import { escapeHtml } from "@shared/cardBodyMarkup";
import { type Card, type CardAction, FIRSTMATE_CARD_META } from "@shared/cards";
import {
  CLAUDE_ACCESS_PAUSE_TITLE,
  CLAUDE_ACCESS_SIGN_IN_TITLE,
  CLAUDE_ACCESS_TRY_AGAIN_LABEL,
  type ClaudeAccessSource,
} from "@shared/claudeAccess";
import { NEEDS_REAUTH_CONSEQUENCE, restoreAccountEffect } from "@shared/credentialHealth";
import { HERE } from "@shared/deviceNames";
import { deviceForgeSignInBody, deviceForgeSignInTitle } from "@shared/deviceSetup";
import {
  forgeCliRefusedText,
  forgeRefusedText,
  forgeSignInTitle,
  LOCAL_PROJECTS_UNAFFECTED,
} from "@shared/forges";
import { cardWordsMark, englishOf, type Said, said, saidMark } from "@shared/i18n/said";
import { INTEGRATIONS_WORDS } from "@shared/integrations";
import { SAVED_RESETS_PAGE } from "@shared/quota";
import { moveLoginAction } from "./loginMove";
import type { SeatPauseClass } from "./seat";

/**
 * The cards the host itself puts up (docs/card-authoring.md): the first
 * mate's pause, move-back, quiet and failure cards, the sign-in cards for a
 * provider, a project's host and a computer that runs work, and an app
 * note. Each is built here from the host's own words; the card stack
 * (`CardService`) decides when one goes up, keeps its place and takes it
 * down.
 */

/** The host's own decisions sit above every agent's card; its notes below every decision. */
export const HOST_CARD_PRIORITY = 40;
const HOST_NOTE_PRIORITY = 25;

/** The paused seat's cards (W1 S9): the move offer, the refusal, and the rest. */
const FIRSTMATE_MOVE_CARD_ID = "card-fm-flagship-move";
const FIRSTMATE_REFUSED_CARD_ID = "card-fm-refused";
export const FIRSTMATE_BENCH_CARD_ID = "card-fm-no-headroom";
export const FIRSTMATE_MOVE_BACK_CARD_ID = "card-fm-move-back";
export const FIRSTMATE_PAUSE_CARD_IDS = [
  FIRSTMATE_MOVE_CARD_ID,
  FIRSTMATE_REFUSED_CARD_ID,
  FIRSTMATE_BENCH_CARD_ID,
] as const;
export const FIRSTMATE_QUIET_CARD_ID = "card-fm-quiet";
/** The Firstmate failure card (the agent-down set): Retry, until a turn ends clean. */
export const FIRSTMATE_FAILURE_CARD_ID = "card-fm-turn-failure";
export const FIRSTMATE_FAILURE_TITLE = "Your first mate hit a problem";

export type FirstmatePauseCard = {
  pause: SeatPauseClass;
  /** What stopped the seat and what happens now, in the user's words. */
  body: string;
  /** The paused account, for its way back (sign in again, try again). */
  accountId?: string;
  providerName: string;
  /** Rung 2: where the seat could move, asked on the card. */
  move?: { providerId: string; providerName: string };
  /**
   * Another login of the same provider has room and the choice for a low
   * login asks (docs/quota.md, "When the login in use runs low"): the card
   * offers the move the ladder would otherwise make on its own.
   */
  login?: { accountId: string; label: string };
  /** A spent allowance is being read again: no second recheck is offered. */
  checking?: boolean;
  /**
   * The captain's recheck read the spent allowance unchanged: the card
   * offers one attempt beside another recheck (`spentAttemptArg`), for a
   * login the reading does not see, such as a token the client's launcher
   * passes.
   */
  attempt?: boolean;
  /**
   * The provider says the paused account has credits and its Keep going on
   * credits switch is off (docs/quota.md): the card offers to turn it on.
   */
  credits?: { usedPercent?: number; balance?: string };
  /**
   * The paused account has saved Codex resets that would apply now
   * (docs/codex-client.md): the card offers to use one.
   */
  savedResets?: boolean;
  /**
   * Where the paused account's Claude access comes from when it is not a
   * subscription: a lost sign-in is then renewed where Claude Code's is.
   */
  access?: ClaudeAccessSource;
};

/** A pause card's attempt on the paused account: a refusal's, or a spent allowance's after a recheck. */
function tryAgainLabel(providerName: string): string {
  return `Try ${providerName} again`;
}

/**
 * The spent-allowance card's attempt, on the same `try-again` op as its
 * recheck: its argument names the account under this prefix, which no
 * account id carries, so the seat tells the two apart (`spentAttemptOf`).
 */
const SPENT_ATTEMPT_PREFIX = "attempt:";

export function spentAttemptArg(accountId: string): string {
  return `${SPENT_ATTEMPT_PREFIX}${accountId}`;
}

/** The account a `try-again` argument attempts past its spent allowance, else undefined. */
export function spentAttemptOf(arg: string): string | undefined {
  return arg.startsWith(SPENT_ATTEMPT_PREFIX) ? arg.slice(SPENT_ATTEMPT_PREFIX.length) : undefined;
}

/** The spent-allowance card's way back: read the allowance again. */
export const RECHECK_ALLOWANCE_LABEL = "Recheck allowance";

/** The meta line of a card about the crew's allowance, where a task's card names its task. */
export const CREW_WORK_META = "Crew work";

/** A run-out card's offer to spend the account's credits (docs/quota.md). */
export const KEEP_GOING_ON_CREDITS_LABEL = "Keep going on credits";

/** What a run-out card says of the credits it offers, as one sentence. */
export function creditsOfferSentence(credits: { usedPercent?: number; balance?: string }): string {
  if (credits.usedPercent !== undefined)
    return `Extra usage is on for this account; ${Math.round(credits.usedPercent)}% of your monthly limit is used.`;
  if (credits.balance !== undefined)
    return `This account has credits past its allowance: ${credits.balance} left.`;
  return "This account has credits past its allowance.";
}

/** The run-out card's action that turns an account's Keep going on credits switch on. */
export function keepGoingAction(accountId: string, primary: boolean): CardAction {
  return {
    id: "keep-going-on-credits",
    label: KEEP_GOING_ON_CREDITS_LABEL,
    variant: primary ? "primary" : "secondary",
    ...(primary ? { default: true } : {}),
    effect: { kind: "host", op: "keep-going-on-credits", arg: accountId },
  };
}

/** A card's offer to use one of the account's saved Codex resets (docs/codex-client.md). */
const USE_SAVED_RESET_SAID = said("cardUseSavedReset");

/**
 * The action that uses one of an account's saved resets, by its key
 * (`accountKey`): at once when Codex keeps a sign-in for it, else on the
 * account's row, where Codex signs in first (`use-saved-reset`).
 */
export function redeemSavedResetAction(accountKey: string, primary: boolean): CardAction {
  return {
    id: "use-saved-reset",
    label: englishOf(USE_SAVED_RESET_SAID),
    variant: primary ? "primary" : "secondary",
    ...(primary ? { default: true } : {}),
    effect: { kind: "host", op: "use-saved-reset", arg: accountKey },
  };
}

/** A run-out card's offer to turn on Use saved resets on their own (docs/quota.md). */
const USE_SAVED_RESETS_SAID = said("cardUseSavedResets");

/**
 * The action that turns on an account's Use saved resets on their own, by
 * its key: at once when Codex keeps a sign-in for it, else on the account's
 * row, where Codex signs in first (`auto-saved-resets`).
 */
export function autoResetsAction(accountKey: string): CardAction {
  return {
    id: "use-saved-resets",
    label: englishOf(USE_SAVED_RESETS_SAID),
    variant: "secondary",
    effect: { kind: "host", op: "use-saved-resets", arg: accountKey },
  };
}

/** A crewmate's sign-in card's title, and the Firstmate's own on a 401. */
export const PROVIDER_SIGN_IN_TITLE = "A provider needs sign in";

export const FIRSTMATE_NO_PROVIDER_SIGN_IN_WORDS =
  "Your first mate needs a signed-in subscription to answer - Codex, Grok, Claude, Kimi Code or Copilot, OpenRouter with an API key, or Amazon Bedrock with your AWS sign-in.";

/** A move's button: a paused seat's names a provider, a crewmate's sign-in card the model. */
export function moveLabel(to: string): string {
  return `Move to ${to}`;
}

/** A paused seat's card title: what stopped it, never how. */
export function firstmatePauseTitle(pause: SeatPauseClass, providerName: string): string {
  switch (pause) {
    case "no_headroom":
      return "Your first mate has used up its allowance";
    case "signed_out":
      return "Your first mate needs you to sign in again";
    case "refused":
      return `${providerName} is not answering your first mate right now`;
    case "client":
      return `Your first mate cannot run on ${HERE.this} right now`;
    case "unavailable":
      return "Your first mate needs an account";
  }
}

/** A card the host puts up, before the stack dates it. */
type HostCard = Omit<Card, "createdAt">;

/**
 * The host's own card, the one builder every card here goes through: the
 * host is its author, a note (no choice to make) sits below every decision,
 * and it is ready as it goes up.
 */
export function hostCard(
  card: Omit<Card, "author" | "priority" | "status" | "createdAt">,
  options: { note?: boolean } = {},
): HostCard {
  return {
    ...card,
    author: "host",
    priority: options.note ? HOST_NOTE_PRIORITY : HOST_CARD_PRIORITY,
    status: "ready",
  };
}

/**
 * Which pause card a pause asks on: with a place to move (rung 2) it asks
 * to move under `card-fm-flagship-move`; without one (rung 3) it says the
 * seat waits, under `card-fm-refused` for a refusal and
 * `card-fm-no-headroom` for the rest.
 */
export function firstmatePauseCardId(input: FirstmatePauseCard): string {
  return input.move
    ? FIRSTMATE_MOVE_CARD_ID
    : input.pause === "refused"
      ? FIRSTMATE_REFUSED_CARD_ID
      : FIRSTMATE_BENCH_CARD_ID;
}

/**
 * The Firstmate's pause card (W1 S9; docs/architecture.md §16 "A paused
 * seat"): one card for one pause, titled for what stopped the seat. With
 * a place to move it asks to move - a cross-provider move is a model
 * change, so it always asks. Either way it carries the class's own way
 * back: "Sign in" for a lost sign-in (a captain click only; nothing signs
 * in on its own) and "Try again" for a refusal (`try-again`, the only way a
 * refusal clears on the captain's word). Nothing moves or retries until a
 * click. Its one primary is its default, so the footer draws it at the
 * right edge.
 */
export function firstmatePauseCard(id: string, input: FirstmatePauseCard): HostCard {
  return hostCard({
    id,
    title:
      input.pause === "signed_out" && input.access
        ? CLAUDE_ACCESS_PAUSE_TITLE
        : firstmatePauseTitle(input.pause, input.providerName),
    meta: FIRSTMATE_CARD_META,
    body: input.body,
    actions: firstmatePauseActions(input),
  });
}

function firstmatePauseActions(input: FirstmatePauseCard): CardAction[] {
  // A spent allowance is read again on the captain's word - after a switch
  // to another login elsewhere, say - and that is the card's default; a
  // move or Settings stays beside it.
  if (input.pause === "no_headroom" && input.accountId && !input.checking) {
    // Credits the account already has come first: one click keeps it going.
    const credits = input.credits !== undefined;
    const login = input.login;
    return [
      ...(login
        ? [
            moveLoginAction(
              { who: "firstmate", from: input.accountId, accountId: login.accountId },
              login.label,
              true,
            ),
          ]
        : []),
      ...(credits ? [keepGoingAction(input.accountId, !login)] : []),
      ...(input.savedResets ? [redeemSavedResetAction(input.accountId, false)] : []),
      {
        id: "recheck-allowance",
        label: RECHECK_ALLOWANCE_LABEL,
        variant: credits || login ? "secondary" : "primary",
        ...(credits || login ? {} : { default: true }),
        effect: { kind: "host", op: "try-again", arg: input.accountId },
      },
      ...(input.attempt
        ? [
            {
              id: "try-again",
              label: tryAgainLabel(input.providerName),
              variant: "secondary" as const,
              effect: {
                kind: "host" as const,
                op: "try-again" as const,
                arg: spentAttemptArg(input.accountId),
              },
            },
          ]
        : []),
      input.move
        ? {
            id: "move-flagship",
            label: moveLabel(input.move.providerName),
            variant: "secondary",
            effect: { kind: "host", op: "move-flagship", arg: input.move.providerId },
          }
        : {
            id: "open-settings",
            label: "Open settings",
            variant: "secondary",
            effect: { kind: "open", target: "settings" },
          },
    ];
  }
  const wayBack: CardAction[] =
    input.pause === "refused" && input.accountId
      ? [
          {
            id: "try-again",
            label: tryAgainLabel(input.providerName),
            variant: input.move ? "secondary" : "primary",
            ...(input.move ? {} : { default: true }),
            effect: { kind: "host", op: "try-again", arg: input.accountId },
          },
        ]
      : input.pause === "signed_out" && input.accountId
        ? [
            {
              id: "sign-in",
              // The access's way back checks it again and opens nothing,
              // as the account row's own button does.
              label: input.access ? CLAUDE_ACCESS_TRY_AGAIN_LABEL : "Sign in",
              variant: input.move ? "secondary" : "primary",
              ...(input.move ? {} : { default: true }),
              effect: restoreAccountEffect(input.accountId),
            },
          ]
        : [];
  return input.move
    ? [
        {
          id: "move-flagship",
          label: moveLabel(input.move.providerName),
          variant: "primary",
          default: true,
          effect: { kind: "host", op: "move-flagship", arg: input.move.providerId },
        },
        ...wayBack,
      ]
    : [
        ...wayBack,
        ...(wayBack.length === 0 || input.pause === "refused"
          ? [
              {
                id: "open-settings",
                label: "Open settings",
                variant: wayBack.length === 0 ? ("primary" as const) : ("secondary" as const),
                ...(wayBack.length === 0 ? { default: true } : {}),
                effect: { kind: "open" as const, target: "settings" as const },
              },
            ]
          : []),
      ];
}

/**
 * The crew's run-out card for one account (docs/quota.md "Keep going on
 * credits"); `deviceId` names the computer that runs work it is on.
 */
export function creditsOfferCardId(accountId: string, deviceId?: string): string {
  return deviceId
    ? `card-credits-offer-${deviceId}-${accountId}`
    : `card-credits-offer-${accountId}`;
}

/**
 * A spent account's saved resets on its run-out card (docs/quota.md, "Saved
 * resets"): how many would refill its allowance now, and a link to the
 * provider's usage page, where the captain can use one without Infinitary;
 * the card's Use a saved reset uses one through Codex (docs/codex-client.md),
 * and these words carry its label's fact, with any other button's in `labels`
 * (one mark holds a card's labels). Empty for a provider with no such page.
 */
export function savedResetsWords(
  input: { account: string; provider: string; count: number },
  labels: readonly Said[] = [],
) {
  const page = SAVED_RESETS_PAGE[input.provider];
  if (!page || input.count < 1) return "";
  const now = saidMark(said("cardSavedResetsNow", { account: input.account, count: input.count }));
  const link = saidMark(
    said("cardSavedResetsOpenPage", { site: new URL(page).host }),
    "a",
    `href="${page}"`,
  );
  return `${now} ${link}${cardWordsMark([USE_SAVED_RESET_SAID, ...labels])}`;
}

/**
 * The crew's run-out card (INF-4104 piece 2): crew work would drop to a
 * weaker model or wait because an account's allowance is spent, while its
 * provider says the account has credits and its Keep going on credits
 * switch is off. Its one choice turns the switch on; the app's Decline
 * leaves it off. The host raises it once per account until its allowance answers again.
 */
export function creditsOfferCard(input: {
  accountId: string;
  /** The account, as its row names it: provider and label. */
  name: string;
  /** When its allowance resets, in clock time, when known. */
  resetsAt?: string;
  /** Its credits past the allowance, when its provider says it has some and the switch is off. */
  credits?: { usedPercent?: number; balance?: string };
  /** Saved resets that would apply now, by its provider and count (`savedResetsWords`). */
  savedResets?: { provider: string; count: number };
  /**
   * The account's Use saved resets on their own is off and can be turned on
   * where it is (docs/quota.md): the card offers it beside the reset.
   */
  offerAutoResets?: boolean;
  /**
   * The computer that runs work the account is on, by id and as words say
   * where ("on Mac mini"): its switch is saved there, so the button sends
   * the account's key there (`accountKey`, src/core/placed/placedAccounts.ts).
   */
  computer?: { deviceId: string; where: string };
}): Omit<Card, "author" | "priority" | "status" | "createdAt"> {
  const { computer } = input;
  const until = input.resetsAt ? ` until ${input.resetsAt}` : "";
  const resetsPage = input.savedResets && SAVED_RESETS_PAGE[input.savedResets.provider];
  const auto = Boolean(resetsPage && input.offerAutoResets);
  const resets = input.savedResets
    ? ` ${savedResetsWords(
        { account: input.name, ...input.savedResets },
        auto ? [USE_SAVED_RESETS_SAID] : [],
      )}`
    : "";
  const key = computer ? `${input.accountId}@${computer.deviceId}` : input.accountId;
  const { credits } = input;
  const waits = computer
    ? saidMark(said("cardSavedResetCrewWaitsThere", { where: computer.where }))
    : saidMark(said("cardSavedResetCrewWaits"));
  return {
    id: creditsOfferCardId(input.accountId, computer?.deviceId),
    title: computer
      ? `${input.name} ${computer.where} has used up its allowance${until}`
      : `${input.name} has used up its allowance${until}`,
    meta: CREW_WORK_META,
    body: !credits
      ? `${waits}${resets}`
      : computer
        ? `${creditsOfferSentence(credits)} Crew work ${computer.where} drops to a weaker model or waits until then unless you keep going on credits. Crew work there would then spend them only after every included allowance.${resets}`
        : `${creditsOfferSentence(credits)} Crew work drops to a weaker model or waits until then unless you keep going on credits. Your first mate and crew would then spend them only after every included allowance.${resets}`,
    actions: [
      ...(credits ? [keepGoingAction(key, true)] : []),
      ...(resetsPage ? [redeemSavedResetAction(key, !credits)] : []),
      ...(auto ? [autoResetsAction(key)] : []),
    ],
  };
}

/**
 * The way back for a seat the captain moved (W1 S9): the account it left
 * serves again, so ask - never move on its own. The action reuses the
 * move, pointed back at the provider the seat left.
 */
export function firstmateMoveBackCard(input: {
  providerId: string;
  providerName: string;
  body: string;
}): HostCard {
  return hostCard({
    id: FIRSTMATE_MOVE_BACK_CARD_ID,
    title: `Move your first mate back to ${input.providerName}?`,
    meta: FIRSTMATE_CARD_META,
    body: input.body,
    actions: [
      {
        id: "move-flagship",
        label: `Move back to ${input.providerName}`,
        variant: "primary",
        effect: { kind: "host", op: "move-flagship", arg: input.providerId },
      },
    ],
  });
}

/**
 * An app-raised auth decision card (also used by the Firstmate agent). A
 * crewmate's own sign-in card carries its task, so it holds that task's
 * turn through the gate like any card; an account's files its own row.
 * With `move`, its default moves the task to the model the app picked,
 * by that model's name (INF-849), `arg` being the task, the provider it
 * moves off and the model offered; Open settings stays beside it.
 */
export function authDecisionCard(
  id: string,
  meta: string,
  body: string,
  options?: {
    restoreAccountId?: string;
    taskId?: string;
    move?: { arg: string; modelName: string };
    /** Claude access set up for Claude Code was refused: renewed there, not signed in here. */
    access?: ClaudeAccessSource;
  },
): HostCard {
  const restoreAccountId = options?.restoreAccountId;
  return hostCard({
    id,
    ...(options?.taskId ? { taskId: options.taskId } : {}),
    title: restoreAccountId
      ? body
      : options?.access
        ? CLAUDE_ACCESS_SIGN_IN_TITLE
        : PROVIDER_SIGN_IN_TITLE,
    meta,
    body: restoreAccountId ? NEEDS_REAUTH_CONSEQUENCE : body,
    actions: [
      ...(options?.move && !restoreAccountId
        ? [
            {
              id: "move-task",
              label: moveLabel(options.move.modelName),
              variant: "primary" as const,
              default: true,
              effect: { kind: "host" as const, op: "move-task" as const, arg: options.move.arg },
            },
          ]
        : []),
      restoreAccountId
        ? {
            id: "sign-in",
            label: "Sign in",
            variant: "primary",
            effect: restoreAccountEffect(restoreAccountId),
          }
        : {
            id: "open-settings",
            label: "Open settings",
            variant: options?.move ? "secondary" : "primary",
            // Sign-in lives on the Intelligence tab, so that is where the
            // card lands - never the General tab one click short of it.
            effect: { kind: "open", target: "subscriptions" },
          },
    ],
  });
}

/**
 * The one host card for a sign-in where projects live that the host
 * refused (git integration PR 1.2): "Sign in to GitHub again", whose one
 * action lands on Settings -> Integrations with the sign-in already started
 * (its effect names `projects`, which `openedSection` routes there).
 * A body names what waits on it; it never suggests the host is required.
 */
export function forgeSignInCard(
  id: string,
  host: string,
  name: string,
  waitingChanges: number,
  options: { reauth?: boolean; cli?: boolean } = {},
): HostCard {
  const reauth = options.reauth ?? true;
  // A sign-in through GitHub CLI is signed in again in GitHub CLI itself, never here.
  const cli = reauth && options.cli === true;
  const waiting =
    waitingChanges === 0
      ? ""
      : waitingChanges === 1
        ? " One pull request is waiting on it."
        : ` ${waitingChanges} pull requests are waiting on it.`;
  return hostCard({
    id,
    title: forgeSignInTitle(name, reauth),
    meta: name,
    body: reauth
      ? `<p>${cli ? forgeCliRefusedText(name) : forgeRefusedText(name)}${waiting}</p><p>${LOCAL_PROJECTS_UNAFFECTED}</p>`
      : `<p>A task for a project on ${name} is waiting for your sign-in.${waiting}</p><p>Once you sign in, your first mate will retry starting the task. ${LOCAL_PROJECTS_UNAFFECTED}</p>`,

    actions: [
      {
        id: "sign-in",
        label: cli ? INTEGRATIONS_WORDS.open : reauth ? "Sign in again" : `Sign in to ${name}`,
        variant: "primary",
        effect: { kind: "open", target: "projects", signIn: host },
      },
    ],
  });
}

/**
 * The one host card for a computer that runs a project living on a host
 * it holds no sign-in for (design skill `components/devices/SignInOnAMac`,
 * "GitHub on another device"; docs/forge.md, "A computer's own sign-in"):
 * "Sign in to GitHub on Mac mini", whose one action lands on Settings ->
 * Integrations with that computer's sign-in started under its row (its
 * effect names `projects`, which `openedSection` routes there).
 */
export function deviceForgeSignInCard(
  id: string,
  input: {
    deviceId: string;
    host: string;
    name: string;
    project: string;
    place: { label: string; where: string; who: string };
  },
): HostCard {
  return hostCard({
    id,
    title: deviceForgeSignInTitle(input.place.where, input.name),
    meta: input.place.label,
    body: deviceForgeSignInBody(input.project, input.place, input.name),
    actions: [
      {
        id: "sign-in",
        label: deviceForgeSignInTitle(input.place.where, input.name),
        variant: "primary",
        effect: {
          kind: "open",
          target: "projects",
          forgeSignInOn: { deviceId: input.deviceId, host: input.host },
        },
      },
    ],
  });
}

/**
 * The Firstmate's own quiet card (P4 extension): informational only - the
 * orchestrator is steer-only, so there is no interrupt to offer.
 */
export function firstmateQuietCard(body: string): HostCard {
  return hostCard(
    {
      id: FIRSTMATE_QUIET_CARD_ID,
      title: "Your first mate has gone quiet",
      meta: FIRSTMATE_CARD_META,
      body,
      actions: [],
    },
    { note: true },
  );
}

/**
 * The Firstmate failure card (the agent-down set, ruling D6): the turn
 * failed and no agent can answer, so the host offers the one way out -
 * Retry, a host effect.
 */
export function firstmateFailureCard(body: string): HostCard {
  return hostCard({
    id: FIRSTMATE_FAILURE_CARD_ID,
    title: FIRSTMATE_FAILURE_TITLE,
    meta: FIRSTMATE_CARD_META,
    body,
    actions: [
      {
        id: "retry-firstmate",
        label: "Retry",
        variant: "primary",
        default: true,
        effect: { kind: "host", op: "retry-firstmate" },
      },
    ],
  });
}

/**
 * The card a moved first mate raises for one sign-in the old home had
 * (docs/devices.md, "What stays"): the move copied none, so it asks for each
 * here, landing on Subscriptions, or on Projects with that host's sign-in
 * started.
 */
export function signInAgainCard(
  id: string,
  signIn: { kind: "provider" | "forge"; id: string; name: string },
  from: string,
): HostCard {
  const name = escapeHtml(signIn.name);
  return hostCard({
    id,
    title: `Sign in to ${signIn.name} on ${HERE.this}`,
    meta: signIn.name,
    body: `<p>Your first mate moved here from ${escapeHtml(from)}, which keeps its own sign-ins. Sign in to ${name} here so your first mate and crew can use it.</p>`,
    actions: [
      {
        id: "sign-in",
        label: `Sign in to ${signIn.name}`,
        variant: "primary",
        effect:
          signIn.kind === "forge"
            ? { kind: "open", target: "projects", signIn: signIn.id }
            : { kind: "open", target: "subscriptions" },
      },
    ],
  });
}

export function systemNoteCard(id: string, title: string, body: string): HostCard {
  return hostCard({ id, title, meta: FIRSTMATE_CARD_META, body, actions: [] }, { note: true });
}
