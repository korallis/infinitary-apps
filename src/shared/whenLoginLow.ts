import { z } from "zod";

/**
 * What Infinitary does when the login in use runs low (docs/quota.md, "When
 * the login in use runs low"): `wait` never moves work between a provider's
 * logins, `ask` puts up one card and moves on the captain's click, `spread`
 * shares new work across the logins and asks before running work moves, and
 * `move` moves work on its own.
 */
export const WHEN_LOGIN_LOW = ["wait", "ask", "spread", "move"] as const;
export const whenLoginLowSchema = z.enum(WHEN_LOGIN_LOW);
export type WhenLoginLow = z.infer<typeof whenLoginLowSchema>;

/** Every install starts here: work moves to another login only on a click. */
export const WHEN_LOGIN_LOW_DEFAULT: WhenLoginLow = "ask";

/** Whether new work runs on the login in use alone: no other login serves it unasked. */
export function servesOnlyLoginInUse(choice: WhenLoginLow): boolean {
  return choice === "wait" || choice === "ask";
}
