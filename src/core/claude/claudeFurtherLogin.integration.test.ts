import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { writeMockClaudeClient } from "../../../tests/e2e/mockClaudeClient";
import { answerText, type StubApi, startStubApi } from "../../../tests/helpers/anthropicDialect";
import { standInClient, writeDefaultLogin } from "../../../tests/helpers/claudeLogins";
import { crewmateToolDelegate } from "../../../tests/helpers/crewmateToolDelegate";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { absentKeychain } from "../host";
import { crewmateSessionSpec } from "../orchestrator/crewSession";
import { appPathsFor } from "../paths";
import { AccountVault } from "../pi/accountVault";
import { LOCAL_MACHINE_ID } from "../session/session";
import { SessionRecordStore } from "../storage/sessionRecordStore";
import { ClaudeAuthBackend } from "./claudeAuth";
import { resolveClaudeExecutable } from "./claudeCli";
import { CLAUDE_MODEL_PROVIDER } from "./claudeQueryCore";
import { readClaudeStore } from "./claudeQuota";
import { resetStoreLeasesForTest } from "./claudeStoreLease";
import { claudeLoginDirs, createClaudeSessionFactory } from "./session";

// One boxed client turn, like the sibling real-client cases, which hold 15 s
// from the hosted Linux check machine's measure.
vi.setConfig({ testTimeout: 15_000 });

/**
 * A further Claude login's sessions run in that login's own Claude Code
 * folder (the approved plan for several Claude logins, piece 1, items 5 and
 * 9: the folder reaches the client, and the person's token command and
 * gateway address reach only the default login's sessions).
 *
 * Real parts: the account vault and Claude account backend holding both
 * logins, the wiring that names each account's folder to its sessions, and
 * the client the product would run, boxed by the e2e stub with a stand-in
 * key and a local stand-in for Anthropic. Stand-ins: the client's sign-in
 * commands and the default login's store files; no sign-in happens. Where
 * the client keeps what it records is the proof of the folder: it writes a
 * session's record under the config folder it was started with. The header
 * each request carries is the proof of the gateway settings.
 */

const MODEL = "claude-haiku-4-5";
const SETTINGS_HEADER = "x-team-id: from-settings";
const INHERITED_HEADER = "x-inherited-id: from-environment";

let api: StubApi;

beforeAll(async () => {
  api = await startStubApi();
});

afterAll(async () => {
  await api.close();
});

const stores: SessionRecordStore[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  resetStoreLeasesForTest();
  await Promise.all(stores.splice(0).map((store) => store.flushed()));
});

/** Whether the client recorded a session under this config folder. */
function recordedIn(configDir: string): boolean {
  const projects = join(configDir, "projects");
  return existsSync(projects) && readdirSync(projects).length > 0;
}

async function boxed() {
  const home = scratchDir("infinitary-claude-further-home-");
  const client = resolveClaudeExecutable();
  const stub = writeMockClaudeClient(home, {
    turns: { baseUrl: api.url, ...(client ? { client } : {}) },
  });
  // The vault's default login lives in its own scratch home, apart from the
  // boxed client's, so the box never meets a stand-in sign-in file.
  const loginHome = scratchDir("infinitary-claude-further-login-");
  writeDefaultLogin(loginHome);
  vi.stubEnv("HOME", loginHome);
  const paths = appPathsFor(scratchDir("infinitary-claude-further-vault-"));
  const vault = AccountVault.create(paths, {
    backends: [
      new ClaudeAuthBackend({
        furtherLogins: true,
        run: standInClient().run,
        available: () => true,
        configDir: () => join(loginHome, ".claude"),
        readStore: (dir, options) => readClaudeStore(dir, { ...options, keychain: absentKeychain }),
      }),
    ],
  });
  const bridge = {
    prompt: () => new Promise<string>(() => {}),
    notify: () => {},
    openExternal: async () => {},
  };
  const first = await vault.add(CLAUDE_PROVIDER_ID, "oauth", bridge);
  const further = await vault.add(CLAUDE_PROVIDER_ID, "oauth", bridge);
  const furtherFolder = vault.claudeConfigDir(further.id) as string;
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    INFINITARY_CLAUDE_CLI: stub,
    ANTHROPIC_CUSTOM_HEADERS: INHERITED_HEADER,
  };
  const accessAsks: string[] = [];
  let running = "";
  const factory = createClaudeSessionFactory({
    ...claudeLoginDirs(vault),
    // The default login's folder is the boxed client's own.
    configDir: join(home, ".claude"),
    env: () => env,
    clock: { now: () => Date.now(), register: () => () => {} },
    log: () => {},
    records: (dir) => {
      const store = new SessionRecordStore(dir);
      stores.push(store);
      return store;
    },
    accessSettings: async () => {
      accessAsks.push(running);
      return { env: { ANTHROPIC_CUSTOM_HEADERS: SETTINGS_HEADER } };
    },
  });
  const turn = async (accountId: string) => {
    running = accountId;
    const spec = crewmateSessionSpec(
      appPathsFor(scratchDir("infinitary-claude-further-app-")),
      {
        ...crewmateToolDelegate(),
        machineId: LOCAL_MACHINE_ID,
        cwd: home,
        model: { provider: CLAUDE_MODEL_PROVIDER, id: MODEL },
      },
      { backend: "claude", accountId },
    );
    const session = await factory.open(spec);
    const events: unknown[] = [];
    session.subscribe((event) => events.push(event));
    await session.prompt("Say aye.");
    session.dispose();
    await session.closed();
    return JSON.stringify(events);
  };
  /** One header's values across the requests a turn sent. */
  const sentSince = (from: number, header: string) => [
    ...new Set(api.requests.slice(from).map((request) => request.headers[header])),
  ];
  return {
    defaultFolder: join(home, ".claude"),
    furtherFolder,
    first: first.id,
    further: further.id,
    removeFurther: () => vault.remove(further.id),
    accessAsks,
    turn,
    sentSince,
  };
}

describe("a Claude crewmate on a further login", () => {
  it("runs the client in that login's own folder, without the person's gateway settings", async () => {
    const run = await boxed();
    api.answer((request, res) => answerText(request, res, "Aye from the further login."));
    const from = api.requests.length;
    expect(await run.turn(run.further), "the answer reached the crewmate").toContain(
      "Aye from the further login.",
    );
    expect(recordedIn(run.furtherFolder), "the client recorded the session in its folder").toBe(
      true,
    );
    expect(recordedIn(run.defaultFolder), "and nothing in the default login's").toBe(false);
    expect(run.accessAsks, "the person's gateway settings were not read for it").toEqual([]);
    expect(api.requests.length, "the turn reached the stand-in API").toBeGreaterThan(from);
    expect(
      run.sentSince(from, "x-team-id"),
      "no request carried the settings' gateway header",
    ).toEqual([undefined]);
    expect(run.sentSince(from, "x-inherited-id"), "nor the header this process inherited").toEqual([
      undefined,
    ]);
  });

  it("leaves the first login's sessions on the default folder, with the person's gateway settings", async () => {
    const run = await boxed();
    api.answer((request, res) => answerText(request, res, "Aye from the first login."));
    const from = api.requests.length;
    expect(await run.turn(run.first)).toContain("Aye from the first login.");
    expect(recordedIn(run.defaultFolder)).toBe(true);
    expect(recordedIn(run.furtherFolder)).toBe(false);
    expect(run.accessAsks).toEqual([run.first]);
    expect(
      run.sentSince(from, "x-team-id"),
      "every request carried the settings' gateway header",
    ).toEqual(["from-settings"]);
  });

  it("refuses a session for a login that was removed, and runs nothing on the default login", async () => {
    const run = await boxed();
    await run.removeFurther();
    const from = api.requests.length;
    await expect(run.turn(run.further)).rejects.toThrow(/Unknown account/);
    expect(api.requests.length, "no request left the computer").toBe(from);
    expect(recordedIn(run.defaultFolder), "and the default login recorded nothing").toBe(false);
  });
});
