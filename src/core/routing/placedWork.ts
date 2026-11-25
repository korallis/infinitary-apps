import type { CatalogModelView, QuotaProviderView, QuotaSnapshotView } from "@shared/quota";
import { allowanceProviderOf, rowMeasuresModel } from "@shared/quota";
import {
  allowanceSpent,
  classifyProviderWindows,
  compareBandRank,
  type SpendBand,
  spendBand,
} from "@shared/quotaSignals";
import { effectiveFromProvider, limitingResetOf, scopeAppliesToModel } from "../quota/catalog";
import type { AppDatabase } from "../storage/db";
import type { SettingsStore } from "../storage/settingsStore";
import { prepared } from "../storage/statements";

export type ChargeFact = {
  accountId: string;
  measuredAt: number;
  source: string;
  baseSpendPriority?: number;
  windows: {
    id: string;
    points: number;
    pointsPerDollar?: number;
    percentRemaining?: number;
    resetsAtMs?: number;
  }[];
};
/**
 * A catalog model ranked for crew routing, with the account whose reading
 * ranked it: `band` from that unadjusted reading (INF-1714), `rawSpendPriority`
 * the score before placed work, and when and until when the reading holds.
 */
export type RankedModel = CatalogModelView & {
  charge?: ChargeFact;
  band?: SpendBand;
  rawSpendPriority?: number;
  accountId?: string;
  measuredAt?: number;
  resetsAtMs?: number;
};
type Reading = { source: string; row: QuotaProviderView; at: number };
type Cycle = Reading & { windowId: string; reset: number; initial: number; start: number };
type Work = {
  id: string;
  account: string | null;
  device: string | null;
  provider: string;
  model: string;
  level: string;
  at: number;
  closed: number | null;
  status: string;
};
type Sample = { provider: string; model: string; level: string; cost: number };
/**
 * The placed and finished work one routing evaluation scores every account
 * against, read once: the finished read is the slow one, and reading it
 * again per account of every model froze the main process (INF-2056).
 */
export type PlacedWorkData = {
  work: Work[];
  samples: Sample[];
  /** Already evaluated in the record process; no history crosses to main. */
  charges?: Record<string, PlacedCharge | null>;
  /** The readings this prepared charge belongs to; retained locally by the caller. */
  readings?: QuotaProviderView[];
};
export function placedReadingKey(row: QuotaProviderView): string {
  return JSON.stringify(row);
}
export type PlacedWorkRead = {
  rows: QuotaProviderView[];
  now: number;
  observations: { source: string; snapshot: QuotaSnapshotView }[];
  prices: Record<string, number>;
};
export type PlacedWorkAnswer = { data: PlacedWorkData; prices: Record<string, number> };

type UsageTotals = { logged: number | null; metered: number | null };
type PlacedCharge = Omit<ChargeFact, "baseSpendPriority">;
type Evaluation = {
  readings: Reading[];
  prices: ReturnType<SettingsStore["getAllowancePrices"]>;
  charges: Map<string, PlacedCharge | undefined>;
  usage: Map<number, Map<string, UsageTotals>>;
  expected: Map<string, number | undefined>;
};

/** INF-443: prices are learned locally; only ranking, never the meter, is adjusted. */
export class PlacedWorkScores {
  private readonly readings = new Map<string, Reading>();
  private readonly cycles = new Map<string, Cycle>();
  /** The work snapshot owns these reads, never a later routing evaluation. */
  private readonly evaluations = new WeakMap<PlacedWorkData, Evaluation>();
  private readonly observations = new Map<string, QuotaSnapshotView>();
  constructor(
    private readonly db: AppDatabase,
    private readonly settings: Pick<SettingsStore, "getAllowancePrices" | "setAllowancePrices">,
    private readonly background?: (input: PlacedWorkRead) => Promise<PlacedWorkAnswer>,
  ) {}

  private login(row: QuotaProviderView): string {
    // Neither Grok nor Codex identifies a login. Claude identities never mix.
    return row.provider === "claude"
      ? JSON.stringify([row.provider, row.account ?? row.accountId])
      : row.provider;
  }
  private priceKey(row: QuotaProviderView, window: string): string {
    return JSON.stringify([this.login(row), window]);
  }

  observe(source: string, snapshot: QuotaSnapshotView): void {
    if (this.background) {
      this.observations.set(source, snapshot);
      void this.prepare([]).catch((error) =>
        console.warn("[routing] a quota reading could not be scored:", error),
      );
      return;
    }
    for (const row of snapshot.providers) {
      if (!row.accountId || row.status !== "ok" || row.stale) continue;
      const at = row.measuredAt ?? snapshot.fetchedAt;
      const key = JSON.stringify([source, row.accountId]);
      const previous = this.readings.get(key);
      if (previous && at <= previous.at) continue; // Recatalog is not another reading.
      const reading = { source, row, at };
      this.readings.set(key, reading);
      const classified = classifyProviderWindows(row.provider, row.windows);
      for (const window of [...classified.bounding, ...[...classified.scoped.values()].flat()]) {
        if (window.percentRemaining === undefined || !window.resetsAtMs || window.resetsAtMs <= at)
          continue;
        const cycleKey = JSON.stringify([key, window.id]);
        const cycle = this.cycles.get(cycleKey);
        if (
          !cycle ||
          cycle.reset !== window.resetsAtMs ||
          window.percentRemaining >
            (cycle.row.windows.find((w) => w.id === window.id)?.percentRemaining ?? 100)
        ) {
          this.cycles.set(cycleKey, {
            ...reading,
            windowId: window.id,
            reset: window.resetsAtMs,
            initial: window.percentRemaining,
            start: at,
          });
        } else {
          this.cycles.set(cycleKey, { ...cycle, ...reading });
        }
      }
    }
    const totals = new Map<string, { drop: number; dollars: number }>();
    for (const cycle of this.cycles.values()) {
      if (cycle.reset <= snapshot.fetchedAt) continue;
      const remaining = cycle.row.windows.find((w) => w.id === cycle.windowId)?.percentRemaining;
      if (remaining === undefined) continue;
      const key = this.priceKey(cycle.row, cycle.windowId);
      const total = totals.get(key) ?? { drop: 0, dollars: 0 };
      total.drop += Math.max(0, cycle.initial - remaining);
      // Includes the first mate's own calls, but only this sign-in's same-time usage.
      const costs = prepared(
        this.db,
        "SELECT model, SUM(cost) AS cost FROM usage_events WHERE account_id = ? AND at > ? AND at <= ? AND cost > 0 GROUP BY model",
      ).all(cycle.row.accountId, cycle.start, cycle.at) as {
        model: string | null;
        cost: number;
      }[];
      const scopes = classifyProviderWindows(cycle.row.provider, [
        { id: cycle.windowId, label: cycle.windowId },
      ]).scoped;
      total.dollars += costs
        .filter(
          (cost) =>
            scopes.size === 0 ||
            (cost.model !== null &&
              [...scopes.keys()].some((scope) => scopeAppliesToModel(scope, cost.model ?? ""))),
        )
        .reduce((sum, cost) => sum + cost.cost, 0);
      totals.set(key, total);
    }
    const prices = this.settings.getAllowancePrices();
    let changed = false;
    for (const [key, total] of totals) {
      if (total.drop < 3 || total.dollars <= 0) continue;
      const price = total.drop / total.dollars;
      if (Number.isFinite(price) && price > 0 && prices[key] !== price) {
        prices[key] = price;
        changed = true;
      }
    }
    if (changed) this.settings.setAllowancePrices(prices);
  }

  /** Read the newest committed route, including an Automatic start not yet attached. */
  private work(): Work[] {
    return prepared(
      this.db,
      `SELECT t.id, COALESCE(x.account_id, json_extract(d.facts_json, '$.accountId')) AS account, x.device_id AS device,
      d.provider, d.model, COALESCE(d.served, d.bucket) AS level, d.at,
      t.closed_at AS closed, t.status
      FROM tasks t JOIN decisions d ON d.task_id = t.id AND d.kind = 'routing'
      LEFT JOIN task_execution x ON x.task_id = t.id
      WHERE d.id = (SELECT MAX(n.id) FROM decisions n WHERE n.task_id = t.id AND n.kind = 'routing')
      AND d.model IS NOT NULL`,
    ).all() as Work[];
  }

  private finished(now: number): Sample[] {
    return prepared(
      this.db,
      `SELECT d.provider, d.model, COALESCE(d.served, d.bucket) AS level, SUM(u.cost) AS cost
      FROM tasks t JOIN decisions d ON d.task_id = t.id AND d.kind = 'routing'
      JOIN usage_events u ON u.task_id = t.id
      WHERE t.status = 'done' AND t.closed_at >= ? AND t.closed_at <= ?
      AND d.id = (SELECT MAX(n.id) FROM decisions n WHERE n.task_id = t.id AND n.kind = 'routing')
      GROUP BY t.id HAVING COUNT(u.cost) = COUNT(*) AND SUM(u.cost) > 0`,
    ).all(now - 14 * 86400000, now) as Sample[];
  }

  /** The work to score against at `now`; one evaluation reads it once. */
  data(now: number): PlacedWorkData {
    if (this.background) throw new Error("placed work must be prepared off-thread");
    return { work: this.work(), samples: this.finished(now) };
  }

  /** Concurrent callers are batched by the record reader, with no main-thread SQL. */
  async prepare(rows: QuotaProviderView[], now = Date.now()): Promise<PlacedWorkData> {
    if (!this.background) return this.data(now);
    const observations = [...this.observations].map(([source, snapshot]) => ({ source, snapshot }));
    const prices = this.settings.getAllowancePrices();
    let answer: PlacedWorkAnswer;
    try {
      answer = await this.background({
        rows,
        now,
        observations,
        prices,
      });
    } catch (error) {
      // A charge is optional; a failed reader must not stop work or read history here.
      console.warn("[routing] placed-work adjustment unavailable:", error);
      return { work: [], samples: [], charges: {}, readings: rows };
    }
    if (JSON.stringify(answer.prices) !== JSON.stringify(this.settings.getAllowancePrices()))
      this.settings.setAllowancePrices(answer.prices);
    return { ...answer.data, readings: rows };
  }

  /** Score all requested readings against the same batch's work, inside the reader. */
  preparedCharges(rows: QuotaProviderView[], data: PlacedWorkData): PlacedWorkData {
    return {
      work: [],
      samples: [],
      charges: Object.fromEntries(
        rows.map((row) => [placedReadingKey(row), this.charge(row, data) ?? null]),
      ),
    };
  }

  private expected(work: Work, samples: Sample[], logged: number): number | undefined {
    const provider = samples.filter((s) => s.provider === work.provider);
    for (const group of [
      provider.filter((s) => s.model === work.model && s.level === work.level),
      provider.filter((s) => s.model === work.model),
      provider,
    ]) {
      if (group.length < 5) continue;
      const average = group.reduce((sum, s) => sum + s.cost, 0) / group.length;
      if (logged <= average) return average;
      const tail = group.filter((s) => s.cost >= logged);
      return tail.length ? tail.reduce((sum, s) => sum + s.cost, 0) / tail.length : logged;
    }
    return undefined;
  }

  score(
    row: QuotaProviderView,
    now: number,
    model: string | undefined,
    data: PlacedWorkData,
  ): {
    spendPriority?: number;
    lastsThroughReset?: boolean;
    charge?: ChargeFact;
    band: SpendBand;
  } {
    const original = effectiveFromProvider(row, now, model);
    // The band is the unadjusted reading's: a charge never moves it (INF-1714).
    const band = spendBand(original);
    if (row.status !== "ok" || row.stale || !row.accountId) return { ...original, band };
    const charge = this.charge(row, data);
    if (!charge) return { ...original, band };
    const windows = charge.windows;
    const adjusted = effectiveFromProvider(
      {
        ...row,
        windows: row.windows.map((window, i) => ({
          ...window,
          ...(window.percentRemaining !== undefined
            ? { percentRemaining: window.percentRemaining - (windows[i]?.points ?? 0) }
            : {}),
        })),
      },
      now,
      model,
    );
    return {
      ...(adjusted.spendPriority !== undefined ? { spendPriority: adjusted.spendPriority } : {}),
      // Placed work counts toward the runway too: a charge can bring a
      // window's projected exhaustion before its reset, which the record
      // keeps, while the band stays the unadjusted reading's.
      ...(adjusted.lastsThroughReset !== undefined
        ? { lastsThroughReset: adjusted.lastsThroughReset }
        : {}),
      band,
      charge: { ...charge, baseSpendPriority: original.spendPriority },
    };
  }

  /**
   * Placed work charges a reading's windows, not the model being ranked.
   * Catalog ranking and account binding share that charge and each task's
   * usage totals within their one evaluation (INF-2255). Model-specific
   * allowance and time-to-reset calculations still run in score.
   */
  private charge(row: QuotaProviderView, data: PlacedWorkData): PlacedCharge | undefined {
    const key = placedReadingKey(row);
    if (data.charges) return data.charges[key] ?? undefined;
    let evaluation = this.evaluations.get(data);
    if (!evaluation) {
      evaluation = {
        readings: [...this.readings.values()],
        prices: this.settings.getAllowancePrices(),
        charges: new Map(),
        usage: new Map(),
        expected: new Map(),
      };
      this.evaluations.set(data, evaluation);
    }
    if (evaluation.charges.has(key)) return evaluation.charges.get(key);
    const { readings, prices } = evaluation;
    const reading =
      readings.find((r) => r.row.accountId === row.accountId && r.at === row.measuredAt) ??
      readings.find((r) => r.row.accountId === row.accountId);
    if (!reading || !row.accountId) {
      evaluation.charges.set(key, undefined);
      return undefined;
    }
    const login = this.login(row);
    const works = data.work.filter(
      (w) =>
        allowanceProviderOf(w.provider) === row.provider &&
        (w.account
          ? readings.some((r) => r.row.accountId === w.account && this.login(r.row) === login)
          : readings
              .filter((r) => (w.device ?? "home") === r.source && r.row.provider === row.provider)
              .slice(0, 1)
              .some((r) => this.login(r.row) === login)),
    );
    let usage = evaluation.usage.get(reading.at);
    if (!usage) {
      usage = new Map();
      evaluation.usage.set(reading.at, usage);
    }
    const windows = row.windows.map((window) => {
      const price = prices[this.priceKey(row, window.id)];
      const scoped = classifyProviderWindows(row.provider, [window]).scoped;
      let points = 0;
      if (price !== undefined)
        for (const work of works) {
          if (work.closed !== null && reading.at > work.closed) continue;
          if (
            scoped.size &&
            ![...scoped.keys()].some((scope) => scopeAppliesToModel(scope, work.model))
          )
            continue;
          let sums = usage.get(work.id);
          if (!sums) {
            sums = prepared(
              this.db,
              "SELECT SUM(cost) AS logged, SUM(CASE WHEN at <= ? THEN cost ELSE 0 END) AS metered FROM usage_events WHERE task_id = ? AND cost > 0",
            ).get(reading.at, work.id) as UsageTotals;
            usage.set(work.id, sums);
          }
          if (!evaluation.expected.has(work.id)) {
            const logged = sums.logged ?? 0;
            evaluation.expected.set(
              work.id,
              work.closed !== null ? logged : this.expected(work, data.samples, logged),
            );
          }
          const expected = evaluation.expected.get(work.id);
          if (expected !== undefined) points += Math.max(0, expected - (sums.metered ?? 0)) * price;
        }
      return {
        id: window.id,
        points,
        percentRemaining: window.percentRemaining,
        resetsAtMs: window.resetsAtMs,
        ...(price !== undefined ? { pointsPerDollar: price } : {}),
      };
    });
    const charge = {
      accountId: row.accountId,
      source: reading.source,
      measuredAt: reading.at,
      windows,
    };
    evaluation.charges.set(key, charge);
    return charge;
  }

  /**
   * Each model's crew ranking facts from one account's reading: the account
   * `bound` names for it - the one that will serve it, so the model is
   * ranked by the account it runs on, and left unranked when that account
   * has no reading - else, when it names none, the best account by the crew
   * bands. `bound` is handed the work read for
   * this evaluation, so naming the account reads it no second time.
   */
  catalog(
    catalog: CatalogModelView[],
    rows: QuotaProviderView[],
    now: number,
    bound: ((model: CatalogModelView, data: PlacedWorkData) => string | undefined) | undefined,
    data: PlacedWorkData,
  ): RankedModel[] {
    return catalog.map((model) => {
      const candidates = rows
        .filter((row) => row.provider === model.provider && rowMeasuresModel(row, model.id))
        .map((row) => ({
          row,
          raw: effectiveFromProvider(row, now, model.id),
          score: this.score(row, now, model.id, data),
        }))
        .filter((c) => c.raw.effectivePercentRemaining !== undefined);
      candidates.sort((a, b) => {
        // A spent allowance comes after one that keeps going on credits.
        const spent = Number(allowanceSpent(a.raw)) - Number(allowanceSpent(b.raw));
        if (spent !== 0) return spent;
        const order = compareBandRank({ ...a.raw, ...a.score }, { ...b.raw, ...b.score });
        if (order !== 0) return order;
        return (b.raw.effectivePercentRemaining ?? -1) - (a.raw.effectivePercentRemaining ?? -1);
      });
      // The account that would serve it ranks it; one with no reading of its
      // own leaves its allowance unknown, never borrowing a sibling's.
      // Readings that name no account are read as before.
      const named = candidates.some((c) => c.row.accountId !== undefined);
      const boundId = named ? bound?.(model, data) : undefined;
      const best = boundId ? candidates.find((c) => c.row.accountId === boundId) : candidates[0];
      // A named account with no reading clears what the catalog carried,
      // which is the provider's whole reading, a spent sibling's included.
      if (!best)
        return boundId ? { provider: model.provider, id: model.id, label: model.label } : model;
      const resetsAtMs = limitingResetOf(best.row, now, model.id);
      const measuredAt = best.score.charge?.measuredAt ?? best.row.measuredAt;
      // Whether it keeps going on credits is the serving account's reading.
      const { onCredits: _catalog, ...base } = model;
      return {
        ...base,
        ...best.raw,
        ...best.score,
        ...(best.raw.spendPriority !== undefined
          ? { rawSpendPriority: best.raw.spendPriority }
          : {}),
        ...(best.row.accountId ? { accountId: best.row.accountId } : {}),
        ...(measuredAt !== undefined ? { measuredAt } : {}),
        ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
      };
    });
  }
}
