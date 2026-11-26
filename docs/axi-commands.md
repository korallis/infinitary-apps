# Task AXI commands

A crewmate reaches some of its task's tools as commands in its own shell rather than as tools in its model's tool list: its task's browser, as `infinitary-browser-axi`, the integrations, as `infinitary-integrations-axi` (`docs/integrations.md`), and the files on the captain's other computers, as `infinitary-files-axi` (`docs/files.md`) (the captain's approved design on FI3-1429, after the captain's AXI principles and chrome-devtools-axi).
A command costs a crewmate nothing until it runs one, so the tools it replaces leave every crewmate's standing context.
Every command answers in its task alone, through the app, and every rule its tool keeps stays with that tool's owner: the browser's with `TaskBrowsers` (`docs/task-browser.md`).

## Who has it

A crewmate gets a command where the tool it replaces would bind: `infinitary-browser-axi` where its task has a browser, which is a task on this Mac when the host has a browser engine and a command process (`HostCapabilities.axiProcess`), or a task on a computer that runs work that keeps task browsers (`docs/task-browser.md`, "On another computer").
That computer runs its own channel and command process, the same way, for the tasks it holds: its keys live in its work folder's `task-channel/` (`docs/helper.md`), and its commands reach only the browsers there.
`infinitary-integrations-axi` goes to every task on this Mac when the host has a command process, and to a task on a computer that runs work whose channel there carries it, where each call is asked of this Mac (`docs/integrations.md`, "On a computer that runs work").
`infinitary-files-axi` goes the same way, to a task on a computer that runs work (`docs/files.md`, "The command").
`infinitary-feedback-axi` goes to every task on this Mac when the host has a command process (`docs/feedback.md`, "The command").
The crewmate's instructions carry one line for it, `CREWMATE_BROWSER_LINE` (`src/core/pi/piResources.ts`), the captain's approved words: "This task has its own browser: run `infinitary-browser-axi` to see or use a web page.
Never press the last step of a purchase or booking; ask the captain on a card."
Its `emit_card` keeps `browser_button` and `browser_handoff`, which carry the sign-in and payment rules (`docs/task-browser.md`, "Asking for help").
Its record leaves the command's calls out, as it leaves out the app's own tools, so what a crewmate types into a page never reaches its lines (`runsTaskCommand`, `src/core/axi/names.ts`; `docs/task-record.md`, "A crewmate's actions").

## The launcher

`resources/axi-bin/infinitary-axi` is the one launcher, a POSIX shell script, and every `infinitary-<tool>-axi` in that folder is an identical copy of it; the name it ran as says which command it is.
They are copies, not links, because a Windows checkout writes a link as a text file and the build's copy of the source cannot make one there.
The folder also holds `infinitary-crew-shell`, no command of a crewmate's but the program a Claude crewmate's client runs each shell command through ("Never the crew's" below).
The packaged app ships the folder outside its archive (`electron-builder.yml`), and an unpackaged run uses the checkout's.
The packaged app's run-as-node fuse is off, so a shell has no Node to run: the launcher uses only shell builtins and the system's curl (`/usr/bin/curl`, read with `-q` so no `~/.curlrc` adds options, and with no proxy).
A bare `-v` answers at once from `INFINITARY_AXI_VERSION`, without the app.
Anything else goes to the app as one request, each argument its own form field in order, with the command's name, the path it ran from, the shell's working folder (in Windows form, `C:/...`, under Git Bash), the shell's limit, when the shell started and the shell's id; the app's answer is the command's exit code on its first line and what it prints after it.
A shell with no channel, or a channel that does not answer, prints an error with code `NO_CHANNEL` and exits 1.

## The channel

`AxiChannel` (`src/core/axi/channel.ts`) is how a command reaches its task.
The app listens on a port of this Mac's loopback (`127.0.0.1`) for the run.
A task granted a tool gets its own key, a 256-bit secret written to a file only its owner can read (0600), as the one header line curl sends, in `userData/task-channel/` (`AppPaths.taskChannelDir`, 0700).
The channel empties that folder when it opens and when it closes, so a run that was killed leaves no key that outlives the next start, and nothing is left in the system's temporary folder.
The task's shell is told three things (`TaskShell` on the session spec, laid over the host's environment by `withTaskShell`): the address (`INFINITARY_AXI_ADDRESS`), the key's file (`INFINITARY_AXI_KEY`), never the key itself, and the version; and the launcher's folder goes first on its search path.
Pi's own shell (`jobs/jobManager.ts`) and the Claude client, and so every command the client runs, carry it.
A request names its task by its key alone: the app looks the key up by its digest, and a command reaches only the tools of the task whose key it holds; nothing in its arguments names a task.
Anything on this Mac can reach a loopback port, a web page among them, so a request that names another host (a name rebound to this Mac) or carries an origin is refused before its key is read; the launcher sends neither.
A task granted again keeps its key, so a shell already given it still answers, and the task's close revokes it and deletes its file.
The app's quit stops every running command process and removes the keys; a heavy program already admitted by the native load wrapper is not a command process and keeps its group reservation.

## The command process

axi-sdk-js writes `process.exitCode` and reads `process.argv`, so each command runs in a process of its own, never the app's: the host starts one per request (`src/core/axi/axiProcess.ts`, a utility process in the app through `HostCapabilities.axiProcess`, a plain `fork` in tests).
It runs `runTaskAxiCli` (`src/core/axi/cli.ts`) over the command's table with what the shell passed, its home view naming the path the shell ran it from, and sends back what the command printed and its exit code.
The table reaches the task's tool only through one call per operation, which the app answers against the tool it granted that task: for the browser, `CrewmateBrowser`'s `navigate`, `inspect`, `act`, `capture`, `close` and `pages`, and never a picture's bytes.
A command process that has not answered in a minute is stopped.
An interrupted native load claim returns `CLAIM_UNAVAILABLE` with the existing reading cadence, letting its waiting wrapper keep the same process group and ask again; other commands still fail without retry permission.
Its output goes to the app alone, never to the app's log.

## A shell's limit

Pi's shell answers within 3 seconds and turns anything longer into a background job (`SYNC_CAP_MS`); it tells every command it runs that limit in `INFINITARY_SHELL_CAP_MS`, when the shell started in `INFINITARY_SHELL_STARTED_MS` and the shell's own id in `INFINITARY_SHELL_ID`, and the launcher passes all three on.
The app keeps a command within it, counting from when the shell started while that shell can still answer, not from when the request arrives, so a slow launcher still answers before the shell gives up: an operation still running 750 milliseconds before the limit goes on in the browser, and the command prints `running: <command>` with how to read its answer.
A request that arrives once that limit has already run out counts from when it arrives, as before, and a finished answer kept for the next command is given even then.
A computer that runs work uses this same channel and this same shell, so its commands keep the same limit.
That answer is kept for the task's next command: if it has finished by then, that command prints it under `earlier:` and does not run, saying so; if not, it refuses with `BUSY` and does not run either.
The bare command is the way to look again, so an action is never sent twice.
A shell with no limit, such as the Claude client's, waits for every answer.
Every answer comes back through the shell that ran the command, and on a loaded Mac that way back, or the app's own process, can be held up past the limit, which no margin covers.
So a request tells the shell whose id it carries that its command reached the app (`JobManager.answering`), and that shell waits for the answer to come back instead of turning it into a background job.
It waits at most one limit more, so a shell that goes on with other work after the command still becomes a job.
A shell whose command reaches the app only after its limit is already a background job by then.

## The runtime

`runTaskAxiCli` (`src/core/axi/cli.ts`) is the shared runtime, built on `axi-sdk-js` 0.1.13, and runs only in the command process.
Each tool supplies its name, purpose, version, home callback and command table, and each command its usage, description, accepted flags and callback.
A flag is either a switch or consumes a value; unknown, repeated and missing-value flags refuse before connecting.
`--` ends flag parsing so subsequent text is content, including literal `--help`.
Global `--help`, command `--help` and `-v` answer without connecting to a task.
Unknown commands and invalid arguments answer on stdout with exit 2 (`VALIDATION_ERROR`); a refusal and a connection or operational error use exit 1.
No command table may register an SDK reserved command, and the runtime shadows every one with a refusal, including `update`, so no updater runs or appears in help.
It never calls a hook installer and never writes provider settings.

## The load command

`infinitary-load-axi` reaches this computer's declared heavy-run line, through an optional `load` grant on the same task channel.
The home grants it to local tasks with a command process and to every computer that runs work; the work computer owns the actual line.
Its bare invocation reads the task's declarations.
Its `run --processors <number> --memory-mib <number> -- <program> [arguments]` path dispatches to the native Bash wrapper before the generic request path, so the program retains the caller's streams and environment.
The wrapper's `claim` requests carry only its process identity, demand and optional outer hold.
A claim timeout, command-process startup failure or premature exit does not end the wrapper's group or discard its queue position.
The common launcher also distinguishes a claim's transport timeout from a channel refusal; only that idempotent operation may repeat before launch after its answer was lost.
The host may still finish a timed-out claim, so recovery always asks with the same identity and requires a fresh admission reply before executing the program.
A separate `receipt` operation records the exact living payload identity after launch; only that receipt can repeat after launch through `RECEIPT_UNAVAILABLE`.
The native supervisor keeps the payload in the same group, preserves its streams and signal behavior, and cancels receipt pursuit when it finishes.
A receipt whose caller's connection closes before its answer stops its command process and saves no launch from then on; a claim, like every other command, runs on without its caller.
Claim and receipt polling clear the shell cap and shell ID and use separate stable operation identities, never another operation's kept answer.
Processor reservations end only after verified launch and a complete following aggregate CPU interval; memory growth reservations continue.
No command table can release a living group or bypass the recorded `load-line` hold.
The caller's demand, admission order, pressure behavior, nested runs and group lifetime are owned by [Declared heavy runs](heavy-runs.md).
The project-neutral served instruction has one home in `CREWMATE_LOAD_LINE`; it says what to declare and never names this project's test gates.

## The browser command

`infinitary-browser-axi` (`src/core/axi/browserCommands.ts`) turns arguments into the task browser's own operations and prints their answers; every decision stays `TaskBrowsers`'s.
A ref is written as the outline shows it, with or without `@`: `@g1:e5`, `g1:e5` or `[g1:e5]`.

| Command | What it does |
| --- | --- |
| `infinitary-browser-axi` | Home: the page now, with how to use it, or that no browser is open and how to open one; reads a kept answer. |
| `open <url>` | Open a public website over https, a private site the captain allowed, or a page this Mac serves. |
| `open <url> --start <command> --within <seconds>` | The same open of a page this Mac serves, saving the command that starts it and how long it may take to answer, which the host runs when nothing answers there (`docs/task-browser.md`, "Starting a page again"). |
| `back`, `forward`, `reload` | Move the page; a form's answer is never reloaded. |
| `snapshot [@ref] [--from <line>] [--find <words>] [--full]` | Read the page as an outline window, from a line or around words; `--full` shows every line; a ref reads a cut passage in full. |
| `wait <text>` | Wait up to ten seconds for words, then read the part that holds them. |
| `click @ref`, `hover @ref`, `drag @from @to` | Pointer input on a control. |
| `fill @ref <text>` | Put text in a field, replacing what it holds, or choose a list's option of that label; never sends a form. |
| `fillform @ref=<text>...` | Fill up to 50 text fields in order without sending. |
| `upload <path>...` | Give a page that asked for a file one from the task's working copy (`docs/task-browser.md`, "A page that asks for a file"). |
| `press <key> [@ref]` | Press a key on a control or on what has focus. |
| `scroll <up\|down\|top\|bottom> [@ref]` | Scroll the page, or bring an element into view. |
| `screenshot [name] [--uid @ref] [--full-page] [--reason <why>]` | Photograph into the evidence folder; the crewmate opens the file with its read tool. |
| `pages`, `selectpage <n>`, `closepage <n>` | The browser's pages, which is current, and closing a second one. |
| `console`, `network` | The page's bounded diagnostic lists. |
| `withdraw` | Take back a request still waiting for the captain, keeping the browser as it is. |
| `stop` | Stop the browser, or withdraw a request still waiting for the captain. |

It offers nothing that runs script on a page (`eval`, `run`), uploads a file the page did not ask for or one from outside the task's working copy, answers a dialog, emulates a device, profiles (`lighthouse`, `perf`, `heap`), updates itself or installs a hook.
It shows content first, following the captain's ten AXI principles:

1. Its answers are TOON.
2. Pages, console messages and network requests list as rows of three or four fields.
3. An outline shows a bounded window with its size and where it sits, `--full` shows it all, and a ref reads a cut passage.
4. A page answer opens with its aggregates: the page's title, address, ref book, how many controls carry a ref, its place among two pages and the errors it logged since the last answer, then what the command did (`BrowserPageFacts`).
5. An empty list says so (`0 messages`, `0 requests`), and so does a browser that is not open.
6. A refusal prints the browser's own words as an error on stdout, which say what to do instead, with exit 1 (`REFUSED`, `BUSY`); a malformed ask exits 2 before reaching the browser.
7. The crewmate's one prompt line is the session hook, and a wake about its browser names the command for its fresh look, carrying none of the page.
8. The bare command shows the page, not help.
9. Each answer ends with `help`: how to read on, from facts the window knows, and the browser's rules where they apply - the sign-in rule where a page opens, the payment rule and what a purchase review names on the home view and in the help of `click` and `press`, the signed-in rule on every answer from a browser that may show the captain's account, and the document rule on the home view and in the help of `click`: keep a site's one-time letter or receipt by downloading and opening it before other work, never by a screenshot, and report `needs_firstmate` when it is lost (INF-2375) (`BROWSER_RULES`).
10. Every command has its own `--help`, `-v` answers fast, and the home view names the command's path and purpose.

The words a crewmate reads in an answer name the commands, through `browserCommand` (`src/core/browser/commandWords.ts`).
A refusal is typed by `TaskBrowsers`, never read off its words (`BrowserAnswer.refused`).

## The integrations command

`infinitary-integrations-axi` (`src/core/axi/integrationCommands.ts`) reaches the integrations the captain connected (`docs/integrations.md`): discover, then call (the captain's q1 on INF-775).
The bare command lists them with who each is signed in as and its actions, `show <name>` lists one's actions with what each does, its rule and its input's JSON Schema, and `call <name> <action> '<json input>' --reason 'why it is needed'` calls one.
The input is one JSON object, checked before it is sent, and a malformed one exits 2.
Every decision stays `IntegrationsService`'s: a paused integration, an action turned off and an action that asks the captain each print the service's words as an error with exit 1 (`REFUSED`).
For an action at Asks you, a missing reason exits 2 before any card; with a reason, `REFUSED` means the held call has not run yet and the app has raised its own approval card.
The crewmate waits for the existing `write-answered` outcome instead of authoring another card or repeating the call.
A task on this Mac is granted it whenever the host has a command process, and a task on a computer that runs work where the home says it reaches them (`docs/integrations.md`, "On a computer that runs work").
Its kept answers follow the shell's limit as the browser's do.
There, a call waits on this Mac at most until 750 milliseconds before the command process would be stopped, so the command always prints an answer, and a call not yet sent then is never sent.

## The files command

`infinitary-files-axi` (`src/core/axi/fileCommands.ts`) copies a file from another of the captain's computers into the task's hand-over folder (`docs/files.md`).
The bare command names the computers, `ls <computer>:<folder>` lists a folder on one, and `get <computer>:<path>` copies one file and prints its path there.
A missing or extra target, or one with no computer before its path, exits 2 before reaching the app.
Every decision stays the home's `FileRouter`: a refused path, a computer out of reach and a task that is not running each print its words as an error with exit 1 (`REFUSED`).
A copy's help tells the crewmate to read it where it is and never to print, quote or paste its content.
Its kept answers follow the shell's limit as the browser's do, and a later command that finds an earlier copy finished says so before its answer, with the words "this command was not run".
On a computer that runs work, a call waits on this Mac at most until 750 milliseconds before the command process would be stopped, as the integrations command's does.

## The feedback command

`infinitary-feedback-axi` (`src/core/axi/feedbackCommands.ts`) drafts a `/feedback` report for Infinitary's own public project (`docs/feedback.md`).
`diagnostics` prints the typed facts a report carries, `similar <words>` lists the project's matching issues once its words pass the guard, and `draft` reads its body from the file it names, relative to the shell's folder, at most 256 KB, runs the guard and keeps the draft for the captain's click, or answers a filled-in link without a GitHub sign-in.
A missing or malformed flag exits 2 before reaching the app; a guard refusal names each match and its kind with exit 1 (`REFUSED`).
It never sends anything itself.

## Infinitary from your terminal

`infinitary-axi` (`src/core/axi/captainCommands.ts`, door `src/core/axi/commandDoor.ts`; INF-1894 and INF-1895, from INF-1880's and INF-1893's agreed plans) is the one command a person runs rather than a crewmate: Infinitary from any shell of theirs on the first mate's computer, as the captain.
It uses the same launcher, but it enters through the connection's local door (`docs/connection.md`, "The local door"), never the task channel: the launcher reads the door's `address`, `pin` and `key` from `local-door/` in the data folder, `INFINITARY_DATA` or else the release's own (`~/Library/Application Support/infinitary` on a Mac, `$XDG_CONFIG_HOME/infinitary` or `~/.config/infinitary` on Linux), and posts to the door's `/command` path over TLS 1.3 with curl pinned to the door's key, the door's key in a header read from a file only this user can read.
No door files mean the app is closed: it prints `NO_CHANNEL` and exits 1.
A task's shell, which carries `INFINITARY_AXI_KEY`, is refused at once, and the door refuses the crew's programs even with that variable cleared: the command is never for the crew ("Never the crew's" below).
The connection answers the path by the door's key alone, never from a web page, and the door runs each request in a command process of its own as the captain, the actor the window on this computer has (`AxiChannel.person`).
It sends no shell limit, start or id, so no answer is kept for a later command.
The inbox's switch in Settings, Integrations, is the command's: off, every verb is refused with exit 1 and the notes stay (`docs/integrations.md`, "The inbox").

It follows the captain's AXI principles: TOON on stdout, `--json` on every command, three or four fields a row with `--fields` and `--limit` (50 by default), whole counts, `help` lines naming the next commands, exit 0 for an answer, 1 for a refusal and 2 for a malformed ask, and errors on stdout as `error` and `help` lines.
Bare, it shows `bin`, `description`, the open cards, the task lanes' counts, the working tasks, the crew's counts and each provider's allowance, then the next commands.
Its nouns are the window's own reads: `card` (list, show one as plain words with its buttons and questions, its thread), `task` (list by lane, show, search, the crewmate's record), `activity`, `allowance`, `project`, `automation` and `knowledge`.
Its changes are the window's own buttons, as the captain: `say <words>` sends the captain's words to the first mate as from the window's input, with `--card`, `--task` and `--project` naming what they look at and `--file` adding a text file, and answers at once; `--wait` waits up to `--for` seconds (45 by default, at most 50) for the first mate's reply line beside those words and prints it with any card the first mate showed or revised meanwhile.
`card act <id> <button>` presses a card's button, with `--answer name=value` (repeated) answering the body's questions and `anything_else=<words>` the card's own field; `card reply <id> <words>` writes in its thread, and `card close <id>` closes it.
`task steer <key> <words>` and `task interrupt <key>` are the Crewmate tab's, and `task start|stop|continue|drop|queue|unqueue <key>` the record's and the board's buttons; a drop sends what the record's review lists and names the tasks waiting on it or underway.
Nothing to do is an answer with exit 0 that says so: a closed card closed again answers `closed: already`, a stopped task stopped again `stopped: already`, a running one started again `started: already`.
A button the card does not have, an unknown question or a verb the noun does not know exits 2 naming the valid ones; the app's own refusal prints its words with exit 1.
`api` reaches any request of the published contract the command reaches (`docs/contract.json`): `api list` lists them, `api show <channel>` its arguments, and `api <channel> [arg]...` sends one, each argument read as JSON when it parses and else as words (`--string` keeps words, `--input` reads the list from a file); the arguments are checked against the contract before anything is sent, and a refusal names the argument's position with exit 2.
It reaches every core request a view of this computer reaches, not a computer's work, not Secrets, not what only a window asks (`VIEWER_CHANNELS`, `src/core/dispatcher.ts`: a task browser's pictures, and this computer's own window saying it is open or holding work for an update) and not what only the window's program asks (`PROGRAM_ONLY_CHANNELS`, `src/shared/ipc.ts`: the link Join by its address holds there), reads and changes alike.
Each refused request exits 1 with the app's words and is never sent on, and `api list` names none of them.
Every request runs as the command's (`asTheCommand`, `src/core/askedFromTheCommand.ts`), so each event the captain's change writes on a task's timeline carries `through: "command"` (`TaskWriter.addEvent`), and the record's Activity line ends "From infinitary-axi."
(`condenseActivity`): the record and the first mate reading it tell a change from the command from a click in the window.
The three other records the first mate reads keep the same mark (INF-3898's plan, piece 2): a message `say` sends (`captain_asks.through`, stamped by `TaskCapture.openAsk`), a reply in a card's thread (`card_messages.through`, `CardStore.appendMessage`) and the choice that closes a card (`cards.resolved_through`, `CardStore.resolve`) record `command`, and older rows read as unmarked.
The first mate's turn says "from infinitary-axi" beside each: under the captain's own words ("Sent from infinitary-axi."), on a first mate card's choice, and on the context block's card resolution, task click and thread lines, as a panel's click names its panel; its core prompt says the mark is the captain, a script or an agent of theirs, with the window's authority.
The window shows "From infinitary-axi" beside the captain's line in the last turn and under it in a card's thread (the captain's answer); crewmates are not told about the mark.
`watch` prints the pushes the core sends after a cursor, waiting up to `--for` seconds for the next one; the door keeps the latest pushes numbered from a fresh epoch each run, so a cursor from before answers `reloaded`, and `--only` or `--channel` narrow it.
`setup` writes a thin skill, `~/.claude/skills/infinitary-axi/SKILL.md` or under `--dir`, that only points a person's own agents at the command (the captain's pick); `setup --check` exits 1 while it is missing or stale.
The skill stays the person's own: the personal skills a crewmate is given (`personalResources`, `src/core/session/personalResources.ts`) never include `infinitary-axi`, in either skills folder (the captain's answer on its review).
`note "<words>"` and `receipts --after <cursor>` are the inbox's verbs, word for word: a note records one event and answers its id, whether this drop recorded it, and how many rules listen; `--request-id` makes a repeat record once, and `--source` names where it came from.
A request id or source is one word of letters, digits and `._:@/+-`, at most 128; anything else, or a note with no words, is refused with exit 1.
`infinitary-inbox-axi`, its old name, answers the same until the captain retires it, each answer opening with the line `notice: infinitary-inbox-axi is now infinitary-axi; the old name still works`; with `--json` the same words are the answer's `notice` field instead, so the answer still parses (`withRenamedNotice`).
A script written for the old inbox may name the inbox's folder, `<data>/integrations/inbox`, in `INFINITARY_INBOX`; when `INFINITARY_DATA` names no data folder, the launcher takes the one above it.
Each run of the old name keeps when it ran and from which working folder in the inbox's folder (`old-name.json`), and the Infinitary command box in Settings shows that one line, so the captain sees what still runs it before retiring it, and a recorded run raises a card, once per folder, that the next version removes the name (`docs/integrations.md`, "The inbox").

## Never the crew's

`infinitary-axi` acts as the captain, so a crewmate never runs it, and two checks refuse the crew (INF-3901).
The launcher refuses a shell that carries a task's key, `INFINITARY_AXI_KEY`, before it reads the door.
A shell can clear that variable, and every program of the account can read the door's key, so the door checks again from the system's side (`CommandDoor`, `loopbackCaller` in `src/core/placed/loopbackCaller.ts`).
For each request it reads which program holds the other end of the loopback connection, and refuses it when the program is the crew's: `infinitary-axi is for you, never for the crew, and a program Infinitary started asked, so nothing was sent.`, exit 1.
A program is the crew's when Infinitary started it, directly or through programs it started, which covers a crewmate's agent, its shell and anything the shell runs, whatever their environment says: the launcher with the variable cleared, another script that calls it, or a request written by hand.
It is the crew's too when it is in the process group of a shell Infinitary started for a crewmate's command, until that shell's task closes, which covers a program the shell left running with `&` or nohup after the shell ended and its parent became the system's.
Infinitary starts each such shell in a group of its own, numbered after the shell, and keeps that group for its task while the app runs (`ShellGroups` in `src/core/placed/shellGroups.ts`, filled by `JobManager`); a task that closes or is removed is forgotten.
Once that shell has ended, a living program with the group's number leads another group with a reused number, so it is not taken for the shell.
A Claude crewmate's client starts each command's shell in a group of its own too, which the app does not start, so the client is told to run each command through `resources/axi-bin/infinitary-crew-shell` (`CLAUDE_CODE_SHELL_PREFIX`; `docs/claude-client.md`, "A crewmate's shell").
That program tells the task channel its process number with the task's key, then runs the command; the channel keeps the shell's group for the key's task (`claimShellGroup`) only when the program, or the shell that started it as a child, leads that group and Infinitary started that leader, directly or through programs it started, so no program can name another's group; a claim it could not keep is logged.
The app never hears that shell end, so it keeps the shell's birth stamp from the process table: a living leader of the group with another stamp took the number later, and is not the crew's.
On a Mac it finds the connection's owner with lsof, on Linux in `/proc/net/tcp` and the programs' open files, and on Windows in the system's connection table; on each it reads the parents and groups in the process table (`readProcesses`), reading only process numbers.
On Windows a shell's group is a Windows job the app makes for it, since Windows has none: a crewmate's Pi shell leads one from its start, and `infinitary-crew-shell` tells the app its Windows process number, which Git Bash reads from `/proc/$$/winpid`, so the app makes it lead one before it runs a Claude crewmate's command (`docs/heavy-runs.md`, "On Windows").
There `infinitary-crew-shell` runs the command as its child rather than replacing itself, so its number stays its own while the command runs, and a program is in a crew shell's job by the birth the app kept for that job, never by which program holds the leader's number later.
A request whose caller the system could not name is refused too, with help to run the command again.

The account stays the only boundary on the computer (`docs/connection.md`, "Reading the key is the permission"), and a crewmate's shell runs with no sandbox (the captain's decision in `src/core/pi/bashTool.ts`), so the door cannot refuse:

- a program that starts a process group of its own, as setsid and tmux do, once the program that started it has ended;
- a program a crewmate hands to the system to start, such as through launchd or another app;
- a program left running from before the app last started, whose shell's group the app no longer keeps;
- on Windows, a program a shell started when Windows had given the shell a number whose earlier job still held a program, since the app makes no second job under that number (`docs/heavy-runs.md`, "On Windows");
- a program a Claude crewmate's shell left running when the person set their own `CLAUDE_CODE_SHELL_PREFIX`, which the app keeps, or when the program could not tell the app in time, since the command runs either way;
- the local door's connection path, which the window uses and which admits by the door's key alone.

The first two and the last take a deliberate way round.
The other three can happen in ordinary work: a program still running when the app restarted, a Windows number given again while its earlier job still runs, or a Claude crewmate's command on a computer whose own Claude setup names a prefix.
Nothing a crewmate is given points it at the command (`docs/personal-resources.md`), and the door refuses it from a crewmate's own shell, through another script, by hand or with a cleared variable.

## The Secrets foundation command

`infinitary-secrets-axi` uses the same launcher and isolated command process, with no browser dependency.
The optional grant is exercised only with disposable adapters today; the normal app entry supplies no protected owner and production tasks do not receive it.
A local task granted the facade receives `CREWMATE_SECRETS_LINE` from `src/core/secrets/commandWords.ts`, naming discovery, exact requests, withheld values and the separate approval boundary.
A shell without that grant receives no such instruction.
A task on a computer that runs work whose app takes such uses is granted the same facade on that computer's own task channel: `list` and `show` ask the home, and each use is decided by the home's Secrets and run there ([`secrets.md`](secrets.md), "On a computer that runs work").
A task on any other computer is granted the catalog alone and receives `CREWMATE_SECRETS_CATALOG_LINE`: `list` and `show` ask the home, and every use answers `unavailable` ([`secrets.md`](secrets.md), "Current command seam").
Bare invocation and `list` show the metadata of every secret the captain added, `inject` submits an exact operation using references, `ask` asks the captain to keep a secret by name, place and reason, `bring` asks to bring secrets from another tool's command or file into Secrets, which Infinitary runs or reads itself ([`secrets.md`](secrets.md), "Bringing secrets from another tool"), and `status`/`cancel` read or withdraw unused requests, `cancel` also withdrawing a waiting ask or bring by its id.
For `bring`, `reads: "json"` selects explicit top-level string fields, and a trusted command that needs a kept key can name a `uses` mapping of environment variables to references, subject to fresh confirmation.
There is no value-returning getter, approval operation, raw output mode or global environment export.
The channel's task label is organizational context, not authenticated secret authority.
The channel adds the calling shell's working folder to an `inject` request as its working directory, a fact the owner binds, never authority.
The operation boundary, backend requirements and current limitations are owned by [Secrets](../primitives/secrets.md) and [`secrets.md`](secrets.md).

## Tests

`cli.test.ts` holds the runtime: content-first home, flags, help and version without a task, refused updates and literal content.
`browserCommands.test.ts` holds the table: each command's operation and input, every malformed ask refused with exit 2 before reaching the browser, only the approved commands, the page's aggregates before its outline, the rules where they apply, compact rows and empty lists, a picture's path without its bytes, refusals with exit 1, a kept answer's three words and the home view.
`channel.test.ts` runs the real launcher with `sh` and the system's curl against the real channel and the bundled command process: only the browser the key names is reached, the key file is 0600 in a 0700 folder and never in the environment, a forged, missing or revoked key reaches nothing, a request naming another host or carrying an origin is refused even with the task's key, the keys' folder is emptied when a channel opens and closes, refusals and malformed asks keep their exit codes, help and `-v` need no task, and a command past its shell's limit, counted from when the shell started while it can still answer, answers `running`, the next command `BUSY`, and the next look the kept answer, the action sent once.
A click that finishes after that start-counted deadline and before the receipt-counted one answers `running`, a finished kept answer is given even when the later command's deadline has passed, a request that arrives after the limit has run out counts from receipt, and a start after receipt does not extend the limit.
A command whose app is held up from before the channel's deadline until after Pi's limit still answers `running` through Pi's own shell, not as a background job.
`captainCommands.test.ts` runs `infinitary-axi` through the real launcher by `sh` with the system's curl, the local door's pinned TLS, the bundled command process and the whole core: the home view, cards, a task and the contract read as the captain, a card's button pressed by `card act` and by `api` and recorded `through: "command"` with the record's line saying so while a window click is not, a thread reply, a card's choice and a message from the command marked while the window's are not, a missing button exiting 2, a closed card closed again answering `already`, `say` reaching the first mate's last turn, `watch` printing a change after its cursor and answering an old one `reloaded`, a malformed ask exiting 2, `setup` writing and checking its skill, only the door's key admitted and a task's shell refused, a crewmate's shell refused at the door with its task's key cleared and nothing pressed while the person's own shell presses the same button, a program a crewmate's job shell left running with `&` or nohup refused after the shell ended until its task closes, the same from a shell started the way the Claude client starts one with the client's settings a Claude crewmate's session gives it, the switch turning it off, and the old name answering with its notice and keeping `note`.
`shellGroups.test.ts` holds a shell's group as the crew's after the shell ended until its task closes, a group number reused after the shell ended as another group's, and a reused group number as its new shell's alone; for a Claude crewmate's shell, a group kept by its leader's birth stamp, still the crew's after the shell ended and not once another program took the number, the group of a shell that started the program as its child, and none kept for a program the app did not start or one that neither it nor its parent leads a group for.
`jobManager.test.ts` holds Pi's shell telling a command its limit, when that shell started, on the wall clock the channel reads, and carrying the task's shell, and a shell whose task command reached the app waiting past the limit for its answer, at most one limit more, `hostEnv.test.ts` that a child does not inherit `INFINITARY_SHELL_CAP_MS`, `INFINITARY_SHELL_STARTED_MS`, `INFINITARY_SHELL_ID` or the older `FM3000_SHELL_CAP_MS` from the process that started the app, and that extra still sets the Infinitary names, `claudeSession.test.ts` the Claude client's, with the crew shell program as its prefix unless the person set their own, `cardActions.browser.test.ts` that a task on this Mac is granted its browser's command and prompt line where its browser binds and none without one, and `crewActions.test.ts` that the record leaves the command out.
The task browser journeys (`tests/e2e/task-browser*.spec.ts`) drive every browser journey through the command on Pi crewmates, and the booking journeys (`task-browser-booking.spec.ts`) on Claude crewmates too, in the hermetic app; the scripted crewmate reads its answers through one helper (`toolAnswers` and `lookingAgain` in `tests/e2e/browserScript.ts`), which looks again when the channel answered `running` or `BUSY`, and the take journey (`task-browser-handoff.spec.ts`) holds that its wait answered with `running`, its answer came with the next look, and it was run once.
When the shell itself becomes a background job, the helper ends the turn until that job's exit wake supplies its output, ignoring the receipt's partial output and unrelated or repeated job exits rather than running the browser action again.
`tests/mockProvider.test.ts` exercises those answers through the provider's request interface using the shell tool's receipt and the host's rendered exit wake, including a job whose output itself asks for the next look.
`channel.test.ts` also runs `infinitary-integrations-axi`: list, show and call reach only the integrations the task was granted, a refusal exits 1, a malformed input exits 2 before reaching them, and a task without the command is answered `NO_TOOL`.
`placedOutside.test.ts` runs it from a Pi crewmate's shell on a computer that runs work, across the connection to this Mac's integrations (`docs/integrations.md`, "Tests").
`channel.test.ts` also runs `infinitary-files-axi`: the computers, a listing and a copy reach only the task's own files, and a copy past the shell's limit answers `running` and is read with the next look; `placedOutside.test.ts` runs it across the connection in both directions (`docs/files.md`, "Tests").
`tests/release-contract.test.ts` holds the launcher and its identical copies shipped outside the archive.

## The stops command

`infinitary-stops-axi` (`src/core/axi/stopCommands.ts`) registers how to stop each thing a crewmate starts that outlives the command that started it (`docs/leftover-programs.md`).
Every task with a channel on this Mac is granted it, and so is a task on a computer that runs work, where it keeps the stops in the task's folder there.
The bare command lists the task's stops and keeps, `add --label "<what it stops>" '<command that stops it>'` registers one with the shell's working folder, and `drop <id>` drops one the crewmate ran itself, or a keep whose job it removed itself.
`keep --label "<the job>" --check '<command that checks it runs>' '<command that removes it>'` records a job the captain asked to keep running past the close and answers its kept folder (`docs/leftover-programs.md`, "A job the captain asked to keep"); a task run as another user on the home's own computer is refused.
A missing label, check or command, or an id that is not one, exits 2 before reaching the app.
The app runs what is left when the task closes; those four subcommands run nothing.
`left` lists what finished tasks left on this computer (`docs/leftover-programs.md`, "What a close leaves"), with each kept stop's command for the look to judge what it deletes and whether its target is gone, never to show on a card.
`rerun <task> <stop id>` runs one finished task's kept stop again, and `end <task> <pid>` ends one finished task's kept program only while it still has the start time its close kept; a cleanup look uses them for the captain's picks.
`drop <task> <stop id>` removes one finished task's kept stop without running it; a cleanup look uses it on its own for a stop whose target it found already gone.
Both refuse a task that is not finished on this computer, and one already running for the same item.

