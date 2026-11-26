# Windows

Infinitary on Windows is one unsigned installer for x64 PCs, built and checked by `.github/workflows/windows.yml`.
Every alpha and every stable publishes it, unsigned: an alpha as an early build for testers, a stable as an experimental download ("Published on every release" below); nothing signs it yet.
The installed app updates itself in one click from the installer its channel's release carries, checked against the published SHA-256 (`docs/alpha.md`, "Updates on Windows"); a channel whose release carries no Windows installer offers no update.
Windows on Arm and signing are later pieces of the Windows plan.
The earlier hosted investigation and what it observed are `docs/windows-feasibility.md`.

## What is built

`electron-builder.win.yml` extends the shared `electron-builder.yml` and builds one NSIS installer, `Infinitary-<version>-windows-x64-setup.exe`.
It keeps only Windows x64's own native code: the speech library, koffi's addon, the SQLite build and the terminal helper.
Native modules are not rebuilt, as on Linux: better-sqlite3 carries a Node-API build for Windows x64 that Electron loads as it is.
The load supervisor (`scripts/load-supervisor.c`) is a POSIX program, so a Windows build skips it and the installer ships no `load-bin`.
The installer and the program carry the committed `packaging/build/icon.ico`, rendered from the same picture as the Mac and Linux icons (`scripts/render-app-ico.mjs`); electron-builder ships it unchanged, so the build runs no icon tool of its own.
The task commands (`resources/axi-bin/`) are POSIX shell scripts that talk to the app over loopback with curl, so they run in Git Bash unchanged.

## The installer

The installer is one click for one person: it asks no question and never asks for administrator rights (`requestedExecutionLevel: asInvoker`, `perMachine: false`).
It installs under `%LOCALAPPDATA%\Programs`, registers its removal for this person in Windows Settings, and puts an `Infinitary` entry in the person's Start menu, with no desktop shortcut.
The Start menu entry carries the app's identity (its AppUserModelID), `appId` from `electron-builder.yml`; the app sets the same one at start (`src/main/windowsStartup.ts`), so Windows files its windows and notifications as Infinitary's.
A run from source takes the development flavor's identity, with `.dev` after it, so it never stands in for the installed app.
At its end the installer opens the app through that Start menu entry (electron-builder's `runAfterFinish`, a shell open of the shortcut), so Explorer starts the app as the Start menu does, never the installer.
Removing Infinitary in Windows Settings keeps the saved work: `deleteAppDataOnUninstall` is false, so tasks, settings and sign-ins stay in `%APPDATA%\infinitary` for a later install.
Nothing the app does afterwards needs administrator rights either: every link the app makes to a folder is a junction, which a standard account may make, where a folder symlink would need Developer Mode (`folderLinkType` in `src/core/platform.ts`).
The projects folder links an adopted project that way (`src/core/workspace/repoRegistry.ts`), and so does a Claude crewmate's staged skills: its working copy's, its personal ones and the runbooks' (`src/core/claude/claudeProjectResources.ts`).
The inbox's one-click link for `infinitary-axi` goes into `/usr/local/bin`, a folder Windows does not have, so Settings offers no link there and shows the command's full path.

## Git for Windows

Windows ships neither Git nor a bash, and the app needs both: Git keeps each task's work apart, and a crewmate's commands run in Git Bash.
Before its window opens, the installed app looks for a suitable Git for Windows (`src/core/windowsGit.ts`): a folder holding both `cmd\git.exe` and `bin\bash.exe` whose git answers `--version`.
It looks in Git for Windows' Program Files folders, then in its install for one person, `%LOCALAPPDATA%\Programs\Git`, then in the install each `git.exe` on the search path belongs to.
The app uses the first one it finds: its children find that `git` on their search path (`src/core/hostEnv.ts`), and Pi runs commands in its Git Bash (`src/core/pi/windowsBash.ts`).
Nothing changes the PC's own search path or Git settings.

With no suitable Git, the app asks once in a system dialog whether to install Git for Windows (`src/main/windowsGitSetup.ts`), with Install Git for Windows and Quit.
On the person's yes it downloads the pinned release, `GIT_FOR_WINDOWS` in `src/core/windowsGit.ts`, from Git for Windows' own GitHub releases.
Before running it, the app checks the download's SHA-256 against the pinned one and reads its Authenticode signature through Windows PowerShell: the signature must be valid and name Git for Windows' publisher.
It runs the installer for this person alone (`/CURRENTUSER`), silently but with its own progress window, then checks that the installed git answers the pinned version.
A failed step says what failed, installs nothing further, and offers to try again or quit.
A run of the app with no window (`docs/run.md`) has nobody to ask, so it ends with the reason, and a run from source keeps Pi's own lookup.
Moving to a newer Git for Windows changes the version, file, address, SHA-256 and size together, each read from the release's own page.

## Joining another computer

Infinitary at its first launch on a Windows PC joins a first mate on a Mac, a Linux computer or another Windows PC by a pasted link or by that computer's address (`docs/view.md`, "Joining"), and both controls it and runs its work, as a Mac that joined by its window does (`systemRunsWork` in `src/shared/devices.ts`).
Its work runs while its person is signed in to Windows, started by their own Task Scheduler with no administrator (`docs/helper.md`, "In the background").
A second Windows account on a Windows home runs that home's work too, by a line for PowerShell (`docs/devices.md`, "Joining by a command").
Its home sends it no update, so its row on Settings -> Devices says to install the newer Infinitary on that PC.
Its window names a newer version of its own copy and installs nothing, since the installer would end the work it runs mid-run (`docs/alpha.md`, "Updates on Windows").
It says who it is by its user's security identifier, which Windows' own `whoami` reads, since a Windows user has no number (`docs/devices.md`, "Joining").
Windows refuses to replace a file another program holds open, as one may the moment the file appears, so a join that knows the home's name already, as the window's work setup does, puts the grant the PC keeps (`home.json`) in place with that name in one write (`JoinedHome.join`, `src/core/devices/joinedHome.ts`), and a join keeps the home's name and where the PC runs, heard in its one welcome, in one write too (`JoinedHome.heard`).
A command's join still puts the grant in place, or a changed address on it, before its dial hears the home, and a run keeps the addresses, the name and where it runs from one welcome each in a write of its own, so each of those writes can still meet a program holding the file.
It finds its home again through Windows' own network browsing, made through Windows PowerShell (`src/core/devices/windowsDnsSd.ts`), and joins by an address with Windows' own SSH (`ssh.exe`), by the person's key alone.
A Windows home reads Windows Defender Firewall's policy and, where it keeps devices out, Settings -> Devices shows the one line to run in PowerShell as an administrator (`docs/devices.md`, "A home's firewall").

## Automatic on a Windows home

A project that lives somewhere else, such as on GitHub, runs on Automatic by default (`docs/helper.md`, "Automatic starts"), so its tasks start once the PC passes Automatic's checks.
The PC answers them as a Mac or a Linux computer does, in Windows' own way.

- Its system is Windows, which a task inherits when its project declares none, as on a Mac (`resolvePlacementRequirements`, `src/core/routing/placementEngine.ts`).
- A program counts when a folder on the search path holds it under one of the endings Windows runs programs by (`PATHEXT`), so Git is `git.exe` in the chosen Git for Windows' `cmd` folder (`programFiles`, `src/core/userBin.ts`).
- Its physical computer is its hashed `MachineGuid`, which Windows writes at install and every account reads without an administrator (`physicalComputerId`, `src/core/placed/placementFacts.ts`).
- Its memory reading is Electron's, whose free memory on Windows is the available physical memory: free, zeroed and standby pages, the same estimate as Linux's `MemAvailable` (`electronMemoryReading`, `src/main/host/resourceMemory.ts`).
  The reading leaves swap out, since Electron's swap figures there are the page file's commit limit, not swap in use.

A Windows PC that runs work for a home answers the same checks the same way, naming Windows as its system (`workSystemSchema`, `src/shared/placement.ts`), so a Windows home's Automatic starts a task on another Windows PC when this one cannot run it.
A Mac or Linux home's tasks inherit its own system, so its Automatic leaves a Windows PC out, and Runs on still starts a project's tasks there (`docs/helper.md`, "Runs on").
The set of systems a project may declare, which views read, has no word for Windows (`placementSystemSchema`), so a project cannot declare it, and a task's saved start leaves its systems out and names Windows on each computer's own row (`publishedSystems`).
Adding Windows to that set is a major change to the published contract that breaks views.

## Secrets

Secrets work on Windows as on a Mac or Linux computer (`docs/secrets.md`): the installed app on the person's own data folder offers Settings -> Secrets and the crew's `infinitary-secrets-axi`.
The root and the rules' head live in Windows Credential Manager, for this person on this PC alone, under `Infinitary Secrets/root` and `Infinitary Secrets/authority-head`, which Credential Manager lists under Windows Credentials.
Each allow is confirmed with Windows Hello, or with the person's Windows password where Hello is off.
A crewmate's approved program runs as an `.exe` in place, or as a script whose `#!` line names Git Bash's own `sh` or `bash` or a program on the search path.

## Keeping a copy, moving and taking over

A Windows PC that runs a home's work keeps a copy of the first mate's record, as a Mac or Linux computer does (`docs/devices.md`, "Keeping a copy on another computer"), and a Windows home sends its copies the same way.
Windows refuses to rename or remove a folder that holds an open file, so the copy closes every file it read before it puts a newer full copy in place (`docs/devices.md`, "On the computer that keeps it").
The first mate moves to a Windows PC, or away from a Windows home, as between Macs (`docs/devices.md`, "Moving the first mate"); on the PC it starts through the person's own Task Scheduler, as its work does (`docs/helper.md`, "In the background").
The computer it arrives on reads the old home's folder locations by the rules of the system that wrote them, so a location inside the old data folder or a project names its place on the new home written that computer's way, from Windows to a Mac and from a Mac to Windows (`docs/devices.md`, "A home on another system").
A Windows PC that keeps a copy offers Take over while the home is out of reach, confirmed with Windows Hello, or with the person's Windows password where Hello is off (`docs/devices.md`, "Taking over").

## The checks

`windows.yml` has two jobs, and a third on request ("The update check" below).
`build` runs on GitHub's hosted `windows-2025`: the unsigned installer reads no secret, and a public project's hosted minutes cost nothing, so the PC's cores stay for the fresh Windows 11 check.
Setting `vars.WINDOWS_RUNNER` to a place of the project's own, a fresh standard account on the PC removed when the job ends, pins the build back there; `hosted` always takes the hosted machine.
It installs, builds and packages the installer, and keeps it on the run with its `SHA256SUMS` as the `windows-installer` artifact, and hands its line of `SHA256SUMS` to a calling workflow as the `sums` output; only a release's upload job publishes it.
Both jobs first unpack Git for Windows' portable build, pinned by its SHA-256, and put it first on their own steps' search path, so the job's bash, git and curl are that release's: the places' own Git 2.45.2 has a curl that refuses a plain download (exit 43), and the fresh machine has no Git.
Each job's checkout then waits while GitHub refuses the job's token and checks out once more, as every checkout a release reaches does (`docs/testing.md`, "GitHub refusing a job's token"); the wait runs in that Git Bash, in the PowerShell job too.
The project's composite actions are bash, which that Git Bash runs; the pnpm action writes a `.cmd` shim beside each sh one on Windows, so PowerShell steps find `pnpm` too.
Each job takes those actions, and the Electron zip reader the build runs, from a sparse checkout of the workflow's own commit in `.release-tooling`, and runs them against the source: a stable's source is its alpha's commit, which may predate an action the workflow uses (`tests/release-workflows-windows-actions.test.ts`).

A request names how many rounds it wants (`rounds`, default 1, a whole number of at least 1).
The `build` job builds the installer once and lists the rounds; `check` is a matrix of one job for each round, so every round installs that one installer on its own fresh machine, side by side, and a failed round never cancels the others.
With more than one round each job's name ends `; round N of M` and each round keeps its evidence as `windows-evidence-round-N`; a batch and an alpha run one round, whose name and batch-stop group are unchanged.

`check` runs on a fresh Windows 11 virtual machine for each check (`vars.WINDOWS_CLEAN_RUNNER`, default `shell-pc-win11`), the captain's pick on the Windows plan.
The machine must have a standard person signed in at its desktop with Explorer running, no Git installed, and a runner that runs as that person; it is removed when the job ends.
The portable Git sits in the job's temporary folder and on its own steps' search path only, so the app, opened through Explorer, never sees it.
Its PowerShell steps run in Windows PowerShell 5.1, the one Windows ships, since the machine has no PowerShell 7.
The machine has no Python or compiler either, so the job installs the project's packages without their build scripts and compiles only the message catalogs the journey reads; the journey runs the installed app, never a build of its own.
The job checks the installer against the `sums` line the build job reported, not only the artifact's own `SHA256SUMS`, refuses an artifact holding any other file, runs that one checked file by its full path silently as a double-click does (`/S --force-run`), and runs `tests/windows/installed-windows.spec.ts` with `playwright.windows.config.ts`.
The job's git never asks for a sign-in, since a prompt on the machine's desktop waits for a press nobody makes, and the journey's config keeps Playwright from reading git, which on a batch's pull request run would fetch the base commit without credentials.
The job uploads its evidence even when its timeout cancels it.
That journey checks, in order:

1. The install is for this person alone, under `%LOCALAPPDATA%\Programs`, and the Start menu entry carries the release's identity.
2. The app opened after install with Explorer as its parent, as the Start menu opens it.
3. The Git for Windows offer is up; the journey presses its install button through Windows' accessibility tree, and the pinned Git installs for this person and the app's saved data appears.
   That first window started no command, since a run could not have found Git then.
   Opened again from the Start menu, the window starts the command with no window through this person's Task Scheduler (`docs/run.md`, "On Windows"): the run's task runs `Infinitary.exe run --agent <label>` as this person in their session, its sign-in trigger off, and closing the window leaves that run going until a stop asked through the data folder ends it.
   `Infinitary.exe start-at-boot` then turns the task's sign-in trigger on and starts it, and `start-at-boot --off` takes the task away; Task Scheduler's own answer for that task, which a refused removal reads, is there before and not found after.
4. Launched again with the mock provider and the `tests/windows/windowsCrew.ts` scenario, the app adds a small Node project whose origin is a bare copy elsewhere on the PC, so it runs on Automatic.
   Its task starts on the PC with none of Automatic's checks refusing it, the task's activity says Automatic chose this computer, and the PC's own reading is fresh with a memory figure.
   Its crewmate runs `git status`, `pnpm install`, one test file, a build and a task command in that Git's Git Bash, each step printing its mark only when it succeeded.
   The crewmate then starts a background job whose program starts a child; cancelling the task ends both.
   During the data-folder takeover check, the journey brings the app forward with one desktop click on its drag strip if needed and verifies foreground ownership before pressing Ctrl+Q.
   The input evidence distinguishes a missing or lost window from failure to bring an existing window forward; the journey still checks that the app exits without starting anything else.
5. The installed app joins a home on the PC's loopback with the line Devices shows another Windows user, run in a PowerShell console window, the home standing in another Windows account's Infinitary.
   The journey types the yes into that console's input as a keyboard does, and reads the question and the answer from its screen.
   The same line run against a home whose own account is this one is refused with the words for the user Infinitary already runs as, and nothing joins.
   The work's task in this person's Task Scheduler runs `Infinitary.exe work run` in their session and starts it again a minute after any end; the run reaches the home, and the work folder lets in this person alone.
   The home sends the run a full copy of a small record and then a newer one, and the run puts each in place with the newer file's content and no old copy left beside it.
   The journey ends the run as a crash would, and the task's next minute starts it again and it reaches the home again, with its copy as it was.
   When the home removes it, the run forgets the home and takes its task away.
   The window, opened on the person's own data folder, then joins such a home by its pasted link and sets up the same task, which reaches the home and leaves when the home removes it.
   The window then joins a home by its address with Windows' own `ssh.exe` and `ssh-keyscan.exe` (`tests/windows/loopbackSshd.ts`): the server is Win32-OpenSSH's `sshd.exe` from its release zip, pinned by its SHA-256 in `windows.yml`, run in the foreground as this person on the loopback, by key alone, handing each command to the job's Git Bash as a Mac's or Linux computer's shell would run it.
   A port nobody answers is refused as SSH off; the check line names the server's own key, read by `ssh.exe` since `ssh-keyscan.exe` stops at the key exchange that server picks; after the yes, `ssh.exe` signs in with the person's own key, the home's door answers a one-use link, and the window joins and sets up the same task.
   The PC's first mate offers no add by address, since Windows' own ssh keeps no control connection.
   A run asked with `home_link`, a one-use link from a throwaway home on another computer, also has the window join that home over the network, run its work until that home removes the PC, and end it.
6. The removal entry's own command removes the app silently, as Settings does: the program, its removal entry and its Start menu entry are gone, and `%APPDATA%\infinitary` still holds the saved data.

Its pictures and readings go to the `windows-evidence` artifact.
The check runs on every alpha and stable (`release.yml`'s `windows` job, which the release's upload and publish wait on, so a failed check holds the whole release) and on each combined batch that touches Windows-relevant files (`batch-checks.yml`'s `windows` job, which the batch's last job waits on).
`scripts/windows-paths.ts` decides the batch's run from its changed files: the Windows check's own files always count - its workflow and the composite actions it uses, its installer config, the script itself, and its journey's config and every test file the journey reaches by its imports, all read from the checkout - and otherwise any file the build reads counts unless it only makes the Mac or Linux packages, is under `.github/`, or is one of the pull request check's light paths (tests, docs, release notes, phone-only files, the docs site).
The shared font notice is a desktop input, not a phone-only file; see [What a pull request runs](testing.md#what-a-pull-request-runs).
An unreadable change runs the check.
It also runs on request (`workflow_dispatch`).
An outside contributor's pull request that reaches Windows-relevant files builds the installer on GitHub's hosted `windows-2025` instead and skips this check, which waits for the next alpha's release check (`contributors.yml`; `docs/public-ci.md`, "Outside contributors").

## Published on every release

A release's installer packages the release notes job's verified catalog and its hero pictures, never the development placeholder `pnpm build` leaves, and `build` runs `verify-package` on the packaged catalog before it keeps the installer (`docs/release-notes.md`), so the installed app's update note lists what changed.
An alpha or a stable publishes the installer its own Windows check built, installed and ran, and no other: `release.yml`'s upload job downloads the `windows-installer` artifact and refuses it unless its bytes match the `sums` line the windows job handed over.
It goes beside the release's other downloads, under the same rules: on the release record and on Cloudflare under `releases/v<version>/`, each with a `.sha256` sidecar, never on a Homebrew tap.
A retry keeps an installer a place already holds only when its bytes are the ones this run's Windows check built and checked; any other copy stops the release before anything is written, the record's zip included, so testers only ever get checked bytes.
The publication job fetches it back from the record and, without a credential, from Cloudflare, and checks each copy against the upload job's list before any feed moves.
The builds file then names it at `channels.<channel>.systems.windows.x64.exe` for each channel the release moves ("Builds by system and chip" in `docs/alpha.md`), and the feed writer runs the app's own builds reader on the next file before the feed switches, so a Windows entry can never make an installed copy refuse the whole file.
Both the Cloudflare upload and the feed writer are the workflow's own copies, never the release source's, so an alpha cut from an older commit, or a stable built from its alpha's commit, publishes and names its installer too; the download origin they use is still the release source's, the one the fetch-back reads.
A live alpha refuses to publish when download storage is not configured, since storage is the only place testers can download the installer; a live stable without it keeps publishing Homebrew and Linux, puts the installer on the release record alone and names it in no builds file, and its run says so.
A rehearsal checks and lists the installer and writes it into its rehearsed builds file, and publishes no release download; like any rehearsal it still keeps its run's artifacts and sends the Mac app and disk image to Apple for notarization.
A stable promotion builds its own installer at the stable version from the alpha's commit; when it hands its version to alpha, alpha's entry names that installer too.
The alpha's release notes call it an unsigned early build; the stable's call it an experimental build, not yet signed with a certificate Microsoft verifies; both say Windows warns before it runs, and a PC with Smart App Control on blocks it until the signed build.
This gives the downloads page the entry it reads; the page lists a channel's installer once its own change is deployed.

## The update check

A request with `update_check` checks the app's own update (`docs/alpha.md`, "Updates on Windows") on the clean machine instead of the installer check.
It runs only on request: nothing a batch or an alpha runs asks for it.
`build` first points the checkout's release source at the machine's own feed, `https://localhost:8443/` (`scripts/windows-update-source.ts`, `tests/windows/updateVersions.ts`), builds once, and packages two unsigned test versions per channel from that one build, telling them apart only by their version: `0.0.1-alpha.1` and `0.0.1-alpha.2` for alpha, `0.0.1` and `0.0.2` for stable.
Their release source names no published place, so nothing they find or download comes from a real release, and they stay on the run as the installer does.
`update` is a matrix of one fresh machine per channel and round (`rounds`, as for `check`), set up as `check`'s is; it installs the channel's older version as a double-click does and runs `tests/windows/windows-update.spec.ts`.
Every round takes the same test installers, which the run built once or took from an earlier run ("Reusing the test versions" below).
With more than one round the jobs run one at a time, in order, and a failed round cancels every round after it, none of which has started; one round runs both channels side by side, each to its end.
With more than one round each job's name ends `; round N`.
The journey serves the feed itself on the machine's loopback addresses (`tests/windows/updateFeed.ts`), with a certificate it makes in this person's own store and trusts for them alone as one of their own roots, answering Yes to the Security Warning Windows shows first, and sets `NODE_USE_SYSTEM_CA=1` in their environment, where the command Task Scheduler starts reads it; it takes both away when it ends.
The certificate is its own authority (basic constraints CA true, allowed to sign certificates) naming `localhost` and both loopback addresses, as the Mac's update check's is: the installed app refused a plain self-signed server certificate the runner's own Node accepted.
Before the window opens, the journey reads the feed from a Node a task of its own starts through Task Scheduler, so a missing setting shows there rather than as an update the app never offers.
It checks, in order:

1. Git for Windows installs on the person's yes, as in the installer check, and the window, opened again on the person's own data folder, starts the command through Task Scheduler.
2. The window signs in to the stand-in provider, turns a setting away from its default and asks the first mate for a task, whose crewmate's turn the stand-in keeps running (`tests/e2e/scenarios/updateResume.ts`).
3. Settings → General's Version row offers the newer version, and the journey takes its hero picture pair there.
4. The feed offers it with another file's checksum: the row's Update and restart installs nothing and says the download did not match its published checksum, and the older copy goes on: its window and command still run, the turn is still running, and no installer is left in the data folder.
5. The feed offers it with a download that stops a quarter of the way: the row's Try again installs nothing, says the download stopped, and the older copy goes on the same way.
6. The feed offers, under the newer installer's name and with its own checksum, Windows' `where.exe`, which exits with an error on the installer's arguments: Try again saves the running turn and the command ends, the hand-over ends the window and opens the kept older copy, whose window starts the command again, which carries the turn on with the words of a turn an update stopped; the journey's window, opened again, finds the row saying the installer stopped beside Try again.
7. The feed offers it as published: Try again saves the running turn, the command ends, the installer replaces the copy (the journey keeps every process of the hand-over it sees meanwhile), and the new copy's window opens through the Start menu entry, the hand-over ends once it sees that window, and the window starts the command again, which carries the turn on once more.
8. Opened again, the new copy names the newer version on the same channel, with the same task, now finished by the resumed turn, setting and sign-in, the same Task Scheduler entry, one removal entry for this person, and no installer left in the data folder.

A second test runs the hand-over itself (`windowsHandOverScript`) for the ways back the journey cannot reach, with a program it compiles standing in for the installer (recording its arguments and exiting as told) and a data folder of its own, with a space and an apostrophe in its name, opened with `--user-data-dir`, beside a window of the installed copy it opens on another folder, which every step finds still running: a disposable process still running after a wait shortened to seconds gets nothing installed, its channel marker put back and the copy opened on that folder once the process ends; a finished update runs the installer without `--force-run`, ends that folder's window and opens the copy there again; and an installer that stops beside a copy that starts but never shows a window, or a copy without its app, and a finished installer for the person's own folder that opens no window, each get the message naming the download page, which opens once the message is answered.
It stops every process it started when it ends, and keeps the hand-overs' error output.

When it ends it takes back the certificate and puts `NODE_USE_SYSTEM_CA` back as it was, and a change it could not take back fails a journey that otherwise passed.
Its pictures and readings go to the `windows-update-evidence-<channel>` artifact, with `-round-N` after it when the run has more than one round.

### Reusing the test versions

A loop of update checks that changes only the journey or the update job would otherwise build the same four installers again each run, which is most of the run's time on the PC's Windows.
So `build` first reads the key of everything the installers are made from (`scripts/windows-update-builds.ts`): each file on the desktop app's build list (`scripts/desktop-build.ts`), `electron-builder.win.yml`, the test versions' release source (`scripts/windows-update-source.ts`, `tests/windows/updateVersions.ts`), the composite actions the build job uses, and the build job's own text in `windows.yml`.
It keeps the installers in an artifact named `windows-update-installers-<key>` for three days.
When an earlier run kept installers under the same key, `build` installs and builds nothing, and each `update` job downloads that run's artifact.
It takes an artifact only from a run of this project's own `windows.yml` that someone with write access asked for, never from a pull request of another project, which can keep an artifact under any name; and only one kept long enough for every `update` job of this run to read it, one hour for each job the run may start one after another and one for the queue.
A lookup that fails builds.
A reused installer was built from an earlier commit with the same inputs, so the app it installs reports that commit as its source.
