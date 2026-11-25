import { z } from "zod";

/**
 * Where long conversations summarize, the captain's Settings choice
 * (INF-6693's plan, piece 2): `automatic` is the app's own rule (300,000
 * tokens, or before the model's first usable price step when that comes
 * sooner); a number is the person's own point, which wins over price steps
 * (the captain's answer on that plan); `model` leaves each model's own
 * limit.
 */
export const SUMMARY_POINT_TOKENS = [150_000, 200_000, 300_000, 500_000] as const;

export const summaryPointSchema = z.union([
  z.literal("automatic"),
  z.literal("model"),
  z.literal(150_000),
  z.literal(200_000),
  z.literal(300_000),
  z.literal(500_000),
]) satisfies z.ZodType<SummaryPoint>;
export type SummaryPoint = "automatic" | "model" | (typeof SUMMARY_POINT_TOKENS)[number];

export const DEFAULT_SUMMARY_POINT: SummaryPoint = "automatic";

/** A model on the person's accounts whose input price rises past `tokens`. */
export const priceStepSchema = z.strictObject({
  name: z.string().min(1).max(256),
  tokens: z.number().int().positive(),
});
export type PriceStep = z.infer<typeof priceStepSchema>;

export const summaryPointViewSchema = z.strictObject({
  point: summaryPointSchema,
  /** The models on the person's accounts with a price step, each by its first one. */
  steps: z.array(priceStepSchema).max(256),
});
export type SummaryPointView = z.infer<typeof summaryPointViewSchema>;

/** The models a choice lets run past their price step, where every input token costs more. */
export function stepsPassed(point: SummaryPoint, steps: readonly PriceStep[]): PriceStep[] {
  if (point === "automatic") return [];
  return steps.filter((step) => point === "model" || step.tokens < point);
}

/**
 * The rule a crewmate's open carries to a computer that runs work
 * (`summary-point.md`): a token ceiling, summarizing before the model's
 * first price step, both, or neither for each model's own limit.
 */
export const placedCompactionSchema = z.strictObject({
  maxContextTokens: z.number().int().positive().max(100_000_000).optional(),
  belowPriceStep: z.literal(true).optional(),
});
