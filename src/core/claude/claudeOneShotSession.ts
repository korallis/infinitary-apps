import { randomUUID } from "node:crypto";
import { type Query, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { FmUsage } from "@shared/events";
import type { ModelSession, SessionEvent, SessionSpec } from "../session/session";
import type { ClaudeAccessSettings } from "./claudeAccess";
import { assertClaudeWorkSettings } from "./claudeAccess";
import { resolveClaudeExecutable } from "./claudeCli";
import { ClaudeClientExit } from "./claudeClientProcess";
import type { ClaudeNormalizeResult, ClaudeTurnFailure } from "./claudeEvents";
import { claudeModelName } from "./claudeModels";
import {
  CLAUDE_CONTROL_PROFILE,
  CLAUDE_MODEL_PROVIDER,
  ClaudeQueryCore,
  type ClaudeSessionDeps,
  MessageQueue,
  userMessage,
} from "./claudeQueryCore";
import { claudeSessionOptions } from "./claudeSessionOptions";

/**
 * The question's one-shot on Claude: ONE query, its one answer read off it,
 * and the account's store lease held for the session's whole life
 * (`session.ts` says how the shape is served).
 */

/** What a second prompt, a steer, or a prompt after dispose is told. */
const ONE_QUESTION_TEXT = "A one-shot session answers one question.";

export class ClaudeOneShotSession extends ClaudeQueryCore<SessionEvent> implements ModelSession {
  readonly sessionId = randomUUID();
  readonly controlProfile = CLAUDE_CONTROL_PROFILE;
  protected disposed = false;
  protected get interrupted(): boolean {
    return false;
  }
  private turn: { resolve: () => void; reject: (error: Error) => void } | undefined;
  private query: Query | undefined;
  private input: MessageQueue | undefined;
  private asked = false;
  /** A result arrived: the client exits on its own once its input ends. */
  private answered = false;
  private readonly request: RequestReading = {};
  private markClosed!: () => void;
  private readonly closedPromise = new Promise<void>((resolve) => {
    this.markClosed = resolve;
  });

  constructor(
    private readonly spec: SessionSpec,
    private readonly accountId: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly deps: ClaudeSessionDeps,
    /** Hands the account's store back; the lease ignores a second call. */
    private readonly releaseLease: () => void,
    /** The person's own token command, address and gateway headers, read as the session opened. */
    private readonly access?: ClaudeAccessSettings,
    /** A further login's own Claude Code folder; absent for the default login. */
    private readonly ownConfigDir?: string,
  ) {
    super(spec.owner);
  }

  resume(): undefined {
    return undefined;
  }

  recordPath(): undefined {
    return undefined;
  }

  isStreaming(): boolean {
    return this.turn !== undefined;
  }

  modelRef(): { provider: string; id: string } | undefined {
    return this.spec.model
      ? { provider: CLAUDE_MODEL_PROVIDER, id: this.spec.model.id }
      : undefined;
  }

  modelLabel(): string | undefined {
    return claudeModelName(this.spec.model?.id);
  }

  /** The one question. Settles on the client's one result, however it ends. */
  prompt(text: string): Promise<void> {
    if (this.disposed || this.asked) return Promise.reject(new Error(ONE_QUESTION_TEXT));
    this.asked = true;
    const settled = new Promise<void>((resolve, reject) => {
      this.turn = { resolve, reject };
    });
    void this.startQuestion(text);
    return settled;
  }

  private async startQuestion(text: string): Promise<void> {
    const input = new MessageQueue();
    const exit = new ClaudeClientExit();
    let query: Query;
    try {
      await assertClaudeWorkSettings(this.deps.resolveWorkSettings);
      // Abort and dispose settle the turn and return the lease while settings are pending.
      if (!this.turn) return;
      const options = claudeSessionOptions({
        spec: this.spec,
        env: this.env,
        executable: resolveClaudeExecutable(this.env),
        stderr: (data) => this.deps.log?.(data.trimEnd()),
        exit,
        ...(this.access ? { access: this.access } : {}),
        ...(this.ownConfigDir ? { ownConfigDir: this.ownConfigDir } : {}),
      });
      query = (this.deps.query ?? sdkQuery)({ prompt: input, options });
    } catch (caught) {
      if (this.turn) {
        this.release();
        this.rejectTurn(caught);
      }
      return;
    }
    this.query = query;
    this.input = input;
    input.push(userMessage(text));
    void this.pumpQuery(query, exit);
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

  /**
   * The caller's bound fired: the question is given up on now, and the
   * client stopped. A one-shot session has nothing to keep steerable, so it
   * does not wait for the client to agree. With a failure, the question
   * reports it as its turn's. The session closes once the client has exited.
   */
  async abort(failure?: string): Promise<void> {
    if (this.disposed) return;
    if (failure !== undefined && this.turn && !this.answered) {
      this.answered = true;
      this.emit({ type: "turn_failed", taskId: this.taskId, error: failure });
      this.emit({ type: "turn_end", taskId: this.taskId });
      this.emit({ type: "turn_closed" });
    }
    const pending = this.turn !== undefined;
    this.settleTurn();
    if (this.query) this.query.close();
    else if (pending) this.release();
  }

  /** A one-shot's client ends with its one answer; there is nothing to let go of between turns. */
  async detach(): Promise<void> {}

  /** Resolves once the client has exited and the store is free. */
  closed(): Promise<void> {
    return this.closedPromise;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.settleTurn();
    if (!this.query) {
      this.release();
      return;
    }
    this.input?.close();
    // A client that has answered exits on its own once its input ends; one
    // that has not is stopped. The lease comes back once it has exited.
    if (!this.answered) this.query.close();
  }

  protected observe(message: unknown, result: ClaudeNormalizeResult): void {
    if (result.rateLimit) this.deps.onRateLimit?.(this.accountId, result.rateLimit);
    readRequest(message, this.request);
    const cut = this.request.cutShort;
    if (!cut || this.answered) return;
    // The output cap cut the answer short. It is still the answer - Pi's
    // classifier reads the same truncated text and the parser takes the one
    // option word in it - and the client, left running, would ask for the
    // rest three more times. So it is read now and the client stopped.
    const usage: FmUsage = {
      ...(this.request.input ? { input: this.request.input } : {}),
      ...(cut.output ? { output: cut.output } : {}),
    };
    this.answer(
      {
        events: [
          {
            type: "turn_end",
            taskId: this.taskId,
            ...(Object.keys(usage).length > 0 ? { usage } : {}),
          },
        ],
      },
      this.request.text,
    );
    this.query?.close();
  }

  protected resultFailed(result: ClaudeNormalizeResult, failure: ClaudeTurnFailure): void {
    // A cut-short answer was already read: the client, stopped, has nothing
    // more to report about this question.
    if (this.answered) return;
    this.emit({
      type: "turn_failed",
      taskId: this.taskId,
      error: failure.error,
      ...(failure.cutOff ? { cutOff: failure.cutOff } : {}),
      ...(failure.contextOverflow ? { contextOverflow: true } : {}),
    });
    this.answer(result, undefined);
  }

  protected resultInterrupted(result: ClaudeNormalizeResult): void {
    this.answer(result, undefined);
  }

  protected resultClean(result: ClaudeNormalizeResult): void {
    this.deps.onServed?.(this.accountId);
    this.answer(result, result.finalText?.trim() || undefined);
  }

  protected streamFailed(caught: unknown): void {
    this.rejectTurn(caught);
  }

  protected streamEnded(): void {
    // The client has exited: the store is free.
    this.release();
    this.rejectTurn(new Error("Claude stopped before it answered."));
  }

  private release(): void {
    this.releaseLease();
    this.markClosed();
  }

  private settleTurn(): void {
    const turn = this.turn;
    this.turn = undefined;
    turn?.resolve();
  }

  private rejectTurn(caught: unknown): void {
    const turn = this.turn;
    this.turn = undefined;
    turn?.reject(caught instanceof Error ? caught : new Error(String(caught)));
  }

  private answer(result: ClaudeNormalizeResult, text: string | undefined): void {
    // A result the stopped client still delivers after a cut-short answer
    // was read is not a second answer.
    if (this.answered) return;
    this.answered = true;
    this.emitAll(result.events);
    this.emit({ type: "turn_closed", ...(text ? { text } : {}) });
    this.input?.close();
    this.settleTurn();
  }
}

/** What one streamed request says about the answer: its words, its tokens, and why it stopped. */
type RequestReading = { text?: string; input?: number; cutShort?: { output?: number } };

/**
 * Reads the main thread's request as it streams. The client hands over the
 * assistant message before the request's `message_delta`, and with
 * `stop_reason` still unset, so the typed stop - `max_tokens` - is read off
 * the streamed `message_delta` and the words off the message before it.
 */
function readRequest(message: unknown, reading: RequestReading): void {
  const record = message as {
    type?: unknown;
    parent_tool_use_id?: unknown;
    message?: { content?: unknown };
    event?: {
      type?: unknown;
      message?: { usage?: { input_tokens?: unknown } };
      delta?: { stop_reason?: unknown };
      usage?: { output_tokens?: unknown };
    };
  } | null;
  if (record?.parent_tool_use_id !== null && record?.parent_tool_use_id !== undefined) return;
  if (record?.type === "assistant") {
    const content = Array.isArray(record.message?.content) ? record.message.content : [];
    const text = content
      .flatMap((block: { type?: unknown; text?: unknown }) =>
        block?.type === "text" && typeof block.text === "string" ? [block.text] : [],
      )
      .join("")
      .trim();
    if (text) reading.text = text;
    return;
  }
  if (record?.type !== "stream_event") return;
  const event = record.event;
  if (event?.type === "message_start") {
    const input = event.message?.usage?.input_tokens;
    if (typeof input === "number") reading.input = input;
  }
  if (event?.type === "message_delta" && event.delta?.stop_reason === "max_tokens") {
    const output = event.usage?.output_tokens;
    reading.cutShort = typeof output === "number" ? { output } : {};
  }
}
