import { constants as cryptoConstants } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import { Server as NetServer, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import {
  channelIn,
  FIRST_SPELLING,
  OWN_SPELLING,
  ownChannel,
  readSpellings,
  SPELLINGS,
  type Spelling,
  spellingFor,
} from "@shared/codeNames";
import {
  type ClientFrame,
  COMMAND_PATH,
  CONNECTION_CLOSE,
  CONNECTION_MAX_FRAME_BYTES,
  CONNECTION_PATH,
  CONNECTION_PORT,
  clientFrameSchema,
  FETCH_APP_PATH,
  FETCH_APP_REFUSAL_STATUS,
  FETCH_APP_SHA256_HEADER,
  FETCH_APP_TYPES,
  FETCH_SOURCE_PATH,
  type FetchAppRefusal,
  fetchAppRequestSchema,
  invokeArgs,
  PAIR_BODY_MAX_BYTES,
  PAIR_PATH,
  PAIR_REFUSAL_STATUS,
  REPLACED_PUSH_CHANNEL,
} from "@shared/connection";
import {
  asksWhileReading,
  type ContractAccess,
  contractAccess,
  readsEndedCards,
  readsSeenUpdate,
  readsSharedCards,
  takesWork,
} from "@shared/contractFeatures";
import { COMPUTER, HOME } from "@shared/deviceNames";
import { type DeviceRole, deviceMayBe, deviceNameSchema } from "@shared/devices";
import { type FmEvent, isStreamedEvent } from "@shared/events";
import { HOME_MOVE_START_HERE, HOME_MOVED_LIVE } from "@shared/homeMove";
import {
  CORE_INVOKE_CHANNELS,
  type CoreInvokeChannel,
  invokeContract,
  isViewInvokeChannel,
  isWorkInvokeChannel,
  PROTOCOL_VERSION,
  VIEW_FLOOR,
} from "@shared/ipc";
import { HOME_GOODBYE_LIVE, HOME_ROUTES_LIVE } from "@shared/standby";
import type { TaskBrowserFrame } from "@shared/taskBrowser";
import { WebSocket, WebSocketServer } from "ws";
import type { BrowserViewer } from "../browser/browserViews";
import { copyStream, type FarBuild } from "../devices/farBuilds";
import { createKeyIdentity } from "../devices/identity";
import type { CoreActor } from "../dispatcher";
import { listenAddresses, listenOn } from "./addresses";
import {
  CARD_ANSWER_SKIPPED,
  CARD_ANSWERED_BY_CREWMATE,
  CARD_DRAFTS_CHANGE,
  CARD_LIVE_READS,
  CARD_NOTE_PLACES,
  type CardReads,
  cardPushFor,
  legacyCardSnapshot,
  lookFor,
  pastCardFor,
  THREAD_CHANNELS,
  threadLinesFor,
} from "./cardCompatibility";
import { type CatchUpWatch, describeCatchUp, watchCatchUp } from "./catchUpLog";
import type {
  ConnectionOptions,
  HomeConnection,
  PairedDevice,
  PairOutcome,
  RunningDeviceVersion,
  ViewDeviceContact,
  WorkDeviceContact,
  WorkDeviceVersion,
} from "./connectionTypes";
import { CONTRACT_CHANGES, listsChange } from "./contractChanges";
import { readsFrameParts } from "./frameParts";
import { heldAsks } from "./heldAsks";
import { answerSource } from "./homeSource";
import {
  DEFAULT_JOURNAL_LIMITS,
  EventJournal,
  type ReplayEntry,
  replacedFrame,
  replayBytes,
  replayOf,
} from "./journal";
import { type OpenLocalDoor, openLocalDoor } from "./localDoor";

/** The name on the local door's own certificate. */
const LOCAL_DOOR_NAME = "Infinitary local door";

import { Outbox } from "./outbox";
import {
  type ActionReads,
  readsAutoSavedResets,
  readsEventScreenOffer,
  readsKeepGoing,
  readsMoveLogin,
  readsSavedReset,
  readsSecretBring,
  readsSecretKeep,
  readsTaskAllow,
  withoutUnreadActions,
} from "./taskAllow";
import {
  COMPUTER_READINGS_LIVE,
  EVERY_VIEW_ASKS,
  STREAMED_EVENTS_LIVE,
  type Unnumbered,
  unnumberedFor,
  unreadLook,
  viewHas,
} from "./viewHello";

export type {
  ConnectionOptions,
  HomeConnection,
  PairedDevice,
  PairedDevices,
  PairOutcome,
  RunningDeviceVersion,
  ViewDeviceContact,
  WelcomedNow,
  WorkDeviceContact,
  WorkDeviceVersion,
} from "./connectionTypes";
export type { HomeSource } from "./homeSource";

/** The push the computers' readings ride (`COMPUTER_READINGS_LIVE`). */
const READINGS_CHANNEL = "inf:computers:resources";

/**
 * The push a card's draft rides (`CARD_DRAFTS_CHANGE`): a window reads every
 * draft again at each welcome, so a change it missed while dropped is never
 * replayed, and a stream of picks and words never pushes a dropped view's
 * place out of the journal.
 */
const DRAFTS_CHANNEL = "inf:cards:draft";

/**
 * Who a client the local door admitted is (docs/connection.md, "The local
 * door"): no device on the list, never told to pairing, always a view.
 */
export const LOCAL_CLIENT = "local";
const LOCAL_DEVICE: PairedDevice = { id: LOCAL_CLIENT, kind: "view" };

/**
 * What a connection in each role may ask (docs/devices.md): a view the
 * channels whose reach is `views`, as the captain at another Mac, naming the
 * device so a phone's own usage events go under its own ID; a computer's work
 * the channels whose reach is `work`, as itself, about a conversation it
 * holds for this home (src/shared/work.ts).
 */
function askerOf(
  device: PairedDevice,
  role: DeviceRole,
  channel: CoreInvokeChannel,
  changes: readonly string[] | undefined,
  version: string,
): CoreActor | null {
  // A client of the local door asks as the window on this computer always
  // has: everything but the work requests, as the captain himself.
  if (role === "view" && device === LOCAL_DEVICE)
    return isWorkInvokeChannel(channel) ? null : { kind: "captain" };
  if (role === "view")
    return isViewInvokeChannel(channel)
      ? {
          kind: "captain",
          view: device.id,
          viewVersion: version,
          ...(changes ? { viewChanges: changes } : {}),
        }
      : null;
  return isWorkInvokeChannel(channel) ? { kind: "device", deviceId: device.id } : null;
}

/**
 * A request the home could not put to a computer that runs work: it is not
 * connected, takes no work, or its connection went before it answered.
 * Nothing says whether it did the work, so the home asks again under the
 * same order id once it is back (src/shared/work.ts). A caller that knows
 * which computer it was names it (`deviceId`), so a start that lost it
 * waits for that computer (docs/helper.md, "Waiting").
 */
export class DeviceOutOfReachError extends Error {
  readonly deviceId: string | undefined;
  constructor(
    message = "That computer is out of reach, so nothing was sent.",
    options: { deviceId?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DeviceOutOfReachError";
    this.deviceId = options.deviceId;
  }
}

type Client = {
  readonly ws: WebSocket;
  readonly device: PairedDevice;
  /** Admitted by the local door's key, not by pairing: it outlives no pairing and is never one. */
  readonly local: boolean;
  welcomed: boolean;
  /** What this connection does, from its hello: null until it is welcomed. */
  role: DeviceRole | null;
  /** The contract version its hello spoke, and what the version rule lets it ask. */
  speaks: string;
  /** The spelling of channel names it is written in: its own, when its hello said it reads that one. */
  spelling: Spelling;
  /** The version of Firstmate its hello said it runs, when it said one. */
  appVersion: string | undefined;
  /** The contract changes its hello listed, when it listed any. */
  changes: readonly string[] | undefined;
  /** The look's later choices it does not read (`unreadLook`): every one, until its hello. */
  unreadLook: readonly string[];
  /** Older desktop card decoders are strict; only capable desktops receive the added fields. */
  cardReads: CardReads;
  /** Whether it reads a thread line's contributor fields (`SHARED_CARDS_SINCE`). */
  sharedCards: boolean;
  /** Which card buttons it reads: Allow for the rest of this task, Keep going on credits. */
  actionReads: ActionReads;
  /**
   * How it is sent streamed reply pieces and tool starts and ends
   * (`STREAMED_EVENTS_LIVE`): as `live` frames, under the newest number
   * for a view from before the change, or not at all, as a phone.
   */
  streamed: Unnumbered;
  /** How it is sent the computers' readings (`COMPUTER_READINGS_LIVE`), as `streamed` is. */
  readings: Unnumbered;
  /** How it is sent a card's draft (`CARD_DRAFTS_CHANGE`): live once its hello lists the change, else not at all. */
  drafts: Unnumbered;
  access: ContractAccess;
  closing: boolean;
  /** What the home writes to it, paced by its answers. */
  readonly out: Outbox;
  /** It answered a ping since the last heartbeat: a piece's or the heartbeat's own. */
  answeredPing: boolean;
  waitedForHello: boolean;
  /** For a computer that runs work: its welcome said it takes work, so the home may ask it. */
  takesWork: boolean;
  /**
   * A computer's join, dialing once only to hear the home's name: welcomed,
   * and nothing of it is that computer in reach, its version, or work.
   */
  nameOnly: boolean;
  /** A phone (its hello says `ios`): its welcome and `inf:home:routes` name each copy (`standby-phone`). */
  phone: boolean;
  /** Where its socket came from, read only for the route its catch-up names (`routeOf`). */
  readonly remote: string | undefined;
  /** A phone's catch-up while it goes (`CatchUpWatch`). */
  catchUp?: CatchUpWatch;
  /**
   * As a view, the one that watches a task's browser through it, made at its
   * first request: its pictures go out as `live` frames to it alone.
   */
  viewer?: BrowserViewer;
  /** Who hears it go: each watch it holds, ended when it closes. */
  gone: (() => void)[];
  /**
   * Per task it watches, whether a picture is still being written to it, and
   * the newest one that came meanwhile: only the newest goes next.
   */
  readonly pictures: Map<string, { next?: TaskBrowserFrame }>;
  /** What the home asked it and waits for, by request id. */
  readonly asked: Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >;
};

type Run = {
  /** The listeners devices dial, while anything is paired. */
  servers: NetServer[];
  /** The addresses it was asked to listen on, as asked; empty while nothing is paired. */
  chosen: string;
  addresses: string[];
  /** The local door's own listener and its key, for as long as the run lasts. */
  readonly local: { readonly server: NetServer; readonly door: OpenLocalDoor } | null;
  /** Listens on these addresses for devices, in place of those it listened on. */
  readonly listen: (listed: { key: string; addresses: string[] }) => Promise<void>;
  readonly clients: Set<Client>;
  readonly detach: () => void;
  readonly heartbeat: NodeJS.Timeout;
};

const CORE_CHANNELS = new Set<string>(CORE_INVOKE_CHANNELS);

/**
 * What a view reads first on a reload (docs/connection.md, "Catching up"):
 * the card list, Activity, the whole board, the last reply, the conversation's
 * state and the computers in reach. A computer's window reads more besides.
 */
const RELOAD_READS = [
  "inf:cards:list",
  "inf:feed:recent",
  "inf:tasks:board",
  "inf:conversation:last-turn",
  "inf:conversation:state",
  "inf:computers:presence",
] as const satisfies CoreInvokeChannel[];
const RELOAD_READ_SET: ReadonlySet<string> = new Set(RELOAD_READS);

/** The read of a reload whose answer a whole list's push is, as it would be read now. */
const WHOLE_LIST_READS: Partial<Record<string, (typeof RELOAD_READS)[number]>> = {
  "inf:cards": "inf:cards:list",
  "inf:tasks": "inf:tasks:board",
};

/** What each refusal at `FETCH_APP_PATH` says; none echoes the code. */
const FETCH_APP_REASONS: Record<FetchAppRefusal, string> = {
  malformed: "The request for Infinitary is not one this home reads.",
  unknown: "This home has no open link with that code.",
  kind: `This link is for the app on another ${COMPUTER.one}.`,
  used: "This link was used already.",
  expired: "This link has expired.",
  none: `This copy of Infinitary cannot send itself to another ${COMPUTER.one}.`,
};

/**
 * A request's body as text, read without iterating, so a body that grows
 * past the cap without a length (chunked) is answered 413 (null) rather
 * than reset; undefined when the request failed.
 */
function readBody(request: IncomingMessage): Promise<string | null | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      if (size > PAIR_BODY_MAX_BYTES) return;
      size += chunk.length;
      if (size > PAIR_BODY_MAX_BYTES) resolve(null);
      else chunks.push(chunk);
    });
    request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", () => resolve(undefined));
  });
}

/**
 * The home's side of the connection (docs/connection.md): the core's
 * requests and pushes served to paired devices over WebSocket. Like the
 * desktop adapter it names no channel - it forwards whatever the contract
 * lets a view ask to `dispatch`, as the captain, and numbers every push from
 * `events` once, so every device sees the same push under the same number.
 */
export function startConnection(options: ConnectionOptions): HomeConnection {
  const { dispatch, events, devices } = options;
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  const maxBufferedBytes = options.maxBufferedBytes ?? 32 * 1024 * 1024;
  // Half the limit goes ahead of an answer at most, leaving the other half
  // for the one order that waits in the outbox (`whenClear`) and pushes.
  const pacing = {
    pieceBytes: options.pieceBytes ?? 4 * 1024,
    aheadMs: options.aheadMs ?? 2_000,
    aheadBytes: Math.floor(maxBufferedBytes / 2),
  };
  const onProblem = options.onProblem ?? ((text) => console.warn(`[connection] ${text}`));
  const onCatchUp =
    options.onCatchUp ?? ((catchUp) => console.info(`[connection] ${describeCatchUp(catchUp)}`));
  const homeVersion = options.protocolVersion ?? PROTOCOL_VERSION;
  const viewFloor = options.viewFloor ?? VIEW_FLOOR;
  const homeChanges = options.changes ?? CONTRACT_CHANGES.names;
  const speaks = options.speaks ?? OWN_SPELLING;
  let run: Run | null = null;
  let closed = false;
  let tail = Promise.resolve();
  let nextAsk = 1;
  /** Why changes wait while the first mate moves to another computer; null otherwise. */
  let moving: string | null = null;
  const windowAsked = heldAsks<Client>();
  const workListeners = new Set<(contact: WorkDeviceContact) => void>();
  const sentListeners = new Set<(deviceId: string, bytes: number) => void>();
  const tellSent = (deviceId: string, bytes: number) => {
    for (const listener of [...sentListeners]) {
      try {
        listener(deviceId, bytes);
      } catch (error) {
        onProblem(`a send listener failed: ${(error as Error).message}`);
      }
    }
  };
  // What the listeners were told and still holds, for one that listens late (`welcomedNow`).
  const toldVersions = new Map<string, WorkDeviceVersion>();
  const toldWork = new Set<string>();
  const toldViews = new Set<string>();
  const versionListeners = new Set<(deviceId: string, version: WorkDeviceVersion | null) => void>();
  const tellVersion = (deviceId: string, version: WorkDeviceVersion | null) => {
    if (version) toldVersions.set(deviceId, version);
    else toldVersions.delete(deviceId);
    for (const listener of [...versionListeners]) {
      try {
        listener(deviceId, version);
      } catch (error) {
        onProblem(`a version listener failed: ${(error as Error).message}`);
      }
    }
  };
  const tellWork = (contact: WorkDeviceContact) => {
    if (contact.contact === "in-reach") toldWork.add(contact.deviceId);
    else toldWork.delete(contact.deviceId);
    for (const listener of [...workListeners]) {
      try {
        listener(contact);
      } catch (error) {
        onProblem(`a work listener failed: ${(error as Error).message}`);
      }
    }
  };
  const listeningListeners = new Set<(listening: string[]) => void>();
  const listeningNow = () => [...(run?.addresses ?? [])];
  const tellListening = () => {
    for (const listener of [...listeningListeners]) {
      try {
        listener(listeningNow());
      } catch (error) {
        onProblem(`a listening listener failed: ${(error as Error).message}`);
      }
    }
  };
  const viewListeners = new Set<(contact: ViewDeviceContact) => void>();
  const tellView = (contact: ViewDeviceContact) => {
    if (contact.contact === "in-reach") toldViews.add(contact.deviceId);
    else toldViews.delete(contact.deviceId);
    for (const listener of [...viewListeners]) {
      try {
        listener(contact);
      } catch (error) {
        onProblem(`a view listener failed: ${(error as Error).message}`);
      }
    }
  };
  /**
   * The newest welcomed connection of a computer that takes work, if any;
   * with `anyVersion`, of one that takes no work too.
   */
  const workClient = (deviceId: string, anyVersion = false): Client | undefined =>
    [...(run?.clients ?? [])]
      .reverse()
      .find(
        (client) =>
          client.device.id === deviceId &&
          client.role === "work" &&
          client.welcomed &&
          !client.nameOnly &&
          (client.takesWork || anyVersion) &&
          !client.closing,
      );
  const listenList = (): { key: string; addresses: string[] } => {
    const read = typeof options.address === "function" ? options.address() : options.address;
    const addresses = Array.isArray(read)
      ? listenOn(read)
      : listenAddresses(typeof read === "string" ? read : undefined);
    return { key: addresses.join(" "), addresses };
  };
  // A name the welcome could not carry is no name: every device parses it.
  const homeName = (): string | undefined => {
    try {
      const parsed = deviceNameSchema.safeParse(options.name?.());
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  };

  const local = options.localDoor;
  const follow = async () => {
    const paired = !closed && devices.any();
    // The local door keeps a run going while nothing is paired.
    if (closed || (!paired && !local)) {
      await stop(closed ? CONNECTION_CLOSE.closing : CONNECTION_CLOSE.unpaired);
      return;
    }
    let listed: { key: string; addresses: string[] } = { key: "", addresses: [] };
    if (paired) {
      try {
        listed = listenList();
      } catch (refusal) {
        onProblem(`not listening: ${(refusal as Error).message}`);
        if (!local) {
          if (run) await stop(CONNECTION_CLOSE.closing);
          return;
        }
      }
    }
    // A new key to show is a new listening run too (`identityTag`).
    if (paired) listed = { ...listed, key: `${listed.key}|${devices.identityTag?.() ?? ""}` };
    if (run && run.chosen !== listed.key) {
      // A new set of addresses is a new listening run: devices come back and
      // reload. With the local door, only the devices' listeners change.
      if (local) await run.listen(listed);
      else await stop(CONNECTION_CLOSE.closing);
    }
    if (!run) run = await start(listed);
    for (const client of run?.clients ?? [])
      if (!client.local && !devices.holds(client.device.id))
        cut(client, CONNECTION_CLOSE.unpaired, "unpaired");
  };
  const reconcile = () => {
    tail = tail
      .then(async () => {
        const was = listeningNow().join(" ");
        try {
          await follow();
        } finally {
          if (listeningNow().join(" ") !== was) tellListening();
        }
      })
      .catch((error) => onProblem(`stopped following pairing: ${(error as Error).message}`));
    return tail;
  };
  // A device whose pairing went is cut in the same call that removed it
  // (docs/devices.md, "Remove"); listening follows on the chain.
  const unsubscribe = devices.subscribe(() => {
    for (const client of run?.clients ?? [])
      if (!client.local && !devices.holds(client.device.id))
        cut(client, CONNECTION_CLOSE.unpaired, "unpaired");
    void reconcile();
  });
  void reconcile();

  async function start(listed: { key: string; addresses: string[] }): Promise<Run | null> {
    // The home's own key, read only once devices are listened for: pairing
    // writes nothing, not even that key, until the first link
    // (docs/devices.md). Without the local door it is read at once, as before.
    let homeIdentity: { key: string; cert: string } | null = null;
    const ownIdentity = () => {
      homeIdentity ??= devices.identity();
      return homeIdentity;
    };
    if (!local)
      try {
        ownIdentity();
      } catch (refusal) {
        onProblem(`not listening: ${(refusal as Error).message}`);
        return null;
      }
    let journal = new EventJournal(options.journal ?? DEFAULT_JOURNAL_LIMITS);
    // The bytes of the newest answer to each read a view's reload makes first.
    const reloadWeights = new Map<string, number>();
    const clients = new Set<Client>();
    const sockets = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      perMessageDeflate: false,
      maxPayload: CONNECTION_MAX_FRAME_BYTES,
    });
    const send = (client: Client, frame: string) => {
      if (client.closing || client.ws.readyState !== WebSocket.OPEN) return;
      if (behind(client)) {
        cut(client, CONNECTION_CLOSE.behind, "behind");
        return;
      }
      client.out.send(frame);
    };
    /** A frame of a phone's catch-up, counted toward it; then, once all is written, its answer. */
    const sendCatchUp = (client: Client, frame: string) => {
      client.catchUp?.sent(frame);
      send(client, frame);
    };
    const settleCatchUp = (client: Client) =>
      client.out.whenAnswered((answered) => client.catchUp?.end(answered));
    // What is happening in a turn now (`isStreamedEvent`), and the
    // computers' readings: outside the numbering, so a stream of them never
    // pushes a dropped view's place out of the journal, and only to the views
    // that read them.
    const sendUnnumbered = (
      channel: string,
      payload: unknown,
      how: (client: Client) => Unnumbered,
    ) => {
      for (const client of clients) {
        if (!client.welcomed || client.role !== "view") continue;
        const mode = how(client);
        if (mode === "none") continue;
        const spelled = channelIn(channel, client.spelling);
        if (mode === "live") {
          send(client, JSON.stringify({ t: "live", channel: spelled, payload }));
          continue;
        }
        // A view from before the change reads only numbered pushes: the newest
        // number again moves its cursor nowhere, so a replay still has no hole.
        if (journal.seq > 0)
          send(client, JSON.stringify({ t: "push", seq: journal.seq, channel: spelled, payload }));
      }
    };
    // Never throws into the core's emit. A push that cannot be written would
    // leave every device with a hole it cannot see, so they all start over.
    const detach = events.subscribe((channel, payload) => {
      const unnumbered =
        channel === "inf:event" && isStreamedEvent(payload as FmEvent)
          ? (client: Client) => client.streamed
          : channel === READINGS_CHANNEL
            ? (client: Client) => client.readings
            : channel === DRAFTS_CHANNEL
              ? (client: Client) => client.drafts
              : null;
      if (unnumbered) {
        try {
          sendUnnumbered(channel, payload, unnumbered);
        } catch (error) {
          onProblem(`could not send ${channel}: ${(error as Error).message}`);
        }
        return;
      }
      try {
        // Kept for catch-up only while something is paired: with nothing
        // paired only the local door's clients, on this computer, dial, and
        // one that dropped reads everything again (docs/connection.md).
        const entry = journal.record(
          (seq) => JSON.stringify({ t: "push", seq, channel, payload }),
          channel,
          devices.any(),
        );
        // A whole list pushed is what a reload would read of it now.
        const read = WHOLE_LIST_READS[channel];
        if (read) reloadWeights.set(read, Buffer.byteLength(entry.frame));
        for (const client of clients)
          if (client.welcomed && client.role === "view")
            send(
              client,
              cardPushFor(
                entry,
                client.spelling,
                client.cardReads,
                client.sharedCards,
                client.actionReads,
                client.unreadLook,
              ),
            );
      } catch (error) {
        onProblem(`could not send ${channel}: ${(error as Error).message}`);
        journal = new EventJournal(options.journal ?? DEFAULT_JOURNAL_LIMITS);
        for (const client of clients) cut(client, CONNECTION_CLOSE.behind, "behind");
      }
    });

    // A picture of a page a view watches (docs/connection.md, "Live
    // pushes"): to that connection alone, unnumbered and never kept. While
    // one is still being written, only the newest that comes meanwhile
    // follows, so a slow link shows the page as it is now, never a queue.
    const showLive = (client: Client, frame: TaskBrowserFrame) => {
      const writing = client.pictures.get(frame.taskId);
      if (writing) {
        writing.next = frame;
        return;
      }
      if (client.closing || client.ws.readyState !== WebSocket.OPEN) return;
      if (behind(client)) {
        cut(client, CONNECTION_CLOSE.behind, "behind");
        return;
      }
      const slot: { next?: TaskBrowserFrame } = {};
      client.pictures.set(frame.taskId, slot);
      const text = JSON.stringify({
        t: "live",
        channel: channelIn("inf:browser:frame", client.spelling),
        payload: frame,
      });
      client.out.send(text, () => {
        if (client.pictures.get(frame.taskId) !== slot) return;
        client.pictures.delete(frame.taskId);
        if (slot.next) showLive(client, slot.next);
      });
    };
    const viewerOf = (client: Client): BrowserViewer => {
      client.viewer ??= {
        show: (frame) => showLive(client, frame),
        onGone: (listener) => client.gone.push(listener),
      };
      return client.viewer;
    };

    const roleOf = (client: Client, hello: Extract<ClientFrame, { t: "hello" }>): DeviceRole =>
      // A Mac that does both runs its work unless it says it controls.
      hello.as ?? (client.device.kind === "view" ? "view" : "work");

    /**
     * What a view's replay would send, or null when its cursor cannot be
     * caught up: only a view is sent pushes, so only a view catches up on them.
     */
    const replayFor = (
      role: DeviceRole,
      hello: Extract<ClientFrame, { t: "hello" }>,
    ): ReplayEntry[] | null => {
      const missed = hello.cursor && role === "view" ? journal.since(hello.cursor) : null;
      return missed ? replayOf(missed) : null;
    };

    /**
     * What a view's reload would read first, weighed from the newest answer
     * to each this home wrote in this run, or the newest whole list it pushed
     * since; undefined while any of them has not been written, and a view
     * then replays (docs/connection.md, "Catching up").
     */
    const reloadBytes = (): number | undefined => {
      let total = 0;
      for (const channel of RELOAD_READS) {
        const bytes = reloadWeights.get(channel);
        if (bytes === undefined) return undefined;
        total += bytes;
      }
      return total;
    };

    const welcome = (client: Client, hello: Extract<ClientFrame, { t: "hello" }>) => {
      const helloAt = Date.now();
      const role = roleOf(client, hello);
      if (!deviceMayBe(client.device.kind, role)) {
        cut(client, CONNECTION_CLOSE.protocol, `a ${client.device.kind} device is never a ${role}`);
        return;
      }
      client.role = role;
      // A replay that would weigh more than what a reload reads first reloads instead.
      const replay = replayFor(role, hello);
      const reload = replay ? reloadBytes() : undefined;
      const missed =
        replay && (reload === undefined || replayBytes(replay) <= reload) ? replay : null;
      client.speaks = hello.protocolVersion;
      client.spelling = spellingFor(readSpellings(hello.spellings), speaks);
      client.appVersion = hello.appVersion;
      client.changes = hello.changes;
      client.unreadLook = unreadLook(hello);
      client.cardReads = {
        updates: hello.system === "ios" || readsSeenUpdate(hello.protocolVersion, hello.changes),
        ended: hello.system === "ios" || readsEndedCards(hello.protocolVersion, hello.changes),
        // A view that has typed notes draws them, a phone that lists them included; one without reads plain lines.
        annotations: viewHas(hello, "card-annotations"),
        // An older desktop reads a card strictly; a phone ignores the field and draws no Save.
        files: hello.system === "ios" || viewHas(hello, "card-files"),
        // A view without the command's mark, the phone included, gets the line without it.
        through: viewHas(hello, "from-the-command"),
        // An older desktop or phone reads answers strictly: a view gets the mark once its hello lists it.
        skipped: listsChange(hello.changes, CARD_ANSWER_SKIPPED),
        // A view that draws no place, the phone included, reads each such note as a line of words.
        places: listsChange(hello.changes, CARD_NOTE_PLACES),
        // An older desktop reads a card strictly; a phone ignores the lists until it answers them.
        liveReads: hello.system === "ios" || listsChange(hello.changes, CARD_LIVE_READS),
        // An older view reads who answers as a closed set, or draws a plain field beside a masked one.
        answeredByCrewmate: listsChange(hello.changes, CARD_ANSWERED_BY_CREWMATE),
      };
      client.sharedCards =
        hello.system === "ios" || readsSharedCards(hello.protocolVersion, hello.changes);
      client.actionReads = {
        taskAllow: readsTaskAllow(hello.protocolVersion, hello.changes),
        keepGoing: readsKeepGoing(hello.protocolVersion, hello.changes, hello.system),
        secretKeep: readsSecretKeep(hello.changes),
        eventScreen: readsEventScreenOffer(hello.changes, hello.system),
        secretBring: readsSecretBring(hello.changes),
        savedReset: readsSavedReset(hello.changes),
        autoSavedResets: readsAutoSavedResets(hello.changes),
        moveLogin: readsMoveLogin(hello.changes, hello.system),
      };
      client.streamed = unnumberedFor(hello, STREAMED_EVENTS_LIVE);
      client.readings = unnumberedFor(hello, COMPUTER_READINGS_LIVE);
      client.drafts = listsChange(hello.changes, CARD_DRAFTS_CHANGE) ? "live" : "none";
      // From the welcome on, a long frame goes as parts to a device that reads them.
      client.out.parts = readsFrameParts(hello.protocolVersion, hello.changes);
      // A view changes things across majors its floor allows; work only on this home's own.
      // A computer viewing from before the floor (its hello says none) reads closed lists
      // strictly, so like work it changes things only on this home's major (INF-1649 review
      // R4, the captain's "Keep version-11 views read-only"); a phone reads them as text.
      const floored = role === "view" && (hello.viewFloor !== undefined || hello.system === "ios");
      // A local client is this computer's own build at this computer's own
      // home (docs/connection.md, "The local door"): it changes things,
      // whatever version either says.
      client.access = client.local
        ? "full"
        : contractAccess(
            hello.protocolVersion,
            homeVersion,
            floored ? { clientFloor: hello.viewFloor, homeFloor: viewFloor } : undefined,
          );
      const takes = role === "work" && takesWork(hello.protocolVersion, homeVersion);
      // A join hearing the name is welcomed as any connection is, and is
      // nothing more: never that computer in reach, so Devices can tell one
      // whose work never reached this Mac since it joined (docs/devices.md).
      client.nameOnly = role === "work" && hello.nameOnly === true;
      client.takesWork = takes && !client.nameOnly;
      client.phone = role === "view" && hello.system === "ios";
      const name = homeName();
      const takeOverId = devices.takeOver?.() ?? null;
      if (client.phone)
        client.catchUp = watchCatchUp({
          lost: hello.cursor ? journal.lost(hello.cursor) : "no-place",
          replay,
          replaying: Boolean(missed),
          weight: replay ? reload : reloadBytes(),
          remote: client.remote,
          appVersion: hello.appVersion,
          helloAt,
          reads: RELOAD_READS,
          tell: onCatchUp,
        });
      sendCatchUp(
        client,
        JSON.stringify({
          t: "welcome",
          protocolVersion: homeVersion,
          epoch: journal.epoch,
          seq: journal.seq,
          catchUp: missed ? "replay" : "reload",
          access: client.access,
          ...(name ? { name } : {}),
          ...(devices.welcomeTargets
            ? { addresses: devices.welcomeTargets(true) }
            : devices.offerTargets
              ? { addresses: devices.offerTargets(true) }
              : {}),
          ...(devices.homeNumber ? { homeNumber: devices.homeNumber() } : {}),
          ...(takeOverId ? { takeOver: takeOverId } : {}),
          ...(client.phone && devices.phoneStandbys ? { standbys: devices.phoneStandbys() } : {}),
          // A computer that runs work takes new work only on this home's own
          // major (docs/helper.md); a view is never sent work.
          ...(role === "work" ? { takesWork: takes } : {}),
          // Where its work runs decides that work's priority there: the home
          // says what its list found, and the computer keeps it on its grant.
          ...(role === "work" && client.device.onThisMac !== undefined
            ? { onHomeMac: client.device.onThisMac }
            : {}),
          // A view from before one rule for every view still waits to hear this
          // before it asks the wider set.
          ...(role === "view" && !viewHas(hello, EVERY_VIEW_ASKS)
            ? { startedByCommand: true }
            : {}),
          spellings: SPELLINGS,
          ...(homeChanges.length ? { changes: homeChanges } : {}),
        }),
      );
      for (const { entry, replaced } of missed ?? [])
        sendCatchUp(
          client,
          replaced
            ? replacedFrame(entry.seq, channelIn(REPLACED_PUSH_CHANNEL, client.spelling))
            : cardPushFor(
                entry,
                client.spelling,
                client.cardReads,
                client.sharedCards,
                client.actionReads,
                client.unreadLook,
              ),
        );
      client.welcomed = true;
      if (client.catchUp && !client.catchUp.waiting) settleCatchUp(client);
      // A client of the local door is no device: pairing hears nothing of it.
      if (client.local) return;
      if (hello.system || hello.chip || hello.automaticStartup)
        devices.noteSystem?.(client.device.id, {
          ...(hello.system ? { system: hello.system } : {}),
          ...(hello.chip ? { chip: hello.chip } : {}),
          ...(hello.automaticStartup ? { automaticStartup: hello.automaticStartup } : {}),
        });
      if (role === "work" && !client.nameOnly)
        tellVersion(client.device.id, {
          contract: hello.protocolVersion,
          ...(hello.appVersion ? { app: hello.appVersion } : {}),
          takesWork: client.takesWork,
          ...(hello.changes?.length ? { changes: hello.changes } : {}),
          ...(hello.failedUpdate ? { failedUpdate: hello.failedUpdate } : {}),
          ...(hello.build ? { build: hello.build } : {}),
        });
      if (client.takesWork) tellWork({ deviceId: client.device.id, contact: "in-reach" });
      if (role === "view") tellView({ deviceId: client.device.id, contact: "in-reach" });
    };

    const answer = async (client: Client, asked: Extract<ClientFrame, { t: "invoke" }>) => {
      // Read in this home's own spelling, whichever the device wrote.
      const frame = { ...asked, channel: ownChannel(asked.channel) };
      const reply = (outcome: { ok: true; value: unknown } | { ok: false; error: string }) => {
        let text: string;
        try {
          text = JSON.stringify({ t: "result", id: frame.id, ...outcome });
        } catch {
          text = JSON.stringify({
            t: "result",
            id: frame.id,
            ok: false,
            error: `The answer to ${frame.channel} could not be sent.`,
          });
        }
        if (outcome.ok && RELOAD_READ_SET.has(frame.channel))
          reloadWeights.set(frame.channel, Buffer.byteLength(text));
        send(client, text);
        if (client.catchUp?.answered(frame.channel, text)) settleCatchUp(client);
      };
      if (!CORE_CHANNELS.has(frame.channel)) {
        reply({ ok: false, error: `${frame.channel} is not a request this home answers.` });
        return;
      }
      const channel = frame.channel as CoreInvokeChannel;
      const actor = client.role
        ? askerOf(client.device, client.role, channel, client.changes, client.speaks)
        : null;
      if (!actor) {
        reply({
          ok: false,
          error: isWorkInvokeChannel(channel)
            ? `${channel} is asked only by a computer that runs work.`
            : `${channel} is answered only on ${HOME.the}.`,
        });
        return;
      }
      // The first mate is moving to another computer (docs/devices.md,
      // "Moving the first mate"): work asked now is never answered here, so
      // the computer asks it again of the new home, which answers it once;
      // a change from a view is refused, and reads still answer. Start my
      // first mate here again passes: it is how the captain ends a move whose
      // destination never answers.
      if (moving) {
        if (actor.kind === "device") return;
        if (invokeContract[channel].effect === "change" && channel !== HOME_MOVE_START_HERE) {
          reply({ ok: false, error: moving });
          return;
        }
      }
      if (actor.kind === "device" && !client.takesWork) {
        reply({
          ok: false,
          error: `${channel} is work, and a computer on contract ${client.speaks} takes no work from a home on ${homeVersion} until it is updated.`,
        });
        return;
      }
      // The version rule (docs/contract.md): outside the window a device
      // reads, and changes nothing until it is updated, but a paired view
      // still says plain words to the first mate (`READ_ONLY_ASKS`).
      if (
        client.access === "read" &&
        invokeContract[channel].effect === "change" &&
        !(client.role === "view" && asksWhileReading(channel, frame.args))
      ) {
        reply({
          ok: false,
          error: `${channel} changes something, and a device on contract ${client.speaks} only reads from a home on ${homeVersion} until it is updated.`,
        });
        return;
      }
      if (windowAsked.stray(channel, frame.args, client))
        return reply({ ok: true, value: { ok: true } });
      try {
        // A paired view is the captain at another Mac: the same actor the
        // desktop adapter stamps, with the contract's reach as the limit, so
        // the words it types are his own words (the captain's pick, FI3-709).
        // A computer that runs work asks as itself, by the pairing it proved.
        const answered = await dispatch(
          channel,
          frame.args,
          actor,
          client.role === "view" ? viewerOf(client) : undefined,
        );
        const looked = lookFor(
          channel,
          channel.startsWith("inf:cards")
            ? withoutUnreadActions(answered, client.actionReads)
            : answered,
          client.unreadLook,
        );
        const value = pastCardFor(channel, looked, client.changes);
        reply({
          ok: true,
          value:
            channel === "inf:cards:list"
              ? legacyCardSnapshot(value, client.cardReads)
              : THREAD_CHANNELS.has(channel) &&
                  (!client.sharedCards ||
                    !client.cardReads.annotations ||
                    !client.cardReads.through ||
                    !client.cardReads.skipped ||
                    !client.cardReads.places)
                ? threadLinesFor(value, {
                    sharing: client.sharedCards,
                    annotations: client.cardReads.annotations,
                    through: client.cardReads.through,
                    skipped: client.cardReads.skipped,
                    places: client.cardReads.places,
                  })
                : value,
        });
      } catch (error) {
        reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    };

    // Leave (docs/devices.md): the device asks to come off the list, and
    // pairing's change cuts it as `unpaired` before this returns.
    const leave = (client: Client) => {
      // A client of the local door is on no list, so it has nothing to leave.
      if (client.local) {
        cut(client, CONNECTION_CLOSE.protocol, "nothing to leave");
        return;
      }
      try {
        devices.leave(client.device.id);
      } catch (error) {
        onProblem(`a device could not leave: ${(error as Error).message}`);
      }
      cut(client, CONNECTION_CLOSE.unpaired, "unpaired");
    };

    const attach = (ws: WebSocket, device: PairedDevice, viaDoor: boolean, remote?: string) => {
      const client: Client = {
        ws,
        remote,
        device,
        local: viaDoor,
        welcomed: false,
        role: null,
        speaks: "",
        spelling: FIRST_SPELLING,
        appVersion: undefined,
        changes: undefined,
        unreadLook: unreadLook({ protocolVersion: "" }),
        cardReads: {
          updates: false,
          ended: false,
          annotations: false,
          files: false,
          through: false,
          skipped: false,
          places: false,
          liveReads: false,
          answeredByCrewmate: false,
        },
        sharedCards: false,
        actionReads: {
          taskAllow: false,
          keepGoing: false,
          secretKeep: false,
          eventScreen: false,
          secretBring: false,
          savedReset: false,
          autoSavedResets: false,
          moveLogin: false,
        },
        streamed: "none",
        readings: "none",
        drafts: "none",
        access: "read",
        closing: false,
        out: new Outbox(ws, pacing),
        answeredPing: true,
        waitedForHello: false,
        takesWork: false,
        nameOnly: false,
        phone: false,
        gone: [],
        pictures: new Map(),
        asked: new Map(),
      };
      clients.add(client);
      if (!viaDoor && !devices.holds(device.id)) cut(client, CONNECTION_CLOSE.unpaired, "unpaired");
      ws.on("pong", () => {
        client.answeredPing = true;
      });
      ws.on("close", () => {
        clients.delete(client);
        client.catchUp?.end(false);
        windowAsked.left(client);
        const heard = client.gone;
        client.gone = [];
        client.pictures.clear();
        for (const listener of heard) {
          try {
            listener();
          } catch (error) {
            onProblem(`a watch could not end: ${(error as Error).message}`);
          }
        }
        const waiting = [...client.asked.values()];
        client.asked.clear();
        for (const entry of waiting)
          entry.reject(
            new DeviceOutOfReachError("The connection to that computer went mid-request."),
          );
        const stillHere = [...clients].some(
          (other) => other.device.id === client.device.id && other.welcomed && other.takesWork,
        );
        if (client.welcomed && client.takesWork && !stillHere)
          tellWork({ deviceId: client.device.id, contact: "gone" });
        const stillViewing = [...clients].some(
          (other) =>
            other.device.id === client.device.id &&
            !other.local &&
            other.welcomed &&
            other.role === "view",
        );
        if (client.welcomed && client.role === "view" && !client.local && !stillViewing)
          tellView({ deviceId: client.device.id, contact: "gone" });
        // What it said of its version holds while any connection of it does.
        if (client.welcomed && client.role === "work" && !client.nameOnly) {
          const newest = [...clients]
            .reverse()
            .find(
              (other) =>
                other.device.id === client.device.id &&
                other.welcomed &&
                other.role === "work" &&
                !other.nameOnly,
            );
          if (!newest) tellVersion(client.device.id, null);
        }
      });
      // The close that follows an error is what removes the client.
      ws.on("error", () => {});
      ws.on("message", (raw, isBinary) => {
        if (client.closing) return;
        if (!client.local && !devices.holds(client.device.id)) {
          cut(client, CONNECTION_CLOSE.unpaired, "unpaired");
          return;
        }
        let frame: ClientFrame;
        try {
          if (isBinary) throw new Error("binary");
          frame = clientFrameSchema.parse(JSON.parse(String(raw)));
        } catch {
          cut(client, CONNECTION_CLOSE.protocol, "malformed frame");
          return;
        }
        if (frame.t === "hello") {
          if (client.welcomed) cut(client, CONNECTION_CLOSE.protocol, "one hello per connection");
          else welcome(client, frame);
        } else if (!client.welcomed) cut(client, CONNECTION_CLOSE.protocol, "hello first");
        else if (frame.t === "leave") leave(client);
        else if (frame.t === "result") {
          // The answer to something the home asked; one it did not ask is ignored.
          const waiting = client.asked.get(Number(frame.id));
          if (!waiting) return;
          client.asked.delete(Number(frame.id));
          if (frame.ok) waiting.resolve(frame.value);
          else waiting.reject(new Error(frame.error));
        } else void answer(client, frame);
      });
    };

    const refuse = (socket: Duplex, status: string) => {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const answerJson = (response: ServerResponse, status: number, body: unknown) => {
      response
        .writeHead(status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          Connection: "close",
        })
        .end(JSON.stringify(body));
    };
    // A device uses its link (docs/devices.md, "Joining"). Pairing reads the
    // body; the connection only bounds it and keeps browsers out.
    const pair = async (request: IncomingMessage, response: ServerResponse) => {
      const refuseWith = (status: number) => {
        request.resume();
        response.writeHead(status, { Connection: "close" }).end();
      };
      if (request.headers.origin !== undefined) return refuseWith(403);
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        return refuseWith(405);
      }
      if (!/^application\/json(;|$)/i.test(request.headers["content-type"] ?? ""))
        return refuseWith(415);
      if (Number(request.headers["content-length"] ?? 0) > PAIR_BODY_MAX_BYTES)
        return refuseWith(413);
      const text = await readBody(request);
      if (text === undefined) return void response.destroy();
      if (text === null) return refuseWith(413);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      let outcome: PairOutcome;
      try {
        outcome = await devices.claim(body, request);
      } catch (error) {
        onProblem(`a device could not join: ${(error as Error).message}`);
        return answerJson(response, 500, { reason: "The home could not save the device." });
      }
      if (outcome.ok) answerJson(response, 201, outcome.grant);
      else
        answerJson(response, PAIR_REFUSAL_STATUS[outcome.refused], {
          refused: outcome.refused,
          reason: outcome.reason,
        });
    };
    // A command on another Mac gets Firstmate with its link's code
    // (docs/devices.md, "Getting Infinitary from this Mac"), and a computer
    // its home updates gets it with its own key: pairing says whether the
    // code is open, without spending it, or the key is on its list, and the
    // app goes as one gzipped tar of its bundle, made as it is sent.
    const fetchApp = async (request: IncomingMessage, response: ServerResponse) => {
      const refuseWith = (status: number) => {
        request.resume();
        response.writeHead(status, { Connection: "close" }).end();
      };
      const refused = (why: FetchAppRefusal, reason: string) =>
        answerJson(response, FETCH_APP_REFUSAL_STATUS[why], { refused: why, reason });
      if (request.headers.origin !== undefined) return refuseWith(403);
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        return refuseWith(405);
      }
      if (!/^application\/json(;|$)/i.test(request.headers["content-type"] ?? ""))
        return refuseWith(415);
      if (Number(request.headers["content-length"] ?? 0) > PAIR_BODY_MAX_BYTES)
        return refuseWith(413);
      const text = await readBody(request);
      if (text === undefined) return void response.destroy();
      if (text === null) return refuseWith(413);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      const why = devices.opened ? devices.opened(body, request) : "unknown";
      if (why) return refused(why, FETCH_APP_REASONS[why]);
      const want = fetchAppRequestSchema.safeParse(body).data;
      // A command asks first whether its code is open, before it downloads
      // Firstmate elsewhere: nothing is sent, and the code is not spent.
      if (want?.check) return void response.writeHead(204, { Connection: "close" }).end();
      // A computer on the list, proven by its key, is heard as it is sent
      // Firstmate; a command's get names no computer yet.
      let sentTo: string | null = null;
      if (want && want.code === undefined) {
        try {
          sentTo = (await devices.admit(request))?.id ?? null;
        } catch {
          sentTo = null;
        }
      }
      // A computer that names its system gets the Firstmate for it; one that
      // names none is a Mac that asks as Macs always have, and gets this
      // home's own bundle, or nothing from a home that is not a Mac. A home
      // wired with no builds answers its own bundle to every computer.
      const bundle = options.app?.() ?? null;
      const ownBundle: FarBuild | null = bundle?.endsWith(".app")
        ? { form: "bundle", path: bundle }
        : null;
      let build: FarBuild | null = null;
      if (want?.system && options.build) {
        try {
          build = await options.build(want.system, want.chip, want.package);
        } catch (error) {
          onProblem(`could not get Infinitary for another system: ${String(error)}`);
          build = null;
        }
      } else build = ownBundle;
      if (!build) return refused("none", FETCH_APP_REASONS.none);
      if (response.destroyed) return;
      const { stream, ended, stop } = copyStream(build);
      ended.catch((error: unknown) => {
        onProblem(
          `could not send Infinitary: ${error instanceof Error ? error.message : String(error)}`,
        );
        // A copy that fails part way cuts the answer short, so the computer
        // never unpacks half an app.
        response.destroy();
      });
      response.writeHead(200, {
        "Content-Type":
          build.form === "bundle"
            ? FETCH_APP_TYPES.bundle
            : build.form === "zip"
              ? FETCH_APP_TYPES.zip
              : FETCH_APP_TYPES.appImage,
        "Cache-Control": "no-store",
        Connection: "close",
        ...(build.form === "bundle" ? {} : { [FETCH_APP_SHA256_HEADER]: build.sha256 }),
      });
      if (sentTo !== null) {
        const deviceId = sentTo;
        stream.on("data", (piece: Buffer) => tellSent(deviceId, piece.length));
      }
      stream.pipe(response);
      response.once("close", stop);
    };
    // A computer this home asks to build its source gets the committed tree
    // at the commit it runs, with its own key (docs/devices.md, "Matching
    // the home's build"): one gzipped tar made as it is sent, counted as an
    // update's copy is. Never the uncommitted edits, nor another commit.
    const fetchSource = (request: IncomingMessage, response: ServerResponse) =>
      answerSource(request, response, {
        admit: (asked) => devices.admit(asked),
        readBody,
        answerJson,
        source: options.source,
        tellSent,
        onProblem,
      });
    // A device's upgrade proves it by pairing; one on the local door's own
    // listener by the door's key alone, and nothing else is answered there.
    const upgrade = async (
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      door: { open: OpenLocalDoor | null } | null,
    ) => {
      socket.on("error", () => {});
      // A browser always sends an Origin; no web page reaches the home.
      if (request.headers.origin !== undefined) return refuse(socket, "403 Forbidden");
      if (new URL(request.url ?? "/", "http://home").pathname !== CONNECTION_PATH)
        return refuse(socket, "404 Not Found");
      if (door) {
        // The door's own listener admits by its key alone, never by pairing.
        if (!door.open?.admits(request) || run?.clients !== clients)
          return refuse(socket, "401 Unauthorized");
        sockets.handleUpgrade(request, socket, head, (ws) => attach(ws, LOCAL_DEVICE, true));
        return;
      }
      let device: PairedDevice | null;
      try {
        device = await devices.admit(request);
      } catch {
        device = null;
      }
      if (!device || run?.clients !== clients || !devices.holds(device.id))
        return refuse(socket, "401 Unauthorized");
      const admitted = device;
      sockets.handleUpgrade(request, socket, head, (ws) =>
        attach(ws, admitted, false, request.socket.remoteAddress),
      );
    };

    // The captain's own command on the door's listener: by the door's key
    // alone, as an upgrade is, and never from a web page.
    const command = (
      request: IncomingMessage,
      response: ServerResponse,
      door: { open: OpenLocalDoor | null },
    ) => {
      const refuse = (status: number, words: string) => {
        request.resume();
        response
          .writeHead(status, { "content-type": "text/plain; charset=utf-8", Connection: "close" })
          .end(`1\nerror: ${words}\ncode: NO_CHANNEL\n`);
      };
      if (request.headers.origin !== undefined)
        return refuse(403, "No web page reaches this door.");
      if (request.method !== "POST") return refuse(405, "The command posts its request.");
      if (!door.open?.admits(request) || !run)
        return refuse(
          401,
          "This key opens nothing now: Infinitary started again since it was read.",
        );
      options.command?.(request, response);
    };

    // TLS 1.3 only, with the key it is given - the home's own for devices,
    // the door's own for the local door - on every address including
    // loopback: a device checks the key before it sends anything, and
    // shows its own, which pairing reads. No session is resumed, so every
    // connection shows both keys again.
    const tlsWith = (identity: { key: string; cert: string }) => ({
      key: identity.key,
      cert: identity.cert,
      requestCert: true,
      rejectUnauthorized: false,
      secureOptions: cryptoConstants.SSL_OP_NO_TICKET,
      minVersion: "TLSv1.3" as const,
      handshakeTimeout: 10_000,
      headersTimeout: 10_000,
      requestTimeout: 10_000,
      // Node looks for connections past those limits this often: 30 s unless told.
      connectionsCheckingInterval: 1_000,
    });
    const bind = async (
      host: string,
      at: number,
      door: { open: OpenLocalDoor | null } | null,
      identity: { key: string; cert: string },
    ): Promise<{ server: NetServer; port: number }> => {
      // Connections the front handed on whose handshake has not finished, by
      // address and port: a TLS socket whose handshake failed no longer
      // knows its address, so the front, which read it first, says it.
      const handshaking = new Set<string>();
      // A reset's old key is shown to an address that asks for it
      // (`identityFor`, docs/reset.md, "Computers out of reach"): TLS picks
      // its key before the device says anything that names the key it
      // expects, so the choice is made on the bare socket, by its address,
      // and the socket is handed to the TLS listener that shows that key.
      const choosing = !door && devices.identityFor;
      const serve = (shown: { key: string; cert: string }) => {
        const made = createServer(tlsWith(shown), (request, response) => {
          const path = new URL(request.url ?? "/", "https://home").pathname;
          if (door && path === COMMAND_PATH && options.command) command(request, response, door);
          else if (!door && path === PAIR_PATH) void pair(request, response);
          else if (!door && path === FETCH_APP_PATH) void fetchApp(request, response);
          else if (!door && path === FETCH_SOURCE_PATH) void fetchSource(request, response);
          else
            response.writeHead(path === CONNECTION_PATH ? 426 : 404, { Connection: "close" }).end();
        });
        made.on("upgrade", (request, socket, head) => void upgrade(request, socket, head, door));
        if (!door && (devices.noticed || devices.abandoned))
          made.on("secureConnection", (socket) => {
            handshaking.delete(`${socket.remoteAddress}|${socket.remotePort}`);
            devices.noticed?.(socket, shown.cert);
          });
        // Node starts a server's header and request timers only when it
        // listens, and one behind the front never does.
        if (choosing) made.emit("listening");
        return made;
      };
      const tls = serve(identity);
      const shownBy = new Map<string, Server>([[identity.cert, tls]]);
      const server: NetServer = choosing
        ? new KeyFront(shownBy, (socket) => {
            const address = socket.remoteAddress;
            const other = devices.identityFor?.(address);
            const shown = other ?? identity;
            let listener = shownBy.get(shown.cert);
            if (!listener) {
              listener = serve(shown);
              shownBy.set(shown.cert, listener);
            }
            if (devices.abandoned) {
              const at = `${address}|${socket.remotePort}`;
              handshaking.add(at);
              socket.once("close", () => {
                if (handshaking.delete(at)) devices.abandoned?.(address, shown.cert);
              });
            }
            listener.emit("connection", socket);
          })
        : tls;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host, port: at }, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const where = server.address();
      return { server, port: where && typeof where === "object" ? where.port : at };
    };

    // The local door: a loopback port the system chooses, so two accounts
    // on one computer each open their own, and its three files.
    let localPart: Run["local"] = null;
    if (local) {
      const held: { open: OpenLocalDoor | null } = { open: null };
      let server: NetServer | null = null;
      try {
        // A key of its own, kept only in memory and new each run: its pin
        // is in the door's folder, and the home's key stays unwritten until
        // the first link.
        const doorIdentity = createKeyIdentity(LOCAL_DOOR_NAME);
        const bound = await bind("127.0.0.1", 0, held, doorIdentity);
        server = bound.server;
        held.open = openLocalDoor(
          local,
          `127.0.0.1:${bound.port}`,
          doorIdentity.cert,
          options.localDoorRun,
        );
        localPart = { server, door: held.open };
      } catch (error) {
        server?.close();
        onProblem(`could not open the local door: ${(error as Error).message}`);
      }
    }

    const heartbeat = setInterval(() => {
      for (const client of clients) {
        if (!client.answeredPing) {
          client.closing = true;
          client.ws.terminate();
        } else if (!client.welcomed && client.waitedForHello) {
          cut(client, CONNECTION_CLOSE.protocol, "hello first");
        } else {
          client.waitedForHello = true;
          client.answeredPing = false;
          client.out.mark();
        }
      }
    }, heartbeatMs);
    heartbeat.unref();

    const started: Run = {
      servers: [],
      chosen: "",
      addresses: [],
      local: localPart,
      clients,
      detach,
      heartbeat,
      listen: async (want) => {
        const was = started.servers;
        started.servers = [];
        started.addresses = [];
        started.chosen = want.key;
        for (const server of was) server.close();
        // A device listened for elsewhere comes back where it is listened for now.
        if (was.length)
          for (const client of clients)
            if (!client.local) cut(client, CONNECTION_CLOSE.closing, "closing");
        const servers: NetServer[] = [];
        const bound: string[] = [];
        let port = options.port ?? CONNECTION_PORT;
        try {
          // Read again at each listen: the key `identityTag` names may have changed.
          homeIdentity = null;
          for (const address of want.addresses) {
            const made = await bind(address, port, null, ownIdentity());
            servers.push(made.server);
            port = made.port;
            bound.push(`${address.includes(":") ? `[${address}]` : address}:${port}`);
          }
        } catch (error) {
          for (const server of servers) server.close();
          // Tried again at the next change to what is paired.
          started.chosen = "";
          onProblem(`could not listen: ${(error as Error).message}`);
          return;
        }
        started.servers = servers;
        started.addresses = bound;
      },
    };
    await started.listen(listed);
    // Without the local door, a run that could not listen for devices is none.
    if (!localPart && started.servers.length === 0) {
      clearInterval(heartbeat);
      detach();
      sockets.close();
      return null;
    }
    return started;
  }

  /** More than `maxBufferedBytes` waits to reach it, here and in the socket. */
  function behind(client: Client): boolean {
    return client.ws.bufferedAmount + client.out.waiting > maxBufferedBytes;
  }

  function cut(client: Client, code: number, reason: string) {
    if (client.closing) return;
    client.closing = true;
    client.ws.close(code, reason);
  }

  async function stop(code: number) {
    const ending = run;
    run = null;
    if (!ending) return;
    ending.detach();
    clearInterval(ending.heartbeat);
    // Stop accepting at once. HTTP requests do not hold quit open; upgraded
    // device sockets get their own bounded close handshake below.
    for (const server of ending.servers) server.close();
    ending.local?.server.close();
    ending.local?.door.close();
    const drained = [...ending.clients].map(
      ({ ws }) =>
        new Promise<void>((resolve) => {
          if (ws.readyState === WebSocket.CLOSED) resolve();
          else ws.once("close", () => resolve());
        }),
    );
    // Writing 1001 is not delivery: exiting now can turn an intentional
    // quit into 1006 (lost) at a busy view. All devices close concurrently;
    // a device that never replies cannot hold quit open indefinitely.
    const deadline = setTimeout(() => {
      for (const client of ending.clients) client.ws.terminate();
    }, 2_000);
    try {
      for (const client of ending.clients) cut(client, code, "closing");
      await Promise.all(drained);
    } finally {
      clearTimeout(deadline);
    }
  }

  /**
   * A live frame to every welcomed device, this computer's own window too;
   * resolves once each is on its way, or after a short wait.
   */
  const liveToAll = async (
    channel: string,
    payload: unknown | ((client: Client) => unknown),
  ): Promise<void> => {
    const sent = [...(run?.clients ?? [])]
      .filter((client) => client.welcomed && !client.closing)
      .map(
        (client) =>
          new Promise<void>((resolve) => {
            try {
              client.out.send(
                JSON.stringify({
                  t: "live",
                  channel: channelIn(channel, client.spelling),
                  payload: typeof payload === "function" ? payload(client) : payload,
                }),
                () => resolve(),
              );
            } catch {
              resolve();
            }
          }),
      );
    await Promise.race([
      Promise.all(sent),
      new Promise((resolve) => setTimeout(resolve, 2_000).unref?.()),
    ]);
  };

  return {
    listening: listeningNow,
    localDoor: () => run?.local?.door.address ?? null,
    runningVersions: () => {
      const versions = new Map<string, RunningDeviceVersion>();
      for (const client of run?.clients ?? []) {
        if (!client.welcomed || client.closing || client.nameOnly || !client.role || client.local)
          continue;
        versions.set(JSON.stringify([client.device.id, client.role, client.appVersion ?? null]), {
          deviceId: client.device.id,
          role: client.role,
          version: client.appVersion ?? null,
        });
      }
      return [...versions.values()];
    },
    ask: (deviceId, channel, args, askOptions) => {
      const client = workClient(deviceId, askOptions?.anyVersion === true);
      if (!client) return Promise.reject(new DeviceOutOfReachError());
      const id = nextAsk++;
      let text: string;
      try {
        text = JSON.stringify({
          t: "invoke",
          id,
          channel: channelIn(channel, client.spelling),
          args: invokeArgs(args),
        });
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      return new Promise((resolve, reject) => {
        client.asked.set(id, { resolve, reject });
        // An order waits its turn for room rather than piling up behind the
        // others (docs/connection.md, "Pacing and liveness"): many tasks
        // starting at once each send a piece of a file, and together they
        // would pass `maxBufferedBytes` and cut a connection that works.
        client.out.whenClear(() => {
          if (!client.asked.has(id)) return;
          if (behind(client)) {
            client.asked.delete(id);
            reject(new DeviceOutOfReachError());
            cut(client, CONNECTION_CLOSE.behind, "behind");
            return;
          }
          client.out.send(text, (error) => {
            if (!error || !client.asked.has(id)) return;
            client.asked.delete(id);
            reject(new DeviceOutOfReachError());
          });
        });
      });
    },
    onWorkDevice: (listener) => {
      workListeners.add(listener);
      return () => workListeners.delete(listener);
    },
    onViewDevice: (listener) => {
      viewListeners.add(listener);
      return () => viewListeners.delete(listener);
    },
    onWorkVersion: (listener) => {
      versionListeners.add(listener);
      return () => versionListeners.delete(listener);
    },
    welcomedNow: () => ({
      versions: [...toldVersions],
      work: [...toldWork],
      views: [...toldViews],
    }),
    onAppSent: (listener) => {
      sentListeners.add(listener);
      return () => sentListeners.delete(listener);
    },
    onListening: (listener) => {
      listeningListeners.add(listener);
      return () => listeningListeners.delete(listener);
    },
    hold: (why) => {
      moving = why;
    },
    moved: (payload) => liveToAll(HOME_MOVED_LIVE, payload),
    goodbye: () => liveToAll(HOME_GOODBYE_LIVE, {}),
    liveToView: (...args) => {
      const [, channel, payload] = args;
      const windows = windowAsked.sendTo(run?.clients, args);
      for (const client of windows)
        client.out.send(
          JSON.stringify({ t: "live", channel: channelIn(channel, client.spelling), payload }),
        );
      return windows.length > 0;
    },
    routes: () => {
      const addresses = devices.welcomeTargets?.(true) ?? devices.offerTargets?.(true) ?? [];
      const standbys = devices.phoneStandbys?.();
      return liveToAll(HOME_ROUTES_LIVE, (client: Client) => ({
        addresses,
        ...(client.phone && standbys ? { standbys } : {}),
      }));
    },
    settled: () => tail,
    close: async () => {
      closed = true;
      unsubscribe();
      await reconcile();
    },
  };
}

/**
 * The listener that picks which key a connection is shown and hands it to the
 * TLS listener showing that key (`identityFor`); those never listen
 * themselves, so closing it closes them too.
 */
class KeyFront extends NetServer {
  constructor(
    private readonly shownBy: ReadonlyMap<string, Server>,
    handOn: (socket: Socket) => void,
  ) {
    super(handOn);
  }

  override close(callback?: (error?: Error) => void): this {
    for (const listener of this.shownBy.values()) listener.close();
    return super.close(callback);
  }
}
