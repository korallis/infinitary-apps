import { createHash, randomBytes } from "node:crypto";
import { open, readFile, realpath, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { cardSizeRefusal } from "@shared/cardSize";
import {
  type ChangePresentation,
  type ChangePresentationRecord,
  changePresentationSchema,
  type PresentationAsset,
  type PresentationPublication,
  type PresentationReceipt,
  type PresentationRecovery,
  readyPresentation,
  type StoryAround,
} from "@shared/changePresentation";
import {
  CHANGE_REQUEST_HOSTS,
  type ChangeRequestKind,
  changeRequestHost,
  changeRequestKind,
} from "@shared/forgeKinds";
import { overridePasses } from "@shared/holds";
import { servedNumber } from "@shared/i18n/format";
import { acceptedValidation } from "@shared/liveValidation";
import { liveValidationSummary } from "@shared/liveValidationSummary";
import {
  assertBranchStoryAddress,
  hostedPresentation,
  type LocalPresentationDestination,
  nativePresentationMedia,
  type PresentationDestination,
  presentationFormat,
  samePresentationDestination,
  sameProjectAnyAudience,
  storyAtOrigin,
  widenedAudience,
} from "@shared/presentationDestination";
import { presentationValidation } from "@shared/presentationValidation";
import type { NamingRule } from "../../shared/runbooks";
import { issueLine } from "../batches/description";
import {
  AttachmentUploadError,
  changeTitle,
  type Forge,
  type ForgeChange,
  ForgeWriteError,
  neutralizePipelineAttestation,
  PresentationAroundError,
  pipelineAttestationSection,
  presentationAround,
  presentationBodyLimit,
  presentationCardBody,
  presentationCommitMessage,
  presentationContentHash,
  presentationLines,
  presentationMarkdown,
  presentationMarkdownText,
  presentationRegionMarkers,
  presentationSizingUrl,
  readPresentationRegion,
  replaceAroundPresentation,
  replacePresentationRegion,
  sameAroundPresentation,
  sameAttachmentDestination,
} from "../forge";
import { restoreKeptCopy } from "../pi/cardImages";
import type { StagedChangePresentation } from "../pi/changePresentation";
import { storyLedgers } from "../storage/changeProjection";
import type { TaskService } from "../tasks/taskService";
import { requireNamed } from "../workspace/naming";

export type PresentationLedger = Pick<TaskService, "get"> & {
  delivery: Pick<
    TaskService["delivery"],
    "changePresentation" | "updateChangePresentation" | "afterMergeRefusal" | "afterMergeShown"
  >;
};
const hash = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");

/**
 * What to do when the app's stored copy of a story picture is gone and no
 * identical copy is left to keep again: the view and side it showed, and
 * preparing again from the picture's original file, whose bytes still pass
 * the kept Before comparison (INF-3672).
 */
function missingMediaWords(story: ChangePresentation, asset: PresentationAsset): string {
  for (const view of story.views)
    for (const side of ["before", "after"] as const)
      if (view[side].some((media) => media.asset === asset.id || media.poster === asset.id))
        return `The app's stored copy of the ${side === "before" ? "Before" : "After"} picture for ${view.caption} is gone, and no identical copy is left. Prepare the story again naming that picture's original file.`;
  return "The app's stored copy of a story picture is gone, and no identical copy is left. Prepare the story again naming each picture's original file.";
}
/** GitHub's body limit covers the rendered region and all surrounding project/human text. */
export const GITHUB_STORY_BODY_LIMIT = presentationBodyLimit("github.com");

/** What each kind calls the two branches a change joins, in its one-open-change rule. */
// i18n-exempt: a tool answer served to the crewmate, not shown to a person
const BRANCH_PAIR_WORDS: Record<ChangeRequestKind, string> = {
  github: "head and base",
  gitlab: "source and target branch",
  bitbucket: "source and destination branch",
};

/** The host's own words in a crewmate's tool text: GitHub's pull request, GitLab's merge request. */
function hostWords(forge: Forge): { place: string; change: string; oneOpen: string } {
  const place = forge.place ?? "the project's host";
  const kind = changeRequestKind(forge.kind) ?? "github";
  const change = CHANGE_REQUEST_HOSTS[kind].changeWord;
  return {
    place,
    change,
    oneOpen: `${place} permits only one open ${change} for this ${BRANCH_PAIR_WORDS[kind]}`,
  };
}

type PublicationOpening = {
  draft?: boolean;
  /** The branch the change targets when it opens (INF-1873); an open change keeps its own. */
  base?: string;
  /** Recheck and consume the caller's publication authority after preflight, before uploads. */
  beforePublish?: (head: string) => void;
  /** Re-read the approved address at the plain branch publication boundaries. */
  branchOrigin?: () => string | null;
  /** Whether Careful's records complete no-mistakes' review, test and document at this version. */
  attests?: (head: string) => boolean;
  /** The ref this Mac holds the branch at when not under its own name (INF-2490). */
  source?: string;
};

type PresentationTarget = Forge | LocalPresentationDestination;

async function storyDestination(target: PresentationTarget): Promise<PresentationDestination> {
  if (target.kind === "local") return target;
  if (target.storyDestination) return target.storyDestination();
  if (target.attachments) return target.attachments.destination();
  throw new Error("The story's destination cannot be read.");
}

/**
 * The story as its merge card shows it: each validation row names the kept
 * proof the record holds for it. Each log is named on the card, never read
 * into it: the log reader opens its kept file (`validationCard`).
 */
function withKeptEvidence(
  story: ChangePresentation,
  current: ReturnType<typeof liveValidationSummary>,
): ChangePresentation {
  if (!story.liveValidation) return story;
  return {
    ...story,
    liveValidation: {
      ...story.liveValidation,
      rows: story.liveValidation.rows.map((row) => ({
        ...row,
        evidence: current?.rows.find((item) => item.id === row.id)?.evidence ?? [],
      })),
    },
  };
}

/** How a crewmate makes a story's merge card small enough to open (`cardSizeRefusal`). */
const STORY_SHRINK =
  "Make the story's largest parts smaller - its words, its own What changed part or its map views - then prepare the story again and show the merge card from the new revision.";

/** What the project says of a story's Before base, read beside its version. */
export type StartingCommit = "descends" | "missing" | "unrelated" | "unread";
type ReadStartingCommit = (taskId: string, base: string, head: string) => Promise<StartingCommit>;

/** Serialization, retained receipts and the all-files-first barrier; never merge authority. */
export class ChangePresentations {
  private readonly active = new Map<string, ReadonlySet<string>>();

  constructor(
    private readonly options: {
      /** The active naming runbook's rule, read at each use; absent or null, no naming runbook is on. */
      namingRule?: () => NamingRule | null;
      tasks: PresentationLedger;
      mediaDir: (taskId: string) => string;
      /** Read actual committed code, including after asynchronous uploads. */
      head: (taskId: string) => Promise<string>;
      /**
       * The branch the working copy has checked out, whose change a story
       * is prepared for (INF-2490); undefined for the task's current change.
       */
      branch?: (taskId: string) => Promise<string | undefined>;
      /**
       * The map part a story's map view draws in on the merge card
       * (`docs/forge.md`, "A map view"); undefined where it cannot be read,
       * and the view shows its picture.
       */
      mapPart?: () => Promise<string | undefined>;
    },
  ) {}

  /**
   * Whether a story's Before base is a commit in the project that its
   * version descends from, bound by the delivery that reads the version
   * (`ChangePublication.startingCommit`); unbound, nothing is looked up.
   */
  private startsFrom?: ReadStartingCommit;

  startingCommitsFrom(read: ReadStartingCommit): void {
    this.startsFrom = read;
  }

  async prepare(
    taskId: string,
    staged: StagedChangePresentation,
    target: PresentationTarget,
    how: {
      /**
       * The same words at the same version answer the newest revision, so a
       * call made again adds no revision and uploads nothing (show_merge_card).
       */
      reuseSame?: boolean;
      /** The approved project address seen by the caller, checked again when saving. */
      approvedAddress?: { origin: string; current: () => boolean; recover: boolean };
    } = {},
  ): Promise<number> {
    try {
      return await this.serial(
        taskId,
        async () => {
          if ((await this.options.head(taskId)) !== staged.head)
            throw new Error("The code changed. Prepare a story for the current committed version.");
          const branch = await this.options.branch?.(taskId);
          const destination = await storyDestination(target);
          const kept = this.options.tasks.delivery.changePresentation(taskId, branch);
          const address = how.approvedAddress;
          if (address) assertBranchStoryAddress(destination, address.origin);
          const former = kept?.revisions.at(-1)?.destination;
          // An address already moved by an older build has no retirement event. Recover only
          // an ordinary remote story, and only after reading the currently approved destination.
          const retired =
            address?.recover &&
            former &&
            kept?.forkNumber === undefined &&
            (hostedPresentation(former) && hostedPresentation(destination)
              ? !former.media && !destination.media
              : !hostedPresentation(former) &&
                former.kind === "branch" &&
                !hostedPresentation(destination) &&
                destination.kind === "branch") &&
            storyAtOrigin(destination, address.origin) &&
            !storyAtOrigin(former, address.origin);
          const current = retired ? undefined : kept;
          if (
            current?.publication &&
            current.publication.state !== "confirmed" &&
            !current.publication.retryOpening
          )
            throw new Error("Reconcile the uncertain story write before preparing a replacement.");
          const prior = current?.revisions.at(-1);
          // The same project at a new visibility starts the next revision at the
          // audience read now; its identity and Before base still hold, and every
          // publication check compares the audience again.
          if (prior && !sameProjectAnyAudience(prior.destination, destination))
            throw new Error(
              "Keep the story's original project; reconcile a changed project identity before publishing.",
            );
          if (!prior || prior.base !== staged.base) {
            // A later revision keeps the first base; the one exception is a
            // first base that names no commit in the project, which nothing
            // could ever be compared against.
            const startsFrom = this.startsFrom;
            if (prior && (await startsFrom?.(taskId, prior.base, staged.head)) !== "missing")
              throw new Error(
                `Keep the original Before base ${prior.base}: every story revision names the starting commit the first one named.`,
              );
            const found = await startsFrom?.(taskId, staged.base, staged.head);
            if (found === "missing")
              throw new Error(
                `The Before base ${staged.base} is not a commit in this project. Give the full id git rev-parse prints for the commit the change started from, then prepare the story again.`,
              );
            if (found === "unrelated")
              throw new Error(
                `The committed version ${staged.head} does not descend from the Before base ${staged.base}. Give the full id of the commit the change started from, such as git merge-base prints against the default branch, then prepare the story again.`,
              );
          }
          const revision = (prior?.revision ?? 0) + 1;
          if (staged.version === 2)
            requireNamed(staged.title, "story title", this.options.namingRule?.() ?? null);
          const story = changePresentationSchema.parse({
            ...staged,
            taskId,
            destination,
            revision,
            ...(staged.version === 2
              ? {
                  liveValidation: presentationValidation(
                    this.options.tasks.get(taskId)?.delivery?.liveValidation,
                    staged.head,
                    staged.validationRows,
                  ),
                }
              : {}),
          });
          const steps =
            story.afterMerge &&
            this.options.tasks.delivery.afterMergeRefusal(taskId, story.afterMerge);
          if (steps) throw new Error(steps);
          if (how.reuseSame && prior && prior.head === story.head && sameStoryWords(prior, story))
            return prior.revision;
          await this.checkRetained(story);
          // Its merge card is measured now, with the log lines showing it adds,
          // so a story too large to open is refused before it is saved.
          const tooLarge = cardSizeRefusal(
            presentationCardBody(
              withKeptEvidence(
                story,
                liveValidationSummary(
                  this.options.tasks.get(taskId)?.delivery?.liveValidation,
                  story.head,
                  false,
                ),
              ),
              story.views.some((view) => view.map !== undefined)
                ? await this.options.mapPart?.()
                : undefined,
            ),
            STORY_SHRINK,
          );
          if (tooLarge) throw new Error(tooLarge);
          // Before media for a surviving view stays the original comparison, never silently refreshed.
          for (const view of prior?.views ?? []) {
            const next = story.views.find((candidate) => candidate.id === view.id);
            if (!next) continue;
            const identities = (owner: ChangePresentation, entries: typeof view.before) =>
              entries.map(
                (entry) => owner.assets.find((asset) => asset.id === entry.asset)?.uploadSha256,
              );
            if (
              JSON.stringify(identities(prior as ChangePresentation, view.before)) !==
              JSON.stringify(identities(story, next.before))
            )
              throw new Error(`Keep the original Before evidence for ${view.id}.`);
          }
          await this.save(taskId, branch, (saved) => {
            if (address && !address.current())
              throw new Error("The approved project address changed. Prepare the story again.");
            const record = retired ? undefined : saved;
            const receipts = [...(record?.receipts ?? [])];
            for (const asset of this.nativeAssets(story)) {
              if (!hostedPresentation(story.destination))
                throw new Error("An upload needs a host.");
              if (receipts.some((receipt) => receiptMatches(story, asset, receipt))) continue;
              receipts.push({
                destination: story.destination,
                digest: asset.uploadSha256,
                mediaType: asset.mediaType,
                state: "prepared",
              });
            }
            return {
              ...record,
              revisions: [...(record?.revisions ?? []), story],
              receipts,
              ...(!hostedPresentation(destination) && destination.kind === "local"
                ? {
                    completion: {
                      revision,
                      head: story.head,
                      contentHash: presentationContentHash(story),
                    },
                  }
                : {}),
            };
          });
          return revision;
        },
        staged.assets,
      );
    } finally {
      await this.discardStaged(taskId, staged);
    }
  }

  /** Also used for refusals before preparation starts, including transferred staging copies. */
  async discardStaged(taskId: string, staged: StagedChangePresentation): Promise<void> {
    await this.cleanupMedia(taskId, staged.assets);
  }

  /** Does not replace an old PR or leave a new PR with only some of its planned evidence. */
  async publish(
    taskId: string,
    revision: number,
    forge: Forge,
    branch: string,
    title: string,
    checks: "pending" | "passed" = "pending",
    recovery?: PresentationRecovery,
    around?: StoryAround,
    opening?: PublicationOpening,
  ): Promise<ForgeChange> {
    // INF-2509: the revision the author named stands for the host's republication of it.
    const record = this.options.tasks.delivery.changePresentation(taskId, branch);
    const named = (record && shownRevision(record, revision)) ?? revision;
    return this.serial(taskId, () =>
      this.publishLocked(
        taskId,
        named,
        forge,
        branch,
        title,
        checks,
        recovery,
        false,
        undefined,
        around,
        opening,
      ),
    );
  }

  private async publishLocked(
    taskId: string,
    revision: number,
    forge: Forge,
    branch: string,
    title: string,
    checks: "pending" | "passed",
    recovery?: PresentationRecovery,
    remoteOnly = false,
    inherited?: { contentHash: string; refreshOf: number },
    around?: StoryAround,
    opening?: PublicationOpening,
  ): Promise<ForgeChange> {
    const story = this.current(taskId, branch, revision);
    if (story.version === 2 && title !== story.title)
      throw new Error("Use the saved title for the pull request and merge card.");
    if (!hostedPresentation(story.destination)) {
      if (story.destination.kind !== "branch")
        throw new Error("A local story has no remote publication.");
      if (around || recovery)
        throw new Error("A pushed branch has no description to replace or reconcile.");
      await this.validatePrepared(story, forge, remoteOnly);
      if (opening?.branchOrigin)
        assertBranchStoryAddress(story.destination, opening.branchOrigin());
      const existing = await forge.changeFor(branch);
      if (existing && existing.headSha !== story.head)
        throw new Error("The pushed branch does not match this story.");
      if (opening?.branchOrigin)
        assertBranchStoryAddress(story.destination, opening.branchOrigin());
      opening?.beforePublish?.(story.head);
      // A placed branch is brought home before publication. Preserve the plain
      // forge's first push from there; an already-pushed branch needs no write.
      const change =
        existing ??
        (await forge.openChange({
          branch,
          title,
          body: "",
          ...(opening?.source ? { source: opening.source } : {}),
        }));
      await this.validateCurrent(story, forge, branch, remoteOnly);
      if (change.headSha !== story.head)
        throw new Error("The pushed branch does not match this story.");
      await this.save(taskId, branch, (record) => {
        if (opening?.branchOrigin)
          assertBranchStoryAddress(story.destination, opening.branchOrigin());
        return {
          ...this.required(record),
          completion: { revision, head: story.head, contentHash: presentationContentHash(story) },
        };
      });
      return change;
    }
    const destination = story.destination;
    if (nativePresentationMedia(destination) && !forge.attachments)
      throw new Error("Native evidence publication is not available on this host.");
    const words = hostWords(forge);
    let ledger = this.ledger(taskId, branch);
    if (ledger.publication && ledger.publication.state !== "confirmed") {
      // Recover a prior write by reading, even if a later push moved the code.
      // Its original head stays on the receipt; completion still needs a current story.
      if (!samePresentationDestination(destination, await storyDestination(forge)))
        throw new Error("The publication destination or audience changed.");
      const reconciled = await this.reconcile(story, ledger.publication, forge, branch, recovery);
      // A reconciled write is this revision's; words around it still need their own change.
      if (reconciled && ledger.publication.revision === revision && !around) return reconciled;
      ledger = this.ledger(taskId, branch);
    }
    const existing = await forge.changeFor(branch);
    if (existing && !ledger.published && ledger.publication?.retryOpening) {
      const reconciled = await this.reconcile(
        story,
        ledger.publication,
        forge,
        branch,
        recovery,
        existing,
      );
      if (reconciled && ledger.publication.revision === revision && !around) return reconciled;
      ledger = this.ledger(taskId, branch);
    }
    if (
      existing &&
      !ledger.published &&
      !ledger.reconciled &&
      (!forge.storyInComment || !!existing.body)
    )
      throw new Error(`This ${words.change} predates the saved story. It will not be rewritten.`);
    if (!existing && (ledger.published || ledger.reconciled))
      throw new Error(
        `The published ${words.change} is no longer open. Publication stops; close this task or deliberately reopen that same ${words.change} on ${words.place}.`,
      );
    const knownNumber = ledger.published?.number ?? ledger.reconciled?.number;
    if (existing && knownNumber !== undefined && existing.number !== knownNumber)
      throw new Error(
        `Another ${words.change} is open for this branch. Publication stops rather than replacing the named ${words.change}.`,
      );
    // INF-497: changing only the words around the published story keeps its region byte for byte.
    const kept = around && ledger.published?.revision === revision ? ledger.published : undefined;
    await this.validateCurrent(story, forge, branch, remoteOnly);
    if (story.liveValidation?.verdict) this.currentValidation(taskId, story);
    // A person's rename stops the story before any file is sent, not only before the write.
    this.renameFor(story, ledger, existing, forge, title);
    const previousRegion =
      recovery?.replaceRegion ?? ledger.reconciled?.region ?? ledger.published?.region;
    // INF-1793: Careful counts as no-mistakes on github.com; the attestation sits at
    // the end of the app's own region, read from the records when the region is written.
    const { end: regionEnd } = presentationRegionMarkers(taskId);
    const attested = (rendered: string): string => {
      // A request's native title belongs to its contributor. Keep the crew's
      // conventional squash title in its own story comment instead. The
      // disclosure sits inside the region so the squash summary, built from
      // the words around it, never carries it.
      if (forge.storyInComment) {
        const { start } = presentationRegionMarkers(taskId);
        rendered = rendered.replace(
          start,
          `${start}\n\n${forge.storyDisclosure ? `${forge.storyDisclosure}\n\n` : ""}# ${presentationMarkdownText(story.title)}`,
        );
      }
      return destination.host === "github.com" &&
        rendered.endsWith(regionEnd) &&
        opening?.attests?.(story.head)
        ? `${rendered.slice(0, -regionEnd.length)}${pipelineAttestationSection(story.head, story.liveValidation)}\n\n${regionEnd}`
        : rendered;
    };
    const bodyFor = (region: string, current: ForgeChange | null): string => {
      if (around && !current)
        throw new PresentationAroundError(
          `Nothing was sent: around changes the words around the story on an open ${words.change}. On its first publication, put them in the story's projectText.`,
        );
      const replaced =
        current && previousRegion !== undefined
          ? replacePresentationRegion(current.body ?? "", previousRegion, region, taskId)
          : [
              story.projectText,
              issueLine(this.options.tasks.get(taskId)?.shape?.issue, forge.kind),
              region,
            ]
              .filter(Boolean)
              .join("\n\n");
      const changed = around
        ? replaceAroundPresentation(
            replaced,
            around,
            taskId,
            changeRequestHost(forge.kind)?.quickActions ?? false,
          )
        : replaced;
      // The check reads the first attestation it finds; words around the region carry none live.
      const outside = region.includes(pipelineAttestationSection(story.head, story.liveValidation))
        ? presentationAround(changed, taskId)
        : undefined;
      const body = outside
        ? `${neutralizePipelineAttestation(outside.above)}${region}${neutralizePipelineAttestation(outside.below)}`
        : changed;
      const limit = presentationBodyLimit(presentationFormat(destination));
      if (Array.from(body).length > limit)
        throw new Error(
          `The complete ${words.change} description exceeds ${words.place}'s ${servedNumber(limit)}-character limit. Shorten the story or surrounding text before publishing.`,
        );
      return body;
    };
    // Render the actual layout, escaping, links and recovery-preserved words before sending files.
    bodyFor(
      kept?.region ??
        attested(
          presentationMarkdown(
            story,
            // Never saved as a receipt or sent: a real receipt's length, for sizing alone.
            new Map(
              this.nativeAssets(story).map((asset) => [
                asset.id,
                presentationSizingUrl(destination.host, asset.mediaType),
              ]),
            ),
            existing ? checks : "pending",
          ),
        ),
      existing,
    );
    opening?.beforePublish?.(story.head);
    const urls = await this.uploadAssets(story, branch, forge, destination, recovery);
    // Uploading may have taken time. No write until code, destination and all retained files still match.
    await this.validateCurrent(story, forge, branch, remoteOnly);
    const region =
      kept?.region ?? attested(presentationMarkdown(story, urls, existing ? checks : "pending"));
    const fresh = await forge.changeFor(branch);
    if (existing?.number !== fresh?.number)
      throw new Error(`The ${words.change} changed during publication. Read it again.`);
    if (fresh && fresh.headSha !== story.head)
      throw new Error("The pushed code does not match this story.");
    // A person may have added words during upload. Recheck before any description write.
    const body = bodyFor(region, fresh);
    const rename = this.renameFor(story, ledger, fresh, forge, title);
    if (
      fresh &&
      body === fresh.body &&
      rename === undefined &&
      ledger.published?.revision === revision
    )
      return fresh;
    const publication: PresentationPublication = {
      revision,
      head: story.head,
      state: "sending",
      region,
      regionHash: hash(region),
      contentHash: inherited?.contentHash ?? kept?.contentHash ?? presentationContentHash(story),
      ...(inherited
        ? { refreshOf: inherited.refreshOf }
        : kept?.refreshOf !== undefined
          ? { refreshOf: kept.refreshOf }
          : {}),
      ...(story.version === 2 || !fresh ? { title } : {}),
      ...(fresh?.number ? { number: fresh.number } : {}),
    };
    this.options.tasks.delivery.updateChangePresentation(
      taskId,
      (record) => ({
        ...this.required(record),
        publication,
      }),
      branch,
    );
    let read: ForgeChange | null;
    try {
      if (fresh) {
        if (!forge.updateChangeBody) throw new Error("This host cannot replace a saved story.");
        await forge.updateChangeBody(fresh, body, rename);
      } else {
        const opened = await forge.openChange({
          branch,
          title,
          body,
          ...(opening?.draft !== undefined ? { draft: opening.draft } : {}),
          ...(opening?.base ? { base: opening.base } : {}),
        });
        if (opened.number) publication.number = opened.number;
      }
      // Neither GitHub nor GitLab offers an atomic conditional body update. Reread both sides and disclose the race.
      // Only the generated region is the app's: GitLab runs and strips a project
      // template's own quick actions around it, and a person may add words (INF-290 F3).
      read = await forge.changeFor(branch);
      if (
        !read ||
        read.headSha !== story.head ||
        readPresentationRegion(read.body ?? "", taskId) !== presentationLines(region)
      )
        throw new Error(
          "The story write did not read back exactly; a simultaneous edit or an uncertain write needs reconciliation.",
        );
      await this.confirm(taskId, branch, { ...publication, number: read.number });
    } catch (error) {
      this.options.tasks.delivery.updateChangePresentation(
        taskId,
        (record) => ({
          ...this.required(record),
          publication:
            error instanceof ForgeWriteError && error.outcome === "failed"
              ? ledger.publication
              : { ...publication, state: "uncertain" },
        }),
        branch,
      );
      throw error;
    }
    // The story is the app's and is confirmed; the words around it are a person's too.
    if (around && !sameAroundPresentation(read.body ?? "", body, taskId))
      throw new PresentationAroundError(
        `The story is published, but ${words.place} shows different words around it than you sent; someone may have edited them at the same time. Read the description with github_read before changing them again.`,
      );
    // INF-717: the title went in the same write; a person may have renamed the change meanwhile.
    const shown = changeTitle(forge.kind, read);
    if (
      !forge.storyInComment &&
      fresh &&
      story.version === 2 &&
      shown !== undefined &&
      shown !== title
    )
      throw new PresentationAroundError(
        `The story is published, but ${words.place} shows the title "${shown}" rather than "${title}"; someone may have renamed the ${words.change} at the same time. Read it with github_read before calling open_change again.`,
      );
    return read;
  }

  /**
   * INF-717: a version-2 story's title is its change's title too. Answers the title
   * to send with the story when the change still carries the one the app left there, or none when
   * it already reads the story's; a person's rename sends nothing and is said.
   */
  private renameFor(
    story: ChangePresentation,
    record: ChangePresentationRecord,
    current: ForgeChange | null,
    forge: Forge,
    title: string,
  ): string | undefined {
    if (story.version !== 2 || !current) return undefined;
    const hosted = changeTitle(forge.kind, current);
    if (hosted === undefined || hosted === title) return undefined;
    if (forge.storyInComment) return undefined;
    const published = record.published;
    const left = published?.title;
    if (hosted === left) return title;
    // A publication before INF-717 kept no title, and the app set one only on opening. Its own
    // version-2 story's title is the app's; the record no longer keeps any older one.
    if (
      published &&
      left === undefined &&
      record.revisions.find((saved) => saved.revision === published.revision && saved.version === 2)
        ?.title === hosted
    )
      return title;
    const words = hostWords(forge);
    throw new PresentationAroundError(
      `Nothing was sent: the ${words.change}'s title on ${words.place} reads "${hosted}", not the story's "${title}". ${left === undefined ? "The app has no record of setting that title." : `The app last left "${left}" there, so someone renamed it.`} To keep that title, prepare the story with it and call open_change again. To use the story's title instead, ask the captain on a card first, then set the title alone with github_write and call open_change again.`,
    );
  }

  /**
   * A completion offer must use the newest fully published story at the
   * current committed version. `ahead` words the refusal of another
   * committed version, where no push answers it: a pull request merged
   * outside the app (INF-3799).
   */
  async completion(
    taskId: string,
    revision: number,
    head: string,
    branch?: string,
    number?: number,
    ahead?: (committed: string) => string,
  ) {
    return this.serial(taskId, async () => {
      const story = this.publishedStory(taskId, branch, head, revision, number);
      const committed = await this.options.head(taskId);
      if (committed !== head)
        throw new Error(
          ahead?.(committed) ??
            `${pushFirst(committed, head)} Then show the merge card again with presentation ${revision}.`,
        );
      const currentValidation = story.liveValidation
        ? this.currentValidation(taskId, story)
        : undefined;
      await this.checkRetained(story);
      // A displayed card owns independent copies. Story pruning never sees
      // these minted names, even after the card closes or the app restarts.
      const copies: PresentationAsset[] = [];
      try {
        for (const asset of story.assets) {
          const bytes = await this.readAsset(story, asset);
          const id = `${taskId}-${randomBytes(16).toString("hex")}`;
          const copy = { ...asset, id, file: asset.file.replace(asset.id, id) };
          const file = await open(join(this.options.mediaDir(taskId), copy.file), "wx");
          copies.push(copy);
          try {
            await file.writeFile(bytes);
          } finally {
            await file.close();
          }
        }
        const ids = new Map(story.assets.map((asset, index) => [asset.id, copies[index]?.id]));
        const copiedId = (id: string): string => {
          const copy = ids.get(id);
          if (!copy) throw new Error("The story has missing retained media.");
          return copy;
        };
        const cardStory: ChangePresentation = {
          ...withKeptEvidence(story, currentValidation),
          assets: copies,
          views: story.views.map((view) => {
            const media = (entries: typeof view.before) =>
              entries.map((entry) => ({
                ...entry,
                asset: copiedId(entry.asset),
                ...(entry.poster ? { poster: copiedId(entry.poster) } : {}),
              }));
            return { ...view, before: media(view.before), after: media(view.after) };
          }),
          // The free-form part names its pictures by the story's copies' names.
          ...(story.whatChangedPart
            ? {
                whatChangedPart: story.assets.reduce(
                  (part, asset) => part.replaceAll(asset.id, copiedId(asset.id)),
                  story.whatChangedPart,
                ),
              }
            : {}),
          pictures: story.pictures.map((picture) => ({
            ...picture,
            id: copiedId(picture.id),
            ...(picture.demo ? { demo: { ...picture.demo, id: copiedId(picture.demo.id) } } : {}),
          })),
        };
        const body = presentationCardBody(
          cardStory,
          cardStory.views.some((view) => view.map !== undefined)
            ? await this.options.mapPart?.()
            : undefined,
        );
        // Measured as the window will receive it (INF-3887): a merge card too
        // large to open goes back to its crewmate, never to the captain.
        const tooLarge = cardSizeRefusal(body, STORY_SHRINK);
        if (tooLarge) throw new Error(tooLarge);
        return {
          title: story.title,
          body,
          pictures: cardStory.pictures,
          riskDeclaration: story.risk,
          requiredActions: story.requiredActions,
          ...(story.afterMerge?.length
            ? { afterMerge: this.options.tasks.delivery.afterMergeShown(story.afterMerge) }
            : {}),
        };
      } catch (error) {
        await this.cleanupMedia(taskId, copies);
        throw error;
      }
    });
  }

  /**
   * The newest story again, its words unchanged, once live validation was
   * accepted after it was prepared with the same scenarios (show_merge_card,
   * INF-3717 piece 2): a new revision whose validation summary is the one
   * accepted now. Undefined when nothing needs it: no live validation on the
   * story, proof not accepted yet, the story at another version, a write
   * still being reconciled, or the summary already current. Scenarios that
   * changed refuse, since only the crewmate can write their public rows.
   */
  async refreshValidation(taskId: string, branch: string | undefined): Promise<number | undefined> {
    return this.serial(taskId, async () => {
      const record = this.options.tasks.delivery.changePresentation(taskId, branch);
      const newest = record?.revisions.at(-1);
      if (!record || !newest?.liveValidation || newest.version !== 2) return undefined;
      if (record.publication && record.publication.state !== "confirmed") return undefined;
      if ((await this.options.head(taskId)) !== newest.head) return undefined;
      const state = this.options.tasks.get(taskId)?.delivery?.liveValidation;
      const current = liveValidationSummary(state, newest.head, false);
      if (
        !current?.verdict ||
        (current.revision === newest.liveValidation.revision &&
          current.label === newest.liveValidation.label)
      )
        return undefined;
      const story = changePresentationSchema.parse({
        ...newest,
        revision: newest.revision + 1,
        liveValidation: presentationValidation(state, newest.head, newest.validationRows),
      });
      await this.save(taskId, branch, (old) => ({
        ...this.required(old),
        revisions: [...this.required(old).revisions, story],
      }));
      return story.revision;
    });
  }

  /** Send each selected file once, by its receipt; a failed or uncertain upload stops before any write. */
  private async uploadAssets(
    story: ChangePresentation,
    branch: string,
    forge: Forge,
    destination: PresentationReceipt["destination"],
    recovery?: PresentationRecovery,
  ): Promise<Map<string, string>> {
    const urls = new Map<string, string>();
    const words = hostWords(forge);
    for (const asset of this.nativeAssets(story)) {
      if (!forge.attachments)
        throw new Error("Native evidence publication is not available on this host.");
      let receipt = this.receipt(story, branch, asset);
      if (receipt?.state === "sending" || receipt?.state === "uncertain") {
        this.keepReceipt(story, branch, { ...receipt, state: "uncertain" });
        if (!recovery?.retryUploads?.includes(asset.uploadSha256))
          throw new Error(
            `An attachment may already exist on ${words.place}. Disclose this possible orphan on a card before asking for a deliberate new attempt; then pass recovery.retryUploads with digest ${asset.uploadSha256}. No upload was resent.`,
          );
        receipt = { ...receipt, possibleOrphan: true };
      }
      if (receipt?.state === "confirmed" && receipt.url) {
        urls.set(asset.id, receipt.url);
        continue;
      }
      const bytes = await this.readAsset(story, asset).catch((error: unknown) => {
        this.keepReceipt(story, branch, {
          destination: destination,
          digest: asset.uploadSha256,
          mediaType: asset.mediaType,
          state: "unavailable",
          problem: "The retained evidence is unavailable or changed.",
        });
        throw error;
      });
      receipt = {
        ...(receipt?.possibleOrphan ? { possibleOrphan: true } : {}),
        destination: destination,
        digest: asset.uploadSha256,
        mediaType: asset.mediaType,
        state: "sending",
      };
      this.keepReceipt(story, branch, receipt);
      try {
        const uploaded = await forge.attachments.upload(destination, {
          bytes,
          sha256: asset.uploadSha256,
          mediaType: asset.mediaType,
        });
        receipt = { ...receipt, state: "confirmed", url: uploaded.url };
        this.keepReceipt(story, branch, receipt);
        urls.set(asset.id, uploaded.url);
      } catch (error) {
        this.keepReceipt(story, branch, {
          ...receipt,
          state: error instanceof AttachmentUploadError ? error.outcome : "uncertain",
          problem:
            error instanceof AttachmentUploadError
              ? error.message
              : "The upload outcome was not confirmed. Do not resend automatically; disclose the possible orphan before asking for another attempt.",
        });
        throw error;
      }
    }
    return urls;
  }

  /**
   * Confirm a story on its pushed branch where its change takes no pull
   * request of its own (docs/forge.md, "Batches of your own"): the pushed
   * code is this story's, and the story is published later, on its batch's
   * pull request. Nothing is written where the project lives.
   */
  async confirmBranch(
    taskId: string,
    revision: number,
    forge: Forge,
    branch: string,
    title: string,
    opening?: PublicationOpening,
  ): Promise<ForgeChange> {
    const record = this.options.tasks.delivery.changePresentation(taskId, branch);
    const named = (record && shownRevision(record, revision)) ?? revision;
    return this.serial(taskId, async () => {
      const story = this.current(taskId, branch, named);
      if (story.version === 2 && title !== story.title)
        throw new Error("Use the saved title for the pull request and merge card.");
      if (!hostedPresentation(story.destination))
        throw new Error("A batch needs a host that keeps a description.");
      if (this.ledger(taskId, branch).published)
        throw new Error("This story is already published on its own pull request.");
      await this.validateCurrent(story, forge, branch);
      if (story.liveValidation?.verdict) this.currentValidation(taskId, story);
      opening?.beforePublish?.(story.head);
      await this.save(taskId, branch, (kept) => ({
        ...this.required(kept),
        completion: {
          revision: named,
          head: story.head,
          contentHash: presentationContentHash(story),
        },
      }));
      return { branch, headSha: story.head, url: null, title };
    });
  }

  /**
   * What a change's one commit in a batch says: its story's title as the
   * subject, and under it the words a squash of its own pull request
   * would carry. Refused in words when this version has no ready story.
   */
  batchCommit(taskId: string, branch: string, head: string): { title: string; body: string } {
    const story = this.publishedStory(taskId, branch, head);
    return {
      title: story.title,
      body: presentationCommitMessage(story, this.options.namingRule?.() ?? null),
    };
  }

  /**
   * A change's story as its batch's pull request shows it: its selected
   * files sent by their receipts, then the same words its own pull request
   * would carry, between the task's own markers.
   */
  async batchRegion(
    taskId: string,
    branch: string,
    head: string,
    forge: Forge,
  ): Promise<{ story: ChangePresentation; region: string }> {
    return this.serial(taskId, async () => {
      const story = await this.atWidenedAudience(this.publishedStory(taskId, branch, head), forge);
      if (!hostedPresentation(story.destination))
        throw new Error("A batch needs a host that keeps a description.");
      await this.validatePrepared(story, forge, true);
      const urls = await this.uploadAssets(story, branch, forge, story.destination);
      return { story, region: presentationMarkdown(story, urls, "pending") };
    });
  }

  private currentValidation(taskId: string, story: ChangePresentation) {
    const current = liveValidationSummary(
      this.options.tasks.get(taskId)?.delivery?.liveValidation,
      story.head,
      false,
    );
    if (!current?.verdict) {
      // INF-3883: the captain's recorded override passes the proof hold at
      // this version, so the card shows the story's table as it reads now.
      if (overridePasses(this.options.tasks.get(taskId)?.delivery, "proof", story.head))
        return current;
      // INF-3717 piece 1: the refusal names which part of acceptance is
      // missing and who supplies it; a new story changes none of them.
      const acceptance = acceptedValidation(
        this.options.tasks.get(taskId)?.delivery?.liveValidation,
        story.head,
      );
      throw new Error(
        `Live validation is not accepted for this version, so preparing the story again changes nothing yet. Missing: ${acceptance.missing ?? acceptance.reason}`,
      );
    }
    if (
      current.revision !== story.liveValidation?.revision ||
      current.label !== story.liveValidation.label
    )
      throw new Error(
        `Live validation was accepted (run ${current.revision}, ${current.label}) after this story was prepared${story.liveValidation ? ` from run ${story.liveValidation.revision}, ${story.liveValidation.label}` : ""}. Prepare the story again at this version with prepare_change, publish it where the branch is pushed, then show its revision.`,
      );
    return current;
  }

  /** Local completion validates the committed code and retained files without reaching a forge. */
  async assertLocal(taskId: string, destination: LocalPresentationDestination): Promise<string> {
    const head = await this.options.head(taskId);
    const story = this.publishedStory(taskId, undefined, head);
    if (!samePresentationDestination(story.destination, destination))
      throw new Error("The story's local project changed.");
    await this.checkRetained(story);
    return head;
  }

  /**
   * Publication completeness is independent of checks and of permission to
   * merge. A completion offer passes its revision, so a refusal names the way
   * to a current story.
   */
  async assertPublished(
    taskId: string,
    change: ForgeChange,
    forge: Forge,
    revision?: number,
  ): Promise<ForgeChange> {
    // The story of the change being checked, on its own branch (INF-2490).
    const branch = change.branch;
    const record = this.ledger(taskId, branch, change.number);
    const story = this.publishedStory(taskId, branch, change.headSha, revision, change.number);
    if (!samePresentationDestination(story.destination, await storyDestination(forge)))
      throw new Error("The story's destination or audience changed.");
    if (!hostedPresentation(story.destination)) return change;
    // A story awaiting its batch carries no description of its own to read back.
    if (!record.published && !record.publication)
      return {
        ...change,
        squashMessage: presentationCommitMessage(story, this.options.namingRule?.() ?? null),
      };
    if (!record.published) throw new Error("The current story has not been published.");
    for (const asset of this.nativeAssets(story)) {
      const receipt = this.receipt(story, branch, asset, change.number);
      if (receipt?.state !== "confirmed" || !receipt.url)
        throw new Error("The current story is missing a confirmed attachment.");
    }
    if (record.published.regionHash !== hash(record.published.region))
      throw new Error("The saved publication record changed.");
    // A person's edit inside the story no longer holds the merge (INF-3623):
    // their words stay on the host, and the squash carries the saved story
    // with the words around it.
    const around = presentationAround(change.body ?? "", taskId);
    const projectText =
      readPresentationRegion(change.body ?? "", taskId) ===
      presentationLines(record.published.region)
        ? replacePresentationRegion(change.body ?? "", record.published.region, "", taskId)
        : around
          ? around.above + around.below
          : "";
    return {
      ...change,
      ...(forge.storyInComment
        ? { title: requireNamed(story.title, "story title", this.options.namingRule?.() ?? null) }
        : {}),
      squashMessage: presentationCommitMessage(
        { ...story, projectText },
        this.options.namingRule?.() ?? null,
      ),
    };
  }

  private async reconcile(
    story: ChangePresentation,
    publication: PresentationPublication,
    forge: Forge,
    branch: string,
    recovery?: PresentationRecovery,
    observed?: ForgeChange,
  ): Promise<ForgeChange | undefined> {
    const found = observed ?? (await forge.changeFor(branch));
    const ledger = this.ledger(story.taskId, branch);
    const words = hostWords(forge);
    if (found && (publication.number === undefined || publication.number === found.number)) {
      const region = readPresentationRegion(found.body ?? "", story.taskId);
      if (region === presentationLines(publication.region)) {
        await this.confirm(story.taskId, branch, { ...publication, number: found.number });
        return found;
      }
      if (
        (ledger.published && region === presentationLines(ledger.published.region)) ||
        (ledger.reconciled && region === presentationLines(ledger.reconciled.region))
      ) {
        this.options.tasks.delivery.updateChangePresentation(
          story.taskId,
          (record) => ({
            ...this.required(record),
            publication: ledger.published,
          }),
          branch,
        );
        const restored =
          ledger.published && region === presentationLines(ledger.published.region)
            ? "The last confirmed story"
            : "The reviewed edit";
        throw new Error(
          `${restored} is still on ${words.place}. Its state is restored; call open_change deliberately to retry the replacement.`,
        );
      }
      // A deliberate replacement is bound to the exact edit shown on the crewmate’s card.
      if (
        recovery?.replaceRegion !== undefined &&
        region === presentationLines(recovery.replaceRegion) &&
        found.number !== undefined
      ) {
        this.options.tasks.delivery.updateChangePresentation(
          story.taskId,
          (record) => ({
            ...this.required(record),
            publication: ledger.published,
            reconciled: { number: found.number as number, region },
          }),
          branch,
        );
        return undefined;
      }
      replacePresentationRegion(
        found.body ?? "",
        publication.region,
        publication.region,
        story.taskId,
      );
    }
    if (publication.number !== undefined || ledger.published) {
      throw new Error(
        `The published ${words.change} is no longer open. Publication stops; it will not be reopened or replaced. Close this task or reopen that ${words.change} deliberately on ${words.place} before continuing.`,
      );
    }
    if (recovery?.retryOpening || publication.retryOpening) {
      // The host permits only one open change for the branch and its target; the fresh read above found none.
      this.options.tasks.delivery.updateChangePresentation(
        story.taskId,
        (record) => ({
          ...this.required(record),
          publication: { ...publication, retryOpening: true },
        }),
        branch,
      );
      return undefined;
    }
    throw new Error(
      `The earlier ${words.change} write remains uncertain; absence is not proof that it failed. No request was resent. A deliberate open_change with recovery.retryOpening may try opening again; ${words.oneOpen}.`,
    );
  }

  /** A completion offer names its revision; the merge path names none and keeps its own words. */
  private publishedStory(
    taskId: string,
    branch: string | undefined,
    head: string,
    revision?: number,
    number?: number,
  ): ChangePresentation {
    const record = this.ledger(taskId, branch, number);
    const story = record.revisions.at(-1);
    if (story && !hostedPresentation(story.destination)) {
      const ready = readyPresentation(record);
      if (!ready || ready.head !== head || (revision !== undefined && ready.revision !== revision))
        throw new Error(
          "The current committed version needs its newest story. Prepare it with prepare_change, and on a pushed branch confirm it with open_change, before showing its merge card or merging.",
        );
      return story;
    }
    // Confirmed on its pushed branch, to be published on its batch's pull request.
    if (story && !record.published && !record.publication) {
      const ready = readyPresentation(record);
      if (ready && ready.head === head && (revision === undefined || ready.revision === revision))
        return story;
    }
    if (!story || (!record.published && revision === undefined))
      throw new Error("The current story has not been published.");
    if (
      !record.published ||
      (revision !== undefined && story.revision !== revision) ||
      record.publication?.state !== "confirmed" ||
      record.published?.revision !== story.revision ||
      record.published.head !== head ||
      story.head !== head
    )
      throw new Error(
        `The current story and all evidence must be published and read back before the merge card or merge.${revision === undefined ? "" : ` ${completionWayOut(record, story, head)}`}`,
      );
    return story;
  }

  private async confirm(
    taskId: string,
    branch: string | undefined,
    publication: PresentationPublication,
  ): Promise<void> {
    const confirmed = { ...publication, state: "confirmed" as const };
    await this.save(taskId, branch, (record) => ({
      ...this.required(record),
      publication: confirmed,
      published: confirmed,
      reconciled: undefined,
    }));
  }

  /** Keep the latest draft and the last complete publication, never an unbounded revision history. */
  private async save(
    taskId: string,
    branch: string | undefined,
    update: (record: ChangePresentationRecord | undefined) => ChangePresentationRecord,
  ): Promise<void> {
    const previous = this.options.tasks.delivery.changePresentation(taskId, branch);
    this.options.tasks.delivery.updateChangePresentation(
      taskId,
      (record) => {
        const next = update(record);
        const newest = next.revisions.at(-1)?.revision;
        return {
          ...next,
          revisions: next.revisions.filter(
            (story) =>
              story.revision === newest ||
              story.revision ===
                (next.completion?.revision ??
                  next.published?.revision ??
                  next.publication?.revision),
          ),
        };
      },
      branch,
    );
    await this.cleanupMedia(taskId, previous?.revisions.flatMap((story) => story.assets) ?? []);
  }

  private async cleanupMedia(taskId: string, assets: PresentationAsset[]): Promise<void> {
    // Every change's story keeps its own files (INF-2490).
    const kept = new Set(
      storyLedgers(this.options.tasks.get(taskId)?.delivery).flatMap((ledger) =>
        ledger.revisions.flatMap((story) => story.assets.map((asset) => asset.file)),
      ),
    );
    for (const asset of assets) {
      if (
        kept.has(asset.file) ||
        this.active.get(taskId)?.has(asset.file) ||
        !asset.file.startsWith(`${taskId}-`) ||
        !/^[A-Za-z0-9_-]+\.(png|jpg|webp|mp4)$/.test(asset.file)
      )
        continue;
      // A failed unlink must not turn a confirmed external write into an uncertain one.
      await rm(join(this.options.mediaDir(taskId), asset.file), { force: true }).catch(() => {
        console.warn("Could not remove superseded story media", taskId, asset.id);
      });
    }
  }

  /** Called only on a host-accepted repair lineage, not an author's arbitrary new story. */
  async refreshConflictOnly(
    taskId: string,
    fromHead: string,
    toHead: string,
    forge: Forge,
    branch: string,
    title: string,
    attests?: (head: string) => boolean,
  ): Promise<void> {
    await this.serial(taskId, () =>
      this.republishLocked(taskId, toHead, forge, branch, title, {
        fromHead,
        remoteOnly: true,
        checks: "passed",
        ...(attests ? { attests } : {}),
      }),
    );
  }

  /**
   * A pushed branch's story confirmed again at an accepted repair's version,
   * where its change joins a batch of the person's own (docs/forge.md,
   * "Batches of your own"): as `refreshConflictOnly` republishes a pull
   * request's story, a new revision with the same words and the content its
   * merge card approved, naming the revision its author confirmed. Called
   * only on a host-accepted repair lineage (`repairedFrom` names its heads);
   * a newer revision its author prepared stays theirs, and nothing happens.
   */
  async confirmRepairedBranch(
    taskId: string,
    branch: string,
    repairedFrom: (head: string) => boolean,
    toHead: string,
    forge: Forge,
  ): Promise<void> {
    await this.serial(taskId, async () => {
      const record = this.options.tasks.delivery.changePresentation(taskId, branch);
      if (!record || record.published || record.publication) return;
      // Unpublished, the story's binding is the one confirmed on the pushed branch.
      const ready = readyPresentation(record) && record.completion;
      const story = record.revisions.at(-1);
      if (!ready || !story || ready.head === toHead || !repairedFrom(ready.head)) return;
      if (!hostedPresentation(story.destination)) return;
      const refreshed = await this.atWidenedAudience(
        atVersion(
          story,
          toHead,
          `The accepted repair from ${ready.head} to ${toHead} leaves this view unchanged.`,
        ),
        forge,
      );
      await this.validateCurrent(refreshed, forge, branch, true);
      await this.save(taskId, branch, (kept) => ({
        ...this.required(kept),
        revisions: [...this.required(kept).revisions, refreshed],
        completion: {
          revision: refreshed.revision,
          head: toHead,
          contentHash: ready.contentHash,
          refreshOf: ready.refreshOf ?? story.revision,
        },
      }));
    });
  }

  /**
   * A pull request that moved past its published story, read at the merge
   * (INF-2509): the story is republished at the pull request's version, its
   * words unchanged. The pushed branch is the version merged, wherever its
   * commits were made.
   */
  async republishMoved(
    taskId: string,
    change: ForgeChange,
    forge: Forge,
    attests?: (head: string) => boolean,
  ): Promise<void> {
    await this.serial(taskId, () =>
      this.republishLocked(taskId, change.headSha, forge, change.branch, change.title ?? "", {
        remoteOnly: true,
        checks: "passed",
        ...(attests ? { attests } : {}),
      }),
    );
  }

  /**
   * The revision a completion card shows (INF-2509, INF-1868's answer 5):
   * the one the author named, or, once the pull request moved past it, the
   * host's republication of it at the pushed version. The author vouches for
   * the story at the code they committed, so that code must be the pushed
   * version. Any other mismatch is left for the completion's own refusal.
   */
  async atPushedVersion(
    taskId: string,
    revision: number,
    change: ForgeChange,
    forge: Forge,
    attests?: (head: string) => boolean,
  ): Promise<number> {
    return this.serial(taskId, async () => {
      const record = this.ledger(taskId, change.branch, change.number);
      const published = record.published;
      const newest = record.revisions.at(-1);
      if (
        !published ||
        !newest ||
        !hostedPresentation(newest.destination) ||
        published.revision !== newest.revision ||
        (published.revision !== revision && published.refreshOf !== revision)
      )
        return revision;
      if (published.head === change.headSha) return published.revision;
      const committed = await this.options.head(taskId);
      if (committed !== change.headSha)
        throw new Error(
          `${pushFirst(committed, change.headSha)} Then show the merge card again with presentation ${revision}.`,
        );
      return (
        (await this.republishLocked(
          taskId,
          change.headSha,
          forge,
          change.branch,
          change.title ?? "",
          { remoteOnly: false, checks: "pending", ...(attests ? { attests } : {}) },
        )) ?? revision
      );
    });
  }

  /**
   * The published story again at `toHead`, its words and the content its
   * completion offer approved unchanged, as a new revision that names the
   * one its author published. Only the newest story is republished: a newer
   * revision the author prepared is theirs to publish, and nothing happens.
   * An accepted repair names where it starts; a newer revision stays its
   * author's there too, since approval follows the code (INF-3623).
   * Answers the revision now published, if any.
   */
  private async republishLocked(
    taskId: string,
    toHead: string,
    forge: Forge,
    branch: string,
    title: string,
    how: {
      fromHead?: string;
      remoteOnly: boolean;
      /** What an older story's description says of the checks: a merge runs after they passed. */
      checks: "pending" | "passed";
      attests?: (head: string) => boolean;
    },
  ): Promise<number | undefined> {
    const record = this.ledger(taskId, branch);
    const published = record.revisions.find(
      (story) => story.revision === record.published?.revision,
    );
    if (!published || !hostedPresentation(published.destination)) return undefined;
    if (published.head === toHead) return published.revision;
    if (how.fromHead !== undefined && published.head !== how.fromHead)
      throw new Error("The repair does not start from the published story.");
    const latest = record.revisions.at(-1) as ChangePresentation;
    const applicability =
      how.fromHead !== undefined
        ? `The accepted repair from ${how.fromHead} to ${toHead} leaves this view unchanged.`
        : "Captured on an earlier version of this pull request; the story's words did not change.";
    const refreshed = atVersion(published, toHead, applicability);
    if (
      latest.revision !== published.revision &&
      JSON.stringify(latest) !== JSON.stringify(refreshed)
    )
      return undefined;
    if (latest.revision === published.revision)
      await this.save(taskId, branch, (old) => ({
        ...this.required(old),
        revisions: [...this.required(old).revisions, refreshed],
      }));
    await this.publishLocked(
      taskId,
      refreshed.revision,
      forge,
      branch,
      published.version === 2 ? published.title : title,
      how.checks,
      undefined,
      how.remoteOnly,
      {
        contentHash: record.published?.contentHash ?? presentationContentHash(published),
        refreshOf: record.published?.refreshOf ?? published.revision,
      },
      undefined,
      how.attests ? { attests: how.attests } : undefined,
    );
    return refreshed.revision;
  }

  private current(taskId: string, branch: string, revision: number): ChangePresentation {
    const story = this.ledger(taskId, branch).revisions.at(-1);
    // INF-3717 piece 1: the refusal names the branch it read and that
    // branch's newest revision, so a crewmate sees which change it met.
    if (!story || story.revision !== revision)
      throw new Error(
        `Use the newest prepared story revision: ${story ? `the newest for ${branch} is revision ${story.revision}, not ${revision}` : `${branch} has no prepared story`}.`,
      );
    return changePresentationSchema.parse(story);
  }
  /** The story ledger of the change on `branch`; undefined names the task's current change. */
  private ledger(
    taskId: string,
    branch: string | undefined,
    number?: number,
  ): ChangePresentationRecord {
    return this.required(this.options.tasks.delivery.changePresentation(taskId, branch, number));
  }
  private required(record: ChangePresentationRecord | undefined): ChangePresentationRecord {
    if (!record) throw new Error("Prepare the change story before opening its pull request.");
    return record;
  }
  private nativeAssets(story: ChangePresentation): PresentationAsset[] {
    if (!nativePresentationMedia(story.destination)) return [];
    const ids = new Set(
      story.views.flatMap((view) => [...view.before, ...view.after].map((entry) => entry.asset)),
    );
    return story.assets.filter((asset) => ids.has(asset.id));
  }
  private receipt(
    story: ChangePresentation,
    branch: string,
    asset: PresentationAsset,
    number?: number,
  ): PresentationReceipt | undefined {
    return this.ledger(story.taskId, branch, number).receipts.find((receipt) =>
      receiptMatches(story, asset, receipt),
    );
  }
  private keepReceipt(story: ChangePresentation, branch: string, next: PresentationReceipt): void {
    this.options.tasks.delivery.updateChangePresentation(
      story.taskId,
      (record) => ({
        ...this.required(record),
        receipts: [
          ...this.required(record).receipts.filter(
            (receipt) =>
              !(
                receipt.digest === next.digest &&
                receipt.mediaType === next.mediaType &&
                sameAttachmentDestination(receipt.destination, next.destination)
              ),
          ),
          next,
        ],
      }),
      branch,
    );
  }
  /**
   * An approved story whose project only became readable by more people
   * since it was saved, bound to the audience read now: its words were
   * written for a stranger, so they carry into the wider audience, and its
   * files upload again under receipts for that audience. Any other change
   * keeps the saved destination, so the publication check still refuses it.
   */
  private async atWidenedAudience(
    story: ChangePresentation,
    forge: Forge,
  ): Promise<ChangePresentation> {
    const current = await storyDestination(forge);
    return widenedAudience(story.destination, current)
      ? changePresentationSchema.parse({ ...story, destination: current })
      : story;
  }
  private async validateCurrent(
    story: ChangePresentation,
    forge: Forge,
    branch: string,
    remoteOnly = false,
  ): Promise<void> {
    await this.validatePrepared(story, forge, remoteOnly);
    if (!forge.branchHead || (await forge.branchHead(branch)) !== story.head)
      throw new Error(
        "The pushed code does not match this story. Push the reviewed version first.",
      );
  }
  private async validatePrepared(
    story: ChangePresentation,
    forge: Forge,
    remoteOnly: boolean,
  ): Promise<void> {
    if (!remoteOnly && (await this.options.head(story.taskId)) !== story.head)
      throw new Error("The code changed after this story was prepared.");
    if (!samePresentationDestination(story.destination, await storyDestination(forge)))
      throw new Error("The publication destination or audience changed.");
    await this.checkRetained(story);
  }
  private async checkRetained(story: ChangePresentation): Promise<void> {
    for (const asset of story.assets) await this.readAsset(story, asset);
    const ids = new Set(story.assets.map((asset) => asset.id));
    if (ids.size !== story.assets.length)
      throw new Error("Duplicate retained attachment identities.");
    for (const view of story.views)
      for (const media of [...view.before, ...view.after]) {
        if (!ids.has(media.asset) || (media.poster && !ids.has(media.poster)))
          throw new Error("Missing retained attachment identity.");
      }
  }
  private async readAsset(
    story: ChangePresentation,
    asset: PresentationAsset,
  ): Promise<Uint8Array> {
    const dir = this.options.mediaDir(story.taskId);
    if (!asset.id.startsWith(`${story.taskId}-`))
      throw new Error("The retained media belongs to another task.");
    // A lost copy comes back from an identical one, or the refusal says what to do (INF-3672).
    if (
      !restoreKeptCopy(dir, asset.file, {
        taskId: story.taskId,
        sha256: asset.uploadSha256,
        bytes: asset.bytes,
      })
    )
      throw new Error(missingMediaWords(story, asset));
    const root = await realpath(dir);
    const file = await realpath(join(root, asset.file));
    if (relative(root, file) !== asset.file)
      throw new Error("The retained media escaped its task folder.");
    const bytes = await readFile(file);
    if (bytes.length !== asset.bytes || hash(bytes) !== asset.uploadSha256)
      throw new Error("The retained media changed after inspection.");
    return bytes;
  }
  private async serial<T>(
    taskId: string,
    run: () => Promise<T>,
    staged: PresentationAsset[] = [],
  ): Promise<T> {
    if (this.active.has(taskId))
      throw new Error("A story operation is already in progress for this task.");
    this.active.set(taskId, new Set(staged.map((asset) => asset.file)));
    try {
      return await run();
    } finally {
      this.active.delete(taskId);
    }
  }
}

/**
 * The way to a refused completion card, said from the ledger's typed facts
 * (INF-961): a crewmate refused without these words took its story as lost
 * (INF-899). A published story follows a later push on its own (INF-2509);
 * a story its author prepared and never published does not.
 */
function completionWayOut(
  record: ChangePresentationRecord,
  newest: ChangePresentation,
  head: string,
): string {
  const published = record.published?.revision === newest.revision;
  // INF-2509: a published story follows its pull request's later versions on its own.
  if (published && record.published?.head !== head)
    return `Story revision ${newest.revision} was published at ${record.published?.head}, and the pushed branch is now at ${head}: show the merge card with presentation ${newest.revision}, and the app republishes it at the pushed version.`;
  if (newest.head !== head)
    return `Story revision ${newest.revision} was prepared at ${newest.head} and never published, and the pushed branch is now at ${head}. Prepare a new story revision at the pushed version with prepare_change, keeping its base and title, publish it with open_change, then show the merge card with the revision prepare_change returns as presentation.`;
  if (!published || record.publication?.state !== "confirmed")
    return `Story revision ${newest.revision} is prepared at the pushed version but not yet published and read back: publish it with open_change, then show the merge card with presentation ${newest.revision}.`;
  return `The newest story is revision ${newest.revision}: show the merge card with presentation ${newest.revision}.`;
}

/**
 * Two revisions saying the same thing (show_merge_card): every field but the
 * revision, with each picture named by its bytes rather than the copy's
 * minted name, so staging the same files again reads as the same story.
 */
function sameStoryWords(saved: ChangePresentation, next: ChangePresentation): boolean {
  const canonical = (story: ChangePresentation): string => {
    const names = new Map(story.assets.map((asset) => [asset.id, asset.uploadSha256]));
    // A free-form part names its pictures inside its HTML, so every name is replaced.
    const named = (value: string): string => {
      let text = value;
      for (const [id, digest] of names) text = text.replaceAll(id, digest);
      return text;
    };
    const walk = (value: unknown): unknown => {
      if (typeof value === "string") return named(value);
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value)
            .filter(([, item]) => item !== undefined)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, walk(item)]),
        );
      return value;
    };
    const { revision: _revision, ...words } = story;
    return JSON.stringify(walk(words));
  };
  return canonical(saved) === canonical(next);
}

/** The refusal when the committed code is ahead of the pushed branch. */
function pushFirst(committed: string, pushed: string): string {
  return `The current code changed before the merge card: the branch is at ${committed}, and the pushed branch at ${pushed}. Push it; the app republishes the published story at the pushed version.`;
}

/**
 * A story again at a later version of its change, its words unchanged, as the
 * next revision: After media that declares no applicability gets `applicability`.
 */
function atVersion(
  story: ChangePresentation,
  toHead: string,
  applicability: string,
): ChangePresentation {
  return changePresentationSchema.parse({
    ...story,
    revision: story.revision + 1,
    head: toHead,
    views: story.views.map((view) => ({
      ...view,
      after: view.after.map((media) => ({
        ...media,
        applicability: media.applicability ?? applicability,
      })),
    })),
  });
}

/**
 * The revision a named one stands for now (INF-2509): itself while it is the
 * newest, or the host's republication of it at a later version, on a pull
 * request or confirmed again on a pushed branch.
 */
function shownRevision(record: ChangePresentationRecord, revision: number): number | undefined {
  const newest = record.revisions.at(-1);
  if (!newest) return undefined;
  if (newest.revision === revision) return revision;
  const refreshed = record.published ?? record.completion;
  return refreshed?.revision === newest.revision && refreshed.refreshOf === revision
    ? newest.revision
    : undefined;
}

function receiptMatches(
  story: ChangePresentation,
  asset: PresentationAsset,
  receipt: PresentationReceipt,
): boolean {
  return (
    hostedPresentation(story.destination) &&
    receipt.digest === asset.uploadSha256 &&
    receipt.mediaType === asset.mediaType &&
    sameAttachmentDestination(receipt.destination, story.destination)
  );
}
