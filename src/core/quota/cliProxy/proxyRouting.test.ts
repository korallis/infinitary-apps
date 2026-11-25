import type { QuotaSnapshotView } from "@shared/quota";
import { describe, expect, it } from "vitest";
import { Flagship, type FlagshipVaultView } from "../../orchestrator/flagship";
import type { ModelRuntime } from "../../pi/types";
import { AccountSelector } from "../../routing/accountRouter";
import { computerPool, servesOnComputer } from "../../routing/computerPool";
import { PlacedWorkScores } from "../../routing/placedWork";
import { quotaGateCleared } from "../../routing/quotaGate";
import { openInMemoryDatabase } from "../../storage/db";
import { DecisionStore } from "../../storage/decisionStore";
import { SettingsStore } from "../../storage/settingsStore";
import { buildModelsCatalog } from "../catalog";
import type { ProxyReading } from "./proxyPools";
import { type PooledConnection, proxyCatalogModels, proxyConnectionRows } from "./proxyQuota";

// The captain's ask: route and pause by the proxy's one Claude pool and one
// ChatGPT pool (docs/quota.md, "A proxy's pooled logins"). One connection
// serves both pools, so every decision that reads a row for it must read the
// row of the model's own pool: here the Claude pool is spent and the ChatGPT
// pool has 60% left.
const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const PROVIDER = "fm-custom-0123456789abcdef";
const ACCOUNT = "acct_proxy";
const CLAUDE = { provider: PROVIDER, id: "claude-opus-5-5" };
const GPT = { provider: PROVIDER, id: "gpt-5.5" };
const CONNECTION: PooledConnection = {
  accountId: ACCOUNT,
  accountLabel: "Proxy",
  providerId: PROVIDER,
  baseUrl: "http://127.0.0.1:8317/v1",
  modelIds: [CLAUDE.id, GPT.id],
};
const reading: ProxyReading = {
  status: "ok",
  port: 8317,
  atMs: NOW,
  modelPools: new Map([
    [CLAUDE.id, "claude"],
    [GPT.id, "chatgpt"],
  ]),
  logins: [
    { kind: "claude", state: "spent", backAtMs: NOW + 3 * HOUR },
    {
      kind: "chatgpt",
      state: "serving",
      windows: [
        { id: "weekly", label: "weekly", percentRemaining: 60, resetsAtMs: NOW + 50 * HOUR },
      ],
    },
  ],
};

/** The connection's rows, in either order: the decisions never read by order. */
function snapshotOf(order: "claude-first" | "chatgpt-first"): QuotaSnapshotView {
  const rows = proxyConnectionRows(reading, [CONNECTION], NOW);
  return {
    generatedAt: new Date(NOW).toISOString(),
    fetchedAt: NOW,
    providers: order === "claude-first" ? rows : [...rows].reverse(),
  };
}

const ORDERS = ["claude-first", "chatgpt-first"] as const;

describe("a connection serving a spent Claude pool and a ChatGPT pool with allowance left", () => {
  it.each(ORDERS)("the account selector serves only the ChatGPT model (%s)", (order) => {
    const latest = snapshotOf(order);
    const selector = new AccountSelector({
      pool: {
        list: () => [{ id: ACCOUNT, providerId: PROVIDER, label: "Proxy", enabled: true }],
        pinnedAccount: () => undefined,
        connectedSync: () => true,
        withheldReason: () => undefined,
        markSelected: () => {},
      },
      quota: { latest: () => latest },
      flagshipAccountId: () => null,
      decisions: new DecisionStore(openInMemoryDatabase()),
    });
    expect(selector.servesNow(ACCOUNT, CLAUDE)).toBe(false);
    expect(selector.servesNow(ACCOUNT, GPT)).toBe(true);
  });

  it.each(ORDERS)("the router ranks each model by its own pool (%s)", (order) => {
    const latest = snapshotOf(order);
    const db = openInMemoryDatabase();
    try {
      const scores = new PlacedWorkScores(db, new SettingsStore(db));
      const models = buildModelsCatalog(
        proxyCatalogModels(reading, [CONNECTION]),
        latest.providers,
        latest.generatedAt,
        NOW,
      ).models;
      const ranked = scores.catalog(models, latest.providers, NOW, () => ACCOUNT, scores.data(NOW));
      const percent = (id: string) =>
        ranked.find((model) => model.id === id)?.effectivePercentRemaining;
      expect(percent(CLAUDE.id)).toBe(0);
      expect(percent(GPT.id)).toBe(60);
    } finally {
      db.close();
    }
  });

  it.each(ORDERS)("a computer bound to it serves only the ChatGPT model (%s)", (order) => {
    const latest = snapshotOf(order);
    const pool = computerPool(
      "Mac mini",
      {
        providers: [],
        accounts: [
          {
            id: ACCOUNT,
            providerId: PROVIDER,
            kind: "api_key",
            label: "Proxy",
            enabled: true,
            connected: true,
            pinned: false,
            createdAt: 1,
          },
        ],
        quota: latest,
      },
      [
        { ...CLAUDE, name: "Claude Opus 5.5" },
        { ...GPT, name: "GPT-5.5" },
      ],
      NOW,
    );
    const listed = {
      ...pool,
      servedBy: new Map([
        [`${PROVIDER}/${CLAUDE.id}`, new Set([ACCOUNT])],
        [`${PROVIDER}/${GPT.id}`, new Set([ACCOUNT])],
      ]),
    };
    expect(servesOnComputer(listed, ACCOUNT, CLAUDE, NOW)).toBe(false);
    expect(servesOnComputer(listed, ACCOUNT, GPT, NOW)).toBe(true);
  });

  it.each(ORDERS)(
    "a quota-reset gate on a slot clears only through the ChatGPT model (%s)",
    (order) => {
      const latest = snapshotOf(order);
      const catalog = buildModelsCatalog(
        proxyCatalogModels(reading, [CONNECTION]),
        latest.providers,
        latest.generatedAt,
        NOW,
      );
      const reads = (available: { provider: string; id: string }[]) => ({
        availableModels: () => available,
        slotsOf: () => ["premium" as const],
        quota: { latest: () => latest, latestModels: () => catalog },
      });
      expect(quotaGateCleared("bucket:premium", reads([CLAUDE]))).toBe(false);
      expect(quotaGateCleared("bucket:premium", reads([GPT]))).toBe(true);
    },
  );

  it.each(ORDERS)(
    "the first mate's seat pauses on the Claude model and not on the ChatGPT one (%s)",
    (order) => {
      const latest = snapshotOf(order);
      const seat = (model: { provider: string; id: string }) =>
        new Flagship({
          vault: seatVault(),
          settings: {
            getFirstmateAccount: () => ACCOUNT,
            setFirstmateAccount: () => {},
            getFirstmateModel: () => model,
          },
          quota: { latest: () => latest },
          baseRuntime: { kind: "base" } as unknown as ModelRuntime,
        });
      expect(seat(CLAUDE).pause(ACCOUNT)).toEqual({ class: "no_headroom" });
      expect(seat(CLAUDE).headroom(ACCOUNT)).toBe(0);
      expect(seat(GPT).pause(ACCOUNT)).toBe(undefined);
      expect(seat(GPT).headroom(ACCOUNT)).toBe(60);
    },
  );
});

function seatVault(): FlagshipVaultView {
  const account = { id: ACCOUNT, providerId: PROVIDER, label: "Proxy", enabled: true };
  return {
    list: () => [account],
    get: (id) => (id === ACCOUNT ? account : undefined),
    connectedSync: () => true,
    servesSync: () => true,
    withheldReason: () => undefined,
    withheldDetail: () => undefined,
    keepsGoingOnCredits: () => false,
    cutOff: () => undefined,
    tryAgain: () => false,
    runtimeFor: async () => ({ kind: "runtime" }) as unknown as ModelRuntime,
    binding: () => ({ via: "pi-runtime" }),
  };
}
