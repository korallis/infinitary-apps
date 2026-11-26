import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CutOff } from "@shared/authFailure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answering,
  baseSpec,
  closes,
  createClaudeSession,
  interruptedBy,
  interruptedResult,
  opens,
  result,
  says,
} from "../../../tests/helpers/claudeCrewmateScript";
import { codingSpec } from "../../../tests/helpers/codingSession";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  type SDKUserMessage,
  scriptedClaudeFactory,
  scriptedClaudeQuery as scriptedQuery,
  scriptedRecordsFlushed,
} from "../../../tests/helpers/scriptedClaudeQuery";
import { CREW_SHELL_PROGRAM } from "../axi/names";
import { CREWMATE_TOOLS } from "../pi/crewmateTaskTools";
import type { SessionEvent } from "../session/session";
import { bindTools, type CrewmateToolDelegate } from "../session/tools";
import { CLAUDE_SEAT_TOOL_SERVER } from "../storage/sessionReader";
import { CLAUDE_MODELS } from "./claudeModels";
import { CLAUDE_MODEL_PROVIDER } from "./claudeQueryCore";
import {
  CLAUDE_ROLLING_ENV,
  CLAUDE_SESSION_ENV,
  CLAUDE_STEER_PRIORITY,
} from "./claudeSessionOptions";
import { hasActiveSession, resetStoreLeasesForTest } from "./claudeStoreLease";
import { encodeClaudeProjectDir } from "./claudeTranscript";

/**
 * The crewmate's coding session on Claude runs against a scripted client
 * that speaks the message shapes the real client speaks to a rolling
 * session - captured from live runs, including the behaviours that are easy
 * to get wrong: cost arrives CUMULATIVE across turns, a turn is bracketed by
 * the client's own `running` and `idle`, every pushed message is
 * acknowledged by its uuid as a turn takes it in, and the client runs turns
 * of its own once a background command it started finishes. Each session
 * is opened by Claude's session factory, the way the supervisor opens a
 * crewmate. The same rules on the real client:
 * `claudeSession.integration.test.ts`.
 */

beforeEach(() => {
  resetStoreLeasesForTest();
});

afterEach(scriptedRecordsFlushed);

describe("the Claude crewmate's coding session", () => {
  it("hands the client the machine's default login, its coding set, and nothing ambient", async () => {
    const { factory, harness } = scriptedQuery({
      onInput: answering(() => [result({ cost: 0.01, input: 10, output: 2 })]),
    });
    const session = await createClaudeSession({ ...baseSpec, model: "claude-opus-5-5" }, factory);
    await session.prompt("go");
    const options = harness().options;

    expect(options.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(options.env?.CLAUDE_CODE_ENTRYPOINT).toBe("infinitary");
    expect(options.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    // No proxy anywhere in the path: nothing redirects the client's traffic.
    expect(options.env?.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(options.cwd).toBe("/tmp/worktree");
    // The user's own machine-wide configuration is not this crewmate's,
    // and neither are the notes their client keeps on the project.
    expect(options.settingSources).toEqual([]);
    expect(options.env).toMatchObject(CLAUDE_SESSION_ENV);
    // Nor are the person's own tool servers: only the app's tools mount.
    expect(options.strictMcpConfig).toBe(true);
    // The client's own coding set and prompt, with the crewmate's appended.
    expect(options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "You are a crewmate.",
    });
    expect("tools" in options).toBe(false);
    expect(options.permissionMode).toBe("bypassPermissions");
    expect(options.model).toBe("claude-opus-5-5");
    // The seat's rules: the client says when it is idle and acknowledges
    // every pushed message by its uuid.
    expect(options.env).toMatchObject(CLAUDE_ROLLING_ENV);
    // Unlike the seat, it keeps the client's per-turn extras.
    expect(options.env?.CLAUDE_CODE_DISABLE_ATTACHMENTS).toBeUndefined();
    expect(options.env?.MAX_MCP_OUTPUT_TOKENS).toBeUndefined();
    expect(options.extraArgs).toEqual({ "replay-user-messages": null });
    // The tier's level is set on the opening query, not a per-turn update.
    expect(options.effort).toBe("medium");
    expect(options.thinking).toBeUndefined();
    expect(options.maxTurns).toBeUndefined();
    expect(options.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();
    session.dispose();
  });

  // INF-6358's piece 4: an unsafe data reader's client keeps only its reads, and
  // the app's gate refuses any of them that leaves the working copy.
  it("hands a fenced session only the client's reads, each gated to its working copy", async () => {
    const cwd = scratchDir("fm-claude-fenced-");
    const outside = scratchDir("fm-claude-outside-");
    writeFileSync(join(cwd, "notes.md"), "inside");
    const { factory, harness } = scriptedQuery({
      onInput: answering(() => [result({ cost: 0.01, input: 10, output: 2 })]),
    });
    const session = await scriptedClaudeFactory({
      configDir: baseSpec.configDir,
      query: factory,
    }).open({
      ...codingSpec({ binding: { backend: "claude", accountId: "acct_claude" }, cwd }),
      fenced: true,
    });
    await session.prompt("go");
    const options = harness().options;
    expect(options.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(options.plugins).toBeUndefined();
    const gates = options.hooks?.PreToolUse?.flatMap((matcher) => matcher.hooks) ?? [];
    const decide = async (tool_name: string, tool_input: unknown) => {
      for (const gate of gates) {
        const answer = (await gate(
          { hook_event_name: "PreToolUse", tool_name, tool_input } as never,
          undefined,
          { signal: new AbortController().signal },
        )) as { hookSpecificOutput?: { permissionDecision?: string } };
        if (answer.hookSpecificOutput?.permissionDecision === "deny") return "deny";
      }
      return "allow";
    };
    expect(await decide("Read", { file_path: join(cwd, "notes.md") })).toBe("allow");
    expect(await decide("Grep", { pattern: "x" })).toBe("allow");
    expect(await decide("Glob", { pattern: "**/*.md" })).toBe("allow");
    expect(await decide("Read", { file_path: join(outside, "notes.md") })).toBe("deny");
    expect(await decide("Read", { file_path: "~/.ssh/id_rsa" })).toBe("deny");
    expect(await decide("Grep", { pattern: "x", path: outside })).toBe("deny");
    expect(await decide("Glob", { pattern: "../**/*" })).toBe("deny");
    expect(await decide("Glob", { pattern: "/etc/*" })).toBe("deny");
    session.dispose();
  });

  it("hands the client its task's shell: the channel's variables, and its commands first on the path", async () => {
    const { factory, harness } = scriptedQuery({
      onInput: answering(() => [result({ cost: 0.01, input: 10, output: 2 })]),
    });
    const session = await scriptedClaudeFactory({
      configDir: baseSpec.configDir,
      query: factory,
    }).open(
      codingSpec({
        binding: { backend: "claude", accountId: "acct_claude" },
        cwd: baseSpec.cwd,
        shell: { env: { INFINITARY_AXI_KEY: "/channel/task-1.key" }, path: ["/app/axi-bin"] },
      }),
    );
    await session.prompt("go");
    const env = harness().options.env;
    expect(env?.INFINITARY_AXI_KEY).toBe("/channel/task-1.key");
    expect(env?.PATH?.split(":")[0]).toBe("/app/axi-bin");
    session.dispose();
  });

  it("runs each of the client's commands through the crew shell program, unless the person set their own", async () => {
    // The captain's choice that a Claude crewmate's backgrounded commands are
    // refused too (docs/axi-commands.md, "Never the crew's"): the app's own
    // command folder holds the program the client runs each command through.
    const binDir = resolve(__dirname, "../../../resources/axi-bin");
    const shell = { env: { INFINITARY_AXI_KEY: "/channel/task-1.key" }, path: [binDir] };
    const opened = async (env: NodeJS.ProcessEnv) => {
      const { factory, harness } = scriptedQuery({
        onInput: answering(() => [result({ cost: 0.01, input: 10, output: 2 })]),
      });
      const session = await scriptedClaudeFactory({
        configDir: baseSpec.configDir,
        query: factory,
        env: () => env,
      }).open(
        codingSpec({
          binding: { backend: "claude", accountId: "acct_claude" },
          cwd: baseSpec.cwd,
          shell,
        }),
      );
      await session.prompt("go");
      session.dispose();
      return harness().options.env;
    };

    const crew = await opened({ PATH: "/usr/bin", HOME: baseSpec.configDir });
    expect(crew?.CLAUDE_CODE_SHELL_PREFIX).toBe(join(binDir, CREW_SHELL_PROGRAM));
    // The shell the program runs the command in is the one the client picks first.
    expect(crew?.CLAUDE_CODE_SHELL).toMatch(/\/(bash|zsh)$/);

    const own = "/opt/audit/log-command";
    const person = await opened({
      PATH: "/usr/bin",
      HOME: baseSpec.configDir,
      CLAUDE_CODE_SHELL_PREFIX: own,
    });
    expect(person?.CLAUDE_CODE_SHELL_PREFIX).toBe(own);
    expect(person?.CLAUDE_CODE_SHELL).toBeUndefined();
  });

  it("opens Quick one rung below the served level, omits effort on legacy Haiku, and says what it opened at", async () => {
    for (const [model, thinking, quick, expected, reasoning] of [
      ["claude-opus-5-5", "xhigh", false, "xhigh", { level: "xhigh" }],
      ["claude-opus-5-5", "xhigh", true, "high", { level: "high", lower: "quick" }],
      ["claude-sonnet-5", "medium", true, "low", { level: "low", lower: "quick" }],
      ["claude-haiku-4-5", "medium", true, undefined, { level: "default" }],
      ["claude-haiku-5-5", "medium", false, "medium", { level: "medium" }],
      ["claude-haiku-5-5", "medium", true, "low", { level: "low", lower: "quick" }],
      ["claude-haiku-5-5-20261007", "medium", true, "low", { level: "low", lower: "quick" }],
    ] as const) {
      const { factory, harness } = scriptedQuery({
        onInput: answering(() => [result({ cost: 0.01, input: 10, output: 2 })]),
      });
      const session = await createClaudeSession({ ...baseSpec, model, thinking, quick }, factory);
      await session.prompt("go");
      expect(harness().options.effort).toBe(expected);
      expect(session.reasoning()).toEqual(reasoning);
      session.dispose();
    }
  });

  it("is addressable for resume from the moment it exists, and its client starts under that id", async () => {
    const { factory, harness, attachments } = scriptedQuery({
      onInput: answering(() => [result({ cost: 0.01, input: 10, output: 2 })]),
    });
    const session = await createClaudeSession(baseSpec, factory);
    // The supervisor persists the resume token immediately after a spawn, so
    // a token that only appears after the first turn would be lost.
    expect(session.resume()).toEqual({ backend: "claude", sessionId: session.sessionId });
    // The client is attached for a prompt, not before.
    expect(attachments).toEqual([]);
    await session.prompt("go");
    expect(harness().options.sessionId).toBe(session.sessionId);
    expect(harness().options.resume).toBeUndefined();
    session.dispose();
  });

  it("resumes a session the client has recorded", async () => {
    const configDir = scratchDir("infinitary-claude-coding-");
    const recorded = "0b7e3a52-5f1c-4c7e-9d3a-2f6b8e1c4a90";
    const project = join(configDir, "projects", encodeClaudeProjectDir(baseSpec.cwd));
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${recorded}.jsonl`), "");
    const { factory, harness } = scriptedQuery({
      onInput: answering(() => [result({ cost: 0.01, input: 10, output: 2 })]),
    });
    const session = await createClaudeSession(
      { ...baseSpec, configDir, resumeToken: recorded },
      factory,
    );
    expect(session.resume()).toEqual({ backend: "claude", sessionId: recorded });
    await session.prompt("carry on");
    expect(harness().options.resume).toBe(recorded);
    expect(harness().options.sessionId).toBeUndefined();
    session.dispose();
  });

  it("starts fresh when the client has no record of the session it was asked to resume", async () => {
    const lost = "0b7e3a52-5f1c-4c7e-9d3a-2f6b8e1c4a90";
    const logs: string[] = [];
    const { factory, harness } = scriptedQuery({
      onInput: answering(() => [result({ cost: 0.01, input: 10, output: 2 })]),
    });
    // The client sweeps its transcripts after 30 days: a dead id would fail
    // every attach, so the crewmate starts a new conversation instead.
    const session = await createClaudeSession(
      { ...baseSpec, resumeToken: lost, log: (line) => logs.push(line) },
      factory,
    );
    expect(session.resume()?.backend).toBe("claude");
    expect(session.sessionId).not.toBe(lost);
    await session.prompt("carry on");
    expect(harness().options.resume).toBeUndefined();
    expect(harness().options.sessionId).toBe(session.sessionId);
    expect(logs).toContain(`the client has no transcript for session ${lost}; starting fresh`);
    session.dispose();
  });

  // The approved plan for several logins of one provider, piece 3, "A moved
  // lane": a Claude conversation is never copied across accounts. Each
  // login's client keeps its transcripts in its own folder.
  it("opens a new conversation under another login's folder, and copies nothing into it", async () => {
    const recorded = "0b7e3a52-5f1c-4c7e-9d3a-2f6b8e1c4a90";
    const personal = scratchDir("infinitary-claude-personal-");
    const work = scratchDir("infinitary-claude-work-");
    const projectOf = (dir: string) => join(dir, "projects", encodeClaudeProjectDir(baseSpec.cwd));
    mkdirSync(projectOf(personal), { recursive: true });
    const transcript = join(projectOf(personal), `${recorded}.jsonl`);
    writeFileSync(transcript, '{"type":"user"}\n');
    const { factory, harness } = scriptedQuery({
      onInput: answering(() => [result({ cost: 0.01, input: 10, output: 2 })]),
    });
    const session = await createClaudeSession(
      { ...baseSpec, configDir: work, resumeToken: recorded },
      factory,
    );
    expect(session.sessionId).not.toBe(recorded);
    await session.prompt("carry on");
    expect(harness().options.resume).toBeUndefined();
    expect(existsSync(join(projectOf(work), `${recorded}.jsonl`))).toBe(false);
    expect(readFileSync(transcript, "utf8")).toBe('{"type":"user"}\n');
    session.dispose();
  });

  describe("the model that answers (FI3-967)", () => {
    const init = (model: string) => ({
      type: "system",
      subtype: "init",
      model,
      session_id: "session-under-test",
    });
    /** The notice as Claude Code 2.1.289 sent it to the app on FI3-957's session. */
    const fellBack = (scope?: "session" | "local") => ({
      type: "system",
      subtype: "model_refusal_fallback",
      trigger: "refusal",
      direction: "retry",
      ...(scope ? { scope } : {}),
      original_model: "claude-opus-5-5",
      fallback_model: "claude-opus-4-8",
      request_id: "req_011Cfikq8XKLo4efqdKLUN8P",
      api_refusal_category: "cyber",
      api_refusal_explanation: null,
      retracted_message_uuids: [],
      content: "Opus 5.5's safeguards flagged this session.",
      uuid: "f50400b2-8b71-451c-9327-b413febda403",
      session_id: "session-under-test",
    });
    const served = (events: SessionEvent[]) =>
      events.flatMap((event) => (event.type === "model_served" ? [event] : []));

    it("names the model Claude Code moved it to, and asks for the routed one again when it reattaches", async () => {
      let turn = 0;
      const { factory, attachments } = scriptedQuery({
        onInput: answering(() => {
          turn += 1;
          if (turn === 1)
            return [
              init("claude-opus-5-5"),
              fellBack("session"),
              result({ cost: 1, input: 10, output: 2 }),
            ];
          // The same client reports the model it swapped in from then on;
          // a new one honors the model it was asked for.
          return [
            init(turn === 2 ? "claude-opus-4-8" : "claude-opus-5-5"),
            result({ cost: turn, input: 10 * turn, output: 2 * turn }),
          ];
        }),
      });
      const session = await createClaudeSession({ ...baseSpec, model: "claude-opus-5-5" }, factory);
      const events: SessionEvent[] = [];
      session.subscribe((event) => events.push(event));
      await session.prompt("go");

      expect(session.modelRef()).toEqual({
        provider: CLAUDE_MODEL_PROVIDER,
        id: "claude-opus-4-8",
      });
      expect(served(events)).toEqual([
        { type: "model_served", model: { provider: CLAUDE_MODEL_PROVIDER, id: "claude-opus-5-5" } },
        {
          type: "model_served",
          model: { provider: CLAUDE_MODEL_PROVIDER, id: "claude-opus-4-8" },
          fallback: {
            from: { provider: CLAUDE_MODEL_PROVIDER, id: "claude-opus-5-5" },
            category: "cyber",
          },
        },
      ]);

      await session.prompt("carry on");
      expect(session.modelRef()?.id).toBe("claude-opus-4-8");
      expect(served(events)).toHaveLength(2);

      await session.detach();
      await session.prompt("and again");
      expect(attachments.map((attachment) => attachment.options.model)).toEqual([
        "claude-opus-5-5",
        "claude-opus-5-5",
      ]);
      expect(session.modelRef()).toEqual({
        provider: CLAUDE_MODEL_PROVIDER,
        id: "claude-opus-5-5",
      });
      expect(served(events).at(-1)).toEqual({
        type: "model_served",
        model: { provider: CLAUDE_MODEL_PROVIDER, id: "claude-opus-5-5" },
      });
      session.dispose();
    });

    it("keeps the session's model when only a subagent's answer fell back, and reads a notice with no scope as the session's", async () => {
      for (const [scope, expected] of [
        ["local", "claude-opus-5-5"],
        [undefined, "claude-opus-4-8"],
      ] as const) {
        const { factory } = scriptedQuery({
          onInput: answering(() => [
            init("claude-opus-5-5"),
            fellBack(scope),
            result({ cost: 1, input: 10, output: 2 }),
          ]),
        });
        const session = await createClaudeSession(
          { ...baseSpec, model: "claude-opus-5-5" },
          factory,
        );
        const events: SessionEvent[] = [];
        session.subscribe((event) => events.push(event));
        await session.prompt("go");
        expect(session.modelRef()?.id).toBe(expected);
        expect(served(events).map((event) => event.model.id)).toEqual(
          expected === "claude-opus-5-5" ? ["claude-opus-5-5"] : ["claude-opus-5-5", expected],
        );
        session.dispose();
      }
    });

    it("reads the client's context and snapshot marks as the same model, by the spec's own id", async () => {
      for (const [model, reported] of [
        ["claude-opus-5-5", "claude-opus-5-5[1m]"],
        ["claude-haiku-4-5-20251001", "claude-haiku-4-5"],
      ] as const) {
        const { factory } = scriptedQuery({
          onInput: answering(() => [init(reported), result({ cost: 1, input: 10, output: 2 })]),
        });
        const session = await createClaudeSession({ ...baseSpec, model }, factory);
        const events: SessionEvent[] = [];
        session.subscribe((event) => events.push(event));
        await session.prompt("go");
        expect(served(events).map((event) => event.model.id)).toEqual([model]);
        expect(session.modelRef()?.id).toBe(model);
        session.dispose();
      }
    });

    it("resumes on the model the client swapped out, never the one it swapped in", async () => {
      const configDir = scratchDir("infinitary-claude-coding-");
      const project = join(configDir, "projects", encodeClaudeProjectDir(baseSpec.cwd));
      mkdirSync(project, { recursive: true });
      const swapped = "0b7e3a52-5f1c-4c7e-9d3a-2f6b8e1c4a90";
      const steady = "6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
      // The transcript lines as the client writes them: a reply on each
      // model around the notice, which the client restores the last of when
      // it is resumed with no model named.
      const reply = (uuid: string, model: string) =>
        JSON.stringify({ type: "assistant", uuid, message: { model, content: [] } });
      writeFileSync(
        join(project, `${swapped}.jsonl`),
        `${[
          reply("a1", "claude-opus-5-5"),
          JSON.stringify({
            type: "system",
            subtype: "model_refusal_fallback",
            uuid: "n1",
            trigger: "refusal",
            direction: "retry",
            scope: "session",
            originalModel: "claude-opus-5-5",
            fallbackModel: "claude-opus-4-8",
            apiRefusalCategory: "cyber",
          }),
          reply("a2", "claude-opus-4-8"),
        ].join("\n")}\n`,
      );
      writeFileSync(join(project, `${steady}.jsonl`), `${reply("a1", "claude-opus-5-5")}\n`);
      for (const [resumeToken, asked] of [
        [swapped, "claude-opus-5-5"],
        [steady, undefined],
      ] as const) {
        const { factory, harness } = scriptedQuery({
          onInput: answering(() => [result({ cost: 0.01, input: 10, output: 2 })]),
        });
        const session = await createClaudeSession({ ...baseSpec, configDir, resumeToken }, factory);
        await session.prompt("carry on");
        expect(harness().options.resume).toBe(resumeToken);
        expect(harness().options.model).toBe(asked);
        session.dispose();
      }
    });
  });

  it("labels its model by the catalog's name: the one answering, else the one it asks for (INF-2625's guardrail)", async () => {
    // Two of the shipped catalog's pairs (claudeModelCatalog.test.ts owns its names).
    const catalogModel = (family: string) => {
      const model = CLAUDE_MODELS.find((entry) => entry.id.includes(family));
      if (!model) throw new Error(`the shipped catalog names no ${family} model`);
      return model;
    };
    const asked = catalogModel("opus");
    const answered = catalogModel("sonnet");
    let turn = 0;
    const { factory } = scriptedQuery({
      onInput: answering(() => {
        turn += 1;
        return [
          {
            type: "system",
            subtype: "init",
            model: turn === 1 ? answered.id : "claude-opus-4-8",
            session_id: "session-under-test",
          },
          result({ cost: 0.01 * turn, input: 10 * turn, output: 2 * turn }),
        ];
      }),
    });
    const session = await createClaudeSession({ ...baseSpec, model: asked.id }, factory);
    // Before the client says anything, the model it is asked for names it.
    expect(session.modelLabel()).toBe(asked.name);
    await session.prompt("go");
    expect(session.modelLabel()).toBe(answered.name);
    // A model the shipped catalog does not name has no label of its own.
    await session.prompt("carry on");
    expect(session.modelRef()?.id).toBe("claude-opus-4-8");
    expect(session.modelLabel()).toBeUndefined();
    session.dispose();
    await session.closed();
  });

  it("normalizes deltas and tool calls, losing none emitted before anyone subscribed", async () => {
    const { factory } = scriptedQuery({
      onInput: answering(() => [
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "hmm" },
          },
        },
        {
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
        },
        says.toolCall("call-1", "Bash"),
        says.toolResult("call-1"),
        result({ cost: 0.01, input: 100, output: 20 }),
      ]),
    });
    const session = await createClaudeSession(baseSpec, factory);
    const events: SessionEvent[] = [];
    const turn = session.prompt("go");
    // Subscribe late on purpose: a spawn subscribes after the session opens,
    // and events raced in before that must not vanish.
    session.subscribe((event) => events.push(event));
    await turn;

    expect(events.map((event) => event.type)).toEqual([
      "background_work_changed",
      "input_read",
      "thinking_delta",
      "assistant_delta",
      "tool_start",
      "tool_end",
      "turn_end",
      "turn_closed",
    ]);
    expect(events.find((event) => event.type === "assistant_delta")).toMatchObject({
      text: "hello",
      taskId: "task-1",
    });
    expect(events.find((event) => event.type === "tool_start")).toMatchObject({
      callId: "call-1",
      toolName: "Bash",
    });
    expect(events.find((event) => event.type === "tool_end")).toMatchObject({
      callId: "call-1",
      toolName: "Bash",
      isError: false,
    });
    session.dispose();
  });

  it("speaks its own tools by their bare names", async () => {
    const { factory } = scriptedQuery({
      onInput: answering(() => [
        says.toolCall("call-1", "mcp__infinitary__note_progress"),
        says.toolResult("call-1"),
        result({ cost: 0.01, input: 10, output: 2 }),
      ]),
    });
    const session = await createClaudeSession(baseSpec, factory);
    const events: SessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.prompt("go");
    expect(
      events.flatMap((event) =>
        event.type === "tool_start" || event.type === "tool_end" ? [event.toolName] : [],
      ),
    ).toEqual(["note_progress", "note_progress"]);
    session.dispose();
  });

  it("reports each turn's own spend, not the session's running total", async () => {
    let turnIndex = 0;
    const { factory } = scriptedQuery({
      onInput: answering(() => {
        turnIndex += 1;
        // The client reports cumulative totals: turn two carries turn one's
        // spend too. Recording them raw would over-bill every later turn.
        return [
          turnIndex === 1
            ? result({ cost: 0.01, input: 100, output: 20 })
            : result({ cost: 0.03, input: 260, output: 55 }),
        ];
      }),
    });
    const session = await createClaudeSession(baseSpec, factory);
    const usage: unknown[] = [];
    session.subscribe((event) => {
      if (event.type === "turn_end") usage.push(event.usage);
    });
    await session.prompt("first");
    await session.prompt("second");

    expect(usage[0]).toMatchObject({ input: 100, output: 20 });
    expect(usage[1]).toMatchObject({ input: 160, output: 35 });
    expect((usage[0] as { cost: number }).cost).toBeCloseTo(0.01, 6);
    expect((usage[1] as { cost: number }).cost).toBeCloseTo(0.02, 6);
    session.dispose();
  });

  it("folds a steer into the running turn after the tool in flight, and settles the prompt once", async () => {
    let steer: SDKUserMessage | undefined;
    const { factory, harness } = scriptedQuery({
      onInput: (message, emit) => {
        if (message.priority === CLAUDE_STEER_PRIORITY) {
          steer = message;
          return;
        }
        opens(emit, message);
        emit(says.toolCall("call-1", "Bash"));
      },
    });
    const session = await createClaudeSession(baseSpec, factory);
    const events: SessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    let settled = 0;
    const turn = session.prompt("count to a hundred").then(() => {
      settled += 1;
    });
    await vi.waitFor(() => expect(harness().inputs).toHaveLength(1));
    await session.steer("and count the starboard hatch too");
    await vi.waitFor(() => expect(steer).toBeDefined());
    // Measured against the real client: the tool finishes, the steer joins
    // the turn at its next step, and the exchange ends in ONE result.
    const emit = harness().emit;
    emit(says.toolResult("call-1"));
    emit(says.ack(steer as SDKUserMessage));
    closes(emit, result({ cost: 0.02, input: 140, output: 9 }, "steered"));
    await turn;

    expect(harness().inputs.map((message) => message.priority)).toEqual([undefined, "next"]);
    expect(settled).toBe(1);
    expect(events.filter((event) => event.type === "turn_end")).toHaveLength(1);
    expect(events.some((event) => event.type === "turn_failed")).toBe(false);
    expect(session.takeUndeliveredSteers()).toEqual([]);
    session.dispose();
  });

  it("gives back a steer no turn took in, once", async () => {
    const { factory, harness } = scriptedQuery({
      onInput: (message, emit) => {
        if (message.priority === CLAUDE_STEER_PRIORITY) return;
        opens(emit, message);
      },
    });
    const session = await createClaudeSession(baseSpec, factory);
    const turn = session.prompt("go");
    await vi.waitFor(() => expect(harness().inputs).toHaveLength(1));
    // The run has made its last look at the queue: the steer lands, and the
    // turn ends without taking it in.
    await session.steer("a word too late");
    expect(session.takeUndeliveredSteers()).toEqual([]);
    closes(harness().emit, result({ cost: 0.01, input: 10, output: 2 }));
    await turn;
    expect(session.takeUndeliveredSteers()).toEqual(["a word too late"]);
    expect(session.takeUndeliveredSteers()).toEqual([]);
    // A steer with no turn to join is held, never pushed.
    await session.steer("while idle");
    expect(harness().inputs).toHaveLength(2);
    expect(session.takeUndeliveredSteers()).toEqual(["while idle"]);
    session.dispose();
  });

  it("sends images as Anthropic image blocks on prompt and steer", async () => {
    const { factory, harness } = scriptedQuery({
      onInput: (message, emit) => {
        if (message.priority === CLAUDE_STEER_PRIORITY) {
          emit(says.ack(message));
          closes(emit, result({ cost: 0.02, input: 20, output: 4 }, "steered"));
          return;
        }
        opens(emit, message);
      },
    });
    const session = await createClaudeSession(baseSpec, factory);
    const image = { mimeType: "image/png", data: "abc" };
    const turn = session.prompt("see this", [image]);
    await vi.waitFor(() => expect(harness().inputs).toHaveLength(1));
    await session.steer("and this", [image]);
    await turn;
    const contents = harness().inputs.map((message) => message.message.content);
    expect(contents[0]).toEqual([
      { type: "text", text: "see this" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
    ]);
    expect(contents[1]).toEqual([
      { type: "text", text: "and this" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
    ]);
    session.dispose();
  });

  it("tells the account a turn that succeeded, and not one that failed", async () => {
    const served: string[] = [];
    let failing = true;
    const { factory } = scriptedQuery({
      onInput: answering(() => [
        failing
          ? {
              type: "assistant",
              message: { role: "assistant", content: [{ type: "text", text: "no" }] },
              parent_tool_use_id: null,
              error: "authentication_failed",
            }
          : result({ cost: 0.01, input: 10, output: 2 }, "yes"),
        ...(failing
          ? [
              {
                type: "result",
                subtype: "success",
                is_error: true,
                result: "no",
                api_error_status: 401,
                duration_api_ms: 12,
                total_cost_usd: 0,
                modelUsage: {},
              },
            ]
          : []),
      ]),
    });
    const session = await createClaudeSession(
      { ...baseSpec, onServed: (id) => served.push(id) },
      factory,
    );
    await session.prompt("go");
    expect(served).toEqual([]);
    failing = false;
    await session.prompt("again");
    expect(served).toEqual(["acct_claude"]);
    session.dispose();
  });

  it("settles an interrupted turn quietly and stays steerable", async () => {
    let interrupted = false;
    const { factory } = scriptedQuery({
      // The interrupted job never answers on its own; the interrupt ends it.
      // Work sent afterwards runs normally - that is the contract.
      onInput: (message, emit) => {
        opens(emit, message);
        if (interrupted) closes(emit, result({ cost: 0.02, input: 140, output: 8 }, "carried on"));
      },
      onInterrupt: (emit) => {
        interrupted = true;
        closes(emit, result({ cost: 0.01, input: 100, output: 0 }, ""));
      },
    });
    const session = await createClaudeSession(baseSpec, factory);
    const events: SessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    const turn = session.prompt("a long job");
    await vi.waitFor(async () => {
      await session.abort();
      expect(interrupted).toBe(true);
    });
    // The seam's two-intent interrupt, as Pi's session settles it: the turn
    // ends quietly and the session stays steerable. That it was an
    // interrupt is the owner's own fact (it asked for it).
    await expect(turn).resolves.toBeUndefined();
    expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
    await expect(session.prompt("carry on")).resolves.toBeUndefined();
    session.dispose();
  });

  it("settles an interrupted turn quietly even when the client closes it with an error result", async () => {
    let interrupted = false;
    const { factory } = scriptedQuery({
      onInput: (message, emit) => {
        opens(emit, message);
        if (interrupted) closes(emit, result({ cost: 0.02, input: 140, output: 8 }, "carried on"));
      },
      onInterrupt: (emit) => {
        interrupted = true;
        // The client's abort path can settle the cut-short turn with an
        // error result; with no stop reason to read, the host's own
        // interrupt is what the turn ended on.
        interruptedBy({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["[ede_diagnostic] result_type=user stop_reason=null"],
          total_cost_usd: 0.01,
          modelUsage: {},
        })(emit);
      },
    });
    const session = await createClaudeSession(baseSpec, factory);
    const events: SessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    const turn = session.prompt("a long job");
    await vi.waitFor(async () => {
      await session.abort();
      expect(interrupted).toBe(true);
    });
    await expect(turn).resolves.toBeUndefined();
    expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
    await expect(session.prompt("carry on")).resolves.toBeUndefined();
    session.dispose();
  });

  it("lets a cut-off that answers an interrupt consume it, so the next clean turn reports", async () => {
    let interrupted = false;
    const { factory } = scriptedQuery({
      onInput: (message, emit) => {
        opens(emit, message);
        if (interrupted) closes(emit, result({ cost: 0.02, input: 140, output: 8 }, "carried on"));
      },
      onInterrupt: (emit) => {
        interrupted = true;
        emit({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "Not logged in." }] },
          parent_tool_use_id: null,
          error: "authentication_failed",
        });
        closes(emit, {
          type: "result",
          subtype: "success",
          is_error: true,
          result: "Not logged in.",
          api_error_status: 401,
          total_cost_usd: 0.01,
          modelUsage: {},
        });
      },
    });
    const session = await createClaudeSession(baseSpec, factory);
    const events: SessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    const turn = session.prompt("a long job");
    // The client has the job before the interrupt lands.
    await vi.waitFor(async () => {
      await session.abort();
      expect(interrupted).toBe(true);
    });
    // The sign-out is news, so the interrupted turn settles as that failure...
    await expect(turn).resolves.toBeUndefined();
    expect(events).toContainEqual({
      type: "turn_failed",
      taskId: "task-1",
      error: "Not logged in.",
      cutOff: { class: "signed_out" },
    });
    // ...and the interrupt is spent: the next clean answer is not read as one.
    const failures = events.filter((event) => event.type === "turn_failed").length;
    await expect(session.prompt("carry on")).resolves.toBeUndefined();
    expect(events.filter((event) => event.type === "turn_failed")).toHaveLength(failures);
    session.dispose();
  });

  it("fails the turn at the provider in the session's own words, and stays steerable", async () => {
    let failing = true;
    const { factory } = scriptedQuery({
      onInput: answering(() => [
        failing
          ? {
              type: "result",
              subtype: "success",
              is_error: true,
              result: "Claude usage limit reached. Your limit resets at 3pm.",
              total_cost_usd: 0,
              modelUsage: {},
            }
          : result({ cost: 0.01, input: 10, output: 2 }, "carried on"),
      ]),
    });
    const session = await createClaudeSession(baseSpec, factory);
    const events: SessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    // The turn settles the way Pi's does: a turn_failed carrying the words,
    // never a thrown error - a throw would end the task, and the host's
    // retry is what keeps the guidance (docs/inbox.md).
    await expect(session.prompt("go")).resolves.toBeUndefined();
    expect(events).toContainEqual({
      type: "turn_failed",
      taskId: "task-1",
      error: "Claude usage limit reached. Your limit resets at 3pm.",
    });
    failing = false;
    await expect(session.prompt("again")).resolves.toBeUndefined();
    session.dispose();
  });

  it("routes each plan-window reading to the account its session is bound to", async () => {
    const readings: { accountId: string; windowId?: string }[] = [];
    const { factory } = scriptedQuery({
      onInput: answering(() => [
        {
          type: "rate_limit_event",
          rate_limit_info: { status: "allowed", utilization: 0.4, rateLimitType: "five_hour" },
        },
        result({ cost: 0.01, input: 10, output: 2 }),
      ]),
    });
    const session = await scriptedClaudeFactory({
      configDir: baseSpec.configDir,
      query: factory,
      onRateLimit: (accountId, reading) =>
        readings.push({ accountId, ...(reading.windowId ? { windowId: reading.windowId } : {}) }),
    }).open(
      codingSpec({ binding: { backend: "claude", accountId: "acct_work" }, cwd: baseSpec.cwd }),
    );
    await session.prompt("go");
    expect(readings).toEqual([{ accountId: "acct_work", windowId: "five_hour" }]);
    session.dispose();
  });

  it("leases the machine's one store per client, whichever account it serves", async () => {
    // The vault account is bookkeeping: whichever Claude account binds a
    // crewmate, the client runs on the machine's default login, never an
    // account dir of the app's.
    const store = scratchDir("infinitary-claude-default-");
    const factory = scriptedClaudeFactory({
      configDir: store,
      query: scriptedQuery({
        onInput: answering(() => [result({ cost: 0.01, input: 10, output: 2 })]),
      }).factory,
    });
    const [a, b] = await Promise.all(
      ["acct_a", "acct_b"].map((accountId) =>
        factory.open(codingSpec({ binding: { backend: "claude", accountId }, cwd: "/tmp/wt" })),
      ),
    );
    if (!a || !b) throw new Error("two sessions");
    // Nothing is leased before a client is attached.
    expect(hasActiveSession(store)).toBe(false);
    await a.prompt("go");
    await b.prompt("go");
    // A client stays attached between prompts, for the work it does on its own.
    expect(hasActiveSession(store)).toBe(true);
    a.dispose();
    await a.closed();
    expect(hasActiveSession(store)).toBe(true);
    b.dispose();
    await b.closed();
    expect(hasActiveSession(store)).toBe(false);
  });

  it("ends the client when the crewmate is dismissed, and takes no prompt after", async () => {
    const { factory, harness } = scriptedQuery({
      onInput: answering(() => [result({ cost: 0.01, input: 10, output: 2 })]),
    });
    const session = await createClaudeSession(baseSpec, factory);
    await session.prompt("go");
    session.dispose();
    await session.closed();
    expect(harness().closed()).toBe(true);
    await expect(session.prompt("anyone there")).rejects.toThrow(/has ended/);
  });

  it("serves every firstmate tool always-loaded, so ToolSearch never defers emit_card (v2.0)", async () => {
    // The Sep 15 Claude crewmates spent 22 ToolSearch calls finding the
    // deferred emit_card. The MCP client is the real consumer of the
    // server the session hands the SDK: what it lists is what the model
    // is shown.
    const { factory, harness } = scriptedQuery({
      onInput: answering(() => [result({ cost: 0.01, input: 10, output: 2 })]),
    });
    const callbacks: CrewmateToolDelegate = {
      onCard: () => undefined,
      onCloseCard: () => "closed",
      onFollowup: () => "filed",
      onProgress: () => "noted",
      onReport: () => "reported",
      onQueryTasks: () => ({ rows: [], total: 0 }),
      // The live-build checks (Step 4) ride the same server on a live task.
      onLintPanel: async () => "clock: No findings.",
      onPlacePanel: async () => ({ ok: true, waitedMs: 0, panels: [] }),
      onCapturePanel: async ({ id }) => ({
        ok: true,
        id,
        photographed: "docked",
        images: [
          { theme: "dark", path: "", width: 1, height: 1, data: "AA==", mimeType: "image/png" },
        ],
      }),
    };
    // What these callbacks bind is what the server must list, every field kept.
    const bound = bindTools(CREWMATE_TOOLS, callbacks);
    const session = await createClaudeSession({ ...baseSpec, ...callbacks }, factory);
    await session.prompt("go");
    const server = harness().options.mcpServers?.[CLAUDE_SEAT_TOOL_SERVER];
    if (server?.type !== "sdk") throw new Error("expected the in-process server");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverTransport);
    const client = new Client({ name: "infinitary-test", version: "0" });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(bound.map((tool) => tool.name).sort());
      const captured = await client.callTool({ name: "capture_panel", arguments: { id: "clock" } });
      expect(captured.content).toEqual([
        { type: "text", text: expect.stringContaining('Captured "clock" in both themes') },
        { type: "image", data: "AA==", mimeType: "image/png" },
      ]);
      const linted = await client.callTool({ name: "lint_panel", arguments: {} });
      expect(linted.content).toEqual([{ type: "text", text: "clock: No findings." }]);
      for (const tool of tools) {
        expect(tool._meta?.["anthropic/alwaysLoad"], tool.name).toBe(true);
      }
      const emitCard = tools.find((tool) => tool.name === "emit_card");
      expect(emitCard?.description).toContain("send tags, never entity-escaped markup");
      expect(emitCard?.description).toContain(
        "Ask every merge on a merge card, one per pull request: one merge action",
      );
      const boundCard = bound.find((tool) => tool.name === "emit_card");
      expect(Object.keys(emitCard?.inputSchema.properties ?? {})).toEqual(
        Object.keys(boundCard?.parameters.properties ?? {}),
      );
    } finally {
      await client.close();
      session.dispose();
    }
  });

  it("registers the card tool only when a crewmate has somewhere to send cards", async () => {
    const answer = answering(() => [result({ cost: 0.01, input: 10, output: 2 })]);
    const withCards = scriptedQuery({ onInput: answer });
    const a = await createClaudeSession(
      { ...baseSpec, onCard: () => undefined },
      withCards.factory,
    );
    await a.prompt("go");
    expect(Object.keys(withCards.harness().options.mcpServers ?? {})).toEqual([
      CLAUDE_SEAT_TOOL_SERVER,
    ]);
    a.dispose();

    const withoutCards = scriptedQuery({ onInput: answer });
    const b = await createClaudeSession(baseSpec, withoutCards.factory);
    await b.prompt("go");
    expect(withoutCards.harness().options.mcpServers).toBeUndefined();
    b.dispose();
  });
});

describe("the client's own continuations", () => {
  /**
   * A crewmate whose first prompt is answered, and whose client then runs a
   * turn of its own - what a background command it started finishing does.
   */
  async function continuing() {
    const starts: number[] = [];
    const ends: Array<[string | undefined, CutOff | undefined]> = [];
    const steers: SDKUserMessage[] = [];
    const { factory, harness } = scriptedQuery({
      onInput: (message, emit) => {
        if (message.priority === CLAUDE_STEER_PRIORITY) {
          steers.push(message);
          return;
        }
        opens(emit, message);
        closes(emit, result({ cost: 0.01, input: 10, output: 2 }, "started the build"));
      },
    });
    const session = await createClaudeSession(
      {
        ...baseSpec,
        onContinuationStart: () => starts.push(starts.length + 1),
        onContinuationEnd: (error, cutOff) => ends.push([error, cutOff]),
      },
      factory,
    );
    await session.prompt("start the build in the background");
    return { session, harness, starts, ends, steers };
  }

  it("INF-1117: reports the client's compact boundary as an owner-only context fact", async () => {
    const { session, harness } = await continuing();
    const events: SessionEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));
    harness().emit({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 160000 },
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual({ type: "context_compacted", turn: "unknown" }),
    );
    unsubscribe();
  });

  /**
   * INF-3011, captain's pick: the character shows the whole shortening on
   * Claude, read from the client's status message; one heard only by its
   * boundary still shows, as a start and an end together. The messages are
   * the real client's, in the order it sent them during a shortening.
   */
  it("INF-3011: reports the client's own shortening as its progress, start and end", async () => {
    const { session, harness } = await continuing();
    const events: SessionEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));
    const emit = harness().emit;
    const folds = () =>
      events.flatMap((event) =>
        (event.type === "tool_start" || event.type === "tool_end") &&
        event.toolName === "compact_context"
          ? [event.type]
          : [],
      );
    emit({ type: "system", subtype: "status", status: "requesting" });
    emit({ type: "system", subtype: "status", status: "compacting" });
    await vi.waitFor(() => expect(folds()).toEqual(["tool_start"]));
    emit({ type: "system", subtype: "status", status: null, compact_result: "success" });
    emit({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 507, post_tokens: 698 },
    });
    emit({ type: "system", subtype: "status", status: "requesting" });
    await vi.waitFor(() =>
      expect(events).toContainEqual({ type: "context_compacted", turn: "unknown" }),
    );
    expect(folds()).toEqual(["tool_start", "tool_end"]);
    // A boundary with no start heard: the short version.
    emit({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 160000 },
    });
    await vi.waitFor(() =>
      expect(folds()).toEqual(["tool_start", "tool_end", "tool_start", "tool_end"]),
    );
    unsubscribe();
  });

  it("replaces background membership and invalidates it when the client transport ends", async () => {
    const { session, harness } = await continuing();
    const counts: Array<number | undefined> = [];
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "background_work_changed") counts.push(event.count);
    });
    const signal = (tasks: unknown[]) =>
      harness().emit({ type: "system", subtype: "background_tasks_changed", tasks });
    signal([{ task_id: "a", task_type: "local_bash" }]);
    signal([
      { task_id: "b", task_type: "agent" },
      { task_id: "c", task_type: "local_bash" },
    ]);
    signal([]);
    await vi.waitFor(() => expect(counts).toEqual([1, 2, 0]));
    harness().end();
    await vi.waitFor(() => expect(counts).toEqual([1, 2, 0, undefined]));
    unsubscribe();
  });

  it("brackets a turn the client runs on its own with its own running and idle", async () => {
    const { session, harness, starts, ends } = await continuing();
    const emit = harness().emit;
    // Measured on the real client: a finished background command is
    // announced, then the client says it is running.
    emit({ type: "system", subtype: "task_notification", status: "completed", task_id: "b1" });
    await Promise.resolve();
    expect(starts).toEqual([]);
    emit(says.running);
    await vi.waitFor(() => expect(starts).toEqual([1]));
    expect(session.isStreaming()).toBe(true);
    // A continuation is a running turn: a prompt waits for it to end.
    await expect(session.prompt("next")).rejects.toThrow(/still working/);
    emit({
      type: "assistant",
      message: { content: [{ type: "text", text: "The build passed." }] },
    });
    emit(result({ cost: 0.02, input: 20, output: 4 }, "The build passed."));
    await Promise.resolve();
    // The result alone does not end it: the client says when it is idle.
    expect(ends).toEqual([]);
    emit(says.idle);
    await vi.waitFor(() => expect(ends).toEqual([[undefined, undefined]]));
    expect(session.isStreaming()).toBe(false);

    // A result the SDK delivers again after the client went idle is not
    // another continuation: only the client's own running opens one.
    emit(result({ cost: 0.02, input: 20, output: 4 }, "The build passed."));
    await Promise.resolve();
    expect(starts).toEqual([1]);
    expect(ends).toHaveLength(1);
    session.dispose();
  });

  it("folds a steer into the continuation, and gives back one it never took in", async () => {
    const { session, harness, ends, steers } = await continuing();
    const emit = harness().emit;
    emit(says.running);
    await vi.waitFor(() => expect(session.isStreaming()).toBe(true));
    await session.steer("include one more check");
    await vi.waitFor(() => expect(steers).toHaveLength(1));
    expect(steers[0]?.priority).toBe("next");
    emit(says.ack(steers[0] as SDKUserMessage));
    await session.steer("and a word too late");
    await vi.waitFor(() => expect(steers).toHaveLength(2));
    expect(session.takeUndeliveredSteers()).toEqual([]);
    closes(emit, result({ cost: 0.02, input: 20, output: 4 }, "checked"));
    await vi.waitFor(() => expect(ends).toHaveLength(1));
    expect(session.takeUndeliveredSteers()).toEqual(["and a word too late"]);
    session.dispose();
  });

  it("reports a failed continuation as its own turn failing, typed, and then ends it", async () => {
    const { session, harness, ends } = await continuing();
    const events: SessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    const emit = harness().emit;
    emit(says.running);
    emit({ type: "assistant", message: { content: [] }, error: "oauth_org_not_allowed" });
    closes(emit, {
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Your organization does not allow this.",
      total_cost_usd: 0,
      modelUsage: {},
    });
    await vi.waitFor(() => expect(ends).toHaveLength(1));
    expect(events.filter((event) => event.type === "turn_failed")).toEqual([
      {
        type: "turn_failed",
        taskId: "task-1",
        error: "Your organization does not allow this.",
        cutOff: { class: "refused" },
      },
    ]);
    // The failure was the turn's own, told once; the boundary just closes.
    expect(ends).toEqual([[undefined, undefined]]);
    session.dispose();
  });

  it("ends a continuation the client's exit cut short, saying so", async () => {
    const { harness, ends } = await continuing();
    harness().emit(says.running);
    harness().end();
    await vi.waitFor(() =>
      expect(ends).toEqual([["Claude stopped before the turn finished.", undefined]]),
    );
  });

  it("ends a continuation its client crashed under with the client's error (INF-2625's guardrail)", async () => {
    const { harness, ends } = await continuing();
    harness().emit(says.running);
    harness().fail(new Error("the client crashed"));
    await vi.waitFor(() => expect(ends).toEqual([["the client crashed", undefined]]));
  });

  it("interrupts a continuation on abort, as it does a prompt", async () => {
    const { session, harness, ends } = await continuing();
    harness().emit(says.running);
    await vi.waitFor(() => expect(session.isStreaming()).toBe(true));
    await session.abort();
    expect(harness().interrupts()).toBe(1);
    closes(harness().emit, interruptedResult);
    await vi.waitFor(() => expect(ends).toEqual([[undefined, undefined]]));
    session.dispose();
  });
});
