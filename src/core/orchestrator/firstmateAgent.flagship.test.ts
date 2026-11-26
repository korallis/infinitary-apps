import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card } from "@shared/cards";
import * as m from "@shared/i18n/messages.generated";
import { clockTime, type QuotaSavedResetsView, SAVED_RESETS_PAGE } from "@shared/quota";
import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_ACCOUNT,
  CLAUDE_SEAT_MODEL,
  claudeFlagship,
} from "../../../tests/helpers/claudeFlagship";
import { deferred } from "../../../tests/helpers/deferred";
import {
  CLAUDE_MODEL,
  CODEX_MODEL,
  claudeLogin,
  claudeLoginSeat,
  claudeSeat,
  notes,
  runtimeKind,
  setupWithFlagship,
} from "../../../tests/helpers/firstmateFlagship";
import {
  type FakeSession,
  fakeClockEachTest,
  fakeSession,
  resumeOf,
  setup,
  tick,
} from "../../../tests/helpers/firstmateHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { SDKUserMessage } from "../../../tests/helpers/scriptedClaudeQuery";
import { parseCodexUsage } from "../quota/providers/codex";
import type { SessionSpec } from "../session/session";
import { DELIVERY_COMPLETE } from "./contextDelivery";
import { formatFlagshipError } from "./firstmateSeat";
import { idleStallWays } from "./holds";
import { renderWake, type TypedWake } from "./wakes";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

fakeClockEachTest();

const claudeSays = {
  running: { type: "system", subtype: "session_state_changed", state: "running" },
  idle: { type: "system", subtype: "session_state_changed", state: "idle" },
  ack: (input: SDKUserMessage) => ({
    type: "user",
    isReplay: true,
    uuid: input.uuid,
    message: input.message,
    parent_tool_use_id: null,
  }),
  result: (text: string) => ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    total_cost_usd: 0,
    modelUsage: {
      "claude-opus": {
        inputTokens: 12,
        outputTokens: 3,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
  }),
};

function answersEveryPrompt(message: SDKUserMessage, emit: (message: unknown) => void): void {
  emit(claudeSays.running);
  emit(claudeSays.ack(message));
  emit(claudeSays.result("Aye."));
  emit(claudeSays.idle);
}

function inputText(message: SDKUserMessage | undefined): string {
  const content = message?.message.content;
  return typeof content === "string" ? content : JSON.stringify(content ?? "");
}

describe("FirstmateAgent flagship binding (broker phase 6)", () => {
  it("binds the derived flagship account's runtime at attachment and tracks its burn", async () => {
    const t = setupWithFlagship({
      accounts: [
        { id: "acct_low", providerId: "openai-codex", label: "Personal", enabled: true },
        { id: "acct_high", providerId: "openai-codex", label: "Work #2", enabled: true },
      ],
    });
    t.setHeadroom("acct_low", 10);
    t.setHeadroom("acct_high", 90);
    await t.agent.converse("hello");
    expect(runtimeKind(t.specs[0])).toBe("runtime-acct_high");
    expect(t.settings.getFirstmateAccount()).toBe("acct_high");
    expect(t.agent.boundAccount()).toBe("acct_high");

    const session = t.sessions[0] as FakeSession;
    session.emitTurnEnd("Hi.", { input: 3 });
    session.resolveNextPrompt();
    await tick();
    expect(t.usages[0]).toMatchObject({ accountId: "acct_high" });
  });

  it("names the seat's custom connection on the sign-in card and says how to check it, never quoting Pi", async () => {
    const custom = { provider: "fm-custom-0123456789abcdef", id: "operator-model" };
    const t = setupWithFlagship({
      accounts: [
        {
          id: "acct_custom",
          providerId: custom.provider,
          label: "Operator gateway",
          enabled: true,
        },
      ],
      availableModels: [custom],
    });
    t.settings.setFirstmateBinding(custom, "acct_custom");
    await t.agent.converse("hello");
    expect(t.agent.boundAccount()).toBe("acct_custom");
    // A connection whose model has no key in its runtime: Pi's session does
    // not name the connection, and its preflight throws its own sign-in help.
    (t.sessions[0] as FakeSession).rejectNextPrompt(
      [
        "No API key found for the selected model.",
        "",
        "Use /login to log into a provider via OAuth or API key. See:",
        "  /Applications/Firstmate 3000.app/Contents/Resources/app/node_modules/@earendil-works/pi-coding-agent/docs/providers.md",
        "  /Applications/Firstmate 3000.app/Contents/Resources/app/node_modules/@earendil-works/pi-coding-agent/docs/models.md",
      ].join("\n"),
    );
    await tick();
    expect(t.cards().find((card) => card.title === "A provider needs sign in")?.body).toBe(
      "Your first mate could not reach Operator gateway, your custom connection. In Settings → Intelligence, press Edit on it, then Save to check it again.",
    );
  });

  it("rebinds to a sibling at the idle boundary when the flagship exhausts (rung 1)", async () => {
    const t = setupWithFlagship({
      accounts: [
        { id: "acct_a", providerId: "openai-codex", label: "Personal", enabled: true },
        { id: "acct_b", providerId: "openai-codex", label: "Work #2", enabled: true },
      ],
    });
    // The `move` choice for a low login: the sibling is taken without a click.
    t.settings.setWhenLoginLow("move");
    t.setHeadroom("acct_a", 60);
    t.setHeadroom("acct_b", 40);
    await t.agent.converse("first");
    expect(t.agent.boundAccount()).toBe("acct_a");
    (t.sessions[0] as FakeSession).resolveNextPrompt();
    await tick();

    // The flagship runs dry between turns; the next turn rebinds at idle.
    t.setHeadroom("acct_a", 0);
    await t.agent.converse("second");
    await tick();
    expect(t.specs).toHaveLength(2);
    expect(runtimeKind(t.specs[1])).toBe("runtime-acct_b");
    expect(t.settings.getFirstmateAccount()).toBe("acct_b");
    // The old session was disposed; the move is a feed line, not a card.
    expect((t.sessions[0] as FakeSession).dispose).toHaveBeenCalled();
    const note = t.events.find(
      (event) => event.type === "firstmate_note" && event.text.includes("moved to Work #2"),
    );
    expect(note).toBeDefined();
    expect((t.sessions[1] as FakeSession).prompts[0]).toContain("second");
  });

  // INF-4104 piece 2: credits come after every included allowance.
  it("moves a seat on credits to a sibling that still has allowance, and comes back to credits when that runs out", async () => {
    const t = setupWithFlagship({
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
    // The `move` choice for a low login: the sibling is taken without a click.
    t.settings.setWhenLoginLow("move");
    t.setHeadroom("acct_a", 60);
    t.setHeadroom("acct_b", 0);
    await t.agent.converse("first");
    expect(t.agent.boundAccount()).toBe("acct_a");
    (t.sessions[0] as FakeSession).resolveNextPrompt();
    await tick();

    // Personal's allowance is spent with Work #2's spent too: it keeps going on credits.
    t.setHeadroom("acct_a", 0);
    await t.agent.converse("second");
    await tick();
    expect(t.specs).toHaveLength(1);
    expect((t.sessions[0] as FakeSession).prompts.at(-1)).toContain("second");
    (t.sessions[0] as FakeSession).resolveNextPrompt();
    await tick();

    // Work #2's allowance resets: the seat moves to it before spending more credits.
    t.setHeadroom("acct_b", 40);
    await t.agent.converse("third");
    await tick();
    expect(t.specs).toHaveLength(2);
    expect(runtimeKind(t.specs[1])).toBe("runtime-acct_b");
    expect(t.settings.getFirstmateAccount()).toBe("acct_b");
    expect(notes(t.events).some((text) => text.includes("moved to Work #2"))).toBe(true);
    expect((t.sessions[1] as FakeSession).prompts[0]).toContain("third");
    (t.sessions[1] as FakeSession).resolveNextPrompt();
    await tick();

    // Work #2 runs out with no switch of its own: the seat goes back to
    // Personal's credits rather than pausing, and stays there.
    t.setHeadroom("acct_b", 0);
    await t.agent.converse("fourth");
    await tick();
    expect(t.specs).toHaveLength(3);
    expect(runtimeKind(t.specs[2])).toBe("runtime-acct_a");
    expect(t.settings.getFirstmateAccount()).toBe("acct_a");
    expect((t.sessions[2] as FakeSession).prompts[0]).toContain("fourth");
    expect(t.cards().some((card) => card.id === "card-fm-no-headroom")).toBe(false);
  });

  // INF-5478's plan, piece 2 (docs/quota.md, "Saved resets on their own"):
  // accounts with allowance left come first; a seat on credits with no such
  // sibling weighs a saved reset and serves the turn on credits meanwhile.
  it("weighs a saved reset as a seat on credits serves the turn, and none while a sibling has room", async () => {
    const weighed: string[] = [];
    const t = setupWithFlagship({
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
      savedResetsSpent: (accountId) => weighed.push(accountId),
    });
    // The `move` choice for a low login: the sibling is taken without a click.
    t.settings.setWhenLoginLow("move");
    t.setHeadroom("acct_a", 60);
    t.setHeadroom("acct_b", 0);
    await t.agent.converse("first");
    (t.sessions[0] as FakeSession).resolveNextPrompt();
    await tick();
    expect(weighed).toEqual([]);

    // Personal is spent and Work #2 has no room: the reset is weighed, and the turn is served on credits at once.
    t.setHeadroom("acct_a", 0);
    await t.agent.converse("second");
    await tick();
    expect(weighed).toEqual(["acct_a"]);
    expect(t.specs).toHaveLength(1);
    expect((t.sessions[0] as FakeSession).prompts.at(-1)).toContain("second");
    expect(t.cards().some((card) => card.id === "card-fm-no-headroom")).toBe(false);
    (t.sessions[0] as FakeSession).resolveNextPrompt();
    await tick();

    // Work #2 has room again: the seat moves there, and nothing more is weighed.
    t.setHeadroom("acct_b", 40);
    await t.agent.converse("third");
    await tick();
    expect(t.settings.getFirstmateAccount()).toBe("acct_b");
    expect(weighed).toEqual(["acct_a"]);
  });

  // INF-5369 piece 6 (docs/quota.md, "Saved resets"), and INF-5478's
  // accepted plan piece 1 (docs/codex-client.md): a button uses it.
  it("says on the spent-allowance card when a saved reset would refill the account now, with a link to its usage page and a button that uses it", async () => {
    const live = parseCodexUsage(
      JSON.parse(
        readFileSync(
          join(__dirname, "../../../tests/fixtures/quota-credits/codex-usage-credits.json"),
          "utf8",
        ),
      ),
      Date.now(),
    ).savedResets as QuotaSavedResetsView;
    const spentCard = async (savedResets: QuotaSavedResetsView) => {
      const t = setupWithFlagship({
        accounts: [
          { id: "acct_w", providerId: "openai-codex", label: "Work", enabled: true, savedResets },
        ],
      });
      t.setHeadroom("acct_w", 50);
      await t.agent.converse("first");
      (t.sessions[0] as FakeSession).resolveNextPrompt();
      await tick();
      t.setHeadroom("acct_w", 0);
      await t.agent.converse("second");
      await tick();
      return t.cards().find((card) => card.id === "card-fm-no-headroom") as Card;
    };

    const applies = await spentCard({ ...live, applicable: live.available });
    expect(applies.body).toContain(
      m.cardSavedResetsNow({ account: "Codex · Work", count: live.available }),
    );
    expect(applies.body).toContain(`<a href="${SAVED_RESETS_PAGE.codex}"`);
    expect(applies.actions.map((action) => action.id)).toEqual([
      "use-saved-reset",
      "recheck-allowance",
      "open-settings",
    ]);

    // The live reading's saved reset does not apply yet: the card says nothing of it.
    expect((await spentCard(live)).body).not.toContain(SAVED_RESETS_PAGE.codex);
  });

  it("never rebinds mid-turn: a busy session steers instead", async () => {
    const t = setupWithFlagship({
      accounts: [
        { id: "acct_a", providerId: "openai-codex", label: "Personal", enabled: true },
        { id: "acct_b", providerId: "openai-codex", label: "Work #2", enabled: true },
      ],
    });
    t.setHeadroom("acct_a", 50);
    t.setHeadroom("acct_b", 40);
    await t.agent.converse("start");
    t.setHeadroom("acct_a", 0);
    await t.agent.converse("mid-turn steer");
    expect(t.specs).toHaveLength(1);
    expect((t.sessions[0] as FakeSession).steers).toHaveLength(1);
    expect(t.settings.getFirstmateAccount()).toBe("acct_a");
  });

  it("applies an explicit pin change at the next idle boundary", async () => {
    const t = setupWithFlagship({
      accounts: [
        { id: "acct_a", providerId: "openai-codex", label: "Personal", enabled: true },
        { id: "acct_b", providerId: "openai-codex", label: "Work #2", enabled: true },
      ],
    });
    t.setHeadroom("acct_a", 80);
    t.setHeadroom("acct_b", 70);
    await t.agent.converse("first");
    (t.sessions[0] as FakeSession).resolveNextPrompt();
    await tick();
    expect(t.agent.boundAccount()).toBe("acct_a");

    t.settings.setFirstmateAccount("acct_b");
    await t.agent.converse("second");
    await tick();
    expect(t.agent.boundAccount()).toBe("acct_b");
    expect(runtimeKind(t.specs[1])).toBe("runtime-acct_b");
    expect(t.ledger.at(-1)).toMatchObject({
      accountId: "acct_b",
      reasons: ["seat pinned", "the setting names Work #2"],
    });
  });

  it("moves an idle seat to a picked sibling account at once, on the same model, with its ledger row", async () => {
    const t = setupWithFlagship({
      accounts: [
        { id: "acct_a", providerId: "openai-codex", label: "Personal", enabled: true },
        { id: "acct_b", providerId: "openai-codex", label: "Work #2", enabled: true },
      ],
    });
    t.setHeadroom("acct_a", 80);
    t.setHeadroom("acct_b", 70);
    await t.agent.converse("first");
    (t.sessions[0] as FakeSession).resolveNextPrompt();
    await tick();
    expect(t.agent.boundAccount()).toBe("acct_a");

    // Settings writes the pick, then asks the idle seat to apply it now.
    t.settings.setFirstmateAccount("acct_b");
    await t.agent.applyAccountSetting();
    expect(t.agent.boundAccount()).toBe("acct_b");
    expect(runtimeKind(t.specs[1])).toBe("runtime-acct_b");
    expect(t.specs[1]?.model).toEqual(t.specs[0]?.model);
    expect(t.ledger.at(-1)).toMatchObject({
      taskId: "firstmate",
      provider: "openai-codex",
      accountId: "acct_b",
      reasons: ["seat pinned", "the setting names Work #2"],
    });
  });

  it("moves a busy session's model and account together at the next idle boundary", async () => {
    const t = setupWithFlagship({
      accounts: [
        { id: "acct_codex", providerId: "openai-codex", label: "Codex", enabled: true },
        { id: "acct_grok", providerId: "xai", label: "Grok", enabled: true },
      ],
      availableModels: [
        { provider: "openai-codex", id: "gpt-5.5" },
        { provider: "xai", id: "grok-4.6" },
      ],
    });
    t.setHeadroom("acct_codex", 40);
    t.setHeadroom("acct_grok", 60);
    await t.agent.converse("first");

    await t.agent.applyModelSetting({ provider: "xai", id: "grok-4.6" });
    expect(t.specs).toHaveLength(1);
    expect(t.agent.boundAccount()).toBe("acct_codex");

    (t.sessions[0] as FakeSession).resolveNextPrompt();
    await tick();
    await t.agent.converse("second");
    await tick();
    expect(t.specs[1]?.model).toEqual({ provider: "xai", id: "grok-4.6" });
    expect(t.agent.boundAccount()).toBe("acct_grok");
  });

  // INF-3307's audit, row 15: a model picked while the seat is still
  // attaching was saved and shown, but the first mate kept answering on the
  // model the attach had already resolved.
  it("runs on a model picked while the first mate is still attaching", async () => {
    const entered = deferred<void>();
    const attach = deferred<void>();
    const t = setupWithFlagship({
      accounts: [{ id: "acct_codex", providerId: "openai-codex", label: "Codex", enabled: true }],
      availableModels: [
        { provider: "openai-codex", id: "gpt-5.5" },
        { provider: "openai-codex", id: "gpt-5.4" },
      ],
      attachReady: () => {
        entered.resolve();
        return attach.promise;
      },
    });
    t.setHeadroom("acct_codex", 40);
    const first = t.agent.converse("first");
    // The attach has resolved the setting's model and is opening its session.
    await entered.promise;
    expect(t.agent.modelRef()).toEqual({ provider: "openai-codex", id: "gpt-5.5" });

    await t.agent.applyModelSetting({ provider: "openai-codex", id: "gpt-5.4" });
    attach.resolve();
    await first;
    await tick();

    expect(t.specs.at(-1)?.model).toEqual({ provider: "openai-codex", id: "gpt-5.4" });
    const session = t.sessions.at(-1) as FakeSession;
    expect(session.prompts.join("\n")).toContain("first");
    session.resolveNextPrompt();
    await tick();
  });

  it("applies a model picker change with its matching account before allowance checks", async () => {
    const t = setupWithFlagship({
      accounts: [
        { id: "acct_codex", providerId: "openai-codex", label: "Codex", enabled: true },
        { id: "acct_grok", providerId: "xai", label: "Grok", enabled: true },
      ],
      availableModels: [
        { provider: "openai-codex", id: "gpt-5.5" },
        { provider: "xai", id: "grok-4.6" },
      ],
    });
    t.setHeadroom("acct_codex", 40);
    t.setHeadroom("acct_grok", 60);
    await t.agent.converse("first");
    (t.sessions[0] as FakeSession).resolveNextPrompt();
    await tick();

    await t.agent.applyModelSetting({ provider: "xai", id: "grok-4.6" });

    expect(t.settings.getFirstmateModel()).toEqual({
      provider: "xai",
      id: "grok-4.6",
    });
    expect(t.settings.getFirstmateAccount()).toBe("acct_grok");
    expect(t.agent.boundAccount()).toBe("acct_grok");
    expect(t.specs[1]?.model).toEqual({ provider: "xai", id: "grok-4.6" });
    expect(runtimeKind(t.specs[1])).toBe("runtime-acct_grok");
    await tick();
    const grok = t.sessions[1] as FakeSession;
    expect(grok.prompts[0]).toContain("Your seat moved on the captain's word");
    grok.resolveNextPrompt();
    await tick();

    t.setHeadroom("acct_grok", 0);
    await t.agent.converse("second");
    await tick();
    const card = t
      .cards()
      .find((entry) => entry.title === "Your first mate has used up its allowance") as Card;
    expect(card.body).toBe(
      // The check time is the stand-in reading's own.
      `Grok has used up its allowance (resets Fri). Your messages are kept. Checked at ${clockTime(0)}. Move your first mate to Codex until then?`,
    );
    expect(card.body).toContain("Move your first mate to Codex");
  });

  it("records a Settings pick that moves the seat, and tells the new seat's first turn", async () => {
    const t = setupWithFlagship({
      claudeSeat: true,
      accounts: [
        { id: "acct_codex", providerId: "openai-codex", label: "Codex", enabled: true },
        claudeLogin(),
      ],
      availableModels: [CODEX_MODEL, CLAUDE_MODEL],
    });
    t.setHeadroom("acct_codex", 40);
    t.setHeadroom(CLAUDE_ACCOUNT, 80);
    await t.agent.converse("first");
    const codex = t.sessions[0] as FakeSession;
    codex.emitTurnEnd("Answered on Codex.");
    codex.resolveNextPrompt();
    await tick();

    await t.agent.applyModelSetting(CLAUDE_MODEL);
    expect(t.specs[1]?.binding).toMatchObject({ backend: "claude", accountId: CLAUDE_ACCOUNT });
    expect(t.ledger.at(-1)).toMatchObject({
      taskId: "firstmate",
      provider: "anthropic-claude",
      accountId: CLAUDE_ACCOUNT,
      reasons: ["seat pinned", "the captain picked Claude (claude-opus) in Settings"],
    });
    expect(notes(t.events)).toContain("Your first mate moved to Claude (claude-opus).");

    await t.agent.converse("second");
    await tick();
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE ref = 'seat-moved'").get()).toEqual({
      n: 1,
    });
    const claude = t.sessions[1] as FakeSession;
    expect(claude.prompts[0]).toContain(
      "Your seat moved on the captain's word: you now answer on Claude (claude-opus); before, you answered on Codex (gpt-5.5).",
    );
    expect(claude.prompts[0]).toContain('- the captain said "first"');
  });

  it("records no move when a Settings pick keeps the seat's account", async () => {
    const t = setupWithFlagship({
      accounts: [{ id: "acct_codex", providerId: "openai-codex", label: "Codex", enabled: true }],
      availableModels: [CODEX_MODEL, { provider: "openai-codex", id: "gpt-5.4" }],
    });
    t.setHeadroom("acct_codex", 40);
    await t.agent.converse("first");
    (t.sessions[0] as FakeSession).resolveNextPrompt();
    await tick();
    const ledgered = t.ledger.length;

    await t.agent.applyModelSetting({ provider: "openai-codex", id: "gpt-5.4" });
    await t.agent.converse("second");
    await tick();
    expect(t.specs[1]?.model).toEqual({ provider: "openai-codex", id: "gpt-5.4" });
    expect(t.agent.boundAccount()).toBe("acct_codex");
    expect(t.ledger).toHaveLength(ledgered);
    expect(notes(t.events).filter((text) => text.startsWith("Your first mate moved"))).toEqual([]);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE ref = 'seat-moved'").get()).toEqual({
      n: 0,
    });
  });

  it("offers a cross-provider move as a decision card (rung 2) and applies it on the user's word", async () => {
    const t = setupWithFlagship({
      accounts: [
        { id: "acct_codex", providerId: "openai-codex", label: "Personal", enabled: true },
        { id: "acct_grok", providerId: "xai", label: "Personal", enabled: true },
      ],
      availableModels: [
        { provider: "openai-codex", id: "gpt-5.5" },
        { provider: "xai", id: "grok-4.6" },
      ],
      catalog: [
        { provider: "codex", id: "gpt-5.5", label: "gpt-5.5" },
        {
          provider: "grok",
          id: "grok-4.6",
          label: "grok-4.6",
        },
      ],
    });
    t.setHeadroom("acct_codex", 40);
    t.setHeadroom("acct_grok", 61);
    await t.agent.converse("first");
    (t.sessions[0] as FakeSession).resolveNextPrompt();
    await tick();

    t.setHeadroom("acct_codex", 0);
    await t.agent.converse("second");
    await tick();
    // Benched: no new turn ran; the decision card offers the move.
    expect(t.specs).toHaveLength(1);
    const card = t
      .cards()
      .find((entry) => entry.title === "Your first mate has used up its allowance") as Card;
    expect(card.body).toBe(
      `Personal has used up its allowance (resets Fri). Your messages are kept. Checked at ${clockTime(0)}. Move your first mate to Grok until then?`,
    );
    expect(card.body).toContain("Move your first mate to Grok");
    const move = card.actions.find((action) => action.id === "move-flagship");
    expect(move?.effect).toEqual({ kind: "host", op: "move-flagship", arg: "xai" });
    // The parked turn is durable in the inbox.
    const parked = t.db.prepare("SELECT COUNT(*) AS n FROM inbox").get() as { n: number };
    expect(parked.n).toBe(1);

    t.supervisor.cardActions.act(card.id, "move-flagship");
    await tick();
    expect(t.settings.getFirstmateModel()).toEqual({
      provider: "xai",
      id: "grok-4.6",
    });
    expect(t.settings.getFirstmateAccount()).toBe("acct_grok");
    expect(runtimeKind(t.specs[1])).toBe("runtime-acct_grok");
    expect((t.sessions[1] as FakeSession).prompts[0]).toContain("second");
  });

  it("benches with the rung-3 card when nothing has headroom, then resumes on refresh", async () => {
    const t = setupWithFlagship({
      accounts: [{ id: "acct_a", providerId: "openai-codex", label: "Personal", enabled: true }],
    });
    t.setHeadroom("acct_a", 30);
    await t.agent.converse("first");
    (t.sessions[0] as FakeSession).resolveNextPrompt();
    await tick();

    t.setHeadroom("acct_a", 0);
    await t.agent.converse("are you there?");
    await tick();
    expect(t.specs).toHaveLength(1);
    expect((t.sessions[0] as FakeSession).prompts).toHaveLength(1);
    const card = t
      .cards()
      .find((entry) => entry.title === "Your first mate has used up its allowance") as Card;
    expect(card.body).toContain("No connected account has allowance left");
    expect(card.body).toContain("resets Fri");

    // The window resets: a quota refresh un-benches and delivers the turn.
    t.setHeadroom("acct_a", 100);
    t.agent.onQuotaRefreshed();
    await tick();
    expect((t.sessions[0] as FakeSession).prompts).toHaveLength(2);
    expect((t.sessions[0] as FakeSession).prompts[1]).toContain("are you there?");
  });
});

describe("the seat seam: the factory comes from the binding (W1 S4)", () => {
  it("fails a Claude binding with no Claude seat through the session-failure path", async () => {
    const { agent, specs, cards, turns } = setup({
      flagship: claudeFlagship(),
      availableModels: () => [CLAUDE_SEAT_MODEL],
    });
    await agent.converse("hello");
    await tick();
    // The Pi seat is never asked to serve a Claude binding.
    expect(specs).toEqual([]);
    expect(turns).toEqual([{ trigger: "captain", failed: true, reason: "no_session" }]);
    const card = cards().find((entry) => entry.title === "Your first mate hit a problem");
    expect(card?.body).toContain("Claude cannot run your first mate.");
  });

  it("derives only a model the seat can serve: a refused Claude login's is passed over (W1 S12)", async () => {
    const claudeSpecs: SessionSpec[] = [];
    const { agent, settings, specs } = setup({
      flagship: claudeFlagship({ refused: true }),
      availableModels: () => [CLAUDE_SEAT_MODEL, { provider: "fm-mock", id: "mock-1" }],
      claudeSeat: async (spec) => {
        claudeSpecs.push(spec);
        return fakeSession(CLAUDE_SEAT_MODEL);
      },
    });
    await agent.converse("hello");
    expect(settings.getFirstmateModel()).toEqual({ provider: "fm-mock", id: "mock-1" });
    expect(specs[0]?.model).toEqual({ provider: "fm-mock", id: "mock-1" });
    expect(claudeSpecs).toEqual([]);
  });

  it("serves a Claude binding on the Claude seat, resuming the Claude session only", async () => {
    const claudeSpecs: SessionSpec[] = [];
    const claudeSession = fakeSession({ provider: "anthropic-claude", id: "claude-opus" });
    const { agent, specs, settings, usages, events } = setup({
      flagship: claudeFlagship(),
      availableModels: () => [CLAUDE_SEAT_MODEL],
      claudeSeat: async (spec) => {
        claudeSpecs.push(spec);
        return claudeSession;
      },
    });
    settings.setFirstmateSessionFile("/tmp/fm/sessions/pi.jsonl");
    settings.setFirstmateClaudeSession("claude-previous");
    await agent.converse("hello");
    expect(specs).toEqual([]);
    expect(claudeSpecs).toHaveLength(1);
    expect(claudeSpecs[0]?.binding).toEqual({ backend: "claude", accountId: CLAUDE_ACCOUNT });
    expect(resumeOf(claudeSpecs[0])).toEqual({ backend: "claude", sessionId: "claude-previous" });
    // The attached session is now the Claude backend's rolling session; the
    // Pi pointer is that backend's, and stays as it was.
    expect(settings.getFirstmateClaudeSession()).toBe("fm-session");
    expect(settings.getFirstmateSessionFile()).toBe("/tmp/fm/sessions/pi.jsonl");

    // A turn on it reads like any other: the agent never learns the backend.
    claudeSession.emitTurnEnd("Hi.", { input: 12, output: 3 });
    claudeSession.resolveNextPrompt();
    await tick();
    expect(claudeSession.prompts).toHaveLength(1);
    expect(usages).toContainEqual({
      accountId: CLAUDE_ACCOUNT,
      model: { provider: "anthropic-claude", id: "claude-opus" },
      usage: { input: 12, output: 3 },
    });
    expect(events).toContainEqual({
      type: "turn_end",
      taskId: "firstmate",
      usage: { input: 12, output: 3 },
    });
  });

  it.each(["claude", "pi"] as const)(
    "INF-447: renews an overflowed %s seat with its digest and automatically answers hello once",
    async (backend) => {
      const model =
        backend === "claude" ? CLAUDE_SEAT_MODEL : { provider: "fm-mock", id: "mock-1" };
      const first = fakeSession(model);
      const fresh = fakeSession(model);
      first.sessionId = "overflowed";
      fresh.sessionId = "fresh";
      const opened: SessionSpec[] = [];
      const open = async (spec: SessionSpec) => {
        opened.push(spec);
        return opened.length === 1 ? first : fresh;
      };
      const f = setup(
        backend === "claude"
          ? {
              flagship: claudeFlagship(),
              availableModels: () => [model],
              claudeSeat: open,
            }
          : { piSeat: open },
      );
      await f.agent.converse("Remember the composer fix");
      first.emitTurnEnd("I kept the composer fix.");
      first.resolveNextPrompt();
      await tick();
      first.holdSteers();
      first.dispose = vi.fn(() => {
        first.takeUndeliveredSteers();
      });
      await f.agent.converse("hello");
      await f.agent.converse("Keep the pasted image fix too");
      first.emit({
        type: "turn_failed",
        taskId: "firstmate",
        error: "Prompt is too long",
        contextOverflow: true,
      });
      first.resolveNextPrompt();
      await tick();
      expect(opened).toHaveLength(2);
      expect(resumeOf(opened[1])).toBeUndefined();
      expect(fresh.prompts.join("\n")).toContain("composer fix");
      expect(fresh.prompts.join("\n")).toContain("hello");
      expect(fresh.prompts.join("\n")).toContain("Keep the pasted image fix too");
      expect(f.cards().some((c) => c.title === "Your first mate hit a problem")).toBe(false);
      fresh.emitTurnEnd("Hello, Captain.");
      fresh.resolveNextPrompt();
      await tick();
      if (backend === "claude") expect(f.settings.getFirstmateClaudeSession()).toBe("fresh");
      expect(f.agent.isBusy()).toBe(false);
      expect(opened).toHaveLength(2);
    },
  );

  it("INF-447: a refused fresh conversation stops automatic renewal instead of looping", async () => {
    const opened: SessionSpec[] = [];
    const sessions = [fakeSession(CLAUDE_SEAT_MODEL), fakeSession(CLAUDE_SEAT_MODEL)];
    const f = setup({
      flagship: claudeFlagship(),
      availableModels: () => [CLAUDE_SEAT_MODEL],
      claudeSeat: async (spec) => {
        opened.push(spec);
        return sessions[opened.length - 1]!;
      },
    });
    await f.agent.converse("hello");
    for (const session of sessions) {
      session.emit({
        type: "turn_failed",
        taskId: "firstmate",
        error: "Prompt is too long",
        contextOverflow: true,
      });
      session.resolveNextPrompt();
      await tick();
    }
    expect(opened).toHaveLength(2);
    expect(f.cards().some((c) => c.title === "Your first mate hit a problem")).toBe(true);
    expect(f.agent.isBusy()).toBe(false);
  });

  it("carries a seat's typed cut-off through to the feed unchanged", async () => {
    const claudeSession = fakeSession({ provider: "anthropic-claude", id: "claude-opus" });
    const { agent, events } = setup({
      flagship: claudeFlagship(),
      availableModels: () => [CLAUDE_SEAT_MODEL],
      claudeSeat: async () => claudeSession,
    });
    await agent.converse("hello");
    claudeSession.emit({
      type: "turn_failed",
      taskId: "firstmate",
      error: "Claude is out of allowance until 5pm.",
      cutOff: { class: "no_headroom", resetsAt: 1_790_450_000_000 },
    });
    claudeSession.emit({ type: "turn_end", taskId: "firstmate" });
    claudeSession.resolveNextPrompt();
    await tick();
    expect(events).toContainEqual({
      type: "turn_failed",
      taskId: "firstmate",
      error: formatFlagshipError(
        { provider: "anthropic-claude", id: "claude-opus" },
        "Claude is out of allowance until 5pm.",
      ),
      cutOff: { class: "no_headroom", resetsAt: 1_790_450_000_000 },
    });
  });

  it("records a seat's typed cut-off on the account it is bound to", async () => {
    const claudeSession = fakeSession({ provider: "anthropic-claude", id: "claude-opus" });
    const noteCutOff = vi.fn();
    const { agent } = setup({
      flagship: claudeFlagship(),
      availableModels: () => [CLAUDE_SEAT_MODEL],
      claudeSeat: async () => claudeSession,
      noteCutOff,
    });
    await agent.converse("hello");
    // A failed turn with no class is not a cut-off.
    claudeSession.emit({ type: "turn_failed", taskId: "firstmate", error: "overloaded" });
    claudeSession.emit({ type: "turn_end", taskId: "firstmate" });
    claudeSession.resolveNextPrompt();
    await tick();
    expect(noteCutOff).not.toHaveBeenCalled();

    await agent.converse("again");
    claudeSession.emit({
      type: "turn_failed",
      taskId: "firstmate",
      error: "Claude said no.",
      cutOff: { class: "refused" },
    });
    claudeSession.emit({ type: "turn_end", taskId: "firstmate" });
    claudeSession.resolveNextPrompt();
    await tick();
    expect(noteCutOff).toHaveBeenCalledTimes(1);
    expect(noteCutOff).toHaveBeenCalledWith(CLAUDE_ACCOUNT, { class: "refused" });
  });

  it("resumes a Pi binding from the Pi file, leaving the Claude session alone", async () => {
    const file = join(scratchDir("infinitary-seat-resume-"), "rolling.jsonl");
    writeFileSync(file, "");
    const { agent, specs, settings } = setup();
    settings.setFirstmateSessionFile(file);
    settings.setFirstmateClaudeSession("claude-previous");
    await agent.converse("hello");
    expect(specs[0]?.binding).toMatchObject({ backend: "pi" });
    expect(resumeOf(specs[0])).toEqual({ backend: "pi", sessionFile: file });
    expect(settings.getFirstmateClaudeSession()).toBe("claude-previous");
  });
});

describe("the Claude seat under the agent (W1 S6)", () => {
  it("answers a captain turn, recording the client's real resumable id", async () => {
    // W1 S6: acceptance is not completion; wait for the owner's settled witness.
    let settled!: () => void;
    const turnSettled = new Promise<void>((resolve) => {
      settled = resolve;
    });
    const clientReady = deferred<void>();
    const seat = claudeSeat(answersEveryPrompt, clientReady.promise);
    const { agent, settings, usages, events, turns } = setup({
      flagship: claudeFlagship(),
      availableModels: () => [CLAUDE_SEAT_MODEL],
      claudeSeat: seat.factory,
      onTurnSettled: settled,
    });
    await agent.converse("hello");
    // INF-2287: acceptance and a clock tick can both precede the client's
    // attachment. Hold that ordering without slowing the real filesystem.
    await tick();
    expect(seat.scripted.attachments).toHaveLength(0);
    expect(turns).toEqual([]);
    clientReady.resolve();
    await turnSettled;
    expect(turns).toEqual([{ trigger: "captain", failed: false }]);
    expect(inputText(seat.scripted.harness().inputs[0])).toContain("hello");
    // The id the agent will resume is the one the client runs under.
    expect(settings.getFirstmateClaudeSession()).toBe(seat.scripted.harness().options.sessionId);
    // The turn's usage under the session's model, with the model the client
    // named as serving it, which the ledger records apart.
    const usage = {
      input: 12,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      models: [{ model: "claude-opus", input: 12, output: 3, cacheRead: 0, cacheWrite: 0 }],
    };
    expect(usages).toContainEqual({
      accountId: CLAUDE_ACCOUNT,
      model: { provider: "anthropic-claude", id: "claude-opus" },
      usage,
    });
    expect(events).toContainEqual({ type: "turn_end", taskId: "firstmate", usage });
    await seat.closed();
  });

  it("drains a typed wake into a turn on the Claude seat, rendered once", async () => {
    // W1 S6: both turns must settle before their asynchronous client inputs are read.
    const settlements: (() => void)[] = [];
    const firstTurn = new Promise<void>((resolve) => {
      settlements.push(resolve);
    });
    const wakeTurn = new Promise<void>((resolve) => {
      settlements.push(resolve);
    });
    const seat = claudeSeat(answersEveryPrompt);
    const { agent, turns } = setup({
      flagship: claudeFlagship(),
      availableModels: () => [CLAUDE_SEAT_MODEL],
      claudeSeat: seat.factory,
      onTurnSettled: () => settlements.shift()?.(),
    });
    await agent.converse("start work");
    await firstTurn;
    expect(turns).toEqual([{ trigger: "captain", failed: false }]);
    const wake: TypedWake = {
      facts: {
        kind: "idle-stall",
        task: { id: "ab12", title: "Fix" },
        crewmate: "crewmate 1",
        key: "FI3-1",
        idleMs: 20 * 60_000,
        thread: false,
        nudged: true,
        wakes: 1,
        last: { kind: "report", excerpt: "Done with step one." },
      },
      ways: idleStallWays("ab12"),
    };
    agent.notifyOp(wake, "agent", "ab12");
    await wakeTurn;
    expect(turns).toEqual([
      { trigger: "captain", failed: false },
      { trigger: "operation", failed: false },
    ]);
    const inputs = seat.scripted.harness().inputs;
    expect(inputs).toHaveLength(2);
    expect(inputText(inputs[1])).toContain(renderWake(wake));
    await seat.closed();
  });

  it("re-parks a steer the client never took in as a turn of its own", async () => {
    // W1 S6: drive each step from the client's input receipt, not a fixed tick.
    let firstReceived!: () => void;
    const firstInput = new Promise<void>((resolve) => {
      firstReceived = resolve;
    });
    let steerReceived!: () => void;
    const steerInput = new Promise<void>((resolve) => {
      steerReceived = resolve;
    });
    let recovered!: () => void;
    const recoveredInput = new Promise<void>((resolve) => {
      recovered = resolve;
    });
    let first: { emit: (message: unknown) => void } | undefined;
    const seat = claudeSeat((message, emit, attachment) => {
      if (attachment > 1) {
        answersEveryPrompt(message, emit);
        recovered();
        return;
      }
      // The first client takes the prompt in and never answers the steer.
      if (!first) {
        first = { emit };
        emit(claudeSays.running);
        emit(claudeSays.ack(message));
        firstReceived();
      } else {
        steerReceived();
      }
    });
    const { agent, turns } = setup({
      flagship: claudeFlagship(),
      availableModels: () => [CLAUDE_SEAT_MODEL],
      claudeSeat: seat.factory,
    });
    await agent.converse("start work");
    // Steer only once the client has taken the prompt, then exit only once
    // it has received the steer (without acknowledging it).
    await firstInput;
    expect(seat.scripted.attachments[0]?.inputs).toHaveLength(1);
    const firstClient = seat.scripted.harness();
    await agent.converse("also this");
    await steerInput;
    expect(inputText(firstClient.inputs[1])).toContain("also this");
    // The client exits with the steer still in its queue.
    firstClient.end();
    await recoveredInput;
    // Audit row 5: neither the unread steer nor the failed live input is lost.
    // The unread steer runs first; its success makes the held live input due.
    await vi.waitFor(() => expect(turns).toHaveLength(3));
    expect(seat.scripted.attachments).toHaveLength(2);
    expect(inputText(seat.scripted.harness().inputs[0])).toContain("[user]\nalso this");
    expect(inputText(seat.scripted.harness().inputs[1])).toContain("[user]\nstart work");
    await seat.closed();
  });
});

describe("the Claude seat starts over when its instructions change (docs/claude-client.md)", () => {
  const seatMovedRows = (t: Awaited<ReturnType<typeof claudeLoginSeat>>) =>
    t.db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE ref = 'seat-moved'").get();

  it("carries a session that started over at the idle boundary with the digest, and resumes it after", async () => {
    const t = await claudeLoginSeat();
    await t.agent.converse("remember the word cobalt");
    const seat = t.sessions[0] as FakeSession;
    seat.emitTurnEnd("Noted: cobalt.");
    seat.resolveNextPrompt();
    await tick();
    expect(t.settings.getFirstmateClaudeSession()).toBe("claude-session");
    const ledgered = t.ledger.length;

    // Served changed instructions, the Claude session starts over, as its
    // client resumes a session only on the prompt it started under.
    seat.serveInstructions = (instructions) => {
      seat.served.push(instructions);
      seat.sessionId = "claude-renewed";
      seat.renewal = { from: "claude-session", changed: ["instructions"] };
    };
    await t.agent.converse("which word?");
    await tick();
    expect(t.sessions).toHaveLength(1);
    expect(t.settings.getFirstmateClaudeSession()).toBe("claude-renewed");
    expect(t.ledger.slice(ledgered)).toEqual([
      {
        taskId: "firstmate",
        provider: "anthropic-claude",
        accountId: CLAUDE_ACCOUNT,
        reasons: [
          "seat renewed",
          "the served instructions changed since session claude-session started",
          "a resumed session serves the prompt it started under, so a new session starts with the digest",
        ],
      },
    ]);
    expect(notes(t.events)).toContain(
      "Your first mate's instructions changed, so it carries on in a new conversation on Claude (claude-opus).",
    );
    expect(seatMovedRows(t)).toEqual({ n: 1 });
    // This very turn is told, with the turns the new session has not seen.
    expect(seat.prompts[1]).toContain(
      "[fm-op] Your instructions changed, so you now answer in a new conversation on Claude (claude-opus). Your conversation before the change does not carry over to this one",
    );
    expect(seat.prompts[1]).toContain(
      '- the captain said "remember the word cobalt"; you used no tool; you said "Noted: cobalt."',
    );
    expect(seat.prompts[1]).toContain("which word?");
    // INF-1746 R1: the new conversation read no context, so this one is complete.
    expect(seat.prompts[0]).toContain(DELIVERY_COMPLETE);
    expect(seat.prompts[1]).toContain(DELIVERY_COMPLETE);
    seat.emitTurnEnd("Cobalt.");
    seat.resolveNextPrompt();
    await tick();

    // Unchanged instructions: the same session, nothing announced again.
    seat.serveInstructions = (instructions) => {
      seat.served.push(instructions);
    };
    await t.agent.converse("thanks");
    await tick();
    // The delivered wake was acknowledged with its turn; none is queued again.
    expect(seatMovedRows(t)).toEqual({ n: 0 });
    expect(seat.prompts[2]).not.toContain("new conversation");
    expect(t.settings.getFirstmateClaudeSession()).toBe("claude-renewed");
    expect(t.ledger.slice(ledgered)).toHaveLength(1);
  });

  it("resumes the recorded session after a restart when its instructions are unchanged", async () => {
    const before = await claudeLoginSeat();
    await before.agent.converse("remember the word cobalt");
    (before.sessions[0] as FakeSession).emitTurnEnd("Noted.");
    (before.sessions[0] as FakeSession).resolveNextPrompt();
    await tick();
    before.agent.dispose();

    const after = await claudeLoginSeat({ restart: { accounts: before.accounts, db: before.db } });
    await after.agent.converse("which word?");
    await tick();
    expect(after.specs[0]?.shape).toMatchObject({
      record: { resume: { backend: "claude", sessionId: "claude-session" } },
    });
    expect(after.settings.getFirstmateClaudeSession()).toBe("claude-session");
    expect(seatMovedRows(after)).toEqual({ n: 0 });
    expect(after.ledger).toEqual([]);
    expect((after.sessions[0] as FakeSession).prompts[0]).not.toContain("new conversation");
  });

  it("carries a session that started over at a restart's open with the digest", async () => {
    const before = await claudeLoginSeat();
    await before.agent.converse("remember the word cobalt");
    (before.sessions[0] as FakeSession).emitTurnEnd("Noted.");
    (before.sessions[0] as FakeSession).resolveNextPrompt();
    await tick();
    before.agent.dispose();

    const after = await claudeLoginSeat({
      restart: { accounts: before.accounts, db: before.db, renewedFrom: "claude-session" },
    });
    await after.agent.converse("which word?");
    await tick();
    expect(after.settings.getFirstmateClaudeSession()).toBe("claude-renewed");
    expect(after.ledger.map((row) => row.reasons[0])).toEqual(["seat renewed"]);
    expect(notes(after.events)).toContain(
      "Your first mate's instructions changed, so it carries on in a new conversation on Claude (claude-opus).",
    );
    const prompt = (after.sessions[0] as FakeSession).prompts[0];
    expect(prompt).toContain("[fm-op] Your instructions changed");
    expect(prompt).toContain('- the captain said "remember the word cobalt"');
  });
});

describe("Firstmate Auto shares one allowance-ranked pool across serving backends", () => {
  it("a fresh install picks Claude when its allowance comes first, despite Codex also serving", async () => {
    const t = setupWithFlagship({
      claudeSeat: true,
      accounts: [
        claudeLogin(),
        {
          id: "acct_codex",
          providerId: "openai-codex",
          label: "Codex",
          enabled: true,
          connected: true,
        },
      ],
      availableModels: [CODEX_MODEL, CLAUDE_MODEL],
      catalog: [
        { provider: "claude", id: CLAUDE_MODEL.id, label: "Claude" },
        { provider: "codex", id: CODEX_MODEL.id, label: "Codex" },
      ],
    });
    await t.agent.converse("hello");
    expect(t.settings.getFirstmateModel()).toEqual(CLAUDE_MODEL);
    expect(t.specs[0]?.binding).toEqual({ backend: "claude", accountId: CLAUDE_ACCOUNT });
  });

  it("Auto picks Codex when its allowance comes first, despite Claude also serving", async () => {
    const t = setupWithFlagship({
      claudeSeat: true,
      accounts: [
        claudeLogin(),
        {
          id: "acct_codex",
          providerId: "openai-codex",
          label: "Codex",
          enabled: true,
          connected: true,
        },
      ],
      availableModels: [CLAUDE_MODEL, CODEX_MODEL],
      catalog: [
        { provider: "codex", id: CODEX_MODEL.id, label: "Codex" },
        { provider: "claude", id: CLAUDE_MODEL.id, label: "Claude" },
      ],
    });
    await t.agent.converse("hello");
    expect(t.settings.getFirstmateModel()).toEqual(CODEX_MODEL);
    expect(t.specs[0]?.binding.backend).toBe("pi");
  });
});
