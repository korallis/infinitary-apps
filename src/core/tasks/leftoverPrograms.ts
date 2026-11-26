import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  keepsAtClose,
  LEFTOVERS_DATA_KEY,
  type LeftoversReport,
  leftoversKept,
  leftoversLine,
  reportsAnything,
  type StopOutcome,
  type TaskStop,
} from "@shared/leftoverPrograms";
import { hostEnv } from "../hostEnv";
import { windowsBash } from "../pi/windowsBash";
import { endHolder, findFolderHolders, type HolderOptions } from "../placed/folderHolders";
import { processRoots } from "../placed/processRoots";
import { hostPlatform } from "../platform";
import { removeAll } from "../removeWhole";
import type { TaskRecord } from "../storage/taskRecords";
import { endWindowsTree } from "../windowsTree";
import { type KeptJobs, keptJobsAt } from "./keptJobs";
import { keepLeftovers, LeftBehindHere, type LeftBehindOptions } from "./leftBehind";
import { handOverStops, takeKeeps, takeStops } from "./taskStops";
import { TEMP_DIR_NAME } from "./taskTemp";

/**
 * A closed task's leftovers (docs/leftover-programs.md): what its crewmate started
 * that outlives the commands that started it. The close runs each stop the
 * crewmate registered, newest first, then ends the programs that still hold
 * the task's working copy or temporary folder and belong to no live task,
 * before either folder goes. A task carried on by a successor hands its
 * stops to that task and stops nothing. The same sweep runs on a computer
 * that runs work, inside its close order, and answers its report home.
 */

/** How long one registered stop may run before it is ended and counted as not finished. */
export const STOP_TIME_MS = 60_000;

export type LeftoverSweep = {
  /** The task's own folder, which keeps its stops. */
  taskFolder: string;
  /** The folders whose holders are its leftovers: its working copy and temporary folder. */
  folders: readonly string[];
  /** The task that carries its work on, on this same computer: its folder and key. */
  handTo?: { folder: string; key: string };
  /**
   * What the close does with the task's keeps (docs/leftover-programs.md, "A
   * job the captain asked to keep"): keep them running, or run their removes
   * after the stops. Absent, they are removed.
   */
  keeps?: "keep" | "remove";
  holders?: HolderOptions;
  stopTimeMs?: number;
  graceMs?: number;
};

/**
 * Runs one stop in its own process group, in the folder it was registered in
 * when that is still there. On Windows it runs in Git Bash, where the crew's
 * commands run and the stop was written (`windowsBash`), and one that runs
 * past its time ends with every program under it (`taskkill /T`).
 */
export function runStop(stop: TaskStop, fallbackCwd: string, timeMs: number): Promise<StopOutcome> {
  const cwd = stop.cwd && existsSync(stop.cwd) ? stop.cwd : fallbackCwd;
  const windows = hostPlatform() === "win32";
  const ownGroup = !windows;
  const bash = windows ? windowsBash() : undefined;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: StopOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bash ?? stop.command, bash ? ["-c", stop.command] : [], {
        shell: !bash,
        cwd: existsSync(cwd) ? cwd : undefined,
        env: hostEnv(),
        stdio: "ignore",
        detached: ownGroup,
        windowsHide: true,
      });
    } catch {
      resolve({ label: stop.label, outcome: "failed" });
      return;
    }
    const timer = setTimeout(() => {
      try {
        if (ownGroup && child.pid) process.kill(-child.pid, "SIGKILL");
        else if (windows && child.pid) endWindowsTree(child.pid, () => child.kill("SIGKILL"));
        else child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      finish({ label: stop.label, outcome: "timed-out" });
    }, timeMs);
    child.once("error", () => finish({ label: stop.label, outcome: "failed" }));
    child.once("exit", (code) =>
      finish(
        code === 0
          ? { label: stop.label, outcome: "ran" }
          : { label: stop.label, outcome: "failed", ...(code !== null ? { exitCode: code } : {}) },
      ),
    );
  });
}

export function leftBehindHere(
  options: Omit<LeftBehindOptions, "runStop"> & { stopTimeMs?: number },
): LeftBehindHere {
  const { stopTimeMs, ...rest } = options;
  return new LeftBehindHere({
    ...rest,
    runStop: (stop, cwd) => runStop(stop, cwd, stopTimeMs ?? STOP_TIME_MS),
  });
}

export async function sweepLeftovers(input: LeftoverSweep): Promise<LeftoversReport> {
  // A task carried on hands its stops and keeps to the task that goes on, and runs none.
  const handed = input.handTo
    ? handOverStops(input.taskFolder, input.handTo.folder)
    : { stops: 0, keeps: 0 };
  const handedTo =
    input.handTo && handed.stops + handed.keeps > 0
      ? {
          ...(handed.stops > 0 ? { handed: handed.stops } : {}),
          ...(handed.keeps > 0 ? { handedKeeps: handed.keeps } : {}),
          handedTo: input.handTo.key,
        }
      : {};
  const timeMs = input.stopTimeMs ?? STOP_TIME_MS;
  const ran: { stop: TaskStop; outcome: StopOutcome }[] = [];
  const removes: { stop: TaskStop; outcome: StopOutcome }[] = [];
  let kept: LeftoversReport["kept"] = [];
  if (!input.handTo) {
    for (const stop of takeStops(input.taskFolder))
      ran.push({ stop, outcome: await runStop(stop, input.taskFolder, timeMs) });
    const keeps = takeKeeps(input.taskFolder);
    // A merged or answered close leaves the job running, its folder kept.
    if (input.keeps === "keep") kept = keeps.map(({ cwd: _cwd, at: _at, ...job }) => job).reverse();
    // Any other close removes it, once, as a stop runs, after the stops.
    else
      for (const keep of keeps) {
        const stop: TaskStop = {
          id: keep.id,
          label: keep.label,
          command: keep.remove,
          ...(keep.cwd ? { cwd: keep.cwd } : {}),
          at: keep.at,
        };
        const outcome = await runStop(stop, input.taskFolder, timeMs);
        // A job removed cleanly takes its kept folder; a failed remove keeps both for a later look.
        // A folder the job left read-only is made writable once; one still not gone stays, never stopping the close.
        if (outcome.outcome === "ran") removeAll(keep.folder);
        removes.push({ stop, outcome });
      }
  }
  const stops = ran.map((entry) => entry.outcome);
  const keepsReport = {
    ...(kept.length > 0 ? { kept } : {}),
    ...(removes.length > 0 ? { removed: removes.map((entry) => entry.outcome) } : {}),
  };
  const unfinished = [...ran, ...removes];
  // Its folders go either way, so what still holds them ends (the captain's
  // answer on the review of INF-3447's piece 1).
  const reading = await findFolderHolders(
    input.folders.filter((folder) => existsSync(folder)),
    input.holders,
  );
  if (reading.status !== "checked") {
    const keptInFile = keepLeftovers(input.taskFolder, unfinished, []);
    return {
      stops,
      programs: [],
      holders: reading.status,
      ...handedTo,
      ...keepsReport,
      ...(keptInFile ? { keptInFile } : {}),
    };
  }
  const programs = await Promise.all(
    reading.holders.map((holder) =>
      endHolder(holder, input.graceMs !== undefined ? { graceMs: input.graceMs } : {}),
    ),
  );
  // What it could not finish stays here, for a later look (docs/leftover-programs.md).
  const keptInFile = keepLeftovers(input.taskFolder, unfinished, programs);
  return {
    stops,
    programs,
    holders: "checked",
    ...handedTo,
    ...keepsReport,
    ...(keptInFile ? { keptInFile } : {}),
  };
}

/**
 * A program in a group another live task declared (a heavy run,
 * `LoadLine`) is that task's, never this one's leftover.
 */
export function ownedByOtherTask(
  taskId: string,
  isLive: (owner: string) => boolean,
): HolderOptions["ownedElsewhere"] {
  return (row) => {
    const group = processRoots.readGroups().get(row.group);
    return group !== undefined && group.owner !== taskId && isLive(group.owner);
  };
}

/** What a computer that runs work keeps of its tasks that the sweep reads (`PlacedTasks`). */
export type PlacedTasksPart = {
  folders(task: string): { root: string; work: string; temp: string };
  has(task: string): boolean;
  state(task: string): { closed: boolean };
};

/**
 * The close order's sweep on a computer that runs work (`inf:session:close`;
 * docs/leftover-programs.md, "On a computer that runs work"): the same
 * guards as at the home, with the task's start time the home sent and the
 * tasks still open there as the live ones.
 */
export function placedLeftovers(
  tasks: PlacedTasksPart,
  timing: { stopTimeMs?: number; graceMs?: number } = {},
): (
  task: string,
  close: {
    carriedTo?: { task: string; key: string };
    startedAt?: number;
    keeps?: "keep" | "remove";
  },
) => Promise<LeftoversReport> {
  return (task, { carriedTo, startedAt, keeps }) => {
    const folders = tasks.folders(task);
    return sweepLeftovers({
      taskFolder: folders.root,
      folders: [folders.work, folders.temp],
      ...(keeps ? { keeps } : {}),
      ...(carriedTo
        ? { handTo: { folder: tasks.folders(carriedTo.task).root, key: carriedTo.key } }
        : {}),
      holders: {
        ...(startedAt !== undefined ? { startedAt } : {}),
        ownedElsewhere: ownedByOtherTask(
          task,
          (owner) => tasks.has(owner) && !tasks.state(owner).closed,
        ),
      },
      ...timing,
    });
  };
}

type TasksPart = {
  get(id: string): TaskRecord | undefined;
  note(
    id: string,
    text: string,
    options: { news: boolean; feed?: boolean; data?: Record<string, unknown> },
  ): unknown;
  graph: {
    carrierOf(id: string): TaskRecord | undefined;
    escalatedTo(id: string): string[];
  };
};

const closed = (record: TaskRecord): boolean =>
  record.status === "done" || record.status === "dropped";

/**
 * The open task that carries a superseded task's work on, which takes its
 * stops (docs/leftover-programs.md, "A task carried on by another"): its
 * stronger-model retry, or the task it was carried on by, followed to the
 * newest. A closed successor would never run them, so none is answered and
 * the stops run at this close.
 */
export function openSuccessor(
  tasks: Pick<TasksPart, "graph">,
  record: TaskRecord,
): TaskRecord | undefined {
  if (!closed(record) || record.closedReason !== "superseded") return undefined;
  const retry = tasks.graph.escalatedTo(record.id).at(-1);
  const carrier = tasks.graph.carrierOf(retry ?? record.id);
  return carrier && carrier.id !== record.id && !closed(carrier) ? carrier : undefined;
}

export type LeftoverProgramsOptions = {
  crewmatesDir: string;
  /** The home's record of the jobs closes kept running; at `<userData>/kept` when absent. */
  keptJobs?: KeptJobs;
  tasks: TasksPart;
  stopTimeMs?: number;
  graceMs?: number;
  log?: (line: string) => void;
};

export function noteLeftovers(
  tasks: Pick<TasksPart, "note">,
  taskId: string,
  report: LeftoversReport,
  computerId: string | null = null,
): void {
  if (!reportsAnything(report)) return;
  const kept = leftoversKept(report);
  tasks.note(taskId, leftoversLine(report), {
    news: kept.stops.length > 0 || kept.programs.length > 0,
    data: {
      [LEFTOVERS_DATA_KEY]: report,
      leftoversComputerId: computerId,
      leftoversUnresolved: kept.stops.length > 0 || kept.programs.length > 0,
      ...(report.keptInFile ? { leftoversKeptInFile: true } : {}),
    },
  });
}

/**
 * The sweep at this computer, one per close. The close begins it as the
 * record closes and waits for it before the working copy goes; the
 * temporary folder's removal waits for it too (`settled`). A task on
 * another computer has its folders swept there (`SessionHost`), but the
 * stops kept in its folder here - registered before it moved, or handed to
 * it before it started there - still run here.
 */
export class LeftoverPrograms {
  private readonly sweeps = new Map<string, Promise<void>>();
  /** The home's record of the jobs closes kept running, which piece 2 lists (`KeptJobs`). */
  readonly keptJobs: KeptJobs;

  constructor(private readonly options: LeftoverProgramsOptions) {
    this.keptJobs = options.keptJobs ?? keptJobsAt(options.crewmatesDir);
  }

  /**
   * Begins the task's sweep once `after` (its crewmate's stop) settles.
   * Begun again for the same task, it answers the sweep already begun.
   */
  begin(taskId: string, after?: Promise<unknown>): Promise<void> {
    const running = this.sweeps.get(taskId);
    if (running) return running;
    const record = this.options.tasks.get(taskId);
    if (!record || !closed(record)) return Promise.resolve();
    const sweep = (async () => {
      await after?.catch(() => undefined);
      await this.sweep(taskId);
    })()
      .catch((caught: unknown) => {
        this.options.log?.(
          `could not stop the leftovers of ${taskId}: ${caught instanceof Error ? caught.message : String(caught)}`,
        );
      })
      .finally(() => this.running.delete(taskId));
    this.running.add(taskId);
    this.sweeps.set(taskId, sweep);
    return sweep;
  }

  settled(taskId: string): Promise<void> {
    return this.sweeps.get(taskId) ?? Promise.resolve();
  }

  sweeping(taskId: string): boolean {
    return this.running.has(taskId);
  }

  private readonly running = new Set<string>();

  /**
   * What finished tasks left on this Mac, which the notices list and a
   * cleanup look acts on (docs/leftover-programs.md, "What a close leaves").
   * A task counts once its close here has finished its own cleanup.
   */
  leftBehind(runs: LeftBehindOptions["runs"]): LeftBehindHere {
    return leftBehindHere({
      tasksDir: this.options.crewmatesDir,
      closed: (taskId) => {
        const record = this.options.tasks.get(taskId);
        return record !== undefined && closed(record);
      },
      sweeping: (taskId) => this.sweeping(taskId),
      runs,
    });
  }

  private async sweep(taskId: string): Promise<void> {
    const { tasks, crewmatesDir } = this.options;
    const record = tasks.get(taskId);
    if (!record) return;
    const taskFolder = join(crewmatesDir, taskId);
    const carrier = openSuccessor(tasks, record);
    // A successor on another computer cannot run them there: they run here.
    const handTo =
      carrier && !carrier.deviceId
        ? { folder: join(crewmatesDir, carrier.id), key: carrier.key || carrier.id }
        : undefined;
    // Only a task here has its folders here; one on another computer has them swept there.
    const folders = record.deviceId
      ? []
      : [
          ...(record.worktreeDir && record.workspaceState === "present"
            ? [record.worktreeDir]
            : []),
          join(taskFolder, TEMP_DIR_NAME),
        ];
    const report = await sweepLeftovers({
      taskFolder,
      folders,
      ...(handTo ? { handTo } : {}),
      keeps: keepsAtClose(record.closedReason),
      holders: {
        ...(record.startedAt !== null ? { startedAt: record.startedAt } : {}),
        ownedElsewhere: ownedByOtherTask(taskId, (owner) => {
          const other = tasks.get(owner);
          return other !== undefined && other.status !== "done" && other.status !== "dropped";
        }),
      },
      ...(this.options.stopTimeMs !== undefined ? { stopTimeMs: this.options.stopTimeMs } : {}),
      ...(this.options.graceMs !== undefined ? { graceMs: this.options.graceMs } : {}),
    });
    noteLeftovers(tasks, taskId, report);
    // The line already names each kept job, so a record that cannot be written loses no word of it.
    try {
      this.keptJobs.record(report.kept ?? [], { computer: null, task: taskId, key: record.key });
    } catch (caught) {
      this.options.log?.(
        `could not record the kept jobs of ${taskId}: ${caught instanceof Error ? caught.message : String(caught)}`,
      );
    }
  }
}

/** The app's own leftover programs, logging to its console. */
export function leftoverProgramsAt(
  crewmatesDir: string,
  keptJobs: KeptJobs,
  tasks: LeftoverProgramsOptions["tasks"],
): LeftoverPrograms {
  return new LeftoverPrograms({
    crewmatesDir,
    keptJobs,
    tasks,
    log: (line) => console.warn(`[leftovers] ${line}`),
  });
}
