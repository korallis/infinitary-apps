import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { softHoldWords } from "@shared/holds";
import { type LoadDemand, type LoadRun, type LoadSnapshot, loadDemandSchema } from "@shared/load";
import {
  RESOURCE_MAX_AGE_MS,
  RESOURCE_REFRESH_MS,
  type ResourceObservation,
} from "@shared/resources";
import { z } from "zod";
import { hostPlatform } from "../platform";
import { memoryUsedBytes } from "./memoryUsed";
import { type ProcessReading, readProcesses, readReceiptProcess } from "./processResources";
import { processRoots } from "./processRoots";
import { memoryMarginBytes, resourceCapacity } from "./resourceCapacity";
import type { CpuWindow, ProcessWindow } from "./resourceSampler";
import { windowsJobs } from "./windowsProcesses";

const heldSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().min(1),
  demand: loadDemandSchema,
  pid: z.number().int().positive(),
  started: z.string().min(1),
  state: z.enum(["waiting", "running"]),
  launch: z.object({ pid: z.number().int().positive(), started: z.string().min(1) }).optional(),
  /** The process that started the waiting wrapper; its end means nobody reads the run. */
  caller: z.object({ pid: z.number().int().positive(), started: z.string().min(1) }).optional(),
});
type Held = z.infer<typeof heldSchema>;

/** The journal keeps its newest lines within this size; the oldest half drops. */
export const JOURNAL_MAX_BYTES = 1024 * 1024;
/** The line's journal sits beside its saved holds. */
export const JOURNAL_FILE = "journal.jsonl";
/** The operating system's first process adopts a wrapper whose caller ended. */
const ADOPTER_PID = 1;
const CALLER_GONE = "The run's caller has ended, so the run left the line; nothing started.";
const MIB = 1024 ** 2;
/**
 * How long a run that fits may start ahead of a bigger run first in line,
 * counted from when that run became first (INF-6381, the captain's 10 minutes).
 * After it nothing passes, so the bigger run waits at most this plus the
 * passing runs' lengths. In memory only: a restart never restarts a window.
 */
export const PASSING_WINDOW_MS = 10 * 60_000;

/** One journal line: what the line did, to which run, and what it compared against. */
export type LoadJournalEntry = {
  at: string;
  event: "wait" | "admit" | "blocked" | "exited" | "release" | "refuse" | "unread";
  taskId: string;
  hold?: string;
  demand?: LoadDemand;
  /** What the line had left to give when it compared, or null without a fresh normal reading. */
  capacity?: LoadDemand | null;
  /** installed: judged against installed memory with nothing running; override: a recorded override passed it. */
  basis?: "capacity" | "installed" | "override";
  pressure?: string;
  running?: number;
  ahead?: number;
  /** A passing admission: the hold first in line that it started ahead of. */
  passed?: string;
  residentBytes?: number;
  why?: string;
};

/**
 * `caller` is the wrapper's own caller where the system cannot say who
 * started the leader: on Windows the leader's parent reads as none, so the
 * wrapper names the outer program it was started by (docs/heavy-runs.md, "On Windows").
 */
export type LoadClaim = { pid: number; demand: LoadDemand; parent?: string; caller?: number };
/**
 * `started` is the payload's birth as its receipt worker read it. A Windows
 * worker runs in Git Bash, which cannot read Windows' birth stamp, so it sends
 * none and the line stamps the birth from its own reading of the run's job.
 */
export type LoadReceipt = { hold: string; pid: number; payload: number; started?: string };
/**
 * A receipt the line could neither verify nor refuse, because this computer's
 * programs could not be read. Nothing was saved and the same receipt may ask again.
 */
export class LoadReceiptUnreadError extends Error {}
/**
 * A claim's answer: its run, or, when the process table could not be read
 * and the caller holds no verified place, a wait with no hold that the
 * wrapper answers by asking again (INF-3192). It grants nothing.
 */
export type LoadClaimAnswer =
  | LoadRun
  | { id?: undefined; state: "waiting"; ahead: number; reason: "unavailable" };
export type TaskLoad = {
  receipt: (input: LoadReceipt, permitted?: () => boolean) => Promise<void>;
  claim: (input: LoadClaim) => Promise<LoadClaimAnswer>;
  read: () => LoadSnapshot;
};

/**
 * Signal zero observes existence only. It never kills, pauses or changes scheduling.
 * Windows has no process groups: there the group is the job the app made, and
 * it exists while a program is in it.
 */
export function loadGroupExists(group: number): boolean {
  if (hostPlatform() === "win32") return windowsJobs.exists(group);
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** The Windows jobs a heavy run's group is (`WindowsJobs`). */
export type LoadJobs = {
  lead: (pid: number, started: string) => string | undefined;
  adopt: (pid: number, started: string) => boolean;
};

/**
 * One line on a work computer. The native wrapper is its own process-group
 * leader before it asks; admission execs the caller's program in that group.
 * The whole group, not the requesting shell or an HTTP connection, owns its
 * declared hold. Saved metadata lets living groups retain it after a restart.
 * No command, environment, process argument or credential is kept here.
 */
export class LoadLine {
  private held: Held[];
  private readonly roots = new Map<string, () => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private latest: { observation: ResourceObservation; at: number } | undefined;
  // Runtime coverage is never restored: monotonic boundaries belong to this host lifetime.
  private readonly verified = new Map<string, number>();
  private readonly covered = new Set<string>();
  private cpuEpoch: string | undefined;
  private cpuEnd = -Infinity;
  private cpuSequence = -Infinity;
  private readonly retiredEpochs = new Set<string>();
  private measuredMemory = new Map<string, number>();
  /** Running holds whose admitted program has exited while other group members live on. */
  private exited = new Set<string>();
  private readonly journaledExits = new Set<string>();
  /** Waiting groups that left because their caller ended; a later claim from one is refused. */
  private readonly left = new Set<string>();
  private blocked: string | undefined;
  /** The run first in line and when it became first, on this host lifetime's monotonic clock. */
  private front: { id: string; since: number } | undefined;
  /** What the line had to give when it last compared the run first in line and it did not fit. */
  private room: { id: string; free: LoadDemand } | undefined;
  private failure: unknown;
  private stopped = false;

  constructor(
    private readonly options: {
      stateFile: string;
      processes?: () => Promise<ProcessReading[] | null>;
      groupExists?: (group: number) => boolean;
      /**
       * Windows starts no group for the wrapper, so the line makes its asking
       * program lead a job (`WindowsJobs.lead`), answering its birth, and finds
       * a saved run's job again after a restart (`adopt`). Absent on other systems.
       */
      jobs?: LoadJobs;
      overridden?: (taskId: string) => boolean;
      changed?: () => void;
      now?: () => number;
      /** Wall-clock time for journal lines; admission keeps its monotonic clock. */
      wallClock?: () => number;
      journalFile?: string;
    },
  ) {
    try {
      this.held = z.array(heldSchema).parse(JSON.parse(readFileSync(options.stateFile, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.failure = error;
      this.held = [];
    }
    for (const held of this.held) {
      this.track(held);
      if (held.launch) this.verified.set(held.id, this.now());
    }
    const first = this.held.find((held) => held.state === "waiting");
    // Its window may already have passed before the restart; it gets no new one.
    if (first) this.front = { id: first.id, since: -Infinity };
    this.watch();
  }

  get active(): boolean {
    return this.held.length > 0;
  }

  forTask(taskId: string): TaskLoad {
    return {
      claim: (input) => this.claim(taskId, input),
      receipt: (input, permitted) => this.receipt(taskId, input, permitted),
      read: () => ({ runs: this.snapshot().runs.filter((run) => run.taskId === taskId) }),
    };
  }

  /** Reuses the sampler's completed reading and metadata; never starts another CPU window. */
  observe(
    observation: ResourceObservation,
    processes: ProcessReading[] | null,
    started = this.now(),
    _window?: ProcessWindow,
    cpuWindow?: CpuWindow,
  ): void {
    if (this.stopped || this.failure) return;
    // A repeated endpoint is not a new interval. Never let an old lifetime or
    // out-of-order reply replace current capacity or advance startup coverage.
    if (cpuWindow) {
      if (
        !Number.isFinite(cpuWindow.start) ||
        !Number.isFinite(cpuWindow.end) ||
        cpuWindow.start >= cpuWindow.end ||
        cpuWindow.end > this.now() ||
        (observation.status === "sampled" &&
          cpuWindow.end - cpuWindow.start !== observation.sampleMs)
      )
        return;
      if (cpuWindow.epoch !== observation.epoch || this.retiredEpochs.has(cpuWindow.epoch)) return;
      if (this.cpuEpoch !== cpuWindow.epoch) {
        if (this.cpuEpoch) {
          this.retiredEpochs.add(this.cpuEpoch);
          this.covered.clear();
          for (const id of this.verified.keys()) this.verified.set(id, this.now());
        }
        this.cpuEpoch = cpuWindow.epoch;
        this.cpuEnd = -Infinity;
        this.cpuSequence = -Infinity;
      }
      if (observation.sequence <= this.cpuSequence || cpuWindow.end <= this.cpuEnd) return;
      this.cpuEnd = cpuWindow.end;
      this.cpuSequence = observation.sequence;
    }
    this.latest = { observation, at: cpuWindow ? Math.min(started, cpuWindow.end) : started };
    try {
      if (processes) {
        const byPid = new Map(processes.map((row) => [row.pid, row]));
        const groups = new Set(processes.map((row) => row.group));
        this.commit(
          this.held.filter((held) => {
            if (!groups.has(held.pid)) return false;
            const leader = byPid.get(held.pid);
            // A reused group identifier is not the group this caller registered.
            return !leader || leader.group !== held.pid || leader.started === held.started;
          }),
        );
        // A waiter whose caller ended would start a run nobody reads (INF-2570).
        const orphaned = this.held.filter((held) => this.callerGone(held, byPid));
        for (const held of orphaned) this.left.add(`${held.pid}:${held.started}`);
        if (orphaned.length)
          this.commit(
            this.held.filter((held) => !orphaned.includes(held)),
            "its caller ended",
          );
        for (const key of this.left)
          if (!byPid.has(Number(key.slice(0, key.indexOf(":"))))) this.left.delete(key);
        this.exited = new Set(
          this.held.filter((held) => this.programExited(held, byPid)).map((held) => held.id),
        );
      }
      if (cpuWindow && observation.status === "sampled") {
        for (const held of this.held) {
          const verifiedAt = this.verified.get(held.id);
          if (held.launch && verifiedAt !== undefined && cpuWindow.start > verifiedAt)
            this.covered.add(held.id);
        }
      }
      this.measuredMemory.clear();
      if (processes && observation.status === "sampled") {
        const owners = new Map(
          processes.flatMap((row) => {
            const held = this.held.find((held) => held.pid === row.group);
            return held ? [[row.pid, held.id] as const] : [];
          }),
        );
        // Resident memory is a reading of this table alone; processor use needs a window.
        for (const row of processes) {
          const id = owners.get(row.pid);
          if (id)
            this.measuredMemory.set(id, (this.measuredMemory.get(id) ?? 0) + row.residentBytes);
        }
      }
      for (const held of this.held) {
        if (!this.exited.has(held.id) || this.journaledExits.has(held.id)) continue;
        this.journaledExits.add(held.id);
        this.journal({
          event: "exited",
          taskId: held.taskId,
          hold: held.id,
          demand: held.demand,
          residentBytes: this.measuredMemory.get(held.id) ?? 0,
          why: "its program exited; the reservation drops to what its processes use",
        });
      }
      this.admit();
    } catch (error) {
      // A failed declaration store must not turn the independent Use reading unknown.
      this.failure = error;
    }
  }

  /** The home may refresh recorded overrides without collecting another resource sample. */
  reconsider(): void {
    if (this.stopped || this.failure) return;
    try {
      this.admit();
    } catch (error) {
      this.failure = error;
    }
  }

  /** Live declared command groups, including ones awaiting admission; no resource sampling. */
  taskIds(): string[] {
    return [...new Set(this.held.map((held) => held.taskId))];
  }

  snapshot(): LoadSnapshot {
    this.check();
    let waiting = 0;
    const unavailable = this.capacity();
    const pressure = this.observation()?.value.memory.memoryPressure;
    return {
      runs: this.held.map((held): LoadRun => {
        if (held.state === "running") {
          return {
            id: held.id,
            taskId: held.taskId,
            demand: held.demand,
            state: held.state,
            ahead: 0,
          };
        }
        const ahead = waiting++;
        const reason =
          pressure === "warning" || pressure === "critical"
            ? "pressure"
            : unavailable === null
              ? "unavailable"
              : waiting > 1
                ? "line"
                : "capacity";
        return {
          id: held.id,
          taskId: held.taskId,
          demand: held.demand,
          state: held.state,
          ahead,
          reason,
          ...(reason === "capacity" && this.room?.id === held.id ? { free: this.room.free } : {}),
        };
      }),
    };
  }

  /** Stop observing only. Existing groups and their saved holds are untouched. */
  dispose(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const release of this.roots.values()) release();
    this.roots.clear();
  }

  private async claim(taskId: string, input: LoadClaim): Promise<LoadClaimAnswer> {
    try {
      return await this.claimOnce(taskId, input);
    } catch (error) {
      this.journal({
        event: "refuse",
        taskId,
        ...(loadDemandSchema.safeParse(input?.demand).success ? { demand: input.demand } : {}),
        why: (error as Error).message,
      });
      throw error;
    }
  }

  private async claimOnce(taskId: string, input: LoadClaim): Promise<LoadClaimAnswer> {
    this.check();
    const demand = loadDemandSchema.parse(input.demand);
    if (!Number.isSafeInteger(input.pid) || input.pid <= 0)
      throw new Error("The run has no process identity.");
    const rows = await (this.options.processes ?? readProcesses)();
    this.check();
    const row = rows?.find((row) => row.pid === input.pid);
    if (!row) {
      // An unavailable table does not prove that a previously verified caller
      // ended. Keep its place, but never hand out a saved admission without a
      // fresh identity check, even if observe() admitted it during this read.
      const held =
        rows === null && !input.parent
          ? this.held.find(
              (held) =>
                held.taskId === taskId &&
                held.pid === input.pid &&
                held.demand.cpu === demand.cpu &&
                held.demand.memoryBytes === demand.memoryBytes,
            )
          : undefined;
      if (held) return { ...this.runOf(held.id), state: "waiting", reason: "unavailable" };
      // An unreadable table proves nothing about a new caller either: it asks
      // again on the next reading, and nothing is held or started until a
      // readable table checks its identity (INF-3192).
      if (rows === null) {
        this.journal({ event: "unread", taskId, demand });
        return { state: "waiting", ahead: 0, reason: "unavailable" };
      }
      throw new Error("The run's process is not running; nothing started.");
    }
    if (input.parent) {
      const parent = this.held.find((held) => held.id === input.parent && held.taskId === taskId);
      if (parent?.state !== "running" || row.group !== parent.pid)
        throw new Error("The inherited hold does not belong to this running process group.");
      if (demand.cpu > parent.demand.cpu || demand.memoryBytes > parent.demand.memoryBytes)
        throw new Error(
          "The outer run declared less than this run needs. Declare the whole run's needs on the outer command.",
        );
      return this.runOf(parent.id);
    }
    const most = this.most();
    if (most !== undefined && demand.memoryBytes > most && !this.options.overridden?.(taskId))
      throw new Error(
        `This run declares ${Math.ceil(demand.memoryBytes / MIB)} MiB of memory, more than this computer can ever give one run. Declare at most ${Math.floor(most / MIB)} MiB, its installed memory less the margin; nothing started.`,
      );
    if (row.group !== row.pid && this.jobs()?.lead(row.pid, row.started) === row.started)
      row.group = row.pid;
    if (row.group !== row.pid)
      throw new Error(
        "The run must ask from its own process group through infinitary-load-axi run. Run the command again through it; on Windows a run that asked that way may have taken a number whose earlier group is still running, and its next start gets another.",
      );
    if (this.left.has(`${row.pid}:${row.started}`)) throw new Error(CALLER_GONE);
    const byPid = new Map(rows?.map((row) => [row.pid, row]));
    // Only a leader with no parent the system can name takes the caller the wrapper names.
    const named =
      row.parent === 0 && Number.isSafeInteger(input.caller) && (input.caller ?? 0) > 0
        ? byPid.get(input.caller ?? 0)
        : undefined;
    const parentRow = row.parent === ADOPTER_PID ? undefined : (byPid.get(row.parent) ?? named);
    const caller =
      parentRow && !parentRow.exited
        ? { pid: parentRow.pid, started: parentRow.started }
        : undefined;
    const existing = this.held.find((held) => held.pid === row.pid && held.started === row.started);
    if (existing) {
      if (
        existing.taskId !== taskId ||
        existing.demand.cpu !== demand.cpu ||
        existing.demand.memoryBytes !== demand.memoryBytes
      )
        throw new Error("This process group already declared a different hold.");
      if (this.callerGone(existing, byPid)) {
        this.left.add(`${row.pid}:${row.started}`);
        this.commit(
          this.held.filter((held) => held.id !== existing.id),
          "its caller ended",
        );
        throw new Error(CALLER_GONE);
      }
      // A hold saved before callers were recorded learns its caller from a living wrapper.
      if (existing.state === "waiting" && !existing.caller && caller)
        this.commit(
          this.held.map((held) => (held.id === existing.id ? { ...held, caller } : held)),
        );
    } else {
      const held: Held = {
        id: randomUUID(),
        taskId,
        demand,
        pid: row.pid,
        started: row.started,
        state: "waiting",
        ...(caller ? { caller } : {}),
      };
      this.commit([...this.held.filter((held) => held.pid !== row.pid), held]);
      this.journal({
        event: "wait",
        taskId,
        hold: held.id,
        demand,
        ahead: this.held.filter((other) => other.id !== held.id && other.state === "waiting")
          .length,
      });
    }
    this.admit();
    this.watch();
    const held = this.held.find((held) => held.taskId === taskId && held.pid === row.pid);
    if (!held) throw new Error("The requesting process group has ended.");
    return this.runOf(held.id);
  }

  private async receipt(
    taskId: string,
    input: LoadReceipt,
    permitted?: () => boolean,
  ): Promise<void> {
    this.check();
    if (
      !input ||
      !Number.isSafeInteger(input.pid) ||
      !Number.isSafeInteger(input.payload) ||
      input.pid <= 0 ||
      input.payload <= 0 ||
      // Only a line whose groups are Windows jobs stamps a birth itself.
      (input.started === undefined
        ? !this.jobs()
        : typeof input.started !== "string" || !input.started)
    )
      throw new Error("The launch has no process identity.");
    const rows = await (this.options.processes ?? readProcesses)();
    const utc = input.started?.startsWith("utc:") === true;
    const payload = utc
      ? await readReceiptProcess(input.payload)
      : rows?.find((row) => row.pid === input.payload);
    this.check();
    if (permitted && !permitted()) throw new Error("This task no longer has a load command.");
    const held = this.held.find((held) => held.id === input.hold && held.taskId === taskId);
    // An unreadable table proves nothing about a running hold's launch. A
    // refusal would end the worker's asking and leave a healthy run charged
    // for its whole life, so this one outcome may repeat (INF-3192's rule for claims).
    if (rows === null && held?.state === "running" && held.pid === input.pid)
      throw new LoadReceiptUnreadError(
        "This computer's programs could not be read; the launch is not verified yet.",
      );
    const leader = rows?.find((row) => row.pid === input.pid);
    const started = input.started ?? payload?.started;
    if (
      held?.state !== "running" ||
      held.pid !== input.pid ||
      leader?.group !== held.pid ||
      leader.started !== held.started ||
      payload?.group !== held.pid ||
      !started ||
      (utc ? `utc:${payload.started}` : payload.started) !== started ||
      payload.pid === held.pid ||
      payload.exited === true ||
      leader.exited === true
    )
      throw new Error("The launch does not belong to this living admitted group.");
    if (held.launch) {
      if (held.launch.pid !== input.payload || held.launch.started !== started)
        throw new Error("This hold already verified a different launch.");
      return;
    }
    // Save before acknowledgment. A lost answer can repeat this exact receipt,
    // never the payload creation. The store contains identities only.
    this.commit(
      this.held.map((row) =>
        row.id === held.id ? { ...row, launch: { pid: input.payload, started } } : row,
      ),
    );
    this.verified.set(held.id, this.now());
  }

  private runOf(id: string): LoadRun {
    const run = this.snapshot().runs.find((run) => run.id === id);
    if (!run) throw new Error("The requesting process group has ended.");
    return run;
  }

  private observation():
    | { value: Extract<ResourceObservation, { status: "sampled" }>; ageMs: number }
    | undefined {
    if (!this.latest) return undefined;
    const age = this.now() - this.latest.at;
    const { observation } = this.latest;
    return age >= 0 && age <= RESOURCE_MAX_AGE_MS && observation.status === "sampled"
      ? { value: observation, ageMs: age }
      : undefined;
  }

  /** The most memory one run can ever get here: installed less the margin, from a fresh reading. */
  private most(): number | undefined {
    const total = this.observation()?.value.memory.totalBytes;
    return total === undefined
      ? undefined
      : Math.max(0, Math.floor(total - memoryMarginBytes(total)));
  }

  private capacity(): LoadDemand | null {
    const current = this.observation();
    if (!current) return null;
    const { value: observation, ageMs } = current;
    if (
      observation.memory.memoryPressure === "warning" ||
      observation.memory.memoryPressure === "critical"
    )
      return null;
    return resourceCapacity({
      status: "fresh",
      observation,
      ageMs,
      memoryUsedBytes: memoryUsedBytes(observation.memory),
    });
  }

  private admit(): void {
    this.check();
    const most = this.most();
    if (most !== undefined) {
      // Saved before refusals existed, or claimed without a fresh reading: it can never start.
      const never = this.held.filter(
        (held) =>
          held.state === "waiting" &&
          held.demand.memoryBytes > most &&
          !this.options.overridden?.(held.taskId),
      );
      if (never.length)
        this.commit(
          this.held.filter((held) => !never.includes(held)),
          // i18n-exempt: a journal line for reading later, never shown in the window
          "it declares more memory than this computer can ever give one run",
        );
    }
    this.markFront();
    const remaining = this.capacity();
    let running = 0;
    if (remaining) {
      for (const held of this.held) {
        if (held.state !== "running") continue;
        // Its program has exited: what its surviving processes use is already in
        // the reading, so nothing more is reserved and it no longer counts as admitted.
        if (this.exited.has(held.id)) continue;
        running++;
        // Aggregate idle already excludes all real use. Only starts not yet
        // covered by a complete post-verification interval retain a CPU charge.
        if (!this.covered.has(held.id)) remaining.cpu -= held.demand.cpu;
        // The memory reading already lacks a running group's resident memory: add
        // it back, then reserve the larger of declared and resident once (INF-2165).
        // An unmeasured group reserves its declaration with nothing added back.
        const resident = this.measuredMemory.get(held.id) ?? 0;
        remaining.memoryBytes += resident - Math.max(held.demand.memoryBytes, resident);
      }
    }
    // With nothing running, the front run's memory ask is judged against installed
    // memory less the same margin, not today's free reading (INF-2165 direction A).
    // Pressure and a fresh reading still gate it through capacity().
    const installed = most ?? 0;
    const passing = this.front !== undefined && this.now() - this.front.since < PASSING_WINDOW_MS;
    let front: string | undefined;
    let blocked: string | undefined;
    let room: { id: string; free: LoadDemand } | undefined;
    const entries: Omit<LoadJournalEntry, "at">[] = [];
    const pressure = this.observation()?.value.memory.memoryPressure;
    const compared = (): LoadDemand | null =>
      remaining === null
        ? null
        : running === 0
          ? { cpu: round(remaining.cpu), memoryBytes: installed }
          : { cpu: round(remaining.cpu), memoryBytes: Math.floor(remaining.memoryBytes) };
    const next = this.held.map((held): Held => {
      if (held.state === "running") return held;
      const overridden = this.options.overridden?.(held.taskId) === true;
      const measured =
        remaining !== null &&
        running > 0 &&
        held.demand.cpu <= remaining.cpu &&
        held.demand.memoryBytes <= remaining.memoryBytes;
      // Behind a blocked front only measured room counts: the lone-run rule is the front's.
      const fits =
        remaining !== null &&
        (front !== undefined
          ? passing && measured
          : running === 0
            ? held.demand.memoryBytes <= installed
            : measured);
      const entry = {
        taskId: held.taskId,
        hold: held.id,
        demand: held.demand,
        capacity: compared(),
        ...(pressure ? { pressure } : {}),
        running,
      };
      if (!overridden && !fits) {
        if (front === undefined) {
          front = held.id;
          // Uncovered startup charges can push the room below zero; none is free then.
          if (entry.capacity)
            room = {
              id: held.id,
              free: {
                cpu: Math.max(0, entry.capacity.cpu),
                memoryBytes: Math.max(0, entry.capacity.memoryBytes),
              },
            };
          // One line per new front or new reason, not one per two-second pass.
          blocked = `${held.id}:${entry.capacity === null ? (pressure ?? "unread") : "capacity"}`;
          if (blocked !== this.blocked) entries.push({ ...entry, event: "blocked" });
        }
        return held;
      }
      entries.push({
        ...entry,
        event: "admit",
        basis: !fits ? "override" : running === 0 ? "installed" : "capacity",
        ...(fits && front !== undefined ? { passed: front } : {}),
      });
      if (remaining) {
        remaining.cpu -= held.demand.cpu;
        remaining.memoryBytes -= held.demand.memoryBytes;
      }
      running++;
      return { ...held, state: "running" };
    });
    this.commit(next);
    this.markFront();
    this.blocked = blocked;
    this.room = room;
    for (const entry of entries) this.journal(entry);
  }

  /** A run that became first in line starts its passing window now. */
  private markFront(): void {
    const first = this.held.find((held) => held.state === "waiting");
    if (first?.id === this.front?.id) return;
    this.front = first ? { id: first.id, since: this.now() } : undefined;
  }

  private commit(next: Held[], why = "its process group ended"): void {
    if (JSON.stringify(next) === JSON.stringify(this.held)) return;
    // Persist before a caller can receive a grant. A failed write grants nothing.
    mkdirSync(dirname(this.options.stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.options.stateFile}.new`;
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    renameSync(temporary, this.options.stateFile);
    for (const held of this.held) {
      if (next.some((row) => row.id === held.id)) continue;
      this.roots.get(held.id)?.();
      this.roots.delete(held.id);
      this.verified.delete(held.id);
      this.covered.delete(held.id);
      this.exited.delete(held.id);
      this.journaledExits.delete(held.id);
      this.journal({
        event: "release",
        taskId: held.taskId,
        hold: held.id,
        demand: held.demand,
        why: held.state === "waiting" ? `it left the line: ${why}` : why,
      });
    }
    this.held = next;
    for (const held of next) if (!this.roots.has(held.id)) this.track(held);
    this.options.changed?.();
  }

  /**
   * A waiter only: the recorded caller ended, or the wrapper now has another
   * parent. A leader with no parent the system can name (Windows) keeps the
   * caller its wrapper named, and leaves when that program ends.
   */
  private callerGone(held: Held, byPid: Map<number, ProcessReading>): boolean {
    if (held.state !== "waiting" || !held.caller) return false;
    const leader = byPid.get(held.pid);
    if (!leader || leader.started !== held.started) return false;
    const caller = byPid.get(held.caller.pid);
    return (
      (leader.parent !== 0 && leader.parent !== held.caller.pid) ||
      !caller ||
      caller.started !== held.caller.started ||
      caller.exited === true
    );
  }

  /** The admitted program ran in the group leader; the group outliving it is leftovers. */
  private programExited(held: Held, byPid: Map<number, ProcessReading>): boolean {
    if (held.state !== "running") return false;
    const leader = byPid.get(held.pid);
    return (
      !leader ||
      leader.group !== held.pid ||
      leader.started !== held.started ||
      leader.exited === true
    );
  }

  /** Diagnostic only: a failed journal write never changes admission. */
  private journal(entry: Omit<LoadJournalEntry, "at">): void {
    try {
      const file = this.options.journalFile ?? join(dirname(this.options.stateFile), JOURNAL_FILE);
      const at = new Date((this.options.wallClock ?? Date.now)()).toISOString();
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      appendFileSync(file, `${JSON.stringify({ at, ...entry })}\n`, { mode: 0o600 });
      if (statSync(file).size <= JOURNAL_MAX_BYTES) return;
      const text = readFileSync(file);
      const tail = text.subarray(text.length - JOURNAL_MAX_BYTES / 2);
      const temporary = `${file}.new`;
      writeFileSync(temporary, tail.subarray(tail.indexOf(10) + 1), { mode: 0o600 });
      renameSync(temporary, file);
    } catch {
      // The journal is a record for reading later; the line's saved holds remain the truth.
    }
  }

  private track(held: Held): void {
    this.jobs()?.adopt(held.pid, held.started);
    this.roots.set(held.id, processRoots.addGroup(held.pid, held.taskId, held.started));
  }

  private jobs(): LoadJobs | undefined {
    return this.options.jobs ?? (hostPlatform() === "win32" ? windowsJobs : undefined);
  }

  private watch(): void {
    if (this.timer || this.stopped || !this.active) return;
    this.timer = setInterval(() => {
      try {
        const exists = this.options.groupExists ?? loadGroupExists;
        this.commit(this.held.filter((held) => exists(held.pid)));
        this.admit();
        if (!this.active && this.timer) {
          clearInterval(this.timer);
          this.timer = undefined;
        }
      } catch (error) {
        this.failure = error;
      }
    }, RESOURCE_REFRESH_MS);
    this.timer.unref();
  }

  private check(): void {
    if (this.stopped) throw new Error("The computer's load line is closed; nothing started.");
    if (this.failure)
      throw new Error("The computer's load holds could not be kept; nothing started.");
  }

  private now(): number {
    return (this.options.now ?? (() => performance.now()))();
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function loadWaitWords(): string {
  return softHoldWords("load-line", "crewmate");
}
