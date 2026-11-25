import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { claudeWindowLabel } from "../../src/core/quota/providers/claude";
import { COPILOT_PLAN, COPILOT_PREMIUM_LABEL } from "../../src/core/quota/providers/copilot";
import {
  GROK_CREDITS_LABEL,
  GROK_NO_WINDOW_DETAIL,
  GROK_PRODUCT_LABELS,
} from "../../src/core/quota/providers/grok";
import { KIMI_NO_WINDOW_DETAIL } from "../../src/core/quota/providers/kimi";
import {
  EMPTY_QUOTA_TEXT,
  SUBSCRIPTIONS_WORDS,
} from "../../src/renderer/src/settings/subscriptionsWords";
import { needsReauthCopy } from "../../src/shared/credentialHealth";
import * as m from "../../src/shared/i18n/messages.generated";
import { CLAUDE_PROVIDER_ID, catalogEntry } from "../../src/shared/providers";
import { scratchDir } from "../helpers/scratchDirs";
import { consumerConfigMessage, grpcWebOkBody } from "../support/grpcWebEncoder";
import { seedAccountAuth, seedAccountRegistry, seedAccountStore } from "./accountFixtures";
import { CLI_PROXY_MODELS, type CliProxyStub, startCliProxyStub } from "./cliProxyStub";
import { customApiBlock } from "./customApi";
import { startCustomApiFixture } from "./customApiFixture";
import { type LaunchedApp, launchApp } from "./launch";
import { resizeWindow } from "./layout";
import {
  claudeDefaultStore,
  claudeHomeWithCredential,
  quotaIdentityHome,
  writeClaudeIdentity,
  writeMockClaudeClient,
  writeRefusedClaudeClient,
  writeRenewingClaudeClient,
} from "./mockClaudeClient";
import { regionShot } from "./pictures";
import { readSavedData } from "./savedData";
import { focusOn, pressKey } from "./windowKeys";

/**
 * Live-sensor journeys do not use the quota fixture seam.
 *
 * Snapshot-based quota specs inject a finished snapshot straight into
 * QuotaService, which means the whole credential-and-request layer -
 * `QuotaAuth.resolve`, `readClaudeStore`, the provider fetchers, the
 * delegated renewal, the status vocabulary - had no end-to-end coverage at
 * all. That is how two provider defects reached the captain's Settings twice.
 *
 * These run the real `createQuotaFetcher` against a local stub of the
 * vendor's usage endpoint, and walks the whole path: resolve the account's own
 * store -> fetch -> parse -> snapshot -> IPC -> render. The only thing
 * redirected is the endpoint's address (a dev/e2e-gated override the packaged
 * app refuses to read); the credential store, the resolver and the renewal are
 * the app's own.
 */

const CLAUDE_PERSONAL = "acct_claude_live";
const GROK_PERSONAL = "acct_grok_live";
const KIMI_PERSONAL = "acct_kimi_live";
/** An unreleased vendor codename the usage stub answers with beside its real windows. */
const UNRELEASED_WINDOW = "nimbus_quill";
/** The Grok product whose own window the credits stub reports. */
const GROK_BUILD_PRODUCT = 2;

type StubUsage = {
  server: Server;
  url: string;
  /** Bearer tokens the stub will answer with a real reading. */
  accept: Set<string>;
  seen: string[];
  status: number;
};

async function startStubUsage(accept: string[]): Promise<StubUsage> {
  const stub: StubUsage = {
    server: createServer(),
    url: "",
    accept: new Set(accept),
    seen: [],
    status: 200,
  };
  stub.server.on("request", (request, response) => {
    const bearer = (request.headers.authorization ?? "").replace(/^Bearer /, "");
    stub.seen.push(bearer);
    if (!stub.accept.has(bearer)) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error" }));
      return;
    }
    const resetsAt = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
    response.writeHead(stub.status, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        // The vendor's real shape: `limits` is authoritative, unreleased
        // codenames sit beside it at the top level, and a switched-off
        // extra-usage block must not become a meter.
        five_hour: { utilization: 30, resets_at: resetsAt },
        [UNRELEASED_WINDOW]: { utilization: 0, resets_at: resetsAt },
        extra_usage: { is_enabled: false, utilization: 0 },
        limits: [
          { kind: "session", group: "session", percent: 30, resets_at: resetsAt },
          { kind: "weekly_all", group: "weekly", percent: 10, resets_at: resetsAt },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => stub.server.listen(0, "127.0.0.1", resolve));
  const { port } = stub.server.address() as AddressInfo;
  stub.url = `http://127.0.0.1:${port}/api/oauth/usage`;
  return stub;
}

type StubMeter = {
  server: Server;
  url: string;
  /** Bearer tokens the stub answers with a real config. */
  accept: Set<string>;
  seen: { bearer: string; contentType: string; body: number[] }[];
};

/**
 * A stand-in for the vendor's consumer credits meter: a gRPC-web unary
 * endpoint that answers the empty request with a framed config message -
 * the exact wire shape captured live on 2026-09-05 - and refuses any other
 * bearer with the vendor's UNAUTHENTICATED verdict in a trailer.
 */
async function startStubMeter(accept: string[]): Promise<StubMeter> {
  const stub: StubMeter = { server: createServer(), url: "", accept: new Set(accept), seen: [] };
  stub.server.on("request", (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const bearer = (request.headers.authorization ?? "").replace(/^Bearer /, "");
      stub.seen.push({
        bearer,
        contentType: request.headers["content-type"] ?? "",
        body: Array.from(Buffer.concat(chunks)),
      });
      response.writeHead(stub.accept.has(bearer) ? 200 : 401, {
        "content-type": "application/grpc-web+proto",
      });
      if (!stub.accept.has(bearer)) {
        response.end();
        return;
      }
      const nowSeconds = Math.floor(Date.now() / 1000);
      response.end(
        Buffer.from(
          grpcWebOkBody(
            consumerConfigMessage({
              percentUsed: 25,
              products: [{ product: GROK_BUILD_PRODUCT, percentUsed: 25 }],
              periodType: 2,
              periodStartSeconds: nowSeconds - 2 * 86_400,
              periodEndSeconds: nowSeconds + 5 * 86_400,
              prepaidBalance: 0,
            }),
          ),
        ),
      );
    });
  });
  await new Promise<void>((resolve) => stub.server.listen(0, "127.0.0.1", resolve));
  const { port } = stub.server.address() as AddressInfo;
  stub.url = `http://127.0.0.1:${port}/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig`;
  return stub;
}

type StubKeyRead = {
  server: Server;
  url: string;
  /** Keys the stub answers with the key's credits. */
  accept: Set<string>;
  seen: { method: string; bearer: string }[];
};

/**
 * A stand-in for xAI's `GET /v1/api-key`, the read an API key's allowance
 * comes from: it answers a key it knows with that key's team credits and
 * any other with the vendor's 401.
 */
async function startStubKeyRead(accept: string[]): Promise<StubKeyRead> {
  const stub: StubKeyRead = { server: createServer(), url: "", accept: new Set(accept), seen: [] };
  stub.server.on("request", (request, response) => {
    request.resume();
    request.on("end", () => {
      const bearer = (request.headers.authorization ?? "").replace(/^Bearer /, "");
      stub.seen.push({ method: request.method ?? "", bearer });
      if (!stub.accept.has(bearer)) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ remaining_credits: 40, credit_limit: 100 }));
    });
  });
  await new Promise<void>((resolve) => stub.server.listen(0, "127.0.0.1", resolve));
  const { port } = stub.server.address() as AddressInfo;
  stub.url = `http://127.0.0.1:${port}/v1/api-key`;
  return stub;
}

/**
 * A Grok account the way the vault stores one: Pi's own auth file in the
 * account's 0700 store, holding either an OAuth entry the runtime resolves
 * without a network round trip because it has not expired, or an API key.
 */
function seedGrokAccount(userDataDir: string, stored: { accessToken: string } | { key: string }) {
  seedAccountStore(userDataDir, "xai", GROK_PERSONAL, { recursive: true, mode: 0o700 });
  seedAccountAuth(
    userDataDir,
    "xai",
    GROK_PERSONAL,
    {
      xai:
        "key" in stored
          ? { type: "api_key", key: stored.key }
          : {
              type: "oauth",
              access: stored.accessToken,
              refresh: "stub-refresh",
              expires: Date.now() + 30 * 24 * 3600 * 1000,
            },
    },
    { mode: 0o600 },
  );
  seedAccountRegistry(
    userDataDir,
    [
      {
        id: GROK_PERSONAL,
        providerId: "xai",
        kind: "key" in stored ? "api_key" : "subscription_oauth",
        label: "Personal",
        enabled: true,
        createdAt: Date.parse("2026-08-01T00:00:00Z"),
      },
    ],
    {},
    { mode: 0o600 },
  );
}

type StubKimi = {
  server: Server;
  /** The usages meter's address. */
  url: string;
  /** The sign-in server's address, for Pi's own refresh. */
  oauthHost: string;
  /** Bearer tokens the meter answers with a reading. */
  accept: Set<string>;
  meterSeen: string[];
  refreshSeen: number;
};

/**
 * A stand-in for Kimi Code's two hosts: the usages meter, answering an
 * accepted bearer with the ratio-pool shape (`usages`, `user.membership`),
 * and the sign-in server, refusing every refresh the way it refuses a
 * lapsed refresh token (401, `invalid_grant`).
 */
async function startStubKimi(accept: string[]): Promise<StubKimi> {
  const stub: StubKimi = {
    server: createServer(),
    url: "",
    oauthHost: "",
    accept: new Set(accept),
    meterSeen: [],
    refreshSeen: 0,
  };
  stub.server.on("request", (request, response) => {
    request.resume();
    request.on("end", () => {
      if (request.url === "/api/oauth/token") {
        stub.refreshSeen += 1;
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      const bearer = (request.headers.authorization ?? "").replace(/^Bearer /, "");
      stub.meterSeen.push(bearer);
      if (!stub.accept.has(bearer)) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      const at = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          usages: {
            limit_5h: { used_ratio: 0.3, reset_time: at(3) },
            limit_7d: { used_ratio: 0.1, reset_time: at(5 * 24) },
            limit_month_total: { used_ratio: 0.05, reset_time: at(20 * 24) },
          },
          user: { membership: { level: "LEVEL_INTERMEDIATE" } },
          version: "GOODS_VERSION_V1",
        }),
      );
    });
  });
  await new Promise<void>((resolve) => stub.server.listen(0, "127.0.0.1", resolve));
  const { port } = stub.server.address() as AddressInfo;
  stub.url = `http://127.0.0.1:${port}/coding/v1/usages`;
  stub.oauthHost = `http://127.0.0.1:${port}`;
  return stub;
}

/**
 * A Kimi Code account the way the vault stores one: Pi's own auth file in
 * the account's store, holding Pi's device-code credential. `expires` in the
 * past is an account stored before Kimi Code came back, its token long lapsed.
 */
function seedKimiAccount(userDataDir: string, accessToken: string, expires: number) {
  seedAccountStore(userDataDir, "kimi-coding", KIMI_PERSONAL, { recursive: true, mode: 0o700 });
  seedAccountAuth(
    userDataDir,
    "kimi-coding",
    KIMI_PERSONAL,
    {
      "kimi-coding": { type: "oauth", access: accessToken, refresh: "stub-refresh", expires },
    },
    { mode: 0o600 },
  );
  seedAccountRegistry(
    userDataDir,
    [
      {
        id: KIMI_PERSONAL,
        providerId: "kimi-coding",
        kind: "subscription_oauth",
        label: "Personal",
        enabled: true,
        createdAt: Date.parse("2026-08-01T00:00:00Z"),
      },
    ],
    {},
    { mode: 0o600 },
  );
}

const COPILOT_LIVE = "acct_copilot_live";
const COPILOT_LAPSED = "acct_copilot_lapsed";

type StubCopilot = { server: Server; url: string; seen: string[] };

/**
 * A stand-in for GitHub's `copilot_internal/user`: it answers a paid seat's
 * reading (premium requests metered, chat and completions unlimited, in
 * the endpoint's `quota_snapshots` shape) for the one GitHub sign-in it knows, and
 * GitHub's 401 for any other.
 */
async function startStubCopilot(accept: string): Promise<StubCopilot> {
  const stub: StubCopilot = { server: createServer(), url: "", seen: [] };
  stub.server.on("request", (request, response) => {
    const bearer = (request.headers.authorization ?? "").replace(/^Bearer /, "");
    stub.seen.push(bearer);
    if (bearer !== accept) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "Bad credentials" }));
      return;
    }
    const reset = new Date();
    reset.setUTCMonth(reset.getUTCMonth() + 1, 1);
    const unlimited = (quota_id: string) => ({
      entitlement: 0,
      overage_count: 0,
      overage_permitted: false,
      percent_remaining: 100,
      quota_id,
      quota_remaining: 0,
      remaining: 0,
      unlimited: true,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        access_type_sku: "monthly_subscriber_quota",
        chat_enabled: true,
        copilot_plan: "individual",
        quota_reset_date: reset.toISOString().slice(0, 10),
        quota_snapshots: {
          chat: unlimited("chat"),
          completions: unlimited("completions"),
          premium_interactions: {
            entitlement: 300,
            overage_count: 0,
            overage_permitted: false,
            percent_remaining: 62,
            quota_id: "premium_interactions",
            quota_remaining: 186,
            remaining: 186,
            unlimited: false,
          },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => stub.server.listen(0, "127.0.0.1", resolve));
  const { port } = stub.server.address() as AddressInfo;
  stub.url = `http://127.0.0.1:${port}/copilot_internal/user`;
  return stub;
}

/**
 * Two Copilot accounts the way Pi stored them before Copilot left the
 * catalog: Pi's own auth file holding the GitHub sign-in (`refresh`) and an
 * unexpired Copilot token, so nothing reaches GitHub to renew it.
 */
function seedCopilotAccounts(userDataDir: string, signIns: Record<string, string>) {
  for (const [id, githubToken] of Object.entries(signIns)) {
    seedAccountStore(userDataDir, "github-copilot", id, { recursive: true, mode: 0o700 });
    seedAccountAuth(
      userDataDir,
      "github-copilot",
      id,
      {
        "github-copilot": {
          type: "oauth",
          refresh: githubToken,
          access: "tid=stub;exp=4000000000;proxy-ep=proxy.individual.githubcopilot.com",
          expires: Date.now() + 30 * 24 * 3600 * 1000,
        },
      },
      { mode: 0o600 },
    );
  }
  seedAccountRegistry(
    userDataDir,
    Object.keys(signIns).map((id, index) => ({
      id,
      providerId: "github-copilot",
      kind: "subscription_oauth",
      label: index === 0 ? "Personal" : "Old work",
      enabled: true,
      createdAt: Date.parse("2026-08-01T00:00:00Z") + index,
    })),
    {},
    { mode: 0o600 },
  );
}

function seedAccounts(userDataDir: string) {
  seedAccountStore(userDataDir, "anthropic-claude", CLAUDE_PERSONAL, {
    recursive: true,
    mode: 0o700,
  });
  seedAccountRegistry(
    userDataDir,
    [
      {
        id: CLAUDE_PERSONAL,
        providerId: "anthropic-claude",
        kind: "subscription_oauth",
        label: "Personal",
        enabled: true,
        createdAt: Date.parse("2026-08-01T00:00:00Z"),
      },
    ],
    {},
    { mode: 0o600 },
  );
}

/**
 * One provider's row from the newest persisted snapshot, read the same
 * read-only way a live validation on a real machine reads it. The snapshot IS
 * the app's per-refresh record: a sanitized status and reason code, and never
 * anything a credential could be recovered from.
 */
function readNewestSnapshotRow(
  userDataDir: string,
  provider: string,
): { status: string; reason?: string } | undefined {
  return readSavedData(userDataDir, (db) => {
    const row = db.prepare("SELECT json FROM quota_snapshots ORDER BY id DESC LIMIT 1").get() as
      | { json: string }
      | undefined;
    if (!row) return undefined;
    const snapshot = JSON.parse(row.json) as {
      providers: { provider: string; status: string; reason?: string }[];
    };
    return snapshot.providers.find((entry) => entry.provider === provider);
  });
}

async function openSubscriptions(app: LaunchedApp) {
  await app.page.getByRole("button", { name: "Settings" }).click();
  await app.page.getByRole("tab", { name: "Intelligence" }).click();
}

/**
 * INF-2320: an idle-recovery journey owns that prerequisite. This auth-only
 * stand-in does not answer the model-list protocol. Its settled fallback log
 * is emitted after the catalog reader releases the store slot; opening the
 * tab alone does not mean startup has released it.
 */
async function untilClaudeCatalogSettles(app: LaunchedApp) {
  await expect
    .poll(() => readFileSync(join(app.diagnosticsDir, "main.stderr.log"), "utf8"), {
      timeout: 20_000,
    })
    .toContain(`[models] ${CLAUDE_PROVIDER_ID} model list unavailable`);
}

/** An account's row in Settings → Intelligence, where its allowance shows. */
function accountRow(app: LaunchedApp, accountId: string) {
  return app.page.locator(`[data-account-row="${accountId}"]`);
}

test.describe("the real quota sensor, end to end", () => {
  let app: LaunchedApp | undefined;
  let stub: StubUsage | undefined;
  let meter: StubMeter | undefined;
  let kimi: StubKimi | undefined;
  let copilot: StubCopilot | undefined;
  let keyRead: StubKeyRead | undefined;

  test.afterEach(async () => {
    await app?.close();
    app = undefined;
    // Only a started server can report its close; awaiting an absent one
    // would wait forever.
    for (const server of [
      stub?.server,
      meter?.server,
      kimi?.server,
      copilot?.server,
      keyRead?.server,
    ]) {
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    stub = undefined;
    meter = undefined;
    kimi = undefined;
    copilot = undefined;
    keyRead = undefined;
  });

  test("resolves the account's own store, reads the vendor, and renders real meters", async () => {
    const userDataDir = scratchDir("infinitary-e2e-");
    stub = await startStubUsage(["live-token"]);
    seedAccounts(userDataDir);
    app = await launchApp({
      userDataDir,
      prepareHome: claudeHomeWithCredential("live-token", Date.now() + 3600_000),
      env: {
        INFINITARY_CLAUDE_USAGE_URL: stub.url,
        INFINITARY_CLAUDE_CLI: writeMockClaudeClient(join(userDataDir, "bin")),
      },
    });
    await openSubscriptions(app);
    const row = accountRow(app, CLAUDE_PERSONAL);

    // A real reading, parsed from the vendor's own `limits` shape.
    await expect(row.getByText(claudeWindowLabel("five_hour"), { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(row.getByText(EMPTY_QUOTA_TEXT.notYet)).toHaveCount(0);
    await expect(row.getByText(EMPTY_QUOTA_TEXT.unread)).toHaveCount(0);
    await expect(row.getByText(claudeWindowLabel(UNRELEASED_WINDOW))).toHaveCount(0);
    // The request really carried the account's own stored token.
    expect(stub.seen).toContain("live-token");
  });

  // INF-2318, approved slim step 2: one reading owns the current identity
  // and an unreadable store is stale, never a sign-out. File-backed on both
  // platforms; a local usage server and isolated client/home are its only resources.
  test("a Claude account swap updates the next reading and an unreadable store stays stale", async () => {
    const userDataDir = scratchDir("infinitary-e2e-claude-swap-");
    stub = await startStubUsage(["first-token", "second-token"]);
    seedAccounts(userDataDir);
    app = await launchApp({
      userDataDir,
      prepareHome: quotaIdentityHome(
        "first-token",
        Date.now() + 3600_000,
        "alex.one@example.com",
        "account-one",
        1000,
      ),
      env: {
        INFINITARY_CLAUDE_USAGE_URL: stub.url,
        // Deliberately still names the earlier login after the external swap.
        INFINITARY_CLAUDE_CLI: writeMockClaudeClient(join(userDataDir, "bin"), {
          email: "alex.one@example.com",
          plan: "max",
        }),
      },
    });
    await resizeWindow(app.app, app.page, { width: 1280, height: 800 });
    await openSubscriptions(app);
    const row = accountRow(app, CLAUDE_PERSONAL);
    await expect(row).toContainText("alex.one@example.com");
    await expect(row).toContainText("70%");
    expect(stub.seen).toContain("first-token");

    claudeHomeWithCredential("second-token", Date.now() + 3600_000)(app.homeDir);
    // e2e-claude-store: mutation -- move the credential stamp backwards to prove every changed stamp refreshes
    utimesSync(join(claudeDefaultStore(app.homeDir), ".credentials.json"), 2000, 2000);
    writeClaudeIdentity(app.homeDir, "account-two", "alex.two@example.com", 2000, "personal");
    const refresh = app.page.getByRole("button", { name: "Refresh", exact: true });
    await focusOn(refresh);
    await pressKey(refresh, "Enter");
    await expect(row).toContainText("alex.two@example.com");
    await expect(row).not.toContainText("alex.one@example.com");
    await expect(row).toContainText("70%");
    expect(stub.seen).toContain("second-token");
    const current = await app.page.evaluate(() => window.infinitary.accounts.list());
    expect(current).toContainEqual(
      expect.objectContaining({
        id: CLAUDE_PERSONAL,
        label: "alex.two@example.com",
        identity: "alex.two@example.com",
        connected: true,
      }),
    );
    await regionShot(row, test.info().outputPath("claude-current-identity.png"));
    // The captain chose current identity instead of a name the next read would replace.
    const actions = row.getByRole("button", { name: "alex.two@example.com actions" });
    await focusOn(actions);
    await pressKey(actions, "Enter");
    const menu = app.page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Rename", exact: true })).toHaveCount(0);
    const pause = menu.getByRole("menuitemcheckbox", { name: m.settingsMenuPaused(), exact: true });
    await expect(pause).toBeVisible();
    await regionShot(menu, test.info().outputPath("claude-menu-current-identity.png"));
    await pressKey(pause, "Escape");
    await expect(menu).toHaveCount(0);

    // e2e-claude-store: mutation -- reproduce an incomplete credential rewrite, which must not sign out
    writeFileSync(join(claudeDefaultStore(app.homeDir), ".credentials.json"), "{incomplete");
    await expect(refresh).toBeEnabled();
    await focusOn(refresh);
    await pressKey(refresh, "Enter");
    await expect
      .poll(async () =>
        (await app?.page.evaluate(() => window.infinitary.quota.snapshot()))?.providers.find(
          (provider) => provider.accountId === CLAUDE_PERSONAL,
        ),
      )
      .toMatchObject({ status: "ok", stale: true, reason: "credential_unavailable" });
    await expect(row).toContainText("70%");
    await expect(row).toContainText("alex.two@example.com");
    await expect(row.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0);
    await regionShot(row, test.info().outputPath("claude-unreadable-stale.png"));
  });

  test("an idle rejected token recovers through the account's own client, with no sign-in", async () => {
    const userDataDir = scratchDir("infinitary-e2e-");
    // Let startup finish under the saved sign-in, then reject it while idle.
    stub = await startStubUsage(["expired-token", "renewed-token"]);
    seedAccounts(userDataDir);
    const binDir = join(userDataDir, "bin");
    const client = writeMockClaudeClient(binDir);
    // INF-2320: the idle rejection asks status once, not a command ladder.
    // The stand-in writes its own store on that request, as the installed
    // client may; the request log proves health did not ask it beforehand.
    const requests = join(userDataDir, "refresh-requests.jsonl");
    writeRenewingClaudeClient(binDir, client, requests);
    app = await launchApp({
      userDataDir,
      // INF-2317: even both saved dates passing must reach rejection and renewal.
      prepareHome: claudeHomeWithCredential(
        "expired-token",
        Date.now() - 3600_000,
        Date.now() - 1000,
      ),
      env: {
        INFINITARY_CLAUDE_USAGE_URL: stub.url,
        INFINITARY_CLAUDE_CLI: join(binDir, "renewing-claude.mjs"),
      },
    });
    await openSubscriptions(app);
    const row = accountRow(app, CLAUDE_PERSONAL);

    await expect(row.getByText(claudeWindowLabel("five_hour"), { exact: true })).toBeVisible();
    await untilClaudeCatalogSettles(app);
    const beforeRejection = stub.seen.length;
    stub.accept.delete("expired-token");

    const clientRequests = () =>
      existsSync(requests)
        ? readFileSync(requests, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [];
    try {
      expect(clientRequests()).toEqual([]);
      const refresh = app.page.getByRole("button", { name: "Refresh", exact: true });
      await focusOn(refresh);
      await pressKey(refresh, "Enter");
      await expect
        .poll(() => readNewestSnapshotRow(userDataDir, "claude"))
        .toMatchObject({
          status: "ok",
          reason: "renewal_succeeded",
        });
      await expect(row.getByText(claudeWindowLabel("five_hour"), { exact: true })).toBeVisible();
      expect(stub.seen).toContain("expired-token");
      expect(stub.seen).toContain("renewed-token");
      await expect(row.getByText(EMPTY_QUOTA_TEXT.signInAgain)).toHaveCount(0);
      expect(clientRequests()).toEqual([["auth", "status", "--json"]]);
    } finally {
      // Keep the reason even when the visible allowance never arrives.
      await test.info().attach("idle-refresh-receipt", {
        body: JSON.stringify({
          clientRequests: clientRequests(),
          requests: stub.seen
            .slice(beforeRejection)
            .map((token) =>
              token === "expired-token" ? "rejected saved sign-in" : "accepted replacement",
            ),
          persisted: readNewestSnapshotRow(userDataDir, "claude"),
        }),
        contentType: "application/json",
      });
    }
  });

  test("INF-2317: a passed refresh date still reads the allowance without a sign-in", async () => {
    // Captain's approved expiry fix: Anthropic, not the saved date, decides.
    const userDataDir = scratchDir("infinitary-e2e-");
    stub = await startStubUsage(["lapsed-token"]);
    seedAccounts(userDataDir);
    app = await launchApp({
      userDataDir,
      prepareHome: claudeHomeWithCredential(
        "lapsed-token",
        Date.now() + 3600_000,
        Date.now() - 1000,
      ),
      env: {
        INFINITARY_CLAUDE_USAGE_URL: stub.url,
        INFINITARY_CLAUDE_CLI: writeMockClaudeClient(join(userDataDir, "bin")),
      },
    });
    await openSubscriptions(app);
    const row = accountRow(app, CLAUDE_PERSONAL);
    await expect(row.getByText(claudeWindowLabel("five_hour"), { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(row.getByText(EMPTY_QUOTA_TEXT.signInAgain)).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0);
    await expect(row.getByText(SUBSCRIPTIONS_WORDS.claudeFirstRun)).toHaveCount(0);
    expect(stub.seen).toContain("lapsed-token");
    expect(readNewestSnapshotRow(userDataDir, "claude")).toMatchObject({ status: "ok" });
    expect(
      await app.page.evaluate(async () =>
        (await window.infinitary.cards.list()).map((card) => card.title),
      ),
    ).not.toContain(needsReauthCopy("Claude", "Personal"));
  });

  // INF-2319, approved slim step 3 ("The button signs in."): Sign in shows
  // only once Anthropic refused the saved sign-in after a renewal, and it
  // runs Claude's own login rather than using that sign-in once more.
  // File-backed on both platforms; a local usage server and an isolated
  // client and home are its only resources.
  test("INF-2319: Sign in after Anthropic refuses runs Claude's own login, and the new sign-in reads", async () => {
    const userDataDir = scratchDir("infinitary-e2e-claude-sign-in-");
    stub = await startStubUsage(["refused-token", "fresh-token"]);
    seedAccounts(userDataDir);
    const binDir = join(userDataDir, "bin");
    const client = writeMockClaudeClient(binDir);
    // Anthropic accepts only what Claude's own login writes. The renewal
    // rewrites the store with another token it still refuses, as a login
    // Anthropic signed out does.
    writeRefusedClaudeClient(binDir, client);
    app = await launchApp({
      userDataDir,
      prepareHome: claudeHomeWithCredential("refused-token", Date.now() + 3600_000),
      env: {
        INFINITARY_CLAUDE_USAGE_URL: stub.url,
        INFINITARY_CLAUDE_CLI: join(binDir, "refused-claude.mjs"),
      },
    });
    await openSubscriptions(app);
    const row = accountRow(app, CLAUDE_PERSONAL);
    await expect(row.getByText(claudeWindowLabel("five_hour"), { exact: true })).toBeVisible();
    await untilClaudeCatalogSettles(app);
    stub.accept.delete("refused-token");
    const refresh = app.page.getByRole("button", { name: "Refresh", exact: true });
    await focusOn(refresh);
    await pressKey(refresh, "Enter");
    const signIn = row.getByRole("button", { name: "Sign in", exact: true });
    await expect(row.getByText(EMPTY_QUOTA_TEXT.signInAgain)).toBeVisible({ timeout: 20_000 });
    expect(stub.seen).toContain("refused-token");
    const label = (await app.page.evaluate(() => window.infinitary.accounts.list())).find(
      (account) => account.id === CLAUDE_PERSONAL,
    )?.label;
    const cardTitles = async () =>
      (await app?.page.evaluate(async () =>
        (await window.infinitary.cards.list()).map((card) => card.title),
      )) ?? [];
    expect(await cardTitles()).toContain(needsReauthCopy("Claude", label ?? "account"));

    await focusOn(signIn);
    await pressKey(signIn, "Enter");

    await expect(row.getByText(claudeWindowLabel("five_hour"), { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(signIn).toHaveCount(0);
    await expect(row.getByText(EMPTY_QUOTA_TEXT.signInAgain)).toHaveCount(0);
    expect(stub.seen).toContain("fresh-token");
    await expect.poll(cardTitles).not.toContain(needsReauthCopy("Claude", label ?? "account"));
  });

  test("a vendor that stays down never invents a reading and never claims a sign-out", async () => {
    const userDataDir = scratchDir("infinitary-e2e-");
    // Nothing is accepted, and the client renews nothing: every attempt fails.
    stub = await startStubUsage([]);
    seedAccounts(userDataDir);
    app = await launchApp({
      userDataDir,
      prepareHome: claudeHomeWithCredential("dead-token", Date.now() + 3600_000),
      env: {
        INFINITARY_CLAUDE_USAGE_URL: stub.url,
        INFINITARY_CLAUDE_CLI: writeMockClaudeClient(join(userDataDir, "bin")),
      },
    });
    await openSubscriptions(app);
    const row = accountRow(app, CLAUDE_PERSONAL);

    // The stand-in client rewrites nothing, so the renewal changed nothing:
    // that is not knowing, and it must not read as a finished sign-in.
    await expect(row.getByText(EMPTY_QUOTA_TEXT.unread)).toBeVisible({
      timeout: 20_000,
    });
    await expect(row.getByText(EMPTY_QUOTA_TEXT.signInAgain)).toHaveCount(0);
    // Not knowing is never rendered as a number.
    await expect(row.getByText("%", { exact: false })).toHaveCount(0);
    // The persisted row says WHICH kind of not-knowing it was, and does not
    // claim a renewal that never worked.
    const claudeRow = readNewestSnapshotRow(userDataDir, "claude");
    expect(claudeRow?.status).toBe("unavailable");
    expect(claudeRow?.reason).toMatch(/^renewal_/);
    expect(claudeRow?.reason).not.toBe("renewal_succeeded");
    const titles = await app.page.evaluate(async () =>
      (await window.infinitary.cards.list()).map((card) => card.title),
    );
    // The re-auth words after the composer's provider and account holes, so
    // a sign-out claim for any account or provider is caught.
    const signOutWords = needsReauthCopy("", "")
      .replace(/^ \(\) /, "")
      .replace(/\.$/, "")
      .toLowerCase();
    expect(titles.some((title) => title.toLowerCase().includes(signOutWords))).toBe(false);
  });

  test("a Grok sign-in reads its consumer meter with its own token and renders real meters", async () => {
    // The captain's dogfood defect (2026-09-05): Grok never showed a meter,
    // because the OAuth branch asked nothing that could answer. Now the
    // whole path runs for real - the vault resolves the account's own Pi
    // store, the sensor POSTs the gRPC-web request, the reader decodes the
    // framed config, and Settings renders the windows the way Codex and
    // Claude already do.
    const userDataDir = scratchDir("infinitary-e2e-");
    meter = await startStubMeter(["grok-live-token"]);
    seedGrokAccount(userDataDir, { accessToken: "grok-live-token" });
    app = await launchApp({ userDataDir, env: { INFINITARY_GROK_USAGE_URL: meter.url } });
    await openSubscriptions(app);
    const row = accountRow(app, GROK_PERSONAL);

    const grokBuild = GROK_PRODUCT_LABELS[GROK_BUILD_PRODUCT]?.label as string;
    await expect(row.getByText(grokBuild, { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(row.getByText(GROK_CREDITS_LABEL, { exact: true })).toBeVisible();
    await expect(row.getByText(EMPTY_QUOTA_TEXT.notYet)).toHaveCount(0);
    await expect(row.getByText(EMPTY_QUOTA_TEXT.unread)).toHaveCount(0);
    await expect(row.getByText(GROK_NO_WINDOW_DETAIL)).toHaveCount(0);
    // The request really was the meter's: the account's own stored token,
    // the gRPC-web content type, and the empty request frame.
    expect(meter.seen.length).toBeGreaterThan(0);
    expect(meter.seen[0]).toMatchObject({
      bearer: "grok-live-token",
      contentType: "application/grpc-web+proto",
      body: [0, 0, 0, 0, 0],
    });
    const grokRow = readNewestSnapshotRow(userDataDir, "grok");
    expect(grokRow).toMatchObject({ status: "ok" });
  });

  test("a Grok API key reads its credits from the key read the launch names, never xAI's", async () => {
    // INF-714: a journey's seeded Grok key went to xAI's real key read,
    // because only the OAuth meter's address could be redirected. The key
    // read now takes its own dev/e2e address (INFINITARY_GROK_KEY_URL),
    // which launch.ts points at a closed port for every other journey.
    const userDataDir = scratchDir("infinitary-e2e-");
    keyRead = await startStubKeyRead(["xai-live-key"]);
    seedGrokAccount(userDataDir, { key: "xai-live-key" });
    app = await launchApp({ userDataDir, env: { INFINITARY_GROK_KEY_URL: keyRead.url } });
    await openSubscriptions(app);
    const row = accountRow(app, GROK_PERSONAL);

    await expect(row.getByText(GROK_CREDITS_LABEL, { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(row.getByText(EMPTY_QUOTA_TEXT.notYet)).toHaveCount(0);
    await expect(row.getByText(EMPTY_QUOTA_TEXT.unread)).toHaveCount(0);
    await expect(row.getByText(GROK_NO_WINDOW_DETAIL)).toHaveCount(0);
    expect(keyRead.seen[0]).toEqual({ method: "GET", bearer: "xai-live-key" });
    expect(readNewestSnapshotRow(userDataDir, "grok")).toMatchObject({ status: "ok" });
  });

  test("a Kimi Code sign-in reads its usages meter with its own token and names the plan", async () => {
    // INF-560: Kimi Code is a subscription with an allowance meter. The
    // vault resolves the account's own Pi store, the sensor asks the usages
    // endpoint with that bearer, and the row shows its windows and plan.
    const userDataDir = scratchDir("infinitary-e2e-");
    kimi = await startStubKimi(["kimi-live-token"]);
    seedKimiAccount(userDataDir, "kimi-live-token", Date.now() + 30 * 24 * 3600 * 1000);
    app = await launchApp({ userDataDir, env: { INFINITARY_KIMI_USAGE_URL: kimi.url } });
    await openSubscriptions(app);
    const row = accountRow(app, KIMI_PERSONAL);

    for (const label of ["session", "weekly", "monthly"]) {
      await expect(row.getByText(label, { exact: true })).toBeVisible({ timeout: 20_000 });
    }
    await expect(row.getByText("Allegretto")).toBeVisible();
    await expect(row.getByText(EMPTY_QUOTA_TEXT.notYet)).toHaveCount(0);
    await expect(row.getByText(KIMI_NO_WINDOW_DETAIL)).toHaveCount(0);
    expect(kimi.meterSeen[0]).toBe("kimi-live-token");
    expect(readNewestSnapshotRow(userDataDir, "kimi")).toMatchObject({ status: "ok" });
  });

  test("a Kimi Code account stored before Kimi Code came back loads and asks to sign in again", async () => {
    // INF-560, the captain's answer: "Load them, and let the row say sign
    // in again when the token has lapsed". Pi's own refresh asks the sign-in
    // server, which refuses the lapsed refresh token; the meter is never asked.
    const userDataDir = scratchDir("infinitary-e2e-");
    kimi = await startStubKimi([]);
    seedKimiAccount(userDataDir, "kimi-old-token", Date.parse("2026-08-02T00:00:00Z"));
    app = await launchApp({
      userDataDir,
      env: { INFINITARY_KIMI_USAGE_URL: kimi.url, KIMI_CODE_OAUTH_HOST: kimi.oauthHost },
    });

    await expect
      .poll(async () =>
        app?.page.evaluate(async () =>
          (await window.infinitary.cards.list()).map((card) => card.title),
        ),
      )
      .toContain(needsReauthCopy("Kimi Code", "Personal"));
    await openSubscriptions(app);
    const row = accountRow(app, KIMI_PERSONAL);
    await expect(row.getByText(EMPTY_QUOTA_TEXT.signInAgain)).toBeVisible({ timeout: 20_000 });
    await expect(row.getByRole("button", { name: "Sign in" })).toBeVisible();
    expect(kimi.refreshSeen).toBeGreaterThan(0);
    expect(kimi.meterSeen).toEqual([]);
    expect(readNewestSnapshotRow(userDataDir, "kimi")).toMatchObject({
      status: "auth_required",
      reason: "refresh_token_lapsed",
    });
  });

  test("Copilot accounts from before load: one reads premium requests, a lapsed one asks to sign in again", async () => {
    // INF-560, the captain's answers: Copilot comes back through Pi, and
    // accounts stored before load again, their row saying to sign in again
    // once the token has lapsed.
    const userDataDir = scratchDir("infinitary-e2e-");
    copilot = await startStubCopilot("gho_live");
    seedCopilotAccounts(userDataDir, {
      [COPILOT_LIVE]: "gho_live",
      [COPILOT_LAPSED]: "gho_lapsed",
    });
    app = await launchApp({ userDataDir, env: { INFINITARY_COPILOT_USAGE_URL: copilot.url } });
    await openSubscriptions(app);

    const live = accountRow(app, COPILOT_LIVE);
    await expect(live.getByText(COPILOT_PREMIUM_LABEL, { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(live.getByText(COPILOT_PLAN, { exact: false })).toBeVisible();
    await expect(live.getByText(EMPTY_QUOTA_TEXT.signInAgain)).toHaveCount(0);

    const lapsed = accountRow(app, COPILOT_LAPSED);
    await expect(lapsed.getByText(EMPTY_QUOTA_TEXT.signInAgain)).toBeVisible({ timeout: 20_000 });
    await expect(lapsed.getByRole("button", { name: "Sign in" })).toBeVisible();
    // The meter asked with each account's stored GitHub sign-in, never the
    // Copilot token Pi resolves for requests.
    expect(new Set(copilot.seen)).toEqual(new Set(["gho_live", "gho_lapsed"]));

    // The chip to add another account names Copilot, with no note under it
    // (INF-838, the captain's answer).
    const chip = app.page.locator('[data-connect-provider="github-copilot"]');
    await expect(chip).toHaveText(catalogEntry("github-copilot")?.name as string);
  });
});

test.describe("a CLI proxy's pools, end to end", () => {
  let app: LaunchedApp | undefined;
  let proxy: CliProxyStub | undefined;
  let models: Awaited<ReturnType<typeof startCustomApiFixture>> | undefined;

  test.afterEach(async () => {
    await app?.close();
    app = undefined;
    const server = proxy?.server;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await models?.close();
    proxy = undefined;
    models = undefined;
  });

  test("a connection to the proxy shows its Claude and ChatGPT pools, read with reads alone", async () => {
    // The captain's ask: read the pooled Claude and ChatGPT usage from the
    // proxy Claude Code and the connection send their requests to
    // (docs/quota.md, "A proxy's pooled logins"). The proxy, its settings
    // file and the model server behind it are local stand-ins.
    const userDataDir = scratchDir("infinitary-e2e-proxy-");
    models = await startCustomApiFixture(0);
    proxy = await startCliProxyStub(Number(new URL(models.baseUrl).port));
    app = await launchApp({
      userDataDir,
      env: { INFINITARY_CLI_PROXY_SETTINGS: proxy.writeSettings(userDataDir) },
    });
    const baseUrl = `http://127.0.0.1:${proxy.port}/v1`;
    const accountId = await app.page.evaluate(
      async ({ baseUrl, ids }) => {
        const draft = await window.infinitary.accounts.custom.prepare({
          baseUrl,
          approvedDestination: baseUrl,
          label: "Proxy",
          mode: "local",
          protocol: "openai-completions",
          key: "",
          noKey: true,
          headers: [],
          unencryptedLocalApproved: true,
          allowStorageDefault: false,
          storageApproved: false,
          models: ids.map((id) => ({ id, context: 200000, output: 4096 })),
        });
        for (const id of ids) {
          const checked = await window.infinitary.accounts.custom.check(draft.draftId ?? "", id);
          if (!checked.models.find((model) => model.id === id)?.checked)
            throw new Error(`Fixture model check failed for ${id}`);
        }
        const saved = await window.infinitary.accounts.custom.save(draft.draftId ?? "", false);
        await window.infinitary.quota.refresh();
        return saved.accountId;
      },
      { baseUrl, ids: [CLI_PROXY_MODELS.claude, CLI_PROXY_MODELS.chatgpt] },
    );
    await openSubscriptions(app);
    const block = customApiBlock(app.page, accountId ?? "").block;
    const claude = block.locator('[data-custom-pool="claude"]');
    const chatgpt = block.locator('[data-custom-pool="chatgpt"]');
    await expect(claude).toBeVisible({ timeout: 30_000 });
    await expect(chatgpt).toBeVisible();
    // The stand-in's one Claude login has 38% of its session left, and its
    // one ChatGPT login 88% of its five-hour window.
    await expect(claude.getByText("38%", { exact: false })).toBeVisible();
    await expect(chatgpt.getByText("88%", { exact: false })).toBeVisible();
    // The ChatGPT login says its credits answer, with 15 left: the pool
    // tells it in ChatGPT's words.
    await expect(chatgpt.locator("[data-credits]")).toContainText("Credits: 15 left");
    // Only the proxy's two reads reached its own routes: both logins were
    // read, so nothing was asked through it, and nothing changed it.
    const own = proxy.seen.filter(
      (entry) => / \/v0\//.test(entry) || / \/v8\//.test(entry) || entry === "GET /v1/models",
    );
    expect(new Set(own)).toEqual(new Set(["GET /v8/management/credentials", "GET /v1/models"]));
  });
});
