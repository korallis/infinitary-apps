import type { QuotaCreditsView, QuotaProviderView } from "@shared/quota";
import type { AppDatabase } from "../storage/db";
import { buildWindow } from "./pace";

/**
 * Quota that arrives on a session rather than from a sensor
 * (account-broker phase 7). Most subscriptions expose a usage endpoint the
 * fetcher polls; Claude's plan windows are pushed mid-session and exist
 * nowhere else, so they are stored as they arrive and rendered from the
 * last reading between sessions.
 *
 * The reading is honest about its age: a window nobody has refreshed since
 * the last session is last-known, and marked stale, rather than presented as
 * live (decision D-7 - stale beats wrong).
 */

/** A reading older than this is last-known rather than current. */
export const PUSHED_STALE_AFTER_MS = 30 * 60 * 1000;

/** Whether the window still allows work, as the session reported it. */
export type PushedWindowStatus = "allowed" | "allowed_warning" | "rejected";

export type PushedWindow = {
  /** The plan window this reading is about ("five_hour", "seven_day", ...). */
  windowId: string;
  /** Absent on a reading from before the status was kept: unknown, never `allowed`. */
  status?: PushedWindowStatus;
  /** Fraction of the window consumed, as the session reported it (0..1). */
  utilization?: number;
  resetsAt?: number;
  /** What the same reading said about extra usage; absent when it said nothing. */
  overageStatus?: PushedWindowStatus;
  /** The client's code for why extra usage cannot answer (`out_of_credits`, ...). */
  overageReason?: string;
  /** The session was answering on extra usage when it pushed this reading. */
  usingOverage?: boolean;
  at: number;
};

export type PushedQuotaReading = {
  accountId: string;
  quotaId: string;
  providerLabel: string;
  windows: PushedWindow[];
};

/** Window ids as the user reads them, matching the sensor's vocabulary. */
const WINDOW_LABELS: Record<string, string> = {
  five_hour: "session",
  seven_day: "weekly",
  seven_day_opus: "weekly (Opus)",
  seven_day_sonnet: "weekly (Sonnet)",
  seven_day_overage_included: "weekly (with overage)",
  overage: "overage",
};

function windowLabel(windowId: string): string {
  return WINDOW_LABELS[windowId] ?? windowId.replace(/_/g, " ");
}

/**
 * The store for pushed readings. Persisted so a restart shows last-known
 * windows instead of an empty card, and keyed by account so one
 * subscription's exhaustion never colours a sibling's.
 */
export class PushedQuotaStore {
  private readonly readings = new Map<string, Map<string, PushedWindow>>();

  constructor(private readonly db: AppDatabase) {
    this.load();
  }

  record(accountId: string, window: PushedWindow): void {
    const windows = this.readings.get(accountId) ?? new Map<string, PushedWindow>();
    windows.set(window.windowId, window);
    this.readings.set(accountId, windows);
    this.db
      .prepare(
        "INSERT INTO pushed_quota (account_id, window_id, status, utilization, resets_at," +
          " overage_status, overage_reason, using_overage, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)" +
          " ON CONFLICT(account_id, window_id) DO UPDATE SET status = excluded.status," +
          " utilization = excluded.utilization, resets_at = excluded.resets_at," +
          " overage_status = excluded.overage_status, overage_reason = excluded.overage_reason," +
          " using_overage = excluded.using_overage, at = excluded.at",
      )
      .run(
        accountId,
        window.windowId,
        window.status ?? null,
        window.utilization ?? null,
        window.resetsAt ?? null,
        window.overageStatus ?? null,
        window.overageReason ?? null,
        window.usingOverage === undefined ? null : window.usingOverage ? 1 : 0,
        window.at,
      );
  }

  forget(accountId: string): void {
    this.readings.delete(accountId);
    this.db.prepare("DELETE FROM pushed_quota WHERE account_id = ?").run(accountId);
  }

  windowsFor(accountId: string): PushedWindow[] {
    return [...(this.readings.get(accountId)?.values() ?? [])];
  }

  private load(): void {
    const rows = this.db
      .prepare(
        "SELECT account_id, window_id, status, utilization, resets_at, overage_status," +
          " overage_reason, using_overage, at FROM pushed_quota",
      )
      .all() as {
      account_id: string;
      window_id: string;
      status: string | null;
      utilization: number | null;
      resets_at: number | null;
      overage_status: string | null;
      overage_reason: string | null;
      using_overage: number | null;
      at: number;
    }[];
    for (const row of rows) {
      const windows = this.readings.get(row.account_id) ?? new Map<string, PushedWindow>();
      const status = pushedStatus(row.status);
      const overageStatus = pushedStatus(row.overage_status);
      windows.set(row.window_id, {
        windowId: row.window_id,
        ...(status ? { status } : {}),
        ...(row.utilization !== null ? { utilization: row.utilization } : {}),
        ...(row.resets_at !== null ? { resetsAt: row.resets_at } : {}),
        ...(overageStatus ? { overageStatus } : {}),
        ...(row.overage_reason !== null ? { overageReason: row.overage_reason } : {}),
        ...(row.using_overage !== null ? { usingOverage: row.using_overage === 1 } : {}),
        at: row.at,
      });
      this.readings.set(row.account_id, windows);
    }
  }
}

/**
 * Render pushed readings as the same QuotaProviderView the sensor produces,
 * so one account row looks the same whichever way its quota was measured.
 */
export function pushedProviderViews(
  accounts: { accountId: string; accountLabel: string; quotaId: string; providerLabel: string }[],
  windowsFor: (accountId: string) => PushedWindow[],
  now: number,
): QuotaProviderView[] {
  return accounts.map((account) => {
    const readings = windowsFor(account.accountId);
    const stale = readings.some((reading) => now - reading.at > PUSHED_STALE_AFTER_MS);
    const credits = pushedCredits(readings, now)?.credits;
    return {
      provider: account.quotaId,
      label: account.providerLabel,
      accountId: account.accountId,
      accountLabel: account.accountLabel,
      // No reading yet is unknown quota, not zero: the account stays
      // eligible and the card says "no data" rather than inventing a meter.
      status: "ok",
      stale: readings.length > 0 ? stale : false,
      windows: readings
        .map((reading) =>
          buildWindow({
            id: reading.windowId,
            label: windowLabel(reading.windowId),
            ...(reading.utilization !== undefined
              ? { percentRemaining: clampPercent(100 * (1 - reading.utilization)) }
              : {}),
            ...(reading.resetsAt !== undefined ? { resetsAtMs: reading.resetsAt } : {}),
            now,
          }),
        )
        .sort((a, b) => a.id.localeCompare(b.id)),
      ...(credits ? { credits } : {}),
    };
  });
}

/**
 * The rows of logins measured only by what their sessions push: a further
 * Claude login, whose usage nothing but Claude Code reports (docs/quota.md,
 * "A further Claude login"). Each reading stands until its reset: a refused
 * window reads zero until then, and a window whose reset has passed counts
 * as refilled, with no reset of its own until a session reports the next.
 */
export function pushedOnlyProviderViews(
  accounts: { accountId: string; accountLabel: string; quotaId: string; providerLabel: string }[],
  windowsFor: (accountId: string) => PushedWindow[],
  now: number,
): QuotaProviderView[] {
  return pushedProviderViews(
    accounts,
    (accountId) =>
      windowsFor(accountId).map((reading): PushedWindow => {
        if (reading.resetsAt !== undefined && reading.resetsAt <= now) {
          const { resetsAt: _resetsAt, status: _status, ...rest } = reading;
          return { ...rest, status: "allowed", utilization: 0 };
        }
        return reading.status === "rejected" && reading.resetsAt !== undefined
          ? { ...reading, utilization: 1 }
          : reading;
      }),
    now,
  );
}

/**
 * The client's codes for extra usage that cannot answer because nothing
 * could be read, rather than because it is switched off: unknown, never off.
 */
const UNREAD_OVERAGE_REASONS: ReadonlySet<string> = new Set(["fetch_error", "unknown"]);

/**
 * Extra usage as the newest pushed reading that spoke of it says
 * (docs/quota.md, "Credits past the allowance"): allowed is `available`,
 * with `inUse` while that reading is current and the session said it was
 * answering on it; refused for `out_of_credits` is `spent`; refused for a
 * reason the client could not read is `unknown`; refused for any other
 * reason is `off`. No reading that spoke of it says nothing.
 */
export function pushedCredits(
  readings: PushedWindow[],
  now: number,
): { credits: QuotaCreditsView; at: number } | undefined {
  let newest: PushedWindow | undefined;
  for (const reading of readings) {
    if (reading.overageStatus === undefined) continue;
    if (!newest || reading.at > newest.at) newest = reading;
  }
  if (!newest?.overageStatus) return undefined;
  const at = newest.at;
  if (newest.overageStatus !== "rejected") {
    const current = now - at <= PUSHED_STALE_AFTER_MS;
    return {
      credits: { state: "available", ...(current && newest.usingOverage ? { inUse: true } : {}) },
      at,
    };
  }
  const reason = newest.overageReason;
  if (reason === "out_of_credits") return { credits: { state: "spent" }, at };
  if (reason === undefined || UNREAD_OVERAGE_REASONS.has(reason)) {
    return { credits: { state: "unknown" }, at };
  }
  return { credits: { state: "off" }, at };
}

/**
 * A sensed row with its sessions' word on extra usage laid over it: the
 * newer of the two readings decides the state, the sensor's share of the
 * monthly limit stays beside an `available` state, and only a current
 * pushed reading can say the account is answering on it now. A row that is
 * not a reading is left as it stands.
 */
export function withPushedCredits(
  view: QuotaProviderView,
  readings: PushedWindow[],
  now: number,
): QuotaProviderView {
  if (view.status !== "ok") return view;
  const pushed = pushedCredits(readings, now);
  if (!pushed) return view;
  const sensed = view.credits;
  const pushedIsNewer = !sensed || view.measuredAt === undefined || pushed.at >= view.measuredAt;
  const state = pushedIsNewer ? pushed.credits.state : (sensed?.state ?? pushed.credits.state);
  const credits: QuotaCreditsView = {
    state,
    ...(state === "available" && sensed?.usedPercent !== undefined
      ? { usedPercent: sensed.usedPercent }
      : {}),
    ...(state === "available" && pushed.credits.inUse ? { inUse: true } : {}),
  };
  return { ...view, credits };
}

/**
 * A sensed account's row with its sessions' refusals laid over it (the
 * cut-off contract, docs/quota.md "Typed cut-offs"): a pushed `rejected`
 * reading is a zero window until its reset, even for a provider whose
 * usage is sensed - the vendor said no, and the sensor lags behind it.
 * Only a `rejected` reading's reset is trusted: rows written before
 * migration 51 held `resets_at` in seconds, and none of them has a status.
 *
 * A row the sensor measured keeps its other windows. A row it could not
 * measure is known only through the refusal, so it carries just that and
 * is marked `unread`: the refusal is no reading of the allowance. A
 * sign-out proven by the sensor is left as it stands, and with no current
 * refusal the row is untouched - unknown is still never zero.
 */
export function withRejectedReadings(
  view: QuotaProviderView,
  readings: PushedWindow[],
  now: number,
): QuotaProviderView {
  if (view.status === "auth_required") return view;
  const rejected = readings.filter(
    (reading) =>
      reading.status === "rejected" && reading.resetsAt !== undefined && reading.resetsAt > now,
  );
  if (rejected.length === 0) return view;
  const zero = rejected.map((reading) =>
    buildWindow({
      id: reading.windowId,
      label: windowLabel(reading.windowId),
      percentRemaining: 0,
      ...(reading.resetsAt !== undefined ? { resetsAtMs: reading.resetsAt } : {}),
      now,
    }),
  );
  const refused = new Set(zero.map((window) => window.id));
  if (view.status === "ok") {
    return {
      ...view,
      windows: [...view.windows.filter((window) => !refused.has(window.id)), ...zero].sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    };
  }
  const { reason: _reason, detail: _detail, retryAfter: _retryAfter, ...rest } = view;
  return {
    ...rest,
    status: "ok",
    stale: false,
    unread: true,
    measuredAt: Math.max(...rejected.map((reading) => reading.at)),
    windows: zero.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** A stored status this build knows, else unknown. */
function pushedStatus(value: string | null): PushedWindowStatus | undefined {
  return value === "allowed" || value === "allowed_warning" || value === "rejected"
    ? value
    : undefined;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}
