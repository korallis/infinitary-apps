import {
  formatResetText,
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
 * One pool's reading as a sensor outcome (docs/quota.md, "A proxy's pooled
 * logins"), for an account whose requests go to `address`: undefined when
 * that address is not the proxy, or the proxy holds no login of the pool.
 * A pool with no read login has no window: unknown, never zero.
 */
export function poolOutcome(
  reading: ProxyReading | undefined,
  kind: QuotaPoolKind,
  address: string | undefined,
  nowMs: number,
): ProviderOutcome | undefined {
  if (!reading || !address || !addressIsProxy(address, reading.port)) return undefined;
  if (reading.status === "unavailable")
    return { status: "unavailable", windows: [], reason: reading.reason };
  const logins = reading.logins.filter((login) => login.kind === kind);
  if (logins.length === 0) return undefined;
  const pooled = poolReading(kind, logins, nowMs, SPENT_WINDOW[kind]);
  return {
    status: "ok",
    windows: pooled.windows.map((window) => withResetText(window, nowMs)),
    pool: pooled.pool,
    ...(pooled.credits ? { credits: pooled.credits } : {}),
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
 * The pools a custom connection to the proxy serves, by the pool each of
 * its models belongs to (the proxy's own model list). A model of no pool
 * (Grok, say) adds none.
 */
function connectionPools(reading: ProxyReading, connection: PooledConnection): QuotaPoolKind[] {
  if (reading.status !== "ok") return [];
  const kinds = new Set<QuotaPoolKind>();
  for (const id of connection.modelIds) {
    const kind = reading.modelPools.get(id);
    if (kind) kinds.add(kind);
  }
  return [...kinds];
}

/**
 * One quota row per pool a custom connection to the proxy serves. Its
 * provider is the connection's own, so the catalog and routing find it by
 * the connection's models (`proxyCatalogModels`).
 */
export function proxyConnectionRows(
  reading: ProxyReading | undefined,
  connections: readonly PooledConnection[],
  nowMs: number,
): QuotaProviderView[] {
  if (!reading) return [];
  return connections.flatMap((connection) => {
    if (!addressIsProxy(connection.baseUrl, reading.port)) return [];
    const base = {
      provider: connection.providerId,
      accountId: connection.accountId,
      accountLabel: connection.accountLabel,
      stale: false,
    };
    // Unanswered, the proxy names no pool: the connection's one row says so.
    if (reading.status === "unavailable")
      return [
        {
          ...base,
          label: connection.accountLabel,
          status: "unavailable" as const,
          windows: [],
          reason: reading.reason,
        },
      ];
    return connectionPools(reading, connection).flatMap((kind) => {
      const outcome = poolOutcome(reading, kind, connection.baseUrl, nowMs);
      if (!outcome) return [];
      return [
        {
          ...base,
          label: QUOTA_POOL_NAMES[kind],
          status: outcome.status,
          windows: outcome.windows,
          ...(outcome.windows.length > 0 ? { measuredAt: nowMs } : {}),
          ...(outcome.pool ? { pool: outcome.pool } : {}),
          ...(outcome.credits ? { credits: outcome.credits } : {}),
          ...(outcome.reason ? { reason: outcome.reason } : {}),
          ...(outcome.detail ? { detail: outcome.detail } : {}),
        },
      ];
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
  if (reading?.status !== "ok") return [];
  return connections.flatMap((connection) => {
    if (!addressIsProxy(connection.baseUrl, reading.port)) return [];
    return connection.modelIds.flatMap((id) => {
      const pool = reading.modelPools.get(id);
      if (!pool || !reading.logins.some((login) => login.kind === pool)) return [];
      return [{ provider: connection.providerId, id, name: id, pool }];
    });
  });
}

function withResetText(window: QuotaWindowView, nowMs: number): QuotaWindowView {
  const resetText =
    window.resetsAtMs !== undefined ? formatResetText(window.resetsAtMs, nowMs) : undefined;
  return resetText ? { ...window, resetText } : window;
}
