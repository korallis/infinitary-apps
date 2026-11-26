import {
  allowanceSpent,
  bandOf,
  compareBandRank,
  compareSpendRank,
  type SpendBand,
} from "@shared/quotaSignals";
import type { AccountCandidateFact } from "../storage/decisionStore";
import type { ChargeFact } from "./placedWork";

/**
 * The account-selection policy (broker phase 3): after routing has chosen a
 * provider/model, this pure function picks WHICH account of that provider
 * serves the spawn. It reuses the quota-array-dispatch reasoning shape:
 *
 * - Spend priority is the primary measured
 *   axis: the account whose paid allowance is most on track to expire
 *   unused wins, among accounts projected to last through their resets
 *   before those projected to run out (INF-898). Headroom (effective percent remaining, the min across the
 *   account's bounding windows) breaks the remaining cases.
 * - Uncertainty and ineligibility are different findings: an account with
 *   unknown quota STAYS eligible and is never read as zero or as healthy -
 *   measured-positive accounts are preferred, but when nothing measured has
 *   headroom the unknowns rotate round-robin (least recently selected
 *   first) so no single account is silently exhausted.
 * - Only concrete contradictory evidence drops a candidate: disabled by the
 *   user, a store known to have lost its credential, or an account withheld
 *   by a fact beside its credential (no client, a standing cut-off).
 *   `connected: undefined` (not yet checked) keeps the account eligible.
 * - The pinned account always wins while it is healthy.
 * - `onlyPin` serves the provider's login in use alone (docs/quota.md,
 *   "When the login in use runs low"): an enabled pin is the one account
 *   that serves, and when it cannot - spent, signed out, withheld - nothing
 *   is picked, so no other login takes the work unasked.
 * - `protect` implements the one-pool asymmetric rule: the Firstmate
 *   flagship account is deprioritized - chosen only when it is the only
 *   candidate left - and the reasons say so.
 *
 * Every decision carries its reasons (the "why this account" surface).
 */

export type AccountCandidate = {
  accountId: string;
  label: string;
  enabled: boolean;
  /** undefined = not yet checked; only an explicit false drops the account. */
  connected?: boolean;
  /**
   * Why a connected account serves nothing right now (its health reason:
   * a missing client, a standing cut-off). Present drops the account.
   */
  withheld?: string;
  /** Min percent remaining across the account's windows; undefined = unknown. */
  effectivePercentRemaining?: number;
  paceStatus?: "ahead" | "on_pace" | "behind" | "unknown";
  /** Round-robin cursor among unknown-quota accounts. */
  lastSelectedAt?: number;
  /**
   * The account scope's spend priority (positive =
   * paid allowance on track to expire unused, negative = overdrawn against
   * the reset clock). The primary comparison among measured accounts;
   * absent means unmeasurable, which is never ranked as zero.
   */
  spendPriority?: number;
  /**
   * Whether the account scope is projected to last through every reset at
   * its observed burn (INF-898); absent means unknown.
   */
  lastsThroughReset?: boolean;
  /** The band of the unadjusted reading, beside a placed-work-adjusted score. */
  band?: SpendBand;
  /**
   * Its allowance is spent and it keeps going on credits (INF-4104 piece
   * 2): eligible, but only after every account with included allowance.
   */
  onCredits?: boolean;
  charge?: ChargeFact;
};

export type AccountSelectionInput = {
  /** Pi provider id, for the reasons record only. */
  providerId: string;
  candidates: AccountCandidate[];
  /** The provider-level account pin: always wins while healthy. */
  pinnedAccountId?: string;
  /**
   * The pin is the login in use and no other login serves in its place
   * (the `wait` and `ask` choices). A pin the captain turned off, or one
   * that is not a candidate, leaves the pick as it is without this.
   */
  onlyPin?: boolean;
  /** The Firstmate flagship reservation (one pool, one asymmetric rule). */
  protect?: { accountId: string; floorPercent: number };
  /**
   * Rank by the crew allowance bands (INF-1714), as crew routing ranks the
   * model; absent, the decision models keep the three spend groups.
   */
  bands?: boolean;
};

export type AccountSelectionDecision = {
  accountId?: string;
  reasons: string[];
  /** Every candidate with the reading behind it and what became of it. */
  candidates: AccountCandidateFact[];
  /** The provider's account pin chose it. */
  pinned?: true;
  /**
   * Nothing was picked because the login in use cannot serve and no other
   * login may (`onlyPin`): `spent` when all that stops it is its allowance,
   * so the model is still ranked by that login's own reading.
   */
  held?: { accountId: string; spent: boolean };
};

/** Headroom within this many points counts as a tie for tiebreak purposes. */
const TIE_DELTA = 3;

export function selectAccount(input: AccountSelectionInput): AccountSelectionDecision {
  const decision = choose(input);
  const picked = decision.accountId;
  return {
    ...decision,
    candidates: input.candidates.map((candidate) => ({
      accountId: candidate.accountId,
      label: candidate.label,
      ...(typeof candidate.effectivePercentRemaining === "number"
        ? { percentRemaining: candidate.effectivePercentRemaining }
        : {}),
      ...(candidate.paceStatus ? { pace: candidate.paceStatus } : {}),
      ...(typeof candidate.spendPriority === "number"
        ? { spendPriority: candidate.spendPriority }
        : {}),
      ...(typeof candidate.lastsThroughReset === "boolean"
        ? { lastsThroughReset: candidate.lastsThroughReset }
        : {}),
      ...(input.bands ? { band: bandOf(candidate) } : {}),
      ...(candidate.charge ? { charge: candidate.charge } : {}),
      status: statusOf(candidate, picked, input),
    })),
  };
}

/** What became of one candidate, in a word the record can be searched by. */
function statusOf(
  candidate: AccountCandidate,
  picked: string | undefined,
  input: AccountSelectionInput,
): string {
  if (candidate.accountId === picked) return "picked";
  if (!candidate.enabled) return "skipped: disabled";
  if (candidate.connected === false) return "skipped: needs sign in";
  if (candidate.withheld) return `skipped: withheld (${candidate.withheld})`;
  if (isExhausted(candidate)) return "skipped: exhausted";
  if (candidate.accountId === input.protect?.accountId)
    return "skipped: reserved for the first mate";
  return "eligible";
}

function choose(input: AccountSelectionInput): Omit<AccountSelectionDecision, "candidates"> {
  const reasons: string[] = [];
  const eligible: AccountCandidate[] = [];
  const inUse = input.onlyPin
    ? input.candidates.find(
        (candidate) => candidate.accountId === input.pinnedAccountId && candidate.enabled,
      )
    : undefined;
  if (inUse) return chooseLoginInUse(inUse, input.providerId);
  for (const candidate of input.candidates) {
    if (!candidate.enabled) {
      reasons.push(`skipped ${candidate.label}: disabled`);
      continue;
    }
    if (candidate.connected === false) {
      reasons.push(`skipped ${candidate.label}: needs sign in`);
      continue;
    }
    if (candidate.withheld) {
      reasons.push(`skipped ${candidate.label}: withheld (${candidate.withheld})`);
      continue;
    }
    eligible.push(candidate);
  }
  if (eligible.length === 0) {
    reasons.push(`no eligible ${input.providerId} account`);
    return { reasons };
  }

  // The pin always wins while healthy (present and not exhausted). A pin
  // on credits waits behind every account with included allowance.
  const pinned = eligible.find((candidate) => candidate.accountId === input.pinnedAccountId);
  if (pinned) {
    if (!isExhausted(pinned) && !pinned.onCredits) {
      reasons.push(`picked ${pinned.label}: pinned`);
      return { accountId: pinned.accountId, reasons, pinned: true };
    }
    reasons.push(
      pinned.onCredits
        ? `pin ${pinned.label} is on credits; falling back to selection`
        : `pin ${pinned.label} is exhausted; falling back to selection`,
    );
  }

  const usable = eligible.filter((candidate) => !isExhausted(candidate));
  for (const candidate of eligible) {
    if (isExhausted(candidate)) {
      reasons.push(`skipped ${candidate.label}: exhausted`);
    }
  }
  if (usable.length === 0) {
    reasons.push(`every ${input.providerId} account is exhausted`);
    return { reasons };
  }
  // Credits come after every included allowance, the first mate's included.
  const live = usable.filter((candidate) => !candidate.onCredits);
  if (live.length === 0) {
    usable.sort((a, b) => (a.lastSelectedAt ?? 0) - (b.lastSelectedAt ?? 0));
    const chosen = usable[0] as AccountCandidate;
    reasons.push(
      `picked ${chosen.label}: every included allowance is spent; keeps going on credits`,
    );
    return { accountId: chosen.accountId, reasons };
  }
  for (const candidate of usable) {
    if (candidate.onCredits)
      reasons.push(`${candidate.label}: on credits, kept for after every included allowance`);
  }

  // The flagship reservation: deprioritized to last resort.
  const protectedId = input.protect?.accountId;
  const alternatives = live.filter((candidate) => candidate.accountId !== protectedId);
  const flagship = live.find((candidate) => candidate.accountId === protectedId);
  if (flagship && alternatives.length === 0) {
    reasons.push(
      `picked ${flagship.label}: reserved for the first mate, but it is the only candidate`,
    );
    return { accountId: flagship.accountId, reasons };
  }
  if (flagship) {
    const floor = input.protect?.floorPercent ?? 0;
    const remaining =
      typeof flagship.effectivePercentRemaining === "number"
        ? `${Math.round(flagship.effectivePercentRemaining)}% left`
        : "quota unknown";
    reasons.push(
      `skipped ${flagship.label}: reserved for the first mate (floor ${floor}%, ${remaining})`,
    );
  }

  const measured = alternatives.filter(
    (candidate) => typeof candidate.effectivePercentRemaining === "number",
  );
  const unknown = alternatives.filter(
    (candidate) => typeof candidate.effectivePercentRemaining !== "number",
  );

  if (measured.length > 0) {
    measured.sort((a, b) => compareMeasured(a, b, input.bands === true));
    const chosen = measured[0] as AccountCandidate;
    const why =
      typeof chosen.spendPriority === "number"
        ? `spend priority ${chosen.spendPriority.toFixed(2)} (${Math.round(
            chosen.effectivePercentRemaining ?? 0,
          )}% left)`
        : `most headroom (${Math.round(chosen.effectivePercentRemaining ?? 0)}% left)`;
    reasons.push(`picked ${chosen.label}: ${why}`);
    if (unknown.length > 0) {
      reasons.push(
        `${unknown.map((candidate) => candidate.label).join(", ")}: quota unknown, stays eligible`,
      );
    }
    return { accountId: chosen.accountId, reasons };
  }

  // Nothing measured has headroom: rotate the unknowns, least recent first.
  unknown.sort((a, b) => (a.lastSelectedAt ?? 0) - (b.lastSelectedAt ?? 0));
  const chosen = unknown[0] as AccountCandidate;
  reasons.push(`picked ${chosen.label}: quota unknown, rotating least recently used`);
  return { accountId: chosen.accountId, reasons };
}

/** The `onlyPin` pick: the login in use while it can serve, else nothing. */
function chooseLoginInUse(
  inUse: AccountCandidate,
  providerId: string,
): Omit<AccountSelectionDecision, "candidates"> {
  const status = statusOf(inUse, undefined, { providerId, candidates: [] });
  if (status !== "eligible")
    return {
      held: { accountId: inUse.accountId, spent: status === "skipped: exhausted" },
      reasons: [
        // i18n-exempt: a decision ledger reason the first mate reads, never shown
        status.replace("skipped:", `skipped ${inUse.label}:`),
        // i18n-exempt: a decision ledger reason the first mate reads, never shown
        `${inUse.label} is the ${providerId} login in use; no other login serves until it is moved`,
      ],
    };
  return {
    accountId: inUse.accountId,
    reasons: [
      inUse.onCredits
        ? // i18n-exempt: a decision ledger reason the first mate reads, never shown
          `picked ${inUse.label}: the login in use, keeps going on credits`
        : // i18n-exempt: a decision ledger reason the first mate reads, never shown
          `picked ${inUse.label}: the login in use`,
    ],
    pinned: true,
  };
}

export function isExhausted(candidate: AccountCandidate): boolean {
  return allowanceSpent(candidate);
}

/**
 * Spend priority first (the account whose paid
 * allowance is most on track to expire unused), an account projected to
 * last through its resets before one projected to run out (INF-898); a
 * known signal outranks an unmeasurable one; then headroom beyond the tie
 * delta; then LRU.
 */
function compareMeasured(a: AccountCandidate, b: AccountCandidate, bands: boolean): number {
  const order = bands ? compareBandRank(a, b) : compareSpendRank(a, b);
  if (order !== 0) return order;
  const remainingA = a.effectivePercentRemaining ?? 0;
  const remainingB = b.effectivePercentRemaining ?? 0;
  if (Math.abs(remainingA - remainingB) > TIE_DELTA) {
    return remainingB - remainingA;
  }
  return (a.lastSelectedAt ?? 0) - (b.lastSelectedAt ?? 0);
}
