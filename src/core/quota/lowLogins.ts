import type { Card } from "@shared/cards";
import { type Said, said } from "@shared/i18n/said";
import { CREW_NEAR_FLOOR_PERCENT } from "@shared/quotaSignals";
import type { WhenLoginLow } from "@shared/whenLoginLow";
import { loginLowCard, loginLowCardId } from "../orchestrator/loginCards";
import type { AccountCandidate } from "../routing/accountPolicy";

/**
 * A login as a pick reads it: whether it serves, and how much of its
 * allowance is left. `runOut` is the vault's typed `no_headroom` cut-off: the
 * provider refused the login for a spent allowance, whatever its meter says.
 */
export type LoginReading = Pick<
  AccountCandidate,
  | "accountId"
  | "label"
  | "enabled"
  | "connected"
  | "withheld"
  | "effectivePercentRemaining"
  | "onCredits"
> & { runOut?: { resetsAt?: number } };

/**
 * The moment: a typed run-out, or 10% of its allowance or less left by a
 * measured reading.
 */
export function runsLow(login: LoginReading): boolean {
  return (
    login.runOut !== undefined ||
    (login.effectivePercentRemaining !== undefined &&
      login.effectivePercentRemaining <= CREW_NEAR_FLOOR_PERCENT)
  );
}

/** Whether work may move to the login: on, serving, on its included allowance and not low itself. */
export function hasRoom(login: LoginReading): boolean {
  return (
    login.enabled &&
    login.connected !== false &&
    login.withheld === undefined &&
    !login.onCredits &&
    !runsLow(login)
  );
}

/**
 * The login with the most room among a provider's others: a measured
 * reading before an unread one, the highest reading first. Undefined when
 * no other login has room, so nothing is asked or moved.
 */
export function roomiestOther(
  logins: readonly LoginReading[],
  lowId: string,
): LoginReading | undefined {
  const room = (login: LoginReading) => login.effectivePercentRemaining ?? -1;
  return logins
    .filter((login) => login.accountId !== lowId && hasRoom(login))
    .sort((a, b) => room(b) - room(a))[0];
}

export type LowLoginsOptions = {
  /** The saved choice (`SettingsStore.getWhenLoginLow`). */
  whenLow: () => WhenLoginLow;
  /** Each provider with a login of this computer, by its Pi id and name. */
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
  /** Binds each of them to the named login, where it moves between turns (`LoginMoves.moveOff`). */
  moveOff: (from: string, to: string) => unknown;
  /** The tasks still to move off a login stay on it (`LoginMoves.forget`). */
  forget: (from: string) => void;
  cards: {
    raiseHostCard: (card: Omit<Card, "author" | "priority" | "status" | "createdAt">) => unknown;
    withdrawHostCard: (id: string, reason: string) => void;
  };
  /** Whether the captain answered the provider's card with Wait for the refill. */
  waitChosen: (providerId: string) => boolean;
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
 *   the tasks on the login it left move to the login the card named.
 * - `spread`: new work already runs across the logins, so the card asks
 *   only about the tasks running on the low login.
 * - `move`: the pin moves with one feed line and the tasks follow, no card.
 *
 * The card up now (`offers`) is kept apart from the captain's Wait answer
 * (`waited`): the card is revised as the login it asks about, the login it
 * offers or their readings change, taken down when nothing can be offered
 * and put up again when something can, while a Wait answer holds until
 * that login has room again. Both are remembered only while the app runs:
 * after a restart the card goes up again for a login still low.
 */
export class LowLogins {
  /** Each provider's card that is up: the login it asks about, the one it offers, and its words. */
  private readonly offers = new Map<string, { from: string; to: string; words: string }>();
  /** The login each provider's captain chose to wait on, until it is no longer low. */
  private readonly waited = new Map<string, string>();

  constructor(private readonly options: LowLoginsOptions) {}

  read(): void {
    const choice = this.options.whenLow();
    const providers = this.options.providers();
    for (const provider of providers) this.readProvider(provider, choice);
    // A provider left with no login has nothing to ask about.
    for (const providerId of [...this.offers.keys()])
      if (!providers.some((provider) => provider.id === providerId))
        // i18n-exempt: a withdrawal's reason on the card's record, never shown
        this.withdraw(providerId, "no longer asked");
  }

  /**
   * The card's click: work moves to the login the card named, while the
   * choice still asks, the login it asked about is still low and the named
   * login still has room. Otherwise nothing moves and the logins are read
   * again, which asks about what is true now.
   */
  move(accountId: string): void {
    const offered = [...this.offers].find(([, offer]) => offer.to === accountId);
    const provider = this.options.providers().find((entry) => entry.id === offered?.[0]);
    if (!offered || !provider) {
      this.read();
      return;
    }
    const { from } = offered[1];
    this.offers.delete(provider.id);
    const choice = this.options.whenLow();
    const logins = this.options.logins(provider.id).filter((login) => login.enabled);
    const low = logins.find((login) => login.accountId === from);
    const to = logins.find((login) => login.accountId === accountId);
    const asks = choice === "ask" || choice === "spread";
    if (!asks || !low || !runsLow(low) || !to || !hasRoom(to)) {
      this.read();
      return;
    }
    // Under `spread` new work is not bound to the pin, so the pin moves only when it is the low login.
    if (choice !== "spread" || this.options.pinOf(provider.id) === from) {
      this.options.setPin(provider.id, accountId);
      this.options.note(
        said("feedLoginMoved", { provider: provider.name, from: low.label, to: to.label }),
      );
    }
    void this.options.moveOff(from, accountId);
  }

  private readProvider(provider: { id: string; name: string }, choice: WhenLoginLow): void {
    const every = this.options.logins(provider.id);
    const logins = every.filter((login) => login.enabled);
    const lowOnes = logins.filter(runsLow);
    const isLow = (accountId: string) => lowOnes.some((login) => login.accountId === accountId);
    const offer = this.offers.get(provider.id);
    if (offer && this.options.waitChosen(provider.id)) {
      this.offers.delete(provider.id);
      this.waited.set(provider.id, offer.from);
    }
    const waited = this.waited.get(provider.id);
    if (waited && !isLow(waited)) this.waited.delete(provider.id);
    // Tasks leave a login only while it is low and work may move.
    for (const login of every)
      if (choice === "wait" || !isLow(login.accountId)) this.options.forget(login.accountId);
    if (choice === "move") this.moveUnasked(provider, logins, lowOnes);
    else this.ask(provider, logins, lowOnes, choice);
  }

  /** `move`: a low pin moves to the login with the most room, and each low login's tasks follow. */
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
        void this.options.moveOff(low.accountId, other.accountId);
    }
  }

  /** `ask` and `spread`: the card, kept true to the login it asks about and the one it offers. */
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
    if (this.waited.get(provider.id) === subject.accountId) return;
    const percent = subject.effectivePercentRemaining ?? 0;
    const refills = this.options.refillsOf(provider.id, subject.accountId);
    const card = loginLowCard({
      providerId: provider.id,
      providerName: provider.name,
      login: subject.label,
      // A typed run-out is spent whatever the meter last read.
      ...(!subject.runOut && percent > 0 ? { percentLeft: percent } : {}),
      ...(refills ? { refills } : {}),
      other: { accountId: other.accountId, label: other.label },
      ...(choice === "spread" ? { spread: true } : {}),
    });
    const words = JSON.stringify([card.title, card.body, card.actions]);
    const offer = this.offers.get(provider.id);
    if (offer?.from === subject.accountId && offer.to === other.accountId && offer.words === words)
      return;
    this.offers.set(provider.id, { from: subject.accountId, to: other.accountId, words });
    this.options.cards.raiseHostCard(card);
  }

  private withdraw(providerId: string, reason: string): void {
    if (!this.offers.delete(providerId)) return;
    this.options.cards.withdrawHostCard(loginLowCardId(providerId), reason);
  }
}
