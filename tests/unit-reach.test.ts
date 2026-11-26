import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTRACTS_PATH } from "../scripts/generate-personal-env.ts";
import { directUnitReach, projectPath } from "../scripts/unit-reach.ts";
import { selectLinuxReach } from "../scripts/unit-repeats.ts";

// INF-2394 measure 3: exercise the actual consumers that motivated local
// direct reach, without a synthetic graph or a transitive dependency sweep.
const root = resolve(import.meta.dirname, "..");
describe("local direct unit reach", () => {
  it("selects relative and aliased direct imports but not unrelated or transitive readers", () => {
    const readers = [
      "tests/generate-self-source.test.ts",
      "tests/phone-order.test.ts",
      "tests/unit-repeats.test.ts",
    ];
    expect(directUnitReach(["src/shared/ipc.ts"], readers, root)).toEqual([
      "tests/generate-self-source.test.ts",
      "tests/phone-order.test.ts",
    ]);
    // unit-repeats.test imports unit-repeats, which imports unit-reach.
    expect(
      directUnitReach(["scripts/unit-reach.ts"], ["tests/unit-repeats.test.ts"], root),
    ).toEqual([]);
  });

  it("resolves the renderer UI alias for its direct panel consumers", () => {
    expect(
      directUnitReach(
        ["src/renderer/src/design/index.ts"],
        ["src/panels/now/boardMoves.test.ts"],
        root,
      ),
    ).toEqual(["src/panels/now/boardMoves.test.ts"]);
  });

  it("selects workflow readers by literal path, not just module imports", () => {
    const readers = [
      "tests/unit-repeats-workflow.test.ts",
      "tests/release-workflows-main-check.test.ts",
      "tests/phone-order.test.ts",
    ];
    expect(directUnitReach([".github/workflows/ci.yml"], readers, root)).toEqual([
      "tests/release-workflows-main-check.test.ts",
      "tests/unit-repeats-workflow.test.ts",
    ]);
    expect(directUnitReach(["unrelated/ci.yml"], readers, root)).toEqual([]);
    expect(
      directUnitReach(
        [".github/workflows/main.yml"],
        ["tests/unit-repeats-workflow.test.ts"],
        root,
      ),
    ).toEqual([]);
  });

  it("selects joined paths and workflow template directory readers", () => {
    expect(
      directUnitReach(
        ["packaging/old-cask-switch.json"],
        ["tests/release-workflows-resolve.test.ts"],
        root,
      ),
    ).toEqual(["tests/release-workflows-resolve.test.ts"]);
    expect(
      directUnitReach(
        [".github/workflows/republish-casks.yml"],
        ["tests/release-workflows-pr-checks.test.ts"],
        root,
      ),
    ).toEqual(["tests/release-workflows-pr-checks.test.ts"]);
  });

  // INF-2426: b4c11e3fd and 61ba81374 edited the testing runbook's text and
  // broke the crewmate budget and the guidance contract on main, because the
  // runbook text is imported by piResources.ts, never by a test.
  // INF-1988 moves Testing to Markdown; Care remains a real imported JSON fixture.
  it("selects the tests that read a runbook's text through the module importing it", () => {
    const readers = [
      "tests/crewmate-fixed-context.test.ts",
      "src/core/pi/piResources.test.ts",
      // seat.ts imports piResources.ts: an importer of the importer stays out.
      "src/core/orchestrator/seat.test.ts",
    ];
    expect(directUnitReach(["resources/runbooks/care/default.json"], readers, root)).toEqual([
      "src/core/pi/piResources.test.ts",
      "tests/crewmate-fixed-context.test.ts",
    ]);
    expect(
      directUnitReach(
        ["resources/runbooks/naming/runbook.json"],
        ["src/core/workspace/naming.test.ts", ...readers],
        root,
      ),
    ).toEqual(["src/core/workspace/naming.test.ts"]);
  });

  // INF-2925's audit, the captain's fix-1: "Widen the pull request's unit
  // selection one step for served text, so a runbook or generated-fallback
  // change runs the budget and prompt tests." PR 1166 changed exactly these
  // files; its pull request selected only tests/release-notes.test.ts, and
  // its 41 tokens over the crew budget first failed in the swept batch.
  it("selects the budget and prompt tests for a runbook and generated-fallback change", () => {
    const changed = [
      "docs/runbooks.md",
      "release-notes/changes/repairs-stop-on-evidence.json",
      "resources/runbooks/delivery/crew.md",
      "src/core/pi/piResources.test.ts",
      "src/core/runbooks/fallback.generated.ts",
      "src/core/runbooks/runbooks.test.ts",
    ];
    const readers = [
      "tests/crewmate-fixed-context.test.ts",
      "tests/firstmate-fixed-context.test.ts",
      "tests/served-boundary.test.ts",
      // seat.ts imports piResources.ts: an importer of the importer stays out.
      "src/core/orchestrator/seat.test.ts",
    ];
    expect(directUnitReach(changed, readers, root)).toEqual([
      "tests/crewmate-fixed-context.test.ts",
      "tests/firstmate-fixed-context.test.ts",
      "tests/served-boundary.test.ts",
    ]);
    // A runbook the app loads from its folder reaches the tests that name
    // the folder, never ones that only name the resources folder above it.
    expect(
      directUnitReach(
        ["resources/runbooks/care/guide.md"],
        [
          "src/core/runbooks/runbooks.test.ts",
          "tests/eval-host-runbooks.test.ts",
          "src/shared/resources.test.ts",
        ],
        root,
      ),
    ).toEqual(["src/core/runbooks/runbooks.test.ts", "tests/eval-host-runbooks.test.ts"]);
  });

  // INF-3262's accepted repair: these real indirect contracts failed late;
  // declare only their owners, without selecting arbitrary transitive readers.
  it("selects the six audited contracts only for their declared indirect owners", () => {
    const inventories = ["src/shared/actions.test.ts", "src/shared/ipc.test.ts"];
    const migrations = [
      "src/core/storage/decisionMigrations.test.ts",
      "src/core/storage/inboxMigrations.test.ts",
      "src/core/storage/retireKeepOpen.test.ts",
    ];
    const policy = ["src/core/orchestrator/settleService.boundary.test.ts"];
    const readers = [...inventories, ...migrations, ...policy];
    expect(directUnitReach(["src/shared/channels/settings.ts"], readers, root)).toEqual(
      inventories,
    );
    expect(directUnitReach(["src/core/storage/migrations.ts"], readers, root)).toEqual(migrations);
    // Other migration tests directly import taskService; this pins only the
    // formerly missed policy consumer, not the existing direct readers.
    expect(directUnitReach(["src/core/tasks/taskService.ts"], policy, root)).toEqual(policy);
    expect(directUnitReach(["src/renderer/src/design/index.ts"], readers, root)).toEqual([]);
    // The channel folder is an explicit owner, including a deleted definition.
    expect(directUnitReach(["src/shared/channels/removed.ts"], readers, root)).toEqual(inventories);
    expect(
      directUnitReach(["src/shared/channels/settings.ts", ...inventories], readers, root),
    ).toEqual([]);
  });

  // The accepted daily velocity audit asks inventory tests to name their
  // covered files, beyond the six explicit contract edges already installed.
  it.each([
    "src/shared/decisions.ts",
    "src/shared/preferences.ts",
    "src/shared/quota.ts",
    "src/shared/sharing.ts",
    "src/shared/update.ts",
  ])("routes the action inventory to the PR check for its declared schema %s", (schema) => {
    const inventory = "src/shared/actions.test.ts";
    expect(directUnitReach([schema], [inventory], root)).toEqual([inventory]);
    expect(selectLinuxReach([schema], root).run).toContain(inventory);
    expect(directUnitReach([schema, inventory], [inventory], root)).toEqual([]);
  });

  // A contracts edit without `pnpm generate:personal-env` passed its pull
  // request check and failed the merge batch: the freshness test reads the
  // contracts only through the generator's path, so it declares that read.
  it("routes the personal contracts' freshness test to the PR check when the contracts change", () => {
    const freshness = "src/core/personal/infinitaryEnv.test.ts";
    // A changed path is named as git names it, with forward slashes on Windows too.
    const contracts = projectPath(relative(root, CONTRACTS_PATH));
    expect(directUnitReach([contracts], [freshness], root)).toEqual([freshness]);
    expect(selectLinuxReach([contracts], root).run).toContain(freshness);
    expect(directUnitReach(["src/shared/voice.ts"], [freshness], root)).toEqual([]);
    expect(directUnitReach([contracts, freshness], [freshness], root)).toEqual([]);
  });

  // INF-3545, INF-3614 and INF-3678: four changes passed their pull request
  // checks and failed the merge batch on a test that pins their output through
  // another module. Each change's own product files, as its pull request had them.
  it("routes the pins of a changed output to the PR check", () => {
    const contract = "src/shared/publishedContract.test.ts";
    const feed = "src/core/orchestrator/crewFacts.test.ts";
    const wakes = [
      "src/core/orchestrator/wakes.words.batches.test.ts",
      "src/core/orchestrator/wakes.words.cards.test.ts",
      "src/core/orchestrator/wakes.words.corrections.test.ts",
      "src/core/orchestrator/wakes.words.crewmate.checks.test.ts",
      "src/core/orchestrator/wakes.words.crewmate.forge.test.ts",
      "src/core/orchestrator/wakes.words.crewmate.test.ts",
      "src/core/orchestrator/wakes.words.firstmate.captain.test.ts",
      "src/core/orchestrator/wakes.words.firstmate.idle.test.ts",
      "src/core/orchestrator/wakes.words.firstmate.notices.test.ts",
      "src/core/orchestrator/wakes.words.firstmate.outages.test.ts",
      "src/core/orchestrator/wakes.words.firstmate.reports.test.ts",
      "src/core/orchestrator/wakes.words.firstmate.starts.test.ts",
      "src/core/orchestrator/wakes.words.firstmate.test.ts",
      "src/core/orchestrator/wakes.words.firstmate.turns.test.ts",
    ];
    const pins = [contract, feed, ...wakes];
    // PR 1408 widened the devices requests and regenerated the contract.
    const devices = ["docs/contract.json", "src/shared/channels/devices.ts"];
    expect(directUnitReach(devices, pins, root)).toEqual([contract]);
    expect(selectLinuxReach(devices, root).run).toContain(contract);
    // PR 1427 renamed the Starting feed line.
    expect(directUnitReach(["src/core/orchestrator/starts.ts"], pins, root)).toEqual([feed]);
    expect(selectLinuxReach(["src/core/orchestrator/starts.ts"], root).run).toContain(feed);
    // PR 1452 added a sentence to the review findings wake, and PR 1444
    // reworded the queue update offer in the notice wakes; wakes.ts itself
    // and its other word modules reach the same pins.
    for (const words of [
      "src/core/orchestrator/reportWakes.ts",
      "src/core/orchestrator/noticeWakes.ts",
      "src/core/orchestrator/wakes.ts",
      "src/core/orchestrator/captainWakes.ts",
    ]) {
      expect(directUnitReach([words], pins, root)).toEqual(wakes);
      expect(selectLinuxReach([words], root).run).toEqual(expect.arrayContaining(wakes));
    }
    expect(directUnitReach(["src/core/orchestrator/mainCheckWake.ts"], pins, root)).toEqual([]);
    expect(directUnitReach(["src/shared/voice.ts"], pins, root)).toEqual([]);
    // An edited pin keeps its own three rounds.
    expect(directUnitReach(["src/core/orchestrator/starts.ts", feed], pins, root)).toEqual([]);
  });

  // INF-4500's weekly audit, addition 6, which the captain chose ("The alpha's
  // build-list test for script changes"): a change gave the message generator
  // a new shared error printer, which the desktop build reaches, without the
  // alpha's build list, and the alpha cut failed. Its scripts, as it had them.
  it("routes the alpha's build-list test to the PR check for a change under scripts/", () => {
    const buildList = "tests/release-workflows-alpha-cut.test.ts";
    const scripts = ["scripts/generate-messages.ts", "scripts/github-errors.ts"];
    expect(directUnitReach(scripts, [buildList], root)).toEqual([buildList]);
    expect(selectLinuxReach(scripts, root).run).toContain(buildList);
    expect(directUnitReach(["src/shared/voice.ts"], [buildList], root)).toEqual([]);
    // An edited build-list test keeps its own three rounds.
    expect(directUnitReach([...scripts, buildList], [buildList], root)).toEqual([]);
  });

  // Two changes passed their pull request checks and failed the merge batch on
  // a Claude test that reaches them only through another file. Each change's
  // product files, as its pull request had them when the batch ran.
  it("routes the Claude session contract and classifier tests to the PR check for their indirect owners", () => {
    const contracts = [
      "src/core/claude/claudeSession.contract.integration.test.ts",
      "src/core/claude/claudeSession.contract.test.ts",
    ];
    const classifier = "src/core/claude/claudeClassifierSession.integration.test.ts";
    const readers = [classifier, ...contracts];
    // PR 1524 stamped the seat's prompt per backend; the contract tests read
    // the stamp through tests/helpers/sessionContract.ts.
    const seat = ["src/core/orchestrator/seat.ts", "src/core/pi/piResources.ts"];
    // The classifier test imports both modules directly, so it runs too.
    for (const owner of seat) {
      expect(directUnitReach([owner], readers, root)).toEqual(readers);
      expect(selectLinuxReach([owner], root).run).toEqual(expect.arrayContaining(contracts));
    }
    // PR 1589 gave the provider catalog an import that plain Node could not
    // load; the classifier test's scoring process loads the catalog.
    expect(directUnitReach(["src/shared/providers.ts"], readers, root)).toEqual([classifier]);
    expect(selectLinuxReach(["src/shared/providers.ts"], root).run).toContain(classifier);
    expect(directUnitReach(["src/shared/voice.ts"], readers, root)).toEqual([]);
    expect(directUnitReach(["src/core/orchestrator/seatDigest.ts"], contracts, root)).toEqual([]);
    // An edited reader keeps its own three rounds.
    expect(directUnitReach([...seat, ...contracts], contracts, root)).toEqual([]);
  });

  // INF-6259's weekly audit, the captain's pick "Twelve reach links": twelve
  // changes passed their branch checks and failed the merge batch on a test
  // that reaches the changed file only through a helper or an import chain.
  // Each case is one change's product file, as it had it, and the tests it
  // broke.
  it.each([
    [
      "src/core/forge/forge.ts",
      [
        "src/core/orchestrator/changeCutover.test.ts",
        "src/core/orchestrator/changePublication.stories.test.ts",
        "src/core/orchestrator/mergeReviews.test.ts",
      ],
    ],
    ["src/core/orchestrator/changePublication.ts", ["src/core/placed/placedWorkingCopies.test.ts"]],
    ["src/core/orchestrator/changeContext.ts", ["src/core/placed/placedWorkingCopies.test.ts"]],
    ["src/core/pi/taskTools.ts", ["tests/firstmate-fixed-context.test.ts"]],
    ["src/core/pi/forgeTools.ts", ["tests/crewmate-fixed-context.test.ts"]],
    ["src/core/tasks/workPresentation.ts", ["src/core/core.projects.test.ts"]],
    ["src/core/storage/cardStore.ts", ["src/core/storage/cardThreadMigrations.test.ts"]],
    ["src/core/placed/placedLedger.ts", ["src/core/placed/placedClaude.contract.test.ts"]],
    ["src/core/program/programRunner.ts", ["src/core/orchestrator/crewPrograms.test.ts"]],
    ["src/core/placed/placedCopies.ts", ["src/core/placed/placedCallbacks.test.ts"]],
    ["src/shared/holds.ts", ["src/core/orchestrator/wakes.words.crewmate.test.ts"]],
    ["src/core/forge/index.ts", ["tests/gitlabMergeReview.test.ts"]],
    ["src/core/placed/placedCopies.ts", ["src/core/placed/placedSignIns.test.ts"]],
    [
      "src/core/notifications.ts",
      ["src/core/core.projects.test.ts", "src/main/shell.beside.test.ts"],
    ],
  ])(
    "routes the readers a change to %s broke in the merge batch to the PR check",
    (owner, broke) => {
      expect(directUnitReach([owner], broke, root)).toEqual(broke);
      expect(directUnitReach(["src/shared/voice.ts"], broke, root)).toEqual([]);
      // An edited reader keeps its own three rounds.
      expect(directUnitReach([owner, ...broke], broke, root)).toEqual([]);
    },
  );

  it("does not broaden inventory coverage to unrelated files or the whole shared folder", () => {
    const inventory = "src/shared/actions.test.ts";
    expect(directUnitReach(["src/shared/voice.ts"], [inventory], root)).toEqual([]);
    expect(selectLinuxReach(["src/shared/voice.ts"], root).run).not.toContain(inventory);
  });

  it("leaves edited tests to their three rounds rather than adding a fourth", () => {
    const reader = "tests/phone-order.test.ts";
    expect(directUnitReach(["src/shared/ipc.ts", reader], [reader], root)).toEqual([]);
  });
});
