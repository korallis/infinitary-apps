import type { CutOffClass } from "@shared/authFailure";
import { HERE } from "@shared/deviceNames";
import { FIRSTMATE_SESSION_ID } from "@shared/observe";
import type { AppPaths } from "../paths";
import {
  buildFirstmateSystemPrompt,
  FIRSTMATE_CONTRACT_VERSION,
  firstmatePromptSha,
  toolFingerprints,
  toolsFingerprint,
} from "../pi/piResources";
import { SESSION_COMPACTION } from "../session/compaction";
import {
  type ContractStamp,
  LOCAL_MACHINE_ID,
  type SessionBinding,
  type SessionResume,
  type SessionSpec,
} from "../session/session";
import type { BoundTool } from "../session/tools";

/**
 * The Firstmate seat (docs/architecture.md section 2): the Firstmate's role
 * on the one session contract (`src/core/session/`). The seat is a preset -
 * `seatSessionSpec` - and nothing else: the agent opens it through whichever
 * backend's `SessionFactory` the binding names, and every other consumer
 * (decision capture, the replay) reads only the contract. The seat's own
 * knowledge lives here - its prompt and contract stamp, its runaway bounds,
 * its thinking levels - so a backend only ever persists and applies what the
 * spec hands it, and which backend served a turn is a fact the binding
 * carries, never one a consumer reads off an event.
 */

/**
 * Thinking level per wake kind (interaction P1 WI-13, captain ruling D5):
 * judgment where the captain is watching, speed where nobody is. A captain
 * turn (`inf:converse`) runs at medium; an `[fm-op]` drain stays at low, the
 * seat's own default. Each backend maps the level onto its own effort knob.
 */
export const FIRSTMATE_CAPTAIN_THINKING_LEVEL = "medium" as const;
export const FIRSTMATE_OPERATIONAL_THINKING_LEVEL = "low" as const;

export type FirstmateThinkingLevel =
  | typeof FIRSTMATE_CAPTAIN_THINKING_LEVEL
  | typeof FIRSTMATE_OPERATIONAL_THINKING_LEVEL;

/**
 * Hard wall-clock abort of ONE uninterrupted Firstmate inference. A request
 * runs from the prompt / a model request's start / the last tool's end
 * until the next tool starts; a tool in flight stops the clock. This is not
 * a user-facing Firstmate abort (inf:firstmate:abort stays absent). The one
 * watcher checks it on the host's ticker for both backends
 * (`session/bounds.ts`), so it fires between 300 and 360 seconds in, and
 * cuts the turn with `abort(failure)`.
 *
 * 300 seconds: a cards-only `low` reasoning step is usually well under a
 * minute, but a legitimately long single inference can exceed 90s. The
 * 2026-09-03 runaway streamed ~280k thinking tokens for ~60 minutes in a
 * single inference; 300s is ~4x tighter than the 20-minute whole-turn
 * backstop and ~12x tighter than xAI's max_time_limit, without clipping
 * a busy multi-tool turn whose each request stays short. Pi's
 * openai-responses driver does not fill usage.reasoning until the
 * request finalizes, so a live token count is not available on grok-4.6
 * - wall-clock is the tightest per-request signal the stream actually
 * exposes (request boundaries via message_start / tool_execution_* /
 * turn_end; thinking_delta is text, not tokens).
 */
export const FIRSTMATE_REQUEST_TIMEOUT_MS = 300_000;

/**
 * Last-resort wall-clock abort of one Firstmate prompt() still open
 * after 20 minutes. The per-request bound is what stops a runaway
 * inference; this backstop covers the complementary case where the
 * request clock is cleared (tools in flight) and something never
 * returns. It does not subsume the per-request bound - a 20-minute
 * multi-tool turn of short requests is allowed.
 */
export const FIRSTMATE_TURN_TIMEOUT_MS = 20 * 60_000;

/**
 * Output cap per assistant message (captain call, paired with the brief
 * turn close). The orchestrator's output is thinking plus short tool
 * calls - cards-only, no long prose - so a message anywhere near this
 * bound is degenerate: the grok silence loop ran 21 minutes to the model's
 * own cap while the captain's input sat queued behind it. Each step of a
 * multi-step turn gets a fresh budget, so legitimate work is unaffected.
 *
 * Pi's openai-responses driver DOES send this as max_output_tokens, but
 * xAI does not apply that field to reasoning tokens - grok-4.6 still
 * generated ~280k thinking tokens under this cap (2026-09-03 dogfood).
 * The real reasoning bound is the operational thinking level plus the
 * per-request abort; this cap still bounds visible output / non-reasoning
 * flagships. Claude's client serves it as the request's `max_tokens`, with
 * the seat's thinking inside it (decision D5, measured 2026-09-27: the
 * Firstmate's 366 real replies on Pi ran at most 571 output tokens, and
 * the client asks the model to carry on three times before it fails a
 * turn whose answer runs past the cap).
 */
export const FIRSTMATE_MAX_OUTPUT_TOKENS = 8192;

/**
 * How many model round trips one prompt may take. A Firstmate turn is a
 * few typed tool calls - the real ones take at most five (decision D5,
 * measured 2026-09-27 over 202 recorded prompts) - so forty is far past any
 * of them and bounds a loop that never closes. Claude applies it as the
 * client's `maxTurns`; Pi counts its own turns and stops the loop at the
 * cap, both after the last reply's tools have run.
 */
export const FIRSTMATE_MAX_MODEL_TURNS = 40;

/** Provider-side retries of one request (Pi's knob; the Claude client keeps its own). */
export const FIRSTMATE_RETRIES = 2;

export type SeatBinding = SessionBinding;

export type SeatBackend = SeatBinding["backend"];

/**
 * Why the seat's account cannot serve the next turn, as a class the ladder
 * and its cards read (docs/architecture.md §16 "A paused seat"): the three
 * cut-off classes, no client on this machine to run it, or no account at
 * all (removed, paused, or one the seat cannot stand on).
 */
export type SeatPauseClass = CutOffClass | "client" | "unavailable";

/** A paused seat's class, with a spent allowance's reset when it is known. */
export type SeatPause = { class: SeatPauseClass; resetsAt?: number };

/**
 * The saved line for a captain message a paused seat keeps (FI3-592;
 * docs/architecture.md §16 "A paused seat"): that it is saved, what stopped
 * the seat - `sentence` is `Flagship.pauseSentence` - and the way back that
 * still reaches the captain once he has closed the pause card: the class's
 * own fact, or another model for Firstmate in Settings. `access` is a lost
 * sign-in on Claude access set up for Claude Code, renewed where Claude
 * Code's is.
 */
export function keptMessageWords(
  sentence: string,
  pause: SeatPauseClass,
  provider: string,
  access?: boolean,
): string {
  const wayBack: Record<SeatPauseClass, string> = {
    no_headroom: "Your first mate answers it when the allowance resets",
    signed_out: access
      ? "Your first mate answers it once that sign-in is renewed"
      : "Your first mate answers it once you sign in again",
    refused: `Your first mate answers it once ${provider} answers again`,
    client: `Your first mate answers it once ${provider} can run on ${HERE.this}`,
    unavailable: "Your first mate answers it once an account can run it",
  };
  return `Your message is saved. ${sentence} ${wayBack[pause]}, or choose another model for your first mate in Settings, under Intelligence.`;
}

/** A lost sign-in, in `Flagship.pauseSentence`'s words: the account by its label. */
export function signedOutSentence(label: string): string {
  return `${label} needs you to sign in again.`;
}

/**
 * A spent allowance, in `Flagship.pauseSentence`'s words up to the reset
 * it names when one is known: the account by its label.
 */
export function allowanceSpentWords(label: string): string {
  return `${label} has used up its allowance`;
}

/** The spent-allowance card's line while the captain's recheck runs. */
export const ALLOWANCE_CHECKING_WORDS = "Checking its allowance now.";

/**
 * The spent-allowance card's line on its last reading: when it was taken
 * and who the account's client says is signed in, or that it could not be
 * taken - never that the allowance is still spent.
 */
export function allowanceCheckedWords(
  reading: { read: true; time: string; identity?: string } | { read: false; time?: string },
): string {
  if (!reading.read)
    return `Its allowance could not be read just now${
      reading.time ? `; last read at ${reading.time}` : ""
    }.`;
  return `Checked at ${reading.time}${reading.identity ? `, signed in as ${reading.identity}` : ""}.`;
}

/**
 * The feed line a fresh pause writes (docs/architecture.md §16 "A paused
 * seat"): a refusal says the provider stopped answering and the words are
 * kept; any other pause says what stopped the seat - `sentence` is
 * `Flagship.pauseSentence`.
 */
export function seatPausedLine(pause: SeatPauseClass, sentence: string, provider: string): string {
  return pause === "refused"
    ? `${provider} is not answering your first mate right now; your messages are kept.`
    : `Your first mate paused: ${sentence}`;
}

/**
 * The feed line once the seat runs somewhere new (`FirstmateAgent`'s
 * announced move): where Firstmate went, or, when its instructions changed,
 * that it carries on in a new conversation there.
 */
export function seatMovedLine(
  to: { provider: string; model: string },
  reason?: SeatPauseClass | "instructions",
): string {
  return reason === "instructions"
    ? `Your first mate's instructions changed, so it carries on in a new conversation on ${to.provider} (${to.model}).`
    : `Your first mate moved to ${to.provider} (${to.model}).`;
}

/** The instructions text and its sha (`instructions_sha` in the contract entry). */
export type ServedInstructions = { text: string; sha: string };

/** One served user message, located in the session's own record. */
export type ServedMessage = {
  /** sha256 of the message text exactly as the model received it. */
  textSha256: string;
  /** The session entry the backend wrote for it; null when it never reached the record. */
  entryId: string | null;
  /** The entry it follows: the tip of the effective prefix. */
  parentEntryId: string | null;
};

export type ServedState = {
  sessionFile: string | null;
  /** The prompt; null when the turn failed before the model saw it. */
  prompt:
    | (ServedMessage & {
        /**
         * The live context the prompt was appended to - after compaction and
         * after any failed-turn thinking was stripped, so it is what the model
         * was actually sent, not a rebuild of the file. System prompt and
         * tools are fingerprinted by the contract instead. Null when the
         * backend's record does not hold the prompt yet (a Claude client
         * writes its transcript on its own schedule).
         */
        prefix: { messageCount: number; sha256: string } | null;
      })
    | null;
  steers: ServedMessage[];
};

/**
 * The contract that serves the seat, as its record stamps it: the contract
 * revision, the byte-stable prompt's sha, the tool surface's fingerprint
 * and each tool's own sha. A Claude client resumes the seat's session on
 * the tools it recorded at its start, as they were described then, so an
 * update that reworded, added or removed a tool starts the session over
 * (`renewIfChanged`).
 * The captain's served text is stamped beside it by the backend
 * (`instructions_sha`), so it never moves the trainable contract.
 */
export function firstmateContractStamp(
  tools: readonly BoundTool[],
  backend: SeatBackend = "pi",
): ContractStamp {
  return {
    version: FIRSTMATE_CONTRACT_VERSION,
    promptSha: firstmatePromptSha(backend),
    toolsSha: toolsFingerprint(tools),
    tools: toolFingerprints(tools),
  };
}

export type SeatSessionInput = {
  paths: Pick<AppPaths, "firstmateHomeDir" | "firstmateSessionsDir" | "firstmateClaudeDir">;
  /** Which backend serves the seat, and on what (`Flagship.resolveBinding`, or the dev local seat). */
  binding: SeatBinding;
  /** The fixed orchestrator model (captain decision Q2). */
  model: { provider: string; id: string };
  /**
   * The closed tool surface: cards, crew operations, and typed lookups, as
   * the one tool spec's bound tools. Each backend's factory generates its
   * own tools from them.
   */
  tools: readonly BoundTool[];
  /** The captain-owned instructions served after the prompt (docs/sequences.md); absent serves none. */
  instructions?: ServedInstructions;
  resume?: SessionResume;
  /** The summary rule, read live (Settings → Intelligence); absent is the app's own. */
  compaction?: SessionSpec["compaction"];
};

/**
 * The Firstmate seat as a session: one rolling session in the neutral
 * firstmate home - never a project - whose whole surface is the app's own
 * typed tools (no built-in at all: no bash, no direct file reads), on the
 * byte-stable Firstmate prompt with the captain's text served after it, at
 * the operational thinking level that each captain turn raises for that
 * turn only (WI-13). Its record is the binding backend's own: Pi's rolling
 * file under `firstmate/sessions`, or the app's copy of the Claude client's
 * transcript under `firstmate/claude` (the one reader tells the two apart
 * by a file's first line, never its path). Its turns are steered, never
 * queued, so it needs a backend that steers natively.
 */
export function seatSessionSpec(input: SeatSessionInput): SessionSpec {
  const { paths, binding, tools } = input;
  return {
    machine: LOCAL_MACHINE_ID,
    owner: FIRSTMATE_SESSION_ID,
    cwd: paths.firstmateHomeDir,
    binding,
    model: input.model,
    thinking: { level: FIRSTMATE_OPERATIONAL_THINKING_LEVEL, perTurn: true },
    instructions: {
      base: buildFirstmateSystemPrompt(binding.backend),
      ...(input.instructions ? { served: input.instructions } : {}),
    },
    builtins: "none",
    tools,
    shape: {
      turns: "rolling",
      record: {
        dir: binding.backend === "claude" ? paths.firstmateClaudeDir : paths.firstmateSessionsDir,
        ...(input.resume ? { resume: input.resume } : {}),
        stamp: firstmateContractStamp(tools, binding.backend),
      },
    },
    bounds: {
      watched: {
        requestTimeoutMs: FIRSTMATE_REQUEST_TIMEOUT_MS,
        turnTimeoutMs: FIRSTMATE_TURN_TIMEOUT_MS,
      },
      request: {
        maxOutputTokens: FIRSTMATE_MAX_OUTPUT_TOKENS,
        maxModelTurns: FIRSTMATE_MAX_MODEL_TURNS,
        retries: FIRSTMATE_RETRIES,
      },
    },
    compaction: input.compaction ?? SESSION_COMPACTION,
    needs: { steer: "native" },
  };
}

/**
 * Hard output bound per decision, whichever backend answers it. One word
 * plus whatever punctuation a model insists on; anything that needs more
 * than this is not an answer to the question asked.
 */
export const CLASSIFIER_MAX_OUTPUT_TOKENS = 64;
