import type { CutOff } from "@shared/authFailure";
import {
  accountIdFromNeedsReauthCard,
  needsReauthCopy,
  REFRESH_TOKEN_LAPSED,
} from "@shared/credentialHealth";
import {
  BEDROCK_PROFILE_UNAVAILABLE,
  BEDROCK_PROVIDER_ID,
  BEDROCK_SIGN_IN,
  CLAUDE_PROVIDER_ID,
} from "@shared/providers";
import { formatBedrockSpend, type QuotaSnapshotView } from "@shared/quota";
import type { ClaudeAccess } from "../claude/claudeAccess";
import type { ClaudeRateLimit } from "../claude/claudeEvents";
import { CLAUDE_MODELS } from "../claude/claudeModels";
import {
  claudeCredentialStamp,
  defaultClaudeConfigDir,
  readClaudeStore,
} from "../claude/claudeQuota";
import type { HostCapabilities } from "../host";
import type { ServedModels } from "../models/servedModels";
import type { CardService } from "../orchestrator/cardService";
import type { AccountVault } from "../pi/accountVault";
import type { PiAuthService } from "../pi/piAuth";
import type { StandIns } from "../standIns";
import type { AppDatabase } from "../storage/db";
import { UsageStore } from "../storage/usageStore";
import { type QuotaCatalogModel, quotaEntryForPiProvider } from "./auth";
import { buildModelsCatalog, effectiveFromProvider } from "./catalog";
import { managedFromClaudeStore } from "./claudeAuthResolve";
import { CreditsWatch, stampSnapshot, stampSwitch } from "./creditsSwitch";
import { createQuotaFetcher } from "./fetchQuota";
import { createFixtureRefresh } from "./fixture";
import { createQuotaHttp } from "./http";
import { needsReauthTargets } from "./needsReauth";
import { claudeAccessOutcome, type ProviderOutcome } from "./outcome";
import {
  PushedQuotaStore,
  pushedCredits,
  pushedOnlyProviderViews,
  pushedProviderViews,
  withPushedCredits,
  withRejectedReadings,
} from "./pushedQuota";
import { type QuotaRefresh, QuotaService } from "./quotaService";
import { lowestLeft, recordCutOff } from "./spentAllowance";

/**
 * The home's allowance wiring (docs/quota.md): the sensor that reads each
 * enabled account's allowance from that account's own store (broker phase
 * 2), the readings a session pushes, the cut-offs a session observes, and
 * the catalog routing walks. Unknown is never zero, and only a refused
 * refresh token or a 401 that survived a real renewal says sign in again.
 */
export type HomeQuota = {
  quota: QuotaService;
  /** Plan-window readings a session pushed, and the refusals among them. */
  pushed: PushedQuotaStore;
  /** Every model the quota catalog carries: provider-wide, served-aware. */
  catalogModels: () => QuotaCatalogModel[];
  /**
   * A plan-window reading a Claude client pushed - a crewmate's, the
   * classifier's or the seat's - recorded for the account's quota.
   */
  recordClaudeRateLimit: (accountId: string, reading: ClaudeRateLimit) => void;
  /** A typed cut-off a session observed, recorded on its account (`recordCutOff`). */
  noteCutOff: (accountId: string, cutOff: CutOff) => void;
  /** The first mate's one-line allowance digest (`quotaContextLine`). */
  contextLine: () => string;
  /**
   * A changed login (the machine's Claude login switched, say): what the old
   * login was refused or read is not this account's any more, so its saved
   * refusals and last reading go and a new reading is taken now
   * (docs/quota.md "A changed login").
   */
  forgetLogin: (accountId: string) => void;
  /**
   * CD-3=A: the terminal needs_reauth card is raised only from a quota row
   * that is already auth_required (proof-gated). Recovered rows drop the
   * matching singleton. A !connected sweep is not proof and must never
   * mint this card - first-run, unknown, and retryable misses stay quiet.
   */
  syncNeedsReauthCards: (
    snapshot: QuotaSnapshotView,
    cards: Pick<CardService, "hostCards" | "snapshot">,
  ) => void;
  /**
   * Keep going on credits (docs/quota.md): what a new snapshot changed for
   * an account that keeps going - its feed lines, said once - and a spent
   * allowance held after a refusal ends once credits answer again.
   */
  noteCredits: (snapshot: QuotaSnapshotView) => string[];
  /** An account's Keep going on credits switch, set and read at once by routing and the seat. */
  setKeepGoingOnCredits: (accountId: string, on: boolean) => void;
};

/**
 * The Claude config root this account's client runs on when it is Claude,
 * or nothing: a further login's own folder, else the machine's default
 * one. Locations only - never a credential. CD-1=B: for the first login it
 * is not the vault account directory, which is bookkeeping only.
 */
export function claudeStoreDirOf(vault: AccountVault, accountId: string): string | undefined {
  const account = vault.list().find((row) => row.id === accountId);
  if (!account || quotaEntryForPiProvider(account.providerId)?.quotaId !== "claude") {
    return undefined;
  }
  return vault.claudeConfigDir(accountId) ?? defaultClaudeConfigDir();
}

/**
 * Whether the account's allowance is measured only by what its sessions
 * push: a provider no sensor covers, or a further Claude login, whose
 * usage only Claude Code reports and whose sign-in Infinitary never opens
 * to ask Anthropic's usage address with.
 */
function pushedOnly(vault: AccountVault, account: { id: string; providerId: string }): boolean {
  const entry = quotaEntryForPiProvider(account.providerId);
  if (!entry) return false;
  return !entry.sensed || vault.claudeConfigDir(account.id) !== undefined;
}

export function startHomeQuota(options: {
  host: Pick<HostCapabilities, "keychain">;
  standIns: Pick<StandIns, "quotaFixtureDir" | "quotaEndpoints">;
  db: AppDatabase;
  vault: AccountVault;
  served: ServedModels;
  auth: PiAuthService;
  /** Each new snapshot, once read. */
  broadcast: (snapshot: QuotaSnapshotView) => void;
  /** Claude access an organization or the person set up for Claude Code (`ClaudeAuthBackend.access`). */
  claudeAccess?: () => Promise<ClaudeAccess | undefined>;
}): HomeQuota {
  const { host, db, vault, served, auth } = options;
  const pushedQuota = new PushedQuotaStore(db);
  const usage = new UsageStore(db);
  // The row carries the switch only while the provider has not refused the
  // account, so a refusal moves work to another account.
  const keepsGoing = (accountId: string) => vault.servesOnCredits(accountId);
  const creditsWatch = new CreditsWatch((accountId) => vault.keepsGoingOnCredits(accountId));
  const quotaUnresolved = new Map<string, ProviderOutcome>();
  /**
   * The quota catalog's rows for a client-served provider: the shipped list
   * plus whatever a successful read added, named as the shipped list names
   * them where it does. The catalog is provider-wide on purpose - it is
   * what routing walks, so every served id must have a row.
   */
  const servedCatalogModels = (
    providerId: string,
    shipped: ReadonlyArray<{ id: string; name: string }>,
  ): { provider: string; id: string; name: string }[] => {
    const byId = new Map(shipped.map((model) => [model.id, model.name]));
    for (const account of vault.list()) {
      if (account.providerId !== providerId || !account.enabled) continue;
      for (const model of served.read(account.id)?.models ?? []) {
        if (!byId.has(model.id)) byId.set(model.id, model.name ?? model.id);
      }
    }
    return [...byId.entries()].map(([id, name]) => ({ provider: providerId, id, name }));
  };
  const catalogModels = () => [
    ...auth.catalogModels(vault.piModelRuntimes()),
    ...servedCatalogModels(CLAUDE_PROVIDER_ID, CLAUDE_MODELS),
  ];
  const resolveQuotaAuth = async (accountId: string, resolve?: { allowPrompt?: boolean }) => {
    // A Claude account's usage credential is the machine's default
    // login (bare Keychain item / ~/.claude). Every other sensed account
    // resolves through its Pi runtime. Infinitary never mints Anthropic OAuth.
    const claudeDir = claudeStoreDirOf(vault, accountId);
    if (claudeDir !== undefined) {
      // Access set up for Claude Code serves no subscription allowance, and
      // its sign-in is not the store's: the store is not read.
      const access = await options.claudeAccess?.();
      if (access) {
        quotaUnresolved.set(accountId, claudeAccessOutcome(access.source));
        return undefined;
      }
      const read = await readClaudeStore(claudeDir, {
        keychain: host.keychain,
        allowPrompt: resolve?.allowPrompt,
      });
      vault.noteCredentialRead(
        accountId,
        claudeCredentialStamp(read),
        read.state === "present" ? read.identity : undefined,
      );
      const mapped = managedFromClaudeStore(read);
      if (mapped.unresolved) quotaUnresolved.set(accountId, mapped.unresolved);
      else quotaUnresolved.delete(accountId);
      return mapped.managed;
    }
    return vault.resolveForQuota(accountId);
  };
  // The lowest percent left in each account's latest sensed reading, before
  // a refusal is laid over it: what a Claude refusal is held against.
  const sensedLeft = new Map<string, number>();
  const endRefusedReadings = (accountId: string) => {
    for (const window of pushedQuota.windowsFor(accountId)) {
      if (window.status === "rejected") {
        // Ending the refusal is not a new word from the session: whether it
        // was answering on extra usage is not carried to the new time.
        const { usingOverage: _using, ...rest } = window;
        pushedQuota.record(accountId, { ...rest, status: "allowed", at: Date.now() });
      }
    }
  };
  // Dev/e2e can point the quota sensor at fixture files instead of live APIs.
  const fixtureDir = options.standIns.quotaFixtureDir;
  const quotaRefresh: QuotaRefresh = fixtureDir
    ? createFixtureRefresh(fixtureDir)
    : createQuotaFetcher({
        // One sensor call per enabled account, resolved from that account's
        // own store (broker phase 2).
        auth: {
          accounts: () =>
            vault.list().flatMap((account) => {
              if (!account.enabled) return [];
              const entry = quotaEntryForPiProvider(account.providerId);
              if (!entry?.sensed || pushedOnly(vault, account)) return [];
              return [
                {
                  accountId: account.id,
                  accountLabel: account.label,
                  quotaId: entry.quotaId,
                  piId: entry.piId,
                  providerLabel: entry.label,
                },
              ];
            }),
          resolve: resolveQuotaAuth,
          // A Pi account whose refresh token the provider refused is the
          // lapsed-sign-in proof: the row says sign in again.
          unresolved: (accountId) =>
            quotaUnresolved.get(accountId) ??
            (vault.refreshLapsed(accountId)
              ? { status: "auth_required", windows: [], reason: REFRESH_TOKEN_LAPSED }
              : undefined),
          /**
           * One caller of AccountBackend.renew (spec §11.2.5): the reactive
           * 401 path. Non-Claude proactive renew rides the supervisor
           * tick. Neither path returns a secret; we re-resolve after a
           * successful rotation.
           */
          renew: async (accountId) => {
            const outcome = await vault.renew(accountId, "vendor_rejected");
            if (outcome.outcome !== "renewed") return { outcome: outcome.outcome };
            const managed = await resolveQuotaAuth(accountId);
            return managed
              ? { outcome: "renewed" as const, auth: managed }
              : { outcome: "unreadable" as const };
          },
        },
        http: createQuotaHttp(),
        // Dev/e2e only, exactly like the fixture seam above: a packaged app
        // never reads it, so the real endpoints cannot be redirected in a
        // build anyone runs.
        ...(options.standIns.quotaEndpoints ? { endpoints: options.standIns.quotaEndpoints } : {}),
        models: () => catalogModels(),
        loginOf: (accountId) => vault.loginSync(accountId),
        // A session's refusal is a zero window until its reset, even on a
        // sensed row: the vendor said no, and the sensor lags behind it.
        onAccepted: (accountId, windows) => {
          vault.noteAccepted(accountId);
          // More left than when the allowance was refused: credits were
          // added, so the hold and its refused reading end now.
          const left = lowestLeft(windows);
          if (left === undefined) sensedLeft.delete(accountId);
          else sensedLeft.set(accountId, left);
          if (left !== undefined && vault.noteReading(accountId, left))
            endRefusedReadings(accountId);
        },
        overlay: (view, now) => {
          if (!view.accountId) return view;
          const readings = pushedQuota.windowsFor(view.accountId);
          return stampSwitch(
            withPushedCredits(withRejectedReadings(view, readings, now), readings, now),
            keepsGoing,
          );
        },
        // Session-pushed readings still merge for any provider the HTTP
        // sensor does not cover.
        pushed: (now) => [
          ...vault
            .list()
            .filter((account) => account.providerId === BEDROCK_PROVIDER_ID)
            .map((account) => {
              const estimate = usage.monthlyAccountEstimate(account.id, BEDROCK_PROVIDER_ID, now);
              const spend = formatBedrockSpend(estimate.cost, estimate.partial);
              const signedOut = vault.cutOff(account.id)?.class === "signed_out";
              const profileUnavailable = !signedOut && vault.bedrockProfileUnavailable(account.id);
              return {
                provider: BEDROCK_PROVIDER_ID,
                label: "Amazon Bedrock",
                accountId: account.id,
                accountLabel: account.label,
                status: signedOut
                  ? ("auth_required" as const)
                  : profileUnavailable
                    ? ("unavailable" as const)
                    : ("not_measured" as const),
                stale: false,
                windows: [],
                ...(signedOut
                  ? { reason: "vendor_rejected" }
                  : profileUnavailable
                    ? { reason: BEDROCK_PROFILE_UNAVAILABLE }
                    : {}),
                detail: profileUnavailable ? `${BEDROCK_SIGN_IN.unavailable} ${spend}` : spend,
              };
            }),
          ...pushedProviderViews(
            vault.list().flatMap((account) => {
              const entry = quotaEntryForPiProvider(account.providerId);
              if (!entry || entry.sensed) return [];
              return [
                {
                  accountId: account.id,
                  accountLabel: account.label,
                  quotaId: entry.quotaId,
                  providerLabel: entry.label,
                },
              ];
            }),
            (accountId) => pushedQuota.windowsFor(accountId),
            now,
          ),
          ...pushedOnlyProviderViews(
            vault.list().flatMap((account) => {
              const entry = quotaEntryForPiProvider(account.providerId);
              if (!entry?.sensed || !account.enabled || !pushedOnly(vault, account)) return [];
              return [
                {
                  accountId: account.id,
                  accountLabel: account.label,
                  quotaId: entry.quotaId,
                  providerLabel: entry.label,
                },
              ];
            }),
            (accountId) => pushedQuota.windowsFor(accountId),
            now,
          ),
        ],
      });
  const quota = new QuotaService({
    refresh: quotaRefresh,
    db,
    // The fixture seam (dev/e2e) supplies its own catalog; only the real
    // fetcher's catalog is rebuilt when a read lands.
    ...(fixtureDir
      ? {}
      : {
          catalogFor: (snapshot: QuotaSnapshotView) =>
            buildModelsCatalog(catalogModels(), snapshot.providers, snapshot.generatedAt),
        }),
    stamp: (snapshot) => stampSnapshot(snapshot, keepsGoing),
    broadcast: options.broadcast,
  });
  // The captain's Try again on a spent allowance ends the vault's hold and
  // the refused readings laid over its meter together, so the seat, the crew
  // and the meter never read two answers. Every other way a hold ends keeps
  // its own way with the readings: a reset ends them at their own reset, a
  // reading with more left ends them, credits serve past them, and another
  // login forgets them.
  const spentHeld = new Set(
    vault
      .list()
      .filter((account) => vault.cutOff(account.id)?.class === "no_headroom")
      .map((account) => account.id),
  );
  vault.onCutOffChange((accountId) => {
    if (vault.cutOff(accountId)?.class === "no_headroom") {
      spentHeld.add(accountId);
      return;
    }
    if (!spentHeld.delete(accountId) || !vault.goesByAnswers(accountId)) return;
    endRefusedReadings(accountId);
    void quota.refresh("pushed");
  });
  return {
    quota,
    pushed: pushedQuota,
    catalogModels,
    recordClaudeRateLimit: (accountId, reading) => {
      if (!reading.windowId) return;
      const now = Date.now();
      const before = pushedQuota.windowsFor(accountId);
      const refusedBefore = before.some(
        (window) => window.windowId === reading.windowId && window.status === "rejected",
      );
      const creditsBefore = pushedCredits(before, now)?.credits;
      pushedQuota.record(accountId, {
        windowId: reading.windowId,
        status: reading.status,
        ...(reading.utilization !== undefined ? { utilization: reading.utilization } : {}),
        ...(reading.resetsAt !== undefined ? { resetsAt: reading.resetsAt } : {}),
        ...(reading.overageStatus !== undefined ? { overageStatus: reading.overageStatus } : {}),
        ...(reading.overageDisabledReason !== undefined
          ? { overageReason: reading.overageDisabledReason }
          : {}),
        ...(reading.usingOverage !== undefined ? { usingOverage: reading.usingOverage } : {}),
        at: now,
      });
      const creditsAfter = pushedCredits(pushedQuota.windowsFor(accountId), now)?.credits;
      // A window that just said no, or just stopped saying it, moves the
      // account's headroom now rather than at the next sensor pass; so does
      // a change in what extra usage can do.
      if (
        (reading.status === "rejected") !== refusedBefore ||
        creditsBefore?.state !== creditsAfter?.state ||
        Boolean(creditsBefore?.inUse) !== Boolean(creditsAfter?.inUse)
      )
        void quota.refresh("pushed");
    },
    noteCutOff: (accountId, cutOff) =>
      recordCutOff(
        {
          providerOf: (id) => vault.get(id)?.providerId,
          latest: () => quota.latest(),
          sensedLeft: (id) => sensedLeft.get(id),
          hold: (id, held, seen) => vault.noteCutOff(id, held, seen),
          holding: (id) => vault.cutOff(id)?.class === "no_headroom",
          refuse: (id, refused) =>
            pushedQuota.record(id, {
              windowId: refused.windowId,
              status: "rejected",
              resetsAt: refused.resetsAt,
              at: refused.at,
            }),
          refresh: () => void quota.refresh("pushed"),
        },
        accountId,
        cutOff,
        Date.now(),
      ),
    noteCredits: (snapshot) => {
      const change = creditsWatch.observe(snapshot, Date.now());
      const ended = change.available.filter((accountId) => vault.noteCreditsAvailable(accountId));
      // A hold that ended lets the switch serve again now.
      if (ended.length > 0) quota.restamp();
      return change.lines;
    },
    setKeepGoingOnCredits: (accountId, on) => {
      vault.setKeepGoingOnCredits(accountId, on);
      // A spent allowance held after a refusal ends when the provider says
      // its credits answer: the switch is what was missing.
      const row = quota.latest()?.providers.find((provider) => provider.accountId === accountId);
      if (on && row?.credits?.state === "available") vault.noteCreditsAvailable(accountId);
      quota.restamp();
    },
    contextLine: () => quotaContextLine(quota.latest()),
    forgetLogin: (accountId) => {
      pushedQuota.forget(accountId);
      sensedLeft.delete(accountId);
      quota.forgetAccount(accountId);
      void quota.refresh("account-changed");
    },
    syncNeedsReauthCards: (snapshot, cards) => {
      const accounts = vault.list();
      const wanted = new Set<string>();
      for (const target of needsReauthTargets(snapshot)) {
        wanted.add(target.cardId);
        const label =
          accounts.find((account) => account.id === target.accountId)?.label ?? target.accountLabel;
        cards.hostCards.addAuthDecisionCard(
          target.cardId,
          target.providerName,
          needsReauthCopy(target.providerName, label),
          { restoreAccountId: target.accountId },
        );
      }
      for (const card of cards.snapshot()) {
        const accountId = accountIdFromNeedsReauthCard(card.id);
        if (accountId !== undefined && !wanted.has(card.id)) {
          cards.hostCards.clearAuthDecisionCard(card.id);
        }
      }
    },
  };
}

/**
 * A compact one-line quota digest for the Firstmate context block: each
 * account's EFFECTIVE remaining (min across its bounding windows - never an
 * arbitrary window) plus its spend priority when measurable (higher =
 * paid allowance on track to expire unused).
 */
export function quotaContextLine(snapshot: QuotaSnapshotView | undefined): string {
  if (!snapshot || snapshot.providers.length === 0) return "unknown";
  const now = Date.now();
  const parts = snapshot.providers
    .filter((provider) => provider.status === "ok")
    .flatMap((provider) => {
      const effective = effectiveFromProvider(provider, now);
      if (typeof effective.effectivePercentRemaining !== "number") return [];
      const subject = provider.accountLabel
        ? `${provider.provider}/${provider.accountLabel}`
        : provider.provider;
      const priority =
        typeof effective.spendPriority === "number"
          ? ` (spend priority ${effective.spendPriority.toFixed(2)})`
          : "";
      const credits = effective.onCredits ? " (keeps going on credits)" : "";
      return [
        `${subject} ${Math.round(effective.effectivePercentRemaining)}%${priority}${credits}`,
      ];
    });
  return parts.length > 0 ? parts.join("; ") : "unknown";
}
