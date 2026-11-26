import type { QuotaProviderView } from "@shared/quota";
import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../storage/db";
import { effectiveFromProvider } from "./catalog";
import {
  PUSHED_STALE_AFTER_MS,
  PushedQuotaStore,
  pushedCredits,
  pushedProviderViews,
  withPushedCredits,
  withRejectedReadings,
} from "./pushedQuota";

/**
 * Quota that a session pushes rather than a sensor fetches (account-broker
 * phase 7). The reading has to survive a restart, stay keyed to one account,
 * and be visibly last-known once it ages - stale beats wrong (D-7).
 */

const NOW = 1_800_000_000_000;

const accounts = [
  { accountId: "acct_a", accountLabel: "Personal", quotaId: "claude", providerLabel: "Claude" },
  { accountId: "acct_b", accountLabel: "Work", quotaId: "claude", providerLabel: "Claude" },
];

describe("PushedQuotaStore", () => {
  it("keeps the status the session pushed with each window, and survives a restart", () => {
    const db = openInMemoryDatabase();
    const store = new PushedQuotaStore(db);
    store.record("acct_a", {
      windowId: "five_hour",
      status: "allowed_warning",
      utilization: 0.9,
      at: NOW,
    });
    store.record("acct_a", {
      windowId: "five_hour",
      status: "rejected",
      utilization: 1,
      resetsAt: NOW + 3_600_000,
      at: NOW + 60,
    });
    store.record("acct_a", { windowId: "seven_day", utilization: 0.2, at: NOW });

    const windows = new PushedQuotaStore(db)
      .windowsFor("acct_a")
      .sort((a, b) => a.windowId.localeCompare(b.windowId));
    expect(windows).toEqual([
      {
        windowId: "five_hour",
        status: "rejected",
        utilization: 1,
        resetsAt: NOW + 3_600_000,
        at: NOW + 60,
      },
      // No status pushed: unknown, never `allowed`.
      { windowId: "seven_day", utilization: 0.2, at: NOW },
    ]);
  });

  it("never lets one account's reading colour a sibling's", () => {
    const store = new PushedQuotaStore(openInMemoryDatabase());
    store.record("acct_a", { windowId: "five_hour", utilization: 1, at: NOW });

    expect(store.windowsFor("acct_b")).toEqual([]);
    store.forget("acct_a");
    expect(store.windowsFor("acct_a")).toEqual([]);
  });
});

describe("pushedProviderViews", () => {
  it("renders a reading as remaining headroom under the window's own name", () => {
    const readings = new Map([
      [
        "acct_a",
        [{ windowId: "five_hour", utilization: 0.25, resetsAt: NOW + 3_600_000, at: NOW }],
      ],
    ]);
    const [row] = pushedProviderViews(accounts, (id) => readings.get(id) ?? [], NOW);

    expect(row).toMatchObject({
      provider: "claude",
      accountId: "acct_a",
      accountLabel: "Personal",
      status: "ok",
      stale: false,
    });
    expect(row?.windows[0]).toMatchObject({
      id: "five_hour",
      label: "session",
      percentRemaining: 75,
    });
    expect(row?.windows[0]?.resetText).toBeDefined();
  });

  it("shows an account nobody has measured yet as having no data, not as empty", () => {
    const [row] = pushedProviderViews(accounts, () => [], NOW);
    // Unknown quota keeps an account eligible for selection; reporting zero
    // would bench a subscription that is probably fine.
    expect(row?.windows).toEqual([]);
    expect(row?.stale).toBe(false);
    expect(row?.status).toBe("ok");
  });

  it("marks a reading nobody has refreshed since the last session as stale", () => {
    const old = [{ windowId: "five_hour", utilization: 0.5, at: NOW - PUSHED_STALE_AFTER_MS - 1 }];
    const [row] = pushedProviderViews(accounts, () => old, NOW);
    expect(row?.stale).toBe(true);
    // The number is still shown - last-known beats a blank meter.
    expect(row?.windows[0]?.percentRemaining).toBe(50);
  });

  it("clamps a window the plan has already blown through", () => {
    const [row] = pushedProviderViews(
      accounts,
      () => [{ windowId: "seven_day", utilization: 1.4, at: NOW }],
      NOW,
    );
    expect(row?.windows[0]?.percentRemaining).toBe(0);
    expect(row?.windows[0]?.label).toBe("weekly");
  });

  it("names a window it has never seen before rather than dropping it", () => {
    const [row] = pushedProviderViews(
      accounts,
      () => [{ windowId: "some_new_window", utilization: 0, at: NOW }],
      NOW,
    );
    expect(row?.windows[0]?.label).toBe("some new window");
  });
});

/**
 * The cut-off contract (W1 S7): a session's `rejected` reading is a zero
 * window until its reset, even for a sensed provider - the vendor said no,
 * and the sensor lags. Only a `rejected` reading's reset is trusted (rows
 * from before migration 51 held seconds), and unknown stays unknown.
 */
describe("withRejectedReadings", () => {
  const sensed: QuotaProviderView = {
    provider: "claude",
    label: "Claude",
    accountId: "acct_a",
    accountLabel: "Personal",
    status: "ok",
    stale: false,
    measuredAt: NOW - 60_000,
    windows: [
      { id: "five_hour", label: "session", percentRemaining: 40 },
      { id: "seven_day", label: "weekly", percentRemaining: 70 },
    ],
  };
  const rejected = {
    windowId: "five_hour",
    status: "rejected" as const,
    utilization: 1,
    resetsAt: NOW + 3_600_000,
    at: NOW - 1_000,
  };

  it("reads a rejected window as zero until its reset, keeping the sensor's other windows", () => {
    const row = withRejectedReadings(sensed, [rejected], NOW);
    expect(row.windows.map((window) => [window.id, window.percentRemaining])).toEqual([
      ["five_hour", 0],
      ["seven_day", 70],
    ]);
    expect(row.windows[0]?.resetsAtMs).toBe(NOW + 3_600_000);
    expect(effectiveFromProvider(row, NOW).effectivePercentRemaining).toBe(0);
    // The sensor read this row: the refusal over it does not make it unread.
    expect(row.unread).toBeUndefined();
    // At the reset the vendor's word no longer stands: the sensor's reading does.
    expect(withRejectedReadings(sensed, [rejected], NOW + 3_600_000)).toBe(sensed);
  });

  it("carries the refusal alone on a row the sensor could not measure", () => {
    const unmeasured: QuotaProviderView = {
      ...sensed,
      status: "unavailable",
      reason: "keychain_locked",
      detail: "Your sign-in is locked.",
      windows: [],
    };
    const row = withRejectedReadings(unmeasured, [rejected], NOW);
    // The captain's choice on the review's question: a refusal is no check
    // of the allowance, so the row says no reading produced it.
    expect(row).toMatchObject({
      status: "ok",
      stale: false,
      unread: true,
      measuredAt: NOW - 1_000,
    });
    expect(row.reason).toBeUndefined();
    expect(row.detail).toBeUndefined();
    expect(row.windows.map((window) => window.id)).toEqual(["five_hour"]);
    expect(effectiveFromProvider(row, NOW).effectivePercentRemaining).toBe(0);
  });

  it("leaves unknown unknown, proof of a sign-out standing, and an older reading untrusted", () => {
    const unmeasured: QuotaProviderView = { ...sensed, status: "unavailable", windows: [] };
    // No refusal at all: nothing to lay over.
    expect(withRejectedReadings(unmeasured, [], NOW)).toBe(unmeasured);
    expect(
      withRejectedReadings(unmeasured, [{ ...rejected, status: "allowed_warning" }], NOW),
    ).toBe(unmeasured);
    // A reading from before migration 51 has no status and a reset in seconds.
    const legacy = { windowId: "five_hour", utilization: 1, resetsAt: 1_900_000_000, at: 1 };
    expect(withRejectedReadings(unmeasured, [legacy], NOW)).toBe(unmeasured);
    // A refusal with no reset named has nothing to clear it at.
    const { resetsAt: _resetsAt, ...noReset } = rejected;
    expect(withRejectedReadings(unmeasured, [noReset], NOW)).toBe(unmeasured);
    // A sign-out the sensor proved is not rewritten into a zero window.
    const proven: QuotaProviderView = { ...sensed, status: "auth_required", windows: [] };
    expect(withRejectedReadings(proven, [rejected], NOW)).toBe(proven);
  });
});

describe("extra usage a session pushed (INF-4104 piece 1)", () => {
  const onExtra = {
    windowId: "five_hour",
    status: "rejected" as const,
    utilization: 1,
    resetsAt: NOW + 3_600_000,
    overageStatus: "allowed" as const,
    usingOverage: true,
    at: NOW,
  };

  it("keeps what the reading said about extra usage across a restart", () => {
    const db = openInMemoryDatabase();
    new PushedQuotaStore(db).record("acct_a", {
      ...onExtra,
      windowId: "seven_day",
      overageStatus: "rejected",
      overageReason: "out_of_credits",
      usingOverage: false,
    });
    new PushedQuotaStore(db).record("acct_a", onExtra);
    const windows = new PushedQuotaStore(db)
      .windowsFor("acct_a")
      .sort((a, b) => a.windowId.localeCompare(b.windowId));
    expect(windows).toEqual([
      onExtra,
      {
        ...onExtra,
        windowId: "seven_day",
        overageStatus: "rejected",
        overageReason: "out_of_credits",
        usingOverage: false,
      },
    ]);
  });

  it("reads the newest reading that spoke of extra usage", () => {
    expect(pushedCredits([onExtra], NOW)?.credits).toEqual({ state: "available", inUse: true });
    // Answering on it now is a claim only a current reading makes.
    expect(pushedCredits([onExtra], NOW + PUSHED_STALE_AFTER_MS + 1)?.credits).toEqual({
      state: "available",
    });
    const refused = (overageReason?: string) => ({
      ...onExtra,
      overageStatus: "rejected" as const,
      ...(overageReason ? { overageReason } : {}),
      at: NOW + 60,
    });
    expect(pushedCredits([onExtra, refused("out_of_credits")], NOW)?.credits).toEqual({
      state: "spent",
    });
    expect(pushedCredits([onExtra, refused("org_level_disabled")], NOW)?.credits).toEqual({
      state: "off",
    });
    // A reason the client could not read is unknown, never off.
    expect(pushedCredits([refused("fetch_error")], NOW)?.credits).toEqual({ state: "unknown" });
    expect(pushedCredits([refused()], NOW)?.credits).toEqual({ state: "unknown" });
    expect(pushedCredits([{ windowId: "five_hour", status: "allowed", at: NOW }], NOW)).toBe(
      undefined,
    );
  });

  it("lets the newer of the sensor and the session decide, keeping the sensor's share", () => {
    const sensed: QuotaProviderView = {
      provider: "claude",
      label: "Claude",
      accountId: "acct_a",
      status: "ok",
      stale: false,
      measuredAt: NOW - 60_000,
      windows: [],
      credits: { state: "available", usedPercent: 12 },
    };
    expect(withPushedCredits(sensed, [onExtra], NOW).credits).toEqual({
      state: "available",
      usedPercent: 12,
      inUse: true,
    });
    const outOfCredits = {
      ...onExtra,
      overageStatus: "rejected" as const,
      overageReason: "out_of_credits",
    };
    expect(withPushedCredits(sensed, [outOfCredits], NOW).credits).toEqual({ state: "spent" });
    // A sensor reading taken after the session's word wins.
    const newer = { ...sensed, measuredAt: NOW + 60_000, credits: { state: "off" as const } };
    expect(withPushedCredits(newer, [onExtra], NOW).credits).toEqual({ state: "off" });
    // A row that is not a reading is left as it stands.
    const unread = { ...sensed, status: "unavailable" as const, credits: undefined };
    expect(withPushedCredits(unread, [onExtra], NOW)).toBe(unread);
  });
});
