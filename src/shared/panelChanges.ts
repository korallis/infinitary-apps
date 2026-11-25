import type { ActionException } from "./actionCoverage";
import type { ActionName } from "./actions";

/**
 * Which settings a panel may change, by the action catalog's own lines
 * (primitives/app-actions.md, "A panel's changes"; docs/ui-plugins.md,
 * "Changing settings"): the host allowlist a panel's manifest `actions`
 * grant is read against. Every line answers: `true`, a panel granted it may
 * change it while the captain's own click or key is in the panel, or an excuse whose
 * ground comes from the catalog's closed set, as the first mate's do. A new
 * line answers here too, or the catalog does not compile.
 *
 * The grant covers how the app looks and sounds, and how work runs
 * (projects, models, accounts, automations), each named on the panel's
 * approval card. Nothing a panel may change uses a credential, answers a
 * consent card, deletes, or moves the first mate's record. Some of what it
 * may change does widen how far the app goes on its own, each by the
 * captain's choice of the setting on that card: a project's merging without
 * asking (`autonomy`) or with no checks required (`requireChecks`), a lifted
 * cost limit, and an automation's prompt, which runs as the captain's
 * scheduled words. Where a project's code lives or is pushed never changes
 * from a panel (`personal/panelChange.ts`).
 *
 * This file imports only types, so a panel's frame and the phone read the
 * names without the catalog itself.
 */
// i18n-exempt: coverage reasons, read by the coverage check and its tests, never shown
export const PANEL_CHANGES = {
  "project-setup": [
    "ruling",
    "Adding a project stays on its own setup card and Settings → Projects (FI3-1531)",
  ],
  "project-remove": ["destructive", "Takes a project off the list and ends its planned work"],
  "project-settings": true,
  "project-move": true,
  "project-name": true,
  "project-tags": [
    "destructive",
    "Removing a tag takes it off every task for good; tags are not panel data yet",
  ],
  "project-tag-check": [
    "not-a-setting",
    "Starts or stops a run of decision model requests; nothing is set",
  ],
  "project-runs-on": true,
  "device-invite": ["credential", "Makes a joining link for a new computer"],
  "private-site-allow": ["consent", "Widens what every task browser may reach"],
  "device-remove": ["destructive", "Removes a computer and the work it holds"],
  "device-update": ["other-computer", "Installs a new version on another computer"],
  "device-sign-in": ["credential", "Signs another computer in to a subscription"],
  "device-address": ["not-a-setting", "A link carries every address; nothing is chosen"],
  theme: true,
  font: true,
  panel: true,
  "voice-model": true,
  "account-sign-in": ["credential", "A provider's sign-in"],
  "custom-connection": ["credential", "A custom connection's key"],
  "decision-key": ["credential", "A decision model's key"],
  "panel-remove": ["destructive", "Removes a panel and its folder from the rail"],
  "task-actions": ["crew-only", "A panel moves tasks through its own moves grant"],
  settle: ["consent", "A merge or discard stays on its task's own card"],
  "card-close": ["consent", "Closing a card stays the captain's on that card"],
  "plugin-consent": ["consent", "A panel never answers its own or another panel's approval card"],
  recovery: ["consent", "Recovery buttons stay on the recovery card"],
  "ask-first-merge": ["consent", "An ask-first project's merge stays on its merge card"],
  "show-card": ["crew-only", "A panel brings a card forward through its own pointing"],
  "show-whats-new": true,
  direction: [
    "consent",
    "A standing direction instructs every agent; only the captain's words or the first mate write one",
  ],
  "start-at-login": true,
  "show-in-dock": true,
  "release-page": true,
  "integration-add": ["credential", "Connecting an integration signs in to it"],
  "integration-add-mcp": ["consent", "Runs a program the captain names on this computer"],
  "integration-remove": ["destructive", "Forgets an integration and its sign-in"],
  "delete-outside": ["destructive", "Deletes saved Gmail and Calendar content"],
  "integration-settings": true,
  "integration-action-rule": ["consent", "An action's allowance is the captain's consent"],
  "integration-key": ["credential", "An integration's key"],
  "integration-check": true,
  "forge-sign-out": ["credential", "Ends a project host's sign-in"],
  diagnostics: ["consent", "Diagnostics is the captain's consent to share"],
  contribution: ["consent", "Contribution is the captain's consent to share"],
  "sharing-ask": ["consent", "The sharing ask is the captain's own answer"],
  purge: ["destructive", "Erases this conversation"],
  "panels-switch": ["consent", "The panels switch is the captain's consent to run panels at all"],
  dictation: true,
  "firstmate-model": true,
  "firstmate-account": true,
  "crew-slots": true,
  "crew-speed": true,
  "crew-reasoning": true,
  "crew-slots-reset": true,
  "model-pins": true,
  "decision-model": true,
  "refresh-usage": true,
  "account-rename": true,
  "account-pause": true,
  "account-prefer": true,
  "account-keep-going": ["consent", "Keep going on credits spends money past the plan"],
  "account-use-reset": ["consent", "Spends one of an account's saved resets"],
  "account-use-saved-resets": [
    "consent",
    "Lets work spend an account's saved resets with no click",
  ],
  "account-disconnect": ["credential", "Forgets an account's sign-in"],
  "projects-folder": true,
  "custom-connection-file": true,
  "project-batch-answer": true,
  "cost-limit": true,
  "summary-point": true,
  notifications: true,
  runbook: true,
  "runbook-copy": true,
  "personal-resources": true,
  "window-wash": true,
  "window-size": true,
  "crew-model-names": true,
  "ambient-music": true,
  // Saves only: panelChange.ts refuses a panel's `remove`, since a panel never deletes.
  "ambient-own-style": true,
  "ambient-away": true,
  "card-size": true,
  language: true,
  "usage-unit": true,
  "key-reminders": [
    "window",
    "The key reminder is kept by each window's own program, which a panel's change does not reach",
  ],
  "panel-collapse": true,
  "automation-edit": true,
  "automation-state": true,
  "automation-pause-all": true,
  "automation-notes": ["crew-only", "An automation's notes are written by its run's crewmate"],
  "automation-delete": ["destructive", "Deletes an automation and its run history"],
  "kept-job-remove": ["destructive", "Runs a kept job's remove"],
  "device-change-address": ["other-computer", "Changes how this computer reaches another"],
  "home-move": ["other-computer", "Moves the first mate's whole record to another computer"],
  "standby-keep": ["other-computer", "Keeps a copy of the record on another computer"],
  "device-forge-sign-in": ["credential", "Signs another computer in to GitHub"],
  "keep-home": ["other-computer", "Chooses which of two first mates keeps the record"],
  "kept-job-forget": ["destructive", "Forgets a kept job whose remove did not finish"],
  "secrets-page": ["credential", "Secrets stay in Settings → Secrets"],
  "show-task": ["crew-only", "A panel opens a task's record through its own pointing"],
  "show-settings": ["crew-only", "A panel opens Settings through its own pointing"],
  "update-channel": true,
  "update-check": true,
  "inbox-link": true,
  "panel-retry": [
    "consent",
    "Starting a panel's stopped background work again is the captain's call on that panel",
  ],
  "panel-ask-again": ["consent", "A panel's integration ask is answered on its own card"],
  "decision-use-off": true,
  "private-site-remove": true,
  "secret-end-read": ["credential", "A permission to read secrets"],
  "device-keep": true,
  "home-move-cancel": true,
  "copy-stop": true,
  "device-fix-work": true,
  "device-try-again": true,
  "kept-job-check": true,
} as const satisfies { [N in ActionName]: true | ActionException };

/** Every catalog line a panel may be granted, in the catalog's own spelling. */
export type PanelChangeName = {
  [N in keyof typeof PANEL_CHANGES]: (typeof PANEL_CHANGES)[N] extends true ? N : never;
}[keyof typeof PANEL_CHANGES];

/** The allowlist as a list, for a manifest's check and a host's support. */
export const PANEL_CHANGE_NAMES: readonly PanelChangeName[] = (
  Object.keys(PANEL_CHANGES) as (keyof typeof PANEL_CHANGES)[]
).filter((name): name is PanelChangeName => PANEL_CHANGES[name] === true);

export function isPanelChange(name: string): name is PanelChangeName {
  return (PANEL_CHANGE_NAMES as readonly string[]).includes(name);
}
