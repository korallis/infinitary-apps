import type { CardAction } from "@shared/cards";
import { englishOf, type Said, said } from "@shared/i18n/said";

/**
 * The button that moves work to another login of the same provider
 * (docs/quota.md, "When the login in use runs low"), and its one host
 * operation, `move-login`, whose argument names who moves and where.
 */

const CREW_PREFIX = "crew:";
const FIRSTMATE_PREFIX = "firstmate:";

/** Who a `move-login` click moves, and the login it moves to. */
export type LoginMove = { who: "crew" | "firstmate"; accountId: string };

export function loginMoveArg(move: LoginMove): string {
  return `${move.who === "crew" ? CREW_PREFIX : FIRSTMATE_PREFIX}${move.accountId}`;
}

/** What a `move-login` argument asks, else undefined. */
export function loginMoveOf(arg: string): LoginMove | undefined {
  if (arg.startsWith(CREW_PREFIX)) return { who: "crew", accountId: arg.slice(CREW_PREFIX.length) };
  if (arg.startsWith(FIRSTMATE_PREFIX))
    return { who: "firstmate", accountId: arg.slice(FIRSTMATE_PREFIX.length) };
  return undefined;
}

/** The button's words; a card that carries it carries the fact too (`cardWordsMark`). */
export function moveLoginSaid(login: string): Said {
  return said("cardLoginLowMove", { login });
}

export function moveLoginAction(move: LoginMove, label: string, primary: boolean): CardAction {
  return {
    id: "move-login",
    label: englishOf(moveLoginSaid(label)),
    variant: primary ? "primary" : "secondary",
    ...(primary ? { default: true } : {}),
    effect: { kind: "host", op: "move-login", arg: loginMoveArg(move) },
  };
}
