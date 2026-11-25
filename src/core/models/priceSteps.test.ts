import { expect, it } from "vitest";
import { customCatalog } from "../pi/customApiModels";
import { priceSteps } from "./priceSteps";

// INF-6693, the captain's answer on its plan: a chosen summary point wins over
// a price step, so Settings names the models on the person's accounts that
// charge more past it. Prices are Pi's bundled catalog's.
it("names each model on the person's accounts by its first price step, never Copilot's", () => {
  const catalog = customCatalog();
  const lookup = (provider: string, id: string) =>
    catalog.find((model) => model.provider === provider && model.id === id);
  const nameOf = (model: { provider: string; id: string }) =>
    lookup(model.provider, model.id)?.name ?? model.id;
  const steps = priceSteps(
    [
      { provider: "openai-codex", id: "gpt-6.1-sol" },
      // A second account serving the same model names it once.
      { provider: "openai-codex", id: "gpt-6.1-sol" },
      { provider: "amazon-bedrock", id: "anthropic.claude-haiku-5-5" },
      // A model with two steps is named by its first, past 32,000.
      { provider: "openrouter", id: "qwen/qwen3-coder-flash" },
      // Copilot's plan counts requests, so its listed step is no cost.
      { provider: "github-copilot", id: "grok-4.7" },
      // A model whose catalog entry lists no step.
      { provider: "openai-codex", id: "not-in-the-catalog" },
    ],
    lookup,
    nameOf,
  );
  expect(steps).toEqual([
    { name: "Qwen: Qwen3 Coder Flash", tokens: 32_000 },
    { name: "Claude Haiku 5.5", tokens: 100_000 },
    { name: "GPT-6.1 Sol", tokens: 272_000 },
  ]);
});
