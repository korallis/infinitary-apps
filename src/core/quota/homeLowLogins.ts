import type { FmEvent } from "@shared/events";
import { type Said, said, saidLine } from "@shared/i18n/said";
import { PROVIDER_CATALOG } from "@shared/providers";
import { type QuotaSnapshotView, resetWhen } from "@shared/quota";
import type { WhenLoginLow } from "@shared/whenLoginLow";
import { LOGIN_LOW_WAIT, loginLowAsked, loginLowCardId } from "../orchestrator/loginCards";
import type { LoginMoves } from "../orchestrator/loginMoves";
import { quotaRowProviderOf } from "./auth";
import { limitingResetOf } from "./catalog";
import { type LoginReading, LowLogins, type LowLoginsOptions } from "./lowLogins";

/**
 * The home's watch over its own logins that run low (docs/quota.md, "When
 * the login in use runs low"): `LowLogins` over this computer's vault,
 * allowance readings and started tasks. A computer that runs work keeps its
 * own pick and is not watched from here.
 */
export function startLowLogins(options: {
  settings: { getWhenLoginLow(): WhenLoginLow };
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
    };
    loginMoves: LoginMoves;
  };
  broadcastEvent: (event: FmEvent) => void;
}): LowLogins {
  const { vault, quota, supervisor } = options;
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
    waitedOn: (providerId) => {
      const id = loginLowCardId(providerId);
      if (supervisor.cards.chosenAction(id) !== LOGIN_LOW_WAIT) return undefined;
      const asked = loginLowAsked(supervisor.cards.stored(id)?.body ?? "");
      // Past the refill the card named, a login low again is a new run-out.
      return asked && (asked.refillsAt === undefined || Date.now() < asked.refillsAt)
        ? asked.accountId
        : undefined;
    },
    tasksOn: (accountId) => supervisor.loginMoves.tasksOn(accountId),
    moveOff: (from, to) => supervisor.loginMoves.moveOff(from, to),
    forget: (from) => supervisor.loginMoves.forget(from),
    waitChosen: (providerId) =>
      supervisor.cards.chosenAction(loginLowCardId(providerId)) === LOGIN_LOW_WAIT,
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
