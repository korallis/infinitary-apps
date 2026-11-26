# Testing and CI rules

The green gate, the CI shape, and the mechanics every test keeps.
Cohorts and probes are `docs/test-cohorts.md`; the e2e harness is `docs/e2e-contracts.md`; how a change picks the tests it writes and runs is `docs/delivery-rigor.md`.

## This project's rulings on tests

Which tests a crewmate writes, and how it repairs a failing one, is the crew's default rule on tests (`docs/delivery-rigor.md`, "The default rule on tests").
A new end-to-end journey follows that rule like any other test, with no ask.
Its review names the promised result, the data, the completion signal, the platform prerequisites and the shared resources (FI3-1732).
This project adds six rulings of the captain, which win over that default:

- Weakening, skipping or deleting a test that was there before the change waits for the captain's approval.
  A test or check the change itself adds is its builder's and reviewer's to settle, as any other finding.
- A phone part sends a tap once more only when backboardd's own log proves the simulator ignored the first one, and only through `tapOnPhone` (INF-1477, "Allow a proven second tap"; `docs/ios.md`).
  The photo pick alone also taps once more when the photo picker's own log proves it read the first tap as a press-and-hold and chose no photo ("Allow one more photo tap"), after one tap below the open preview closes it ("Allow the closing tap").
- A phone journey never waits for XCTest's animation reply: it skips that wait and keeps the app's run loop wait, and each tap waits until its own target, and the screen inside it, holds still (INF-1541, "The test code skips Apple's animation wait and checks each target itself"; `docs/ios.md`).
- A phone part's display change sets the text size once more only when the app's own log proves it read the old size after the simulator saved the new one, and never sets an appearance twice (INF-1785, "Confirm each change from the simulator's log, and set it once more only when the log proves the phone missed it"; `docs/ios.md`).
- A phone part puts back a caret a key put in a text field only when the app's own log proves the system's keyboard took it back, and never presses that key a second time (INF-6074, "Check only"; `docs/ios.md`).
- A test file, helper or stand-in a change edits is brought to the six words in the same pull request (INF-2394, measure 5).
  Remove a bad pattern by re-typing a pin to its source or moving a stand-in to its owner, never by deleting a test on sight.
  Name a pattern seen elsewhere in the report for the first mate to file, not fixed in passing and never copied.
  Deleting a test that was there before the change still waits for the captain's approval.

Before merge, prove the change with the smallest relevant checks, counted once for the current version and required platform (INF-2259's accepted hybrid process).
Opening a pull request may start that proof; there is no duplicate complete local pre-push gate when CI owns it.
The PR's Linux check owns typecheck, lint and build; the adherence lint runs in `pnpm check:changed` before each push, never on a pull request.
A small local diagnostic run is allowed, not an additional mandatory gate.
Passing checks never grants merge permission.

Edited test files require three total successful runs: ordinary coverage plus two more, never an ordinary run plus three repetitions.
An affected unedited phone part runs once, on the iPhone, and a change to the phone app's screens adds the iPad's and the iPhone Duo's short passes (INF-2582 as INF-4241 amends it, "The phone check on request"); an unedited journey the change only reaches runs in the swept batch, never on the task branch ("What a task branch requests").
Failed, skipped, cancelled, incomplete and older-version outcomes are not passing proof.
A failed or interrupted round stops later repetitions without retries.
Record the version, selection reasons, files or parts, required platforms or devices, rounds and outcomes in the existing task/check evidence; this adds no host gate or second selector.

- Portable journeys run in Linux CI through `journeys.yml`, with `files`, `platforms=linux` and the comparison `base`.
  `scripts/journey-runs.ts` runs every selected file once, then only directly edited selected files twice more, retaining every round's report.
  Each round runs the parallel lanes' selected files together, then the desktop lane's in a Playwright run of their own, as a run of every lane orders them ("E2E scheduling and launch diagnostics").
  Once every round passes, it runs the run-alone pass over the directly edited selected files ("Each test owns its prerequisites"), on Linux and, with `@mac-only`, on the Mac (INF-2340, the captain's route "alone-at-author": a repeat checks the test's quality, so it belongs to author time).
- Selected Mac-required cases run locally through `node scripts/local-mac-journeys.ts <file>... [--base <ref>]`, even while this computer remains in CI mode.
  The route requires explicit existing files with native cases, filters to `@mac-only`, rebuilds from current source and dependencies, and admits build through cleanup under one declared load.
  Nested launchers reuse that hold, with the existing two-worker default and measured memory declaration.
  It uses Electron's supplied signature for isolated source tests, not custom development-signing preparation.
  Genuine signing, Keychain, microphone and quiet-host performance checks retain their own prerequisites and consent.
  Mixed files retain Linux coverage and their Mac-required cases: those prove different platform behavior.
  A check requiring a CI environment uses `platforms=mac` or `both` instead of equivalent local proof, not in addition.
- Every edited Vitest file runs three total fresh invocations locally, including Linux-eligible files (the captain's INF-2273 override).
  The pull request's check also runs each one once on Linux ("Notes"), since three changes whose edited tests passed their Mac rounds first failed on Linux in the merge batch (INF-3690's gap 3, the captain's "Yes: start it now"); the three local rounds stay.
  `pnpm test:repeats --base origin/main --workers <declared workers>` uses the existing changed-path reader and stops at the first failed or interrupted round without retries.
  Unedited Vitest files that directly import a changed file or reference its literal path run once locally in the same command (INF-2394 measure 3).
  The selector resolves relative imports and the node and renderer compilers' aliases, literal paths relative to the project or test file, joined literal path segments, and template directory prefixes such as workflow readers use.
  A data file a module imports, such as a runbook's JSON in `src/core/pi/piResources.ts` or a stylesheet read as text, is part of that module's text, so a test that imports that module directly reads the data directly too (INF-2426).
  Served text, a runbook under `resources/runbooks/` or the generated runbook fallback `src/core/runbooks/fallback.generated.ts`, is carried the same way, so a change to it selects the tests that import `src/core/pi/piResources.ts`, among them the crew prompt's budget test and the prompt contract tests (INF-2925).
  A test naming a folder that holds a runbook, as the runbook loaders' tests do, reads that runbook too.
  Audited indirect contracts have explicit links in `scripts/unit-reach.ts`: channel definitions select the action and IPC inventories, `src/core/storage/migrations.ts` selects the decision, inbox and keep-open migration tests, `src/core/tasks/taskService.ts` selects the settle boundary test, `src/core/orchestrator/wakes.ts` and its `*Wakes.ts` word modules select the wake words pins, `src/core/orchestrator/wakes.words.*.test.ts` (INF-3614), `src/core/orchestrator/seat.ts` and `src/core/pi/piResources.ts` select the two Claude session contract tests, which pin the seat's prompt and contract stamp through `tests/helpers/sessionContract.ts`, `src/shared/providers.ts` selects the Claude classifier test, whose scoring process loads it under plain Node, and any file under `scripts/` selects the alpha's build-list test, `tests/release-workflows-alpha-cut.test.ts`, which refuses a script the desktop build reaches that the alpha's build list leaves out (INF-4500).
  INF-6259's weekly audit added twelve more, each for a change that passed its branch check and failed the batch on a test reaching the file through a helper: the forge's `putIn` to the publication tests that pin its arguments, the change publication and context to the placed working copies test, the `src/core/pi/*Tools.ts` modules to the two fixed-context ledgers, the services, presentation and notifications to the started core's projects test and notifications to the beside window's, the card store to the thread migrations, the placed ledger to the placed Claude contract, the program runner and crew brief to the program test, the placed copies and sessions to the placed callbacks and sign-in tests, `src/shared/holds.ts` to the crewmate wake words, and the forge's index and the publication's repository to the GitLab review test.
  These links add no readers for unrelated changes and leave edited tests to their local rounds.
  An inventory test declares additional indirect files in an `inventoryFiles` literal array of project-relative file paths in its own test file, as `src/shared/actions.test.ts` does for its settings request schemas.
  A generated file's freshness test that reads its source only through the generator's path constant declares that source the same way, as `src/core/personal/infinitaryEnv.test.ts` does for `src/shared/personal/contracts.ts`.
  A test that pins a file's output it reaches only through another module declares that file the same way: `src/shared/publishedContract.test.ts` declares `docs/contract.json`, and `src/core/orchestrator/crewFacts.test.ts` the modules whose feed and timeline lines it pins (INF-3545).
  The existing literal-path reader selects it whenever a named file changes, including deletion; no new parser, transitive traversal or CI job is needed.
  Name only files the inventory actually checks that direct imports or the explicit links do not already cover, and add a real-file selector regression with unrelated nonselection.
  Edited inventories still belong only to their local rounds; the PR check runs unedited selected inventories once through the same cohort routing and selected-versus-ran reconciliation.
  Otherwise it reads each test file and, for a changed data file or served text, the modules that test imports; it never follows imports transitively, and does not execute dynamically computed paths to discover dependencies.
  Edited files remain disjoint from that once-only selection; a failed direct-reader round stops the edited-file rounds too.
  Ordinary coverage is included, so do not add a fourth run or duplicate local proof in PR CI.
  Declare the whole batch's processor and memory needs through the local load path, and bound Vitest workers to that declaration.
  `scripts/mac-unit-tests.ts` identifies native prerequisites, not an exclusion of portable files from local rounds.
  An edited file on that list keeps its three rounds on the Mac.
  A developer without a Mac cannot count skipped native cases as proof.
- Edited phone parts retain three runs on the iPhone and one on the iPad (INF-2732, the captain: "run each edited phone part three times on the iPhone and once on the iPad"), the iPad's only for a part about the iPad, and one on the iPhone Duo for a part about the Duo (`docs/ios.md`, "Which parts run on which device").
  An affected request gives ordinary coverage once and only its distance-zero parts twice more, on the iPhone alone, in the same CI gate, whether it selects every part or a proper subset (INF-2811: a computer in CI mode cannot run a local phone check), so no local phone repeat or second request is needed.
  Other affected parts run once, on the iPhone, a change to the phone app's screens adds one run of the iPad's and the Duo's short passes, and unreadable test changes keep conservative all-parts repetitions on the iPhone and one run of every iPad part on the iPad.
  See "The phone check on request" for its exact route and isolation.
- Replay runs once in Linux CI when relevant; pictures and demos remain local.

A push to main repeats no changed-test proof: its pull request already supplied it, the run-alone pass included.
A requested branch run compares edited files with `origin/main`, or its explicit `base`.
Full local journey suites remain prohibited.

## Actions artifact retention

Large, short-lived uploads use explicit three-day retention: `phone-results`, `phone-pictures`, `phone-logs`, `phone-simulator-logs`, `linux-packages` and the `source-desktop-*` family, including overflow-parallel journeys.
Two of them are shorter.
A requested run's `linux-packages` are kept 1 day, while a release's stay 3 days for a release that resumes.
`phone-results` from a failed phone check are kept 1 day, while a recording run's stay 3 days for its export.
This keeps recent diagnostic evidence and same-run package handoffs without accumulating weeks of bundles and binaries.
Phone result bundles upload only on failure or a recording request.
A `source-desktop-*` upload from a run whose journeys passed holds only `source-results.json` and any recorded demo; a run that did not pass keeps the window and everything under `test-results/`.
A failed run's `journeys-failures` and `e2e-failures-<lane>` are kept 7 days.
The repository's default for an upload that names no retention is 14 days.
Download diagnostic evidence or export a recording within those three days if a task needs to keep it longer.
Phone logs also carry the full gate's `part-times.json`, a record of each part's minutes on each device; no workflow reads it since INF-2539 removed the pull request's part budget.
They carry its `part-work.json` too, each part's screen reads and app launches, from which `scripts/phone-work.json`'s recorded amounts are taken (`docs/ios.md`, INF-4326).
Published release assets are independent of Actions artifact retention, but a release resuming after its Linux packages expire must rebuild them.
Retention applies to new uploads only; existing artifacts keep their expiry dates, and repository storage still depends on upload volume and other artifact families.

## Windows feasibility observations

The opt-in hosted Windows investigation is `docs/windows-feasibility.md`.
It collects results with disposable data and synthetic sign-ins; it is not a Windows support promise, a recurring suite or a release gate.

## Every test makes an assertion

`vitest.config.ts` sets `expect.requireAssertions`, so a Vitest test that finishes without running an `expect` fails with "expected any number of assertion, but got none".
A test cannot pass merely by finishing, and a case whose every check sits behind a branch that never runs fails instead of passing empty.
The setting sits at the config's root, which every project inherits through `extends: true`; a command-line flag does not reach the projects.
It counts `expect` calls wherever they run, inside a helper too, and `expect.soft`, `expect.poll`, `.resolves`, `.rejects` and `toThrow`; Node's `assert` and chai's `assert` do not count, and neither does an `expect` in an `afterEach` hook or a setup file.
A type-only `expectTypeOf` does not count either: a test that holds a type equal to a runtime list also checks that list's behavior.
A test that once passed by finishing states the outcome it waits for: what came back, which calls were made, or that a promise resolved.

## Comparing binary payloads

Use `expectBytesEqual` (`tests/helpers/expectBytes.ts`) to assert complete byte equality on large recordings or transport pieces.
It checks the length and compares each view's bytes with `Buffer.equals`, rather than making the assertion library walk a million indexed properties.
Keep the transport's piece offsets, sizes and ordering assertions alongside it.
Its regression tests cover corruption at the beginning, piece boundary and end, truncated payloads, and views with different backing buffers.

## Frame styles in unit tests

Vitest blanks every `.css?raw` import unless the config sets `css: true`.

## The browser layer

The `browser` project (`vitest.config.ts`) draws the window's real React in a headless Chromium page, with no Electron, no build and no app launch.
Each file under `tests/browser/` starts from a fresh page, as each journey was a fresh app, and opens the window with `openWindow` (`tests/browser/window.ts`), which runs the renderer's own entry.
Each browser session runs its files one after another in one page of one origin, so the project's setup (`tests/browser/freshPageSetup.ts`) runs `freshPage()` (`tests/browser/freshPage.ts`) before each file: it clears local and session storage and cookies, and sets the motion setting back to the browser's own.
It also collects the page's garbage, because each earlier file's window holds the browser's shared memory until a collection, and on Linux that memory is files in the temp folder that otherwise fill the disk.
The page's pointer stays where the last file left it, so a test that reads a state the pointer changes, such as a hover, moves the pointer first.
A test that changes the page in any other way, such as a device-metrics override through `cdp()`, puts it back before it ends.
The window talks to one shared fake of the bridge, `fakeBridge` (`tests/browser/bridge.ts`), built with the preload's own `createApi` (`src/preload/api.ts`), so the page holds the very API Electron exposes.
Every request the window sends is read against the published contract's request schema, every answer and push a test gives against its answer or payload schema, and a shape the contract refuses fails the test.
A request with no answer rejects and is listed in `unanswered`, so a test names every answer the screen it draws needs; so does a read with arguments the home did not read, such as a card's thread its seed's `asked` does not name.

A test's answers start from the fresh home, `freshHome()` (`tests/browser/freshHome.ts`).
Once per run, `tests/helpers/browserFreshHome.ts` boots a real core in Node on a throwaway data folder, offline, and reads every core read that takes no arguments, plus the few reads with arguments that `ASKED` names with the request the window sends.
Every boot, the fresh home's and a seeded home's, also gets a throwaway home folder and a Claude Code path that does not exist, as a journey's launch gets its own home and Claude client.
So its core finds no Claude Code and no Claude login of the computer it runs on: the Claude chip says to install Claude Code on a developer's Mac as in CI, and no boot runs the computer's own (`tests/browser-fresh-home.test.ts`).
The desktop shell's own answers come from the shell's code where it runs in a page (the installed keys) and are written beside it otherwise, each still read against the contract.
A test replaces only the answers its story changes, such as a home whose person connected a subscription.
After those reads the same core plays the short stories a test replays, each a list of the core's own pushes and the boards between them: `crewStory` sends one crewmate out and cancels it, for the crew ring's files (`tests/browser/crewOrbit.ts`).
There is no recorded fixture: a core change that moves an answer reaches the browser tests on the next run.

A story that needs a home already holding something - tasks, cards, asked messages - reads a seeded home, `seededHome(input)` (`tests/browser/freshHome.ts`).
The `seededHome` browser command boots a real core the same way, after the test's own seed module, `tests/helpers/browserHomes/<the test file's name>.ts`, has written the folder through the core's own stores, as a journey seeded its userData before the launch.
The seed's default export takes the folder and the test's `input`, so the words and numbers the test reads back have one owner, the test; its `asked` lists the reads with arguments the story's screen sends, such as a card's thread.
`subscribed(home)` is the same home with a subscription connected, so the first-run welcome gives way to the main message box.
A card that shows pictures its crewmate wrote is stored through `storeCardWithPictures` (`tests/helpers/browserCardPictures.ts`): the seed writes real files into a working copy and the core verifies them and keeps its own copies, as it does for a crewmate's card.

The window defines `window.infinitary` once per page, so a file opens one window and holds one test; a journey's tests that each launched the app become one test with named sections, in order.
A test sizes the page as the journey sized the window: `openSize()` (`tests/browser/window.ts`) is the app's default window, and `page.viewport` any other, such as the smallest.
Reading a screen goes through the shared readers beside the tests: the card stack's shown card, its body's and its settle facts' frames, and the answers the core gives its close (`stack.ts`), the main message box and a pasted picture (`prompt.ts`), the stage's characters and crew (`crew.ts`), and boxes compared with each other (`layout.ts`).
A card body with no script draws in its own frame, as in the app, and so do a settle card's facts; a frame the shell serves over its own scheme - a scripted card body, a panel, the task record, Now, the task browser - mounts and stays empty in a page.
A card's pictures are the core's own copies: the home reads each through `inf:cards:picture` and names it by a data address in the card's body, since a page cannot load the shell's scheme.
`bodyDrawn(title)` waits until the shown card's body has drawn, and `inCardBody(title, read)` runs `read` inside it.
A test that scrolls a list back after a smooth scroll first waits for that scroll's `scrollend`: the page's Chromium drops a smooth scroll started within a frame of an instant scroll that cut another smooth scroll short (`tests/browser/thread-place.test.tsx`).

A browser test's limit and its waits count only the time the page and the Node process that answers its commands both got to run, and end by their wall cap, as every project's do (`tests/browser/loadClock.ts`, `docs/test-cohorts.md` "Budgets").
So a runner whose disk stalls that process, such as during a seeded home's boot, does not fail a test.
A seeded home's wait in line behind other pages' boots does not count either, and each click, fill or hover has the load time its test has left, which Playwright counts on the command process's own load clock.

Browser commands (`tests/helpers/browserCommands.ts`) reach the page itself, such as the media a person's Mac sets, and `evaluateInFrame` reads inside a sandboxed frame, found by its name or its title, such as a card body, that the page cannot script; `cdp()` from `vitest/browser` reads the browser's own counters.
A command that finds a frame the page drew reads Playwright's list of frames only once a request on Playwright's connection has been answered: the test's word that the page drew the frame comes over the runner's connection and can arrive before the browser's word that the frame exists.
A journey helper that takes a Playwright page, such as the layout invariant or the first mate idle wait, is checked here on a plain page of the browser's own, through a command in `tests/helpers/journeyHelperPages.ts`, never by launching the app only to replace its page.
A frame program served as text, such as Observe's, draws in a same-origin frame the test builds from the program and the design tokens (`tests/browser/observe-frame.test.ts`).
The project's Chromium runs with Web Share on, as the window's does, and draws scrollbars as the window does: over the content on a Mac by default, beside it on Linux, and beside it wherever a page styles them.
Install it once with `pnpm exec playwright install --only-shell chromium`, then run `pnpm exec vitest run --project browser`.
A pull request version that touches the renderer or its browser tests runs the whole browser project in `ci.yml`'s `reached-tests` job, about three minutes with its Chromium install; any other version runs only the browser files that import or read a changed file, in the reader step ("Notes", "What a pull request runs").
`verify.yml`'s browser test group, a job of every swept batch's check and of main's, runs every browser file, and `ci.yml`'s requested `unit-tests` sweep runs them beside the in-memory cohorts; all three install Chromium through `.github/actions/browser-chromium`.
A journey that only draws the window and reads it moves here, and its original is deleted as its twin lands, so the swept batch checks the window through its twin.
A journey stays when it needs what the browser layer cannot give the page: main or the core at work, a frame served over the app's own scheme, whose body a page cannot load, or a change of display density, which Chromium tells only a top-level page and the test page is a frame.
A seeded home holds no signed-in account: its core would check one against its provider, so a story about accounts writes their answers in the test, or stays a journey when it proves the core's own handling of them.
A disconnected account, a row with no key saved, is seeded in the vault's own layout (`tests/e2e/accountFixtures.ts`), since its core checks nothing.

## The required typecheck

`pnpm typecheck` runs the pinned tsrs checker in build mode through `scripts/typecheck.ts`, visiting the node, web and checked-JavaScript frame projects in `tsconfig.json`.
Local, pull-request, main and release verification use this one command; there is no second project check or tsc fallback.
The selector reads the pinned package's published platform list: native on Apple silicon and Linux x64/ARM64 (the native launcher selects GNU or musl), portable `@tsrs/wasm` elsewhere, including Intel macOS.
Selection never depends on whether a binary is installed or a check passed: a missing native binary, diagnostic or crash fails the gate without retrying another engine.
Both engines are exact development-dependency pins; the portable checker runs single-threaded with its own 4 GiB linear-memory limit, not the old Node heap flag.
TypeScript remains a runtime library for panel compilation, generated types and lint/test consumers, not a backup project-check command.

The three configurations keep their source lists and checking options; aliases use explicit relative targets without `baseUrl`.
The compiler owns its incremental `.tsbuildinfo` results and invalidates results from the previous compiler version on the first run; subsequent checks reuse the new results.
For an explicit fresh check, run `pnpm typecheck --force`; to remove saved results, run `node scripts/typecheck.ts --clean`.
A rollback restores the old command and removes the three root `tsconfig.*.tsbuildinfo` files before checking; it changes no app data or panel output.
This command is a batch check, not an editor, language-server or watch-mode migration.

## The statement check

Five main thread freezes (INF-703, INF-940, INF-1348, INF-1956, INF-2059) were synchronous SQLite whose cost grew with the saved record while the tests used a few rows.
A plan is what grows with the record, so the statement check reads plans (INF-2061).
`tests/helpers/statementCheck.ts` is a setup file of the `unit`, `unit-isolated`, `integration` and `probe` projects.
It records every statement the app's own code prepares while a test file runs: the first caller under `src/` that is not a test, so a test's own statements and a helper's are left out.
It finds that caller from the stack as the engine holds it and maps each call path to its source lines once per test worker, since a migrated record makes thousands of prepares and mapping each one's stack would cost most of a database-backed test's time (INF-3596).
When the file ends, it plans each one with `EXPLAIN QUERY PLAN` against a freshly migrated database (the app's record, or the knowledge collection when only that schema compiles it), with every parameter bound as NULL.
The file fails on a walk the ledger does not explain: a `SCAN` of a growing table, read through a view's alias too, and a temporary b-tree in a statement that makes one.
A search through an index, a temporary b-tree over the rows an index sought, and a virtual table's own index are not walks.

`tests/helpers/statementWalks.ts` is the ledger, in three parts:

- `BOUNDED_TABLES` names each table that does not grow with the record and the code that trims it; every other table grows, a new one included.
- `ONE_TIME_CALLERS` names code whose statements run once per record, such as the migrations, the folder move and the D-13 purge; a statement prepared under one of them is not planned.
- `WALKS` holds each allowed walk by its statement's text, the walks its plan makes and why the walk is acceptable.

The ledger only shrinks.
A statement whose plan no longer makes its ledgered walks fails the check, and `tests/statement-check.test.ts` plans every entry, so a fixed walk leaves the ledger in the same pull request.
A new entry is a move its pull request explains, as a moved replay number is; the usual answer to a new walk is an index or a query that seeks.
An optional query index goes in `createQueryIndexes` in `src/core/storage/queryIndexes.ts`, with no migration version.
A read that needs a partial index names it with `INDEXED BY`: with no statistics, SQLite prefers an index that matches more equality terms, and the roster's restart read did so and tested every note of a running task before INF-2341.
This check plans that read as a search, and the scale check below counts only the one row it returns, so the read's own test asserts its plan (`src/core/tasks/taskRead.test.ts`).
The check sees only the statements the tests prepare, and it reads no time: a walk of a small table and a slow file read are outside it.
`INFINITARY_STATEMENT_CENSUS=<folder>` writes each test file's planned statements there as JSON, for a review of every walk at once.

## The scale check

The statement check reads plans; a read that seeks through an index can still read more rows every time the record grows, as the task board did before INF-703, the minute pass before INF-1348 and a read every two seconds before INF-1956.
`tests/scale-check.test.ts` counts that work for the reads the app repeats on its main thread: a first mate turn's context build, the answer-delivery sweep, one minute pass (the crew's watchdog checks and the work presentation refresh, registered as `services.ts` registers them), a task board update (INF-2061, built as INF-2069), the first launch's crew facts, read on a first-run record that lacks them as each such launch reads them (INF-2338), a running task's close with the passes over closed tasks' files watching (INF-3032), a merged close whose change declared a required action, which files the captain's action task and must not read every task to match it (INF-4224), and a work computer's contact, whose roster is read against the record (INF-3040).
It seeds a record sized from the captain's readings: 3,400 closed tasks with about 47 events each (160,094 events in INF-2059's reading), their cards, threads and answered messages, beside running work with 33 open messages in 13 chains.
It runs each read once, then counts each statement the read runs and the rows it returns, reads again to show the counts repeat, adds three times the closed history and counts again.
A count ends only once the work its read set off in later event-loop turns has finished, each part awaited by its own promise (the minute pass's passes through the ticker's steps, the closed-task file passes, the presentation refresh and a contact's roster read), never by a number of turns.
It fails when any statement's runs or rows moved, naming the statement, both counts and the app code that ran it.
The answer is a read that seeks only the rows it needs, never a bigger number in the test.
It counts work, never time (captain's B1), and a walk that returns no rows is the statement check's to catch.
It sees only the reads it drives; a new read the app repeats on its main thread joins it.
The fixture seeds through `outsideCensus` (`tests/helpers/statementCheck.ts`), so the statement check does not read a stack for each of the seeding's prepares; the reads it measures are still recorded and planned.

## A failed check says why

A check's reason reaches GitHub's summary of the check, not only its log (INF-4305): a step that prints its reason as plain text and exits 1 leaves the summary at "Process completed with exit code 1."
Inside GitHub Actions (`GITHUB_ACTIONS=true`) every check prints its refusal in GitHub's error format, which the summary shows as an annotation beside the file it names:

- Playwright adds its `github` reporter beside the console and JSON reporters (`playwright.config.ts`).
- Vitest adds its `github-actions` reporter itself only when a run names no reporters, so a run that writes the timing file (`INFINITARY_TEST_TIMING_FILE`, `vitest.config.ts`) and the pull request check's run of the tests that read a change (`reachArgs` in `scripts/unit-repeats.ts`) name it again beside the default and JSON reporters.
- The size check, the message catalogs' check, every generator's `--check` and the release-notes command print each refusal through `scripts/github-errors.ts`, naming the file a refusal leads with or the generated file out of step and the command that refreshes it; outside GitHub Actions they print the same plain lines as before.
- A merge batch stopped at failed code checks fails one job that names the failed step, one stopped at a confirm that failed again fails one job that names the confirm and its test files, and its stops pass ("The swept batch").

`tests/failure-annotations.test.ts` runs the real configurations, a real generator and the batch's stop steps as a check in GitHub Actions runs them, and `tests/github-errors.test.ts` holds the error format.
A new check that refuses with words prints them through `printErrors` or `errorLine`.

## The size check

A code file the project tracks is at most 2,000 lines, the captain's bar for a file that is too long (INF-2625).
`pnpm check` runs `node scripts/file-sizes.ts`, which refuses a code file over `SIZE_CEILING` lines unless it is on `OVER_CEILING`, the list of files that were already longer when the check began.
The list only shrinks: the check refuses an entry whose file is back at or under the ceiling, or gone, so the pull request that brings a file under removes its entry.
A file that grows past the ceiling is split along its owners in the change that grows it; a new entry is a move its pull request explains.
A code file is one with a code extension (TypeScript, JavaScript, Swift, C, shell or CSS), less generated files (`.generated.` in the name), vendored code, fixtures and the design skill's built bundle; data, lockfiles and pictures are not code.
`node scripts/file-sizes.ts --list` prints every code file over the ceiling with its lines.

### The size check's warning line

The ceiling holds a merge only once a file has passed it, so a file growing hundreds of lines a week is split under pressure in the change that tips it over.
The warning line, `SIZE_WARNING_LINE` at 1,800 lines, gives that split room before it holds anything (INF-4496, the captain's pick: "1,800 lines").
`scripts/file-sizes.ts` owns both lines and what counts as a code file.

- **The ceiling.**
  `pnpm check` refuses a code file over 2,000 lines, as above, so every check that merges or releases holds it.
- **The warning line.**
  `node scripts/file-sizes.ts --warn` fails naming each code file over the warning line, largest first, less the files on `OVER_CEILING`, whose splits the list already owns.
  `size-warning.yml` runs it on each push to main that changes a code file, and by hand.
  No pull request starts it, and the batch, main's release check, the alpha and every release never read it; `tests/size-warning-workflow.test.ts` holds that.
- **The headroom.**
  A change may not grow a code file past the warning line, or further past it (INF-6259's weekly audit, the captain's pick: "refuse a change that grows a code file past, or further past, 1,800 lines").
  Two changes that each grew a file under the ceiling had together passed it in the batch seven times in two weeks, each time holding every change beside them.
  `node scripts/file-sizes.ts --headroom --base <commit>` compares each code file the change touches with its length at the change's base: it refuses one now over the warning line and longer than it was, a new file included, and passes one the change shrinks or leaves the same length, so a split can take more than one change.
  A renamed file is measured at the base under its old name, so moving a large file is not growth.
  The branch check's code checks run it against the change's base ("A pushed branch"), and `pnpm check:changed` runs it before each push with uncommitted edits included; `tests/release-workflows-pr-checks.test.ts` holds the step.
  The batch never reads it, since the ceiling already holds the combined version.
- **The split task.**
  An Automation rule on GitHub's "A workflow run fails", filtered to workflow `size-warning` on branch `main`, files and starts one split task unless one is already open.
  The task splits the first file the run names, the largest, along its owners, with no test or behavior lost; the next red run starts the next.
  Splits are restructure work outside INF-2604's pieces, so each asks before it merges.

## Measuring coverage

`pnpm coverage <file>...` measures which lines, branches and functions of the named files the tests reach, with Vitest's V8 coverage provider (`scripts/coverage.ts`), and prints one table.
By default it runs the named files' own tests: the test files whose paths start with a named file's path less its extension.
Arguments after `--` go to Vitest in place of those, such as `pnpm coverage src/core/orchestrator/wakes.ts -- --project unit src/core/orchestrator`.
It sets no threshold and fails nothing for low coverage: the number is information, never a gate.
A piece of a restructure measures the files it moves on untouched main, so its guardrail tests cover what the tests do not reach before it moves them.

## Imports plain Node can load

The project's scripts run under plain Node's type stripping, which loads a relative import only by its exact file name: `./catalog` fails there, where the test runner and the typecheck find `./catalog.ts`.
`pnpm check` runs `node scripts/node-imports.ts`, which refuses a relative import without its file's extension in every file plain Node starts and every file their static imports reach (INF-4500).
A file plain Node starts is one a `node` command names in `package.json`, a workflow, an action or a shell script, or a script a test starts with the running Node.
A type-only import and a dynamic `import()` are not followed: Node erases the first, and a script may take the second only under another runner, such as the Vite module runner.
`tests/node-imports.test.ts` holds it to the project and to a real script with one import's extension dropped.

## E2E scheduling and launch diagnostics

The renderer and application lanes (`tests/e2e/lanes.ts`, `playwright.config.ts`) share two workers locally unless the caller passes `--workers`.
CI starts one worker per core, at most ten and always one, and no more than the job's memory holds at 1.5 GiB a worker beside 0.5 GiB for the runner (`ciJourneyWorkers` in `scripts/heavy-run-place.ts`, INF-5216).
Cores are the job's size when the Mac mini's placement service names one and the whole machine otherwise, and memory is the machine's or the smaller limit its control group sets (`scripts/job-cores.ts`, "Each Mac job's kind and size").
That share is the estimate a local run declares ("A local heavy run's place"), not a bound on what a journey can use, so it lowers a small machine's memory pressure without ruling it out.
The full Mac check (`verify.yml`) runs its journeys in four jobs (INF-2779, INF-2987, INF-6249): two desktop journeys jobs each run a group of the one-worker desktop lane, alone on a Mac of its own, and the styles, renderer and application lanes are split between the parallel journeys job and the native tests, replay and package job.
The split is by measured time ("Journey groups by measured time", below): the native job takes fewer journeys for the work it does besides, so those three jobs end together.
The desktop lane's two groups (`desktop-1` and `desktop-2`, the jobs named `Desktop journeys (Mac; group N/2)`) are split the same way by the Mac times, with no job of their own work to count, and each runs `scripts/journey-groups.ts --lane desktop`; the lane's files still run one at a time inside each, since they need a quiet machine.
A round therefore needs four Macs at once, and the desktop lane's time is half what one job took.
On GitHub's own Macs (`macos-15`, three processors and 7 GB), which run the same journeys about three times slower, the parallel journeys job is four, `parallel-1` to `parallel-4`, the jobs named `Parallel journeys (Mac; group N/4)`: with the native job they are five groups of about equal time, balanced by GitHub's Mac's own measured times (`macHosted` and `macHostedJobs` in the record), and each takes every processor but one, since such a Mac runs its job alone (INF-6330's plan, option D).
The `native` kind sends the native job and the parallel journeys there ("Each Mac job's kind and size"), while both desktop groups stay on the project's Macs; an outside contributor's run, all on GitHub's Macs, splits the same way.
The journeys part of an alpha, with no native job, runs the whole parallel lanes in the parallel journeys job.
Each passes `--no-deps`, so neither parallel group pulls in desktop, its lanes' teardown.
Each gives Playwright half the job's cores, because a job on the real Mac shares one processor with the jobs beside it: with all of it, app launches starved past `firstWindow`'s 30 s while the other slot ran journeys too.
Desktop is the one-worker lane, and in a run of every lane it runs last, even after a failure.
A run of selected journeys (`scripts/journey-runs.ts`) keeps desktop apart and last too: under `--no-deps` one Playwright run would start both lanes side by side, and a desktop file such as the automatic placement journey would read the parallel lanes' apps' memory as its own computer's (INF-4891).
A failure in either run stops the rounds.
The lanes load only `*.spec.ts` files (`testMatch` in `playwright.config.ts`); a vitest `*.test.ts` beside them, such as a scenario's own test, runs in vitest's cohorts and never in Playwright.
New spec files start in desktop.
A file joins application once a review finds it needs no voice, paint budget, demo recording or other one-at-a-time resource, keeps its own HOME, userData, ports and service stand-ins, and passes under the parallel lanes' load in a full Mac and Linux run (`verify.yml`).
Background work (`run-work.spec.ts`) and the browser booking journeys (`task-browser-booking.spec.ts`) are such files: scratch homes, loopback SSH fixtures, a `launchctl` stand-in and a local test airline.
Desktop keeps the voice journeys (the dictation key and the microphone), the paint budgets tagged `@perf` (`tests/e2e/perf.ts`), and the demo recordings, which play at real speed.
Devices (`devices.spec.ts`, `devices-links.spec.ts`, `devices-command.spec.ts`, `devices-address.spec.ts` and `devices-ssh.spec.ts`) stays in desktop: under the parallel lanes' load, adding a Mac by its address, which packs the app at background priority (`src/core/devices/appArchive.ts`), outlasts the journey's wait for the Mac to join.
Automatic placement (`automatic-placement.spec.ts`) stays in desktop pending the full Mac and Linux parallel-lane qualification; its memory and compatibility readings remain live.
Its first two journeys replay captured busy and available CPU counters inside the isolated Electron process, releasing room only after observing the task's CPU wait (`tests/e2e/placementCpu.ts`, `docs/routing.md`).
No product hook or shared runner setting changes, and the remaining refusal journeys keep live CPU readings.
The task board (`task-board.spec.ts`) stays in desktop: a tile's summary lets go when its window loses focus, and on Linux's shared screen another journey's window can take that focus.
Google integrations (`integrations-google.spec.ts`) stays in desktop: its released-build case uses the packaged bootstrap, which ignores the launcher's private connection-port override, so that file has not qualified for sharing.
The application lane's recent journeys keep their existing assertions and fixtures: Copilot records its own clipboard writes and browser opens; the inbox links only inside scratch space; the privacy journey replays recorded log lines with its own process IDs; the browser journeys keep local sites and private sessions; and the task, card, panel and project journeys keep their own saved data and windows.
Their keyboard and pointer checks use the launcher's per-page focus, not the operating system's foreground window; none records a real-speed demo or grades paint budgets.
`tests/e2e-lanes.test.ts` pins these reviewed assignments and the files named here that stay in desktop.
A full run never stops at its first failure: it reports every failure, later tests still run, and desktop still runs after a failure in the parallel lanes; `tests/e2e-lanes.test.ts` runs the real lanes over fixture specs to hold this.

`INFINITARY_TEST_PROFILE=1` prints per-phase e2e launch timings (`tests/e2e/launch.ts`).

## Journey waits and check limits

A journey's waits run on the load clock and end by their wall cap, 20 times their budget and at most 10 minutes; a graded run keeps the wall clock (`docs/e2e-contracts.md`, "Waits run on the load clock").
A unit test's limits and waits run on the same clock and cap, and each `ci.yml` test step ends at 30 minutes (`docs/test-cohorts.md`, "Budgets").
Above every wait sit the whole check's limits (INF-1083, the captain's check limits).
A pull request's journeys and journeys on request end their run at 75 minutes (Playwright's `globalTimeout`, which `playwright.config.ts` reads from the workflow's `INFINITARY_E2E_RUN_MINUTES`) and their command at 90 (the step's `timeout-minutes`), on the Mac mini and on the Linux overflow alike.
Each journey job of the full Mac check in `verify.yml` ends its run at 150 minutes and its command at 180.
The Mac command's 90 minutes include the build and run; it does not wait for a command lease.

## Load never gates a run

The Mac mini is always busy with the fleet's other work, so no crewmate waits for its load to drop and no crewmate skips or defers a run because of load (INF-1541, the captain: "the mac will always be busy given how many other things our fleet needs to run").
A check runs now, at whatever the load is, and a number the crewmate picked from one loaded reading, such as "start below a one-minute load of 28", is not a project rule.
A run that fails or stalls under load is diagnosed from its own logs and fixed in the code that does not count the end of the work it waits for; it is not repeated until the load happens to be low.

## Notes

Moved verbatim from `AGENTS.md` on 2026-09-24; `docs/README.md` lists this page.

- The branch check's Linux `code-checks` and `build` jobs own typecheck, lint and build; the adherence lint runs in `pnpm check:changed` before each push and in `code-checks` only on request; do not duplicate them as a complete local pre-push gate.
  It also runs, once, each edited Vitest file and the unedited unit, integration and browser tests that import or read a changed file (`node scripts/unit-repeats.ts --reach`, from `directUnitReach`), in the `pure`, `unit`, `unit-isolated`, `integration` and `browser` cohorts (INF-2441, INF-2478, INF-2999, INF-3690's gap 3).
  An edited Mac-listed file runs there too, since Linux runs its portable cases in the merge batch and main's full check.
  It lists apart, with the run that owns each, an unedited Mac-listed reader (the crewmate's local round), a probe (main's full check, `docs/test-cohorts.md` "Probes") and, when the change touches the renderer or its browser tests, a browser test (the browser step, which then runs every browser file).
  It installs Chromium first, for the browser tests this step and the browser step run, and for an integration file that starts it, such as `tests/run-temp-root.test.ts`.
  It reads Vitest's JSON report afterwards and fails when a file it selected did not run, so a file none of those cohorts takes cannot pass unseen.
  A selection of more than `REACH_RUN_FILES` (100) files runs as several Vitest runs of at most that many, one after another, each with fresh workers and its own report, and every run goes even after one fails (INF-4163).
  A selection holding more than `REACH_PART_SECONDS` (900) measured seconds runs as the fewest parts of about that much each, a machine per part side by side, so its time stays inside the step's 30-minute limit however wide the change and however slow the machine (INF-5493).
  A measured second is one a file took in main's Linux test groups: `tests/helpers/shardTimings.json` for a unit file and `tests/helpers/reachTimings.json` for an integration or browser file, and a file neither measured weighs a typical one (`docs/test-cohorts.md`).
  The code checks job counts the parts right after its install; `reached-tests` runs the first part at once, `reached-tests-parts` runs each other part on its own machine once the code checks end, and a machine that counts the parts otherwise fails.
  An in-memory worker (`pure`, `unit`, `isolate: false`) keeps what each file it ran leaves behind until its run ends, so one run of a wide selection can use most of the memory of the check's runner, which has 7.9 GB and no swap.
  For the same reason the in-memory cohorts start no more workers than the runner's memory holds, as well as no more than its cores (`docs/test-cohorts.md`).
  An integration worker holds the programs its file starts as well, the quick check's among them, so the `integration` cohort also starts no more workers than the runner's memory holds: two on the 2-core, 8 GB Linux places, where four left as little as 278 MiB free and a SIGKILL, most likely from the kernel's out-of-memory killer, ended Vitest's own process (INF-5632).
  Required focused proof may run before or alongside the PR and must finish for its current version before merge.
  A selected local `renderer` or `application` spec needs `--no-deps`, since its teardown otherwise runs the whole `desktop` lane.
  Run the existing unit and integration tests a change can break by path, `pnpm test <path>...` (a bare file path finds its cohort, `docs/test-cohorts.md`), and the probes it reaches with `pnpm test:probes`.
  `pnpm exec vitest related --run <files>` is not that selection: it follows the whole transitive import graph, so a widely shared module reaches a large part of the suite (`src/shared/rigor.ts` reached 140 of 344 test files, 2026-09-30).
  The full unit, integration and probe suites run in the full check's Linux test groups on main and across `ci.yml`'s jobs on request, not on PRs; the full e2e suite (`pnpm build && pnpm exec playwright test`) is the release verify's job (next bullet); the full unit suite is not a per-push obligation.
  The full e2e suite runs only in CI, never locally during development or release preparation.
  The adherence lint runs the design skill's `_adherence.oxlintrc.json` through ESLint FlatCompat (current oxlint cannot execute its selector rules); its raw-px/hex rules are warn-level by the skill's own design.
- Standing CI rule (PR 8; CI shape revised by captain decision B, 2026-09-15, scout `fm3000-ci-release-only-s1`; split across machines by the captain's direction on FI3-1204, 2026-10-07; probes moved off every push by FI3-1756's plan, 2026-10-14): `ci.yml` runs the branch check on all pull requests, including release notes, as three Linux jobs side by side: typecheck and the lint, the tests a change reaches, and the build with the critical-path journey, with a fourth for the later parts of a wide change's tests ("What a pull request runs", "The critical path").
  The captain's INF-2273 ruling removes both unit-repeat shards; every edited unit file instead gets three total local runs, including portable files, and one more in the pull request's check ("Notes", above).
  Requested runs also run the full unit and probe sweeps and both integration shards, five jobs in total; there is no unit/integration selector.
  A push to `main` starts no `ci.yml` job (INF-2340, the captain's route "drop-ci-main"): the full check's `linux-checks` lane and its Linux test groups run the same commands, every probe included ("Main's desktop release check").
  `code-checks` runs typecheck and biome on pull requests, and the eslint adherence lint on a request; `reached-tests` runs the tests a change reaches, and `reached-tests-parts` the parts past the first of a wide change's; `build` runs the build and, on pull requests, the critical-path journey; `unit-tests` runs the in-memory cohorts (`pure`, `unit`, `unit-isolated`); `integration-tests`, shown as integration test groups 1/2 and 2/2, runs the integration cohort in vitest's own `--shard` halves, which split the files by a hash of their paths; `probe-tests` runs every probe (`docs/test-cohorts.md`, "Probes").
  The hosted runner has two processors and a personal account is offered no larger one, so the jobs run side by side; together they run what `verify.yml`'s `linux-checks` lane and its Linux test groups run, every probe included, and `tests/release-workflows-pr-checks.test.ts` holds every vitest project, in each layout, to one job or to shards that cover it, including the full probe project.
  Every job runs on the label the repository variable `LINUX_RUNNER` names, the placement service's `shell-pc-linux` places (a fresh two-processor VM per job on the Windows PC, five at once), and on GitHub's hosted `ubuntu-24.04` when the variable is unset, the one hosted image every workflow falls back to (INF-2539); `tests/release-workflows-runners.test.ts` evaluates each job's runner both ways.
  The shell PC job image supplies Node 24 and a pre-filled pnpm store, so setup-node restores its pnpm cache only on a GitHub-hosted runner (`runner.environment`); every self-hosted job, wherever a variable sent it, skips it.
  The same image gives pnpm's downloads ten minutes and four more tries, which `.github/actions/pnpm` gives a GitHub-hosted runner ("pnpm's own download").
  The repository variable `LINUX_QUEUES` can send a job's kind to another queue before `LINUX_RUNNER` ("Each Linux job's kind").
  Every other workflow's requested Linux jobs read the same variable the same way (INF-1720's plan): the journeys' chooser and overflow (the overflow's kind is `journeys`), `verify.yml`'s Linux lanes, the replay gate and the Linux packages; the package check's Ubuntu 26.04 leg takes the variable's label with `-2604`, the PC's 26.04 job image.
  The gate job a request starts takes the variable's label with `-gate` (DOP-157's plan): `journeys.yml`'s `choose-journeys` and `phone.yml`'s `request`.
  The placement service's runners on that label take only these jobs and go first in the PC's line, so the Mac job waiting on it starts within minutes; hosted, it runs on `ubuntu-24.04`.
  Main and release Linux jobs run on GitHub's hosted Ubuntu instead, except a publishing release's packages when its release queue is configured ("A release's hosted machines").
  Linux dependency installs use `.github/actions/node-headers`, which finds the running Node archive's `include/node` headers and refuses an image missing them; only the install receives that root as `NPM_PACKAGE_CONFIG_NODE_GYP_NODEDIR`.
  Uppercase preserves the setting through pnpm's lifecycle environment filter.
  That setting belongs only to the install, so later Electron rebuilds keep their own headers.
  `ci.yml` also forces a better-sqlite3 source build with an empty header cache and an unreachable header server, then writes and reads a database.
  The same workflow contract test evaluates the cache input for both runners.
  Every install restores what it downloads from GitHub's release server from the Actions cache first, and every package step restores electron-builder's tools ("Downloads from GitHub's release server").
  A new test file joins its cohort's job on its own; a new kind of check joins one of the jobs, never a step with a condition.
  The retained PR jobs have no release-branch exemption: they must actually run to provide the required project verification, even though the generic forge verdict accepts conditional skipped checks.
  CI green means every check on the exact head commit SHA reports status=completed and conclusion=success or skipped (`gh pr checks`); a project that runs no checks reads green with the empty list, but on GitHub an empty list where workflow runs exist or have run for earlier pull requests reads pending ("checks have not started yet"), and so does a pull request's list with none of its own workflow runs on the version yet where the project runs them (`docs/forge.md`, "The green rule").
  The macOS work - the Playwright e2e suite, the universal package smoke, the replay gate - is `verify.yml`'s three Mac lanes (INF-2779: the native tests, replay and package job, the parallel journeys job and the desktop journeys job), in a reusable workflow that rolling main calls for every lane but the old journey set and that `release.yml` calls for an alpha unless its swept batch ran every journey (every alpha runs or reuses the whole Playwright suite on Linux as `linux-e2e` ("The Linux source desktop" below) and on the Mac itself, and requires the Linux checks (`linux-checks` and every Linux test group) and the native tests, replay and package job, reused from passing main or newly run; a stable promotion inherits its alpha's successful checks or is refused: `docs/alpha.md` "The signed channel workflow") and that crewmates request on demand through `github_write` (`docs/forge.md`, "Verification workflow requests"); it is deliberately not per PR and has no trigger of its own beyond `main.yml`'s call on every push to `main` (the per-PR mac job was 98% of a ~$200/month bill).
  Every alpha runs every journey on the Mac itself, or reuses the swept batch's (INF-2480, the captain: "old set at the release check only, from the first piece on"); main's desktop release check (`main.yml`, "Main's desktop release check") and any other request run there only the tests tagged `MAC_ONLY_TAG`, since `linux-e2e` runs every other one ("Tests that need a Mac").
  Crewmate validation is agent-driven and evidence-first (captain rulings 2026-09-19, the no-mistakes alignment; `docs/delivery-rigor.md`): demonstrate the user intent end-to-end with product-level evidence for each concrete thing an end user would do and relevant existing end-to-end tests covering the surfaces changed, re-run after an overlapping rebase, named under Verified, and a relevant test that cannot run is named, never dropped quietly - the full unit and integration sweeps run on main and in release verification and the full Playwright suite and `pnpm package:mac` are `verify.yml`'s Mac lanes, with the full suite on Linux beside it (the full suite in every alpha or the swept batch it reuses, the package in rolling main and alphas without reusable proof, both in named full-run exceptions), with full e2e runs only in CI, never locally, and no configured command is mandated anywhere in the rigor pipeline.
  Never treat old SHAs as authoritative for the current head.
- A timing claim in a test is asserted as an ORDER or as WORK, never as a wall-clock window (captain's B1, 2026-09-24: "one clock, budgets measured"): on a host running several suites at once a millisecond budget, a runner-clock interval, or two short real timers racing measure the load.
  Log the events the behavior promises in one ordered list on the page, count what a paint built (`rail-panels.spec.ts`), wait on the event that follows the one you need, or drive a unit test's timers on a fake clock (`jobManager.test.ts`, `piAccountBackend.test.ts`).
  A fake clock that also advances with real time (`shouldAdvanceTime`) can fire a timer before the test does, so a step that fires the next timer while real work runs holds the clock still with `vi.setTimerTickMode("manual")` (`sessionHostDeadlines.test.ts`, INF-435).
  A journey that waits on one of the app's own passes - a redelivery after a restart, a check's reread, a placement sweep - spreads `SHORT_TICK` (`tests/e2e/launch.ts`) into its launch `env` rather than waiting out the app's one-minute tick: it names a two-second period in `INFINITARY_TICK_PERIOD_MS` (`docs/architecture.md`, "One clock"), which a packaged build ignores.
  A test that waits for another process to reach a step waits on a mark it made, through `reachMark` (`tests/helpers/reachMark.ts`), never on a folder's watch.
  On macOS a folder's watch is FSEvents, which held or dropped a new file's event while other unit rounds churned the disk, so `remoteLoginUpdate.test.ts` ran out its budget with the mark already there (INF-2578); `churnDisk` (`tests/helpers/diskChurn.ts`) makes that churn in the test that owns the wait.
  A process that waits for the test, such as a stand-in tool command, does the same the other way round: it watches a mark the test made empty, reads it once its watch is in place, and ends once the test appends to it (`processResources.integration.test.ts`, `placedClaudeCost.integration.test.ts`).
  The main thread's own processor time is work, not a wall-clock window: a busy host stretches a stall's wall time but not the work the main thread did in it, so the freeze journey (`tests/e2e/main-thread-freeze.spec.ts`) grades its 250 ms line wherever it runs (`docs/freeze-recorder.md`, "Before a change merges").
  A budgeted duration goes through `tests/e2e/perf.ts` (`measured`, or `graded` for a bar with a 95th percentile and a maximum, tests tagged `@perf`): printed and annotated every run, graded only by `verify.yml`'s on-demand `perf` input on a quiet host, the same run that holds vitest's tests to their budgets (`docs/test-cohorts.md`, "Budgets"); the Biome plugin `tests/lint/e2e-no-ms-budgets.grit` refuses `toBeLessThan(X_MS)` anywhere else in `tests/e2e`.
- Test temp directories: a test makes one only through `scratchDir(prefix)` (`tests/helpers/scratchDirs.ts`), removed after the vitest file or as the Playwright worker exits - never at module scope or in a Playwright `describe` body, which run in the runner (refused there).
  Both runners point TMPDIR at one private per-run root (`tests/helpers/runTempRoot.ts`, from each global setup) and FAIL the run naming whatever is still in it.
  Before removing the root, they use the task-close folder-holder reader and birth-checked stop (`src/core/placed/folderHolders.ts`) to end programs still working there or holding files there, including unlinked files and detached children, and fail naming each program, its process number and its result.
  The runner and its ancestors stay protected, but its finished workers' descendants do not; task-close callers keep their existing descendant protection.
  `scratchDir`, `socketScratchDir` and `removeLater` record external scratch paths in the run root while those paths still exist, so programs holding removed short socket folders are covered too.
  At global teardown, Vitest closes each actual browser provider before the holder scan, because its Chromium may hold temporary files outside its profile and artifact folders.
  Those known folders keep their existing file-entry exemption; no program is exempted by name.
  Vitest's Chromium starts with TMPDIR at a folder of its own in the root (`tests/helpers/browserChromiumTemp.ts`), because on Linux it keeps its shared memory there as files it unlinks right after making them, and a Chromium process that ends in between leaves one no test made; the teardown removes that folder once the browser has closed, before the scan, which still finds a program holding a file there.
  The work-mode journey launches each child in its own group and its own working folder, snapshots its descendants (including detached display keepers) before stopping them, and awaits the direct child's close (`tests/helpers/stopChildTree.ts`).
  Every program inherits its parent's working folder, so the stop also ends programs still working in the child's folder whose parent already ended, such as the update's return watcher (`src/core/helper/updateTrial.ts`), which a Mac work run starts as it ends and the system adopts.
  The watcher starts a new `sleep` each second, so the stop reads the tree again after each pass and returns only once a reading finds none of it.
  A killed child the system still lists after the task-close kill window is still finishing its end, so that cleanup waits until the reading no longer lists it, and only the test's own timeout ends the wait.
  The next run ends holders of abandoned roots before removing those roots, never touching roots whose owning run is alive.
  An unreadable holder list or a surviving program fails the run and keeps its root for the next sweep; on Windows the reading finds only programs working in a root or started from it, not one holding a file there open.
  `tests/run-temp-root.test.ts` drives both real runners, including a clean run, detached holders, forced termination, removed socket folders, multiple leftovers, a concurrent live run, Vitest's real Chromium beside an unrelated leaked daemon, a file left beside Chromium's real shared memory on Linux, and a browser run's own leftover.
  `tests/stop-child-tree.test.ts` drives real shell, app and keeper trees, including a detached keeper, children whose shell already exited, a keeper in its own session whose app already exited, and a program only a later reading lists.
  It also kills a real app that ignores the end request while the reading keeps listing it past the kill window.
  The run-root regression's real browser requires `pnpm exec playwright install --only-shell chromium` before local rounds; the integration and native-unit CI lanes install it through the shared browser action.
  Each global setup also drops the variables of the session that started the run (`tests/helpers/runnerSession.ts`: `CLAUDECODE`, `AI_AGENT`, `CLAUDE_*` and `ANTHROPIC_*`), so a run from a Claude crewmate starts its workers, apps and boxed Claude clients the way CI does; a test that wants one names it in the environment it builds.
  Work that writes after a test returns must be awaited first (`catalogRefreshesSettled` for Pi catalog refreshes).
  A computer that runs work in the placed tests stops only once it has answered the orders it was still answering, as its own process would end with them (`world` in `tests/helpers/placedWorld.ts`): a keep still running there wrote its answer into the computer's folder after the file had removed it.
  The leaked 300k-entry temp dir of 2026-09 made every mkdtemp cost seconds.
- Test ports: a test that gives a home, a stand-in server or any other listener a loopback port takes it from `claimedPort` (`tests/helpers/claimedPort.ts`), in vitest and Playwright alike.
  A port found by listening on port 0 and closing again is free only for that moment: another worker can be handed the same one, and the home that listens second fails while its join reaches the other worker's home, refused as not that Mac (INF-698).
  A claimed port lies below every ephemeral range and stays claimed by its worker until the worker exits, so no other worker, run or port-0 listener on the computer takes it, and a home that quits can open again where it was.

## Downloads from GitHub's release server

An install and a package step download files from GitHub's release server, and that server answers with a 504 often enough to fail a check before it reaches anything the check is for.
A GitHub-hosted runner, and each virtual machine the placement service makes fresh for one job, starts with none of those files, so each job reads them from the Actions cache instead and reaches the release server only for a version's first download.
A retry would not do it: electron-builder already retries a server error three times within about twelve seconds, and the server's outages last longer.

- **Every install** runs `.github/actions/electron-download` before `pnpm install`.
  It restores Electron's downloaded binary under a key naming the Electron version `package.json` pins, and points Electron's own installer at it through `electron_config_cache`.
  On macOS it also restores the app's own git archives for both chips (`scripts/ensure-bundled-git.ts`, dugite-native's archives) under a key naming the `dugite` version, through `INFINITARY_BUNDLED_GIT_CACHE` (`docs/forge.md`, "The app's own git").
  The script checks each restored archive against dugite's checksum and downloads again only one that differs.
  The action's `zips` input names the Electron zips a job reads beyond its install's own, which join the cache key: the Mac check's lane names both Mac zips for its universal package.
  Two installs go without it: `release.yml`'s signing job, which runs on the project's own Mac, whose home keeps both downloads between jobs, and restores nothing from the Actions cache into the app it signs; and an install allowed to fail (`continue-on-error`).
- **Every step that packages the app with electron-builder in the release path** - the Mac check's universal package, and a release's Mac and Linux packages - first runs `.github/actions/electron-download/zips.mjs`.
  It checks each zip the package reads against the checksums Electron's own package ships, in the cache electron-builder reads, and downloads only a zip that cache lacks.
  The package step then has electron-builder read that cache with its own checksum download off, since otherwise it fetches Electron's `SHASUMS256.txt` from GitHub's release server for every zip, and a 504 there failed both main's check and an alpha.
  A release's jobs run the workflow's own copy of the reader, since a stable builds an older alpha's commit (`docs/alpha.md`).
- **Every step that packages beyond an unpacked folder** runs `.github/actions/electron-builder-tools` before it, and again after it with `save: 'true'` under `!cancelled()`.
  The packaging tools electron-builder downloads from GitHub's release server go to `ELECTRON_BUILDER_CACHE`: the AppImage tools, 7-Zip and fpm for the Linux packages (`linux-packages.yml`), and dmgbuild for a disk image (`mac-installer.yml`).
  The first use restores the newest set saved for that electron-builder version, on that system and processor.
  The second saves the archives under a key naming their checksums, so a build that failed partway keeps what it fetched, and a set the cache already holds is not saved again.
  On a restored archive, electron-builder checks the checksum it pins and downloads again one that differs.
  An unpacked folder (`--dir`, `--mac dir`) needs no tool, and `release.yml`'s signing job keeps electron-builder's cache in its Mac's home.
- **The publication job's keyless fetch-backs** must ask the release server for the taps' copies, since the copy they check is the one Homebrew fetches, so they wait out its outages instead: each keyless download, Cloudflare's too, goes through the workflow's own `scripts/fetch-without-credential.sh`, which tries a server error or a lost connection again for up to 30 minutes a file and fails on any other answer, such as a 404, after five more tries (`docs/alpha.md`, "The signed channel workflow").
  `tests/release-workflows-handoff.test.ts` runs each of those steps against a stand-in server that answers 504 first.
- `tests/workflow-hygiene.test.ts` holds every install and every package step to these.
  `tests/ensure-electron-installed.test.ts` runs the download action's steps with Electron's own installer and the app's git script, and each zips reader step, against a stand-in server, and `tests/electron-builder-tools.test.ts` runs the tools action's steps with electron-builder's own downloader.

## pnpm's own download

Every job outside the release path takes pnpm itself from the Actions cache through `.github/actions/pnpm`, before setup-node and before its first pnpm command.
`pnpm/action-setup` installed pnpm from npm's registry on every job, with three tries in about a minute, and twice in a day all three timed out on a fresh self-hosted Linux machine, so the pull request's check and a journeys job failed before any of the project's steps ran.
The action reads the version from `packageManager` in the checkout's `package.json` and restores that version's npm package under a key naming the version and the system.
On a miss it downloads the package from the registry through `scripts/fetch-without-credential.sh`, which tries a timeout, a lost connection or a server error again every 30 seconds for up to ten minutes, checks the package's version, and saves it at once, whatever the job does next.
It puts `pnpm` and `pnpx` commands on the PATH that run the package's own entry on the job's Node, and points `PNPM_HOME` at a folder of its own outside the cached one, so a store pnpm keeps under its home is never saved with the package and stays the job's own, as before.
A branch's jobs read the entry a run on `main` saved, so once `main` has run a version, no job reaches the registry for pnpm itself.
`linux-packages.yml`'s jobs take the workflow's own copy of the action and of the fetch script, since a stable builds an older alpha's commit, and set up the pnpm that commit pins.
The release path (`release.yml`, `ios-release.yml`, `mac-update.yml`, `republish-casks.yml`) and the Windows trial still run `pnpm/action-setup`.
`pnpm install` still reaches the registry for a package the machine's store lacks.
On a GitHub-hosted machine the action also gives pnpm's own downloads the waits the project's self-hosted job images give them: ten minutes a download and four more tries, as `pnpm_config_fetch_timeout` and `pnpm_config_fetch_retries` in the job's environment.
By default pnpm gives a download 60 seconds, the whole file included, and two more tries.
A hosted job starts with an empty store whenever `main` has saved none for the current lockfile, which is the usual case after a lockfile change, since `main`'s check skips what a batch already checked; a batch's hosted Linux journeys job then failed its install when an 86 MB package took longer than 60 seconds three times.
A self-hosted machine keeps the waits its own image gives pnpm.
As environment values, the hosted waits win over the project's own pnpm settings, which set none.
`tests/workflow-hygiene.test.ts` holds every other job to the action, and `tests/pnpm-action.test.ts` runs its steps against a stand-in registry that answers 504 first, and the project's own pnpm against a stand-in registry whose package arrives slowly.

pnpm leaves out an optional package whose download failed and says nothing, and the install still exits 0.
Most optional packages here are a platform's native part, such as the Claude SDK's or esbuild's, so the install looks whole until a program loads that part: the same batch's hosted Linux journeys installed without the Claude SDK's Linux package, and its Claude journeys failed with "Cannot find module".
`scripts/check-installed-packages.ts` runs first in the project's own `postinstall` and refuses such an install, naming each package left out and the packages that need it.
Each package that needs a left-out package still links to it, so pnpm leaves a link that leads nowhere, while a package built for another platform gets no link at all; the check fails on a link that leads nowhere.
The Windows installer check installs without scripts and runs the check by itself.
`tests/check-installed-packages.test.ts` runs the project's own pnpm, with the check as its `postinstall`, against a stand-in registry publishing a package shaped as the Claude SDK is, whose native part arrives slowly.

## GitHub refusing a job's token

Every checkout in main's check and in a release waits while GitHub refuses the job's token, then checks out once more.
A release once lost seven of its eight Linux package checks at `actions/checkout`: GitHub answered "Repository not found." to every job's token for about three minutes, while its status page reported no incident.
The action's own retry is three tries about 12 to 20 seconds apart, which cannot be changed, and a failed main check is never run again, so one such refusal there held the alpha until the next merge.
A job's first checkout cannot use a local action, since nothing of the project is on disk yet, so each checkout carries its patience in three steps of its own:

1. The checkout, with an `id` and `continue-on-error: true`.
2. "Wait until GitHub takes the job's token", which runs only after the checkout failed.
   It asks the address the checkout's fetch reads (`info/refs?service=git-upload-pack`) with the job's token, as the checkout sends it, every 15 seconds for up to 10 minutes, naming each answer in the log.
   The token reaches curl on its input, never its command line.
   A failure the token did not cause, such as a missing commit, gets an answer at once, so the checkout is tried again at once.
   Once its patience is spent it leaves a warning and lets the checkout try anyway.
   In a job whose default working directory is its checkout, it runs from the runner's temporary folder.
3. The same checkout again, under the same condition and with the same inputs (a YAML alias of the first's `with`), without `continue-on-error`, so a second refusal still fails the job.

Ten minutes is over three times the one refusal seen, and fits inside every job's time limit.
The wait's script is a YAML anchor in each workflow file (`&wait-for-token`), the same text in every file.
The rule covers `main.yml`, `release.yml` and every workflow they reach through a call, whatever else calls it: `verify.yml`, `source-journeys.yml`, `mac-installer.yml`, `linux-startup.yml`, `linux-packages.yml`, `mac-update.yml` and `windows.yml`.
Workflows outside that reach, such as a branch's own check (`ci.yml`), the swept batch's own jobs (`batch-checks.yml`) and the phone release (`ios-release.yml`), still check out once.
`tests/workflow-hygiene.test.ts` holds every checkout of those workflows to the three steps, and `tests/checkout-patience.test.ts` runs the wait against a stand-in for GitHub's git address that refuses first.
A test that reads a job's steps in order reads them through `firstTry` (`tests/helpers/releaseWorkflows.ts`), the steps that run when every checkout passes the first time.

## Tests that need a Mac

The captain's principle of 2026-10-28 (`docs/principles.md`): a test runs on the Mac only when it needs a Mac, and Linux runs every test it can.
A journey needs a Mac when it skips on Linux, or when it has a step only a Mac runs; it then carries `MAC_ONLY_TAG` (`tests/e2e/tags.ts`) in its own details, `test("…", { tag: MAC_ONLY_TAG }, …)`, or a describe's around it, beside its own `test.skip` and reason.
A unit test that needs a Mac is a file of the reviewed list in `scripts/mac-unit-tests.ts` instead (`docs/test-cohorts.md`).
`tests/mac-unit-gates.test.ts` holds the list to that: a case behind a `runIf` or `skipIf` that runs it on macOS and not on Linux sits in a listed file, or Linux skips it and the Mac lane never runs it.
The captain's INF-2273 local-round exception covers every edited unit file, including portable files; the native list still governs the full-check Mac lane.

Where each journey runs:

| Run | Linux | Mac |
| --- | --- | --- |
| A request for journeys (`journeys.yml`) | every named journey when `platforms=linux` or `both` | tagged tests when `platforms=mac` or `both`, every test of each edited named journey once more with `mac_once`, or every test with `mac_all` |
| A requested full check (`verify.yml`) | every journey | every tagged test, or every journey with `all_journeys` |
| The run on `main` (`main.yml`) | none | every tagged test |
| The swept batch (`batch-checks.yml`), which an alpha from its merges reuses | every journey | every journey |
| An alpha that reuses main's checks (`release.yml`, `part: journeys`) | every journey | every journey |
| A manual alpha without reusable proof (`verify.yml`) | every journey | every journey |

Three checks hold the tag to what a test needs:

1. Every Linux journey job, `source-journeys.yml`'s overflow and full shards, fails on a test that skipped there without the tag (`scripts/untagged-skips.ts`), whether its journeys passed or failed.
   The run-alone pass refuses one itself ("Each test owns its prerequisites" above).
2. The `e2e-mac-tag` lint in `pnpm check` (`tests/lint/e2eMacTag.ts`) refuses an untagged test that reads a Mac fact, and a tagged test that reads none.
   A test reads a Mac fact when its own code, or a `test.skip` or hook of the describe or file around it, names `THIS_DESKTOP` or `HAS_APP_MENU` (`tests/e2e/desktop.ts`) or the platform name "darwin".
   A step only Linux runs, such as a comparison with "linux", needs no Mac, and a helper the test calls is not followed.
3. `tests/release-workflows-journey-requests.test.ts` holds the Mac steps of `journeys.yml` (`--grep @mac-only`) and `verify.yml` (`INFINITARY_E2E_TAG=@mac-only`) to the tag, and the untagged-skip step to every Linux journey job.
   `verify.yml` names the tag in `INFINITARY_E2E_TAG`, which `playwright.config.ts` makes every lane's filter: the command line's `--grep` filters only the lanes a run names, so the `desktop` lane, the others' teardown, would still run every test it holds.
   `tests/e2e-lanes.test.ts` runs the real lanes over fixture specs to hold this, with `desktop` still running after the parallel lanes.

`tests/e2e-mac-tag.test.ts` drives the first two on this repository's own journeys and a Linux run's real result.

### Platform and signing are separate

Where a check runs and whether it proves real signing are two separate declarations: a Mac requirement, `mac_all`, `all_journeys` or a full run never implies custom signing.
Every journey is an isolated source test on disposable data and Electron's supplied signature, on the Mac as on Linux, Mac keyboard behavior included; no journey route runs `pnpm codesign:local` (`journeys.yml`, `scripts/local-mac-journeys.ts`, `scripts/virtual-mac/job.sh`).
The genuine signing proof is `verify.yml`'s own stages: `dev-signing` signs the dev Electron, `package` builds its own signed copy of the app, and `codesign` and the package checks read the real signatures.
The native tests, replay and package job runs that proof, and no stage of that job launches the dev Electron after it signs it: its group of the parallel journeys (`e2e`, INF-2987) ends before `dev-signing` starts, and the perf journeys run in the journey jobs alone, so signing never changes what those journeys ran on, and a failed signing stage stops none of them.
Each journey job logs the dev Electron's signature before the suite, read from the binary, and a red signing stage still ends the full check red.
Logic-only signing tests use the stand-in `security` and `codesign` commands under `tests/fixtures/local-codesign/`.
`tests/release-workflows-verify-evidence.test.ts` holds both: no journey route signs, and the signing stages share no job with the journeys and fail their own.

## When to request full verification

Full Mac verification is not a routine pre-PR or pre-merge gate.
Crewmates almost never request it on task branches because rolling main supplies broad post-merge coverage, automatic alphas reuse that exact proof, and every alpha runs or reuses every journey.
Broad code changes, extra confidence and a rigor level alone are not exceptions.
Keep the checks "What a task branch requests" names, with their repetitions; do not add supplementary signed checks merely because portable code changed or a defect appeared on a Mac.

The exceptions are an alpha candidate lacking reusable exact-source main proof, an evidenced full-run repair or infrastructure qualification that narrower checks cannot prove, coordinated missing-evidence recovery after reading existing runs/artifacts, or an explicit captain full-run request.
Preserve full Linux/Mac parallel-lane qualification and stable promotion's inherited-alpha rules.
A change sent back from its batch is a named exception for the Linux checks alone: it requests `linux_only` ("A change sent back from its batch"), never `full_system`.
Record the requesting task, exact source and reason explaining why narrower proof is insufficient.
Before dispatching, inspect existing same-source checks and artifacts, including running checks, to avoid duplicate work.
A request for all Linux proof authorizes Linux only, never Mac tests, signing or packaging.
Use `source-journeys.yml` with `suite: full` for that sweep; Linux-only success is not full-system main or release proof.
A Mac-specific exception, such as a Mac runner's trial or a repair only the Mac jobs can prove, requests `verify.yml` with `mac_only: true` in place of `full_system`: its three Mac jobs run and no Linux job does (INF-2850).
Mac-only success is not full-system main or release proof either.
`mac_all` and `all_journeys` belong only to a named Mac-specific proof or full-run exception, never reassurance.
Signing consent remains separate.

## Full e2e runs are CI-only

Run only the affected spec files locally.
`playwright.config.ts` refuses a local run without an explicit `.spec.ts` file filter, including runs filtered only by project, grep or last failure.
`--list` is allowed because it discovers tests without executing them.
For `renderer` or `application` specs, add `--no-deps` to avoid pulling in the whole `desktop` lane.

Only for a named exception under "When to request full verification", start `verify.yml` in GitHub Actions for the required branch or tag.
Crewmates use `github_write` to POST `/repos/{owner}/{repo}/actions/workflows/verify.yml/dispatches` with `{"ref":"<workflow-branch>","inputs":{"full_system":true,"ref":"<exact-source-commit>","task":"<task-key>","reason":"<named exception; why narrower proof cannot suffice>"}}` and any other required inputs through the app's own GitHub sign-in (`docs/forge.md`, "Verification workflow requests").
For the Mac jobs alone, pass `"mac_only":true` in place of `"full_system":true`, with the same source, task and reason; the two cannot be combined.
For the Linux jobs the swept batch runs, a change sent back from its batch, pass `"linux_only":true` in its place, with the same source, task and reason; it combines with neither.
For an isolated Mac proof, pass the optional `mac_runner` input with a temporary runner label; it changes only that invocation's Mac lanes, never `MAC_RUNNER` or the Linux jobs.
A Mac runner's trial pairs it with `mac_only`, so no Linux job runs beside it.
The reusable workflow accepts the same input, and leaving it unset keeps the normal project runner and hosted fallback.
An accepted request is not a passing check: find the run with `github_read`, confirm its version, then read `check_change`.
CI sets `CI`; do not set it locally to bypass the guard.
An automatic alpha reuses the exact passing rolling-main check without repeating it, and runs every journey on Linux and the Mac itself, which main does not.
Release-specific signed-package, update, phone-order and publication gates still run, and no local full run precedes a release.
The full-suite workload measurement (`scripts/test-workload.ts`) must also run in CI.
Unit tests are unchanged.

## Where the heavy checks run

The hybrid owners above decide required proof: portable journeys use Linux CI, every edited unit file has three total local runs, and selected native journeys use the admitted Mac route.
The setting below governs local command refusal, not a second assignment of every check to one place; without it, commands allow local diagnostics where the project rules permit them.
A computer opts into CI mode with one git setting, `git config --global infinitary.checks ci` (INF-800, the captain's approval: "Only the heavy checks: journeys, the phone check and the replay gate").
INF-2074's ci-gate fix adds the typecheck and the lint; INF-2273 leaves every edited unit file's three total rounds local, outside this setting.
In CI mode these checks refuse to start outside CI and name their route on request instead (`scripts/checks-mode.ts`).
A committed journey copied under another name, or a journey's edits run before they are committed, is still that journey: its proof goes through its route at the exact version, never a local run of a copy.
The edited unit files' own rounds stay on the local unit route.
The routes:

| Check | Command that refuses | Its route in CI mode |
| --- | --- | --- |
| Journeys | `pnpm exec playwright test` naming a committed journey (`playwright.config.ts`) | Portable proof uses `journeys.yml` with `platforms=linux`; the admitted selected-native route above is allowed locally without changing CI mode |
| The phone check | `pnpm test:phone` and `scripts/test-phone.ts` | `phone.yml` on request ("The phone check on request") |
| The replay gate | `pnpm replay:gate` | `replay.yml` on request (`docs/replay-harness.md`, "The gate") |
| The typecheck | `pnpm typecheck` | the branch check's `code-checks` job; before a pull request, `ci.yml` on request |
| The lint | `pnpm check`, `pnpm lint` and `pnpm lint:adherence` | the branch check's `code-checks` job runs `pnpm check`; the adherence lint runs in `pnpm check:changed` and in `ci.yml` on request |

`pnpm check` (`scripts/check.ts`) runs every step it names in `package.json`, one after another, even after one fails, and ends by naming each step that failed, so one failure never hides the lints after it (INF-5379).
Only its first command, the refusal in CI mode, stops it.

A crewmate runs `pnpm check:changed` (`scripts/check-changed.ts`, INF-2588 fix 1) before every push, on a CI-mode computer or not: Biome on the files its branch changed, the design adherence lint on the changed renderer files, every node script `pnpm check` runs (its project lints and generated-file `--check` scripts, read from `package.json`), the pull request's release-notes check once the branch has a commit, the size headroom ("The size check's warning line"), the phone contract flag ("What a pull request runs"), and the whole-project typecheck.
They run side by side, as many at once as the job has cores (`scripts/job-cores.ts`) and its computer's memory holds at 2 GiB a step, room for the largest, so a lint or a missing release note fails before the push instead of in the pull request's check.
A step that loads the app through a Vite module runner holds about 0.9 GB, so cores alone are no bound: an 11-core, 9 GB Linux guest with no swap runs four at once, where eleven ran it out of memory beside the test files sharing it.
Started all at once they hold more memory than the two-processor Linux runner has beside the tests it runs.
Biome is handed every changed file and its own configuration picks which of them it checks, as in the full lint, so the quick check keeps no list of file kinds of its own.
It starts Biome and ESLint itself, as the Node script each package names under `bin` (`packageProgram`), never through pnpm or a shell: on a Windows PC pnpm is a `.cmd` file, which Node starts only through a shell, and a shell would read a changed file's name as its own words.
A checkout with no main branch to compare with, such as main's own check of a push, counts as having nothing committed since main, so its release-notes check waits.
It is not gated by CI mode, takes seconds, and prints every error; the full lint and the typecheck stay in the branch check's `code-checks` job as INF-2074 set it, so this narrows INF-2074's choice that the typecheck runs only in CI.
Crewmates start each route the way they start a full verification: `github_write` to `POST /repos/{owner}/{repo}/actions/workflows/<workflow>/dispatches` with `{"ref":"<branch>"}` and the route's inputs (`docs/forge.md`, "Verification workflow requests").
An accepted request is not a passing check: find the run, confirm its version, then read it.
The branch check's own `code-checks` job is the full typecheck and lint, so only `ci.yml` started on a branch with no pull request adds Linux work for them; a request runs code and build only, and the test sweeps need the `sweep` input set to `true`.
Every edited unit file gets three total local runs in both modes ("This project's rulings on tests"); PR CI has no unit-repeat job, and runs each edited file once in its build check.
Pictures and demos for a card stay local too: they are evidence, not checks.
A throwaway picture or demo script is never committed, so the journey guard lets it run; an existing spec cannot take pictures in CI mode.
Inside CI (`CI` is set) the heavy checks always run, because the Mac mini's runners run as the same user and read the same git settings.
`INFINITARY_CHECKS=local` or `INFINITARY_CHECKS=ci` overrides the git setting for one run in a terminal; the app's crewmates do not see a shell profile's variables, which is why the setting is a git setting.
A value other than `ci` or `local` refuses rather than guess.
`tests/checks-mode.test.ts` runs each command with a scratch home's git settings.

## A local heavy run's place

A local `pnpm test:phone` gate and every local `playwright test` run, repeats included, take a place before their heavy work: the gate before it builds, a journey run in the e2e global setup before any test starts (`scripts/heavy-run-place.ts`).
Inside CI the job already holds its runner's place and asks for none.
With `BORROWED_PLACE` set, the run says it rides that borrowed place and does not ask the load line; the virtual Mac's measured load is not declared again.
A phone part the gate starts rides the gate's place.

Where the shell has this computer's load line, the run declares its needs there through `infinitary-load-axi run` and holds them until it ends (`docs/heavy-runs.md`).
The supervisor preserves the gate's input pipe on a separate descriptor before starting background children, including under dash; closing that pipe ends an admitted hold or terminates a still-waiting group.
A phone gate still declares 4 processors and 8192 MiB, sized from DOP-113's measured runs on the Mac mini, which include the simulators launchd starts outside the run's process group (INF-1664); it has not been remeasured.
A journey run declares its resolved Playwright worker count N as N processors and `1536 * N + 512` MiB: two workers ask 3584 MiB (3.5 GiB), four ask 6656 MiB (6.5 GiB).
The local default is two workers; an explicit `--workers` count or percentage wins, and CI keeps its own worker count without asking the local line.
The measured basis (INF-2165) is the summed macOS process-tree footprint sampled about twice a second on the Mac mini: one worker peaked near 1.6 GiB, four at 5.7 GiB, and ten at up to 13.7 GiB during ten-repeat journey runs.
The declaration rounds that to 1.5 GiB per worker plus 0.5 GiB for the runner.
Footprint includes compressed pages at full size, while short peaks between samples can be missed; these measurements are not a bound on every journey's possible use.
The run prints the line's facts while it waits and says when it is admitted.
A run that ends or dies gives its hold back.
A run stopped while it still waits leaves the line: a small supervisor outside the run's process group ends the waiting command once the run's end closes its input.
Inside a run its caller already declared, the run rides that hold, and the line refuses it when the outer run declared less.

Where the shell has no line, the run says so and starts at once, asking nothing else (INF-2137, the captain's "completely remove fm-placer and any fallback logic now").
The shell has no line when the command is not on its PATH, the shell has no task channel, or the app gives the task no line, as an app older than the line does.

`tests/heavy-run-place.test.ts` drives a journey run, a run killed while it holds its place, nested runs, and each way a shell has no line starting at once, through the real task channel and line (`tests/helpers/heavyRunLine.ts`, `tests/helpers/noLoadLine.ts`).
`tests/heavy-run-place-phone.test.ts` drives the phone gate the same way; the gate needs a Mac, so that file is on the Mac lane's list ("Tests that need a Mac").

## A main repair's priority label

Our own runners queue a main repair's checks ahead of other work when its pull request carries the `fixes-main` label.
The label is a project rule for infinitary-labs/infinitary-apps only, not app behavior and not a setting (INF-1423, direction A).
A crewmate that repairs a failing main follows these steps:

1. It records the evidence that main fails, then confirms its own open pull request targets main from the same repository and its exact task branch.
   Diagnosis may come before or after the pull request exists, and resumed work repeats the confirmation.
2. It adds only `fixes-main` through the generic GitHub label tools, keeps every other label, and reads the labels back before requesting checks on that branch.
3. When it withdraws the repair, it removes only `fixes-main`.
   A write whose outcome is uncertain is checked by reading, never repeated blindly.
4. A closed pull request keeps the label as history: the service ignores it while the pull request is closed.
   Reopening restores eligibility, so the crewmate reassesses whether the pull request is still a main repair.

Priority never interrupts running work, and capacity, test gates and merge consent are unchanged.

## The prompt budget's two lines

The first mate's and a crewmate's fixed prompts each have a budget derived from the smallest local window (`docs/orchestrator-contract.md`, "The fixed-context budget"), and each budget has two lines (INF-2930).
`tests/helpers/promptBudget.ts` owns the budgets, the count and both lines; the two fixed-context tests and `scripts/prompt-budget.ts` read it.

- **The hard line, one and a half times a crewmate's budget and a quarter over the first mate's raised one.**
  `tests/firstmate-fixed-context.test.ts` and `tests/crewmate-fixed-context.test.ts` fail only past it, naming each reading, its budget and its hard line.
  Every check that merges or releases runs them, so only an overrun this large holds a merge or a release.
  Their room tests hold the conversation the hard line leaves in the 64K window and keep the real pre-send guard's refusal of one token more.
- **The budget itself.**
  `node scripts/prompt-budget.ts` runs the same budget tests with `PROMPT_BUDGET_LINE=budget`, prints every reading and fails naming each one over its budget.
  `prompt-budget.yml` runs it on each push to main that changes the app's source or runbooks, and by hand.
  No pull request starts it, and the batch, main's release check, the alpha and every release never read it; `tests/prompt-budget-workflow.test.ts` holds that.
- **The trim task.**
  An Automation rule on GitHub's "A workflow run fails", filtered to workflow `prompt-budget` on branch `main`, files and starts one trim task unless one is already open.
  It works as `docs/orchestrator-contract.md`, "How a trim works", says: at the Careful level on the strongest model, toward 90% of each budget, with every served sentence it removes or alters listed by `node scripts/served-sentences.ts` and marked for its reviewer.
  A red run's output says the same.
  It never changes a protected sentence ("The protected sentences").
  It changes served text, so it asks before it merges.

## The protected sentences

Some served sentences decide what an agent may do without the captain: consent, what reaches the captain, merges, tests, private data and deleted files.
Each fixed-context test keeps a list of them, `PROTECTED` in `tests/firstmate-fixed-context.test.ts` and `tests/crewmate-fixed-context.test.ts`, and fails naming the intent and rule of each sentence no longer served word for word in the home its entry names.
`tests/helpers/protectedSentences.ts` names the six intents, and each list fails when an intent has no sentence.

- **Only the captain's approval changes one.**
  Changing or removing an entry, or the served words it names, is weakening a test ("This project's rulings on tests"), so it waits for the captain's approval, in its own change.
  A trim never shortens a protected sentence to make room, and never re-types an entry to match one it shortened.
- **A new sentence joins in the change that adds it.**
  A change that adds or restores a served sentence deciding one of the six intents adds its entry, naming the intent and the rule it serves.

## The size check on AGENTS.md

`AGENTS.md` is read by every agent session in this project, so it holds only the captain's principles, pointers to ground truth and the rules no check stops; its own "Maintaining this file" says what belongs.
Its length has two lines, the captain's picks, built as the prompt budget's two are.
`scripts/agent-memory.ts` owns both lines and counts words as `wc -w` does.

- **The ceiling, 1,500 words.**
  `pnpm check` runs `node scripts/agent-memory.ts`, which refuses an `AGENTS.md` over `AGENTS_WORD_CEILING` words, so every check that merges or releases holds it.
  The same run refuses a path the file names in backticks that does not exist, a quoted section heading after a path that the page does not have, a page under `docs/` that `docs/README.md` does not list, and a listed page that is gone.
- **The warning line, 1,200 words.**
  `node scripts/agent-memory.ts --warn` fails past `AGENTS_WARNING_WORD_LIMIT` words.
  `agent-memory.yml` runs it on each push to main that changes `AGENTS.md`, the script or the workflow, and by hand.
  No pull request starts it, and the batch, main's release check, the alpha and every release never read it; `tests/agent-memory-workflow.test.ts` holds that.
- **The trim task.**
  An Automation rule on GitHub's "A workflow run fails", filtered to workflow `agent-memory` on branch `main`, files and starts one trim task unless one is already open.
  The trim brings the file back to 1,200 words or under with no rule lost, by moving detail to the page that owns it.
  It is a documentation change, so it asks before it merges.

## Main's desktop release check

Main's check is the desktop app's release check (INF-2498, the captain: "the main check should be clarified to be specifically about the desktop app's release").
Its passing run is what the desktop app's alpha is cut from; the phone app releases through its own checks (`ios-release.yml`).
A push to `main` starts `main.yml` (INF-2146, the captain's approved plan, direction B), which calls the full check for files no merge batch built ("The swept batch").
A batch merges with the person's own sign-in, so its merge is a push like any other and starts the run itself.
Beside the full check it calls `linux-startup.yml`, the Linux automatic startup fixtures (INF-2441); a push the swept batch covered runs neither, since the batch ran both.
A push whose every changed file is in the phone app or the docs starts no run (INF-2492, the captain's decision "Skip pushes that change only the phone app or the docs"): its `paths` filter excludes `ios/`, `docs/`, `primitives/`, `release-notes/changes/` and `docs-site/`.
It includes the shared font notice under `ios/` and the generated `docs/contract.json`, which are desktop build inputs.
Phone check helpers in `scripts/` and `tests/helpers/` are not the phone app, so a push that touches them runs.
The sentence-per-line check runs in `pnpm check` on every pull request.
Other docs breaks that only a unit test reads, such as `tests/served-boundary.test.ts`, surface at the next push that runs, and a skipped push leaves main's green mark on the older version.
The full check is `verify.yml`'s checks part (`part: checks`, `all_journeys: false`): the Linux checks, and the three Mac lanes with only the journeys tagged `MAC_ONLY_TAG` beside the unit, client, replay and package stages.
It runs no old journey set (INF-2480, the captain: "old set at the release check only, from the first piece on"): every alpha runs every journey on Linux and the Mac itself, or reuses the swept batch's (`docs/alpha.md`, "Full alpha checks, inherited stable checks").
It replaces the nightly full check, which requested it and the phone check on `main` once a night.
Main runs no phone check (INF-2492, the captain: "remove phone check from main altogether. we run all phone check parts at release"): `ios-release.yml` calls `phone.yml` at its resolved source before each TestFlight upload, which runs every part on the iPhone and the parts about the iPad and the iPhone Duo on each, in one job from one build.
The workflow's concurrency group never cancels a run in progress, so GitHub keeps the running run and at most one waiting run; a newer push replaces the waiting one, and a burst of merges is checked once at its newest version.
No check starts while the previous check's alpha is being cut (INF-2465, the captain: "i want to make it so that the next main check keeps queueing all merges until the alpha is actually cut successfully, not while the alpha cut is still happening").
The run's wait, `alpha-wait.yml`, lists the rolling alpha runs by the name `release.yml` gives them ("Alpha from main run N") and waits while any is still running, including one re-run after it ended.
It also waits for the alpha cut from the newest earlier main run that passed, which that run's last job dispatched (`docs/alpha.md`, "Cutting an alpha"); a failed run dispatches none.
The wait holds no machine while an alpha is cut, and nobody waits longer for it (INF-2834, the captain's pick: "Make main's wait for an alpha cut hold no machine").
Each rolling alpha run holds the concurrency group `rolling-alpha-from-main-run-N` (`release.yml`), and the wait's `wait` job joins the group of each alpha still running, so GitHub keeps it pending, on no machine, until that run ends.
Only its `find` job, for the moments GitHub takes to start an alpha and put it in its group, and its `ended` job, which confirms every alpha ended, take a machine, about a minute each.
An alpha run that holds no group, such as one started before the groups, is still waited for by polling in the `ended` job.
A failed cut ends the wait too, so it never holds main's fixes; an alpha run that never started holds nothing after ten minutes, and that polling ends before GitHub's six-hour job limit.
Its scripts ask GitHub again after a server error, the answer GitHub gives a request that takes it more than ten seconds, so one slow answer does not fail main's check.
While it waits, merges keep queueing in the one waiting run; when main moved meanwhile, the run cancels itself, so the waiting run checks every merge at once.
While the captain has paused the rolling pipeline, a run a push started cancels itself in that first job, and the next merge after Resume starts the run that covers the pause (`docs/alpha.md`, "Pausing the rolling pipeline").
The newest passing run of `main.yml` is main's green mark: its commit is the newest version main's full check passed, and no other record names it.
An untagged journey that fails fails the alpha cut from that run, which publishes nothing, while main's mark still moves (`docs/alpha.md`, "Failed alpha checks").
A failed run fails on the version it checked, which can be older than `main`'s head, so a repair reads that run and the range of commits since the newest passing one.
Merging continues while a run is red.
A red run reaches the crew through the captain's own Automation rules on GitHub's event "A workflow run fails", for the workflows `main` and `release` on the branch `main` (`docs/integrations.md`, "GitHub's events"): its words start one repair crewmate under the main repair direction, or steer the repair already open, and the app's code names no repair (INF-2146).
The repair fixes forward, and a revert is the last resort, on the captain's click.
A failed journey fails the alpha's run, `release.yml`'s "Alpha from main run N", not main's, so a rule watches `release` too (the captain on INF-2508: "Yes: watch the release workflow on main too").
A successful completed main run automatically starts an alpha at that exact source, not a newer main head (`docs/alpha.md`, "Cutting an alpha").
That alpha ends green without cutting while an earlier alpha is still being cut or a stable is being promoted or rehearsed, or when nothing the desktop app is built from changed since the previous release (`docs/alpha.md`, "An alpha with nothing new to build").
The alpha reuses main's checks after reading both owners and every latest per-job result on that exact source, and runs every journey itself unless the swept batch ran them ("The swept batch"); release-specific gates still run.
Ordinary CI starts nothing on a push to `main`: the full check's `linux-checks` lane and its Linux test groups run the same typecheck, lint, build and every unit, integration and probe test, so the five jobs ran them twice (INF-2340, the captain's route "drop-ci-main").
The full check runs no run-alone pass either; the proof of edited journeys runs it at author time ("Each test owns its prerequisites").
Its Linux jobs run on GitHub's hosted Ubuntu, whatever `LINUX_RUNNER` says, so the run never waits in the PC's line ("A release's hosted machines").
There one two-processor machine ran every vitest project past its step's 60-minute limit, so the Linux checks run on nine machines at once (INF-2646, the captain's approved split): `linux-checks` runs the typecheck, the lints and the build, and `linux-tests` runs the tests in eight groups, `pure`, `unit` and `unit-isolated` in three, `integration` in two, `probe` in two and `browser` in one, each group a set of vitest's own `--shard`.
Each group keeps the 60-minute limit and reports whatever another did, and the alpha's proof requires every group's complete set (`scripts/main-alpha-proof.mjs`).
`tests/release-workflows-main-check.test.ts` holds the trigger, the skipped paths against real merges, the queue, the calls and the phone release's call of every part.
Beside the wait, its `sort` job reads each push against the swept batch ("The swept batch"): a push whose files are exactly a passed batch's skips the full check once the wait ends, and only files no batch built get the full check (the captain's pick on INF-3052, "A: keep a fallback full check on main for versions no batch built").

## The swept batch

This project merges in batches of the person's own (`docs/forge.md`, "Batches of your own"), so a change merges only when it passed the alpha's whole check together with every change approved beside it, and the alpha needs no second run of it (INF-2430's plan, piece 3; INF-2952's plan, piece 3; INF-3759's plan, piece 3).
A change is a task's pushed branch with no pull request of its own, and each push of that branch runs the change's own check ("A pushed branch").
The captain's merge click on its merge card puts the approved version in line.
The app at the captain's home combines the line into one branch, `infinitary-batch/<id>`, one commit per change, and opens it as one pull request with the captain's sign-in ("A batch pull request").
Once every check of that pull request passed, the app merges it with the same sign-in: by squash when it holds one change and by a rebase merge when it holds several, so `main` gains one commit per change.
That merge is a push to `main` like any other, so it starts `main.yml`, and `prompt-budget.yml` and `republish-casks.yml` where their paths select it.
The line and its batch are the home's own record, so a batch waits while the app there is closed.
How the app forms, combines, holds and merges a batch is `docs/forge.md`'s.

What this project adds is the batch's checks, `.github/workflows/batch-checks.yml`, which `batch-pull-request.yml` calls on the batch pull request's version.
Its first job, `Merge batch · Regenerate the phone files`, runs the phone's generators on the batch's version (`scripts/batch-regenerate.ts`, the captain's pick in a daily velocity review: "Have each batch regenerate the phone's generated files itself, as its own commit, before its checks run"), since each change regenerated them from its own base and two changes together can leave one out of step.
It runs the app parts list's generator first, `scripts/generate-runbook-parts.ts`, since the phone's card bundle carries the app's parts (INF-6259's weekly audit, the captain's pick: "it would also rebuild the app parts list").
It then runs the published contract's generator, `scripts/generate-contract.ts`, so a batch no longer waits for a repair crewmate to regenerate `docs/contract.json` when two changes together left it stale (the captain's pick in the daily velocity review: "Have the batch's first job regenerate the published contract file too"); `pnpm check` and `src/shared/publishedContract.test.ts` still read the committed file against its source on the regenerated version.
The job keeps its name, and its commit keeps the trailer `Batch-regenerated: phone`, so a batch version made before still reads as one.
When they change nothing, every other job runs on that version.
When they change files, all of them marked `linguist-generated` in `.gitattributes`, it hands the difference to `Merge batch · Push the regenerated phone files`, which commits it on the batch's version as one commit carrying the trailer `Batch-regenerated: phone` and pushes it to the batch branch; every other job of that run skips.
That job runs no code of the project, on GitHub's hosted Ubuntu, and is the one job of the batch with a token that writes (`contents: write`, which `batch-pull-request.yml` grants its call).
A push with that token starts no run, so the app takes the commit as the batch's version and pushes it again under its own sign-in (`docs/forge.md`, "A generated commit"), and the run that push starts runs every check on it; the push job waits until the branch moves, up to 22 minutes, so the batch shows a running check meanwhile rather than a passed one.
A version that already carries the trailer is not regenerated again, so its checks read whether the generators agree with it, and a generator that changed a file not marked generated fails the first job, naming the file.
The release notes check counts that commit as no change of its own (`docs/release-notes.md`).
The sweep is `verify.yml` with every journey and without the phone check, the whole check an alpha reuses: an alpha from a merge it checked runs no lane itself (the captain on INF-2508: "Keep every journey in the batch, and let an alpha reuse them").
A sweep without every journey's complete set still lends its Linux checks and Mac lanes, and the alpha then runs every journey itself (INF-2480; `scripts/main-alpha-proof.mjs`).
Its eight Linux test groups use `LINUX_RUNNER`, the PC-only queue, then hosted Ubuntu when unset; they do not use `LINUX_QUEUES.checks`, whose mixed fleet includes guests without Chromium dependencies; its other Linux jobs stay hosted and its Mac lanes use the `release_split` queue ("Each Mac job's kind and size").
Beside it, the `critical-path` job runs the critical path on the same version on GitHub's hosted Linux ("The critical path"), so the batch's check runs it whatever part of the full check the sweep runs (the captain, on INF-2508: "the e2e journey + browser tests should all run during the sweep batch").
The `startup` job runs the Linux automatic startup fixtures, `linux-startup.yml`, on the same version on GitHub's hosted Ubuntu, so they run before a merge (the captain's pick on INF-3052, "In the batch check, beside the critical-path journey").
The `notes` job runs the release notes check, `node scripts/release-notes.ts batch`, and the phone contract flag on the same version on GitHub's hosted Ubuntu, measured from the main version the batch left: each change's commit must add its note or exclusion as the alpha counts it (`docs/release-notes.md`, "The release check"), so a held batch's fix, whose own check skipped both ("A pushed branch"), has its note read before it merges.
The `windows` job builds the Windows installer and checks it on a fresh Windows 11 virtual machine, `windows.yml`, when `scripts/windows-paths.ts` finds the batch touches Windows-relevant files (the captain's pick on the Windows plan; `docs/windows.md`, "The checks").
The last job, `Merge batch · Batch passed (tree T; base B)`, passes once the sweep, the critical path and the startup fixtures passed, or once every failed job's test files passed their confirm, and in either case the release notes check passed and the Windows check passed or skipped; it names the tree T of the batch's version and the main version B its branch left `main` at.
Its `Read the batch` job reads T and B with git from the commits alone, fetched without their trees or files, and never asks GitHub's compare answer, which builds the batch's whole diff first and can refuse it under heavy load, holding the batch on one reading (INF-4683).
The batch stops at its first code-check failure (the captain's pick on INF-3925), and once a confirm fails again on the test files it named (the captain's pick on INF-5113, "Start now: stop at a failed confirm").
Its `watch` job, `Merge batch · Watch for a stop`, reads the run every half minute until every other job ended (`scripts/batch-stop.mjs`), on the `light` Linux kind so the 40-minute wait bills no hosted minutes.
It stops the batch when the sweep's `Code checks and build (Linux)` job failed, or when a confirm job failed and its log shows a round that failed on the files it named: `scripts/batch-confirm.ts` prints `Confirm round N of 3:` with the files before each round and `Failed in round N of 3.` after a failed one.
A confirm that failed before any round ran, because its failed job's log named no test file, as when a test machine dropped out, never stops the batch, and neither does one whose log GitHub cannot give yet, which the watch reads again.
A failed test group alone never stops it either: a failed group is often a flake its confirm passes, and a stop before the confirm would leave the repair no evidence and hide another change's failure later in the run.
On a stop, its `stop` job enters the concurrency group of every other sweep job (`verify.yml`'s lanes and test groups and `source-journeys.yml`'s journey groups, each its own) and of both Windows jobs (`windows.yml`'s build and check) with cancel-in-progress, which cancels each one still queued or running.
Each stop job passes with a notice, and the `stopped` job after them fails with one error line naming what failed (the watch's `failed` output), so the batch's failed checks are the failed check and that one job rather than twenty stops ("A failed check says why"): `Merge batch · Batch stopped because the code checks failed` names the code checks' failed step, and `Merge batch · Batch stopped because a confirm failed again` names the confirm and its test files.
Failed code checks name no test file, so nothing is confirmed, and the batch holds; after a confirm that failed again, the other confirms still running end on their own, and the batch holds.
An alpha cut is the stop's second user (`docs/alpha.md`, "Failed alpha checks"): `release.yml`'s watch reads the cut with its own rule, any failed or timed-out job, and its stops enter the same groups and those of the release's own jobs.
The stop cancels single jobs, never a whole called check: the jobs it cancels still show as cancelled checks, and GitHub may end the run itself cancelled, as it ended a batch whose stops all failed, so the batch's verdict is its failed checks, never the run's ending.
The critical path, the startup fixtures and the release notes check end within a few minutes and run on, and the watch never fails a batch itself.
Each Linux test group's confirm starts in the sweep once the test groups ended, while the journeys and the Mac lanes run on (INF-4382), with no job waiting beside the checks: `verify.yml`'s `linux-tests-confirm`, which only the batch's call asks for, has one job for each of the eight test groups, named `Confirm failed` and the group's own name, such as `Merge batch · Confirm failed Unit tests (Linux; group 1/3)`.
Each one reads its own group's failed job's log for the test files it names as failed (`scripts/batch-failures.mjs`) and runs each of those files three rounds with no retries on the same version on hosted Linux (`.github/actions/batch-confirm`, `scripts/batch-confirm.ts`; the captain's pick on INF-3012, "A only: the confirm step"); a group that did not fail passes it, and a failed group whose log names no test file fails it.
It cancels nothing itself, and the watch stops the batch when it fails again (above); a Mac confirm waits in the Mac line behind the sweep's Mac lanes queued before it.
Once every check ended, the `failures` job reads every other failed job - the code checks, the journeys, the Mac lanes, the critical path and the startup fixtures, and a test group whose own confirm did not run - and the `confirm-later` job, `Confirm failed tests (Linux, later failures)` or `(Mac, later failures)`, runs their files the same way, on hosted Linux when a Linux job failed and on the `release_split` Mac when a Mac job did.
The last job passes only when every test group's confirm that ran passed and the later confirm passed or had nothing left to run.
A failed job whose log names no test file failed for something no rerun of a test answers, so nothing runs again, first or later.
When a confirm fails, it keeps everything under `test-results/` on the run for 7 days, as `confirm-failures-linux-<n>` from the test group's own confirm (its place among the eight, from 0) and `confirm-later-failures-mac` or `confirm-later-failures-linux` from the later one: each failed journey's error context, trace and screenshot, as `e2e-failures-<lane>` keeps the sweep's ("A red verify's evidence"), so a failure that shows only in the confirm can still be read.
A batch with a failed check holds, whatever its confirm said: the app reads every check the host reports, and the failed job stays failed on it (`docs/forge.md`, "A held batch").
The confirm is the repair's evidence ("A held batch's repair"): a green one says the failed files passed three rounds on the same version, and its run's summary names what failed, a flaky test that still needs an owner who fixes its root cause.
When the confirm passed and its last job passed, the repair declares that version passed with `check_change`'s `batch.passed`, and the batch merges as it is; a test-only fix for the flaky test goes to the next batch.
A red confirm says the failure repeats, and it fixes forward (INF-2948, the captain: "whenever we meet a failure, we pause the sweeps until a fix arrives, then we rerun the sweep with everything queued + the fix, if there's another error, repeat"): the changes approved meanwhile wait in line behind the held batch until its repair answers it.

`main.yml`'s `sort` job reads a push that merged a batch pull request from that pull request's own run (`scripts/batch.mjs`, `scripts/batch-pull.mjs`).
When a run N on the pull request's version named exactly the pushed files in its last job, and the batch changed no file under `.github/` that run reads, the push is covered: a job named `Main push · Covered by batch run N` replaces the full check and the startup fixtures.
That holds for a batch merged after it passed on its confirm too, since the batch's run and its confirm together passed every test (the captain's pick on INF-3052, "Nothing more: the batch's run and its recheck together passed every test").
A pull request's run reads its workflows and their actions from the pull request itself, so a batch that changes one chose its own check, and main runs its full check instead.
The files that run reads are `batch-pull-request.yml` and every file under `.github/` that a file it reads names outside a comment, in a `uses`, a sparse checkout or a command, read the same way in turn, a named folder with every file in it (`batchRunCheckFiles`).
They are read from the pushed version, which is the batch's whenever a run passed on its tree, and they include what a job of that run could reach even when it did not start.
A changed file only the Windows check drives, its workflow `windows.yml` and the actions that workflow names in a `uses` which no other file of the run reads (`windowsOnlyCheckFiles`), keeps the push covered too: the batch's run started the Windows check on its own version, since `scripts/windows-paths.ts` counts those files as its own, and chose nothing else of its checks.
A changed file under `.github/` that run never reads, such as `release.yml`, `main.yml` or `ci.yml`, chose nothing of the batch's check, so the push stays covered and the alpha reuses the batch's journeys.
A file list GitHub cut short counts as a changed check file.
Anything else gets the full check: a commit that merged no batch pull request, such as a pull request merged through its own review or a commit pushed by hand, and a batch merged after `main` moved under it, since the pushed files are then not the ones the batch checked.
The alpha's proof follows a covered run to the batch pull request's run: it requires a completed run of `batch-pull-request.yml`, started by a pull request from a batch branch of this repository, whose last job names the source's tree, and after passed confirms it counts each failed job of the checks as passed, since the confirms ran its failed files again (`scripts/main-alpha-proof.mjs`, `docs/alpha.md` "Cutting an alpha").
It still reads a run of the team queue this project merged through before, for an alpha whose source that queue merged.
The fleet never cancels a running batch or a running main check unless the captain asks; a batch's own stop at failed code checks or at a confirm that failed again is the batch's, not the fleet's.
`tests/batch.test.ts` holds the batch's checks and which pushes main's sort leaves to a batch; `tests/batch-pull.test.ts` holds how a batch pull request starts them, the confirm's plan, main's reading of the merged pull request and the alpha's proof.

## A held batch's repair

A batch whose check failed holds, and its repair follows the app's `batch-repair` skill (`docs/forge.md`, "A held batch"): a batch of one wakes its own crewmate, and a batch of several gets one repair task, which accounts for every failed test against every change and then sends changes back, fixes forward, merges a version a rerun passed, or runs the failed checks again for a flake that still gets an owner.
Once the cause is found it fixes forward by default, sending a change back only when that change's code under test must change, the fix needs a decision, or the fix is not small; a test that still expects behavior a change replaced on purpose is brought up to date in the fix, never weakened, skipped or deleted.
The batch's run holds what the repair reads: its failed jobs, the test files the test groups' confirms and the `failures` job read from their logs, and whether each confirm passed or failed on them.
A file the repair's computer cannot run, such as a journey where journeys run only through CI, is judged from its log and the changes' diffs, or run through `journeys.yml` with `files` on a branch the repair pushes at the batch's version.
The batch's version is its branch's, `infinitary-batch/<id>`, which any clone fetches: one commit per change on the `main` version its last job names.
A fix built on that version runs its branch's own check, which finds that version, skips every other step and passes in about a minute ("A pushed branch"), and the fix requests no journeys of its own: once it joins, the batch's rebuild runs every check and every journey on it with every change beside it, its release notes included ("The swept batch").

## A batch pull request

A batch is one pull request (INF-3759's plan, pieces 2 and 3): a branch of this repository whose name starts with `infinitary-batch/` holds the approved changes, one commit each, and its pull request against `main` runs the swept batch on its own version.
`batch-pull-request.yml` starts on every pull request, since a pull request has no filter on the name of its branch, and its one job, `Merge batch · Batch checks`, runs only when the branch starts with `infinitary-batch/`, comes from this repository itself and targets `main`.
A fork's branch of that name starts nothing, so code from a fork never reaches this project's own Mac; every other pull request shows the job skipped.
`ci.yml`'s job skips itself on exactly those pull requests, since each change of the batch ran it on its own pushed branch, and the push of a batch's branch starts no run ("A pushed branch").
So a batch's checks are `batch-pull-request.yml`'s run alone.
A newer version of the pull request cancels the run of the older one.

That job calls `batch-checks.yml` on the pull request's version, with nothing to combine, since the branch already holds its changes ("The swept batch").
Main's sort and the alpha's proof read that run by its last job ("The swept batch").
`tests/batch-pull.test.ts` holds the two workflow files and which pull requests and pushes start each check.

## CI job names

Every job's name says what started its run and what it checks, in one scheme (INF-2410, the captain: "i want to distinguish what triggered the job and what they check"; scheme "A. Trigger first"): `Trigger · Purpose (platform or device; group or round)`, such as `Main push · App journeys (Linux; serial group 3/4)` or `Pull request · Code, build, affected tests and critical path (Linux)`.
The trigger is one of `TRIGGERS` in `scripts/ci-job-names.mjs`: `Pull request`, `Pull request comment` (a reply on a pull request, which the contributor agreement check reads, `docs/public-ci.md` "Outside contributors"), `New issue` (an issue opened on the project, which the feedback labels read, `docs/feedback.md` "Triage"), `New comment` (a comment on an issue or pull request, which the triage mark reads, `docs/public-ci.md` "Intake"), `Daily` (a once-a-day run, such as the waiting-on-author timer), `Branch push` (a pushed branch's own check, "A pushed branch"), `Main push`, `Manual request` (a check started by hand, main's included, is never a main push), `Merge batch` (a batch pull request's checks), `Automatic alpha`, `Requested alpha` or `Requested stable` with ` rehearsal` for a dry run, and `Requested TestFlight` or `Requested TestFlight status`.
A called workflow takes its caller's trigger through its `trigger` input, so each level of GitHub's full name leads with it: `Main push · Desktop checks / Main push · Linux journeys / Main push · App journeys (Linux; serial group 3/4)`; a runner list that shows only the last level still says what started it.
A workflow only a caller starts (`alpha-wait.yml`, `batch-checks.yml`, `linux-startup.yml`, `mac-installer.yml`, `mac-update.yml`) requires that input and keeps no fallback of its own, and a release says its trigger once, in its `resolve` job's `trigger` output, which every later job's name and every workflow it calls read (INF-2539).
Workflow names and files, job ids, run titles, concurrency groups and artifact names keep their earlier names, so triggers, queues and the readers of `github.workflow` are unchanged.
A reader that judges a run by its jobs (the alpha's proof, stable promotion, the phone's order and cancellation, installer reuse and journey timing) compares `legacyJobName(name)`, which reads a job named before or after the scheme alike; a name that does not lead with a known trigger on every level stays as it is and never passes for a known job.
`tests/ci-job-names.test.ts` evaluates every job's name in every workflow for each trigger that can start it and holds each to the scheme.
`tests/workflow-hygiene.test.ts` holds every workflow to a top-level `permissions` block and every shell step, composite actions included, to reading values through its environment rather than an expression pasted into the script.
It also holds every caller of one of the project's workflows to granting at least the permissions each called job asks for, since GitHub starts no job of a run whose called job asks for more, even one its condition would skip (INF-2548).

## A release's hosted machines

Main's desktop release check and a release's Linux jobs run on GitHub's hosted Ubuntu, except publishing release packages when `RELEASE_LINUX_PACKAGES_RUNNER` names their queue.
That queue takes the next free PC place ahead of pull request checks; an unavailable PC holds those package jobs.
It is not faster: GitHub's hosted two-processor machine ran the whole Linux test suite in over an hour, where the PC's two-processor machine took 29 to 34 minutes, so `verify.yml` splits the tests across hosted machines ("Main's desktop release check").
The cost is GitHub's per-minute bill for those jobs.

`release.yml`'s own Linux jobs, `resolve`, `notes`, `phone` and `upload`, name `ubuntu-24.04`, publishing or dry run.
`release.yml` and `main.yml` pass `hosted: true` to the workflows they call:

- `verify.yml`, whose `request` job, `linux-checks` lane, every Linux test group and every `linux-e2e` journey job (`source-journeys.yml`, through the same input) take it;
- `linux-packages.yml`, whose build and checks use hosted Ubuntu unless a publishing release passes `RELEASE_LINUX_PACKAGES_RUNNER`; the Ubuntu 26.04 host check appends `-2604` to that label.
  Rehearsals and an unset variable stay hosted.

`linux-startup.yml`'s job and `alpha-wait.yml`'s jobs name `ubuntu-24.04`, since `main.yml` and, for the startup fixtures, `batch-checks.yml` and `contributors.yml` are their only callers; the alpha wait bills no minutes while its `wait` job is pending in an alpha's group ("Main's desktop release check").
`batch-checks.yml` passes `hosted: true` to its sweep and its critical path, and opts only the sweep's eight Linux test groups into `LINUX_RUNNER` with `fleet_tests: true`; its startup fixtures name hosted Ubuntu themselves, and its own jobs but the Mac side of its confirm, and `main.yml`'s `sort` and `covered` jobs, name `ubuntu-24.04` ("The swept batch").

`ios-release.yml`'s four Linux jobs, `resolve`, `preflight`, `availability` and `external`, name `ubuntu-24.04` for every dispatch, since each one checks or releases a phone build.
A requested check and this project's own pull request keep `LINUX_RUNNER`: `hosted` is an input only a call takes, never a request's.
An outside contributor's pull request runs on GitHub's machines whatever the variables say: `ci.yml`'s branch check and the docs site's check name `ubuntu-24.04` first for it, and `contributors.yml` calls `verify.yml` with `hosted: true` and `mac_runner: macos-15`, `linux-startup.yml`, and `journeys.yml` and `windows.yml` with `hosted: true` (`docs/public-ci.md`, "Outside contributors").
`tests/release-workflows-runners.test.ts` holds where each job starts with `LINUX_RUNNER` set and unset, publishing and in a dry run.

## Native phone checks

A pull request no longer starts `phone.yml` (INF-2139, captain: "let's pull journeys and phone checks off PRs now"): a crewmate whose change selects the gate requests it on its branch ("The phone check on request").
INF-2539 removed its pull request selection; an affected request chooses parts, and the phone release runs every part ("Main's desktop release check").
An affected request selects the device gates for `ios/`, the phone-card generator, the phone-contract generator with its shape guard, and the gate's own setup (`scripts/affected-phone.ts`).
A change to the generated phone contract that touches only its `public static let version` line, a first-number change included, does not select it; `pnpm check` still verifies the file is current on every pull request.
The setup inputs are `phone.yml`, the launcher `scripts/test-phone.ts` and every module it loads short of the app's own code and the test home `tests/helpers/phoneHome.ts`: among them `tests/helpers/phoneKeyboard.ts`, the Photos wait `tests/helpers/phonePhotos.ts`, the failure timers and load clock `tests/helpers/budgets.ts`, the scratch folders `tests/helpers/scratchDirs.ts`, the activity writer `scripts/phone-activity.ts`, the leftover sweep `scripts/phone-leftovers.ts`, the check runner `scripts/phone-checks.ts`, the command deadlines `scripts/phone-deadlines.ts`, the shared build `scripts/phone-build.ts`, the simulator selector `scripts/phone-simulator.ts`, the Duo's hinge helper `scripts/phone-hinge.ts` and the test plan helper `scripts/phone-test-plan.ts`.
The test home is an input itself, and so are the helpers chosen for it one by one, such as the Google stand-in `tests/helpers/phoneGoogle.ts` and the journey stand-in `tests/e2e/mockProvider.ts`.
`tests/phone-ci.test.ts` walks the launcher's imports, stopping at the app's code under `src/` and at the test home, and fails when a module it reaches is not an input (INF-1242).
What the launcher reads is an input too: the simulator pin `scripts/phone-pin.json`, the part times `scripts/phone-part-times.json`, each part's recorded work `scripts/phone-work.json`, the hinge helper's source `scripts/phone-hinge.m` and the library photo a part chooses.
The runner's diagnostic inputs also select it: `scripts/phone-guest-observer.ts` and `tests/helpers/phoneWebStacks.ts`, `phoneGuestLaunches.ts`, `phoneLauncherLog.ts`, `phoneLookupWait.ts` and `phoneProxyLaunches.ts`.
Setup the device gates never run does not select it: the chooser itself, the local test home `scripts/phone-test-home.ts`, and the virtual Mac scripts `scripts/virtual-mac/phone.sh`, `phone-job.sh` and `vm.sh`.
Changes to general shared modules, connection/device code, packages or the lockfile alone do not select the native gate.
The chooser runs in the Linux `request` job before a phone Mac is reserved; it reads the comparison of the request's branch with its base, and an unreadable comparison selects the gate rather than silently skipping it.
That job publishes the selection, keeps `phone-placement` and deals the selection's passes into jobs, creating only jobs with passes to run.
When the chooser selects no gate, as for a change only to the generated contract's version line, the job ends before it installs anything.
A manual request that chooses its parts runs one `native-phone` job for each job the chooser dealt, each on its own phone Mac at once (INF-5387's plan, piece 2, after the captain's "how can we make them last <30m at max").
The chooser builds the passes the request's devices run (`requestPasses` in `scripts/affected-phone.ts`), each a device, a part, a round and any named tests, and deals them into jobs of at most 20 recorded minutes (`dealPhonePasses` in `scripts/phone-test-plan.ts`, `PHONE_JOB_BUDGET_MS` in `scripts/phone-deadlines.ts`).
A job's minutes are its passes' recorded minutes and 3 for each device past its first (`PHONE_DEVICE_START_MS`, `phoneJobMs`), since a phone Mac with one simulator starts each device after the last one's parts end and waits for its wallpaper prewarm before its first part (INF-5546, INF-6058).
A pass longer than 14 minutes by itself runs in a job of its own, and no other job passes 14.
The job count is those passes and the other passes' recorded minutes over 20, rounded up, and one more while a job of more than one pass would be past 20.
Passes go longest first to the job they leave lightest, a pass of a part with no recorded time counting as the median part, and a pass joins a job already holding its device, whose simulators it then reuses, when that leaves no job longer than the lightest choice would.
A job may hold several devices, and its name gives its number and devices, such as `job 2 of 5: iPad, iPhone`.
`tests/phone-chooser.test.ts` holds, over generated selections, that the dealt jobs together hold exactly the passes a job of each of the request's devices would run, none lost and none doubled.
The phone release's call, and a wait-clock or tool request, keep one job of the device they name, or of every device, matrix device `every`, whose gate runs every device's lanes from one build (INF-4241 piece 8).
Each runs the disposable `scripts/test-phone.ts` gate for its devices only on the required `MAC_QUEUES.phone` queue ("Each Mac job's kind and size"), without an override or fallback.
When the job fails, or a run on request records, it keeps native result bundles, logs, published-client results and connection readings in the `phone-results` artifact.
The same command logs also live in the smaller `phone-logs` artifact, independently of the result bundles.
Each part's live simulator log lives in `phone-simulator-logs`, never in `phone-logs`, which keeps `phone-logs` within the app's 64 MiB artifact download.
The pictures the journeys took live in the small `phone-pictures` artifact, exported from the result bundles by device and part.
A failure on any device fails its job and the run, and a complete branch selection or a request with edited-part passes stops at the first failed part ("The phone check on request").
That gate checks and builds once, starts as many simulators of its device as the phone Mac holds, and runs the phone journey's parts on them, each part with its own test home and a clean app (`docs/ios.md`, "Disposable verification").
A dealt request's jobs share one build (INF-6039's plan, part 1): its first job builds the app for testing in a step of its own (`node scripts/phone-build.ts`) and uploads it as `phone-build-<attempt>`, named for the run attempt, before its gate starts.
Each other job downloads that artifact if it is there when the job starts, and its gate uses it in place of its own build only when its record names this job's own commit, a checkout with no changes, the same Xcode, simulator SDK and chip, and its archive's SHA-256 matches (`phoneBuildRefusal`, `useSharedPhoneBuild`).
Otherwise the gate says why in a notice and builds the app itself, as every job did before, so a job that starts before the first job shared its build, or finds it broken, still runs.
The archive holds the first job's built products folder whole, its test plan included; a failed upload or download fails nothing, and the phone release's call and wait-clock or tool requests build in their gate as before.
A check dealt into one job shares nothing and its job builds in its gate as before.
When every job starts at once, the first job starts its parts later than it would building in its gate, by its upload's minutes and about a minute more, since its simulators no longer start during the build.
Each placed guest runs simulators of only the devices its job holds.

### The phone parts a request runs

An affected request runs every part the change reaches, by the chooser's distances below; a default request and the phone release run every part.
The chooser (`scripts/affected-phone.ts`) gives each part a distance: 0 when the change edits UI test code the part runs, 1 when it edits a file in the part's owner table (`PART_OWNERS`), and 2 for any other phone input.
`scripts/phone-part-owners.ts` explicitly assigns production files to their consuming parts, including shared files with multiple owners.
`pnpm check` refuses a new production phone file with no owner; UI and app-hosted test files use their declaration consumers below.
Every part owns the generated contract and card words (`PhoneContract.generated.swift`, `PhoneCardWords.generated.swift`), but a change to either reaches only the owners of the Swift files that read a changed entry (`generatedReach`, INF-3379): a changed static member is read by a file naming both its type and its name, and a changed case, nested type or type by a file naming the type or one of its cases.
A member of the generated file that reads a changed member changes with it, the UI tests never read either file, and a change to the header comment alone reaches nothing.
An unreadable diff, a shape the reader does not know, a line outside every generated type or a reader nobody owns keeps every part.
Every part also owns the phone's generated messages and their string files (`PhoneMessages.generated.swift`, `Resources/*.lproj/Localizable.strings` and `.stringsdict`), and the card parts own the card host (`CardHost.generated.js`) and the panels part the panel host (`PanelHost.generated.js`), which both bundle the whole catalog; a change to these reaches only the parts whose code calls a changed message (`wordsReach`, INF-6223): the owners of each Swift file naming it through `PhoneMessages`, and a host's owners when the host's own code names it outside its function and the catalog's tables.
A message the phone words only from a saved fact, by its name at run time, reaches no part on a request; the phone release runs every part.
A changed line that names no message, such as a host's own code, an unreadable diff or a reader nobody owns keeps every owner.
It reads a UI test change by its declarations: each changed line counts for the functions, computed properties, supported top-level structs and enums, or literal constants around it, added lines in the new version and removed ones in the old.
Each part reaches its test and follows identifier references through bodies and signatures, including function values, helper types and constants; a helper type owns its methods.
The reader keeps string contents for references, including interpolation, so a matching word in a literal can conservatively select extra consumers.
A setup, teardown or XCTest observation callback reaches every part, as does a changed declaration referenced by code outside the supported declarations.
The rest part also starts from every test no other part names, and a change to the app-hosted tests puts it at 0.
A part that names an app-hosted class as its `suite` (`weak-link`, INF-2989, whose class is the phone package's own test target on the Mac since INF-4326) runs no UI test code: a change to that class's own file puts that part at 0 instead of the rest part, and a change to an app-hosted file that is not a test class, such as a shared helper, puts both at 0.
A blank or comment-only line counts for nothing.
An edited line outside every supported declaration counts for the declarations it can change (INF-3379): an import for its own file's, a plain extension's opening or closing line for what that extension declares, a type's header for its members, its extensions and every declaration naming it, and any other line, such as a stored property, for its enclosing block's declarations and every declaration naming one of its words.
Each of those declarations then counts as an edited one, so a new part file's imports and extension lines repeat only that part, and a shared helper's get ordinary coverage.
Overloads of one function name share every caller of that name, so an edited overload counts for its callers, not every part.
A line none of this places, such as an empty extension, keeps every part once; a declaration name shared by anything but functions, conditional compilation or a test file it cannot read or parse keeps every part with its repeats.
Unsupported declarations, including aliases, attributed types and executable global initializers, keep full coverage rather than using a file exemption.
An affected request keeps every part at 0 or 1, and every part when an unowned production file or an unreadable comparison leaves its reach unknown; a part at 2 is checked by the next phone release.
A change confined to scripts, helpers or the workflow runs the short `join-read` part as a smoke check.
The six-minute placement of a pull request's gate, `placeParts` in the chooser with the `--times` reading of a full gate's `part-times.json`, has no workflow caller since INF-2539; `tests/phone-chooser.test.ts` still holds it.
The job summary names each kept part with its distance and reason, and the `phone-placement` artifact keeps the same as JSON.
`tests/phone-chooser.test.ts` replays real changes merged to `main` through the chooser.
Unlike the desktop journey workflow, a device gate that already started finishes and deletes the simulator it started for each device.
Each native phone job uses a group unique to its run and attempt, with `queue: max` and `cancel-in-progress: false`; the run's own group, which lets a newer same-selection request on a task branch cancel it, is in "What a task branch requests".
The phone queue is served from every Mac place the placement service runs, the two rented vBoxx places and the compute Macs alike, and each of those places also takes other kinds of Mac work, the merge batch's Mac lanes included, so a phone check waits for any free place and holds one that a batch lane could take (`docs/ios.md`, "A phone check the placement service puts in a virtual Mac").
Desktop journey jobs from different pull requests remain parallel.
Desktop journeys and native phone gates run directly, without a command lease, so real and virtual Macs can check concurrently.
The phone workflow keeps its configured concurrency groups; they do not exclude desktop checks or a local phone command.
A dealt job is stopped at 34 minutes and its gate step at 30, so a gate past its limit fails the job, whose results, cleanup and evidence upload still run.
The first job of a check dealt into several jobs is stopped at 46 minutes instead, its build step's 12 more, since it builds and uploads the app before its gate.
The recorded part times come from a full gate that ran two simulators at once.
A phone Mac with one simulator runs a job's parts one after another at up to 1.08 of their recorded minutes, and its gate step also builds the app for up to 3.1 minutes and starts the first part about a minute late.
It also starts no part until the simulator's wallpaper prewarm has finished, which on the phone Macs came up to 2.0 minutes after the build ended (`docs/ios.md`, "Disposable verification").
So a gate of 20 recorded minutes ends near 27.7 minutes there, inside its 30, and sooner on a phone Mac with two simulators.
The phone release's call keeps its job's 345 minutes, 165 for setup, the ordinary pass, cleanup and evidence upload and 90 for each of two further passes it never runs, and its gate step's 90; there is no command-admission wait.
`pnpm test:phone` checks the configured execution mode, then runs `scripts/test-phone.ts` directly.
`tests/mac-check-lock.test.ts` executes the workflow and package command strings with held workloads to verify overlap, failure status and cancellation.
`tests/phone-ci.test.ts` evaluates the required queue, rejects missing configuration and proves former overrides cannot change routing or suppress guest setup.
The device gate runs as many simulators of its one device as the phone Mac's processors and memory hold, two on today's compute Mac VMs, where an iPhone Duo takes both (`docs/ios.md`, "Disposable verification"), and shares the device's parts among them by their recorded times (INF-4241 piece 3; `docs/ios.md`, "Disposable verification").
This applies to requested checks and unsigned TestFlight checks, with the same tests, failure propagation and allowances; a request's dealt jobs each take their own phone Mac, and the TestFlight call runs every device in its one job.
The fixture, simulator identity and unsigned Xcode configuration are described in `docs/ios.md`, "Disposable verification".

### The phone check on request

`phone.yml` also runs on request (`workflow_dispatch`): a crewmate checking its own branch sends `POST /repos/{owner}/{repo}/actions/workflows/phone.yml/dispatches` with `{"ref":"<branch>","inputs":{"affected":"true"},"return_run_details":true}` to select touched parts conservatively, once at its final version ("What a task branch requests").
A default run on request runs every part of the device gate whatever changed, as the phone release's call does; on a branch it needs `task` and `reason` inputs, and the `request` job refuses it without them.
Branch requests also read the chooser for repeat accounting; the phone release's call never repeats.
A release check of every part on `main` sends `{"ref":"main","return_run_details":true}`.
The optional `base` input defaults to `origin/main`.
The check's copy of the project holds branches only as their `origin/` copies, so a base named by its branch, such as `main`, is read from `origin/main`; a base that names no commit or branch there is refused in the `request` job with the reason, before a phone Mac is taken, since comparing with it would count every part on every device (INF-6223, `readableBase`).
The chooser reads the change from the branch's merge point with `origin/main` when the given base is older than it, since an older base would count main's own changes since then as the branch's edits (INF-3379, `requestBase`); a base at or past the merge point, such as a stacked branch's, stands, and the summary and `phone-placement` artifact name the base read and any ignored one.
The optional `last_pass` input names, by its full commit id, the version whose affected request last passed on the branch; it narrows an affected request alone, and the `request` job refuses it with named `parts`, without `affected` or as a short id (INF-4071, the captain's "Only the change's own edits").
The chooser then counts only the files whose edit differs between the change at that version, read from its own merge point with main, and the change now, read from the current one (`ownEdits`), so main's newer changes that bringing the branch up to date brought in count for nothing, and a file the change no longer edits counts.
Each file's edit is its removed and added lines without their positions, so main's lines moving around an unchanged edit do not count it.
The `request` job fetches that version by its id when bringing the branch up to date left it on no branch; a version it cannot read leaves the whole change compared, as before, and the summary and `phone-placement` (`since`, `ownEdits`) name the version and the files counted.
This selection reuses `PART_OWNERS` and the Swift declaration reach reader, without a timing budget.
Shared production inputs select every declared consumer; unreadable comparisons or test changes retain conservative full coverage.
An affected request with no reached parts deals no job, and one that edits none of the phone app's screens and whose every kept part runs on the iPhone alone, or is not a part about the iPad or the Duo, deals none of that device's passes (the chooser's `ipad_parts` and `duo_parts`); the Linux job's summary and `phone-placement` artifact record the selection, and the summary each dealt job's passes, before any job on a phone Mac starts.
Explicit `parts` still overrides automatic selection for diagnostic runs.
The optional `device` input, `ipad`, `duo` or `iphone`, deals that device's passes alone; empty, its default, deals every device's (INF-3205).
Those passes are the ones that device runs beside the other devices', so a replacement proof of one device sends the original request's inputs with `device`, at the branch's current version, which a rerun of the original run cannot reach since it keeps the original version.
An iPad request whose change edits no screen and whose every kept part runs on the iPhone alone checks nothing, as a both-device request deals the iPad nothing; so does one that names only parts the iPad does not run.
To reproduce a known failure, send its one named `parts` value and `device` (`iphone`, `ipad` or `duo`); named diagnostic parts do not add repeat rounds.
A retry after a failed request names only the failing part and its device this way, never the whole affected selection again, and the whole affected selection runs once more only at the final version ("A retry after a failed phone request").
The iPad and the Duo run only the parts whose row in `PHONE_PARTS` names each, on every route (`docs/ios.md`, "Which parts run on which device"); the screenless weak-link suite is not one of them, and its own edited test code still gets its three iPhone rounds.
The `request` job refuses any other device, on every route, before a phone Mac is taken, and names the device in the request summary.
The chooser compares ordinary coverage with the complete live part table, independent of order, and keeps `coverage`, `iphoneOnly`, `screens` and `repeats` in `phone-placement`.
INF-2582 direction A (the captain's choice "A: wait once and trim the soak"), with INF-4241's middle rule (the captain's "today's rule, plus the short Duo and iPad passes when the change edits the phone app's screens") in place of its "iPhone only; iPad waits for the release check", shapes the gate of an affected request in four ways.
A part the change only reaches runs on the iPhone (the chooser's `iphone_parts`); a part whose test code changed, or every part of a change the chooser could not read, runs on each device its row names.
A change that edits the phone app's screens, a hand-written Swift file under `ios/Infinitary/InfinitaryApp/` (`appScreenEdits` in `scripts/affected-phone.ts`), also runs the iPad's and the Duo's short passes: every part whose row names that device, once, whether the change reaches it or not; a regenerated file (`.generated.swift`, or any file not in Swift) and translated words do not count, and named `parts` never add them.
Otherwise a part about the iPad or the Duo that the change only reaches waits for the next phone release on those devices.
Its selection runs once, then only parts whose test's own code changed run twice more on the iPhone alone (the iPad runs each once, INF-2732), each further pass dealt into the request's jobs like any other (`phonePasses` in `scripts/phone-test-plan.ts`).
This holds for a proper subset as for a complete selection (INF-2811), so a branch that edits one part's test code gets all three of that part's iPhone runs from its one affected request.
Named `parts` and every-part requests run their parts on every device their rows name.
Shared helpers and setup reach their consumers without repeating them; changed test bodies, signatures and helpers used by only one part retain three rounds.
For a part containing a suite, the chooser carries exact changed-test identifiers into the two further rounds, so the other tests run only in ordinary coverage.
A test's identity is the XCTest class around it, a class or an extension of one, so a file of two test classes still names each test exactly.
An unreadable test identity conservatively repeats its containing part; each exact selection must witness every selected test starting.
A changed test of the phone check's own tools, which the rest part otherwise skips, runs by name in every pass of the rest part, round one included, and a named-parts request runs none (`docs/ios.md`, beside the `tools` input).
Unreadable test changes retain all-parts repeats; a product-only shared input does not invent edited tests.
Within a job the iPhone runs a later pass only after its own ordinary pass, each pass of a part starts from a fresh test home and app, and in a complete selection or a request with edited-part passes the first failure stops every later part and pass, with no retries, and the first failed job cancels the request's other jobs (`fail-fast`).
A later pass writes its part's folder beside the ordinary one, named `<part>-round-<n>`, so its logs, pictures and failure results ride the ordinary artifacts.
An unavailable CI route leaves missing proof, never an automatic complete local fallback.
Neither route starts a release, TestFlight or App Store step.
Complete branch selections and requests with edited-part passes stop at the first failed part; other proper-subset requests and main keep full discovery.
Inside the gate a failed Swift package test no longer skips the simulator tests (`scripts/phone-checks.ts`); every failure is reported and fails the job.
Every request uses `MAC_QUEUES.phone`, currently `mini-mac-phone`; no `mac_runner` input, `PHONE_VIRTUAL_MAC` switch or generic-Mac variable can redirect it.
Do not use local mini borrows for phone proof.
The same-source unsigned call from `ios-release.yml` passes its resolved `source_commit` and no device, so one job runs every device's parts without repeats from one build on one phone Mac (INF-4241 piece 8, the plan's "a phone release runs the full check"); it must succeed before host signing starts.
Each job names its key, a dealt job's number (`job-1`, `job-2` and so on) or a call's device, or every device, in each artifact (`phone-logs-job-2`, `phone-results-every` and so on), and keeps each device's evidence under its device's folder; a gate that ran every part of a device writes that device's `part-times.json` there, and the job of every device one `part-times.json` with every device's times, so a dealt job, which runs only some parts, usually writes none and the phone release keeps the times current.
Only a request's first job runs the phone's Swift package tests, once for the request, and it holds the Mac part when one is dealt, since that part reuses their build.
Two phone guests on the one rented computer reported memory pressure warnings in 5 of 29 readings while both ran (INF-2409).
Status-only TestFlight requests start no phone or signing job.

## What a pull request runs

A change's version runs one check, `ci.yml`'s branch check (INF-2915's plan, the captain's direction B with the light profile): each push of a task's branch starts it, and so does a pull request ("A pushed branch").
The check is three jobs that start together and run side by side, each from its own install, so the longest of them sets the check's time instead of their sum (INF-5577's review, the captain's pick "Split the branch check into three jobs that run side by side"): `code-checks` runs the release notes check, the size headroom ("The size check's warning line"), the phone contract flag, the typecheck and `pnpm check`; `reached-tests` runs the tests a change reaches and the browser tests; `build` runs the build and the critical path.
A change whose tests hold more measured time than one part runs a fourth job, `reached-tests-parts`, a machine per part past the first, once `code-checks` has counted them ("Notes"); it skips for most changes, whose tests take one part (INF-5493).
All four run on GitHub's hosted `ubuntu-24.04`, since `LINUX_QUEUES` names no `typecheck` queue ("Each Linux job's kind", INF-6330's plan); an outside contributor's pull request takes hosted Ubuntu whatever the variables say (`docs/public-ci.md`, "Outside contributors").
Its steps keep what caught problems on pull requests and leave the rest to the swept batch, which runs everything on each approved change before it reaches `main` ("The swept batch").
Every version runs the release notes check, the size headroom, the phone contract flag, the typecheck, `pnpm check`, each edited unit or integration test file and the unedited ones that read a changed file, once ("Notes"), except a pushed branch built on a batch's version, which leaves all of it to the batch's own run ("A pushed branch").
The phone contract flag, `scripts/phone-contract-flag.ts`, compares the contract's major and view floor in `src/shared/ipc.ts` with the change's base, and when either moved it names, as a warning that never fails the check, the phone build the next alpha waits for (`docs/alpha.md`, "The phone goes first"); `pnpm check:changed` prints the same before each push, and the change's story carries that build as an after-merge step (INF-4500).
Its paths step, `scripts/pr-paths.ts`, reads the change against the merge commit's base parent and decides two things.
The build and the critical path run unless every changed path is a test (under `tests/`, or a `.test` or `.spec` file), docs (`docs/`, `primitives/` or any Markdown file), a release note, the phone app (`ios/`, except the shared font notice) or the docs site (`docs-site/`, which `docs-site.yml` builds and checks instead; `docs/docs-site.md`).
Every browser test runs only when a path is under `src/renderer/` or `tests/browser/`, or is a browser test helper (`tests/helpers/browser*`); otherwise the reader step runs the browser tests that import or read a changed file, such as those reading `src/shared/cards.ts` ("Notes").
An empty change or an unreadable diff runs everything.
No pull request runs the Linux startup fixtures, the node-headers proof or the adherence lint: none caught a problem on a pull request, the swept batch or main's full check runs all three, and `pnpm check:changed` runs the adherence lint before each push.
`tests/pr-paths.test.ts` holds the two decisions to real changes on main, and `tests/release-workflows-pr-checks.test.ts` holds the jobs' steps to them.

### A pushed branch

The same jobs run for a pushed branch as for its pull request, named `Branch push · Code checks (Linux)`, `Branch push · Tests a change reaches (Linux)` and `Branch push · Build and critical path (Linux)` (INF-3759's plan, piece 2), with `Branch push · Tests a change reaches (Linux; part 2/3)` and so on for a wide change's later parts.
A pull request's change starts at the base parent of its merge commit; a pushed branch has no merge commit, so its change starts at the commit the branch left `main` at.
Each job's `Find the change's base` step, one shared action (`.github/actions/change-base`), finds that commit, and the release notes check, the paths step, the reader of changed files and the critical path all measure the change from it, so commits `main` gained since are never read as the branch's own.
A branch built on a batch's version, as a held batch's repair is ("A held batch's repair"), starts instead at the newest version of a batch branch, `infinitary-batch/<id>`, that the branch holds and that holds the commit it left `main` at (INF-5379's plan, piece 2).
The step then names that version as its `batch` output and in a notice, `Checked in the batch`, and every later step skips, so the check passes in about a minute.
Each check it skips runs in the batch's own run once the branch joins, with every change beside it ("The swept batch"): the typecheck, `pnpm check` and the build in the sweep's `Code checks and build (Linux)` job, the tests that read a changed file and the browser tests in its Linux test groups, the critical path in the `critical-path` job, and the release notes check and the phone contract flag in the `notes` job.
The skip trusts nothing but the commits: a branch no batch version is under, including one whose batch version is no longer a batch branch's newest, starts where it left `main` and runs every step.
A pushed branch fetches every commit and every branch to find it, where a pull request fetches two commits and so always starts at its merge commit's base parent.
Each push of a task's branch starts `ci.yml`: one named `inf/...`, as the built-in naming runbook names a task's branch, or `fm/task-*`, as every task branch was named before (`docs/architecture.md`, "A task's branch").
So a task's change is checked with no pull request of its own, which is how a change reaches a batch (INF-3759's plan, piece 3; "The swept batch").
A branch under another name is checked by its pull request, or by a request by hand.
A task branch that still has a pull request runs the job for each, the push and the pull request.
A push of `main` or of a batch's own branch, `infinitary-batch/<id>`, starts nothing here, and the job skips itself on a batch pull request, whose changes each ran it already ("A batch pull request").
`tests/batch-pull.test.ts` holds which pushes and pull requests run it.

### An outside contributor's pull request

A pull request from another person's copy of the project runs on GitHub's own machines only, never on the project's (the captain's choice on INF-5002; `docs/public-ci.md`, "Outside contributors").
It runs the same branch check on hosted `ubuntu-24.04`, and the docs site's check when it touches the site.
An outside change merges as its own pull request and joins no batch (`docs/forge.md`, "Batches of your own"), so `contributors.yml` runs on it the tests the swept batch runs ("The swept batch"), on GitHub's machines (the captain's route on INF-3559).
Its `sweep` job calls `verify.yml` with the batch's selection and `hosted: true`: the code checks, every Linux test group and every Linux journey on hosted Ubuntu, and the three Mac lanes with every journey on hosted `macos-15`, which `mac_runner` names ahead of `MAC_QUEUES` and `MAC_RUNNER`.
Its `startup` job runs the Linux startup fixtures, and the branch check runs the critical path and the release notes check.
Its `paths` job reads the merge commit against its base parent: the journey files it edits, and `scripts/windows-paths.ts`.
A contributor cannot request a run, so its `journeys` job requests for them what a task branch requests for its own edited journeys ("What a task branch requests"): `journeys.yml` with `hosted: true`, the edited files and the base parent, which runs each three rounds and then by itself on hosted Ubuntu, and once on hosted `macos-15` (`mac_once`).
When the change reaches the Windows installer, `windows.yml` with `hosted: true` builds it on hosted `windows-2025` and skips the fresh Windows 11 check.
Unlike the batch, it confirms no failed test files again: the owner reads a failed run.
GitHub's Macs are smaller than the project's, so the Mac lanes run slower there.
The fresh Windows 11 check needs the project's own Windows PC, so for an outside change it waits for the next alpha's release check; the phone check, the signed installer checks, signing and TestFlight run only from `main`.
The run shares GitHub's limit on jobs at once with the batch's hosted Linux jobs, so a busy outside run can make a batch wait.
This project's own pull requests start `contributors.yml` and skip every job.
`tests/release-workflows-pr-checks.test.ts` holds which jobs an outside pull request starts, that each one it reaches through every call names a hosted machine with every routing variable set, and that its sweep keeps the batch's selection.

### The weekly audit of the pull request check

An Automation rule (`docs/automation.md`) asks the first mate every week to start a task in the Infinitary project that repeats INF-2915's audit, at the captain's request, and since INF-4500 audits the failures that got past the pull request check too.
The first mate saves the rule as a draft, and the captain turns it on in Settings → Automation:

- Name: Weekly pull request check audit.
- Schedule: every Monday at 5:00 AM, America/Los_Angeles.
- Project: Infinitary.
- Prompt: "Start a task in Infinitary that runs the weekly audit of the pull request check in docs/testing.md ("The weekly audit of the pull request check") for the week up to {{scheduled time}}.
  It answers on a card and changes no code."

The audit is an answer: its crewmate ships nothing, and its card is the deliverable.
It runs five steps.

1. **The runs.**
   It lists `ci.yml`'s pull request and branch push runs of the week and their jobs and steps, from where the last audit task ended or seven days back, and the swept batch's, main's and the alpha cut's runs of the same week.
2. **The catches.**
   For each failed step it reads the failure and counts a catch when a later version of the same change passed it or failed it the same way; anything else is the runner's own failure, counted apart.
   It counts, per step, its runs, its catches and its median and slow-tail minutes, and the wall time from a push to its last finished check.
3. **The escapes.**
   It names each failure the swept batch or main found that a pull request step skipped by its paths would have caught, from the failed tests' paths and the change they came in.
4. **The late failures.**
   It reads the log of every failed run of the swept batch, main's check and the alpha cut, and gives each one cause: a change's own fault, a flake with its owner, the runner or the host, or something else.
   For each change's own fault it names the earliest pull request check that could have seen it and the smallest addition there, with what that addition costs per change, and it names the savings other tasks already own rather than proposing them again.
5. **The answer.**
   Its card compares the counts with the last audit's report, names each step that caught nothing in the week, each escape and each late failure by its earliest catch, and offers any trim, any step to restore and any addition as a choice for the captain.

The week's runs outgrow the 200 reads a task may make where the project lives, so the audit lists runs by date in pages of 20 or fewer, and reads each failed log through the run reader, which counts no reads against that limit.

## The critical path

Every pull request runs one journey, the critical path (INF-2480's plan, the captain: "path six-steps (launch, sign in, project, first mate, crewmate card, merge)"; INF-2507): `tests/e2e/critical-path.spec.ts`.
It walks a fresh install from the gate to a merged change in the real app, one test with a named section per step.
Those sections are the gate at launch, a key signed in through the gate's own chip, a project started in Settings, a message that starts a crewmate, the crewmate's card, and the merge click that puts its commit on the project's main.
`ci.yml`'s `build` job runs it as its last step (INF-2915's plan, the captain's direction B), on the app that job just built from the pull request's merge commit, on the Linux desktop `.github/actions/linux-desktop` prepares, as `source-journeys.yml` prepares its own ("The Linux source desktop").
A version that skips the build skips it too ("What a pull request runs").
A pull request that edits the journey runs it three rounds and then alone, as any edited journey (`scripts/journey-runs.ts`); any other pull request runs it once.
The `build` job then runs `tests/e2e/phase0-guardrails.spec.ts`, the journey that pins the window's exact method list, as its own step on the same build (INF-6748's velocity review, the captain's pick), since a change that adds a method fails it in the swept batch and no branch check ran it before; it adds about 15 seconds.
A failed run keeps the window and either journey's results as the `source-desktop-critical-path` artifact.
The swept batch runs it again on the batch's version, in `batch-checks.yml`'s own `critical-path` job, and passes only when it passed ("The swept batch").
Every other journey runs on request ("Journeys on request") and in main's desktop release check, never on a pull request of its own accord.
A step that breaks fails the pull request, and is repaired at its owner; weakening or deleting the journey is ask-first ("This project's rulings on tests").

## What a task branch requests

A task branch's checks are the check each push of it runs ("A pushed branch"), the critical path included, and only the requests below (INF-2576, the captain's choices "a, the critical path and the edited journeys only; reached ones wait for the swept batch" and "A, write the rules and add the phone workflow guard").
INF-4500's weekly audit widened the journey request with the captain's choices "Journeys that import a changed file" and "One Mac round for each edited journey": sixteen later failures in one week were journeys that directly import a changed file, and eight were edited journeys that passed on Linux and failed on the Mac.
INF-6259's weekly audit widened it again with the captain's choice "Wider journey selection": journeys one import further, the importers of an edited helper and the first-run screen's fallback row, after such journeys broke in the batch on changes whose request ran none of them.
The swept batch runs every journey on Linux and the Mac, and the critical path, on each approved change before it reaches `main` ("The swept batch").
So a journey the change only reaches some other way, by a word, a hook, a helper most journeys import or an unmarked fallback row, is checked there, and a break found there sends the change back to its task.

| Check | A task branch requests it when | It requests |
| --- | --- | --- |
| Edited and importing journeys | its change edits a journey file; a journey directly imports a product module or a scenario under `tests/e2e/scenarios/` that the change edits, or a product module one import further (rule 14); it imports a changed export of an edited helper that no more than 40 journeys import that way; or a fallback row marked `request` matches; a held batch's fix requests none, since the batch's rebuild runs every journey on it ("A held batch's repair") | `journeys.yml` with the files `node scripts/affected-journeys.ts --request --base origin/main` lists: an edited file runs three rounds and then alone, an importing one once (`scripts/journey-runs.ts`); with an edited file, `platforms=both` and `mac_once: true`, so each edited file runs every test once on the Mac too, after the rounds of its tagged tests |
| Other reached journeys | never | nothing: they wait for the swept batch; a journey the batch sent the change back for is named again after its repair |
| The batch's Linux checks | the swept batch sent the change back ("A change sent back from its batch", below) | `verify.yml` with `linux_only`, task and reason |
| The Linux sweep | never, outside a named exception ("When to request full verification") | `source-journeys.yml` with `suite: full`, task and reason |
| The phone check | its change selects the phone gate ("Native phone checks") | `phone.yml` with `affected: "true"`, or named `parts`; every part only with `task` and `reason` |
| The replay gate | its change touches a replay trigger (`docs/replay-harness.md`, "The gate") | `replay.yml` |
| The Linux package check | its change edits how the Linux packages are made (`docs/linux-packages.md`, "The checks", lists the files) | `linux-packages.yml`, which no pull request starts (INF-2834) |
| Full verification | never, outside a named exception ("When to request full verification") | `verify.yml` with `full_system`, or `mac_only` for its Mac jobs alone, task and reason |

Each request goes once per task, at the final version, after the branch's own check passed.
A request that names its version (`ref`) names one a branch of the project holds, the task's pushed branch normally; the workflow refuses any other before anything checks it out (`docs/public-ci.md`, "A check requested by hand").
A request made while the change is still being written is a diagnostic, never its proof.
A phone request that failed with nothing to repair is retried by rerunning its failed job, which runs only the parts that did not pass and turns that run green; after a repair, a retry names only its failing part and device, and the whole affected selection runs once at the final version ("A retry after a failed phone request").
Before a request, read the runs already on that version, running ones included, and reuse one that passed or is still running.
A later version keeps a run's proof when the files that differ from the proved version reach none of that run's selection: the journey chooser selects none of the proved journeys, the phone chooser keeps no part, or none of those files makes the Linux packages.
That holds across a repair and across bringing the branch up to date; otherwise request the check again, once, at the new final version.
A phone request after a pass names the passed version as `last_pass` ("The phone check on request"), so it checks only the parts the change's own edits since that version reach, and one after only bringing the branch up to date checks none, and takes no phone Mac, unless a file the change regenerates came out different (INF-4071, the captain's "Only the change's own edits").
The change's phone proof is then the earlier pass and the narrower run together, and a Careful change's validation record cites both runs.
A clash between the change and main's newer phone edits shows at the next phone release, which checks every part on every device its row names.
The phone pictures a release note or a card needs come from that one run's `phone-pictures` artifact, never from a run of their own.
A newer request of `phone.yml`, `journeys.yml` or `verify.yml` on the same task branch with the same selection cancels the older run, waiting or running (INF-3380, the captain's direction A, "the workflow files cancel the older run themselves"): `phone.yml` and `verify.yml` through the workflow's own group, and `journeys.yml` through its first job.
GitHub fails a run at creation, with no job and no reason, when its group name reaches 400 characters, and a journeys selection names any number of files, so `journeys.yml` has no group: it names a request by a hash of its branch and inputs, marks its run with an artifact of that name and cancels the older live run of that mark (INF-3635).
The selection is every input but `task`, `reason` and `verify.yml`'s exact `ref`, so a request of another selection, such as a one-device replacement proof, runs beside the older run.
A request on `main`, a rerun and every call from another workflow keep a group of their own run, attempt and, for the phone release's calls, device, and `journeys.yml` replaces none of them, so nothing else cancels them.
Cancel any other run no longer needed by its id (`POST /repos/{owner}/{repo}/actions/runs/{id}/cancel`).
`phone.yml`'s `request` job refuses a branch request for every part, one with no `affected` or `parts`, without `task` and `reason`, on a light Linux machine before the run waits for a phone guest; `main`, a narrower request and the phone release's call pass.
`tests/release-workflows-journey-suites.test.ts` runs that guard's shell.

### A change sent back from its batch

A change the swept batch sent back passes every Linux test and journey the batch runs before it goes back in line (INF-5097's plan, piece 2, the captain's pick "Every Linux test and journey the batch runs").
A send-back's repair otherwise re-proves only the failure the batch named, while the batch stopped at its first code-check failure never ran the change's other checks, so a change came back once more for a failure the first batch could have shown.
The request is `verify.yml` with `linux_only: true`, the repaired version's exact commit as `ref`, the task and a reason naming the batch that sent it back ("Full e2e runs are CI-only" has the request body).
It runs the code checks and build, every Linux test group, every journey in the full suite, the critical path among them, and the Linux startup fixtures, on the project's Linux machines, and no Mac job, signing or packaging.
A failure on the Mac or Windows alone still shows only in the next batch.
It goes once, at the repaired version, after the branch's own check and the requests above passed, and before the change goes back in line: before its new merge card, or, where the captain's approval is kept across the send-back, before the repair is declared and the change rejoins.
A later repair of the same send-back requests it again, once, at its new final version; a run on that version, passed or still running, is reused.
A change sent back again requests it again after that repair, whatever an earlier send-back's run showed.

### A retry after a failed phone request

A failed phone request is retried by rerunning its failed jobs (`POST /repos/{owner}/{repo}/actions/runs/{id}/rerun-failed-jobs`) when nothing in the change needs repairing, such as a part that failed for a reason outside the change (INF-4496's fix 2).
The rerun checks the same version, and its gate runs only the passes that did not pass in the run's earlier attempts: the failed part, and the parts an early stop left unrun or stopped.
Each failed attempt keeps the names of every pass the run has passed so far in the Actions cache, under a key of its run, job and attempt, and the rerun restores the newest (`readPhonePasses`, `phonePassesLeft` and `keepPhonePasses` in `scripts/phone-test-plan.ts`); a dealt job that another job's failure cancelled keeps its own too, since the rerun of the failed jobs reruns it.
Together the attempts have then passed every pass of the selection at that version, so the rerun's pass turns the run's failed check green and is the change's proof, and nobody reruns the whole failed job.
A record the cache no longer holds runs the whole job again, as before; a rerun of a job whose every pass already passed runs none.
When the failure needs a repair, the repair makes a new version, which a rerun cannot reach.
A diagnostic retry there names only the part that failed and the device it failed on (INF-3726's fix 2): `phone.yml` with that one `parts` value and `device`, at the repaired version.
It never sends the whole affected selection again, and never the device that passed.
An affected request runs every part a shared app file reaches, often twenty or more on each device, for about an hour on the iPhone; a one-part retry on one device takes minutes and holds one phone Mac, which the merge batch's Mac jobs share.
Read the failed part's logs and repair it before the retry, as for any failed check; a retry that fails again names that same part and device again.
A named-part retry is a diagnostic, never the change's proof, and its named part gets no repeat rounds.
Once the repair is final and the branch's own check passes, the whole affected selection runs once at that final version, as "What a task branch requests" says, with its repeat rounds for edited test code.
A failure there is retried the same way, and the whole affected selection then runs once more at the version that holds the repair.

## Journeys on the pull request

A pull request no longer starts `journeys.yml` (INF-2139, captain: "let's pull journeys and phone checks off PRs now"), and runs only the critical path ("The critical path").
A crewmate requests the journeys its change edits and those that directly import a file it changes, and the other journeys its change reaches wait for the swept batch ("What a task branch requests").
`node scripts/affected-journeys.ts --base origin/main` lists the journeys a change reaches, which tells its author what the swept batch will check.
A whole selection is the swept batch's and main's, never pruned by hand (INF-2394 measure 2): `--plan` reads its route, a sweep above 40 files, and `--ran "<files>"` compares it with the files that ran, exiting nonzero on missing coverage.
Neither is a task branch's duty, and no listed-versus-run record is kept for one.
INF-2539 removed the pull request selection from `journeys.yml`, its Linux starter job included; a request names its journeys ("Journeys on request").
A request runs `journeys.yml`'s Linux `choose-journeys` job, which installs the locked tools, selects the journey files and writes the reasons and placement in its summary.
The chooser downloads the journey results from the newest successful `verify.yml` run that kept every one of them unexpired, and sums each journey file's measured Mac durations.
Since the desktop journeys run in two groups (INF-6249), those are `e2e-results-parallel`, `e2e-results-desktop-1`, `e2e-results-desktop-2` and `e2e-results-mac`, and a run needs all four; a run from before kept `e2e-results-desktop` in place of the two groups, and one from before that (INF-2987) the first two (INF-2779), and an older one a single `e2e-results`.
Each lands in a folder of its own, and `scripts/journey-budget.ts` reads every `e2e-results.json` under the folder it is given.
Only a run of every journey keeps those artifacts, so a requested check of the tagged tests alone never becomes the journeys' times.
It finds that run in the workflow's plain run list, newest first, never through GitHub's search by result, which has answered no run while passing ones were listed.
It asks for that list without each run's pull requests, which it never reads: working them out has run past GitHub's time limit and answered 502, and leaving them out drops no run.
It reads each passing run's artifact list and keeps paging past runs without a usable set, including installer-only verifications.
If no passing run has usable timings, the chooser still schedules every explicitly selected file conservatively.
Missing timing artifacts change placement, never selection or the need for a new full run; unreadable selections remain an error.
An artifact-list error or a failed download still fails the chooser.
`scripts/journey-budget.ts` places every chosen file on Linux, and on the Mac mini (the `journeys` kind's queue or the `MAC_RUNNER` label) only the chosen files that hold a test tagged `MAC_ONLY_TAG`, whose `affected-journeys` job runs only those tests (`--grep @mac-only`), as "Tests that need a Mac" says.
A file with a tagged test runs on both: its tagged tests on the Mac, and its other tests on Linux, where its tagged tests skip or run their shared steps.
A tagged test still needs native proof; a Linux-only request does not claim to provide that proof.
`linux-overflow` packs the chosen files into six-minute groups separately for parallel and desktop files, on Linux machines running beside the Mac.
It is at most five jobs, one per Linux place on the PC (`LINUX_PLACES`, INF-1720's plan).
For modest selections the existing grouping and job count stay unchanged.
For five-job candidate estimates, the chooser additionally reads compact observations from the newest successful default-branch run of each of `journeys.yml` and `verify.yml`.
Missing or expired reports retain the prior placement, and an artifact-list error still fails the chooser rather than hiding an access problem.
An archive the runner cannot download is left out: its download step stays failed on the run, and the chooser goes on with that report missing, since execution never reads these observations and the selection and executed placement stay the same (INF-3622).
The timing reader checks schema, Linux X64, run/attempt/checkout identity, successful final job conclusion, complete selection, lane ownership and compatible configured/actual workers.
It rejects ambiguous reusable-job identities rather than guessing between overlapping jobs.
Each selected file needs a compatible reading; partial coverage retains the entire prior placement rather than mixing Mac test-work sums with Linux elapsed intervals.
An observed skip-only file has zero executed work but stays selected, unlike a missing file.
The estimator preserves file boundaries, schedules files over the observed parallel worker count, keeps desktop serial, and adds observed setup/cleanup outside the executed file span using final job timestamps.
It uses the largest compatible observed file interval and lane overhead, not a replacement platform multiplier.
The allocator evaluates advisory lane allocations within the same five jobs, retaining each nonempty lane and accepting only a lower predicted completion without higher predicted summed job occupancy.
Automatic execution retains the conservative placement until live evidence supports adopting the calibrated model; candidate placements and their timing source remain visible in the placement artifact and summary.
An explicit `--apply-linux` request on `scripts/journey-budget.ts` runs the candidate for verification; `journeys.yml` does not pass that flag.
It never hard-codes a three-plus-two split.
The conservative fallback still gives each lane places by its share of estimated work, at least one, and places a file into its lane's least loaded job, which may exceed six minutes.
A new or previously skipped file uses the middle measured file in its lane, and the summary lists it as unmeasured (INF-2486).
While the packing is not bound to the five places, a group under two minutes (`SMALL_BIN_MS`) joins its lane's lightest other group, since each job repeats the checkout, install and build before its first test (INF-2486).
Conservative Linux estimates use the plan's observed rates: one Mac minute of parallel work per Linux minute and 0.6 Mac minutes of desktop work.
A file stays intact, so an indivisible slow file may exceed six minutes; conservative estimates exclude setup, and neither model predicts runner waits or shared-machine slowdown.
Every selected file has ordinary Linux coverage once; only directly edited selected files receive two additional fresh rounds.
The `platforms` input independently selects Linux, Mac or both, so already completed native proof need not be dispatched again.
The default is Linux; native proof remains required separately when the selected files need it.
The chooser keeps its selection and placement as the `journey-placement` artifact.
The full Mac suite runs in every alpha, or in the swept batch it reuses (INF-2480, INF-2508); a break that only a Mac shows in an untagged test first surfaces there.
When the chooser passes with no tagged files, the Mac job skips by its own condition without taking a runner; when the chooser fails, its failed check holds the merge.
Both success and a job-condition skip satisfy the app's green rule.
If GitHub branch rules ever require `affected-journeys`, they must require `choose-journeys` too: a job skipped because its prerequisite failed does not itself hold a merge.
It reverses captain decision B of 2026-09-15 for pull requests in part (FI3-1305, the captain's answer of 2026-10-08).
That decision kept every Mac journey for the alpha because a hosted Mac was ~$200 a month, and its price was a loop: a change merged on green Linux checks, the alpha's full Mac run found one to three broken journeys of about 610 hours later, and every other pull request waited on the fix.
Twenty-one failing sites in five days were certain breaks after an intentional product change, found at the alpha cut; the check puts them on the change that caused them.
`scripts/affected-journeys.ts` chooses the files from the diff (`--base`, `--head`, `--json` for the reasons):

1. a spec file the change edits;
2. a spec whose import closure reaches a changed helper and imports one of its changed exports, directly or through another helper: one under `tests/e2e/`, a shared one elsewhere under `tests/` such as `tests/helpers/`, or a script.
   The closure stops at a module of `src/`: a product change reaches a journey through rules 3 to 7, 10, 12, 13 and 14 instead, which match words in the spec and its helpers under `tests/e2e/`;
3. a spec that imports a changed module of `src/shared/` and names a symbol that module's diff adds or removes (a declared property of four or more letters or an export, with at least one capital letter);
4. a spec, or a helper most journeys do not import, that names a `data-*` hook, as a whole token, that the change adds or removes in `src/`;
5. a spec, or a helper most journeys do not import, that holds a sentence of two or more words as its own quoted string, one the change adds or removes in a string of `src/`;
6. a spec, or a helper most journeys do not import, that names a `data-*` hook, as a whole token, that the edited part of a file under `src/renderer/` draws before or after the change, even when the change adds or removes no hook.
   The parser uses the smallest enclosing JSX subtree plus ancestor container hooks, or the enclosing top-level declaration for non-JSX edits, following local declaration consumers.
   Import edits, unowned setup, absent hunks and deleted owners retain conservative coverage;
7. a spec, or a helper most journeys do not import, that calls a `window.infinitary` method, or names a read, whose message between the window and the core the change edits (`scripts/window-messages.ts`);
8. a targeted fallback row matches a changed path, even without a changed hook, symbol or sentence; a row marked `request` names journeys a task branch's request runs too;
9. a commit of the change names the journey in a `Journeys:` trailer;
10. a spec, or a helper most journeys do not import, that reads words a string of `src/` serves, when the change alters what it reads.
    It reads them with a regular expression of its own holding a word of four or more letters, or its stand-in scripts a tool by name, as `name: "check_change"`, that most journeys do not script.
    Only quoted strings of two or more words on the diff's lines count; a comment, and a one-word value of the code such as `"checked"`, serve nothing.
    The rule compares the pattern's matches, or the tool's mentions, on the removed and added strings of each file, so words that only moved choose nothing;
11. the freeze journey (`main-thread-freeze.spec.ts`), when the change edits the freeze recorder (`src/core/freeze/`) or the main process's own start and clock (`src/main/index.ts`, `src/main/app.ts`, `src/core/orchestrator/ticker.ts`), other than a unit test (`FREEZE_JOURNEY`).
    That code can hold the main thread with no hook, symbol or words changing (`docs/freeze-recorder.md`, "Before a change merges").
    Other main-process code selects it only through the rules above, and main's desktop release check runs it on every push (INF-2486, the captain's cut E).
12. a spec directly importing a changed product module, even when no symbol changes (relative paths and the `@shared/` and `@core/` aliases).
    A data file that module imports by relative path, such as a runbook's JSON in `src/core/pi/piResources.ts`, is part of the module's text, so a change to it selects the same specs (INF-2426).
    A hub, a module more than 40 journeys import directly (`JOURNEY_SELECTION_CAP`), does not select by import alone, and neither does a hook more than 40 journeys read under rule 6: an edit there would make every change to it a sweep (INF-2486, the captain's cut C).
    Its readers still follow the other rules, its unit tests and the statement check run on the change, and main's desktop release check catches the rest as a main repair;
13. a spec directly importing a stand-in declaring `@journey-area src/path/` in a documentation comment, for a changed file there other than a unit test, which no journey runs (INF-2486, the captain's cut B).
    A trailing slash means every file under that directory; otherwise the declaration names one exact product file.
    The declaration does not follow the common launcher's imports: nearly every journey reaches that launcher, but only the stand-in's explicit callers exercise its product area.
    `tests/e2e/mockClaudeClient.ts` declares `src/core/claude/` so changes to the real reader select the stand-in's callers;
14. a spec one import further than rule 12: it directly imports a product module, other than a hub, that imports a changed product module, or it reaches a helper that imports one, other than a helper more than half the journeys or more than 40 journeys reach.
    An edited module more than 40 journeys reach this way selects none of them by this rule, as a hub does under rule 12 (INF-6259's weekly audit, the captain's choice "Wider journey selection");

A journey calls the window's interface directly, such as `window.infinitary.retention.scope()`, so a changed answer breaks it with no hook, sentence or symbol of its own changing.
`knowledge-gate.spec.ts` compares that answer whole, so a new field in it breaks the journey (INF-1136).
Rule 7 reads a message as a channel of the contract, `invokeContract` or `pushContract` in `src/shared/ipc.ts`, with the groups of channels they spread in from their own modules (`...talkChannels`, `src/shared/channels/`).
The channel changes when the code of its entry changes, or the code of a declaration of the entry's own module that the entry uses, directly or through another declaration there.
A method of the preload's `window.infinitary` object changes with its channel or with its own code in `src/preload/api.ts` or `src/preload/index.ts`, and a read of `readCatalog` in `src/shared/reads.ts` with its channel, its own entry or a declaration of that module it uses.
The journey names the method by its whole path, as `window.infinitary.retention.scope` or `window.firstmate.retention.scope`, or holds the read's name as its own quoted string.
A comment or a line break is not code, so an edited comment on a channel chooses nothing.
A schema the contract imports from another module is not followed: the task and card schemas there change with most changes, and most journeys call a method that carries them.
A change that reaches a journey through such a schema names it in a `Journeys:` trailer.

A core change reaches a journey through the words it serves the model, which the journey's stand-in reads with no hook, sentence or symbol of its own changing, so rule 10 reads them (INF-1255).
Project scopes (PR #470) added a context note holding "a project or scope", and `programRun.ts` read the project the captain named with `/project (\S+)/`, so the note named the project "or".
Merge anyway (PR #462) let a merge card up once every failed check carries its `check_change` diagnosis, and its refusal says so; `checkRepair.ts` scripts `check_change` and relied on that refusal.
A sentence of a template literal that spans lines carries no quote on its own line, so rule 10 does not read it; a change that reaches a journey that way names it in a `Journeys:` trailer.

The fallback table beside the existing selector unions these files into its result, deduplicating files and preserving existing reasons:

| Changed path | Additional files under `tests/e2e/` |
| --- | --- |
| `src/renderer/src/cards/`, `src/renderer/src/app/HomeScreen.tsx`, `HomeMate.tsx`, `HomePrompt.tsx` or `src/renderer/src/app/stage/` | `keyboard-routing.spec.ts`, `stage-reveals.spec.ts` |
| `src/renderer/src/app/focusRecovery.ts` or `src/renderer/src/plugins/frames/frameFocus.ts` | `frame-focus.spec.ts`, `focus-recovery.spec.ts`, `card-task-keys.spec.ts` |
| `src/core/devices/` | `devices.spec.ts`, `devices-links.spec.ts`, `devices-command.spec.ts`, `devices-address.spec.ts`, `devices-ssh.spec.ts` |
| `src/core/routing/placementEngine.ts`, `src/main/host/resourceMemory.ts`, or `automaticPlacement.ts`, `placementFacts.ts`, `resourceSampler.ts`, `computerResources.ts` or `computerResourceFeed.ts` in `src/core/placed/` | `automatic-placement.spec.ts` |

Directory paths match descendants; file paths match exactly.
Each matched row reports its changed paths in the summary, including when existing rules already selected its files.
A matched row with a target missing from the available specs refuses selection rather than silently omitting promised coverage.
Documentation-only changes add no Mac files.

The author of a change knows reach that no rule above reads, such as a journey that imports a module but never names what changed in it (PR #167 broke `now-panel.spec.ts` through `src/shared/taskFacts.ts` that way).
The author names each such journey in a trailer on any of the branch's commits, separated by commas or spaces, as a file name with or without `.spec.ts` or as its path:

```
Journeys: now-panel, task-crewmate.spec.ts
```

The chooser reads the trailers of every commit between the base and the head, adds each named journey with the reason "the change's commits declare it reaches this journey", and the summary shows that reason.
A declared journey is placed beside the screen readers, ahead of the importers of a distant shared helper.
A name that is no journey under `tests/e2e/` fails the chooser rather than silently running nothing for it.
A declaration only adds journeys; it never removes one a rule chose.

A changed helper selects only journeys whose import closure imports one of its changed exports.
The chooser compares top-level declarations and bodies, follows references to edited private declarations, and reads original names through import aliases.
A change to imports or setup before the declarations can affect every export.
Importing a shared module is not enough, and an ordinary word most specs already contain does not count.
A hook name inside a longer token, such as a document path, does not count.
A fragment inside a longer quote does not count, and a sentence held only by the stand-in does not select every journey that reaches it.
The hook and sentence rules ignore app unit tests and cancel a token present on both sides of a file's change; the drawn-hook rule reads the whole changed screen file, not only its diff, and ignores a unit test beside it.
They read only the journey and its own helpers, not helpers most journeys import.
They read the text, not the product's meaning.
They match the whole hook and the whole quoted sentence, so a fragment in the shared stand-in does not select every journey.
A change no journey or helper it imports reaches runs nothing and the chooser reports so in its summary.
A change to an export every journey imports still runs them all, because that is the break this check exists to catch.
A changed screen file that draws a hook most journeys read, such as `stage/CardLayer.tsx` with `data-stage-entry`, likewise runs most journeys.
A model behavior only a few journeys need lives in its own scenario file instead ("A journey's own scenarios"), so an edit to it runs only those journeys.
The Mac job refuses an empty file list, builds once, then runs the chosen files' tagged tests with `--no-deps`, as a local run does (`docs/testing.md`, "Full e2e runs are CI-only").
After the rounds pass it runs the edited files' tagged tests alone, as Linux does for the rest ("Each test owns its prerequisites"), and keeps that result as the `e2e-alone-mac` artifact.
It does not repeat the release's other stages: the replay gate and the package smoke stay `verify.yml`'s, in rolling main, reused by automatic alphas and newly run only for alphas without reusable proof or named exceptions, and the full suite runs in every alpha or the swept batch it reuses.
A newer push to the same pull request cancels the older run, because the Mac mini is one machine.
`tests/affected-journeys.test.ts` pins the selection and `tests/release-workflows-journey-requests.test.ts` the workflow's shape.

The native phone gate uses the same clock and cap through `PhoneWaits.swift`, with each ordinary XCTest allowance its part's deadline, a deadline on every command the gate runs, and a 90-minute gate limit on every route; graded native runs retain Xcode's own allowances and wall-clock waits (`docs/ios.md`, "Disposable verification").
Its on-demand `parts`, `starve` and `perf` inputs select native parts and reproduce twelve-second stalls without changing assertions or app deadlines.

### Journeys on request

`journeys.yml` also runs on request for any branch, with the journeys it names: `POST /repos/{owner}/{repo}/actions/workflows/journeys.yml/dispatches` with `{"ref":"<branch>","inputs":{"files":"now-panel task-crewmate.spec.ts"}}`.
The names are read as a `Journeys:` trailer's are, separated by spaces or commas, and a name that is no journey fails the chooser (`scripts/affected-journeys.ts --named`).
The chooser places every named file on Linux and their tagged tests on the Mac mini.
Its `mac_all` input runs every named journey on the Mac mini as well, every test of it, for a check of the Mac itself such as a `starve` experiment.
`mac_all` and `mac_once` place their files on the Mac even when `platforms` names only Linux, since a request that asks for a Mac round gets one (`scripts/journey-budget.ts`; INF-6259's weekly audit found one passed with its Mac round never run).
Its `base` input, the comparison that decides which named files the change edits, is read where the checkout holds it, or else as the branch of that name where the project lives, so `main` reads `origin/main`; a base that names neither stops each job with words before it runs a journey (`comparisonBase`, `scripts/journey-runs.ts`).
It is a computer's route for journeys in CI mode ("Where the heavy checks run"), such as a journey a change is still being written against.
Its optional `mac_runner` input selects an isolated Mac runner for that request, as `verify.yml` does, without changing shared runner variables.
Ordinary journeys pin the built-in task browser even with an installed browser present.
Its `browser_engine` input set to `chrome` runs the Mac journeys with task browsers in Google Chrome (`INFINITARY_TASK_BROWSER_ENGINE`, `docs/task-browser.md` "Installed browser engines"), and the Mac job installs Google's stable Chrome where it is missing and stops before the journeys if Chrome still is not there; pair it with `platforms=mac` and `mac_all`, since the Linux jobs keep the built-in engine.
A newer request on the same task branch naming the same journeys with the same inputs cancels the older run, so a request may name any number of journeys; a request naming other journeys runs beside it, and a request on `main` or a rerun is never replaced, so another task's request on `main` never cancels it (INF-941, INF-3380, INF-3635; "What a task branch requests").
A finished request is decided by a newer request at the same version, whatever it read: one that failed for a wrong input, such as a comparison the checkout lacks, is retried by a corrected request, and the merge reads that one in its place (`docs/forge.md`, "Check facts and crew judgment").
A retry at the same version therefore names every journey the failed request named, never fewer.
A request its requester no longer needs is cancelled by its run's id (`POST /repos/{owner}/{repo}/actions/runs/{id}/cancel`).

The `starve` input runs the Mac journeys through the load controller, `scripts/starve-check.py`, after the build.
The controller runs the command's own process tree for 0.1 s, stops it for 0.2 s, and adds a 65-second stop after each 20 seconds of that, longer than the one-minute journey default.
It walks the command's known processes and their children, detached sessions included, through `libproc` on macOS and `/proc` on Linux, never a system-wide listing, which on macOS can wait on an unrelated process part-way through exec.
It rescans a stopped parent for children it started meanwhile, rechecks each process's identity before letting it go, and never signals a process outside the tree.
On Linux it counts a process waiting in the kernel with a stop already pending as stopped, since it stops before it runs again: a parent in vfork waits that way until its child, stopped before exec, is let go.
It prints its schedule, the processes it found and the ones stopped at each long stop.
Cancelled, it lets the tree go and gives it five seconds to end before killing what is left.
Its own experiment limit is 15 minutes (`--timeout`, required, in seconds), and its run, pause and stall arguments reproduce another chosen load; compare unchanged and changed code with the same arguments.
The limit is an alarm, as `timeout` keeps its own: a `SIGALRM` sent to the controller ends the experiment as the limit does, with status 124 and the same cleanup.
`tests/starve-check.test.ts` holds it over real detached process trees, and sends its deadline case's alarm only once the whole tree is stopped, so a slow start on a loaded runner cannot end the experiment first.
The `perf` input sets `INFINITARY_PERF_BUDGETS=1` for the Mac command, for a quiet graded run.
Neither input changes where the files are placed or the Linux overflow jobs.

## A journey's own scenarios

The shared stand-in model (`tests/e2e/mockProvider.ts`) answers every journey, so nearly every journey imports it and an edit to it runs them all.
A scripted model behavior that only some journeys need is a scenario in its own file under `tests/e2e/scenarios/`, imported only by those journeys.
A scenario is the stand-in's `Scenario` type: a start function that returns an answerer.
The stand-in calls the start function once when it starts, so any state the scenario keeps lasts as long as that stand-in.
The answerer reads one request (`ScenarioRequest`, which also carries whether it came on Anthropic's messages wire and the stand-in's port, for a card that loads a page the stand-in serves) and returns tool calls, text, a refusal the way the service sends one, `held`, a turn the stand-in keeps open the way a crewmate goes on working, or `threadHeld`, calls the stand-in keeps back until the spec lets them go (`releaseThreadAnswer`); `undefined` passes the request on.
An answer's `afterMs` holds it back that long, the way a model takes its time over a turn's last line.
A journey names its scenarios where its stand-in starts: `launchApp({ withMockProvider: true, scenarios: [reviewedTier] })`, `launchClaudeCrew({ scenarios })`, or `startMockProvider({ scenarios })` for a stand-in the spec keeps across launches.
The kept-merge and guided-merge scripts read git output through `scenarios/mergeShell.ts`: a background job receipt ends the turn, a supervision ask leaves the merge assignment intact, and the exit continues it with the completed output.
Their Pi commands request background execution even on a quiet host, so `settle-effects.spec.ts` exercises that boundary without a sleep or a load-dependent command.
`scenarios/mergeShell.test.ts` replays inline and background completion with disposable git commits and the bash tool's own receipt and exit words.
A relaunch with `reuseMockProvider` keeps the scenarios that stand-in started with, and `launchApp` refuses `scenarios` when it does not start the stand-in itself.
The stand-in asks the named scenarios in the order named, after the first mate's answer-missing retry and a spec's scripted turns (`scriptFirstmateTurn`) and before every shared answer; the first answer wins.
The reply check is the exception: the app asks it about every captain message, beside the conversation and in no fixed order, and it quotes the captain's words, markers included.
The stand-in recognizes it by its question's opening line (`isReplyCheck`), asks only the scenarios marked `answersReplyCheck`, answers `ordinary` when none does, and leaves it out of `requestBodies` and `requestHeaders`, so no scripted turn takes it for its own and no positional read counts it.
Words a journey and its scenario share, such as a marker or a card title, live in the scenario file, and the journey imports them from there.
A shared helper the scenarios read lives in the file that owns it, and a journey, a scenario or the stand-in imports it from there, never through another file.
The request readers, such as `calledTool`, `sinceLastUser` or `isTaskRequest` (a request is the crewmate's of the task with this title), are `tests/e2e/providerRequest.ts`; a crewmate's browser commands and the reading of their answers are `tests/e2e/browserScript.ts`; the card fixtures and card words several crewmates share are `tests/e2e/crewCards.ts`; and the models.json files that point the app at the stand-in are `tests/e2e/mockModels.ts`.
A behavior that answers before the scenarios are asked, or that the spec releases through the first mate's held turn (`releaseHeldFirstmate`), stays in the stand-in.
So do the answers to the app's own words, such as the first-run welcome and a report that declares its work finished, and the captain's words nearly every journey's first mate needs: commission a crewmate, settle, steer or cancel a task, an answer card and a catalog change.
The built-in crew scripts are `tests/e2e/crewScripts.ts`: the crewmate on a build-in-place brief, the crewmate that keeps a card's thread, and the Claude crewmate on a working or a refused login.
The stand-in asks them after the scenarios and its first mate's own answers, and keeps the controls a spec releases them through (`releaseThreadAnswer`, `releaseHeldCrew`, `refuseClaude`).
Every other scripted behavior, whether one journey or several use it, is a scenario.
Only a journey or another scenario imports a scenario file.
`tests/lint/e2e-scenario-imports.grit` refuses the import anywhere else in `tests/e2e`, in `pnpm check`, because one import in a shared helper puts the scenario under every journey again.
An edit to a scenario file then picks only the journeys that import it, by rule 2 of "Journeys on the pull request".

## Per-run e2e evidence

Each Playwright run keeps its result directories (traces, error contexts, failure pictures, `testInfo.outputPath` files) and its JSON result in `test-results/runs/<UTC start>-<runner pid>/` (`tests/e2e/runEvidence.ts`), printed as `This run's evidence: …` before its tests start.
Every `launchApp` keeps a unique `launches/<pid>-<id>/` folder inside that run, including launches shared by a file's hooks and relaunches after a restart.
It streams `main.stdout.log`, `main.stderr.log` and `provider.requests.jsonl` while the app runs, then copies app-owned `crewmates/<task>/sessions/` before and after closing, before scratch cleanup removes userData.
The provider record keeps decoded request bodies with sequence numbers and timestamps, including tool-result follow-ups, never authentication headers; a reused provider replays its history to the new launch's record.
`launch.json` identifies the disposable userData and worker; no account store or whole HOME is copied.
The existing failure uploads in `journeys.yml`, `source-journeys.yml`, `verify.yml` and the batch checks' confirm job already keep this run directory under `test-results/`.
A passing Linux journey upload also keeps pictures saved under a test's `evidence/` output directory, alongside its results and demos.
Main-process streams attach as soon as Playwright returns the launched process; a failure inside `electron.launch` itself has only Playwright's launch error, not these streams.
On Linux, just before each close, the launcher also adds to `threads.txt` every process of the app and of the virtual screen, with each thread's name, its state and the kernel function it sleeps in (`appThreads` in `tests/e2e/launchDiagnostics.ts`).
A window whose drawing process stops raises no error, and Playwright's failure picture then waits five seconds for a frame and gives up, so this record is what names the process and thread that held the window.
Playwright clears a run's output directory as the run starts, and that used to be all of `test-results/`, so a second run of the same working copy deleted the first one's traces and pictures while it was still going, and the two shared one JSON result.
The newest ten finished runs are kept, and every live one; `--last-failed` still reads the working copy's last run, from `test-results/.last-run.json`.
A spec saves its pictures and JSON with `test.info().outputPath(name)` (or the `testInfo` it was handed), so each lands in that test's own directory inside the run's, beside its trace: `test-results/runs/<run>/<spec>-<test title>-<lane>/<name>` (Playwright shortens a long title with a hash).
A fixed path in `test-results/` is shared by every run of the working copy, so a second run would overwrite the first's picture; `tests/lint/e2e-run-evidence-path.grit` refuses one in `tests/e2e` on `pnpm check`.
A run's start clears nothing outside `test-results/runs/`.
A run is going while a process with its runner's pid is running and started no later than the run did, so a pid the system has since handed to another process never counts.
While a run of a working copy is going, `pnpm build` there - and so `pnpm test:e2e` - refuses before writing anything, naming the run (`scripts/refuse-build-during-e2e.ts`, `prebuild`'s first step): the run launches the app from `out/` for every test, and a rebuild would replace the app under its later tests.
Build again once it has finished or been stopped; `pnpm exec playwright test <spec>` runs more specs against the current build meanwhile.
`tests/run-evidence-playwright.test.ts` drives two real overlapping runs, and a build refused under a real run.

## Each test owns its prerequisites

A named test passes when it is selected alone, from fresh state: `pnpm exec playwright test tests/e2e/<file>.spec.ts:<line>`, with `--project=<lane> --no-deps` for a `renderer` or `application` spec.
After a failure Playwright discards the worker, even with zero retries, and the next test starts over from `beforeAll`/`beforeEach`.
A test that leans on an earlier test's task, sign-in or panel then starts on an empty app, and its own red result hides the first one.
In the 2026-09 release cuts, side-rails' collapse and settings cases and forge-signin's sign-in-again and sign-out cases failed that way.

- The setup a test needs is its own.
  `side-rails.spec.ts` launches a fresh app per test, and a case that needs the docked home commissions its task through `commissionFirstTask`.
  `forge-signin.spec.ts` arranges each case's projects, GitHub stand-in and sign-in (`arrange({ signedIn })`).
  `claude-seat.spec.ts` gives each case a test-scoped app, HOME and mock provider, asserts an empty card/task state before the case, and attaches the starting and resulting state.
  `task-record.spec.ts` shares only its app launch; every case commissions its own reported task, including before its restart, and record/worktree reads stay keyed to that task.
- Sharing one app across a file (`beforeAll`) saves launches; it is never a prerequisite.
  Each test still makes the task, card or account it asserts on, and finds it by its own key.
- A journey whose later parts are the point of the earlier ones is ONE test with named `test.step` sections, never separate tests borrowing a predecessor's state.
  `personal-panels.spec.ts` is one: build, relaunch, both themes, a follow-up, removal.
  `claude-crew-turn.spec.ts` is another: card and mid-turn steer, hermetic-client checks, then Observe reading that turn's app-owned transcript after the client original is removed.
  A journey that joins tests keeps the minute each had (`test.setTimeout(n * 60_000)`), never a longer wait inside it.
  `test.describe.configure({ mode: "serial" })` orders tests; it does not make an undeclared prerequisite correct.
- **The run-alone pass** checks the rule, since no lint can see what a test borrows.
  `scripts/e2e-alone.ts` lists the tests with Playwright's own `--list`, and runs each test after the first of a spec file that shares one app (a `beforeAll`) by itself, by `file:line`, in a Playwright run of its own on the current build.
  It is part of the proof of edited journeys, not of main's full check (INF-2340, the captain's route "alone-at-author"): a repeat guards the test's quality, which matters at author time, not the product's.
  `scripts/journey-runs.ts` runs it over the directly edited selected files once their rounds pass, in each Linux job of `journeys.yml` and in the local and CI Mac routes; each CI job keeps the result as an `e2e-alone-…` artifact, and each Linux job lists its counts and failures in its summary.
  A test that runs only on a Mac carries `MAC_ONLY_TAG` (`tests/e2e/tags.ts`) beside its own `test.skip` and reason: on Linux it is recorded as skipped, and the Mac routes run those tests alone (`--alone-tag @mac-only`), keeping the result as the `e2e-alone-mac` artifact.
  Each test's own run names that tag as `--grep` and passes `--no-deps` in every lane, as the rounds do, so on a computer in CI mode the local Mac route's guard (`scripts/checks-mode.ts`) admits it under the route's load hold.
  A test that skips without the tag, or skips on a Mac, fails the pass, since it never ran alone.
  The pass over every spec file runs only on request: `source-journeys.yml` with `suite: alone`, in four isolated Linux jobs, `Manual request · Fresh-start app journeys (Linux; group N/4)` ("The Linux source desktop", below), each keeping its share's result as the `e2e-alone-N` artifact.
  `tests/release-workflows-journey-suites.test.ts` and `tests/release-workflows-verify-evidence.test.ts` hold those steps and `tests/journey-runs.test.ts` the edited selection.
  Locally it takes the affected spec files, like a Playwright run: `node scripts/e2e-alone.ts tests/e2e/<file>.spec.ts` after `pnpm build`.
  The renderer and application lanes' tests run four at a time, and the desktop lane's one at a time after them, as in the full run.
- Vitest cases keep the same rule, selected alone with `pnpm test <file> -t "<name>"`.
  `core.capture.test.ts`'s capture cases share one booted core: a case that needs a project registers its own, the decision case waits out the first mate turn its choice wakes, and the crewmate's spawn, steer, hinted turn, settle and protocol reads are one test whose `section(name, part)` calls name the part a failure stopped in.
  A check over the whole session is an `afterEach` that holds whichever cases ran, never a last case counting what earlier ones made.

## The e2e assertion contract

Adopted by the captain on 2026-09-28 (scout `fm3000-e2e-rigidity-s1`, "adopt with notes") and narrowed on 2026-10-02 (FI3-547: "focus on tests that truly assert a functional user journey without being too specific about the exact pixels at each step").
Of the twelve failures behind three red release cuts, seven were end-to-end specs re-typing a product detail - exact copy, a pixel number, a model id, DOM order - that one intentional change moved, and every such detail was one fact copied into several spec files.
The 0.1.27 cuts then showed what separates the tests worth keeping: all eleven of their test-only failures asserted how the app looks, reads or is built (an internal number or shape, a pixel size, typed wording or an exact list, a halfway state), while every real bug was caught by a step where someone does something and must get the result they came for - press Close and the card goes, ask and the answer card appears - twice inside tests whose own animation and layout assertions noticed nothing.
So an e2e test is a journey: someone does something (opening a screen counts), the test checks the result they came for (the card closed, the task exists, the reply arrived, the setting took, their own data is there, the unsafe thing was refused), and it would still pass if the screen were redesigned and reworded tomorrow.
What a journey asserts, each fact from its one place:

| An e2e spec asserts | Through | Never | Because that lives in |
| --- | --- | --- | --- |
| the journey's result (a task exists, is blocked by its review, a card was filed or closed, the host moved, the setting took) | `window.infinitary.tasks.detail`/`board`, `cards.list`, the task record | the pager text, the feed's wording, a whole state compared for equality (exactly no tasks, the full event list), a halfway state nobody waits on | the typed IPC surface (pinned by `phase0-guardrails.spec.ts`) |
| the controls and content the journey uses or lands on | `data-*` hooks and roles through the helper layer: `reportLine(page, key)` on `[data-feed-event][data-feed-key]`, `nowRow(page, key)`, `recordFact(page, fact)`, `promptInput(page)`, `getByRole("button", …)` | re-typed copy, a page-wide `getByText`, CSS classes, a bare-tag `querySelector("input")`, nth positions, an inventory of what else is on the screen (every tab, chip or row) | `feed.test.ts`, `taskFeed.test.ts`, the vocabulary tests, the replay gate |
| words only when imported from their single source | `RIGOR_WORDS.quick`, `reportSummary(MOCK_REPORT)`, `STANDARD_PLACEHOLDER`, the mock's own titles | a string typed into the spec that the product also types | `src/shared/vocabulary.ts`, `src/shared/feed.ts`, `src/shared/firstRun.ts` |
| layout only as the loss it would cause: at the smallest window the control can still be used and the content reached, and a frame stops resizing | doing the thing at `minimumWindowSize` (`BrowserWindow.getMinimumSize()`); where no action shows the loss, measured boxes compared with each other through `tests/e2e/layout.ts` (`within`, `overflows`, `expectClearOf`) | pixel equality, a hard-coded rect, a two-decimal ratio, geometry re-computed in the test; spacing, alignment, colour, a drawing, an animation's timing | `cardGeometry.test.ts`, `threadGeometry.test.ts`, `record.frame.test.ts`; polish is judged by eye and by the pictures a crewmate attaches |
| ids only from the product's tables | `STARTER_SLOTS` (`src/shared/modelSlots.ts`), `CLAUDE_MODELS` | a model id such as "claude-sonnet-5-5" typed into a spec or a helper | the catalog specs (`model-lists`, `decision-models`, `phase5-model-catalog`), whose subject is the catalog |
| timing as order or work | as the timing rule above | wall-clock windows | captain's B1 |

- **The helper layer** is `tests/e2e/rails.ts` (the rails' frames, the now rows, and a task's feed lines by event and key: `reportLine`, `startedLine`, `putInLine`, `statusLine`, `taskLine`, with `taskKey` to find the key and `feedLineOf` for a task-less line in `feedLineFrom`'s own words; `recordFact(page, fact)` selects a task-record detail value by the stable `RecordFact` identity in `src/shared/recordFacts.ts`, painted as `data-record-fact` independently of its displayed label; `recordDrawings(page, taskId)`, every drawing of a task's record on the stage, shown, or held while the next card gets ready or drops away, which a journey that hides a record waits to be gone, the sign its Hide has finished; `expectRecordBody(page)`, the record body once its frame has drawn, which a journey that presses the record's controls waits for inside the open, because the host reveals the record before that frame draws and the frame then grows the card), `tests/e2e/stack.ts` (the card stack; `shownCard(page, title)`, the shown card by the region its title names, never by the title's words, which the last turn's reply may repeat; `expectNoCard(page, title)`, no open card of that title in the core's stack or on the stage; `cardMeta(page, title)`, the shown card's meta line over `data-card-meta`; `pager(page, count)` and `pagerAt(page, position, count)` over `data-card-pager`, never the pager's words; `cardSurface(page)`, the shown card's own box, never the stage's fixed-height `[data-card-layer]` envelope around it; a settle card's `factsStrip` over `data-fact`; and `dragCardTo(page, width)`, the captain's edge drag, which holds the edge beside the card's chrome and travels over it, never over the sandboxed body frame), `tests/e2e/prompt.ts` (the task prompt), `tests/e2e/projects.ts` (`projectRow(page, id)` over `data-project` in Settings → Projects; policy outcomes come from `window.infinitary.repos.list()`), `tests/e2e/crew.ts` (`crewPlaneCounts` over `data-plane-counts` on the visible orbit, read once its first frame has painted; `pointAtCrewmate(page, wanted)`, which waits until the planes have settled in (`data-plane-blend`) and that crewmate is listed, then points at its name when it is a part seated at its constellation node (`data-constellation-crew`) or sweeps the pointer along the orbit `data-plane-crew` names it on, since a start the record already names can reach the orbit a moment later and a part takes its seat only once the planes have settled; `waitForFirstmateIdle(page)`, the character has drawn and the first mate's turn has ended even while a card hides its frame), `tests/e2e/lastTurn.ts` (`yourBubble(page)` and `mateBubble(page)` over `data-last-turn-bubble` in the pair that stays, the first mate's `data-state`, and `bubbleWords` for a bubble's whole words; `askFirstmate(page, text)`, which sends a message and waits for the first mate's answer to it as an order of typed events, `user_turn`, then `firstmate_reply`, then its busy signal down, never a glimpse of the character's working state, which a quick turn can pass through between two polls; docs/composer.md "The last turn"), `tests/e2e/starters.ts` (`starterFor(provider, slot)` over `STARTER_SLOTS`), `tests/e2e/taskTimeline.ts` (`SPAWNED_TASK_START`, the event kinds a spawned task's start leaves on its timeline, which a journey extends with its own turn's), `tests/e2e/taskBrowser.ts` (a task's browser: `browserView(page, taskId)` over `data-task-browser`, `canvasReading` for the pictures the view drew, `pageFillsView` for a page laid out at its view's room and drawn there, `pageSays` and `clickOnPage` on the task's hidden page itself, `windowCount`, `filesHolding` for what no file may keep, `stopTaskBrowsers` to make room under the cap of four, and `closeSite` to close a test site with every connection a browser's session still holds open to it) and `tests/e2e/layout.ts` (layout as invariants: `within(inner, outer)` names the edges that escape, `intersects`, `expectClearOf(page, surface, ...controls)` for a surface inside the window and clear of the controls still needed, `overflows(el)`, `tokenPx(scope, name)` for a token as the window resolves it, `pseudoBox` for where a `::before`/`::after` really paints, `settled(page, read)` for boxes once a move has finished, two reads agreeing across a painted frame of the page, `atRest(target)` for a box read once no motion plays on it or on a box it sits in (a card grows into place as it arrives, its controls already working, and an opened section's content slides into place), and `minimumWindowSize`/`resizeWindow` for the window's own minimum).
  A fact that more than one spec reads gets one helper there, over a `data-*` hook the renderer paints where the fact lives; a fact without a hook gets one, never a copy of its words.
  A product change that moves such a fact is then one helper edit in the same PR, and the end-to-end tests that cover a surface are that helper's callers.
- **Independent oracles.**
  A journey that imports the product's words or numbers (`reportSummary(MOCK_REPORT)`, `PROTOCOL_VERSION`) proves that the fact reached the user, not that the fact is right: importing production output everywhere is not an independent oracle.
  The focused test that owns it states it outright (`src/shared/ipc.test.ts` pins the version's number, `taskFeed.test.ts` the feed's sentences), and an assertion names the user promise it protects.
  Decision consent is read from `decisionConsent` in its journey and stated independently in `src/shared/decisions.test.ts`; answer-task guidance is read from `renderAnswerShapeSection` and owned by `intentBrief.test.ts`.
  Settings recovery journeys keep saved values, refusal feedback and successful retries without copying the explanation that `settingSave.test.ts` and `readableRequest.test.ts` own.
- **Tiers.**
  `pure` and `unit` tests own every printed word, every sentence served to a model and every computed number (`feed.test.ts`, `taskFeed.test.ts`, `cardGeometry`, `threadGeometry`, `record.frame.test.ts`, `rigor.test.ts`); `integration` owns the boxes around the SDK, the CLI and git; e2e owns journeys and boundaries, without the literals.
  A boundary check keeps its build-level assertions, because there the build is the promise: what a card's frame may do, what leaves the Mac, the pinned API.
  A screenshot is evidence a crewmate attaches, never an assertion; no pixel snapshot is added.
  The goldens stay the two that exist: the replay baseline, and the pinned `window.infinitary` API and first mate tool set.
- **The gate is unchanged.**
  E2E stays release-only (`verify.yml`, above) with zero retries; the live Claude catalog alarm and the benchmark tooling tests keep blocking the release.
  The contract exists so that an intentional change breaks one helper its author sees, not a spec the release finds.
- **Keys wait until the app takes them.**
  `launchApp` returns only once the shell marks the window's keys as its own (`data-window-keys="commands"` on the document, `docs/keyboard.md` "Who runs a window command"), so a window key pressed right after a launch runs its command; a journey that reloads the page waits for the same mark with `untilWindowCommands(page)` before its next window key.
  A launch that expects the saved-data refusal window instead of the shell passes `shell: false` and returns once that page has loaded.
  Keyboard settings' recorder is started with `startRecording(page, command)`, which returns once the main process records, and ended with `endRecording(app, page, key)`, which returns once the window's keys run commands again (`tests/e2e/windowKeys.ts`).
  Words typed with Playwright's keyboard go wherever focus is, so a journey types where a step of its own put focus through `typeInto(field, text)`, which waits until that field holds the window's focus, and fills a field it only needs words in with `fill` or `pressSequentially`; a task's hidden page takes keys through `typeOnPage` (`tests/e2e/taskBrowser.ts`).
  A key pressed on an element goes through `pressKey(target, key)`, and an element that only needs focus through `focusOn(target)`: both wait for `untilFocused(target)`, because focus moves into a frame of its own a moment later, and take their turn on the page's input queue (`docs/e2e-contracts.md`, "Input waits for focus").
  A key whose command takes its own frame away, as Settings takes the cards and the side panels, goes through `pressKeyTakingFrame(target, key)` instead, which lets the key up only once that frame is gone.
  A frame is read through the door in `tests/e2e/frames.ts`, which selects it only once the app marks its page drawn (`docs/e2e-contracts.md`, "Frames are read through the door").
  A journey waits for the first mate's answer to a message it sent with `askFirstmate`, and for its turn to end otherwise with `waitForFirstmateIdle`, never by the character's pose name, which reads idle before a turn has started as well as after it ended.
- **The lint.**
  Twelve Biome plugins in `tests/lint/`, scoped to `tests/e2e` and run by `pnpm check`, refuse what the table's "Never" column and the rules above name: `e2e-structural-selectors.grit` (a bare-tag `querySelector`/`querySelectorAll`, a class in any selector), `e2e-measured-box.grit` (a box `toEqual` a rect of number literals, measured lengths and tolerances of two or more digits, geometric `Math.abs` gaps, pixel `toHaveCSS` expectations and product constants used as expected sizes), `e2e-model-id-literal.grit` (a model id outside the catalog specs), `e2e-feed-line-prose.grit` (words typed into `feedLine`: a string, a template, a regular expression or a `new RegExp` built from one), `e2e-no-ms-budgets.grit` (a `toBeLessThan(X_MS)` outside `tests/e2e/perf.ts`), `e2e-run-evidence-path.grit` (a fixed path in `test-results/`), `e2e-typed-keys.grit` (a keyboard's `type` or `insertText` outside `typeInto` in `tests/e2e/windowKeys.ts`), `e2e-firstmate-pose.grit` (the first mate's pose name, such as "First mate - idle", outside `waitForFirstmateIdle` in `tests/e2e/crew.ts`, its own spec and `phase1-shell.spec.ts`, whose subject is the pose), `e2e-frame-door.grit` (a `frameLocator`, a `contentFrame` or an `iframe` selector in a `*.spec.ts`: a frame is read through `tests/e2e/frames.ts`), `e2e-bare-focus.grit` (an awaited `target.focus()` in a `*.spec.ts`: focus goes through `focusOn` or `pressKey` in `tests/e2e/windowKeys.ts`), `e2e-layout-state.grit` (the renderer's `data-rails-folded`, `data-card-width`, `data-stage-rate` and `data-side-panel-size` hooks), and `e2e-text-lookup.grit` (`page.getByText` with typed words or a card's title, and a spec's region found by its name across the page or the stage: a card is found through `shownCard`, another region through its helper; `docs/e2e-contracts.md`, "Find by place, not by words").
  `biome.json` gives them to `tests/e2e/**` alone through one override, so Biome runs none of them over the rest of the tree; a new e2e rule joins that override, never the top-level `plugins`.
  All twelve are errors.
  Biome's rule engine builds a rule's regular expression again at every node it tests, so a rule names a method or matcher as a plain string (`"toBe"`), and puts an `includes "text"` check ahead of each regular expression, with text every match must contain (INF-2138).
  `tests/e2e-contract-lint.test.ts` holds a fixture line on each side of those checks, so a check that skips a real finding fails it.
  The four the table names were each raised once a semantic review had moved its callers onto the helper layer (`e2e-model-id-literal` and `e2e-feed-line-prose` in I6 of scout `fm3000-e2e-rigidity-s2`): a looked-up class became a `data-*` hook or the owning module's exported constant, a model id became `starterFor` or a row read from `window.infinitary.models`.
  The catalog specs keep their ids and the geometry contract tests their measured boxes.
  An imported product size or a token-derived number is still a copied layout expectation, not a journey's result.
  The layout rule leaves inline Set counts and decoded image dimensions alone; a non-layout arithmetic use that it flags keeps an adjacent reason (PNG decoding and the encoded demo attachment limits).
  The frame helper inspects folding only to avoid waiting for an offscreen rail to paint; it never asserts a layout.
  `expectClearOf` accepts any placement that stays inside the window without overlapping the journey's needed controls; the task-board, task-key and row summaries share it rather than reimplementing their placement algorithm.
  `tests/browser/layout-invariants.test.ts` exercises clear placements on every side and refuses overlap, an escaped edge and a missing control, on a plain page of the browser layer.
  A spec whose subject is every element of a tag says so where it counts them, in `// biome-ignore lint/plugin/e2e-structural-selectors: <why>` (a card body's iframes and images in `card-containment.spec.ts`, a card document's scripts in `card-scripts.spec.ts`, a diagram's labels in `phase4-cards.spec.ts`).
  A thirteenth rule, `e2e-frame-actions` (`tests/lint/e2eFrameActions.ts`, run by `scripts/lint-e2e-frames.ts` in `pnpm check` and `pnpm lint`), refuses native `click`, `dblclick`, `check`, `uncheck`, `setChecked`, `tap`, `hover` and `dragTo` on frame contents.
  It follows `frameLocator` and `contentFrame` chains, scoped locator aliases and local or imported helpers' returns and arguments through TypeScript's symbols, rather than guessing from variable names; `owner()` returns the outer iframe element and stays native.
  It loads only `tests/e2e` sources, not the product or libraries, and follows initializers, not later assignments or arbitrary runtime data flow.
  A frame action uses `clickInBody` or an in-frame event, since Chromium can drop native pointer input in the hidden window.
  A journey proving native input itself keeps the action with an adjacent `// e2e-frame-actions: native -- <reason>`; an empty reason or a file-wide exception does not exempt it.
  `panel-tasks` keeps its native activation and pointer-routing checks, and `frame-focus` keeps the click whose job is to transfer focus without the helper doing it.
  A fourteenth, `e2e-no-writer-after-launch` (`tests/lint/e2eWriters.ts`, run by the same script), refuses a store opened for writing in a spec once the app runs (`openDatabase`, `new TaskService`, `new CardService`, `new CardStore` after a launch, in a kept closure or in a helper called after one); a spec reads saved data after a launch through `readSavedData` (`tests/e2e/savedData.ts`), and `// e2e-writer-ok: <why>` waives a journey whose subject is someone else's write (`docs/e2e-contracts.md`, "One writer once the app runs").
  A fifteenth, `e2e-typed-words` (`tests/lint/e2eTypedWords.ts`, run by the same script), refuses words a spec types where they belong to someone else: a `toContainText` or `toHaveText` whose expected value carries a typed literal of three or more words, a fixture constant whose words the product also types under `src/`, and a contract or protocol version typed as a number; the spec reads the words from their owner instead, the product's exported words or composer, the mock's constant or its own named constant (`docs/e2e-contracts.md`, "Words come from their owner").
  `tests/e2e-contract-lint.test.ts` drives the Biome rules on fixtures and the frame rule through its callable and command interfaces, including breaking chains, preserving shell actions and requiring reasons; `tests/e2e-writers-lint.test.ts` drives the writer rule and `tests/e2e-typed-words-lint.test.ts` the typed-words rule.
  The fifth TypeScript rule in that script, `e2e-claude-store-owner` (`tests/lint/e2eClaudeStore.ts`), refuses a journey calling either component Claude seed or writing under the Claude store instead of using `signedInClaudeHome` or `launchSignedInClaude` (`docs/e2e-contracts.md`, "A signed-in Claude home").
  `tests/e2e-claude-store-lint.test.ts` exercises component calls, aliases, raw writes, reads and adjacent reasoned mutation exceptions; `tests/mockClaudeClient.test.ts` checks the home through both the stand-in client's status and the product's store reader.
  These are lints on test code, never a banned-phrase list on product copy, and they recognize only the patterns they name: a clean lint is not proof that a spec asserts a contract.

### Completion controls

`completionAction(page, title)` in `tests/e2e/stack.ts` reads the card's typed settle-merge action and locates its button by the action's exact label, so the journey never duplicates host-authored wording.

## Focused stylesheet contracts

`tests/renderer/` owns browser checks of exact stylesheet composition, outside the end-to-end journeys above.
`pnpm test:styles` runs them against Chromium in the hermetic launcher's hidden window after `pnpm build`; the complete CI `pnpm test:e2e` gate includes them.
`railDocking.spec.ts` exercises the real rail stylesheet with collapsed, expanded and hidden bottom panels on both rails, protecting one bottom group with no extra margins between its shown panels.
`detailsReveal.spec.ts` opens the record template's More row under the real reveal stylesheet and focuses inside it in the same task, protecting a body that takes focus before its fade draws a frame.
Pictures and a surface reproduction still show whether a visible fix meets the captain's intent.

## Capturing pictures of a change

A change a person can see gets pictures of each changed view before the first edit and after the change (`docs/delivery-rigor.md`, `docs/card-authoring.md`).
A view that shows only under a condition, or only after a script reveals it, still counts as a changed view.
The merge card's Before and After show as many pictures as the change needs.
This project's recipe uses `regionShot` in `tests/e2e/pictures.ts`:

1. Build once per state: `pnpm build` before the first edit (the unchanged app), and again after the change.
   A hermetic run shows what `out/` was built from, not what the source holds: the app's own panels (`src/panels/`, such as the task board) reach it only as the compiled `out/frame-lib/builtin/` (`docs/ui-plugins.md`, "The app's own panels are ordinary folders (piece 7)"), so restoring the source to photograph the earlier state needs another `pnpm build` too.
   Never build while an e2e run of the working copy is going (`## Per-run e2e evidence`).
2. Launch through the hermetic launcher, `launchApp` in `tests/e2e/launch.ts`, in a throwaway Playwright script or an existing spec you run alone with `--no-deps`; never the real app, home or sign-in.
   Reach the view through the same mock provider and seed helpers the specs use (`seedTask`, `tests/e2e/stack.ts`, `tests/e2e/crew.ts`).
3. Fix the window size with `resizeWindow` (`tests/e2e/layout.ts`), for example the minimum window size from `minimumWindowSize` plus one roomy size, and use the same size before and after.
   Choose a size where the entire intended region fits both the window and its scrolling ancestors; a locator taller than the visible scrolling region cannot capture hidden content faithfully.
   For content that cannot fit, photograph smaller intentional regions or use an explicit scrolling capture strategy, never a partial picture described as whole.
4. Photograph each region with `regionShot(region, path)` (the card, the panel, the row), not the whole window, so the picture is cropped to the smallest region that shows the change; take both themes (`setThemeViaSettings`, `tests/e2e/theme.ts`) when color changes.
   It waits for the region's and its ancestors' finite reveal motion with `atRest`, brings the region into view, and checks its measured bounds against the window and every clipping ancestor before capturing.
   That wait includes an opened section's own reveal (`details::details-content` in `design/reveals.css`), which Chromium lists among no animations and `atRest` reads from the content's style, so a region inside a section just opened is never brought into view while the reveal still slides it down.
   It photographs the region at any Size, 100% to 150%, at the window's own resolution, the way `heroShot` does ("A hero picture" below), with the caret hidden.
   A refused crop requires resizing the window or choosing a smaller region; disabling screenshot animations alone does not establish reveal readiness or recover clipped content.
   `tests/e2e/region-shot.spec.ts` checks this boundary by decoding synthetic corner markers after a reveal and at every Size, not by comparing a visual golden.
   It also checks that the wait lets go of a region inside a section just opened only where the section's reveal leaves it.
   When the change is the window itself, `windowShot(page, path)` photographs the whole window the same way, at any Size.
   Playwright's own `page.screenshot` shows only the window's top-left at a larger Size ("A hero picture" below says why), so a whole-window picture never comes from it.
   `tests/e2e/window-shot.spec.ts` checks `windowShot` at every Size by decoding synthetic markers in the window's corners, with a recording running alongside that must keep every frame whole.
   Chromium already waits for the page's next drawn frame, and for a frame at the window's current size, before it copies, so none of these pictures waits or tries again.
   When Chromium refuses one all the same, the picture fails and its error names what the window showed just after: the page and the window, the app's processes and when each started, whether the page still draws, and whether the same copy and a fresh one work now.
   The same journey checks that error with a stand-in refusal.
5. Save the files with `testInfo.outputPath(name)`, then copy them into your task's evidence folder with a name that carries the view and the state (`rail-panel-before.png`).
   They stay out of the working copy, the commit and the PR.

Shoot a view again after any later edit or update that touches it, the same way as before.

## Recording a demo

Where the change is behavior a still cannot show - a drag, a keyboard journey, motion, progress, recovery from an error - that view gets a demo recording in place of its pictures (`docs/card-authoring.md`, "Demo recordings").
Record the same action before the first edit and after the last, at the same window size, theme, data and crop, with `startDemo` (`tests/e2e/demo.ts`) in the same kind of throwaway script or spec run as the pictures:

```ts
const demo = await startDemo({ withMockProvider: true, size: { width: 1280, height: 800 } });
// reach the view through the mock provider and seed helpers, as for a picture
await demo.record("Drag the row to the top", rowList, async () => {
  // the one action, played once
});
const files = await demo.finish({ dir: testInfo.outputPath("demo"), name: "rows-after" });
```

1. `startDemo` launches the hermetic app (`launchApp`) with its home pinned by `CFFIXED_USER_HOME` as well as `HOME`, fixes the window at `size`, then starts Playwright's screencast (`page.screencast`) on the ready window, keeping every frame it draws as a JPEG at quality 100.
   It records browser rendering, never the screen: the window stays hidden and nothing else on the Mac is in it.
   The demo is never built from Playwright's own WebM of the window: that encoder is fixed at 1 Mbit/s VP8 with a starved keyframe every 5.12 seconds, which flashes the view grey-purple for one frame and blocks dark gradients before the MP4 step runs.
   A frame smaller than the window (a capture cut off by a clipped screenshot) is dropped and the frame before it holds.
   `demo-recorder.spec.ts` holds a still view past that interval and refuses a one-frame flash.
   The first recorded frame supplies the clock origin for action marks, so startup time cannot shift the poster or crop back into an earlier reveal.
   Readiness takes whole-window pictures with `windowShot` only: any clipped capture, Playwright's own `page.screenshot` included, briefly crops Chromium's drawing surface, and at a larger Size the recording catches a frame of only the window's top-left.
2. `record` waits for fonts and the starting view to draw at rest, and scrolls a named region wholly into view.
   It holds a drawn half-second lead-in, marks the start, and keeps the starting view for 0.2 seconds across encoder frame rounding.
   It plays the action once and marks its end, cropping to the region's starting box: the card, panel, row, or `"window"` when the action opens something over it.
3. `finish` closes the app, cuts that span (with half a second before and most of a second after) out of those frames at their real times, crops it, scales it to fit 1280 x 720 at 24 frames a second, and encodes a silent H.264 MP4 (High profile, CRF 14, full-range BT.601 JPEGs converted once to limited-range BT.709 and tagged so, yuv420p, `+faststart`), its poster (the recording frame at the action-start mark; `poster: "first"` or `poster: "last"` explicitly selects a recording frame) and a manifest of how it was made.
4. It checks the result as the host will on a card - `readDemoVideo`, every frame decoded, the poster the recording's own size.
5. When no MP4 can be made, `finish` falls back to a GIF of the same span that plays once: at most 10 seconds (a longer action is refused, not cut), fitted to 1280 x 720 at 10 frames a second through FFmpeg's palette pass, made at three quarters and then half that size when it passes 8 MB, written with `-loop -1` so it carries no loop instruction, and checked by `readDemoGif`, the host's own walk; its poster follows the same action-start default and explicit frame choices, and its manifest says why the MP4 could not be made (`fallback`).
   `format: "gif"` makes the GIF alone, as `card-demo-gif.spec.ts` does to check it; `format: "mp4"` makes the MP4 alone, with no fallback.
6. A demo that cannot be made either way throws `DemoEncoderUnavailable` naming both reasons rather than leave one the card would refuse; it is reported with still pictures, never relabelled or claimed.
7. Copy the three files into the task's evidence folder with names that carry the view and the state (`rows-before.mp4`, `rows-after.mp4`); like pictures, they stay out of the working copy, the commit and the PR.

The encoder is one pinned FFmpeg build (`tests/e2e/demoEncoder.ts`: ffmpeg-static `b6.1.1`, with libx264 for the MP4 and its own GIF encoder for the fallback; FFmpeg 6 on a Mac and the release's static FFmpeg 7 on Linux, both x64 and the arm64 Linux guests that journeys also run on, each checked for the version its pin names), fetched on first use into `~/Library/Caches/infinitary-dev/` (`$XDG_CACHE_HOME` or `~/.cache` elsewhere) and checked against the release's published SHA-256 before it runs.
The download tries the release's own address first and, when that fails, GitHub's API address for the same asset, which its pin names by id; the digest check holds either way.
In CI every job that prepares the window recorder restores that folder from the Actions cache first (`.github/actions/demo-encoder`, keyed on the pin and the platform), so a fresh runner reaches GitHub's release server only on a pin's first download, never in the middle of each recording journey; a machine that already keeps the build skips the restore.
A miss fetches the build in that same step, before any journey runs, and saves it to the cache at once, so one fetch fills the key whether or not the job's journeys pass; a fetch that fails there leaves the demo journeys to fetch it on first use, as on a developer's machine.
The pull request's critical path is the one exception: its journey records no demo, so it restores none (`tests/workflow-hygiene.test.ts`).
It is a development tool: the app ships no FFmpeg, and installing the project's dependencies downloads none.
Playwright's screencast still runs through Playwright's own FFmpeg build, which installing the dependencies does not fetch either, so `startDemo` installs it on first use with the project's Playwright (`playwright install ffmpeg`, into Playwright's cache; `needWindowRecorder` in `tests/e2e/demoEncoder.ts`).
A machine that cannot install it gets `DemoEncoderUnavailable` before launch, rather than opening an app that cannot record.

For a keyboard demo, wrap each press and its result assertion in `await demo.step(async () => { ... })`.
The helper holds that result for half a second before the next press, so focus and intermediate views remain visible at real speed.
These holds are presentation pacing, not readiness checks or performance budgets; the callback still waits for the result through the usual shared helpers.
`record` holds the tail before returning, so an immediate `finish` keeps it too.
Never take a Playwright screenshot inside the action, a locator's or the page's own; take a whole-window picture with `windowShot` and crop the saved file after recording if a reference is needed.
Look at the poster and watch the whole recording before attaching them; describe only the states the files actually show.

A journey that records a demo saves it under `testInfo.outputPath("demo")`, and `verify.yml`'s two desktop journeys jobs, the ones whose lane records demos, each keep every such folder as their `e2e-demos-<lane>` artifact for 14 days whether the suite passed or failed ("A red verify's evidence" below).
Only a journey that calls `startDemo` records; the suite never records itself.

## A hero picture

A change a person can see also keeps one hero picture pair, committed beside its release note (`docs/release-notes.md` "Hero pictures"): the crop a startup note shows when the change is a highlight.
It is part of the change, not evidence, so it is the one picture the pull request carries.
Take it at build time, from one of the After views above, with `heroShot` (`tests/e2e/pictures.ts`) in the same throwaway script or spec run:

```ts
await heroShot(app, page, { region: card, anchors: [panelTitle], name: "<entry id>" });
```

It unions the region and its anchors, pads the clip out to landscape inside the window, photographs that one clip in both themes, encodes WebP in the app's own Chromium, and writes `release-notes/pictures/<entry id>-dark.webp` and `-light.webp`; `ready` brings a view back that a theme switch let go of, such as a pointer resting on a row.
It photographs the clip at any Size, 100% to 150%, at the window's own resolution.
Playwright's own screenshot hands Chromium the clip in page pixels, which Chromium reads as the window's unzoomed pixels, after trimming it at the page's width, so at a larger Size it lands up and to the left of the region and is cut short.
With no clip it hands Chromium the page's size the same way, so a whole-window picture keeps only the window's top-left.
A clip handed to Chromium also briefly crops its drawing surface, which a recording running alongside can catch.
`heroShot`, `regionShot` and `windowShot` therefore ask Chromium for the whole window as drawn, with no clip, and the first two crop it in the app's own canvas, by the device pixel ratio Chromium reports (the Size's zoom times the screen's scale).
All three hide the caret as Playwright's `caret: "hide"` does, and `heroShot` also holds motion still as `animations: "disabled"` does.
After each theme switch it waits for motion that ends, never for motion that does not, as `atRest` does, so a view with something that keeps moving, such as the spinning working mark, still takes its pair, with that motion held at its start.
`tests/e2e/hero-shot.spec.ts` checks this at every Size by decoding synthetic corner markers in both pictures, and with a marker that pulses without end.
It shows each theme without saving it: the main process hands the window the captain's saved preferences with that theme, as the core pushes them after a change, and sets the window material to match, then puts the saved theme back.
Switching through Settings would be the captain's own change, which writes its line in Activity (`docs/orchestrator-contract.md`, "Settled runs"), so a pair of Activity, or of the newest line a collapsed Activity shows, would hold that line in one picture and not the other.
`tests/e2e/hero-shot.spec.ts` checks that Activity shows the same lines at both pictures and that the pair files nothing on the record.
The recipe:

1. Crop to the component that holds the new thing, plus one anchor that says where it is: the card, the panel with its title, the row with its neighbors, the character with its line.
   Never the whole window, unless the change is the window.
2. Keep it landscape, between 16 by 9 and 2 by 1, about 1200 by 600: the lead slot is about 720 by 360 and the two beside it about 330 by 150, so a whole window shrinks past reading.
   The check refuses a picture taller than it is wide.
3. Show the state where the change is at its best, with sample data a person would recognize, never the empty state and never the captain's own data.
   Leave the pointer out unless the change is about resting on something.
4. Take both themes from one clip in one run, at one window size, so the pair matches to the pixel; prefer the smallest window that shows the change without scrolling it, so the picture is dense.
5. Draw nothing on the picture: no arrows, rings or labels.
   The alt text and the note's title name the new thing; when no crop can show the change, declare `noPicture` with the reason instead.
6. The release crewmate looks at the pictures of the entries it ranks and re-takes a pair by this recipe when one does not carry; there is no larger source to re-crop.

## Signed Mac installation and updates

`verify.yml` with `installer_only=true` runs `mac-installer.yml` with its build, which checks its own copies, on the `build` kind's queue and a reused-copies check on the `light` kind's queue, or the placement service's `mini-mac-virtual` virtual-only label where those have none, using the selected ref and existing release credentials without publishing anything.
Its scratch signing home, real notarized binaries, native replacements, saved-work checks and failure cases are described in `docs/alpha.md`, "Isolated signed verification".
The legacy private project keeps its requested pre-merge check.
After cutover to `infinitary-apps`, the first alpha and alphas that change installer inputs (`docs/alpha.md`, "The update check", names them) must pass the full check after merge and before publication, in addition to the update check from the previous alpha (`docs/alpha.md`, "The update check").
The local `mac-updates.spec.ts` journey owns channel selection, update consent, progress, restart recovery and keyboard access, with native effects replaced; it does not prove signed installation.
The affected-journey selector retains that journey for changes to the core Mac controller or shared renderer update store, including changes with no new words or hooks.

## A red verify's evidence

`verify.yml` keeps what the e2e run left on the run itself, so a red release is read from its page instead of re-run blind (scout `fm3000-e2e-rigidity-s2`, I5; held by `tests/release-workflows-verify-evidence.test.ts`).
Each Mac job that ran journeys keeps its own, named for its lane, `parallel`, `desktop` or `mac` (INF-2779, INF-2987):

- **`e2e-results-<lane>`** (`e2e-results-mac-only-<lane>` for a run of only the tagged journeys) is Playwright's JSON result (the `json` reporter in `playwright.config.ts` beside the unchanged console reporter; verify's e2e step names its path, `playwright-report/e2e-results.json`, through `PLAYWRIGHT_JSON_OUTPUT_FILE`), kept whenever the suite ran.
- **`e2e-failures-<lane>`** is, on a failed run, everything under `test-results/` (the run's own directory under `test-results/runs/`, "Per-run e2e evidence" above): each failed journey's `error-context.md` (the error, its call log and the window's accessibility snapshot), `trace.zip` (the runner's steps, errors and sources) and `test-failed-*.png` (the app window), beside whatever the specs wrote.
  Playwright takes the picture and the snapshot as the app closes - inside the test, or in `afterAll` as it retires the worker after the failure - so a journey that shares one app across its file gets them too.
  The picture costs about 100 ms per app close and is dropped when the test passed.
- **`e2e-demos-desktop-1`** and **`e2e-demos-desktop-2`** are every demo a journey recorded (`testInfo.outputPath("demo")`, "Recording a demo" above), kept by each desktop journeys job whenever the suite ran, passed or failed, so a requested demo can be watched from the run's page.
- `e2e-failures-<lane>` is kept 7 days, the others 14 days.
  None can fail the job, and none runs when a stage the suite needs kept it from starting.
- **Every stage reports**: each stage waits only on the stages it needs, never on every stage before it (INF-663).
  The unit suite, the client check and the replay gate need the install; the e2e suite needs the build and the recorder, never the signing; the signing stage needs the install, and runs after the one journey stage its job has; the package smoke needs the build and the signed dev Electron; the four package checks need the package.
  Each stage but the e2e suite, which every Mac job runs a group of, runs in exactly one of the three Mac jobs, and every Mac job installs and builds for itself, since both take seconds beside handing a build from one machine to another.
  So a red unit test still leaves the e2e suite's and the package's results on the run, the linux-checks lane's checks and build each run whatever another of them did, and each Linux test group runs on its own machine whatever another did.
  The job still ends red on any failure, so `release.yml` still refuses to sign.
- **The job summary** names the requested ref and the exact commit checked out, the first failed stage, the e2e counts (skipped includes a serial file's tests that did not run), every failure in the order it started and the first one's assertion.
  It reads the stages' outcomes and the JSON, never the log's prose, and decides nothing about which failure caused which: that stays with whoever reviews the evidence.
  It reports and never gates.
- **What they can hold:** every app ran on a throwaway userData and HOME, no verify step holds a secret (`release.yml` passes it none), and a trace records the launch environment's shape, never its values.
- Zero retries and the release-only trigger are unchanged.
  A local run writes the same files into its own `test-results/runs/<run>/`, the JSON beside them ("Per-run e2e evidence" above); a `--reporter` flag replaces both reporters.

## A virtual Mac as a runner

On the Mac mini, start a local virtual Mac only under `borrow-virtual-mac --label <text> --minutes <n> -- <command>`.
It borrows `mini-vm1` or `mini-vm2`; do not add a load-line declaration or hand-made hold for that virtual Mac.
The borrow owns the whole command's lifetime, ends at completion or the later of one hour and the declared minutes, and cleans up a leftover virtual Mac.
Outside CI, `image.sh` and `run.sh` enter that command automatically where it exists, using `BORROW_MINUTES` (required there) and optional `BORROW_LABEL`.
An existing `BORROWED_PLACE` reuses the outer borrow without asking again; scripts use its `BORROWED_VM` name and granted processor and memory size.
Where the command is missing, the scripts start at once as before; CI keeps its existing placement.
For example, `BORROW_MINUTES=30 scripts/virtual-mac/run.sh tests/e2e/mic-access.spec.ts` borrows for the journey and cleanup.
Phone checks use `phone.yml` on the phone queue, never these local mini borrows.
A local split `start` refuses where borrowing is available, because returning from it would free the place before the gates ran.

A virtual Mac runs the journeys like the Mac mini does only when its image holds two things the app and macOS look for there.
`scripts/virtual-mac/image.sh [name]` builds that image with tart (`brew install cirruslabs/cli/tart`, or name it with `TART`), under tart's own `TART_HOME`, `~/.tart` by default.
It clones Cirrus Labs' `macos-tahoe-xcode` image of the Xcode `scripts/phone-pin.json` names with 6 CPUs and 16 GB by default (the granted size under a borrow) as `infinitary-lane`, and `provision.sh` adds Node 24, the `packageManager` pnpm, a warm pnpm store and the two things below inside it.
Each part checks itself as the image is built, and the image is renamed into place only once all of them pass, so a fix lands in the script and never in an image by hand.
`scripts/virtual-mac/run.sh <files>` runs journeys in a fresh clone of the image the way `journeys.yml` runs them on the Mac mini, on the working copy's committed version, keeps the run's log and `test-results/runs/` in `test-results/virtual-mac/`, and deletes the clone.
`scripts/virtual-mac/phone.sh` retains its legacy lifecycle for existing callers and cleanup; no current workflow calls it, and it is not the route for phone proof.

### One image for every project

The Mac mini's placement service (`dotfiles-private`) runs every project's Mac jobs in fresh clones of this one image, two at a time, and deletes each clone after its job.
It brings its own GitHub runner into each clone, so the image holds none.
Provisioning installs its checksum-verified Node archive under `$HOME/tool-cache/node/<version>/arm64`, checks the executable's version, then writes `arm64.complete` for `actions/setup-node`.
`$HOME/node` links to that installation, preserving the guest services' and login shells' path.
The placement service points virtual runners' `RUNNER_TOOL_CACHE` at `$HOME/tool-cache`, outside the runner's wiped `_work`, so the first job in a fresh clone finds Node without downloading a manifest or archive.
After reboot, the image builder checks the completion marker, cached executable and shared installation before publishing the image.
`provision.sh` fails the build unless the tools those jobs' workflows name are there: `git`, `gh`, `python3`, `perl`, `swift`, `xcodebuild` and `xcrun`, and the iOS 26.1 runtime that a project's full simulator suite explicitly requests.
The base is Cirrus Labs' image of the Xcode `scripts/phone-pin.json` names, and the build refuses it unless that Xcode is the one selected and every iOS simulator build the pin names is available, iOS 27.0 for the iPhone and the iPad and iOS 27.1 for the iPhone Duo; provisioning downloads a build from Apple when the base lacks it (`docs/ios.md`, "Disposable verification").
Neither base provides that iOS 26.1 fixture.
Provisioning also updates the guest's Homebrew and installs its Python and Bash, refusing an image without `tomllib`, Homebrew's tap-trust command or Bash 4+ on the job's path.
The full Mac gate consumes Python and Homebrew, and a simulator admission wrapper uses Bash's `coproc`; macOS's Bash 3.2 is not sufficient.
Both Tart services prepend the image's Node and Homebrew to their child process path and use launchd's `ProcessType Interactive`, so their children do not inherit background scheduling.
`guest-services.sh` configures both plists without replacing or reloading the responsible agent, preserving its microphone grant.
The builder requests shutdown inside the guest and waits for a successful VM process exit before rebooting or publishing; a failed or incomplete shutdown refuses the image.
After a fresh boot, it checks both saved `ProcessType` values and both loaded services' `spawn type`, then Python's `tomllib`, Bash and Homebrew through a non-login `tart exec`, matching how the runner starts.
It records the verification shell's actual priority without asserting a fixed scheduler value.
The provisioning user's signing commands run only inside the disposable guest with an explicit scratch home and signing-material directory.
`image.sh` finds an Apple-verified, ready iOS 26.1 disk installed on the build Mac, or accepts its Apple-supplied disk through `IOS_RUNTIME_DMG`.
It shares that disk's folder read-only and imports the runtime inside the guest; it never copies simulator devices, host runtime state or signing material.
`IOS_RUNTIME_VERSION` names the required version and defaults to 26.1, and the image is refused unless that runtime becomes available after import.
The guest's imported runtime remains in the image, while the source disk stays untouched on the build Mac.
The build also fails when the image holds any code-signing identity, so nothing that signs as the captain is ever in a clone.

### Each Linux job's kind

DOP-251's plan moves Linux jobs to the Mac mini's Linux guests one stage at a time, so a Linux job that may move names its kind, and the repository variable `LINUX_QUEUES` maps each kind to the label of its queue, as JSON such as `{"light":"fleet-linux","gate":"fleet-linux-gate"}`.
Each such job reads `fromJSON(vars.LINUX_QUEUES || '{}').<kind>` after the hosted machine a call from `main.yml` or a release asks for, and before `LINUX_RUNNER` ("A release's hosted machines").
A kind the variable leaves out, and an unset or empty variable, keep the label the job asked for before, so the variable changes nothing until it names a kind.
Name a kind only once the placement service serves its queue, so no job waits on a label nothing serves.
A Linux job with no kind, such as main's startup fixtures and the Linux packages, never reads `LINUX_QUEUES`; release packages use their separate variable.
`tests/release-workflows-runners.test.ts` moves each kind alone and holds every other job where it was.
A compute Mac's guest is an arm64 Ubuntu 24.04 container, so the branch check's whole run passes there as on the PC's x86-64 places: its build, its browser layer, and its critical path on Xvfb with an arm64 Electron.
A test that passes on only one of them is a defect in the test, repaired at its owner.
A journey whose far computer is this one is the exception: it reaches this computer over its own SSH server, or runs the command for another computer on it, and on Linux that far computer needs an SSH server and an x64 chip, the one chip Infinitary for Linux runs on, where a guest has neither.
So a journey request's Linux part that holds one (`FAR_LINUX_JOURNEYS`, `tests/e2e/lanes.ts`) runs where `LINUX_RUNNER` sends it, never on the `journeys` kind's queue: `scripts/journey-budget.ts` marks the part and `source-journeys.yml` reads it as `far-linux`.
A full Linux sweep picks each job's group inside the job, after its machine is chosen, so on Linux `scripts/journey-groups.ts` puts every one of them in the first group of its lane (`FAR_LINUX_GROUP`), and `source-journeys.yml`'s full-suite matrix marks those two jobs `farLinux` to keep them off the queue too; the other groups still take it.
The fresh-start sweep runs alone only the later tests of a file that shares one app, and none of these files shares one, so its four jobs hold none of them; `tests/release-workflows-runners.test.ts` holds both facts.

| Kind | Jobs | Its old label |
| --- | --- | --- |
| `light` | `verify.yml`'s `request`, `size-warning.yml`'s `size-warning`, `batch-checks.yml`'s `watch` (it reads the batch's run for about 40 minutes, so it holds no hosted machine), and `docs-site.yml`'s `build-and-check` (an outside pull request still takes hosted Ubuntu first) | `LINUX_RUNNER` |
| `ci` | `ci.yml`'s `unit-tests`, `integration-tests` and `probe-tests`, `replay.yml`'s `replay-gate`, and `prompt-budget.yml`'s `prompt-budget` | `LINUX_RUNNER` |
| `gate` | `journeys.yml`'s `choose-journeys`, and `phone.yml`'s `request` on a request (the phone release's call names hosted `ubuntu-24.04`), the two choosers a Mac job waits on (INF-5387's plan, piece 1) | `LINUX_RUNNER` with `-gate` |
| `checks` | `verify.yml`'s `linux-checks` lane and its Linux test groups (`linux-tests`) | `LINUX_RUNNER` |
| `journeys` | `source-journeys.yml`'s `source-desktop`, the app journeys a request, an alpha or the swept batch runs on Linux, unless the caller asks for hosted or a request's part or a full sweep's group holds a journey whose far computer is this one: a queue whose places are the PC's Linux places first and then each compute Mac's arm64 Linux guest, which takes the job only while no PC place can | `LINUX_RUNNER` |
| `typecheck` | `ci.yml`'s `code-checks`, `reached-tests`, `reached-tests-parts` and `build`, the branch check; the project's own home names no queue for it, so it runs on hosted Ubuntu like every other Linux job: on hosted four-processor Ubuntu its steps take about as long as on the project's own Linux places (INF-6330's plan) | `LINUX_RUNNER` |

### Each Mac job's kind and size

Every job that runs on a Mac names its kind, and the repository variable `MAC_QUEUES` maps each kind to the label of its queue, as JSON such as `{"check":"mini-mac-check","phone":"mini-mac-phone"}`.
The Mac mini's placement service gives each queue a size in cores and memory and decides which jobs run side by side, so a heavy job waits for room rather than share the Mac mini with another heavy one.
GitHub picks which of a queue's waiting jobs a new runner takes, so one queue holds one kind and one size.
Except for the required `phone` kind, a missing kind or unset variable keeps the label the job asked for before.
Name a kind only once the placement service serves its queue, so no job waits on a label nothing serves.
Other jobs read `fromJSON(vars.MAC_QUEUES || '{}').<kind>` before their old label; phone jobs read only `fromJSON(vars.MAC_QUEUES).phone`.

| Kind | Jobs | Its queue places it |
| --- | --- | --- |
| `split` | `verify.yml`'s Mac lanes, the full Mac check: native tests, replay and package; parallel journeys; two desktop journeys groups | in a virtual Mac only |
| `native` | `verify.yml`'s native tests, replay and package and its parallel journeys, ahead of `split` and of a batch's or release's `release_split` | GitHub's own `macos-15`, not the placement service |
| `check` | none of its own: the full Mac check's lanes fall back to it after `split` and `journeys` | anywhere |
| `journeys` | `journeys.yml`'s `affected-journeys` | anywhere |
| `phone` | `phone.yml`'s `native-phone` | on any Mac place: the rented vBoxx places and the compute Macs alike |
| `testflight` | `ios-release.yml`'s `testflight`, which signs after the separate unsigned phone job succeeds | on the real Mac |
| `build` | `mac-installer.yml`'s `build`, which also checks the copies it signed | in a virtual Mac only |
| `sign` | `release.yml`'s signing job | on the real Mac |
| `light` | `mac-installer.yml`'s check of reused copies, `mac-update.yml`'s update checks, `release.yml`'s `publish`, `republish-casks.yml` and `phone.yml`'s `scene-evidence` | in a virtual Mac only |
| `release_split`, `release_build`, `release_sign`, `release_light` | the same jobs as `split`, `build`, `sign` and `light`, in a publishing release | as their ordinary kind |

A publishing release asks first for its own kinds, whose queues the placement service starts before every other waiting Mac job (DOP-178); each falls back to its ordinary kind and then to the old label.
Those queues share the same places and add no capacity; they keep a release from waiting behind phone checks, main repairs and borrowed virtual Macs.
The TestFlight job runs only for a release, so its `testflight` kind has no release twin, and the placement service ranks its queue the same way.
A dry run asks for the ordinary kinds, so a rehearsal never takes a release's place in line.
`release.yml` hands `release_split` to `verify.yml` as its `mac_runner` input, `release_build` to `mac-installer.yml` and `release_light` to `mac-update.yml` as their `runner` input, and `verify.yml`'s Mac lanes read their kind only when that input is empty.
The batch checks' sweep, the alpha's full check, hands `release_split` the same way.
The `native` kind is the one kind whose queue is GitHub's, `macos-15`, free in a public project: its five jobs take GitHub's five Macs for about half an hour each and leave the project's Macs to the desktop journeys (INF-6330's plan, option D).
Those lanes read it before `verify.yml`'s `mac_runner` input, so a batch and a release send them there too, while the desktop lanes keep the input's queue; a request's own `native_runner` input comes first, to measure another runner, such as `macos-15-intel`, before a switch.
Removing `native` from `MAC_QUEUES` sends them back to `split` in one parallel journeys job.
The full Mac check's lanes ask for `split`, then the `journeys` kind, whose queue already takes journeys-sized jobs, then `check`, then the old label, so until `MAC_QUEUES` names `split` they run where journeys run.
The placement service starts `release_build` before `release_sign`, so a publishing release's signed installer build starts first; on the Mac mini the build's place and the signing job's cores do not fit together, so signing waits until the build job, with its installed check, ends; until `MAC_QUEUES` names it, the build asks for its `build` kind, as in a dry run.
`tests/release-workflows-runners.test.ts` ("each Mac job's kind") evaluates every Mac job with the variable set, unset and for a publishing release, and refuses a Mac job without a kind.
The `phone` mapping remains `mini-mac-phone`, served from every Mac place the placement service runs, the two rented vBoxx places and the compute Macs alike.
Those places also take other queues, such as the merge batch's Mac lanes (`release_split`), so phone checks and batch lanes wait for the same places (INF-3726).
`tests/phone-pool-isolation.test.ts` evaluates workflow runner expressions, including matrix entries and both release modes, against the configured queues.
It requires exactly the three native phone-check jobs on the phone queue and rejects secret reads in any job resolving there, including inherited workflow environments.
The ordinary GitHub job token used for checkout and results is not a repository signing or publishing secret.
Explicit proof-run label overrides remain operator-controlled; do not direct another kind of job to `mini-mac-phone`.
No change to `VIRTUAL_MAC_RUNNER` is needed: phone jobs ignore it, and when no place serving the phone queue is free, phone work waits rather than falling back to another label.
Already-created requests and reruns of older workflows retain their old routing; preserve running jobs and use the current workflow for new phone proof.

Where the placement service names a job's size, it sets `RUNNER_UP_CORES` to the job's cores.
A virtual Mac is made that size, but a job on the real Mac shares the processor with the jobs beside it, and macOS cannot hold a group of programs to a share, so the job's own test workers keep to it (`scripts/job-cores.ts`).
Each journey job of the full Mac check runs half that many Playwright workers, at least one, the same share of the job it took of the whole machine before ("E2E scheduling and launch diagnostics").
Playwright's own limit (`playwright.config.ts`), vitest's unit cohorts and the integration cohort on macOS (`docs/test-cohorts.md`) count the same cores.
With no size named, each counts the whole machine, as before.
A virtual Mac's size bounds it but guarantees it nothing, because its cores are the Mac mini's own, so the service keeps the sizes of what runs together within what the Mac mini has for jobs.

### The real Mac's place

A job that signs with the captain's Apple certificates asks for the real Mac: `release.yml`'s signing job, by the `sign` kind, and `ios-release.yml`'s TestFlight job, by the `testflight` kind.
Where its kind has no queue, each reads `${{ vars.REAL_MAC_RUNNER || vars.MAC_RUNNER || <its fallback> }}`, so until the switch sets `REAL_MAC_RUNNER` it runs where it ran before.
The signed installer's build and Apple-silicon checks, the release's Apple-silicon update check and `release.yml`'s publication job ask for a virtual Mac by the `build` and `light` kinds, or by the placement service's `mini-mac-virtual` label where those have no queue.
The publication job holds no Apple signing material and uploads nothing: it fetches back and checks every copy a hosted upload job put in place from the signing job's handoff, then switches the casks and feeds (`docs/alpha.md`, "Signing on the real Mac, uploads on a hosted machine, checks in a virtual Mac").
The signing job runs while the release's checks run (`docs/alpha.md`, "Signing while the checks run"), so it holds the real Mac during the release's Mac lanes, which then take a virtual place or wait.
These checks require throwaway guests for their signing, trust changes or writes to `/Applications` (`docs/alpha.md`, "Isolated signed verification").
The phone check reads its `phone` kind's queue alone (the repository variable `VIRTUAL_MAC_RUNNER` is read by no workflow), so it starts on the next free virtual place; the Mac mini has one, so there it starts after any other phone check (`docs/ios.md`, "A phone check the placement service puts in a virtual Mac").
The other Mac jobs read their kind's queue or `MAC_RUNNER` and may run in any place, a virtual one or the real Mac's.
`tests/release-workflows-runners.test.ts` holds which jobs ask for the real Mac.

### The runner's microphone access

The journeys open Chromium's fake microphone, but coreaudiod still asks macOS for microphone access on behalf of the responsible process, which in a virtual Mac is the lane's guest agent, not the app.
With no grant, macOS raises a prompt nobody answers and `getUserMedia` never settles, so `mic-access.spec.ts` and `voice-prompt-focus.spec.ts` fail after their waits.
The image grants `kTCCServiceMicrophone` to that agent: sign the agent ad hoc (`codesign -f -s -`), because a Homebrew build is only linker-signed and a row for it fails its code requirement, then add a row carrying its cdhash requirement.
The running agent keeps its old signature until it restarts, so the grant holds from the image's next start, which is every clone's first.
`micProbe.cjs` opens the microphone from a file page, because a `data:` page is not a secure context and has no `navigator.mediaDevices`.
`tests/e2e/globalSetup.ts` checks this before any test starts (`tests/e2e/micPreflight.ts`): in a virtual Mac, or with `INFINITARY_E2E_MIC_PREFLIGHT=1`, it opens the fake microphone once and fails the run with the fix when it does not open.
`INFINITARY_E2E_MIC_PREFLIGHT=0` turns the check off for a run whose specs open no microphone, as `tests/run-evidence-playwright.test.ts`'s fixture runs do, so a slow virtual Mac does not boot Electron for it before their first spec.

### Drawing in software

In a virtual Mac every app a journey starts draws in software (`--disable-gpu`, `virtualMacSwitches` in `tests/e2e/virtualMac.ts`).
Linux journeys draw in software too, for a reason of their own ("The Linux source desktop").
Its paravirtualized Metal now and then never signals that a frame finished, and Chromium's GPU process waits for that signal with no limit (`CALayerTreeCoordinator::ApplyBackpressure`).
The app then draws nothing, `requestAnimationFrame` stops, and a screenshot waits until the GPU watchdog ends the process 25 to 50 s later, past Playwright's 30 s (INF-747).
Other apps in the same guest keep drawing, because each GPU process waits on its own signal.
Software drawing has no such wait.
The Mac mini draws on its real graphics card and keeps that path covered.
A perf run's paint budgets (`INFINITARY_PERF_BUDGETS=1`, `tests/e2e/perf.ts`) graded in a virtual Mac measure software drawing instead.

### The Claude Code the app finds first

`knownClaudeHomes` looks in `~/.local/bin` and `~/.claude/local`, which the base image leaves empty, then in `/opt/homebrew/bin`, all before the search path.
So the image installs Claude Code there with Homebrew's npm (`/opt/homebrew/bin/npm install -g --force --prefix /opt/homebrew @anthropic-ai/claude-code@<version>`); a copy Node's own npm puts in `~/node/bin` is never read.
The version is the one the Mac that builds the image finds first, or `CLAUDE_CODE_VERSION`, so the lane runs the client the Mac mini's own journeys run.
`claude-seat-instructions.spec.ts` fails with a first mate that never answers when that copy is old.

## Voice start and release budgets

`tests/e2e/voice-freeze.check.spec.ts` is a macOS real-model check, skipped unless `INFINITARY_VOICE_MODEL_DIR` names the installed Whisper model directory.
It clones that directory into hermetic userData and uses the fake microphone; no real microphone or sign-in is used.
Run `pnpm build`, then `INFINITARY_VOICE_MODEL_DIR="<model directory>" INFINITARY_PERF_BUDGETS=1 pnpm exec playwright test tests/e2e/voice-freeze.check.spec.ts` on a quiet host.
It grades seven budgets.
Two keep the window thread and the main process free: first-use main-process busy time under 300 ms, and release-key handling under 16 ms at sixfold renderer throttling.
Five keep the model out of the window and the process that draws it: no WebGPU work on the GPU process's main thread after release, no task there of 16 ms or more after release or during first use, and no more than 500 MB of renderer or GPU-process footprint growth.
Where the recognizer runs in the window (an Intel Mac, `docs/architecture.md` section 8) those five are printed but not graded.
Every run also prints the voice helper's own footprint while its model is loaded.
Budgets are soft (`tests/e2e/perf.ts`), so one run reports every miss.
Release-key handling is one sample of a React re-render at sixfold throttling and is noisy on a loaded host; judge it over several runs.
The Chromium traces include actual key dispatch markers and are kept with the run; missing markers fail instead of making a whole trace look like post-release work.
Set `INFINITARY_VOICE_HOLD_MS=60000` to check release after a minute of real capture, where the synchronous clip work used to grow with length.

## The latency check

`tests/e2e/latency.check.spec.ts` is INF-2078's latency measure, the one INF-1359 and INF-1361 run on their cards: the actual app on a record the captain's size (`tests/e2e/captainSizedRecord.ts`) with the freeze recorder on, six stand-in crewmates each writing a progress line a second (`tests/e2e/scenarios/writingCrew.ts`), while the captain types a question one key at a time and then scrolls the Tasks list with its landed work open.
It is a perf check (`PERF_TAG`) that skips unless `INFINITARY_PERF_BUDGETS=1` on a Mac, so it runs on request: `journeys.yml` with `files` naming it and `perf` on, or `verify.yml` with `perf` on.
Locally, run `pnpm build`, then `INFINITARY_PERF_BUDGETS=1 pnpm exec playwright test tests/e2e/latency.check.spec.ts --no-deps` on a quiet Mac.
It grades the plan's bar, each a soft hold (`graded` in `tests/e2e/perf.ts`), so one run reports every miss:

- no main thread stall of 50 ms or more while typing or scrolling, read from the freeze recorder's record (`docs/freeze-recorder.md`);
- a key press round trip under 17 ms at its 95th percentile, timed from the test's press to the window's page done with it, which holds the driver's own dispatch of a few milliseconds and the app's main thread, where a stall holds every key;
- Tasks list frames under 20 ms at their 95th percentile and under 50 ms at most, with under one in twenty dropped (over 25 ms), read by the Tasks panel's own animation frames while the list scrolls a step a frame and the crew's changes arrive;
- each list redraw under 4 ms and the core's cost per change under 5 ms, read from a Chromium trace of a quiet stretch with only the crew writing, as the top-level tasks of the Tasks panel's main thread and of the app's main thread; a task that bundles several writes counts once.

Every run prints each measure as a `[perf]` line, and writes `latency.json`, each stall in words and the trace into the run's own directory.
It also prints, ungraded, the window's start, its memory, a core request's round trip and the first mate's answer, timed by the window's own clock from the Enter to the reply and idle state it hears (INF-1352's plan, to compare the window before and after it reaches its first mate over the local door).
A second test, also printed and ungraded, times a crewmate's card picture from the card reaching the window to its picture drawn, and twelve changes of a page a task's browser shows from the change to its picture in the window's view, and writes `picture-latency.json`.
A third test, printed and ungraded, measures the window beside the first mate in its own program against the window running it itself (INF-1352's plan, piece 7): the memory of each program and the two together, the window's start, a core request's round trip, the first mate's answer, a key's round trip and 30 bursts of fast typing timed from each key to the screen drawn after it, while the stand-in crew writes; it starts the command through a stand-in service manager (`tests/e2e/serviceManagerStandIn.ts`) and writes `two-programs-latency.json`.
The app ticks at its own period, so a minute pass may or may not fall in a stretch; judge a measure near its bar over several runs.

## The runner's automatic updates

A fresh Ubuntu runner machine can start Ubuntu's own automatic updates as it boots, and they hold apt's locks: the daily list refresh holds the package lists' lock, and `unattended-upgrade` holds dpkg's.
A plain `apt-get` stops at once on a held lock with exit code 100, which fails the job before any test runs, whatever the change.
So every package install on the runner machine itself goes through `scripts/apt-install.sh`, never a bare `apt-get`: the journeys' virtual display, the Linux packages' build tools and virtual screen, and the Ubuntu package installed on the runner.
The helper first turns the automatic updates off for the rest of the machine's life (`APT::Periodic::Enable "0"`), so a run that starts later ends without touching apt; only a disposable runner may run it.
It then waits for a run already going to end, which apt's daily script marks by holding `/var/lib/apt/daily_lock` for its whole run.
Meanwhile it asks that run's `unattended-upgrade` to stop, the way the package's own shutdown helper does, and it stops after the package it is installing, leaving dpkg consistent.
`apt-get` then waits for dpkg's lock (`DPkg::Lock::Timeout=-1`) should anything else hold it; apt's own wait covers only dpkg's lock, never the lists' lock `apt-get update` takes, which is why the helper waits for the daily run itself.
Each wait lasts as long as its step's time limit, ten minutes for each install step.
That limit holds the download too, so the journeys' virtual display and the Linux packages' virtual screen download nothing they can do without.
The journeys' desktop names Xvfb and the libraries Electron needs, every one of which GitHub's hosted Ubuntu images hold, and parks the pointer through the X library rather than a tool of its own ("The Linux source desktop"), so the step downloads nothing there.
The Linux packages' runner itself needs only Xvfb, so that step downloads nothing there either, and the AppImage check works its question with xdotool and ImageMagick from its own container's packages (`docs/linux-packages.md`, "The checks").
A release built from another commit than the workflow's own, as a stable is from its alpha's, may run an older check that works the AppImage's screen from the runner, so that leg also installs both there, with `--no-install-recommends`: ImageMagick's recommended packages, Ghostscript and its fonts, are 25 MB that its one screenshot never uses.
A runner's image may already hold every package a step names: the PC's job image holds every package of the Linux desktop.
Refreshing the package lists then still downloads about 12 MB, and naming a package installs its newer build with whatever that pulls in, about 28 MB of Mesa's graphics libraries for `libgbm1`, which a slow mirror stretches past ten minutes before any test runs.
So before it touches the network or waits on the automatic updates, the helper asks apt what installing the named packages would unpack or remove, planned from the machine's own lists and status alone and keeping every package already installed as it is (`apt-get --simulate --no-upgrade`).
When that is nothing, it downloads and installs nothing, and asks a running `unattended-upgrade` to stop without waiting for it, since the step then needs none of apt's locks.
Otherwise it refreshes the lists and installs with `--no-upgrade`, so only the missing packages and what they need are downloaded.
A plan apt cannot make from the machine's own lists, such as for a package they lack, also takes the refresh.
A `.deb` file names the build to install, so a step that names one always refreshes the lists and installs it, over an older copy too.
A mirror can also stall the list refresh partway: a connection that keeps sending a little never trips apt's own timer, which ends only a connection silent for 30 seconds, so `apt-get update` waits until the step's limit fails the job before any test runs.
Because apt prints a line as it starts each file or gives one up, the helper takes a refresh that prints nothing for 90 seconds as stalled, ends it and starts a fresh one with new connections.
A mirror part way through its own update can serve a package list that the index it already served does not describe, and `apt-get update` then fails with status 100, naming the list's unexpected size and asking `Mirror sync in progress?`, though the same refresh passes once the mirror's update has moved on.
So the helper waits 60 seconds after a refresh that fails and starts a fresh one.
Stalled and failed refreshes share one count, three refreshes in all, and any other status stops the step at once.
Ninety seconds is longer than apt's own longest silence, about a minute while it retries a silent connection.
The pause after a failure is shorter than the 90 seconds a stall takes to notice, so three refreshes of either kind still end inside an install step's ten minutes, or end at all where a step has no limit of its own.
None of this helps while a hosted machine's own mirror, the first its list names, stops answering: apt then falls back to Ubuntu's main archive, which can stall each of the three refreshes, so a step downloads nothing it can do without.
An install inside a container needs none of this: the container's apt is its own, and nothing in it updates automatically.

## The Linux source desktop

`source-journeys.yml` builds the checkout and runs journeys on the app built from source on Ubuntu 24.04 x64 (`LINUX_RUNNER`, hosted when unset), under Xvfb on a 2560 by 1600 virtual screen with Chromium's sandbox enabled.
`journeys.yml` calls it as `linux-overflow` with `suite: affected` for a request's named journeys, and `batch-checks.yml` for the critical path on the batch's version ("The swept batch"); INF-2539 removed the pull request's `linux-source` call and its fixed starter list.
Linux runs the keyboard journeys `keyboard-routing` and `keyboard-regions`, which press Ctrl where a Mac presses ⌘ (`docs/keyboard.md`, "Keys on each system"), the task browser's journeys, the device journeys and the voice journeys (`phase6-voice`, `voice-prompt-focus`, `voice-fields` and `repro-voice-press`), which hold right Ctrl, with a stand-in graphics card and a stand-in voice helper (`docs/e2e-contracts.md`); the real card check is the captain's on each Linux alpha (`docs/architecture.md` section 8, "Where speech runs").
`verify.yml` calls it as `linux-e2e` with `suite: full`: every journey in the suite, in every alpha or the swept batch it reuses and named full-run exceptions, in nine jobs, with no run-alone pass (INF-2340).
Six take a group each of the parallel lanes (`styles`, `renderer` and `application`) and three a group each of the serial `desktop` lane, groups of about equal measured time ("Journey groups by measured time", below), each run with `--no-deps` so neither lane waits as the other's teardown and the desktop lane still runs alone on its machine; a job is named for its group, such as `Main push · App journeys (Linux; serial group 2/3)`, a serial group being a share of the desktop lane.
Nine jobs keep the swept batch within the twenty hosted jobs GitHub runs at once for the project: the batch's other hosted jobs are the critical path, `linux-checks` and the eight Linux test groups.
A request with `suite: alone` runs the run-alone pass over every spec file instead, in four fresh-start jobs, `Manual request · Fresh-start app journeys (Linux; group N/4)`, which divide the run-alone pass’s ordered listing by round-robin position with `--shard N/4`; together they cover every later file:line/lane selection once, without splitting tests that share a line.
Each share keeps the existing fresh Playwright process and home for each selection, runs the parallel lanes at the existing local width and then its desktop selections serially, and keeps a distinct `e2e-alone-N` artifact and summary.
The Mac-only tests skip there.
Request `source-journeys.yml` on a branch with `suite: alone` to check just those four jobs, without the ordinary suite, Mac checks or packaging.
Its manual `suite: full` route runs the same nine full-suite jobs, including styles, with no Mac tests, signing, packaging or broad unit sweep.
Pass `ref` as the exact source commit, `task` as the requesting task and `reason` as why the Linux sweep is needed; each job checks its checkout and records these fields before installing or building.
The dispatch's top-level `ref` selects the workflow definition; `inputs.ref` selects the tested source, and the artifact names, timing identity, test order and failure reporting remain the reusable full route's.

### Journey groups by measured time

Playwright's own `--shard` cuts a lane into equal counts of files in listing order, so the group that drew the slow files held up every run (INF-2987).
`scripts/journey-groups.ts` instead splits a lane's files by the seconds each took, longest first into the group with the least time so far (`scripts/shard-balance.ts`, as the unit groups are split), and runs Playwright over its group's files alone.
A group with no file runs nothing, since Playwright given no file runs every one.
The times are `tests/helpers/journeyTimings.json`: each file's job seconds on Linux, on the project's Macs and on GitHub's Mac (its work over the workers that ran it), and each Mac job's seconds outside its journeys on each kind of Mac, the head start its group begins with.
A file with no measured time, a new journey, weighs the median of the measured ones.
On Linux the journeys whose far computer is this one go to the first group of their lane before the rest are split, their seconds its head start, so that group's job can keep an x64 place with an SSH server ("Each Linux job's kind").
GitHub's Macs run the same file at different speeds from round to round: in three batch rounds a group's journeys took 1.3 to 2.6 times the record, and the two longest files, `forge-signin.spec.ts` and `gitlab-delivery.spec.ts`, swung 2.4 and 3.7 times while the rest of their group swung about 1.5, so one group ran 40 minutes in one round and 24 in another while the others stayed near 26.
The record's longest-of-several rule gives such a file its worst round's weight, which keeps two of them out of one group; write `--hosted` times from several rounds, never one.
`scripts/journey-group-timings.ts` writes the record from a passing full run's results: the Linux groups' `journey-timing-Linux-*` artifacts, the Mac jobs' `e2e-results-<lane>` artifacts, and that run's job list for the Mac jobs' own work; with `--hosted` the Mac results and job list are a run on GitHub's Macs and write their times alone.
Write it again and commit it when journeys move or the groups' times drift apart.
A manual `verify.yml` request instead requires `full_system: true`, or `mac_only: true` for its Mac jobs alone, plus task, source and reason before expensive jobs can start.
Both `stable` and `alpha` profiles run full-system checks, not Linux-only checks.
Installer-only and installer-reuse requests retain their separate route and cannot also select `full_system` or `mac_only`; main and release reusable calls need no manual opt-in.
With `suite: affected`, each job ends with the run-alone pass over its directly edited files and keeps it as `e2e-alone-<suffix>-<lane>`.
A stable promotion inherits them with the other lanes ("Full alpha checks, inherited stable checks" in `docs/alpha.md`).
The replay gate and packaging stay on the full check's native Mac job.
The Linux packages have their own checks, an installed-package journey on a clean copy of each system (`docs/linux-packages.md`, "The checks").

The launcher shows the app's window on Linux without giving it focus (`paintLikeAMac` in `tests/e2e/launch.ts`): a hidden window there paints about once a second, where a hidden Mac window paints at the display's rate, so a journey that waits on frames or plays Chromium's synthetic pointer would wait out its time.
On the virtual screen the shown window disrupts no desktop, so run Linux journeys under `xvfb-run` there too.
With no window manager the window under the pointer takes the keyboard, so the lane parks the pointer on the screen's last pixel, where no window reaches, and stops before any journey unless the pointer is there (`scripts/on-screen.sh`).
`scripts/park-pointer.ts` moves the pointer and reads it back through the X library Electron itself loads, called through koffi, so the virtual screen needs no tool beyond Xvfb ("The runner's automatic updates").
It starts Xvfb with `-noreset`: Xvfb otherwise resets as its last client leaves, which is the park itself before any app opens, and puts the pointer back at the screen's centre.
Every app window opens centred, so a pointer at the centre sits in each one, and the windows of parallel journeys, opening and closing over one another, hand it to the window under test, whose page then hears it leave what its journey rests on.
Linux text is antialiased in grey, as macOS draws it (`--disable-lcd-text`): Chromium draws subpixel text only on an opaque layer of its own, so a component would otherwise draw different pixels in a panel and out of one.
Linux journeys draw in software from the start (`--disable-gpu`), as a virtual Mac's do ("Drawing in software").
A Linux runner has no graphics card, so the window composites in software either way, but without the switch Chromium's drawing process first starts Mesa's software GL (llvmpipe): its driver and compiler, a GPU watchdog and a shader cache in each launch's fresh home, only to report GL unusable.
Journeys never use GL there, so they skip that start-up, which depends on what the machine has installed and runs in the process whose stall leaves a window undrawn with no error.
If a window stops drawing again, the record of what each thread waits on ("Per-run e2e evidence") names that process's threads.
A journey reads this computer's desktop through `tests/e2e/desktop.ts` (`THIS_DESKTOP`, `HAS_APP_MENU`, and a key's words and `aria-keyshortcuts` through their owners in `src/shared/keyboard.ts`), and its dictation key and hints through `tests/e2e/dictation.ts`, so the same journey reads ⌘ and right ⌥ on a Mac and Ctrl and right Ctrl on Linux.
A step whose subject only a Mac has - the window wash, Show in dock, the app menu - runs where the desktop has it, the rest of its journey runs on both, and the test carries `MAC_ONLY_TAG` so a pull request's Mac job runs that step.
A journey whose whole subject is the Mac's skips on Linux, says why and carries `MAC_ONLY_TAG` ("Tests that need a Mac"): the shell keys' default keys (`multiline-composer`, `card-threads`; `docs/composer.md`, "Shell keys"), the window wash (`window-wash`, `activity-runs`), macOS's microphone permission (`mic-access`), macOS's question about other apps' data (`macos-privacy`), the app's own git (`app-git`, `run-work`; `docs/forge.md`, "The app's own git"), the Mac app another Mac downloads with its zip tools (`devices`, `run-work`), `CFFIXED_USER_HOME` (`user-data-folder`) and the real voice model (`voice-freeze.check`).
The SSH journeys run on Linux too, against the runner's own OpenSSH (`tests/helpers/sshServer.ts`), on an x64 machine ("Each Linux job's kind").
The demo encoder is the release's static FFmpeg 7 there ("Recording a demo" above).
A mock crewmate writes its fixture files one bash call each, since Linux refuses a command argument over 128 KiB (`writeFilesCalls` in `tests/e2e/crewCards.ts`).

The disposable Linux runner, a hosted machine or the PC's fresh virtual machine, installs the downloaded Electron sandbox helper root-owned with mode 4755 at a space-free temporary path, named by `CHROME_DEVEL_SANDBOX`.
It removes the unpacked adjacent helper after installing it because Chromium prefers an adjacent helper to the development fallback.
Chromium splits the helper's command-prefix path at spaces, so the helper is separate while the checkout and app executable still stay under `Application Support`.
The Playwright launcher explicitly enables Chromium sandboxing.
Each job keeps the machine-readable result and any failed journey evidence; the job that runs `source-start` also keeps a 1280 by 800 Linux window picture.
Ordinary Linux source jobs additionally keep a separate `journey-timing-Linux-<suffix>-<lane>-<shard>` artifact for 14 days, without changing those evidence bundles.
The timing exporter comes from a separate sparse checkout pinned to `github.workflow_sha`, not the candidate's `inputs.ref`; these local reusable workflows share their caller's commit.
An older reviewed candidate need not contain the helper, and a branch moving after dispatch cannot replace the exporter.
The export command still runs in the candidate's directory and reads its report and git revision, without copying tooling into or modifying that checkout.
`tests/journey-timing-workflow.test.ts` exercises the workflow's checkout inputs and export command with separate candidate and workflow commits, including failed and missing reports.
`scripts/journey-timing.ts` projects the existing Playwright JSON into `journey-timing.json`: schema version, run and attempt, checked-out revision, platform and architecture, suite/lane/shard, requested and observed selected files, configured and actual workers, outcomes and per-file/project attempt intervals and work.
Paths retain their directory identity, including styles files under `tests/renderer`; repeated attempts keep their retry and worker identity, without logs, steps, pictures or attachment paths.
`elapsedMs` spans the first executed attempt's start through the last one's end in that file/project group, including intervening gaps; `workMs` sums non-skipped attempts and is not wall time.
Skipped attempts remain observed skips, with null elapsed intervals when nothing executed; missing reports, absent requested files and tests without results remain explicit and cannot be successful complete observations.
The exporter marks a report successful only when the test command succeeded, every selected test has a completed result, and Playwright records no global errors, unexpected outcomes or flakes.
This flag describes the test observation, not the final workflow conclusion; a timing consumer must also check that job's successful conclusion and compatible provenance before using it.
`setupMs` spans the first job step through test-command entry; `jobObservedMs` and `testStepObservedMs` end at export, after the skip gate but before uploads and runner cleanup.
These are bounded observations, not total job occupancy or runner waiting: join the run/attempt/job and matrix identity to GitHub's job timestamps for final job time, including checkout before the first step and work after export.
A missing report records null workers and Playwright timing, never zero work or a skip.
Run-alone keeps its existing per-selection reports unchanged and does not export the final child process as an ordinary complete timing observation.
The affected-journey allocator consumes compatible compact reports as described under "Journeys on the pull request"; selection, worker limits, lane definitions, full-verification shard counts, cancellation and release gates stay unchanged.
A change to `tests/e2e/layout.ts` reaches every resize and minimum-size caller, calls through the demo helper included, through the affected-journey selector's imports (`scripts/affected-journeys.ts`).
Window sizes in `resizeWindow`, its returned restore value and `minimumWindowSize` describe content pixels before page zoom, not outer bounds that include a native menu or frame.
This is the source app, not a packaged Linux release check.
The launcher gives each app a throwaway HOME, userData, TMPDIR and XDG configuration, cache and data directories, and pins the Mac home with `CFFIXED_USER_HOME`.

## Linux automatic startup fixtures

`linux-startup.yml` runs the production runtime/session classifier through `.github/actions/linux-startup`; `main.yml` calls it once per main check, so a burst of pushes to main is checked once.
No pull request runs it: it caught nothing on 504 pull request runs (INF-2915's plan), and the swept batch does not run it either.
Both startup fixtures and their result summary run even when the other fixture fails, unless the job was cancelled.
The fixtures need systemd and Docker.
It uses a disposable GitHub-hosted `ubuntu-24.04` machine ("A release's hosted machines").
It checks a disposable logged-out user under running systemd, then starts that user's manager for the available case.
It also checks a plain Ubuntu container with installed systemctl but no running systemd, then an unavailable systemctl.
The container's systemctl is the machine's own, put in place with every library it loads, from the same Ubuntu release as the image, and it must run there before either check.
The container runs with no network, so the fixture downloads no package, and Ubuntu's package archive refusing connections cannot fail it with no change to the code.
The job logs the runtime, commands, statuses and classification, never the user manager's environment values.
The fixture removes its disposable user and manager; it changes no person's startup configuration.

## Linux-only branch checks

`ci.yml` accepts `workflow_dispatch` for branch validation without triggering any Mac job.
It runs the same Linux gate as a pull request, and the unit, integration and probe cohorts only with the `sweep` input set to `true`; a successful unit job can be rerun individually to collect required consecutive passes without starting unrelated Mac workflows.
