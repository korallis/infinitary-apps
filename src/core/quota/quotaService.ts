import { settlePoolResets } from "@shared/accountPools";
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
/** The longest wait one timer holds: `setTimeout` fires at once past 2^31 - 1 ms. */
const LONGEST_TIMER_MS = 2 ** 31 - 1;
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
  /**
   * The pools of the person's own logins over a snapshot's rows
   * (`QuotaSnapshotView.pools`, docs/quota.md "A pool of your own logins"),
   * folded on every snapshot, on `restamp` and when a login's reading is
   * forgotten: none leaves the snapshot without the field. With
   * `refusedUntil`, the fold is the served one, in which a refused login is
   * back when its refusal ends; without, it is the measurement's.
   */
  pools?: (
    snapshot: QuotaSnapshotView,
    refusedUntil?: (accountId: string) => number | undefined,
  ) => QuotaProviderView[];
  /**
   * Until when the provider's own refusal of an account's spent allowance
   * stands, when one does (the vault's cut-off): a pooled login's used-up
   * window stays on its served row until then (`settlePoolResets`).
   */
  refusedUntil?: (accountId: string) => number | undefined;
  /**
   * A reading of this computer alone (a CLI proxy's pools), taken on its
   * own clock between refreshes and never holding one up: each run answers
   * how it rewrites the last snapshot's rows, or nothing to leave it be.
   */
  localReading?: {
    everyMs: number;
    run: () => Promise<((snapshot: QuotaSnapshotView) => QuotaSnapshotView) | undefined>;
  };
  now?: () => number;
};

export class QuotaService {
  /**
   * The last snapshot as measured: every row as its reading left it. Stale
   * merges, a pushed row, a forgotten login and what is saved all work on
   * this one, never on the served view.
   */
  private measured: QuotaSnapshotView | undefined;
  /**
   * The snapshot every reader is served (`latest`): `measured`, with a
   * pooled login's used-up windows that have reset left out (`laid`).
   */
  private latestSnapshot: QuotaSnapshotView | undefined;
  /** A lay is running: a `restamp` it sets off itself is that same lay. */
  private laying = false;
  private latestCatalog: ModelsCatalogView | undefined;
  private refreshing: Promise<QuotaSnapshotView | undefined> | undefined;
  private refreshingReason: string | undefined;
  /** The forced refresh waiting on the one in flight, by reason. */
  private readonly followUps = new Map<string, Promise<QuotaSnapshotView | undefined>>();
  private interval: ReturnType<typeof setInterval> | undefined;
  private localInterval: ReturnType<typeof setInterval> | undefined;
  private localRunning = false;
  /** The last local reading's rewrite, laid over each refresh until the next one. */
  private localRewrite: ((snapshot: QuotaSnapshotView) => QuotaSnapshotView) | undefined;
  /**
   * When a pooled login's used-up window next resets: the last snapshot is
   * read again from then (`settle`), with no new reading.
   */
  private settleAtMs: number | undefined;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;
  private readonly snapshots: QuotaSnapshotStore;

  constructor(private readonly options: QuotaServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.snapshots = new QuotaSnapshotStore(options.db);
    const json = this.snapshots.latestJson();
    if (json !== undefined) {
      const parsed = quotaSnapshotViewSchema.safeParse(JSON.parse(json));
      // The switches as they stand now, not as they stood when it was saved.
      if (parsed.success) this.take(parsed.data);
    }
  }

  /** Takes `snapshot` as the measurement and lays the served view over it. */
  private take(snapshot: QuotaSnapshotView): QuotaSnapshotView {
    return this.adopt(this.laid(snapshot));
  }

  /**
   * Makes a lay the one readers are served, and waits on its next reset. A
   * lay that is not adopted leaves the wait as it was, so a reset already
   * due is still settled.
   */
  private adopt(lay: ReturnType<QuotaService["laid"]>): QuotaSnapshotView {
    this.measured = lay.measured;
    this.latestSnapshot = lay.served;
    this.settleAtMs = lay.settleAtMs;
    this.arm();
    return lay.served;
  }

  /**
   * A snapshot with what is derived from its rows laid over it, twice:
   * `measured` keeps every row as read, under the switches and the pools
   * folded from those rows, and is what the next lay starts from and what
   * is saved; `served` is what readers get, in which a pooled login's
   * used-up window that has reset since the reading is gone from its row
   * before the pool is folded (`settlePoolResets`). A login that leaves its
   * pool is therefore served its measured row again. `settleAtMs` is when
   * the served view next changes with no reading.
   */
  private laid(snapshot: QuotaSnapshotView): {
    measured: QuotaSnapshotView;
    served: QuotaSnapshotView;
    settleAtMs: number | undefined;
  } {
    this.laying = true;
    try {
      const { pools: _was, ...stamped } = this.options.stamp?.(snapshot) ?? snapshot;
      const fold = this.options.pools;
      const read = fold?.(stamped) ?? [];
      const measured = read.length > 0 ? { ...stamped, pools: read } : stamped;
      const settled = settlePoolResets(
        stamped.providers,
        read,
        this.now(),
        this.options.refusedUntil,
      );
      const settleAtMs = settled.nextAtMs;
      if (!fold || read.length === 0) return { measured, served: measured, settleAtMs };
      const standing = { ...stamped, providers: settled.providers };
      const pools = fold(standing, this.options.refusedUntil);
      const served = pools.length > 0 ? { ...standing, pools } : standing;
      return { measured, served, settleAtMs };
    } finally {
      this.laying = false;
    }
  }

  /**
   * The one reset fact every reader shares (docs/quota.md, "A pool of your
   * own logins"): once a pooled login's used-up window has reset, the last
   * snapshot and its catalog are served again without it and pushed, so the
   * meters, both waits, routing and the first mate's seat change together
   * at that moment. A timer brings it, and so does any read after it, so a
   * late timer never leaves two readers on different facts.
   */
  private settle(): void {
    if (this.settleAtMs === undefined || this.settleAtMs > this.now()) return;
    this.settleAtMs = undefined;
    this.restamp();
  }

  /** Arms the timer for the reset `settle` waits on, or clears it when there is none. */
  private arm(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
    if (this.settleAtMs === undefined) return;
    const wait = Math.min(Math.max(0, this.settleAtMs - this.now()), LONGEST_TIMER_MS);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = undefined;
      this.settle();
      // Fired before the reset, as a capped wait does: wait out the rest.
      if (!this.settleTimer) this.arm();
    }, wait);
    // A reset days away never holds the process open.
    this.settleTimer.unref?.();
  }

  latest(): QuotaSnapshotView | undefined {
    this.settle();
    return this.latestSnapshot;
  }

  latestModels(): ModelsCatalogView | undefined {
    this.settle();
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
    this.latestCatalog = markCredits(
      catalog.data,
      this.latestSnapshot.providers,
      this.latestSnapshot.pools,
    );
    this.options.broadcast(this.latestSnapshot);
  }

  /**
   * An account's Keep going on credits switch moved, or which logins a pool
   * folds did: the last snapshot and its catalog are read again with it,
   * fetching nothing, and pushed again so routing, the first mate and every
   * surface see it now.
   */
  restamp(): void {
    if (!this.measured || !this.latestSnapshot || this.laying) return;
    this.take(this.measured);
    const rebuilt = this.options.catalogFor
      ? modelsCatalogViewSchema.safeParse(this.options.catalogFor(this.latestSnapshot))
      : undefined;
    const catalog = rebuilt?.success ? rebuilt.data : this.latestCatalog;
    if (catalog)
      this.latestCatalog = markCredits(
        catalog,
        this.latestSnapshot.providers,
        this.latestSnapshot.pools,
      );
    this.options.broadcast(this.latestSnapshot);
  }

  /**
   * One account's row as its sessions just reported it (a further Claude
   * login's pushed reading, docs/quota.md) replaces that account's in the
   * last snapshot, fetching nothing and asking no other account's sensor.
   * False, changing nothing, while there is no snapshot to lay it in.
   */
  publishProvider(view: QuotaProviderView): boolean {
    const latest = this.measured;
    if (!latest) return false;
    const same = (provider: QuotaProviderView) =>
      provider.provider === view.provider && provider.accountId === view.accountId;
    this.measured = {
      ...latest,
      providers: latest.providers.some(same)
        ? latest.providers.map((provider) => (same(provider) ? view : provider))
        : [...latest.providers, view],
    };
    this.restamp();
    this.snapshots.record(this.measured);
    return true;
  }

  start(): void {
    this.interval = setInterval(() => {
      void this.refresh("interval");
    }, REFRESH_INTERVAL_MS);
    void this.refresh("startup");
    const local = this.options.localReading;
    if (local) {
      this.localInterval = setInterval(() => {
        void this.readLocal();
      }, local.everyMs);
      void this.readLocal();
    }
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    if (this.localInterval) clearInterval(this.localInterval);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
  }

  /**
   * One run of the local reading, laid over the last snapshot as a refresh
   * lays its reading: stale rows kept, switches stamped, the catalog rebuilt
   * and every surface told - only when the rows it gives differ from the
   * last snapshot's, so a reading that changes nothing publishes nothing. A
   * run still going skips the next tick.
   */
  async readLocal(): Promise<void> {
    const local = this.options.localReading;
    if (!local || this.localRunning) return;
    this.localRunning = true;
    try {
      const rewrite = await local.run();
      this.localRewrite = rewrite;
      const latest = this.measured;
      if (!rewrite || !latest) return;
      const merged = mergeStaleProviders(rewrite(latest), latest, this.now());
      const next = this.laid(merged);
      if (JSON.stringify(next.measured.providers) === JSON.stringify(latest.providers)) return;
      this.adopt(next);
      this.recatalog();
    } catch {
      // A local reading that failed leaves the last snapshot as it was.
    } finally {
      this.localRunning = false;
    }
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
    const without = (snapshot: QuotaSnapshotView) => ({
      ...snapshot,
      providers: snapshot.providers.filter((provider) => provider.accountId !== accountId),
    });
    this.latestSnapshot = without(latest);
    if (this.measured) this.measured = without(this.measured);
    // A pool that folded the old login's reading is folded again without it.
    if (latest.pools) this.restamp();
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
        const read = this.localRewrite?.(result.snapshot) ?? result.snapshot;
        const merged = mergeStaleProviders(read, this.measured, this.now());
        const snapshot = this.take(merged);
        // The refresh's own catalog never saw the local reading's rows, nor
        // the pools.
        const catalog = modelsCatalogViewSchema.safeParse(
          (this.localRewrite || snapshot.pools) && this.options.catalogFor
            ? this.options.catalogFor(snapshot)
            : result.catalog,
        );
        if (catalog.success)
          this.latestCatalog = markCredits(catalog.data, snapshot.providers, snapshot.pools);
        if (this.measured) this.snapshots.record(this.measured);
        this.options.broadcast(snapshot);
        // What a refresh read can change what the local reading reads (a
        // connection added or moved): it runs again now, not at its next tick.
        void this.readLocal();
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
  // A proxy's row is keyed by its pool, apart from the account's own
  // reading, so a proxy that did not answer never takes a direct sign-in's
  // windows and a direct reading never takes the proxy's.
  const keyOf = (provider: QuotaSnapshotView["providers"][number]) =>
    `${provider.provider}:${provider.accountId ?? ""}:${provider.fromProxy ? `proxy:${provider.pool?.kind ?? ""}` : ""}`;
  const prior = new Map(previous.providers.map((provider) => [keyOf(provider), provider]));
  const staleFrom = (
    provider: QuotaSnapshotView["providers"][number],
    last: QuotaSnapshotView["providers"][number] | undefined,
  ) => {
    if (!last || last.windows.length === 0) return undefined;
    const windows = last.windows.filter((window) => stillApplies(window, now));
    if (windows.length === 0) return undefined;
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
  };
  return {
    ...next,
    providers: next.providers.flatMap((provider) => {
      if (provider.status === "ok" || provider.status === "auth_required") return [provider];
      if (provider.windows.length > 0) return [provider];
      // A Claude account now on access set up for Claude Code is not
      // measured by decision, not for want of a reading: the subscription's
      // last windows are no longer its allowance.
      if (provider.reason === CLAUDE_ACCESS_REASON) return [provider];
      // An unanswered proxy names no pool: its row stands for every pool the
      // proxy last read for that account, each kept apart.
      if (provider.fromProxy && !provider.pool) {
        const kept = previous.providers.flatMap((last) =>
          last.fromProxy &&
          last.pool &&
          last.provider === provider.provider &&
          last.accountId === provider.accountId
            ? (staleFrom(provider, last) ?? [])
            : [],
        );
        return kept.length > 0 ? kept : [provider];
      }
      return [staleFrom(provider, prior.get(keyOf(provider))) ?? provider];
    }),
  };
}
