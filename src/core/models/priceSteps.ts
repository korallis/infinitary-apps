import { COPILOT_PROVIDER_ID } from "@shared/providers";
import type { PriceStep } from "@shared/summaryPoint";

/** What a model's catalog entry says of its price: each tier's input threshold. */
type PricedModel = { name?: string; cost: { tiers?: readonly { inputTokensAbove: number }[] } };

/**
 * The models on the person's accounts whose input price rises past a step,
 * each by its first one, for Settings to name the models a chosen summary
 * point lets run past it (INF-6693). Copilot's plan counts premium requests,
 * not tokens (docs/quota.md), so its listed prices are no cost; two
 * accounts serving one model name it once.
 */
export function priceSteps(
  models: readonly { provider: string; id: string }[],
  lookup: (providerId: string, modelId: string) => PricedModel | undefined,
  nameOf: (model: { provider: string; id: string }) => string,
): PriceStep[] {
  const byName = new Map<string, number>();
  for (const model of models) {
    if (model.provider === COPILOT_PROVIDER_ID) continue;
    const priced = lookup(model.provider, model.id);
    const tiers = priced?.cost.tiers ?? [];
    if (tiers.length === 0) continue;
    const step = Math.min(...tiers.map((tier) => tier.inputTokensAbove));
    // A model no account row names, such as a models.json one, keeps its catalog name.
    const named = nameOf(model);
    const name = named === model.id && priced?.name ? priced.name : named;
    byName.set(name, Math.min(step, byName.get(name) ?? step));
  }
  return [...byName]
    .map(([name, tokens]) => ({ name, tokens }))
    .sort((a, b) => a.tokens - b.tokens || a.name.localeCompare(b.name));
}
