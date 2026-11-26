import type { Card } from "@shared/cards";
import type { FmEvent } from "@shared/events";
import { wordSaidMarks } from "@shared/i18n/said";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOGIN_LOW_WAIT } from "../orchestrator/loginCards";
import { moveLoginActionId } from "../orchestrator/loginMove";
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

/**
 * What the app keeps across launches: the provider's card, the action that
 * answered it, and the answers the watch recorded as over.
 */
type SavedCard = {
  card?: HostCard;
  /** The card is up, unanswered. */
  open?: boolean;
  chosen?: string;
  over?: Record<string, string>;
};

function home(
  logins: LoginReading[],
  saved: SavedCard = {},
  cutOffs = new Map<string, { class: string; resetsAt?: number }>(),
) {
  const listeners: (() => void)[] = [];
  const raised: HostCard[] = [];
  const moved: string[] = [];
  /** The moves to one named login that the watch had dropped. */
  const discarded: string[] = [];
  const withdrawn: string[] = [];
  /** The tasks' moves and the pin's, in the order the watch recorded them. */
  const order: string[] = [];
  const events: FmEvent[] = [];
  const state = {
    pin: "personal" as string | undefined,
    /** The app quits as the pin is about to be saved. */
    quitsAtPin: false,
    /** The record of the tasks' moves cannot be written. */
    movesUnwritable: false,
    choice: "ask" as "ask" | "wait" | "move" | "spread",
    get chosen() {
      return saved.chosen;
    },
    set chosen(action: string | undefined) {
      saved.chosen = action;
    },
  };
  const loginMoves = {
    tasksOn: () => ["task-1"],
    // As `LoginMoves.moveOff`: a record that cannot be written throws before the promise.
    moveOff: (from: string, to: string) => {
      if (state.movesUnwritable) throw new Error("the record could not be written");
      moved.push(`${from} to ${to}`);
      order.push(`tasks ${from} to ${to}`);
      return Promise.resolve();
    },
    forget: (from: string, to?: string) => {
      if (to !== undefined) discarded.push(`${from} to ${to}`);
    },
  } as unknown as LoginMoves;
  const watch = startLowLogins({
    settings: {
      getWhenLoginLow: () => state.choice,
      getLoginAnswersOver: () => saved.over ?? {},
      setLoginAnswersOver: (over) => {
        saved.over = over;
      },
    },
    vault: {
      list: (providerId) =>
        providerId === "openai-codex"
          ? logins.map((login) => ({ id: login.accountId, label: login.label, enabled: true }))
          : [],
      pinnedAccount: () => state.pin,
      setPin: (_providerId, accountId) => {
        if (state.quitsAtPin) throw new Error("the app quit");
        state.pin = accountId ?? undefined;
        order.push(`pin ${accountId}`);
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
            saved.open = true;
            raised.push(card);
          },
          withdrawHostCard: (id) => {
            if (!saved.open) return;
            saved.open = false;
            withdrawn.push(id);
          },
        },
        chosenAction: () => saved.chosen,
        stored: (id) => (id === saved.card?.id ? saved.card : undefined),
        get: (id) =>
          id === saved.card?.id && saved.open && saved.chosen === undefined
            ? saved.card
            : undefined,
      },
      loginMoves,
    },
    broadcastEvent: (event) => events.push(event),
  });
  const cutOffChanged = () => {
    for (const listener of listeners) listener();
  };
  return {
    watch,
    cutOffs,
    cutOffChanged,
    raised,
    moved,
    discarded,
    withdrawn,
    order,
    state,
    loginMoves,
    saved,
  };
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

describe("the home's watch when a known refill or a reading with room ends a Wait answer", () => {
  it("asks again without a relaunch when the login is cut off anew after the refill the answered card named", () => {
    const cutOffs = new Map([["personal", { class: "no_headroom", resetsAt: RESETS }]]);
    const t = home([login("personal", "Personal"), login("work", "Work", 60)], {}, cutOffs);
    t.watch.read();
    t.saved.chosen = LOGIN_LOW_WAIT;
    t.watch.read();
    expect(t.raised).toHaveLength(1);

    // Past that refill the first reading is a cut-off again, until a week later.
    vi.setSystemTime(RESETS + 60_000);
    const week = 7 * 24 * 60 * 60 * 1000;
    cutOffs.set("personal", { class: "no_headroom", resetsAt: RESETS + week });
    t.cutOffChanged();
    expect(t.raised).toHaveLength(2);
  });

  it("asks at the next run-out after a relaunch, when the login was read with room before the app quit and no card went up since", () => {
    const logins = [login("personal", "Personal", 4), login("work", "Work", 60)];
    const before = home(logins);
    before.watch.read();
    before.saved.chosen = LOGIN_LOW_WAIT;
    before.watch.read();
    logins[0] = login("personal", "Personal", 100);
    before.watch.read();
    expect(before.raised).toHaveLength(1);

    // The next launch reads nothing of the login at first, then reads it low again.
    const later = [login("personal", "Personal"), login("work", "Work", 60)];
    const after = home(later, before.saved);
    after.watch.read();
    expect(after.raised).toEqual([]);
    later[0] = login("personal", "Personal", 9);
    after.watch.read();
    expect(after.raised).toHaveLength(1);
  });
});

// The approved plan, "Ask": the click moves work to the login the card
// named. The card store records the click before the watch acts on it, so a
// quit in between leaves an answered card the next launch finishes.
describe("the home's watch after a relaunch, when the app quit while it made the move a click named", () => {
  const offeringSpare = () => [
    login("personal", "Personal", 4),
    login("work", "Work", 40),
    login("spare", "Spare", 60),
  ];
  // By the next launch Work has more room than the login the click named.
  const workRoomier = () => [
    login("personal", "Personal", 4),
    login("work", "Work", 95),
    login("spare", "Spare", 60),
  ];

  it("moves the tasks and the pin to the named login, tasks first, when the click was recorded and nothing else", () => {
    const before = home(offeringSpare());
    before.watch.read();
    expect(before.raised[0]?.actions?.[0]?.label).toBe("Move to Spare");
    before.saved.chosen = moveLoginActionId("personal", "spare");

    const logins = [login("personal", "Personal"), ...workRoomier().slice(1)];
    const after = home(logins, before.saved);
    after.watch.read();
    // The low login is not read yet: the answer waits.
    expect(after.order).toEqual([]);
    logins[0] = login("personal", "Personal", 4);
    after.watch.read();
    after.watch.read();
    expect(after.order).toEqual(["tasks personal to spare", "pin spare"]);
    expect(after.raised).toEqual([]);

    // Finished, it is not made again at a later launch.
    const later = home(workRoomier(), { ...before.saved });
    later.state.pin = "spare";
    later.watch.read();
    expect(later.order).toEqual([]);
    expect(later.raised).toEqual([]);
  });

  it("finishes on the named login a move cut off after the tasks' moves were recorded and before the pin's", () => {
    const before = home(offeringSpare());
    before.watch.read();
    before.saved.chosen = moveLoginActionId("personal", "spare");
    before.state.quitsAtPin = true;
    expect(() => before.loginMoves.onClick?.("spare")).toThrow("the app quit");
    expect(before.order).toEqual(["tasks personal to spare"]);
    expect(before.state.pin).toBe("personal");

    const after = home(workRoomier(), before.saved);
    after.watch.read();
    expect(after.order).toEqual(["tasks personal to spare", "pin spare"]);
    expect(after.state.pin).toBe("spare");
    expect(after.raised).toEqual([]);
  });

  it("moves nothing and asks about what is true now, when the named login has no room left at the next launch", () => {
    const before = home(offeringSpare());
    before.watch.read();
    before.saved.chosen = moveLoginActionId("personal", "spare");

    const after = home(
      [login("personal", "Personal", 4), login("work", "Work", 95), login("spare", "Spare", 3)],
      before.saved,
    );
    // Before any reading, the click's moves the last launch saved are no longer to make.
    expect(after.discarded).toEqual(["personal to spare"]);
    after.watch.read();
    expect(after.order).toEqual([]);
    expect(after.discarded).toEqual(["personal to spare", "personal to spare"]);
    expect(after.raised).toHaveLength(1);
    expect(after.raised[0]?.actions?.[0]?.label).toBe("Move to Work");
  });

  it("changes neither the login in use nor the answer when the tasks' moves cannot be saved, and makes the whole move at the next reading", () => {
    const t = home(offeringSpare());
    t.watch.read();
    t.saved.chosen = moveLoginActionId("personal", "spare");
    t.state.movesUnwritable = true;
    expect(() => t.loginMoves.onClick?.("spare")).toThrow("the record could not be written");
    expect(t.order).toEqual([]);
    expect(t.state.pin).toBe("personal");
    expect(t.saved.over).toBeUndefined();

    t.state.movesUnwritable = false;
    t.watch.read();
    expect(t.order).toEqual(["tasks personal to spare", "pin spare"]);
    expect(t.saved.over).toBeDefined();
  });
});

// The approved plan: `wait` raises no card, and `ask` offers a move only
// while another login has room. The card store keeps an unanswered card
// open across a launch, so the first reading after it settles that card too.
describe("the home's watch after a relaunch, over a card still open from the last launch", () => {
  const cardId = "card-login-low-openai-codex";
  const openCard = () => {
    const before = home([login("personal", "Personal", 4), login("work", "Work", 60)]);
    before.watch.read();
    expect(before.saved.open).toBe(true);
    return before.saved;
  };

  it("takes it down at the first reading when the login it asks about has room again", () => {
    const after = home([login("personal", "Personal", 100), login("work", "Work", 60)], openCard());
    after.watch.read();
    expect(after.withdrawn).toEqual([cardId]);
  });

  it("takes it down when no other login has room, when the choice is wait or move, and when the provider has no login left", () => {
    const noRoom = home([login("personal", "Personal", 4), login("work", "Work", 2)], openCard());
    noRoom.watch.read();
    expect(noRoom.withdrawn).toEqual([cardId]);

    for (const choice of ["wait", "move"] as const) {
      const t = home([login("personal", "Personal", 4), login("work", "Work", 60)], openCard());
      t.state.choice = choice;
      t.watch.read();
      expect([choice, t.withdrawn]).toEqual([choice, [cardId]]);
    }

    const gone = home([], openCard());
    gone.watch.read();
    expect(gone.withdrawn).toEqual([cardId]);
  });

  it("leaves it up while the login it asks about is not read yet, and once that login is read low", () => {
    const logins = [login("personal", "Personal"), login("work", "Work", 60)];
    const after = home(logins, openCard());
    after.watch.read();
    logins[0] = login("personal", "Personal", 4);
    after.watch.read();
    expect(after.withdrawn).toEqual([]);
    expect(after.saved.open).toBe(true);
  });
});
