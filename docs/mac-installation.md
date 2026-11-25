# Installing and updating Infinitary on Mac

## Install without Homebrew

Download the disk image for Stable or Alpha from the release page linked by Infinitary.
Open it, drag Infinitary into Applications, eject the disk image, and open the copy in Applications.
Both channels install the same app and use the same saved work.
The universal app supports Apple silicon and Intel; its minimum macOS version matches the packaged Electron runtime, currently macOS 12 Monterey.
Homebrew is not required for installation or later updates.

## Keep using Homebrew

Homebrew Cask installation and publication remain supported for Stable and Alpha.
Install the cask for the channel you want:

```sh
brew install --cask infinitary-labs/tap/infinitary
# Or choose Alpha instead:
brew install --cask infinitary-labs/tap/infinitary@alpha
```

A Homebrew copy shows its cask's upgrade command with Copy command, never Update and restart.
It reads the update targets published with that cask, including the older cask names for existing Firstmate 3000 installations.
Switch channels through Homebrew, not the in-app channel selector.
Both methods keep the same saved work; the installation method belongs to the running app copy, not its shared data folder.

## Choose a channel in a direct installation

In a disk-image installation, Settings → General shows Update channel beside Version.
Choose Stable for published releases or Alpha for early releases; the controls work with Tab and the arrow keys.
Infinitary saves that choice outside the app before its first update check and keeps an existing explicit choice.
An Alpha subscriber stays on Alpha after receiving a promoted stable release.
Stable never offers an alpha.
If this copy is newer than the chosen channel, Infinitary waits for that channel to catch up rather than installing an older version.
A channel with no published release offers nothing.

Settings → General's Version row and the update notice say where the update stands and offer its next step, Update and restart once a version is available; command search also opens the notice with Show available update, without consenting to installation.
Checking does not download or install anything.
After that choice, Infinitary downloads the ZIP, checks its checksum and Apple signature, stops running work safely, and restarts into the new app.
The notice shows download progress and a readable problem if it cannot finish.
A problem Infinitary cannot fix on that copy withdraws Update and restart and makes Open the releases page the next step.
Changing channels during a download cancels that download and discards its offer.
Once the native updater has staged the replacement, changing channels waits until restart; a failed shutdown leaves Restart available without downloading the update twice.
A copy running from the disk image, a translocated copy, or an installation that cannot be replaced must be copied into a writable Applications location first.

## Move from a Homebrew installation

No final Homebrew upgrade is required.
An existing Infinitary or Firstmate 3000 user can download a disk image directly.
Quit both applications before replacing the installed copy.
The new app keeps Infinitary's saved work and uses the existing one-time Firstmate 3000 folder handover.
It preserves an explicit channel choice and then uses the new download source rather than the old cask's source.

Copying an app does not remove Homebrew's ownership record.
If you still have Homebrew, you may remove only the cask you installed **before** copying the new app:

```sh
brew uninstall --cask infinitary
# Or, only if this is the cask you installed:
brew uninstall --cask infinitary@alpha
brew uninstall --cask firstmate-3000
brew uninstall --cask firstmate-3000@alpha
```

Choose the one matching your installation; do not run every command.
Never add `--zap`: it removes saved work.
Skip this optional cleanup if Homebrew is absent.
After confirming Infinitary has your saved work, an old Firstmate 3000 application can be moved to Trash; do not remove its Library folders yourself.
Keeping an old Homebrew registration means a later explicit Homebrew uninstall or upgrade can still affect that app.
Do not manually replace a newer Alpha with an older Stable: choose Stable inside the app and wait instead.

## Release destinations and historical downloads

`packaging/release-source.json` selects `downloads.getinfinitary.com` and the `getinfinitary.com/alpha-downloads/` address at build time.
The site forwards that address to its official downloads page, `getinfinitary.com/downloads/`; the app keeps naming it, since older copies refuse a builds file that names another release page.
The public source moves to `infinitary-apps` at cutover.
Direct installers and update metadata still live in Cloudflare R2, served through the download Worker.
Until storage is configured, releases keep publishing Homebrew and Linux through the public taps and skip direct disk-image publication.
Partial storage configuration fails rather than silently skipping a configured download path.
No release, hosting setup, visibility change, or remote cask removal follows merely from merging the implementation.
Historical releases on both Homebrew repositories stay available, including downloads used by older paired computers.
New releases continue publishing the Infinitary casks and, for activated channels, the Firstmate 3000 casks alongside direct installers.
Each path verifies its public downloads before advancing its own update metadata; neither replaces the other.
See `docs/alpha.md` for the publication gates and isolated signed verification.

## Per-copy update ownership

Packaging writes the direct-install receipt from `packaging/mac-installation.json` as a custom extended attribute on the final app's `Contents/Info.plist` before signing.
The attribute follows the file when a copy replaces it, unlike attributes on a directory merged in place.
The cask stamps its own tap and channel before moving the app into Applications, so a failed stamp cannot leave a Homebrew copy that looks direct.
It never edits the contents of a signed file.
Copying a disk-image app carries the direct receipt, so another installation's Homebrew registration or shared channel file cannot force that copy through Homebrew.
The installed-app checker routes a Homebrew receipt to the existing cask reader and a direct receipt to the native updater.
The native adapter checks ownership again before checking, downloading or installing, so ownership cannot silently change under existing consent.
A missing, unreadable or unknown receipt permits neither native replacement nor a guessed Homebrew command; Settings explains that reinstalling through either supported method preserves saved work.
