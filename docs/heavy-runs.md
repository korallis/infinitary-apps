# Declared heavy runs

The accepted load design (INF-1621 piece 2) puts heavy programs in one admission line on the computer that runs them.
It does not put crewmates in a load queue or change task placement.
The caller judges and declares the entire run's processor and memory needs; the app neither estimates a request nor enforces a running process's use.
`LoadLine` (`src/core/placed/loadLine.ts`) is the one writer of declarations, admission and saved group ownership on each computer.
The home owns its local line and each work computer owns its own line.

## Asking and running

The task's `infinitary-load-axi` command uses the existing task command channel ([AXI commands](axi-commands.md)).
A bare invocation reads only that task's declared runs.
`infinitary-load-axi run --processors <number> --memory-mib <number> -- <program> [arguments]` declares positive processor equivalents and memory in MiB, then waits for admission.
The launcher starts its waiting child in a native process group before asking, and the app verifies that group's live process identity.
The caller's program and arguments stay in that shell, never crossing the task channel.
After fresh admission the group leader becomes a small native supervisor, which creates the payload once in the same group with inherited input, output, error, environment, arguments and working directory.
The supervisor forwards termination and interrupt signals, waits for the payload and returns its exit status; it never stops a payload for load or a missing receipt.
It exports the inherited hold before payload creation; verified nesting execs in that same group without creating another supervisor or changing its startup charge.
A shell asynchronous payload would inherit ignored interrupt handling, so `scripts/load-supervisor.c` owns fork, signal forwarding and waiting instead.
The build compiles this helper for both Mac chips or the current Linux architecture, following the existing native git-launcher pattern, and ships it outside the archive in `load-bin`; Windows builds none ("On Windows").
Disposable native checks use the same compiled helper.
The waiting wrapper prints line facts on standard error, leaving the admitted program's standard output intact.
Short claim requests use the existing two-second cadence and bypass the shell's kept-answer mechanism; the waiting wrapper is itself the shell job.
A command process that cannot start, exits without answering or reaches its deadline answers an admission claim with the typed `CLAIM_UNAVAILABLE` outcome and the same reading cadence.
A transport timeout on a claim carries that outcome too; a first transport timeout has already waited out its bound, and later attempts reuse the last cadence received.
The wrapper keeps the same process group and declaration and asks again, without a limit on how long it can remain queued.
The wrapper waits inside the caller's shell command, so a shell that stops a command after a time limit counts the wait against it.
The served words tell a crewmate to give a heavy run the longest limit its shell allows.
A Pi crewmate's background commands have no time limit.
A Claude crewmate's client counts a command's own limit from its start and stops the whole process tree when it passes, so every Claude coding session raises the longest limit a command may ask for to 3 days ([Claude client](claude-client.md), "The crewmate on Claude").
A lost claim reply may finish on the host later, but neither that reply nor a remembered admission starts the program: the wrapper still requires its own fresh successful admission answer.
Admission recovery applies only before payload creation, never to a payload launch or another command's effects; invalid requests, revoked keys, lost channels and owner refusals still end the waiting wrapper.
If a later process-table reading is unavailable, a previously verified caller with the same task, group and declaration keeps waiting in its existing place instead of treating the missing reading as proof it ended.
The reply grants no execution until a fresh reading verifies the caller, even if capacity has already admitted its saved hold; that reservation remains counted in the meantime.
Any other claim on an unavailable reading, a first claim, a changed declaration or a nested claim, answers a wait with no hold and the reading cadence: the reading proves nothing about the caller, so the wrapper asks again and nothing is held or started until a readable table checks it.
A process-table read can run out its time limit while the computer is busy, such as while simulators boot.
A caller absent from a readable table, and a changed declaration or an unverified nested claim on a readable one, still refuse.

A nested wrapper carries `INFINITARY_LOAD_HOLD` and reuses the outer declaration only when the app verifies the same task and process group.
A nested demand larger than the outer declaration refuses before starting its program.
A disconnected or revoked command cannot start a new program; a living, already admitted group keeps its memory growth reservation and any unconfirmed processor startup charge.
An app restart refuses the old command keys, but restores the reservations of living groups before admitting new work.

## Launch receipts

A launch receipt tells the line which program a running hold started; only a verified receipt lets a complete processor interval end that hold's startup charge ("Capacity and pressure").
On every system a receipt worker with no caller streams sends it, naming only the task-bound hold, the group leader's PID and the payload's PID; the command, arguments and environment stay local.
LoadLine verifies that the named leader is the living one the hold registered, by PID and birth stamp, and that the payload is a living member of its group other than the leader; it rejects exited payloads and saves the launch identity before acknowledging it.
On Mac and Linux the native supervisor starts the worker in its group after creating the payload, and the receipt also carries the payload's birth stamp, which the line compares with its own reading.
Those birth stamps use Linux start ticks or a targeted UTC Mac reading, independent of the payload shell's timezone; existing saved group birth fields keep their original format.
The supervisor retains an exited payload's PID until receipt pursuit stops, preventing reuse during that handoff, and cancels the worker when the payload exits.
On Windows the wrapper starts the worker, the receipt carries no birth stamp, and the worker ends itself with its wrapper ("On Windows").
Repeated exact receipts are idempotent; a different payload, changed identity, ended hold, revoked grant or failed store cannot clear a startup charge.
An interrupted receipt operation returns `RECEIPT_UNAVAILABLE`, separate from `CLAIM_UNAVAILABLE`.
A receipt for a task's running hold that arrives while the process table cannot be read returns the same outcome with the reading cadence: the reading proves nothing about the launch, so nothing is saved and the worker asks again at that cadence.
A receipt the hold itself rules out, one naming its own leader or a launch other than the saved one, is refused even then, since no reading could verify it.
Every refusal is final for that payload identity.
Only that receipt repeats after launch, never admission or payload creation.
The worker stops when the payload exits and cancels its pending transport or cadence wait; an unverified short-lived payload leaves the startup charge while its group remains.
A receipt whose caller's connection closes before its answer stops the app's command process for it at once, and its check saves no launch from then on; any other command runs on without its caller.
Both operations carry stable operation identities and clear the shell cap and shell ID, avoiding unrelated kept answers without changing command or transport bounds.
A timeout is an unknown outcome, not evidence that the host did nothing.

## Capacity and pressure

Admission consumes the existing completed resource sample, not another CPU sampling loop.
The observation's age starts before sampling and must remain within the existing freshness allowance.
Missing or stale readings admit nothing.
The shared `resourceCapacity` owner retains the existing placement margins: 80 percent of observed idle processor capacity, and available memory minus the greater of 512 MiB or 10 percent of installed memory.
With no admitted run, the first waiting request starts when its memory declaration is at most installed memory less that same memory margin, regardless of processor load or today's available memory (INF-1685 and INF-2165, direction A).
It still needs a fresh reading with a memory figure and normal pressure.
A claim that declares more memory than that, read from a fresh reading, can never start, so the line refuses it at once with words naming the most it may declare in MiB, unless a recorded override passes its task (INF-6381).
A waiting run that can never fit, such as one saved before this rule or claimed without a fresh reading, leaves the line at the next fresh reading, and its next claim is refused.
Further requests need 80 percent of whole-computer observed idle processors, minus the full processor declarations of admitted starts not yet covered by a qualifying aggregate interval.
There is no admitted-group CPU add-back or persistent maximum-of-declared-and-measured charge after coverage.
Each admission spends and durably saves its startup declaration before answering, including repeated claims, observation callbacks, timer passes and reconsideration.
The sampler supplies the actual aggregate CPU interval endpoints and sampler lifetime locally, independently of its process window and the callback's request-start time.
An interval must begin strictly after the host verifies launch; a larger sample number, a reused endpoint or a process-window duration is not sufficient.
Duplicate, out-of-order or retired-lifetime intervals cannot advance coverage or refresh capacity.
A new sampler lifetime requires new coverage; missing per-group CPU counters alone do not defeat trustworthy aggregate readings.
Until coverage the full startup declaration remains, even when aggregate use already includes some startup work.
A covered living group still counts as admitted for the no-admitted-run exception.
Later processor bursts may slow running work; admission neither predicts them nor stops existing work.
Memory counts each admitted run once (INF-2165).
The available-memory reading already lacks a running group's resident memory, so the line adds that measured resident memory back to the headroom and then reserves the larger of the run's declared and resident memory.
Resident memory comes from the same process-table reading and needs no processor window.
A run with no measured memory reserves its declaration with nothing added back.
This is admission accounting, not a prediction or a promise of physical isolation.
Runs start in arrival order, with one bounded exception (INF-6381, the captain's 10 minutes).
While the run first in line does not fit, a later run that fits the measured room beside the running runs may start ahead of it, during the first `PASSING_WINDOW_MS` (10 minutes) after that run became first in line.
After the window nothing passes until the first in line starts, so it waits at most the window plus the passing runs' lengths.
A passing run never starts through the no-admitted-run exception, which belongs to the first in line.
The window lives in memory: a run first in line restored after a restart counts as past its window, so a restart never lengthens its wait.
A macOS warning or critical pressure reading suspends new admissions, passing ones included; normal pressure and fresh capacity allow the same line to advance.
The existing resource-pressure Activity and first-mate wake remain the only pressure notices.
Each memory warning is one thing with an ID: memory, the computer, and when the warning began on the home's clock (`memory-warning:<computer or home>:<began, ms>`).
A warning begins at the first fresh warning or critical reading on a computer with no open warning; the home then writes one Activity line and queues one first-mate wake whose once-name is the ID (`src/core/placed/resourcePressure.ts`).
While it is open, later readings tell nothing: not a newly seen task, not new process use, not a newly recorded close report, not byte counts, not a flip to normal and back, not a restart.
The one exception is the first critical reading in it, which writes one more line and queues one more wake under the same ID (`<id>:critical`).
A warning ends when the computer reads normal after 30 minutes without a warning or critical reading, the captain's number; the check runs on each reading, and missing or stale readings never count as normal.
Its end queues one first-mate wake that asks for no card (`memory-warning-ended`, once-name `memory-clear:<computer or home>:<began, ms>`) and writes one Activity line without the warning tone.
A line is written only when its wake was queued, so a restart cannot repeat one.
Open warnings and their ends are read back from the inbox's once-names after a restart, and an open warning's quiet stretch starts again at the restart, since not knowing is not recovery.
The line names unresolved leftovers recorded at finished tasks' closes on that computer, when present, with current use explicitly unknown; otherwise it names the largest measured open-task share or the programs not linked to open tasks.
The wake keeps every measured task share separate from the recorded close outcomes.
It also carries what finished tasks left on that computer, when the list names anything (`docs/leftover-programs.md`, "What a close leaves").
When a finished task's run still counts as running in a computer's line while another run waits there, the first mate hears it once for that run (`line-blocked`, `LineBlocked` in `src/core/placed/leftBehindNotices.ts`), with the same list; this reads the line facts the resource feed already carries and stops nothing.
It tells only once that computer's own list names the run, which it does only after the task's close has finished its own cleanup there; a list that cannot be read, or a computer without the list, tells nothing.
No pressure change kills, pauses, slows or moves a running program.
With Computer cleanup enabled, on either notice the first mate offers a read-only cleanup look on the reporting computer before spending the captain’s plan’s allowance, and starts it only on yes.
The runbook owns that procedure, not the pressure wake: disabling it withdraws the offer guidance and the skill for new looks, without cancelling running conversations or suppressing the pressure facts.
It offers at most one card per warning ID and reuses an open offer or look there; after an answer, a new offer needs a new warning ID, and a warning's end takes down an offer nobody answered.
The no-project look follows the bundled `computer-cleanup` skill: measured ownership, one card of finished-task leftovers and unowned programs with stopping costs, and only explicit picks stopped after identity checks.
Open tasks and CI are named, never offered; unowned programs are never recommended.
Recorded close outcomes are leads, never proof of current liveness, ownership or memory use.
The registered soft hold `load-line` passes only through the existing recorded captain override; the command has no bypass flag.

## A whole group's lifetime

A reservation belongs to the whole process group, not the requesting HTTP connection, model turn or group leader.
The app checks group existence without sending a terminating or scheduling signal.
A completed process-table reading also detects an ended group or a reused group identifier with a different birth stamp.
The line releases a declaration only after the registered group ends.
A descendant that survives its leader therefore keeps its hold and explicit task attribution, including after an app restart.
The group leader is the supervisor that ran the admitted program, so a readable process table without that leader, or with it exited, means the program has ended (INF-2570).
From then on the hold reserves nothing beyond what its surviving processes measurably use, which the reading already includes: no processor startup charge, no declared memory, and it no longer counts as an admitted run for the lone-run exception.
Until the first reading after a restart, a restored hold keeps its full declaration.

A waiting run whose caller has gone leaves the line (INF-2570).
At its first claim the line records the waiting wrapper's parent process and birth stamp, unless that parent is the system's first process.
When a readable table shows that parent ended, changed birth stamp, or the wrapper now has another parent, the line removes the waiting hold and refuses that wrapper's next claim, which ends it.
A running group keeps its hold whatever becomes of its caller, and a hold saved without a caller learns it from the next claim of a wrapper whose parent is still alive.
`ProcessRoots` registers group ownership separately from process roots, so an unrelated process that reuses the departed leader's PID cannot inherit its task attribution.

The line persists only the task id, request id, declaration, group id, birth stamp, waiting/running state, optional verified payload identity and optional caller identity in its own `load/holds.json`, under the home or work data folder.
It writes before answering admission and refuses admissions when its saved state cannot be read or written.
A failed declaration store leaves independent measured Use available and marks last-known declarations unavailable, never ended.
It stores no command, arguments, environment or credentials.
Legacy holds without verified launch evidence keep their processor declarations until the group ends.
Restored verified launches retain their startup charge until a current-lifetime interval covers the restart boundary; saved monotonic times are never compared across restarts.
Older code ignores the additive launch field and restores the full declaration conservatively.
Disposal ends observation, not running work, and leaves the saved reservations for restart reconciliation.

Processes that escape the group, including work a system service starts, cannot be contained or attributed by a process-group reservation.
The caller includes that work's needs in its declaration and keeps the wrapped run alive until it finishes.
This project's local virtual Macs borrow a virtual place through `borrow-virtual-mac` instead (`docs/testing.md`, "A virtual Mac as a runner").
Their phone and journey gates reuse `BORROWED_PLACE` and do not ask this load line; the virtual Mac appears here only as measured load.
Programs that never declare a run stay visible through measured resource use; the app does not pretend to contain them.

## On Windows

Windows has no process groups, so the app makes a named Windows job object stand in for each one (`WindowsJobs` in `src/core/placed/windowsProcesses.ts`).
The launcher runs under Git Bash, which numbers its programs itself, so it reads its Windows process number from `/proc/$$/winpid` and claims with that.
At the first claim the app makes the waiting wrapper lead a job of its own, named after the wrapper's number and birth stamp, and puts in it the programs the wrapper already started.
No program in the job may leave it, because Git Bash's programs leave every job that allows it, so a program the payload starts stays in it after its parent ends.
A program's group in the process table is the leader of the smallest job the app keeps that lists it, and 0 when none does.
A job is alive while it lists a living program; after a restart the app reopens a saved hold's job by its name, and one it cannot open has ended.
A crewmate's Pi shell starts detached, outside the job the app's process library puts its other children in, which would end every program in it when the app exits, so a run and a program a command left running outlive the app as they do on a Mac.
After admission the wrapper runs the payload as its foreground child and exits with its status, with no native supervisor.
It does not exec it: Git Bash's exec of one of its own programs, such as a script, ends the leader's Windows process, which the app reads as the run's end, so the leader lives exactly as long as the payload.
Just before the payload the wrapper starts the receipt worker with none of the caller's streams, from a subshell that ends at once, so the worker is no job of the leader's shell.
A shell builtin run as the payload shares that shell, and its `wait`, `kill` and `$!` meet only the jobs it started itself.
The worker finds the payload as the wrapper's child and sends its Windows number from `/proc/<pid>/winpid`, with no birth stamp, which Git Bash cannot read.
Git Bash starts a program as a copy of the wrapper, under a Windows number the program then leaves, so the worker passes over a child that still shows the wrapper's whole argument list.
A program's own list is only the end of that list, so it is never mistaken for the copy, whatever words of the wrapper's its arguments repeat.
The app takes a receipt with no birth stamp only where a run's group is a Windows job: it checks that the named program is a living member of the hold's job other than its leader, and saves the birth stamp from that same reading as the launch identity.
From then on a Windows run's processor charge ends as it does on Mac and Linux, at the first complete interval that began after the verified launch ("Capacity and pressure").
A program that replaces itself takes another number, so after a refusal the worker sends again only when the number changed, five times at most.
A shell builtin that starts no program gets no receipt, so its run keeps its startup charge while its group remains.
Nothing signals the worker, since Git Bash gives an ended program's number to a later one.
The worker reads each second whether its wrapper's Git Bash number still names the wrapper's Windows number, and ends within about a second of the wrapper, cancelling its pending request or cadence wait.
That holds whether the payload ended, the run was stopped, or the wrapper was ended by force while its payload runs on.
Windows may give an ended leader's number to a new program while its job still holds one; the app then keeps that job as the number's group and makes no new job under it, so the new program leads none.
The process table, birth stamps (`win:` and the creation time in 100-nanosecond ticks), processor time and resident memory come from the system itself, never from a program the app starts.
Windows keeps a program's parent number after the parent ends and may give that number to a newer program, so a parent missing from the table or born after its child reads as no parent.
The leader is started by an exec that Git Bash makes a new Windows program, so it reads as having no parent; the wrapper names its caller instead, the outer wrapper's Windows number from `/proc/$PPID/winpid`, as `claim --caller`.
The app takes a named caller only for a leader with no parent it can read, records it with its birth stamp, and takes the waiting run out of the line when that program ends, as it does on Mac and Linux.

## The journal

Beside its saved holds the line appends one JSON line per event to `load/journal.jsonl`, with the wall-clock time, task id, hold and declaration.
It records a run joining the line and how many runs wait ahead of it, each admission with the capacity it compared against and its basis (measured capacity, installed memory for a lone run, or a recorded override) and, for a run that passed the first in line, that run's hold, a blocked front with that capacity or a null capacity and the pressure level, a program that exited with its leftovers' resident memory, each release and why, and each refused claim and its words.
A blocked front is written when the front or its reason changes, not on every two-second pass.
The file keeps its newest lines within `JOURNAL_MAX_BYTES`; the oldest half drops.
The journal is a record for reading later: a failed write never changes admission, and the saved holds stay the truth.
It stores no command, arguments, environment, process identity or credentials.

## What the task shows

The task record keeps measured Use unchanged and adds a separate Run row for its declared runs.
Waiting says which computer, why it is waiting, and the declared processor and memory amounts.
A run behind others says how many runs wait ahead of it; running runs are not counted.
The run first in line, when it waits for room, says how many processors and how much memory are free, from the room the line last compared it with (`free` on the run); the waiting wrapper prints the same room to the crewmate.
Running shows the same declaration with its admitted state; it never calls that declaration measured use.
A lost connection preserves explicitly unavailable last-known run state instead of implying the run ended.
The row adds no control or task status.
Living declarations count as background work for the existing task witness, even after the requesting shell exits; a remote declaration must still have fresh contact.

The optional load facts ride the existing computer-resource view and its two-second feed.
The authenticated `inf:computer:load` order carries only already-recorded overrides and returns line facts, never process identities or commands.
The home reads standing overrides through `TaskService.passingOverridesForComputer`, seeking only non-null permission overrides and joining their execution computer and evidence head by task id, without composing task records.
Closed tasks remain eligible because a declared process group can survive its task closing; `overridePasses` retains the recorded hold and version scope.
Every computer that takes work runs the home's contract major, so the home asks each one for its load and grants it the load capability.
The iPhone and iPad app retains its existing surface and ignores these optional facts.

## Checks

`src/core/placed/loadLine.integration.test.ts` runs real native wrappers through the task channel with a recorded ordinary-use Mac reading and explicitly supplied pressure states.
It exercises queue order, a fitting run passing a blocked first in line only during its window, the room the first in line prints, a run too big for its computer refused at once, unchanged streams and exit status, pressure admission, unknown and stale readings, interrupted claim commands retaining their identity and hold, revoked waiters, surviving descendants, restart restoration, failed state writes, nested demands and recorded overrides.
`src/core/axi/channel.test.ts` checks the launcher's transport-timeout classification and that an interrupted non-load action remains terminal rather than gaining retry permission.
`src/core/placed/loadLine.test.ts` covers an exited program's reservation dropping to its leftovers' use, a waiter whose caller ended leaving the line, the journal's entries and size, a run too big for its computer refused and released, the passing window and its bound under a stream of small runs, what "ahead" counts, a Windows receipt stamped from the line's own reading, refused outside the run's job and refused where groups are not Windows jobs, a receipt asked again while the process table cannot be read, and one the hold itself rules out refused for good on such a table.
`src/core/placed/processResources.test.ts` exercises declared-group attribution, PID reuse and explicit nested roots using recorded process metadata.
`src/core/placed/windowsProcesses.integration.test.ts` runs only on Windows: it reads the real process table, connection table and working folders, keeps a job's programs after its leader ends, runs a heavy run through the real launcher under Git Bash to its exit status, verifies its launch as the program's own Windows number and starts a later run after a covering interval while the first still runs, sends no receipt for a slow copy of the wrapper before it becomes the program, whose arguments repeat the wrapper's words, repeats at the reading cadence a receipt that met an unreadable table, ends a builtin's `wait` with its own job and leaves a job a builtin started running, each while the run's receipt is unanswered, ends the worker and the app's command for its receipt with a wrapper stopped by force while its program runs on, and passes a short run's streams and status through with nothing of it left behind.
This project's own local phone gate and journey runs declare their runs through this command (`docs/testing.md`, "A local heavy run's place").
