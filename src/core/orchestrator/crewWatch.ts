import { resolve as resolvePath } from "node:path";
import { reportSummary } from "@shared/feed";
import { formatDurationShort } from "@shared/quotaSignals";
import { cutText } from "@shared/textCut";
import { capWithOverflow } from "../overflow";
import { errorText } from "../personal/errorText";
import { NotOpenThere } from "../placed/crewMachines";
import type { AnsweredRead } from "../session/openReads";
import { LOCAL_MACHINE_ID } from "../session/session";
import {
  FIRSTMATE_RECIPIENT,
  INBOX_ATTEMPT_MAX,
  type InboxRow,
  SUPERVISION_RECIPIENT,
} from "../storage/inboxStore";
import type { TaskRecord } from "../storage/taskRecords";
import { carryOnWords } from "../tasks/recordActivity";
import { TaskService } from "../tasks/taskService";
import { CheckWatcher } from "./checkWatch";
import type { CrewCore } from "./crewCore";
import { SUPERVISOR_STEER, type TaskRuntime } from "./crewRuntime";
import { JOB_BOUND_MS } from "./idleLadder";
import { retireLeftoverBranches } from "./leftoverBranches";
import { MainCheckWatcher } from "./mainCheckWake";
import { RunWatcher } from "./runWatch";
import { ModelWaitError, NotAcceptedError } from "./taskMoves";
import type { Ticker } from "./ticker";
import type { OpenCallFact } from "./turnWakes";
import { laneText, laneTurnText, renderWake, type WakeBody } from "./wakes";
import { mergesInOwnBatch } from "./workShape";

/**
 * The quiet-crewmate watchdog (P4): conservative thresholds, no settings
 * surface. Ten silent minutes on a streaming turn earns one line on the
 * task's own record, twenty a check with the live session that runs it and a wake to the
 * Firstmate unless that check ended the turn; the generous wall-clock bound
 * escalates a turn that never ends. The watchdog never stops a turn that
 * still runs (firstmate's rule: the bound demands inspection, never an
 * automatic kill); it ends only one its live session says is already over
 * (INF-2332). Exported for the Firstmate agent's own-turn watchdog, which
 * mirrors them.
 */
export const QUIET_FEED_MS = 10 * 60 * 1000;

export const QUIET_CARD_MS = 20 * 60 * 1000;

/** A turn's wall-clock bound; a background job counts as moving for the same (idleLadder.ts). */
const TURN_WALL_CLOCK_MS = JOB_BOUND_MS;

const WATCHDOG_TICK_MS = 60 * 1000;

function listSome(items: string[], limit = 5): string {
  const shown = items.slice(0, limit).join(", ");
  return items.length > limit ? `${shown}, and ${items.length - limit} more` : shown;
}

/**
 * The crew's watch (docs/inbox.md, docs/report-sort.md): the boot sweep of
 * working copies, the watchdog's tick, the inbox and task lane sweeps,
 * quiet crewmates and the waits they are named, the idle ladder's
 * reconcile, the ready sweep and the check watches. Shares the crew's
 * state through `CrewCore`.
 */
export class CrewWatch {
  /** The watchdog's registrations on the shared ticker, undone at dispose. */
  private watchdog: (() => void)[] | undefined;
  /** Ready sweeps running now, each until it ends (`sweepGates`). */
  private readonly sweeping = new Set<Promise<void>>();
  /** Serializes inbox sweeps: a resume-heavy pass must not overlap itself. */
  private sweepingInbox = false;
  private readonly checkWatch: CheckWatcher | undefined;
  /** Wakes baseline waits when the default branch's own run of that check passes. */
  private readonly mainCheckWake: MainCheckWatcher | undefined;
  private readonly runWatch: RunWatcher | undefined;

  constructor(private readonly core: CrewCore) {
    const options = core.options;
    const readRunWatch = options.readRunWatch;
    this.runWatch = readRunWatch
      ? new RunWatcher({
          tasks: options.tasks,
          inbox: options.inbox,
          read: readRunWatch,
          steer: (taskId, wake) => this.core.steer.steerInternal(taskId, wake, SUPERVISOR_STEER),
          ...(options.readRunBatch ? { batchOf: options.readRunBatch } : {}),
        })
      : undefined;
    const readCheckWatch = options.readCheckWatch;
    this.checkWatch = readCheckWatch
      ? new CheckWatcher({
          tasks: options.tasks,
          inbox: options.inbox,
          read: readCheckWatch,
          ...(options.readComments ? { readComments: options.readComments } : {}),
          ...(options.readPull
            ? {
                reconcileMerged: (taskId: string) =>
                  this.core.settling.settle.reconcileExternalMerge(taskId),
              }
            : {}),
          // The posture the Tasks dot shows as "Blocked by another task".
          idleBehindOtherWork: (record) => {
            const posture = this.core.postures.workPosture(record);
            return posture.state === "idle" && posture.reason === "dependency";
          },
          steer: (taskId, wake) => this.core.steer.steerInternal(taskId, wake, SUPERVISOR_STEER),
          runKept: (taskId) => {
            void this.core.settling.kept.runMergeAuthorization(taskId).catch((caught: unknown) => {
              console.warn("[crew] kept merge after passed checks failed:", caught);
            });
          },
          readsBranch: (record) => readsOwnBranch(record, this.core),
          versionAwaited: (record) => this.core.cards.awaitsVersion(record.id),
          working: (record) =>
            record.activity === "running" ||
            this.core.options.hasRunningJobs?.(record.id) === true ||
            this.core.starts.clientJobStart(record.id) !== undefined,
        })
      : undefined;
    const readMainChecks = options.readMainChecks;
    this.mainCheckWake = readMainChecks
      ? new MainCheckWatcher({
          tasks: options.tasks,
          inbox: options.inbox,
          read: readMainChecks,
          steer: async (taskId, wake) => {
            this.core.options.tasks.turns.endIdle(taskId);
            await this.core.steer.steerInternal(taskId, wake, SUPERVISOR_STEER);
          },
        })
      : undefined;
  }

  /** The quit: the watchdog's registrations on the shared ticker are undone. */
  stopWatchdog(): void {
    for (const unregister of this.watchdog ?? []) unregister();
    this.watchdog = undefined;
  }

  /** Ready sweeps running now: the quit waits for them. */
  sweeps(): Iterable<Promise<void>> {
    return this.sweeping.values();
  }

  /** A lane's account serves again: its due rows go now, resuming the task if need be. */
  deliverLane(taskId: string): void {
    const task = this.core.tasks.get(taskId);
    if (task) {
      this.core.turns.deliverPendingToTask(task);
      return;
    }
    void this.sweepTaskLane(taskId, this.core.now());
  }

  /**
   * Boot-time fleet reconciliation (WI-7). Closed rows still holding a
   * worktree retire it, and so does every directory under the worktrees
   * area that no record explains - the same rule as a close: the work is
   * saved on a hidden kept ref first, and only a failed save keeps a tree.
   * Every task branch (marked as a task's, or `fm/task-*`) that no live row explains - no record at all,
   * or a row that is closed without a worktree, or open and not yet
   * started - is deleted too, its work saved on the kept ref first
   * (`leftoverBranches.ts`); only one that could not be deleted is named.
   */
  async reconcileFleetHygiene(): Promise<void> {
    const kept: TaskRecord[] = [];
    for (const record of this.core.options.tasks.withPresentWorkspace()) {
      if (record.kind !== "work" || !record.worktreeDir || record.workspaceState !== "present") {
        continue;
      }
      if (record.status !== "done" && record.status !== "dropped") continue;
      if (
        (await this.core.settling.closing.retireWorkspace(record.id, { noteKept: false })) ===
        "kept"
      )
        kept.push(record);
    }
    const orphansKept = await this.retireOrphanWorktrees();
    const branchesKept = await retireLeftoverBranches(this.core);
    const parts: string[] = [];
    if (kept.length > 0) {
      parts.push(
        `${kept.length} closed ${kept.length === 1 ? "task keeps its working copy because its work could not be saved first" : "tasks keep their working copies because their work could not be saved first"}: ${listSome(kept.map((record) => `"${record.title}"`))}`,
      );
    }
    if (orphansKept.length > 0) {
      parts.push(
        `${orphansKept.length} ${orphansKept.length === 1 ? "working copy with no task is kept because its work" : "working copies with no task are kept because their work"} could not be saved first: ${listSome(orphansKept)}`,
      );
    }
    if (branchesKept.length > 0) {
      parts.push(
        `${branchesKept.length} leftover task ${branchesKept.length === 1 ? "branch is" : "branches are"} kept because ${branchesKept.length === 1 ? "it" : "they"} could not be deleted: ${listSome(branchesKept)}`,
      );
    }
    if (parts.length > 0) {
      this.core.options.broadcastEvent({ type: "firstmate_note", text: `${parts.join("; ")}.` });
    }
  }

  /**
   * Boot: a directory under the worktrees area that no record explains -
   * its record purged, a close whose removal never finished, a crash
   * between creating a tree and recording it - retires like a closed
   * task's: work saved on the kept ref named for the directory, then
   * removed. A tree a live or dispatching row might own is never touched,
   * and neither is one whose work cannot be saved. Answers the names kept.
   */
  private async retireOrphanWorktrees(): Promise<string[]> {
    const explained = (name: string): boolean => {
      if (this.core.tasks.has(name)) return true;
      const own = this.core.options.tasks.get(name);
      if (own && (!TaskService.isClosed(own) || own.workspaceState === "present")) return true;
      const dir = resolvePath(this.core.options.paths.worktreesDir, name);
      return this.core.options.tasks
        .withPresentWorkspace()
        .some(
          (record) =>
            record.workspaceState === "present" &&
            Boolean(record.worktreeDir) &&
            resolvePath(record.worktreeDir) === dir,
        );
    };
    const kept: string[] = [];
    for (const name of this.core.options.workspace.listWorktreeDirs()) {
      if (explained(name)) continue;
      const workspace = await this.core.options.workspace.workspaceAt(name);
      // A dispatch may have claimed the name while git was awaited.
      if (explained(name)) continue;
      if (!workspace) {
        if (!(await this.core.options.workspace.removeEmptyWorktreeDir(name))) {
          console.warn(`[workspace] kept ${name}: not a working copy of its own`);
          kept.push(name);
        }
        continue;
      }
      const retired = await this.core.options.workspace
        .retireTaskWorktree(workspace)
        .catch((caught): { outcome: "kept"; reason: string } => ({
          outcome: "kept",
          reason: caught instanceof Error ? caught.message : String(caught),
        }));
      if (retired.outcome === "kept") kept.push(name);
      else if (retired.kept) {
        console.info(`[workspace] removed ${name}; its work is saved at ${retired.kept.ref}`);
      }
    }
    return kept;
  }

  /**
   * A session event or a running background job means the crewmate is alive:
   * reset the quiet escalation.
   */
  noteTaskActivity(task: TaskRuntime): void {
    task.lastEventAt = this.core.now();
    task.quietLevel = 0;
    task.waitNamed = undefined;
  }

  /**
   * A background job's exit becomes the crewmate's next turn (R2), through
   * the durable inbox: recorded on the task's lane, delivered now on an
   * idle session, at turn end behind a streaming one, after a resume for a
   * task a previous process left idle - and never silently dropped, because
   * the row outlives any failed delivery and the quit itself. `result` is
   * the typed `job-exit` wake; the replay hands over the recorded text.
   */
  deliverJobResult(taskId: string, result: WakeBody): void {
    const task = this.core.tasks.get(taskId);
    if (task?.session && !task.turn.closing) {
      this.noteTaskActivity(task);
      this.core.options.inbox.enqueue(taskId, result);
      // A started task in the backlog keeps it on its lane until a Start.
      if (this.core.facts.inBacklog(taskId))
        this.core.steer.tellBacklogNews(taskId, renderWake(result));
      else if (!task.turn.busy) this.core.turns.deliverPendingToTask(task);
      return;
    }
    const record = this.core.options.tasks.get(taskId);
    if (record && TaskService.isResumable(record) && record.sessionFile) {
      this.core.options.inbox.enqueue(taskId, result);
      // A held lane keeps it until its account serves again, or until a
      // started task in the backlog is started again.
      if (this.core.facts.laneHeld(taskId)) return;
      if (this.core.facts.inBacklog(taskId)) {
        this.core.steer.tellBacklogNews(taskId, renderWake(result));
        return;
      }
      // A task bound to another login reopens there, not where it was (`LoginMoves`).
      if (this.core.loginMoves.takes(taskId, (open) => this.core.turns.deliverPendingToTask(open)))
        return;
      void this.core.sessions
        .resumeTask(taskId)
        .then((resumed) => this.core.turns.deliverPendingToTask(resumed))
        .catch(() => {
          // The row is durable; the tick sweep retries the resume.
        });
      return;
    }
    // The task ended first (WI-2): nothing from a dead task wakes anyone.
    // One self-contained feed line says the job finished; its output is moot.
    this.core.options.broadcastEvent({
      type: "firstmate_note",
      text: `A background job finished after ${record ? `"${record.title}"` : `task ${taskId}`} ended; its output was set aside.`,
      taskId,
    });
  }

  /**
   * The shared tick (P4 + R1 + the inbox ladder) on the host's one ticker;
   * start once from main. The order is the contract: the idle ladder's
   * reconcile (with the job bound it reads) runs before the gate sweep.
   */
  startWatchdog(ticker: Ticker): void {
    if (this.watchdog) return;
    this.watchdog = [
      ticker.register("quiet-turns", WATCHDOG_TICK_MS, (now) => this.checkQuietTasks(now)),
      ticker.register("idle-ladder", WATCHDOG_TICK_MS, (now) => this.reconcileIdle(now)),
      ticker.register("firstmate-quiet", WATCHDOG_TICK_MS, (now) =>
        this.core.hooks().checkQuiet?.(now),
      ),
      ticker.register("gate-sweep", WATCHDOG_TICK_MS, (now) => this.sweepGates(now)),
      ticker.register("in-place-folders", WATCHDOG_TICK_MS, () =>
        this.core.inPlaceWork.closeCurrentFolders(),
      ),
      ticker.register("check-watch", WATCHDOG_TICK_MS, (now) => this.pollCheckWatches(now)),
      ticker.register("kept-merges", WATCHDOG_TICK_MS, (now) =>
        this.core.settling.kept.reconcileMergeAuthorizations(now),
      ),
      ticker.register("inbox-sweep", WATCHDOG_TICK_MS, (now) => this.sweepInbox(now)),
      ticker.register("firstmate-inbox", WATCHDOG_TICK_MS, () => this.core.hooks().pokeInbox?.()),
      ticker.register("watchdog-riders", WATCHDOG_TICK_MS, (now) =>
        this.core.options.onWatchdogTick?.(now),
      ),
    ];
  }

  /**
   * The durable-inbox re-ring ladder (design A): one pass over every task
   * lane holding undelivered rows. Rows past their grace get one delivery
   * attempt; rows whose attempt budget is spent escalate loudly - once -
   * and stop retrying; rows for a task that no longer exists become one
   * honest firstmate notice. The firstmate lane is the agent's own to
   * drain; the tick only pokes it (startWatchdog).
   */
  /**
   * Name the crew a restart cut, including turns still running elsewhere.
   * The announcement records pending observation, never proof of recovery.
   * Session events and the existing boot sweep supply the outcome; writing
   * or reading the facts never sends guidance or wakes either agent.
   */
  announceCarryOn(): void {
    const carrying: TaskRecord[] = [];
    const recipients = new Set([
      ...this.core.options.inbox.recipientsWithRows(),
      ...this.core.options.tasks
        .listActive()
        .filter((record) => record.activity === "running")
        .map((record) => record.id),
    ]);
    for (const recipient of recipients) {
      if (recipient === FIRSTMATE_RECIPIENT || recipient === SUPERVISION_RECIPIENT) continue;
      const record = this.core.options.tasks.get(recipient);
      if (!record || TaskService.isClosed(record)) continue;
      // A started task in the backlog does not carry on (INF-2062).
      if (record.backlogSince != null) continue;
      const cut = this.core.options.inbox
        .allFor(recipient)
        .some((row) => row.cuts > 0 || row.facts?.kind === "turn-resumed");
      if (cut || record.activity === "running") {
        carrying.push(record);
        if (!this.core.restarts.observing(record.id)) {
          this.core.restarts.observe(record.id);
          this.core.restarts.recordRestartOutcome(
            record.id,
            "pending",
            "automatic recovery has not started a request yet",
          );
        }
      }
    }
    if (carrying.length === 0) return;
    this.core.options.broadcastEvent({
      type: "firstmate_note",
      text: carryOnWords(
        carrying.map((record) => ({ key: record.key || record.id, title: record.title })),
      ),
    });
  }

  async sweepInbox(now: number): Promise<void> {
    if (this.sweepingInbox) return;
    this.sweepingInbox = true;
    try {
      for (const recipient of new Set([
        ...this.core.options.inbox.recipientsWithRows(),
        ...this.core.restarts.observed(),
      ])) {
        // Service-owned lanes have their own consumers. In particular the
        // firstmate tick drains its lane, and boot reassigns retired supervision
        // rows; neither those nor registered service work is orphan task guidance.
        if (this.core.options.inbox.isServiceRecipient(recipient)) continue;
        await this.sweepTaskLane(recipient, now);
      }
    } finally {
      this.sweepingInbox = false;
    }
  }

  async sweepTaskLane(taskId: string, now: number): Promise<void> {
    if (this.core.options.inbox.isServiceRecipient(taskId)) return;
    const spent = this.core.options.inbox.spent(taskId, INBOX_ATTEMPT_MAX);
    if (spent.length > 0) this.escalateTaskGuidance(taskId, spent);
    // A started task in the backlog keeps its lane until a Start (INF-2062).
    if (this.core.facts.inBacklog(taskId)) return;
    if (
      this.core.restarts.observing(taskId) &&
      this.core.facts.laneHeld(taskId) &&
      !this.core.steer.handingOver(taskId)
    )
      this.core.restarts.recordRestartOutcome(
        taskId,
        "waiting",
        this.core.facts.outOfReach(taskId)
          ? "its computer is out of reach or still catching up"
          : this.core.updates.waitsForUpdateThere(taskId)
            ? "its computer must be updated first"
            : this.core.moves.waitsForModel(taskId)
              ? this.core.moves.modelWaitWords(taskId)
              : "its subscription is waiting for its sign-in or allowance",
      );
    const due = this.core.facts.deliverableRows(taskId, now);
    if (due.length === 0) return;
    const task = this.core.tasks.get(taskId);
    if (task) {
      if (task.turn.closing || !task.session) return;
      if (this.core.facts.laneHeld(taskId)) return;
      if (!task.turn.busy) {
        this.core.turns.deliverPendingToTask(task);
        return;
      }
      if (!task.turn.running) return;
      // Streaming: a due row here is a failed native steer past its grace.
      // A followup-queue backend's rows simply wait for the turn to end.
      if (task.session.controlProfile.steer !== "native") return;
      // Nor is one steered into a turn on a login the task is leaving (`LoginMoves`).
      if (this.core.loginMoves.bindsTask(taskId)) return;
      const pictures = this.core.facts.rowPictures(taskId, due);
      if (pictures.blocked) return;
      const ids = this.core.turns.deliverRows(taskId, due);
      try {
        await this.core.steer.steerIntoTurn(
          task,
          task.session,
          laneTurnText(due),
          ids,
          pictures.images,
        );
      } catch (caught) {
        // A conversation that did not open there again: they go back unspent.
        if (caught instanceof NotOpenThere) this.core.options.inbox.reparkUndelivered(ids);
        else this.core.options.inbox.release(ids);
      }
      return;
    }
    const record = this.core.options.tasks.get(taskId);
    if (record?.status === "open") return; // waits for dispatch
    if (!record || TaskService.isClosed(record)) {
      this.orphanTaskGuidance(taskId, record);
      return;
    }
    // A missing local conversation is not a closed task. A new wake can make
    // this lane due beside older, escalated guidance; keep both until the
    // unfinished task can resume, rather than orphaning its entire lane.
    if (record.kind !== "work" || !TaskService.isResumable(record) || !record.sessionFile) {
      this.core.restarts.recordRestartOutcome(
        taskId,
        "stopped",
        !record.sessionFile ? "its saved conversation is unavailable" : "its task is not resumable",
      );
      return;
    }
    if (this.core.sessions.retiredProviderOf(taskId)) {
      // Its session belongs to a subscription this build no longer offers:
      // no backend can reopen it, so the guidance is kept, not retried.
      this.core.restarts.recordRestartOutcome(
        taskId,
        "stopped",
        "it ran on a subscription no longer offered",
      );
      this.orphanTaskGuidance(taskId, record, "it ran on a subscription no longer offered");
      return;
    }
    // A task a previous process left idle or interrupted: resume and
    // deliver - this is what makes a quit-with-recorded-guidance heal at
    // the next boot instead of losing the message. A held lane waits for
    // its account first.
    if (this.core.facts.laneHeld(taskId)) return;
    // A task bound to another login reopens there, not where it was (`LoginMoves`).
    if (this.core.loginMoves.takes(taskId, (open) => this.core.turns.deliverPendingToTask(open)))
      return;
    const pictures = this.core.facts.rowPictures(taskId, due);
    if (pictures.blocked) return;
    const ids = this.core.turns.deliverRows(taskId, due);
    try {
      const resumed = await this.core.sessions.resumeTask(taskId);
      // A hold that came up while the conversation opened starts no turn:
      // the rows go back unspent for the delivery after it.
      if (this.core.facts.laneHeld(taskId)) {
        this.core.options.inbox.reparkUndelivered(ids);
        if (due.every((row) => row.facts?.kind === "conversation-restart"))
          this.core.turns.continueAfterHold(taskId);
        return;
      }
      void this.core.turns.runTurn(resumed, laneTurnText(due), ids, pictures.images);
    } catch (caught) {
      // Waiting for a model is no refused delivery: the rows go back
      // unspent, and the lane holds until a model can take it.
      if (caught instanceof ModelWaitError) {
        this.core.options.inbox.reparkUndelivered(ids);
        this.core.restarts.recordRestartOutcome(taskId, "waiting", caught.message);
        return;
      }
      // A conversation that opened but was not accepted took no words: the
      // rows go back unspent, and the next pass opens again.
      if (caught instanceof NotAcceptedError) {
        this.core.options.inbox.reparkUndelivered(ids);
        this.core.restarts.recordRestartOutcome(taskId, "waiting", caught.message);
        return;
      }
      this.core.restarts.recordRestartOutcome(
        taskId,
        "stopped",
        caught instanceof Error ? caught.message : String(caught),
      );
      this.core.options.inbox.release(ids);
    }
  }

  /** The lane's task is gone: one honest notice instead of silent rot. */
  private orphanTaskGuidance(
    taskId: string,
    record: TaskRecord | undefined,
    why = "the task is gone",
  ): void {
    const rows = this.core.options.inbox.allFor(taskId);
    this.core.options.inbox.deleteFor(taskId);
    if (rows.length === 0) return;
    this.recordUndeliveredGuidance(taskId, record?.title, why, rows);
  }

  /**
   * Guidance that never became a turn (WI-5): the task's timeline keeps the
   * guidance itself and its feed line says what happened in plain language.
   * A lane with no record left has no timeline, so the feed line alone
   * carries it. Operational chatter either way - the Firstmate is not woken.
   */
  recordUndeliveredGuidance(
    taskId: string,
    title: string | undefined,
    why: string,
    rows: InboxRow[],
  ): void {
    const guidance = capWithOverflow(laneText(rows), "undelivered-guidance");
    if (this.core.options.tasks.get(taskId)) {
      this.core.options.tasks.note(taskId, `guidance never delivered - ${why}: ${guidance}`, {
        news: true,
        feed: true,
        data: { undelivered: rows.length, why },
      });
      return;
    }
    const summary = reportSummary(guidance);
    this.core.options.broadcastEvent({
      type: "firstmate_note",
      text: `Guidance for ${title ? `"${title}"` : "a task that no longer exists"} was never delivered - ${why}${summary ? `: ${summary}` : "."}`,
    });
  }

  /**
   * The ladder's loud end for a task lane: budget spent, retries stop, and
   * the stall surfaces - a feed line and an [fm-op] carrying the guidance
   * so the agent can act (the Firstmate decides whether the captain needs
   * a card; the host raises none, cards/tasks/agents P0 WI-3).
   */
  private escalateTaskGuidance(taskId: string, rows: InboxRow[]): void {
    for (const row of rows) this.core.options.inbox.markEscalated(row.id);
    const title =
      this.core.tasks.get(taskId)?.title ?? this.core.options.tasks.get(taskId)?.title ?? taskId;
    const excerpt = capWithOverflow(laneText(rows), "escalate-guidance");
    this.core.options.broadcastEvent({
      type: "firstmate_note",
      text: `Guidance for "${title}" could not be delivered after ${INBOX_ATTEMPT_MAX} attempts.`,
      taskId,
    });
    this.core.hooks().notifyOp(
      {
        facts: {
          kind: "guidance-set-aside",
          task: { id: taskId, title },
          attempts: INBOX_ATTEMPT_MAX,
          excerpt,
        },
      },
      "agent",
      taskId,
    );
  }

  /**
   * One watchdog pass, which never stops a turn that still runs: a quiet
   * streaming task earns a feed line at ten minutes, and at twenty its live
   * session is asked whether the turn still works - one already over ends
   * as interrupted. A turn that goes on has its wait named (`nameWait`):
   * each of the app's own reads still open is answered "ask again" so the
   * turn goes on, and otherwise a wake names what it waits on; a turn past
   * the wall-clock bound escalates once more, naming its job and open call.
   * The Firstmate holds interrupt_crewmate, so the wake is the whole
   * escalation - no host card (cards/tasks/agents P0, WI-3).
   */
  checkQuietTasks(now: number): void {
    for (const task of this.core.tasks.values()) {
      if (!task.turn.busy) continue;
      // A turn on a computer out of reach goes on there, unseen here: not stuck.
      if (this.core.facts.outOfReach(task.id)) continue;
      // Quiet this long, the live session is asked whether the turn still
      // works, again after each such quiet stretch, whatever jobs run: a job
      // can outlive the turn that started it (INF-2332). A task on another
      // computer asks first and alerts after: its quiet alert goes once that
      // computer answers, unless the answer ended the turn here.
      if (now - Math.max(task.lastEventAt, task.confirmedAt ?? 0) >= QUIET_CARD_MS) {
        task.confirmedAt = now;
        if (this.core.facts.machineOf(task.id) !== LOCAL_MACHINE_ID) {
          task.quietAsk = true;
          this.core.turns.confirmTurn(task, (ended) => {
            if (!task.quietAsk || task.confirmedAt !== now) return;
            if (ended) {
              task.quietAsk = undefined;
              return;
            }
            void this.answerReadsThere(task.id).then((answered) => {
              if (!task.quietAsk || task.confirmedAt !== now) return;
              task.quietAsk = undefined;
              this.nameWait(task, now, answered);
              this.quietAlerts(task, now);
            });
          });
        } else {
          this.core.turns.confirmTurn(task);
          if (task.turn.busy) this.nameWait(task, now, task.openReads.answer(now - QUIET_CARD_MS));
        }
        if (!task.turn.busy) continue;
      }
      this.quietAlerts(task, now);
    }
  }

  /**
   * The reads a task's computer answered "ask again" at the quiet check,
   * as this Mac's clock reads when each began; none when it could not be asked.
   */
  private async answerReadsThere(taskId: string): Promise<AnsweredRead[]> {
    const ask = this.core.options.machines?.answerReads;
    if (!ask) return [];
    try {
      const answered = await ask.call(this.core.options.machines, taskId);
      const at = this.core.now();
      return answered.map((read) => ({ tool: read.tool, since: at - read.waitedMs }));
    } catch (caught) {
      console.warn(
        `[crew] could not ask ${taskId}'s computer to answer its open reads: ${errorText(caught)}`,
      );
      return [];
    }
  }

  /**
   * The twenty-minute check's account of what a quiet turn that goes on
   * waits on (INF-2603). Reads the app answered "ask again" go on the
   * timeline, and the quiet alert waits for the next check, which finds the
   * turn moving or names it. A steer this check and the previous one both
   * found unread wakes the first mate once, naming what it waits behind,
   * unless the answered reads were all it waited on.
   */
  private nameWait(task: TaskRuntime, now: number, answered: readonly AnsweredRead[]): void {
    if (!task.turn.busy) return;
    task.waitNamed = true;
    task.readsAnsweredAt = answered.length > 0 ? now : undefined;
    for (const read of answered)
      this.core.options.tasks.note(
        task.id,
        `answered ${read.tool} "ask again" for the crewmate: it had no answer for ${formatDurationShort(Math.max(0, now - read.since))}`,
        { news: true },
      );
    const unread = [...task.unreadSteers];
    const before = new Set(task.steersAtCheck ?? []);
    task.steersAtCheck = unread;
    // The calls it still waits behind: the reads just answered end on their own.
    const calls = this.openCallFacts(task);
    for (const read of answered) {
      const at = calls.findIndex((call) => call.tool === read.tool);
      if (at >= 0) calls.splice(at, 1);
    }
    if (answered.length > 0 && calls.length === 0) return;
    for (const steer of unread) {
      if (!before.has(steer) || steer.woken) continue;
      steer.woken = true;
      this.core.routeCrewEvent(
        task.id,
        {
          once: `steer-unread:${task.id}:${steer.since}`,
          facts: {
            kind: "steer-unread",
            task: { id: task.id, title: task.title },
            crewmate: task.crewmate,
            since: steer.since,
            calls,
          },
        },
        "agent",
      );
    }
  }

  /** What a turn has open now, oldest first, for a wake (INF-2603). */
  private openCallFacts(task: TaskRuntime): OpenCallFact[] {
    return [...task.openCalls.values()]
      .sort((a, b) => a.since - b.since)
      .map((call) => ({ tool: call.tool, since: call.since }));
  }

  /**
   * The wait a quiet turn's twenty-minute check named, as crew status
   * shows it until the turn moves: its open calls and unread steers.
   */
  namedWait(
    taskId: string,
  ): { words?: string; calls: OpenCallFact[]; steers: number; steersSince?: number } | undefined {
    const task = this.core.tasks.get(taskId);
    if (!task?.waitNamed || !task.turn.busy) return undefined;
    const calls = this.openCallFacts(task);
    const steers = task.unreadSteers.length;
    if (calls.length === 0 && steers === 0) return undefined;
    const now = this.core.now();
    const parts = [
      ...calls.map(
        (call) => `inside ${call.tool} ${formatDurationShort(Math.max(0, now - call.since))}`,
      ),
      ...(steers > 0
        ? [
            `${steers} steer${steers === 1 ? "" : "s"} unread ${formatDurationShort(Math.max(0, now - (task.unreadSteers[0]?.since ?? now)))}`,
          ]
        : []),
    ];
    return {
      words: parts.join("; "),
      calls,
      steers,
      ...(steers > 0 ? { steersSince: task.unreadSteers[0]?.since } : {}),
    };
  }

  private quietAlerts(task: TaskRuntime, now: number): void {
    if (!task.turn.busy) return;
    // Two hours on one turn escalates whatever runs (INF-2603): a job
    // proves the job works, not that the turn does. The wake names the job
    // and what the turn has open.
    if (now - task.turnStartedAt >= TURN_WALL_CLOCK_MS && !task.wallClockEscalated) {
      task.wallClockEscalated = true;
      const hours = Math.round(((now - task.turnStartedAt) / 3_600_000) * 10) / 10;
      const running =
        this.core.options.hasRunningJobs?.(task.id) === true ||
        this.core.starts.clientJobStart(task.id) !== undefined;
      const job = running ? this.core.starts.oldestJob(task.id) : undefined;
      const calls = this.openCallFacts(task);
      this.core.routeCrewEvent(
        task.id,
        {
          facts: {
            kind: "long-turn",
            task: { id: task.id, title: task.title },
            crewmate: task.crewmate,
            hours,
            ...(job
              ? {
                  job: {
                    command: cutText(job.command.replace(/\s+/g, " "), 80),
                    since: job.startedAt,
                  },
                }
              : {}),
            ...(calls.length > 0 ? { calls } : {}),
          },
        },
        "agent",
      );
    }
    // A running background job is proof of life (R2): a quiet turn that
    // is waiting on its own build is not stuck.
    if (this.core.options.hasRunningJobs?.(task.id)) return;
    const quietFor = now - task.lastEventAt;
    const minutes = Math.round(quietFor / 60_000);
    // A read the check just answered moves the turn on; the next check names it if not.
    const answered = task.readsAnsweredAt !== undefined && task.readsAnsweredAt >= task.lastEventAt;
    if (quietFor >= QUIET_CARD_MS && task.quietLevel < 2 && !task.quietAsk && !answered) {
      task.quietLevel = 2;
      const calls = this.openCallFacts(task);
      const unread = task.unreadSteers;
      const waits = [
        ...calls.map(
          (call) => `inside ${call.tool} for ${formatDurationShort(Math.max(0, now - call.since))}`,
        ),
        ...(unread.length > 0
          ? [`${unread.length} steer${unread.length === 1 ? "" : "s"} unread`]
          : []),
      ];
      this.core.options.tasks.note(
        task.id,
        `quiet for ${minutes} minutes; may be stuck${waits.length > 0 ? `; ${waits.join("; ")}` : ""}`,
        { news: true },
      );
      this.core.routeCrewEvent(
        task.id,
        {
          facts: {
            kind: "quiet",
            task: { id: task.id, title: task.title },
            crewmate: task.crewmate,
            minutes,
            ...(calls.length > 0 ? { calls } : {}),
            ...(unread.length > 0
              ? { steers: { count: unread.length, since: unread[0]?.since ?? now } }
              : {}),
          },
        },
        "agent",
      );
    } else if (quietFor >= QUIET_FEED_MS && task.quietLevel < 1) {
      // The task's own timeline says so; the feed stays silent, since a
      // quiet turn gives the captain nothing to do yet (INF-3060 finding
      // 6) and the first mate hears it at QUIET_CARD_MS.
      task.quietLevel = 1;
      this.core.options.tasks.note(task.id, `quiet for ${minutes} minutes`, { news: true });
    }
  }

  /** The idle reconciler over every live idle record (docs/report-sort.md; idleLadder.ts). */
  reconcileIdle(now: number): void {
    this.core.ladder.reconcileIdle(now);
  }

  /**
   * The ready sweep over open and active rows (docs/task-graph.md; the
   * ladder's `sweepGates`). Runs on the shared tick, after any close, after
   * a graph change, on quota refresh, and once at boot. The quit runs no
   * new sweep and waits for one already running (`disposeAll`).
   */
  sweepGates(now: number): Promise<void> {
    if (this.core.disposed()) return Promise.resolve();
    // One projection over the sweep's synchronous stretch, which is the
    // whole sweep unless it starts a task or drives a move: its witnesses
    // re-read the same open and active tasks, and each read composed the
    // whole record again (docs/freeze-recorder.md, "A task's close"). A
    // write inside clears it; what runs after an await reads afresh.
    const sweep: Promise<void> = this.core.options.tasks
      .readProjection(() => this.sweepReady(now))
      .finally(() => this.sweeping.delete(sweep));
    this.sweeping.add(sweep);
    return sweep;
  }

  private async sweepReady(now: number): Promise<void> {
    this.core.cards.fileMissingHostCardTasks();
    // A fix whose return to its reviewer lost its computer goes once it is back.
    void this.core.reviews.resumeLostReturns();
    // Only a sweep with a move to drive yields here, so one with none keeps its order.
    if (this.core.options.tasks.listWithComputerMove().length > 0)
      await this.core.moves.driveComputerMoves();
    for (const record of this.core.options.tasks.listOpen()) {
      const action = record.delivery?.captainAction;
      if (
        action &&
        this.core.options.tasks.delivery.captainActionReady(record.id) &&
        (action.presentedGeneration < action.generation || action.state === "blocked")
      )
        this.core.cards.presentRequiredAction(record.id);
    }
    await this.core.ladder.sweepGates(now);
  }

  /**
   * The check watch's pass (docs/forge.md, "The check watch"): every due
   * watch reads its change's checks once, and a watch whose checks
   * finished wakes its crewmate once. The same tick reads the default
   * branch for standing baseline waits (docs/forge.md, "A main failure's
   * wake"). Runs on the shared tick.
   */
  async pollCheckWatches(now: number): Promise<void> {
    await Promise.all([
      this.checkWatch?.poll(now),
      this.runWatch?.poll(now),
      this.mainCheckWake?.poll(now),
    ]);
    this.core.cards.refreshSettleFacts();
    // A hold whose end writes nothing - a failed read, a lane that can no
    // longer deliver - ends on the tick (INF-6241).
    this.core.cards.recheckHeld();
  }

  /**
   * Whether the read after the task's crewmate's newest turn has not
   * finished (`CheckWatcher.afterTurnReadOwed`); none is owed where the app
   * reads no checks.
   */
  afterTurnReadOwed(record: TaskRecord): boolean {
    return this.checkWatch?.afterTurnReadOwed(record) === true;
  }

  /**
   * Read the task's change now when its after-turn read is owed, then
   * return any merge card that read set free (INF-6241).
   */
  readAfterTurn(taskId: string): void {
    const watch = this.checkWatch;
    if (!watch) return;
    void watch
      .readAfterTurn(taskId, this.core.now())
      .then((read) => {
        if (!read) return;
        this.core.cards.refreshSettleFacts([taskId]);
        this.core.cards.recheckHeld();
      })
      .catch((caught: unknown) => {
        // The tick rechecks every held card, so a failed recheck here holds nothing.
        console.warn("[crew] could not recheck a held merge card after its read:", caught);
      });
  }
}

/**
 * The task's own pushed branch with no pull request, in a project that
 * merges in batches of its own, once a reading has named its version: the
 * check watch reads it as it reads a pull request (INF-6241).
 */
function readsOwnBranch(record: TaskRecord, core: CrewCore): boolean {
  const delivery = record.delivery;
  if (!delivery?.headSha || delivery.prNumber !== undefined || delivery.checkTarget) return false;
  const repo = record.repoId ? core.options.repos.get(record.repoId) : undefined;
  return mergesInOwnBatch(record, repo);
}
