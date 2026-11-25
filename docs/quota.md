# Quota: the sensor and its math

How quota is read, renewed, reported and derived.
The account broker and credential health are `docs/architecture.md` §16.

## Notes

Moved verbatim from `AGENTS.md` on 2026-09-24; `docs/README.md` lists this page.

- Quota reliability (captain escalation 2026-09-04, investigation report `fm3000-quota-visibility-diag-s1`).
  The sensor's job is to be honest about what it established, and to recover from routine expiry without a sign-in.
  Four rules that must not regress:
  - **The vendor's verdict drives reactive recovery.**
    A 401 - and only a 401, never a 403, which is also how a WAF refuses - makes `fetchOneAccount` (`src/core/quota/fetchQuota.ts`) ask `AccountBackend.renew` (`vendor_rejected`), then retry once after an observed credential change.
    Claude sessions renew their own sign-in; the first login's health reads the modification-date-cached store without a client status poll or an advance renewal, and a further login's is the client's own status ("A further Claude login").
    Only after a rejection, with no live session and the store slot free, `ClaudeAuthBackend.renew` asks `auth status --json` once and rereads the store (`docs/claude-renew-probe.md`).
    It runs no fallback command and never speaks Anthropic OAuth.
    Pi accounts keep their existing proactive health policy and resolve-is-renewal: `getAuth` already refreshed.
  - **One session count and one store slot.**
    `src/core/claude/claudeStoreLease.ts` counts live clients and owns the slot shared by login, logout, catalog reads and the one idle status request, one count and one slot per login store: the default one, and each further login's folder.
    Claim and check happen in the same tick, so a background request cannot race a live session over its single-use refresh token.
    A session waits for an occupied slot before attaching; a background request defers immediately while a session or slot is active, without a renewal queue or thirty-second wait.
    User-initiated login and logout still serialize through the slot, with the seat detached by their existing owner.
    Infinitary owns its sessions, so this is a registry, never a process scan.
  - **Not knowing is its own state, and so is recovering.**
    `quotaProviderViewSchema` carries `ok | auth_required | rate_limited | unavailable | not_measured` plus a sanitized `reason` code and `measuredAt`.
    `renewal_succeeded` on an `ok` row is the ONE positive trace a renewal leaves - without it an `ok` after a failure is indistinguishable from plain network recovery, so a snapshot could only ever prove recovery had NOT worked; never record it on an ordinary reading that needed no renewal.
    Only `auth_required` may say "sign in again" or raise the needs_reauth card (CD-3=A: singleton card + Subscriptions CTA + one-step restore via `accounts.signIn`); it is reachable from a provider-refused refresh (`refresh_token_lapsed`: for a Pi account a credential read whose refresh the provider answered 401 or `invalid_grant`, `isLapsedRefresh` in `src/shared/authFailure.ts`, held by `AccountVault.refreshLapsed` until a read succeeds; and Copilot's refused GitHub sign-in, `providers/copilot.ts`) or a vendor rejection that SURVIVED a real renewal (`rejected_after_renewal`, `fetchQuota.ts`).
    Claude's saved refresh expiry is ignored: neither it nor access expiry establishes a sign-out, and the resolved credential still reaches Anthropic's allowance endpoint.
    A transient miss, a no-interactive-session block, and an unreadable store stay `unavailable` and retryable.
    `mergeStaleProviders` keeps last-known-good with its age through everything else, dropping windows whose own reset has passed.
    A no-window fallback is never a success and unknown is never zero.
  - **The credential-and-request layer has real coverage.**
    `tests/e2e/quota-live-sensor.spec.ts` is the one e2e that does NOT use the fixture seam: it runs the real `createQuotaFetcher` against a local stub of the vendor endpoint (`INFINITARY_CLAUDE_USAGE_URL`, `INFINITARY_GROK_USAGE_URL`, `INFINITARY_GROK_KEY_URL`, `INFINITARY_KIMI_USAGE_URL`, dev/e2e-gated exactly like `INFINITARY_QUOTA_FIXTURE_DIR`).
    Two provider defects reached the captain twice because that layer had none.
    Grok is METERED since the 2026-09-05 dogfood fix: `providers/grok.ts` reads the consumer credits meter (`grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig`, an UNDOCUMENTED gRPC-web endpoint that can change without notice) with the account's own Pi OAuth token and no browser headers: the meter answers with the bearer, the gRPC-web content type and marker alone, so Infinitary sends nothing that claims to be a browser or another client.
    `src/core/quota/grpcWeb.ts` is the schema-less reader (framing, trailers, a bounded protobuf field scanner); the field map in grok.ts is reverse-engineered and confirmed against a live capture (`providers/grok.test.ts` carries the bytes).
    A body the reader does not recognize is `schema_unrecognized`, never a window.
    A meter refusal (401/403, gRPC 16/7) is NOT a sign-in verdict on its own - whether a Pi-minted xAI token reaches the consumer meter was never established on the captain's account - so the sign-in is probed once (`/v1/models`): alive means the honest disclosed line with `meter_*` as the reason, and only the vendor's own 401 is `auth_required`.
    `INFINITARY_GROK_USAGE_URL` is the dev/e2e endpoint override, gated like `INFINITARY_CLAUDE_USAGE_URL`.
    An API key's allowance comes from its own read instead (`api.x.ai/v1/api-key`), whose dev/e2e override is `INFINITARY_GROK_KEY_URL`; `tests/e2e/launch.ts` points it at a local port nothing listens on, so no journey sends a seeded key to xAI.
    Kimi Code is METERED (INF-560): `providers/kimi.ts` reads `api.kimi.com/coding/v1/usages`, an UNDOCUMENTED endpoint that answers either ratio pools under `usages` or the older `usage`/`limits` counts, with the bearer Pi derives from the device-code sign-in or the pasted Kimi Code key and nothing else.
    Its five-hour, weekly and monthly pools are the session, weekly and monthly windows, and the membership level names the plan.
    A shape it does not know is `schema_unrecognized`, an answer with no pool is `KIMI_NO_WINDOW_DETAIL`, and only the vendor's 401 is `auth_required`; `INFINITARY_KIMI_USAGE_URL` is its dev/e2e override.
  - **Copilot** is METERED: `providers/copilot.ts` reads GitHub's `copilot_internal/user` (on `api.github.com`, or `api.<domain>` for GitHub Enterprise), an UNDOCUMENTED endpoint VS Code's Copilot reads, with the bearer and an Accept header only.
    Pi's request auth for Copilot is a short-lived Copilot token that GitHub's API does not take, so the meter reads with the GitHub sign-in Pi minted it from, through Pi's own `readStoredCredential` (`src/core/pi/copilotMeter.ts`, from `AccountVault.resolveForQuota`); nothing renews it and nothing writes the store.
    `quota_snapshots.premium_interactions` is the account's bound, labeled "premium requests"; `quota_snapshots.chat` shows as `product:chat` only when the plan meters it and bounds only its own scope; an unlimited snapshot or a zero-entitlement placeholder is no window.
    The cycle runs from the same day a month before `quota_reset_date` to it, and the row names its plan "GitHub Copilot".
    A 401 there is the GitHub sign-in itself refused, so it is `auth_required` with `refresh_token_lapsed`, the proof that may say "sign in again", and `fetchQuota.ts` tries no renewal after that reason; a 403 stays `unavailable`.
    An answer with nothing metered is `not_measured` with `COPILOT_NO_WINDOW_DETAIL`; one without `quota_snapshots` is `schema_unrecognized`.
    No typed cut-off is read from Copilot's refusals yet: the meter's reset is the only hold.
    `INFINITARY_COPILOT_USAGE_URL` is its dev/e2e endpoint override, gated like the others.
- Quota math (dogfood fix 2026-09-01): `src/shared/quotaSignals.ts` is the ONE home of derived quota math - pace/reserve/burnMultiple, runway projection, spendPriority, per-provider scope bounding.
  `quotaSignals.test.ts` pins constructed readings whose expected values are worked out by hand from those formulas.
  Signals are recomputed from a snapshot's cycle evidence (`resetsAtMs`/`windowSeconds` on windows) at read time, never persisted.
  Provider rules that must not regress: model/product windows bound only their own scope (never the account-wide min); a signed-in account with no readable window renders a disclosed detail line, never a silent blank (`GROK_NO_WINDOW_DETAIL` is the Grok case when the meter answers with nothing readable or refuses a live sign-in - it states what happened on that read, never that the credential cannot expose usage).
  Claude is SENSED: `src/core/claude/claudeQuota.ts` reads the machine's default login (`.credentials.json` in `~/.claude`, else the bare Keychain item `Claude Code-credentials` - presence-probe first).
  What it reads never leaves the computer except the token's own request to Anthropic: `~/.claude.json`'s email, account ID and organization ID only label the account, and `docs/sharing.md`, "What the app reads and never sends", is the promise.
  The item is found under whatever account the client keyed it on: the client names it after `USER`, but it runs on Bun, which names an unset `USER` `unknown` where the app would name the real user.
  So the presence probe asks for the `USER` name first, which is the item the client itself reads when both exist, and on a definite miss for the service alone; the value read, the unlock and the Apple tool then name the account that probe found (INF-1798).
  A host `absent` outcome (`errSecItemNotFound`, OSStatus -25300) is absence, and so is a value that parses and holds no login, which Claude Code leaves behind when its sign-out keeps other entries or a refused renewal blanks its tokens; a thrown presence-probe or an unparseable value is a named `keychain_*` read failure (`locked` / `unavailable` with `detail` and Retry), never an empty store and never `credential_unavailable` with the reason erased.
  `keychain_no_interactive_session` stays out of `keychainLocks` so every tick retries (a relaunch fixes it); a decline still holds until Retry, unless the store changed under it (another login's account config, or a rewritten Keychain item): then one fresh background read is made, never a prompt, and a decline there holds the new store until Retry.
  A `demand` refresh chains after an in-flight tick so Retry is not swallowed; a post-request resolve that cannot read the store is `unreadable`, not `unchanged`.
  The Keychain VALUE read rides `HostCapabilities.keychain`: guarded Apple-first inside a disposable utility process, the approved INF-2308/INF-2321 amendment to CD-5=B's in-process-first order.
  A sign-in asks macOS nothing itself (`ClaudeAuthBackend.login`, INF-2319); the allowance reading the Subscriptions tab asks for once it ends, a `demand` refresh, is the moment a permission prompt is expected.
  A LOCKED store is `keychain_locked`, never held: macOS fixes a process's unlock-dialog policy at its first touch of the store (the silent startup tick), so a tick skips the VALUE read and a user-initiated read first unlocks in a fresh `src/main/host/keychainProcessMain.ts` utility process, then reads in another fresh process (`docs/architecture.md` §16.6; the host sets the interaction flag before EVERY Security call).
  `providers/claude.ts` calls the vendor's OAuth usage endpoint; renewal is delegated to the client, never reimplemented.
  A computer that runs work reads its own Claude login the same way, but never lets macOS ask, holds no refusal and offers no Retry (`docs/helper.md`, "Claude's allowance, never asking").
  Pace vocabulary: "ahead" = burning faster than the reset clock = the WARN state ("behind" is calm) - an earlier UI had this inverted; don't bring that back.

## Keeping the Claude reading current

- For the first login, health, allowance, identity and login ownership use `readClaudeStore`: one `present`, `absent` or `unreadable` result carrying the access token, advisory expiry and current identity from Claude Code's config.
  A token command set up for Claude Code comes first: while one is set, health is that access, the allowance is not measured and the store is not read for it (`docs/claude-client.md`, "Access a company set up"), unless that access sends its requests to a CLI proxy on this computer, whose Claude pool is then the allowance ("A proxy's pooled logins").
  File credentials and the account config are cached by modification date; a Keychain value is cached only when the item reports its modification date, and is invalidated by a changed item or config.
  Access expiry alone does not discard a cached value, and concurrent equivalent reads share their work.
  Retry and the read around the idle status request bypass the value cache; an explicit permission request never joins a silent read.
  An unreadable result stays stale or degraded, never signed out, and never replaces the last known account label.
- A read through Apple's tool that fails or runs out of time is `keychain_read_incomplete`: retryable on the next refresh, never held until Retry, and its words never mention Always Allow.
  Every silent operation keeps the existing five-second read allowance, including its metadata, access-rule and value work in the child.
  An explicit interactive operation keeps the existing two-minute dialog allowance; a stalled or failed child never blocks the main thread and is never a false absence.
- Claude's usage service is asked at most once per account every five minutes (`CLAUDE_ASK_INTERVAL_MS`), and ten minutes after a 429 whatever its retry-after says.
  Refreshes between asks resolve the store first and serve the last answer only for the same login; a person's Retry always asks.

## A further Claude login

A Claude login in its own folder (`docs/claude-client.md`, "Further logins") is never read from its store and never sent to Claude's usage service: the sensor skips it (`pushedOnly`, `src/core/quota/homeQuota.ts`).
Its row holds only the plan windows its own sessions push (`pushedOnlyProviderViews`, `src/core/quota/pushedQuota.ts`):

- a login with no reading yet has a row and no meter, never an empty one;
- a refused window reads empty until its reset;
- a reading whose reset has passed reads as refilled, with no reset time, until a session pushes the next one.

Each pushed reading that moves a window is published as it arrives (`recordClaudeRateLimit`), since no sensor pass would bring it: the login's row alone replaces its last one in the snapshot (`QuotaService.publishProvider`), which asks no account's sensor and waits for none.
The credential resolver refuses such an account before any store read, so the rule does not rest on the sensor's list alone.

## Typed cut-offs

Before a Claude value read, the child checks that the store is unlocked and reads that one item's access rules (`SecKeychainItemCopyAccess`, `src/main/host/darwinKeychain.ts`).
It does not list the other saved passwords, and it does not check each trusted app's signature.
It tries `/usr/bin/security` before a direct value read only when that item's decrypt entry lists the tool and its partition is `apple-tool:` or absent.
The decrypt entry's require-password bit is not judged: a listed app satisfies that entry without its password window, and each of Claude Code's own saves (`security -i` running `add-generic-password -U`) swaps the bytes of the entry's prompt selector, so the bit comes and goes while the listed apps stay.
The partition description from `SecACLCopyContents` is a hex-encoded XML plist; the host decodes that known shape and accepts exactly one `apple-tool:` entry, refusing malformed data and any additional team.
Unknown layouts, other items, locked stores and missing grants never authorize the tool; the native fallback still enforces the caller's interaction flag.
The captain retained this guard because Apple's reader has no universal no-prompt switch; tool-first by itself is not proof that an arbitrary item cannot ask.
The value stays in memory, never disk or logs; no ACL or grant changes.
External rotation is observed on the next uncached read.
The value read is `find-generic-password -w` of that one item (`src/main/host/claudeKeychainTool.ts`), with Apple's hexadecimal output decoded for values containing non-printable bytes such as multiline JSON.

The regular macOS integration test (`src/main/host/claudeKeychainAccess.integration.test.ts`) creates its store under a scratch home’s `Library/Keychains/`, so macOS gives the item real partition entries.
It covers a Claude Code-style item, Apple-first success without direct value access, a granted item read through the tool after each of several Claude Code-style saves whatever they leave in the password bit, exact-account resolution through a real child, multiline credentials, and refusal of `apple-tool:` plus another team without invoking the tool.
It compares the real search list before and after; no real credential or real-item access rule is read or changed.
The unit fixture uses the hex-encoded plist returned by macOS and rejects malformed layouts and other partitions.

W1 S3, the Claude-seat plan's section 4.2.
A cut-off - a provider that stops serving an account - is expected input, never an error path, and it is classified in ONE place from typed fields only: `classifyClaudeSignal` in `src/shared/authFailure.ts`, beside `isAuthFailureMessage`, which stays the classifier for Pi and for rows recorded as prose.
Three product-neutral classes ride `turn_failed.cutOff` (`src/shared/events.ts`), so no provider's vocabulary crosses the event seam:

- `signed_out`: a result with `api_error_status: 401`, or the assistant's `authentication_failed` with no status beside it.
  The client labels every 401 and 403 `authentication_failed`, and a 403 is also a firewall's block page in front of the API, which no sign-in changes; so `authentication_failed` beside a 403 is an ordinary failed turn, never "sign in again".
- `refused`: `oauth_org_not_allowed` or `billing_error`; a bare `api_error_status: 403` is not a refusal.
- `no_headroom`: a pushed rate-limit `status: "rejected"` in the same failed turn, with `rate_limit` or no typed error at all; it carries that reading's `resetsAt` (epoch ms).
  A reading whose `overageStatus` is `allowed` or `allowed_warning` is not one: extra usage still answers past the plan window there ("Credits past the allowance"), so a turn that failed on it is an ordinary failed turn.
  `rate_limit` alone is not enough: the client also types a transient capacity 429 and a model it has switched off that way, so without the vendor's rejected reading it is an ordinary failed turn, and a typed error that is not a cut-off beats a reading.
  So does a loop that stopped on its own bound (`error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries`): its requests were answered, so a reading it saw on the way is not why it stopped.
  Only an API stop (`success` with `is_error`, or `error_during_execution`) can be read as a spent allowance; the real client against a stub API returning the vendor's `rejected` headers pushes the reading before it reports the error (`claudeFirstmateSession.integration.test.ts`).

Whether a turn failed is the result's to say (`is_error`, or a subtype other than `success`); only the turn's own assistant messages count, never a subagent's (`parent_tool_use_id` set), whose error the main agent may have recovered from.
Every other failure (`overloaded`, `server_error`, `unknown`, `max_output_tokens`, `invalid_request`, `model_not_found`, and the `error_*` results) is an ordinary failed turn with the honest retry.
A turn that answered is `ok` whatever its pushed reading said, and so is a turn the client cut short for a steer or an interrupt (`terminal_reason` `aborted_*`) with no API error behind it.
When one turn carries several signals the sign-in wins, then a refusal, then a spent allowance.
A backend declares which kind of failure it reports (`ControlProfile.failureSignals`: `typed` for Claude, `text` for Pi); a typed backend's failure without a class is never read as a sign-in.
The record keeps the class: `TaskService.turns.recordTurnFailure` stores `failureSignals: "typed"` and the `cutOff` beside the words (a typed backend's fatal close, `TaskClosing.closeRecord`, stores `failureSignals: "typed"` too, with no class: a session that exits is a session failure), and the feed line and the stall card read it back through `typedFailureOf`, so `plainProblem` picks the line by class (`signed_out` the sign-in line, `no_headroom` the allowance line, `refused` the plain fallback until it has its own) and never runs its sign-in, allowance or slow-down word rules over a typed failure.
A typed `signed_out` takes the crewmate's sign-in path (`CrewTurns.turnComplete`); `no_headroom` and `refused` take the provider-failure path, and the account's fact then holds the lane (`docs/inbox.md`, "A lane on a withheld account").
A Pi failure is prose, with one typed exception: xAI's `402` (credits spent) is read from where Pi's error puts the status, `xai API error (402): ...` or `402: ...`, never from its words, and only for xAI (`isOutOfCreditsRefusal`, with the session's provider; another provider's 402 can be about one oversized request).
`piEvents` types it as `no_headroom` with no reset; the host fills the reset where the hold is recorded (`recordCutOff` in `src/core/quota/spentAllowance.ts`, and `ownAccounts` on a computer that runs work), from the limiting window of that sign-in's latest reading on the computer where the refusal happened.
A 402 with no reset to hold against stays an ordinary failed turn, retried as before.
On this Mac the hold also lays a `rejected` reading over that window, the way Claude's refusal is laid over its meter, so the sign-in reads 0% left until the reset and routing skips it; `servesThere` already skips a held sign-in on a computer.
The hold keeps the lowest percent left the reading showed (`AccountCutOff.leftPercent`), and a later allowance reading that shows more ends it early (`AccountVault.noteReading`, from the sensor's `onAccepted`), as after a top-up; a lower reading is the sensor catching up with the refusal, so the hold keeps that lower one.
A Claude refusal names its own reset, and its hold keeps the lowest percent left of the sensor's own latest reading of the account, before any refusal is laid over it (`spentAllowanceHold`).
So a reset Claude gives back early, such as a Fable reset, which keeps the week's reset time, ends the hold and its refused reading at the next allowance reading instead of leaving the meter at 0% until the old reset.
A hold observed before any reading of the account keeps the first reading after it.
The failure's record keeps the class beside the prose, so the feed line reads `no_headroom`, and the crewmate's lane waits without turns (`docs/inbox.md`).
The pushed reading's `status` is kept on its window (`pushed_quota.status`, migration 51); a reading from before the column has none, which is unknown, never `allowed`, and its `resets_at` was stored in epoch seconds, so a reset is trusted only on a `rejected` reading.
The rules above still hold: only a 401 renews, and "sign in again" comes only from proof.

### The cut-off on the account

W1 S7.
Whoever observes a typed cut-off - a crewmate's turn (`CrewTurns.turnComplete`), the seat's (`FirstmateAgent.onSessionEvent`) or the kind classifier's (`AdaptedDecisionModel`, W1 S10) - records it on the account with `AccountVault.noteCutOff`.
A crewmate's turn on another computer met it on that computer's own sign-in, so that computer records it in its own store and this Mac records nothing; that computer's account rows carry it to this Mac, which holds the task on it as it holds one on its own (`docs/helper.md`, "Its own sign-ins").
The fact lives on the account's registry row (`cutOff`, additive: a row an older build wrote has none, which is no cut-off), so it survives a restart, and it goes with the account when the account is removed.

- **One predicate.**
  `servesModels` (`src/core/accounts/credentialHealth.ts`) is false for a connected account whose health reason withholds it: `client_missing`, `client_outdated`, and the cut-off reasons `refused` and `signed_out`.
  The vault's `health()` lays a standing `refused` or `signed_out` over the backend's reading as `degraded` with that reason, so the account stays connected - only proof shows "sign in again" - but serves nothing.
  A proven sign-out still reads as one, and a missing client keeps its own sentence.
  The routing pool (`availableModelsByAccount`), the flagship's eligibility (`Flagship.isEligible` through `servesSync`) and account selection (`selectAccount`, whose `account` row says `skipped <label>: withheld (<reason>)`, and names a withheld account of another provider too, since routing never reached it) read the same predicate.
  Crew delivery holds a lane while a typed cut-off stands on its account - the fact itself, a spent allowance included - and leaves every other not-serving reason to fail its turn as before (`docs/inbox.md`, "A lane on a withheld account").
- **A spent allowance withholds nothing.**
  Its predicate is headroom: a pushed `rejected` reading is a zero window until its reset, even for the sensed Claude row (`withRejectedReadings`, laid over each sensed row by `createQuotaFetcher`'s `overlay`; a reading that flips to or from `rejected` refreshes the snapshot at once).
  The row the sensor measured keeps its other windows; a row it could not measure carries only the refusal; `auth_required` is left standing.
  Only a `rejected` reading's reset is trusted (rows from before migration 51 held seconds).
  The vault still records `no_headroom` with its reset for the lane and seat phases, and holds none with no reset named, since nothing could clear it.
  When the captain's Try again ends the hold, the home's quota wiring ends the account's `rejected` readings with it (`AccountVault.onCutOffChange` in `src/core/quota/homeQuota.ts`, only while the account goes by its answers), so the seat, the crew lanes and the meter never read two answers.
  Every other way a hold ends keeps its own way with the readings: a reset ends each at its own reset, a reading with more left ends them, credits serve past them, and another login forgets them.
- **Clearing, only when a fact changes** (owner Q1 a: never an automatic attempt).
  Each fact carries the stamp it was seen under (`CredentialStamp`): which login the store holds (a digest of the account and organisation the client's config names), when the credential was last written (the plain-file store's modification time, else the Keychain item's), and the client's version, projected from the shared store result by `claudeCredentialStamp` and never carrying a token.
  Its existing digest and file-first modification-date format stay compatible with saved refusals and records of pasted-code logins; neither needs a second reader.
  A part the note could not see is adopted from the next read that does, never counted as a change.
  One fact stands at a time, and a cut-off with a looser way back never replaces a stricter one that stands (refused, then signed_out, then no_headroom): a turn already in flight that settles after a refusal cannot hand it to a clock or a routine rewrite.
  Before the first read after a restart, `servesSync` and `withheldReason` answer from the standing fact.
  - `no_headroom` clears at its reset, or when the store names another login: the spent allowance belonged to the old login, so a swapped-in login is not held by it (and held crew lanes resume within the idle ladder's next tick).
    It also clears on the captain's "Try <provider> again" on the first mate's spent-allowance card, offered once the captain's recheck from the card leaves the seat paused, whether or not its reading was taken (`AccountVault.tryPastSpent`).
    The client can answer on a login the store does not name, such as a token a launcher passes it, and only the provider sees that one, so the account then goes by the provider's answers rather than its allowance reading (`AccountRecord.goesByAnswers`, which `Flagship.pause` reads) until the provider refuses it again or the store names another login.
    The next turn is the attempt: served, the seat stays on the account; refused, the hold, its refused reading and the pause come back, at the cost of that one refused request.
  - `signed_out` clears when the store is written again, names another login, or the provider accepts that same login again.
    A dead login cannot renew itself, so a rewrite is a new sign-in (or a renewal that worked).
    A still-live login never rewrites itself, so a good allowance reading or a turn that succeeded on it clears the mark too (`AccountVault.noteAccepted`), and so does the row's Sign in once it ends, since a store the app cannot read shows no rewrite of the new login.
    A refusal is not cleared by any of those.
  - `refused` clears only on the captain's "Try Claude again" (`AccountVault.tryAgain`, which the seat's refused card calls through its `try-again` host op), another login, or another client version.
    A live credential renews itself routinely, so a rewrite alone is not a changed login here - which also means signing in again to the same account and organisation does not clear a refusal; "Try Claude again" is the way back after a fix that keeps the same login.
- **A changed login** (INF-1079).
  A person may switch the machine's Claude login outside the app when one runs out, and the account row stays the same, so the vault keeps the login its store last named on the row (`AccountRecord.login`, kept across a restart).
  Each health or allowance read passes its non-secret projection to `AccountVault.noteCredentialRead`; the vault compares that login and updates Claude's row label from the current identity.
  There is no separate focus-time identity scan; the next ordinary reading observes a swap.
  The first login seen is adopted and an unreadable one is no change; a different one clears whatever cut-off stood on the account and is heard through `AccountVault.onLoginChange`.
  The home's quota wiring (`src/core/quota/homeQuota.ts`) then forgets the old login's pushed readings (`PushedQuotaStore.forget`), drops its row from the last snapshot so it is not carried forward (`QuotaService.forgetAccount`), and takes a reading at once (`refresh("account-changed")`, which, like `demand`, chains after a refresh in flight instead of joining it).
  The sensor keeps each Claude answer under the login it was asked with (`createQuotaFetcher`'s `loginOf`): an answer the old login got is never served from the five-minute ledger, and one that lands after the switch is dropped as `skipped`.
  An unchanged login keeps its spacing, its backoff and its genuine refusal.
  The captain's Recheck allowance (the spent-allowance card, command search, Subscriptions' Refresh) refreshes with `demand`, the one reason that may ask for access (`FirstmateAgent.recheckAllowance`).
  The same Refresh asks each computer that runs work to read its own allowance now, which never asks for access there (`docs/helper.md`, "Allowance and renewal, here alone").
  That same store read supplies the login before the sensor considers a cached answer.
- **A refusal never renews.**
  `AccountVault.renew` answers `withheld` without asking the backend while a refusal stands; the health tick already skips a degraded account, and the sensor's 401 path reads `withheld` as `renewal_withheld` (not knowing), never a sign-out.
  A lost sign-in may still renew: only a 401 renews, and that is the path to proof.

## Credits past the allowance

INF-4104 piece 1.
A provider can keep answering after the plan allowance runs out, paid from credits the person set up with it: Claude's extra usage, ChatGPT's Codex credits and Copilot's paid premium requests.
Each reading carries what the provider says about them as `credits` on the account's row (`quotaCreditsViewSchema` in `src/shared/quota.ts`): `available`, `spent`, `off` or `unknown`, with a share of a monthly limit used, a balance, `unlimited` or `inUse` where the provider gives them.
No `credits` is unknown too, never `off`.
It is a fact beside the windows: it never bounds or raises a plan window, so a spent window still reads 0% and every reader of the windows is unchanged.
Infinitary neither buys credits, switches them on nor sets their limit; the provider's own site does.

- Claude, from the usage reading's `extra_usage`: `is_enabled: false` is `off`; switched on, `spend_limit_reached` or `utilization` at 100 is `spent`, and below it `available` with that share (`claudeCreditsFromUsage`).
- Claude, from the reading the client pushes mid-session (`readRateLimit` in `src/core/claude/claudeEvents.ts`): `overageStatus`, `overageDisabledReason` and `isUsingOverage` are saved beside the pushed window (`PushedQuotaStore`, three nullable columns).
  The newest reading that names an `overageStatus` decides: allowed is `available`, refused for `out_of_credits` is `spent`, refused for `fetch_error`, `unknown` or no reason is `unknown`, and refused for any other reason is `off` (`pushedCredits`).
  Only a reading younger than `PUSHED_STALE_AFTER_MS` may say `inUse`.
- On a sensed Claude row the newer of the two readings decides the state, and the sensor's share stays beside an `available` state (`withPushedCredits`, laid over the row after `withRejectedReadings`).
- ChatGPT, from the Codex usage reading's `credits` (`has_credits`, `unlimited`, `balance`, `overage_limit_reached`) and `spend_control.reached`: a reached spend or overage limit is `spent`, `unlimited` or `has_credits` is `available` with the balance as sent, and `has_credits: false` is `off`.
- Copilot, from `overage_permitted` on the premium-requests snapshot: `available` or `off`, shown only, and never `spent`, since GitHub does not yet say when a budget stops a request.

The Subscriptions row says the fact in one line under its meters, then where to change it (`creditsLine` in `src/renderer/src/settings/subscriptionsWords.ts`, `docs/subscriptions-tab.md`).
Alone the fact routes nothing, picks no account and pauses nothing; the account's Keep going on credits switch below is what lets an account serve on it.
`src/core/quota/credits.test.ts` reads whole provider answers from `tests/fixtures/quota-credits/`: live Claude and Codex usage readings, the Codex one trimmed of its identity, which also carries its saved resets ("Saved resets" below); the client's pushed readings there are written from its published types.

## Keep going on credits

INF-4104 piece 2.
A Claude or Codex account carries a switch, off by default, that lets it keep serving on its provider's credits once its allowance is spent (`CREDITS_SWITCH_PROVIDERS` in `src/shared/quota.ts`; Copilot is left out, since GitHub does not say when a budget stops a request).
The switch is saved on the account's registry row (`AccountRecord.keepGoingOnCredits`, additive: an older row has none, which is off) by `AccountVault.setKeepGoingOnCredits`, which refuses another provider's account.
It is the `account-keep-going` catalog line (`inf:accounts:keep-going`), at the own-words tier: the first mate turns it on only on the captain's typed words, and the run-out card's button is the captain's own click.
The row's menu offers it, and the provider's own limit is the only cap: Infinitary sets none.

- **One predicate.**
  `answersOnCredits` (`src/shared/quota.ts`) is true for a row whose switch is on, whose provider is one of the two, and whose credits are not `off` or `spent`; an unknown fact still answers, and the provider's refusal is what stops it.
  The home lays the switch over every quota row (`stampSwitch` in `src/core/quota/creditsSwitch.ts`, through the fetcher's overlay and `QuotaService`'s `stamp`, the saved snapshot read at start included), so every reader sees it on the row it already reads.
  It lays none on an account the provider refused ("A real refusal still holds" below), so the refusal moves work to another account rather than waiting on it.
  `effectiveFromProvider` marks a spent scope of such a row `onCredits`, the catalog marks its spent models the same way (`markCredits`, for a fixture's catalog too), and `allowanceSpent` (`src/shared/quotaSignals.ts`) is the one exhaustion test: a spent allowance that is `onCredits` is not spent.
  Routing's 0% exclusion, the account pick, the first mate's pause (`Flagship.pause`), the first mate's own model pick, the quota-reset gate and placed work read it, so never-downgrade keeps the level on credits because nothing excludes the model.
- **Credits come last.**
  A model on credits ranks in its own band, `credits`, after `unknown` (`spendBand`), so every included allowance at the level is spent first and a weaker level comes only after it (`docs/routing.md`).
  The band stays inside routing: a crewmate's published model choice names it `near_floor` with the candidate's `onCredits` mark (`modelChoiceOf`), so a paired view that reads the band list strictly still reads the record.
  The catalog's best account per model and the account pick take an account with allowance left before one on credits, and pick among accounts on credits the least recently used.
  The first mate on credits moves first to a sibling of the same provider with measured included allowance (`FirstmateSeat.admitTurn`), and when that sibling runs out, the ladder's first rung takes it back to an account that serves on credits before it pauses (`Flagship.sibling`).
- **The run-out cards.**
  When the first mate's account runs out and its provider says credits are available while its switch is off, the spent-allowance card (`card-fm-no-headroom`) puts Keep going on credits first, with Recheck allowance beside it (`Flagship.creditsOffer`, the `keep-going-on-credits` host op).
  When a crew decision would wait or drop a level because an account's allowance is spent, the router names those accounts (`RoutePreview.spentAt`), and the home raises one crew card per account until its allowance answers again (`creditsOffers`, `creditsOfferCard`, `forgetAnsweredOffers`), never keyed by a reset time, which moves with every Codex reading; the cards it offered are kept in memory, so a restart may offer one again.
  Turning the switch on takes the account's card down.
  An account a computer that runs work signed in to on its own has the same switch, saved on that computer (`docs/helper.md`, "Its own sign-ins"): its row in Settings → Intelligence offers it, the `account-keep-going` line takes the computer's `deviceId`, and `inf:accounts:keep-going` takes it as a third argument.
  A crew decision that waits on such an account names the computer (`RoutePreview.spentOn`), and its card says where (`card-credits-offer-<deviceId>-<accountId>`, whose button carries `<accountId>@<deviceId>`), as do its feed lines (`CreditsCards` in `src/core/quota/creditsCards.ts`).
  A home sends the Keep going on credits button only to a view on contract major 16 or later, to a view on major 15 that lists `keep-going-on-credits`, or to the phone, and leaves it off every card it pushes or answers to an older desktop view, whose card reader is strict (`readsKeepGoing`, `withoutUnreadActions` in `src/core/connection/taskAllow.ts`, as for Allow for the rest of this task); that view still has Recheck allowance and Settings.
- **A real refusal still holds.**
  A spent allowance the provider refused stands until its reset, switch on or not (`no_headroom` on the account, "The cut-off on the account" above): the row carries no switch while it stands, and the switch serves again once the hold ends.
  A later reading whose credits read `available` after `spent` or `off` ends that hold early (`AccountVault.noteCreditsAvailable`), and so does turning the switch on while the credits read `available`.
- **Feed lines.**
  `CreditsWatch` reads each snapshot against the one before it and says one line when an account that keeps going starts spending credits, and one when its credits run out; a restart says nothing again.

## Saved resets

INF-5369 piece 6.
ChatGPT can give a Codex account saved resets: each one, used on ChatGPT's own usage page, refills the allowance it covers before that allowance resets on its own.
The Codex usage reading's `rate_limit_reset_credits` carries how many the account holds (`available_count`) and how many would apply now (`applicable_available_count`), and the row keeps them as `savedResets` (`quotaSavedResetsViewSchema` in `src/shared/quota.ts`, `codexSavedResets` in `src/core/quota/providers/codex.ts`).
A reading without a count is unknown, never zero, and the row then carries no `savedResets`.
OpenAI's own Codex client reads only the held count, so what decides whether a reset applies now is the provider's, read from the applicable count as sent: a reading may hold one that does not apply yet.
It is a fact beside the windows, like credits: it never raises a window, and routing, the account pick and the first mate's pause read nothing from it.
Infinitary uses one only when the captain chooses Use a saved reset, or on its own for an account whose Use saved resets on their own is on ("Saved resets on their own" below), and then through the Codex CLI the person installed, never by calling ChatGPT itself (`docs/codex-client.md`); the provider's own page (`SAVED_RESETS_PAGE`, `https://chatgpt.com/settings/usage` for Codex) stays the other way.

- The Subscriptions row says the held count in one line under its meters, with the site where one is used (`savedResetsLine` in `src/renderer/src/settings/subscriptionsWords.ts`); none held, or an unknown count, says nothing.
- While a saved reset applies now (`savedResetsNow`), the row's menu offers Use a saved reset (`savedResetItem` in `src/renderer/src/settings/SubscriptionsTab.tsx`), on this computer's accounts and on each computer that runs work's own (`docs/helper.md`, "Its own sign-ins").
- When the first mate's account runs out and a saved reset applies now, the spent-allowance card (`card-fm-no-headroom`) says so in its body, naming the account as its row does, with a link to the provider's usage page beside the sentence (`savedResetsWords` in `src/core/orchestrator/hostCards.ts`, `Flagship.savedResetsNow`), and adds a Use a saved reset button after Keep going on credits (`redeemSavedResetAction`).
- The crew's run-out card rises for an account with credits or with a saved reset that applies now (`creditsOffers`): it says the same sentence and adds the same button, first when the account has no credits to offer.
- The button is the `use-saved-reset` host operation, carrying the account's key (`<accountId>@<deviceId>` for a computer that runs work).
  For this computer's account that Codex is already signed in to, the click uses the reset at once; otherwise it opens Settings → Intelligence, whose row starts the use with Codex's sign-in (`pendingUseSavedReset`).
- The catalog line `account-use-reset` (`inf:accounts:use-saved-reset`) is at the own-words tier: the first mate uses a reset only on the captain's typed words, and only for an account Codex is already signed in to; any other is refused with words that say to choose Use a saved reset on the account's row.
- What the use came to is one feed line naming the account: used, with how many are left when Codex says; nothing to reset, since no allowance it covers was spent; or none left (`savedResetLine` in `src/core/codex/savedResets.ts`).
  After a use the allowance is read again at once (`demand`), and the account's crew run-out card is taken down.
- A home sends the button only to a view that lists `use-saved-reset` among its contract changes, and leaves it off every card it pushes or answers to an older view (`readsSavedReset`, `withoutUnreadActions` in `src/core/connection/taskAllow.ts`); that view keeps the body's link to the provider's page.

### Saved resets on their own

INF-5478's plan, piece 2.
Each Codex account carries a switch, Use saved resets on their own, off until the person turns it on (`AccountRecord.useSavedResets`, saved on the computer that holds the account; `AccountVault.setUseSavedResets` refuses any other provider's account).
With it on, Infinitary may use one of the account's saved resets without a click, only when work waits on its spent allowance and no account at that level has room.
Accounts with allowance left come first.
A saved reset is weighed as work starts on credits, not before it: an account that keeps going on credits serves that work until the question ends, the reset is used and a new reading shows the allowance back.

- The moment is a committed crew decision that waits or drops a level on the account's spent allowance (`RoutePreview.spentAt`), or that keeps going on its credits (`RoutePreview.creditsAt`), and the first mate's ladder once no sibling account has room (`savedResetsSpent` in `FirstmateSeat`).
  There the seat either serves the turn on credits at once, when its account keeps going on credits, without waiting for the question, or pauses on the spent allowance until a higher reading resumes it.
- Whether a reset beats waiting for the refill is a judgment, so the `saved-reset` decision use asks it as a choice between use and wait (`AutoSavedResets` in `src/core/codex/autoSavedResets.ts`; `docs/decision-models.md`, "The uses").
  Its facts are the account's plan, how much of each allowance is left and how many hours until it refills, how many saved resets it holds and how many apply now, and which work waits.
- It is asked once per spent allowance of an account, like `creditsOffers`; a reading that shows the allowance back above zero lets it be asked again the next time the account is spent.
- An abstention, a failed question, the use switched off, or the account's switch off all mean wait: nothing is used and the run-out card keeps its Use a saved reset button.
- A use goes through the same path as Use a saved reset (`SavedResets.use`), and its feed line says Infinitary used a saved reset on the account so waiting work could continue, with how many are left when Codex says (`savedResetLine`).
  It never shows a sign-in: a use that needs Codex's sign-in fails, says why in the feed and leaves the card's button.
- The switch sits in the account row's menu (`autoResetsItem`), and the run-out card offers it as a secondary action after Use a saved reset while it is off (`autoResetsAction`, the `use-saved-resets` host operation).
  Turning it on while Codex is not signed in to the account starts Codex's sign-in on the row first and uses nothing; the switch stays off if the sign-in does not finish.
  A card's click turns it on at once for this computer's account that Codex is already signed in to, and otherwise opens Settings → Intelligence, whose row starts it with the sign-in (`pendingUseSavedResets`).
- The catalog line `account-use-saved-resets` (`inf:accounts:use-saved-resets`) is at the own-words tier and takes a `deviceId` for a computer that runs work's account; turning it on there with Codex not signed in is refused with words that say to turn it on from the account's row.
- A computer that runs work is asked with the `inf:sign-ins:use-saved-resets` order, sent only to a computer that lists the `auto-saved-resets` change (`DeviceSignIns.setUseSavedResets`); a view that does not list it gets no switch action on the run-out card (`readsAutoSavedResets`).

## Amazon Bedrock refusals

Amazon Bedrock has no allowance meter.
Its built-in agent uses the named AWS response code, not a bare HTTP 403 or an error sentence.
`ExpiredTokenException` and `UnrecognizedClientException` say to sign in again; for a named profile, the request first tries one fresh resolution if AWS refused it before streaming.
`AccessDeniedException` says this AWS account may not use the model, and `ThrottlingException` backs off without asking for sign-in.
A profile renewal rejected by AWS with a terminal code also asks for sign-in: a changed password or expired console sign-in, or a refused IAM Identity Center refresh grant.
Named AWS permission failures and throttling during profile resolution do not offer sign-in.
An ambiguous local profile failure says that Infinitary could not use the AWS sign-in and offers Sign in without marking it expired or signed out.
The sign-in action opens AWS's own sign-in for an existing AWS IAM Identity Center or console profile, or asks for a replacement Bedrock API key.
Before work resumes after profile sign-in, Infinitary rechecks Claude model access in that account’s region and saves the new list.
AWS may bill those checks.

## A proxy's pooled logins

A CLI proxy on this computer (EasyCLIProxyAPI, a build of CLIProxyAPI) can hold several Claude logins and several ChatGPT logins and send each request to one of them.
Infinitary reads such a proxy's own limit readings and shows, routes and pauses by one Claude pool and one ChatGPT pool, never by a single login (`src/core/quota/cliProxy/`).

- **Finding the proxy.**
  EasyCLIProxyAPI keeps its settings in `config.toml` in its own folder and runs its proxy program, `cli-proxy-api`, from a folder inside it (`cpa-core` in its Windows download).
  A packaged app asks the system, on every read, which programs named `cli-proxy-api` listen on this computer's TCP ports, and on which address and port (`findProxyListeners`: `Get-NetTCPConnection` on Windows, `lsof` elsewhere, where a wildcard address counts only with the address family `lsof` names for that socket; at most once every five minutes while no proxy runs), and reads `config.toml` beside such a program or in the folder above it (`readProxySettings`): the port, the management key and the first client key, from the top-level lines before any table.
  The settings are used only while that program itself listens on the port they name, and only at the loopback addresses where it listens there (`loopbackOriginOf`): `http://127.0.0.1:<port>` for IPv4 loopback or every IPv4 address, `http://[::1]:<port>` for IPv6 loopback or every IPv6 address; the keys go to the IPv4 one first when it listens on both (`createProxyAppReader`).
  When both folders hold settings naming a port the program listens on and their keys differ, which ones the program uses is not known, and neither is read.
  Every one of these addresses is written as an address's origin writes it (`loopbackOrigin`), so a proxy on port 80 is `http://127.0.0.1`.
  A proxy that exited, another program on its port, or a proxy listening only on another interface is never sent a key, and a proxy whose `host` is not this computer is not read.
  The keys stay in memory: they are never logged, saved or shown, and go only to that loopback address.
  A development or test run reads no proxy unless `CLI_PROXY_SETTINGS` names a settings file (`proxyAppFor` in `src/core/quota/homeQuota.ts`), so a test never reads the proxy of the computer it runs on.
- **Only reads.**
  Every request goes through `guardedProxyHttp`, which refuses before sending anything but `GET /v8/management/credentials` (`/v0/management/auth-files` on a proxy before version 8, after a 404), `GET /v1/models`, and a `POST /v0/management/api-call` that reads one login's usage from Anthropic's or ChatGPT's usage address with no body.
  The usage queue is never asked, since asking empties it, and nothing that changes the proxy is sent.
  A redirect answer fails the request instead of being followed (`redirect: "error"`), so no request reaches a route the guard did not check.
  A reader made with `ask: false` refuses the request tool as well, and only reads what the proxy already holds.
- **Only when it is used.**
  The proxy is read only while something in the app sends requests to its port: the Claude account's access for Claude Code, or a custom connection's base address (`uses`); otherwise no request is sent at all.
- **Each login.**
  `parseProxyCredentials` keeps each login's pool, state and last limit reading, and drops its email, label, file path, id and id token.
  A login switched off in the proxy is `switched_off`; one whose renewal fails and whose sign-in has expired is `sign_in_ended`; one on a quota cooldown of the whole login is `spent` until the proxy tries it again; any other serves, with the time it stops serving when the proxy says it needs signing in again.
  Its reading is the limit headers of its last answer: Anthropic's unified headers (a used fraction and a reset in Unix seconds per window) or ChatGPT's `x-codex-*` headers (a used percent, a reset and the window's length, which names it).
- **A login the proxy has not read.**
  A serving login with no reading, in a pool something in the app uses, is asked once through the proxy's request tool, which puts the login's own token in place of `$TOKEN$`, so Infinitary never holds it (`fillUnread`).
  Its answer stands in until the proxy reads the login itself, and a login that answered is never asked again, even after the proxy loses its own reading; the record is kept for each proxy address and login.
  A failed ask is tried again no sooner than ten minutes later (`UNREAD_RETRY_MS`), or later when the vendor's or the proxy's `Retry-After` says so.
- **The pool.**
  `poolReading` (`src/shared/quotaSignals.ts`) makes each window's share left the mean of every serving, read login's share, weighted by the proxy's own login weight, with each spent login counted at zero.
  A login whose window already reset counts as full.
  Unread, switched-off and sign-in-ended logins are counted on the row and never weigh as zero: unknown is not empty.
  The window refills at the earliest moment a spent login comes back or a read login resets.
  With no login serving and one spent, the pool reads 0% until the first comes back; with serving logins all unread, it has no window.
  The row carries the counts as `pool` (`quotaPoolViewSchema`), and the proxy's sign-ins never make it `auth_required`: they are renewed in the proxy app.
  A pool's credits stay the proxy's: Keep going on credits is never offered on it (`creditsOfferOf`, `answersOnCredits`), and its row says the credits fact in its vendor's words with no switch (`POOL_CREDITS_PROVIDER`).
- **Where the pools show.**
  An address in the app is the proxy's only when it names one of those loopback addresses (`addressIsProxy`): IPv4 and IPv6 loopback are told apart, since another program can hold the same port on the other, and `localhost`, which a client may reach on either, counts only when the proxy listens on both.
  The Claude row whose access for Claude Code sends its requests to the proxy (`ClaudeAccess.address`) reads the Claude pool (`poolOutcome`), with the sessions' current refusals laid over it as on any sensed row (`withRejectedReadings`) and none of a session's usage or credits.
  Once that access is removed, the row is the pool's no longer: it is unread until the account's own reading comes with the next refresh.
  A custom connection whose base address is the proxy gets one row per pool its models are served from, under its own provider id, the pool named by the owner the proxy's model list gives each model (`owned_by`: anthropic is Claude, openai is ChatGPT); a model of any other owner belongs to no pool (`proxyConnectionRows`).
  Each such row names the models it measures (`pool.models`), and every row read through the proxy is marked `fromProxy`.
  A proxy that did not answer, or whose model list could not be read, gives such a connection one unread row saying why (`models_http_<status>` or `models_unreadable` for the list); the last reading of each pool stays on as stale under its own pool, and never mixes with a reading taken without the proxy (`mergeStaleProviders` keys a proxy's row by its pool).
  A list that could not be read is not a list with no model of a pool: while it is missing, none of the connection's models is put under a pool, so routing knows nothing of their headroom.
  Settings shows each pool's meters, a line saying how its logins stand (`poolLine` in `src/renderer/src/settings/subscriptionsWords.ts`) and its credits, on the Claude row and under the connection; the phone shows the same for each pool, in whatever order the rows come.
- **Routing and pausing.**
  Each pooled model of a connection has a catalog row that reads its pool's row (`proxyCatalogModels`, `pool` on `QuotaCatalogModel`), so routing weighs its pool's reading instead of admitting it by its level alone, and a spent pool takes its models out as any spent allowance does (`allowanceSpent`).
  Every decision that reads an account's row for a model reads the row that measures that model (`rowMeasuresModel`, `quotaRowOf` in `src/shared/quota.ts`): the router's ranking, the account selector, a bound computer's check and the first mate's seat, which reads the row of the first mate's model.
  The first mate's one-line allowance digest names each pool row's pool beside its account (`quotaContextLine`), so a connection's two pools never read as one account.
  A model of no pool is still admitted by its level alone.
- **When it is read.**
  The proxy is read on its own one-minute clock and again after each quota refresh (`localReading` on `QuotaService`), never holding a refresh up.
  One projection makes every row read through the proxy, all timed at the reading's own moment (`projectProxyRows`, through `rowOfOutcome`): the Claude row, found by its quota id while Claude Code's access is set up and the last ordinary refresh read the account through it, so a fresh reading of the account's own sign-in is never replaced, and each connection's pool rows.
  It is laid over every refresh until the next reading, and a reading publishes the rows and the catalog only when they change, so an unchanged minute tells no surface; when the last proxy goes, one publish gives the Claude row back to what its access says and takes the connection rows away.
