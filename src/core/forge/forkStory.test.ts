import type { MergeReview } from "@shared/mergeReview";
import { describe, expect, it } from "vitest";
import { API_PER_PAGE_MAX, API_RESPONSE_MAX_BYTES } from "./api";
import type { Forge } from "./forge";
import { forkStoryForge } from "./forkStory";
import { presentationRegionMarkers } from "./presentation";
import { GitHubForge } from "./providers/github/githubForge";
import { GitLabForge } from "./providers/gitlab/gitlabForge";

// INF-3585's comment-page-oversize finding: exercise the real provider's
// response cap and next-page reader against a long contributor discussion.
// Fetch stands in for the hosts; no account or persistent effect is used.
describe("fork story comment paging", () => {
  it.each(["github", "gitlab"] as const)(
    "recovers oversized %s pages and finds the story after earlier discussion",
    async (kind) => {
      const host = kind === "github" ? "github.com" : "gitlab.com";
      const head = "ae410df83379e6c96f737767e22cd4d7f3f72302";
      const review: MergeReview = {
        id: "mr-thread",
        kind,
        host,
        owner: "x",
        name: "y",
        number: 151,
        branch: "contribution",
        base: "main",
        headSha: head,
        headRepo: kind === "github" ? "contributor/y" : "gitlab-project:99",
        headRepoId: 99,
        title: "Fix typo",
        method: "squash",
        at: 1,
      };
      const marker = presentationRegionMarkers("thread-review");
      const body = `${marker.start}\nThe crew's reviewed contribution.\n${marker.end}`;
      // A documented result and its review discussion, not a huge single
      // comment: every comment fits, while the first full page does not.
      const discussion =
        "The contribution updates the meter reading when the saved value changes. Please retain the existing behavior for an empty reading and explain the result of checking both states.\n";
      const comments = Array.from({ length: API_PER_PAGE_MAX + 1 }, (_, index) => ({
        id: index + 1,
        body: `${index + 1}. ${discussion.repeat(20)}`,
        user: { id: index + 10, login: `reviewer-${index + 1}`, type: "User" },
      }));
      comments.push({
        id: comments.length + 1,
        body,
        user: { id: 7, login: "maintainer", type: "User" },
      });
      expect(
        Buffer.byteLength(JSON.stringify(comments.slice(0, API_PER_PAGE_MAX))),
      ).toBeGreaterThan(API_RESPONSE_MAX_BYTES);
      const reads: URL[] = [];
      const fetcher: typeof fetch = async (input) => {
        const url = new URL(String(input));
        reads.push(url);
        if (url.pathname.endsWith("/comments") || url.pathname.endsWith("/notes")) {
          const size = Number(url.searchParams.get("per_page"));
          const page = Number(url.searchParams.get("page") ?? 1);
          const rows = comments.slice((page - 1) * size, page * size);
          const next = new URL(url);
          next.searchParams.set("page", String(page + 1));
          return Response.json(rows, {
            headers: page * size < comments.length ? { link: `<${next.href}>; rel="next"` } : {},
          });
        }
        if (kind === "github")
          return Response.json({
            number: review.number,
            state: "open",
            merged: false,
            title: review.title,
            html_url: `https://${host}/x/y/pull/151`,
            body: "The contributor's explanation.",
            head: {
              sha: head,
              ref: review.branch,
              repo: { full_name: review.headRepo, id: review.headRepoId },
            },
            base: { ref: "main" },
            mergeable: true,
            mergeable_state: "clean",
          });
        return Response.json({
          iid: review.number,
          project_id: 7,
          source_project_id: 99,
          target_project_id: 7,
          source_branch: review.branch,
          target_branch: "main",
          sha: head,
          title: review.title,
          description: "The contributor's explanation.",
          web_url: `https://${host}/x/y/-/merge_requests/151`,
          state: "opened",
          detailed_merge_status: "mergeable",
        });
      };
      const location = { kind, host, owner: "x", name: "y", dir: "/disposable-project" };
      const options = {
        token: async () => "disposable-stand-in-key",
        apiBaseUrl: `https://${host}${kind === "gitlab" ? "/api/v4" : ""}`,
        fetch: fetcher,
      };
      const provider: Forge =
        kind === "github" ? new GitHubForge(location, options) : new GitLabForge(location, options);
      const story = await forkStoryForge(provider, review, "thread-review", undefined).changeFor(
        review.branch,
      );
      expect(story).toMatchObject({
        number: review.number,
        body,
        title: review.title,
        headSha: head,
      });
      const pages = reads.filter(
        (url) => url.pathname.endsWith("/comments") || url.pathname.endsWith("/notes"),
      );
      expect(pages[0]?.searchParams.get("per_page")).toBe(String(API_PER_PAGE_MAX));
      expect(pages.some((url) => Number(url.searchParams.get("per_page")) < API_PER_PAGE_MAX)).toBe(
        true,
      );
      expect(pages.some((url) => Number(url.searchParams.get("page")) > 1)).toBe(true);
    },
  );
});
