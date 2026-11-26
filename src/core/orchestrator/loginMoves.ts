import { said, saidLine } from "@shared/i18n/said";
import { parseOfferingKey } from "@shared/modelSlots";
import { LOCAL_MACHINE_ID } from "../session/session";
import type { TaskRuntime } from "./crewRuntime";
import type { CrewSupervisorOptions } from "./crewSupervisorOptions";

/** What the moves read and drive of the supervisor that owns the conversations. */
export type LoginMovesHost = {
  runtime(taskId: string): TaskRuntime | undefined;
  releaseSession(runtime: TaskRuntime): void;
  forgetRuntime(taskId: string): void;
  resumeTask(taskId: string): Promise<TaskRuntime>;
  /** Hand an idle crewmate what waits on its lane. */
  deliverPendingToTask(task: TaskRuntime): void;
  /** A lane's due rows go now, resuming the task if need be. */
  deliverLane(taskId: string): void;
  /** Where a task's crewmate runs: the computer that runs work its record names, or this Mac. */
  machineOf(taskId: string): string;
  /**
   * Something other than the login it leaves holds the task's lane: a cost
   * limit, an update, a move to another computer (`CrewFacts.laneHold`).
   */
  laneHeld(taskId: string): boolean;
  /** The app is quitting: no move starts now. */
  disposed(): boolean;
};

/** A move under way: the delivery asked of it, and whether it handed the lane on. */
type Going = {
  deliver: (task: TaskRuntime) => void;
  reopen: boolean;
  handed: boolean;
  done: Promise<void>;
};

/**
 * A started task's move to another login of the same provider
 * (docs/quota.md, "When the login in use runs low"): between turns, never
 * inside one, its conversation is let go and its record names the login the
 * move named - the one the captain's card offered, or the home chose under
 * `move` - and no other; it then reopens the way a resume on a changed
 * account does, with what waited on its lane due at once. A task inside a
 * turn stays bound to that login and moves at its lane's next delivery
 * (`takes`), which reaches the new login and never the turn still running
 * on the old one. A task held by anything else - a cost limit, an update, a
 * move to another computer - stays bound and moves at the delivery after
 * that hold ends. A login that no longer serves the task's model leaves the task
 * where it is. Only this computer's own tasks move: a task on a computer
 * that runs work is on that computer's login.
 */
export class LoginMoves {
  /** The low-login card's click, bound by the watch that raises the card. */
  onClick?: (accountId: string) => void;
  /** Each move under way, with the delivery it owes when it is over. */
  private readonly moving = new Map<string, Going>();
  /** Each task still to move, with the login it leaves and the one named for it. */
  private readonly bound = new Map<string, { from: string; to: string }>();

  constructor(
    private readonly options: Pick<
      CrewSupervisorOptions,
      "tasks" | "inbox" | "accounts" | "broadcastEvent"
    >,
    private readonly host: LoginMovesHost,
  ) {}

  /** This computer's started tasks whose conversation is on the login. */
  tasksOn(accountId: string): string[] {
    return this.options.tasks
      .listActive()
      .filter(
        (record) =>
          record.accountId === accountId && this.host.machineOf(record.id) === LOCAL_MACHINE_ID,
      )
      .map((record) => record.id);
  }

  /**
   * Binds each task on `from` to `to` and moves those between turns now;
   * one inside a turn moves at its lane's next delivery.
   */
  async moveOff(from: string, to: string): Promise<void> {
    const taskIds = this.tasksOn(from);
    for (const taskId of taskIds) this.bound.set(taskId, { from, to });
    await Promise.all(taskIds.map((taskId) => this.begin(taskId).done));
  }

  /** The login has room again, or work now waits: its tasks still to move stay. */
  forget(from: string): void {
    for (const [taskId, move] of this.bound) if (move.from === from) this.bound.delete(taskId);
  }

  /**
   * Whether the task still has a move to make: the login it leaves holds it
   * no more (`CrewFacts.laneHold`) and takes no more of its words.
   */
  bindsTask(taskId: string): boolean {
    return this.bound.has(taskId);
  }

  /**
   * A lane's delivery to a task still to move: the move takes it, and
   * `deliver` hands the lane to the conversation the task ends up with.
   * Undefined when the task is bound to no move; otherwise it settles once
   * the move is over, true when the lane was handed on. With `reopen`, a
   * task with no open conversation is opened for `deliver` on the login it
   * ends up with, as a message someone sent opens one; without it, its
   * lane's own sweep does, which leaves a task in the backlog alone. A move
   * already picking its account takes the request with it.
   */
  takes(
    taskId: string,
    deliver: (task: TaskRuntime) => void,
    reopen = false,
  ): Promise<boolean> | undefined {
    if (!this.bound.has(taskId)) return undefined;
    const running = this.moving.get(taskId);
    // A sent message's delivery is not given up for a sweep's.
    if (running && (reopen || !running.reopen)) {
      running.deliver = deliver;
      running.reopen = reopen;
    }
    const going = running ?? this.begin(taskId, deliver, reopen);
    return going.done.then(() => going.handed);
  }

  private begin(
    taskId: string,
    deliver: (task: TaskRuntime) => void = (task) => this.host.deliverPendingToTask(task),
    reopen = false,
  ): Going {
    const running = this.moving.get(taskId);
    if (running) return running;
    const going: Going = { deliver, reopen, handed: false, done: Promise.resolve() };
    this.moving.set(taskId, going);
    going.done = this.move(taskId, going).finally(() => this.moving.delete(taskId));
    return going;
  }

  /** `going` is read where it is used: a delivery asked for while the account is picked is the one made. */
  private async move(taskId: string, going: Going): Promise<void> {
    const accounts = this.options.accounts;
    const move = this.bound.get(taskId);
    if (!move || !accounts?.pickForSpawn) return;
    const { from, to } = move;
    const hand = (task: TaskRuntime) => {
      going.handed = true;
      going.deliver(task);
    };
    // The task stays where it is, with its lane delivered there.
    const stay = async () => {
      this.bound.delete(taskId);
      const open = this.host.runtime(taskId);
      if (open) return hand(open);
      if (!going.reopen) return;
      try {
        hand(await this.host.resumeTask(taskId));
      } catch {
        // The rows are durable: the next message or Start delivers them.
      }
    };
    try {
      const before = this.options.tasks.get(taskId);
      if (before?.status !== "active" || before.accountId !== from || !before.model)
        return await stay();
      // A hold of its own keeps the task bound and unopened; the delivery
      // that follows the hold's end makes the move.
      if (this.host.runtime(taskId)?.turn.busy || this.host.laneHeld(taskId)) return;
      const model = parseOfferingKey(before.model);
      const pick = await accounts.pickForSpawn(taskId, model.provider, {
        model: model.id,
        only: to,
      });
      const record = this.options.tasks.get(taskId);
      const runtime = this.host.runtime(taskId);
      if (runtime?.turn.busy || this.host.disposed() || this.host.laneHeld(taskId)) return;
      if (
        pick.accountId !== to ||
        record?.status !== "active" ||
        record.accountId !== from ||
        record.model !== before.model ||
        this.bound.get(taskId)?.to !== to
      )
        return await stay();
      this.bound.delete(taskId);
      if (runtime) {
        this.host.releaseSession(runtime);
        this.host.forgetRuntime(taskId);
      }
      // The decision and the record move together; the login is marked
      // selected only once they committed.
      this.options.tasks.atomic(
        () => {
          pick.record();
          this.options.tasks.placement.setAccountId(taskId, to);
        },
        () => pick.selected(),
      );
      this.options.broadcastEvent({
        type: "firstmate_note",
        ...saidLine(
          said("feedTaskMovedLogin", {
            task: record.title,
            from: accounts.labelOf(from) ?? from,
            to: accounts.labelOf(to) ?? to,
          }),
        ),
        taskId,
      });
      // What waited on the login it left is due on the one it goes to.
      this.options.inbox.movedProvider(taskId);
      if (!runtime && !going.reopen) {
        going.handed = true;
        this.host.deliverLane(taskId);
        return;
      }
      hand(await this.host.resumeTask(taskId));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      // i18n-exempt: a task timeline row the first mate reads
      this.options.tasks.note(taskId, `its move to another login could not reopen it: ${message}`, {
        news: true,
      });
    }
  }
}
