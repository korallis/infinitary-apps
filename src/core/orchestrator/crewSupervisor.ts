import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type Card,
  type CardMutation,
  isRoutineMergeCard,
  isStoryNote,
  mergeEffectOf,
} from "@shared/cards";
import type { ChangeReceipt } from "@shared/change";
import { readyPresentation } from "@shared/changePresentation";
import { isRepairAssessment } from "@shared/checkRepair";
import { waitingForMaintainers } from "@shared/contributions";
import type { CrewSpeed } from "@shared/crewSpeed";
import { computerForgeName } from "@shared/deviceSetup";
import { hasChangeRequests } from "@shared/forge";
import {
  validationAssignment,
  validationRevision,
  validationStateRevision,
} from "@shared/liveValidation";
import { compareSemver } from "@shared/semver";
import type { ServedWakeOrigin } from "@shared/servedFrame";
import {
  type EffectiveTaskPolicies,
  policyEditConsequences,
  type TaskPolicyEdits,
  taskPolicyEditsSchema,
} from "@shared/taskPolicies";
import { RIGOR_WORDS } from "@shared/vocabulary";
import { resolveFirstmateCardId } from "../pi/cardTool";
import { CREWMATE_TOOLS } from "../pi/crewmateTaskTools";
import type { PlacedHost } from "../placed/crewMachines";
import { CrewPrograms, ProgramRunner } from "../program/programRunner";
import { LOCAL_MACHINE_ID } from "../session/session";
import { bindTools, type EmittedCardInput } from "../session/tools";
import type { DuplicateResult } from "../storage/cardStore";
import { currentChange, currentReceipt, mergingClose } from "../storage/changeProjection";
import { FIRSTMATE_RECIPIENT } from "../storage/inboxStore";
import type { CompletionOffer, TaskRecord } from "../storage/taskRecords";
import { carryOnWords } from "../tasks/recordActivity";
import { TaskService } from "../tasks/taskService";
import { type AskEnding, askEndingOf } from "./askEnding";
import { BuildRows } from "./buildRows";
import { CaptainOverrides } from "./captainOverrides";
import { CardActions } from "./cardActions";
import { FIRSTMATE_CARD_PREFIX, type OwnCardWrite } from "./cardEmit";
import { CardService } from "./cardService";
import { CostLimits } from "./costLimits";
import { CrewBrief } from "./crewBrief";
import type { CrewCore } from "./crewCore";
import { CrewFacts, serveabilityOf } from "./crewFacts";
import { CrewmateCards } from "./crewmateCards";
import {
  type PlacementRecord,
  QUIT_SETTLE_MS,
  SUPERVISOR_STEER,
  type TaskRuntime,
} from "./crewRuntime";
import { CrewSessions } from "./crewSessions";
import { CrewSteer } from "./crewSteer";
import type { CrewSupervisorOptions, FirstmateHooks } from "./crewSupervisorOptions";
import { CrewToolHooks } from "./crewToolHooks";
import { CrewTurns, crewSignInCardId } from "./crewTurns";
import { CrewUpdates } from "./crewUpdates";
import { CrewWatch } from "./crewWatch";
import { mergeCardBehindWake } from "./deliveryWakes";
import { HoldRules } from "./holdRules";
import { premiumRetryPossible } from "./holds";
import { HostOps } from "./hostOps";
import { IdleLadder } from "./idleLadder";
import { InPlaceWork } from "./inPlaceWork";
import { TaskIntake } from "./intake";
import { IntegrationAsks } from "./integrationAsks";
import { renderReviewBrief } from "./intentBrief";
import { LoginMoves } from "./loginMoves";
import { mergeHold, standingAuthorization } from "./mergeAuthorization";
import { publicationRepo } from "./publicationRepo";
import { ReportIntake } from "./reportIntake";
import type { WakeOpenReview } from "./reportWakes";
import { RepositoryMoves } from "./repositoryMoves";
import { RestartWatch } from "./restartWatch";
import { Reviews } from "./reviews";
import { reworkHold } from "./reworkHold";
import { RuleNotes, type RuleNotesRules } from "./ruleNotes";
import { type MergeBehind, SettleFacts } from "./settleCardFacts";
import { createSettleOwners, type SettleOwners } from "./settleOwners";
import { contributionStatusLine, hasMergeLine, receiptMergedLine } from "./settleWords";
import { CrewStarts } from "./starts";
import { TaskMoves } from "./taskMoves";
import { TaskPlacement } from "./taskPlacement";
import type { TypedWake } from "./wakes";
import { WorkPostures } from "./workPosture";
import { deliverableOf, taskContributesUpstream } from "./workShape";

/**
 * Every fm-op excerpt the crew's owners write rides through capWithOverflow instead of a bare
 * slice (2026-09-04 captain decision): a crewmate's real report - or the
 * error, guidance, or job output standing in for one - is never just cut at
 * a fixed length. capWithOverflow's own MESSAGE_EXCERPT_LIMIT is the cap;
 * anything longer spills to a file and the excerpt carries a pointer.
 */

/**
 * The crew supervisor: task lifecycle, event fan-out, and card production.
 * Work starts only through intake.commission() - a deliberate Firstmate agent
 * decision via the spawn_crewmate tool - never directly from user input
 * (the loop inversion; docs/architecture.md section 2).
 *
 * Crewmate sessions are multi-turn: a completed turn leaves the task idle
 * and steerable rather than finished, so follow-ups continue the same
 * crewmate. The supervisor is the authoritative crew registry (the host
 * owns the fleet, not any agent's transcript); lifecycle events reach the
 * Firstmate agent through the hooks as [fm-op] inbox messages.
 *
 * It is the crew's composition root: it builds the owners that do the work
 * and the `CrewCore` they share, and keeps only the first mate's card
 * writes, the review facts, the policy changes and the placed entry points.
 */
export class CrewSupervisor {
  private readonly tasks = new Map<string, TaskRuntime>();

  /** The facts a settle card's task writes on the card: its fact strip and its follow-ups. */
  private readonly settleFacts: SettleFacts;
  /**
   * Every part a reworked merge card's hold reads is built (INF-6241): the
   * card stack restores before the watch's postures and the ladder exist,
   * so a card it restores is held for the read until then.
   */
  private holdReadable = false;
  /** The card stack: the open cards and every write to them. */
  readonly cards: CardService;
  /** How each captain's message ends (INF-1610, docs/task-capture.md "How a message ends"). */
  readonly askEnding: AskEnding;
  /** Settling and closing: land, merge-pr, discard, and every close's teardown. */
  readonly settling: SettleOwners;
  /** A crewmate's brief at dispatch, and the runbook facts its instructions are selected by. */
  private readonly briefs: CrewBrief;
  /** Independent reviews and repair assessments: their reads, verdicts and tasks. */
  private readonly reviews: Reviews;
  /** Where each task runs: its computer, the waits for it, and the words said of it. */
  readonly placement: TaskPlacement;
  /** A started task's moves: to another provider between turns, and to another computer at a safe pause. */
  readonly moves: TaskMoves;
  /** A started task's move to another login of its provider (docs/quota.md). */
  readonly loginMoves: LoginMoves;
  /** A started task with no commits of its own, moved to another repository of its project. */
  readonly repositoryMoves: RepositoryMoves;
  /** The captain's overrides of a soft hold: declared, withdrawn, and the words they cite. */
  readonly overrides: CaptainOverrides;
  /** The crew's pause and save while a computer is updated. */
  readonly updates: CrewUpdates;
  /** Each task's cost limit: the hold a task past it meets, and the captain's answer. */
  readonly costLimits: CostLimits;
  /** The crew a restart or an update cut, watched until each carries on or stops. */
  private readonly restarts: RestartWatch;
  /** A crewmate's own cards: its emit_card, the completion card the host finishes, and its refusals. */
  readonly crewmateCards: CrewmateCards;
  /** Integration calls held for the captain: their approval cards and what came of them. */
  readonly integrationAsks: IntegrationAsks;
  /** An unsafe data reader's Build rows: kept on its approval card, filed on the captain's click. */
  readonly buildRows: BuildRows;
  /** What a crewmate reports: its follow-ups, progress, report, responses and validation records. */
  readonly reportIntake: ReportIntake;
  /** The host's own work in a project's folder: its repairs, the start check and their close. */
  readonly inPlaceWork: InPlaceWork;
  /** How the crew takes in new work: commissions, plans, reviews and the task graph's links and drops. */
  readonly intake: TaskIntake;
  /** A crewmate's session and its conversation: opening, resuming, interrupting, stopping and letting go. */
  readonly sessions: CrewSessions;
  /** A crewmate's turn from its first prompt to its end, and what waits on its lane. */
  readonly turns: CrewTurns;
  /** Steering a crewmate: words kept on its lane, delivered into its turn or as the next one. */
  readonly steer: CrewSteer;
  /** Starting a task: its queued shape and brief, its dispatch, a start on request and again. */
  readonly starts: CrewStarts;
  /** The crew's watch: the boot sweep, the watchdog, the lane sweeps, quiet crewmates and the ready sweep. */
  readonly watch: CrewWatch;
  /** The captain's card actions: a button's effect, a reply under a card and a read's close. */
  readonly cardActions: CardActions;
  /** The host's own operations: a card's host operation, the record's and board's buttons and their doors. */
  readonly hostOps: HostOps;
  /** The crew's facts: crew status, the crew counts and the lane facts. */
  readonly facts: CrewFacts;
  /** What a crewmate's session calls back into: its tools' hooks and its session events. */
  readonly toolHooks: CrewToolHooks;
  /** The app is quitting: a turn that settles now is not the crew's to act on. */
  private disposed = false;
  private readonly now: () => number;
  private hooks: FirstmateHooks = { notifyOp: () => {}, retryConverse: () => {} };
  /** The idle ladder and the holds: the witnesses, the gate, the caps and the ready sweep. */
  private readonly ladder: IdleLadder;
  /** Each task's posture, and the wait facts read from the same snapshot. */
  readonly postures: WorkPostures;
  /** A started task's hold that an event ends sooner, through a one-run Automation rule (INF-5145). */
  readonly holdRules: HoldRules;
  private recoveredPendingSettles = false;
  /** Every running program (INF-799 piece 2, docs/programs.md). */
  private readonly programs: ProgramRunner;
  /** The crew's side of a running program: its parts, its asks, its bound and its end. */
  private readonly crewPrograms: CrewPrograms;
  private readonly stopAllowedLinks: () => void;
  /** A rule's notes as a file: bound once the Scheduler exists, which is built after the crew. */
  private ruleNotes: RuleNotes | undefined;

  constructor(private readonly options: CrewSupervisorOptions) {
    const now = options.now;
    this.now = now ? () => now() : () => Date.now();
    // The core and its owners exist before any leaf owner is built: building
    // one may already read a crew fact through them, as the card stack's
    // settle facts do. The leaf owners are read through the core once built.
    const supervisor = this;
    const core: CrewCore = {
      options,
      tasks: this.tasks,
      now: this.now,
      disposed: () => this.disposed,
      hooks: () => this.hooks,
      get sessions() {
        return sessions;
      },
      get turns() {
        return turns;
      },
      get steer() {
        return steer;
      },
      get starts() {
        return starts;
      },
      get watch() {
        return watch;
      },
      get cardActions() {
        return cardActions;
      },
      get hostOps() {
        return hostOps;
      },
      get facts() {
        return facts;
      },
      get toolHooks() {
        return toolHooks;
      },
      get briefs() {
        return supervisor.briefs;
      },
      get cards() {
        return supervisor.cards;
      },
      get crewmateCards() {
        return supervisor.crewmateCards;
      },
      get crewPrograms() {
        return supervisor.crewPrograms;
      },
      get inPlaceWork() {
        return supervisor.inPlaceWork;
      },
      get loginMoves() {
        return supervisor.loginMoves;
      },
      get intake() {
        return supervisor.intake;
      },
      get integrationAsks() {
        return supervisor.integrationAsks;
      },
      get buildRows() {
        return supervisor.buildRows;
      },
      get ladder() {
        return supervisor.ladder;
      },
      get moves() {
        return supervisor.moves;
      },
      get overrides() {
        return supervisor.overrides;
      },
      get placement() {
        return supervisor.placement;
      },
      get postures() {
        return supervisor.postures;
      },
      get programs() {
        return supervisor.programs;
      },
      get reportIntake() {
        return supervisor.reportIntake;
      },
      get restarts() {
        return supervisor.restarts;
      },
      get reviews() {
        return supervisor.reviews;
      },
      get settling() {
        return supervisor.settling;
      },
      get updates() {
        return supervisor.updates;
      },
      get costLimits() {
        return supervisor.costLimits;
      },
      ruleNotes: () => this.ruleNotes,
      bypassesSupervision: (taskId) => this.bypassesSupervision(taskId),
      closeCard: (cardId, actor, reason) => this.closeCard(cardId, actor, reason),
      openReviewOf: (builderId) => this.openReviewOf(builderId),
      policiesChanged: (taskId, edits, before) => this.policiesChanged(taskId, edits, before),
      refreshReview: (task) => this.refreshReview(task),
      reviewBuilderOf: (record) => this.reviewBuilderOf(record),
      reviewToReread: (builder) => this.reviewToReread(builder),
      routeCrewEvent: (taskId, wake, origin) => this.routeCrewEvent(taskId, wake, origin),
    };
    const sessions = new CrewSessions(core);
    const turns = new CrewTurns(core);
    const steer = new CrewSteer(core);
    const starts = new CrewStarts(core);
    const watch = new CrewWatch(core);
    const cardActions = new CardActions(core);
    const hostOps = new HostOps(core);
    const facts = new CrewFacts(core);
    const toolHooks = new CrewToolHooks(core);
    this.sessions = sessions;
    this.turns = turns;
    this.steer = steer;
    this.starts = starts;
    this.watch = watch;
    this.cardActions = cardActions;
    this.hostOps = hostOps;
    this.facts = facts;
    this.toolHooks = toolHooks;
    this.restarts = new RestartWatch(options, { now: this.now });
    this.costLimits = new CostLimits(options, {
      now: this.now,
      runtimes: () => this.tasks.values(),
      raiseCard: (card) => this.cards.put(card),
      takeDown: (id, resolution) => this.cards.takeDown(id, resolution),
      sweepTaskLane: (taskId, at) => this.watch.sweepTaskLane(taskId, at),
      sweepGates: (at) => this.watch.sweepGates(at),
      moveToBacklog: (taskId, source) => this.hostOps.moveToBacklog(taskId, source),
    });
    this.updates = new CrewUpdates(options, {
      now: this.now,
      restarts: this.restarts,
      disposed: () => this.disposed,
      runtimes: () => this.tasks.values(),
      machineOf: (taskId) => this.facts.machineOf(taskId),
      untilTurnOver: (task) => this.turns.untilTurnOver(task),
      sweepTaskLane: (taskId, at) => this.watch.sweepTaskLane(taskId, at),
      sweepGates: (at) => this.watch.sweepGates(at),
      broadcastCrewCounts: () => this.facts.broadcastCrewCounts(),
    });
    // A project moved: its tasks that have not started follow it (docs/helper.md, "Runs on").
    options.repos.onRunsOn?.((repo) => this.placement.projectMoved(repo));
    this.settleFacts = new SettleFacts(options, {
      now: this.now,
      taskDelivery: (taskId) => this.facts.taskDelivery(taskId),
      reviewOpen: (taskId) => this.openReviewOf(taskId) !== undefined,
    });
    this.cards = new CardService({
      now: this.now,
      tasks: options.tasks,
      cardStore: options.cardStore,
      syncCaptainGate: (taskId, at) => {
        this.ladder.syncCaptainGate(taskId, at);
        // A card about the task moved: a merge kept for the review's answers
        // looks again (INF-5396's audit, finding 2).
        if (standingAuthorization(options.tasks.get(taskId)?.delivery)?.waiting?.on === "questions")
          this.settling.locks.retryWhenFree(taskId);
      },
      closeAnsweredTask: (card, action, by, carried) =>
        this.settling.declared.closeAnsweredTask(card, action, by, carried),
      settleFacts: (taskId, part) => this.settleFacts.strip(taskId, part),
      mergeLabel: (card) => this.cardActions.merges.mergeLabel(card),
      mergeAnyway: (card) => this.cardActions.merges.mergeAnyway(card),
      mergeBehind: (card) => this.cardActions.merges.mergeBehind(card),
      mergeFellBehind: (cardId, behind) => this.mergeFellBehind(cardId, behind),
      holdsUntilMerge: (card) => this.holdsUntilMerge(card),
      reworkHold: (card) =>
        reworkHold(card, {
          tasks: options.tasks,
          cardStore: options.cardStore,
          readOwed: (record) => !this.holdReadable || this.watch.afterTurnReadOwed(record),
          jobRunning: (taskId) => this.holdReadable && this.ladder.jobInBound(taskId, this.now()),
          witnesses: (taskId) =>
            this.holdReadable ? this.ladder.witnesses(taskId, this.now()) : undefined,
          stuck: (taskId) => options.inbox.stuck(taskId) !== undefined,
          waitsForUpdate: (taskId) => this.updates.waitsForUpdateThere(taskId),
        }),
      readAfterTurn: (taskId) => {
        if (this.holdReadable) this.watch.readAfterTurn(taskId);
      },
      mergedLine: (card) => this.mergedLineOf(card),
      otherChangeOpen: (taskId) => this.otherChangeOpen(taskId),
      followupNotice: (taskId) => this.settleFacts.followupNotice(taskId),
      choiceUnheard: (card) => {
        const lane = card.id.startsWith(FIRSTMATE_CARD_PREFIX) ? FIRSTMATE_RECIPIENT : card.taskId;
        return lane !== undefined && options.inbox.holdsUndeliveredChoice(lane, card.id);
      },
      broadcastCrewCounts: () => this.facts.broadcastCrewCounts(),
      broadcastEvent: options.broadcastEvent,
      broadcastCards: options.broadcastCards,
      presentationChanged: options.presentationChanged,
      ...(options.broadcastThread ? { broadcastThread: options.broadcastThread } : {}),
      ...(options.build ? { build: options.build } : {}),
      captainResponded: (card, response, action) => {
        this.askEnding.captainResponded(card, response, action);
        this.hooks.asksMoved?.();
      },
      cardPlaced: () => this.hooks.cardPlaced?.(),
      checkCardResponse: (_taskId, response, card) =>
        this.reportIntake.checkCardResponse(response, card),
      submitCardResponse: (taskId, response, text, line) => {
        options.inbox.submitResponse(
          response,
          { task: taskId, session: this.tasks.get(taskId)?.session?.recordPath() ?? null },
          text,
          line,
        );
        queueMicrotask(() => this.hooks.pokeInbox?.());
      },
    });
    this.askEnding = askEndingOf(options.tasks, this.cards, (id) => options.inbox.requestOpen(id));
    this.placement = new TaskPlacement(options, {
      now: this.now,
      cards: this.cards,
      runtime: (taskId) => this.tasks.get(taskId),
      outOfReach: (taskId) => this.facts.outOfReach(taskId),
      reviewBuilderOf: (record) => this.reviewBuilderOf(record),
      dispatchQueuedTask: async (taskId) => {
        await this.starts.dispatchQueuedTask(taskId);
      },
      disposed: () => this.disposed,
    });
    this.moves = new TaskMoves(options, {
      now: this.now,
      placement: this.placement,
      runtime: (taskId) => this.tasks.get(taskId),
      releaseSession: (runtime) => this.sessions.releaseSession(runtime),
      forgetRuntime: (taskId) => this.tasks.delete(taskId),
      resumeTask: (taskId, move) => this.sessions.resumeTask(taskId, move),
      deliverPendingToTask: (task) => this.turns.deliverPendingToTask(task),
      deliverLane: (taskId) => this.watch.deliverLane(taskId),
      machineOf: (taskId) => this.facts.machineOf(taskId),
      isPersonalTask: (taskId) => this.facts.isPersonalTask(taskId),
      queuedShape: (record) => this.starts.queuedShape(record),
      clientJobStart: (taskId) => this.starts.clientJobStart(taskId),
      modelName: (model) => this.turns.modelName(model),
      beingUpdated: (deviceId) => this.updates.isUpdating(deviceId),
      clearSignInCard: (taskId) =>
        this.cards.hostCards.clearAuthDecisionCard(crewSignInCardId(taskId)),
      disposed: () => this.disposed,
      broadcastCrewCounts: () => this.facts.broadcastCrewCounts(),
    });
    this.loginMoves = new LoginMoves(options, {
      runtime: (taskId) => this.tasks.get(taskId),
      releaseSession: (runtime) => this.sessions.releaseSession(runtime),
      forgetRuntime: (taskId) => this.tasks.delete(taskId),
      resumeTask: (taskId) => this.sessions.resumeTask(taskId),
      deliverPendingToTask: (task, sent) =>
        this.turns.deliverPendingToTask(task, sent ? { sent: true } : undefined),
      deliverLane: (taskId) => this.watch.deliverLane(taskId),
      machineOf: (taskId) => this.facts.machineOf(taskId),
      laneHeld: (taskId) => this.facts.laneHeld(taskId),
      disposed: () => this.disposed,
    });
    const runbooks = options.runbooks;
    this.settling = createSettleOwners({
      now: this.now,
      tasks: options.tasks,
      inbox: options.inbox,
      workspace: options.workspace,
      repos: options.repos,
      cards: this.cards,
      askEnding: this.askEnding,
      asksMoved: () => this.hooks.asksMoved?.(),
      runtimeState: (taskId) => {
        const turn = this.tasks.get(taskId)?.turn;
        return !turn ? undefined : !turn.busy ? "idle" : turn.running ? "streaming" : "starting";
      },
      stopRuntime: (taskId) => this.sessions.stopRuntime(taskId),
      hasRunningJobs: (taskId) =>
        options.hasRunningJobs?.(taskId) === true ||
        this.starts.clientJobStart(taskId) !== undefined,
      announceReach: (taskId) => this.steer.announceReach(taskId),
      ...(options.killJobs ? { killJobs: options.killJobs } : {}),
      ...(options.leftovers ? { leftovers: options.leftovers } : {}),
      ...(options.step ? { step: options.step } : {}),
      ...(options.machines ? { placed: options.machines } : {}),
      endLiveTask: (taskId) => options.personal?.endLiveTask(taskId),
      ...(options.mergePullRequest ? { mergePullRequest: options.mergePullRequest } : {}),
      ...(options.removeQueuedApproval
        ? { removeQueuedApproval: options.removeQueuedApproval }
        : {}),
      ...(runbooks ? { namingRule: () => runbooks.naming() } : {}),
      ...(options.validateLocalStory ? { validateLocalStory: options.validateLocalStory } : {}),
      ...(options.mergeReview ? { mergeReview: options.mergeReview } : {}),
      mergeContinued: (taskId, review, outcome, named) => {
        if (outcome.ok) void this.watch.sweepGates(this.now());
        const still = this.options.tasks.get(taskId);
        if (!still || TaskService.isClosed(still)) return;
        // The required actions the app now asks the captain for on its own
        // cards (finishContinued), named by the words this task declared so
        // the crewmate asks none again (INF-5396).
        const asked = outcome.ok
          ? this.options.tasks
              .listWithRequirementFrom(taskId, [])
              .filter((row) => row.status === "open")
              .flatMap((row) =>
                (row.delivery?.captainAction?.requirements ?? [])
                  .filter((entry) => entry.source === taskId)
                  .map((entry) => ({ key: row.key, title: entry.action.title })),
              )
          : [];
        // A host result is not new captain guidance about the kept approval.
        void this.steer
          .steerInternal(
            taskId,
            {
              facts: {
                kind: "merge-continued",
                ok: outcome.ok,
                ...(outcome.stop === "outcome" ? { unknown: true } : {}),
                change: named
                  ? named
                  : review
                    ? `#${review.number}`
                    : still?.delivery?.prNumber !== undefined && outcome.stillOpen
                      ? `#${still.delivery.prNumber}`
                      : "the reviewed pull request",
                ...(outcome.receipt?.head || review?.headSha
                  ? { head: outcome.receipt?.head ?? review?.headSha }
                  : {}),
                ...(outcome.stillOpen ? { open: outcome.stillOpen } : {}),
                ...(asked.length > 0 ? { asked } : {}),
                text: outcome.text,
              },
              ...(outcome.ok && review ? { once: `merge-continued:${review.id}` } : {}),
            },
            SUPERVISOR_STEER,
          )
          .catch((caught: unknown) => {
            console.warn("[crew] merge continuation not delivered:", caught);
          });
      },
      ...(options.closePullRequest ? { closePullRequest: options.closePullRequest } : {}),
      ...(options.readPull ? { readPull: options.readPull } : {}),
      ...(options.mergedStory ? { mergedStory: options.mergedStory } : {}),
      assessRepair: (taskId) => this.reviews.assessRepair(taskId),
      fileFolderRepair: (merged, refusal) => this.inPlaceWork.fileFolderRepair(merged, refusal),
      folderMissing: (repoId, noticed, by) => this.inPlaceWork.folderMissing(repoId, noticed, by),
      filePullRepair: (abandoned, problem) => this.inPlaceWork.filePullRepair(abandoned, problem),
      isPersonalTask: (taskId) => this.facts.isPersonalTask(taskId),
      deliverableOf,
      taskDelivery: (taskId) => this.facts.taskDelivery(taskId),
      taskAutonomy: (taskId) => this.facts.taskAutonomy(taskId),
      resolveTaskRef: (ref, param) => this.intake.resolveTaskRef(ref, param),
      notifyOp: (wake, origin, ref) => this.hooks.notifyOp(wake, origin, ref),
      pokeInbox: () => this.hooks.pokeInbox?.(),
      sweepGates: (at) => this.watch.sweepGates(at),
      broadcastCrewCounts: () => this.facts.broadcastCrewCounts(),
      broadcastEvent: options.broadcastEvent,
    });
    const machines = options.machines;
    this.repositoryMoves = new RepositoryMoves(
      {
        now: this.now,
        tasks: options.tasks,
        workspace: options.workspace,
        stopRuntime: (taskId) => this.sessions.stopRuntime(taskId),
        ...(options.killJobs ? { killJobs: options.killJobs } : {}),
        endLiveTask: (taskId) => options.personal?.endLiveTask(taskId),
        ...(machines ? { placedStatus: (taskId: string) => machines.workStatus(taskId) } : {}),
        ...(machines?.retireMoved
          ? {
              retireThere: (deviceId: string, taskId: string) =>
                machines.retireMoved?.(deviceId, taskId) ?? Promise.resolve(),
            }
          : {}),
        moving: (taskId) => this.moves.isMoving(taskId),
        repoint: (taskId) => this.placement.runsOnChanged(taskId),
        sweepGates: (at) => this.watch.sweepGates(at),
      },
      this.settling.locks,
    );
    this.overrides = new CaptainOverrides(options, {
      now: this.now,
      cards: this.cards,
      settling: this.settling,
      syncCaptainGate: (taskId, at) => this.ladder.syncCaptainGate(taskId, at),
      runtime: (taskId) => this.tasks.get(taskId),
      sweepTaskLane: (taskId, at) => this.watch.sweepTaskLane(taskId, at),
    });
    // A task that now carries on earlier work reads that work's yeses too (INF-3170 piece 2).
    // The notice writes, so it runs after the change notification, never inside it.
    this.stopAllowedLinks = options.tasks.onChange(({ events }) => {
      const carriers = events
        .filter((event) => event.kind === "linked" && event.data?.type === "replaced-by")
        .map((event) => event.taskId);
      if (carriers.length > 0)
        queueMicrotask(() => {
          if (this.disposed) return;
          for (const taskId of carriers) this.overrides.allowedNoticed(taskId);
        });
    });
    this.briefs = new CrewBrief(options, {
      cards: this.cards,
      machineOf: (taskId) => this.facts.machineOf(taskId),
      deliverHandover: (taskId, path, name, sha256) =>
        this.sessions.deliverHandover(taskId, path, name, sha256),
      knowledgeFor: (taskId) => this.toolHooks.knowledgeFor(taskId),
      backendOf: (taskId) => this.tasks.get(taskId)?.backend,
      ruleNotesSection: (taskId) =>
        this.ruleNotes?.briefSection(taskId) ?? Promise.resolve(undefined),
    });
    this.reviews = new Reviews(options, {
      now: this.now,
      cards: this.cards,
      settling: this.settling,
      notifyOp: (wake, origin, ref) => this.hooks.notifyOp(wake, origin, ref),
      steer: (taskId, wake) => this.steer.steerInternal(taskId, wake, SUPERVISOR_STEER),
      startTask: (spec) => this.starts.startTask(spec),
      reviewBuilderOf: (record) => this.reviewBuilderOf(record),
    });
    this.crewmateCards = new CrewmateCards(options, {
      now: this.now,
      cards: this.cards,
      settling: this.settling,
      cardPlace: (taskId) => this.placement.cardPlace(taskId),
      taskDelivery: (taskId) => this.facts.taskDelivery(taskId),
      taskAutonomy: (taskId) => this.facts.taskAutonomy(taskId),
      isPersonalTask: (taskId) => this.facts.isPersonalTask(taskId),
      worksInPlace: (taskId) => this.facts.worksInPlace(taskId),
      mergeModeFor: (taskId) => this.cardActions.merges.mergeModeFor(taskId),
      machineOf: (taskId) => this.facts.machineOf(taskId),
      validationHead: (record) => this.reportIntake.validationHead(record),
      keepOffer: (taskId, offers, offer) => this.keepOffer(taskId, offers, offer),
    });
    this.integrationAsks = new IntegrationAsks(options, {
      cards: this.cards,
      notifyOp: (wake, origin, ref) => this.hooks.notifyOp(wake, origin, ref),
      steer: (taskId, wake) => this.steer.steerInternal(taskId, wake, SUPERVISOR_STEER),
    });
    this.buildRows = new BuildRows(options, {
      present: (taskId, ask, dropped) => {
        this.integrationAsks.askForge(taskId, ask, dropped);
      },
      startNow: (key) => this.starts.startQueuedNow(key, { audience: "captain" }),
      now: this.now,
    });
    this.reportIntake = new ReportIntake(options, {
      cards: this.cards,
      askEnding: this.askEnding,
      isPersonalTask: (taskId) => this.facts.isPersonalTask(taskId),
      personalFacts: () => this.facts.personalFacts(),
      taskDelivery: (taskId) => this.facts.taskDelivery(taskId),
      reviewBuilderOf: (record) => this.reviewBuilderOf(record),
      noteTaskActivity: (task) => this.watch.noteTaskActivity(task),
      pokeInbox: () => this.hooks.pokeInbox?.(),
      clientJobStart: (taskId) => this.starts.clientJobStart(taskId),
      broadcastCrewCounts: () => this.facts.broadcastCrewCounts(),
      relayedCaptainWords: (taskId, from) => this.overrides.relayedCaptainWords(taskId, from),
      relayWakesNow: (task) => this.turns.relayWakesNow(task),
    });
    this.inPlaceWork = new InPlaceWork(options, {
      now: this.now,
      cards: this.cards,
      settling: this.settling,
      runtime: (taskId) => this.tasks.get(taskId),
      steer: (taskId, message) => this.steer.steerInternal(taskId, message, SUPERVISOR_STEER),
      broadcastCrewCounts: () => this.facts.broadcastCrewCounts(),
      sweepGates: (at) => this.watch.sweepGates(at),
    });
    this.intake = new TaskIntake(options, {
      now: this.now,
      cards: this.cards,
      settling: this.settling,
      placement: this.placement,
      reviews: this.reviews,
      runtime: (taskId) => this.tasks.get(taskId),
      releaseSession: (runtime) => this.sessions.releaseSession(runtime),
      forgetRuntime: (taskId) => {
        this.tasks.delete(taskId);
      },
      recordInterrupt: (taskId, mode, source, effect) =>
        this.sessions.recordInterrupt(taskId, mode, source, effect),
      personalFacts: () => this.facts.personalFacts(),
      taskDelivery: (taskId) => this.facts.taskDelivery(taskId),
      openReviewOf: (builderId) => this.openReviewOf(builderId),
      startTask: (spec) => this.starts.startTask(spec),
      startBehind: (taskId, options) => this.starts.startBehind(taskId, options),
      startTaskBehind: (taskId, title, start, named) =>
        this.starts.startTaskBehind(taskId, title, start, named),
      announceReach: (taskId) => this.steer.announceReach(taskId),
      haltProgram: (programId) => this.programs.halt(programId),
      broadcastCrewCounts: () => this.facts.broadcastCrewCounts(),
      sweepGates: (at) => this.watch.sweepGates(at),
    });
    this.crewPrograms = new CrewPrograms(options, {
      now: this.now,
      settling: this.settling,
      resolveGraphPlacement: (input) => this.intake.resolveGraphPlacement(input),
      notifyOp: (wake, origin, taskId) => this.hooks.notifyOp(wake, origin, taskId),
      broadcastCrewCounts: () => this.facts.broadcastCrewCounts(),
      sweepGates: (at) => this.watch.sweepGates(at),
      steer: (taskId, wake) => this.steer.steerInternal(taskId, wake, SUPERVISOR_STEER),
    });
    this.programs = new ProgramRunner({
      tasks: options.tasks,
      spawner: options.programProcess,
      filePart: (program, part) => this.crewPrograms.fileProgramPart(program, part),
      closePart: (partId) => this.crewPrograms.closeProgramPart(partId),
      ask: (program, prompt, schema) => this.crewPrograms.programAsk(program, prompt, schema),
      finish: (program, end) => this.crewPrograms.finishProgram(program, end),
      bounded: (program, calls) => this.crewPrograms.programBounded(program, calls),
    });
    const serveability = serveabilityOf(options);
    this.holdRules = new HoldRules({
      tasks: options.tasks,
      endHold: (taskId, ruleId, events) => this.ladder.endHoldOnEvent(taskId, ruleId, events),
      endUpdateHold: (taskId, installed) =>
        this.ladder.endHoldOnEvent(taskId, undefined, installed),
    });
    this.ladder = new IdleLadder({
      now: this.now,
      tasks: options.tasks,
      inbox: options.inbox,
      runtime: (taskId) => this.tasks.get(taskId),
      hasRunningJobs: (taskId) =>
        options.hasRunningJobs?.(taskId) === true ||
        this.starts.clientJobStart(taskId) !== undefined,
      oldestRunningJob: (taskId) => this.starts.oldestJob(taskId),
      openCards: () => this.cards.values(),
      answerNoteForTask: (taskId) => this.cards.answerNoteForTask(taskId),
      threadsAwaitingAuthor: (taskId) => this.cards.threadsAwaitingAuthor(taskId),
      bypassesSupervision: (taskId) => this.bypassesSupervision(taskId),
      notifyOp: (wake, origin, taskId) => this.hooks.notifyOp(wake, origin, taskId),
      premiumCanServe: () => this.facts.premiumCanServe(),
      recordSort: (taskId, title, wake, verdict, reason, rule, effect) =>
        this.turns.recordSort(taskId, title, wake, verdict, reason, rule, effect),
      steer: (taskId, message) => this.steer.steerInternal(taskId, message, SUPERVISOR_STEER),
      raiseCard: (card) => this.cards.put(card),
      withdrawCard: (id, resolution) => this.cards.takeDown(id, resolution),
      answerOwed: (id) => this.cards.answerOwed(id),
      dispatchQueuedTask: (taskId) => this.starts.dispatchQueuedTask(taskId),
      ...(serveability ? { serveability } : {}),
      placedAccount: (deviceId, taskId) => options.machines?.accountOf(deviceId, taskId),
      outOfReach: (taskId) => this.facts.outOfReach(taskId),
      waitsForUpdate: (taskId) => this.updates.waitsForUpdateThere(taskId),
      deliverLane: (taskId) => this.watch.deliverLane(taskId),
      accountBack: (taskId) => this.cards.hostCards.clearAuthDecisionCard(crewSignInCardId(taskId)),
      ...(options.quotaGateCleared ? { quotaGateCleared: options.quotaGateCleared } : {}),
      heldOnItsLevel: (record) => this.starts.reasoning.heldOnItsLevel(record),
      wakeDeadGate: (record, dead) => this.starts.wakeDeadGate(record, dead),
      completeContainers: () => this.intake.completeContainers(),
      broadcastCrewCounts: () => this.facts.broadcastCrewCounts(),
      putOff: (taskId) => this.cards.putOffs.witness(taskId),
      putOffAwaits: (taskId) => this.cards.putOffs.awaits(taskId),
      cardPutOff: (cardId) => this.cards.putOffs.kept(cardId) !== undefined,
      putOffsOnTasks: () => this.cards.putOffs.onTasks(),
      ...(options.readCheckWatch || options.readRunWatch
        ? {
            checksWatched: (record: TaskRecord) =>
              record.delivery?.ciWatch !== undefined ||
              (record.delivery?.runWatches?.length ?? 0) > 0 ||
              waitingForMaintainers(record.delivery),
          }
        : {}),
      ...(options.browsers
        ? { browserWithCaptain: (taskId: string) => options.browsers?.withCaptain(taskId) === true }
        : {}),
    });
    this.postures = new WorkPostures(options, {
      now: this.now,
      witnesses: (taskId, at) => this.ladder.witnesses(taskId, at),
      heldBy: (record) => this.ladder.heldBy(record),
      runtime: (taskId) => this.tasks.get(taskId),
    });
    this.holdReadable = true;
    this.cards.recheckHeld("restart");
  }

  /**
   * A rule's notes reach the crewmates its runs start once the Scheduler,
   * built after the crew, is bound here (docs/automation.md, "A rule's notes").
   */
  bindRuleNotes(rules: RuleNotesRules): void {
    this.ruleNotes = new RuleNotes(this.options.tasks, rules, (taskId, path, name, sha256) =>
      this.sessions.deliverHandover(taskId, path, name, sha256),
    );
  }

  setFirstmateHooks(hooks: FirstmateHooks): void {
    this.hooks = hooks;
    if (this.recoveredPendingSettles) return;
    this.recoveredPendingSettles = true;
    // TaskService has already marked a turn left running by a dead process
    // interrupted. Resume the captain's durable intent only after the
    // Firstmate wake path is attached, so its eventual outcome is not lost.
    queueMicrotask(() => {
      // Recover a committed edit whose notice a quit prevented us from queuing.
      for (const record of this.options.tasks.listLive()) {
        const revision = record.shape?.policies?.revision;
        if (!revision) continue;
        const event = this.options.tasks.timeline(record.id).findLast((entry) => {
          const changes = entry.data?.changes;
          return changes && typeof changes === "object" && "policies" in changes;
        });
        const changes = event?.data?.changes as { policies?: unknown } | undefined;
        const edits = taskPolicyEditsSchema.safeParse(changes?.policies);
        if (edits.success) this.policiesChanged(record.id, edits.data);
      }
      this.settling.settle.resumePendingSettles();
      this.settling.kept.resumeMergeAuthorizations();
    });
  }

  /**
   * Run the cut-off watch now (`IdleLadder.checkCutOffs`): the vault just
   * recorded or cleared a cut-off, or a computer that runs work said
   * something new of its own sign-ins, so the Firstmate hears it and a held
   * lane goes on without waiting for the tick.
   */
  reconcileCutOffs(): void {
    this.hostOps.resumePendingStarts();
    this.placement.reconcileStartChecks();
    this.ladder.checkCutOffs();
  }

  /**
   * Whether the first mate's emit_card names a card that is not its own -
   * someone else's open or closed card, or a card id the record lacks -
   * so the write is a contribution (docs/card-threads.md, "Shared cards").
   */
  writesOnOthersCard(id: string | undefined): boolean {
    const target = this.cards.targetOf({ actor: "firstmate" }, id);
    return target.kind !== "new" && target.kind !== "own";
  }

  /**
   * The first mate's write on someone else's card, typed; undefined when the
   * card is its own or new, which `addFirstmateCard` shows.
   */
  contributeAsFirstmate(input: EmittedCardInput): CardMutation | undefined {
    if (!this.writesOnOthersCard(input.id)) return undefined;
    return this.cards.contribute({ actor: "firstmate" }, input, {
      ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
      ...(input.contributionReason ? { reason: input.contributionReason } : {}),
      ...(input.operationId ? { operationId: input.operationId } : {}),
      ...(input.answersMessage !== undefined ? { answersMessage: input.answersMessage } : {}),
    });
  }

  addFirstmateCard(input: EmittedCardInput, written?: OwnCardWrite): string {
    if (input.requiredActions !== undefined) {
      const priorSource = input.id
        ? this.options.tasks.capture.taskForCard(resolveFirstmateCardId(input.id))
        : undefined;
      this.options.tasks.delivery.validateRequiredActions(
        input.taskId ?? priorSource?.id ?? "",
        input.requiredActions,
      );
    }
    const id = this.cards.addFirstmateCard(input, written);
    const offer = this.cards.get(id);
    if (
      input.taskId &&
      input.actions.some((action) => {
        const merge = mergeEffectOf(action);
        return merge !== undefined && !merge.review;
      })
    )
      this.bindFirstmateOffer(input.taskId, id);
    if (input.requiredActions !== undefined && input.taskId && offer?.offerId) {
      const merges = input.actions.some((action) => mergeEffectOf(action));
      this.options.tasks.delivery.declareRequiredActions(
        input.taskId,
        {
          cardId: id,
          offerId: offer.offerId,
          head: this.options.tasks.get(input.taskId)?.delivery?.headSha,
          actions: input.requiredActions,
        },
        !merges,
      );
      void this.watch.sweepGates(this.now());
    }
    return id;
  }

  /**
   * A first mate merge card on a task with a saved story carries that story
   * (INF-2490, lifting INF-1364): the host binds the card's offer to the
   * published story, so its click passes the same gate a crewmate's
   * completion card does and the merge reads the same story. The offer names
   * no pull request, so the click approves no head and is one attempt.
   */
  private bindFirstmateOffer(taskId: string, cardId: string): void {
    const record = this.options.tasks.get(taskId);
    const ready = readyPresentation(record?.delivery?.presentation);
    const offerId = this.cards.get(cardId)?.offerId;
    const shownFor = record ? currentChange(record.delivery, record.branch).number : undefined;
    const head = ready?.head ?? record?.delivery?.headSha;
    if (!record || !offerId || !head || (!ready && shownFor === undefined)) return;
    this.keepOffer(taskId, record.delivery?.completionOffers ?? [], {
      cardId,
      offerId,
      headSha: head,
      // The change it was shown for (INF-2490): its click refuses once another is current.
      ...(shownFor === undefined ? {} : { shownFor }),
      ...(ready
        ? { presentationRevision: ready.revision, presentationContentHash: ready.contentHash }
        : {}),
      at: this.now(),
    });
  }

  /**
   * One card's completion offer (INF-2490), replacing that card's earlier
   * entry. The list keeps its four newest entries and the current offer of
   * every card still open, so an open card never loses the change it was
   * shown for, which its click is checked against.
   */
  private keepOffer(
    taskId: string,
    offers: readonly CompletionOffer[],
    offer: CompletionOffer,
  ): void {
    const previous = offers.find(
      (entry) => entry.cardId === offer.cardId && entry.offerId === offer.offerId,
    );
    const record = this.options.tasks.get(taskId);
    const repoId = record?.delivery?.checkTarget?.repoId ?? record?.repoId;
    const repo = repoId ? this.options.repos.get(repoId) : undefined;
    const story = record?.delivery?.presentation?.revisions.at(-1);
    const origin =
      record && repo && hasChangeRequests(repo.host?.kind)
        ? publicationRepo(record, repo).origin
        : offer.presentationRevision !== undefined &&
            story &&
            "kind" in story.destination &&
            story.destination.kind === "branch"
          ? story.destination.origin
          : undefined;
    const destination = previous
      ? previous.destination
      : origin && repoId && record
        ? { repoId, origin, branch: currentChange(record.delivery, record.branch).branch }
        : undefined;
    offer = { ...offer, destination, ...(previous?.retired ? { retired: true } : {}) };
    const all = [
      ...offers.filter((entry) => entry.cardId !== offer.cardId || entry.offerId !== offer.offerId),
      offer,
    ];
    this.options.tasks.delivery.recordPermissionRecords(taskId, {
      completionOffers: all.filter(
        (entry, index) =>
          index >= all.length - 4 || this.cards.get(entry.cardId)?.offerId === entry.offerId,
      ),
    });
  }

  declareStandaloneRequiredActions(input: EmittedCardInput, cardId: string): void {
    if (input.taskId || input.requiredActions === undefined) return;
    const source = this.options.tasks.capture.taskForCard(cardId);
    const card = this.cards.get(cardId);
    if (!source || !card?.offerId) throw new Error("Required actions have no source record.");
    this.options.tasks.delivery.declareRequiredActions(
      source.id,
      { cardId, offerId: card.offerId, actions: input.requiredActions },
      true,
    );
    void this.watch.sweepGates(this.now());
  }

  /** An emitter withdraws its own card (close_card). */
  closeCard(
    cardId: string,
    actor: { kind: "firstmate" } | { kind: "crewmate"; taskId: string },
    reason?: string,
  ): string {
    // A decision its crewmate withdraws ends with none of its actions
    // chosen; the turn's report wake names it (INF-2828). close throws on
    // every refusal, so a returned close withdrew this card.
    const author = actor.kind === "crewmate" ? actor.taskId : undefined;
    const card = author ? this.cards.get(cardId.trim()) : undefined;
    const result = this.cards.close(cardId, actor, reason);
    if (author && card && card.actions.length > 0)
      this.tasks.get(author)?.withdrawnThisTurn.push({
        id: card.id,
        title: this.cards.threads.servedCardLine(card, card.title),
      });
    // Withdrawal can leave a message without its answering offer. Re-read
    // coverage through the existing sweep, never a captain acknowledgement.
    this.hooks.asksMoved?.();
    return result;
  }

  /** Called only from the authenticated connection's fresh hello, not cached device reads. */
  observeRequiredActionDevice(
    deviceId: string,
    version: { app?: string; takesWork: boolean },
  ): void {
    if (!version.app || !version.takesWork) return;
    for (const record of this.options.tasks.listOpen()) {
      const action = record.delivery?.captainAction;
      if (!action || !this.options.tasks.delivery.captainActionReady(record.id)) continue;
      const matches = action.requirements.every(({ action: requirement }) => {
        const criterion = requirement.completion;
        if (criterion.kind !== "device-version" || criterion.deviceId !== deviceId) return false;
        const order = compareSemver(version.app as string, criterion.minVersion);
        return order !== null && order >= 0;
      });
      if (
        matches &&
        this.options.tasks.delivery.completeCaptainAction(record.id, action.generation, "checked")
      )
        this.cards.retireTaskCards(record.id, "answered");
    }
    void this.watch.sweepGates(this.now());
  }

  flagDuplicate(input: { cardId: string; duplicateOf: string; note: string }): DuplicateResult {
    const card = this.cards.shown(input.cardId);
    const result = this.cards.flagDuplicate(input);
    // A duplicate closure notifies the live author, as an ordinary read
    // does, but without the ordinary-read acknowledgement (INF-759).
    if (result.status === "flagged" && card)
      this.cardActions.tellCardClosed(card, {
        id: result.original.id,
        title: result.original.title,
      });
    return result;
  }

  /**
   * The one router for crew lifecycle events: the event type is a property
   * of the call site, so sorting has always been code here. Since S7c
   * (captain call C7 A) there is no second reader behind it - a failed
   * turn, a quiet turn, the wall-clock bound, a start or start failure all
   * reach the Firstmate directly, which is exactly what this did whenever
   * the retired supervision session could not take them. A crewmate's
   * REPORT does not come through here: `sortReport` answers whose turn it
   * is first (`reportSort.ts`).
   */
  private routeCrewEvent(
    taskId: string,
    wake: TypedWake,
    origin: ServedWakeOrigin,
  ): number | null | void {
    return this.hooks.notifyOp(wake, origin, taskId);
  }

  /**
   * The live review task of a builder, if one is open (delivery rigor phase
   * 2). A repair assessment (FI3-663) is not its review.
   */
  private openReviewOf(builderId: string): TaskRecord | undefined {
    return this.options.tasks.graph
      .openChildren(builderId)
      .find(
        (record) =>
          !TaskService.isClosed(record) &&
          record.shape?.kind === "review" &&
          !isRepairAssessment(record.shape),
      );
  }

  /**
   * A builder's open review whose last verdict - recorded from that very
   * review - was findings or blocked, while no cap holds its re-reviews:
   * the builder's next report may bring the head it re-reviews.
   */
  private reviewToReread(builder: TaskRecord): WakeOpenReview | undefined {
    const verdict = builder.delivery?.reviewVerdict;
    if (verdict !== "findings" && verdict !== "blocked") return undefined;
    const open = this.openReviewOf(builder.id);
    if (!open || this.options.tasks.graph.verdictReviewOf(builder)?.id !== open.id)
      return undefined;
    const head = builder.delivery?.reviewSha;
    return {
      key: open.key || open.id,
      verdict,
      ...(head ? { head } : {}),
      ...(builder.delivery?.liveValidation
        ? {
            evidenceRevision: open.delivery?.validationAssignment?.revision ?? 0,
            currentEvidenceRevision: validationRevision(builder.delivery.liveValidation),
            stateRevision: open.delivery?.validationAssignment?.stateRevision ?? 0,
            currentStateRevision: validationStateRevision(builder.delivery.liveValidation),
          }
        : {}),
    };
  }

  /** The builder a review task reads: its parent, the one stored join. */
  private reviewBuilderOf(record: PlacementRecord | undefined): TaskRecord | undefined {
    if (record?.shape?.kind !== "review" || isRepairAssessment(record.shape) || !record.parentId)
      return undefined;
    return this.options.tasks.get(record.parentId);
  }

  /** Refresh only between review turns; never move a checkout under a running reviewer. */
  private async refreshReview(task: TaskRuntime): Promise<string | undefined> {
    const review = this.options.tasks.get(task.id);
    const builder = this.reviewBuilderOf(review);
    if (!review || !builder) return undefined;
    if ((review.deviceId ?? null) !== (builder.deviceId ?? null))
      throw new Error(
        "This review started on another computer. Close it and commission a new review on the builder's computer.",
      );
    // The first assignment is already prepared and briefed at commission.
    // Keep it through retries while the builder's head is still that one;
    // a turn after a first turn that ended with no report, such as a
    // provider failure, takes the builder's newer commit like any later
    // turn (INF-3141). A head that cannot be read then keeps the prepared one.
    const firstAssignment = Boolean(review.delivery?.headSha && !review.outcome);
    const facts = await this.reviews.reviewFacts(builder).catch((caught: unknown) => {
      if (firstAssignment) return undefined;
      throw caught;
    });
    if (!facts || (firstAssignment && facts.headSha === review.delivery?.headSha)) return undefined;
    this.options.tasks.delivery.recordChangeEvidence(review.id, {
      validationAssignment: validationAssignment(builder.delivery?.liveValidation, facts.headSha),
    });
    const previousHead = review.delivery?.headSha;
    if (!review.intent) throw new Error("The review has no recorded brief to refresh.");
    if (facts.headSha !== previousHead) {
      const base = {
        task: builder.id,
        headSha: facts.headSha,
        ...(previousHead ? { previousHead } : {}),
      };
      if (review.deviceId) {
        await this.options.machines?.prepare(review.deviceId, review.id, review.repoId, base);
      } else {
        task.workspace = await this.options.workspace.createTaskWorktree(
          review.id,
          review.repoDir,
          base,
          undefined,
          review.branch || undefined,
        );
      }
      this.options.tasks.delivery.recordChangeEvidence(
        review.id,
        {
          headSha: facts.headSha,
          ...(facts.changeReading
            ? { reviewChange: facts.changeReading }
            : { reviewChange: undefined }),
        },
        {
          kind: "review",
          text: `review assigned at ${facts.headSha.slice(0, 7)}`,
          feed: false,
        },
      );
    }
    // The scope set at commission holds for every turn (INF-401).
    const passedHead = review.delivery?.passedHead;
    const brief = renderReviewBrief(
      review.intent,
      this.facts.taskDelivery(builder.id) ?? "local-only",
      passedHead ? { ...facts, passedHead } : facts,
    );
    // Re-send the assignment even when the head stayed put: a previous
    // prompt may have failed after preparation but before the model read it.
    return brief;
  }

  private bypassesSupervision(taskId: string): boolean {
    return this.options.tasks.get(taskId)?.shape?.kind === "review";
  }

  /**
   * A merge card behind its change (INF-4031): a crewmate's card is redrawn
   * at its newest story once that story is ready at the current version;
   * otherwise its author hears it once per card and version, and
   * show_merge_card revises the card. A first mate card is never redrawn,
   * since its words are its own. A newer story at the same version is only
   * redrawn: the click it keeps needs no one woken.
   */
  private mergeFellBehind(cardId: string, behind: MergeBehind): void {
    const card = this.cards.get(cardId);
    const record = card?.taskId ? this.options.tasks.get(card.taskId) : undefined;
    if (!card || !record || TaskService.isClosed(record)) return;
    const crewmate = !card.id.startsWith(FIRSTMATE_CARD_PREFIX);
    const tell = () => {
      if (behind.why === "story") return;
      const wake = mergeCardBehindWake(card, record, behind, crewmate ? "crewmate" : "firstmate");
      // A task that merged or closed meanwhile takes no wake: its card goes with it.
      if (crewmate)
        void this.steer.steerInternal(record.id, wake, SUPERVISOR_STEER).catch(() => undefined);
      else this.hooks.notifyOp(wake, "agent", record.id);
    };
    const runtime = crewmate ? this.tasks.get(record.id) : undefined;
    if (!runtime || !this.crewmateCards.redrawBehind(runtime, card, behind, tell)) tell();
  }

  /**
   * Whether a story note stays off the stack until its task's merge has a
   * result (INF-2533): a task that merges on its own, open, with a saved
   * story, whose change has not merged.
   */
  private holdsUntilMerge(card: Card): boolean {
    if (!card.taskId || !isStoryNote(card)) return false;
    const record = this.options.tasks.get(card.taskId);
    if (!record || TaskService.isClosed(record) || !record.delivery?.presentation) return false;
    if (
      taskContributesUpstream(
        record,
        record.repoId ? this.options.repos.get(record.repoId) : undefined,
      )
    )
      return false;
    if (!this.facts.taskAutonomy(record.id)) return false;
    return mergeOf(record, card) === undefined;
  }

  /** The close each closed task recorded, by task and close time (`mergedLineOf`). */
  private readonly closes = new Map<string, { actor?: string; sentence?: string }>();

  /**
   * A story note's merge line once its change's receipt says merged
   * (INF-2678): the card stack draws it whenever the task's record changes.
   * The close that merged adds who closed it and the first mate's closing
   * sentence; a merge that kept the task open says the task continued.
   */
  private mergedLineOf(card: Card): string | undefined {
    if (!card.taskId || !isStoryNote(card) || !hasMergeLine(card.body)) return undefined;
    const record = this.options.tasks.get(card.taskId);
    if (
      taskContributesUpstream(
        record,
        record?.repoId ? this.options.repos.get(record.repoId) : undefined,
      ) &&
      (record?.delivery?.ci === "merged" ||
        record?.delivery?.contributionState?.state === "merged" ||
        record?.delivery?.contributionState?.state === "closed")
    )
      return contributionStatusLine(record);
    const merge = record ? mergeOf(record, card) : undefined;
    if (!record || merge?.at == null) return undefined;
    // Only the close that merged adds to the line: a merge that kept its
    // task open still says so after a later close that merged nothing.
    let close: { actor?: string; sentence?: string } | undefined;
    if (TaskService.isClosed(record) && mergingClose(record.closedReason)) {
      const key = `${record.id}:${record.closedAt}`;
      close = this.closes.get(key);
      if (!close) {
        const event = this.options.tasks
          .timeline(record.id)
          .findLast(
            (item) =>
              item.data?.status === record.status && item.data?.reason === record.closedReason,
          );
        const sentence = event?.data?.closingSentence;
        close = {
          ...(event?.actor ? { actor: event.actor } : {}),
          ...(typeof sentence === "string" ? { sentence } : {}),
        };
        this.closes.set(key, close);
      }
    }
    return receiptMergedLine(record, { ...merge, at: merge.at }, close);
  }

  /**
   * Another pull request the task's record keeps that has not ended,
   * besides its current one (INF-2525): its merge card's line reads it.
   */
  private otherChangeOpen(taskId: string): boolean {
    const current = this.options.tasks.get(taskId)?.delivery?.prNumber;
    return this.options.tasks
      .changesFor(taskId)
      .some(
        (change) =>
          change.handle?.number !== undefined &&
          change.handle.number !== current &&
          !change.receipt,
      );
  }

  /** Called after the atomic record edit; never dispatches or restarts work. */
  policiesChanged(
    taskId: string,
    edits: TaskPolicyEdits,
    before?: EffectiveTaskPolicies | null,
  ): string {
    const record = this.options.tasks.get(taskId);
    const policies = this.options.tasks.policiesOf(record);
    if (!record || !policies) return "";
    const guidance = this.briefs.addedGuidance(taskId, before, policies);
    if (guidance.length > 0) this.briefs.noteAddedWakes(taskId, before, policies);
    const wake: TypedWake = {
      facts: {
        kind: "task-policies-changed",
        task: { id: taskId, key: record.key, title: record.title },
        policies,
        ...(guidance.length > 0 ? { guidance } : {}),
      },
    };
    this.options.inbox.enqueueSteerOnce(taskId, {
      ...wake,
      once: `task-policies:${policies.revision}`,
    });
    // A change that cancels unsent merges ends a merge waiting for the
    // turn's end, whose intent the edit cleared, and the task's other kept
    // approvals too, and its crewmate hears which (INF-2746).
    if (
      edits.delivery !== undefined ||
      (edits.autonomy !== undefined && !policies.autonomy.value)
    ) {
      this.settling.locks.cancelWait(taskId, "how it merges changed");
      const ended = record.delivery?.mergeAuthorization;
      if (ended && ended.status !== "standing")
        this.settling.approvals.dropQueued(taskId, ended, "the task's policy changed");
    }
    // A native running turn hears the change now. Other sessions keep it on
    // their durable lane until work next continues, including after a quit.
    const runtime = this.tasks.get(taskId);
    if (runtime?.turn.running) void this.watch.sweepTaskLane(taskId, this.now());
    if (edits.autonomy !== undefined && policies.autonomy.value && !mergeHold(record.delivery)) {
      // The app merges from the task's open merge cards itself (INF-2744),
      // through the same gate as a card that goes up under autonomy; the
      // first mate is not woken for it.
      const released = this.crewmateCards.mergeOpenCards(taskId);
      if (
        record.delivery?.captainWait?.cardId &&
        released.includes(record.delivery.captainWait.cardId)
      ) {
        this.options.tasks.delivery.clearCaptainWait(taskId);
      }
      this.ladder.syncCaptainGate(taskId, this.now());
    }
    // Care that rises asks for more before a merge, so the merge card
    // offered at the old care comes down rather than leave a Merge that
    // now fails (INF-562); the crewmate brings a new one after the work
    // the new care needs. However the captain asked: words or the card.
    const rank = { quick: 0, standard: 1, reviewed: 2 } as const;
    if (before && rank[policies.rigor.value] > rank[before.rigor.value]) {
      for (const card of this.cards.values()) {
        if (card.taskId !== taskId || !isRoutineMergeCard(card)) continue;
        this.cards.takeDown(
          card.id,
          `The captain made this task ${RIGOR_WORDS[policies.rigor.value]}.`,
        );
        if (record.delivery?.captainWait?.cardId === card.id)
          this.options.tasks.delivery.clearCaptainWait(taskId);
      }
      this.ladder.syncCaptainGate(taskId, this.now());
    }
    this.facts.broadcastCrewCounts();
    return policyEditConsequences({
      edits,
      now: policies,
      before,
      mergeSent: this.settling.locks.mergeWasSent(taskId),
    });
  }

  /**
   * update_task withdraw_merge (FI3-304 section 6): the captain takes back
   * a merge he clicked. The work stays where it is; the task's merge is
   * his again, past project autonomy, until he clicks a new completion card.
   */
  withdrawMergeApproval(taskId: string): { ok: boolean; text: string } {
    const record = this.options.tasks.get(taskId);
    if (!record) throw new Error(`Unknown task "${taskId}".`);
    const handle = `${record.key || record.id} "${record.title}"`;
    const ended = this.settling.approvals.endAuthorization(
      taskId,
      "revoked",
      "the captain withdrew it",
      {
        holds: true,
        feed: true,
      },
    );
    if (ended) this.steer.announceReach(taskId);
    return ended
      ? {
          ok: true,
          text: `Withdrew the captain's kept merge approval on ${handle}. Its work stays; only their new merge click merges it.`,
        }
      : { ok: false, text: `${handle} has no kept merge approval to withdraw.` };
  }

  escalationEligible(taskId: string): boolean {
    const task = this.options.tasks.resolve(taskId);
    return task ? premiumRetryPossible(task) : true;
  }

  noteUnsupportedSpeed(taskId: string, requested: CrewSpeed): void {
    const model = this.tasks.get(taskId)?.session?.modelRef();
    if (requested !== "standard" && model && model.provider !== "openai-codex")
      this.toolHooks.noteSpeed(taskId, model, {
        requested,
        sent: "standard",
        reason: "this is not a Codex model",
      });
  }

  /**
   * A task that runs on a computer that runs work, whose conversation no
   * crewmate here holds - this Mac restarted, and that computer runs its
   * turn or asks about it first - opens here now (src/core/placed/).
   */
  async adoptPlaced(taskId: string): Promise<void> {
    if (this.tasks.get(taskId)?.session) return;
    const record = this.options.tasks.get(taskId);
    if (!record?.deviceId || !TaskService.isResumable(record))
      throw new Error(`Task ${taskId} does not run on another computer.`);
    await this.sessions.resumeTask(taskId);
  }

  /**
   * A task's conversation opened again on the computer that runs it, after
   * that computer restarted (src/core/placed/), in the session this crewmate
   * holds: one that started over there is carried into its new
   * conversation as an open carries it, before its lane goes on.
   */
  placedReopened(taskId: string): void {
    // What it holds there now took words: nothing there is refused any more.
    this.moves.openedThere(taskId);
    const task = this.tasks.get(taskId);
    if (task?.session) {
      // The conversation there may have started over, or folded while that
      // computer could not say so, under the session held here: its next
      // turn is told the project's directions again (`crewDirections.ts`).
      task.directions = undefined;
      if (task.turn.busy && !this.restarts.observing(taskId)) {
        this.restarts.observe(taskId);
        this.restarts.recordRestartOutcome(
          taskId,
          "waiting",
          "its computer reopened and has not confirmed a new request yet",
        );
        this.options.broadcastEvent({
          type: "firstmate_note",
          text: carryOnWords([{ key: task.key, title: task.title }]),
        });
      }
      this.sessions.carryRestart(task, this.facts.machineOf(taskId), task.session);
    }
  }

  /**
   * The model a conversation opening again on `machine` - after that
   * computer restarted, or a turn ended that an open found running there -
   * asks for, when the one it had left every level: routed again among
   * that computer's models, with the move recorded only once a
   * conversation opened on it (`TaskMoves.routeAgainIfLeft`), "wait" when
   * none can take it and "stale" when the task is no longer that
   * computer's. Undefined keeps the one it opened with.
   */
  reopenModel(
    taskId: string,
    machine: string,
    attach: boolean,
  ): ReturnType<NonNullable<PlacedHost["reopenModel"]>> {
    // Answered at once when nothing can have left, so a reopen that keeps
    // its model sends its open as soon as it would have without routing.
    if (!this.moves.mayRouteAgain(taskId)) return undefined;
    return this.moves.routeAgainIfLeft(taskId, { machine, attach }).then((routed) => {
      if (!routed || routed === "wait" || routed === "stale") return routed;
      return {
        model: routed.model,
        ...(routed.binding ? { accountId: routed.binding } : {}),
        thinking: { level: routed.thinkingLevel, ...(routed.quick ? { quick: true } : {}) },
        commit: routed.commit,
        passOver: routed.passOver,
      };
    });
  }

  /**
   * A task's conversation did not open again on its computer in the
   * session this crewmate holds (`PlacedHost.letGo`): the crewmate lets it
   * go, so its next turn opens a new one by the ordinary resume, once a
   * turn it was in has ended.
   */
  placedLetGo(taskId: string, held?: TaskRuntime, now?: boolean): void {
    const task = this.tasks.get(taskId);
    if (!task || task.turn.closing || (held && task !== held)) return;
    // A turn still out ends first through its own end - taken, failed or
    // given back to the lane - so none of its rows is lost with the session;
    // it goes as that turn ends, before words given back start another on it.
    // Asked to go only now, it stays held instead.
    if (task.turn.busy) {
      if (!now) this.turns.atTurnOver(task, () => this.placedLetGo(taskId, task));
      return;
    }
    this.sessions.releaseSession(task);
    this.tasks.delete(taskId);
    this.facts.broadcastCrewCounts();
    // Words its turn gave back unspent go to the conversation the task opens next.
    void this.watch.sweepTaskLane(taskId, this.now());
  }

  /**
   * The tool names this task's crewmate binds now. Read at a reopen, so a
   * computer that restarted on a newer contract is given a version-gated
   * tool the conversation opened without.
   */
  toolsNow(taskId: string): readonly string[] | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    const personal = this.facts.isPersonalTask(taskId) ? this.options.personal : undefined;
    return bindTools(CREWMATE_TOOLS, this.toolHooks.crewmateHooks(task, personal)).map(
      (tool) => tool.name,
    );
  }

  /**
   * These tasks' computer is in reach again and caught up: what waited on
   * their lanes goes now, and a start that waited for it may start.
   */
  placedCaughtUp(taskIds: readonly string[]): void {
    for (const taskId of taskIds) {
      if (this.options.tasks.get(taskId)?.status !== "active") continue;
      // Rows a restart here left in flight that no turn there took: the
      // computer never started them, so they go again.
      const holding = new Set(this.tasks.get(taskId)?.turn.rows ?? []);
      const stranded = this.options.inbox
        .inFlight(taskId)
        .filter((row) => !holding.has(row.id))
        .map((row) => row.id);
      this.options.inbox.reparkUndelivered(stranded);
      void this.watch.sweepTaskLane(taskId, this.now());
    }
    void this.watch.sweepGates(this.now());
    this.facts.broadcastCrewCounts();
  }

  /** Resume work paused by a typed askpass/auth refusal once that host's sign-in is ready. */
  async resumeForgeSignInTasks(host: string): Promise<void> {
    const ref = `forge-sign-in:${host}`;
    for (const record of this.options.tasks.listOpen()) {
      if (record.kind !== "work" || record.gate?.ref !== ref) continue;
      this.options.tasks.placement.setGate(
        record.id,
        null,
        `the ${computerForgeName(host)} sign-in is ready`,
      );
      await this.starts.dispatchQueuedTask(record.id);
    }
  }

  /**
   * The retention purge control (D-13): the one destructive control. Every
   * task, its worktree, its session JSONL, its cards, lane, timeline and
   * links go; projects stay.
   */
  async purgeAllTasks(): Promise<number> {
    const records = this.options.tasks.list();
    for (const record of records) {
      this.options.killJobs?.(record.id);
      const runtime = this.tasks.get(record.id);
      if (runtime) {
        runtime.turn.request("cancel");
        await runtime.session?.abort().catch(() => {});
        this.sessions.releaseSession(runtime);
        this.tasks.delete(record.id);
      }
      await rm(join(this.options.paths.crewmatesDir, record.id), {
        recursive: true,
        force: true,
      });
      if (record.worktreeDir && record.workspaceState !== "removed") {
        await this.options.workspace
          .removeTaskWorktree({
            taskId: record.id,
            cwd: record.worktreeDir,
            branch: record.branch,
            repoDir: record.repoDir,
          })
          .catch(() => {});
      }
      this.cards.purgeTask(record.id);
      this.options.inbox.purgeTask(record.id);
    }
    // A card with no task of its own - a Firstmate decision filed as its
    // own row, a host card's operation row - loses its evidence with the
    // row that stood for it (docs/card-evidence.md).
    this.cards.purgeEvidence(
      records.flatMap((record) =>
        (record.kind === "decision" || record.kind === "operation") && record.gate?.ref
          ? [record.gate.ref]
          : [],
      ),
    );
    this.options.tasks.archive.purge();
    this.cards.scheduleBroadcast();
    this.facts.broadcastCrewCounts();
    return records.length;
  }

  /** The corner only puts a card aside (INF-2794); it never reaches the card's author. */
  close(cardId: string): void {
    // An ended card's minus closes it: nothing on it can wait (INF-3071).
    if (this.cards.ended.close(cardId)) return;
    const card = this.cards.shown(cardId);
    if (card) this.cards.dismiss(card);
  }

  /** A live note's own button (INF-2794): only Got it tells the note's author. */
  pressNote(cardId: string, submission?: unknown, value?: unknown): void {
    // The words left in the card's field ride its one button; a press that
    // cannot take them is refused, so they stay in the field.
    // Its notes, files and pictures go with them (`choice-attachments.md`).
    const words = this.cardActions.notePress(value);
    // An ended card's one button is Close, which tells nobody (INF-3071): its
    // words go as the reply its field already sends, before it closes.
    if (this.cards.ended.has(cardId)) {
      if (words) this.cardActions.replyWithEndedClose(cardId, words);
      this.cards.ended.close(cardId);
      return;
    }
    const card = this.cards.shown(cardId);
    // A note's words go after its press: a reply waiting under the note
    // would keep Done from closing its task.
    const pressed = card ? this.cards.pressNote(card, submission) : undefined;
    if (!card || !pressed) {
      if (words)
        throw new Error("This card changed before your press went; your words stay in its field.");
      return;
    }
    // A read that carries words is told in the same turn as the words.
    if (pressed === "got-it") this.cardActions.tellCardClosed(card, undefined, Boolean(words));
    if (words) this.cardActions.replyWithNotePress(card, words, pressed === "done");
  }

  /**
   * The quit: every crewmate is let go of, a running turn cut, and nothing
   * more starts. The returned promise waits, at most `QUIT_SETTLE_MS`, for
   * the cut turns to settle so their usage is kept, and for a ready sweep
   * already running and moves already in flight to end, so their writes
   * land before the database closes.
   */
  disposeAll(): Promise<void> {
    this.disposed = true;
    this.cards.dispose();
    this.stopAllowedLinks();
    // Each program runs again from its record at the next start.
    this.programs.dispose();
    this.watch.stopWatchdog();
    for (const task of this.tasks.values()) {
      // A Claude client's background tasks end with it here: each waits on
      // the crewmate's lane as its `[job]` turn, which the next start's
      // sweep delivers once (`sweepInbox`).
      if (!task.turn.closing)
        for (const [id, run] of task.clientTasks)
          this.options.inbox.enqueue(task.id, this.toolHooks.clientTaskEnd(task, id, run, "quit"));
      task.clientTasks.clear();
      // A turn this quit cuts here with no lane row to deliver again - a
      // Claude client's own continuation - is carried on by the next
      // start's sweep; a turn's rows go again on their own (`resetInFlight`).
      if (
        !task.turn.closing &&
        task.turn.running &&
        task.turn.rows.length === 0 &&
        task.turn.pause?.row === undefined &&
        this.facts.machineOf(task.id) === LOCAL_MACHINE_ID
      )
        this.options.inbox.enqueue(task.id, { facts: { kind: "turn-resumed", stopped: "quit" } });
      this.sessions.releaseSession(task);
    }
    this.tasks.clear();
    // An update that saved the crew's work replaces this copy only once
    // every conversation is closed: no bound (docs/alpha.md, "Saving work
    // before an update").
    return this.updates.savedHere() ? this.settled() : this.settled(QUIT_SETTLE_MS);
  }

  /**
   * Resolves once every session let go of mid-turn is gone and every ready
   * sweep and computer move has ended, or `boundMs`, when given, has passed. A failed
   * operation is its caller's to hear, never the quit's.
   */
  private settled(boundMs?: number): Promise<void> {
    const pending = [
      ...this.sessions.releases(),
      ...this.watch.sweeps(),
      ...this.moves.operations(),
    ];
    if (pending.length === 0) return Promise.resolve();
    if (boundMs === undefined) return Promise.allSettled(pending).then(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, boundMs);
    });
    return Promise.race([Promise.allSettled(pending).then(() => {}), bound]).finally(() =>
      clearTimeout(timer),
    );
  }
}

/**
 * The merge a story note's line tells (INF-2678): its change's receipt once
 * it says merged. A close that merged tells every note. A merge that kept
 * the task open tells only notes made before it, and a local one only the
 * story version it landed (`landedHead`): a note made, or revised under
 * its id, for a later version waits for its own merge, and a later close
 * that merged nothing does not lend it the earlier merge's line. A local
 * merge let past its story's check names a version its story does not, so
 * its note shows at the close (INF-2678).
 */
function mergeOf(record: TaskRecord, card: Card): ChangeReceipt | undefined {
  const receipt = currentReceipt(record);
  if (receipt?.outcome !== "merged") return undefined;
  // The close that merged is the change's last merge: every note tells it.
  if (TaskService.isClosed(record) && mergingClose(record.closedReason)) return receipt;
  // A note made after this merge tells a later one; a note revised under
  // its first id keeps its first time, so its story's version decides. A
  // local merge names the version it landed; a pull request's later story
  // needs a change of its own, so one merged past its story still tells it.
  if (receipt.at !== null && receipt.at < card.createdAt) return undefined;
  const story = record.delivery?.presentation?.revisions.at(-1)?.head;
  const landed = record.delivery?.landedHead;
  if (story && landed && story !== landed) return undefined;
  return receipt;
}
