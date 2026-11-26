import type { Card } from "@shared/cards";
import { type Said, said } from "@shared/i18n/said";
import { CREW_NEAR_FLOOR_PERCENT } from "@shared/quotaSignals";
import type { WhenLoginLow } from "@shared/whenLoginLow";
import { loginLowCard, loginLowCardId } from "../orchestrator/loginCards";
import type { AccountCandidate } from "../routing/accountPolicy";

/** A login as a pick reads it: whether it serves, and how much of its allowance is left. */
export type LoginReading = Pick<
  AccountCandidate,
  | "accountId"
  | "label"
  | "enabled"
  | "connected"
  | "withheld"
  | "effectivePercentRemaining"
  | "onCredits"
>;

/** The moment: 10% of its allowance or less is left, by a measured reading. */
export function runsLow(login: LoginReading): boolean {
  return (
    login.effectivePercentRemaining !== undefined &&
    login.effectivePercentRemaining <= CREW_NEAR_FLOOR_PERCENT
  );
}

/**
 * The login with the most room among a provider's others: on, serving and
 * not low itself, a measured reading before an unread one, the highest
 * reading first. Undefined when no other login has room, so nothing is
 * asked or moved.
 */
export function roomiestOther(
  logins: readonly LoginReading[],
  lowId: string,
): LoginReading | undefined {
  const room = (login: LoginReading) => login.effectivePercentRemaining ?? -1;
  return logins
    .filter(
      (login) =>
        login.accountId !== lowId &&
        login.enabled &&
        login.connected !== false &&
        login.withheld === undefined &&
        !login.onCredits &&
        !runsLow(login),
    )
    .sort((a, b) => room(b) - room(a))[0];
}

export type LowLoginsOptions = {
  /** The saved choice (`SettingsStore.getWhenLoginLow`). */
  whenLow: () => WhenLoginLow;
  /** Each provider with logins of this computer, by its Pi id and name. */
  providers: () => { id: string; name: string }[];
  /** A provider's logins as a pick reads them now. */
  logins: (providerId: string) => LoginReading[];
  /** The provider's login in use: its pin. */
  pinOf: (providerId: string) => string | undefined;
  setPin: (providerId: string, accountId: string) => void;
  /** When a login's allowance refills, worded for a person, when known. */
  refillsOf: (providerId: string, accountId: string) => string | undefined;
  /** The started tasks whose conversation is on a login (`LoginMoves.tasksOn`). */
  tasksOn: (accountId: string) => string[];
  /** Moves each of them that is between turns to another login (`LoginMoves.moveOff`). */
  moveOff: (accountId: string) => unknown;
  cards: {
    raiseHostCard: (card: Omit<Card, "author" | "priority" | "status" | "createdAt">) => unknown;
    withdrawHostCard: (id: string, reason: string) => void;
  };
  /** One feed line. */
  note: (fact: Said) => void;
};

/**
 * What happens when a provider's login in use runs low while another login
 * of that provider has room (docs/quota.md, "When the login in use runs
 * low"), read again on every allowance reading, cut-off change and change
 * of the choice:
 *
 * - `wait`: nothing; work on the login waits for its refill.
 * - `ask`: one card per provider per run-out. Its click moves the pin, and
 *   the tasks on the login it left move as each comes between turns.
 * - `spread`: new work already runs across the logins, so the card asks
 *   only about the tasks running on the low login.
 * - `move`: the pin moves with one feed line and the tasks follow, no card.
 *
 * What was asked, and which logins are being left, is remembered only
 * while the app runs: after a restart the card goes up again for a login
 * still low, and a click moves again what a restart left behind.
 */
export class LowLogins {
  /** The login each provider's card asked about, until that login is no longer low. */
  private readonly asked = new Map<string, string>();
  /** Providers whose card this watch put up and has not taken down. */
  private readonly shown = new Set<string>();
  /** Logins whose tasks move off them, with their provider, while the login stays low. */
  private readonly leaving = new Map<string, string>();

  constructor(private readonly options: LowLoginsOptions) {}

  read(): void {
    const choice = this.options.whenLow();
    for (const provider of this.options.providers()) this.readProvider(provider, choice);
  }

  /** The card's click: work moves to the named login of the provider the card asked about. */
  move(accountId: string): void {
    const provider = this.options
      .providers()
      .find((entry) =>
        this.options
          .logins(entry.id)
          .some((login) => login.accountId === accountId && login.enabled),
      );
    if (!provider) return;
    const from = this.asked.get(provider.id);
    this.withdraw(provider.id, "moved");
    const choice = this.options.whenLow();
    if (!from || from === accountId || choice === "wait") return;
    const logins = this.options.logins(provider.id);
    const label = (id: string) => logins.find((login) => login.accountId === id)?.label ?? id;
    // Under `spread` new work is not bound to the pin, so the pin moves only when it is the low login.
    if (choice !== "spread" || this.options.pinOf(provider.id) === from) {
      this.options.setPin(provider.id, accountId);
      this.options.note(
        said("feedLoginMoved", {
          provider: provider.name,
          from: label(from),
          to: label(accountId),
        }),
      );
    }
    this.leaving.set(from, provider.id);
    void this.options.moveOff(from);
  }

  private readProvider(provider: { id: string; name: string }, choice: WhenLoginLow): void {
    const logins = this.options.logins(provider.id).filter((login) => login.enabled);
    const lowOnes = logins.filter(runsLow);
    const isLow = (accountId: string) => lowOnes.some((login) => login.accountId === accountId);
    const asked = this.asked.get(provider.id);
    if (asked && !isLow(asked)) this.asked.delete(provider.id);
    for (const [accountId, providerId] of this.leaving)
      if (providerId === provider.id && (!isLow(accountId) || choice === "wait"))
        this.leaving.delete(accountId);
    if (choice === "move") this.moveUnasked(provider, logins, lowOnes);
    else this.ask(provider, logins, lowOnes, choice);
    for (const [accountId, providerId] of this.leaving)
      if (providerId === provider.id) void this.options.moveOff(accountId);
  }

  /** `move`: a low pin moves to the login with the most room, and each low login is left. */
  private moveUnasked(
    provider: { id: string; name: string },
    logins: readonly LoginReading[],
    lowOnes: readonly LoginReading[],
  ): void {
    // i18n-exempt: a withdrawal's reason on the card's record, never shown
    this.withdraw(provider.id, "moves without asking");
    for (const low of lowOnes) {
      const other = roomiestOther(logins, low.accountId);
      if (!other) continue;
      if (low.accountId === this.options.pinOf(provider.id)) {
        this.options.setPin(provider.id, other.accountId);
        this.options.note(
          said("feedLoginMovedLow", {
            from: low.label,
            provider: provider.name,
            to: other.label,
          }),
        );
      }
      if (this.options.tasksOn(low.accountId).length > 0)
        this.leaving.set(low.accountId, provider.id);
    }
  }

  /** `ask` and `spread`: the card, once per run-out of the login it asks about. */
  private ask(
    provider: { id: string; name: string },
    logins: readonly LoginReading[],
    lowOnes: readonly LoginReading[],
    choice: WhenLoginLow,
  ): void {
    const pin = this.options.pinOf(provider.id);
    const subject =
      choice === "ask"
        ? lowOnes.find((login) => login.accountId === pin)
        : choice === "spread"
          ? [...lowOnes]
              .sort((a, b) => Number(b.accountId === pin) - Number(a.accountId === pin))
              .find((login) => this.options.tasksOn(login.accountId).length > 0)
          : undefined;
    const other = subject ? roomiestOther(logins, subject.accountId) : undefined;
    if (!subject || !other) {
      // i18n-exempt: a withdrawal's reason on the card's record, never shown
      this.withdraw(provider.id, "no longer asked");
      return;
    }
    if (this.asked.get(provider.id) === subject.accountId) return;
    this.asked.set(provider.id, subject.accountId);
    this.shown.add(provider.id);
    const percent = subject.effectivePercentRemaining ?? 0;
    const refills = this.options.refillsOf(provider.id, subject.accountId);
    this.options.cards.raiseHostCard(
      loginLowCard({
        providerId: provider.id,
        providerName: provider.name,
        login: subject.label,
        ...(percent > 0 ? { percentLeft: percent } : {}),
        ...(refills ? { refills } : {}),
        other: { accountId: other.accountId, label: other.label },
        ...(choice === "spread" ? { spread: true } : {}),
      }),
    );
  }

  private withdraw(providerId: string, reason: string): void {
    if (!this.shown.delete(providerId)) return;
    this.options.cards.withdrawHostCard(loginLowCardId(providerId), reason);
  }
}
