import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, type PlatformPath, posix, win32 } from "node:path";
import { HOME } from "@shared/deviceNames";
import { HOME_ARRIVE_ORDER, HOME_MOVE_MANIFEST, type HomeMoveManifest } from "@shared/homeMove";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { LOCAL_MACHINE_ID } from "../session/session";
import { openDatabase } from "../storage/db";
import { SettingsStore } from "../storage/settingsStore";
import { TaskExecutionStore } from "../storage/taskExecutionStore";
import { TaskSessionStore } from "../storage/taskSessionStore";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { HOME_ARRIVING_DIR, IncomingHomeMove, projectLanding } from "./arriving";

/**
 * The ask these guard: a first mate that moves between a Windows PC and a Mac
 * arrives with each project in a normally named folder, and each folder
 * location its record saved inside the old data folder or a project names its
 * place on the new home (docs/devices.md, "A home on another system"). Each case hands the arriving
 * side the files a home of the other system sends, so the Windows home's case
 * is the one that crosses systems on a Mac or Linux run, and the Mac home's on
 * a Windows run.
 */

// The arriving side's git runs at the test run's own priority (docs/test-cohorts.md, "Budgets").
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

// Real git for each project's bundle and clone (docs/test-cohorts.md).
vi.setConfig({ testTimeout: 25_000 });

/** An old home's own folders, written as its system writes them. */
type OldHome = {
  name: string;
  rules: PlatformPath;
  userData: string;
  homeDir: string;
  /** A folder outside both, where a person keeps a project. */
  elsewhere: string;
};

const WINDOWS_PC: OldHome = {
  name: "Windows PC",
  rules: win32,
  userData: "C:\\Users\\ada\\AppData\\Roaming\\infinitary",
  homeDir: "C:\\Users\\ada",
  elsewhere: "D:\\work",
};
const MAC: OldHome = {
  name: "MacBook Pro",
  rules: posix,
  userData: "/Users/ada/Library/Application Support/infinitary",
  homeDir: "/Users/ada",
  elsewhere: "/Volumes/work",
};

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** The destination: a computer that runs work, whose first mate starts when asked. */
function destination() {
  const root = scratchDir("infinitary-other-system-new-");
  const homeData = join(root, "data");
  const homeDir = join(root, "home");
  mkdirSync(join(homeData, "work"), { recursive: true });
  const incoming = new IncomingHomeMove({
    homeData,
    arrivingDir: join(homeData, "work", HOME_ARRIVING_DIR),
    homeDir,
    claudeDir: null,
    appVersion: "0.8.0-alpha.600",
    addresses: () => ["192.168.1.30:47213"],
    background: true,
    startHome: async () => true,
    log: () => {},
  });
  return { homeData, homeDir, incoming };
}

/**
 * The files a home on `old`'s system sends, laid out where `to` keeps a
 * move's files: a database the app made, whose saved locations are written as
 * that system writes them, a crewmate's and the first mate's conversation, a
 * bundle of each project, and the manifest that names them all. `shop` adds a
 * second project whose folder is also named `website`, kept on another disk
 * and listed before or after the others.
 */
async function send(old: OldHome, to: ReturnType<typeof destination>, shop?: "first" | "last") {
  const at = (...parts: string[]) => old.rules.join(...parts);
  const made = scratchDir("infinitary-other-system-old-");
  const move = randomUUID();
  const files = join(to.homeData, "work", HOME_ARRIVING_DIR, move, "files");
  mkdirSync(join(files, "projects"), { recursive: true });

  const kept = [
    // Kept in the app's own projects folder, in the home folder, and on another disk.
    { id: "r1", name: "website", path: at(old.userData, "fleet", "website") },
    { id: "r2", name: "tools", path: at(old.homeDir, "code", "tools") },
    { id: "r3", name: "notes", path: at(old.elsewhere, "notes") },
  ];
  const other = { id: "r4", name: "shop", path: at(old.elsewhere, "website") };
  if (shop === "first") kept.unshift(other);
  if (shop === "last") kept.push(other);
  const projects = kept.map((project, index) => {
    const repo = join(made, project.name);
    mkdirSync(repo, { recursive: true });
    sh(repo, "init", "-q", "-b", "main");
    sh(repo, "config", "user.email", "test@example.com");
    sh(repo, "config", "user.name", "Test");
    writeFileSync(join(repo, "README.md"), `${project.name}\n`);
    if (project.name === "tools") {
      mkdirSync(join(repo, "plugin"));
      writeFileSync(join(repo, "plugin", "plugin.json"), '{"name":"clock"}\n');
    }
    sh(repo, "add", ".");
    sh(repo, "commit", "-q", "-m", "first");
    sh(repo, "branch", `fm/${project.name}`);
    const remote = `https://example.com/acme/${project.name}.git`;
    sh(repo, "remote", "add", "origin", remote);
    sh(repo, "bundle", "create", join(files, "projects", `${index}.bundle`), "--all");
    return {
      id: project.id,
      path: project.path,
      bundle: `projects/${index}.bundle`,
      remotes: [{ name: "origin", url: remote }],
    };
  });
  const [website, tools, notes] = ["r1", "r2", "r3"].map(
    (id) => projects.find((project) => project.id === id)?.path,
  ) as [string, string, string];
  // A folder beside the data folder whose name starts the same way, as a build run from source keeps.
  const beside = at(old.rules.dirname(old.userData), "infinitary-dev", "fleet", "site");
  const mention = `Look in ${website} for the footer.`;

  const db = openDatabase(join(made, "data"));
  const addRepo = db.prepare(
    "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy, rigor, kind) VALUES (?, ?, ?, 1, 'adopt', NULL, 'direct-pr', 0, 'standard', 'project')",
  );
  for (const project of projects) addRepo.run(project.id, project.path, project.id);
  const tasks = new TaskService({ db, now: () => 5_000 });
  const session = ["crewmates", "task-1", "sessions", "one.jsonl"];
  seedTask(tasks, {
    id: "task-1",
    title: "Fix the footer",
    prompt: mention,
    status: "idle",
    repoDir: website,
    worktreeDir: at(old.userData, "worktrees", "task-1"),
    sessionFile: at(old.userData, ...session),
  });
  // The conversation as the old home recorded it for a crewmate it ran itself.
  // Its id is the file's name read by that home's folder rules, which the
  // computer running this test may not share, so the stores write it.
  new TaskSessionStore(db).record("task-1", {
    conversation: "one",
    resume_token: at(old.userData, ...session),
    file: at(old.userData, ...session),
    computer: HOME.the,
    device_id: LOCAL_MACHINE_ID,
    provider: "openai-codex",
    model: "gpt-5",
    account_id: null,
    opened_at: 5_000,
    last_at: 5_000,
    began: "start",
  });
  new TaskExecutionStore(db).pinConversation("task-1", "one");
  const tidied: [string, string][] = [
    ["task-2", tools],
    ["task-3", notes],
    ["task-4", beside],
  ];
  if (shop) tidied.push(["task-5", other.path]);
  for (const [id, repoDir] of tidied)
    seedTask(tasks, {
      id,
      title: "Tidy up",
      status: "idle",
      repoDir,
      worktreeDir: at(old.userData, "worktrees", id),
    });
  const rolling = ["firstmate", "sessions", "rolling.jsonl"];
  new SettingsStore(db).setFirstmateSessionFile(at(old.userData, ...rolling));
  // A plugin the person added from a folder inside one of their projects.
  db.prepare(
    "INSERT INTO plugins (id, source, spec, updated_at) VALUES ('clock', 'path', ?, 1)",
  ).run(at(tools, "plugin"));
  await db.backup(join(files, "firstmate.db"));
  db.close();

  for (const file of [session, rolling]) {
    mkdirSync(join(files, ...file.slice(0, -1)), { recursive: true });
    writeFileSync(join(files, ...file), '{"a":1}\n');
  }
  const manifest: HomeMoveManifest = {
    version: 1,
    files: ["firstmate.db", session.join("/"), rolling.join("/")].map((path) => ({
      path,
      size: statSync(join(files, ...path.split("/"))).size,
      sha256: sha256(join(files, ...path.split("/"))),
    })),
    projects,
    from: { userData: old.userData, homeDir: old.homeDir },
    name: old.name,
  };
  writeFileSync(join(files, HOME_MOVE_MANIFEST), `${JSON.stringify(manifest)}\n`);
  return {
    order: { move, homeNumber: 2, manifestSha256: sha256(join(files, HOME_MOVE_MANIFEST)) },
    beside,
    mention,
  };
}

type SavedTask = {
  id: string;
  repo_dir: string;
  worktree_dir: string;
  session_file: string | null;
};

/** Every folder location the arrived record saved, as its database holds it now. */
function saved(homeData: string) {
  const db = openDatabase(homeData);
  const tasks = new TaskService({ db, now: () => 5_000 });
  try {
    return {
      repos: db.prepare("SELECT id, path FROM repos ORDER BY id").all() as {
        id: string;
        path: string;
      }[],
      tasks: db
        .prepare(
          `SELECT t.id, t.repo_dir, t.worktree_dir, x.session_file
           FROM tasks t LEFT JOIN task_execution x ON x.task_id = t.id ORDER BY t.id`,
        )
        .all() as SavedTask[],
      plugin: (db.prepare("SELECT spec FROM plugins WHERE id = 'clock'").get() as { spec: string })
        .spec,
      firstmateSession: new SettingsStore(db).getFirstmateSessionFile(),
      prompt: tasks.get("task-1")?.prompt,
      // As the by-key task read asks for them, with this home's own folder of the task's files.
      conversations: tasks.archive.sessions("task-1", {
        dir: join(homeData, "crewmates", "task-1", "sessions"),
        computer: HOME.the,
        device: LOCAL_MACHINE_ID,
      }),
    };
  } finally {
    db.close();
  }
}

describe.each([WINDOWS_PC, MAC])("a first mate arriving from a $name", (old) => {
  it("lands each project in a normally named folder and names each saved location inside the old data folder or a project on the new home", async () => {
    const to = destination();
    const sent = await send(old, to);

    expect(await to.incoming.answer(HOME_ARRIVE_ORDER, [sent.order])).toEqual({
      addresses: ["192.168.1.30:47213"],
      started: true,
    });

    const website = join(to.homeData, "fleet", "website");
    const tools = join(to.homeDir, "code", "tools");
    const notes = join(to.homeData, "fleet", "notes");
    for (const [project, name] of [
      [website, "website"],
      [tools, "tools"],
      [notes, "notes"],
    ] as const) {
      expect(sh(project, "branch", "--format=%(refname:short)")).toContain(`fm/${name}`);
      expect(sh(project, "remote", "get-url", "origin")).toBe(
        `https://example.com/acme/${name}.git`,
      );
    }
    const record = saved(to.homeData);
    expect(record.repos).toEqual([
      { id: "r1", path: website },
      { id: "r2", path: tools },
      { id: "r3", path: notes },
    ]);
    const conversation = join(to.homeData, "crewmates", "task-1", "sessions", "one.jsonl");
    expect(record.tasks).toEqual([
      {
        id: "task-1",
        repo_dir: website,
        worktree_dir: join(to.homeData, "worktrees", "task-1"),
        session_file: conversation,
      },
      {
        id: "task-2",
        repo_dir: tools,
        worktree_dir: join(to.homeData, "worktrees", "task-2"),
        session_file: null,
      },
      {
        id: "task-3",
        repo_dir: notes,
        worktree_dir: join(to.homeData, "worktrees", "task-3"),
        session_file: null,
      },
      {
        id: "task-4",
        // Beside the old data folder, not in it: no folder here stands for it.
        repo_dir: sent.beside,
        worktree_dir: join(to.homeData, "worktrees", "task-4"),
        session_file: null,
      },
    ]);
    expect(existsSync(conversation)).toBe(true);
    // One conversation, by the file that came over, with what the old home recorded of it.
    expect(record.conversations).toEqual([
      {
        conversation: "one",
        file: conversation,
        computer: HOME.the,
        device_id: LOCAL_MACHINE_ID,
        provider: "openai-codex",
        model: "gpt-5",
        account_id: null,
        opened_at: 5_000,
        last_at: 5_000,
        began: "start",
        current: true,
      },
    ]);
    // A sentence that mentions a location is history, and stays as it was written.
    expect(record.prompt).toBe(sent.mention);
    expect(record.plugin).toBe(join(tools, "plugin"));
    expect(readFileSync(join(record.plugin, "plugin.json"), "utf8")).toBe('{"name":"clock"}\n');
    const rolling = join(to.homeData, "firstmate", "sessions", "rolling.jsonl");
    expect(record.firstmateSession).toBe(rolling);
    expect(existsSync(rolling)).toBe(true);
  });

  it("names the folder a project landed in when one of its name was already there", async () => {
    const to = destination();
    const own = join(to.homeData, "fleet", "website");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "kept.txt"), "this computer's own\n");
    const sent = await send(old, to);

    await to.incoming.answer(HOME_ARRIVE_ORDER, [sent.order]);

    const landed = join(to.homeData, "fleet", "website-2");
    expect(sh(landed, "branch", "--format=%(refname:short)")).toContain("fm/website");
    expect(readFileSync(join(own, "kept.txt"), "utf8")).toBe("this computer's own\n");
    const record = saved(to.homeData);
    expect(record.repos[0]).toEqual({ id: "r1", path: landed });
    expect(record.tasks[0]?.repo_dir).toBe(landed);
  });

  // Whichever is listed first takes the name, and the other lands beside it.
  it.each([
    { shop: "first", website: "website-2", other: "website" },
    { shop: "last", website: "website", other: "website-2" },
  ] as const)(
    "keeps two projects whose folders share a name apart when the one kept on another disk is listed $shop",
    async ({ shop, website, other }) => {
      const to = destination();
      const sent = await send(old, to, shop);

      await to.incoming.answer(HOME_ARRIVE_ORDER, [sent.order]);

      const fleet = join(to.homeData, "fleet");
      expect(sh(join(fleet, website), "branch", "--format=%(refname:short)")).toContain(
        "fm/website",
      );
      expect(sh(join(fleet, other), "branch", "--format=%(refname:short)")).toContain("fm/shop");
      const record = saved(to.homeData);
      expect(record.repos.filter((repo) => ["r1", "r4"].includes(repo.id))).toEqual([
        { id: "r1", path: join(fleet, website) },
        { id: "r4", path: join(fleet, other) },
      ]);
      expect(
        record.tasks
          .filter((task) => ["task-1", "task-5"].includes(task.id))
          .map((task) => [task.id, task.repo_dir]),
      ).toEqual([
        ["task-1", join(fleet, website)],
        ["task-5", join(fleet, other)],
      ]);
    },
  );
});

// Each case names the system it lands on, so both directions run on every system the checks run on.
describe("where a project lands on the new home", () => {
  it("keeps its place under the data folder or the home folder, or joins the others, from a Windows PC onto a Mac", () => {
    const to = { homeData: MAC.userData, homeDir: MAC.homeDir };
    const landing = (location: string) => projectLanding(location, WINDOWS_PC, to, posix);
    expect(landing("C:\\Users\\ada\\AppData\\Roaming\\infinitary\\fleet\\website")).toBe(
      "/Users/ada/Library/Application Support/infinitary/fleet/website",
    );
    expect(landing("C:\\Users\\ada\\code\\tools")).toBe("/Users/ada/code/tools");
    expect(landing("D:\\work\\notes")).toBe(
      "/Users/ada/Library/Application Support/infinitary/fleet/notes",
    );
  });

  it("does the same from a Mac onto a Windows PC", () => {
    const to = { homeData: WINDOWS_PC.userData, homeDir: WINDOWS_PC.homeDir };
    const landing = (location: string) => projectLanding(location, MAC, to, win32);
    expect(landing("/Users/ada/Library/Application Support/infinitary/fleet/website")).toBe(
      "C:\\Users\\ada\\AppData\\Roaming\\infinitary\\fleet\\website",
    );
    expect(landing("/Users/ada/code/tools")).toBe("C:\\Users\\ada\\code\\tools");
    expect(landing("/Volumes/work/notes")).toBe(
      "C:\\Users\\ada\\AppData\\Roaming\\infinitary\\fleet\\notes",
    );
  });
});
