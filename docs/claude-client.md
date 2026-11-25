# The Claude client

How the Claude Max backend finds, checks and runs the Claude client the person installed.
The backend's design is `docs/architecture.md` §16.1; the sign-in rules are below, and the renewal and model probes are `docs/claude-renew-probe.md` and `docs/claude-model-probe.md`.

## The client's process

Every Claude session's client is spawned by the app through the SDK's supported `spawnClaudeCodeProcess` hook (`src/core/claude/claudeClientProcess.ts`), on every platform: the first mate's seat, a crewmate's coding session and a one-shot question alike.
The hook keeps the SDK's executable, arguments, already-filtered environment and forwarded late-abort signal unchanged, and uses piped streams without a terminal, as the SDK's own spawn does.
It watches the client until it exits, so a session's lease, its `closed()` and its record's last copy follow the client's real exit (INF-3500).
The SDK cannot give that by itself: its close ends the client's input, sends SIGTERM 2 s on and SIGKILL 5 s after that, but ends the session's message stream after at most 2 s, whether the client has gone or not.
A session stopped outright with a client slow to leave therefore waits for the client, up to the SDK's SIGKILL about 7 s after the stop.
`src/core/claude/claudeClientExit.integration.test.ts` holds a question's abort and a crewmate's hard close to it, on the boxed client stopped with SIGSTOP.
On macOS and Linux, a coding session's hook also registers the client's PID as its task's process root and releases the root on process exit.
The resource observer never signals that process; the existing session lifecycle still owns close and cancellation.
The client's stderr goes to the existing host log callback.
The SDK's custom-process contract delivers plain process exit, unlike its default local adapter's bounded stderr-close delay and built-in stderr tail in exit errors, so a client's exit error carries its code but no stderr tail; diagnostics remain in the host log.
Task attribution and its limitations are owned by `docs/helper.md`, "Running tasks’ resource use".

## A crewmate's shell

A crewmate's coding session hands its client the task's shell: the task channel's variables, and the app's command folder first on the search path (`withTaskShell`; `docs/axi-commands.md`, "The channel").
It also sets `CLAUDE_CODE_SHELL_PREFIX` to that folder's `infinitary-crew-shell`, and `CLAUDE_CODE_SHELL` to the shell the client picks first anyway (`withCrewShell` in `src/core/claude/claudeCrewShell.ts`): its own setting when that names a bash or zsh that runs, then the person's login shell when it is one, then the system's zsh or bash, in the client's order.
The client starts each command's shell leading a process group of its own and, with a prefix, runs `'<prefix>' '<command>'` in it.
The program tells the task channel its process number with the task's key, then runs the command in `CLAUDE_CODE_SHELL`, so the door refuses a program the command left running with `&` or nohup until its task closes (`docs/axi-commands.md`, "Never the crew's").
When the app cannot be told within the program's wait, the command still runs.
The command itself first restores the client's own search path from its shell snapshot, so a system's shell start-up files that set another do not hide the app's commands.
With a prefix, the client also runs its command-line tool servers and command hooks through it; a crewmate's session declares neither (`settingSources: []`, `strictMcpConfig: true`, and its hooks are the app's own in-process callbacks), and those would run in the client's group, which neither they nor the client leads, so the channel would keep none of them.
On Windows the client runs every command in Git Bash, so the app sets only the prefix, and the program runs the command in Git Bash's bash; the app makes the program lead a Windows job in place of a process group (`docs/heavy-runs.md`, "On Windows").
A prefix the person set for their own client stays theirs, so a command left running from that crewmate's shell is not refused; a command folder whose path the client would split at ` -` gets no prefix.
`claudeSession.test.ts` (and its record, upgrade and guardrail groups in `claudeSession.record.test.ts`) holds the two settings and a person's own prefix kept, and `captainCommands.test.ts` a program left running from a shell started the client's way, refused after the shell ended.

## Notes

`claudeEnvFor` unconditionally sets `CLAUDE_CODE_ENTRYPOINT=infinitary`, replacing absent, empty and inherited labels with the app's own identity without mutating the supplied environment.
The shared environment reaches first mate, crewmate and decision-question sessions, model catalog reads, version checks and direct client runs, including sign-in and the one idle status request after rejection.
Both home and helper conversations use that same session factory.
This applies the custom-entrypoint workaround discussed in [Claude Code issue 97074](https://github.com/anthropics/claude-code/issues/97074#issuecomment-6426128541); community reports of lower allowance consumption are not an Anthropic guarantee or a measured saving for Infinitary.
Only new processes receive the identity; running processes and saved conversations are not rewritten, and the person's Claude settings, sign-in and Infinitary's usage calculations stay unchanged.
The client passes the label on to every command it runs, and the account evaluation runner reads it to know a shell belongs to one of the app's own Claude crewmates (`docs/account-evaluation.md`, "The Claude crewmate's client").
`claudeEntrypoint.integration.test.ts` checks actual request billing metadata for all three roles and persisted transcript labels for rolling sessions, including a resumed conversation and an SDK-default control, on a boxed real client with dummy credentials and a local API.

`claudeEnvFor` leaves `CLAUDE_CONFIG_DIR` unset: setting it at all, even to `~/.claude`, selects a differently named Keychain item rather than the machine's default login (CD-1=B, captain, 2026-09-10).
A further login is the one exception: its runs name its own folder ("Further logins", below).

`runClaude` uses piped stdin, stdout and stderr, with no terminal or PTY.
For sign-in, `claudeAuth.ts` lets the client open the browser.
The app does not open that page again on its own; the person can, and can paste a code the page shows or cancel, and a second Connect waiting behind the first uses the login the first one saved.
Connect uses a login already on the computer.
The row's Sign in shows only once Anthropic refused the saved sign-in, so it runs the client's own login over that sign-in, even when the app cannot read it now, and never uses it once more (INF-2319).
It counts only a new login: a different credential in the store, or, where the store cannot be read, a clean finish and the client's word that it is signed in.
Both login paths bypass the credential cache when taking the before and after readings under the store lease, including after a status call, so writes within one modification-date tick neither hide a new login nor count a pre-existing credential as one.
Those reads keep prompting disabled; ordinary health and allowance reads retain their modification-date cache.
A second Sign in while one is open is refused in a sentence, and a sign-in asks macOS nothing itself.
When that sign-in ends with no reason, the person is told Claude failed, and to run /login in the Claude Code CLI, whose saved login the first mate then uses.

Never let a test or probe start a real Claude sign-in.
The sign-in leg of `claudeLoginProbe.test.ts` is opt-in with `INFINITARY_CLAUDE_LOGIN_PROBE=1` and stubs the platform opener even then; no test asks a person to authorize a sign-in.

Moved verbatim from `AGENTS.md` on 2026-09-24; `docs/README.md` lists this page.

- Every `@anthropic-ai/*` import stays behind `src/core/claude/`, the same fence Pi has (Biome `noRestrictedImports`).
  The Claude client is the one the person INSTALLED (F14, captain lock 2026-09-20: "assume / require the user has already installed claude code cli"): the app ships no copy and downloads none - `electron-builder.yml` `files` excludes the SDK's platform packages (one ~300 MB binary each), `tests/release-contract.test.ts` pins the exclusion and `scripts/verify-app.sh` fails a bundle that carries one.
  `resolveClaudeExecutable` (`src/core/claude/claudeCli.ts`) finds the installed client at the installers' known homes (`~/.local/bin/claude` first, the native installer's symlink that survives its own updates), then on `PATH`, then through one bounded login-shell lookup (`primeClaudeExecutable`) - never through the SDK's copy in `node_modules`.
  `checkClaudeClient` reads `claude --version` and holds it to the SDK's co-released client version, read off the SDK's own `manifest.json`; a missing or too-old client is stamped on the account's health as `client_missing` / `client_outdated` with the one sentence the row and the chip show (`src/shared/claudeClient.ts`) - the credential is still never a sign-out, but the account serves no model and a spawn refuses.
  `INFINITARY_CLAUDE_CLI` overrides the path (a missing override path is "no client", never a fallback); `tests/e2e/launch.ts` gives EVERY e2e run `tests/e2e/mockClaudeClient.ts` unless the spec names its own, so a developer's real client is never spawned by a test.
  A spec that asks for `claudeTurns` gets the stub's turn mode: a session that runs turns goes to the SDK's own co-released client from `node_modules`, boxed into the run's throwaway HOME with a dummy key and the mock provider's address (`docs/e2e-contracts.md` "Claude turns").
  That copy is the test harness's, never the app's.
  `verify.yml` installs today's native client and runs `claudeToolSurface.test.ts` against it; on a runner with no client that test lets the SDK spawn its own copy.
  **The client TRUNCATES a tool description at 2,048 characters**.
  It also transliterates non-ASCII in one.
  A tool's schema reaches the model whole, nested descriptions and limits included, because the app serves its tools from its own copy of the MCP server (`claudeToolServer`, `src/core/claude/claudeTaskTools.ts`), never from the SDK's `createSdkMcpServer`.
  That one writes each schema with the older zod the SDK bundles, which reads a schema the app's zod built with a check (`.int()`, `.min()`, `.regex()`) as the bare type beneath it and finds only the top-level descriptions the SDK copies into its own registry.
  Until INF-744 a Claude seat was therefore served no integer, minimum, maximum, pattern, item count, length or nested description, a loss the audit had read as the client's.
  The list serves each tool's own JSON Schema, the one Pi serves, and a call is still checked against the zod `zodOf` builds from it.
  A parameter a zod schema owns is served without its lengths, item counts and closed flag (`zodParameter`, `docs/orchestrator-contract.md`), on both runtimes alike, and the tool's own parse refuses past them.
  `CLAUDE_TOOL_DESCRIPTION_CAP` and `claudeToolSurface.test.ts` are the guard - every app description under the cap (the census reads the first mate's live set through `claudeToolsOf`: `FIRSTMATE_TOOLS` in `src/core/session/tools.ts` names 23, and the seat also serves `emote`, so the live set is 24, beside every crewmate tool), and what the real client sends equal to the source - each description, and each tool's schema whole - captured against a local stub with a dummy key, for a crewmate's server and for the first mate's set on the same in-process server shape.
  A rule that must reach a Claude crewmate or the first mate on Claude lives in the description or a TOP-LEVEL parameter, never only a nested one, because no app tool describes a nested parameter (contract v4.59, below).
  Since contract v4.13 (W1 S2) the first mate's capture holds every parameter description the source declares to the served request, so a rule left only in a nested description fails it: `spawn_crewmate`'s `shape` and `start_after` rules ride each group's own description under the field's name, and `constraints[]`' ride the array's.
  Since contract v4.59 no app tool describes a nested parameter at all: `emit_card`'s nested words were a restatement for Pi, and the test names where each nested field's rule is served instead - `CARD_MECHANICS` or its top-level parameter's description, such as `actions` or `asks_again`.
  A fixed choice is one string with an `enum` (`stringEnum`), which `zodOf` reads as the same closed set.
  A two-member union with null carries that same typed value as nullable, preserving its validation on both runtimes.
  The 2,048-character cap is on a TOOL description only: a top-level parameter description arrives whole (`spawn_crewmate`'s `shape` group, 2,545 characters, is served byte for byte, and the capture holds it), so a group's rules are never trimmed to fit a cap that does not apply to them.
  The crewmate's fixed instructions, for each runtime and kind of work, are measured in `tests/crewmate-fixed-context.test.ts`, which names each tool's headroom when a description would meet the cap.
  Two more things that binary taught us the expensive way (captain dogfood, packaged build, 2026-09-01):
  - **Never spawn a path inside app.asar.**
    `child_process.spawn` cannot execute one (only `execFile` is asar-aware), and Electron's asar shim answers `fs.existsSync` for it - so the obvious check passes and the spawn fails ENOTDIR.
    `resolveClaudeExecutable` (`src/core/claude/claudeCli.ts`) still maps an in-archive override to the `app.asar.unpacked` copy and returns only a file really on disk, though no client ships in the archive any more; the trees `asarUnpack` names now are koffi's native addons, said out loud instead of leaning on smart-unpack, and `tests/release-contract.test.ts` pins them.
    Any future vendored binary needs the same treatment.
  - **The machine's default Claude login is the authority on whether it is signed in, not the client probe.**
    Every way a spawned third-party binary can fail looks identical to `loggedIn: false`, and the vault turns that into a red badge, a sign-in card AND the removal of every one of the provider's models from the routing pool (`availableModelsByAccount` gates non-Pi backends on `connected === true`).
    `ClaudeAuthBackend.status` and the allowance use the same `readClaudeStore` result (`claudeQuota.ts`): the file in `~/.claude` or the bare Keychain item `Claude Code-credentials`, with its token, advisory expiry and current config identity.
    Health reads silently and shares the modification-date cache with allowance; it has no client status poll, proactive renewal, separate evidence, expiry peek or stamp read.
    Only an absent credential is a sign-out; saved access and refresh expiry dates never establish one.
    A file that cannot be read is not absent, but a file that parses and holds no login is, and so is a Keychain item that parses and holds none: Claude Code leaves one behind when its sign-out keeps other entries or a refused renewal blanks its tokens.
    A client that answers signed in is a login, including over an expired file.
    Connect asks the client before it treats a lookup miss as a sign-out, on the store lease it already holds, and reads the store again after the wait.
    The row's Sign in over a store that holds or may hold a login runs the client's login without that question, since Anthropic already refused the login there.
    Live sessions renew their own access tokens, and an unreadable store is degraded, never a sign-out.
    With no live session, an Anthropic rejection asks the client once through `auth status --json`, then rereads; no changed credential means stale, not a claimed recovery.
- **A crewmate's tools come from one spec (primitives P7, contract v4.12).**
  Every app-owned crewmate tool - `emit_card`, `close_card`, `file_followup`, `note_progress`, `report`, `reply`, `tasks`, `lint_panel`, `place_panel`, `capture_panel`, `open_change`, `check_change`, `read_workflow`, `download_artifact`, `github_read` and `github_write` - is ONE entry (name, description, typebox parameters, run) in `CREWMATE_TOOLS` (`src/core/pi/crewmateTaskTools.ts`; the entry type and the rest of the runtime-neutral spec are `src/core/session/tools.ts`).
  The crewmate preset (`crewmateSessionSpec`) binds the entries to the crewmate's callbacks, and each session generates its own tools from the bound list: Pi's with `piToolsOf` (`src/core/pi/toolSpec.ts`), Claude's tool server with `claudeToolServer` (`src/core/claude/claudeTaskTools.ts`), which turns the same JSON Schema into zod and REFUSES a parameter kind it cannot carry rather than serving a looser schema.
  Claude passes an optional give-up signal to `ToolRun` only when the SDK handler's `extra.signal` aborts with the typed MCP `RequestTimeout` code.
  Ordinary home-stopped Claude turns and Pi turn cancellations do not withdraw a pending request; it can still receive its real answer.
  A conversation on a work computer scopes the give-up signal to the invocation and combines it with its own callback deadline.
  Background completion-refusal records run outside that invocation's scope, so a cancelled card still leaves its refusal on the home.
  There are no hand-written Claude twins any more, so a rule reaches both runtimes in one edit and the self-source map lists the same set (`crewmateTools`).
  A tool is served only when the crewmate's delegate hands the callback it runs on.
  The conversation serves the bound list with each answer too long to read whole saved to a file, on the computer that runs it: `crewmateSessionSpec` on this Mac, `SessionHost` on a computer that runs work, beside the crewmate's shell there ("Complete task reads through the tool-result cap", below).
  `prepare_change` shares this spec: on a paired computer, `inf:work:prepare-change` transfers inspected media to the home behind `CHANGE_PRESENTATIONS_SINCE` (`docs/forge.md`, "Saved change stories").
  The task's browser is no tool: the client's own shell carries the task's command, `infinitary-browser-axi`, in its environment (`docs/axi-commands.md`).
  `crewmateTaskTools.test.ts` holds both runtimes to the spec by what they serve and do, and shows that a new entry reaches both and the pin; `claudeToolSurface.test.ts` still captures what the real client sends.
  The transport rules above still bind every entry: the description under the cap, ASCII only, and a rule a Claude crewmate must see in the description or a top-level parameter's description.
  The first mate's live set is on the same spec: `FIRSTMATE_TOOLS` names 23, the seat also serves `emote`, and `claudeToolsOf` generates a Claude seat's set from the very list the Pi seat is served (the Claude seat below serves exactly that list).
- **A Claude outcome is read from typed fields, never from words (W1 S3).**
  The normalizer (`src/core/claude/claudeEvents.ts`) collects each turn's typed signals - the turn's own (main-thread) assistant message's `error` (`SDKAssistantMessageError`; a subagent's is not the turn's), the latest pushed rate-limit `status` and `resetsAt`, and the result's `subtype`, `is_error` and `api_error_status` - and `classifyClaudeSignal` (`src/shared/authFailure.ts`) turns them into `ok`, an ordinary failed turn, or a cut-off with its class (`docs/quota.md` "Typed cut-offs").
  An `error_*` result (`error_max_turns`, `error_during_execution`, ...) is a failed turn in the session's own words (its `errors`), never a clean one - except the cut a steer or an interrupt makes: a result whose typed `terminal_reason` is `aborted_streaming` / `aborted_tools` with no API error behind it is not a failure, and while the host's own interrupt is in flight a failure with no cut-off class settles as that interrupt.
  The failed turn is a `turn_failed` carrying `cutOff` when there is one, and so is a failed continuation, ahead of its `continuation_ended`.
  `CLAUDE_CONTROL_PROFILE` declares `failureSignals: "typed"`, so the supervisor reads a Claude failure by its class alone and never runs `isAuthFailureMessage` over its words; a failure with no class, or a client that exits, is never a sign-in.
  The pushed `resetsAt` is epoch SECONDS on the wire and ms everywhere past the normalizer.
  Every session runs with `strictMcpConfig: true`, and so does the model-catalog run (`listClaudeModels`), so only the app's own tool server mounts: the person's claude.ai connectors, plugins and project `.mcp.json` never reach a crewmate.
  The feed line for a Claude failure is picked by its class too (`docs/quota.md` "Typed cut-offs").
- **No session reads or writes the person's Claude notes (FI3-795).**
  The client's auto memory keeps notes per project in the person's Claude folder, under `projects/<the working copy's main checkout>/memory/` with `MEMORY.md` as their index.
  Left on, it serves that index to every session started there, and on the installed 2.1.288 the coding preset also tells the model where the folder is and to write more.
  `settingSources: []` does not reach it: on the installed 2.1.288 and the SDK's 2.1.234, a boxed crewmate, seat and question were each served a planted index.
  On 2.1.288 every crewmate worktree of a project uses its main checkout's folder, so Claude crewmates read and added to one shared set of notes in the person's Claude folder that no Pi crewmate ever saw.
  So every session the app opens sets the client's documented switch, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (`CLAUDE_SESSION_ENV` in `src/core/claude/claudeSessionOptions.ts`), over any value the host's shell has.
  The app keeps no notes of its own in their place: what a project's agents should know lives in its committed instructions (`AGENTS.md`), which every crewmate reads whatever its runtime.
  The switch leaves the person's existing notes on disk untouched.
  `claudeAutoMemory.integration.test.ts` holds it on the client the product would run, with a control that serves the planted index once the switch is taken out.
- **One Claude session, three presets (the session contract, `docs/architecture.md` §2).**
  `createClaudeSessionFactory` (`src/core/claude/session.ts`) is the one Claude implementation of the session contract (`src/core/session/`), and every role opens it through its own preset: the seat's rolling spec (`seatSessionSpec`), the crewmate's rolling spec with the coding built-ins (`crewmateSessionSpec`), and the question's one-shot (`questionSessionSpec`).
  The factory never sees a role name; what differs is only what the spec carries.
  The three bullets below are those three presets.
- **The first mate seat on Claude (W1 S6; live since the flip, S12, `docs/architecture.md` rev-9).**
  `createClaudeSessionFactory` (`src/core/claude/session.ts`) serves the seat preset's rolling spec (`seatSessionSpec`) behind the seat seam (`docs/architecture.md` §2); the composition root injects it beside Pi's (`src/core/services.ts`), with the machine's default config dir, the host's ticker and the account's quota readings, and the spec's record dir names the app's transcript store under `userData/firstmate/claude/`.
  A Claude account seats the first mate once the captain picks a Claude model, or when Claude is the only subscription that can answer.
  `tests/e2e/claude-seat.spec.ts` (a captain turn answered with a card, a spawn, a mid-turn steer, the picker) and `claude-seat-cutoff.spec.ts` (a 401, a 429 with its reset and a 403 organisation refusal, each on its own card with the words kept; "Try Claude again"; a new sign-in) run it end to end on the SDK's own client against the mock provider (`tests/e2e/claudeSeat.ts`).
  It stands on the crewmate's core (`claudeQueryCore.ts`: the input queue, the user message, the pump that normalizes and routes each result) and its options are the rolling branch of one pinned function, `claudeSessionOptions`, read off the spec: the default login and nothing ambient (`claudeEnvFor`), `settingSources: []`, the prompt as `[buildFirstmateSystemPrompt(), SYSTEM_PROMPT_DYNAMIC_BOUNDARY, instructions]`, `tools: []` with the live set of 25 always-loaded on the app's server, each declaring the seat's 200,000-character result band (below), and `strictMcpConfig`, `bypassPermissions`, partial messages, `effort: "low"`, `maxTurns: 40` and `CLAUDE_CODE_MAX_OUTPUT_TOKENS=8192` from the seat's request bounds, the binding's model, `resume` or the minted `sessionId`, `--replay-user-messages`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (`CLAUDE_SESSION_ENV`, above), `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`, `CLAUDE_CODE_DISABLE_ATTACHMENTS=1` and `MAX_MCP_OUTPUT_TOKENS=100000` (`CLAUDE_SEAT_ENV`, below).
  The seat session keeps these rules, held by `claudeFirstmateSession.integration.test.ts`:
  - **A steer rides `priority: "next"`.**
    Pushed while a tool runs, `next` folds the message into the running turn after the tool's result and the exchange ends in one result - Pi's steer.
    `now` aborts the tool in flight (the model reads an error for it) and answers in a second turn; `later` waits for the turn to end.
    The integration test measures all three on every run and pins the choice.
    The measurement uses three turns on one rolling client and one uninterrupted output consumer, waiting for idle between them; cold starts are not the priority behavior being measured.
    Each named case owns its API server.
    The shared seat box owns every session it opens, registered tool gates and transcript watchers, and raw-query drains: `seatBoxesFlushed` aborts abandoned work, disposes sessions, advances their existing client-hygiene clock, awaits exits and consumers, then flushes sidecars and removes scratch homes and client folders before the next case.
    A real-client regression abandons an inference and a held tool at that boundary and checks that their requests, leases and homes are gone.
    `INFINITARY_CLAUDE_SEAT_EVIDENCE=1 pnpm exec vitest run src/core/claude/claudeFirstmateSession.integration.test.ts` prints credential-free request and transcript evidence for output caps, priority and cleanup.
  - **One turn and one life state** (`claudeRollingSession.ts`) own the rolling session: a turn is idle, starting (with early steers and a remembered stop), or running by prompt or continuation; life is open, disposing, disposed or retired.
    The starting turn's object identity rejects a late attachment, and one `settle()` returns unread steers and ends either kind of turn.
    The query core reads the session's interrupt and disposal state; it stores neither.
    A stop asked while the client is starting waits for the prompt to enter its input, then interrupts it; a safe stop still keeps an unstarted prompt out of the client entirely.
  - **A prompt settles when the client says it is idle** (`session_state_changed: idle`, emitted once every queued turn is done, which the environment variable turns on), not on a result: a steer answered in a turn of its own still settles the prompt once.
    A client that never reports its state settles on the result that follows the last acknowledged message.
  - **Every pushed message carries a uuid**, and the client acknowledges each by it (`isReplay`) as a turn takes it in.
    A steer that no turn took in (it arrived while nothing ran, or the client exited first) goes back through `takeUndeliveredSteers`.
  - **Effort per turn** is `applyFlagSettings({effortLevel})` before the prompt; it reaches the very next request, mid-turn included.
    A mid-turn instruction change is refused.
    A resumed client serves the system prompt it recorded when the session started (its `prompt_snapshot`, measured on the installed 2.1.283), not the one it is handed, so a seat never resumes on a changed prompt array: at every reattach - an idle-boundary `serveInstructions` and an open with `resume` - the session compares the array it would serve (the prompt, instructions and tool shas) with the contract its client started under (the newest `contract` stamp in `<id>.served.jsonl` before its first `served` one), and when they differ and the client has recorded the session it starts a new session under a new id with the new array rather than resuming.
    It says so once (`takeRenewal`), and the first mate carries it as a seat move (`docs/architecture.md` §16): a `seat renewed` ledger row naming what changed, the `seat-moved` wake with the bounded digest of the turns the new session has not seen, on the turn about to be served, and a feed line.
    Unchanged instructions keep resuming the same id, and the app's copy of the old session stays.
    The client records each tool's description there too (measured on the installed 2.1.295): on resume a tool the session had keeps its recorded words.
    It records the tool list as well (measured on the installed 2.1.306): on resume a tool it lacked never arrives, and a tool gone is still offered.
    Both roles' stamps name each tool's own sha (the seat's `firstmateContractStamp`, a crewmate's below), so a session also starts over when a tool it had is described differently or a tool came or went, and an update that only rewords, adds or removes a first mate tool moves the seat as a changed prompt does.
    A seat started before its stamp named each tool has only the whole tool surface's sha to compare, and starts over when that moved.
    The seat's tools are described the same at every open of one build (nothing a description or schema says depends on the app's state), so a relaunch of the same build resumes.
    A recorded session with no contract stamped before its first prompt started under one nothing vouches for, and starts over too.
    The integration test holds all four on the installed client (the SDK's own on a machine without one): the reopen, the unchanged resume, the change found at open, and a reworded tool found at open.
  - **Tool names** arrive as `mcp__infinitary__<name>`; the seat reports the bare name, as the Pi seat does.
    Served instructions name the app's tools bare, so a model sometimes calls one by that name, and the client refuses it with its own "No such tool available".
    A Claude crewmate's backend note (`crewmateBackendNote`, `src/core/pi/piResources.ts`) names its output tools in full and says that every short name in its instructions is called as `mcp__infinitary__<name>` (INF-3060).
    The first mate on Claude reads the same sentence after its prompt (`buildFirstmateSystemPrompt("claude")`, INF-3718); its prompt on every other backend is unchanged, and the seat's contract stamp carries the served prompt's sha.
    Every Claude session that serves the app's tools (the seat, a crewmate, a one-shot) carries a `PostToolBatch` hook (`claudeToolNameHint`, `src/core/claude/claudeTaskTools.ts`) that adds the full name to that same result, so the next call is the right one (`claudeToolNames.integration.test.ts`).
  - **The runaway bounds ride the one clock**, kept by the one watcher both backends share (`src/core/session/bounds.ts`, its own `session-bounds` registration): the 300-second per-inference bound (restarted at every request - the session says `request_started` at each `message_start` - and at the last tool's end, stopped while a tool runs) and the 20-minute turn backstop cut the turn with `abort(failure)`, which interrupts the client and fails the turn with the bound's sentence.
    Once the interrupted result lands, both clocks start again: a steer the client still holds is answered in a turn of its own under its own bounds, and a bound that fires on that turn is reported as the first was.
    The session's own `claude-sessions` registration keeps the client's hygiene: a client that does not answer that interrupt within a tick is stopped and the turn fails anyway, as is a client still running a tick after its input ended.
    Every other interrupt is watched the same way - a plain `abort()`, a crewmate's interrupt, and the one a dispose sends - so a client that stopped answering is stopped a tick on and its turn ends quietly, and nothing waits on it for good (`src/core/claude/interruptWedge.integration.test.ts`).
    The output cap (measured on 2.1.234 and 2.1.283): the client serves it as every request's `max_tokens` with the model's thinking inside it (adaptive on Fable, Opus and Sonnet; a budget one below the cap on Haiku 4.5), and asks an answer that runs past it to carry on three times before it fails the turn with a typed `max_output_tokens` error, which the seat reports as "Answer kept running past the 8192-token limit" rather than the client's own words (`docs/firstmate-runaway-hardening.md`).
  - **Quota and usage**: a pushed plan reading goes to `onRateLimit(accountId, reading)`, the factory's one quota wiring for every role; matched completed calls can record usage before the result, whose remainder is the share the client states for that result (or, from a client that states none, its delta over that client's running total) less calls already recorded, recorded by the agent under `taskId: "firstmate"` (`docs/usage.md`, "Claude calls during a turn").
    `checkClaudeClient` runs at the seat's create and again at every client attach inside it, before that client's store lease is taken, so a client removed between turns fails the turn with its sentence.
  - **The lease** (`acquireSessionLease`) is per client: each attach takes it (waiting out a sign-in in progress) before the client is spawned, and it is handed back when that client has EXITED - not when a dispose returns, because the client writes the last of its transcript as it exits and can refresh its login until then.
    A dispose or a detach ends the client's input and lets it exit on its own; a client still running a tick later is stopped.
    Between clients nothing is leased, so an idle rejection can ask the client once.
    An attach can outlive its prompt (the bounds give up on a prompt whose attach still waits behind a sign-in), so after each wait it checks that its prompt is still the open one and spawns nothing otherwise - no orphaned client holds the store behind a later attach, a detach or a dispose.
    Each new client also starts the normalizer over: its usage counts from zero, and nothing the last client pushed classifies its first turn.
    `detach()` (on the session contract) ends the client at an idle boundary - after the open prompt settles, never mid-turn - and resolves once the store is free; the next prompt reattaches and resumes.
    The agent calls it while the seat is paused on a cut-off, and before a sign-in or sign-out rewrites the bound account's store (`AccountVault`'s `holdSeat` → `FirstmateAgent.holdSeatFor`, which also keeps the seat off that account until the rewrite ends; `docs/architecture.md` §16.8).
    `closed()` resolves once a disposed seat's client has exited.
  - **The record.**
    The client writes its transcript on its own schedule (at `idle` its file can still be empty; the rest lands a moment later, and on exit).
    The session copies it into the app's store (`SessionRecordStore`, `src/core/storage/sessionRecordStore.ts`; the seat's is `userData/firstmate/claude/<id>.jsonl`, byte for byte, never spliced when the client's file stops extending the copy) at every boundary where it can grow: idle, reattach, exit, each host tick while its client is attached, and a copy order's refresh from the home (`docs/helper.md`, "The record's copy").
    A pass reads only what the copy gained (the tail it compares is read in place), and the copy's parsed entries are kept and extended rather than re-read at each turn.
    The parsed entries are kept only while the session uses them: a renewal lets go of the old id's, and a session that ends lets go of its own once its record is final (`SessionRecordStore.release`), so the app never holds every session it has run (INF-2392); the copy on disk stays, and a later read parses it again.
    The seat also reads ahead (`SessionRecordStore.catchUp`): once a recorded session opens and while each turn runs, it parses the copy's new lines and hashes its chain one line per turn of the event loop, so a turn's close parses and hashes only what the turn added (INF-2408, `docs/provenance-capture.md`); a read-ahead stops when its copy is let go of, and the chain's hash is let go of with the entries.
    Rolling sessions keep discovered client paths; a missing path searches the project folders asynchronously, sharing concurrent discovery and retrying misses when the client writes later.
    Completion following awaits that discovery before its baseline and each scan, and its owner awaits the final scan before closing the completion index.
    Known-path copies remain immediate; attachment, explicit refresh and retirement wait for discovery, so a new task never walks all Claude project folders on the main thread.
    Beside it, `<id>.served.jsonl` stamps the contract (version, prompt, instructions, tools shas) and each prompt's acknowledged uuids (`docs/provenance-capture.md`).
    A resume reads the client's own transcript; an id it has none for (a crash before the first turn, or the client's 30-day sweep) starts fresh under a new id, and the app's copy of the old session stays.
    A crewmate's session that opens under another id than the one it was asked to resume, with no renewal to say why, is carried as one that could not be reopened (`CrewSessions.openCrewmate`).
    The Settings purge removes that copy with the rest of the first mate's transcripts (`docs/task-retention.md`); the client's own file is not the app's to delete.
  - **Not the SDK's session store.**
    `Options.sessionStore` (`@alpha`) mirrors fine, but resuming from it makes the SDK itself read the person's Claude credential (`security find-generic-password` on the default Keychain item, or `.credentials.json`), write it into a temporary config dir without its refresh token, and run the client there - the app never reads a provider token, and a client without its refresh token cannot renew mid-session.
    So the seat takes the plan's fallback, the copy above.
    (The SDK also drops every mirror frame from a client whose config dir differs from its own idea of it, silently.)
  - **The dynamic boundary** reaches a non-first-party base URL as literal text (`...prompt\n\n__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__\n\ninstructions`, measured against the stub with both a key and a subscription token); whether the first-party API splits it there is unmeasured.
  - **What the client adds to the seat.**
    Beside the app's prompt, tools and the captain's words, the client adds attachments of its own, recorded in its transcript and served to the model.
    One documented switch reaches part of it: `CLAUDE_CODE_DISABLE_ATTACHMENTS=1` (the vendor's environment-variable reference: "disable attachment processing") turns off the client's per-turn extras, and the seat sets it (`CLAUDE_SEAT_ENV`).
    That keeps out `silent_turn_reminder` ("The user hasn't heard from you in a while ...", served into a run of tool calls without a word) and `total_tokens_reminder` (a token countdown after every request); the first mate's turn ends with brief output by contract and the captain hears it only through the app, so neither is the seat's to receive.
    Queued steers still arrive.
    A crewmate's coding session keeps the extras.
    What no documented switch removes is served once at the start of every client attachment, and is the accepted exposure:
    - `environment`: the seat's working directory (the app's first mate home, under the person's user folder, so it names their account on the machine), whether it is a git repository or worktree, the platform, the shell and the OS version.
    - `session_context`: the signed-in Claude account's email address, with the client's instruction to use it only to identify the person.
    - `model`: the served model's name, id and knowledge cutoff.
    - `date`: today's date.
    - `prompt_snapshot`: the client's own record of the system prompt it served, which is the app's.

    Accepted because each goes only to Anthropic, the provider the person signed in to, or to the gateway their own or their organization's Claude Code settings name ("Access a company set up"), which already holds all of it from the login and the request itself, as Claude Code sends it there too; none of it is a credential; and none of it asks the first mate to do anything.
    The switches that would remove it cannot be used: `--bare` (`CLAUDE_CODE_SIMPLE`) is the documented mode that trims them, but it never reads the OAuth login, and the app serves only the person's own login (F14).
    `excludeDynamicSections` moves the working directory rather than removing it and applies only to the preset prompt, which the seat does not use.
    `claudeToolSurface.test.ts` holds the set on the client the product runs (`verify.yml` points it at today's native install): the seat's session on the boxed client, with a made-up account email and a quiet run of tool calls, may carry only the attachment types above, `environment` only the fields above and `session_context` only the email, so a client that adds one fails there instead of reaching the first mate unseen.
  - **Hermetic runs** box the SDK's co-released client with the e2e stub's turn mode and `credential: "subscription"` (a dummy subscription token, with which the client pushes plan readings a key never gets) against a local stub of the Messages API (`tests/helpers/anthropicDialect.ts`): a 401 classifies `signed_out`, a 429 with `rejected` unified headers `no_headroom` with its reset (the client pushes the `rejected` reading before it reports the error), a 403 organisation refusal (`oauth_org_not_allowed`) `refused`.
    `claudeFirstmateSeat.live.test.ts` runs the same seat on the machine's own login, only with `INFINITARY_CLAUDE_SEAT_LIVE=1`, never in CI, and never starts a sign-in.
- **The crewmate on Claude (the session contract's step 5).**
  A crewmate's coding session is the seat's rolling session with the coding built-ins (`src/core/claude/claudeRollingSession.ts`; there is no second Claude coding path): the client's own `claude_code` preset with the crewmate's instructions appended, every one of the client's own tools beside the app's tool server, and the effort `claudeCodingReasoning` opens at.
  A recognized Opus, Sonnet, Fable or Haiku 5.5 model is served a coding rung (`effort` on the query); legacy Haiku and an unknown model omit `effort` and keep the client's own, and a coding session does not serve `thinking`.
  Its Agent tool offers the client's own agents and any an administrator put in the machine's managed Claude folder, never the person's own: `settingSources: []` reads no definition from `~/.claude/agents`, the working copy's `.claude/agents` or a folder above it (`claudeCrewAgents.integration.test.ts`).
  It carries its working copy's own instructions and skills, the same ones a Pi crewmate is served (`src/core/session/projectResources.ts`, FI3-789), without turning the client's project settings source on: that source also applies the project's `.claude/settings.json` (its hooks, permission rules - a switch there can turn the session's permission bypass off, and no app-supplied layer turns it back on - environment, credential helpers and output style) and every instruction file in the folders above the working copy, the person's own `~/.claude/CLAUDE.md` and `~/.claude/skills` among them when the working copy sits under their home.
  So each attach reads the working copy's AGENTS.md (or its CLAUDE.md where it has none) into the appended prompt, framed as Pi frames its own, and stages its `.claude/skills` and `.agents/skills` folders as a local plugin named `project` in the session's own staging folder beside its record (`claudeProjectResources.ts`): a manifest and one link per skill folder, which the client lists as `project:<skill>` and loads with its Skill tool.
  Every coding session passes the client's attribution setting with empty text, `settings: { attribution: { commit: "", pr: "" } }` (`CLAUDE_CODING_SETTINGS`), so the client never tells the model to end a commit message with a `Co-Authored-By` trailer or a pull request description with a "Generated with Claude Code" line (the captain, 2026-10-15: "disable commit and PR author attribution for all claude crewmates in infinitary (it's a claude setting)").
  It rides the client's flag settings layer, which `settingSources: []` leaves on, so the person's own Claude settings stay unread, but for the token command, address and gateway headers below ("Access a company set up").
  `claudeAttribution.integration.test.ts` holds it on the client the product would run, with a control that serves both lines once the setting is taken out.
  Every coding session also sets the client's documented `BASH_MAX_TIMEOUT_MS` to 3 days (`CLAUDE_CODING_ENV`; the captain, 2026-11-04: "change highest to 3 days, not 24 which is too much"), over any value the host's shell has.
  The client counts a command's limit from its start, so a heavy run waiting in its computer's line ([heavy runs](heavy-runs.md)) spends its limit while it waits, and left to its default the client stops a background command after 2 hours at most.
  The client honors a command's own limit up to that ceiling, so a heavy run started with a 3-day limit outlives its wait; one started without a limit still gets the 30-minute background default.
  `BASH_DEFAULT_TIMEOUT_MS` stays the client's own, since it is also the 2-minute limit of every ordinary command started without one.
  `claudeCommandTimeLimit.integration.test.ts` holds it on the client the product would run: the Bash tool the client serves states a 3-day ceiling, for background commands too where the client has a background limit, beside the client's own background default, and a control serves the client's own ceilings once the setting is taken out.
  With a plugin staged the same settings also carry `disableAllHooks: true`, so a hook a skill declares never runs.
  The app's own hooks on the query still run with it (measured on the installed 2.1.319 and the SDK's own client), which the full-name hint above relies on.
  The safe stop before an update (`stopSafely`; `docs/alpha.md`, "Saving work before an update") is a `PreToolUse` hook on the query (`toolGate`) that refuses each call the client asks about once the stop stands; with the client's hooks off it still waits for each call the client says it began, and cuts the turn once none runs.
  With Global instructions and skills on, each attach also reads the home's global instructions, from this Mac's home folder on the home or the copy kept on a computer that runs work, and stages its personal skills as a second local plugin named `personal`; project names win, settings sources stay empty, hooks stay disabled and strict MCP stays on (`docs/personal-resources.md`).
  Each turned-on Claude Code plugin with a skill to serve is staged as a local plugin of its own under its own name, with a manifest the app writes, links to its skill folders and its other own files, and none of its hooks, MCP servers, agents, commands or other parts, so the client lists `<plugin>:<skill>` and a skill's `${CLAUDE_PLUGIN_ROOT}` reaches the files it names (`docs/personal-resources.md`, "Claude Code plugins").
  The client resumes a session on the prompt it recorded at its start, so a project instruction file changed mid-task reaches a Claude crewmate's next fresh session, while the skills are staged afresh at every attach.
  Every session of a task records into one folder and two can be open at once, so each session stages its project, personal and runbook skills in a folder of its own under it, `staged/<id>`, held until the session retires (`src/core/session/stagingFolders.ts`, INF-2054).
  The next claim removes every folder no open session holds, and a stage that fails costs its skills and a line in the log, never the attach.
  A reopened crewmate with changed personal resource digests or opt-in renews its conversation through the existing renewal seam, keeping the old record, so it never resumes with stale personal instructions.
  So does a crewmate reopened by a build whose crewmate prompt, or the description of a tool it had, changed, and one recorded before crewmates were stamped, so it never runs this build's tools under an earlier build's words.
  So does one whose task gained or lost a tool, since the client would serve the tool list it recorded, offering the lost tool and never the new one (`claudeCrewContract.integration.test.ts`).
  The supervisor notes the move on the task's timeline and records the new conversation at once.
  Why, the task's key, where the earlier transcript is saved and the brief its first turn served are a once-named wake on the task's lane (`conversation-restart`, rendered by `renderWake` from `crewmateRestartText`).
  The turn that brings the crewmate back serves that wake first, so the reason rides the same message, and a quit before that turn ends clean still delivers it.
  A conversation that could not be reopened at all is carried the same way.
  A conversation on a computer that runs work is carried the same way whether the home opens it there or reopens it after that computer restarted (`docs/helper.md`, "That computer restarts").
  `claudeProjectResources.integration.test.ts` holds this on the SDK's own client, boxed, with a working copy under the box's HOME.
  It shares every rule above - the `next` steer that folds after the tool in flight, the idle settle, uuid acknowledgements and `takeUndeliveredSteers`, the lease per client attach (nothing is leased before the first prompt), the resume that starts fresh under a new id when the client has no transcript for the old one, and bare tool names.
  Its record is the app's copy too, in its task's `crewmates/<taskId>/sessions/` beside a Pi crewmate's file, with a sidecar of served stamps and the crewmate's contract (the session contract's step 6): the prompt exactly as served, the tool surface and each tool's own sha (`crewmateContractStamp`).
  Its client stays attached between prompts, so the tail the client writes after a turn's `idle` is copied on the host's next tick rather than at an exit.
  What only a coding session meets, held by `claudeSession.integration.test.ts`: a command the model started in the background finishes after the prompt's turn, and the client then runs a turn of its own, announced by the same `running` and `idle` a prompt's turn has.
  The session reports that turn as `continuation_started` and `continuation_ended` from those two signals alone, never from guessing at activity; a steer sent meanwhile joins it, and a continuation the provider failed is a `turn_failed` like a prompt's.
  The supervisor re-parks a steer no turn took in on either backend (`docs/inbox.md`).
  A completed call can report its tokens and client-priced cost through the private local export before the turn ends (`docs/usage.md`, "Claude calls during a turn").
  A turn's unrecorded usage remains in its `result`, and an interrupted turn's `result` lands after `abort()` returns (the interrupt's round trip is all it awaits).
  So every teardown that lets go of a crewmate mid-turn - a close (`closeTask`: an answered card, a confirmed discard, a parent retiring its reviewer), an escalation, the retention purge, the quit - hands the session to a usage-only listener (`CrewSessions.releaseSession`) until `closed()`, and the cut turn lands in `usage_events` once; the task's own subscriber is gone, so the closed task's state and feed are untouched.
  The quit waits at most `QUIT_SETTLE_MS` (2 s) for those turns; The close/quit integration fixture waits for the foreground command's own ready marker, not `tool_start`: that announcement can precede the request's trailing usage events, and interrupting there can produce a zero-usage result before the command ran.
  The fixture holds those trailing events until the announcement, then completes the request and waits for the marker before cutting the turn.
  The client exits only after its input closes, and on a loaded machine that exit can come after the quit's bound, so the quit case checks the store is free once the released session's `closed()` resolves, never at the moment the quit returns.
  A crash, or a client that does not answer, still loses that turn's usage.
- **The model that answers (FI3-967).**
  A rolling session asks every attachment for one model: the spec's, else the model a resumed session ran on before the client swapped it, else the first one the client reported.
  It reports the model the client says answers (`modelRef`, and so a card's model chip): the `init` message's model, and Claude Code's `model_refusal_fallback` notice when the model it asked for refused a reply and the client answered on another for the rest of the session.
  A notice with `scope: local` is a subagent's or side question's answer alone and moves nothing; one with no scope comes from an older client and means the session's.
  The client's own marks (`[1m]`, a dated snapshot) name the same model (`canonicalClaudeModelId`).
  Each change reaches the owner as the owner-only `model_served`, with the notice's original model and the provider's category (`cyber`).
  The supervisor writes the model onto the task record whenever it is not the one the record names (`CrewTurns.recordServedModel`), so the crew's labels and the task's own fact strip name the model doing the work, and a note on the timeline and the feed says what moved it; the routing ledger keeps the router's decision.
  When the model answering is not the one the task's newest routing choice asked for, the first mate is told once per pair of models (`model-unasked`, INF-1272): both models by their Settings names, whether the client fell back after a refusal or opened on another model, and whether the captain named the asked one, so it can tell them.
  A reattach asks for the model the session was asked for, never the one the client swapped in.
  So does a resume that names no model: the client (2.1.289) restores a resumed session's last model and keeps a fallback it finds in the transcript, so the session reads the first session-wide fallback in the app's copy and asks for its original model.
  A crewmate's reopen names one wherever it can (INF-1272): the supervisor asks for the model of the task's newest routing choice, its start's or its newest move's, at the effort a move works out - the captain's word on the task, else the model's Settings choice, else the level's default - here or on a computer that runs work (`CrewSessions.reopenedOn`).
  A model no level, pin or standing-in default holds any more is first routed away from, wherever the conversation opens (`docs/routing.md`, "A model that left every level"); the reopen still asks for it when the newest choice named it, and waits instead when no other model can take its place.
  A conversation that starts over after an update has no transcript to restore a model from, and the client opens it on its own default (Sonnet 5.5 on the installed 2.1.309), so without this a Fable task answered on another model and the timeline said it moved.
  A fallback is not a routing choice, so a reopen after one asks for the original model; a task that never routed opens as its session restores it.
  The crew contract's integration test holds it on the installed client: the new conversation's first request carries the model it was handed.
  The client books a fallback's retry under the model that answered it, so that turn's usage has a row per model (`docs/usage.md`).
  The app leaves the client's fallback as the client ships it: it passes no fallback model and does not set `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK`.
- **The kind classifier on Claude (W1 S10).**
  `createClaudeSessionFactory` (`src/core/claude/session.ts`) is Claude's `SessionFactory` on the one session contract (`src/core/session/`), and for the question it serves the one-shot shape: the question's session (`questionSessionSpec`), the adapted decision model's session for a Claude-served model (`docs/decision-models.md`).
  A machine with only Claude signed in classifies work on it.
  Since the contract's step 3 it also serves the rolling shape, the seat's (above), and since step 5 the crewmate's coding session on that same rolling shape (above); a one-shot spec that asks for the coding built-ins is refused.
  It stands on the same core and makes ONE query, its options one pinned function read off the spec (`claudeSessionOptions`): its account's login - the default one, or a further login's folder ("Further logins") - or for the default login the token command, address and gateway headers set up for Claude Code as flag settings ("Access a company set up"), and nothing ambient (`claudeEnvFor`), `settingSources: []` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, the question's instruction as the only system prompt the app supplies (the client adds its identity line and a date reminder), `tools: []` and `strictMcpConfig`, `maxTurns: 1`, `effort: "low"` from its thinking level, `persistSession: false` (no transcript), partial messages, the bound model.
  The question preset leaves Claude's output allowance to its client, and a one-shot clears an ambient `CLAUDE_CODE_MAX_OUTPUT_TOKENS` before applying any explicit request bound.
  Claude counts hidden thinking inside output, so Pi's 64-token answer cap can stop Sonnet 5.5 before any text exists even with `thinking: { type: "disabled" }` requested (INF-1451).
  There is no universal off switch: [Anthropic's thinking reference](https://platform.claude.com/docs/en/build-with-claude/thinking#configuring-thinking) says Sonnet 5.5 uses `between_tools` to skip thinking without tools, while Opus 5.5 and Fable 5.2 cannot disable thinking; the installed client's supported modes do not include `between_tools`.
  Low effort, one question, no tools and the adapter's 15-second wall clock still bound the classifier, and Pi's own cap stays unchanged.
  The client is spawned only when the question is asked, after `checkClaudeClient` at create and the account's shared store lease, which it holds until the client has exited.
  The one result settles the question - its closing words, its usage, or a `turn_failed` with the typed class, which the adapter records on the account - and ends the client's input.
  An answer the output cap cut short is read off the first request - its typed `max_tokens` stop rides the streamed `message_delta` - and the client stopped, because `maxTurns` does not stop the client's own output-limit recovery, which re-asks within milliseconds up to three times; the one re-ask already sent is dropped unanswered.
  `abort()` gives the question up at once and stops the client; the session closes, and the lease comes back, once the client has exited ("The client's process", above).
  An explicit session output cap still reaches the client and its typed `max_tokens` stop is still read; the question preset simply supplies no answer-only cap to Claude.
  `claudeClassifierSession.integration.test.ts` runs it on the boxed client against a local stub API, beneath the real kind question: a cold spawn plus one turn answers inside the adapter's wall clock, serves no tools, reads a captured Sonnet thinking-only cutoff as a completed kind once the request has room, reads a cut-short answer with one re-ask dropped, and leaves no transcript.
  A cancel and a 401 or 403 refusal on that client are the session contract's question cases below, and `decisionKindClassifier.test.ts` owns how a cut-off reaches the account.
  The same file runs `pnpm score:kinds --provider anthropic-claude` on that boxed client.
  The session contract's shared suite (`tests/helpers/sessionContract.ts`) runs the question's cases on Claude twice, scripted (`claudeSession.contract.test.ts`) and on the same boxed client (`claudeSession.contract.integration.test.ts`), and on real Pi against the same stub API (`pi/piSession.contract.test.ts`), with identical assertions.

## Further logins

The captain's own computer holds several Claude logins: Settings offers "Add another Claude login" once one Claude account is connected.
The first account stands on the machine's default login, as before.
Each one added beside it is a login of its own (`ownLogin` on its saved record, `AccountVault.add`), in an owner-only Claude Code folder inside the account's store, `accounts/anthropic-claude/<account>/claude/` (`claudeLoginFolder`), and binds as `{ via: "config-dir", configDir }`.

- **Sign-in is the client's own.**
  `ClaudeAuthBackend.login` runs the installed client's `auth login` with `CLAUDE_CONFIG_DIR` naming the folder, through the same browser or pasted-code flow as the first login.
  Nothing is pasted into or copied by Infinitary, and a sign-in that does not finish leaves no account and no folder.
- **The client's word is the sign-in state.**
  Health comes from `claude auth status --json` run with that folder, kept for five minutes (`OWN_LOGIN_STATUS_TTL_MS`) and asked only while no session holds the folder's lease; while one does, the last word stands.
  Infinitary never reads the folder's credentials or its Keychain item, and that status carries no expiry, so a further login's row never says when its sign-in ends.
  Renewal is the client's, inside its sessions.
- **Sessions run in the folder.**
  `claudeEnvFor` sets `CLAUDE_CONFIG_DIR` for a further login's client and leaves it unset for the first, and each folder has its own store lease.
  The folder comes from the account's own binding (`claudeLoginDirs`): a session for an account the vault no longer holds is refused, never run on the default login.
  A person's own token command, gateway address and custom headers ("Access a company set up") reach only the first login's sessions, sign-in commands and model list read: a further login's client is handed none as settings, and `claudeEnvFor` drops custom headers the app's own environment inherited.
  What an organization manages is read by the client itself in every session.
  The client keeps a session's transcript in the folder it ran in, so a conversation resumes only on the login that held it.
  `claudeFurtherLogin.integration.test.ts` holds the folder, the settings rule and the refusal on the client the product would run.
- **The model list is each login's own.**
  `claudeListReader` asks the client as the account's login, a further login in its folder under that folder's lease and without the person's gateway settings.
- **Usage is pushed only** (`docs/quota.md`, "A further Claude login").
- **Removing it** runs the client's `auth logout` in the folder, holding the folder's lease, and then deletes the folder; a sign-out that fails still deletes it.
  Removing the Claude login the first mate runs on, the first one or a further one, puts a line in the feed: the first mate will use another Claude login when it next runs, when one can seat it now, and otherwise no other Claude login can run it (`firstmateLoginRemovedLine`).
  The line promises no turn: a login with a spent allowance can hold the seat and still pause it.
  The first login's store is never touched.
- **The first mate may sit on any of them**: `SEAT_BINDINGS.claude` names both bindings.

A computer that runs work keeps one Claude login: its session host does not run accounts in folders, so a second Claude account there is refused and the chip stays unavailable.
A moved project's or home's transcripts and the observer's transcript source read the default folder only.
A build from before further logins would take an account record marked `ownLogin` for the default login, so a folder that holds one is marked for that build to refuse, until the last further login is removed (`docs/saved-data-compatibility.md`, "Further Claude logins").

## App-owned automatic compaction

Every Claude session enables auto-compaction through the app's flag settings, including one reopened from a saved conversation.
`CLAUDE_COMPACTION_SETTINGS` sets `autoCompactEnabled: true` and `autoCompactWindow: 321192`: the app's 300,000-token summary point (`SESSION_COMPACTION_TOKENS`) plus the first mate's 8,192-token answer allowance and the client's 13,000-token compaction buffer.
The client clamps that window to the model's own context window, so a smaller model compacts earlier without a second catalog in the app.
The session environment removes `DISABLE_AUTO_COMPACT`, `DISABLE_COMPACT`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` and `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE`, so a person's shell cannot disable or enlarge this app-owned budget.
The person's Claude configuration stays untouched.
`claudeSeatOverflow.integration.test.ts` drives the real boxed client through growing first mate context with the global opt-out and environment switches set, on a large-window model and Haiku's smaller window.
A failed result whose typed `terminal_reason` is `prompt_too_long` carries `contextOverflow: true`; words alone never declare it.
The first mate's bounded fresh-conversation recovery is documented in `docs/firstmate-runaway-hardening.md`.

## Complete task reads through the tool-result cap

Claude Code 2.1.299 defaults to a 25,000-token MCP output cap, overridable by a positive `MAX_MCP_OUTPUT_TOKENS` or the client’s positive finite `mcp_tool` configuration.
Its text estimate is `Math.round(text.length / 4)`; estimates at or below half the cap bypass token counting, while larger results go through the client’s token counter before it decides whether to substitute a saved-file notice.
The default unconditional acceptance band therefore holds 50,000 text characters, not 100,000: the full token cap is not a safe character conversion.
A first mate has no file tool with which to recover the client’s saved file.
First mate Claude sessions pin `MAX_MCP_OUTPUT_TOKENS=100000` through `CLAUDE_SEAT_ENV`, overriding an ambient value and taking precedence over the client’s remote configuration.
The first mate’s explicit cap gives that client a 200,000-character unconditional band; coding and classifier sessions receive no such host override.
The client also has a second, separate limit: it saves a tool result longer than 50,000 characters to a file and serves the model a 2,000-character `<persisted-output>` preview, whatever the token cap.
A tool raises that limit by declaring `_meta["anthropic/maxResultSizeChars"]`, which the client honors up to 500,000 characters (2.1.303, and the SDK’s own 2.1.234).
Every first mate tool declares `CLAUDE_FIRSTMATE_TOOL_RESULT_CHARACTERS` (`claudeToolServer`), the same 200,000 characters derived from the seat’s cap, so a first mate result of up to 200,000 characters reaches the model whole and a longer one becomes the preview.
A coding session’s tools keep the client’s 50,000-character default, and no crewmate answer reaches the client past it.
Every crewmate tool answer longer than `ANSWER_WHOLE_MAX_CHARACTERS` (50,000 characters, derived from that same band) is saved whole in the task’s temporary folder, under `answers/`, and the model reads the file’s path between backticks (a task’s folder on a Mac holds a space), the answer’s size and how to read it in its place (`serveAnswerFiles`, `src/core/session/answerFiles.ts`).
The answer stays a success.
Without it, the client would save a longer answer in its own folder and serve the model its 2,000-character preview, or, past its token cap, an error naming that file, and Pi would hand the model all of it.
It adds no paging of its own: the crewmate reads the file in parts with its file tools or searches it with its shell.
A file that cannot be written leaves the answer whole, since the call has already done its work.
The first mate’s tools never go through it: it has no file tools.
Two of the client’s remote switches can still save a shorter result: a limit it sets for a tool by name, and a per-message budget that saves the largest results of one message’s parallel calls once together they pass 200,000 characters.
The `tasks` tool pages a by-key read that does not fit one answer, by field and offset, instead of compressing it (`docs/task-record.md`, “By-key closing resolution”); it never drops distinct content.
A read whose original heading and indented JSON fit 50,000 characters stays byte-for-byte unchanged on every provider.
That page size remains independent of the first mate’s larger Claude cap.
It is `ANSWER_WHOLE_MAX_CHARACTERS` itself, so a full page reaches a crewmate’s model whole and never goes to a file.
Every page of the original accepted-plan fixture and the larger INF-91 design record must fit that unconditional band (`tests/account-eval.test.ts` and `taskTools.test.ts`, with the verified client limit in `tests/helpers/claudeMcpLimit.ts`).
`claudeToolSurface.test.ts` sends both production-host evaluation reads and the captured INF-91 row through the installed client, boxed into a scratch HOME with a local provider stub, and requires the model-bound request to carry each byte for byte.
It also sends a first mate result between the client’s default and the seat’s band, the captured INF-91 row read whole and that record filling the band to its last character, and requires each to arrive byte for byte.
This transport check calls no live model and does not establish that a model acts correctly on the plan; the approved account evaluation supplies that evidence.

## Access a company set up

A Claude account also connects through access set up for Claude Code rather than a Claude subscription: a token command (Claude Code's `apiKeyHelper`) and the address it is sent to (`env.ANTHROPIC_BASE_URL`), as a company's gateway hands them out.
They come from two places, read with the client library's own settings reader (`resolveSettings`, `src/core/claude/claudeAccess.ts`), the same merge the client runs at start.
The organization's tier is the managed settings the client reads at start - the installed file and its drop-in folder, a device-management profile, the Windows registry and the server-managed cache - except settings an administrator's `policyHelper` program computes, which the reader does not run.
A token command only such a program sets is not seen here, so the account reads its subscription sign-in as before.
The person's own tier is their user settings file; a project's settings stay unread.
Infinitary never runs the command and never sees what it prints: the client does both.

The organization's tier needs nothing from the app, because the client reads it in every session whatever `settingSources` says.
Of the person's own settings the token command, the address and a gateway's custom headers (below) reach a session, as the app's own flag settings (`accessSettings` on the session deps, laid under the app's other flag settings), read again each time a client starts, and `settingSources` stays empty.
The only other part of that file read is a company's usage reporting setup: its `env` reporting keys and its `otelHeadersHelper`, which the app runs itself and passes on through its receiver (`docs/usage.md`, "A company's Claude Code setup"); everything else in that file stays out.
The organization's tier ranks above flag settings in the client, so where it sets any of these keys, its own wins.
An address alone, with no token command, also reaches sessions, as it reaches Claude Code.
So do the custom headers a gateway asks for (`env.ANTHROPIC_CUSTOM_HEADERS`, such as a team id), from the person's settings file or, where it sets none, their login shell, whose one-time ask (`src/core/userBin.ts`) prints that key beside the reporting keys and nothing else; `claudeAccess.integration.test.ts` holds that the header reaches the gateway from each.

When either tier sets a token command, the account's access is that command (`ClaudeAuthBackend`, `src/core/claude/claudeAuth.ts`), ahead of any subscription sign-in in the store:

- Connect, and the row's Try again, check the access and open no browser; the notice says which access is in use.
- Health is healthy with the access's source (`organization` or `claude-settings`, `src/shared/claudeAccess.ts`) and a stamp naming a digest of the command and address, so a changed command is a new sign-in that ends a refusal recorded under the old one.
- Renewal is unsupported: the client runs the command again on a refusal, which `claudeAccess.integration.test.ts` holds on the client the product would run.
- The allowance is `not_measured` with a detail naming who sets it (`claudeAccessOutcome`), never a zero, and the store is not read for it.
- The account is named "Claude Code access" (`CLAUDE_ACCESS_ACCOUNT_LABEL`), since Claude's row follows its current identity, and the row names where the access comes from in place of a plan and the email; a sign-out cut-off asks the person to renew the sign-in the way they renew it for Claude Code and offers Try again, and the crewmate's and first mate's cards say the same (`claudeAccessRefusedText`, titled `CLAUDE_ACCESS_SIGN_IN_TITLE`; the first mate's pause card, its feed line and a kept message's reply line with `CLAUDE_ACCESS_PAUSED_SENTENCE` and `CLAUDE_ACCESS_RENEW_WORDS`, and the line under the refused message and a crewmate's failed turn in the feed with `CLAUDE_ACCESS_REFUSED_LINE`, which the turn's typed failure carries as its access).

An account already connected with a subscription switches at its next reading after the update, as Claude Code itself does with the same settings: the row is renamed and stops showing the subscription's email, the allowance becomes not measured with no earlier subscription reading carried over (`mergeStaleProviders`), and requests are billed wherever the access bills them rather than to the subscription.
A settings reader that fails reads as no such access, so the account reads its subscription sign-in for that reading, a choice the captain made over keeping the last good reading.

When neither tier sets a token command but one names an address, the subscription sign-in still serves and its requests go to that address: health carries who set it (`gateway`), and the row adds "sent through" that address after the plan and email (`CLAUDE_GATEWAY_LABEL`).
A computer with neither behaves as before.

A company's Claude Code usage reporting set up in the person's own settings file or shell reaches its collector through the app's local receiver, never from the client directly (`docs/usage.md`, "A company's Claude Code setup").
