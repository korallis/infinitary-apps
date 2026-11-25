import { join } from "node:path";
import { stageRunbookSkills } from "../runbooks/runbooks";
import { clampThinkingLevel } from "./reasoning";

export { clampThinkingLevel } from "./reasoning";

import { createHash } from "node:crypto";
import {
  type AssistantMessage,
  getCurrentSystemPrompt,
  getCurrentTools,
  isContextOverflow,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DEFAULT_COMPACTION_SETTINGS,
  type EditToolInput,
  estimateTokens,
  type FindToolInput,
  type GrepToolInput,
  type LsToolInput,
  type ReadToolInput,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
  type WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import type { CrewSpeed } from "@shared/crewSpeed";
import { isCustomApiProvider } from "@shared/customApi";
import { COPILOT_PROVIDER_ID } from "@shared/providers";
import type { Reasoning } from "@shared/reasoning";
import type { BashOutcome } from "../jobs/jobManager";
import type { ServedInstructions, ServedMessage, ServedState } from "../orchestrator/seat";
import { modelTurnsErrorMessage } from "../session/bounds";
import { compactionNow } from "../session/compaction";
import { personalPluginSource, personalResources } from "../session/personalResources";
import { projectSkillFolders } from "../session/projectResources";
import {
  admits,
  type ContractStamp,
  LOCAL_MACHINE_ID,
  type ModelSession,
  type RunningCall,
  SAFE_STOP_BLOCKED_TEXT,
  type SafeStopOptions,
  type SafeStopOutcome,
  type SessionCompaction,
  type SessionEvent,
  type SessionFactory,
  type SessionImage,
  type SessionResume,
  type SessionSpec,
  StoppedBeforeStartError,
  type TaskShell,
  type ThinkingLevel,
} from "../session/session";
import { stagePluginTrees } from "../session/stagedPlugins";
import { claimStagingFolder } from "../session/stagingFolders";
import { PI_CONTROL_PROFILE } from "./controlProfile";
import { speedRuntime } from "./crewSpeed";
import { customCompaction } from "./customCompaction";
import { customPictureContext } from "./customPictureContext";

export { PI_CONTROL_PROFILE } from "./controlProfile";

import { createEventBashTool, type EventBashInput } from "./bashTool";
import { fencedPiReadTools } from "./fencedTools";
import { LOCAL_CONTEXT_RESERVE, localInputFits } from "./ollamaStream";
import { piSessionEvents, usageFromMessage } from "./piEvents";
import { createCrewmateResourceLoader } from "./piResourceLoader";
import { piToolsOf } from "./toolSpec";
import type { ModelRuntime } from "./types";
import { answerUnansweredCalls } from "./unansweredCalls";

/**
 * Pi's implementation of the one session contract (`src/core/session/`):
 * the only place a Pi session is built from a `SessionSpec`. It serves the
 * three roles' shapes: the seat's rolling session and the adapted decision
 * model's one-shot question with no built-ins, and the crewmate's rolling
 * session with Pi's coding set.
 *
 * Every Pi session shares one construction discipline: the app-scoped
 * agentDir, a hand-built resource loader whose system prompt is the spec's
 * base prompt served byte for byte (with the captain's served text appended
 * after it), and the spec's tools generated as Pi custom tools. With no
 * built-ins, Pi's own are off structurally (`noTools: "builtin"`); the
 * coding set is Pi's own tools beside the spec's, with the host's
 * event-driven bash in place of Pi's blocking one when the factory has it,
 * and its loader also serves the working copy's own AGENTS.md (or
 * CLAUDE.md) and skills. The spec says the rest: the request bounds clamp
 * the model's output and Pi's retries and cap a rolling prompt's model
 * turns, the thinking level is the spec's, and a rolling record is stamped
 * with the spec's contract. The watched time bounds are not Pi's to keep:
 * the one watcher on the host's clock (`session/bounds.ts`) holds a session
 * to them and cuts a turn with `abort(failure)`. It sits behind
 * `src/core/pi/` like every other Pi touchpoint.
 */

export type PiSessionDeps = {
  /** The app-scoped Pi agentDir, never ~/.pi/agent. */
  agentDir: string;
  speedCapabilities?: (
    accountId: string | undefined,
    modelId: string,
  ) => readonly CrewSpeed[] | undefined | Promise<readonly CrewSpeed[] | undefined>;
  /**
   * The event-driven bash runner (R2), keyed by the spec's owner. Present,
   * the coding set's bash shadows Pi's blocking builtin: long commands
   * become background jobs whose exit arrives as the owner's next turn.
   * Absent (tests), stock bash stands.
   */
  runBash?: (input: {
    ownerId: string;
    command: string;
    cwd: string;
    background?: boolean;
    /** What the session's shell carries beyond the host's environment (`SessionSpec.shell`). */
    shell?: TaskShell;
  }) => Promise<BashOutcome>;
};

/** Pi's coding set: the full toolset a crewmate gets - its worktree is the isolation. */
export const PI_CODING_BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

/**
 * A call of one of the coding builtins, typed by the arguments Pi's own
 * definitions take - bash by the event-driven one that replaces Pi's.
 */
export type PiCodingBuiltinCall = {
  [N in (typeof PI_CODING_BUILTINS)[number]]: {
    name: N;
    args: {
      read: ReadToolInput;
      bash: EventBashInput;
      edit: EditToolInput;
      write: WriteToolInput;
      grep: GrepToolInput;
      find: FindToolInput;
      ls: LsToolInput;
    }[N];
  };
}[(typeof PI_CODING_BUILTINS)[number]];

/** A rolling session's custom entry recording the contract that served it. */
export const FIRSTMATE_CONTRACT_ENTRY = "fm-contract";

/**
 * Pi's retry.provider.timeoutMs, forwarded to the provider SDK as the
 * request timeout of a rolling session. On a continuously streaming
 * reasoning loop this may be idle-based (the 2026-09-03 hang ran 60 minutes
 * against Pi's 5-minute httpIdleTimeoutMs default) - the spec's watched
 * request bound, on the host's clock, is the one that actually fires.
 */
export const PI_PROVIDER_TIMEOUT_MS = 180_000;

/**
 * The provider timeout for a local model (the dev local seat): five
 * minutes, the longest one inference is ever allowed, since a cold local
 * model can take minutes to answer at all.
 */
const LOCAL_PROVIDER_TIMEOUT_MS = 300_000;

type QueuedMessage = Parameters<AgentSession["agent"]["steer"]>[0];

/**
 * Pi's steering queue, oldest first, which its agent keeps private; undefined
 * when that agent keeps it elsewhere, and then every steer keeps Pi's order.
 */
function steeringQueue(agent: AgentSession["agent"]): { messages: QueuedMessage[] } | undefined {
  const queue = (agent as unknown as { steeringQueue?: { messages?: unknown } }).steeringQueue;
  return queue && Array.isArray(queue.messages)
    ? (queue as { messages: QueuedMessage[] })
    : undefined;
}

/**
 * Pi carries user-turn images in PromptOptions.images / steer's second
 * argument as flat `{ type, data, mimeType }` parts - never as a content
 * array in the text position (its prompt() does string work on `text`).
 * The rebind contract test pins this call shape.
 */
export function toImageContents(
  images: SessionImage[] | undefined,
): Array<{ type: "image"; data: string; mimeType: string }> | undefined {
  if (!images || images.length === 0) return undefined;
  return images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }));
}

/**
 * A model that says it takes no pictures refuses them by name: the words
 * and the picture stay with the message, never sent as words alone. A model
 * that does not say is tried - its provider's own answer decides.
 */
export function refuseUnreadablePictures(
  model: { name?: string; id?: string; input?: readonly string[] } | undefined,
  images: SessionImage[] | undefined,
): void {
  if (!images?.length || !model?.input || model.input.includes("image")) return;
  throw new Error(
    `${model.name ?? model.id ?? "This model"} cannot read pictures. Choose a model that can, or send the words without the picture.`,
  );
}

/**
 * Drop thinking blocks from assistant messages that ended in error or
 * abort. Pi's transformMessages skips those messages when building the
 * next provider request, but convertToLlm (compaction) does not, and a
 * resumed JSONL still has the blob. Stripping the live session state (and
 * the same walk on resume) is what stops a 280k thinking runaway from
 * becoming the next turn's 174k input.
 */
export function stripFailedThinking(messages: unknown): void {
  if (!Array.isArray(messages)) return;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const typed = message as { role?: unknown; stopReason?: unknown; content?: unknown };
    if (typed.role !== "assistant") continue;
    if (typed.stopReason !== "error" && typed.stopReason !== "aborted") continue;
    if (!Array.isArray(typed.content)) continue;
    typed.content = typed.content.filter((block) => {
      if (!block || typeof block !== "object") return true;
      return (block as { type?: unknown }).type !== "thinking";
    });
  }
}

/**
 * Rewrite the turn_end of a turn an `abort(failure)` cut as a provider error
 * carrying that failure, so the feed and card fire with the cut's words. A
 * cut mid-reply ends the turn aborted; one that lands between turns (after a
 * tool ran, or at the model-turn cap) ends the next request in Pi's own
 * error ("This operation was aborted") - either way the cut is why.
 */
export function rewriteTimedOutTurn(event: unknown, cut: boolean, errorMessage: string): unknown {
  if (!cut || !event || typeof event !== "object") return event;
  const typed = event as { type?: unknown; message?: unknown };
  if (typed.type !== "turn_end") return event;
  if (!typed.message || typeof typed.message !== "object") {
    return {
      ...typed,
      message: { stopReason: "error", errorMessage },
    };
  }
  const message = typed.message as { stopReason?: unknown; errorMessage?: unknown };
  const stopped =
    message.stopReason === "aborted" ||
    message.stopReason === "error" ||
    message.stopReason === undefined;
  if (!stopped) return event;
  return {
    ...typed,
    message: { ...message, stopReason: "error", errorMessage },
  };
}

/** What a second prompt, a steer, or a prompt after dispose is told. */
const ONE_QUESTION_TEXT = "A one-shot session answers one question.";
const ENDED_SESSION_TEXT = "This conversation has ended.";

class PiOneShotSession implements ModelSession {
  readonly controlProfile = PI_CONTROL_PROFILE;
  private asked = false;
  private disposed = false;
  /** The failure an `abort(failure)` asked the cut turn to report. */
  private failure: string | undefined;
  private markClosed!: () => void;
  private readonly closedPromise = new Promise<void>((resolve) => {
    this.markClosed = resolve;
  });

  constructor(
    private readonly session: AgentSession,
    private readonly owner: string,
  ) {}

  get sessionId(): string {
    return this.session.sessionId;
  }

  resume(): undefined {
    return undefined;
  }

  recordPath(): undefined {
    return undefined;
  }

  modelRef(): { provider: string; id: string } | undefined {
    const model = this.session.model;
    return model ? { provider: model.provider, id: model.id } : undefined;
  }

  modelLabel(): string | undefined {
    return this.session.model?.name;
  }

  isStreaming(): boolean {
    return this.session.isStreaming;
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    const translate = piSessionEvents(this.owner, () => this.modelRef()?.provider);
    const deliver = holdingRecoverableAttempt((event) => {
      const reported = rewriteTimedOutTurn(event, this.failure !== undefined, this.failure ?? "");
      for (const sessionEvent of translate(reported)) listener(sessionEvent);
    });
    return this.session.subscribe((event) => deliver(event));
  }

  prompt(text: string): Promise<void> {
    if (this.disposed || this.asked) return Promise.reject(new Error(ONE_QUESTION_TEXT));
    this.asked = true;
    return this.session.prompt(text, { source: "rpc" });
  }

  steer(): Promise<void> {
    return Promise.reject(new Error(ONE_QUESTION_TEXT));
  }

  takeUndeliveredSteers(): string[] {
    return [];
  }

  /** A one-shot's thinking is fixed by its spec. */
  setThinkingLevel(): void {}

  reasoning(): undefined {
    return undefined;
  }

  /** A one-shot's instructions are fixed by its spec. */
  serveInstructions(): void {}

  takeRenewal(): undefined {
    return undefined;
  }

  servedState(): undefined {
    return undefined;
  }

  abort(failure?: string): Promise<void> {
    if (failure !== undefined && this.session.isStreaming) this.failure = failure;
    return this.session.abort();
  }

  /** Nothing is held between turns: an in-process session has no client to let go of. */
  async detach(): Promise<void> {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.session.dispose();
    this.markClosed();
  }

  closed(): Promise<void> {
    return this.closedPromise;
  }
}

/**
 * A rolling Pi session: one file-backed Pi session in the spec's record
 * dir that survives restarts, compacted by Pi as it grows. It serves the
 * captain's instructions after the base prompt and re-serves a change only
 * at an idle boundary, stamps the spec's contract in its own file, and
 * stops a prompt whose model turns reach the spec's cap. A session held to
 * watched bounds also strips a failed turn's thinking so it cannot poison
 * the next prompt. A local binding (the dev local seat) gets bounded
 * compaction and terminal failures, empty answers included.
 */
class PiRollingSession implements ModelSession {
  readonly controlProfile = PI_CONTROL_PROFILE;
  /** The failure an `abort(failure)` asked the cut turn to report. */
  private failure: string | undefined;
  private promptOpen = false;
  /** The prompt's model turns that answered, for the model-turn cap. */
  private modelTurns = 0;
  private readonly unsubscribeTracking: () => void;
  private readonly readListeners = new Set<(event: SessionEvent) => void>();
  /** User messages Pi appended while the current prompt was open, in order. */
  private served: Array<{
    message: object;
    textSha256: string;
    parentEntryId: string | null;
    prefix?: { messageCount: number; sha256: string };
  }> = [];
  private servedPromptPending = false;
  private lastAssistant: AssistantMessage | undefined;
  private disposed = false;
  /** Includes host-side prompt preparation before Pi itself becomes busy. */
  private readonly promptFinishes = new Set<Promise<void>>();
  /** The app's own inputs that go before every queued steer (`steerFirst`). */
  private readonly firstSteers = new WeakSet<object>();
  /** Calls the tool gate let run in this prompt whose result Pi has not recorded yet. */
  private readonly executing = new Map<string, RunningCall>();
  /** A tool batch is running: from its first call until its turn ends. */
  private inToolBatch = false;
  /** The safe stop under way (`stopSafely`): no tool starts while it stands. */
  private stop:
    | { promise: Promise<SafeStopOutcome>; cut: boolean; options: SafeStopOptions }
    | undefined;
  /** Steers the safe stop took out of Pi's queue before its cut, for the owner. */
  private keptSteers: string[] = [];
  private markClosed!: () => void;
  private failClosed!: (error: unknown) => void;
  private readonly closedPromise = new Promise<void>((resolve, reject) => {
    this.markClosed = resolve;
    this.failClosed = reject;
  });

  constructor(
    private readonly session: AgentSession,
    private readonly options: {
      owner: string;
      /** The spec's `maxModelTurns`; 0 is no cap. */
      maxModelTurns: number;
      local: boolean;
      perTurn: boolean;
      compaction: SessionSpec["compaction"];
      /** Drop a failed turn's thinking from the live state (the runaway hardening). */
      stripFailed: boolean;
      stamp: ContractStamp | undefined;
      instructions: { current: ServedInstructions | undefined };
      /** What a coding session opened at on its spec's model. */
      reasoning?: Reasoning;
    },
  ) {
    if (options.stripFailed) stripFailedThinking(session.messages);
    this.unsubscribeTracking = session.subscribe((event) => this.onPiEvent(event));
    // Pi polls for steers after preparing its next request (where it folds
    // before the next response) only when it holds none already, so an input
    // that must reach that request - the first mate's recovery from the fold -
    // goes with it, ahead of the steers Pi holds (INF-1746 R43). Every other
    // steer keeps Pi's order.
    const agent = session.agent;
    if (agent?.convertToLlm) {
      const convert = agent.convertToLlm;
      const pictures = customPictureContext(session.sessionManager);
      agent.convertToLlm = (messages) =>
        convert.call(
          agent,
          isCustomApiProvider(session.model?.provider ?? "") ? pictures(messages) : messages,
        );
    }
    // The safe stop's gate (`stopSafely`), after Pi's own check: a call
    // asked once the stop stands never runs and says why, and a call it
    // lets run is one the stop waits on.
    if (agent) {
      const before = agent.beforeToolCall;
      agent.beforeToolCall = async (context, signal) => {
        if (this.stop) return { block: true, reason: SAFE_STOP_BLOCKED_TEXT };
        const result = await before?.call(agent, context, signal);
        if (result?.block) return result;
        if (this.stop) return { block: true, reason: SAFE_STOP_BLOCKED_TEXT };
        const { id, name } = context.toolCall;
        this.executing.set(id, { callId: id, toolName: name });
        return result;
      };
    }
    const prepare = agent?.prepareNextTurnWithContext;
    if (agent && prepare)
      agent.prepareNextTurnWithContext = async (turn, signal) => {
        const update = await prepare.call(agent, turn, signal);
        const first = this.takeFirstSteers();
        return first.length > 0
          ? { ...update, messages: [...(update?.messages ?? []), ...first] }
          : update;
      };
  }

  get sessionId(): string {
    return this.session.sessionId;
  }

  resume(): SessionResume | undefined {
    const sessionFile = this.session.sessionFile;
    return sessionFile ? { backend: "pi", sessionFile } : undefined;
  }

  recordPath(): string | undefined {
    return this.session.sessionFile;
  }

  isStreaming(): boolean {
    return this.session.isStreaming;
  }

  modelRef(): { provider: string; id: string } | undefined {
    const model = this.session.model;
    return model ? { provider: model.provider, id: model.id } : undefined;
  }

  modelLabel(): string | undefined {
    return this.session.model?.name;
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    const translate = piSessionEvents(this.options.owner, () => this.modelRef()?.provider);
    const deliver = holdingRecoverableAttempt((event) => {
      const rewritten = rewriteTimedOutTurn(event, this.failure !== undefined, this.failure ?? "");
      for (const sessionEvent of translate(rewritten)) {
        listener(sessionEvent);
      }
    });
    this.readListeners.add(listener);
    const unsubscribe = this.session.subscribe((event) => {
      // Pi may recover an overflow by compacting and retrying. A local session
      // raises no failure card until that recovery has settled; prompt() throws
      // the final failure through the owner's existing visible-error path instead.
      if (!(this.options.local && isFailedTurnEnd(event))) deliver(event);
      if (this.options.stripFailed && (this.failure !== undefined || isFailedTurnEnd(event))) {
        stripFailedThinking(this.session.messages);
      }
    });
    return () => {
      this.readListeners.delete(listener);
      unsubscribe();
    };
  }

  serveInstructions(instructions: ServedInstructions): void {
    const holder = this.options.instructions;
    if (holder.current?.sha === instructions.sha) return;
    // Never mid-turn: a change waits for the next prompt's own boundary.
    if (this.promptOpen || this.session.isStreaming) return;
    holder.current = instructions;
    // Pi rebuilds its prompt sections from the loader on a loadout change;
    // the same loadout is the cheapest way to ask for that. The next prompt
    // then patches only the changed section into the transcript.
    this.session.setActiveToolsByName(this.session.getActiveToolNames());
    recordContract(this.session.sessionManager, this.options.stamp, instructions.sha);
  }

  /** Pi serves its prompt afresh on every request: a resumed session never starts over. */
  takeRenewal(): undefined {
    return undefined;
  }

  async prompt(text: string, images?: SessionImage[]): Promise<void> {
    if (this.disposed) throw new Error(ENDED_SESSION_TEXT);
    refuseUnreadablePictures(this.session.model, images);
    const parts = toImageContents(images);
    this.keptSteers = [];
    this.failure = undefined;
    this.modelTurns = 0;
    this.lastAssistant = undefined;
    this.served = [];
    this.servedPromptPending = true;
    this.promptOpen = true;
    let finished!: () => void;
    const promptFinished = new Promise<void>((resolve) => {
      finished = resolve;
    });
    this.promptFinishes.add(promptFinished);
    try {
      budgetCustomCompaction(
        this.session,
        compactionNow(this.options.compaction),
        this.options.local ? LOCAL_CONTEXT_RESERVE : DEFAULT_COMPACTION_SETTINGS.reserveTokens,
      );
      if (this.options.local) {
        const fits = async () => {
          const messages = await this.session.agent.convertToLlm([
            ...this.session.messages,
            {
              role: "user",
              content: [{ type: "text", text }, ...(parts ?? [])],
              timestamp: Date.now(),
            },
          ]);
          // Pi 0.87 keeps the prompt and the tool list on transcript system
          // messages. The estimator's prefix already counts those, so leaving
          // the system messages in the chat list counts them twice: a short
          // retry then looks too big to send and too small for Pi to compact.
          const prompt = getCurrentSystemPrompt(messages) || this.session.systemPrompt;
          const tools = getCurrentTools(messages);
          return localInputFits(
            {
              systemPrompt: prompt,
              tools: tools.length > 0 ? tools : this.session.agent.state.tools,
              messages: messages.filter((message) => message.role !== "system"),
            },
            this.session.model?.contextWindow ?? 0,
          );
        };
        // Pi's built-in pre-prompt check excludes the incoming user message.
        // Include it here, use Pi's real compactor, and recheck before sending.
        if (!(await fits())) {
          try {
            await this.session.compact();
          } catch {
            throw new Error(
              this.failure ??
                "Your first mate could not shorten this conversation enough for the local model. Send less at once or choose a model with more room.",
            );
          }
          if (!(await fits()))
            throw new Error(
              "This request is too large for the local model, even after shortening the conversation. Send less at once or choose a model with more room.",
            );
        }
      }
      if (this.disposed) throw new Error(ENDED_SESSION_TEXT);
      if (this.failure !== undefined) throw new Error(this.failure);
      // A safe stop came while the prompt was prepared: Pi never takes it,
      // and its input goes again.
      if (this.stop?.cut) throw new StoppedBeforeStartError();
      await this.session.prompt(text, parts ? { source: "rpc", images: parts } : { source: "rpc" });
      if (this.options.local) {
        if (this.failure !== undefined) throw new Error(this.failure);
        const last = this.lastAssistant as AssistantMessage | undefined;
        if (last && isContextOverflow(last, this.session.model?.contextWindow)) {
          throw new Error(
            "Your first mate could not shorten this conversation enough for the local model. Send less at once or choose a model with more room.",
          );
        }
        if (
          !last ||
          last.stopReason === "error" ||
          last.stopReason === "aborted" ||
          last.stopReason === "length"
        ) {
          throw new Error(
            last?.errorMessage ||
              "The local model did not finish its answer. Try again or choose a different model.",
          );
        }
      }
    } finally {
      this.promptOpen = false;
      this.executing.clear();
      this.inToolBatch = false;
      this.promptFinishes.delete(promptFinished);
      finished();
    }
  }

  setThinkingLevel(level: ThinkingLevel): void {
    if (!this.options.perTurn) return;
    this.session.setThinkingLevel(level);
  }

  reasoning(): Reasoning | undefined {
    return this.options.reasoning;
  }

  async steer(text: string, images?: SessionImage[]): Promise<void> {
    if (this.disposed) throw new Error(ENDED_SESSION_TEXT);
    refuseUnreadablePictures(this.session.model, images);
    // Pi 0.99 returns the queued input disposition; callers only need the
    // queueing to finish, not its internal placement decision.
    await this.session.steer(text, toImageContents(images));
  }

  /**
   * Queued at once, ahead of every steer still queued and behind earlier
   * first steers, so the turn's next request takes it: the first poll of a
   * run (a prompt, or the retry after a fold) takes the queue's head, and a
   * request after Pi prepares a step takes it from `takeFirstSteers`. It
   * skips Pi's own input handling, which awaits before queueing and would let
   * a retry start without it.
   */
  async steerFirst(text: string, images?: SessionImage[]): Promise<void> {
    if (this.disposed) throw new Error(ENDED_SESSION_TEXT);
    refuseUnreadablePictures(this.session.model, images);
    const message = {
      role: "user" as const,
      content: [{ type: "text" as const, text }, ...(toImageContents(images) ?? [])],
      timestamp: Date.now(),
    };
    this.firstSteers.add(message);
    this.session.agent.steer(message);
    const queue = steeringQueue(this.session.agent);
    if (!queue) return;
    const rest = queue.messages.filter((queued) => queued !== message);
    const ahead = rest.filter((queued) => this.firstSteers.has(queued));
    queue.messages = [...ahead, message, ...rest.filter((queued) => !this.firstSteers.has(queued))];
  }

  private takeFirstSteers(): QueuedMessage[] {
    const queue = steeringQueue(this.session.agent);
    if (!queue) return [];
    const first = queue.messages.filter((queued) => this.firstSteers.has(queued));
    if (first.length > 0)
      queue.messages = queue.messages.filter((queued) => !this.firstSteers.has(queued));
    return first;
  }

  takeUndeliveredSteers(): string[] {
    // A first steer no turn took is the app's own input; its owner sends it
    // again with the next input, so it is dropped here, never handed back.
    if (!this.session.isStreaming) this.takeFirstSteers();
    if (this.session.isStreaming) return [];
    const kept = this.keptSteers.splice(0);
    if (this.session.getSteeringMessages().length === 0) return kept;
    return [...kept, ...this.session.clearQueue().steering];
  }

  servedState(): ServedState | undefined {
    if (this.served.length === 0 && this.servedPromptPending) {
      return { sessionFile: this.session.sessionFile ?? null, prompt: null, steers: [] };
    }
    if (this.served.length === 0) return undefined;
    const entries = this.session.sessionManager.getEntries();
    const locate = (message: object): string | null =>
      entries.find((entry) => entry.type === "message" && entry.message === message)?.id ?? null;
    const [first, ...rest] = this.served;
    const asServed = (item: (typeof this.served)[number]): ServedMessage => ({
      textSha256: item.textSha256,
      entryId: locate(item.message),
      parentEntryId: item.parentEntryId,
    });
    const prompt = first?.prefix ? { ...asServed(first), prefix: first.prefix } : null;
    const steers = (prompt ? rest : this.served).map(asServed);
    return { sessionFile: this.session.sessionFile ?? null, prompt, steers };
  }

  /** With a failure, the cut turn reports it as a failed turn: a bound's, or the owner's own. */
  abort(failure?: string): Promise<void> {
    if (failure !== undefined && this.promptOpen && this.failure === undefined) {
      this.failure = failure;
    }
    if (this.options.local) this.session.abortCompaction();
    return this.session.abort();
  }

  /**
   * The safe stop (`ModelSession.stopSafely`): the gate refuses every call
   * from now on, the calls it let run finish and Pi records their results,
   * the batch's refused calls record why they did not run, and then the
   * turn is cut - before Pi polls for steers, so the ones it holds stay the
   * owner's. A second ask joins the first.
   */
  stopSafely(options: SafeStopOptions = {}): Promise<SafeStopOutcome> {
    if (this.stop) return this.stop.promise;
    const finishes = [...this.promptFinishes];
    if (finishes.length === 0 && !this.session.isStreaming) return Promise.resolve("stopped");
    const { signal } = options;
    if (signal?.aborted) return Promise.resolve("withdrawn");
    let settle!: (outcome: SafeStopOutcome) => void;
    const promise = new Promise<SafeStopOutcome>((resolve) => {
      settle = resolve;
    });
    const stop = { promise, cut: false, options };
    this.stop = stop;
    const end = (outcome: SafeStopOutcome) => {
      if (this.stop === stop) this.stop = undefined;
      signal?.removeEventListener("abort", withdraw);
      settle(outcome);
    };
    const withdraw = () => {
      if (!stop.cut) end("withdrawn");
    };
    signal?.addEventListener("abort", withdraw, { once: true });
    void Promise.all(finishes)
      .then(() => this.session.waitForIdle())
      .then(
        () => end("stopped"),
        () => end("stopped"),
      );
    this.checkStop();
    return promise;
  }

  /** The safe stop cuts the turn once nothing it let run is still running. */
  private checkStop(): void {
    const stop = this.stop;
    if (!stop || stop.cut) return;
    const calls = [...this.executing.values()];
    if (calls.length > 0 || this.inToolBatch) {
      stop.options.waiting?.(calls);
      return;
    }
    stop.cut = true;
    stop.options.waiting?.([]);
    this.keptSteers.push(...this.session.clearQueue().steering);
    void this.abort().catch(() => {});
  }

  /** Nothing is held between turns: an in-process session has no client to let go of. */
  async detach(): Promise<void> {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // abort() waits for Pi's run (including noncancellable callbacks), unlike
    // dispose(), which immediately disconnects the transcript writer.
    void this.session
      .abort()
      .then(async () => {
        await Promise.all(this.promptFinishes);
        this.unsubscribeTracking();
        this.session.dispose();
        this.markClosed();
      })
      .catch(this.failClosed);
  }

  closed(): Promise<void> {
    return this.closedPromise;
  }

  private onPiEvent(event: unknown): void {
    const type = eventType(event);
    // A run Pi began after the safe stop's cut is cut too.
    if (this.stop?.cut && (type === "agent_start" || type === "turn_start"))
      void this.session.abort().catch(() => {});
    if (type === "tool_execution_start") this.inToolBatch = true;
    if (type === "message_end") {
      const message = (event as { message?: { role?: unknown; toolCallId?: unknown } }).message;
      if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
        if (this.executing.delete(message.toolCallId)) this.checkStop();
      }
    }
    if (type === "turn_end" && this.inToolBatch) {
      this.inToolBatch = false;
      this.checkStop();
    }
    if (this.promptOpen && type === "message_end") {
      this.noteServed(event);
      const message = (event as { message?: AssistantMessage }).message;
      if (message?.role === "assistant") this.lastAssistant = message;
    }
    if (this.promptOpen && this.failure === undefined && type === "turn_end") {
      this.countModelTurn(event);
    }
  }

  /**
   * One model turn answered. Its tools have run by the time Pi ends the
   * turn, and their results are what the loop would ask the model about
   * next, so a turn at the cap whose tools ran is where the loop stops,
   * before that request - where Claude's client stops at `maxTurns`. A
   * failed attempt Pi retries is not a turn that answered.
   */
  private countModelTurn(event: unknown): void {
    const cap = this.options.maxModelTurns;
    const turn = event as { message?: { stopReason?: unknown }; toolResults?: unknown };
    const stopReason = turn.message?.stopReason;
    if (cap <= 0 || stopReason === "error" || stopReason === "aborted") return;
    this.modelTurns += 1;
    const toolsRan = Array.isArray(turn.toolResults) && turn.toolResults.length > 0;
    if (this.modelTurns >= cap && toolsRan) void this.abort(modelTurnsErrorMessage(cap));
  }

  /**
   * A user message reached the model's context. Agent state already holds
   * it and Pi persists it right after the listeners, so the tree's current
   * leaf is the entry it follows. The first one of a prompt is the prompt
   * itself; later ones are steers queued into the running turn.
   */
  private noteServed(event: unknown): void {
    const message = (event as { message?: unknown }).message;
    if (!message || typeof message !== "object") return;
    if ((message as { role?: unknown }).role !== "user") return;
    const text = userText((message as { content?: unknown }).content);
    const item: (typeof this.served)[number] = {
      message,
      textSha256: sha256(text),
      parentEntryId: this.session.sessionManager.getLeafId(),
    };
    if (this.servedPromptPending) {
      this.servedPromptPending = false;
      const live = this.session.messages;
      const prefix = live.at(-1) === message ? live.slice(0, -1) : live;
      item.prefix = { messageCount: prefix.length, sha256: sha256(JSON.stringify(prefix)) };
    }
    this.served.push(item);
    for (const listener of this.readListeners) {
      listener({ type: "input_read", textSha256: item.textSha256 });
    }
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && (part as { type?: unknown }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}

function eventType(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const type = (event as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

/**
 * An attempt Pi retries inside the same prompt is not a failed turn.
 *
 * Overflow: Pi compacts and retries once. A custom connection raises that
 * overflow when the server says the request does not fit, or when Pi trimmed
 * the reply and the cut answer cannot stand. The failed turn_end waits until
 * compaction ends. It is dropped when that compaction will retry, and
 * delivered when Pi moves on without one (nothing to compact, a failed or
 * cancelled compaction, or a second overflow after the one retry).
 *
 * Any other provider error: Pi emits the failed turn_end, then agent_end
 * with willRetry, and retries inside the same prompt. The turn_end waits.
 * It is dropped when that retry succeeds, delivered when Pi will not retry
 * or the retry is cancelled, and delivered if the prompt settles while it
 * is still held. A later attempt supersedes the one being held.
 * Dropping keeps the attempt's measured usage and suppresses only its
 * failure and closing text.
 */
export function holdingRecoverableAttempt(
  deliver: (event: unknown) => void,
): (event: unknown) => void {
  let heldOverflow: unknown;
  let heldRetry: unknown;
  return (event) => {
    const type = eventType(event);
    if (heldOverflow !== undefined && type === "compaction_end") {
      const end = event as { willRetry?: unknown; errorMessage?: unknown };
      if (end.willRetry !== true || end.errorMessage) deliver(heldOverflow);
      else preserveMeasuredUsage(deliver, heldOverflow);
      heldOverflow = undefined;
    } else if (
      heldOverflow !== undefined &&
      (type === "message_start" || type === "turn_end" || type === "agent_settled")
    ) {
      deliver(heldOverflow);
      heldOverflow = undefined;
    }
    if (heldRetry !== undefined && type === "agent_end") {
      if ((event as { willRetry?: unknown }).willRetry !== true) {
        deliver(heldRetry);
        heldRetry = undefined;
      }
    } else if (heldRetry !== undefined && type === "auto_retry_end") {
      if ((event as { success?: unknown }).success !== true) deliver(heldRetry);
      else preserveMeasuredUsage(deliver, heldRetry);
      heldRetry = undefined;
    } else if (heldRetry !== undefined && (type === "turn_end" || type === "agent_settled")) {
      // A later attempt replaces the one held. The prompt ending still
      // delivers it: a failure must not vanish because its decision never came.
      if (type === "agent_settled") deliver(heldRetry);
      else preserveMeasuredUsage(deliver, heldRetry);
      heldRetry = undefined;
    }
    if (isOverflowTurnEnd(event)) {
      heldOverflow = event;
      return;
    }
    if (isRetriedErrorTurnEnd(event)) {
      heldRetry = event;
      return;
    }
    deliver(event);
  };
}

/**
 * The dropped attempt's measured usage, and nothing else. The usage is the
 * one already read from the attempt, provider included, so a custom request
 * with unknown counts keeps its empty record. The translator does not read
 * it again. No failure, no closing text.
 */
function preserveMeasuredUsage(deliver: (event: unknown) => void, event: unknown): void {
  const usage = usageFromMessage((event as { message?: unknown }).message);
  if (!usage) return;
  deliver({ type: "turn_end", usageOnly: true, usage });
}

/** A provider-error turn_end that is not an overflow Pi recovers by compacting. */
function isRetriedErrorTurnEnd(event: unknown): boolean {
  if (!isFailedTurnEnd(event) || isOverflowTurnEnd(event)) return false;
  return (event as { message: { stopReason?: unknown } }).message.stopReason === "error";
}

function isOverflowTurnEnd(event: unknown): boolean {
  if (!isFailedTurnEnd(event)) return false;
  const message = (event as { message: AssistantMessage }).message;
  return (
    message.stopReason === "error" &&
    typeof message.errorMessage === "string" &&
    isContextOverflow(message)
  );
}

function isFailedTurnEnd(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const typed = event as { type?: unknown; message?: { stopReason?: unknown } };
  if (typed.type !== "turn_end" || !typed.message || typeof typed.message !== "object") {
    return false;
  }
  return typed.message.stopReason === "error" || typed.message.stopReason === "aborted";
}

/**
 * Record the contract that serves this session in the session file itself
 * (contract v1.1 provenance): a custom entry, which never reaches the
 * model, appended when the session's newest one names a different contract
 * version, prompt, tool surface, or served instructions. The stamp is the
 * spec's - the role computed it - and the dispatch corpus stamps every
 * later turn with it. `prompt_sha` covers the byte-stable prompt alone, so
 * the trainable contract is never moved by the captain's own text;
 * `instructions_sha` is that text's (docs/sequences.md).
 */
function recordContract(
  sessionManager: SessionManager,
  stamp: ContractStamp | undefined,
  instructionsSha?: string,
): void {
  if (!stamp) return;
  const recorded = sessionManager
    .getEntries()
    .filter((entry) => entry.type === "custom" && entry.customType === FIRSTMATE_CONTRACT_ENTRY)
    .at(-1) as
    | {
        data?: {
          version?: unknown;
          prompt_sha?: unknown;
          tools_sha?: unknown;
          instructions_sha?: unknown;
        };
      }
    | undefined;
  if (
    recorded?.data?.version === stamp.version &&
    recorded.data.prompt_sha === stamp.promptSha &&
    recorded.data.tools_sha === stamp.toolsSha &&
    recorded.data.instructions_sha === instructionsSha
  ) {
    return;
  }
  sessionManager.appendCustomEntry(FIRSTMATE_CONTRACT_ENTRY, {
    version: stamp.version,
    prompt_sha: stamp.promptSha,
    ...(instructionsSha ? { instructions_sha: instructionsSha } : {}),
    tools_sha: stamp.toolsSha,
  });
}

/** Pi derives the request's output budget from model.maxTokens: a copy with the cap bounds every assistant message. */
function boundedModel<M extends { maxTokens?: number }>(
  model: M,
  maxOutput: number | undefined,
): M {
  // The catalog object itself is shared and never mutated.
  return maxOutput !== undefined &&
    typeof model.maxTokens === "number" &&
    model.maxTokens > maxOutput
    ? { ...model, maxTokens: maxOutput }
    : model;
}

function modelOf(spec: SessionSpec, runtime: ModelRuntime) {
  if (!spec.model) throw new Error("A Pi session needs a model.");
  const model = runtime.getModel(spec.model.provider, spec.model.id);
  if (!model) {
    throw new Error(`Unknown model ${spec.model.provider}/${spec.model.id}`);
  }
  return boundedModel(model, spec.bounds?.request?.maxOutputTokens);
}

async function openOneShot(
  deps: PiSessionDeps,
  spec: SessionSpec,
  runtime: ModelRuntime,
): Promise<ModelSession> {
  const request = spec.bounds?.request;
  const sessionManager = SessionManager.inMemory(spec.cwd);
  const custom = Boolean(spec.model && isCustomApiProvider(spec.model.provider));
  const settingsManager = SettingsManager.inMemory({
    ...(custom ? { cacheWarming: "off" as const } : {}),
    // One bounded call: nothing rolls, so nothing compacts. The retries are
    // the spec's: an answer that has to be fought for is one the caller is
    // better off abstaining from.
    compaction: { enabled: false },
    retry: {
      enabled: !custom,
      ...(request?.retries !== undefined ? { maxRetries: request.retries } : {}),
    },
    enableInstallTelemetry: false,
  });

  const resourceLoader = createCrewmateResourceLoader(
    spec.instructions.base,
    () => spec.instructions.served?.text,
  );
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: spec.cwd,
    agentDir: deps.agentDir,
    modelRuntime: runtime,
    model: modelOf(spec, runtime),
    thinkingLevel: spec.thinking.level,
    resourceLoader,
    sessionManager,
    settingsManager,
    noTools: "builtin",
    customTools: piToolsOf(spec.tools),
  });
  return new PiOneShotSession(session, spec.owner);
}

/**
 * Budget compaction in Pi's own token count. Kept turns are a quarter of the
 * history room and never more than Pi's default; the reserve is sized so the
 * summary is that quarter, and never more than Pi's default. A connection's
 * stated values replace those within the history room, kept turns within
 * what the reserve Pi is given leaves of it. The spec's app-owned rule
 * lowers the trigger further (`compactionCeiling`). Rebudget at
 * each prompt boundary so a resumed session uses the current model. Overflow
 * still uses Pi's real compactor and its single retry.
 */
function budgetCustomCompaction(
  session: AgentSession,
  compaction: SessionCompaction | undefined,
  defaultReserve = DEFAULT_COMPACTION_SETTINGS.reserveTokens,
): void {
  const model = session.model;
  if (!model) return;
  const custom = isCustomApiProvider(model.provider);
  if (!custom && !compaction) return;
  const historyRoom = custom
    ? Math.max(0, model.contextWindow - model.maxTokens - piPrefixTokens(session))
    : 0;
  const quarter = Math.max(1, Math.floor(historyRoom / 4));
  const stated = custom ? customCompaction(model.provider, model.id) : undefined;
  const within = (tokens: number) => Math.max(1, Math.min(tokens, historyRoom));
  const reserve = custom
    ? stated?.reserveTokens
      ? within(stated.reserveTokens)
      : Math.min(DEFAULT_COMPACTION_SETTINGS.reserveTokens, Math.ceil(quarter / 0.8))
    : defaultReserve;
  const ceiling = compactionCeiling(session, model, compaction, reserve);
  // Pi triggers above window - reserve. Recompute rather than retaining a
  // previous large-window reserve when the next attachment uses a smaller model.
  const reserveTokens = Math.max(
    reserve,
    ceiling === undefined ? 0 : model.contextWindow - ceiling,
  );
  session.settingsManager.applyOverrides({
    compaction: {
      ...(custom
        ? {
            // Kept turns and the summary share the history room below Pi's trigger:
            // keeping more leaves the session above it right after compacting.
            keepRecentTokens: stated?.keepRecentTokens
              ? Math.max(1, Math.min(stated.keepRecentTokens, historyRoom - reserveTokens))
              : Math.min(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens, quarter),
          }
        : {}),
      reserveTokens,
    },
  });
}

/**
 * The context an app-owned rule keeps a session under, when it states one.
 * Past a price step every input token costs more, so a session asked to stay
 * below one treats it as Pi treats the window: it summarizes once the context
 * passes the step less the same reserve, which leaves room for the incoming
 * prompt and the error in Pi's estimate.
 *
 * A step counts only when that trigger sits a reserve above what a summary
 * keeps (the instructions, tool schemas and Pi's kept turns); below it Pi
 * would summarize before every request and never get under, so the rule
 * takes the model's next step, or leaves Pi's own trigger. Copilot's plan
 * counts premium requests, not tokens (docs/quota.md), so its listed prices
 * are no cost a summary saves.
 */
function compactionCeiling(
  session: AgentSession,
  model: NonNullable<AgentSession["model"]>,
  compaction: SessionCompaction | undefined,
  reserve: number,
): number | undefined {
  let steps: number[] = [];
  const tiers = model.cost.tiers ?? [];
  if (compaction?.belowPriceStep && model.provider !== COPILOT_PROVIDER_ID && tiers.length > 0) {
    const kept =
      piPrefixTokens(session) + session.settingsManager.getCompactionKeepRecentTokens(model);
    steps = tiers
      .map((tier) => tier.inputTokensAbove)
      .filter((step) => step - reserve > kept + reserve);
  }
  const limits = [
    ...(compaction?.maxContextTokens === undefined ? [] : [compaction.maxContextTokens]),
    ...(steps.length > 0 ? [Math.min(...steps) - reserve] : []),
  ];
  return limits.length > 0 ? Math.min(...limits) : undefined;
}

/** Instructions and tool schemas, counted the way Pi's compactor counts them. */
function piPrefixTokens(session: AgentSession): number {
  const prompt = estimateTokens({ role: "system", content: session.systemPrompt, timestamp: 0 });
  const tools = session.agent.state.tools;
  return prompt + (tools.length > 0 ? Math.ceil(JSON.stringify(tools).length / 4) : 0);
}

async function openRolling(
  deps: PiSessionDeps,
  spec: SessionSpec,
  record: Extract<SessionSpec["shape"], { turns: "rolling" }>["record"],
  binding: Extract<SessionSpec["binding"], { backend: "pi" }>,
): Promise<ModelSession> {
  const local = binding.local === true;
  const custom = Boolean(spec.model && isCustomApiProvider(spec.model.provider));
  const request = spec.bounds?.request;
  const sessionFile = record.resume?.backend === "pi" ? record.resume.sessionFile : undefined;
  const sessionManager = sessionFile
    ? SessionManager.open(sessionFile, record.dir, spec.cwd)
    : SessionManager.create(spec.cwd, record.dir);
  // A quit in the middle of a tool call leaves it unanswered (INF-3089).
  if (sessionFile) answerUnansweredCalls(sessionManager);

  const settingsManager = SettingsManager.inMemory({
    ...(custom ? { cacheWarming: "off" as const } : {}),
    compaction: {
      enabled: true,
      ...(local ? { reserveTokens: LOCAL_CONTEXT_RESERVE, keepRecentTokens: 4096 } : {}),
    },
    retry: {
      enabled: !custom,
      ...(request?.retries !== undefined ? { maxRetries: request.retries } : {}),
      provider: {
        timeoutMs: local ? LOCAL_PROVIDER_TIMEOUT_MS : PI_PROVIDER_TIMEOUT_MS,
      },
    },
    defaultThinkingLevel: spec.thinking.level,
    enableInstallTelemetry: false,
  });

  // The served instructions are read through this holder at every rebuild,
  // so a re-serve only swaps what it holds (`serveInstructions`).
  const instructions = { current: spec.instructions.served };
  const resourceLoader = createCrewmateResourceLoader(
    spec.instructions.base,
    () => instructions.current?.text,
  );
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: spec.cwd,
    agentDir: deps.agentDir,
    modelRuntime: binding.runtime,
    model: modelOf(spec, binding.runtime),
    thinkingLevel: spec.thinking.level,
    resourceLoader,
    sessionManager,
    settingsManager,
    // The built-ins stay off structurally; the session's whole surface is
    // the spec's tools (they are enabled without a `tools` allowlist).
    noTools: "builtin",
    customTools: piToolsOf(spec.tools),
  });
  // Resume can restore a previous medium/high from the JSONL; pin the
  // spec's level again so a grok-4.6 rebind cannot inherit an unbounded
  // effort. A per-turn session raises it for one turn only (WI-13).
  session.setThinkingLevel(spec.thinking.level);
  recordContract(sessionManager, record.stamp, instructions.current?.sha);

  return new PiRollingSession(session, {
    owner: spec.owner,
    maxModelTurns: request?.maxModelTurns ?? 0,
    local,
    perTurn: spec.thinking.perTurn === true,
    compaction: spec.compaction,
    stripFailed: spec.bounds?.watched !== undefined,
    stamp: record.stamp,
    instructions,
  });
}

/** A line about the person's plugins for a developer, as the Claude sessions' log keeps it. */
const notePlugins = (line: string) => console.warn(`[pi-session] ${line}`);

/**
 * A rolling session with Pi's coding set: the spec's tools beside Pi's own
 * (a tool of the spec's that shares a builtin's name replaces it, and the
 * host's bash replaces Pi's when the factory has one), in the spec's
 * record dir. With no model the spec defers to Pi, which reopens a resumed
 * session on the model and effort its record names; a model is served at
 * the spec's effort, clamped to what the model offers.
 */
async function openCoding(
  deps: PiSessionDeps,
  spec: SessionSpec,
  record: Extract<SessionSpec["shape"], { turns: "rolling" }>["record"],
  binding: Extract<SessionSpec["binding"], { backend: "pi" }>,
  staged: string | undefined,
): Promise<ModelSession> {
  const request = spec.bounds?.request;
  const sessionFile = record.resume?.backend === "pi" ? record.resume.sessionFile : undefined;
  const sessionManager = sessionFile
    ? SessionManager.open(sessionFile, record.dir, spec.cwd)
    : SessionManager.create(spec.cwd, record.dir);
  // A quit in the middle of a tool call leaves it unanswered (INF-3089).
  if (sessionFile) answerUnansweredCalls(sessionManager);

  const custom = Boolean(spec.model && isCustomApiProvider(spec.model.provider));
  const settingsManager = SettingsManager.inMemory({
    ...(custom ? { cacheWarming: "off" as const } : {}),
    compaction: { enabled: true },
    retry: {
      enabled: !custom,
      ...(request?.retries !== undefined ? { maxRetries: request.retries } : {}),
    },
    enableInstallTelemetry: false,
  });

  // The working copy's own AGENTS.md (or CLAUDE.md) and skills, from its
  // root alone (FI3-789).
  const read = spec.personalResources
    ? personalResources(
        spec.personalRoot,
        new Set(projectSkillFolders(spec.cwd).map((skill) => skill.name)),
        await personalPluginSource(spec.personalRoot),
      )
    : undefined;
  // A plugin is served from its own files alone, staged beside the record;
  // with nowhere to stage them, or a stage that fails, no plugin is served.
  const personal = read && {
    ...read,
    plugins: staged
      ? await stagePluginTrees(read.plugins, join(staged, "plugin-files"), notePlugins).catch(
          (error: unknown) => {
            // i18n-exempt: a line in the app's own log, for a developer.
            notePlugins(`the plugin skills were not staged: ${String(error)}`);
            return [];
          },
        )
      : [],
  };
  const runbookSkills =
    spec.runbookSkills && staged
      ? await stageRunbookSkills(spec.runbookSkills, join(staged, "runbook-skills"))
      : [];
  const resourceLoader = createCrewmateResourceLoader(spec.instructions.base, undefined, {
    runbookSkills,
    cwd: spec.cwd,
    ...(personal ? { personal } : {}),
  });
  await resourceLoader.reload();

  const runBash = deps.runBash;
  // A fenced session has only reads confined to its working copy: none of
  // Pi's own set, and no shell.
  const customTools: ToolDefinition[] = [
    ...piToolsOf(spec.tools),
    ...(spec.fenced ? fencedPiReadTools(spec.cwd) : []),
    ...(runBash && !spec.fenced
      ? [
          createEventBashTool((input) =>
            runBash({
              ownerId: spec.owner,
              command: input.command,
              cwd: spec.cwd,
              ...(input.background !== undefined ? { background: input.background } : {}),
              ...(spec.shell ? { shell: spec.shell } : {}),
            }),
          ),
        ]
      : []),
  ];
  const runtime = binding.runtime;
  const routedModel = spec.model ? runtime.getModel(spec.model.provider, spec.model.id) : undefined;
  const level = spec.thinking.level;
  const reasoning = routedModel
    ? clampThinkingLevel(
        routedModel,
        runtime,
        level === "off" ? undefined : level,
        spec.thinking.quick === true,
      )
    : undefined;
  // A custom tool sharing a builtin's name replaces it (R2: the event-driven
  // bash shadows Pi's blocking bash), so the builtin never competes.
  const customNames = new Set(customTools.map((tool) => tool.name));
  const builtins = spec.fenced ? [] : PI_CODING_BUILTINS.filter((name) => !customNames.has(name));
  const { session } = await createAgentSession({
    cwd: spec.cwd,
    agentDir: deps.agentDir,
    modelRuntime: runtime,
    ...(routedModel ? { model: routedModel } : {}),
    ...(reasoning ? { thinkingLevel: reasoning.level } : {}),
    resourceLoader,
    sessionManager,
    settingsManager,
    // The allowlist gates custom tools too: every custom tool must be named
    // here or it is silently disabled.
    tools: [...builtins, ...customTools.map((tool) => tool.name)],
    customTools,
  });

  if (personal) sessionManager.appendCustomEntry("personal-resources", personal.digests);
  return new PiRollingSession(session, {
    owner: spec.owner,
    maxModelTurns: request?.maxModelTurns ?? 0,
    local: false,
    perTurn: spec.thinking.perTurn === true,
    compaction: spec.compaction,
    stripFailed: spec.bounds?.watched !== undefined,
    stamp: record.stamp,
    instructions: { current: undefined },
    ...(reasoning ? { reasoning } : {}),
  });
}

/**
 * Pi's session factory. Its exact call shape into Pi is pinned by the
 * crewmate's, the seat's and the classifier's realSession contract tests;
 * change them together.
 */
export function createPiSessionFactory(deps: PiSessionDeps): SessionFactory {
  return {
    backend: "pi",
    controlProfile: PI_CONTROL_PROFILE,
    open: async (spec) => {
      if (spec.machine !== LOCAL_MACHINE_ID) {
        throw new Error(`A Pi session cannot run on machine ${spec.machine}.`);
      }
      const originalBinding = spec.binding;
      if (originalBinding.backend === "pi") {
        spec = {
          ...spec,
          binding: {
            ...originalBinding,
            runtime: speedRuntime(
              originalBinding.runtime,
              spec,
              deps.speedCapabilities ?? (() => undefined),
            ),
          },
        };
      }
      const binding = spec.binding;
      if (binding.backend !== "pi") {
        throw new Error(`A Pi session cannot serve a ${binding.backend} binding.`);
      }
      if (!admits(PI_CONTROL_PROFILE, spec.needs)) {
        throw new Error("A Pi session cannot steer the way this session needs.");
      }
      if (spec.builtins === "coding") {
        if (spec.shape.turns !== "rolling") {
          throw new Error("A Pi session serves the coding built-ins on a rolling session only.");
        }
        // The runbook skills and the person's plugins are staged in this
        // session's own folder beside its record, held until it closes
        // (INF-2054): Pi reads them where it was told they are for as long
        // as it runs.
        const staging =
          spec.runbookSkills || spec.personalResources
            ? await claimStagingFolder(spec.shape.record.dir)
            : undefined;
        try {
          const session = await openCoding(deps, spec, spec.shape.record, binding, staging?.dir);
          if (staging) void session.closed().then(staging.release, staging.release);
          return session;
        } catch (caught) {
          staging?.release();
          throw caught;
        }
      }
      return spec.shape.turns === "rolling"
        ? openRolling(deps, spec, spec.shape.record, binding)
        : openOneShot(deps, spec, binding.runtime);
    },
  };
}
