import { expect, type Locator, type Page, test } from "@playwright/test";
import { MODELS_WORDS } from "../../src/renderer/src/settings/modelsWords";
import {
  noReaderText,
  SUBSCRIPTIONS_WORDS,
} from "../../src/renderer/src/settings/subscriptionsWords";
import * as m from "../../src/shared/i18n/messages.generated";
import { SLOTS } from "../../src/shared/modelSlots";
import type { QuotaSnapshotView } from "../../src/shared/quota";
import { providerScopes } from "../../src/shared/quotaSignals";
import { scratchDir } from "../helpers/scratchDirs";
import { seedAccountAuth, seedAccountRegistry, seedAccountStore } from "./accountFixtures";
import { launchSignedInClaude } from "./claudeAccount";
import type { LaunchedApp } from "./launch";
import { writeMockClaudeClient } from "./mockClaudeClient";
import { modelsSection } from "./modelsBoard";
import { seedQuotaFixture } from "./quotaFixtures";
import { pressKey, pressWindowKey } from "./windowKeys";

/**
 * The Subscriptions tab in the Instruments direction (captain's pick from
 * the prototype review, 2026-09-05), run against the review's own dataset:
 * ten accounts across the catalog, in every state the quota sensor can
 * produce - a combined-bound reading with a projected-exhaustion verdict,
 * an untriggered window, a paused account, a sign-in the vendor rejected
 * after renewal, Grok's disclosed no-window line, a three-window Claude on
 * pace, a stale last-known-good, a monthly credit window, a rate-limited
 * API key, and an OpenRouter key with no quota row at all.
 *
 * What is pinned here is the HONESTY each state carries: a reading shows
 * its windows, nothing read is never a meter, and Sign in appears only
 * where it is the way back.
 */

const HOUR = 3600_000;
const ID = {
  codexPersonal: "acct_cx1",
  codexWork: "acct_cx2",
  codexOld: "acct_cx3",
  copilotPersonal: "acct_cp2",
  grok: "acct_gk1",
  claudeMax: "acct_cl1",
  claudeWork: "acct_cl2",
  grokTeam: "acct_gk2",
  kimi: "acct_km1",
  openrouter: "acct_or1",
} as const;
const ACCOUNTS: string[] = Object.values(ID);

function buildQuotaFixture(now: number): QuotaSnapshotView {
  const W = { session: 18_000, week: 604_800, month: 2_592_000 };
  return {
    generatedAt: new Date(now).toISOString(),
    fetchedAt: now,
    providers: [
      {
        provider: "codex",
        label: "Codex",
        accountId: ID.codexPersonal,
        accountLabel: "Personal",
        plan: "Plus",
        account: "kun@example.com",
        status: "ok",
        stale: false,
        windows: [
          {
            id: "session",
            label: "session",
            percentRemaining: 74,
            pace: "behind",
            resetText: "resets 3pm",
            resetsAtMs: now + 2 * HOUR,
            windowSeconds: W.session,
          },
          {
            id: "weekly",
            label: "weekly",
            percentRemaining: 9,
            pace: "ahead",
            resetText: "resets Fri",
            resetsAtMs: now + 120 * HOUR,
            windowSeconds: W.week,
          },
        ],
      },
      {
        provider: "codex",
        label: "Codex",
        accountId: ID.codexWork,
        accountLabel: "Work #2",
        plan: "Pro",
        status: "ok",
        stale: false,
        windows: [
          // Untriggered: full, no clock, no pace word.
          { id: "session", label: "session", percentRemaining: 100 },
          {
            id: "weekly",
            label: "weekly",
            percentRemaining: 38,
            pace: "ahead",
            resetText: "resets Wed",
            resetsAtMs: now + 72 * HOUR,
            windowSeconds: W.week,
          },
        ],
      },
      {
        provider: "codex",
        label: "Codex",
        accountId: ID.codexOld,
        accountLabel: "Old team",
        plan: "Plus",
        status: "ok",
        stale: false,
        windows: [
          { id: "session", label: "session", percentRemaining: 100 },
          {
            id: "weekly",
            label: "weekly",
            percentRemaining: 91,
            pace: "behind",
            resetText: "resets Sun",
            resetsAtMs: now + 48 * HOUR,
            windowSeconds: W.week,
          },
        ],
      },
      {
        provider: "grok",
        label: "Grok",
        accountId: ID.copilotPersonal,
        accountLabel: "Rejected",
        status: "auth_required",
        stale: false,
        reason: "credential_rejected",
        windows: [],
      },
      {
        provider: "grok",
        label: "Grok",
        accountId: ID.grok,
        accountLabel: "Personal",
        plan: "SuperGrok",
        status: "not_measured",
        stale: false,
        reason: "no_window_read",
        detail: "Infinitary doesn't read usage for this sign-in yet.",
        windows: [],
      },
      {
        provider: "claude",
        label: "Claude",
        accountId: ID.claudeMax,
        accountLabel: "Personal Max",
        plan: "Max",
        account: "kun@example.com",
        status: "ok",
        stale: false,
        windows: [
          {
            id: "five_hour",
            label: "session",
            percentRemaining: 68,
            pace: "behind",
            resetText: "resets 6pm",
            resetsAtMs: now + 2 * HOUR,
            windowSeconds: W.session,
          },
          {
            id: "seven_day",
            label: "weekly",
            percentRemaining: 41,
            pace: "behind",
            resetText: "resets Mon",
            resetsAtMs: now + 60 * HOUR,
            windowSeconds: W.week,
          },
          {
            id: "seven_day_opus",
            label: "weekly (Opus)",
            percentRemaining: 55,
            pace: "behind",
            resetText: "resets Mon",
            resetsAtMs: now + 60 * HOUR,
            windowSeconds: W.week,
          },
        ],
      },
      {
        provider: "claude",
        label: "Claude",
        accountId: ID.claudeWork,
        accountLabel: "Work",
        plan: "Max",
        account: "kun@acme.example",
        status: "ok",
        stale: true,
        measuredAt: now - 3 * HOUR,
        reason: "network_unreachable",
        windows: [
          {
            id: "five_hour",
            label: "session",
            percentRemaining: 22,
            pace: "ahead",
            resetText: "resets 7pm",
            resetsAtMs: now + 3 * HOUR,
            windowSeconds: W.session,
          },
          {
            id: "seven_day",
            label: "weekly",
            percentRemaining: 64,
            pace: "behind",
            resetText: "resets Tue",
            resetsAtMs: now + 84 * HOUR,
            windowSeconds: W.week,
          },
          {
            id: "seven_day_opus",
            label: "weekly (Opus)",
            percentRemaining: 70,
            pace: "behind",
            resetText: "resets Tue",
            resetsAtMs: now + 84 * HOUR,
            windowSeconds: W.week,
          },
        ],
      },
      {
        provider: "grok",
        label: "Grok",
        accountId: ID.grokTeam,
        accountLabel: "Team",
        plan: "SuperGrok Heavy",
        account: "kun@example.com",
        status: "ok",
        stale: false,
        windows: [
          {
            id: "monthly",
            label: "monthly credits",
            percentRemaining: 40,
            pace: "on_pace",
            resetText: "resets Sep 17",
            resetsAtMs: now + 288 * HOUR,
            windowSeconds: W.month,
          },
        ],
      },
      {
        provider: "openrouter",
        label: "OpenRouter",
        accountId: ID.kimi,
        accountLabel: "Limited",
        status: "rate_limited",
        stale: false,
        reason: "rate_limited",
        retryAfter: "120",
        windows: [],
      },
    ],
  };
}

/**
 * The account matrix the way the vault lays it out: one isolated store per
 * account with a provider-shaped credential file (fake values). Two stores
 * are deliberately EMPTY - one Grok account (the vendor rejected its
 * credential) and OpenRouter (never signed in) - so their rows read as
 * signed out and offer the one inline action.
 */
function seedAccounts(userDataDir: string): void {
  const store = (providerId: string, accountId: string, credential?: Record<string, unknown>) => {
    seedAccountStore(userDataDir, providerId, accountId, { recursive: true, mode: 0o700 });
    if (credential) {
      seedAccountAuth(
        userDataDir,
        providerId,
        accountId,
        { [providerId]: credential },
        {
          mode: 0o600,
        },
      );
    }
  };
  const farFuture = Date.now() + 30 * 24 * HOUR;
  const oauth = (n: number) => ({
    type: "oauth",
    access: `fake-access-${n}`,
    refresh: `fake-refresh-${n}`,
    expires: farFuture,
  });
  store("openai-codex", ID.codexPersonal, oauth(1));
  store("openai-codex", ID.codexWork, oauth(2));
  store("openai-codex", ID.codexOld, oauth(3));
  store("xai", ID.copilotPersonal);
  store("xai", ID.grok, oauth(5));
  // Vault bookkeeping dirs still exist; the login itself lives in HOME/.claude.
  seedAccountStore(userDataDir, "anthropic-claude", ID.claudeMax, { recursive: true, mode: 0o700 });
  seedAccountStore(userDataDir, "anthropic-claude", ID.claudeWork, {
    recursive: true,
    mode: 0o700,
  });
  store("xai", ID.grokTeam, oauth(6));
  store("openrouter", ID.kimi, { type: "api_key", key: "or-limited-key" });
  store("openrouter", ID.openrouter);
  const day = (n: number) => Date.parse("2026-08-01T00:00:00Z") + n * 24 * HOUR;
  const account = (
    id: string,
    providerId: string,
    label: string,
    n: number,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    providerId,
    kind: providerId === "openrouter" ? "api_key" : "subscription_oauth",
    label,
    enabled: true,
    createdAt: day(n),
    ...extra,
  });
  seedAccountRegistry(
    userDataDir,
    [
      account(ID.codexPersonal, "openai-codex", "Personal", 0),
      account(ID.codexWork, "openai-codex", "Work #2", 1),
      account(ID.codexOld, "openai-codex", "Old team", 2, { enabled: false }),
      account(ID.copilotPersonal, "xai", "Rejected", 4),
      account(ID.grok, "xai", "Personal", 5),
      account(ID.claudeMax, "anthropic-claude", "Personal Max", 6),
      account(ID.claudeWork, "anthropic-claude", "Work", 7),
      account(ID.grokTeam, "xai", "Team", 8),
      account(ID.kimi, "openrouter", "Limited", 9),
      account(ID.openrouter, "openrouter", "Personal", 10),
    ],
    { "openai-codex": ID.codexPersonal },
    { mode: 0o600 },
  );
}

function row(page: Page, accountId: string): Locator {
  return page.locator(`[data-account-row="${accountId}"]`);
}

function anyOf(words: readonly string[]): RegExp {
  return new RegExp(words.map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"));
}

let launched: LaunchedApp;

test.beforeAll(async () => {
  const fixtureDir = seedQuotaFixture(
    scratchDir("infinitary-quota-fixture-"),
    buildQuotaFixture(Date.now()),
  );
  const userDataDir = scratchDir("infinitary-e2e-");
  seedAccounts(userDataDir);
  launched = await launchSignedInClaude(ID.claudeMax, {
    withMockProvider: true,
    userDataDir,
    env: {
      INFINITARY_QUOTA_FIXTURE_DIR: fixtureDir,
      INFINITARY_CLAUDE_CLI: writeMockClaudeClient(scratchDir("infinitary-claude-stub-")),
    },
  });
  await launched.page.evaluate(
    (accountId) => window.infinitary.settings.setFirstmateAccount(accountId),
    ID.codexPersonal,
  );
  await launched.page.getByRole("button", { name: "Settings", exact: true }).click();
  await launched.page.getByRole("tab", { name: "Intelligence" }).click();
  await expect(row(launched.page, ID.openrouter)).toBeVisible({ timeout: 20_000 });
});

test.afterAll(async () => {
  await launched.close();
});

test("each row shows the allowance it has, and offers Sign in only where that is the way back", async () => {
  const { page } = launched;
  const meters = (accountId: string) => row(page, accountId).getByTestId("quota-micro-meter");
  const signIn = (accountId: string) =>
    row(page, accountId).getByRole("button", { name: "Sign in" });

  // A reading shows every window it carries, the person's own numbers -
  // a paused account's included.
  const read: [string, string[]][] = [
    [ID.codexPersonal, ["74", "9"]],
    [ID.codexWork, ["100", "38"]],
    [ID.codexOld, ["100", "91"]],
    [ID.claudeMax, ["68", "41", "55"]],
    [ID.grokTeam, ["40"]],
  ];
  for (const [accountId, percents] of read) {
    await expect(meters(accountId)).toHaveCount(percents.length, { timeout: 15_000 });
    for (const percent of percents) {
      await expect(meters(accountId).filter({ hasText: percent })).toBeVisible();
    }
    await expect(signIn(accountId)).toHaveCount(0);
  }
  await expect(row(page, ID.codexOld)).toHaveAttribute("data-paused", "true");

  // A last-known-good reading keeps its numbers, every one marked stale.
  await expect(meters(ID.claudeWork)).toHaveCount(3);
  await expect(meters(ID.claudeWork).and(page.locator("[data-stale='true']"))).toHaveCount(3);

  // Nothing read - not measured, rate limited - is never a meter, and the
  // credential is fine, so no sign-in is offered.
  for (const accountId of [ID.grok, ID.kimi]) {
    await expect(meters(accountId)).toHaveCount(0);
    await expect(signIn(accountId)).toHaveCount(0);
  }
  // A sign-in the vendor rejected after renewal, and a key never signed
  // in: the one inline way back.
  for (const accountId of [ID.copilotPersonal, ID.openrouter]) {
    await expect(meters(accountId)).toHaveCount(0);
    await expect(signIn(accountId)).toBeVisible();
  }
  await test.info().attach("allowance-rows.json", {
    body: JSON.stringify(
      await Promise.all(
        ACCOUNTS.map(async (accountId) => ({
          accountId,
          meters: await meters(accountId).allTextContents(),
          staleMeters: await meters(accountId).and(page.locator("[data-stale='true']")).count(),
          signIn: await signIn(accountId).count(),
        })),
      ),
      null,
      2,
    ),
    contentType: "application/json",
  });
});

// The captain's ask: several logins of one provider are one pool, whose
// meter heads that provider's accounts (docs/quota.md, "A pool of your own
// logins"). The dataset has two Codex logins in use beside a paused one, a
// Claude login read beside one whose reading is stale, and three Grok logins.
test("a provider with two or more logins in use shows their pooled allowance above them", async () => {
  const { page } = launched;
  const pool = (provider: string) => page.locator(`[data-pool-row="${provider}"]`);
  const meters = (provider: string) => pool(provider).getByTestId("quota-micro-meter");

  // Codex: (74 + 100) / 2 and (9 + 38) / 2. The paused login is not pooled.
  await expect(meters("codex")).toHaveCount(2, { timeout: 15_000 });
  await expect(meters("codex").nth(0)).toContainText("87%");
  await expect(meters("codex").nth(1)).toContainText("24%");
  await expect(pool("codex")).toContainText(m.settingsSubscriptionsOwnPoolAccounts({ count: 2 }));

  // Claude: the stale login is named and never counted as empty, so the
  // pool reads what the one read login has.
  await expect(meters("claude")).toHaveCount(3);
  for (const [index, percent] of ["68%", "41%", "55%"].entries()) {
    await expect(meters("claude").nth(index)).toContainText(percent);
  }
  await expect(pool("claude")).toContainText(m.settingsSubscriptionsOwnPoolAccounts({ count: 2 }));
  await expect(pool("claude")).toContainText(m.settingsSubscriptionsPoolUnread({ count: 1 }));

  // Only Claude and ChatGPT logins pool: Grok's three keep their own rows alone.
  await expect(page.locator("[data-pool-row]")).toHaveCount(2);
  // The pooled row heads its provider's accounts.
  const rows = page.locator("[data-subscriptions-list] :is([data-pool-row], [data-account-row])");
  const order = await rows.evaluateAll((all) =>
    all.map(
      (each) => each.getAttribute("data-pool-row") ?? each.getAttribute("data-account-row") ?? "",
    ),
  );
  expect(order.indexOf("codex")).toBe(order.indexOf(ID.codexPersonal) - 1);
  expect(order.indexOf("claude")).toBe(order.indexOf(ID.claudeMax) - 1);
});

test("the kebab holds the row's actions; rename rides the row", async () => {
  const { page } = launched;
  const work = row(page, ID.codexWork);
  await work.getByRole("button", { name: "Work #2 actions" }).click();
  const menu = page.getByRole("menu", { name: "Work #2 actions" });
  await expect(menu).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("dark-subscriptions-instruments-menu.png"),
  });
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  await work.getByRole("button", { name: "Work #2 actions" }).click();
  await menu.getByRole("menuitem", { name: "Rename" }).click();
  const input = work.getByPlaceholder("Account name");
  await expect(input).toBeVisible();
  await input.fill("Muse box");
  await work.getByRole("button", { name: "Save" }).click();
  await expect(row(page, ID.codexWork).getByText("Muse box")).toBeVisible({ timeout: 10_000 });
  // The kebab is named after the row, so it follows the rename.
  await row(page, ID.codexWork).getByRole("button", { name: "Muse box actions" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await work.getByPlaceholder("Account name").fill("Work #2");
  await work.getByRole("button", { name: "Save" }).click();
  await expect(row(page, ID.codexWork).getByText("Work #2")).toBeVisible({ timeout: 10_000 });

  // Pause and resume through the menu's Paused switch, which keeps the menu
  // open; the row dims and says so.
  await work.getByRole("button", { name: "Work #2 actions" }).click();
  const paused = page.getByRole("menuitemcheckbox", { name: m.settingsMenuPaused() });
  await expect(paused).toHaveAttribute("aria-checked", "false");
  await paused.click();
  await expect(row(page, ID.codexWork)).toHaveAttribute("data-paused", "true", { timeout: 10_000 });
  await expect(paused).toHaveAttribute("aria-checked", "true");
  await paused.click();
  await expect(row(page, ID.codexWork)).not.toHaveAttribute("data-paused", "true", {
    timeout: 10_000,
  });
  await expect(paused).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
});

test("Models starts expanded and a row's menu reopens it after collapse", async () => {
  const { page } = launched;
  const region = modelsSection(page);
  const head = region.getByRole("button", { name: /^Models/ });
  await expect(head).toHaveAttribute("aria-expanded", "true");
  await expect(region.locator("[data-slot-group]").first()).toBeVisible();
  await head.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("settings-models-default-expanded.png") });
  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "false");
  await expect(region.locator("[data-slot-group]")).toHaveCount(0);
  await expect(head).toHaveText(
    anyOf([...SLOTS, MODELS_WORDS.notInUse, MODELS_WORDS.startingLevelsSummary]),
  );

  await row(page, ID.codexPersonal)
    .getByRole("button", { name: "Personal actions" })
    .first()
    .click();
  await page.getByRole("menuitem", { name: "Model slots", exact: true }).click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
  await expect(region.locator("[data-slot-group]").first()).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("dark-subscriptions-instruments-models.png"),
  });
  await head.click();
});

test("the inline Sign in signs an existing account into its own store", async () => {
  const { page } = launched;
  const openrouter = row(page, ID.openrouter);
  await openrouter.getByRole("button", { name: "Sign in" }).click();
  // The provider's own flow asks for the key; the prompt lands under the row
  // that started it, and the answer never crosses the renderer as anything
  // but this one reply.
  const prompt = page.locator(`[data-account-row="${ID.openrouter}"] + div`).getByRole("textbox");
  await expect(prompt).toBeVisible({ timeout: 15_000 });
  await prompt.fill("or-fake-key");
  await page.getByRole("button", { name: "Submit" }).click();
  // Same row, same label, now signed in: with no quota provider for it,
  // the row says what Infinitary does rather than inventing a meter.
  await expect(row(page, ID.openrouter).getByText(noReaderText("api_key"))).toBeVisible({
    timeout: 20_000,
  });
  await expect(row(page, ID.openrouter).locator("[data-account-name]")).toHaveText(
    "OpenRouter · Personal",
  );
  await expect(row(page, ID.openrouter).getByRole("button", { name: "Sign in" })).toHaveCount(0);
  await expect(page.locator("[data-account-row]")).toHaveCount(ACCOUNTS.length);
});

test("the captain picks the account Firstmate answers on, apart from crew work's preferred one", async () => {
  const { page } = launched;
  // Firstmate answers with a Codex model on Personal, the account crew work
  // also prefers (the seeded pin).
  const modelBefore = await page.evaluate(() => window.infinitary.settings.getFirstmateModel());
  const codex = (await page.evaluate(() => window.infinitary.models.available())).find(
    (model) => model.provider === "openai-codex",
  );
  if (!codex) throw new Error("No Codex model is listed");
  await page.evaluate((model) => window.infinitary.settings.setFirstmateModel(model), codex);
  await page.evaluate(
    (accountId) => window.infinitary.settings.setFirstmateAccount(accountId),
    ID.codexPersonal,
  );
  const picker = page
    .locator('[data-setting="firstmate-model"]')
    .getByRole("combobox", { name: "First mate account" });
  await expect(picker).toHaveValue(ID.codexPersonal, { timeout: 15_000 });
  // A paused account is listed and cannot be picked.
  await expect(picker.locator(`option[value="${ID.codexOld}"]`)).toBeDisabled();

  // By keys: Tab from Firstmate model reaches the picker, which shows where
  // focus is, and typing an account's first letter picks it.
  await pressKey(page.getByRole("combobox", { name: "First mate model" }), "Tab");
  await expect(picker).toBeFocused();
  expect(await picker.evaluate((select) => select.matches(":focus-visible"))).toBe(true);
  await page.keyboard.press("w");
  await expect
    .poll(() => page.evaluate(() => window.infinitary.settings.getFirstmateAccount()))
    .toBe(ID.codexWork);
  // Crew work keeps its own preferred account.
  const preferred = async () =>
    (await page.evaluate(() => window.infinitary.accounts.list()))
      .filter((account) => account.pinned)
      .map((account) => account.id);
  expect(await preferred()).toEqual([ID.codexPersonal]);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Intelligence" }).click();
  await expect(picker).toHaveValue(ID.codexWork, { timeout: 15_000 });

  // With Personal paused only Work can answer, so there is no choice to
  // offer; resumed, the choice is back.
  const personal = row(page, ID.codexPersonal);
  await personal.getByRole("button", { name: "Personal actions" }).click();
  await page.locator('[data-menu-item="pause"]').click();
  await expect(personal).toHaveAttribute("data-paused", "true", { timeout: 10_000 });
  await expect(picker).toHaveCount(0);
  // Paused is a switch, so the menu stays open for the second press.
  await page.locator('[data-menu-item="pause"]').click();
  await expect(personal).not.toHaveAttribute("data-paused", "true", { timeout: 10_000 });
  await page.keyboard.press("Escape");
  await expect(picker).toHaveValue(ID.codexWork);

  await page.evaluate((model) => window.infinitary.settings.setFirstmateModel(model), modelBefore);
  await page.evaluate(
    (accountId) => window.infinitary.settings.setFirstmateAccount(accountId),
    ID.codexPersonal,
  );
});

test("a Claude account can carry the firstmate tag", async () => {
  const { page } = launched;
  // Claude seats the Firstmate too since W1: pinned, its row says so, and
  // exactly one row does.
  await page.evaluate(
    (accountId) => window.infinitary.settings.setFirstmateAccount(accountId),
    ID.claudeMax,
  );
  await page.evaluate(() => window.infinitary.quota.refresh());
  await expect(
    row(page, ID.claudeMax).getByText(SUBSCRIPTIONS_WORDS.firstmateAccountTag, { exact: true }),
  ).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    row(page, ID.codexPersonal).getByText(SUBSCRIPTIONS_WORDS.firstmateAccountTag, { exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .locator("[data-account-row]")
      .getByText(SUBSCRIPTIONS_WORDS.firstmateAccountTag, { exact: true }),
  ).toHaveCount(1);
  await page.evaluate(
    (accountId) => window.infinitary.settings.setFirstmateAccount(accountId),
    ID.codexPersonal,
  );
});

test("Subscriptions renders model-only and incomplete allowance scope projections", async () => {
  const now = Date.now();
  const fixture = buildQuotaFixture(now);
  const model = {
    id: "model:opus",
    label: "Opus",
    percentRemaining: 90,
    resetsAtMs: now + HOUR / 2,
    windowSeconds: 3600,
  };
  const setWindows = (id: string, windows: QuotaSnapshotView["providers"][number]["windows"]) => {
    const provider = fixture.providers.find((entry) => entry.accountId === id);
    if (!provider) throw new Error(`Missing fixture allowance for ${id}`);
    provider.windows = windows;
  };
  setWindows(ID.codexPersonal, [model]);
  setWindows(ID.codexWork, [
    { id: "session", label: "session" },
    { ...model, id: "weekly", label: "weekly" },
  ]);
  // This scope really does run out before reset, so its warning must survive.
  setWindows(ID.claudeMax, [{ ...model, percentRemaining: 10 }]);
  const fixtureDir = seedQuotaFixture(scratchDir("infinitary-forecast-fixture-"), fixture);
  const userDataDir = scratchDir("infinitary-forecast-");
  seedAccounts(userDataDir);
  const app = await launchSignedInClaude(ID.claudeMax, {
    withMockProvider: true,
    userDataDir,
    env: {
      INFINITARY_QUOTA_FIXTURE_DIR: fixtureDir,
      INFINITARY_CLAUDE_CLI: writeMockClaudeClient(scratchDir("infinitary-claude-stub-")),
    },
  });
  try {
    const { page } = app;
    // Wait for the shell to attach its keys before sending a window command.
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    await pressWindowKey(app.app, ",", ["meta"]);
    const tab = page.getByRole("tab", { name: "Intelligence" });
    await pressKey(tab, "Enter");
    await expect(row(page, ID.codexPersonal).getByTestId("quota-micro-meter")).toHaveCount(1);
    await expect(row(page, ID.codexWork).getByTestId("quota-micro-meter")).toHaveCount(2);
    const snapshot = await page.evaluate(() => window.infinitary.quota.snapshot());
    if (!snapshot) throw new Error("No allowance snapshot");
    for (const [id, status, tone] of [
      [ID.codexPersonal, "through_reset", "ok"],
      [ID.codexWork, "unknown", undefined],
      [ID.claudeMax, "projected_exhaustion", "danger"],
    ] as const) {
      const provider = snapshot.providers.find((entry) => entry.accountId === id);
      if (!provider) throw new Error(`Missing allowance for ${id}`);
      const scopes = providerScopes(provider, Date.now());
      expect((scopes.allModels ?? scopes.scopes[0])?.runway.status).toBe(status);
      const verdict = row(page, id).locator("[data-tone]:not([role='img'])");
      if (tone) await expect(verdict).toHaveAttribute("data-tone", tone);
      else await expect(verdict).toHaveCount(0);
    }
  } finally {
    await app.close();
  }
});
