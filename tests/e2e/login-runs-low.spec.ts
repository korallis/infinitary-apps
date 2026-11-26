import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { loginLowCardId } from "../../src/core/orchestrator/loginCards";
import * as m from "../../src/shared/i18n/messages.generated";
import { scratchDir } from "../helpers/scratchDirs";
import {
  CLAUDE_SEAT_ACCOUNT,
  CODEX_SEAT_ACCOUNT,
  CODEX_SECOND_ACCOUNT,
  CODEX_SECOND_LABEL,
  launchClaudeSeat,
} from "./claudeSeat";
import { cardBody } from "./frames";
import type { LaunchedApp } from "./launch";
import { type MockProviderServer, startMockProvider } from "./mockProvider";
import { heroShot, regionShot } from "./pictures";
import { seedQuotaFixture } from "./quotaFixtures";
import { dockRegion, expectRailsDrawn, feedLine } from "./rails";
import { shownCard, stageAtRest } from "./stack";
import { pressKey } from "./windowKeys";

/**
 * When the login in use runs low (the approved plan for several logins of
 * one provider, piece 3; docs/quota.md "When the login in use runs low"):
 * two Codex logins, the one in use at 5% while the other has room. Every
 * install asks: one card names the low login, its refill and the login with
 * the most room, and nothing moves until its button is pressed. Enter on
 * Move makes the other login the one in use, takes the card down and writes
 * one feed line.
 */

const LOW_LABEL = "Work";
const LOW_PERCENT = 5;

function readings(now: number): string {
  const HOUR = 3600 * 1000;
  const row = (provider: string, label: string, accountId: string, percent: number) => ({
    provider,
    label,
    accountId,
    accountLabel: "sailor@example.com",
    status: "ok" as const,
    stale: false,
    windows: [
      {
        id: "five_hour",
        label: "session",
        percentRemaining: percent,
        pace: "behind" as const,
        resetText: "resets 6pm",
        resetsAtMs: now + 2 * HOUR,
        windowSeconds: 18_000,
      },
    ],
  });
  return seedQuotaFixture(scratchDir("infinitary-login-low-quota-"), {
    generatedAt: new Date(now).toISOString(),
    fetchedAt: now,
    providers: [
      row("claude", "Claude", CLAUDE_SEAT_ACCOUNT, 80),
      row("codex", "Codex", CODEX_SEAT_ACCOUNT, LOW_PERCENT),
      row("codex", "Codex", CODEX_SECOND_ACCOUNT, 70),
    ],
  });
}

/** The Codex login in use, as Subscriptions reads it. */
async function loginInUse(page: Page): Promise<string | undefined> {
  const accounts = await page.evaluate(() => window.infinitary.accounts.list());
  return accounts.find((account) => account.providerId === "openai-codex" && account.pinned)?.id;
}

async function cardUp(page: Page): Promise<boolean> {
  const id = loginLowCardId("openai-codex");
  const cards = await page.evaluate(() => window.infinitary.cards.list());
  return cards.some((card) => card.id === id);
}

test("a low login in use asks once on a card, and Enter on Move makes the other login the one in use", async () => {
  test.setTimeout(3 * 60_000);
  let mock: MockProviderServer | undefined;
  let launched: LaunchedApp | undefined;
  try {
    mock = await startMockProvider();
    launched = await launchClaudeSeat({
      mockProvider: mock,
      withCodex: true,
      secondCodex: true,
      env: { INFINITARY_QUOTA_FIXTURE_DIR: readings(Date.now()) },
    });
    const { page } = launched;

    const title = m.cardLoginLowTitle({ login: LOW_LABEL });
    await expect(shownCard(page, title)).toBeVisible({ timeout: 45_000 });
    const body = cardBody(page, title);
    await expect(
      body.getByText(m.cardLoginLowLeft({ percent: String(LOW_PERCENT) })),
    ).toBeVisible();
    await expect(body.getByText(/Its allowance refills \S+\./)).toBeVisible();
    await expect(
      body.getByText(new RegExp(`${CODEX_SECOND_LABEL} has the most room`)),
    ).toBeVisible();
    await expect(
      shownCard(page, title).getByRole("button", { name: m.cardLoginLowWait(), exact: true }),
    ).toBeVisible();
    const evidence =
      test.info().repeatEachIndex === 0 ? process.env.INFINITARY_TASK_EVIDENCE_DIR : undefined;
    if (evidence) {
      await stageAtRest(page);
      await regionShot(shownCard(page, title), join(evidence, "login-low-ask-card.png"));
      await heroShot(launched.app, page, {
        region: shownCard(page, title),
        name: "ask-when-a-login-runs-low",
      });
    }
    // Nothing moved before the click.
    expect(await loginInUse(page)).toBe(CODEX_SEAT_ACCOUNT);

    await pressKey(
      shownCard(page, title).getByRole("button", {
        name: m.cardLoginLowMove({ login: CODEX_SECOND_LABEL }),
        exact: true,
      }),
      "Enter",
    );
    await expect.poll(() => loginInUse(page)).toBe(CODEX_SECOND_ACCOUNT);
    await expect.poll(() => cardUp(page)).toBe(false);
    await expect(
      feedLine(page, `Codex work moved from ${LOW_LABEL} to ${CODEX_SECOND_LABEL}.`),
    ).toBeVisible();
    if (evidence) {
      await expectRailsDrawn(page);
      await regionShot(dockRegion(page, "activity"), join(evidence, "login-low-moved.png"));
    }
  } finally {
    await launched?.close();
    await mock?.close();
  }
});
