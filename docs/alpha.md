# Alpha, stable and public downloads

Stable and Alpha support both Homebrew Casks and signed, notarized drag-to-Applications disk images.
Homebrew copies update through Homebrew; direct copies update inside Infinitary without Homebrew.
Both channels keep one app, one bundle identity and the same saved work.
User instructions and migration precautions are in `docs/mac-installation.md`.

## How it holds together

`packaging/release-source.json` selects the public download origin and hidden download page at build time.
The selected download destination is `downloads.getinfinitary.com`; its Cloudflare storage configuration is separate from the source repository's visibility.
The workflow keeps each immutable signed `v<version>` record on the active source repository using its own token.
The source moves to the public development repository `infinitary-apps` at the cutover below; the preparation changes do not switch publication.
Bucket-scoped R2 credentials publish the public copy only after storage is configured.
Without those settings, the approved fallback keeps a stable's Homebrew and Linux publishing through the taps and skips disk images and direct feeds; a live alpha refuses to publish, since its Windows installer reaches testers only through download storage.

Each release carries the finalized universal ZIP, a signed and notarized disk image, and the Linux files, with checksum sidecars.
The ZIP remains the native updater's payload and the download paired computers use.
The disk image places Infinitary on the left, an instruction to drag it across, and the Applications shortcut on the right; its artwork and dimensions are owned by the design skill and `electron-builder.yml`.
The release publishes the verified ZIP to the Homebrew tap as well as the configured direct-download destination, then advances each path after its own credential-free fetch-back.
Cask publication keeps its style, compatibility, immutability and channel-isolation gates; direct installation and native updates do not require Homebrew.
Historical download URLs stay available; the readers retain their exact-version fallback for older paired computers.

- Contribution stays hidden until approved terms are published; [Infinitary’s privacy policy](https://getinfinitary.com/privacy) covers Diagnostics and phone notifications.
  The alpha notice ships with the build, and outside code merges only once its author accepted the Contributor License Agreement (`CLA.md`; `docs/public-ci.md`, "Outside contributors").
  The amendment is the EONA alpha-before-incorporating decision (captain, 2026-09-22: "on from the first cask: an anonymous daily count, opt-out, disclosed in the notice"), widened by the captain the same day for funnel and retention accounting: the Diagnostics switch is ON by default and carries an allowlisted set of anonymous usage events - the app opening, a first mate turn ending or failing, the first-run funnel - with the app version and an anonymous random install ID that resets when Diagnostics is turned off and back on, never anything typed; it is disclosed in the alpha notice and on the first launch, and turned off by the switch (`docs/sharing.md` is the one home).

## Update channels

`src/core/update/macUpdates.ts` owns the saved subscription, logical-version ordering and consent.
`src/main/host/macUpdates.ts` owns `electron-updater` and Electron's native signed replacement.
The host enables native replacement only for an installed release Mac, not a development or hermetic source run.

- **Persist first.**
  `update-channel.json` in the data root records Stable or Alpha before the first update check.
  A valid existing choice wins; otherwise the installed logical version supplies the initial channel.
  A direct copy keeps the channel independently of the installed version and drops old cask-routing fields.
  A Homebrew copy instead follows its per-copy installation receipt, including the tap and channel chosen by its cask; it never enters the native updater.
  An Alpha subscriber remains Alpha after receiving a promoted stable.
- **Only newer versions.**
  Stable excludes prereleases; Alpha may take a newer alpha or promoted stable.
  The full logical version, not only Get Info's numeric core, determines precedence.
  Selecting Stable while ahead waits for a newer compatible stable, with no downgrade.
  A missing channel feed offers nothing.
  An app open on another computer follows the version its home runs instead, whatever its channel, by that version's own manifest (`docs/view.md`, "Following the home's version").
  The native library's channel setter enables downgrades, so the adapter explicitly disables them afterward.
- **No identifier.**
  Unpatched, `electron-updater` keeps a random per-install ID in the data folder (`.updaterId`) and sends it as `x-user-staging-id` with every feed read, whatever the Diagnostics switch says.
  Our patch of it (`patches/electron-updater@6.8.9.patch`) sends none, so Diagnostics' install ID stays the one identifier that leaves for us (`docs/sharing.md`).
  The adapter puts every copy in every release, since the library's staged-rollout check would otherwise mint that ID for a feed naming a `stagingPercentage`, which our feeds never name.
  It removes a `.updaterId` an earlier version left, from the folder the library used.
  `src/main/host/macUpdateFeed.test.ts` reads a feed through the adapter and the patched library and holds all three.
- **The active mark.**
  An installed copy's first answered feed read of each Pacific day carries `Infinitary-Active: day`, or `day, month` on the first of a Pacific month, so copies in use can be counted with no ID (`docs/sharing.md`, "The update check's active mark").
  The adapter sets it on the library's request headers for that check alone and clears them, so a download never carries it.
- **Consent before replacement.**
  Checking never downloads; Update and restart (Install on Linux, and Try again after an install that can pass) first reads the release source, so it installs the newest version on the channel, falling back to the version already offered when that read fails; a staged update reads nothing.
  An app following the version of the computer it controls is the one exception: its offer is that exact version, read from its own manifest whatever the channel, and its install refuses any other (`docs/view.md`, "Following the home's version").
  It then downloads, checks the checksum, saves the crew's work ("Saving work before an update" below), stages through native signature verification, awaits core shutdown, and restarts.
  Automatic downloads and automatic installation on quit are disabled, except that an app following the computer it controls downloads that version in the background and starts again on it while nobody uses it (`docs/view.md`, "Following the home's version").
  The notice shows progress and bounded errors, with a link to the release page for recovery.
  The app refuses updates from a mounted or translocated copy, an unwritable installation, or an unsupported system.
  Such a problem cannot pass on a retry, so the core withdraws Update and restart for the rest of that run (`blocked` in `src/core/update/macUpdates.ts`) and Open the releases page becomes the next step; a failure that can pass, such as a stopped download, offers Try again beside Check for updates.
- **Switching invalidates pending work.**
  A channel change saves first, invalidates prior checks and offers, and cancels an unfinished download.
  Native staging locks the channel until restart.
  If shutdown fails after staging, the ready state preserves the staged update and retries restart without downloading or staging it again.
- **Settings and controlling views.**
  Settings → General places keyboard-accessible Stable and Alpha choices next to Version.
  The Version row and the top-right update notice draw one update part (`src/renderer/src/app/UpdateStepView.tsx`) from one ladder (`updateStep`, `src/renderer/src/app/updateStep.ts`): for every state a line that says where the update stands and, beside it, a button that takes the next step, with at most one more control.
  Up to date, a copy ahead of its channel, or no release yet: the line says so and when the release source last answered (`checkedAt`; "Up to date on Stable.
  Checked just now."), with Check for updates.
  Check for updates reads the release source now on every copy whose installation the app knows, past the 4-hour saved answer, and joins a check already reading (`checkNow`, `inf:update:check`); command search's Check for updates and the app menu's Check for Updates… open Settings → General with focus on the row's Check for updates, or its next step where it offers none, and press Check for updates.
  A failed check with nothing found says so beside Try again and Open the releases page; it never says the copy is up to date.
  A version available offers Update and restart (Install on Linux) or, where a package manager installs it (Homebrew, Arch, NixOS), shows its command with Copy command, each beside Check for updates, since a newer version may be out; the line says when it last checked ("Version 0.6.5 is available.
  Checked 3h ago."), and the version in it opens that version's release page.
  While that check reads, the line and the next step hold still and only the button says Checking….
  A failed check keeps a version already found ("Updates could not be checked.
  Version 0.6.5 is still available."), and the quiet read keeps it without a word, on every system.
  Once an update downloads, saves work, updates or waits to restart, the row offers no check, and a check from the menu or command search changes nothing.
  While an update downloads the line shows its progress; while it saves the crew's work it says Saving work and whose running work it waits for, with Update later, then Updating, and after the restart Resuming work until every turn the update stopped has started again.
  A staged update whose restart did not finish offers Restart; a copy of unknown installation explains itself beside Open the releases page.
  The Update channel row shows only its own problem, a failed channel change.
  A Mac controlling another Mac changes and checks its own installed app, never the remote computer's.
  The release indicator and Settings share one renderer status store.

## Builds by system and chip

The selected Cloudflare snapshot serves `feeds/latest-mac.yml` for Stable and `feeds/alpha-mac.yml` for Alpha, using standard updater metadata with the finalized ZIP's URL, size and SHA-512.
The same snapshot carries schema-1 `infinitary-updates.json`, `infinitary-builds.json`, and `versions/<version>.json` with immutable ZIP and disk-image identities.
`releaseFeedFiles` reuses the existing forward-only target and builds producers and validates URLs against the configured destination.

The builds file carries `macos` → `arm64` and `x64` → `zip` and `dmg`, `linux` → `x64` → `deb`, `rpm`, `appimage`, `arch` and `nix`, and, on an alpha, `windows` → `x64` → `exe`, the unsigned installer its Windows check tested (`docs/windows.md`, "Published on every alpha").
The feed writer runs the app's own builds reader on the next file and refuses one it would not accept, before the feed switches.
Every build names a file on that version's release and its SHA-256.
Both channels naming one version must agree on channel-neutral bytes; the Arch and Nix recipes may differ because their package names encode the channel.
Linux and paired-device readers use the configured source; exact historical paired-device versions may still resolve through the old tap and its checksum sidecars.
Unknown build kinds remain compatible with older readers.

`node scripts/linux-recipes.ts release --version <v> --packages <dir> --out <dir>` prepares the Linux artifacts, recipes, `SHA256SUMS`, `manifest.json` and `assets.txt`.
A retry adopts published package bytes before rendering their recipes again.

## Updates on Linux

A Linux installation updates through the one update reader (`src/core/update/updateChecker.ts`), never a second one, from the builds file above.

- **Which package it is.**
  The deb and the rpm carry `resources/package-type` (`electron-builder.linux.yml`), the Arch recipe and the Nix package write their own, and an AppImage is told by its runtime's `APPIMAGE` and `APPDIR` (`src/core/update/linuxInstall.ts`).
  An installation whose package Infinitary cannot name is offered the version and its release page, and installs nothing.
- **A deb or an rpm.**
  The panel offers Install.
  The app downloads the build into its own data folder, refuses bytes whose SHA-256 is not the published one, saves the crew's work ("Saving work before an update" below), and asks the system for the person's password (`pkexec`).
  The command that runs then copies the package into a folder only the superuser can write, checks that copy's checksum again, so the bytes it installs are the bytes it checked, and hands it to `apt-get` or `dnf`, which bring anything the package needs.
  The app then writes its channel marker with the version it installed and starts again.
- **An AppImage.**
  The panel offers Install; the app downloads the build beside the AppImage it runs from, checks its checksum, saves the crew's work, replaces the file in one rename and starts the new one, with no password.
  An AppImage in a folder the person cannot write is refused in plain words.
- **Arch, Omarchy and NixOS.**
  Their packages update through their own package manager, so the notice names the command: for Arch and Omarchy, fetch the channel's recipe, check its checksum and `makepkg -si`; for NixOS, `nix-env -iE` with the recipe's address and checksum.
  Each recipe writes its channel marker beside the app, so an alpha installation that takes a stable version stays on alpha.
  The recipes publish on the configured public release; nothing publishes to the Arch User Repository.
- **When installing cannot finish.**
  A closed password prompt, a computer with no way to ask, a refused checksum or a stopped installer each say so in the panel, nothing changes, the crew's work carries on, and the panel shows the command that installs the same build by hand, checksum first.
- **Development and tests.**
  Only an unpackaged run reads `INFINITARY_UPDATE_BUILDS_URL` and `INFINITARY_UPDATE_LINUX_PACKAGE` (with `APPIMAGE` for an AppImage), which point the reader at a stand-in download source and stand in for a package; a run from source on Linux without them reads what a Mac reads.

## Updates on Windows

A Windows installation updates through the same update reader, from the builds file above, under `windows`, this PC's chip and `exe` (`src/core/update/updateChecker.ts`).

- **Which channel.**
  It follows its channel marker in the data folder, which the app writes just before it hands an update over, and otherwise its version's channel, as on a Mac.
  A channel whose version carries no Windows installer offers it nothing, and the Version row says no release is available on that channel yet.
- **One click.**
  The Version row offers Update and restart.
  The app downloads the installer into its data folder (`updates`), refuses bytes whose SHA-256 is not the published one, and saves the crew's work ("Saving work before an update" below).
  It then hands the installer to a hidden Windows PowerShell, the hand-over, which waits for the app's own process to end, runs the installer as a silent update and reads how it ended (`windowsHandOverScript`, `src/core/update/windowsInstall.ts`).
  Windows ends every process a Task Scheduler task started when the task's command ends, so Windows PowerShell asks Windows' own process service (`Win32_Process.Create`) to start the hand-over, which then belongs to no task and outlives the command.
  The app writes its channel marker with the version it hands over before the hand-over, since the installer runs after the app ends: a marker it cannot read or write hands nothing over, and a hand-over that fails puts the earlier marker back whole, or says it could not and asks the person to check the channel in Settings → General.
  Then it ends: a window quits, and a command ends with 75 as for any update (`docs/run.md`, "After an update").
  The installer replaces the copy for this person alone, with no administrator, and keeps the data folder and the Task Scheduler tasks, which name the same program.
  The new copy opens on the data folder the old one was opened on: the person's own through the Start menu entry, as the installer's `--force-run` opens it, whose window starts the scheduled command again, and a folder named with `--user-data-dir` by the hand-over, with that folder again, whose window runs its own first mate as it did before, since a switched data folder starts no command (`docs/run.md`).
- **Who the installer trusts.**
  Until the Windows package is signed, an update trusts the download site and the published checksum alone, as a Linux package does; requiring the expected publisher's signature is a later piece of the Windows plan.
- **When installing cannot finish.**
  A download that stops, a refused checksum, or an installer that cannot start each say so on the Version row, nothing changes, and the crew's work carries on.
  An app still running five minutes after the hand-over began has not finished saving, so the hand-over installs nothing; once the app ends it opens it again.
  An installer that exits with an error leaves the copy in place, and the hand-over opens it again.
  Either way the hand-over first puts back the channel marker the kept copy followed, then ends that data folder's windows still open, as the installer would, and only windows: a command or a work run has none, and another data folder's are left alone.
  It reads each process's data folder as Chromium does, from its command line split as Windows splits it (the last `--user-data-dir=` switch, any prefix or case, before a lone `--`), compares full paths, and leaves alone a process whose command line it cannot read, leaves a quote open, or names a folder with no drive or share, since a relative folder means the folder that process started in; the app reads its own switch the same way (`openedOnSwitch`).
  The hand-over is plain Windows PowerShell and compiles nothing as it runs, so a computer whose policy refuses that still updates.
  The copy then opens fresh on its data folder as above, and the person's own starts its command, which carries the saved work on.
  The hand-over leaves `update-result.json` in the data folder, which the copy it kept reads once as it starts (`takeWindowsHandOverResult`), and its Version row says the update stopped or the installer stopped, beside Try again, until the next attempt; when the marker could not be put back it also asks the person to check the channel in Settings → General.
  A result file the copy cannot remove is said again at its next start rather than stopping it.
  The windows it ends must end within 30 seconds before it opens the copy, since a new window would hand itself to an old one still open on the same folder; one that does not end gets the message below.
  A copy counts as opened again only when a window that was not there before shows on its data folder, which the hand-over also waits for after a finished installer's own restart of the person's own folder.
  A copy missing its program or its `resources\app.asar`, or one that shows no new window on that data folder within two minutes, is said in a message from the hand-over, with the release page to download the installer from, which it opens next.
- **A window controlling another computer.**
  It names a newer version of its own copy and its downloads page, and installs nothing: such a PC also runs that computer's work, which the installer would end mid-run (`docs/windows.md`, "Joining another computer").
- **Development and tests.**
  Only an unpackaged run reads `INFINITARY_UPDATE_BUILDS_URL` and `INFINITARY_UPDATE_WINDOWS_INSTALLER=1`, which stand in for the download source and for an installed copy; a run from source on Windows without them reads what a Mac reads.

## Saving work before an update

An update of this computer's own copy saves the crew's work here before anything replaces the copy (INF-2245, the stop-and-resume update the captain approved on INF-2223).
The update asks the crew's work (`CrewWorkForUpdate`, `src/core/update/updateWork.ts`), which `CrewUpdates.saveForUpdate` answers.
The Mac updater asks once the download is done and before native installation; the Linux updater asks once the download's checksum is checked and before the password prompt or the AppImage's rename (`beforeReplace`, `src/core/update/linuxInstall.ts`), and the Windows updater once the installer's checksum is checked and before it hands the installer over (`src/core/update/windowsInstall.ts`).

- **Nothing new starts.**
  While the update saves, no crewmate turn on this computer starts: a reply, a steer, a queued task and the next turn of a task wait on their lanes in order (`heldForUpdate`).
  A turn already on its way to its model is refused before its model takes it (`StoppedBeforeStartError`), and its words stay on its lane.
- **Running work finishes first.**
  Each running turn stops safely (`ModelSession.stopSafely`, `src/core/session/session.ts`): a call it already began finishes and its result is kept in the conversation, a call asked for after the stop is refused and tells the model why, and only then is the turn cut.
  Pi's gate is its `beforeToolCall`; Claude's is a `PreToolUse` hook (`docs/claude-client.md`).
  A Claude call the client begins with its hooks off, as a staged skill turns them off, is waited for once the client says it began.
- **No deadline.**
  The save waits as long as the calls run, and the update panel names each task whose running work it waits for: Waiting for “Release notes” to finish what it is running.
- **What it records.**
  Each turn it stops gets one `turn-resumed` lane row, `stopped: "update"` with no computer, written before the stop (`docs/inbox.md`, "A turn a quit or crash cut").
  A turn a crewmate carries on by itself after its earlier turn stopped stops too, the same row carries both on, and the save waits for it.
  The feed says once that the task paused while Infinitary is updated and carries on after the update, naming no computer (`updatePauseLine`).
  Nothing else is copied: the conversation, the task, its files, its approvals and its pause stay with their owners, and an idle or separately paused task gets no row.
- **Closing.**
  Once every turn has stopped, the shutdown waits, with no bound, until every conversation's client is gone (`disposeAll`), so each transcript is written before the new copy reads it.
- **After the restart.**
  The sweep carries each stopped turn on once from its row, before the words that waited; Settings' Version row says Resuming work until every such row is served (`resumingAfterUpdate`).
- **Update later.**
  While the update saves, Update later in the update panel or in command search (`updates.later`, `inf:update:later`) lets the update go: nothing is replaced, a turn still waiting for its calls goes on as if never asked, a turn already stopped carries on from its row, and the words that waited go now, in order.
  An installation that fails after the save, such as a closed password prompt or a refused signature, lets the work carry on the same way.
- **A first mate started by a command.**
  Its own updater is the only updater where it can be: on Linux the command replaces the program after the same save and ends with 75, for whatever started it to start the new copy (`docs/run.md`, "After an update").
  On Windows the command hands the installer over after the same save and ends with 75; the installer opens the new copy's window, which starts the command again.
  On a Mac only a program in the person's own session can install the update, so the window opened beside the command installs it for that first mate, while the first mate holds the crew's work saved (`createUpdateHold`, `src/core/update/updateHold.ts`; `inf:update:hold`, asked only by this computer's window).
  The window asks `save` where a window with its own first mate asks the crew's work, `later` for Update later, `release` when nothing replaced the copy, and `replaced` once it did, which ends the first mate with its work still saved for the new copy to resume (`crewWorkHeldThere`).
  The hold belongs to the window's connection: a window that closes or drops mid-save lets the save go and the work carries on, so a closed window never leaves the crew waiting.
  A `replaced` with no work saved is refused, and nothing ends.
  Once `replaced` answers, the window lets go of the agent it started the command with (`BesideWindow.replacing`, `src/main/besideWindow.ts`): that agent starts the command again after an update's exit, which would start the old copy before the installer replaced it, and macOS's installer refuses to replace a copy that runs (INF-4113 found it giving up with no window back).
  The new copy's window, which the installer opens, starts the command again.
- **What it does not wait for.**
  A background job is app-lifetime: the shutdown stops it and its row says the quit stopped it (`src/core/jobs/jobManager.ts`), which the crewmate hears after the restart.
  A turn on another computer goes on there; the connection and Remote Login updates of a computer that runs work still pause its turns the earlier way ("Updating" in `docs/devices.md`).
  The guarantee starts with the copy that has this code: an update that replaces an older copy stops work the way that copy did.

## Updates from source

A copy run by `pnpm dev` updates from where the project lives instead of from a release, through a starter that stays as the app's parent (`scripts/dev.ts`, `scripts/dev-starter.ts`).
The starter makes a private folder for each run and names it to the app in `INFINITARY_DEV_STARTER` (`src/core/update/devStarter.ts`); the app's children never inherit it (`hostEnv`).
Before each start it writes the session there: the copy's commit, whether a tracked file differs from it, the lockfile's digest and how its last update ended.
The app marks the folder once its main process runs, and an app the starter started keeps running when its last window closes, as the installed app does.

Daily `pnpm dev` runs from a clone of the person's own, never from the project's folder the app manages: after each merge the app fast-forwards that folder (`docs/task-record.md`), which would move the code under the running app, and the app would then read itself up to date and never offer Update and restart.

The app's update check (`src/core/update/sourceUpdates.ts`) reads the branch the copy is on and the branch it follows where the project lives, fetching that branch alone every 4 hours or when the person presses Check for updates; a quiet fetch that fails tries again at the next status read instead of waiting 4 hours.
Its versions are short commits, the status names the branch and how many newer commits it has, and a GitHub project's newer commits open on its page comparing the two; elsewhere the commit is plain text.
Such a copy has no releases page, so a failed check with nothing found offers Try again alone, and an update that went back and cannot move forward offers Check for updates.
It offers Update and restart only when that branch has newer commits, no tracked file is edited and the copy has no commit of its own; otherwise it says why.
A copy on no branch, or on one that follows none, says it cannot update itself.

Update and restart saves the crew's work as an installed update does ("Saving work before an update"), writes its request naming both commits into the starter's folder and quits.
The starter moves the copy forward only when it is still on the offered commit and clean, with a fast-forward merge.
It runs `pnpm install --frozen-lockfile` when the lockfile, `package.json`, `pnpm-workspace.yaml` or `patches/` changed, then `predev`, and starts the app again.
A commit whose packages do not install, whose `predev` fails or whose app ends before its main process runs moves the copy back to the commit before, installs and prepares that one again, and starts it; the app then says why it went back.
An app that crashes after its main process ran is not moved back.
A clean starter run names its commit in the build's identity (`readSelfSource`), still mutable, since the copy can change.
Every other run from source, journeys among them, keeps the simulated update; `INFINITARY_SIMULATE_UPDATE=1` gives a starter run the simulated one too.

## Casks and update targets

The cask generator and strict tap readers remain active release prerequisites for Homebrew installations.
The new feed writer reuses their typed forward-only target rules with the configured release names; it never renders a cask.
Every cask's homepage is Infinitary's website, `https://getinfinitary.com/` (`HOMEPAGE`), on both supported taps; the release contract checks it.
The app's offered Homebrew command runs `brew update` and upgrades the installed channel's fully qualified cask (`upgradeCommandFor`), including the old Firstmate tap.
Naming the tap and cask lets Homebrew 6 and later trust that cask when the installation predates tap trust, without trusting the whole tap, and works on older Homebrew too.

## Republishing the casks

The automatic cask republication workflow remains active.
A generator change on main rewrites the casks at their existing targets only after verifying the public downloads; it does not create a release or advance a target.
A dry run preserves the generated casks without pushing them.
Its optional `mac_runner` input selects a temporary runner for that dry run without changing `MAC_RUNNER`; publication ignores the override.
Historical releases, tags and checksum sidecars stay intact, and unrelated products on the shared taps remain untouched.

## The old-cask switch

Existing Firstmate 3000 users install an Infinitary disk image directly, without a final Homebrew upgrade.
The existing saved-folder handover preserves their work and explicit channel choice; the new updater replaces the marker's legacy routing fields with its persistent subscription.
Optional Homebrew ownership cleanup happens before copying the new app and never uses `--zap` (`docs/mac-installation.md`).
For channels activated in `packaging/old-cask-switch.json`, the release also mirrors the finalized ZIP and Linux assets to the old tap, verifies their public downloads, and advances its casks and frozen-schema metadata.
People who keep their Homebrew installation continue upgrading the same cask; the app's offered command names its tap explicitly so it also works after Homebrew begins requiring tap trust.
Moving to a disk image remains optional.
The switch lists `alpha` and `stable`; releases of either channel also update the corresponding older cask.

## The signed channel workflow

`release.yml` resolves one source and publishes verified immutable artifacts before any channel moves.

- **One source commit.**
  The `channel` input is `stable` - the workflow's default - or `alpha`, and both are requested from main, so the workflow file is always main's.
  The `resolve` job (Linux, no secret) provisions Node 24 before running `scripts/resolve-release.sh` from the workflow's own commit, in a clone with every branch and tag, and pins the source commit first.
  Both the resolver and its source-destination check need Node on the job's search path; a gate runner's action runtime alone does not provide it.
  For an automatic alpha it is the successful rolling-main run's exact `head_sha`; a manual alpha names its `candidate`, and a stable names the `promote`d alpha's own commit ("Promoting an alpha").
  The verify lanes, the update check, the signing job and the source tag use exactly it, and the targets file records it.
- **One candidate.**
  A `main` workflow run that passed automatically starts an alpha: its last job dispatches `release.yml` with its exact source as the candidate and its run as `main_run` and `main_run_number` ("Cutting an alpha").
  A manually dispatched live alpha still requires a full candidate commit id.
  `verified_main_run` is the recovery route for reusing a successful exact-source main run, not an unchecked skip switch.
  The resolver refuses it unless `git diff --name-only $(git merge-base <candidate> origin/main) <candidate>` lies under `release-notes/`: its code is exactly main's at the commit the review started from.
  Merges that land on main meanwhile wait for the next alpha.
  A rehearsal may omit it and build the dispatched commit.
- **Versions.**
  Both channels number from the newest stable tag, a bare `vX.Y.Z`.
  Alpha is its next patch, or its next minor when a commit since it is a breaking change (`type!:` or a `BREAKING CHANGE` footer), numbered by the workflow's run number: `X.Y.(Z+1)-alpha.N`.
  Stable is its alpha's numeric core.
  A fresh history with no stable tag of its own numbers from the record of past releases, `release-notes/archive.json`, which the resolver reads from the workflow's own commit: the next patch or minor above the newest numeric core either channel published in the archived history; and every version must be newer than that history's newest stable and newest alpha (`docs/release-notes.md` "A fresh history").
  Rehearsals use run numbers too, so gaps are normal.
  Nothing is committed: `package.json` and `CHANGELOG.md` stopped changing at stable 0.1.30.
  The source record uses `v<version>` tags; Cloudflare downloads use `releases/v<version>/` object keys.
  An alpha is a prerelease, never latest.
  The source repository becomes public at cutover, independently of the installer origins; both Homebrew taps retain their releases and update files.
- **Two version identities.**
  The packaged `package.json` carries the logical version (`-c.extraMetadata.version`), which the running app reports (`app.getVersion()`); `CFBundleShortVersionString` and `CFBundleVersion` both carry its numeric core, so nothing relies on macOS accepting a prerelease suffix.
  The packaged `self-map.json`, in `Resources/` and inside `Resources/self-source/`, names the logical version too: the build step passes it as `INFINITARY_RELEASE_VERSION` to `scripts/generate-self-source.mjs`, so a crewmate reading only the self-source can tell which build it holds; the `package.json` inside that tree is the repository's own and keeps 0.1.30.
  `scripts/check-app-launch.sh <app> <logical version>` proves them separately at every launch gate - the built app, the distribution zip, and both fetched-back copies: the two fields from the bundle, the logical version by asking the running app, on a throwaway profile, through its own healthcheck over Chromium's debugging port (`scripts/app-runtime-version.mjs`).
  The gate starts the app in a process group of its own; afterwards it asks the app to quit and waits for it, stops outright whatever of that group, or whatever names the profile, is still running, reaps the app, and removes the profile only once nothing can write into it.
  Every launch runs the workflow's own copy of the gate and its probe: the signing job puts them in place of the source's once the app is packaged, and the publication job and the old-cask check before they launch anything, so a stable promoting an older alpha launches through the current gate while its app stays the alpha's.
- **The Windows check on every alpha.**
  The `windows` job calls `windows.yml` at the alpha's version on its one source commit: it builds the unsigned Windows installer and installs and runs it on a fresh Windows 11 virtual machine (`docs/windows.md`, "The checks").
  An alpha's upload and publication wait for it to succeed; a stable promotion skips it.
  The upload job checks its own copy of the `windows-installer` artifact against the windows job's `sums` output and uploads it beside the zip to the record and Cloudflare, never a tap; the publication job fetches it back from both before the builds file names it (`docs/windows.md`, "Published on every alpha").
- **Linux in every release.**
  The `linux` job calls `linux-packages.yml` at the release's version on its one source commit, with the notes job's catalog, for both channels, a stable promotion included: it builds the Linux packages and installs and opens each on a clean copy of its system (`docs/linux-packages.md`) while verify runs.
  The upload job waits for it and checks its own copy of the artifact against the linux job's `SHA256SUMS` before anything renders or uploads (`docs/linux-packages.md`, "The checks").
  It then lays out the Linux files (`linux-files`) from that copy and uploads them beside the zip to every place, adopting any package a retry finds already published on one of them.
  The publication job fetches every Linux file back from each place like the zip - the public copies without a credential - and compares it and its sidecar with the upload job's list before the feed commit writes the builds file.
- **Full alpha checks, inherited stable checks (FI3-482).**
  Every alpha needs every Playwright journey passed on its exact files, on Linux in shards (`docs/testing.md`, "The Linux source desktop") and on the Mac, since main runs none of the old journey set (INF-2480, the captain: "old set at the release check only, from the first piece on").
  An automatic alpha whose files a green swept batch checked with every journey reuses that batch's run and runs no lane itself (the captain on INF-2508: "Keep every journey in the batch, and let an alpha reuse them"; `docs/testing.md`, "The swept batch").
  Any other automatic alpha calls `verify.yml` with `part: journeys` for them, and reuses the rest of the completed rolling-main run's full check without running it again: its Linux checks, the `linux-checks` lane's typecheck, lint, adherence lint and build and every Linux test group's unit, integration, probe and browser tests, and its Mac lanes' macOS unit tests, tests tagged `MAC_ONLY_TAG`, installed Claude client check, replay gate, and development package with its signature, data-folder and bundled-git checks.
  Since INF-2779 the full check's Mac work is native tests, replay and package; parallel journeys; and, since INF-6249, desktop journeys in two groups (`docs/testing.md`, "E2E scheduling and launch diagnostics").
  The journeys part runs only the two journey jobs, each with only the install, the build, the recorder and the suite.
  The release also runs the update check (`mac-update.yml`, "The update check" below) on Apple silicon: the real update from the signing job's handoff, once every check passed, before publication.
  There is no Linux-only bypass.
  Performance grading stays on request (`verify.yml` with explicit `full_system=true`, task/source/reason and `perf=true`; `docs/forge.md`, "Verification workflow requests").
  A stable omits verify and inherits its alpha's checks: the resolve job reads the published alpha's release run, found by its run number (the alpha's suffix), because a run dispatched from main records main's commit rather than the candidate it built.
  The stable's source is the alpha tag's own commit, so nothing differs from what that run checked.
  The run must have succeeded with every lane's latest execution completed successfully, each Linux journey shard included.
  An alpha that ran only the journeys part, with no Linux checks job, needs complete Linux shard sets and also validated exact-source main proof for the rest.
  An automatic alpha that ran no lane reused every one, so it is promoted only when the run it reused also holds complete Linux shard sets: its swept batch's, or a main run from before INF-2480, which carried every journey (`scripts/main-alpha-proof.mjs`).
  Reuse reads GitHub's run and latest per-job executions, requires a trusted main push, or the after-merge signal of the team queue this project merged through before, and the full-check owners, the Linux checks and the three Mac jobs (or, in a run from before INF-2779, the one `mac` job), and refuses skipped required owners, partial, cancelled, failed or other-source results.
  The Linux checks are the `linux-checks` lane and every Linux test group's complete set, or, in a run from before INF-2646 split them, the one `linux-checks` job that ran them all (`scripts/main-alpha-proof.mjs`).
  A manual alpha without reusable main proof, including a rehearsal, still runs full verification.
  A stable is refused without its alpha's proof, never verified again on its own.
  A promoted alpha must also have a passing update check on Apple silicon, or, for an alpha released before the update check, passing five-copy signed installer and updater jobs for both architectures.
  An alpha without those results is refused: publish and verify an updater-capable alpha first.
  The resolve and signing summaries name the alpha and link its run, explicitly saying the lanes were omitted, not passed here.
  The conditional reusable-workflow call may show as skipped; its Linux and Mac lane jobs are absent, never green skips.
  An API error stops resolution rather than inventing assurance.
  The signing job is the same for both channels and repeats none of the lanes' checks: it checks public-download visibility and updater capability, then builds, performs Developer ID signing, signed-app, launch and data-folder gates, notarization and stapling, the distribution zip's Gatekeeper and launch gates and checksum.
  Stable rebuilds new bytes, so all publication and fetch-back gates stay.
- **Signing while the checks run (INF-2074).**
  The signing job waits only for the notes it packages and the phone check; it builds, signs and notarizes while the verify lanes and the Linux packages are still checked.
  Its token only reads: it records, uploads and publishes nothing, so a failed check leaves no tag, release or public file behind.
  The update check and the upload job wait for every check, the verify lanes and the Linux packages included; recording the zip is the upload job's first effect.
  A stable has no lanes to wait for, so its signing starts once the phone and release-notes checks pass.
  The signing job holds the real Mac while the release's Mac lanes run, so those lanes take a virtual place or wait for the real Mac (`docs/testing.md`, "The real Mac's place").
- **Signing on the real Mac, uploads on a hosted machine, checks in a virtual Mac (INF-1716, INF-2498).**
  The signing job runs on the real Mac through the checked disk image, then hands off and frees it.
  Its handoff is two uncompressed Actions artifacts per attempt: one holds the zip to record, the other the checked disk image, when one was built, and a manifest of the run, attempt, workflow revision, source, channel, version, download mode, and each file's size and checksum.
  It never carries the app, the workspace, a credential or the environment, nor the Linux files, which come from the linux job; both artifacts' ids, the zip's on its own and the manifest's checksum are the signing job's outputs, and every reader fetches the artifacts by id into one folder.
  The `upload` job starts only after the signing job, the update check and every check succeeded, on GitHub's hosted `ubuntu-24.04`, one run of a version at a time.
  Before any effect it validates the handoff: the manifest is the one the signing job wrote, names this run, an attempt no later than this one, this workflow revision and this release, and the files are exactly those it lists, byte for byte.
  Then it lays out the Linux files and reads every place - the record, Cloudflare through its storage API, the Homebrew tap and the Firstmate 3000 tap - for the disk image, an alpha's Windows installer and the Linux files, adopts a copy any of them already holds, and fails before anything is written when two places hold different bytes or a held Windows installer is not the one this run's Windows check built and checked.
  Only then does it record the zip in the source record, its first effect and alone, so no place can hold a zip the record lacks.
  It compares each place's copies as soon as it reads them and keeps only the adopted copy of each file, and a copy fetched back only to prove an upload's bytes the same is deleted once checked, so a retry after every place took every file holds one copy of each on the hosted machine's disk, not one per place.
  It then uploads to every place at once, the recipes rendered from the adopted packages, and hands the publication job each file's name and checksum; its summary names the places and how long the uploads took.
  The `publish` job starts only after the upload job succeeded, in one disposable virtual Mac from the placement service, on the `release_light` or `light` kind's queue or its `mini-mac-virtual` pool (`docs/testing.md`, "Each Mac job's kind and size"); it waits for a free place and never falls back to the real Mac.
  It uploads nothing: it checks that the upload job's list names the signed zip, then downloads each copy from every place and checks it against its sidecar and that list, the record's with a token that only reads and the public ones without a credential.
  It reads every place at once - the record, Cloudflare, the tap and the old tap - in one step (`scripts/fetch-back-copies.sh`, the workflow's own copy), since no place's check waits on another's; the step prints each place's log whole once all have ended, records each place's outcome for the summary, and fails naming each place whose check failed.
  A keyless download fails on any answer about the file, such as the 404 a private or missing asset gets, after the same five more tries 15 seconds apart; a server error or a lost connection says nothing about the file, so it waits that out for up to 30 minutes a file, since GitHub has answered most keyless downloads 504 for over twenty minutes during its own incidents (`scripts/fetch-without-credential.sh`, the workflow's own copy).
  Every Mac check there - signature, Gatekeeper, launch and version, the disk image against the zip - still runs on the fetched copies, never replaced by a checksum.
  Only after every check passed does it switch the Homebrew casks, the old cask and the feeds; a rehearsal runs its tap and feed rehearsals on the handoff's own copies instead.
  The Apple signing material stays on the real Mac; the upload job holds the upload keys - the workflow token that writes, the storage keys and both tap tokens - and the virtual Mac holds only the tap tokens and storage keys its switch steps write with (`tests/release-workflows-resolve.test.ts`, "pins which machine holds which key").
  Rerunning only the upload or publication job reuses the signing job's handoff from whichever attempt produced it; rerunning the signing job hands off anew, and the record's immutable adoption still decides which bytes publish.
  The handoff and upload code lives in the workflow itself, so an older alpha promoted to stable needs none of it in its source.
- **Signing steps that overlap (INF-3193).**
  Most of the disk image's time is Apple's notarization wait, so the signing job starts the disk image in the background once the zip is built and the record read.
  Meanwhile it runs the zip's Gatekeeper and launch gates and uploads the zip's artifact; then it waits for the disk image, prints its log, fails on its exit status, and uploads the manifest and the disk image.
  The update check fetches only the zip's artifact.
- **Notarization survives a dropped connection to Apple.**
  The app and the disk image are each notarized through the workflow's own `scripts/notarize.ts`, so a release that builds an older commit notarizes the same way.
  It uploads the archive, saves the submission ID Apple assigns, reads that submission until Apple accepts or rejects it, then staples the ticket and validates it.
  A recorded transport failure, one of Foundation's network errors or notarytool's connect or read timeout, gets retries for status reads and ticket attachment, waiting fifteen seconds, thirty seconds, then one minute three times.
  An upload such a failure broke off is uploaded again as a new submission of the same bytes, up to three uploads, since a submission whose upload broke off may never receive its file; its journal keeps the abandoned ID.
  A rejection or an authentication error fails at once, and only acceptance followed by a validated ticket passes.
  The wait has no budget of its own: the signing job's time limit bounds it, as it bounded `notarytool submit --wait`.
  Each failed request's output goes to the job's log.
- **Release notes are checked first (`docs/release-notes.md`).**
  The `notes` job runs before `verify` or any signing, on the resolved source with full history.
  Every source change since the previous release needs a note or a reviewed exclusion, reviewed with its change before merge.
  An automatic alpha validates its exact-main source with `--verified-main`; it makes no new notes commit that would invalidate the reused main check.
  The existing published-release reader derives historical manifests from immutable tags when no committed record exists.
  A manual notes-only candidate keeps its existing reviewed-source and committed-history checks, and so does a rehearsal of one.
  A rehearsal that names no candidate builds the dispatched commit and reads past releases from their tags, as an automatic alpha does.
  The job runs its check and its catalog as two parts side by side, so a release waits for the slower walk rather than both.
  The catalog part generates the offline catalog, the signing job packages it as `Resources/release-notes.json`, and the packaged copy's logical version and source commit are verified before notarization.
  A stable promotion proves `release-notes/` is identical to its alpha's, so promoted stables reuse the alpha's entries and ids; prose corrections need a new alpha.
  Its highlights are the captain's picks, written into the generated catalog by the workflow's own tooling ("Promoting an alpha").
  The publication itself changes nothing in the project, and a rehearsal pins nothing.
- **No local full e2e run before a cut.**
  An alpha with exact-source proof from main's run runs every journey on Linux and the Mac in its own `verify.yml` call and reuses main's other checks.
  An alpha whose swept batch ran every journey on its files reuses every lane, and an alpha without reusable proof runs every lane.
  Full e2e runs are CI-only, including release preparation; request an additional run for any branch on GitHub's Actions page, or through `github_write` for the ref the crewmate's task needs (`docs/forge.md`, "Verification workflow requests").
  Locally, run only affected spec files (with `--no-deps` for renderer/application specs).
- **Failed alpha checks.**
  Nothing is recorded or published: the signing job may have finished, but its signed files stay only in the run's handoff artifact, which expires after seven days.
  The cut stops at its first failed job, a rehearsal's too (INF-6038's approved plan): its `watch` job, `<trigger> · Watch for a stop`, reads the run every half minute (`scripts/batch-stop.mjs`, the cut's rule), and once any job before the upload failed or timed out, its `stop` jobs enter the concurrency group of every job that can still be running - the verify lanes, test groups and journey groups, the signing job, the Linux package build and install checks, the Windows build and check, the signed installer build (which also checks the fresh copies), and the update check - with cancel-in-progress, the merge batch's stop ("The swept batch" in `docs/testing.md`).
  The cut does not request reused installer copies, so their separate check has no stop in the cut.
  Each cancelled job shows as cancelled, each stop passes, and the watch then fails itself, `Stopped the cut after <job> failed`, so the cut's red lines are the failed job and the watch, and the Mac and Windows machines are free about two minutes after the failure.
  GitHub may end the stopped run cancelled rather than failed; GitHub's "A workflow run fails" event still tells a run that ended cancelled with a failed job in its latest attempt (`docs/integrations.md`, "GitHub's events"), so a stopped cut still reaches its repair.
  The signing job's always-run steps still run after a cancel, so its throwaway keychain is removed by the same path the restore step creates it at.
  A watch that cannot read the run passes and leaves the cut to run on; the upload and the publication are never stopped, since neither starts after a failure.
  Automatic journey retries stay zero, and the cut confirms nothing before it stops.
  When a test fails, the release crewmate gets it fixed on main; its next rolling run that passes starts the next alpha automatically.
  Until the swept batch runs, an untagged journey first fails here, in the run named "Alpha from main run N", since main runs only the tagged ones (INF-2480).
  Only when the failing journey passes alone on the same commit may the failed checks be manually re-run once, keeping the alpha's version; if they still fail, diagnose rather than retry again.
  GitHub's Re-run failed jobs re-runs the failed watch and the jobs its stops cancelled beside the failed job, so the re-run is watched again.
  No urgent-alpha bypass.
- **Published bytes never change** (`scripts/publish-release-asset.sh`).
  The source release is the record: its tag must name the source commit.
  When GitHub answers a release's create with a server error, the script reads the release again and creates it once more only while it is still missing; a second error, or any other refusal, fails the upload.
  A retry adopts an already-published ZIP: its signing job reads the record before the disk image, builds the image from that ZIP's finalized, stapled app rather than the retry's rebuilt app, and hands that ZIP over.
  The upload job's record must then name the same bytes; a record another run of the version changed since that read fails before anything uploads, and a fresh dispatch signs from it.
  A disk image or Linux package any place already holds is adopted too, and the adopted disk image's app must match the ZIP exactly; two places holding different bytes fail before any upload.
  Every copy on Cloudflare and both taps must match the upload job's list, and so the source record, byte for byte.
  Nothing uploads with `--clobber`; a missing sidecar is added, a present one must agree.
- **Disk images and ZIPs have separate gates.**
  `scripts/build-mac-dmg.sh` packages the prebuilt app without re-signing or rebuilding it.
  The workflow signs the container with the existing Developer ID identity, notarizes it, and staples it before computing its checksum.
  `scripts/verify-mac-dmg.sh` checks notarization and Gatekeeper, mounts read-only, checks the Applications shortcut and saved Finder layout, compares the app with the ZIP, and launches a copied installation.
  Every release check that mounts a disk image detaches it through `scripts/detach-disk-image.sh`: a moment's hold by one of macOS's own background scans, which runs as the system and answers the unmount with "Resource busy", gets the read-only image detached by force, and only a forced detach that also fails fails the check.
  The unauthenticated fetch-back repeats the ZIP and disk-image gates against the actual public downloads before a channel advances.
- **One atomic feed snapshot** (`scripts/publish-feeds.sh`).
  After every public download passes fetch-back, `scripts/release-feeds.ts` writes the moved channels' standard updater metadata, targets, builds, and immutable per-version manifest into one immutable R2 snapshot.
  `scripts/publish-storage-feeds.ts` retains previous files, verifies the new snapshot publicly, and conditionally switches `feeds/current.json` last.
  See “Download storage” below for the object and credential contract.
  The publication job runs the workflow's own copies of these scripts and the code they load, never the release source's, so a release built from an older commit still writes every entry the workflow publishes.
  Those copies come from a checkout of committed files alone, with nothing installed or built in it, so the code the feed writer loads imports nothing the project generates, such as the compiled message catalog: it takes the update channel from `src/shared/updateChannel.ts`, which reaches only zod, not from `src/shared/update.ts`, which loads the update words.
  The download origin stays the source's: each feed step lays the source's `packaging/release-source.json` beside the workflow's writer, so the feeds name the origin the upload wrote to and the fetch-back read.
  An alpha moves only alpha; a stable moves stable and also alpha when newer than alpha's current target.
  A late older publication, inconsistent manifest, invalid existing file, or changed bytes at a published version is refused.
  A concurrent pointer write is refused rather than overwriting the other publication; read the new snapshot before publishing again.
  A release is never cancelled to start another; only a newer rehearsal of the same channel and ref replaces an older rehearsal.
- **Rehearsals publish nothing.**
  `-f dry_run=true` runs the channel's full checks, Linux packaging, signing, notarization, the disk-image gates and the update check itself.
  Its upload job reads and uploads to no place; it lists the files a release would upload, and the publication job checks the handoff's own copies against that list.
  It computes a local initial feed plan and keeps the metadata as `release-feed-rehearsal`, without instantiating a storage client or reading upload credentials.
  The rehearsal proves the release's metadata construction, not compatibility with a live channel's current target; live publication validates that state before switching.
  No tag, release, cask or feed is published, and no repository visibility changes.
  Its summary names each gate's outcome; a skipped live publication or fetch-back did not pass in that run.

## Moving the release home

Pause automatic and manual desktop and phone releases in the old project and let any in-flight releases finish before taking either snapshot.
From a full checkout of the old main, pin the release-notes archive ([A fresh history](release-notes.md#a-fresh-history)).
With read access to the old project’s workflow runs, write the phone snapshot using `node scripts/phone-order.ts archive infinitary-labs/infinitary` (the same `GH_TOKEN` input as the phone gate).
Place the output in `packaging/phone-release-archive.json` in the new project’s initial tree alongside the notes archive and its manifests.
The snapshot keeps the old workflow’s highest run number and the release attempts’ contract and TestFlight confirmation, so the new workflow does not need access to the old project.
The next phone release adds that fixed run-number offset; status-only requests still take the explicit build number.
Keep the current repository publishing during preparation and private rehearsal; a dry run on the new repository does not take over publication.
At the switch, change `repository` in `packaging/release-source.json` and the job-level repository guards in `docs-site-publish.yml` and `republish-casks.yml` to `infinitary-labs/infinitary-apps` together in the new project’s initial tree.
Do not change `downloadBase` or `releasePage`.
Rehearse that tree privately; keep the old project paused and archive it before starting live publication from the new project.
Promote only an alpha built in the new project; finish any intended promotion of an old alpha before the move.

## Moving releases to another Apple team

An installed Mac copy accepts an update only from a signature its own designated requirement allows: Squirrel.Mac checks the downloaded app against the running copy's requirement before staging it.
A default requirement names the one team that signed the copy, so a release signed by another team is refused and each copy would need a manual reinstall.
The release therefore gives its app bundle an explicit requirement (`src/shared/releaseRequirement.ts`, applied by `scripts/sign-release-mac.mjs`, electron-builder's `mac.sign` hook): Apple's chain through the Developer ID intermediate, the app identifier, a Developer ID leaf (the parts of codesign's own default) and any team in `acceptedTeamIds` of `packaging/release-identity.json`.
`teamId` stays the one team that signs the version; the release gate (`scripts/verify-app.sh`) requires that team's signature and the explicit requirement in codesign's normal form.
The requirement goes on the two files signed under the app's identifier: the app bundle and its background file, whose requirement must stay the app's (`docs/run.md`, "Opened while it runs").
No helper or other nested executable has that identifier, so none takes it.
A copy added over SSH is checked against the same requirement (`docs/devices.md`, "Downloading on a Mac reached by its address").

A move takes two releases on each channel.
The bridge release, still signed by the old team, lists both teams, and copies reach it through ordinary updates.
The switch changes `teamId`, `signer` and `electron-builder.yml`'s `mac.identity` to the new team, and keeps both teams in `acceptedTeamIds`, so a release the old team signs stays installable while any channel still needs one.
Dropping the old team from `acceptedTeamIds` is a later change, once no release the old team signs is left to publish.
Releases now sign with Infinitary Labs, Inc. (team `Y44V95NP6K`); sources from before the switch name the personal team `9T2J7MNUP9`.

Each release signs with the team its own source names.
`release.yml`'s resolve job reads it with the workflow's own `scripts/release-signing-team.ts`, which also names the prefix of the release secrets that hold that team's Developer ID certificate and App Store Connect key: `COMPANY_` for Infinitary Labs, none for the personal team.
A stable promoting an alpha the old team signed therefore signs with the old team, as that alpha's own `electron-builder.yml` asks.
The same step refuses a release whose team the channel's current release does not accept, before anything builds.
An alpha checks the newest release of either channel, since alpha copies also take a promoted stable; a stable checks the newest stable.
A stable runs no update check of its own, so the stable channel needs its own bridge stable, a promoted bridge alpha, before a stable the new team signs.
The step reads only the channel's newest release: a copy older than its channel's bridge refuses the switch's update and needs one manual reinstall.
The signed installer check (`mac-installer.yml`) and the phone's release reads use the new team's material alone.
The Keychain's items are tied to the signing team, so each saved item asks once more after the switch.

## Download storage

`packaging/release-source.json` owns the production download origin and hidden download-page address.
The hidden download-page address, `/alpha-downloads/`, forwards to the site's official downloads page, `/downloads/`, keeping its query, and the site lists no alpha installers.
The app keeps naming `/alpha-downloads/` as its release page, since older copies refuse a builds file that names another one (`src/core/update/releaseBuilds.ts`).
The storage and serving Worker belong to `infinitary-infra`; creating or deploying them is separate from merging this release code.
Repository variable `R2_BUCKET` and secrets `R2_ENDPOINT` (`https://<account-id>.r2.cloudflarestorage.com`), `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` activate direct publication.
The endpoint stays secret because it contains the Cloudflare account identifier; the two upload keys are bucket-scoped.
With all four absent, a live stable skips the disk image and direct feeds but still publishes Homebrew and Linux to both activated taps.
A live alpha with all four absent refuses before anything is signed or written: its Windows installer reaches testers only through download storage (`docs/windows.md`).
Its Linux recipes use the tap's download URLs in that mode (`RECIPE_HOST=tap`), never the not-yet-configured storage address.
A partial configuration fails before publication.
Upload credentials are passed only through the recipient's environment and signed HTTPS request headers; they are never placed on a command line or printed.

`scripts/publish-downloads.ts`, the workflow's own copy as with the feed writer, uploads the finalized release-record bytes to `releases/v<version>/<asset>` and adds a SHA-256 sidecar for every asset.
The S3-compatible uploader signs each payload's SHA-256 and uses `If-None-Match: *`; an existing object is accepted only after its digest agrees, never overwritten.
An upload that R2 answers with a server error, timeout or request to slow down (HTTP 5xx, 408 or 429), or whose connection is lost, says nothing about the object, so it is tried again 30 seconds later, for up to 30 minutes a write, each wait named in the log by the object's key alone.
The condition makes that safe: a later try either creates the object or is refused because an earlier try took it, and then the digest of the copy R2 holds still has to agree.
The release verifies every asset and sidecar through unsigned HTTPS before the signed ZIP and disk-image gates and before advancing any direct channel.
A read the network drops part way continues at once from the byte it reached with a range request (`publicDigest` in `scripts/release-storage.mjs`, which the snapshot check below shares).
A connection lost before it brought another byte, or a server error, timeout or request to slow down (HTTP 5xx, 408 or 429), says nothing about the file, so it is tried again 30 seconds later, each wait named in the log, for up to 30 minutes since the last try that brought bytes, the same patience as the fetch-back's keyless downloads; then the read ends.
An answer about the file, such as a refusal or a range the site did not continue, fails at once, and the digest still has to agree.
Every historical version remains downloadable.
Release objects and snapshot objects carry `Cache-Control: public, max-age=31536000, immutable`; the download service caches Linux file types as well as ZIPs and disk images.

A snapshot lives under `feed-snapshots/<id>/`.
The ID is SHA-256 of the JSON encoding of sorted `[filename, SHA256(content)]` pairs.
The snapshot retains all prior feed files and version manifests and applies all changed channels together.
`feeds/current.json` contains `{ "schemaVersion": 1, "prefix": "feed-snapshots/<id>/", "files": ["alpha-mac.yml", "infinitary-builds.json", "infinitary-updates.json", "latest-mac.yml", "versions/<version>.json"] }`, with the actual sorted list of files; a channel not yet published may be absent.
The uploader requests identity encoding when reading R2 objects, verifies every snapshot object publicly, then replaces this pointer with `If-Match: <previous strong ETag>`, or `If-None-Match: *` for its first creation.
If R2 still supplies a weak or missing validator, the uploader refuses the pointer write; it never strips `W/` or guesses a strong validator.
A signed R2 read, of the pointer or of an object an immutable write found already there, waits out a server error (HTTP 5xx, 408 or 429) or a lost connection with the same patience as the public read-back, naming only the object's key in the log; any other answer fails at once.
A conditional-write refusal stops the publication without moving the selected snapshot.
The pointer switch is never tried again on its own: a transport failure can leave its outcome unknown, and a replayed `If-Match` would be refused as a concurrent publication, so read the pointer before any deliberate retry.
The download Worker resolves `/feeds/<filename>` against one read of this pointer and serves only a listed file.
Pointer and feed responses, including missing objects, carry `Cache-Control: no-store` so a previous missing object cannot hide a completed upload.
Installer serving supports GET, HEAD and byte ranges.

The first live publication waits for the storage owner to confirm the bucket, domain, cache behavior, credentials and real R2 conditional-write semantics.
After that setup, a separately authorized alpha proves public fetch-back, both taps, and signed installed updates on both Mac architectures; unit fixtures do not prove those live effects.

## Cutting an alpha

A rolling `main.yml` run that passed automatically starts an alpha at that exact commit (INF-2259, the captain's accepted override).
The alpha cuts only when no earlier alpha is still being cut, no stable is being promoted or rehearsed, and something the desktop app is built from changed since the previous release ("An alpha with nothing new to build", below).
Main's last job, once every check before it passed, dispatches `release.yml` with `channel` alpha, the checked source as `candidate`, and its own run as `main_run` and `main_run_number`.
It starts the cut by dispatch, naming its own run, rather than by a completion trigger on `release.yml` (INF-3738).
A check started by hand dispatches nothing.
The dispatched release uses the checked source, not main's newer head, waits for that main run to end, since it starts during the run's last job, and runs only the journeys part of the full check, which main leaves to the release (INF-2480, the captain: "old set at the release check only, from the first piece on").
A source the swept batch checked with every journey runs no part: the batch already ran them on its files (the captain on INF-2508: "Keep every journey in the batch, and let an alpha reuse them").
Main runs no phone check ("An alpha does not wait on the phone check", below).
A failed, cancelled or incomplete main run cuts nothing; main's waiting-version coalescing and fix-forward process stay unchanged.

1. **Validate the completed run.**
   The resolver reads the completed successful trusted main run, started by a push or, before this project merged in batches of the person's own, by its team queue's after-merge signal, and every latest per-job execution from GitHub.
   It requires the full-check owners, the Linux checks (the `linux-checks` lane and every Linux test group) and `mac`, at exactly the source being released.
   A covered main run, whose files a passed swept batch already checked, names that batch run instead; the resolver then reads the batch run's two owners and requires the tree its batch checks name to be the source's tree, and accepts a batch that passed on its confirm, whose failed jobs the confirm ran again (`docs/testing.md`, "The swept batch").
   The batch run is a batch pull request's own (`docs/testing.md`, "A batch pull request"), or, for a source merged before then, a run of the team queue.
2. **Keep the same source.**
   The notes check validates committed declarations without a separate notes-review commit.
   Existing immutable tags supply published manifests through the same ledger reader when they have not been committed afterward.
   Missing or invalid notes still fail the release; editorial corrections merge normally and wait for their own passing main check.
3. **Run release-only gates and publish.**
   Phone availability, Linux package installation, signing, notarization, actual signed update and public-download checks still run.
   Every journey runs on Linux and the Mac in `verify.yml`'s journeys part, and the update check and publication wait for it, unless the swept batch's run already holds every journey for these files.
   Only the reused `verify.yml` coverage is skipped, and the summary names it inherited, not passed here.
   A failed job stops the rest of the cut about two minutes later ("Failed alpha checks" above), so main's next check, which waits for a running cut, starts soon after.
   The source tag `v<version>` names the exact checked commit.

### An alpha with nothing new to build

A rolling alpha cuts only when it has something new to ship (INF-2465, the captain: "make it so that the rolling alpha release pipeline on main only runs when there are desktop app code changes").
The resolve job's first step decides it, before main's proof is read, and when it skips, the run ends green with a summary saying why and no later job runs.
It skips in three cases:

1. **An earlier alpha is still being cut.**
   While an earlier rolling alpha run is still going, no new one cuts, whatever either holds (the captain: "as long as there's one main alpha release still happening, don't start any new alpha cuts. doesn't matter what changes are in each").
   An earlier run counts once its notes job exists, so a run still deciding whether to skip never stops another.
2. **A stable is being promoted or rehearsed.**
   A promotion tags its version only when it publishes, so an alpha numbered meanwhile takes the newest stable tag before it and can share the promoted stable's numeric core.
   A stable outranks every alpha of its own core, so once the stable reaches the alpha feed, subscribers are never offered that alpha, and its update check fails (INF-3648: `0.7.0-alpha.510`, cut while `0.7.0` was promoted).
   While a requested stable run is still going, no rolling alpha cuts; a run counts once its first job exists.
   A stable rehearsal counts too: it publishes nothing, but the promotion it rehearses follows it, and an alpha cut beside the rehearsal is still cutting when that stable publishes (INF-5587: `0.8.5-alpha.12`, cut while `0.8.5` was rehearsed).
   An alpha rehearsal never counts.
3. **Nothing the desktop app is built from changed.**
   `node scripts/release-notes.ts desktop-changes --source <commit>` finds the previous release by the notes check's own rule and lists the paths that changed since it on the desktop build list, `scripts/desktop-build.ts`.
   An empty list skips; a source with no previous release cuts.

The list names what the release installs, builds and packages the app and its Linux packages from: `src/` without its test files, `resources/`, `packaging/`, `vendor/`, `store/`, `patches/`, the package and builder configuration, the design skill and the scripts the build runs.
Tests, the phone, docs, `.github/`, `release-notes/` and every other script never cut an alpha on their own.
`tests/release-workflows-alpha-cut.test.ts` fails when the build starts running a script the list misses, unless `BUILD_SCRIPTS_THAT_SHIP_NOTHING` names it with a reason.

A skipped merge is not lost: the next alpha that cuts carries it, and that alpha's notes check covers its note or exclusion.
A failed or cancelled alpha publishes no tag, so the next run still finds the change and cuts.
Main's full check still runs on every merge that changes more than the phone app or the docs, and its green mark still moves.
Skipped runs leave gaps in the alpha numbers, which already skip run numbers.
Manual alpha requests, recoveries, rehearsals and stable promotions never skip.

Main's next check waits while an alpha is cut, so merges made meanwhile queue and are checked together once the cut ends (`docs/testing.md`, "Main's desktop release check").
Each rolling alpha run is named "Alpha from main run N" after the main run it cuts from, which is how that wait and the alpha's own gate find it: every release run starts by dispatch, so only the name tells a rolling alpha apart.
It runs in the concurrency group `rolling-alpha-from-main-run-N`, where that wait sits on no machine until the run ends; no other release run shares the group.

### Pausing the rolling pipeline

The captain can pause the automatic pipeline and resume it later (PERS-51, the captain: "add a "pause/resume" button on the rolling alpha panel for me to pause/resume the rolling pipeline manually").
The pause is the repository variable `ROLLING_ALPHA_PAUSED`: `true` pauses, and any other value or no variable leaves the pipeline running.
While it is `true`:

1. **Main checks stop.**
   A main check a push started cancels itself in its first job, `alpha-wait.yml`, before any other check behind it starts, and its summary says "Paused by the captain".
   A cancelled check never moves main's green mark and never cuts an alpha.
   A main check started by hand still runs.
2. **Rolling alphas hold.**
   The resolve job's first step ends a rolling alpha run green with "Paused by the captain" ("An alpha with nothing new to build", above).
   An alpha already past that step finishes.
3. **Everything else carries on.**
   Merging and pull request checks continue, and manual alphas, recoveries, rehearsals and stable promotions ignore the variable.

GitHub reads a variable only when a job starts, so the variable alone cannot stop a check that is already running.
Pausing therefore sets the variable and also cancels main's running and waiting checks, the captain's answer "stop now, also cancel the running check".
The pause lasts until Resume, which clears the variable and re-runs nothing, the captain's answer "the next merge starts a check that covers the pause".
The next merge's check runs at main's head, so it covers every merge made during the pause, and its alpha carries their notes.
`tests/release-workflows-alpha-cut.test.ts` holds both steps.

### An alpha does not wait on the phone check

An alpha ships the signed desktop app only (INF-2353, the captain's pick "Drop phone from alpha gate", asked as "alpha is the desktop app, right?"), and main runs no phone check at all (INF-2492, the captain: "remove phone check from main altogether. we run all phone check parts at release").
`scripts/main-alpha-proof.mjs` therefore reads every job of the main run, and `release.yml`'s resolve job starts only on a successful one.
The phone's own gates run where the phone ships: `ios-release.yml` runs every part on iPhone and iPad before a TestFlight upload, and the release's phone job still waits for a TestFlight build ("The phone goes first", below).

For a failed release's recovery, a manual alpha request can name `candidate=<exact source>` and `verified_main_run=<successful main run id>`; the resolver reads and validates that proof again.
A manual candidate without reusable proof follows the existing full-verification route, including its notes-only candidate and release-specific gates.
Neither passing main nor automatic publication authorizes merging an unrelated pull request or changing stable's captain-selected highlights.

## The phone goes first

A phone updates more slowly than the desktop app, so a desktop release waits for a phone build that keeps changing things on it (INF-1649).
The captain's words: "alpha desktop builds wait for phone build is on testflight. stable desktop releases wait for phone builds are live in app store (which we haven't done yet, so enforce this only once the first ios app release is live in app store)".
A phone build keeps changing things on a release when the release's view floor reaches the phone's contract, or the phone's own floor reaches the release's (`docs/contract.md`, "The version rule").

- **Alpha.**
  The release run's phone job (`scripts/phone-order.ts`) looks for such a build on TestFlight: an `ios-release.yml` run whose availability job passed, also while its external testing job still runs, or a later status check of its build that passed.
  The release-notes checks start only after the phone job passes; the shared release workflow applies this order to stable releases too.
  A build Apple once confirmed stays enough, and the job does not ask Apple whether it is still on TestFlight (the captain's "A past success is enough").
  A major that kept views leaves the build already on TestFlight enough, so the alpha waits for nothing.
  After a major that broke views, the release crewmate dispatches `ios-release.yml` from main first, with the next phone version, and dispatches the alpha once its availability job has passed.
  The change that moves the major or the view floor is flagged earlier, by its branch check's phone contract flag, and its story carries that phone build as an after-merge step (`docs/testing.md`, "What a pull request runs").
- **Stable.**
  The phone job asks Apple which phone build is live in the App Store and waits for one that keeps changing things on the stable.
  Until Apple shows that a version of Infinitary was ever released in the App Store, a stable waits for no phone.
  Once one was, a stable always waits for such a build, also while a withdrawn version leaves none live.

The Linux packages and the desktop checks wait for the phone job too, so a failed phone job spends no hosted machine minutes on packages that can never publish (INF-3059).
Only an answer about the phone builds fails the phone job: a server error (HTTP 5xx, 408 or 429) or a lost connection from GitHub says nothing about them, so each read waits it out, 30 seconds apart, for up to 30 minutes, naming each wait in the job's log, as the keyless downloads do (INF-4061: an alpha failed on one 502 while a build that fit was on TestFlight).
Any other answer, such as a 404, or an answer that is not JSON, fails the job at once, and its time limit leaves room for one such wait.
Without such a build the phone job fails, and the release job neither signs nor publishes anything; a rehearsal says what it would wait for and never fails on it.

## Promoting an alpha

Every stable is a published alpha rebuilt as stable (captain, FI3-424): the same code, tested as the alpha, never whatever main holds.
Builds are not byte-for-byte repeatable, so "the same code" means the alpha's commit and lockfile with its stable version.
A promotion opens no pull request (captain, FI3-1057).
The captain's words "promote the current alpha" start one, and its crewmate first has the captain pick the stable's three highlights on a card.

A release crewmate sends `"return_run_details": true` with its GitHub dispatch; an accepted answer with `workflow_run_id` starts the app's minute watch automatically.
It confirms the run's version through `github_read` and ends its turn when the answer says the watch stands.
If the accepted answer supplies no run number, it finds the run through `github_read`, confirms its version, and calls `read_workflow` with `runId` alone.
That short read saves the app's minute watch while the run goes on: end the turn, never sleep or loop on run reads.
The app wakes the crewmate on the first failed job and when the run ends, up to three hours (`docs/forge.md`, "The run watch").
Read the named job's log on a failure wake; a release run outcome is not a pull request green reading or permission to merge.

1. **Pick the highlights.**
   The captain picks the three highlights a stable shows, from every change since the last stable (captain, FI3-1392); each alpha review's ranks stay with its alpha users.
   Before anything runs, the crewmate preparing the promotion builds the stable's catalog the way the release run does, with the alpha's own tooling, in a scratch working copy at the alpha's tag (`git worktree add --detach <copy> v<alpha>`): `node <copy>/scripts/release-notes.ts generate --version <X.Y.Z> --source HEAD --out <dir>/release-notes.json`.
   The script does not start through a path with a symbolic link in it, such as macOS's `/tmp`, so the copy lives at a real path.
   From main, `node scripts/release-notes.ts stable-highlights --catalog <dir>/release-notes.json` lists every change since the last stable, with the rank each alpha review gave it and whether it has a hero picture.
   The crewmate puts up one decision card titled for the stable, with three required slots: 01, the lead, then 02 and 03.
   Each slot lists every one of those changes, the lead's only the ones with a picture, and the card shows each change's hero picture beside its title.
   It marks one recommendation per slot by the release review's rule (`docs/release-notes.md` "Who writes what"): a new feature most people will see, over a fix or a niche case.
   It starts nothing until the captain picks, and the captain's picks, lead first, are the run's `highlights`.
2. **Start.**
   `gh workflow run release.yml --ref main -f channel=stable -f promote=<alpha version> -f highlights=<lead>,<second>,<third>` (for example `0.1.31-alpha.40`, and the picked changes' entry ids).
   The resolver refuses unless the alpha has a source tag `v<alpha>`, its numeric core is newer than the latest stable, and it carries a feat, fix or breaking change since that stable.
   It also refuses a live stable without highlights, and highlights that are not one to three different entry ids.
   The resolve job then refuses unless the alpha's release run has every lane's latest execution passed, its journeys part passed beside validated exact-source main proof, or it ran no lane beside proof that carried every journey ("Full alpha checks, inherited stable checks").
3. **Release.**
   The run builds the alpha tag's own commit as the alpha's numeric core, `X.Y.Z`, signs and publishes it, and tags `vX.Y.Z` on that same commit.
   Its notes job writes the picks into the stable's catalog as its only highlights, in order, and clears every other rank (`docs/release-notes.md` "The release check").
   That step runs the tooling of the workflow's own commit, because the alpha's commit may predate it; the alpha's own `verify-package` then checks the result.
   It refuses a lead with no hero picture, a pick from outside the changes since the last stable, and a count of picks other than its slots: three, or one per change when there are fewer.
   The words of every change and `release-notes/` stay the alpha's.
   If a gate fails nothing publishes; dispatching the same promotion again keeps whatever that version already published.
   The public notes name the promoted alpha, and the source release names the picks.
4. **Record.**
   The stable's record rides with the next alpha's review commit, which the notes check asks for.
   It keeps the picks, as the stable's source release names them: `node scripts/release-notes.ts manifest --version <X.Y.Z> --highlights <picks> --write`.
   Pinning a promoted stable without `--highlights` is refused.
5. **Confirm the announcement.**
   After the release run ends, the crewmate reads the `release-announce` run that followed it and reports its result ("Announcing a stable").
   If no announcement run started within 10 minutes of the release run's end, it dispatches one: `gh workflow run release-announce.yml --ref main -f mode=normal -f version=<X.Y.Z>`; the claim keeps a second run from posting again.
   An `ambiguous` result is reported, never replayed by the crewmate on its own.

The next alpha is numbered from the new stable tag ("The signed channel workflow"); no rolling alpha cuts while the promotion or its rehearsal runs ("An alpha with nothing new to build").
A stable rehearsal (`release.yml -f channel=stable -f dry_run=true`) promotes an alpha the same way, or builds the dispatched commit as the next stable when it names none, and publishes nothing.
It may leave `highlights` empty to keep the alpha reviews' ranks.

## Announcing a stable

Each stable posts one message to the project's Discord channel, and an alpha or a rehearsal posts nothing (`.github/workflows/release-announce.yml`, `scripts/release-announce.ts`).
The message shows the stable's three picked highlights, lead first, each with its title and the first sentence of its note, the lead's dark hero picture, and links to the version's own What's new page (`/whats-new/0-8-7/` for 0.8.7) and to the download page.
It mentions nobody: `allowed_mentions` is empty.

The workflow follows every release run's end, as the docs site's publish does, and runs only in this project, on main, for the operator, after a successful release run on main.
Its one job runs on a machine GitHub hosts, in the `release-announcement` environment, limited to main, which holds the webhook as `INFINITARY_DISCORD_RELEASE_WEBHOOK_URL`.
Runs queue one at a time and are never cancelled midway.
Every check comes before the post, and the first that fails stops the run with nothing posted:

1. The release run counts only when its latest jobs include one named `Requested stable · …`; otherwise the run ends green as `not_stable`.
2. The version is the latest release's tag, exactly `vX.Y.Z`, not a draft or prerelease, published between the release run's start and end.
3. The highlights are the `Highlights picked, lead first:` line of the stable's record, which the release run writes; each pick's words and the lead's picture come from `release-notes/changes/` at the stable's tag, and the picture is linked as the public file at that tag.
4. The message must fit Discord's limits.
5. A missing webhook stops the run red as `no_webhook` before anything is claimed.
6. It waits up to 30 minutes for the docs site to serve the version's own page (`https://docs.getinfinitary.com/whats-new/0-8-7/` for 0.8.7), reading past any cache, and otherwise stops red as `whats_new_not_listed`.
7. It claims the version by creating `refs/announcements/discord/v<version>` at the tag's commit.
   GitHub creates a ref only once, so only the run that created it may post.
   If the claim already exists and `refs/announcements/discord-posted/v<version>` does too, the run ends green as `already_announced`; with no posted marker it stops red as `ambiguous`.
   Any other answer, such as a rule refusing the name, stops red as `github_error` with nothing posted.
8. It posts once, with `?wait=true`, and on Discord's answer with a message id prints the id, then creates the posted marker, a ref to an annotated tag holding the message id and the payload's SHA-256.

Discord's other answers:

- A refusal (a 4xx other than 429) releases the claim and stops red as `refused`, so a later normal run may try again.
- A 429 waits its `retry_after` once and posts again; a second 429 counts as a refusal.
- A timeout, a lost connection, a 5xx or a success without a message id keeps the claim and stops red as `ambiguous`.
  Nothing retries it: a person checks the channel, and only if the stable is not there replays it.

The markers' one writer is this workflow; neither is in the tag list, and the release readers, which match only `vX.Y.Z`, never see them.
Nothing here reads a list of past announcements or writes issues.

Requests, from main:

- `gh workflow run release-announce.yml --ref main -f mode=preview -f version=<X.Y.Z>` prints the message in the run's summary and posts nothing; it reads no webhook.
- `-f mode=normal -f version=<X.Y.Z>` announces the newest stable, the same way a release run does; any other version is refused as `not_latest`.
- `-f mode=replay -f version=<X.Y.Z>`, only after a person checked the channel, posts a version that is claimed with no posted marker, once, and writes the marker.
  A version with no claim is refused, and one already posted ends as `already_announced`.

If a post succeeded but its marker could not be written, the run says so with the message id and keeps the claim, so nothing posts it again; create the marker by hand with the same name.

## Activating the channels

A request for “a release” that names no channel means Alpha; “a stable release” names Stable.
The workflow's own default remains Stable, so an operator always supplies the intended channel explicitly.
An automatic alpha changes no project source; a manual release and a stable promotion follow the candidate and promotion rules above.
When a release review rechecks old crew filings, its report names every checked key, the evidence for its fate, and the keys it left unchecked (`docs/task-graph.md`).

Before activation, the storage owner provisions the bucket, download Worker and domain, verifies conditional writes and unsigned downloads, and supplies the R2 settings through the approved credential recipient.
Neither a build nor storage activation changes the source repository’s visibility.
An updater-capable alpha must pass its update check before Stable may promote it.
The first new publication creates the selected feed snapshot only after public artifacts pass fetch-back.
Keep the Homebrew casks publishing alongside direct installers; neither a shared tap nor its historical downloads is retired.

## The update check

Every alpha, a dry run included, proves on Apple silicon that the version alpha subscribers have now updates to it (INF-1900, the captain's direction D).
`.github/workflows/mac-update.yml` runs `scripts/check-update-from-alpha.mjs` in a placement-service virtual Mac, on the `release_light` kind's queue in a publishing release, otherwise the `light` kind's or `mini-mac-virtual` (`docs/testing.md`, "Each Mac job's kind and size").
Intel is a best-effort side effect of the universal build: no release runs a hosted Mac for it (the captain, INF-1900).
It reads the published alpha feed, `feeds/alpha-mac.yml`, for the version alpha subscribers have now, which is a promoted stable right after a promotion.
It downloads that version's public disk image, checks it against its published checksum and copies the app into `/Applications` the way a person installs it, with its direct-installation receipt.
It then serves a local copy of the alpha feed that offers the release, under the same private local root, hosts entry and isolation guard as the five-copy check below; no production override enters either app.

The `update` job runs after the signing job and every check, from its handoff, and publication waits for it.
It is the release's only update check: the rehearsal that ran before signing repeated only its first checks, so INF-2498's plan removed it.

- The handoff's zip must be the one the signing job handed over.
- The release must be newer than the version alpha subscribers have, or the check stops before installing anything and names both versions.
- The installed app must trust the local feed and offer the release on Alpha without downloading anything before consent.
- A real streaming turn through a local custom connection is running when the installed app takes the update; the release's own signed zip must replace it natively, the app must restart on its own as the new version on Alpha, with a valid signature and its direct receipt.
  The live reply must stop before the replacement, and the captain's message and a personal draft must survive.

ShipIt restarts the app with no inspector, so the check stops that copy and launches the app again with one (`scripts/installer-app.ts`).
It stops the restarted copy only once its main process has started a renderer, the process that draws its page, so it never stops that copy early in its start.
After the app's main process ends, the check waits until every process from the app's bundle but ShipIt has ended before it launches again.
A process still running after 30 s is recorded as `Processes left after the app stopped`, with its kind, parent, age and state, and then ended.
Every launch the check makes writes Chromium's own warnings and errors to `application.log` beside the app's lines.
A launch that shows no page, or a restarted copy that starts none, keeps what the app was doing before cleanup removes the scratch home, in files named for the launch.
They hold the inspector's targets of every kind, the app's processes, a three-second sample of each main process and renderer, the app's stall and memory records and five minutes of the system log for its processes.
The failure's own record names the facts read from them in one line, such as the deepest frame each sampled main thread stayed in.
A failed check also keeps the app's stall and memory records at cleanup; the app's database never leaves the disposable Mac.
Cleanup removes the app's saved data before the rest of the scratch home, and that removal must succeed, here and in the five-copy check below (`removeScratchHome`, `scripts/installer-app.ts`).
Programs outside the app's bundle that ran with the scratch home, such as macOS's own agents, write into it on their own schedule, so one may write while the home is removed, which the system refuses with `ENOTEMPTY`.
Such a write leaves the rest of the home for the disposable Mac and is recorded as `Scratch home written while removed`, naming each file or empty folder still there; saved data that came back still fails the check.

The check builds nothing, signs nothing and sends nothing to Apple; its observations are kept as `update-evidence-*` artifacts.
GitHub ends a job as lost when the runner's lease renewals stop reaching its job service, even after every step passed, and the virtual Mac's runner log is deleted with it.
So the job's next step, `scripts/runner-link-readings.ts`, reads the runner's own renewals from its diagnostics folder and waits out one more renewal when the last is overdue.
It also probes the virtual Mac's path to the job service and the results service by name, address, route and open connections.
It prints a summary, warns on a missed renewal, a listener error or a failed probe, keeps `runner-link.json` beside the other observations and never fails the job.
The saved work is created by the installed published app itself, through its own interface, because an older app refuses a database a newer build wrote.
A stable inherits its alpha's update check and does not run it.

The five-copy check below stays available on request.
In the legacy private repository, a pull request that changes Electron or `electron-updater`, update code, signing, packaging or shutdown runs the five-copy check before merging through `verify.yml` with `installer_only=true`.
On `infinitary-apps`, the first alpha and subsequent alphas with changes to installer inputs must pass this check after merge and before any uploads.
The installer inputs are what the check guards, compared with the previous release (`signedInstallerChanges`, `scripts/desktop-build.ts`): the Mac update code, including the update file Mac shares with Linux and Windows, but not the builds file only Linux and Windows read (`src/core/update/releaseBuilds.ts`); the `electron`, `electron-updater` or `electron-builder` version, or a patch to the updater library, Electron or the universal merge; the app's own executables the packaging steps place and the receipt they write; signing and notarization; and app shutdown.
In `electron-builder.yml` only the `appId`, `productName`, `mac`, `afterPack`, `afterSign`, `electronFuses`, `publish` and `dmg` settings count, so a copyright line, a license file the app carries or a comment does not.
Every other alpha, the check's own workflow and fixtures included, relies on the update check, and the release log names the inputs that held it.
It signs only merged code from protected `main`; for a notes-only candidate it uses the merged base after verifying that nothing outside `release-notes/` differs.
Its Apple silicon check must pass, and a failure or skip holds publication; no Intel Mac runs it (INF-5571), so Intel stays a best-effort side effect of the universal build here too.
A stable promotes an already published alpha, not a branch build.
The update check covers only the path from the current alpha to the release; channel switching, refused downloads, the read-only disk image, the saved-work handover and Homebrew are the five-copy check's.

## Isolated signed verification

`verify.yml` with `installer_only=true` invokes `mac-installer.yml` and runs no personal-Mac signing job.
A fresh manual run in `infinitary-apps` must use the exact commit of its protected `main` dispatch.
The build and the Apple silicon check request the `build` and `light` kinds' queues, or the placement service's `mini-mac-virtual` virtual-only label where those have none; a publishing release hands the build its `release_build` kind's queue instead (`docs/testing.md`, "Each Mac job's kind and size").
The installed check runs on Apple silicon only: no Intel Mac runs it.
A fresh build checks its own copies in the build job, on the Mac that built them, after it removes the signing material and returns to the runner's own home without the signing home's variables.
Handing the copies to a separate check job meant uploading about 3.7 GB over the Mac mini's uplink and downloading them back, about 23 minutes of each check, while the build's place kept a release's signing job waiting.
The build job keeps the signed copies as an artifact only when that check fails, for one day, so a repair can reuse them (below); the separate installed job runs only for a reuse.
The workflow uses existing Apple credentials only in disposable Actions Macs, under a scratch signing home, and publishes nothing.
Before installation, signing or trust changes, `scripts/installer-environment.ts` refuses local execution and requires the kernel's virtual-machine reading on a self-hosted runner; the physical Mac cannot substitute for a guest.
`scripts/installer-signing.mjs` repeats that guard and keeps passwords off command lines.
It creates the scratch home's `Library/Preferences` before writing the keychain search list, because Security does not create that parent directory.
Before packaging, it checks the disposable identity's search-list visibility and signs and verifies a throwaway executable; finding the certificate alone is not signing proof.
It builds real release binaries at ordered fixture versions, notarizes them, and tests the actual native updater on Apple silicon.
Each version builds into its own folder and is sent to Apple as soon as it passes the signed check; its notarization, Gatekeeper check, kept zip and disk image finish in the background while the next version builds (`scripts/build-installer-fixtures.sh`).
The step waits for every version's finishing and fails, naming the versions, when any one failed.
The invalid-signature copy is not built or uploaded: the installed check makes it from the next alpha's zip after checking that zip's recorded digest, adds one byte to its `app.asar` and records the new zip's own digest (`scripts/installer-tampered-copy.ts`).
The packager's automatic notarization is disabled: `scripts/installer-notarize.ts`, the guarded entry to the release's `scripts/notarize.ts`, submits each app and disk image once, saves its submission ID and artifact digest, and reads that same submission until Apple accepts or rejects it.
The upload streams normal output and saves the assigned ID before the upload finishes; JSON output would withhold it until the command ends.
Uploads use the enclosing workflow's time limit, not the two-minute deadline for status and ticket commands.
If saving an ID fails, the script stops its upload child and reports that failure; it never continues without the journal.
Recorded transport failures get bounded retries for status reads and ticket attachment, never a second upload; an upload without a confirmed ID remains explicitly unknown.
A changed artifact cannot reuse another artifact's submission.
Only acceptance followed by ticket attachment and validation passes, and signature and Gatekeeper checks remain required.
Failed requests capture the guest's network interfaces, default route and power assertions beside the submission journal, which the workflow retains even on failure.
The status wait has a thirty-minute budget per artifact; transport retries wait fifteen seconds, thirty seconds, then one minute three times, within the workflow's existing limit.
Before redirecting GitHub, the probe prepares Homebrew's Ruby runtime and real `homebrew/core` tap, retaining the tap's commit in its observations.
The API-disabled cask upgrade needs that core metadata even though Infinitary has no formula dependency; a missing tap is fetched while public GitHub is still reachable, never replaced with an empty tap, and its one-time clone has fifteen minutes.
A temporary local HTTPS server supplies the normal production addresses inside those disposable machines; no production feed override or disabled signature check enters the app.
A hosts entry sends those addresses to the server's loopback address (`scripts/installer-hosts.ts`, shared with the update check).
The Mac's resolver takes in a changed hosts file only when its watch on the file reports the write, and emptying its cache never rereads the file, so the check restarts the resolver, which reads the file as it starts.
It then waits until the resolver answers every rerouted address with the loopback address before reading a feed, and a wait that runs out names what the resolver answered.
The server uses the same isolation guard and inherits only the runner's actual `GITHUB_ACTIONS` and `RUNNER_ENVIRONMENT` facts alongside the restricted scratch environment, never a claimed hosted identity or the parent's signing credentials.
Those admission facts go only to the verification server; the installed application's environment stays separate.
The installed app uses the existing virtual-Mac drawing switches in a guest, avoiding the paravirtualized Metal stall described in `docs/testing.md`, "Drawing in software".
The installed probe creates its own scratch preferences directory, reads back the trust-keychain search list, and requires both the system HTTPS reader and the installed app to accept the fixture feed before preparing active work.
The disposable app environment sets `NODE_USE_SYSTEM_CA=1` so Node's Homebrew metadata reader uses the same registered system root; the value must be exactly `1`.
The release's disabled node-options fuse strips `NODE_EXTRA_CA_CERTS`, so the fixture does not rely on that variable or change the fuse.
One environment builder supplies both direct launches and the guest's LaunchServices values, which cleanup restores or unsets; the opt-in also reaches the fixture app's child processes.
This opt-in is confined to disposable verification, retains certificate and hostname checks, and does not make an unregistered root trusted.
The active-work setup, status reads and cleanup waits record their phases and have limits; the probe records a failure before starting cleanup.
Between fresh-install scenarios, the probe stops the app and removes only the download cache named by `packaging/app-update.yml`, so a previous download cannot bypass the next scenario's transport check.
It leaves the shared `Library/Caches` directory and other cache owners intact; stopping the app's main process does not establish that every macOS cache writer has stopped.
The fixture certificate is registered in the disposable System keychain and must appear in the admin trust listing; cleanup deletes that certificate by SHA-1 rather than removing the last admin trust record.
Independent cleanup continues after an error and never replaces the original proof failure.
While a native replacement is awaited, the probe samples from outside the signed app every two seconds and appends each change to `install-stages.jsonl`: whether the app and ShipIt are running, the installed version, and the app's update phase and problem while its page answers.
A replacement that never arrives keeps the app's last status reading, ShipIt's `ShipIt_stderr.log`, `ShipIt_stdout.log` and `ShipItState.plist` from the scratch home, and ten minutes of the system log for ShipIt, Infinitary and Squirrel; cleanup also keeps ShipIt's files before removing the scratch home.
The app itself is unchanged, so this tracing never voids reused signed copies.
The installed-version reader pins the archive with a temporary hard link on the same volume, so replacement cannot mix one archive's header with another's contents; a missing archive remains unobserved and malformed contents still fail.
The saved-work handover must finish with both copies intact, the original retired and refused, and the new folder openable; the recovery copy is never expected to disappear.
The proof exercises fresh copies, alpha-to-alpha with unchanged numeric bundle versions, alpha-to-promoted-stable-to-next-alpha, stable-to-stable, no-downgrade switching, cancellation, corrupt bytes, invalid signatures, permissions, read-only images and the saved-work handover from Firstmate 3000 to Infinitary.
An unwritable copy's refusal withdraws Update and restart for the rest of that run, so the probe starts the restored copy again before it checks cancellation.
It temporarily removes Homebrew's standard entrypoints on each disposable machine for the native-update checks, then restores them for signed Homebrew installation and upgrade checks.
`scripts/check-installed-homebrew.mjs` runs generated Stable and Alpha casks from both supported taps against the signed ZIPs, using disposable local taps and cached artifacts.
Homebrew 6 refuses to load casks from an untrusted tap, so where Homebrew has the `trust` command the check trusts each disposable tap, whole, in the scratch home's trust store before reading its casks; an older Homebrew loads them without trust.
It checks quarantine, the per-copy receipt, signature and notarization after installation and upgrade; the running Homebrew app must show its own command and refuse native replacement.
Failed fixture commands retain their exit status, signal and standard error or, when that is empty, standard output.
The build job validates each stapled ticket with Apple once; installed checks then require the installed `Contents/CodeResources` to exist and match the fixture ZIP's ticket bytes, alongside the signature and Gatekeeper checks.
They do not repeat Apple's online ticket lookup, which can lose its network on a hosted runner; a missing, changed or unreadable ticket fails and records both sides without a retry.
Uninstalling without `--zap` and installing the direct copy must retain the saved task and draft and restore direct ownership and in-app channels.
A real streaming turn through a local custom connection must stop before replacement, and its message must survive restart alongside a saved task and personal draft.
Its observed transcript and pictures are artifacts; fixtures and signing material are not released.
Hermetic UI journeys and unit tests do not substitute for this signed proof.

### Reusing signed verification copies

A test-setup repair can reuse existing signed copies without another build or Apple submission when the reviewing agent has established that the application behavior is unchanged.
This is not an automatic judgment from file names: the agent reviews every difference, including packaged inputs and the embedded source record.
An application change needs new signed copies instead.
The original copies keep their original embedded source and signatures; a reuse run records its newer verification source separately and never presents those copies as a new build.

A `verify.yml` dispatch selects `installer_only=true` and supplies `installer_reuse` as a JSON object with `runId`, `artifactId`, `artifactSha256`, `sourceHead`, `checkHead`, `changedPaths`, `sameApplication: true` and a nonempty `applicability` explanation.
The two heads are full commit IDs, and `changedPaths` lists every difference between them, not only the files the agent most recently edited.
A nonempty reuse declaration also selects installer-only mode itself, so it never starts the unrelated full-verification lanes.
The normal release call supplies no declaration and still builds fresh copies.
Preparing this route does not itself authorize a verification run, new signing or publication.

`scripts/installer-reuse.ts` checks the clean checkout and exact declared differences, then reads the original run, artifact and successful build through the job's read-only GitHub access.
The artifact must belong to that run and workflow version and have been created during the original build job, whose signing step passed; that job's own installed check, which is why it kept the copies, may have failed.
The selected artifact ID and SHA-256 are explicit, and an expired, missing or changed artifact fails rather than silently starting a build.
The download streams to disk, matches GitHub's byte count and the declared archive digest, and forwards no GitHub sign-in header to the download host.
The standard Python ZIP64 reader extracts only the producer's exact flat file inventory, refusing duplicates, special files, encrypted members and paths outside that inventory.
Every fixture's bytes must match its recorded size and both digests, the fixture roles must match the current test's roles, and every app ZIP must retain the declared original source in its embedded source record.
The temporary outer archive is removed after verification; the existing app ZIPs and disk images are not modified.

The installed job then runs the same complete native and Homebrew scenarios as a fresh build, with no signing credentials restored.
The evidence retains the compatibility declaration, original run and artifact, original source and newer check source; the temporary Homebrew metadata also names the original signed source.
Reuse neither waives an installed check nor establishes a new signed pass until those checks actually complete.

## The alpha notice

`packaging/alpha-notice.txt` remains the one home of the alpha notice and appears on every release's notes.
Its Diagnostics disclosure and opt-out remain unchanged (`docs/sharing.md`).
A reviewed wording change reaches new releases; historical releases are never silently rewritten.

## Versions

The alpha ships as 0.x and the public beta stays 0.x (captain decision 2026-09-21); there is no 1.0.0 at the beta gate.
A breaking change takes the next minor, never the next major, so every release stays on the 0.x line.
The tag stays bare (`vX.Y.Z`, never a component prefix) and the release's logical version is read off it.

Versions live in tags alone ("The signed channel workflow"): an alpha is the newest stable tag's next patch or minor, numbered by the workflow run, and a stable is its alpha's numeric core.
A repository that starts again from one commit has no tags of its own; it numbers from the record of past releases instead, above every version either channel published before it, and never tags an archived version (`docs/release-notes.md` "A fresh history").
`package.json`'s version and `CHANGELOG.md` stopped changing at stable 0.1.30; do not hand-edit either.
Plain merge titles are refused.
A stable with nothing to release is the captain's call.

Which release first carried a change is read from its commit, never from a date: `git merge-base --is-ancestor <commit> v<version>` answers it for each fetched tag, and a stable carries exactly what its alpha's commit does.
An installed app's version is the logical one in the `package.json` inside its `app.asar` (the running app's `app.getVersion()`); Get Info and `Info.plist` show only the numeric core ("Two version identities" above).
The build that showed a given card is in that card's observations (`card_observations.build`, `docs/card-evidence.md`).

## Operator steps (the captain's, once)

1. Confirm the five Apple secrets listed in `docs/architecture.md` and public readability of the selected download repository.
   A separate destination also needs `PUBLIC_RELEASE_TOKEN`; the selected source repository uses its workflow token.
2. Rehearse the release with `dry_run=true`, which runs the update check.
   Neither verification nor rehearsal publishes a release or changes visibility.
3. Let a rolling-main run that passed cut its exact source as an alpha, or promote a verified updater-capable alpha with the captain's selected highlights.
   Publication verifies both public Mac downloads and every Linux file before advancing feeds.

## Before the public beta

A checklist the beta gate walks, each item dated when it was added.
An item is done when its result is recorded where it names; it is never ticked here.

- [ ] **Re-read Anthropic's pages on the Claude seat** (added 2026-09-26, the owner's Q8 a on W1: the Claude seat ships in every build, and the beta re-reads the terms).
  Read the Claude Agent SDK overview, Anthropic's legal and usage page, and the Help Center's usage-limits note again.
  Record the reading as a new dated entry under "The terms" in `docs/architecture.md` §16.1 - never an edit of an older one - and confirm the Claude seat still ships, or escalate to the captain before the beta.

## Verification owners

- `src/core/update/macUpdates.test.ts` owns subscription persistence, consent, ordering, stale replies, cancellation and staged-restart recovery.
- `src/main/host/macUpdates.test.ts` owns native configuration, writable-install checks, signature failure and shutdown ordering.
- `src/core/update/releaseFeeds.test.ts` exercises the actual updater metadata parser, immutable manifests and channel advancement.
- `tests/e2e/mac-updates.spec.ts` drives keyboard selection, restart persistence, progress, recovery, cancellation, Saving work and Update later through the hermetic app.
- `src/core/orchestrator/crewSessions.reopen.test.ts` ("saving work before this computer's update") owns the hold, the safe stop, a later turn of a task already stopped, Update later and the carry-on after the restart, and a later turn on a computer that runs work held by the same row; `tests/helpers/sessionContract.ts` owns each backend's safe stop.
- `src/core/update/linuxInstall.test.ts` and `src/core/update/updateChecker.test.ts` own the Linux save before replacement and its Update later.
- The `tests/release-workflows-*.test.ts` files evaluate the release workflow's conditions, promotion evidence and no-publication rehearsals.
- `tests/e2e/installed-update-work.spec.ts` checks that a fresh app accepts the proof's local connection and message while its real provider stream stays open, then retains the message after stopping.
- `tests/installed-update-fixtures.test.ts` exercises coherent archive reads across an ordered replacement and the real saved-work mover's retained recovery copy.
- `scripts/check-update-from-alpha.mjs` updates the published alpha to each release's own signed zip in a disposable Apple silicon virtual Mac.
- `scripts/check-installed-updates.mjs` observes real signed replacement and saved work in disposable Actions Macs, on request; `scripts/check-installed-homebrew.mjs` checks signed cask updates and installation-method handover; `scripts/verify-mac-dmg.sh` verifies the finalized installer against its ZIP.
- Cask producer, republication and isolated real-Homebrew consumer tests gate the Homebrew path, including the per-copy receipt and refusal of native update effects.
  The consumer runs the generated install hooks on quarantined disposable apps and verifies that only the ownership receipt changes, preserving quarantine, other metadata and app bytes.

### Checking older Homebrew consumers

`INFINITARY_CASK_HOMEBREW_VERSIONS=5.1.13,5.1.14,6.0.14,6.0.15,current pnpm test tests/cask-consumers.test.ts` runs the cask journeys on each version: installation, upgrade and channel switching, upgrading through republished targets, and the old-cask migration.
The source Homebrew repository must already contain those tags and their matching vendored Ruby versions; the test checks them out only in its scratch clone and never fetches or updates the source.
For archived versions with different Ruby requirements, run each version separately with `INFINITARY_CASK_HOMEBREW_REPOSITORY=<prepared-repository>` pointing at an offline-ready Homebrew copy for that tag.
Without that variable the test uses the installed version.
`INFINITARY_CASK_PRETRUST_VERSION=5.1.14 INFINITARY_CASK_HOMEBREW_VERSIONS=5.1.14,6.0.0,7.0.11 pnpm test tests/cask-consumers.test.ts -t "executes the offered upgrade"` installs before tap trust, then runs the app's complete offered command under each selected Homebrew, on both channels and both taps.
That regression uses the scratch clone's compatible Ruby, local Git sources for `brew update`, and cached stand-in downloads; it verifies the installed version, channel marker, saved work and cask-only trust.
Its default run revokes scratch tap trust after installation to reproduce the same untrusted state without requiring historical Homebrew tags.
Every version runs with `HOMEBREW_DEVELOPER=1`, so current Homebrew also proves the deprecated block is not evaluated.
