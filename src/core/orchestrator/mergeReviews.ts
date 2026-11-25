import type { CheckChangeInput } from "@shared/checkRepair";
import { checkSnapshotSummary } from "@shared/checkSnapshot";
import { CONTRIBUTION_MERGE_REFUSAL } from "@shared/contributions";
import { contributorDisclosureLine } from "@shared/contributorDisclosure";
import { changeNumberLabel, forgeOf, hasChangeRequests } from "@shared/forge";
import { changePageUrl } from "@shared/forgeKinds";
import { fixedHoldWords, overridePasses } from "@shared/holds";
import type { AbsentChecksDeclaration, MergeReview } from "@shared/mergeReview";
import { NEVER_SENT_AGAIN } from "@shared/writeAsk";
import {
  type Forge,
  ForgeBaseMoved,
  type ForgeChange,
  ForgeError,
  ForgeMergeUnconfirmed,
  type ForgePull,
  forkStoryForge,
  isForkReview,
  isSignInForgeFailure,
  isTransientForgeFailure,
} from "../forge";
import { wayToSend } from "../forge/mergeWays";
import { requireNamed } from "../workspace/naming";
import type { ChangeChecks } from "./changeChecks";
import {
  type ChangeContext,
  type ChangeDeliveryOptions,
  crewSignInText,
  type Located,
  numberLabel,
  projectOf,
  reviewOf,
} from "./changeContext";
import {
  atDispatch,
  branchInProject,
  type ChangeMerge,
  hostQueued,
  MERGE_RETRY_DELAYS_MS,
  type MergeAttempt,
  type MergeGuard,
  type MergeStop,
  MergeWithdrawn,
  otherMerged,
  otherMergedFacts,
  type PrOutcome,
  readDecided,
  readinessStop,
  sleep,
  stripAttempt,
  UNDECIDED_REREAD_MS,
} from "./changeMerge";
import { MERGE_CHECKS_HOLD_REASON, standingAuthorization } from "./mergeAuthorization";
import { taskContributesUpstream } from "./workShape";

/**
 * What naming a pull request does, in the answer that names it (INF-2490):
 * it becomes the task's current change, and the card that merges it says
 * whether the task closes.
 */
const SELECTED_CHANGE_WORDS =
  "It is now this task's current change: check_change reads it until you name another or open_change opens one. Your merge card merges it, with after saying whether the task continues or closes. A saved-story card gives presentation and omits review, because this is the current change; otherwise name this review in the merge effect.";

type Reread =
  | { ok: true; forge: Forge; pull: ForgePull }
  | { ok: false; text: string; stop?: MergeStop };

/**
 * Merge reviews (`docs/forge.md`, "A requested merge"): a pull request the
 * crew names by its number, kept on the task at the version read, shown on
 * a merge card and merged once on the captain's click - an ordinary
 * one, or one past the branch rules.
 */
export class MergeReviews {
  private readonly options: ChangeDeliveryOptions;

  constructor(
    private readonly context: ChangeContext,
    private readonly checks: ChangeChecks,
    private readonly merges: ChangeMerge,
  ) {
    this.options = context.options;
  }

  /**
   * Prepare a merge review of pull request `number` in the task's project.
   * The answer names the review id. Nothing is merged.
   */
  async prepareReview(
    taskId: string,
    number: number,
    absent: CheckChangeInput["absentChecks"],
    within?: { repoId?: string },
  ): Promise<string> {
    if (!Number.isInteger(number) || number < 1) {
      return "Merge review refused: pull must be the pull request's number.";
    }
    // The number is read in the task's own project, or in the other managed
    // project the current change is in when it names that change (INF-2510).
    const target = this.options.tasks.get(taskId.trim())?.delivery?.checkTarget;
    const located = this.context.locate(
      taskId,
      "check",
      within ?? (target?.repoId && target.number === number ? target : "new-request"),
    );
    if ("said" in located) return located.said;
    const { record, forge } = located;
    const origin = forgeOf(located.repo?.origin);
    if (!origin.owner || !origin.name || !origin.host) {
      return "Merge review refused: this project has no pull requests where it lives.";
    }
    if (!forge.pull) {
      return "Merge review refused: where this project lives has no pull requests to read.";
    }
    const read = await this.openPull(located, number, `${origin.owner}/${origin.name}`);
    if ("said" in read) return read.said;
    const { pull, branch } = read;
    let absentChecks: AbsentChecksDeclaration | undefined;
    if (absent) {
      const evidence = absent.evidence.trim();
      const localGate = absent.localGate.trim();
      if (!evidence || !localGate || absent.headSha !== pull.headSha) {
        return "Merge review refused: an absence declaration must name this pull request's current version, the workflow and changed-file evidence, and the local gate run at that version.";
      }
      absentChecks = { headSha: pull.headSha, evidence, localGate };
    }
    const review = reviewOf(
      forge,
      { host: origin.host, owner: origin.owner, name: origin.name },
      { ...pull, branch },
      this.context.now(),
      {
        ...(located.elsewhere && located.repo ? { repoId: located.repo.id } : {}),
        ...(absentChecks ? { absentChecks } : {}),
      },
    );
    this.context.select(record, review, pull.url ?? null);
    const checks = await this.checks.run(taskId, "crewmate");
    const where = forge.place ?? "where the project lives";
    return [
      checks.text,
      `Merge review ${review.id} for ${changeNumberLabel(forge.kind, number)} at ${pull.headSha} into ${pull.base} on ${where}.`,
      SELECTED_CHANGE_WORDS,
      ...(isForkReview(review)
        ? [
            "This change comes from a contributor's fork. Read its code before running it. Check out the reviewed commit unchanged, then prepare_change and open_change with presentation to publish the crew's story in a comment and the merged commit, keeping the contributor's description.",
            "Offer this contributor change with asks_first on its merge effect: the captain's click authorizes merging this version. A later push needs a new review and a new click.",
          ]
        : []),
      "This request grants no approval and does not itself merge anything. With autonomy off, only the captain's merge button authorizes execution.",
      absentChecks
        ? "Absence evidence stored for this version. A merge offer expresses the crew's judgment; this evidence grants no merge permission."
        : this.checks.projectRunsNoChecks(projectOf(located))
          ? "No absence declaration stored for this version; none is needed while the project is recorded as running no checks."
          : "No absence declaration stored. An empty hosted reading alone does not establish that checks are absent.",
    ].join("\n");
  }

  /**
   * Prepare a merge past the branch rules (FI3-1571 piece 2): GitHub only,
   * squash only, at the version the crewmate read. It is stored only when
   * something holds the pull request - a rule, or a failed check - and
   * GitHub says this sign-in may skip every rule set holding the default
   * branch. The review names each rule and failed check; nothing is merged.
   */
  async prepareSkipReview(
    taskId: string,
    number: number,
    skip: NonNullable<CheckChangeInput["skipRules"]>,
  ): Promise<string> {
    if (!Number.isInteger(number) || number < 1) {
      return "Merge review refused: pull must be the pull request's number.";
    }
    if (skip.method !== "squash") {
      return "Merge review refused: a merge that skips the branch rules uses squash only.";
    }
    const located = this.context.locate(taskId, "check", "new-request");
    if ("said" in located) return located.said;
    const { record, forge } = located;
    const origin = forgeOf(located.repo?.origin);
    if (
      forge.kind !== "github" ||
      !forge.pull ||
      !forge.branchRules ||
      !forge.putInSkippingRules ||
      !origin.owner ||
      !origin.name ||
      !origin.host
    ) {
      return "Merge review refused: a merge that skips the branch rules is available on GitHub, including GitHub Enterprise, only.";
    }
    const opened = await this.openPull(
      located,
      number,
      `${origin.owner}/${origin.name}`,
      skip.headSha,
    );
    if ("said" in opened) return opened.said;
    const { pull, branch } = opened;
    const read = await this.merges.skipState(taskId, forge, pull, projectOf(located));
    if (!read.ok) return `Merge review refused: ${read.text}`;
    const { rules, failedChecks } = read;
    if (pull.readiness === "clean" && failedChecks.length === 0) {
      return `Merge review refused: nothing holds pull request ${number}: GitHub reports no rule or terminal failure to skip. Prepare an ordinary review with pull alone.`;
    }
    const review = reviewOf(
      forge,
      { host: origin.host, owner: origin.owner, name: origin.name },
      { ...pull, branch },
      this.context.now(),
      { skips: { rules, failedChecks } },
    );
    this.context.select(record, review, pull.url ?? null);
    const checks = await this.checks.run(taskId, "crewmate");
    const where = forge.place ?? "GitHub";
    return [
      checks.text,
      `Merge review ${review.id} for #${number} at ${pull.headSha} into ${pull.base} on ${where}, skipping the branch rules.`,
      "Your merge card merges it, its review naming this review.",
      rules.length
        ? `It may skip these rules, each of which ${where} says your sign-in may skip: ${rules.map((rule) => `${rule.rule} (${rule.ruleset})`).join("; ")}.`
        : "No branch rule holds it.",
      failedChecks.length
        ? `It merges with these checks failed: ${failedChecks.join(", ")}.`
        : "No terminal check failures were reported.",
      "The merge card names this review; the app names each rule and failed check on the card. Only the captain's click on that card sends it, once, at this version; the who-merges setting and every other path never do. A new version needs a new review.",
    ].join("\n");
  }

  /**
   * Pull request `number` read for a new review: open, naming its branch,
   * version and destination, at `head` when the crew named one, and a
   * branch in `project` itself. Otherwise the refusal.
   */
  private async openPull(
    located: Located,
    number: number,
    project: string,
    head?: string,
  ): Promise<{ pull: ForgePull; branch: string } | { said: string }> {
    const { forge } = located;
    let pull: ForgePull;
    try {
      pull = await (forge.pull as NonNullable<Forge["pull"]>)(number);
    } catch (caught) {
      if (isSignInForgeFailure(caught))
        return {
          said: crewSignInText(
            this.context.signInFact(forge, located.repo?.id ?? located.record.repoId),
          ),
        };
      const message = caught instanceof Error ? caught.message : String(caught);
      return { said: `Merge review refused: could not read pull request ${number}. ${message}` };
    }
    if (pull.number !== number || pull.state !== "open" || pull.merged) {
      return { said: `Merge review refused: pull request ${number} is not open.` };
    }
    if (!pull.branch || !pull.headSha || !pull.base) {
      return {
        said: `Merge review refused: pull request ${number} did not name its branch, version and destination.`,
      };
    }
    if (head !== undefined && pull.headSha !== head) {
      return {
        said: `Merge review refused: pull request ${number} is at ${pull.headSha}, not the version you named (${head}). Read it again and prepare the review at the version you mean.`,
      };
    }
    if (head !== undefined && !branchInProject(pull, project)) {
      return {
        said: `Merge review refused: pull request ${number} is not a branch in ${project}. Forks are out of scope for a merge past the branch rules.`,
      };
    }
    if (!pull.headRepo) {
      return {
        said: `Merge review refused: pull request ${number} did not name its source repository.`,
      };
    }
    return { pull, branch: pull.branch };
  }

  /**
   * Whether a stored review may be shown to the captain now. Undefined when
   * it may; otherwise the refusal. Does not merge.
   */
  async reviewGate(taskId: string, reviewId: string): Promise<string | undefined> {
    const record = this.options.tasks.get(taskId);
    if (
      taskContributesUpstream(
        record,
        record?.repoId ? this.options.repos.get(record.repoId) : undefined,
      )
    )
      return CONTRIBUTION_MERGE_REFUSAL;
    const review = record?.delivery?.mergeReviews?.find((item) => item.id === reviewId);
    if (!review) return `Card refused: merge review ${reviewId} is not on this task.`;
    if (review.skips) {
      // Marked sent before the send, so a merged one is sent too.
      if (review.sent) {
        return `Card refused: that merge was already sent once and is ${NEVER_SENT_AGAIN}. Prepare a new review to ask again. ${fixedHoldWords("sent-once")}`;
      }
      const fresh = await this.readSkipTarget(taskId, review);
      return fresh.ok ? undefined : `Card refused: ${fresh.text}`;
    }
    const fresh = await this.readReviewTarget(taskId, review);
    if (!fresh.ok) {
      return fresh.text === "already-merged"
        ? "Card refused: that pull request is already merged."
        : `Card refused: ${fresh.text}`;
    }
    return undefined;
  }

  /**
   * Merge the stored review after the captain's click: the pull request it
   * names, whoever opened it, read again by its number at the reviewed
   * version with the same identity, check and readiness gates. Whether the
   * task closes is the caller's (`SettleService.requestMerge`).
   */
  async mergeReview(taskId: string, reviewId: string, guard?: MergeGuard): Promise<PrOutcome> {
    const record = this.options.tasks.get(taskId);
    if (
      taskContributesUpstream(
        record,
        record?.repoId ? this.options.repos.get(record.repoId) : undefined,
      )
    )
      return { ok: false, text: CONTRIBUTION_MERGE_REFUSAL };
    const approved = guard ? standingAuthorization(record?.delivery)?.review : undefined;
    const review =
      approved?.id === reviewId
        ? approved
        : record?.delivery?.mergeReviews?.find((item) => item.id === reviewId);
    if (!record || !review) {
      return { ok: false, text: `Cannot merge: merge review ${reviewId} is not on this task.` };
    }
    if (review.receipt) {
      return {
        ok: true,
        text: `Pull request #${review.number} was already merged at ${review.receipt.head}.`,
        receipt: {
          head: review.receipt.head,
          ...(review.receipt.sha ? { sha: review.receipt.sha } : {}),
          already: true,
        },
      };
    }
    if (review.skips) return this.mergeSkippingRules(taskId, review, guard);
    // A merge GitHub refused because the main branch moved is tried again
    // as the task's own merge is (`ChangeMerge.merge`): each try reads the
    // pull request until GitHub decides, and sends only where it may merge.
    let attempt = await this.mergeNamed(taskId, review, guard);
    for (const delay of MERGE_RETRY_DELAYS_MS) {
      if (!attempt.baseMoved) break;
      await sleep(delay);
      attempt = await this.mergeNamed(taskId, review, guard, true);
    }
    return this.merges.withSkip(taskId, guard, stripAttempt(attempt), review);
  }

  /**
   * The merge a review made, stored on it at the head it merged; answers the
   * receipt. Every route a review merges by ends here.
   */
  private storeReviewReceipt(
    taskId: string,
    reviewId: string,
    head: string,
    sha?: string,
    by?: "captain",
  ): { head: string; sha?: string } {
    const receipt = { head, ...(sha ? { sha } : {}) };
    const record = this.options.tasks.get(taskId);
    const reviews = record?.delivery?.mergeReviews;
    if (!reviews) return receipt;
    this.options.tasks.delivery.recordPermissionRecords(taskId, {
      mergeReviews: reviews.map((item) =>
        item.id === reviewId
          ? {
              ...item,
              receipt: {
                head: receipt.head,
                ...(receipt.sha ? { sha: receipt.sha } : {}),
                at: this.context.now(),
                ...(by ? { by } : {}),
              },
            }
          : item,
      ),
    });
    return receipt;
  }

  /**
   * Re-read a merge past the rules before its card goes up and before the
   * click sends it: the same pull request at the reviewed version, and
   * nothing it would skip that the review did not name.
   */
  private async readSkipTarget(taskId: string, review: MergeReview): Promise<Reread> {
    const located = this.context.locate(taskId, "check", review);
    if ("said" in located) return { ok: false, text: located.said };
    const { forge } = located;
    if (forge.kind !== "github" || !forge.pull || !forge.putInSkippingRules) {
      return { ok: false, text: "this host cannot merge past its branch rules." };
    }
    const read = forge.pull.bind(forge);
    const reread = await this.reread(review, async () => ({
      pull: await read(review.number),
      waited: 0,
    }));
    if (!reread.ok) return reread;
    const { pull } = reread;
    const state = await this.merges.skipState(taskId, forge, pull, projectOf(located));
    if (!state.ok) return state;
    const named = new Set(
      (review.skips?.rules ?? []).map((rule) => `${rule.ruleset}\u0000${rule.rule}`),
    );
    const newRule = state.rules.find((rule) => !named.has(`${rule.ruleset}\u0000${rule.rule}`));
    if (newRule) {
      return {
        ok: false,
        text: `it would now also skip ${newRule.rule} (${newRule.ruleset}), which the review did not name. Nothing merged. Prepare a new review.`,
        stop: "protected",
      };
    }
    const failed = new Set(review.skips?.failedChecks ?? []);
    const newFailure = state.failedChecks.find((name) => !failed.has(name));
    if (newFailure) {
      return {
        ok: false,
        text: `the check ${newFailure} failed after the review, which did not name it. Nothing merged. Prepare a new review.`,
        stop: "checks",
      };
    }
    return { ok: true, forge, pull };
  }

  /**
   * A review's pull request read again by its number (`read`): still the
   * one reviewed, open, and at the reviewed version. Otherwise why not, with
   * `already-merged` for one merged since.
   */
  private async reread(
    review: MergeReview,
    read: () => Promise<{ pull: ForgePull; waited: number }>,
  ): Promise<
    { ok: true; pull: ForgePull; waited: number } | { ok: false; text: string; stop?: MergeStop }
  > {
    let pull: ForgePull;
    let waited = 0;
    try {
      ({ pull, waited } = await read());
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      return {
        ok: false,
        text: `the pull request could not be read. ${message}`,
        stop: isSignInForgeFailure(caught)
          ? "sign-in"
          : isTransientForgeFailure(caught)
            ? "transient"
            : undefined,
      };
    }
    const project = `${review.owner}/${review.name}`;
    if (
      pull.number !== review.number ||
      pull.base !== review.base ||
      pull.branch !== review.branch ||
      !pull.headRepo ||
      pull.headRepo.toLowerCase() !== (review.headRepo ?? project).toLowerCase() ||
      (review.headRepoId !== undefined && pull.headRepoId !== review.headRepoId)
    ) {
      return {
        ok: false,
        text: "the pull request is not the one that was reviewed.",
        stop: "identity",
      };
    }
    if (pull.merged) return { ok: false, text: "already-merged", stop: "outcome" };
    if (pull.state !== "open") {
      return { ok: false, text: "the pull request was closed without merging.", stop: "closed" };
    }
    if (pull.headSha !== review.headSha) {
      return {
        ok: false,
        text: `the pull request is at ${pull.headSha}, and the review covers ${review.headSha}. Nothing merged. A new version needs a new review and a new click.`,
        stop: "moved",
      };
    }
    return { ok: true, pull, waited };
  }

  /**
   * The captain's click on a merge past the rules: re-read it, mark it
   * sent, then send it once. A result the app cannot read is unknown and is
   * never sent again; a confirmed merge keeps its receipt like any review.
   */
  private async mergeSkippingRules(
    taskId: string,
    review: MergeReview,
    _guard?: MergeGuard,
  ): Promise<PrOutcome> {
    const label = `#${review.number}`;
    if (review.sent) {
      return {
        ok: false,
        text:
          review.sent.outcome === "failed"
            ? `Cannot merge: that merge was sent once and GitHub did not merge it${review.sent.text ? ` (${review.sent.text})` : ""}. Nothing was sent again; prepare a new review to ask again. ${fixedHoldWords("sent-once")}`
            : `Cannot merge: that merge was already sent once and its outcome is unknown${review.sent.text ? ` (${review.sent.text})` : ""}. Nothing was sent again; read pull request ${label} to see whether it merged. ${fixedHoldWords("sent-once")}`,
        stop: "outcome",
      };
    }
    const fresh = await this.readSkipTarget(taskId, review);
    if (!fresh.ok) {
      if (fresh.text === "already-merged") {
        const located = this.context.locate(taskId, "check", review);
        const pull =
          "said" in located
            ? undefined
            : await located.forge.pull?.(review.number).catch(() => undefined);
        if (pull?.merged) {
          const receipt = this.storeReviewReceipt(
            taskId,
            review.id,
            review.headSha,
            pull.mergedSha,
          );
          return {
            ok: true,
            text: `${label} is already merged on GitHub.`,
            receipt: { ...receipt, already: true },
          };
        }
      }
      return {
        ok: false,
        text: `Cannot merge: ${fresh.text}`,
        ...(fresh.stop ? { stop: fresh.stop } : {}),
      };
    }
    const { forge, pull } = fresh;
    const place = forge.place ?? "GitHub";
    let change: ForgeChange = {
      number: pull.number,
      url: null,
      branch: pull.branch ?? review.branch,
      headSha: pull.headSha,
      title: pull.title ?? review.title,
      body: "",
    };
    try {
      requireNamed(change.title ?? "", "pull request title", this.options.namingRule?.() ?? null);
      const storied = await this.merges.withPublishedStory(taskId, forge, change);
      if ("held" in storied) return { ok: false, stop: "guidance", text: storied.held };
      change = storied.change;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      return { ok: false, text: `Cannot merge: ${message}`, problem: message };
    }
    // Marked before the send: whatever happens next, it is never sent twice.
    this.markSkipSent(taskId, review.id, {});
    const confirmed = (sha?: string): PrOutcome => ({
      ok: true,
      text: `Merged ${label} on ${place}, skipping the branch rules.`,
      receipt: this.storeReviewReceipt(taskId, review.id, review.headSha, sha, "captain"),
    });
    const unknown = async (why: string): Promise<PrOutcome> => {
      const after = await forge.pull?.(review.number).catch(() => undefined);
      if (after?.merged && after.headSha === review.headSha) return confirmed(after.mergedSha);
      this.markSkipSent(taskId, review.id, { outcome: "unknown", text: why });
      return {
        ok: false,
        text: `The merge of ${label} was sent once, and its outcome is unknown: ${why}. It is not sent again; read pull request ${label} to see whether it merged.`,
        problem: why,
        stop: "outcome",
      };
    };
    try {
      const result = await (forge.putInSkippingRules as NonNullable<Forge["putInSkippingRules"]>)(
        change,
        review.headSha,
      );
      if (result.status === "merged") return confirmed(result.sha);
      if (result.status === "unknown") return unknown(result.message);
      this.markSkipSent(taskId, review.id, { outcome: "failed", text: result.message });
      return {
        ok: false,
        text: `Cannot merge: ${place} did not merge ${label}: ${result.message}. Nothing merged, and it is not sent again.`,
        problem: result.message,
      };
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      // A transport failure may have reached the host; any answer it gave did not merge.
      if (isTransientForgeFailure(caught)) return unknown(message);
      this.markSkipSent(taskId, review.id, { outcome: "failed", text: message });
      return {
        ok: false,
        text: `Cannot merge: ${message}. Nothing merged, and it is not sent again.`,
        problem: message,
        ...(isSignInForgeFailure(caught) ? { stop: "sign-in" as const } : {}),
      };
    }
  }

  /** A merge past the rules was sent, or its outcome is known: stored before and after the send. */
  private markSkipSent(
    taskId: string,
    reviewId: string,
    outcome: { outcome?: "failed" | "unknown"; text?: string },
  ): void {
    const reviews = this.options.tasks.get(taskId)?.delivery?.mergeReviews;
    if (!reviews) return;
    this.options.tasks.delivery.recordPermissionRecords(taskId, {
      mergeReviews: reviews.map((item) =>
        item.id === reviewId
          ? { ...item, sent: { at: item.sent?.at ?? this.context.now(), ...outcome } }
          : item,
      ),
    });
  }

  /**
   * Re-read a review's pull request. `ok` means it still matches and may
   * merge. At the captain's click, or before a merge GitHub refused because
   * the main branch moved is sent again (`click`), a pull request GitHub has
   * not decided on yet is read again until it decides (`readDecided`).
   */
  private async readReviewTarget(
    taskId: string,
    review: MergeReview,
    click = false,
  ): Promise<Reread> {
    // The review's own project: the task's, or the one open_change opened it in (INF-2510).
    const located = this.context.locate(taskId, "check", review);
    if ("said" in located)
      return located.stop === "identity"
        ? { ok: false, text: "where the reviewed pull request lives changed.", stop: "identity" }
        : { ok: false, text: located.said };
    const { forge } = located;
    const origin = forgeOf(located.repo?.origin);
    if (
      origin.host !== review.host ||
      origin.owner !== review.owner ||
      origin.name !== review.name
    ) {
      return {
        ok: false,
        text: "where the reviewed pull request lives changed.",
        stop: "identity",
      };
    }
    if (!forge.pull) {
      return { ok: false, text: "this host cannot read a pull request by its number." };
    }
    const read = forge.pull.bind(forge);
    const reread = await this.reread(review, () =>
      readDecided(() => read(review.number), review.headSha, click ? UNDECIDED_REREAD_MS : []),
    );
    if (!reread.ok) return reread;
    const { pull, waited } = reread;
    const change: ForgeChange = {
      number: pull.number,
      url: null,
      branch: pull.branch ?? review.branch,
      headSha: pull.headSha,
      title: pull.title ?? review.title,
      body: "",
    };
    let checks: Awaited<ReturnType<Forge["checks"]>>;
    try {
      checks = await forge.checks(change);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      return {
        ok: false,
        text: `the checks could not be read. ${message}`,
        stop: isSignInForgeFailure(caught) ? "sign-in" : "checks",
      };
    }
    const items = checks.items;
    this.checks.endNoChecks({ forge, change, ...projectOf(located) }, items);
    const held = readinessStop(forge, pull, { head: review.headSha });
    if (held) {
      const plain = held.plain ?? held.text;
      return {
        ok: false,
        text:
          held.stop === "computing" && waited > 0
            ? `${plain}, after reading it again for ${Math.round(waited / 1_000)} seconds. Nothing merged.`
            : plain,
        stop: held.stop,
      };
    }
    const requestPage = changePageUrl(
      review.kind,
      review.host,
      `${review.owner}/${review.name}`,
      review.number,
    );
    const record = this.options.tasks.get(taskId);
    if (
      items.length === 0 &&
      (!record || !this.checks.absenceDeclared(record, { forge, change, ...projectOf(located) })) &&
      !overridePasses(record?.delivery, "checks", pull.headSha, requestPage)
    )
      return {
        ok: false,
        text: "No checks have registered and no positive absence declaration covers this version.",
        stop: "checks",
      };
    const status = checkSnapshotSummary({
      headSha: pull.headSha,
      items,
      complete: checks.complete,
      problem: checks.problem,
      absenceDeclared: Boolean(
        record && this.checks.absenceDeclared(record, { forge, change, ...projectOf(located) }),
      ),
    }).overall;
    if (
      status !== "green" &&
      status !== "none" &&
      !overridePasses(record?.delivery, "checks", pull.headSha, requestPage)
    )
      return {
        ok: false,
        text: checks.problem
          ? `the checks cannot be read. ${checks.problem}`
          : status === "red"
            ? "the checks failed"
            : MERGE_CHECKS_HOLD_REASON,
        stop: "checks",
      };
    return { ok: true, forge, pull };
  }

  /**
   * The captain's click on a merge card that names a review: the pull request it
   * names, read again by its number, sent once at the reviewed version (or
   * the version a declared repair carried the approval to). A story
   * published on that pull request must still be the published one.
   * `settle` follows a refusal because the main branch moved.
   */
  private async mergeNamed(
    taskId: string,
    review: MergeReview,
    guard?: MergeGuard,
    settle = false,
  ): Promise<MergeAttempt> {
    if (isForkReview(review) && guard && guard.head !== review.headSha)
      return {
        ok: false,
        stop: "moved",
        text: "Cannot merge: a contributor's later version needs a new review and a new click.",
      };
    const candidate = guard ? { ...review, headSha: guard.head } : review;
    // The host's own merge queue took this version: its place there is read
    // before any gate (docs/forge.md, "The host's merge queue"). One it
    // merged is read as merged just below.
    if (guard?.handed?.()) {
      const located = this.context.locate(taskId, "check", review);
      const handed =
        "said" in located
          ? undefined
          : await this.merges.handedOver(
              located.forge,
              {
                number: review.number,
                url: null,
                branch: review.branch,
                headSha: candidate.headSha,
                title: review.title,
                body: "",
              },
              guard,
            );
      if (handed && !handed.ok) return handed;
    }
    const fresh = await this.readReviewTarget(taskId, candidate, !guard?.unattended || settle);
    if (!fresh.ok) {
      if (fresh.text === "already-merged") {
        const located = this.context.locate(taskId, "check", review);
        if (!("said" in located) && located.forge.pull) {
          const pull = await located.forge.pull(review.number).catch(() => undefined);
          // A host whose merge names no version may have merged a later push:
          // that merge is the one made, recorded and told as such.
          if (
            pull?.merged &&
            (pull.headSha === candidate.headSha || located.forge.mergeNamesNoVersion)
          ) {
            const label = numberLabel(located.forge, review.number);
            const other = otherMergedFacts(
              located.forge.place,
              label,
              pull.headSha,
              candidate.headSha,
            );
            const receipt = this.storeReviewReceipt(
              taskId,
              review.id,
              pull.headSha,
              pull.mergedSha,
            );
            return {
              ok: true,
              text: `${label} is already merged${located.forge.place ? ` on ${located.forge.place}` : ""}.${other.told}`,
              ...other.line,
              receipt: { ...receipt, already: true },
            };
          }
        }
      }
      return {
        ok: false,
        text:
          guard && fresh.stop === "moved"
            ? `Cannot merge: the pull request moved past the approved version. Declare its repair with check_change conflictRepair; the captain's approval is kept.`
            : `Cannot merge: ${fresh.text}`,
        ...(fresh.stop ? { stop: fresh.stop } : {}),
        ...(fresh.stop === "checks" ? { notGreen: true } : {}),
      };
    }
    const { forge, pull } = fresh;
    let change: ForgeChange = {
      number: pull.number,
      url: null,
      branch: pull.branch ?? review.branch,
      headSha: pull.headSha,
      title: pull.title ?? review.title,
      body: "",
    };
    // The receipt names the version that merged: on a host whose merge names
    // no version, a push after the read may have gone in instead, and is told.
    const merged = (sha?: string, head?: string): PrOutcome => {
      const newer = otherMerged(candidate.headSha, head);
      const other = otherMergedFacts(forge.place, forge.label(change), head, candidate.headSha);
      return {
        ok: true,
        text: `Merged ${forge.label(change)}${forge.place ? ` on ${forge.place}` : ""}.${other.told}`,
        ...other.line,
        receipt: this.storeReviewReceipt(
          taskId,
          review.id,
          newer ?? candidate.headSha,
          sha,
          guard?.unattended ? undefined : "captain",
        ),
      };
    };
    let dispatched = false;
    try {
      if (!isForkReview(review) && hasChangeRequests(forge.kind))
        requireNamed(change.title ?? "", "pull request title", this.options.namingRule?.() ?? null);
      // The task's own pull request merges with its description, as the
      // finishing merge sends it.
      if (!isForkReview(review) && change.branch === this.options.tasks.get(taskId)?.branch) {
        const own = await forge.changeFor(change.branch);
        if (own && own.number === change.number) change = { ...change, body: own.body ?? "" };
      }
      const hasStory = this.options.tasks.delivery.changePresentation(
        taskId,
        change.branch,
        change.number,
      );
      // A moved story is republished here, so the region it rebuilds keeps
      // the project's disclosure line (docs/forge.md, "Disclosing AI assistance").
      const located = this.context.locate(taskId, "check", review);
      const disclosure = contributorDisclosureLine("said" in located ? undefined : located.repo);
      const storyForge =
        isForkReview(review) && hasStory
          ? forkStoryForge(forge, candidate, taskId, disclosure)
          : forge;
      const storied = await this.merges.withPublishedStory(taskId, storyForge, change, guard);
      if ("held" in storied) return { ok: false, stop: "guidance", text: storied.held };
      change = storied.change;
      // The story publisher applies the active naming runbook; a fork adds no wording rule.
      const held = guard?.held?.();
      if (held) return { ok: false, stop: "guidance", text: held };
      if (isForkReview(review)) {
        const last = await this.reread(candidate, async () => ({
          pull: await this.context.pullOf(forge, review.number),
          waited: 0,
        }));
        if (!last.ok) return { ok: false, text: `Cannot merge: ${last.text}`, stop: last.stop };
      }
      // The merge the project allows, read where it lives before anything is sent.
      const way = await wayToSend(forge, change);
      const leaving = atDispatch(
        forge,
        guard,
        () => guard?.beforeDispatch(candidate.headSha),
        () => {
          dispatched = true;
        },
      );
      const sent = leaving
        ? await forge.putIn(change, candidate.headSha, way, leaving)
        : await forge.putIn(change, candidate.headSha, way);
      if (sent?.queued) return hostQueued(forge, change);
      return merged(sent?.sha, sent?.mergedHead);
    } catch (caught) {
      if (caught instanceof MergeWithdrawn)
        return {
          ok: false,
          stop: caught.stop,
          text: caught.message,
        };
      const message = caught instanceof Error ? caught.message : String(caught);
      // A request the host says never left sent nothing, whatever was marked.
      const sent = dispatched && !(caught instanceof ForgeError && caught.beforeSend);
      const after = sent ? await forge.pull?.(review.number).catch(() => undefined) : undefined;
      if (after?.merged && (after.headSha === candidate.headSha || forge.mergeNamesNoVersion))
        return merged(after.mergedSha, after.headSha);
      const stop = guard
        ? ((await this.merges.refusalStop(forge, guard, caught, message)) ??
          (sent ? "outcome" : isTransientForgeFailure(caught) ? "transient" : undefined))
        : /Head branch was modified/i.test(message)
          ? "moved"
          : undefined;
      return {
        ok: false,
        text: `Cannot merge: ${message}`,
        problem: message,
        stop,
        ...(caught instanceof ForgeMergeUnconfirmed && caught.mergeTask
          ? { mergeTask: caught.mergeTask }
          : {}),
        ...(caught instanceof ForgeBaseMoved && (stop === undefined || stop === "computing")
          ? { baseMoved: true }
          : {}),
      };
    }
  }
}
