import { randomUUID } from "node:crypto";
import { type Query, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { PROGRESS_TOOL_NAMES } from "@shared/events";
import type { Reasoning } from "@shared/reasoning";
import type { ServedInstructions, ServedState } from "../orchestrator/seat";
import { TICK_PERIOD_MS } from "../orchestrator/ticker";
import { outputCapErrorMessage, type SessionClock } from "../session/bounds";
import {
  type PersonalResourceDigests,
  personalPluginSource,
  personalResources,
} from "../session/personalResources";
import { projectSkillFolders } from "../session/projectResources";
import {
  type ContractStamp,
  type ModelSession,
  type SafeStopOptions,
  type SafeStopOutcome,
  type SessionEvent,
  type SessionImage,
  type SessionRenewal,
  type SessionResume,
  type SessionSpec,
  StoppedBeforeStartError,
  type ThinkingLevel,
} from "../session/session";
import { claimStagingFolder, type StagingFolder } from "../session/stagingFolders";
import type { SessionRecordStore } from "../storage/sessionRecordStore";
import { assertClaudeWorkSettings } from "./claudeAccess";
import { ClaudeCallUsage } from "./claudeCallUsage";
import { resolveClaudeExecutable } from "./claudeCli";
import { ClaudeClientExit } from "./claudeClientProcess";
import type { ClaudeCostSubscription } from "./claudeCostReports";
import {
  type ClaudeNormalizeResult,
  type ClaudeTurnFailure,
  createNormalizerState,
} from "./claudeEvents";
import { canonicalClaudeModelId } from "./claudeModelCatalog";
import { claudeModelName } from "./claudeModels";
import { type ClaudeProjectResources, claudeProjectResources } from "./claudeProjectResources";
import {
  CLAUDE_CONTROL_PROFILE,
  CLAUDE_MODEL_PROVIDER,
  ClaudeQueryCore,
  type ClaudeSessionDeps,
  claudeLoginStore,
  MessageQueue,
  noteTo,
  refuseMissingClient,
  userMessage,
} from "./claudeQueryCore";
import { companyForward, receiverStepsAside, withoutReportingKeys } from "./claudeReporting";
import { ClaudeSafeStop } from "./claudeSafeStop";
import { CLAUDE_STEER_PRIORITY, claudeSessionOptions } from "./claudeSessionOptions";
import { ClaudeSessionRecord, type Pushed, sha256 } from "./claudeSessionRecord";
import { acquireSessionLease } from "./claudeStoreLease";
import type { ClaudeTranscriptLookup } from "./claudeTranscript";
import { claudeCodingReasoning } from "./reasoning";

/** The progress a shortening of the conversation reports itself by, as Pi's does. */
const [FOLD_TOOL] = PROGRESS_TOOL_NAMES;

/**
 * The rolling Claude session: one conversation across prompts, steers and
 * client attachments, for the seat and the crewmate (`session.ts` says how
 * the shape is served). Its durable record is `ClaudeSessionRecord`, its
 * safe stop `ClaudeSafeStop`, and the options each attachment hands the
 * client `claudeSessionOptions`.
 */

/** What a prompt or steer on a disposed rolling session is told. */
const ENDED_TEXT = "This Claude session has ended.";

/** What a continuation the client's exit cut short, or a prompt it stranded, is told. */
const STOPPED_TEXT = "Claude stopped before the turn finished.";

type Connection = {
  /** The session id this client runs, which a renewal can leave behind. */
  sessionId: string;
  query: Query;
  input: MessageQueue;
  /** The effort the client is serving at right now. */
  effort: ThinkingLevel | "off";
  /** The session is ending this attachment itself; its stream's end is expected. */
  closing: boolean;
  /** When the session ended its input; a client still running a tick later is stopped. */
  closedAt?: number;
  /** Resolves once the stream is over, the client has exited and the lease is back. */
  done: Promise<void>;
  /** Hands this client's lease on the account's store back. */
  release: () => void;
  costReports?: ClaudeCostSubscription;
};

/** One prompt's caller, owned by its starting or running turn. */
type Completion = { resolve: () => void; reject: (error: Error) => void };
type Steer = { text: string; images?: SessionImage[] };
type Interrupt = { at: number; cut?: string };
type Starting = {
  kind: "starting";
  completion: Completion;
  early: Steer[];
  stopAsked?: Interrupt;
};
type Running = {
  kind: "running";
  pushed: Pushed[];
  ran: boolean;
  failed: boolean;
  interrupt?: Interrupt;
} & ({ by: "prompt"; completion: Completion } | { by: "continuation" });
/** Idle keeps the last inputs only for a replay acknowledgement arriving after the boundary. */
type Turn = { kind: "idle"; pushed: Pushed[] } | Starting | Running;
type Life = "open" | "disposing" | "disposed" | "retired";

/** What a rolling session runs on, resolved at open. */
type RollingConfig = {
  accountId: string;
  env: NodeJS.ProcessEnv;
  /** The app's own record of the session, in the spec's record dir. */
  store: SessionRecordStore;
  stamp: ContractStamp | undefined;
  clock: SessionClock;
};

export class ClaudeRollingSession extends ClaudeQueryCore<SessionEvent> implements ModelSession {
  readonly controlProfile = CLAUDE_CONTROL_PROFILE;
  private connection: Connection | undefined;
  private calls = this.callUsage();
  /**
   * The model every attachment asks the client for: the spec's, else the
   * one a resumed session ran on before the client swapped it, else the
   * first one the client reported. Never what the client swapped in, so a
   * reattach or a resume does not keep a refusal fallback on its own.
   */
  private asked: string | undefined;
  /** The model the client last said answers, as Infinitary names it; what the session reports. */
  private answering: string | undefined;
  private instructions: ServedInstructions | undefined;
  /** New instructions wait for the next prompt's attachment. */
  private reopen = false;
  private wantedEffort: ThinkingLevel | "off";
  private turn: Turn = { kind: "idle", pushed: [] };
  private life: Life = "open";
  /** Steers that arrived while no prompt could take them, for the next one. */
  private held: string[] = [];
  /** The client reports its session state; without it a result settles. */
  private statesSeen = false;
  /**
   * Where the client's own shortening of the conversation stands: running
   * from its compacting status, ended once one of its two end signals (the
   * status's result or the compact boundary) is heard and until the other.
   */
  private folding: "idle" | "running" | "ended" = "idle";
  private acksSeen = false;
  /** Run once the open turn settles: a dispose or a detach waiting for it. */
  private afterSettle: (() => void)[] = [];
  /** The last settled prompt's messages, where `servedState` locates them. */
  private served: Pushed[] | undefined;
  /** The session this one started over from, until the owner takes it. */
  private renewal: SessionRenewal | undefined;
  /** The client took a prompt under the current id: a reattach resumes it. */
  private tookPrompt = false;
  private readonly retirement: { promise: Promise<void>; resolve: () => void };
  private readonly record: ClaudeSessionRecord;
  private readonly safeStop = new ClaudeSafeStop(() => void this.interrupt());

  constructor(
    private id: string,
    private readonly spec: SessionSpec,
    private readonly config: RollingConfig,
    private readonly deps: ClaudeSessionDeps,
    private readonly unregister: () => void,
    transcripts: ClaudeTranscriptLookup,
  ) {
    super(spec.owner);
    this.record = new ClaudeSessionRecord(config.store, transcripts, config.clock, (line) =>
      this.note(line),
    );
    this.asked = spec.model?.id;
    this.instructions = spec.instructions.served;
    // Coding care is fixed at open; only the seat changes effort per turn.
    this.wantedEffort = spec.thinking.quick ? "off" : spec.thinking.level;
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    this.retirement = { promise, resolve };
  }

  /** Resolves once the session is disposed, its client has exited and the account's store is free. */
  closed(): Promise<void> {
    return this.retirement.promise;
  }

  /** The id the client runs under: the resumed one, or the one a renewal minted. */
  get sessionId(): string {
    return this.id;
  }

  resume(): SessionResume {
    return { backend: "claude", sessionId: this.sessionId };
  }

  /** The app's copy of the client's transcript: the session's durable record. */
  recordPath(): string;
  recordPath(options: { refresh?: boolean }): string | Promise<string>;
  recordPath(options?: { refresh?: boolean }): string | Promise<string> {
    const path = this.config.store.transcriptPath(this.sessionId);
    const pending = options?.refresh
      ? this.record.bringUp(this.connection?.sessionId ?? this.id)
      : undefined;
    return pending ? pending.then(() => path) : path;
  }

  isStreaming(): boolean {
    return this.turn.kind !== "idle";
  }

  modelRef(): { provider: string; id: string } | undefined {
    const id = this.answering ?? this.asked;
    return id ? { provider: CLAUDE_MODEL_PROVIDER, id } : undefined;
  }

  modelLabel(): string | undefined {
    return claudeModelName(this.answering ?? this.asked);
  }

  prompt(text: string, images?: SessionImage[]): Promise<void> {
    if (this.life !== "open") return Promise.reject(new Error(ENDED_TEXT));
    if (this.isStreaming()) {
      // Overwriting the running turn would orphan whoever awaits it; work
      // for a running turn belongs in steer().
      return Promise.reject(new Error("This session is still working on its current turn."));
    }
    this.served = undefined;
    return new Promise<void>((resolve, reject) => {
      const mine: Starting = { kind: "starting", completion: { resolve, reject }, early: [] };
      this.turn = mine;
      void this.start(mine, text, images);
    });
  }

  private async start(mine: Starting, text: string, images?: SessionImage[]): Promise<void> {
    let connection: Connection;
    try {
      connection = await this.attach(mine);
      await this.applyEffort(connection);
    } catch (caught) {
      if (this.turn === mine) this.settle(caught);
      return;
    }
    // A late attach never hands an abandoned prompt to the client.
    if (this.turn !== mine) return;
    if (this.safeStop.cut) {
      this.settle(new StoppedBeforeStartError());
      return;
    }
    const running: Running = {
      kind: "running",
      by: "prompt",
      completion: mine.completion,
      pushed: [],
      ran: false,
      failed: false,
    };
    this.turn = running;
    this.push(connection, "prompt", text, images);
    for (const steer of mine.early) this.push(connection, "steer", steer.text, steer.images);
    // Keep a stop asked before attachment; only interrupt after the prompt
    // and its early steers are in the client's input.
    if (mine.stopAsked || this.life === "disposing") {
      // A bound watches from its request; a plain stop watches from send.
      if (mine.stopAsked?.cut !== undefined) running.interrupt = mine.stopAsked;
      void this.interrupt();
    } else void this.readAhead();
  }

  /** A seat's record is read ahead of its turns' ends (`ClaudeSessionRecord.readAhead`); a coding session's owner never asks. */
  async readAhead(): Promise<void> {
    if (this.spec.builtins === "coding") return;
    const sessionId = this.sessionId;
    await this.record.readAhead(
      sessionId,
      () => sessionId === this.sessionId && this.life !== "retired",
    );
  }

  /** Honored when the spec asked for a per-turn level (WI-13). */
  setThinkingLevel(level: ThinkingLevel): void {
    if (!this.spec.thinking.perTurn) return;
    this.wantedEffort = level;
  }

  /** A coding session's effort is set once, on its opening query. */
  reasoning(): Reasoning | undefined {
    return this.spec.builtins === "coding" && this.spec.model
      ? claudeCodingReasoning(this.spec)
      : undefined;
  }

  serveInstructions(instructions: ServedInstructions): void {
    if (this.instructions?.sha === instructions.sha) return;
    // Never mid-turn: a change waits for the next prompt's own boundary. A
    // prompt cannot be patched in place, so the next prompt reattaches -
    // under a new id when the client has recorded this one (`renewIfChanged`).
    if (this.isStreaming()) return;
    this.instructions = instructions;
    this.reopen = true;
    this.renewIfChanged();
    void this.stampContract().catch((error: unknown) =>
      this.note(`the contract stamp was not written: ${String(error)}`),
    );
  }

  takeRenewal(): SessionRenewal | undefined {
    const renewal = this.renewal;
    this.renewal = undefined;
    return renewal;
  }

  /**
   * Start over under a new id when the prompt array this session would serve
   * is not the one its client started under (`changedSinceStart` says when).
   * The app's copy of the old session stays; a client still attached exits
   * at the next attach and its copy is finished under its own id.
   */
  renewIfChanged(): void {
    const changed = this.record.changedSinceStart(
      this.id,
      this.config.stamp,
      this.instructions?.sha,
      this.tookPrompt,
    );
    if (changed) this.renewFor(changed);
  }

  /** Claude restores its recorded opening prompt; renew when the personal opt-in or files changed. */
  async renewPersonalIfChanged(): Promise<void> {
    if (this.spec.builtins !== "coding" || this.record.clientTranscript(this.id) === null) return;
    const previous = this.record.personalAtStart(this.id);
    const current = this.spec.personalResources
      ? personalResources(
          this.spec.personalRoot ?? this.config.env.HOME,
          new Set(projectSkillFolders(this.spec.cwd).map((skill) => skill.name)),
          await personalPluginSource(this.spec.personalRoot),
        ).digests
      : undefined;
    if (JSON.stringify(previous) !== JSON.stringify(current)) this.renewFor(["instructions"]);
  }

  private renewFor(changed: ("prompt" | "instructions")[]): void {
    const from = this.id;
    this.record.mirror(from);
    // The old id's entries are never read again; its copy on disk stays.
    this.record.release(from);
    this.id = randomUUID();
    this.tookPrompt = false;
    this.reopen = true;
    this.served = undefined;
    this.renewal = { from, changed };
    this.note(
      `the ${changed.join(" and ")} changed since session ${from} started; starting ${this.id}`,
    );
  }

  /**
   * Into the running turn - a prompt's or a continuation's - at its next
   * step; with no turn to join, held for the owner to take back.
   */
  steer(text: string, images?: SessionImage[]): Promise<void> {
    if (this.life !== "open") return Promise.reject(new Error(ENDED_TEXT));
    const connection = this.connection;
    if (this.safeStop.stopping) {
      // A stopping turn takes nothing more: the owner has it back at its end.
      this.held.push(text);
    } else if (this.turn.kind === "running" && connection) {
      this.push(connection, "steer", text, images);
    } else if (this.turn.kind === "starting") {
      // The client is still starting: the steer follows the prompt in.
      this.turn.early.push({ text, ...(images ? { images } : {}) });
    } else {
      this.held.push(text);
    }
    return Promise.resolve();
  }

  takeUndeliveredSteers(): string[] {
    if (this.isStreaming()) return [];
    return this.held.splice(0);
  }

  /**
   * Interrupt the running turn. With a failure (a watched bound's, say), the
   * cut turn reports it as a failed turn. A client that does not answer the
   * interrupt within a tick is stopped, and the turn ends anyway.
   */
  async abort(failure?: string): Promise<void> {
    await this.interrupt(failure);
  }

  /** The safe stop (`ModelSession.stopSafely`, `ClaudeSafeStop`); a steer from now on is held for the owner. */
  stopSafely(options: SafeStopOptions = {}): Promise<SafeStopOutcome> {
    return this.safeStop.ask(options, this.isStreaming());
  }

  protected get disposed(): boolean {
    return this.life === "disposed" || this.life === "retired";
  }

  protected get interrupted(): boolean {
    return this.turn.kind === "running" && this.turn.interrupt !== undefined;
  }

  private async interrupt(failure?: string): Promise<void> {
    const turn = this.turn;
    if (turn.kind === "idle") return;
    const previous = turn.kind === "starting" ? turn.stopAsked : turn.interrupt;
    const interrupt =
      failure !== undefined && previous?.cut === undefined
        ? { at: this.config.clock.now(), cut: failure }
        : (previous ?? { at: this.config.clock.now() });
    if (turn.kind === "starting") {
      turn.stopAsked = interrupt;
      return;
    }
    const connection = this.connection;
    if (!connection || connection.closing) return;
    turn.interrupt = interrupt;
    try {
      await connection.query.interrupt();
    } catch (caught) {
      this.note(`interrupt failed: ${String(caught)}`);
    }
  }

  /**
   * Ends input only after a settled turn - an open prompt or continuation
   * is interrupted first - and lets the client exit on its own, which is
   * when it writes the last of its transcript. The store stays leased until
   * it has.
   */
  dispose(): void {
    if (this.life !== "open") return;
    this.life = "disposing";
    const finish = () => {
      this.life = "disposed";
      const connection = this.connection;
      if (connection) this.close(connection);
      else this.retire();
    };
    if (this.isStreaming()) {
      this.afterSettle.push(finish);
      void this.interrupt();
    } else {
      finish();
    }
  }

  /**
   * End the client at an idle boundary - after the open prompt or
   * continuation settles, never mid-turn - and hand the account's store
   * back once it has exited. The next prompt reattaches, resuming the
   * session. The owner detaches before anything else may rewrite that store
   * (a sign-in or sign-out) and while the session is benched.
   */
  detach(): Promise<void> {
    return new Promise((resolve) => {
      const end = () => {
        const connection = this.connection;
        if (!connection) {
          resolve();
          return;
        }
        this.close(connection);
        void connection.done
          .then(() => this.record.refreshMirror(connection.sessionId))
          .then(resolve);
      };
      if (this.isStreaming()) this.afterSettle.push(end);
      else end();
    });
  }

  /**
   * Where the last prompt and its steers landed in the recorded transcript
   * (R2 provenance), read from the app's copy as it stands. The client
   * writes its transcript on its own schedule, so a location it has not
   * written yet is null here; the sidecar's served stamp keeps the ids to
   * find it by once it has.
   */
  servedState(): ServedState | undefined {
    const served = this.served;
    if (!served) return undefined;
    this.record.mirror(this.id);
    return this.record.locate(this.sessionId, served);
  }

  /**
   * One tick of the host's clock. The client writes its transcript on its
   * own schedule, so the tail of a turn can land after the idle boundary
   * copied it; while a client stays attached (a crewmate's does, between
   * prompts), each tick brings the app's copy up to it. Then the client's
   * hygiene.
   */
  tick(now: number): void {
    if (this.connection) this.record.mirror(this.connection.sessionId);
    this.checkClient(now);
  }

  /**
   * A client that has not done what it was asked a tick later is stopped:
   * one still running after its input ended, and one that never answered
   * an interrupt - that turn ends anyway, failed when a failing abort cut it.
   */
  checkClient(now: number): void {
    const connection = this.connection;
    if (
      connection?.closing &&
      connection.closedAt !== undefined &&
      now - connection.closedAt >= TICK_PERIOD_MS
    ) {
      this.close(connection, true);
    }
    // The interrupt never landed within a tick: the client is wedged.
    const turn = this.turn;
    const asked =
      turn.kind === "starting"
        ? turn.stopAsked?.cut !== undefined
          ? turn.stopAsked.at
          : undefined
        : turn.kind === "running" && !connection?.closing
          ? turn.interrupt?.at
          : undefined;
    if (this.isStreaming() && asked !== undefined && now - asked >= TICK_PERIOD_MS) this.abandon();
  }

  /** Write the spec's contract stamp when it differs from the session's newest one. */
  stampContract(): Promise<void> {
    return this.record.stampContract(this.sessionId, this.config.stamp, this.instructions?.sha);
  }

  private personalDigests: PersonalResourceDigests | undefined;
  /** This session's own folder for the skills its attaches stage, held until it retires. */
  private staging: StagingFolder | undefined;

  private async projectResources(): Promise<ClaudeProjectResources | undefined> {
    const shape = this.spec.shape;
    if (this.spec.builtins !== "coding" || shape.turns !== "rolling") return undefined;
    // Attaches take turns, so this session's own folder is rebuilt by one at a time.
    this.staging ??= await claimStagingFolder(shape.record.dir);
    const { project, personalDigests } = await claudeProjectResources(
      this.spec,
      this.spec.personalRoot ?? this.config.env.HOME,
      this.staging.dir,
      (line) => this.note(line),
    );
    this.personalDigests = personalDigests;
    return project;
  }

  /**
   * The live attachment, reopened when it ended or new instructions wait,
   * for the starting turn `mine`. An attach can outlive its prompt
   * (the bounds give up on it while it waits for a sign-in to finish), so
   * after every wait it checks the prompt is still the one it serves and
   * spawns nothing otherwise: a later attach, a detach or a dispose never
   * has an orphaned client beside it.
   */
  private async attach(mine: Starting): Promise<Connection> {
    const current = this.connection;
    if (current && !current.closing && !this.reopen) return current;
    if (current) {
      this.close(current);
      await current.done;
    }
    // Whatever the client wrote since the last boundary, before it runs again.
    await this.record.refreshMirror(this.id);
    this.stillServing(mine);
    this.reopen = false;
    const env = this.config.env;
    // The machine's own client (F14), checked at every attachment: refuse
    // with its sentence, before anything is leased, when it is gone or old.
    await refuseMissingClient(this.deps, env);
    this.stillServing(mine);
    // This client holds the account's store for as long as it runs: it
    // refreshes its own login inside the run, and the refresh token behind
    // it is single use. A sign-in in progress is waited out first.
    const store = claudeLoginStore(this.deps, this.config.accountId);
    const release = await acquireSessionLease(store.dir);
    // Every exit before the connection holds the lease hands it back: a
    // resume reads its transcript copy here, and that read can fail.
    const input = new MessageQueue();
    const exit = new ClaudeClientExit();
    let query: Query;
    let costReports: ClaudeCostSubscription | undefined;
    const calls = this.callUsage();
    try {
      this.stillServing(mine);
      // A session the client has recorded resumes; one it has not (no turn
      // yet) starts under the same id.
      const recorded = this.record.clientTranscript(this.id) !== null;
      // A resume that names no model would get back the model the client
      // swapped in (it restores its transcript's last one): ask for the one
      // it swapped out instead.
      if (this.asked === undefined && recorded) this.asked = this.record.swappedFrom(this.id);
      const project = await this.projectResources();
      await assertClaudeWorkSettings(this.deps.resolveWorkSettings);
      // The person's own token command and address are their default
      // login's; a further login signs in only with its own folder.
      const access = store.own
        ? undefined
        : await this.deps.accessSettings?.().catch(() => undefined);
      // A company's reporting keys in the launch environment are a setup the
      // receiver passes records on to (`claudeReporting.ts`), not a reason
      // to step aside; any other reporting choice there still is.
      if (
        !receiverStepsAside(env) &&
        (await this.deps.costReportingAllowed?.().catch(() => false))
      ) {
        const company = await this.deps.companyReporting?.(env).catch(() => undefined);
        this.stillServing(mine);
        try {
          costReports = await this.deps.costReports?.subscribe(
            this.id,
            (report) =>
              calls.report({ ...report, model: canonicalClaudeModelId({ value: report.model }) }),
            company
              ? companyForward(company, env, (line) => this.note(line), { cwd: this.spec.cwd })
              : undefined,
          );
        } catch {
          this.note("local cost reporting unavailable; retaining turn-end accounting");
        }
        this.stillServing(mine);
      }
      const options = claudeSessionOptions({
        spec: this.spec,
        env,
        executable: resolveClaudeExecutable(env),
        stderr: (data) => this.note((costReports?.redact(data) ?? data).trimEnd()),
        exit,
        ...(access ? { access } : {}),
        ...(store.own ? { ownConfigDir: store.dir } : {}),
        attachment: {
          ...(this.asked ? { model: this.asked } : {}),
          ...(this.instructions?.text ? { served: this.instructions.text } : {}),
          session: recorded ? { resume: this.sessionId } : { sessionId: this.sessionId },
          ...(project ? { project } : {}),
          toolGate: this.safeStop.toolGate,
        },
      });
      // The client reports only to the receiver: the setup's own keys leave its environment.
      if (costReports)
        options.env = { ...withoutReportingKeys(options.env ?? {}), ...costReports.env };
      this.stillServing(mine);
      query = (this.deps.query ?? sdkQuery)({ prompt: input, options });
    } catch (caught) {
      costReports?.close();
      release();
      throw caught;
    }
    // A new client starts the normalizer over: its running totals are its
    // own, and a client that resumed the session may start them from what it
    // restored rather than from zero, so each result's share is the one the
    // client states for it (`claudeEvents.ts`, "turnUsage"). Nothing the
    // last client said about its turn - a pushed reading, an error, a tool
    // in flight - classifies this one's.
    this.normalizer = createNormalizerState();
    this.calls = calls;
    if (this.spec.builtins === "coding")
      this.emit({ type: "background_work_changed", count: undefined });
    const connection: Connection = {
      sessionId: this.id,
      query,
      input,
      effort: this.spec.thinking.quick ? "off" : this.spec.thinking.level,
      closing: false,
      done: Promise.resolve(),
      release,
      ...(costReports ? { costReports } : {}),
    };
    this.connection = connection;
    connection.done = this.pumpQuery(query, exit);
    return connection;
  }

  private stillServing(mine: Starting): void {
    if (this.disposed) throw new Error(ENDED_TEXT);
    if (this.turn !== mine) {
      throw new Error("The turn ended before Claude attached.");
    }
  }

  /** Per turn (WI-13): the client changes effort from its next request on. */
  private async applyEffort(connection: Connection): Promise<void> {
    if (connection.effort === this.wantedEffort || this.wantedEffort === "off") return;
    const effort = this.wantedEffort;
    try {
      await connection.query.applyFlagSettings({ effortLevel: effort });
      connection.effort = effort;
    } catch (caught) {
      // The turn still runs, at the effort the client has.
      this.note(`effort ${effort} was not applied: ${String(caught)}`);
    }
  }

  private push(
    connection: Connection,
    kind: Pushed["kind"],
    text: string,
    images: SessionImage[] | undefined,
  ): void {
    const uuid = randomUUID();
    if (this.turn.kind !== "running") return;
    this.turn.pushed.push({ uuid, kind, text, acked: false });
    connection.input.push(
      userMessage(text, kind === "steer" ? CLAUDE_STEER_PRIORITY : undefined, images, uuid),
    );
  }

  /**
   * End an attachment: its input ends and the client exits on its own,
   * writing the last of its transcript; `hard` stops it outright (a client
   * that stopped answering).
   */
  private close(connection: Connection, hard = false): void {
    if (!connection.closing) {
      connection.closing = true;
      connection.closedAt = this.config.clock.now();
      connection.input.close();
    }
    if (hard) connection.query.close();
  }

  /** The session is gone: its record is final, the store is free, the clock forgets it. */
  private retire(): void {
    if (this.life === "retired") return;
    this.life = "retired";
    this.unregister();
    // Its client has exited: the next session of the task removes the folder.
    this.staging?.release();
    void this.record
      .settled()
      .then(() => this.record.refreshMirror(this.id))
      .then(() => {
        // The session's record is final: its parsed entries are no longer read.
        this.record.release(this.id);
        this.retirement.resolve();
      });
  }

  /**
   * The client's status says when it starts shortening the conversation
   * (`compacting`) and when it stops (another status, with or without a
   * result). Reported the way Pi reports its own: as the shortening's
   * progress.
   */
  private foldStatus(record: { status?: unknown; compact_result?: unknown }): void {
    if (record.status === "compacting") {
      if (this.folding !== "running") this.foldProgress("start");
      this.folding = "running";
      return;
    }
    if (this.folding === "running") {
      this.foldProgress("end", record.compact_result === "failed");
      this.folding = "ended";
    } else if (this.folding === "ended" && record.compact_result !== undefined) {
      this.folding = "idle";
    }
  }

  private foldProgress(edge: "start" | "end", failed = false): void {
    const callId = `${this.taskId}:compaction`;
    if (edge === "start")
      this.emit({ type: "tool_start", taskId: this.taskId, callId, toolName: FOLD_TOOL });
    else
      this.emit({
        type: "tool_end",
        taskId: this.taskId,
        callId,
        toolName: FOLD_TOOL,
        isError: failed,
      });
  }

  private callUsage(): ClaudeCallUsage {
    return new ClaudeCallUsage(
      (usage) => this.emit({ type: "turn_end", taskId: this.taskId, usage }),
      (model) => canonicalClaudeModelId({ value: model }),
    );
  }

  protected normalized(result: ClaudeNormalizeResult, message: unknown): ClaudeNormalizeResult {
    return (message as { type?: unknown } | null)?.type === "result"
      ? { ...result, events: this.calls.settle(result.events, this.normalizer.totals) }
      : result;
  }

  protected observe(message: unknown, result: ClaudeNormalizeResult): void {
    this.calls.observe(message, this.answering ?? this.asked);
    const record = message as {
      type?: unknown;
      subtype?: unknown;
      model?: unknown;
      state?: unknown;
      status?: unknown;
      compact_result?: unknown;
      isReplay?: unknown;
      uuid?: unknown;
      event?: { type?: unknown };
    };
    this.safeStop.track(message);
    if (record.type === "system" && record.subtype === "status") this.foldStatus(record);
    if (record.type === "system" && record.subtype === "compact_boundary") {
      // A boundary ends a running shortening; one heard with no start is
      // reported as a start and an end together, so it still shows.
      if (this.folding === "ended") this.folding = "idle";
      else {
        if (this.folding === "idle") this.foldProgress("start");
        this.foldProgress("end");
        this.folding = "ended";
      }
      // Claude's client folds between its own requests; whether more follow
      // is not said.
      this.emit({ type: "context_compacted", turn: "unknown" });
    }
    if (this.spec.builtins === "coding" && result.backgroundJobs !== undefined) {
      this.emit({
        type: "background_work_changed",
        count: result.backgroundJobs,
        tasks: result.backgroundTasks ?? [],
      });
    }
    if (record.type === "system" && record.subtype === "init" && typeof record.model === "string") {
      // A session that named no model keeps the one it opened on.
      this.asked ??= record.model;
      this.serve(record.model);
    }
    // The client moved the session off the model it asked for (a refusal
    // fallback). A subagent's own fallback leaves the session's model as it was.
    if (result.fallback?.scope === "session") this.serve(result.fallback.to, result.fallback);
    if (record.type === "system" && record.subtype === "session_state_changed") {
      this.statesSeen = true;
      if (record.state === "running") {
        // Running with no prompt open is the client resuming on its own.
        if (this.turn.kind === "running" && this.turn.by === "prompt") this.turn.ran = true;
        else if (this.turn.kind === "idle") this.beginContinuation();
      }
      if (record.state === "idle") {
        const turn = this.turn;
        if (turn.kind === "running" && (turn.by === "continuation" || turn.ran)) this.settle();
      }
      return;
    }
    if (record.type === "user" && record.isReplay === true && typeof record.uuid === "string") {
      this.acksSeen = true;
      const pushed =
        this.turn.kind === "starting"
          ? undefined
          : this.turn.pushed.find((entry) => entry.uuid === record.uuid);
      if (pushed && !pushed.acked) {
        pushed.acked = true;
        this.emit({
          type: "input_read",
          textSha256: sha256(pushed.text),
        });
      }
    }
    if (record.type === "stream_event" && record.event?.type === "message_start") {
      // One model request begins: the per-inference clock starts over.
      this.emit({ type: "request_started" });
    }
    if (result.rateLimit) this.deps.onRateLimit?.(this.config.accountId, result.rateLimit);
  }

  protected resultFailed(result: ClaudeNormalizeResult, failure: ClaudeTurnFailure): void {
    if (this.turn.kind === "running") this.turn.failed = true;
    // An answer that kept running past the spec's output cap is the cap's
    // failure, said in the session's words rather than the client's.
    const cap = this.spec.bounds?.request?.maxOutputTokens;
    this.emit({
      type: "turn_failed",
      taskId: this.taskId,
      error: failure.outputCapped && cap !== undefined ? outputCapErrorMessage(cap) : failure.error,
      ...(failure.cutOff ? { cutOff: failure.cutOff } : {}),
      ...(failure.contextOverflow ? { contextOverflow: true } : {}),
    });
    this.closeTurn(result, undefined);
  }

  protected resultInterrupted(result: ClaudeNormalizeResult): void {
    // An abort with a failure (a watched bound's) interrupted the turn: say
    // it, the way the Pi session rewrites its cut turn. A plain abort ends
    // quietly.
    const turn = this.turn;
    if (turn.kind === "running" && turn.interrupt?.cut !== undefined && !turn.failed) {
      turn.failed = true;
      this.emit({ type: "turn_failed", taskId: this.taskId, error: turn.interrupt.cut });
    }
    this.closeTurn(result, undefined);
  }

  protected resultClean(result: ClaudeNormalizeResult): void {
    this.deps.onServed?.(this.config.accountId);
    this.closeTurn(result, result.finalText?.trim() || undefined);
  }

  protected streamFailed(caught: unknown, stream: AsyncIterable<unknown>): void {
    const connection = this.connection;
    if (!connection || connection.query !== stream || connection.closing) return;
    const message = caught instanceof Error ? caught.message : String(caught);
    this.note(`the client stopped: ${message}`);
    // Its stream is over, but the client may not have exited yet: a prompt
    // in between waits for it before attaching a new one.
    this.close(connection);
    // The failure was already told; the throw is the same failure ending the stream.
    const turn = this.turn;
    if (turn.kind === "idle") return;
    this.settle(turn.kind === "running" && turn.failed ? undefined : caught);
  }

  protected streamEnded(stream: AsyncIterable<unknown>): void {
    const connection = this.connection;
    if (!connection || connection.query !== stream) return;
    this.connection = undefined;
    if (this.spec.builtins === "coding")
      this.emit({ type: "background_work_changed", count: undefined });
    connection.costReports?.close();
    connection.release();
    this.record.mirror(connection.sessionId);
    if (this.turn.kind === "running" && this.turn.by === "continuation") this.settle(STOPPED_TEXT);
    if (connection.closing) {
      if (this.life !== "open") this.retire();
      return;
    }
    this.settle(new Error(STOPPED_TEXT));
  }

  private closeTurn(result: ClaudeNormalizeResult, text: string | undefined): void {
    const turn = this.turn;
    if (turn.kind === "running") turn.ran = true;
    this.emitAll(result.events);
    this.emit({ type: "turn_closed", ...(text ? { text } : {}) });
    if (turn.kind !== "running") return;
    // A result answers the interrupt. A queued steer can have its own
    // result and its own bound before this prompt reaches idle.
    if (turn.interrupt?.cut !== undefined) turn.failed = false;
    turn.interrupt = undefined;
    if (!this.statesSeen && (!this.acksSeen || turn.pushed.every((entry) => entry.acked))) {
      this.settle();
    }
  }

  /** The client did not answer: stop it and settle the prompt; a continuation ends on stream exit. */
  private abandon(): void {
    const turn = this.turn;
    const cut =
      turn.kind === "starting"
        ? turn.stopAsked?.cut
        : turn.kind === "running"
          ? turn.interrupt?.cut
          : undefined;
    const prompt = turn.kind === "starting" || (turn.kind === "running" && turn.by === "prompt");
    if (prompt && !(turn.kind === "running" && turn.failed)) {
      if (cut !== undefined) this.emit({ type: "turn_failed", taskId: this.taskId, error: cut });
      this.emit({ type: "turn_end", taskId: this.taskId });
      this.emit({ type: "turn_closed" });
    }
    // A continuation can still drain an interrupted result before stream
    // exit. Keep its interrupt classification, but spend the bound's cut.
    if (turn.kind === "running" && turn.interrupt) {
      turn.interrupt = { at: turn.interrupt.at };
    }
    const connection = this.connection;
    if (connection) this.close(connection, true);
    if (prompt) this.settle();
  }

  /** One exit for a prompt or continuation: return inputs, record, then notify its owner. */
  private settle(caught?: unknown): void {
    const turn = this.turn;
    if (turn.kind === "idle") return;
    const pushed = turn.kind === "running" ? turn.pushed : [];
    this.turn = { kind: "idle", pushed };
    for (const entry of pushed) {
      if (entry.kind === "steer" && !entry.acked) this.held.push(entry.text);
    }
    if (turn.kind === "starting") {
      for (const steer of turn.early) this.held.push(steer.text);
    }
    this.record.mirror(this.id);
    this.safeStop.turnOver();
    if (turn.kind === "running" && turn.by === "continuation") {
      this.emit({
        type: "continuation_ended",
        ...(caught !== undefined
          ? { error: caught instanceof Error ? caught.message : String(caught) }
          : {}),
      });
    } else {
      this.served = pushed;
      if (pushed.some((entry) => entry.acked)) {
        this.tookPrompt = true;
        this.record.stampServed(this.sessionId, pushed, this.personalDigests);
      }
      if (caught === undefined) turn.completion.resolve();
      else turn.completion.reject(caught instanceof Error ? caught : new Error(String(caught)));
    }
    for (const after of this.afterSettle.splice(0)) after();
  }

  /** The client resumed on its own; a closing client cannot start a continuation. */
  private beginContinuation(): void {
    const connection = this.connection;
    if (this.turn.kind !== "idle" || this.life !== "open" || !connection || connection.closing)
      return;
    this.turn = { kind: "running", by: "continuation", pushed: [], ran: false, failed: false };
    this.emit({ type: "continuation_started" });
  }

  /**
   * The model the client answers on now, said to the owner when it is news:
   * its first report, and every change after it.
   */
  private serve(raw: string, fallback?: { from: string; category?: string }): void {
    const id = this.named(raw);
    if (!id || id === this.answering) return;
    this.answering = id;
    this.emit({
      type: "model_served",
      model: { provider: CLAUDE_MODEL_PROVIDER, id },
      ...(fallback
        ? {
            fallback: {
              from: { provider: CLAUDE_MODEL_PROVIDER, id: this.named(fallback.from) },
              ...(fallback.category ? { category: fallback.category } : {}),
            },
          }
        : {}),
    });
  }

  /**
   * A model the client reported, as Infinitary names it: the client's own
   * variant and snapshot marks (`[1m]`, a date) name the same model, and the
   * spec's model keeps the id the spec gave it.
   */
  private named(raw: string): string {
    const id = canonicalClaudeModelId({ value: raw });
    const spec = this.spec.model?.id;
    return spec && canonicalClaudeModelId({ value: spec }) === id ? spec : id;
  }

  private note(line: string): void {
    if (!line) return;
    noteTo(this.deps)(line);
  }
}
