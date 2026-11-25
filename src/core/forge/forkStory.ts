import { changePageUrl } from "@shared/forgeKinds";
import { isForkReview, type MergeReview } from "@shared/mergeReview";
import {
  API_PER_PAGE_MAX,
  type ApiDialect,
  apiDialectAt,
  OversizedAnswer,
  smallerPage,
} from "./api";
import type { Forge, ForgeChange } from "./forge";
import { ForgeError, ForgeWriteError } from "./forge";
import { presentationRegionMarkers } from "./presentation";

/**
 * Where each kind keeps a change's comments, and how one is rewritten.
 * Bitbucket Cloud and Data Center have none yet: reviewing someone else's
 * pull request from a fork there comes later.
 */
const STORY_COMMENTS: Partial<
  Record<
    ApiDialect,
    {
      list: (project: string, number: number) => string;
      update: (
        project: string,
        number: number,
        id: number,
      ) => { method: "PATCH" | "PUT"; path: string };
    }
  >
> = {
  github: {
    list: (project, number) => `/repos/${project}/issues/${number}/comments`,
    update: (project, _number, id) => ({
      method: "PATCH",
      path: `/repos/${project}/issues/comments/${id}`,
    }),
  },
  gitlab: {
    list: (project, number) =>
      `/projects/${encodeURIComponent(project)}/merge_requests/${number}/notes`,
    update: (project, number, id) => ({
      method: "PUT",
      path: `/projects/${encodeURIComponent(project)}/merge_requests/${number}/notes/${id}`,
    }),
  },
};

/**
 * Reuse the saved-story publisher, receipts and uncertain-write recovery for
 * a comment on a reviewed fork. Never write the contributor's title or body,
 * open a replacement request, push to its source, or discover it by branch.
 * `disclosure` is the project's line saying a crewmate wrote it
 * (`contributorDisclosureLine`); undefined posts none.
 */
export function forkStoryForge(
  forge: Forge,
  review: MergeReview,
  taskId: string,
  disclosure?: string,
): Forge {
  if (!isForkReview(review)) return forge;
  const api = forge.api;
  if (!api || !forge.pull)
    throw new ForgeError("unsupported", "This host cannot publish a review story comment.");
  const readPull = forge.pull.bind(forge);
  const project = `${review.owner}/${review.name}`;
  const storyComments = STORY_COMMENTS[apiDialectAt(forge.kind, forge.host) ?? "github"];
  if (!storyComments)
    throw new ForgeError("unsupported", "This host cannot publish a review story comment.");
  const root = storyComments.list(project, review.number);
  const marker = presentationRegionMarkers(taskId).start;
  type Comment = { id: number; body: string };
  const call = async (method: "GET" | "POST" | "PATCH" | "PUT", path: string, body?: string) => {
    const answer = await api.call(
      method,
      path,
      body === undefined ? undefined : JSON.stringify({ body }),
    );
    if (answer.status < 200 || answer.status >= 300) {
      const message = `The story comment request was refused (${answer.status}).`;
      if (method === "GET") throw new ForgeError("refused", message);
      throw new ForgeWriteError(answer.status >= 500 ? "uncertain" : "failed", "refused", message);
    }
    return answer;
  };
  const comments = async (): Promise<Comment | undefined> => {
    let path: string | null = `${root}?per_page=${API_PER_PAGE_MAX}`;
    let found: Comment | undefined;
    while (path) {
      let response: Awaited<ReturnType<typeof call>>;
      try {
        response = await call("GET", path);
      } catch (caught) {
        if (!(caught instanceof OversizedAnswer)) throw caught;
        const smaller = smallerPage(path, caught, api.defaultPerPage);
        if ("refused" in smaller)
          throw new ForgeError("refused", `${caught.message} ${smaller.refused}`);
        path = api.route("GET", smaller.path).path;
        continue;
      }
      const rows: unknown = JSON.parse(response.body);
      if (!Array.isArray(rows))
        throw new ForgeError("refused", "The story comments could not be read.");
      for (const row of rows) {
        if (
          typeof row?.id !== "number" ||
          typeof row.body !== "string" ||
          !row.body.includes(marker)
        )
          continue;
        if (found)
          throw new ForgeError(
            "refused",
            "More than one comment names this story; reconcile them before publishing.",
          );
        found = { id: row.id, body: row.body };
      }
      path = api.nextPath(response.link);
    }
    return found;
  };
  const pull = async () => {
    const read = await readPull(review.number);
    if (
      read.number !== review.number ||
      read.base !== review.base ||
      read.branch !== review.branch ||
      read.headRepo?.toLowerCase() !== review.headRepo?.toLowerCase() ||
      (review.headRepoId !== undefined && read.headRepoId !== review.headRepoId) ||
      read.headSha !== review.headSha
    ) {
      throw new ForgeError(
        "refused",
        "The contributor's source or version changed. Read it again and prepare a new review.",
      );
    }
    return read;
  };
  const changeFor = async (): Promise<ForgeChange | null> => {
    const read = await pull();
    if (read.merged || read.state !== "open") return null;
    const comment = await comments();
    return {
      number: review.number,
      url: read.url ?? changePageUrl(forge.kind, review.host, project, review.number),
      branch: review.branch,
      base: review.base,
      headSha: read.headSha,
      title: read.title,
      body: comment?.body ?? "",
    };
  };
  const updateChangeBody = async (change: ForgeChange, body: string) => {
    const current = await changeFor();
    if (
      !current ||
      change.number !== review.number ||
      change.headSha !== current.headSha ||
      change.body !== current.body
    )
      throw new ForgeWriteError(
        "failed",
        "refused",
        "The review story changed before publication.",
      );
    const comment = await comments();
    if ((comment?.body ?? "") !== change.body)
      throw new ForgeWriteError(
        "failed",
        "refused",
        "The review story changed before publication.",
      );
    await pull();
    const update = comment && storyComments.update(project, review.number, comment.id);
    await call(update ? update.method : "POST", update ? update.path : root, body);
  };
  const overrides: Partial<Forge> = {
    storyInComment: true,
    storyDisclosure: disclosure,
    changeFor,
    branchHead: async () => (await pull()).headSha,
    updateChangeBody,
    openChange: async () => {
      throw new ForgeError("refused", "A contributor's review never opens another pull request.");
    },
  };
  return new Proxy(forge, {
    get(target, property) {
      if (property in overrides) return Reflect.get(overrides, property);
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
