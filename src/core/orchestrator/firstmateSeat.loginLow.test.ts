import { describe, expect, it, vi } from "vitest";
import { notes, runtimeKind, setupWithFlagship } from "../../../tests/helpers/firstmateFlagship";
import { type FakeSession, fakeClockEachTest, tick } from "../../../tests/helpers/firstmateHarness";

fakeClockEachTest();

// The approved plan for several logins of one provider, piece 3, "First
// mate": the ladder's step to another login of the same provider follows
// the choice for a low login. Under `ask` that move becomes a card, under
// `wait` the step is skipped, and only `move` takes it without a click.
// The card follows the choice and the readings between turns, and its click
// moves the seat only while they still bear the offer out.

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
    const move = card?.actions?.find((action) => action.id === "move-login");
    expect(move).toMatchObject({
      label: "Move to Work #2",
      default: true,
      effect: { kind: "host", op: "move-login", arg: "firstmate:acct_b" },
    });

    // The click moves the seat, takes the card down and delivers what waited.
    t.supervisor.cardActions.act("card-fm-no-headroom", "move-login");
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
    expect(card?.actions?.some((action) => action.id === "move-login")).toBe(false);
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
        ?.actions?.some((action) => action.id === "move-login"),
    ).toBe(true);
  });
});

describe("the first mate's offer of another login, between turns", () => {
  const moveOn = (t: ReturnType<typeof twoLogins>) =>
    t
      .cards()
      .find((each) => each.id === "card-fm-no-headroom")
      ?.actions?.find((action) => action.id === "move-login");

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
    t.supervisor.cardActions.act("card-fm-no-headroom", "move-login");
    await tick();
    expect(t.specs).toHaveLength(1);
    expect(t.settings.getFirstmateAccount()).toBe("acct_a");
    expect(notes(t.events)).not.toContain("Your first mate moved to Work #2.");
  });

  it("moves nothing on a click after the choice became wait", async () => {
    const t = twoLogins();
    await spendPersonal(t);
    t.settings.setWhenLoginLow("wait");
    t.supervisor.cardActions.act("card-fm-no-headroom", "move-login");
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
    t.supervisor.cardActions.act("card-fm-on-credits", "move-login");
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
});
