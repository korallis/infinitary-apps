import { statSync } from "node:fs";
import type { Agent } from "node:http";
import { resolve as resolvePath } from "node:path";
import type { FmEvent } from "@shared/events";
import { isProgressTool } from "@shared/events";
import type { UsageWorkKind } from "@shared/usage";
import { type CertificateFiles, collectorAgent, postOtlpHttp } from "../claude/claudeReporting";
import type { UsageRow } from "../storage/usageStore";
import {
  callSpan,
  claudeCodeBodies,
  newSpanId,
  newTraceId,
  type OtlpBodies,
  type OtlpSignal,
  type ReportedRow,
  type ReportedSpan,
  standardBodies,
  type UsageReportFormat,
  type UsageRole,
} from "./usageReportFormats";

/**
 * One place usage is reported to, in exactly one format. Its sources (a
 * company's Claude Code setup, a connection the person adds) own where it
 * comes from; the reporter only sends.
 */
export type UsageReportDestination = {
  /** Stable while the destination is unchanged; names it in log lines with its host. */
  id: string;
  format: UsageReportFormat;
  /** Full OTLP/HTTP URL per signal; a signal without one is not sent there. */
  endpoints: Partial<Record<OtlpSignal, string>>;
  /**
   * The certificate files a secure signal is sent with, as Claude's client
   * sends its own reports; a secure signal without them is checked against
   * the computer's trusted list.
   */
  certificates?: Partial<Record<OtlpSignal, CertificateFiles>>;
  /** Asked per batch; values often hold a token, so they are never logged. */
  headers(signal: OtlpSignal): Promise<Record<string, string>>;
  /** The destination's own resource attributes, such as which team. */
  resource: Record<string, string>;
  /**
   * Who the work is for, on each point and event, where Claude's client puts
   * it (`user.email`): a per-person panel groups by it, not by the resource.
   */
  person?: Record<string, string>;
};

export type UsageReporterOptions = {
  destinations(): readonly UsageReportDestination[];
  /** The saved work kind of a task, for grouping; never its title or project. */
  workKind(taskId: string): UsageWorkKind | null;
  /** Whether a task id is a task on the record (otherwise its work is `other`). */
  isTask(taskId: string): boolean;
  firstmateTaskId: string;
};

/** A batch goes this long after its first row or span, as Claude's client batches its own reports. */
const BATCH_MS = 5_000;

/** A turn heard but never ended, such as a session that crashed, is forgotten after this long. */
const TURN_FORGET_MS = 6 * 60 * 60 * 1000;

const POST_TIMEOUT_MS = 10_000;

type Turn = {
  traceId: string;
  spanId: string;
  start: number;
  /** The last call's moment, where the next call's span starts. */
  since: number;
  open: boolean;
  /** A step of it ended in a provider error. */
  failed: boolean;
  tools: Map<string, { name: string; start: number }>;
};

/**
 * Infinitary's own usage report (docs/usage-report.md): every ledger row and
 * every heard turn, batched, projected per destination into its one format
 * and posted as OTLP/HTTP JSON. Reporting never blocks a turn: a refused or
 * unreachable destination drops its batch with one log line.
 */
export class UsageReporter {
  private rows: ReportedRow[] = [];
  private spans: ReportedSpan[] = [];
  private batchSince: number;
  private readonly turns = new Map<string, Turn>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Each destination signal's kept connections, made again when its address,
   * a certificate file's path or that file's last change moves, so a
   * certificate renewed in place is sent from the next batch, while a file
   * is read, and a file that cannot be read is logged, once per change
   * rather than per batch.
   */
  private readonly connections = new Map<string, { made: string; agent: Agent }>();

  constructor(private readonly options: UsageReporterOptions) {
    this.batchSince = Date.now();
  }

  /** Sends what is waiting, once, as the app stops. */
  async stop(): Promise<void> {
    await this.flush();
  }

  /** A batch goes a while after its first row or span; nothing waits while nothing is queued. */
  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush(), BATCH_MS);
    this.timer.unref?.();
  }

  private active(): boolean {
    if (this.options.destinations().length > 0) return true;
    this.rows = [];
    this.spans = [];
    this.turns.clear();
    return false;
  }

  /** The rows `UsageStore.record` just wrote. */
  recorded(rows: readonly UsageRow[]): void {
    if (rows.length === 0 || !this.active()) return;
    for (const row of rows) {
      const turn = this.turns.get(row.taskId);
      const reported: ReportedRow = {
        ...row,
        role: this.roleOf(row.taskId),
        workKind: this.options.workKind(row.taskId),
        ...(turn
          ? { parent: { traceId: turn.traceId, spanId: turn.spanId, since: turn.since } }
          : {}),
      };
      if (turn) turn.since = row.at;
      this.rows.push(reported);
      this.spans.push(callSpan(reported));
    }
    this.schedule();
  }

  /**
   * Every broadcast event; only a session's step and tool events and the
   * moments its owner settles the turn are read. A session ends a step
   * (`turn_end`, `turn_failed`) per model call, so a turn ends only where
   * its owner settles it: the first mate no longer busy, a crewmate's task
   * no longer running, or the task finished.
   */
  heard(event: FmEvent): void {
    if (
      event.type !== "assistant_delta" &&
      event.type !== "thinking_delta" &&
      event.type !== "tool_start" &&
      event.type !== "tool_end" &&
      event.type !== "turn_failed" &&
      event.type !== "task_changed" &&
      event.type !== "firstmate_state" &&
      event.type !== "task_finished"
    ) {
      return;
    }
    if (!this.active()) return;
    const at = Date.now();
    if (event.type === "firstmate_state") {
      if (!event.busy) this.settle(this.options.firstmateTaskId, at, false);
      return;
    }
    if (event.type === "task_changed") {
      if (event.activity !== "running" && event.activity !== "starting")
        this.settle(event.taskId, at, false);
      return;
    }
    if (event.type === "task_finished") {
      this.settle(event.taskId, at, event.status !== "completed");
      this.turns.delete(event.taskId);
      return;
    }
    if (event.type === "turn_failed") {
      const turn = this.turns.get(event.taskId);
      if (turn?.open) turn.failed = true;
      return;
    }
    const turn = this.openTurn(event.taskId, at);
    if (event.type === "tool_start" && !isProgressTool(event.toolName)) {
      turn.tools.set(event.callId, { name: event.toolName, start: at });
    } else if (event.type === "tool_end") {
      const tool = turn.tools.get(event.callId);
      if (tool) {
        turn.tools.delete(event.callId);
        this.spans.push({
          traceId: turn.traceId,
          spanId: newSpanId(),
          parentSpanId: turn.spanId,
          name: `execute_tool ${tool.name}`,
          kind: "internal",
          start: tool.start,
          end: at,
          failed: event.isError,
          attributes: {
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": tool.name,
            "gen_ai.tool.call.id": event.callId,
          },
        });
        this.schedule();
      }
    }
  }

  /** Ends the task's open turn, if it has one. */
  private settle(taskId: string, at: number, failed: boolean): void {
    const turn = this.turns.get(taskId);
    if (!turn?.open) return;
    this.endTurn(taskId, turn, at, failed || turn.failed);
    this.schedule();
  }

  private roleOf(taskId: string): UsageRole {
    if (taskId === this.options.firstmateTaskId) return "firstmate";
    return this.options.isTask(taskId) ? "crewmate" : "other";
  }

  /** The task's open turn, or a new one; a closed turn stays as the parent of calls recorded just after it ended. */
  private openTurn(taskId: string, at: number): Turn {
    const held = this.turns.get(taskId);
    if (held?.open) return held;
    for (const [id, turn] of this.turns) {
      if (at - turn.start > TURN_FORGET_MS) this.turns.delete(id);
    }
    const turn: Turn = {
      traceId: newTraceId(),
      spanId: newSpanId(),
      start: at,
      since: at,
      open: true,
      failed: false,
      tools: new Map(),
    };
    this.turns.set(taskId, turn);
    return turn;
  }

  private endTurn(taskId: string, turn: Turn, at: number, failed: boolean): void {
    turn.open = false;
    const role = this.roleOf(taskId);
    const workKind = this.options.workKind(taskId);
    this.spans.push({
      traceId: turn.traceId,
      spanId: turn.spanId,
      name: `invoke_agent ${role}`,
      kind: "internal",
      start: turn.start,
      end: at,
      failed,
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": role,
        "infinitary.role": role,
        ...(workKind ? { "infinitary.work_kind": workKind } : {}),
      },
    });
  }

  /** Sends what is waiting to every destination, each in its own format. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const rows = this.rows;
    const spans = this.spans;
    const since = this.batchSince;
    this.rows = [];
    this.spans = [];
    this.batchSince = Date.now();
    if (rows.length === 0 && spans.length === 0) return;
    await Promise.all(
      this.options.destinations().map(async (destination) => {
        const bodies: OtlpBodies =
          destination.format === "claude-code"
            ? claudeCodeBodies(rows, destination.resource, since, destination.person)
            : standardBodies(rows, spans, destination.resource, since);
        await Promise.all(
          (Object.keys(bodies) as OtlpSignal[]).map((signal) =>
            this.send(destination, signal, bodies[signal]),
          ),
        );
      }),
    );
  }

  private async send(
    destination: UsageReportDestination,
    signal: OtlpSignal,
    body: unknown,
  ): Promise<void> {
    const url = destination.endpoints[signal];
    if (!url) return;
    try {
      const answer = await postOtlpHttp(
        url,
        this.connection(destination, signal, url),
        Buffer.from(JSON.stringify(body)),
        "application/json",
        await destination.headers(signal),
        POST_TIMEOUT_MS,
      );
      if (answer.failure === "refused")
        console.warn(
          `[usage report] ${hostOf(url)} refused a ${signal} batch (HTTP ${answer.status}); dropped`,
        );
      else if (answer.failure)
        console.warn(
          `[usage report] ${hostOf(url)} unreachable for a ${signal} batch (${answer.failure}); dropped`,
        );
    } catch (caught) {
      const reason = caught instanceof Error ? caught.name : "error";
      console.warn(
        `[usage report] ${hostOf(url)} unreachable for a ${signal} batch (${reason}); dropped`,
      );
    }
  }

  private connection(destination: UsageReportDestination, signal: OtlpSignal, url: string): Agent {
    const files = destination.certificates?.[signal];
    // A relative certificate path resolves against the folder the app runs in.
    const cwd = process.cwd();
    const made = JSON.stringify([url, files ?? null, changedAt(files, cwd)]);
    const id = `${destination.id} ${signal}`;
    const held = this.connections.get(id);
    if (held?.made === made) return held.agent;
    // The replaced connections are left to close once idle, not destroyed:
    // a batch still in flight on one finishes.
    const agent = collectorAgent(url, files, cwd, (line) =>
      console.warn(`[usage report] ${hostOf(url)}: ${line}`),
    );
    this.connections.set(id, { made, agent });
    return agent;
  }
}

/** When each named certificate file last changed, or null for one that is not named or cannot be read. */
function changedAt(files: CertificateFiles | undefined, cwd: string): (number | null)[] {
  return [files?.ca, files?.cert, files?.key].map((path) => {
    if (!path) return null;
    try {
      return statSync(resolvePath(cwd, path)).mtimeMs;
    } catch {
      return null;
    }
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unreadable";
  }
}
