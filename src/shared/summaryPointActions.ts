import { z } from "zod";
import type { ActionLine } from "./actions";
import { type SummaryPointView, summaryPointSchema } from "./summaryPoint";

/**
 * The catalog line for where conversations summarize (INF-6693): the same
 * request Settings → Intelligence sends, on the captain's ask.
 */
export const summaryPointLines = {
  "summary-point": {
    area: "intelligence",
    tier: "asked",
    change: "inf:settings:summary-point:set",
    current: "inf:settings:summary-point:get",
    value: z.strictObject({ point: summaryPointSchema }),
    line: 'Set where the first mate and crew summarize a long conversation when asked: "automatic" (300,000 tokens, or below a model\'s first price step), 150000, 200000, 300000, 500000, or "model" for each model\'s own limit. A number wins over price steps; steps lists the models that charge more past one.',
    toRequest: (v) => [v.point],
    readValue: (c) => c as SummaryPointView,
    // i18n-exempt: an operation's saved title, written in English like every catalog line's done
    done: (v) =>
      v.point === "automatic"
        ? "summarize automatically"
        : v.point === "model"
          ? "summarize at each model's limit"
          : `summarize at ${v.point} tokens`,
  },
} as const satisfies Record<string, ActionLine>;
