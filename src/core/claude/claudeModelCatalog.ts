import { spawn } from "node:child_process";
import {
  type ModelInfo,
  type Options,
  type Query,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_CLIENT_MISSING_TEXT } from "@shared/claudeClient";
import { modelLine } from "@shared/modelListing";
import { atUtilityQos } from "../utilityQos";
import type { ClaudeAccessSettings } from "./claudeAccess";
import { claudeEnvFor, compareVersions, resolveClaudeExecutable } from "./claudeCli";
import { CLAUDE_MODELS } from "./claudeModels";

/**
 * Reading Claude's own catalog: the client's account-aware list
 * (`Query.supportedModels()`), for the machine's connected subscription -
 * a picker catalog, not exhaustive runnable-id proof on older clients.
 *
 * Two callers. The running app reads it in the background, under the store
 * lease, as the Claude account's runtime catalog read (docs/model-lists.md,
 * `src/core/models/clientLists.ts`); a failed read falls back to
 * CLAUDE_MODELS silently. And the live catalog check
 * (`claudeModelProbe.test.ts`, docs/claude-model-probe.md) holds
 * CLAUDE_MODELS and the starter map to the shared contract in
 * `src/core/models/catalogChecks.ts`: a dead or stale default fails, a
 * family's newest generation missing from the list fails, and older
 * generations the client re-lists are digest only.
 *
 * Reading the catalog costs nothing: the session is opened with an input
 * stream that never yields, so no turn is ever started, and it is closed as
 * soon as the list is in hand. It runs under the production credential
 * boundary - the installed executable (or INFINITARY_CLAUDE_CLI), the machine's
 * default login with CLAUDE_CONFIG_DIR unset, and no ambient key.
 */

/** The part of the client's `ModelInfo` this guard reads. */
export type ClaudeModelRow = {
  /** The id to pass as `model`; may be an alias ("sonnet", "opus[1m]"). */
  value: string;
  /** The canonical wire id that alias resolves to, when the client says. */
  resolvedModel?: string;
  /** The client's own label ("Opus 4.8"; "Default (recommended)" for the alias). */
  displayName?: string;
};

export type ClaudeCatalogQuery = Pick<Query, "supportedModels" | "close">;

export type ClaudeCatalogQueryFactory = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => ClaudeCatalogQuery;

/** Long enough for a cold start of a 300MB single-file client. */
export const CATALOG_TIMEOUT_MS = 90_000;

/**
 * A context-window variant marker: the client offers `claude-opus-5-5[1m]` for
 * the same model Infinitary routes to as `claude-opus-5-5`. It selects a window,
 * not a different model, so it is not drift.
 */
const CONTEXT_VARIANT = /\[[^\]]*\]$/;

/**
 * A dated snapshot: `claude-haiku-4-5-20251001` is today's build of the
 * family Infinitary names as `claude-haiku-4-5`. CLAUDE_MODELS deliberately
 * names families (the client resolves them to the current build), so a check
 * that demanded the date would fail on every point release - which is a
 * broken guard, not a caught drift.
 */
const DATED_SNAPSHOT = /-\d{8}$/;

/**
 * One catalog row as the runnable model id Infinitary would name. The client's
 * own `resolvedModel` is the authority where it is given ("sonnet" ->
 * "claude-sonnet-5"); a row that does not resolve is taken at its `value`,
 * which is the id the client would accept for it either way.
 */
export function canonicalClaudeModelId(row: ClaudeModelRow): string {
  const wire = row.resolvedModel?.trim() || row.value.trim();
  return wire.replace(CONTEXT_VARIANT, "").replace(DATED_SNAPSHOT, "");
}

/**
 * The distinct models a catalog offers, in the order the client listed them.
 * Several rows collapse onto one model - "default", "opus[1m]" and a bare
 * "opus" are all Opus - so aliases are deduplicated rather than counted.
 */
export function canonicalClaudeModelIds(rows: readonly ClaudeModelRow[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const row of rows) {
    const id = canonicalClaudeModelId(row);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** First client with native Haiku 5.5 catalog metadata; not the session floor. */
export const CLAUDE_HAIKU_CATALOG_VERSION = "2.1.293";

/**
 * An older client's successful picker can omit a runnable Haiku 5.5.
 * Treat that known-incomplete read like any unavailable catalog, never add
 * a made-up account row. A current client's omissions remain authoritative.
 */
export function claudeCatalogIsOutdated(
  rows: readonly ClaudeModelRow[],
  version: string | undefined,
): boolean {
  return (
    version !== undefined &&
    compareVersions(version, CLAUDE_HAIKU_CATALOG_VERSION) < 0 &&
    !canonicalClaudeModelIds(rows).includes("claude-haiku-5-5")
  );
}

/**
 * Whether the answer has the shape of the client's built-in picker: rows
 * that are all aliases, none naming a model by its own id. Claude Code
 * answers a session from that picker when the account's own list is not
 * ready, and its aliases can point at an older model than the account
 * serves. Such an answer is treated like an unavailable read. It catches
 * only that shape: a built-in answer the client adds an explicit id to
 * passes, and is named by version below. An empty answer is its own
 * failure, not this one.
 */
export function claudeCatalogIsBuiltInPicker(rows: readonly ClaudeModelRow[]): boolean {
  return rows.length > 0 && !rows.some(namesItsOwnId);
}

/** Whether a row's `value` is the model id itself, not an alias for it. */
function namesItsOwnId(row: ClaudeModelRow): boolean {
  const own = canonicalClaudeModelId({ value: row.value });
  return own !== "" && own === canonicalClaudeModelId(row);
}

/**
 * An alias row's label names the alias ("Fable"), not the model it points
 * at today. Where it leaves out that model's version, the name comes from
 * the id, so `fable` on claude-fable-5-1 reads "Claude Fable 5.1".
 */
function aliasName(id: string, label: string): string | undefined {
  const { line, version } = modelLine(id);
  const number = version.join(".");
  if (!number || label.includes(number)) return undefined;
  const family = (line.split("|")[0] ?? "")
    .replace(/^claude-?/, "")
    .split("-")
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
  return family ? `Claude ${family} ${number}` : undefined;
}

/**
 * The catalog as Infinitary's runtime read keeps it (docs/model-lists.md): one
 * row per distinct model, named as CLAUDE_MODELS names it where it does,
 * else by the client's own label - an alias row's label with the model's
 * version added where the label leaves it out.
 */
export function claudeServedModels(
  rows: readonly ClaudeModelRow[],
): { id: string; name: string }[] {
  const shipped = new Map(CLAUDE_MODELS.map((model) => [model.id, model.name]));
  const byId = new Map<string, string>();
  for (const row of rows) {
    const id = canonicalClaudeModelId(row);
    if (!id) continue;
    const label = row.value.trim() === "default" ? undefined : row.displayName?.trim();
    const name =
      shipped.get(id) ??
      (label && !namesItsOwnId(row) ? aliasName(id, label) : undefined) ??
      (label ? (/^claude\b/i.test(label) ? label : `Claude ${label}`) : undefined);
    if (!byId.has(id) || (name && byId.get(id) === id)) byId.set(id, name ?? id);
  }
  return [...byId.entries()].map(([id, name]) => ({ id, name }));
}

/**
 * An input stream that never yields a message, and ends the moment it is
 * released. It is what keeps this read free: a session opened over it can
 * answer control requests but has nothing to answer, so no turn starts and
 * no tokens are spent.
 */
function idleInput(): AsyncIterable<SDKUserMessage> & { end: () => void } {
  let finish: (() => void) | undefined;
  return {
    end: () => finish?.(),
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          finish = () => resolve({ value: undefined as never, done: true });
        }),
    }),
  };
}

/**
 * The models the connected subscription can actually run, as the client
 * itself reports them. Everything is released before this returns - the
 * session is closed on every path, including the timeout.
 */
export async function readClaudeModelCatalog(
  options: {
    cwd?: string;
    timeoutMs?: number;
    factory?: ClaudeCatalogQueryFactory;
    /** Run the client at utility QoS: the in-app read is background work. */
    utilityQos?: boolean;
    /** The person's own token command, address and gateway headers, as a session is handed them (`claudeAccess.ts`). */
    settings?: ClaudeAccessSettings;
    /** A further login's own Claude Code folder: the client is asked as that login. */
    ownConfigDir?: string;
  } = {},
): Promise<ClaudeModelRow[]> {
  const executable = resolveClaudeExecutable();
  const factory: ClaudeCatalogQueryFactory = options.factory ?? sdkQuery;
  if (!options.factory && !executable) {
    throw new Error(CLAUDE_CLIENT_MISSING_TEXT);
  }
  const input = idleInput();
  const query = factory({
    prompt: input,
    options: {
      cwd: options.cwd ?? process.cwd(),
      // The account's login, and nothing ambient - the same boundary a
      // crewmate session runs under (claudeCli.ts).
      env: claudeEnvFor(undefined, options.ownConfigDir),
      // The user's own machine-wide Claude configuration is theirs: the
      // catalog under test is the one a crewmate run would see.
      settingSources: [],
      ...(options.settings && Object.keys(options.settings).length > 0
        ? { settings: options.settings }
        : {}),
      // Only the app's own tool servers, here none: the person's
      // connectors, plugins and project `.mcp.json` never mount.
      strictMcpConfig: true,
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
      ...(options.utilityQos ? { spawnClaudeCodeProcess: spawnAtUtilityQos } : {}),
    },
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      query.supportedModels(),
      new Promise<ModelInfo[]>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Claude did not list its models in time.")),
          options.timeoutMs ?? CATALOG_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    input.end();
    query.close();
  }
}

/**
 * The SDK's spawn, at utility QoS (`atUtilityQos`, the same treatment git
 * and pnpm get): a background catalog read must never compete with the
 * character's frame. stderr is not read, so it is not piped.
 */
function spawnAtUtilityQos(options: SpawnOptions): SpawnedProcess {
  const command = atUtilityQos(options.command, options.args);
  return spawn(command.file, command.args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: options.env,
    signal: options.signal,
    stdio: ["pipe", "pipe", "ignore"],
  });
}
