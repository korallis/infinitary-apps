import { z } from "zod";

/**
 * The app settings a panel may read through `settings.current`
 * (primitives/live-reads.md): the action catalog's lines that carry a panel
 * value (`PANEL_SETTINGS`, src/shared/panelSettings.ts), by their catalog
 * names. Kept in a file of its own, with nothing but zod, so the core
 * request's schema (src/shared/channels/settings.ts) can name them without
 * loading the catalog; `panelSettings.test.ts` holds the two lists equal.
 */
export const PANEL_SETTING_NAMES = [
  "theme",
  "font",
  "window-wash",
  "window-size",
  "crew-model-names",
  "ambient-music",
  "notifications",
  "cost-limit",
  "summary-point",
  "personal-resources",
  "panels-switch",
] as const;
export type PanelSettingName = (typeof PANEL_SETTING_NAMES)[number];
export const panelSettingNameSchema = z.enum(PANEL_SETTING_NAMES);

/** The names a panel asks `settings.current` for: at least one. */
export const panelSettingNamesSchema = z
  .array(panelSettingNameSchema)
  .min(1)
  .max(PANEL_SETTING_NAMES.length);
