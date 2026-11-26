import { z } from "zod";
import type { ActionLine } from "./actions";
import { whenLoginLowValue } from "./settingValues";
import { whenLoginLowSchema } from "./whenLoginLow";

/**
 * The catalog line for what happens when the login in use runs low
 * (docs/quota.md, "When the login in use runs low"). It is at the own-words
 * tier, since `spread` and `move` change which of the captain's logins their
 * work runs on without a click, which a provider's terms may not allow.
 */
export const whenLoginLowLines = {
  "when-login-low": {
    area: "intelligence",
    tier: "own-words",
    change: "inf:settings:when-login-low:set",
    current: "inf:settings:when-login-low:get",
    value: z.strictObject({ choice: whenLoginLowSchema }),
    // i18n-exempt: served to the first mate, a model, never shown
    line: "Set what happens when a provider's login in use runs low (10% of its allowance left, or its allowance spent) while another of the captain's logins of that provider has room, only on typed captain words: wait never moves work between logins, ask (the default) puts up one card and moves on the captain's click, spread shares new work across the logins and asks before running work moves, move moves work on its own. Before setting spread or move, name the terms risk and set it only once the captain still asks: OpenAI's terms forbid switching accounts to get past a limit, and Anthropic's leave it unsaid. The login in use is account-prefer's preference.",
    toRequest: (v) => [v.choice],
    readValue: whenLoginLowValue,
    // i18n-exempt: served to the first mate, a model, never shown
    done: (v) => `when the login in use runs low: ${v.choice}`,
  },
} as const satisfies Record<string, ActionLine>;
