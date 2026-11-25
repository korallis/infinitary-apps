import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { ClaudeAuthBackend } from "../claude/claudeAuth";
import type { RunClaude } from "../claude/claudeCli";
import { claudeAvailableModels } from "../claude/claudeModels";
import { readClaudeStore } from "../claude/claudeQuota";
import { acquireSessionLease, resetStoreLeasesForTest } from "../claude/claudeStoreLease";
import { absentKeychain } from "../host";
import { Flagship } from "../orchestrator/flagship";
import { appPathsFor } from "../paths";
import { AccountVault } from "../pi/accountVault";
import type { AuthInteractionBridge } from "../pi/piAuth";
import { startHomeQuota } from "../quota/homeQuota";
import { SettingsStore } from "../storage/settingsStore";
import { claudeLoginFolder } from "./accountBackend";

/**
 * Further Claude logins (the approved plan for several Claude logins, piece
 * 1): a Claude account added beside the one on the computer's default login
 * signs in inside its own Claude Code folder through the client's own login,
 * its usage comes only from what its sessions push, and removing it signs
 * that folder out and deletes it.
 *
 * Real parts: the account vault, the Claude account backend, the store
 * lease, the home's allowance readings and the first mate seat's rules.
 * Stand-ins: the Claude client (it keeps a sign-in per folder, the way the
 * real one does under CLAUDE_CONFIG_DIR), the default login's store files in
 * a scratch home, and Anthropic's usage address.
 */

const vendor = vi.hoisted(() => ({
  http: undefined as unknown as (url: string, init: unknown) => Promise<unknown>,
}));
vi.mock("../quota/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../quota/http")>();
  return {
    ...actual,
    createQuotaHttp: () => (url: string, init: unknown) => vendor.http(url, init),
  };
});

const START = Date.parse("2026-11-20T09:00:00Z");
const HOUR = 60 * 60_000;
const FIRST_EMAIL = "first@example.invalid";
const SECOND_EMAIL = "second@example.invalid";
const FIRST_TOKEN = "stand-in-token-first";
const USAGE_FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "../../../tests/fixtures/quota-credits/claude-usage.json"), "utf8"),
);

/** The computer's default Claude login, as the client last wrote it. */
function writeDefaultLogin(home: string): void {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      oauthAccount: {
        accountUuid: "uuid-first",
        organizationUuid: "org-first",
        emailAddress: FIRST_EMAIL,
      },
    }),
  );
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: FIRST_TOKEN,
        refreshToken: "stand-in-refresh-first",
        expiresAt: START + 30 * 24 * HOUR,
        subscriptionType: "max",
      },
    }),
  );
  const written = START / 1000;
  utimesSync(join(home, ".claude.json"), written, written);
  utimesSync(join(home, ".claude", ".credentials.json"), written, written);
}

type ClientCall = { command: string; configDir?: string };

/**
 * A Claude client that keeps one sign-in per config folder. A command with
 * no folder named is the default login's, which these cases never ask it
 * about: the default login is read from its store.
 */
function standInClient() {
  const calls: ClientCall[] = [];
  const signedIn = new Map<string, string>();
  const behavior = { loginFinishes: true, logoutThrows: false };
  const run: RunClaude = async (args, _dir, options) => {
    const configDir = options?.env?.CLAUDE_CONFIG_DIR;
    const command = args.slice(0, 2).join(" ");
    calls.push({ command, ...(configDir ? { configDir } : {}) });
    if (!configDir) return { code: 0, stdout: "{}", stderr: "" };
    if (command === "auth login") {
      if (!behavior.loginFinishes) return { code: 1, stdout: "", stderr: "" };
      signedIn.set(configDir, SECOND_EMAIL);
      return { code: 0, stdout: "Login successful.\n", stderr: "" };
    }
    if (command === "auth logout") {
      if (behavior.logoutThrows) throw new Error("the client is gone");
      signedIn.delete(configDir);
      return { code: 0, stdout: "", stderr: "" };
    }
    const email = signedIn.get(configDir);
    return {
      code: email ? 0 : 1,
      stdout: JSON.stringify(
        email
          ? { loggedIn: true, authMethod: "claude.ai", email, subscriptionType: "pro" }
          : { loggedIn: false, authMethod: "none" },
      ),
      stderr: "",
    };
  };
  return { run, calls, signedIn, behavior };
}

const bridge: AuthInteractionBridge = {
  prompt: () => new Promise<string>(() => {}),
  notify: () => {},
  openExternal: async () => {},
};

function boot(home: string) {
  const root = scratchDir("claude-further-logins-app-");
  const paths = appPathsFor(root);
  const db = freshDatabase();
  const client = standInClient();
  const storesRead: string[] = [];
  const usageAsks: string[] = [];
  vendor.http = async (_url, init) => {
    const headers = (init as { headers?: Record<string, string> }).headers ?? {};
    usageAsks.push(headers.Authorization ?? headers.authorization ?? "");
    return { status: 200, json: structuredClone(USAGE_FIXTURE) };
  };
  const claude = new ClaudeAuthBackend({
    furtherLogins: true,
    run: client.run,
    available: () => true,
    configDir: () => join(home, ".claude"),
    readStore: (dir, options) => {
      storesRead.push(dir);
      return readClaudeStore(dir, { ...options, keychain: absentKeychain });
    },
  });
  const vault = AccountVault.create(paths, {
    backends: [claude],
    modelsForAccount: ({ providerId }) =>
      providerId === CLAUDE_PROVIDER_ID ? claudeAvailableModels() : [],
  });
  const homeQuota = startHomeQuota({
    host: { keychain: absentKeychain },
    standIns: {},
    db,
    vault,
    served: { read: () => undefined } as never,
    auth: { catalogModels: () => [] } as never,
    broadcast: () => {},
  });
  const flagship = new Flagship({
    vault,
    settings: new SettingsStore(db),
    quota: homeQuota.quota,
    baseRuntime: { kind: "base" } as never,
    decisions: { recordAccount: () => 1 },
  });
  const add = () => vault.add(CLAUDE_PROVIDER_ID, "oauth", bridge);
  const folderOf = (accountId: string) =>
    claudeLoginFolder(join(paths.accountsDir, CLAUDE_PROVIDER_ID, accountId));
  return { paths, client, storesRead, usageAsks, vault, homeQuota, flagship, add, folderOf };
}

describe("further Claude logins", () => {
  let home: string;
  let savedHome: string | undefined;
  let savedConfigDir: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START);
    home = scratchDir("claude-further-logins-home-");
    savedHome = process.env.HOME;
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = home;
    delete process.env.CLAUDE_CONFIG_DIR;
    writeDefaultLogin(home);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetStoreLeasesForTest();
    process.env.HOME = savedHome;
    if (savedConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  });

  // Plan items 1, 2 and 3: the binding, the client's own login in the
  // folder, and sign-in state from the client's word alone.
  it("signs a second Claude login in inside its own folder and leaves the first on the default login", async () => {
    const run = boot(home);
    const first = await run.add();
    expect(run.vault.binding(first.id)).toEqual({ via: "default-login" });
    expect(existsSync(run.folderOf(first.id)), "the first login gets no folder").toBe(false);
    expect(
      run.client.calls.filter((call) => call.command === "auth login"),
      "a login already on the computer is used, with no sign-in",
    ).toEqual([]);

    const second = await run.add();
    const folder = run.folderOf(second.id);
    expect(run.vault.binding(second.id)).toEqual({ via: "config-dir", configDir: folder });
    expect(run.vault.binding(first.id)).toEqual({ via: "default-login" });
    expect(run.client.calls.filter((call) => call.command === "auth login")).toEqual([
      { command: "auth login", configDir: folder },
    ]);
    expect(second.label, "named from the client's own word").toBe(SECOND_EMAIL);
    expect(run.vault.list().map((account) => account.id)).toEqual([first.id, second.id]);
    expect((await run.vault.status(first.id)).connected).toBe(true);
    expect((await run.vault.status(second.id)).connected).toBe(true);
    expect(run.storesRead, "Infinitary never opens the folder's sign-in").not.toContain(folder);
  });

  it("leaves no account and no folder behind when the second sign-in does not finish", async () => {
    const run = boot(home);
    const first = await run.add();
    run.client.behavior.loginFinishes = false;
    await expect(run.add()).rejects.toThrow("Claude failed to sign in. Try again.");
    expect(run.vault.list().map((account) => account.id)).toEqual([first.id]);
    expect(
      run.client.calls.some((call) => call.configDir && existsSync(call.configDir)),
      "the folder the sign-in ran in is gone",
    ).toBe(false);
  });

  it("refuses a second Claude account where further logins are not turned on", async () => {
    const paths = appPathsFor(scratchDir("claude-further-logins-off-"));
    const client = standInClient();
    const vault = AccountVault.create(paths, {
      backends: [
        new ClaudeAuthBackend({
          run: client.run,
          available: () => true,
          configDir: () => join(home, ".claude"),
          readStore: (dir, options) =>
            readClaudeStore(dir, { ...options, keychain: absentKeychain }),
        }),
      ],
    });
    await vault.add(CLAUDE_PROVIDER_ID, "oauth", bridge);
    await expect(vault.add(CLAUDE_PROVIDER_ID, "oauth", bridge)).rejects.toThrow(
      /Claude uses the login already on/,
    );
    expect(vault.list()).toHaveLength(1);
  });

  // Plan item 3: the client's own status says whether a folder is signed in,
  // asked only while no session holds the folder.
  it("reads a further login's sign-in from the client's word, and does not ask while a session holds its folder", async () => {
    const run = boot(home);
    await run.add();
    const second = await run.add();
    const folder = run.folderOf(second.id);
    const statusAsks = () =>
      run.client.calls.filter((call) => call.command === "auth status" && call.configDir === folder)
        .length;

    // The client signs the folder out behind the app's back while a session
    // holds it: the last word stands and nothing is asked.
    const release = await acquireSessionLease(folder);
    run.client.signedIn.delete(folder);
    vi.setSystemTime(START + HOUR);
    const asksBefore = statusAsks();
    expect((await run.vault.status(second.id, { refresh: true })).connected).toBe(true);
    expect(statusAsks()).toBe(asksBefore);

    release();
    expect((await run.vault.status(second.id, { refresh: true })).connected).toBe(false);
    expect(statusAsks()).toBe(asksBefore + 1);
    expect(run.storesRead).not.toContain(folder);
  });

  // Plan item 4: usage only from pushed readings, kept until the reset.
  it("shows a further login's allowance only from pushed readings: refused until its reset, then refilled", async () => {
    const run = boot(home);
    const first = await run.add();
    const second = await run.add();
    const rowOf = (accountId: string) =>
      run.homeQuota.quota.latest()?.providers.find((row) => row.accountId === accountId);

    await run.homeQuota.quota.refresh("demand");
    expect(rowOf(second.id), "no reading yet is no meter, never an empty one").toMatchObject({
      status: "ok",
      windows: [],
    });
    expect(rowOf(first.id)?.windows.length, "the first login is still measured").toBeGreaterThan(0);

    const resetsAt = START + 2 * HOUR;
    run.homeQuota.recordClaudeRateLimit(second.id, {
      status: "rejected",
      windowId: "five_hour",
      resetsAt,
    });
    await run.homeQuota.quota.refresh("demand");
    expect(rowOf(second.id)?.windows).toMatchObject([
      { id: "five_hour", percentRemaining: 0, resetsAtMs: resetsAt },
    ]);

    vi.setSystemTime(resetsAt + 60_000);
    await run.homeQuota.quota.refresh("demand");
    const refilled = rowOf(second.id)?.windows ?? [];
    expect(refilled).toMatchObject([{ id: "five_hour", percentRemaining: 100 }]);
    expect(refilled[0]?.resetsAtMs, "the passed reset is not shown as the next one").toBe(
      undefined,
    );

    expect(run.usageAsks.length, "the usage address was asked for the first login").toBeGreaterThan(
      0,
    );
    expect(new Set(run.usageAsks), "and only ever with the first login's own sign-in").toEqual(
      new Set([`Bearer ${FIRST_TOKEN}`]),
    );
  });

  // Plan item 7: removing a further login runs the client's own sign-out in
  // its folder, then deletes the folder.
  it("removes a further login by signing its folder out and deleting it, leaving the first untouched", async () => {
    const run = boot(home);
    const first = await run.add();
    const second = await run.add();
    const folder = run.folderOf(second.id);
    expect(existsSync(folder)).toBe(true);

    await run.vault.remove(second.id);
    expect(run.client.calls).toContainEqual({ command: "auth logout", configDir: folder });
    expect(existsSync(folder)).toBe(false);
    expect(run.vault.list().map((account) => account.id)).toEqual([first.id]);
    expect(run.vault.binding(first.id)).toEqual({ via: "default-login" });
    expect(
      run.client.calls.some((call) => call.command === "auth logout" && !call.configDir),
      "the default login is never signed out",
    ).toBe(false);
    expect(existsSync(join(home, ".claude", ".credentials.json"))).toBe(true);
  });

  it("still deletes a further login's folder when the client's sign-out fails", async () => {
    const run = boot(home);
    const first = await run.add();
    const second = await run.add();
    run.client.behavior.logoutThrows = true;
    await run.vault.remove(second.id);
    expect(existsSync(run.folderOf(second.id))).toBe(false);
    expect(run.vault.list().map((account) => account.id)).toEqual([first.id]);
  });

  it("keeps a further login on its own folder when the folder goes missing: signed out, never the default login", async () => {
    const run = boot(home);
    await run.add();
    const second = await run.add();
    const folder = run.folderOf(second.id);
    rmSync(folder, { recursive: true, force: true });
    run.client.signedIn.delete(folder);
    vi.setSystemTime(START + HOUR);
    expect(run.vault.binding(second.id)).toEqual({ via: "config-dir", configDir: folder });
    expect((await run.vault.status(second.id, { refresh: true })).connected).toBe(false);
  });

  // Plan item 6: the first mate's seat accepts both bindings.
  it("lets the first mate sit on the first login or a further one, and not on a paused one", async () => {
    const run = boot(home);
    const first = await run.add();
    const second = await run.add();
    expect(run.flagship.seatable(first.id)).toBe(true);
    expect(run.flagship.seatable(second.id)).toBe(true);
    run.vault.setEnabled(second.id, false);
    expect(run.flagship.seatable(second.id)).toBe(false);
  });
});
