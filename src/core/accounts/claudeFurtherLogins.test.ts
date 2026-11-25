import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIRST_TOKEN,
  HOUR,
  SECOND_EMAIL,
  START,
  standInClient,
  writeDefaultLogin,
} from "../../../tests/helpers/claudeLogins";
import { freshDatabase } from "../../../tests/helpers/database";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { scriptedClaudeQuery } from "../../../tests/helpers/scriptedClaudeQuery";
import { ClaudeAuthBackend } from "../claude/claudeAuth";
import { claudeEnvFor } from "../claude/claudeCli";
import { claudeAvailableModels } from "../claude/claudeModels";
import { CLAUDE_MODEL_PROVIDER } from "../claude/claudeQueryCore";
import { readClaudeStore } from "../claude/claudeQuota";
import { acquireSessionLease, resetStoreLeasesForTest } from "../claude/claudeStoreLease";
import { claudeLoginDirs, createClaudeSessionFactory } from "../claude/session";
import { absentKeychain } from "../host";
import { createAccountStore } from "../models/accountStore";
import { claudeListReader } from "../models/clientLists";
import { Flagship } from "../orchestrator/flagship";
import { seatSessionSpec } from "../orchestrator/seat";
import { appPathsFor } from "../paths";
import { AccountVault } from "../pi/accountVault";
import type { AuthInteractionBridge } from "../pi/piAuth";
import { startHomeQuota } from "../quota/homeQuota";
import { questionSessionSpec } from "../session/questionSession";
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

const USAGE_FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "../../../tests/fixtures/quota-credits/claude-usage.json"), "utf8"),
);

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
  const held: { held: boolean; accounts: number }[] = [];
  // The vault says what its registry holds once as it opens, before `vault`
  // is assigned: that first word finds no saved account.
  let opened: AccountVault | undefined;
  const vault: AccountVault = AccountVault.create(paths, {
    backends: [claude],
    furtherLoginsHeld: (now) => held.push({ held: now, accounts: opened?.list().length ?? 0 }),
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
  opened = vault;
  const settings = new SettingsStore(db);
  const flagship = new Flagship({
    vault,
    settings,
    quota: homeQuota.quota,
    baseRuntime: { kind: "base" } as never,
    decisions: { recordAccount: () => 1 },
  });
  const add = () => vault.add(CLAUDE_PROVIDER_ID, "oauth", bridge);
  const folderOf = (accountId: string) =>
    claudeLoginFolder(join(paths.accountsDir, CLAUDE_PROVIDER_ID, accountId));
  return {
    paths,
    client,
    storesRead,
    usageAsks,
    held,
    vault,
    homeQuota,
    flagship,
    settings,
    add,
    folderOf,
  };
}

/** The app's own account store over `paths`, as a start opens it. */
function openStore(paths: ReturnType<typeof appPathsFor>, home: string) {
  return createAccountStore(paths, {
    backends: [
      new ClaudeAuthBackend({
        furtherLogins: true,
        run: standInClient().run,
        available: () => true,
        configDir: () => join(home, ".claude"),
        readStore: (dir, options) => readClaudeStore(dir, { ...options, keychain: absentKeychain }),
      }),
    ],
    packaged: false,
    claudeConfigDir: () => join(home, ".claude"),
    claudeList: { read: async () => [], clientVersion: async () => undefined },
    rail: "home",
  }).vault;
}

const revisionIn = (folder: string) =>
  JSON.parse(readFileSync(join(folder, "saved-data-format.json"), "utf8")).revision;

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
    // Each reading moves the login's own row as it arrives: no pass is
    // asked, so no other account's sensor is.
    const asksBefore = run.usageAsks.length;
    const firstRowBefore = rowOf(first.id);
    expect(rowOf(second.id)?.windows).toMatchObject([
      { id: "five_hour", percentRemaining: 0, resetsAtMs: resetsAt },
    ]);
    run.homeQuota.recordClaudeRateLimit(second.id, {
      status: "allowed",
      windowId: "seven_day",
      utilization: 0.4,
      resetsAt: START + 100 * HOUR,
    });
    expect(rowOf(second.id)?.windows).toMatchObject([
      { id: "five_hour" },
      { id: "seven_day", percentRemaining: 60 },
    ]);
    await Promise.resolve();
    expect(run.usageAsks.length, "the usage address was not asked again").toBe(asksBefore);
    expect(rowOf(first.id), "the first login's row is as it was read").toEqual(firstRowBefore);

    vi.setSystemTime(resetsAt + 60_000);
    await run.homeQuota.quota.refresh("demand");
    const refilled = rowOf(second.id)?.windows ?? [];
    expect(refilled).toMatchObject([
      { id: "five_hour", percentRemaining: 100 },
      { id: "seven_day" },
    ]);
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
    const folder = run.folderOf(second.id);
    run.client.behavior.logoutThrows = true;
    await run.vault.remove(second.id);
    expect(run.client.calls, "the sign-out was tried in the login's folder").toContainEqual({
      command: "auth logout",
      configDir: folder,
    });
    expect(existsSync(folder)).toBe(false);
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

  // Plan item 5: a session runs on its account's own binding, and an account
  // that is gone is refused rather than run on the default login.
  it("names a further login's folder to its sessions and refuses a removed login's", async () => {
    const run = boot(home);
    const first = await run.add();
    const second = await run.add();
    const folder = run.folderOf(second.id);
    const dirs = claudeLoginDirs(run.vault);
    expect(dirs.ownConfigDir?.(first.id)).toBe(undefined);
    expect(dirs.ownConfigDir?.(second.id)).toBe(folder);
    await run.vault.remove(second.id);
    expect(() => dirs.ownConfigDir?.(second.id)).toThrow(/Unknown account/);
  });

  // Plan items 5 and 9 on the real factory with the vault's own wiring: the
  // question's one-shot client is started as its account's login.
  it("starts a question's client in a further login's folder without the person's gateway settings, and refuses a removed login's", async () => {
    const run = boot(home);
    const first = await run.add();
    const second = await run.add();
    const folder = run.folderOf(second.id);
    const scripted = scriptedClaudeQuery({
      onInput: (_message, emit) =>
        emit({ type: "result", subtype: "success", is_error: false, result: "left" }),
    });
    const settingsAsks: string[] = [];
    let asking = "";
    const factory = createClaudeSessionFactory({
      ...claudeLoginDirs(run.vault),
      env: () => ({
        PATH: "/usr/bin",
        HOME: home,
        ANTHROPIC_CUSTOM_HEADERS: "x-team-id: inherited",
      }),
      checkClient: async () => ({ state: "ready", executable: "/usr/local/bin/claude" }),
      resolveWorkSettings: async () => ({ effective: {}, provenance: {}, sources: [] }),
      accessSettings: async () => {
        settingsAsks.push(asking);
        return { env: { ANTHROPIC_CUSTOM_HEADERS: "x-team-id: settings" } };
      },
      query: scripted.factory,
    });
    const ask = async (accountId: string) => {
      asking = accountId;
      const session = await factory.open(
        questionSessionSpec({
          homeDir: home,
          binding: { backend: "claude", accountId },
          model: { provider: CLAUDE_MODEL_PROVIDER, id: "claude-haiku-4-5" },
          instruction: "Answer with exactly one of: left, right.",
        }),
      );
      await session.prompt("Which way?");
      session.dispose();
      return scripted.harness().options.env ?? {};
    };

    const further = await ask(second.id);
    expect(further.CLAUDE_CONFIG_DIR).toBe(folder);
    expect(further.ANTHROPIC_CUSTOM_HEADERS).toBe(undefined);
    expect(settingsAsks, "the person's gateway settings were not read for it").toEqual([]);

    const firstEnv = await ask(first.id);
    expect(firstEnv.CLAUDE_CONFIG_DIR).toBe(undefined);
    expect(settingsAsks).toEqual([first.id]);

    await run.vault.remove(second.id);
    await expect(ask(second.id)).rejects.toThrow(/Unknown account/);
    expect(scripted.attachments, "no client was started for the removed login").toHaveLength(2);
  });

  // Plan item 9: the person's gateway headers are their default login's.
  it("keeps inherited gateway headers out of a further login's client", () => {
    const inherited = { PATH: "/usr/bin", ANTHROPIC_CUSTOM_HEADERS: "x-team-id: stand-in" };
    expect(claudeEnvFor(inherited).ANTHROPIC_CUSTOM_HEADERS).toBe("x-team-id: stand-in");
    const own = claudeEnvFor(inherited, "/stores/second/claude");
    expect(own.CLAUDE_CONFIG_DIR).toBe("/stores/second/claude");
    expect(own.ANTHROPIC_CUSTOM_HEADERS).toBe(undefined);
  });

  it("asks a further login's model list as that login, while no session holds its folder", async () => {
    const run = boot(home);
    const first = await run.add();
    const second = await run.add();
    const folder = run.folderOf(second.id);
    const askedAs: (string | undefined)[] = [];
    const reader = claudeListReader({
      configDir: () => join(home, ".claude"),
      ownConfigDir: (accountId) => run.vault.claudeConfigDir(accountId),
      read: async (ownConfigDir) => {
        askedAs.push(ownConfigDir);
        return [];
      },
      clientVersion: async () => undefined,
    });
    const account = (accountId: string) => ({ accountId, providerId: CLAUDE_PROVIDER_ID });
    await reader(account(first.id));
    await reader(account(second.id));
    expect(askedAs).toEqual([undefined, folder]);

    const release = await acquireSessionLease(folder);
    expect(await reader(account(second.id))).toEqual({ status: "deferred" });
    await reader(account(first.id));
    release();
    expect(askedAs).toEqual([undefined, folder, undefined]);
  });

  // The captain's choice on the review: an older version must refuse a
  // folder that holds a further login, so the folder is marked before the
  // record exists and handed back once the last further login is removed.
  it("says a further login is held before its record is saved, and that none is left after the last is removed", async () => {
    const run = boot(home);
    const first = await run.add();
    expect(run.held, "an empty folder and the first login hold none").toEqual([
      { held: false, accounts: 0 },
    ]);
    const second = await run.add();
    const third = await run.add();
    expect(run.held.slice(1)).toEqual([
      { held: true, accounts: 1 },
      { held: true, accounts: 2 },
    ]);
    await run.vault.remove(second.id);
    await run.vault.remove(third.id);
    await run.vault.remove(first.id);
    expect(run.held.slice(3)).toEqual([
      { held: true, accounts: 2 },
      { held: false, accounts: 1 },
      { held: false, accounts: 0 },
    ]);
  });

  it("marks the saved-data folder as revision 2 while it holds a further login, and as revision 1 again once it is removed", async () => {
    const paths = appPathsFor(scratchDir("claude-further-logins-marked-"));
    const vault = openStore(paths, home);
    const marker = join(paths.userData, "saved-data-format.json");
    await vault.add(CLAUDE_PROVIDER_ID, "oauth", bridge);
    expect(existsSync(marker), "the first login marks nothing").toBe(false);
    const second = await vault.add(CLAUDE_PROVIDER_ID, "oauth", bridge);
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ schemaVersion: 1, revision: 2 });
    await vault.remove(second.id);
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ schemaVersion: 1, revision: 1 });
  });

  // The captain's choice on the review, at a start: the marker follows the
  // account records only when they were read.
  it("keeps the folder marked at a start that cannot read the account records, and unmarks one whose records hold no further login", async () => {
    const paths = appPathsFor(scratchDir("claude-further-logins-unread-"));
    const vault = openStore(paths, home);
    await vault.add(CLAUDE_PROVIDER_ID, "oauth", bridge);
    const second = await vault.add(CLAUDE_PROVIDER_ID, "oauth", bridge);
    const registry = join(paths.accountsDir, "registry.json");
    const saved = readFileSync(registry, "utf8");

    writeFileSync(registry, saved.slice(0, saved.length / 2));
    expect(openStore(paths, home).list(), "the cut-short records read as none").toEqual([]);
    expect(revisionIn(paths.userData)).toBe(2);

    writeFileSync(registry, saved);
    expect(
      openStore(paths, home)
        .list()
        .map((account) => account.id),
    ).toContain(second.id);
    expect(revisionIn(paths.userData)).toBe(2);

    // A start that ended after the mark and before the record was saved.
    const records = JSON.parse(saved) as { accounts: { id: string }[] };
    records.accounts = records.accounts.filter((account) => account.id !== second.id);
    writeFileSync(registry, JSON.stringify(records));
    expect(openStore(paths, home).list()).toHaveLength(1);
    expect(revisionIn(paths.userData)).toBe(1);
  });

  // The copy a run from source keeps holds the marker and no account
  // records, so its marker moves with the folder's.
  it("marks the copy a run from source kept along with the folder, and makes no copy of its own", async () => {
    const paths = appPathsFor(scratchDir("claude-further-logins-kept-"));
    const vault = openStore(paths, home);
    await vault.add(CLAUDE_PROVIDER_ID, "oauth", bridge);
    const kept = join(paths.userData, "before-source-run");
    const second = await vault.add(CLAUDE_PROVIDER_ID, "oauth", bridge);
    expect(existsSync(kept), "no copy is made where none was kept").toBe(false);
    await vault.remove(second.id);

    mkdirSync(kept, { recursive: true });
    writeFileSync(join(kept, "firstmate.db"), "");
    writeFileSync(
      join(kept, "saved-data-format.json"),
      `${JSON.stringify({ schemaVersion: 1, revision: 1 })}\n`,
    );
    const third = await vault.add(CLAUDE_PROVIDER_ID, "oauth", bridge);
    expect(revisionIn(kept), "copied back, it still blocks an older version").toBe(2);
    expect(revisionIn(paths.userData)).toBe(2);
    await vault.remove(third.id);
    expect(revisionIn(kept)).toBe(1);
    expect(revisionIn(paths.userData)).toBe(1);
  });

  // Plan item 6 on the real factory: the first mate's own session opens on
  // the login the seat resolves, through the seat's binding and session spec.
  it("opens the first mate's session in the folder of the further login it is seated on", async () => {
    const run = boot(home);
    const first = await run.add();
    const second = await run.add();
    const scripted = scriptedClaudeQuery({
      onInput: (_message, emit) =>
        emit({ type: "result", subtype: "success", is_error: false, result: "aye" }),
    });
    const factory = createClaudeSessionFactory({
      ...claudeLoginDirs(run.vault),
      env: () => ({ PATH: "/usr/bin", HOME: home }),
      clock: { now: () => Date.now(), register: () => () => {} },
      checkClient: async () => ({ state: "ready", executable: "/usr/local/bin/claude" }),
      resolveWorkSettings: async () => ({ effective: {}, provenance: {}, sources: [] }),
      query: scripted.factory,
    });
    const seatOn = async (accountId: string) => {
      run.settings.setFirstmateAccount(accountId);
      const binding = await run.flagship.resolveBinding(CLAUDE_MODEL_PROVIDER);
      const session = await factory.open(
        seatSessionSpec({
          paths: run.paths,
          binding,
          model: { provider: CLAUDE_MODEL_PROVIDER, id: "claude-haiku-4-5" },
          tools: [],
        }),
      );
      await session.prompt("Report.");
      session.dispose();
      return { binding, env: scripted.harness().options.env ?? {} };
    };

    const further = await seatOn(second.id);
    expect(further.binding).toMatchObject({ backend: "claude", accountId: second.id });
    expect(further.env.CLAUDE_CONFIG_DIR).toBe(run.folderOf(second.id));

    const onFirst = await seatOn(first.id);
    expect(onFirst.binding).toMatchObject({ backend: "claude", accountId: first.id });
    expect(onFirst.env.CLAUDE_CONFIG_DIR).toBe(undefined);
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
