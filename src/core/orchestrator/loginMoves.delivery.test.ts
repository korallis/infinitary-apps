import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_COST_LIMIT } from "@shared/costLimit";
import type { FmEvent } from "@shared/events";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import { describe, expect, it, vi } from "vitest";
import {
  type FakeCrewmate,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  reboot,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import type { FakeSessionOptions } from "../../../tests/helpers/fakeSession";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { crewmateHandoverDir } from "../paths";
import { loginMoveUnchecked, startLowLogins } from "../quota/homeLowLogins";
import type { LoginReading } from "../quota/lowLogins";
import { type AccountPool, AccountSelector } from "../routing/accountRouter";
import type { Router } from "../routing/router";
import { CardStore } from "../storage/cardStore";
import { CostLimitStore } from "../storage/costLimitStore";
import { DecisionStore } from "../storage/decisionStore";
import { STUCK_REFUSAL_LIMIT } from "../storage/inboxStore";
import { SettingsStore } from "../storage/settingsStore";
import { keepHandoverFiles } from "../tasks/handoverFiles";
import { seedTask } from "../tasks/seedTask";
import { SUPERVISOR_STEER } from "./crewRuntime";
import { crewmateRestartText } from "./crewSession";
import type { AccountAttachment, CrewSupervisorOptions } from "./crewSupervisorOptions";
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
  const attachment: AccountAttachment = {
    selectForSpawn: () => (routedModel ? "acct_personal" : undefined),
    pickForSpawn: async (...args) => {
      await beforePick();
      return (accounts as AccountSelector).pickForSpawn(...args);
    },
    reselectForResume: (...args) => (accounts as AccountSelector).reselectForResume(...args),
    labelOf: (accountId) => (accounts as AccountSelector).labelOf(accountId),
  };
  // The app's own saved record of the moves still to make.
  let moveRecord: NonNullable<CrewSupervisorOptions["loginMoveRecord"]> | undefined;
  const h = setup(first, {
    loginMoveRecord: (db) => {
      const settings = new SettingsStore(db);
      moveRecord = {
        read: () => settings.getLoginMoves(),
        write: (moves) => settings.setLoginMoves(moves),
        // As the home wires it: read from the saved card and the record of ended answers.
        unchecked: (move) => {
          const cards = new CardStore(db);
          return loginMoveUnchecked(
            {
              cards: {
                chosenAction: (id) => cards.chosenAction(id),
                stored: (id) => cards.get(id),
              },
              settings,
              vault: {
                list: (providerId) => pool.list().filter((a) => a.providerId === providerId),
              },
            },
            move,
          );
        },
      };
      return moveRecord;
    },
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
    accounts: attachment,
  });
  accounts = new AccountSelector({
    pool,
    quota: { latest: () => undefined },
    flagshipAccountId: () => null,
    decisions: new DecisionStore(h.db),
    loginInUse: { whenLow: () => "ask", pin: () => {} },
  });
  return {
    ...h,
    costs: costs as CostLimitStore,
    /** What the next launch is built with over the same saved state (`reboot`). */
    relaunchWith: {
      accounts: attachment,
      loginMoveRecord: moveRecord as NonNullable<CrewSupervisorOptions["loginMoveRecord"]>,
      costLimits: { store: costs as CostLimitStore, appLimit: () => DEFAULT_COST_LIMIT },
    },
  };
}

function seedRunning(
  h: ReturnType<typeof setup>,
  model: { provider: string; id: string },
  sessionFile: string,
  id = "t-move",
) {
  seedTask(h.tasks, {
    id,
    title: "Fix the login form",
    prompt: "old work",
    repoId: null,
    repoDir: "/tmp/repo",
    worktreeDir: `/tmp/wt-${id}`,
    branch: `fm/task-${id}`,
    sessionFile,
    accountId: "acct_personal",
    model,
    status: "idle",
    createdAt: Date.now(),
  });
  h.tasks.recordBrief(id, ["Goal: fix the login form."]);
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
    // Still on Personal, its login is already named: no card asks about it again.
    expect(h.supervisor.loginMoves.tasksOn("acct_personal")).toEqual(["t-move"]);
    expect(h.supervisor.loginMoves.unnamedOn("acct_personal")).toEqual([]);
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

  it("carries on a restart with only its brief, held as its conversation opened, after the app is relaunched: once the limit is answered, with no message sent and no spark", async () => {
    const first = fakeCrewmate({ model: MODEL });
    const resume = { backend: "pi" as const, sessionFile: "/tmp/s2.jsonl" };
    const second = fakeCrewmate({ model: MODEL, sessionId: "s2", resume });
    const h = threeLogins("openai-codex", first, second, false, undefined, undefined, MODEL);
    const { taskId } = await h.supervisor.intake.commission({
      title: "Fix the login form",
      intent: intentOf("fix the login form"),
    });
    await vi.waitFor(() => expect(first.promptCalls).toHaveLength(1));
    await h.supervisor.loginMoves.moveOff("acct_personal", "acct_work");
    costLimitWhileOpening(h, () => taskId);
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
    expect(second.promptCalls).toHaveLength(0);
    await h.supervisor.disposeAll();

    // The next launch reads the same saved state: the record names the new conversation.
    const boot = fakeCrewmate({ model: MODEL, sessionId: "s2", resume });
    const events: FmEvent[] = [];
    const relaunched = reboot(h, async () => boot, {
      router: h.router as unknown as Router,
      costLimits: { store: h.costs, appLimit: () => DEFAULT_COST_LIMIT },
      broadcastEvent: (event) => events.push(event),
    });
    await relaunched.watch.sweepInbox(Date.now());
    await tick();
    expect(boot.promptCalls).toHaveLength(0);
    // Nothing but the restart's own reason waits on its lane.
    expect(h.inbox.allFor(taskId).map((row) => row.facts?.kind)).toEqual(["conversation-restart"]);

    h.costs.clearHold(taskId);
    await relaunched.watch.sweepInbox(Date.now());
    await vi.waitFor(() => expect(boot.promptCalls).toHaveLength(1));
    expect(boot.promptCalls[0]).toContain("context limit");
    expect(h.tasks.get(taskId)?.accountId).toBe("acct_work");
    expect(
      events.filter((event) => event.type === "task_event" && event.kind === "reached"),
    ).toHaveLength(0);
    await relaunched.disposeAll();
  });

  it("tells the center a message reached the task once, on the opening that succeeds after a failed one backed off, and not on the failure", async () => {
    const first = fakeCrewmate({});
    const h = threeLogins("openai-codex", first, fakeCrewmate({}), false);
    seedRunning(h, MODEL, "/tmp/s1.jsonl");
    // Sent while its cost limit stands, so it waits on the lane.
    h.costs.placeHold({ taskId: "t-move", limitUsd: 50, spentUsd: 51.5, at: Date.now() });
    await expect(h.supervisor.steer.steerCrewmate("t-move", "Check the footer too.")).resolves.toBe(
      "recorded-held",
    );
    h.costs.clearHold("t-move");
    vi.spyOn(h.supervisor.sessions, "resumeTask").mockRejectedValueOnce(
      new Error("The conversation could not be opened."),
    );
    const before = reached(h);

    await h.supervisor.watch.sweepInbox(Date.now());
    await tick();
    // The opening failed: the try is spent and backs off, and nothing reached the task.
    expect(first.promptCalls).toHaveLength(0);
    expect(reached(h)).toBe(before);
    const [row] = h.inbox.allFor("t-move");
    expect(row?.attempts).toBe(1);
    const due = row?.nextAttemptAt ?? 0;
    expect(due).toBeGreaterThan(Date.now());
    await h.supervisor.watch.sweepInbox(Date.now());
    await tick();
    expect(h.sessionSpecs).toHaveLength(0);

    vi.setSystemTime(due);
    await h.supervisor.watch.sweepInbox(due);
    await vi.waitFor(() => expect(first.promptCalls).toHaveLength(1));
    expect(first.promptCalls[0]).toContain("Check the footer too.");
    expect(reached(h)).toBe(before + 1);
  });
});

describe("a task still to move when the app is relaunched", () => {
  const MODEL = { provider: "openai-codex", id: "gpt-6.1-terra" };

  it("takes its next delivery on the login the click named, never the one it leaves or the login in use now", async () => {
    const h = threeLogins("openai-codex", fakeCrewmate({}), fakeCrewmate({}), false);
    seedRunning(h, MODEL, "/tmp/s1.jsonl");
    // Its cost limit keeps the click's move to Spare from being made before the quit.
    h.costs.placeHold({ taskId: "t-move", limitUsd: 50, spentUsd: 51.5, at: Date.now() });
    await h.supervisor.loginMoves.moveOff("acct_personal", "acct_spare");
    expect(h.tasks.get("t-move")?.accountId).toBe("acct_personal");
    expect(h.sessionSpecs).toHaveLength(0);
    await h.supervisor.disposeAll();

    // The next launch: Work is the login in use, and Spare is still the one the click named.
    const boot = fakeCrewmate({});
    const specs: { binding?: unknown }[] = [];
    const opens = async (spec: { binding?: unknown }) => {
      specs.push(spec);
      return boot;
    };
    const relaunched = reboot(h, opens, {
      router: h.router as unknown as Router,
      ...h.relaunchWith,
    });
    expect(relaunched.loginMoves.bindsTask("t-move")).toBe(true);
    expect(new SettingsStore(h.db).getLoginMoves()).toEqual({
      "t-move": { from: "acct_personal", to: "acct_spare" },
    });
    h.costs.clearHold("t-move");
    await expect(relaunched.steer.steerCrewmate("t-move", "Check the footer too.")).resolves.toBe(
      "mid-turn",
    );
    await vi.waitFor(() => expect(boot.promptCalls).toHaveLength(1));
    expect(specs).toHaveLength(1);
    expect((specs[0]?.binding as { accountId?: string } | undefined)?.accountId).toBe("acct_spare");
    expect(h.tasks.get("t-move")?.accountId).toBe("acct_spare");
    expect(boot.promptCalls[0]).toContain("Check the footer too.");
    expect(relaunched.loginMoves.bindsTask("t-move")).toBe(false);
    expect(new SettingsStore(h.db).getLoginMoves()).toEqual({});
    await relaunched.disposeAll();

    // Made, the move is no longer saved: a later launch binds the task to nothing.
    const later = reboot(h, async () => fakeCrewmate({}), {
      router: h.router as unknown as Router,
      ...h.relaunchWith,
    });
    expect(later.loginMoves.bindsTask("t-move")).toBe(false);
    await later.disposeAll();
  });

  it("opens it on the named login when the lane's sweep delivers what waited, with nothing sent after the relaunch", async () => {
    const h = threeLogins("openai-codex", fakeCrewmate({}), fakeCrewmate({}), false);
    seedRunning(h, MODEL, "/tmp/s1.jsonl");
    h.costs.placeHold({ taskId: "t-move", limitUsd: 50, spentUsd: 51.5, at: Date.now() });
    await h.supervisor.steer.steerCrewmate("t-move", "Check the footer too.");
    await h.supervisor.loginMoves.moveOff("acct_personal", "acct_spare");
    await h.supervisor.disposeAll();

    const boot = fakeCrewmate({});
    const specs: { binding?: unknown }[] = [];
    const opens = async (spec: { binding?: unknown }) => {
      specs.push(spec);
      return boot;
    };
    const relaunched = reboot(h, opens, {
      router: h.router as unknown as Router,
      ...h.relaunchWith,
    });
    h.costs.clearHold("t-move");
    await relaunched.watch.sweepInbox(Date.now());
    await vi.waitFor(() => expect(boot.promptCalls).toHaveLength(1));
    expect(specs).toHaveLength(1);
    expect((specs[0]?.binding as { accountId?: string } | undefined)?.accountId).toBe("acct_spare");
    expect(boot.promptCalls[0]).toContain("Check the footer too.");
    await relaunched.disposeAll();
  });

  it("forgets a saved move whose task is no longer on the login it was to leave", async () => {
    const h = threeLogins("openai-codex", fakeCrewmate({}), fakeCrewmate({}), false);
    seedRunning(h, MODEL, "/tmp/s1.jsonl");
    h.costs.placeHold({ taskId: "t-move", limitUsd: 50, spentUsd: 51.5, at: Date.now() });
    await h.supervisor.loginMoves.moveOff("acct_personal", "acct_spare");
    await h.supervisor.disposeAll();
    h.tasks.placement.setAccountId("t-move", "acct_work");

    const relaunched = reboot(h, async () => fakeCrewmate({}), {
      router: h.router as unknown as Router,
      ...h.relaunchWith,
    });
    expect(relaunched.loginMoves.bindsTask("t-move")).toBe(false);
    // It leaves the saved record too, so the task coming back to Personal later revives nothing.
    expect(new SettingsStore(h.db).getLoginMoves()).toEqual({});
    await relaunched.disposeAll();
  });
});

// The approved plan, "Ask": the click moves work to the login the card
// named, and each task on the low login takes its next delivery there. The
// card's own button is pressed here, over the real card store, the real
// saved settings and the home's watch.
describe("the low-login card's Move click, cut off as the app quits", () => {
  const MODEL = { provider: "openai-codex", id: "gpt-6.1-terra" };
  const TASKS = ["t-move", "t-other"];
  const reading = (accountId: string, label: string, percent: number): LoginReading => ({
    accountId,
    label,
    enabled: true,
    connected: true,
    effectivePercentRemaining: percent,
  });

  type Vault = { pin: string; quitsAtPin: boolean; quitsAfterPin?: boolean; savedAtPin?: unknown };

  /** The home's watch over a supervisor, with the vault's pin and each login's reading. */
  function watching(
    h: ReturnType<typeof threeLogins>,
    supervisor: ReturnType<typeof reboot>,
    vault: Vault,
    readings: () => LoginReading[],
    choice: "ask" | "wait" = "ask",
  ) {
    const settings = new SettingsStore(h.db);
    return startLowLogins({
      settings: {
        getWhenLoginLow: () => choice,
        getLoginAnswersOver: () => settings.getLoginAnswersOver(),
        setLoginAnswersOver: (over) => settings.setLoginAnswersOver(over),
      },
      vault: {
        list: (providerId) =>
          providerId === "openai-codex"
            ? readings().map((login) => ({
                id: login.accountId,
                label: login.label,
                enabled: true,
              }))
            : [],
        pinnedAccount: () => vault.pin,
        setPin: (_providerId, accountId) => {
          // What the saved record names for the tasks as the pin is about to move.
          vault.savedAtPin = settings.getLoginMoves();
          if (vault.quitsAtPin) throw new Error("the app quit");
          vault.pin = accountId ?? vault.pin;
          if (vault.quitsAfterPin) throw new Error("the app quit");
        },
        onCutOffChange: () => {},
        cutOff: () => undefined,
      },
      routing: { accounts: { logins: readings }, attachLoginInUse: () => {} },
      quota: { latest: () => undefined },
      supervisor,
      broadcastEvent: () => {},
    });
  }

  it("moves every task on the low login to the login the click named, at its next delivery after the relaunch, though another login has more room by then", async () => {
    const h = threeLogins("openai-codex", fakeCrewmate({}), fakeCrewmate({}), false);
    for (const id of TASKS) {
      seedRunning(h, MODEL, `/tmp/${id}.jsonl`, id);
      // Its cost limit keeps each task's move from being made before the quit.
      h.costs.placeHold({ taskId: id, limitUsd: 50, spentUsd: 51.5, at: Date.now() });
    }
    const vault: Vault = {
      pin: "acct_personal",
      quitsAtPin: true,
    };
    const named = { from: "acct_personal", to: "acct_spare" };
    const bothNamed = { "t-move": named, "t-other": named };
    const first = watching(h, h.supervisor, vault, () => [
      reading("acct_personal", "Personal", 4),
      reading("acct_work", "Work", 40),
      reading("acct_spare", "Spare", 60),
    ]);
    first.read();
    const cardId = loginLowCardId("openai-codex");
    expect(h.supervisor.cards.stored(cardId)?.actions?.[0]?.label).toBe("Move to Spare");

    // The click; the app quits as the pin is about to be saved.
    expect(() =>
      h.supervisor.cardActions.act(cardId, "move-login-acct_personal-acct_spare"),
    ).toThrow("the app quit");
    expect(vault.savedAtPin).toEqual(bothNamed);
    expect(vault.pin).toBe("acct_personal");
    await h.supervisor.disposeAll();

    // The next launch: Work has the most room now, and the click named Spare.
    const boots: FakeCrewmate[] = [];
    const specs: { binding?: unknown }[] = [];
    const relaunched = reboot(
      h,
      async (spec: { binding?: unknown }) => {
        specs.push(spec);
        const boot = fakeCrewmate({});
        boots.push(boot);
        return boot;
      },
      { router: h.router as unknown as Router, ...h.relaunchWith },
    );
    vault.quitsAtPin = false;
    // A wake at startup, before the watch has checked the click: each task
    // waits, on neither the login it leaves nor the named one.
    for (const id of TASKS) h.costs.clearHold(id);
    for (const id of TASKS) await relaunched.steer.steerCrewmate(id, "Check the footer too.");
    await relaunched.watch.sweepInbox(Date.now());
    await tick();
    expect(specs).toEqual([]);
    expect(TASKS.map((id) => relaunched.loginMoves.awaitsCheck(id))).toEqual([true, true]);

    const second = watching(h, relaunched, vault, () => [
      reading("acct_personal", "Personal", 4),
      reading("acct_work", "Work", 95),
      reading("acct_spare", "Spare", 60),
    ]);
    second.read();
    second.read();
    await tick();
    expect(vault.pin).toBe("acct_spare");
    expect(vault.savedAtPin).toEqual(bothNamed);
    // The captain is not asked to choose again.
    expect(relaunched.cards.get(cardId)).toBeUndefined();

    await vi.waitFor(() =>
      expect(boots.filter((boot) => boot.promptCalls.length > 0)).toHaveLength(2),
    );
    expect(
      specs.map((spec) => (spec.binding as { accountId?: string } | undefined)?.accountId),
    ).toEqual(["acct_spare", "acct_spare"]);
    expect(TASKS.map((id) => h.tasks.get(id)?.accountId)).toEqual(["acct_spare", "acct_spare"]);
    expect(new SettingsStore(h.db).getLoginMoves()).toEqual({});
    await relaunched.disposeAll();
  });

  /** Two held tasks on Personal, the card up offering Spare, and the click cut off at the pin. */
  async function clickCutOff() {
    const h = threeLogins("openai-codex", fakeCrewmate({}), fakeCrewmate({}), false);
    for (const id of TASKS) {
      seedRunning(h, MODEL, `/tmp/${id}.jsonl`, id);
      h.costs.placeHold({ taskId: id, limitUsd: 50, spentUsd: 51.5, at: Date.now() });
    }
    const vault: Vault = {
      pin: "acct_personal",
      quitsAtPin: true,
    };
    const offeringSpare = () => [
      reading("acct_personal", "Personal", 4),
      reading("acct_work", "Work", 40),
      reading("acct_spare", "Spare", 60),
    ];
    const first = watching(h, h.supervisor, vault, offeringSpare);
    first.read();
    return { h, vault, first, cardId: loginLowCardId("openai-codex") };
  }

  it("opens no task on the named login when that login has run low by the relaunch, though the tasks' moves were already saved", async () => {
    const { h, vault, cardId } = await clickCutOff();
    expect(() =>
      h.supervisor.cardActions.act(cardId, "move-login-acct_personal-acct_spare"),
    ).toThrow("the app quit");
    expect(Object.keys(new SettingsStore(h.db).getLoginMoves())).toEqual(TASKS);
    await h.supervisor.disposeAll();

    const specs: { binding?: unknown }[] = [];
    const boots: FakeCrewmate[] = [];
    const relaunched = reboot(
      h,
      async (spec: { binding?: unknown }) => {
        specs.push(spec);
        const boot = fakeCrewmate({});
        boots.push(boot);
        return boot;
      },
      { router: h.router as unknown as Router, ...h.relaunchWith },
    );
    vault.quitsAtPin = false;
    // Spare has 3% left now; Work has room.
    const second = watching(h, relaunched, vault, () => [
      reading("acct_personal", "Personal", 4),
      reading("acct_work", "Work", 40),
      reading("acct_spare", "Spare", 3),
    ]);
    // Until the watch has read the logins, a wake opens no task anywhere.
    for (const id of TASKS) h.costs.clearHold(id);
    for (const id of TASKS) await relaunched.steer.steerCrewmate(id, "Check the footer too.");
    await relaunched.watch.sweepInbox(Date.now());
    await tick();
    expect(specs).toEqual([]);

    second.read();
    await tick();
    expect(TASKS.map((id) => relaunched.loginMoves.bindsTask(id))).toEqual([false, false]);
    expect(vault.pin).toBe("acct_personal");
    expect(new SettingsStore(h.db).getLoginMoves()).toEqual({});
    // The captain is asked about what is true now.
    expect(relaunched.cards.get(cardId)?.actions?.[0]?.label).toBe("Move to Work");

    // Refused, the click holds the tasks no longer: they carry on where they are.
    await relaunched.watch.sweepInbox(Date.now());
    await vi.waitFor(() =>
      expect(boots.filter((boot) => boot.promptCalls.length > 0)).toHaveLength(2),
    );
    expect(
      specs.map((spec) => (spec.binding as { accountId?: string } | undefined)?.accountId),
    ).toEqual(["acct_personal", "acct_personal"]);
    await relaunched.disposeAll();
  });

  it("keeps both tasks' moves to the named login when the app quit after the login in use was saved", async () => {
    const { h, vault, cardId } = await clickCutOff();
    vault.quitsAtPin = false;
    vault.quitsAfterPin = true;
    expect(() =>
      h.supervisor.cardActions.act(cardId, "move-login-acct_personal-acct_spare"),
    ).toThrow("the app quit");
    expect(vault.pin).toBe("acct_spare");
    await h.supervisor.disposeAll();

    const specs: { binding?: unknown }[] = [];
    const boots: FakeCrewmate[] = [];
    const relaunched = reboot(
      h,
      async (spec: { binding?: unknown }) => {
        specs.push(spec);
        const boot = fakeCrewmate({});
        boots.push(boot);
        return boot;
      },
      { router: h.router as unknown as Router, ...h.relaunchWith },
    );
    vault.quitsAfterPin = false;
    for (const id of TASKS) h.costs.clearHold(id);
    for (const id of TASKS) await relaunched.steer.steerCrewmate(id, "Check the footer too.");
    const second = watching(h, relaunched, vault, () => [
      reading("acct_personal", "Personal", 4),
      reading("acct_work", "Work", 95),
      reading("acct_spare", "Spare", 60),
    ]);
    second.read();
    await vi.waitFor(() =>
      expect(boots.filter((boot) => boot.promptCalls.length > 0)).toHaveLength(2),
    );
    expect(
      specs.map((spec) => (spec.binding as { accountId?: string } | undefined)?.accountId),
    ).toEqual(["acct_spare", "acct_spare"]);
    expect(vault.pin).toBe("acct_spare");
    expect(Object.keys(new SettingsStore(h.db).getLoginAnswersOver())).toEqual(["openai-codex"]);
    await relaunched.disposeAll();
  });

  it("names no task, moves no login in use and keeps the answer when the tasks' moves cannot be saved, then makes the whole move at the next reading", async () => {
    const { h, vault, first, cardId } = await clickCutOff();
    vault.quitsAtPin = false;
    const settings = new SettingsStore(h.db);
    const write = vi.spyOn(SettingsStore.prototype, "setLoginMoves").mockImplementationOnce(() => {
      throw new Error("the record could not be written");
    });
    expect(() =>
      h.supervisor.cardActions.act(cardId, "move-login-acct_personal-acct_spare"),
    ).toThrow("the record could not be written");
    expect(TASKS.map((id) => h.supervisor.loginMoves.bindsTask(id))).toEqual([false, false]);
    expect(settings.getLoginMoves()).toEqual({});
    expect(vault.pin).toBe("acct_personal");
    expect(settings.getLoginAnswersOver()).toEqual({});

    first.read();
    await tick();
    write.mockRestore();
    const named = { from: "acct_personal", to: "acct_spare" };
    expect(settings.getLoginMoves()).toEqual({ "t-move": named, "t-other": named });
    expect(vault.pin).toBe("acct_spare");
    expect(Object.keys(settings.getLoginAnswersOver())).toEqual(["openai-codex"]);
    await h.supervisor.disposeAll();
  });

  it("opens neither task where it is while only the click is saved, then moves both to the named login once the logins are read", async () => {
    const { h, vault, cardId } = await clickCutOff();
    vault.quitsAtPin = false;
    // The app stops before any task's move is saved: the card's answer is all there is.
    const write = vi.spyOn(SettingsStore.prototype, "setLoginMoves").mockImplementationOnce(() => {
      throw new Error("the app quit");
    });
    expect(() =>
      h.supervisor.cardActions.act(cardId, "move-login-acct_personal-acct_spare"),
    ).toThrow("the app quit");
    write.mockRestore();
    expect(new SettingsStore(h.db).getLoginMoves()).toEqual({});
    await h.supervisor.disposeAll();

    const specs: { binding?: unknown }[] = [];
    const boots: FakeCrewmate[] = [];
    const relaunched = reboot(
      h,
      async (spec: { binding?: unknown }) => {
        specs.push(spec);
        const boot = fakeCrewmate({});
        boots.push(boot);
        return boot;
      },
      { router: h.router as unknown as Router, ...h.relaunchWith },
    );
    expect(TASKS.map((id) => relaunched.loginMoves.bindsTask(id))).toEqual([false, false]);
    // A wake at startup, before the logins are read.
    for (const id of TASKS) h.costs.clearHold(id);
    for (const id of TASKS) await relaunched.steer.steerCrewmate(id, "Check the footer too.");
    await relaunched.watch.sweepInbox(Date.now());
    await tick();
    expect(specs).toEqual([]);
    expect(TASKS.map((id) => relaunched.loginMoves.awaitsCheck(id))).toEqual([true, true]);

    const second = watching(h, relaunched, vault, () => [
      reading("acct_personal", "Personal", 4),
      reading("acct_work", "Work", 95),
      reading("acct_spare", "Spare", 60),
    ]);
    second.read();
    await vi.waitFor(() =>
      expect(boots.filter((boot) => boot.promptCalls.length > 0)).toHaveLength(2),
    );
    expect(
      specs.map((spec) => (spec.binding as { accountId?: string } | undefined)?.accountId),
    ).toEqual(["acct_spare", "acct_spare"]);
    expect(vault.pin).toBe("acct_spare");
    expect(TASKS.map((id) => relaunched.loginMoves.awaitsCheck(id))).toEqual([false, false]);
    await relaunched.disposeAll();
  });

  /**
   * After the click was cut off and the app relaunched, both tasks wait in
   * the backlog: one is sent a message, the other a message whose files
   * have crossed, while the click is still to be checked.
   */
  async function sentToBacklogBeforeTheCheck() {
    const { h, vault, cardId } = await clickCutOff();
    expect(() =>
      h.supervisor.cardActions.act(cardId, "move-login-acct_personal-acct_spare"),
    ).toThrow("the app quit");
    await h.supervisor.disposeAll();

    const specs: { binding?: unknown }[] = [];
    const boots: FakeCrewmate[] = [];
    const relaunched = reboot(
      h,
      async (spec: { binding?: unknown }) => {
        specs.push(spec);
        const boot = fakeCrewmate({});
        boots.push(boot);
        return boot;
      },
      { router: h.router as unknown as Router, ...h.relaunchWith },
    );
    vault.quitsAtPin = false;
    for (const id of TASKS) {
      h.costs.clearHold(id);
      expect(
        relaunched.hostOps.moveToBacklog(id, { actor: "firstmate", via: "tool", decision: null })
          .ok,
      ).toBe(true);
    }
    await expect(relaunched.steer.steerCrewmate("t-move", "Check the footer too.")).resolves.toBe(
      "recorded-held",
    );
    seedTask(h.tasks, { id: "t-finder", title: "Find the screenshot", status: "idle" });
    const picture = join(scratchDir("infinitary-handed-"), "clipped card.png");
    writeFileSync(picture, "a picture of the clipped card");
    await keepHandoverFiles([picture], crewmateHandoverDir(h.paths, "t-finder"));
    await relaunched.steer.steerAfterFiles("t-finder", "t-other", "look at it", {
      response: { mode: "guidance-only" as const },
    });
    await relaunched.watch.sweepInbox(Date.now());
    await tick();
    expect(specs).toEqual([]);
    const prompts = () => boots.flatMap((boot) => boot.promptCalls);
    const accounts = () =>
      specs.map((spec) => (spec.binding as { accountId?: string } | undefined)?.accountId);
    return { h, vault, relaunched, boots, prompts, accounts };
  }

  it("delivers what was sent to backlog tasks before the check on the named login once the click is accepted, with no second message or Start", async () => {
    const { h, vault, relaunched, boots, prompts, accounts } = await sentToBacklogBeforeTheCheck();
    watching(h, relaunched, vault, () => [
      reading("acct_personal", "Personal", 4),
      reading("acct_work", "Work", 95),
      reading("acct_spare", "Spare", 60),
    ]).read();
    await vi.waitFor(() =>
      expect(boots.filter((boot) => boot.promptCalls.length > 0)).toHaveLength(2),
    );
    expect(accounts()).toEqual(["acct_spare", "acct_spare"]);
    expect(prompts().every((prompt) => prompt.startsWith(BACKLOG_STEER_LINE))).toBe(true);
    expect(prompts().some((prompt) => prompt.includes("Check the footer too."))).toBe(true);
    expect(
      prompts().some((prompt) => /Files handed to you from [^\n]*\n\nlook at it/.test(prompt)),
    ).toBe(true);
    expect(TASKS.map((id) => h.tasks.get(id)?.backlogSince != null)).toEqual([true, true]);
    await relaunched.disposeAll();
  });

  it("delivers what was sent to backlog tasks before the check where they are once the click is refused, with no second message or Start", async () => {
    const { h, vault, relaunched, boots, prompts, accounts } = await sentToBacklogBeforeTheCheck();
    // Spare has 3% left now.
    watching(h, relaunched, vault, () => [
      reading("acct_personal", "Personal", 4),
      reading("acct_work", "Work", 40),
      reading("acct_spare", "Spare", 3),
    ]).read();
    await vi.waitFor(() =>
      expect(boots.filter((boot) => boot.promptCalls.length > 0)).toHaveLength(2),
    );
    expect(accounts()).toEqual(["acct_personal", "acct_personal"]);
    expect(prompts().every((prompt) => prompt.startsWith(BACKLOG_STEER_LINE))).toBe(true);
    expect(prompts().some((prompt) => prompt.includes("Check the footer too."))).toBe(true);
    expect(
      prompts().some((prompt) => /Files handed to you from [^\n]*\n\nlook at it/.test(prompt)),
    ).toBe(true);
    await relaunched.disposeAll();
  });

  it("delivers what was sent before the check as soon as the tasks' moves are named, whatever else the reading settles", async () => {
    const { h, vault, relaunched, boots, prompts, accounts } = await sentToBacklogBeforeTheCheck();
    // Nothing but the naming of the moves tells the tasks the click was checked.
    const forget = vi.spyOn(relaunched.loginMoves, "forget").mockImplementation(() => {});
    watching(h, relaunched, vault, () => [
      reading("acct_personal", "Personal", 4),
      reading("acct_work", "Work", 95),
      reading("acct_spare", "Spare", 60),
    ]).read();
    await vi.waitFor(() =>
      expect(boots.filter((boot) => boot.promptCalls.length > 0)).toHaveLength(2),
    );
    forget.mockRestore();
    expect(accounts()).toEqual(["acct_spare", "acct_spare"]);
    expect(prompts().every((prompt) => prompt.startsWith(BACKLOG_STEER_LINE))).toBe(true);
    await relaunched.disposeAll();
  });

  it("delivers what was sent to a backlog task with its conversation open before the check, on the named login once the click is accepted", async () => {
    const { h, vault, first, cardId } = await clickCutOff();
    for (const id of TASKS) {
      h.costs.clearHold(id);
      expect(
        h.supervisor.hostOps.moveToBacklog(id, { actor: "firstmate", via: "tool", decision: null })
          .ok,
      ).toBe(true);
    }
    await h.supervisor.sessions.resumeTask("t-move");
    expect(boundAccount(h, 0)).toBe("acct_personal");
    expect(() =>
      h.supervisor.cardActions.act(cardId, "move-login-acct_personal-acct_spare"),
    ).toThrow("the app quit");
    await expect(h.supervisor.steer.steerCrewmate("t-move", "Check the footer too.")).resolves.toBe(
      "recorded-held",
    );
    await tick();
    expect(h.inbox.allFor("t-move").filter((row) => row.deliveredAt == null)).toHaveLength(1);

    vault.quitsAtPin = false;
    first.read();
    await vi.waitFor(() =>
      expect(h.inbox.allFor("t-move").filter((row) => row.deliveredAt == null)).toHaveLength(0),
    );
    expect(h.tasks.get("t-move")?.accountId).toBe("acct_spare");
    expect(boundAccount(h, 1)).toBe("acct_spare");
    expect(h.tasks.get("t-move")?.backlogSince != null).toBe(true);
    await h.supervisor.disposeAll();
  });

  /**
   * The click was cut off and the app relaunched; both tasks are in the
   * backlog and nothing has read the logins yet.
   */
  async function relaunchedInBacklog() {
    const { h, vault, cardId } = await clickCutOff();
    expect(() =>
      h.supervisor.cardActions.act(cardId, "move-login-acct_personal-acct_spare"),
    ).toThrow("the app quit");
    await h.supervisor.disposeAll();
    const specs: { binding?: unknown }[] = [];
    const boots: FakeCrewmate[] = [];
    const relaunched = reboot(
      h,
      async (spec: { binding?: unknown }) => {
        specs.push(spec);
        const boot = fakeCrewmate({});
        boots.push(boot);
        return boot;
      },
      { router: h.router as unknown as Router, ...h.relaunchWith },
    );
    vault.quitsAtPin = false;
    for (const id of TASKS) {
      h.costs.clearHold(id);
      expect(
        relaunched.hostOps.moveToBacklog(id, { actor: "firstmate", via: "tool", decision: null })
          .ok,
      ).toBe(true);
    }
    const prompts = () => boots.flatMap((boot) => boot.promptCalls);
    const accounts = () =>
      specs.map((spec) => (spec.binding as { accountId?: string } | undefined)?.accountId);
    const read = (spare: number) =>
      watching(h, relaunched, vault, () => [
        reading("acct_personal", "Personal", 4),
        reading("acct_work", "Work", spare < 10 ? 40 : 95),
        reading("acct_spare", "Spare", spare),
      ]).read();
    return { h, relaunched, prompts, accounts, read };
  }

  // docs/inbox.md: the host's own steer waits on a started task's lane in the backlog until a Start.
  it("starts no turn in the backlog for the host's own notice kept while the click was unchecked", async () => {
    const { h, relaunched, prompts, read } = await relaunchedInBacklog();
    await expect(
      relaunched.steer.steerInternal("t-move", "Checks passed.", SUPERVISOR_STEER),
    ).resolves.toBe("recorded-held");
    read(60);
    await tick();
    await relaunched.watch.sweepInbox(Date.now());
    await tick();
    expect(prompts()).toEqual([]);
    expect(h.inbox.allFor("t-move").filter((row) => row.deliveredAt == null)).toHaveLength(1);
    expect(h.tasks.get("t-move")?.backlogSince != null).toBe(true);
    await relaunched.disposeAll();
  });

  it("keeps a sent message's wake through a cost limit that outlasts the click's check, and delivers it on the named login when the limit is lifted", async () => {
    const { h, relaunched, prompts, accounts, read } = await relaunchedInBacklog();
    await expect(relaunched.steer.steerCrewmate("t-move", "Check the footer too.")).resolves.toBe(
      "recorded-held",
    );
    h.costs.placeHold({ taskId: "t-move", limitUsd: 50, spentUsd: 51.5, at: Date.now() });
    read(60);
    await tick();
    await relaunched.watch.sweepInbox(Date.now());
    await tick();
    expect(prompts()).toEqual([]);

    h.costs.clearHold("t-move");
    await relaunched.watch.sweepTaskLane("t-move", Date.now());
    await vi.waitFor(() => expect(prompts()).toHaveLength(1));
    expect(prompts()[0]?.startsWith(BACKLOG_STEER_LINE)).toBe(true);
    expect(prompts()[0]).toContain("Check the footer too.");
    expect(accounts()).toEqual(["acct_spare"]);
    expect(h.tasks.get("t-move")?.backlogSince != null).toBe(true);
    // Taken, it is owed no more: a later sweep opens nothing.
    await relaunched.watch.sweepTaskLane("t-move", Date.now());
    await tick();
    expect(prompts()).toHaveLength(1);
    await relaunched.disposeAll();
  });

  it("starts no turn for the host's own notice kept while the click was unchecked, in a backlog task whose conversation is open", async () => {
    const { h, vault, first, cardId } = await clickCutOff();
    for (const id of TASKS) {
      h.costs.clearHold(id);
      expect(
        h.supervisor.hostOps.moveToBacklog(id, { actor: "firstmate", via: "tool", decision: null })
          .ok,
      ).toBe(true);
    }
    await h.supervisor.sessions.resumeTask("t-move");
    expect(() =>
      h.supervisor.cardActions.act(cardId, "move-login-acct_personal-acct_spare"),
    ).toThrow("the app quit");
    await expect(
      h.supervisor.steer.steerInternal("t-move", "Checks passed.", SUPERVISOR_STEER),
    ).resolves.toBe("recorded-held");

    vault.quitsAtPin = false;
    first.read();
    await vi.waitFor(() => expect(h.tasks.get("t-move")?.accountId).toBe("acct_spare"));
    await tick();
    await h.supervisor.watch.sweepInbox(Date.now());
    await tick();
    expect(h.inbox.allFor("t-move").filter((row) => row.deliveredAt == null)).toHaveLength(1);
    await h.supervisor.disposeAll();
  });

  it("keeps a sent message's wake when a cost limit is reached as the conversation opens after the click is refused, and delivers it when the limit is lifted", async () => {
    const { h, relaunched, prompts, accounts, read } = await relaunchedInBacklog();
    await expect(relaunched.steer.steerCrewmate("t-move", "Check the footer too.")).resolves.toBe(
      "recorded-held",
    );
    const resume = relaunched.sessions.resumeTask.bind(relaunched.sessions);
    const open = vi
      .spyOn(relaunched.sessions, "resumeTask")
      .mockImplementationOnce(async (...args) => {
        const opened = await resume(...args);
        h.costs.placeHold({ taskId: "t-move", limitUsd: 50, spentUsd: 51.5, at: Date.now() });
        return opened;
      });
    read(3);
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    await tick();
    expect(prompts()).toEqual([]);

    h.costs.clearHold("t-move");
    await relaunched.watch.sweepTaskLane("t-move", Date.now());
    await vi.waitFor(() => expect(prompts()).toHaveLength(1));
    expect(prompts()[0]?.startsWith(BACKLOG_STEER_LINE)).toBe(true);
    expect(accounts()).toEqual(["acct_personal"]);
    await relaunched.disposeAll();
  });

  it("keeps a sent message's wake when the conversation does not open after the click is refused, waits out the back-off and delivers it then", async () => {
    const { h, relaunched, prompts, accounts, read } = await relaunchedInBacklog();
    await expect(relaunched.steer.steerCrewmate("t-move", "Check the footer too.")).resolves.toBe(
      "recorded-held",
    );
    const open = vi
      .spyOn(relaunched.sessions, "resumeTask")
      .mockRejectedValueOnce(new Error("could not open"))
      .mockRejectedValueOnce(new Error("could not open"));
    // Spare has 3% left now: the click is refused and the task stays on Personal.
    read(3);
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    await tick();
    expect(prompts()).toEqual([]);

    const now = Date.now();
    await relaunched.watch.sweepTaskLane("t-move", now);
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    await tick();
    expect(prompts()).toEqual([]);
    const next = Math.max(...h.inbox.allFor("t-move").map((row) => row.nextAttemptAt ?? 0));
    expect(next).toBeGreaterThan(now);
    // Before the back-off ends nothing is tried.
    await relaunched.watch.sweepTaskLane("t-move", now);
    await tick();
    expect(open).toHaveBeenCalledTimes(2);

    vi.setSystemTime(next);
    await relaunched.watch.sweepTaskLane("t-move", next);
    await vi.waitFor(() => expect(prompts()).toHaveLength(1));
    expect(prompts()[0]?.startsWith(BACKLOG_STEER_LINE)).toBe(true);
    expect(prompts()[0]).toContain("Check the footer too.");
    expect(accounts()).toEqual(["acct_personal"]);
    await relaunched.disposeAll();
  });

  it("delivers files whose crossing ended while the click was unchecked to a backlog task with its conversation open, on the named login once the click is accepted", async () => {
    const { h, vault, first, cardId } = await clickCutOff();
    for (const id of TASKS) {
      h.costs.clearHold(id);
      expect(
        h.supervisor.hostOps.moveToBacklog(id, { actor: "firstmate", via: "tool", decision: null })
          .ok,
      ).toBe(true);
    }
    await h.supervisor.sessions.resumeTask("t-other");
    expect(boundAccount(h, 0)).toBe("acct_personal");
    expect(() =>
      h.supervisor.cardActions.act(cardId, "move-login-acct_personal-acct_spare"),
    ).toThrow("the app quit");
    seedTask(h.tasks, { id: "t-finder", title: "Find the screenshot", status: "idle" });
    const picture = join(scratchDir("infinitary-handed-"), "clipped card.png");
    writeFileSync(picture, "a picture of the clipped card");
    await keepHandoverFiles([picture], crewmateHandoverDir(h.paths, "t-finder"));
    await h.supervisor.steer.steerAfterFiles("t-finder", "t-other", "look at it", {
      response: { mode: "guidance-only" as const },
    });
    await vi.waitFor(() => expect(h.supervisor.steer.handingOver("t-other")).toBe(false));
    await tick();
    const waiting = () => h.inbox.allFor("t-other").filter((row) => row.deliveredAt == null);
    expect(waiting().length).toBeGreaterThan(0);

    vault.quitsAtPin = false;
    first.read();
    await vi.waitFor(() => expect(waiting()).toHaveLength(0));
    expect(h.tasks.get("t-other")?.accountId).toBe("acct_spare");
    expect(boundAccount(h, 1)).toBe("acct_spare");
    expect(h.tasks.get("t-other")?.backlogSince != null).toBe(true);
    await h.supervisor.disposeAll();
  });

  it("delivers files whose crossing ended after the click was cut off, on the named login once the click is checked", async () => {
    const { h, vault } = await clickCutOff();
    await h.supervisor.disposeAll();
    const specs: { binding?: unknown }[] = [];
    const boots: FakeCrewmate[] = [];
    const relaunched = reboot(
      h,
      async (spec: { binding?: unknown }) => {
        specs.push(spec);
        const boot = fakeCrewmate({});
        boots.push(boot);
        return boot;
      },
      { router: h.router as unknown as Router, ...h.relaunchWith },
    );
    // The card the last launch left open is still to be answered.
    const watch = watching(h, relaunched, vault, () => [
      reading("acct_personal", "Personal", 4),
      reading("acct_work", "Work", 95),
      reading("acct_spare", "Spare", 60),
    ]);
    for (const id of TASKS) {
      h.costs.clearHold(id);
      expect(
        relaunched.hostOps.moveToBacklog(id, { actor: "firstmate", via: "tool", decision: null })
          .ok,
      ).toBe(true);
    }
    seedTask(h.tasks, { id: "t-finder", title: "Find the screenshot", status: "idle" });
    const picture = join(scratchDir("infinitary-handed-"), "clipped card.png");
    writeFileSync(picture, "a picture of the clipped card");
    await keepHandoverFiles([picture], crewmateHandoverDir(h.paths, "t-finder"));
    // Sent with no click made yet; the click is cut off while the files cross.
    await relaunched.steer.steerAfterFiles("t-finder", "t-other", "look at it", {
      response: { mode: "guidance-only" as const },
    });
    expect(relaunched.steer.handingOver("t-other")).toBe(true);
    expect(() =>
      relaunched.cardActions.act(
        loginLowCardId("openai-codex"),
        "move-login-acct_personal-acct_spare",
      ),
    ).toThrow("the app quit");
    await vi.waitFor(() => expect(relaunched.steer.handingOver("t-other")).toBe(false));
    await tick();
    expect(specs).toEqual([]);

    vault.quitsAtPin = false;
    watch.read();
    await vi.waitFor(() =>
      expect(boots.filter((boot) => boot.promptCalls.length > 0)).toHaveLength(1),
    );
    const prompt = boots.flatMap((boot) => boot.promptCalls)[0] ?? "";
    expect(prompt.startsWith(BACKLOG_STEER_LINE)).toBe(true);
    expect(prompt).toMatch(/Files handed to you from [^\n]*\n\nlook at it/);
    expect(
      specs.map((spec) => (spec.binding as { accountId?: string } | undefined)?.accountId),
    ).toContain("acct_spare");
    expect(h.tasks.get("t-other")?.accountId).toBe("acct_spare");
    await relaunched.disposeAll();
  });

  it("takes down at the first reading a card left open by the last launch, once the choice is wait", async () => {
    const { h, vault, cardId } = await clickCutOff();
    expect(h.supervisor.cards.get(cardId)).toBeDefined();
    await h.supervisor.disposeAll();

    const relaunched = reboot(h, async () => fakeCrewmate({}), {
      router: h.router as unknown as Router,
      ...h.relaunchWith,
    });
    // The card store brought the unanswered card back.
    expect(relaunched.cards.get(cardId)).toBeDefined();
    const second = watching(
      h,
      relaunched,
      vault,
      () => [
        reading("acct_personal", "Personal", 4),
        reading("acct_work", "Work", 40),
        reading("acct_spare", "Spare", 60),
      ],
      "wait",
    );
    second.read();
    expect(relaunched.cards.get(cardId)).toBeUndefined();
    await relaunched.disposeAll();
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
