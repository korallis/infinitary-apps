import { type AccountView, standingCutOff } from "@shared/accounts";
import { isCustomApiProvider } from "@shared/customApi";
import type { ReasoningCapabilities } from "@shared/modelSlots";
import { rowMeasuresModel, servedModelKey } from "@shared/quota";
import { allowanceSpent } from "@shared/quotaSignals";
import { type ComputerSignIns, type DeviceSignIns, signInPlace } from "@shared/signIns";
import { type QuotaCatalogModel, quotaRowProviderOf } from "../quota/auth";
import { buildModelsCatalog, effectiveFromProvider } from "../quota/catalog";
import type { RoutingPool } from "./router";

/**
 * What a computer that runs work can serve a task, from what it last said
 * of its own sign-ins (docs/helper.md, "Its own sign-ins"): the routing pool
 * a task that runs there is routed among, and the account there that serves
 * each provider. Nothing of this Mac's sign-ins enters it.
 */
export type ComputerPool = RoutingPool & {
  /** The account there that serves each provider, by provider id: its pin, else the first. */
  accounts: ReadonlyMap<string, string>;
  /**
   * The account there that serves each model, by provider/id: its pin, else
   * the first that lists it. Absent for a computer too old to list what it serves.
   */
  modelAccounts?: ReadonlyMap<string, string>;
  /**
   * Every account there that serves each model, by provider/id: each one
   * that lists it. Absent for a computer too old to list what it serves.
   */
  servedBy?: ReadonlyMap<string, ReadonlySet<string>>;
};

/**
 * Whether an account a computer bound serves the model there now: one that
 * lists it, or, from a computer too old to list what it serves, the
 * account there that serves its provider, and whose own allowance there,
 * as that computer measured it, is not spent. No account serves nothing.
 */
export function servesOnComputer(
  pool: ComputerPool,
  account: string | undefined,
  model: { provider: string; id: string },
  nowMs: number,
): boolean {
  if (account === undefined) return false;
  const listed = pool.servedBy
    ? pool.servedBy.get(`${model.provider}/${model.id}`)?.has(account) === true
    : pool.accounts.get(model.provider) === account;
  if (!listed) return false;
  const quotaId = quotaRowProviderOf(model.provider);
  const reading = pool.readings?.find(
    (row) =>
      row.accountId === account && row.provider === quotaId && rowMeasuresModel(row, model.id),
  );
  return !allowanceSpent(effectiveFromProvider(reading, nowMs, model.id));
}

/**
 * The pool with each model it lists ranked on the account there that would
 * serve it now: its pin, else the first that lists it, passing over one
 * whose own allowance there is spent (`servesOnComputer`) or that `passing`
 * names for that model. A model no account there serves now keeps no
 * account of its own, so its provider's account ranks it. A computer too
 * old to list what it serves is read as it is.
 */
export function servingNow(
  pool: ComputerPool,
  nowMs: number,
  passing: (key: string, account: string) => boolean,
): ComputerPool {
  const { servedBy, modelAccounts } = pool;
  if (!servedBy || !modelAccounts) return pool;
  const ranked = new Map<string, string>();
  for (const [key, accounts] of servedBy) {
    const slash = key.indexOf("/");
    const model = { provider: key.slice(0, slash), id: key.slice(slash + 1) };
    const pinned = modelAccounts.get(key);
    const account = [...(pinned !== undefined ? [pinned] : []), ...accounts].find(
      (each) => !passing(key, each) && servesOnComputer(pool, each, model, nowMs),
    );
    if (account !== undefined) ranked.set(key, account);
  }
  return { ...pool, modelAccounts: ranked };
}

/**
 * Whether an account a computer listed can serve a task there: enabled,
 * signed in, needing no new sign-in, and withheld by nothing there (no
 * Claude Code, one too old, or a typed cut-off standing on it - a lost
 * sign-in, a refusal, or a spent allowance until its reset). A cut-off is
 * skipped as this Mac skips its own (docs/quota.md, "The cut-off on the
 * account"), so a task goes to another sign-in there, or waits for this one.
 */
function servesThere(account: AccountView, nowMs: number): boolean {
  return !withheldThere(account) && standingCutOff(account, nowMs) === undefined;
}

/** Whether an account a computer listed serves nothing for a reason other than a cut-off. */
function withheldThere(account: AccountView): boolean {
  return !(
    account.enabled &&
    account.connected &&
    account.needsReauth !== true &&
    account.detail === undefined
  );
}

/**
 * The account a cut-off alone keeps from serving a task there, when nothing
 * else there serves: a task for that computer waits for it, as a task on a
 * cut-off account here does, rather than failing to start. Undefined when
 * something there serves, or nothing would serve even without a cut-off.
 */
export function heldThere(
  signIns: ComputerSignIns | null | undefined,
  nowMs: number,
): AccountView | undefined {
  const accounts = signIns?.accounts ?? [];
  if (accounts.some((account) => servesThere(account, nowMs))) return undefined;
  return accounts.find(
    (account) => !withheldThere(account) && standingCutOff(account, nowMs) !== undefined,
  );
}

/**
 * The pool, built from the computer's word and this Mac's provider-wide
 * catalog (`models`, which needs no sign-in to list): every catalog model
 * of a provider the computer holds an account that serves, with that
 * computer's own reading of the allowance, so a spent subscription there is
 * skipped and one with allowance to spare there is spent first. A computer
 * that has said nothing serves nothing.
 */
/**
 * Models a computer serves that this Mac's board should list, tagged with
 * that computer: its checked custom models, and models of a provider this
 * Mac's catalog does not list. Slot keys stay provider/id, so a custom id
 * minted there never collides with one minted here.
 */
export function computerBoardModels(
  devices: readonly DeviceSignIns[],
  catalogProviders: ReadonlySet<string>,
): {
  accountId: string;
  accountLabel: string;
  providerId: string;
  place: string;
  models: {
    provider: string;
    id: string;
    name?: string;
    reasoningCapabilities?: ReasoningCapabilities;
  }[];
}[] {
  const rows: {
    accountId: string;
    accountLabel: string;
    providerId: string;
    place: string;
    models: {
      provider: string;
      id: string;
      name?: string;
      reasoningCapabilities?: ReasoningCapabilities;
    }[];
  }[] = [];
  for (const device of devices) {
    const signIns = device.signIns;
    if (!signIns) continue;
    const place = signInPlace(device).who;
    for (const view of signIns.custom ?? []) {
      const account = signIns.accounts.find((row) => row.id === view.accountId);
      if (!account || !view.enabled || !isCustomApiProvider(account.providerId)) continue;
      const models = view.models
        .filter((model) => model.checked)
        .map((model) => ({
          provider: account.providerId,
          id: model.id,
          reasoningCapabilities: signIns.served
            ?.find((row) => row.accountId === account.id)
            ?.models.find((row) => row.provider === account.providerId && row.id === model.id)
            ?.reasoningCapabilities,
        }));
      if (models.length === 0) continue;
      rows.push({
        accountId: `${device.deviceId}:${account.id}`,
        accountLabel: view.label,
        providerId: account.providerId,
        place,
        models,
      });
    }
    for (const served of signIns.served ?? []) {
      const account = signIns.accounts.find((row) => row.id === served.accountId);
      if (!account || isCustomApiProvider(account.providerId)) continue;
      const models = served.models
        .filter((model) => !catalogProviders.has(model.provider))
        .map((model) => {
          const { speeds, speedsUntil, ...rest } = model;
          return {
            ...rest,
            ...(speeds && speedsUntil !== undefined && speedsUntil > Date.now() ? { speeds } : {}),
          };
        });
      if (models.length === 0) continue;
      rows.push({
        accountId: `${device.deviceId}:${account.id}`,
        accountLabel: account.label,
        providerId: account.providerId,
        place,
        models,
      });
    }
  }
  return rows;
}

export function computerPool(
  who: string,
  signIns: ComputerSignIns | null | undefined,
  models: readonly QuotaCatalogModel[],
  nowMs: number,
): ComputerPool {
  const accounts = new Map<string, string>();
  const serving = signIns?.accounts.filter((account) => servesThere(account, nowMs)) ?? [];
  for (const account of [...serving].sort((a, b) => Number(b.pinned) - Number(a.pinned)))
    if (!accounts.has(account.providerId)) accounts.set(account.providerId, account.id);
  const catalogProviders = new Set(models.map((model) => model.provider));
  const extra: QuotaCatalogModel[] = [];
  const seen = new Set(
    models
      .filter((model) => accounts.has(model.provider))
      .map((model) => `${model.provider}/${model.id}`),
  );
  const add = (provider: string, id: string, name = id) => {
    const key = `${provider}/${id}`;
    if (seen.has(key) || !accounts.has(provider)) return;
    seen.add(key);
    extra.push({ provider, id, name });
  };
  // Checked custom models are this computer's own. The home catalog lists none.
  for (const view of signIns?.custom ?? []) {
    const account = signIns?.accounts.find((row) => row.id === view.accountId);
    if (!account || !servesThere(account, nowMs) || !view.enabled) continue;
    if (!isCustomApiProvider(account.providerId)) continue;
    for (const model of view.models) if (model.checked) add(account.providerId, model.id);
  }
  // A provider this Mac's catalog lacks (OpenRouter) takes the computer's own list.
  for (const row of signIns?.served ?? []) {
    const account = signIns?.accounts.find((entry) => entry.id === row.accountId);
    if (!account || !servesThere(account, nowMs)) continue;
    for (const model of row.models) {
      if (catalogProviders.has(model.provider) || isCustomApiProvider(model.provider)) continue;
      add(model.provider, model.id, model.name ?? model.id);
    }
  }
  const offered = [...models.filter((model) => accounts.has(model.provider)), ...extra];
  const quota = signIns?.quota;
  const catalog = buildModelsCatalog(
    offered,
    quota?.providers ?? [],
    quota?.generatedAt ?? new Date(nowMs).toISOString(),
    nowMs,
  ).models;
  const providers = [...accounts.keys()];
  const count = `${offered.length} ${offered.length === 1 ? "model" : "models"}`;
  return {
    available: offered.map((model) => ({ provider: model.provider, id: model.id })),
    catalog,
    readings: quota?.providers,
    accounts,
    place: who,
    note: `${who}'s own sign-ins (${providers.length > 0 ? providers.join(", ") : "none"}): ${count}`,
    unowned: extra
      .filter((model) => !isCustomApiProvider(model.provider))
      .map(({ provider, id }) => ({ provider, id })),
  };
}

/**
 * What a computer says each account serves, with this Mac's catalog for the
 * provider of an account that lists no models: one on protocol 2.6.0
 * through 8.1.0 lists none for its Claude account, so a task set to run
 * there takes that provider's catalog for it, as it did before it routed
 * among the computer's own lists. Automatic placement never fills one in.
 */
export function catalogWhereUnlisted(
  signIns: ComputerSignIns | null,
  models: readonly QuotaCatalogModel[],
): ComputerSignIns | null {
  if (!signIns?.served?.some((row) => row.models.length === 0)) return signIns;
  return {
    ...signIns,
    served: signIns.served.map((row) => {
      if (row.models.length > 0) return row;
      const providerId = signIns.accounts.find(
        (account) => account.id === row.accountId,
      )?.providerId;
      return { ...row, models: models.filter((model) => model.provider === providerId) };
    }),
  };
}

/** Automatic placement never expands a sign-in into the home's provider catalog. */
export function actualComputerPool(
  who: string,
  signIns: ComputerSignIns | null,
  models: readonly QuotaCatalogModel[],
  nowMs: number,
):
  | (ComputerPool & {
      modelAccounts: ReadonlyMap<string, string>;
      servedBy: ReadonlyMap<string, ReadonlySet<string>>;
    })
  | null {
  if (!signIns?.served) return null;
  const serving = new Set(
    signIns.accounts.filter((account) => servesThere(account, nowMs)).map((account) => account.id),
  );
  const actual = new Map(
    signIns.served
      .filter((row) => serving.has(row.accountId))
      .flatMap((row) =>
        row.models.map((model) => [`${model.provider}/${model.id}`, model] as const),
      ),
  );
  const described = models.filter((model) => actual.has(`${model.provider}/${model.id}`));
  const modelAccounts = new Map<string, string>();
  const servedBy = new Map<string, Set<string>>();
  for (const account of [...signIns.accounts]
    .filter((row) => serving.has(row.id))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned)))
    for (const model of signIns.served.find((row) => row.accountId === account.id)?.models ?? []) {
      const key = `${model.provider}/${model.id}`;
      if (!modelAccounts.has(key)) modelAccounts.set(key, account.id);
      servedBy.set(key, (servedBy.get(key) ?? new Set()).add(account.id));
    }
  // computerPool's catalog expansion is safe with exactly this computer's identities.
  const pool = computerPool(who, signIns, described, nowMs);
  return {
    ...pool,
    modelAccounts,
    servedBy,
    available: pool.available.filter((model) => actual.has(`${model.provider}/${model.id}`)),
    // The catalog names a provider by its allowance id (claude, codex, grok), as routing reads it.
    catalog: pool.catalog.filter((model) => actual.has(servedModelKey(model))),
  };
}
