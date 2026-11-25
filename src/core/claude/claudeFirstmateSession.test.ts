import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_CLIENT_MISSING_TEXT } from "@shared/claudeClient";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_MCP_DEFAULT_OUTPUT_TOKENS } from "../../../tests/helpers/claudeMcpLimit";
import { type ManualClock, manualClock } from "../../../tests/helpers/manualClock";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  type ScriptedAttachment,
  scriptedClaudeQuery,
} from "../../../tests/helpers/scriptedClaudeQuery";
import { type SeatTestSpec, seatSpec } from "../../../tests/helpers/seatSession";
import { QUIET_FEED_MS } from "../orchestrator/crewWatch";
import {
  FIRSTMATE_MAX_MODEL_TURNS,
  FIRSTMATE_MAX_OUTPUT_TOKENS,
  FIRSTMATE_REQUEST_TIMEOUT_MS,
} from "../orchestrator/seat";
import { TICK_PERIOD_MS } from "../orchestrator/ticker";
import {
  buildFirstmateSystemPrompt,
  FIRSTMATE_CONTRACT_VERSION,
  firstmatePromptSha,
  toolFingerprints,
  toolsFingerprint,
} from "../pi/piResources";
import {
  BoundsWatcher,
  outputCapErrorMessage,
  requestTimeoutErrorMessage,
  turnTimeoutErrorMessage,
} from "../session/bounds";
import { summaryCompaction } from "../session/compaction";
import type { ModelSession, SessionEvent } from "../session/session";
import { boundTool } from "../session/tools";
import { CLAUDE_SEAT_TOOL_SERVER } from "../storage/sessionReader";
import { SessionRecordStore } from "../storage/sessionRecordStore";
import type { ClaudeClientCheck } from "./claudeCli";
import type { ClaudeRateLimit } from "./claudeEvents";
import { CLAUDE_FIRSTMATE_MCP_OUTPUT_TOKENS, CLAUDE_STEER_PRIORITY } from "./claudeSessionOptions";
import {
  hasActiveSession,
  resetStoreLeasesForTest,
  runExclusiveStoreTask,
} from "./claudeStoreLease";
import { encodeClaudeProjectDir } from "./claudeTranscript";
import { createClaudeSessionFactory } from "./session";

/**
 * The Claude seat against a scripted client (W1 S6). The message shapes are
 * the ones the pinned client was measured emitting (the integration test
 * runs the real one): a `session_state_changed` running/idle pair around
 * every prompt, an acknowledgement echoing each pushed message's uuid, and
 * one result per turn.
 */

const ACCOUNT = "acct_claude";
const MODEL = "claude-opus-5-5";

/** One turn's usage as the seat reports it: the served model's share, and their sum. */
function spent(input: number, output: number) {
  const counts = { input, output, cacheRead: 0, cacheWrite: 0 };
  return { ...counts, models: [{ model: MODEL, ...counts }] };
}

const crewStatus = boundTool({
  name: "crew_status",
  label: "Crew status",
  description: "What the crew is doing.",
  parameters: Type.Object({}),
  run: () => ({ text: "all idle" }),
});

type Seat = {
  /** Opens the seat preset through Claude's session factory, its record in this seat's store. */
  factory: (spec: SeatTestSpec) => Promise<ModelSession>;
  attachments: ScriptedAttachment[];
  harness: () => ScriptedAttachment;
  /** The script has received this many inputs, across attachments. */
  input: (count?: number) => Promise<void>;
  store: SessionRecordStore;
  configDir: string;
  clock: ManualClock;
  readings: Array<{ accountId: string; reading: ClaudeRateLimit }>;
  logs: string[];
};

function seat(
  options: {
    onInput?: (message: SDKUserMessage, emit: (message: unknown) => void) => void;
    onInterrupt?: (emit: (message: unknown) => void) => void;
    ignoresEndOfInput?: boolean;
    /** What the client check answers; read at each check, so a test can change it. */
    check?: { current: ClaudeClientCheck };
    env?: NodeJS.ProcessEnv;
  } = {},
): Seat {
  const dir = scratchDir("infinitary-claude-seat-");
  const claudeDir = join(dir, "firstmate", "claude");
  const store = new SessionRecordStore(claudeDir);
  stores.push(store);
  const clock = manualClock();
  const readings: Seat["readings"] = [];
  const logs: string[] = [];
  let inputs = 0;
  const waiting: { count: number; resolve: () => void }[] = [];
  const scripted = scriptedClaudeQuery({
    onInput: (message, emit) => {
      options.onInput?.(message, emit);
      inputs++;
      for (const waiter of waiting.filter((waiter) => inputs >= waiter.count)) waiter.resolve();
    },
    ...(options.onInterrupt ? { onInterrupt: options.onInterrupt } : {}),
    ...(options.ignoresEndOfInput ? { ignoresEndOfInput: true } : {}),
  });
  const configDir = join(dir, "claude-config");
  // As the app opens it: Claude's factory under the one watcher, both on the host's clock.
  const sessions = new BoundsWatcher(clock).factory(
    createClaudeSessionFactory({
      configDir,
      records: (recordDir) => {
        if (recordDir !== claudeDir) throw new Error(`the seat's record is not in ${recordDir}`);
        return store;
      },
      clock,
      onRateLimit: (accountId, reading) => readings.push({ accountId, reading }),
      log: (line) => logs.push(line),
      env: () => ({
        PATH: "/usr/bin",
        HOME: dir,
        INFINITARY_CLAUDE_CLI: "/nonexistent/claude",
        ...options.env,
      }),
      checkClient: async () =>
        options.check?.current ?? { state: "ready", executable: "/bin/claude" },
      query: scripted.factory,
    }),
  );
  return {
    factory: (spec) => sessions.open(seatSpec({ ...spec, claudeDir })),
    attachments: scripted.attachments,
    harness: scripted.harness,
    input: (count = 1) =>
      inputs >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiting.push({ count, resolve })),
    store,
    configDir,
    clock,
    readings,
    logs,
  };
}

/** Lines the client appends to its own transcript of a session, where it keeps it. */
function clientWrites(s: Seat, sessionId: string, entries: object[]): void {
  const dir = join(s.configDir, "projects", encodeClaudeProjectDir(CWD));
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    join(dir, `${sessionId}.jsonl`),
    entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
  );
}

const CWD = "/tmp/firstmate/home";

function spec(overrides: Partial<SeatTestSpec> = {}): SeatTestSpec {
  return {
    cwd: CWD,
    sessionsDir: "/tmp/firstmate/sessions",
    binding: { backend: "claude", accountId: ACCOUNT },
    model: { provider: "anthropic-claude", id: MODEL },
    tools: [crewStatus],
    instructions: { text: "Say hello first.", sha: "sha-1" },
    ...overrides,
  };
}

/** The client's side of one prompt, in the order it was measured saying it. */
const say = {
  running: { type: "system", subtype: "session_state_changed", state: "running" },
  idle: { type: "system", subtype: "session_state_changed", state: "idle" },
  init: { type: "system", subtype: "init", session_id: "s", model: MODEL },
  ack: (input: SDKUserMessage) => ({
    type: "user",
    isReplay: true,
    uuid: input.uuid,
    message: input.message,
    parent_tool_use_id: null,
  }),
  messageStart: { type: "stream_event", event: { type: "message_start" } },
  toolUse: (id: string, name = "mcp__infinitary__crew_status") => ({
    type: "assistant",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_use", id, name, input: {} }] },
  }),
  toolResult: (id: string) => ({
    type: "user",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_result", tool_use_id: id, content: "all idle" }] },
  }),
  result: (text: string, totals = { input: 10, output: 5 }) => ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    total_cost_usd: 0,
    modelUsage: {
      [MODEL]: {
        inputTokens: totals.input,
        outputTokens: totals.output,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
  }),
};

function answering(text = "Aye.") {
  return (message: SDKUserMessage, emit: (message: unknown) => void) => {
    emit(say.running);
    emit(say.ack(message));
    emit(say.result(text));
    emit(say.idle);
  };
}

function recorder(session: ModelSession): SessionEvent[] {
  const events: SessionEvent[] = [];
  // Read witnesses have their own contract test; these journeys measure
  // the turn, tool and bounds events independently of input bookkeeping.
  session.subscribe((event) => {
    if (event.type !== "input_read") events.push(event);
  });
  return events;
}

/** INF-2248: a bound starts at the observed session event, never at a guessed number of loop turns. */
function nextEvent(session: ModelSession, type: SessionEvent["type"]): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = session.subscribe((event) => {
      if (event.type !== type) return;
      unsubscribe();
      resolve();
    });
  });
}

/** Let the session's pump and the scripted client catch up. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Every store a test made: its sidecar stamps land before the test's directory goes. */
const stores: SessionRecordStore[] = [];

afterEach(async () => {
  resetStoreLeasesForTest();
  await Promise.all(stores.splice(0).map((store) => store.flushed()));
});

describe("the Claude seat's options (the contract test)", () => {
  // INF-133 F1: captain chose a higher host-owned limit for first mate Claude sessions.
  it("pins a higher MCP output cap instead of leaving it to ambient or remote configuration", async () => {
    const s = seat({ onInput: answering(), env: { MAX_MCP_OUTPUT_TOKENS: "1" } });
    const session = await s.factory(spec());
    await session.prompt("Read the saved plan.");
    expect(s.harness().options.env?.MAX_MCP_OUTPUT_TOKENS).toBe(
      String(CLAUDE_FIRSTMATE_MCP_OUTPUT_TOKENS),
    );
    // INF-416 piece K preserves INF-133's exact cap; this seat test owns that pin.
    expect(CLAUDE_FIRSTMATE_MCP_OUTPUT_TOKENS).toBe(100_000);
    expect(CLAUDE_FIRSTMATE_MCP_OUTPUT_TOKENS).toBeGreaterThan(CLAUDE_MCP_DEFAULT_OUTPUT_TOKENS);
    session.dispose();
    await session.closed();
  });

  it("attaches the client exactly as the seat's contract pins", async () => {
    const s = seat({ onInput: answering() });
    const session = await s.factory(spec());
    await session.prompt("hello");
    const options = s.harness().options;
    // The machine's default login, nothing ambient, plus the idle signal.
    expect(options.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(options.env?.CLAUDE_CODE_ENTRYPOINT).toBe("infinitary");
    expect(options.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(options.env?.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(options.env?.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe("1");
    // None of the client's per-turn extras (docs/claude-client.md), nor
    // the person's Claude notes.
    expect(options.env?.CLAUDE_CODE_DISABLE_ATTACHMENTS).toBe("1");
    expect(options.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect(options.cwd).toBe("/tmp/firstmate/home");
    expect(options.settingSources).toEqual([]);
    // The byte-stable prompt is the cached prefix; the captain's words follow the boundary.
    expect(options.systemPrompt).toEqual([
      buildFirstmateSystemPrompt("claude"),
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      "Say hello first.",
    ]);
    // No built-in tool; only the app's own server, always loaded.
    expect(options.tools).toEqual([]);
    expect(Object.keys(options.mcpServers ?? {})).toEqual([CLAUDE_SEAT_TOOL_SERVER]);
    expect(options.mcpServers?.[CLAUDE_SEAT_TOOL_SERVER]).toMatchObject({
      type: "sdk",
      name: CLAUDE_SEAT_TOOL_SERVER,
    });
    expect(options.strictMcpConfig).toBe(true);
    expect(options.permissionMode).toBe("bypassPermissions");
    expect(options.allowDangerouslySkipPermissions).toBe(true);
    expect(options.includePartialMessages).toBe(true);
    expect(options.effort).toBe("low");
    // The seat's request bounds, in the client's own terms (decision D5): the
    // output cap, with the seat's thinking inside it, and the model-turn cap.
    expect(options.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe(String(FIRSTMATE_MAX_OUTPUT_TOKENS));
    expect(options.thinking).toBeUndefined();
    expect(options.maxTurns).toBe(FIRSTMATE_MAX_MODEL_TURNS);
    expect(options.model).toBe(MODEL);
    // A fresh session runs under the id the seat minted and told the agent.
    expect(options.sessionId).toBe(session.sessionId);
    expect(options.resume).toBeUndefined();
    // Not the SDK's session store: resuming from one has the SDK read the
    // person's credential. The app copies the client's transcript instead.
    expect(options.sessionStore).toBeUndefined();
    // The client keeps its own transcript, which the seat resumes and copies.
    expect(options.persistSession).toBeUndefined();
    // Each pushed message is acknowledged by its uuid.
    expect(options.extraArgs).toEqual({ "replay-user-messages": null });
    expect(typeof options.stderr).toBe("function");
    session.dispose();
  });

  it("serves no instructions section when the captain has none", async () => {
    const s = seat({ onInput: answering() });
    const session = await s.factory(spec({ instructions: { text: "", sha: "empty" } }));
    await session.prompt("hello");
    expect(s.harness().options.systemPrompt).toEqual([
      buildFirstmateSystemPrompt("claude"),
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    ]);
    session.dispose();
  });
});

it("INF-447: the app owns compaction settings and removes all ambient budget overrides", async () => {
  const switches = {
    DISABLE_AUTO_COMPACT: "1",
    DISABLE_COMPACT: "1",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "100",
    CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE: "1000000",
  };
  const s = seat({ onInput: answering(), env: switches });
  const session = await s.factory(spec());
  await session.prompt("hello");
  for (const key of Object.keys(switches)) expect(s.harness().options.env?.[key]).toBeUndefined();
  expect(s.harness().options.settings).toMatchObject({
    autoCompactEnabled: true,
    autoCompactWindow: 321192,
  });
  session.dispose();
});

describe("the Claude seat's attachment", () => {
  it("checks the client at every attachment and leases nothing when it is missing", async () => {
    const s = seat({ check: { current: { state: "missing" } } });
    await expect(s.factory(spec())).rejects.toThrow(CLAUDE_CLIENT_MISSING_TEXT);
    expect(hasActiveSession(s.configDir)).toBe(false);
    expect(s.attachments).toHaveLength(0);
  });

  it("leases the account's store per client, from its attach until it has exited", async () => {
    const s = seat({ onInput: answering() });
    const session = await s.factory(spec());
    // No client yet, so nothing holds the store.
    expect(hasActiveSession(s.configDir)).toBe(false);
    await session.prompt("hello");
    expect(hasActiveSession(s.configDir)).toBe(true);
    session.dispose();
    // Its input ends; the client exits on its own, after its last writes.
    await session.closed();
    expect(hasActiveSession(s.configDir)).toBe(false);
    expect(s.harness().closed()).toBe(true);
  });

  it("detaches at an idle boundary: the client exits, the store is free, the next prompt resumes", async () => {
    const s = seat({ onInput: answering() });
    const session = await s.factory(spec());
    await session.prompt("hello");
    clientWrites(s, session.sessionId, [
      { type: "user", uuid: "u1", message: { role: "user", content: "hello" } },
    ]);
    await session.detach?.();
    expect(s.harness().closed()).toBe(true);
    expect(hasActiveSession(s.configDir)).toBe(false);
    await session.prompt("again");
    expect(s.attachments).toHaveLength(2);
    expect(s.harness().options.resume).toBe(session.sessionId);
    expect(hasActiveSession(s.configDir)).toBe(true);
    session.dispose();
    await session.closed();
  });

  it("detaches only once the open turn has settled, never mid-turn", async () => {
    let emit: ((message: unknown) => void) | undefined;
    const s = seat({
      onInput: (message, send) => {
        emit = send;
        send(say.running);
        send(say.ack(message));
      },
    });
    const session = await s.factory(spec());
    const prompt = session.prompt("hello");
    await s.input(1);
    let detached = false;
    const detach = session.detach?.().then(() => {
      detached = true;
    });
    await settle();
    expect(detached).toBe(false);
    expect(s.harness().closed()).toBe(false);
    emit?.(say.result("Aye."));
    emit?.(say.idle);
    await prompt;
    await detach;
    expect(detached).toBe(true);
    expect(s.harness().closed()).toBe(true);
    expect(hasActiveSession(s.configDir)).toBe(false);
    session.dispose();
  });

  it("waits out a sign-in in progress before its client attaches", async () => {
    const s = seat({ onInput: answering() });
    const session = await s.factory(spec());
    let finishSignIn!: () => void;
    const signIn = runExclusiveStoreTask(
      s.configDir,
      () => new Promise<void>((resolve) => (finishSignIn = resolve)),
    );
    const prompt = session.prompt("hello");
    await settle();
    expect(s.attachments).toHaveLength(0);
    finishSignIn();
    await signIn;
    await prompt;
    expect(s.attachments).toHaveLength(1);
    session.dispose();
    await session.closed();
  });

  it("spawns no orphan when an attach outlives its prompt behind a sign-in (P4)", async () => {
    const s = seat({ onInput: answering() });
    const session = await s.factory(spec({ requestTimeoutMs: 300_000 }));
    let finishSignIn!: () => void;
    const signIn = runExclusiveStoreTask(
      s.configDir,
      () => new Promise<void>((resolve) => (finishSignIn = resolve)),
    );
    const first = session.prompt("first");
    await settle();
    // The bound gives up on the first prompt while its attach still waits.
    s.clock.advance(TICK_PERIOD_MS * 5);
    s.clock.advance(TICK_PERIOD_MS);
    await first;
    const second = session.prompt("second");
    await settle();
    finishSignIn();
    await signIn;
    await second;
    // One client, answering the prompt that is still open.
    expect(s.attachments).toHaveLength(1);
    expect(s.harness().inputs).toHaveLength(1);
    session.dispose();
    await session.closed();
    expect(s.attachments.every((attachment) => attachment.closed())).toBe(true);
    expect(hasActiveSession(s.configDir)).toBe(false);
  });

  it("keeps its word on detach while an abandoned attach waits (P5)", async () => {
    const s = seat({ onInput: answering() });
    const session = await s.factory(spec({ requestTimeoutMs: 300_000 }));
    let finishSignIn!: () => void;
    const signIn = runExclusiveStoreTask(
      s.configDir,
      () => new Promise<void>((resolve) => (finishSignIn = resolve)),
    );
    const first = session.prompt("first");
    await settle();
    s.clock.advance(TICK_PERIOD_MS * 5);
    s.clock.advance(TICK_PERIOD_MS);
    await first;
    await session.detach?.();
    expect(hasActiveSession(s.configDir)).toBe(false);
    finishSignIn();
    await signIn;
    await settle();
    // The abandoned attach spawned nothing once the store was free.
    expect(s.attachments).toHaveLength(0);
    expect(hasActiveSession(s.configDir)).toBe(false);
    session.dispose();
    await session.closed();
  });

  it("checks the client again at every reattach, leasing nothing when it is gone", async () => {
    const check: { current: ClaudeClientCheck } = {
      current: { state: "ready", executable: "/bin/claude" },
    };
    const s = seat({ onInput: answering(), check });
    const session = await s.factory(spec());
    await session.prompt("hello");
    await session.detach?.();
    check.current = { state: "missing" };
    await expect(session.prompt("again")).rejects.toThrow(CLAUDE_CLIENT_MISSING_TEXT);
    expect(s.attachments).toHaveLength(1);
    expect(hasActiveSession(s.configDir)).toBe(false);
    session.dispose();
  });

  it("stops a client that is still running a tick after its input ended", async () => {
    const s = seat({ onInput: answering(), ignoresEndOfInput: true });
    const session = await s.factory(spec());
    await session.prompt("hello");
    session.dispose();
    await settle();
    expect(s.harness().closed()).toBe(false);
    expect(hasActiveSession(s.configDir)).toBe(true);
    s.clock.advance(TICK_PERIOD_MS);
    await session.closed();
    expect(s.harness().closed()).toBe(true);
    expect(hasActiveSession(s.configDir)).toBe(false);
  });

  it("resumes a recorded session by its id", async () => {
    const s = seat({ onInput: answering() });
    clientWrites(s, "11111111-2222-4333-8444-555555555555", [
      { type: "user", uuid: "u1", message: { role: "user", content: "earlier" } },
    ]);
    // Its record names the contract it started under, as every seat's does.
    await s.store.stamp("11111111-2222-4333-8444-555555555555", {
      kind: "contract",
      at: 1,
      version: FIRSTMATE_CONTRACT_VERSION,
      prompt_sha: firstmatePromptSha("claude"),
      instructions_sha: "sha-1",
      tools_sha: toolsFingerprint([crewStatus]),
    });
    const session = await s.factory(
      spec({ resume: { backend: "claude", sessionId: "11111111-2222-4333-8444-555555555555" } }),
    );
    expect(session.sessionId).toBe("11111111-2222-4333-8444-555555555555");
    await session.prompt("hello");
    expect(s.harness().options.resume).toBe("11111111-2222-4333-8444-555555555555");
    expect(s.harness().options.sessionId).toBeUndefined();
    session.dispose();
  });

  it("starts a new session from one recorded before seats named each tool, once its tool surface moved", async () => {
    const s = seat({ onInput: answering() });
    const recorded = "11111111-2222-4333-8444-555555555555";
    clientWrites(s, recorded, [
      { type: "user", uuid: "u1", message: { role: "user", content: "earlier" } },
    ]);
    // Stamped before seats named each tool, on a build that described
    // crew_status otherwise: the client would serve those words on resume.
    await s.store.stamp(recorded, {
      kind: "contract",
      at: 1,
      version: FIRSTMATE_CONTRACT_VERSION,
      prompt_sha: firstmatePromptSha("claude"),
      instructions_sha: "sha-1",
      tools_sha: toolsFingerprint([{ ...crewStatus, description: "What the crew was doing." }]),
    });
    const session = await s.factory(spec({ resume: { backend: "claude", sessionId: recorded } }));
    expect(session.sessionId).not.toBe(recorded);
    expect(session.takeRenewal()).toEqual({ from: recorded, changed: ["prompt"] });
    await session.prompt("hello");
    expect(s.harness().options.resume).toBeUndefined();
    expect(s.harness().options.sessionId).toBe(session.sessionId);
    session.dispose();
  });

  it("starts fresh, under a new id, when the recorded id has no transcript", async () => {
    const s = seat({ onInput: answering() });
    const session = await s.factory(
      spec({ resume: { backend: "claude", sessionId: "99999999-2222-4333-8444-555555555555" } }),
    );
    expect(session.sessionId).not.toBe("99999999-2222-4333-8444-555555555555");
    await session.prompt("hello");
    expect(s.harness().options.resume).toBeUndefined();
    expect(s.harness().options.sessionId).toBe(session.sessionId);
    expect(s.logs.join("\n")).toContain("starting fresh");
    session.dispose();
  });

  it("stamps the contract that serves the session in its sidecar, once per change", async () => {
    const s = seat({ onInput: answering() });
    const session = await s.factory(spec());
    await session.prompt("hello");
    await s.store.flushed();
    expect(s.store.sidecar(session.sessionId).filter((line) => line.kind === "contract")).toEqual([
      {
        kind: "contract",
        at: expect.any(Number),
        version: FIRSTMATE_CONTRACT_VERSION,
        prompt_sha: firstmatePromptSha("claude"),
        instructions_sha: "sha-1",
        tools_sha: toolsFingerprint([crewStatus]),
        tool_shas: toolFingerprints([crewStatus]),
      },
    ]);
    session.dispose();
  });
});

describe("the Claude seat's turns", () => {
  it("settles a prompt when the client is idle, not on its first result", async () => {
    let input: SDKUserMessage | undefined;
    let emit: ((message: unknown) => void) | undefined;
    const s = seat({
      onInput: (message, send) => {
        input = message;
        emit = send;
      },
    });
    const session = await s.factory(spec());
    const events = recorder(session);
    let settled = false;
    const prompt = session.prompt("hello").then(() => {
      settled = true;
    });
    await s.input(1);
    expect(session.isStreaming()).toBe(true);
    emit?.(say.running);
    emit?.(say.ack(input as SDKUserMessage));
    emit?.(say.result("Aye."));
    await settle();
    expect(settled).toBe(false);
    emit?.(say.idle);
    await prompt;
    expect(settled).toBe(true);
    expect(session.isStreaming()).toBe(false);
    expect(events).toEqual([
      { type: "turn_end", taskId: "firstmate", usage: spent(10, 5) },
      { type: "turn_closed", text: "Aye." },
    ]);
    session.dispose();
  });

  it("steers into the running turn at the measured priority, stamped for acknowledgement", async () => {
    const inputs: SDKUserMessage[] = [];
    let emit: ((message: unknown) => void) | undefined;
    const s = seat({
      onInput: (message, send) => {
        inputs.push(message);
        emit = send;
      },
    });
    const session = await s.factory(spec());
    const reads: SessionEvent[] = [];
    session.subscribe((event) => {
      if (event.type === "input_read") reads.push(event);
    });
    const read = (text: string) => ({
      type: "input_read",
      textSha256: createHash("sha256").update(text).digest("hex"),
    });
    const prompt = session.prompt("hello");
    await s.input(1);
    expect(reads).toEqual([]);
    emit?.(say.running);
    emit?.(say.ack(inputs[0] as SDKUserMessage));
    emit?.(say.toolUse("toolu_1"));
    await session.steer("and check the queue");
    await settle();
    expect(reads).toEqual([read("hello")]);
    expect(CLAUDE_STEER_PRIORITY).toBe("next");
    expect(inputs[1]).toMatchObject({
      type: "user",
      priority: "next",
      message: { role: "user", content: "and check the queue" },
    });
    expect(inputs[0]?.priority).toBeUndefined();
    expect(typeof inputs[0]?.uuid).toBe("string");
    expect(typeof inputs[1]?.uuid).toBe("string");
    // The client folds it in after the tool's result: one result, then idle.
    emit?.(say.toolResult("toolu_1"));
    emit?.(say.ack(inputs[1] as SDKUserMessage));
    emit?.(say.ack(inputs[1] as SDKUserMessage)); // duplicate replay is not a second read
    await settle();
    expect(reads).toEqual([read("hello"), read("and check the queue")]);
    emit?.(say.result("Queue checked."));
    emit?.(say.idle);
    await prompt;
    expect(session.takeUndeliveredSteers?.()).toEqual([]);
    session.dispose();
  });

  it("settles once when a steer is answered in a turn of its own (two results)", async () => {
    const inputs: SDKUserMessage[] = [];
    let emit: ((message: unknown) => void) | undefined;
    const s = seat({
      onInput: (message, send) => {
        inputs.push(message);
        emit = send;
      },
    });
    const session = await s.factory(spec());
    const events = recorder(session);
    let settles = 0;
    const prompt = session.prompt("hello").then(() => {
      settles += 1;
    });
    await s.input(1);
    emit?.(say.running);
    emit?.(say.ack(inputs[0] as SDKUserMessage));
    await session.steer("one more thing");
    await settle();
    emit?.(say.result("", { input: 10, output: 5 }));
    await settle();
    expect(settles).toBe(0);
    emit?.(say.ack(inputs[1] as SDKUserMessage));
    emit?.(say.result("Both done.", { input: 30, output: 12 }));
    emit?.(say.idle);
    await prompt;
    expect(settles).toBe(1);
    expect(events.filter((event) => event.type === "turn_closed")).toEqual([
      { type: "turn_closed" },
      { type: "turn_closed", text: "Both done." },
    ]);
    // Usage is each result's delta over the session's running total.
    expect(events.filter((event) => event.type === "turn_end")).toEqual([
      { type: "turn_end", taskId: "firstmate", usage: spent(10, 5) },
      { type: "turn_end", taskId: "firstmate", usage: spent(20, 7) },
    ]);
    session.dispose();
  });

  it("holds a steer that finds no turn to join, and hands it back as undelivered", async () => {
    const s = seat({ onInput: answering() });
    const session = await s.factory(spec());
    await session.prompt("hello");
    await session.steer("while idle");
    expect(s.harness().inputs).toHaveLength(1);
    expect(session.takeUndeliveredSteers?.()).toEqual(["while idle"]);
    expect(session.takeUndeliveredSteers?.()).toEqual([]);
    session.dispose();
  });

  it("hands back a steer the client never took in when its stream ends", async () => {
    const inputs: SDKUserMessage[] = [];
    const s = seat({
      onInput: (message, emit) => {
        inputs.push(message);
        if (inputs.length === 1) {
          emit(say.running);
          emit(say.ack(message));
        }
      },
    });
    const session = await s.factory(spec());
    const prompt = session.prompt("hello");
    await s.input(1);
    await session.steer("never read");
    await settle();
    s.harness().end();
    await expect(prompt).rejects.toThrow("Claude stopped before the turn finished.");
    expect(session.takeUndeliveredSteers?.()).toEqual(["never read"]);
    session.dispose();
  });

  it("reattaches, resuming its record, after the client ended between turns", async () => {
    const s = seat({ onInput: answering() });
    const session = await s.factory(spec());
    await session.prompt("hello");
    clientWrites(s, session.sessionId, [
      { type: "user", uuid: "u1", message: { role: "user", content: "hello" } },
    ]);
    s.harness().end();
    await settle();
    await session.prompt("again");
    expect(s.attachments).toHaveLength(2);
    expect(s.harness().options.resume).toBe(session.sessionId);
    session.dispose();
  });

  it("counts a new client's usage from zero after a reattach", async () => {
    const s = seat({
      onInput: (message, emit) => {
        emit(say.running);
        emit(say.ack(message));
        // Each client process reports its own cumulative totals.
        const turn = s.harness().inputs.length;
        emit(say.result("Aye.", { input: 10 * turn, output: 5 * turn }));
        emit(say.idle);
      },
    });
    const session = await s.factory(spec());
    const events = recorder(session);
    await session.prompt("one");
    await session.prompt("two");
    session.serveInstructions?.({ text: "New rule.", sha: "sha-2" });
    await session.prompt("after the change");
    expect(s.attachments).toHaveLength(2);
    expect(events.filter((event) => event.type === "turn_end")).toEqual([
      { type: "turn_end", taskId: "firstmate", usage: spent(10, 5) },
      { type: "turn_end", taskId: "firstmate", usage: spent(10, 5) },
      { type: "turn_end", taskId: "firstmate", usage: spent(10, 5) },
    ]);
    session.dispose();
  });

  it("raises its effort for a captain turn, per turn, only when it changes", async () => {
    const s = seat({ onInput: answering() });
    const session = await s.factory(spec());
    session.setThinkingLevel?.("low");
    await session.prompt("an op");
    expect(s.harness().flagSettings).toEqual([]);
    session.setThinkingLevel?.("medium");
    await session.prompt("the captain");
    expect(s.harness().flagSettings).toEqual([{ effortLevel: "medium" }]);
    await session.prompt("the captain again");
    session.setThinkingLevel?.("low");
    await session.prompt("an op");
    expect(s.harness().flagSettings).toEqual([{ effortLevel: "medium" }, { effortLevel: "low" }]);
    session.dispose();
  });

  it("re-serves instructions only at an idle boundary, reopening on the next prompt", async () => {
    let hold = false;
    let release: (() => void) | undefined;
    const s = seat({
      onInput: (message, emit) => {
        emit(say.running);
        emit(say.ack(message));
        const finish = () => {
          emit(say.result("Aye."));
          emit(say.idle);
        };
        if (hold) release = finish;
        else finish();
      },
    });
    const session = await s.factory(spec());
    await session.prompt("hello");
    clientWrites(s, session.sessionId, [
      { type: "user", uuid: "u1", message: { role: "user", content: "hello" } },
    ]);
    hold = true;
    const running = session.prompt("working");
    await s.input(2);
    // Mid-turn: ignored, never patched in.
    session.serveInstructions?.({ text: "New rule.", sha: "sha-2" });
    release?.();
    await running;
    hold = false;
    await session.prompt("next");
    expect(s.attachments).toHaveLength(1);
    expect(session.takeRenewal()).toBeUndefined();
    // At an idle boundary: the next prompt reattaches with the new words -
    // in a new session, since a resumed client serves the prompt it started under.
    const first = session.sessionId;
    session.serveInstructions?.({ text: "New rule.", sha: "sha-2" });
    expect(session.takeRenewal()).toEqual({ from: first, changed: ["instructions"] });
    expect(session.takeRenewal()).toBeUndefined();
    expect(session.sessionId).not.toBe(first);
    expect(session.resume()).toEqual({ backend: "claude", sessionId: session.sessionId });
    await session.prompt("after the change");
    expect(s.attachments).toHaveLength(2);
    expect(s.attachments[0]?.closed()).toBe(true);
    expect(s.harness().options.systemPrompt).toEqual([
      buildFirstmateSystemPrompt("claude"),
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      "New rule.",
    ]);
    expect(s.harness().options.resume).toBeUndefined();
    expect(s.harness().options.sessionId).toBe(session.sessionId);
    await s.store.flushed();
    const contracts = (sessionId: string) =>
      s.store
        .sidecar(sessionId)
        .filter((line) => line.kind === "contract")
        .map((line) => (line.kind === "contract" ? line.instructions_sha : undefined));
    expect(contracts(first)).toEqual(["sha-1"]);
    expect(contracts(session.sessionId)).toEqual(["sha-2"]);
    session.dispose();
  });

  it("starts a new session for changed instructions once the client took a prompt, before its file lands", async () => {
    const s = seat({ onInput: answering() });
    const session = await s.factory(spec());
    await session.prompt("hello");
    // The client writes its transcript on its own schedule: nothing yet.
    const first = session.sessionId;
    session.serveInstructions?.({ text: "New rule.", sha: "sha-2" });
    expect(session.takeRenewal()).toEqual({ from: first, changed: ["instructions"] });
    await session.prompt("after the change");
    expect(s.harness().options.resume).toBeUndefined();
    expect(s.harness().options.sessionId).toBe(session.sessionId);
    expect(session.sessionId).not.toBe(first);
    session.dispose();
  });

  it("keeps its session id when the instructions change before the client recorded it", async () => {
    const s = seat({ onInput: answering() });
    const session = await s.factory(spec());
    const sessionId = session.sessionId;
    session.serveInstructions?.({ text: "New rule.", sha: "sha-2" });
    expect(session.takeRenewal()).toBeUndefined();
    await session.prompt("hello");
    expect(session.sessionId).toBe(sessionId);
    expect(s.harness().options.sessionId).toBe(sessionId);
    session.dispose();
  });

  it("disposes only after the open turn settles, interrupting it first", async () => {
    let emit: ((message: unknown) => void) | undefined;
    // INF-2248: attachment discovers transcripts asynchronously; wait for input, not ten loop turns.
    let received!: () => void;
    const input = new Promise<void>((resolve) => {
      received = resolve;
    });
    const s = seat({
      onInput: (message, send) => {
        emit = send;
        send(say.running);
        send(say.ack(message));
        received();
      },
      onInterrupt: (send) => {
        send({
          ...say.result(""),
          subtype: "error_during_execution",
          is_error: true,
          terminal_reason: "aborted_streaming",
        });
        send(say.idle);
      },
    });
    const session = await s.factory(spec());
    const events = recorder(session);
    const prompt = session.prompt("hello");
    await input;
    expect(emit).toBeDefined();
    session.dispose();
    expect(s.harness().interrupts()).toBe(1);
    await prompt;
    await session.closed();
    expect(s.harness().closed()).toBe(true);
    expect(hasActiveSession(s.configDir)).toBe(false);
    expect(events.some((event) => event.type === "turn_failed")).toBe(false);
    await expect(session.prompt("after")).rejects.toThrow("has ended");
  });

  it("reports a typed cut-off as a failed turn carrying its class", async () => {
    const s = seat({
      onInput: (message, emit) => {
        emit(say.running);
        emit(say.ack(message));
        emit({
          type: "assistant",
          parent_tool_use_id: null,
          error: "authentication_failed",
          message: { content: [{ type: "text", text: "Not logged in" }] },
        });
        emit({
          type: "result",
          subtype: "success",
          is_error: true,
          api_error_status: 401,
          terminal_reason: "api_error",
          result: "Not logged in",
        });
        emit(say.idle);
      },
    });
    const session = await s.factory(spec());
    const events = recorder(session);
    await session.prompt("hello");
    expect(events).toEqual([
      {
        type: "turn_failed",
        taskId: "firstmate",
        error: "Not logged in",
        cutOff: { class: "signed_out" },
      },
      { type: "turn_end", taskId: "firstmate" },
      { type: "turn_closed" },
    ]);
    session.dispose();
  });

  it("hands each pushed plan reading to the account's quota", async () => {
    const s = seat({
      onInput: (message, emit) => {
        emit(say.running);
        emit(say.ack(message));
        emit({
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed_warning",
            utilization: 0.8,
            resetsAt: 1_790_437_617,
            rateLimitType: "five_hour",
          },
        });
        emit(say.result("Aye."));
        emit(say.idle);
      },
    });
    const session = await s.factory(spec());
    await session.prompt("hello");
    expect(s.readings).toEqual([
      {
        accountId: ACCOUNT,
        reading: {
          status: "allowed_warning",
          utilization: 0.8,
          resetsAt: 1_790_437_617_000,
          windowId: "five_hour",
        },
      },
    ]);
    session.dispose();
  });

  it("settles on a result when the client never reports its state", async () => {
    const s = seat({
      onInput: (message, emit) => {
        emit(say.ack(message));
        emit(say.result("Aye."));
      },
    });
    const session = await s.factory(spec());
    await session.prompt("hello");
    expect(session.isStreaming()).toBe(false);
    session.dispose();
  });
});

describe("the Claude seat's served record", () => {
  it("locates the prompt and a folded steer in the recorded transcript", async () => {
    const inputs: SDKUserMessage[] = [];
    let emit: ((message: unknown) => void) | undefined;
    const s = seat({
      onInput: (message, send) => {
        inputs.push(message);
        emit = send;
      },
    });
    const session = await s.factory(spec());
    expect(session.servedState?.()).toBeUndefined();
    const prompt = session.prompt("hello");
    await s.input(1);
    emit?.(say.running);
    emit?.(say.ack(inputs[0] as SDKUserMessage));
    await session.steer("and the queue");
    await settle();
    emit?.(say.ack(inputs[1] as SDKUserMessage));
    // What the client records: the prompt under its own uuid, the folded
    // steer as an attachment naming it as its source.
    clientWrites(s, session.sessionId, [
      { type: "user", uuid: "root", parentUuid: null, message: { role: "user", content: "old" } },
      { type: "assistant", uuid: "a0", parentUuid: "root", message: { content: [] } },
      {
        type: "user",
        uuid: inputs[0]?.uuid as string,
        parentUuid: "a0",
        message: { role: "user", content: "hello" },
      },
      {
        type: "attachment",
        uuid: "att-1",
        parentUuid: inputs[0]?.uuid as string,
        attachment: {
          type: "queued_command",
          prompt: "and the queue",
          source_uuid: inputs[1]?.uuid,
        },
      },
    ]);
    emit?.(say.result("Aye."));
    emit?.(say.idle);
    await prompt;
    const served = session.servedState?.();
    expect(served?.sessionFile).toBe(s.store.transcriptPath(session.sessionId));
    expect(served?.prompt).toMatchObject({
      entryId: inputs[0]?.uuid,
      parentEntryId: "a0",
      prefix: { messageCount: 2 },
    });
    expect(served?.steers).toEqual([
      { textSha256: expect.any(String), entryId: "att-1", parentEntryId: inputs[0]?.uuid },
    ]);
    await s.store.flushed();
    // The sidecar keeps the ids the client acknowledged: the durable join.
    expect(s.store.sidecar(session.sessionId).find((line) => line.kind === "served")).toEqual({
      kind: "served",
      at: expect.any(Number),
      prompt: { textSha256: served?.prompt?.textSha256, uuid: inputs[0]?.uuid },
      steers: [{ textSha256: served?.steers[0]?.textSha256, uuid: inputs[1]?.uuid }],
    });
    session.dispose();
  });

  // INF-2408 (the captain: "File a fix for later"): the seat reads its chain
  // while a turn runs and hashes at the close only what the turn added; the
  // fingerprint each turn records stays the whole recorded chain's sha256.
  it("records each turn's prefix as the sha256 of the whole chain the prompt landed on", async () => {
    const inputs: SDKUserMessage[] = [];
    let emit: ((message: unknown) => void) | undefined;
    const s = seat({
      onInput: (message, send) => {
        inputs.push(message);
        emit = send;
      },
    });
    const session = await s.factory(spec());
    const chainOf = (entries: object[]) => ({
      messageCount: entries.length,
      sha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    });
    const root = { type: "user", uuid: "root", parentUuid: null, message: { content: "old" } };
    const a0 = { type: "assistant", uuid: "a0", parentUuid: "root", message: { content: [] } };
    const first = session.prompt("hello");
    await s.input(1);
    emit?.(say.running);
    emit?.(say.ack(inputs[0] as SDKUserMessage));
    const asked = {
      type: "user",
      uuid: inputs[0]?.uuid as string,
      parentUuid: "a0",
      message: { role: "user", content: "hello" },
    };
    const a1 = {
      type: "assistant",
      uuid: "a1",
      parentUuid: asked.uuid,
      message: { content: [{ type: "text", text: "Aye — résumé." }] },
    };
    clientWrites(s, session.sessionId, [root, a0, asked, a1]);
    emit?.(say.result("Aye."));
    emit?.(say.idle);
    await first;
    expect(session.servedState?.()?.prompt?.prefix).toEqual(chainOf([root, a0]));
    // The next turn: the seat reads the chain so far while the turn runs.
    const second = session.prompt("and now");
    await s.input(2);
    emit?.(say.running);
    emit?.(say.ack(inputs[1] as SDKUserMessage));
    await settle();
    clientWrites(s, session.sessionId, [
      {
        type: "user",
        uuid: inputs[1]?.uuid as string,
        parentUuid: "a1",
        message: { role: "user", content: "and now" },
      },
      { type: "assistant", uuid: "a2", parentUuid: inputs[1]?.uuid, message: { content: [] } },
    ]);
    emit?.(say.result("Done."));
    emit?.(say.idle);
    await second;
    expect(session.servedState?.()?.prompt?.prefix).toEqual(chainOf([root, a0, asked, a1]));
    session.dispose();
  });

  it("keeps null locations for a prompt the client never took in", async () => {
    const s = seat({
      onInput: (_message, emit) => {
        emit(say.running);
        emit({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["boom"],
        });
        emit(say.idle);
      },
    });
    const session = await s.factory(spec());
    await session.prompt("hello");
    expect(session.servedState?.()).toEqual({
      sessionFile: s.store.transcriptPath(session.sessionId),
      prompt: null,
      steers: [],
    });
    session.dispose();
  });
});

describe("the Claude seat's runaway bounds on the host's clock", () => {
  it("rides the host's clock - its client's upkeep and the one watcher - gone with the last seat", async () => {
    const s = seat({ onInput: answering() });
    const session = await s.factory(spec());
    expect(s.clock.registrations()).toEqual(["claude-sessions", "session-bounds"]);
    session.dispose();
    await session.closed();
    expect(s.clock.registrations()).toEqual([]);
  });

  it("interrupts an inference past the per-request bound and fails the turn with its sentence", async () => {
    const s = seat({
      onInput: (message, emit) => {
        emit(say.running);
        emit(say.ack(message));
        emit(say.messageStart);
      },
      onInterrupt: (emit) => {
        emit({
          ...say.result(""),
          subtype: "error_during_execution",
          is_error: true,
          terminal_reason: "aborted_streaming",
        });
        emit(say.idle);
      },
    });
    const session = await s.factory(spec({ requestTimeoutMs: 300_000 }));
    const events = recorder(session);
    const started = nextEvent(session, "request_started");
    const prompt = session.prompt("hello");
    await started;
    s.clock.advance(TICK_PERIOD_MS * 4);
    expect(s.harness().interrupts()).toBe(0);
    s.clock.advance(TICK_PERIOD_MS);
    await prompt;
    expect(s.harness().interrupts()).toBe(1);
    // The request's start, which the watcher's clock ran from, then its cut.
    expect(events.slice(0, 2)).toEqual([
      { type: "request_started" },
      { type: "turn_failed", taskId: "firstmate", error: requestTimeoutErrorMessage(300_000) },
    ]);
    session.dispose();
  });

  it("fails an answer that kept running past the output cap in its own words, not the client's", async () => {
    // What the client ends with once its three carry-ons also ran past the
    // cap (measured on 2.1.234 and 2.1.283): a synthetic assistant message
    // typed `max_output_tokens`, then an error result naming its own setting.
    const words = `API Error: Claude's response exceeded the ${FIRSTMATE_MAX_OUTPUT_TOKENS} output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.`;
    const s = seat({
      onInput: (message, emit) => {
        emit(say.running);
        emit(say.ack(message));
        emit({
          type: "assistant",
          parent_tool_use_id: null,
          error: "max_output_tokens",
          message: { content: [{ type: "text", text: words }] },
        });
        emit({ ...say.result(words), is_error: true });
        emit(say.idle);
      },
    });
    const session = await s.factory(spec());
    const events = recorder(session);
    await session.prompt("hello");
    expect(events.filter((event) => event.type === "turn_failed")).toEqual([
      {
        type: "turn_failed",
        taskId: "firstmate",
        error: outputCapErrorMessage(FIRSTMATE_MAX_OUTPUT_TOKENS),
      },
    ]);
    session.dispose();
  });

  it("names its tools as the Pi seat does, without the client's server prefix", async () => {
    const s = seat({
      onInput: (message, emit) => {
        emit(say.running);
        emit(say.ack(message));
        emit(say.toolUse("toolu_1"));
        emit(say.toolResult("toolu_1"));
        emit(say.result("Aye."));
        emit(say.idle);
      },
    });
    const session = await s.factory(spec());
    const events = recorder(session);
    await session.prompt("hello");
    expect(events.slice(0, 2)).toEqual([
      { type: "tool_start", taskId: "firstmate", callId: "toolu_1", toolName: "crew_status" },
      {
        type: "tool_end",
        taskId: "firstmate",
        callId: "toolu_1",
        toolName: "crew_status",
        isError: false,
      },
    ]);
    session.dispose();
  });

  it("stops the per-request clock while a tool is in flight", async () => {
    let emit: ((message: unknown) => void) | undefined;
    const s = seat({
      onInput: (message, send) => {
        emit = send;
        send(say.running);
        send(say.ack(message));
        send(say.toolUse("toolu_1"));
      },
    });
    const session = await s.factory(spec({ requestTimeoutMs: 300_000, turnTimeoutMs: 0 }));
    const started = nextEvent(session, "tool_start");
    const prompt = session.prompt("hello");
    await started;
    s.clock.advance(TICK_PERIOD_MS * 10);
    expect(s.harness().interrupts()).toBe(0);
    emit?.(say.toolResult("toolu_1"));
    emit?.(say.result("Aye."));
    emit?.(say.idle);
    await prompt;
    session.dispose();
  });

  it("ends a turn past the whole-turn backstop", async () => {
    const s = seat({
      onInput: (message, emit) => {
        emit(say.running);
        emit(say.ack(message));
        emit(say.toolUse("toolu_1"));
      },
      onInterrupt: (emit) => {
        emit({
          ...say.result(""),
          subtype: "error_during_execution",
          is_error: true,
          terminal_reason: "aborted_tools",
        });
        emit(say.idle);
      },
    });
    const session = await s.factory(spec({ turnTimeoutMs: 20 * 60_000 }));
    const events = recorder(session);
    const started = nextEvent(session, "tool_start");
    const prompt = session.prompt("hello");
    await started;
    s.clock.advance(20 * 60_000);
    await prompt;
    expect(events.find((event) => event.type === "turn_failed")).toEqual({
      type: "turn_failed",
      taskId: "firstmate",
      error: turnTimeoutErrorMessage(20 * 60_000),
    });
    session.dispose();
  });

  it("says something inside the quiet watchdog's bound even when the client says nothing", async () => {
    // A client that takes the prompt and then goes silent, and does not
    // answer its interrupt either: the worst case the watchdog can see.
    const s = seat({
      onInput: (message, emit) => {
        emit(say.running);
        emit(say.ack(message));
      },
    });
    const session = await s.factory(spec());
    const events = recorder(session);
    const started = nextEvent(session, "input_read");
    const prompt = session.prompt("hello");
    await started;
    let silentFor = 0;
    while (events.length === 0) {
      s.clock.advance(TICK_PERIOD_MS);
      silentFor += TICK_PERIOD_MS;
    }
    await prompt;
    // The production per-inference bound (300 s), checked each tick, then
    // one tick for the interrupt: well inside the 10-minute quiet line.
    expect(silentFor).toBe(FIRSTMATE_REQUEST_TIMEOUT_MS + TICK_PERIOD_MS);
    expect(silentFor).toBeLessThan(QUIET_FEED_MS);
    expect(events[0]).toEqual({
      type: "turn_failed",
      taskId: "firstmate",
      error: requestTimeoutErrorMessage(FIRSTMATE_REQUEST_TIMEOUT_MS),
    });
    session.dispose();
  });

  it("answers a steer the client still holds when the bound's interrupt lands", async () => {
    // The reviewer's script: a steer queued, then the per-inference bound
    // fires. The interrupt lands and the client answers the steer in a turn
    // of its own - which must run, not be stopped a tick later as wedged.
    const inputs: SDKUserMessage[] = [];
    let emit: ((message: unknown) => void) | undefined;
    const s = seat({
      onInput: (message, send) => {
        inputs.push(message);
        emit = send;
        if (inputs.length === 1) {
          send(say.running);
          send(say.ack(message));
          send(say.messageStart);
        }
      },
      onInterrupt: (send) => {
        send({
          ...say.result(""),
          subtype: "error_during_execution",
          is_error: true,
          terminal_reason: "aborted_streaming",
        });
        send(say.ack(inputs[1] as SDKUserMessage));
        send(say.messageStart);
      },
    });
    const session = await s.factory(spec({ requestTimeoutMs: 300_000 }));
    const events = recorder(session);
    let settled = false;
    const started = nextEvent(session, "request_started");
    const prompt = session.prompt("hello").then(() => {
      settled = true;
    });
    await started;
    await session.steer("the steer text");
    await settle();
    s.clock.advance(TICK_PERIOD_MS * 5);
    await settle();
    expect(s.harness().interrupts()).toBe(1);
    s.clock.advance(TICK_PERIOD_MS);
    await settle();
    expect(settled).toBe(false);
    expect(s.harness().closed()).toBe(false);
    emit?.(say.result("Steered."));
    emit?.(say.idle);
    await prompt;
    expect(session.takeUndeliveredSteers?.()).toEqual([]);
    expect(events.filter((event) => event.type === "turn_failed")).toEqual([
      { type: "turn_failed", taskId: "firstmate", error: requestTimeoutErrorMessage(300_000) },
    ]);
    expect(events.at(-1)).toEqual({ type: "turn_closed", text: "Steered." });
    session.dispose();
  });

  it("reports a second bound in the same prompt as it did the first (P6)", async () => {
    // A steer answered in a turn of its own after the first bound, which then
    // runs past the bound too, and never answers the second interrupt.
    const inputs: SDKUserMessage[] = [];
    let interrupts = 0;
    const s = seat({
      onInput: (message, send) => {
        inputs.push(message);
        if (inputs.length === 1) {
          send(say.running);
          send(say.ack(message));
          send(say.messageStart);
        }
      },
      onInterrupt: (send) => {
        interrupts += 1;
        if (interrupts > 1) return;
        send({
          ...say.result(""),
          subtype: "error_during_execution",
          is_error: true,
          terminal_reason: "aborted_streaming",
        });
        send(say.ack(inputs[1] as SDKUserMessage));
        send(say.messageStart);
      },
    });
    const session = await s.factory(spec({ requestTimeoutMs: 300_000 }));
    const events = recorder(session);
    const started = nextEvent(session, "request_started");
    const prompt = session.prompt("hello");
    await started;
    await session.steer("the steer text");
    await settle();
    s.clock.advance(TICK_PERIOD_MS * 5);
    await settle();
    s.clock.advance(TICK_PERIOD_MS * 5);
    await settle();
    expect(interrupts).toBe(2);
    s.clock.advance(TICK_PERIOD_MS);
    await prompt;
    expect(s.harness().closed()).toBe(true);
    const failure = {
      type: "turn_failed",
      taskId: "firstmate",
      error: requestTimeoutErrorMessage(300_000),
    };
    expect(events.map((event) => event.type)).toEqual([
      "request_started",
      "turn_failed",
      "turn_end",
      "turn_closed",
      "request_started",
      "turn_failed",
      "turn_end",
      "turn_closed",
    ]);
    expect(events.filter((event) => event.type === "turn_failed")).toEqual([failure, failure]);
    session.dispose();
  });

  it("abandons a client that never answers its interrupt, within one more tick", async () => {
    const s = seat({
      onInput: (message, emit) => {
        emit(say.running);
        emit(say.ack(message));
      },
    });
    const session = await s.factory(spec({ requestTimeoutMs: 60_000 }));
    const events = recorder(session);
    const started = nextEvent(session, "input_read");
    const prompt = session.prompt("hello");
    await started;
    s.clock.advance(TICK_PERIOD_MS);
    expect(s.harness().interrupts()).toBe(1);
    s.clock.advance(TICK_PERIOD_MS);
    await prompt;
    expect(s.harness().closed()).toBe(true);
    expect(events).toEqual([
      { type: "turn_failed", taskId: "firstmate", error: requestTimeoutErrorMessage(60_000) },
      { type: "turn_end", taskId: "firstmate" },
      { type: "turn_closed" },
    ]);
    // The next prompt reattaches, resuming nothing it never recorded.
    const readAgain = nextEvent(session, "input_read");
    const next = session.prompt("again");
    await readAgain;
    expect(s.attachments).toHaveLength(2);
    s.harness().emit(say.result("Aye."));
    s.harness().emit(say.idle);
    await next;
    session.dispose();
  });
});

// INF-6693's plan: the person's summary point sets the client's window at the
// point plus the first mate's 8,192 answer allowance and the client's 13,000
// buffer; each model's limit leaves the client's own window.
it.each([
  [200_000, 221_192],
  ["model", undefined],
] as const)("a summary point of %s sets the client's window to %s", async (point, window) => {
  const s = seat({ onInput: answering() });
  const session = await s.factory(spec({ compaction: () => summaryCompaction(point) }));
  await session.prompt("hello");
  const settings = s.harness().options.settings as Record<string, unknown>;
  expect(settings.autoCompactEnabled).toBe(true);
  expect(settings.autoCompactWindow).toBe(window);
  session.dispose();
});
