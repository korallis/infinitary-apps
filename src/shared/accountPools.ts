import {
  formatResetText,
  POOL_QUOTA_PROVIDER,
  QUOTA_POOL_KINDS,
  QUOTA_POOL_NAMES,
  type QuotaProviderView,
} from "./quota";
import { classifyProviderWindows, type PoolLogin, poolReading } from "./quotaSignals";

/** One of the person's own logins a pool may fold: an enabled account and its quota provider. */
export type PoolMember = { accountId: string; provider: string };

/**
 * One own login as the pool weighs it, from its account row. A row that is
 * missing, stale or not a reading is unread, never zero; a sign-in that
 * ended cannot serve; a reading with an account-wide window used up is
 * spent until every such window has reset - the last of them, since one
 * that resets earlier leaves the login blocked by the other - and serves
 * again from then.
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
  const { combined, bounding } = classifyProviderWindows(row.provider, row.windows);
  const blocking = combined
    ? bounding.filter(
        (window) =>
          typeof window.percentRemaining === "number" &&
          window.percentRemaining <= 0 &&
          (window.resetsAtMs === undefined || window.resetsAtMs > nowMs),
      )
    : [];
  if (blocking.length === 0) return { state: "serving", windows };
  const resets = blocking.map((window) => window.resetsAtMs);
  const backAtMs = resets.every((at) => at !== undefined) ? Math.max(...resets) : undefined;
  return { state: "spent", windows, ...(backAtMs !== undefined ? { backAtMs } : {}) };
}

/**
 * The person's own logins as one pool per provider (docs/quota.md, "A pool
 * of your own logins"): for Claude and for ChatGPT, when two or more of
 * `members` are logins of it, one row whose windows are `poolReading`'s
 * over those logins' account rows as read at `nowMs`. A login a CLI proxy
 * answers for is that proxy's pool already and is no member. The row names
 * no account: each login keeps its own row, and the pool is a reading of
 * them, never an allowance of its own. `nowMs` is when the rows were read
 * (the snapshot's own time), not when the pool is looked at: a login's row
 * keeps what it read until the next reading, and the pool agrees with it.
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

/** The snapshot's pool of the person's own logins of `provider`, when it has one. */
export function accountsPoolOf(
  pools: readonly QuotaProviderView[] | undefined,
  provider: string,
): QuotaProviderView | undefined {
  return pools?.find((row) => row.provider === provider && row.pool?.source === "accounts");
}
