import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { fileSizeWords } from "@shared/attachments";
import { isCustomApiProvider } from "@shared/customApi";
import { COMPUTER, HERE, HOME } from "@shared/deviceNames";
import { parseOfferingKey } from "@shared/modelSlots";
import { PERSONAL_READ_FIELD, type PersonalRead, personalReadOf } from "@shared/personalSet";
import type { InterruptEventData, TASK_CARD_VIA } from "@shared/provenance";
import { isRetiredProvider } from "@shared/providers";
import { isFolderRepair, levelDefaultReasoning } from "@shared/routingPolicy";
import { capWithOverflow } from "../overflow";
import { crewmateHandoverDir, crewmateSessionsDir, crewmateTempDir } from "../paths";
import { NeedsNewConversation, NothingOpenedThere } from "../placed/crewMachines";
import { sameModel } from "../placed/placedSpecs";
import { crewRunbookText } from "../runbooks/runbooks";
import { summaryCompaction } from "../session/compaction";
import { OpenReads } from "../session/openReads";
import { LOCAL_MACHINE_ID, type ModelSession, type SessionSpec } from "../session/session";
import { INBOX_ATTEMPT_MAX, type InboxRow } from "../storage/inboxStore";
import type { TaskRecord } from "../storage/taskRecords";
import {
  deliverHandoverFile,
  HANDOVER_IN_DIR_NAME,
  handoverFileName,
  keptHandoverFiles,
} from "../tasks/handoverFiles";
import { TaskService } from "../tasks/taskService";
import { provisionTaskTemp } from "../tasks/taskTemp";
import type { CrewCore } from "./crewCore";
import type { InterruptSource, MoveTarget, TaskRuntime } from "./crewRuntime";
import {
  type CrewmateRestart,
  type CrewmateSpec,
  crewmateProcedureFor,
  crewmateRenewedNote,
  crewmateResumeToken,
  crewmateSessionSpec,
} from "./crewSession";
import type { ResumeAccount } from "./crewSupervisorOptions";
import { CrewTurn } from "./crewTurn";
import { describeStatus } from "./settleService";
import { ModelWaitError, NotAcceptedError, OpenedNothingError } from "./taskMoves";
import { conversationRestartWake } from "./turnWakes";

/**
 * A crewmate's session and its conversation (docs/architecture.md section 2):
 * opening it and recording where it runs, reopening it to resume a task,
 * carrying a restart, interrupting and stopping it, letting it go, and the
 * hand-over doors that put files in its folder. Shares the crew's state
 * through `CrewCore`.
 */
/**
 * Whether a conversation's resume token names a conversation other than the
 * one `from` names: neither the same token nor the same record file. One
 * that names none is not shown to be another.
 */
function distinctFrom(token: string | undefined, from: string): boolean {
  return token !== undefined && token !== from && basename(token) !== basename(from);
}

export class CrewSessions {
  /** Each task's conversation opening here now (`resumeTask`), which a plain resume joins. */
  private readonly resuming = new Map<string, Promise<TaskRuntime>>();
  private crewmateSeq = 0;
  /** Sessions let go of mid-turn, each until it is gone (`releaseSession`). */
  private readonly releasing = new Set<Promise<void>>();
  /**
   * What a reopened conversation writes once it is accepted (`carryRestart`):
   * its record, a renewal and a restart wake, never written for one let go.
   */
  private readonly carries = new WeakMap<ModelSession, () => void>();

  constructor(private readonly core: CrewCore) {}

  /** The next crewmate's name: its number counts every crewmate opened since the app started. */
  nameCrewmate(): string {
    this.crewmateSeq += 1;
    return `crewmate ${this.crewmateSeq}`;
  }

  /** Sessions let go of mid-turn that are not gone yet: the quit waits for them. */
  releases(): Iterable<Promise<void>> {
    return this.releasing.values();
  }

  /**
   * Open a crewmate's session: its account's binding, the crewmate preset on
   * it, and the factory of that binding's backend. A recorded conversation
   * its backend cannot reopen (a token of another backend's shape) starts
   * fresh, and the task's timeline says so. `servedModel` is the model a
   * resumed conversation's record names ("provider/id"), so a task on
   * another computer binds the account there that served it at its start.
   * `movedTo` names the provider a moved task now runs on (INF-849): a
   * conversation that provider's client cannot reopen restarts as moved.
   */
  async openCrewmate(
    task: TaskRuntime,
    crewmate: CrewmateSpec,
    accountId: string | undefined,
    servedModel?: string,
    movedTo?: string,
  ): Promise<ModelSession> {
    const binding =
      crewmate.machineId === LOCAL_MACHINE_ID
        ? await this.core.options.bind(accountId, crewmate.model?.provider)
        : await this.core.placement.placedBinding(
            crewmate.machineId,
            crewmate.model?.provider ?? this.core.options.router?.servedProvider(task.id),
            accountId,
            crewmate.model ?? (servedModel ? parseOfferingKey(servedModel) : undefined),
          );
    const factories =
      crewmate.machineId === LOCAL_MACHINE_ID
        ? this.core.options.sessions
        : this.core.options.machines?.factories(crewmate.machineId);
    if (!factories) throw new Error("This task runs on another computer this app cannot reach.");
    const factory = factories[binding.backend];
    if (!factory) {
      throw new Error(`No backend is registered to serve account "${accountId ?? ""}".`);
    }
    // Provision before the prompt is served, so a new folder is the app's.
    // A temp directory that already holds files is left on the old policy.
    if (crewmate.machineId === LOCAL_MACHINE_ID) {
      provisionTaskTemp(join(this.core.options.paths.crewmatesDir, task.id));
    }
    const briefed = {
      ...crewmate,
      ...(this.core.options.source ? { source: await this.core.options.source() } : {}),
      procedure: crewmateProcedureFor(
        this.core.options.tasks.policiesOf(this.core.options.tasks.get(task.id)),
      ),
      // Every crewmate is told the captain's computers and which one it runs on (INF-992).
      ...this.core.placement.computersFor(crewmate.machineId),
      // Its app reads here are answerable by the quiet check; there, that computer keeps its own.
      ...(crewmate.machineId === LOCAL_MACHINE_ID ? { openReads: task.openReads } : {}),
    };
    task.backend = binding.backend;
    let runbookSkills: SessionSpec["runbookSkills"];
    if (this.core.options.runbooks) {
      const served = this.core.options.runbooks.crew(
        this.core.briefs.runbookFacts(task.id, briefed.procedure, binding.backend),
      );
      Object.assign(briefed, {
        runbookText: crewRunbookText(served),
      });
      runbookSkills = served.skills;
      // The host's wakes follow what this conversation was told (docs/forge.md,
      // "Comments on a pull request"); a task never told of one keeps no fact.
      const before = this.core.options.tasks.get(task.id)?.delivery?.servedWakes ?? [];
      if (before.join("\n") !== served.wakes.join("\n"))
        this.core.options.tasks.delivery.recordChangeEvidence(task.id, {
          servedWakes: served.wakes,
        });
    }
    const spec = this.core.options.sessionSpec
      ? this.core.options.sessionSpec(briefed, binding)
      : crewmateSessionSpec(this.core.options.paths, briefed, binding);
    if (
      spec.speed &&
      (binding.backend === "claude" || (spec.model && spec.model.provider !== "openai-codex"))
    ) {
      const model = spec.model ?? { provider: "anthropic-claude", id: "This model" };
      const requested = await spec.speed.requested(model);
      if (requested !== "standard")
        spec.speed.record(model, {
          requested,
          sent: "standard",
          reason: "this model and account do not offer Codex crew speeds",
        });
      delete spec.speed;
    }
    // A fenced session's reads stop at its working copy, so skills staged
    // outside it would be offered and then refused.
    spec.personalResources =
      !spec.fenced && this.core.options.personalResourcesEnabled?.() === true;
    const summaryPoint = this.core.options.summaryPoint;
    if (summaryPoint) spec.compaction = () => summaryCompaction(summaryPoint());
    if (runbookSkills && !spec.fenced) spec.runbookSkills = runbookSkills;
    if (this.core.disposed()) throw new Error("This computer is stopping.");
    const session = await factory.open(spec);
    if (spec.personalResources) await this.notePersonal(task.id, crewmate.machineId);
    // Unopenable: the backend could not take the recorded conversation, or
    // it was asked to and opened another one instead, as a Claude client
    // with no transcript for it does.
    // A Pi token is the file Pi opens, so a Pi session never opens another.
    const asked = spec.shape.turns === "rolling" ? spec.shape.record.resume : undefined;
    const opened = crewmateResumeToken(session.resume());
    const unopenable =
      Boolean(crewmate.resumeToken) &&
      spec.shape.turns === "rolling" &&
      (!asked ||
        (asked.backend !== "pi" && opened !== undefined && opened !== crewmateResumeToken(asked)));
    const carry = () =>
      this.carryRestart(
        task,
        crewmate.machineId,
        session,
        unopenable ? crewmate.resumeToken : undefined,
        movedTo,
      );
    // A reopen writes what replaced the earlier conversation only once the
    // task took this one (`acceptOpened`).
    if (crewmate.resumeToken) this.carries.set(session, carry);
    else carry();
    return session;
  }

  /**
   * Names on the timeline the version of the home's personal instructions
   * and skills a conversation read as it opened, and where, once each time
   * it moves: the record's Info tab shows the newest (docs/personal-resources.md).
   */
  private async notePersonal(taskId: string, machine: string): Promise<void> {
    const local = machine === LOCAL_MACHINE_ID;
    const version = local
      ? await this.core.options.personalVersion?.()
      : this.core.options.machines?.personalOf?.(taskId);
    if (!version) return;
    const computer = local
      ? undefined
      : (this.core.options.machines?.nameOf(machine) ?? `another ${COMPUTER.one}`);
    const last = personalReadOf(this.core.options.tasks.timeline(taskId));
    const where = last && ("home" in last ? undefined : last.computer);
    if (last?.version === version.version && where === computer) return;
    const read: PersonalRead = computer ? { ...version, computer } : { ...version, home: true };
    this.core.options.tasks.note(
      taskId,
      `Read the personal instructions and skills, version ${version.version.slice(0, 12)}, on ${computer ?? HERE.this}.`,
      { news: false, data: { [PERSONAL_READ_FIELD]: read } },
    );
  }

  /** One association writer for starts, replacements, moves and completed turns. */
  recordCrewSession(
    task: TaskRuntime,
    session: ModelSession,
    began: string,
    machine = this.core.facts.machineOf(task.id),
  ): void {
    task.conversationBegan = began;
    const token = crewmateResumeToken(session.resume());
    if (!token) return;
    const folders =
      machine === LOCAL_MACHINE_ID
        ? { sessions: crewmateSessionsDir(this.core.options.paths, task.id) }
        : this.core.options.machines?.folders(machine, task.id);
    // A Claude token is not a path. Its durable copy belongs to the computer
    // running the session, not to this computer's copy of the transcript.
    const file = isAbsolute(token)
      ? token
      : folders
        ? join(folders.sessions, `${token}.jsonl`)
        : undefined;
    if (!file) return;
    const model = session.modelRef();
    this.core.options.tasks.turns.setSessionFile(task.id, token, {
      file,
      computer:
        machine === LOCAL_MACHINE_ID
          ? HOME.the
          : (this.core.options.machines?.nameOf(machine) ?? `another ${COMPUTER.one}`),
      device_id: machine,
      provider: model?.provider ?? null,
      model: model?.id ?? null,
      account_id: task.accountId ?? null,
      began,
    });
  }

  /**
   * A conversation that replaced the task's earlier one: a Claude
   * conversation resumed under changed instructions renews as it opens -
   * here, or on its computer again after that computer restarted
   * (`placedReopened`) - or the earlier one, `unopenable`, could not be
   * reopened. A renewal is noted, and the record names the one it moved to
   * now, so a quit before its first turn ends does not reopen the earlier
   * one again; either way the lane keeps why, and the next turn serves it.
   */
  carryRestart(
    task: TaskRuntime,
    machine: string,
    session: ModelSession,
    unopenable?: string,
    movedTo?: string,
  ): void {
    const renewal = session.takeRenewal();
    if (renewal) {
      this.core.options.tasks.note(task.id, crewmateRenewedNote(renewal), {
        news: false,
        data: { conversation: { from: renewal.from, changed: [...renewal.changed] } },
      });
    } else if (unopenable) {
      this.core.options.tasks.note(
        task.id,
        movedTo
          ? `it moved to a new conversation on ${movedTo}, which cannot reopen its earlier one; the earlier one is kept`
          : "its earlier conversation could not be reopened, so it starts a fresh one",
        { news: true },
      );
    }
    const restart: CrewmateRestart | undefined =
      renewal ??
      (unopenable
        ? movedTo
          ? { from: unopenable, changed: "moved", to: movedTo }
          : { from: unopenable, changed: "unopenable" }
        : undefined);
    if (restart) {
      this.recordCrewSession(
        task,
        session,
        renewal ? "renewal" : movedTo ? "move" : "unopenable",
        machine,
      );
      this.recordRestart(task.id, task.key, machine, restart);
    }
  }

  /**
   * What a crewmate whose conversation replaced its task's earlier one is
   * told first, queued once on its lane: the brief its first turn served,
   * read back off the record, and where its earlier conversation's
   * transcript is saved on the computer it runs on. The turn that brings it
   * back serves the wake first, and a quit before that turn ends clean
   * still has the row.
   */
  private recordRestart(
    taskId: string,
    taskKey: string,
    machine: string,
    restart: CrewmateRestart,
  ): void {
    const briefed = this.core.options.tasks
      .timeline(taskId)
      .filter((event) => event.kind === "briefed")
      .at(-1);
    const brief = briefed ? this.core.options.tasks.servedBrief(briefed) : undefined;
    // A Pi conversation's token is its file; a Claude one's names the
    // app's copy in the task's sessions folder.
    const named = (dir: string) =>
      isAbsolute(restart.from) ? restart.from : join(dir, `${restart.from}.jsonl`);
    let earlier: string | undefined;
    if (machine === LOCAL_MACHINE_ID) {
      const path = named(crewmateSessionsDir(this.core.options.paths, taskId));
      if (existsSync(path)) earlier = path;
    } else {
      const folders = this.core.options.machines?.folders(machine, taskId);
      if (folders) earlier = named(folders.sessions);
    }
    this.core.options.inbox.enqueueWake(
      taskId,
      conversationRestartWake({
        restart,
        taskKey,
        ...(brief ? { brief } : {}),
        ...(earlier ? { earlier } : {}),
      }),
      "agent",
      taskId,
    );
  }

  /**
   * A restart that waited for a model (`ModelWaitError`), still on the lane:
   * its reason replaces the conversation the record still names, so the
   * open that follows starts fresh as that restart asked, after a relaunch
   * too. A row the delivery that opens it already claimed counts too, as no
   * crewmate is held to hold it otherwise.
   */
  private waitingRestart(record: TaskRecord): CrewmateRestart | undefined {
    if (!record.sessionFile) return undefined;
    const inbox = this.core.options.inbox;
    for (const row of [...inbox.allFor(record.id), ...inbox.inFlight(record.id)]) {
      const facts = row.facts;
      if (facts?.kind !== "conversation-restart") continue;
      const restart = facts.restart;
      if (
        (restart.changed === "context" || restart.changed === "refused") &&
        restart.from === record.sessionFile
      )
        return restart;
    }
    return undefined;
  }

  /**
   * A renewed conversation's reason still waiting on the lane, claimed for
   * the turn about to start so it rides that turn and a clean end acks it.
   */
  claimConversationRestart(taskId: string, already: readonly number[]): InboxRow[] {
    const claimed = new Set(already);
    const leading = this.core.options.inbox
      .pending(taskId, this.core.now(), { maxAttempts: INBOX_ATTEMPT_MAX })
      .filter((row) => row.facts?.kind === "conversation-restart" && !claimed.has(row.id));
    if (leading.length === 0) return [];
    this.core.options.inbox.markDelivered(leading.map((row) => row.id));
    return leading;
  }

  async cleanupFailedSpawn(task: TaskRuntime): Promise<void> {
    await task.unsubscribe?.();
    task.session?.dispose();
    this.core.tasks.delete(task.id);
    this.core.cards.deleteRowsForTask(task.id);
    if (this.core.options.tasks.get(task.id)) {
      this.core.options.tasks.archive.discardFailedSpawn(task.id);
    }
    if (task.workspace) {
      await this.core.options.workspace.removeTaskWorktree(task.workspace).catch(() => {});
    }
    this.core.cards.scheduleBroadcast();
    this.core.facts.broadcastCrewCounts();
  }

  /**
   * Delivers one file into a task's hand-over folder on the computer it
   * runs on, verified and 0600, named by its sha256 and its own name
   * (`handoverFileName`): a copy here, or the source-file order there.
   * Answers its kept name and its path there.
   */
  async deliverHandover(
    taskId: string,
    path: string,
    name: string,
    sha256: string,
  ): Promise<{ file: string; path: string }> {
    const file = handoverFileName(name, sha256);
    const machine = this.core.facts.machineOf(taskId);
    if (machine === LOCAL_MACHINE_ID)
      return {
        file,
        path: await deliverHandoverFile(
          path,
          join(crewmateTempDir(this.core.options.paths, taskId), HANDOVER_IN_DIR_NAME),
          file,
        ),
      };
    const machines = this.core.options.machines;
    if (!machines?.sourceFile)
      throw new Error("The work computer cannot receive this message’s attachments.");
    return { file, path: await machines.sourceFile(machine, taskId, file, path, "handover") };
  }

  /**
   * Why a task cannot take a file from outside into its hand-over folder
   * now (docs/integrations.md, "Google"): it is not running, or its
   * computer could not remove the file when it is due.
   */
  outsideFileRefusal(taskId: string): string | undefined {
    const record = this.core.options.tasks.get(taskId);
    if (!record || record.status !== "active")
      return "this task is not running, so it has no hand-over folder to save into.";
    const machine = this.core.facts.machineOf(taskId);
    if (machine === LOCAL_MACHINE_ID) return undefined;
    const machines = this.core.options.machines;
    if (machines?.sourceFile && machines.takesOutsideFiles?.(machine)) return undefined;
    return `update Infinitary on ${machines?.nameOf(machine) ?? `the other ${COMPUTER.one}`} before a file from outside can be saved into this task's folder there.`;
  }

  /**
   * Saves a file from outside, such as a Gmail attachment, into a task's
   * hand-over folder (`IntegrationsServiceOptions.files`): written 0600 in a
   * private folder of its own, delivered verified, and removed here.
   */
  async saveOutsideFile(
    taskId: string,
    name: string,
    bytes: Buffer,
  ): Promise<{ file: string; path: string }> {
    const refusal = this.outsideFileRefusal(taskId);
    if (refusal) throw new Error(refusal);
    const staging = await mkdtemp(join(tmpdir(), "infinitary-outside-"));
    try {
      const path = join(staging, "file");
      await writeFile(path, bytes, { mode: 0o600 });
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      return await this.deliverHandover(taskId, path, name, sha256);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  /**
   * Delivers the files a task's reports handed on into another task's
   * hand-over folder on the computer it runs on (INF-992, direction B): a
   * verified local copy here, or the source-file order there, each 0600 in
   * its temporary folder, so it goes when that task closes. Answers the
   * words the steer carries: paths and sizes, never content.
   */
  async handFiles(fromTask: string, toTask: string): Promise<string> {
    return (await this.prepareHandFiles(fromTask, toTask)).copy();
  }

  /**
   * The checks of a hand-over, answered at once, and the copy itself, which
   * can take a minute to another computer, as a function to run after: the
   * first mate's steer answers between the two (INF-3060). `copy` tells
   * `arrived` how many files have reached the task so far, so a failure part
   * way can say so.
   */
  async prepareHandFiles(
    fromTask: string,
    toTask: string,
  ): Promise<{ files: number; copy: (arrived?: (count: number) => void) => Promise<string> }> {
    const { from, kept } = await this.handSource(fromTask);
    const to = this.core.options.tasks.resolve(toTask);
    if (!to) throw new Error(`There is no task ${toTask} to hand files to.`);
    const handle = (record: TaskRecord) => record.key || record.id;
    if (to.status !== "active")
      throw new Error(
        `${handle(to)} has not started, so there is no folder to hand files into yet.`,
      );
    const machine = to.deviceId;
    const machines = this.core.options.machines;
    if (machine && !machines?.takesHandover?.(machine))
      throw new Error(
        `${handle(to)} runs on ${machines?.nameOf(machine) ?? `another ${COMPUTER.one}`}, which needs an update to Infinitary before it can take handed files.`,
      );
    return {
      files: kept.length,
      copy: (arrived) => this.copyHandFiles(from, to, kept, arrived),
    };
  }

  /**
   * The task files are handed from, and the files its reports kept; a
   * hand-over to a task that has not started checks these at once (INF-3060).
   */
  async handSource(
    fromTask: string,
  ): Promise<{ from: TaskRecord; kept: Awaited<ReturnType<typeof keptHandoverFiles>> }> {
    const from = this.core.options.tasks.resolve(fromTask);
    if (!from) throw new Error(`There is no task ${fromTask} to hand files from.`);
    const kept = await keptHandoverFiles(crewmateHandoverDir(this.core.options.paths, from.id));
    if (kept.length === 0)
      throw new Error(
        `${from.key || from.id} has no reported files to hand on: its crewmate passes them in report files.`,
      );
    return { from, kept };
  }

  private async copyHandFiles(
    from: TaskRecord,
    to: TaskRecord,
    kept: Awaited<ReturnType<typeof keptHandoverFiles>>,
    arrived?: (count: number) => void,
  ): Promise<string> {
    const handle = (record: TaskRecord) => record.key || record.id;
    const machine = to.deviceId;
    const machines = this.core.options.machines;
    const lines: string[] = [];
    for (const file of kept) {
      const path =
        machine && machines?.sourceFile
          ? await machines.sourceFile(machine, to.id, file.file, file.path, "handover")
          : await deliverHandoverFile(
              file.path,
              join(crewmateTempDir(this.core.options.paths, to.id), HANDOVER_IN_DIR_NAME),
              file.file,
            );
      lines.push(`${path} (${fileSizeWords(file.size)})`);
      arrived?.(lines.length);
    }
    // Only a complete, verified delivery is a receipt; failed copies leave none.
    this.core.options.tasks.capture.recordResultHandoff(from.id, { taskId: to.id });
    // Paths and sizes only: a handed file may hold secrets (the captain's words on INF-992).
    return `Files handed to you from ${handle(from)}, verified byte for byte, in your hand-over folder: ${lines.join(", ")}. They may hold secrets: never print, quote or paste their content anywhere, and read only what your work needs. They are removed when this task closes.`;
  }

  /**
   * The provider a task was last routed to, when this build no longer
   * offers it (Cursor). Its resume token belongs to that
   * provider's own client, so no backend here can reopen the session.
   */
  retiredProviderOf(taskId: string): string | undefined {
    const provider = this.core.options.router?.servedProvider(taskId);
    return provider && isRetiredProvider(provider) ? provider : undefined;
  }

  /**
   * Reopen the session of an idle task left by a previous process, or of
   * one moving to another provider (`move`, INF-849): it opens on the
   * move's model and account in the same working copy, resuming the same
   * conversation when the new backend can reopen it. With `restart`, a new
   * conversation opens instead, told why and where the earlier one is: a
   * task that moved to another computer (docs/helper.md, "Moving a started
   * task"). A task has one crewmate at a time (INF-2556). A plain resume
   * while the task's conversation is opening joins that open, and a plain
   * resume of a task whose crewmate already holds the conversation returns
   * that crewmate: a computer that runs work can ask for the conversation
   * (`adoptPlaced`) before it has answered the open a move or a wake asked
   * of it, and two wakes after a restart each ask for it. A move or a
   * restart waits for an open under way to end first; the move let go of
   * that crewmate, so its open ends without one (`openResumed`).
   */
  resumeTask(taskId: string, move?: MoveTarget, restart?: CrewmateRestart): Promise<TaskRuntime> {
    const replaces = move !== undefined || restart !== undefined;
    const opening = this.resuming.get(taskId);
    if (opening && !replaces) return opening;
    const live = this.core.tasks.get(taskId);
    if (!opening && !replaces && live?.session && !live.turn.closing) return Promise.resolve(live);
    const resuming = opening
      ? opening.then(
          () => this.openResumed(taskId, move, restart),
          () => this.openResumed(taskId, move, restart),
        )
      : this.openResumed(taskId, move, restart);
    this.resuming.set(taskId, resuming);
    const opened = () => {
      if (this.resuming.get(taskId) === resuming) this.resuming.delete(taskId);
    };
    resuming.then(opened, opened);
    return resuming;
  }

  private async openResumed(
    taskId: string,
    move?: MoveTarget,
    restart?: CrewmateRestart,
    /** The computer answered that it holds no conversation to reattach to. */
    known = false,
  ): Promise<TaskRuntime> {
    const record = this.core.options.tasks.get(taskId);
    if (!record) throw new Error(`Unknown task "${taskId}".`);
    // One crewmate per task: one still here is never opened over (INF-2556).
    const held = this.core.tasks.get(record.id);
    if (held) {
      const state = !held.session
        ? " that is starting"
        : held.turn.closing
          ? " that is stopping"
          : "";
      throw new Error(`This task already has a crewmate${state}, so a second one is not opened.`);
    }
    // A committed move to another computer opens a new conversation there,
    // whichever path resumes it first (docs/helper.md, "Moving a started task").
    const moved = record.shape?.computer_move;
    const movedFrom = moved?.restartFrom;
    const fresh: CrewmateRestart | undefined =
      restart ??
      (move ? undefined : this.waitingRestart(record)) ??
      (!move && movedFrom !== undefined
        ? {
            from: movedFrom,
            changed: "computer",
            to: this.core.moves.computerName(this.core.moves.computerOf(record)),
            ...(moved?.away
              ? {
                  leftBehind: {
                    on: this.core.moves.computerName(moved.from),
                    head: moved.away.head,
                  },
                }
              : {}),
          }
        : undefined);
    if (!record.sessionFile) {
      throw new Error(`Task ${taskId} has no session to resume. Spawn a follow-up instead.`);
    }
    // A context or refusal restart is kept on its lane before anything can
    // fail, so a failure, a wait, a refusal or a quit before its new
    // conversation is accepted leaves the next open starting fresh too
    // (`waitingRestart`); one already there is not queued again.
    const restarting = fresh !== undefined && fresh.changed !== "computer";
    if (restarting && this.waitingRestart(record) === undefined)
      this.recordRestart(
        record.id,
        record.key || record.id,
        this.core.facts.machineOf(record.id),
        fresh,
      );
    if (this.retiredProviderOf(taskId)) throw new Error(retiredResumeText(taskId));
    // A resume is an attachment point: re-check the recorded account and
    // move to a sibling (transcript intact) if it died or was removed.
    const previousProvider = this.core.options.router?.servedProvider(taskId);
    const custom = previousProvider && isCustomApiProvider(previousProvider);
    const machine = this.core.facts.machineOf(record.id);
    if (
      machine === LOCAL_MACHINE_ID &&
      custom &&
      (!record.accountId || !this.core.options.accounts?.labelOf(record.accountId))
    )
      throw new Error(
        "This task’s custom connection was disconnected. It cannot resume on another server automatically.",
      );
    // A model that left every level routes again before a new conversation
    // opens, wherever it opens (docs/routing.md, "A model that left every
    // level"); a move names its model. An open that may reattach to a
    // conversation open on its computer waits for no model, and its move
    // is recorded only if that computer opens a new conversation on it.
    const moving = fresh?.changed === "computer";
    // A computer that opens only what it holds is asked that first, on the
    // model and backend it holds, and this routes only once it answers that
    // a new conversation is needed (`reattach-only-open.md`).
    // One holding a conversation this Mac refused opens anew instead.
    const refusedThere = this.core.moves.refusedThere(record.id);
    const reattaching =
      !known &&
      !move &&
      !fresh &&
      machine !== LOCAL_MACHINE_ID &&
      !refusedThere &&
      this.core.options.machines?.reattachOnly?.(machine) === true;
    // An older computer's open may reattach to a conversation open there,
    // or open it again on the model it had: a removed model waits instead.
    const attach =
      !known &&
      !reattaching &&
      !refusedThere &&
      machine !== LOCAL_MACHINE_ID &&
      !fresh &&
      this.core.options.machines?.conversationOpen?.(machine, record.id) === true;
    const routedAgain =
      move || reattaching
        ? undefined
        : await this.core.moves.routeAgainIfLeft(record.id, { machine, ownMove: moving, attach });
    if (routedAgain === "wait") {
      // A restart that waits for a model stays on the lane, so it opens
      // fresh once one can take it (`waitingRestart`).
      throw new ModelWaitError(this.core.moves.modelWaitWords(record.id));
    }
    // A stop, a quit, a close or another move - to another computer, or to
    // another model, which writes a newer routing choice - while this reopen
    // waited took the task: it registers and opens nothing for it.
    const choiceNow = () => {
      const routed = this.core.options.router?.servedChoice(record.id);
      return routed ? `${routed.model.provider}/${routed.model.id}` : undefined;
    };
    const chosen = choiceNow();
    const superseded = () => {
      const now = this.core.options.tasks.get(record.id);
      return (
        !now ||
        now.status === "done" ||
        now.status === "dropped" ||
        this.core.facts.machineOf(record.id) !== machine ||
        choiceNow() !== chosen
      );
    };
    if (routedAgain === "stale" || superseded())
      throw new Error("This task's crewmate was let go while its conversation opened.");
    const rerouted = routedAgain;
    const target = move ?? rerouted;
    // A task on a computer that runs work binds that computer's own
    // account again there; no account of this Mac's is chosen for it.
    const selecting = target
      ? { ...(target.accountId ? { accountId: target.accountId } : {}), changed: false }
      : machine !== LOCAL_MACHINE_ID
        ? { changed: false }
        : custom
          ? { accountId: record.accountId ?? undefined, changed: false }
          : (this.core.options.accounts?.reselectForResume(record.id, record.accountId) ?? {
              ...(record.accountId ? { accountId: record.accountId } : {}),
              changed: false,
            });
    const attachment: ResumeAccount = selecting instanceof Promise ? await selecting : selecting;
    if (superseded())
      throw new Error("This task's crewmate was let go while its conversation opened.");
    // On a computer that runs work, its working copy is there; this Mac holds none.
    // A folder repair that started above its missing folder resumes there (INF-572).
    const startedIn = isFolderRepair(record.shape?.in_place)
      ? record.shape.in_place.started_in
      : undefined;
    const cwd =
      machine === LOCAL_MACHINE_ID
        ? startedIn || record.worktreeDir || record.repoDir
        : this.core.options.machines?.folders(machine, record.id)?.work;
    if (cwd === undefined) throw new Error("The computer this task runs on is out of reach.");
    const crewmate = this.nameCrewmate();
    const task: TaskRuntime = {
      id: record.id,
      title: record.title,
      key: record.key || record.id,
      crewmate,
      ...(machine === LOCAL_MACHINE_ID
        ? {
            workspace: {
              taskId: record.id,
              // A live task has no worktree: its cwd is the workspace itself.
              cwd,
              branch: record.branch,
              repoDir: record.repoDir,
            },
          }
        : {}),
      currentTurnText: "",
      // The durable record remembers the last report across the restart.
      lastCompleteText: record.outcome ?? "",
      turn: new CrewTurn("idle"),
      ...(attachment.accountId ? { accountId: attachment.accountId } : {}),
      filedThisTurn: [],
      withdrawnThisTurn: [],
      lastEventAt: this.core.now(),
      turnStartedAt: this.core.now(),
      quietLevel: 0,
      wallClockEscalated: false,
      clientTasks: new Map(),
      openCalls: new Map(),
      unreadSteers: [],
      openReads: new OpenReads(this.core.now),
    };
    const livePersonal = this.core.facts.isPersonalTask(record.id)
      ? this.core.options.personal
      : undefined;
    const asked: Pick<CrewmateSpec, "model" | "thinkingLevel" | "quick"> = move
      ? { model: move.model, thinkingLevel: move.thinkingLevel }
      : rerouted
        ? {
            model: rerouted.model,
            thinkingLevel: rerouted.thinkingLevel,
            ...(rerouted.quick ? { quick: true } : {}),
          }
        : this.reopenedOn(record);
    // An open that may have opened a new conversation: all but one that
    // only reattaches to what is held there. A move's, and an older
    // computer's, which may reattach or open anew, are checked as new.
    const creation = !reattaching;
    // One opened anew on a computer that runs work is marked refused there
    // before it is asked, so a quit or a failure before it is accepted
    // leaves nothing the next open reattaches to (`refusedThere`).
    if (creation) this.core.moves.refuseOpened(record.id, machine);
    // Register before opening the session: a resumed provider can carry on
    // with work of its own the moment it is back.
    this.core.tasks.set(record.id, task);
    let session: ModelSession;
    try {
      session = await this.openCrewmate(
        task,
        {
          taskId: record.id,
          machineId: machine,
          cwd,
          ...(fresh ? {} : { resumeToken: record.sessionFile }),
          ...(restarting ? { fresh: true } : {}),
          ...(reattaching ? { reattach: true } : {}),
          ...asked,
          ...this.core.toolHooks.crewmateHooks(task, livePersonal),
        },
        // A computer that runs work binds the account there routing chose.
        rerouted?.binding ?? attachment.accountId,
        record.model ?? undefined,
        target?.providerName,
      );
    } catch (caught) {
      if (this.core.tasks.get(record.id) === task) this.core.tasks.delete(record.id);
      // Nothing is held there: a new conversation opens, routed first.
      if (reattaching && caught instanceof NeedsNewConversation)
        return this.openResumed(taskId, move, restart, true);
      // A routed open that surely opened nothing - it failed here, or its
      // computer answered that it left nothing new there - passes that model
      // and account over, and routes among the rest with no delivery spent.
      const nothing = machine === LOCAL_MACHINE_ID || caught instanceof NothingOpenedThere;
      if (rerouted && !superseded() && nothing) {
        rerouted.passOver();
        return this.openResumed(taskId, move, restart, known);
      }
      if (superseded()) throw caught;
      // One on a model it keeps gives its work back unspent all the same.
      if (nothing)
        throw new OpenedNothingError(caught instanceof Error ? caught.message : String(caught), {
          cause: caught,
        });
      // Any other may have opened there - its computer went before it
      // answered, or its answer could not be read: what it may hold stays
      // refused until an open there is accepted, and no words went.
      throw new NotAcceptedError(caught instanceof Error ? caught.message : String(caught), {
        cause: caught,
      });
    }
    // The conversation takes no words until it is accepted: no steer, lane
    // sweep or turn reaches it before (`task.session` is unset). One that is
    // not accepted, or whose check failed, is let go with its runtime.
    const refuse = () => {
      if (this.core.tasks.get(record.id) === task) this.core.tasks.delete(record.id);
      task.session = session;
      this.disposeSession(task);
    };
    let verdict: "committed" | "stale" | "again" | "elsewhere";
    try {
      if (
        creation &&
        machine !== LOCAL_MACHINE_ID &&
        fresh !== undefined &&
        fresh.changed !== "computer" &&
        !distinctFrom(crewmateResumeToken(session.resume()), fresh.from)
      ) {
        // A fresh restart that a computer that runs work, which may hold the
        // conversation it replaces, answered on that one - or on one it does
        // not name - takes no words, rerouted or not.
        this.core.moves.refuseOpened(record.id, machine);
        verdict = "elsewhere";
      } else if (rerouted) {
        // The move is recorded once the conversation opened on its model
        // and an account that serves it; any other open is let go, and the
        // task routes again or waits.
        const model = session.modelRef();
        const account = this.core.options.machines?.servingAccount(session);
        verdict = await rerouted.commit({
          ...(model ? { model } : {}),
          ...(account ? { account } : {}),
        });
      } else if (creation && !sameModel(session.modelRef(), asked.model)) {
        // One opened anew on another model than it asked takes no words.
        this.core.moves.refuseOpened(record.id, machine);
        verdict = "elsewhere";
      } else if (creation && !move && !(await this.core.moves.keepsModel(record.id, machine))) {
        // One opened anew on the model it had takes work only while a level
        // where it opened still holds that model, or the task names it: one
        // that left every level while it opened is let go, and the task
        // routes again. One reattached to, live there, is kept as it is.
        verdict = "again";
      } else verdict = "committed";
    } catch (caught) {
      // A check that could not finish accepted nothing: no words went.
      refuse();
      if (caught instanceof ModelWaitError || caught instanceof NotAcceptedError) throw caught;
      throw new NotAcceptedError(caught instanceof Error ? caught.message : String(caught), {
        cause: caught,
      });
    }
    if (verdict !== "committed") {
      refuse();
      if (verdict === "again") return this.openResumed(taskId, move, restart, known);
      if (verdict === "elsewhere") {
        throw new NotAcceptedError(
          "This task's conversation opened on another model or conversation than it asked, so it takes no words.",
        );
      }
      throw new Error("This task's crewmate was let go while its conversation opened.");
    }
    task.session = session;
    this.endIfLetGo(task);
    this.acceptOpened(session);
    this.core.moves.openedThere(record.id);
    // A sibling account the resume moved to is written, and said, only
    // once the conversation on it was accepted.
    if (attachment.changed) {
      this.core.options.tasks.atomic(
        () => {
          attachment.record?.();
          this.core.options.tasks.placement.setAccountId(record.id, attachment.accountId ?? null);
        },
        () => attachment.selected?.(),
      );
      const moved = attachment.accountId
        ? `moved to ${this.core.options.accounts?.labelOf(attachment.accountId) ?? "another account"}`
        : "continuing without a bound account";
      this.core.options.broadcastEvent({
        type: "firstmate_note",
        text: `Task "${record.title}" ${moved} - its previous account is no longer available.`,
        taskId: record.id,
      });
    }
    task.unsubscribe = await this.core.toolHooks.follow(task, session);
    this.endIfLetGo(task);
    // A moved task's record names the conversation it opened now, so a quit
    // before its first turn ends reopens this one.
    this.recordCrewSession(
      task,
      session,
      task.conversationBegan ?? (target || fresh ? "move" : "resume"),
    );
    if (fresh) {
      // A context or refusal restart is already on its lane (`restarting`).
      if (!restarting) this.recordRestart(task.id, task.key, machine, fresh);
      if (fresh.changed === "context") task.contextRecovered = true;
    }
    const movedThere = this.core.options.tasks.get(record.id)?.shape?.computer_move;
    if (movedThere?.restartFrom !== undefined) {
      const { restartFrom: _told, ...rest } = movedThere;
      this.core.options.tasks.placement.setComputerMove(record.id, rest);
    }
    livePersonal?.beginLiveTask(record.id);
    // A conversation on another computer may be in a turn this Mac follows
    // from here (`continuation_started`), which is no idle boundary.
    if (!task.turn.busy) {
      this.core.options.tasks.turns.setActivity(record.id, "idle");
      // A resume that went idle is an idle boundary: the record's own clock
      // carries across the restart, and a record a quit interrupted mid-turn
      // starts one now.
      this.core.options.tasks.turns.markIdle(record.id);
    }
    this.core.facts.broadcastCrewCounts();
    return task;
  }

  /** Writes what a reopened conversation the task took replaced (`carries`). */
  private acceptOpened(session: ModelSession): void {
    const carry = this.carries.get(session);
    this.carries.delete(session);
    carry?.();
  }

  /**
   * An opening whose crewmate was let go while its conversation opened - a
   * move, a stop or a close took the task meanwhile - ends here: the session
   * it opened goes too, never left running with no task (INF-2556).
   */
  endIfLetGo(task: TaskRuntime): void {
    if (this.core.tasks.get(task.id) === task) return;
    this.disposeSession(task);
    throw new Error("This task's crewmate was let go while its conversation opened.");
  }

  /**
   * What a reopen asks for (INF-1272): the model of the task's newest
   * routing choice, its start's or its newest move's, at the effort a move
   * works out - here or on a computer that runs work. A Claude conversation
   * that starts over after an update has no transcript to restore a model
   * from, so without this it opens on the client's default. A client's
   * fallback is not a routing choice, so the reopen asks for the original
   * again. A task that never routed opens as its session restores it. A
   * model that left every level was routed again before this, or the open
   * waited for one (`TaskMoves.routeAgainIfLeft`), so the choice read here
   * is held, or was the newest model named.
   */
  private reopenedOn(record: TaskRecord): Pick<CrewmateSpec, "model" | "thinkingLevel" | "quick"> {
    const routed = this.core.options.router?.servedChoice(record.id);
    if (!routed) return {};
    const chosen =
      record.shape?.override_reasoning ??
      this.core.options.router?.reasoningChoice(routed.model, routed.slot);
    return {
      model: routed.model,
      thinkingLevel: chosen ?? levelDefaultReasoning(routed.slot),
      // As its start did: Quick care opens a rung lower unless an effort was chosen.
      ...(record.shape?.rigor === "quick" && !chosen ? { quick: true } : {}),
    };
  }

  /**
   * The lifecycle control plane (interrupt_crewmate, the Firstmate's tool;
   * the shell's abort is a cancel). An interrupt's receipt is a feed line:
   * the tool that asked for it already said it happened.
   */
  async interruptCrewmate(
    taskId: string,
    mode: "interrupt" | "cancel",
    source: InterruptSource = { actor: "firstmate", via: "tool", decision: null },
    closingSentence?: string,
  ): Promise<void> {
    if (mode !== "cancel" || !closingSentence) return this.interruptOnce(taskId, mode, source);
    // The first mate's cancel carries its sentence to the close it brings
    // about, now or when the stopped turn ends (INF-547), keyed by the
    // record the close names.
    const id = this.core.options.tasks.resolve(taskId)?.id ?? taskId;
    this.core.settling.closing.expectClosingSentence(id, closingSentence);
    try {
      await this.interruptOnce(taskId, mode, source);
    } catch (caught) {
      this.core.settling.closing.forgetClosingSentence(id);
      throw caught;
    }
    // With no turn left to end, no later close will take it.
    if (!this.core.tasks.has(id)) this.core.settling.closing.forgetClosingSentence(id);
  }

  private async interruptOnce(
    taskId: string,
    mode: "interrupt" | "cancel",
    source: InterruptSource,
  ): Promise<void> {
    // A start that runs behind the first mate's answer (INF-3060) has no
    // crewmate to stop until it has run: the stop or cancel waits for it,
    // then reaches the crewmate it started, or the record it left.
    const behind = this.core.starts.startingBehind(
      this.core.options.tasks.resolve(taskId)?.id ?? taskId,
    );
    if (behind && !this.core.tasks.get(taskId)) await behind.catch(() => undefined);
    const task = this.core.tasks.get(taskId);
    // A stop or a cancel reaches the crewmate: its spark flies first.
    this.core.steer.announceReach(taskId);
    if (!task) {
      const record = this.core.options.tasks.get(taskId);
      if (!record) throw new Error(`Unknown task "${taskId}".`);
      // Already-closed work must not be relabelled cancelled (a second
      // cancel on a done row, including after a merge).
      if (record.status === "done") {
        this.recordInterrupt(taskId, mode, source, "already-done");
        return;
      }
      if (TaskService.isResumable(record)) {
        if (mode === "cancel") {
          this.recordInterrupt(taskId, mode, source, "cancelled-record");
          this.core.settling.closing.closeRecord(record.id, "cancelled", undefined, source.actor);
          this.core.options.broadcastEvent({
            type: "task_finished",
            taskId,
            status: "cancelled",
            title: record.title,
          });
          this.core.facts.broadcastCrewCounts();
          // As `finish` does: the record may be what a queued row, or an
          // active task's wait (FI3-250), is waiting on.
          void this.core.watch.sweepGates(this.core.now());
        } else {
          this.recordInterrupt(taskId, mode, source, "no-turn");
        }
        return;
      }
      throw new Error(`Task ${taskId} is already ${describeStatus(record)}.`);
    }
    if (mode === "cancel") {
      if (!task.turn.busy) {
        this.recordInterrupt(taskId, mode, source, "cancelled-idle");
        this.finish(task, "cancelled");
      } else if (!task.session) {
        task.turn.request("cancel");
        this.recordInterrupt(taskId, mode, source, "no-turn");
      } else {
        this.recordInterrupt(taskId, mode, source, "requested");
        const undo = task.turn.request("cancel");
        try {
          await task.session.abort();
          this.recordInterrupt(taskId, mode, source, "aborted-turn");
        } catch (caught) {
          undo();
          const error = caught instanceof Error ? caught.message : String(caught);
          this.recordInterrupt(taskId, mode, source, "abort-failed", error);
          throw caught;
        }
        // An abort asks the turn to stop; it never promises the turn ends.
        // A Claude client answers the steers it still holds in a turn of its
        // own, and a turn on another computer may never report its end, so
        // waiting for that end left a cancelled task running. The cancel
        // ends the task here, as a settle's stop does; the turn's own end,
        // whenever it comes, finds it gone (`finish`).
        this.finish(task, "cancelled");
      }
      return;
    }
    if (task.turn.busy && !task.turn.running) {
      task.turn.request("stop");
      this.recordInterrupt(taskId, mode, source, "requested");
      return;
    }
    if (task.turn.busy) {
      if (!task.session) {
        this.recordInterrupt(taskId, mode, source, "no-turn");
        return;
      }
      this.recordInterrupt(taskId, mode, source, "requested");
      const undo = task.turn.request("stop");
      try {
        await task.session.abort();
        this.recordInterrupt(taskId, mode, source, "aborted-turn");
        // A stop that found nothing running leaves no end to wait for: the
        // live session is asked at once (INF-2332).
        this.core.turns.confirmTurn(task);
      } catch (caught) {
        undo();
        const error = caught instanceof Error ? caught.message : String(caught);
        this.recordInterrupt(taskId, mode, source, "abort-failed", error);
        throw caught;
      }
      return;
    }
    this.recordInterrupt(taskId, mode, source, "no-turn");
  }

  /** The interrupt request or outcome's timeline event (R2 forward capture). */
  recordInterrupt(
    taskId: string,
    mode: "interrupt" | "cancel",
    source: InterruptSource,
    effect: InterruptEventData["effect"],
    error?: string,
  ): void {
    // An interruption withdraws the captain's kept merge approval (FI3-304:
    // interrupt = revoke); resuming work needs a new click. A move back to
    // the backlog keeps it (INF-2114, the captain's choice): a merge needs no
    // turn, so it goes ahead while the task waits there.
    if (!source.backlog)
      this.core.settling.approvals.revokeMergeAuthorization(
        taskId,
        source.actor === "captain"
          ? "the captain interrupted the crewmate"
          : "the first mate interrupted the crewmate",
      );
    try {
      this.core.options.tasks.turns.recordInterrupt(taskId, {
        actor: source.actor,
        mode,
        effect,
        via: source.via,
        decision: source.decision,
        error,
        ...(source.panel ? { panel: source.panel } : {}),
        ...(source.backlog ? { backlog: true as const } : {}),
      });
    } catch (caught) {
      console.warn("[crew] interrupt capture failed:", caught);
    }
  }

  finish(task: TaskRuntime, status: "cancelled" | "failed", error?: string): void {
    // The turn a settle stopped ends before or after that settle's close,
    // as its backend goes. Either way the close keeps its own reason and
    // hands on what it carries - the captain's choice on an answer reaches
    // the first mate - so this end neither closes the record cancelled nor
    // purges what is queued about it (INF-721: a choice outranks a cancel).
    // The settle releases the runtime once the abort returns.
    if (task.turn.end === "settle") return;
    // A runtime no longer in the crew has ended already: a cancel ended it
    // when its abort returned, before the turn it stopped came to an end.
    // Ending it again would announce a second finish, and could close or
    // purge what a runtime now holding its place carries.
    if (this.core.tasks.get(task.id) !== task) return;
    // A finished task's background jobs die with it, quietly (R2).
    this.core.options.killJobs?.(task.id);
    // This is a terminal close, not an idle boundary: closeRecord retires
    // its cards without presenting work the captain can no longer answer.
    // Rows the final turn consumed reached the transcript; they are not
    // "never delivered" even when that turn failed - the failure op above
    // already reports it. What was still waiting on the lane is, and so is
    // a steer the session accepted that no turn took in.
    const unread = task.turn.running
      ? this.core.turns.undeliveredSteerRows(task)
      : [...task.turn.rows];
    const rows = task.turn.takeRows();
    if (rows.length > 0) {
      this.core.options.inbox.ack(rows.filter((id) => !unread.includes(id)));
      this.core.options.inbox.reparkUndelivered(unread);
    }
    const undeliveredRows = this.core.options.inbox.allFor(task.id);
    if (undeliveredRows.length > 0) {
      // The task ended before its recorded guidance could become a turn.
      // Saying so is the whole point of recording it visibly - on the task's
      // own timeline, which keeps the guidance, and as one feed line; never
      // a Firstmate wake about a task that is closing (WI-5).
      this.core.watch.recordUndeliveredGuidance(
        task.id,
        task.title,
        `the task ${status} first`,
        undeliveredRows,
      );
    }
    this.releaseSession(task);
    this.core.tasks.delete(task.id);
    this.core.settling.locks.turnEnded(task.id);
    this.core.options.personal?.endLiveTask(task.id);
    // A record another close already ended keeps its own reason; the turn's
    // end must not relabel it. Either way nothing queued about the task
    // survives.
    const record = this.core.options.tasks.get(task.id);
    if (record && (record.status === "open" || record.status === "active")) {
      // A typed backend's session failure has no class: it is never read as
      // a sign-in or an allowance from its words (a client exit is a session
      // failure, docs/quota.md "Typed cut-offs").
      const typed = task.session?.controlProfile.failureSignals === "typed" ? {} : undefined;
      this.core.settling.closing.closeRecord(task.id, status, error, "host", typed);
    } else {
      this.core.options.inbox.purgeTask(task.id);
    }
    if (status === "failed") {
      // After the purge and straight to the Firstmate: the task is closed,
      // so a triage wake would be set aside unread (WI-2), and a terminal
      // failure is the captain's to hear.
      this.core.hooks().notifyOp(
        {
          facts: {
            kind: "task-failed",
            task: { id: task.id, title: task.title },
            error: capWithOverflow(error ?? "unknown error", "task-failed"),
          },
        },
        "agent",
        task.id,
      );
    }
    this.core.options.broadcastEvent({
      type: "task_finished",
      taskId: task.id,
      status,
      title: task.title,
      ...(error ? { error } : {}),
    });
    this.core.facts.broadcastCrewCounts();
    // A finished task may be the gate a queued row waits on (R1).
    void this.core.watch.sweepGates(this.core.now());
  }

  stopRuntime(taskId: string): Promise<void> | undefined {
    const runtime = this.core.tasks.get(taskId);
    if (!runtime) return undefined;
    runtime.turn.request("settle");
    return (async () => {
      await runtime.session?.abort().catch(() => {});
      this.releaseSession(runtime);
      this.core.tasks.delete(taskId);
    })();
  }

  /**
   * Let go of a crewmate's session: the task stops hearing it and the
   * session is disposed. A turn it is still settling is owed to the usage
   * ledger - an interrupted Claude turn reports its tokens and cost only in
   * the result that arrives after the interrupt's round trip - so a
   * usage-only listener takes the task's place until the session is gone.
   * Only usage: the task is closing, and its state, feed and cards are not
   * the settling turn's to change. A turn that already settled was recorded
   * by the task's own subscriber and emits nothing more, so nothing is
   * counted twice.
   */
  releaseSession(runtime: TaskRuntime): void {
    this.core.turns.turnOver(runtime.id);
    this.disposeSession(runtime);
  }

  /** The session goes; a turn it is still settling is owed to the usage ledger (`releaseSession`). */
  private disposeSession(runtime: TaskRuntime): void {
    const session = runtime.session;
    // A copy replaced by an update waits for every client to be gone, so
    // each conversation is written down before the new copy reads it.
    if (session?.isStreaming() || (session && this.core.updates.savedHere())) {
      const unsubscribe = session.subscribe((event) => {
        if ((event.type === "turn_end" || event.type === "tool_end") && event.usage) {
          this.core.turns.recordUsage(runtime, event.usage);
        }
      });
      const released: Promise<void> = session
        .closed()
        .catch(() => {})
        .then(() => {
          unsubscribe();
          this.releasing.delete(released);
        });
      this.releasing.add(released);
    }
    const following = runtime.unsubscribe?.();
    runtime.unsubscribe = undefined;
    if (following) {
      const released = following.finally(() => this.releasing.delete(released));
      this.releasing.add(released);
    }
    session?.dispose();
  }

  /**
   * A crewmate in a turn, opening, settling or moving, or with work of its
   * client's own still running: its conversation's files are not to be
   * written by anyone else now (`SavedOutsideData`).
   */
  conversationBusy(taskId: string): boolean {
    const runtime = this.core.tasks.get(taskId);
    if (this.core.moves.isMoving(taskId)) return true;
    if (!runtime) return false;
    return (
      runtime.turn.busy ||
      !runtime.session ||
      runtime.session.isStreaming() ||
      runtime.clientTasks.size > 0
    );
  }

  /** A live crewmate holds its conversation's files. */
  conversationHeld(taskId: string): boolean {
    return this.core.tasks.has(taskId) || this.core.moves.isMoving(taskId);
  }

  /**
   * Let go of an idle crewmate's session, as a move does, so a pass can
   * write its files again whole: its next delivery resumes it from them.
   * False while it is busy.
   */
  async releaseConversation(taskId: string): Promise<boolean> {
    if (this.conversationBusy(taskId)) return false;
    const runtime = this.core.tasks.get(taskId);
    if (!runtime) return true;
    this.releaseSession(runtime);
    this.core.tasks.delete(taskId);
    await runtime.session?.closed().catch(() => {});
    return true;
  }

  /** Candidate credentials may replace a connection only between matching turns. */
  accountHasActiveTurns(accountId: string): boolean {
    return [...this.core.tasks.values()].some(
      (task) => task.accountId === accountId && (task.turn.busy || task.session?.isStreaming()),
    );
  }

  /** Disconnect preserves task/session history and stops this account's work only. */
  async disconnectAccount(accountId: string): Promise<void> {
    const matching = [...this.core.tasks.values()].filter((task) => task.accountId === accountId);
    for (const task of matching) {
      this.core.options.killJobs?.(task.id);
      await this.interruptCrewmate(task.id, "interrupt", {
        actor: "captain",
        via: "shell",
        decision: null,
      });
    }
  }

  /** The shell's abort: the captain cancelling directly, not through the Firstmate. */
  async abort(taskId: string): Promise<void> {
    await this.interruptCrewmate(taskId, "cancel", {
      actor: "captain",
      via: "shell",
      decision: null,
    }).catch(() => {});
  }

  /**
   * A computer that runs work is being removed (docs/devices.md, "Remove"):
   * each task started there stops, as the captain's Stop stops one, and
   * this resolves once each one's record is closed. One whose computer is
   * out of reach cannot end its turn there, so it stops here at once, and
   * so does one still open after `boundMs`. A task that has not started
   * follows its project instead (`TaskPlacement.projectMoved`), and one the
   * captain said runs there follows its parent's or its project's again.
   */
  async stopTasksOn(deviceId: string, boundMs = 60_000): Promise<void> {
    for (const taskId of this.core.options.tasks.placement.forgetRunsOn(deviceId))
      this.core.placement.runsOnChanged(taskId);
    const source: InterruptSource = { actor: "captain", via: "shell", decision: null };
    const started = this.core.options.tasks
      .listLive()
      .filter(
        (record) =>
          record.deviceId === deviceId &&
          Boolean(
            record.placement ||
              record.branch ||
              record.sessionFile ||
              this.core.tasks.has(record.id),
          ),
      )
      .map((record) => record.id);
    const stopHere = (taskId: string) => {
      const task = this.core.tasks.get(taskId);
      if (!task) {
        const record = this.core.options.tasks.get(taskId);
        if (record?.placement && !TaskService.isClosed(record))
          this.core.settling.closing.closeRecord(taskId, "cancelled", undefined, "captain");
        return;
      }
      this.recordInterrupt(taskId, "cancel", source, "requested");
      this.finish(task, "cancelled");
    };
    for (const taskId of started) {
      if (this.core.tasks.has(taskId) && this.core.facts.outOfReach(taskId)) {
        stopHere(taskId);
        continue;
      }
      await this.interruptCrewmate(taskId, "cancel", source).catch(() => stopHere(taskId));
    }
    const open = () =>
      started.filter((taskId) => {
        const record = this.core.options.tasks.get(taskId);
        return record !== undefined && !TaskService.isClosed(record);
      });
    if (open().length === 0) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        off();
        resolve();
      };
      const off = this.core.options.tasks.onChange(() => {
        if (open().length === 0) done();
      });
      const timer = setTimeout(() => {
        for (const taskId of open()) stopHere(taskId);
        done();
      }, boundMs);
      timer.unref?.();
    });
  }
}

export function retiredResumeText(taskId: string): string {
  return `Task ${taskId} ran on a subscription Infinitary no longer offers, so its session cannot be resumed. Spawn a follow-up crewmate instead.`;
}
