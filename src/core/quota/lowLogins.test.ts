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
// only about running work.

type HostCard = Omit<Card, "author" | "priority" | "status" | "createdAt">;

function watchOver(start: {
  choice: WhenLoginLow;
  pin?: string;
  logins: LoginReading[];
  tasksOn?: Record<string, string[]>;
}) {
  const state = { ...start, tasksOn: start.tasksOn ?? {} };
  const raised: HostCard[] = [];
  const withdrawn: string[] = [];
  const lines: string[] = [];
  const left: string[] = [];
  const pins: string[] = [];
  const watch = new LowLogins({
    whenLow: () => state.choice,
    providers: () => [{ id: "openai-codex", name: "ChatGPT" }],
    logins: () => state.logins,
    pinOf: () => state.pin,
    setPin: (_providerId, accountId) => {
      state.pin = accountId;
      pins.push(accountId);
    },
    refillsOf: (_providerId, accountId) => (accountId === "personal" ? "6pm" : undefined),
    tasksOn: (accountId) => state.tasksOn[accountId] ?? [],
    moveOff: (accountId) => {
      left.push(accountId);
    },
    cards: {
      raiseHostCard: (card) => {
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
  return { watch, state, raised, withdrawn, lines, left, pins };
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
    expect(t.left).toEqual(["personal"]);
    expect(t.withdrawn).toEqual(["card-login-low-openai-codex"]);
    // A task that was mid-turn at the click is asked again at each reading while the login stays low.
    t.watch.read();
    expect(t.left).toEqual(["personal", "personal"]);
    expect(t.raised).toHaveLength(1);
    // Once it refills nothing leaves it any more.
    t.state.logins = [
      login("personal", "Personal", 100),
      login("work", "Work", 45),
      login("spare", "Spare", 60),
    ];
    t.watch.read();
    expect(t.left).toEqual(["personal", "personal"]);
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
    expect(t.left).toEqual(["personal"]);
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
    expect(t.left).toEqual(["personal"]);
    expect(t.lines).toEqual([]);
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
    t.watch.move("spare");
    expect([t.pins, t.left]).toEqual([[], []]);
  });
});
