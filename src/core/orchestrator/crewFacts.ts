import type { TurnImage } from "@shared/cards";
import { isRepairAssessment } from "@shared/checkRepair";
import { HERE } from "@shared/deviceNames";
import type { CrewCounts } from "@shared/events";
import { forgePlace } from "@shared/forge";
import { holdNames, overrideSpan, standingOverride } from "@shared/holds";
import { formatDurationShort } from "@shared/quotaSignals";
import {
  autonomyForRecord,
  deliveryForRecord,
  opensPullRequest,
  type RepoDelivery,
} from "@shared/repos";
import { cutText } from "@shared/textCut";
import { AttachmentUnavailableError, loadImages } from "../attachments";
import { capWithOverflow } from "../overflow";
import type { CrewStatusEntry } from "../pi/crewTools";
import { LOCAL_MACHINE_ID } from "../session/session";
import { INBOX_ATTEMPT_MAX, type InboxRow } from "../storage/inboxStore";
import type { TaskRecord } from "../storage/taskRecords";
import { alreadyAllowed } from "../tasks/alreadyAllowed";
import { hasStartQueueWait, queueWaitOf } from "../tasks/queueWait";
import { TaskService } from "../tasks/taskService";
import { crewTally } from "../tasks/workPresentation";
import { ciFactOf } from "./ciFact";
import { costCardId } from "./costLimits";
import type { CrewCore } from "./crewCore";
import type { LaneHold } from "./crewRuntime";
import type { CrewSupervisorOptions } from "./crewSupervisorOptions";
import { premiumRetryPossible } from "./holds";
import type { AccountServeability } from "./idleLadder";
import { blockedText, gateText } from "./intake";
import type { PersonalBriefFacts } from "./intentBrief";
import { reviewCoversHead } from "./reviewCarry";
import { rowAttachments } from "./wakes";
import { deliverableOf } from "./workShape";

/**
 * The crew's facts (docs/report-sort.md, docs/inbox.md): each task's crew
 * status for the first mate, the crew counts the window shows, and the
 * lane facts the sweeps read - due rows, pictures, the backlog, holds and
 * where a task runs. Shares the crew's state through `CrewCore`.
 */
export class CrewFacts {
  private readonly ciFact = Symbol("crew check summary");
  /** The lane rows whose pictures were already said to be unavailable. */
  private blockedPictureRows = new Set<number>();

  constructor(private readonly core: CrewCore) {}

  deliverableRows(taskId: string, now: number): InboxRow[] {
    const rows = this.core.options.inbox.pending(taskId, now, { maxAttempts: INBOX_ATTEMPT_MAX });
    const task = this.core.tasks.get(taskId);
    const running = task !== undefined && task.turn.busy;
    // A renewed conversation's reason rides the next full turn (`runTurn`),
    // never a turn of its own and never a mid-turn steer; why the app
    // stopped a turn part way is a turn of its own, never a mid-turn steer.
    // A context or refusal restart that waited for a model, with no crewmate
    // here, is the turn of its own that opens its new conversation, its
    // brief and guidance served (`CrewSessions.waitingRestart`).
    const sessionFile = task ? undefined : this.core.options.tasks.get(taskId)?.sessionFile;
    const waited = (row: InboxRow) =>
      row.facts?.kind === "conversation-restart" &&
      (row.facts.restart.changed === "context" || row.facts.restart.changed === "refused") &&
      sessionFile !== undefined &&
      row.facts.restart.from === sessionFile;
    const rest = rows.filter(
      (row) =>
        (row.facts?.kind !== "conversation-restart" || waited(row)) &&
        !(running && row.facts?.kind === "turn-resumed"),
    );
    // A policy, override or kept-copy notice alone is guidance, not permission to resume or start.
    if (
      !this.core.tasks.get(taskId)?.turn.running &&
      rest.every(
        (row) =>
          row.facts?.kind === "task-policies-changed" ||
          row.facts?.kind === "away-copy-kept" ||
          row.facts?.kind === "task-override-changed" ||
          row.facts?.kind === "task-allowed-changed",
      )
    )
      return [];
    return rest;
  }

  /**
   * The pictures the rows' messages keep copies of, read back for the turn
   * or steer that serves them. A copy that is missing or changed blocks the
   * rows: they stay on the lane, and the feed says so once - never a
   * delivery without the picture the captain attached.
   */
  rowPictures(taskId: string, rows: readonly InboxRow[]): { images?: TurnImage[]; blocked?: true } {
    const refs = rowAttachments(rows);
    if (refs.length === 0) return {};
    try {
      return { images: loadImages(refs) };
    } catch (caught) {
      const first = rows[0]?.id;
      if (first !== undefined && !this.blockedPictureRows.has(first)) {
        this.blockedPictureRows.add(first);
        const why =
          caught instanceof AttachmentUnavailableError
            ? caught.message
            : "its picture could not be read";
        this.core.options.broadcastEvent({
          type: "firstmate_note",
          text: `A message to ${this.core.tasks.get(taskId)?.crewmate ?? "the crewmate"} is waiting: ${why} Send it again with the picture.`,
          taskId,
        });
      }
      return { blocked: true };
    }
  }

  /**
   * A started task went back to the backlog (INF-2062; `TaskRecord.backlogSince`):
   * the host's own rows wait on its lane until a Start, and nothing the
   * idle ladder or a report's sort reads wakes it. Words the captain or the
   * first mate send still reach it (`deliverPendingToTask`'s `sent`).
   */
  inBacklog(taskId: string): boolean {
    const record = this.core.options.tasks.get(taskId);
    return record?.status === "active" && record.backlogSince != null;
  }

  /**
   * A task lane is held while a typed cut-off stands on its account (the
   * cut-off contract, docs/inbox.md; `IdleLadder.cutOffHolds`, the one
   * predicate the wakes read too): its rows are not attempted at all - no
   * attempt spent, no backoff advanced, no session resumed - until the
   * cut-off ends. A resumed task keeps its account even so
   * (`reselectForResume`), so the record's account is read too. The idle
   * ladder reads the hold as the task moving. A lane whose computer that
   * runs work is out of reach, or back and not yet caught up, is held the
   * same way (`outOfReach`).
   */
  laneHeld(taskId: string): boolean {
    return this.laneHold(taskId) !== undefined;
  }

  /**
   * What holds the lane (`laneHeld`), or undefined when nothing does, so
   * steer_crewmate answers a kept message with its real hold. A cost limit
   * comes first: only the captain's answer on its card ends it.
   */
  laneHold(taskId: string): LaneHold | undefined {
    const record = this.core.options.tasks.get(taskId);
    // The task, or a task above it, passed its cost limit: nothing starts
    // until the captain answers its card (docs/usage.md, "The cost limit").
    const cost = this.core.costLimits.heldBy(taskId);
    if (cost)
      return {
        kind: "cost-limit",
        holder: cost.taskId,
        holderKey: this.core.options.tasks.get(cost.taskId)?.key || cost.taskId,
        limitUsd: cost.limitUsd,
        cardId: costCardId(cost.taskId),
      };
    // A move to another computer starts no new turn until it has moved, its
    // new conversation opened there and its dependencies installed
    // (`restartFrom`, `preparing`, `reopenMovedTask`).
    const move = record?.shape?.computer_move;
    if (
      move?.phase === "waiting" ||
      move?.phase === "moving" ||
      move?.restartFrom !== undefined ||
      move?.preparing === true ||
      this.core.moves.isCrossing(taskId)
    )
      return { kind: "move" };
    // A hand-over of files still crossing: what is behind it waits for it (INF-3060).
    if (this.core.steer.handingOver(taskId)) return { kind: "hand-over" };
    // Its model left every level and no other can take it yet (docs/routing.md).
    const cause = this.core.moves.modelWaitCause(taskId);
    if (cause) return { kind: "model", cause };
    const accountId = this.core.tasks.get(taskId)?.accountId ?? record?.accountId;
    // A task with a confirmed move to another login is not held by the
    // login it leaves: its next delivery makes the move (`LoginMoves.takes`).
    if (
      !this.core.loginMoves.bindsTask(taskId) &&
      this.core.ladder.cutOffHolds({
        id: taskId,
        accountId: accountId ?? null,
        deviceId: record?.deviceId ?? null,
      })
    )
      return { kind: "account" };
    // This computer's update, or the update of the computer the task runs on.
    if (this.core.updates.heldForUpdate(taskId)) return { kind: "update" };
    if (this.core.updates.waitsForUpdateThere(taskId)) return { kind: "update" };
    if (this.outOfReach(taskId))
      return this.core.updates.isUpdating(this.machineOf(taskId))
        ? { kind: "update" }
        : { kind: "out-of-reach" };
    return undefined;
  }

  /**
   * Whether each account serves, as the cut-off contract reads it: this
   * Mac's own (`serveability`), and a computer's own for a task that runs
   * there (`CrewMachines.cutOffOf`), keyed apart (docs/helper.md, "Its own
   * sign-ins"). A wake names a computer's account with where it is, "Claude
   * on Mac mini". Absent when neither is given.
   */
  serveability(): AccountServeability | undefined {
    return serveabilityOf(this.core.options);
  }

  machineOf(taskId: string): string {
    return this.core.options.tasks.get(taskId)?.deviceId ?? LOCAL_MACHINE_ID;
  }

  /**
   * The task runs on a computer that runs work, which is out of reach or
   * back and not yet caught up (docs/helper.md, "Holding a conversation"):
   * its turn goes on there, so nothing here calls it stuck, nudges it or
   * hands it work, and it never runs here instead.
   */
  outOfReach(taskId: string): boolean {
    const machine = this.machineOf(taskId);
    if (machine === LOCAL_MACHINE_ID) return false;
    // Being updated, it stops for a moment: nothing is handed to it meanwhile.
    if (this.core.updates.isUpdating(machine)) return true;
    return this.core.options.machines?.ready(machine, taskId) !== true;
  }

  /**
   * Where a task stands with its independent review, for crew_status and
   * the context block: the reviewer's own row names the builder; a builder
   * has a review open, a verdict short of a pass, or a pass. A care name
   * says nothing here: what each care asks is the care runbook's.
   */
  private reviewState(record: TaskRecord): string | undefined {
    const shape = record.shape;
    if (shape?.kind === "review" && record.parentId) {
      const builder = this.core.options.tasks.get(record.parentId);
      return isRepairAssessment(shape)
        ? `assesses ${builder?.key || record.parentId}'s repair`
        : `reviews ${builder?.key || record.parentId}`;
    }
    // A review happens at any care (INF-1875).
    const verdict = record.delivery?.reviewVerdict;
    // A pass names the version it read, and says when it does not cover
    // the version on offer (INF-3141).
    if (verdict === "pass") {
      const read = record.delivery?.reviewSha;
      const offered = record.delivery?.headSha;
      if (!read) return "review passed";
      return offered && !reviewCoversHead(record.delivery, offered)
        ? `review passed at ${read.slice(0, 7)} only, an earlier version than ${offered.slice(0, 7)} on offer`
        : `review passed at ${read.slice(0, 7)}`;
    }
    const open = this.core.openReviewOf(record.id);
    if (open) return `review open (${open.key || open.id})`;
    return verdict ? `review: ${verdict}` : undefined;
  }

  personalFacts(ongoing?: boolean): PersonalBriefFacts | undefined {
    const personal = this.core.options.personal;
    if (!personal) return undefined;
    return { workspaceDir: personal.workspaceDir, surfaces: personal.surfaces(), ongoing };
  }

  /**
   * A task on the personal workspace: no worktree, the host commits, a
   * report closes it. The workspace's KIND says so since Task A of the
   * posture rationalization - it was a third delivery posture before, which
   * made `delivery` answer two questions at once.
   */
  isPersonalTask(taskId: string): boolean {
    const repoId = this.core.options.tasks.get(taskId)?.repoId;
    if (!repoId) return false;
    return this.core.options.repos.get(repoId)?.kind === "personal";
  }

  /**
   * A task the host filed to work in place in its project's folder (INF-549,
   * `WorkShape.in_place`): no working copy, no delivery, no merge, and no
   * completion decision; the host closes it when the folder is up to date.
   */
  worksInPlace(taskId: string): boolean {
    return this.core.options.tasks.get(taskId)?.shape?.in_place !== undefined;
  }

  /**
   * Whether this task's green work may be merged without the captain: its
   * own ask, else the repository's standing flag (`autonomyFor`). The one
   * reader for the settle refusal, `crew_status` and the fact strip, so
   * none of the three can disagree with another.
   */
  taskAutonomy(taskId: string): boolean {
    const record = this.core.options.tasks.get(taskId);
    if (!record) return false;
    return this.core.options.tasks.policiesOf(record)?.autonomy.value ?? false;
  }

  premiumCanServe(): boolean {
    return this.core.hooks().premiumCanServe?.() !== false;
  }

  /**
   * The live crew registry: open rows waiting to start and active rows -
   * a runtime's live state when one exists, else the durable record's own
   * (an idle or interrupted crewmate a previous process left is still
   * steerable, and its last report rides the record across the restart).
   * Closed rows (done, dropped) are history, not crew.
   */
  crewStatus(taskId?: string, options: { startedOnly?: boolean } = {}): CrewStatusEntry[] {
    return this.core.options.tasks.readProjection(() =>
      this.readCrewStatus(taskId, options.startedOnly),
    );
  }

  private readCrewStatus(taskId?: string, startedOnly = false): CrewStatusEntry[] {
    const records = taskId
      ? [this.core.options.tasks.get(taskId)].flatMap((r) => (r ? [r] : []))
      : startedOnly
        ? this.core.options.tasks.listActive()
        : this.core.options.tasks.listLive();
    // A decision row or a host card's row is its card, not crew work.
    const crew = records
      .filter((record) => !startedOnly || record.status === "active")
      .filter((record) => record.kind !== "decision" && record.kind !== "operation")
      .filter(
        (record) =>
          this.core.tasks.has(record.id) || record.status === "open" || record.status === "active",
      );
    const threads = this.core.cards.threadFacts(crew.map((record) => record.id));
    return crew.map((record) => {
      const runtime = this.core.tasks.get(record.id);
      const repo = record.repoId ? this.core.options.repos.get(record.repoId) : undefined;
      const reportText = runtime?.lastCompleteText || record.outcome || "";
      const lastReport = reportText ? capWithOverflow(reportText, "crew-status-report") : undefined;
      const starting = this.core.options.tasks.starts.startAttemptOf(record.id);
      const queueWait =
        starting || !hasStartQueueWait(record)
          ? undefined
          : queueWaitOf(
              record,
              this.core.options.tasks.graph.blockers(record.id),
              this.core.options.tasks.graph.linksTo(record.id),
              this.core.options.tasks.graph.children(record.id),
            );
      // A started task in the backlog (INF-2062) waits for start_now, with how long it has.
      const backlog =
        record.status === "active" && record.backlogSince != null
          ? `started, in the backlog ${formatDurationShort(Math.max(0, this.core.now() - record.backlogSince))}; start_now picks it up`
          : undefined;
      const gate = starting
        ? undefined
        : (backlog ??
          queueWait?.line ??
          (record.status === "open"
            ? record.gate
              ? gateText(record.gate)
              : (this.waitingOnBlockers(record) ??
                (record.startPolicy === "on-request" ? "starts on request" : undefined))
            : undefined));
      const computer = this.taskComputer(record);
      const away = record.status === "active" ? this.core.moves.awayFact(record) : undefined;
      const rigor = this.core.options.tasks.policiesOf(record)?.rigor.value;
      const review = this.reviewState(record);
      const thread = threads.get(record.id);
      const restart = this.core.restarts.restartFact(record.id);
      const now = this.core.now();
      const stalledSince = this.core.ladder.stalledSince(record, now);
      const stalled = stalledSince
        ? this.core.ladder.stalledFact(record, now, stalledSince)
        : undefined;
      const timing = this.timingFacts(record);
      const refused = record.delivery?.cardRefusal;
      const ci = this.core.options.tasks.projectedFact(record, this.ciFact, () =>
        ciFactOf(record.delivery, this.core.now()),
      );
      const override = standingOverride(record.delivery, record.delivery?.headSha);
      const allowed = alreadyAllowed(this.core.options.tasks, record).allowances;
      // A personal task carries no delivery: it builds in place, and
      // saying "local-only" here would be a posture the Firstmate could
      // act on. The brief omits the line for the same reason.
      const delivery =
        repo?.kind === "personal" ? undefined : deliveryForRecord(record, repo?.delivery);
      // Where its proposed change goes, in the person's word for the host
      // (git integration PR 1.3) - only where one goes somewhere.
      const goesIn =
        opensPullRequest(delivery) && repo?.host
          ? forgePlace({ kind: repo.host.kind, host: repo.host.name })
          : null;
      return {
        taskId: record.id,
        key: record.key,
        title: record.title,
        status: backlog
          ? "backlog"
          : runtime
            ? !runtime.turn.busy
              ? "idle"
              : "running"
            : record.status === "open"
              ? "queued"
              : (record.activity ?? "idle"),
        ...(runtime ? { crewmate: runtime.crewmate } : {}),
        repoName: repo?.name ?? "default workspace",
        branch: record.branch,
        ...(gate ? { gate } : {}),
        ...(computer ? { computer } : {}),
        ...(away ? { away } : {}),
        ...(lastReport ? { lastReport } : {}),
        ...(restart ? { restart } : {}),
        premiumRetryEligible: premiumRetryPossible(record),
        ...(rigor ? { rigor } : {}),
        ...(review ? { review } : {}),
        ...(thread ? { thread } : {}),
        ...(stalled ? { stalled } : {}),
        ...timing.words,
        ...(Object.keys(timing.times).length > 0 || stalledSince
          ? {
              times: {
                ...timing.times,
                ...(stalledSince
                  ? { stalledSince: stalledSince.since, stalledWakes: stalledSince.wakes }
                  : {}),
              },
            }
          : {}),
        ...(override
          ? {
              override: {
                passes: `${holdNames(override.holds)} ${overrideSpan(override)}`,
                words: override.words,
              },
            }
          : {}),
        ...(allowed.length > 0
          ? { allowed: allowed.map((entry) => ({ card: entry.card, covers: entry.covers })) }
          : {}),
        ...(refused
          ? {
              cardRefused: {
                title: refused.title,
                at: new Date(refused.at).toISOString(),
                reason: refused.reason,
                why: refused.why,
              },
            }
          : {}),
        ...(delivery ? { delivery } : {}),
        ...(goesIn ? { goesIn } : {}),
        ...(ci ? { ci } : {}),
        // Autonomy answers "who merges this", so it is absent wherever
        // there is no merge: the personal workspace, and an answer task,
        // which the deliverable hold refuses to merge whoever asks. The
        // rigor above is absent on the same rows for the same reason.
        ...(repo?.kind === "personal" || deliverableOf(record) !== "change"
          ? {}
          : { autonomy: autonomyForRecord(record, repo?.autonomy) }),
      };
    });
  }

  /**
   * The durations a crew line reads rather than guesses (INF-1244): the
   * oldest job still running and its age, how long ago the crewmate last
   * reported, and the check-back its report named.
   */
  private timingFacts(record: TaskRecord): {
    words: Pick<CrewStatusEntry, "job" | "waiting" | "reported" | "checkBack">;
    times: NonNullable<CrewStatusEntry["times"]>;
  } {
    const now = this.core.now();
    const running =
      record.status === "active" &&
      (this.core.options.hasRunningJobs?.(record.id) === true ||
        this.core.starts.clientJobStart(record.id) !== undefined);
    const job = running ? this.core.starts.oldestJob(record.id) : undefined;
    const reportedAt =
      record.status === "active" ? this.core.options.tasks.lastReportAt(record.id) : undefined;
    const back = record.delivery?.checkBack;
    const waiting = record.status === "active" ? this.core.watch.namedWait(record.id) : undefined;
    const times: NonNullable<CrewStatusEntry["times"]> = {
      ...(job
        ? { jobSince: job.startedAt, job: cutText(job.command.replace(/\s+/g, " "), 80) }
        : {}),
      ...(waiting?.calls.length ? { calls: waiting.calls } : {}),
      ...(waiting?.steers
        ? { steersUnread: waiting.steers, steersSince: waiting.steersSince }
        : {}),
      ...(reportedAt !== undefined ? { reportedAt } : {}),
      ...(back ? { checkBackUntil: back.until, checkBackFor: back.waitingFor } : {}),
    };
    const words = {
      ...(job
        ? {
            job: `running ${formatDurationShort(now - job.startedAt)}: ${cutText(job.command.replace(/\s+/g, " "), 80)}`,
          }
        : {}),
      ...(waiting?.words ? { waiting: waiting.words } : {}),
      ...(reportedAt !== undefined
        ? { reported: `${formatDurationShort(now - reportedAt)} ago` }
        : {}),
      ...(back
        ? {
            checkBack:
              back.until > now
                ? `in ${formatDurationShort(back.until - now)}: ${back.waitingFor}`
                : `due ${formatDurationShort(now - back.until)} ago: ${back.waitingFor}`,
          }
        : {}),
    };
    return { words, times };
  }

  /**
   * The computer a task runs on, for the first mate (INF-992): the one its
   * place names, else this computer once it started here. Absent while no
   * computer that runs work is listed, and for an unstarted task whose
   * computer is not chosen yet.
   */
  private taskComputer(record: TaskRecord): string | undefined {
    if (!this.core.options.machines || this.core.options.machines.computers().length === 0)
      return undefined;
    const place = this.core.placement.taskPlace(record);
    if (place) return place.name;
    return record.status === "open" ? undefined : HERE.this;
  }

  private waitingOnBlockers(record: TaskRecord): string | undefined {
    const waiting = this.core.options.tasks.graph
      .blockers(record.id)
      .filter((blocker) => !TaskService.blockerCleared(blocker));
    return waiting.length > 0 ? blockedText(waiting) : undefined;
  }

  /**
   * Non-terminal tasks bound to a repo: the project-removal guard.
   * Queued rows count - their dispatch would land on a missing registration.
   */
  activeTasksOnRepo(
    repoId: string,
  ): { key: string; title: string; status: "planned" | "working" }[] {
    // The live set includes interrupted and idle tasks that can still resume.
    return this.core.options.tasks
      .listLive()
      .filter((record) => record.repoId === repoId)
      .map((record) => ({
        key: record.key,
        title: record.title,
        status: record.status === "open" ? ("planned" as const) : ("working" as const),
      }));
  }

  /** A task's delivery posture: the merge mode a settle resolves to, and the settle-facts strip. */
  taskDelivery(taskId: string): RepoDelivery | undefined {
    const record = this.core.options.tasks.get(taskId);
    if (!record) return undefined;
    const repo = record.repoId ? this.core.options.repos.get(record.repoId) : undefined;
    return deliveryForRecord(record, repo?.delivery);
  }

  /**
   * The crew counts, read as one projection like the presentation pass: each
   * active row's posture shares the rows, settings and sign-ins the others
   * read, rather than reading them again per row (INF-2342).
   */
  crewCounts(): CrewCounts {
    const tasks = this.core.options.tasks;
    const active = tasks.listActive();
    return tasks.readProjection(() => {
      const tally = crewTally();
      for (const record of active) tally.see(record, () => this.core.postures.workPosture(record));
      return tally.counts(tasks);
    }, active);
  }

  broadcastCrewCounts(): void {
    this.core.options.broadcastEvent({ type: "crew_counts", ...this.crewCounts() });
  }

  /** When the crewmate's running turn began; null while none runs (the Crewmate tab's clock). */
  turnStartedAt(taskId: string): number | null {
    const task = this.core.tasks.get(taskId);
    return task && task.turn.busy ? task.turnStartedAt : null;
  }
}

/**
 * Whether each account serves, read from the supervisor's options alone
 * (`CrewFacts.serveability`); the idle ladder is given it before the crew's
 * owners exist.
 */
export function serveabilityOf(options: CrewSupervisorOptions): AccountServeability | undefined {
  const here = options.serveability;
  const machines = options.machines;
  if (!here && !machines) return undefined;
  return {
    cutOff: (account) => machines?.cutOffOf(account) ?? here?.cutOff(account),
    providerName: (account) => {
      const place = machines?.accountPlace(account);
      return place
        ? `${place.provider} ${place.where}`
        : (here?.providerName(account) ?? "the provider");
    },
    known: (account) => machines?.knows(account) ?? true,
  };
}
