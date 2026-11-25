import {
  type HookCallback,
  type Options,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from "@anthropic-ai/claude-agent-sdk";
import { hostPlatform } from "../platform";
import { compactionNow, SESSION_COMPACTION } from "../session/compaction";
import type { SessionCompaction, SessionSpec } from "../session/session";
import type { BoundTool } from "../session/tools";
import { CLAUDE_SEAT_TOOL_SERVER } from "../storage/sessionReader";
import type { ClaudeAccessSettings } from "./claudeAccess";
import { claudeEnvFor } from "./claudeCli";
import { type ClaudeClientExit, claudeClientSpawn } from "./claudeClientProcess";
import { CLAUDE_FENCED_TOOLS, claudeFenceHook } from "./claudeFence";
import {
  type ClaudeProjectResources,
  claudeProjectInstructionsText,
} from "./claudeProjectResources";
import { claudeToolNameHint, claudeToolServer } from "./claudeTaskTools";
import { claudeCodingReasoning } from "./reasoning";

/**
 * The exact options a Claude session's query hands the SDK, and the client
 * settings and environment they carry: the backend's one Claude touchpoint
 * for both session shapes (`claudeRollingSession.ts`,
 * `claudeOneShotSession.ts`), pure and built from the spec alone.
 */

/**
 * Anthropic's legacy extended-thinking floor. A fixed thinking budget
 * must fit below `max_tokens`; newer adaptive models may still think
 * when asked to disable it.
 */
const CLAUDE_THINKING_FLOOR_TOKENS = 1024;

/**
 * The client's documented switch for its auto memory, set on every session
 * (FI3-795). Left on, the client keeps notes per project in the person's
 * Claude folder (`projects/<the working copy's main checkout>/memory/`),
 * serves their index to every session started there and, in the coding
 * preset, tells the model to write more, whatever `settingSources` says:
 * measured on the installed 2.1.288 and the SDK's 2.1.234, the crewmate, the
 * seat and the question were each served a planted index. Those notes are
 * the person's own Claude setup, and the project's own knowledge lives in
 * its committed instructions (`claudeAutoMemory.integration.test.ts`).
 */
export const CLAUDE_SESSION_ENV = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } as const;

/**
 * The client's documented attribution setting, handed to every coding
 * session as flag settings (the captain, 2026-10-15: "disable commit and PR
 * author attribution for all claude crewmates in infinitary (it's a claude
 * setting)"). Left to its default the client has the model end each commit
 * message with a `Co-Authored-By` trailer and each pull request description
 * with a "Generated with Claude Code" line; empty text hides both
 * (`claudeAttribution.integration.test.ts`). Flag settings are the app's
 * own layer, so the person's own Claude settings stay unread, but for the
 * token command, address and gateway headers a session is handed
 * (`claudeAccess.ts`).
 */
export const CLAUDE_CODING_SETTINGS = { attribution: { commit: "", pr: "" } } as const;

/**
 * The longest time limit a coding session's command may ask for (the
 * captain, 2026-11-04, INF-2490 and INF-2225's lost runs: "change highest to
 * 3 days, not 24 which is too much"). The client counts a command's limit
 * from its start, so a heavy run waiting in its computer's line
 * (docs/heavy-runs.md) spends its limit while it waits; left to its default
 * the client stops a background command after 2 hours at most.
 */
export const CLAUDE_COMMAND_TIME_CEILING_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The client's documented ceiling on a command's time limit, handed to
 * every coding session over any value the host's shell has. The client
 * honors a command's own limit up to it, so a heavy run started with a
 * 3-day limit is not stopped at the 30-minute background default
 * (`claudeCommandTimeLimit.integration.test.ts`). The default itself,
 * `BASH_DEFAULT_TIMEOUT_MS`, stays the client's own: it is also the
 * 2-minute limit of every ordinary command started without one.
 */
export const CLAUDE_CODING_ENV = {
  BASH_MAX_TIMEOUT_MS: String(CLAUDE_COMMAND_TIME_CEILING_MS),
} as const;

/** Claude clamps this to its model window, then subtracts output room and a 13k buffer. */
const CLAUDE_COMPACTION_SETTINGS = claudeCompactionSettings(SESSION_COMPACTION);

/**
 * The client's own window for a rule: its point plus the first mate's 8,192
 * answer allowance and the client's 13,000 buffer. Price steps are Pi's to
 * read, so only the ceiling crosses; a rule with none (each model's limit)
 * leaves the client's window at the model's own.
 */
export function claudeCompactionSettings(compaction: SessionCompaction | undefined): {
  autoCompactEnabled: true;
  autoCompactWindow?: number;
} {
  const point = compaction?.maxContextTokens;
  return {
    autoCompactEnabled: true,
    ...(point === undefined ? {} : { autoCompactWindow: point + 8192 + 13_000 }),
  };
}

/** A person's client switches must not disable or enlarge the app's compaction budget. */
function claudeSessionEnv(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = claudeEnvFor(base);
  for (const key of [
    "DISABLE_COMPACT",
    "DISABLE_AUTO_COMPACT",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
    "CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE",
  ])
    delete env[key];
  return env;
}

/** The client's own words a rolling session turns on: the idle signal the settle rule reads. */
export const CLAUDE_ROLLING_ENV = { CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" } as const;

// INF-133 F1: the captain chose a higher, host-owned first mate tool-result cap.
// An explicit positive value takes precedence over the client's remote configuration.
export const CLAUDE_FIRSTMATE_MCP_OUTPUT_TOKENS = 100_000;

/**
 * The first mate's tool-result band in characters: the client takes a result
 * whose estimate (a quarter token per character) is at most half the cap
 * without counting it (docs/claude-client.md). INF-451: each of the seat's
 * tools declares it, or the client saves a result past 50,000 characters to a
 * file and serves a preview the seat has no tool to open.
 */
export const CLAUDE_FIRSTMATE_TOOL_RESULT_CHARACTERS = (CLAUDE_FIRSTMATE_MCP_OUTPUT_TOKENS / 2) * 4;

/**
 * The client's documented switch that keeps its per-turn extras off the
 * seat: without it the installed 2.1.283 tells a seat that ran a few tool
 * calls without a word that "the user hasn't heard from you"
 * (`silent_turn_reminder`), and counts down a token budget after every
 * request. The Firstmate's turn ends with brief output by contract, and its
 * captain speaks only through the app. What the switch cannot reach - the
 * start-of-session `environment`, `model`, `session_context` and `date` -
 * is the accepted exposure in docs/claude-client.md, and
 * `claudeToolSurface.test.ts` holds the set on the real client. A coding
 * session keeps the client's extras: they are its own coding aids.
 */
export const CLAUDE_SEAT_ENV = {
  CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
  MAX_MCP_OUTPUT_TOKENS: String(CLAUDE_FIRSTMATE_MCP_OUTPUT_TOKENS),
} as const;

/** The priority a steer rides; measured, see the module comment. */
export const CLAUDE_STEER_PRIORITY = "next" as const;

type ClaudeSessionOptionsInput = {
  spec: SessionSpec;
  /** The host environment; the client's own is derived from it. */
  env: NodeJS.ProcessEnv;
  executable: string | undefined;
  stderr: (data: string) => void;
  /**
   * Where the session learns when the client this query spawns has exited:
   * its stream can end before then (`claudeClientProcess.ts`).
   */
  exit?: ClaudeClientExit;
  /**
   * The person's own Claude Code token command, address and gateway headers,
   * the only keys of their settings a session is handed (`claudeAccess.ts`);
   * their usage reporting setup goes to the app's receiver instead
   * (`claudeReporting.ts`).
   */
  access?: ClaudeAccessSettings;
  /**
   * A rolling session's client attachment: the model it asks for (never
   * one the client swapped in), the captain's text served right now, and
   * whether it resumes the recorded session or starts one under the
   * session's id.
   */
  attachment?: {
    model?: string;
    served?: string;
    session: { resume: string } | { sessionId: string };
    /** A coding session's working copy: its instruction file and staged skills. */
    project?: ClaudeProjectResources;
    /** Asked before each tool call the client would run: the safe stop's gate (`stopSafely`). */
    toolGate?: HookCallback;
  };
};

/**
 * The app's in-process server for the spec's tools, served always-load, with
 * the result length the client serves whole when one is given.
 */
function toolServer(
  tools: readonly BoundTool[],
  wholeResultCharacters?: number,
): Options["mcpServers"] {
  return { [CLAUDE_SEAT_TOOL_SERVER]: claudeToolServer(tools, wholeResultCharacters) };
}

/**
 * The hooks a session's query carries: the safe stop's gate when it has one,
 * and, for a session serving the app's tools, the full name back for a call
 * of one by its own name (`claudeToolNameHint`). The client asks the app's
 * own hooks even with `disableAllHooks`, which a staged skill sets: that
 * switch turns off the hooks settings and skills declare.
 */
function sessionHooks(
  tools: readonly BoundTool[],
  toolGate?: HookCallback,
  fence?: HookCallback,
): Pick<Options, "hooks"> {
  const gates = [...(fence ? [fence] : []), ...(toolGate ? [toolGate] : [])];
  const hooks: NonNullable<Options["hooks"]> = {
    ...(gates.length > 0 ? { PreToolUse: [{ hooks: gates }] } : {}),
    ...(tools.length > 0 ? { PostToolBatch: [{ hooks: [claudeToolNameHint(tools)] }] } : {}),
  };
  return Object.keys(hooks).length > 0 ? { hooks } : {};
}

/**
 * The exact options a session's query hands the SDK, from its spec (and, for
 * a rolling session, its attachment) alone. Its call shape is the backend's
 * one Claude touchpoint, pinned by the seat's and the question's tests;
 * change them together.
 */
export function claudeSessionOptions(input: ClaudeSessionOptionsInput): Options {
  const { spec } = input;
  const request = spec.bounds?.request;
  const level = spec.thinking.level;
  const attachment = input.attachment;
  const opened = claudeCodingReasoning(spec).level;
  const codingEffort = opened === "default" ? undefined : opened;
  // The spec's output cap, in the client's own terms, and the one backend
  // rule it brings: a legacy thinking budget must fit below the cap, so a
  // cap at or under that floor requests thinking off.
  const maxOutput = request?.maxOutputTokens;
  const outputCap =
    maxOutput !== undefined ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutput) } : {};
  const thinks =
    level !== "off" && !(maxOutput !== undefined && maxOutput <= CLAUDE_THINKING_FLOOR_TOKENS);
  if (spec.shape.turns === "rolling") {
    if (!attachment) throw new Error("A rolling Claude session attaches with a session.");
    const coding = spec.builtins === "coding";
    const fenced = coding && spec.fenced === true;
    const project = attachment.project;
    // A fenced session stages no skill: a plugin can bring hooks and servers
    // of its own.
    const staged =
      coding &&
      !fenced &&
      Boolean(
        project?.skillsPlugin ||
          project?.personalSkillsPlugin ||
          project?.pluginSkillsPlugins?.length ||
          project?.runbookSkillsPlugin,
      );
    return {
      cwd: spec.cwd,
      // The app spawns the client, so the session knows when it has exited;
      // a coding session's client is its task's process root on macOS and
      // Linux.
      spawnClaudeCodeProcess: claudeClientSpawn({
        stderr: input.stderr,
        ...(coding && hostPlatform() !== "win32" ? { owner: spec.owner } : {}),
        ...(input.exit ? { exit: input.exit } : {}),
      }),
      // The machine's default login and nothing ambient, none of the
      // person's Claude notes, plus the session state events the settle rule
      // reads, the output bound, for the seat none of the client's per-turn
      // extras, and for a coding session the longest command time limit.
      env: {
        ...claudeSessionEnv(input.env),
        ...CLAUDE_SESSION_ENV,
        ...CLAUDE_ROLLING_ENV,
        ...(coding ? CLAUDE_CODING_ENV : CLAUDE_SEAT_ENV),
        ...outputCap,
      },
      // The person's own Claude configuration is not the app's: a session
      // imports no settings source on any machine. Of the person's own
      // settings only the token command, address and gateway headers ride
      // the flag settings (`accessFlagSettings`), a company's usage
      // reporting setup is passed on by the app's receiver
      // (`claudeReporting.ts`), and an organization's
      // managed settings reach the client whatever this says. Nor is a
      // project's configuration the app's: its settings
      // file would bring its hooks, permission rules and environment, so a
      // coding session is handed its working copy's instructions and skills
      // instead (`claudeProjectResources.ts`).
      settingSources: [],
      // With the coding set, the client's own coding prompt with the role's
      // appended, then the working copy's instruction file. Without it, the
      // byte-stable prompt is the cached static prefix and the captain's own
      // instructions follow the boundary (docs/sequences.md).
      systemPrompt: coding
        ? {
            type: "preset",
            preset: "claude_code",
            append: [
              spec.instructions.base,
              ...(project?.instructions
                ? [claudeProjectInstructionsText(project.instructions)]
                : []),
              ...(project?.personalInstructions ? [project.personalInstructions] : []),
            ].join("\n\n"),
          }
        : [
            spec.instructions.base,
            SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
            ...(attachment.served ? [attachment.served] : []),
          ],
      // With the coding set, the client serves every one of its own tools
      // (none named is all of them). Without it, no built-in tool at all:
      // the session's whole surface is the spec's own typed tools
      // (docs/orchestrator-contract.md).
      // A fenced session gets only the client's reads, each confined to its
      // working copy by the fence hook (`claudeFenceHook`).
      ...(fenced ? { tools: [...CLAUDE_FENCED_TOOLS] } : coding ? {} : { tools: [] }),
      // The spec's tools, served always-load, when it has any; the seat's
      // whole band reaches it, since it has no tool to open a saved result.
      ...(spec.tools.length > 0
        ? {
            mcpServers: toolServer(
              spec.tools,
              coding ? undefined : CLAUDE_FIRSTMATE_TOOL_RESULT_CHARACTERS,
            ),
          }
        : {}),
      // Only the app's tool server: nothing of the person's mounts.
      strictMcpConfig: true,
      // The working copy's skills, listed as `project:<skill>`, and no hook
      // a skill declares: the app's session runs no project code of its own.
      ...(staged
        ? {
            plugins: [
              project?.skillsPlugin,
              project?.personalSkillsPlugin,
              ...(project?.pluginSkillsPlugins ?? []),
              project?.runbookSkillsPlugin,
            ].flatMap((path) => (path ? [{ type: "local" as const, path }] : [])),
          }
        : {}),
      // A coding session's commits and pull requests carry no attribution,
      // and with a skill staged no hook runs. The person's own token command
      // and address, when they set them up for Claude Code, ride along.
      settings: {
        ...input.access,
        ...claudeCompactionSettings(compactionNow(spec.compaction) ?? SESSION_COMPACTION),
        ...(coding ? CLAUDE_CODING_SETTINGS : {}),
        ...(staged ? { disableAllHooks: true } : {}),
      },
      // The app's tools are its own and typed, and a coding session works
      // alone in its own worktree - the isolation Pi's has (docs/architecture.md
      // section 4: social and a worktree, not a filesystem jail) - so there
      // is nothing to ask about.
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      // Set the coding level on the query itself: the per-turn update skips
      // it when the recorded effort already matches the requested level.
      ...(coding
        ? codingEffort
          ? { effort: codingEffort }
          : {}
        : level !== "off"
          ? { effort: level }
          : {}),
      ...(coding || thinks ? {} : { thinking: { type: "disabled" as const } }),
      ...(request?.maxModelTurns !== undefined ? { maxTurns: request.maxModelTurns } : {}),
      ...(attachment.model ? { model: attachment.model } : {}),
      ...sessionHooks(
        spec.tools,
        attachment.toolGate,
        fenced ? claudeFenceHook(spec.cwd) : undefined,
      ),
      ...("resume" in attachment.session
        ? { resume: attachment.session.resume }
        : { sessionId: attachment.session.sessionId }),
      ...(input.executable ? { pathToClaudeCodeExecutable: input.executable } : {}),
      stderr: input.stderr,
      // The client acknowledges each pushed message, by its uuid, as a turn
      // takes it in.
      extraArgs: { "replay-user-messages": null },
    };
  }
  return {
    cwd: spec.cwd,
    // The app spawns the client, so the session knows when it has exited.
    spawnClaudeCodeProcess: claudeClientSpawn({
      stderr: input.stderr,
      ...(input.exit ? { exit: input.exit } : {}),
    }),
    // The machine's default login and nothing ambient, none of the person's
    // Claude notes, plus the output bound.
    env: {
      ...claudeSessionEnv(input.env),
      ...CLAUDE_SESSION_ENV,
      // A one-shot without an explicit bound uses the client's allowance,
      // never an answer-only cap inherited from the shell (INF-1451).
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: undefined,
      ...outputCap,
    },
    settings: { ...input.access, ...CLAUDE_COMPACTION_SETTINGS },
    // The person's own Claude configuration is not the app's, but for the
    // token command, address and gateway headers above.
    settingSources: [],
    // The spec's instruction is the only system prompt the app supplies: no
    // preset (the client still adds its identity line).
    systemPrompt: spec.instructions.base,
    // No built-in tool: the model answers from what it was given, and can
    // reach only the spec's own tools, when it has any.
    tools: [],
    ...(spec.tools.length > 0
      ? {
          mcpServers: toolServer(spec.tools),
          permissionMode: "bypassPermissions" as const,
          allowDangerouslySkipPermissions: true,
        }
      : {}),
    ...sessionHooks(spec.tools),
    strictMcpConfig: true,
    ...(request?.maxModelTurns !== undefined ? { maxTurns: request.maxModelTurns } : {}),
    ...(level !== "off" ? { effort: level } : {}),
    // Request no extended thinking when an explicit cap leaves it no room.
    // Newer models may still think; the question preset supplies no cap.
    ...(thinks ? {} : { thinking: { type: "disabled" as const } }),
    // One bounded call leaves no transcript behind.
    persistSession: false,
    ...(spec.model ? { model: spec.model.id } : {}),
    ...(input.executable ? { pathToClaudeCodeExecutable: input.executable } : {}),
    stderr: input.stderr,
    // The request's typed stop rides its streamed `message_delta`: how an
    // answer the output cap cut short is known in time to stop the client's
    // own recovery from asking again.
    includePartialMessages: true,
  };
}
