---
title: What leaves your computer
description: What Infinitary sends, where it goes, and the one switch that sends anything to us.
---

Infinitary runs on your computer, through the subscriptions you already have.
It needs no account with us, and your work does not pass through us.
This page lists what the app sends, and where.

## Your work goes to the provider you chose

Your first mate and your crew think through the AI subscriptions you signed in to.
Your messages, and what a crewmate reads of your project to do its task, go to that provider through your subscription.
With Claude, Infinitary uses the Claude Code you installed, signed in to your own account.
With a custom provider, it goes to the address you entered.

Your sign-ins stay on your computer.

## Your projects go where they live

A crewmate works in a working copy of your project on your computer.
When a task is offered as a pull request, its branch is pushed to where your project lives, such as GitHub, GitLab or Bitbucket, and the pull request is opened there.
A project kept on this computer only stays on this computer.

When a crewmate prepares a working copy or does its task, it may fetch what your project needs, the way you would by hand.

## Your other computers and your phone

The computers and phones you add talk to the computer where your first mate lives.
Settings → **Devices** says how they find it.
**Over the internet** reads "Never. Infinitary does not open this computer to the internet."

A sign-in you type for another computer goes to that computer once.
The computer where your first mate lives keeps no copy.
See [Your other computers](/your-other-computers/).

## Integrations you connect

An integration you connect in Settings → **Integrations**, such as Google, is reached with its own sign-in, which stays on the computer you signed in on.
Your first mate and your crew read it only once you connect it.
See [Integrations](/integrations/).

## Your company's usage reporting

If your Claude Code settings file or your shell sets up usage reporting for your company, as Claude Code's guide describes, Infinitary sends the usage of all work done here to the same place.
Claude's work goes as the records Claude Code itself would send there.
Every other model's work goes under the same names, with its model, provider, tokens, estimated cost, whether your first mate or a crewmate did it, the kind of work and your Claude Code sign-in's email, never your words, task titles or project names.
Settings → **Usage** names where it goes.
If that place keeps turning Claude's work away, or cannot be reached, that line says so instead.
A setup your company's administrator manages for the whole computer reaches Claude Code directly, as it always did, and Infinitary sends every other model's work there too, the same way.
Either kind of setup gets only Claude's work when it sends its usage over gRPC, and Settings → **Usage** then says so.

## Update checks

Infinitary checks for a newer version every few hours, from the place its releases are published.
That check sends no content of yours and no ID.
The first check each day, and the first each month, also says that it is the first, so Infinitary Labs can count how many computers use Infinitary.
This happens whatever the **Diagnostics** switch says, and a copy installed with Homebrew does not send it.
It downloads a new version only when you choose to update.
You can also press **Check for updates** yourself.
See [Update and remove Infinitary](/update-and-remove/).

## Dictation

Dictation turns your voice into words on your computer.
The first time you use it, it asks before a one-time download of its speech model.

## Diagnostics, the one switch that sends to us

Settings → **General** → **Sharing** has the **Diagnostics** switch.
It is the only switch that sends anything to us; the one thing that reaches us without it is the update check's first-of-the-day and first-of-the-month note above, which **Sharing** also describes.
It is on unless you turn it off, and nothing in the app depends on it.

On your first launch, a notice under the message box says what it sends, with **Turn off** and **OK**.
Nothing is sent until you answer.

Diagnostics sends anonymous usage events:

- the app opening,
- your first mate finishing or failing a turn, with only the kind of failure,
- how far first-time setup has come,
- and, from an iPhone or iPad you added, the app opening, being set up, a message sent and a card answered.

Each event carries the app version and a random install ID.
The ID is tied to nothing about you or your computer, and is replaced whenever Diagnostics is turned off and back on.
No text you wrote, no names and no paths are sent: never a conversation, code or a card.
Your phone sends nothing itself; your computer sends its events under the same switch.

To see exactly what would go, open **What would leave this computer** under **Sharing**.
It shows the install ID, what waits to be sent, what was sent, and every event Diagnostics can send.
Turn **Diagnostics** off, and nothing more is recorded or sent.

## Secrets

Values you keep in Settings → **Secrets** stay on your computer.
Each value goes straight into Secrets: Infinitary never shows it again, and neither the first mate nor the crew gets it.
See [Secrets](/secrets/).
