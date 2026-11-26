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
import { type AccountPool, AccountSelector } from "../routing/accountRouter";
import { DecisionStore } from "../storage/decisionStore";
import { seedTask } from "../tasks/seedTask";
import { crewmateRestartText } from "./crewSession";

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

/** Three logins of one provider: Personal, where the task runs, Work and Spare. */
function threeLogins(provider: string, first: FakeCrewmate, second: FakeCrewmate, claude: boolean) {
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
    markSelected: () => {},
  };
  let accounts: AccountSelector | undefined;
  const h = setup(first, {
    crewmates: [second],
    ...(claude
      ? {
          alsoServes: ["claude"] as const,
          bind: async (accountId) => ({ backend: "claude" as const, accountId: accountId ?? "" }),
        }
      : {}),
    accounts: {
      selectForSpawn: () => undefined,
      pickForSpawn: (...args) => (accounts as AccountSelector).pickForSpawn(...args),
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
  return h;
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
});
