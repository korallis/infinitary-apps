import { CLAUDE_CLIENT_MISSING_TEXT } from "@shared/claudeClient";
import { accessFlagSettings, readClaudeAccess } from "../claude/claudeAccess";
import { claudeClientVersion, resolveClaudeExecutable } from "../claude/claudeCli";
import {
  type ClaudeModelRow,
  claudeCatalogIsBuiltInPicker,
  claudeCatalogIsOutdated,
  claudeServedModels,
  readClaudeModelCatalog,
} from "../claude/claudeModelCatalog";
import { tryExclusiveStoreTask } from "../claude/claudeStoreLease";
import type { CatalogReader } from "./servedModels";

/**
 * The runtime read for the one subscription served by its own client
 * (docs/model-lists.md). It asks the client the account runs under - the
 * only authority on what that subscription serves on this machine - and
 * reports a failure as a failure, never as an empty catalog.
 *
 * Claude: the installed client's own account-aware catalog
 * (`supportedModels()`), asked as the account's own login - a further
 * login in its folder, without the person's gateway settings, which are the
 * default login's - and read under that login's store lease as a one-shot that
 * DEFERS while a crewmate session holds the store - the same courtesy the
 * idle rejection request pays (claudeAuth.ts). A deferred read keeps what is in hand
 * and is retried on the next pass.
 */
export function claudeListReader(options: {
  configDir: () => string;
  /** A further login's own Claude Code folder, by account; nothing for the default login. */
  ownConfigDir?: (accountId: string) => string | undefined;
  read?: (ownConfigDir?: string) => Promise<ClaudeModelRow[]>;
  clientVersion?: () => Promise<string | undefined>;
}): CatalogReader {
  const read =
    options.read ??
    (async (ownConfigDir?: string) =>
      readClaudeModelCatalog({
        utilityQos: true,
        ...(ownConfigDir
          ? { ownConfigDir }
          : { settings: accessFlagSettings(await readClaudeAccess()) }),
      }));
  const version =
    options.clientVersion ??
    (async () => {
      const executable = resolveClaudeExecutable();
      return executable ? claudeClientVersion(executable) : undefined;
    });
  return async (account) => {
    const own = options.ownConfigDir?.(account.accountId);
    const claimed = await tryExclusiveStoreTask(
      own ?? options.configDir(),
      async (): Promise<
        { ok: true; rows: ClaudeModelRow[]; version?: string } | { ok: false; error: string }
      > => {
        try {
          return { ok: true, rows: await read(own), version: await version() };
        } catch (caught) {
          return { ok: false, error: caught instanceof Error ? caught.message : String(caught) };
        }
      },
    );
    if (!claimed.ran) return { status: "deferred" };
    const outcome = claimed.value;
    if (!outcome.ok) {
      if (outcome.error === CLAUDE_CLIENT_MISSING_TEXT)
        return { status: "failed", reason: "no_client" };
      if (/in time/i.test(outcome.error)) return { status: "failed", reason: "timeout" };
      return { status: "failed", reason: "error", detail: outcome.error };
    }
    if (claudeCatalogIsOutdated(outcome.rows, outcome.version)) {
      return {
        status: "failed",
        reason: "unrecognised",
        detail: "client catalog predates Haiku 5.5",
      };
    }
    if (claudeCatalogIsBuiltInPicker(outcome.rows)) {
      return {
        status: "failed",
        reason: "unrecognised",
        detail: "client answered with aliases only, the shape of its built-in picker",
      };
    }
    return { status: "ok", models: claudeServedModels(outcome.rows) };
  };
}
