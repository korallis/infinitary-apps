# First mate flagship runaway hardening

The first mate flagship is the captain's persisted model (`SettingsStore.getFirstmateModel`), or the subscription-derived default `resolveModel` picks once and stores.
A runaway refusal does not change that choice.
Bound the model's reasoning around the close; do not add `inf:firstmate:abort`.

Pi bounds the seat's reasoning with `thinkingLevel` (`FIRSTMATE_OPERATIONAL_THINKING_LEVEL`, sent as `reasoning.effort`).
It does not apply `max_output_tokens` or idle timeouts to a live thinking stream, and `usage.reasoning` arrives only when the request ends.

## Abort granularity

A whole-turn wall-clock cap is too blunt for this runaway: it has to be loose enough for a legitimate multi-tool turn, so a single stuck inference can still burn the full window, and a genuinely long turn can be clipped.
The runaway this bound was sized for is one model inference that will not stop (a grok-4.6 stream of about 280k thinking tokens in one request, when that model was the flagship).
Cap that inference.

Both backends' event streams *do* expose request boundaries, and each session says so as `request_started` (Pi at an assistant `message_start` or a compaction's start, Claude at each request's `message_start`).
A request runs from `prompt()` / a `request_started` / the last `tool_end` (all in-flight tools at 0) until the next `tool_start`, so the bound tracks the live inference, not the gap after a tool result.
Parallel tools keep the clock stopped until the last result; the backend's own housekeeping (compaction, a retry) does not stop it.

The tightest per-request signal available is **wall-clock**, not a reasoning-token count: openai-responses does not increment `usage.reasoning` until the request ends, which is exactly when a runaway has already happened.
300 seconds (`FIRSTMATE_REQUEST_TIMEOUT_MS`) is several times a normal cards-only `low` reasoning step, still enough headroom for a legitimately long single inference, and ~4x tighter than the 20-minute whole-turn backstop / ~12x tighter than xAI's 60-minute `max_time_limit`.

The whole-turn cap stays as a **loose last-resort backstop** at 20 minutes (`FIRSTMATE_TURN_TIMEOUT_MS`).
It does not subsume the per-request bound: it covers the complementary case where the request clock is cleared (tools in flight) and something never returns.
A busy multi-tool turn of short requests is allowed.
(The consult and supervision sessions wrapped with both timeouts 0; both have since retired.)

## What this ship does

1. `FIRSTMATE_OPERATIONAL_THINKING_LEVEL = "low"`, the seat preset's thinking level (`seatSessionSpec`), on create and `setThinkingLevel` (resume cannot inherit medium/high).
2. `FIRSTMATE_REQUEST_TIMEOUT_MS` (300 seconds) cuts the turn internally when a single uninterrupted inference stays open.
   Reset at every request and tool boundary.
   `FIRSTMATE_TURN_TIMEOUT_MS` (20 minutes) is a last-resort backstop only.
   Both are kept by the one watcher on the host's clock, for either backend (below).
3. `stripFailedThinking` drops `type: "thinking"` from assistant messages with `stopReason` error/aborted, on resume and on failed `turn_end`.
   A turn the host cut reuses this path via `rewriteTimedOutTurn`.
4. Feed/card name the provider and full error (`Grok grok-4.6: Response incomplete: max_time_limit`).
   Auth classification still runs on the raw error.
5. After two consecutive `max_time_limit` / token-generation / request-or-turn-timeout failures, idle turns refuse until Retry.
   The captain's chosen flagship is not changed.

## The seat's bounds on both backends (one clock)

The seat keeps the same bounds whichever backend serves it (decision D5, one-session step 7).
The time bounds are the host's: one watcher (`src/core/session/bounds.ts`) wraps both session factories in the composition root, rides one `session-bounds` registration on the host's ticker while any watched session lives, and cuts a turn with the contract's `abort(failure)`, so both fire at the first tick after they are due (the 300-second bound between 300 and 360 s).
The request bounds are each backend's own, set from the spec's `bounds.request`.
Crewmates and the decision models' questions carry no time bound and none of the seat's request bounds.

| | Pi seat | Claude seat |
| --- | --- | --- |
| Effort | `FIRSTMATE_OPERATIONAL_THINKING_LEVEL` (`low`) on create and resume; a captain turn raises it for that turn | `effort: "low"` on every attachment; a captain turn raises it with `applyFlagSettings({effortLevel})`, which reaches the very next request |
| Per-inference bound (300 s) | the one watcher: restarted at each `request_started` and at the last tool's end, stopped while a tool runs; `abort(failure)` is Pi's `session.abort()` | the one watcher, the same clock; `abort(failure)` interrupts the client |
| Turn backstop (20 min) | the one watcher, from the prompt's start | the one watcher, from the prompt's start |
| The failed turn | `rewriteTimedOutTurn` turns the aborted (or, cut between requests, errored) `turn_end` into a `turn_failed` with the bound's sentence | the interrupted result becomes a `turn_failed` with the bound's sentence; a client that does not answer its interrupt within a tick is stopped and the turn fails anyway (the session's own `claude-sessions` tick, which also stops a client still running a tick after its input ended and keeps the transcript copy) |
| Model-turn cap (40) | Pi counts the prompt's answered model turns; at the 40th, if its reply asked for tools, they run and the turn ends with "Turn stopped after 40 model requests" | the client's `maxTurns: 40`, the same shape; its own words ("Reached maximum number of turns (40)") |
| Output cap (8,192) | `FIRSTMATE_MAX_OUTPUT_TOKENS` clamps `model.maxTokens` (xAI does not apply it to reasoning) | `CLAUDE_CODE_MAX_OUTPUT_TOKENS`: every request's `max_tokens`, with thinking inside it; the client asks an answer that runs past it to carry on three times, then fails the turn with a typed `max_output_tokens` error, reported as "Answer kept running past the 8192-token limit" |
| Failed-turn thinking | `stripFailedThinking` on resume and on a failed `turn_end` | the client's own hygiene (`resumed_from_incomplete_thinking`); nothing to strip host-side |
| Quiet watchdog | seat events at every delta, tool edge and turn end | the same events; a client silent from the first byte still yields `turn_failed` at worst 420 s in (the bound's tick, then a tick for a client that does not answer its interrupt), inside the 10-minute quiet line |

The repeated-runaway refusal (point 5 above) reads the error text the seat reports, so both backends' timeout sentences feed it unchanged.

## Close protocol

The turn ends with one plain sentence of about 40 characters saying what took effect, which the captain reads as the reply line beside their message (captain decision fm3000-firstmate-empty-turn-instruction, revised 2026-09-03; shown since INF-772, the captain's Approve and build, `docs/composer.md` "The last turn").
The exact token `done` is never required.
Empty output is not a close.
The turn ends on the model's natural stop; the host does not wait for a magic word.
Wording lives in `FIRSTMATE_PROMPT_CORE`.

Do not revert to "write nothing": the host cannot tell a completed empty turn from a live thinking stream until the provider stops.
`thinkingLevel: "low"` plus the 300-second per-request abort plus strip-plus-refuse caps a hang at two bounded inferences.

## Notes moved from AGENTS.md

Moved verbatim from `AGENTS.md` on 2026-09-24; `docs/README.md` lists this page.

- Failure visibility (captain fixes 2026-08-22, scout report fm3000-devmode-auth-message-s1): Pi RESOLVES a provider-failed turn (assistant `stopReason: "error"`) instead of throwing, so `piEvents.ts` maps it to the `turn_failed` FmEvent - the first mate routes it to the error/sign-in card, the supervisor reports it instead of "(no report)" and keeps the crewmate steerable, and `src/shared/feed.ts` gives it a feed line.
  Never remove that event or a failed turn goes silent again.
  A turn Pi recovers is not a failed turn: `PiRollingSession` holds a context overflow's `turn_end` until Pi says what it does next, drops it when a compaction ends ready to retry, and delivers it unchanged whenever Pi moves on without that retry.
  Auth classification lives ONLY in `src/shared/authFailure.ts`, keyed on real signal (401/403 in status positions, provider auth codes, Pi preflight text) - never substring-match arbitrary error or tool text ("token generation" and "authoritative" were real false positives).
- The first mate's own turn is bounded (captain decision fm3000-firstmate-empty-turn-instruction, revised 2026-09-03): the contract ends a turn with one short sentence, the reply line since INF-772 - never an empty turn ("write nothing" drove grok into a 21-minute silence loop) and never the exact token `done` (grok-4.6 fixated and looped on it).
  The turn still ends on the model's natural stop; the instruction just requires some brief output.
  `FIRSTMATE_OPERATIONAL_THINKING_LEVEL` (`low`) is the Pi-native effort Pi actually sends on openai-responses / xAI; `FIRSTMATE_MAX_OUTPUT_TOKENS` still clamps `model.maxTokens` but xAI does not apply `max_output_tokens` to reasoning (Pi gap).
  `PI_PROVIDER_TIMEOUT_MS` is Pi's `retry.provider.timeoutMs`; a continuously streaming thinking loop can ignore it, so `FIRSTMATE_REQUEST_TIMEOUT_MS` aborts one uninterrupted inference internally (not a user-facing `inf:firstmate:abort`; `FIRSTMATE_TURN_TIMEOUT_MS` is only a loose last-resort backstop).
  Error-turn thinking is stripped from live session state so it cannot poison the next prompt.
  Repeated `max_time_limit` / token-generation failures refuse the next idle turn until Retry; they do not change the captain's chosen flagship.
  The supervisor's shared tick still watchdogs through `checkQuiet` (feed line at 10 quiet minutes, informational card at 20).
  Pi gaps, abort granularity, and the reasoning bound: `docs/firstmate-runaway-hardening.md`.

## Conversation length

Every Pi conversation of the first mate and the crew, at home and on a computer that runs work, carries one automatic summary rule, which the person sets in Settings → Intelligence under "Summarize long conversations at" (`SummaryPointRow`, the `summary-point` setting).
Automatic, the default, is the app's own rule, `SESSION_COMPACTION`: it summarizes at 300,000 tokens (`SESSION_COMPACTION_TOKENS`), or before the context reaches a price step in the model's listed prices (`inputTokensAbove`), where every input token costs more, when that comes sooner.
A number (150,000, 200,000, 300,000 or 500,000) is a ceiling that wins over price steps (the captain's answer on INF-6693's plan), and the row names the models on the person's accounts that charge more past it (`priceSteps`, Copilot's left out); "Each model's limit" states no rule, so Pi's own trigger applies (`summaryCompaction`).
The first mate's seat and a crewmate at home read the setting at every prompt, so a changed point reaches a conversation already open at its next message; a Claude session takes it when it next attaches.
A crewmate's open on a computer that runs work carries the rule as it stands (`compaction`, `summary-point.md`), and a computer or home without that change keeps the app's own rule.
The row is a native select, one Tab stop whose arrows and first letters pick a point; it is chosen now and then, so it adds no command (`docs/keyboard.md`, "A new feature"), and the phone shows no such row.
Pi recomputes its reserve at every prompt boundary: the larger of its existing model budget and `contextWindow` less the lower of the two limits.
A smaller model keeps its earlier trigger, including the custom connection and local model budgets.
Pi's own compactor observes usage after a response and compacts when that count exceeds its trigger; this is not a hard per-request input cap.
Claude uses the app's flag settings and its own smaller-model clamp (`docs/claude-client.md`, "App-owned automatic compaction").
Below a price step, Pi's trigger sits at that step less Pi's own reserve, which leaves room for the incoming prompt and the error in Pi's estimate; Pi counts a turn's tool results before its next request.
Automatic takes the lowest step whose trigger sits a reserve above what a summary keeps (the instructions, tool schemas and Pi's kept turns); with none, or on Copilot, whose plan counts premium requests, only the 300,000 limit applies.
Pi's check before a prompt's first request leaves the new prompt out of its count, so one prompt larger than the reserve can still reach past the step once.
A large new message or tool result can still exceed a model's window, so both backends retain their own overflow compaction and retry first.

An exhausted backend context recovery carries `contextOverflow: true` on `turn_failed`: Claude reads the typed terminal reason, and Pi uses its runtime's overflow classifier after its recoverable attempt has settled.
The first mate records that failed turn and its usage, keeps the old transcript, forgets only that backend's resume pointer, and opens a fresh conversation with the bounded seat digest.
The existing durable inbox redelivers the kept captain words, accepted steers and operational updates; the digest tells the new conversation to check task records before repeating actions.
As on any provider failure, a kept attachment is named as omitted rather than silently discarded (`docs/inbox.md`).
The recovery makes the kept words due immediately and reports the new conversation in the feed without asking the captain to Retry.
It makes one such attempt until a turn succeeds; a refusal in the fresh conversation follows the ordinary visible failure and backoff path rather than an automatic renewal loop.
No failure line recommends a stronger model as a way out of the same oversized conversation.

A crewmate's turn that fails with `contextOverflow` is no provider outage either (`CrewTurns.recoverContext`).
The first one lets the full conversation go, keeps its file, and opens a fresh one through the conversation restart path (`changed: "context"`), which tells the crewmate why, serves its brief, and names where the earlier transcript is kept.
The rows the failed turn held go again once, as the fresh conversation's first turn, except the brief row, which the restart already serves; a failed turn that held only the brief still takes that turn.
The feed says so, and the first mate is not woken.
A second refusal in that fresh conversation, before any turn there ends clean, is not retried: its rows are acknowledged, since they are already in the conversation that overflowed, and the first mate is woken once with the failed turn (`turn-failed`) to act on.
