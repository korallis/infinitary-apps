import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  adherenceStep,
  baseRef,
  biomeStep,
  checkScripts,
  LANE_MEMORY_BYTES,
  packageProgram,
  quickCheckLanes,
  runsOf,
  sideBySide,
} from "../scripts/check-changed.ts";
import { ciModeRefusal } from "../scripts/checks-mode.ts";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * INF-800, the captain's approval: "Only the heavy checks: journeys, the
 * phone check and the replay gate". Anyone building Infinitary runs them on
 * their own computer; the git setting infinitary.checks = ci sends them
 * through CI, and inside CI they always run (docs/testing.md, "Where the
 * heavy checks run"). INF-2074 added typecheck and lint; INF-2273 leaves
 * every edited unit file's three total rounds local, outside this setting. Each case runs the real command a person types,
 * with a scratch home whose git settings stand in for the person's own.
 */
const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;

function computer(setting?: string) {
  const home = scratchDir("infinitary-checks-mode-");
  const global = join(home, ".gitconfig");
  writeFileSync(global, setting ? `[infinitary]\n\tchecks = ${setting}\n` : "");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    CFFIXED_USER_HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: global,
    GIT_CONFIG_NOSYSTEM: "1",
    CI: "",
    INFINITARY_CHECKS: "",
  };
  const run = (command: string, extra: NodeJS.ProcessEnv = {}) =>
    spawnSync("bash", ["-c", command], { encoding: "utf8", env: { ...env, ...extra } });
  return { home, run };
}

describe("where the heavy checks run", () => {
  // INF-2259's accepted native exception keeps the global setting and all
  // unrelated checks unchanged; the real launcher still validates file filters.
  it("allows only admitted, explicitly Mac-tagged selected journeys in CI mode", () => {
    const env = {
      INFINITARY_CHECKS: "ci",
      INFINITARY_SELECTED_MAC: "1",
      INFINITARY_LOAD_HOLD: "selected-native-proof",
    };
    const args = ["--no-deps", "--grep", "@mac-only", "tests/e2e/devices.spec.ts"];
    expect(ciModeRefusal("journeys", env, process.cwd(), args) === undefined).toBe(
      process.platform === "darwin",
    );
    expect(
      ciModeRefusal("journeys", { ...env, INFINITARY_LOAD_HOLD: "" }, process.cwd(), args),
    ).toContain("journeys.yml");
    expect(ciModeRefusal("journeys", env, process.cwd(), ["tests/e2e/devices.spec.ts"])).toContain(
      "journeys.yml",
    );
    expect(ciModeRefusal("phone", env, process.cwd(), args)).toContain("phone.yml");
    expect(ciModeRefusal("typecheck", env, process.cwd(), args)).toContain("code-checks");
  });
  it("runs them here by default", () => {
    const { run } = computer();
    for (const check of ["journeys", "phone", "replay-gate", "typecheck", "lint"]) {
      const result = run(`node scripts/checks-mode.ts ${check}`);
      expect(result.status, result.stderr).toBe(0);
    }
  });

  it("refuses the phone check and the replay gate outside CI with the setting on, naming each route", () => {
    const { home, run } = computer("ci");
    const phone = run(`${scripts["test:phone"]} --evidence ${join(home, "evidence")}`);
    expect(phone.status).toBe(1);
    expect(phone.stderr).toContain("phone.yml/dispatches");
    // It refuses before it waits for the Mac check lease.
    expect(existsSync(join(home, "Library/Caches/infinitary-ci"))).toBe(false);
    const replay = run(`${scripts["replay:gate"]} --out ${join(home, "replay-report.json")}`);
    expect(replay.status).toBe(1);
    expect(replay.stderr).toContain("replay.yml/dispatches");
    expect(existsSync(join(home, "replay-report.json"))).toBe(false);
  });

  // Each refuses in its first command, so neither the checker nor a lint starts.
  it("refuses the typecheck and every lint outside CI with the setting on, naming the pull request's check", () => {
    const { run } = computer("ci");
    for (const script of ["typecheck", "check", "lint", "lint:adherence"]) {
      const result = run(scripts[script] ?? "");
      expect(result.status, script).toBe(1);
      expect(result.stderr, script).toContain("code-checks");
      expect(result.stderr, script).toContain("ci.yml/dispatches");
      expect(result.stdout + result.stderr, script).not.toMatch(/Checked \d+ files|tsrs/);
    }
  });

  // INF-2588 fix 1: a crewmate on a CI-mode computer still lints its changed files before it pushes.
  it("lints changed files and checks generated files in CI mode instead of refusing", () => {
    const { run } = computer("ci");
    const result = run(scripts["check:changed"] ?? "");
    expect(result.stdout).toMatch(/check:changed: \d+ changed file/);
    expect(result.stderr).not.toContain("code-checks");
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  // The bug the branch check's Linux runner found: the quick check started
  // every step at once, about thirty programs with the typecheck among them,
  // and on its two processors the kernel ended the largest test beside this
  // file for memory. The full lint's own node scripts stand in for the steps.
  it("starts only as many steps at once as the job has cores, and answers in their order", async () => {
    const steps = checkScripts(scripts.check ?? "").map((args) => ({
      label: args.join(" "),
      command: "node",
      args,
    }));
    expect(steps.length).toBeGreaterThan(2);
    let running = 0;
    let most = 0;
    const results = await sideBySide(steps, 2, async (step) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((turn) => setImmediate(turn));
      running -= 1;
      return step.label;
    });
    expect(most).toBe(2);
    expect(results).toEqual(steps.map((step) => step.label));
  });

  // INF-5001, the bug a compute Mac's Linux guest found: one step per core started
  // eleven Vite runners and checks there, and with the three files the integration
  // cohort ran beside this one, the guest ran out of memory and every process
  // stalled past Vite's 60-second module fetch. The guest's own readings, 11
  // cores and 9,065 MiB of memory with no swap, stand in for the computer.
  it("starts no more steps at once than the computer's memory holds, each as large as the largest", () => {
    const guest = { cores: 11, memoryBytes: 9065 * 1024 ** 2 };
    const lanes = quickCheckLanes(guest);
    expect(lanes * LANE_MEMORY_BYTES).toBeLessThanOrEqual(guest.memoryBytes);
    expect(lanes).toBeLessThan(guest.cores);
    expect(lanes).toBeGreaterThan(1);
    // A Mac with 14 cores and 64 GiB still runs one step per core.
    expect(quickCheckLanes({ cores: 14, memoryBytes: 64 * 1024 ** 3 })).toBe(14);
  });

  // INF-3297: the quick check gave Biome only ts, tsx, json and md files, so a
  // formatting slip in a changed .mjs queue source passed it and failed the
  // pull request's full lint. The project's own files stand in for a branch's
  // changes: one tracked file of each kind in each top folder.
  it("hands Biome every changed file the full lint would check", () => {
    const sample = new Map<string, string>();
    for (const file of execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n")) {
      const kind = `${file.includes("/") ? file.split("/")[0] : "."} ${extname(file)}`;
      if (file && !sample.has(kind)) sample.set(kind, file);
    }
    const files = [...sample.values()];
    // Biome names the files it checked when asked to be verbose.
    const checked = (command: string, args: string[]) => {
      const result = spawnSync(command, [...args, "--verbose"], { encoding: "utf8" });
      const listed = (result.stdout + result.stderr).split("Files processed:")[1] ?? "";
      const names = (listed.split("Files fixed:")[0] ?? "").matchAll(/^\s*- (.+)$/gm);
      return [...names].map(([, file]) => file ?? "").sort();
    };
    // The paths as the full lint's Biome takes them, with no word on which to check.
    const full = checked("node", [
      packageProgram("@biomejs/biome", "biome"),
      "check",
      "--no-errors-on-unmatched",
      ...files,
    ]);
    const mjs = full.filter((file) => file.endsWith(".mjs"));
    expect(mjs, full.join(" ")).not.toEqual([]);
    const step = biomeStep(files);
    expect(step).toBeDefined();
    expect(checked(step?.command ?? "", step?.args ?? [])).toEqual(full);
  });

  // The bug a Windows PC found: the quick check started Biome and the
  // adherence lint as `pnpm exec`, and pnpm there is a .cmd file, which Node
  // starts only through a shell, so both steps answered `spawn pnpm ENOENT`
  // and linted nothing. One of the project's own renderer files stands in for
  // a branch's change, and ESLint's JSON report names each file it judged.
  it("starts the adherence lint on the changed renderer files as a program of its own", () => {
    const [file = ""] = execFileSync("git", ["ls-files", "src/renderer/*.tsx"], {
      encoding: "utf8",
    }).split("\n");
    const step = adherenceStep([file]);
    const result = spawnSync(step?.command ?? "", [...(step?.args ?? []), "--format", "json"], {
      encoding: "utf8",
    });
    expect(result.error?.message).toBeUndefined();
    const judged = (JSON.parse(result.stdout) as { filePath: string }[]).map(({ filePath }) =>
      relative(process.cwd(), filePath).split(sep).join("/"),
    );
    expect(judged).toEqual([file]);
  });

  // A lint whose package cannot be read is that lint's failure, as a lint that
  // finds an error is, and the checks after it still run and report. A folder
  // with no packages installed stands in for the package that cannot be read.
  it("reports a lint whose package it cannot read as that step's failure and runs the checks after it", () => {
    const quickCheck = pathToFileURL(resolve("scripts/check-changed.ts")).href;
    const script = `
      import { adherenceStep, biomeStep, run, sideBySide } from ${JSON.stringify(quickCheck)};
      const next = { label: "next", command: "node", args: ["-e", "console.log('the next check ran')"] };
      const results = await sideBySide([biomeStep(["a.ts"]), adherenceStep(["a.ts"]), next], 1, run);
      console.log(JSON.stringify(results.map(({ step, ok, output }) => [step.label, ok, output])));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], {
      cwd: scratchDir("infinitary-no-packages-"),
      encoding: "utf8",
    });
    const results = JSON.parse(result.stdout || "[]") as [string, boolean, string][];
    expect(
      results.map(([label, ok]) => [label, ok]),
      result.stderr,
    ).toEqual([
      ["biome", false],
      ["adherence", false],
      ["next", true],
    ]);
    expect(results[0]?.[2]).toContain("biome");
    expect(results[1]?.[2]).toContain("eslint");
    expect(results[2]?.[2]).toContain("the next check ran");
  });

  // The bug a wide change meets on a Windows PC: Windows starts a program with
  // a command line of at most 32,767 characters, and Biome was handed every
  // changed file in one, so past about 650 files it answered
  // `spawn ENAMETOOLONG`. Every file of the project stands in for the change.
  it("hands a lint only as many changed files at once as a Windows command line holds", () => {
    const files = execFileSync("git", ["ls-files"], { encoding: "utf8", maxBuffer: 64 * 1024 ** 2 })
      .split("\n")
      .filter(Boolean);
    const runs = runsOf(files, "win32");
    expect(runs.flat()).toEqual(files);
    for (const some of runs) {
      const step = biomeStep(some);
      const line = [step?.command, ...(step?.args ?? [])].map((word) => `"${word}"`).join(" ");
      expect(line.length).toBeLessThan(32_767);
    }
    // The budget is Windows's own: on Linux and macOS a lint takes every
    // file in one run and reports on them together.
    expect(runsOf(files, "linux")).toEqual([files]);
    expect(runsOf(files, "darwin")).toEqual([files]);
  });

  // The bug a main check found: its push checkout holds one commit and no main
  // branch, and the quick check took the word HEAD for a commit since main, so
  // it ran the release-notes check on nothing and refused.
  it("takes a checkout with no main branch to have nothing committed since main", () => {
    const { home, run } = computer();
    const repo = join(home, "repo");
    const made = run(
      `git init -q -b work "${repo}" && git -C "${repo}" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m one`,
    );
    expect(made.status, made.stderr).toBe(0);
    expect(baseRef(repo)).toBe(run(`git -C "${repo}" rev-parse HEAD`).stdout.trim());
  });

  // The real runner boots in about a second.
  it("refuses a committed journey outside CI with the setting on, before setup", () => {
    const { run } = computer("ci");
    const result = run(
      "node node_modules/@playwright/test/cli.js test --no-deps tests/e2e/phase0-guardrails.spec.ts",
    );
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("journeys.yml/dispatches");
    expect(result.stdout).not.toContain("This run's evidence:");
  }, 30_000);

  it("always runs them inside CI, where the runners read the same git settings", () => {
    const { run } = computer("ci");
    for (const check of ["journeys", "phone", "replay-gate", "typecheck", "lint"]) {
      const result = run(`node scripts/checks-mode.ts ${check}`, { CI: "true" });
      expect(result.status, result.stderr).toBe(0);
    }
  });

  it("lets INFINITARY_CHECKS override the git setting for one run", () => {
    expect(
      computer("ci").run("node scripts/checks-mode.ts phone", { INFINITARY_CHECKS: "local" })
        .status,
    ).toBe(0);
    const on = computer().run("node scripts/checks-mode.ts phone", { INFINITARY_CHECKS: "ci" });
    expect(on.status).toBe(1);
    expect(on.stderr).toContain("phone.yml/dispatches");
  });

  it("refuses a setting it cannot read rather than guess", () => {
    const result = computer("CI").run("node scripts/checks-mode.ts phone");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('infinitary.checks reads "CI"; it takes ci or local.');
  });
});

// INF-5379's plan, piece 3: as an `&&` chain the full lint stopped at its
// first failure, so a held batch's file-size refusal hid the eighteen lints
// after it and each repair found only the next failure. Plain Node commands
// stand in for the lints: two fail, the one between them passes.
describe("the full lint", () => {
  it("runs every step after one fails and names each step that failed", () => {
    const fail = (code: number) => ["node", "-e", `process.exit(${code})`];
    const steps = [fail(3), ["node", "-e", "console.log('the middle step ran')"], fail(1)];
    const result = spawnSync(
      "node",
      ["scripts/check.ts", ...steps.flatMap((step, at) => (at ? [",", ...step] : step))],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("the middle step ran");
    expect(result.stderr).toContain("pnpm check: 2 of 3 steps failed:");
    expect(result.stderr).toContain("node -e process.exit(3)");
    expect(result.stderr).toContain("node -e process.exit(1)");
  });
});
