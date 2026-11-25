import { DEFAULT_CONTRIBUTOR_DISCLOSURE } from "@shared/contributorDisclosure";
import type { MergeReview } from "@shared/mergeReview";
import { describe, expect, it } from "vitest";
import { arrange, BRANCH, HEAD, TASK } from "../../../tests/helpers/changePresentationsHarness";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { type ForgeApi, type ForgePull, forkStoryForge, parseApiRequest } from "../forge";
import { presentationMarkdownText, presentationRegionMarkers } from "../forge/presentation";

// Accepted contributor plan, piece A: preserve the contributor's words and
// reuse the publication owner's confirmed and uncertain-write lifecycle.
// The fixture uses the existing inspected app photographs and host comment
// readings; the network itself is a stand-in, not a real external account.
describe("contributor review stories", () => {
  async function contributor(kind: "github" | "gitlab", disclosure?: string) {
    const at = await arrange();
    const review: MergeReview = {
      id: "mrcontributor",
      kind,
      host: "github.com",
      owner: "x",
      name: "y",
      number: 151,
      branch: BRANCH,
      base: "main",
      headSha: HEAD,
      headRepo: kind === "github" ? "contributor/y" : "gitlab-project:99",
      headRepoId: 99,
      method: "squash",
      title: "Fix typo",
      at: 1,
    };
    let read: ForgePull = { ...review, state: "open", merged: false, readiness: "clean" };
    at.change = {
      number: review.number,
      branch: BRANCH,
      headSha: HEAD,
      title: review.title,
      body: "The contributor's original explanation.\n\nFixes #25",
      url: null,
    };
    const original = { ...at.change };
    const comments: { id: number; body: string }[] = [];
    const writes: { method: string; path: string; body: string }[] = [];
    let loseReply = false;
    const api: ForgeApi = {
      place: kind,
      defaultPerPage: 100,
      route: (method, path) => parseApiRequest(method, path, { owner: "x", name: "y" }),
      nextPath: () => null,
      call: async (method, path, body) => {
        if (method !== "GET") {
          const words = JSON.parse(body ?? "{}").body;
          writes.push({ method, path, body: words });
          if (method === "POST") comments.push({ id: 41, body: words });
          else comments[0] = { id: 41, body: words };
          if (loseReply) {
            loseReply = false;
            throw new Error("The comment reply was lost.");
          }
        }
        return {
          status: 200,
          requestId: null,
          rateLimit: null,
          retryAfterSeconds: null,
          link: null,
          body: JSON.stringify(method === "GET" ? comments : comments[0]),
        };
      },
    };
    const underlying = new Proxy(at.forge, {
      get(target, property) {
        if (property === "kind") return kind;
        if (property === "api") return api;
        if (property === "pull") return async () => read;
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    seedDelivery(at.tasks, TASK, { checkTarget: review, mergeReviews: [review] });
    const forge = forkStoryForge(underlying, review, TASK, disclosure);
    await at.prepare();
    return {
      at,
      forge,
      original,
      comments,
      writes,
      move: (fields: Partial<ForgePull>) => {
        read = { ...read, ...fields };
      },
      lose: () => {
        loseReply = true;
      },
      publish: () => at.service.publish(TASK, 1, forge, BRANCH, at.draft.title),
    };
  }
  it.each(["github", "gitlab"] as const)(
    "publishes and reads back a %s comment, keeping the description and squash summary",
    async (kind) => {
      const c = await contributor(kind, DEFAULT_CONTRIBUTOR_DISCLOSURE);
      const published = await c.publish();
      expect(c.writes).toHaveLength(1);
      expect(c.writes[0]?.method).toBe("POST");
      expect(c.writes[0]?.path).toBe(
        kind === "gitlab"
          ? "/projects/x%2Fy/merge_requests/151/notes"
          : "/repos/x/y/issues/151/comments",
      );
      expect(c.comments[0]?.body).toContain(
        presentationMarkdownText(c.at.draft.whatChanged[0] ?? ""),
      );
      // The captain's ask: a reply to an outside contributor always says an
      // Infinitary crewmate made it. The line opens the crew's story, above its title.
      const { start } = presentationRegionMarkers(TASK);
      expect(c.comments[0]?.body).toContain(
        `${start}\n\n_Written by an Infinitary crewmate, an AI agent working for this project's maintainer._\n\n` +
          `# ${presentationMarkdownText(c.at.draft.title)}`,
      );
      expect(c.at.change).toEqual(c.original);
      expect(c.at.update).not.toHaveBeenCalled();
      expect(c.at.open).not.toHaveBeenCalled();
      const verified = await c.at.service.assertPublished(TASK, published, c.forge);
      expect(verified.squashMessage).toContain(c.at.draft.whatChanged[0]);
      expect(verified.squashMessage).not.toContain("Infinitary crewmate");
      expect(verified.title).toBe(c.at.draft.title);
      // Re-publication is a read, never a duplicate comment.
      await c.publish();
      expect(c.writes).toHaveLength(1);
      // The fork's story does not occupy the task's same-named branch ledger.
      expect(c.at.tasks.delivery.changePresentation(TASK)?.forkNumber).toBe(151);
      c.at.tasks.delivery.selectOwnChange(TASK);
      expect(c.at.tasks.delivery.changePresentation(TASK)).toBeUndefined();
      expect(
        c.at.tasks.delivery.changePresentation(TASK, BRANCH, published.number)?.forkNumber,
      ).toBe(published.number);
      const afterSelection = await c.at.service.assertPublished(TASK, published, c.forge);
      expect(afterSelection.squashMessage).toBe(verified.squashMessage);
      expect(afterSelection.title).toBe(c.at.draft.title);
    },
  );
  // The captain's follow-up: a project can turn the line off or write its own.
  it.each([
    {
      disclosure: "_Drafted by our project's AI crew._",
      shown: "_Drafted by our project's AI crew._",
    },
    { disclosure: undefined, shown: undefined },
  ])(
    "opens the comment with the project's own line or none: $disclosure",
    async ({ disclosure, shown }) => {
      const c = await contributor("github", disclosure);
      await c.publish();
      const { start } = presentationRegionMarkers(TASK);
      const title = `# ${presentationMarkdownText(c.at.draft.title)}`;
      expect(c.comments[0]?.body).toContain(
        shown ? `${start}\n\n${shown}\n\n${title}` : `${start}\n\n${title}`,
      );
      expect(c.comments[0]?.body).not.toContain("Infinitary crewmate");
    },
  );
  it.each(["github", "gitlab"] as const)(
    "reconciles a lost %s comment reply without sending it twice",
    async (kind) => {
      const c = await contributor(kind);
      c.lose();
      await expect(c.publish()).rejects.toThrow("reply was lost");
      expect(c.at.tasks.delivery.changePresentation(TASK)?.publication?.state).toBe("uncertain");
      await c.publish();
      expect(c.writes).toHaveLength(1);
      expect(c.at.tasks.delivery.changePresentation(TASK)?.published?.state).toBe("confirmed");
      expect(c.at.change).toEqual(c.original);
    },
  );
  it.each([{ headSha: "9".repeat(40) }, { headRepo: "another/y" }, { headRepoId: 100 }])(
    "refuses a source or version move before comment publication: %j",
    async (fields) => {
      const c = await contributor("github");
      c.move(fields);
      await expect(c.publish()).rejects.toThrow("source or version changed");
      expect(c.writes).toEqual([]);
      expect(c.at.upload).not.toHaveBeenCalled();
      expect(c.at.change).toEqual(c.original);
    },
  );
});
