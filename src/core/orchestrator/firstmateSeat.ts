import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { isAuthFailureMessage } from "@shared/authFailure";
import { CLAUDE_ACCESS_RENEW_WORDS, claudeAccessRefusedText } from "@shared/claudeAccess";
import { isCustomApiProvider } from "@shared/customApi";
import * as m from "@shared/i18n/messages.generated";
import { isRunawayProviderError } from "@shared/plainProblem";
import { backendForProvider, catalogEntry } from "@shared/providers";
import { clockTime, type QuotaSnapshotView } from "@shared/quota";
import type { ServedSequences } from "../personal/sequencesSkill";
import { firstmatePromptSha, toolsFingerprint } from "../pi/piResources";
import { createPiSessionFactory } from "../pi/sessionFactory";
import { summaryCompaction } from "../session/compaction";
import type {
  ModelSession,
  SessionEvent,
  SessionFactories,
  SessionRenewal,
  SessionResume,
} from "../session/session";
import { FIRSTMATE_RECIPIENT } from "../storage/inboxStore";
import type { FirstmatePaused } from "../storage/settingsStore";
import { QUIT_SETTLE_MS } from "./crewRuntime";
import type { FirstmateAgentOptions } from "./firstmateAgent";
import { deriveModelForProvider, preflightModel, resolveModel } from "./firstmateModelPick";
import type { buildFirstmateTools } from "./firstmateTools";
import {
  creditsOfferSentence,
  FIRSTMATE_MOVE_BACK_CARD_ID,
  FIRSTMATE_NO_PROVIDER_SIGN_IN_WORDS,
  type FirstmatePauseCard,
  savedResetsWords,
  spentAttemptOf,
} from "./hostCards";
import type { LocalOrchestratorSeat } from "./localOrchestrator";
import type { SeatMoveReason, WakeSeat } from "./noticeWakes";
import {
  ALLOWANCE_CHECKING_WORDS,
  allowanceCheckedWords,
  type SeatBackend,
  type SeatBinding,
  type SeatPause,
  seatMovedLine,
  seatPausedLine,
  seatSessionSpec,
} from "./seat";
import { digestFor, seatIdentity } from "./seatDigest";

const AUTH_CARD_ID = "card-fm-auth";

/**
 * Consecutive flagship runaways (max_time_limit / token-generation /
 * turn-timeout) after which Firstmate refuses a new turn until Retry.
 * Does not change the captain's chosen flagship model.
 */
const RUNAWAY_REFUSE_AFTER = 2;

/** The inbox ref the moved seat's wake rides (W1 S9). */
const SEAT_MOVED_REF = "seat-moved";

/** Why an attach the quit stopped ended; it reaches no card or feed line. */
// i18n-exempt: why a stopped attach ended; it reaches no card or feed line
const QUIT_STOPPED_ATTACH = "The app quit before your first mate attached.";

export function formatFlagshipError(
  model: { provider: string; id: string } | undefined | null,
  error: string,
): string {
  const trimmed = error.trim();
  if (!trimmed) return "unknown error";
  if (!model) return trimmed;
  const name = catalogEntry(model.provider)?.name ?? model.provider;
  const prefix = `${name} ${model.id}: `;
  if (trimmed.startsWith(prefix)) return trimmed;
  return `${prefix}${trimmed}`;
}

/**
 * The first mate's seat (docs/architecture.md §16): which account and
 * model answer, the attachment that opens the rolling session over them,
 * and the admission ladder at each idle boundary - a sibling account, a
 * pause with its card, a move the captain chooses and the way back. It
 * never runs a turn: the agent does, and lends it what it needs
 * (`FirstmateSeatHost`).
 */

type FirstmateSeatHost = {
  /** A turn is running: a change waits for its idle boundary. */
  running(): boolean;
  tools(): ReturnType<typeof buildFirstmateTools>;
  sequences(): ServedSequences;
  /** A new session read no context of this app's: the next input is complete. */
  contextChanged(): void;
  onSessionEvent(event: SessionEvent): void;
  /** One delivery attempt of the first mate's inbox lane. */
  drain(): Promise<void>;
};

export class FirstmateSeat {
  session: ModelSession | undefined;
  /** The attach in flight, so a second asker shares it. */
  creating: Promise<ModelSession> | undefined;
  private unsubscribe: (() => void) | undefined;
  /** Set by the quit: no attach goes on after it (`dispose`). */
  private disposed = false;
  boundAccountId: string | undefined;
  boundLocal = false;
  /** Consecutive thinking-runaway failures; Reset on a clean turn or Retry. */
  runawayStreak = 0;
  /** After RUNAWAY_REFUSE_AFTER, idle turns wait for Retry rather than hang. */
  runawayRefused = false;
  private readonly seats: SessionFactories;
  /** The tool surface fingerprint of the bound session (R2 contract stamp). */
  toolsSha: string | null = null;
  /** The bound backend's served prompt sha (R2 contract stamp); it differs on Claude. */
  promptSha: string | null = null;
  /**
   * The dev-only local seat (roadmap 1.7): the Firstmate's model and
   * runtime outright while set. It changes only through
   * `setLocalOrchestrator`, and a change binds at an idle boundary.
   */
  private localSeat: LocalOrchestratorSeat | undefined;
  private seatChanged = false;
  /** A Settings model change waiting for the current turn's idle boundary. */
  private modelChanged = false;

  /**
   * The pause the seat is in (W1 S9, docs/architecture.md §16 "A paused
   * seat"): the bound account and the class admission found, and where the
   * card offered to move, so the pause's feed line, ledger row and card go
   * out once and the way back is noticed on the tick. Durable (a settings
   * row), so a restart neither repeats them nor leaves the card up once the
   * account serves again.
   */
  get paused(): FirstmatePaused | undefined {
    return this.options.settings.getFirstmatePaused() ?? undefined;
  }

  set paused(paused: FirstmatePaused | undefined) {
    this.options.settings.setFirstmatePaused(paused ?? null);
  }
  /** Sign-ins and sign-outs rewriting an account's store, which hold the seat off it. */
  private readonly storeHolds = new Map<string, number>();
  /** The attached seat: its session's identity on the digest, provider and model. */
  boundSeat: { identity: string; provider: string; model: string } | undefined;
  /**
   * A move the captain chose, waiting for the attachment that carries it
   * out: that attachment's first turn gets the `seat-moved` wake.
   */
  private pendingMove:
    | { from: WakeSeat; fromIdentity: string | undefined; reason?: SeatMoveReason }
    | undefined;

  constructor(
    private readonly options: FirstmateAgentOptions,
    private readonly host: FirstmateSeatHost,
  ) {
    this.localSeat = options.localOrchestrator;
    this.seats = options.seats ?? {
      pi: createPiSessionFactory({ agentDir: options.paths.piAgentDir }),
    };
  }

  /**
   * The dev-only local seat (roadmap 1.7) changed under Settings: bind to
   * it - or back to the usual model - at an idle boundary, the way an
   * explicit pin applies. Idle now: the rolling session is detached and the
   * next turn re-opens the same file over the new runtime; busy: the
   * pre-turn admission check does it, never mid-turn.
   */
  async setLocalOrchestrator(seat: LocalOrchestratorSeat | undefined): Promise<void> {
    this.localSeat = seat;
    if (this.creating) {
      this.seatChanged = true;
      return;
    }
    if (!this.session) return;
    if (this.host.running() || this.session.isStreaming()) {
      this.seatChanged = true;
      return;
    }
    this.detach();
    void this.host.drain();
  }

  /**
   * Let go of the rolling session; its durable identity is its JSONL file
   * plus the settings row, so the next turn re-opens it over whatever the
   * attachment resolves to then.
   */
  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session?.dispose();
    this.session = undefined;
  }

  /**
   * The quit: let go of the session, and let no attach still in flight make
   * a folder, open a session or write the record after it. An attach waiting
   * on its model or account stops at its next step; one already opening is
   * waited for, at most `QUIT_SETTLE_MS` as the crew's are, and what it
   * opened is closed.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.detach();
    const creating = this.creating;
    if (!creating) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        creating.then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, QUIT_SETTLE_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The purge (captain decision Q4): let go of the rolling session, forget
   * every backend's pointer and the digest, and remove the transcripts.
   */
  async forget(): Promise<void> {
    const session = this.session;
    this.detach();
    this.creating = undefined;
    this.runawayStreak = 0;
    this.runawayRefused = false;
    // Every backend keeps its own rolling session; the purge forgets them all.
    this.options.settings.setFirstmateSessionFile(null);
    this.options.settings.setFirstmateClaudeSession(null);
    // The turns the digest carries across belong to the sessions just forgotten.
    this.options.settings.setFirstmateSeatDigest([]);
    // The Claude seat copies its transcript as the client exits. Wait for that
    // last write, then remove every Firstmate transcript directory. The
    // supervision session retired with S7c; a leftover transcripts dir still goes.
    // The client's own copies under ~/.claude/projects stay.
    await session?.closed().catch(() => {});
    await Promise.all([
      rm(this.options.paths.firstmateSessionsDir, { recursive: true, force: true }),
      rm(this.options.paths.firstmateClaudeDir, { recursive: true, force: true }),
      rm(this.options.paths.supervisionSessionsDir, { recursive: true, force: true }),
    ]);
  }

  /** Peek for Observe: the model this rolling session is on. */
  modelRef(): { provider: string; id: string } | null {
    return this.session?.modelRef() ?? this.options.settings.getFirstmateModel();
  }

  sessionFile(): string | null {
    return this.session?.recordPath() ?? null;
  }

  async ensureSession(): Promise<ModelSession | undefined> {
    if (this.disposed) return undefined;
    if (this.session) return this.session;
    if (this.creating) return this.creating.catch(() => undefined);
    this.attaching = undefined;
    this.pausedAtAttach = false;
    this.creating = this.doCreateSession();
    let failure: string;
    try {
      const session = await this.creating;
      this.session = session;
      return session;
    } catch (caught) {
      // A quit stopped the attach: nothing failed that a card should say.
      if (this.disposed) return undefined;
      failure = caught instanceof Error ? caught.message : String(caught);
      this.sessionFailure = failure;
    } finally {
      this.creating = undefined;
    }
    // An attach a typed fact on its account explains - no client on this
    // Mac to run the seat - is that account's pause, through the ladder
    // like any other (W1 S12): its card in its class's words, and a move
    // offered when another provider can serve. Anything else is the
    // failure card.
    const accountId = this.attaching;
    const pause =
      accountId && !this.boundLocal ? this.options.flagship?.pause(accountId) : undefined;
    if (accountId && pause) {
      const moved = await this.climbLadder(accountId, pause);
      this.pausedAtAttach = !moved;
      return moved;
    }
    this.raiseSessionFailureCard(failure);
    return undefined;
  }

  /** The account the attach in flight is binding, once it has resolved one. */
  private attaching: string | undefined;

  /** The last attach found its account paused: the seat waits, as admission's pause does. */
  pausedAtAttach = false;

  /** Why the last session create failed, for the ask that turn had opened. */
  sessionFailure: string | undefined;

  private async doCreateSession(): Promise<ModelSession> {
    const model = resolveModel(this.options, this.localSeat);
    if (!model) {
      throw new Error("No signed-in model is available for your first mate.");
    }
    // The flagship binding is a property of this ATTACHMENT: resolved here
    // (app start and every rebind), never mid-transcript.
    const local = this.localSeat;
    await local?.prepare?.();
    const binding: SeatBinding = local
      ? { backend: "pi", runtime: local.runtime, local: true }
      : this.options.flagship
        ? await this.options.flagship.resolveBinding(model.provider)
        : { backend: "pi", runtime: this.options.modelRuntime };
    if (this.disposed) throw new Error(QUIT_STOPPED_ATTACH);
    const factory = this.seats[binding.backend];
    if (!factory) {
      // No factory seats this backend: the create fails like any other, so
      // the turn takes the existing session-failure path and its card.
      const accountId = binding.accountId;
      const flagship = this.options.flagship;
      throw new Error(
        (accountId ? flagship?.ineligibilityReason(accountId) : undefined) ??
          `${(accountId ? flagship?.labelOf(accountId) : undefined) ?? "That account"} cannot run your first mate.`,
      );
    }
    this.boundAccountId = binding.accountId;
    this.attaching = binding.accountId;
    this.boundLocal = Boolean(local);
    await mkdir(this.options.paths.firstmateHomeDir, { recursive: true });
    await mkdir(this.options.paths.firstmateSessionsDir, { recursive: true });
    const resume = this.recordedResume(binding.backend);
    const tools = this.host.tools();
    this.toolsSha = toolsFingerprint(tools);
    this.promptSha = firstmatePromptSha(binding.backend);
    const sequences = this.host.sequences();
    const session = await factory.open(
      seatSessionSpec({
        paths: this.options.paths,
        binding,
        model,
        tools,
        instructions: { text: sequences.text, sha: sequences.sha },
        ...(resume ? { resume } : {}),
        compaction: () => summaryCompaction(this.options.settings.getSummaryPoint()),
      }),
    );
    if (this.disposed) {
      session.dispose();
      throw new Error(QUIT_STOPPED_ATTACH);
    }
    // A session opened here - new, resumed or replaced - has read no
    // context this app can vouch for: its next input is complete.
    this.host.contextChanged();
    this.rememberResume(session);
    this.unsubscribe = session.subscribe((event) => this.host.onSessionEvent(event));
    const renewal = session.takeRenewal();
    if (renewal) {
      this.noteRenewal(
        renewal,
        binding.backend,
        this.boundSeat ?? {
          provider: model.provider,
          model: model.id,
        },
      );
    }
    const seat = {
      identity: seatIdentity(binding.backend, session.sessionId),
      provider: model.provider,
      model: model.id,
    };
    this.boundSeat = seat;
    this.announceMove(seat);
    return session;
  }

  /**
   * An idle boundary before a turn's batch is read: a changed sequences
   * file is re-served here, never inside a turn already running. A session
   * that starts over for it under a new id (a Claude client resumes a
   * session on the prompt it started under) is carried over as a move is:
   * the ledger says why, and this turn gets the seat-moved wake with the
   * digest of the turns the new session has not seen.
   */
  serveInstructionsAt(session: ModelSession): void {
    const sequences = this.host.sequences();
    session.serveInstructions({ text: sequences.text, sha: sequences.sha });
    const renewal = session.takeRenewal();
    const seat = this.boundSeat;
    const backend = session.resume()?.backend;
    if (!renewal || !seat || !backend) return;
    this.rememberResume(session);
    this.noteRenewal(renewal, backend, seat);
    const renewed = { ...seat, identity: seatIdentity(backend, session.sessionId) };
    this.boundSeat = renewed;
    this.announceMove(renewed);
  }

  /**
   * The seat's session started over under a new id because the prompt
   * array it serves changed: a ledger row names the change, and the
   * attachment's next turn is told as a move's is (`announceMove`), unless
   * a move the captain chose is already waiting to say where it went.
   */
  private noteRenewal(
    renewal: SessionRenewal,
    backend: SeatBackend,
    from: { provider: string; model: string },
  ): void {
    this.host.contextChanged();
    const changed = renewal.changed
      .map((part) => (part === "prompt" ? "the first mate's prompt" : "the served instructions"))
      .join(" and ");
    this.options.flagship?.record("renewed", this.boundAccountId ?? null, [
      `${changed} changed since session ${renewal.from} started`,
      "a resumed session serves the prompt it started under, so a new session starts with the digest",
    ]);
    this.pendingMove ??= {
      from: { provider: this.providerNameOf(from.provider), model: from.model },
      fromIdentity: seatIdentity(backend, renewal.from),
      reason: "instructions",
    };
  }

  /**
   * The attachment that carries out the captain's move (W1 S9): its first
   * turn gets the typed `seat-moved` wake - and, when the move changed
   * sessions, the bounded digest of the turns this session has not seen
   * (the owner's Q4 b, `seatDigest.ts`) - and the feed says where
   * Firstmate went. The context block every turn carries is the host's
   * truth either way.
   */
  private announceMove(seat: { identity: string; provider: string; model: string }): void {
    const move = this.pendingMove;
    if (!move) return;
    this.pendingMove = undefined;
    const carried = move.fromIdentity === seat.identity;
    const to: WakeSeat = { provider: this.providerNameOf(seat.provider), model: seat.model };
    this.options.inbox.enqueueWake(
      FIRSTMATE_RECIPIENT,
      {
        facts: {
          kind: "seat-moved",
          from: move.from,
          to,
          ...(move.reason ? { reason: move.reason } : {}),
          carried,
          recent: carried
            ? []
            : digestFor(this.options.settings.getFirstmateSeatDigest(), seat.identity),
        },
      },
      "agent",
      SEAT_MOVED_REF,
    );
    this.options.broadcastEvent({ type: "firstmate_note", text: seatMovedLine(to, move.reason) });
  }

  private providerNameOf(providerId: string): string {
    return (
      this.options.flagship?.providerNameOf(providerId) ??
      catalogEntry(providerId)?.name ??
      providerId
    );
  }

  /**
   * Where the binding backend's own rolling session resumes from. Each
   * backend keeps its own pointer, since the two transcript formats do not
   * carry across; a Pi file that is gone starts fresh.
   */
  private recordedResume(backend: SeatBackend): SessionResume | undefined {
    const settings = this.options.settings;
    if (backend === "claude") {
      const sessionId = settings.getFirstmateClaudeSession();
      return sessionId ? { backend, sessionId } : undefined;
    }
    const sessionFile = settings.getFirstmateSessionFile();
    return sessionFile && existsSync(sessionFile) ? { backend, sessionFile } : undefined;
  }

  private rememberResume(session: ModelSession): void {
    const settings = this.options.settings;
    const resume = session.resume();
    if (resume?.backend === "claude") {
      settings.setFirstmateClaudeSession(resume.sessionId);
    } else if (resume?.backend === "pi") {
      settings.setFirstmateSessionFile(resume.sessionFile);
    }
  }

  /**
   * Rebind the rolling session to another account at an idle boundary: the
   * session's durable identity is its JSONL file plus the settings row, so
   * this is the same operation as an app-restart resume - dispose, re-open
   * the same file over the other account's runtime. Never mid-turn.
   */
  async rebind(accountId: string, note?: string): Promise<ModelSession | undefined> {
    if (this.host.running() || this.session?.isStreaming()) return undefined;
    this.options.settings.setFirstmateAccount(accountId);
    this.detach();
    const session = await this.ensureSession();
    if (session && note) {
      this.options.broadcastEvent({ type: "firstmate_note", text: note });
    }
    return session;
  }

  /**
   * Apply an explicit flagship pin change now if the session is idle; a
   * busy session picks it up at the next idle boundary (the pre-turn
   * admission check), never mid-turn.
   */
  async applyAccountSetting(): Promise<void> {
    const flagship = this.options.flagship;
    if (!flagship || !this.session) return;
    if (this.localSeat) return;
    if (this.host.running() || this.session.isStreaming()) return;
    const persisted = this.options.settings.getFirstmateAccount();
    if (!persisted || persisted === this.boundAccountId) return;
    if (!flagship.isEligible(persisted)) return;
    // The same ledger row admission writes when the change waits for idle.
    flagship.record("pinned", persisted, [
      `the setting names ${flagship.labelOf(persisted) ?? persisted}`,
    ]);
    await this.rebind(persisted);
  }

  /**
   * Persist a model together with an account from that provider, then move
   * the rolling session at the next safe attachment boundary.
   */
  async applyModelSetting(model: { provider: string; id: string } | null): Promise<void> {
    const flagship = this.options.flagship;
    const accountId = model ? flagship?.deriveForProvider(model.provider) : undefined;
    const seat = this.boundSeat;
    // A pick that takes the seat to another account or backend is a move:
    // the ledger says why, and the attachment that carries it out tells its
    // first turn (`announceMove`), as the move card's does.
    if (
      model &&
      seat &&
      !this.localSeat &&
      (accountId !== this.boundAccountId ||
        backendForProvider(model.provider) !== backendForProvider(seat.provider))
    ) {
      flagship?.record("pinned", accountId ?? null, [
        `the captain picked ${this.providerNameOf(model.provider)} (${model.id}) in Settings`,
      ]);
      this.pendingMove = {
        from: { provider: this.providerNameOf(seat.provider), model: seat.model },
        fromIdentity: seat.identity,
      };
    }
    this.options.settings.setFirstmateBinding(model, accountId ?? null);
    // The captain chose the seat outright: a pending way back is moot.
    if (this.options.settings.getFirstmateMovedFrom()) {
      this.options.settings.setFirstmateMovedFrom(null);
      this.options.supervisor.cards.hostCards.withdrawHostCard(
        FIRSTMATE_MOVE_BACK_CARD_ID,
        "model chosen",
      );
    }
    if (this.localSeat) return;
    // An attach in flight already resolved the earlier model: admission,
    // which every turn passes right after the attach, re-opens on this one.
    if (this.creating) {
      this.modelChanged = true;
      return;
    }
    if (!this.session) return;
    if (this.host.running() || this.session.isStreaming()) {
      this.modelChanged = true;
      return;
    }
    this.detach();
    await this.ensureSession();
    void this.host.drain();
  }

  /**
   * The pre-turn admission check and exhaustion ladder. Returns the session
   * to run on (possibly rebound to a sibling), or undefined when the
   * orchestrator is benched - rung 2 and 3 raise their cards and the turn
   * waits in the durable inbox.
   */
  async admitTurn(initial: ModelSession): Promise<ModelSession | undefined> {
    if (this.runawayRefused) return undefined;
    let session = initial;
    // The dev-only local seat (roadmap 1.7) changed while a turn ran: this
    // idle boundary is where the rolling session moves onto it, or off it.
    while (this.seatChanged) {
      this.seatChanged = false;
      this.detach();
      const reopened = await this.ensureSession();
      if (!reopened) return undefined;
      session = reopened;
    }
    // The seat has no account to ladder: it stays.
    if (this.localSeat) return session;
    // A picker change made during the preceding turn becomes one coherent
    // model/account attachment now, before allowance admission reads it.
    if (this.modelChanged) {
      this.modelChanged = false;
      this.detach();
      const reopened = await this.ensureSession();
      if (!reopened) return undefined;
      session = reopened;
    }
    const flagship = this.options.flagship;
    if (!flagship) return session;
    // A sign-in or sign-out is rewriting the bound account's store: the
    // seat waits it out, its turns kept on the inbox.
    if (this.boundAccountId && this.storeHolds.has(this.boundAccountId)) return undefined;
    // An explicit pin change in Settings applies at this idle boundary.
    const persisted = this.options.settings.getFirstmateAccount();
    if (persisted && persisted !== this.boundAccountId && flagship.isEligible(persisted)) {
      flagship.record("pinned", persisted, [
        `the setting names ${flagship.labelOf(persisted) ?? persisted}`,
      ]);
      return this.rebind(persisted);
    }
    const accountId = this.boundAccountId;
    if (!accountId) return session;
    const pause = flagship.pause(accountId);
    if (!pause) {
      // Credits come after every included allowance: a seat on credits
      // moves first to a sibling of the same provider that still has some.
      const sibling = flagship.onCredits(accountId)
        ? flagship.sibling(accountId, "measured")
        : undefined;
      if (sibling) {
        const label = flagship.labelOf(accountId) ?? accountId;
        flagship.record("rebound", sibling.id, [
          `${label}: on credits`,
          `picked ${sibling.label}: an account of the same provider with included allowance`,
        ]);
        return this.rebind(
          sibling.id,
          `Your first mate moved to ${sibling.label} - ${label} has used up its allowance, and ${sibling.label} still has some.`,
        );
      }
      // A saved reset is weighed now, when its switch is on; credits serve this turn until it lands.
      if (flagship.onCredits(accountId)) this.options.savedResetsSpent?.(accountId);
      this.servesAgain();
      return session;
    }
    return this.climbLadder(accountId, pause);
  }

  /**
   * The ladder for a seat whose account cannot serve (docs/architecture.md
   * §16 "A paused seat"), the same for every class and every backend (the
   * owner's Q5 a). Rung 1: a sibling of the same provider - same model,
   * the system working - is a feed line, not a card. Otherwise the seat
   * pauses: rung 2 asks by card to move to another provider with headroom,
   * rung 3 says it waits. Nothing moves or retries until the captain
   * clicks, and the durable inbox keeps every word meanwhile.
   */
  private async climbLadder(
    accountId: string,
    pause: SeatPause,
  ): Promise<ModelSession | undefined> {
    const flagship = this.options.flagship;
    if (!flagship) return undefined;
    const label = flagship.labelOf(accountId);
    // A removed account has no siblings of its own: the model's provider does.
    const provider = this.options.settings.getFirstmateModel()?.provider;
    const derived = !label && provider ? flagship.deriveForProvider(provider) : undefined;
    const sibling =
      flagship.sibling(accountId) ??
      (derived ? { id: derived, label: flagship.labelOf(derived) ?? derived } : undefined);
    if (sibling) {
      flagship.record("rebound", sibling.id, [
        `${label ?? accountId}: ${pause.class}`,
        `picked ${sibling.label}: an account of the same provider that can serve`,
      ]);
      const why =
        label && pause.class !== "unavailable"
          ? flagship.pauseSentence(accountId, pause)
          : "its previous account is no longer available.";
      return this.rebind(sibling.id, `Your first mate moved to ${sibling.label} - ${why}`);
    }
    // No sibling has room: a saved reset may end the pause, when the account's
    // switch is on and it beats waiting; a higher reading then resumes the seat.
    if (pause.class === "no_headroom") this.options.savedResetsSpent?.(accountId);
    this.pauseSeat(accountId, pause);
    return undefined;
  }

  /**
   * The seat pauses on this account: the pause card for its class and rung,
   * and - once per pause - its feed line and ledger row. The seat lets go
   * of a client that holds the account's sign-in, so its health can be read
   * while nothing runs; the next admitted turn attaches again.
   */
  private pauseSeat(accountId: string, pause: SeatPause): void {
    const flagship = this.options.flagship;
    if (!flagship) return;
    const providerId =
      flagship.providerOf(accountId) ?? this.options.settings.getFirstmateModel()?.provider;
    const providerName = providerId ? flagship.providerNameOf(providerId) : "its provider";
    const other = providerId ? flagship.otherProviderOption(providerId) : undefined;
    const previous = this.paused;
    const fresh =
      previous?.accountId !== accountId ||
      previous.class !== pause.class ||
      previous.move !== other?.providerId;
    if (fresh) {
      this.attemptOffered = undefined;
      this.paused = {
        accountId,
        class: pause.class,
        ...(other ? { move: other.providerId } : {}),
      };
    }
    void this.session?.detach();
    // The pause card speaks for a lost sign-in: the generic sign-in card a
    // failed turn raised before the proof came is not a second card for it.
    this.options.supervisor.cards.hostCards.clearAuthDecisionCard(AUTH_CARD_ID);
    const card = this.pauseCard(accountId, pause);
    if (!fresh) {
      // The same pause: its card stands, revised in place if its words
      // moved, without recreating a card removed by a choice or withdrawal.
      this.options.supervisor.cards.hostCards.addFirstmatePauseCard(card, { reviseOnly: true });
      return;
    }
    // A changed pause is a new question: the old card's is gone.
    if (previous) this.options.supervisor.cards.hostCards.withdrawFirstmatePauseCards("superseded");
    const sentence = flagship.pauseSentence(accountId, pause);
    this.options.broadcastEvent({
      type: "firstmate_note",
      text: seatPausedLine(pause.class, sentence, providerId ? providerName : "Its provider"),
    });
    flagship.record(other ? "move-offered" : "paused", accountId, [
      `${flagship.labelOf(accountId) ?? accountId}: ${pause.class}`,
      ...(other ? [`offered ${other.providerName}: it has headroom`] : ["nothing else can serve"]),
    ]);
    this.options.supervisor.cards.hostCards.addFirstmatePauseCard(card);
  }

  private pauseCard(accountId: string, pause: SeatPause): FirstmatePauseCard {
    const flagship = this.options.flagship;
    const providerId =
      flagship?.providerOf(accountId) ?? this.options.settings.getFirstmateModel()?.provider;
    const providerName =
      providerId && flagship ? flagship.providerNameOf(providerId) : "its provider";
    const other = providerId ? flagship?.otherProviderOption(providerId) : undefined;
    const access = flagship?.accessOf(accountId);
    const credits = pause.class === "no_headroom" ? flagship?.creditsOffer(accountId) : undefined;
    return {
      pause: pause.class,
      ...(access ? { access } : {}),
      body: this.pauseCardBody(accountId, pause, providerName, other?.providerName),
      ...(flagship?.labelOf(accountId) ? { accountId } : {}),
      providerName,
      ...(other ? { move: other } : {}),
      ...(this.rechecking ? { checking: true } : {}),
      ...(this.offersAttempt(accountId, pause) ? { attempt: true } : {}),
      ...(credits ? { credits } : {}),
      ...(pause.class === "no_headroom" && flagship?.savedResetsNow(accountId)
        ? { savedResets: true }
        : {}),
    };
  }

  /** What a pause card says: what stopped the seat, what is kept, and what it asks. */
  private pauseCardBody(
    accountId: string,
    pause: SeatPause,
    providerName: string,
    moveTo: string | undefined,
  ): string {
    const flagship = this.options.flagship;
    if (!flagship) return "";
    const providerId = flagship.providerOf(accountId);
    if (pause.class === "no_headroom") {
      const summary = providerId ? flagship.exhaustionSummary(providerId) : undefined;
      // One account (Claude has one login ever) is named, never counted.
      const spent =
        providerId && flagship.accountCount(providerId) > 1
          ? `Your first mate's ${providerName} accounts have used up their allowance (${summary}).`
          : flagship.pauseSentence(accountId, pause);
      const checked = `${this.allowanceCheckWords(accountId)}${
        this.offersAttempt(accountId, pause)
          ? ` ${m.cardSpentTryOnce({ provider: providerName })}`
          : ""
      }`;
      const resets = this.savedResetsWords(accountId, providerName);
      const offer = flagship.creditsOffer(accountId);
      if (offer)
        return `${spent} ${creditsOfferSentence(offer)} Your messages are kept, and your first mate and crew wait until then unless you keep going on credits.${checked}${resets}`;
      return moveTo
        ? `${spent} Your messages are kept.${checked}${resets} Move your first mate to ${moveTo} until then?`
        : `No connected account has allowance left for your first mate right now${
            summary ? ` (${summary})` : ""
          }. Your messages are kept. It will resume when one resets.${checked}${resets}`;
    }
    if (pause.class === "unavailable" && !moveTo) {
      return "Your first mate's account was disconnected and no other account can serve it. Connect an account to continue.";
    }
    const said =
      pause.class === "refused"
        ? `${providerName} is not answering your first mate right now, and your messages are kept. If something on your ${providerName} account needed fixing, such as billing, fix it there first.`
        : `${flagship.pauseSentence(accountId, pause)} Your messages are kept.`;
    if (moveTo) return `${said} Move your first mate to ${moveTo} in the meantime?`;
    if (pause.class === "refused") return `${said} Then choose Try ${providerName} again.`;
    if (pause.class === "signed_out") {
      const access = flagship.accessOf(accountId);
      return access
        ? `${said} ${CLAUDE_ACCESS_RENEW_WORDS[access]}`
        : `${said} Your first mate picks them up once you sign in.`;
    }
    return `${said} Your first mate picks them up once it can run.`;
  }

  /**
   * The seat account's saved resets that would apply now, with a leading
   * space, for the spent-allowance card (docs/quota.md, "Saved resets"):
   * named as its Settings row names it, with a link to where it is used.
   */
  private savedResetsWords(accountId: string, providerName: string): string {
    const flagship = this.options.flagship;
    const resets = flagship?.savedResetsNow(accountId);
    if (!flagship || !resets) return "";
    const label = flagship.labelOf(accountId);
    const account = label ? `${providerName} · ${label}` : providerName;
    return ` ${savedResetsWords({ account, ...resets })}`;
  }

  /**
   * When the spent allowance was last read and who is signed in, with a
   * leading space, for the pause card: a person who switched accounts
   * elsewhere sees whether the reading is the new one. A reading that could
   * not be taken says so, never that the allowance is still spent.
   */
  private allowanceCheckWords(accountId: string): string {
    const flagship = this.options.flagship;
    if (!flagship) return "";
    if (this.rechecking) return ` ${ALLOWANCE_CHECKING_WORDS}`;
    const check = flagship.allowanceCheck(accountId);
    if (!check) return "";
    return ` ${allowanceCheckedWords(
      check.read
        ? {
            read: true,
            time: clockTime(check.at),
            ...(check.identity ? { identity: check.identity } : {}),
          }
        : { read: false, ...(check.at !== undefined ? { time: clockTime(check.at) } : {}) },
    )}`;
  }

  /**
   * The paused seat's account serves again (the way back, W1 S9): a feed
   * line, the ledger row, and the pause cards go - nothing moved, so there
   * is nothing to ask. A pause on an account the seat is no longer bound
   * to simply ends: its question is gone.
   */
  private servesAgain(): void {
    // Whatever pause card is up - one a previous run left, too - asks a
    // question that is gone. Taking one down is idempotent.
    this.options.supervisor.cards.hostCards.withdrawFirstmatePauseCards("serves again");
    this.attemptOffered = undefined;
    const paused = this.paused;
    if (!paused) return;
    this.paused = undefined;
    const flagship = this.options.flagship;
    if (!flagship || paused.accountId !== this.seatAccount()) return;
    this.options.supervisor.cards.hostCards.clearAuthDecisionCard(AUTH_CARD_ID);
    // What waited out the pause is due now, whatever its backoff said.
    this.options.inbox.endOutage(FIRSTMATE_RECIPIENT);
    const label = flagship.labelOf(paused.accountId) ?? "its account";
    flagship.record("serves-again", paused.accountId, [`${label}: no longer ${paused.class}`]);
    this.options.broadcastEvent({
      type: "firstmate_note",
      text: `Your first mate is answering again on ${label}.`,
    });
  }

  /**
   * The seat's way back, read on the shared tick and a quota refresh (W1
   * S9): a paused seat whose account serves again resumes - its feed line,
   * then the next drain - and a seat the captain moved off an account that
   * serves again is offered the move back, once, by card. Nothing moves on
   * its own.
   */
  checkSeat(): void {
    const flagship = this.options.flagship;
    if (!flagship || this.localSeat) return;
    const paused = this.paused;
    if (paused && (paused.accountId !== this.seatAccount() || !flagship.pause(paused.accountId))) {
      this.servesAgain();
    }
    const movedFrom = this.options.settings.getFirstmateMovedFrom();
    if (!movedFrom) return;
    if (!flagship.labelOf(movedFrom.accountId)) {
      // The account it left is gone: there is nowhere to move back to.
      this.options.settings.setFirstmateMovedFrom(null);
      this.options.supervisor.cards.hostCards.withdrawHostCard(
        FIRSTMATE_MOVE_BACK_CARD_ID,
        "account removed",
      );
      return;
    }
    const back = !flagship.pause(movedFrom.accountId);
    if (back && !movedFrom.offered) {
      const label = flagship.labelOf(movedFrom.accountId) ?? movedFrom.accountId;
      const providerName = flagship.providerNameOf(movedFrom.providerId);
      const current = this.boundSeat ? this.providerNameOf(this.boundSeat.provider) : undefined;
      this.options.settings.setFirstmateMovedFrom({ ...movedFrom, offered: true });
      flagship.record("move-back-offered", movedFrom.accountId, [
        `${label}: no longer ${movedFrom.class}`,
      ]);
      this.options.broadcastEvent({
        type: "firstmate_note",
        text: `${label} can serve your first mate again.`,
      });
      this.options.supervisor.cards.hostCards.addFirstmateMoveBackCard({
        providerId: movedFrom.providerId,
        providerName,
        body: `${label} can serve your first mate again.${
          current ? ` Your first mate stays on ${current} until you choose.` : ""
        }`,
      });
    } else if (!back && movedFrom.offered) {
      // It stopped serving again before the captain chose: the offer is stale.
      this.options.settings.setFirstmateMovedFrom({ ...movedFrom, offered: false });
      this.options.supervisor.cards.hostCards.withdrawHostCard(
        FIRSTMATE_MOVE_BACK_CARD_ID,
        "stopped serving",
      );
    }
  }

  private seatAccount(): string | undefined {
    return this.boundAccountId ?? this.options.settings.getFirstmateAccount() ?? undefined;
  }

  /**
   * The refused card's "Try again" (W1 S9): the captain's word clears the
   * refusal (S7's clearing), the pause cards go, and the lane drains once -
   * the waiting rows are due now, so that drain is the attempt. A turn that
   * is refused again pauses again; nothing tries on its own. The spent
   * allowance's card offers the same attempt once the captain's recheck
   * read it unchanged.
   */
  tryAgain(arg: string): void {
    const flagship = this.options.flagship;
    if (!flagship) return;
    const attempt = spentAttemptOf(arg);
    const accountId = attempt ?? arg;
    // On a spent allowance, trying again is reading it again; the attempt
    // the card offers once a reading saw no change goes by the provider's
    // answer instead (`Flagship.tryPastSpent`).
    if (flagship.pause(accountId)?.class === "no_headroom") {
      if (attempt === undefined) {
        void this.recheckAllowance({ fromCard: true });
        return;
      }
      this.attemptOffered = undefined;
      flagship.tryPastSpent(accountId);
    } else flagship.tryAgain(accountId);
    if (this.paused?.accountId === accountId) this.paused = undefined;
    this.options.supervisor.cards.hostCards.withdrawFirstmatePauseCards("trying again");
    this.options.inbox.endOutage(FIRSTMATE_RECIPIENT);
    void this.host.drain();
  }

  /**
   * A run-out card's "Keep going on credits" (docs/quota.md): the account's
   * switch goes on, which reads the last snapshot again with it; a seat
   * paused on that spent allowance then serves again and its card goes.
   */
  keepGoingOnCredits(accountId: string): void {
    this.options.keepGoingOnCredits?.(accountId);
    this.options.flagship?.record("keep-going-on-credits", accountId, [
      "the captain chose to keep going on credits",
    ]);
    this.checkSeat();
    void this.host.drain();
  }

  /**
   * The captain's Recheck allowance (the spent-allowance card, Settings'
   * Refresh, command search): one at a time, and a second ask shares the
   * one running. While it runs the card says so and offers no second
   * recheck; then the seat reads its way back - serving again closes the
   * card and the kept messages go, once, through the inbox - and a seat
   * still paused gets its card back with what the reading said.
   */
  recheckAllowance(options: { fromCard?: boolean } = {}): Promise<QuotaSnapshotView | undefined> {
    // The card's own click closed it: the card comes back, saying it checks.
    // A recheck from elsewhere revises a card that is up and raises none.
    if (options.fromCard) this.recheckRaises = true;
    this.recheck ??= this.runRecheck().finally(() => {
      this.recheck = undefined;
    });
    if (options.fromCard) this.showSpentAllowanceCard();
    return this.recheck;
  }

  private recheck: Promise<QuotaSnapshotView | undefined> | undefined;

  /** A recheck is running: the pause card says so. */
  private rechecking = false;

  /** The running recheck came from the card, so its card comes back. */
  private recheckRaises = false;

  /** The account whose card offers one attempt: the captain's recheck saw it still spent. */
  private attemptOffered: string | undefined;

  /** Whether the pause card offers the attempt in place of another recheck. */
  private offersAttempt(accountId: string, pause: SeatPause): boolean {
    return pause.class === "no_headroom" && !this.rechecking && this.attemptOffered === accountId;
  }

  private async runRecheck(): Promise<QuotaSnapshotView | undefined> {
    this.rechecking = true;
    this.showSpentAllowanceCard();
    try {
      return await this.options.recheckAllowance?.();
    } finally {
      this.rechecking = false;
      this.checkSeat();
      // The captain's own recheck read the allowance spent again: the card
      // offers one attempt, for a sign-in the reading does not see.
      const paused = this.paused;
      if (this.recheckRaises && paused?.class === "no_headroom")
        this.attemptOffered = paused.accountId;
      this.showSpentAllowanceCard();
      this.recheckRaises = false;
      void this.host.drain();
    }
  }

  private showSpentAllowanceCard(): void {
    const flagship = this.options.flagship;
    const paused = this.paused;
    if (!flagship || paused?.class !== "no_headroom") return;
    const pause = flagship.pause(paused.accountId);
    if (pause?.class !== "no_headroom") return;
    this.options.supervisor.cards.hostCards.addFirstmatePauseCard(
      this.pauseCard(paused.accountId, pause),
      {
        reviseOnly: !this.recheckRaises,
      },
    );
  }

  /**
   * A sign-in or sign-out is about to rewrite an account's store (W1 S9):
   * the seat stays off that account until the returned release, and a
   * client holding its store lets go first - at an idle boundary, never
   * mid-turn, so this waits out a running turn. The release drains.
   */
  async holdSeatFor(accountId: string): Promise<() => void> {
    this.storeHolds.set(accountId, (this.storeHolds.get(accountId) ?? 0) + 1);
    if (this.boundAccountId === accountId) await this.session?.detach();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.storeHolds.get(accountId) ?? 1) - 1;
      if (left > 0) this.storeHolds.set(accountId, left);
      else this.storeHolds.delete(accountId);
      void this.host.drain();
    };
  }

  /**
   * The move, on the captain's click (rung 2, or the way back): pick the
   * target provider's best model and account, persist both, and rebind at
   * an idle boundary - any provider, either backend. A move off a paused
   * account remembers where the seat was, so the way back can ask; a move
   * back forgets it. The attachment that carries it out tells its first
   * turn (`announceMove`).
   */
  async moveFlagship(providerId: string): Promise<void> {
    const model = deriveModelForProvider(this.options, providerId);
    if (!model) {
      this.raiseTurnFailureCard(`No signed-in model is available on that subscription.`);
      return;
    }
    const flagship = this.options.flagship;
    const accountId = flagship?.deriveForProvider(providerId);
    const fromAccount = this.boundAccountId;
    const fromProvider =
      (fromAccount ? flagship?.providerOf(fromAccount) : undefined) ?? this.boundSeat?.provider;
    const pause = fromAccount ? flagship?.pause(fromAccount) : undefined;
    const movedFrom = this.options.settings.getFirstmateMovedFrom();
    if (movedFrom?.providerId === providerId) {
      this.options.settings.setFirstmateMovedFrom(null);
    } else if (fromAccount && fromProvider && fromProvider !== providerId && pause) {
      this.options.settings.setFirstmateMovedFrom({
        providerId: fromProvider,
        accountId: fromAccount,
        class: pause.class,
      });
    }
    flagship?.record("moved", accountId ?? null, [
      `from ${fromProvider ?? "no provider"}${pause ? `: ${pause.class}` : ""}`,
      "the captain chose it on the card",
    ]);
    if (this.boundSeat) {
      this.pendingMove = {
        from: {
          provider: this.providerNameOf(this.boundSeat.provider),
          model: this.boundSeat.model,
        },
        fromIdentity: this.boundSeat.identity,
        ...(pause ? { reason: pause.class } : {}),
      };
    }
    this.paused = undefined;
    this.options.supervisor.cards.hostCards.withdrawFirstmatePauseCards("moved");
    this.options.supervisor.cards.hostCards.withdrawHostCard(FIRSTMATE_MOVE_BACK_CARD_ID, "moved");
    this.options.settings.setFirstmateBinding(model, accountId ?? null);
    // Rows held for the account the seat leaves (a spent allowance's reset)
    // are due on the seat it goes to.
    this.options.inbox.endOutage(FIRSTMATE_RECIPIENT);
    if (this.host.running() || this.session?.isStreaming()) return; // applies at the next idle boundary
    this.detach();
    const session = await this.ensureSession();
    if (session) void this.host.drain();
  }

  /** Local preflight's chosen model, or its normal initial Auto choice; never opens a session. */
  preflightModel(): { provider: string; id: string } | undefined {
    return preflightModel(this.options, this.localSeat);
  }

  /**
   * Whether a typed cut-off on this seat is the ladder's to answer: the
   * seat is bound to an account the cut-off is recorded on. Otherwise (the
   * base runtime, the local seat) the turn fails the ordinary way.
   */
  pausesOnCutOff(): boolean {
    return Boolean(
      this.options.flagship && this.options.noteCutOff && this.boundAccountId && !this.boundLocal,
    );
  }

  /** Whether the bound account, as the cut-off just left it, pauses the seat. */
  pausesNow(): boolean {
    const accountId = this.boundAccountId;
    return Boolean(accountId && this.options.flagship?.pause(accountId));
  }

  /** Auth-vs-generic dispatch for every failure channel (create, throw, provider). */
  raiseSessionFailureCard(message: string): void {
    if (isAuthFailureMessage(message) || message.includes("No signed-in model")) {
      const account = this.seatAccount();
      const access = account ? this.options.flagship?.accessOf(account) : undefined;
      this.options.supervisor.cards.hostCards.addAuthDecisionCard(
        AUTH_CARD_ID,
        "firstmate",
        this.signInCardBody(),
        access ? { access } : undefined,
      );
      return;
    }
    this.raiseTurnFailureCard(formatFlagshipError(this.session?.modelRef(), message));
  }

  /**
   * The sign-in card's body, in product words from what the host knows - the
   * seat's provider and connection - and never the failure's own text: Pi's
   * adds its terminal sign-in instructions and paths into the app's files.
   * The raw text stays on the turn's own records (its ask and decision
   * rows). A crewmate's card says it the same way
   * (`CrewTurns.signInCardBody`): a custom connection is named, with the
   * way to check it again, since a sign-in is not what it needs. With no
   * provider to name, it lists the ones that can serve Firstmate.
   */
  private signInCardBody(): string {
    const account = this.seatAccount();
    const flagship = this.options.flagship;
    // The session's own provider while it knows one the app offers, else
    // the chosen model's - a Pi session whose custom connection has no
    // runtime reads "unknown", and a create that failed has no session. A
    // dev checkout's local seat is none of them, so it names nothing.
    const candidates: (string | undefined)[] = this.localSeat
      ? []
      : [
          this.session?.modelRef()?.provider,
          this.options.settings.getFirstmateModel()?.provider,
          account ? flagship?.providerOf(account) : undefined,
        ];
    const provider = candidates.find(
      (id) => id !== undefined && (isCustomApiProvider(id) || catalogEntry(id) !== undefined),
    );
    if (provider && isCustomApiProvider(provider)) {
      const label =
        account && flagship?.providerOf(account) === provider
          ? flagship.labelOf(account)
          : undefined;
      const connection = label ? `${label}, your custom connection` : "its custom connection";
      return `Your first mate could not reach ${connection}. In Settings → Intelligence, press Edit on ${label ? "it" : "that connection"}, then Save to check it again.`;
    }
    // Claude access set up for Claude Code is renewed where the person
    // renews it for Claude Code, never with a sign-in here.
    const access = account ? flagship?.accessOf(account) : undefined;
    if (access) return claudeAccessRefusedText("Your first mate", access);
    const name = provider ? catalogEntry(provider)?.name : undefined;
    return name
      ? `Your first mate could not reach ${name}, which needs you to sign in again.`
      : FIRSTMATE_NO_PROVIDER_SIGN_IN_WORDS;
  }

  raiseTurnFailureCard(message: string): void {
    // The agent-down set (ruling D6): a host card under a stable id, so
    // repeated failures (a provider outage across several turns) revise
    // one card in place instead of stacking copies.
    const body = this.runawayRefused
      ? `${message}\n\nFirstmate will not try again until you press Retry.`
      : message;
    this.options.supervisor.cards.hostCards.addFirstmateFailureCard(body);
  }

  /**
   * Last-resort safety net for a pinned reasoning flagship: after repeated
   * max_time_limit / token-generation failures, refuse the next idle turn
   * instead of hanging again. Retry (or a clean turn) clears it. Never
   * changes the captain's chosen default flagship.
   */
  noteRunaway(error: string): void {
    if (!isRunawayProviderError(error)) {
      this.runawayStreak = 0;
      return;
    }
    this.runawayStreak += 1;
    if (this.runawayStreak >= RUNAWAY_REFUSE_AFTER) {
      this.runawayRefused = true;
    }
  }

  /** A custom connection is removed without changing the saved seat choice. */
  async disconnectAccount(accountId: string): Promise<void> {
    if (this.seatAccount() !== accountId) return;
    await this.session?.abort(
      "This connection was disconnected. Choose a connection in Intelligence.",
    );
    this.session?.dispose();
    this.session = undefined;
  }
}
