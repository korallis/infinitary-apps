import { homedir } from "node:os";
import { join } from "node:path";
import type { CheckChangeInput } from "@shared/checkRepair";
import { type SpeedSelection, speedNote } from "@shared/crewSpeed";
import { COMPUTER, HOME } from "@shared/deviceNames";
import type { FmEvent } from "@shared/events";
import { isPullRepair } from "@shared/routingPolicy";
import { protectedPlaces } from "../files/fileReach";
import type {
  DownloadArtifactInput,
  GithubReadInput,
  GithubWriteInput,
  ReadWorkflowInput,
} from "../forge";
import { hostEnv } from "../hostEnv";
import { jobExitWake } from "../jobs/jobManager";
import { knowledgeBinding } from "../knowledge/knowledgeTools";
import {
  crewmateCardBodiesDir,
  crewmateCardPicturesDir,
  crewmateEvidenceDir,
  crewmateHandoverDir,
  crewmateSessionsDir,
  crewmateTempDir,
} from "../paths";
import type { PanelPlaceResult } from "../personal/personalExtensions";
import { renderPlaceText } from "../pi/panelTools";
import { followCompletions } from "../session/followCompletions";
import {
  type ClientBackgroundTask,
  LOCAL_MACHINE_ID,
  type ModelSession,
  type SessionEvent,
} from "../session/session";
import type { SecretUsesElsewhere } from "../session/tools";
import {
  queryTasksAsync,
  type TaskQueryInput,
  type TaskQueryReach,
  type TaskQueryRow,
} from "../tasks/taskQuery";
import type { WebReadInput } from "../web/publicPage";
import { cardMutationText } from "./cardMutationText";
import { declareRunCheck } from "./checkRepair";
import type { CrewCore } from "./crewCore";
import { heardDirections } from "./crewDirections";
import { CrewmatePrograms } from "./crewmatePrograms";
import type { TaskRuntime } from "./crewRuntime";
import type { CrewmateSpec } from "./crewSession";
import type { PersonalLiveDelegate } from "./crewSupervisorOptions";
import { readerReport, readerReportRefusal } from "./readerData";
import { servedNewestBody, servedResolutionForTask } from "./readerResolution";
import type { WakeBody } from "./wakes";
import { deliverableOf } from "./workShape";

/**
 * What a crewmate's session calls back into the host
 * (docs/architecture.md section 2): its tools' hooks - cards, reports,
 * knowledge, the panel, where the project lives and the task's commands -
 * and its session events, which are its task's activity and reach the
 * feed. Shares the crew's state through `CrewCore`.
 */
export class CrewToolHooks {
  private readonly programs: CrewmatePrograms;

  constructor(private readonly core: CrewCore) {
    this.programs = new CrewmatePrograms(core);
  }

  crewmateHooks(
    task: TaskRuntime,
    personal: PersonalLiveDelegate | undefined,
  ): Omit<CrewmateSpec, "taskId" | "machineId" | "cwd"> {
    // On a computer that runs work, its tools write where they run: the
    // crewmate is told that computer's folders.
    const machine = this.core.facts.machineOf(task.id);
    const there =
      machine === LOCAL_MACHINE_ID
        ? undefined
        : this.core.options.machines?.folders(machine, task.id);
    // An unsafe data reader holds strangers' words, so it gets no shell and none
    // of the commands that ride it, no program, and no read of the captain's
    // record or saved knowledge (docs/agents-reach.md, "An unsafe data reader").
    const reader = this.core.options.tasks.get(task.id)?.shape?.unsafe_data_reader === true;
    return {
      ...(reader ? { fenced: true as const } : {}),
      onSpeed: (model, selection) => this.noteSpeed(task.id, model, selection),
      requestedSpeed: (model) =>
        this.core.options.tasks.get(task.id)?.shape?.override_speed ??
        this.core.options.crewSpeed?.(model) ??
        "standard",
      picturesDir: there?.cards ?? crewmateCardPicturesDir(this.core.options.paths, task.id),
      cardBodiesDir: there?.cardBodies ?? crewmateCardBodiesDir(this.core.options.paths, task.id),
      evidenceDir: there?.evidence ?? crewmateEvidenceDir(this.core.options.paths, task.id),
      tempDir: there?.temp ?? crewmateTempDir(this.core.options.paths, task.id),
      // A task on another computer keeps its reported files there and sends them home.
      ...(machine === LOCAL_MACHINE_ID
        ? {
            handoverDir: crewmateHandoverDir(this.core.options.paths, task.id),
            protectedPlaces: protectedPlaces({
              userData: this.core.options.paths.userData,
              home: hostEnv().HOME ?? homedir(),
            }),
          }
        : {}),
      // A task held on another computer checks its recordings and fonts where it runs.
      ...(machine === LOCAL_MACHINE_ID && this.core.options.probeMedia
        ? { probeMedia: this.core.options.probeMedia }
        : {}),
      ...(machine === LOCAL_MACHINE_ID && this.core.options.probeTypeface
        ? { probeTypeface: this.core.options.probeTypeface }
        : {}),
      contributionNotes: true,
      onCard: (card) =>
        card.presentationRevision === undefined
          ? this.core.crewmateCards.crewmateCardWrite(task, card)
          : this.core.crewmateCards.afterRedraw(task.id, () =>
              this.core.crewmateCards.crewmateCardWrite(task, card),
            ),
      onCardRefused: (refusal) => this.core.crewmateCards.recordCardRefusal(task, refusal),
      onCloseCard: (input) =>
        this.core.closeCard(input.cardId, { kind: "crewmate", taskId: task.id }, input.reason),
      // A reader's follow-up naming an issue is a Build row the captain files
      // (docs/agents-reach.md, "A reader's Build rows"); any other is filed now.
      onFollowup: (input) =>
        input.issue !== undefined || input.startAs !== undefined
          ? this.core.buildRows.keep(task.id, input)
          : this.core.reportIntake.fileFollowup(task, input),
      // Served only where a program can run (docs/programs.md, "Starting a program").
      ...(!reader && this.programs.servedTo(task.id)
        ? { onStartProgram: (input) => this.programs.start(task, input) }
        : {}),
      onProgress: (text, plan) => this.core.reportIntake.noteProgress(task, text, plan),
      onReport: (text, summary, declared) => {
        if (!reader) return this.core.turns.recordReportFromSession(task, text, summary, declared);
        const refused = readerReportRefusal(declared);
        if (refused) throw new Error(refused);
        return this.core.turns.recordReportFromSession(
          task,
          ...readerReport(text, declared, Date.now()),
        );
      },
      onReply: (input) => this.core.cards.replyFromCrewmate(task.id, input),
      onReviseRequiredAction: (input) =>
        cardMutationText(
          this.core.cards.reviseRequiredAction({ actor: "crewmate", taskId: task.id }, input),
        ),
      ...(reader
        ? {}
        : {
            onReadCard: (cardId: string) => this.core.crewmateCards.readCard(cardId),
            onQueryTasks: (input: TaskQueryInput) => this.queryTasks(input),
            ...this.knowledgeHooks(task, machine),
            ...this.panelToolHooks(task, personal),
          }),
      ...this.forgeToolHooks(task),
      ...(reader ? this.readerIntegrationHooks(task) : this.taskCommandHooks(task, machine)),
    };
  }

  /**
   * An unsafe data reader's integrations, as typed tools since it has no
   * shell for the command: its task's rules, every answer fenced whole, and
   * every call that waits kept on its one approval card
   * (`IntegrationsService.forReader`).
   */
  private readerIntegrationHooks(
    task: TaskRuntime,
  ): Pick<CrewmateSpec, "onIntegrations" | "onUseIntegration"> {
    const reach = this.core.options.integrations?.forReader?.(task.id);
    if (!reach) return {};
    return {
      onIntegrations: async ({ name }) => {
        if (name === undefined) return JSON.stringify({ integrations: await reach.list() });
        const shown = await reach.show(name);
        return "refused" in shown ? String(shown.text) : JSON.stringify(shown);
      },
      onUseIntegration: async (input) =>
        (await reach.call(input.name, input.action, input.input ?? {}, undefined, input.reason))
          .text,
    };
  }

  /**
   * The task's commands in its crewmate's shell: its integrations, through
   * `infinitary-integrations-axi` (docs/integrations.md), and the task's own
   * browser, through `infinitary-browser-axi` (docs/axi-commands.md). They
   * run on the computer the task runs on, beside that shell: on this Mac
   * through this Mac's task channel, and on a computer that runs work
   * through that computer's own, where its roster says it keeps browsers
   * (docs/task-browser.md, "On another computer"). The browser there is that
   * computer's own; the integrations stay this Mac's, and that computer asks
   * this Mac each call where it lists the change for it ("On a computer that
   * runs work"). With no channel, or a computer that keeps none, there is no
   * way to reach either.
   */
  private taskCommandHooks(
    task: TaskRuntime,
    machine: string,
  ): Pick<
    CrewmateSpec,
    | "browser"
    | "shell"
    | "integrations"
    | "load"
    | "files"
    | "secrets"
    | "secretsCatalog"
    | "secretUses"
    | "stops"
  > {
    const {
      browsers,
      taskCommands,
      integrations,
      machines,
      load,
      files,
      secrets,
      stops,
      feedback,
    } = this.core.options;
    const hasLoad = load?.available(machine) === true;
    if (machine !== LOCAL_MACHINE_ID) {
      const command =
        secrets && machines?.takesSecrets?.(machine) ? secrets.forTask(task.id) : undefined;
      // Its shell there is granted the commands; this Mac reads its browser
      // for the captain and answers its integrations' calls and its files'.
      return {
        ...(hasLoad ? { load: true } : {}),
        // Its stops are kept and run there, beside its shell (docs/leftover-programs.md).
        ...(machines?.takesStops?.(machine) ? { stops: true } : {}),
        ...(browsers && machines?.keepsBrowsers?.(machine)
          ? { browser: browsers.forTask(task.id) }
          : {}),
        ...(integrations && machines?.takesIntegrations?.(machine)
          ? { integrations: integrations.forTask(task.id) }
          : {}),
        ...(files && machines?.takesFiles?.(machine) ? { files: files.forTask(task.id) } : {}),
        ...(command ? { secretsCatalog: { list: () => command.list() } } : {}),
        // Its uses are decided here and run there (docs/secrets.md, "On a computer that runs work").
        ...(command && secrets?.elsewhere && machines?.takesSecretUses?.(machine)
          ? { secretUses: this.secretUsesThere(secrets.elsewhere(task.id), machine) }
          : {}),
      };
    }
    if (!taskCommands) return {};
    const browser = browsers?.forTask(task.id);
    // Every crewmate here reaches the integrations (docs/integrations.md)
    // and the files on the captain's other computers (docs/files.md).
    const reach = integrations?.forTask(task.id);
    const otherFiles = files?.forTask(task.id);
    const secretRequests = secrets?.forTask(task.id);
    // Every crewmate here registers how to stop what it leaves running.
    const taskStops = stops?.forTask(task.id);
    // Every crewmate here can draft a /feedback report (docs/feedback.md).
    const taskFeedback = feedback?.forTask(task.id);
    if (
      !browser &&
      !reach &&
      !hasLoad &&
      !otherFiles &&
      !secretRequests &&
      !taskStops &&
      !taskFeedback
    )
      return {};
    return {
      ...(hasLoad ? { load: true } : {}),
      ...(taskStops ? { stops: true } : {}),
      ...(browser ? { browser } : {}),
      ...(reach ? { integrations: reach } : {}),
      ...(otherFiles ? { files: otherFiles } : {}),
      ...(secretRequests ? { secrets: true as const } : {}),
      shell: taskCommands.grant(task.id, {
        ...(hasLoad && load ? { load: load.forTask(task.id) } : {}),
        ...(browser ? { browser } : {}),
        ...(reach ? { integrations: reach } : {}),
        ...(otherFiles ? { files: otherFiles } : {}),
        ...(secretRequests ? { secrets: secretRequests } : {}),
        ...(taskStops ? { stops: taskStops } : {}),
        ...(taskFeedback ? { feedback: taskFeedback } : {}),
      }),
    };
  }

  /**
   * A task's Secrets on a computer that runs work: its uses always, and its
   * asks to keep a secret only where that computer's command offers them
   * (docs/secrets.md, "Asking to keep a secret"), so its crewmate is never
   * told to ask what its command there cannot ask.
   */
  private secretUsesThere(uses: SecretUsesElsewhere, machine: string): SecretUsesElsewhere {
    if (uses.ask && this.core.options.machines?.takesSecretAsks?.(machine)) return uses;
    const { ask: _ask, ...withoutAsk } = uses;
    return withoutAsk;
  }

  /**
   * The knowledge pair for every crewmate (docs/knowledge.md, "Who has it"), read and written
   * here, in this Mac's knowledge, whatever computer the task runs on. A
   * computer that runs work forwards each call here once it speaks
   * `KNOWLEDGE_THERE_SINCE`. Its working copy there is no folder of this
   * Mac's, so a kept source is checked where a reader with none checks it.
   */
  private knowledgeHooks(task: TaskRuntime, machine: string): Pick<CrewmateSpec, "knowledge"> {
    const knowledge = this.knowledgeFor(task.id, machine);
    const record = this.core.options.tasks.get(task.id);
    const repoId = record?.repoId;
    if (!knowledge) return {};
    const cwd = machine === LOCAL_MACHINE_ID ? task.workspace?.cwd : undefined;
    return {
      knowledge: knowledgeBinding(knowledge, () => ({
        kind: "crewmate",
        taskId: task.id,
        repoId: repoId ?? "",
        ...(cwd ? { cwd } : {}),
      })),
    };
  }

  /**
   * This Mac's knowledge, for a crewmate whose task runs on `machine`: on
   * this Mac, or a computer that forwards the knowledge pair here. Absent
   * when no service was provided, or for a computer on an older contract.
   */
  knowledgeFor(taskId: string, machine = this.core.facts.machineOf(taskId)) {
    if (machine === LOCAL_MACHINE_ID || this.core.options.machines?.takesKnowledge?.(machine))
      return this.core.options.knowledge;
    return undefined;
  }

  /**
   * A crewmate's session events: a continuation the backend began on its
   * own gets the same host-owned turn boundary a prompt has, the owner-only
   * events stop here, and every other event is the task's activity and
   * reaches the feed.
   */
  async follow(task: TaskRuntime, session: ModelSession): Promise<() => Promise<void>> {
    task.clientJobs = undefined;
    task.clientJobsSince = undefined;
    task.clientJob = undefined;
    task.clientTasks.clear();
    const unsubscribe = await followCompletions(
      session,
      (event) => {
        if (event.type === "tool_observation") {
          this.core.options.tasks.observeTool(task.id, event, (notice) => {
            const queued = this.core.routeCrewEvent(
              task.id,
              {
                once: notice.identity,
                facts: {
                  kind: "possible-repetition",
                  task: { id: task.id, title: task.title },
                  notice,
                  usage: this.core.options.latestUsage?.(task.id) ?? null,
                },
              },
              "agent",
            );
            if (queued === undefined) throw new Error("The first mate inbox is not attached yet");
          });
          return;
        }
        if (
          !task.turn.pause &&
          (event.type === "input_read" ||
            event.type === "request_started" ||
            event.type === "continuation_started")
        )
          this.core.restarts.recordRestartOutcome(task.id, "resumed");
        if (event.type === "turn_failed" && !task.turn.pause)
          this.core.restarts.recordRestartOutcome(task.id, "stopped", event.error);
        // A steer is read once its session says so, or once a model request
        // begins after it was handed over (INF-2603).
        if (event.type === "input_read") {
          const at = task.unreadSteers.findIndex((steer) => steer.sha === event.textSha256);
          if (at >= 0) task.unreadSteers.splice(at, 1);
        } else if (event.type === "request_started") task.unreadSteers = [];
        // The directions it read stay held until a fold (INF-2599).
        task.directions = heardDirections(task.directions, event);
        if (event.type === "background_work_changed") {
          task.clientJobs = event.count;
          task.clientJobsSince =
            (event.count ?? 0) > 0 ? (task.clientJobsSince ?? this.core.now()) : undefined;
          task.clientJob = (event.count ?? 0) > 0 ? event.job : undefined;
          if (event.count === undefined) this.clientEnded(task);
          else if (event.tasks) this.keepClientTasks(task, event.tasks);
          this.core.facts.broadcastCrewCounts();
          return;
        }
        if (event.type === "continuation_started") {
          this.core.turns.startAutonomousTurn(task, laneRowsOf(event.order));
          return;
        }
        if (event.type === "continuation_ended") {
          this.core.turns.endAutonomousTurn(task, event.error, event.cutOff, event.unheard);
          return;
        }
        if (event.type === "model_served") {
          this.core.turns.recordServedModel(task, event);
          return;
        }
        if (event.type === "turn_closed") {
          // A turn's closing words, as its session read them, are its report
          // candidate (WI-1), and a turn that closed on none leaves none. Pi
          // ends a turn per model message, so they match what it streamed;
          // Claude ends one per prompt and closes on the client's final
          // assistant text, so the text its earlier messages streamed ahead
          // of their tool calls - a self-brief, a note to itself - never
          // stands in for a report.
          task.turnReport = event.text?.trim() ? event.text : undefined;
          return;
        }
        // A turn its computer's update cut is paused, never failed: its end
        // carries it on (`turnComplete`), and the feed says no failure.
        if (event.type === "turn_failed" && task.turn.pause) {
          task.lastTurnError ??= event.error;
          return;
        }
        if (!isBroadcastEvent(event)) return;
        this.core.watch.noteTaskActivity(task);
        this.applyEvent(task, event);
        this.core.options.broadcastEvent(enrichEvent(task, event));
      },
      this.core.now,
      this.core.facts.machineOf(task.id) === LOCAL_MACHINE_ID,
      join(this.core.options.paths.crewmatesDir, task.id, "completions.sqlite"),
    );
    // Only a crewmate let go meanwhile stops its start here. One a cancel
    // reached while it started is still the task's: the cancel ends it as a
    // cancel once the start has run (`CrewTurns.prepareFirstTurn`), never as
    // a start that failed, which would put the task back to wait.
    if (this.core.tasks.get(task.id) !== task) {
      await unsubscribe();
      throw new Error("The task closed while its transcript was being located.");
    }
    return unsubscribe;
  }

  /**
   * The background tasks this Mac's Claude client names for the crewmate
   * now, each keeping when it was first seen. A conversation on another
   * computer names none here: that computer keeps and tells its own
   * (`SessionHost`).
   */
  private keepClientTasks(task: TaskRuntime, named: readonly ClientBackgroundTask[]): void {
    const kept: TaskRuntime["clientTasks"] = new Map();
    for (const { id, description } of named)
      kept.set(id, { description, since: task.clientTasks.get(id)?.since ?? this.core.now() });
    task.clientTasks = kept;
  }

  /**
   * The crewmate's Claude client ended while this Mac ran on, and the
   * background tasks it still ran ended with it: each becomes the
   * crewmate's `[job]` turn, once, so it never waits on them. A task being
   * stopped has nobody waiting.
   */
  private clientEnded(task: TaskRuntime): void {
    if (!task.turn.closing)
      for (const [id, run] of task.clientTasks)
        this.core.watch.deliverJobResult(task.id, this.clientTaskEnd(task, id, run, "client"));
    task.clientTasks.clear();
  }

  /** A Claude client's background task that ended with it, as the crewmate's `job-exit` wake. */
  clientTaskEnd(
    task: TaskRuntime,
    id: string,
    run: { description: string; since: number },
    interrupted: "client" | "quit",
  ): WakeBody {
    return jobExitWake(
      {
        jobId: id,
        ownerId: task.id,
        command: run.description,
        exitCode: null,
        durationMs: Math.max(0, this.core.now() - run.since),
        tail: "",
        interrupted,
      },
      "crewmate",
    );
  }

  /**
   * The crewmate's pair where the project lives (git integration PR 1.2):
   * every crewmate whose task ships a change, whatever the posture today -
   * a posture can change mid-task, and the tools answer for the posture at
   * the call. Read-only workflow evidence and the API pair also belong on
   * answer tasks, whose every write asks the captain; the delivery pair
   * does not. None belong on the personal workspace.
   */
  private forgeToolHooks(
    task: TaskRuntime,
  ): Pick<
    CrewmateSpec,
    | "onPrepareChange"
    | "onOpenChange"
    | "onShowMergeCard"
    | "onCheckChange"
    | "onReadWorkflow"
    | "onDownloadArtifact"
    | "onGithubRead"
    | "onGithubWrite"
    | "onWebRead"
  > {
    if (this.core.facts.isPersonalTask(task.id)) return {};
    // An unsafe data reader reaches where its project lives only through the
    // API pair, whose answers the gateway fences and whose writes all wait
    // for the captain: a workflow log or artifact would bring outside words
    // in unfenced (docs/agents-reach.md, "An unsafe data reader").
    // Its one way onto the web is web_read, whose pages come fenced and whose
    // new addresses wait for the captain once it holds something of theirs.
    if (this.core.options.tasks.get(task.id)?.shape?.unsafe_data_reader === true) {
      const { githubRead, githubWrite, webRead } = this.core.options;
      return {
        ...(githubRead
          ? { onGithubRead: (input: GithubReadInput) => githubRead(task.id, input) }
          : {}),
        ...(githubWrite
          ? { onGithubWrite: (input: GithubWriteInput) => githubWrite(task.id, input) }
          : {}),
        ...(webRead
          ? {
              onWebRead: (input: WebReadInput, signal?: AbortSignal) =>
                webRead(task.id, input, signal),
            }
          : {}),
      };
    }
    // A task that works in place ships nothing; the one that closes a pull
    // request an abandoned task left open reads and writes where the project
    // lives, and nothing else (INF-549's sibling).
    if (
      this.core.facts.worksInPlace(task.id) &&
      deliverableOf(this.core.options.tasks.get(task.id)) !== "operation"
    ) {
      if (!isPullRepair(this.core.options.tasks.get(task.id)?.shape?.in_place)) return {};
      const { githubRead, githubWrite } = this.core.options;
      return {
        ...(githubRead
          ? { onGithubRead: (input: GithubReadInput) => githubRead(task.id, input) }
          : {}),
        ...(githubWrite
          ? { onGithubWrite: (input: GithubWriteInput) => githubWrite(task.id, input) }
          : {}),
      };
    }
    const {
      prepareChange,
      openChange,
      mergeCardSteps,
      checkChange,
      readWorkflow,
      downloadArtifact,
      githubRead,
      githubWrite,
    } = this.core.options;
    const machine = this.core.facts.machineOf(task.id);
    const canPrepare =
      machine === LOCAL_MACHINE_ID ||
      this.core.options.machines?.takesChangePresentations?.(machine);
    // A computer that takes no current work keeps the three calls (`major-16.md`).
    const canShowMergeCard =
      machine === LOCAL_MACHINE_ID || this.core.options.machines?.takesMergeCardCall?.(machine);
    return {
      ...(openChange &&
      checkChange &&
      deliverableOf(this.core.options.tasks.get(task.id)) === "change"
        ? {
            ...(prepareChange && canPrepare
              ? {
                  onPrepareChange: (
                    input: import("@shared/changePresentation").StagedChangePresentation,
                  ) =>
                    this.core.crewmateCards.afterRedraw(task.id, () =>
                      prepareChange(task.id, input),
                    ),
                }
              : {}),
            onOpenChange: (input: import("@shared/changePresentation").OpenChangeInput) =>
              this.core.crewmateCards.afterRedraw(task.id, () => openChange(task.id, input)),
            ...(prepareChange && mergeCardSteps && canPrepare && canShowMergeCard
              ? {
                  onShowMergeCard: async (
                    input: import("@shared/changePresentation").ShowMergeCardInput,
                  ) =>
                    this.core.crewmateCards.whileShowing(task.id, async () =>
                      this.core.crewmateCards.showMergeCard(
                        task,
                        await mergeCardSteps(task.id, input.story),
                        input.card,
                      ),
                    ),
                }
              : {}),
            onCheckChange: async (input?: CheckChangeInput) => {
              const read = await checkChange(task.id, input);
              // A declaration that ended the approval in front with a hold
              // ends the task's other approvals now, not at the next run
              // (INF-2746); one that ended it without a hold lets the next go.
              if (input?.captainGuidance || input?.conflictRepair)
                this.core.settling.approvals.promoteQueued(task.id);
              return read;
            },
          }
        : {}),
      // An operation reads and reruns workflow runs with no pull request: its
      // check_change records the diagnosis and reserves the rerun (INF-2146).
      ...(deliverableOf(this.core.options.tasks.get(task.id)) === "operation"
        ? {
            onCheckChange: async (input?: CheckChangeInput) =>
              declareRunCheck(this.core.options.tasks, task.id, input ?? {}, this.core.now()),
          }
        : {}),
      ...(readWorkflow
        ? { onReadWorkflow: (input: ReadWorkflowInput) => readWorkflow(task.id, input) }
        : {}),
      ...(downloadArtifact
        ? { onDownloadArtifact: (input: DownloadArtifactInput) => downloadArtifact(task.id, input) }
        : {}),
      ...(githubRead
        ? { onGithubRead: (input: GithubReadInput) => githubRead(task.id, input) }
        : {}),
      // A task that only answers writes too: all but a run start or rerun on its own project asks the captain (FI3-1571, INF-729).
      ...(githubWrite
        ? { onGithubWrite: (input: GithubWriteInput) => githubWrite(task.id, input) }
        : {}),
    };
  }

  /**
   * The live-build checks a crewmate on the personal workspace gets (Step 4):
   * absent on every other posture, so the tools never appear where there is
   * no panel to check.
   */
  private panelToolHooks(
    task: TaskRuntime,
    personal: PersonalLiveDelegate | undefined,
  ): Pick<CrewmateSpec, "onLintPanel" | "onPlacePanel" | "onCapturePanel"> {
    if (!personal) return {};
    return {
      onLintPanel: (input) => personal.lint(input),
      onPlacePanel: (input) => this.placePanel(task, personal, input.id),
      onCapturePanel: (input) => personal.capture({ id: input.id, taskId: task.id }),
    };
  }

  /**
   * `place_panel` for a crewmate on the personal workspace: its version goes
   * on the captain's rail, and the window's answer lands on the task's
   * timeline (never the feed) beside going back to the crewmate, so the
   * record shows what the captain's rail held before the report.
   */
  private async placePanel(
    task: TaskRuntime,
    personal: PersonalLiveDelegate,
    id: string | undefined,
  ): Promise<PanelPlaceResult> {
    const result = await personal.place({ taskId: task.id, ...(id ? { id } : {}) });
    if (result.ok && this.core.options.tasks.get(task.id)) {
      this.core.options.tasks.note(task.id, `placed on the rail: ${renderPlaceText(result)}`, {
        news: false,
        data: { placed: result.panels },
      });
    }
    return result;
  }

  noteSpeed(
    taskId: string,
    model: { provider: string; id: string },
    selection: SpeedSelection,
  ): void {
    const task = this.core.options.tasks.get(taskId);
    if (!task) return;
    const text = speedNote(model, selection);
    this.core.options.tasks.note(taskId, text, {
      news: true,
      data: { speed: { ...selection, model } },
    });
    if (selection.reason && !selection.confirmed)
      this.core.options.broadcastEvent({
        type: "firstmate_note",
        taskId,
        text: `${task.title}: ${text}`,
      });
  }

  private applyEvent(task: TaskRuntime, event: FmEvent): void {
    switch (event.type) {
      case "assistant_delta": {
        task.currentTurnText += event.text;
        task.answeredAt = this.core.now();
        break;
      }
      case "turn_failed": {
        // Held on the runtime until the prompt resolves; turnComplete turns
        // it into the failure report instead of "(no report)".
        task.failedAt = this.core.now();
        task.lastTurnError = event.error;
        task.lastTurnCutOff = event.cutOff;
        task.lastTurnContextOverflow = event.contextOverflow;
        break;
      }
      case "tool_start": {
        task.answeredAt = this.core.now();
        task.openCalls.set(event.callId, { tool: event.toolName, since: this.core.now() });
        break;
      }
      case "tool_end": {
        task.openCalls.delete(event.callId);
        if (event.usage) this.core.turns.recordUsage(task, event.usage);
        break;
      }
      case "turn_end": {
        // Only a turn's FINAL message can be its report (WI-1): each turn
        // end overwrites the candidate with the text it streamed, and the
        // session's own closing words for it (turn_closed, `follow`) then
        // stand in its place.
        task.turnReport = task.currentTurnText.trim() ? task.currentTurnText : undefined;
        task.currentTurnText = "";
        if (event.usage) this.core.turns.recordUsage(task, event.usage);
        break;
      }
      default:
        break;
    }
  }

  /**
   * The crewmate's read-only `tasks` query (cards/tasks/agents P0, WI-4):
   * the same query the Firstmate and supervision read, so a crewmate can
   * search the backlog before filing a follow-up.
   */
  private queryTasks(input: TaskQueryInput): Promise<{ rows: TaskQueryRow[]; total: number }> {
    return queryTasksAsync(
      this.core.options.tasks,
      input,
      (repoId) => this.core.options.repos.get(repoId)?.name,
      (taskId) => servedNewestBody(this.core.cards, taskId),
      (taskId) => servedResolutionForTask(this.core.cards, taskId),
      this.taskQueryReach(),
    );
  }

  /**
   * What the `tasks` query names beyond the record (INF-1217): a project's
   * folder, which is always on the computer where the first mate lives, and
   * the computer a task's crewmate ran on with its evidence folder there,
   * so a crewmate names a folder instead of searching the disk for it.
   */
  taskQueryReach(): TaskQueryReach {
    return {
      select: this.core.options.taskSelection,
      timeline: this.core.options.taskTimeline,
      pendingResponses: (taskId) => this.core.options.inbox.pendingResponses(taskId),
      projectFolder: (repoId) => this.core.options.repos.get(repoId)?.path,
      sessionFolderOf: (record) => ({
        dir: crewmateSessionsDir(this.core.options.paths, record.id),
        computer: HOME.the,
        device: LOCAL_MACHINE_ID,
      }),
      placeOf: (record) => {
        if (record.status === "open") return undefined;
        const machine = record.deviceId ?? LOCAL_MACHINE_ID;
        if (machine === LOCAL_MACHINE_ID) {
          return {
            computer: HOME.the,
            evidence_folder: crewmateEvidenceDir(this.core.options.paths, record.id),
          };
        }
        const machines = this.core.options.machines;
        const evidence = machines?.folders(machine, record.id)?.evidence;
        const place = machines?.placeOf(machine);
        const computer = place?.where.startsWith("as ")
          ? `${place.who}, another user on ${HOME.the}`
          : (machines?.nameOf(machine) ?? `another ${COMPUTER.one}`);
        return { computer, ...(evidence ? { evidence_folder: evidence } : {}) };
      },
    };
  }
}

/** The lane rows an order names; none for one this Mac did not mint from rows. */
function laneRowsOf(order: string | undefined): number[] {
  if (!order?.startsWith("rows:")) return [];
  return (order.slice("rows:".length).split(":")[0] ?? "")
    .split(",")
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0);
}

/** The session events that are also feed events: everything but owner-only session facts. */
function isBroadcastEvent(event: SessionEvent): event is FmEvent {
  return (
    event.type !== "context_compacted" &&
    event.type !== "background_work_changed" &&
    event.type !== "turn_closed" &&
    event.type !== "request_started" &&
    event.type !== "continuation_started" &&
    event.type !== "continuation_ended" &&
    event.type !== "input_read" &&
    event.type !== "model_served" &&
    event.type !== "tool_observation"
  );
}

/** Name the crewmate and task on its turn_failed before it reaches the feed. */
function enrichEvent(task: TaskRuntime, event: FmEvent): FmEvent {
  if (event.type !== "turn_failed") return event;
  return { ...event, crewmate: task.crewmate, title: task.title };
}
