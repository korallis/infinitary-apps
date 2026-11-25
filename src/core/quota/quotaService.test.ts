import type { QuotaSnapshotView } from "@shared/quota";
import { describe, expect, it, vi } from "vitest";
import { openInMemoryDatabase } from "../storage/db";
import type { ProxyReading } from "./cliProxy/proxyPools";
import { proxyConnectionRows } from "./cliProxy/proxyQuota";
import { claudeAccessOutcome } from "./outcome";
import { mergeStaleProviders, QuotaService } from "./quotaService";

const SNAPSHOT: QuotaSnapshotView = {
  generatedAt: "2026-08-13T20:00:00Z",
  fetchedAt: 1000,
  providers: [
    {
      provider: "claude",
      label: "Claude",
      plan: "Max 20x",
      account: "kun@example.com",
      status: "ok",
      stale: false,
      windows: [
        {
          id: "session",
          label: "session",
          percentRemaining: 74,
          resetText: "resets 3pm",
          pace: "ahead",
        },
        { id: "weekly", label: "weekly", percentRemaining: 62, pace: "on_pace" },
      ],
    },
    {
      provider: "grok",
      label: "Grok",
      status: "auth_required",
      stale: true,
      windows: [],
    },
  ],
};

const CATALOG = {
  generatedAt: "2026-08-13T20:00:00Z",
  models: [
    {
      provider: "claude",
      id: "claude-opus-4-5",
      label: "opus 4.5",
      effectivePercentRemaining: 62,
      paceStatus: "unknown" as const,
    },
    {
      provider: "codex",
      id: "gpt-5.5",
      label: "gpt-5.5",
    },
  ],
};

describe("QuotaService", () => {
  it("persists snapshots, restores the latest on boot, and single-flights refreshes", async () => {
    const db = openInMemoryDatabase();
    const broadcast = vi.fn();
    const refresh = vi.fn(async () => ({ snapshot: SNAPSHOT, catalog: CATALOG }));
    const service = new QuotaService({ refresh, db, broadcast, now: () => 5000 });
    const [a, b] = await Promise.all([service.refresh("demand"), service.refresh("demand")]);
    expect(a).toBe(b);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(service.latest()?.providers).toHaveLength(2);
    expect(service.latestModels()?.models).toHaveLength(2);

    const restored = new QuotaService({ refresh, db, broadcast });
    expect(restored.latest()?.generatedAt).toBe("2026-08-13T20:00:00Z");
  });

  // The review's finding on a CLI proxy (docs/quota.md, "A proxy's pooled
  // logins"): the proxy is read on its own clock, never holding up a
  // refresh, and its last reading stays laid over each refresh.
  it("lays the local reading over the snapshot without holding up a refresh", async () => {
    const db = openInMemoryDatabase();
    const broadcast = vi.fn();
    const refresh = vi.fn(async () => ({ snapshot: SNAPSHOT, catalog: CATALOG }));
    let answer: (() => void) | undefined;
    const proxyRow = {
      provider: "fm-custom-0123456789abcdef",
      label: "Proxy",
      accountId: "acct_proxy",
      status: "ok" as const,
      stale: false,
      fromProxy: true as const,
      windows: [{ id: "weekly", label: "weekly", percentRemaining: 60 }],
    };
    const service = new QuotaService({
      refresh,
      db,
      broadcast,
      catalogFor: () => CATALOG,
      localReading: {
        everyMs: 60_000,
        run: async () => {
          await new Promise<void>((resolve) => {
            answer = resolve;
          });
          return (snapshot) => ({ ...snapshot, providers: [...snapshot.providers, proxyRow] });
        },
      },
      now: () => 5000,
    });
    await service.refresh("demand");
    expect(service.latest()?.providers.map((row) => row.provider)).toEqual(["claude", "grok"]);
    answer?.();
    await vi.waitFor(() =>
      expect(service.latest()?.providers.map((row) => row.provider)).toEqual([
        "claude",
        "grok",
        "fm-custom-0123456789abcdef",
      ]),
    );
    expect(broadcast).toHaveBeenCalledTimes(2);
    // The next refresh keeps the proxy's row from its first broadcast.
    const next = service.refresh("demand");
    await next;
    expect(
      broadcast.mock.calls[2]?.[0].providers.map((row: { provider: string }) => row.provider),
    ).toEqual(["claude", "grok", "fm-custom-0123456789abcdef"]);
    answer?.();
  });

  // The review's finding: the proxy is read every minute, and a reading that
  // changes no row tells no surface.
  it("publishes a local reading only when it changes a row", async () => {
    const db = openInMemoryDatabase();
    const broadcast = vi.fn();
    let percentRemaining = 60;
    const service = new QuotaService({
      refresh: async () => ({ snapshot: SNAPSHOT, catalog: CATALOG }),
      db,
      broadcast,
      catalogFor: () => CATALOG,
      localReading: {
        everyMs: 60_000,
        // As the proxy's projection does, it makes its row again over any
        // it laid before.
        run: async () => (snapshot) => ({
          ...snapshot,
          providers: [
            ...snapshot.providers.filter((row) => !row.fromProxy),
            {
              provider: "fm-custom-0123456789abcdef",
              label: "Proxy",
              accountId: "acct_proxy",
              status: "ok" as const,
              stale: false,
              fromProxy: true as const,
              windows: [{ id: "weekly", label: "weekly", percentRemaining }],
            },
          ],
        }),
      },
      now: () => 5000,
    });
    // The refresh publishes, then reads the proxy at once, which adds its row.
    await service.refresh("demand");
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledTimes(2));
    await service.readLocal();
    expect(broadcast).toHaveBeenCalledTimes(2);
    percentRemaining = 55;
    await service.readLocal();
    expect(broadcast).toHaveBeenCalledTimes(3);
    expect(service.latest()?.providers.at(-1)?.windows[0]?.percentRemaining).toBe(55);
  });

  it("reads the saved snapshot at start with the switches as they stand now", async () => {
    // docs/quota.md "Keep going on credits": a switch turned off before a
    // restart spends no credits on the saved snapshot's old mark.
    const db = openInMemoryDatabase();
    const broadcast = vi.fn();
    const on = (snapshot: QuotaSnapshotView): QuotaSnapshotView => ({
      ...snapshot,
      providers: snapshot.providers.map((row) => ({ ...row, keepGoingOnCredits: true })),
    });
    const off = (snapshot: QuotaSnapshotView): QuotaSnapshotView => ({
      ...snapshot,
      providers: snapshot.providers.map(({ keepGoingOnCredits: _was, ...row }) => row),
    });
    const refresh = vi.fn(async () => ({ snapshot: SNAPSHOT, catalog: CATALOG }));
    const before = new QuotaService({ refresh, db, broadcast, stamp: on });
    await before.refresh("demand");
    expect(before.latest()?.providers[0]?.keepGoingOnCredits).toBe(true);

    const restarted = new QuotaService({ refresh, db, broadcast, stamp: off });
    expect(restarted.latest()?.providers[0]?.keepGoingOnCredits).toBeUndefined();
  });

  it("rebuilds the model catalog over the last snapshot without fetching, and re-pushes it", async () => {
    // docs/model-lists.md: a runtime catalog read landed a model the catalog
    // had no row for, so routing could neither name nor pick it.
    const db = openInMemoryDatabase();
    const broadcast = vi.fn();
    const refresh = vi.fn(async () => ({ snapshot: SNAPSHOT, catalog: CATALOG }));
    let served = CATALOG.models;
    const service = new QuotaService({
      refresh,
      db,
      broadcast,
      catalogFor: (snapshot) => ({ generatedAt: snapshot.generatedAt, models: served }),
    });
    service.recatalog();
    expect(broadcast).not.toHaveBeenCalled();
    await service.refresh("startup");
    served = [...CATALOG.models, { provider: "xai", id: "grok-4.8", label: "Grok 4.8" }];
    service.recatalog();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(service.latestModels()?.models.map((model) => model.id)).toContain("grok-4.8");
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  it("keeps the last snapshot when the refresh throws", async () => {
    const db = openInMemoryDatabase();
    let fail = false;
    const refresh = vi.fn(async () => {
      if (fail) throw new Error("network down");
      return { snapshot: SNAPSHOT, catalog: CATALOG };
    });
    const service = new QuotaService({ refresh, db, broadcast: () => {} });
    await service.refresh("demand");
    fail = true;
    const snapshot = await service.refresh("demand");
    expect(snapshot?.providers).toHaveLength(2);
  });

  it("a demand refresh chains after an in-flight background tick instead of being swallowed", async () => {
    const db = openInMemoryDatabase();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reasons: string[] = [];
    const refresh = vi.fn(async (reason?: string) => {
      reasons.push(reason ?? "");
      if (reasons.length === 1) await gate;
      return { snapshot: SNAPSHOT, catalog: CATALOG };
    });
    const service = new QuotaService({ refresh, db, broadcast: () => {}, now: () => 5000 });
    const background = service.refresh("interval");
    const demand = service.refresh("demand");
    release();
    const [fromBackground, fromDemand] = await Promise.all([background, demand]);
    expect(refresh.mock.calls.map((call) => call[0])).toEqual(["interval", "demand"]);
    expect(fromBackground).toBeDefined();
    expect(fromDemand).toBeDefined();
  });
  // INF-1079: after a switch of the machine's Claude login, the old login's
  // spent reading must not stand in for the new one's.
  it("takes a changed login's reading after one in flight, and never carries the old login's forward", async () => {
    const db = openInMemoryDatabase();
    const row = (status: "ok" | "unavailable", percent?: number) => ({
      provider: "claude",
      label: "Claude",
      accountId: "c1",
      status,
      stale: false,
      windows:
        percent === undefined
          ? []
          : [{ id: "five_hour", label: "session", percentRemaining: percent }],
    });
    const answers = [row("ok", 0), row("unavailable"), row("unavailable"), row("ok", 80)];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reasons: string[] = [];
    const refresh = vi.fn(async (reason?: string) => {
      reasons.push(reason ?? "");
      if (reasons.length === 2) await gate;
      const provider = answers[reasons.length - 1] ?? row("unavailable");
      return {
        snapshot: { generatedAt: "t", fetchedAt: 5000, providers: [provider] },
        catalog: CATALOG,
      };
    });
    const service = new QuotaService({ refresh, db, broadcast: () => {}, now: () => 5000 });
    await service.refresh("startup");

    // A read that could not be taken keeps the last reading - the same login's.
    const kept = service.refresh("interval");
    service.forgetAccount("c1");
    const changed = service.refresh("account-changed");
    release();
    await kept;
    // The login changed: the old login's 0% is not this account's any more.
    expect(service.latest()?.providers[0]).toMatchObject({ status: "unavailable", windows: [] });
    await changed;
    expect(reasons).toEqual(["startup", "interval", "account-changed"]);
    expect(await service.refresh("demand")).toMatchObject({
      providers: [{ status: "ok", windows: [{ percentRemaining: 80 }] }],
    });
  });
});

describe("mergeStaleProviders", () => {
  it("does not revive auth_required from a previous ok card", () => {
    const next: QuotaSnapshotView = {
      generatedAt: "later",
      fetchedAt: 2000,
      providers: [
        { provider: "claude", label: "Claude", status: "auth_required", stale: false, windows: [] },
      ],
    };
    expect(mergeStaleProviders(next, SNAPSHOT).providers[0]?.status).toBe("auth_required");
  });

  const emptyRow = (status: QuotaSnapshotView["providers"][number]["status"], reason?: string) => ({
    generatedAt: "later",
    fetchedAt: 2000,
    providers: [
      {
        provider: "claude",
        label: "Claude",
        status,
        stale: false,
        windows: [],
        ...(reason ? { reason } : {}),
      },
    ],
  });

  it.each(["unavailable", "rate_limited", "not_measured"] as const)(
    "keeps a real reading through a %s pass instead of wiping the card",
    (status) => {
      const merged = mergeStaleProviders(emptyRow(status, "timeout"), SNAPSHOT, 3000);
      expect(merged.providers[0]).toMatchObject({
        status: "ok",
        stale: true,
        reason: "timeout",
        // The row states when the windows it is showing were measured, rather
        // than borrowing the new snapshot's fetch time.
        measuredAt: 1000,
      });
      expect(merged.providers[0]?.windows).toHaveLength(2);
    },
  );

  // The captain's answer on INF-3449: an account that switches to access set
  // up for Claude Code on update has its allowance no longer measured, so the
  // subscription's last reading is not carried onto it.
  it("carries no subscription reading onto a Claude account now on access set up for Claude Code", () => {
    const outcome = claudeAccessOutcome("claude-settings");
    const next: QuotaSnapshotView = {
      generatedAt: "later",
      fetchedAt: 2000,
      providers: [{ provider: "claude", label: "Claude", stale: false, ...outcome }],
    };
    const merged = mergeStaleProviders(next, SNAPSHOT, 3000);
    expect(merged.providers[0]).toMatchObject({
      status: "not_measured",
      windows: [],
      detail: outcome.detail,
    });
  });

  it("drops a carried-forward window whose own reset has already passed", () => {
    const previous: QuotaSnapshotView = {
      generatedAt: "earlier",
      fetchedAt: 1000,
      providers: [
        {
          provider: "claude",
          label: "Claude",
          status: "ok",
          stale: false,
          measuredAt: 1000,
          windows: [
            { id: "session", label: "session", percentRemaining: 20, resetsAtMs: 2500 },
            { id: "weekly", label: "weekly", percentRemaining: 62, resetsAtMs: 9000 },
          ],
        },
      ],
    };
    const merged = mergeStaleProviders(emptyRow("unavailable"), previous, 3000);
    expect(merged.providers[0]?.windows.map((window) => window.id)).toEqual(["weekly"]);
  });

  it("never borrows a sibling account's windows", () => {
    const previous: QuotaSnapshotView = {
      generatedAt: "earlier",
      fetchedAt: 1000,
      providers: [
        {
          provider: "claude",
          label: "Claude",
          accountId: "acct_a",
          status: "ok",
          stale: false,
          windows: [{ id: "session", label: "session", percentRemaining: 40 }],
        },
      ],
    };
    const next: QuotaSnapshotView = {
      generatedAt: "later",
      fetchedAt: 2000,
      providers: [
        {
          provider: "claude",
          label: "Claude",
          accountId: "acct_b",
          status: "unavailable",
          stale: false,
          windows: [],
        },
      ],
    };
    expect(mergeStaleProviders(next, previous, 3000).providers[0]?.windows).toEqual([]);
  });

  // The review's finding on a CLI proxy's rows (docs/quota.md, "A proxy's
  // pooled logins"): a proxy that did not answer keeps each pool's last
  // reading apart, and never takes a direct sign-in's windows.
  describe("a CLI proxy's rows", () => {
    const connection = {
      accountId: "acct_proxy",
      accountLabel: "Proxy",
      providerId: "fm-custom-0123456789abcdef",
      baseUrl: "http://127.0.0.1:8317/v1",
      modelIds: ["claude-opus-5-5", "gpt-5.5"],
    };
    const answered: ProxyReading = {
      status: "ok",
      origins: ["http://127.0.0.1:8317"],
      atMs: 1000,
      modelPools: new Map([
        ["claude-opus-5-5", "claude"],
        ["gpt-5.5", "chatgpt"],
      ]),
      logins: [
        {
          kind: "claude",
          state: "serving",
          windows: [{ id: "five_hour", label: "5h", percentRemaining: 30, resetsAtMs: 9000 }],
        },
        {
          kind: "chatgpt",
          state: "serving",
          windows: [{ id: "weekly", label: "weekly", percentRemaining: 70, resetsAtMs: 9000 }],
        },
      ],
    };
    const silent: ProxyReading = {
      status: "unavailable",
      origins: ["http://127.0.0.1:8317"],
      reason: "connection_refused",
      atMs: 2000,
    };
    const snapshotOf = (fetchedAt: number, providers: QuotaSnapshotView["providers"]) => ({
      generatedAt: String(fetchedAt),
      fetchedAt,
      providers,
    });

    it("keeps both pools' last readings, each under its own pool, when the proxy stops answering", () => {
      const previous = snapshotOf(1000, proxyConnectionRows(answered, [connection]));
      const next = snapshotOf(2000, proxyConnectionRows(silent, [connection]));
      const merged = mergeStaleProviders(next, previous, 3000).providers;
      expect(
        merged.map((row) => [row.pool?.kind, row.stale, row.windows[0]?.percentRemaining]),
      ).toEqual([
        ["claude", true, 30],
        ["chatgpt", true, 70],
      ]);
      expect(merged.every((row) => row.reason === "connection_refused")).toBe(true);
    });

    // The review's finding: a model list the proxy did not give keeps the
    // pools' last readings, marked stale, instead of dropping them.
    it("keeps both pools' last readings when the proxy's model list cannot be read", () => {
      const { modelPools: _modelPools, ...unlisted } = answered;
      const previous = snapshotOf(1000, proxyConnectionRows(answered, [connection]));
      const next = snapshotOf(
        2000,
        proxyConnectionRows({ ...unlisted, atMs: 2000, modelsFailure: "models_http_503" }, [
          connection,
        ]),
      );
      const merged = mergeStaleProviders(next, previous, 3000).providers;
      expect(merged.map((row) => [row.pool?.kind, row.stale, row.reason])).toEqual([
        ["claude", true, "models_http_503"],
        ["chatgpt", true, "models_http_503"],
      ]);
    });

    it("never gives a proxy's unanswered Claude row the account's direct windows", () => {
      const previous = snapshotOf(1000, [
        {
          provider: "claude",
          label: "Claude",
          accountId: "acct_claude",
          status: "ok",
          stale: false,
          windows: [{ id: "session", label: "session", percentRemaining: 40, resetsAtMs: 9000 }],
        },
      ]);
      const next = snapshotOf(2000, [
        {
          provider: "claude",
          label: "Claude",
          accountId: "acct_claude",
          status: "unavailable",
          stale: false,
          fromProxy: true,
          windows: [],
        },
      ]);
      expect(mergeStaleProviders(next, previous, 3000).providers[0]?.windows).toEqual([]);
    });

    it("never gives the account's unanswered direct row the proxy's last pool reading", () => {
      const pooled = proxyConnectionRows(answered, [connection])[0];
      if (!pooled) throw new Error("The proxy reads a Claude pool.");
      const previous = snapshotOf(1000, [
        { ...pooled, provider: "claude", label: "Claude", accountId: "acct_claude" },
      ]);
      const next = snapshotOf(2000, [
        {
          provider: "claude",
          label: "Claude",
          accountId: "acct_claude",
          status: "unavailable",
          stale: false,
          windows: [],
        },
      ]);
      expect(mergeStaleProviders(next, previous, 3000).providers[0]?.windows).toEqual([]);
    });
  });
});
