import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { scratchDir } from "../helpers/scratchDirs";
import { seedAccountRegistry, seedAccountStore } from "./accountFixtures";
import { launchSignedInClaude } from "./claudeAccount";
import { writeMockClaudeClient } from "./mockClaudeClient";

/**
 * @journey-area src/core/claude/
 *
 * Several Claude logins (the approved plan for several Claude logins, piece
 * 1, item 7): with one Claude account connected, Settings offers "Add
 * another Claude login"; the new login signs in inside its own folder
 * through the client's own login, gets a row of its own, and removing it
 * signs that folder out and deletes it. The client is the e2e stand-in,
 * which keeps its sign-in marker in the folder it is started with, the
 * default login's when none is named; nobody is signed in anywhere.
 */

const FIRST = "acct_claude_first";
const CLAUDE = "anthropic-claude";

test("Settings adds another Claude login in its own folder and removes it again", async () => {
  const userDataDir = scratchDir("infinitary-e2e-");
  seedAccountStore(userDataDir, CLAUDE, FIRST);
  seedAccountRegistry(userDataDir, [
    {
      id: FIRST,
      providerId: CLAUDE,
      kind: "subscription_oauth",
      label: "Personal",
      enabled: true,
      createdAt: Date.parse("2026-08-01T00:00:00Z"),
    },
  ]);
  const app = await launchSignedInClaude(FIRST, {
    withMockProvider: true,
    userDataDir,
    env: {
      INFINITARY_CLAUDE_CLI: writeMockClaudeClient(scratchDir("infinitary-claude-stub-"), {
        email: "second@example.invalid",
      }),
    },
  });
  try {
    await app.page.getByRole("button", { name: "Settings", exact: true }).click();
    await app.page.getByRole("tab", { name: "Intelligence" }).click();
    await expect(app.page.locator(`[data-account-row="${FIRST}"]`)).toBeVisible({
      timeout: 20_000,
    });

    await app.page.getByRole("button", { name: "Add another Claude login" }).click();
    await expect(app.page.locator("[data-account-row]")).toHaveCount(2, { timeout: 20_000 });

    const accounts = await app.page.evaluate(() => window.infinitary.accounts.list());
    const further = accounts.find((account) => account.id !== FIRST);
    expect(further).toMatchObject({ providerId: CLAUDE, connected: true });
    if (!further) return;
    expect(
      accounts.find((account) => account.id === FIRST),
      "the first login stays connected",
    ).toMatchObject({ connected: true });
    const folder = join(userDataDir, "accounts", CLAUDE, further.id, "claude");
    expect(
      existsSync(join(folder, "stub-credential")),
      "the client signed in inside the new login's own folder",
    ).toBe(true);

    await app.page.evaluate((id) => window.infinitary.accounts.remove(id), further.id);
    await expect(app.page.locator("[data-account-row]")).toHaveCount(1);
    await expect(app.page.locator(`[data-account-row="${FIRST}"]`)).toBeVisible();
    expect(existsSync(folder), "removing it deletes its folder").toBe(false);
    expect(
      existsSync(join(app.homeDir, ".claude", "stub-credential")),
      "the sign-out ran in its folder, so the default login is still signed in",
    ).toBe(true);
  } finally {
    await app.close();
  }
});
