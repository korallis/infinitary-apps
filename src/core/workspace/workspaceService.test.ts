import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { BATCH_BRANCH_PREFIX } from "@shared/batches";
import { describe, expect, it, vi } from "vitest";
import { BUNDLED_NAMING } from "../../../tests/helpers/namingRunbook";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { captureLoginPath, resetLoginPathForTests } from "../hostEnv";
import { writeLoginShellStub } from "../loginShellStub";
import { appPathsFor } from "../paths";
import { git } from "./git";
import { branchNameRefusal, nameTaskBranch, taskBranchStem } from "./taskBranches";
import { keptRefFor, WorkspaceService } from "./workspaceService";

// Integration budget (docs/test-cohorts.md): real git, the slowest test
// 2.392 s at its fastest of three eight-worker Mac runs (pass 4).
vi.setConfig({ testTimeout: 15_000 });

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

// The app names and checks commits by its active naming runbook; this is the bundled one, on by default.
function emptyService() {
  const userData = scratchDir("infinitary-ws-");
  const paths = appPathsFor(userData);
  return { paths, workspace: new WorkspaceService(paths, { namingRule: () => BUNDLED_NAMING }) };
}

// Only preparation is shared: no test ever opens this repository for writes.
// Initialisation itself remains exercised by the empty-service case below.
let defaultRepoTemplate: Promise<string> | undefined;
async function service() {
  defaultRepoTemplate ??= (async () => {
    const { workspace } = emptyService();
    const repo = await workspace.ensureDefaultRepo();
    await git(repo, ["config", "maintenance.auto", "false"]);
    return repo;
  })();
  const fixture = emptyService();
  mkdirSync(dirname(fixture.paths.defaultWorkspaceDir), { recursive: true });
  cpSync(await defaultRepoTemplate, fixture.paths.defaultWorkspaceDir, { recursive: true });
  return fixture;
}

/**
 * A pnpm stand-in that logs its arguments and answers each attempt the way
 * the test asks: the offline attempt (`--offline` present) and the online
 * one exit with their own codes. On Windows it is a batch file, as the pnpm
 * npm or Corepack installs is, which hands the same work to a Node script.
 */
function stubPnpm(dir: string, offlineExit: number, onlineExit: number) {
  const log = join(dir, "pnpm-calls.log");
  const windows = process.platform === "win32";
  const bin = join(dir, windows ? "pnpm-stub.cmd" : "pnpm-stub.sh");
  if (windows) {
    const script = join(dir, "pnpm-stub.cjs");
    writeFileSync(
      script,
      `const { appendFileSync, realpathSync } = require("node:fs");
const args = process.argv.slice(2).join(" ");
appendFileSync(${JSON.stringify(log)}, realpathSync(process.cwd()) + "|" + args + "\\n");
const offline = args.includes("--offline");
const exit = offline ? ${offlineExit} : ${onlineExit};
if (exit !== 0) {
  console.error(offline ? "ERR_PNPM_NO_OFFLINE_TARBALL missing from the store" : "ERR_PNPM_FETCH_404 not found");
}
process.exit(exit);
`,
    );
    writeFileSync(bin, `@node "${script}" %*\r\n`);
  } else {
    writeFileSync(
      bin,
      `#!/bin/sh
echo "$PWD|$*" >> "${log}"
case "$*" in
  *--offline*) [ ${offlineExit} -eq 0 ] || echo "ERR_PNPM_NO_OFFLINE_TARBALL missing from the store" >&2; exit ${offlineExit} ;;
esac
[ ${onlineExit} -eq 0 ] || echo "ERR_PNPM_FETCH_404 not found" >&2
exit ${onlineExit}
`,
    );
    chmodSync(bin, 0o755);
  }
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split("|"))
      : [];
  return { bin, calls };
}

describe("dependency install at commission (interaction P0, WI-7)", () => {
  async function worktreeWithLockfile(pnpm: string) {
    const userData = scratchDir("infinitary-ws-");
    const workspace = new WorkspaceService(appPathsFor(userData), { pnpm });
    const ws = await workspace.createTaskWorktree("abcd1234");
    writeFileSync(join(ws.cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    return { workspace, ws };
  }

  it("installs from the shared store offline with a frozen lockfile, in the worktree", async () => {
    const stub = stubPnpm(scratchDir("infinitary-pnpm-"), 0, 0);
    const { workspace, ws } = await worktreeWithLockfile(stub.bin);
    const result = await workspace.installDependencies(ws.cwd);
    expect(result.outcome).toBe("offline");
    expect(stub.calls()).toEqual([[realpathSync(ws.cwd), "install --frozen-lockfile --offline"]]);
  });

  function directoryWithLockfile(pnpm: string) {
    const { paths } = emptyService();
    const workspace = new WorkspaceService(paths, { pnpm });
    const cwd = scratchDir("infinitary-install-policy-");
    writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    return { workspace, cwd };
  }

  it("falls back to an online frozen install when the store misses a package", async () => {
    const stub = stubPnpm(scratchDir("infinitary-pnpm-"), 1, 0);
    const { workspace, cwd } = directoryWithLockfile(stub.bin);
    const result = await workspace.installDependencies(cwd);
    expect(result.outcome).toBe("online");
    expect(stub.calls().map(([, args]) => args)).toEqual([
      "install --frozen-lockfile --offline",
      "install --frozen-lockfile",
    ]);
  });

  it("reports a failed install with the reason instead of throwing", async () => {
    const stub = stubPnpm(scratchDir("infinitary-pnpm-"), 1, 1);
    const { workspace, cwd } = directoryWithLockfile(stub.bin);
    const result = await workspace.installDependencies(cwd);
    expect(result).toMatchObject({ outcome: "failed", error: "ERR_PNPM_FETCH_404 not found" });
  });

  it("finds the pnpm the person's shell puts on the path, though the app's own path is the system folders", async () => {
    const saved = { PATH: process.env.PATH, SHELL: process.env.SHELL };
    const dir = scratchDir("infinitary-pnpm-path-");
    const nvm = join(dir, "nvm", "bin");
    const stub = stubPnpm(dir, 0, 0);
    // The planted program is named pnpm and lives only on the shell's path.
    mkdirSync(nvm, { recursive: true });
    writeFileSync(join(nvm, "pnpm"), `#!/bin/sh\nexec '${stub.bin}' "$@"\n`);
    chmodSync(join(nvm, "pnpm"), 0o755);
    try {
      process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
      process.env.SHELL = writeLoginShellStub(join(dir, "shell"), {
        interactive: `PATH='${nvm}':"$PATH"`,
      }).shell;
      resetLoginPathForTests();
      await captureLoginPath();
      const userData = scratchDir("infinitary-ws-");
      const workspace = new WorkspaceService(appPathsFor(userData));
      const cwd = scratchDir("infinitary-install-path-");
      writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      expect(await workspace.installDependencies(cwd)).toMatchObject({ outcome: "offline" });
      expect(stub.calls()).toEqual([[realpathSync(cwd), "install --frozen-lockfile --offline"]]);
    } finally {
      resetLoginPathForTests();
      process.env.PATH = saved.PATH;
      process.env.SHELL = saved.SHELL;
    }
  });

  describe.runIf(process.platform === "win32")("on Windows", () => {
    /** A folder to put first on the search path, holding pnpm the way npm installs it there. */
    function npmInstalledPnpm(stub: string): string {
      const bin = scratchDir("infinitary-npm-bin-");
      // The shim a Git Bash runs, which Windows itself cannot start.
      writeFileSync(join(bin, "pnpm"), "#!/bin/sh\nexit 1\n");
      writeFileSync(join(bin, "pnpm.cmd"), `@"${stub}" %*\r\n`);
      return bin;
    }

    function lockfileFolder(): string {
      const cwd = scratchDir("infinitary-install-windows-");
      writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      return cwd;
    }

    async function withSearchPath<T>(path: string, run: () => Promise<T>): Promise<T> {
      const saved = process.env.PATH;
      process.env.PATH = path;
      try {
        return await run();
      } finally {
        process.env.PATH = saved;
      }
    }

    it("starts a pnpm that is a batch file, found by its name on the search path", async () => {
      const stub = stubPnpm(scratchDir("infinitary-pnpm-"), 0, 0);
      const bin = npmInstalledPnpm(stub.bin);
      const { workspace } = emptyService();
      const cwd = lockfileFolder();
      const result = await withSearchPath(`${bin};${process.env.PATH}`, () =>
        workspace.installDependencies(cwd),
      );
      expect(result).toMatchObject({ outcome: "offline" });
      expect(stub.calls()).toEqual([[realpathSync(cwd), "install --frozen-lockfile --offline"]]);
    });

    it("never runs a file named pnpm that the project itself holds", async () => {
      const stub = stubPnpm(scratchDir("infinitary-pnpm-"), 0, 0);
      const bin = npmInstalledPnpm(stub.bin);
      const { workspace } = emptyService();
      const cwd = lockfileFolder();
      writeFileSync(join(cwd, "pnpm.cmd"), "@echo ran > project-pnpm-ran.txt\r\n@exit /b 1\r\n");
      const result = await withSearchPath(`${bin};${process.env.PATH}`, () =>
        workspace.installDependencies(cwd),
      );
      expect(existsSync(join(cwd, "project-pnpm-ran.txt"))).toBe(false);
      expect(result).toMatchObject({ outcome: "offline" });
      expect(stub.calls()).toEqual([[realpathSync(cwd), "install --frozen-lockfile --offline"]]);
    });

    it("starts a batch file by its own path, in a folder named like a variable", async () => {
      const stub = stubPnpm(scratchDir("infinitary-pnpm-"), 0, 0);
      // A valid folder name, which cmd.exe would read as its Windows folder.
      const named = join(scratchDir("infinitary-npm-bin-"), "%SystemRoot%");
      mkdirSync(named);
      writeFileSync(join(named, "pnpm.cmd"), `@"${stub.bin}" %*\r\n`);
      const { workspace } = emptyService();
      const cwd = lockfileFolder();
      const result = await withSearchPath(`${named};${process.env.PATH}`, () =>
        workspace.installDependencies(cwd),
      );
      expect(result).toMatchObject({ outcome: "offline" });
      expect(stub.calls()).toEqual([[realpathSync(cwd), "install --frozen-lockfile --offline"]]);
    });

    it("says pnpm could not be started when no folder on the search path holds it", async () => {
      const { workspace } = emptyService();
      const cwd = lockfileFolder();
      const result = await withSearchPath(scratchDir("infinitary-empty-path-"), () =>
        workspace.installDependencies(cwd),
      );
      expect(result).toMatchObject({ outcome: "failed", error: "spawn pnpm ENOENT" });
    });

    /**
     * A pnpm stand-in that never ends by itself: a batch file starts a
     * program, which starts another under it, and both write down their
     * process numbers and wait. `loud` also prints more than an install may;
     * `orphan` puts a program that ends at once between the two, so nothing
     * leads from the first program to the last and Windows cannot find it
     * to end it.
     */
    function unendingPnpm(mode: "quiet" | "loud" | "orphan") {
      const dir = scratchDir("infinitary-pnpm-unending-");
      const log = join(dir, "started.log");
      const script = join(dir, "unending.cjs");
      writeFileSync(
        script,
        `const { appendFileSync, existsSync, readFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const log = ${JSON.stringify(log)};
const [mode, role = "top"] = process.argv.slice(2);
const under = () => (existsSync(log) ? readFileSync(log, "utf8").split("\\n").filter((line) => line.startsWith("under ")).length : 0);
const start = (next, detached) =>
  spawn(process.execPath, [__filename, mode, next], { stdio: "inherit", detached, windowsHide: true });
if (role === "middle") {
  start("under", true).unref();
  process.exit(0);
}
const before = under();
appendFileSync(log, role + " " + process.pid + "\\n");
if (role === "top") {
  start(mode === "orphan" ? "middle" : "under", false);
  if (mode === "loud") {
    const wait = setInterval(() => {
      if (under() === before) return;
      clearInterval(wait);
      process.stdout.write("x".repeat(17 * 1024 * 1024));
    }, 50);
  }
}
setTimeout(() => {}, 600000);
`,
      );
      const bin = join(dir, "pnpm-unending.cmd");
      writeFileSync(bin, `@node "${script}" ${mode}\r\n`);
      const started = (role: "top" | "under") =>
        (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [])
          .map((line) => line.split(" "))
          .filter(([name]) => name === role)
          .map(([, pid]) => Number(pid));
      const running = (pids: number[]) =>
        pids.filter((pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        });
      const end = () => {
        for (const pid of [...started("top"), ...started("under")]) {
          try {
            process.kill(pid);
          } catch {
            // Already ended, as the test expects.
          }
        }
      };
      return { bin, started, running, end };
    }

    it("has ended every program an install started by the time it reports running past its time", {
      timeout: 60_000,
    }, async () => {
      const pnpm = unendingPnpm("quiet");
      try {
        const { paths } = emptyService();
        const workspace = new WorkspaceService(paths, { pnpm: pnpm.bin, installTimeoutMs: 4_000 });
        const result = await workspace.installDependencies(lockfileFolder());
        expect(pnpm.running([...pnpm.started("top"), ...pnpm.started("under")])).toEqual([]);
        expect(result).toMatchObject({ outcome: "failed", error: "timed out" });
        // The offline attempt and the online one each started both programs.
        expect(pnpm.started("top")).toHaveLength(2);
        expect(pnpm.started("under")).toHaveLength(2);
      } finally {
        pnpm.end();
      }
    });

    it("has ended every program an install started by the time it reports printing too much", {
      timeout: 60_000,
    }, async () => {
      const pnpm = unendingPnpm("loud");
      try {
        const { paths } = emptyService();
        const workspace = new WorkspaceService(paths, { pnpm: pnpm.bin });
        const result = await workspace.installDependencies(lockfileFolder());
        expect(pnpm.running([...pnpm.started("top"), ...pnpm.started("under")])).toEqual([]);
        expect(result).toMatchObject({
          outcome: "failed",
          error: "stdout maxBuffer length exceeded",
        });
        expect(pnpm.started("top")).toHaveLength(2);
        expect(pnpm.started("under")).toHaveLength(2);
      } finally {
        pnpm.end();
      }
    });

    it("fails in bounded time, and starts no second attempt, when a program of the install cannot be ended", {
      timeout: 60_000,
    }, async () => {
      const pnpm = unendingPnpm("orphan");
      try {
        const { paths } = emptyService();
        const workspace = new WorkspaceService(paths, { pnpm: pnpm.bin, installTimeoutMs: 4_000 });
        const result = await workspace.installDependencies(lockfileFolder());
        expect(result).toMatchObject({ outcome: "failed", error: "timed out" });
        expect(pnpm.started("top")).toHaveLength(1);
        expect(pnpm.running(pnpm.started("top"))).toEqual([]);
        // The program Windows could not find is why no second attempt may start.
        expect(pnpm.running(pnpm.started("under"))).toHaveLength(1);
      } finally {
        pnpm.end();
      }
    });
  });

  it("skips a directory with no pnpm lockfile without running anything", async () => {
    const stub = stubPnpm(scratchDir("infinitary-pnpm-"), 0, 0);
    const userData = scratchDir("infinitary-ws-");
    const workspace = new WorkspaceService(appPathsFor(userData), { pnpm: stub.bin });
    const cwd = scratchDir("infinitary-no-lockfile-");
    expect(await workspace.installDependencies(cwd)).toEqual({ outcome: "skipped" });
    expect(stub.calls()).toEqual([]);
  });

  it("lists every fm/task-* branch with the task id it names, and nothing else", async () => {
    const { paths, workspace } = await service();
    await workspace.createTaskWorktree("aaaa1111");
    await workspace.createTaskWorktree("bbbb2222");
    await git(paths.defaultWorkspaceDir, ["branch", "feature/other"]);
    expect(await workspace.listTaskBranches(paths.defaultWorkspaceDir)).toEqual([
      { branch: "fm/task-aaaa1111", taskId: "aaaa1111" },
      { branch: "fm/task-bbbb2222", taskId: "bbbb2222" },
    ]);
    expect(await workspace.listTaskBranches(join(paths.userData, "not-a-repo"))).toEqual([]);
  });

  // INF-4195's plan: a task's branch takes the name its record holds, and
  // cleanup still tells the app's branches apart from the person's own.
  it("knows a task branch of any name by its mark, through a rename and until it is deleted", async () => {
    const { paths, workspace } = await service();
    const repo = paths.defaultWorkspaceDir;
    const made = await workspace.createTaskWorktree(
      "cccc3333",
      undefined,
      undefined,
      undefined,
      "inf/tidy-docs",
    );
    expect(made.branch).toBe("inf/tidy-docs");
    expect(await git(made.cwd, ["symbolic-ref", "--short", "HEAD"])).toBe("inf/tidy-docs");
    await git(repo, ["branch", "inf/someone-elses"]);
    expect(await workspace.listTaskBranches(repo)).toEqual([
      { branch: "inf/tidy-docs", taskId: "cccc3333" },
    ]);
    expect((await workspace.workspaceAt("cccc3333"))?.branch).toBe("inf/tidy-docs");

    await git(made.cwd, ["branch", "-m", "inf/tidy-docs-renamed"]);
    expect(await workspace.listTaskBranches(repo)).toEqual([
      { branch: "inf/tidy-docs-renamed", taskId: "cccc3333" },
    ]);

    await workspace.removeTaskWorktree({ ...made, branch: "inf/tidy-docs-renamed" });
    expect(await workspace.listTaskBranches(repo)).toEqual([]);
    expect(await git(repo, ["config", "--get-regexp", "infinitarytask"]).catch(() => "")).toBe("");
  });
});

describe("a new task's branch name (INF-4195's plan, piece 2)", () => {
  const ID = "4ab0c9d1";
  /** Names as the start does, reading the repository's branches and the other tasks' saved ones. */
  const named = (repoDir: string, stem: string, saved: string[] = []) =>
    nameTaskBranch({
      taskId: ID,
      stem,
      repoDir,
      savedByAnother: (branch) => saved.includes(branch),
    });

  it("takes the first mate's name, or inf/ and the title's words, with the task's code", async () => {
    const { paths } = await service();
    const repo = paths.defaultWorkspaceDir;
    const task = {
      id: ID,
      key: "INF-4200",
      title: "Build branch names from the naming runbook's words",
    };
    expect(
      await named(repo, taskBranchStem({ ...task, written: "inf/branch-names-runbook" })),
    ).toBe("inf/branch-names-runbook-4ab0");
    // The title's slug stops at a hyphen before it passes 48 characters.
    expect(await named(repo, taskBranchStem(task))).toBe(
      "inf/build-branch-names-from-the-naming-runbooks-4ab0",
    );
    expect(await named(repo, taskBranchStem({ ...task, title: "Réparer l'écran d'accueil" }))).toBe(
      "inf/reparer-lecran-daccueil-4ab0",
    );
    // A title with no Latin letters or digits takes the task's key.
    expect(await named(repo, taskBranchStem({ ...task, title: "修复登录超时" }))).toBe(
      "inf/inf-4200-4ab0",
    );
  });

  it("grows the code while the name is a branch, a remote-tracking branch or another task's saved branch", async () => {
    const { paths } = await service();
    const repo = paths.defaultWorkspaceDir;
    const stem = "inf/branch-names-runbook";
    await git(repo, ["branch", `${stem}-4ab0`]);
    await git(repo, ["update-ref", `refs/remotes/origin/${stem}-4ab0c`, "HEAD"]);
    // A branch under a folder of the name holds it as well.
    await git(repo, ["branch", `${stem}-4ab0c9/older`]);
    expect(await named(repo, stem, [`${stem}-4ab0c9d`])).toBe(`${stem}-4ab0c9d1`);
    await git(repo, ["branch", `${stem}-4ab0c9d1`]);
    await expect(named(repo, stem, [`${stem}-4ab0c9d`])).rejects.toThrow(
      `Every branch name from ${stem} for this task is taken in this project.`,
    );
    await expect(named(repo, "inf/branch-names-runbook-4ab0/deeper")).rejects.toThrow(
      `The branch ${stem}-4ab0 blocks inf/branch-names-runbook-4ab0/deeper-4ab0`,
    );
  });

  it("keeps the name a start that did not finish chose, by the repository's mark", async () => {
    const { workspace } = await service();
    const made = await workspace.createTaskWorktree(
      ID,
      undefined,
      undefined,
      undefined,
      "inf/first-try-4ab0",
    );
    expect(await named(made.repoDir, "inf/second-try")).toBe("inf/first-try-4ab0");
    // Sent a name worked out anew, as a computer that runs work is asked
    // again after a lost answer or a changed title, it answers that copy.
    const again = await workspace.createTaskWorktree(
      ID,
      undefined,
      undefined,
      undefined,
      "inf/second-try-4ab0",
    );
    expect(again).toMatchObject({ cwd: made.cwd, branch: "inf/first-try-4ab0" });
  });

  it("refuses in words exactly the names git refuses, and the app's batch branches", async () => {
    const { paths } = await service();
    const repo = paths.defaultWorkspaceDir;
    const names = [
      "inf/ok-name",
      "été",
      "a/@",
      "@",
      "x/HEAD",
      "a{b",
      "a@b",
      "HEAD",
      "-x",
      "a b",
      "a..b",
      "a@{b",
      "a/",
      "/a",
      "a//b",
      "a.",
      "a/.b",
      "a.lock",
      "a/b.lock/c",
      "a~b",
      "a^b",
      "a:b",
      "a?b",
      "a*b",
      "a[b",
      "a\\b",
      "tab\there",
    ];
    for (const name of names) {
      const gitTakes = await git(repo, ["check-ref-format", "--branch", name]).then(
        () => true,
        () => false,
      );
      expect({ name, refused: branchNameRefusal(name) !== undefined }).toEqual({
        name,
        refused: !gitTakes,
      });
    }
    expect(branchNameRefusal("a b")).toBe(
      'The branch name "a b" has a space or a control character; git takes no such branch name.',
    );
    expect(branchNameRefusal(`${BATCH_BRANCH_PREFIX}mine`)).toBe(
      `The branch name "${BATCH_BRANCH_PREFIX}mine" starts with ${BATCH_BRANCH_PREFIX}, which the app keeps for its batches.`,
    );
  });
});

describe("the copied repository fixture", () => {
  it("keeps files, config, refs and worktree registrations private, including future copies", async () => {
    const first = await service();
    const second = await service();
    const a = first.paths.defaultWorkspaceDir;
    const b = second.paths.defaultWorkspaceDir;
    expect(await git(a, ["rev-parse", "HEAD"])).toBe(await git(b, ["rev-parse", "HEAD"]));
    expect(await git(b, ["status", "--porcelain"])).toBe("");
    await git(a, ["config", "fixture.private", "first"]);
    writeFileSync(join(a, "private.txt"), "only first\n");
    await git(a, ["add", "private.txt"]);
    await git(a, ["commit", "-m", "test: private fixture write"]);
    const task = await first.workspace.createTaskWorktree("fixture1111");
    const third = await service();
    for (const { paths, workspace } of [second, third]) {
      const repo = paths.defaultWorkspaceDir;
      expect(existsSync(join(repo, "private.txt"))).toBe(false);
      expect(await git(repo, ["config", "--get", "fixture.private"]).catch(() => "")).toBe("");
      expect(await git(repo, ["branch", "--list", task.branch])).toBe("");
      expect(await git(repo, ["worktree", "list", "--porcelain"])).not.toContain("fixture1111");
      const own = await workspace.createTaskWorktree("fixture1111");
      expect(realpathSync(own.repoDir)).toBe(realpathSync(repo));
      expect(await git(own.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).toBe(
        join(realpathSync(repo), ".git"),
      );
    }
  });
});

describe("WorkspaceService", () => {
  it("initializes the default repo lazily with an initial commit", async () => {
    const { paths, workspace } = emptyService();
    expect(existsSync(paths.defaultWorkspaceDir)).toBe(false);
    const repo = await workspace.ensureDefaultRepo();
    expect(repo).toBe(paths.defaultWorkspaceDir);
    expect(await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(await git(repo, ["log", "--oneline"])).toContain("initialize default workspace");
    await workspace.ensureDefaultRepo();
    expect((await git(repo, ["log", "--oneline"])).split("\n")).toHaveLength(1);
  });

  // INF-3060's starts run behind the first mate's answer, so two spawns in a
  // fresh default workspace start at once; before they shared one creation,
  // the second git init failed on the first one's locked config.
  it("makes the default repo once when two starts ask for it at once", async () => {
    const { workspace } = emptyService();
    const [first, second] = await Promise.all([
      workspace.ensureDefaultRepo(),
      workspace.ensureDefaultRepo(),
    ]);
    expect(second).toBe(first);
    expect((await git(first, ["log", "--oneline"])).split("\n")).toHaveLength(1);
  });

  // INF-3307 audit: "A half-made default repository stops every task with no project from
  // starting". A launch stopped between the default repository's `git init` and its first
  // commit leaves a `.git` with no commit; every later start must still find a usable one.
  it("finishes a default repo a stopped launch left with no first commit, and starts a task in it", async () => {
    const { paths, workspace } = emptyService();
    const repo = paths.defaultWorkspaceDir;
    mkdirSync(repo, { recursive: true });
    await git(repo, ["init", "--initial-branch=main"]);
    writeFileSync(join(repo, "README.md"), "# Infinitary workspace\n");
    const ws = await workspace.createTaskWorktree("cccc3333");
    expect(await git(ws.cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("fm/task-cccc3333");
    expect(await git(repo, ["log", "--oneline"])).toContain("initialize default workspace");
    expect(await workspace.ensureDefaultRepo()).toBe(repo);
    expect((await git(repo, ["log", "--oneline"])).split("\n")).toHaveLength(1);
  });

  it("creates one worktree per task on its own branch", async () => {
    const { paths, workspace } = await service();
    const a = await workspace.createTaskWorktree("aaaa1111");
    const b = await workspace.createTaskWorktree("bbbb2222");
    expect(a.cwd).toBe(join(paths.worktreesDir, "aaaa1111"));
    expect(a.branch).toBe("fm/task-aaaa1111");
    expect(await git(a.cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("fm/task-aaaa1111");
    expect(await git(b.cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("fm/task-bbbb2222");
    const list = await git(paths.defaultWorkspaceDir, ["worktree", "list"]);
    expect(list).toContain("aaaa1111");
    expect(list).toContain("bbbb2222");
  });

  it("answers a task branch's head, and null for a branch that is gone", async () => {
    // The reviewed tier reads the builder's branch BEFORE any PR exists
    // (captain ruling, 2026-09-19): this is the head the review brief
    // names and the per-head round counter keys on.
    const { workspace } = await service();
    const ws = await workspace.createTaskWorktree("cccc3333");
    const head = await workspace.branchHead(ws.repoDir, ws.branch);
    expect(head).toBe(await git(ws.cwd, ["rev-parse", "HEAD"]));
    expect(await workspace.branchHead(ws.repoDir, "fm/task-never-was")).toBeNull();
  });

  it("lists every committed changed path at the review head, including spaces and leading whitespace", async () => {
    const { workspace } = await service();
    const ws = await workspace.createTaskWorktree("cccc4444");
    writeFileSync(join(ws.cwd, " leading space.txt"), "one\n");
    writeFileSync(join(ws.cwd, "second file.txt"), "two\n");
    await git(ws.cwd, ["add", "-A"]);
    await git(ws.cwd, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-m",
      "Add files",
    ]);
    const head = await git(ws.cwd, ["rev-parse", "HEAD"]);
    expect(await workspace.reviewChangedFiles(ws.repoDir, "1".repeat(40))).toBeNull();
    expect(await workspace.reviewChangedFiles(ws.repoDir, head)).toEqual([
      " leading space.txt",
      "second file.txt",
    ]);
    writeFileSync(join(ws.cwd, "uncommitted.txt"), "not at this head\n");
    expect(await workspace.reviewChangedFiles(ws.repoDir, head)).toEqual([
      " leading space.txt",
      "second file.txt",
    ]);
  });

  it("keeps one change reading across a pure update, and not across an edited conflict or an indentation change", async () => {
    // INF-148, the captain's words: a passed review should not start over
    // only because main moved, when the change itself is the same.
    const { workspace } = await service();
    const repo = await workspace.ensureDefaultRepo();
    const commit = async (file: string, body: string, message: string) => {
      writeFileSync(join(repo, file), body);
      await git(repo, ["add", file]);
      await git(repo, ["commit", "-m", message]);
      return git(repo, ["rev-parse", "HEAD"]);
    };
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    const base = `${lines.join("\n")}\n`;
    const changed = `${lines.map((line) => (line === "line 20" ? "line 20 changed" : line)).join("\n")}\n`;
    await commit("a.txt", base, "chore: base lines");
    await git(repo, ["checkout", "-b", "work"]);
    const reviewed = await commit("a.txt", changed, "feat: change line 20");
    const reviewedReading = await workspace.reviewChangeReading(repo, reviewed);
    expect(reviewedReading).toMatch(/^[0-9a-f]{64}$/);
    expect(await workspace.reviewChangeReading(repo, "1".repeat(40))).toBeNull();

    await git(repo, ["checkout", "main"]);
    await commit(
      "a.txt",
      `${base.replace("line 1\n", "line 1 main\n")}`,
      "chore: main edits a nearby line",
    );
    await git(repo, ["checkout", "work"]);
    await git(repo, ["rebase", "main"]);
    const updated = await git(repo, ["rev-parse", "HEAD"]);
    expect(updated).not.toBe(reviewed);
    expect(await workspace.reviewChangeReading(repo, updated)).toBe(reviewedReading);

    const indented = await commit(
      "a.txt",
      `${base.replace("line 1\n", "line 1 main\n").replace("line 20\n", "  line 20 changed\n")}`,
      "style: indent the changed line",
    );
    expect(await workspace.reviewChangeReading(repo, indented)).not.toBe(reviewedReading);

    await git(repo, ["checkout", "main"]);
    await commit(
      "a.txt",
      `${base.replace("line 1\n", "line 1 main\n").replace("line 20\n", "line 20 from main\n")}`,
      "chore: main edits the same line",
    );
    await git(repo, ["checkout", "-B", "conflict", reviewed]);
    await expect(git(repo, ["rebase", "main"])).rejects.toThrow();
    writeFileSync(
      join(repo, "a.txt"),
      `${base.replace("line 1\n", "line 1 main\n").replace("line 20\n", "line 20 changed and main\n")}`,
    );
    await git(repo, ["add", "a.txt"]);
    await git(repo, ["-c", "core.editor=true", "rebase", "--continue"]);
    const edited = await git(repo, ["rev-parse", "HEAD"]);
    expect(await workspace.reviewChangeReading(repo, edited)).not.toBe(reviewedReading);
  });

  // INF-4517 piece 3 and the independent review's findings on it: a part built on an earlier
  // part's approved version reads its own difference from there while its version builds on
  // it, even after the earlier part merged as a squash commit, and from the default branch
  // once it took that branch in.
  it("reads a part's own difference from the approved version it was built on until it takes in the default branch", async () => {
    const { workspace } = await service();
    const repo = await workspace.ensureDefaultRepo();
    const commit = async (message: string) => {
      await git(repo, ["add", "-A"]);
      await git(repo, ["commit", "-m", message]);
      return git(repo, ["rev-parse", "HEAD"]);
    };
    writeFileSync(join(repo, "meter.ts"), "export const meter = 1;\n");
    await commit("chore: start the meter");
    await git(repo, ["checkout", "-b", "earlier"]);
    writeFileSync(join(repo, "export.ts"), "export const csv = true;\n");
    const approved = await commit("feat: add the export");
    await git(repo, ["checkout", "-b", "later"]);
    writeFileSync(join(repo, "panel.ts"), "export const panel = true;\n");
    const later = await commit("feat: show the export in the panel");
    expect(await workspace.builtOnAt(repo, approved, later)).toBe(approved);

    // The earlier part merges as one squash commit: the approved version is not on main.
    await git(repo, ["checkout", "main"]);
    await git(repo, ["merge", "--squash", "earlier"]);
    await commit("feat: add the export (squashed)");
    expect(await workspace.builtOnAt(repo, approved, later)).toBe(approved);
    expect(await workspace.reviewChangedFiles(repo, later, approved)).toEqual(["panel.ts"]);
    expect(await workspace.changeLines(repo, later, approved)).toMatchObject({
      base: approved,
      added: 1,
      deleted: 0,
    });

    // The part takes in the default branch: it reads from there, as any change does.
    await git(repo, ["checkout", "later"]);
    await git(repo, ["merge", "--no-edit", "main"]);
    const updated = await git(repo, ["rev-parse", "HEAD"]);
    expect(await workspace.builtOnAt(repo, approved, updated)).toBeUndefined();
    expect(await workspace.reviewChangedFiles(repo, updated, approved)).toEqual(["panel.ts"]);
  });

  it("counts the lines the whole offered change adds and deletes: every commit, a rename's edit alone, no binary lines, and no reading for a commit it cannot see (INF-820)", async () => {
    // INF-820, the captain's words: "add line added/deleted stats to merge
    // completion card". The card's Lines cell shows this reading.
    const { workspace } = await service();
    const repo = await workspace.ensureDefaultRepo();
    const commit = async (message: string) => {
      await git(repo, ["add", "-A"]);
      await git(repo, ["commit", "-m", message]);
      return git(repo, ["rev-parse", "HEAD"]);
    };
    const lines = (count: number, tag: string) =>
      Array.from({ length: count }, (_, index) => `${tag} line ${index + 1}`).join("\n") + "\n";
    writeFileSync(join(repo, "meter.ts"), lines(30, "meter"));
    writeFileSync(join(repo, "old-name.ts"), lines(40, "kept"));
    writeFileSync(join(repo, "gone.ts"), lines(5, "gone"));
    const mainAt = await commit("chore: base files");
    await git(repo, ["checkout", "-b", "work"]);

    // First commit: three lines edited (3 added, 3 deleted), one file of
    // twelve new lines, and one five-line file deleted.
    writeFileSync(
      join(repo, "meter.ts"),
      lines(30, "meter").replace(/meter line (1|2|3)\n/g, "meter line $1 changed\n"),
    );
    writeFileSync(join(repo, "added.ts"), lines(12, "added"));
    rmSync(join(repo, "gone.ts"));
    const first = await commit("feat: edit, add and delete");
    expect(await workspace.changeLines(repo, first)).toEqual({
      base: mainAt,
      added: 15,
      deleted: 8,
    });

    // Second commit: a rename with one line edited counts that edit alone,
    // and a binary file adds no text lines. The reading covers both commits.
    rmSync(join(repo, "old-name.ts"));
    writeFileSync(
      join(repo, "new-name.ts"),
      lines(40, "kept").replace("kept line 40\n", "kept line 40 edited\n"),
    );
    writeFileSync(join(repo, "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 0, 3]));
    const second = await commit("feat: rename and add a picture");
    expect(await workspace.changeLines(repo, second)).toEqual({
      base: mainAt,
      added: 16,
      deleted: 9,
    });
    // INF-4517 piece 3: a part built on another part's approved version counts only its own
    // difference against that version, as its review reads it.
    expect(await workspace.changeLines(repo, second, first)).toEqual({
      base: first,
      added: 1,
      deleted: 1,
    });
    expect(await workspace.reviewChangedFiles(repo, second, first)).toEqual([
      "icon.png",
      "new-name.ts",
    ]);
    // The independent review's finding: that version counts only while the version read builds on it.
    expect(await workspace.builtOnAt(repo, first, second)).toBe(first);
    expect(await workspace.builtOnAt(repo, second, first)).toBeUndefined();

    // A change of only a binary file reads as zero lines, a real reading.
    await git(repo, ["checkout", "-b", "picture-only", "main"]);
    writeFileSync(join(repo, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 8, 0, 7]));
    const binaryOnly = await commit("feat: add a logo");
    expect(await workspace.changeLines(repo, binaryOnly)).toEqual({
      base: mainAt,
      added: 0,
      deleted: 0,
    });

    await git(repo, ["checkout", "main"]);
    writeFileSync(join(repo, "unrelated.ts"), lines(50, "main"));
    await commit("chore: main grows");
    expect(await workspace.changeLines(repo, second)).toEqual({
      base: mainAt,
      added: 16,
      deleted: 9,
    });

    // A commit this repository does not hold has no reading, never a zero.
    expect(await workspace.changeLines(repo, "1".repeat(40))).toBeNull();
  });

  it("treats a moved guard as a different change once the file is already on main", async () => {
    // Review finding R1. Both functions are on main first, so the change is
    // only the inserted guard. With no context the two placements read the
    // same; one neighboring line makes a move an edit.
    const { workspace } = await service();
    const repo = await workspace.ensureDefaultRepo();
    const source = [
      "function a() {",
      "  return 1;",
      "}",
      "function b() {",
      "  return 2;",
      "}",
      "",
    ].join("\n");
    writeFileSync(join(repo, "guard.ts"), source);
    await git(repo, ["add", "guard.ts"]);
    await git(repo, ["commit", "-m", "chore: two functions"]);
    await git(repo, ["checkout", "-b", "moved"]);
    const place = async (fn: "a" | "b", message: string) => {
      const body = source.replace(
        `function ${fn}() {\n`,
        `function ${fn}() {\n  if (!ok) return;\n`,
      );
      writeFileSync(join(repo, "guard.ts"), body);
      await git(repo, ["add", "guard.ts"]);
      await git(repo, ["commit", "-m", message]);
      return git(repo, ["rev-parse", "HEAD"]);
    };
    const inserted = await place("a", "feat: guard function a");
    const moved = await place("b", "fix: move the guard to function b");
    expect(await workspace.reviewChangeReading(repo, moved)).not.toBe(
      await workspace.reviewChangeReading(repo, inserted),
    );
  });

  it("reuses an existing matching worktree on a second create", async () => {
    const { workspace } = await service();
    const first = await workspace.createTaskWorktree("dddd4444");
    writeFileSync(join(first.cwd, "keep.txt"), "stayed\n");
    const second = await workspace.createTaskWorktree("dddd4444");
    // The same tree, and nothing acquired this time: it was already there.
    const { acquired, ...tree } = first;
    expect(acquired?.source).toBe("new");
    expect(second).toEqual(tree);
    expect(existsSync(join(first.cwd, "keep.txt"))).toBe(true);
    expect(await git(first.cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("fm/task-dddd4444");
  });

  it("checks out an existing leftover branch without failing add -b", async () => {
    const { paths, workspace } = await service();
    const first = await workspace.createTaskWorktree("eeee5555");
    await git(first.repoDir, ["worktree", "remove", first.cwd]);
    expect(existsSync(first.cwd)).toBe(false);
    expect(
      await git(paths.defaultWorkspaceDir, ["branch", "--list", "fm/task-eeee5555"]),
    ).toContain("fm/task-eeee5555");
    const second = await workspace.createTaskWorktree("eeee5555");
    expect(second.branch).toBe("fm/task-eeee5555");
    expect(await git(second.cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("fm/task-eeee5555");
  });

  it("replaces a stale empty worktree path left by a failed add", async () => {
    const { paths, workspace } = await service();
    mkdirSync(join(paths.worktreesDir, "ffff6666"), { recursive: true });
    const created = await workspace.createTaskWorktree("ffff6666");
    expect(await git(created.cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("fm/task-ffff6666");
  });
});

// The delete path: what every removal did before the warm pool, and what a
// removal still does when the pool is off or cannot take the tree.
describe("worktree deletion off the settle path (character-jank scout)", () => {
  /** A deleteTree the test releases, so the order of events is observable. */
  function heldDeletion() {
    const started: string[] = [];
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deleteTree = async (dir: string) => {
      started.push(dir);
      await released;
      rmSync(dir, { recursive: true, force: true });
    };
    return { deleteTree, started, release };
  }

  it("returns before the tree is deleted, with the worktree and branch already gone", async () => {
    const userData = scratchDir("infinitary-ws-");
    const paths = appPathsFor(userData);
    const held = heldDeletion();
    const workspace = new WorkspaceService(paths, { deleteTree: held.deleteTree, pool: false });
    const ws = await workspace.createTaskWorktree("dddd4444");
    mkdirSync(join(ws.cwd, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(ws.cwd, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");

    await workspace.removeTaskWorktree(ws);

    // The settle has its answer while the tree is still being deleted.
    expect(held.started).toHaveLength(1);
    const trashed = held.started[0] as string;
    expect(existsSync(join(trashed, "node_modules", "pkg", "index.js"))).toBe(true);
    expect(existsSync(ws.cwd)).toBe(false);
    // git lists realpaths, so match the task id rather than the path.
    expect(await git(paths.defaultWorkspaceDir, ["worktree", "list"])).not.toContain("dddd4444");
    expect(await git(paths.defaultWorkspaceDir, ["branch", "--list", ws.branch])).toBe("");

    held.release();
    await workspace.deletionsSettled();
    expect(existsSync(trashed)).toBe(false);
  });

  it("deletes the tree for real in the background and leaves the trash empty", async () => {
    const paths = appPathsFor(scratchDir("infinitary-ws-"));
    const workspace = new WorkspaceService(paths, { pool: false });
    const ws = await workspace.createTaskWorktree("eeee5555");
    writeFileSync(join(ws.cwd, "big.txt"), "x".repeat(100_000));
    await workspace.removeTaskWorktree(ws);
    await workspace.deletionsSettled();
    expect(readdirSync(paths.worktreeTrashDir)).toEqual([]);
    const again = await workspace.createTaskWorktree("eeee5555");
    expect(existsSync(again.cwd)).toBe(true);
  });

  it("finishes at boot what a quit left half-deleted", async () => {
    const userData = scratchDir("infinitary-ws-");
    const paths = appPathsFor(userData);
    mkdirSync(join(paths.worktreeTrashDir, "ffff6666-left", "node_modules"), { recursive: true });
    writeFileSync(join(paths.worktreeTrashDir, "ffff6666-left", "node_modules", "a.js"), "1");
    const workspace = new WorkspaceService(paths, { pool: false });
    workspace.sweepTrash();
    await workspace.deletionsSettled();
    expect(readdirSync(paths.worktreeTrashDir)).toEqual([]);
    // No trash dir at all is nothing to do.
    new WorkspaceService(appPathsFor(scratchDir("infinitary-ws-"))).sweepTrash();
  });

  it("never moves aside a tree outside the app's worktrees area", async () => {
    const userData = scratchDir("infinitary-ws-");
    const paths = appPathsFor(userData);
    const held = heldDeletion();
    const workspace = new WorkspaceService(paths, { deleteTree: held.deleteTree, pool: false });
    await workspace.createTaskWorktree("cdcd8888");
    // A record pointing at the repo's own checkout: git refuses to remove a
    // main worktree, and nothing is moved into the trash.
    await workspace
      .removeTaskWorktree({
        taskId: "cdcd8888",
        cwd: paths.defaultWorkspaceDir,
        branch: "fm/task-cdcd8888",
        repoDir: paths.defaultWorkspaceDir,
      })
      .catch(() => {});
    expect(held.started).toEqual([]);
    expect(existsSync(paths.worktreeTrashDir)).toBe(false);
  });

  it("removes a tree it cannot move aside in place, as before", async () => {
    const userData = scratchDir("infinitary-ws-");
    const paths = appPathsFor(userData);
    const held = heldDeletion();
    const workspace = new WorkspaceService(paths, { deleteTree: held.deleteTree, pool: false });
    const ws = await workspace.createTaskWorktree("abab7777");
    writeFileSync(paths.worktreeTrashDir, "not a directory");
    await workspace.removeTaskWorktree(ws);
    expect(held.started).toEqual([]);
    expect(existsSync(ws.cwd)).toBe(false);
    expect(await git(paths.defaultWorkspaceDir, ["branch", "--list", ws.branch])).toBe("");
  });
});

describe("taskWorkStatus (P1: what a discard would destroy)", () => {
  async function serviceWithRemote() {
    const result = await service();
    await result.workspace.ensureDefaultRepo();
    const remote = scratchDir("infinitary-remote-");
    await git(remote, ["init", "--bare", "--initial-branch=main"]);
    await git(result.paths.defaultWorkspaceDir, ["remote", "add", "origin", remote]);
    await git(result.paths.defaultWorkspaceDir, ["push", "--set-upstream", "origin", "main"]);
    await git(result.paths.defaultWorkspaceDir, ["remote", "set-head", "origin", "main"]);
    return result;
  }

  it("counts unlanded commits and sees uncommitted edits", async () => {
    const { workspace } = await service();
    const task = await workspace.createTaskWorktree("stat2222");
    writeFileSync(join(task.cwd, "a.txt"), "one\n");
    await git(task.cwd, ["add", "-A"]);
    await git(task.cwd, ["commit", "-m", "feat: one"]);
    writeFileSync(join(task.cwd, "b.txt"), "wip\n");
    expect(await workspace.taskWorkStatus(task)).toEqual({ dirty: true, unlandedCommits: 1 });
  });

  it("treats landed commits as safe again", async () => {
    const { workspace } = await service();
    const task = await workspace.createTaskWorktree("stat3333");
    writeFileSync(join(task.cwd, "a.txt"), "one\n");
    await git(task.cwd, ["add", "-A"]);
    await git(task.cwd, ["commit", "-m", "feat: one"]);
    await workspace.landTaskWork(task);
    expect(await workspace.taskWorkStatus(task)).toEqual({ dirty: false, unlandedCommits: 0 });
  });

  it("treats task commits on the tracked remote integration branch as landed", async () => {
    const { paths, workspace } = await serviceWithRemote();
    const task = await workspace.createTaskWorktree("statremote1");
    writeFileSync(join(task.cwd, "remote.txt"), "merged\n");
    await git(task.cwd, ["add", "-A"]);
    await git(task.cwd, ["commit", "-m", "feat: merged remotely"]);

    await git(task.cwd, ["push", "origin", `${task.branch}:main`]);
    await git(paths.defaultWorkspaceDir, ["fetch", "origin", "main"]);

    expect(await git(paths.defaultWorkspaceDir, ["rev-parse", "HEAD"])).not.toBe(
      await git(paths.defaultWorkspaceDir, ["rev-parse", "origin/main"]),
    );
    expect(await workspace.taskWorkStatus(task)).toEqual({ dirty: false, unlandedCommits: 0 });
  });

  // INF-3169 piece 2: a done close naming a commit reads whether it is on the main branch.
  it("reads a commit as on the main branch once it merged there, remotely too, and null for one it cannot find", async () => {
    const { paths, workspace } = await serviceWithRemote();
    const task = await workspace.createTaskWorktree("onmain1");
    writeFileSync(join(task.cwd, "meter.txt"), "fixed meter\n");
    await git(task.cwd, ["add", "-A"]);
    await git(task.cwd, ["commit", "-m", "fix: the meter"]);
    const commit = await git(task.cwd, ["rev-parse", "HEAD"]);
    const repo = paths.defaultWorkspaceDir;
    expect(await workspace.commitOnMain(repo, commit)).toBe(false);
    await git(task.cwd, ["push", "origin", `${task.branch}:main`]);
    await git(repo, ["fetch", "origin", "main"]);
    expect(await workspace.commitOnMain(repo, commit)).toBe(true);
    expect(await workspace.commitOnMain(repo, commit.slice(0, 12))).toBe(true);
    expect(await workspace.commitOnMain(repo, "0".repeat(40))).toBeNull();
  });

  it("keeps commits protected when they exist only on the task's remote branch", async () => {
    const { workspace } = await serviceWithRemote();
    const task = await workspace.createTaskWorktree("statremote2");
    writeFileSync(join(task.cwd, "remote.txt"), "pushed only\n");
    await git(task.cwd, ["add", "-A"]);
    await git(task.cwd, ["commit", "-m", "feat: pushed but unmerged"]);

    await git(task.cwd, ["push", "--set-upstream", "origin", task.branch]);

    expect(await workspace.taskWorkStatus(task)).toEqual({ dirty: false, unlandedCommits: 1 });
  });

  it("uses a valid remote default when the checked-out upstream is stale", async () => {
    const { paths, workspace } = await serviceWithRemote();
    const task = await workspace.createTaskWorktree("statremote3");
    writeFileSync(join(task.cwd, "remote.txt"), "merged\n");
    await git(task.cwd, ["add", "-A"]);
    await git(task.cwd, ["commit", "-m", "feat: merged on default"]);
    await git(task.cwd, ["push", "origin", `${task.branch}:main`]);
    await git(paths.defaultWorkspaceDir, ["fetch", "origin", "main"]);
    await git(paths.defaultWorkspaceDir, ["config", "branch.main.merge", "refs/heads/missing"]);

    expect(await workspace.taskWorkStatus(task)).toEqual({ dirty: false, unlandedCommits: 0 });
  });

  it("reports nothing to lose when the worktree is already gone", async () => {
    const { workspace } = await service();
    const task = await workspace.createTaskWorktree("stat4444");
    await workspace.removeTaskWorktree(task);
    expect(await workspace.taskWorkStatus(task)).toEqual({ dirty: false, unlandedCommits: 0 });
  });
});

// R4: optional Git bookkeeping cannot retain a saved task tree when its project disappears.
describe("retiring a task after its project folder disappears", () => {
  it.each([false, true])("removes the task tree with a prepared remote: %s", async (bound) => {
    const { workspace, paths } = await service();
    const repo = await workspace.ensureDefaultRepo();
    const origin = join(dirname(repo), "disposable-origin.git");
    await git(repo, ["clone", "--quiet", "--bare", repo, origin]);
    const task = await workspace.createTaskWorktree(
      "missing-project",
      repo,
      undefined,
      bound ? { origin } : undefined,
    );
    await workspace.poolSettled();
    rmSync(repo, { recursive: true, force: true });
    await workspace.removeTaskWorktree(task);
    await workspace.deletionsSettled();
    expect(existsSync(task.cwd)).toBe(false);
    expect(existsSync(paths.defaultWorkspaceDir)).toBe(false);
  });
});

describe("retireTaskWorktree (always clean, work saved first)", () => {
  it("saves nothing for landed work and still removes the tree and branch", async () => {
    const { workspace, paths } = await service();
    const task = await workspace.createTaskWorktree("keep1111");
    writeFileSync(join(task.cwd, "a.txt"), "one\n");
    await git(task.cwd, ["add", "-A"]);
    await git(task.cwd, ["commit", "-m", "feat: one"]);
    await workspace.landTaskWork(task);

    expect(await workspace.retireTaskWorktree(task)).toEqual({ outcome: "removed", kept: null });
    expect(existsSync(task.cwd)).toBe(false);
    expect(await git(paths.defaultWorkspaceDir, ["for-each-ref", "refs/infinitary"])).toBe("");
    expect(await workspace.branchHead(paths.defaultWorkspaceDir, task.branch)).toBeNull();
  });

  it("saves even landed work when asked to always keep, so a named ref exists", async () => {
    const { workspace, paths } = await service();
    const task = await workspace.createTaskWorktree("keep2222");
    const retired = await workspace.retireTaskWorktree(task, { keepAlways: true });
    expect(retired).toMatchObject({
      outcome: "removed",
      kept: { ref: keptRefFor("keep2222"), dirty: false, unlandedCommits: 0 },
    });
    expect(
      await git(paths.defaultWorkspaceDir, ["rev-parse", `${keptRefFor("keep2222")}^{commit}`]),
    ).toBe(retired.outcome === "removed" ? retired.kept?.sha : "");
  });

  it("keeps an earlier save as a parent when the same task is saved again", async () => {
    const { workspace, paths } = await service();
    const repo = paths.defaultWorkspaceDir;
    const first = await workspace.createTaskWorktree("keep3333");
    writeFileSync(join(first.cwd, "first.txt"), "first\n");
    await workspace.retireTaskWorktree(first);
    const again = await workspace.createTaskWorktree("keep3333");
    writeFileSync(join(again.cwd, "second.txt"), "second\n");
    await workspace.retireTaskWorktree(again);

    const ref = keptRefFor("keep3333");
    expect(await git(repo, ["show", `${ref}:second.txt`])).toBe("second");
    expect(await git(repo, ["show", `${ref}^2:first.txt`])).toBe("first");
  });

  it("never reads an enclosing repository as the tree's own: a plain directory is refused, not removed", async () => {
    const { paths } = emptyService();
    // The worktrees area itself sits inside a repository.
    await git(paths.userData, ["init", "--initial-branch=main"]);
    const workspace = new WorkspaceService(paths);
    const dir = join(paths.worktreesDir, "plain1111");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "notes.txt"), "not a checkout\n");

    expect(await workspace.workspaceAt("plain1111")).toBeNull();
    expect(await workspace.removeEmptyWorktreeDir("plain1111")).toBe(false);
    const retired = await workspace.retireTaskWorktree({
      taskId: "plain1111",
      cwd: dir,
      branch: "",
      repoDir: paths.userData,
    });
    expect(retired).toMatchObject({ outcome: "kept" });
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("not a checkout\n");
  });

  it("finds the repository and task branch of a tree whose record is gone", async () => {
    const { workspace, paths } = await service();
    const task = await workspace.createTaskWorktree("orph1111");
    expect(await workspace.workspaceAt("orph1111")).toEqual({
      taskId: "orph1111",
      cwd: task.cwd,
      branch: "fm/task-orph1111",
      repoDir: realpathSync(paths.defaultWorkspaceDir),
    });
    expect(workspace.listWorktreeDirs()).toEqual(["orph1111"]);
  });
});

// INF-3060 finding 6: a leftover task branch's card deletes it on the
// captain's click, the branch's commits saved first; one still checked out
// stays and says why.
describe("retireTaskBranch (a leftover branch, work saved first)", () => {
  it("saves a leftover branch's unlanded commit on the kept ref, then deletes the branch", async () => {
    const { workspace, paths } = await service();
    const repo = paths.defaultWorkspaceDir;
    const task = await workspace.createTaskWorktree("left1111");
    writeFileSync(join(task.cwd, "draft.txt"), "draft\n");
    await git(task.cwd, ["add", "-A"]);
    await git(task.cwd, ["commit", "-m", "feat: draft"]);
    const tip = await git(task.cwd, ["rev-parse", "HEAD"]);
    // The working copy goes the way a crash leaves it: only the branch stays.
    await git(repo, ["worktree", "remove", "--force", task.cwd]);

    expect(await workspace.retireTaskBranch(repo, task.branch, "left1111")).toEqual({
      outcome: "removed",
    });
    expect(await workspace.branchHead(repo, task.branch)).toBeNull();
    expect(await git(repo, ["show", `${keptRefFor("left1111")}:draft.txt`])).toBe("draft");
    expect(await git(repo, ["merge-base", "--is-ancestor", tip, keptRefFor("left1111")])).toBe("");
  });

  // INF-4195's plan: start-up cleanup finds a leftover branch named from a
  // task by its mark, as it finds an fm/task-* one by its name.
  it("finds and retires a leftover inf/ branch by its mark, its work saved first", async () => {
    const { workspace, paths } = await service();
    const repo = paths.defaultWorkspaceDir;
    const task = await workspace.createTaskWorktree("left3333", undefined, undefined, undefined, {
      stem: "inf/draft-notes",
      savedByAnother: () => false,
    });
    expect(task.branch).toBe("inf/draft-notes-left");
    writeFileSync(join(task.cwd, "draft.txt"), "draft\n");
    await git(task.cwd, ["add", "-A"]);
    await git(task.cwd, ["commit", "-m", "feat: draft"]);
    await git(repo, ["worktree", "remove", "--force", task.cwd]);
    expect(await workspace.listTaskBranches(repo)).toEqual([
      { branch: "inf/draft-notes-left", taskId: "left3333" },
    ]);

    expect(await workspace.retireTaskBranch(repo, task.branch, "left3333")).toEqual({
      outcome: "removed",
    });
    expect(await workspace.listTaskBranches(repo)).toEqual([]);
    expect(await git(repo, ["show", `${keptRefFor("left3333")}:draft.txt`])).toBe("draft");
  });

  it("keeps a branch still checked out in a working copy and says why", async () => {
    const { workspace, paths } = await service();
    const repo = paths.defaultWorkspaceDir;
    const task = await workspace.createTaskWorktree("left2222");

    const outcome = await workspace.retireTaskBranch(repo, task.branch, "left2222");
    expect(outcome.outcome).toBe("kept");
    expect(await workspace.branchHead(repo, task.branch)).not.toBeNull();
  });
});

describe("refreshManagedCheckout", () => {
  it("fast-forwards a clean default checkout from origin", async () => {
    const { workspace } = await service();
    const remoteDir = scratchDir("infinitary-refresh-remote-");
    const remote = join(remoteDir, "remote.git");
    await git(remoteDir, ["init", "--bare", remote]);
    const local = await workspace.ensureDefaultRepo();
    await git(local, ["remote", "add", "origin", remote]);
    await git(local, ["push", "-u", "origin", "main"]);
    await git(local, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    await git(local, [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "remote change",
    ]);
    await git(local, ["push", "origin", "main"]);
    await git(local, ["reset", "--hard", "HEAD~1"]);
    expect(await workspace.refreshManagedCheckout(local)).toEqual({ refreshed: true });
    expect(await git(local, ["rev-parse", "HEAD"])).toBe(
      await git(local, ["rev-parse", "refs/remotes/origin/main"]),
    );
  });

  it("leaves a dirty default checkout untouched", async () => {
    const { workspace } = await service();
    const local = await workspace.ensureDefaultRepo();
    await git(local, ["remote", "add", "origin", "unused"]);
    writeFileSync(join(local, "dirty.txt"), "keep\n");
    expect(await workspace.refreshManagedCheckout(local)).toMatchObject({ refreshed: false });
    expect(await git(local, ["status", "--porcelain"])).toContain("dirty.txt");
  });

  /**
   * INF-549, the captain's words: "when a project folder couldn't be brought
   * up to date ... this needs to be corrected durably". The refusal names
   * which state stopped it, so the task the host files can say so.
   */
  describe("names why a folder was not brought up to date", () => {
    async function behindOrigin() {
      const { workspace } = await service();
      const remote = join(scratchDir("infinitary-refresh-remote-"), "remote.git");
      await git(dirname(remote), ["init", "--bare", remote]);
      const local = await workspace.ensureDefaultRepo();
      await git(local, ["remote", "add", "origin", remote]);
      await git(local, ["push", "-u", "origin", "main"]);
      await git(local, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
      const commit = (message: string) =>
        git(local, [
          "-c",
          "user.name=test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--allow-empty",
          "-m",
          message,
        ]);
      await commit("feat: the merged change");
      await git(local, ["push", "origin", "main"]);
      const merged = await git(local, ["rev-parse", "HEAD"]);
      await git(local, ["reset", "--hard", "HEAD~1"]);
      return { workspace, local, merged, commit };
    }

    it("edits of its own", async () => {
      const { workspace, local, merged } = await behindOrigin();
      writeFileSync(join(local, "draft.txt"), "the captain's draft\n");
      expect(await workspace.refreshManagedCheckout(local)).toEqual({
        refreshed: false,
        cause: "dirty",
        branch: "main",
        remote: merged,
      });
      expect(await git(local, ["status", "--porcelain"])).toContain("draft.txt");
    });

    it("another branch, and no branch", async () => {
      const { workspace, local } = await behindOrigin();
      await git(local, ["checkout", "-b", "spike"]);
      expect(await workspace.refreshManagedCheckout(local)).toMatchObject({
        cause: "other-branch",
        branch: "main",
      });
      await git(local, ["checkout", "--detach"]);
      expect(await workspace.refreshManagedCheckout(local)).toMatchObject({ cause: "detached" });
    });

    it("commits that are not where the project lives", async () => {
      const { workspace, local, merged, commit } = await behindOrigin();
      await commit("chore: only in the folder");
      expect(await workspace.refreshManagedCheckout(local)).toEqual({
        refreshed: false,
        cause: "diverged",
        branch: "main",
        remote: merged,
      });
    });

    it("never removes the folder a task worked in place in", async () => {
      // A folder repair starts in the project's own folder (INF-549); a
      // failed start hands that folder back as its "worktree".
      const { workspace, local } = await behindOrigin();
      writeFileSync(join(local, "draft.txt"), "the captain's draft\n");
      await workspace.removeTaskWorktree({
        taskId: "fold1111",
        cwd: local,
        branch: "",
        repoDir: local,
      });
      expect(readFileSync(join(local, "draft.txt"), "utf8")).toBe("the captain's draft\n");
      expect(await git(local, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    });

    it("reads the folder current only when clean, on the branch and at or past the merged version", async () => {
      const { workspace, local, merged } = await behindOrigin();
      expect(await workspace.folderCurrent(local, "main", merged)).toBe(false);
      await git(local, ["merge", "--ff-only", merged]);
      writeFileSync(join(local, "draft.txt"), "the captain's draft\n");
      expect(await workspace.folderCurrent(local, "main", merged)).toBe(false);
      rmSync(join(local, "draft.txt"));
      expect(await workspace.folderCurrent(local, "main", merged)).toBe(true);
      // With no merged version known, origin's branch as last fetched stands in.
      expect(await workspace.folderCurrent(local, "main")).toBe(true);
      await git(local, ["checkout", "-b", "spike"]);
      expect(await workspace.folderCurrent(local, "main", merged)).toBe(false);
    });

    /**
     * INF-572, the captain's approved plan: a merge's update on a folder
     * that is not there says "it is missing", and one git cannot read says
     * so, never that it does not know where the project lives.
     */
    it("a folder that is gone, and one git cannot read", async () => {
      const { workspace, local } = await behindOrigin();
      rmSync(join(local, ".git"), { recursive: true, force: true });
      expect(await workspace.refreshManagedCheckout(local)).toEqual({
        refreshed: false,
        cause: "unreadable",
      });
      rmSync(local, { recursive: true, force: true });
      expect(await workspace.refreshManagedCheckout(local)).toEqual({
        refreshed: false,
        cause: "missing",
      });
      expect(await workspace.folderDefaultBranch(local)).toBe("");
    });
  });

  /**
   * INF-572, the captain's answers for the check at each app start: a clean
   * folder behind on its default branch is brought up to date as after a
   * merge; one with edits or its own commits is refused for its repair; a
   * folder on another branch or on none is left alone; a missing folder is
   * left for the work that next needs it.
   */
  describe("reads a folder once at app start", () => {
    async function behind() {
      const { workspace } = await service();
      const remote = join(scratchDir("infinitary-start-remote-"), "remote.git");
      // Named, so a clone checks out main whatever git's own default is.
      await git(dirname(remote), ["init", "--bare", "--initial-branch=main", remote]);
      const local = await workspace.ensureDefaultRepo();
      await git(local, ["remote", "add", "origin", remote]);
      await git(local, ["push", "-u", "origin", "main"]);
      await git(local, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
      const clone = join(scratchDir("infinitary-start-clone-"), "clone");
      await git(dirname(clone), ["clone", remote, clone]);
      const commit = (dir: string, message: string) =>
        git(dir, [
          "-c",
          "user.name=test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--allow-empty",
          "-m",
          message,
        ]);
      // Merged on the project's host, so the folder never saw it.
      await commit(clone, "feat: merged on the website (#3)");
      await git(clone, ["push", "origin", "main"]);
      const merged = await git(clone, ["rev-parse", "HEAD"]);
      const before = await git(local, ["rev-parse", "HEAD"]);
      return { workspace, local, merged, before, commit };
    }

    it("brings a clean folder on its default branch up to date, then finds it current", async () => {
      const { workspace, local, merged, before } = await behind();
      expect(await workspace.refreshAtStart(local)).toEqual({
        outcome: "refreshed",
        branch: "main",
        from: before,
        to: merged,
      });
      expect(await git(local, ["rev-parse", "HEAD"])).toBe(merged);
      expect(await workspace.refreshAtStart(local)).toEqual({ outcome: "current" });
    });

    it("refuses one with edits or its own commits, and leaves it as it is", async () => {
      const { workspace, local, merged, before, commit } = await behind();
      writeFileSync(join(local, "draft.txt"), "the captain's draft\n");
      expect(await workspace.refreshAtStart(local)).toEqual({
        outcome: "refused",
        refusal: { refreshed: false, cause: "dirty", branch: "main", remote: merged },
      });
      expect(await git(local, ["rev-parse", "HEAD"])).toBe(before);
      rmSync(join(local, "draft.txt"));
      await commit(local, "chore: only in the folder");
      expect(await workspace.refreshAtStart(local)).toMatchObject({
        outcome: "refused",
        refusal: { cause: "diverged", remote: merged },
      });
    });

    it("leaves a folder on another branch or on none, and a missing one", async () => {
      const { workspace, local, before } = await behind();
      await git(local, ["checkout", "-b", "spike"]);
      expect(await workspace.refreshAtStart(local)).toEqual({ outcome: "elsewhere" });
      await git(local, ["checkout", "--detach"]);
      expect(await workspace.refreshAtStart(local)).toEqual({ outcome: "elsewhere" });
      expect(await git(local, ["rev-parse", "HEAD"])).toBe(before);
      rmSync(local, { recursive: true, force: true });
      expect(await workspace.refreshAtStart(local)).toEqual({ outcome: "missing" });
    });

    it("changes nothing when where the project lives cannot be read", async () => {
      const { workspace, local, before } = await behind();
      await git(local, ["remote", "set-url", "origin", join(local, "nowhere.git")]);
      expect(await workspace.refreshAtStart(local)).toEqual({ outcome: "unread" });
      expect(await git(local, ["rev-parse", "HEAD"])).toBe(before);
    });
  });
});

describe("landTaskWork (Q5, forge-agnostic local landing)", () => {
  it("fast-forwards a clean branch and reports the mode", async () => {
    const { workspace } = await service();
    const task = await workspace.createTaskWorktree("land1111");
    writeFileSync(join(task.cwd, "feature.txt"), "done\n");
    await git(task.cwd, ["add", "-A"]);
    await git(task.cwd, ["commit", "-m", "feat: land me"]);

    const result = await workspace.landTaskWork(task);
    expect(result.mode).toBe("fast-forward");
    expect(await git(task.repoDir, ["log", "--oneline", "-1"])).toContain("feat: land me");

    await workspace.removeTaskWorktree(task);
    expect(existsSync(task.cwd)).toBe(false);
  });

  it.each([false, true])(
    "rechecks live permission before the %s fallback merge without moving main",
    async (fallback) => {
      const { workspace } = await service();
      const task = await workspace.createTaskWorktree(fallback ? "live2222" : "live1111");
      await git(task.cwd, ["commit", "--allow-empty", "-m", "feat: branch work"]);
      if (fallback)
        await git(task.repoDir, ["commit", "--allow-empty", "-m", "chore: main advanced"]);
      const before = await git(task.repoDir, ["rev-parse", "HEAD"]);
      let calls = 0;
      const guard = () => {
        calls++;
        return fallback && calls === 1 ? undefined : "The task now asks before merging";
      };
      await expect(workspace.landTaskWork(task, guard)).rejects.toThrow("asks before merging");
      expect(calls).toBe(fallback ? 2 : 1);
      expect(await git(task.repoDir, ["rev-parse", "HEAD"])).toBe(before);
      expect(await git(task.repoDir, ["status", "--porcelain"])).toBe("");
    },
  );

  it("refuses a plain incoming save point without moving the checked-out project", async () => {
    const { workspace } = await service();
    const task = await workspace.createTaskWorktree("plain123");
    await git(task.cwd, ["commit", "--allow-empty", "-m", "Plain save point"]);
    const before = await git(task.repoDir, ["rev-parse", "HEAD"]);
    await expect(workspace.landTaskWork(task)).rejects.toThrow(
      /does not follow the naming runbook/,
    );
    expect(await git(task.repoDir, ["rev-parse", "HEAD"])).toBe(before);
  });

  it("falls back to a merge commit when main moved on", async () => {
    const { workspace } = await service();
    const task = await workspace.createTaskWorktree("land2222");
    writeFileSync(join(task.cwd, "feature.txt"), "done\n");
    await git(task.cwd, ["add", "-A"]);
    await git(task.cwd, ["commit", "-m", "feat: branch work"]);
    writeFileSync(join(task.repoDir, "elsewhere.txt"), "moved\n");
    await git(task.repoDir, ["add", "-A"]);
    await git(task.repoDir, ["commit", "-m", "chore: mainline moved"]);

    const result = await workspace.landTaskWork(task);
    expect(result.mode).toBe("merge");
    const log = await git(task.repoDir, ["log", "--oneline", "-3"]);
    expect(log).toContain("chore: integrate task work");
    expect(log).toContain("feat: branch work");
    expect(log).toContain("chore: mainline moved");
  });

  it("refuses a conflict and leaves the repo exactly as found", async () => {
    const { workspace } = await service();
    const task = await workspace.createTaskWorktree("land3333");
    writeFileSync(join(task.cwd, "README.md"), "branch version\n");
    await git(task.cwd, ["add", "-A"]);
    await git(task.cwd, ["commit", "-m", "feat: branch readme"]);
    writeFileSync(join(task.repoDir, "README.md"), "main version\n");
    await git(task.repoDir, ["add", "-A"]);
    await git(task.repoDir, ["commit", "-m", "chore: main readme"]);
    const headBefore = await git(task.repoDir, ["rev-parse", "HEAD"]);

    await expect(workspace.landTaskWork(task)).rejects.toThrow(/conflict/);
    expect(await git(task.repoDir, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(await git(task.repoDir, ["status", "--porcelain"])).toBe("");
  });

  it("refuses a dirty repository before touching anything", async () => {
    const { workspace } = await service();
    const task = await workspace.createTaskWorktree("land4444");
    writeFileSync(join(task.repoDir, "wip.txt"), "uncommitted\n");
    await expect(workspace.landTaskWork(task)).rejects.toThrow(/uncommitted changes/);
  });
});
