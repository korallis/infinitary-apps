import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { PROJECT_POLICY_WORDS } from "../../src/renderer/src/settings/projectsWords";
import { scratchDir } from "../helpers/scratchDirs";
import { seedGitHubSignIn, seedRepo, startGitHubStub } from "./githubStub";
import { launchApp } from "./launch";
import { heroShot } from "./pictures";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { projectLine, projectSettings } from "./projects";
import { readSavedData } from "./savedData";
import { focusOn, pressKey } from "./windowKeys";

/**
 * The captain's ask on a fork review's story comment: "have a setting
 * somewhere that allows this to be set per project. default disclosure on,
 * but user can either turn it off or edit the disclosure line", reached from
 * the keyboard like every control.
 *
 * A project on GitHub, served by a disposable GitHub with the app's real
 * sign-in. The captain opens its page by keys, finds Disclose AI assistance
 * on with the default line, writes the project's own line and saves it with
 * Enter, turns it off with Space, then on again, which goes back to the
 * default line. The completion signal is the saved project record
 * (`contributor_disclosure`); the comment it opens is
 * `changePresentations.contributor.test.ts`'s. Requires desktop Electron and
 * local git; no real sign-in or shared pull request.
 */
test("a project's line saying a crewmate wrote it is edited, turned off and back on by keys", async () => {
  test.setTimeout(120_000);
  const userDataDir = scratchDir("infinitary-contributor-disclosure-");
  const { repoDir } = seedRepo(userDataDir);
  const github = await startGitHubStub();
  seedGitHubSignIn(userDataDir);
  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: "repo-meterlab",
    path: repoDir,
    name: "meterlab",
    setupKind: "clone",
    origin: "https://github.com/o/meterlab.git",
    runsOn: null,
    delivery: "direct-pr",
    rigor: "quick",
  });
  seedHostedOrigins(db, userDataDir);
  db.close();
  const launched = await launchApp({ withMockProvider: true, userDataDir, env: github.env });
  try {
    const { page } = launched;
    const saved = () =>
      readSavedData(
        userDataDir,
        (savedDb) =>
          (
            savedDb
              .prepare("SELECT contributor_disclosure FROM repos WHERE id = ?")
              .get("repo-meterlab") as { contributor_disclosure: string | null }
          ).contributor_disclosure,
      );

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Projects", exact: true }).click();
    const line = projectLine(page, "repo-meterlab").getByRole("button");
    await expect(line).toBeVisible();
    await pressKey(line, "Enter");
    const row = projectSettings(page, "repo-meterlab");

    // On by default, with the default line.
    const toggle = row.getByRole("switch", { name: PROJECT_POLICY_WORDS.disclosureTitle });
    const field = row.getByRole("textbox", { name: PROJECT_POLICY_WORDS.disclosureLine });
    await expect(toggle).toBeChecked();
    await expect(row).toContainText(PROJECT_POLICY_WORDS.disclosure(true));
    await expect(field).toHaveValue(
      "_Written by an Infinitary crewmate, an AI agent working for this project's maintainer._",
    );
    expect(await saved()).toBeNull();

    const inView = () => field.evaluate((node) => node.scrollIntoView({ block: "center" }));
    await inView();
    await heroShot(launched.app, page, {
      region: field,
      anchors: [toggle, row.getByText(PROJECT_POLICY_WORDS.disclosureTitle, { exact: true })],
      name: "fork-review-disclosure",
      ready: inView,
    });

    // The project's own line, saved with Enter from the field it is typed in.
    await focusOn(toggle);
    await pressKey(toggle, "Tab");
    await expect(field).toBeFocused();
    await field.fill("Posted by the meterlab maintainers' AI crew.");
    await pressKey(field, "Enter");
    await expect.poll(saved).toBe("Posted by the meterlab maintainers' AI crew.");

    // Off: nothing opens the comment, and the field leaves.
    await focusOn(toggle);
    await pressKey(toggle, " ");
    await expect.poll(saved).toBe("");
    await expect(toggle).not.toBeChecked();
    await expect(row).toContainText(PROJECT_POLICY_WORDS.disclosure(false));
    await expect(field).toHaveCount(0);

    // On again: the default line.
    await pressKey(toggle, " ");
    await expect.poll(saved).toBeNull();
    await expect(field).toHaveValue(
      "_Written by an Infinitary crewmate, an AI agent working for this project's maintainer._",
    );
  } finally {
    await launched.close();
    await github.close();
  }
});
