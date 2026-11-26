import { accountsPoolOf } from "@shared/accountPools";
import type { CutOffClass } from "@shared/authFailure";
import { CLAUDE_ACCESS_PAUSED_SENTENCE, type ClaudeAccessSource } from "@shared/claudeAccess";
import { isClientIssueReason } from "@shared/claudeClient";
import { isCustomApiProvider } from "@shared/customApi";
import { HERE } from "@shared/deviceNames";
import {
  type BackendId,
  backendForProvider,
  isOfferedProvider,
  PROVIDER_CATALOG,
  providerServesRole,
} from "@shared/providers";
import {
  creditsOfferOf,
  inAccountsPool,
  type QuotaSnapshotView,
  quotaRowOf,
  savedResetsNow,
} from "@shared/quota";
import { allowanceSpent } from "@shared/quotaSignals";
import { CUT_OFF_REFUSED, CUT_OFF_SIGNED_OUT } from "../accounts/credentialHealth";
import type { ModelRuntime } from "../pi/types";
import { effectiveFromProvider, pooledBlockerOf } from "../quota/catalog";
import { SessionBinder } from "../session/binding";
import type { AccountDecisionInput } from "../storage/decisionStore";
import { allowanceSpentWords, type SeatBinding, type SeatPause, signedOutSentence } from "./seat";

/**
 * The Firstmate flagship binding (broker phase 6): the orchestrator pins
 * one account - a persisted setting exactly parallel to the fixed
 * Firstmate model: broker-derived once, user-visible, never silently
 * changed. The binding is a property of a session ATTACHMENT, not of the
 * transcript: it is re-resolved only at attachment points (app start,
 * explicit rebind at an idle boundary), never mid-turn.
 *
 * Which accounts are eligible is asserted three ways, so no single edit can
 * quietly widen it: the provider's catalog entry must list the firstmate
 * role, its backend must have a seat (`SEAT_BINDINGS`), and the vault
 * binding it produces must be one that seat stands on - `pi-runtime` for
 * Pi; for Claude the machine's `default-login` (W1, 2026-09-26) or a
 * further login's own folder, `config-dir`. A
 * single vendor cutting the seat off is a designed path, not a reason to
 * refuse it: a typed cut-off pauses the seat and asks (`pause`, and the
 * agent's ladder).
 */

/**
 * The backends that seat the Firstmate, each with the vault bindings its
 * seat stands on. A backend absent here has no seat factory, so none of its
 * accounts is eligible whatever the catalog says.
 */
export const SEAT_BINDINGS: Readonly<Record<BackendId, readonly string[]>> = {
  pi: ["pi-runtime"],
  claude: ["default-login", "config-dir"],
};

export type FlagshipVaultView = {
  list(providerId?: string): {
    id: string;
    providerId: string;
    label: string;
    enabled: boolean;
  }[];
  get(
    accountId: string,
  ): { id: string; providerId: string; label: string; enabled: boolean } | undefined;
  connectedSync(accountId: string): boolean | undefined;
  /** The one serveability predicate, from the last read (undefined = unread). */
  servesSync(accountId: string): boolean | undefined;
  /** Why a connected account serves nothing (`client_missing`, `refused`, ...). */
  withheldReason(accountId: string): string | undefined;
  /** The one sentence a client issue carries, when that is what withholds it. */
  withheldDetail(accountId: string): string | undefined;
  keepsGoingOnCredits?(accountId: string): boolean;
  /** The typed cut-off standing on the account (`AccountVault.noteCutOff`). */
  cutOff(accountId: string): { class: CutOffClass; resetsAt?: number } | undefined;
  /** The captain's "Try again" on a refusal; answers whether one stood. */
  tryAgain(accountId: string): boolean;
  /** The captain's "Try again" on a spent allowance a recheck saw unchanged (`AccountVault`). */
  tryPastSpent?(accountId: string): void;
  /** Whether the account goes by its provider's answers past its reading (`AccountVault`). */
  goesByAnswers?(accountId: string): boolean;
  /** Where a Claude account's access comes from when it is not a subscription. */
  accessSync?(accountId: string): ClaudeAccessSource | undefined;
  /** Who the account's own client last said is signed in, when it says. */
  identitySync?(accountId: string): string | undefined;
  runtimeFor(accountId: string): Promise<ModelRuntime>;
  binding(accountId: string): { via: string };
};

/**
 * What the seat's binding decided, as the one ledger's `account` row names
 * it (`taskId: "firstmate"`): the host's own record of every attachment,
 * move, pause and way back, with its typed reasons.
 */
export type SeatDecision =
  | "derived"
  | "pinned"
  | "rebound"
  | "move-offered"
  | "paused"
  | "moved"
  | "move-back-offered"
  | "serves-again"
  | "try-again"
  | "keep-going-on-credits"
  | "renewed";

export type FlagshipOptions = {
  vault: FlagshipVaultView;
  settings: {
    getFirstmateAccount(): string | null;
    setFirstmateAccount(accountId: string | null): void;
    getFirstmateModel?(): { provider: string; id: string } | null;
  };
  quota: {
    latest(): QuotaSnapshotView | undefined;
    /** The rows as read, where the served view differs from them (`QuotaService.latestMeasured`). */
    latestMeasured?(): QuotaSnapshotView | undefined;
  };
  /** The base runtime, serving custom providers and account-less setups. */
  baseRuntime: ModelRuntime;
  /** The one decision ledger the seat's binding decisions are recorded in. */
  decisions?: { recordAccount(input: AccountDecisionInput): number };
};

/** The ledger reason for the captain's Try again, on a refused account or past a spent reading. */
const CAPTAIN_TRIED_AGAIN = "the captain chose to try again";

export class Flagship {
  private readonly binder: SessionBinder;

  constructor(private readonly options: FlagshipOptions) {
    this.binder = new SessionBinder({
      runtimeFor: (accountId) => options.vault.runtimeFor(accountId),
      baseRuntime: options.baseRuntime,
    });
  }

  /**
   * Resolve the flagship at an attachment point: the persisted pin while it
   * is healthy, else a derived default (most headroom among the model
   * provider's eligible accounts) persisted so it never silently changes.
   * No eligible account means the base runtime (custom providers, e2e) -
   * for a Pi provider. The binding names the seat backend that serves it:
   * a Claude account's is the machine's own login, which the app never
   * builds a runtime for; a Claude model with no account to stand on has
   * nothing to answer it, so the attach fails the way a model with no
   * sign-in does.
   */
  async resolveBinding(modelProvider: string | undefined): Promise<SeatBinding> {
    const accountId = this.resolveAccountId(modelProvider);
    if (!accountId) {
      if (modelProvider && isCustomApiProvider(modelProvider))
        throw new Error(
          "This custom connection is paused, unchecked or disconnected. Choose its use in Intelligence.",
        );
      if (modelProvider && backendForProvider(modelProvider) !== "pi") {
        throw new Error(
          `No signed-in model is available for your first mate: ${this.providerNameOf(modelProvider)} is not connected.`,
        );
      }
      return this.binder.base();
    }
    // A resolved account is seatable, so its provider's backend is its seat's.
    return this.binder.bind(accountId, this.providerOf(accountId));
  }

  resolveAccountId(modelProvider: string | undefined): string | undefined {
    const persisted = this.options.settings.getFirstmateAccount();
    if (persisted && this.isEligible(persisted) && this.providerOf(persisted) === modelProvider) {
      return persisted;
    }
    if (!modelProvider) return undefined;
    // A generated connection is never derived or cleared by availability.
    // Its model/account choice is an explicit user placement, even while paused.
    if (isCustomApiProvider(modelProvider)) {
      return persisted && this.providerOf(persisted) === modelProvider ? persisted : undefined;
    }
    const derived = this.deriveForProvider(modelProvider);
    if (derived) {
      this.options.settings.setFirstmateAccount(derived);
      this.record("derived", derived, [
        persisted && persisted !== derived
          ? `the pinned ${this.labelOf(persisted) ?? persisted} cannot serve ${modelProvider}`
          : `no account pinned for ${modelProvider}`,
        `picked ${this.labelOf(derived) ?? derived}: most headroom among eligible accounts`,
      ]);
    } else if (persisted) {
      // A pin a fact pauses (a lost sign-in, a refusal, no client, a spent
      // allowance) with nothing to replace it stays bound: admission pauses
      // the seat on it and asks, rather than the seat answering on the base
      // runtime as if nothing were wrong.
      if (this.providerOf(persisted) === modelProvider && this.heldByFact(persisted)) {
        return persisted;
      }
      this.options.settings.setFirstmateAccount(null);
    }
    // Nothing pinned can serve, but an account of the model's provider is
    // paused by a fact: the seat stands on it the same way, unpinned.
    return (
      derived ??
      this.options.vault.list(modelProvider).find((account) => this.heldByFact(account.id))?.id
    );
  }

  private heldByFact(accountId: string): boolean {
    if (!this.seatable(accountId)) return false;
    const pause = this.pause(accountId);
    return pause !== undefined && pause.class !== "unavailable";
  }

  /** The best eligible account of a provider by headroom at pin time. */
  deriveForProvider(providerId: string): string | undefined {
    const candidates = this.options.vault
      .list(providerId)
      .filter((account) => this.isEligible(account.id));
    if (candidates.length === 0) return undefined;
    const measured = candidates
      .map((account) => ({ account, headroom: this.headroom(account.id) }))
      .filter(
        (entry): entry is { account: (typeof candidates)[number]; headroom: number } =>
          typeof entry.headroom === "number",
      )
      .sort((a, b) => b.headroom - a.headroom);
    return (measured[0]?.account ?? candidates[0])?.id;
  }

  /**
   * Seatable, and not known to serve nothing: disconnected, or withheld by
   * a fact beside its credential (a missing client, a standing cut-off) -
   * the same predicate the routing pool reads.
   */
  isEligible(accountId: string): boolean {
    return this.seatable(accountId) && this.options.vault.servesSync(accountId) !== false;
  }

  /**
   * The rules that are not facts about serving: enabled, the catalog role,
   * a backend with a seat, and the vault binding that seat stands on.
   */
  seatable(accountId: string): boolean {
    const account = this.options.vault.get(accountId);
    if (!account?.enabled) return false;
    if (!isOfferedProvider(account.providerId) && !isCustomApiProvider(account.providerId))
      return false;
    if (!providerServesRole(account.providerId, "firstmate")) return false;
    const seat = SEAT_BINDINGS[backendForProvider(account.providerId)];
    if (!seat) return false;
    try {
      return seat.includes(this.options.vault.binding(accountId).via);
    } catch {
      return false;
    }
  }

  /**
   * Whether a provider's models can answer a Firstmate turn now: its
   * catalog role, and - where it has accounts - one the seat can stand on.
   * A provider with no accounts is a custom one the base runtime serves,
   * which only a Pi provider can be. What an automatic model pick and the
   * first-run gate count (`resolveModel`, `FirstRunService`).
   */
  servesFirstmate(providerId: string): boolean {
    if (!providerServesRole(providerId, "firstmate")) return false;
    if (isCustomApiProvider(providerId)) {
      const selected = this.options.settings.getFirstmateModel?.();
      const accountId = this.options.settings.getFirstmateAccount();
      return selected?.provider === providerId && Boolean(accountId && this.isEligible(accountId));
    }
    const accounts = this.options.vault.list(providerId);
    if (accounts.length === 0) return backendForProvider(providerId) === "pi";
    return accounts.some((account) => this.isEligible(account.id));
  }

  /**
   * Whether an account the seat could stand on is only paused by a typed
   * cut-off (refused, a lost sign-in, a spent allowance) that the vault
   * holds - any such account, not only the one bound now: the seat has
   * somewhere to stand, waiting on its card, so the first-launch gate stays
   * down. A missing client, or a login never signed in, holds no
   * cut-off - nothing has answered yet, and the stage says why.
   */
  standsOnCutOff(): boolean {
    return this.options.vault
      .list()
      .some((account) => this.seatable(account.id) && this.options.vault.cutOff(account.id));
  }

  /**
   * Why an account cannot be the Firstmate, in the user's terms: the
   * binding explains itself rather than silently refusing. An account a
   * fact withholds says which fact, in its class's own words.
   */
  ineligibilityReason(accountId: string): string | undefined {
    const account = this.options.vault.get(accountId);
    if (!account) return "That account no longer exists.";
    if (!providerServesRole(account.providerId, "firstmate")) {
      return `${this.providerNameOf(account.providerId)} accounts cannot run your first mate.`;
    }
    if (!account.enabled) return `${account.label} is paused.`;
    const pause = this.pause(accountId);
    if (pause && pause.class !== "no_headroom" && pause.class !== "unavailable") {
      return this.pauseSentence(accountId, pause);
    }
    return this.isEligible(accountId) ? undefined : `${account.label} cannot run your first mate.`;
  }

  /**
   * Why the seat's account cannot serve the next turn, as a class the
   * ladder reads (docs/architecture.md §16 "A paused seat"), or undefined
   * when it can: gone or paused, a proven or typed lost sign-in, a
   * refusal, no client to run it, a spent allowance (a standing cut-off's
   * reset, else the quota reading), or eligibility's other rules. Every
   * input is a typed fact the vault or the quota reading holds.
   */
  pause(accountId: string): SeatPause | undefined {
    const vault = this.options.vault;
    const account = vault.get(accountId);
    if (!account?.enabled) return { class: "unavailable" };
    // A standing refusal outlives a lapsed sign-in: signing in again does not
    // clear it, so it is never read as a sign-in to ask for.
    if (vault.cutOff(accountId)?.class === "refused") return { class: "refused" };
    if (vault.connectedSync(accountId) === false) return { class: "signed_out" };
    const withheld = vault.withheldReason(accountId);
    if (withheld === CUT_OFF_REFUSED) return { class: "refused" };
    if (withheld === CUT_OFF_SIGNED_OUT) return { class: "signed_out" };
    if (isClientIssueReason(withheld)) return { class: "client" };
    if (!this.isEligible(accountId)) return { class: "unavailable" };
    const cutOff = vault.cutOff(accountId);
    if (cutOff?.class === "no_headroom") {
      return {
        class: "no_headroom",
        ...(cutOff.resetsAt !== undefined ? { resetsAt: cutOff.resetsAt } : {}),
      };
    }
    // An account that keeps going on credits answers past a spent
    // allowance, and so does one the captain tried past its reading; only
    // the provider's own refusal (the cut-off above) stops either.
    if (vault.goesByAnswers?.(accountId)) return undefined;
    const effective = effectiveFromProvider(this.snapshotRow(accountId), Date.now());
    return allowanceSpent(effective) ? { class: "no_headroom" } : undefined;
  }

  /**
   * The spent-allowance card's offer to keep going (INF-4104 piece 2): the
   * account's provider says its credits are available and its switch is
   * off. Undefined when there is nothing to offer.
   */
  creditsOffer(accountId: string): { usedPercent?: number; balance?: string } | undefined {
    const row = this.snapshotRow(accountId);
    // The switch itself, not the row's mark: a refusal held while it is on
    // leaves the row unmarked, and the switch is not offered again.
    if (!row || this.options.vault.keepsGoingOnCredits?.(accountId)) return undefined;
    return creditsOfferOf(row);
  }

  /**
   * The spent-allowance card's saved resets (docs/quota.md, "Saved resets"):
   * how many the account's provider says would apply now, by provider.
   * Undefined when none would, or the count is unknown.
   */
  savedResetsNow(accountId: string): { provider: string; count: number } | undefined {
    const row = this.snapshotRow(accountId);
    const count = savedResetsNow(row);
    return row && count !== undefined ? { provider: row.provider, count } : undefined;
  }

  /**
   * A paused account in one sentence of the user's words: what stopped it,
   * never how. A refusal names the provider, since the provider is what
   * stopped answering; the rest name the account.
   */
  pauseSentence(accountId: string, pause: SeatPause): string {
    const account = this.options.vault.get(accountId);
    const label = account?.label ?? "Its account";
    const provider = account ? this.providerNameOf(account.providerId) : "Its provider";
    switch (pause.class) {
      case "signed_out": {
        // Claude access set up for Claude Code is renewed where the person
        // renews it for Claude Code, never by a sign-in here.
        const access = this.accessOf(accountId);
        return access ? CLAUDE_ACCESS_PAUSED_SENTENCE[access] : signedOutSentence(label);
      }
      case "no_headroom": {
        const reset = this.resetText(accountId);
        return `${allowanceSpentWords(label)}${reset ? ` (${reset})` : ""}.`;
      }
      case "refused":
        return `${provider} is not answering your first mate right now.`;
      case "client":
        return (
          this.options.vault.withheldDetail(accountId) ?? `${provider} cannot run on ${HERE.this}.`
        );
      case "unavailable":
        return account ? `${label} cannot run your first mate.` : "That account no longer exists.";
    }
  }

  /**
   * The captain's "Try again" on a refused account: the refusal clears on
   * their word (S7's `tryAgain`), and the next turn is the attempt.
   */
  tryAgain(accountId: string): boolean {
    const cleared = this.options.vault.tryAgain(accountId);
    if (cleared) this.record("try-again", accountId, [CAPTAIN_TRIED_AGAIN]);
    return cleared;
  }

  /**
   * The captain's "Try again" on a spent allowance a recheck saw unchanged:
   * the hold ends on their word, the account goes by its provider's
   * answers until it refuses again, and the next turn is the attempt.
   */
  tryPastSpent(accountId: string): void {
    this.options.vault.tryPastSpent?.(accountId);
    this.record("try-again", accountId, [CAPTAIN_TRIED_AGAIN]);
  }

  /**
   * One seat-binding decision on the ledger (`account`, task "firstmate"):
   * what was decided about which account, and why.
   */
  record(decision: SeatDecision, accountId: string | null, reasons: readonly string[]): void {
    const providerId = accountId ? this.providerOf(accountId) : undefined;
    this.options.decisions?.recordAccount({
      taskId: "firstmate",
      provider: providerId ?? "none",
      accountId,
      reasons: [`seat ${decision}`, ...reasons],
    });
  }

  accountCount(providerId: string): number {
    return this.options.vault.list(providerId).length;
  }

  labelOf(accountId: string): string | undefined {
    return this.options.vault.get(accountId)?.label;
  }

  /** Where a Claude account's access comes from when it is not a subscription. */
  accessOf(accountId: string): ClaudeAccessSource | undefined {
    return this.options.vault.accessSync?.(accountId);
  }

  providerOf(accountId: string): string | undefined {
    return this.options.vault.get(accountId)?.providerId;
  }

  providerNameOf(providerId: string): string {
    if (isCustomApiProvider(providerId))
      return this.options.vault.list(providerId)[0]?.label ?? "Custom API";
    return PROVIDER_CATALOG.find((entry) => entry.id === providerId)?.name ?? providerId;
  }

  headroom(accountId: string): number | undefined {
    return effectiveFromProvider(this.snapshotRow(accountId), Date.now()).effectivePercentRemaining;
  }

  /**
   * The account's last allowance reading, for the spent-allowance card:
   * when it was taken, whether this refresh read it (rather than carrying
   * an older one forward), and who the account's client says is signed in.
   * A row that holds no reading was not read: one known only through its
   * provider's refusal (`unread`), whose time is the refusal's and no
   * reading's, or an answer that carried no share. One none of whose
   * windows carries a share now, as a login no session has reported on
   * yet, was not read either, and names when a share last was if known.
   */
  allowanceCheck(
    accountId: string,
  ): { at: number; read: true; identity?: string } | { at?: number; read: false } | undefined {
    // The reading itself, not the served row: a refusal laid over a login
    // whose reading failed or never happened is no reading of it.
    const row = this.snapshotRow(accountId, "measured");
    if (!row) return undefined;
    if (row.unread) return { read: false };
    const shareRead = row.windows.some((window) => typeof window.percentRemaining === "number");
    // Not read now, and last read when a share last was: a row with no
    // share left in its windows can still know that time, as a login whose
    // sessions reported one before a refusal that has since ended.
    if (row.status !== "ok" || row.stale || !shareRead)
      return { read: false, ...(row.measuredAt !== undefined ? { at: row.measuredAt } : {}) };
    const identity = this.options.vault.identitySync?.(accountId);
    return {
      at: row.measuredAt ?? this.options.quota.latest()?.fetchedAt ?? Date.now(),
      read: true,
      ...(identity ? { identity } : {}),
    };
  }

  /** When the flagship's quota resets, for user-facing ladder copy. */
  resetText(accountId: string): string | undefined {
    const row = this.snapshotRow(accountId);
    if (!row) return undefined;
    // A login of a pool is back when what blocks the first mate's model is
    // gone, and names no time when that is not known.
    const pools = this.options.quota.latest()?.pools;
    if (inAccountsPool(accountsPoolOf(pools, row.provider), accountId)) {
      const blocker = pooledBlockerOf(row, Date.now(), this.modelOn(accountId));
      if (blocker) return blocker.resetText;
    }
    const bounding = [...row.windows]
      .filter((window) => typeof window.percentRemaining === "number")
      .sort((a, b) => (a.percentRemaining ?? 0) - (b.percentRemaining ?? 0))[0];
    return bounding?.resetText;
  }

  /**
   * The account's allowance is spent and it answers on credits (its switch
   * is on): it serves, but only after every sibling with included allowance.
   */
  onCredits(accountId: string): boolean {
    return effectiveFromProvider(this.snapshotRow(accountId), Date.now()).onCredits === true;
  }

  /**
   * Ladder rung 1: a sibling account of the same provider worth rebinding
   * to - measured headroom first; an unknown-quota sibling is still better
   * than benching the orchestrator; last, a sibling that serves on its
   * credits. `measured` asks only for a sibling with measured headroom: the
   * one a seat on credits moves to, since credits come last.
   */
  sibling(accountId: string, only?: "measured"): { id: string; label: string } | undefined {
    const account = this.options.vault.get(accountId);
    if (!account) return undefined;
    const siblings = this.options.vault
      .list(account.providerId)
      .filter((entry) => entry.id !== accountId && this.isEligible(entry.id));
    const measured = siblings.find((entry) => {
      const headroom = this.headroom(entry.id);
      return typeof headroom === "number" && headroom > 0;
    });
    const chosen =
      only === "measured"
        ? measured
        : (measured ??
          siblings.find((entry) => this.headroom(entry.id) === undefined) ??
          siblings.find((entry) => this.onCredits(entry.id) && !this.pause(entry.id)));
    return chosen ? { id: chosen.id, label: chosen.label } : undefined;
  }

  /**
   * Ladder rung 2: another provider with measured headroom. A cross-provider
   * move is also a model change - captain territory - so this only feeds a
   * decision card, never an automatic move.
   */
  otherProviderOption(
    excludeProviderId: string,
  ): { providerId: string; providerName: string } | undefined {
    for (const entry of PROVIDER_CATALOG) {
      if (entry.id === excludeProviderId) continue;
      // A rung the Firstmate cannot actually stand on is not a rung.
      if (!providerServesRole(entry.id, "firstmate")) continue;
      const hasHeadroom = this.options.vault.list(entry.id).some((account) => {
        if (!this.isEligible(account.id)) return false;
        const headroom = this.headroom(account.id);
        return typeof headroom === "number" && headroom > 0;
      });
      if (hasHeadroom) return { providerId: entry.id, providerName: entry.name };
    }
    return undefined;
  }

  /** Ladder rung 3 copy: what is exhausted and when it comes back. */
  exhaustionSummary(providerId: string): string {
    const lines = this.options.vault.list(providerId).flatMap((account) => {
      const reset = this.resetText(account.id);
      return reset ? [`${account.label} ${reset}`] : [];
    });
    return lines.length > 0 ? lines.join("; ") : "no reset times are known yet";
  }

  /** The first mate's model, when `accountId` is a login of its provider. */
  private modelOn(accountId: string): string | undefined {
    const selected = this.options.settings.getFirstmateModel?.();
    return selected && selected.provider === this.providerOf(accountId) ? selected.id : undefined;
  }

  /**
   * The reading of the account that serves the first mate's model: a
   * connection to a CLI proxy has a row per pool, and the first mate's
   * model's pool is the one it pauses, keeps headroom and resets by.
   */
  private snapshotRow(accountId: string, as?: "measured") {
    const modelId = this.modelOn(accountId);
    const { quota } = this.options;
    const snapshot =
      as === "measured" && quota.latestMeasured ? quota.latestMeasured() : quota.latest();
    return quotaRowOf(snapshot?.providers, accountId, modelId);
  }
}
