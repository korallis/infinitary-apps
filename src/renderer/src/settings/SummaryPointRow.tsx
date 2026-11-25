import * as m from "@shared/i18n/messages.generated";
import { type SummaryPoint, summaryPointSchema } from "@shared/summaryPoint";
import { useEffect } from "react";
import { FIRSTMATE_SELECT_STYLE } from "./GeneralTab";
import { SETTINGS_QUIET_TEXT, SettingRow } from "./settingRows";
import {
  SUMMARY_POINT_WORDS,
  summaryPointChoices,
  summaryPointDescription,
  summaryPointSteps,
} from "./summaryPointWords";
import { useSettingSave } from "./useSettingSave";

/**
 * Where the first mate's and the crew's long conversations summarize
 * (docs/firstmate-runaway-hardening.md, "Conversation length"): Automatic,
 * a number of tokens, or each model's own limit. A native select, so Tab
 * reaches it and the arrows or a first letter pick a point.
 */
export function SummaryPointRow() {
  const save = useSettingSave(() => window.infinitary.settings.getSummaryPoint());
  useEffect(() => {
    void save.refresh();
  }, [save.refresh]);
  const view = save.value;
  const steps = summaryPointSteps(view);
  return (
    <SettingRow
      id="summary-point"
      error={save.error}
      title={SUMMARY_POINT_WORDS.title}
      description={summaryPointDescription(view)}
      detail={
        steps ? (
          <div
            data-summary-point-steps=""
            style={{ fontSize: "var(--text-sm)", color: SETTINGS_QUIET_TEXT }}
          >
            {steps}
          </div>
        ) : null
      }
      control={
        <select
          aria-label={SUMMARY_POINT_WORDS.title}
          value={view ? String(view.point) : ""}
          disabled={view === null || save.saving}
          onChange={(event) => {
            const parsed = summaryPointSchema.safeParse(choiceValue(event.target.value));
            if (!parsed.success || parsed.data === view?.point) return;
            const point: SummaryPoint = parsed.data;
            // The core refuses only a point this build does not offer, so a
            // refusal carries no reason worth showing beyond the catalog's words.
            void save.save(() =>
              window.infinitary.settings.setSummaryPoint(point).catch(() => {
                throw new Error(m.settingsSummaryPointSaveFailed());
              }),
            );
          }}
          style={FIRSTMATE_SELECT_STYLE}
        >
          {view === null ? <option value="" /> : null}
          {summaryPointChoices().map((choice) => (
            <option key={String(choice.point)} value={String(choice.point)}>
              {choice.label}
            </option>
          ))}
        </select>
      }
    />
  );
}

/** An option's value is its point as text: a number of tokens, or a word. */
function choiceValue(value: string): unknown {
  return /^\d+$/.test(value) ? Number(value) : value;
}
