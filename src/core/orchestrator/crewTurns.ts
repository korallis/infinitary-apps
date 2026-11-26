import { randomUUID } from "node:crypto";
import { fileSizeWords } from "@shared/attachments";
import { type CutOff, isAuthFailureMessage } from "@shared/authFailure";
import type { TurnImage } from "@shared/cards";
import { isRepairAssessment } from "@shared/checkRepair";
import { type ClaudeAccessSource, claudeAccessRefusedText } from "@shared/claudeAccess";
import { isCustomApiProvider } from "@shared/customApi";
import type { FmEvent } from "@shared/events";
import { reportSummary } from "@shared/feed";
import { offeringKey } from "@shared/modelSlots";
import { isProviderRefusal, refusalWords, type TypedFailure } from "@shared/plainProblem";
import { PROVIDER_CATALOG } from "@shared/providers";
import type { HandoverFile } from "@shared/work";
import { ComputerBehindError } from "../connection/contractChanges";
import { renderDirections } from "../knowledge/directions";
import { capWithOverflow } from "../overflow";
import { crewmateHandoverDir } from "../paths";
import { NotOpenThere } from "../placed/crewMachines";
import {
  type ControlProfile,
  LOCAL_MACHINE_ID,
  type SessionEvent,
  StoppedBeforeStartError,
} from "../session/session";
import { type InboxRow, STUCK_REFUSAL_LIMIT } from "../storage/inboxStore";
import type { TaskRecord } from "../storage/taskRecords";
import { verifyHandoverFiles } from "../tasks/handoverFiles";
import { modelMoveWords } from "../tasks/recordActivity";
import { TaskService } from "../tasks/taskService";
import type { ReportDeclaration } from "../tasks/taskTurns";
import { gitFailure } from "../workspace/git";
import type { DependencyInstall } from "../workspace/workspaceService";
import { AccountRefusals } from "./accountRefusals";
import type { CrewCore } from "./crewCore";
import { handedDirections, servesDirections } from "./crewDirections";
import { type MoveAsk, SUPERVISOR_STEER, type TaskRuntime } from "./crewRuntime";
import type { PersonalLiveDelegate } from "./crewSupervisorOptions";
import { updatePauseLine } from "./crewUpdates";
import { JOB_BOUND_MS } from "./idleLadder";
import { type BriefPart, briefText } from "./intentBrief";
import { checkBackAsk, checkBackAskOnce } from "./jobWakes";
import { outageFailedWake, stuckWake } from "./outageWakes";
import { closingWords } from "./readerData";
import { implausibleReport } from "./reportPlausibility";
import { sortReport } from "./reportSort";
import { ReportSorting, relayRecovery } from "./reportSorting";
import { PENDING_RESPONSES_END, PENDING_RESPONSES_OPENING } from "./reportWakes";
import { installText, ModelWaitError, NotAcceptedError, OpenedNothingError } from "./taskMoves";
import { keptReportNote, laneTurnText, type TypedWake } from "./wakes";

/**
 * The task timeline's line for a turn whose end never arrived, ended once
 * the live session that ran it said it no longer works (INF-2332).
 */
export const UNHEARD_END_NOTE =
  "its turn had already ended where it ran, but that end never arrived; ended here as interrupted";

/**
 * The message a conversation that replaced one the context limit failed
 * opens on, when the failed turn carried nothing but the brief.
 */
const CONTEXT_CONTINUE_TEXT = "Carry on with your task from where its record shows it stands.";

/** Lane rows that are the crewmate's own work, sent by nobody: they draw no spark (INF-759). */
const OWN_LANE_KINDS: ReadonlySet<string> = new Set([
  "job-exit",
  "conversation-restart",
  "turn-resumed",
]);

/**
 * The feed line for guidance that waited for a turn to end and goes out as
 * the next one (WI-5), and the fold that keeps one such line per task in
 * the feed (`feedOnce`, `recentFeed`; INF-1137).
 */
export const QUEUED_GUIDANCE_LINE = "Delivered guidance that waited for its turn to end";

/**
 * What a started task in the backlog hears with words sent to it (INF-2062):
 * it answers them and stays there, since only a Start picks it up again.
 */
export const BACKLOG_STEER_LINE =
  "This task waits in the backlog: answer what follows, then stop and wait. Do not carry on with the work until it is started again.";

const QUEUED_GUIDANCE_FOLD = "queued-guidance";

/**
 * A report's handed files in the words the first mate reads (INF-992):
 * kept names and sizes, never content, and the task its steer names.
 */
function handedFilesLine(
  task: { id: string; key: string },
  files: readonly HandoverFile[],
): string {
  const named = files.map((file) => `${file.file} (${fileSizeWords(file.size)})`).join(", ");
  return `Files handed on, kept for steer_crewmate files_from ${task.key || task.id}: ${named}.`;
}

/**
 * The sign-in card a crewmate's turn raises when its provider no longer
 * accepts the sign-in: one per task, taken down once the account it was held
 * on serves again (`IdleLadder.checkCutOffs`).
 */
export function crewSignInCardId(taskId: string): string {
  return `card-auth-${taskId}`;
}

/**
 * A crewmate's turn from its first prompt to its end (docs/report-sort.md,
 * docs/inbox.md): running and confirming it, reading its report, sorting
 * whose turn it is next, committing a live turn, delivering what waits on
 * its lane, and the model, account and usage it was served on. Shares the
 * crew's state through `CrewCore`.
 */
export class CrewTurns {
  /** Who waits for a task's running turn to end here, by task (`untilTurnOver`). */
  private readonly turnWaiters = new Map<string, Set<() => void>>();
  /** One wake per account for the same provider refusal. */
  private readonly accountRefusals = new AccountRefusals();

  private readonly sorting: ReportSorting;

  constructor(private readonly core: CrewCore) {
    this.sorting = new ReportSorting(core);
  }

  /**
   * A commissioned worktree can build before the crewmate's first turn
   * (interaction P0, WI-7): dependencies install from the shared pnpm store,
   * recorded on the task's timeline. It runs behind commission's return so
   * spawn_crewmate still answers at once; a steer that arrives meanwhile is
   * recorded on the lane like any mid-start steer. A failed install is a
   * timeline fact, never a failed task - the crewmate can still run it.
   */
  async prepareFirstTurn(
    task: TaskRuntime,
    brief: readonly BriefPart[],
    inboxIds: number[],
    images?: TurnImage[],
  ): Promise<void> {
    task.turn.prepare(inboxIds);
    const cwd = task.workspace?.cwd;
    const machine = this.core.facts.machineOf(task.id);
    const installing =
      machine !== LOCAL_MACHINE_ID
        ? this.core.options.machines?.install(machine, task.id)
        : cwd
          ? this.core.options.workspace.installDependencies(cwd)
          : undefined;
    if (installing) {
      const install = await installing.catch(
        (caught): DependencyInstall => ({
          outcome: "failed",
          ms: 0,
          error: caught instanceof Error ? caught.message : String(caught),
        }),
      );
      if (install.outcome !== "skipped" && this.core.options.tasks.get(task.id)) {
        // A failed install is news: the crewmate's first turn runs without it.
        this.core.options.tasks.note(task.id, installText(install), {
          news: install.outcome === "failed",
          data: {
            install: install.outcome,
            ms: install.ms,
            ...(install.outcome === "failed" ? { error: install.error } : {}),
          },
        });
      }
    }
    // Settled while installing: the close already retired the runtime and
    // the brief row. Cancelled while installing: no turn is running to end,
    // so the cancel finishes here.
    if (this.core.tasks.get(task.id) !== task) return;
    if (task.turn.closing) {
      this.core.sessions.finish(task, "cancelled");
      return;
    }
    this.core.options.tasks.recordBrief(task.id, brief);
    if (task.turn.takeStop()) {
      this.core.options.inbox.reparkUndelivered(task.turn.takeRows());
      const move = task.turn.rest("stopped");
      this.core.options.tasks.turns.setActivity(task.id, "idle");
      this.turnEnded(task.id);
      this.core.facts.broadcastCrewCounts();
      this.turnOver(task.id);
      this.afterTurn(task, move);
      return;
    }
    await this.runTurn(task, briefText(brief), inboxIds, images);
  }

  /** What another writer already answered of the thread replies these rows carry. */
  private answeredWhileQueued(inboxIds: readonly number[]): string[] {
    return inboxIds.flatMap((id) => {
      const facts = this.core.options.inbox.get(id)?.facts;
      if (facts?.kind !== "thread-reply" || facts.card.messageId === undefined) return [];
      const line = this.core.cards.answeredByContributor(facts.card.id, facts.card.messageId);
      if (!line?.contributor) return [];
      return [
        `On card "${facts.card.title}" (${facts.card.id}), ${line.contributor.label} already answered the captain's message ${facts.card.messageId} (message ${line.id}): "${line.text}" Do not answer it again; write on its thread only with something new, as a comment.`,
      ];
    });
  }

  /**
   * The project's directions this turn carries, or undefined when its
   * conversation already holds the current set or the task has no project.
   * A conversation on a computer that cannot say it folded is served them
   * on every turn (`CrewMachines.reportsFolds`).
   */
  private directionsFor(task: TaskRuntime): string | undefined {
    const repoId = this.core.options.tasks.get(task.id)?.repoId;
    if (!this.core.options.knowledge || !repoId) return undefined;
    const block = renderDirections(
      this.core.options.knowledge.directions.standing({
        kind: "crewmate",
        taskId: task.id,
        repoId,
      }),
    );
    if (!block) return undefined;
    const machine = this.core.facts.machineOf(task.id);
    const foldsHeard =
      machine === LOCAL_MACHINE_ID || this.core.options.machines?.reportsFolds?.(machine) === true;
    return servesDirections(task.directions, task.session?.sessionId, block, foldsHeard)
      ? block
      : undefined;
  }

  /**
   * The note a turn opens with when the last turn called report and then
   * stopped before it ended clean (INF-3165, docs/inbox.md "A report a
   * failed turn kept"): once per kept report in this runtime, so a restart
   * names it again.
   */
  private keptReportToTell(task: TaskRuntime): string | undefined {
    const kept = this.core.options.tasks.turns.keptReport(task.id);
    if (!kept || task.keptReportTold === kept.eventId) return undefined;
    task.keptReportTold = kept.eventId;
    return keptReportNote(kept.summary);
  }

  /** One crewmate turn: prompt to completion, then idle (multi-turn). */
  async runTurn(
    task: TaskRuntime,
    text: string,
    inboxIds: number[] = [],
    images?: TurnImage[],
  ): Promise<void> {
    // A new conversation hears why first, on this turn, even when the row
    // was queued after the message it rides.
    const leading = this.core.sessions.claimConversationRestart(task.id, inboxIds);
    const ids = [...leading.map((row) => row.id), ...inboxIds];
    this.beginTurn(task, ids);
    // The rows it delivers name the turn, so a conversation on another
    // computer starts it once however often it is asked.
    const order = laneOrder(ids);
    // A report the last turn made before it stopped short is named once,
    // after a renewed conversation's reason, so the crewmate checks and
    // reports again instead of redoing the work.
    const kept = this.keptReportToTell(task);
    let served = [leading.length > 0 ? laneTurnText(leading) : undefined, kept, text]
      .filter((part) => part !== undefined)
      .join("\n\n");
    // A captain question someone else answered while this steer waited is
    // told now, so its answerer does not answer it twice ("Shared cards").
    for (const answered of this.answeredWhileQueued(inboxIds)) served += `\n\n${answered}`;
    try {
      // The one place a crewmate is told its project's directions: the
      // brief holds none, so a first turn carries them once, and a brief
      // served again to a new conversation carries no stale copy. A later
      // turn carries them only when its conversation does not hold the
      // current set (`crewDirections.ts`).
      const directions = this.directionsFor(task);
      if (directions) served += `\n\n${directions}`;
      // A request already in this prompt's guidance is served there once.
      // Only other pending requests need the recovery-context snapshot.
      const servedInboxIds = new Set(ids);
      const pendingResponses = this.core.options.inbox
        .pendingResponses(task.id)
        .filter((request) => !servedInboxIds.has(request.inboxId));
      if (pendingResponses.length)
        served += `${PENDING_RESPONSES_OPENING}${task.key || task.id} after context loss):\n${capWithOverflow(pendingResponses.map((request) => `${request.id}: ${request.body}`).join("\n\n"), "pending-responses")}${PENDING_RESPONSES_END}`;
      const assignment = await this.core.refreshReview(task);
      if (assignment)
        served += `\n\nCurrent review assignment (supersedes earlier heads):\n${assignment}`;
      // This computer is being updated: the turn never reaches its model,
      // and its rows go again once the update is over (`saveForUpdate`).
      if (this.core.updates.heldForUpdate(task.id)) {
        if (!task.turn.pause) task.turn.hold({});
        throw new StoppedBeforeStartError();
      }
      // Held once the session reads this input (`heardDirections`).
      const conversation = task.session?.sessionId;
      if (directions && conversation)
        task.directions = handedDirections(conversation, directions, served);
      if (images?.length) await task.session?.prompt(served, images, order);
      else if (order) await task.session?.prompt(served, undefined, order);
      else await task.session?.prompt(served);
      if (this.core.disposed()) return;
      if (task.turn.closing) {
        this.core.sessions.finish(task, "cancelled");
      } else {
        // A session settles the turn an interrupt cut short (Pi and Claude
        // alike); the interrupt the host asked for is what makes it one.
        const interrupted = task.turn.takeStop();
        this.turnComplete(task, { interrupted });
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (this.core.disposed()) return;
      // Its computer must be updated before it takes this turn: the task
      // waits for that, open, and is never closed failed for it.
      if (caught instanceof ComputerBehindError && !task.turn.pause && !task.turn.closing)
        this.core.updates.waitForUpdateThere(task, caught);
      // Its conversation did not open there again before its model took the
      // turn: its words go back unspent, as for a turn an update stopped first.
      if (caught instanceof NotOpenThere && !task.turn.pause && !task.turn.closing)
        task.turn.hold({ unstarted: true, notOpen: true });
      if (!task.turn.pause) this.core.restarts.recordRestartOutcome(task.id, "stopped", message);
      if (task.turn.closing) {
        this.core.sessions.finish(task, "cancelled");
      } else if (task.turn.takeStop()) {
        this.turnComplete(task, { interrupted: true });
      } else if (task.turn.pause) {
        // The update the app stopped it for ended it there: a pause. One
        // its model never took sends its words again.
        if (caught instanceof StoppedBeforeStartError)
          task.turn.hold({ ...task.turn.pause, unstarted: true });
        task.lastTurnError ??= message;
        this.turnComplete(task);
      } else if (isSignInFailure(task.session?.controlProfile, message)) {
        // A sign-in the provider refused as the turn started (Pi's "No API
        // key found") is the captain's to fix, like one a turn reports: the
        // task stays open and idle with its working copy and the card up,
        // never closed failed (INF-849).
        task.lastTurnError ??= message;
        this.turnComplete(task);
      } else {
        this.core.sessions.finish(task, "failed", message);
      }
    }
  }

  /** Reset every per-turn buffer before either host- or provider-initiated work. */
  private beginTurn(task: TaskRuntime, inboxIds: number[] = [], continuation = false): void {
    task.turn.begin(inboxIds, continuation);
    task.currentTurnText = "";
    task.turnReport = undefined;
    task.explicitReport = undefined;
    task.explicitSummary = undefined;
    task.explicitDeclared = undefined;
    task.relayWoken = undefined;
    task.lastTurnError = undefined;
    task.lastTurnCutOff = undefined;
    task.lastTurnContextOverflow = undefined;
    task.lastEventAt = this.core.now();
    task.turnStartedAt = this.core.now();
    task.quietLevel = 0;
    task.wallClockEscalated = false;
    this.clearWait(task);
    // The task moving on its own ends its idle episode (docs/report-sort.md):
    // the clock, the rungs and the host's stall card all go. The one turn
    // that does not is the ladder's own nudge - that turn is the ladder
    // acting, and its episode goes on until something else moves the task.
    if (!this.isLadderTurn(task.id, inboxIds)) {
      this.core.options.tasks.turns.endIdle(task.id);
      this.core.ladder.withdrawStallCard(task.id);
    }
    // Whatever the last report declared about whose turn followed it no
    // longer stands once a turn runs: a delivered input started this one,
    // and its own report says it again if it still holds.
    if (this.core.options.tasks.turns.clearDeclaration(task.id)) {
      this.core.ladder.syncCaptainGate(task.id, this.core.now());
    }
    this.core.facts.broadcastCrewCounts();
    this.core.options.tasks.turns.setActivity(task.id, "running");
    // A build the host started for its page is left alone while the turn runs.
    this.core.options.browsers?.turn?.(task.id, true);
  }

  /**
   * The sign-in card's body, in product words from what the host knows - the
   * crewmate's provider and connection - and never the failure's own text: a
   * client's words name a terminal command, and Pi's add its sign-in
   * instructions and paths into the app's files. The raw text stays on the
   * task's timeline and behind its feed line. A custom connection is named,
   * with the way to check it again, since a sign-in is not what it needs.
   */
  private signInCardBody(task: TaskRuntime): string {
    // A task on another computer runs on that computer's own sign-in, so
    // that is where the captain signs in again (docs/helper.md, "Its own
    // sign-ins"); this Mac's own account is not the one that lapsed.
    const record = this.core.options.tasks.get(task.id);
    const device = record?.deviceId;
    const where = device ? this.core.options.machines?.placeOf(device).where : undefined;
    const crewmate = where ? `The crewmate ${where}` : "The crewmate";
    const provider = signInProvider(task.session?.modelRef()?.provider, record?.model);
    if (provider && isCustomApiProvider(provider)) {
      const label = task.accountId
        ? this.core.options.accounts?.labelOf(task.accountId)
        : undefined;
      const connection = label ? `${label}, your custom connection` : "its custom connection";
      return `${crewmate} could not reach ${connection}. In Settings → Intelligence, press Edit on ${label ? "it" : "that connection"}${where ? ` ${where}` : ""}, then Save to check it again.`;
    }
    // Claude access set up for Claude Code is renewed where the person
    // renews it for Claude Code, never with a sign-in here.
    const access = this.localAccess(task);
    if (access) return claudeAccessRefusedText(crewmate, access, where);
    const name = PROVIDER_CATALOG.find((entry) => entry.id === provider)?.name;
    return `${crewmate} could not reach ${name ?? "its subscription"}, which needs you to sign in again${where ? ` ${where}` : ""}.`;
  }

  /**
   * The rows of the steers the session accepted that no turn took in: the
   * window is the turn's own tail (the run made its last check of the
   * queue, or ended, before the steer landed). A session delivers its
   * steers oldest first, so what is left over is the newest. Taken at every
   * turn end, whatever becomes of the rows, so a steer left over from one
   * turn is never counted against the next one's.
   */
  undeliveredSteerRows(task: TaskRuntime): number[] {
    return task.turn.takeUnheard(task.session?.takeUndeliveredSteers().length ?? 0);
  }

  private isLadderTurn(taskId: string, inboxIds: number[]): boolean {
    const record = this.core.options.tasks.get(taskId);
    if (!record || record.recoveryAt == null) return false;
    return this.core.options.tasks.turns.onlyLadderSteers(taskId, inboxIds);
  }

  /**
   * An MCP report can reach the host before the SDK exposes the assistant
   * message that reveals an autonomous continuation. Open the boundary at
   * the earliest observable session signal so the prior turn's buffers
   * cannot consume or later erase this report.
   */
  recordReportFromSession(
    task: TaskRuntime,
    text: string,
    summary?: string,
    declared?: ReportDeclaration,
  ): string | Promise<string> {
    if (!task.turn.busy) this.startAutonomousTurn(task);
    // Handed files are checked whole here before the report counts, and
    // named in it by kept name and size only, never content (INF-992).
    if (declared?.files && declared.files.length > 0) {
      const { files, ...rest } = declared;
      const dir = crewmateHandoverDir(this.core.options.paths, task.id);
      return (
        verifyHandoverFiles(dir, files)
          // A rule's notes file among them replaces the rule's notes, or the report is refused.
          .then(() => this.core.ruleNotes()?.takeBack(task.id, dir, files))
          .then(() =>
            this.recordReportBody(
              task,
              `${text}\n\n${handedFilesLine(task, files)}`,
              summary,
              rest,
              text,
            ),
          )
      );
    }
    return this.recordReportBody(task, text, summary, declared);
  }

  /** A report whose handed files, if any, are already checked. */
  private recordReportBody(
    task: TaskRuntime,
    text: string,
    summary?: string,
    declared?: ReportDeclaration,
    responseText = text,
  ): string | Promise<string> {
    if (declared?.validation)
      return this.core.reportIntake
        .recordValidationReport(task, text, summary, declared, responseText)
        .then((receipt) => {
          this.core.cards.closeOut({ kind: "crewmate", taskId: task.id }, "report");
          this.relayNow(task);
          return receipt;
        });
    const receipt = this.core.reportIntake.recordExplicitReport(
      task,
      text,
      summary,
      declared,
      responseText,
    );
    // The report is the crewmate's close-out for its new cards: they reach
    // the stage now. A card the captain already had waits for the turn's
    // end, so it comes back once, with the crewmate's last word (INF-926).
    this.core.cards.closeOut({ kind: "crewmate", taskId: task.id }, "report");
    this.relayNow(task);
    return receipt;
  }

  /**
   * A relay wakes the first mate when it is made (INF-3926's finding 2):
   * a report that declares `needs_firstmate` carries a captain decision
   * only the first mate can carry out, and its crewmate's turn may go on
   * for an hour after it. So the report call itself sorts it at row 0a
   * and wakes the first mate, with the same words the turn's end would
   * send. A captain reply still waiting for this crewmate's answer holds
   * it (row 0), and the turn's end decides as before. The same request
   * twice in one turn wakes once. A relay the turn's end would not sort
   * (a review's verdict, a repair assessment) waits for it as before.
   */
  /** Whether a relay this task's crewmate makes now wakes the first mate at once (`relayNow`). */
  relayWakesNow(task: TaskRuntime): boolean {
    if (this.core.cards.threadAwaitingAuthor(task.id)) return false;
    const record = this.core.options.tasks.get(task.id);
    if (!record || TaskService.isClosed(record)) return false;
    // A reviewer's or a repair assessment's report settles at the turn's
    // end through its own owner, which carries its request on.
    return record.shape?.kind !== "review" && !isRepairAssessment(record.shape);
  }

  private relayNow(task: TaskRuntime): void {
    const report = task.explicitReport;
    const declared = task.explicitDeclared;
    const request = declared?.needsFirstmate;
    if (report === undefined || !request) return;
    if (task.relayWoken?.request === request) return;
    if (!this.relayWakesNow(task)) return;
    task.relayWoken = {
      request,
      report,
      at: this.core.now(),
      filed: task.filedThisTurn.length,
      withdrawn: task.withdrawnThisTurn.length,
      recovery: relayRecovery(declared),
    };
    const turn = { filed: [...task.filedThisTurn], withdrawn: [...task.withdrawnThisTurn] };
    this.core.options.tasks.readProjection(() => {
      const { wake, stall, recoveryWays } = this.sorting.reportWake(
        task,
        report,
        turn,
        declared,
        true,
      );
      if (this.core.bypassesSupervision(task.id)) {
        this.core.hooks().notifyOp(wake, "crewmate-report", task.id);
        return;
      }
      const sort = sortReport({
        ...this.core.ladder.witnesses(task.id, this.core.now()),
        filedFollowups: turn.filed.length > 0,
        finished: declared?.finished === true,
        needsFirstmate: true,
        recovery: stall !== undefined || recoveryWays !== undefined,
        workObservable: task.session?.controlProfile.backgroundWork === "host",
      });
      this.recordSort(task.id, task.title, wake, sort.verdict, sort.reason, sort.rule, () => {
        if (sort.wake) this.core.hooks().notifyOp(wake, "crewmate-report", task.id);
      });
    });
  }

  /**
   * Claude can continue after prompt() settled when background work
   * completes; a conversation on another computer runs a turn this Mac did
   * not start here - one a restart here left running there - with the lane
   * rows it delivers, which its end acknowledges.
   */
  startAutonomousTurn(task: TaskRuntime, inboxIds: number[] = []): void {
    if (this.core.tasks.get(task.id) !== task || task.turn.closing || task.turn.busy) return;
    this.beginTurn(task, inboxIds, true);
    // Its computer is being updated: the turn it began there stops too.
    this.core.updates.turnBegan(task);
  }

  /**
   * Complete an autonomous boundary exactly once, using the normal report
   * path; an interrupt the host asked for ends it the way it ends a prompt.
   * One whose end never arrived (`unheard`), because the live session that
   * ran it says it no longer works, ends as interrupted too, so the idle
   * ladder takes the task from there (INF-2332).
   */
  endAutonomousTurn(task: TaskRuntime, error?: string, cutOff?: CutOff, unheard?: boolean): void {
    if (task.turn.stage !== "continuation" || this.core.tasks.get(task.id) !== task) return;
    if (error && !task.lastTurnError) {
      task.lastTurnError = error;
      task.lastTurnCutOff = cutOff;
    }
    if (unheard) this.core.options.tasks.note(task.id, UNHEARD_END_NOTE, { news: true });
    const interrupted = task.turn.takeStop() || unheard === true;
    this.turnComplete(task, { interrupted });
  }

  /**
   * Asks the live session whether a turn the supervisor holds as working
   * still works (INF-2332). A crewmate here is read from its own session:
   * a turn it carried on by itself, which that session no longer runs, ends
   * as interrupted, while a prompt's turn ends with its own prompt. One on
   * another computer is asked of that computer, which ends such a turn once
   * every event it counted is in. Nothing that still runs is stopped.
   */
  confirmTurn(task: TaskRuntime, answered?: (ended: boolean) => void): void {
    if (!task.turn.busy) return;
    if (this.core.facts.machineOf(task.id) === LOCAL_MACHINE_ID) {
      if (task.turn.stage === "continuation" && task.session && !task.session.isStreaming())
        this.endAutonomousTurn(task, undefined, undefined, true);
      return;
    }
    const asked = this.core.options.machines?.confirm?.(task.id) ?? Promise.resolve(false);
    void asked
      .catch((caught: unknown) => {
        const error = caught instanceof Error ? caught.message : String(caught);
        console.warn(`[crew] could not ask whether ${task.id}'s turn still works: ${error}`);
        return false;
      })
      .then((ended) => answered?.(ended));
  }

  /**
   * A turn ended: the task stays steerable, and the Firstmate hears about it
   * only when the crewmate actually reported (interaction P0, WI-1). The
   * report is the explicit report call, else the turn's final message when
   * that message has text - never an earlier turn's text re-sent. A turn
   * that ends silently (a job result it only noted, a card click, a provider
   * hiccup) wakes nobody - even when it filed follow-ups: the rows stand on
   * the record and the task index shows them (P0, WI-4); the quiet watchdog
   * still covers a stuck turn. A report that is not plausible prose is a
   * failed turn, never an outcome.
   */
  private turnComplete(task: TaskRuntime, options: { interrupted?: boolean } = {}): void {
    this.clearWait(task);
    const placement = this.core.options.tasks.get(task.id)?.placement;
    if (placement)
      this.core.options.tasks.placement.releasePlacement(
        task.id,
        placement.snapshot.orderId,
        "ended",
      );
    // A turn the app stopped for its computer's update ends as a pause
    // (`pauseForUpdate`): whatever cut it there is the update, never the
    // provider, so it fails nothing and wakes nobody.
    const paused = task.turn.takePause();
    // Another computer's update cut the turn there, or this one's own
    // stopped it before its model took it: its words go again. A turn this
    // computer's own update stopped safely kept what it read.
    const cutByUpdate =
      paused !== undefined &&
      (paused.computer !== undefined
        ? task.lastTurnError !== undefined
        : paused.unstarted === true);
    const providerError = paused ? undefined : task.lastTurnError;
    let cutOff = paused ? undefined : task.lastTurnCutOff;
    // A turn the model's context limit failed is no outage: the same
    // conversation fails the same way however long the retry waits, and
    // every retry appends its rows to it again. The first one continues in
    // one fresh conversation, as the first mate's does; a second one, in
    // that fresh conversation, is the first mate's to act on.
    const overflowed = providerError !== undefined && task.lastTurnContextOverflow === true;
    task.lastTurnError = undefined;
    task.lastTurnCutOff = undefined;
    task.lastTurnContextOverflow = undefined;
    const recoverContext = overflowed && !task.contextRecovered;
    if (!providerError && !paused) task.contextRecovered = undefined;
    // A cut-off is a fact about the account, not only this turn: it stands
    // there until a fact changes (docs/quota.md "Typed cut-offs"). A turn on
    // another computer met it on that computer's own sign-in, which records
    // it there (docs/helper.md, "Its own sign-ins"): never on this Mac's
    // account, whose Firstmate and crew keep serving.
    if (cutOff && task.accountId && this.core.facts.machineOf(task.id) === LOCAL_MACHINE_ID)
      this.core.options.noteCutOff?.(task.accountId, cutOff);
    // A spent allowance that named no reset (xAI's 402) was held against the
    // sign-in's own reading when it was recorded: the retry waits for that.
    if (cutOff?.class === "no_headroom" && cutOff.resetsAt === undefined && task.accountId) {
      const standing = this.core.facts.serveability()?.cutOff(task.accountId);
      if (standing?.class === "no_headroom" && standing.resetsAt !== undefined) {
        cutOff = { ...cutOff, resetsAt: standing.resetsAt };
      }
    }
    const { text: finalText, headline } = closingWords(this.core.options.tasks.get(task.id), task);
    // A paused turn's last words are where it stopped, never its report.
    const candidate = providerError
      ? undefined
      : paused
        ? task.explicitReport
        : (task.explicitReport ?? finalText);
    // The tool's own headline belongs to the tool's report, never to a
    // final text that stood in for it.
    const candidateSummary = task.explicitReport !== undefined ? task.explicitSummary : headline;
    // A report the provider-failed turn made before it failed is already on
    // the record (`holdReport`): its wake names it (INF-3165).
    const keptReport =
      providerError && task.explicitReport !== undefined
        ? reportSummary(candidateSummary || task.explicitReport)
        : undefined;
    const declared = task.explicitReport !== undefined ? task.explicitDeclared : undefined;
    const closingText = task.explicitReport === undefined;
    const turnReview = task.turnReview;
    task.turnReport = undefined;
    task.explicitReport = undefined;
    task.explicitSummary = undefined;
    task.explicitDeclared = undefined;
    task.turnReview = undefined;
    task.currentTurnText = "";
    const filed = task.filedThisTurn;
    task.filedThisTurn = [];
    const withdrawn = task.withdrawnThisTurn;
    task.withdrawnThisTurn = [];
    const relayed = task.relayWoken;
    task.relayWoken = undefined;
    const implausible =
      candidate && !options.interrupted ? implausibleReport(candidate) : undefined;
    const turnError =
      providerError ??
      (implausible ? `its report was set aside because ${implausible}` : undefined);
    const report = turnError ? undefined : candidate;
    // Ack after handling: the rows this turn consumed are deleted when it
    // ended clean - an interrupt counts, it is a deliberate captain act and
    // the content already reached the transcript, and so does a turn whose
    // report was implausible - and released for a retry only when the
    // provider failed the turn. That release is the honest retry (the
    // captain's Q1, docs/inbox.md): a provider failure spends no attempt
    // and backs off, forever, so the guidance is delivered on the first
    // attempt after the provider answers. A sign-in failure is the
    // captain's to fix, so it spends the ladder as any refusal does. Every
    // other cut-off class keeps the provider-failure path for now.
    const signInFailure =
      providerError !== undefined &&
      isSignInFailure(task.session?.controlProfile, providerError, cutOff);
    const outage = this.core.options.inbox.outage(task.id);
    const unread = new Set(this.undeliveredSteerRows(task));
    const inFlight = task.turn.takeRows();
    const consumed = inFlight.filter((id) => !unread.has(id));
    // The same provider refusal three times in a row makes the lane stuck
    // at its provider (docs/inbox.md, "Stuck at its provider"): only a plain
    // provider failure counts, never a sign-in, a cut-off or a full
    // conversation, each of which has its own way back.
    let released: { failures: number; refusals: number } | undefined;
    if (inFlight.length > 0) {
      if (recoverContext) {
        // Its words never reached a conversation that goes on: they go
        // again, due now, as the fresh conversation's first turn - all but
        // the brief, which the restart's own words already serve whole.
        const brief = this.servedBrief(task.id);
        const told = inFlight.filter((id) => {
          const row = this.core.options.inbox.get(id);
          return brief !== undefined && row?.facts === undefined && row?.text === brief;
        });
        this.core.options.inbox.ack(told);
        this.core.options.inbox.reparkUndelivered(inFlight.filter((id) => !told.includes(id)));
      } else if (overflowed) {
        // They are in the conversation that overflowed, and sending them
        // into it again only fails again: the first mate hears below.
        this.core.options.inbox.ack(inFlight);
      } else if (providerError && !signInFailure) {
        // A spent allowance is not asked again before its reset.
        released = this.core.options.inbox.releaseAfterProviderFailure(
          inFlight,
          cutOff?.class === "no_headroom" && cutOff.resetsAt !== undefined
            ? { notBefore: cutOff.resetsAt }
            : cutOff
              ? {}
              : isProviderRefusal(providerError)
                ? { refusal: refusalWords(providerError) }
                : {},
        );
      } else if (providerError) {
        this.core.options.inbox.release(inFlight);
      } else if (cutByUpdate) {
        // Cut before it ended there: its words go again, due once its
        // computer is back, with no attempt spent.
        this.core.options.inbox.reparkUndelivered(inFlight);
      } else {
        // A steer no turn took in never reached the transcript: its rows
        // go back on the lane, due now, and the delivery below serves them
        // as the next turn - the Firstmate's own rule for its steers
        // (`redeliverUndeliveredSteers`).
        // Acknowledge below, together with any missing-response obligation,
        // after the turn's report has its durable reference.
        this.core.options.inbox.reparkUndelivered(inFlight.filter((id) => unread.has(id)));
      }
    }
    // The first provider failure of an outage wakes the Firstmate; the rest
    // are the retry's, and each is still its own line on the task's
    // timeline. A failed turn that carried no guidance has no retry, so it
    // is reported as it always was.
    const retrying =
      providerError !== undefined && !signInFailure && !overflowed && inFlight.length > 0;
    const firstFailure = !retrying || outage.failures === 0;
    const stuck =
      retrying && !cutOff && released !== undefined && released.refusals >= STUCK_REFUSAL_LIMIT;
    if (stuck) this.core.options.inbox.holdStuck(task.id);
    // The outage as it stands after this failure, for the feed line.
    const retry =
      retrying && released && !cutOff
        ? {
            failures: released.failures,
            since: this.core.options.inbox.outage(task.id).since ?? this.core.now(),
            ...(stuck ? { stuck: true as const } : {}),
          }
        : undefined;
    if (!providerError && !paused && outage.failures > 0)
      this.core.ladder.endOutage(task, outage.failures, outage.since);
    // A refusal is told once per account and words (docs/inbox.md, "The
    // same refusal on one account"); a turn that went through ends that.
    const account = this.core.ladder.accountOf(task.id);
    if (account && !providerError && !paused) this.accountRefusals.answered(account);
    const refusal =
      account &&
      providerError !== undefined &&
      !signInFailure &&
      !cutOff &&
      !overflowed &&
      isProviderRefusal(providerError)
        ? this.accountRefusals.tell(account, refusalWords(providerError), task.id)
        : undefined;
    const sameAccount =
      account && refusal?.first
        ? this.core.ladder.tasksOnAccount(account).filter((other) => other.id !== task.id)
        : undefined;
    // Another task on the account already woke the first mate in these words.
    const toldForAccount = refusal !== undefined && !refusal.first;
    // A lane stuck in those words is not told either: that task's wake named it.
    const stuckToldElsewhere = toldForAccount && refusal.teller !== task.id;
    // A paused turn that reported needs no carrying on: its report stands.
    // Nor does one its model never took: its own rows carry it.
    if (paused?.row !== undefined && (report || paused.unstarted))
      this.core.options.inbox.withdraw([paused.row]);
    const move = task.turn.rest();
    this.turnOver(task.id);
    if (report) task.lastCompleteText = report;
    // The record carries the report (task-system P0): crew_status reads the
    // outcome column after a restart, when no runtime remembers it.
    let reportEventId: number | undefined;
    if (turnError) {
      // A typed backend's provider failure keeps its class for the record,
      // so the feed line reads the class, never the words.
      let typed: TypedFailure | undefined;
      // A lost sign-in on Claude access set up for Claude Code says so, so
      // its line asks to renew it there, never to sign in here.
      const access = cutOff?.class === "signed_out" ? this.localAccess(task) : undefined;
      if (providerError !== undefined && task.session?.controlProfile.failureSignals === "typed") {
        typed = cutOff ? { cutOff, ...(access ? { access } : {}) } : {};
      } else if (providerError !== undefined && cutOff) {
        // A prose backend's failure with a typed class (xAI's 402) keeps the
        // class too, so the feed line reads the class and not the words.
        typed = { cutOff };
      }
      this.core.options.tasks.turns.recordTurnFailure(task.id, turnError, typed, retry);
    } else if (report) {
      reportEventId = this.core.options.tasks.turns.recordReport(task.id, {
        text: report,
        ...(candidateSummary ? { summary: candidateSummary } : {}),
        ...(declared ? { declared } : {}),
        // The relay's ask stands from when it woke the first mate, so an
        // act of the first mate's before this turn ended answers it.
        ...(relayed && declared?.needsFirstmate === relayed.request ? { askedAt: relayed.at } : {}),
      });
      // A declared wait places the captain gate before the sort reads it.
      if (declared?.wait) this.core.ladder.syncCaptainGate(task.id, this.core.now());
    }
    if (!providerError && !cutByUpdate && consumed.length) {
      const missing = this.core.options.inbox.transaction(() => {
        // The ordered remote event lane supplies the same completed-turn
        // boundary. An interrupted, paused or failed turn proves no miss.
        const ids =
          !turnError && !options.interrupted && !paused
            ? this.core.options.inbox.noteMissingResponses(task.id, consumed, {
                id: `${task.id}:${task.turnStartedAt}:${consumed.join(",")}`,
                since: task.turnStartedAt,
                session: task.session?.recordPath(),
                reportEventId,
                ...(report ? { report } : {}),
              })
            : [];
        this.core.options.inbox.ack(consumed);
        return ids;
      });
      if (missing.length) this.core.hooks().pokeInbox?.();
    }
    this.core.options.tasks.turns.setActivity(task.id, "idle");
    this.turnEnded(task.id);
    this.core.options.tasks.turns.markIdle(task.id, {
      providerFailed: providerError !== undefined,
    });
    // Going idle is the crewmate's close-out: a card the captain already had
    // comes back or redraws with its last write, and a new card no report
    // released reaches the stage.
    this.core.cards.closeOut({ kind: "crewmate", taskId: task.id }, "idle");
    if (report) {
      const summary = candidateSummary || reportSummary(report);
      this.core.options.broadcastEvent({
        type: "task_report",
        taskId: task.id,
        title: task.title,
        crewmate: task.crewmate,
        ...(summary ? { summary } : {}),
      });
    }
    this.core.facts.broadcastCrewCounts();
    // A backend that mints its conversation id when the first turn starts
    // only becomes resumable here. Re-reading the token every turn
    // is a no-op for backends whose token was known at creation - and a
    // missing token never erases a good one.
    if (task.session)
      this.core.sessions.recordCrewSession(task, task.session, task.conversationBegan ?? "resume");
    // The personal workspace (Step 4): a report is the turn's commit. The
    // host commits the workspace with the report as the message and, once
    // the commit lands, routes the report like any other (INF-1677): its
    // completion is the ordinary one, which the first mate closes as
    // finished. A commit that fails keeps the task open and tells the
    // Firstmate instead (`commitFailed`), so it never reads as finished.
    const personal = this.core.options.personal;
    // Ongoing work commits every personal turn without waking the first mate
    // for routine progress. Coordination and completion route normally.
    if (
      !turnError &&
      !options.interrupted &&
      personal &&
      this.core.facts.isPersonalTask(task.id) &&
      this.core.options.tasks.get(task.id)?.shape?.ongoing === true &&
      !declared?.needsFirstmate &&
      declared?.finished !== true
    ) {
      void this.commitLiveTurn(task, report || "ongoing work turn", personal);
      return;
    }
    const saved =
      report &&
      !turnError &&
      !options.interrupted &&
      personal &&
      this.core.facts.isPersonalTask(task.id)
        ? this.commitLiveTurn(task, report, personal)
        : undefined;
    if (turnError) {
      // A provider-failed turn: the session lives and stays steerable, but
      // the failure is never reported as an empty report. The feed line
      // already rode the turn_failed broadcast. Auth is captain territory
      // by definition (deterministic classification, sign-in card) and
      // stays on the firstmate lane; other failures are triageable.
      const error = capWithOverflow(turnError, "turn-error");
      // A cut-off standing on the account is the account's to tell: the
      // Firstmate hears it once for all the crewmates it pauses, never once
      // per failed turn (the cut-off contract).
      if (cutOff) this.core.ladder.checkCutOffs();
      const accountTells =
        cutOff !== undefined &&
        this.core.ladder.cutOffHolds({
          id: task.id,
          accountId: task.accountId ?? null,
          deviceId: this.core.options.tasks.get(task.id)?.deviceId ?? null,
        });
      const failedOp: TypedWake = retrying
        ? outageFailedWake(task, error, keptReport, sameAccount)
        : {
            facts: {
              kind: "turn-failed",
              task: { id: task.id, title: task.title },
              crewmate: task.crewmate,
              error,
              ...(keptReport ? { keptReport } : {}),
              ...(sameAccount ? { sameAccount } : {}),
            },
          };
      if (signInFailure) {
        if (!accountTells) this.core.hooks().notifyOp(failedOp, "agent", task.id);
        // Auth-required is never silent (docs/architecture.md section 6): a
        // decision card offers the way back to a signed-in provider. Its
        // head reads the task's key and title, never the crewmate counter a
        // restart renumbers.
        // Its default moves the task to the app's pick when another
        // provider serves (INF-849); Open settings stays beside it.
        void this.presentSignInCard(task);
      } else if (recoverContext) {
        // The fresh conversation carries the task on: a feed line, no wake.
        this.core.options.broadcastEvent({
          type: "firstmate_note",
          text: `Task ${task.title} reached its conversation limit and continues with its brief in a new conversation.`,
          taskId: task.id,
        });
      } else if (stuck && !accountTells && !stuckToldElsewhere) {
        // Stuck at its provider: the first mate is told once, with the ways
        // that can work, instead of the outage's own wakes.
        void this.tellStuck(task, error, retry?.since ?? this.core.now(), released?.refusals ?? 0);
      } else if (firstFailure && !accountTells && !toldForAccount) {
        this.core.routeCrewEvent(task.id, failedOp, "agent");
      }
    } else if (options.interrupted) {
      // The Firstmate asked for this interrupt (interrupt_crewmate is its
      // tool) and the tool already said it happened: the receipt is a feed
      // line, never a wake (Q4a).
      this.core.options.broadcastEvent({
        type: "firstmate_note",
        text: `Task ${task.title} interrupted: it can still be told what to do`,
      });
    } else if (paused?.cost && !report) {
      // Its cost limit stopped it: the hold's card already asks the
      // captain, and the lane carries it on once they answer.
    } else if (paused?.notOpen && !report) {
      // Its conversation did not open there again: the let-go or the wait
      // for a model says why, and no update is announced for it.
    } else if (paused && !report) {
      // Nobody has anything to act on: the lane carries it on once the
      // computer is back, and the feed says so once.
      this.core.options.broadcastEvent({
        type: "firstmate_note",
        text: updatePauseLine(task.title, paused.computer, paused.behind),
      });
    } else if (report && isRepairAssessment(this.core.options.tasks.get(task.id)?.shape)) {
      // An independent repair assessment's one report decides the kept
      // merge's undecided repair (FI3-663).
      void this.core.reviews.settleRepairAssessment(task, report);
    } else if (report && this.core.options.tasks.get(task.id)?.shape?.kind === "review") {
      // A reviewer's report settles its review (INF-1875): the typed review
      // record the turn reported is the verdict, recorded on the builder,
      // and a pass closes the review.
      void this.core.reviews.settleReview(task, report, turnReview);
    } else if (report && saved) {
      void saved.then((committed) => {
        const record = this.core.options.tasks.get(task.id);
        if (committed && record && !TaskService.isClosed(record))
          this.sorting.sortReport(
            task,
            report,
            { filed, withdrawn, relayed, closingText },
            declared,
          );
      });
    } else if (report) {
      this.sorting.sortReport(task, report, { filed, withdrawn, relayed, closingText }, declared);
    }
    if (!turnError && !options.interrupted && !paused) this.askForCheckBack(task, declared);
    this.afterTurn(task, move, recoverContext);
  }

  /**
   * The turn is over, wherever it goes idle: a build whose browser stopped
   * during it stops now (docs/task-browser.md, "Starting a page again").
   */
  private turnEnded(taskId: string): void {
    this.core.options.browsers?.turn?.(taskId, false);
  }

  /** Every idle boundary hands off its deferred work through this one exit. */
  private afterTurn(task: TaskRuntime, move?: MoveAsk, recoverContext = false): void {
    // A captured settle owns this idle boundary: the one waiting goes on now,
    // and no other queued guidance turn starts before its close/CI gates run.
    const settleWaited = this.core.settling.locks.turnEnded(task.id);
    if (settleWaited || this.core.options.tasks.get(task.id)?.pendingSettle) {
      // The settle's own outcome speaks for this boundary.
    } else if (recoverContext) {
      void this.recoverContext(task);
    } else if (move) {
      // A move asked for mid-turn runs at this boundary, and delivers what
      // waits once the task reopens on its new provider (INF-849).
      void this.core.moves.runMove(task.id, move);
    } else if (this.core.options.tasks.get(task.id)?.shape?.computer_move?.phase === "waiting") {
      // The safe pause a move to another computer waited for.
      void this.core.moves.runComputerMove(task.id);
    } else {
      this.deliverPendingToTask(task, { announce: true });
    }
    // What a move continues from if that computer goes out of reach later
    // (docs/helper.md, "Moving a task off a computer that is out of reach").
    if (this.core.facts.machineOf(task.id) !== LOCAL_MACHINE_ID)
      void Promise.resolve()
        .then(() => this.core.options.machines?.bringBranchHome(task.id))
        .catch(() => undefined);
    // Every idle boundary runs the one reconciler the tick runs.
    this.core.ladder.reconcileIdleTask(task.id, this.core.now());
    // The captain's kept merge approval runs once the crewmate's turn is
    // over; a no-op when none stands (FI3-304).
    void this.core.settling.kept.runMergeAuthorization(task.id).catch((caught: unknown) => {
      console.warn("[crew] kept merge could not run:", caught);
    });
  }

  /**
   * The task's Claude access set up for Claude Code, when it runs here. Only
   * this Mac's access is known here: a task on another computer ran on that
   * computer's own sign-in (docs/helper.md, "Its own sign-ins").
   */
  private localAccess(task: TaskRuntime): ClaudeAccessSource | undefined {
    const local = this.core.facts.machineOf(task.id) === LOCAL_MACHINE_ID;
    return task.accountId && local
      ? this.core.options.accounts?.accessOf?.(task.accountId)
      : undefined;
  }

  /**
   * A task stuck at its provider (docs/inbox.md, "Stuck at its provider"):
   * the first mate hears it once, with the refusal, how many times and
   * since when, and only the ways that can work - another model is named
   * only when the app has one to move it to.
   */
  private async tellStuck(
    task: TaskRuntime,
    error: string,
    since: number,
    refusals: number,
  ): Promise<void> {
    let moveTo: string | undefined;
    let provider: string | undefined;
    try {
      const plan = await this.core.moves.planMove(task.id);
      if (!("refused" in plan) && plan.from) {
        moveTo = this.modelName(plan.choice);
        provider = this.core.moves.providerLabel(plan.from);
      }
    } catch (caught) {
      console.warn("[crew] another model could not be evaluated:", caught);
    }
    const record = this.core.options.tasks.get(task.id);
    if (!record || TaskService.isClosed(record) || !this.core.options.inbox.stuck(task.id)) return;
    this.core.routeCrewEvent(
      task.id,
      stuckWake(
        { id: task.id, title: task.title, key: record.key || task.id, crewmate: task.crewmate },
        {
          error,
          since,
          refusals,
          ...(moveTo ? { moveTo } : {}),
          ...(provider ? { provider } : {}),
        },
      ),
      "agent",
    );
  }

  /**
   * The first mate's answer to a task stuck at its provider (update_task
   * unstick): `restart` lets the conversation go and opens a fresh one told
   * why, which serves its brief and the kept guidance; `move` moves it to
   * the app's pick off the provider that refused it. A task that is not
   * stuck is refused as text and nothing changes.
   */
  async unstick(taskId: string, how: "restart" | "move"): Promise<{ ok: boolean; text: string }> {
    const record = this.core.options.tasks.get(taskId);
    if (!record) return { ok: false, text: `Unknown task "${taskId}".` };
    const handle = `${record.key || record.id} "${record.title}"`;
    if (!this.core.options.inbox.stuck(taskId))
      return { ok: false, text: `${handle} is not stuck at its provider, so nothing changed.` };
    if (how === "move") {
      const moved = await this.core.moves.requestMove(taskId, { by: "firstmate" });
      return moved;
    }
    const task = this.core.tasks.get(taskId);
    if (task?.turn.busy)
      return { ok: false, text: `${handle} is in a turn now, so nothing changed.` };
    const from = record.sessionFile;
    if (!from)
      return {
        ok: false,
        text: `${handle} has no earlier conversation on its record to restart from.`,
      };
    this.core.options.inbox.unstick(taskId);
    this.core.options.tasks.note(
      taskId,
      "the first mate restarted it in a new conversation, because the provider kept refusing its requests the same way; the earlier one is kept",
      { news: false },
    );
    if (task) {
      this.core.sessions.releaseSession(task);
      this.core.tasks.delete(taskId);
    }
    try {
      const resumed = await this.core.sessions.resumeTask(taskId, undefined, {
        from,
        changed: "refused",
      });
      this.deliverPendingToTask(resumed);
      return {
        ok: true,
        text: `${handle} continues in a new conversation with its brief and kept guidance.`,
      };
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      // The restart stays on its lane and opens once a model can take it.
      if (caught instanceof ModelWaitError)
        return {
          ok: true,
          // i18n-exempt: a tool answer served to the agent, not shown to a person
          text: `${handle} opens its new conversation once a model can take it: ${message}`,
        };
      // One that opened but was not accepted stays on the lane, and the
      // lane's next pass opens it fresh again.
      if (caught instanceof NotAcceptedError && !(caught instanceof OpenedNothingError))
        return {
          ok: true,
          // i18n-exempt: a tool answer served to the agent, not shown to a person
          text: `${handle} opens its new conversation on its next try: ${message}`,
        };
      this.core.options.tasks.note(taskId, `its new conversation could not open: ${message}`, {
        news: true,
      });
      return { ok: false, text: `${handle}'s new conversation could not open: ${message}` };
    }
  }

  private async presentSignInCard(task: TaskRuntime): Promise<void> {
    let move: { arg: string; modelName: string } | undefined;
    try {
      const plan = await this.core.moves.planMove(task.id);
      if (!("refused" in plan) && plan.from)
        move = {
          arg: `${task.id}:${plan.from}:${offeringKey(plan.choice)}`,
          modelName: this.modelName(plan.choice),
        };
    } catch (error) {
      console.warn("[crew] another model could not be evaluated:", error);
    }
    const record = this.core.options.tasks.get(task.id);
    if (!record || TaskService.isClosed(record) || this.core.tasks.get(task.id) !== task) return;
    const access = this.localAccess(task);
    this.core.cards.hostCards.addAuthDecisionCard(
      crewSignInCardId(task.id),
      task.title,
      this.signInCardBody(task),
      { taskId: task.id, ...(move ? { move } : {}), ...(access ? { access } : {}) },
    );
  }

  /**
   * A turn ended with a background job still running and no check-back
   * named (INF-1244): the crewmate is asked once, per job, when it will
   * look at the job again, so a job that stalls silently is read within
   * the time it names rather than at the job's bound. A turn that hands
   * the task to the captain or ends it asks nothing.
   */
  private askForCheckBack(task: TaskRuntime, declared: ReportDeclaration | undefined): void {
    if (declared?.checkBack || declared?.wait || declared?.finished) return;
    if (this.core.bypassesSupervision(task.id)) return;
    const running =
      this.core.options.hasRunningJobs?.(task.id) === true ||
      this.core.starts.clientJobStart(task.id) !== undefined;
    const job = running ? this.core.starts.oldestJob(task.id) : undefined;
    if (!job || this.core.options.inbox.woken(task.id, checkBackAskOnce(job))) return;
    const ask = checkBackAsk(
      { ...job, command: capWithOverflow(job.command, "check-back-command") },
      this.core.now(),
      JOB_BOUND_MS,
    );
    void this.core.steer.steerInternal(task.id, ask, SUPERVISOR_STEER).catch((caught: unknown) => {
      console.warn("[crew] the check-back ask was not delivered:", caught);
    });
  }

  recordSort(...args: Parameters<ReportSorting["recordSort"]>): void {
    this.sorting.recordSort(...args);
  }

  private servedBrief(taskId: string): string | undefined {
    const briefed = this.core.options.tasks
      .timeline(taskId)
      .filter((event) => event.kind === "briefed")
      .at(-1);
    return briefed ? this.core.options.tasks.servedBrief(briefed) : undefined;
  }

  /**
   * A turn the model's context limit failed, in a conversation that is not
   * already the recovery: the crewmate lets that conversation go and opens
   * a fresh one through the restart path, which tells it why and serves its
   * brief and where the earlier transcript is kept; the rows the failed
   * turn held go again as its first turn. The earlier conversation's file
   * stays. A reopen that fails is a note on the task, and the first mate
   * hears it as the failed turn it is.
   */
  private async recoverContext(task: TaskRuntime): Promise<void> {
    if (this.core.tasks.get(task.id) !== task) return;
    const from = this.core.options.tasks.get(task.id)?.sessionFile;
    this.core.options.tasks.note(
      task.id,
      "its conversation reached the model's context limit, so it continues in a new one; the earlier one is kept",
      { news: false },
    );
    this.core.sessions.releaseSession(task);
    this.core.tasks.delete(task.id);
    try {
      if (!from) throw new Error("its earlier conversation is not on its record");
      const resumed = await this.core.sessions.resumeTask(task.id, undefined, {
        from,
        changed: "context",
      });
      resumed.contextRecovered = true;
      // The failed turn held only the brief, which the restart serves: the
      // new conversation still takes its turn, on the restart's words.
      if (this.core.facts.deliverableRows(task.id, this.core.now()).length > 0)
        this.deliverPendingToTask(resumed);
      else if (!resumed.turn.busy && !resumed.turn.closing)
        void this.runTurn(resumed, CONTEXT_CONTINUE_TEXT);
    } catch (caught) {
      // The restart stays on its lane, said once, and opens fresh once a
      // model can take it, or on the lane's next pass when the one that
      // opened was not accepted (`CrewSessions.waitingRestart`).
      if (
        caught instanceof ModelWaitError ||
        (caught instanceof NotAcceptedError && !(caught instanceof OpenedNothingError))
      )
        return;
      const message = caught instanceof Error ? caught.message : String(caught);
      this.core.options.tasks.note(task.id, `its new conversation could not open: ${message}`, {
        news: true,
      });
      this.core.routeCrewEvent(
        task.id,
        {
          facts: {
            kind: "turn-failed",
            task: { id: task.id, title: task.title },
            crewmate: task.crewmate,
            error: capWithOverflow(
              `its conversation reached the model's context limit, and a new one could not open: ${message}`,
              "turn-error",
            ),
          },
        },
        "agent",
      );
    }
  }

  /**
   * The end of a live crewmate turn (Step 4): stamp, lint and commit. The
   * commit and the lint land on the task's timeline (never the feed). It
   * answers whether the turn's work is saved, so only a saved report routes;
   * a commit that fails tells the Firstmate instead (`commitFailed`).
   */
  private async commitLiveTurn(
    task: TaskRuntime,
    report: string,
    personal: PersonalLiveDelegate,
  ): Promise<boolean> {
    try {
      const commit = await personal.commitTurn(task.id, report);
      if (!this.core.options.tasks.get(task.id)) return false;
      if (commit.committed && commit.sha) {
        this.core.options.tasks.note(
          task.id,
          `committed ${commit.sha.slice(0, 7)} in the personal workspace${
            commit.touched.length > 0 ? ` (${commit.touched.join(", ")})` : ""
          }`,
          { news: true, data: { commit: commit.sha, touched: commit.touched } },
        );
      }
      if (commit.findings.length > 0) {
        const summary = commit.findings
          .slice(0, 8)
          .map((finding) => `${finding.severity} ${finding.file}:${finding.line} ${finding.rule}`)
          .join("; ");
        this.core.options.tasks.note(
          task.id,
          `lint at commit: ${commit.findings.length} finding${commit.findings.length === 1 ? "" : "s"} - ${summary}`,
          { news: false, data: { findings: commit.findings } },
        );
      }
    } catch (caught) {
      this.commitFailed(task, caught);
      return false;
    }
    return true;
  }

  /**
   * A turn's commit failed (FI3-1218): what the crewmate changed is saved in
   * the workspace but not committed, so the task stays open - never done
   * and "built in place". Git's words go on the timeline (its whole error in
   * the note's data) and to the Firstmate, whose steer starts the crewmate's
   * next turn; that turn's report commits again. The idle ladder watches
   * the open task as any other.
   */
  private commitFailed(task: TaskRuntime, caught: unknown): void {
    const record = this.core.options.tasks.get(task.id);
    if (!record) return;
    const reason = gitFailure(caught);
    this.core.options.tasks.note(
      task.id,
      `could not commit the personal workspace, so its changes are saved there uncommitted: ${reason}`,
      {
        news: true,
        data: { commitFailed: caught instanceof Error ? caught.message : String(caught) },
      },
    );
    if (TaskService.isClosed(record)) return;
    this.core.routeCrewEvent(
      task.id,
      {
        facts: {
          kind: "commit-failed",
          task: { id: task.id, title: task.title },
          crewmate: task.crewmate,
          error: reason,
        },
      },
      "agent",
    );
  }

  /**
   * Deliver the task lane's due rows as the crewmate's next turn: the
   * followup-queue fallback (guidance a backend could not take mid-turn),
   * failed steers past their grace, and job results alike. With announce,
   * when the rows carry guidance someone sent, the feed says so rather than
   * letting the guidance arrive as if the crewmate had thought of it - one
   * quiet feed line, never a Firstmate wake (interaction P0, WI-5): the
   * Firstmate queued that guidance itself and has nothing to act on. The
   * line is a row on the task that the feed shows once per task, the
   * newest (`QUEUED_GUIDANCE_FOLD`, INF-1137). Rows are marked in-flight
   * here and acknowledged at the turn's end (runTurn -> turnComplete).
   * True when the lane went out as a turn, or a login move took it.
   */
  deliverPendingToTask(
    task: TaskRuntime,
    options: { announce?: boolean; sent?: boolean } = {},
  ): boolean {
    // A runtime let go as its turn ended takes no more turns.
    if (this.core.tasks.get(task.id) !== task) return false;
    if (task.turn.closing || !task.session || task.turn.busy) return false;
    if (task.turn.stage === "stopped" && !options.sent) return false;
    if (this.core.facts.laneHeld(task.id)) return false;
    // A started task in the backlog (INF-2062) takes a turn only for words
    // the captain or the first mate sent, told it stays there.
    const backlog = this.core.facts.inBacklog(task.id);
    if (backlog && !options.sent) return false;
    // A task bound to another login moves there first (`LoginMoves`), due
    // rows or none: what its old login's run-out held is due on the new one.
    if (
      this.core.loginMoves.takes(
        task.id,
        (open) => this.deliverPendingToTask(open, options),
        options.sent,
      )
    )
      return true;
    const rows = this.core.facts.deliverableRows(task.id, this.core.now());
    if (rows.length === 0) return false;
    const pictures = this.core.facts.rowPictures(task.id, rows);
    if (pictures.blocked) return false;
    if (options.announce && rows.some((row) => !OWN_LANE_KINDS.has(row.facts?.kind ?? ""))) {
      this.core.options.tasks.note(task.id, QUEUED_GUIDANCE_LINE, {
        news: false,
        feed: true,
        data: { feedLine: true, feedOnce: QUEUED_GUIDANCE_FOLD },
      });
    }
    const ids = this.deliverRows(task.id, rows);
    const text = laneTurnText(rows);
    void this.runTurn(
      task,
      backlog ? `${BACKLOG_STEER_LINE}\n\n${text}` : text,
      ids,
      pictures.images,
    );
    return true;
  }

  /**
   * Lane rows go out: marked in flight, and when one is a sent row going
   * out for the first time the crewmate's center spark flies now, as it
   * reaches it (INF-759). The crewmate's own rows - a job's result, a
   * renewed conversation's reason - were sent by nobody and draw nothing;
   * a row delivered again already drew its spark.
   */
  deliverRows(taskId: string, rows: readonly InboxRow[]): number[] {
    const ids = rows.map((row) => row.id);
    const sent = rows.some(
      (row) => row.lastAttemptAt === null && !OWN_LANE_KINDS.has(row.facts?.kind ?? ""),
    );
    this.core.options.inbox.markDelivered(ids);
    if (sent) this.core.steer.announceReach(taskId);
    return ids;
  }

  /** A model by its Settings name, as the sign-in card's Move names it. */
  modelName(model: { provider: string; id: string }): string {
    return this.core.options.modelName?.(model) ?? model.id;
  }

  /**
   * The model answering for a crewmate, kept on its task's record whenever
   * the record names another (FI3-967): the record, and so the fact strip
   * and the crew's labels, name the model doing the work, and the timeline
   * and the feed say what moved it - the backend's own fallback, or a
   * reattach that asked for the routed model again. The routing ledger keeps
   * the router's decision as it was made. A record that named no model
   * learns it without a line: nothing moved.
   */
  recordServedModel(
    task: TaskRuntime,
    event: Extract<SessionEvent, { type: "model_served" }>,
  ): void {
    const record = this.core.options.tasks.get(task.id);
    if (!record || TaskService.isClosed(record)) return;
    const served = `${event.model.provider}/${event.model.id}`;
    if (record.model === served) return;
    this.noticeUnaskedModel(task, record, event);
    if (!record.model) {
      this.core.options.tasks.starts.recordServedModel(task.id, event.model);
      return;
    }
    const name = (ref: { provider: string; id: string }) =>
      this.core.options.router?.modelLabel(ref) ?? ref.id;
    const slash = record.model.indexOf("/");
    const was =
      slash > 0
        ? { provider: record.model.slice(0, slash), id: record.model.slice(slash + 1) }
        : undefined;
    const fallback = event.fallback;
    const from = fallback?.from ?? was;
    this.core.options.tasks.starts.recordServedModel(task.id, event.model, {
      text: modelMoveWords({
        from: from ? name(from) : record.model,
        to: name(event.model),
        fallback: fallback !== undefined,
      }),
      data: {
        servedModel: served,
        from: record.model,
        ...(fallback
          ? {
              fallback: {
                from: `${fallback.from.provider}/${fallback.from.id}`,
                ...(fallback.category ? { category: fallback.category } : {}),
              },
            }
          : {}),
      },
    });
  }

  /**
   * The first mate is told once when a task answers on a model its routing
   * did not choose (INF-1272): both models, why, and whether the captain
   * named the one asked for, so it can tell them. An answer back on the
   * asked model, or on a task that never routed, says nothing.
   */
  private noticeUnaskedModel(
    task: TaskRuntime,
    record: TaskRecord,
    event: Extract<SessionEvent, { type: "model_served" }>,
  ): void {
    const asked = this.core.options.router?.servedChoice(task.id)?.model;
    if (!asked || offeringKey(asked) === offeringKey(event.model)) return;
    const named = record.shape?.override_model_id;
    const category = event.fallback?.category;
    this.core.hooks().notifyOp(
      {
        facts: {
          kind: "model-unasked",
          task: { id: record.id, key: record.key || record.id, title: record.title },
          asked: this.modelName(asked),
          served: this.modelName(event.model),
          cause: event.fallback ? "fallback" : "client",
          ...(category ? { category } : {}),
          named:
            named !== undefined &&
            (named.includes("/") ? named === offeringKey(asked) : named === asked.id),
        },
        once: `model-unasked:${offeringKey(asked)}:${offeringKey(event.model)}`,
      },
      "agent",
      record.id,
    );
  }

  recordUsage(
    task: TaskRuntime,
    usage: NonNullable<Extract<FmEvent, { type: "turn_end" }>["usage"]>,
  ): void {
    const model = task.session?.modelRef();
    const accountId = this.servingAccount(task);
    this.core.options.recordUsage?.({
      taskId: task.id,
      ...(accountId ? { accountId } : {}),
      ...(model ? { model } : {}),
      usage,
    });
    // Each recorded response is where a task meets its cost limit.
    this.core.costLimits.recorded(task.id);
  }

  /**
   * The account a task's turns are served by: the account picked here for a
   * task on this Mac, and for a task on another computer that computer's
   * own, as it said - never the account this Mac picked for it
   * (docs/helper.md, "Its own sign-ins").
   */
  private servingAccount(task: TaskRuntime): string | undefined {
    if (this.core.facts.machineOf(task.id) === LOCAL_MACHINE_ID) return task.accountId;
    return task.session ? this.core.options.machines?.servingAccount(task.session) : undefined;
  }

  /** A turn began or ended: nothing it had open, or was handed, waits any more. */
  private clearWait(task: TaskRuntime): void {
    task.openCalls.clear();
    task.unreadSteers = [];
    task.steersAtCheck = undefined;
    task.waitNamed = undefined;
    task.readsAnsweredAt = undefined;
  }

  /**
   * Runs `then` as the task's running turn here ends, before anything
   * waiting starts the next one (`turnOver`); at once when none runs.
   */
  atTurnOver(task: TaskRuntime, then: () => void): void {
    if (this.core.tasks.get(task.id) !== task || !task.turn.busy) {
      then();
      return;
    }
    const waiters = this.turnWaiters.get(task.id) ?? new Set<() => void>();
    waiters.add(then);
    this.turnWaiters.set(task.id, waiters);
  }

  untilTurnOver(task: TaskRuntime): Promise<void> {
    if (this.core.tasks.get(task.id) !== task || !task.turn.busy) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.turnWaiters.get(task.id) ?? new Set<() => void>();
      waiters.add(resolve);
      this.turnWaiters.set(task.id, waiters);
    });
  }

  /** The task's running turn ended here, or its session was let go. */
  turnOver(taskId: string): void {
    const waiters = this.turnWaiters.get(taskId);
    if (!waiters) return;
    this.turnWaiters.delete(taskId);
    for (const resolve of waiters) resolve();
  }
}

/**
 * The order one delivery of lane rows is, for a conversation on another
 * computer (src/shared/work.ts): its rows, and this delivery among their
 * attempts. Asked again after a drop it is the same order, which that
 * computer answers without acting again; a later delivery of the same rows,
 * after a turn there was lost, is a new one.
 */
export function laneOrder(ids: readonly number[]): string | undefined {
  return ids.length > 0 ? `rows:${ids.join(",")}:${randomUUID().slice(0, 8)}` : undefined;
}

/**
 * Whether a failed turn needs the captain's sign-in. A backend that reports
 * typed failures is read by its class alone - a failure without one is never
 * a sign-in, whatever its words say (a session that exits is a session
 * failure); a prose backend goes through the one prose classifier.
 */
function isSignInFailure(
  profile: ControlProfile | undefined,
  error: string,
  cutOff?: CutOff,
): boolean {
  if (cutOff) return cutOff.class === "signed_out";
  if (profile?.failureSignals === "typed") return false;
  return isAuthFailureMessage(error);
}

/**
 * The provider a sign-in card names: the session's own while it knows one
 * the app offers, else the one the task's record keeps (`provider/id`). A Pi
 * session whose custom connection has no runtime no longer knows its
 * provider (it reads "unknown").
 */
function signInProvider(
  session: string | undefined,
  recorded: string | null | undefined,
): string | undefined {
  const known = (provider: string | undefined) =>
    provider &&
    (isCustomApiProvider(provider) || PROVIDER_CATALOG.some((entry) => entry.id === provider))
      ? provider
      : undefined;
  return known(session) ?? known(recorded?.split("/")[0]);
}
