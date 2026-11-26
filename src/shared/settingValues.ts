import type { CostLimit } from "./costLimit";
import {
  type Appearance,
  ambientStyleIn,
  DEFAULT_AMBIENT_VOLUME,
  DEFAULT_APPEARANCE,
  type ShellPreferences,
  type UiSize,
} from "./preferences";
import type { WhenLoginLow } from "./whenLoginLow";

/**
 * The narrow value of a setting line, read from its `current` answer: the
 * first mate's `readValue` (src/shared/actions.ts) and a panel's
 * `settings.current` value (src/shared/panelSettings.ts) share each one, so
 * the two never read a setting differently.
 */
const look = (current: unknown) => current as Appearance;
/** The app's own look sets both, so neither reads as missing. */
const DEFAULT_WASH = DEFAULT_APPEARANCE.washStrength as number;
const DEFAULT_SIZE = DEFAULT_APPEARANCE.size as UiSize;

export const themeValue = (c: unknown) => ({ theme: look(c).theme });
export const fontsValue = (c: unknown) => ({ fonts: look(c).fonts ?? {} });
export const washValue = (c: unknown) => ({ strength: look(c).washStrength ?? DEFAULT_WASH });
export const sizeValue = (c: unknown) => ({ size: look(c).size ?? DEFAULT_SIZE });
export const crewModelNamesValue = (c: unknown) => ({
  visible: look(c).showCrewModelNames ?? true,
});
export const ambientMusicValue = (c: unknown) => ({
  on: look(c).ambientMusic ?? false,
  volume: look(c).ambientVolume ?? DEFAULT_AMBIENT_VOLUME,
  style: ambientStyleIn(look(c).ambientStyle, look(c).ambientOwnStyles),
});
/**
 * A person's own ambient styles by id and name, and which style plays: each
 * style is read whole only on demand (the `ambient.own-style` read), so
 * however many are saved they cost the first mate's context only their names.
 */
export const ambientOwnStylesValue = (c: unknown) => ({
  saved: (look(c).ambientOwnStyles ?? []).map(({ id, name }) => ({ id, name })),
  playing: ambientStyleIn(look(c).ambientStyle, look(c).ambientOwnStyles),
});
/**
 * The music's pause, which a panel reads beside the music's own value: always
 * false since the pause retired, kept so panels that read it still work.
 */
export const ambientPausedValue = (c: unknown) => ({ paused: look(c).ambientPaused ?? false });
export const enabledValue = (c: unknown) => ({ enabled: c as boolean });
export const whenLoginLowValue = (c: unknown) => ({ choice: c as WhenLoginLow });
/** Reads the limit alone from any answer that carries it, the app's cost limit view included. */
export const costLimitValue = (c: unknown) => ({ limit: (c as { limit: CostLimit }).limit });
export const panelsSwitchValue = (c: unknown) => ({
  enabled: (c as Pick<ShellPreferences, "panels">).panels.enabled,
});
