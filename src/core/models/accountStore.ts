import { settingFrom } from "@shared/envSettings";
import { backendForProvider, CLAUDE_PROVIDER_ID } from "@shared/providers";
import { claudeAvailableModels } from "../claude/claudeModels";
import type { AppPaths } from "../paths";
import { AccountVault, type AccountVaultOptions } from "../pi/accountVault";
import type { QuotaHttp } from "../quota/http";
import { markFurtherLoginsFormat } from "../storage/savedDataCompatibility";
import { markKeptCopyFurtherLogins } from "../storage/sourceRunCopy";
import { claudeListReader } from "./clientLists";
import { codexListReader, grokListReader, railVerdict } from "./piAccountLists";
import { type CatalogAccount, type ServedModel, ServedModels } from "./servedModels";

/**
 * One computer's account store and the model lists its accounts serve
 * (docs/model-lists.md, "Where "served" comes from"). This Mac and every
 * computer that runs work build theirs here, so an account lists the same
 * models wherever it is signed in: a Claude account its client's own list,
 * else the shipped one, and a Codex or Grok account Pi's catalog narrowed by
 * the account's own list behind the safety rail, judged where the models
 * the captain kept are (`rail`). When each list is read stays the caller's.
 */
export type AccountStoreOptions = Omit<
  AccountVaultOptions,
  "modelsForAccount" | "piModelFilter"
> & {
  /** Whether it runs from a packaged app; the dev and test list addresses are read only off one. */
  packaged: boolean;
  /** Where Claude's client keeps this login: its list is read only while no session holds it. */
  claudeConfigDir: () => string;
  /** Stands in for Claude's client and its version, for tests; production asks the installed one. */
  claudeList?: Pick<Parameters<typeof claudeListReader>[0], "read" | "clientVersion">;
  /** The Codex and Grok list requests; the providers' own transport unless a test stands in its own. */
  http?: QuotaHttp;
  /**
   * Where a Codex or Grok account's own list is judged by the safety rail
   * (`railVerdict`), which needs the models the captain kept. This Mac holds
   * that record, so it narrows its accounts here, given the ids of one
   * provider a read may never be trusted to take away. A computer that runs
   * work holds none, so with `"home"` it narrows nothing and reports each
   * list beside Pi's catalog for its home to judge (`narrowServedThere`).
   */
  rail: { protectedIds: (providerId: string) => readonly string[] } | "home";
  /** After every settled read, so the lists and the news can follow it. */
  onSettled?: (account: CatalogAccount) => void;
  /** A failed read, once per account until its reason changes. */
  log?: (line: string) => void;
  /** A successful read, once per account until what it served changes. */
  info?: (line: string) => void;
};

export type AccountStore = { vault: AccountVault; served: ServedModels };

export function createAccountStore(
  paths: Pick<AppPaths, "accountsDir"> & Partial<Pick<AppPaths, "userData">>,
  options: AccountStoreOptions,
): AccountStore {
  const {
    packaged,
    claudeConfigDir,
    claudeList,
    http,
    rail,
    onSettled,
    log,
    info,
    ...vaultOptions
  } = options;
  // Until an account's read succeeds - and whenever one fails - its models
  // are the shipped catalog. Either way each keeps its name, so the Models
  // board names it before the first allowance read builds the catalog.
  let served: ServedModels | undefined;
  // A folder that holds a further Claude login is marked so a build from
  // before them refuses it, and unmarked once the last one is removed; the
  // copy a run from source keeps is marked with it, so copying that back
  // never opens the folder to such a build past a login still held
  // (docs/saved-data-compatibility.md, "Further Claude logins").
  const { userData } = paths;
  const furtherLoginsHeld = userData
    ? (held: boolean) => {
        markFurtherLoginsFormat(userData, held);
        markKeptCopyFurtherLogins(userData, held);
      }
    : undefined;
  const vault = AccountVault.create(paths, {
    ...vaultOptions,
    ...(furtherLoginsHeld ? { furtherLoginsHeld } : {}),
    modelsForAccount: ({ accountId, providerId }) => {
      const read = served?.read(accountId);
      if (read)
        return read.models.map((model) => ({
          provider: providerId,
          id: model.id,
          ...(model.name ? { name: model.name } : {}),
        }));
      if (providerId === CLAUDE_PROVIDER_ID) return claudeAvailableModels();
      return [];
    },
    ...(rail === "home"
      ? {}
      : {
          piModelFilter: (accountId: string) => {
            const read = served?.read(accountId);
            return read ? new Set(read.models.map((model) => model.id)) : undefined;
          },
        }),
  });
  // The Pi filters honour Pi's own offline switch (e2e sets it) and take
  // a dev/e2e endpoint the way the quota meters do; a packaged app never
  // reads the override.
  const offline = process.env.PI_OFFLINE !== undefined;
  const devEndpoint = (name: string): { url?: string } => {
    const value = packaged ? undefined : settingFrom(process.env, name)?.trim();
    return value ? { url: value } : {};
  };
  const resolveAuth = (id: string) => vault.resolveForQuota(id);
  served = new ServedModels({
    readers: {
      [CLAUDE_PROVIDER_ID]: claudeListReader({
        configDir: claudeConfigDir,
        ownConfigDir: (accountId) => vault.claudeConfigDir(accountId),
        ...claudeList,
      }),
      "openai-codex": codexListReader({
        resolveAuth,
        http,
        offline,
        ...devEndpoint("CODEX_MODELS_URL"),
      }),
      xai: grokListReader({ resolveAuth, http, offline, ...devEndpoint("GROK_MODELS_URL") }),
    },
    accounts: () =>
      vault
        .list()
        .filter((account) => account.enabled)
        .map((account) => ({ accountId: account.id, providerId: account.providerId })),
    // The Pi filters' safety rail (captain's decision A): an answer that
    // leaves out a starter or kept id Pi can serve is not trusted to remove
    // it - it is an unrecognised answer, so no filter at all.
    ...(rail === "home"
      ? {}
      : {
          accept: (account: CatalogAccount, models: readonly ServedModel[]) =>
            backendForProvider(account.providerId) !== "pi"
              ? { ok: true as const }
              : railVerdict({
                  answer: models,
                  protectedIds: rail.protectedIds(account.providerId),
                  piIds: vault.piCatalogIds(account.accountId),
                }),
        }),
    ...(onSettled ? { onSettled } : {}),
    ...(log ? { log } : {}),
    ...(info ? { info } : {}),
    ...(vaultOptions.now ? { now: vaultOptions.now } : {}),
  });
  return { vault, served };
}
