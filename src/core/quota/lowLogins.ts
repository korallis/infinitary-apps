import { randomUUID } from "node:crypto";
import type { Card } from "@shared/cards";
import { type Said, said } from "@shared/i18n/said";
import type { WhenLoginLow } from "@shared/whenLoginLow";
import { loginLowCard, loginLowCardId } from "../orchestrator/loginCards";
import { hasRoom, type LoginReading, runsLow } from "../routing/accountPolicy";

export { hasRoom, type LoginReading, runsLow };

/** No reading of the login yet: neither a typed run-out nor a measured allowance. */
function unread(login: LoginReading): boolean {
  return login.runOut === undefined && login.effectivePercentRemaining === undefined;
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
  /**
   * The tasks still to move off a login stay on it; with `to`, only those
   * named for that login (`LoginMoves.forget`).
   */
  forget: (from: string, to?: string) => void;
  /**
   * Each provider's card the card store still has open from the last
   * launch: the login it asks about and the one it offers, where it says.
   */
  openOffers?: () => { providerId: string; from?: string; to?: string }[];
  cards: {
    raiseHostCard: (card: Omit<Card, "author" | "priority" | "status" | "createdAt">) => unknown;
    withdrawHostCard: (id: string, reason: string) => void;
  };
  /**
   * The captain's answer on the provider's saved card that still stands:
   * the login the card asked about, the login a Move click named (absent
   * for Wait for the refill), and the refill time the card named. Undefined
   * once `endAnswer` ended it or the card went up again; saved, so a launch
   * reads it as the last one left it.
   */
  answered: (providerId: string) => { from: string; to?: string; refillsAt?: number } | undefined;
  /** The answer is over: its move is made or refused, or its run-out ended. Saved. */
  endAnswer: (providerId: string) => void;
  /** When a login's allowance refills, in milliseconds, when known. */
  refillsAt?: (providerId: string, accountId: string) => number | undefined;
  now?: () => number;
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
 * The card up now (`offers`) is kept apart from the captain's answer on it
 * (`answered`): the card is revised as the login it asks about, the login
 * it offers or their readings change, taken down when nothing can be
 * offered and put up again when something can. A Wait answer holds until
 * that login is read with room again or the refill its card named has
 * passed; a Move answer holds until its move is recorded. The card up is
 * remembered only while the app runs; the answer is saved, so a launch
 * keeps a Wait and finishes a Move the last one was cut off in.
 */
export class LowLogins {
  /** Each provider's card that is up: the login it asks about, the one it offers, and its words. */
  private readonly offers = new Map<string, { from: string; to: string; words: string }>();

  constructor(private readonly options: LowLoginsOptions) {
    // A card still open from the last launch is the card up now, so the
    // readings revise it or take it down as they would one raised here.
    for (const open of options.openOffers?.() ?? [])
      this.offers.set(open.providerId, { from: open.from ?? "", to: open.to ?? "", words: "" });
    // A Move click the last launch was cut off in is made again whole by
    // `accept`, or not at all: until then none of its tasks is still to move.
    for (const provider of options.providers()) {
      const answer = options.answered(provider.id);
      if (answer?.to !== undefined) options.forget(answer.from, answer.to);
    }
  }

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
    if (offered && provider) {
      this.offers.delete(provider.id);
      if (this.accept(provider, offered[1].from, accountId)) return;
    }
    this.read();
  }

  /**
   * Makes the move a click named, true when work moved. The tasks' moves
   * are recorded before the pin, and the answer ends last: a quit part way
   * leaves an answer the next launch finishes (`readProvider`), which
   * records the same moves again and never picks another login. A record
   * that cannot be saved throws from `moveOff` before the pin or the
   * answer change, so the next reading tries the whole move again.
   */
  private accept(provider: { id: string; name: string }, from: string, accountId: string): boolean {
    const choice = this.options.whenLow();
    const logins = this.options.logins(provider.id).filter((login) => login.enabled);
    const low = logins.find((login) => login.accountId === from);
    const to = logins.find((login) => login.accountId === accountId);
    // Not read yet, as at launch: the answer waits for the reading.
    if (low && unread(low)) return false;
    const asks = choice === "ask" || choice === "spread";
    // Under `ask` the card asked about the login in use: one the captain has since replaced is not it.
    const inUse = choice !== "ask" || this.options.pinOf(provider.id) === from;
    const moves = asks && inUse && low && runsLow(low) && to && hasRoom(to);
    if (moves) {
      void this.options.moveOff(from, accountId);
      // Under `spread` new work is not bound to the pin, so the pin moves only when it is the low login.
      if (choice !== "spread" || this.options.pinOf(provider.id) === from) {
        this.options.setPin(provider.id, accountId);
        this.options.note(
          said("feedLoginMoved", { provider: provider.name, from: low.label, to: to.label }),
        );
      }
    }
    // Refused, the click leaves no task named for the login it named.
    else this.options.forget(from, accountId);
    this.options.endAnswer(provider.id);
    return Boolean(moves);
  }

  private readProvider(provider: { id: string; name: string }, choice: WhenLoginLow): void {
    const every = this.options.logins(provider.id);
    const logins = every.filter((login) => login.enabled);
    const lowOnes = logins.filter(runsLow);
    const isLow = (accountId: string) => lowOnes.some((login) => login.accountId === accountId);
    const answer = this.options.answered(provider.id);
    if (answer) this.offers.delete(provider.id);
    // A Move click the last launch was cut off in is finished as it was named.
    if (answer?.to !== undefined) this.accept(provider, answer.from, answer.to);
    const waited =
      answer && answer.to === undefined ? this.stillWaited(provider.id, answer, every) : undefined;
    // Tasks leave a login only while it is low and work may move. A login
    // not read yet, as at launch, is not known to have room again.
    for (const login of every)
      if (choice === "wait" || (!isLow(login.accountId) && !unread(login)))
        this.options.forget(login.accountId);
    if (choice === "move") this.moveUnasked(provider, logins, lowOnes);
    else this.ask(provider, logins, lowOnes, choice, waited);
  }

  /**
   * The login a Wait answer still covers. The answer ends, for good, once
   * that login is read with room again, the refill its card named has
   * passed, or the login is gone; a login not read yet keeps it.
   */
  private stillWaited(
    providerId: string,
    answer: { from: string; refillsAt?: number },
    logins: readonly LoginReading[],
  ): string | undefined {
    const login = logins.find((entry) => entry.accountId === answer.from);
    const refilled =
      answer.refillsAt !== undefined && (this.options.now?.() ?? Date.now()) >= answer.refillsAt;
    if (login && (unread(login) || (runsLow(login) && !refilled))) return answer.from;
    this.options.endAnswer(providerId);
    return undefined;
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
      // The tasks' moves are recorded before the pin, so a quit between leaves none unnamed.
      if (this.options.tasksOn(low.accountId).length > 0)
        void this.options.moveOff(low.accountId, other.accountId);
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
    }
  }

  /** `ask` and `spread`: the card, kept true to the login it asks about and the one it offers. */
  private ask(
    provider: { id: string; name: string },
    logins: readonly LoginReading[],
    lowOnes: readonly LoginReading[],
    choice: WhenLoginLow,
    waited: string | undefined,
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
    const offer = this.offers.get(provider.id);
    const asked = logins.find((login) => login.accountId === offer?.from);
    // The login the card up asks about is not read yet, as at launch: nothing is known against it.
    if (!subject && asked && unread(asked) && (choice === "ask" || choice === "spread")) return;
    if (!subject || !other) {
      // i18n-exempt: a withdrawal's reason on the card's record, never shown
      this.withdraw(provider.id, "no longer asked");
      return;
    }
    if (waited === subject.accountId) return;
    const percent = subject.effectivePercentRemaining ?? 0;
    const refills = this.options.refillsOf(provider.id, subject.accountId);
    const refillsAt = this.options.refillsAt?.(provider.id, subject.accountId);
    const asks = {
      providerId: provider.id,
      providerName: provider.name,
      accountId: subject.accountId,
      login: subject.label,
      // A typed run-out is spent whatever the meter last read.
      ...(!subject.runOut && percent > 0 ? { percentLeft: percent } : {}),
      ...(refills ? { refills } : {}),
      ...(refillsAt !== undefined ? { refillsAt } : {}),
      other: { accountId: other.accountId, label: other.label },
      ...(choice === "spread" ? { spread: true } : {}),
    };
    const card = loginLowCard(asks);
    const words = JSON.stringify([card.title, card.body, card.actions]);
    if (offer?.from === subject.accountId && offer.to === other.accountId && offer.words === words)
      return;
    this.offers.set(provider.id, { from: subject.accountId, to: other.accountId, words });
    // Each raising is its own question, so the answer to an earlier one is never read as this one's.
    this.options.cards.raiseHostCard(loginLowCard({ ...asks, askId: randomUUID() }));
  }

  private withdraw(providerId: string, reason: string): void {
    if (!this.offers.delete(providerId)) return;
    this.options.cards.withdrawHostCard(loginLowCardId(providerId), reason);
  }
}
