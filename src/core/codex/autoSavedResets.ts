import type {
  DecisionAnswer,
  DecisionCaller,
  DecisionQuestion,
  DecisionState,
} from "@shared/decisions";
import type { DecisionUseId } from "@shared/decisionUses";
import {
  type QuotaProviderView,
  type QuotaSnapshotView,
  savedResetsNow,
  servedProviderOf,
} from "@shared/quota";
import type { SavedResetResult } from "@shared/savedResets";
import { effectiveFromProvider } from "../quota/catalog";

/**
 * Use saved resets on their own (docs/quota.md "Saved resets on their own",
 * INF-5478's plan, piece 2): an account whose switch is on may have one of
 * its saved Codex resets used without a click, only when work waits on its
 * spent allowance and no account at that level has room - a committed crew
 * decision that waits or drops a level, or keeps going on credits, and the
 * first mate's ladder after its sibling move. Whether a reset beats waiting
 * for the refill is a judgment, so one decision question weighs it, asked
 * once per spent allowance of an account; an abstention, a failure, that
 * use switched off or the account's switch off all mean wait, and the
 * run-out card keeps its button.
 */

/** The question: use one of the account's saved resets now, or wait for the refill. */
// i18n-exempt: a question served to the decision model, not shown to a person
export const SAVED_RESET_QUESTION: DecisionQuestion = {
  type: "choice",
  version: "sr1",
  instructions: [
    "An assistant's work waits because a Codex account's plan allowance is used up, and no other account at that level has room.",
    "The account holds saved resets: each one refills the plan's spent allowance once, cannot be given back, and expires if never used.",
    "The person turned on using saved resets without asking, and leaves to you whether using one now beats waiting for the allowance to refill on its own.",
    "Choose use when the wait for the refill is long enough that the waiting work is worth a reset.",
    "Choose wait when the allowance refills soon, so a reset would mostly be thrown away.",
  ].join("\n"),
  criteria: {
    use: "Using one saved reset now is worth more than waiting for the refill.",
    wait: "Waiting for the allowance to refill on its own is better than using a reset now.",
  },
  abstain: "wait",
};

/** The work that waits on the spent allowance, as the question names it. */
export type WaitingWork = "crew task" | "first mate";

const HOUR_MS = 3600_000;

/** What the question sends about one spent account: its plan, its windows and its resets. */
export function savedResetState(
  row: QuotaProviderView,
  waiting: WaitingWork,
  now: number,
): DecisionState {
  const facts: DecisionState["facts"] = {
    waiting_work: waiting,
    plan: row.plan ?? null,
    saved_resets_held: row.savedResets?.available ?? null,
    saved_resets_that_apply_now: row.savedResets?.applicable ?? null,
  };
  for (const window of row.windows ?? []) {
    facts[`${window.id}_percent_left`] = window.percentRemaining ?? null;
    facts[`${window.id}_refills_in_hours`] =
      window.resetsAtMs !== undefined
        ? Math.max(0, Math.round(((window.resetsAtMs - now) / HOUR_MS) * 10) / 10)
        : null;
  }
  return { facts };
}

/** The decision service as the question reaches it. */
export type SavedResetModels = {
  decide(
    caller: DecisionCaller & { use: DecisionUseId },
    state: DecisionState,
    questions: Record<string, DecisionQuestion>,
    signal: AbortSignal,
  ): Promise<Record<string, DecisionAnswer>>;
  allowsUse(id: DecisionUseId): boolean;
};

export type AutoSavedResetsOptions = {
  models: SavedResetModels;
  /** Whether the account's switch is on, here or on that computer. */
  switchOn: (accountId: string, deviceId?: string) => boolean;
  /** The newest allowance reading, this Mac's own or that computer's. */
  latest: (deviceId?: string) => QuotaSnapshotView | undefined;
  /** Whether that computer can use a saved reset now: it takes the order and is in reach. */
  canUse: (deviceId: string) => boolean;
  /** Uses one saved reset of the account, saying its own feed line (`SavedResets.use`). */
  use: (accountId: string, deviceId?: string) => Promise<SavedResetResult>;
  /** One feed line, for a use that failed. */
  note: (text: string) => void;
  now: () => number;
};

/** The once-per-spent-allowance question and the use it may lead to. */
export class AutoSavedResets {
  /** Each account asked about since its allowance last answered, by its key. */
  private readonly asked = new Set<string>();

  constructor(private readonly options: AutoSavedResetsOptions) {}

  /**
   * Work waits on these providers' spent allowance, on this Mac or on
   * `deviceId`: each of their accounts whose switch is on, whose allowance
   * is spent and which holds a saved reset that applies now is weighed
   * once. Answers when every question asked has ended.
   */
  async spentAt(piProviders: readonly string[], waiting: WaitingWork, deviceId?: string) {
    if (deviceId && !this.options.canUse(deviceId)) return;
    const rows = (this.options.latest(deviceId)?.providers ?? []).filter(
      (row) => row.accountId && piProviders.includes(servedProviderOf(row.provider)),
    );
    await Promise.all(rows.map((row) => this.weigh(row, waiting, deviceId)));
  }

  /** The first mate's own account is spent and no sibling has room: weigh that account. */
  async spentHere(accountId: string): Promise<void> {
    const row = this.options.latest()?.providers.find((each) => each.accountId === accountId);
    // i18n-exempt: a fact served to the decision model, not shown to a person
    if (row) await this.weigh(row, "first mate");
  }

  /**
   * A new reading, here or on that computer: an account whose allowance
   * answers again may be weighed again when it is next spent.
   */
  read(deviceId?: string): void {
    const now = this.options.now();
    for (const row of this.options.latest(deviceId)?.providers ?? []) {
      if (!row.accountId) continue;
      const left = effectiveFromProvider(row, now).effectivePercentRemaining;
      if (left !== undefined && left > 0) this.asked.delete(keyOf(row.accountId, deviceId));
    }
  }

  private async weigh(
    row: QuotaProviderView,
    waiting: WaitingWork,
    deviceId?: string,
  ): Promise<void> {
    const accountId = row.accountId;
    if (!accountId || !this.options.switchOn(accountId, deviceId)) return;
    if (savedResetsNow(row) === undefined) return;
    const now = this.options.now();
    const left = effectiveFromProvider(row, now).effectivePercentRemaining;
    if (left === undefined || left > 0) return;
    const key = keyOf(accountId, deviceId);
    if (this.asked.has(key)) return;
    // A use turned on while the allowance is already spent still asks then.
    if (!this.options.models.allowsUse("saved-reset")) return;
    this.asked.add(key);
    const answers = await this.options.models.decide(
      { purpose: "saved-reset", use: "saved-reset" },
      savedResetState(row, waiting, now),
      { reset: SAVED_RESET_QUESTION },
      new AbortController().signal,
    );
    const answer = answers.reset;
    if (answer?.outcome !== "answered" || answer.value !== "use") return;
    // The switch may have been turned off while the question ran.
    if (!this.options.switchOn(accountId, deviceId)) return;
    await this.options.use(accountId, deviceId).catch((error: unknown) => {
      this.options.note(error instanceof Error ? error.message : String(error));
    });
  }
}

function keyOf(accountId: string, deviceId?: string): string {
  return deviceId ? `${accountId}@${deviceId}` : accountId;
}

/** The home's own: this Mac's vault and readings, and each computer that runs work's as it last said. */
export function homeAutoSavedResets(options: {
  models: SavedResetModels;
  deviceSignIns: {
    lastSaid(deviceId: string): {
      accounts: { id: string; useSavedResets?: boolean | undefined }[];
      quota?: QuotaSnapshotView | null | undefined;
    } | null;
    canUseSavedReset(deviceId: string): boolean;
    takesAutoSavedResets(deviceId: string): boolean;
  };
  vault: { usesSavedResets(accountId: string): boolean };
  quota: { latest(): QuotaSnapshotView | undefined };
  /** `SavedResets.use`. */
  use: (accountId: string, options: { deviceId?: string; auto: true }) => Promise<SavedResetResult>;
  note: (text: string) => void;
}): AutoSavedResets {
  const { deviceSignIns } = options;
  return new AutoSavedResets({
    models: options.models,
    switchOn: (accountId, deviceId) =>
      deviceId
        ? deviceSignIns
            .lastSaid(deviceId)
            ?.accounts.some((account) => account.id === accountId && account.useSavedResets) ===
          true
        : options.vault.usesSavedResets(accountId),
    latest: (deviceId) =>
      deviceId ? (deviceSignIns.lastSaid(deviceId)?.quota ?? undefined) : options.quota.latest(),
    canUse: (deviceId) =>
      deviceSignIns.canUseSavedReset(deviceId) && deviceSignIns.takesAutoSavedResets(deviceId),
    use: (accountId, deviceId) =>
      options.use(accountId, { ...(deviceId ? { deviceId } : {}), auto: true }),
    note: options.note,
    now: Date.now,
  });
}
