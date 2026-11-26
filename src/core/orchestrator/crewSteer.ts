import { createHash, randomUUID } from "node:crypto";
import type { AttachmentRef } from "@shared/attachments";
import type { CardNote } from "@shared/cardNotes";
import type { TurnImage } from "@shared/cards";
import type { AskedResponsePolicy, ResponsePolicy } from "@shared/crewResponses";
import type { CrewSendResult } from "@shared/crewTranscript";
import { CREWMATE_TAB_VIA, type TASK_CARD_VIA } from "@shared/provenance";
import { keepImages } from "../attachments";
import { capWithOverflow } from "../overflow";
import { NotOpenThere } from "../placed/crewMachines";
import type { SecretAskEnded } from "../secrets/asks";
import type { SecretBringEnded } from "../secrets/bring";
import type { EndedUseReceipt } from "../secrets/requests";
import type { ModelSession } from "../session/session";
import { withoutOutsideWords } from "../storage/outsideDataScrub";
import type { TaskRecord } from "../storage/taskRecords";
import { TaskService } from "../tasks/taskService";
import type { CrewCore } from "./crewCore";
import type { SteerDelivery, SteerSource, TaskRuntime, UnreadSteer } from "./crewRuntime";
import { retiredResumeText } from "./crewSessions";
import { laneOrder } from "./crewTurns";
import { isCaptainGuidance } from "./mergeAuthorization";
import { describeStatus } from "./settleService";
import { toldInCrewmateTabLine } from "./threadWords";
import {
  renderWake,
  replyWordsSpan,
  type WakeBody,
  withAttachmentsDropped,
  withAttachmentsKept,
  withGuidanceMark,
} from "./wakes";

/**
 * Steering a crewmate (docs/inbox.md): words from the first mate, the
 * captain's Crewmate tab and the host itself, kept in the task's durable
 * lane and delivered into a running turn or as the next one, and the
 * reach line a task's own computer coming back announces. Shares the
 * crew's state through `CrewCore`.
 */
/** A steer's source once checked: its card reference names a lifecycle. */
type CheckedSteerSource = Omit<
  NonNullable<Parameters<CrewSteer["steerCrewmate"]>[3]>,
  "response"
> & { response?: ResponsePolicy | undefined };

export class CrewSteer {
  /**
   * The lane rows that carry the captain's guidance (`isCaptainGuidance`):
   * a turn that holds one carries his words (`carriesCaptainWords`). Kept in
   * memory, so after a restart a row read again no longer counts and the
   * crewmate asks again.
   */
  private readonly captainRows = new Set<number>();

  /**
   * A task's hand-overs of files still crossing (INF-3060), the last of
   * them: its lane is held until it ends (`handingOver`), so every message
   * recorded on it meanwhile is read after the files, in the order sent.
   */
  private readonly handing = new Map<string, Promise<void>>();
  /** Each hand-over's files line on its task's lane, which the messages sent with it are read after. */
  private readonly handedRows = new Map<string, number[]>();

  constructor(private readonly core: CrewCore) {}

  /** Whether the turn running now holds a steer with the captain's words (his own, or the first mate's on his turn). */
  carriesCaptainWords(task: TaskRuntime): boolean {
    return task.turn.rows.some((id) => this.captainRows.has(id));
  }

  /** Metadata-only completion, delivered once through the task's existing durable lane. */
  secretsUseEnded(taskId: string, receipt: EndedUseReceipt): void {
    const once = `secrets-use-ended:${receipt.request}`;
    if (this.core.options.inbox.woken(taskId, once)) return;
    this.core.options.tasks.turns.endIdle(taskId);
    void this.steerInternal(
      taskId,
      { facts: { kind: "secrets-use-ended", receipt }, once },
      { actor: "supervisor", via: "supervision", decision: null, cardId: null },
    ).catch(() => {
      // The durable receipt remains readable; the existing ladder handles an absent conversation.
      console.warn("[crew] Secrets result's steer not delivered.");
    });
  }

  /**
   * An ask to keep a secret ended (docs/secrets.md, "Asking to keep a
   * secret"): its asker hears once, metadata only. A task's crewmate through
   * its lane, the first mate (no task) as a wake on its next turn.
   */
  secretsAskEnded(taskId: string | null, ended: SecretAskEnded): void {
    const once = `secrets-ask-ended:${taskId ?? "firstmate"}:${ended.ask}:${this.core.now()}`;
    const wake = { facts: { kind: "secrets-ask-ended" as const, ended }, once };
    if (!taskId) {
      this.core.hooks().notifyOp(wake, "agent");
      return;
    }
    if (this.core.options.inbox.woken(taskId, once)) return;
    this.core.options.tasks.turns.endIdle(taskId);
    void this.steerInternal(taskId, wake, {
      actor: "supervisor",
      via: "supervision",
      decision: null,
      cardId: null,
    }).catch(() => {
      console.warn("[crew] Secrets ask's steer not delivered.");
    });
  }

  /**
   * A bring from another tool ended (docs/secrets.md, "Bringing secrets from
   * another tool"): its task's crewmate hears once, names, references and
   * outcomes, never a value.
   */
  secretsBringEnded(taskId: string, ended: SecretBringEnded): void {
    const once = `secrets-bring-ended:${taskId}:${ended.bring}:${this.core.now()}`;
    if (this.core.options.inbox.woken(taskId, once)) return;
    this.core.options.tasks.turns.endIdle(taskId);
    void this.steerInternal(
      taskId,
      { facts: { kind: "secrets-bring-ended", ended }, once },
      { actor: "supervisor", via: "supervision", decision: null, cardId: null },
    ).catch(() => {
      console.warn("[crew] Secrets bring's steer not delivered.");
    });
  }

  /**
   * Something sent reached a crewmate (INF-759): words entered its turn,
   * its turn was stopped, its task closed under it or was edited. One push
   * says so, and the center draws its spark out to the crewmate then. Only
   * a crewmate on the ring has a place for it.
   */
  announceReach(taskId: string): void {
    const record = this.core.options.tasks.get(taskId);
    if (record?.kind !== "work" || record.status !== "active") return;
    this.core.options.broadcastEvent({
      type: "task_event",
      taskId,
      key: record.key,
      kind: "reached",
      text: "",
      at: this.core.now(),
      feed: false,
      reached: true,
    });
  }

  async steerCrewmate(
    taskId: string,
    message: WakeBody,
    actor: "firstmate" | "captain" = "firstmate",
    source: {
      via?: "tool" | "card" | "thread" | typeof TASK_CARD_VIA | typeof CREWMATE_TAB_VIA;
      decision?: string | null;
      cardId?: string | null;
      /** The panel the captain moved it from, by its title. */
      panel?: string;
      /** The Firstmate steers in a turn that carries the captain's own words. */
      captainWords?: boolean;
      images?: TurnImage[];
      /** The message's own copies of `images`, kept when it was accepted. */
      attachments?: AttachmentRef[];
      /** First mate tool messages expect answers; host/captain steers do not. */
      response?: AskedResponsePolicy;
      /**
       * The first mate's tool answers once the message is recorded and
       * delivers it behind that answer (INF-3060): `recorded-sending`.
       */
      behind?: boolean;
    } = {},
  ): Promise<SteerDelivery> {
    const checked = this.checkSteer(taskId, actor, source);
    // A first mate message after one still waiting on its files is recorded
    // now and read after it, in the order the first mate sent them.
    if (actor === "firstmate" && this.handingOver(taskId)) {
      await this.sendSteer(taskId, message, actor, checked, true);
      return "after-files";
    }
    return this.sendSteer(taskId, message, actor, checked);
  }

  /** Whether a hand-over of files to the task is still crossing, which holds its lane. */
  handingOver(taskId: string): boolean {
    return this.handing.has(taskId);
  }

  private sendSteer(
    taskId: string,
    message: WakeBody,
    actor: "firstmate" | "captain",
    source: CheckedSteerSource,
    held = false,
  ): Promise<SteerDelivery> {
    // A steer answers a lane stuck at its provider: what it kept goes again
    // with the new words (docs/inbox.md, "Stuck at its provider").
    this.core.options.inbox.unstick(taskId);
    const steer: SteerSource = {
      actor,
      via: source.via ?? "tool",
      decision: source.decision ?? null,
      cardId: source.cardId ?? null,
      ...(source.panel ? { panel: source.panel } : {}),
      ...(source.captainWords ? { captainWords: true } : {}),
    };
    return this.steerInternal(
      taskId,
      message,
      steer,
      source.images,
      source.attachments,
      source.response,
      source.behind,
      held,
    );
  }

  /**
   * The refusals a steer answers before anything is recorded or copied;
   * answers the source with its card reference in the card's lifecycle.
   */
  private checkSteer(
    taskId: string,
    actor: "firstmate" | "captain",
    source: NonNullable<Parameters<CrewSteer["steerCrewmate"]>[3]>,
  ): CheckedSteerSource {
    const record = this.core.options.tasks.get(taskId);
    if (source.response && actor !== "firstmate")
      throw new Error("Only a first mate message creates or cancels its response expectations.");
    if (
      source.response?.mode === "expected" &&
      record?.deviceId &&
      !this.core.options.machines?.takesResponses?.(record.deviceId)
    )
      throw new Error(
        "Update Infinitary on the work computer before requesting a tracked response. Nothing was sent.",
      );
    for (const id of source.response?.cancel ?? []) {
      const request = this.core.options.inbox.responseRequest(id);
      if (request?.state === "answered")
        throw new Error("An answered request cannot be cancelled. Nothing was sent.");
      if (request?.targetTask !== taskId)
        throw new Error(`Response request ${id} does not belong to this task. Nothing was sent.`);
    }
    if (!source.response) return { ...source, response: undefined };
    const { card, ...response } = source.response;
    return {
      ...source,
      response: card
        ? { ...response, card: this.core.reportIntake.checkResponseCard(card, "response_context") }
        : response,
    };
  }

  /**
   * A hand-over ended: its lane goes on, and what waited on it is read now
   * as any message on the lane is - by the idle crewmate, steered into the
   * turn running, or by the crewmate resumed for it (`sweepTaskLane`). A
   * started task in the backlog, whose lane the sweep leaves, is resumed
   * for it as for any first mate message. A task that has not started
   * reads it after its brief.
   */
  private handOverEnded(taskId: string, crossing: Promise<void>): void {
    if (this.handing.get(taskId) !== crossing) return;
    this.handing.delete(taskId);
    const sent = this.handedRows.get(taskId) ?? [];
    this.handedRows.delete(taskId);
    if (this.core.disposed()) return;
    const task = this.core.tasks.get(taskId);
    if (task?.session && !task.turn.closing && !task.turn.busy) {
      // Held for its click's check, it keeps its wake until that check (`LoginMoves`).
      if (!this.core.turns.deliverPendingToTask(task, { sent: true }))
        this.core.loginMoves.keepsSent(taskId, sent);
      return;
    }
    const record = this.core.options.tasks.get(taskId);
    if (
      !task?.session &&
      record &&
      this.core.facts.inBacklog(taskId) &&
      TaskService.isResumable(record) &&
      record.sessionFile &&
      !this.core.facts.laneHeld(taskId)
    ) {
      // A task bound to another login is resumed there, never where it was (`LoginMoves`).
      if (
        this.core.loginMoves.takes(
          taskId,
          (open) => this.core.turns.deliverPendingToTask(open, { sent: true }),
          true,
        )
      )
        return;
      void this.core.sessions
        .resumeTask(taskId)
        .then((resumed) => this.core.turns.deliverPendingToTask(resumed, { sent: true }))
        .catch(() => {
          // The rows are durable; the next first mate message or Start delivers them.
        });
      return;
    }
    // Held for its click's check, it is delivered as sent once the check is made.
    if (record && this.core.facts.inBacklog(taskId)) this.core.loginMoves.keepsSent(taskId, sent);
    void this.core.watch.sweepTaskLane(taskId, this.core.now());
  }

  /**
   * A task that has not started but will - its start runs behind the first
   * mate's answer, it starts by itself once its wait ends, or its start
   * failed and it waits open for update_task start_now - takes a message on
   * its lane, which its crewmate reads right after its brief (INF-3060).
   */
  private waitsToStart(record: TaskRecord): boolean {
    if (record.kind !== "work" || TaskService.isClosed(record)) return false;
    if (this.core.starts.startingBehind(record.id)) return true;
    return (
      record.status === "open" &&
      (record.startPolicy === "when-ready" || record.startNotice != null)
    );
  }

  /**
   * Why a task with no crewmate running cannot be told anything now, or
   * undefined when a message to it is kept: on its lane while it waits to
   * start (`waitsToStart`), or by resuming its idle crewmate.
   */
  private steerRefusal(taskId: string, actor: SteerSource["actor"]): string | undefined {
    const task = this.core.tasks.get(taskId);
    if (task?.session && !task.turn.closing) return undefined;
    const record = this.core.options.tasks.get(taskId);
    if (!record) return `Unknown task "${taskId}". Check crew_status for live task ids.`;
    if (actor !== "supervisor" && this.waitsToStart(record)) return undefined;
    if (!TaskService.isResumable(record))
      return `Task ${taskId} is ${describeStatus(record)} and no longer steerable. ${record.status === "dropped" ? "On the captain’s request, use update_task start_again to create a replacement." : "Spawn a follow-up crewmate instead."}`;
    if (!record.sessionFile)
      return `Task ${taskId} has no session to resume. Spawn a follow-up instead.`;
    if (this.core.sessions.retiredProviderOf(taskId)) return retiredResumeText(taskId);
    return undefined;
  }

  /**
   * The first mate's steer with files_from (INF-3060): the steer's and the
   * hand-over's checks answer now, and the message is recorded on the
   * task's lane now, after a line about the files, so a quit loses
   * neither. The lane is held while the copy, which can take a minute to
   * another computer, goes on behind the tool's answer; the line then says
   * where the files are, and the crewmate reads it and every message
   * behind it. A task that has not started - its start runs behind an
   * earlier answer, it waits for its turn, or its start failed and it waits
   * open for its retry - takes the files once it has started. A hand-over that fails leaves the line
   * saying the files did not arrive, and the first mate hears so in one
   * [fm-op].
   */
  async steerAfterFiles(
    fromTask: string,
    taskId: string,
    message: string,
    source: Parameters<CrewSteer["steerCrewmate"]>[3] = {},
  ): Promise<void> {
    const checked = this.checkSteer(taskId, "firstmate", source);
    const refused = this.steerRefusal(taskId, "firstmate");
    if (refused) throw new Error(refused);
    // What only the source task decides answers now, even while the target
    // waits to start; its folder is there only once it has started.
    const { from } = await this.core.sessions.handSource(fromTask);
    const fromHandle = from.key || from.id;
    const target = this.core.options.tasks.get(taskId);
    const ready =
      target && this.waitsToStart(target)
        ? undefined
        : await this.core.sessions.prepareHandFiles(from.id, taskId);
    let files: number | undefined = ready?.files;
    let arrived = 0;
    let resolveLine: (inboxId: number) => void = () => {};
    const line = new Promise<number>((resolve) => {
      resolveLine = resolve;
    });
    const before = this.handing.get(taskId) ?? Promise.resolve();
    const crossing = before.then(async () => {
      const lineId = await line;
      // The message was refused as it was recorded: nothing to hand on.
      if (lineId < 0) return;
      try {
        // A start that fails leaves the task open for its retry, which the
        // files wait for too.
        for (
          let record = this.core.options.tasks.get(taskId);
          !ready && record && this.waitsToStart(record) && !this.core.disposed();
          record = this.core.options.tasks.get(taskId)
        )
          await this.core.starts.nextStart(taskId);
        const handover = ready ?? (await this.core.sessions.prepareHandFiles(from.id, taskId));
        files = handover.files;
        const handed = await handover.copy((count) => {
          arrived = count;
        });
        // The line was held with the lane, so no turn has it yet.
        if (!this.core.options.inbox.revise(lineId, handed))
          this.handedRow(taskId, this.core.options.inbox.enqueue(taskId, handed));
      } catch (caught) {
        const record = this.core.options.tasks.resolve(taskId);
        this.core.hooks().notifyOp(
          {
            facts: {
              kind: "handover-failed",
              task: { id: record?.id ?? taskId, title: record?.title ?? taskId },
              from: fromHandle,
              error: caught instanceof Error ? caught.message : String(caught),
              arrived,
              ...(files !== undefined ? { files } : {}),
            },
          },
          "agent",
          record?.id ?? taskId,
        );
      }
    });
    // Held from here: nothing recorded on the lane is read before the files.
    this.handing.set(taskId, crossing);
    void crossing.then(() => this.handOverEnded(taskId, crossing));
    // Until the files arrive, the line says what is true if they never do.
    const lineId = this.core.options.inbox.enqueue(taskId, handoverMissingLine(fromHandle));
    this.handedRow(taskId, lineId);
    try {
      await this.sendSteer(taskId, message, "firstmate", checked, true);
    } catch (caught) {
      this.core.options.inbox.withdraw([lineId]);
      resolveLine(-1);
      throw caught;
    }
    resolveLine(lineId);
  }

  private handedRow(taskId: string, id: number): void {
    this.handedRows.set(taskId, [...(this.handedRows.get(taskId) ?? []), id]);
  }

  /**
   * `body` is the guidance as its lane stores it: the words given, or a
   * typed wake (the ladder's nudge) that renders to the words the crewmate
   * is steered with and the timeline records.
   */
  async steerInternal(
    taskId: string,
    body: WakeBody,
    given: SteerSource,
    images?: TurnImage[],
    attachments?: readonly AttachmentRef[],
    response?: ResponsePolicy,
    behind = false,
    /**
     * Recorded on the lane and kept there while a hand-over of files before
     * it crosses (`handingOver`), which delivers it when it ends.
     */
    held = false,
  ): Promise<SteerDelivery> {
    let message = renderWake(body);
    // A reply the captain typed under a card: the record reads the captain's words in the message.
    const words = replyWordsSpan(body);
    const captainText =
      given.actor === "captain" &&
      typeof body !== "string" &&
      body.facts.kind === "crewmate-tab-line"
        ? body.facts.captainText
        : undefined;
    const source: SteerSource = {
      ...given,
      ...(words ? { words } : {}),
      ...(captainText !== undefined ? { captainText } : {}),
    };
    const reviewBuilder = this.core.reviewBuilderOf(this.core.options.tasks.get(taskId));
    const hasImages = Boolean(images?.length);
    const withPictures = (guidance: WakeBody): WakeBody =>
      attachments?.length
        ? withAttachmentsKept(guidance, attachments)
        : hasImages
          ? withAttachmentsDropped(guidance)
          : guidance;
    let durable = withPictures(body);
    const liveImages = hasImages ? images : undefined;
    // The captain's guidance while his kept merge approval stands takes its
    // mark as its row is recorded, and the mark rides the message, so the
    // crewmate can declare only guidance it read (FI3-662).
    const guidance = isCaptainGuidance(given, body);
    // The host's own steer - a timed wait's end, a closed dependency, a
    // check's result - waits on a started task's lane in the backlog.
    const sentByHost = given.actor === "supervisor";
    const enqueue = (): number => {
      if (this.core.restarts.observing(taskId)) {
        this.core.restarts.recordRestartOutcome(
          taskId,
          "stopped",
          "new guidance arrived before automatic recovery was confirmed",
        );
        this.core.restarts.forget(taskId);
      }
      const mark = guidance ? this.core.settling.approvals.holdForGuidance(taskId) : undefined;
      if (mark !== undefined) {
        const marked = withGuidanceMark(body, mark);
        message = renderWake(marked);
        durable = withPictures(marked);
      }
      const id = this.core.options.inbox.transaction(() => {
        for (const id of response?.cancel ?? []) this.core.options.inbox.cancelResponse(id);
        if (response?.cancel?.length) {
          durable = {
            facts: {
              kind: "responses-cancelled",
              requests: response.cancel,
              guidance: typeof durable === "string" ? durable : durable.facts,
            },
            ...(typeof durable !== "string" && durable.ways ? { ways: durable.ways } : {}),
          };
          message = renderWake(durable);
        }
        if (response?.mode !== "expected") return this.enqueueSteer(taskId, durable);
        const requested = this.core.options.inbox.requestResponse(
          taskId,
          renderWake(body),
          {
            session: response.sourceSession,
            message: given.decision,
            card: response.card,
            targetSession:
              this.core.tasks.get(taskId)?.session?.recordPath() ??
              this.core.options.tasks.get(taskId)?.sessionFile,
          },
          durable,
        );
        // A request asked for a captain's message ties that message to it.
        if (response.ask)
          this.core.options.tasks.capture.tieRequest(response.ask, taskId, requested.request.id);
        durable = requested.body;
        message = renderWake(durable);
        return requested.inboxId;
      });
      if (guidance) this.captainRows.add(id);
      return id;
    };
    const task = this.core.tasks.get(taskId);
    if (held) {
      if (!task?.session || task.turn.closing) {
        const refused = this.steerRefusal(taskId, given.actor);
        if (refused) throw new Error(refused);
      }
      const id = enqueue();
      this.recordSteer(taskId, message, source, "recorded-held", id);
      return "recorded-held";
    }
    if (task?.session && !task.turn.closing) {
      if (task.turn.busy && !task.turn.running) {
        const id = enqueue();
        this.recordSteer(taskId, message, source, "queued-next-turn", id);
        return "queued-next-turn";
      }
      if (task.turn.busy) {
        // Its computer is out of reach, or this one is being updated: kept
        // on the lane, and steered into the turn once it is back and caught
        // up, or served by the turn that carries it on.
        if (this.core.facts.outOfReach(taskId) || this.core.updates.heldForUpdate(taskId)) {
          const held = enqueue();
          this.recordSteer(taskId, message, source, "recorded-held", held);
          return "recorded-held";
        }
        // A task bound to another login takes no more words on the one it
        // leaves: they wait for the move at its turn's end (`LoginMoves`).
        if (
          reviewBuilder ||
          task.session.controlProfile.steer === "followup-queue" ||
          this.core.loginMoves.bindsTask(taskId)
        ) {
          const queued = enqueue();
          this.recordSteer(taskId, message, source, "queued-next-turn", queued);
          return "queued-next-turn";
        }
        const id = enqueue();
        this.core.options.inbox.markDelivered([id]);
        this.announceReach(taskId);
        // Handled when the turn it landed in ends: ack rides turnComplete.
        const steered = this.steerIntoTurn(task, task.session, message, [id], liveImages)
          .then((): SteerDelivery => {
            this.recordSteer(taskId, message, source, "mid-turn", id);
            return "mid-turn";
          })
          .catch((caught: unknown): SteerDelivery => {
            // A conversation that did not open there again: it goes back unspent.
            if (caught instanceof NotOpenThere) this.core.options.inbox.reparkUndelivered([id]);
            else this.core.options.inbox.release([id]);
            this.recordSteer(taskId, message, source, "recorded-retrying", id);
            return "recorded-retrying";
          });
        if (!behind) return steered;
        void steered;
        return "recorded-sending";
      }
      const pending = enqueue();
      if (this.core.facts.laneHeld(taskId) || (sentByHost && this.core.facts.inBacklog(taskId))) {
        // Kept on the lane until the account serves again, or the task leaves the backlog.
        if (!sentByHost) this.core.loginMoves.keepsSent(taskId, [pending]);
        this.recordSteer(taskId, message, source, "recorded-held", pending);
        if (sentByHost) this.tellBacklogNews(taskId, message);
        return "recorded-held";
      }
      const moved = this.steerThroughMove(taskId, message, source, pending, behind);
      if (moved) return moved;
      this.recordSteer(taskId, message, source, "mid-turn", pending);
      this.core.turns.deliverPendingToTask(task, { sent: true });
      return "mid-turn";
    }
    const refused = this.steerRefusal(taskId, given.actor);
    const record = this.core.options.tasks.get(taskId);
    if (refused || !record) throw new Error(refused);
    if (given.actor !== "supervisor" && this.waitsToStart(record)) {
      const queued = enqueue();
      this.recordSteer(taskId, message, source, "recorded-queued", queued);
      return "recorded-queued";
    }
    const resumeId = enqueue();
    if (this.core.facts.laneHeld(taskId) || (sentByHost && this.core.facts.inBacklog(taskId))) {
      if (!sentByHost) this.core.loginMoves.keepsSent(taskId, [resumeId]);
      this.recordSteer(taskId, message, source, "recorded-held", resumeId);
      if (sentByHost) this.tellBacklogNews(taskId, message);
      return "recorded-held";
    }
    const moved = this.steerThroughMove(taskId, message, source, resumeId, behind);
    if (moved) return moved;
    const resumed = this.core.sessions
      .resumeTask(record.id)
      .then((runtime): SteerDelivery => {
        this.recordSteer(taskId, message, source, "mid-turn", resumeId);
        this.core.turns.deliverPendingToTask(runtime, { sent: true });
        return "mid-turn";
      })
      .catch((): SteerDelivery => {
        // The row is durable; the tick sweep retries the resume.
        this.recordSteer(taskId, message, source, "recorded-retrying", resumeId);
        return "recorded-retrying";
      });
    if (!behind) return resumed;
    void resumed;
    return "recorded-sending";
  }

  /**
   * A message sent to a task bound to another login: it is read on the
   * login the task ends up with, never where it was (`LoginMoves`), and
   * answered once the move is over; the row is durable when the move hands
   * nothing on. Undefined when no move binds the task.
   */
  private steerThroughMove(
    taskId: string,
    message: string,
    source: SteerSource,
    id: number,
    behind: boolean,
  ): Promise<SteerDelivery> | SteerDelivery | undefined {
    const moved = this.core.loginMoves
      .takes(taskId, (open) => this.core.turns.deliverPendingToTask(open, { sent: true }), true)
      ?.then((handed): SteerDelivery => {
        const outcome = handed ? "mid-turn" : "recorded-retrying";
        this.recordSteer(taskId, message, source, outcome, id);
        return outcome;
      });
    if (!moved || !behind) return moved;
    void moved;
    return "recorded-sending";
  }

  /**
   * The host's news - a closed dependency, a check's result, a job's exit -
   * reached a started task in the backlog, where it waits on the lane until
   * a Start. The first mate hears it once per stay there (INF-3143,
   * direction A): a parked blocker that changes is not missed, and news
   * that changes nothing wakes nobody again. A task outside the backlog,
   * or one already told about this stay, sends nothing.
   */
  tellBacklogNews(taskId: string, news: string): void {
    const record = this.core.options.tasks.get(taskId);
    if (record?.status !== "active" || record.backlogSince == null) return;
    const once = `backlog-news:${record.backlogSince}`;
    if (this.core.options.inbox.woken(taskId, once)) return;
    this.core.routeCrewEvent(
      taskId,
      {
        once,
        facts: {
          kind: "backlog-news",
          task: { id: taskId, title: record.title },
          waitedMs: Math.max(0, this.core.now() - record.backlogSince),
          // Words from outside stay in the crewmate's steer, never in this
          // copy or the overflow file a long one spills into.
          news: capWithOverflow(withoutOutsideWords(news, this.core.now()), "backlog-news"),
        },
      },
      "agent",
    );
  }

  /**
   * A steer's durable row. A host steer that goes out once per fact (the
   * check watch's) records its name with the row (`enqueueSteerOnce`).
   */
  private enqueueSteer(taskId: string, body: WakeBody): number {
    return typeof body !== "string" && body.once !== undefined
      ? this.core.options.inbox.enqueueSteerOnce(taskId, { ...body, once: body.once })
      : this.core.options.inbox.enqueue(taskId, body);
  }

  /**
   * Steer the running turn with lane rows already marked in flight. The
   * rows are the turn's before the session is asked, so a steer that lands
   * in the turn's own tail is known to the turn's end, which takes it back
   * (`undeliveredSteerRows`); a steer the session refuses takes its rows
   * back out and throws.
   */
  async steerIntoTurn(
    task: TaskRuntime,
    session: ModelSession,
    text: string,
    ids: number[],
    images?: TurnImage[],
  ): Promise<void> {
    const undo = task.turn.carrySteer(ids);
    const handed: UnreadSteer = {
      sha: createHash("sha256").update(text).digest("hex"),
      since: this.core.now(),
    };
    task.unreadSteers.push(handed);
    const order = laneOrder(ids);
    try {
      if (images) await session.steer(text, images, order);
      else if (order) await session.steer(text, undefined, order);
      else await session.steer(text);
    } catch (caught) {
      undo();
      task.unreadSteers = task.unreadSteers.filter((steer) => steer !== handed);
      throw caught;
    }
  }

  /**
   * The steer's timeline event (R2 forward capture), written once the
   * control plane has decided what happened to it. Bookkeeping never takes
   * a steer down with it.
   */
  private recordSteer(
    taskId: string,
    message: string,
    source: SteerSource,
    outcome: SteerDelivery,
    inboxId: number,
  ): void {
    try {
      this.core.options.tasks.turns.recordSteer(taskId, {
        text: message,
        actor: source.actor,
        outcome,
        via: source.via,
        decision: source.decision,
        cardId: source.cardId,
        inboxId,
        ...(source.panel ? { panel: source.panel } : {}),
        ...(source.words ? { words: source.words } : {}),
        ...(source.captainText !== undefined ? { captainText: source.captainText } : {}),
      });
    } catch (caught) {
      console.warn("[crew] steer capture failed:", caught);
    }
  }

  /**
   * A line the captain typed in the task card's Crewmate tab
   * (docs/task-card-tabs.md, "Typing"): his steer on the crewmate's own
   * lane, as a reply under its card is, with his words verbatim, and one
   * feed line. Firstmate is not in the loop; it reads the steer on the
   * task's timeline. A task no crewmate can be told anything about refuses
   * in words and writes nothing.
   */
  async steerFromCrewmateTab(
    taskId: string,
    words: string,
    more: { notes?: CardNote[] | undefined; images?: TurnImage[] | undefined } = {},
  ): Promise<CrewSendResult> {
    const text = words.trim();
    // Notes on the task's running page ride the line, with the pictures their marks are drawn
    // on (docs/task-browser.md, "Pointing at a page"); they need no words beside them.
    const notes = more.notes?.length ? more.notes : undefined;
    const images = more.images?.length ? more.images : undefined;
    if (!text && !notes) return { ok: false, text: "There is nothing to send." };
    const record = this.core.options.tasks.get(taskId);
    if (!record) return { ok: false, text: "This task is not on the record." };
    if (TaskService.isClosed(record)) {
      return { ok: false, text: "This task is closed, so its crewmate cannot be told anything." };
    }
    if (!this.core.tasks.has(taskId) && !record.sessionFile) {
      return { ok: false, text: "This task's crewmate has not started yet." };
    }
    try {
      await this.steerCrewmate(
        taskId,
        {
          facts: {
            kind: "crewmate-tab-line",
            words: text,
            captainText: words,
            ...(notes ? { notes } : {}),
          },
        },
        "captain",
        {
          via: CREWMATE_TAB_VIA,
          // The accepted line owns copies of its pictures before its lane records it.
          ...(images ? { images, attachments: keepImages(randomUUID(), images) } : {}),
        },
      );
    } catch (caught) {
      return { ok: false, text: caught instanceof Error ? caught.message : String(caught) };
    }
    const crewmate = this.core.tasks.get(taskId)?.crewmate ?? record.assignee ?? "the crewmate";
    this.core.options.broadcastEvent({
      type: "firstmate_note",
      text: toldInCrewmateTabLine(crewmate, record.title),
    });
    return { ok: true };
  }

  /**
   * ⌃C or Stop in the task card's Crewmate tab: the captain's interrupt of
   * the crewmate's running turn, on the path Firstmate's interrupt takes;
   * the task stays steerable. With no turn running it refuses in words.
   */
  async interruptFromCrewmateTab(taskId: string): Promise<CrewSendResult> {
    const task = this.core.tasks.get(taskId);
    if (!task || !task.turn.busy) {
      return { ok: false, text: "Its turn is not running." };
    }
    try {
      await this.core.sessions.interruptCrewmate(taskId, "interrupt", {
        actor: "captain",
        via: CREWMATE_TAB_VIA,
        decision: null,
      });
      return { ok: true };
    } catch (caught) {
      return { ok: false, text: caught instanceof Error ? caught.message : String(caught) };
    }
  }
}

/**
 * The line a hand-over's message is read after while its files cross, as it
 * stands if they never arrive: a quit or a failure leaves it so.
 */
function handoverMissingLine(from: string): string {
  return `Files from ${from} were to come with the message below, but they did not arrive. If you need them, say so in your report.`;
}
