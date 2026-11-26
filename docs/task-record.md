# The task record and its protocol

The task as a record (task-system P0) and the wire protocol over it (P3).
`docs/architecture.md` §19 summarizes the whole task system; capture is `docs/task-capture.md`, the graph `docs/task-graph.md`, retention `docs/task-retention.md`.

## Specifications and composed records

The task core references its current immutable `task_specifications` revision through `specification_id` (INF-1296 piece 5).
A specification holds the authored goal, intent and prompt; a scope edit writes a revision rather than changing earlier words.
The migration records the current older specification without inventing when it was authored or who authored it.
A later scope-edit event names its specification revision and keeps the existing `journal` retention mark, so compaction cannot remove that reference.
Export includes earlier revisions and any raw current specification the compatible task line cannot reproduce exactly.
Import remaps their local identities while preserving revision order and the current reference.
The remaining work-shape families live in `task_contracts`, `task_programs`, `task_workspace_facts`, `task_placement_requests` and `task_routing_requests`; unknown older fields remain in `task_legacy_shapes`, not a new permission source.
`task_record_history` retains the closed policy snapshot, older result copy and unreadable older evidence.
The internal read-only `task_records` view assembles these sources under the older column names for compatible consumers; it is neither another writer nor a published SQL surface.
The task row no longer has the specification, shape, delivery or superseded execution columns.
The typed scheduling columns and the existing activity/assignment/outcome indexes remain on the task row; they are not a generic operational payload.
`TaskService` coordinates all writes in the existing transaction, through named evidence, permission, validation, execution and task operations.
`TaskService.readProjection` shares composed task records and relationship reads within one synchronous board, presentation, roster or context read.
The host joins the same projection with settings, project, device, narrowed sign-in and declared-run facts through their existing owners.
A board's current cached record can seed that read, so its posture witnesses do not decode the record again.
A presentation refresh borrows current records from the board cache, overlays pending creates, changes and removals, and reuses them in its pure metadata publication only while the task sequence remains unchanged.
Owner-derived posture, place, ask and dependency facts share the same projection through `TaskService.projectedFact`; each task's fact is derived once for that snapshot.
The crew counts read every active row's posture in one such projection, as the presentation pass does (INF-2342).
A tasks listing composes its page in one such projection, and each idle ladder pass reads its witnesses in one, so a row's neighbours and a task's witnesses decode a record once (INF-3412).
The ready sweep (`CrewWatch.sweepGates`, after every close and every minute) reads its synchronous stretch in one too, which is the whole sweep unless it starts a task or drives a move; what runs after such an await reads afresh.
A posture's blocker reads (`liveBlocks`, `waitingOn`, `blockersHoldingClose`) select the blockers in the statuses they need before composing records, leaving finished blockers' retained payloads unread (`TaskStore.getAmong`).
The unanswered-request witness seeks the first real first-mate action and child activity times instead of decoding the task's timeline or its children's records.
Task writes suspend the task and relationship reads and clear them, including derived facts, on success or rollback.
Completing the synchronous projection drops its shared facts, rather than keeping operational facts across turns.
Recent supervision outcomes seek the newest sort ids through their ledger index before reading payloads, rather than sorting the retained history.
The former public `recordDelivery` field bag is private; fixture injection of older mixed records lives only in the test helper.

## A task's title

A task's title is the one line the board, the feed, a card's strip and the record show for it, and it holds at most 64 characters (`TASK_TITLE_MAX`, `src/shared/taskTitle.ts`).
A title an author writes is refused whole past that room, never saved cut: the refusal names the room and the title's length, and the author says it shorter.
That covers the first mate's `spawn_crewmate`, `create_task` and `update_task` (`Intake.commission`, `Intake.plan`, `TaskService.updateFields`), a crewmate's `file_followup` and `start_program`, and an after-merge step's title, whose room leaves space for the `Continue: ` its task adds.
A title the host makes itself from longer words has no author to refuse, so it ends on its last whole word that fits, marked with an ellipsis (`shortTaskTitle`): the first sentence of a captain's message filed as a question, a card's title on the record it files, `Review: ` and `Assess repair: ` before a builder's title, a required action's title, a program part's label, an operation's words, and a goal standing in for a missing title.
Only a first word longer than the room is cut inside it.
`TaskService.create` and an operation's revision apply the same shortening to any title past the room that reaches them, so no path saves a title cut mid-word; titles saved before this rule keep the words they were saved with.

## Conversations on a task

`TaskService.turns.setSessionFile` commits the current resume pointer and its `task_sessions` association together.
`CrewSessions.recordCrewSession` supplies the resume token, durable transcript file, computer and device, provider and model, account, and why the conversation opened at start, renewal, move, recovery and turn completion.
A conversation key comes from its resume token: a Pi file name without its suffix, or a Claude conversation id, never a placed proxy's construction id.
One row belongs to one conversation on one task; reopening it updates its last observed activity and serving metadata without replacing its first observation or opening reason.
`opened_at` is when this association was first recorded, and `last_at` is the latest recorded lifecycle boundary, not a claim about a provider's message timestamp.
A backend that mints its id during its first turn is recorded when the resume token becomes available; until then the runtime retains why it opened.
The current resume pointer is the task's resume binding on its execution record, and `current` is derived from that binding rather than stored on the conversation row.
A by-key `tasks` read includes `sessions`; list reads stay compact.
Each row names its transcript file and computer, model and provider, account, opening reason, timestamps and whether it is current.
A stronger-model task names `earlier_attempt` by task key; reading that key lists that attempt's own sessions, never copies them onto its successor.
For conversations retained before associations existed, the by-key read also lists this computer's session-folder files, including copies from another computer, through `sessionFilesIn`.
A retained file whose conversation key an association already holds is not repeated, and served sidecars are not conversations.
A conversation the home itself holds is named by the file of its key in that folder, since the row keeps the location it was saved under, which an older home on another computer wrote (`docs/devices.md`, "A home on another system"); one another computer holds keeps the location recorded for it.
Unrecorded files have no model, account, reason or timestamps; their computer names the location of the retained copy, not an inferred original computer.
Files still held only on an unreachable computer are not enumerated by this fallback.
Recorded associations remain available without a readable transcript and survive task closure, timeline compaction, restart and JSONL record export/import.
Only erasing an unstarted task or the D-13 purge removes their rows, through `TaskService`.
New lifecycle observations retain changed supplied facts beside their conversation reference in immutable `task_session_observations` rows.
A change to the conversation, file, computer or device, provider, model or account appends an observation; an unchanged turn-end reading only refreshes the conversation association's last activity.
Restoring observations by their recorded identities preserves identical historical rows rather than deduplicating retained evidence.
They share the session writer and its transaction without adding bookkeeping to the legacy task-event stream.
They do not copy resume tokens or reconstruct older assignments from the changing conversation row.

## A task's execution record

A task's running work is its own record, one `task_execution` row per task beside the conversations in `task_sessions` (INF-1296 piece 3, migration 97).
It holds the resume binding, the computer and account the crewmate runs on, the committed placement, the idle clock and recovery rung, a manual start that did not begin (`start_notice`), and what the current turn's report declared about whose turn follows it (`turn_json`: `captainWait`, `finishedAt`, `mergeCompletion`, `needsFirstmate`, `checkBack`).
The resume binding is the opaque token the backend resumes from (`session_file`) and, where `task_sessions` records the conversation that token belongs to, that conversation's key (`conversation`); a token from before conversations were recorded keeps none, and nothing makes one up for it.
`TaskService.archive.sessions` marks current the conversation the binding names, or for a token with none the conversation its file is.
`TaskStore` is the one writer, beneath `TaskService`, and a record still reads every one of these facts under the field it read before (`sessionFile`, `deviceId`, `accountId`, `placement`, `idleSince`, the `recovery*` fields, `startNotice`, and the turn's declarations on `delivery`), so no reader changed.
A write of a task's whole delivery facts replaces the turn's declarations with the ones it carries, as the delivery column did before them.
The task row's older execution columns are retired; `activity`, `assignee`, `model` and `started_at` stay on the task row, because the published views and the feed read them there, as do the scheduling facts already typed on it (`priority`, `start_policy`, `gate`, `test_path`).
A record export carries the binding's `conversation` on the task's line; an export an older build wrote imports with the conversation named as the migration names it.

## The idle clock

Four columns of the execution record (migration 45 added them to the task row, and migration 97 moved them) hold the idle ladder's durable state, written only through `TaskService` like every other column: `idle_since` (`markIdle` at every idle boundary, `endIdle` when a turn the ladder did not start begins), `recovery_rung`, `recovery_count` and `recovery_at` (`recordRecovery`).
They are machinery, not a state change: no timeline event and no `updated_at`.
What reads them is `CrewWatch.reconcileIdle` and the crew line's `stalled` fact (`docs/report-sort.md`, "The idle ladder").

## Where a task runs

`device_id` on the execution record (migration 63, moved by migration 97, written only by `TaskService.placement.setDevice`) names the paired computer that runs work holding the task's conversation, and null is this Mac (`docs/helper.md`, "The home's side").
Such a row has no working copy here, so the boot keeps it active once its conversation was recorded (`sessionFile`) rather than by its `worktreeDir`, never marks its turn interrupted, and reads it as resumable whatever its activity: a turn it was running went on there.

## A folder a merge left behind

After a merge the host brings the project's folder up to date only by fast-forwarding a clean folder on its default branch (`WorkspaceService.refreshManagedCheckout`); any other state is refused with a typed cause (`FolderRefreshCause`, `src/shared/folderRefresh.ts`, which owns its words), such as edits of its own, another branch, no branch, a failed fetch or a diverged default branch (INF-549).
A refusal is kept on the merged task's record as a note naming the cause, the branch, the merged version and origin's version as last read (`data.folderRefresh`); on the first mate's own settle that note is the Activity line, and on the captain's click the settle's own line already carries the same sentence.
The host then files one task under the project, "Bring the folder up to date", and starts it the way a when-ready task starts, with no reminder or card of its own (`InPlaceWork.fileFolderRepair`).
Its shape carries the facts as `in_place`, a host stamp: the crewmate's working directory is the folder itself, with no working copy and no branch, and the task ships nothing, so it has no delivery, rigor or autonomy, no delivery tools and no merge card, and it runs on this Mac whatever the project's Runs on says.
Its brief is filled from those facts at each start (`renderFolderRepairBrief`): the crewmate judges whether the folder is safe to bring up to date, may set edits aside on a backup branch or a stash, and asks the captain on a card before it discards or overwrites anything, moves the folder off its default branch, pushes or opens a pull request.
A later refusal on the same project while that task is open or active updates its facts, notes it, and tells its crewmate; it files nothing new.
Once a minute the host reads each such folder without changing it (`WorkspaceService.folderCurrent`), and a task whose folder is clean, on its default branch and at or past the merged version closes as finished with a line saying so, unless its crewmate is mid-turn or one of its cards is up (`InPlaceWork.closeCurrentFolders`).
A refusal for `no-origin` or `no-default-branch` read no default branch, so the minute's read takes it from the folder's own `origin/HEAD`, as the next merge's update does (INF-583).
Its brief has the crewmate add origin at the project's address when the folder has none, and name origin's default branch with `git remote set-head origin --auto`, since a pull of one branch leaves `origin/HEAD` unset.
Removing a working copy never touches a directory that is the repository itself or holds it, so a failed start of a task that works in place leaves its folder, or the folder above a missing one with everything in it, as it was (INF-585).
It deletes a directory git refused to remove only when it is in the worktrees area, so a failed start never deletes a folder outside it, whatever the record says the task started in.

A folder that is gone is `missing`, and one git cannot read is `unreadable`; neither reads as having no address (INF-572).
Work that needs the folder notices it then, never earlier: a merge's update says it is missing, and a task starting on this computer, a branch coming home from a computer that runs work (`PlacedCopies.bringBranchHome`), and a merge into the folder itself (`SettleService`) are refused with words naming the folder and its repair (`InPlaceWork.folderMissing`, `folderMissingText`).
Each files or names the same "Bring the folder up to date" task, with `in_place.noticed` saying what found it; a folder found missing again while its repair knows it tells nobody anything new.
Of the tasks that work in the folder, only that repair starts while the folder is missing: folder work and "Close the pull request" are refused at their start with the same words (INF-584).
A refused start waits on the captain like any start that failed.
A task bound for a computer that runs work still starts: the start's read of the folder's address skips a missing folder (`ProjectChanges.inspect`), and that computer clones from the project's saved address.
A missing folder's repair works in the folder that held it, or the nearest folder above that exists, recorded as `in_place.started_in` so a resume opens there again (`nearestFolderAbove`).
Each start opens a new conversation, so it reads the project's folder at the path the project names now and starts in it when it is there, dropping `started_in` (`InPlaceWork.inPlaceDir`, INF-757).
Its brief has the crewmate find out why the folder is missing, clone it again into the same path only when it was deleted, and otherwise ask the captain on a card.
A repair that never read a default branch reads it from the folder's own `origin/HEAD` when the minute's read comes round, so it closes once the folder is back, clean, on that branch and level with origin's.

At each app start, the computer that keeps the record reads every project with an address once, in the background (`InPlaceWork.checkFoldersAtStart`, `WorkspaceService.refreshAtStart`).
A missing folder is left for the work that next needs it; a folder on another branch or on none is left alone without a fetch; one that cannot be read, or is level with or ahead of origin's default branch, is left as it is.
A clean folder behind on its default branch is fast-forwarded, as after a merge, with one Activity line.
One behind with edits or commits of its own gets the repair, with `noticed: "app-start"`, unless the captain dropped the project's latest repair while origin's default branch stood where it stands now; once that moves on, the next start files it again.

A pull request an abandoned task could not close gets the same kind of task (INF-549's sibling).
When a discarded, cancelled or superseded task's pull request is refused its close (`TaskClosing.closeOpenPullRequest`), the host files one task under the project, "Close the pull request", with `in_place.pull` naming the pull request, its link and branch, the abandoned task, and what the host answered (`InPlaceWork.filePullRepair`); one stands per pull request.
The note on the abandoned task names it, and is an Activity line unless the captain's own click already put the outcome there.
Its brief says close the pull request or report why not (`renderPullRepairBrief`): the crewmate works in the folder without changing it, holds only the read and write tools where the project lives, and never merges, pushes or deletes a branch.
The same minute's read closes it as finished once the host reads that pull request closed or merged.

Work on a project's folder itself is the first mate's to declare, by its own judgment (INF-567, direction A).
`spawn_crewmate`'s `shape.in_folder` stamps `in_place: { folder: true }` and `deliverable: operation` (`workShape` in `workShape.ts`), and a stronger-model retry keeps it.
Such a task runs on this Mac, which keeps the folder, whatever the project's Runs on says, and works in the folder with no working copy, branch, delivery, rigor or merge card, as the folder repair does.
Its brief is the first mate's intent with no Delivery line, closed by a paragraph naming the folder and that the captain's edits there are the captain's (`renderIntentBrief`'s folder facts).
It needs a project other than the personal workspace, and refuses `runs_on_ask`, `delivery_ask` and `review_of` beside it; nothing spawns.
While the folder is missing it is refused at its start, as any task starting on this computer is, and the folder's repair is filed or named (INF-584).
After its crewmate reports a successful result, the first mate can close it `done/finished` with `settle_task` done, why `finished`, and `evidence` naming what verifies that result (INF-1279).
The existing settle owner records that evidence on the close event; it never reads the report's prose to infer success, and the host's folder-reading close never reads this task.
The close touches no project files or git state: existing edits, staged work, stashes and unpushed commits stay exactly where they were.
A pending settle refuses it; closing on its own, the first mate meets the soft holds every done close meets - an open decision, open parts, waits, and the delivery proof, which holds running jobs, queued guidance and a crewmate that has not reported - and the captain's words pass them all (below, "One close as done").
The same close accepts operations with a scratch working copy and folder tasks of any deliverable.
A missing proposal or dismissed note is not evidence, and successful folder work is not discarded.

## Relationships

A task stands to other tasks in three stores under one read and one check contract (`src/core/tasks/taskRelationships.ts`, INF-1296 piece 2), and `TaskService` is the one writer of all three.
Its parent is the `tasks.parent_id` column; its typed links (`blocks`, `related`, `discovered-from`, `replaced-by`) are rows of `task_links`, with `holdsMerge` a mark some `blocks` rows carry as history (every `blocks` row holds the merge, INF-3167); and the three references it names one of each are rows of `task_references`: its `basis`, the task it branches from (`branch-source`) and the earlier attempt it retries (`retry-of`).
`TASK_RELATIONSHIP_RULES` keeps each kind's rule distinct: how many one task names, whether it holds a start, whether a cycle is refused, where the other task must be, and whether a name that resolves to no task is kept.
Only `blocks` holds a start, so naming a basis or a branch source never adds a scheduling dependency; the ready query reads no reference.
Each family is read where it is kept: the parent and children through `TaskService.graph` (`children`, `ancestors`), the links each way through `TaskService.graph.linksFrom` and `linksTo`, and the references through `TaskService.archive.recordedReferences`, with who recorded each and when, where the store kept that.
A reference row keeps the name as given (`ref`, a key or an id), the task it resolved to when it was recorded (`target_id`, provenance only), the actor and the time; a reference migrated from an older profile has no actor or time, since none was saved.
Each reference is read by the name it gives, resolved at every read as before, so `target_id` decides nothing.
The rules a reference is checked against (`referenceRefusal`): an empty name names nothing; a basis may name no task yet, as a spawn names a plan step still being filed, while a branch source or an earlier attempt must name a task; none names the task itself; and a branch source is in the same project.
A record's work shape still reads `basis`, `branch_from` and `escalate_from`, composed from the reference rows, so every reader of the shape reads the same words; the store refuses a shape write that names a different reference, which goes through `create`, `update_task` or `import` instead.
The escalation stamp beside a retry (`escalated`) stays on the shape: it is a fact of how the retry ran, not a relationship.
Migration 95 moved each name out of the shape into its row in one transaction before any service starts, keeping the name exactly as saved and recording the task it resolved to then.

## Derived, never stored: the basis and the review join

The record keeps no stamp of a fact the graph already holds (migration 46 removed the two it had).
A task's `basis` is recorded as the first mate named it (a key or an id, "Relationships"); whether it holds - the named task is done or has reported - is derived at every read (`TaskService.graph.basisHolds`, `basisOf`), so a step planned behind a still-running task reads grounded the moment that task answers, with no write.
The store strips `basis_verified` from any shape it is handed; the router still receives it, derived, beside the shape.
The basis reads the same everywhere it is shown: `tasks.detail` carries `basis: { ref, verified }`, `v_tasks_v1` a `basis` column, and the export the name in the task's shape beside its reference rows.
A review's builder is its parent (the one stored join), and which review a builder's verdict came from is read off that edge (`TaskService.graph.verdictReviewOf`: the newest review child opened at or before `reviewedAt`), never cached in the builder's delivery facts; the verdict's timeline event still names the review in its data, which is what the replay scorer reads.

## Live task policies

The captain changes a named open task's Delivery, Merging and Care by talking to the first mate, not through new record controls; the one exception is a merge card's Review carefully, which raises Care to Careful (`docs/delivery-rigor.md`, "Raising care from a merge card").
`update_task` takes `delivery: direct-pr|local-only|project`, `autonomy: on|off|project`, and `rigor: quick|standard|reviewed|project`.
Omission preserves a policy; `project` resets it to the current project setting, including a project's permission to merge on its own.
An explicit request is consent; ambiguity about the task, policy or consent gets one specific question rather than a routine confirmation.
`TaskService.updateFields` commits the live policy revision, cancellation of old pending approval, and its actor-attributed Activity/feed event together; a rejected mixed edit rolls back its other fields too.
`WorkShape.policies` holds edits separately from original asks, dispatch stamps, published delivery facts, pull request identity and evidence.
The asks made at filing (`delivery_ask`, `autonomy_ask`, `rigor_ask`) and the live edits are the task's policy record, one `task_policies` row per task (INF-1296 piece 3, migration 98), and a record's work shape still reads each under the shape field it was saved in.
A shape write replaces them with the ones it carries, as the shape column did before them, and a value of another type than its field declares stays in the shape column, where every reader met it before.
The closed snapshot (`delivery.closedPolicies`) is history, not an input, and stays on the delivery facts.
The shared `effectiveTaskPolicies` reader supplies the record, task query, crew context, briefs, review gates and final merge guards; the task detail's legacy `rigor` remains dispatch history, and its optional `policies` holds the current values and sources.
The Info tab's More row shows three read-only rows and `This task` or `Project setting` beside each, followed by the helper inviting a request to the first mate.
For Automatic work or once a computer that runs work is on the list, a fourth read-only row, Runs on, says where the task runs and whether that came from `This task`, its `Parent task` or the `Project setting` (`TaskDetail.runsOn`; `docs/helper.md`, "A task's own Runs on"); `update_task` `runs_on` changes it before the task starts.
A local merge bounds Careful to Default without losing the requested care, with an explanation in More.
Queued, interrupted and waiting work stays in place; the existing durable inbox carries policy notices to active and later resumed crews without starting a crew solely for that notice.
A restart recovers a notice from the committed event if the app quit before enqueueing it.
Newly closed work snapshots its effective policies beside the closed outcome (`delivery.closedPolicies`), without creating or rewriting a routing shape; policy edits refuse closed tasks, reviews, answers and the personal workspace.
The merge and care semantics, including the final asynchronous boundary, are in `docs/delivery-rigor.md`, “Changing policy on open work”.

## A task's change evidence and permissions

A task's delivery facts are two records of their own beside the task row (INF-1296 piece 4, migration 99), so what a change showed and what the captain allowed are never one blob.
Its change evidence is one `task_delivery_evidence` row: how it delivers (`mode`), the version its readings were taken at (`head_sha`), and in `evidence_json` the change's identity, checks and their watches, reviews, repair and round ledgers, version readings, live validation without its permissions, the published story and its risk.
Its permissions and effects are one `task_permissions` row with a column each: the captain's merge approval with its lineage and any attempt in flight, an unversioned merge click an older build kept, the merge cards a click approves, other reviewed pull requests and the selected one, write asks, the required action offer and the captain's action, the override, a refused merge card, the live validation's permissions with their effect states, and a settle that has not run.
The row carries `format` 1, and a later format names its own number.
The delivery column keeps only history: the closed policy snapshot and an older release's copy of the latest result.
`TaskStore` is the one writer, beneath `TaskService`, and a record still reads every one of these facts under the field it read before (`delivery`, and the settle under `pendingSettle`), so no reader changed; `splitDelivery` in `src/core/storage/taskDeliveryFields.ts` names which field goes where, and a field it does not name is evidence.
A read record composes its `delivery` from the rows that read took the first time something reads the field, so a list whose reader never reads it decodes none of its change evidence; a spread, copy or clone reads it as any field, and a write to the field replaces it.
A write of a task's whole delivery facts replaces its evidence and its delivery permissions with the ones it carries, as the column did before them, and a settle that has not run is its own field.
It writes again only what moves (INF-2220): the evidence row when any of its columns would change, each permission column whose value would change, the history row and the turn's declarations when theirs would.
A write that would move none of them, carrying no timeline line, is an exact no-op: the task keeps its updated time and the board does not move.
A row left with nothing in it is removed, so a task with no delivery facts has no records.
`v_tasks_v1` and `v_feed_v1` read the delivery mode from the evidence row.
A record export carries the delivery facts it carried before, which hold no permission, so an import grants nothing.
Restart recovery reads the same facts it read before: a kept approval's attempt token is read back from where the project lives before anything is sent (`docs/delivery-rigor.md`), and a settle that has not run resumes once.
The offline tools under `scripts/` read a saved database's delivery facts through `savedDeliveryReader`.

## A task's change

The change a task carries is a record of its own (INF-1868 piece 1; `src/core/storage/changeStore.ts`, its shape in `src/shared/change.ts`): one `changes` row and one `change_versions` row per observed version.
A task carries one change on its own branch and one for every other pull request it names on another branch, whoever opened it (INF-2490): each is projected from the facts that name its number (`projectOtherChange`).
The task record's read lists every pull request on the task in number order (`pullRequests`, `taskPullRequestsOf`, INF-2490 round two), from every change the record keeps rather than the capped review list: its number, its page where the slot keeps it, the checks last read for it, whether it merged, and whether its merge closes the task - true only for the change the open finishing card was shown for - while `prNumber`, `prUrl` and `changeLabel` keep naming the current one.
Each change keeps its own saved story: `delivery.presentation`, the one field older readers read, holds the current change's, and `delivery.presentations` every other change's, each naming its branch.
A change's merged receipt comes from its own merge; the task's close reaches only the current change's receipt.
The task row, the board tile, the crew summary and the iPhone show the current pull request only; the record's Info tab lists them all on a task with more than one.
The change says where it is - the project, the branch it merges into as the host last named it (`TaskDelivery.prBase`, written when the change opens and refreshed by each reading, else its owned review's or approval's), and its head branch - its handle where the project's host keeps one (a pull request or a merge request with its number, page and label; a plain Git host keeps none), who raised it, and its receipt once merged, discarded or closed.
For remote delivery, a version is a head pushed (the captain's plan), so the record makes one of each head the project's host saw: a check read, an owned merge review, a published story, a merge click and the repairs it was carried to, a merge card, and an override given for one version.
A saved story's completion binding also supplies its confirmed plain-branch head or committed local head, without inventing a hosted request or upload.
Each version, in the order the host saw them, holds the facts the host held at it: the checks it read with their states, times and lines, the default branch's newest run of each check that reading found red where the host read it (`ChangeChecks.main`, INF-1915 fix 1; evidence about the failure's cause for the crew and the card, never a merge input), the review verdict declared with its risk, its typed findings and its reading, the story revisions prepared and the one published, and the consent given.
A version a declared repair carried the approval to before the host read it follows the version the repair started from, in the lineage's own order, whatever the host read in between.
A review, a lines reading of the working copy or an unbound prepared story makes no version; they attach once its head is observed.
A reading of another branch's pull request (`docs/forge.md`, "A requested merge") writes its number, page, label and base and the head it read with its checks into the same slot, and an approval of it is consent to merge that pull request, not the task's own change.
Each of those facts names the pull request it belongs to, and the record binds it by that number within the verified forge repository, never by its head: the number group carries it, every check reading is stamped with the number of the pull request it was read of (`CheckSnapshot.prNumber`, INF-1873) and the head, state and times read with it go with that stamp, a head written with no reading goes with the number group it stands beside, an approval names the review it approved, and an override given for one version names the pull request that version belonged to (`HoldOverride.prNumber`).
A fact that names another branch's pull request is that pull request's change's, whatever the current selection, and the record reads the task's own number from the reviews on its own branch and the merge cards that name no other branch's pull request, so the other pull request's facts, consent and receipt stay off the task's own change and land on its own.
A review saved before INF-2490 also names whose it was (`owned` or `referenced`); its branch says the same, and the record reads the branch.
Two pull requests can share a commit, and their readings never share a stamp, so a reading of the own pull request at a commit another branch's review also names is the own change's version, and a reading of the other one there is that change's.
A reading or a version override an older release saved before its writer stamped it is the own change's only in a slot that records no other branch's pull request; in one that does, the host cannot tell whose it was, so it is nobody's and the record leaves it out (`docs/saved-data-compatibility.md`, "The change record").
Consent at a version is the captain's click on a card, an approval carried to a repaired version by a declared repair, or an override given for that version alone; an override given for the whole task sits on the change.
Every value is a fact the host held or was told; none is a judgment, and a fact the record does not name is left out, never made up.
In this piece the record is a projection: `TaskStore` writes it from the task's record on every write that can move it (its delivery facts, status, close, branch, project or shape), the delivery facts keep their writers, and every reader reads them where they were.
A task carries a change when it is work on a project the app manages, on a branch of its own, not building in place and not raised by the host on another task's change, while it is open.
An answer, a review the host raised, work in the personal workspace, a task not yet started and a task closed before the record existed carry none.
A version once recorded stays, dated when the host first saw it, and what the slot says at it is read on every later write, whether or not a pushed-head fact still names it.
A reading of its checks - state, snapshot and times - replaces the last whole, so a time a rerun no longer names goes with it, while its lines are kept until read again; a review replaces the last whole; and the consent's click, carried approval and override each follow their own newest fact.
A component the slot no longer names at it - the checks of a head a newer push replaced, the publication the next story moved past, the click a later approval superseded - is kept, and the story's revisions accumulate; a handle, base or override the task no longer names is kept the same way, so the record accumulates what the delivery facts forget.
A task's hard delete takes its change with it, and a project removed keeps what its changes recorded.
The tools name the change (INF-1868 piece 2, INF-1873): `open_change` takes a `repository`, the task's own project or another project the app manages (INF-2510), and a `base`, the branch the change targets when not the default one, such as another change's branch for a stacked change; `check_change` takes the change's id and refuses another's, and its facts name the change and its base.
The one card and note, and a review, belong to the change by its id; the delivery fields stay its writers' and its readers' slot, and the change record stays their projection, so the record keeps no second source (INF-1868 piece 5; `primitives/changes.md`).

## Specification delivery and history

`update_task` applies combined edits before `start_now`; a typed graph refusal prevents that start.
The first mate's `start_now` also waits while its own open decision still asks the captain about the task, and so do its `start_policy` when-ready on queued work, its `link_tasks remove` of the last wait of when-ready work, and any other `update_task` edit that leaves when-ready work waiting on nothing, such as `needs_merge` or `start_at_approval` letting an approved base answer its last wait, each of which would let the ready sweep start it (INF-6091; the soft hold `card-question`, `docs/delivery-rigor.md` "The holds"; `src/core/orchestrator/cardHeldStart.ts`).
The decision is one kept on the task, or one filed as its own record that names the task in `related`.
The captain's click takes the card off the stack at once, but the choice reaches the first mate on its next turn, so the hold stays while that choice waits unread on the first mate's lane.
It holds only a start not yet made - queued work, or started work in the backlog - and only on a turn that carries no words the captain typed - a message or a steer, never only a click on another card; the first mate's read of the captain's choice on that card, their typed words, their Start on the task, or the first mate's withdrawal of the card lifts it, the refusal names the card, and the first mate then starts the task again.
A decision kept on another task, which names this one only for context, holds nothing, and work already set to start when ready before the card went up still starts when its wait ends.
Goal edits atomically update `tasks.goal`, the structured intent and the host-rendered goal in the stored template.
The captain's verbatim words, constraints, delivery and escalation context are not rewritten.
Queued intent tasks render from saved intent at dispatch (escalations retain their host-authored context).

A by-key `tasks` read carries the latest `outcome` and `card`, complete chronological `reports` with event ids, saved timeline `decisions`, the explicit `basis`, and the most recent pinned `brief`.
Each of `decisions` names who ended its card (`by`): the captain for their choice, its author for a withdrawal, which holds no action the captain chose (INF-2828, `docs/card-authoring.md` "A decision its author withdrew").
It names `computer`, the computer the task's crewmate ran on, and `evidence_folder`, its evidence folder there, so a crewmate reports a file on another computer as a gap instead of searching for it (INF-1217, `docs/macos-privacy.md`).
A crewmate's `tasks` also takes `projects`: true answers every project's key, name and folder instead of tasks; the first mate's has no such parameter, which keeps it out of the first mate's fixed context.
It also carries `built_on_by`: every task whose basis names this one, by key or id, open, done or dropped alike, each with its status, closing reason, short outcome and change (`TaskService.graph.builtOn`, INF-976); the host's delivery machinery, such as a review, is not among them.
Lists carry no bodies.
A short closure report still replaces the latest outcome but cannot hide earlier full specifications.
Reports, closing choices and exact first-turn briefs are exempt from timeline compaction alongside existing provenance; no historical approval is inferred and no historical builder is restarted.
So is any event whose data marks it `journal: true`, a record a replay reads back, such as a program's ask answers and its start (`docs/programs.md`).

At dispatch the named verified basis carries its latest report once, as the answer, and every report before it as history, the full card and its full thread, plus the existing saved choice/answer reader.
No card or thread tail is cut from the implementation handoff.
An existing `discovered-from` edge also delivers its origin's recorded findings, explicitly labelled provenance, not accepted scope or a basis routing discount.
That context includes reports, cards and their media, never the origin's working branch or saved code; a finding moved to another project starts from that project's own code.
A verified basis or replacement in the same repository still carries recoverable code; an explicit `branch_from` still selects the starting commit.
That code, while the source's working copy is present, is the commit it has checked out (`otherCheckedOutBranch`): when its crewmate committed on another branch than the task's own, the brief names that branch, or brings it home from another computer to the source's own ref for it, never the task's branch it left behind; a detached checkout, or a computer that cannot say, hands on the task's own branch, as a story does.
A basis or replacement in another repository starts the task from its own repository's code, on a work computer and at home alike: it carries the reports, card and thread, never the source's branch, saved code or a starting point, and it never brings a live branch home from another computer.
Its section adds one line naming where that code lives instead (`codeElsewhereLine`): the repository, and its pull request or pushed branch where the record named one, that it merged there, or that it was never pushed.
A follow-up so handed its origin, as an origin section or as its basis, loses the line its filing wrote telling it to read the origin through `tasks` (`withoutOriginReadLine`), so the origin reaches it once; an answer follow-up gets no section and keeps the line.
No natural language scan attaches a basis, no self-basis is invented, and same-session prototypes and narrow direct builds remain valid without external sources.

The brief a first turn serves is appended as a non-feed `briefed` event just before serving it; Activity leaves this host receipt out as evidence ("What Activity holds").
The project's standing directions are not part of it: the first served turn of a conversation adds the current ones, and a later turn adds them again after they change (`docs/knowledge.md`, "Knowledge as needed").
Each report the brief copies off a task's timeline is stored in the receipt as a reference to its event wherever the reference is smaller than the copy (`src/core/tasks/briefReceipt.ts`): a short stand-in naming the event in the text, and its offset, task, event id and the text's hash in `data.reports`.
Report events are never compacted, so `TaskService.servedBrief` reads the receipt back as served, for the `tasks` query's `brief` and the record's timeline; the hash finds the report again when an export reloads it under a new event id.
The card is already a file the brief names, so the receipt holds its path; a card that could not be saved rides in the brief, and the receipt, whole.
`TaskDetail.cards` lists every card the task showed, open and past, newest first, for the record's Cards tab (`docs/card-evidence.md` "The past card").
Successor lookups can recover that pinned content even after source or builder reports change.
This proves host delivery, not model compliance or how an agent reads an approval; that judgment is `HANDOFF`'s (`docs/card-authoring.md`, "The handoff").

## A typed result and where a working copy starts

A task's shape can carry `result_schema`, a JSON Schema with an object at its root, which the first mate declares on `spawn_crewmate`, `create_task` or `update_task` (INF-799 piece 1).
The host refuses a schema without an object at its root, or one the validator cannot read, as tool text, and files nothing (`resultSchemaRefusal`, `src/core/tasks/taskResult.ts`).
The brief prints it in a "Result shape" section with one sentence saying the report's `result` must fit it (`renderResultShapeSection`).
The crewmate's `report` takes `result`, a JSON object, checked with the JSON Schema validator the app ships (typebox's `Schema`).
A result that does not fit, or a missing one where a schema stands, is refused as tool text naming the first failing field, such as `result.files[0] must be string`, so the crewmate reports again; a report that declares `waiting_on_captain` or `needs_firstmate` is taken without one.
A task with no schema keeps whatever object its report carried.
A checked result is stored on the report's event (`data.result`) and nowhere else: the report event is the one record of a report and the result it carried.
`reportEntryOf` (`src/core/tasks/reportEntry.ts`) reads a report event as a typed, versioned entry - its words, summary, result and what it declared - and leaves out, never guesses, a field an older writer stored in another shape.
The task's latest result is the newest report entry that carried one (`TaskService.latestResult`), and it stands until a later report carries another.
A release before INF-1296 also copied the latest result onto the task's delivery facts (`delivery.result`); that copy stays saved as it was and is still read with the precedence it had, so it stands unless a report written after it carried a newer result.
The by-key `tasks` read, the program runner and a brief's basis all read the latest result through `latestResult`.
The report wake carries it as a typed fact after "Its result, as declared:", a by-key `tasks` read carries `result` and `result_schema`, and a brief whose basis carries one prints it after that task's report under the same words.
A crewmate's report text that ends a turn without the tool carries no result.
A task running on another computer carries its result home on the report order; every computer taking work on the current contract major supports it.

`branch_from` names, by key, the task whose last commit a task's working copy starts at: that task's branch head while its working copy is present on this Mac, else the kept ref its work was saved on.
The host checks it when it is named and again when the task starts, and refuses as tool text an unknown task, the task itself, a task in another project, a working copy on another computer, or a task with neither a branch nor saved work (`handOffShape` in `workShape.ts`).
A step filed behind open work that has not started yet may name it; a start that then finds nothing to branch from fails in those words.
On this Mac the working copy is created at that commit at dispatch (`WorkspaceService.baseAt`) instead of the dispatch base, and the brief says so in one line (`renderBranchFromLine`).
On a computer that runs work the working copy is created at the default branch instead: the source's work kept on this Mac crosses into its repository there as a replacement's saved work does, and the brief tells the crewmate to reset its branch to that commit before anything else, only while its working copy has no edits and no commit of its own, and to stop and report rather than reset otherwise (`renderBranchFromCarriedLine`; `docs/helper.md`, "Starting from a source task").
A task that starts on an approved version (`built_on`) or a review's version starts there, as on this Mac: its source is not checked at the start, and its brief says nothing of the source.
Both fields change only on open work that has not started, like `basis`, and both are the first mate's own, so no host stamp writes them (`CAPTAIN_OWNED_SHAPE_FIELDS`); `branch_from` is recorded as a `branch-source` reference ("Relationships").
`update_task` clears either one with an empty value, `{}` or an empty string.
The tools serve both parameters bare, with no description, and the served sequences guide's preamble says their rule once, to keep the first mate's fixed context inside its boundary (`tests/firstmate-fixed-context.test.ts`).

## The unified timeline

`TaskTimeline` (`src/core/tasks/taskTimeline.ts`) reads every durable entry of one task in one versioned shape (`TimelineEntry`, `src/shared/timeline.ts`): the task's events and the events that concern it, its cards' evidence and thread lines, and its crewmate's actions from the kept sessions (INF-1296 piece 1).
Each owner keeps its records; the reader writes nothing, and an entry grants nothing.
An entry carries its time as recorded (null when the source holds none), who did it, a one-line summary, its content kind with that kind's version, and an exact reference to its source: a task event by id, a card observation by id with the offer, interaction and thread message it names, a thread line by message id, or a session action by file name and place.
Every task event kind and card observation kind maps to exactly one content kind (`EVENT_CONTENT`, `OBSERVATION_CONTENT`), and a new kind fails the build until it has one.
Two records are read as one entry only where an owner named them the same occurrence: a card's thread reference folds into its thread line, and a card choice event that names its card evidence (`card_resolved`'s `data.observation`, written since INF-1296) folds into that evidence as an alias.
Nothing is folded on matching words or nearby times, so an older choice that names no evidence stays visible from both owners.
Links are the owners' own: a choice, close or thread line replies to its offer, an offer revises the one it replaced, an effect's receipt names the interaction that caused it, and an event about another task names that task and how it stands.
Task events retain a task-scoped stable source identity through export/import, independently of remapped numeric storage ids.
The order is stable: undated entries first, then by time, then by source (task events, card evidence, thread lines, actions), then by each source's own order.
`read` pages that order behind a cursor holding the cut it was taken at, and an incomplete agent timeline field read retains its first cut until its final transport page, so later entries cannot shift or repeat a page; `expand` opens one entry's exact source record, or says it is gone or not this task's.
Activity reads `TaskDetail.timeline`; an agent explicitly requesting `field: "timeline"` receives the same normalized headers with their exact typed source records.
Ordinary by-key reads do not load or include timeline bodies.
The query tool retains its most recent incomplete timeline field read under the task's canonical id, so its key and id share a captured cut.
Completing that read releases it; starting another timeline read replaces it, and a superseded continuation explicitly asks to restart from the first offset rather than combining cuts.
The earlier `events`, `activityLog`, reports, decisions and sessions fields remain compatible focused projections.
Activity keeps the existing condensed event rows, interleaves card evidence, thread lines, brief receipts and retained conversation actions, and exposes folded sources through native keyboard disclosures.
The displayed author distinguishes the captain, agents, the app and a card script; an unknown time says Undated.
A historical offer opens its retained words, never the latest card body, and historical actions have no live controls.
Revised briefs, conversation observations and script choices lead with plain text; where the source carries raw data, `TimelineReading.details` keeps it in a further keyboard-reachable disclosure.
A closing question answer or operation result takes precedence over its status source's shorter text when no report already carries that outcome.
An unavailable source is explicit; opening history grants nothing, changes no permission and repeats no effect.

## Starting dropped work again

The dropped work record offers Start again in its action bar's next slot, with no confirmation and the shared keyboard focus ring.
Done records have no bar, including work carried on by another task ("Work carried on by another task"); dropped work with parts, a `replaced-by` successor or a stronger-model retry has no Start again.
An accepted click removes that record from the stack, not from history; a refusal is inline and writes nothing.
The old task stays dropped.

`TaskService.starts.startAgain` creates a fresh record and the old-to-new `replaced-by` link in one transaction, and the link moves the old task's live waits to the new task (`docs/task-graph.md`, "A wait follows moved work").
It copies title, goal, intent (including the captain's words and constraints), project, repository, priority and a parent that is still open or active.
The supervisor carries the basis, captain-named model and task-level delivery, autonomy and care declarations, but no session, chosen model/account, delivery outcome or escalation stamp.
It dispatches through the ordinary Start path with fresh routing, not a tier increase, after pending retirement has finished.
The replacement's brief reads its predecessors beside discovered-from origins, carrying their keys, full reports and saved work even when they never reported.
The crewmate starts a fresh conversation and applies saved work itself; the working copy is not preloaded.
The basis remains a specification, never a substitute for saved-work provenance.

A captain click writes a `note` on the old task with `startAgain` naming the new key and `via: task-card`, which the next first mate context lists once beside other task-card clicks.
`update_task start_again` is the conversational equivalent, only on the captain's own request, and returns the replacement key.
It takes no other edits or operation in that call; start and steer refusals on dropped tasks point to it.
Drop task and Discard ("One drop"), stronger-model retries, provider retries and closed-work retirement retain their meanings.

## Ready waiting is a presentation projection

Approved specification: FI3-275, direction A, reachable cards, split waiting children.
Cancellation and terminal session failure retire task cards at closure through `TaskClosing.closeRecord` (FI3-270); the waiting projection also independently excludes closed tasks.
`waitingCardId` is the operational ready-decision fact: the first unresolved shown ready decision associated with a live task, with no `awaiting` and nonempty actions, in `CardService.taskSnapshot()` order.
Direct associations and captain-gate references use that same test.
A ready card behind the foreground card still counts; navigation can focus it.
A hidden or Working sibling cannot mask another ready decision.
Closed tasks always have null.
A saved marked answer has its own `answerNoteId` and `answerSince`, the note’s recorded time (INF-1879).
That answer remains Waiting on you in the task’s row and project count after reading or restart, with Done in the record’s next slot; the corner never completes it and no timer does.
Count each task once, not cards or ancestors.

`flags.needsYou` and project `counts.needsYou` retain broader durable attention (cards, captain holds and dead dependencies); those facts alone never label a task as waiting.
Ready waiting also implies attention.
A crewmate-declared `captainWait` remains an operational hold, but never creates a waiting label, lane or count without a ready card (FI3-702).
A cardless paused record keeps the latest report summary in its attention box, even when a later closed note occupies Now; the host displays that authored reason without classifying its prose.
Continuing checks, jobs or replies take precedence over that paused box.
Project `counts.waitingOnYou` is the derived live-task waiting count (protocol 1.39.0).
No task status, readiness column or dispatch permission is added.
Losing a waiting signal never releases a gate.
A saved ready answer offers Done in the next slot; otherwise the record keeps generic attention/hold guidance and the bar's other slots when there is no ready choice.
A ready choice outranks a blocker or an interruption in the action bar, whose next slot is then Show the card, while the body's attention box still names the blocker or interruption.

CardService declares stack changes through `presentationChanged` at its broadcast seam, including pending shown-version revisions, reply holds, close-out, Working/ready, retirement and restoration.
`TaskService` alone advances `task_board.seq` for that invalidation, without changing task rows, updated/idle/recovery clocks, timeline or feed.
TaskProtocol delivers the focusable card snapshot before its board snapshot or delta, explicitly, not by relative timer delays.
Its task-flag read uses the card owner's staged versions and durable open heads, without rebuilding each card's message graph, task title or seen state.
The board shares one staged-card read between minimized tasks and ready decisions, and indexes incoming links once for wait dates and queue waits.
A queue wait indexes its incoming prerequisite dates once rather than searching the same edges separately for every blocker.
A tier read seeks only each requested task's newest routing decision that chose a model, selecting its served slot and legacy bucket without reading the routing history.
The first mate's roster requests started crew only, so it does not derive computer places or check summaries for unstarted tasks that its backlog counts instead.
Crew status checks the queue-wait owner's applicability before fetching blockers, links or children, so started work reads none of those inputs for an inapplicable start wait.
Its thread facts use one current batch of open-card counts and last authors for the selected crew, without fetching each message body (`docs/card-threads.md`).
Live review witnesses select open children before composing records, without loading closed review payloads.
Job membership reads declared command ids through `LoadLine.taskIds`, never a capacity or system-memory snapshot.
Move eligibility shares the projection and formats a refusal only when an action asks for one; unchanged board views retain their lifecycle moves.
A device place is shared from the device snapshot once per refresh, and an address change invalidates that snapshot and its places.
A presentation refresh reuses its derived posture when its synchronous post-commit listener publishes that same fact.
The board consumes that publication's already-read posture, place and move facts once at the same task sequence; any intervening task write or another owner's presentation invalidation discards them.
The standalone projects read uses the current board's project counts, so it does not build each live task's full view again after a board update.
`tasks.detail` re-reads on either board carrier as well as its own events; project readers refresh too.

The renderer immediately overlays local card availability on board/detail and project waiting counts when it hides a reply, or restores a refused one.
The read executor retains raw data as its delta base; local presentation does not change seq.
A presentation change repaints what each reader holds and reads nothing again: a change the core derives from the stack arrives on the board carriers, so a card change never sends each board reader back for the whole board.
A read that holds nothing yet keeps its first read through a presentation change: that read lands when it answers, presented for the stack as it is then (INF-2526).
Older snapshots/deltas do not restore a hidden shortcut; gaps re-read.
In-flight reply pushes stay hidden, and a reply receipt refreshes the stack if a fast author returned before the receipt.
Task navigation and Show the card refresh the association before focusing it, falling back to the record rather than forcing a hidden card forward.

Tasks separates a waiting child from a working parent tree.
Nonwaiting parents/siblings keep their existing grouping, nesting, sorting and activity dots; no parent context is duplicated or counted as a decision.
The binding interface regression is `src/core/tasks/readyWaiting.test.ts`, joined through real CardService, TaskProtocol and the read executor; the isolated app journey is the ready-waiting case in `tests/e2e/card-threads.spec.ts`.

A crewmate's `report` takes an optional top-level `summary`: one plain sentence of what happened.
The record's headline and the feed's report line prefer it.
Without one, the first sentence past a leading Intent section stands in.

## A held task says why

Queued work a gate holds has never reported, so its record's attention box says what the gate waits for and what ends the wait instead of asking for a reason (`TaskDetail.hold`).
The host reads it from the gate and the work's own ask alone, never from words (`holdOf` in `src/core/tasks/taskDetail.ts`), and `taskHoldWords` in `src/shared/taskHold.ts` is its one wording.
A level's gate that is the level the work asked for is that ask's own wait: a premium ask, or a stronger-model retry's rung, held on that level's allowance rather than started lower (`requiresReasoningWait`, `docs/routing.md`).
Its words say it starts by itself once a model at that level has allowance, and that the first mate can start it sooner on another model.
When no allowance reset can end that wait, the gate carries why (`TaskGate.cause`, set by the hold that routed it): `empty` when no model is placed at the level, and `pictures` when the task carries pictures and every model placed there reads text only (`docs/routing.md`, "Pictures").
The words then say that, and that it starts once a model is placed there, or one there reads pictures; the record's wait and queue line read the same cause, so none of them names allowance.
Any other gate on queued work is one first mate set with `start_after`: a level's allowance, a plan's allowance by its provider's name, or a time in this computer's zone.
The captain's own gate, and any gate on underway work, keeps the paused box above.

## The plan a crewmate reports

A crewmate's `note_progress` takes an optional `plan` beside its line (FI3-734, the captain's Build it on the steps-view preview): the whole list of what the task takes, each item a label, a short label for its dot, and a state the crewmate declares - done, current, next or skipped (`src/shared/taskPlan.ts`).
The tool and the persona prompt ask for a short, high-level list of under eight items, sent with the brief, sent whole with every later note, unchanged if nothing moved, with finished items folded into one to make room, and every item done or skipped at the final report.
They ask for a note as soon as an item finishes or the work moves to the next one, in the middle of the turn, so the plan moves while the crewmate works rather than with its brief and its report alone (INF-1464; `scripts/evals/progressCadence.ts` measures it, `docs/account-evaluation.md` "Progress cadence").
How long and how many is the crewmate's call (INF-484 move 5: clip and show, never refuse a shape): the host keeps every word and every item, the record lists them whole, and the summary's line cuts what it cannot hold - a short label by its width, with the full name on hover, and past twelve dots the items after the current one, folded into one (`clipPlanLine`).
A note that omits the list is written and leaves the last list standing, and its answer says so; only a list no surface could draw - an item with no words, a state outside the four, an empty list - is refused, in words and writing nothing.
The list rides the `progress` event's data (`TaskService.noteProgress`), never a column of its own, and `tasks.detail` reads the newest note that carried one as `plan` (`planOf`, `src/core/tasks/taskDetail.ts`): the items as declared plus `since`, when each first read its state in an unbroken run of notes, matched by label, so a finished item shows when it finished and a folded item reads from the note that folded it.
Null when no note ever carried one; the board row carries none, so the crew summary shows the plan once the record answers, as it shows Now.
The shared task facts carry it as `plan` after `now` (`taskFactsOf`), labelled Progress, with the newest list note’s short age at the right edge as on Now, drawn as dots on the summary and as the list on the record (the design skill's NowPanel, Shared task facts); `foldPlan`, `clipPlanLine` and `planCounts` are the one home of the fold past eight items, the line's cut past twelve dots and the count.

## What Activity holds

A task's Activity (`TaskDetail.activityLog`, `condenseActivity` in `src/core/tasks/recordActivity.ts`) holds every event of its timeline in time order, read in plain words from typed fields only, never from the words.
It also holds the events of other tasks that concern it, each a row in its time ("Whom an event concerns" below).
The compatible `activityLog` projection folds a minor event under the next row of the task's own, the one it led to, and what no row followed yet folds under the newest of them.
A row carries what folded under it as `folded`, oldest first, and on the record its line opens to them (the design skill's TaskRecord, "Activity lines that open").
The compatible projection keeps its older folded action summaries; Activity itself reads those actions from the common timeline, without a second displayed copy.
The timeline itself stays whole on `TaskDetail.events`.
An answer given on a card is stored as the card's body (`FileQuestionInput`, `recordAnswer`), so `TaskDetail.outcome` reads it as the card's words (`cardWords` in `src/shared/cardWords.ts`), and the line that closed the task opens to those words, never to the markup.
The `tasks` query keeps the body, and the record's Cards tab opens the card itself.

Every event kind has one place: a `row` of its own, `folded` under the row it led to, or `evidence` the timeline keeps for whoever digs.
`ACTIVITY_PLACES` is the code copy of this table, so a new kind fails the build until it has a place; `recordActivity.test.ts` holds the two to the same places and checks that condensing leaves out nothing but evidence.

| Kind | Place | When it reads otherwise |
| --- | --- | --- |
| `created` | row | |
| `ask` | row | |
| `answered` | row | |
| `briefed` | evidence | The brief as sent, read on the timeline and by the `tasks` query. |
| `dispatched` | row | |
| `steered` | row | A reply the captain typed under a card reads as the captain's words and the card's title; a line the captain typed in the Crewmate tab reads as the captain's words. |
| `progress` | row | The update just before a crewmate's report folds under the report, which restates it. |
| `report` | row | |
| `failed` | row | |
| `card_raised` | row | |
| `card_resolved` | row | |
| `status` | folded | A status that closes the task is a row. |
| `linked` | row | |
| `unlinked` | row | |
| `moved` | row | |
| `pr_opened` | row | |
| `ci` | row | A reading with the same result as the last one shown, or with no change to read, folds. |
| `landed` | row | |
| `merged` | row | The host's receipt reads as the pull request the task opened (`Merged pull request #965.`), not its address. |
| `triaged` | row | |
| `note` | row | One its writer declared bookkeeping folds. |
| `compacted` | row | |
| `interrupted` | row | |
| `decided` | evidence | The first mate's sorting decisions, for the export and the offline readers. |
| `escalated` | row | |
| `review` | row | |
| `cap_reset` | row | |
| `replied` | row | A reply its crewmate or the first mate wrote under one of the task's cards reads as its first sentence under the card's title. |

Each writer of a `note` declares what it is, through `TaskService.note`'s required `news`, stored as `data.news`.
News is a row: a merge approval or refusal, a kept merge that ended, the captain's override and its take-back (quoting the captain's words, `docs/delivery-rigor.md` "The holds"), a working copy kept, a quiet crewmate, a failed install, what happened to the task's browser.
Bookkeeping folds: where the working copy came from, dependencies installed, a working copy removed with its work saved, a closed task's leftover files removed, lint findings at a commit, a refused merge card.
A note written before writers declared is news unless the host wrote it.

A reply the captain typed under a card is recorded as the whole message its crewmate was sent.
The steer's `data.words` says where the captain's own words sit in that text, a span rather than a copy (`replyWordsSpan`, `src/core/orchestrator/wakes.ts`), and Activity reads the card's title by `cardId`.
A reply recorded before the span, or one whose text redaction changed, reads as the whole message.
A line the captain typed in the task card's Crewmate tab is the same kind of steer (`via: "crewmate-tab"`, `docs/task-card-tabs.md`, "Typing"), its words a span too, and reads `You told the crewmate: ...`.
A reply its crewmate or the first mate writes in a card's thread is a `replied` event on the card's task (`TaskService.turns.recordReply`, from `CardService.addMessage`), with the author's words.
A reply the captain types under a first mate card reaches the first mate as a turn, and its ask is the record of it (`docs/task-capture.md`).

A feed line about a task whose fact the task's own timeline does not already hold is a row on that task: the writer names the task (`firstmate_note`'s `taskId`), and the `broadcastEvent` seam writes it as a news `note` that the feed reads back, with its words as written (`data.feedLine`).
The feed line stays where it was, now with the task's key.
A writer that would repeat one line on a task marks it with `data.feedOnce`, a name for the line, and the feed shows only the newest of that name per task while the timeline keeps each (`recentFeed`, `src/core/tasks/taskFeed.ts`): queued guidance going out as a crewmate's next turn is one (INF-1137).
Each line in the first mate's computer's own words carries `saidHere`, every line but a crewmate's report and the captain's own turn, so a computer that controls it names that computer where the line says this computer (`docs/view.md`, "The first mate's own words").
So does each Activity line of the record that the host, its own steering or the first mate wrote (`condenseActivity`), never the captain's or a crewmate's.
Activity sentences start with capitals at their producers, including `taskFeedLine`, which authors the same task update for live events and restored history.
The renderer never changes the case of supplied text, so a deliberate lowercase name, key, path or command stays intact; previously stored free-text notes keep their original words.
A line whose fact the record already holds - the captain's reply or a line the captain typed in the Crewmate tab, a start, a drop, a filing, a close, the receipt of a merge - names no task and stays task-less.

## Whom an event concerns

An event is written once, on its own task, and names the other tasks it concerns (FI3-1189's rule 1).
`TaskService` derives them in the transaction that writes the event, only from the typed links and the declared basis as they stand then, and keeps them in `task_event_concerns` (migration 71): the event, the other task, how the event's task stands to it, and the task a replacement carried it through (`via`).
`TaskService.concerning` reads them, and that task's Activity shows each as a row naming the task that wrote it (`TaskActivityLine.from`), whose key at the line's end is a link to that task.
Such a row takes no fold, and it never stands as the task's Now line ("The Now line" below).

| Event | Concerns | How it reads there |
| --- | --- | --- |
| A milestone: `created`, `dispatched`, `pr_opened`, `merged`, `landed`, and a `status` or `failed` that closes the task | its parent; each task it blocks; the origin it was filed from; the task its basis names (INF-976); the task it replaced, and through it every task that one concerns | `SCR-5, a part of this task, merged pull request #977.`, `SCR-7, built on this task, merged pull request #977.` and `SCR-6, which replaced SCR-3, merged pull request #977.` |
| `linked` and `unlinked` | the link's other end | `SCR-4 waits for this task.`; the far end of a filing folds under the filing's own note |
| A refused merge (`note` with `data.refused`) | each task the refusal names that a link or a parent edge joins to it | `SCR-1, which waits for this task, could not merge.` |

A drop reads with its reason, and work another task carries on names that task (`SCR-3, filed by this task, closed: SCR-6 carries on its work.`).
The first mate declares the replacement with `update_task`'s `replaced_by` beside `drop`, which writes a `replaced-by` link from the dropped task to its replacement before the close, or with `link_tasks` type `replaced-by` (`docs/task-graph.md`).

## One close as done

The first mate closes finished work with one close, `settle_task` mode `done`, and names why: `answered`, `finished`, `released`, `carried_on` or `merged` (`DoneClose`, `src/core/orchestrator/doneClose.ts`).
`finished` and `released` need `evidence`, `carried_on` needs `carried_by`, and `merged` names `delivered_in`, any pull request in the task's project or a commit on the main branch, or reads the task's own pull request.
Before it closes, the close reads every delivery fact it can: the pull request or commit it names, each of the task's own pull requests, its working copy, the task carrying it, where its answer went, the evidence and the open parts that stay planned.
It records each fact on the close event (`deliveryFacts`, `src/shared/deliveryFacts.ts`) as checked by the app, stated by the first mate, or unread when the app could not read it, and its answer lists them.
A fact the app cannot read never stops the close.
The task's own pull request stays open where the project lives when the close is not `carried_on`, and the record says it is still open; a `carried_on` close closes it unless the carrier shares it.
When the first mate closes on its own, four soft holds stop the close: `decisions` (a card or wait on the captain, or an answer the captain asked for and has not read), `parts` (open children), `waits` (a task it waits on) and `proof`, the delivery proof.
An answer closed `carried_on` by the task the captain's own reply under its crewmate's card started (`spawn_crewmate`'s `from_card`, `docs/card-threads.md`) passes `decisions` on its own: the reply shows the captain read the answer and chose what follows, so its answer card still up or never chosen on holds nothing; a card that still asks, a wait on the captain, a reply under another card and any other carrier still hold it.
The proof holds while its crewmate is still working, has guidance queued or has not reported, while its own pull request reads open, while a `merged` close's change does not read merged, and while its working copy holds work that is not merged and the close names nowhere else it went.
The open batch's pull request in the task's project is never one of the task's own pull requests, whichever task read it, and a close sends nothing to it (`docs/forge.md`, "A held batch").
Instead, the proof holds the batch's recorded repair while the batch is held for its checks and the batch record holds no answer to that hold: no fix of its own declared, no fix awaited after its send-back, no send-back since the hold began and no rerun declared passed at the held version (`repairUnanswered`, `src/core/batches/line.ts`).
That refusal names the batch's ways out, its crewmate's `check_change` batch declaration or Try again through `app_change`'s `project-batch-answer`, and says the hold also ends once the failed checks pass when run again; a `carried_on` close passes it, as it passes the task's own open pull request.
A refusal for queued guidance names each message still waiting for the crewmate: its id, how long ago it was queued, whether it was never delivered, tried and not taken, or handed to a turn that never finished with it, and its words (`waitingGuidance`, `src/core/orchestrator/waitingGuidance.ts`).
When the first mate judges the crewmate no longer needs one, the close's `drop_waiting` names its id: while the crewmate is idle, the close reads its holds as if the message were gone and drops it from the crewmate's lane only once the close goes through, so a close refused for anything else drops nothing; it writes the dropped words on the task's timeline as the first mate's, and cancels a response request it carried (INF-4072); a working crewmate refuses the drop, and an id not waiting for the task is left alone.
Where the work went is a merged pull request or commit, a release or the task carrying it on; for the working copy of a started answer task closed `answered`, it is also a live task that names it as its basis or waits on it, and that close still saves the copy.
The captain's own words pass every soft hold: `captain_words` names where they came in (this turn, the card or the Crewmate tab line), and the close records them with the facts.
A merge click is never such words; merging stays on the merge card.
The close only refuses outright what no words change: a task that is not crew work, one already closed, one another settle holds, and missing evidence or a missing carrier.

The record shows the facts as its first row, labelled Delivered beside Goal and Now, each with how it is known at the line's right edge: Checked, As stated, or Not read (`closing.facts` on the task's detail, `RecordDelivered` in `src/renderer/src/cards/RecordHead.tsx`).
A close the captain's word asked reads `Finished on your word` (`closing.onWord`), and the line keeps only the words the close adds beyond its reason.

A started task's record offers Close as done (`recordOffersCloseDone`, `src/shared/recordCloseDone.ts`): the captain's own word, from the record, that the work is done.
It sits just left of the bar's next slot on started work whose start was accepted and that has no saved answer waiting for Done, and command search lists it as Close the task as done (`task.close-done`).
It asks once, inline, as Drop task does: Cancel takes focus, the sentence says a working crewmate stops, unmerged work is saved and an open pull request stays open, and a second Close as done closes it.
The press closes the task through the one close as done (`HostOps.closeDoneFromRecord`, `inf:task:close-done`) as the captain's, from the task card, with the press as their words, so it passes every soft hold and meets only the real limits; with no why named it closes `finished`.
The record stays shown and reads Done with its facts; a refusal is the bar's inline line and writes nothing.

## One drop

Discard and Drop task end a task by one set of rules (`TaskDrop`, `src/core/orchestrator/taskDrop.ts`): the first mate's `settle_task` discard, a card's Discard button, and the captain's Drop task on started and on never-started work all run it.
Discard records the close as `discarded` and Drop task as `cancelled`, so each surface keeps its own word.
The drop refuses outright only what no choice changes: a task that is not here, a decision, another settle of the same task still running, a task already closed with neither a kept copy nor a failure's pull request, and a record that changed since the captain reviewed it on the record.
A drop stops a working crewmate, closes the task's own open pull request and waits for that close, filing the task that closes it when the host refuses, and saves its commits and edits on the task's kept ref, as every close does.
A copy whose work cannot be saved stays on disk, and the record says so; dropping the closed task again removes it.
A failed task's pull request stays open when it fails; discarding the failed task closes it, unless an open task, such as its stronger-model retry, now delivers through it, which the discard's answer names.
Open parts stay planned, and a part that started keeps working.
The captain's own drop, by Drop task or a click on a Discard button, passes every hold.
The first mate dropping on its own meets three holds: open parts, which `proceed_with_open` passes; a crewmate still working; and work that is not merged or cannot be read, which `confirm` passes after the captain chose.
Never-started work has no crewmate, copy or pull request, so its record closes within the click.
`interrupt_crewmate` cancel, the first mate's own stop of a turn, and `update_task drop` on open work keep their own closes.

## Work carried on by another task

Work another task carries on closes done, never dropped (INF-1825): "dropped" is kept for work that was really abandoned.
The first mate closes work another task carries on with `settle_task` done, why `carried_on`, and `carried_by`, the task carrying it (`DoneClose`); its open parts stay planned, and a part of its own may carry it.
It is also the close for work another task delivered in its merged pull request while the old task's own pull request closed unmerged (INF-2626), since the merge close reads that closed pull request and cannot close the task.
The close writes the `replaced-by` link first, so the old task's live waits move to that task before the close clears them (`docs/task-graph.md`, "A wait follows moved work").
Its unmerged commits are saved as every close saves them, and its own pull request is closed unless the task carrying the work carries that same pull request.
It closes with status `done` and reason `superseded`, an existing closing reason, so the published contract gains no member (`carriedOnClose`).
`closedWithoutClick` gives that reason no outcome, so no closing note goes up; Activity shows one line, `Carried on by SCR-6`.
The close is refused for the task itself, a dropped task and a task already carried on by another, and, when the first mate closes on its own, held while a decision card of the old task waits on the captain.
The record's closed line follows the last task of the replacement chain (`TaskService.graph.carriedOn`): `Carried on by SCR-6` while it runs, `Done through SCR-6` once it is done, and `Carried on by SCR-6, which was dropped` if it drops later.
The task view publishes `replacedBy` on such a done row as it does on a dropped one.
The board reads it for every row it shows at once (`TaskService.graph.replacementsOf`): the `replaced-by` links, then the stronger-model moves through the event reference index, never a task's timeline.
When the task carrying the work closed first, its outcome was held back while the old task was open in the same message, so the old task's close places that outcome once, where it would have gone.
A chain that ends on a dropped task places nothing: a dropped task carries no work on, so it is reached only through a link left from before its drop, and its old closing line is no news.
Its crewmate goes home on the ring as any done task's does.
An event another task reads is exempt from timeline compaction, so the row it makes there never folds away.
A `compacted` row keeps the newest plan it folded (`plan`, written at `planAt`) and the highest program line number per op it folded (`programLines`), so the task's plan and a program's replay still read them.
The task export carries each event's concerns on its line (`concerns`), and an import writes them back with the event.

## Other tasks' keys in the record

Every other task's key the record shows is a link to that task (FI3-1271; the design skill's core rule "Task keys"): resting on it opens that task's summary beside the record, and a click or Enter opens its record in front.
That holds for the Waiting on box, the Info tab's Part of, Waits on and Holds up rows, the Now line, Activity's lines and the texts they open to, the goal, the captain's words and a refused drop; the record's own key stays text, as do Cards tab titles, an Activity line's toggle and Drop task's question.
The window finds which keys name tasks from the record's own read (`recordWords` in `RecordCard.tsx`, then `useTaskLinks`), and the record's frame links them where its text writes them, as a card's body does (`docs/card-authoring.md`, "Task keys").
Part of names the parent's key, never its id: the frame reads the parent's own record when the board does not list it.

## Pull requests in the record

Every pull request the record names by its number links to its page where the host has one on the web (FI3-1159; the design skill's TaskRecord, "Pull request links").
`condenseActivity` says which words of a line name one, as `TaskActivityLine.change`: the span of the text and the page, never a copy of the words.
On the task's own lines that is the task's pull request, from the `pr_opened` event's `prUrl`, wherever its label stands as a whole token (`#965`, not `#9650`), with "pull request " or "PR " just before it taken in; on a linked task's line it is that task's pull request (`ConcernedEventView.from.changeUrl`, its delivery's `prUrl`).
A pull request with no `https` page, or a branch on a plain Git host, gives no span.
Now carries its row's span when it reads a row (`taskFactsOf`), so the record links it there too; the record's frame links the Activity lines, and a click goes where every link in the record goes.
`recordActivity.test.ts` holds the spans, `record.frame.test.ts` the frame's links, and `tests/e2e/task-card-links.spec.ts` opens the pull request from the fact strip, from Now by keys and from an Activity line.
The `tasks` query's rows carry the same change as `change`, its label and its page (`taskChangeOf`), so an agent that names a task's pull request on a card links the page it was given (FI3-1307; `docs/card-authoring.md`, "Pull request numbers").

## Activity updates during a press

The record frame reconciles Activity rows by event id, leaving unchanged nodes mounted rather than detaching them with `replaceChildren`.
A native pointer press therefore reaches the same summary on release even when a detail or board update arrives between them.
When folded events, actions or whole text change beneath an unchanged summary, the frame keeps that disclosure, its summary and its count node, and refreshes the body and count in place.
The retained rows keep their age registrations, so relative times and their accessible names still refresh on pushes and minute ticks.
Rows that change their summary or disclosure shape are rebuilt with the existing open-state and late-toggle handoff; removed rows leave the rendering cache.
This is Activity's renderer behavior only; Cards and Knowledge used still render through their own owners.

## A crewmate's actions

Activity also holds what the task's crewmate did: each call it made to a tool other than the app's own, read from the sessions the app keeps for the task (FI3-1189's rule 3, the captain's "Folded under the row they led to").
The calls are never copied into the timeline, whose ordinary history folds into counts past 500 events (`TIMELINE_CAP`); the session already keeps every call, and nothing prunes it (`docs/task-retention.md`).
`CrewActions` (`src/core/tasks/crewActions.ts`) reads every session in `crewmates/<task>/sessions/` through the one session reader (`sessionAssistantLines`, `src/core/storage/sessionReader.ts`), with the Claude client's own file standing in for the app's copy of the same session while it holds a turn's tail the copy has not caught up with (`createCrewmateTranscriptResolver`).
It follows each file as it grows: a read parses only the whole lines appended since the last, and only a line that can be an assistant's.
A call to the app's own tools (`CREWMATE_TOOLS`) is left out, because what it did is already an event: a report, an update, a card, a pull request.
So is a shell call that runs one of the app's own task commands, such as `infinitary-browser-axi` (`runsTaskCommand`, `docs/axi-commands.md`): the task's browser line and timeline already say what its browser did, and never what was typed into a page.
A call reads as the one-line description the crewmate wrote with it; a call with none reads plainly from its typed arguments (`Read src/a.ts`, `Ran pnpm test`, a path inside the working copy relative to it, and `Used <tool>` for a tool with no reading).
Each line is redacted as an update is and ends in an ellipsis past 160 characters.
The Claude client's command tool asks for a description; the app's own command tool for a Pi crewmate takes an optional `description` for the same line (`src/core/pi/bashTool.ts`).

The task card's Crewmate tab reads the same sessions whole, as a transcript, through the same reader (`docs/task-card-tabs.md`, "The Crewmate tab").

`condenseActivity` folds each action under the first row recorded at or after it, the row it led to, as the row's `actions`, and what no row followed yet under the newest row; an update a report restates takes what led to it along under the report.
On the record, a line's count and what it opens to hold its actions and its folded events together, in time order.

## The Info tab

The record's Info tab is shaped like the crew summary a task's circle shows on hover (INF-2261), and the summary itself stays as it was.
The window draws its overview from the shared task facts (`TaskFactRows`, `TaskFactStrip`, `src/renderer/src/design/core/TaskFacts.tsx`), in this order:

1. The attention sentence, when something is wrong or the task waits: a failure, an interruption, a hold or a wait (`recordAttentionOf`, `src/shared/recordAttention.ts`), with a charted filing's Why and a closed task's one line (`recordClosedLineOf`) beside it (`RecordAttention`, `src/renderer/src/cards/RecordHead.tsx`).
2. On a task closed as done, the Delivered row: each delivery fact the close read, with how it is known (`RecordDelivered`).
3. The task's place among other tasks as rows of keys: Part of, Waits on, Holds up and Parts, and the outside issue it answers as a link under Issue (`RecordRelations`; `docs/agents-reach.md`, "A reader's Build rows").
4. The goal, whole, with the captain's words folded under it, closed, the fold's name counting them ("Your 2 messages"); the fold also holds why a crew filing was filed and why the first mate built without a plan (`RecordGoal`, `recordWordsFoldName`).
   The title stays the task's one line in the chrome.
5. Project, Now, Progress and the Browser line, as the summary draws them.
   Project names the task's project, and in a project of several repositories the repository it works in beside it ("Harbor Ledger · ledger-api"; `projectFact`, `src/renderer/src/character/crew/projectFact.ts`, and `PhoneRecord.projectFact` on the phone).
   Tags follows Project once the project has tags or the task carries one: the tags it carries, then Edit tags (`RecordTags`, `docs/task-tags.md`).
6. One row of facts under a hairline, as the summary's footer row: the model, the task's Difficulty badge (the level its routing asked for), the reasoning, the change with its checks as one cell, the review, Delivery, Runs on, a dim mono Use cell and a Run cell beside it ("Live resource use"), then Why this model.
7. One closed More row at the end, scrolling with the body: the facts the summary leaves out, with their policy sources, Knowledge used and Live validation; a short dim preview beside its name says what it holds.

The words fold and More are remembered per task while its record stays in the stack, as every record section is (`recordOpenSections`): paging away and back keeps them, and closing the record ends its visit, so reopening starts with both closed.
Cards and Activity are the record's own tabs (`docs/task-card-tabs.md`): the record's sandboxed body draws them and More, and the window tells it which view to show (`view` in its state, `[data-record-view]` on each part).

## Live resource use

The record adds a dim mono Use cell to its row of facts, beside Runs on (`TaskResourceUse`; INF-2261, the captain's pick: "A Use cell beside Runs on, dim mono").
It reads the raw shared computer-resource observations, not a second sampler or the personal-panel memory projection.
Each attributed task share names its computer, measured processor equivalents, resident bytes and process count; RSS can count shared pages more than once and is not unique physical memory.
An unavailable, stale or older reading stays explicit as Use unavailable; no matching processes in sampled computers says No processes running for this task.
The row stays live while the record is open, including when a background job continues after the model turn ends, and changes no task status or idle clock.
The sampler and pressure notices are owned by `docs/helper.md`, "Running tasks’ resource use".
A separate Run cell beside Use shows each caller-declared heavy run's computer, waiting or admitted state, and declared processor and memory amounts (`docs/heavy-runs.md`).
A waiting run says what it awaits or how many runs are ahead; unavailable remote facts keep the last-known run explicitly unavailable, never completed.
A declaration is never presented as measured Use, and neither cell adds a task state or a control.

## The Now line

Now says what the crewmate is doing: its own newest doing, with that doing's age (`nowOf` in `src/shared/taskFacts.ts`; INF-554's audit, built as INF-557).
It is the newest of three things the record already holds.
The first is the crewmate's own newest row: a progress note, a report, a card, a pull request or its checks.
The second is its newest action, in the description it gave the call or the plain reading Activity writes for it.
The third is the last sentence it wrote in its session (`TaskDetail.said`), which `CrewActions.said` reads on the same pass as its actions, from the last line with words of its newest assistant line, never its thinking or a helper's sidechain.
A message the app sent the crewmate and a compaction stay in Activity and never stand as Now, so a crewmate that did nothing since reads its last doing at its true age, and a stalled crewmate looks stalled.
Before its first doing, Now is the task's own newest row but those, such as the start line; a row another task wrote is Activity's alone.
Who wrote a row is its kind, a typed fact; Now never reads a row's words to choose.
The same Now follows `working` in the thread of a crewmate's card the captain replied under, once it is newer than the captain's line, and the record's read re-reads on each of the crewmate's calls so it moves with the work (`docs/card-threads.md`, "The waiting line").

## Notes

Moved verbatim from `AGENTS.md` on 2026-09-24; `docs/README.md` lists this page.

- The task record (task-system design P0, captain decisions D2/D5/D6; spec `fm-homes/mini-default/data/fm3000-task-system-design-s1/report.md`): a task is a RECORD, not a runtime handle.
  `src/core/tasks/taskService.ts` is the ONE writer over `tasks` / `task_events` / `task_links` (migrations 17-19) - every state change commits in one transaction with the timeline event that explains it; nothing else writes those tables, and tests seed rows through `seedTask` (`src/core/tasks/seedTask.ts`), never raw SQL.
  A read of many rows (`list`, `listByStatus`, `listLiveOrClosedSince`, `getMany` and `listChildren` in `src/core/storage/taskRecords.ts`) comes back oldest first, by `created_at` and then `seq`, sorted after reading and never by an `ORDER BY` over whole rows.
  SQLite's sorter copies every column of every row it sorts, and once that copy outgrows its cache it writes it to a temporary file, on the main thread, on every read of a long record (INF-940; `taskService.test.ts` asks SQLite for each read's plan).
  Status is `open | active | done | dropped` with `activity` (starting/running/idle/interrupted) while active and `closed_reason` once closed; the offline corpus scripts pass the column through verbatim.
  The `delivered` status and the `finish` settle mode were retired together (cards/tasks/agents P2, WI-11, migration 30 maps every historical `delivered` row to `done`): an idle crewmate with unlanded work stays `active` and resumable, shown in the Tasks panel's `working` group like any other active row (captain: "if it's finished and doesn't need me, why is it even there?"; the captain later dropped the group's own separate "to land" bucket - it's just working), until merged, landed, or discarded.
  Settling CLOSES: land -> done/landed, merge-pr -> done/merged (also when the task's current pull request, read by its number, was already merged outside the app and none of its other pull requests is open or unreadable: nothing is sent, with autonomy on or off; INF-2490), an explicitly verified external release -> done/released (`settle_task` done, why `released`, with `evidence` recorded on the timeline; commits only history calls unmerged, such as a squash merge's originals, are kept on the task's kept ref, INF-2628), verified folder work -> done/finished (done, why `finished`, with `evidence`, leaving the folder untouched), any merged pull request or commit on main -> done/merged (done, why `merged`, with `delivered_in`), each through the one close as done ("One close as done"), discard -> dropped/discarded ("One drop"), and - on a task whose deliverable is an ANSWER (Task B of the crew-posture rationalization) - the captain's choice on its own crewmate's card closes it done/answered unless the crewmate declared that card `continues` (INF-1226) or it hands the captain the task's browser (INF-1322), while putting the card away never completes the task; reading an ordinary note still reaches its author, and a marked saved answer waits for explicit Done (the one other path, captain's call C of 2026-09-24: `settle_task` done, why `answered`, closes an IDLE answer task the first mate itself declared an internal step at creation - `WorkShape.internal_step`, its judgment under its instructions, stored and honoured with no host inference - done/answered once a live task names it as its basis or waits on it through a blocks link or once its crewmate reported its answer (INF-1137), or an answer task whose crewmate reports it finished after explicit acknowledgement, never merely after putting away a marked saved answer; a verified result-handoff receipt also permits reported idle work to close under the delivery safeguards in `docs/task-graph.md`), while merge-pr and land are refused on it outright; only the worktree and branch go, the row, its timeline and the session JSONL under `crewmates/<id>` stay (captain: "we shouldn't remove the entire session JSONL altogether"; P5 scopes pruning).
  Fleet hygiene is enforced in code (interaction P0, WI-7): every close refusal is a structured `SettleRefusal` (`{ refused, task, tasks, ways, text }`, WI-12) whose runnable ways ride the settle wake as a fenced JSON block the first mate carries as effect buttons (`proceed_with_open` lets a settle bypass the children-open gate, keeping children planned); every closed status stamps `closed_at` in `patch`, a done/dropped close ALWAYS retires the worktree and branch (captain, 2026-09-22: "cleaned up period. no exceptions") - whatever never landed (uncommitted edits, tracked and untracked but not ignored, plus branch commits) is first saved as ONE commit on the hidden ref `refs/infinitary/kept/<task-id>` (`WorkspaceService.retireTaskWorktree`; outside refs/heads, never named on a surface, nothing expires it yet), git ancestry only decides whether a save is needed (it reads squash-merged work as unlanded forever), and the one exception is a save that FAILS, which keeps the tree with a feed line, until a drop of the closed task removes it ("One drop"); a task on a computer that runs work keeps its working copy there, `present` with no `worktree_dir`, and its close saves the same commit there, brings it home as a bundle and only then deletes the copy (`docs/helper.md`, "Its working copies"), and a working copy there whose task this Mac no longer records goes by the same rule, its work saved here first (`docs/helper.md`, "Leftovers"); boot hygiene applies the same rule to closed rows still holding a tree and to directories under `userData/worktrees` no record explains; the first mate's own discard of unlanded work is refused without `confirm` (its ways: discard anyway, or land/merge instead), while the captain's own Discard click saves the work and drops it, a crewmate's merge card is one `merge` effect the host labels by the repository's posture, with a danger `settle discard` beside a merge that closes the task (INF-2744) - and never a keep button (closing the card is the keep; cards/tasks/agents P1), commissioning installs pnpm dependencies before the first turn (`WorkspaceService.installDependencies`, a timeline note), and `reconcileFleetHygiene` at boot deletes every leftover task branch (marked as a task's, or named `fm/task-*`) no live task explains, each saved on its task's kept ref first, saying nothing about one that went and naming in its feed line one that could not be deleted (`leftoverBranches.ts`).
  The D-13 purge is the one control that deletes the record; a closed task's leftover files go a week after the close (`docs/task-retention.md`).
  `crew_status` and the strip list resumable records (idle/interrupted) with the report from the `outcome` column, so a restart forgets nothing.
  Projects (`projects` table, `ProjectStore`): Scratch plus the projects the managed repositories belong to, each repository naming its one project in `repos.project_id`; a repository's own project is born in `saveNewRepo`'s transaction unless it joins an existing one, and is archived when its last repository is unregistered; keys `<KEY>-<seq>` (`deriveProjectKey`, or the key chosen when the project was added, `docs/fleet.md` "Choosing a task key") are the conversational handle from P3 on.
- The task protocol (task-system P3, `docs/ui-plugins.md` "The read catalog"; design section 9): `src/shared/tasks.ts` is the wire surface (board, detail, project views), `inf:tasks:board` / `inf:tasks:detail` / `inf:projects:list` the reads, `inf:tasks` the push, `task_changed` / `task_event` the two FmEvents, `tasks.board` / `tasks.detail` / `projects.list` the catalog entries.
  ONE seam feeds all of it: every `TaskService` write goes through its writer's `write()` (`TaskWriter`, `src/core/tasks/taskWriter.ts`), whose outermost transaction bumps `task_board.seq` (migration 20, one row) in the same commit and notifies `onChange` listeners only AFTER the commit; `src/core/tasks/taskProtocol.ts` turns each change into the FmEvents through `broadcastEvent` and one coalesced (40 ms) `inf:tasks` board built from task records and the shown card projection, so a pushed board always equals a fresh read (`taskProtocol.push.test.ts` pins it).
  A nested write is one change with one seq; a no-op write bumps nothing; a refused write notifies nothing.
  The board is the LIVE set (open/active, closed within `BOARD_RECENT_MS`, plus shown rows' parents; links only across shown rows), plus every pinned task whatever its age, which lists in Tasks' Pinned alone and brings no old closed parent with it (INF-3127); all other history is `tasks.detail`, one task at a time.
  Building it reads only those rows, the rows at the other ends of their links and their children's counts, never the older closed history, since every crew event pushes it and a long record is mostly that history (INF-703; `taskProtocol.cache.test.ts` counts the rows read).
  Between pushes the board keeps what its last build read (`BoardCache` in `boardCache.ts`, the row cache of INF-2078): one change rebuilds only the rows it reached - the rows the writer touched, the rows at the other ends of their edges (a blocker, what it blocks, a filing's origin, a dropped row's carrier), their parents, the active rows whose standing waits name them, and any row whose card facts moved - and every other row keeps the view it had, the same object, so a change costs the rows it reached and not the board.
  A touched row closed before the board's window that no shown row holds is ruled out from the record its write left, with no read, so closed history written since the last push costs the update nothing (the scale check, `tests/scale-check.test.ts`).
  A rebuilt row is still derived from SQLite and the live host facts at that read; a host fact that moved with no row written (`TaskService.invalidatePresentation`, carried as `TaskChange.presentation`) has every shown row's live facts read again and the rows they moved on rebuilt; a purge or an import rebuilds from nothing; `taskProtocol.cache.test.ts` pins the kept board against a build from nothing after every shape of write, and the rows read and views built per change against a board four times the size.
  A push that builds the board from nothing (the first, or the one after a purge or an import) runs its parts - the rows the board shows, what joins them, and their views - on separate turns of the main process, so other work runs between them (INF-3453).
  Rows written meanwhile reach the pushed board as any change does, and a read that comes before the last part finishes the parts at once (`taskProtocol.push.test.ts`).
  A record's `tasks.detail` reads the same way: the record, the rows its concerning events, standing waits and gate's card name, the rows at the other ends of their links, and one row on its own for any other task its Activity names, never the whole history, since each open of the Info tab reads it several times (INF-939).
  The one exception is the Tasks filter: typed text also asks `inf:tasks:search` / `tasks.search` (`TaskProtocol.search`) for closed work older than the window, for dropped work, and for questions, decisions and operations closed within the window (the panel never lists those), matched on key, title and goal only, newest closed first, at most 50, empty text finding nothing, with the graph read around the found rows alone; the panel paints them as an `earlier` group and a row opens the record through `tasks.detail` like any row.
  That search finds its matches in the read-only record process below (`selectClosedTasks`), which returns only their ids, and the main process composes views for those rows alone; a key a panel looks up is one such search, so a burst of lookups never walks the closed history on the main thread, where it would stall the window (`docs/freeze-recorder.md`).
  A host with no record process reads the same selection in its own process.
  A task key the window draws (`src/renderer/src/cards/taskLinks.ts`) is not such a search: every key the board does not list goes, with the other keys of the same turn, in one `inf:tasks:keys` / `tasks.keys` request (`TaskProtocol.byKeys`), which seeks the key index and answers live work and work closed at any age, this week's included, so a card naming many earlier tasks never reads the closed history once per key (INF-3896).
  Every task search - the filter's board rows, this search, the task board's Find (`docs/task-board.md`) and the `tasks` query's `text` - compares through `foldForSearch` (`src/shared/searchText.ts`): lowercase, with a curly apostrophe or quote read as the plain one a keyboard types, so `what's new` finds `What’s new in …`.
  The agents' `tasks` list and text search use the read-only record process (`src/core/recordReads/`) too: SQLite seeks the requested status partitions and filters project, parent, title and goal before returning compact matching metadata.
  That process orders the matches and returns only the requested page of ids, its total and an explicitly requested snapshot order; the main process composes full records only for that page.
  By-key reads, saved-id pages and project lists retain their existing owners and do not scan the task record.
  Flags (`blocked`, `held`, `needsYou`, `ready`) and `waitingCardId` are derived on read from links, gates and the open card stack.
  The feed is a VIEW since P3: `inf:feed:recent` merges `task_events` (feed=1, line authored by `src/core/tasks/taskFeed.ts` from event + record, keyed by `taskKey`) with the task-less `activity_events`; `feedLineFrom` no longer authors the task-bound runtime events (`task_started`, `task_report`, `task_landed`, `task_finished`, a crewmate's `turn_failed` - those FmEvents still flow for the character, Observe and the strip), and `broadcastEvent` never persists a `task_event` line (it already lives in the timeline).
  The `task_event` FmEvent's `text` is the feed line when `feed` is true, else the timeline text.
  A drop the first mate made carries its closing sentence in the close's data, and its line reads `Dropped:` and that sentence (INF-547; `docs/card-authoring.md`, "Work that closed without the captain's click").
  The two pinned surfaces moved: `window.infinitary` gained `tasks` and `projects` (`phase0-guardrails.spec.ts`); the self-map's channel and event lists are read from the contract itself.

### By-key closing resolution

A single `tasks` lookup includes `resolution` alongside the report/newest card: closing action, submitted answers, resolved time and stored card, plus an exact `offer` when interaction capture recorded it.
Both the first mate and crewmates read the same fields.
The query view omits a closing card or offer body only when it is identical to the newest `card` body.
Its action, submitted answers and other closing metadata remain in `resolution`; a differing historical body stays there too.
The stored resolution is unchanged, and `taskResolutionBody` reads a closing body from its own field or the identical newest body.
The tool-text renderer returns the original heading and indented JSON byte for byte when the complete response fits 50,000 characters, on every provider.
A longer by-key read does not compress and does not cut unique content.
It keeps every field that still fits and names each remaining field, whether that field is its own text or JSON, and that field's length.
Read one named field from a 1-based character offset.
The answer's nextOffset continues that field, and none ends it.
The page index asks the reader to finish the remaining fields before acting.
Each page fits the same 50,000-character band, in characters and in UTF-8 bytes, so the client does not replace it with a saved file.
The first mate's 100,000-token cap stays the outer limit and is not this band.
Distinct historical reports and differing closing card and offer bodies remain whole, alongside every event id, answer, action and other metadata.
This is a paged presentation of the query, not a storage change or a change to authorization.
Lists omit this material.
This is evidence, not authorization interpreted by the host.
The shared `HANDOFF` contract owns that agent judgment.
Basis briefs hand over the matching offer as a file they name and quote the answers alongside full report and thread history.

A missing basis on an existing successor can be repaired with `update_task basis` before a separate `start_now` call.
Only open work that has never started can change its basis; unknown/self references are refused.
This edits grounding, not permission or dependencies, and preserves the rest of its work shape.
By-key/list task rows expose the basis reference.

A model the captain names for a filed task is `update_task override_model_id` (contract v4.46, FI3-436): `TaskService.updateFields` stores it as the shape's `override_model_id` on open work no crewmate holds - a row a failed start returned to the queue included - recomputes `difficulty` from the shape, and an empty value clears it.
Combined with `start_now` it is an edit that applies before the start, so the same row - its key, parent and links - routes on the named model (R0); the start runs behind the tool's answer, and, as for a new spawn, the first mate's `queued-started` wake follows only when another model took it or none is recorded, while the crew list names the model it runs on (`docs/routing.md`).
Before it, a model could be chosen only on a new spawn, so a filed task was dropped and replaced.
A model or basis named or cleared while a queued task starts decides that start (INF-83).
The classifier's verdict is stamped on the row as it stands when the classifier answers, so the edit stays and the tier is computed from it.
A start whose model or basis moved while it waited on a computer, to place the task or to route it, starts over from the record as it now stands.
Once the start claims the row it is no longer open work, so a basis is refused in words, and a named model moves the task instead.

## Moving a started task to another provider

A started task moves to another provider in place (INF-849): it keeps its key, branch, working copy, record, pull request and waiting messages, and only its model, account and sometimes its conversation change.
Two things ask for it, and both run `TaskMoves.requestMove`.
The crewmate sign-in card's default, "Move to" the app's pick, is the captain's: the router evaluates the task's own shape with the failed provider left out (`withoutProvider`, `docs/routing.md`), and the card offers it only when a model serves; otherwise the card keeps only Open settings.
The button names that model by its Settings name (`ModelSlots.nameOf`), the model the task would run on.
A task whose brief carries the captain's pictures is offered only a model that reads them (`docs/routing.md`, "Pictures").
Its `move-task` effect names the task, the provider it moves off and the model offered, so a card left up after another move, or after the app's pick changed, refuses in a feed line rather than move somewhere the card did not name.
`update_task override_model_id` on started work is the first mate's, on the captain's words: the router pins the named model as R0 does, and a model that cannot serve is refused as text.
`update_task unstick move` is the first mate's own answer to a task stuck at its provider (`docs/inbox.md`, "Stuck at its provider"): the app's pick with the refusing provider left out, as the sign-in card's Move, never a model the first mate names.
A crewmate mid-turn moves once that turn ends; a turn is never cut short.
The move prepares a routing preview and selects the account (`selectForSpawn`) before committing the routing decision.
After checking that the task is still active and its turn idle, it commits the routing decision with who asked, lets go of the old session, and writes the record's model and account with one timeline row and feed line naming who moved it (`TaskService.placement.recordMove`).
The sign-in card comes down, the lane's waiting rows are due at once with their spent attempts given back (`InboxStore.movedProvider`), and the task reopens in the same working copy.
Between two Pi providers the same conversation resumes on the new model.
To or from Claude, the new backend cannot reopen the conversation, so a new one starts and is told it moved (`CrewmateRestart` `moved`), with the brief and the earlier transcript's path, as an unopenable one is.
A task on a computer that runs work moves the same way among that computer's own sign-ins, never this Mac's (`docs/helper.md`, "A task's model"): the router evaluates it with that computer's pool (`CrewMachines.served`), no account of this Mac's is selected or recorded, and it reopens there bound to that computer's account that lists the new model.
That computer must be in reach, since its conversation reopens there: out of reach, the move is refused in words and nothing changes, and a computer that has not said what it serves has no other model to offer.

## Requested crew speed

A task’s optional `override_speed` is its own explicit choice, never inherited from a parent, basis or failed attempt.
The task query names it as `crew_speed`; absent means the selected model’s current default.
Speed notes use ordinary task notes, not progress notes, so they never replace or refuse a crewmate’s saved plan.
Each note carries the typed requested, sent and provider-confirmed service with the actual model, and explains any Standard fallback.

## Requested reasoning

A reasoning effort the captain names for a task - low, medium, high or extra high - is its shape's `override_reasoning`: `spawn_crewmate.shape.override_reasoning` at the start, or `update_task reasoning` on open work no crewmate holds, which null clears.
It is the captain's own word for that task, never the first mate's judgment, and never inherited from a parent, basis or failed attempt; start again copies it with the task's other asks.
Its crewmate opens at it in place of the model's Settings → Models choice and the level's default, capped to what the model offers and not stepped down for Quick care (`docs/routing.md`, "Reasoning effort"); the Settings choice is unchanged.
A started conversation keeps the level it opened at, so the edit is refused once a crewmate holds the task.
The task query names it as `reasoning`; the crewmate summary shows the level the session opened at.

## Placement commitments

`task_execution.placement_json` is one bounded historical commitment and its reservation state, written only through `TaskService`.
It preserves the selected computer, stable preparation order, explicit acceptance of an existing model fallback, resolved demand and at most 64 candidate explanations.
`TaskDetail.placement` exposes that snapshot, and the Runs on explanation renders its past-tense reasons and saved headroom.
A live resource refresh never writes it; task retention owns its lifetime.
`v_placements_v1` publishes task id, commitment time, selected computer id/name, reservation state and snapshot JSON, without the private preparation origin, to a declared and granted read-only SQL query.
The snapshot is never reused as fresh scheduling evidence.

## Minimized cards in Tasks

A minimized message remains open, with its task and operational ready-decision association unchanged.
The desktop’s `presentTask` overlays the optional `minimizedCardId` for presentation only, never a gate or a task move.
`nowGroupOf` puts that task’s own row under waiting on you without an added word, even for a note on a finished task.
On active tasks, `presentTask` masks that shortcut while work continues or an associated card’s typed `answer` hold says its author owes a reply.
A ready decision or outstanding required captain action still puts the row under waiting on you; a paused author keeps its honest status mark.
Masking changes only placement and its counts, not the card’s minimized state: clicking the Working row still restores its cards.
The raw board includes finished tasks while they have minimized cards, however old; the phone keeps its existing card list.
`presentBoard` gives a taskless minimized card one presentation-only row, titled by the card, never a saved task.
The task board and compact Tasks count use that same projection, and restoring or withdrawing the last minimized card removes that presentation override.
Click or Enter restores the task’s minimized cards, then `openTask` shows its waiting decision, deferred required action, newest showable card, or record, in that order.
Newest means `createdAt`, not revision time; off-stage and ended cards do not count.
A card already held by the window comes forward using the presented task, without a task detail lookup.
The record’s Cards tab labels an open minimized card Put aside, and its link brings the live card back.
A put-aside note keeps its task's row there until the captain presses the note's Done or Got it, which reads it (INF-2794); the minus never reads a note.
The record’s Show the card also brings back a minimized decision.
A task-less first mate question keeps that button beside explicit Decline, which presses the question's Decline (INF-3108): the first mate hears no to every choice and the question closes as answered.

## Live validation

A change's `delivery.liveValidation` retains scenario revisions, version-bound observations and digested selected proof, independent reviewer judgments, and separate captain permissions.
`TaskService.delivery.recordLiveValidation` and `decideLiveValidation` are the only writers; no prose parser grants proof or consent.
The merge card presents the live-validation result, evidence and limitations beside the merge decision; the captain need not open the task record to understand what was demonstrated.
The task-detail read keeps the shared Live validation verdict and counts with an open Scenario, Result and Evidence table and keyboard-openable retained files as supporting history under the Info tab's More row in the existing record frame.
More starts closed, so validation does not displace the record's overview and ordinary rows.
Delivery and timeline rows contain evidence metadata and compact references, never transcript bytes or a repeated copy of the complete validation state.
The detail reader loads only bounded retained text for presentation, never media bytes or repeated proof hashes.
Digest verification remains uncached at review and delivery gates.
Retained pictures and recording posters open the existing picture and demo viewer, with focus returning to their record control.
Only media named by that record's retained proof may open, and playback requires the captain's press.
The record frame never plays a recording itself: its opaque origin cannot load the media URL.
The contract and its review are owned by `docs/delivery-rigor.md`, "Careful live validation"; since INF-1876 no host gate reads the record, only the pull request's attestation (`docs/forge.md`, "No-mistakes' attestation").
A keyed `tasks` read includes `live_validation` and, for a reviewer, `validation_assignment`; compact lists include neither.
That agent-facing record carries proof identities and digests, not duplicate transcript bytes; the reviewer reads the verified files named in its assignment.

Proof for a different committed version remains readable, with its scenario result marked Another version rather than a current live pass.

## First release of merged work

The delivery evidence keeps `mergedSha` from the forge's merge receipt, distinct from the proposed branch's `headSha`.
A merged or locally landed task's `tasks` read exposes `merge_commit` when known and `first_release`, which is null until verified, not a claim that it is unreleased.
A crewmate verifying a published release declares `report.first_release`: its earliest published version, release page, included merged task keys and evidence of membership and earliest publication.
The agent verifies publication and source membership; the host stores that declaration rather than guessing from merge time, release names or version ordering.
The report parameter instructs the releasing crewmate to verify every included merged task, including changes with no release note, and report groups sharing an earliest release.
`TaskService.delivery.recordFirstRelease` records an entire same-project batch atomically with the reporting task as provenance, and refuses unknown, unmerged or other-project tasks before writing any attribution.
Later release reports preserve existing first releases; an explicit `corrects` names the previous version before replacing an attribution and keeps both declarations in the timeline.
Repeating an attribution adds no event.
Old tasks and projects with no verified release remain unknown until that verification, and no release attribution changes their closed status or merge permissions.
The crewmate's `tasks skip` pages row lists beyond the per-read limit; release verifiers collect all keys before attribution writes change the list's ordering.

## A task waiting to start

Every open work row waiting to start carries `queueWait`, derived by `src/core/tasks/queueWait.ts` from its prerequisites, parts, gate, start policy and recorded placement wait.
The desktop Tasks panel shows its dated line only in Queued, leaving Backlog compact; board list rows and native lists keep reading the wait fact.
Desktop kanban tiles and records reconcile the structured wait projection with their existing fields instead of repeating that line.
The first mate reads the same line as `waiting` in `tasks` and `gate` in crew status.
An on-request row waits for the first mate’s go; a ready row with no placement reading says it waits for a computer to start it, without claiming that a computer is busy.
Prerequisites name each task, including a dropped prerequisite that cannot clear the wait.
Source timestamps survive unrelated edits and restarts: relationships date their own waits, start-policy and gate transitions carry their own stamps, and a placement wait keeps its time while its kind stays the same.
A historical placement wait or gate with no recorded start time says so rather than guessing from the latest edit.
The line disappears when work starts, and changes no readiness or dispatch decision.

## Recorded waits

Desktop kanban tiles replace their generic status reason with grouped standing wait names and the earliest recorded event, never a finish estimate.
The Tasks list and board list rows retain their existing presentation.
The task card reconciles every structured wait into its existing header, Checks and blocker or hold explanation, without another Wait section; the hover preview keeps its short status, blocker keys and one-row fact strip (INF-2528), its status naming where a lone wait's line stops and that task's hold (INF-5578).
Checks keeps each named watch and its own next read separate from other runs’ results.
Dependencies retain their keys and recorded-since dates; missing end times stay unknown.
A lone dependency whose line goes further or ends in a hold names where it stops in the blocker explanation, as its tile does, keeping when the wait was recorded (`waitStopsOf`, INF-5578).
Only recorded events carry clock times: next read, check-back, reset or start time.
Past events say was due, not resumed; Backlog still requires Start.
Older homes without the optional projection retain the previous presentation.
