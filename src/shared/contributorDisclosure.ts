import { z } from "zod";

/**
 * The line that opens what the crew posts to an outside contributor
 * (docs/forge.md, "Saying a crewmate wrote it"), unless the project turns it
 * off or writes its own in Settings → Projects. It is posted where the
 * project lives, in the project's own words, so it is not translated.
 */
// i18n-exempt: posted where the project lives in its own language, never shown as the app's words
export const DEFAULT_CONTRIBUTOR_DISCLOSURE =
  "_Written by an Infinitary crewmate, an AI agent working for this project's maintainer._";

/**
 * A project's own disclosure (`RepoView.contributorDisclosure`): an empty
 * string turns it off; a patch's null goes back to the default line.
 */
export const contributorDisclosureSchema = z.string().trim().max(300);

/** The line a project's crew opens with, or undefined when the project turned it off. */
export function contributorDisclosureLine(
  repo: { contributorDisclosure?: string } | undefined,
): string | undefined {
  const own = repo?.contributorDisclosure;
  if (own === undefined) return DEFAULT_CONTRIBUTOR_DISCLOSURE;
  return own === "" ? undefined : own;
}
