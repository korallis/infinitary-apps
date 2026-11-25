import { z } from "zod";
import { TASK_KEYS_PER_READ } from "./channels/tasks";
import type { CrewLive, CrewTranscript } from "./crewTranscript";
import type { FmEvent } from "./events";
import { changesFeed } from "./feed";
import type { CoreInvokeChannel, CorePushChannel, InvokeRequest, InvokeResponse } from "./ipc";
import {
  knowledgeConceptsArgsSchema,
  knowledgeDirectionArgsSchema,
  knowledgeDirectionsArgsSchema,
  knowledgeEntryArgsSchema,
  knowledgeFindingsArgsSchema,
  knowledgeGraphArgsSchema,
  knowledgeRefsArgsSchema,
  knowledgeUsesArgsSchema,
} from "./knowledge";
import { panelSettingNamesSchema } from "./panelSettingNames";
import { RESOURCE_DEMAND_RENEW_MS } from "./resources";
import { sameSqlAnswer, sqlQuerySchema } from "./sql";
import { applyTaskBoardDelta, type TaskBoard, type TaskBoardDelta } from "./tasks";
import { usageQuerySchema, usageTaskCostsQuerySchema, usageTasksQuerySchema } from "./usage";

/**
 * The read catalog (v0 in phase 1 of the UI plugin system, docs/ui-plugins.md;
 * the three task reads joined in task-system P3).
 *
 * A read is host-pushed app data a plugin frame may subscribe to by NAME.
 * The frame never holds IPC, never sees `window.infinitary`, and never
 * composes a query: it names a catalog entry its manifest declared, hands
 * over args the entry's own schema bounds, and the host executes and
 * pushes. Every entry maps to a `surface: "core"` channel of the contract
 * (src/shared/ipc.ts), so the catalog is named exactly once, where the
 * protocol lives, and a client other than the Electron renderer could serve
 * it from the same table (the reconciliation the proposal asked for).
 *
 * Deliberately absent, by design: `cards.list` (a plugin must not read other
 * emitters' card content) and anything account- or auth-shaped.
 *
 * Invalidation is declared per entry and executed by the host
 * (src/renderer/src/plugins/reads/executor.ts): an event predicate, a push
 * channel, or a poll interval - a read re-runs on any of them and the new
 * value is pushed to every subscriber. Names are frozen once landed; adding
 * an entry is additive, renaming one is a protocol change.
 */

export type ReadInvalidation<A> = {
  events?: (event: FmEvent, args: A) => boolean;
  pushes?: readonly Exclude<CorePushChannel, "inf:event">[];
  /**
   * A push whose payload IS this read's value: the host hands it to every
   * subscriber as it arrives instead of re-reading (no second coalescing
   * window, no round trip), because the core builds the pushed snapshot
   * from the same query the read runs. Only for an argument-less read whose
   * channel answers with exactly the pushed shape.
   */
  valueFromPush?: Exclude<CorePushChannel, "inf:event">;
  /**
   * A push that carries a CHANGE to this read's value (task-system P5):
   * the host folds it onto the value the subscriber already holds with
   * `apply`, and delivers the result with no read. `apply` answers null
   * when the change cannot be applied (a gap in the sequence, no value
   * held yet), which is the host's cue to re-run the read instead.
   */
  deltaFromPush?: {
    channel: Exclude<CorePushChannel, "inf:event">;
    apply: (current: unknown, delta: unknown) => unknown | null;
  };
  /** Reproject held raw values on local presentation changes, without changing the delta base. */
  presentation?: boolean;
  pollMs?: number;
  /**
   * When a re-run's value says the same thing as the one the subscriber
   * holds, it is not delivered: a read re-run on every event would
   * otherwise hand a subscriber the same answer many times a second.
   */
  sameValue?: (current: unknown, next: unknown) => boolean;
};

/**
 * What the HOST adds to a read on a plugin's behalf, from the plugin's
 * manifest - never from the subscriber, whose args are strict. Today one
 * grant: the views a plugin may query (`capabilities.sql`, or a personal
 * manifest's `sql`). A read that takes no grant ignores it.
 */
export type ReadGrant = {
  sql?: readonly string[];
};

/**
 * What a frame may subscribe to and the grant the host adds, from the reads
 * and views a panel's manifest or a crewmate's card declared: declaring a
 * view is what lets it name the `sql` read, which runs under those views.
 * One shaping for every frame that declares them.
 */
export function frameReads(
  reads: readonly string[],
  views: readonly string[],
): { reads: string[]; grant: ReadGrant } {
  return { reads: [...reads, ...(views.length ? ["sql"] : [])], grant: { sql: [...views] } };
}

export type ReadEntry<C extends CoreInvokeChannel, A extends z.ZodType> = {
  channel: C;
  /** What a subscriber may pass; strict, so a stray key is a refusal. */
  args: A;
  toRequest: (args: z.infer<A>, grant: ReadGrant) => InvokeRequest<C>;
  invalidate: ReadInvalidation<z.infer<A>>;
  /**
   * Readers that ask for less of a pushed value share one value with the
   * readers that ask for all of it: it is read with `args` while every
   * reader asks for less (`asksLess`), and read again whole once a reader
   * that asks for all of it joins a lesser value (`lesser`). The task board
   * is the one this is for (`boardWithoutClosed`).
   */
  narrows?: {
    args: z.infer<A>;
    asksLess: (args: z.infer<A>) => boolean;
    lesser: (value: unknown) => boolean;
  };
  description: string;
};

function entry<C extends CoreInvokeChannel, A extends z.ZodType>(
  definition: ReadEntry<C, A>,
): ReadEntry<C, A> {
  return definition;
}

const noArgs = z.strictObject({});
const sessionArgs = z.strictObject({ id: z.string().min(1).max(128) });
const taskArgs = z.strictObject({ id: z.string().min(1).max(64) });

/**
 * Events after which a knowledge read re-reads: a write to a collection
 * (a declared use is one), the purge, and a project coming or going, which
 * adds or takes away its collection.
 */
const KNOWLEDGE_EVENTS: ReadonlySet<FmEvent["type"]> = new Set([
  "knowledge_changed",
  "repo_setup",
  "repo_configured",
  "repo_unregistered",
]);

/** Events after which the Observe list and detail re-read their files. */
const OBSERVE_RELOAD_EVENTS: ReadonlySet<FmEvent["type"]> = new Set([
  "turn_end",
  "turn_failed",
  "task_started",
  "task_finished",
  "task_report",
  "firstmate_state",
  "auth_reconnect_required",
]);

/** Events after which a crewmate's transcript may have moved. */
const CREWMATE_EVENTS: ReadonlySet<FmEvent["type"]> = new Set([
  "tool_start",
  "tool_end",
  "turn_end",
  "turn_failed",
  "task_finished",
  "task_changed",
  "task_event",
]);

/** Events that move what a crewmate is writing now, or whether a turn runs. */
const CREWMATE_LIVE_EVENTS: ReadonlySet<FmEvent["type"]> = new Set([
  "assistant_delta",
  "tool_start",
  "tool_end",
  "turn_end",
  "turn_failed",
  "task_finished",
  "task_changed",
]);

const taskIdOf = (event: FmEvent): string | undefined =>
  "taskId" in event && typeof event.taskId === "string" ? event.taskId : undefined;

/** Events that change a session's in-flight turn. */
const OBSERVE_LIVE_EVENTS: ReadonlySet<FmEvent["type"]> = new Set([
  "assistant_delta",
  "tool_start",
  "tool_end",
  "turn_end",
  "turn_failed",
]);

export const readCatalog = {
  "computers.resources": entry({
    channel: "inf:computers:resources",
    args: noArgs,
    toRequest: () => [],
    invalidate: {
      valueFromPush: "inf:computers:resources",
      // Renew the shared core source's demand lease, never sample per subscription.
      pollMs: RESOURCE_DEMAND_RENEW_MS,
    },
    description:
      "Current CPU and memory readings for the computers that run work, with age or why unavailable.",
  }),
  "observe.sessions": entry({
    channel: "inf:observe:sessions",
    args: noArgs,
    toRequest: () => [],
    invalidate: { events: (event) => OBSERVE_RELOAD_EVENTS.has(event.type), pollMs: 2_000 },
    description:
      "Every agent session Observe lists (development and alpha builds; docs/dev-observe.md).",
  }),
  "observe.session": entry({
    channel: "inf:observe:detail",
    args: sessionArgs,
    toRequest: (args) => [args.id],
    invalidate: { events: (event) => OBSERVE_RELOAD_EVENTS.has(event.type) },
    description: "One session's header and transcript, read from its file.",
  }),
  "observe.live": entry({
    channel: "inf:observe:live",
    args: sessionArgs,
    toRequest: (args) => [args.id],
    invalidate: {
      events: (event, args) =>
        OBSERVE_LIVE_EVENTS.has(event.type) && "taskId" in event && event.taskId === args.id,
    },
    description: "One session's in-flight turn: text and tool calls not yet in its file.",
  }),
  // Settings → Automation (docs/automation.md): a rule changes by a feed
  // line (create, save, pause, resume, delete), the Scheduler's own or the
  // trail of a catalog change; next runs and history move with the clock,
  // so the read also refreshes while the section is open.
  "automation.list": entry({
    channel: "inf:automation:list",
    args: noArgs,
    toRequest: () => [],
    invalidate: {
      events: (event) => event.type === "firstmate_note" || event.type === "personalized",
      pollMs: 30_000,
    },
    description: "Every automation rule: its name, state, schedule, prompt and next run.",
  }),
  // Kept running (docs/leftover-programs.md, "Kept running"): a close keeps
  // a job and writes its timeline line; a Remove's trail is a feed line.
  "automation.kept": entry({
    channel: "inf:automation:kept",
    args: noArgs,
    toRequest: () => [],
    invalidate: {
      events: (event) =>
        event.type === "firstmate_note" ||
        event.type === "task_event" ||
        event.type === "task_finished" ||
        event.type === "task_landed",
      pollMs: 30_000,
    },
    description:
      "The jobs kept running past their task's close: each one's label, computer, account, task and last check.",
  }),
  // The Batches panel (docs/forge.md, "The Batches panel"): the record moves
  // on its own event, the checks reading on another, and a project coming,
  // going or changing how its changes go moves which projects are listed.
  // A task's key and title come with it; the minute's poll reads a renamed one.
  "batches.list": entry({
    channel: "inf:batches:list",
    args: noArgs,
    toRequest: () => [],
    invalidate: {
      events: (event) =>
        event.type === "repo_batch" ||
        event.type === "batch_checks" ||
        event.type === "repo_setup" ||
        event.type === "repo_configured" ||
        event.type === "repo_unregistered",
      // A finished batch leaves Last day a day after it ended, with no event.
      pollMs: 60_000,
    },
    // i18n-exempt: served only to the first mate, as the read's description (src/core/pi/appReads.ts).
    description:
      "Each project on batched pull requests: the approved changes in line, the open batch with its checks, the changes left out and the batches that ended in the last day.",
  }),
  // A delivery is handled when a Firstmate turn ends, which no feed line says.
  "automation.history": entry({
    channel: "inf:automation:history",
    args: z.strictObject({ id: z.string().min(1) }),
    toRequest: (args) => [args.id],
    invalidate: {
      events: (event) =>
        event.type === "firstmate_note" ||
        event.type === "personalized" ||
        event.type === "firstmate_state",
      pollMs: 30_000,
    },
    description:
      "One automation rule's recent runs, newest first, each with where its delivery stands.",
  }),
  // A rule's notes change by the captain's save, whose catalog trail is
  // read at once, or by a crewmate's report, which the poll reads.
  "automation.notes": entry({
    channel: "inf:automation:notes",
    // Every version unless only the newest is asked for.
    args: z.strictObject({
      id: z.string().min(1),
      versions: z.enum(["current", "all"]).optional(),
    }),
    toRequest: (args) => [args.id, args.versions ?? "all"],
    invalidate: {
      events: (event) => event.type === "personalized" || event.type === "firstmate_note",
      pollMs: 30_000,
    },
    description:
      "One automation rule's notes, what its runs learned: the newest version, or every version newest first.",
  }),
  // Settings → Usage (docs/usage.md): re-read when a model response is
  // recorded or a task changes, so the tab keeps up while it is open.
  "usage.summary": entry({
    channel: "inf:usage:summary",
    args: usageQuerySchema,
    toRequest: (args) => [args],
    invalidate: {
      events: (event) =>
        event.type === "turn_end" || (event.type === "tool_end" && event.usage !== undefined),
      pushes: ["inf:tasks", "inf:tasks:delta"],
    },
    description:
      "Recorded model usage by period and kind of work, in tokens and estimated dollars.",
  }),
  // Read on opening and every minute: the setup lives in files and a shell the app does not watch.
  "usage.reporting": entry({
    channel: "inf:usage:reporting",
    args: noArgs,
    toRequest: () => [],
    invalidate: { pollMs: 60_000 },
    // i18n-exempt: served only to the first mate, as the read's description (src/core/pi/appReads.ts).
    description:
      "The host the usage report sends every model's work to, from a company's Claude Code reporting setup; claudeOnly when only Claude's own records go there, such as a setup over gRPC; null when no host is known, which includes Claude's own client reporting straight to a company setup this app cannot read; connection is the host of the reporting connection the person added in Settings → Intelligence, which gets the same work too.",
  }),
  "usage.tasks": entry({
    channel: "inf:usage:tasks",
    args: usageTasksQuerySchema,
    toRequest: (args) => [args],
    invalidate: {
      events: (event) =>
        event.type === "turn_end" || (event.type === "tool_end" && event.usage !== undefined),
      pushes: ["inf:tasks", "inf:tasks:delta"],
    },
    description:
      "The newest tasks with recorded usage by period and kind of work, and their count.",
  }),
  "usage.taskCosts": entry({
    channel: "inf:usage:task-costs",
    args: usageTaskCostsQuerySchema,
    toRequest: (args) => [args],
    invalidate: {
      events: (event) =>
        event.type === "turn_end" || (event.type === "tool_end" && event.usage !== undefined),
      pushes: ["inf:tasks", "inf:tasks:delta"],
    },
    // i18n-exempt: served only to the first mate, as the read's description (src/core/pi/appReads.ts).
    description:
      "Each task finished in a period, and in the week before it, with what it and its reviews spent in tokens and estimated dollars.",
  }),
  // The captain's own panels, as the app has them mounted right now
  // (talk-to-personalize Step 5). Observe's Panels group: not a session -
  // a mount has no transcript - but the one place a dev can see what
  // compiled, what is on a rail, what a server module exported, and which
  // one refused. The push IS the snapshot the core pushes on every
  // reconcile, so the read takes it as its value.
  "personal.mounts": entry({
    channel: "inf:plugins:personal:list",
    args: noArgs,
    toRequest: () => [],
    invalidate: { valueFromPush: "inf:plugins:personal" },
    description: "The personal panels the core has mounted, with their state (dev-only).",
  }),
  "quota.snapshot": entry({
    channel: "inf:quota:snapshot",
    args: noArgs,
    toRequest: () => [],
    invalidate: { pushes: ["inf:quota"] },
    description: "The latest quota reading across signed-in accounts.",
  }),
  "feed.recent": entry({
    channel: "inf:feed:recent",
    args: noArgs,
    toRequest: () => [],
    invalidate: { events: changesFeed },
    description: "The persisted activity feed, oldest first.",
  }),
  "crew.counts": entry({
    channel: "inf:crew:counts",
    args: noArgs,
    toRequest: () => [],
    invalidate: { events: (event) => event.type === "crew_counts" },
    description: "Live crew strip counts.",
  }),
  "repos.list": entry({
    channel: "inf:repos:list",
    args: noArgs,
    toRequest: () => [],
    invalidate: {
      events: (event) =>
        event.type === "repo_setup" ||
        event.type === "repo_configured" ||
        event.type === "repo_runs_on" ||
        event.type === "repo_batch" ||
        event.type === "repo_unregistered",
    },
    description:
      "The managed fleet. Setup, settings and removal are `app_change` lines shared with Settings.",
  }),
  "update.status": entry({
    channel: "inf:update:status",
    args: noArgs,
    toRequest: () => [],
    invalidate: { pollMs: 60_000 },
    description: "Whether a newer release is available.",
  }),
  // The task protocol (task-system P3). The board rides its own push, and
  // the push carries the board itself - the snapshot the core rebuilt from
  // SQLite after the commit, equal to a fresh read by construction
  // (taskProtocol.push.test.ts) - so a subscriber takes the pushed value as it
  // lands (P4: the now panel paints a row within one coalescing window of
  // the write) rather than re-reading on every task event; a detail
  // re-reads only when ITS task changes or gains a timeline event.
  "tasks.board": entry({
    channel: "inf:tasks:board",
    // `closed: false` asks for the board without its closed rows: a reader
    // that has no use for them yet, so a view's first read stays light.
    args: z.strictObject({ closed: z.literal(false).optional() }),
    toRequest: (args) => (args.closed === false ? [{ closed: false }] : []),
    narrows: {
      args: { closed: false },
      asksLess: (args) => args.closed === false,
      lesser: (value) => (value as TaskBoard).closedLeftOut !== undefined,
    },
    invalidate: {
      presentation: true,
      valueFromPush: "inf:tasks",
      // A newer board, or the whole board where a lesser one is held, is news.
      sameValue: (current, next) => {
        const held = current as TaskBoard;
        const read = next as TaskBoard;
        if (held.seq !== read.seq) return held.seq > read.seq;
        return held.closedLeftOut === undefined || read.closedLeftOut !== undefined;
      },
      // Above the measured trigger the core pushes what changed (P5); the
      // executor folds it onto the board it holds, and a gap re-reads.
      deltaFromPush: {
        channel: "inf:tasks:delta",
        apply: (current, delta) =>
          applyTaskBoardDelta(current as TaskBoard, delta as TaskBoardDelta),
      },
    },
    description:
      "The live task board: open, underway, and recently closed work. `closed: false` leaves out the closed rows a reader has no use for yet.",
  }),
  "tasks.detail": entry({
    channel: "inf:tasks:detail",
    args: taskArgs,
    toRequest: (args) => [args.id],
    invalidate: {
      presentation: true,
      // A card closing or leaving changes the record's Cards row too.
      pushes: ["inf:tasks", "inf:tasks:delta", "inf:cards"],
      // Its own browser's fact moves on every command the crewmate runs,
      // and so does its Now line, which a card's thread shows while the
      // crewmate works on the captain's reply (INF-990 friction 3).
      events: (event, args) =>
        event.type === "personalized" ||
        event.type === "repo_configured" ||
        event.type === "turn_end" ||
        (event.type === "tool_end" && event.usage !== undefined) ||
        ((event.type === "task_changed" ||
          event.type === "task_event" ||
          event.type === "task_browser" ||
          event.type === "tool_start" ||
          event.type === "tool_end") &&
          event.taskId === args.id),
    },
    description: "One task in full: goal, the captain's words, graph, report, timeline, delivery.",
  }),
  // The task card's Crewmate tab (docs/task-card-tabs.md, "The Crewmate
  // tab"): the crewmate's sessions as a transcript, re-read when the task
  // or its crewmate's calls move, and each second while it shows, since a
  // call's result lands in the session after the call's own event. An
  // answer whose sessions and record did not move is not delivered again.
  "tasks.crewmate": entry({
    channel: "inf:tasks:crewmate",
    args: taskArgs,
    toRequest: (args) => [args.id],
    invalidate: {
      events: (event, args) => CREWMATE_EVENTS.has(event.type) && taskIdOf(event) === args.id,
      pollMs: 1_000,
      sameValue: (current, next) =>
        (current as CrewTranscript).revision === (next as CrewTranscript).revision,
    },
    description:
      "One task's crewmate session as a transcript: its words, calls, blocks and what it was told.",
  }),
  // What the crewmate is writing in its running turn, before its session holds it.
  "tasks.crewmate.live": entry({
    channel: "inf:tasks:crewmate:live",
    args: taskArgs,
    toRequest: (args) => [args.id],
    invalidate: {
      events: (event, args) => CREWMATE_LIVE_EVENTS.has(event.type) && taskIdOf(event) === args.id,
      sameValue: (current, next) =>
        (current as CrewLive).text === (next as CrewLive).text &&
        (current as CrewLive).since === (next as CrewLive).since,
    },
    description: "What one task's crewmate is writing in its running turn, and since when.",
  }),
  // Typed text finds closed work the board no longer lists (FI3-579 piece
  // 3). Re-read when the board changes, so a dropped task appears at once.
  "tasks.search": entry({
    channel: "inf:tasks:search",
    args: z.strictObject({ query: z.string().max(200) }),
    toRequest: (args) => [args.query],
    invalidate: { pushes: ["inf:tasks", "inf:tasks:delta"] },
    description: "Closed work older than the board's window, or dropped, matching typed text.",
  }),
  // The tasks the window's words name by exact key, live or closed at any
  // age (INF-3896): one request for every key the board does not list.
  "tasks.keys": entry({
    channel: "inf:tasks:keys",
    args: z.strictObject({
      keys: z.array(z.string().min(1).max(64)).min(1).max(TASK_KEYS_PER_READ),
    }),
    toRequest: (args) => [args.keys],
    invalidate: { pushes: ["inf:tasks", "inf:tasks:delta"] },
    description: "Recorded tasks, live or closed at any age, with exactly these keys.",
  }),
  "projects.list": entry({
    channel: "inf:projects:list",
    args: noArgs,
    toRequest: () => [],
    invalidate: {
      presentation: true,
      pushes: ["inf:tasks", "inf:tasks:delta"],
      events: (event) =>
        event.type === "repo_setup" ||
        event.type === "repo_configured" ||
        event.type === "repo_runs_on" ||
        event.type === "repo_batch" ||
        event.type === "repo_unregistered",
    },
    description: "Scratch plus every project the managed repositories belong to, with live counts.",
  }),
  // The person's open proposed changes where their projects live (git
  // integration PR 1.2), read through the app's own sign-in: one request,
  // re-read when a sign-in changes and every five minutes while a panel
  // shows it. Not signed in, it answers empty and says so.
  "forge.changes": entry({
    channel: "inf:forges:changes",
    args: noArgs,
    toRequest: () => [],
    invalidate: { pushes: ["inf:forges"], pollMs: 300_000 },
    description:
      "Your open pull requests where your projects live, newest first, with their checks.",
  }),
  // Knowledge (docs/knowledge.md, "The browser"), in alpha and development
  // builds only: the collections and their counts, a bounded graph of one
  // collection's concepts, its Concepts and Findings a page at a time, and
  // one entry whole. Scoped as Firstmate's reads are; a stable build refuses
  // each before it opens the collection. Re-read after a write and when a
  // project comes or goes; a finding's sources are checked again then.
  "knowledge.collections": entry({
    channel: "inf:knowledge:collections",
    args: noArgs,
    toRequest: () => [],
    invalidate: {
      events: (event) => KNOWLEDGE_EVENTS.has(event.type),
    },
    description:
      "Each knowledge collection, private first, with its concepts, findings and directions counted.",
  }),
  "knowledge.graph": entry({
    channel: "inf:knowledge:graph",
    args: knowledgeGraphArgsSchema,
    toRequest: (args) => [args],
    invalidate: { events: (event) => KNOWLEDGE_EVENTS.has(event.type) },
    description:
      "One collection's concepts and their connections, at most 75 and 200, with what was left out.",
  }),
  "knowledge.concepts": entry({
    channel: "inf:knowledge:concepts",
    args: knowledgeConceptsArgsSchema,
    toRequest: (args) => [args],
    invalidate: { events: (event) => KNOWLEDGE_EVENTS.has(event.type) },
    description: "A page of one collection's concepts, by name or as typed words find them.",
  }),
  "knowledge.findings": entry({
    channel: "inf:knowledge:findings",
    args: knowledgeFindingsArgsSchema,
    toRequest: (args) => [args],
    invalidate: { events: (event) => KNOWLEDGE_EVENTS.has(event.type) },
    description:
      "A page of one collection's findings with their standing, filtered for rechecking or differing evidence.",
  }),
  "knowledge.entry": entry({
    channel: "inf:knowledge:entry",
    args: knowledgeEntryArgsSchema,
    toRequest: (args) => [args],
    invalidate: { events: (event) => KNOWLEDGE_EVENTS.has(event.type) },
    description: "One concept or finding whole: its evidence, checks, history and declared uses.",
  }),
  "knowledge.directions": entry({
    channel: "inf:knowledge:directions",
    args: knowledgeDirectionsArgsSchema,
    toRequest: (args) => [args],
    invalidate: {
      events: (event) => KNOWLEDGE_EVENTS.has(event.type),
    },
    description: "Standing directions for one project, with their origin, never ordinary findings.",
  }),
  "knowledge.direction": entry({
    channel: "inf:knowledge:direction",
    args: knowledgeDirectionArgsSchema,
    toRequest: (args) => [args],
    invalidate: {
      events: (event) => KNOWLEDGE_EVENTS.has(event.type),
    },
    description: "One standing direction and its paged edit history, read-only.",
  }),
  // The entries a card body names, for its references, and what one task's
  // work declared it used, for its record: re-read after a write, as the
  // browser's are.
  "knowledge.refs": entry({
    channel: "inf:knowledge:refs",
    args: knowledgeRefsArgsSchema,
    toRequest: (args) => [args],
    invalidate: { events: (event) => KNOWLEDGE_EVENTS.has(event.type) },
    description: "The concepts and findings among the ids a card names, with where each stands.",
  }),
  "knowledge.uses": entry({
    channel: "inf:knowledge:uses",
    args: knowledgeUsesArgsSchema,
    toRequest: (args) => [args],
    invalidate: { events: (event) => KNOWLEDGE_EVENTS.has(event.type) },
    description:
      "What one task's work declared it used: each revision it relied on beside the current one.",
  }),
  // The captain's preferences (talk-to-personalize Step 1): the theme and
  // the rail layout the host applies to the window. Written by the window's
  // own controls and by the Firstmate's `personalize` tool alike; every
  // write pushes the whole value, so the read takes the push as its own.
  "shell.preferences": entry({
    channel: "inf:shell:preferences",
    args: noArgs,
    toRequest: () => [],
    invalidate: { valueFromPush: "inf:shell:preferences" },
    description:
      "The theme, the rail layout, and the panels switch the host applies for the captain.",
  }),
  // The app settings a panel may read (primitives/live-reads.md,
  // "settings.current"): each named action catalog line's panel value, and
  // never a line without one. A look change pushes the whole preferences;
  // every other catalog change leaves a `personalized` line.
  "settings.current": entry({
    channel: "inf:settings:current",
    args: z.strictObject({ names: panelSettingNamesSchema }),
    toRequest: (args) => [args.names],
    invalidate: {
      pushes: ["inf:shell:preferences"],
      events: (event) => event.type === "personalized",
      sameValue: (current, next) => JSON.stringify(current) === JSON.stringify(next),
    },
    // i18n-exempt: told to a panel's author and the crew, never shown in the window
    description:
      "The current value of each named app setting a panel may read: look, sound and a few switches.",
  }),
  // The record, through SQL (plugin data surface, Phase B; src/shared/sql.ts):
  // a read-only query over the published views the plugin's grant names -
  // the host adds the grant, so a subscriber passes the query alone and a
  // plugin with no grant reaches nothing. Live the way the captain's B3
  // decided: after any app event (and a quota reading, which is not one)
  // the host re-runs it on the 40 ms coalescing tick, the query process
  // answers from what it has unless the database's `data_version` moved,
  // and an answer that says the same thing is not delivered again.
  sql: entry({
    channel: "inf:sql:query",
    args: sqlQuerySchema,
    toRequest: (args, grant) => [{ ...args, views: [...(grant.sql ?? [])] as never }],
    invalidate: {
      events: () => true,
      pushes: ["inf:quota"],
      sameValue: sameSqlAnswer,
    },
    description: "A read-only SQL query over the published views of the app's record.",
  }),
} as const;

export type ReadCatalog = typeof readCatalog;
export type ReadName = keyof ReadCatalog;
export type ReadArgs<N extends ReadName> = z.input<ReadCatalog[N]["args"]>;
export type ReadResult<N extends ReadName> = InvokeResponse<ReadCatalog[N]["channel"]>;

export const READ_NAMES = Object.keys(readCatalog) as ReadName[];

export function isReadName(name: string): name is ReadName {
  return Object.hasOwn(readCatalog, name);
}
