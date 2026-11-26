import {
  formatResetText,
  POOL_QUOTA_PROVIDER,
  QUOTA_POOL_KINDS,
  QUOTA_POOL_NAMES,
  type QuotaProviderView,
} from "./quota";
import { type PoolLogin, poolReading, providerScopes } from "./quotaSignals";

/** One of the person's own logins a pool may fold: an enabled account and its quota provider. */
export type PoolMember = { accountId: string; provider: string };

/**
 * One own login as the pool weighs it, from its account row. A row that is
 * missing, stale or not a reading is unread, never zero; a sign-in that
 * ended cannot serve; a reading whose every-model allowance is used up is
 * spent until the window holding it resets, and serves again from then.
 */
function loginOfRow(row: QuotaProviderView | undefined, nowMs: number): PoolLogin {
  if (row?.status === "auth_required") return { state: "sign_in_ended" };
  if (row?.status !== "ok" || row.stale) return { state: "serving" };
  const windows = row.windows.flatMap((window) =>
    typeof window.percentRemaining === "number"
      ? [
          {
            id: window.id,
            label: window.label,
            percentRemaining: window.percentRemaining,
            ...(window.resetsAtMs !== undefined ? { resetsAtMs: window.resetsAtMs } : {}),
          },
        ]
      : [],
  );
  if (windows.length === 0) return { state: "serving" };
  const all = providerScopes(row, nowMs).allModels;
  if (all?.effectivePercentRemaining !== undefined && all.effectivePercentRemaining <= 0) {
    const backAtMs = row.windows.find((window) => window.id === all.limitingWindowId)?.resetsAtMs;
    if (backAtMs === undefined || backAtMs > nowMs)
      return { state: "spent", windows, ...(backAtMs !== undefined ? { backAtMs } : {}) };
  }
  return { state: "serving", windows };
}

/**
 * The person's own logins as one pool per provider (docs/quota.md, "A pool
 * of your own logins"): for Claude and for ChatGPT, when two or more of
 * `members` are logins of it, one row whose windows are `poolReading`'s
 * over those logins' account rows as read at `nowMs`. A login a CLI proxy
 * answers for is that proxy's pool already and is no member. The row names
 * no account: each login keeps its own row, and the pool is a reading of
 * them, never an allowance of its own.
 */
export function accountPools(
  providers: readonly QuotaProviderView[],
  members: readonly PoolMember[],
  nowMs: number,
): QuotaProviderView[] {
  const pools: QuotaProviderView[] = [];
  for (const kind of QUOTA_POOL_KINDS) {
    const provider = POOL_QUOTA_PROVIDER[kind];
    const rowOf = (accountId: string) =>
      providers.find((row) => row.provider === provider && row.accountId === accountId);
    const ids = [
      ...new Set(
        members.filter((member) => member.provider === provider).map((member) => member.accountId),
      ),
    ].filter((accountId) => {
      const row = rowOf(accountId);
      return !row?.pool && !row?.fromProxy;
    });
    if (ids.length < 2) continue;
    const rows = ids.map(rowOf);
    const logins = rows.map((row) => loginOfRow(row, nowMs));
    const fallback = logins.find((login) => login.state === "spent")?.windows?.[0];
    const pooled = poolReading(kind, logins, nowMs, {
      id: fallback?.id ?? "weekly",
      label: fallback?.label ?? "weekly",
    });
    const measured = rows.flatMap((row) =>
      row?.status === "ok" && !row.stale && row.measuredAt !== undefined ? [row.measuredAt] : [],
    );
    pools.push({
      provider,
      label: QUOTA_POOL_NAMES[kind],
      status: "ok",
      stale: false,
      ...(measured.length > 0 ? { measuredAt: Math.min(...measured) } : {}),
      windows: pooled.windows.map((window) => {
        const resetText =
          window.resetsAtMs !== undefined ? formatResetText(window.resetsAtMs, nowMs) : undefined;
        return resetText ? { ...window, resetText } : window;
      }),
      pool: { ...pooled.pool, source: "accounts", accounts: ids },
    });
  }
  return pools;
}

/**
 * The pool of the person's own logins of `provider` as it stands at `nowMs`:
 * the snapshot's pool names the logins, and their rows are folded again, so
 * a reset that passed since the snapshot was made counts with no new reading.
 */
export function accountsPoolAt(
  pools: readonly QuotaProviderView[] | undefined,
  providers: readonly QuotaProviderView[],
  provider: string,
  nowMs: number,
): QuotaProviderView | undefined {
  const saved = pools?.find((row) => row.provider === provider && row.pool?.source === "accounts");
  if (!saved?.pool?.accounts) return undefined;
  return accountPools(
    providers,
    saved.pool.accounts.map((accountId) => ({ accountId, provider })),
    nowMs,
  )[0];
}
