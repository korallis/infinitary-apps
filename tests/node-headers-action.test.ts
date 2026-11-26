import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hostEnv } from "../src/core/hostEnv";
import { loadYamlFile } from "./helpers/releaseWorkflows";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * Intent: an install of the project's current source asks nothing of the
 * machine's Node headers. The headers step ran before every Linux install and
 * failed the job on an image without them, though the install compiles
 * nothing since pnpm-workspace.yaml turned better-sqlite3's build off.
 *
 * A workflow given its source by a ref of its own can still be handed a
 * release from before that, whose install starts node-gyp. For such a source
 * the step finds the headers beside Node, or fails rather than leave node-gyp
 * to download them.
 *
 * The step runs before the install, with no YAML reader yet, and tells the two
 * kinds of source apart from the settings file's lines. Only the top-level
 * allowBuilds list speaks for the install: a line reading the same under
 * another key or in a block of text does not, and neither does the list once
 * it names the module twice or another setting allows every build. A source
 * the step took for one that builds nothing would start node-gyp with no
 * headers set up for it.
 *
 * These run the action's own shell step as a runner does, in a source's
 * folder, with a copy of this Node in a folder that has, or lacks, the headers
 * a Node archive ships.
 */

const repoRoot = join(__dirname, "..");
const actionPath = join(repoRoot, ".github", "actions", "node-headers");
const { runs } = loadYamlFile(".github/actions/node-headers/action.yml") as {
  runs: { steps: [find: { run: string }] };
};
const [find] = runs.steps;

// The step ends within seconds. A synchronous wait holds the worker where the
// test's own limit cannot reach it, so a step that never ends is stopped here.
const STEP_DEADLINE_MS = 30_000;

const HEADERS = ["node.h", "common.gypi", "config.gypi"];
const SETTINGS = "pnpm-workspace.yaml";

describe(".github/actions/node-headers", () => {
  let folder: string;
  /** A Node archive's layout: bin/node, and include/node only where it ships headers. */
  let withHeaders: string;
  let withoutHeaders: string;
  let current: string;
  let stillBuilds: string;
  let noSettings: string;
  let offInTextElsewhere: string;
  let offInAnotherList: string;
  let offButAllowsAll: string;
  let namedTwice: string;
  let listIsText: string;

  function nodeRoot(name: string, headers: boolean): string {
    const root = join(folder, name);
    mkdirSync(join(root, "bin"), { recursive: true });
    copyFileSync(process.execPath, join(root, "bin", basename(process.execPath)));
    if (headers) {
      mkdirSync(join(root, "include", "node"), { recursive: true });
      for (const header of HEADERS) writeFileSync(join(root, "include", "node", header), "");
    }
    return realpathSync(root);
  }

  function source(name: string, settings?: string): string {
    const checkout = join(folder, name);
    mkdirSync(checkout, { recursive: true });
    if (settings !== undefined) writeFileSync(join(checkout, SETTINGS), settings);
    return checkout;
  }

  beforeAll(() => {
    folder = scratchDir("infinitary-node-headers-");
    withHeaders = nodeRoot("node-with-headers", true);
    withoutHeaders = nodeRoot("node-without-headers", false);
    const settings = readFileSync(join(repoRoot, SETTINGS), "utf8");
    current = source("current", settings);
    // The same settings as they stood while the install still built the module.
    const before = settings.replace(/^( +better-sqlite3:) false$/m, "$1 true");
    expect(before).not.toBe(settings);
    stillBuilds = source("still-builds", before);
    // An earlier release kept its build allowances in package.json.
    noSettings = source("no-settings");
    const off = "  better-sqlite3: false\n";
    expect(settings).toContain(`\n${off}`);
    // The list still allows the build; the same words as the setting that
    // turns it off stand outside the list.
    offInTextElsewhere = source("off-in-text-elsewhere", `${before}note: |\n${off}`);
    offInAnotherList = source("off-in-another-list", `${before}catalog:\n${off}`);
    // pnpm 11 runs every build under this setting, whatever the list says.
    offButAllowsAll = source("off-but-allows-all", `dangerouslyAllowAllBuilds: true\n${settings}`);
    // pnpm also matches a package by name and version, so the list's word on
    // the module is no longer one line's.
    namedTwice = source(
      "named-twice",
      settings.replace(`\n${off}`, `\n${off}  better-sqlite3@13.0.3: true\n`),
    );
    // The same lines as text: the key holds no list for pnpm to read.
    const opens = "\nallowBuilds:\n";
    expect(settings).toContain(opens);
    listIsText = source("list-is-text", settings.replace(opens, `${opens}  |\n`));
  });

  afterAll(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  /** The step on a Linux runner whose Node sits in `node`, about to install `checkout`. */
  function runStep(checkout: string, node: string) {
    const exported = join(scratchDir("infinitary-node-headers-env-"), "github-env");
    writeFileSync(exported, "");
    const ended = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", find.run], {
      cwd: checkout,
      encoding: "utf8",
      timeout: STEP_DEADLINE_MS,
      env: {
        ...hostEnv(),
        PATH: `${join(node, "bin")}${delimiter}${hostEnv().PATH ?? ""}`,
        RUNNER_OS: "Linux",
        GITHUB_ACTION_PATH: actionPath,
        GITHUB_ENV: exported,
      },
    });
    return {
      error: ended.error?.message,
      status: ended.status,
      stderr: ended.stderr,
      exported: readFileSync(exported, "utf8"),
    };
  }

  it("asks nothing of a source that keeps the database module's build off", () => {
    expect(runStep(current, withoutHeaders)).toEqual({
      error: undefined,
      status: 0,
      stderr: "",
      exported: "",
    });
  });

  it.each([
    ["still allows the build", () => stillBuilds],
    ["has no settings file", () => noSettings],
    ["allows the build beside a block of text that reads as off", () => offInTextElsewhere],
    ["allows the build beside another list that reads as off", () => offInAnotherList],
    ["keeps the build off in the list but allows every build", () => offButAllowsAll],
    ["names the module twice in the list", () => namedTwice],
    ["writes the list as a block of text that reads as off", () => listIsText],
  ])("gives the headers beside Node to a source that %s", (_, checkout) => {
    expect(runStep(checkout(), withHeaders)).toEqual({
      error: undefined,
      status: 0,
      stderr: "",
      exported: `INFINITARY_NODE_HEADERS=${withHeaders}\n`,
    });
  });

  it("stops a source that still builds when Node came without its headers", () => {
    const ended = runStep(stillBuilds, withoutHeaders);
    expect({ error: ended.error, status: ended.status, exported: ended.exported }).toEqual({
      error: undefined,
      status: 1,
      exported: "",
    });
    expect(ended.stderr).toContain("include/node/node.h is missing");
  });
});
