import type { Card } from "@shared/cards";
import type { FmEvent } from "@shared/events";
import { wordSaidMarks } from "@shared/i18n/said";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOGIN_LOW_WAIT } from "../orchestrator/loginCards";
import type { LoginMoves } from "../orchestrator/loginMoves";
import { startLowLogins } from "./homeLowLogins";
import type { LoginReading } from "./lowLogins";

// The approved plan for several logins of one provider, piece 3, "Moment":
// the login in use at 10% or less, or a typed `no_headroom` cut-off, while
// another enabled login of the provider has room. The cut-off is the
// provider's own refusal, so it counts whatever the meter last read.

type HostCard = Omit<Card, "author" | "priority" | "status" | "createdAt">;

// A Monday noon; the cut-off below names the Wednesday after it.
const NOW = Date.parse("2026-08-17T12:00:00Z");
const RESETS = Date.parse("2026-08-19T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

/** What the card store keeps across launches: the provider's card and the action that answered it. */
type SavedCard = { card?: HostCard; chosen?: string };

function home(
  logins: LoginReading[],
  saved: SavedCard = {},
  cutOffs = new Map<string, { class: string; resetsAt?: number }>(),
) {
  const listeners: (() => void)[] = [];
  const raised: HostCard[] = [];
  const moved: string[] = [];
  const events: FmEvent[] = [];
  const state = {
    pin: "personal" as string | undefined,
    get chosen() {
      return saved.chosen;
    },
    set chosen(action: string | undefined) {
      saved.chosen = action;
    },
  };
  const loginMoves = {
    tasksOn: () => ["task-1"],
    moveOff: async (from: string, to: string) => {
      moved.push(`${from} to ${to}`);
    },
    forget: () => {},
  } as unknown as LoginMoves;
  const watch = startLowLogins({
    settings: { getWhenLoginLow: () => "ask" },
    vault: {
      list: (providerId) =>
        providerId === "openai-codex"
          ? logins.map((login) => ({ id: login.accountId, label: login.label, enabled: true }))
          : [],
      pinnedAccount: () => state.pin,
      setPin: (_providerId, accountId) => {
        state.pin = accountId ?? undefined;
      },
      onCutOffChange: (listener) => listeners.push(listener),
      cutOff: (accountId) => cutOffs.get(accountId),
    },
    routing: { accounts: { logins: () => logins }, attachLoginInUse: () => {} },
    quota: { latest: () => undefined },
    supervisor: {
      cards: {
        hostCards: {
          raiseHostCard: (card) => {
            saved.chosen = undefined;
            saved.card = card;
            raised.push(card);
          },
          withdrawHostCard: () => {},
        },
        chosenAction: () => saved.chosen,
        stored: () => saved.card,
      },
      loginMoves,
    },
    broadcastEvent: (event) => events.push(event),
  });
  const cutOffChanged = () => {
    for (const listener of listeners) listener();
  };
  return { watch, cutOffs, cutOffChanged, raised, moved, state, loginMoves, saved };
}

const login = (accountId: string, label: string, percent?: number): LoginReading => ({
  accountId,
  label,
  enabled: true,
  connected: true,
  ...(percent !== undefined ? { effectivePercentRemaining: percent } : {}),
});

const wordsOf = (card: HostCard | undefined) =>
  wordSaidMarks(card?.body ?? "")
    .replace(/<template[^>]*><\/template>/g, "")
    .replace(/<[^>]+>/g, "");

describe("the home's watch over a login the provider cut off for a spent allowance", () => {
  it("asks as the cut-off is recorded, with a meter that never read the login, and names the cut-off's own refill", () => {
    const t = home([login("personal", "Personal"), login("work", "Work", 60)]);
    t.watch.read();
    expect(t.raised).toEqual([]);
    t.cutOffs.set("personal", { class: "no_headroom", resetsAt: RESETS });
    t.cutOffChanged();
    expect(t.raised).toHaveLength(1);
    expect(t.raised[0]?.title).toBe("Personal has used up its allowance");
    expect(wordsOf(t.raised[0])).toContain("Its allowance refills Wed.");
    expect(t.raised[0]?.actions?.[0]?.label).toBe("Move to Work");
  });

  it("asks though the meter last read the login as healthy", () => {
    const t = home([login("personal", "Personal", 80), login("work", "Work", 60)]);
    t.cutOffs.set("personal", { class: "no_headroom", resetsAt: RESETS });
    t.watch.read();
    expect(t.raised[0]?.title).toBe("Personal has used up its allowance");
  });

  it("never offers a login that was cut off the same way, and reads no other cut-off as a run-out", () => {
    const t = home([
      login("personal", "Personal", 5),
      login("spare", "Spare", 90),
      login("work", "Work", 60),
    ]);
    t.cutOffs.set("spare", { class: "no_headroom", resetsAt: RESETS });
    t.watch.read();
    expect(t.raised[0]?.actions?.[0]?.label).toBe("Move to Work");

    const refused = home([login("personal", "Personal", 80), login("work", "Work", 60)]);
    refused.cutOffs.set("personal", { class: "refused" });
    refused.watch.read();
    expect(refused.raised).toEqual([]);
  });

  it("moves the login's tasks to the login the card named, and holds a Wait answer", () => {
    const t = home([
      { ...login("personal", "Personal", 80) },
      login("work", "Work", 60),
      login("spare", "Spare", 40),
    ]);
    t.cutOffs.set("personal", { class: "no_headroom", resetsAt: RESETS });
    t.watch.read();
    t.loginMoves.onClick?.("work");
    expect(t.moved).toEqual(["personal to work"]);
    expect(t.state.pin).toBe("work");

    const waits = home([login("personal", "Personal", 80), login("work", "Work", 60)]);
    waits.cutOffs.set("personal", { class: "no_headroom", resetsAt: RESETS });
    waits.watch.read();
    waits.state.chosen = "wait-for-refill";
    waits.watch.read();
    waits.cutOffChanged();
    expect(waits.raised).toHaveLength(1);
    expect(waits.moved).toEqual([]);
  });
});

// The approved plan, "Ask": one card per provider per run-out. The captain's
// Wait for the refill is on the saved card, so a relaunch reads it back.
describe("the home's watch after a relaunch, when the captain answered Wait for the refill", () => {
  const lowAndRoomy = () => [login("personal", "Personal", 4), login("work", "Work", 60)];

  it("does not ask again while that login is still low, whichever login has the most room", () => {
    const before = home(lowAndRoomy());
    before.watch.read();
    expect(before.raised).toHaveLength(1);
    before.saved.chosen = LOGIN_LOW_WAIT;

    const logins = lowAndRoomy();
    const after = home(logins, before.saved);
    after.watch.read();
    logins.push(login("spare", "Spare", 95));
    after.watch.read();
    expect(after.raised).toEqual([]);
    expect(after.moved).toEqual([]);
  });

  it("does not ask again when the first reading after the relaunch has not read that login yet", () => {
    const before = home(lowAndRoomy());
    before.watch.read();
    before.saved.chosen = LOGIN_LOW_WAIT;

    const logins = [login("personal", "Personal"), login("work", "Work", 60)];
    const after = home(logins, before.saved);
    after.watch.read();
    logins[0] = login("personal", "Personal", 4);
    after.watch.read();
    expect(after.raised).toEqual([]);
  });

  it("asks again at the next run-out, once that login was read with room", () => {
    const before = home(lowAndRoomy());
    before.watch.read();
    before.saved.chosen = LOGIN_LOW_WAIT;

    const logins = [login("personal", "Personal", 100), login("work", "Work", 60)];
    const after = home(logins, before.saved);
    after.watch.read();
    expect(after.raised).toEqual([]);
    logins[0] = login("personal", "Personal", 9);
    after.watch.read();
    expect(after.raised).toHaveLength(1);
  });

  it("asks again for a login cut off anew after the refill the answered card named", () => {
    const cutOffs = new Map([["personal", { class: "no_headroom", resetsAt: RESETS }]]);
    const logins = [login("personal", "Personal"), login("work", "Work", 60)];
    const before = home(logins, {}, cutOffs);
    before.watch.read();
    expect(before.raised).toHaveLength(1);
    before.saved.chosen = LOGIN_LOW_WAIT;

    // Relaunched before that refill, the same run-out is not asked about again.
    const same = home(logins, before.saved, cutOffs);
    same.watch.read();
    expect(same.raised).toEqual([]);

    // Relaunched after it, with the login cut off until a week later: a new run-out.
    vi.setSystemTime(RESETS + 60_000);
    const week = 7 * 24 * 60 * 60 * 1000;
    const again = new Map([["personal", { class: "no_headroom", resetsAt: RESETS + week }]]);
    const next = home(logins, before.saved, again);
    next.watch.read();
    expect(next.raised).toHaveLength(1);
  });
});
