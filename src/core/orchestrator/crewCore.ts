import type { ServedWakeOrigin } from "@shared/servedFrame";
import type { EffectiveTaskPolicies, TaskPolicyEdits } from "@shared/taskPolicies";
import type { CrewPrograms, ProgramRunner } from "../program/programRunner";
import type { TaskRecord } from "../storage/taskRecords";
import type { BuildRows } from "./buildRows";
import type { CaptainOverrides } from "./captainOverrides";
import type { CardActions } from "./cardActions";
import type { CardService } from "./cardService";
import type { CostLimits } from "./costLimits";
import type { CrewBrief } from "./crewBrief";
import type { CrewFacts } from "./crewFacts";
import type { CrewmateCards } from "./crewmateCards";
import type { PlacementRecord, TaskRuntime } from "./crewRuntime";
import type { CrewSessions } from "./crewSessions";
import type { CrewSteer } from "./crewSteer";
import type { CrewSupervisorOptions, FirstmateHooks } from "./crewSupervisorOptions";
import type { CrewToolHooks } from "./crewToolHooks";
import type { CrewTurns } from "./crewTurns";
import type { CrewUpdates } from "./crewUpdates";
import type { CrewWatch } from "./crewWatch";
import type { HostOps } from "./hostOps";
import type { IdleLadder } from "./idleLadder";
import type { InPlaceWork } from "./inPlaceWork";
import type { TaskIntake } from "./intake";
import type { IntegrationAsks } from "./integrationAsks";
import type { LoginMoves } from "./loginMoves";
import type { ReportIntake } from "./reportIntake";
import type { WakeOpenReview } from "./reportWakes";
import type { RestartWatch } from "./restartWatch";
import type { Reviews } from "./reviews";
import type { RuleNotes } from "./ruleNotes";
import type { SettleOwners } from "./settleOwners";
import type { CrewStarts } from "./starts";
import type { TaskMoves } from "./taskMoves";
import type { TaskPlacement } from "./taskPlacement";
import type { TypedWake } from "./wakes";
import type { WorkPostures } from "./workPosture";

/**
 * What the crew supervisor's core owners share (docs/architecture.md
 * section 2): the crew's sessions (`CrewSessions`), its turns (`CrewTurns`),
 * its steering (`CrewSteer`), its starts (`CrewStarts`), its watch
 * (`CrewWatch`), the captain's card actions (`CardActions`), the host's own
 * operations (`HostOps`), the crew's facts (`CrewFacts`) and a crewmate's
 * hooks into the host (`CrewToolHooks`) each hold this one typed view of the
 * supervisor, and reach the others and the leaf owners through it. The
 * supervisor builds it and the core owners first, before any leaf owner,
 * which it reads through the core once built; the facts it reads through a
 * function are the supervisor's own.
 */
export type CrewCore = {
  readonly options: CrewSupervisorOptions;
  readonly tasks: Map<string, TaskRuntime>;
  now(): number;
  /** The app is quitting: a turn that settles now is not the crew's to act on. */
  disposed(): boolean;
  /** What the first mate's side asked to hear (`CrewSupervisor.setFirstmateHooks`). */
  hooks(): FirstmateHooks;

  readonly sessions: CrewSessions;
  readonly turns: CrewTurns;
  readonly steer: CrewSteer;
  readonly starts: CrewStarts;
  readonly watch: CrewWatch;
  readonly cardActions: CardActions;
  readonly hostOps: HostOps;
  readonly facts: CrewFacts;
  readonly toolHooks: CrewToolHooks;

  readonly briefs: CrewBrief;
  readonly buildRows: BuildRows;
  readonly cards: CardService;
  readonly costLimits: CostLimits;
  readonly crewmateCards: CrewmateCards;
  readonly crewPrograms: CrewPrograms;
  readonly inPlaceWork: InPlaceWork;
  readonly intake: TaskIntake;
  readonly integrationAsks: IntegrationAsks;
  readonly ladder: IdleLadder;
  readonly loginMoves: LoginMoves;
  readonly moves: TaskMoves;
  readonly overrides: CaptainOverrides;
  readonly placement: TaskPlacement;
  readonly postures: WorkPostures;
  readonly programs: ProgramRunner;
  readonly reportIntake: ReportIntake;
  readonly restarts: RestartWatch;
  readonly reviews: Reviews;
  readonly settling: SettleOwners;
  readonly updates: CrewUpdates;

  /** A rule's notes as a file, once the Scheduler is bound (docs/automation.md, "A rule's notes"). */
  ruleNotes(): RuleNotes | undefined;
  /** Whether a task's events skip supervision: a review task itself. */
  bypassesSupervision(taskId: string): boolean;
  /** An emitter withdraws its own card (close_card). */
  closeCard(
    cardId: string,
    actor: { kind: "firstmate" } | { kind: "crewmate"; taskId: string },
    reason?: string,
  ): string;
  /** The live review task of a builder, if one is open; a repair assessment is not its review. */
  openReviewOf(builderId: string): TaskRecord | undefined;
  /** A task's policies changed: its lane and its open cards hear it. */
  policiesChanged(
    taskId: string,
    edits: TaskPolicyEdits,
    before?: EffectiveTaskPolicies | null,
  ): string;
  /** Refresh only between review turns; never move a checkout under a running reviewer. */
  refreshReview(task: TaskRuntime): Promise<string | undefined>;
  /** The builder a review task reads: its parent, the one stored join. */
  reviewBuilderOf(record: PlacementRecord | undefined): TaskRecord | undefined;
  /** A builder's open review whose last verdict was findings or blocked, while no cap holds its re-reviews. */
  reviewToReread(builder: TaskRecord): WakeOpenReview | undefined;
  /** The one router for crew lifecycle events. */
  routeCrewEvent(taskId: string, wake: TypedWake, origin: ServedWakeOrigin): number | null | void;
};
