import type { AppCostLimitView, CostLimit } from "@shared/costLimit";
import type { DeviceChip, DeviceInvite, DeviceInviteRequest, DeviceSystem } from "@shared/devices";
import type { FmEvent } from "@shared/events";
import type { ForgeChangesView } from "@shared/forges";
import type { ProviderView } from "@shared/providers";
import type { SavedResetResult } from "@shared/savedResets";
import type {
  UsageQuery,
  UsageReporting,
  UsageSummary,
  UsageTaskCosts,
  UsageTaskCostsQuery,
  UsageTasks,
  UsageTasksQuery,
} from "@shared/usage";
import type {
  UsageConnectionSave,
  UsageConnectionSaved,
  UsageConnectionView,
} from "@shared/usageConnection";
import type { AxiChannel } from "./axi/channel";
import type { Batches } from "./batches/batches";
import type { HomeSource } from "./connection/connection";
import type { DecisionModels } from "./decisions/decisionModel";
import type { EventScreenOffer } from "./decisions/eventScreenOffer";
import type { startCorrections } from "./decisions/startCorrections";
import type { startTaskTagger } from "./decisions/taskTagger";
import type { HomeAnnouncement } from "./devices/announce";
import type { CaptainPlaces } from "./devices/captainPlaces";
import type { CardAdds } from "./devices/cardAdds";
import type { Computers } from "./devices/computers";
import type { DeviceSignIns } from "./devices/deviceSignIns";
import type { FarBuild } from "./devices/farBuilds";
import type { NearbyMacs } from "./devices/nearby";
import type { DevicePairing } from "./devices/pairing";
import type { PhoneDoor } from "./devices/phoneDoor";
import type { RemoteLogin } from "./devices/remoteLogin";
import type { ResetFarewells } from "./devices/resetFarewells";
import type { SshConnections } from "./devices/sshConnections";
import type { CardFileReads } from "./files/cardFileReads";
import type { FirstRunService } from "./firstRun";
import type { ForgeSignIns } from "./forge";
import type { FreezeRecorder } from "./freeze/freezeRecorder";
import type { Inbox, IntegrationsService, SavedOutsideData } from "./integrations";
import type { JobManager } from "./jobs/jobManager";
import type { KnowledgeService } from "./knowledge/knowledgeService";
import type { ServedModels } from "./models/servedModels";
import type { ObserveService } from "./observe/observeService";
import type { CardDrafts } from "./orchestrator/cardDrafts";
import type { CrewSupervisor } from "./orchestrator/crewSupervisor";
import type { FirstmateAgent } from "./orchestrator/firstmateAgent";
import type { Flagship } from "./orchestrator/flagship";
import type { LocalOrchestratorService } from "./orchestrator/localOrchestrator";
import type { Scheduler } from "./orchestrator/scheduler";
import type { TeamQueueLeft } from "./orchestrator/teamQueueLeft";
import type { Ticker } from "./orchestrator/ticker";
import type { AppPaths } from "./paths";
import type { PanelMountsHolder } from "./personal/panelMounts";
import type { PersonalExtensions } from "./personal/personalExtensions";
import type { LaunchWatch } from "./personal/safeMode";
import type { AccountVault } from "./pi/accountVault";
import type { AuthInteractionBridge, PiAuthService } from "./pi/piAuth";
import type { AutomaticPlacement } from "./placed/automaticPlacement";
import type { ComputerLoads } from "./placed/computerLoads";
import type { ComputerResourceFeed } from "./placed/computerResourceFeed";
import type { ComputerResources } from "./placed/computerResources";
import type { LoadLine } from "./placed/loadLine";
import type { HomeBrowsers } from "./placed/placedBrowsers";
import type { PlacedWork } from "./placed/placedWork";
import type { ShellGroups } from "./placed/shellGroups";
import type { WorkDevices } from "./placed/workDevices";
import type { MediatedFetch } from "./plugins/mediatedFetch";
import type { ShellPreferencesService } from "./preferences/shellPreferences";
import type { AppDataWatch } from "./privacy/appDataWatch";
import type { QuotaService } from "./quota/quotaService";
import type { ModelSlots } from "./routing/modelSlots";
import type { Runbooks } from "./runbooks/runbooks";
import type { SecretBrings } from "./secrets/bring";
import type { SecretsSettings } from "./secrets/settings";
import type { SharingService } from "./sharing/sharingService";
import type { SqlService } from "./sql/sqlService";
import type { SettledBeforeAct } from "./standby/settled";
import type { ActivityStore } from "./storage/activityStore";
import type { AppDatabase } from "./storage/db";
import type { SettingsStore } from "./storage/settingsStore";
import type { CrewLiveText } from "./tasks/crewTranscript";
import type { KeptRunning } from "./tasks/keptRunning";
import type { LeftoverPrograms } from "./tasks/leftoverPrograms";
import type { TaskProtocol } from "./tasks/taskProtocol";
import type { TaskService } from "./tasks/taskService";
import type { TaskTimeline } from "./tasks/taskTimeline";
import type { UpdateChecker } from "./update/updateChecker";
import type { WindowsInFront } from "./windowsInFront";
import type { ProjectChanges } from "./workspace/projectChanges";
import type { ProjectContributions } from "./workspace/projectContributions";
import type { ProjectSetups } from "./workspace/projectSetups";
import type { RepoRegistry } from "./workspace/repoRegistry";
import type { WorkspaceService } from "./workspace/workspaceService";

/**
 * The services the app wiring hands the shell (`createServices` in
 * src/core/services.ts): everything a client-facing dispatcher can reach.
 */
export type CoreServices = {
  runbooks: Runbooks;
  paths: AppPaths;
  /**
   * The record's one writer connection, for the copy on other computers
   * alone (docs/devices.md, "Keeping a copy on another computer"): it reads
   * the log this connection writes and folds it back. Every write goes
   * through the stores that own it.
   */
  recordDatabase: AppDatabase;
  /** A card's files for the captain, read a piece at a time for a window's Save (docs/card-authoring.md). */
  cardFiles: CardFileReads;
  /** Each open card's unsent draft, which every window follows (docs/card-authoring.md, "Unsent picks follow you"). */
  cardDrafts: CardDrafts;
  /** Where the captain's input comes from: the computer or phone whose window sent it (docs/devices.md). */
  captainPlaces: CaptainPlaces;
  /** The windows in programs of their own that say they are in front, which hold a phone's pushes (docs/phone-push.md). */
  windowsInFront: WindowsInFront;
  auth: PiAuthService;
  vault: AccountVault;
  flagship: Flagship;
  scheduler: Scheduler;
  /** The host's one clock and interval (P5); stopped at dispose. */
  ticker: Ticker;
  jobs: JobManager;
  /** Each crewmate shell's process group while its task is open (docs/axi-commands.md, "Never the crew's"). */
  shellGroups: ShellGroups;
  /** Provider rows across every registered backend, for the Subscriptions tab. */
  providerViews: () => ProviderView[];
  /** The pooled availability: vault accounts plus base-runtime customs. */
  availableModels: () => { provider: string; id: string }[];
  /**
   * The decision-model seam (S7): any module may ask it a typed, bounded
   * question, and Settings reads and writes its one row through it.
   */
  decisions: DecisionModels;
  /** The event screen's offer card, withdrawn once Settings turns the screen on (docs/automation.md, "Offering the screen"). */
  eventScreenOffer?: Pick<EventScreenOffer, "turnedOn">;
  /** The install's model-slot record behind Settings -> Subscriptions. */
  slots: ModelSlots;
  /** The runtime catalog reads (docs/model-lists.md); never awaited on a user path. */
  servedModels: ServedModels;
  /** Settles once the usage report's last send has ended, so its Secrets use ends recorded. */
  stopLivenessSweep: () => Promise<void>;
  /**
   * Stops the presentation pass with the core: a write that lands after the
   * quit, such as a background job's exit or a closed task's temporary-folder
   * sweep, runs none.
   */
  stopWorkPresentation: () => void;
  corrections?: ReturnType<typeof startCorrections>;
  /** Automatic tagging and Check existing tasks (docs/task-tags.md). */
  tagging?: ReturnType<typeof startTaskTagger>;
  supervisor: CrewSupervisor;
  /** The one task writer (task-system P0/P1); the record every surface reads. */
  tasks: TaskService;
  /**
   * The one reader of a task's durable entries (docs/task-record.md, "The
   * unified timeline"): task events, card evidence and threads, and its
   * crewmate's actions, read-only.
   */
  timeline: TaskTimeline;
  /** The task protocol's reads and emitter (P3): board, detail, projects, feed. */
  taskProtocol: TaskProtocol;
  firstmate: FirstmateAgent;
  /** The first launch: the gate on the stage and the once-only welcome (docs/first-launch.md). */
  firstRun: FirstRunService;
  /** The dev-only local seat (roadmap 1.7): boot, Settings reads and writes; refused packaged. */
  localOrchestrator: LocalOrchestratorService;
  observe: ObserveService;
  /** What each crewmate is writing in its running turn, for its Crewmate tab. */
  crewLive: CrewLiveText;
  /** Settings → Usage (docs/usage.md): the ledger summed by period, work, day, model and place, and its recent tasks. */
  usage: {
    summary: (query: UsageQuery) => UsageSummary;
    tasks: (query: UsageTasksQuery) => UsageTasks;
    taskCosts: (query: UsageTaskCostsQuery) => UsageTaskCosts;
    /** Settings → Usage's line naming where usage is reported (docs/usage-report.md). */
    reporting: () => Promise<UsageReporting>;
    /** The reporting connection the person adds in Settings → Intelligence (docs/usage-report.md). */
    connection: {
      view: () => UsageConnectionView;
      save: (input: UsageConnectionSave) => Promise<UsageConnectionSaved>;
      remove: () => Promise<UsageConnectionView>;
    };
  };
  /** Settings → Intelligence's cost limit row: the app's own limit and what it would have asked about (docs/usage.md). */
  costLimit: {
    view: () => AppCostLimitView;
    set: (limit: CostLimit) => AppCostLimitView;
  };
  /** The mediated fetch seam for plugin frames; serves no grant yet (D6). */
  pluginFetch: MediatedFetch;
  /** The `sql` read's engine: the query process over the published views. */
  sql: SqlService;
  recordReader: import("./recordReads/recordReader").RecordReader;
  /** Personal extensions (talk-to-personalize Step 2): the seeded workspace, compiled and served. */
  personal: PersonalExtensions;
  /** What the window did with each panel, as it last said (`inf:plugins:personal:mounts`). */
  panelMounts: PanelMountsHolder;
  /**
   * Each task's own browser (docs/task-browser.md): this Mac's, and a task's
   * on another computer as the captain reads and drives it from here.
   * Absent on a host with none.
   */
  browsers?: HomeBrowsers;
  /** The task channel its crewmate's commands reach it by (docs/axi-commands.md); absent with no browser. */
  taskCommands?: AxiChannel;
  /** The launch marker safe mode reads (Step 5); a clean quit settles it. */
  launchWatch: LaunchWatch;
  repos: RepoRegistry;
  /** The setup card: the Firstmate's proposal and the captain's click on it (docs/fleet.md). */
  projectSetups: ProjectSetups;
  projectContributions: ProjectContributions;
  projectChanges: ProjectChanges;
  /** The one look, per project, for files of the team queue the app once shipped. */
  teamQueueLeft: TeamQueueLeft;
  /** The captain's own batches of approved changes, one line and one open batch per project. */
  batches: Batches;
  /** Worktree pool and background trash cleanup (also awaited by core integration tests). */
  workspace: WorkspaceService;
  /**
   * The app's own sign-ins where projects live (git integration PR 1.2):
   * optional, one per host, read by the forge and the app's git helper.
   */
  forges: ForgeSignIns;
  /** Integrations (docs/integrations.md): the one writer over userData/integrations/. */
  integrations: IntegrationsService;
  /** The inbox integration's door, key and receipts (docs/integrations.md, "The inbox"). */
  integrationInbox: Inbox;
  /** Trusted Secrets controls; only its closed command facade reaches a crewmate. */
  secrets: SecretsSettings;
  /** Bringing secrets from another tool: Infinitary's own card and the window's Bring (docs/secrets.md). */
  secretBrings: SecretBrings;
  /** Words from outside in saved conversations: their sweep and the captain's delete. */
  savedOutsideData: SavedOutsideData;
  /**
   * Pairing (docs/devices.md): the one writer over userData/devices, and the
   * connection's pairing seam. Nothing is on disk until the first link.
   */
  devices: DevicePairing;
  /**
   * The wait before a merge, a push, a secret use or a computer's kept
   * events, which the copies on other computers follow while they run
   * (docs/devices.md, "Before an act that cannot be undone").
   */
  settledBeforeAct: SettledBeforeAct;
  /**
   * Your devices as Settings -> Devices lists them, and Remove for a
   * computer that runs work, which brings its unmerged work here first
   * (src/core/devices/computers.ts).
   */
  computers: Computers;
  /**
   * Makes a link for a device, wrapped in the command for one when asked
   * (docs/devices.md, "Joining by a command"): for this Mac's own window.
   */
  inviteDevice: (request: DeviceInviteRequest) => Promise<DeviceInvite>;
  /**
   * The app a command on another Mac gets from this one, or null when this
   * copy cannot send itself (docs/devices.md, "Getting Infinitary from this Mac").
   */
  appBundle: () => string | null;
  /**
   * The Firstmate a computer that names its system and chip gets from this
   * one (docs/devices.md, "Infinitary for another system"), or its Ubuntu
   * package when it asks for that (`deb`), or null when there is none to send.
   */
  farBuild: (
    system: DeviceSystem | undefined,
    chip: DeviceChip | undefined,
    kind?: "deb",
  ) => Promise<FarBuild | null>;
  /**
   * The committed source a computer matched to this run from source gets
   * from it (docs/devices.md, "Matching the home's build"); null when this
   * run is not one `pnpm dev`'s starter started.
   */
  homeSource: () => HomeSource | null;
  /**
   * Adding a Mac by its address over Remote Login, and updating Firstmate
   * there (docs/devices.md, "Adding a computer by its address"): the captain's
   * own click in Settings -> Devices runs each.
   */
  remoteLogin: RemoteLogin;
  /**
   * The adds the first mate's card began (docs/devices.md, "Asking the first
   * mate"): the card's click starts one, and the first mate hears its end once.
   */
  cardAdds: CardAdds;
  /**
   * Macs nearby with Remote Login on, listed while "By its address" is open
   * (docs/devices.md, "Macs nearby"): Settings -> Devices asks, and it stops
   * a minute after the last ask.
   */
  nearbyMacs: NearbyMacs;
  /** This computer's Bonjour announcement to a phone on its list; stopped at dispose. */
  homeAnnouncement: HomeAnnouncement;
  /** The door a phone signed in over SSH asks for a link at; closed at dispose. */
  phoneDoor?: PhoneDoor;
  /**
   * The privacy watch on macOS (docs/macos-privacy.md): each "data from
   * other apps" question a crewmate's search raises, on its task's
   * timeline; null where there is no privacy log to read.
   */
  privacyWatch: AppDataWatch | null;
  /** The freeze recorder (docs/freeze-recorder.md); null outside an alpha build. Stopped at dispose. */
  freezeRecorder: FreezeRecorder | null;
  /**
   * This Mac's own SSH connection to each computer it added by its address
   * (docs/devices.md, "Through the home's SSH"): the shell starts it once it
   * attached the paired connection, and stops it before it closes that
   * connection.
   */
  sshConnections: SshConnections;
  /** The computers a reset could not tell they were removed (docs/reset.md, "Computers out of reach"). */
  resetFarewells: ResetFarewells;
  /**
   * The home's side of a crewmate's conversation held on a computer that
   * runs work (src/core/placed/placedSessions.ts): the work requests such a
   * computer asks, answered for the task its record names on it.
   */
  placed: PlacedWork & { stopCopies(): Promise<void> };
  /** The jobs kept running past their task's close, and each one's check and remove (docs/leftover-programs.md, "Kept running"). */
  keptRunning: KeptRunning;
  /** What closed tasks left running, stopped at each close; a reset waits for every sweep (docs/reset.md). */
  leftovers: Pick<LeftoverPrograms, "settled">;
  /**
   * The core's way to the computers that run work (src/core/placed/workDevices.ts):
   * the shell attaches the connection once it listens.
   */
  workDevices: WorkDevices;
  /** Demand-only resource facts; does not choose or move a task. */
  computerResources: ComputerResources;
  computerResourceFeed: ComputerResourceFeed;
  loadLine: LoadLine;
  computerLoads: ComputerLoads;
  automaticPlacement: AutomaticPlacement;
  /**
   * Each computer that runs work signing in to its own subscriptions, as
   * Settings -> Intelligence draws it (docs/helper.md, "Its own sign-ins").
   */
  deviceSignIns: DeviceSignIns;
  /** The person's open proposed changes where their projects live: the `forge.changes` read. */
  forgeChanges: () => Promise<ForgeChangesView>;
  forgeProjects: (host: string) => Promise<import("@shared/forges").ForgeProject[]>;
  forgeProjectsListed: (host: string) => Promise<import("@shared/forges").ForgeProjectListing>;
  /** The one event seam: feed, Observe, and the renderer. */
  broadcastEvent: (event: FmEvent) => void;
  /**
   * The captain's settled run whose line is Activity's newest, by id, or
   * null when the newest line is any other (docs/orchestrator-contract.md,
   * "Settled runs"): only that run's next step rewrites its line in place.
   */
  activityRun: () => string | null;
  quota: QuotaService;
  /**
   * An account's Keep going on credits switch (docs/quota.md): saved by the
   * vault, read at once by routing and the first mate, and a crew run-out
   * card offering it goes when it turns on. With `deviceId`, the account is
   * that computer that runs work's own, and its switch is saved there.
   */
  setKeepGoingOnCredits: (accountId: string, on: boolean, deviceId?: string) => Promise<void>;
  /**
   * Uses one of a Codex account's saved resets (docs/codex-client.md) and
   * says what it came to in the feed; with `deviceId` on that computer that
   * runs work. With a bridge, Codex may sign in to the account through it.
   */
  redeemSavedReset: (
    accountId: string,
    options: { deviceId?: string; bridge?: AuthInteractionBridge },
  ) => Promise<SavedResetResult>;
  /**
   * An account's Use saved resets on their own (docs/quota.md, "Saved
   * resets on their own"), saved where the account is: with `deviceId` on
   * that computer. Turning it on signs Codex in first when it must, through
   * the bridge; without one it is refused with words saying where.
   */
  setUseSavedResets: (
    accountId: string,
    on: boolean,
    options: { deviceId?: string; bridge?: AuthInteractionBridge },
  ) => Promise<void>;
  /** Whether Codex keeps a sign-in for this Mac's own account, so a use needs no browser. */
  codexSignedIn: (accountId: string) => boolean;
  settings: SettingsStore;
  /**
   * The Notifications switch changed (Settings -> General): a phone
   * withdrawal held while it was off goes (docs/phone-push.md, "Withdrawals").
   * Absent in a helper or test.
   */
  notificationsSwitched?: () => void;
  /** The one writer of the captain's presentation preferences; pushes every write. */
  preferences: ShellPreferencesService;
  /** The two switches (roadmap 1.4): the one writer of `sharing` and the gate on what leaves for us. */
  sharing: SharingService;
  activity: ActivityStore;
  /** Knowledge (docs/knowledge.md); present in every home, absent only in a helper or test. */
  knowledge?: KnowledgeService;
  updateChecker: UpdateChecker;
};
