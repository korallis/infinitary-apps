import { customHomeDefinition } from "@shared/customApiFile";
import { askedFromAView, askingViewHas } from "./askedFromAView";
import type { CoreServices } from "./coreServices";
import { ownComputerName } from "./devices/computerName";
import { type CoreDispatch, createCoreDispatcher } from "./dispatcher";
import { CoreEventBus } from "./events";
import type { HomeHandOver } from "./homeMove/outgoing";
import { movePending } from "./homeMove/outgoing";
import { askSignInsAgainAt, homeMoveStaging, outgoingHomeMove } from "./homeMove/wiring";
import type { HostCapabilities } from "./host";
import { OwnWindow } from "./ownWindow";
import type { AppPaths } from "./paths";
import { appPanelGatesOf, appPanelsFor, watchAppPanels } from "./personal/appPanelsServed";
import { followCustomApiFile } from "./pi/customApiFileSource";
import { createServices } from "./services";
import { SIGN_IN_RETURN, SIGN_IN_RETURN_WORDS, SignInReturns } from "./signInReturns";
import { type Standbys, standbyCopies } from "./standby/wiring";
import { recordStartAtLogin } from "./storage/startAtLoginRecord";

/**
 * The application core, entire (daemon study D1,
 * data/fm3000-daemon-process-study-s1 section 4.5).
 *
 * One function starts everything the product does, and hands back the two
 * seams a client needs: `dispatch` for requests and `events` for pushes.
 * `src/core/` imports no Electron - the fence in biome.json is what keeps
 * that true - so this whole tree runs, and is testable, in plain Node. The
 * Electron app is simply its first client (src/main/app.ts).
 */
export type Core = {
  readonly services: CoreServices;
  readonly paths: AppPaths;
  /** Push channels out; subscribe one sink per attached client. */
  readonly events: CoreEventBus;
  /** Request channels in; validates and answers every core-surface channel. */
  readonly dispatch: CoreDispatch;
  /**
   * Stops every timer, session, and child process the core owns. Resolves
   * once the crewmates it cut mid-turn have settled, within a bound.
   */
  dispose: () => Promise<void>;
};

export type CoreOptions = {
  /**
   * The first mate moved to another computer (docs/devices.md, "Moving the
   * first mate"): this computer opens as a window of the new home with the
   * grant handed over. Null when the move failed after the first mate
   * stopped: it starts again here, whole. Absent, the core takes no move.
   */
  onHomeMoved?: (handOver: HomeHandOver | null) => void;
  /**
   * The app was started by a command, with no window (docs/run.md): nobody
   * sits at this computer to see a page it opens, so every page it would
   * open in a browser goes to each computer that controls it instead, as a
   * page a view's own request opens always does (`inf:app:open-page`).
   */
  startedByCommand?: boolean;
  /**
   * The language the computer itself asks for (docs/i18n.md, "The language
   * choice"): the core speaks the captain's saved choice over it from the
   * moment its settings open, before any boot work words a turn.
   */
  computerLanguage?: string;
  /**
   * Called once the saved data is accepted, before any service starts
   * (`createServices`): a command reads the stops asked of it from here, and
   * one already stopping throws, so the core starts nothing.
   */
  accepted?: () => void;
};

export async function startCore(given: HostCapabilities, options: CoreOptions = {}): Promise<Core> {
  const events = new CoreEventBus();
  const signInReturns = new SignInReturns();
  const elsewhere = () => options.startedByCommand === true || askedFromAView();
  // A first mate a command started has no desktop: it keeps the settings,
  // the records and the crew, and only this computer's window, opened
  // beside it in another program, touches the desktop (docs/run.md, "The
  // window opened beside it"). So its own Dock call does nothing, it posts
  // no notification, and a page's file picker is the window's to show.
  const ownWindow = options.startedByCommand
    ? new OwnWindow((asked) => events.emit("inf:own-window:ask", asked))
    : undefined;
  const host: HostCapabilities = {
    ...given,
    ...(ownWindow
      ? {
          presence: { ...given.presence, setShowInDock: () => {} },
          notifications: { ...given.notifications, supported: () => false },
          ...(given.browser
            ? {
                browser: {
                  ...given.browser,
                  // Nobody to show the picker to is the captain choosing nothing.
                  chooseFiles: async ({ multiple }) =>
                    ownWindow.open()
                      ? (await ownWindow.ask({ kind: "choose-files", multiple })).paths
                      : [],
                },
              }
            : {}),
        }
      : {}),
    openExternal: async (url) =>
      elsewhere() ? events.emit("inf:app:open-page", { url }) : given.openExternal(url),
    // A sign-in page whose browser comes back to this computer's loopback
    // address goes to the computers that control it with its port, so the
    // one the person is at catches the return and hands it here (docs/view.md,
    // "A sign-in that returns to the first mate's computer").
    openSignInPage: async (url, to) => {
      if (!elsewhere()) return given.openExternal(url);
      if (askedFromAView() && !askingViewHas(SIGN_IN_RETURN))
        throw new Error(SIGN_IN_RETURN_WORDS.updateHere);
      const id = signInReturns.open(to);
      to.ended.addEventListener("abort", () => events.emit("inf:app:sign-in-ended", { id }), {
        once: true,
      });
      events.emit("inf:app:sign-in-page", { url, id, port: to.port });
    },
  };
  // A home that stopped for a move and quit before its destination answered
  // keeps its first mate stopped and asks again (docs/devices.md, "The stop").
  const paused =
    options.onHomeMoved !== undefined && movePending(homeMoveStaging(host.app.userDataDir));
  const services = await createServices(host, events.emit, {
    ...(options.computerLanguage ? { computerLanguage: options.computerLanguage } : {}),
    ...(paused ? { paused } : {}),
    ...(options.accepted ? { accepted: options.accepted } : {}),
  });
  let standbys: Standbys | undefined;
  const homeMove = options.onHomeMoved
    ? outgoingHomeMove(services, host, events.emit, options.onHomeMoved, () => standbys?.dispose())
    : undefined;
  // The live copies on other computers follow a home that runs (docs/devices.md,
  // "Keeping a copy on another computer").
  if (homeMove && !paused)
    standbys = standbyCopies(
      services,
      events.emit,
      (sink) => events.subscribe(sink),
      homeMove,
      {
        ownName: () => ownComputerName({ packaged: host.app.packaged, env: process.env }),
        stepDown: (handOver) => {
          standbys?.dispose();
          options.onHomeMoved?.(handOver);
        },
      },
      host.secrets?.standbyLock,
    );
  if (paused) await homeMove?.resume();
  else askSignInsAgainAt(services, (sink) => events.subscribe(sink));
  // The connection file (docs/custom-api.md, "Connection file").
  const customApiFile = followCustomApiFile(services.settings, services.vault, () => {
    services.slots.reconcile();
    services.firstRun.reconcile();
    events.emit("inf:models:changed", { ok: true });
  });
  // Each computer that runs work follows the connections here it approved its own from
  // (docs/custom-api.md, "On other computers"); any change to them says the models changed.
  services.deviceSignIns.followCustomDefinitions(() =>
    services.vault.customViews().flatMap((view) => {
      const definition = view.accountId
        ? customHomeDefinition(view, customApiFile.view())
        : undefined;
      return view.accountId && definition ? [{ name: view.accountId, definition }] : [];
    }),
  );
  const stopSendingCustom = events.subscribe((channel) => {
    if (channel === "inf:models:changed") services.deviceSignIns.sendCustomDefinitions();
  });
  const dispatch = createCoreDispatcher({
    services,
    host,
    signInReturns,
    customApiFile,
    ...(homeMove ? { homeMove } : {}),
    ...(standbys ? { standbys } : {}),
    ...(ownWindow ? { ownWindow } : {}),
    emit: events.emit,
    onActionRecorded: (id, action, value) =>
      services.firstmate.appActionRecorded(id, action, value),
  });
  services.firstmate.bindAppDispatch(dispatch);
  const stopAppPanels = watchAppPanels({
    subscribe: (sink) => events.subscribe(sink),
    keptJobs: (listener) => services.keptRunning.onChange(listener),
    emit: events.emit,
    read: () => appPanelsFor(appPanelGatesOf(services), host.frameLib?.pins, host.app.version),
  });
  // What the system starts at login, remembered in the folder for an app
  // that later moves it in (storage/startAtLoginRecord.ts).
  // A first mate a command started hears it from its window, when one opens.
  if (!ownWindow) recordStartAtLogin(services.paths.userData, host.presence.getStartAtLogin());
  services.projectSetups.bindDispatch(dispatch);
  services.projectChanges.bindDispatch(dispatch);
  // Each project's address is read against git in the background, so a
  // folder or a git that does not answer never keeps the door shut: a run
  // opens its door only once this returns (INF-4622).
  if (!paused) void services.projectChanges.inspectAll().catch(() => {});
  // Each project is looked at once for files of the team queue the app once
  // shipped, in the background.
  if (!paused) void services.teamQueueLeft.lookAll().catch(() => {});
  // Each project's folder is read once against where the project lives, in
  // the background, so the window opens as fast as before (INF-572).
  if (!paused) void services.supervisor.inPlaceWork.checkFoldersAtStart();
  return {
    services,
    paths: services.paths,
    events,
    dispatch,
    dispose: () => {
      // The health log dates the quit and the sign-in on file first, so a
      // sign-in that dies while the app is closed is bracketed (docs/forge.md).
      services.forges.recordApp("quit");
      standbys?.dispose();
      stopAppPanels();
      services.jobs.disposeAll();
      services.ticker.stop();
      services.corrections?.stop();
      services.tagging?.stop();
      services.stopWorkPresentation();
      services.scheduler.stop();
      // An attach still in flight would make the first mate's folders after the quit.
      const firstmate = services.firstmate.dispose();
      const crew = services.supervisor.disposeAll();
      const placedCopies = services.placed.stopCopies();
      // Every task browser goes with the app, its site data with it, and
      // the task channel with its keys.
      services.browsers?.closeAll();
      services.taskCommands?.close();
      // Every MCP server program the app started stops with it.
      void services.integrations.dispose();
      services.taskProtocol.dispose();
      services.quota.stop();
      const usageSent = services.stopLivenessSweep();
      services.personal.dispose();
      // The query process holds a read snapshot while it runs: stop it.
      services.sql.dispose();
      const records = services.recordReader.dispose();
      stopSendingCustom();
      services.deviceSignIns.dispose();
      services.automaticPlacement.dispose();
      services.loadLine.dispose();
      services.computerLoads.dispose();
      services.computerResourceFeed.dispose();
      services.computerResources.dispose();
      services.devices.dispose();
      services.nearbyMacs.dispose();
      services.homeAnnouncement.dispose();
      services.phoneDoor?.close();
      services.privacyWatch?.dispose();
      services.freezeRecorder?.stop();
      // A clean quit is not a crash, however early it comes (Step 5).
      services.launchWatch.dispose();
      // Stop the Diagnostics retry and let an event already on the wire finish.
      void services.sharing.close(1_000);
      customApiFile.close();
      // A custom connection's catalog fetch stops, so no late write puts its store back.
      const catalog = services.vault.closeCustomCatalog();
      return Promise.all([firstmate, crew, placedCopies, records, catalog, usageSent]).then(
        () => undefined,
      );
    },
  };
}

export type { CoreServices } from "./coreServices";
export type { CoreDispatch } from "./dispatcher";
export type { CoreEventSink } from "./events";
export type {
  HostCapabilities,
  HostChildProcess,
  HostChildSpawner,
  HostKeychain,
  HostKeychainOutcome,
} from "./host";
