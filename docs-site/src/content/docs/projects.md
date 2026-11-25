---
title: Projects
description: How to add a project to Infinitary, focus the window on one, choose how its changes are merged, and remove it.
---

A project is what your crew works on: a folder of your own, kept with git.
Every task belongs to a project, and every task key starts with its project's key, such as `WEB-12`.
Your projects are listed in **Settings → Projects**.

## Add a project

You can add a project in two ways.

- **Ask your first mate.**
  Say which project to work on, for example "Clone the project at" followed by its link.
  Your first mate brings you a card that names the project and its settings.
  Nothing is added until you press **Add project** on that card.
- **Add it yourself.**
  Open **Settings → Projects** and use the **Add project** row at the foot of the list.

The **Add project** row has three buttons:

1. **Folder on this computer** adds a folder you already have.
   If the folder does not use git yet, Infinitary starts git there with an empty first commit.
2. **GitHub repo**, **GitLab repo** or **Bitbucket repo** clones a project from where it lives.
   Pick it from **Your GitHub repos**, use **Find a repo** to search, or paste its link.
   With many repos, some may not be checked, and the list says so; paste a link to add one that is missing.
3. **New project** starts an empty project with the name you type.

A cloned or new project goes into your projects folder.
The line **New projects go in** shows that folder, and **Choose folder** changes it.
Projects you already added never move when you change it.

**Task key** is optional.
Type up to four letters or digits, and the next project's tasks are numbered with it.
Leave it empty, and Infinitary makes a key from the project's name.

For a project on another host, ask your first mate.

## Your GitHub, GitLab or Bitbucket sign-in

To clone a project and offer its changes, Infinitary uses your sign-in to GitHub, GitLab or Bitbucket.

If you are not signed in when you press **GitHub repo**, **GitLab repo** or **Bitbucket repo**, the row shows **Sign in to GitHub**, **Sign in to GitLab** or **Sign in to Bitbucket** instead of your projects.
That button opens **Settings → Integrations**, where your sign-ins live; see [Integrations](/integrations/).
For GitHub, you enter a code on GitHub's page in your browser.
For GitLab, you can sign in in your browser or paste a key, on gitlab.com or on your own GitLab server.
For Bitbucket, you make an API token on your Atlassian account and paste it, for projects on bitbucket.org.
The key form names the scopes to tick on Atlassian's page.
For your own Bitbucket Data Center server, version 8.19 or newer, you enter its address and paste an HTTP access token with Project read and Repository write permissions.
A Data Center project's changes are offered as pull requests, and the merge goes in only at the version you approved: if someone pushes in the meantime, nothing is merged and the task says so.
A Data Center project can also choose batched pull requests, and your crew can read and write on the server, contribute through your fork, and wake on new comments on its pull request and on a failed check on its main branch.
A Data Center server keeps no check logs, runs or release files of its own: its checks come from another service, and each one links to where its log is.
Your Bitbucket projects are listed from the workspaces you belong to; with many, some may not be checked, and the list says so.
A Bitbucket project's changes are offered as pull requests, as on GitHub and GitLab; a project you added before this works the same way from its next task.
A Bitbucket pull request's description carries the story as text, and its pictures stay on the card.
A Bitbucket project can also choose batched pull requests, and its merges follow the strategies and merge queue its main branch has on bitbucket.org.
On a Bitbucket project your crew can also read the project's pipelines and a step's log, put a release file in its Downloads, and wake on new comments on its pull request, as on GitHub and GitLab; Bitbucket offers no download of a pipeline's artifacts.
Your sign-in stays on this computer.

If a sign-in stops working, a card asks you to sign in again.
Work that needs it waits until you do.

## Working copies

Your crew never works in your project's folder directly.
Each crewmate works in its own working copy of your project, on its own branch.
Your files stay as they are until you merge a change.

## Focus on one project

With two projects or more, the top bar shows a project pill.
Press it, or press ⇧⌘P (Ctrl+Shift+P on Linux), to open a row of your projects.
Each pill counts the tasks that wait on you and the tasks that are working.
Pick a project to focus the window on it.

While a project is in focus:

- The Tasks panel and the task board show only that project's tasks.
- Activity shows only the lines about that project, and the lines about no task.
- Cards about other projects wait until the focus changes.
  Nothing is closed, and every project still sends notifications.
- A short line beside the pill says how many tasks wait on you elsewhere, such as "2 waiting elsewhere".
- Your first mate puts new work you ask for in that project, unless you name another.

Press the **×** beside the pill (**Show all projects**), or pick **All projects** in the row, to see everything again.
Infinitary remembers your focus when you restart it.

## How changes reach your project

Open a project in **Settings → Projects** to choose how its finished work is merged.
**Where changes go** offers:

- **pull requests**: each change is offered as a pull request on GitHub, GitLab or Bitbucket.
- **batched pull requests**: your approved changes are combined into one batch pull request, one commit for each change, and merged once its checks pass.
- **local merge**: the change is merged into the project on this computer, with no pull request.

A project that lives only on this computer offers **local merge** alone.

When a change is ready, its crewmate brings you a merge card.
The card's button says what it does, such as **Merge the pull request**, **Merge the branch** or **Merge in the next batch**.
If the checks are still running, the button reads **Merge when checks pass**, and Infinitary merges once they pass.

**Ask before merging** decides who merges.
It is on for a new project, so finished work waits for your word.
Turn it off, and work that passes the checks may merge without asking you.

**Rigor** sets how thoroughly work is checked: **Quick**, **Default** or **Careful**.

**Say a crewmate wrote it** is on for a project whose changes go through pull requests.
When a crewmate reviews someone else's pull request, the comment it posts opens with a line saying an Infinitary crewmate wrote it.
Change the line and press **Save**, or turn the switch off to leave it out.

## Remove a project

1. Open the project in **Settings → Projects**.
2. Press **Remove** on its last line.
3. Press **Remove** again to confirm.

Removing takes the project off the list.
Its folder and its finished tasks stay.
If the project still has tasks, Infinitary names them, and you finish or drop them first.

## Next

- [Tasks and crewmates](/tasks-and-crewmates/)
- [Cards and decisions](/cards-and-decisions/)
