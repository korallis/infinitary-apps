import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { data, Evaluator, Lexer, Parser } from "@actions/expressions";
import { describe, expect, it, vi } from "vitest";
import { laneOf } from "../scripts/journey-budget.ts";
import vitestConfig from "../vitest.config";
import {
  type CiJob,
  ciJobs,
  loadCi,
  loadYamlFile,
  root,
  type WorkflowStep as Step,
  verifyLinuxTests,
  workflowString,
  workflowValue,
} from "./helpers/releaseWorkflows";
import { scratchDir } from "./helpers/scratchDirs";

// INF-2267: portable workflow contracts keep the integration cohort and its isolation;
// native executable and bundle checks remain in the Mac-listed release-contract file.

// Preserve the original release-contract budget; discovery keeps its explicit budget.
vi.setConfig({ testTimeout: 10_000 });

/** The branch check's three jobs, in ci.yml's order. */
const BRANCH_CHECK = ["code-checks", "reached-tests", "build"];

/**
 * INF-5493: the job that runs the parts past the first of a wide change's
 * tests, once the code checks counted them, a machine per part.
 */
const PARTS = "reached-tests-parts";

/** The pull request's checks and main's sweep jobs (ci.yml). */

describe("local packaging identity (electron-builder.dev.yml)", () => {
  /**
   * Captain: "ok move it too but as a separate task" extends INF-2224
   * to probes: retain the real PR gates, move all full sweeps to main.
   * Exercise the actual job condition with GitHub's expression evaluator,
   * including a release's own notes pull request, rather than looking for a
   * string. No upstream jobs: the implicit success() condition is true here.
   */
  // Captain's pick from INF-2588: a request checks code and build only unless
  // it asks for the sweep, so a lint before a pull request costs no sweep.
  it("starts no test sweep on a request that does not ask for it", () => {
    const names = ciJobs("workflow_dispatch", false).map((job) => job.id);
    expect(names).toEqual(["code-checks", "build"]);
  });

  it.each([
    ["requested full sweep", "workflow_dispatch", "", "refs/heads/fm/task-ci-contract"],
    ["ordinary proposal", "pull_request", "fm/task-ci-contract", "refs/pull/42/merge"],
    ["release notes and record", "pull_request", "fm/task-release-alpha", "refs/pull/471/merge"],
    // INF-3759's plan, piece 2: a pushed task branch runs what its pull
    // request runs, measured from the commit it left main at.
    ["pushed task branch", "push", "", "refs/heads/fm/task-ci-contract"],
  ])("runs the real Linux gate for %s", (_name, eventName, headRef, ref) => {
    const ci = loadCi();
    const change = eventName !== "workflow_dispatch";
    // The event must reach every job, not disappear behind a branch/path filter.
    expect(ci.on).toHaveProperty("pull_request", null);
    // INF-2340 (captain's route "drop-ci-main"): a push to main starts none of
    // these jobs, since main.yml's full check runs the same commands. The
    // captain's pick on INF-3759, "the pushed branch": each push of a task's
    // branch starts them (tests/batch-pull.test.ts holds which branches).
    expect(Object.keys(ci.on).toSorted()).toEqual(["pull_request", "push", "workflow_dispatch"]);
    const github = new data.Dictionary(
      { key: "event_name", value: new data.StringData(eventName) },
      { key: "head_ref", value: new data.StringData(headRef) },
      { key: "base_ref", value: new data.StringData(eventName === "pull_request" ? "main" : "") },
      { key: "ref", value: new data.StringData(ref) },
    );
    // INF-5577's review, the captain's pick "Split the branch check into
    // three jobs that run side by side": the branch check is three jobs,
    // whose steps together are the one gate a change passes, with the later
    // parts of a wide change's tests in a fourth (INF-5493).
    const gate = [...BRANCH_CHECK, PARTS].flatMap((id) => ci.jobs[id]?.steps ?? []);
    // INF-2414 (captain: "why can't we catch release note problems before
    // merge?"): the pull request's notes step (docs/release-notes.md, "The
    // release check").
    const notes = gate.find((step) =>
      step.run?.startsWith("node scripts/release-notes.ts change "),
    );
    expect(notes).toBeDefined();
    // INF-4500's weekly audit, addition 4 (the captain's choice: "Flag a
    // contract change that breaks phone views"): the flag reads the change
    // from its base and never fails the check.
    const phoneFlag = gate.find((step) =>
      step.run?.startsWith("node scripts/phone-contract-flag.ts "),
    );
    expect(phoneFlag?.run).toBe('node scripts/phone-contract-flag.ts --base "$CHANGE_BASE"');
    expect(phoneFlag?.["continue-on-error"]).toBeFalsy();
    // INF-6259's weekly audit, the captain's pick "Size headroom: refuse a
    // change that grows a code file past, or further past, 1,800 lines": the
    // code checks measure the change from its base and fail on a refusal.
    const headroom = gate.filter((step) =>
      step.run?.startsWith("node scripts/file-sizes.ts --headroom"),
    );
    expect(headroom.map((step) => step.run)).toEqual([
      'node scripts/file-sizes.ts --headroom --base "$CHANGE_BASE"',
    ]);
    expect(ci.jobs["code-checks"]?.steps).toContain(headroom[0]);
    expect(headroom[0]?.["continue-on-error"]).toBeFalsy();
    // INF-2915's plan: the paths step decides the build, the browser tests
    // and the critical path (scripts/pr-paths.ts).
    // The tests job reads its browser verdict and the build job its build
    // verdict, each from its own run of the step.
    const pathSteps = gate.filter((step) => step.id === "paths");
    expect(pathSteps.map((step) => step.run)).toEqual(
      Array(2).fill('node scripts/pr-paths.ts --base "$CHANGE_BASE"'),
    );
    const [paths] = pathSteps;
    // INF-3759's plan, piece 2: the step that says where the change starts,
    // which the notes, paths, reader and critical-path steps all read.
    // Each job finds it alike, so each skips alike on a batch's version.
    const bases = gate.filter((step) => step.name === "Find the change's base");
    expect(bases).toHaveLength(BRANCH_CHECK.length + 1);
    const [base] = bases;
    expect(base?.uses).toBe("./.github/actions/change-base");
    for (const other of bases) {
      expect(other.uses).toBe(base?.uses);
      expect(other.with).toEqual(base?.with);
    }
    // INF-2441 (captain's choice: "Run the tests that read each changed file
    // inside the pull request's build check"): the pull request's round of
    // the unit, integration and browser tests that read a changed file
    // (docs/testing.md). INF-5493: reached-tests runs its first part, and
    // reached-tests-parts each later part the code checks counted.
    const [reach, later, ...others] = gate.filter(
      (step) =>
        step.run?.startsWith("node scripts/unit-repeats.ts --reach ") &&
        step.run.endsWith(" --run"),
    );
    expect(others).toEqual([]);
    expect(reach?.run).toBe(
      'node scripts/unit-repeats.ts --reach --base "$CHANGE_BASE" --part 1 --run',
    );
    expect(later?.run).toBe(
      'node scripts/unit-repeats.ts --reach --base "$CHANGE_BASE" --part "$PART" --run',
    );
    const count = gate.find((step) => step.id === "reach-parts");
    expect(count?.run).toBe(
      'node scripts/unit-repeats.ts --reach --base "$CHANGE_BASE" --later-parts',
    );
    expect(ci.jobs["code-checks"]?.steps).toContain(count);
    const testTools = gate.filter((step) => step.uses === "./.github/actions/linux-test-tools");
    expect(testTools).toHaveLength(2);
    for (const [tools, reader] of [
      [testTools[0], reach],
      [testTools[1], later],
    ]) {
      expect(tools?.if).toBe(reader?.if);
      expect(gate.indexOf(tools ?? {})).toBeLessThan(gate.indexOf(reader ?? {}));
      expect(gate.indexOf(tools ?? {})).toBeGreaterThan(-1);
    }
    // INF-2505, gated by INF-2915's plan: the browser project in the build
    // check, after installing the Chromium it draws in, which a later part's
    // browser files draw in too.
    const chromium = gate.filter((step) => step.uses === "./.github/actions/browser-chromium");
    const browser = gate.find((step) => step.run === "pnpm test --project browser");
    expect(chromium).toHaveLength(2);
    expect(browser).toBeDefined();
    // INF-2915's plan: the build skips on a light version, and the critical
    // path runs inside the build check on the app it built.
    // The adherence lint runs on a request, as in main's check, never on a
    // pull request (INF-2915's plan).
    const adherence = gate.find((step) => step.run === "pnpm lint:adherence");
    expect(adherence).toBeDefined();
    const build = gate.find((step) => step.run === "pnpm build");
    const desktop = gate.find((step) => step.uses === "./.github/actions/linux-desktop");
    const criticalPath = gate.find((step) => step.id === "critical-path");
    const skips = gate.find(
      (step) => step.run === "node scripts/untagged-skips.ts playwright-report/source-results.json",
    );
    // INF-6748's velocity review, the captain's pick: the window's method
    // list journey runs beside the critical path on the same build.
    const windowMethods = gate.find((step) => step.id === "window-methods");
    const windowSkips = gate.find((step) => step.run?.includes("window-methods-results.json"));
    const evidence = gate.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    for (const step of [build, desktop, criticalPath, skips, windowMethods, windowSkips, evidence])
      expect(step).toBeDefined();
    expect(windowMethods?.run).toContain("--files tests/e2e/phase0-guardrails.spec.ts");
    const gated = [
      ...bases,
      notes,
      phoneFlag,
      ...headroom,
      ...pathSteps,
      count,
      reach,
      later,
      ...testTools,
      ...chromium,
      browser,
      adherence,
      build,
      desktop,
    ];
    gated.push(criticalPath, skips, windowMethods, windowSkips);
    // The setup and code checks a branch built on a batch's version skips
    // (the case after next), which every other change runs.
    const setup = gate.filter(
      (step) =>
        ["./.github/actions/pnpm", "./.github/actions/electron-download"].includes(
          step.uses ?? "",
        ) ||
        step.uses?.startsWith("actions/setup-node@") ||
        ["pnpm install --frozen-lockfile", "pnpm typecheck", "pnpm check"].includes(step.run ?? ""),
    );
    // Each job sets up and installs on its own; the code checks job alone
    // runs the typecheck and the lint.
    expect(setup).toHaveLength(4 * (BRANCH_CHECK.length + 1) + 2);
    gated.push(...setup);
    for (const [id, job] of Object.entries(ci.jobs)) {
      // INF-5493: the later parts alone wait, for the code checks' count of
      // them, which says whether they start: the wide machines below.
      expect(job.needs, id).toBe(id === PARTS ? "code-checks" : undefined);
      const expression = (id === PARTS ? "true" : (job.if ?? "true")).replace(
        /^\$\{\{\s*|\s*\}\}$/g,
        "",
      );
      const ast = new Parser(new Lexer(expression).lex().tokens, ["github", "inputs"], []).parse();
      const eligible = new Evaluator(
        ast,
        new data.Dictionary(
          { key: "github", value: github },
          {
            key: "inputs",
            value: new data.Dictionary({
              key: "sweep",
              value: new data.BooleanData(_name === "requested full sweep"),
            }),
          },
        ),
      );
      const fullSweep = id === "unit-tests" || id === "integration-tests" || id === "probe-tests";
      // A request reaches no change's tests; its sweep runs them all.
      const runs = fullSweep ? !change : id === PARTS || id !== "reached-tests" || change;
      expect(eligible.evaluate().coerceString(), id).toBe(String(runs));
      // A no-op success would not solve the problem: keep the real gate and
      // fail on any gate step's failure, without step-level skips beyond the
      // gate's pull request and changed-path steps, the critical path's
      // failure evidence and the steps a branch built on a batch's version
      // skips.
      // INI-9's plan: every job runs where LINUX_RUNNER sends it, the
      // placement service's shell-pc-linux places, and back on GitHub's
      // hosted Linux when the variable is unset.
      // This project's own pull request or push; an outside one is held below.
      const own = { event_name: eventName };
      expect(workflowString(job["runs-on"], { github: own, vars: {} }), id).toBe("ubuntu-24.04");
      expect(
        workflowString(job["runs-on"], { github: own, vars: { LINUX_RUNNER: "shell-pc-linux" } }),
        id,
      ).toBe("shell-pc-linux");
      expect(job["continue-on-error"], id).toBeFalsy();
      expect(
        job.steps.every(
          (step) =>
            !step["continue-on-error"] && (gated.includes(step) || step === evidence || !step.if),
        ),
        id,
      ).toBe(true);
    }
    // INF-2915's plan: the critical path is a step of the build check, so
    // ci.yml calls no other workflow.
    expect(Object.keys(ci.calls)).toEqual([]);
    // Every machine installs from the lockfile before it runs anything but a
    // change's base, notes, size headroom and paths steps, git and plain Node that need no
    // install and read the commits its checkout fetched: a pull request's
    // base parent, and for a pushed branch the commit it left main at; a
    // requested full sweep has no change to compare, and release.yml's notes
    // job covers each change on main. The jobs together run each check once:
    // a change runs the unit tests that read its changed files in the gate,
    // where no unit sweep runs, and a requested sweep runs none there; the
    // sweeps are the next case's.
    const install = "pnpm install --frozen-lockfile";
    const machines = ciJobs(eventName);
    // The base step is the shared action, which reads the ref the change left.
    const from = eventName === "pull_request" ? "HEAD^1" : "origin/main";
    for (const step of bases)
      expect(workflowValue(step.with?.from ?? "", { github: { event_name: eventName } })).toBe(
        from,
      );
    for (const { id, name, runs } of machines)
      expect(runs.slice(0, runs.indexOf(install) + 1), name).toEqual(
        !change || !BRANCH_CHECK.includes(id)
          ? [install]
          : id === "code-checks"
            ? [notes?.run, headroom[0]?.run, phoneFlag?.run, install]
            : [paths?.run, install],
      );
    const checks = machines
      .flatMap(({ runs }) => runs.slice(runs.indexOf(install) + 1))
      .filter((run) => !run.startsWith("pnpm test"));
    expect(checks.toSorted()).toEqual(
      [
        "pnpm build",
        "pnpm check",
        "pnpm typecheck",
        ...(change
          ? [
              count?.run,
              reach?.run,
              criticalPath?.run,
              skips?.run,
              windowMethods?.run,
              windowSkips?.run,
            ]
          : ["pnpm lint:adherence"]),
      ].toSorted(),
    );
    // The browser project runs once: in a change's gate, and in a requested
    // sweep's unit-tests, whose gate runs none.
    const browserRuns = machines.flatMap(({ id, runs }) =>
      runs.filter((run) => /^pnpm test .*--project browser\b/.test(run)).map(() => id),
    );
    expect(browserRuns).toEqual([change ? "reached-tests" : "unit-tests"]);
    // Each job says what started it and what it checks (scripts/ci-job-names.mjs).
    const trigger = { pull_request: "Pull request", push: "Branch push" }[eventName];
    expect(
      machines.filter(({ id }) => BRANCH_CHECK.includes(id)).map(({ id, name }) => [id, name]),
    ).toEqual(
      trigger
        ? [
            ["code-checks", `${trigger} · Code checks (Linux)`],
            ["reached-tests", `${trigger} · Tests a change reaches (Linux)`],
            ["build", `${trigger} · Build and critical path (Linux)`],
          ]
        : [
            ["code-checks", "Manual request · Code checks (Linux)"],
            ["build", "Manual request · Build (Linux)"],
          ],
    );
    // INF-5493: a change whose tests the code checks counted as three parts
    // starts two more machines, after the three, each finding the change's
    // base, installing and running the part its matrix names. A change of
    // one part, and a request, start none.
    const wide = ciJobs(eventName, undefined, undefined, undefined, 3);
    expect(wide.filter(({ id }) => id !== PARTS)).toEqual(machines);
    expect(wide.filter(({ id }) => id === PARTS).map(({ name, runs }) => [name, runs])).toEqual(
      trigger
        ? [2, 3].map((part) => [
            `${trigger} · Tests a change reaches (Linux; part ${part}/3)`,
            [install, later?.run?.replace('"$PART"', `${part}/3`)],
          ])
        : [],
    );
    expect(machines.map(({ id }) => id)).not.toContain(PARTS);
  });

  // The captain's ask on a held batch's repair: "cut whatever is redundant
  // in the repair's path back to the batch ... and we simply rely on them
  // being covered by the batch's checks run". A pushed branch built on a
  // batch's version runs its checkout and its base step, nothing else, so it
  // passes in about a minute; every check it skips runs in the batch's own
  // run (batch-checks.yml), the release notes included. A pull request and a
  // request never name a batch version, so they run as before.
  it("runs only the base step on a branch built on a batch's version", () => {
    const held = "c".repeat(40);
    for (const id of [...BRANCH_CHECK, PARTS]) {
      const steps = loadCi().jobs[id]?.steps ?? [];
      const ran = steps.filter(
        (step) =>
          step.if === undefined ||
          workflowValue(step.if, {
            github: { event_name: "push" },
            steps: {
              base: { outputs: { batch: held } },
              paths: { outputs: {} },
              "critical-path": { outcome: "skipped" },
            },
          }) === true,
      );
      expect(
        ran.map((step) => step.name ?? step.uses?.replace(/@.*/, "")),
        id,
      ).toEqual(["actions/checkout", "Find the change's base"]);
    }
    // The base step is the shared action, so no job runs a script of its own,
    // and the code checks count no parts there, so however wide the change,
    // no later part starts (INF-5493).
    expect(ciJobs("push", false, undefined, held, 3).map(({ id, runs }) => [id, runs])).toEqual(
      BRANCH_CHECK.map((id) => [id, []]),
    );
    // The batch's own run reads the notes and the phone contract flag from
    // the main version the batch left, which the check skips here.
    const notes = loadYamlFile(".github/workflows/batch-checks.yml") as {
      jobs: Record<string, { steps?: Step[] }>;
    };
    expect(notes.jobs.notes?.steps?.flatMap((step) => (step.run ? [step.run] : []))).toEqual([
      'node scripts/release-notes.ts batch --base "$BASE"',
      'node scripts/phone-contract-flag.ts --base "$BASE"',
    ]);
  });

  // INF-2915's plan, the captain's direction B with the light profile: the
  // paths step's two verdicts decide what the pull request's gate runs past
  // its code checks and the unit, integration and browser tests that read a
  // changed file, which every version runs.
  it.each([
    [{ build: true, browser: true }, ["build", "browser", "critical path"]],
    [{ build: true, browser: false }, ["build", "critical path"]],
    [{ build: false, browser: true }, ["browser"]],
    [{ build: false, browser: false }, []],
  ])("runs only what the paths step decided for %j", (paths, expected) => {
    const runs = ciJobs("pull_request", false, paths).flatMap((job) => job.runs);
    const ran = [
      runs.includes("pnpm build") && "build",
      runs.includes("pnpm test --project browser") && "browser",
      runs.some((run) => run.includes("--files tests/e2e/critical-path.spec.ts")) &&
        "critical path",
    ].filter(Boolean);
    expect(ran).toEqual(expected);
    for (const always of ["pnpm typecheck", "pnpm check"]) expect(runs).toContain(always);
    expect(runs.some((run) => run.startsWith("node scripts/unit-repeats.ts --reach "))).toBe(true);
  });

  // INF-2915's plan: the startup fixtures, which caught nothing on 504 pull
  // request runs, leave the pull request; main's check runs them once per
  // push on hosted Ubuntu (linux-startup.yml, docs/testing.md "Linux
  // automatic startup fixtures").
  it("runs the Linux startup fixtures in main's check, not on a pull request", () => {
    const ci = loadCi();
    const fixtures = (job: CiJob) =>
      job.steps.some((step) => step.uses === "./.github/actions/linux-startup");
    expect(Object.values(ci.jobs).filter(fixtures)).toEqual([]);
    const main = loadYamlFile(".github/workflows/main.yml") as {
      jobs: Record<string, { uses?: string }>;
    };
    expect(Object.values(main.jobs).map((job) => job.uses)).toContain(
      "./.github/workflows/linux-startup.yml",
    );
  });

  /**
   * INF-2480's plan (captain: "path six-steps (launch, sign in, project,
   * first mate, crewmate card, merge)", done when "One desktop journey walks
   * the chosen path on Linux on every pull request"), INF-2507, and
   * INF-2915's plan (the captain's direction B: "the critical path inside
   * the build job"): every pull request that builds the app runs the
   * critical-path journey in the desktop lane, in the build check after the
   * build, on the Linux desktop the source desktop workflow prepares the
   * same way.
   */
  it("runs the critical-path journey inside the build check after the build", () => {
    const job = loadCi().jobs.build;
    const steps = job?.steps ?? [];
    const at = (find: (step: Step) => boolean) => steps.findIndex(find);
    const build = at((step) => step.run === "pnpm build");
    const desktop = at((step) => step.uses === "./.github/actions/linux-desktop");
    const journey = at((step) => step.id === "critical-path");
    expect(build).toBeGreaterThan(-1);
    expect(desktop).toBeGreaterThan(build);
    expect(journey).toBeGreaterThan(desktop);
    const step = steps[journey];
    const file = "tests/e2e/critical-path.spec.ts";
    expect(existsSync(join(root, file))).toBe(true);
    expect(laneOf(file)).toBe("desktop");
    // The change against where it starts, its base parent for a pull
    // request's merge commit: an edit to the journey runs it three rounds
    // and alone (scripts/journey-runs.ts).
    expect(step?.run).toBe(
      `scripts/on-screen.sh node scripts/journey-runs.ts --base "$CHANGE_BASE" --files ${file} --alone-out playwright-report/alone -- --project=desktop`,
    );
    // A pull request fetches its merge commit and its base parent; a pushed
    // branch has no merge commit, so it fetches every commit to find the one
    // it left main at (INF-3759's plan, piece 2).
    const checkout = steps.find((candidate) => candidate.uses?.startsWith("actions/checkout@"));
    const depth = (event: string) =>
      workflowValue(String(checkout?.with?.["fetch-depth"]), { github: { event_name: event } });
    expect(depth("pull_request")).toBe(2);
    expect(depth("workflow_dispatch")).toBe(2);
    expect(depth("push")).toBe(0);
    // Every version of a pull request or a pushed branch that builds the
    // app, and no request.
    for (const [event, built, runs] of [
      ["pull_request", "true", true],
      ["pull_request", "false", false],
      ["push", "true", true],
      ["push", "false", false],
      ["workflow_dispatch", "", false],
    ] as const) {
      const contexts = {
        github: { event_name: event },
        steps: { paths: { outputs: { build: built } } },
      };
      expect(workflowValue(steps[desktop]?.if ?? "true", contexts), `${event} ${built}`).toBe(runs);
      expect(workflowValue(step?.if ?? "true", contexts), `${event} ${built}`).toBe(runs);
    }
    const source = loadYamlFile(".github/workflows/source-journeys.yml") as {
      jobs: { "source-desktop": { steps: Step[] } };
    };
    expect(
      source.jobs["source-desktop"].steps.filter((candidate) =>
        candidate.uses?.endsWith("/.github/actions/linux-desktop"),
      ),
    ).toHaveLength(1);
  });

  // DOP-66 fix 1: the rebuilt shell PC image owns the pnpm store;
  // hosted runners still need setup-node's cache. DOP-251's plan: a job
  // LINUX_QUEUES sends to a self-hosted queue, such as the Mac mini's Linux
  // guests whose image bakes the store, restores no cache even while
  // LINUX_RUNNER is unset, so the cache follows the machine, not a variable.
  // Evaluate the real inputs of every Linux job that installs.
  it.each([
    ["hosted Linux", "github-hosted", {}, "pnpm"],
    // INF-2430's plan, piece 1: main's and a release's Linux jobs run hosted
    // while LINUX_RUNNER names the PC, and keep the cache.
    [
      "hosted Linux while LINUX_RUNNER is set",
      "github-hosted",
      { LINUX_RUNNER: "shell-pc-linux" },
      "pnpm",
    ],
    ["shell PC", "self-hosted", { LINUX_RUNNER: "shell-pc-linux" }, ""],
    ["a LINUX_QUEUES queue", "self-hosted", { LINUX_QUEUES: '{"ci":"mini-linux"}' }, ""],
  ])("selects the pnpm cache for %s", (_name, environment, vars, expected) => {
    const installs: string[] = [];
    for (const file of readdirSync(join(root, ".github/workflows")).filter((name) =>
      name.endsWith(".yml"),
    )) {
      const { jobs } = loadYamlFile(`.github/workflows/${file}`) as { jobs: Record<string, CiJob> };
      for (const [id, job] of Object.entries(jobs)) {
        if (!job.steps?.some((step) => step.run?.startsWith("pnpm install"))) continue;
        const setup = job.steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
        const cache = setup?.with?.cache;
        // A literal cache belongs to a Mac job, which runs on its own rules.
        if (typeof cache !== "string" || !cache.includes("${{")) continue;
        installs.push(`${file}:${id}`);
        const contexts = { vars, runner: { environment }, matrix: { lane: "linux-checks" } };
        expect(workflowString(cache, contexts), `${file}:${id}`).toBe(expected);
      }
    }
    expect(installs).toEqual(
      expect.arrayContaining([
        "ci.yml:code-checks",
        "ci.yml:reached-tests",
        "ci.yml:build",
        "ci.yml:unit-tests",
        "ci.yml:integration-tests",
        "ci.yml:probe-tests",
        "replay.yml:replay-gate",
        "verify.yml:lane",
        "verify.yml:linux-tests",
        "linux-packages.yml:build",
        "linux-packages.yml:check",
        "source-journeys.yml:source-desktop",
        "journeys.yml:choose-journeys",
      ]),
    );
  });

  /**
   * FI3-1204 / INF-2224: main runs full sweeps on several machines at once, and
   * split it must still run every test: each vitest project in exactly one
   * job, or in shards of one count that together cover it. The captain
   * explicitly includes every probe, not just affected files.
   */
  const vitestProjects = () => {
    const projects = (vitestConfig.test?.projects ?? []).map((project) => {
      const name =
        typeof project === "object" && "test" in project ? project.test?.name : undefined;
      if (typeof name !== "string") throw new Error("every vitest project is named");
      return name;
    });
    expect(projects).toEqual(
      expect.arrayContaining(["pure", "unit", "unit-isolated", "integration", "probe"]),
    );
    return projects;
  };
  const vitestShards = (jobs: { name: string; runs: string[] }[], projects: string[]) => {
    const shardsOf = new Map<string, string[]>();
    for (const { name, runs } of jobs) {
      for (const run of runs) {
        const [tool, script, ...args] = run.split(/\s+/);
        if (tool !== "pnpm" || script !== "test") continue;
        const selected: string[] = [];
        let shard = "whole";
        for (let index = 0; index < args.length; index++) {
          const arg = args[index] ?? "";
          if (arg === "--project") selected.push(args[++index] ?? "");
          else if (arg.startsWith("--shard=")) shard = arg.slice("--shard=".length);
          else throw new Error(`${name} passes vitest an argument this check cannot read: ${arg}`);
        }
        for (const project of selected.length > 0 ? selected : projects) {
          shardsOf.set(project, [...(shardsOf.get(project) ?? []), shard]);
        }
      }
    }
    return shardsOf;
  };
  const coversOnce = (shards: string[]) => {
    const whole = shards.length === 1 && shards[0] === "whole";
    const cover = shards.map((_, index) => `${index + 1}/${shards.length}`);
    return whole || shards.toSorted().join() === cover.toSorted().join();
  };

  it("runs every vitest project once across ci.yml's sweep jobs, a sharded one in shards that cover it", () => {
    const projects = vitestProjects();
    const shardsOf = vitestShards(ciJobs("workflow_dispatch"), projects);
    expect([...shardsOf.keys()].toSorted()).toEqual(projects.toSorted());
    expect(shardsOf.get("probe")).toEqual(["whole"]);
    for (const [project, shards] of shardsOf) expect(coversOnce(shards), project).toBe(true);
  });

  /**
   * INF-2646 (the captain approved INF-2641's split of main's Linux tests
   * across GitHub's hosted machines): verify.yml's Linux test groups run every
   * vitest project, each in one group or in shards of one count that
   * together cover it, every probe included, so the split loses no file.
   * Each group is a machine of its own, and one red group skips no other.
   */
  it("runs every vitest project once across verify.yml's Linux test groups, a sharded one in shards that cover it", () => {
    const projects = vitestProjects();
    for (const inputs of [{}, { part: "checks", hosted: true, all_journeys: false }]) {
      const groups = verifyLinuxTests(inputs);
      expect(groups.map(({ name }) => name)).toEqual([
        "Manual request · Unit tests (Linux; group 1/3)",
        "Manual request · Unit tests (Linux; group 2/3)",
        "Manual request · Unit tests (Linux; group 3/3)",
        "Manual request · Integration tests (Linux; group 1/2)",
        "Manual request · Integration tests (Linux; group 2/2)",
        "Manual request · Environment checks (Linux; group 1/2)",
        "Manual request · Environment checks (Linux; group 2/2)",
        "Manual request · Browser tests (Linux)",
      ]);
      const shardsOf = vitestShards(groups, projects);
      expect([...shardsOf.keys()].toSorted()).toEqual(projects.toSorted());
      for (const [project, shards] of shardsOf) expect(coversOnce(shards), project).toBe(true);
      // Every probe, in two groups that cover them, never a changed-path selection.
      expect(shardsOf.get("probe")?.toSorted()).toEqual(["1/2", "2/2"]);
      for (const { name, steps } of groups) {
        const tools = steps.findIndex(({ uses }) => uses?.endsWith("/linux-test-tools"));
        if (name.includes("Integration tests")) {
          expect(tools, name).toBeGreaterThanOrEqual(0);
          expect(tools, name).toBeLessThan(
            steps.findIndex(({ run }) => run?.startsWith("pnpm test ")),
          );
        } else {
          expect(tools, name).toBe(-1);
        }
      }
      const browser = groups.find(({ name }) => name.includes("Browser tests"))?.steps ?? [];
      const chromium = browser.findIndex(({ uses }) =>
        uses?.endsWith("/.github/actions/browser-chromium"),
      );
      expect(chromium).toBeGreaterThanOrEqual(0);
      expect(browser.findIndex(({ run }) => run?.startsWith("pnpm test "))).toBeGreaterThan(
        chromium,
      );
    }
    // The journeys part, and an installer check, run none of them.
    expect(verifyLinuxTests({ part: "journeys" })).toEqual([]);
    expect(verifyLinuxTests({ installer_only: true })).toEqual([]);
    expect(verifyLinuxTests({ installer_reuse: "reviewed declaration" })).toEqual([]);
    const job = (loadYamlFile(".github/workflows/verify.yml") as { jobs: Record<string, CiJob> })
      .jobs["linux-tests"];
    expect(job?.strategy?.["fail-fast"]).toBe(false);
    // Each group's test step keeps the full check's 60-minute limit.
    const test = job?.steps.find((step) => step.run?.startsWith("pnpm test "));
    expect(test?.["timeout-minutes"]).toBe(60);
  });
});

/**
 * INF-5379's plan, piece 2 (the captain chose to file it: "each round saves 30
 * to 40 minutes, and a bad repair is caught one rerun later"): a held batch's
 * repair is built on the batch's version, so its own check measures it from
 * that version, never the whole batch from main. The captain's later ask
 * ("we simply rely on them being covered by the batch's checks run") has the
 * step name that version as its `batch` output, which every later step skips
 * on. The real step's script runs against a scratch clone whose origin holds
 * main and two batch branches, as a pushed branch's full checkout fetches
 * them.
 */
describe("the change's base (ci.yml)", () => {
  // The three jobs share one composite action; its script is what runs.
  const action = loadYamlFile(".github/actions/change-base/action.yml") as {
    runs: { steps: { run?: string }[] };
  };
  const step = action.runs.steps[0];

  function scratch() {
    const dir = scratchDir("infinitary-change-base-");
    const env = {
      PATH: process.env.PATH,
      HOME: dir,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@localhost",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@localhost",
    };
    const work = join(dir, "work");
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: work, env, encoding: "utf8" }).trim();
    const commit = (file: string) => {
      writeFileSync(join(work, file), `${file}\n`);
      git("add", "-A");
      git("commit", "-q", "-m", `feat: ${file}`);
      return git("rev-parse", "HEAD");
    };
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", join(dir, "origin.git")], { env });
    execFileSync("git", ["clone", "-q", join(dir, "origin.git"), work], { env });
    git("checkout", "-q", "-b", "main");
    /**
     * Pushes and fetches as the checkout does, then runs the step at HEAD:
     * the base it hands later steps, and the batch version it names, if any.
     */
    const changeBase = () => {
      git("push", "-q", "--force", "--all", "origin");
      git("fetch", "-q", "--prune", "origin");
      const files = {
        GITHUB_ENV: join(dir, "github-env"),
        GITHUB_OUTPUT: join(dir, "github-output"),
      };
      for (const file of Object.values(files)) writeFileSync(file, "");
      execFileSync("bash", ["-e", "-c", step?.run ?? "false"], {
        cwd: work,
        env: { ...env, FROM: "origin/main", ...files },
        stdio: ["ignore", "ignore", "inherit"],
      });
      return {
        env: readFileSync(files.GITHUB_ENV, "utf8").trim(),
        output: readFileSync(files.GITHUB_OUTPUT, "utf8").trim(),
      };
    };
    return { git, commit, changeBase };
  }

  it("starts a held batch's repair at the batch's version, and keeps it there on a later push", () => {
    const { git, commit, changeBase } = scratch();
    commit("main.txt");
    git("checkout", "-q", "-b", "infinitary-batch/7");
    commit("change-1.txt");
    const held = commit("change-2.txt");
    git("checkout", "-q", "main");
    commit("main-later.txt");
    git("checkout", "-q", "-b", "inf/repair-held", held);
    commit("repair.txt");
    const repair = { env: `CHANGE_BASE=${held}`, output: `batch=${held}` };
    expect(changeBase()).toEqual(repair);
    commit("repair-again.txt");
    expect(changeBase()).toEqual(repair);
  });

  it("starts at the newest batch version the branch is built on", () => {
    const { git, commit, changeBase } = scratch();
    commit("main.txt");
    git("checkout", "-q", "-b", "infinitary-batch/older");
    commit("change-1.txt");
    git("checkout", "-q", "-b", "infinitary-batch/newer");
    const newer = commit("change-2.txt");
    git("checkout", "-q", "-b", "inf/repair-newer");
    commit("repair.txt");
    expect(changeBase()).toEqual({ env: `CHANGE_BASE=${newer}`, output: `batch=${newer}` });
  });

  it("starts an ordinary branch where it left main, beside a batch it is not built on", () => {
    const { git, commit, changeBase } = scratch();
    const left = commit("main.txt");
    git("checkout", "-q", "-b", "infinitary-batch/7");
    commit("change-1.txt");
    git("checkout", "-q", "main");
    git("checkout", "-q", "-b", "inf/ordinary");
    commit("ordinary.txt");
    git("checkout", "-q", "main");
    commit("main-later.txt");
    git("checkout", "-q", "inf/ordinary");
    // It names no batch version, so its check runs every step.
    expect(changeBase()).toEqual({ env: `CHANGE_BASE=${left}`, output: "" });
  });
});

// INF-4960 kept outside pull requests off the project's runners by skipping
// them; the captain's choice on INF-5002, "Contributors run on GitHub; you
// approve each", runs them on GitHub's own machines instead (docs/public-ci.md,
// "Outside contributors"). The workflow contract is checked here; the owner's
// approval of each outside run is the host's gate.
describe("public CI admission", () => {
  const repository = "infinitary-labs/infinitary-apps";
  const contributor = "contributor/infinitary-apps";
  const paths = [
    ".github/workflows/ci.yml",
    ".github/workflows/docs-site.yml",
    ".github/workflows/batch-pull-request.yml",
    ".github/workflows/contributors.yml",
  ];
  type Job = {
    if?: string;
    needs?: string;
    "runs-on"?: string;
    strategy?: { matrix?: Record<string, unknown> | string };
    uses?: string;
    with?: Record<string, unknown>;
  };
  const jobsOf = (path: string) => loadYamlFile(path).jobs as Record<string, Job>;
  const pullRequest = (headRepo: string, branch: string) => ({
    event_name: "pull_request",
    repository,
    head_ref: branch,
    base_ref: "main",
    sha: "a".repeat(40),
    ref: "refs/pull/1/merge",
    run_attempt: "1",
    event: {
      repository: { default_branch: "main" },
      pull_request: { head: { repo: { full_name: headRepo } } },
    },
  });
  /** The jobs a pull request starts on its own, before any job's outputs. */
  function admitted(headRepo: string, branch: string) {
    const github = pullRequest(headRepo, branch);
    return paths.map((path) => {
      const jobs = jobsOf(path);
      return Object.keys(jobs).filter((name) => {
        const job = jobs[name];
        if (job?.needs) return false;
        return !job?.if || workflowValue(job.if, { github, inputs: { sweep: false } });
      });
    });
  }
  // Every routing variable naming one of the project's own machines.
  const ownMachines = {
    LINUX_RUNNER: "shell-pc-linux",
    LINUX_QUEUES: JSON.stringify(
      Object.fromEntries(
        ["light", "light_gate", "ci", "gate", "checks", "typecheck"].map((kind) => [
          kind,
          `q-${kind}`,
        ]),
      ),
    ),
    MAC_RUNNER: "mini-mac-any",
    MAC_QUEUES: JSON.stringify({ journeys: "q-journeys", split: "q-split", light: "q-light" }),
    WINDOWS_RUNNER: "shell-pc-windows",
    WINDOWS_CLEAN_RUNNER: "shell-pc-win11",
  };
  const hostedLabel = /^(ubuntu-2\d\.04|macos-\d+|windows-20\d\d)$/;

  it("starts an outside pull request's checks, never the batch, even on a batch-like branch", () => {
    for (const branch of ["inf/ordinary", "infinitary-batch/reviewed"])
      expect(admitted(contributor, branch), branch).toEqual([
        [...BRANCH_CHECK],
        ["build-and-check"],
        [],
        ["paths"],
      ]);
  });

  it("runs every job an outside pull request reaches on GitHub's own machines", () => {
    const github = pullRequest(contributor, "inf/ordinary");
    const reached: string[] = [];
    const runner = (
      where: string,
      job: Job | undefined,
      inputs: Record<string, unknown>,
      matrix: Record<string, unknown> = {},
    ) => {
      const value = job?.["runs-on"] ?? "";
      const label = !value.includes("${{")
        ? value
        : workflowValue(value, { github, inputs, vars: ownMachines, matrix });
      reached.push(`${where} ${label}`);
      expect(label, where).toMatch(hostedLabel);
    };
    /** Each matrix a job's lanes take, from its declared values or its expression. */
    const lanes = (job: Job, inputs: Record<string, unknown>): Record<string, unknown>[] => {
      const matrix = job.strategy?.matrix;
      if (!matrix || typeof matrix === "string") return [{}];
      const rows: Record<string, unknown>[] = [];
      for (const [key, declared] of Object.entries(matrix)) {
        const value =
          typeof declared === "string" && declared.includes("${{")
            ? workflowValue(declared, { github, inputs, vars: ownMachines })
            : declared;
        if (!Array.isArray(value)) continue;
        if (key === "include") rows.push(...value);
        else rows.push(...value.map((one) => ({ [key]: one })));
      }
      return rows.length ? rows : [{}];
    };
    /** Every job a call reaches, with the inputs GitHub gives it: the caller's, over the defaults. */
    const follow = (file: string, passed: Record<string, unknown>) => {
      const workflow = loadYamlFile(file) as {
        on: { workflow_call?: { inputs?: Record<string, { default?: unknown }> } };
        jobs: Record<string, Job>;
      };
      const defaults = Object.fromEntries(
        Object.entries(workflow.on.workflow_call?.inputs ?? {}).map(([name, input]) => [
          name,
          input.default ?? null,
        ]),
      );
      const inputs = { ...defaults, ...passed };
      for (const [jobId, job] of Object.entries(workflow.jobs)) {
        const where = `${file}:${jobId}`;
        // A job the call skips by its own condition takes no machine; one
        // that waits on an earlier job's outputs is counted as reached.
        if (job.if && !job.if.includes("needs.") && !workflowValue(job.if, { github, inputs }))
          continue;
        if (job.uses) {
          const given = Object.fromEntries(
            Object.entries(job.with ?? {}).map(([name, value]) => [
              name,
              // A whole expression is read; text around one, such as an
              // artifact name, decides no machine and passes on as written.
              typeof value === "string" && /^\$\{\{[^}]*\}\}$/.test(value.trim())
                ? workflowValue(value, { github, inputs, matrix: {}, strategy: {} })
                : value,
            ]),
          );
          follow(String(job.uses).replace("./", ""), given);
          continue;
        }
        for (const matrix of lanes(job, inputs))
          runner([where, ...Object.values(matrix).map(String)].join(" "), job, inputs, matrix);
      }
    };
    const [ci = {}, docs = {}, , contributors = {}] = paths.map(jobsOf);
    for (const id of BRANCH_CHECK) runner(`ci.yml:${id}`, ci[id], { sweep: false });
    runner("docs-site.yml:build-and-check", docs["build-and-check"], {});
    runner("contributors.yml:paths", contributors.paths, {});
    const calls = Object.entries(contributors).filter(([, job]) => job.uses);
    expect(calls.map(([id, job]) => `${id} ${job.uses}`)).toEqual([
      "sweep ./.github/workflows/verify.yml",
      "journeys ./.github/workflows/journeys.yml",
      "startup ./.github/workflows/linux-startup.yml",
      "windows ./.github/workflows/windows.yml",
    ]);
    for (const [, call] of calls) follow(String(call.uses).replace("./", ""), { ...call.with });
    // The batch's Mac lanes reached GitHub's Mac, its Linux test groups and
    // journeys hosted Ubuntu, and the Windows build GitHub's Windows; the
    // PC's fresh Windows 11 check and the signed installer checks took none.
    // On GitHub's Macs the parallel journeys are four jobs.
    for (const lane of [
      "mac",
      "parallel-1",
      "parallel-2",
      "parallel-3",
      "parallel-4",
      "desktop-1",
      "desktop-2",
    ])
      expect(reached).toContain(`.github/workflows/verify.yml:lane ${lane} macos-15`);
    expect(reached).toContain(".github/workflows/verify.yml:lane linux-checks ubuntu-24.04");
    expect(
      reached.some((line) => /verify\.yml:linux-tests Unit tests .* ubuntu-24\.04$/.test(line)),
    ).toBe(true);
    expect(reached).toContain(
      ".github/workflows/source-journeys.yml:source-desktop desktop 3 3 ubuntu-24.04",
    );
    // The edited journeys' rounds reached hosted Ubuntu and GitHub's Mac, and
    // the request-replacing job, which only a request needs, took none.
    expect(reached).toContain(".github/workflows/journeys.yml:choose-journeys ubuntu-24.04");
    expect(reached).toContain(".github/workflows/journeys.yml:affected-journeys macos-15");
    expect(reached.some((line) => line.includes("replace-older-request"))).toBe(false);
    expect(reached).toContain(".github/workflows/linux-startup.yml:runtime-facts ubuntu-24.04");
    expect(reached).toContain(".github/workflows/windows.yml:build windows-2025");
    expect(reached.some((line) => line.startsWith(".github/workflows/windows.yml:check"))).toBe(
      false,
    );
    expect(reached.some((line) => line.includes("mac-installer.yml"))).toBe(false);
  });

  // The captain's route on INF-3559: "GitHub's machines run your batch's
  // tests, then you merge their pull request". The outside run calls each
  // workflow the batch calls, its sweep with the batch's selection, and
  // differs only in where it runs: the critical path runs among the sweep's
  // every Linux journey and in the branch check, and no failed test is
  // confirmed again, since the owner reads the run.
  it("runs the swept batch's selection on an outside pull request", () => {
    const batch = jobsOf(".github/workflows/batch-checks.yml");
    const contributors = jobsOf(".github/workflows/contributors.yml");
    const called = (jobs: Record<string, Job>) =>
      new Set(Object.values(jobs).flatMap((job) => (job.uses ? [job.uses] : [])));
    const outside = called(contributors);
    for (const uses of called(batch))
      if (uses !== "./.github/workflows/source-journeys.yml")
        expect(outside.has(uses), uses).toBe(true);
    const selection = (job: Job | undefined) => {
      const { trigger, ref, mac_runner, fleet_tests, confirm, ...rest } = job?.with ?? {};
      return rest;
    };
    expect(selection(contributors.sweep)).toEqual(selection(batch.sweep));
    expect(contributors.sweep?.with?.mac_runner).toBe("macos-15");
  });

  it("keeps the ordinary and swept internal PR routes, and starts no contributor job", () => {
    expect(admitted(repository, "inf/ordinary")).toEqual([
      [...BRANCH_CHECK],
      ["build-and-check"],
      [],
      [],
    ]);
    expect(admitted(repository, "infinitary-batch/reviewed")).toEqual([
      [],
      ["build-and-check"],
      ["checks"],
      [],
    ]);
  });
});
