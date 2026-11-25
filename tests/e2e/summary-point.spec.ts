import { expect, test } from "@playwright/test";
import { SettingsStore } from "../../src/core/storage/settingsStore";
import * as m from "../../src/shared/i18n/messages.generated";
import { launchApp } from "./launch";
import { MOCK_PROVIDER_ID, mockModelsJson } from "./mockModels";
import { readSavedData } from "./savedData";
import { settingRow } from "./settings";
import { focusOn, pressKey, pressWindowKey } from "./windowKeys";

/** The stepped model's name, which this spec puts in its catalog. */
const STEPPED_NAME = "Stepped stand-in";

/**
 * The stand-in's catalog with a second model whose listed input price rises
 * past 272,000 tokens, as some models in Pi's catalog do.
 */
function steppedModelsJson(port: number): string {
  const models = JSON.parse(mockModelsJson(port));
  models.providers[MOCK_PROVIDER_ID].models.push({
    id: "mock-stepped",
    name: STEPPED_NAME,
    input: ["text"],
    contextWindow: 1_050_000,
    cost: {
      input: 2.5,
      output: 15,
      cacheRead: 0.25,
      cacheWrite: 0,
      tiers: [{ inputTokensAbove: 272_000, input: 5, output: 22.5, cacheRead: 0.5, cacheWrite: 0 }],
    },
  });
  return `${JSON.stringify(models, null, 2)}\n`;
}

// INF-6693's plan, piece 2: a person picks where long conversations summarize
// from Settings → Intelligence by keyboard; a number past a model's price step
// names that model, and the choice survives a restart.
test("a person picks where long conversations summarize by keyboard, and the choice survives restart", async () => {
  let launched = await launchApp({ withMockProvider: true, modelsJson: steppedModelsJson });
  const { userDataDir, homeDir } = launched;
  const saved = () => readSavedData(userDataDir, (db) => new SettingsStore(db).getSummaryPoint());
  const openIntelligence = async () => {
    await pressWindowKey(launched.app, ",", ["meta"]);
    const tab = launched.page.locator('[role="tab"][id$="-tab-subscriptions"]');
    await focusOn(tab);
    await pressKey(tab, "Enter");
    return settingRow(launched.page, "summary-point");
  };
  try {
    const row = await openIntelligence();
    const select = row.getByRole("combobox", { name: m.settingsSummaryPointTitle() });
    await expect(select).toBeEnabled();
    await expect(select).toHaveValue("automatic");
    await expect(row.locator("[data-summary-point-steps]")).toHaveCount(0);
    // A native select: Tab reaches it, and its first letters pick a point.
    await focusOn(select);
    await pressKey(select, "3");
    await expect(select).toHaveValue("300000");
    await expect.poll(saved).toBe(300_000);
    await expect(row.locator("[data-summary-point-steps]")).toHaveText(
      m.settingsSummaryPointSteps({
        models: m.settingsSummaryPointStep({ name: STEPPED_NAME, tokens: "272,000" }),
      }),
    );
    await pressKey(select, "1");
    await expect(select).toHaveValue("150000");
    await expect.poll(saved).toBe(150_000);
    await expect(row.locator("[data-summary-point-steps]")).toHaveCount(0);
    await launched.close();
    launched = await launchApp({
      userDataDir,
      homeDir,
      withMockProvider: true,
      modelsJson: steppedModelsJson,
    });
    const reopened = (await openIntelligence()).getByRole("combobox", {
      name: m.settingsSummaryPointTitle(),
    });
    await expect(reopened).toHaveValue("150000");
  } finally {
    await launched.close();
  }
});
