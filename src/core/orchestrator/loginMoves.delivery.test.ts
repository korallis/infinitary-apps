import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_COST_LIMIT } from "@shared/costLimit";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import { describe, expect, it, vi } from "vitest";
import {
  type FakeCrewmate,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import type { FakeSessionOptions } from "../../../tests/helpers/fakeSession";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { crewmateHandoverDir } from "../paths";
import { type AccountPool, AccountSelector } from "../routing/accountRouter";
import { CostLimitStore } from "../storage/costLimitStore";
import { DecisionStore } from "../storage/decisionStore";
import { keepHandoverFiles } from "../tasks/handoverFiles";
import { seedTask } from "../tasks/seedTask";
import { crewmateRestartText } from "./crewSession";
import { BACKLOG_STEER_LINE } from "./crewTurns";
import { loginLowCard, loginLowCardId } from "./loginCards";

fakeCrewTimersEachTest();

// The approved plan for several logins of one provider, piece 3. "Ask": the
// click moves work to the login the card named, and lanes on the spent login
// renew on the new login at their next delivery. "A moved lane": it uses the
// conversation renewal a resume already has, a Claude conversation is never
// carried across accounts, and nothing is retried inside a running turn.
// Each case drives a real CrewSupervisor through the crew harness.

/** A crewmate whose backend queues words sent during a turn on its lane. */
function queueingCrewmate(options: FakeSessionOptions): FakeCrewmate {
  return {
    ...fakeCrewmate(options),
    controlProfile: {
      steer: "followup-queue",
      interruptGranularity: "process",
      quotaEvents: false,
      backgroundWork: "host",
      failureSignals: "text",
    },
    steer: vi.fn(async () => {
      throw new Error("this crewmate cannot be steered mid-turn");
    }),
  };
}

/** A provider's typed run-out on a login, as the vault keeps it; it refills a day after the fake clock's start. */
const RAN_OUT = { class: "no_headroom" as const, since: 0, resetsAt: 86_400_000 * 20_000 };

/** Three logins of one provider: Personal, where the task runs, Work and Spare. */
function threeLogins(
  provider: string,
  first: FakeCrewmate,
  second: FakeCrewmate,
  claude: boolean,
  cutOffs = new Map<string, typeof RAN_OUT>(),
  /** Each account pick waits for this, as a pick that reads a login's models does. */
  beforePick: () => Promise<void> = async () => {},
) {
  let costs: CostLimitStore | undefined;
  const pool: AccountPool = {
    list: () =>
      [
        { id: "acct_personal", label: "Personal" },
        { id: "acct_work", label: "Work" },
        { id: "acct_spare", label: "Spare" },
      ].map((login) => ({ ...login, providerId: provider, enabled: true })),
    // The click already made Work the login in use.
    pinnedAccount: () => "acct_work",
    connectedSync: () => true,
    withheldReason: () => undefined,
    cutOff: (accountId) => cutOffs.get(accountId),
    markSelected: () => {},
  };
  let accounts: AccountSelector | undefined;
  const h = setup(first, {
    crewmates: [second],
    costLimits: (db) => {
      costs = new CostLimitStore(db);
      return { store: costs, appLimit: () => DEFAULT_COST_LIMIT };
    },
    serveability: {
      cutOff: (accountId) => cutOffs.get(accountId),
      providerName: () => "ChatGPT",
    },
    ...(claude
      ? {
          alsoServes: ["claude"] as const,
          bind: async (accountId) => ({ backend: "claude" as const, accountId: accountId ?? "" }),
        }
      : {}),
    accounts: {
      selectForSpawn: () => undefined,
      pickForSpawn: async (...args) => {
        await beforePick();
        return (accounts as AccountSelector).pickForSpawn(...args);
      },
      reselectForResume: (...args) => (accounts as AccountSelector).reselectForResume(...args),
      labelOf: (accountId) => (accounts as AccountSelector).labelOf(accountId),
    },
  });
  accounts = new AccountSelector({
    pool,
    quota: { latest: () => undefined },
    flagshipAccountId: () => null,
    decisions: new DecisionStore(h.db),
    loginInUse: { whenLow: () => "ask", pin: () => {} },
  });
  return { ...h, costs: costs as CostLimitStore };
}

function seedRunning(
  h: ReturnType<typeof setup>,
  model: { provider: string; id: string },
  sessionFile: string,
) {
  seedTask(h.tasks, {
    id: "t-move",
    title: "Fix the login form",
    prompt: "old work",
    repoId: null,
    repoDir: "/tmp/repo",
    worktreeDir: "/tmp/wt",
    branch: "fm/task-t-move",
    sessionFile,
    accountId: "acct_personal",
    model,
    status: "idle",
    createdAt: Date.now(),
  });
  h.tasks.recordBrief("t-move", ["Goal: fix the login form."]);
}

const boundAccount = (h: ReturnType<typeof setup>, index: number) =>
  (h.sessionSpecs[index]?.binding as { accountId?: string } | undefined)?.accountId;

describe("a task inside a turn when its login's work is moved", () => {
  it("takes its next delivery on the named login, in a new Claude conversation that is told its brief", async () => {
    const earlier = "0f3a2c1e-5b6d-4e7f-8a9b-0c1d2e3f4a5b";
    const opened = "7d1e2f30-4a5b-4c6d-8e9f-a0b1c2d3e4f5";
    const first = queueingCrewmate({
      sessionId: earlier,
      resume: { backend: "claude", sessionId: earlier },
    });
    // Work's own Claude Code folder holds no transcript of the earlier
    // conversation, so its client opens another one.
    const second = queueingCrewmate({
      sessionId: opened,
      resume: { backend: "claude", sessionId: opened },
    });
    const h = threeLogins(CLAUDE_PROVIDER_ID, first, second, true);
    seedRunning(h, { provider: CLAUDE_PROVIDER_ID, id: "claude-fable-5-1" }, earlier);

    await h.supervisor.steer.steerCrewmate("t-move", "carry on");
    await tick();
    expect(first.promptCalls).toHaveLength(1);
    expect(boundAccount(h, 0)).toBe("acct_personal");

    // The captain's click names Work while the turn runs: nothing moves inside it.
    await h.supervisor.loginMoves.moveOff("acct_personal", "acct_work");
    await h.supervisor.steer.steerCrewmate("t-move", "Check the footer too.");
    await tick();
    expect(h.tasks.get("t-move")?.accountId).toBe("acct_personal");
    expect(h.sessionSpecs).toHaveLength(1);

    first.finishPrompt();
    await vi.waitFor(() => expect(second.promptCalls).toHaveLength(1));
    // The words that waited went to Work, never to Personal or Spare.
    expect(first.promptCalls).toHaveLength(1);
    expect(boundAccount(h, 1)).toBe("acct_work");
    expect(h.tasks.get("t-move")?.accountId).toBe("acct_work");
    // It asked Work's client for the recorded conversation, which opened
    // another: the earlier one is not carried across the two logins.
    expect(
      h.sessionSpecs[1]?.shape.turns === "rolling" && h.sessionSpecs[1].shape.record.resume,
    ).toEqual({ backend: "claude", sessionId: earlier });
    expect(h.tasks.get("t-move")?.sessionFile).toBe(opened);
    expect(
      h.tasks
        .timeline("t-move")
        .filter((event) => event.kind === "note")
        .map((event) => event.text),
    ).toContain("its earlier conversation could not be reopened, so it starts a fresh one");
    expect(second.promptCalls[0]).toContain(
      crewmateRestartText({
        restart: { from: earlier, changed: "unopenable" },
        taskKey: h.tasks.get("t-move")?.key ?? "",
        brief: "Goal: fix the login form.",
      }).split("\n\n")[0] ?? "",
    );
    expect(second.promptCalls[0]).toContain("Goal: fix the login form.");
    expect(second.promptCalls[0]).toContain("Check the footer too.");
    expect(
      h.events.flatMap((event) => (event.type === "firstmate_note" ? [event.text] : [])),
    ).toContain("Fix the login form moved from Personal to Work.");
  });

  it("takes its next delivery on the named login with its own transcript, on a backend that keeps one", async () => {
    const first = queueingCrewmate({});
    const second = queueingCrewmate({});
    const h = threeLogins("openai-codex", first, second, false);
    seedRunning(h, { provider: "openai-codex", id: "gpt-6.1-terra" }, "/tmp/s1.jsonl");

    await h.supervisor.steer.steerCrewmate("t-move", "carry on");
    await tick();
    await h.supervisor.loginMoves.moveOff("acct_personal", "acct_work");
    await h.supervisor.steer.steerCrewmate("t-move", "Check the footer too.");
    await tick();
    expect(h.sessionSpecs).toHaveLength(1);

    first.finishPrompt();
    await vi.waitFor(() => expect(second.promptCalls).toHaveLength(1));
    expect(first.promptCalls).toHaveLength(1);
    expect(boundAccount(h, 1)).toBe("acct_work");
    expect(h.specs[1]).toMatchObject({ resumeToken: "/tmp/s1.jsonl" });
    expect(h.tasks.get("t-move")?.accountId).toBe("acct_work");
    expect(second.promptCalls[0]).toContain("Check the footer too.");
    expect(second.promptCalls[0]).not.toContain("Goal: fix the login form.");
  });

  it("moves at its turn's end though its old login was cut off meanwhile, and is not held by it", async () => {
    const cutOffs = new Map<string, typeof RAN_OUT>();
    const first = queueingCrewmate({});
    const second = queueingCrewmate({});
    const h = threeLogins("openai-codex", first, second, false, cutOffs);
    seedRunning(h, { provider: "openai-codex", id: "gpt-6.1-terra" }, "/tmp/s1.jsonl");

    await h.supervisor.steer.steerCrewmate("t-move", "carry on");
    await tick();
    await h.supervisor.loginMoves.moveOff("acct_personal", "acct_work");
    await h.supervisor.steer.steerCrewmate("t-move", "Check the footer too.");
    await tick();
    // The provider now refuses Personal: a lane on it would be held until its refill.
    cutOffs.set("acct_personal", RAN_OUT);

    first.finishPrompt();
    await vi.waitFor(() => expect(second.promptCalls).toHaveLength(1));
    expect(boundAccount(h, 1)).toBe("acct_work");
    expect(h.tasks.get("t-move")?.accountId).toBe("acct_work");
    expect(second.promptCalls[0]).toContain("Check the footer too.");
    expect(first.promptCalls).toHaveLength(1);
  });

  it("moves at its turn's end with nothing waiting on its lane", async () => {
    const first = queueingCrewmate({});
    const second = queueingCrewmate({});
    const h = threeLogins("openai-codex", first, second, false);
    seedRunning(h, { provider: "openai-codex", id: "gpt-6.1-terra" }, "/tmp/s1.jsonl");

    await h.supervisor.steer.steerCrewmate("t-move", "carry on");
    await tick();
    await h.supervisor.loginMoves.moveOff("acct_personal", "acct_work");
    first.finishPrompt();
    await vi.waitFor(() => expect(h.tasks.get("t-move")?.accountId).toBe("acct_work"));
    await vi.waitFor(() => expect(boundAccount(h, 1)).toBe("acct_work"));
    // It reopened there and was told nothing: there was nothing to tell.
    expect(second.promptCalls).toHaveLength(0);
  });

  it("stays where it is when the named login was cut off after the click", async () => {
    const cutOffs = new Map<string, typeof RAN_OUT>();
    const first = queueingCrewmate({});
    const second = queueingCrewmate({});
    const h = threeLogins("openai-codex", first, second, false, cutOffs);
    seedRunning(h, { provider: "openai-codex", id: "gpt-6.1-terra" }, "/tmp/s1.jsonl");

    await h.supervisor.steer.steerCrewmate("t-move", "carry on");
    await tick();
    await h.supervisor.loginMoves.moveOff("acct_personal", "acct_work");
    await h.supervisor.steer.steerCrewmate("t-move", "Check the footer too.");
    await tick();
    // Work's meter still reads room, but its provider has refused it since.
    cutOffs.set("acct_work", RAN_OUT);

    first.finishPrompt();
    await vi.waitFor(() => expect(first.promptCalls).toHaveLength(2));
    expect(first.promptCalls[1]).toContain("Check the footer too.");
    expect(h.tasks.get("t-move")?.accountId).toBe("acct_personal");
    expect(h.sessionSpecs).toHaveLength(1);
    expect(second.promptCalls).toHaveLength(0);
  });
});

// The plan's "A moved lane" again, for the two ways round it: words sent
// after the click on a backend that takes them mid-turn, and a move made at
// once for a task another hold keeps closed.
describe("a task whose backend takes words mid-turn, after its login's work is moved", () => {
  it("keeps words sent after the click out of the turn on the old login, and reads them on the named one", async () => {
    const first = fakeCrewmate({});
    const second = fakeCrewmate({});
    const h = threeLogins("openai-codex", first, second, false);
    seedRunning(h, { provider: "openai-codex", id: "gpt-6.1-terra" }, "/tmp/s1.jsonl");

    await h.supervisor.steer.steerCrewmate("t-move", "carry on");
    await tick();
    expect(first.promptCalls).toHaveLength(1);
    await h.supervisor.loginMoves.moveOff("acct_personal", "acct_work");
    await expect(h.supervisor.steer.steerCrewmate("t-move", "Check the footer too.")).resolves.toBe(
      "queued-next-turn",
    );
    // The sweep that steers a waiting row into a running turn passes it too.
    await h.supervisor.watch.sweepTaskLane("t-move", Date.now() + 3_600_000);
    await tick();
    expect(first.steer).not.toHaveBeenCalled();
    expect(h.tasks.get("t-move")?.accountId).toBe("acct_personal");

    first.finishPrompt();
    await vi.waitFor(() => expect(second.promptCalls).toHaveLength(1));
    expect(boundAccount(h, 1)).toBe("acct_work");
    expect(h.tasks.get("t-move")?.accountId).toBe("acct_work");
    expect(second.promptCalls[0]).toContain("Check the footer too.");
    expect(first.steer).not.toHaveBeenCalled();
    expect(first.promptCalls).toHaveLength(1);
  });
});

describe("an idle task held at its cost limit when its login's work is moved", () => {
  it("is not reopened by the move, and takes its next words on the named login once the limit is answered", async () => {
    const first = fakeCrewmate({});
    const h = threeLogins("openai-codex", first, fakeCrewmate({}), false);
    seedRunning(h, { provider: "openai-codex", id: "gpt-6.1-terra" }, "/tmp/s1.jsonl");
    h.costs.placeHold({ taskId: "t-move", limitUsd: 50, spentUsd: 51.5, at: Date.now() });

    await h.supervisor.loginMoves.moveOff("acct_personal", "acct_work");
    await tick();
    expect(h.sessionSpecs).toHaveLength(0);
    expect(h.tasks.get("t-move")?.accountId).toBe("acct_personal");
    await expect(h.supervisor.steer.steerCrewmate("t-move", "Check the footer too.")).resolves.toBe(
      "recorded-held",
    );
    await tick();
    expect(h.sessionSpecs).toHaveLength(0);

    // The captain allows more: the task's next words open it on Work alone.
    h.costs.clearHold("t-move");
    await h.supervisor.steer.steerCrewmate("t-move", "And the header.");
    await vi.waitFor(() => expect(first.promptCalls).toHaveLength(1));
    expect(h.sessionSpecs).toHaveLength(1);
    expect(boundAccount(h, 0)).toBe("acct_work");
    expect(h.tasks.get("t-move")?.accountId).toBe("acct_work");
    expect(first.promptCalls[0]).toContain("Check the footer too.");
    expect(first.promptCalls[0]).toContain("And the header.");
  });
});

describe("a task in the backlog, bound to a move, when a message's files have crossed", () => {
  it("is opened on the named login alone and reads the first mate's message there", async () => {
    const first = fakeCrewmate({});
    const h = threeLogins("openai-codex", first, fakeCrewmate({}), false);
    seedRunning(h, { provider: "openai-codex", id: "gpt-6.1-terra" }, "/tmp/s1.jsonl");
    expect(
      h.supervisor.hostOps.moveToBacklog("t-move", {
        actor: "firstmate",
        via: "tool",
        decision: null,
      }).ok,
    ).toBe(true);
    // Its cost limit kept the move from reopening it, so it is still to move.
    h.costs.placeHold({ taskId: "t-move", limitUsd: 50, spentUsd: 51.5, at: Date.now() });
    await h.supervisor.loginMoves.moveOff("acct_personal", "acct_work");
    h.costs.clearHold("t-move");
    expect(h.tasks.get("t-move")?.accountId).toBe("acct_personal");
    seedTask(h.tasks, { id: "t-finder", title: "Find the screenshot", status: "idle" });
    const picture = join(scratchDir("infinitary-handed-"), "clipped card.png");
    writeFileSync(picture, "a picture of the clipped card");
    await keepHandoverFiles([picture], crewmateHandoverDir(h.paths, "t-finder"));

    await h.supervisor.steer.steerAfterFiles("t-finder", "t-move", "look at it", {
      response: { mode: "guidance-only" as const },
    });
    await vi.waitFor(() => expect(first.promptCalls).toHaveLength(1));
    // Personal was never opened: the one conversation is Work's.
    expect(h.sessionSpecs).toHaveLength(1);
    expect(boundAccount(h, 0)).toBe("acct_work");
    expect(h.tasks.get("t-move")?.accountId).toBe("acct_work");
    expect(first.promptCalls[0]?.startsWith(BACKLOG_STEER_LINE)).toBe(true);
    expect(first.promptCalls[0]).toMatch(/Files handed to you from [^\n]*\n\nlook at it/);
  });
});

describe("a move still picking its account when a message is sent to its task", () => {
  /** A pick that waits until the case lets it go. */
  function heldPick() {
    let release: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { beforePick: () => waiting, release };
  }

  it("hands a backlog task the message whose files crossed meanwhile, on the named login, with no second message or Start", async () => {
    const pick = heldPick();
    const first = fakeCrewmate({});
    const h = threeLogins(
      "openai-codex",
      first,
      fakeCrewmate({}),
      false,
      undefined,
      pick.beforePick,
    );
    seedRunning(h, { provider: "openai-codex", id: "gpt-6.1-terra" }, "/tmp/s1.jsonl");
    h.supervisor.hostOps.moveToBacklog("t-move", {
      actor: "firstmate",
      via: "tool",
      decision: null,
    });
    seedTask(h.tasks, { id: "t-finder", title: "Find the screenshot", status: "idle" });
    const picture = join(scratchDir("infinitary-handed-"), "clipped card.png");
    writeFileSync(picture, "a picture of the clipped card");
    await keepHandoverFiles([picture], crewmateHandoverDir(h.paths, "t-finder"));

    // The click's own move is still picking its account.
    const moving = h.supervisor.loginMoves.moveOff("acct_personal", "acct_work");
    await h.supervisor.steer.steerAfterFiles("t-finder", "t-move", "look at it", {
      response: { mode: "guidance-only" as const },
    });
    await vi.waitFor(() => expect(h.supervisor.steer.handingOver("t-move")).toBe(false));
    await tick();
    expect(h.sessionSpecs).toHaveLength(0);

    pick.release();
    await moving;
    await vi.waitFor(() => expect(first.promptCalls).toHaveLength(1));
    expect(h.sessionSpecs).toHaveLength(1);
    expect(boundAccount(h, 0)).toBe("acct_work");
    expect(first.promptCalls[0]?.startsWith(BACKLOG_STEER_LINE)).toBe(true);
    expect(first.promptCalls[0]).toMatch(/Files handed to you from [^\n]*\n\nlook at it/);
  });

  it("answers a message sent to its task only once the task has reopened on the named login", async () => {
    const pick = heldPick();
    const first = fakeCrewmate({});
    const h = threeLogins(
      "openai-codex",
      first,
      fakeCrewmate({}),
      false,
      undefined,
      pick.beforePick,
    );
    seedRunning(h, { provider: "openai-codex", id: "gpt-6.1-terra" }, "/tmp/s1.jsonl");

    const moving = h.supervisor.loginMoves.moveOff("acct_personal", "acct_work");
    let answer: string | undefined;
    const steered = h.supervisor.steer
      .steerCrewmate("t-move", "Check the footer too.")
      .then((delivery) => {
        answer = delivery;
      });
    await tick();
    // Nothing has reopened yet, so nothing is claimed.
    expect(answer).toBeUndefined();
    expect(h.sessionSpecs).toHaveLength(0);

    pick.release();
    await moving;
    await steered;
    expect(answer).toBe("mid-turn");
    await vi.waitFor(() => expect(first.promptCalls).toHaveLength(1));
    expect(h.sessionSpecs).toHaveLength(1);
    expect(boundAccount(h, 0)).toBe("acct_work");
    expect(first.promptCalls[0]).toContain("Check the footer too.");
  });
});

describe("the low-login card's Move button, as the host admits its click", () => {
  it("refuses the button as it stood before the card named another login, and takes the one it shows", async () => {
    const h = threeLogins("openai-codex", queueingCrewmate({}), queueingCrewmate({}), false);
    const clicked: string[] = [];
    h.supervisor.loginMoves.onClick = (accountId) => clicked.push(accountId);
    const offering = (other: { accountId: string; label: string }) =>
      loginLowCard({
        providerId: "openai-codex",
        providerName: "ChatGPT",
        accountId: "acct_personal",
        login: "Personal",
        percentLeft: 8,
        other,
      });
    const cardId = loginLowCardId("openai-codex");
    h.supervisor.cards.hostCards.raiseHostCard(offering({ accountId: "acct_work", label: "Work" }));
    // Work ran low too: the card is revised to offer Spare.
    h.supervisor.cards.hostCards.raiseHostCard(
      offering({ accountId: "acct_spare", label: "Spare" }),
    );
    // The captain's window still showed Move to Work.
    expect(() =>
      h.supervisor.cardActions.act(cardId, "move-login-acct_personal-acct_work"),
    ).toThrow("This choice is not offered on this card.");
    expect(clicked).toEqual([]);
    h.supervisor.cardActions.act(cardId, "move-login-acct_personal-acct_spare");
    await tick();
    expect(clicked).toEqual(["acct_spare"]);
  });
});
