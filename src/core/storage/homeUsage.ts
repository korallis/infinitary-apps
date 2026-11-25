import {
  type AppCostLimitView,
  type CostLimit,
  effectiveCostLimit,
  limitUsd,
  RECENT_COST_DAYS,
  type TaskCostView,
} from "@shared/costLimit";
import { isCustomApiProvider } from "@shared/customApi";
import type { FmEvent } from "@shared/events";
import { modelNames } from "@shared/modelDisplayName";
import { offeringKey, providerLabel, type SlotModelView } from "@shared/modelSlots";
import type { CoreServices } from "../coreServices";
import { type UsageReportDestination, UsageReporter } from "../usageReport/usageReporter";
import { CostLimitStore } from "./costLimitStore";
import type { AppDatabase } from "./db";
import type { TaskRecord } from "./taskRecords";
import { FIRSTMATE_USAGE_TASK_ID, type UsageInput, UsageStore } from "./usageStore";

export type HomeUsageFacts = {
  /** The app's own limit, from Settings → Intelligence. */
  appLimit(): CostLimit;
  /** A project's own limit, or null when it follows the app's. */
  projectLimit(repoId: string): CostLimit | null | undefined;
  isTask(taskId: string): boolean;
  /** Hands the usage report every broadcast event (`EventSeam.attachUsageReport`). */
  hearEvents(hear: (event: FmEvent) => void): void;
  /**
   * Where Infinitary's own usage report goes (docs/usage-report.md), from
   * their sources: a company's Claude Code setup, a connection the person
   * adds. With none, nothing is sent or kept. Asked on every heard event,
   * so it answers from what its sources already hold.
   */
  reportDestinations?(): readonly UsageReportDestination[];
};

/**
 * The home's usage ledger and cost limits (docs/usage.md): the per-account
 * ledger (broker phase 2), whose cost comes from session turn_end and
 * model-powered tool_end usage (Pi's listed prices, Claude's own estimate) -
 * never a proxy - keyed by the serving account and model; and each task's
 * cost limit below the app's own, with the holds a limit placed
 * ("The cost limit").
 */
export type HomeUsage = {
  usageStore: UsageStore;
  costLimitStore: CostLimitStore;
  /** A task record's live family spend and the effective limit it follows. */
  taskCostOf(record: TaskRecord): TaskCostView;
  /** The app's own limit as Settings → Intelligence shows it, with its recent tasks. */
  appCostLimitView(): AppCostLimitView;
  /** Record one response's usage now. */
  recordUsage(input: Omit<UsageInput, "at">): void;
  /** Infinitary's own usage report; stopped once, with the app. */
  usageReporter: UsageReporter;
};

export function homeUsage(db: AppDatabase, facts: HomeUsageFacts): HomeUsage {
  const usageStore = new UsageStore(db);
  const costLimitStore = new CostLimitStore(db);
  const usageReporter = new UsageReporter({
    destinations: facts.reportDestinations ?? (() => []),
    workKind: (taskId) => usageStore.workKind(taskId),
    isTask: facts.isTask,
    firstmateTaskId: FIRSTMATE_USAGE_TASK_ID,
  });
  // The report never costs a turn its cost limit or a window its event.
  const reporting = (run: () => void): void => {
    try {
      run();
    } catch (caught) {
      console.warn(
        `[usage report] skipped one update (${caught instanceof Error ? caught.name : "error"})`,
      );
    }
  };
  facts.hearEvents((event) => reporting(() => usageReporter.heard(event)));
  return {
    usageReporter,
    usageStore,
    costLimitStore,
    taskCostOf: (record) => ({
      ...costLimitStore.familySpend(record.id),
      ...effectiveCostLimit({
        task: costLimitStore.taskLimit(record.id)?.limit,
        project: record.repoId ? facts.projectLimit(record.repoId) : null,
        app: facts.appLimit(),
      }),
    }),
    appCostLimitView: () => {
      const limit = facts.appLimit();
      const since = Date.now() - RECENT_COST_DAYS * 24 * 60 * 60 * 1000;
      return {
        limit,
        recent: { ...costLimitStore.recent(limitUsd(limit), since), days: RECENT_COST_DAYS },
      };
    },
    recordUsage: (input) => {
      const rows = usageStore.record({ ...input, at: Date.now() });
      reporting(() => usageReporter.recorded(rows));
    },
  };
}

/**
 * Settings → Usage's reads (docs/usage.md), with models and providers by the
 * names Settings gives them, read once per summary; a connected custom API
 * by its own connection name, else `customApiName`.
 */
export function usageReads(
  usageStore: UsageStore,
  slots: { view(): { models: SlotModelView[]; byName: SlotModelView[] } },
  customApiName: string,
): Omit<CoreServices["usage"], "reporting" | "connection"> {
  return {
    summary: (query) => {
      const view = slots.view();
      const rows = [...view.models, ...view.byName];
      const modelName = modelNames(rows);
      const providers = new Map(rows.map((row) => [row.provider, row.providerLabel]));
      return usageStore.summary(query, {
        now: Date.now(),
        names: {
          model: (ref) => modelName(offeringKey(ref)),
          // Never the raw provider id.
          provider: (provider) =>
            providers.get(provider) ??
            (isCustomApiProvider(provider) ? customApiName : providerLabel(provider)),
        },
      });
    },
    tasks: (query) => usageStore.tasks(query, { now: Date.now() }),
    taskCosts: (query) => usageStore.taskCosts(query, { now: Date.now() }),
  };
}
