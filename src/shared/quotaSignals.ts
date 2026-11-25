import type {
  QuotaCreditsView,
  QuotaPoolKind,
  QuotaPoolView,
  QuotaProviderView,
  QuotaWindowView,
} from "./quota";

/**
 * Derived quota signals: Infinitary's own quota math.
 * Everything here is pure and recomputed from a snapshot's windows plus a
 * clock, never persisted: a projection is only honest at the moment it is
 * read.
 *
 * The core vocabulary:
 * - reserve = percentRemaining - timeRemainingPercent (± the on-pace
 *   deadband). Negative reserve is "ahead" of the reset clock - burning
 *   faster than linear, conserve. Positive is "behind" - allowance on track
 *   to go unused.
 * - burnMultiple = percentUsed / elapsedPercent: the cycle-average spend
 *   rate against the clock.
 * - spendPriority (per scope): for each bounding window,
 *   S_w = percentRemaining - burnMultiple * timeRemainingPercent (the
 *   percentage points projected to reach reset unused at the observed burn);
 *   gap_w = S_w / timeRemainingPercent; the scope scalar is the
 *   cycle-length-weighted mean of gap_w, clamped to [-100, +100]. Positive
 *   means spending here reclaims allowance that would otherwise expire;
 *   zero is exact utilization; negative is overdrawn.
 *
 * Uncertainty is disclosed, never invented: a bounding window without usable
 *   pace makes the whole scope's runway/spendPriority unknown (an unknown
 *   window is never assumed healthy and never treated as zero). The one
 *   exception is an untriggered window - no reset clock, zero usage - which
 *   is fully available and blocks nothing.
 */

export type PaceStatus = "ahead" | "on_pace" | "behind" | "unknown";

/** Within ±1 percentage point of the linear clock, rounding noise is on pace. */
const PACE_DEADBAND = 1;
/** A cycle less than 10% elapsed projects with early confidence. */
const EARLY_ELAPSED_PERCENT = 10;
/** spendPriority is clamped so one near-reset window cannot dwarf the scale. */
const SPEND_PRIORITY_CLAMP = 100;

export type WindowSignals =
  | {
      kind: "measured";
      status: PaceStatus;
      reservePercentPoints: number;
      burnMultiple: number;
      timeRemainingPercent: number;
      elapsedPercent: number;
      cycleSeconds: number;
      /** Present only when the cycle-average burn exhausts the window. */
      projectedExhaustedAtMs?: number;
      confidence: "early" | "established";
    }
  /** No reset clock and nothing used: fully available, not yet started. */
  | { kind: "untriggered" }
  /** Headroom may be known, but pace/projection cannot be computed. */
  | { kind: "unmeasurable" };

/**
 * Pace from trusted cycle evidence only: a startsAt+resetsAt pair, or a
 * provider-owned cycle length with resetsAt. Nothing is inferred from labels.
 */
export function windowSignals(window: QuotaWindowView, nowMs: number): WindowSignals {
  const remaining = window.percentRemaining;
  if (window.resetsAtMs === undefined) {
    // Not yet triggered (a session window before its first request) reads as
    // fully available rather than a data gap - but only with zero usage; any
    // other shape without a clock is a real gap.
    if (remaining !== undefined && remaining >= 100) return { kind: "untriggered" };
    return { kind: "unmeasurable" };
  }
  if (remaining === undefined) return { kind: "unmeasurable" };
  const cycleSeconds =
    window.startsAtMs !== undefined && window.resetsAtMs > window.startsAtMs
      ? (window.resetsAtMs - window.startsAtMs) / 1000
      : window.windowSeconds;
  if (!cycleSeconds || cycleSeconds <= 0) return { kind: "unmeasurable" };
  const remainingSeconds = (window.resetsAtMs - nowMs) / 1000;
  // An expired reset, or one so close the clock has effectively run out, is
  // unmeasurable rather than infinite spend priority.
  if (remainingSeconds <= 0) return { kind: "unmeasurable" };
  const timeRemainingPercent = Math.min(100, (100 * remainingSeconds) / cycleSeconds);
  const elapsedPercent = 100 - timeRemainingPercent;
  const used = 100 - remaining;
  let burnMultiple: number;
  if (elapsedPercent > 0) {
    burnMultiple = Math.max(0, used) / elapsedPercent;
  } else if (used <= 0) {
    burnMultiple = 0;
  } else {
    return { kind: "unmeasurable" };
  }
  const reservePercentPoints = remaining - timeRemainingPercent;
  const status: PaceStatus =
    Math.abs(reservePercentPoints) <= PACE_DEADBAND
      ? "on_pace"
      : reservePercentPoints < 0
        ? "ahead"
        : "behind";
  const elapsedSeconds = (cycleSeconds * elapsedPercent) / 100;
  const projectedExhaustedAtMs =
    burnMultiple > 0 && elapsedSeconds > 0 && used > 0
      ? nowMs + (remaining / (used / elapsedSeconds)) * 1000
      : undefined;
  return {
    kind: "measured",
    status,
    reservePercentPoints,
    burnMultiple,
    timeRemainingPercent,
    elapsedPercent,
    cycleSeconds,
    ...(projectedExhaustedAtMs !== undefined ? { projectedExhaustedAtMs } : {}),
    confidence: elapsedPercent < EARLY_ELAPSED_PERCENT ? "early" : "established",
  };
}

export type RunwayStatus = "exhausted_now" | "projected_exhaustion" | "through_reset" | "unknown";

export type ScopeSignals = {
  scope: string;
  /** Window ids whose limits jointly bound this scope. */
  boundedBy: string[];
  /** Min headroom across bounding windows; absent when any bound is unread. */
  effectivePercentRemaining?: number;
  /** The window supplying that minimum. */
  limitingWindowId?: string;
  pace: PaceStatus | "mixed";
  runway: {
    status: RunwayStatus;
    projectedExhaustedAtMs?: number;
    limitingWindowId?: string;
    confidence?: "early" | "established";
  };
  /** Absent means unmeasurable - a completely different claim from 0. */
  spendPriority?: number;
  /** The bounding windows that block runway/spendPriority, when any do. */
  unmeasurableWindowIds?: string[];
};

export function scopeSignals(input: {
  scope: string;
  windows: QuotaWindowView[];
  nowMs: number;
}): ScopeSignals {
  const boundedBy = input.windows.map((window) => window.id);
  const perWindow = input.windows.map((window) => ({
    window,
    signals: windowSignals(window, input.nowMs),
  }));

  // Headroom: the min across bounds with a read percentage (an untriggered
  // window's 100% still counts). A bound with no percentage at all leaves
  // headroom unknown rather than overstated.
  let effectivePercentRemaining: number | undefined;
  let limitingWindowId: string | undefined;
  let headroomUnknown = false;
  for (const { window } of perWindow) {
    if (typeof window.percentRemaining !== "number") {
      headroomUnknown = true;
      continue;
    }
    if (
      effectivePercentRemaining === undefined ||
      window.percentRemaining < effectivePercentRemaining
    ) {
      effectivePercentRemaining = window.percentRemaining;
      limitingWindowId = window.id;
    }
  }
  if (headroomUnknown) {
    effectivePercentRemaining = undefined;
    limitingWindowId = undefined;
  }

  const statuses = new Set<PaceStatus>();
  for (const { signals } of perWindow) {
    if (signals.kind === "measured") statuses.add(signals.status);
    else if (signals.kind === "unmeasurable") statuses.add("unknown");
  }
  const known = [...statuses].filter((status) => status !== "unknown");
  const pace: ScopeSignals["pace"] = known.length > 1 ? "mixed" : (known[0] ?? "unknown");

  // A bounding window without usable pace blocks the scope's projections.
  const unmeasurableWindowIds = perWindow
    .filter((entry) => entry.signals.kind === "unmeasurable")
    .map((entry) => entry.window.id);

  // Runway: exhausted-now wins outright; otherwise every bound must be
  // measurable (or untriggered) before any through-reset claim is made.
  const exhausted = perWindow.find(
    (entry) =>
      typeof entry.window.percentRemaining === "number" && entry.window.percentRemaining <= 0,
  );
  let runway: ScopeSignals["runway"];
  if (exhausted) {
    runway = { status: "exhausted_now", limitingWindowId: exhausted.window.id };
  } else if (unmeasurableWindowIds.length > 0 || perWindow.length === 0) {
    runway = { status: "unknown" };
  } else {
    let earliest:
      | { atMs: number; windowId: string; confidence: "early" | "established" }
      | undefined;
    let anyEarly = false;
    for (const { window, signals } of perWindow) {
      if (signals.kind !== "measured") continue;
      if (signals.confidence === "early") anyEarly = true;
      if (
        signals.projectedExhaustedAtMs !== undefined &&
        window.resetsAtMs !== undefined &&
        signals.projectedExhaustedAtMs < window.resetsAtMs &&
        (!earliest || signals.projectedExhaustedAtMs < earliest.atMs)
      ) {
        earliest = {
          atMs: signals.projectedExhaustedAtMs,
          windowId: window.id,
          confidence: signals.confidence,
        };
      }
    }
    runway = earliest
      ? {
          status: "projected_exhaustion",
          projectedExhaustedAtMs: earliest.atMs,
          limitingWindowId: earliest.windowId,
          confidence: earliest.confidence,
        }
      : { status: "through_reset", confidence: anyEarly ? "early" : "established" };
  }

  // spendPriority: the cycle-weighted mean of per-window gaps. Untriggered
  // windows contribute nothing and block nothing; any unmeasurable bound
  // makes the whole scope unknown.
  let spendPriority: number | undefined;
  if (unmeasurableWindowIds.length === 0) {
    let weighted = 0;
    let totalCycle = 0;
    for (const { signals } of perWindow) {
      if (signals.kind !== "measured") continue;
      // S_w = percentRemaining - burnMultiple * timeRemaining, written via
      // the identity percentRemaining = reserve + timeRemaining.
      const s =
        signals.reservePercentPoints +
        signals.timeRemainingPercent -
        signals.burnMultiple * signals.timeRemainingPercent;
      const gap = s / signals.timeRemainingPercent;
      weighted += gap * signals.cycleSeconds;
      totalCycle += signals.cycleSeconds;
    }
    if (totalCycle > 0) {
      spendPriority = Math.max(
        -SPEND_PRIORITY_CLAMP,
        Math.min(SPEND_PRIORITY_CLAMP, weighted / totalCycle),
      );
    }
  }

  return {
    scope: input.scope,
    boundedBy,
    ...(effectivePercentRemaining !== undefined ? { effectivePercentRemaining } : {}),
    ...(limitingWindowId !== undefined ? { limitingWindowId } : {}),
    pace,
    runway,
    ...(spendPriority !== undefined ? { spendPriority } : {}),
    ...(unmeasurableWindowIds.length > 0 ? { unmeasurableWindowIds } : {}),
  };
}

/**
 * How one provider's windows bound its scopes, following each vendor's
 * semantics: account-wide windows jointly bound
 * "all_models"; a model- or product-scoped window bounds only its own scope
 * (on top of the account-wide bounds) and never drags the account minimum
 * down; overage/extra-credit windows bound nothing. Every offered provider
 * has a known account-wide bound, so a combined minimum is reported.
 */
export function classifyProviderWindows(
  quotaId: string,
  windows: QuotaWindowView[],
): {
  /** Whether an account-wide combined bound exists for this provider. */
  combined: boolean;
  /** Account-wide bounding windows (empty when `combined` is false). */
  bounding: QuotaWindowView[];
  /** Scope id -> that scope's own extra windows (model/product/feature). */
  scoped: Map<string, QuotaWindowView[]>;
  /** Windows that bound nothing (overage / extra usage). */
  excluded: QuotaWindowView[];
} {
  const bounding: QuotaWindowView[] = [];
  const scoped = new Map<string, QuotaWindowView[]>();
  const excluded: QuotaWindowView[] = [];
  const addScoped = (scope: string, window: QuotaWindowView) => {
    const rows = scoped.get(scope) ?? [];
    rows.push(window);
    scoped.set(scope, rows);
  };
  for (const window of windows) {
    const id = window.id;
    if (id.includes("overage") || id.includes("extra_usage") || id === "overage") {
      excluded.push(window);
      continue;
    }
    const modelMatch = id.match(/^model:(.+?)(?::\d+[a-z]+)?$/);
    if (modelMatch?.[1]) {
      addScoped(`model:${modelMatch[1]}`, window);
      continue;
    }
    // Claude's per-model weeklies ("seven_day_opus") scope like model windows.
    const claudeModel = id.match(/^seven_day_(.+)$/);
    if (claudeModel?.[1]) {
      addScoped(`model:${claudeModel[1]}`, window);
      continue;
    }
    if (id.startsWith("code_review")) {
      addScoped("code_review", window);
      continue;
    }
    if ((quotaId === "grok" || quotaId === "copilot") && id.startsWith("product:")) {
      addScoped(id, window);
      continue;
    }
    bounding.push(window);
  }
  return { combined: true, bounding, scoped, excluded };
}

export type ProviderScopeView = {
  combined: boolean;
  /** The account-wide scope, when a combined bound exists with windows. */
  allModels?: ScopeSignals;
  /** Every narrower scope (model/product/feature), by scope id. */
  scopes: ScopeSignals[];
};

/**
 * All scope signals for one account row. A stale row deliberately reports
 * nothing derived: a stale raw percentage must never read as current
 * headroom (the raw windows stay visible for diagnostics, marked stale).
 */
export function providerScopes(row: QuotaProviderView, nowMs: number): ProviderScopeView {
  if (row.status !== "ok" || row.stale) return { combined: false, scopes: [] };
  const { combined, bounding, scoped } = classifyProviderWindows(row.provider, row.windows);
  const allModels =
    combined && bounding.length > 0
      ? scopeSignals({ scope: "all_models", windows: bounding, nowMs })
      : undefined;
  const scopes = [...scoped.entries()].map(([scope, extra]) =>
    scopeSignals({
      scope,
      // A named scope is bounded by the account-wide windows plus its own.
      windows: combined ? [...bounding, ...extra] : extra,
      nowMs,
    }),
  );
  return { combined, ...(allModels ? { allModels } : {}), scopes };
}

/** The ranking facts of one candidate model or account. */
export type SpendRank = { spendPriority?: number; lastsThroughReset?: boolean };

/**
 * The spend-ranking group (INF-898): a known score projected to last through
 * every reset (0), a known score projected to run out first (1), then an
 * unmeasurable score (2). Spend priority orders candidates within a group.
 */
export function spendGroup(rank: SpendRank): number {
  if (typeof rank.spendPriority !== "number") return 2;
  return rank.lastsThroughReset === true ? 0 : 1;
}

/**
 * Highest spend priority first, but never above a candidate of an earlier
 * group: conserving a scope that will run out before its reset outranks
 * spending one whose allowance may go unused. Equal ranks compare 0, so
 * the caller's own tiebreak decides.
 */
export function compareSpendRank(a: SpendRank, b: SpendRank): number {
  const group = spendGroup(a) - spendGroup(b);
  if (group !== 0) return group;
  if (typeof a.spendPriority === "number" && typeof b.spendPriority === "number") {
    return b.spendPriority - a.spendPriority;
  }
  return 0;
}

/**
 * The near-floor boundary of crew routing (INF-1714, the captain's choice of
 * 10%): a known allowance at or below it ranks after every allowance above
 * it, whatever its score. It matches the meter's danger boundary; it is not
 * the first mate's 15% reserve.
 */
export const CREW_NEAR_FLOOR_PERCENT = 10;

/**
 * The four crew allowance bands, in order (INF-1714): room - above the
 * floor, a known score, projected to last through every reset; conserve -
 * above the floor, a known score, projected to run out first; near-floor -
 * a known allowance at or below the floor; unknown - no usable reading.
 * A band is read from the unadjusted reading only: an estimate of placed
 * work orders candidates inside a band and never moves one between bands.
 * A fifth band, credits, comes last (INF-4104 piece 2): a spent allowance
 * whose account keeps going on credits, after every included allowance.
 */
export type SpendBand = "room" | "conserve" | "near_floor" | "unknown" | "credits";

export const SPEND_BANDS: readonly SpendBand[] = [
  "room",
  "conserve",
  "near_floor",
  "unknown",
  "credits",
];

export type BandFacts = SpendRank & { effectivePercentRemaining?: number; onCredits?: boolean };

/**
 * A known allowance that is spent and not carried on credits: nothing
 * serves on it until its reset.
 */
export function allowanceSpent(raw: BandFacts): boolean {
  return (
    typeof raw.effectivePercentRemaining === "number" &&
    raw.effectivePercentRemaining <= 0 &&
    raw.onCredits !== true
  );
}

export function spendBand(raw: BandFacts, floorPercent = CREW_NEAR_FLOOR_PERCENT): SpendBand {
  if (raw.onCredits === true) return "credits";
  if (
    typeof raw.effectivePercentRemaining === "number" &&
    raw.effectivePercentRemaining <= floorPercent
  )
    return "near_floor";
  if (typeof raw.spendPriority !== "number") return "unknown";
  return raw.lastsThroughReset === true ? "room" : "conserve";
}

/**
 * A crew candidate's ranking facts: `band` is the band of its unadjusted
 * reading, when a placed-work adjustment replaced the score beside it;
 * absent, the band is read from these facts, which are then unadjusted.
 */
export type BandRank = BandFacts & { band?: SpendBand };

export function bandOf(rank: BandRank): SpendBand {
  return rank.band ?? spendBand(rank);
}

/**
 * Crew ranking (INF-1714): the band first, then the highest spend priority
 * inside it (adjusted for placed work where it was). Equal ranks compare 0,
 * so the caller's own tiebreak decides. The first mate and the decision
 * models keep `compareSpendRank`.
 */
export function compareBandRank(a: BandRank, b: BandRank): number {
  const band = SPEND_BANDS.indexOf(bandOf(a)) - SPEND_BANDS.indexOf(bandOf(b));
  if (band !== 0) return band;
  if (typeof a.spendPriority === "number" && typeof b.spendPriority === "number") {
    return b.spendPriority - a.spendPriority;
  }
  if (typeof a.spendPriority === "number") return -1;
  if (typeof b.spendPriority === "number") return 1;
  return 0;
}

/** "3h 20m", "5d 19h", "40m" - the human form of a runway or reset horizon. */
export function formatDurationShort(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/** One window of one pooled login: what is left of it and when it refills. */
export type PoolLoginWindow = {
  id: string;
  label: string;
  percentRemaining: number;
  resetsAtMs?: number;
};

/**
 * One login of a CLI proxy, as the pool weighs it at the moment it was read
 * (docs/quota.md, "A proxy's pooled logins"). `windows` absent is unread.
 * - `serving` it answers now,
 * - `spent` its allowance ran out: it weighs zero until `backAtMs`,
 * - `switched_off` the proxy has it switched off,
 * - `sign_in_ended` its sign-in ended in the proxy and it cannot serve.
 */
export type PoolLogin = {
  state: "serving" | "spent" | "switched_off" | "sign_in_ended";
  /** The proxy's own weight for the login; absent weighs one. */
  weight?: number;
  backAtMs?: number;
  /** The proxy says sign in again before this moment, when it stops serving. */
  signInByMs?: number;
  windows?: PoolLoginWindow[];
  credits?: QuotaCreditsView;
};

export type PoolReading = {
  windows: QuotaWindowView[];
  pool: QuotaPoolView;
  credits?: QuotaCreditsView;
};

function earliest(values: (number | undefined)[]): number | undefined {
  const known = values.filter((value): value is number => typeof value === "number");
  return known.length > 0 ? Math.min(...known) : undefined;
}

/**
 * A proxy's logins of one kind as one allowance. For each window, the share
 * left is the weighted mean of what every serving, read login has left of
 * it, with each spent login weighing in at zero; a window a read login has
 * not reported, or whose reset has passed, leaves that login out of it or
 * counts it full again. Unread, switched-off and sign-in-ended logins are
 * counted and never weigh as zero: unknown is not empty. The window refills
 * at the earliest moment a spent login comes back or a read login resets.
 * Pace stays unknown: the logins' cycles differ, so the pool has no one
 * cycle to measure it against, and no window carries a cycle length.
 */
export function poolReading(
  kind: QuotaPoolKind,
  logins: readonly PoolLogin[],
  nowMs: number,
  /** The window a pool with every login spent and none read is shown on. */
  spentWindow: { id: string; label: string },
): PoolReading {
  const weightOf = (login: PoolLogin) =>
    typeof login.weight === "number" && login.weight > 0 ? login.weight : 1;
  const serving = logins.filter((login) => login.state === "serving");
  const read = serving.filter((login) => login.windows !== undefined);
  const spent = logins.filter((login) => login.state === "spent");
  const soon = serving.filter((login) => login.signInByMs !== undefined);
  const pool: QuotaPoolView = {
    kind,
    logins: logins.length,
    read: read.length,
    unread: serving.length - read.length,
    spent: spent.length,
    switchedOff: logins.filter((login) => login.state === "switched_off").length,
    signInEnded: logins.filter((login) => login.state === "sign_in_ended").length,
    signInSoon: soon.length,
  };
  const backAtMs = earliest(spent.map((login) => login.backAtMs));
  if (backAtMs !== undefined) pool.backAtMs = backAtMs;
  const signInByMs = earliest(soon.map((login) => login.signInByMs));
  if (signInByMs !== undefined) pool.signInByMs = signInByMs;

  // The read logins name the windows. Only with no login serving do the
  // spent logins' last readings name them: a window just the spent logins
  // reported never shows a serving pool as spent, and an unread serving
  // login keeps the pool unknown.
  const namers = read.length > 0 ? read : serving.length === 0 ? spent : [];
  const labels = new Map<string, string>();
  for (const login of namers) {
    for (const window of login.windows ?? []) {
      if (!labels.has(window.id)) labels.set(window.id, window.label);
    }
  }
  const windows: QuotaWindowView[] = [];
  for (const [id, label] of labels) {
    let weighted = 0;
    let total = 0;
    const resets: (number | undefined)[] = [];
    for (const login of read) {
      const window = login.windows?.find((entry) => entry.id === id);
      if (!window) continue;
      const lapsed = window.resetsAtMs !== undefined && window.resetsAtMs <= nowMs;
      const left = lapsed ? 100 : Math.max(0, Math.min(100, window.percentRemaining));
      weighted += left * weightOf(login);
      total += weightOf(login);
      if (!lapsed) resets.push(window.resetsAtMs);
    }
    for (const login of spent) {
      total += weightOf(login);
      resets.push(login.backAtMs);
    }
    if (total === 0) continue;
    const resetsAtMs = earliest(resets);
    windows.push({
      id,
      label,
      percentRemaining: weighted / total,
      ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
    });
  }
  // No login serving and one spent: the pool is spent, in one window. An
  // unread serving login keeps it unknown instead.
  if (windows.length === 0 && spent.length > 0 && serving.length === 0) {
    windows.push({
      ...spentWindow,
      percentRemaining: 0,
      ...(backAtMs !== undefined ? { resetsAtMs: backAtMs } : {}),
    });
  }
  const credits = serving.find((login) => login.credits?.state === "available")?.credits;
  return { windows, pool, ...(credits ? { credits } : {}) };
}
