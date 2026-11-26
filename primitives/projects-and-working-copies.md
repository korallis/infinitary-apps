# Projects and working copies

A project binds work to its files and to its delivery rules, and a working copy gives each task an isolated place to change those files that is retired when the task closes.

## Intended use

Register every repository the fleet works in with a stable id, a workspace kind, where it lives (its approved hosting address and forge kind) and its standing delivery, autonomy and rigor.
Each repository belongs to one project, named by its `repos.project_id`, which owns the task key; a project may hold several repositories, and each task works in exactly one of them.
A new repository gets a project of its own unless it joins an existing one (`NewRepoRow.project`), and a project is archived, never deleted, when its last repository leaves.
Read a project's repositories through `ProjectStore.repositoriesOf` and a repository's project through `ProjectStore.forRepo`; `projects.repo_id` only records the repository a project was made with.
Give each task that changes code its own git worktree and branch, started from the default branch fetched at dispatch, so tasks never share a checkout.
Name the branch once, when the working copy is first made, from the first mate's written name or the task's title with a short code from its id, and read it from the task's record from then on, never rebuilt from the id ([architecture](../docs/architecture.md), "A task's branch").
The personal workspace builds in place, with no worktree and no delivery; ordinary work explicitly declared `in_folder` also runs in its project's folder without a task working copy (`docs/task-record.md`).
Ship a change through the project's posture: a pull or merge request through the forge seam, or a local land, and retire the working copy when the task closes.

## When to use it, and when not

Use a project whenever work touches a folder of files, and read its delivery, autonomy and rigor through the shared derivations rather than storing a copy on the feature's own row.
Do not build a second registry, a feature-named project list, or a per-feature folder convention: add a field to the project record or a new workspace kind to `repoKindSchema`.
Do not add a new delivery posture as a flag elsewhere: new postures extend `repoDeliverySchema` in `src/shared/repos.ts`, the seam a future validation pipeline plugs into.
Do not call a forge's API, run `gh`, or reach a provider file directly: go through the forge seam.
Do not keep a task's worktree alive after close for a later feature to reuse: unlanded work goes to the kept ref, and a later task starts from it with `branch_from` or a basis ([tasks.md](tasks.md)).
Work that changes no files (an answer, a question) needs no working copy.

## Owner and entry points

- Project identity, setup and removal: `RepoRegistry` in [`../src/core/workspace/repoRegistry.ts`](../src/core/workspace/repoRegistry.ts) (`setup`, `check`, `configure`, `unregister`, `ensurePersonal`, `setRunsOn`, `setProjectsFolder`).
- The project shape and the derivations: `repoSetupSpecSchema`, `repoKindSchema`, `repoDeliverySchema`, `repoPolicyPatchSchema`, `RepoView`, `deliveryFor` / `deliveryForRecord` and `autonomyFor` / `autonomyForRecord` in [`../src/shared/repos.ts`](../src/shared/repos.ts); `rigorFor` in [`../src/shared/rigor.ts`](../src/shared/rigor.ts).
- Working copies: `WorkspaceService` in [`../src/core/workspace/workspaceService.ts`](../src/core/workspace/workspaceService.ts) (`createTaskWorktree`, `dispatchBase`, `landTaskWork`, `retireTaskWorktree`, `keepUnlandedWork`, `removeTaskWorktree`, `KEPT_REF_PREFIX`), with the warm pool `WorktreePool` in [`../src/core/workspace/worktreePool.ts`](../src/core/workspace/worktreePool.ts).
- Proposals the captain approves: `ProjectSetups` in [`../src/core/workspace/projectSetups.ts`](../src/core/workspace/projectSetups.ts) and `ProjectChanges` in [`../src/core/workspace/projectChanges.ts`](../src/core/workspace/projectChanges.ts).
- The forge seam: `createForgeResolver` in [`../src/core/forge/index.ts`](../src/core/forge/index.ts); `forgeOf` in [`../src/shared/forge.ts`](../src/shared/forge.ts).
- On a computer that runs work: `WorkingCopies` in [`../src/core/helper/workingCopies.ts`](../src/core/helper/workingCopies.ts).

## Operations and lifecycle

Setup is `clone` (with `origin`), `init` (with `name`) or `adopt` (with `path`), each with an optional task key; adopt links an existing folder in place and never moves it.
A key is chosen once at setup, normalized to capitals, 2-4 letters or digits, and never reused by another project, removed ones included.
Instead of a key, setup may name an existing project by its task key (`project`), and the repository joins that project, whose key its tasks then take; naming both is refused, and so are Scratch, the personal workspace and an unknown key, before anything is cloned, created or linked.
A project of one repository is named with that repository; one of several has a name of its own, which `RepoRegistry.renameProject` changes (`inf:projects:rename`).
A repository moves to another project with `project-move` (`inf:repos:move`), keeping its id, name, folder and settings and its tasks' keys; a project it empties joins the target whole and is archived with its key reserved ([fleet](../docs/fleet.md), "Moving a repository to another project").
Delivery is `direct-pr` or `local-only`, defaulted by whether the project has a remote; autonomy is a flag (on means the agent may land green work itself); rigor is `quick`, `standard` or `reviewed`, with `standard` every project's standing value ([delivery rigor](../docs/delivery-rigor.md)).
Each of the three is a repository default with a per-task ask on the captain's own words, derived live by its one function, so changing a project's default reaches work already in flight.
Each ordinary project may carry nullable scope text describing what work belongs there, saved by `RepoRegistry.configure`; the personal workspace takes none.
The first mate receives the scopes only when changed or after context loss (compaction or session attachment), and makes the routing judgment itself.
A dispatch starts the task's worktree from `origin`'s default branch fetched at dispatch, from the last fetched commit when the fetch fails, and from the repository's own commit when it has no `origin`.
A contributing project's origin fetches the original project and pushes task branches to its verified owned fork, leaving the fork's own default branch unchanged ([the forge seam](../docs/forge.md), "Contributing through an owned fork").
Its app-authored project-change card owns fork creation consent and the imported-fork destination choice, including an existing project whose prepared tasks keep their original targets.
Target project in Settings changes a previously selected destination once existing code working copies finish.
Task-owned native remotes bind prepared task branches independently of the shared folder, including a new, pooled or moved copy.
The host's `git worktree` commands and task-remote configuration writes run one at a time per canonical common Git directory, so concurrent starts and pool maintenance never read another command's unfinished administrative files.
Linked checkouts and aliases share that queue; unrelated repositories and ordinary Git commands do not wait on it, and a failed command releases it without a retry.
A personal-workspace task has no worktree (its directory is the workspace), takes no rigor tier, refuses every settle mode, and closes as "built in place" when its report is committed.

Verified operations close `done/finished` from reported evidence through the existing settle owner, retiring an isolated working copy when one exists.
Verified folder work can close `done/finished` through the existing settle owner with completion evidence; it has no task working copy to retire and its project folder stays untouched.
A done/dropped close always retires the task's worktree and branch (captain: "cleaned up period. no exceptions"), saving unlanded work to `refs/infinitary/kept/<task-id>` first.
Git ancestry decides only whether a save is needed, never whether the tree goes, because a squash-merged change reads as unlanded forever.
The one exception is a save that fails, which keeps the tree exactly as it was and says so in the feed.
Retiring a worktree never happens on the settle path: `removeTaskWorktree` moves the tree aside by rename (into the warm pool, or the trash) and returns, and deleting its files runs in the background and at boot (`sweepPool`, `sweepTrash`).
On Windows a pooled working copy keeps its installed packages only when renaming the copy cannot break a link among them, which a pnpm project's never pass; the packages then go and the next task's install puts them back ([Windows](../docs/windows.md), "A task's working copy").
Boot hygiene applies the same rule to closed rows still holding a tree and to record-less directories under `userData/worktrees`, and deletes each leftover task branch no live task explains, marked as a task's or named `fm/task-*`, its work saved on the kept ref first.
A task on a computer that runs work keeps its working copy there; its close saves the same commit there and brings it home as a bundle before deleting the copy ([running work for another Mac](../docs/helper.md), "Its working copies").

## Authority

**Settings → Projects (2026-09-19)** may expose scope, delivery, autonomy, and standing rigor, each project on a page of its own opened from a one-line list.
Setup and removal are shared by Settings and `app_change` (`project-setup`, `project-remove`); the first mate removes a project only on the captain's own words.
The personal workspace's row is locked and reads "builds in place".
Every project's page in Settings → Projects holds its Name, then one Repositories panel with a tab for each repository and an Add a repository button after the last tab, for a project of one or several.
Delivery, autonomy, rigor and scope stay with each repository; directions reach every repository in the project.
Settings writes through the same action-catalog dispatcher as `app_change` ([app-actions.md](app-actions.md)).
Fleet management is agent-operated (`docs/fleet.md`): Settings may add and remove projects through `app_change`'s dispatcher (`project-setup`, `project-remove`); removal never deletes repo data.
The first mate's `project-setup` only proposes: the host's setup card adds a project only on the captain's Add project click, and a proposed settings change that is not the captain's exact words applies only from its own card.
Removal is refused while tasks are planned or working on the project, naming them by key.
The host enforces autonomy on merges: `SettleService` refuses a first-mate `merge-pr` or `land` on an autonomy-off task with the `autonomy-off` `SettleRefusal`, whose one way out is the open merge card's merge action, and a captain click is never refused.
Observing a confirmed merge of the task's recorded pull request grants no merge permission and does not declare the task finished.
The shared check watcher records the merge, then closes only for a matching open merge card that declared `after: close`, with no active work, queued instructions, unfinished required children or dependency holds; otherwise it wakes the crewmate once and leaves its work intact.
An unreachable computer delays only its working-copy retirement, never recording the confirmed merge; the existing placed-copy owner saves and removes it on reconnection.
Forge providers are fenced to `src/core/forge/index.ts`: the provider files under `src/core/forge/providers/` are importable only from `src/core/forge/` itself, the seam and its home wiring (`homeForges.ts`) among it (Biome `noRestrictedImports`).
The app never runs `gh` or reads another program's sign-in; forge work goes through the forge seam and the app's own sign-in (`docs/forge.md`).
When the captain's own words ask a crewmate to run a program, that rule is in the crewmate prompt, not a reason to refuse.
Crewmate isolation is social (system prompt + git worktree), not a filesystem jail.
It is a captain KEEP call (`docs/architecture.md` §4; the 2026-08-14 architecture review): a crewmate's stock tools, `bash` included, run with its worktree as `cwd` and can leave it, and crewmates are not to be over-rigidified.
The first mate's steer-only turns, the other half of that call, stay with the model sessions foundation (`docs/architecture.md` §2, "The first mate's turns are steer-only").

## Compositions

- Tasks name their project and repository and inherit them from a parent ([tasks.md](tasks.md)); a task key is the project's key plus a sequence.
- Project setup, settings, Runs on and removal are app actions with feed lines and operations ([app-actions.md](app-actions.md)).
- Pull and merge requests, their checks and the merge are forge operations over the seam, gated by the green rule ([forge](../docs/forge.md), "The green rule").
- Panels built in the personal workspace ([panels.md](panels.md)).
- Placement on another computer through Runs on ([running work for another Mac](../docs/helper.md), "Runs on").

## Failure and recovery

A setup refusal (a taken key, a folder already managed, a clone's typed sign-in refusal) comes before anything is cloned, created or linked, in words the caller relays.
A "Not signed in" forge answer is a refusal whose ways are the sign-in and keeping the project on this Mac; a forge is never required.
A failed kept-work save keeps the tree; a discard of unlanded work is refused without `confirm`.
Kept work stays on its hidden ref, outside `refs/heads`, never named on a surface; nothing expires it yet.

## Uses

- Every code task's worktree and branch, and its pull request through the forge seam (`direct-pr`) or its local land (`local-only`).
- The personal workspace (`RepoRegistry.ensurePersonal`), where personal panels build in place.
- The first mate's setup card and Settings → Projects' Add project, sharing one dispatcher ([fleet](../docs/fleet.md)).
- Tasks placed on a computer that runs work, whose working copies `WorkingCopies` holds there.

## Checks

- [`../src/core/workspace/repoRegistry.test.ts`](../src/core/workspace/repoRegistry.test.ts), [`../src/shared/repos.test.ts`](../src/shared/repos.test.ts), [`../src/shared/rigor.test.ts`](../src/shared/rigor.test.ts) and [`../src/core/workspace/projectChanges.test.ts`](../src/core/workspace/projectChanges.test.ts).
- [`../src/core/workspace/workspaceService.test.ts`](../src/core/workspace/workspaceService.test.ts) and [`../src/core/workspace/worktreePool.test.ts`](../src/core/workspace/worktreePool.test.ts): dispatch base, kept refs and retirement.
- [`../src/core/orchestrator/settleService.test.ts`](../src/core/orchestrator/settleService.test.ts): the `autonomy-off` refusal.
- The Biome fence on `src/core/forge/providers/` in `biome.json`.
- End to end: [`add-project.spec.ts`](../tests/e2e/add-project.spec.ts), [`project-setup-card.spec.ts`](../tests/e2e/project-setup-card.spec.ts), [`remove-project.spec.ts`](../tests/e2e/remove-project.spec.ts), [`autonomy.spec.ts`](../tests/e2e/autonomy.spec.ts), [`task-card-retirement.spec.ts`](../tests/e2e/task-card-retirement.spec.ts), and the direct-pr specs `rigor-standard`, `rigor-reviewed`, `settle-effects` and `honest-settles`.

## Where the detail lives

- [Fleet management](../docs/fleet.md): "Asking the first mate to add a project", "Choosing a task key", "Changing a project", "Notes".
- [The forge seam](../docs/forge.md): "What it is", "The app's own sign-in (PR 1.2)", "The green rule", "The fence".
- [Architecture](../docs/architecture.md) §4 "Process and security model" (crewmate isolation) and §7 "Work substrate and persistence".
- [Delivery rigor](../docs/delivery-rigor.md): "The three care names", "How a task's care is derived".
- [The task record](../docs/task-record.md): "Notes" (fleet hygiene); [running work for another Mac](../docs/helper.md): "Its working copies".
