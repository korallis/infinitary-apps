import type { Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { FmEvent } from "@shared/events";
import type { SessionClock } from "../session/bounds";
import type { ControlProfile, SessionImage } from "../session/session";
import { bareToolName } from "../storage/sessionReader";
import type { SessionRecordStore } from "../storage/sessionRecordStore";
import type { ClaudeAccessSettings, ResolveClaudeSettings } from "./claudeAccess";
import { type ClaudeClientCheck, checkClaudeClient, claudeClientIssueText } from "./claudeCli";
import type { ClaudeClientExit } from "./claudeClientProcess";
import type { ClaudeCostReports } from "./claudeCostReports";
import {
  type ClaudeNormalizeResult,
  type ClaudeNormalizerState,
  type ClaudeRateLimit,
  createNormalizerState,
  fmEventsFromClaudeMessage,
} from "./claudeEvents";
import type { ClaudeCompanyReporting } from "./claudeReporting";

/**
 * The core both Claude sessions stand on - the rolling session
 * (`claudeRollingSession.ts`) and the one-shot (`claudeOneShotSession.ts`),
 * which the factory (`session.ts`) opens: what they run on, the push-to-pull
 * input queue, the user message the client reads, and the pump that reads
 * the client's messages and normalizes them. Each session owns its turn
 * and life state, including when a turn ends and what a failed one says;
 * the pump reads that state but never keeps a second copy.
 */

/**
 * Claude's streaming-input session delivers the whole contract natively.
 * One constant, so the factory's declaration and each session's own cannot
 * drift apart.
 */
export const CLAUDE_CONTROL_PROFILE: ControlProfile = {
  steer: "native",
  interruptGranularity: "turn",
  quotaEvents: true,
  // The client owns its own background work and keeps working after a
  // prompt settles, so the host sees activity but never a provable stop.
  // The whose-turn rule answers "cannot tell" here (S7c, R4.8 q2).
  backgroundWork: "client",
  // Every failed turn is classified from the SDK's typed fields
  // (`classifyClaudeSignal`), never from the words it reports.
  failureSignals: "typed",
};

export type ClaudeQueryFactory = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => Query;

/** The provider id a Claude session reports as its model's provider. */
export const CLAUDE_MODEL_PROVIDER = "anthropic-claude";

export type ClaudeSessionDeps = {
  /**
   * The machine's default Claude config root: the store the lease guards,
   * and where the client keeps a rolling session's own transcript.
   */
  configDir: string;
  /**
   * A further Claude login's own Claude Code folder, by account; nothing for
   * the default login. It throws for an account that is gone, which refuses
   * the session. Absent, every account runs on the default login.
   */
  ownConfigDir?: (accountId: string) => string | undefined;
  /** Whether managed settings permit app-local cost exports; absence keeps terminal accounting. */
  costReportingAllowed?: () => Promise<boolean>;
  /**
   * A company's Claude Code reporting setup from the person's settings file,
   * login shell and this launch environment, read as each client starts; the
   * receiver passes the client's records on to it (`claudeReporting.ts`).
   * Absent, nothing is passed on.
   */
  companyReporting?: (env: NodeJS.ProcessEnv) => Promise<ClaudeCompanyReporting | undefined>;
  /** One lazy receiver for all this factory's rolling attachments. */
  costReports?: Pick<ClaudeCostReports, "subscribe">;
  /**
   * The host's one clock: every rolling session reads it, and its record's
   * copy and its client hygiene ride its ticks.
   */
  clock?: SessionClock;
  /**
   * The app's durable record of the rolling sessions in a directory;
   * production keeps one store per directory. Tests hand in their own.
   */
  records?: (dir: string) => SessionRecordStore;
  /** A plan-window reading the client pushed, for the account's quota. */
  onRateLimit?: (accountId: string, reading: ClaudeRateLimit) => void;
  /** A turn succeeded on this account: the provider accepted its login. */
  onServed?: (accountId: string) => void;
  /** The client's own stderr, and the session's notes about the client. */
  log?: (line: string) => void;
  /** The environment the client is found in and run from; production reads the host's. */
  env?: () => NodeJS.ProcessEnv;
  /** Is the client there and new enough; production spawns `claude --version` once per binary. */
  checkClient?: (env: NodeJS.ProcessEnv) => Promise<ClaudeClientCheck>;
  /** The SDK's query; tests script one. */
  query?: ClaudeQueryFactory;
  /**
   * The person's own Claude Code token command, address and gateway headers, read as each
   * client starts and handed to it as the app's flag settings
   * (`claudeAccess.ts`). Production reads them with the client library's
   * settings reader; tests that leave it out hand the client none.
   */
  accessSettings?: () => Promise<ClaudeAccessSettings>;
  resolveWorkSettings?: ResolveClaudeSettings;
};

/**
 * The login store one account's client runs on: a further login's own
 * folder (`own`), which the client is pointed at, or the default one, which
 * it reaches with no folder named. The store lease and the client's
 * transcripts are per store.
 */
export function claudeLoginStore(
  deps: Pick<ClaudeSessionDeps, "configDir" | "ownConfigDir">,
  accountId: string,
): { dir: string; own: boolean } {
  const own = deps.ownConfigDir?.(accountId);
  return own ? { dir: own, own: true } : { dir: deps.configDir, own: false };
}

export function noteTo(deps: ClaudeSessionDeps): (line: string) => void {
  return deps.log ?? ((line) => console.warn(`[claude] ${line}`));
}

/**
 * The machine's own client (F14), checked at every open and attachment:
 * refuse with its sentence, before anything is leased, when it is gone or old.
 */
export async function refuseMissingClient(
  deps: ClaudeSessionDeps,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const issue = claudeClientIssueText(await (deps.checkClient ?? checkClaudeClient)(env));
  if (issue) throw new Error(issue);
}

/**
 * A hand-rolled queue, because the input side of a streaming-input session
 * is push (the orchestrator prompts and steers whenever it likes) while the
 * SDK wants pull (an async iterable). Closing it ends the session cleanly.
 */
export class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private readonly buffered: SDKUserMessage[] = [];
  /** Consumers awaiting a message. A list, so an overlapped read is not lost. */
  private readonly waiting: ((value: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) return;
    const waiting = this.waiting.shift();
    if (waiting) {
      waiting({ value: message, done: false });
      return;
    }
    this.buffered.push(message);
  }

  close(): void {
    this.closed = true;
    while (this.waiting.length > 0) {
      this.waiting.shift()?.({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const buffered = this.buffered.shift();
        if (buffered) return Promise.resolve({ value: buffered, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          this.waiting.push(resolve);
        });
      },
    };
  }
}

/**
 * One user message as the client reads it. `uuid` stamps it, so the client
 * can acknowledge it by that id when a turn takes it in (a rolling session
 * asks for the acknowledgement; a one-shot does not).
 */
export function userMessage(
  text: string,
  priority?: SDKUserMessage["priority"],
  images?: SessionImage[],
  uuid?: string,
): SDKUserMessage {
  const imageBlocks = (images ?? []).flatMap((image) => {
    if (
      image.mimeType !== "image/png" &&
      image.mimeType !== "image/jpeg" &&
      image.mimeType !== "image/gif" &&
      image.mimeType !== "image/webp"
    ) {
      return [];
    }
    return [
      {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: image.mimeType,
          data: image.data,
        },
      },
    ];
  });
  const content =
    imageBlocks.length === 0
      ? text
      : ([{ type: "text" as const, text }, ...imageBlocks] as SDKUserMessage["message"]["content"]);
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    ...(priority ? { priority } : {}),
    ...(uuid ? { uuid: uuid as SDKUserMessage["uuid"] } : {}),
  };
}

/** How an interrupted turn settles, mirroring the Pi seam's rejection. */
export const INTERRUPTED_MESSAGE = "The turn was interrupted.";

/**
 * The pump / apply core. `E` is what the session tells its
 * subscribers: the session contract's events.
 *
 * Every message is normalized once (`fmEventsFromClaudeMessage`). A result
 * is routed by the one rule both sessions share: a typed failure is the
 * provider failing the turn, unless it is only the host's own interrupt
 * landing (a cut-off answering an interrupt is still news, and consumes
 * it); an interrupt with no failure is the interrupt; anything else is a
 * clean result. What each of those means for the awaited turn is the
 * session's own (`resultFailed`, `resultInterrupted`, `resultClean`).
 */
export abstract class ClaudeQueryCore<E extends { type: string }> {
  private readonly listeners = new Set<(event: E) => void>();
  /** Events seen before anyone subscribed; replayed on the first subscribe. */
  private pending: E[] = [];
  /** The normalizer's running state; a session that swaps clients starts it over per client. */
  protected normalizer: ClaudeNormalizerState = createNormalizerState();
  /** The session's life and current turn, read without owning either. */
  protected abstract get disposed(): boolean;
  protected abstract get interrupted(): boolean;

  constructor(protected readonly taskId: string) {}

  subscribe(listener: (event: E) => void): () => void {
    this.listeners.add(listener);
    const replay = this.pending;
    this.pending = [];
    for (const event of replay) listener(event);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Consume one query's messages for as long as it runs, then wait for the
   * client it spawned to exit: the SDK ends a closed query's stream after at
   * most 2 s, whether its client has gone or not (`claudeClientProcess.ts`).
   */
  protected async pumpQuery(query: AsyncIterable<unknown>, exit?: ClaudeClientExit): Promise<void> {
    try {
      for await (const message of query) {
        this.apply(message);
      }
    } catch (caught) {
      if (!this.disposed) this.streamFailed(caught, query);
    } finally {
      const running = exit?.running();
      if (running) await running;
      this.streamEnded(query);
    }
  }

  private apply(message: unknown): void {
    const result = this.normalized(
      fmEventsFromClaudeMessage(message, this.taskId, this.normalizer),
      message,
    );
    const type = (message as { type?: unknown } | null)?.type;
    this.observe(message, result);
    if (type !== "result") {
      this.emitAll(result.events);
      return;
    }
    const interruptLanded = this.interrupted && !result.failure?.cutOff;
    if (result.failure && !interruptLanded) {
      this.resultFailed(result, result.failure);
    } else if (this.interrupted) {
      this.resultInterrupted(result);
    } else {
      this.resultClean(result);
    }
  }

  /** A rolling session reconciles call reports before the ordinary result is routed. */
  protected normalized(result: ClaudeNormalizeResult, _message: unknown): ClaudeNormalizeResult {
    return result;
  }

  /** Every message, before it is routed: ids, model, activity, the session's own signals. */
  protected abstract observe(message: unknown, result: ClaudeNormalizeResult): void;
  /** The provider failed a turn; its class, when it has one, rides `failure.cutOff`. */
  protected abstract resultFailed(
    result: ClaudeNormalizeResult,
    failure: NonNullable<ClaudeNormalizeResult["failure"]>,
  ): void;
  /** The host's own interrupt landed. */
  protected abstract resultInterrupted(result: ClaudeNormalizeResult): void;
  /** A turn finished on its own. */
  protected abstract resultClean(result: ClaudeNormalizeResult): void;
  /** The client's stream threw: nothing further arrives on it. */
  protected abstract streamFailed(caught: unknown, stream: AsyncIterable<unknown>): void;
  /** The client's stream is over and the client has exited, however it ended. */
  protected abstract streamEnded(stream: AsyncIterable<unknown>): void;

  protected emit(event: E): void {
    if (this.listeners.size === 0) {
      this.pending.push(event);
      return;
    }
    for (const listener of this.listeners) listener(event);
  }

  /**
   * A normalized FmEvent is always one of `E`: both sessions' unions contain
   * FmEvent. A session speaks the spec's tools by their own names: the client
   * serves each under the app's server (`mcp__infinitary__<name>`), and the
   * decision record, the feed and the replay read the bare one.
   */
  protected emitAll(events: readonly FmEvent[]): void {
    for (const event of events) {
      const spoken =
        event.type === "tool_start" || event.type === "tool_end"
          ? { ...event, toolName: bareToolName(event.toolName) }
          : event;
      this.emit(spoken as unknown as E);
    }
  }
}
