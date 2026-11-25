import type { CutOff } from "@shared/authFailure";
import type { CrewSpeed, SpeedSelection } from "@shared/crewSpeed";
import type { FmEvent } from "@shared/events";
import type { Reasoning } from "@shared/reasoning";
import type { SourceIdentity } from "@shared/selfSource";
import type { ToolObservation } from "@shared/toolCompletion";
import type { RunbookSkillFiles } from "../../shared/runbooks";
import type { ServedInstructions, ServedState } from "../orchestrator/seat";
import type { ModelRuntime } from "../pi/types";
import type { BoundTool, CrewmateToolDelegate } from "./tools";

/**
 * One model session for three roles: the backend-neutral contract the
 * crewmate, the Firstmate seat and the classifier each open a session
 * through, the role being nothing but the options it passes (its preset:
 * `crewmateSessionSpec`, `seatSessionSpec`, `questionSessionSpec`). Pi and
 * Claude are its two implementations, each behind its own seam
 * (`src/core/pi/`, `src/core/claude/`); nothing here imports a backend's
 * runtime. An account becomes a binding in one place (`binding.ts`).
 *
 * Every session is opened on a machine (decision D-11): `machine` rides
 * every spec and every factory refuses a machine it cannot reach. This Mac
 * is `LOCAL_MACHINE_ID`; a crewmate's conversation held on a computer that
 * runs work opens on that computer's factories (src/core/placed/).
 */

/** This Mac, where every session runs unless its task names another computer. */
export const LOCAL_MACHINE_ID = "local";

export type SessionBackend = "pi" | "claude";

/**
 * What a backend can honestly deliver on the control plane. Steer is the
 * axis that splits the field: the Firstmate role requires native mid-turn
 * steer (steer-only turns, captain rev-5); crewmates tolerate an explicit
 * followup-queue emulation (deliver as the next turn, surfaced honestly).
 * `steer: "none"` is deliberately not representable - it is never built.
 * A role states what it needs on its spec (`needs`), and a factory refuses
 * a spec its profile does not admit (`admits`).
 */
export type ControlProfile = {
  steer: "native" | "followup-queue";
  interruptGranularity: "turn" | "process";
  /** Whether the backend pushes plan-window quota events on its own. */
  quotaEvents: boolean;
  /**
   * Where this backend's background work runs, and so whether the host can
   * ever prove a crewmate has STOPPED (S7c, R4.8 question 2). `host`: the
   * backend's shell is the host's own tool, so a background job sits in the
   * job registry and its exit arrives as a lane row - with the registry,
   * the lane, the runtime state and a pending settle all empty, nothing
   * will ever start the next turn. `client`: the backend runs its own
   * background work (Claude's continuations), so the host sees
   * activity but never a provable stop, and the whose-turn rule answers
   * "cannot tell" and lets the stall clock decide.
   */
  backgroundWork: "host" | "client";
  /**
   * How this backend says why a turn failed (docs/quota.md "Typed
   * cut-offs"). `typed`: every failure is classified from the provider's
   * own fields, so a `turn_failed` carries its `cutOff` or is an ordinary
   * failure, and the host never reads the error's words. `text`: the
   * backend has only prose, which the one prose classifier
   * (`isAuthFailureMessage`) reads.
   */
  failureSignals: "typed" | "text";
};

/**
 * Which backend serves a session, and on what. A Pi binding carries the
 * runtime its account (or the base runtime) resolved to; a Claude binding
 * names the account whose login serves it, because the Claude client holds
 * its own sign-in and the app never builds a runtime for it. `local` marks
 * the dev local seat's runtime (bounded compaction, terminal failures).
 */
export type SessionBinding =
  | { backend: "pi"; accountId?: string; runtime: ModelRuntime; local?: boolean }
  | { backend: "claude"; accountId: string };

/** An image riding a prompt or steer (base64, no data: prefix). */
export type SessionImage = { mimeType: string; data: string };

export type ThinkingLevel = "low" | "medium" | "high" | "xhigh";

/** One offered rung below the level the model would actually serve, never below its floor. */
export function quickThinkingLevel<T extends string>(served: T, offered: readonly T[]): T {
  const index = offered.indexOf(served);
  return (index > 0 ? offered[index - 1] : undefined) ?? served;
}

/**
 * The level a coding session opens at, out of `offered` (weakest first, in
 * `order`'s terms): the requested level, or the nearest below it the model
 * offers (its weakest when none is), then one offered rung lower for Quick
 * care. `lower` says which of the two put it below the request (FI3-439);
 * undefined when the model offers no level at all.
 */
export function openingReasoning<T extends string>(
  order: readonly T[],
  offered: readonly T[],
  requested: T,
  quick: boolean,
): { level: T; lower?: "quick" | "capped" } | undefined {
  const at = order.indexOf(requested);
  const served = [...offered].reverse().find((level) => order.indexOf(level) <= at) ?? offered[0];
  if (served === undefined) return undefined;
  const level = quick ? quickThinkingLevel(served, offered) : served;
  if (level !== served) return { level, lower: "quick" };
  return order.indexOf(level) < at ? { level, lower: "capped" } : { level };
}

/**
 * Where a rolling session resumes from. Each backend keeps its own: the two
 * transcript formats do not carry across.
 */
export type SessionResume =
  | { backend: "pi"; sessionFile: string }
  | { backend: "claude"; sessionId: string };

/**
 * A rolling session that started over under a new id at an attachment
 * point instead of resuming: the id it would have resumed, and which part
 * of the prompt array it serves had changed since that session started.
 * `prompt` is the prompt as the client recorded it at the start: the
 * system prompt and the tools it had then, as they were described then.
 */
export type SessionRenewal = { from: string; changed: readonly ("prompt" | "instructions")[] };

/**
 * The contract fingerprint a role stamps on its record. `tools`, when the
 * role fingerprints each tool too, names each tool's own sha: a resumed
 * session whose client serves the tools it recorded at its start then
 * starts over when a tool it had is described differently now, or a tool
 * came or went.
 */
export type ContractStamp = {
  version: string;
  promptSha: string;
  toolsSha: string;
  tools?: Readonly<Record<string, string>>;
};

/**
 * A rolling session takes many prompts and steers and keeps an app-owned
 * durable record in `dir`; a one-shot answers one prompt, takes no steer
 * and writes nothing.
 */
export type SessionShape =
  | {
      turns: "rolling";
      record: {
        dir: string;
        resume?: SessionResume;
        stamp?: ContractStamp;
        /** Only reattach to the conversation held on a computer that runs work (`CrewmateSpec.reattach`). */
        reattach?: boolean;
        /** A new conversation, never the one held on a computer that runs work (`CrewmateSpec.fresh`). */
        fresh?: boolean;
      };
    }
  | { turns: "one" };

/**
 * Time bounds (`watched`) are enforced by one neutral watcher on the host's
 * ticker over the session's own events, both backends identically; request
 * bounds are applied by each backend in its own terms.
 */
export type SessionBounds = {
  watched?: {
    /** One uninterrupted inference: from a request start or the last tool end. */
    requestTimeoutMs?: number;
    /** One prompt, whole. */
    turnTimeoutMs?: number;
  };
  request?: {
    maxOutputTokens?: number;
    /** Model round trips per prompt: Claude's `maxTurns`; Pi counts its own turn ends. */
    maxModelTurns?: number;
    /** Provider-side retries: Pi's knob; the Claude client keeps its own. */
    retries?: number;
  };
};

/** Variables, and folders to put first on the search path, that a session's shell carries. */
export type TaskShell = { env: Readonly<Record<string, string>>; path: readonly string[] };

/**
 * `maxContextTokens` is a ceiling; `belowPriceStep` summarizes before a
 * request crosses the model's first price step; the lower of the two wins.
 * Neither leaves the backend's own trigger (`summaryCompaction`).
 */
export type SessionCompaction = { maxContextTokens?: number; belowPriceStep?: true };

export type SessionSpec = {
  homeSource?: SourceIdentity;
  /**
   * The machine the session runs on (D-11): "local" for this Mac, or a
   * computer that runs work by its device id, which only that computer's
   * factories serve.
   */
  machine: string;
  /** The id events carry (a task id, or "firstmate"), and host bash's owner. */
  owner: string;
  cwd: string;
  binding: SessionBinding;
  /** Absent defers to the backend's default. */
  model?: { provider: string; id: string };
  /** Opt-in request policy. Missing means Standard, including supporting calls. */
  speed?: {
    requested: (model: { provider: string; id: string }) => CrewSpeed | Promise<CrewSpeed>;
    record: (model: { provider: string; id: string }, selection: SpeedSelection) => void;
  };
  thinking: { level: ThinkingLevel | "off"; perTurn?: boolean; quick?: boolean };
  /** The base prompt the role built, and the captain-owned text served after it. */
  instructions: { base: string; served?: ServedInstructions };
  /** Beyond the app's tools: nothing, or the backend's own coding set. */
  builtins: "none" | "coding";
  /**
   * With the coding set, only its read-only tools, each refusing a path
   * outside `cwd`: no shell, no file change, no web and no subagent (an
   * unsafe data reader, docs/agents-reach.md). Only this computer's factories
   * build it; a computer that runs work refuses it.
   */
  fenced?: true;
  /** Opt-in to personal instructions and skills: this user's own, or `personalRoot`'s. */
  personalResources?: boolean;
  /**
   * Read in place of this user's home folder: the home's set as a computer
   * that runs work kept it (docs/personal-resources.md, "One set, kept on
   * each computer").
   */
  personalRoot?: string;
  runbookSkills?: RunbookSkillFiles[];
  tools: readonly BoundTool[];
  shape: SessionShape;
  bounds?: SessionBounds;
  /**
   * App-owned automatic compaction, or a reader of the current rule
   * (`compactionNow`); smaller model budgets still win.
   */
  compaction?: SessionCompaction | (() => SessionCompaction);
  needs?: Partial<Pick<ControlProfile, "steer">>;
  /**
   * What the session's shell carries beyond the host's environment: a
   * task's commands (docs/axi-commands.md). Every command the session runs -
   * Pi's own shell, the Claude client and whatever it runs - gets it.
   */
  shell?: TaskShell;
  /** The role has declared heavy runs on its execution computer. */
  load?: boolean;
  /** The role's shell keeps its task's stops on its execution computer (docs/leftover-programs.md). */
  stops?: boolean;
  /**
   * The host's callbacks the role's crewmate tools were bound to. A factory
   * whose conversation runs on another computer (src/core/placed/) binds the
   * same tools there and answers each callback they ask back with these; a
   * factory here serves `tools` as bound and never reads them.
   */
  callbacks?: CrewmateToolDelegate;
};

/** A background task a backend's own client runs (`background_work_changed`). */
export type ClientBackgroundTask = { id: string; description: string };

/** A running background job out of the host's sight, as its runner names it (`background_work_changed`). */
export type BackgroundJobName = { id: string; command: string };

/**
 * What a session tells its owner. Only the `FmEvent`s are ever broadcast;
 * the rest stay with the owner.
 */
export type SessionEvent =
  /** The backend replaced older context with a summary. Owner-only, never a feed event. */
  | {
      type: "context_compacted";
      /**
       * The backend makes another model request in this turn after the fold
       * (Pi's overflow recovery, or its threshold fold before the next
       * response), so the turn goes on. Absent on a fold after the turn's
       * last request, which goes on only for input already queued.
       * A backend that cannot tell leaves it absent and says `unknown`.
       */
      turn?: "goes-on" | "unknown";
    }
  | {
      type: "background_work_changed";
      count: number | undefined;
      /**
       * The background tasks the backend's own client runs now and ends
       * with it, when it names them (a Claude session's): each by the id
       * its model was given and what the model said it is. Whoever holds
       * the client keeps them, so the crewmate is told of each the client's
       * end or a stop cuts off (`CrewSupervisor`, `SessionHost`).
       */
      tasks?: readonly ClientBackgroundTask[];
      /**
       * The longest-running job of that work, when whoever runs it names
       * it (a computer that runs work, for its Pi shell's jobs): by its id
       * and the command it runs, so the host's words about the job name it.
       */
      job?: BackgroundJobName;
    }
  | FmEvent
  | ToolObservation
  /** One model turn closed, with its closing words when it said any. */
  | { type: "turn_closed"; text?: string }
  /** A model request began: the watched request clock starts over. */
  | { type: "request_started" }
  /** A prompt or steer entered the model context, not merely the send queue. Owner-only. */
  | { type: "input_read"; textSha256: string }
  /**
   * The backend resumed work on its own (a Claude background continuation),
   * or a conversation on another computer runs a turn this owner did not
   * start here (src/core/placed/): `order` is what that turn delivers, the
   * id the owner gave its prompt.
   */
  | { type: "continuation_started"; order?: string }
  /**
   * That work ended. `unheard`: its end never arrived, and the live session
   * that ran it says it no longer works, so its owner ends it as interrupted
   * (INF-2332).
   */
  | { type: "continuation_ended"; error?: string; cutOff?: CutOff; unheard?: true }
  /**
   * The model answering for the conversation, as the backend reports it:
   * its first report and every change after it. `fallback` says the backend
   * moved the conversation off `from` on its own (Claude Code's refusal
   * fallback, docs/claude-client.md), with the category the provider gave.
   */
  | {
      type: "model_served";
      model: { provider: string; id: string };
      fallback?: { from: { provider: string; id: string }; category?: string };
    };

/** A live session. Every member is required, so an owner never asks what a session can do. */
export type ModelSession = {
  readonly sessionId: string;
  readonly controlProfile: ControlProfile;
  /** What the owner persists to reattach; undefined for a one-shot. */
  resume(): SessionResume | undefined;
  /** The app-owned transcript's path, undefined for a one-shot. */
  recordPath(): string | undefined;
  /** A refresh finishes discovering and copying the client-owned tail before answering. */
  recordPath(options: { refresh?: boolean }): string | undefined | Promise<string | undefined>;
  modelRef(): { provider: string; id: string } | undefined;
  modelLabel(): string | undefined;
  isStreaming(): boolean;
  subscribe(listener: (event: SessionEvent) => void): () => void;
  /**
   * `order` is the durable id of what this prompt delivers - its owner's
   * lane rows - so a conversation held on another computer starts it once
   * however often it is asked (src/core/placed/); a session here ignores it.
   */
  prompt(text: string, images?: SessionImage[], order?: string): Promise<void>;
  /** Into the running turn at its next step; a one-shot rejects. `order` as for `prompt`. */
  steer(text: string, images?: SessionImage[], order?: string): Promise<void>;
  /**
   * The app's own input that must reach the turn's next request, ahead of
   * the steers still queued, which keep their order: the first mate's
   * recovery after a fold. A session without it takes a steer.
   */
  steerFirst?(text: string, images?: SessionImage[]): Promise<void>;
  /** Steers accepted that no turn took in, taken idle at a turn's end. */
  takeUndeliveredSteers(): string[];
  /** Honored when the spec asked for `thinking.perTurn`. */
  setThinkingLevel(level: ThinkingLevel): void;
  /**
   * The reasoning a coding session opened at on the spec's model, as the
   * backend served it (FI3-439); undefined for a one-shot and for a session
   * that named no model, which keeps whatever its record names.
   */
  reasoning(): Reasoning | undefined;
  /** Served at the next idle boundary and stamped in the record, never mid-turn. */
  serveInstructions(instructions: ServedInstructions): void;
  /**
   * The session this one started over from, taken once: set when an open
   * or `serveInstructions` found the prompt array changed on a backend that
   * cannot serve a changed one on resume (Claude); undefined otherwise.
   */
  takeRenewal(): SessionRenewal | undefined;
  servedState(): ServedState | undefined;
  /** Cuts the running turn; with a failure, the turn reports `turn_failed` with it. */
  abort(failure?: string): Promise<void>;
  /**
   * Stops the running turn where nothing it did is lost, for an update
   * (docs/alpha.md, "Saving work before an update"): once asked, no tool call starts and none is
   * handed to the client, a call already running finishes and its result
   * is kept, and only then is the turn cut; a steer no request took stays
   * the owner's (`takeUndeliveredSteers`). Resolves `stopped` once the turn
   * has ended, at once when none runs. Aborting `signal` while it waits
   * withdraws it: the turn carries on as if never asked, and it resolves
   * `withdrawn`. A session that cannot hold its tools leaves this out and
   * its owner cuts the turn with `abort`.
   */
  stopSafely?(options?: SafeStopOptions): Promise<SafeStopOutcome>;
  /** Lets go of the live client at an idle boundary; the next prompt reattaches. */
  detach(): Promise<void>;
  dispose(): void;
  /** Resolves once the backend's client is gone and its store is free. */
  closed(): Promise<void>;
};

export type RunningCall = { callId: string; toolName: string };

export type SafeStopOptions = {
  signal?: AbortSignal;
  /** Each change in the calls the stop still waits on; `[]` once none runs. */
  waiting?: (calls: readonly RunningCall[]) => void;
};

export type SafeStopOutcome = "stopped" | "withdrawn";

/**
 * What a call the safe stop refused says to the model that asked for it,
 * read when its turn carries on (every backend's gate serves these words).
 */
export const SAFE_STOP_BLOCKED_TEXT =
  "Infinitary stopped this turn at a safe point before this call started, so it did not run. Run it again if it is still needed.";

/**
 * A prompt a safe stop ended before its model took it: nothing of it
 * reached the conversation, so its owner sends its input again.
 */
export class StoppedBeforeStartError extends Error {
  constructor() {
    super("Infinitary stopped this turn to update before it started.");
    this.name = "StoppedBeforeStartError";
  }
}

export type SessionFactory = {
  readonly backend: SessionBackend;
  readonly controlProfile: ControlProfile;
  open(spec: SessionSpec): Promise<ModelSession>;
};

export type SessionFactories = { pi: SessionFactory; claude?: SessionFactory };

/** Generic admission: a role's needs against a backend's profile, with no role names. */
export function admits(profile: ControlProfile, needs: SessionSpec["needs"]): boolean {
  return !needs?.steer || needs.steer === profile.steer;
}
