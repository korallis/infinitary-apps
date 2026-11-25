import {
  type ModelsCatalogView,
  modelsCatalogViewSchema,
  type QuotaProviderView,
  type QuotaSnapshotView,
  quotaSnapshotViewSchema,
} from "@shared/quota";
import type { AppDatabase } from "../storage/db";
import { QuotaSnapshotStore } from "../storage/quotaSnapshotStore";
import { markCredits } from "./catalog";
import type { QuotaFetchResult } from "./fetchQuota";
import { CLAUDE_ACCESS_REASON } from "./outcome";

/**
 * The quota sensor (decision D-7): fetch usage windows from first-party
 * provider APIs with Infinitary-managed keys (Pi ModelRuntime.getAuth refreshes
 * OAuth). Snapshots persist so the shell can show last-known state (visibly
 * stale) after a restart. Per-provider failures never crash the app.
 */

export type QuotaRefresh = (reason?: string) => Promise<QuotaFetchResult>;

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
/**
 * Refreshes an in-flight background one never swallows: a person's Retry
 * (`demand`, the only one that may ask for access) and a changed login,
 * whose reading must be taken under the new login.
 */
const FORCED_REASONS: ReadonlySet<string> = new Set(["demand", "account-changed"]);
/** A focus event only refreshes when the last snapshot is older than this. */
const FOCUS_STALENESS_MS = 60 * 1000;
/**
 * A window whose own reset instant has passed is not stale, it is wrong:
 * carrying it forward would show a spent allowance as if it still applied.
 */
function stillApplies(window: { resetsAtMs?: number }, now: number): boolean {
  return window.resetsAtMs === undefined || window.resetsAtMs > now;
}

export type QuotaServiceOptions = {
  refresh: QuotaRefresh;
  db: AppDatabase;
  broadcast: (snapshot: QuotaSnapshotView) => void;
  /**
   * The model catalog over a snapshot, for `recatalog`: the same build a
   * refresh runs, without fetching anything.
   */
  catalogFor?: (snapshot: QuotaSnapshotView) => ModelsCatalogView;
  /**
   * Lays each account's Keep going on credits switch over its row
   * (`QuotaProviderView.keepGoingOnCredits`), on every snapshot and again on
   * `restamp`; the catalog is then marked from those rows (`markCredits`).
   */
  stamp?: (snapshot: QuotaSnapshotView) => QuotaSnapshotView;
  now?: () => number;
};

export class QuotaService {
  private latestSnapshot: QuotaSnapshotView | undefined;
  private latestCatalog: ModelsCatalogView | undefined;
  private refreshing: Promise<QuotaSnapshotView | undefined> | undefined;
  private refreshingReason: string | undefined;
  /** The forced refresh waiting on the one in flight, by reason. */
  private readonly followUps = new Map<string, Promise<QuotaSnapshotView | undefined>>();
  private interval: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;
  private readonly snapshots: QuotaSnapshotStore;

  constructor(private readonly options: QuotaServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.snapshots = new QuotaSnapshotStore(options.db);
    const json = this.snapshots.latestJson();
    if (json !== undefined) {
      const parsed = quotaSnapshotViewSchema.safeParse(JSON.parse(json));
      // The switches as they stand now, not as they stood when it was saved.
      if (parsed.success) this.latestSnapshot = options.stamp?.(parsed.data) ?? parsed.data;
    }
  }

  latest(): QuotaSnapshotView | undefined {
    return this.latestSnapshot;
  }

  latestModels(): ModelsCatalogView | undefined {
    return this.latestCatalog;
  }

  /**
   * Rebuild the model catalog over the last snapshot, fetching nothing:
   * what the accounts serve moved (a runtime catalog read landed,
   * docs/model-lists.md), and routing walks this catalog - a model it has no
   * row for can be neither named nor picked until the next refresh. The
   * snapshot is pushed again so every surface re-reads the lists.
   */
  recatalog(): void {
    if (!this.latestSnapshot || !this.options.catalogFor) return;
    const catalog = modelsCatalogViewSchema.safeParse(this.options.catalogFor(this.latestSnapshot));
    if (!catalog.success) return;
    this.latestCatalog = markCredits(catalog.data, this.latestSnapshot.providers);
    this.options.broadcast(this.latestSnapshot);
  }

  /**
   * An account's Keep going on credits switch moved: the last snapshot and
   * its catalog are read again with it, fetching nothing, and pushed again
   * so routing, the first mate and every surface see it now.
   */
  restamp(): void {
    if (!this.latestSnapshot) return;
    this.latestSnapshot = this.options.stamp?.(this.latestSnapshot) ?? this.latestSnapshot;
    const rebuilt = this.options.catalogFor
      ? modelsCatalogViewSchema.safeParse(this.options.catalogFor(this.latestSnapshot))
      : undefined;
    const catalog = rebuilt?.success ? rebuilt.data : this.latestCatalog;
    if (catalog) this.latestCatalog = markCredits(catalog, this.latestSnapshot.providers);
    this.options.broadcast(this.latestSnapshot);
  }

  /**
   * One account's row as its sessions just reported it (a further Claude
   * login's pushed reading, docs/quota.md) replaces that account's in the
   * last snapshot, fetching nothing and asking no other account's sensor.
   * False, changing nothing, while there is no snapshot to lay it in.
   */
  publishProvider(view: QuotaProviderView): boolean {
    const latest = this.latestSnapshot;
    if (!latest) return false;
    const same = (provider: QuotaProviderView) =>
      provider.provider === view.provider && provider.accountId === view.accountId;
    this.latestSnapshot = {
      ...latest,
      providers: latest.providers.some(same)
        ? latest.providers.map((provider) => (same(provider) ? view : provider))
        : [...latest.providers, view],
    };
    this.restamp();
    this.snapshots.record(this.latestSnapshot);
    return true;
  }

  start(): void {
    this.interval = setInterval(() => {
      void this.refresh("interval");
    }, REFRESH_INTERVAL_MS);
    void this.refresh("startup");
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
  }

  onWindowFocus(): void {
    const age = this.latestSnapshot ? this.now() - this.latestSnapshot.fetchedAt : Infinity;
    if (age > FOCUS_STALENESS_MS) {
      void this.refresh("focus");
    }
  }

  /**
   * The machine woke. A plain `setInterval` fires once late after a sleep and
   * then drifts, so recovery cannot be left to the timer alone: this is the
   * moment a reading is most likely to be both wrong and fixable.
   */
  onResumed(): void {
    void this.refresh("resume");
  }

  /**
   * An account's login changed: its last reading was the old login's, so it
   * is not carried forward as this account's while the next one is taken.
   */
  forgetAccount(accountId: string): void {
    const latest = this.latestSnapshot;
    if (!latest?.providers.some((provider) => provider.accountId === accountId)) return;
    this.latestSnapshot = {
      ...latest,
      providers: latest.providers.filter((provider) => provider.accountId !== accountId),
    };
  }

  /**
   * Single-flight refresh; failures keep the last snapshot (stale > wrong).
   * A forced refresh (`FORCED_REASONS`) is never swallowed by an in-flight
   * one of another reason: it chains a follow-up, so a person's Retry
   * actually runs with its `allowPrompt`, and a changed login's reading is
   * taken after a request the old login started.
   */
  refresh(reason: string): Promise<QuotaSnapshotView | undefined> {
    if (this.refreshing) {
      if (FORCED_REASONS.has(reason) && this.refreshingReason !== reason) {
        let followUp = this.followUps.get(reason);
        if (!followUp) {
          followUp = this.refreshing.then(() => {
            this.followUps.delete(reason);
            return this.refresh(reason);
          });
          this.followUps.set(reason, followUp);
        }
        return followUp;
      }
      return [...this.followUps.values()].at(-1) ?? this.refreshing;
    }
    this.refreshingReason = reason;
    this.refreshing = (async () => {
      try {
        const result = await this.options.refresh(reason);
        const merged = mergeStaleProviders(result.snapshot, this.latestSnapshot, this.now());
        const snapshot = this.options.stamp?.(merged) ?? merged;
        this.latestSnapshot = snapshot;
        const catalog = modelsCatalogViewSchema.safeParse(result.catalog);
        if (catalog.success) this.latestCatalog = markCredits(catalog.data, snapshot.providers);
        this.snapshots.record(snapshot);
        this.options.broadcast(snapshot);
        return this.latestSnapshot;
      } catch {
        return this.latestSnapshot;
      } finally {
        this.refreshing = undefined;
        this.refreshingReason = undefined;
      }
    })();
    return this.refreshing;
  }
}

/**
 * Last-known-good is the default, not the exception.
 *
 * Any reading that did not establish a new one keeps the previous windows and
 * says how old they are. The single exception is `auth_required`, which by
 * construction reaches this point only after a delegated renewal failed to fix
 * a vendor rejection - the one state that is evidence the credential itself is
 * finished, and so the only one that may clear a card - beside a Claude
 * account now on access set up for Claude Code, whose allowance is not
 * measured at all. Not knowing (a timeout,
 * a rate limit, an unreadable store, a renewal that could not run) never
 * throws away a real reading. Keyed per account, so one account's failure can
 * never borrow a sibling's windows.
 */
export function mergeStaleProviders(
  next: QuotaSnapshotView,
  previous: QuotaSnapshotView | undefined,
  now: number = Date.now(),
): QuotaSnapshotView {
  if (!previous) return next;
  const keyOf = (provider: QuotaSnapshotView["providers"][number]) =>
    `${provider.provider}:${provider.accountId ?? ""}`;
  const prior = new Map(previous.providers.map((provider) => [keyOf(provider), provider]));
  return {
    ...next,
    providers: next.providers.map((provider) => {
      if (provider.status === "ok" || provider.status === "auth_required") return provider;
      if (provider.windows.length > 0) return provider;
      // A Claude account now on access set up for Claude Code is not
      // measured by decision, not for want of a reading: the subscription's
      // last windows are no longer its allowance.
      if (provider.reason === CLAUDE_ACCESS_REASON) return provider;
      const last = prior.get(keyOf(provider));
      if (!last || last.windows.length === 0) return provider;
      const windows = last.windows.filter((window) => stillApplies(window, now));
      if (windows.length === 0) return provider;
      return {
        ...last,
        windows,
        stale: true,
        // The row keeps saying WHY it could not be refreshed, and when the
        // windows it is showing were actually measured.
        measuredAt: last.measuredAt ?? previous.fetchedAt,
        ...(provider.reason ? { reason: provider.reason } : {}),
        ...(provider.retryAfter ? { retryAfter: provider.retryAfter } : {}),
        ...(provider.detail ? { detail: provider.detail } : {}),
      };
    }),
  };
}
