import type { QuotaSnapshotView } from "@shared/quota";
import { allowanceSpent } from "@shared/quotaSignals";
import { describe, expect, it } from "vitest";
import { buildModelsCatalog } from "../catalog";
import type { ProxyReading } from "./proxyPools";
import {
  type PooledConnection,
  poolOutcome,
  projectProxyRows,
  proxyCatalogModels,
  proxyConnectionRows,
} from "./proxyQuota";

// The captain's ask: show, route and pause by the proxy's one Claude pool
// and one ChatGPT pool (docs/quota.md, "A proxy's pooled logins").
const NOW = Date.parse("2026-11-25T16:40:00Z");
const HOUR = 60 * 60 * 1000;
const CONNECTION: PooledConnection = {
  accountId: "acct_proxy",
  accountLabel: "Proxy",
  providerId: "fm-custom-0123456789abcdef",
  baseUrl: "http://127.0.0.1:8317/v1",
  modelIds: ["claude-opus-5-5", "gpt-5.5", "grok-5"],
};

const reading: ProxyReading = {
  status: "ok",
  origins: ["http://127.0.0.1:8317"],
  atMs: NOW,
  modelPools: new Map([
    ["claude-opus-5-5", "claude"],
    ["gpt-5.5", "chatgpt"],
  ]),
  logins: [
    { kind: "claude", state: "spent", backAtMs: NOW + 3 * HOUR },
    { kind: "claude", state: "spent", backAtMs: NOW + 9 * HOUR },
    {
      kind: "chatgpt",
      state: "serving",
      windows: [
        { id: "weekly", label: "weekly", percentRemaining: 60, resetsAtMs: NOW + 50 * HOUR },
      ],
    },
  ],
};

describe("proxyConnectionRows", () => {
  it("gives a connection to the proxy one row per pool its models are served from", () => {
    const rows = proxyConnectionRows(reading, [CONNECTION]);
    expect(rows.map((row) => [row.provider, row.accountId, row.pool?.kind])).toEqual([
      ["fm-custom-0123456789abcdef", "acct_proxy", "claude"],
      ["fm-custom-0123456789abcdef", "acct_proxy", "chatgpt"],
    ]);
    expect(rows[0]?.windows).toEqual([
      expect.objectContaining({ percentRemaining: 0, resetsAtMs: NOW + 3 * HOUR }),
    ]);
    expect(rows[1]?.windows).toEqual([expect.objectContaining({ percentRemaining: 60 })]);
  });

  it("gives a connection elsewhere no row", () => {
    expect(
      proxyConnectionRows(reading, [{ ...CONNECTION, baseUrl: "https://api.example.com/v1" }]),
    ).toEqual([]);
  });

  it("gives a connection to a proxy that did not answer one unread row", () => {
    const rows = proxyConnectionRows(
      {
        status: "unavailable",
        origins: ["http://127.0.0.1:8317"],
        reason: "connection_refused",
        atMs: NOW,
      },
      [CONNECTION],
    );
    expect(rows).toEqual([
      expect.objectContaining({ status: "unavailable", windows: [], reason: "connection_refused" }),
    ]);
  });
});

describe("a model list the proxy did not give", () => {
  // The review's finding: without the list the proxy names no pool for the
  // connection's models, so the connection's one row says why and no model
  // is weighed by a pool it may not belong to.
  const { modelPools: _modelPools, ...unlisted } = reading;
  const noList: ProxyReading = { ...unlisted, modelsFailure: "models_http_503" };

  it("gives the connection one unread row saying why", () => {
    expect(proxyConnectionRows(noList, [CONNECTION])).toEqual([
      expect.objectContaining({
        accountId: "acct_proxy",
        status: "unavailable",
        windows: [],
        reason: "models_http_503",
        fromProxy: true,
      }),
    ]);
  });

  it("puts none of the connection's models under a pool", () => {
    expect(proxyCatalogModels(noList, [CONNECTION])).toEqual([]);
  });
});

describe("the catalog over the pools", () => {
  it("takes a spent pool's models out of routing and leaves the other pool's in", () => {
    const catalog = buildModelsCatalog(
      proxyCatalogModels(reading, [CONNECTION]),
      proxyConnectionRows(reading, [CONNECTION]),
      new Date(NOW).toISOString(),
      NOW,
    );
    const spent = Object.fromEntries(
      catalog.models.map((model) => [model.id, allowanceSpent(model)]),
    );
    // grok-5 belongs to no pool: it has no row, and its slot alone admits it.
    expect(spent).toEqual({ "claude-opus-5-5": true, "gpt-5.5": false });
  });
});

describe("poolOutcome", () => {
  it("serves the Claude pool to Claude Code set up to send its requests to the proxy", () => {
    const outcome = poolOutcome(reading, "claude", "http://127.0.0.1:8317");
    expect(outcome).toMatchObject({ status: "ok", pool: { kind: "claude", logins: 2, spent: 2 } });
  });

  it("serves nothing to an address that is not the proxy", () => {
    expect(poolOutcome(reading, "claude", "https://api.anthropic.com")).toBe(undefined);
  });

  // The review's finding: the proxy listens on IPv4 loopback here, so a
  // service on the same port of IPv6 loopback is not the proxy, for Claude
  // Code and for a connection alike.
  it("serves nothing to the proxy's port on the other loopback family", () => {
    expect(poolOutcome(reading, "claude", "http://[::1]:8317")).toBe(undefined);
    const elsewhere = { ...CONNECTION, baseUrl: "http://[::1]:8317/v1" };
    expect(proxyConnectionRows(reading, [elsewhere])).toEqual([]);
    expect(proxyCatalogModels(reading, [elsewhere])).toEqual([]);
  });
});

describe("projectProxyRows", () => {
  const CLAUDE_ROW = "claude";
  const access = { address: "http://127.0.0.1:8317", source: "claude-settings" as const };
  // One Claude login with 75% of its session left, until two hours on.
  const claudeReading: ProxyReading = {
    status: "ok",
    origins: ["http://127.0.0.1:8317"],
    atMs: NOW,
    modelPools: new Map(),
    logins: [
      {
        kind: "claude",
        state: "serving",
        windows: [
          { id: "five_hour", label: "5h", percentRemaining: 75, resetsAtMs: NOW + 2 * HOUR },
        ],
      },
    ],
  };
  // A session's refusal of the five-hour window, until an hour on.
  const refusal = {
    windowId: "five_hour",
    status: "rejected" as const,
    resetsAt: NOW + HOUR,
    at: NOW - 60_000,
  };
  // The account's row as an ordinary refresh leaves it: the access says it
  // is not measured, and the session's refusal and credits laid over it.
  const refreshed: QuotaSnapshotView = {
    generatedAt: new Date(NOW).toISOString(),
    fetchedAt: NOW,
    providers: [
      {
        provider: CLAUDE_ROW,
        label: "Claude",
        accountId: "acct_claude",
        status: "ok" as const,
        stale: false,
        credits: { state: "available" as const },
        windows: [{ id: "five_hour", label: "5h", percentRemaining: 0, resetsAtMs: NOW + HOUR }],
      },
    ],
  };
  const project = (
    snapshot: QuotaSnapshotView,
    claudeAccess: typeof access | undefined,
    refusals: (typeof refusal)[],
    readThroughAccess = true,
  ) =>
    projectProxyRows(snapshot, {
      reading: claudeReading,
      claudeAccess,
      claudeRowId: CLAUDE_ROW,
      readThroughAccess: () => readThroughAccess,
      connections: [],
      refusalsOf: () => refusals,
      nowMs: NOW,
    });

  // The review's finding: a session's refusal holds on the pooled row as on
  // any sensed row, whether the row comes from a refresh or the minute's
  // own reading, and no session's credits are laid over the pool.
  it("keeps a session's refusal on the Claude pool, after a refresh and on the next minute", () => {
    const afterRefresh = project(refreshed, access, [refusal]);
    const nextMinute = project(afterRefresh, access, [refusal]);
    for (const snapshot of [afterRefresh, nextMinute]) {
      const row = snapshot.providers[0];
      expect(row).toMatchObject({ fromProxy: true, pool: { kind: "claude", read: 1 } });
      expect(row?.windows).toEqual([
        expect.objectContaining({ id: "five_hour", percentRemaining: 0, resetsAtMs: NOW + HOUR }),
      ]);
      expect(row).not.toHaveProperty("credits");
    }
  });

  it("shows the pool's own reading once no refusal holds", () => {
    expect(project(refreshed, access, []).providers[0]?.windows).toEqual([
      expect.objectContaining({ id: "five_hour", percentRemaining: 75 }),
    ]);
  });

  // The review's finding: once Claude Code's access is removed, the pool is
  // no longer the account's allowance and neither shows nor pauses it.
  it("takes the pool off the account once Claude Code's access is removed", () => {
    const pooled = project(refreshed, access, []);
    const row = project(pooled, undefined, []).providers[0];
    expect(row).toMatchObject({ status: "unavailable", windows: [] });
    expect(row).not.toHaveProperty("pool");
    expect(row).not.toHaveProperty("fromProxy");
  });

  it("leaves an account's own reading alone while no access is set up", () => {
    const direct = {
      ...refreshed,
      providers: [
        {
          provider: CLAUDE_ROW,
          label: "Claude",
          accountId: "acct_claude",
          status: "ok" as const,
          stale: false,
          windows: [{ id: "five_hour", label: "5h", percentRemaining: 40 }],
        },
      ],
    };
    expect(project(direct, undefined, []).providers).toEqual(direct.providers);
  });

  // The review's finding: once an ordinary refresh read the account's own
  // sign-in, an access the minute's reading still holds never replaces it.
  it("keeps a fresh reading of the account's own sign-in over an access read earlier", () => {
    const direct = {
      ...refreshed,
      providers: [
        {
          provider: CLAUDE_ROW,
          label: "Claude",
          accountId: "acct_claude",
          status: "ok" as const,
          stale: false,
          windows: [{ id: "five_hour", label: "5h", percentRemaining: 40 }],
        },
      ],
    };
    expect(project(direct, access, [], false).providers).toEqual(direct.providers);
  });
});
