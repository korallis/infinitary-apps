import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { deviceLabel, deviceRunsWork } from "@shared/devices";
import { HOME_MOVE_CHANGE } from "@shared/homeMove";
import { forgeSignInHost } from "@shared/integrations";
import { catalogEntry } from "@shared/providers";
import { RUNS_ON_THIS_MAC } from "@shared/repos";
import { defaultClaudeConfigDir } from "../claude/claudeQuota";
import type { CoreServices } from "../coreServices";
import { ownComputerName } from "../devices/computerName";
import type { CoreEventSink } from "../events";
import type { HostCapabilities } from "../host";
import { hostEnv } from "../hostEnv";
import { sealedFor } from "../standby/sealedSecrets";
import { readStandIns } from "../standIns";
import { type HomeHandOver, type LocalTask, OutgoingHomeMove } from "./outgoing";
import { HOME_MOVING } from "./record";
import { askSignInsAgain } from "./signInAgain";

/**
 * Stops everything the first mate does but its connection to its devices,
 * for the move's last copy (docs/devices.md, "Moving the first mate"): no
 * timer, turn, crewmate or program it started writes the record from here.
 * The rest goes with the process, which the move ends.
 */
async function quiesce(services: CoreServices, stopCopies: () => void): Promise<void> {
  // The copies on other computers stop following before the last copy.
  stopCopies();
  services.jobs.disposeAll();
  services.ticker.stop();
  services.corrections?.stop();
  services.stopWorkPresentation();
  services.scheduler.stop();
  const firstmate = services.firstmate.dispose();
  const crew = services.supervisor.disposeAll();
  const placedCopies = services.placed.stopCopies();
  services.browsers?.closeAll();
  services.taskCommands?.close();
  void services.integrations.dispose();
  services.taskProtocol.dispose();
  services.quota.stop();
  const usageSent = services.stopLivenessSweep();
  services.personal.dispose();
  services.sql.dispose();
  services.automaticPlacement.dispose();
  await Promise.all([firstmate, crew, placedCopies, services.recordReader.dispose(), usageSent]);
}

/**
 * The new home's asks for each sign-in the old home had (`askSignInsAgain`):
 * now, and again whenever the accounts or the hosts where projects live
 * change, so a card goes once its sign-in is here.
 */
export function askSignInsAgainAt(
  services: CoreServices,
  subscribe: (sink: CoreEventSink) => () => void,
): void {
  const cards = services.supervisor.cards.hostCards;
  const ask = () =>
    askSignInsAgain(
      services.paths.userData,
      {
        providers: () => services.vault.list().map((account) => account.providerId),
        forges: () =>
          services.forges
            .view()
            // Unknown or unavailable is not absent: only the host's own refusal asks again.
            .signIns.filter((signIn) => signIn.state !== "needs_reauth")
            .map((signIn) => signIn.host),
      },
      {
        ask: (id, signIn, from) => cards.addSignInAgainCard(id, signIn, from),
        clear: (id) => cards.clearAuthDecisionCard(id),
      },
    );
  ask();
  subscribe((channel) => {
    if (channel === "inf:quota" || channel === "inf:forges") ask();
  });
}

/** Where the old home keeps a move's files and its mark, inside its data folder. */
export function homeMoveStaging(userData: string): string {
  return join(userData, HOME_MOVING);
}

export function outgoingHomeMove(
  services: CoreServices,
  host: HostCapabilities,
  emit: CoreEventSink,
  onHomeMoved: (handOver: HomeHandOver | null) => void,
  stopCopies: () => void = () => {},
): OutgoingHomeMove {
  const userData = services.paths.userData;
  const ownName = () => ownComputerName({ packaged: host.app.packaged, env: process.env });
  const { homeMoveOfferMs } = readStandIns(host.app.packaged, process.env);
  return new OutgoingHomeMove({
    userData,
    ...(homeMoveOfferMs !== undefined ? { offerMs: homeMoveOfferMs } : {}),
    homeDir: homedir(),
    claudeDir: defaultClaudeConfigDir(hostEnv()),
    appVersion: host.app.version,
    ownName,
    computer: (deviceId) => {
      const device = services.computers.list().find((each) => each.id === deviceId);
      // Named as its row in Settings, Devices names it.
      return device
        ? { name: deviceLabel(device), runsWork: deviceRunsWork(device.kind) }
        : undefined;
    },
    ask: (deviceId, channel, args) => services.workDevices.ask(deviceId, channel, args),
    inReach: (deviceId) => services.workDevices.inReach(deviceId),
    speaksMove: (deviceId) =>
      services.workDevices.inReach(deviceId) &&
      (services.workDevices.version(deviceId)?.changes?.includes(HOME_MOVE_CHANGE) ?? false),
    homeNumber: () => services.devices.homeNumber(),
    raiseHomeNumber: (homeNumber) => services.devices.raiseHomeNumber(homeNumber),
    homeKey: () => services.devices.identity().pin,
    addMovedHome: (name) => services.devices.addMovedHome(name),
    removeMovedHome: (deviceId) => services.devices.removeMovedHome(deviceId),
    localTasks: async (to) => {
      const found: LocalTask[] = [];
      for (const record of services.tasks.listActive()) {
        if (services.supervisor.moves.computerOf(record) !== RUNS_ON_THIS_MAC) continue;
        const handle = `${record.key || record.id} "${record.title}"`;
        const move = record.shape?.computer_move;
        const moving = move
          ? {
              to: move.to,
              ...(move.problem ? { problem: `${handle} cannot move: ${move.problem}` } : {}),
            }
          : undefined;
        const options = await services.supervisor.moves.moveOptions(record.id);
        // Movable means movable to this computer: its own refusal shows before the click.
        const unavailable = options.ok
          ? (options.destinations.find((each) => each.id === to)?.unavailable ??
            (options.destinations.some((each) => each.id === to)
              ? undefined
              : "that computer cannot take it."))
          : undefined;
        found.push({
          id: record.id,
          handle,
          ...(moving ? { moving } : {}),
          ...(options.ok && !unavailable
            ? { movable: true }
            : {
                movable: false,
                refusal: options.ok ? `${handle} cannot move: ${unavailable}` : options.text,
              }),
        });
      }
      return found;
    },
    moveTask: (taskId, to) => services.supervisor.moves.requestComputerMove(taskId, to, "captain"),
    cancelTask: (taskId) => {
      services.supervisor.moves.cancelComputerMove(taskId, "captain");
    },
    projects: () => {
      const projects = services.repos
        .list()
        .filter((repo) => repo.kind !== "personal")
        .map((repo) => ({ id: repo.id, path: repo.path }));
      // The local-only repository of tasks with no project crosses like a project.
      const own = services.paths.defaultWorkspaceDir;
      if (existsSync(join(own, ".git")) && !projects.some((project) => project.path === own))
        projects.push({ id: "default-workspace", path: own });
      return projects;
    },
    providers: () => {
      const seen = new Map<string, string>();
      for (const account of services.vault.list())
        if (!seen.has(account.providerId))
          seen.set(account.providerId, catalogEntry(account.providerId)?.name ?? account.label);
      return [...seen].map(([id, name]) => ({ id, name: name.slice(0, 64) }));
    },
    forges: () =>
      services.forges.view().signIns.map((signIn) => ({ host: signIn.host, name: signIn.name })),
    sshComputers: () =>
      services.devices.sshConnections().map((each) => {
        const device = services.computers.list().find((one) => one.id === each.deviceId);
        return { id: each.deviceId, name: device ? deviceLabel(device) : each.address };
      }),
    secretsKept: () => {
      const dir = join(userData, "secrets");
      return existsSync(dir) && readdirSync(dir).length > 0;
    },
    secretsGoTo: (deviceId) => sealedFor(userData, deviceId),
    integrationsSignedIn: () =>
      services.integrations
        .view()
        .integrations.filter((integration) => integration.account !== null)
        .map((integration) => {
          const forgeHost = forgeSignInHost(integration);
          return { name: integration.name, ...(forgeHost ? { forgeHost } : {}) };
        }),
    dictationOn: () => services.settings.getDictation().enabled,
    quiesce: () => quiesce(services, stopCopies),
    hold: (why) => services.workDevices.hold(why),
    tellMoved: (moved) => services.workDevices.tellMoved(moved),
    onMoved: (handOver) => onHomeMoved(handOver),
    onStopped: () => onHomeMoved(null),
    emit: (progress) => emit("inf:home-move:progress", progress),
    stagingDir: homeMoveStaging(userData),
  });
}
