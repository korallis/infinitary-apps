import { describe, expect, it, vi } from "vitest";
import {
  CODEX_MODEL,
  notes,
  runtimeKind,
  setupWithFlagship,
} from "../../../tests/helpers/firstmateFlagship";
import { type FakeSession, fakeClockEachTest, tick } from "../../../tests/helpers/firstmateHarness";
import { firstmateOnCreditsCard } from "./loginCards";

fakeClockEachTest();

// The approved plan for several logins of one provider, piece 3, "First
// mate": the ladder's step to another login of the same provider follows
// the choice for a low login. Under `ask` that move becomes a card, under
// `wait` the step is skipped, and only `move` takes it without a click.
// The card follows the choice and the readings between turns, and its click
// moves the seat only while they still bear the offer out. "Ask": the button
// names the login it moves to, so a click moves to that login or to none.

/** The Move button's id from Personal to Work #2 (`moveLoginActionId`). */
const TO_WORK = "move-login-acct_a-acct_b";
const isMove = (action: { effect?: { kind: string; op?: string } }) =>
  action.effect?.kind === "host" && action.effect.op === "move-login";

const twoLogins = () =>
  setupWithFlagship({
    accounts: [
      { id: "acct_a", providerId: "openai-codex", label: "Personal", enabled: true },
      { id: "acct_b", providerId: "openai-codex", label: "Work #2", enabled: true },
    ],
  });

/** The seat answers once on Personal, then Personal's allowance runs out and a second message comes. */
async function spendPersonal(t: ReturnType<typeof twoLogins>): Promise<void> {
  t.setHeadroom("acct_a", 60);
  t.setHeadroom("acct_b", 40);
  await t.agent.converse("first");
  expect(t.agent.boundAccount()).toBe("acct_a");
  (t.sessions[0] as FakeSession).resolveNextPrompt();
  await tick();
  t.setHeadroom("acct_a", 0);
  await t.agent.converse("second");
  await tick();
}

describe("the first mate's login running out, under each choice", () => {
  it("asks on its pause card before moving to another login, the default", async () => {
    const t = twoLogins();
    expect(t.settings.getWhenLoginLow()).toBe("ask");
    await spendPersonal(t);
    // Nothing moved: the seat is still on Personal, and its message is kept.
    expect(t.specs).toHaveLength(1);
    expect(t.settings.getFirstmateAccount()).toBe("acct_a");
    expect(notes(t.events).some((text) => text.includes("moved to Work #2"))).toBe(false);
    const card = t.cards().find((each) => each.id === "card-fm-no-headroom");
    expect(card?.body).toContain("Work #2 has allowance left. Move your first mate to Work #2");
    const move = card?.actions?.find(isMove);
    expect(move).toMatchObject({
      id: TO_WORK,
      label: "Move to Work #2",
      default: true,
      effect: { kind: "host", op: "move-login", arg: "firstmate:acct_b" },
    });

    // The click moves the seat, takes the card down and delivers what waited.
    t.supervisor.cardActions.act("card-fm-no-headroom", TO_WORK);
    await vi.waitFor(() => expect(t.specs).toHaveLength(2));
    await tick();
    expect(t.settings.getFirstmateAccount()).toBe("acct_b");
    expect(runtimeKind(t.specs[1])).toBe("runtime-acct_b");
    expect(t.cards().some((each) => each.id === "card-fm-no-headroom")).toBe(false);
    expect(notes(t.events)).toContain("Your first mate moved to Work #2.");
    expect((t.sessions[1] as FakeSession).prompts[0]).toContain("second");
  });

  it("skips the step under wait: the seat waits on its own login", async () => {
    const t = twoLogins();
    t.settings.setWhenLoginLow("wait");
    await spendPersonal(t);
    expect(t.specs).toHaveLength(1);
    expect(t.settings.getFirstmateAccount()).toBe("acct_a");
    const card = t.cards().find((each) => each.id === "card-fm-no-headroom");
    expect(card).toBeDefined();
    expect(card?.actions?.some(isMove)).toBe(false);
    expect(card?.body).not.toContain("Work #2");
  });

  it("moves without a card under move", async () => {
    const t = twoLogins();
    t.settings.setWhenLoginLow("move");
    await spendPersonal(t);
    expect(t.settings.getFirstmateAccount()).toBe("acct_b");
    expect(t.cards().some((each) => each.id === "card-fm-no-headroom")).toBe(false);
    expect(notes(t.events).some((text) => text.includes("moved to Work #2"))).toBe(true);
  });

  it("asks on the card under spread too", async () => {
    const t = twoLogins();
    t.settings.setWhenLoginLow("spread");
    await spendPersonal(t);
    expect(t.settings.getFirstmateAccount()).toBe("acct_a");
    expect(
      t
        .cards()
        .find((each) => each.id === "card-fm-no-headroom")
        ?.actions?.some(isMove),
    ).toBe(true);
  });
});

describe("the first mate's offer of another login, between turns", () => {
  const moveOn = (t: ReturnType<typeof twoLogins>) =>
    t
      .cards()
      .find((each) => each.id === "card-fm-no-headroom")
      ?.actions?.find(isMove);

  it("drops the offer when the choice becomes wait, and offers it again under ask", async () => {
    const t = twoLogins();
    await spendPersonal(t);
    expect(moveOn(t)?.label).toBe("Move to Work #2");
    t.settings.setWhenLoginLow("wait");
    t.agent.onQuotaRefreshed();
    await tick();
    expect(t.cards().some((each) => each.id === "card-fm-no-headroom")).toBe(true);
    expect(moveOn(t)).toBeUndefined();
    t.settings.setWhenLoginLow("ask");
    t.agent.onQuotaRefreshed();
    await tick();
    expect(moveOn(t)?.label).toBe("Move to Work #2");
    // One pause, one feed line, however often its card was revised.
    expect(notes(t.events).filter((text) => text.includes("paused"))).toHaveLength(1);
  });

  it("drops the offer when the other login runs out too", async () => {
    const t = twoLogins();
    await spendPersonal(t);
    t.setHeadroom("acct_b", 0);
    t.agent.onQuotaRefreshed();
    await tick();
    expect(moveOn(t)).toBeUndefined();
    expect(t.settings.getFirstmateAccount()).toBe("acct_a");
  });

  it("puts its card back up with the offer when another login gets room after the captain answered the card", async () => {
    const t = twoLogins();
    await spendPersonal(t);
    t.setHeadroom("acct_b", 0);
    t.agent.onQuotaRefreshed();
    await tick();
    expect(moveOn(t)).toBeUndefined();
    // Any choice closes the card; Personal is still spent.
    t.supervisor.cardActions.act("card-fm-no-headroom", "open-settings");
    await tick();
    expect(t.cards().some((each) => each.id === "card-fm-no-headroom")).toBe(false);
    t.setHeadroom("acct_b", 40);
    t.agent.onQuotaRefreshed();
    await tick();
    expect(moveOn(t)?.label).toBe("Move to Work #2");
    expect(notes(t.events).filter((text) => text.includes("paused"))).toHaveLength(1);
  });

  it("moves nothing on a click the other login no longer bears out", async () => {
    const t = twoLogins();
    await spendPersonal(t);
    // Work #2 ran out after the card went up and before the click.
    t.setHeadroom("acct_b", 0);
    t.supervisor.cardActions.act("card-fm-no-headroom", TO_WORK);
    await tick();
    expect(t.specs).toHaveLength(1);
    expect(t.settings.getFirstmateAccount()).toBe("acct_a");
    expect(notes(t.events)).not.toContain("Your first mate moved to Work #2.");
  });

  it("refuses a click on the button as it stood before the card named another login", async () => {
    const t = setupWithFlagship({
      accounts: [
        { id: "acct_a", providerId: "openai-codex", label: "Personal", enabled: true },
        { id: "acct_b", providerId: "openai-codex", label: "Work #2", enabled: true },
        { id: "acct_c", providerId: "openai-codex", label: "Spare", enabled: true },
      ],
    });
    t.setHeadroom("acct_c", 0);
    await spendPersonal(t);
    expect(moveOn(t)?.id).toBe(TO_WORK);
    // Work #2 runs out and Spare refills: the card now names Spare.
    t.setHeadroom("acct_b", 0);
    t.setHeadroom("acct_c", 70);
    t.agent.onQuotaRefreshed();
    await tick();
    expect(moveOn(t)).toMatchObject({ id: "move-login-acct_a-acct_c", label: "Move to Spare" });
    // The captain's window still showed Move to Work #2.
    expect(() => t.supervisor.cardActions.act("card-fm-no-headroom", TO_WORK)).toThrow(
      "This choice is not offered on this card.",
    );
    await tick();
    expect(t.settings.getFirstmateAccount()).toBe("acct_a");
    expect(t.specs).toHaveLength(1);
  });

  it("moves nothing on a click after the choice became wait", async () => {
    const t = twoLogins();
    await spendPersonal(t);
    t.settings.setWhenLoginLow("wait");
    t.supervisor.cardActions.act("card-fm-no-headroom", TO_WORK);
    await tick();
    expect(t.specs).toHaveLength(1);
    expect(t.settings.getFirstmateAccount()).toBe("acct_a");
  });
});

describe("the first mate on a login's credits while another login has allowance left", () => {
  const onCredits = () =>
    setupWithFlagship({
      accounts: [
        {
          id: "acct_a",
          providerId: "openai-codex",
          label: "Personal",
          enabled: true,
          keepGoingOnCredits: true,
        },
        { id: "acct_b", providerId: "openai-codex", label: "Work #2", enabled: true },
      ],
    });

  it("keeps answering on credits and asks once on a card, under ask", async () => {
    const t = onCredits();
    await spendPersonal(t);
    // The turn is served where it is.
    expect(t.specs).toHaveLength(1);
    expect((t.sessions[0] as FakeSession).prompts.at(-1)).toContain("second");
    const asked = t.cards().filter((each) => each.id === "card-fm-on-credits");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.title).toBe("Your first mate is running on credits");
    expect(asked[0]?.actions?.map((action) => action.label)).toEqual([
      "Move to Work #2",
      "Stay on Personal",
    ]);
    (t.sessions[0] as FakeSession).resolveNextPrompt();
    await tick();

    // Staying is an answer: the next turn does not ask again.
    t.supervisor.cardActions.act("card-fm-on-credits", "stay-on-credits");
    await t.agent.converse("third");
    await tick();
    expect(t.cards().some((each) => each.id === "card-fm-on-credits")).toBe(false);
    expect(t.settings.getFirstmateAccount()).toBe("acct_a");
  });

  it("takes the ask down between turns when the choice becomes wait or the other login runs out", async () => {
    const waits = onCredits();
    await spendPersonal(waits);
    expect(waits.cards().some((each) => each.id === "card-fm-on-credits")).toBe(true);
    waits.settings.setWhenLoginLow("wait");
    waits.agent.onQuotaRefreshed();
    await tick();
    expect(waits.cards().some((each) => each.id === "card-fm-on-credits")).toBe(false);

    const ranOut = onCredits();
    await spendPersonal(ranOut);
    ranOut.setHeadroom("acct_b", 0);
    ranOut.agent.onQuotaRefreshed();
    await tick();
    expect(ranOut.cards().some((each) => each.id === "card-fm-on-credits")).toBe(false);
  });

  it("moves nothing on a click for a login whose allowance ran out meanwhile", async () => {
    const t = onCredits();
    await spendPersonal(t);
    t.setHeadroom("acct_b", 0);
    t.supervisor.cardActions.act("card-fm-on-credits", TO_WORK);
    await tick();
    expect(t.settings.getFirstmateAccount()).toBe("acct_a");
    expect(notes(t.events)).not.toContain("Your first mate moved to Work #2.");
  });

  it("stays on credits and asks nothing under wait", async () => {
    const t = onCredits();
    t.settings.setWhenLoginLow("wait");
    await spendPersonal(t);
    expect(t.specs).toHaveLength(1);
    expect(t.cards().some((each) => each.id === "card-fm-on-credits")).toBe(false);
  });

  it("takes down a card left open by the last launch when its offer no longer holds", async () => {
    const t = onCredits();
    // The card as the card store kept it, raised before this seat asked anything.
    t.supervisor.cards.hostCards.raiseHostCard(
      firstmateOnCreditsCard({
        accountId: "acct_a",
        login: "Personal",
        other: { accountId: "acct_b", label: "Work #2" },
      }),
    );
    await tick();
    expect(t.cards().some((each) => each.id === "card-fm-on-credits")).toBe(true);
    t.settings.setWhenLoginLow("wait");
    await spendPersonal(t);
    expect(t.cards().some((each) => each.id === "card-fm-on-credits")).toBe(false);
  });

  const leftOpen = (t: ReturnType<typeof onCredits>) =>
    t.supervisor.cards.hostCards.raiseHostCard(
      firstmateOnCreditsCard({
        accountId: "acct_a",
        login: "Personal",
        other: { accountId: "acct_b", label: "Work #2" },
      }),
    );

  it("takes that card down between turns under wait, before the seat has answered anything", async () => {
    const t = onCredits();
    leftOpen(t);
    await tick();
    expect(t.cards().some((each) => each.id === "card-fm-on-credits")).toBe(true);
    t.settings.setWhenLoginLow("wait");
    t.agent.onQuotaRefreshed();
    await tick();
    expect(t.cards().some((each) => each.id === "card-fm-on-credits")).toBe(false);
    expect(t.specs).toHaveLength(0);
  });

  it("takes that card down between turns under wait for a seat whose saved login has not answered yet", async () => {
    const t = onCredits();
    t.settings.setFirstmateAccount("acct_a");
    leftOpen(t);
    t.settings.setWhenLoginLow("wait");
    t.agent.onQuotaRefreshed();
    await tick();
    expect(t.cards().some((each) => each.id === "card-fm-on-credits")).toBe(false);
    expect(t.specs).toHaveLength(0);
  });

  it("takes that card down when the seat pauses, and keeps the pause's own offer of another provider", async () => {
    const t = setupWithFlagship({
      accounts: [
        { id: "acct_a", providerId: "openai-codex", label: "Personal", enabled: true },
        { id: "acct_b", providerId: "openai-codex", label: "Work #2", enabled: true },
        { id: "acct_grok", providerId: "xai", label: "Grok", enabled: true },
      ],
      availableModels: [CODEX_MODEL, { provider: "xai", id: "grok-4.6" }],
    });
    t.settings.setFirstmateModel(CODEX_MODEL);
    t.settings.setWhenLoginLow("wait");
    t.setHeadroom("acct_a", 60);
    t.setHeadroom("acct_b", 40);
    t.setHeadroom("acct_grok", 70);
    await t.agent.converse("first");
    expect(t.agent.boundAccount()).toBe("acct_a");
    (t.sessions[0] as FakeSession).resolveNextPrompt();
    await tick();
    // The card is up with nothing in this launch having asked it.
    leftOpen(t);
    t.setHeadroom("acct_a", 0);
    await t.agent.converse("second");
    await tick();
    expect(t.cards().some((each) => each.id === "card-fm-on-credits")).toBe(false);
    const pause = t.cards().find((each) => each.id === "card-fm-flagship-move");
    expect(pause?.actions?.map((action) => action.label)).toContain("Move to Grok");

    // Put up again while the seat is paused, the next check between turns takes it down too.
    leftOpen(t);
    t.agent.onQuotaRefreshed();
    await tick();
    expect(t.cards().some((each) => each.id === "card-fm-on-credits")).toBe(false);
    expect(t.cards().some((each) => each.id === "card-fm-flagship-move")).toBe(true);
  });
});
