import { type QuotaSnapshotView, rowMeasuresModel } from "@shared/quota";
import { servesOnlyLoginInUse, type WhenLoginLow } from "@shared/whenLoginLow";
import { quotaRowProviderOf } from "../quota/auth";
import { effectiveFromProvider, spentScopes } from "../quota/catalog";
import type { DecisionStore } from "../storage/decisionStore";
import {
  type AccountCandidate,
  type AccountSelectionDecision,
  isExhausted,
  selectAccount,
} from "./accountPolicy";
import type { PlacedWorkData, PlacedWorkScores } from "./placedWork";

/**
 * Binds the pure account-selection policy to live inputs (the vault's
 * account pool, the per-account quota snapshot, the provider pin, the
 * Firstmate flagship reservation) and records every decision with its
 * reasons in the decision ledger (`account` rows) - the "why this account"
 * surface, beside the `routing` rows.
 *
 * Selection happens only at attachment points: spawn and resume. A running
 * turn is never re-bound.
 */

/** The flagship keeps this much headroom in reserve from crewmate burn. */
export const FLAGSHIP_RESERVE_FLOOR_PERCENT = 15;

/** The slice of the vault the selector reads. */
export type AccountPool = {
  list(providerId?: string): {
    id: string;
    providerId: string;
    label: string;
    enabled: boolean;
    lastSelectedAt?: number;
  }[];
  pinnedAccount(providerId: string): string | undefined;
  connectedSync(accountId: string): boolean | undefined;
  /** Why a connected account serves nothing right now, if it does not. */
  withheldReason(accountId: string): string | undefined;
  markSelected(accountId: string): void;
};

export type AccountSelectorOptions = {
  pool: AccountPool;
  placedWork?: PlacedWorkScores;
  quota: { latest(): QuotaSnapshotView | undefined };
  /** The Firstmate flagship account to protect, when one is pinned. */
  flagshipAccountId: () => string | null;
  /** The decision ledger every selection is recorded in. */
  decisions: DecisionStore;
  /**
   * The models each account lists (`AccountVault.availableModelsByAccount`):
   * a crewmate's pick leaves out an account whose list names other models
   * but not this one, so the account bound serves the model routing chose.
   * An account with no list, or an empty one, stands in only when no
   * sibling's list names the model.
   */
  accountModels?: () => { accountId: string; models: { provider: string; id: string }[] }[];
  /**
   * The login in use (docs/quota.md, "When the login in use runs low"):
   * under `wait` and `ask` a provider's pin alone serves, and a provider
   * with several logins and no pin gets the picked one as its pin, which
   * `pin` saves and says once the pick stands. Absent, as on a computer
   * that runs work, the pick is by spend priority alone.
   */
  loginInUse?: {
    whenLow: () => WhenLoginLow;
    pin: (providerId: string, accountId: string) => void;
  };
};

export class AccountSelector {
  private readonly listsByEvaluation = new WeakMap<
    PlacedWorkData,
    ReturnType<NonNullable<AccountSelectorOptions["accountModels"]>> | undefined
  >();

  constructor(private readonly options: AccountSelectorOptions) {}

  /**
   * What a pick reads of the accounts, as one comparable string
   * (`AccountAttachment.servingState`): each account's state and the models
   * it lists, and whether each of its own allowance scopes is spent and
   * whether it answers on credits as read now (`spentScopes`), so a reset
   * that passes changes it with no new reading.
   */
  servingState(): string {
    const pool = this.options.pool;
    const rows = this.options.quota.latest()?.providers ?? [];
    const now = Date.now();
    return JSON.stringify([
      pool
        .list()
        .map((account) => [
          account.id,
          account.providerId,
          account.enabled,
          pool.connectedSync(account.id) ?? null,
          pool.withheldReason(account.id) ?? null,
          rows
            .filter((row) => row.accountId === account.id)
            .map((row) => [row.provider, spentScopes(row, now)]),
        ]),
      this.options.accountModels?.() ?? null,
    ]);
  }

  /**
   * Pick the account of `piProviderId` serving a task spawn, and record why.
   * A crewmate's spawn names its `crew` model: the accounts are read in that
   * model's scope and ranked by the crew allowance bands, as routing ranked
   * the model (INF-1714); a decision model's call names none.
   */
  async selectForSpawn(
    taskId: string,
    provider: string,
    crew?: { model: string },
  ): Promise<string | undefined> {
    const pick = await this.pickForSpawn(taskId, provider, crew);
    pick.record();
    pick.selected();
    return pick.accountId;
  }

  /**
   * The account `selectForSpawn` would pick, with its writes kept apart: a
   * move that may still be abandoned after the pick - a stop, a quit or
   * another move meanwhile - writes the decision row (`record`) in the
   * move's own transaction, and marks the account selected (`selected`, a
   * file write no transaction rolls back) only once that transaction
   * committed, so an abandoned move leaves neither. `only` names the one
   * login a low login's move may bind (`LoginMoves`): it is picked while it
   * serves the model, and nothing is picked otherwise.
   */
  async pickForSpawn(
    taskId: string,
    piProviderId: string,
    crew?: { model: string; passing?: readonly string[]; only?: string },
  ): Promise<{ accountId?: string; record(): void; selected(): void }> {
    const placed = await this.options.placedWork?.prepare(
      this.options.quota.latest()?.providers ?? [],
    );
    const decision = this.decide(piProviderId, crew, placed);
    if (!decision) return { record: () => {}, selected: () => {} };
    const record = () => {
      this.options.decisions.recordAccount({
        taskId,
        provider: piProviderId,
        accountId: decision.accountId ?? null,
        reasons: [...decision.reasons, ...this.withheldElsewhere(piProviderId)],
        facts: {
          kind: "account-candidates",
          candidates: decision.candidates,
          ...(decision.pinned ? { pinned: true as const } : {}),
        },
      });
    };
    const selected = () => {
      if (!decision.accountId) return;
      this.options.pool.markSelected(decision.accountId);
      this.pinLoginInUse(piProviderId, decision.accountId);
    };
    return { ...(decision.accountId ? { accountId: decision.accountId } : {}), record, selected };
  }

  /**
   * A resume keeps a healthy account; otherwise it prepares a serving
   * sibling, whose decision (`record`) and selection mark (`selected`) are
   * written only once the resumed conversation is accepted.
   */
  async reselectForResume(
    taskId: string,
    accountId: string | null,
  ): Promise<{ accountId?: string; changed: boolean; record?(): void; selected?(): void }> {
    if (accountId) {
      const account = this.options.pool.list().find((row) => row.id === accountId);
      if (account?.enabled && this.options.pool.connectedSync(accountId) !== false)
        return { accountId, changed: false };
    }
    const routed = this.options.decisions.latestRouting(taskId);
    if (!routed?.provider) return { changed: Boolean(accountId) };
    const pick = await this.pickForSpawn(
      taskId,
      routed.provider,
      routed.model ? { model: routed.model } : undefined,
    );
    return {
      ...(pick.accountId ? { accountId: pick.accountId } : {}),
      changed: pick.accountId !== (accountId ?? undefined),
      record: pick.record,
      selected: pick.selected,
    };
  }

  /**
   * The account a crewmate's spawn on `model` would bind now, recording
   * nothing: routing ranks the model by this account's reading, so the
   * model and the account that serves it are judged on the same facts.
   * `placed` is the work the routing evaluation already read.
   */
  crewAccount(
    piProviderId: string,
    model: string,
    placed: PlacedWorkData,
  ): string | null | undefined {
    const decision = this.decide(piProviderId, { model }, placed);
    if (decision?.accountId) return decision.accountId;
    // A login in use that cannot serve is not missing information: a spent
    // one ranks the model by its own reading, and any other serves nothing.
    if (decision?.held) return decision.held.spent ? decision.held.accountId : null;
    return undefined;
  }

  /** The enabled login the provider's pin names while the pin alone serves. */
  private loginInUse(piProviderId: string): { id: string; label: string } | undefined {
    if (!this.onlyLoginInUse()) return undefined;
    const pin = this.options.pool.pinnedAccount(piProviderId);
    return this.options.pool
      .list(piProviderId)
      .find((account) => account.id === pin && account.enabled);
  }

  /** Whether the provider's pin alone serves: the `wait` and `ask` choices. */
  private onlyLoginInUse(): boolean {
    const choice = this.options.loginInUse?.whenLow();
    return choice !== undefined && servesOnlyLoginInUse(choice);
  }

  /**
   * A provider with several logins and no login in use takes the one just
   * picked as its pin, so later work stays on it. A pin naming a login the
   * captain turned off or removed counts as none.
   */
  private pinLoginInUse(piProviderId: string, accountId: string): void {
    if (!this.onlyLoginInUse()) return;
    const logins = this.options.pool.list(piProviderId).filter((account) => account.enabled);
    if (logins.length < 2) return;
    const pin = this.options.pool.pinnedAccount(piProviderId);
    if (pin && logins.some((account) => account.id === pin)) return;
    this.options.loginInUse?.pin(piProviderId, accountId);
  }

  private decide(
    piProviderId: string,
    crew: { model: string; passing?: readonly string[]; only?: string } | undefined,
    placed: PlacedWorkData | undefined,
  ) {
    // A move to a named login reads that login alone, whatever the pin.
    if (crew?.only) {
      const named = this.candidatesFor(piProviderId, crew.model, placed, crew.only).filter(
        (row) => row.accountId === crew.only,
      );
      return named.length > 0
        ? selectAccount({ providerId: piProviderId, candidates: named, bands: true })
        : undefined;
    }
    // An account that already failed to open the model is passed over.
    const inUse = this.loginInUse(piProviderId);
    const candidates = this.candidatesFor(piProviderId, crew?.model, placed, inUse?.id).filter(
      (row) => !crew?.passing?.includes(row.accountId),
    );
    // A login in use that does not list the model, or failed to open it,
    // still stands between the work and every other login.
    if (inUse && !candidates.some((row) => row.accountId === inUse.id))
      return {
        held: { accountId: inUse.id, spent: false },
        reasons: [
          // i18n-exempt: a decision ledger reason the first mate reads, never shown
          `skipped ${inUse.label}: ${crew?.passing?.includes(inUse.id) ? "failed to open this model" : "does not list this model"}`,
          // i18n-exempt: a decision ledger reason the first mate reads, never shown
          `${inUse.label} is the ${piProviderId} login in use; no other login serves until it is moved`,
        ],
        candidates: [],
      } satisfies AccountSelectionDecision;
    if (candidates.length === 0) return undefined;
    const pinned = this.options.pool.pinnedAccount(piProviderId);
    const flagship = this.options.flagshipAccountId();
    return selectAccount({
      providerId: piProviderId,
      candidates,
      ...(pinned ? { pinnedAccountId: pinned } : {}),
      ...(this.onlyLoginInUse() ? { onlyPin: true } : {}),
      ...(flagship
        ? { protect: { accountId: flagship, floorPercent: FLAGSHIP_RESERVE_FLOOR_PERCENT } }
        : {}),
      ...(crew ? { bands: true } : {}),
    });
  }

  /**
   * Whether the account serves `model` now, as a pick reads it: on,
   * connected, withheld by nothing, with allowance left, and listing the
   * model - or listing nothing while no sibling's list names it.
   */
  servesNow(accountId: string, model: { provider: string; id: string }): boolean {
    const candidate = this.candidatesFor(model.provider, model.id, undefined).find(
      (row) => row.accountId === accountId,
    );
    return (
      candidate !== undefined &&
      candidate.enabled &&
      candidate.connected !== false &&
      candidate.withheld === undefined &&
      !isExhausted(candidate)
    );
  }

  /** A provider's logins as a pick reads them with no model named, for the low-login watch. */
  logins(piProviderId: string): AccountCandidate[] {
    return this.candidatesFor(piProviderId, undefined, undefined);
  }

  labelOf(accountId: string): string | undefined {
    return this.options.pool.list().find((account) => account.id === accountId)?.label;
  }

  /**
   * The accounts of other providers the pool left out because they serve
   * nothing right now (their models never reached routing), so the row says
   * why they were not in the running.
   */
  private withheldElsewhere(piProviderId: string): string[] {
    return this.options.pool.list().flatMap((account) => {
      if (account.providerId === piProviderId || !account.enabled) return [];
      const reason = this.options.pool.withheldReason(account.id);
      return reason
        ? [`skipped ${account.label} (${account.providerId}): withheld (${reason})`]
        : [];
    });
  }

  /**
   * Which models each account's sign-in lists, read once per routing
   * evaluation: every model it ranks shares that evaluation's `placed`
   * read, and an actual pick prepares its own.
   */
  private modelLists(placed: PlacedWorkData | undefined) {
    if (!placed) return this.options.accountModels?.();
    if (!this.listsByEvaluation.has(placed))
      this.listsByEvaluation.set(placed, this.options.accountModels?.());
    return this.listsByEvaluation.get(placed);
  }

  private candidatesFor(
    piProviderId: string,
    model: string | undefined,
    placed: PlacedWorkData | undefined,
    inUse?: string,
  ): AccountCandidate[] {
    const snapshot = this.options.quota.latest();
    const rows = placed?.readings ?? snapshot?.providers;
    const quotaId = quotaRowProviderOf(piProviderId);
    const now = Date.now();
    // Every account is scored against one read of the placed work.
    const placedWork = this.options.placedWork;
    const data = placed;
    const lists = model ? this.modelLists(placed) : undefined;
    // An account whose sign-in lists the model serves it; one with no list
    // yet stands in only when no sibling's list confirms the model.
    const serving = (accountId: string): boolean | undefined => {
      const listed = lists?.find((row) => row.accountId === accountId)?.models;
      if (!listed || listed.length === 0) return undefined;
      return listed.some((entry) => entry.provider === piProviderId && entry.id === model);
    };
    const accounts = this.options.pool.list(piProviderId);
    const confirmed = accounts.filter((account) => serving(account.id) === true);
    // The login in use with no list yet stands in beside a confirmed
    // sibling, since it alone may serve.
    const pool = accounts.filter((account) =>
      confirmed.length > 0 && account.id !== inUse
        ? serving(account.id) === true
        : serving(account.id) !== false,
    );
    return pool.map((account) => {
      const row = rows?.find(
        (provider) =>
          provider.accountId === account.id &&
          provider.provider === quotaId &&
          rowMeasuresModel(provider, model),
      );
      const effective = effectiveFromProvider(row, now, model);
      const score = row && data ? placedWork?.score(row, now, model, data) : undefined;
      const connected = this.options.pool.connectedSync(account.id);
      const withheld = this.options.pool.withheldReason(account.id);
      return {
        accountId: account.id,
        label: account.label,
        enabled: account.enabled,
        ...(connected !== undefined ? { connected } : {}),
        ...(withheld ? { withheld } : {}),
        ...(effective.effectivePercentRemaining !== undefined
          ? { effectivePercentRemaining: effective.effectivePercentRemaining }
          : {}),
        ...(effective.paceStatus ? { paceStatus: effective.paceStatus } : {}),
        ...(effective.spendPriority !== undefined
          ? { spendPriority: effective.spendPriority }
          : {}),
        ...(effective.lastsThroughReset !== undefined
          ? { lastsThroughReset: effective.lastsThroughReset }
          : {}),
        ...score,
        ...(effective.onCredits ? { onCredits: true, band: "credits" as const } : {}),
        ...(account.lastSelectedAt !== undefined ? { lastSelectedAt: account.lastSelectedAt } : {}),
      };
    });
  }
}
