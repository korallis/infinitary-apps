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
  /**
   * Hand an idle crewmate what waits on its lane; true when it took it.
   * `sent` marks the delivery of a message someone sent, which a task in
   * the backlog still reads.
   */
  deliverPendingToTask(task: TaskRuntime, sent?: boolean): boolean;
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
  deliver: (task: TaskRuntime) => boolean;
  sent: boolean;
  /** A restart reopens the task itself: the move names its login and opens nothing. */
  restarting?: boolean;
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
  /** Each task whose lane keeps a message someone sent, until a delivery takes it (`keepsSent`). */
  private readonly owed = new Set<string>();

  constructor(
    private readonly options: Pick<
      CrewSupervisorOptions,
      "tasks" | "inbox" | "accounts" | "broadcastEvent" | "loginMoveRecord"
    >,
    private readonly host: LoginMovesHost,
  ) {
    // The moves the last launch left unmade: each task still on the login it was to leave.
    const saved = Object.entries(options.loginMoveRecord?.read() ?? {});
    for (const [taskId, move] of saved) {
      const record = options.tasks.get(taskId);
      if (record?.status === "active" && record.accountId === move.from)
        this.bound.set(taskId, move);
    }
    // A move that no longer applies leaves the record too, so nothing revives it later.
    if (this.bound.size !== saved.length) this.save();
  }

  private save(): void {
    this.options.loginMoveRecord?.write(Object.fromEntries(this.bound));
  }

  /** The task's move is named, or `undefined` once it is made or given up; saved either way. */
  private bind(taskId: string, move: { from: string; to: string } | undefined): void {
    if (move) this.bound.set(taskId, move);
    else if (!this.bound.delete(taskId)) return;
    this.save();
  }

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
   * one inside a turn moves at its lane's next delivery. Every task's move
   * is saved in one write before any is bound: a write that fails throws
   * here, before the promise, with no task bound and nothing saved. With
   * `unnamedOnly`, a task another login is already named for keeps that
   * login: the click that asked about the rest did not ask about it.
   */
  moveOff(from: string, to: string, unnamedOnly = false): Promise<void> {
    const taskIds = this.tasksOn(from).filter((taskId) => {
      const bound = this.bound.get(taskId);
      return !unnamedOnly || !bound || (bound.from === from && bound.to === to);
    });
    // The same move named again keeps its binding, so a pick already out for it stands.
    const named = taskIds.filter((taskId) => {
      const bound = this.bound.get(taskId);
      return bound?.from !== from || bound.to !== to;
    });
    if (named.length > 0) {
      const next = new Map(this.bound);
      for (const taskId of named) next.set(taskId, { from, to });
      this.options.loginMoveRecord?.write(Object.fromEntries(next));
      for (const taskId of named) this.bound.set(taskId, { from, to });
    }
    // The moves begin once the caller has finished what follows the save in
    // the same step (the pin, the answer's end), which they are held for.
    return Promise.resolve().then(async () => {
      this.payOwed();
      await Promise.all(taskIds.map((taskId) => this.begin(taskId).done));
    });
  }

  /**
   * A message someone sent is kept on the task's lane because its click's
   * check is awaited: true when so. It is delivered as a sent message, on
   * the named login or where the task is, once the click is checked and
   * nothing else holds the lane, so a task in the backlog, which no sweep
   * opens, still reads it. Never for a notice of the host's own, which
   * waits in the backlog for a Start.
   */
  keepsSent(taskId: string): boolean {
    if (!this.awaitsCheck(taskId)) return false;
    this.owed.add(taskId);
    return true;
  }

  /** Delivers each kept sent message whose click has been checked. */
  private payOwed(): void {
    for (const taskId of [...this.owed]) this.paySent(taskId);
  }

  /**
   * Delivers the task's kept sent message when its click has been checked
   * and no hold stands. It stays kept until a delivery takes the lane, so
   * another hold, a conversation that did not open or a delivery that was
   * not admitted leaves it for the lane's next sweep. `failed` is told of
   * a conversation that did not open.
   */
  paySent(taskId: string, failed: () => void = () => {}): void {
    if (!this.owed.has(taskId) || this.awaitsCheck(taskId) || this.host.laneHeld(taskId)) return;
    this.owed.delete(taskId);
    const deliver = (task: TaskRuntime) => this.host.deliverPendingToTask(task, true);
    // Still kept while rows wait that no delivery took.
    const settle = (taken: boolean) => {
      const parked = this.options.tasks.get(taskId)?.backlogSince != null;
      if (!taken && parked && this.options.inbox.pending(taskId).length > 0) this.owed.add(taskId);
    };
    const moved = this.takes(taskId, deliver, true);
    if (moved) {
      void moved.then(settle);
      return;
    }
    const open = this.host.runtime(taskId);
    if (open) {
      settle(deliver(open));
      return;
    }
    void this.host
      .resumeTask(taskId)
      .then(deliver)
      .then(settle, () => {
        this.owed.add(taskId);
        failed();
      });
  }

  /**
   * The login has room again, or work now waits: its tasks still to move
   * stay. With `to`, only the moves to that login: a click's moves that
   * the click's own check then refused.
   */
  forget(from: string, to?: string): void {
    for (const [taskId, move] of [...this.bound])
      if (move.from === from && (to === undefined || move.to === to)) this.bind(taskId, undefined);
    // After the caller has ended the answer that held them.
    if (this.owed.size > 0) void Promise.resolve().then(() => this.payOwed());
  }

  /**
   * Whether the task is on a login a Move click left and that click is
   * still to be checked (`loginMoveRecord.unchecked`): as after a quit part
   * way through the click, with the task's own move saved or not yet. Until
   * the check accepts or refuses the click the task's lane is held
   * (`CrewFacts.laneHold`), so it neither moves nor takes a delivery on the
   * login it would leave.
   */
  awaitsCheck(taskId: string): boolean {
    const accountId = this.options.tasks.get(taskId)?.accountId;
    return (
      accountId != null &&
      this.host.machineOf(taskId) === LOCAL_MACHINE_ID &&
      this.options.loginMoveRecord?.unchecked?.(accountId) === true
    );
  }

  /**
   * Whether the task still has a move to make: the login it leaves holds it
   * no more (`CrewFacts.laneHold`) and takes no more of its words.
   */
  bindsTask(taskId: string): boolean {
    return this.bound.has(taskId);
  }

  /** The login's started tasks no move is named for yet: those a card may still ask about. */
  unnamedOn(accountId: string): string[] {
    return this.tasksOn(accountId).filter((taskId) => !this.bound.has(taskId));
  }

  /**
   * A lane's delivery to a task still to move: the move takes it, and
   * `deliver` hands the lane to the conversation the task ends up with.
   * Undefined when the task is bound to no move; otherwise it settles once
   * the move is over, true when the delivery took the lane. `sent` marks
   * the delivery of a message someone sent: a task with no open
   * conversation is opened for it on the login it ends up with, where an
   * ordinary delivery leaves that to the lane's own sweep, which leaves a
   * task in the backlog alone; and a move already picking its account
   * takes it in place of an ordinary delivery, never the reverse.
   */
  takes(
    taskId: string,
    deliver: (task: TaskRuntime) => boolean,
    sent = false,
  ): Promise<boolean> | undefined {
    if (!this.bound.has(taskId)) return undefined;
    const running = this.moving.get(taskId);
    // A sent message's delivery is not given up for a sweep's.
    if (running && (sent || !running.sent)) {
      running.deliver = deliver;
      running.sent = sent;
    }
    const going = running ?? this.begin(taskId, deliver, sent);
    return going.done.then(() => going.handed);
  }

  /**
   * A restart is about to open a new conversation for the task: one still
   * to move is on its named login first, so the restart opens there. It
   * opens and delivers nothing; the restart does. True when a hold of the
   * task's own kept the move back: the task is still to move, and the
   * restart waits on its lane for the delivery after that hold.
   */
  async beforeRestart(taskId: string): Promise<boolean> {
    if (!this.bound.has(taskId)) return false;
    const going = this.begin(taskId);
    going.restarting = true;
    await going.done;
    return this.bound.has(taskId);
  }

  private begin(
    taskId: string,
    deliver: (task: TaskRuntime) => boolean = (task) => this.host.deliverPendingToTask(task),
    sent = false,
  ): Going {
    const running = this.moving.get(taskId);
    if (running) return running;
    const going: Going = { deliver, sent, handed: false, done: Promise.resolve() };
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
    // Handed on only when the delivery took the lane: a hold that came up
    // while the task reopened keeps its rows waiting.
    const hand = (task: TaskRuntime) => {
      going.handed = going.deliver(task);
    };
    // The task stays where it is, with its lane delivered there.
    const stay = async () => {
      this.bind(taskId, undefined);
      if (going.restarting) return;
      const open = this.host.runtime(taskId);
      if (open) return hand(open);
      if (!going.sent) return;
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
      // A newer move named its login while this one picked: only the pick
      // is dropped, and the delivery goes with the task to the newer login.
      const newest = this.bound.get(taskId);
      if (newest && newest !== move) return await this.move(taskId, going);
      if (
        pick.accountId !== to ||
        record?.status !== "active" ||
        record.accountId !== from ||
        record.model !== before.model ||
        !newest
      )
        return await stay();
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
      // Saved as made only once the record names the login: a quit before this leaves it to make.
      this.bind(taskId, undefined);
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
      if (going.restarting) return;
      if (!runtime && !going.sent) {
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
