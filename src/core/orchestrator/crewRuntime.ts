import type { CutOff } from "@shared/authFailure";
import type { KeptValidationInput } from "@shared/liveValidation";
import type { InterruptEventData, SteerEventData } from "@shared/provenance";
import type { OpenReads } from "../session/openReads";
import type { BackgroundJobName, ModelSession } from "../session/session";
import type { TaskRecord } from "../storage/taskRecords";
import type { ReportDeclaration } from "../tasks/taskTurns";
import type { TaskWorkspace } from "../workspace/workspaceService";
import type { HeldDirections } from "./crewDirections";
import type { CrewmateSpec } from "./crewSession";
import type { CrewTurn } from "./crewTurn";
import type { WakeWithdrawn } from "./reportWakes";
import type { ModelWaitCause } from "./taskMoves";

/**
 * How a steer actually reached the crewmate. A backend whose ControlProfile
 * says `followup-queue` cannot interrupt its own running turn, so guidance
 * sent mid-turn is parked and delivered as the crewmate's NEXT turn. The
 * caller is told which happened (captain's phase-8 decision): a queued steer
 * is surfaced honestly, never dropped and never reported as if it had
 * reached the work in flight. `recorded-retrying` is the durable-inbox
 * outcome for a delivery that failed right now: the message is recorded,
 * the ladder retries it, and it escalates loudly if it keeps failing.
 * `recorded-queued` (INF-3060): the task has not started yet - its start
 * runs behind the first mate's answer, it waits to start by itself, or its
 * start failed and it waits open for update_task start_now - so
 * the message waits durably on the task's lane and its crewmate reads it
 * right after its brief once it starts. `after-files`: the first mate's
 * message is recorded on the task's lane, which is held while its earlier
 * message with files is still being handed over, so the crewmate reads them
 * in the order they were sent. `recorded-held`: the task's lane is held
 * (`LaneHold`: a cut-off on its account, its computer out of reach, an
 * update, a move, a hand-over or a cost limit), so the message is kept on
 * its lane, not attempted, and goes out when the hold ends (docs/inbox.md,
 * "A lane on a withheld account").
 * `recorded-sending` (INF-3060): the first mate's message is recorded and
 * its delivery - into the running turn, or by reopening the conversation -
 * goes on behind the tool's answer; the timeline records what became of it,
 * and a failed delivery is retried like `recorded-retrying`.
 */
export type SteerDelivery =
  | "mid-turn"
  | "queued-next-turn"
  | "recorded-retrying"
  | "recorded-queued"
  | "recorded-held"
  | "recorded-sending"
  | "after-files";

/**
 * What keeps a task's lane held (`CrewFacts.laneHold`), so a message kept
 * there is answered with the hold that keeps it: the task's account under
 * a cut-off, its computer out of reach, an update, a move to another
 * computer or a hand-over of files still crossing, or a cost limit, named
 * with the task it stands on and the card whose answer releases it.
 */
export type LaneHold =
  | { kind: "cost-limit"; holder: string; holderKey: string; limitUsd: number; cardId: string }
  | { kind: "move" }
  | { kind: "hand-over" }
  | { kind: "model"; cause: ModelWaitCause }
  | { kind: "account" }
  | { kind: "update" }
  | { kind: "out-of-reach" };

/** Who issued a steer, how it arrived, and the decision behind it (R2 capture). */
export type SteerSource = {
  actor: "firstmate" | "captain" | "supervisor";
  via: SteerEventData["via"];
  decision: string | null;
  cardId: string | null;
  /** The panel the captain moved it from, by its title (a panel's Continue). */
  panel?: string;
  /** Where the captain's own words sit in the message (`replyWordsSpan`). */
  words?: SteerEventData["words"];
  /** The Firstmate steered in a turn that carries the captain's own words. */
  captainWords?: boolean;
  /** Private original input for its task record, never part of public steer data. */
  captainText?: string;
};

export const SUPERVISOR_STEER: SteerSource = {
  actor: "supervisor",
  via: "supervision",
  decision: null,
  cardId: null,
};

/**
 * How long a quit waits for the crewmates it cut mid-turn to settle, so each
 * interrupted turn's usage reaches the ledger. An answered interrupt takes
 * well under a second; a client that does not answer loses its turn's usage
 * rather than holding the quit.
 */
export const QUIT_SETTLE_MS = 2_000;

/** What placement reads of a task, or of one about to exist (docs/helper.md, "Runs on"). */
export type PlacementRecord = {
  branch?: string;
  sessionFile?: string | null;
  placement?: TaskRecord["placement"];
  repoId: string | null;
  parentId?: string | null;
  deviceId?: string | null;
  shape?: {
    kind?: string;
    runs_on_ask?: string;
    in_place?: object;
    unsafe_data_reader?: boolean;
  } | null;
};

export type InterruptSource = {
  actor: "firstmate" | "captain";
  via: InterruptEventData["via"];
  decision: string | null;
  /** The panel the captain moved it from, by its title (a panel's Drop task on started work). */
  panel?: string;
  /** The stop is part of a move back to the backlog (INF-2062), not a Stop of its own. */
  backlog?: true;
};

/**
 * A move of a started task to another provider (INF-849): who asked, the
 * model they named (update_task's override_model_id), or none for the app's
 * pick with the current provider left out; `from` is the provider the card
 * offered to move off, so a card left up after another move does nothing;
 * `offered` is the model the card named, which the move takes or refuses,
 * never another in its place.
 */
export type MoveAsk = {
  by: "captain" | "firstmate";
  model?: string;
  from?: string;
  offered?: string;
};

export type MoveTarget = {
  model: { provider: string; id: string };
  accountId?: string;
  thinkingLevel: NonNullable<CrewmateSpec["thinkingLevel"]>;
  providerName: string;
};

export type TaskRuntime = {
  id: string;
  title: string;
  /** The conversational handle (`<PROJECT_KEY>-<seq>`), for card chrome; falls back to `id`. */
  key: string;
  crewmate: string;
  /** The backend serving the open conversation, a fact the runbook selectors read. */
  backend?: string;
  workspace?: TaskWorkspace;
  session?: ModelSession;
  /** Why the current conversation opened, including ids minted on its first turn. */
  conversationBegan?: string;
  unsubscribe?: () => Promise<void>;
  clientJobs?: number;
  /** When the client's background work last went from none to some: the job bound's clock. */
  clientJobsSince?: number;
  /** The longest-running job of that work, when its runner names it (a computer's Pi shell). */
  clientJob?: BackgroundJobName;
  /**
   * The background tasks this Mac's Claude client runs for the crewmate, by
   * id, each with what the model said it is and when it was first seen: the
   * ones a client end, or the quit, cuts off (`follow`, `disposeAll`).
   */
  clientTasks: Map<string, { description: string; since: number }>;
  currentTurnText: string;
  /** The last completed turn's text - the report shown on the task card. */
  lastCompleteText: string;
  /** The turn's FINAL message text so far, its closing words once its session closes it: its report candidate (WI-1). */
  turnReport?: string;
  /** What the turn in flight reported through the report tool (WI-1); wins over its text. */
  explicitReport?: string;
  /** The report tool's own one-line headline for `explicitReport`, when it gave one. */
  explicitSummary?: string;
  /** What `explicitReport` declared about whose turn follows it (FI3-435). */
  explicitDeclared?: ReportDeclaration;
  /**
   * The relay this turn already woke the first mate for, when its report
   * was made (INF-3926's finding 2): the request, the report it rode, when,
   * and how many filings and withdrawals the turn had then. The turn's end
   * sends no second wake for the same unchanged relay.
   */
  relayWoken?: RelayWoken;
  /**
   * The record's event of the kept report (`TaskTurns.keptReport`) this
   * runtime's turns already named: a later turn names it only once.
   */
  keptReportTold?: number;
  /** The typed review this turn's report recorded (INF-1875): a reviewer's verdict, read at the turn's end. */
  turnReview?: Extract<KeptValidationInput, { kind: "review" }>;
  /** The phase owner carries input from preparation through its one exit. */
  turn: CrewTurn;
  /** The vault account serving this crewmate; absent = base runtime. */
  accountId?: string;
  /**
   * The follow-ups this turn filed (cards/tasks/agents P0, WI-4): a filing
   * is a row, a link and a feed line, never a wake of its own; the report
   * wake that ends the turn names them, and the list clears with it. A
   * program the turn started is named as one (`program`).
   */
  filedThisTurn: { key: string; title: string; blocks: boolean; program?: boolean }[];
  /**
   * The decisions its crewmate withdrew itself this turn (INF-2828): the
   * captain chose none of their actions, and the report wake that ends
   * the turn names them beside the report; the list clears with it.
   */
  withdrawnThisTurn: WakeWithdrawn[];
  /** Watchdog signals (P4): any session event counts as activity. */
  lastEventAt: number;
  /**
   * When its model last answered in this runtime: a word or a tool call it
   * streamed, which only an answering provider sends. The still-down wake
   * reads it against `failedAt`, so a lane that has worked since its last
   * failure is never told as still failing (`IdleLadder.checkStillDown`).
   */
  answeredAt?: number;
  /** When a turn of its last failed in this runtime (`turn_failed`). */
  failedAt?: number;
  turnStartedAt: number;
  /** 0 = active, 1 = quiet feed line sent, 2 = quiet card raised. */
  quietLevel: 0 | 1 | 2;
  /** When the watchdog last asked the live session whether this quiet turn still works (INF-2332). */
  confirmedAt?: number;
  /**
   * The quiet pass's question to the task's computer is out: its quiet
   * alert waits for the answer, and goes unless that answer ended the turn
   * here (INF-2332).
   */
  quietAsk?: true;
  /** The 2h wall-clock escalation fired for this turn. */
  wallClockEscalated: boolean;
  /**
   * The calls the turn has open now, by call id, each by its tool and when
   * it began (INF-2603): what a quiet turn waits on, named whoever started
   * the call.
   */
  openCalls: Map<string, { tool: string; since: number }>;
  /**
   * The steers handed into the turn that its session has not read yet,
   * oldest first: one is read once the session says so (`input_read`), or
   * once a model request begins after it was handed over (INF-2603).
   */
  unreadSteers: UnreadSteer[];
  /**
   * The standing directions this conversation holds (`crewDirections.ts`,
   * INF-2599): a turn sends them again only when it does not hold the
   * current set. Kept in memory, so a restart of this app sends them once.
   */
  directions?: HeldDirections;
  /** The steers the previous twenty-minute check found unread: one still unread at the next wakes the first mate once. */
  steersAtCheck?: readonly UnreadSteer[];
  /** The app's own reads a conversation on this Mac has open, which the twenty-minute check may answer. */
  openReads: OpenReads;
  /** The twenty-minute check named this quiet stretch's wait: crew status names it until the turn moves. */
  waitNamed?: true;
  /** The twenty-minute check answered an app read: the quiet alert waits for the next check, which finds the turn moving or names it. */
  readsAnsweredAt?: number;
  /**
   * The provider error the current turn ended with (turn_failed), consumed
   * by turnComplete: Pi resolves such turns instead of rejecting, so
   * without this the failure would report as an empty "(no report)".
   */
  lastTurnError?: string;
  lastTurnCutOff?: CutOff;
  /** `lastTurnError` is the model's context limit, as the backend typed it. */
  lastTurnContextOverflow?: true;
  /**
   * This conversation is the one fresh conversation a context-limit failure
   * opened (`CrewTurns.recoverContext`), and no turn in it has ended clean
   * yet: a second context-limit failure is not recovered again.
   */
  contextRecovered?: true;
};

/** A steer handed into a running turn, by its words' digest and when it was handed over. */
export type UnreadSteer = { sha: string; since: number; woken?: true };

export type RelayWoken = {
  request: string;
  report: string;
  at: number;
  filed: number;
  withdrawn: number;
  /** Its wait and recovery facts as its wake carried them (`relayRecovery`); undefined when they ran past their band. */
  recovery?: string;
};
