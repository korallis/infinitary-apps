import type { FmEvent } from "@shared/events";
import { type Said, said, saidLine } from "@shared/i18n/said";
import { PROVIDER_CATALOG } from "@shared/providers";
import { type QuotaSnapshotView, resetWhen } from "@shared/quota";
import type { WhenLoginLow } from "@shared/whenLoginLow";
import { LOGIN_LOW_WAIT, loginLowAsked, loginLowCardId } from "../orchestrator/loginCards";
import { moveLoginActionId } from "../orchestrator/loginMove";
import type { LoginMoves } from "../orchestrator/loginMoves";
import { quotaRowProviderOf } from "./auth";
import { limitingResetOf } from "./catalog";
import { type LoginReading, LowLogins, type LowLoginsOptions } from "./lowLogins";

type SavedAnswers = {
  cards: {
    chosenAction(id: string): string | undefined;
    stored(id: string): { body?: string } | undefined;
  };
  settings: { getLoginAnswersOver(): Record<string, string> };
  vault: { list(providerId?: string): { id: string }[] };
};

/**
 * The captain's answer on a provider's saved low-login card that still
 * stands (`LowLoginsOptions.answered`): read from the card store and the
 * record of ended answers alone, so it reads the same at any point of a
 * launch.
 */
export function loginLowAnswer(
  saved: SavedAnswers,
  providerId: string,
): { from: string; to?: string; refillsAt?: number } | undefined {
  const id = loginLowCardId(providerId);
  const chosen = saved.cards.chosenAction(id);
  const asked = loginLowAsked(saved.cards.stored(id)?.body ?? "");
  if (chosen === undefined || !asked) return undefined;
  if (saved.settings.getLoginAnswersOver()[providerId] === (asked.askId ?? "")) return undefined;
  const answer = {
    from: asked.accountId,
    ...(asked.refillsAt !== undefined ? { refillsAt: asked.refillsAt } : {}),
  };
  if (chosen === LOGIN_LOW_WAIT) return answer;
  // A Move button's id names both logins (`moveLoginActionId`).
  const to = saved.vault
    .list(providerId)
    .find((account) => chosen === moveLoginActionId(asked.accountId, account.id));
  return to ? { ...answer, to: to.id } : undefined;
}

/** Whether a Move click that left this login has an answer that still stands unchecked. */
export function loginMoveUnchecked(saved: SavedAnswers, from: string): boolean {
  return PROVIDER_CATALOG.some((entry) => {
    if (!saved.vault.list(entry.id).some((account) => account.id === from)) return false;
    const answer = loginLowAnswer(saved, entry.id);
    return answer?.from === from && answer.to !== undefined;
  });
}

/**
 * The home's watch over its own logins that run low (docs/quota.md, "When
 * the login in use runs low"): `LowLogins` over this computer's vault,
 * allowance readings and started tasks. A computer that runs work keeps its
 * own pick and is not watched from here.
 */
export function startLowLogins(options: {
  settings: {
    getWhenLoginLow(): WhenLoginLow;
    getLoginAnswersOver(): Record<string, string>;
    setLoginAnswersOver(over: Record<string, string>): void;
  };
  vault: {
    list(providerId?: string): { id: string; label: string; enabled: boolean }[];
    pinnedAccount(providerId: string): string | undefined;
    setPin(providerId: string, accountId: string | null): void;
    onCutOffChange(listener: () => void): unknown;
    cutOff(accountId: string): { class: string; resetsAt?: number } | undefined;
  };
  routing: {
    accounts: { logins(providerId: string): LoginReading[] };
    /** Hears the login a pick took as a provider's login in use, already saved as its pin. */
    attachLoginInUse(said: (providerId: string, accountId: string) => void): void;
  };
  quota: { latest(): QuotaSnapshotView | undefined };
  supervisor: {
    cards: {
      hostCards: LowLoginsOptions["cards"];
      chosenAction(id: string): string | undefined;
      stored(id: string): { body?: string } | undefined;
      /** A card that is up, unanswered. */
      get(id: string): { actions?: readonly { id: string }[] } | undefined;
    };
    loginMoves: LoginMoves;
  };
  broadcastEvent: (event: FmEvent) => void;
}): LowLogins {
  const { vault, quota, supervisor, settings } = options;
  const note = (fact: Said) =>
    options.broadcastEvent({ type: "firstmate_note", ...saidLine(fact) });
  const nameOf = (providerId: string) =>
    PROVIDER_CATALOG.find((entry) => entry.id === providerId)?.name ?? providerId;
  // The provider's typed refusal for a spent allowance, which no meter has to agree with.
  const runOutOf = (accountId: string) => {
    const cut = vault.cutOff(accountId);
    return cut?.class === "no_headroom" ? { resetsAt: cut.resetsAt } : undefined;
  };
  const refillsAt = (providerId: string, accountId: string) => {
    const row = quota
      .latest()
      ?.providers.find(
        (entry) =>
          entry.accountId === accountId && entry.provider === quotaRowProviderOf(providerId),
      );
    return runOutOf(accountId)?.resetsAt ?? (row ? limitingResetOf(row, Date.now()) : undefined);
  };
  const askedOn = (providerId: string) =>
    loginLowAsked(supervisor.cards.stored(loginLowCardId(providerId))?.body ?? "");
  const lowLogins = new LowLogins({
    whenLow: () => options.settings.getWhenLoginLow(),
    providers: () =>
      PROVIDER_CATALOG.filter((entry) => vault.list(entry.id).length > 0).map((entry) => ({
        id: entry.id,
        name: entry.name,
      })),
    logins: (providerId) =>
      options.routing.accounts.logins(providerId).map((login) => {
        const runOut = runOutOf(login.accountId);
        return runOut ? { ...login, runOut } : login;
      }),
    pinOf: (providerId) => vault.pinnedAccount(providerId),
    setPin: (providerId, accountId) => vault.setPin(providerId, accountId),
    refillsOf: (providerId, accountId) => {
      const reset = refillsAt(providerId, accountId);
      return reset !== undefined ? resetWhen(reset, Date.now()) : undefined;
    },
    refillsAt,
    answered: (providerId) =>
      loginLowAnswer({ cards: supervisor.cards, settings, vault }, providerId),
    tasksOn: (accountId) => supervisor.loginMoves.tasksOn(accountId),
    unnamedOn: (accountId) => supervisor.loginMoves.unnamedOn(accountId),
    moveOff: (from, to, unnamedOnly) => supervisor.loginMoves.moveOff(from, to, unnamedOnly),
    forget: (from, to) => supervisor.loginMoves.forget(from, to),
    openOffers: () =>
      PROVIDER_CATALOG.flatMap((entry) => {
        const card = supervisor.cards.get(loginLowCardId(entry.id));
        if (!card) return [];
        const from = askedOn(entry.id)?.accountId;
        const to = vault
          .list(entry.id)
          .find((account) =>
            card.actions?.some((action) => action.id === moveLoginActionId(from ?? "", account.id)),
          )?.id;
        return [{ providerId: entry.id, ...(from ? { from } : {}), ...(to ? { to } : {}) }];
      }),
    endAnswer: (providerId) =>
      settings.setLoginAnswersOver({
        ...settings.getLoginAnswersOver(),
        [providerId]: askedOn(providerId)?.askId ?? "",
      }),
    cards: supervisor.cards.hostCards,
    note,
  });
  // A cut-off recorded or cleared changes which login has room before the next reading.
  vault.onCutOffChange(() => lowLogins.read());
  supervisor.loginMoves.onClick = (accountId) => lowLogins.move(accountId);
  options.routing.attachLoginInUse((providerId, accountId) =>
    note(
      said("feedLoginInUse", {
        provider: nameOf(providerId),
        login:
          vault.list(providerId).find((account) => account.id === accountId)?.label ?? accountId,
      }),
    ),
  );
  return lowLogins;
}
