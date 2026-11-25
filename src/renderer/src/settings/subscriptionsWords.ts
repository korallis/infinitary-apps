import { formatDateTime, formatNumber, formatTime } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
import type { AccountView } from "../../../shared/accounts";
import { COMPUTER, HERE } from "../../../shared/deviceNames";
import { API_KEY_LABEL } from "../../../shared/providers";
import {
  type QuotaCreditsView,
  type QuotaPoolView,
  type QuotaSavedResetsView,
  SAVED_RESETS_PAGE,
} from "../../../shared/quota";

/** Settings → Intelligence's account-row words (`SubscriptionsTab.tsx`). */
export const SUBSCRIPTIONS_WORDS = {
  /** First-run copy when the machine has no Claude login yet (CD-1=B). */
  get claudeFirstRun() {
    return m.settingsSubscriptionsClaudeFirstRun({ here: HERE.this });
  },
  /** What a row with no allowance reader says the app does, never what the credential could expose. */
  get noReader() {
    return m.settingsSubscriptionsNoReader();
  },
  /** The Claude row while a sign-out mark holds the account, allowance or not. */
  get signedOutHoldLabel() {
    return m.settingsSubscriptionsSignedOutHoldLabel();
  },
  get signedOutHoldText() {
    return m.settingsSubscriptionsSignedOutHoldText();
  },
  /** The row while the provider is refusing this sign-in. */
  get refusedHoldLabel() {
    return m.settingsSubscriptionsRefusedHoldLabel();
  },
  get refusedHoldText() {
    return m.settingsSubscriptionsRefusedHoldText();
  },
  /** The tag on the one row whose account Firstmate runs on, and its tooltip. */
  get firstmateAccountTag() {
    return m.settingsSubscriptionsFirstmateAccountTag();
  },
  get firstmateAccountTagTitle() {
    return m.settingsSubscriptionsFirstmateAccountTagTitle();
  },
  /** What the ✱ beside an account's name means: crew work prefers it. */
  get crewPreferredMarkTitle() {
    return m.settingsSubscriptionsCrewPreferredMarkTitle();
  },
} as const;

/** The no-reader line, after "API key set" on a key's row. */
export function noReaderText(kind: AccountView["kind"]): string {
  return kind === "api_key"
    ? m.settingsSubscriptionsNoReaderKey({ apiKey: API_KEY_LABEL })
    : m.settingsSubscriptionsNoReader();
}

/**
 * What a row with no window says, one line per situation the captain must
 * tell apart (`emptyQuotaText`): the sign-in itself needs redoing, the
 * provider asked us to slow down, the allowance could not be read just now,
 * or none has been read yet. None of them is ever a meter.
 */
export const EMPTY_QUOTA_TEXT = {
  get signInAgain() {
    return m.settingsSubscriptionsEmptySignInAgain();
  },
  get slowDown() {
    return m.settingsSubscriptionsEmptySlowDown();
  },
  get unread() {
    return m.settingsSubscriptionsEmptyUnread();
  },
  get notYet() {
    return m.settingsSubscriptionsEmptyNotYet();
  },
} as const;

/** The mark beside an account crew work prefers, on the computer's row and the phone's alike. */
export const CREW_PREFERRED_MARK = "✱";

export const PERSONAL_RESOURCES_WORDS = {
  get title() {
    return m.settingsSubscriptionsPersonalResourcesTitle();
  },
  get description() {
    return m.settingsSubscriptionsPersonalResourcesDescription({
      computer: COMPUTER.one,
      computers: COMPUTER.many,
    });
  },
} as const;

/**
 * Where each provider's credits are switched on, bought and limited: the
 * place the row points to, since Infinitary changes none of it.
 */
export const CREDITS_SITE: Record<string, string> = {
  claude: "claude.ai",
  codex: "chatgpt.com",
  copilot: "github.com",
};

/**
 * The row's one line about paying past the allowance (docs/quota.md,
 * "Credits past the allowance"): what the provider says, then where to
 * change it, or, while the account's Keep going on credits switch is on,
 * that it keeps going on them. Unknown says nothing, and a provider this
 * build reads no credits for has no line.
 */
export function creditsLine(
  provider: string,
  credits: QuotaCreditsView | undefined,
  keepsGoing = false,
) {
  const site = CREDITS_SITE[provider];
  if (!credits || !site || credits.state === "unknown") return undefined;
  const fact = creditsFact(provider, credits);
  if (!fact) return undefined;
  const after = keepsGoing
    ? m.settingsSubscriptionsCreditsKeepsGoing()
    : m.settingsSubscriptionsCreditsWhere({ site });
  return `${fact} · ${after}`;
}

/**
 * The row's one line about saved resets (docs/quota.md, "Saved resets"):
 * how many the account holds and where they are used, since Infinitary
 * uses none. An unknown count, or none, says nothing.
 */
export function savedResetsLine(provider: string, savedResets: QuotaSavedResetsView | undefined) {
  const site = CREDITS_SITE[provider];
  if (!SAVED_RESETS_PAGE[provider] || !site || !savedResets || savedResets.available < 1) {
    return undefined;
  }
  return m.settingsSubscriptionsSavedResets({ count: savedResets.available, site });
}

function creditsFact(provider: string, credits: QuotaCreditsView): string | undefined {
  const { state } = credits;
  if (provider === "claude") {
    if (state === "off") return m.settingsSubscriptionsCreditsClaudeOff();
    if (state === "spent") return m.settingsSubscriptionsCreditsClaudeSpent();
    const percent =
      credits.usedPercent !== undefined ? formatNumber(Math.round(credits.usedPercent)) : undefined;
    if (credits.inUse) {
      return percent !== undefined
        ? m.settingsSubscriptionsCreditsClaudeInUseUsed({ percent })
        : m.settingsSubscriptionsCreditsClaudeInUse();
    }
    return percent !== undefined
      ? m.settingsSubscriptionsCreditsClaudeAvailableUsed({ percent })
      : m.settingsSubscriptionsCreditsClaudeAvailable();
  }
  if (provider === "codex") {
    if (state === "off") return m.settingsSubscriptionsCreditsCodexOff();
    if (state === "spent") return m.settingsSubscriptionsCreditsCodexSpent();
    if (credits.unlimited) return m.settingsSubscriptionsCreditsCodexUnlimited();
    return credits.balance !== undefined
      ? m.settingsSubscriptionsCreditsCodexBalance({ balance: balanceText(credits.balance) })
      : m.settingsSubscriptionsCreditsCodexAvailable();
  }
  if (provider === "copilot") {
    if (state === "available") return m.settingsSubscriptionsCreditsCopilotAvailable();
    if (state === "off") return m.settingsSubscriptionsCreditsCopilotOff();
  }
  return undefined;
}

/**
 * A balance as the language writes numbers, to two places at most
 * (ChatGPT sends "32684.7473575000"); words it is not a number stay as sent.
 */
function balanceText(balance: string): string {
  const value = Number(balance);
  return balance.trim() !== "" && Number.isFinite(value)
    ? formatNumber(value, { maximumFractionDigits: 2 })
    : balance;
}

/**
 * A pooled row's one line about its proxy's logins (docs/quota.md, "A
 * proxy's pooled logins"): how many are pooled, then each count that stops
 * one serving or leaves it unread. Every sign-in it names is renewed in the
 * proxy app, so the row offers no Sign in of its own.
 */
export function poolLine(pool: QuotaPoolView, now: number): string {
  const facts = [m.settingsSubscriptionsPoolAccounts({ count: pool.logins })];
  if (pool.unread > 0) facts.push(m.settingsSubscriptionsPoolUnread({ count: pool.unread }));
  if (pool.spent > 0)
    facts.push(
      m.settingsSubscriptionsPoolSpent({
        count: pool.spent,
        time: pool.backAtMs !== undefined ? poolTime(pool.backAtMs, now) : "",
      }),
    );
  if (pool.signInSoon > 0 && pool.signInByMs !== undefined)
    facts.push(
      m.settingsSubscriptionsPoolSignInBy({
        count: pool.signInSoon,
        time: poolTime(pool.signInByMs, now),
      }),
    );
  if (pool.signInEnded > 0)
    facts.push(m.settingsSubscriptionsPoolSignedOut({ count: pool.signInEnded }));
  if (pool.switchedOff > 0)
    facts.push(m.settingsSubscriptionsPoolSwitchedOff({ count: pool.switchedOff }));
  return facts.join(" · ");
}

/** A moment within the day as its clock time, a later one with its weekday. */
function poolTime(at: number, now: number): string {
  return at - now < 24 * 60 * 60 * 1000
    ? formatTime(at, { hour: "2-digit", minute: "2-digit" })
    : formatDateTime(at, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

/** The row of a proxy that did not answer, before it names a pool. */
export function poolUsageLabel(): string {
  return m.settingsSubscriptionsPoolUsage();
}
