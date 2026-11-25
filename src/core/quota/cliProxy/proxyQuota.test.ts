import { allowanceSpent } from "@shared/quotaSignals";
import { describe, expect, it } from "vitest";
import { buildModelsCatalog } from "../catalog";
import type { ProxyReading } from "./proxyPools";
import {
  type PooledConnection,
  poolOutcome,
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
  port: 8317,
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
    const rows = proxyConnectionRows(reading, [CONNECTION], NOW);
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
      proxyConnectionRows(reading, [{ ...CONNECTION, baseUrl: "https://api.example.com/v1" }], NOW),
    ).toEqual([]);
  });

  it("gives a connection to a proxy that did not answer one unread row", () => {
    const rows = proxyConnectionRows(
      { status: "unavailable", port: 8317, reason: "connection_refused", atMs: NOW },
      [CONNECTION],
      NOW,
    );
    expect(rows).toEqual([
      expect.objectContaining({ status: "unavailable", windows: [], reason: "connection_refused" }),
    ]);
  });
});

describe("the catalog over the pools", () => {
  it("takes a spent pool's models out of routing and leaves the other pool's in", () => {
    const catalog = buildModelsCatalog(
      proxyCatalogModels(reading, [CONNECTION]),
      proxyConnectionRows(reading, [CONNECTION], NOW),
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
    const outcome = poolOutcome(reading, "claude", "http://localhost:8317", NOW);
    expect(outcome).toMatchObject({ status: "ok", pool: { kind: "claude", logins: 2, spent: 2 } });
  });

  it("serves nothing to an address that is not the proxy", () => {
    expect(poolOutcome(reading, "claude", "https://api.anthropic.com", NOW)).toBe(undefined);
  });
});
