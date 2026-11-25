import { existsSync } from "node:fs";
import type { OpenChangeInput, StagedChangePresentation } from "@shared/changePresentation";
import { contributesUpstream } from "@shared/contributions";
import { contributorDisclosureLine } from "@shared/contributorDisclosure";
import { forgeOf, hasChangeRequests } from "@shared/forge";
import { overridePasses, softHoldWords } from "@shared/holds";
import {
  hostedPresentation,
  type LocalPresentationDestination,
  type PresentationDestination,
} from "@shared/presentationDestination";
import { deliveryForRecord, opensPullRequest, type RepoView } from "@shared/repos";
import { effectiveTaskPolicies } from "@shared/taskPolicies";
import {
  AttachmentUploadError,
  CONTRIBUTION_DELIVERY_WORDS,
  changeTitle,
  type Forge,
  type ForgeChange,
  ForgeError,
  ForgeWriteError,
  forkStoryForge,
  isForkReview,
  isSignInForgeFailure,
  PresentationAroundError,
  presentationLines,
} from "../forge";
import { currentChange, storyNeverSent } from "../storage/changeProjection";
import type { TaskRecord } from "../storage/taskRecords";
import { earlyPublication } from "../tasks/liveValidation";
import { git, gitFailure } from "../workspace/git";
import { requireNamed, requireNamedRange } from "../workspace/naming";
import { checkedOutRefFor } from "../workspace/workspaceService";
import type { ChangeChecks } from "./changeChecks";
import {
  type ChangeContext,
  type ChangeDeliveryOptions,
  changeWords,
  crewSignInText,
  numberLabel,
  reviewOf,
} from "./changeContext";
import type { StartingCommit } from "./changePresentations";
import type { DraftReadiness } from "./draftReadiness";
import { mergedAheadWords, mergedStory } from "./mergedStory";
import { publicationRepo } from "./publicationRepo";
import { carryPassedReview } from "./reviewCarry";

/**
 * A task's change offered where the project lives: its saved change story
 * prepared and published, and the change opened - in the task's own project
 * or another the app manages - for the checks and the merge to read.
 */
/** What open_change answers for a change that joins this person's batch instead of opening a pull request. */
export const BATCH_OPEN_WORDS = {
  confirmed: (branch: string) =>
    `Confirmed the story on the pushed branch ${branch}. This project merges approved changes together, as one batch pull request, so this change opens no pull request of its own: its story is published on its batch's pull request once the change is approved. Read its checks with check_change, which reads the checks the project runs on the pushed branch; if the project runs none there, declare that with check_change absentChecks after the local gate. Then show the merge card: the captain's click on it, or the task's autonomy, puts this version in line for the project's next batch, where it merges as one commit of its own. If the rest of your work needs this merged first, list it in the story's afterMerge and end this task with the merge card.`,
  around:
    "This change has no pull request of its own: it merges in this project's batch, so there are no words around its story to change. Pass presentation alone.",
} as const;

export class ChangePublication {
  private readonly options: ChangeDeliveryOptions;

  constructor(
    private readonly context: ChangeContext,
    private readonly checks: ChangeChecks,
    private readonly readiness: DraftReadiness,
  ) {
    this.options = context.options;
  }

  /**
   * The crewmate's prepare_change: the change story saved for the change on
   * the branch the working copy has checked out, for open_change to publish
   * and the completion card to show. Nothing is uploaded and no card shown.
   */
  async preparePresentation(taskId: string, staged: StagedChangePresentation): Promise<string> {
    return (await this.prepareStory(taskId, staged)).said;
  }

  /**
   * prepare_change's work, typed for show_merge_card: the revision saved, or
   * only the words when nothing was saved. `reuseSame` answers the newest
   * revision for the same words at the same version instead of adding one.
   */
  async prepareStory(
    taskId: string,
    staged: StagedChangePresentation,
    how: { reuseSame?: boolean } = {},
  ): Promise<{ revision?: number; said: string }> {
    const said = (text: string) => ({ said: text });
    try {
      const fork = this.options.tasks.get(taskId)?.delivery?.checkTarget;
      if (!fork || !isForkReview(fork)) {
        const contribution = await this.options.prepareContribution?.(taskId);
        if (contribution) return said(contribution);
      }
      const local = this.localStoryDestination(taskId);
      if (local) {
        if (!this.options.presentations) return said("Saved change stories are unavailable.");
        const revision = await this.options.presentations.prepare(taskId, staged, local, how);
        return {
          revision,
          said: `Prepared presentation ${revision} for ${staged.head}. Nothing was uploaded and no card was shown. This work merges locally: pass presentation: ${revision} to emit_card; no open_change or host sign-in is needed.`,
        };
      }
      // A story is prepared for the task's own project; a change opened in
      // another managed project carries its body instead (INF-2510).
      const located = this.context.locate(
        taskId,
        "open",
        fork && isForkReview(fork) ? "current" : "own",
      );
      if ("said" in located) return said(located.said);
      if (!this.options.presentations) return said("Saved change stories are unavailable.");
      try {
        // The story is for the change on the branch the working copy has
        // checked out; each change keeps its own (INF-2490).
        const current = currentChange(located.record.delivery, located.branch);
        const branch = (await this.presentationBranch(taskId)) ?? current.branch;
        const ledger = this.options.tasks.delivery.changePresentation(taskId, branch);
        // Only a pull request still open for the branch predates saved stories;
        // a recorded one that has closed is forgotten, as for any new task.
        if (
          !ledger &&
          !(fork && isForkReview(fork)) &&
          hasChangeRequests(located.forge.kind) &&
          (await located.forge.changeFor(branch))
        )
          return said(
            "This pull request predates saved stories and will not be rewritten into one. To replace its description, pass body to open_change.",
          );
        const merged =
          branch === located.record.branch
            ? await this.mergedBeforeStories(
                ledger,
                this.context.savedOwnNumber(located),
                located.forge,
              )
            : undefined;
        if (merged) return said(merged);
        const repo = located.repo;
        const origin = repo ? publicationRepo(located.record, repo).origin : null;
        const revision = await this.options.presentations.prepare(taskId, staged, located.forge, {
          ...how,
          ...(repo && origin
            ? {
                approvedAddress: {
                  origin,
                  current: () => this.context.approvedOrigin(taskId) === origin,
                  recover:
                    !repo.contribution &&
                    !located.record.delivery?.publicationOrigin &&
                    !(fork && isForkReview(fork)),
                },
              }
            : {}),
        });
        const destination = this.options.tasks.delivery
          .changePresentation(taskId, branch)
          ?.revisions.find((saved) => saved.revision === revision)?.destination;
        return {
          revision,
          said: `Prepared presentation ${revision} for ${staged.head}. ${destination ? `${storyAudience(destination)} ` : ""}No file was uploaded and no card was shown. Pass presentation: ${revision} to open_change after review and pushing; pass the same current published revision to emit_card after checks pass.`,
        };
      } catch (caught) {
        if (isSignInForgeFailure(caught))
          return said(
            crewSignInText(this.context.signInFact(located.forge, located.record.repoId)),
          );
        return said(
          `Could not prepare the change story: ${caught instanceof Error ? caught.message : String(caught)}`,
        );
      }
    } catch (caught) {
      return said(
        `Could not prepare the change story: ${caught instanceof Error ? caught.message : String(caught)}`,
      );
    } finally {
      await this.options.presentations?.discardStaged(taskId, staged);
    }
  }

  /**
   * The pull request a task recorded before saved stories, merged outside the
   * app: nothing more is opened for it, as for a merged published story. One
   * closed without merging is forgotten and the task starts a story.
   */
  private async mergedBeforeStories(
    story: { published?: unknown; reconciled?: unknown } | undefined,
    number: number | undefined,
    forge: Forge,
  ): Promise<string | undefined> {
    // Once a story is published or reconciled, #N is the story's own pull
    // request and its own stops decide. A failed read reaches the caller's
    // catch, so the check fails closed.
    if (story?.published || story?.reconciled) return undefined;
    if (number === undefined) return undefined;
    const pull = await this.context.pullOf(forge, number);
    return pull.merged
      ? `${numberLabel(forge, pull.number)} was merged outside the app. Nothing more is opened for it; close this task or start a new one.`
      : undefined;
  }

  async presentationHead(taskId: string): Promise<string> {
    const record = this.options.tasks.get(taskId);
    if (!record?.branch) throw new Error("The task has no committed branch.");
    let dir = record.worktreeDir;
    if (record.deviceId) {
      // A working copy there reads its own checkout (INF-2490): another
      // branch the crewmate checked out answers its commit there.
      const there = await this.options.checkedOut?.(taskId);
      if (there && there.branch !== record.branch) return there.head;
      dir = (await this.options.bringBranchHome?.(taskId, true)) ?? "";
    } else if (dir && (await git(dir, ["status", "--porcelain", "--untracked-files=no"])).trim()) {
      throw new Error(
        "Commit the task's changes before preparing or publishing its demonstrated version.",
      );
    }
    if (!dir) throw new Error("The current code version is unavailable.");
    // Here the demonstrated version is the commit the working copy has
    // checked out: the task's own branch, or an existing branch or another
    // change the crewmate checked out to deliver (INF-2184, INF-2490).
    return git(dir, ["rev-parse", `${record.deviceId ? record.branch : "HEAD"}^{commit}`]);
  }

  /**
   * Whether a story's starting commit is a commit in the project that `head`
   * descends from, read in the project's own folder: a working copy here
   * shares its commits, and a branch from another computer arrives there
   * (`presentationHead`). Where `head` is not there, nothing is judged.
   */
  async startingCommit(taskId: string, base: string, head: string): Promise<StartingCommit> {
    const record = this.options.tasks.get(taskId);
    if (!record) return "unread";
    let dir: string;
    try {
      dir = this.context.projectDir(record.repoId, record.repoDir);
    } catch {
      return "unread";
    }
    const commit = (sha: string) =>
      git(dir, ["cat-file", "-e", `${sha}^{commit}`]).then(
        () => true,
        () => false,
      );
    if (!(await commit(head))) return "unread";
    if (!(await commit(base))) return "missing";
    return git(dir, ["merge-base", "--is-ancestor", base, head]).then(
      () => "descends" as const,
      () => "unrelated" as const,
    );
  }

  /**
   * With "current" (the default), a selected contributor review supplies its
   * branch. "own" ignores that review, as a named-project publication needs.
   * Otherwise the branch the working copy has checked out, whose change a
   * story is prepared for (INF-2184, INF-2490): the task's own, or an existing
   * branch the crewmate checked out to deliver, on this Mac or on the
   * computer that runs the task. Undefined - the current change - with no
   * branch checked out. A computer that cannot say delivers the task's own.
   */
  async presentationBranch(
    taskId: string,
    target: "current" | "own" = "current",
  ): Promise<string | undefined> {
    const record = this.options.tasks.get(taskId);
    const selected = record?.delivery?.checkTarget;
    if (target === "current" && selected && isForkReview(selected)) return selected.branch;
    if (record?.deviceId) {
      const there = await this.options.checkedOut?.(taskId);
      return there ? (there.branch ?? undefined) : record.branch;
    }
    if (!record?.worktreeDir) return undefined;
    const branch = (
      await git(record.worktreeDir, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")
    ).trim();
    return branch && branch !== "HEAD" ? branch : undefined;
  }

  /** Delivery, not the presence of an origin, decides whether a story reaches a host. */
  localStoryDestination(taskId: string): LocalPresentationDestination | undefined {
    const record = this.options.tasks.get(taskId);
    if (!record) throw new Error("The task no longer exists.");
    const repo = record.repoId ? this.options.repos.get(record.repoId) : undefined;
    if (record.repoId && !repo) throw new Error("The task's project is no longer registered.");
    if (deliveryForRecord(record, repo?.delivery) !== "local-only") return undefined;
    return { kind: "local", project: record.repoId ?? record.repoDir };
  }

  async validateLocalStory(taskId: string): Promise<string> {
    const destination = this.localStoryDestination(taskId);
    if (!destination || !this.options.presentations)
      throw new Error("The local story cannot be checked.");
    const head = await this.presentationHead(taskId);
    if (overridePasses(this.options.tasks.get(taskId)?.delivery, "story", head)) return head;
    return this.options.presentations.assertLocal(taskId, destination);
  }

  async completionPresentation(taskId: string, revision: number) {
    if (this.localStoryDestination(taskId)) {
      if (!this.options.presentations) throw new Error("Saved change stories are unavailable.");
      const head = await this.validateLocalStory(taskId);
      return {
        ...(await this.options.presentations.completion(taskId, revision, head)),
        revision,
      };
    }
    const located = this.context.locate(taskId);
    if ("said" in located) throw new Error(located.said);
    if (!this.options.presentations) throw new Error("Saved change stories are unavailable.");
    const target = located.record.delivery?.checkTarget;
    const fork = target && isForkReview(target) ? target : undefined;
    const forge = fork
      ? forkStoryForge(located.forge, fork, taskId, contributorDisclosureLine(located.repo))
      : located.forge;
    // Own changes follow the checked-out branch; a fork review stays bound to its numbered request.
    const selected = currentChange(located.record.delivery, located.branch);
    const checkedOut = await this.presentationBranch(taskId).catch(() => undefined);
    const branch = fork?.branch ?? checkedOut ?? selected.branch;
    // A change that joins a batch of this person's own has no pull request:
    // its story is confirmed on its pushed branch (docs/forge.md, "Batches of your own").
    const change =
      (await forge.changeFor(branch)) ??
      (!fork && branch === located.record.branch && this.context.ownBatch(taskId)
        ? await this.context.pushedBranch(located.forge, branch, located.record.delivery)
        : null);
    if (!change) {
      if (fork) throw new Error("The story's pull request is not open.");
      // The story's pull request merged outside the app (INF-3799): its
      // merge card shows the story it merged with, and closes the task.
      const merged = await mergedStory(this.options.tasks, taskId, forge, branch);
      if (merged && "refused" in merged) throw new Error(merged.refused);
      if (merged) {
        if (revision !== merged.revision && revision !== merged.refreshOf)
          throw new Error(
            `${numberLabel(forge, merged.pull.number)} was merged outside the app with story revision ${merged.revision}: show its merge card with presentation ${merged.revision}.`,
          );
        const completion = await this.options.presentations.completion(
          taskId,
          merged.revision,
          merged.pull.headSha,
          branch,
          merged.pull.number,
          (committed) => mergedAheadWords(forge, merged.pull, committed),
        );
        return { ...completion, revision: merged.revision };
      }
      const elsewhere = this.currentStoryWords(taskId, checkedOut);
      throw new Error(
        `The story's pull request is not open: no open pull request was found for ${branch}${checkedOut ? ", the branch the working copy has checked out" : ""}. ${elsewhere ?? "Publish its story with open_change, which opens one."}`,
      );
    }
    // INF-2509: a pull request that moved past its published story shows it
    // republished at the pushed version, with the same words.
    const shown = await this.options.presentations.atPushedVersion(
      taskId,
      revision,
      change,
      forge,
      this.context.attestsAt(taskId),
    );
    const current =
      shown === revision
        ? change
        : await forge.changeFor(change.branch).then((read) => {
            if (!read || read.number !== change.number || read.headSha !== change.headSha)
              throw new Error("The pull request changed while its story was republished.");
            return read;
          });
    await this.options.presentations.assertPublished(taskId, current, forge, shown);
    const completion = await this.options.presentations.completion(
      taskId,
      shown,
      current.headSha,
      current.branch,
      current.number,
    );
    // The merge card merges the task's current change: the change whose
    // story it shows becomes current, as open_change makes it (INF-3717).
    if (!fork && branch !== selected.branch) {
      if (branch === located.record.branch)
        this.options.tasks.delivery.selectOwnChange(taskId, {
          ...(current.number !== undefined ? { number: current.number } : {}),
          headSha: current.headSha,
          ...(current.base ? { base: current.base } : {}),
        });
      else await this.selectOpened(located.record, forge, current, undefined);
      this.checks.noteChange(taskId, { change: current, forge });
    }
    return { ...completion, revision: shown };
  }

  /**
   * The crewmate's open_change (git integration PR 1.2): offer the task's
   * branch as a proposed change where the project lives - a pull request
   * on GitHub (the crewmate has pushed the branch), the branch sent up on a
   * plain host (the forge pushes it). A change already open for the branch
   * is answered, not opened twice, and a body replaces its description when
   * that is not a saved story (`redescribe`). Recorded like a reading's change:
   * `pr_opened` on the timeline, the label and link on the delivery facts.
   */
  async open(taskId: string, input: OpenChangeInput): Promise<string> {
    const selected = this.options.tasks.get(taskId)?.delivery?.checkTarget;
    if (
      selected &&
      isForkReview(selected) &&
      input.repository === undefined &&
      (input.branch === undefined || input.branch === selected.branch)
    ) {
      const located = this.context.locate(taskId, "open");
      if ("said" in located) return located.said;
      try {
        if (
          !this.options.presentations ||
          input.presentation === undefined ||
          input.body !== undefined
        )
          return "Prepare the contributor review story with prepare_change, then pass presentation to open_change. The contributor's description stays unchanged.";
        if (input.base !== undefined && input.base !== selected.base)
          return "The reviewed contributor change keeps its destination branch.";
        const forge = forkStoryForge(
          located.forge,
          selected,
          taskId,
          contributorDisclosureLine(located.repo),
        );
        const change = await this.options.presentations.publish(
          taskId,
          input.presentation,
          forge,
          selected.branch,
          input.title,
          "passed",
          input.recovery,
          input.around,
        );
        await this.checks.run(taskId, "crewmate");
        return `Published the crew's story in a comment on ${numberLabel(forge, selected.number)}. The contributor's description is unchanged. ${change.url ?? ""}`;
      } catch (caught) {
        if (isSignInForgeFailure(caught))
          return crewSignInText(this.context.signInFact(located.forge, located.record.repoId));
        return `Could not publish the contributor review story: ${caught instanceof Error ? caught.message : String(caught)}`;
      }
    }
    const contribution = await this.options.prepareContribution?.(taskId);
    if (contribution) return contribution;
    const located = this.context.locate(taskId, "open", "own");
    if ("said" in located) return located.said;
    const { record, forge } = located;
    if (input.repository !== undefined) {
      const named = this.projectNamed(record, input.repository);
      if ("said" in named) return named.said;
      if (!named.own) return this.openElsewhere(record, named.repo, input);
    }
    // INF-2184: an existing branch the crewmate names opens as it is, at
    // its own head. Named none, it is the branch the working copy has
    // checked out, whose change prepare_change saved the story for and the
    // merge card shows (INF-3717 piece 1); the task's own with none.
    const branch =
      input.branch?.trim() ||
      ((await this.presentationBranch(taskId, "own").catch(() => undefined)) ?? located.branch);
    const own = branch === record.branch;
    try {
      requireNamed(input.title, "pull request title", this.options.namingRule?.() ?? null);
      if (own) await this.context.branchHome(record);
      // Where this Mac's git reads the branch: by its name, or another
      // branch from the computer that runs the task at the task's own ref
      // for it (INF-2490).
      const read = own || !record.deviceId ? branch : await this.otherBranchHome(record, branch);
      const batched = own && !input.base ? this.context.ownBatch(taskId) : undefined;
      const dir = this.context.projectDir(record.repoId, record.repoDir);
      const existing = await forge.changeFor(branch);
      if (existing && hasChangeRequests(forge.kind))
        requireNamed(
          changeTitle(forge.kind, existing) ?? "",
          "existing pull request title",
          this.options.namingRule?.() ?? null,
        );
      const current = this.options.tasks.get(taskId);
      const policy =
        current &&
        effectiveTaskPolicies(
          current,
          current.repoId ? this.options.repos.get(current.repoId) : undefined,
        );
      if (!current || !policy || !opensPullRequest(policy.delivery.value))
        return "Cannot open the change: its delivery policy changed. Read the current task record.";
      let prerequisite: string | undefined;
      let validationHead: string | undefined;
      if (
        !existing &&
        current.delivery?.liveValidation?.permissions.some(
          (item) =>
            item.request.kind === "effect" &&
            item.request.prerequisitePublication &&
            item.request.publication?.repoId === current.repoId &&
            item.request.publication.branch === branch &&
            (item.state === "started" || item.state === "unknown"),
        )
      )
        return "The earlier prerequisite publication has an unknown outcome. Reconcile it before another publication; a missing result does not prove it failed.";
      // A task with a review or a live-validation record carries it to the
      // version being opened, at any care: the care's name holds nothing
      // here, and a task with neither record has nothing to read. The
      // version is read where the range was checked: the project's folder,
      // where a branch from another computer came home.
      if (current.delivery?.reviewVerdict || current.delivery?.liveValidation) {
        const head = existing?.headSha ?? (await git(dir, ["rev-parse", read]));
        await carryPassedReview({
          tasks: this.options.tasks,
          taskId,
          record: current,
          repoDir: dir,
          head,
        });
        validationHead = head;
        this.options.tasks.delivery.recordChangeEvidence(taskId, { validationHead: head });
        const early =
          earlyPublication(current.delivery?.liveValidation, head, Boolean(existing)) ??
          (existing
            ? current.delivery?.liveValidation?.permissions.find(
                (item) =>
                  item.request.kind === "effect" &&
                  item.request.prerequisitePublication &&
                  item.request.head === head &&
                  item.request.publication?.repoId === current.repoId &&
                  item.request.publication.branch === branch &&
                  ["started", "unknown", "succeeded"].includes(item.state),
              )
            : undefined);
        if (
          early?.request.kind === "effect" &&
          early.request.publication?.repoId === current.repoId &&
          early.request.publication.branch === branch
        )
          prerequisite = early.request.id;
      }
      // INF-3995: a story prepared for the branch the working copy has
      // checked out goes with an existing branch named at its very version.
      let carried = "";
      if (
        input.branch?.trim() &&
        input.presentation !== undefined &&
        input.body === undefined &&
        this.options.presentations &&
        !(selected && isForkReview(selected))
      ) {
        const carry = await this.carryStory(
          taskId,
          branch,
          input.presentation,
          existing,
          forge,
          () => git(dir, ["rev-parse", read]),
        );
        if ("said" in carry) return carry.said;
        carried = carry.words;
      }
      const presentations = this.options.presentations;
      // The story of the change on this branch: each change keeps its own (INF-2490).
      const ledger = this.options.tasks.delivery.changePresentation(taskId, branch);
      if (own && !existing && presentations && hasChangeRequests(forge.kind)) {
        // The slot names the own pull request only while no other change is
        // selected; the selection moves only once this call succeeds.
        const merged = await this.mergedBeforeStories(
          ledger,
          this.context.savedOwnNumber(located),
          forge,
        );
        if (merged) return merged;
      }
      // The captain's override on the saved story lets this task open its
      // pull request with a body; the default stays as he chose.
      const storyPassed =
        input.presentation === undefined &&
        current.delivery?.override?.holds.includes("story") === true &&
        overridePasses(
          current.delivery,
          "story",
          existing?.headSha ?? (await git(dir, ["rev-parse", read])),
        );
      const usesStory =
        presentations &&
        (forge.storyDestination || forge.attachments) &&
        (!hasChangeRequests(forge.kind) || !existing || ledger) &&
        !storyPassed;
      if (usesStory && (input.presentation === undefined || input.body !== undefined))
        return `Prepare the current change story with prepare_change, then pass its presentation revision, not body. Native media hosts confirm every selected attachment before publication; other description hosts receive text only. A plain branch keeps its story on the merge card. To change only the words around a published story, pass around. ${softHoldWords("story", "crewmate")}`;
      if (!usesStory && input.presentation !== undefined)
        return "This host or existing pull request does not use saved change stories. Keep its existing delivery.";
      if (!usesStory && input.around !== undefined)
        return "This pull request does not carry a saved story, so around has nothing to keep; pass body to replace its description.";
      if (
        input.around &&
        presentationLines(input.around.from) === presentationLines(input.around.to)
      )
        return "Nothing was sent: around.to is the same as around.from.";
      if (!usesStory && !existing && input.body === undefined)
        return "The pull request description is missing.";
      const beginPublication = (head: string) => {
        if (!validationHead || (prerequisite && existing)) return;
        const latest = this.options.tasks.get(taskId);
        if (
          head !== validationHead ||
          latest?.repoId !== current.repoId ||
          latest.branch !== record.branch
        )
          throw new Error(
            "The publication changed; nothing was sent. Read its current version and permission.",
          );
        if (!prerequisite) return;
        // The transition rechecks the current approval, code clearance and
        // scenario. For saved stories this runs after their preflight, before
        // any attachment leaves the computer, not before a possibly long read.
        this.options.tasks.delivery.recordLiveValidation(
          taskId,
          {
            kind: "effect-state",
            request: prerequisite,
            state: "started",
            evidence: "The approved prerequisite draft publication passed its execution gate.",
          },
          { head },
        );
        this.options.tasks.delivery.recordLiveValidation(
          taskId,
          {
            kind: "effect-state",
            request: prerequisite,
            state: "unknown",
            evidence:
              "The approved prerequisite publication is being sent; read the host before any repeat.",
          },
          { head },
        );
      };
      // A project that gets batches of its own opens no pull request for a
      // change: its story is confirmed on the pushed branch and published on
      // its batch's pull request (docs/forge.md, "Batches of your own"). A
      // change that already has a pull request, targets another branch or
      // publishes a draft for its validation keeps its own.
      const batchRoute = batched && !existing && usesStory && !prerequisite;
      // The commit names are checked once the route is chosen, from the base that route carries:
      // a held batch's fix from its held version only where its batch carries it as its own
      // difference; any other route opens a pull request that merges the branch whole.
      await this.context.validateRange(
        record,
        branch,
        forge,
        read,
        batchRoute ? taskId : undefined,
      );
      if (batchRoute) {
        if (input.around) return BATCH_OPEN_WORDS.around;
        const confirmed = await presentations.confirmBranch(
          taskId,
          input.presentation as number,
          forge,
          branch,
          input.title,
          validationHead ? { beforePublish: beginPublication } : undefined,
        );
        this.checks.noteChange(record.id, { change: confirmed, forge });
        // A story revised under a kept approval: the change keeps its
        // place in line or in its batch, which takes the story's words.
        await this.context.batches?.revise(batched.id, {
          taskId,
          head: confirmed.headSha,
          ...presentations.batchCommit(taskId, branch, confirmed.headSha),
        });
        return BATCH_OPEN_WORDS.confirmed(branch);
      }
      let change: ForgeChange;
      let described = "";
      if (usesStory) {
        change = await presentations.publish(
          taskId,
          input.presentation as number,
          forge,
          branch,
          input.title,
          current.delivery?.ci === "green" && current.delivery.headSha === existing?.headSha
            ? "passed"
            : "pending",
          input.recovery,
          input.around,
          {
            ...(validationHead
              ? {
                  beforePublish: beginPublication,
                  attests: this.context.attestsAt(taskId),
                  ...(prerequisite && !existing ? { draft: hasChangeRequests(forge.kind) } : {}),
                }
              : {}),
            ...(input.base ? { base: input.base } : {}),
            ...(located.repo ? { branchOrigin: () => this.context.approvedOrigin(taskId) } : {}),
            ...(read === branch ? {} : { source: read }),
          },
        );
        const place = forge.place ?? "the project's host";
        // INF-717: a renamed change says its new title, the story's.
        const renamed =
          existing && changeTitle(forge.kind, change) !== changeTitle(forge.kind, existing);
        described = [
          carried,
          input.around
            ? `Changed the words around the story: ${place} shows them, and the story is as published.`
            : "",
          renamed ? `Its title now reads "${changeTitle(forge.kind, change)}", the story's.` : "",
        ]
          .filter(Boolean)
          .join(" ");
      } else if (existing) {
        ({ change, said: described } = await this.redescribe(forge, branch, existing, input));
      } else {
        beginPublication(validationHead ?? "");
        change = await forge.openChange({
          branch,
          title: input.title,
          body: input.body ?? "",
          ...(input.base ? { base: input.base } : {}),
          ...(read === branch ? {} : { source: read }),
          ...(prerequisite && hasChangeRequests(forge.kind) ? { draft: true } : {}),
        });
        if (!hasChangeRequests(forge.kind)) described = keepsNoDescription(forge);
      }
      if (
        prerequisite &&
        ["started", "unknown"].includes(
          this.options.tasks
            .get(taskId)
            ?.delivery?.liveValidation?.permissions.find((item) => item.request.id === prerequisite)
            ?.state ?? "",
        )
      )
        this.options.tasks.delivery.recordLiveValidation(
          taskId,
          {
            kind: "effect-state",
            request: prerequisite,
            state: "succeeded",
            evidence: `The host confirmed ${changeWords(forge, change)}.`,
          },
          { head: validationHead ?? "" },
        );
      change = await this.readiness.readyPrerequisite(record.id, forge, change);
      // The change it opened or answered becomes current only once it is
      // there: a refused call leaves the current change as it was (INF-3717).
      if (own && this.options.tasks.get(taskId)?.delivery?.checkTarget)
        this.options.tasks.delivery.selectOwnChange(taskId, {
          ...change,
          url: forge.url(change) ?? null,
        });
      else if (!own) await this.selectOpened(record, forge, change, input.base);
      this.checks.noteChange(record.id, { change, forge });
      const next = [
        contributesUpstream(current.delivery?.contribution)
          ? CONTRIBUTION_DELIVERY_WORDS
          : "Read its checks with check_change. If the rest of your work needs this merged first, list it in the story's afterMerge and end this task with the merge card after the checks pass.",
        this.readiness.readinessProblem(taskId, change),
      ]
        .filter(Boolean)
        .join(" ");
      const said = described ? ` ${described}` : "";
      return existing
        ? `A pull request for ${branch} is already open: ${changeWords(forge, change)}.${said} ${next}`
        : `Opened ${changeWords(forge, change)} for ${branch}.${said} ${next}`;
    } catch (caught) {
      return this.openFailure(record, forge, located.repo, caught);
    }
  }

  /**
   * open_change naming an existing branch that keeps no story of its own
   * (INF-3995): the story prepare_change saved for the branch the working
   * copy has checked out - the current change's with none - goes with it
   * when the crewmate names that story's newest revision, nothing of it was
   * sent anywhere, and it was prepared at the very commit the named branch
   * is at where the project lives. Otherwise the answer names the fact that
   * does not hold. A pull request open before saved stories keeps its own
   * delivery.
   */
  private async carryStory(
    taskId: string,
    branch: string,
    revision: number,
    existing: ForgeChange | null,
    forge: Forge,
    readHere: () => Promise<string>,
  ): Promise<{ words: string } | { said: string }> {
    const tasks = this.options.tasks;
    const record = tasks.get(taskId);
    if (!record || tasks.delivery.changePresentation(taskId, branch)) return { words: "" };
    if (existing && hasChangeRequests(forge.kind)) return { words: "" };
    const checkedOut = await this.presentationBranch(taskId).catch(() => undefined);
    const from = checkedOut ?? currentChange(record.delivery, record.branch).branch;
    if (from === branch) return { words: "" };
    const where = `${from}, ${checkedOut ? "the branch the working copy has checked out" : "the task's current change"}`;
    const ledger = tasks.delivery.changePresentation(taskId, from);
    const story = ledger?.revisions.at(-1);
    if (!ledger || !story)
      return {
        said: `${branch} has no prepared story, and neither has ${where}. ${checkOutWords(branch)} and prepare its story there with prepare_change.`,
      };
    if (story.revision !== revision)
      return {
        said: `Use the newest prepared story revision: the newest for ${where}, is revision ${story.revision}, not ${revision}.`,
      };
    if (!storyNeverSent(ledger))
      return {
        said: `${where}, keeps a story already sent where the project lives, so the story stays with that change. ${checkOutWords(branch)} and prepare its own story there with prepare_change.`,
      };
    // Where the project lives when its host can say, else as this Mac reads it.
    const at =
      existing?.headSha ??
      (forge.branchHead ? await forge.branchHead(branch).catch(() => undefined) : undefined) ??
      (await readHere().catch(() => undefined));
    if (at !== story.head)
      return {
        said: `Story revision ${revision} was prepared for ${where}, at ${story.head}, and ${branch} is ${at ? `at ${at}` : "not pushed where the project lives"}. A story goes with a named branch only at the version it was prepared for: ${lowerFirst(checkOutWords(branch))} and prepare its story there with prepare_change.`,
      };
    tasks.delivery.carryChangePresentation(taskId, from, branch);
    return {
      words: `Story revision ${revision}, prepared for ${from} at this version, now belongs to ${branch}.${checkedOut ? ` Its merge card follows the branch the working copy has checked out: ${lowerFirst(checkOutWords(branch))} before showing it.` : ""}`,
    };
  }

  /**
   * The words that say how to show the current change's merge card while
   * the working copy has another branch checked out (INF-3995): undefined
   * unless the current change is another branch of this project that keeps
   * a story.
   */
  currentStoryWords(taskId: string, checkedOut: string | undefined): string | undefined {
    const target = this.options.tasks.get(taskId)?.delivery?.checkTarget;
    if (
      !checkedOut ||
      !target ||
      isForkReview(target) ||
      target.repoId ||
      target.branch === checkedOut
    )
      return undefined;
    const story = this.options.tasks.delivery
      .changePresentation(taskId, target.branch)
      ?.revisions.at(-1);
    if (!story) return undefined;
    return `${target.branch}, the task's current change, keeps story revision ${story.revision}; its merge card follows the branch the working copy has checked out. ${checkOutWords(target.branch)}, then show its merge card.`;
  }

  /**
   * open_change in another project the app manages (INF-2510): the crewmate
   * pushed a branch to where that project lives. The host reads the branch
   * into that project's folder, checks its commit names there, and opens the
   * change with the crewmate's description through that project's host. The
   * change becomes the task's current one, so check_change and the merge
   * read and act on it there. It carries no saved story: prepare_change
   * prepares the task's own project's.
   */
  private async openElsewhere(
    record: TaskRecord,
    repo: RepoView,
    input: OpenChangeInput,
  ): Promise<string> {
    const forge = this.options.forgeFor(repo, repo.path);
    if (!hasChangeRequests(forge.kind))
      return `Cannot open the change in ${repo.name}: ${forge.place ?? "where it lives"} has no pull requests, so the app opens no change there for another project's task.`;
    const branch = input.branch?.trim();
    if (!branch)
      return `Name the branch you pushed to ${repo.name} with branch: a change in another project opens from its own pushed branch.`;
    if (branch === record.branch)
      return `Cannot open the change in ${repo.name} from ${branch}: that name is this task's own branch. Push the work there under another branch name, then name it with branch.`;
    if (
      input.presentation !== undefined ||
      input.around !== undefined ||
      input.recovery !== undefined
    )
      return "A change in another project carries no saved story: pass body as its description, without presentation, around or recovery.";
    if (!existsSync(repo.path)) return `${repo.name}'s folder is gone; cannot open a change there.`;
    try {
      requireNamed(input.title, "pull request title", this.options.namingRule?.() ?? null);
      await this.validateElsewhere(record.id, repo.path, branch, forge);
      const existing = await forge.changeFor(branch);
      let change: ForgeChange;
      let described = "";
      if (existing) {
        requireNamed(
          changeTitle(forge.kind, existing) ?? "",
          "existing pull request title",
          this.options.namingRule?.() ?? null,
        );
        ({ change, said: described } = await this.redescribe(forge, branch, existing, input));
      } else {
        if (input.body === undefined) return "The pull request description is missing.";
        change = await forge.openChange({
          branch,
          title: input.title,
          body: input.body,
          ...(input.base ? { base: input.base } : {}),
        });
      }
      await this.selectOpened(record, forge, change, input.base, repo);
      this.checks.noteChange(record.id, { change, forge });
      const next =
        "Read its checks with check_change; they are read there, and the merge goes there. Show its outcome on the merge card after they pass.";
      const said = described ? ` ${described}` : "";
      return existing
        ? `A pull request for ${branch} in ${repo.name} is already open: ${changeWords(forge, change)}.${said} ${next}`
        : `Opened ${changeWords(forge, change)} in ${repo.name} for ${branch}.${said} ${next}`;
    } catch (caught) {
      return this.openFailure(record, forge, repo, caught);
    }
  }

  /**
   * Reads a branch pushed to another managed project into that project's
   * folder, beside its default branch, then checks the branch's own commit
   * names there (INF-2510). Its private ref leaves the person's branches as
   * they were.
   */
  private async validateElsewhere(
    taskId: string,
    dir: string,
    branch: string,
    forge: Forge,
  ): Promise<void> {
    if (this.options.validateRange) {
      await this.options.validateRange(dir, branch, forge, branch);
      return;
    }
    const name = await forge.defaultBranch();
    const head = `refs/infinitary/opened/${taskId}`;
    try {
      await git(
        dir,
        [
          "fetch",
          "--quiet",
          "--no-tags",
          "origin",
          `+refs/heads/${name}:refs/remotes/origin/${name}`,
          `+refs/heads/${branch}:${head}`,
        ],
        { env: { GIT_TERMINAL_PROMPT: "0" } },
      );
    } catch (caught) {
      throw new ForgeError(
        "refused",
        `could not read ${branch} there (${gitFailure(caught)})`,
        true,
      );
    }
    const base = await git(dir, ["merge-base", head, `refs/remotes/origin/${name}`]);
    await requireNamedRange(dir, base, head, this.options.namingRule?.() ?? null);
  }

  /** What open_change says when the host or the checks refused the change, in either project. */
  private openFailure(
    record: TaskRecord,
    forge: Forge,
    repo: RepoView | undefined,
    caught: unknown,
  ): string {
    const message = caught instanceof Error ? caught.message : String(caught);
    if (isSignInForgeFailure(caught)) {
      return crewSignInText(this.context.signInFact(forge, repo?.id ?? record.repoId));
    }
    // An evidence upload says what stopped it; the branch is already pushed (INF-290 F4).
    // A permission refusal keeps the write-access note and blocker words below (INF-290 G1).
    if (caught instanceof AttachmentUploadError && caught.failure !== "permission") return message;
    // INF-497: nothing was sent, or what the host shows; the words carry the current text.
    if (caught instanceof PresentationAroundError) return message;
    const place = forge.place ?? "the project's host";
    if (caught instanceof ForgeError && caught.failure === "permission") {
      this.options.onNote?.(
        `${place} did not allow the change on ${repo?.name ?? record.title} - ask its owner for write access.`,
        record.id,
      );
      return `${place} did not allow opening the change: ${message}. Report this as a blocker: the captain needs write access to the project there.`;
    }
    if (caught instanceof ForgeError && caught.failure === "refused") {
      return `${place} refused to open the change: ${message}. Push your branch first (git push) if you have not, then call open_change again.`;
    }
    return `Could not open the pull request: ${message}`;
  }

  /**
   * An open change whose description is the crewmate's own words, not a
   * saved story (INF-291): a body replaces it whole through the forge's
   * conditional write, and the answer says what the host shows when read
   * back, never only that the change exists. A refused or uncertain write,
   * or a read-back that differs, is said as such; nothing is sent again.
   */
  private async redescribe(
    forge: Forge,
    branch: string,
    existing: ForgeChange,
    input: OpenChangeInput,
  ): Promise<{ change: ForgeChange; said: string }> {
    const { body } = input;
    // A title is never renamed here; say so rather than drop it quietly.
    const titled =
      existing.title !== undefined && existing.title !== input.title
        ? ` Its title stays "${existing.title}".`
        : "";
    const place = forge.place ?? "the project's host";
    const readBack = "Read it with github_read before calling open_change again.";
    if (!hasChangeRequests(forge.kind))
      return { change: existing, said: body === undefined ? "" : keepsNoDescription(forge) };
    if (body === undefined)
      return {
        change: existing,
        said: `Its description is unchanged; pass body to replace it.${titled}`,
      };
    if (sameDescription(existing.body, body))
      return {
        change: existing,
        said: `${place} already shows this description; nothing was sent.${titled}`,
      };
    if (!forge.updateChangeBody)
      return {
        change: existing,
        said: `Its description was not replaced: ${place} offers no way to replace it here.`,
      };
    try {
      await forge.updateChangeBody(existing, body);
    } catch (caught) {
      // A missing sign-in or write access keeps the blocker words open_change already gives.
      const denied =
        isSignInForgeFailure(caught) ||
        (caught instanceof ForgeError && caught.failure === "permission");
      if (!(caught instanceof ForgeWriteError) || denied) throw caught;
      return {
        change: existing,
        said:
          caught.outcome === "failed"
            ? `Its description was not replaced: ${caught.message}`
            : `Its description may or may not have been replaced: ${caught.message} ${readBack}`,
      };
    }
    let read: ForgeChange | null;
    try {
      read = await forge.changeFor(branch);
    } catch (caught) {
      if (isSignInForgeFailure(caught)) throw caught;
      const why = caught instanceof Error ? caught.message : String(caught);
      return {
        change: existing,
        said: `Sent the new description, but could not read it back: ${why}. ${readBack}`,
      };
    }
    if (read && read.number === existing.number && sameDescription(read.body, body))
      return {
        change: read,
        said: `Replaced its description: ${place} now shows the ${body.length}-character body you passed, at version ${read.headSha.slice(0, 7)}.${titled}`,
      };
    return {
      change: read ?? existing,
      said: `Sent the new description, but ${place} shows different words; someone may have edited it at the same time. ${readBack}`,
    };
  }

  /**
   * open_change names the project the change opens on (INF-1873): the
   * task's own or any other project the app manages (INF-2510), by its
   * name, id, owner/name or origin where it lives. A name the app does not
   * manage is refused in words that list the ones it does.
   */
  private projectNamed(
    record: TaskRecord,
    repository: string,
  ): { repo: RepoView; own: boolean } | { said: string } {
    const asked = repository.trim().toLowerCase();
    const namesOf = (repo: RepoView) => {
      const origin = forgeOf(repo.origin);
      const full = origin.owner && origin.name ? `${origin.owner}/${origin.name}` : undefined;
      return [repo.id, repo.name, full, repo.origin]
        .filter((name): name is string => Boolean(name))
        .map((name) => name.toLowerCase());
    };
    const repos = this.options.repos.list();
    const own = record.repoId ? repos.find((repo) => repo.id === record.repoId) : undefined;
    if (own && namesOf(own).includes(asked)) return { repo: own, own: true };
    const matches = repos.filter((repo) => repo.id !== own?.id && namesOf(repo).includes(asked));
    if (matches.length === 1) return { repo: matches[0] as RepoView, own: false };
    const managed = repos.map((repo) => repo.name).join(", ");
    if (matches.length > 1)
      return {
        said: `Cannot open the change on "${repository}": more than one project the app manages answers to that name (${matches.map((repo) => repo.name).join(", ")}). Name it by owner/name or its origin.`,
      };
    return {
      said: `Cannot open the change on "${repository}": a change opens only in a project the app manages${managed ? ` (${managed})` : ""}. Name one of them, or leave repository out for this task's own.`,
    };
  }

  /**
   * A change open_change opened from an existing branch (INF-2184) becomes
   * the task's current change, selected the way a named pull request is.
   * A host with no pull requests keeps no selection: its branch is read by
   * name. One opened in another managed project names that project
   * (INF-2510).
   */
  private async selectOpened(
    record: TaskRecord,
    forge: Forge,
    change: ForgeChange,
    asked: string | undefined,
    elsewhere?: RepoView,
  ): Promise<void> {
    const repo = elsewhere ?? (record.repoId ? this.options.repos.get(record.repoId) : undefined);
    const origin = forgeOf(repo?.origin);
    if (
      change.number === undefined ||
      !hasChangeRequests(forge.kind) ||
      !origin.host ||
      !origin.owner ||
      !origin.name
    )
      return;
    const base = change.base ?? asked ?? (await forge.defaultBranch());
    this.context.select(
      this.options.tasks.get(record.id) ?? record,
      reviewOf(
        forge,
        { host: origin.host, owner: origin.owner, name: origin.name },
        { ...change, number: change.number, base },
        this.context.now(),
        elsewhere ? { repoId: elsewhere.id } : {},
      ),
    );
  }

  /**
   * Another branch a placed task's crewmate checked out there to deliver,
   * brought to the task's own ref for it here (INF-2490); answers that ref.
   */
  private async otherBranchHome(record: { id: string }, branch: string): Promise<string> {
    await this.options.bringBranchHome?.(record.id, true, branch);
    return checkedOutRefFor(record.id);
  }
}

/**
 * How a crewmate checks out an existing branch to deliver it (INF-3995): by
 * name, or at its commit where another working copy holds the name.
 */
function checkOutWords(branch: string): string {
  return `Check out ${branch} (git switch ${branch}; where another working copy holds it, git switch --detach ${branch})`;
}

function lowerFirst(words: string): string {
  return words.charAt(0).toLowerCase() + words.slice(1);
}

/** What open_change says of a body on a host whose pushed branch carries no description. */
function keepsNoDescription(forge: Forge): string {
  return `${forge.place ?? "The project's host"} keeps no description for a pushed branch, so body was not published.`;
}

/** Two descriptions alike as a host keeps them: line endings and trailing space aside. */
function sameDescription(held: string | undefined, body: string): boolean {
  const plain = (text: string) => text.replace(/\r\n?/g, "\n").trimEnd();
  return plain(held ?? "") === plain(body);
}

/**
 * Who reads a story, from the visibility the host read when it was prepared
 * (INF-2142's approved plan): the crewmate is told the audience it writes for.
 */
function storyAudience(destination: PresentationDestination): string {
  if (hostedPresentation(destination))
    return destination.visibility === "public"
      ? `${destination.fullName} is public: anyone can read this story, so it names nothing personal or local.`
      : `${destination.fullName} is ${destination.visibility}: everyone with access can read this story, and the project can turn public, so it names nothing personal or local.`;
  return destination.kind === "branch"
    ? "Everyone who can reach the branch where the project lives can read its commits; write them for a stranger."
    : "";
}
