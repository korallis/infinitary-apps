import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { USAGE_CONNECTION_FILE } from "../../src/core/usageReport/usageConnection";
import * as m from "../../src/shared/i18n/messages.generated";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { leaveSettings } from "./handoverCards";
import { ANSWER_PROMPT_MARKER, MOCK_ANSWER_TITLE } from "./mockProvider";
import { promptInput } from "./prompt";
import { launchSecrets } from "./secretsHarness";
import { settingRow } from "./settings";
import { usageTab } from "./usage";
import { focusOn, pressKey, pressWindowKey, runFromSearch, typeInto } from "./windowKeys";

type Arrived = { path: string; headers: IncomingHttpHeaders; body: any };

const TOKEN = "glc_invented-grafana-cloud-token";

/**
 * INF-6587's approved plan, piece 3 (docs/usage-report.md, "The person's
 * reporting connection"): the person adds a reporting connection in
 * Settings → Intelligence by keys, with an Authorization header kept in
 * Secrets; the crew's next turn reaches the person's collector, a local
 * HTTP server this test owns, in the standard format with the header, and
 * no file holds the header's value. Settings → Usage names the host, and
 * Remove forgets the connection.
 * The app, its Secrets controller and its sending are real; custody is the
 * Secrets harness's disposable stand-in and the model is the mock provider.
 */
test("the person adds a reporting connection by keys and the crew's usage reaches it", async () => {
  // The connection sends once a minute, so the turn's batch arrives up to a minute later.
  test.setTimeout(3 * 60_000);
  const arrived: Arrived[] = [];
  const collector = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => {
      text += chunk;
    });
    request.on("end", () => {
      arrived.push({ path: request.url ?? "", headers: request.headers, body: JSON.parse(text) });
      response.end("{}");
    });
  });
  await new Promise<void>((done) => collector.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;
  const host = new URL(url).host;
  const userDataDir = scratchDir("infinitary-usage-connection-");
  const launched = await launchSecrets({ userDataDir });
  try {
    const { app, page } = launched;
    const row = settingRow(page, "usage-connection");

    await test.step("Add connection, filled and saved by keys", async () => {
      await pressWindowKey(app, ",", ["meta"]);
      const intelligence = page.locator('[role="tab"][id$="-tab-subscriptions"]');
      await focusOn(intelligence);
      await pressKey(intelligence, "Enter");
      await expect(row).toContainText(m.settingsUsageConnectionNone());
      await pressKey(row.getByRole("button", { name: m.settingsUsageConnectionAdd() }), "Enter");
      const form = row.locator("[data-usage-connection-form]");
      const address = form.getByLabel(m.settingsUsageConnectionAddress());
      await expect(address).toBeFocused();
      await typeInto(address, url);
      await expect(form.getByLabel(m.settingsUsageConnectionReads())).toHaveValue("standard");
      await pressKey(
        form.getByRole("button", { name: m.settingsUsageConnectionAddHeader() }),
        "Enter",
      );
      const name = form.getByLabel(m.settingsUsageConnectionHeaderName());
      await focusOn(name);
      await typeInto(name, "Authorization");
      await pressKey(name, "Tab");
      const value = form.getByLabel(m.settingsUsageConnectionHeaderValue());
      await expect(value).toBeFocused();
      await typeInto(value, `Bearer ${TOKEN}`);
      await pressKey(value, "Enter");
      await expect(row).toContainText(m.settingsUsageConnectionStandard({ host }));
      await expect(form).toHaveCount(0);
      const saved = readFileSync(join(userDataDir, USAGE_CONNECTION_FILE), "utf8");
      expect(saved).toContain(url);
      expect(saved).not.toContain(TOKEN);
    });

    await test.step("the crew's next turn reaches the collector with the kept header", async () => {
      await leaveSettings(page);
      const input = promptInput(page);
      await expect(input).toBeEnabled();
      await input.fill(`please ${ANSWER_PROMPT_MARKER}: report this turn`);
      await input.press("Enter");
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.infinitary.cards.list())).some(
              (card) => card.title === MOCK_ANSWER_TITLE,
            ),
          { timeout: 30_000 },
        )
        .toBe(true);
      await waitForFirstmateIdle(page);
      await expect
        .poll(() => arrived.some((entry) => entry.path === "/v1/metrics"), { timeout: 90_000 })
        .toBe(true);
      for (const entry of arrived) expect(entry.headers.authorization).toBe(`Bearer ${TOKEN}`);
      const names = arrived
        .filter((entry) => entry.path === "/v1/metrics")
        .flatMap((entry) => entry.body.resourceMetrics)
        .flatMap((resource: any) => resource.scopeMetrics)
        .flatMap((scope: any) => scope.metrics.map((metric: any) => metric.name));
      expect(names).toContain("gen_ai.client.token.usage");
    });

    await test.step("Settings → Usage names where it goes", async () => {
      await runFromSearch(app, page, "settings.usage");
      await expect(usageTab(page).section.locator("[data-usage-reporting-connection]")).toHaveText(
        m.settingsUsageReportsConnectionTo({ host }),
      );
    });

    await test.step("Remove, by keys, forgets the connection", async () => {
      const intelligence = page.locator('[role="tab"][id$="-tab-subscriptions"]');
      await focusOn(intelligence);
      await pressKey(intelligence, "Enter");
      await pressKey(row.getByRole("button", { name: m.settingsUsageConnectionRemove() }), "Enter");
      await expect(row).toContainText(m.settingsUsageConnectionRemoveWarning());
      await pressKey(
        row.getByRole("button", { name: m.settingsUsageConnectionRemoveConfirm() }),
        "Enter",
      );
      await expect(row).toContainText(m.settingsUsageConnectionNone());
      expect(existsSync(join(userDataDir, USAGE_CONNECTION_FILE))).toBe(false);
    });
  } finally {
    await launched.close();
    await new Promise<void>((done) => collector.close(() => done()));
  }
});
