---
title: Update and remove Infinitary
description: How each kind of installation gets a new stable version, and how to remove Infinitary while keeping your saved work.
---

Infinitary checks for a new stable version every few hours.
Checking downloads nothing, and nothing installs until you choose it.
An update keeps your saved work.

## When a new version is out

A round button with a down arrow appears at the top right of the window.
Rest the pointer on it to read "Update available" and the new version's number, and press it to see what to do next.
Settings → **General** shows the same, under **Version**.

To check yourself, use any of these:

- **Check for updates** under **Version** in Settings → **General**.
- **Check for updates** in command search.
- On a Mac, **Check for Updates…** in the Infinitary menu.

What to do next depends on how you installed Infinitary.

## A Mac copy from the downloads page

1. Press **Update and restart**.
2. Infinitary downloads the new version and checks its checksum and its Apple signature.
3. It saves your crew's work.
   Running work finishes what it is running first, so nothing is lost.
4. Infinitary restarts on the new version and resumes the work the update paused.

While it waits for running work, **Update later** lets the update go until you choose it again.
Your work carries on.

If Infinitary could not finish restarting, the button reads **Restart**.
Press it again once your running work stops.

Infinitary updates itself only from Applications.
If it runs from the disk image, drag it into Applications, eject the disk image and open the copy in Applications.

## A Mac copy from Homebrew

A copy you installed with Homebrew updates through Homebrew.
The notice shows the command, with **Copy command**:

```sh wrap
brew update && brew upgrade --cask infinitary-labs/tap/infinitary
```

Run it in Terminal.
Homebrew quits Infinitary while it replaces it, so open Infinitary again when it finishes.

## Linux

- **Ubuntu, Debian and Fedora**, from the .deb or .rpm package: press **Install**.
  Infinitary downloads the new version, checks it, saves your crew's work and asks for your password, then starts again.
- **An AppImage**: press **Install**.
  Infinitary replaces the AppImage file with the new version and starts again, with no password.
  It needs to be able to change the folder the AppImage is in.
- **Arch, Omarchy and NixOS** update through their own package manager.
  The notice shows the command, with **Copy command**; run it in a terminal.

If installing cannot finish, nothing changes and your crew's work carries on.
The notice then shows a command that installs the same version by hand.

## Windows

1. Press **Update and restart**.
2. Infinitary downloads the new installer, checks its checksum and saves your crew's work.
3. Infinitary closes, the installer replaces it, and Infinitary opens again on the new version.

If installing cannot finish, nothing changes and your crew's work carries on.

## Your other computers and your phone

A computer you added updates from the computer where your first mate lives.
In Settings → **Devices**, a computer on another version shows **Update** on its row.
It gets this computer's version, and its running work stops for a moment and goes on after.

From a computer that controls your first mate, Settings → **General** has a row for Infinitary on the computer where your first mate lives.
When that computer has an update ready, press **Update** followed by its name to start the update from where you are.
Your phone can start that update too, after it asks you first.
See [Your other computers](/your-other-computers/) and [iPhone and iPad](/iphone-and-ipad/).

## Remove Infinitary

Removing the app leaves your saved work in place, so installing Infinitary again picks up where you left off.
If this computer runs work for another, press **Leave** in Settings → **Devices** first.

- **A Mac copy from the downloads page**: quit Infinitary and move it from Applications to the Trash.
- **A Mac copy from Homebrew**: run `brew uninstall --cask infinitary` in Terminal.
  Never add `--zap`: it deletes your saved work.
- **Linux**: remove the package with the software installer or package manager you installed it with.
  For an AppImage, delete the file.
- **Windows**: in Windows Settings → **Apps** → **Installed apps**, choose **Uninstall** in Infinitary's menu.

Your saved work stays in `~/Library/Application Support/infinitary` on a Mac, in `~/.config/infinitary` on Linux, and in `%APPDATA%\infinitary` on Windows.

### What deletes your saved work

These delete that folder, and what Infinitary kept there goes with it:

- `brew uninstall --zap`.
- An uninstaller app that also removes an app's support files.
- Moving the folder itself to the Trash, or deleting it.

On a computer that runs work for another, that folder holds the computer's own key, its working copies and its tasks' files.
Without it, the computer joins again as a new entry, and work it had not brought home stays lost.
See [A computer is listed twice](/troubleshooting/#a-computer-is-listed-twice).
