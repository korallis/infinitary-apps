import { describe, expect, it } from "vitest";
import { accountPools, accountsPoolOf, type PoolMember } from "./accountPools";
import type { QuotaProviderView } from "./quota";
import { poolRank } from "./quotaSignals";

// The captain's ask: several logins of one provider signed in here are one
// pool per provider, Claude and ChatGPT alone, read with the pool math a CLI
// proxy's logins already use (docs/quota.md, "A pool of your own logins").
const NOW = Date.parse("2026-11-25T16:40:00Z");
const HOUR = 60 * 60 * 1000;

function login(
  accountId: string,
  session: number,
  weekly: number,
  more: Partial<QuotaProviderView> = {},
): QuotaProviderView {
  return {
    provider: "claude",
    label: "Claude",
    accountId,
    status: "ok",
    stale: false,
    measuredAt: NOW - 60_000,
    windows: [
      {
        id: "five_hour",
        label: "session",
        percentRemaining: session,
        resetsAtMs: NOW + 3 * HOUR,
        windowSeconds: 5 * 3600,
      },
      {
        id: "seven_day",
        label: "weekly",
        percentRemaining: weekly,
        resetsAtMs: NOW + 72 * HOUR,
        windowSeconds: 7 * 86400,
      },
    ],
    ...more,
  };
}

const members = (...ids: string[]): PoolMember[] =>
  ids.map((accountId) => ({ accountId, provider: "claude" }));
const left = (pool: QuotaProviderView | undefined, id: string) =>
  pool?.windows.find((window) => window.id === id)?.percentRemaining;

describe("accountPools", () => {
  it("folds two logins of one provider into one pool, each window the mean of what they have left", () => {
    const rows = [login("personal", 68, 41), login("work", 22, 64)];
    const pools = accountPools(rows, members("personal", "work"), NOW);
    expect(pools).toHaveLength(1);
    const [pool] = pools;
    // (68 + 22) / 2 and (41 + 64) / 2
    expect(left(pool, "five_hour")).toBe(45);
    expect(left(pool, "seven_day")).toBe(52.5);
    expect(pool?.pool).toMatchObject({
      kind: "claude",
      source: "accounts",
      accounts: ["personal", "work"],
      logins: 2,
      read: 2,
      unread: 0,
      spent: 0,
    });
    expect(pool?.provider).toBe("claude");
    expect(pool?.accountId).toBeUndefined();
  });

  it("makes no pool for a provider with one enabled login", () => {
    const rows = [login("personal", 68, 41), login("work", 22, 64)];
    // The second login is paused: it is not among the members.
    expect(accountPools(rows, members("personal"), NOW)).toEqual([]);
  });

  it("pools Claude and ChatGPT logins only", () => {
    const grok = (accountId: string): QuotaProviderView => ({
      ...login(accountId, 80, 40),
      provider: "grok",
      label: "Grok",
    });
    const codex = (accountId: string): QuotaProviderView => ({
      ...login(accountId, 74, 9),
      provider: "codex",
      label: "Codex",
    });
    const pools = accountPools(
      [grok("grok-a"), grok("grok-b"), codex("codex-a"), codex("codex-b")],
      [
        { accountId: "grok-a", provider: "grok" },
        { accountId: "grok-b", provider: "grok" },
        { accountId: "codex-a", provider: "codex" },
        { accountId: "codex-b", provider: "codex" },
      ],
      NOW,
    );
    expect(pools.map((pool) => [pool.provider, pool.pool?.kind])).toEqual([["codex", "chatgpt"]]);
  });

  it("counts a spent login as zero in every window until the window that spent it resets", () => {
    const rows = [login("personal", 0, 90), login("work", 60, 40)];
    const [pool] = accountPools(rows, members("personal", "work"), NOW);
    // The spent login weighs zero in both: (0 + 60) / 2 and (0 + 40) / 2.
    expect(left(pool, "five_hour")).toBe(30);
    expect(left(pool, "seven_day")).toBe(20);
    expect(pool?.pool).toMatchObject({ read: 1, spent: 1, backAtMs: NOW + 3 * HOUR });

    // Its session reset has passed: it serves again, that window full.
    const [later] = accountPools(rows, members("personal", "work"), NOW + 4 * HOUR);
    expect(later?.pool).toMatchObject({ read: 2, spent: 0 });
    expect(left(later, "seven_day")).toBe(65);
    expect(left(later, "five_hour")).toBe(100);
  });

  it("names unread and signed-out logins and never counts them as zero", () => {
    const rows = [
      login("personal", 68, 41),
      login("stale", 5, 5, { stale: true }),
      { ...login("ended", 0, 0), status: "auth_required" as const, windows: [] },
    ];
    // A fourth member has no row at all yet.
    const [pool] = accountPools(rows, members("personal", "stale", "ended", "new"), NOW);
    expect(left(pool, "five_hour")).toBe(68);
    expect(left(pool, "seven_day")).toBe(41);
    expect(pool?.pool).toMatchObject({
      logins: 4,
      read: 1,
      unread: 2,
      spent: 0,
      signInEnded: 1,
    });
  });

  it("leaves a pool whose logins are all unread without a window: unknown, not empty", () => {
    const rows = [login("a", 10, 10, { stale: true }), login("b", 10, 10, { stale: true })];
    const [pool] = accountPools(rows, members("a", "b"), NOW);
    expect(pool?.windows).toEqual([]);
    expect(pool?.pool).toMatchObject({ logins: 2, read: 0, unread: 2 });
  });

  it("shows a pool whose every login is spent as spent, back when the first returns", () => {
    const rows = [login("a", 0, 50), login("b", 30, 0)];
    const [pool] = accountPools(rows, members("a", "b"), NOW);
    expect(left(pool, "five_hour")).toBe(0);
    expect(left(pool, "seven_day")).toBe(0);
    expect(pool?.pool).toMatchObject({ read: 0, spent: 2, backAtMs: NOW + 3 * HOUR });
  });

  it("keeps a login a CLI proxy answers for out of the pool of the person's own", () => {
    const proxied = login("proxied", 90, 90, {
      fromProxy: true,
      pool: {
        kind: "claude",
        logins: 3,
        read: 3,
        unread: 0,
        spent: 0,
        switchedOff: 0,
        signInEnded: 0,
        signInSoon: 0,
      },
    });
    const rows = [login("personal", 68, 41), proxied];
    expect(accountPools(rows, members("personal", "proxied"), NOW)).toEqual([]);
  });
});

describe("a login with more than one account-wide window used up", () => {
  // Both of a's windows are used up; b's session is, and its week has half left.
  const rows = [login("a", 0, 0), login("b", 0, 50)];

  it("is back only when its last blocking window resets, so the pool returns with the first login that can serve", () => {
    const [pool] = accountPools(rows, members("a", "b"), NOW);
    // b returns with its session, in 3 hours; a not before its week, in 72.
    expect(pool?.pool).toMatchObject({ read: 0, spent: 2, backAtMs: NOW + 3 * HOUR });
    expect(left(pool, "five_hour")).toBe(0);
    // Two such logins: neither is back before its week resets.
    const [both] = accountPools([login("a", 0, 0), login("c", 0, 0)], members("a", "c"), NOW);
    expect(both?.pool).toMatchObject({ spent: 2, backAtMs: NOW + 72 * HOUR });
  });

  it("stays spent after its first window reset while the other still blocks it", () => {
    const [pool] = accountPools(rows, members("a", "b"), NOW + 4 * HOUR);
    // Only b serves: (100 + 0) / 2 of the session and (50 + 0) / 2 of the week.
    expect(pool?.pool).toMatchObject({ read: 1, spent: 1, backAtMs: NOW + 72 * HOUR });
    expect(left(pool, "five_hour")).toBe(50);
    expect(left(pool, "seven_day")).toBe(25);
  });
});

describe("accountsPoolOf", () => {
  it("finds a provider's pool of own logins among the snapshot's, and no other", () => {
    const rows = [login("personal", 0, 90), login("work", 60, 40)];
    const saved = accountPools(rows, members("personal", "work"), NOW);
    expect(accountsPoolOf(saved, "claude")).toBe(saved[0]);
    expect(accountsPoolOf(saved, "codex")).toBeUndefined();
    expect(accountsPoolOf(undefined, "claude")).toBeUndefined();
  });
});

describe("poolRank", () => {
  it("scores a pool by the mean of its logins that still have allowance", () => {
    expect(
      poolRank([
        { effectivePercentRemaining: 60, spendPriority: 0.4, lastsThroughReset: true },
        { effectivePercentRemaining: 30, spendPriority: -0.2, lastsThroughReset: false },
        // Spent: its score is not the pool's.
        { effectivePercentRemaining: 0, spendPriority: -1, lastsThroughReset: false },
      ]),
    ).toEqual({ spendPriority: 0.1, lastsThroughReset: true });
  });

  it("runs out first only when no login is known to last, and stays unknown with no score", () => {
    expect(
      poolRank([
        { effectivePercentRemaining: 30, spendPriority: -0.2, lastsThroughReset: false },
        { effectivePercentRemaining: 50 },
      ]),
    ).toEqual({ spendPriority: -0.2, lastsThroughReset: false });
    expect(poolRank([{ effectivePercentRemaining: 50 }, {}])).toEqual({});
  });
});
