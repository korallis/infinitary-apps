import type { FmEvent } from "@shared/events";
import type { QuotaSnapshotView } from "@shared/quota";
import type { WhenLoginLow } from "@shared/whenLoginLow";
import { describe, expect, it } from "vitest";
import { type AccountPool, AccountSelector } from "../routing/accountRouter";
import { openInMemoryDatabase } from "../storage/db";
import { DecisionStore } from "../storage/decisionStore";
import { InboxStore } from "../storage/inboxStore";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import type { TaskRuntime } from "./crewRuntime";
import { LoginMoves } from "./loginMoves";

// The approved plan for several logins of one provider, piece 3, "A moved
// lane": a task on the spent login moves to the new login between turns,
// never inside one, and its conversation reopens the way a resume does.
// "Ask": the click moves work to the login the card named, so a third
// login with more room takes none of it.

const MODEL = { provider: "openai-codex", id: "gpt-6.1-terra" };

const reading: QuotaSnapshotView = {
  generatedAt: "2026-08-17T12:00:00Z",
  fetchedAt: Date.parse("2026-08-17T12:00:00Z"),
  providers: [
    { accountId: "personal", percent: 0 },
    { accountId: "work", percent: 60 },
    // More room than Work, and not the login the card named.
    { accountId: "spare", percent: 95 },
  ].map((row) => ({
    provider: "codex",
    label: "Codex",
    accountId: row.accountId,
    accountLabel: row.accountId,
    status: "ok" as const,
    stale: false,
    windows: [{ id: "weekly", label: "weekly", percentRemaining: row.percent }],
  })),
};

function crew(
  start: {
    busy?: boolean;
    /** Something other than its login holds the task's lane, as a cost limit does. */
    held?: boolean;
    machine?: string;
    /** The provider's login in use when the task moves; Work unless named. */
    pin?: string;
    whenLow?: WhenLoginLow;
    /** The models a login's sign-in lists, when it lists any. */
    lists?: Record<string, string[]>;
  } = {},
) {
  const db = openInMemoryDatabase();
  const tasks = new TaskService({ db, strict: true });
  const inbox = new InboxStore(db);
  const events: FmEvent[] = [];
  const steps: string[] = [];
  const pool: AccountPool = {
    list: () =>
      [
        { id: "personal", label: "Personal" },
        { id: "work", label: "Work" },
        { id: "spare", label: "Spare" },
      ].map((login) => ({ ...login, providerId: "openai-codex", enabled: true })),
    // The click already moved the login in use to Work.
    pinnedAccount: () => start.pin ?? "work",
    connectedSync: () => true,
    withheldReason: () => undefined,
    markSelected: (accountId) => {
      steps.push(`selected ${accountId}`);
    },
  };
  const accounts = new AccountSelector({
    pool,
    quota: { latest: () => reading },
    flagshipAccountId: () => null,
    decisions: new DecisionStore(db),
    loginInUse: { whenLow: () => start.whenLow ?? "ask", pin: () => {} },
    accountModels: () =>
      Object.entries(start.lists ?? {}).map(([accountId, models]) => ({
        accountId,
        models: models.map((id) => ({ provider: MODEL.provider, id })),
      })),
  });
  seedTask(tasks, {
    id: "task-1",
    title: "Fix the login form",
    status: "idle",
    accountId: "personal",
    model: MODEL,
  });
  const turn = { busy: start.busy ?? false };
  const hold = { held: start.held ?? false };
  /** The task's conversation does not open; `due` is the lane's due rows, one more once it has failed. */
  const opening = { fails: false, due: [7] };
  const runtime = { id: "task-1", turn } as unknown as TaskRuntime;
  const live = new Map<string, TaskRuntime>([["task-1", runtime]]);
  const moves = new LoginMoves(
    { tasks, inbox, accounts, broadcastEvent: (event) => events.push(event) },
    {
      runtime: (taskId) => live.get(taskId),
      releaseSession: (task) => {
        steps.push(`released ${task.id}`);
      },
      forgetRuntime: (taskId) => {
        live.delete(taskId);
      },
      resumeTask: async (taskId) => {
        if (opening.fails) {
          opening.due = [7, 8];
          throw new Error("could not open");
        }
        steps.push(`resumed ${taskId} on ${tasks.get(taskId)?.accountId}`);
        return runtime;
      },
      deliverPendingToTask: (task) => {
        steps.push(`delivered ${task.id}`);
        return true;
      },
      deliverLane: (taskId) => {
        steps.push(`lane ${taskId}`);
      },
      machineOf: () => start.machine ?? "local",
      laneHeld: () => hold.held,
      disposed: () => false,
      dueRows: () => opening.due,
      openingFailed: (rowIds) => {
        steps.push(`backed off ${rowIds.join(" and ")}`);
      },
    },
  );
  return { moves, tasks, events, steps, live, db, turn, hold, opening, runtime };
}

describe("a started task's move to another login", () => {
  it("lets go of its conversation, names the new login on its record and reopens it there", async () => {
    const t = crew();
    expect(t.moves.tasksOn("personal")).toEqual(["task-1"]);
    await t.moves.moveOff("personal", "work");
    expect(t.tasks.get("task-1")?.accountId).toBe("work");
    expect(t.steps).toEqual([
      "released task-1",
      "selected work",
      "resumed task-1 on work",
      "delivered task-1",
    ]);
    expect(t.events).toEqual([
      {
        type: "firstmate_note",
        text: "Fix the login form moved from Personal to Work.",
        said: {
          m: "feedTaskMovedLogin",
          a: { task: "Fix the login form", from: "Personal", to: "Work" },
        },
        taskId: "task-1",
      },
    ]);
    const decision = t.db
      .prepare("SELECT account_id FROM account_decisions WHERE task_id = ?")
      .get("task-1") as { account_id: string };
    expect(decision.account_id).toBe("work");
    expect(t.moves.tasksOn("personal")).toEqual([]);
  });

  it("leaves a task inside a turn where it is, and moves it to the named login at its next delivery", async () => {
    const t = crew({ busy: true });
    await t.moves.moveOff("personal", "work");
    expect(t.tasks.get("task-1")?.accountId).toBe("personal");
    expect(t.steps).toEqual([]);
    expect(t.events).toEqual([]);
    // Its turn ends and its lane has words for it: the move takes the delivery.
    t.turn.busy = false;
    const delivered: string[] = [];
    await expect(t.moves.takes("task-1", (task) => delivered.push(task.id) > 0)).resolves.toBe(
      true,
    );
    await expect.poll(() => delivered).toEqual(["task-1"]);
    expect(t.tasks.get("task-1")?.accountId).toBe("work");
    expect(t.steps).toEqual(["released task-1", "selected work", "resumed task-1 on work"]);
    // Moved, it is bound to nothing: the next delivery is an ordinary one.
    expect(t.moves.takes("task-1", () => true)).toBeUndefined();
  });

  it("leaves an idle task held by something else unopened, and moves it at the delivery after that hold", async () => {
    const t = crew({ held: true });
    await t.moves.moveOff("personal", "work");
    expect(t.tasks.get("task-1")?.accountId).toBe("personal");
    expect(t.steps).toEqual([]);
    expect(t.events).toEqual([]);
    t.hold.held = false;
    const delivered: string[] = [];
    await expect(t.moves.takes("task-1", (task) => delivered.push(task.id) > 0)).resolves.toBe(
      true,
    );
    await expect.poll(() => delivered).toEqual(["task-1"]);
    expect(t.tasks.get("task-1")?.accountId).toBe("work");
    expect(t.steps).toEqual(["released task-1", "selected work", "resumed task-1 on work"]);
  });

  // INA-9: a task's next delivery is on the login its own click named.
  it("leaves a task another login is already named for on that login, when a later click asks only about work no login is named for", async () => {
    const t = crew({ held: true });
    await t.moves.moveOff("personal", "work");
    seedTask(t.tasks, {
      id: "task-2",
      title: "Fix the footer",
      status: "idle",
      accountId: "personal",
      model: MODEL,
    });
    expect(t.moves.unnamedOn("personal")).toEqual(["task-2"]);
    await t.moves.moveOff("personal", "spare", true);
    t.hold.held = false;
    await t.moves.takes("task-1", () => true);
    await t.moves.takes("task-2", () => true);
    expect(t.tasks.get("task-1")?.accountId).toBe("work");
    expect(t.tasks.get("task-2")?.accountId).toBe("spare");
  });

  // INA-9: a task's next delivery is on the login its own click named.
  it("gives up only the moves a refused click itself named, and keeps an earlier click's to the same login", async () => {
    const t = crew({ held: true });
    await t.moves.moveOff("personal", "spare", true, "first raising");
    seedTask(t.tasks, {
      id: "task-2",
      title: "Fix the footer",
      status: "idle",
      accountId: "personal",
      model: MODEL,
    });
    // A later click that is refused before it names any task's move.
    t.moves.forget("personal", "spare", "second raising");
    expect(t.moves.bindsTask("task-1")).toBe(true);
    // And one refused after its moves were saved, as after a quit part way.
    await t.moves.moveOff("personal", "spare", true, "second raising");
    expect(t.moves.bindsTask("task-2")).toBe(true);
    t.moves.forget("personal", "spare", "second raising");
    expect(t.moves.bindsTask("task-2")).toBe(false);
    expect(t.moves.bindsTask("task-1")).toBe(true);
    t.hold.held = false;
    await t.moves.takes("task-1", () => true);
    expect(t.tasks.get("task-1")?.accountId).toBe("spare");
    expect(t.tasks.get("task-2")?.accountId).toBe("personal");
  });

  // docs/inbox.md: a refused delivery spends its try and backs off.
  it("backs off the rows that were due as the opening began when a sent message's conversation does not open, on the named login and where the task stays", async () => {
    const moved = crew({ held: true });
    moved.live.delete("task-1");
    await moved.moves.moveOff("personal", "work");
    moved.hold.held = false;
    moved.opening.fails = true;
    await expect(moved.moves.takes("task-1", () => true, true)).resolves.toBe(false);
    expect(moved.tasks.get("task-1")?.accountId).toBe("work");
    // Row 8 became due while the conversation was opening: it took no part.
    expect(moved.steps).toEqual(["selected work", "backed off 7"]);

    // Work's sign-in does not list the task's model: the task stays on Personal.
    const stays = crew({
      held: true,
      lists: { work: ["gpt-6.1-luna"], spare: [MODEL.id], personal: [MODEL.id] },
    });
    stays.live.delete("task-1");
    await stays.moves.moveOff("personal", "work");
    stays.hold.held = false;
    stays.opening.fails = true;
    await expect(stays.moves.takes("task-1", () => true, true)).resolves.toBe(false);
    expect(stays.tasks.get("task-1")?.accountId).toBe("personal");
    expect(stays.steps).toEqual(["backed off 7"]);
  });

  it("opens a task with no open conversation on the named login for a sent message, and not through its lane's sweep", async () => {
    const t = crew({ held: true });
    t.live.delete("task-1");
    await t.moves.moveOff("personal", "work");
    t.hold.held = false;
    const delivered: string[] = [];
    await expect(
      t.moves.takes("task-1", (task) => delivered.push(task.id) > 0, true),
    ).resolves.toBe(true);
    await expect.poll(() => delivered).toEqual(["task-1"]);
    expect(t.steps).toEqual(["selected work", "resumed task-1 on work"]);
  });

  it("takes no delivery of a task bound to no move, or one whose login has room again", async () => {
    const t = crew({ busy: true });
    expect(t.moves.takes("task-1", () => true)).toBeUndefined();
    await t.moves.moveOff("personal", "work");
    t.moves.forget("personal");
    t.turn.busy = false;
    expect(t.moves.takes("task-1", () => true)).toBeUndefined();
    expect(t.tasks.get("task-1")?.accountId).toBe("personal");
  });

  it("moves to the named login when the login in use has changed since the click", async () => {
    const t = crew({ busy: true, pin: "spare" });
    await t.moves.moveOff("personal", "work");
    t.turn.busy = false;
    await expect(t.moves.takes("task-1", () => true)).resolves.toBe(true);
    await expect.poll(() => t.tasks.get("task-1")?.accountId).toBe("work");
    expect(t.steps).toContain("selected work");
  });

  it("moves to the named login under spread, where a login with more room would win a new pick", async () => {
    const t = crew({ whenLow: "spread", pin: "personal" });
    await t.moves.moveOff("personal", "work");
    expect(t.tasks.get("task-1")?.accountId).toBe("work");
    expect(t.steps).toContain("selected work");
  });

  it("leaves a task where it is when the named login does not serve its model", async () => {
    // Work's sign-in lists another model; Spare, which lists this one, was not named.
    const t = crew({ lists: { work: ["gpt-6.1-luna"], spare: [MODEL.id], personal: [MODEL.id] } });
    await t.moves.moveOff("personal", "work");
    expect(t.tasks.get("task-1")?.accountId).toBe("personal");
    // Its lane is delivered on the conversation it keeps.
    expect(t.steps).toEqual(["delivered task-1"]);
    expect(t.events).toEqual([]);
    expect(t.moves.takes("task-1", () => true)).toBeUndefined();
  });

  it("delivers the lane of a task with no open conversation, without opening one first", async () => {
    const t = crew();
    t.live.clear();
    await t.moves.moveOff("personal", "work");
    expect(t.tasks.get("task-1")?.accountId).toBe("work");
    expect(t.steps).toEqual(["selected work", "lane task-1"]);
  });

  it("counts no task that runs on another computer", () => {
    const t = crew({ machine: "device-1" });
    expect(t.moves.tasksOn("personal")).toEqual([]);
  });
});
