import { accountPools } from "@shared/accountPools";
import type { QuotaProviderView } from "@shared/quota";
import { describe, expect, it } from "vitest";
import { buildModelsCatalog, effectiveFromProvider, markCredits } from "./catalog";

// The captain's ask: where a provider's own logins pool, a model's band and
// spend order come from its pool, not from one login (docs/quota.md, "A pool
// of your own logins").
const NOW = Date.parse("2026-11-25T16:40:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const FABLE = { provider: "anthropic-claude", id: "claude-fable-5", name: "Claude Fable 5" };

/** A Claude login a day into its week, with `weekly` percent left. */
function login(
  accountId: string,
  weekly: number,
  more: Partial<QuotaProviderView> = {},
): QuotaProviderView {
  return {
    provider: "claude",
    label: "Claude",
    accountId,
    status: "ok",
    stale: false,
    windows: [
      {
        id: "seven_day",
        label: "weekly",
        percentRemaining: weekly,
        resetsAtMs: NOW + 6 * DAY,
        windowSeconds: 7 * 86400,
      },
    ],
    ...more,
  };
}

function catalogOf(rows: QuotaProviderView[], pooled: boolean) {
  const pools = pooled
    ? accountPools(
        rows,
        rows.map((row) => ({ accountId: row.accountId ?? "", provider: row.provider })),
        NOW,
      )
    : undefined;
  const [model] = buildModelsCatalog([FABLE], rows, new Date(NOW).toISOString(), NOW, pools).models;
  if (!model) throw new Error("The catalog lists the model.");
  return model;
}

describe("a model of a provider whose own logins pool", () => {
  it("reads what is left from the pool, where it read its best login before", () => {
    const rows = [login("personal", 90), login("work", 30)];
    expect(catalogOf(rows, false).effectivePercentRemaining).toBe(90);
    // (90 + 30) / 2
    expect(catalogOf(rows, true).effectivePercentRemaining).toBe(60);
  });

  it("takes its place in the spend order from its logins' own places", () => {
    const rows = [login("personal", 90), login("work", 30)];
    const own = rows.map((row) => effectiveFromProvider(row, NOW, FABLE.id));
    const [a, b] = own;
    if (typeof a?.spendPriority !== "number" || typeof b?.spendPriority !== "number")
      throw new Error("Each login has a score of its own.");
    const model = catalogOf(rows, true);
    expect(model.spendPriority).toBeCloseTo((a.spendPriority + b.spendPriority) / 2, 10);
    // One login is on track to last its week: so is the pool.
    expect(a.lastsThroughReset).toBe(true);
    expect(b.lastsThroughReset).toBe(false);
    expect(model.lastsThroughReset).toBe(true);
  });

  it("is spent only when every login is, and keeps going on credits when one answers on them", () => {
    const oneSpent = [login("personal", 0), login("work", 30)];
    // (0 + 30) / 2: the pool still has allowance.
    expect(catalogOf(oneSpent, true).effectivePercentRemaining).toBe(15);

    const allSpent = [login("personal", 0), login("work", 0)];
    const spent = catalogOf(allSpent, true);
    expect(spent.effectivePercentRemaining).toBe(0);
    expect(spent.onCredits).toBeUndefined();

    const credited = catalogOf(
      [
        login("personal", 0, { keepGoingOnCredits: true, credits: { state: "available" } }),
        login("work", 0),
      ],
      true,
    );
    expect(credited).toMatchObject({ effectivePercentRemaining: 0, onCredits: true });
  });

  it("is not spent by a window one login alone reports while another login has room", () => {
    const opusSpent = login("personal", 80, {
      windows: [
        ...login("personal", 80).windows,
        { id: "seven_day_opus", label: "weekly (Opus)", percentRemaining: 0 },
      ],
    });
    const opus = { provider: "anthropic-claude", id: "claude-opus-4-5", name: "Claude Opus 4.5" };
    const rows = [opusSpent, login("work", 40)];
    const [model] = buildModelsCatalog(
      [opus],
      rows,
      new Date(NOW).toISOString(),
      NOW,
      accountPools(
        rows,
        rows.map((row) => ({ accountId: row.accountId ?? "", provider: row.provider })),
        NOW,
      ),
    ).models;
    // The pooled Opus window reads 0, from the one login that reports it; the
    // other login serves Opus from its week, so the model has (0 + 40) / 2 left.
    expect(model?.effectivePercentRemaining).toBe(20);
  });

  // The review's ask: a paused login is outside the pool and must not make
  // a spent pool's model read as serving on credits.
  it("is marked as on credits by a serving login of its pool, never by a paused or signed-out one", () => {
    const credits = { keepGoingOnCredits: true, credits: { state: "available" as const } };
    const marked = (rows: QuotaProviderView[], memberIds: string[]) => {
      const pools = accountPools(
        rows,
        memberIds.map((accountId) => ({ accountId, provider: "claude" })),
        NOW,
      );
      const catalog = buildModelsCatalog([FABLE], rows, new Date(NOW).toISOString(), NOW, pools);
      return markCredits(catalog, rows, pools).models[0];
    };
    // Both logins of the pool are spent; the paused third keeps going on credits.
    const paused = [login("personal", 0), login("work", 0), login("old", 0, credits)];
    expect(marked(paused, ["personal", "work"])).toMatchObject({ effectivePercentRemaining: 0 });
    expect(marked(paused, ["personal", "work"])?.onCredits).toBeUndefined();

    // A login of the pool whose sign-in ended keeps its switch and serves
    // nothing: beside a spent login, the model is spent, not on credits.
    const ended: QuotaProviderView = {
      ...login("ended", 0, credits),
      status: "auth_required",
      windows: [],
    };
    const signedOut = marked([login("personal", 0), ended], ["personal", "ended"]);
    expect(signedOut).toMatchObject({ effectivePercentRemaining: 0 });
    expect(signedOut?.onCredits).toBeUndefined();

    // The same switch on a login of the pool does mark it.
    const member = [login("personal", 0, credits), login("work", 0), login("old", 0)];
    expect(marked(member, ["personal", "work"])?.onCredits).toBe(true);
  });
});
