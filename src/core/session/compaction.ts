import type { SummaryPoint } from "@shared/summaryPoint";
import type { SessionCompaction, SessionSpec } from "./session";

/** Captain’s INF-447 ruling: the app's own summary point, which Settings → Intelligence can change (INF-6693). */
export const SESSION_COMPACTION_TOKENS = 300_000;

/**
 * The one automatic summary rule every Pi conversation of the first mate and
 * the crew carries (INF-6693): summarize at `SESSION_COMPACTION_TOKENS`, or
 * before a request would cross the model's first usable price step, where
 * every input token costs more, when that comes sooner. Claude sessions take
 * the same point through the client's own window (`claudeCompactionSettings`).
 */
export const SESSION_COMPACTION = {
  maxContextTokens: SESSION_COMPACTION_TOKENS,
  belowPriceStep: true,
} as const satisfies SessionCompaction;

/**
 * The rule for the person's Settings choice: Automatic is the app's own; a
 * number is a ceiling that wins over price steps (the captain's answer on
 * INF-6693's plan); each model's limit states nothing, so Pi's trigger and
 * the Claude client's own window apply.
 */
export function summaryCompaction(point: SummaryPoint): SessionCompaction {
  if (point === "automatic") return SESSION_COMPACTION;
  if (point === "model") return {};
  return { maxContextTokens: point };
}

/**
 * The rule a spec carries now: a live one is read at each Pi prompt and when
 * a Claude session attaches, so a changed setting reaches a conversation
 * already open.
 */
export function compactionNow(
  compaction: SessionSpec["compaction"],
): SessionCompaction | undefined {
  return typeof compaction === "function" ? compaction() : compaction;
}
