import { z } from "zod";
import { usageCostSourceSchema } from "./events";
import type { WorkKind } from "./routingPolicy";

/**
 * Settings → Usage (docs/usage.md): the recorded model usage across the
 * fleet, read from the usage ledger by `UsageStore.summary`. The core
 * answers one summary per period and kind of work; the unit (tokens or
 * estimated dollars) is the window's own choice, so every number here
 * carries both.
 */

export const USAGE_PERIODS = ["7d", "30d", "all"] as const;
export const usagePeriodSchema = z.enum(USAGE_PERIODS);
export type UsagePeriod = z.infer<typeof usagePeriodSchema>;

/**
 * Which work: everything, task work (a task's own turns and the supporting
 * model calls made for it), the Firstmate's own conversation, or other
 * work - model calls tied to no task, or to a task the record no longer has.
 */
export const USAGE_SCOPES = ["all", "task", "firstmate", "other"] as const;
export const usageScopeSchema = z.enum(USAGE_SCOPES);
export type UsageScope = z.infer<typeof usageScopeSchema>;

export const usageQuerySchema = z.strictObject({
  period: usagePeriodSchema,
  scope: usageScopeSchema,
});
export type UsageQuery = z.infer<typeof usageQuerySchema>;

/** What Usage opens on: all work, the last 30 days. */
export const DEFAULT_USAGE_QUERY: UsageQuery = { period: "30d", scope: "all" };

/** How Usage shows every amount; estimated dollars until the captain picks tokens. */
export const usageUnitSchema = z.enum(["tokens", "usd"]);
export type UsageUnit = z.infer<typeof usageUnitSchema>;

/** What Usage opens on before the captain picks a unit. */
export const DEFAULT_USAGE_UNIT: UsageUnit = "usd";

const categoriesSchema = <T extends z.ZodType>(value: T) =>
  z.object({ input: value, output: value, cacheRead: value, cacheWrite: value });

/**
 * One aggregate over ledger records. Token categories are the known sums,
 * each counted once. `cost` is the known estimate in USD over the priced
 * records only, null when none is priced: a record with no price, or an
 * older zero, is never counted as free.
 */
export const usageAmountSchema = z.object({
  tokens: categoriesSchema(z.number()),
  records: z.number(),
  /** Records that reported any token count. */
  counted: z.number(),
  /** Records reporting each token category; absent on older homes, never inferred from counted. */
  tokenReported: categoriesSchema(z.number()).optional(),
  cost: z.number().nullable(),
  /** Records with a price. */
  priced: z.number(),
  /** The estimate by category over the priced records that split it, null where none did. */
  costParts: categoriesSchema(z.number().nullable()),
  /** Priced records whose estimate is split by category. */
  split: z.number(),
});
export type UsageAmount = z.infer<typeof usageAmountSchema>;
export type UsageCategory = keyof UsageAmount["tokens"];

export const EMPTY_USAGE_AMOUNT: UsageAmount = {
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  records: 0,
  counted: 0,
  tokenReported: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  cost: null,
  priced: 0,
  costParts: { input: null, output: null, cacheRead: null, cacheWrite: null },
  split: 0,
};

/**
 * Where usage went: one task, the Firstmate, or other work. The tab reads
 * `UsageWhere`; the largest tasks stay in the published summary for its clients.
 */
export const usagePlaceSchema = z.object({
  kind: z.enum(["task", "firstmate", "other"]),
  /** The task's key, title and project; null for the Firstmate and other work. */
  task: z.object({ key: z.string(), title: z.string(), project: z.string().nullable() }).nullable(),
  amount: usageAmountSchema,
});
export type UsagePlace = z.infer<typeof usagePlaceSchema>;

/**
 * The kinds of work Where it went names: the whole-task kind a task's shape
 * saved (`workKindSchema`). A task with none, `unclear`, or a kind this list
 * does not know is null, "Other task work".
 */
export const USAGE_WORK_KINDS = [
  "plan",
  "research",
  "retrieval",
  "reproduce",
  "implement",
  "fix",
  "chore",
  "review",
  "operation",
] as const satisfies ReadonlyArray<WorkKind | "operation">;
export const usageWorkKindSchema = z.enum(USAGE_WORK_KINDS);
export type UsageWorkKind = z.infer<typeof usageWorkKindSchema>;

export const usageProjectSchema = z.object({
  /** Null when the record no longer has the task's project. */
  project: z.object({ id: z.string(), name: z.string() }).nullable(),
  amount: usageAmountSchema,
  /** Each kind once; together they are the subtotal, never added to it. */
  kinds: z.array(z.object({ kind: usageWorkKindSchema.nullable(), amount: usageAmountSchema })),
});
export type UsageProject = z.infer<typeof usageProjectSchema>;

/**
 * Where usage went (docs/usage.md): the Firstmate's own conversation, each
 * project's task work by kind, and other work. The Firstmate, the project
 * subtotals and other work add up to the whole.
 */
export const usageWhereSchema = z.object({
  firstmate: usageAmountSchema,
  projects: z.array(usageProjectSchema),
  other: usageAmountSchema,
});
export type UsageWhere = z.infer<typeof usageWhereSchema>;

/**
 * How a model row knows its model: every record named by the provider
 * (`served`), the model the app asked for on some (`requested`), or recorded
 * before models were kept apart on some (`recorded`) - the weakest wins.
 */
export const usageAttributionSchema = z.enum(["served", "requested", "recorded"]);
export type UsageAttribution = z.infer<typeof usageAttributionSchema>;

/** Where a model's estimates came from; `unrecorded` for priced records from before the source was kept. */
export const usagePriceSourceSchema = z.union([usageCostSourceSchema, z.literal("unrecorded")]);
export type UsagePriceSource = z.infer<typeof usagePriceSourceSchema>;

export const usageModelSchema = z.object({
  /** Stable identity: the provider and model as recorded. */
  id: z.string(),
  provider: z.string().nullable(),
  providerName: z.string().nullable(),
  model: z.string().nullable(),
  /** The model by the name every surface gives it, or its id; null when none was recorded. */
  name: z.string().nullable(),
  attribution: usageAttributionSchema,
  priceSources: z.array(usagePriceSourceSchema),
  amount: usageAmountSchema,
  /** The work it served: the Firstmate, other work, and its largest tasks. */
  places: z.array(usagePlaceSchema),
  /** Its work, by project and kind, over this model's records alone. */
  where: usageWhereSchema,
});
export type UsageModel = z.infer<typeof usageModelSchema>;

export const usageDaySchema = z.object({
  /** The local calendar date, YYYY-MM-DD. */
  date: z.string(),
  amount: usageAmountSchema,
});
export type UsageDay = z.infer<typeof usageDaySchema>;

export const usageSummarySchema = z.object({
  query: usageQuerySchema,
  /** The first local day the period covers; null for all time with nothing recorded. */
  since: z.number().nullable(),
  /** When the summary was read: today is partial until it ends. */
  at: z.number(),
  total: usageAmountSchema,
  /** Every local day of the period, oldest first, today last. */
  days: z.array(usageDaySchema),
  models: z.array(usageModelSchema),
  /**
   * The Firstmate, other work, and the largest tasks by tokens and by
   * estimate, so either unit can name its own three largest.
   */
  places: z.array(usagePlaceSchema),
  where: usageWhereSchema,
  /** Tasks finished in the period and kind of work. */
  finished: z.number(),
  /** Tasks finished across all retained history, for the milestones. */
  finishedEver: z.number(),
});
export type UsageSummary = z.infer<typeof usageSummarySchema>;

/**
 * Why a company's collector has not taken this computer's Claude work for a
 * while: it could not be reached, the connection to it could not be made
 * secure, or it answered with a refusal.
 */
export const usageReportingRefusalReasonSchema = z.enum([
  "unreachable",
  "secure-connection",
  "refused",
]);
export type UsageReportingRefusalReason = z.infer<typeof usageReportingRefusalReasonSchema>;

/**
 * Where usage is also reported, when a company's Claude Code setup names a
 * collector: its host, or null (docs/usage-report.md, "Destinations"); and
 * the host of the person's own reporting connection.
 * `claudeOnly` when only Claude's own records go there, as for a setup the
 * report cannot send every other model's work to.
 * `refusal` names the collector of the person's own setup whose failures have
 * gone on for a minute or more, with no batch taken between its first and
 * latest, and why.
 */
export const usageReportingSchema = z.object({
  host: z.string().nullable(),
  claudeOnly: z.literal(true).optional(),
  refusal: z.object({ host: z.string(), reason: usageReportingRefusalReasonSchema }).optional(),
  /** The host of the reporting connection the person added, which gets every model's work. */
  connection: z.string().optional(),
});
export type UsageReporting = z.infer<typeof usageReportingSchema>;

/** Recent tasks: ten at first, ten more each time the captain asks. */
export const USAGE_TASK_PAGE = 10;
/** The most tasks one read lists. */
export const USAGE_TASKS_MAX = 5000;

/** Recent tasks over a period and kind of work, the newest `limit` of them. */
export const usageTasksQuerySchema = z.strictObject({
  period: usagePeriodSchema,
  scope: usageScopeSchema,
  limit: z.number().int().min(1).max(USAGE_TASKS_MAX),
});
export type UsageTasksQuery = z.infer<typeof usageTasksQuerySchema>;

/**
 * One task's usage in the period. `reported` says how many records named
 * each token category and `costReported` how many priced records split
 * their estimate into it, so a category no record reported is told from a
 * measured zero.
 */
export const usageTaskSchema = z.object({
  task: z.object({ key: z.string(), title: z.string(), project: z.string().nullable() }),
  /** When the task was created: the list's order, newest first. */
  createdAt: z.number(),
  amount: usageAmountSchema,
  reported: categoriesSchema(z.number()),
  costReported: categoriesSchema(z.number()),
});
export type UsageTask = z.infer<typeof usageTaskSchema>;

export const usageTasksSchema = z.object({
  query: usageTasksQuerySchema,
  /** The newest tasks with recorded usage in the period and work, at most `limit`. */
  tasks: z.array(usageTaskSchema),
  /** How many tasks have recorded usage in the period and work. */
  matching: z.number(),
});
export type UsageTasks = z.infer<typeof usageTasksSchema>;

/**
 * Cost per task (docs/usage.md): the finished tasks a period's chart needs,
 * each counted with its reviews. The read reaches back one window before
 * the period starts, so the period's first point has a full window.
 */
export const usageTaskCostsQuerySchema = z.strictObject({ period: usagePeriodSchema });
export type UsageTaskCostsQuery = z.infer<typeof usageTaskCostsQuerySchema>;

/** The days before each point whose finished tasks make its median. */
export const COST_WINDOW_DAYS = 7;

export const usageTaskCostSchema = z.object({
  /** When it closed done: where it falls on the chart. */
  closedAt: z.number(),
  /** Null when the record no longer has the task's project. */
  project: z.object({ id: z.string(), name: z.string() }).nullable(),
  /** Its saved kind; null for none, `unclear` or one the list does not know. Never `review`. */
  kind: usageWorkKindSchema.nullable(),
  /** Tokens it and its reviews recorded; null when no record reported any. */
  tokens: z.number().nullable(),
  /** Its and its reviews' known estimate in USD; null when nothing was priced. */
  cost: z.number().nullable(),
});
export type UsageTaskCost = z.infer<typeof usageTaskCostSchema>;

export const usageTaskCostsSchema = z.object({
  query: usageTaskCostsQuerySchema,
  /** The period's first moment; null for all time with nothing finished. */
  since: z.number().nullable(),
  /** When it was read: the chart's last point. */
  at: z.number(),
  /** Finished tasks from one window before `since`, oldest closed first. */
  tasks: z.array(usageTaskCostSchema),
});
export type UsageTaskCosts = z.infer<typeof usageTaskCostsSchema>;

/** The points a period's line draws, and the fewest tasks a point needs. */
export const COST_POINTS = 150;
export const COST_MIN_TASKS = 5;

/** Which finished tasks the chart counts: every one, or the projects and kinds picked. */
export type CostSelection = {
  /** Project ids, `null` standing for a project the record no longer has; null for all. */
  projects: ReadonlySet<string | null> | null;
  /** Kinds, `null` standing for other task work; null for all. */
  kinds: ReadonlySet<UsageWorkKind | null> | null;
};

/** One point: the window's median, its middle half, and how many tasks it holds. */
export type CostPoint = {
  at: number;
  tasks: number;
  /** Null when fewer than `COST_MIN_TASKS` finished in the window. */
  median: number | null;
  q1: number | null;
  q3: number | null;
};

export type CostSeries = {
  points: CostPoint[];
  /** The last point: the window ending now. */
  now: CostPoint;
  /** The first point with a median, or null when none has one. */
  start: CostPoint | null;
  /** Now against the start, as a fraction; null when either lacks a median or the start is 0. */
  change: number | null;
  /** Selected tasks in the period left out for want of a value in the unit. */
  missing: number;
};

/** A quantile of sorted values, interpolated between the two nearest. */
export function quantile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const at = (sorted.length - 1) * fraction;
  const low = Math.floor(at);
  const high = Math.min(low + 1, sorted.length - 1);
  const lower = sorted[low] ?? 0;
  return lower + ((sorted[high] ?? lower) - lower) * (at - low);
}

/** Whether a finished task is in the selection. */
export function inCostSelection(task: UsageTaskCost, selection: CostSelection): boolean {
  return (
    (selection.projects === null || selection.projects.has(task.project?.id ?? null)) &&
    (selection.kinds === null || selection.kinds.has(task.kind))
  );
}

/** A task's value in the unit; a zero estimate proves nothing, so it has none. */
function costValue(task: UsageTaskCost, unit: UsageUnit): number | null {
  const value = unit === "usd" ? task.cost : task.tokens;
  return value !== null && value > 0 ? value : null;
}

/**
 * The window ending at `at`: the selected tasks that closed in the
 * `COST_WINDOW_DAYS` before it, sorted by their values.
 */
function costWindow(
  values: readonly { at: number; value: number }[],
  at: number,
): { tasks: number; sorted: number[] } {
  const from = at - COST_WINDOW_DAYS * 86_400_000;
  const sorted = values
    .filter((each) => each.at > from && each.at <= at)
    .map((each) => each.value)
    .sort((a, b) => a - b);
  return { tasks: sorted.length, sorted };
}

/** The point for the window ending at `at`. */
export function costPoint(values: readonly { at: number; value: number }[], at: number): CostPoint {
  const { tasks, sorted } = costWindow(values, at);
  if (tasks < COST_MIN_TASKS) return { at, tasks, median: null, q1: null, q3: null };
  return {
    at,
    tasks,
    median: quantile(sorted, 0.5),
    q1: quantile(sorted, 0.25),
    q3: quantile(sorted, 0.75),
  };
}

/** The selected tasks with a value in the unit, and how many in the period have none. */
export function costValues(
  costs: UsageTaskCosts,
  selection: CostSelection,
  unit: UsageUnit,
): { values: { at: number; value: number }[]; missing: number } {
  const values: { at: number; value: number }[] = [];
  let missing = 0;
  for (const task of costs.tasks) {
    if (!inCostSelection(task, selection)) continue;
    const value = costValue(task, unit);
    if (value !== null) values.push({ at: task.closedAt, value });
    else if (costs.since === null || task.closedAt >= costs.since) missing++;
  }
  return { values, missing };
}

/**
 * The sliding median over the period (INF-6217's plan): `COST_POINTS`
 * evenly spaced points from the period's first moment to now, each the
 * median of the selected tasks that closed in the `COST_WINDOW_DAYS`
 * before it, with the middle half around it. A window with fewer than
 * `COST_MIN_TASKS` has no median, never a zero.
 */
export function costSeries(
  costs: UsageTaskCosts,
  selection: CostSelection,
  unit: UsageUnit,
): CostSeries {
  const { values, missing } = costValues(costs, selection, unit);
  const from = costs.since ?? costs.at;
  const points: CostPoint[] = [];
  for (let step = 0; step <= COST_POINTS; step++) {
    points.push(costPoint(values, Math.round(from + ((costs.at - from) * step) / COST_POINTS)));
  }
  const now = points[points.length - 1] ?? costPoint(values, costs.at);
  const start = points.find((point) => point.median !== null) ?? null;
  const change =
    start?.median && now.median !== null && start !== now ? now.median / start.median - 1 : null;
  return { points, now, start, change, missing };
}

/** The end of each local day in the period, today ending now: the Values table's rows. */
export function costDayEnds(costs: UsageTaskCosts): number[] {
  if (costs.since === null) return [];
  const ends: number[] = [];
  const day = new Date(costs.since);
  day.setHours(0, 0, 0, 0);
  for (;;) {
    day.setDate(day.getDate() + 1);
    const end = day.getTime() - 1;
    if (end >= costs.at) break;
    ends.push(end);
  }
  ends.push(costs.at);
  return ends;
}

export function usageTokens(amount: UsageAmount): number {
  const { input, output, cacheRead, cacheWrite } = amount.tokens;
  return input + output + cacheRead + cacheWrite;
}

/**
 * An amount in the chosen unit, or null where it is not available: no
 * record reported a token count, or no record is priced.
 */
export function usageValue(amount: UsageAmount, unit: UsageUnit): number | null {
  if (unit === "usd") return amount.cost;
  return amount.counted > 0 ? usageTokens(amount) : null;
}

export function usageCategoryValue(
  amount: UsageAmount,
  category: UsageCategory,
  unit: UsageUnit,
): number | null {
  if (unit === "usd") return amount.costParts[category];
  return (amount.tokenReported?.[category] ?? 0) > 0 ? amount.tokens[category] : null;
}

/** Sums amounts, keeping an unknown estimate unknown until some record is priced. */
export function addUsageAmounts(amounts: readonly UsageAmount[]): UsageAmount {
  const plus = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : a + b);
  return amounts.reduce<UsageAmount>(
    (sum, next) => ({
      tokens: {
        input: sum.tokens.input + next.tokens.input,
        output: sum.tokens.output + next.tokens.output,
        cacheRead: sum.tokens.cacheRead + next.tokens.cacheRead,
        cacheWrite: sum.tokens.cacheWrite + next.tokens.cacheWrite,
      },
      records: sum.records + next.records,
      counted: sum.counted + next.counted,
      tokenReported:
        (sum.records === 0 || sum.tokenReported) && (next.records === 0 || next.tokenReported)
          ? {
              input: (sum.tokenReported?.input ?? 0) + (next.tokenReported?.input ?? 0),
              output: (sum.tokenReported?.output ?? 0) + (next.tokenReported?.output ?? 0),
              cacheRead: (sum.tokenReported?.cacheRead ?? 0) + (next.tokenReported?.cacheRead ?? 0),
              cacheWrite:
                (sum.tokenReported?.cacheWrite ?? 0) + (next.tokenReported?.cacheWrite ?? 0),
            }
          : undefined,
      cost: plus(sum.cost, next.cost),
      priced: sum.priced + next.priced,
      costParts: {
        input: plus(sum.costParts.input, next.costParts.input),
        output: plus(sum.costParts.output, next.costParts.output),
        cacheRead: plus(sum.costParts.cacheRead, next.costParts.cacheRead),
        cacheWrite: plus(sum.costParts.cacheWrite, next.costParts.cacheWrite),
      },
      split: sum.split + next.split,
    }),
    EMPTY_USAGE_AMOUNT,
  );
}

/** Finished-work milestones: a few counts worth noticing, and nothing past them. */
export const USAGE_MILESTONES = [1, 10, 25, 50] as const;

export function usageMilestone(finished: number): { reached: number | null; next: number | null } {
  const reached = [...USAGE_MILESTONES].reverse().find((stop) => finished >= stop) ?? null;
  const next = USAGE_MILESTONES.find((stop) => finished < stop) ?? null;
  return { reached, next };
}
