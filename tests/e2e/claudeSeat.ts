/**
 * INF-2394: fixture ownership follows the product reader.
 * @journey-area src/core/claude/
 * @journey-area src/core/pi/accountVault.ts
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import type { AccountRecord } from "../../src/core/pi/accountVault";
import { FIRSTMATE_PERSONA } from "../../src/core/pi/piResources";
import { scratchDir } from "../helpers/scratchDirs";
import { seedAccountAuth, seedAccountRegistry, seedAccountStore } from "./accountFixtures";
import { launchSignedInClaude } from "./claudeAccount";
import type { LaunchedApp, LaunchOptions } from "./launch";
import { claudeDefaultStore } from "./mockClaudeClient";
import { MOCK_KEY_PROVIDER_ID } from "./mockModels";
import type { MockProviderServer } from "./mockProvider";
import { starterFor } from "./starters";

/**
 * An app whose Firstmate runs on Claude (W1 S12): the machine's Claude
 * login seats it, on turn-mode sessions of the SDK's own client against the
 * mock provider (tests/e2e/mockClaudeClient.ts). Optionally a Codex account
 * sits beside it - the other provider a paused seat is offered - on a dummy
 * token whose turns the mock answers in Codex's own dialect.
 *
 * Hermetic twice over for the person's own Claude login. The boxed client
 * holds a dummy token and a Keychain shim. And the app itself - which reads
 * the machine's saved Claude login by service and `$USER` for a sign-in or
 * an allowance - runs as NO_CLAUDE_LOGIN_USER, a user no login was ever
 * saved under, so every such lookup finds nothing: no value is read and no
 * permission is asked for.
 */

/** The `$USER` the app runs as: the Keychain holds no Claude login under it. */
export const NO_CLAUDE_LOGIN_USER = "infinitary-e2e-no-claude-login";

export const CLAUDE_SEAT_ACCOUNT = "acct_claude_seat";
export const CODEX_SEAT_ACCOUNT = "acct_codex_seat";
/** A second login of Codex's provider, beside the seat's: the one a low login's work moves to. */
export const CODEX_SECOND_ACCOUNT = "acct_codex_second";
export const CODEX_SECOND_LABEL = "Personal";
/** The Claude account's label, the name a pause or a move says it by. */
// INF-2318: Claude names its current store identity, not a custom account label.
export const CLAUDE_SEAT_LABEL = "sailor@example.com";

/** The Claude model the captain picks for Firstmate (Claude's medium slot). */
export const CLAUDE_SEAT_MODEL = {
  provider: "anthropic-claude",
  id: starterFor("anthropic-claude", "medium"),
};

export const CODEX_SEAT_CHATGPT_ID = "acct-e2e-codex";

/**
 * A dummy Codex sign-in, shaped like one: an unsigned token whose claims
 * name a ChatGPT account, which Codex's client reads before it sends. It
 * only ever reaches the mock provider.
 */
function fakeCodexToken(): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    part({ alg: "none", typ: "JWT" }),
    part({ "https://api.openai.com/auth": { chatgpt_account_id: CODEX_SEAT_CHATGPT_ID } }),
    "e2e",
  ].join(".");
}

function seedAccounts(userDataDir: string, withCodex: boolean, secondCodex: boolean): void {
  // Vault bookkeeping only; the login lives in HOME/.claude (CD-1=B).
  seedAccountStore(userDataDir, "anthropic-claude", CLAUDE_SEAT_ACCOUNT, {
    recursive: true,
    mode: 0o700,
  });
  const accounts: AccountRecord[] = [
    {
      id: CLAUDE_SEAT_ACCOUNT,
      providerId: "anthropic-claude",
      kind: "subscription_oauth",
      label: CLAUDE_SEAT_LABEL,
      enabled: true,
      createdAt: Date.parse("2026-08-01T00:00:00Z"),
    },
  ];
  const codexLogins = withCodex
    ? [
        { id: CODEX_SEAT_ACCOUNT, label: "Work" },
        ...(secondCodex ? [{ id: CODEX_SECOND_ACCOUNT, label: CODEX_SECOND_LABEL }] : []),
      ]
    : [];
  for (const [index, login] of codexLogins.entries()) {
    seedAccountStore(userDataDir, "openai-codex", login.id, {
      recursive: true,
      mode: 0o700,
    });
    seedAccountAuth(
      userDataDir,
      "openai-codex",
      login.id,
      {
        "openai-codex": {
          type: "oauth",
          access: fakeCodexToken(),
          refresh: "fake-refresh",
          expires: Date.now() + 30 * 24 * 3600 * 1000,
        },
      },
      { mode: 0o600 },
    );
    accounts.push({
      id: login.id,
      providerId: "openai-codex",
      kind: "subscription_oauth",
      label: login.label,
      enabled: true,
      createdAt: Date.parse("2026-08-02T00:00:00Z") + index,
    });
  }
  // With two Codex logins the seat's own is the login in use.
  const pins: Record<string, string> = secondCodex ? { "openai-codex": CODEX_SEAT_ACCOUNT } : {};
  seedAccountRegistry(userDataDir, accounts, pins, { mode: 0o600 });
}

/**
 * Both allowances from a fixture: the live sensor would read the machine's
 * own login to ask Anthropic, and this run must not. Claude has room; Codex,
 * when it is there, has room too - so it is the move a paused seat offers.
 */
function writeQuotaFixture(now: number, codexPercent: number): string {
  const dir = scratchDir("infinitary-quota-fixture-");
  const HOUR = 3600 * 1000;
  const row = (provider: string, label: string, accountId: string, percent: number) => ({
    provider,
    label,
    accountId,
    accountLabel: "kun@example.com",
    status: "ok",
    stale: false,
    windows: [
      {
        id: "five_hour",
        label: "session",
        percentRemaining: percent,
        pace: "behind",
        resetText: "resets 6pm",
        resetsAtMs: now + 2 * HOUR,
        windowSeconds: 18_000,
      },
    ],
  });
  writeFileSync(
    join(dir, "snapshot.json"),
    JSON.stringify({
      generatedAt: new Date(now).toISOString(),
      fetchedAt: now,
      providers: [
        row("claude", "Claude", CLAUDE_SEAT_ACCOUNT, 80),
        row("codex", "Codex", CODEX_SEAT_ACCOUNT, codexPercent),
      ],
    }),
  );
  return dir;
}

/**
 * The app's models.json: OpenRouter and Codex pointed at the mock provider,
 * no custom provider. A Codex seat then speaks Codex's own dialect to it.
 */
function seatModelsJson(port: number): string {
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  return `${JSON.stringify({ providers: { [MOCK_KEY_PROVIDER_ID]: { baseUrl }, "openai-codex": { baseUrl } } }, null, 2)}\n`;
}

export type ClaudeSeatLaunch = Pick<
  LaunchOptions,
  "userDataDir" | "homeDir" | "prepareHome" | "env"
> & {
  mockProvider: MockProviderServer;
  withCodex?: boolean;
  /** With Codex, a second Codex login beside the seat's, which is then the login in use. */
  secondCodex?: boolean;
  /** Codex's allowance left, in percent (60 unless named). */
  codexPercent?: number;
  /** The Claude client the seat runs; the SDK's co-released one unless named. */
  client?: string;
};

/**
 * Launch the app with the Firstmate on Claude. A first launch seeds the
 * accounts and a signed-in Claude store, and the captain picks the Claude
 * model for Firstmate the way the Intelligence tab does; a relaunch
 * (`userDataDir` given) keeps them, and `homeDir` keeps the Claude store
 * and the seat's transcripts.
 */
export async function launchClaudeSeat(options: ClaudeSeatLaunch): Promise<LaunchedApp> {
  const relaunch = options.userDataDir !== undefined;
  const userDataDir = options.userDataDir ?? scratchDir("infinitary-e2e-");
  if (!relaunch) {
    seedAccounts(userDataDir, options.withCodex === true, options.secondCodex === true);
  }
  const launched = await launchSignedInClaude(
    CLAUDE_SEAT_ACCOUNT,
    {
      reuseMockProvider: options.mockProvider,
      modelsJson: seatModelsJson,
      // A dummy subscription token: the client then reads the plan-window
      // headers a reply carries, the way a person's login does. No retries,
      // so a refusal is the turn's answer at once.
      claudeTurns: {
        credential: "subscription",
        maxRetries: 0,
        ...(options.client ? { client: options.client } : {}),
      },
      userDataDir,
      ...(options.homeDir ? { homeDir: options.homeDir } : {}),
      // Signed in, as the client and the store both say: the store keeps its
      // credential in the plain file, since the Keychain holds nothing for
      // this run's user.
      prepareHome: (homeDir) => {
        if (!relaunch) {
          writeFileSync(
            join(homeDir, ".claude.json"),
            JSON.stringify({
              oauthAccount: { emailAddress: CLAUDE_SEAT_LABEL, accountUuid: CLAUDE_SEAT_ACCOUNT },
            }),
          );
        }
        options.prepareHome?.(homeDir);
      },
      env: {
        USER: NO_CLAUDE_LOGIN_USER,
        INFINITARY_QUOTA_FIXTURE_DIR: writeQuotaFixture(Date.now(), options.codexPercent ?? 60),
        ...options.env,
      },
    },
    relaunch,
  );
  if (relaunch) return launched;
  // The captain's pick: nothing moves to Claude on its own.
  await launched.page.evaluate(
    (model) => window.infinitary.settings.setFirstmateModel(model),
    CLAUDE_SEAT_MODEL,
  );
  return launched;
}

/** Every Firstmate request the Claude client made, oldest first. */
export function claudeSeatRequests(mockProvider: MockProviderServer): string[] {
  const headers = mockProvider.requestHeaders();
  return mockProvider
    .requestBodies()
    .filter(
      (body, index) =>
        body.includes(FIRSTMATE_PERSONA) &&
        headers[index]?.["user-agent"]?.startsWith("claude-cli/") === true,
    );
}

/** Every Firstmate request any other client made (a Pi seat's). */
export function otherSeatRequests(mockProvider: MockProviderServer): string[] {
  const headers = mockProvider.requestHeaders();
  return mockProvider
    .requestBodies()
    .filter(
      (body, index) =>
        body.includes(FIRSTMATE_PERSONA) &&
        headers[index]?.["user-agent"]?.startsWith("claude-cli/") !== true,
    );
}

/**
 * Whether the Claude client has queued `text` into its session: the
 * client's own transcript under the run's HOME records an enqueue for a
 * message pushed while a turn runs, before the turn takes it in.
 */
export function claudeQueued(homeDir: string, text: string): boolean {
  const projects = join(claudeDefaultStore(homeDir), "projects");
  let dirs: string[];
  try {
    dirs = readdirSync(projects);
  } catch {
    return false;
  }
  return dirs.some((dir) => {
    let files: string[];
    try {
      files = readdirSync(join(projects, dir)).filter((file) => file.endsWith(".jsonl"));
    } catch {
      return false;
    }
    return files.some((file) =>
      readFileSync(join(projects, dir, file), "utf8")
        .split("\n")
        .some((line) => {
          let entry: { type?: unknown; operation?: unknown; content?: unknown };
          try {
            entry = JSON.parse(line);
          } catch {
            return false;
          }
          return (
            entry.type === "queue-operation" &&
            entry.operation === "enqueue" &&
            String(entry.content).includes(text)
          );
        }),
    );
  });
}

export async function taskPrompt(page: Page) {
  const input = page.getByRole("textbox", { name: "Task prompt" });
  await expect(input).toBeEnabled({ timeout: 30_000 });
  return input;
}

export async function say(page: Page, text: string): Promise<void> {
  const input = await taskPrompt(page);
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}
