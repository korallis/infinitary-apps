import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CustodySlot } from "../../src/core/secrets/custody";
import { USAGE_CONNECTION_FILE } from "../../src/core/usageReport/usageConnection";
import * as m from "../../src/shared/i18n/messages.generated";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { leaveSettings } from "./handoverCards";
import { ANSWER_PROMPT_MARKER, MOCK_ANSWER_TITLE } from "./mockProvider";
import { promptInput } from "./prompt";
import { launchSecrets, type SecretsJourneyGlobal } from "./secretsHarness";
import { settingRow, settingsSection } from "./settings";
import { usageTab } from "./usage";
import { focusOn, pressKey, pressWindowKey, runFromSearch, typeInto } from "./windowKeys";

type Arrived = { path: string; headers: IncomingHttpHeaders; body: any };

const TOKEN = "glc_invented-grafana-cloud-token";

/**
 * INF-6587's approved plan, piece 3 (docs/usage-report.md, "The person's
 * reporting connection"): the person adds a reporting connection in
 * Settings → Intelligence by keys, with an Authorization header kept in
 * Secrets, and no file holds the header's value. Settings → Usage names the
 * host. The connection sends every ten minutes and once more at quit, so
 * quitting delivers the crew's turn to the person's collector, a local HTTP
 * server this test owns, in the standard format with the header. After a
 * relaunch Secrets names the header as the reporting connection's, and
 * Remove forgets the connection and its header.
 * The app, its Secrets controller and its sending are real; custody is the
 * Secrets harness's disposable stand-in, kept across the relaunch as a
 * computer's would be, and the model is the mock provider.
 */
test("the person adds a reporting connection by keys and the crew's usage reaches it", async () => {
  test.setTimeout(4 * 60_000);
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
  let custody: Map<CustodySlot, Buffer> = new Map();
  const userDataDir = scratchDir("infinitary-usage-connection-");
  let launched: Awaited<ReturnType<typeof launchSecrets>> | undefined = await launchSecrets({
    userDataDir,
  });
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
      await expect(name).toBeFocused();
      await typeInto(name, "Authorization");
      await pressKey(name, "Tab");
      const value = form.getByLabel(m.settingsUsageConnectionHeaderValue());
      await expect(value).toBeFocused();
      await typeInto(value, `Bearer ${TOKEN}`);
      await pressKey(value, "Enter");
      await expect(row).toContainText(m.settingsUsageConnectionStandard({ host }));
      await expect(form).toHaveCount(0);
      await expect(
        row.getByRole("button", { name: m.settingsUsageConnectionEdit() }),
      ).toBeFocused();
      const saved = readFileSync(join(userDataDir, USAGE_CONNECTION_FILE), "utf8");
      expect(saved).toContain(url);
      expect(saved).not.toContain(TOKEN);
    });

    await test.step("the crew takes a turn", async () => {
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
    });

    await test.step("Settings → Usage names where it goes", async () => {
      await runFromSearch(app, page, "settings.usage");
      await expect(usageTab(page).section.locator("[data-usage-reporting-connection]")).toHaveText(
        m.settingsUsageReportsConnectionTo({ host }),
      );
    });

    await test.step("quitting sends what waits, with the kept header", async () => {
      expect(arrived).toEqual([]);
      // The computer's custody outlives the app, so the relaunch opens the same Secrets.
      const slots = await app.evaluate(() =>
        [...(globalThis as SecretsJourneyGlobal).secretsJourney.custody.slots].map(
          ([slot, bytes]) => [slot, bytes.toString("base64")] as const,
        ),
      );
      custody = new Map(slots.map(([slot, bytes]) => [slot, Buffer.from(bytes, "base64")]));
      await launched?.close();
      launched = undefined;
      expect(arrived.some((entry) => entry.path === "/v1/metrics")).toBe(true);
      for (const entry of arrived) expect(entry.headers.authorization).toBe(`Bearer ${TOKEN}`);
      const names = arrived
        .filter((entry) => entry.path === "/v1/metrics")
        .flatMap((entry) => entry.body.resourceMetrics)
        .flatMap((resource: any) => resource.scopeMetrics)
        .flatMap((scope: any) => scope.metrics.map((metric: any) => metric.name));
      expect(names).toContain("gen_ai.client.token.usage");
    });

    launched = await launchSecrets({ userDataDir, leftCustody: custody });
    const relaunched = launched;
    const page2 = relaunched.page;
    const row2 = settingRow(page2, "usage-connection");

    await test.step("Secrets names the header as the reporting connection's", async () => {
      await runFromSearch(relaunched.app, page2, "settings.secrets");
      const secret = settingsSection(page2, "secrets").locator("li[data-secret-row]", {
        hasText: m.settingsUsageConnectionSecretLabel({ name: "Authorization" }),
      });
      const summary = secret.locator(":scope > details > summary");
      await focusOn(summary);
      await pressKey(summary, "Enter");
      await expect(secret.locator('[data-secrets-kept="usage-report"]')).toContainText(
        m.settingsSecretsKeptUsageReport(),
      );
      await pressKey(
        secret.getByRole("button", { name: m.settingsSecretsManageInIntelligence() }),
        "Enter",
      );
      await expect(
        row2.getByRole("button", { name: m.settingsUsageConnectionEdit() }),
      ).toBeFocused();
    });

    await test.step("Remove, by keys, forgets the connection and its header", async () => {
      const row = row2;
      await pressKey(row.getByRole("button", { name: m.settingsUsageConnectionRemove() }), "Enter");
      await expect(row).toContainText(m.settingsUsageConnectionRemoveWarning());
      const confirm = row.getByRole("button", { name: m.settingsUsageConnectionRemoveConfirm() });
      await expect(confirm).toBeFocused();
      await pressKey(confirm, "Enter");
      await expect(row).toContainText(m.settingsUsageConnectionNone());
      expect(existsSync(join(userDataDir, USAGE_CONNECTION_FILE))).toBe(false);
      await runFromSearch(relaunched.app, page2, "settings.secrets");
      await expect(
        settingsSection(page2, "secrets").locator("li[data-secret-row]", {
          hasText: m.settingsUsageConnectionSecretLabel({ name: "Authorization" }),
        }),
      ).toHaveCount(0);
    });
  } finally {
    await launched?.close();
    await new Promise<void>((done) => collector.close(() => done()));
  }
});
