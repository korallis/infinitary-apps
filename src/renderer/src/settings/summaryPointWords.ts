import { formatList, formatNumber } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
import {
  type PriceStep,
  SUMMARY_POINT_TOKENS,
  type SummaryPoint,
  type SummaryPointView,
  stepsPassed,
} from "@shared/summaryPoint";

/** The app's own point, which Automatic names; the core's `SESSION_COMPACTION_TOKENS`. */
const AUTOMATIC_TOKENS = 300_000;

/** Settings → Intelligence's summary point row (`SummaryPointRow.tsx`; INF-6693). */
export const SUMMARY_POINT_WORDS = {
  get title() {
    return m.settingsSummaryPointTitle();
  },
} as const;

/** The select's choices in order, each with the words it shows. */
export function summaryPointChoices(): { point: SummaryPoint; label: string }[] {
  return [
    { point: "automatic", label: m.settingsSummaryPointAutomatic() },
    ...SUMMARY_POINT_TOKENS.map((tokens) => ({
      point: tokens,
      label: m.settingsSummaryPointTokens({ tokens: formatNumber(tokens) }),
    })),
    { point: "model", label: m.settingsSummaryPointModelLimit() },
  ];
}

/** What the row says under its title: where conversations summarize. */
export function summaryPointDescription(view: SummaryPointView | null): string {
  if (!view) return m.settingsSummaryPointDescriptionUnread();
  const { point } = view;
  if (point === "automatic")
    return m.settingsSummaryPointDescriptionAutomatic({ tokens: formatNumber(AUTOMATIC_TOKENS) });
  if (point === "model") return m.settingsSummaryPointDescriptionModelLimit();
  return m.settingsSummaryPointDescriptionTokens({ tokens: formatNumber(point) });
}

/**
 * The models on the person's accounts that charge more past the chosen
 * point, since a chosen number wins over a price step (the captain's answer
 * on INF-6693's plan); nothing when none does.
 */
export function summaryPointSteps(view: SummaryPointView | null): string | null {
  const passed: PriceStep[] = view ? stepsPassed(view.point, view.steps) : [];
  if (passed.length === 0) return null;
  return m.settingsSummaryPointSteps({
    models: formatList(
      passed.map((step) =>
        m.settingsSummaryPointStep({ name: step.name, tokens: formatNumber(step.tokens) }),
      ),
    ),
  });
}
