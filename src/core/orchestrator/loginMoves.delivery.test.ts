import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_COST_LIMIT } from "@shared/costLimit";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import { describe, expect, it, vi } from "vitest";
import {
  type FakeCrewmate,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import type { FakeSessionOptions } from "../../../tests/helpers/fakeSession";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { crewmateHandoverDir } from "../paths";
import { type AccountPool, AccountSelector } from "../routing/accountRouter";
import { CostLimitStore } from "../storage/costLimitStore";
import { DecisionStore } from "../storage/decisionStore";
import { STUCK_REFUSAL_LIMIT } from "../storage/inboxStore";
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
  /** The model a task commissioned here is routed to; it starts on Personal. */
  routedModel?: { provider: string; id: string },
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
    ...(routedModel ? { routedModel } : {}),
    accounts: {
      selectForSpawn: () => (routedModel ? "acct_personal" : undefined),
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

/** How many times the center was told something sent reached a crewmate. */
const reached = (h: ReturnType<typeof setup>) =>
  h.events.filter((event) => event.type === "task_event" && event.kind === "reached").length;

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

describe("a bound task with no open conversation that is started from the backlog", () => {
  it("is opened on the named login alone and hears what waited on its lane", async () => {
    const first = fakeCrewmate({});
    const h = threeLogins("openai-codex", first, fakeCrewmate({}), false);
    seedRunning(h, { provider: "openai-codex", id: "gpt-6.1-terra" }, "/tmp/s1.jsonl");
    h.supervisor.hostOps.moveToBacklog("t-move", {
      actor: "firstmate",
      via: "tool",
      decision: null,
    });
    // Its cost limit kept the move from reopening it, so it is still to move.
    h.costs.placeHold({ taskId: "t-move", limitUsd: 50, spentUsd: 51.5, at: Date.now() });
    await h.supervisor.loginMoves.moveOff("acct_personal", "acct_work");
    h.costs.clearHold("t-move");
    const record = h.tasks.get("t-move");
    if (!record) throw new Error("the seeded task is gone");

    h.supervisor.hostOps.startFromBacklog(record, "captain");
    await vi.waitFor(() => expect(first.promptCalls).toHaveLength(1));
    // Personal was never opened: the one conversation is Work's.
    expect(h.sessionSpecs).toHaveLength(1);
    expect(boundAccount(h, 0)).toBe("acct_work");
    expect(h.tasks.get("t-move")?.accountId).toBe("acct_work");
    expect(h.tasks.get("t-move")?.backlogSince).toBeNull();
  });
});

describe("a move still picking its account, and what it owes the task when it is over", () => {
  /** A pick that waits until the case lets it go. */
  function heldPick() {
    let release: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { beforePick: () => waiting, release };
  }

  it("keeps a sent message's delivery when an ordinary delivery follows it, so a task since moved to the backlog still reads it", async () => {
    const pick = heldPick();
    const first = fakeCrewmate({});
    const second = fakeCrewmate({});
    const h = threeLogins("openai-codex", first, second, false, undefined, pick.beforePick);
    seedRunning(h, { provider: "openai-codex", id: "gpt-6.1-terra" }, "/tmp/s1.jsonl");
    // Its conversation is open and idle on Personal. No move binds it yet, so no pick is asked for.
    await h.supervisor.steer.steerCrewmate("t-move", "carry on");
    await vi.waitFor(() => expect(first.promptCalls).toHaveLength(1));
    first.finishPrompt();
    await tick();

    const moving = h.supervisor.loginMoves.moveOff("acct_personal", "acct_work");
    void h.supervisor.steer.steerCrewmate("t-move", "Check the footer too.");
    await tick();
    // An ordinary delivery, as a sweep makes, comes behind the sent one.
    h.supervisor.watch.deliverLane("t-move");
    h.supervisor.hostOps.moveToBacklog("t-move", {
      actor: "firstmate",
      via: "tool",
      decision: null,
    });
    expect(second.promptCalls).toHaveLength(0);

    pick.release();
    await moving;
    await vi.waitFor(() => expect(second.promptCalls).toHaveLength(1));
    expect(boundAccount(h, 1)).toBe("acct_work");
    expect(second.promptCalls[0]?.startsWith(BACKLOG_STEER_LINE)).toBe(true);
    expect(second.promptCalls[0]).toContain("Check the footer too.");
  });

  it("answers a sent message as kept, not delivered, when a cost limit holds the task while it reopens", async () => {
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
    const resume = h.supervisor.sessions.resumeTask.bind(h.supervisor.sessions);
    vi.spyOn(h.supervisor.sessions, "resumeTask").mockImplementation(async (...args) => {
      const resumed = await resume(...args);
      // The task passes its cost limit while its conversation opens.
      h.costs.placeHold({ taskId: "t-move", limitUsd: 50, spentUsd: 51.5, at: Date.now() });
      return resumed;
    });

    const moving = h.supervisor.loginMoves.moveOff("acct_personal", "acct_work");
    const steered = h.supervisor.steer.steerCrewmate("t-move", "Check the footer too.");
    await tick();
    pick.release();
    await moving;
    await expect(steered).resolves.toBe("recorded-retrying");
    expect(boundAccount(h, 0)).toBe("acct_work");
    expect(first.promptCalls).toHaveLength(0);
    // Its row still waits on the lane for the hold to end.
    expect(h.inbox.allFor("t-move")).toHaveLength(1);
  });

  it("tells the sender of a message to an open, idle task nothing until the move is over, and then that it is kept when a cost limit came up", async () => {
    const pick = heldPick();
    const first = fakeCrewmate({});
    const second = fakeCrewmate({});
    const h = threeLogins("openai-codex", first, second, false, undefined, pick.beforePick);
    seedRunning(h, { provider: "openai-codex", id: "gpt-6.1-terra" }, "/tmp/s1.jsonl");
    // Its conversation is open and idle on Personal.
    await h.supervisor.steer.steerCrewmate("t-move", "carry on");
    await vi.waitFor(() => expect(first.promptCalls).toHaveLength(1));
    first.finishPrompt();
    await tick();
    const resume = h.supervisor.sessions.resumeTask.bind(h.supervisor.sessions);
    vi.spyOn(h.supervisor.sessions, "resumeTask").mockImplementation(async (...args) => {
      const resumed = await resume(...args);
      // The task passes its cost limit while its conversation opens on Work.
      h.costs.placeHold({ taskId: "t-move", limitUsd: 50, spentUsd: 51.5, at: Date.now() });
      return resumed;
    });

    const moving = h.supervisor.loginMoves.moveOff("acct_personal", "acct_work");
    let answer: string | undefined;
    const steered = Promise.resolve(
      h.supervisor.steer.steerCrewmate("t-move", "Check the footer too."),
    ).then((delivery) => {
      answer = delivery;
    });
    await tick();
    // The move still picks its account: nothing is claimed, and Personal reads nothing more.
    expect(answer).toBeUndefined();
    expect(first.promptCalls).toHaveLength(1);

    pick.release();
    await moving;
    await steered;
    expect(answer).toBe("recorded-retrying");
    expect(boundAccount(h, 1)).toBe("acct_work");
    expect(first.promptCalls).toHaveLength(1);
    expect(second.promptCalls).toHaveLength(0);
    expect(h.inbox.allFor("t-move")).toHaveLength(1);
  });

  it("goes to the login a second click named while the first click's pick was still out, with the message that waited", async () => {
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

    const toWork = h.supervisor.loginMoves.moveOff("acct_personal", "acct_work");
    const steered = h.supervisor.steer.steerCrewmate("t-move", "Check the footer too.");
    await tick();
    // The card is read again and names Spare before Work's pick is back.
    const toSpare = h.supervisor.loginMoves.moveOff("acct_personal", "acct_spare");
    pick.release();
    await Promise.all([toWork, toSpare]);

    await expect(steered).resolves.toBe("mid-turn");
    await vi.waitFor(() => expect(first.promptCalls).toHaveLength(1));
    // One conversation, on Spare: neither Personal nor Work was opened.
    expect(h.sessionSpecs).toHaveLength(1);
    expect(boundAccount(h, 0)).toBe("acct_spare");
    expect(h.tasks.get("t-move")?.accountId).toBe("acct_spare");
    expect(first.promptCalls[0]).toContain("Check the footer too.");
    expect(h.supervisor.loginMoves.bindsTask("t-move")).toBe(false);
  });

  it("keeps the pick already out when the same login is named again, and asks for no second one", async () => {
    const pick = heldPick();
    let picks = 0;
    const first = fakeCrewmate({});
    const h = threeLogins("openai-codex", first, fakeCrewmate({}), false, undefined, () => {
      picks += 1;
      return pick.beforePick();
    });
    seedRunning(h, { provider: "openai-codex", id: "gpt-6.1-terra" }, "/tmp/s1.jsonl");

    const offered = h.supervisor.loginMoves.moveOff("acct_personal", "acct_work");
    const steered = h.supervisor.steer.steerCrewmate("t-move", "Check the footer too.");
    await tick();
    // The allowance is read again and offers the same move, twice.
    const again = h.supervisor.loginMoves.moveOff("acct_personal", "acct_work");
    const onceMore = h.supervisor.loginMoves.moveOff("acct_personal", "acct_work");
    pick.release();
    await Promise.all([offered, again, onceMore]);

    await expect(steered).resolves.toBe("mid-turn");
    await vi.waitFor(() => expect(first.promptCalls).toHaveLength(1));
    expect(picks).toBe(1);
    expect(h.sessionSpecs).toHaveLength(1);
    expect(boundAccount(h, 0)).toBe("acct_work");
    expect(first.promptCalls[0]).toContain("Check the footer too.");
  });
});

describe("a task still to move whose conversation is restarted", () => {
  const MODEL = { provider: "openai-codex", id: "gpt-6.1-terra" };
  /** The provider's words, the same on every refused request. */
  const REFUSAL = '{"detail":"Bad Request"}';

  it("opens its new conversation on the named login when its turn reached the context limit with only its brief", async () => {
    const first = fakeCrewmate({ model: MODEL });
    const second = fakeCrewmate({
      model: MODEL,
      sessionId: "s2",
      resume: { backend: "pi", sessionFile: "/tmp/s2.jsonl" },
    });
    const h = threeLogins("openai-codex", first, second, false, undefined, undefined, MODEL);
    const { taskId } = await h.supervisor.intake.commission({
      title: "Fix the login form",
      intent: intentOf("fix the login form"),
    });
    await vi.waitFor(() => expect(first.promptCalls).toHaveLength(1));
    expect(h.tasks.get(taskId)?.accountId).toBe("acct_personal");
    // The click names Work while the first turn runs, so the task is still to move.
    await h.supervisor.loginMoves.moveOff("acct_personal", "acct_work");
    expect(h.tasks.get(taskId)?.accountId).toBe("acct_personal");

    first.emit({
      type: "turn_failed",
      taskId,
      error: "This request exceeds the context window.",
      contextOverflow: true,
    });
    first.emit({ type: "turn_end", taskId });
    first.finishPrompt();
    await vi.waitFor(() => expect(second.promptCalls).toHaveLength(1));
    // Nothing waited on its lane: the restart's own words are its turn, on Work.
    expect(h.sessionSpecs).toHaveLength(2);
    expect(boundAccount(h, 1)).toBe("acct_work");
    expect(h.tasks.get(taskId)?.accountId).toBe("acct_work");
    expect(second.promptCalls[0]).toContain("context limit");
    expect(first.promptCalls).toHaveLength(1);
  });

  it("opens its new conversation on the named login, with the guidance it kept, when the first mate restarts it after refusals", async () => {
    const first = fakeCrewmate({});
    const second = fakeCrewmate({});
    const h = threeLogins("openai-codex", first, second, false);
    seedRunning(h, MODEL, "/tmp/s1.jsonl");
    await h.supervisor.steer.steerCrewmate("t-move", "carry on with the handoff");
    for (let refusal = 1; refusal <= STUCK_REFUSAL_LIMIT; refusal++) {
      if (refusal > 1) {
        const due = Math.max(
          Date.now(),
          ...h.inbox.allFor("t-move").map((row) => row.nextAttemptAt ?? 0),
        );
        vi.setSystemTime(due);
        await h.supervisor.watch.sweepInbox(due);
      }
      await vi.waitFor(() => expect(first.promptCalls).toHaveLength(refusal));
      first.emit({ type: "turn_failed", taskId: "t-move", error: REFUSAL });
      first.emit({ type: "turn_end", taskId: "t-move" });
      first.finishPrompt();
      await tick();
    }
    expect(h.inbox.stuck("t-move")).toBeDefined();
    // Its cost limit kept the click's move from reopening it, so it is still to move.
    h.costs.placeHold({ taskId: "t-move", limitUsd: 50, spentUsd: 51.5, at: Date.now() });
    await h.supervisor.loginMoves.moveOff("acct_personal", "acct_work");
    h.costs.clearHold("t-move");
    expect(h.tasks.get("t-move")?.accountId).toBe("acct_personal");

    expect(await h.supervisor.turns.unstick("t-move", "restart")).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(second.promptCalls).toHaveLength(1));
    expect(h.sessionSpecs).toHaveLength(2);
    expect(boundAccount(h, 1)).toBe("acct_work");
    expect(h.tasks.get("t-move")?.accountId).toBe("acct_work");
    expect(second.promptCalls[0]).toContain(
      "the provider refused your earlier conversation's requests the same way several times in a row",
    );
    expect(second.promptCalls[0]).toContain("carry on with the handoff");
    expect(first.promptCalls).toHaveLength(STUCK_REFUSAL_LIMIT);
  });

  it("neither moves nor opens a task restarted after refusals while its cost limit holds it, and restarts it on the named login once the limit is answered", async () => {
    const first = fakeCrewmate({});
    const second = fakeCrewmate({});
    const h = threeLogins("openai-codex", first, second, false);
    seedRunning(h, MODEL, "/tmp/s1.jsonl");
    await h.supervisor.steer.steerCrewmate("t-move", "carry on with the handoff");
    for (let refusal = 1; refusal <= STUCK_REFUSAL_LIMIT; refusal++) {
      if (refusal > 1) {
        const due = Math.max(
          Date.now(),
          ...h.inbox.allFor("t-move").map((row) => row.nextAttemptAt ?? 0),
        );
        vi.setSystemTime(due);
        await h.supervisor.watch.sweepInbox(due);
      }
      await vi.waitFor(() => expect(first.promptCalls).toHaveLength(refusal));
      first.emit({ type: "turn_failed", taskId: "t-move", error: REFUSAL });
      first.emit({ type: "turn_end", taskId: "t-move" });
      first.finishPrompt();
      await tick();
    }
    h.costs.placeHold({ taskId: "t-move", limitUsd: 50, spentUsd: 51.5, at: Date.now() });
    await h.supervisor.loginMoves.moveOff("acct_personal", "acct_work");

    expect(await h.supervisor.turns.unstick("t-move", "restart")).toMatchObject({ ok: true });
    await tick();
    // The limit stands: no login change, no new conversation, no prompt.
    expect(h.sessionSpecs).toHaveLength(1);
    expect(h.tasks.get("t-move")?.accountId).toBe("acct_personal");
    expect(second.promptCalls).toHaveLength(0);
    expect(first.promptCalls).toHaveLength(STUCK_REFUSAL_LIMIT);

    h.costs.clearHold("t-move");
    await h.supervisor.watch.sweepInbox(Date.now());
    await vi.waitFor(() => expect(second.promptCalls).toHaveLength(1));
    expect(h.sessionSpecs).toHaveLength(2);
    expect(boundAccount(h, 1)).toBe("acct_work");
    expect(h.tasks.get("t-move")?.accountId).toBe("acct_work");
    expect(second.promptCalls[0]).toContain(
      "the provider refused your earlier conversation's requests the same way several times in a row",
    );
    expect(second.promptCalls[0]).toContain("carry on with the handoff");
  });

  it("starts no turn for a task at the context limit whose cost limit is reached while its login is picked, and continues it on the named login once the limit is answered", async () => {
    let release: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = fakeCrewmate({ model: MODEL });
    const second = fakeCrewmate({
      model: MODEL,
      sessionId: "s2",
      resume: { backend: "pi", sessionFile: "/tmp/s2.jsonl" },
    });
    const h = threeLogins("openai-codex", first, second, false, undefined, () => waiting, MODEL);
    const { taskId } = await h.supervisor.intake.commission({
      title: "Fix the login form",
      intent: intentOf("fix the login form"),
    });
    await vi.waitFor(() => expect(first.promptCalls).toHaveLength(1));
    await h.supervisor.loginMoves.moveOff("acct_personal", "acct_work");

    first.emit({
      type: "turn_failed",
      taskId,
      error: "This request exceeds the context window.",
      contextOverflow: true,
    });
    first.emit({ type: "turn_end", taskId });
    first.finishPrompt();
    await tick();
    // The restart's move is picking its account when the task passes its cost limit.
    h.costs.placeHold({ taskId, limitUsd: 50, spentUsd: 51.5, at: Date.now() });
    release();
    await tick();
    expect(h.sessionSpecs).toHaveLength(1);
    expect(h.tasks.get(taskId)?.accountId).toBe("acct_personal");
    expect(second.promptCalls).toHaveLength(0);

    h.costs.clearHold(taskId);
    await h.supervisor.watch.sweepInbox(Date.now());
    await vi.waitFor(() => expect(second.promptCalls).toHaveLength(1));
    expect(h.sessionSpecs).toHaveLength(2);
    expect(boundAccount(h, 1)).toBe("acct_work");
    expect(h.tasks.get(taskId)?.accountId).toBe("acct_work");
    expect(second.promptCalls[0]).toContain("context limit");
    expect(first.promptCalls).toHaveLength(1);
  });

  /** The task passes its cost limit as each conversation opens, while `opening.holds`. */
  function costLimitWhileOpening(h: ReturnType<typeof threeLogins>, taskId: () => string) {
    const opening = { holds: true };
    const resume = h.supervisor.sessions.resumeTask.bind(h.supervisor.sessions);
    vi.spyOn(h.supervisor.sessions, "resumeTask").mockImplementation(async (...args) => {
      const resumed = await resume(...args);
      if (opening.holds)
        h.costs.placeHold({ taskId: taskId(), limitUsd: 50, spentUsd: 51.5, at: Date.now() });
      return resumed;
    });
    return opening;
  }

  it("starts no turn when its cost limit is reached while the restarted conversation opens on the named login, and takes it once the limit is answered", async () => {
    const first = fakeCrewmate({ model: MODEL });
    const second = fakeCrewmate({
      model: MODEL,
      sessionId: "s2",
      resume: { backend: "pi", sessionFile: "/tmp/s2.jsonl" },
    });
    const h = threeLogins("openai-codex", first, second, false, undefined, undefined, MODEL);
    const { taskId } = await h.supervisor.intake.commission({
      title: "Fix the login form",
      intent: intentOf("fix the login form"),
    });
    await vi.waitFor(() => expect(first.promptCalls).toHaveLength(1));
    await h.supervisor.loginMoves.moveOff("acct_personal", "acct_work");
    const opening = costLimitWhileOpening(h, () => taskId);

    first.emit({
      type: "turn_failed",
      taskId,
      error: "This request exceeds the context window.",
      contextOverflow: true,
    });
    first.emit({ type: "turn_end", taskId });
    first.finishPrompt();
    await vi.waitFor(() => expect(h.sessionSpecs).toHaveLength(2));
    await tick();
    // It moved and its conversation is open on Work, and the limit stands: it is told nothing.
    expect(boundAccount(h, 1)).toBe("acct_work");
    expect(second.promptCalls).toHaveLength(0);

    const before = reached(h);
    opening.holds = false;
    h.costs.clearHold(taskId);
    await h.supervisor.watch.sweepInbox(Date.now());
    await vi.waitFor(() => expect(second.promptCalls).toHaveLength(1));
    expect(second.promptCalls[0]).toContain("context limit");
    expect(h.sessionSpecs).toHaveLength(2);
    expect(first.promptCalls).toHaveLength(1);
    // Nobody sent the restart's own turn: the center draws nothing for it.
    expect(reached(h)).toBe(before);
  });

  it("tells the center a message reached the task once, when the reopened task takes it, and not while a cost limit that came up as it opened stands", async () => {
    const first = fakeCrewmate({});
    const h = threeLogins("openai-codex", first, fakeCrewmate({}), false);
    seedRunning(h, MODEL, "/tmp/s1.jsonl");
    // Sent while its cost limit stands, so it waits on the lane.
    h.costs.placeHold({ taskId: "t-move", limitUsd: 50, spentUsd: 51.5, at: Date.now() });
    await expect(h.supervisor.steer.steerCrewmate("t-move", "Check the footer too.")).resolves.toBe(
      "recorded-held",
    );
    const opening = costLimitWhileOpening(h, () => "t-move");
    h.costs.clearHold("t-move");
    const before = reached(h);

    await h.supervisor.watch.sweepInbox(Date.now());
    await vi.waitFor(() => expect(h.sessionSpecs).toHaveLength(1));
    await tick();
    // The limit was reached again as the conversation opened: nothing reached the task.
    expect(first.promptCalls).toHaveLength(0);
    expect(reached(h)).toBe(before);

    opening.holds = false;
    h.costs.clearHold("t-move");
    await h.supervisor.watch.sweepInbox(Date.now());
    await vi.waitFor(() => expect(first.promptCalls).toHaveLength(1));
    expect(first.promptCalls[0]).toContain("Check the footer too.");
    expect(reached(h)).toBe(before + 1);
  });

  it("starts no turn when its cost limit is reached again while a restart kept for a hold reopens, and takes it once that limit is answered", async () => {
    let release: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = fakeCrewmate({ model: MODEL });
    const second = fakeCrewmate({
      model: MODEL,
      sessionId: "s2",
      resume: { backend: "pi", sessionFile: "/tmp/s2.jsonl" },
    });
    const h = threeLogins("openai-codex", first, second, false, undefined, () => waiting, MODEL);
    const { taskId } = await h.supervisor.intake.commission({
      title: "Fix the login form",
      intent: intentOf("fix the login form"),
    });
    await vi.waitFor(() => expect(first.promptCalls).toHaveLength(1));
    await h.supervisor.loginMoves.moveOff("acct_personal", "acct_work");
    first.emit({
      type: "turn_failed",
      taskId,
      error: "This request exceeds the context window.",
      contextOverflow: true,
    });
    first.emit({ type: "turn_end", taskId });
    first.finishPrompt();
    await tick();
    // Held while its login is picked: the restart is kept on its lane.
    h.costs.placeHold({ taskId, limitUsd: 50, spentUsd: 51.5, at: Date.now() });
    release();
    await tick();
    expect(h.sessionSpecs).toHaveLength(1);

    // The limit is answered, and reached again as the lane's sweep reopens the task.
    const opening = costLimitWhileOpening(h, () => taskId);
    h.costs.clearHold(taskId);
    await h.supervisor.watch.sweepInbox(Date.now());
    await vi.waitFor(() => expect(h.sessionSpecs).toHaveLength(2));
    await tick();
    expect(boundAccount(h, 1)).toBe("acct_work");
    expect(second.promptCalls).toHaveLength(0);

    const before = reached(h);
    opening.holds = false;
    h.costs.clearHold(taskId);
    await h.supervisor.watch.sweepInbox(Date.now());
    await vi.waitFor(() => expect(second.promptCalls).toHaveLength(1));
    expect(second.promptCalls[0]).toContain("context limit");
    expect(h.sessionSpecs).toHaveLength(2);
    expect(first.promptCalls).toHaveLength(1);
    expect(reached(h)).toBe(before);
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
