import { describe, expect, it } from "vitest";
import { type PoolLogin, poolReading } from "./quotaSignals";

// The captain's ask: the proxy's Claude logins are one pooled allowance, and
// its ChatGPT logins another (docs/quota.md, "A proxy's pooled logins").
const NOW = Date.parse("2026-11-25T16:40:00Z");
const HOUR = 60 * 60 * 1000;
const SPENT_WINDOW = { id: "seven_day", label: "weekly" };

const weekly = (percentRemaining: number, resetsAtMs: number) => ({
  id: "seven_day",
  label: "weekly",
  percentRemaining,
  resetsAtMs,
});

describe("poolReading", () => {
  it("averages the read logins, a spent login weighing zero, and refills at the earliest return", () => {
    const logins: PoolLogin[] = [
      { state: "serving", windows: [weekly(80, NOW + 72 * HOUR)] },
      { state: "serving", windows: [weekly(20, NOW + 30 * HOUR)] },
      { state: "spent", backAtMs: NOW + 10 * HOUR },
    ];
    const reading = poolReading("claude", logins, NOW, SPENT_WINDOW);
    // (80 + 20 + 0) / 3
    expect(reading.windows).toHaveLength(1);
    expect(reading.windows[0]?.percentRemaining).toBeCloseTo(33.333, 2);
    expect(reading.windows[0]?.resetsAtMs).toBe(NOW + 10 * HOUR);
    expect(reading.pool).toMatchObject({ logins: 3, read: 2, unread: 0, spent: 1 });
    expect(reading.pool.backAtMs).toBe(NOW + 10 * HOUR);
  });

  it("weighs each login by the proxy's own weight", () => {
    const reading = poolReading(
      "chatgpt",
      [
        { state: "serving", weight: 3, windows: [weekly(100, NOW + HOUR)] },
        { state: "serving", weight: 1, windows: [weekly(0, NOW + HOUR)] },
      ],
      NOW,
      SPENT_WINDOW,
    );
    // (100 * 3 + 0 * 1) / 4
    expect(reading.windows[0]?.percentRemaining).toBe(75);
  });

  it("counts a login whose window already reset as full", () => {
    const reading = poolReading(
      "claude",
      [
        { state: "serving", windows: [weekly(0, NOW - HOUR)] },
        { state: "serving", windows: [weekly(50, NOW + HOUR)] },
      ],
      NOW,
      SPENT_WINDOW,
    );
    // (100 + 50) / 2, refilling when the unlapsed one resets
    expect(reading.windows[0]?.percentRemaining).toBe(75);
    expect(reading.windows[0]?.resetsAtMs).toBe(NOW + HOUR);
  });

  it("shows a pool with every login spent as empty until the first comes back", () => {
    const reading = poolReading(
      "claude",
      [
        { state: "spent", backAtMs: NOW + 5 * HOUR },
        { state: "spent", backAtMs: NOW + 2 * HOUR },
        { state: "switched_off" },
      ],
      NOW,
      SPENT_WINDOW,
    );
    expect(reading.windows).toEqual([
      expect.objectContaining({
        id: "seven_day",
        percentRemaining: 0,
        resetsAtMs: NOW + 2 * HOUR,
      }),
    ]);
    expect(reading.pool).toMatchObject({ logins: 3, spent: 2, switchedOff: 1 });
  });

  it("leaves a pool whose serving logins are all unread unknown, never empty", () => {
    const reading = poolReading(
      "chatgpt",
      [{ state: "serving" }, { state: "spent", backAtMs: NOW + HOUR }, { state: "sign_in_ended" }],
      NOW,
      SPENT_WINDOW,
    );
    expect(reading.windows).toEqual([]);
    expect(reading.pool).toMatchObject({ logins: 3, read: 0, unread: 1, spent: 1, signInEnded: 1 });
  });

  it("names the earliest moment a login needing a new sign-in stops serving", () => {
    const reading = poolReading(
      "claude",
      [
        { state: "serving", signInByMs: NOW + 6 * HOUR, windows: [weekly(40, NOW + 72 * HOUR)] },
        { state: "serving", signInByMs: NOW + 3 * HOUR, windows: [weekly(60, NOW + 72 * HOUR)] },
      ],
      NOW,
      SPENT_WINDOW,
    );
    expect(reading.pool).toMatchObject({ signInSoon: 2, signInByMs: NOW + 3 * HOUR });
  });
});
