import { type Card, FIRSTMATE_CARD_META } from "@shared/cards";
import { cardWordsMark, englishOf, said, saidMark } from "@shared/i18n/said";
import { CREW_WORK_META } from "./hostCards";
import { moveLoginAction, moveLoginSaid } from "./loginMove";

/**
 * The cards and buttons for a login that runs low (docs/quota.md, "When the
 * login in use runs low"): the crew's card for a provider's login in use,
 * and the first mate's while it runs on a login's credits.
 */

/** One card per provider: a second low login of it revises the card in place. */
export function loginLowCardId(providerId: string): string {
  return `card-login-low-${providerId}`;
}

/** The card's Wait for the refill action, which the low-login watch reads as its answer. */
export const LOGIN_LOW_WAIT = "wait-for-refill";

export type LoginLowCard = {
  providerId: string;
  providerName: string;
  /** The login running low: its account, and the name its row gives it. */
  accountId: string;
  login: string;
  /** Its percent left; absent once its allowance is spent. */
  percentLeft?: number;
  /** When its allowance refills, worded for a person, when known. */
  refills?: string;
  /** The login with the most room: where the click moves work. */
  other: { accountId: string; label: string };
  /** New work already runs across the logins: the click moves only running work. */
  spread?: boolean;
};

/**
 * The crew's card for a login that runs low while another login of its
 * provider has room: the login and its refill, a button for the login with
 * the most room, and Wait for the refill, which leaves work where it is.
 * Nothing moves until the click.
 */
export function loginLowCard(
  input: LoginLowCard,
): Omit<Card, "author" | "priority" | "status" | "createdAt"> {
  const title = said(
    input.percentLeft === undefined ? "cardLoginSpentTitle" : "cardLoginLowTitle",
    { login: input.login },
  );
  const move = moveLoginSaid(input.other.label);
  const wait = said("cardLoginLowWait");
  const sentences = [
    ...(input.percentLeft === undefined
      ? []
      : [said("cardLoginLowLeft", { percent: String(Math.round(input.percentLeft)) })]),
    ...(input.refills ? [said("cardLoginLowRefills", { when: input.refills })] : []),
    input.spread
      ? said("cardLoginLowSpreadOffer", { other: input.other.label, login: input.login })
      : said("cardLoginLowOffer", {
          other: input.other.label,
          login: input.login,
          provider: input.providerName,
        }),
  ];
  return {
    id: loginLowCardId(input.providerId),
    title: englishOf(title),
    meta: CREW_WORK_META,
    body: `${sentences.map((fact) => saidMark(fact)).join(" ")}${cardWordsMark([title, move, wait])}`,
    actions: [
      moveLoginAction(
        { who: "crew", from: input.accountId, accountId: input.other.accountId },
        input.other.label,
        true,
      ),
      { id: LOGIN_LOW_WAIT, label: englishOf(wait), variant: "secondary", declines: true },
    ],
  };
}

export const FIRSTMATE_ON_CREDITS_CARD_ID = "card-fm-on-credits";

/**
 * The first mate runs on a login's credits while another login of the same
 * provider has allowance left: the move it would make on its own under
 * `move`, asked instead. It keeps answering either way.
 */
export function firstmateOnCreditsCard(input: {
  accountId: string;
  login: string;
  other: { accountId: string; label: string };
}): Omit<Card, "author" | "priority" | "status" | "createdAt"> {
  const title = said("cardFirstMateOnCreditsTitle");
  const move = moveLoginSaid(input.other.label);
  const stay = said("cardFirstMateStayOnCredits", { login: input.login });
  return {
    id: FIRSTMATE_ON_CREDITS_CARD_ID,
    title: englishOf(title),
    meta: FIRSTMATE_CARD_META,
    body: `${saidMark(
      said("cardFirstMateOnCreditsBody", { login: input.login, other: input.other.label }),
    )}${cardWordsMark([title, move, stay])}`,
    actions: [
      moveLoginAction(
        { who: "firstmate", from: input.accountId, accountId: input.other.accountId },
        input.other.label,
        true,
      ),
      { id: "stay-on-credits", label: englishOf(stay), variant: "secondary", declines: true },
    ],
  };
}
