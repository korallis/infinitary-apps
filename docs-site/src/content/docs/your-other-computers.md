---
title: Your other computers
description: Add your other computers so you can control your first mate from any of them, let them run your projects' work, and keep a copy that can take over.
---

Your first mate lives on one computer.
Its tasks, cards and conversation stay there.
From any computer you add, you can control your first mate, and any computer you add can run a project's work.

You find all of this in Settings → **Devices**, under **Your devices**.
Open Settings with ⌘, (Ctrl+, on Linux and Windows).

## The computer where your first mate lives

Pick a computer that stays on as much as possible.
Your other computers and your phone need it awake, with Infinitary open.

While it sleeps or is out of reach:

- Another computer shows the last it saw, and says "Changes are off".
  A message you type there is not sent, and your words stay in the message box until that computer is back.
- Automation runs only while Infinitary is open there and the computer is awake.
  A run missed meanwhile happens once when it returns.

## Add a computer

1. On the computer where your first mate lives, open Settings → **Devices**.
2. Press **+ A computer**.
3. Type the other computer's address and press **Add it**.

Adding a computer by its address is the way to start with: this computer then keeps the other one updated and reaches it by itself, with no visit there after setup.
Type the address you use with SSH for the other computer, such as `you@mini.local`.
Remote Login must be on there; on Linux, its SSH server.
Computers on the same network are listed under **On this network**, so you can pick one.
You can also ask your first mate to add a computer, and it recommends the address.

On a new Mac or x64 Linux computer, Infinitary's first launch shows the address to type: choose **Set up from your first mate's computer**.
It shows this computer's private network address first, such as Tailscale's, then its address on the local network, each with **Copy**.
Once the computer where your first mate lives adds it, that window opens your first mate by itself, as long as nothing was set up in it yet.
A window where you already signed in, added a project or talked to its first mate keeps its own first mate, and so does a window beside an Infinitary you started yourself from Terminal.
If Infinitary was closed on that computer when it was added, it opens your first mate the next time it starts, whatever was set up in it.
A Windows PC and an Arm Linux computer join with **Paste its link** instead.

Under the address, **Can't turn on Remote Login there?** offers two other ways.
Each adds the same kind of computer.

**Paste a link into Infinitary there**, when you are at that computer, or it is a Windows PC.
Copy the link, then open Infinitary on the other computer for the first time.
Under **Your first mate is on another computer**, choose **Paste its link**, paste it and press **Continue**.
Infinitary asks once whether to control your first mate from there; press **Control it from here**.

**Run a command there**, when you can type in Terminal there but Remote Login is off.
Copy the command and run it once in Terminal on the other computer, as the user who should run its work.
It gets Infinitary from this computer, so both need the same network.

When your first mate lives on a Windows PC, **+ A computer** offers only the link and the command.

A link or command works once, for ten minutes, and you can press **Stop it** before then.
You can also join from the other computer: on its first launch, choose **Join by its address** and type the address of the computer where your first mate lives.

## Control your first mate from another computer

Once a computer has joined, opening Infinitary there shows your first mate.
The top of the window reads "Controlling your first mate on" and that computer's name.
Your cards, tasks and conversation stay on the computer where your first mate lives.

Each computer keeps its own Appearance, Keyboard and Panels.
Other Settings sections are read and changed on the computer where your first mate lives.

To stop, open Settings → **Devices** on that computer and press **Leave**.
To cut a computer off from the computer where your first mate lives, open its menu, the three dots on its row, and choose **Remove**.
A computer that only controls your first mate needs a new link to come back.

## A computer that runs work

Any computer you add can run a project's work, with no window open there.
It signs in to its own subscriptions, and a task that runs there uses only those.
Sign it in to a subscription in Settings → **Intelligence**, where each computer's sign-ins are listed under its name.
Then give it a project.

In Settings → **Projects**, open a project and set **Runs on**: **Automatic**, **This computer**, or one of **Your computers**.
While that computer is out of reach, the project's tasks wait, and never run on this computer instead.

A computer can also run work as another user on the computer where your first mate lives.
Press **+ Running as another user** to make its command.

Removing a computer that runs work brings its unmerged work back first.

## Move a task to another computer

A started task can move to another computer that runs work.
Open its record and press **Move to a computer**, then pick where it goes.
It keeps its key, branch, files and record.
The task moves once its crewmate finishes what it is doing; until then you can press **Cancel move**.

## Files on another computer

A crewmate can copy a file from another of your computers into its task, to read it.
It only reads: nothing is written onto another computer.
Each copy adds one line to the task's Activity, naming the file and the computer it came from.

## Move your first mate

In the menu of a computer that runs work, the three dots on its row, **Move your first mate here** moves your first mate there.
A list first shows anything that stands in the way.
[Secrets](/secrets/) stay on the computer it leaves, and you sign in again there to your subscriptions.

## Keep a copy on another computer

A computer that runs work can keep a live copy of your first mate's record.
If the computer where your first mate lives is then lost, or out of reach for long, that computer can [take over](#take-over).

1. On the computer where your first mate lives, open Settings → **Devices** and pick the other computer.
2. Open its menu, the three dots on its row, and choose **Keep a copy here**.

It takes one full copy, then each change your first mate saves.
Its row says where the copy stands, such as **Copy in sync** or **Copy catching up · 3 changes**, and while it is out of reach, **Copy from** a time.
You can keep a copy on more than one computer.

The copy holds your first mate's tasks, cards, conversation, knowledge and automations.
That computer never opens it until it takes over.
On its own, the copy holds none of your projects, sign-ins or Secrets:

- When it takes over, each project is cloned again from where it lives.
  A project kept only on the computer that was lost starts there empty.
- **Ready to take over**, in its menu, lists what that computer would still need, such as a sign-in of its own to each subscription your first mate uses, and to where your projects live.
  A button for each, such as **Sign in to GitHub there**, starts that sign-in from this window.
- **Keep Secrets there**, in the same list, keeps your Secrets with the copy once you confirm on that computer itself.
  See [Secrets](/secrets/#when-your-first-mate-moves).

**Stop keeping a copy**, in that list, ends it, and that computer deletes its copy once it is in reach.

Before a merge, a push or a use of a secret, your first mate waits until each copy in reach has every change so far.
A computer that takes over then knows what was already done, and does not do it again.

## Take over

While the computer where your first mate lives is out of reach, a computer that keeps a copy can take over: your first mate starts there from its copy.
Nothing takes over by itself, and no timer decides: only your click does.

Open Infinitary on a computer that keeps a copy, and open Settings → **Devices**.
Under **Controlling**, **Take over** says when this copy is from, and whether your first mate's computer said it was going to sleep or that Infinitary quit there.
It lists each other copy too, marked **may be newer** when it may hold more changes.
If a newer copy is in reach, this computer brings it in first.

1. Press **Take over**.
2. Press **Take over** again to confirm, or **Stay** to keep things as they are.
3. On a Mac, confirm with Touch ID or your password; on a Windows PC, with Windows Hello or your Windows password.

Your first mate then starts on this computer, which becomes the computer where your first mate lives.
Your other computers and your phone find it there by themselves, with no new link.
A card there asks for each sign-in it lacks, and you add your Secrets again unless it kept them.

Your phone can also ask a computer to take over.
While your computer is out of reach, tap the computer button at the right of the phone's top bar.
Its sheet offers **Take over** for each computer that keeps a copy, then asks for Face ID or your passcode.

### If the lost computer comes back

The computer that was lost stops being your first mate's computer when it comes back, and keeps a copy instead.
Under **Stepped down**, its Settings → **Devices** lists what it saved after the copy, which never reached your first mate.
It keeps that record set aside, and nothing opens it again.

If two computers both answer as your first mate, Settings → **Devices** asks under **Two first mates**: **Keep this one**, or keep the other.
Merges, pushes and uses of a secret wait until you choose, and the one you do not keep stops and keeps a copy of the other.

## How computers find each other

Settings → **Devices** shows **How other devices find this computer**: **On this network** and **On your private network**.
**Over the internet** reads "Never. Infinitary does not open this computer to the internet."
To control your first mate from somewhere else, put both computers on the same private network.

See also [iPhone and iPad](/iphone-and-ipad/) and [Troubleshooting](/troubleshooting/).
