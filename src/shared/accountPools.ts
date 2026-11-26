import {
  formatResetText,
  inAccountsPool,
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
 * again from then, or from the end of its provider's refusal of it
 * (`refusedUntilMs`) when that is later.
 */
function loginOfRow(
  row: QuotaProviderView | undefined,
  nowMs: number,
  refusedUntilMs = 0,
): PoolLogin {
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
          (window.resetsAtMs === undefined || Math.max(window.resetsAtMs, refusedUntilMs) > nowMs),
      )
    : [];
  if (blocking.length === 0) return { state: "serving", windows };
  const resets = blocking.map((window) => window.resetsAtMs);
  const backAtMs = resets.every((at) => at !== undefined)
    ? Math.max(...resets, refusedUntilMs)
    : undefined;
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
 * (the snapshot's own time), not when the pool is looked at: the pool
 * agrees with the rows it is given, and a reset that passes between
 * readings reaches it through those rows (`settlePoolResets`). With
 * `refusedUntilMs`, a spent login its provider refused until later is back
 * at that time, as `settlePoolResets` holds it, so the pool names the same
 * return as the wait for it.
 */
export function accountPools(
  providers: readonly QuotaProviderView[],
  members: readonly PoolMember[],
  nowMs: number,
  refusedUntilMs?: (accountId: string) => number | undefined,
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
    const logins = ids.map((accountId) =>
      loginOfRow(rowOf(accountId), nowMs, refusedUntilMs?.(accountId) ?? 0),
    );
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
 * A refused login's row with the refusal laid over it, as a session's
 * refusal is laid over a meter (`withRejectedReadings`): the provider said
 * no after the sensor read, or where it could not read. The refusal is the
 * whole account's, so every window that bounds a scope reads used up until
 * `refusedUntilMs`: one with room left, one read without a share, and a
 * model's own. A bound left unread would make that scope's allowance
 * unknown, and unknown may be tried. A window already used up keeps its
 * own reset, which `settlePoolResets` holds until the refusal ends, and
 * credits past the allowance bound nothing and stay as read. A row that is
 * no current reading is known only through the refusal, so it carries one
 * used-up account-wide window. The row names the refusal's end itself
 * (`refusedUntilMs`), since windows already used up keep earlier resets.
 * A sign-in that ended is left as it stands.
 */
function withRefusal(
  row: QuotaProviderView,
  refusedUntilMs: number,
  nowMs: number,
): QuotaProviderView {
  if (row.status === "auth_required") return row;
  const resetText = formatResetText(refusedUntilMs, nowMs);
  const usedUp = (id: string, label: string) => ({
    id,
    label,
    percentRemaining: 0,
    resetsAtMs: refusedUntilMs,
    ...(resetText ? { resetText } : {}),
  });
  const current = row.status === "ok" && !row.stale;
  const read = current ? row.windows : [];
  const { excluded } = classifyProviderWindows(row.provider, read);
  const windows = read.map((window) =>
    excluded.includes(window) ||
    (typeof window.percentRemaining === "number" && window.percentRemaining <= 0)
      ? window
      : usedUp(window.id, window.label),
  );
  if (classifyProviderWindows(row.provider, windows).bounding.length === 0)
    windows.push(usedUp("weekly", "weekly"));
  if (current) return { ...row, refusedUntilMs, windows };
  const { reason: _reason, detail: _detail, retryAfter: _retryAfter, ...rest } = row;
  return { ...rest, status: "ok", stale: false, refusedUntilMs, windows };
}

/**
 * The rows of pooled logins as they stand at `nowMs`, with no new reading
 * (docs/quota.md, "A pool of your own logins"): a used-up window whose own
 * reset has passed is no longer what the login has, so it leaves the row,
 * and every reader of the row, the pool and the catalog then agrees the
 * login serves again once its last such window is gone. Its other windows
 * keep what they read. A login its provider refused until a later time
 * (`refusedUntilMs`) keeps its used-up windows until then: a window's reset
 * frees nothing while the refusal stands. And the refusal itself is on
 * that login's row until it ends (`withRefusal`), a row with room left, a
 * row that could not be read and a login with no row at all included, so
 * no reader counts a refused login as usable or unknown. `nextAtMs` is the
 * next time a pooled login's row changes in one of these ways.
 * Rows of a provider with no pool in `pools` are left as read, and the rows
 * given are never changed: they stay the measurement.
 */
export function settlePoolResets(
  providers: readonly QuotaProviderView[],
  pools: readonly QuotaProviderView[],
  nowMs: number,
  refusedUntilMs?: (accountId: string) => number | undefined,
): { providers: QuotaProviderView[]; changed: boolean; nextAtMs?: number } {
  const resetOfUsedUp = (window: QuotaProviderView["windows"][number]) =>
    typeof window.percentRemaining === "number" && window.percentRemaining <= 0
      ? window.resetsAtMs
      : undefined;
  let changed = false;
  let nextAtMs: number | undefined;
  const changesAt = (atMs: number) => {
    if (nextAtMs === undefined || atMs < nextAtMs) nextAtMs = atMs;
  };
  const refusedUntilOf = (accountId: string | undefined) => {
    const untilMs = (accountId && refusedUntilMs?.(accountId)) || 0;
    return untilMs > nowMs ? untilMs : 0;
  };
  // A refused login with no row at all is served one that says so.
  const unread: QuotaProviderView[] = [];
  for (const pool of pools) {
    if (pool.pool?.source !== "accounts") continue;
    for (const accountId of pool.pool.accounts ?? []) {
      const untilMs = refusedUntilOf(accountId);
      if (!untilMs) continue;
      changesAt(untilMs);
      const rows = providers.filter((row) => row.provider === pool.provider && !row.pool);
      if (rows.some((row) => row.accountId === accountId)) continue;
      const blank: QuotaProviderView = {
        provider: pool.provider,
        label: rows[0]?.label ?? pool.label,
        accountId,
        status: "not_measured",
        stale: false,
        windows: [],
      };
      unread.push(withRefusal(blank, untilMs, nowMs));
    }
  }
  const settled = providers.map((row) => {
    if (row.pool || !inAccountsPool(accountsPoolOf(pools, row.provider), row.accountId)) return row;
    const refusedUntil = refusedUntilOf(row.accountId);
    const kept = row.windows.filter((window) => {
      const resetsAtMs = resetOfUsedUp(window);
      if (resetsAtMs === undefined) return true;
      const leavesAtMs = Math.max(resetsAtMs, refusedUntil);
      if (leavesAtMs <= nowMs) return false;
      changesAt(leavesAtMs);
      return true;
    });
    const standing = kept.length === row.windows.length ? row : { ...row, windows: kept };
    const served = refusedUntil ? withRefusal(standing, refusedUntil, nowMs) : standing;
    if (served !== row) changed = true;
    return served;
  });
  if (unread.length > 0) {
    changed = true;
    settled.push(...unread);
  }
  return { providers: settled, changed, ...(nextAtMs !== undefined ? { nextAtMs } : {}) };
}

/** The snapshot's pool of the person's own logins of `provider`, when it has one. */
export function accountsPoolOf(
  pools: readonly QuotaProviderView[] | undefined,
  provider: string,
): QuotaProviderView | undefined {
  return pools?.find((row) => row.provider === provider && row.pool?.source === "accounts");
}
