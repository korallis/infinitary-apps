import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { connect } from "node:net";
import path, { dirname, join, type PlatformPath } from "node:path";
import { LOCAL_DOOR_FOLDER } from "@shared/connection";
import {
  HOME_ABANDON_ORDER,
  HOME_ARRIVE_ORDER,
  HOME_MOVE_MANIFEST,
  HOME_READY_ORDER,
  HOME_RECEIVE_ORDER,
  type HomeMoveFacts,
  type HomeMoveManifest,
  type HomeMoveOrderChannel,
  homeMoveManifestSchema,
  homeMoveOrders,
} from "@shared/homeMove";
import { readLocalDoor } from "../connection/localDoor";
import { HOME_NUMBER_FILE, readHomeNumber, writeHomeNumber } from "../devices/homeNumber";
import { writePrivate } from "../devices/identity";
import { rulesOf, stepsInside } from "../folderMove/folderRules";
import { movedPath, rewriteDatabases } from "../folderMove/rewrite";
import { git } from "../workspace/git";
import { hashFile, landingOf, removePlaced, restoreAside, setAsideRecord } from "./record";
import { keepSignInsToAsk } from "./signInAgain";

/**
 * The folder in the work folder where a move's files wait until it arrives,
 * and its arrival is kept after; a removal takes it (`cleanUp`).
 */
export const HOME_ARRIVING_DIR = "home-arriving";
const ARRIVED_FILE = "arrived.json";
/** Written before the destination changes anything of its own, and gone once the arrive finished or was undone. */
const ARRIVING_FILE = "arriving.json";
/** What the destination's data folder holds of its own beside the record, set aside with it. */
const ALSO_ASIDE = ["joined", "default-workspace"] as const;

/** How far an arrive went, kept so an arrive cut short, even by a restart, is undone. */
type Arriving = {
  aside: boolean;
  homeNumber: number | null;
  clones: string[];
  /** Set before the first mate is started here: from then on it may run on the placed record. */
  starting?: boolean;
  addresses?: string[];
};

export type IncomingHomeMoveOptions = {
  /** The data folder the first mate's record lands in: the app's own, beside the work folder. */
  homeData: string;
  /**
   * Where each move's files wait until the first mate starts here, and its
   * arrival is kept after: `HOME_ARRIVING_DIR` in the work folder, which
   * stays this computer's own, so nothing is written outside the app's folders.
   */
  arrivingDir: string;
  /** This user's home folder, where a project kept under the old one's lands at the same place. */
  homeDir: string;
  /** Claude's own folder here, where the first mate's Claude conversations land; none without one. */
  claudeDir: string | null;
  appVersion: string | null;
  /** Where a first mate here answers its devices. */
  addresses: () => string[];
  /** Whether this computer can start a first mate in the background. */
  background: boolean;
  /** Starts the first mate here in the background; answers whether it started. */
  startHome: () => Promise<boolean>;
  log: (line: string) => void;
};

/** As `inf:home:arrive` answers: an arrival is only kept once its first mate started. */
type Arrived = { addresses: string[]; started: true };

/**
 * A computer that runs work taking the first mate in (docs/devices.md,
 * "Moving the first mate"): it says what it has before a move, keeps each
 * piece of the record the old home sends in a folder of the move's own, and
 * at the commit checks every file, puts the record in place as its own data
 * folder's with the next home number, clones each project from its bundle,
 * and starts the first mate in the background. An order asked again after
 * it was answered answers the same.
 */
export class IncomingHomeMove {
  /** Each arrive running now, by move: asked again, it answers the same one. */
  private readonly arriving = new Map<string, Promise<Arrived>>();
  /** Each move's abandon while it runs, so a re-ask or an arrive never settles it twice. */
  private readonly abandoning = new Map<string, Promise<{ dropped: boolean }>>();
  /** The takeovers among the arrives: each project is cloned again from where it lives. */
  private readonly fromCopy = new Set<string>();

  constructor(private readonly options: IncomingHomeMoveOptions) {}

  answer(channel: HomeMoveOrderChannel, args: unknown): Promise<unknown> {
    switch (channel) {
      case HOME_READY_ORDER:
        homeMoveOrders[HOME_READY_ORDER].request.parse(args);
        return this.facts();
      case HOME_RECEIVE_ORDER:
        return this.receive(homeMoveOrders[HOME_RECEIVE_ORDER].request.parse(args)[0]);
      case HOME_ARRIVE_ORDER:
        return this.arrive(homeMoveOrders[HOME_ARRIVE_ORDER].request.parse(args)[0]);
      case HOME_ABANDON_ORDER: {
        const [{ move }] = homeMoveOrders[HOME_ABANDON_ORDER].request.parse(args);
        return this.abandon(move);
      }
    }
  }

  /**
   * Takes over from the copy kept here (docs/devices.md, "Taking over"): an
   * arrive of files this computer laid out itself in the takeover's own
   * folder, whose projects carry no bundle and are cloned again from where
   * they live. As for a move, anything that fails is undone before it answers.
   */
  takeOver(order: { move: string; homeNumber: number; manifestSha256: string }): Promise<Arrived> {
    this.fromCopy.add(order.move);
    return this.arrive(order).finally(() => this.fromCopy.delete(order.move));
  }

  /**
   * A takeover cut short by a restart, taken up again at start: one that
   * arrived, or whose first mate started or starts again here, answers its
   * addresses and the home number it took; any other is undone, its set-aside folders put back and its
   * files dropped, and answers null.
   */
  async recover(move: string): Promise<{ addresses: string[]; homeNumber: number } | null> {
    const dir = this.dirOf(move);
    const arrivedFile = join(dir, ARRIVED_FILE);
    const settled = existsSync(arrivedFile)
      ? (JSON.parse(readFileSync(arrivedFile, "utf8")) as Arrived)
      : await this.settleStarting(move);
    if (settled)
      return {
        addresses: settled.addresses,
        homeNumber: readHomeNumber(join(this.options.homeData, "devices")),
      };
    this.undo(move);
    rmSync(dir, { recursive: true, force: true });
    return null;
  }

  /** Where a takeover lays out its files before it arrives. */
  filesOf(move: string): string {
    return join(this.dirOf(move), "files");
  }

  /**
   * Drops what arrived of a move that did not finish, undoing an arrive cut
   * short first. Refused while its arrive runs, and once it arrived: the
   * first mate is then in place here, and the old home must not start again.
   * An arrive cut short while the first mate started is settled first: a
   * first mate running here keeps the move.
   */
  private abandon(move: string): Promise<{ dropped: boolean }> {
    const running = this.abandoning.get(move);
    if (running) return running;
    const abandoned = this.abandonOnce(move).finally(() => this.abandoning.delete(move));
    this.abandoning.set(move, abandoned);
    return abandoned;
  }

  private async abandonOnce(move: string): Promise<{ dropped: boolean }> {
    const dir = this.dirOf(move);
    if (this.arriving.has(move) || existsSync(join(dir, ARRIVED_FILE))) return { dropped: false };
    if (await this.settleStarting(move)) return { dropped: false };
    this.undo(move);
    rmSync(dir, { recursive: true, force: true });
    return { dropped: true };
  }

  /**
   * An arrive cut short, by a restart, after it began to start the first
   * mate: a first mate already answering here is left as it is, and one not
   * answering is started again. A first mate running here is the move
   * arrived; one that cannot start is left for the undo. Answers the
   * arrival, or null.
   */
  private async settleStarting(move: string): Promise<Arrived | null> {
    const dir = this.dirOf(move);
    const arrivingFile = join(dir, ARRIVING_FILE);
    if (!existsSync(arrivingFile)) return null;
    const state = JSON.parse(readFileSync(arrivingFile, "utf8")) as Arriving;
    if (!state.starting || !state.addresses?.length) return null;
    let started = await firstMateAnswers(join(this.options.homeData, LOCAL_DOOR_FOLDER));
    try {
      if (!started) started = await this.options.startHome();
    } catch (caught) {
      this.options.log(`could not start the first mate here: ${String(caught)}`);
    }
    if (!started) return null;
    return this.arrived(move, { addresses: state.addresses, started: true });
  }

  /** Keeps the arrival, which every later ask of the move answers, and drops the files that crossed. */
  private arrived(move: string, arrived: Arrived): Arrived {
    const dir = this.dirOf(move);
    writePrivate(join(dir, ARRIVED_FILE), `${JSON.stringify(arrived)}\n`);
    rmSync(join(dir, ARRIVING_FILE), { force: true });
    rmSync(join(dir, "files"), { recursive: true, force: true });
    return arrived;
  }

  /** Undoes an arrive that stopped part way, from what it kept of how far it went. */
  private undo(move: string): void {
    const dir = this.dirOf(move);
    const arrivingFile = join(dir, ARRIVING_FILE);
    if (!existsSync(arrivingFile)) return;
    const { homeData, homeDir, claudeDir } = this.options;
    const state = JSON.parse(readFileSync(arrivingFile, "utf8")) as Arriving;
    if (state.aside) {
      removePlaced(homeData);
      const manifestFile = join(dir, "files", HOME_MOVE_MANIFEST);
      if (existsSync(manifestFile)) {
        const manifest = homeMoveManifestSchema.parse(
          JSON.parse(readFileSync(manifestFile, "utf8")),
        );
        for (const file of manifest.files) {
          if (!file.path.startsWith("claude/")) continue;
          const landing = landingOf(file.path, homeData, claudeDir ?? join(homeDir, ".claude"));
          if (landing) rmSync(landing, { force: true });
        }
      }
      for (const clone of state.clones) rmSync(clone, { recursive: true, force: true });
      const numberFile = join(homeData, "devices", HOME_NUMBER_FILE);
      if (state.homeNumber === null) rmSync(numberFile, { force: true });
      else writeHomeNumber(join(homeData, "devices"), state.homeNumber);
    }
    restoreAside(homeData, move, ALSO_ASIDE);
    rmSync(arrivingFile, { force: true });
    this.options.log(`undid a move that did not finish: ${move}`);
  }

  private dirOf(move: string): string {
    return join(this.options.arrivingDir, move);
  }

  private async facts(): Promise<HomeMoveFacts> {
    const { homeData } = this.options;
    let freeBytes: number | null = null;
    try {
      const where = existsSync(homeData) ? homeData : dirname(homeData);
      const stats = statfsSync(where);
      freeBytes = Math.floor(Number(stats.bavail) * Number(stats.bsize));
    } catch {
      freeBytes = null;
    }
    return {
      appVersion: this.options.appVersion,
      freeBytes,
      addresses: this.options.addresses().slice(0, 9),
      ownRecord: existsSync(join(homeData, "firstmate.db")),
      firstMateRunning: await firstMateAnswers(join(homeData, LOCAL_DOOR_FOLDER)),
      background: this.options.background,
    };
  }

  private async receive(piece: {
    move: string;
    path: string;
    size: number;
    sha256: string;
    offset: number;
    data: string;
  }): Promise<{ complete: boolean }> {
    const dir = this.dirOf(piece.move);
    if (existsSync(join(dir, ARRIVED_FILE))) return { complete: true };
    const file = join(dir, "files", ...piece.path.split("/"));
    const bytes = Buffer.from(piece.data, "base64");
    if (piece.offset + bytes.length > piece.size) throw new Error("The piece runs past its file.");
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    // The first piece starts the file over: a file sent again after it changed is whole again.
    const handle = await open(file, piece.offset === 0 ? "w" : "r+", 0o600);
    try {
      if (bytes.length) await handle.write(bytes, 0, bytes.length, piece.offset);
      if (piece.offset + bytes.length >= piece.size) await handle.truncate(piece.size);
    } finally {
      await handle.close();
    }
    if (piece.offset + bytes.length < piece.size) return { complete: false };
    const sha = await hashFile(file);
    if (sha !== piece.sha256) throw new Error(`${piece.path} did not arrive whole.`);
    return { complete: true };
  }

  private arrive(order: {
    move: string;
    homeNumber: number;
    manifestSha256: string;
  }): Promise<Arrived> {
    const running = this.arriving.get(order.move);
    if (running) return running;
    // An arrive asked while its abandon runs waits for it, and then answers from what it left.
    const abandoning = this.abandoning.get(order.move);
    const arrived = (abandoning ? abandoning.catch(() => {}) : Promise.resolve())
      .then(() => this.arriveOnce(order))
      .finally(() => this.arriving.delete(order.move));
    this.arriving.set(order.move, arrived);
    return arrived;
  }

  /**
   * Puts the record in place and starts the first mate, or leaves this
   * computer as it was: anything that fails after its own record went aside
   * is undone before the refusal answers, and an arrive cut short by a
   * restart is undone when the old home asks again.
   */
  private async arriveOnce(order: {
    move: string;
    homeNumber: number;
    manifestSha256: string;
  }): Promise<Arrived> {
    const dir = this.dirOf(order.move);
    const arrivedFile = join(dir, ARRIVED_FILE);
    if (existsSync(arrivedFile)) return JSON.parse(readFileSync(arrivedFile, "utf8")) as Arrived;
    if (existsSync(join(dir, ARRIVING_FILE))) {
      const settled = await this.settleStarting(order.move);
      if (settled) return settled;
      this.undo(order.move);
      throw new Error("The move was cut short here and is undone. Move your first mate again.");
    }
    const files = join(dir, "files");
    const manifestFile = join(files, HOME_MOVE_MANIFEST);
    if ((await hashFile(manifestFile)) !== order.manifestSha256)
      throw new Error("The move's list of files did not arrive whole.");
    const manifest = homeMoveManifestSchema.parse(JSON.parse(readFileSync(manifestFile, "utf8")));
    for (const file of manifest.files) {
      const at = join(files, ...file.path.split("/"));
      if (
        !existsSync(at) ||
        statSync(at).size !== file.size ||
        (await hashFile(at)) !== file.sha256
      )
        throw new Error(`${file.path} did not arrive whole.`);
    }
    const { homeData, homeDir, claudeDir } = this.options;
    const addresses = this.options.addresses().slice(0, 9);
    if (!addresses.length) throw new Error("This computer has no address its devices could reach.");
    const state: Arriving = {
      aside: false,
      homeNumber: existsSync(join(homeData, "devices", HOME_NUMBER_FILE))
        ? readHomeNumber(join(homeData, "devices"))
        : null,
      clones: [],
      addresses,
    };
    const keep = () => writePrivate(join(dir, ARRIVING_FILE), `${JSON.stringify(state)}\n`);
    keep();
    let started = false;
    try {
      // What this data folder held of a first mate of its own, the window's
      // own grant to another home and its local-only repository go aside:
      // nothing here is deleted.
      setAsideRecord(homeData, order.move, ALSO_ASIDE);
      state.aside = true;
      keep();
      for (const file of manifest.files) {
        const landing = landingOf(file.path, homeData, claudeDir ?? join(homeDir, ".claude"));
        if (!landing || (file.path.startsWith("claude/") && !claudeDir)) continue;
        place(join(files, ...file.path.split("/")), landing);
      }
      rewriteDatabases(homeData, [manifest.from.userData], homeData);
      // The new home asks for each sign-in the old one had: none crossed.
      if (manifest.signIns) keepSignInsToAsk(homeData, manifest.name, manifest.signIns);
      for (const project of manifest.projects) {
        const to = await this.cloneProject(
          project,
          manifest,
          files,
          (clone) => {
            state.clones.push(clone);
            keep();
          },
          this.fromCopy.has(order.move),
        );
        // The rewrite above already named a project the old home kept in its data folder by this one's.
        const saved = movedPath(project.path, [manifest.from.userData], homeData) ?? project.path;
        if (to !== saved) rewriteDatabases(homeData, [saved], to);
      }
      writeHomeNumber(join(homeData, "devices"), order.homeNumber);
      state.starting = true;
      keep();
      try {
        started = await this.options.startHome();
      } catch (caught) {
        this.options.log(`could not start the first mate here: ${String(caught)}`);
      }
      if (!started) throw new Error("This computer could not start the first mate.");
    } catch (caught) {
      this.undo(order.move);
      throw caught;
    }
    this.options.log(`the first mate moved here from ${manifest.name}`);
    return this.arrived(order.move, { addresses, started: true });
  }

  private async cloneProject(
    project: HomeMoveManifest["projects"][number],
    manifest: HomeMoveManifest,
    files: string,
    made: (clone: string) => void,
    fromRemotes = false,
  ): Promise<string> {
    const landing = projectLanding(project.path, manifest.from, this.options);
    let to = landing;
    // A folder already there is never written over: the project lands beside it.
    for (let n = 2; existsSync(to); n++) to = `${landing}-${n}`;
    made(to);
    mkdirSync(dirname(to), { recursive: true });
    if (project.bundle) {
      const bundle = join(files, ...project.bundle.split("/"));
      await git(dirname(to), ["clone", bundle, to], { timeoutMs: 30 * 60_000 });
      // Every branch and tag as the old home kept it, not only the one checked out.
      await git(to, [
        "fetch",
        "--update-head-ok",
        bundle,
        "+refs/heads/*:refs/heads/*",
        "+refs/tags/*:refs/tags/*",
      ]);
      await git(to, ["remote", "remove", "origin"]).catch(() => "");
    } else if (fromRemotes && project.remotes[0] && (await cloned(project.remotes[0], to))) {
      // Taking over: cloned again from where it lives, with this computer's own sign-in.
    } else {
      if (fromRemotes && project.remotes.length)
        this.options.log(`could not clone ${project.path} again; it starts empty`);
      mkdirSync(to, { recursive: true });
      if (project.remotes.length) await git(to, ["init"]);
    }
    for (const remote of project.remotes)
      await git(to, ["remote", "add", remote.name, remote.url]).catch(() =>
        git(to, ["remote", "set-url", remote.name, remote.url]),
      );
    // What the old home last fetched from each remote, so its branches compare as they did there.
    if (project.bundle && project.remotes.length)
      await git(to, [
        "fetch",
        join(files, ...project.bundle.split("/")),
        "+refs/remotes/*:refs/remotes/*",
      ]).catch(() => "");
    return to;
  }
}

/**
 * Where a project lands on the new home: the same place under its home folder
 * or data folder, else beside the others. The old home's locations are read
 * by its own system's folder rules, and the landing is written by `here`'s.
 */
export function projectLanding(
  location: string,
  from: HomeMoveManifest["from"],
  to: { homeData: string; homeDir: string },
  here: PlatformPath = path,
): string {
  const underData = stepsInside(from.userData, location);
  if (underData?.length) return here.join(to.homeData, ...underData);
  const underHome = stepsInside(from.homeDir, location);
  if (underHome?.length) return here.join(to.homeDir, ...underHome);
  return here.join(to.homeData, "fleet", rulesOf(location).basename(location));
}

/** Clones a project again from one of its remotes; false when it could not, leaving nothing. */
async function cloned(remote: { name: string; url: string }, to: string): Promise<boolean> {
  try {
    await git(dirname(to), ["clone", "--origin", remote.name, remote.url, to], {
      timeoutMs: 30 * 60_000,
    });
    return true;
  } catch {
    rmSync(to, { recursive: true, force: true });
    return false;
  }
}

/** Puts one arrived file in place, across disks when it must. */
function place(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  try {
    renameSync(from, to);
  } catch {
    copyFileSync(from, to);
  }
}

/** Whether a first mate answers at this data folder's local door now. */
async function firstMateAnswers(doorDir: string): Promise<boolean> {
  const door = readLocalDoor(doorDir);
  if (!door) return false;
  const [host, port] = door.address.split(":");
  return new Promise((resolve) => {
    const socket = connect({ host, port: Number(port) });
    const done = (answers: boolean) => {
      socket.destroy();
      resolve(answers);
    };
    socket.setTimeout(1_000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
