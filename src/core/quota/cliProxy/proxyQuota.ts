import {
  formatResetText,
  QUOTA_POOL_KINDS,
  QUOTA_POOL_NAMES,
  type QuotaPoolKind,
  type QuotaProviderView,
  type QuotaWindowView,
} from "@shared/quota";
import { poolReading } from "@shared/quotaSignals";
import type { QuotaCatalogModel } from "../auth";
import type { ProviderOutcome } from "../outcome";
import { addressIsProxy } from "./proxyApp";
import type { ProxyReading } from "./proxyPools";

/**
 * The window a pool whose every login is spent shows, named as that
 * vendor's weekly window is, when no reading names one.
 */
const SPENT_WINDOW: Record<QuotaPoolKind, { id: string; label: string }> = {
  claude: { id: "seven_day", label: "weekly" },
  chatgpt: { id: "weekly", label: "weekly" },
};

/**
 * Each pool's reading, folded once per proxy reading at the moment it was
 * read: the Claude row, every connection's rows and every refresh they are
 * laid over read the same fold, never timed again.
 */
const folded = new WeakMap<ProxyReading, Map<QuotaPoolKind, ProviderOutcome>>();

function pooledOutcomes(
  reading: ProxyReading & { status: "ok" },
): Map<QuotaPoolKind, ProviderOutcome> {
  const cached = folded.get(reading);
  if (cached) return cached;
  const pools = new Map<QuotaPoolKind, ProviderOutcome>();
  for (const kind of QUOTA_POOL_KINDS) {
    const logins = reading.logins.filter((login) => login.kind === kind);
    if (logins.length === 0) continue;
    const pooled = poolReading(kind, logins, reading.atMs, SPENT_WINDOW[kind]);
    pools.set(kind, {
      status: "ok",
      windows: pooled.windows.map((window) => withResetText(window, reading.atMs)),
      pool: pooled.pool,
      fromProxy: true,
      ...(pooled.credits ? { credits: pooled.credits } : {}),
    });
  }
  folded.set(reading, pools);
  return pools;
}

/**
 * One pool's reading as a sensor outcome (docs/quota.md, "A proxy's pooled
 * logins"), for an account whose requests go to `address`: undefined when
 * that address is not the proxy, or the proxy holds no login of the pool.
 * A pool with no read login has no window: unknown, never zero.
 */
export function poolOutcome(
  reading: ProxyReading | undefined,
  kind: QuotaPoolKind,
  address: string | undefined,
): ProviderOutcome | undefined {
  if (!reading || !address || !addressIsProxy(address, reading.port)) return undefined;
  if (reading.status === "unavailable")
    return { status: "unavailable", windows: [], reason: reading.reason, fromProxy: true };
  return pooledOutcomes(reading).get(kind);
}

/**
 * A quota row read from a proxy outcome, keeping who and what the row is:
 * the one mapping every row read through the proxy goes through. Its
 * measurement is the reading's own moment.
 */
export function rowOfOutcome(
  row: QuotaProviderView,
  outcome: ProviderOutcome,
  atMs: number,
): QuotaProviderView {
  const {
    pool: _pool,
    credits: _credits,
    reason: _reason,
    detail: _detail,
    retryAfter: _retryAfter,
    measuredAt: _measuredAt,
    fromProxy: _fromProxy,
    ...rest
  } = row;
  return {
    ...rest,
    status: outcome.status,
    windows: outcome.windows,
    stale: false,
    ...(outcome.windows.length > 0 ? { measuredAt: atMs } : {}),
    ...(outcome.pool ? { pool: outcome.pool } : {}),
    ...(outcome.credits ? { credits: outcome.credits } : {}),
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    ...(outcome.detail ? { detail: outcome.detail } : {}),
    ...(outcome.fromProxy ? { fromProxy: true as const } : {}),
  };
}

/** A custom connection, as the pools read it. */
export type PooledConnection = {
  accountId: string;
  accountLabel: string;
  providerId: string;
  baseUrl: string;
  modelIds: readonly string[];
};

/**
 * The connection's models the proxy serves from a pool it holds logins of,
 * each under that pool (the proxy's own model list). A model of no pool
 * (Grok, say), and every model while the list cannot be read, is left out:
 * it stays unmeasured. The rows and the catalog both read this one mapping.
 */
function connectionModelPools(
  reading: ProxyReading,
  connection: PooledConnection,
): Map<QuotaPoolKind, string[]> {
  const byPool = new Map<QuotaPoolKind, string[]>();
  if (reading.status !== "ok" || !addressIsProxy(connection.baseUrl, reading.port)) return byPool;
  for (const id of connection.modelIds) {
    const kind = reading.modelPools?.get(id);
    if (!kind || !reading.logins.some((login) => login.kind === kind)) continue;
    byPool.set(kind, [...(byPool.get(kind) ?? []), id]);
  }
  return byPool;
}

/**
 * One quota row per pool a custom connection to the proxy serves. Its
 * provider is the connection's own, and its pool names the models it
 * measures, so the catalog and routing read each model by its own pool.
 */
export function proxyConnectionRows(
  reading: ProxyReading | undefined,
  connections: readonly PooledConnection[],
): QuotaProviderView[] {
  if (!reading) return [];
  return connections.flatMap((connection): QuotaProviderView[] => {
    if (!addressIsProxy(connection.baseUrl, reading.port)) return [];
    const base: QuotaProviderView = {
      provider: connection.providerId,
      label: connection.accountLabel,
      accountId: connection.accountId,
      accountLabel: connection.accountLabel,
      status: "unavailable",
      stale: false,
      windows: [],
    };
    // Unanswered, or with no model list to say which pool serves which
    // model, the proxy names no pool: the connection's one row says why, and
    // its pools' last readings stay on as stale (`mergeStaleProviders`).
    const unread =
      reading.status === "unavailable"
        ? reading.reason
        : reading.modelPools
          ? undefined
          : (reading.modelsFailure ?? "models_unreadable");
    if (unread !== undefined)
      return [
        rowOfOutcome(
          base,
          { status: "unavailable", windows: [], reason: unread, fromProxy: true },
          reading.atMs,
        ),
      ];
    if (reading.status !== "ok") return [];
    const outcomes = pooledOutcomes(reading);
    return [...connectionModelPools(reading, connection)].flatMap(([kind, models]) => {
      const outcome = outcomes.get(kind);
      if (!outcome?.pool) return [];
      const row = rowOfOutcome({ ...base, label: QUOTA_POOL_NAMES[kind] }, outcome, reading.atMs);
      return [{ ...row, pool: { ...outcome.pool, models } }];
    });
  });
}

/**
 * The quota catalog's rows for a connection's models that belong to a pool:
 * each carries its pool, so the catalog reads that pool's row for it and
 * routing weighs its reading instead of admitting it by its level alone.
 */
export function proxyCatalogModels(
  reading: ProxyReading | undefined,
  connections: readonly PooledConnection[],
): QuotaCatalogModel[] {
  if (!reading) return [];
  return connections.flatMap((connection) =>
    [...connectionModelPools(reading, connection)].flatMap(([pool, models]) =>
      models.map((id) => ({ provider: connection.providerId, id, name: id, pool })),
    ),
  );
}

function withResetText(window: QuotaWindowView, nowMs: number): QuotaWindowView {
  const resetText =
    window.resetsAtMs !== undefined ? formatResetText(window.resetsAtMs, nowMs) : undefined;
  return resetText ? { ...window, resetText } : window;
}
