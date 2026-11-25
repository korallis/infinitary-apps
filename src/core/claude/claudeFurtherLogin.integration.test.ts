import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { writeMockClaudeClient } from "../../../tests/e2e/mockClaudeClient";
import { answerText, type StubApi, startStubApi } from "../../../tests/helpers/anthropicDialect";
import { crewmateToolDelegate } from "../../../tests/helpers/crewmateToolDelegate";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { crewmateSessionSpec } from "../orchestrator/crewSession";
import { appPathsFor } from "../paths";
import { LOCAL_MACHINE_ID } from "../session/session";
import { SessionRecordStore } from "../storage/sessionRecordStore";
import { resolveClaudeExecutable } from "./claudeCli";
import { CLAUDE_MODEL_PROVIDER } from "./claudeQueryCore";
import { resetStoreLeasesForTest } from "./claudeStoreLease";
import { createClaudeSessionFactory } from "./session";

// One boxed client turn, like the sibling real-client cases, which hold 15 s
// from the hosted Linux check machine's measure.
vi.setConfig({ testTimeout: 15_000 });

/**
 * A further Claude login's sessions run in that login's own Claude Code
 * folder (the approved plan for several Claude logins, piece 1, items 5 and
 * 9: the folder reaches the client, and the person's token command and
 * gateway address reach only the default login's sessions).
 *
 * The client the product would run is boxed by the e2e stub with a stand-in
 * key and a local stand-in for Anthropic; no sign-in happens. Where the
 * client keeps what it records is the proof: it writes a session's record
 * under the config folder it was started with.
 */

const MODEL = "claude-haiku-4-5";
const FIRST = "acct_claude_first";
const FURTHER = "acct_claude_further";

let api: StubApi;

beforeAll(async () => {
  api = await startStubApi();
});

afterAll(async () => {
  await api.close();
});

const stores: SessionRecordStore[] = [];

afterEach(async () => {
  resetStoreLeasesForTest();
  await Promise.all(stores.splice(0).map((store) => store.flushed()));
});

/** Whether the client recorded a session under this config folder. */
function recordedIn(configDir: string): boolean {
  const projects = join(configDir, "projects");
  return existsSync(projects) && readdirSync(projects).length > 0;
}

function boxed() {
  const home = scratchDir("infinitary-claude-further-home-");
  const furtherFolder = join(scratchDir("infinitary-claude-further-store-"), "claude");
  const client = resolveClaudeExecutable();
  const stub = writeMockClaudeClient(home, {
    turns: { baseUrl: api.url, ...(client ? { client } : {}) },
  });
  const env = { PATH: process.env.PATH ?? "", HOME: home, INFINITARY_CLAUDE_CLI: stub };
  const accessAsks: string[] = [];
  let running = "";
  const factory = createClaudeSessionFactory({
    configDir: join(home, ".claude"),
    ownConfigDir: (accountId) => (accountId === FURTHER ? furtherFolder : undefined),
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
      return {};
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
  return { defaultFolder: join(home, ".claude"), furtherFolder, accessAsks, turn };
}

describe("a Claude crewmate on a further login", () => {
  it("runs the client in that login's own folder, without the person's gateway settings", async () => {
    const run = boxed();
    api.answer((request, res) => answerText(request, res, "Aye from the further login."));
    expect(await run.turn(FURTHER), "the answer reached the crewmate").toContain(
      "Aye from the further login.",
    );
    expect(recordedIn(run.furtherFolder), "the client recorded the session in its folder").toBe(
      true,
    );
    expect(recordedIn(run.defaultFolder), "and nothing in the default login's").toBe(false);
    expect(run.accessAsks, "the person's gateway settings were not read for it").toEqual([]);
  });

  it("leaves the first login's sessions on the default folder, with the person's gateway settings", async () => {
    const run = boxed();
    api.answer((request, res) => answerText(request, res, "Aye from the first login."));
    expect(await run.turn(FIRST)).toContain("Aye from the first login.");
    expect(recordedIn(run.defaultFolder)).toBe(true);
    expect(recordedIn(run.furtherFolder)).toBe(false);
    expect(run.accessAsks).toEqual([FIRST]);
  });
});
