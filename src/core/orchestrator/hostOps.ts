import type {
  CardAnswer,
  DropTaskReview,
  HostEffect,
  ShellEffect,
  TaskLifecycleOp,
  TaskMoveFrom,
} from "@shared/cards";
import { softHoldWords } from "@shared/holds";
import { TASK_CARD_VIA } from "@shared/provenance";
import {
  closeDoneClosedRefusal,
  closeDoneMissingRefusal,
  closeDoneNotStartedRefusal,
} from "@shared/recordCloseDone";
import {
  DROP_REVIEW_STALE,
  dropIneligibleRefusal,
  dropMissingRefusal,
  dropStartedRefusal,
} from "@shared/recordDrop";
import {
  queueMissingRefusal,
  queueStartedBacklogRefusal,
  queueStartedRefusal,
} from "@shared/taskQueue";
import { isUnstartedWork } from "@shared/tasks";
import { FIRSTMATE_RECIPIENT } from "../storage/inboxStore";
import type { TaskRecord } from "../storage/taskRecords";
import { TaskService } from "../tasks/taskService";
import { CardChoiceUnavailableError } from "./cardActions";
import type { CrewCore } from "./crewCore";
import type { InterruptSource } from "./crewRuntime";
import type { PluginConsentHandler, ProjectSetupHandler } from "./crewSupervisorOptions";
import { stallCardId } from "./idleLadder";
import { loginMoveOf } from "./loginMove";
import { describeStatus } from "./settleService";

function startWaitRefusal(
  record: TaskRecord,
  handle: string,
  blockers: TaskRecord[],
  audience: "tool" | "captain",
): string {
  const named = blockers.map(
    (blocker) =>
      `${blocker.key || blocker.id} "${blocker.title}"${blocker.status === "dropped" ? " (dropped)" : ""}`,
  );
  const waits = `Cannot start ${handle} now: it waits on ${named.join(", ")}.`;
  if (audience !== "tool") return waits;
  const plural = (list: TaskRecord[]) => (list.length === 1 ? "" : "s");
  const dead = blockers.filter((blocker) => blocker.status === "dropped");
  if (dead.length === 0) {
    return `${waits} It starts when that work closes, or on batched pull requests when the work it builds on is approved to merge, unless its needs_merge names that work. When only part of that work gives what it needs, split that part into its own task or fold this task into it; remove a wait with link_tasks remove only when it names the wrong task. Dropping a blocker never clears its wait. ${softHoldWords("start-waits", "firstmate")}`;
  }
  const key = record.key || record.id;
  const edges = dead.map((blocker) => `blocks ${blocker.key || blocker.id} -> ${key}`).join(", ");
  const rest = dead.length < blockers.length ? "; it can start once the rest is done" : "";
  return `${waits} Dropped work never clears a wait: remove the dead edge${plural(dead)} ${edges} with link_tasks remove${rest}.`;
}

/** The one line a Start puts before what waited on a started task's lane in the backlog. */
export function backlogLeftLine(actor: "captain" | "firstmate"): string {
  return `This task left the backlog: ${actor === "captain" ? "the captain" : "the first mate"} started it again. Carry on from where you stopped, with anything that waited on this task while it was there.`;
}

/**
 * The host's own operations (docs/task-board.md): a card's host operation,
 * the task record's and the task board's buttons, and the backlog, queue,
 * drop and pending-start doors that answer them. Shares the crew's state
 * through `CrewCore`.
 */
export class HostOps {
  /**
   * Starts the captain pressed that wait for the Firstmate to apply his
   * standing directions: the wake's inbox row, and where the press came from
   * so the history still records it as his. The row is the saved copy, so a
   * quit loses nothing (`resumePendingStarts`).
   */
  readonly pendingStarts = new Map<
    string,
    { rowId: number; from?: typeof TASK_CARD_VIA; panel?: string }
  >();
  private pendingStartsResumed = false;
  /** Charted starts requested and not yet claimed. A drop in that window refuses. */
  readonly starting = new Set<string>();
  private pluginConsent: PluginConsentHandler | null = null;
  projectChange: {
    apply: (arg: string | undefined) => void;
    decline: (arg: string | undefined) => void;
    inspect: (repoId: string) => Promise<void>;
  } | null = null;
  private secretsDecision: ((offer: string) => Promise<void>) | undefined;
  private eventScreen: ((arg: string | undefined) => void) | undefined;

  /** The event screen's offer card turns the screen on (docs/automation.md, "Offering the screen"). */
  setEventScreen(turnOn: (arg: string | undefined) => void): void {
    this.eventScreen = turnOn;
  }

  /** Only an app-authored Secrets card can spend its private, one-use offer. */
  setSecretsDecision(decide: (offer: string) => Promise<void>): void {
    this.secretsDecision = decide;
  }

  private projectSetup: ProjectSetupHandler | null = null;

  constructor(private readonly core: CrewCore) {}

  /** The installer answers the consent card's host ops (A2a). */
  setPluginConsent(handler: PluginConsentHandler): void {
    this.pluginConsent = handler;
  }

  setProjectChange(handler: NonNullable<HostOps["projectChange"]>): void {
    this.projectChange = handler;
  }

  /** The setup card's host ops reach the project setups (docs/fleet.md). */
  setProjectSetup(handler: ProjectSetupHandler): void {
    this.projectSetup = handler;
  }

  /**
   * The host cards' own operations, keyed on the declared op. `answers` are
   * what the captain's click carried from the card's own questions.
   */
  runHostOp(effect: HostEffect, answers?: readonly CardAnswer[]): { effect?: ShellEffect } {
    switch (effect.op) {
      case "secrets-decision":
        if (effect.arg) void this.secretsDecision?.(effect.arg);
        return {};
      case "secrets-bring":
      case "secrets-keep":
        // Its values ride their own request (`inf:secrets:keep`), never a card choice.
        return {};
      case "turn-on-event-screen":
        this.eventScreen?.(effect.arg);
        return {};
      case "confirm-required-action": {
        const [id] = (effect.arg ?? "").split(":");
        if (id && this.core.options.tasks.get(id)?.status === "open")
          this.core.cards.presentRequiredAction(id);
        void this.core.watch.sweepGates(this.core.now());
        return {};
      }
      case "defer-required-action":
        if (effect.arg) this.core.options.tasks.delivery.deferCaptainAction(effect.arg);
        return {};
      case "retry-firstmate":
        this.core.hooks().retryConverse();
        return {};
      case "move-flagship":
        if (effect.arg) this.core.hooks().moveFlagship?.(effect.arg);
        return {};
      case "move-login": {
        const move = loginMoveOf(effect.arg ?? "");
        if (move?.who === "crew") this.core.loginMoves.onClick?.(move.accountId);
        if (move?.who === "firstmate") this.core.hooks().moveFirstmateLogin?.(move.accountId);
        return {};
      }
      case "try-again":
        if (effect.arg) this.core.hooks().tryAgain?.(effect.arg);
        return {};
      case "keep-going-on-credits":
        if (effect.arg) this.core.hooks().keepGoingOnCredits?.(effect.arg);
        return {};
      case "use-saved-reset": {
        if (!effect.arg) return {};
        // Codex must sign in first: the shell lands on the account's row, which starts it there.
        if (this.core.hooks().redeemSavedReset?.(effect.arg) === "ran") return {};
        return { effect: { kind: "open", target: "subscriptions", useSavedReset: effect.arg } };
      }
      case "use-saved-resets": {
        if (!effect.arg) return {};
        // Codex must sign in first: the shell lands on the account's row, which turns it on there.
        if (this.core.hooks().turnOnSavedResets?.(effect.arg) === "ran") return {};
        return { effect: { kind: "open", target: "subscriptions", useSavedResets: effect.arg } };
      }
      case "restore-account":
        return {
          effect: {
            kind: "open",
            target: "subscriptions",
            ...(effect.arg ? { restoreAccountId: effect.arg } : {}),
          },
        };
      case "add-plugin":
        if (effect.arg) this.pluginConsent?.add(effect.arg);
        return {};
      case "decline-plugin":
        if (effect.arg) this.pluginConsent?.decline(effect.arg);
        return {};
      case "apply-project-change":
        this.projectChange?.apply(effect.arg);
        return {};
      case "decline-project-change":
        this.projectChange?.decline(effect.arg);
        return {};
      // The two choices of a card the app no longer puts up: a saved one does nothing.
      case "plan-queue":
      case "keep-delivery":
        return {};
      case "add-project":
        this.projectSetup?.add(effect.arg, answers);
        return {};
      case "decline-project":
        this.projectSetup?.decline(effect.arg);
        return {};
      case "move-task": {
        // The sign-in card's Move (INF-849): `arg` is the task, the
        // provider it moves off and the model the card offered.
        const [taskId, from, ...offered] = effect.arg?.split(":") ?? [];
        if (!taskId || !from) return {};
        const moved = this.core.moves.requestMove(taskId, {
          by: "captain",
          from,
          ...(offered.length > 0 ? { offered: offered.join(":") } : {}),
        });
        const answered = (answer: { ok: boolean; text: string }) => {
          if (!answer.ok)
            this.core.options.broadcastEvent({ type: "firstmate_note", text: answer.text, taskId });
        };
        void moved.then(answered).catch((error) => {
          this.core.options.broadcastEvent({
            type: "firstmate_note",
            text: `The task could not move: ${error instanceof Error ? error.message : String(error)}`,
            taskId,
          });
        });
        return {};
      }
      case "continue-task":
        // The stall card's Continue: the ladder's nudge again, now with the
        // captain's authority - a new turn, which ends the episode.
        if (effect.arg) this.continueStuckTask(effect.arg, "card");
        return {};
      case "backlog-task": {
        // The stall card's Back to backlog (INF-3143, direction A): the
        // captain parks a task stopped on a blocker nothing will change soon.
        if (!effect.arg) return {};
        const moved = this.moveToBacklog(effect.arg, {
          actor: "captain",
          via: "shell",
          decision: null,
        });
        if (!moved.ok)
          this.core.options.broadcastEvent({
            type: "firstmate_note",
            text: moved.text,
            taskId: effect.arg,
          });
        return {};
      }
      case "stop-task":
        if (effect.arg) this.dropStarted(effect.arg, "shell");
        return {};
      case "start-task":
        if (effect.arg) this.startOnRequest(effect.arg);
        return {};
      case "ask-again":
        if (effect.arg) this.core.hooks().askAgain?.(effect.arg);
        return {};
      // A task's cost limit card (docs/usage.md, "The cost limit").
      case "allow-cost":
        if (effect.arg) this.core.costLimits.answer(effect.arg, "allow");
        return {};
      case "lift-cost-limit":
        if (effect.arg) this.core.costLimits.answer(effect.arg, "lift");
        return {};
      case "stop-at-cost":
        if (effect.arg) this.core.costLimits.answer(effect.arg, "stop");
        return {};
    }
  }

  /**
   * A lifecycle toggle from the task record's footer or the task board.
   * Start, stop and continue run the stall card's host ops; a Start the
   * host refuses at once comes back as text as well as its feed line. Drop
   * task is the footer's own: never-started work, captain-attributed, and a
   * refusal is text for the popover rather than a feed line. Queue and
   * unqueue are the board's (`setQueued`): a refusal is text and writes
   * nothing, and a queued task that nothing holds starts on the next sweep.
   * Nothing resolves a card as an answer. Each click lands on the task's
   * history as the captain's, from the task card (`via: "task-card"`), and
   * wakes nobody: the Firstmate's next context block lists it beside his
   * card choices (FI3-695).
   */
  runTaskOp(
    taskId: string,
    op: TaskLifecycleOp,
    review?: DropTaskReview,
    from?: TaskMoveFrom,
  ): string | undefined {
    // A move a panel made on the captain's click names that panel beside it.
    const panel = from?.panel;
    switch (op) {
      case "answer-done": {
        if (!this.core.cards.finishAnswer(taskId))
          return "This task has no answer ready to mark Done.";
        return undefined;
      }
      case "dismiss-question": {
        // The record's Decline (INF-3108): the question's own way to say no,
        // or the app's Decline, pressed as the captain's choice.
        const card = this.core.cards.questionCard(taskId);
        const decline = card?.actions.find((action) => action.declines);
        if (!card || !decline) return "This question is no longer waiting.";
        try {
          this.core.cardActions.act(card.id, decline.id, "chrome");
        } catch (error) {
          if (error instanceof CardChoiceUnavailableError) return error.message;
          throw error;
        }
        return undefined;
      }
      case "show-card": {
        const action = this.core.options.tasks.get(taskId)?.delivery?.captainAction;
        if (action && !this.core.cards.presentRequiredAction(taskId))
          return "This action cannot be shown until its prerequisites finish.";
        const cardId =
          action?.cardId ??
          this.core.cards
            .snapshot()
            .find(
              (card) =>
                (card.taskId === taskId ||
                  this.core.options.tasks.capture.openCardTaskFor(card.id)?.id === taskId) &&
                card.status === "ready" &&
                card.actions.length,
            )?.id;
        if (!cardId) return "This task has no card to show.";
        this.core.cards.showOpenCard(cardId);
        return undefined;
      }
      case "drop-task":
        return this.dropFromRecord(taskId, review, panel);
      case "queue-task":
      case "unqueue-task":
        return this.queueFromBoard(taskId, op, panel);
      case "start-again": {
        if (!this.core.options.tasks.get(taskId)) return "This task could not be found.";
        const result = this.core.starts.startAgain(taskId, "captain", panel);
        if (!result.ok) return result.text;
        void result.started
          .then((text) => {
            if (
              text &&
              this.core.options.tasks.get(result.task.id)?.status !== "active" &&
              !this.pendingStarts.has(result.task.id)
            )
              this.core.options.broadcastEvent({
                type: "firstmate_note",
                text,
                taskId: result.task.id,
              });
          })
          .catch((caught: unknown) => this.reportCardEffectFailure(result.task.id, caught));
        return undefined;
      }
      case "start-task":
        return this.startOnRequest(taskId, TASK_CARD_VIA, panel);
      case "continue-task":
        this.continueStuckTask(taskId, TASK_CARD_VIA, panel);
        return undefined;
      case "stop-task":
        return this.dropStarted(taskId, TASK_CARD_VIA, panel);
    }
  }

  /**
   * The record's Close as done (INF-3169's plan, piece 3): the captain's
   * own word that started work is done, through the one close as done. The
   * press passes every soft hold, so only the real limits refuse it; a
   * refusal is text for the record's inline line.
   */
  async closeDoneFromRecord(taskId: string): Promise<{ ok: boolean; text: string }> {
    const record = this.core.options.tasks.get(taskId);
    const key = record?.key || taskId;
    if (!record) return { ok: false, text: closeDoneMissingRefusal(key) };
    if (record.status === "done" || record.status === "dropped")
      return { ok: false, text: closeDoneClosedRefusal(key) };
    if (record.kind !== "work" || record.status !== "active")
      return { ok: false, text: closeDoneNotStartedRefusal(key) };
    const done = await this.core.settling.done.close(taskId, { fromRecord: true });
    return { ok: done.ok, text: done.text };
  }

  /**
   * Drop task on started work: the captain's own drop, by the one drop's
   * rules (`TaskDrop`), which stops its crewmate and keeps a copy of its
   * unfinished work. A real limit answers at once; anything the drop says
   * after its reads reaches the feed.
   */
  private dropStarted(
    taskId: string,
    via: typeof TASK_CARD_VIA | "shell",
    panel?: string,
  ): string | undefined {
    const input = {
      actor: "captain" as const,
      reason: "cancelled" as const,
      via,
      ...(panel ? { panel } : {}),
    };
    const refused = this.core.settling.drops.refusal(taskId, input);
    if (refused) return refused.text;
    void this.core.settling.drops
      .drop(taskId, input)
      .then((result) => {
        if (!result.ok) this.reportCardEffectFailure(taskId, new Error(result.text));
      })
      .catch((caught: unknown) => this.reportCardEffectFailure(taskId, caught));
    return undefined;
  }

  /**
   * Drop task on never-started work: the captain's own drop, by the one
   * drop's rules (`TaskDrop`). Its open parts stay planned. A start already
   * requested, or a review that no longer matches, refuses and writes
   * nothing. Its record closes before this returns.
   */
  private dropFromRecord(
    taskId: string,
    review: DropTaskReview | undefined,
    panel?: string,
  ): string | undefined {
    const record = this.core.options.tasks.get(taskId);
    const key = record?.key || taskId;
    if (!record) return dropMissingRefusal(key);
    if (!review) return DROP_REVIEW_STALE;
    if (this.starting.has(taskId) || this.pendingStarts.has(taskId) || this.core.tasks.has(taskId))
      return dropStartedRefusal(key);
    if (!isUnstartedWork(record) || record.worktreeDir || record.assignee != null)
      return dropIneligibleRefusal(key);
    const input = {
      actor: "captain" as const,
      reason: "cancelled" as const,
      review,
      via: TASK_CARD_VIA as typeof TASK_CARD_VIA,
      ...(panel ? { panel } : {}),
    };
    const refused = this.core.settling.drops.refusal(taskId, input);
    if (refused) return refused.text;
    // Never-started work closes in this call, before the drop first yields.
    void this.core.settling.drops
      .drop(taskId, input)
      .catch((caught: unknown) => this.reportCardEffectFailure(taskId, caught));
    this.core.intake.graphChanged();
    return undefined;
  }

  /**
   * The task board's queue and unqueue on never-started work. A start
   * already requested refuses as started; the task service guards the rest
   * at write time. A queued task the ready query now takes starts on the
   * sweep `TaskIntake.graphChanged` runs.
   */
  private queueFromBoard(
    taskId: string,
    op: "queue-task" | "unqueue-task",
    panel?: string,
  ): string | undefined {
    const record = this.core.options.tasks.get(taskId);
    const key = record?.key || taskId;
    if (!record) return queueMissingRefusal(key);
    if (this.starting.has(taskId) || this.pendingStarts.has(taskId))
      return queueStartedRefusal(key);
    // Started work goes back to the backlog with its work kept (INF-2062).
    if (record.kind === "work" && record.status === "active") {
      if (op === "queue-task") return queueStartedBacklogRefusal(key);
      const moved = this.moveToBacklog(taskId, {
        actor: "captain",
        via: TASK_CARD_VIA,
        decision: null,
        ...(panel ? { panel } : {}),
      });
      return moved.ok ? undefined : moved.text;
    }
    if (this.core.tasks.has(taskId)) return queueStartedRefusal(key);
    const result = this.core.options.tasks.starts.setQueued(taskId, op, {
      actor: "captain",
      via: TASK_CARD_VIA,
      ...(panel ? { panel } : {}),
    });
    if (!result.ok) return result.text;
    if (!result.changed) return undefined;
    if (op === "queue-task") {
      // Queued work that nothing holds would start at once: that is a
      // Start, and goes through the Firstmate like one. Work that waits
      // has his directions applied now, so the sweep starts it carrying them.
      if (this.core.options.tasks.graph.listReady().some((ready) => ready.id === taskId)) {
        return this.startOnRequest(taskId, TASK_CARD_VIA, panel);
      }
      this.tellFirstmate(taskId, "queue");
    }
    this.core.intake.graphChanged();
    return undefined;
  }

  /**
   * A started task goes back to the backlog (INF-2062; docs/task-board.md,
   * "Moves"): the task board's Back to backlog, and update_task
   * start_policy on-request on started work. Its running turn stops, as an
   * interrupt does, but a kept merge approval stays and its merge goes ahead
   * there (INF-2114); its working copy, branch, conversation, change and
   * jobs stay. Nothing the host sends
   * wakes it there, and Start picks it up in the same conversation
   * (`startFromBacklog`). Its stuck card comes down with the move, since
   * the backlog is now where its wait shows (INF-3143, direction A), and
   * the first mate hears once if the host's news reaches it there
   * (`CrewSteer.tellBacklogNews`).
   */
  moveToBacklog(
    taskId: string,
    source: InterruptSource,
    reason?: string,
  ): { ok: boolean; text: string } {
    const record = this.core.options.tasks.get(taskId);
    if (!record) return { ok: false, text: queueMissingRefusal(taskId) };
    const handle = `${record.key || record.id} "${record.title}"`;
    const result = this.core.options.tasks.starts.setQueued(taskId, "unqueue-task", {
      actor: source.actor,
      ...(source.via === TASK_CARD_VIA ? { via: TASK_CARD_VIA } : {}),
      ...(source.panel ? { panel: source.panel } : {}),
      ...(reason?.trim() ? { reason: reason.trim() } : {}),
    });
    if (!result.ok) return result;
    if (!result.changed) return { ok: true, text: `${handle} already waits in the backlog.` };
    this.core.ladder.withdrawStallCard(taskId);
    void this.core.sessions
      .interruptCrewmate(taskId, "interrupt", { ...source, backlog: true })
      .catch((caught: unknown) => {
        console.warn("[crew] the backlog move could not stop the turn:", caught);
      });
    this.core.facts.broadcastCrewCounts();
    this.core.intake.graphChanged();
    return {
      ok: true,
      text: `Moved ${handle} back to the backlog: its turn stops and its work stays. Nothing wakes it until update_task start_now or the captain's Start.`,
    };
  }

  /**
   * Start on a started task in the backlog (INF-2062): it leaves the
   * backlog, and its crewmate hears everything that waited on its lane,
   * with one line that it left, in the same conversation.
   */
  startFromBacklog(
    record: TaskRecord,
    actor: "captain" | "firstmate",
    from?: typeof TASK_CARD_VIA,
    panel?: string,
    handle = `${record.key || record.id} "${record.title}"`,
  ): string {
    const left = this.core.options.tasks.starts.leaveBacklog(record.id, {
      actor,
      ...(from ? { via: from } : {}),
      ...(panel ? { panel } : {}),
    });
    if (!left) return `${handle} is not in the backlog.`;
    this.core.steer.announceReach(record.id);
    this.core.options.inbox.enqueue(record.id, backlogLeftLine(actor));
    const task = this.core.tasks.get(record.id);
    if (task?.session && !task.turn.closing) {
      this.core.turns.deliverPendingToTask(task, { sent: true });
    } else {
      const now = this.core.options.tasks.get(record.id);
      if (
        now &&
        TaskService.isResumable(now) &&
        now.sessionFile &&
        !this.core.facts.laneHeld(record.id) &&
        // A task bound to another login is opened there, never where it was (`LoginMoves`).
        !this.core.loginMoves.takes(
          record.id,
          (open) => this.core.turns.deliverPendingToTask(open, { sent: true }),
          true,
        )
      )
        void this.core.sessions
          .resumeTask(record.id)
          .then((resumed) => this.core.turns.deliverPendingToTask(resumed))
          .catch(() => {
            // The row is durable; the tick sweep retries the resume.
          });
    }
    this.core.facts.broadcastCrewCounts();
    this.core.intake.graphChanged();
    return `Started ${handle} again from the backlog. Its crewmate carries on in the same conversation.`;
  }

  /**
   * Why a start on the captain's click would be refused at once, in his
   * words, or undefined when it may go ahead: the checks `startQueuedNow`
   * makes before its first await. `handle` names the task as the one the
   * answer goes to reads it.
   */
  startRefusal(
    record: TaskRecord,
    audience: "tool" | "captain",
    handle = `${record.key || record.id} "${record.title}"`,
  ): string | undefined {
    if (record.status !== "open" || record.kind !== "work") {
      return `Cannot start ${handle} now: it is ${describeStatus(record)}, not queued work.${record.status === "dropped" ? (audience === "tool" ? " On the captain’s request, use update_task start_again to create a replacement." : " Use Start again on its record to create a replacement.") : ""}`;
    }
    // The Firstmate finishes a pending Start; nobody else starts it twice.
    const awaitsFirstmate = audience === "tool" && this.pendingStarts.has(record.id);
    if (
      this.core.tasks.has(record.id) ||
      (this.core.options.tasks.starts.startAttemptOf(record.id) && !awaitsFirstmate)
    )
      return `${handle} is already starting.`;
    const blockers = this.core.options.tasks.graph
      .blockers(record.id)
      .filter((blocker) => !TaskService.blockerCleared(blocker));
    if (blockers.length > 0) return startWaitRefusal(record, handle, blockers, audience);
    return undefined;
  }

  private tellFirstmate(
    taskId: string,
    move: "start" | "queue",
    from?: typeof TASK_CARD_VIA,
    panel?: string,
  ): number | null {
    const record = this.core.options.tasks.get(taskId);
    if (!record) return null;
    const id = this.core.hooks().notifyOp(
      {
        facts: {
          kind: "captain-start",
          task: { id: taskId, key: record.key || taskId, title: record.title },
          move,
          at: this.core.now(),
          ...(from ? { from } : {}),
          ...(panel ? { panel } : {}),
        },
      },
      "agent",
      taskId,
    );
    return typeof id === "number" ? id : null;
  }

  /**
   * Hold the captain's Start as Starting and tell the Firstmate, unless it
   * cannot answer: a seat that is paused or a lane in a provider outage, both
   * typed facts, start the task as it is and say so. True when the Start now
   * waits for the Firstmate's turn.
   */
  askFirstmateFirst(record: TaskRecord, from?: typeof TASK_CARD_VIA, panel?: string): boolean {
    const hooks = this.core.hooks();
    if (!hooks.firstmateCannotAnswer) return false;
    const cannot = hooks.firstmateCannotAnswer();
    if (cannot) {
      this.sayStartedAsIs(record.id, cannot);
      return false;
    }
    const rowId = this.tellFirstmate(record.id, "start", from, panel);
    if (rowId === null) return false;
    this.pendingStarts.set(record.id, {
      rowId,
      ...(from ? { from } : {}),
      ...(panel ? { panel } : {}),
    });
    this.core.options.tasks.starts.beginStartAttempt(record.id);
    return true;
  }

  private sayStartedAsIs(taskId: string, why: string): void {
    this.core.options.tasks.note(
      taskId,
      `started without applying your standing directions: ${why}`,
      {
        news: true,
      },
    );
  }

  private startPendingAsIs(taskId: string, why: string): void {
    const pending = this.pendingStarts.get(taskId);
    if (!pending) return;
    this.pendingStarts.delete(taskId);
    this.core.options.tasks.starts.clearStartAttempt(taskId);
    this.sayStartedAsIs(taskId, why);
    this.starting.add(taskId);
    void this.core.starts
      .startQueuedNow(taskId, {
        audience: "captain",
        ...(pending.from ? { from: pending.from } : {}),
        ...(pending.panel ? { panel: pending.panel } : {}),
        direct: true,
      })
      .finally(() => this.starting.delete(taskId))
      .then((result) => {
        if (!result || this.core.options.tasks.get(taskId)?.status === "active") return;
        this.core.options.broadcastEvent({ type: "firstmate_note", text: result, taskId });
      })
      .catch((caught: unknown) => this.reportCardEffectFailure(taskId, caught));
  }

  /**
   * The Firstmate's turn ended over these inbox rows (acknowledged or
   * released). A Start it read and did not start begins as it is: the turn
   * failed, broke, or finished without starting it. Answers the rows to
   * acknowledge, so a released wake is not served again for a task that began.
   */
  firstmateTurnEnded(rowIds: readonly number[], outcome: "clean" | "failed" | "broke"): number[] {
    const handled: number[] = [];
    for (const [taskId, pending] of [...this.pendingStarts]) {
      if (!rowIds.includes(pending.rowId)) continue;
      handled.push(pending.rowId);
      this.startPendingAsIs(
        taskId,
        outcome === "clean"
          ? "your first mate finished its turn without starting it"
          : outcome === "failed"
            ? "your first mate's turn failed"
            : "your first mate's turn broke",
      );
    }
    return handled;
  }

  /**
   * After a quit, the wake rows on the Firstmate's lane are the saved copy of
   * each pending Start: the task shows Starting again, and a Start whose row
   * is gone begins as it is. Run on the shared tick.
   */
  resumePendingStarts(): void {
    const rows = () => [
      ...this.core.options.inbox.allFor(FIRSTMATE_RECIPIENT),
      ...this.core.options.inbox.inFlight(FIRSTMATE_RECIPIENT),
    ];
    if (!this.pendingStartsResumed) {
      this.pendingStartsResumed = true;
      for (const row of rows()) {
        const facts = row.facts as
          | { kind?: string; move?: string; task?: { id: string }; from?: string; panel?: string }
          | undefined;
        if (facts?.kind !== "captain-start" || facts.move !== "start" || !facts.task) continue;
        const record = this.core.options.tasks.get(facts.task.id);
        if (
          record?.status !== "open" ||
          record.kind !== "work" ||
          this.pendingStarts.has(record.id)
        )
          continue;
        this.pendingStarts.set(record.id, {
          rowId: row.id,
          ...(facts.from === TASK_CARD_VIA ? { from: TASK_CARD_VIA } : {}),
          ...(facts.panel ? { panel: facts.panel } : {}),
        });
        this.core.options.tasks.starts.beginStartAttempt(record.id);
      }
    }
    for (const [taskId, pending] of [...this.pendingStarts]) {
      if (this.core.options.inbox.get(pending.rowId)) continue;
      this.startPendingAsIs(taskId, "your first mate's request for it was lost");
    }
  }

  /**
   * Start a charted task now on the captain's click: the Firstmate's
   * `update_task start_now` path, which also clears a hold. A task that
   * did not start says why in the feed; one refused at once also returns
   * why, for the surface that asked. The id is marked starting before the
   * first await, so a drop in that window refuses.
   */
  private startOnRequest(
    taskId: string,
    from?: typeof TASK_CARD_VIA,
    panel?: string,
  ): string | undefined {
    const record = this.core.options.tasks.get(taskId);
    if (record?.status === "active" && record.backlogSince != null) {
      this.startFromBacklog(record, "captain", from, panel);
      return undefined;
    }
    const refused = record ? this.startRefusal(record, "captain") : undefined;
    if (refused) {
      this.core.options.broadcastEvent({ type: "firstmate_note", text: refused, taskId });
      return refused;
    }
    if (this.starting.has(taskId)) {
      const handle = `${record?.key || taskId} "${record?.title ?? taskId}"`;
      const already = `${handle} is already starting.`;
      this.core.options.broadcastEvent({ type: "firstmate_note", text: already, taskId });
      return already;
    }
    this.starting.add(taskId);
    void this.core.starts
      .startQueuedNow(taskId, {
        audience: "captain",
        ...(from ? { from } : {}),
        ...(panel ? { panel } : {}),
      })
      .finally(() => {
        this.starting.delete(taskId);
      })
      .then((result) => {
        if (
          !result ||
          this.core.options.tasks.get(taskId)?.status === "active" ||
          this.pendingStarts.has(taskId)
        )
          return;
        this.core.options.broadcastEvent({ type: "firstmate_note", text: result, taskId });
      })
      .catch((caught: unknown) => this.reportCardEffectFailure(taskId, caught));
    return undefined;
  }

  /**
   * The ladder's nudge with the captain's authority. The stall card's names
   * its card; the task card's names where it came from, so the two clicks
   * read apart on the record and neither is listed twice.
   */
  private continueStuckTask(
    taskId: string,
    from: "card" | typeof TASK_CARD_VIA,
    panel?: string,
  ): void {
    void this.core.steer
      .steerCrewmate(
        taskId,
        this.core.ladder.nudgeFor(taskId),
        "captain",
        from === "card"
          ? { via: "card", cardId: stallCardId(taskId) }
          : { via: from, ...(panel ? { panel } : {}) },
      )
      .catch((caught: unknown) => this.reportCardEffectFailure(taskId, caught));
  }

  /** A stall card's effect that could not run: one feed line, as a card choice's does. */
  reportCardEffectFailure(taskId: string | undefined, caught: unknown): void {
    const message = caught instanceof Error ? caught.message : String(caught);
    this.core.options.broadcastEvent({
      type: "firstmate_note",
      text: `Could not carry out your choice for "${this.core.cardActions.taskTitle(taskId)}": ${message}`,
      ...(taskId ? { taskId } : {}),
    });
  }
}
