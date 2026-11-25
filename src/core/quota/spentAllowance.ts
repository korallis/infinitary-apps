import type { CutOff } from "@shared/authFailure";
import { type QuotaSnapshotView, type QuotaWindowView, quotaRowOf } from "@shared/quota";

/**
 * What a provider's refusal of a spent allowance (xAI's 402, which names no
 * reset) is held against: the limiting window of the account's own latest
 * reading - the one with the least left - with its reset and how much it
 * showed. Absent when the reading names no reset still ahead, so there is
 * nothing to end a hold and none is recorded.
 */
export type SpentAllowance = {
  window: QuotaWindowView;
  resetsAt: number;
  leftPercent: number;
};

export function spentAllowanceOf(
  snapshot: QuotaSnapshotView | null | undefined,
  accountId: string,
  now: number,
): SpentAllowance | undefined {
  const view = quotaRowOf(snapshot?.providers, accountId);
  if (!view || view.status !== "ok") return undefined;
  let limiting: QuotaWindowView | undefined;
  for (const window of view.windows) {
    if (window.percentRemaining === undefined) continue;
    if (!limiting || window.percentRemaining < (limiting.percentRemaining ?? 100)) {
      limiting = window;
    }
  }
  if (!limiting || limiting.resetsAtMs === undefined || limiting.resetsAtMs <= now) {
    return undefined;
  }
  return {
    window: limiting,
    resetsAt: limiting.resetsAtMs,
    leftPercent: limiting.percentRemaining ?? 0,
  };
}

export function lowestLeft(windows: readonly QuotaWindowView[]): number | undefined {
  const lefts = windows.flatMap((window) =>
    window.percentRemaining === undefined ? [] : [window.percentRemaining],
  );
  return lefts.length > 0 ? Math.min(...lefts) : undefined;
}

/**
 * The reading a Pi provider's spent-allowance refusal is held against, for a
 * cut-off that names no reset. Only xAI's 402 reports that shape; Claude's
 * refusal without a reset stays unheld, as it is.
 */
export function heldAgainst(
  cutOff: CutOff,
  providerId: string | undefined,
  snapshot: QuotaSnapshotView | null | undefined,
  accountId: string,
  now: number,
): SpentAllowance | undefined {
  if (cutOff.class !== "no_headroom" || cutOff.resetsAt !== undefined) return undefined;
  if (providerId !== "xai") return undefined;
  return spentAllowanceOf(snapshot, accountId, now);
}

/**
 * What a spent-allowance hold is observed against, so a later reading can
 * end it before its reset (`AccountVault.noteReading`): xAI's 402 takes the
 * limiting window of the latest reading (`heldAgainst`), and a refusal that
 * names its own reset (Claude's) keeps the lowest percent left the sensor's
 * own latest reading showed, before any refusal is laid over it. Without
 * that, a reset the vendor gives back early - Claude's Fable reset, which
 * keeps the week's reset time - left the account held and its meter at 0%
 * until the old reset passed.
 */
export function spentAllowanceHold(
  cutOff: CutOff,
  spent: SpentAllowance | undefined,
  sensedLeft: number | undefined,
): { cutOff: CutOff; seen?: { leftPercent: number } } {
  if (spent)
    return {
      cutOff: { ...cutOff, resetsAt: spent.resetsAt },
      seen: { leftPercent: spent.leftPercent },
    };
  if (cutOff.class === "no_headroom" && cutOff.resetsAt !== undefined && sensedLeft !== undefined) {
    return { cutOff, seen: { leftPercent: sensedLeft } };
  }
  return { cutOff };
}

export function sensedLeftOf(
  snapshot: QuotaSnapshotView | null | undefined,
  accountId: string,
): number | undefined {
  const view = quotaRowOf(snapshot?.providers, accountId);
  return view?.status === "ok" ? lowestLeft(view.windows) : undefined;
}

/** What recording a cut-off on this Mac reaches (the vault, the pushed readings, the quota clock). */
export type SpentAllowanceSeams = {
  providerOf(accountId: string): string | undefined;
  latest(): QuotaSnapshotView | undefined;
  /**
   * The lowest percent left in the sensor's own latest reading of the
   * account, before any refusal is laid over it; undefined before one.
   */
  sensedLeft(accountId: string): number | undefined;
  /** `AccountVault.noteCutOff`. */
  hold(accountId: string, cutOff: CutOff, seen?: { leftPercent?: number }): void;
  /** Whether a spent allowance stands on the account after `hold`. */
  holding(accountId: string): boolean;
  /** Lay a refused reading for one window over the meter until its reset. */
  refuse(accountId: string, refused: { windowId: string; resetsAt: number; at: number }): void;
  /** The meter moves now rather than at the next reading. */
  refresh(): void;
};

/**
 * Record a typed cut-off a session observed. A spent allowance that names no
 * reset (xAI's 402) is held until the reset of the limiting window of the
 * account's latest reading, and that window reads 0% left until then, the
 * way a Claude refusal is laid over its meter - otherwise the hold alone
 * would not keep this Mac's routing away. With no reset to hold against
 * the vault keeps it an ordinary failed turn. Either hold keeps what the
 * reading showed (`spentAllowanceHold`).
 */
export function recordCutOff(
  seams: SpentAllowanceSeams,
  accountId: string,
  cutOff: CutOff,
  now: number,
): void {
  const spent = heldAgainst(cutOff, seams.providerOf(accountId), seams.latest(), accountId, now);
  const held = spentAllowanceHold(cutOff, spent, seams.sensedLeft(accountId));
  seams.hold(accountId, held.cutOff, held.seen);
  if (spent && seams.holding(accountId)) {
    seams.refuse(accountId, { windowId: spent.window.id, resetsAt: spent.resetsAt, at: now });
    seams.refresh();
  }
}
