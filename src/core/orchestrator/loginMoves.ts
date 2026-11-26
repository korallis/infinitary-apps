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
  /** The app is quitting: no move starts now. */
  disposed(): boolean;
};

/**
 * A started task's move to another login of the same provider
 * (docs/quota.md, "When the login in use runs low"): between turns, never
 * inside one, its conversation is let go and its record names the login a
 * pick chooses now, passing over the one it leaves; it then reopens the way
 * a resume on a changed account does, with what waited on its lane due at
 * once. Only this computer's own tasks move: a task on a computer that runs
 * work is on that computer's login.
 */
export class LoginMoves {
  /** The low-login card's click, bound by the watch that raises the card. */
  onClick?: (accountId: string) => void;
  private readonly moving = new Set<string>();

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

  /** Moves each task on the login that is between turns; one mid-turn stays until asked again. */
  async moveOff(accountId: string): Promise<void> {
    await Promise.all(this.tasksOn(accountId).map((taskId) => this.move(taskId, accountId)));
  }

  private async move(taskId: string, from: string): Promise<void> {
    const accounts = this.options.accounts;
    if (!accounts?.pickForSpawn || this.moving.has(taskId)) return;
    this.moving.add(taskId);
    try {
      const before = this.options.tasks.get(taskId);
      if (!before?.model || this.host.runtime(taskId)?.turn.busy) return;
      const model = parseOfferingKey(before.model);
      const pick = await accounts.pickForSpawn(taskId, model.provider, {
        model: model.id,
        passing: [from],
      });
      const to = pick.accountId;
      const record = this.options.tasks.get(taskId);
      const runtime = this.host.runtime(taskId);
      if (
        !to ||
        record?.status !== "active" ||
        record.accountId !== from ||
        record.model !== before.model ||
        runtime?.turn.busy ||
        this.host.disposed()
      )
        return;
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
      if (!runtime) {
        this.host.deliverLane(taskId);
        return;
      }
      this.host.deliverPendingToTask(await this.host.resumeTask(taskId));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      // i18n-exempt: a task timeline row the first mate reads
      this.options.tasks.note(taskId, `its move to another login could not reopen it: ${message}`, {
        news: true,
      });
    } finally {
      this.moving.delete(taskId);
    }
  }
}
