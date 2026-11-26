import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { contributionOriginMatches } from "@shared/contributions";
import { HERE } from "@shared/deviceNames";
import type { FolderRefreshCause, FolderRefreshRefusal } from "@shared/folderRefresh";
import type { KnownForgeHost } from "@shared/forge";
import { forgeOf } from "@shared/forge";
import { cutText } from "@shared/textCut";
import type { NamingRule } from "../../shared/runbooks";
import { hostEnv } from "../hostEnv";
import type { AppPaths } from "../paths";
import { atUtilityQos } from "../utilityQos";
import { forgeAuthRequired } from "./forgeAuth";
import {
  APP_GIT_IDENTITY,
  git,
  gitFailure,
  inheritWorktreeRemotes,
  isGitRepo,
  REMOTE_TIMEOUT_MS,
  releaseTaskRemote,
  taskRemoteName,
} from "./git";
import { type InstallFailure, runInstall } from "./installProcess";
import { composedName, requireNamedRange } from "./naming";
import {
  defaultTaskBranch,
  markedTaskBranch,
  markTaskBranch,
  nameTaskBranch,
  type TaskBranchStem,
  taskBranches,
  taskOfBranch,
} from "./taskBranches";
import { WorktreePool, type WorktreePoolOptions } from "./worktreePool";

const execFileAsync = promisify(execFile);

/**
 * The work substrate (decision D-8): crewmates operate on git repos,
 * worktree per task. Repo-less tasks land in the app-managed default
 * local-only repo (git init on first use), so every crewmate has a real,
 * versioned cwd. Phase 3 adds the user-registered repo registry on top.
 */

export type TaskWorkspace = {
  taskId: string;
  cwd: string;
  branch: string;
  repoDir: string;
  /** How a dispatch got this tree; absent on a tree that was already there. */
  acquired?: WorktreeAcquisition;
};

/**
 * The commit a task's branch starts at (captain's board answer, 2026-09-23:
 * "fetch the default branch at dispatch"): the repository's default branch,
 * refreshed from `origin` first. `fetch` says whether that refresh ran and
 * worked; a failed one never fails the dispatch - the task starts from what
 * this machine last saw. A repository without `origin` starts from its own
 * checked-out commit, as before.
 */
/** What a change adds and deletes in text lines, against the merge base it was read from. */
export type ChangeLineCount = { base: string; added: number; deleted: number };

export type DispatchBase = {
  sha: string;
  /** What the commit was read from: `origin/main`, `main`, or `HEAD`. */
  ref: string;
  fetch: "fetched" | "failed" | "none";
  fetchError?: string;
};

/** A warm tree from the pool, or a new one; with the base and the time it took. */
export type WorktreeAcquisition = {
  source: "pool" | "new";
  base: DispatchBase;
  ms: number;
};

/**
 * How a commissioned worktree got its dependencies (interaction P0, WI-7):
 * from the shared pnpm store alone, from the network after the offline
 * attempt missed, not at all because the repo has no pnpm lockfile, or a
 * failure the crewmate can still recover from itself.
 */
export type DependencyInstall =
  | { outcome: "skipped" }
  | { outcome: "offline" | "online"; ms: number }
  | { outcome: "failed"; ms: number; error: string };

/**
 * The folders a workspace keeps working copies in: the app's own here, and
 * a computer that runs work's own there (`../helper/workingCopies.ts`).
 */
export type WorkspacePaths = Pick<
  AppPaths,
  "worktreesDir" | "worktreeTrashDir" | "worktreePoolDir" | "defaultWorkspaceDir"
>;

export type WorkspaceServiceOptions = {
  /** The active naming runbook's rule, read at each use; absent or null, no naming runbook is on. */
  namingRule?: () => NamingRule | null;
  /** The pnpm executable; tests point it at a stub. */
  pnpm?: string;
  /** Bound on one install attempt. */
  installTimeoutMs?: number;
  /** Deletes a retired tree in the background; tests hold it to observe the order. */
  deleteTree?: (dir: string) => Promise<void>;
  /** The warm worktree pool's limits; false turns pooling off (every tree is new and deleted). */
  pool?: WorktreePoolOptions | false;
  /** Bound on the dispatch-time fetch of the default branch. */
  fetchTimeoutMs?: number;
  /**
   * The hosts on the person's own server the app signs in to (a GitHub
   * Enterprise host): a fetch refused there waits for that host's sign-in,
   * as one refused by github.com does.
   */
  knownHosts?: () => readonly KnownForgeHost[];
};

/** A fetch overtaken by another fetch of the same ref runs again, this many times in all. */
const FETCH_ATTEMPTS = 3;

/** A cold online install of a large monorepo fits comfortably; a hang does not. */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

export { TASK_BRANCH_PREFIX } from "./taskBranches";

/**
 * Where a computer that runs work keeps the home's default workspace in its
 * own (docs/helper.md, "Its working copies"): the commit a task with no
 * project there starts from.
 */
export const SEEDED_REF = "refs/infinitary/home-main";
/** Where Firstmate 3000 kept it, read beside `SEEDED_REF` (the Infinitary rename). */
export const OLDER_SEEDED_REF = "refs/fm3000/home-main";

/**
 * Where a closed task's unlanded work is kept once its worktree and branch
 * are gone: a ref outside `refs/heads`, `refs/tags` and `refs/remotes`, so
 * no branch listing, no branch picker and no push of branches or tags ever
 * shows it. `git log refs/infinitary/kept/<id>` reads it back; nothing
 * expires it yet.
 */
export const KEPT_REF_PREFIX = "refs/infinitary/kept/";
/**
 * Where Firstmate 3000 kept that work before the Infinitary rename: still
 * read, so work kept before an update is found after it, here and on a
 * computer that runs work.
 */
export const OLDER_KEPT_REF_PREFIX = "refs/fm3000/kept/";

export function keptRefFor(taskId: string): string {
  return `${KEPT_REF_PREFIX}${taskId}`;
}

/**
 * Where the home keeps the other branch a placed task's crewmate checked
 * out on the computer that runs it, to deliver it (INF-2490): one ref of
 * the task's own, so a branch of the same name here is never moved.
 */
export function checkedOutRefFor(taskId: string): string {
  return `refs/infinitary/checked-out/${taskId}`;
}

/**
 * Where the home keeps what a task's copy left on a computer it moved off
 * while that computer was out of reach held that never merged, once that
 * computer is back (docs/helper.md, "Moving a task off a computer that is
 * out of reach"): one ref per move, so the task's own kept ref is never
 * written over.
 */
export function awayCopyRefFor(taskId: string, movedAt: number): string {
  return `refs/infinitary/away-copy/${taskId}/${movedAt}`;
}

/** Every name a task's kept work may be under, Infinitary's first. */
export function keptRefsFor(taskId: string): string[] {
  return [keptRefFor(taskId), `${OLDER_KEPT_REF_PREFIX}${taskId}`];
}

/**
 * The private ref a destination computer fetches a task's starting work
 * into (docs/helper.md, "Starting from a source task"): Infinitary's name
 * for a computer that takes it (`speaksInfinitaryNames`), Firstmate 3000's
 * for an older one, which takes no other.
 */
export function sourceRefFor(taskId: string, sourceId: string, infinitary: boolean): string {
  return `refs/${infinitary ? "infinitary" : "fm3000"}/sources/${taskId}-${sourceId}`;
}

/** The refs a destination computer may keep a task's starting work under, in either name. */
export function sourceRefPatterns(taskId: string): string[] {
  return [`refs/infinitary/sources/${taskId}-*`, `refs/fm3000/sources/${taskId}-*`];
}

/** The one commit a retired worktree's unlanded work was saved as. */
export type KeptWork = {
  ref: string;
  sha: string;
  dirty: boolean;
  unlandedCommits: number;
};

/** What a save held, in the timeline's words: "its 2 commits not in yet and uncommitted edits". */
export function keptWorkWords(kept: KeptWork): string {
  const commits =
    kept.unlandedCommits > 0
      ? `${kept.unlandedCommits} ${kept.unlandedCommits === 1 ? "commit" : "commits"} not in yet`
      : "";
  const edits = kept.dirty ? "uncommitted edits" : "";
  const held = [commits, edits].filter(Boolean).join(" and ");
  return held ? `its ${held}` : "its work";
}

/**
 * A retired worktree: removed, with the work it held saved first when any
 * never landed - or, the one exception, left in place because that save
 * failed and removing it would have thrown the work away.
 */
export type WorktreeRetirement =
  | { outcome: "removed"; kept: KeptWork | null }
  | { outcome: "kept"; reason: string };

/**
 * Where a repair works while its project's folder is missing (INF-572): the
 * folder that held it, or the nearest folder above that which exists.
 */
export function nearestFolderAbove(path: string): string {
  let dir = dirname(resolve(path));
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}

/** True when `path` is `folder` itself or anywhere beneath it. */
function holds(folder: string, path: string): boolean {
  const rel = relative(resolve(folder), resolve(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** What the check at each app start found in a project's folder (`refreshAtStart`). */
export type FolderStartReading =
  | { outcome: "missing" | "unread" | "elsewhere" | "current" }
  | { outcome: "refreshed"; branch: string; from: string; to: string }
  | { outcome: "refused"; refusal: FolderRefreshRefusal };

export class WorkspaceService {
  /** Retired trees still being deleted in the background. */
  private readonly deletions = new Set<Promise<void>>();
  /** Warm trees between tasks; null when pooling is off. */
  private readonly pool: WorktreePool | null;
  /** Serialize refreshes targeting the same main checkout. */
  private readonly refreshQueues = new Map<string, Promise<unknown>>();
  /** One fetch from `origin` at a time per repository (`fetchDefaultBranch`). */
  private readonly fetchQueues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly paths: WorkspacePaths,
    private readonly options: WorkspaceServiceOptions = {},
  ) {
    this.pool =
      options.pool === false
        ? null
        : new WorktreePool(paths.worktreePoolDir, (dir) => this.discardDir(dir), options.pool);
  }

  /** The active naming runbook's rule, which names and checks every commit here. */
  private naming(): NamingRule | null {
    return this.options.namingRule?.() ?? null;
  }

  /**
   * Install a fresh worktree's dependencies before the crewmate's first turn,
   * so the worktree can build without the crewmate spending a turn on it.
   * pnpm's content-addressed store is shared across every worktree on the
   * machine, so `--offline` usually links everything with no network; only
   * when the store is missing a package does the online attempt run. The
   * lockfile is frozen either way - installing never rewrites the branch.
   * Never throws: a failed install is an outcome the caller records.
   */
  async installDependencies(cwd: string): Promise<DependencyInstall> {
    if (!existsSync(join(cwd, "pnpm-lock.yaml"))) return { outcome: "skipped" };
    const started = Date.now();
    const base = ["install", "--frozen-lockfile"];
    try {
      await this.pnpm(cwd, [...base, "--offline"]);
      return { outcome: "offline", ms: Date.now() - started };
    } catch (caught) {
      // The shared store lacks something: fetch it - unless the first run's
      // programs were not confirmed ended, which a second run would write beside.
      if ((caught as InstallFailure).stillRunning) {
        return { outcome: "failed", ms: Date.now() - started, error: installError(caught) };
      }
    }
    try {
      await this.pnpm(cwd, base);
      return { outcome: "online", ms: Date.now() - started };
    } catch (caught) {
      return { outcome: "failed", ms: Date.now() - started, error: installError(caught) };
    }
  }

  private async pnpm(cwd: string, args: string[]): Promise<void> {
    // An install links thousands of files and may build native modules:
    // below the UI, with everything it starts (../utilityQos.ts).
    const command = atUtilityQos(this.options.pnpm ?? "pnpm", args);
    await runInstall(command.file, command.args, {
      cwd,
      timeoutMs: this.options.installTimeoutMs ?? INSTALL_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: hostEnv({ CI: "true" }),
    });
  }

  /**
   * Every task branch in a repo, with the task it belongs to: each branch
   * marked as a task's, and each `fm/task-<id>` (`taskBranches.ts`).
   * Read-only: boot reconciliation retires each leftover with
   * `retireTaskBranch`.
   */
  async listTaskBranches(repoDir: string): Promise<{ branch: string; taskId: string }[]> {
    return taskBranches(repoDir);
  }

  /**
   * A leftover task branch with no working copy goes the way a closed
   * task's does: whatever it holds that never landed is first saved on the
   * task's hidden kept ref (`keepUnlandedWork`), then the branch is deleted.
   * Answers why it stayed when the save or the delete failed - a branch
   * still checked out somewhere is refused by git and stays.
   */
  async retireTaskBranch(
    repoDir: string,
    branch: string,
    taskId: string,
  ): Promise<{ outcome: "removed" } | { outcome: "kept"; reason: string }> {
    try {
      await this.keepUnlandedWork({ cwd: "", repoDir, branch, taskId });
      await git(repoDir, ["branch", "-D", branch]);
      return { outcome: "removed" };
    } catch (caught) {
      return { outcome: "kept", reason: gitFailure(caught) };
    }
  }

  /**
   * The commit a task's branch stands at, or null when the branch is gone.
   * Host bookkeeping, not a gate: the reviewer's brief names the head an
   * independent reviewer reads (a review reads the builder's branch, which
   * may have no pull request yet), and a re-review counts a round only when
   * this moved.
   */
  async branchHead(repoDir: string, branch: string): Promise<string | null> {
    try {
      const sha = await git(repoDir, ["rev-parse", "--verify", "--quiet", `${branch}^{commit}`]);
      return sha || null;
    } catch {
      return null;
    }
  }

  /**
   * Complete committed-file checklist for a review at a named head. Use the
   * merge base of the default branch, as the reviewer's own diff does. Never
   * fetch here: a review must describe the head the host actually named.
   */
  async reviewChangedFiles(
    repoDir: string,
    headSha: string,
    /** The approved version a part started on (`shape.built_on`): its own difference is read from there. */
    builtOn?: string,
    /** The default branch read in place of `origin`'s (`routedReviewBase`). */
    defaultBranch?: string,
  ): Promise<string[] | null> {
    // A named commit that is not in this checkout has no local checklist.
    // The reviewer reports that gap; it does not substitute another head.
    if (!(await resolveCommit(repoDir, headSha))) return null;
    const base =
      (await this.builtOnAt(repoDir, builtOn, headSha, defaultBranch)) ??
      (await reviewDiffBase(repoDir, defaultBranch));
    const out = await git(
      repoDir,
      ["diff", "--ignore-submodules=none", "--name-only", "-z", `${base}...${headSha}`],
      { trim: false },
    );
    return out.split("\0").filter(Boolean);
  }

  /**
   * The approved version a part started on, while this checkout holds it,
   * the head read still builds on it and has taken in nothing newer from
   * the default branch, whether or not that earlier part merged since: a
   * squash merge never puts the approved version on the default branch.
   * Else undefined, and the change reads from the default branch as any
   * other does.
   */
  async builtOnAt(
    repoDir: string,
    builtOn: string | undefined,
    headSha: string,
    /** As `reviewChangedFiles`'s. */
    defaultBranch?: string,
  ): Promise<string | undefined> {
    if (!builtOn) return undefined;
    const sha = await resolveCommit(repoDir, builtOn);
    if (!sha || !(await isAncestor(repoDir, sha, headSha))) return undefined;
    const fork = await git(repoDir, [
      "merge-base",
      await reviewDiffBase(repoDir, defaultBranch),
      headSha,
    ]).catch(() => null);
    return fork && (await isAncestor(repoDir, fork, sha)) ? sha : undefined;
  }

  /**
   * The change's own lines at a commit, as a sha256.
   * Same base as `reviewChangedFiles`. Null when the commit is not here.
   * A pure update onto newer main keeps the reading; an edited line,
   * dropped line, added change or spacing change does not (INF-148).
   */
  async reviewChangeReading(
    repoDir: string,
    headSha: string,
    /** As `reviewChangedFiles`'s. */
    defaultBranch?: string,
  ): Promise<string | null> {
    return readChangeReading(repoDir, headSha, defaultBranch);
  }

  /**
   * The lines the whole offered change adds and deletes (INF-820): every
   * commit from where the commit leaves the default branch to the commit,
   * as `reviewChangedFiles` compares them, with renames found so a moved
   * file counts only its edited lines. A binary file adds no text lines.
   * `base` is the merge base the counts were read against. Null when the
   * commit or its base cannot be read here, never a zero.
   */
  async changeLines(
    repoDir: string,
    headSha: string,
    /** As `reviewChangedFiles`'s: a part's own lines are counted from the approved version it started on. */
    builtOn?: string,
    /** As `reviewChangedFiles`'s. */
    defaultBranch?: string,
  ): Promise<ChangeLineCount | null> {
    if (!(await resolveCommit(repoDir, headSha))) return null;
    try {
      const base = await git(repoDir, [
        "merge-base",
        (await this.builtOnAt(repoDir, builtOn, headSha, defaultBranch)) ??
          (await reviewDiffBase(repoDir, defaultBranch)),
        headSha,
      ]);
      const out = await git(repoDir, [
        "diff",
        "--numstat",
        "-M",
        "--ignore-submodules=none",
        "--no-ext-diff",
        "--no-textconv",
        base,
        headSha,
      ]);
      let added = 0;
      let deleted = 0;
      for (const line of out.split("\n")) {
        // `-` in both columns is a binary file: no text lines.
        const [plus, minus] = line.split("\t");
        if (plus && /^\d+$/.test(plus)) added += Number(plus);
        if (minus && /^\d+$/.test(minus)) deleted += Number(minus);
      }
      return { base, added, deleted };
    } catch {
      return null;
    }
  }

  /**
   * The default branch a review of a task's branch is measured from when
   * the branch's own remote names another project than this clone's
   * `origin`. A task that started before its project moved stays in the
   * clone it started in, whose `origin` still names the former address for
   * every other task there, while the task's own remote follows the
   * approved one (docs/helper.md, "Independent reviews"). That remote's
   * declared default branch is fetched into the remote's own tracking ref,
   * never `origin`'s, and named. Undefined when the branch follows
   * `origin`, whose default branch the review reads as before. A failed
   * read falls back to that remote's default branch as this computer last
   * read it; with none, it throws, rather than measure against the former
   * project.
   */
  async routedReviewBase(repoDir: string, branch: string): Promise<string | undefined> {
    const remote = await git(repoDir, ["config", "--get", `branch.${branch}.remote`]).catch(
      () => "",
    );
    if (!remote || remote === "origin" || remote === ".") return undefined;
    const address = (name: string) =>
      git(repoDir, ["ls-remote", "--get-url", "--", name]).catch(() => "");
    const routed = await address(remote);
    if (!routed || routed === (await address("origin"))) return undefined;
    const head = `refs/remotes/${remote}/HEAD`;
    try {
      const declared = await git(repoDir, ["ls-remote", "--symref", "--", remote, "HEAD"], {
        timeoutMs: this.options.fetchTimeoutMs ?? REMOTE_TIMEOUT_MS,
        env: { GIT_TERMINAL_PROMPT: "0" },
      });
      const name = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(declared)?.[1];
      if (!name) throw new Error("The project's approved address declares no default branch.");
      await this.fetchDefaultBranch(repoDir, name, remote);
      await git(repoDir, ["symbolic-ref", head, `refs/remotes/${remote}/${name}`]);
      return `refs/remotes/${remote}/${name}`;
    } catch (caught) {
      const kept = await git(repoDir, ["symbolic-ref", "--quiet", head]).catch(() => "");
      if (kept && (await resolveCommit(repoDir, kept))) return kept;
      throw (
        forgeAuthRequired(routed, caught, this.options.knownHosts?.() ?? []) ??
        new Error(
          `The default branch at the project's approved address could not be read, so the review has nothing to measure from: ${gitFailure(caught)}`,
        )
      );
    }
  }

  /**
   * Lazily creates the default local-only repo with an initial commit. Two
   * starts at once (a start runs behind the first mate's answer, INF-3060)
   * share one creation, so neither finds the other's half-made repository.
   */
  ensureDefaultRepo(): Promise<string> {
    if (this.creatingDefaultRepo) return this.creatingDefaultRepo;
    const dir = this.paths.defaultWorkspaceDir;
    if (this.defaultRepoReady && existsSync(join(dir, ".git"))) return Promise.resolve(dir);
    const creating = this.createDefaultRepo(dir)
      .then((made) => {
        this.defaultRepoReady = true;
        return made;
      })
      .finally(() => {
        if (this.creatingDefaultRepo === creating) this.creatingDefaultRepo = undefined;
      });
    this.creatingDefaultRepo = creating;
    return creating;
  }

  private creatingDefaultRepo: Promise<string> | undefined;
  /** Set once this run has seen the default repository's first commit. */
  private defaultRepoReady = false;

  /**
   * Makes the default repository, or finishes one an earlier launch stopped
   * before its first commit (INF-3307): a `.git` with no commit has nothing a
   * task's branch can start from. Each step is safe to run again.
   */
  private async createDefaultRepo(dir: string): Promise<string> {
    if (existsSync(join(dir, ".git"))) {
      try {
        await git(dir, ["rev-parse", "--verify", "HEAD^{commit}"]);
        return dir;
      } catch {
        // No first commit yet: finish making it below.
      }
    }
    await mkdir(dir, { recursive: true });
    await git(dir, ["init", "--initial-branch=main"]);
    await git(dir, ["config", "user.name", "Infinitary"]);
    await git(dir, ["config", "user.email", "infinitary@localhost"]);
    await writeFile(
      join(dir, "README.md"),
      "# Infinitary workspace\n\nThe app-managed default workspace. Tasks not tied to a registered repo run here, one git worktree per task.\n",
    );
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", composedName("initialize default workspace", this.naming())]);
    return dir;
  }

  /**
   * A new task's branch name, from `stem` and the task's code, read among
   * the branches of its project or, with none, of the default workspace
   * (`nameTaskBranch`, docs/architecture.md "A task's branch").
   */
  async taskBranchName(
    taskId: string,
    repoDir: string | undefined,
    stem: TaskBranchStem,
  ): Promise<string> {
    const repo = repoDir ?? (await this.ensureDefaultRepo());
    return nameTaskBranch({ taskId, repoDir: repo, ...stem });
  }

  /**
   * Creates the task's worktree on the branch the repository already marks
   * as the task's, else on `named` - the name its record holds, or one made
   * now from a stem (`taskBranchName`), `fm/task-<id>` when none - marked
   * as the task's, starting at the
   * dispatch base (`dispatchBase`). A warm tree from the pool is taken when
   * one is idle for the repository - moved to the task's path and switched
   * to the new branch, its dependency tree intact - and a new one is added
   * otherwise. Idempotent: a retry reuses an existing matching worktree, or
   * checks out an existing branch without `-b`, so a leftover from a failed
   * or overlapping start never fails with "branch already exists". `startAt`
   * can name a seeded dispatch base (`SEEDED_REF`) for projectless work,
   * or an exact review commit. An existing review copy moves only from its
   * previous assigned base, never over other commits or edits.
   */
  async createTaskWorktree(
    taskId: string,
    repoDir?: string,
    startAt?: DispatchBase | { headSha: string; previousHead?: string },
    remote?: { origin: string; pushOrigin?: string },
    named?: string | TaskBranchStem,
  ): Promise<TaskWorkspace> {
    const started = Date.now();
    const at = startAt && "headSha" in startAt ? startAt : undefined;
    const repo = repoDir ?? (await this.ensureDefaultRepo());
    const cwd = join(this.paths.worktreesDir, taskId);
    // A branch the repository already marks as the task's is its name,
    // whatever this attempt sends: a computer that runs work, asked again
    // after a lost answer or a changed title, answers the copy it made.
    const branch =
      (await markedTaskBranch(repo, taskId)) ??
      (typeof named === "object"
        ? await nameTaskBranch({ taskId, repoDir: repo, ...named })
        : named || defaultTaskBranch(taskId));
    await mkdir(this.paths.worktreesDir, { recursive: true });
    await git(repo, ["worktree", "prune"]);
    if (at && (await resolveCommit(repo, at.headSha)) !== at.headSha)
      throw new Error(`The assigned commit ${at.headSha} is not in this repository.`);
    if (await isMatchingWorktree(cwd, branch)) {
      if (at) {
        const head = await this.branchHead(repo, branch);
        if (await git(cwd, ["status", "--porcelain"]))
          throw new Error("The working copy has edits; nothing was replaced.");
        if (head !== at.headSha) {
          if (!at.previousHead || head !== at.previousHead)
            throw new Error("The working copy has other commits; nothing was replaced.");
          // Only an idle copy still at its assigned base may move. --keep
          // also refuses an edit that raced the clean check above.
          await git(cwd, ["reset", "--keep", at.headSha]);
        }
      }
      if (remote) await inheritWorktreeRemotes(repo, cwd, remote);
      await markTaskBranch(repo, branch, taskId);
      return { taskId, cwd, branch, repoDir: repo };
    }
    if (existsSync(cwd)) {
      if (at || (await isGitRepo(cwd))) {
        throw new Error(`Worktree path ${cwd} exists but is not on ${branch}; refuse to reuse it.`);
      }
      await rm(cwd, { recursive: true, force: true });
    }
    const existing = await branchExists(repo, branch);
    const existingHead = existing ? await this.branchHead(repo, branch) : null;
    if (at && existing && existingHead !== at.headSha)
      throw new Error("The task's branch holds another commit; nothing was replaced.");
    if (remote) await inheritWorktreeRemotes(repo, repo, remote, branch);
    try {
      const base: DispatchBase = at
        ? { sha: at.headSha, ref: at.headSha, fetch: "none" }
        : existing
          ? { sha: existingHead ?? "", ref: branch, fetch: "none" }
          : startAt && "sha" in startAt
            ? startAt
            : await this.dispatchBase(repo, remote ? taskRemoteName(branch) : "origin");
      const checkout = existing ? [branch] : ["-b", branch, base.sha];
      const add = existing ? [cwd, branch] : ["-b", branch, cwd, base.sha];
      let source: WorktreeAcquisition["source"] = "new";
      if (this.pool && (await this.pool.acquire(repo, cwd))) {
        try {
          await git(cwd, ["checkout", "--quiet", ...checkout]);
          source = "pool";
        } catch (caught) {
          console.warn(`[workspace] a pooled tree could not take ${branch}:`, caught);
          await this.discardDir(cwd);
          await git(repo, ["worktree", "prune"]);
        }
      }
      if (source === "new") await git(repo, ["worktree", "add", ...add]);
      if (remote) await inheritWorktreeRemotes(repo, cwd, remote);
      await markTaskBranch(repo, branch, taskId);
      return {
        taskId,
        cwd,
        branch,
        repoDir: repo,
        acquired: { source, base, ms: Date.now() - started },
      };
    } catch (error) {
      if (remote && !existing) await releaseTaskRemote(repo, branch);
      throw error;
    }
  }

  /**
   * A dispatch base at a named ref of the repository (INF-799 `branch_from`):
   * another task's branch or the kept ref its work was saved on. Throws in
   * words when the ref names no commit here.
   */
  async baseAt(repo: string, ref: string): Promise<DispatchBase> {
    const sha = await resolveCommit(repo, ref);
    if (!sha)
      throw new Error(`${ref} names no commit in this project, so there is nothing to start from.`);
    return { sha, ref, fetch: "none" };
  }

  /**
   * A dispatch base at an earlier part's approved version (docs/task-graph.md,
   * "A part that starts at approval"): the commit when this project already
   * holds it, else fetched from its pushed branch where the project lives.
   * Throws in words when neither has it.
   */
  async approvedBaseAt(
    repo: string,
    head: string,
    branch: string,
    remoteName = "origin",
  ): Promise<DispatchBase> {
    if (!(await resolveCommit(repo, head)))
      await git(repo, ["fetch", "--quiet", "--no-tags", remoteName, `refs/heads/${branch}`], {
        timeoutMs: this.options.fetchTimeoutMs ?? REMOTE_TIMEOUT_MS,
        env: { GIT_TERMINAL_PROMPT: "0" },
      }).catch(() => {});
    if (!(await resolveCommit(repo, head)))
      throw new Error(
        `The approved version ${head} of ${branch} is not in this project and could not be fetched, so there is nothing to start from.`,
      );
    return { sha: head, ref: branch, fetch: "none" };
  }

  /**
   * Where a new task starts (captain's board answer, 2026-09-23: "fetch the
   * default branch at dispatch"). With an `origin`, its default branch is
   * fetched - bounded, never prompting - and the base is whichever of the
   * local branch and `origin/<branch>` is further ahead, `origin` when they
   * diverged (treehouse's rule). A failed fetch falls back to what this
   * machine last saw and says so; it never fails the dispatch. Without an
   * `origin`, the base is the repository's checked-out commit.
   */
  async dispatchBase(repo: string, remoteName = "origin"): Promise<DispatchBase> {
    const remotes = await git(repo, ["remote"]).catch(() => "");
    if (!remotes.split("\n").some((remote) => remote.trim() === remoteName)) {
      return {
        sha: await git(repo, ["rev-parse", "--verify", "HEAD^{commit}"]),
        ref: "HEAD",
        fetch: "none",
      };
    }
    const origin = await git(repo, ["remote", "get-url", remoteName]).catch(() => "");
    const name = await defaultBranchName(repo);
    let fetch: DispatchBase["fetch"] = "fetched";
    let fetchError: string | undefined;
    try {
      await this.fetchDefaultBranch(repo, name, remoteName);
    } catch (caught) {
      const authRequired = forgeAuthRequired(origin, caught, this.options.knownHosts?.() ?? []);
      if (authRequired) throw authRequired;
      fetch = "failed";
      fetchError = gitFailure(caught);
    }
    const local = await resolveCommit(repo, `refs/heads/${name}`);
    const remote = await resolveCommit(repo, `refs/remotes/${remoteName}/${name}`);
    const failure = fetchError ? { fetchError } : {};
    // The local branch wins only when it is strictly ahead of origin's.
    const pushOrigin = await git(repo, ["config", "--get", `remote.${remoteName}.pushurl`]).catch(
      () => "",
    );
    const where = forgeOf(origin, this.options.knownHosts?.() ?? []);
    const samePush =
      !pushOrigin ||
      pushOrigin === origin ||
      Boolean(
        where.host &&
          where.owner &&
          where.name &&
          contributionOriginMatches(
            { origin, fullName: `${where.owner}/${where.name}` },
            pushOrigin,
            where.kind,
          ),
      );
    const localAhead =
      samePush &&
      local !== null &&
      remote !== null &&
      local !== remote &&
      (await isAncestor(repo, remote, local));
    if (remote && !localAhead)
      return { sha: remote, ref: `${remoteName}/${name}`, fetch, ...failure };
    if (local) return { sha: local, ref: name, fetch, ...failure };
    return {
      sha: await git(repo, ["rev-parse", "--verify", "HEAD^{commit}"]),
      ref: "HEAD",
      fetch,
      ...failure,
    };
  }

  /**
   * Best-effort refresh for a registered managed checkout after host merge.
   * Only the clean checked-out default branch may fast-forward from origin;
   * every other state is refused with its typed cause (INF-549).
   */
  async refreshManagedCheckout(
    repoDir: string,
  ): Promise<{ refreshed: true } | FolderRefreshRefusal> {
    const prior = this.refreshQueues.get(repoDir) ?? Promise.resolve();
    const run = prior.catch(() => {}).then(() => this.refreshManagedCheckoutOnce(repoDir));
    this.refreshQueues.set(repoDir, run);
    try {
      return await run;
    } finally {
      if (this.refreshQueues.get(repoDir) === run) this.refreshQueues.delete(repoDir);
    }
  }

  private async refreshManagedCheckoutOnce(
    repoDir: string,
  ): Promise<{ refreshed: true } | FolderRefreshRefusal> {
    // A folder that is gone is missing, and one git cannot read is
    // unreadable: neither says where the project lives (INF-572).
    if (!existsSync(repoDir)) return { refreshed: false, cause: "missing" };
    const remotes = await git(repoDir, ["remote"]).catch(() => null);
    if (remotes === null) return { refreshed: false, cause: "unreadable" };
    if (!remotes.split("\n").includes("origin")) return { refreshed: false, cause: "no-origin" };
    const branch = await this.originDefaultBranch(repoDir);
    if (!branch) return { refreshed: false, cause: "no-default-branch" };
    const fail = (cause: FolderRefreshCause, remote?: string | null): FolderRefreshRefusal => ({
      refreshed: false,
      cause,
      branch,
      ...(remote ? { remote } : {}),
    });
    const check = async (): Promise<{ head: string } | { cause: FolderRefreshCause }> => {
      const current = await git(repoDir, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(
        () => "",
      );
      if (!current) return { cause: "detached" };
      if (current !== branch) return { cause: "other-branch" };
      if (await git(repoDir, ["status", "--porcelain"]).catch(() => "dirty")) {
        return { cause: "dirty" };
      }
      const head = await resolveCommit(repoDir, `refs/heads/${branch}`);
      return head ? { head } : { cause: "unreadable" };
    };
    const tracked = () => resolveCommit(repoDir, `refs/remotes/origin/${branch}`);
    const before = await check();
    if ("cause" in before) return fail(before.cause, await tracked());
    try {
      await this.fetchDefaultBranch(repoDir, branch);
    } catch (caught) {
      console.warn(`[workspace] refreshing ${repoDir}: ${gitFailure(caught)}`);
      return fail("fetch-failed", await tracked());
    }
    const remote = await tracked();
    if (!remote) return fail("no-remote-branch");
    if (!(await isAncestor(repoDir, before.head, remote))) return fail("diverged", remote);
    const current = await check();
    if (!("head" in current) || current.head !== before.head) return fail("changed", remote);
    try {
      await git(repoDir, ["merge", "--ff-only", remote]);
      return { refreshed: true };
    } catch {
      return fail("fast-forward-refused", remote);
    }
  }

  /**
   * The check at each app start (INF-572, the captain's answers): one fetch
   * of the folder's default branch from where the project lives, then the
   * same rule as after a merge - only a clean folder on its default branch
   * moves forward, by fast-forward. A folder on another branch or on none
   * is left alone without a fetch; a folder at or past origin's is left as
   * it is; one that is behind with edits or its own commits is refused
   * with its cause, for its repair. Anything that cannot be read is
   * `unread`, and the next start reads it again.
   */
  async refreshAtStart(repoDir: string): Promise<FolderStartReading> {
    const prior = this.refreshQueues.get(repoDir) ?? Promise.resolve();
    const run = prior.catch(() => {}).then(() => this.refreshAtStartOnce(repoDir));
    this.refreshQueues.set(repoDir, run);
    try {
      return await run;
    } finally {
      if (this.refreshQueues.get(repoDir) === run) this.refreshQueues.delete(repoDir);
    }
  }

  private async refreshAtStartOnce(repoDir: string): Promise<FolderStartReading> {
    if (!existsSync(repoDir)) return { outcome: "missing" };
    const remotes = await git(repoDir, ["remote"]).catch(() => "");
    if (!remotes.split("\n").includes("origin")) return { outcome: "unread" };
    const branch = await this.originDefaultBranch(repoDir);
    if (!branch) return { outcome: "unread" };
    const onBranch = async () =>
      (await git(repoDir, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")) ===
      branch;
    if (!(await onBranch())) return { outcome: "elsewhere" };
    try {
      await this.fetchDefaultBranch(repoDir, branch);
    } catch (caught) {
      console.warn(`[workspace] reading ${repoDir} at start: ${gitFailure(caught)}`);
      return { outcome: "unread" };
    }
    const remote = await resolveCommit(repoDir, `refs/remotes/origin/${branch}`);
    const head = await resolveCommit(repoDir, `refs/heads/${branch}`);
    if (!remote || !head) return { outcome: "unread" };
    if (await isAncestor(repoDir, remote, head)) return { outcome: "current" };
    const refused = (cause: FolderRefreshCause): FolderStartReading => ({
      outcome: "refused",
      refusal: { refreshed: false, cause, branch, remote },
    });
    const dirty = async () =>
      !!(await git(repoDir, ["status", "--porcelain"]).catch(() => "dirty"));
    if (await dirty()) return refused("dirty");
    if (!(await isAncestor(repoDir, head, remote))) return refused("diverged");
    if (
      !(await onBranch()) ||
      (await dirty()) ||
      (await resolveCommit(repoDir, `refs/heads/${branch}`)) !== head
    ) {
      return refused("changed");
    }
    try {
      await git(repoDir, ["merge", "--ff-only", remote]);
      return { outcome: "refreshed", branch, from: head, to: remote };
    } catch {
      return refused("fast-forward-refused");
    }
  }

  /** The default branch the folder's origin declares, or "" when it declares none or is gone. */
  async folderDefaultBranch(repoDir: string): Promise<string> {
    return existsSync(repoDir) ? this.originDefaultBranch(repoDir) : "";
  }

  /** The default branch origin declares, or "" when it declares none. */
  private async originDefaultBranch(repoDir: string): Promise<string> {
    return git(repoDir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
      .then((head) => (head.startsWith("origin/") ? head.slice("origin/".length) : ""))
      .catch(() => "");
  }

  /**
   * Whether a project's folder is up to date, read without changing it
   * (INF-549): clean, on `branch`, and at or past `reach` - or, with no
   * `reach` known, at or past origin's `branch` as last fetched.
   */
  async folderCurrent(repoDir: string, branch: string, reach?: string): Promise<boolean> {
    const current = await git(repoDir, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(
      () => "",
    );
    if (!branch || current !== branch) return false;
    if (await git(repoDir, ["status", "--porcelain"]).catch(() => "dirty")) return false;
    const head = await resolveCommit(repoDir, `refs/heads/${branch}`);
    const target = reach ?? (await resolveCommit(repoDir, `refs/remotes/origin/${branch}`));
    if (!head || !target) return false;
    return isAncestor(repoDir, target, head);
  }

  /**
   * Fetches `origin`'s `branch` into `refs/remotes/origin/<branch>`. Git
   * reads that ref before it downloads and refuses to move it when another
   * fetch moved it meanwhile, so a dispatch a merge starts would fail that
   * merge's refresh. The app's own fetches of one repository therefore run
   * one at a time, and a fetch that lost to one outside the app - a
   * crewmate's own `git fetch` in its worktree, which shares these refs -
   * runs again, up to `FETCH_ATTEMPTS` in all. A failure that left the ref
   * where it was is the fetch's own and throws at once.
   */
  private async fetchDefaultBranch(
    repo: string,
    branch: string,
    remoteName = "origin",
  ): Promise<void> {
    const key = resolve(repo);
    const prior = this.fetchQueues.get(key) ?? Promise.resolve();
    const run = prior
      .catch(() => {})
      .then(() => this.fetchDefaultBranchOnce(repo, branch, remoteName));
    this.fetchQueues.set(key, run);
    try {
      await run;
    } finally {
      if (this.fetchQueues.get(key) === run) this.fetchQueues.delete(key);
    }
  }

  private async fetchDefaultBranchOnce(
    repo: string,
    branch: string,
    remoteName: string,
  ): Promise<void> {
    const tracking = `refs/remotes/${remoteName}/${branch}`;
    for (let attempt = 1; ; attempt++) {
      const before = await resolveCommit(repo, tracking);
      try {
        await git(
          repo,
          ["fetch", "--quiet", "--no-tags", remoteName, `+refs/heads/${branch}:${tracking}`],
          {
            timeoutMs: this.options.fetchTimeoutMs ?? REMOTE_TIMEOUT_MS,
            env: { GIT_TERMINAL_PROMPT: "0" },
          },
        );
        return;
      } catch (caught) {
        const moved = (await resolveCommit(repo, tracking)) !== before;
        if (!moved || attempt >= FETCH_ATTEMPTS) throw caught;
      }
    }
  }

  /**
   * Lands a finished task's branch into the branch currently checked out in
   * its repo (captain decision Q5). Deliberately forge-agnostic: pure local
   * git - fast-forward when possible, a merge commit otherwise - and never
   * a forge API, so GitHub, GitLab, Bitbucket, and plain remotes are all
   * equal. Refuses loudly (with the concrete reason) on a dirty repo, a
   * detached HEAD, or a merge conflict; a refused conflict is aborted so
   * the repo is left exactly as found.
   */
  async landTaskWork(
    workspace: TaskWorkspace,
    beforeDispatch?: (head?: string) => string | undefined,
  ): Promise<{ mode: "fast-forward" | "merge" }> {
    const { repoDir, branch } = workspace;
    const head = await git(repoDir, ["rev-parse", `${branch}^{commit}`]);
    const base = await git(repoDir, ["merge-base", "HEAD", head]);
    await requireNamedRange(repoDir, base, head, this.naming());
    const dirty = await git(repoDir, ["status", "--porcelain"]);
    if (dirty) {
      throw new Error("The repository has uncommitted changes; commit or stash them first.");
    }
    let current: string;
    try {
      current = await git(repoDir, ["symbolic-ref", "--short", "HEAD"]);
    } catch {
      throw new Error("The repository is on a detached HEAD; check out a branch first.");
    }
    const check = () => {
      const refusal = beforeDispatch?.(head);
      if (refusal) throw new Error(refusal);
    };
    check();
    try {
      await git(repoDir, ["merge", "--ff-only", head]);
      return { mode: "fast-forward" };
    } catch {
      // Fall through to a real merge commit.
    }
    check();
    try {
      const name = composedName("integrate task work", this.naming());
      await git(repoDir, ["merge", "--no-ff", "-m", name, head]);
      return { mode: "merge" };
    } catch (caught) {
      await git(repoDir, ["merge", "--abort"]).catch(() => {});
      const message = caught instanceof Error ? caught.message : String(caught);
      throw new Error(
        `Merging ${branch} into ${current} hit a conflict; resolve it manually. ${firstGitError(message)}`,
      );
    }
  }

  /**
   * Whether `commit` is on the project's main line in `repoDir` (INF-3169's
   * plan, piece 2): reachable from its checked-out HEAD or a tracked
   * integration ref, the same refs `taskWorkStatus` counts as merged. Null
   * when the commit cannot be found there, so nobody can say. A squash
   * merge's original commits read false; its pull request's merged flag is
   * the fact for those.
   */
  async commitOnMain(repoDir: string, commit: string): Promise<boolean | null> {
    if (!repoDir) return null;
    const sha = await resolveCommit(repoDir, commit);
    if (!sha) return null;
    const refs = await trackedIntegrationRefs({ taskId: "", cwd: "", branch: "", repoDir });
    for (const ref of ["HEAD", ...refs]) if (await isAncestor(repoDir, sha, ref)) return true;
    return false;
  }

  /**
   * What a discard would destroy: uncommitted edits in the worktree plus
   * branch commits not reachable from the repo's checked-out HEAD or its
   * tracked remote integration refs. A missing worktree or branch counts as
   * nothing to lose - there is nothing left to protect, and discard must
   * still be able to clean up the bookkeeping.
   */
  async taskWorkStatus(
    workspace: TaskWorkspace,
    options: { strict?: boolean } = {},
  ): Promise<{
    dirty: boolean;
    unlandedCommits: number;
  }> {
    let dirty = false;
    let unlandedCommits = 0;
    try {
      // No folder is no working copy here: `git -C ""` would read the
      // process's own folder instead.
      if (!workspace.cwd) throw new Error(`The task has no working copy on ${HERE.this}.`);
      dirty = (await git(workspace.cwd, ["status", "--porcelain"])) !== "";
    } catch (caught) {
      // Discard can clean up a missing tree; a verified release cannot infer
      // that missing means safe to close.
      if (options.strict) throw caught;
    }
    try {
      const integrationRefs = await trackedIntegrationRefs(workspace);
      const count = await git(workspace.repoDir, [
        "rev-list",
        "--count",
        workspace.branch,
        "--not",
        "HEAD",
        ...integrationRefs,
      ]);
      unlandedCommits = Number.parseInt(count, 10) || 0;
    } catch (caught) {
      if (options.strict) throw caught;
      // Branch already gone.
    }
    return { dirty, unlandedCommits };
  }

  /**
   * A closed task's worktree ALWAYS goes (captain, 2026-09-22: "when a task
   * closes, its worktree gets cleaned up period. no exceptions"). Whatever
   * it holds that never landed - uncommitted edits, tracked and untracked
   * (ignored files are not work), and branch commits - is first saved as ONE
   * commit on the task's hidden kept ref (`keptRefFor`), so removing it
   * destroys nothing. Git ancestry only decides whether that save is
   * needed; it never decides whether the tree goes, because a squash-merged
   * pull request reads as unlanded to ancestry forever.
   *
   * The one exception: when the save itself fails, the tree stays exactly
   * as it was and the outcome says why - never a removal on a guess.
   */
  async retireTaskWorktree(
    workspace: TaskWorkspace,
    options: { keepAlways?: boolean } = {},
  ): Promise<WorktreeRetirement> {
    let kept: KeptWork | null;
    try {
      kept = await this.keepUnlandedWork(workspace, options);
    } catch (caught) {
      const reason = gitFailure(caught);
      console.warn(`[workspace] kept ${workspace.cwd}: its work could not be saved: ${reason}`);
      return { outcome: "kept", reason };
    }
    await this.removeTaskWorktree(workspace);
    return { outcome: "removed", kept };
  }

  /**
   * Saves what a worktree holds that never landed as one commit - the
   * worktree's full state (a temporary index, so the crewmate's own index
   * is untouched) whose parents are the checked-out tip, the branch head
   * when it differs, and any earlier save for the same task - and points
   * the task's kept ref at it. An earlier save that already holds that
   * state and every unlanded commit is the save, so keeping again answers
   * the same commit. Null when nothing is unlanded, unless
   * `keepAlways` asks for the save anyway (an escalation's brief names the
   * ref, so it must exist whatever ancestry says). Throws when
   * a tree still on disk cannot be read as a checkout: then nothing proves
   * it holds no work.
   */
  async keepUnlandedWork(
    workspace: TaskWorkspace,
    options: { keepAlways?: boolean } = {},
  ): Promise<KeptWork | null> {
    const { cwd, repoDir, branch, taskId } = workspace;
    const tips = await this.workTips(workspace);
    const tip = tips[0];
    const dirty =
      cwd && existsSync(cwd) ? (await git(cwd, ["status", "--porcelain"])) !== "" : false;
    if (!tip) return null;
    const integrationRefs = await trackedIntegrationRefs(workspace);
    const unlandedCommits = await countCommits(repoDir, tips, ["HEAD", ...integrationRefs]);
    if (!dirty && unlandedCommits === 0 && !options.keepAlways) return null;

    let tree = await git(repoDir, ["rev-parse", `${tip}^{tree}`]);
    if (dirty) {
      const index = resolve(
        cwd,
        await git(cwd, ["rev-parse", "--git-path", "infinitary-kept-index"]),
      );
      const env = { GIT_INDEX_FILE: index };
      try {
        await git(cwd, ["read-tree", tip], { env });
        await git(cwd, ["add", "-A"], { env });
        tree = await git(cwd, ["write-tree"], { env });
      } finally {
        await rm(index, { force: true });
      }
    }
    const ref = keptRefFor(taskId);
    let earlier = "";
    // An earlier save, under Firstmate 3000's name too, stays an ancestor.
    for (const name of keptRefsFor(taskId)) {
      try {
        earlier = await git(repoDir, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`]);
        if (earlier) break;
      } catch {
        // The first save for this task, under this name.
      }
    }
    if (
      earlier &&
      (await git(repoDir, ["rev-parse", `${earlier}^{tree}`])) === tree &&
      (await countCommits(repoDir, tips, [earlier, "HEAD", ...integrationRefs])) === 0
    ) {
      if ((await this.branchHead(repoDir, ref)) !== earlier)
        await git(repoDir, ["update-ref", "-m", `keep task ${taskId}`, ref, earlier]);
      return { ref, sha: earlier, dirty, unlandedCommits };
    }
    const parents = [...new Set([...tips, earlier].filter(Boolean))].flatMap((sha) => ["-p", sha]);
    const held =
      [
        unlandedCommits > 0 ? `${unlandedCommits} unlanded commit(s)` : "",
        dirty ? "uncommitted edits" : "",
      ]
        .filter(Boolean)
        .join(" and ") || "nothing unlanded";
    const sha = await git(repoDir, [
      ...APP_GIT_IDENTITY,
      "commit-tree",
      tree,
      ...parents,
      "-m",
      composedName(`keep work of task ${taskId}${branch ? ` (${branch})` : ""}`, this.naming()),
      "-m",
      `Saved when the task closed and its working copy was removed: ${held}.`,
    ]);
    await git(repoDir, ["update-ref", "-m", `keep task ${taskId}`, ref, sha]);
    return { ref, sha, dirty, unlandedCommits };
  }

  /**
   * The commits a worktree's checkout and branch hold that neither landed
   * nor are in `kept`: what removing it would lose once `kept` holds its
   * work. Throws when a tree still on disk cannot be read as a checkout.
   */
  async unkeptCommits(workspace: TaskWorkspace, kept: string | null): Promise<number> {
    const tips = await this.workTips(workspace);
    if (tips.length === 0) return 0;
    const integrationRefs = await trackedIntegrationRefs(workspace);
    return countCommits(workspace.repoDir, tips, [
      ...(kept ? [kept] : []),
      "HEAD",
      ...integrationRefs,
    ]);
  }

  /**
   * The commits a worktree's work stands on: its checkout's while the tree
   * is on disk, first, and its branch's head when that differs.
   */
  private async workTips(workspace: TaskWorkspace): Promise<string[]> {
    const { cwd, repoDir, branch } = workspace;
    const branchTip = branch ? await this.branchHead(repoDir, branch) : null;
    let tip = branchTip;
    if (cwd && existsSync(cwd)) {
      await assertCheckoutRoot(cwd);
      tip = await git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
    }
    return [...new Set([tip, branchTip].filter((sha): sha is string => Boolean(sha)))];
  }

  /**
   * The directories under the app's worktrees area, by name (a task id
   * when the app made it). Boot hygiene reads it to find trees no record
   * explains.
   */
  listWorktreeDirs(): string[] {
    try {
      return readdirSync(this.paths.worktreesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  /**
   * The workspace a tree under the worktrees area really is, read from git
   * itself - for a tree whose task record is gone. The branch is named
   * only when it is the app's own branch for that task, marked as its or
   * `fm/task-<name>` (`taskBranches.ts`), so retiring the tree
   * never deletes a branch the app did not make. Null when the directory
   * is not a checkout of its own.
   */
  async workspaceAt(name: string): Promise<TaskWorkspace | null> {
    const cwd = join(this.paths.worktreesDir, name);
    try {
      await assertCheckoutRoot(cwd);
      const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      const repoDir = basename(common) === ".git" ? dirname(common) : common;
      let branch = "";
      try {
        const head = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
        if ((await taskOfBranch(repoDir, head)) === name) branch = head;
      } catch {
        // Detached: no branch to retire with it.
      }
      return { taskId: name, cwd, branch, repoDir };
    } catch {
      return null;
    }
  }

  /**
   * Removes a directory under the worktrees area only when it is empty -
   * the stale path a failed `worktree add` can leave. Answers whether it
   * is gone.
   */
  async removeEmptyWorktreeDir(name: string): Promise<boolean> {
    const dir = join(this.paths.worktreesDir, name);
    try {
      if (readdirSync(dir).length > 0) return false;
      await rm(dir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Removes a task's worktree and branch (decision D-13: a task's workspace
   * dies with it). The repo itself and anything merged from the branch stay.
   *
   * The tree leaves its path in one rename into the trash, git forgets the
   * worktree and the branch, and this returns: deleting the tree itself -
   * with `node_modules`, tens of thousands of files and many seconds of
   * disk and CPU - happens in the background below the UI, so a settle
   * never waits on it (character-jank scout, fm3000-character-anim-jank-s1).
   * A tree the rename cannot move is removed in place, as before.
   * `keepBranch` removes only the tree: the branch is the copy this Mac
   * holds of a task that runs on another computer (docs/helper.md,
   * "Moving a task off a computer that is out of reach").
   */
  async removeTaskWorktree(
    workspace: TaskWorkspace,
    options: { keepBranch?: boolean } = {},
  ): Promise<void> {
    // A task that works in place (the personal workspace, a folder repair)
    // has the repository itself, or the folder above a missing one, as its
    // directory: there is no worktree, and the fallback below would delete
    // that folder with everything in it (INF-585).
    if (!workspace.cwd || holds(workspace.cwd, workspace.repoDir)) return;
    // Optional metadata cleanup must not prevent retirement when the project moved or vanished.
    await releaseTaskRemote(workspace.repoDir, workspace.branch).catch((error: unknown) => {
      console.warn("[workspace] task remote cleanup was unavailable:", gitFailure(error));
    });
    if (await this.parkInPool(workspace)) {
      if (options.keepBranch) return;
      try {
        await git(workspace.repoDir, ["branch", "-D", workspace.branch]);
      } catch {
        // Branch already gone.
      }
      return;
    }
    const trashed = await this.moveToTrash(workspace.cwd);
    if (trashed) {
      // The worktree's path is gone, so prune drops its bookkeeping.
      this.deleteInBackground(trashed);
      await git(workspace.repoDir, ["worktree", "prune"]).catch((error: unknown) => {
        console.warn("[workspace] worktree metadata cleanup was unavailable:", gitFailure(error));
      });
    } else {
      try {
        await git(workspace.repoDir, ["worktree", "remove", "--force", workspace.cwd]);
      } catch {
        // The worktree dir may already be gone; prune bookkeeping either way.
        // Only a tree under the worktrees area is deleted without git: any
        // other directory git refused is not this repository's worktree,
        // such as the folder a repair started in before its project's
        // folder was named somewhere else (INF-585).
        if (dirname(resolve(workspace.cwd)) === resolve(this.paths.worktreesDir)) {
          await rm(workspace.cwd, { recursive: true, force: true });
        }
        await git(workspace.repoDir, ["worktree", "prune"]).catch((error: unknown) => {
          console.warn("[workspace] worktree metadata cleanup was unavailable:", gitFailure(error));
        });
      }
    }
    if (options.keepBranch) return;
    try {
      await git(workspace.repoDir, ["branch", "-D", workspace.branch]);
    } catch {
      // Branch already gone.
    }
  }

  /**
   * A removed tree goes to the warm pool instead of the trash when it can
   * (`WorktreePool.park`): only a tree the app made, under the worktrees
   * area. Every caller has already saved the work it held, or chose to
   * throw it away - exactly what deleting it assumed - and the pool resets
   * it clean before any other task can have it.
   */
  private async parkInPool(workspace: TaskWorkspace): Promise<boolean> {
    const { cwd, repoDir } = workspace;
    if (!this.pool || !cwd || !repoDir) return false;
    if (dirname(resolve(cwd)) !== resolve(this.paths.worktreesDir) || !existsSync(cwd)) {
      return false;
    }
    return this.pool.park(cwd, repoDir);
  }

  /**
   * Boot: finish the pool returns a quit interrupted, and retire idle trees
   * past the pool's budget or age. Runs in the background; never throws.
   */
  sweepPool(): void {
    if (this.pool) void this.pool.sweep().catch(() => {});
  }

  /** Resolves once every pool return started so far has finished: a reset waits on it before undoing a project's links, and tests do. */
  async poolSettled(): Promise<void> {
    await this.pool?.settled();
  }

  /** The idle trees in the pool (tests and diagnostics). */
  pooledTrees(): string[] {
    return this.pool?.idle() ?? [];
  }

  /**
   * Boot: finish deleting what a quit interrupted. Never throws; what
   * cannot be deleted now is tried again at the next boot.
   */
  sweepTrash(): void {
    let entries: string[];
    try {
      entries = readdirSync(this.paths.worktreeTrashDir);
    } catch {
      return;
    }
    for (const entry of entries) this.deleteInBackground(join(this.paths.worktreeTrashDir, entry));
  }

  async deletionsSettled(): Promise<void> {
    await Promise.all([...this.deletions]);
  }

  private async moveToTrash(cwd: string): Promise<string | null> {
    // Only a tree the app made (`createTaskWorktree`) moves aside; anything
    // else takes the in-place route, where git checks it is a worktree.
    if (!cwd || dirname(resolve(cwd)) !== resolve(this.paths.worktreesDir)) return null;
    if (!existsSync(cwd)) return null;
    const target = join(
      this.paths.worktreeTrashDir,
      `${basename(cwd)}-${randomUUID().slice(0, 8)}`,
    );
    try {
      await mkdir(this.paths.worktreeTrashDir, { recursive: true });
      await rename(cwd, target);
      return target;
    } catch {
      return null;
    }
  }

  /** Out of its path in one rename, deleted in the background; in place when the rename fails. */
  private async discardDir(dir: string): Promise<void> {
    // The entry itself, never where it leads: a link whose folder has gone is still there to remove.
    if (!(await lstat(dir).catch(() => null))) return;
    const target = join(
      this.paths.worktreeTrashDir,
      `${basename(dir)}-${randomUUID().slice(0, 8)}`,
    );
    try {
      await mkdir(this.paths.worktreeTrashDir, { recursive: true });
      await rename(dir, target);
      this.deleteInBackground(target);
    } catch {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Deletes a folder already moved into the trash, below the UI; what a
   * quit leaves behind is swept at the next boot. A closed task's leftover
   * files take this way too (`../tasks/closedTaskFiles.ts`).
   */
  deleteInBackground(dir: string): void {
    const deletion: Promise<void> = (this.options.deleteTree ?? deleteTree)(dir)
      // A tree left behind is swept at the next boot.
      .catch(() => {})
      .finally(() => {
        this.deletions.delete(deletion);
      });
    this.deletions.add(deletion);
  }
}

/** `rm -rf` below the UI (../utilityQos.ts), with the in-process delete as the fallback. */
async function deleteTree(dir: string): Promise<void> {
  const command = atUtilityQos("rm", ["-rf", dir]);
  try {
    await execFileAsync(command.file, command.args);
  } catch {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Refuses a directory that is not the root of its own checkout: `git -C`
 * walks up to any enclosing repository, and reading THAT repository's
 * status would say nothing about this tree.
 */
async function assertCheckoutRoot(cwd: string): Promise<void> {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (realpathSync(top) !== realpathSync(cwd)) {
    throw new Error(`${cwd} is not a checkout of its own`);
  }
}

/**
 * The ref a review diff is measured from: the default branch read in place
 * of `origin`'s when one is named (`routedReviewBase`), else `origin`'s
 * fetched default branch, else the local one.
 */
async function reviewDiffBase(repoDir: string, defaultBranch?: string): Promise<string> {
  if (defaultBranch) return defaultBranch;
  const name = await defaultBranchName(repoDir);
  const remote = `refs/remotes/origin/${name}`;
  return (await resolveCommit(repoDir, remote)) ? remote : `refs/heads/${name}`;
}

/**
 * The change reading (INF-148, the captain's words: a passed review should
 * not start over only because main moved). The three-dot diff of the
 * commit against the review base, with one line of context, hunk positions
 * and blob ids removed, and spaces kept exact. A line moved beside the
 * same neighbors still counts as the same change. A main edit right next
 * to the change asks for a fresh review. Spawned through `git()`, which
 * uses hostEnv.
 */
export async function readChangeReading(
  repoDir: string,
  headSha: string,
  /** The default branch read in place of `origin`'s (`routedReviewBase`). */
  defaultBranch?: string,
): Promise<string | null> {
  if (!(await resolveCommit(repoDir, headSha))) return null;
  const base = await reviewDiffBase(repoDir, defaultBranch);
  let diff: string;
  try {
    diff = await git(
      repoDir,
      [
        "diff",
        "-U1",
        "--ignore-submodules=none",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--binary",
        "--diff-algorithm=myers",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        `${base}...${headSha}`,
      ],
      { trim: false },
    );
  } catch {
    return null;
  }
  return createHash("sha256").update(normalizeChangeDiff(diff)).digest("hex");
}

/** Drop blob-id lines and reduce each hunk header to `@@`, leaving every other byte. */
export function normalizeChangeDiff(diff: string): string {
  return diff
    .split("\n")
    .filter((line) => !/^index [0-9a-f]+\.\.[0-9a-f]+/.test(line))
    .map((line) => (line.startsWith("@@ ") ? "@@" : line))
    .join("\n");
}

/**
 * The branch a new task starts from: `origin`'s declared default when git
 * knows it, else `main` or `master` where either exists, else whatever the
 * repository has checked out.
 */
async function defaultBranchName(repo: string): Promise<string> {
  try {
    const head = await git(repo, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    if (head.startsWith("origin/")) return head.slice("origin/".length);
  } catch {
    // origin/HEAD is only set by a clone; many repositories never have it.
  }
  for (const name of ["main", "master"]) {
    if (
      (await resolveCommit(repo, `refs/remotes/origin/${name}`)) ||
      (await resolveCommit(repo, `refs/heads/${name}`))
    ) {
      return name;
    }
  }
  try {
    return await git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  } catch {
    return "main";
  }
}

async function resolveCommit(repo: string, ref: string): Promise<string | null> {
  try {
    return (await git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) || null;
  } catch {
    return null;
  }
}

async function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(repo, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

async function isMatchingWorktree(cwd: string, branch: string): Promise<boolean> {
  if (!existsSync(cwd)) return false;
  try {
    return (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])) === branch;
  } catch {
    return false;
  }
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function countCommits(repoDir: string, from: string[], not: string[]): Promise<number> {
  const count = await git(repoDir, ["rev-list", "--count", ...from, "--not", ...not]);
  return Number.parseInt(count, 10) || 0;
}

/**
 * Remote destinations that can prove task commits were integrated without a
 * local pull: the checked-out branch's upstream and each remote's declared
 * default branch. The task branch's own tracking ref is never a destination.
 * Every optional ref is discovered and verified independently so one stale
 * remote does not hide work or invalidate the final reachability count.
 */
async function trackedIntegrationRefs(workspace: TaskWorkspace): Promise<string[]> {
  const { repoDir, branch } = workspace;
  const taskRemoteRefs = new Set<string>();
  const candidates = new Set<string>();
  // What the home sent this computer's default workspace is where its tasks
  // started, so it is merged work, not the task's.
  candidates.add(SEEDED_REF);
  candidates.add(OLDER_SEEDED_REF);

  try {
    const remotes = (await git(repoDir, ["remote"]))
      .split("\n")
      .map((remote) => remote.trim())
      .filter(Boolean);
    for (const remote of remotes) taskRemoteRefs.add(`refs/remotes/${remote}/${branch}`);
  } catch {
    // No configured remotes.
  }

  try {
    const head = await git(repoDir, ["symbolic-ref", "--quiet", "HEAD"]);
    const upstream = await git(repoDir, ["for-each-ref", "--format=%(upstream)", head]);
    if (upstream) candidates.add(upstream);
  } catch {
    // Detached HEAD or no upstream.
  }

  try {
    const refs = await git(repoDir, ["for-each-ref", "--format=%(refname)", "refs/remotes"]);
    for (const ref of refs.split("\n")) {
      if (ref.endsWith("/HEAD")) candidates.add(ref);
    }
  } catch {
    // No remote-tracking refs.
  }

  const integrationRefs: string[] = [];
  for (const candidate of candidates) {
    let destination = candidate;
    try {
      destination = await git(repoDir, ["symbolic-ref", "--quiet", candidate]);
    } catch {
      // A direct remote-tracking ref is expected to be non-symbolic.
    }
    if (taskRemoteRefs.has(candidate) || taskRemoteRefs.has(destination)) continue;
    try {
      await git(repoDir, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]);
      integrationRefs.push(candidate);
    } catch {
      // A stale optional ref must not poison the valid destinations.
    }
  }
  return integrationRefs;
}

/** The last meaningful line of a failed install, for a timeline-sized reason. */
function installError(caught: unknown): string {
  const failure = caught as { stderr?: string; message?: string; killed?: boolean };
  if (failure.killed) return "timed out";
  const lines = `${failure.stderr ?? ""}\n${failure.message ?? ""}`
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const reason = lines.find((line) => /ERR_|error/i.test(line)) ?? lines.at(-1) ?? "unknown error";
  return reason.length > 200 ? `${cutText(reason, 200)}...` : reason;
}

/** The first stderr-ish line of a git failure, for a card-sized reason. */
function firstGitError(message: string): string {
  const line = message
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("CONFLICT") || entry.startsWith("error:"));
  return line ?? "";
}
