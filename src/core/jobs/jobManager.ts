import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cutText, cutTextEnd } from "@shared/textCut";
import { hostEnv, SHELL_CAP_ENV, SHELL_ID_ENV, SHELL_STARTED_ENV, withTaskShell } from "../hostEnv";
import type { TypedWake, WakeLane } from "../orchestrator/wakes";
import { appendOverflow, capWithOverflow, overflowFilePath } from "../overflow";
import { windowsBash } from "../pi/windowsBash";
import { processRoots } from "../placed/processRoots";
import type { ShellGroups } from "../placed/shellGroups";
import { windowsJobs } from "../placed/windowsProcesses";
import { hostPlatform } from "../platform";
import type { TaskShell } from "../session/session";
import type { AppDatabase } from "../storage/db";
import { type InterruptedJob, JobStore } from "../storage/jobStore";
import { atUtilityQos } from "../utilityQos";
import { endWindowsTree } from "../windowsTree";

/**
 * Background jobs for the event-driven bash tool (R2): a command that
 * finishes within the synchronous cap returns like ordinary bash; anything
 * longer keeps running as a job, the calling turn stays free, and the
 * process EXIT is what wakes the owning session - nothing polls.
 *
 * Job lifetime is app lifetime: quit kills the processes and leaves each
 * one's row, marked, where its rows are kept - the jobs table on the home,
 * the task's own folder on a computer that runs work (`JobRows`). Rows left
 * there at boot are the honest record: a marked one the quit stopped; an
 * unmarked one was running when the app ended without its quit, and since
 * jobs run detached, its command may have run on, even to the end.
 */

export type JobExit = {
  jobId: string;
  ownerId: string;
  command: string;
  exitCode: number | null;
  durationMs: number;
  tail: string;
  /**
   * It never exited where it ran: the run of the computer that runs work
   * ended first, and its next start says so once (`SessionHost`). `quit`:
   * that run's own stop killed it, `durationMs` in, or the home's quit
   * ended the Claude client it ran in (`CrewSupervisor`). `crash`: the run
   * ended without its stop, so the command may have run on, even to the
   * end. `client`: a Claude client's background task, which ended with its
   * client while Infinitary ran on (`CrewSupervisor`, `SessionHost`).
   */
  interrupted?: "quit" | "crash" | "client";
};

/**
 * Where each background job's row is kept while it runs, so the next start
 * can name what the last one's end cut off (the module comment): the home's
 * jobs table (`JobStore`), or a task's folder on a computer that runs work
 * (`PlacedTasks.jobRows`), whose conversation names them (`SessionHost`).
 */
export type JobRows = {
  add(job: { id: string; ownerId: string; command: string; startedAt: number }): void;
  remove(id: string, ownerId: string): void;
  /** The quit has sent this job its kill, at `at` on the job's clock. */
  markStoppedByQuit(id: string, ownerId: string, at: number): void;
};

export type BashOutcome =
  | { kind: "done"; exitCode: number | null; output: string }
  | { kind: "job"; jobId: string; tail: string };

/** The captain's synchronous cap (R2, round-2 decision): 3 seconds. */
export const SYNC_CAP_MS = 3000;

/** Keep the tail; a command that prints megabytes keeps its last words. */
const OUTPUT_CAP = 32_768;
const COMMAND_EXCERPT = 80;

type RunningJob = {
  id: string;
  ownerId: string;
  command: string;
  startedAt: number;
  child: ReturnType<typeof spawn>;
  /** It runs on Windows, which has no process groups (`killGroup`). */
  windows: boolean;
  output: { text: string; truncated: boolean; overflowFile?: string };
  /** Who killed it (its owner's cancel, the app's quit): the exit is not news. */
  stoppedBy?: "owner" | "quit";
};

export type JobManagerOptions = {
  onChange?: () => void;
  /**
   * The home's database, whose jobs table keeps the rows and answers
   * `reportInterrupted`. Absent with no `rows` either (tests) means no
   * interrupted-at-quit record.
   */
  db?: AppDatabase;
  /** Where the rows are kept instead, by a reader of its own (`JobRows`). */
  rows?: JobRows;
  /** The wake: one call per background-job exit, with the bounded tail. */
  onExit: (exit: JobExit) => void;
  /**
   * The host's one clock (the ticker's): a job's `startedAt`, which the
   * idle ladder's job bound compares against, and its duration. Absent
   * reads `Date.now()`.
   */
  now?: () => number;
  /**
   * Whether its commands run below the UI (`atUtilityQos`), as they do on
   * the Mac whose window draws the character: the home's own, and another
   * user's work there. A separate Mac that runs work draws none, so its
   * crewmates' builds and tests run at the run's own priority instead
   * (docs/helper.md, "Holding a conversation"). Absent means below.
   */
  belowUi?: boolean;
  /** The system it runs on (tests); absent reads this computer's. */
  platform?: NodeJS.Platform;
  /** On Windows, the bash its commands run in (tests); absent asks Pi (`windowsBash`). */
  windowsBash?: () => string | undefined;
  /**
   * Where each shell's own process group is kept for its owner, after the
   * shell ends, so a program it left running is still known as the crew's
   * (docs/axi-commands.md, "Never the crew's"). The home keeps them, where
   * the Infinitary command's door reads them; absent keeps none.
   */
  shellGroups?: Pick<ShellGroups, "add">;
};

/**
 * What a command on Windows answers when the computer has no Git Bash to run
 * it in, without starting anything.
 */
export const NO_GIT_BASH =
  "This command did not run: crewmates' commands on Windows run in Git Bash, so install Git for Windows (https://gitforwindows.org) and run it again.";

export class JobManager {
  private readonly jobs = new Map<string, RunningJob>();
  /**
   * Shells still inside their limit, by the id each tells its commands
   * (`SHELL_ID_ENV`), and whether a task command in it reached the app.
   */
  private readonly limited = new Map<string, { answering: boolean }>();
  private readonly now: () => number;
  private readonly store: JobStore | undefined;
  /** The interrupted-at-quit record; absent with neither (tests). */
  private readonly rows: JobRows | undefined;

  constructor(private readonly options: JobManagerOptions) {
    const now = options.now;
    this.now = now ? () => now() : () => Date.now();
    this.store = options.db ? new JobStore(options.db) : undefined;
    this.rows = options.rows ?? this.store;
  }

  /**
   * Boot: rows left by a previous process are jobs its quit stopped, or that
   * were running when it ended without one. Returns them (cleared) so the
   * caller can say which, honestly, once.
   */
  reportInterrupted(): InterruptedJob[] {
    return this.store?.takeInterrupted() ?? [];
  }

  /**
   * A task command in the shell with this id reached the app, which answers
   * it within the shell's limit (docs/axi-commands.md, "A shell's limit").
   * That answer still comes back through the shell, which a loaded Mac can
   * hold up past the limit, so the shell waits for it (`run`). The id of a
   * shell no longer inside its limit changes nothing.
   */
  answering(shell: string): void {
    const limited = this.limited.get(shell);
    if (limited) limited.answering = true;
  }

  /**
   * Run one command. Resolves with the output when it finishes within the
   * cap (or the command was quick), or within one cap more once a task
   * command in it reached the app (`answering`), with a job handle
   * otherwise - and then the exit arrives through onExit when it comes.
   */
  run(input: {
    ownerId: string;
    command: string;
    cwd: string;
    background?: boolean;
    capMs?: number;
    /** What the session's shell carries beyond the host's environment (`SessionSpec.shell`). */
    shell?: TaskShell;
  }): Promise<BashOutcome> {
    const id = randomUUID().slice(0, 8);
    // The shell's own id, which a task command passes on (`answering`).
    const shellId = randomUUID();
    const startedAt = this.now();
    // The channel compares this stamp with `Date.now()`, not the ticker.
    const shellStartedAt = Date.now();
    // A crewmate's builds and tests run below the UI (../utilityQos.ts),
    // where there is one. Its stderr is its stdout, joined by a `sh` that
    // then becomes bash, so the output reads in the order the command wrote
    // it: read from two pipes, a line written earlier on one landed after a
    // later line on the other whenever the app reached them late (INF-689).
    // The command itself is bash's, word for word, so its errors quote it.
    // Windows has no /bin/sh: Git Bash joins the output there, then becomes
    // its own bash, and with none to run in the command answers at once.
    const windows = (this.options.platform ?? hostPlatform()) === "win32";
    const gitBash = windows ? (this.options.windowsBash ?? windowsBash)() : undefined;
    if (windows && !gitBash) {
      return Promise.resolve({ kind: "done", exitCode: 127, output: NO_GIT_BASH });
    }
    const sh = gitBash ?? "/bin/sh";
    const bash = gitBash ? "/usr/bin/bash" : "/bin/bash";
    const shell = ["-c", 'exec "$@" 2>&1', "sh", bash, "-c", input.command];
    const command =
      this.options.belowUi === false ? { file: sh, args: shell } : atUtilityQos(sh, shell);
    const child = spawn(command.file, command.args, {
      cwd: input.cwd,
      // The person's search path, so node, pnpm and gh are there from a Dock
      // launch, the session's own shell over it, and the cap this command
      // answers within, counted from this start, which a task command keeps
      // to (docs/axi-commands.md). Pi's own timer below counts from the spawn.
      env: withTaskShell(
        hostEnv({
          [SHELL_CAP_ENV]: String(input.background ? 0 : (input.capMs ?? SYNC_CAP_MS)),
          [SHELL_STARTED_ENV]: String(shellStartedAt),
          [SHELL_ID_ENV]: shellId,
        }),
        input.shell,
      ),
      // Its own process group, so killing a job kills what it spawned. On
      // Windows, detached keeps it out of the job the app's process library
      // puts its other children in, which ends them when the app exits, so
      // what a command leaves running outlives the app as on a Mac; it has
      // no console and shows no window, and Git Bash gives the console
      // programs it starts a hidden one. Its tree is killed by process id
      // there (`killGroup`).
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.pid) {
      const releaseRoot = processRoots.add(child.pid, input.ownerId);
      // Detached, the shell leads a group numbered after it, which a program
      // it starts in the background stays in after the shell ends. On
      // Windows the shell leads a job instead, numbered after it the same way.
      const started = windows ? windowsJobs.lead(child.pid) : undefined;
      const shellEnded = !windows
        ? this.options.shellGroups?.add(child.pid, input.ownerId)
        : started
          ? this.options.shellGroups?.add(child.pid, input.ownerId, started)
          : undefined;
      child.once("exit", () => {
        releaseRoot();
        shellEnded?.();
      });
    }
    const job: RunningJob = {
      id,
      ownerId: input.ownerId,
      command: input.command,
      startedAt,
      child,
      windows,
      output: { text: "", truncated: false },
    };
    const append = (chunk: Buffer) => {
      job.output.text += chunk.toString("utf8");
      if (job.output.text.length > OUTPUT_CAP) {
        // The live buffer only ever holds the tail (memory, not information,
        // is the constraint here); what falls off the front is not lost -
        // it spills to a file so the full output is still one open away.
        const kept = cutTextEnd(job.output.text, OUTPUT_CAP);
        const evicted = job.output.text.length - kept.length;
        job.output.overflowFile ??= overflowFilePath("job-output", job.id);
        appendOverflow(job.output.overflowFile, job.output.text.slice(0, evicted));
        job.output.text = kept;
        job.output.truncated = true;
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    return new Promise<BashOutcome>((resolve) => {
      let becameJob = false;
      let exited = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const becomeJob = () => {
        this.limited.delete(shellId);
        if (becameJob || exited) return;
        becameJob = true;
        this.jobs.set(id, job);
        this.options.onChange?.();
        this.rows?.add({ id, ownerId: input.ownerId, command: input.command, startedAt });
        resolve({ kind: "job", jobId: id, tail: renderOutput(job.output) });
      };

      child.on("error", (error) => {
        append(Buffer.from(`${error.message}\n`));
      });
      child.on("close", (code, signal) => {
        exited = true;
        this.limited.delete(shellId);
        if (timer) clearTimeout(timer);
        this.jobs.delete(id);
        this.options.onChange?.();
        // Only a job has a row. The quit's kill leaves it for the next boot
        // to name; a job that finished on its own before the kill landed
        // leaves none.
        if (becameJob && (job.stoppedBy !== "quit" || signal === null))
          this.rows?.remove(id, input.ownerId);
        if (!becameJob) {
          resolve({ kind: "done", exitCode: code, output: renderOutput(job.output) });
          return;
        }
        if (job.stoppedBy) return;
        this.options.onExit({
          jobId: id,
          ownerId: input.ownerId,
          command: input.command,
          exitCode: code,
          durationMs: this.now() - startedAt,
          tail: renderOutput(job.output),
        });
      });

      if (input.background) {
        becomeJob();
      } else {
        const cap = input.capMs ?? SYNC_CAP_MS;
        const limited = { answering: false };
        this.limited.set(shellId, limited);
        // A task command that reached the app has its answer on the way
        // back: the shell waits for it, for at most one limit more, so a
        // shell that goes on after that command still becomes a job.
        timer = setTimeout(() => {
          if (limited.answering) timer = setTimeout(becomeJob, cap);
          else becomeJob();
        }, cap);
      }
    });
  }

  runningJobCount(ownerId: string): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.ownerId === ownerId) count += 1;
    }
    return count;
  }

  /** How many background commands run here now, whoever owns them: a restart stops each. */
  runningCount(): number {
    return this.jobs.size;
  }

  hasRunningJobs(ownerId: string): boolean {
    for (const job of this.jobs.values()) {
      if (job.ownerId === ownerId) return true;
    }
    return false;
  }

  /**
   * The owner's longest-running job, for the bound on background jobs as
   * proof of life (docs/report-sort.md): the host reads its start beside
   * `hasRunningJobs` and never kills it for its age.
   */
  oldestRunningJob(
    ownerId: string,
  ): { jobId: string; command: string; startedAt: number } | undefined {
    let oldest: RunningJob | undefined;
    for (const job of this.jobs.values()) {
      if (job.ownerId !== ownerId) continue;
      if (!oldest || job.startedAt < oldest.startedAt) oldest = job;
    }
    return oldest
      ? { jobId: oldest.id, command: oldest.command, startedAt: oldest.startedAt }
      : undefined;
  }

  /**
   * The owner ended (cancel, discard): its jobs die and stay quiet, and no
   * later boot has anything to say about them.
   */
  killForOwner(ownerId: string): void {
    for (const job of this.jobs.values()) {
      if (job.ownerId !== ownerId) continue;
      job.stoppedBy = "owner";
      this.rows?.remove(job.id, job.ownerId);
      killGroup(job, "SIGTERM");
    }
  }

  /**
   * App quit: everything dies, and each row is marked once its kill is sent,
   * so the next boot names the jobs the quit stopped. The mark comes after
   * the kill: a row a crash leaves unmarked only ever says less.
   */
  disposeAll(): void {
    for (const job of this.jobs.values()) {
      job.stoppedBy = "quit";
      killGroup(job, "SIGKILL");
      this.rows?.markStoppedByQuit(job.id, job.ownerId, this.now());
    }
  }
}

/** Kill a detached shell and every program in its group (its job tree on Windows). */
export function killGroup(
  job: { child: ReturnType<typeof spawn>; windows: boolean },
  signal: NodeJS.Signals,
): void {
  const pid = job.child.pid;
  if (!pid) return;
  if (job.windows) {
    // Windows' own taskkill ends the job and every program under it, by
    // force, as Pi's bash does; nothing there takes a gentler signal.
    endWindowsTree(pid, () => job.child.kill(signal));
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    job.child.kill(signal);
  }
}

function renderOutput(output: { text: string; truncated: boolean; overflowFile?: string }): string {
  const text = output.text.trimEnd();
  return output.truncated
    ? `[earlier output truncated; full output: ${output.overflowFile}]\n${text}`
    : text;
}

/**
 * A job's exit as the typed wake its owner hears (R2): the Firstmate's
 * `[fm-op]` or a crewmate's `[job]` turn, worded by `renderWake`. The
 * command is cut to its excerpt and the tail capped here, once, because
 * a long tail spills to an overflow file.
 */
export function jobExitWake(exit: JobExit, to: WakeLane): TypedWake {
  const command =
    exit.command.length > COMMAND_EXCERPT
      ? `${cutText(exit.command, COMMAND_EXCERPT)}...`
      : exit.command;
  return {
    facts: {
      kind: "job-exit",
      to,
      jobId: exit.jobId,
      command,
      exitCode: exit.exitCode,
      durationMs: exit.durationMs,
      ...(exit.tail ? { tail: capWithOverflow(exit.tail, "job-exit-tail", { keep: "tail" }) } : {}),
      ...(exit.interrupted ? { interrupted: exit.interrupted } : {}),
    },
  };
}
