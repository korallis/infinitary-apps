import { describe, expect, it } from "vitest";
import { summaryPointDescription, summaryPointSteps } from "./summaryPointWords";

/** Two models on the person's accounts with listed price steps (Pi's catalog). */
const STEPS = [
  { name: "Claude Haiku 5.5", tokens: 100_000 },
  { name: "GPT-6.1 Sol", tokens: 272_000 },
];

// INF-6693, the captain's answer on its plan: a chosen number wins over a
// price step, and the row names the models that charge more past it.
describe("the summary point row's words", () => {
  it("names only the models whose price step a chosen number passes", () => {
    expect(summaryPointSteps({ point: 200_000, steps: STEPS })).toBe(
      "Requests cost more on Claude Haiku 5.5 past 100,000.",
    );
    expect(summaryPointSteps({ point: 300_000, steps: STEPS })).toBe(
      "Requests cost more on Claude Haiku 5.5 past 100,000 and GPT-6.1 Sol past 272,000.",
    );
    expect(
      summaryPointSteps({ point: 150_000, steps: [{ name: "GPT-6.1 Sol", tokens: 272_000 }] }),
    ).toBeNull();
  });

  it("names none for Automatic, which summarizes before a step, and every one for each model's limit", () => {
    expect(summaryPointSteps({ point: "automatic", steps: STEPS })).toBeNull();
    expect(summaryPointSteps({ point: "model", steps: STEPS })).toBe(
      "Requests cost more on Claude Haiku 5.5 past 100,000 and GPT-6.1 Sol past 272,000.",
    );
  });

  it("says where conversations summarize for each kind of choice", () => {
    expect(summaryPointDescription({ point: "automatic", steps: [] })).toBe(
      "Your first mate and crew summarize a conversation at 300,000 tokens, or sooner where a model charges more past a lower point.",
    );
    expect(summaryPointDescription({ point: 500_000, steps: [] })).toBe(
      "Your first mate and crew summarize a conversation at 500,000 tokens, or at a model's own limit when it is smaller.",
    );
  });
});
