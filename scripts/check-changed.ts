import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCommands } from "./check.ts";
import { writeCompiledMessages } from "./generate-messages.ts";
import { jobCores, jobMemory } from "./job-cores.ts";

/**
 * The quick check a crewmate runs before every push (INF-2588's report, fix 1;
 * INF-2674's typecheck fix; INF-2970's fix to run the pull request check's
 * lints here too): Biome on only the files this branch changed, the adherence
 * lint on its renderer files, every node script `pnpm check` runs (the
 * project lints and the generated-file checks), the release-notes check the
 * pull request runs first, the size headroom, the phone contract flag, and the whole-project
 * typecheck. Together they take
 * seconds, so they run side by side, as many at once as the job has cores and
 * the computer's memory holds (`quickCheckLanes`), and print in order. It is
 * not gated by CI mode, so the Mac mini can
 * run it; the full lint and the typecheck also stay in the branch check's
 * `code-checks` job (INF-2074, docs/testing.md "Where the heavy checks
 * run").
 */
// Its stderr rides a failure's message, so a probe that misses prints nothing.
const git = (args: string[], cwd?: string) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/**
 * The commit the branch grew from: its merge base with main, or HEAD's own
 * commit in a checkout with no main to compare with, such as the main
 * check's one-commit checkout of a push, where nothing is committed since.
 */
export function baseRef(cwd?: string): string {
  for (const ref of ["origin/main", "main"]) {
    try {
      return git(["merge-base", "HEAD", ref], cwd);
    } catch {
    }
  }
  return git(["rev-parse", "HEAD"], cwd);
}

/** Files that exist now and differ from the branch's base, committed or not. */
export function changedFiles(base = baseRef()): string[] {
  const tracked = git(["diff", "--name-only", "--diff-filter=ACMR", base]).split("\n");
  const untracked = git(["ls-files", "--others", "--exclude-standard"]).split("\n");
  return [...new Set([...tracked, ...untracked])].filter(Boolean);
}

/**
 * The node scripts `pnpm check` runs after its whole-project Biome, read from
 * package.json (`checkCommands`) so a lint added there runs here too. `checks-mode.ts` is left
 * out: it is the CI-mode refusal this quick check exists to step around, and
 * so is the build of the catalogs' compiled modules, which runs first, before
 * the steps that read them start side by side.
 */
export function checkScripts(check: string): string[][] {
  return checkCommands(check)
    .filter(([program, script]) => program === "node" && script?.startsWith("scripts/"))
    .filter(([, script]) => script !== "scripts/checks-mode.ts")
    .filter(([, script, flag]) => !(script === "scripts/generate-messages.ts" && flag === "--compiled"))
    .map(([, ...args]) => args);
}

export interface Step {
  label: string;
  command: string;
  args: string[];
}

/**
 * A lint's own program: the Node script its package names under `bin`, the
 * file `pnpm exec` starts. The lint steps start it through Node themselves.
 * On Windows pnpm and the programs it links are .cmd files, which Node starts
 * only through a shell (`spawn pnpm ENOENT` without one), and a shell would
 * read a changed file's name as its own words.
 */
export function packageProgram(name: string, program = name): string {
  const folder = join("node_modules", name);
  const { bin } = JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const script = typeof bin === "string" ? bin : bin?.[program];
  if (!script) throw new Error(`${name} has no program named ${program}`);
  return join(folder, script);
}

/**
 * A step that starts a package's program through Node. It reads the package
 * when the step starts, not when the steps are listed, so a package it cannot
 * read is that step's failure and every other check still runs and reports.
 */
function programStep(label: string, name: string, program: string, args: string[]): Step {
  return {
    label,
    command: "node",
    get args() {
      return [packageProgram(name, program), ...args];
    },
  };
}

/**
 * Biome on every changed file, so Biome's own configuration picks which of
 * them it checks, as it does for the whole-project Biome in `pnpm check`: its
 * `files.includes` and the languages it knows. A list of extensions here
 * dropped .mjs sources, so a formatting slip in one passed this
 * check and failed the pull request's (INF-3297).
 */
export function biomeStep(files: string[]): Step | undefined {
  if (!files.length) return undefined;
  return programStep("biome", "@biomejs/biome", "biome", [
    "check",
    "--no-errors-on-unmatched",
    "--files-ignore-unknown=true",
    ...files,
  ]);
}

export function adherenceStep(renderer: string[]): Step | undefined {
  if (!renderer.length) return undefined;
  return programStep("adherence", "eslint", "eslint", [
    "--config",
    "eslint.adherence.config.mjs",
    "--no-config-lookup",
    ...renderer,
  ]);
}

/**
 * The most characters of file names one run of a lint is handed on Windows,
 * which starts a program with a command line of at most 32,767 characters and
 * answers `spawn ENAMETOOLONG` past it; about 650 of this project's file
 * names reach that. The rest of the line is left to the program and its flags.
 */
export const RUN_NAME_CHARACTERS = 24_000;

/**
 * The files in the runs that hold them: every name once, in order. Linux and
 * macOS start a line of a megabyte or more, so there a lint takes every file
 * in one run and reports on them together.
 */
export function runsOf(files: readonly string[], platform = process.platform): string[][] {
  if (platform !== "win32") return files.length ? [[...files]] : [];
  const runs: string[][] = [];
  let room = 0;
  for (const file of files) {
    // A name takes its own length, the space before it and a pair of quotes.
    const size = file.length + 3;
    if (!runs.length || size > room) {
      runs.push([]);
      room = RUN_NAME_CHARACTERS;
    }
    runs.at(-1)?.push(file);
    room -= size;
  }
  return runs;
}

export function run(step: Step): Promise<{ step: Step; ok: boolean; output: string }> {
  return new Promise((done) => {
    let output = "";
    const stopped = (error: unknown) =>
      done({ step, ok: false, output: `${output}${error instanceof Error ? error.message : error}\n` });
    // A step can fail before it starts: its package cannot be read, or the
    // system refuses its command line. That is this step's failure, never a
    // throw that ends the checks beside it.
    try {
      const child = spawn(step.command, step.args, { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.on("error", stopped);
      child.on("close", (status) => done({ step, ok: status === 0, output }));
    } catch (error) {
      stopped(error);
    }
  });
}

/**
 * The steps side by side, `atOnce` of them at a time, answered in the steps'
 * own order. Started all at once they are about thirty programs, the
 * typecheck among them, and they hold more memory than a small computer
 * has: on the two-processor Linux runner the kernel ended the largest test
 * beside the test that runs this command.
 */
export async function sideBySide<Result>(
  steps: readonly Step[],
  atOnce: number,
  start: (step: Step) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = [];
  const waiting = [...steps.entries()];
  const lane = async () => {
    for (let next = waiting.shift(); next; next = waiting.shift())
      results[next[0]] = await start(next[1]);
  };
  await Promise.all(Array.from({ length: Math.max(1, atOnce) }, lane));
  return results;
}

/**
 * The memory one lane may need: room for the largest step, the typecheck
 * from a cold start, which peaked at 1.9 GB on an arm64 Linux guest and on a
 * Mac. Each generated-file check that loads the app through a Vite module
 * runner peaks near 0.9 GB, so a lane per core is not enough of a bound.
 */
export const LANE_MEMORY_BYTES = 2 * 1024 ** 3;

/**
 * How many steps run at once: one for each core the job has and for each
 * `LANE_MEMORY_BYTES` of the computer's memory, whichever gives fewer, and
 * always one. INF-5001: by cores alone the quick check ran eleven steps at once
 * on the compute Macs' Linux guests, which have 11 cores and 9 GB with no
 * swap. Beside the three files the integration cohort ran with
 * tests/checks-mode.test.ts, the guest ran out of memory, and the generated
 * contract's check stopped at Vite's 60-second module fetch.
 */
export function quickCheckLanes({ cores, memoryBytes }: { cores: number; memoryBytes: number }): number {
  return Math.max(1, Math.min(cores, Math.floor(memoryBytes / LANE_MEMORY_BYTES)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = baseRef();
  const files = changedFiles(base);
  const renderer = files.filter((file) => /^src\/renderer\/.*\.tsx?$/.test(file));
  const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;
  console.log(`check:changed: ${files.length} changed file(s)`);
  writeCompiledMessages();
  const steps: Step[] = [];
  steps.push(...runsOf(files).flatMap((some) => biomeStep(some) ?? []));
  steps.push(...runsOf(renderer).flatMap((some) => adherenceStep(some) ?? []));
  for (const args of checkScripts(scripts.check ?? ""))
    steps.push({ label: args.join(" "), command: "node", args });
  // The pull request's first step. It reads commits, so it waits for the
  // branch's first one; before that there is nothing to push.
  if (base !== git(["rev-parse", "HEAD"]))
    steps.push({
      label: "release notes",
      command: "node",
      args: ["scripts/release-notes.ts", "change", "--base", base],
    });
  else console.log("check:changed: no commit since main yet, so the release-notes check waits");
  // The branch check's size headroom, against the same base, uncommitted
  // edits included.
  steps.push({
    label: "size headroom",
    command: "node",
    args: ["scripts/file-sizes.ts", "--headroom", "--base", base],
  });
  // The phone contract flag, which names the phone build a moved major or
  // view floor needs before the next alpha; it prints and never fails.
  steps.push({
    label: "phone contract",
    command: "node",
    args: ["scripts/phone-contract-flag.ts", "--base", base],
  });
  // Called directly, not through `pnpm typecheck`, which CI mode refuses.
  steps.push({ label: "typecheck", command: "node", args: ["scripts/typecheck.ts", "--pretty"] });
  const lanes = quickCheckLanes({ cores: jobCores(), memoryBytes: jobMemory() });
  const results = await sideBySide(steps, lanes, run);
  for (const { step, ok, output } of results) {
    process.stdout.write(output);
    if (!ok) console.error(`check:changed: ${step.label} failed`);
  }
  process.exitCode = results.every((result) => result.ok) ? 0 : 1;
}
