import type { ActionName } from "./actions";
import type { PanelSettingName } from "./panelSettingNames";
import {
  ambientMusicValue,
  ambientPausedValue,
  costLimitValue,
  crewModelNamesValue,
  enabledValue,
  fontsValue,
  panelsSwitchValue,
  sizeValue,
  themeValue,
  washValue,
} from "./settingValues";
import type { SummaryPointView } from "./summaryPoint";

/**
 * Why an action catalog line has no panel value, so `settings.current`
 * refuses it: one ground from this closed set for every such line.
 */
// i18n-exempt: a developer's reason for each ground, never shown to a person
export const PANEL_UNREADABLE = {
  act: "an act, a hand-over or a card: it holds no setting to read",
  names:
    "its value names projects, folders, computers, accounts, sign-ins, sites, integrations, runbooks, directions or an install",
  layout: "its value places every panel, not only the panel reading it",
  home: "only the computer that holds it reads it, never a view of it",
  read: "a panel reads it through a read of its own (quota.snapshot, automation.list or automation.kept)",
  unchecked: "how the crew's models are chosen: not yet checked field by field for a panel",
  own: "a person's own ambient styles, in their own words: read by the first mate and Settings, not yet offered to a panel",
  later:
    "a Settings line the first mate gained beside settings.current: not yet checked field by field for a panel",
} as const;
export type PanelUnreadable = keyof typeof PANEL_UNREADABLE;

/**
 * What a panel reads of one catalog line: its panel value, read from the
 * line's own `current` answer as `readValue` reads it for the first mate,
 * but cut to what a panel may see; or the ground it is unreadable on.
 */
export type PanelSetting =
  | { value: (current: unknown) => Record<string, unknown> }
  | { unreadable: PanelUnreadable };

// Each panel value is the line's own `readValue` projector (src/shared/settingValues.ts).
const readable = {
  theme: { value: themeValue },
  font: { value: fontsValue },
  "window-wash": { value: washValue },
  "window-size": { value: sizeValue },
  "crew-model-names": { value: crewModelNamesValue },
  // A momentary hush stays inside the window; a pause is saved, so it reads.
  "ambient-music": { value: (c) => ({ ...ambientMusicValue(c), ...ambientPausedValue(c) }) },
  notifications: { value: enabledValue },
  "cost-limit": { value: costLimitValue },
  "summary-point": { value: (c) => ({ point: (c as SummaryPointView).point }) },
  "personal-resources": { value: enabledValue },
  "panels-switch": { value: panelsSwitchValue },
} satisfies Record<PanelSettingName, PanelSetting>;

/** The value each readable line answers, as the core builds it. */
export type PanelSettingValuesRead = {
  [K in PanelSettingName]: ReturnType<(typeof readable)[K]["value"]>;
};

/**
 * Every action catalog line, with what a panel may read of it
 * (primitives/live-reads.md, "settings.current"). A line added to the
 * catalog does not compile until it is named here: a panel value, or a
 * ground from `PANEL_UNREADABLE`.
 */
export const PANEL_SETTINGS: Record<ActionName, PanelSetting> = {
  ...readable,
  "project-setup": { unreadable: "names" },
  "project-remove": { unreadable: "names" },
  "project-settings": { unreadable: "names" },
  "project-move": { unreadable: "names" },
  "project-name": { unreadable: "names" },
  "project-tags": { unreadable: "names" },
  "project-tag-check": { unreadable: "act" },
  "project-runs-on": { unreadable: "names" },
  "device-invite": { unreadable: "names" },
  "private-site-allow": { unreadable: "names" },
  "device-remove": { unreadable: "names" },
  "device-update": { unreadable: "names" },
  "device-sign-in": { unreadable: "names" },
  "device-address": { unreadable: "act" },
  "device-change-address": { unreadable: "names" },
  "device-forge-sign-in": { unreadable: "names" },
  "home-move": { unreadable: "names" },
  "standby-keep": { unreadable: "names" },
  "keep-home": { unreadable: "names" },
  panel: { unreadable: "layout" },
  "voice-model": { unreadable: "home" },
  "account-sign-in": { unreadable: "act" },
  "custom-connection": { unreadable: "act" },
  "decision-key": { unreadable: "act" },
  "panel-remove": { unreadable: "act" },
  "task-actions": { unreadable: "act" },
  settle: { unreadable: "act" },
  "card-close": { unreadable: "act" },
  "plugin-consent": { unreadable: "act" },
  recovery: { unreadable: "act" },
  "ask-first-merge": { unreadable: "act" },
  "show-card": { unreadable: "act" },
  "show-task": { unreadable: "act" },
  "show-settings": { unreadable: "act" },
  "secrets-page": { unreadable: "act" },
  "show-whats-new": { unreadable: "home" },
  direction: { unreadable: "names" },
  "start-at-login": { unreadable: "home" },
  "show-in-dock": { unreadable: "home" },
  "release-page": { unreadable: "home" },
  "integration-add": { unreadable: "names" },
  "integration-add-mcp": { unreadable: "names" },
  "integration-remove": { unreadable: "names" },
  "delete-outside": { unreadable: "names" },
  "integration-settings": { unreadable: "names" },
  "integration-action-rule": { unreadable: "names" },
  "integration-key": { unreadable: "act" },
  "integration-check": { unreadable: "names" },
  "forge-sign-out": { unreadable: "names" },
  diagnostics: { unreadable: "names" },
  contribution: { unreadable: "names" },
  "sharing-ask": { unreadable: "names" },
  purge: { unreadable: "act" },
  dictation: { unreadable: "home" },
  "ambient-own-style": { unreadable: "own" },
  "firstmate-model": { unreadable: "unchecked" },
  "firstmate-account": { unreadable: "names" },
  "crew-slots": { unreadable: "unchecked" },
  "crew-speed": { unreadable: "unchecked" },
  "crew-reasoning": { unreadable: "unchecked" },
  "crew-slots-reset": { unreadable: "unchecked" },
  "model-pins": { unreadable: "unchecked" },
  "decision-model": { unreadable: "unchecked" },
  "refresh-usage": { unreadable: "read" },
  "account-rename": { unreadable: "names" },
  "account-pause": { unreadable: "names" },
  "account-prefer": { unreadable: "names" },
  "account-keep-going": { unreadable: "names" },
  "account-disconnect": { unreadable: "names" },
  "account-use-reset": { unreadable: "names" },
  "account-use-saved-resets": { unreadable: "names" },
  "projects-folder": { unreadable: "names" },
  "custom-connection-file": { unreadable: "names" },
  "project-batch-answer": { unreadable: "names" },
  runbook: { unreadable: "names" },
  "runbook-copy": { unreadable: "names" },
  "panel-collapse": { unreadable: "layout" },
  "automation-edit": { unreadable: "read" },
  "automation-state": { unreadable: "read" },
  "automation-pause-all": { unreadable: "read" },
  "automation-notes": { unreadable: "read" },
  "automation-delete": { unreadable: "read" },
  "kept-job-remove": { unreadable: "read" },
  "kept-job-forget": { unreadable: "read" },
  "ambient-away": { unreadable: "later" },
  "card-size": { unreadable: "later" },
  language: { unreadable: "later" },
  "usage-unit": { unreadable: "later" },
  "key-reminders": { unreadable: "later" },
  "update-channel": { unreadable: "home" },
  "update-check": { unreadable: "act" },
  "inbox-link": { unreadable: "act" },
  "panel-retry": { unreadable: "act" },
  "panel-ask-again": { unreadable: "act" },
  "home-move-cancel": { unreadable: "act" },
  "copy-stop": { unreadable: "names" },
  "device-keep": { unreadable: "names" },
  "device-fix-work": { unreadable: "names" },
  "device-try-again": { unreadable: "names" },
  "private-site-remove": { unreadable: "names" },
  "secret-end-read": { unreadable: "names" },
  "kept-job-check": { unreadable: "read" },
  "decision-use-off": { unreadable: "unchecked" },
};

/** The panel value of each named line from its `current` answer, by that answer's channel. */
export async function panelSettingsNow(
  names: readonly PanelSettingName[],
  readCurrent: (name: PanelSettingName) => Promise<unknown>,
): Promise<Record<string, Record<string, unknown>>> {
  const answer: Record<string, Record<string, unknown>> = {};
  for (const name of new Set(names)) answer[name] = readable[name].value(await readCurrent(name));
  return answer;
}
