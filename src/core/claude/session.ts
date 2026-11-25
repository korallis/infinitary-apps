import { randomUUID } from "node:crypto";
import type { AccountBinding } from "../accounts/accountBackend";
import { hostEnv, withTaskShell } from "../hostEnv";
import { TICK_PERIOD_MS } from "../orchestrator/ticker";
import type { SessionClock } from "../session/bounds";
import {
  admits,
  LOCAL_MACHINE_ID,
  type ModelSession,
  type SessionFactory,
  type SessionSpec,
} from "../session/session";
import { SessionRecordStore } from "../storage/sessionRecordStore";
import { assertClaudeWorkSettings } from "./claudeAccess";
import { ClaudeCostReports } from "./claudeCostReports";
import { withCrewShell } from "./claudeCrewShell";
import { ClaudeOneShotSession } from "./claudeOneShotSession";
import {
  CLAUDE_CONTROL_PROFILE,
  type ClaudeSessionDeps,
  claudeLoginStore,
  noteTo,
  refuseMissingClient,
} from "./claudeQueryCore";
import { defaultClaudeConfigDir } from "./claudeQuota";
import { ClaudeRollingSession } from "./claudeRollingSession";
import { acquireSessionLease } from "./claudeStoreLease";
import { ClaudeTranscriptLookup } from "./claudeTranscript";

/**
 * Claude's implementation of the one session contract
 * (`src/core/session/`): the only place a Claude session is built from a
 * `SessionSpec`, on the machine's own client. It serves the three roles'
 * shapes with two classes: a rolling session - the Firstmate seat's with no
 * built-ins (W1 S6), the crewmate's with the client's own coding set - and
 * the adapted decision model's one-shot question (W1 S10).
 *
 * Every Claude session runs its account's login - the machine's default
 * one, or a further login's own folder - or, for the default login, the
 * token command an organization or the person set up for Claude Code with
 * its address (`claudeAccess.ts`, as flag settings), and nothing ambient
 * (`claudeEnvFor`), nothing else of the person's own Claude setup
 * (`settingSources: []`, `strictMcpConfig: true`, and the client's auto
 * memory off: `CLAUDE_SESSION_ENV`) but a gateway's custom headers beside
 * the address and a company's usage reporting, which the app's receiver
 * passes on (`claudeReporting.ts`), no built-in tool unless the spec asks
 * for the coding set - which also brings its working copy's own instruction
 * file and skills (`claudeProjectResources.ts`) and turns the client's
 * commit and pull request attribution off (`CLAUDE_CODING_SETTINGS`) - and
 * the spec's tools served always-load by the app's own in-process server,
 * spoken by their bare names. Nothing here is emulated: Claude's
 * streaming-input mode gives native mid-turn steer, a turn-granular
 * `interrupt()`, live deltas and resume by id. The shapes differ in what the
 * spec asks for:
 *
 * - A one-shot is ONE query: the spec's base instruction as the only system
 *   prompt the app supplies (the client adds its own identity line, and a
 *   date reminder to the user message), the question as one user message,
 *   and one answer read off it. `maxTurns` bounds the agent's turns, not the
 *   client's requests: an answer the output cap cut short would be asked
 *   for again, up to three more times, by the client's own recovery. The
 *   first answer is the one read - cut short or not, as Pi reads it - and
 *   the client is stopped before it can ask again. No transcript
 *   (`persistSession: false`), and the account's shared store lease held for
 *   the session's whole life, so a renewal never races the client over its
 *   single-use refresh token. The spec's request bounds apply in the
 *   client's own terms: an explicit output cap as
 *   `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, the model-turn cap as `maxTurns`. An
 *   explicit cap at or under the legacy thinking floor requests thinking
 *   disabled, but newer models need not honor it. The question preset
 *   therefore leaves Claude's output allowance to its client: Sonnet 5.5
 *   can consume a small cap entirely in hidden thinking (INF-1451). The
 *   adapter still bounds the whole question with its own wall clock.
 * - A rolling session keeps one conversation across prompts, steers and
 *   client attachments. With no built-ins its prompt is the spec's base,
 *   the dynamic boundary and the captain's served text; with the coding set
 *   it is the client's own coding preset with the base appended. Its rules
 *   are measured against the real client and pinned by
 *   `claudeFirstmateSession.integration.test.ts` and
 *   `claudeSession.integration.test.ts`:
 *   - A steer rides `priority: "next"`. On the pinned client that folds the
 *     message into the running turn at its next step, after the in-flight
 *     tool's result, and the exchange ends in ONE result - Pi's steer. `now`
 *     aborts the tool in flight (its result becomes an error the model
 *     reads) and answers in a second turn; `later` waits for the turn to end.
 *   - A prompt settles when the client says its session is idle
 *     (`session_state_changed`, turned on by
 *     `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`): after every turn the prompt
 *     and its steers started, however many results that took. Should a
 *     client ever stop saying so, a result with every pushed message
 *     acknowledged settles it instead.
 *   - Every pushed message carries a uuid and the client acknowledges each
 *     as a turn takes it in (`--replay-user-messages`), which is how the
 *     session knows a steer was delivered and where it landed. A steer no
 *     turn took in goes back to the owner (`takeUndeliveredSteers`).
 *   - The client works on its own too: a background command it started
 *     can finish after the prompt settled, and the client then runs a turn
 *     no prompt asked for. It says `running` before that turn and `idle`
 *     after it, which the session reports as a continuation
 *     (`continuation_started`, `continuation_ended`): the host-owned turn
 *     boundary its owner gives it. A steer joins a continuation as it joins
 *     a prompt.
 *
 *   Every rolling session's durable record is the app's own
 *   (`SessionRecordStore`, in the spec's record dir: the seat's
 *   `firstmate/claude/`, a crewmate's `crewmates/<task>/sessions/`): at
 *   every idle boundary, attach and exit, on each tick while its client
 *   is attached, and when the home's copy order requests a refresh, the
 *   session copies what the client appended to its own
 *   transcript, so the record outlives the client's 30-day sweep, and
 *   stamps the spec's contract, when it has one, in a sidecar. A resume
 *   reads the client's own file; when that is gone, the session starts
 *   fresh under a new id (and the app's copy of the old one stays). A
 *   resumed client serves the system prompt it recorded when the session
 *   started, and the tools it had then as they were described then, not
 *   the ones it is handed, so a session with a contract whose prompt array
 *   (or, where the contract fingerprints each tool, a tool it had, or
 *   which tools it has) changed since it started never resumes: it
 *   starts over under a new id with the new array, at open or at the idle
 *   boundary `serveInstructions` is, and
 *   says so once (`takeRenewal`). (Not
 *   the SDK's session store: resuming from it has the SDK read the
 *   person's credential and copy it into a temporary config dir, and the
 *   app never reads a provider token.) The account's
 *   store is leased per client attachment. The spec's request bounds apply
 *   in the client's own terms, as a one-shot's do: the output cap as
 *   `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, the model-turn cap as `maxTurns`.
 *   Measured on the pinned client and the installed 2.1.283 (decision D5),
 *   the cap reaches every request as `max_tokens` with the model's own
 *   thinking inside it (adaptive, or a budget one below the cap on Haiku),
 *   and an answer that runs past it is asked to carry on three times before
 *   the turn fails, which the session reports in its own words. The watched
 *   time bounds are not Claude's to keep: the one watcher on the host's
 *   clock (`session/bounds.ts`) cuts a turn with `abort(failure)`, and the
 *   session's own tick stops a client that does not answer that interrupt.
 *
 * A typed cut-off rides the `turn_failed` it produces (`cutOff`), which the
 * owner records on the account; the words the client said stay off the
 * owner's record. Like every Claude touchpoint it sits behind
 * `src/core/claude/`.
 */

/**
 * Claude's session factory. Refuses with the client's sentence when the
 * machine's client is gone or too old, before anything is leased, the way
 * every Claude touchpoint does.
 *
 * One registration on the host's clock brings every live rolling session's
 * record up to its client's transcript and stops a client that did not
 * exit or answer an interrupt, the way the quiet watchdog rides it; no
 * session owns a timer.
 */
/**
 * Where each Claude account's client runs, from the account's own binding:
 * a further login's folder, else the default one. An account the vault no
 * longer holds is refused, so a removed login's session never runs on the
 * default login.
 */
export function claudeLoginDirs(vault: {
  binding(accountId: string): AccountBinding;
}): Pick<ClaudeSessionDeps, "configDir" | "ownConfigDir"> {
  return {
    configDir: defaultClaudeConfigDir(),
    ownConfigDir: (accountId) => {
      const binding = vault.binding(accountId);
      return binding.via === "config-dir" ? binding.configDir : undefined;
    },
  };
}

export function createClaudeSessionFactory(deps: ClaudeSessionDeps): SessionFactory {
  deps = { ...deps, costReports: deps.costReports ?? new ClaudeCostReports() };
  const live = new Set<ClaudeRollingSession>();
  let unregisterTick: (() => void) | undefined;
  const track = (clock: SessionClock, session: ClaudeRollingSession) => {
    live.add(session);
    unregisterTick ??= clock.register("claude-sessions", TICK_PERIOD_MS, (now) => {
      for (const rolling of live) rolling.tick(now);
    });
  };
  const untrack = (session: ClaudeRollingSession) => {
    live.delete(session);
    if (live.size === 0) {
      unregisterTick?.();
      unregisterTick = undefined;
    }
  };
  // One store per record dir, so every session's stamps on it land in order.
  const stores = new Map<string, SessionRecordStore>();
  const records =
    deps.records ??
    ((dir: string) => {
      let store = stores.get(dir);
      if (!store) {
        store = new SessionRecordStore(dir);
        stores.set(dir, store);
      }
      return store;
    });

  const openRolling = async (
    spec: SessionSpec,
    record: Extract<SessionSpec["shape"], { turns: "rolling" }>["record"],
    accountId: string,
    clock: SessionClock,
    env: NodeJS.ProcessEnv,
  ): Promise<ModelSession> => {
    // The client resumes what it has recorded. An id it has no transcript
    // for (a crash before its first turn, or the client's own sweep) cannot
    // resume, so the session starts fresh under a new id rather than failing
    // every attach on a stale one; the app's copy of the old one stays.
    const requested = record.resume?.backend === "claude" ? record.resume.sessionId : undefined;
    const transcripts = new ClaudeTranscriptLookup(claudeLoginStore(deps, accountId).dir, spec.cwd);
    const recorded = requested !== undefined && (await transcripts.find(requested)) !== null;
    if (requested !== undefined && !recorded) {
      noteTo(deps)(`the client has no transcript for session ${requested}; starting fresh`);
    }
    // The session id is the app's, minted before the client starts, so the
    // owner records the real resumable id the moment the session attaches.
    const sessionId = recorded ? (requested as string) : randomUUID();
    // The store lease is per client, taken as each one attaches (`attach`).
    const session: ClaudeRollingSession = new ClaudeRollingSession(
      sessionId,
      spec,
      {
        accountId,
        env,
        store: records(record.dir),
        stamp: record.stamp,
        clock,
      },
      deps,
      () => untrack(session),
      transcripts,
    );
    // Resumed on a changed prompt array, the client would serve the old one.
    if (recorded) {
      session.renewIfChanged();
      await session.renewPersonalIfChanged();
      void session.readAhead();
    }
    await session.stampContract();
    track(clock, session);
    return session;
  };

  return {
    backend: "claude",
    controlProfile: CLAUDE_CONTROL_PROFILE,
    open: async (spec) => {
      if (spec.machine !== LOCAL_MACHINE_ID) {
        throw new Error(`A Claude session cannot run on machine ${spec.machine}.`);
      }
      const binding = spec.binding;
      if (binding.backend !== "claude") {
        throw new Error(`A Claude session cannot serve a ${binding.backend} binding.`);
      }
      if (!admits(CLAUDE_CONTROL_PROFILE, spec.needs)) {
        throw new Error("A Claude session cannot steer the way this session needs.");
      }
      if (spec.builtins === "coding" && spec.shape.turns !== "rolling") {
        throw new Error("A Claude session serves the coding built-ins on a rolling session only.");
      }
      const clock = deps.clock;
      if (spec.shape.turns === "rolling" && !clock) {
        throw new Error("A rolling Claude session needs the host's clock.");
      }
      // The session's own shell (its task's commands) rides the client's
      // environment, so every command the client runs carries it, through
      // the program that names each command's shell to the task channel.
      const env = withCrewShell(
        withTaskShell((deps.env ?? (() => hostEnv()))(), spec.shell),
        spec.shell,
      );
      // The machine's own client (F14): a session whose client is gone or too
      // old fails its open with the client's sentence, as any attach does.
      await refuseMissingClient(deps, env);
      await assertClaudeWorkSettings(deps.resolveWorkSettings);
      if (spec.shape.turns === "rolling" && clock) {
        return openRolling(spec, spec.shape.record, binding.accountId, clock, env);
      }
      // Held for the session's life: the client refreshes its own login
      // inside the run, and the refresh token behind it is single use.
      const store = claudeLoginStore(deps, binding.accountId);
      const release = await acquireSessionLease(store.dir);
      // The person's own token command and address are their default
      // login's; a further login signs in only with its own folder.
      const access = store.own ? undefined : await deps.accessSettings?.().catch(() => undefined);
      return new ClaudeOneShotSession(
        spec,
        binding.accountId,
        env,
        deps,
        release,
        access,
        store.own ? store.dir : undefined,
      );
    },
  };
}
