import type { Card } from "@shared/cards";
import { englishOf, type Said, wordSaidMarks } from "@shared/i18n/said";
import type { WhenLoginLow } from "@shared/whenLoginLow";
import { describe, expect, it } from "vitest";
import { type LoginReading, LowLogins } from "./lowLogins";

// The approved plan for several logins of one provider, piece 3: "Moment"
// (the login in use at 10% or less while another login of the provider has
// room), "Ask" (one card per provider per run-out; the click moves the pin
// and the tasks on the spent login follow) and "Move" (the same with no
// card and one feed line), with `wait` doing nothing and `spread` asking
// only about running work. The moment is also a typed `no_headroom`
// cut-off, whatever the meter last read, and the click moves work only to
// the login the card named.

type HostCard = Omit<Card, "author" | "priority" | "status" | "createdAt">;

function watchOver(start: {
  choice: WhenLoginLow;
  pin?: string;
  logins: LoginReading[];
  tasksOn?: Record<string, string[]>;
}) {
  const state = {
    ...start,
    tasksOn: start.tasksOn ?? {},
    providers: [{ id: "openai-codex", name: "ChatGPT" }],
    waitChosen: false,
  };
  const forgotten = new Set<string>();
  const raised: HostCard[] = [];
  const withdrawn: string[] = [];
  const lines: string[] = [];
  const left: string[] = [];
  const pins: string[] = [];
  const watch = new LowLogins({
    whenLow: () => state.choice,
    providers: () => state.providers,
    logins: () => state.logins,
    pinOf: () => state.pin,
    setPin: (_providerId, accountId) => {
      state.pin = accountId;
      pins.push(accountId);
    },
    refillsOf: (_providerId, accountId) => (accountId === "personal" ? "6pm" : undefined),
    tasksOn: (accountId) => state.tasksOn[accountId] ?? [],
    moveOff: (from, to) => {
      forgotten.delete(from);
      left.push(`${from} to ${to}`);
    },
    forget: (from) => {
      forgotten.add(from);
    },
    waitChosen: () => state.waitChosen,
    cards: {
      raiseHostCard: (card) => {
        state.waitChosen = false;
        raised.push(card);
      },
      withdrawHostCard: (id) => {
        withdrawn.push(id);
      },
    },
    note: (fact: Said) => {
      lines.push(englishOf(fact));
    },
  });
  return { watch, state, raised, withdrawn, lines, left, pins, forgotten };
}

const login = (accountId: string, label: string, percent?: number): LoginReading => ({
  accountId,
  label,
  enabled: true,
  connected: true,
  ...(percent !== undefined ? { effectivePercentRemaining: percent } : {}),
});

const personalLow = () => [
  login("personal", "Personal", 8),
  login("work", "Work", 45),
  login("spare", "Spare", 70),
];

/** A card's words as a person reads them, with its markup taken out. */
const wordsOf = (card: HostCard | undefined) =>
  wordSaidMarks(card?.body ?? "")
    .replace(/<template[^>]*><\/template>/g, "")
    .replace(/<[^>]+>/g, "");

describe("the login in use running low, under ask", () => {
  it("asks once on one card that names the login, its refill and the login with the most room", () => {
    const t = watchOver({ choice: "ask", pin: "personal", logins: personalLow() });
    t.watch.read();
    t.watch.read();
    expect(t.raised).toHaveLength(1);
    const card = t.raised[0];
    expect(card?.id).toBe("card-login-low-openai-codex");
    expect(card?.title).toBe("Personal is running low");
    expect(wordsOf(card)).toBe(
      "It has 8% of its allowance left. Its allowance refills 6pm. Spare has the most room. New ChatGPT work would run on Spare, and crew work waiting on Personal would continue there at its next turn.",
    );
    expect(card?.actions?.map((action) => [action.label, action.effect, action.declines])).toEqual([
      ["Move to Spare", { kind: "host", op: "move-login", arg: "crew:spare" }, undefined],
      ["Wait for the refill", undefined, true],
    ]);
    // The button's id names both logins, so a card revised to another login declares another button.
    expect(card?.actions?.[0]?.id).toBe("move-login-personal-spare");
    // Nothing moves until the click.
    expect(t.pins).toEqual([]);
    expect(t.left).toEqual([]);
  });

  it("moves the pin and the tasks on the low login on the click, and says one feed line", () => {
    const t = watchOver({
      choice: "ask",
      pin: "personal",
      logins: personalLow(),
      tasksOn: { personal: ["task-1"] },
    });
    t.watch.read();
    t.watch.move("spare");
    expect(t.state.pin).toBe("spare");
    expect(t.lines).toEqual(["ChatGPT work moved from Personal to Spare."]);
    // Work, which also has room, is not where the card said work would go.
    expect(t.left).toEqual(["personal to spare"]);
    // While the login stays low its tasks stay bound to the move.
    t.watch.read();
    expect(t.forgotten.has("personal")).toBe(false);
    expect(t.raised).toHaveLength(1);
    // Once it refills nothing leaves it any more.
    t.state.logins = [
      login("personal", "Personal", 100),
      login("work", "Work", 45),
      login("spare", "Spare", 60),
    ];
    t.watch.read();
    expect(t.forgotten.has("personal")).toBe(true);
    expect(t.left).toEqual(["personal to spare"]);
  });

  it("keeps a low login's tasks still to move while a reading has not read that login yet, as after a relaunch", () => {
    const t = watchOver({
      choice: "ask",
      pin: "spare",
      logins: [
        login("personal", "Personal"),
        login("work", "Work", 45),
        login("spare", "Spare", 60),
      ],
      tasksOn: { personal: ["task-1"] },
    });
    t.watch.read();
    expect(t.forgotten.has("personal")).toBe(false);
    // Read with room again, nothing leaves it any more.
    t.state.logins = [login("personal", "Personal", 100), login("spare", "Spare", 60)];
    t.watch.read();
    expect(t.forgotten.has("personal")).toBe(true);
  });

  it("asks at a typed run-out whatever the meter last read, and never offers a login that ran out", () => {
    const t = watchOver({
      choice: "ask",
      pin: "personal",
      logins: [
        // The provider refused Personal for a spent allowance; its meter still reads 80%.
        { ...login("personal", "Personal", 80), runOut: { resetsAt: 1_800_000_000_000 } },
        // Spare was refused the same way and has no reading at all.
        { ...login("spare", "Spare"), runOut: {} },
        login("work", "Work", 45),
      ],
    });
    t.watch.read();
    expect(t.raised).toHaveLength(1);
    expect(t.raised[0]?.title).toBe("Personal has used up its allowance");
    expect(wordsOf(t.raised[0])).toBe(
      "Its allowance refills 6pm. Work has the most room. New ChatGPT work would run on Work, and crew work waiting on Personal would continue there at its next turn.",
    );
  });

  it("keeps the card true to the logins: revised, taken down and put up again as they change", () => {
    const t = watchOver({ choice: "ask", pin: "personal", logins: personalLow() });
    t.watch.read();
    // Spare runs low too: the card now offers Work.
    t.state.logins = [
      login("personal", "Personal", 6),
      login("work", "Work", 45),
      login("spare", "Spare", 9),
    ];
    t.watch.read();
    expect(t.raised).toHaveLength(2);
    expect(t.raised[1]?.actions?.[0]?.label).toBe("Move to Work");
    expect(wordsOf(t.raised[1])).toContain("It has 6% of its allowance left.");
    expect(t.withdrawn).toEqual([]);
    // No login has room: the card comes down.
    t.state.logins = [login("personal", "Personal", 6), login("work", "Work", 3)];
    t.watch.read();
    expect(t.withdrawn).toEqual(["card-login-low-openai-codex"]);
    // Work refills while Personal is still low: the question is asked again.
    t.state.logins = [login("personal", "Personal", 6), login("work", "Work", 100)];
    t.watch.read();
    expect(t.raised).toHaveLength(3);
    // The provider is left with one login: nothing to ask.
    t.state.logins = [login("personal", "Personal", 6)];
    t.watch.read();
    expect(t.withdrawn).toHaveLength(2);
  });

  it("takes the card down for a provider left with no login", () => {
    const t = watchOver({ choice: "ask", pin: "personal", logins: personalLow() });
    t.watch.read();
    t.state.providers = [];
    t.watch.read();
    expect(t.withdrawn).toEqual(["card-login-low-openai-codex"]);
  });

  it("holds the captain's Wait answer until that login has room again", () => {
    const t = watchOver({
      choice: "ask",
      pin: "personal",
      logins: personalLow(),
      tasksOn: { personal: ["task-1"] },
    });
    t.watch.read();
    t.state.waitChosen = true;
    // Another login becoming the roomiest does not ask again.
    t.state.logins = [
      login("personal", "Personal", 4),
      login("work", "Work", 95),
      login("spare", "Spare", 70),
    ];
    t.watch.read();
    expect(t.raised).toHaveLength(1);
    expect([t.pins, t.left]).toEqual([[], []]);
    // It refills, and at its next run-out the card is back.
    t.state.logins = [login("personal", "Personal", 100), login("work", "Work", 95)];
    t.watch.read();
    t.state.logins = [login("personal", "Personal", 9), login("work", "Work", 95)];
    t.watch.read();
    expect(t.raised).toHaveLength(2);
  });

  it("moves nothing on a click the logins no longer bear out, and asks about what is true now", () => {
    const gone = watchOver({
      choice: "ask",
      pin: "personal",
      logins: personalLow(),
      tasksOn: { personal: ["task-1"] },
    });
    gone.watch.read();
    // Spare ran out between the card and the click.
    gone.state.logins = [
      login("personal", "Personal", 8),
      login("work", "Work", 45),
      { ...login("spare", "Spare", 70), runOut: {} },
    ];
    gone.watch.move("spare");
    expect([gone.pins, gone.left, gone.lines]).toEqual([[], [], []]);
    expect(gone.raised).toHaveLength(2);
    expect(gone.raised[1]?.actions?.[0]?.label).toBe("Move to Work");

    const refilled = watchOver({
      choice: "ask",
      pin: "personal",
      logins: personalLow(),
      tasksOn: { personal: ["task-1"] },
    });
    refilled.watch.read();
    refilled.state.logins = [login("personal", "Personal", 100), login("spare", "Spare", 70)];
    refilled.watch.move("spare");
    expect([refilled.pins, refilled.left]).toEqual([[], []]);
  });

  it("moves nothing on a click once the captain made another login the one in use", () => {
    const t = watchOver({
      choice: "ask",
      pin: "personal",
      logins: personalLow(),
      tasksOn: { personal: ["task-1"] },
    });
    t.watch.read();
    // The captain picked Work in the accounts list; the card about Personal was still up.
    t.state.pin = "work";
    t.watch.move("spare");
    expect([t.pins, t.left, t.lines]).toEqual([[], [], []]);
    expect(t.state.pin).toBe("work");
    // The click closed the card, and Personal is no longer the login in use: nothing is asked again.
    expect(t.raised).toHaveLength(1);
  });

  it("says the allowance is used up for a spent login", () => {
    const t = watchOver({
      choice: "ask",
      pin: "personal",
      logins: [login("personal", "Personal", 0), login("work", "Work", 45)],
    });
    t.watch.read();
    expect(t.raised[0]?.title).toBe("Personal has used up its allowance");
    expect(wordsOf(t.raised[0])).not.toContain("% of its allowance left");
  });

  it("asks nothing while no other login has room, and nothing about a login that is not in use", () => {
    const none = watchOver({
      choice: "ask",
      pin: "personal",
      logins: [login("personal", "Personal", 8), login("work", "Work", 4)],
    });
    none.watch.read();
    expect(none.raised).toEqual([]);
    const other = watchOver({ choice: "ask", pin: "work", logins: personalLow() });
    other.watch.read();
    expect(other.raised).toEqual([]);
  });

  it("asks again at the login's next run-out, and takes the card down when the offer is gone", () => {
    const t = watchOver({ choice: "ask", pin: "personal", logins: personalLow() });
    t.watch.read();
    t.state.logins = [login("personal", "Personal", 100), login("work", "Work", 45)];
    t.watch.read();
    expect(t.withdrawn).toEqual(["card-login-low-openai-codex"]);
    t.state.logins = personalLow();
    t.watch.read();
    expect(t.raised).toHaveLength(2);
  });

  it("leaves out a login that is off, signed out, withheld or itself low as the place to move", () => {
    const t = watchOver({
      choice: "ask",
      pin: "personal",
      logins: [
        login("personal", "Personal", 8),
        { ...login("off", "Off", 90), enabled: false },
        { ...login("out", "Signed out", 90), connected: false },
        { ...login("held", "Held", 90), withheld: "refused" },
        login("low", "Low", 10),
        login("unread", "Unread"),
        login("work", "Work", 30),
      ],
    });
    t.watch.read();
    // A measured reading comes before an unread one.
    expect(t.raised[0]?.actions?.[0]?.effect).toEqual({
      kind: "host",
      op: "move-login",
      arg: "crew:work",
    });
  });
});

describe("the login in use running low, under the other choices", () => {
  it("does nothing under wait", () => {
    const t = watchOver({
      choice: "wait",
      pin: "personal",
      logins: personalLow(),
      tasksOn: { personal: ["task-1"] },
    });
    t.watch.read();
    expect([t.raised, t.pins, t.left, t.lines]).toEqual([[], [], [], []]);
  });

  it("moves the pin and the tasks without a card under move, with one feed line", () => {
    const t = watchOver({
      choice: "move",
      pin: "personal",
      logins: personalLow(),
      tasksOn: { personal: ["task-1"] },
    });
    t.watch.read();
    expect(t.raised).toEqual([]);
    expect(t.state.pin).toBe("spare");
    expect(t.lines).toEqual(["Personal is running low, so ChatGPT work moved to Spare."]);
    expect(t.left).toEqual(["personal to spare"]);
    // The next reading says nothing again: the pin is no longer the low login.
    t.watch.read();
    expect(t.lines).toHaveLength(1);
  });

  it("asks only about running work under spread, and leaves a pin on another login alone", () => {
    const t = watchOver({
      choice: "spread",
      pin: "work",
      logins: personalLow(),
      tasksOn: { personal: ["task-1"] },
    });
    t.watch.read();
    expect(wordsOf(t.raised[0])).toBe(
      "It has 8% of its allowance left. Its allowance refills 6pm. Spare has the most room. Crew work running on Personal would continue on Spare at its next turn.",
    );
    t.watch.move("spare");
    expect(t.state.pin).toBe("work");
    expect(t.left).toEqual(["personal to spare"]);
    expect(t.lines).toEqual([]);
  });

  it("leaves running work where it is under spread when the captain chooses Wait", () => {
    const t = watchOver({
      choice: "spread",
      pin: "work",
      logins: personalLow(),
      tasksOn: { personal: ["task-1"] },
    });
    t.watch.read();
    expect(t.raised).toHaveLength(1);
    t.state.waitChosen = true;
    t.watch.read();
    t.watch.read();
    expect(t.raised).toHaveLength(1);
    expect([t.pins, t.left, t.lines]).toEqual([[], [], []]);
  });

  it("asks nothing under spread about a low login no task runs on", () => {
    const t = watchOver({ choice: "spread", pin: "personal", logins: personalLow() });
    t.watch.read();
    expect(t.raised).toEqual([]);
  });

  it("takes the card down when the choice changes to wait, and a late click moves nothing", () => {
    const t = watchOver({
      choice: "ask",
      pin: "personal",
      logins: personalLow(),
      tasksOn: { personal: ["task-1"] },
    });
    t.watch.read();
    t.state.choice = "wait";
    t.watch.read();
    expect(t.withdrawn).toEqual(["card-login-low-openai-codex"]);
    expect(t.forgotten.has("personal")).toBe(true);
    t.watch.move("spare");
    expect([t.pins, t.left]).toEqual([[], []]);
  });
});
