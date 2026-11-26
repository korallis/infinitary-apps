/**
 * The crew supervisor's test harness: a real CrewSupervisor over an
 * in-memory database, fake crewmate sessions and a mocked workspace (or a
 * real one over real git, on request), with the helpers its tests share.
 * Each test file that drives a supervisor imports what it needs from here.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KnowledgeService } from "@core/knowledge/knowledgeService";
import { type CrewmateSpec, crewmateSessionSpec } from "@core/orchestrator/crewSession";
import { CrewSupervisor } from "@core/orchestrator/crewSupervisor";
import type {
  AccountAttachment,
  CrewSupervisorOptions,
  FirstmateHooks,
} from "@core/orchestrator/crewSupervisorOptions";
import { QUEUED_GUIDANCE_LINE } from "@core/orchestrator/crewTurns";
import type { AccountServeability } from "@core/orchestrator/idleLadder";
import type { SpawnIntent } from "@core/orchestrator/intentBrief";
import { renderWake, type WakeBody, type WakeFacts } from "@core/orchestrator/wakes";
import { type AppPaths, appPathsFor } from "@core/paths";
import { PI_CONTROL_PROFILE } from "@core/pi/controlProfile";
import type { AutomaticPlacement } from "@core/placed/automaticPlacement";
import type { CrewMachines } from "@core/placed/crewMachines";
import type { QuotaService } from "@core/quota/quotaService";
import { Router } from "@core/routing/router";
import { Runbooks } from "@core/runbooks/runbooks";
import type { ModelSession, SessionSpec } from "@core/session/session";
import { CardStore } from "@core/storage/cardStore";
import type { AppDatabase } from "@core/storage/db";
import { DecisionStore } from "@core/storage/decisionStore";
import { FIRSTMATE_RECIPIENT, InboxStore } from "@core/storage/inboxStore";
import { SettingsStore } from "@core/storage/settingsStore";
import { SETTLE_FOLD } from "@core/tasks/taskFeed";
import { TaskService } from "@core/tasks/taskService";
import { RepoRegistry } from "@core/workspace/repoRegistry";
import {
  WorkspaceService as RealWorkspaceService,
  type WorkspaceService,
} from "@core/workspace/workspaceService";
import {
  CARD_ANSWER_TEXT_MAX,
  CARD_ANSWERS_MAX_BYTES,
  type Card,
  type CardThread,
  cardAnswersBytes,
} from "@shared/cards";
import type { CheckChangeInput } from "@shared/checkRepair";
import type { FmEvent } from "@shared/events";
import type { KeptValidationInput } from "@shared/liveValidation";
import type { Slot } from "@shared/modelSlots";
import type { RequiredAction } from "@shared/requiredActions";
import type { RiskDeclaration } from "@shared/risk";
import type { WorkShape } from "@shared/routingPolicy";
import { signInPlace } from "@shared/signIns";
import { afterEach, beforeEach, type Mock, vi } from "vitest";
import { completionCardBody } from "./completionCard";
import { freshDatabase as openInMemoryDatabase } from "./database";
import { type FakeSession, type FakeSessionOptions, fakeBinding, fakeSession } from "./fakeSession";
import { orderPolicyOnlyRoute, preparePolicyOnlyRoute } from "./policyOnlyRouting";
import { scratchDir } from "./scratchDirs";

/** Schema-valid answers whose JSON exceeds the footer bound. One value cannot, so this is several. */
export function answersPastBound(): { name: string; values: string[]; changed: boolean }[] {
  const answers = Array.from({ length: 5 }, (_, index) => ({
    name: `notes-${index}`,
    values: ["x".repeat(CARD_ANSWER_TEXT_MAX)],
    changed: true,
  }));
  if (cardAnswersBytes(answers) <= CARD_ANSWERS_MAX_BYTES) {
    throw new Error("the bound fixture no longer exceeds the answers bound");
  }
  return answers;
}

/**
 * The shared fake session (`tests/helpers/fakeSession.ts`) as this file
 * drives a crewmate: the texts it was prompted with, its steer and dispose
 * spied, and each prompt ended by the case - an abort only asks, as a
 * backend's does, and the case ends the turn the way that backend would.
 */
export type FakeCrewmate = FakeSession & {
  promptCalls: string[];
  promptImageCalls: (Parameters<ModelSession["prompt"]>[1] | undefined)[];
  finishPrompt: () => void;
  failPrompt: (message: string) => void;
  steer: Mock<ModelSession["steer"]>;
  dispose: Mock<ModelSession["dispose"]>;
};

/**
 * A crewmate on a backend that cannot take guidance mid-turn: its
 * profile says `followup-queue`, and its steer() rejects, so a supervisor
 * that called it would fail this test rather than quietly lose the message.
 */
export function fakeQueuedSteerCrewmate(): FakeCrewmate {
  const crewmate = fakeCrewmate();
  return {
    ...crewmate,
    controlProfile: {
      steer: "followup-queue",
      interruptGranularity: "process",
      quotaEvents: false,
      backgroundWork: "host",
      failureSignals: "text",
    },
    steer: vi.fn(async () => {
      throw new Error("this crewmate cannot be steered mid-turn");
    }),
  };
}

export function fakeCrewmate(options: FakeSessionOptions = {}): FakeCrewmate {
  const session = fakeSession({
    sessionId: "s1",
    controlProfile: PI_CONTROL_PROFILE,
    resume: { backend: "pi", sessionFile: "/tmp/s1.jsonl" },
    model: { provider: "fm-mock", id: "mock-1" },
    modelLabel: "Claude Fable 5",
    ...options,
  });
  const promptCalls: string[] = [];
  const promptImageCalls: (Parameters<ModelSession["prompt"]>[1] | undefined)[] = [];
  const { prompt, steer, dispose } = session;
  return Object.assign(session, {
    promptCalls,
    promptImageCalls,
    prompt: (text: string, images?: Parameters<ModelSession["prompt"]>[1]) => {
      promptCalls.push(text);
      promptImageCalls.push(images);
      return prompt(text, images);
    },
    abort: async (failure?: string) => {
      session.aborts.push(failure);
    },
    finishPrompt: () => session.settle(),
    failPrompt: (message: string) => session.rejectPrompt(message),
    steer: vi.fn(steer),
    dispose: vi.fn(dispose),
  });
}

/**
 * A supervisor's session options over fakes: one Pi factory whose `open`
 * the case supplies, bindings that carry the account, and the crewmate
 * preset, keeping every crewmate the host started (its callbacks are what a
 * case plays the crewmate's tool calls into). `alsoServes` names the other
 * backends the same fake opens for, which a case's `bind` then picks.
 */
export function crewSessions(
  paths: AppPaths,
  open: (spec: SessionSpec) => Promise<ModelSession>,
  specs: CrewmateSpec[] = [],
  alsoServes: readonly "claude"[] = [],
): Pick<CrewSupervisorOptions, "sessions" | "bind" | "sessionSpec"> {
  const others = Object.fromEntries(
    alsoServes.map((backend) => [backend, { backend, controlProfile: PI_CONTROL_PROFILE, open }]),
  );
  return {
    sessions: { pi: { backend: "pi", controlProfile: PI_CONTROL_PROFILE, open }, ...others },
    bind: async (accountId) => fakeBinding(accountId),
    sessionSpec: (crewmate, binding) => {
      specs.push(crewmate);
      return crewmateSessionSpec(paths, crewmate, binding);
    },
  };
}

/** What a reboot keeps: the database, folders and workspace, and each store handed over open. */
export type RebootOver = {
  paths: AppPaths;
  db: AppDatabase;
  workspace: WorkspaceService;
  repos?: RepoRegistry;
  tasks?: TaskService;
  cardStore?: CardStore;
  inbox?: InboxStore;
};

/**
 * The supervisor the app's next launch builds over what the last one left:
 * the same database, folders and workspace, each store `over` or `options`
 * hands over kept open, and every other store opened again over that
 * database in the order the app opens them - the projects, then the task
 * record (whose opening marks running work interrupted, as a launch does),
 * the cards and the inbox, the last two on `options.now` when it is given.
 * `open` and `specs` are the new launch's crewmate sessions
 * (`crewSessions`); every other option passes through as given.
 */
export function reboot(
  over: RebootOver,
  open: (spec: SessionSpec) => Promise<ModelSession>,
  options: Partial<CrewSupervisorOptions> & { specs?: CrewmateSpec[] } = {},
): CrewSupervisor {
  const { specs, ...given } = options;
  const now = given.now;
  return new CrewSupervisor({
    ...crewSessions(over.paths, open, specs),
    workspace: over.workspace,
    repos: given.repos ?? over.repos ?? new RepoRegistry(over.db, over.paths.fleetDir),
    tasks:
      given.tasks ??
      over.tasks ??
      new TaskService({ db: over.db, strict: true, ...(now ? { now } : {}) }),
    cardStore: given.cardStore ?? over.cardStore ?? new CardStore(over.db),
    inbox: given.inbox ?? over.inbox ?? new InboxStore(over.db, now ? { now } : undefined),
    paths: over.paths,
    broadcastEvent: () => {},
    broadcastCards: () => {},
    ...given,
  });
}

type RecordUsageInput = {
  taskId: string;
  accountId?: string;
  model?: { provider: string; id: string };
  usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: number;
  };
};

export type SetupExtras = {
  /** The integrations a task reaches (docs/integrations.md); absent, none. */
  integrations?: import("@core/orchestrator/crewSupervisorOptions").CrewSupervisorOptions["integrations"];
  realRouter?: (
    db: ReturnType<typeof openInMemoryDatabase>,
  ) => import("@core/routing/router").Router;
  accountlessServes?: () => boolean;
  /** The models the account-less runtime serves (a models.json provider's). */
  accountlessModels?: () => { provider: string; id: string }[];
  /**
   * Automatic placement's answers for a project set to Automatic, with the
   * computers that run work on the list (docs/helper.md,
   * "Automatic starts"); nothing asks those computers anything here.
   */
  automatic?: Pick<AutomaticPlacement, "choose">;
  reasoningChoice?: import("@core/routing/router").Router["reasoningChoice"];
  accounts?: AccountAttachment;
  /** Where the tasks still to move to another login are saved, over the harness's database. */
  loginMoveRecord?: (
    db: ReturnType<typeof openInMemoryDatabase>,
  ) => NonNullable<CrewSupervisorOptions["loginMoveRecord"]>;
  routedModel?: { provider: string; id: string };
  routeResult?: import("@core/routing/router").RouteResult;
  /**
   * The reviewer question as a review start reaches it (INF-5021): the
   * decision model's pick from the standing directions, answered here.
   */
  reviewerChooser?: import("@core/orchestrator/reviewerChoice").ReviewerChooser;
  /** The models placed where a review would run, as the stand-in router lists them for that question. */
  reviewerModels?: import("@core/orchestrator/reviewerChoice").ReviewerModelsReading["models"];
  /** Spies on every router.decide() call, to check what commission() passed it. */
  onRouteDecide?: (args: {
    taskId: string;
    prompt: string;
    shape: WorkShape;
    avoidProvider?: string;
  }) => void;
  recordUsage?: (input: RecordUsageInput) => void;
  /** The cost limits, read off the harness's own database (docs/usage.md, "The cost limit"). */
  costLimits?: (
    db: ReturnType<typeof openInMemoryDatabase>,
  ) => import("@core/orchestrator/costLimits").CostLimitFacts;
  /**
   * What the router evaluates for a move (INF-849): the model it would pick
   * for the shape with `withoutProvider` left out. Absent, nothing serves.
   */
  movePick?: (
    shape: WorkShape,
    options: { withoutProvider?: string; pool?: import("@core/routing/router").RoutingPool },
  ) => { provider: string; id: string } | undefined;
  noteCutOff?: (accountId: string, cutOff: import("@shared/authFailure").CutOff) => void;
  /** A model's Settings name (`ModelSlots.nameOf`). */
  modelName?: (model: { provider: string; id: string }) => string;
  serveability?: AccountServeability;
  quotaGateCleared?: (ref: string) => boolean;
  quotaGateRefValid?: (ref: string) => boolean;
  hasRunningJobs?: (taskId: string) => boolean;
  oldestRunningJob?: (
    taskId: string,
  ) => { jobId: string; command: string; startedAt: number } | undefined;
  killJobs?: (taskId: string) => void;
  /** The close's sweep of what a task left running (docs/leftover-programs.md). */
  leftovers?: CrewSupervisorOptions["leftovers"];
  /** The runner that times each part of a task's close (docs/freeze-recorder.md). */
  step?: CrewSupervisorOptions["step"];
  mergePullRequest?: CrewSupervisorOptions["mergePullRequest"];
  mergeReview?: CrewSupervisorOptions["mergeReview"];
  reviewGate?: CrewSupervisorOptions["reviewGate"];
  readPull?: CrewSupervisorOptions["readPull"];
  mergedStory?: CrewSupervisorOptions["mergedStory"];
  openChange?: (
    taskId: string,
    input: import("@shared/changePresentation").OpenChangeInput,
  ) => Promise<string>;
  completionPresentation?: CrewSupervisorOptions["completionPresentation"];
  prepareChange?: CrewSupervisorOptions["prepareChange"];
  /** show_merge_card's walk to the card (INF-3717 piece 2); served with prepareChange. */
  mergeCardSteps?: CrewSupervisorOptions["mergeCardSteps"];
  validateLocalStory?: CrewSupervisorOptions["validateLocalStory"];
  checkChange?: (taskId: string, input?: CheckChangeInput) => Promise<string>;
  readWorkflow?: CrewSupervisorOptions["readWorkflow"];
  downloadArtifact?: CrewSupervisorOptions["downloadArtifact"];
  closePullRequest?: (taskId: string) => Promise<{ ok: boolean; text: string }>;
  githubRead?: CrewSupervisorOptions["githubRead"];
  webRead?: CrewSupervisorOptions["webRead"];
  githubWrite?: CrewSupervisorOptions["githubWrite"];
  sendTakenIntegrationAsk?: CrewSupervisorOptions["sendTakenIntegrationAsk"];
  /** The captain's click on a crewmate's kept write sends it once (`GithubGatewayService.sendAsk`). */
  sendWriteAsk?: CrewSupervisorOptions["sendWriteAsk"];
  /** The home's personal instructions switch and the version of its set (docs/personal-resources.md). */
  personal?: {
    enabled: () => boolean;
    version: () => import("@shared/personalSet").PersonalVersion;
  };
  /** Where the captain's input comes from (docs/devices.md, "Where the captain is"). */
  captainPlaces?: CrewSupervisorOptions["captainPlaces"];
  /** A panel's held call was answered: the panel hears the choice (`HomeIntegrations`). */
  panelAskAnswered?: CrewSupervisorOptions["panelAskAnswered"];
  checkCi?: CrewSupervisorOptions["checkCi"];
  /** The reader check on a crewmate's own card (docs/card-authoring.md, "The reader check"). */
  readerCheck?: CrewSupervisorOptions["readerCheck"];
  /** The bundled runbooks, when a test reads the guidance the task's facts select. */
  runbooks?: CrewSupervisorOptions["runbooks"];
  readCheckWatch?: CrewSupervisorOptions["readCheckWatch"];
  readMainChecks?: CrewSupervisorOptions["readMainChecks"];
  knowledge?: (repos: RepoRegistry) => KnowledgeService;
  /** The kind classifier (S3); absent keeps S2's every-shape-unclear behaviour. */
  classifier?: import("@core/routing/kindClassifier").KindClassifier;
  /**
   * Further crewmates, one per later spawn in order (delivery rigor phase
   * 2: a builder and its reviewer are two sessions). The first spawn still
   * gets `crewmate`; once these run out every spawn gets `crewmate` again.
   */
  crewmates?: FakeCrewmate[];
  /** A real workspace service over real git, in place of the mocked one. */
  realWorkspace?: boolean;
  /** Each task's own browser (docs/task-browser.md). */
  browsers?: CrewSupervisorOptions["browsers"];
  /** The task channel; a stand-in that grants a key path when the app has browsers. */
  taskCommands?: CrewSupervisorOptions["taskCommands"];
  /** The host's one clock (the ticker's), for the task record, the inbox and the supervisor. */
  now?: () => number;
  /** An account's binding; absent, every account binds to a Pi runtime. */
  bind?: CrewSupervisorOptions["bind"];
  /** The backends besides Pi the fake crewmate opens for (`crewSessions`). */
  alsoServes?: readonly "claude"[];
  /** Open cards a previous build saved, there before the supervisor starts. */
  savedCards?: Card[];
  /** The computers that run work for this one, as the crew reads them. */
  machines?: CrewMachines;
  /** Whether a computer takes no new work until it is updated (`Computers.takesNoWorkUntilUpdated`). */
  takesNoWorkUntilUpdated?: CrewSupervisorOptions["takesNoWorkUntilUpdated"];
  /** A task began waiting for a computer's update: its Update card returns. */
  recallUpdateCard?: CrewSupervisorOptions["recallUpdateCard"];
  /** The process a program's script runs in (docs/programs.md). */
  programProcess?: CrewSupervisorOptions["programProcess"];
  /** The one-question session a program's ask() reads its answer from. */
  answerJson?: CrewSupervisorOptions["answerJson"];
};

/**
 * Routing on, over a pool no allowance is read for: an install signed in
 * only to OpenRouter (INF-2523). The quota catalog holds no row for it, and
 * the slot record places every listed model at medium, as its fallback does
 * when nothing is placed. `capabilityFor` reads each model's def, as the
 * models' own runtimes would; `slotsFor` names the levels each model is
 * placed at instead; `spent` lists subscription models whose allowance the
 * catalog reads as used up.
 */
export function catalogLessRouter(
  db: ReturnType<typeof openInMemoryDatabase>,
  models: { provider: string; id: string }[],
  options: {
    capabilityFor?: import("@core/routing/capability").ModelCapabilityLookup;
    slotsFor?: (model: { provider: string; id: string }) => readonly Slot[];
    spent?: readonly { provider: string; id: string }[];
  } = {},
) {
  const { capabilityFor, slotsFor = () => ["medium"], spent = [] } = options;
  return new Router({
    ...(capabilityFor ? { capabilityFor } : {}),
    settings: new SettingsStore(db),
    decisions: new DecisionStore(db),
    quota: {
      latestModels: () => ({
        generatedAt: "now",
        models: spent.map((model) => ({ ...model, label: model.id, effectivePercentRemaining: 0 })),
      }),
      latest: () => undefined,
    } as unknown as QuotaService,
    availableModels: () => models,
    slots: {
      routable: (available: { provider: string; id: string }[]) => ({
        models: available.flatMap((model) => slotsFor(model).map((slot) => ({ ...model, slot }))),
        note: "no slotted or starter-map model is available; using every listed model",
      }),
      slotsOf: () => [],
      reasoningChoice: () => undefined,
      nameOf: () => undefined,
    } as unknown as import("@core/routing/modelSlots").ModelSlots,
  });
}

export function setup(crewmate: FakeCrewmate, extras: SetupExtras = {}) {
  const paths = appPathsFor(scratchDir("infinitary-crew-"));
  const events: FmEvent[] = [];
  const ops: string[] = [];
  const sorts: { taskId: string; verdict: "routine" | "captain"; rule: string }[] = [];
  /** The text each ledger row records, in order (what the replay scorer matches). */
  const ledger: string[] = [];
  /** The typed facts each ledger row carries beside that text (P6); undefined for a line. */
  const ledgerFacts: (WakeFacts | undefined)[] = [];
  let cards: Card[] = [];
  const threads: CardThread[] = [];
  const workspace = {
    createTaskWorktree: vi.fn(async (taskId: string) => ({
      taskId,
      cwd: join(paths.worktreesDir, taskId),
      branch: `fm/task-${taskId}`,
      repoDir: paths.defaultWorkspaceDir,
    })),
    // The branch a computer that runs work is sent, as the stand-in above names it.
    taskBranchName: vi.fn(async (taskId: string) => `fm/task-${taskId}`),
    removeTaskWorktree: vi.fn(async () => {}),
    // The real save-then-remove: nothing to save by default, then the
    // removal the assertions below watch.
    retireTaskWorktree: vi.fn(
      async (ws: import("@core/workspace/workspaceService").TaskWorkspace) => {
        await workspace.removeTaskWorktree(ws);
        return { outcome: "removed" as const, kept: null };
      },
    ),
    listWorktreeDirs: vi.fn(() => [] as string[]),
    workspaceAt: vi.fn(async () => null),
    removeEmptyWorktreeDir: vi.fn(async () => false),
    landTaskWork: vi.fn(async () => ({ mode: "fast-forward" as const })),
    taskWorkStatus: vi.fn(async () => ({ dirty: false, unlandedCommits: 0 })),
    ensureDefaultRepo: vi.fn(async () => paths.defaultWorkspaceDir),
    installDependencies: vi.fn(async () => ({ outcome: "skipped" as const })),
    listTaskBranches: vi.fn(async () => [] as { branch: string; taskId: string }[]),
    retireTaskBranch: vi.fn(async () => ({ outcome: "removed" as const })),
    branchHead: vi.fn(async () => null as string | null),
    reviewChangedFiles: vi.fn(async () => ["src/meter.ts", "tests/meter.test.ts"]),
    reviewChangeReading: vi.fn(async () => "a".repeat(64)),
    changeLines: vi.fn(
      async () => null as import("@core/workspace/workspaceService").ChangeLineCount | null,
    ),
  } as unknown as WorkspaceService;
  const realWorkspace = extras.realWorkspace ? new RealWorkspaceService(paths) : undefined;
  const specs: CrewmateSpec[] = [];
  const sessionSpecs: SessionSpec[] = [];
  const open = vi.fn(async (spec: SessionSpec): Promise<ModelSession> => {
    sessionSpecs.push(spec);
    if (sessionSpecs.length > 1 && extras.crewmates) {
      return extras.crewmates[sessionSpecs.length - 2] ?? crewmate;
    }
    return crewmate;
  });
  const db = openInMemoryDatabase();
  const clock = extras.now ? { now: extras.now } : {};
  const repos = new RepoRegistry(db, paths.fleetDir);
  const tasks = new TaskService({ db, repos, strict: true, ...clock });
  const cardStore = new CardStore(db);
  for (const card of extras.savedCards ?? []) cardStore.upsert(card);
  const inbox = new InboxStore(db, clock);
  /** Each task's newest routing choice, as the real router reads it off routing_decisions. */
  const routedChoices = new Map<
    string,
    { model: { provider: string; id: string }; slot: import("@shared/modelSlots").Slot }
  >();
  const routed = (taskId: string, result: import("@core/routing/router").RouteResult) => {
    if (result.choice)
      routedChoices.set(taskId, {
        model: result.choice,
        slot: result.servedBucket ?? result.bucket,
      });
    return result;
  };
  const router =
    extras.realRouter?.(db) ??
    (extras.routedModel || extras.routeResult
      ? {
          reasoningChoice: extras.reasoningChoice ?? (() => undefined),
          prepare: preparePolicyOnlyRoute,
          inOrder: orderPolicyOnlyRoute,
          decide: (
            taskId: string,
            prompt: string,
            shape: WorkShape,
            options?: { avoidProvider?: string },
          ) => {
            extras.onRouteDecide?.({ taskId, prompt, shape, ...options });
            return routed(
              taskId,
              extras.routeResult ?? {
                choice: extras.routedModel,
                bucket: "high" as const,
                rule: "R8" as const,
              },
            );
          },
          servedChoice: (taskId: string) => routedChoices.get(taskId),
          // A stand-in router has no levels: every model it routed stays held.
          holdsAtALevel: () => true,
          // A move's evaluation, never recorded until it is committed.
          preview: (
            _prompt: string,
            shape: WorkShape,
            options: {
              withoutProvider?: string;
              pool?: import("@core/routing/router").RoutingPool;
            },
          ) => {
            const choice = extras.movePick?.(shape, options);
            return {
              result: {
                bucket: "high" as const,
                rule: "R8" as const,
                ...(choice ? { choice } : {}),
              },
              reasons: [],
              preferenceRank: 0,
              requiresReasoningWait: false,
            };
          },
          commit: vi.fn(
            (taskId: string, preview: { result: import("@core/routing/router").RouteResult }) =>
              routed(taskId, preview.result),
          ),
          // The builder's served provider (R9): the routed model's, as the
          // real router reads it off routing_decisions.
          servedProvider: () => extras.routedModel?.provider,
          // The reviewer question's reading: the usual pick is the routed
          // model, and the placed models are the ones this setup names.
          reviewerModels: () => ({
            usual: {
              result: {
                bucket: "high" as const,
                rule: "R8" as const,
                ...(extras.routedModel ? { choice: extras.routedModel } : {}),
              },
            },
            models: extras.reviewerModels ?? [],
          }),
          // The settle card's crewmate fact: the real router falls back
          // to the raw id when the catalog holds no label.
          modelLabel: (ref: { provider: string; id: string }) => ref.id,
        }
      : undefined);
  const supervisor = new CrewSupervisor({
    ...clock,
    ...crewSessions(paths, open, specs, extras.alsoServes),
    ...(extras.bind ? { bind: extras.bind } : {}),
    workspace: realWorkspace ?? workspace,
    repos,
    tasks,
    cardStore,
    inbox,
    paths,
    ...(extras.knowledge ? { knowledge: extras.knowledge(repos) } : {}),
    ...(extras.reviewerChooser ? { reviewerChooser: extras.reviewerChooser } : {}),
    ...(router ? { router: router as unknown as import("@core/routing/router").Router } : {}),
    ...(extras.automatic
      ? {
          automaticPlacement: extras.automatic as AutomaticPlacement,
          // Automatic compares no computers of its own here; a crewmate's brief reads the list.
          machines: { computers: () => [] } as unknown as CrewMachines,
          // This Mac's routing, for a task that starts here once it no longer runs on Automatic.
          router: {
            ...router,
          } as unknown as import("@core/routing/router").Router,
        }
      : {}),
    ...(extras.accounts ? { accounts: extras.accounts } : {}),
    ...(extras.integrations ? { integrations: extras.integrations } : {}),
    ...(extras.accountlessServes ? { accountlessServes: extras.accountlessServes } : {}),
    ...(extras.accountlessModels ? { accountlessModels: extras.accountlessModels } : {}),
    ...(extras.machines ? { machines: extras.machines } : {}),
    ...(extras.personal
      ? {
          personalResourcesEnabled: extras.personal.enabled,
          personalVersion: async () =>
            (extras.personal as NonNullable<typeof extras.personal>).version(),
        }
      : {}),
    ...(extras.takesNoWorkUntilUpdated
      ? { takesNoWorkUntilUpdated: extras.takesNoWorkUntilUpdated }
      : {}),
    ...(extras.recallUpdateCard ? { recallUpdateCard: extras.recallUpdateCard } : {}),
    ...(extras.programProcess ? { programProcess: extras.programProcess } : {}),
    ...(extras.answerJson ? { answerJson: extras.answerJson } : {}),
    ...(extras.readerCheck ? { readerCheck: extras.readerCheck } : {}),
    ...(extras.recordUsage ? { recordUsage: extras.recordUsage } : {}),
    ...(extras.costLimits ? { costLimits: extras.costLimits(db) } : {}),
    ...(extras.loginMoveRecord ? { loginMoveRecord: extras.loginMoveRecord(db) } : {}),
    ...(extras.noteCutOff ? { noteCutOff: extras.noteCutOff } : {}),
    ...(extras.modelName ? { modelName: extras.modelName } : {}),
    ...(extras.serveability ? { serveability: extras.serveability } : {}),
    ...(extras.quotaGateCleared ? { quotaGateCleared: extras.quotaGateCleared } : {}),
    ...(extras.quotaGateRefValid ? { quotaGateRefValid: extras.quotaGateRefValid } : {}),
    ...(extras.hasRunningJobs ? { hasRunningJobs: extras.hasRunningJobs } : {}),
    ...(extras.oldestRunningJob ? { oldestRunningJob: extras.oldestRunningJob } : {}),
    ...(extras.killJobs ? { killJobs: extras.killJobs } : {}),
    ...(extras.leftovers ? { leftovers: extras.leftovers } : {}),
    ...(extras.step ? { step: extras.step } : {}),
    ...(extras.mergePullRequest ? { mergePullRequest: extras.mergePullRequest } : {}),
    ...(extras.mergeReview ? { mergeReview: extras.mergeReview } : {}),
    ...(extras.reviewGate ? { reviewGate: extras.reviewGate } : {}),
    ...(extras.closePullRequest ? { closePullRequest: extras.closePullRequest } : {}),
    ...(extras.readPull ? { readPull: extras.readPull } : {}),
    ...(extras.mergedStory ? { mergedStory: extras.mergedStory } : {}),
    ...(extras.githubRead ? { githubRead: extras.githubRead } : {}),
    ...(extras.webRead ? { webRead: extras.webRead } : {}),
    ...(extras.githubWrite ? { githubWrite: extras.githubWrite } : {}),
    ...(extras.sendTakenIntegrationAsk
      ? { sendTakenIntegrationAsk: extras.sendTakenIntegrationAsk }
      : {}),
    ...(extras.sendWriteAsk ? { sendWriteAsk: extras.sendWriteAsk } : {}),
    ...(extras.captainPlaces ? { captainPlaces: extras.captainPlaces } : {}),
    ...(extras.panelAskAnswered ? { panelAskAnswered: extras.panelAskAnswered } : {}),
    ...(extras.checkCi ? { checkCi: extras.checkCi } : {}),
    ...(extras.runbooks ? { runbooks: extras.runbooks } : {}),
    ...(extras.openChange ? { openChange: extras.openChange } : {}),
    ...(extras.completionPresentation
      ? { completionPresentation: extras.completionPresentation }
      : {}),
    ...(extras.prepareChange ? { prepareChange: extras.prepareChange } : {}),
    ...(extras.mergeCardSteps ? { mergeCardSteps: extras.mergeCardSteps } : {}),
    ...(extras.validateLocalStory ? { validateLocalStory: extras.validateLocalStory } : {}),
    ...(extras.checkChange ? { checkChange: extras.checkChange } : {}),
    ...(extras.readWorkflow ? { readWorkflow: extras.readWorkflow } : {}),
    ...(extras.downloadArtifact ? { downloadArtifact: extras.downloadArtifact } : {}),
    ...(extras.readCheckWatch ? { readCheckWatch: extras.readCheckWatch } : {}),
    ...(extras.readMainChecks ? { readMainChecks: extras.readMainChecks } : {}),
    ...(extras.classifier ? { classifier: extras.classifier } : {}),
    ...(extras.browsers ? { browsers: extras.browsers } : {}),
    ...(extras.browsers
      ? {
          taskCommands: extras.taskCommands ?? {
            grant: (taskId: string) => ({
              env: { INFINITARY_AXI_KEY: `/channel/${taskId}.key` },
              path: ["/app/axi-bin"],
            }),
          },
        }
      : {}),
    // The whose-turn sort's record (S7c), wired exactly as services.ts
    // does: the row, then the wake inside the same call.
    recordSort: (input) => {
      sorts.push({ taskId: input.taskId, verdict: input.verdict, rule: input.rule });
      ledger.push(input.wake);
      ledgerFacts.push(input.facts);
      input.effect?.();
    },
    broadcastEvent: (event: FmEvent) => events.push(event),
    broadcastCards: (snapshot: Card[]) => {
      cards = snapshot;
    },
    broadcastThread: (thread) => threads.push(thread),
  });
  const hooks: FirstmateHooks = {
    notifyOp: (wake) => ops.push(served(wake)),
    notifyCaptainChoice: (wake) => ops.push(served(wake)),
    retryConverse: vi.fn(),
  };
  supervisor.setFirstmateHooks(hooks);
  return {
    supervisor,
    events,
    ops,
    sorts,
    ledger,
    ledgerFacts,
    cards: () => cards,
    threads,
    sessions: { open },
    workspace,
    realWorkspace,
    tasks,
    cardStore,
    inbox,
    // Named through its alias, so the type check can write out this return type.
    db: db as AppDatabase,
    specs,
    sessionSpecs,
    paths,
    repos,
    router,
  };
}

let servedLane: InboxStore | undefined;

/**
 * What the Firstmate's drain serves for a wake: the envelope the inbox
 * stores, read back and rendered where it is served (docs/inbox.md, "The
 * wake envelope"). The hooks below collect this, so every assertion on a
 * wake's text is an assertion on the served text.
 */
export function served(wake: WakeBody): string {
  servedLane ??= new InboxStore(openInMemoryDatabase());
  const id = servedLane.enqueue(FIRSTMATE_RECIPIENT, wake, undefined, "agent");
  const row = servedLane.allFor(FIRSTMATE_RECIPIENT).find((entry) => entry.id === id);
  servedLane.ack([id]);
  if (!row) throw new Error("the wake was not recorded");
  return renderWake(row);
}

/**
 * Run the same deadline assertions without wall-clock sleeps. Date and
 * timeouts are controlled; real I/O, microtasks and intervals are untouched.
 * A test file calls this once at its top level; a case that needs real
 * scheduling switches back to real timers itself and then waits on facts
 * with `vi.waitFor`, since `tick` refuses the real clock.
 */
export function fakeCrewTimersEachTest(): void {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    if (vi.isFakeTimers()) vi.clearAllTimers();
    vi.useRealTimers();
  });
}

/**
 * Lets the supervisor's work settle by moving the fake clock 80 ms: its
 * timers fire and its promise chains run between them. It never waits on
 * the real clock (docs/test-cohorts.md), so it refuses to run on real
 * timers: a file that ticks fakes them with `fakeCrewTimersEachTest`, and a
 * case on real timers waits on the fact it needs with `vi.waitFor`.
 */
export const tick = async (): Promise<void> => {
  if (!vi.isFakeTimers()) {
    throw new Error(
      "tick() moves the fake clock and never waits on the real one: call fakeCrewTimersEachTest() in this file, or wait on the fact with vi.waitFor.",
    );
  }
  await vi.advanceTimersByTimeAsync(80);
};

export async function reportTurn(crewmate: FakeCrewmate, taskId: string, text: string) {
  crewmate.emit({ type: "assistant_delta", taskId, text });
  crewmate.emit({ type: "turn_end", taskId });
  crewmate.finishPrompt();
  await tick();
}

export async function endTurn(
  crewmate: FakeCrewmate,
  taskId: string,
  text?: string,
): Promise<void> {
  if (text) crewmate.emit({ type: "assistant_delta", taskId, text });
  crewmate.emit({ type: "turn_end", taskId });
  crewmate.finishPrompt();
  await tick();
}

/**
 * The reviewer's typed review record for the head and evidence revision
 * assigned to its review (INF-1875): the verdict is this record, never a
 * line of the report. Its live-proof judgment defaults to the no-surface
 * one this lifecycle fixture's empty branch gets (`noSurfaceProof`).
 */
export function typedReview(
  tasks: TaskService,
  reviewId: string,
  input: Partial<Omit<Extract<KeptValidationInput, { kind: "review" }>, "kind">> & {
    code: "clear" | "findings" | "blocked";
  },
): Extract<KeptValidationInput, { kind: "review" }> {
  const review = tasks.get(reviewId);
  const head = review?.delivery?.headSha;
  const assignment = review?.delivery?.validationAssignment;
  if (!head || !assignment) throw new Error("the review has no assigned head");
  return {
    kind: "review",
    head,
    revision: assignment.revision,
    coverage: "complete",
    coverageReason: "No running surface exists in this lifecycle fixture.",
    effects: [],
    omitted: [],
    verdict: "no-surface",
    reason: "The reviewer accepts the empty branch's no-surface reason, not a live pass.",
    ...input,
  };
}

/** One reviewer turn: its typed review on the report tool, then the report text ending the turn. */
export async function reviewTurn(
  env: { tasks: TaskService; specs: CrewmateSpec[] },
  reviewer: FakeCrewmate,
  spec: number,
  reviewId: string,
  text: string,
  input: Parameters<typeof typedReview>[2],
) {
  await env.specs[spec]!.onReport!(text, undefined, {
    validation: typedReview(env.tasks, reviewId, input),
  });
  await reportTurn(reviewer, reviewId, text);
}

/**
 * The id of the captain's newest line under a card: what an answer names in
 * answers_message, since only a line naming it ends their question (the
 * captain's "Only a line that says it answers it; a handoff stays open").
 */
export function askedOn(supervisor: Pick<CrewSupervisor, "cards">, cardId: string) {
  return supervisor.cards.thread(cardId).messages.findLast((line) => line.who === "captain")?.id;
}

export const METER_RISK: RiskDeclaration = {
  blast: { level: "low", why: "Two files in the meter" },
  behavior: { level: "low", why: "Corrects the unit" },
  undo: { level: "low", why: "A revert restores the old meter" },
  evidence: { level: "medium", why: "The meter test" },
  sensitivity: { level: "low", why: "No sign-in, data or release code" },
  novelty: { level: "low", why: "Edits the existing reading" },
  deps: { level: "low", why: "Nothing added" },
};

export const METER_ACTION: RequiredAction = {
  id: "reconnect-meter",
  target: "the meter",
  title: "Reconnect the meter after the update",
  consequence: "Until then the meter shows no new readings.",
  instructions: ["Open Settings and press Reconnect beside the meter."],
  criterion: "The meter shows a reading newer than the update.",
  prerequisites: [],
  completion: { kind: "manual", label: "I reconnected it" },
};

/** The settle effects a card action carries (cards/tasks/agents P1): the host resolves merge by posture. */
export const SETTLE_MERGE = { kind: "merge", after: "close" } as const;
export const SETTLE_DISCARD = { kind: "settle", mode: "discard" } as const;

/** The lifecycle fixtures need a valid completion outline, not a content recipe. */
export const completionBody = (after: string) =>
  completionCardBody(
    "<p>The captain asked for this code change.</p>",
    "<p>The requested change is complete.</p>",
    "<p>The requested behavior was missing.</p>",
    after,
  );

export const settleWakes = (ops: string[]) =>
  ops.filter((line) => line.includes("the host settled it"));

/** A task's settle lines, oldest first: the click and its outcome on the task's record (INF-1845). */
export function settleLines(tasks: TaskService, taskId: string): string[] {
  return tasks
    .timeline(taskId)
    .filter((event) => event.kind === "note" && event.data?.feedOnce === SETTLE_FOLD)
    .map((event) => event.text);
}

/**
 * spawn v2 carries a structured intent instead of an authored brief; tests
 * that only need "some work text" put it in both goal and user words - the
 * host-rendered template then contains it, so content assertions hold.
 */
export function queuedGuidanceLines(tasks: TaskService, taskId: string) {
  return tasks.timeline(taskId).filter((event) => event.text === QUEUED_GUIDANCE_LINE);
}

export function intentOf(text: string): SpawnIntent {
  return { goal: text, userWords: text };
}

/** The card file a brief names for a source task (FI3-700), read back the way the crewmate opens it. */
export function handedCard(brief: string): { file: string; body: string } {
  const file = /open it to read the card:\n- (.+)/.exec(brief)?.[1];
  if (!file) throw new Error(`the brief names no card file:\n${brief}`);
  return { file, body: readFileSync(file, "utf8") };
}

/**
 * onCard's return can be a promise now that a merge decision on a
 * direct-pr task may clear a live CI gate first (`CrewmateCards.pendingCiGate`), but
 * none of these fixtures wire `checkCi`, so every call here stays the
 * synchronous string it always was. Fails loudly instead of silently
 * comparing a Promise if that assumption ever stops holding.
 */
export function syncCardId(
  id: string | { cardId: string } | Promise<unknown> | undefined,
): string | undefined {
  if (id instanceof Promise) {
    throw new Error("expected a synchronous card id in this fixture; got a pending CI gate");
  }
  // A write on someone else's card answers its typed result, which names the card.
  return typeof id === "object" ? id.cardId : id;
}

/** The bundled runbooks, read as the app serves them, with every switch on. */
export const bundledRunbooks = () =>
  new Runbooks(join(dirname(fileURLToPath(import.meta.url)), "../../resources/runbooks"), {
    getRunbookStates: () => ({}),
    setRunbookStates: () => {},
  });

/**
 * One computer that runs work, as the crew reads it: named, in reach unless
 * `ready` says otherwise, serving no account of its own, and answering
 * whatever else a case names in `fields`.
 */
export function workComputer(
  id: string,
  name: string,
  fields: Partial<Record<keyof CrewMachines, unknown>> = {},
): CrewMachines {
  return {
    computers: () => [id],
    ready: () => true,
    nameOf: () => name,
    placeOf: () => signInPlace({ name, onThisMac: false }),
    accountOf: () => undefined,
    ...fields,
  } as unknown as CrewMachines;
}
