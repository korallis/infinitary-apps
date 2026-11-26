/**
 * How a crewmate's turns go, as its lane or the first mate hears it: a
 * failed or quiet turn, a long one, a steer it has not read, a repeated
 * tool result, a turn the app stopped part way, and a renewed conversation.
 *
 * The wake envelope, `renderWake` and `WAKE_WORDS`, the map of every
 * kind's words, are in `wakes.ts`.
 */

import type { RepetitionNotice, RepetitionOutcome } from "@shared/toolCompletion";
import { updateResumedWords } from "@shared/updateWords";
import { type CrewmateRestart, crewmateRestartText } from "./crewSession";
import { keptReportWords, sameAccountWords } from "./outageWakes";
import type { KindWords, TypedWake, WakeTask } from "./wakes";

export type TurnFacts =
  | {
      kind: "possible-repetition";
      task: WakeTask;
      notice: RepetitionNotice;
      usage: ReturnType<import("../storage/usageStore").UsageStore["latestForTask"]>;
    }
  | {
      /** A crewmate's turn failed with no guidance of its own for the host to retry. */
      kind: "turn-failed";
      task: WakeTask;
      crewmate: string;
      /** The failure, already capped for a wake. */
      error: string;
      /** The headline of the report the turn made before it failed, kept on the record (INF-3165). */
      keptReport?: string;
      /** For a provider refusal: the other open tasks on the same account (`sameAccountWords`). */
      sameAccount?: WakeTask[];
    }
  | {
      /**
       * The host could not commit the personal workspace at the end of a
       * crewmate's turn: its files are saved there uncommitted and the task
       * stays open (FI3-1218, docs/personal-panels.md "Report, commit, close").
       */
      kind: "commit-failed";
      task: WakeTask;
      crewmate: string;
      /** The failure's first meaningful line, git's own words (`gitFailure`). */
      error: string;
    }
  | {
      kind: "task-failed";
      task: WakeTask;
      error: string;
    }
  | {
      /** A task lane's guidance spent its attempts and was set aside. */
      kind: "guidance-set-aside";
      task: WakeTask;
      attempts: number;
      /** The guidance, already capped for a wake. */
      excerpt: string;
    }
  | {
      /** The quiet watchdog: a streaming turn with no events for this many minutes. */
      kind: "quiet";
      task: WakeTask;
      crewmate: string;
      minutes: number;
      /** The calls the turn has open, oldest first, whoever started them (INF-2603). */
      calls?: OpenCallFact[];
      /** Steers handed into the turn its session has not read, and when the oldest was handed over. */
      steers?: { count: number; since: number };
    }
  | {
      /** One turn past the wall-clock bound, in hours to one decimal. */
      kind: "long-turn";
      task: WakeTask;
      crewmate: string;
      hours: number;
      /** The task's oldest background job still running, which no longer silences this wake (INF-2603). */
      job?: { command: string; since: number };
      calls?: OpenCallFact[];
    }
  | {
      /**
       * A steer two twenty-minute checks in a row found unread (INF-2603):
       * handed over at `since`, it waits behind `calls`, the turn's open
       * calls, which may be none the app can see.
       */
      kind: "steer-unread";
      task: WakeTask;
      crewmate: string;
      since: number;
      calls: OpenCallFact[];
    }
  | {
      /**
       * A first mate steer with files_from, answered before the files
       * crossed (INF-3060), whose files were not handed over; its message
       * is kept on the lane. `arrived` counts the files that reached the
       * task before the failure, of `files` when the hand-over's checks passed.
       */
      kind: "handover-failed";
      task: WakeTask;
      /** The task whose reported files were to be handed on, by key. */
      from: string;
      error: string;
      arrived: number;
      files?: number;
    }
  | {
      /**
       * The app stopped the crewmate's turn part way and nothing else on
       * its lane carries it on (docs/inbox.md, "A turn a quit or crash
       * cut"): the computer it runs on was updated, or this Mac quit. Its
       * own turn, served once the crewmate can run again, never a mid-turn
       * steer.
       */
      kind: "turn-resumed";
      /** `cost-limit`: the task passed its cost limit and the captain let it go on (docs/usage.md). */
      stopped: "update" | "quit" | "cost-limit";
      /** The computer that was updated, as Devices names it. */
      computer?: string;
    }
  | {
      /**
       * A conversation that replaced the task's earlier one (INF-416 piece B).
       * Queued once per renewal, and served first on the turn that brings the
       * crewmate back, so a quit before that turn ends clean still delivers it.
       */
      kind: "conversation-restart";
      restart: CrewmateRestart;
      /** The task's key, which `tasks` reads its record by. */
      taskKey: string;
      /** The brief its first turn served, when the record holds it. */
      brief?: string;
      /** Where the earlier conversation's transcript is saved, on the computer it runs on. */
      earlier?: string;
      /**
       * A hold came up while the new conversation opened, before its first
       * turn: this reason is that turn, due by itself once the hold ends,
       * after a relaunch too (`CrewSessions.restartIsDue`).
       */
      due?: true;
    };

/**
 * Whether the repeated calls worked, a typed fact (INF-5123 finding 2): a
 * repeat of a call that worked is never read as a failure to stop retrying.
 */
const REPETITION_OUTCOME_WORDS: Record<RepetitionOutcome, string> = {
  worked: "every one of those calls worked; none failed",
  failed: "every one of those calls failed with the same error",
  unknown: "whether those calls worked or failed is not known",
};

/** The event's words, shared with journeys that observe its delivery. */
export const POSSIBLE_REPETITION_OPENING = "[fm-op] Possible repetition on task ";

/** The once-name of one renewal: a later renewal, from a different conversation, is a new fact. */
export function conversationRestartOnce(restart: CrewmateRestart): string {
  const changed =
    restart.changed === "unopenable" ||
    restart.changed === "context" ||
    restart.changed === "refused" ||
    restart.changed === "moved" ||
    restart.changed === "computer"
      ? restart.changed
      : [...restart.changed].sort().join("+");
  return `conversation-restart:${restart.from}:${changed}`;
}

/**
 * The reason a renewed conversation is told, as a once-named wake. `renderWake`
 * draws it with `crewmateRestartText`, so the served words stay the same bytes.
 */
export function conversationRestartWake(input: {
  restart: CrewmateRestart;
  taskKey: string;
  brief?: string;
  earlier?: string;
}): TypedWake {
  const restart =
    input.restart.changed === "unopenable" ||
    input.restart.changed === "context" ||
    input.restart.changed === "refused" ||
    input.restart.changed === "moved" ||
    input.restart.changed === "computer"
      ? input.restart
      : { from: input.restart.from, changed: [...input.restart.changed] };
  return {
    facts: {
      kind: "conversation-restart",
      restart,
      taskKey: input.taskKey,
      ...(input.brief ? { brief: input.brief } : {}),
      ...(input.earlier ? { earlier: input.earlier } : {}),
    },
    once: conversationRestartOnce(input.restart),
  };
}

/** What a crewmate whose turn the app stopped part way checks before it carries on. */
const RESUME_CHECK =
  "Carry on where you left off. Before you repeat a step, check what already took effect - your working copy and branch, a push, a pull request, a job or workflow you started, a card you showed - rather than doing it twice.";

/** One call a quiet turn has open, by its tool and when it began (INF-2603). */
export type OpenCallFact = { tool: string; since: number };

function isoOf(at: number): string {
  return new Date(at).toISOString();
}

/** A turn's open calls in words: `github_read since 2026-11-04T03:02:08.000Z`. */
function callsList(calls: readonly OpenCallFact[]): string {
  return calls.map((call) => `${call.tool} since ${isoOf(call.since)}`).join(", ");
}

function openCallsText(calls: readonly OpenCallFact[] | undefined): string {
  return calls?.length ? ` It is inside ${callsList(calls)}.` : "";
}

export const TURN_WORDS: KindWords<TurnFacts> = {
  "turn-failed": (facts) =>
    `[fm-op] ${facts.crewmate}'s turn on task ${facts.task.id} "${facts.task.title}" failed: ${facts.error}.${keptReportWords(facts.keptReport)}${sameAccountWords(facts.sameAccount)} The crewmate is still steerable; you can retry, steer, or interrupt it.`,
  "commit-failed": (facts) =>
    `[fm-op] the host could not commit the personal workspace at the end of ${facts.crewmate}'s turn on task ${facts.task.id} "${facts.task.title}", so the task stays open and cannot close as finished. What it changed is saved in the workspace but not committed. Its crewmate's next report tries the commit again: steer it to look into the error and report again, or tell the captain. The error: ${facts.error}`,
  "task-failed": (facts) =>
    `[fm-op] task ${facts.task.id} "${facts.task.title}" failed: ${facts.error}`,
  "guidance-set-aside": (facts) =>
    `[fm-op] guidance for task ${facts.task.id} "${facts.task.title}" could not be delivered after ${facts.attempts} attempts and was set aside: ${facts.excerpt}. You can interrupt the task or spawn a follow-up.`,
  "possible-repetition": (facts) =>
    `${POSSIBLE_REPETITION_OPENING}${facts.task.id} "${facts.task.title}": ${facts.notice.toolName} returned the same result ${facts.notice.count} times for the same arguments, and ${REPETITION_OUTCOME_WORDS[facts.notice.outcome]}. First/latest call references: ${JSON.stringify({ first: facts.notice.first, latest: facts.notice.latest })}. Elapsed: ${Math.max(0, facts.notice.latest.at - facts.notice.first.at)} ms. Latest available usage reading (not a total): ${JSON.stringify(facts.usage)}. Missing fields and cost are unknown, not zero. Inspect the task. Repeated tests, rereads and polling may be useful. Judge against the original task before steering or interrupting within its scope. This observation is not a loop verdict or an automatic stop.`,
  quiet: (facts) =>
    `[fm-op] ${facts.crewmate} on task ${facts.task.id} "${facts.task.title}" has produced no events for ${facts.minutes} minutes; it may be stuck.${openCallsText(facts.calls)}${facts.steers ? ` ${facts.steers.count === 1 ? "1 steer" : `${facts.steers.count} steers`} handed over since ${isoOf(facts.steers.since)} not read yet: the turn reads a steer only once its open call returns.` : ""} You can steer or interrupt it.`,
  "long-turn": (facts) =>
    `[fm-op] ${facts.crewmate} on task ${facts.task.id} "${facts.task.title}" has been on one turn for ${facts.hours} hours.${facts.job ? ` Its background job runs since ${isoOf(facts.job.since)}: ${facts.job.command}. A running job shows the job works, not the turn.` : ""}${openCallsText(facts.calls)}`,
  "steer-unread": (facts) =>
    `[fm-op] a steer handed to ${facts.crewmate} on task ${facts.task.id} "${facts.task.title}" at ${isoOf(facts.since)} is still unread after two quiet checks.${facts.calls.length > 0 ? ` It waits behind ${callsList(facts.calls)}, and the turn reads it only once that call returns.` : " The turn has no open call the app can see."} You can wait, or interrupt the turn so the steer goes into its next turn.`,
  "handover-failed": (facts) =>
    `[fm-op] the files from ${facts.from} for your message to task ${facts.task.id} "${facts.task.title}" were not handed over: ${facts.error} ${handoverArrivedText(facts.arrived, facts.files)} Your message is kept, and its crewmate reads it with a line saying the files did not arrive; hand them again with steer_crewmate files_from if they are still needed.`,
  "conversation-restart": (facts) =>
    crewmateRestartText({
      restart: facts.restart,
      taskKey: facts.taskKey,
      ...(facts.brief ? { brief: facts.brief } : {}),
      ...(facts.earlier ? { earlier: facts.earlier } : {}),
    }),
  "turn-resumed": (facts) =>
    `${facts.stopped === "cost-limit" ? "Your last turn stopped at a safe point when this task passed its cost limit, and the captain let it go on." : facts.stopped === "update" ? updateResumedWords(facts.computer) : "Your last turn stopped part way when the app closed - a quit or an update; it is open again."} ${RESUME_CHECK}`,
};

/** What of a failed hand-over reached the task (INF-3060). */
function handoverArrivedText(arrived: number, files: number | undefined): string {
  if (arrived === 0) return "No file reached its hand-over folder.";
  if (files !== undefined && arrived >= files)
    return `All ${files} files reached its hand-over folder, verified, but its crewmate was not told about them.`;
  return `${arrived}${files !== undefined ? ` of ${files}` : ""} files reached its hand-over folder before the failure, with no receipt; its crewmate was not told about them.`;
}
