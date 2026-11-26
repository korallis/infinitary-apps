import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { changedPaths, PROBE_FILES } from "./affected-probes.ts";
import { packageProgram } from "./check-changed.ts";
import { MAC_UNIT_FILES } from "./mac-unit-tests.ts";
import { prRuns } from "./pr-paths.ts";
import {
  balanceShards,
  fileWeights,
  REACH_TIMINGS_FILE,
  readShardTimings,
  type ShardTimings,
} from "./shard-balance.ts";
import { directUnitReach, projectPath, unitFiles, VITEST_FILE } from "./unit-reach.ts";

/**
 * The captain's INF-2273 override to INF-2259: every edited Vitest file
 * gets its ordinary local run plus two more, including Linux-eligible files.
 * INF-2394 measure 3 adds one local round for unedited direct importers and
 * literal path readers; a data file counts as part of the module importing it
 * (INF-2426), and so does served text such as the generated runbook fallback
 * (INF-2925). No other transitive reach or added CI jobs; the pull request's
 * build check runs each edited file once more on Linux (`--reach`). Native files still require a Mac.
 *
 *   node scripts/unit-repeats.ts [--base <ref>] [--head <ref>] [--workers <n>] [--shard <index/count>] [--run]
 *   node scripts/unit-repeats.ts --reach [--base <ref>] [--part <index>[/<count>]] [--run]   (the branch check:
 *     edited test files and their unedited direct readers, once, on Linux; a wide selection in parts)
 *   node scripts/unit-repeats.ts --reach [--base <ref>] --later-parts   (the code checks job: the parts after
 *     the first, as the job matrix that runs them)
 *
 * The existing changed-path reader owns selection. Fresh rounds stop at the
 * first failure or interruption, without retries. An unreadable base fails.
 * Explicit workers bound a local batch to its caller's load declaration;
 * optional Vitest sharding divides disjoint local batches, not extra CI gates.
 */

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** INF-2259 accepted override: ordinary coverage plus two more rounds. */
export const REPEATS = 3;

/** What a round's arguments to pnpm open with: the program `pnpm exec` starts. */
const PNPM_VITEST = ["exec", "vitest"];

const LISTED_PROGRAM = fileURLToPath(new URL("./listed-program.ts", import.meta.url));

export type Selection = { repeat: string[]; onMac: string[] };
export type LocalSelection = Selection & { once: string[] };

/** Edited tests own three rounds; unedited direct readers own just one. */
export function selectLocalUnits(changed: readonly string[], root = ROOT): LocalSelection {
  const edited = selectRepeats(changed, (file) => existsSync(join(root, file)));
  const once = directUnitReach(changed, unitFiles(root), root);
  const mac = new Set<string>(MAC_UNIT_FILES);
  return {
    ...edited,
    once,
    onMac: [...edited.onMac, ...once.filter((file) => mac.has(file))].sort(),
  };
}

/**
 * The pull request's build check runs the unedited direct readers once, on
 * Linux, in the in-memory cohorts and the integration cohort: an integration
 * reader such as tests/release-workflows.test.ts was listed and never run, so
 * its break merged (INF-2478). It runs each edited Vitest file once there too,
 * beside its three local rounds: PRs #1398, #1455 and #1420 edited tests that
 * passed on the crewmate's Mac and first failed on Linux in the merge batch
 * (INF-3690's gap 3, the captain's "Yes: start it now"). A browser file
 * runs here too, in the browser project, when the browser step skips: a
 * change to src/shared/cards.ts alone reached twelve browser tests and ran
 * none (INF-2999). Naming the browser project costs a round with no browser
 * file nothing, and the step before installs the Chromium it draws in.
 * Three kinds stay with another run, listed apart with where each runs: an
 * unedited Mac-listed reader with the crewmate's local round, a probe with
 * main's full check, since it can fail with no code change
 * (docs/test-cohorts.md, "Probes"), and a browser file with the browser step
 * when the change touches the renderer or its browser tests, since that step
 * then runs every browser file.
 */
export const REACH_PROJECTS = ["pure", "unit", "unit-isolated", "integration", "browser"];

export type LinuxReach = { run: string[]; elsewhere: { file: string; where: string }[] };

export function selectLinuxReach(changed: readonly string[], root = ROOT): LinuxReach {
  const mac = new Set<string>(MAC_UNIT_FILES);
  const probes = new Set<string>(PROBE_FILES);
  // The paths step's own verdict on the same change (scripts/pr-paths.ts).
  // This list leaves out a rename's old path, which that step reads too, so
  // at worst a browser file runs in both steps, and never in neither.
  const browserStep = prRuns(changed).browser;
  const reach: LinuxReach = { run: [], elsewhere: [] };
  const edited = new Set(selectRepeats(changed, (file) => existsSync(join(root, file))).repeat);
  const readers = directUnitReach(changed, unitFiles(root), root);
  for (const file of [...new Set([...edited, ...readers])].toSorted()) {
    // Linux runs every file, a Mac-listed one's portable cases included
    // (scripts/mac-unit-tests.ts), so an edited one runs here too: #1420's
    // edited tests/run-temp-root.test.ts is Mac-listed and failed on Linux.
    if (mac.has(file) && !edited.has(file))
      reach.elsewhere.push({ file, where: "needs a Mac: the crewmate's local round" });
    else if (probes.has(file))
      reach.elsewhere.push({ file, where: "a probe: main's full check runs every probe" });
    else if (file.startsWith("tests/browser/") && browserStep)
      reach.elsewhere.push({
        file,
        where: "a browser test: the browser step runs every browser test for this change",
      });
    else reach.run.push(file);
  }
  return reach;
}

/**
 * One round, no retry, and a JSON report of the files that ran. Naming
 * reporters drops the GitHub one Vitest adds on its own inside GitHub
 * Actions, so it is named again there: a failure stays an annotation the
 * check's summary shows (docs/testing.md, "A failed check says why").
 */
export function reachArgs(
  files: readonly string[],
  reportFile: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  return [
    ...PNPM_VITEST,
    "run",
    "--retry",
    "0",
    "--reporter=default",
    ...(env.GITHUB_ACTIONS === "true" ? ["--reporter=github-actions"] : []),
    "--reporter=json",
    `--outputFile.json=${reportFile}`,
    ...REACH_PROJECTS.flatMap((project) => ["--project", project]),
    ...files,
  ];
}

/** The selected files Vitest's report does not show running: the step fails on any. */
export function unreported(
  files: readonly string[],
  report: { testResults?: { name: string }[] } | undefined,
  root = ROOT,
): string[] {
  const ran = new Set(
    (report?.testResults ?? []).map((result) => projectPath(relative(root, result.name))),
  );
  return files.filter((file) => !ran.has(file));
}

/**
 * The most selected test files one Vitest run of the reader step takes (INF-4163).
 * The pure and unit projects share one module cache per worker (isolate: false), so a worker keeps what each file
 * leaves behind - its modules, state a test kept, native memory the heap does not count - until its run ends.
 * A branch whose selection reached 454 files ran two such workers at 3.2 and 2.4 GB on the check's runner, which has
 * 7.9 GB and no swap, and the same step on a sibling branch lost its runner.
 * A wider selection runs as several runs one after another, each with fresh workers, so a worker's memory follows
 * one run's files rather than the whole selection's.
 * On that runner, every file this step can select (1,239) in runs of at most 100 took 26 minutes, its largest worker
 * held 2.4 GB, and at least 2.1 GB stayed free except while tests/checks-mode.test.ts started the quick check's
 * programs all at once; runs of at most 200 saved 89 seconds and let a worker reach 2.9 GB.
 */
export const REACH_RUN_FILES = 100;

/** The selection cut in order into the fewest runs of at most `most` files, of nearly equal size. */
export function reachRuns(files: readonly string[], most = REACH_RUN_FILES): string[][] {
  const count = Math.ceil(files.length / most);
  const size = Math.ceil(files.length / count);
  return Array.from({ length: count }, (_, run) => files.slice(run * size, (run + 1) * size));
}

/**
 * The most measured seconds of tests one part of the reader step holds (INF-5493): a measured second is one the file
 * took in main's Linux test groups (tests/helpers/shardTimings.json and reachTimings.json, scripts/shard-timings.ts).
 * The step once ran every selected file on one machine, so its time grew with the selection and with that machine's
 * pace: a change to the shared orchestrator and forge files selected 334 files holding 2,579 measured seconds, which
 * one push's run ran in 19m44s on a hosted machine, about 0.46 of a second per measured second, and the next push's
 * run reached the step's 30-minute limit with three files left, more than 0.7. A part of at most 900 measured seconds
 * takes about 7 minutes at the usual pace and about 12 at the slowest pace seen, which leaves room inside the limit
 * for a machine twice as slow again.
 */
export const REACH_PART_SECONDS = 900;

/** The seconds each test file took in main's Linux test groups: the unit groups' record and the integration and browser one. */
export function reachTimings(): ShardTimings {
  return { ...readShardTimings(), ...readShardTimings(REACH_TIMINGS_FILE) };
}

/**
 * The selection split into the fewest parts of at most `most` measured seconds, each part on a machine of its own,
 * side by side (ci.yml's reached-tests runs the first, reached-tests-parts the others), so a wider change takes more
 * machines instead of a longer step. The parts are balanced by measured time (scripts/shard-balance.ts), and every
 * machine computes the same parts from the same version.
 */
export function reachParts(
  files: readonly string[],
  timings: ShardTimings,
  most = REACH_PART_SECONDS,
): string[][] {
  const total = [...fileWeights(files, timings).values()].reduce((sum, seconds) => sum + seconds, 0);
  const count = Math.max(1, Math.min(files.length, Math.ceil(total / most)));
  return balanceShards(files, count, timings).map((part) => part.toSorted());
}

/**
 * The files of the part `--part <index>[/<count>]` names. The count, when given, is the one the code checks job
 * counted for the matrix that starts the later parts: a machine that counts otherwise fails rather than leave a part
 * unrun.
 */
export function reachPart(parts: readonly string[][], spec: string): string[] {
  const match = /^([1-9]\d*)(?:\/([1-9]\d*))?$/.exec(spec);
  if (!match) throw new Error(`Invalid reader step part: ${spec}`);
  const index = Number(match[1]);
  const count = match[2] === undefined ? parts.length : Number(match[2]);
  if (count !== parts.length || index > count)
    throw new Error(
      `This version's selection runs as ${parts.length} parts, so part ${spec} would leave a part unrun or run one twice.`,
    );
  return [...(parts[index - 1] ?? [])];
}

/** The code checks job's output that starts the parts after the first: a matrix entry for each, or nothing for one part. */
export function laterParts(parts: readonly string[][]): string {
  if (parts.length < 2) return "";
  return JSON.stringify(
    Array.from({ length: parts.length - 1 }, (_, index) => ({
      part: index + 2,
      parts: parts.length,
    })),
  );
}

/**
 * Run the selected files once, in runs of at most REACH_RUN_FILES one after another. Every run goes, so one push
 * shows each failing reader; a failed run, an interrupted one, which ends the step there, or a file no run's report
 * shows fails it.
 */
export function runLinuxReach(
  files: readonly string[],
  run: (args: string[], reportFile: string) => number | null,
  report: (lines: string[]) => void,
  root = ROOT,
): number {
  if (files.length === 0) return 0;
  const runs = reachRuns(files);
  if (runs.length > 1)
    report([
      `The ${files.length} selected files run as ${runs.length} Vitest runs of at most ${REACH_RUN_FILES} files, one after another, each with fresh workers.`,
    ]);
  const dir = mkdtempSync(join(tmpdir(), "unit-reach-"));
  try {
    const ran: { name: string }[] = [];
    let failed = 0;
    for (const [index, part] of runs.entries()) {
      const file = join(dir, `report-${index + 1}.json`);
      const status = run(reachArgs(part, file), file);
      if (status === null) return failed || 1;
      if (status !== 0) {
        failed ||= status;
        continue;
      }
      if (existsSync(file)) ran.push(...(JSON.parse(readFileSync(file, "utf8")).testResults ?? []));
    }
    if (failed !== 0) return failed;
    const missing = unreported(files, { testResults: ran }, root);
    if (missing.length === 0) return 0;
    report([
      `These selected test files did not run in ${REACH_PROJECTS.join(", ")}:`,
      ...missing.map((path) => `- \`${path}\``),
    ]);
    return 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** All edited surviving Vitest files run locally; identify their native prerequisites. */
export function selectRepeats(
  changed: readonly string[],
  exists: (path: string) => boolean = (path) => existsSync(join(ROOT, path)),
): Selection {
  const files = changed.filter((path) => VITEST_FILE.test(path) && exists(path)).toSorted();
  const mac = new Set<string>(MAC_UNIT_FILES);
  return {
    repeat: files,
    onMac: files.filter((path) => mac.has(path)),
  };
}

/** Keep every round on Vitest's own shard, with the complete candidate set. */
export function repetitionArgs(
  files: readonly string[],
  shard?: string,
  workers?: string,
): string[] | undefined {
  if (workers !== undefined && !/^[1-9]\d*$/.test(workers))
    throw new Error(`Invalid worker count: ${workers}`);
  let split: string[] = [];
  if (shard !== undefined) {
    const parts = /^([1-9]\d*)\/([1-9]\d*)$/.exec(shard);
    const index = Number(parts?.[1]);
    const total = Number(parts?.[2]);
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index > total)
      throw new Error(`Invalid repetition shard: ${shard}`);
    // Vitest refuses more shards than files. Empty shards own no work; the
    // others use the available file count, without passWithNoTests hiding a
    // real selection error in a nonempty shard.
    const count = Math.min(total, files.length);
    if (index > count) return undefined;
    if (count > 1) split = ["--shard", `${index}/${count}`];
  }
  return [
    ...PNPM_VITEST,
    "run",
    "--retry",
    "0",
    ...(workers === undefined ? [] : ["--maxWorkers", workers]),
    ...split,
    ...files,
  ];
}

/** Three fresh invocations (ordinary coverage plus two), never a retry; any failed or interrupted round ends this shard. */
export function runRepetitions(
  files: readonly string[],
  shard: string | undefined,
  run: (args: string[]) => number | null,
  report: (lines: string[]) => void,
  workers?: string,
): number {
  if (files.length === 0) return 0;
  const command = repetitionArgs(files, shard, workers);
  if (command === undefined) {
    report([`Shard ${shard} owns no selected test files.`]);
    return 0;
  }
  for (let round = 1; round <= REPEATS; round++) {
    report([`Round ${round} of ${REPEATS}`]);
    const status = run(command);
    if (status !== 0) {
      report([`Round ${round} of ${REPEATS} failed; later rounds did not run.`]);
      return status ?? 1;
    }
  }
  report([`All ${REPEATS} rounds passed.`]);
  return 0;
}

/** Run affected readers once before the edited-file rounds, stopping on any failure. */
export function runLocalUnits(
  selection: LocalSelection,
  shard: string | undefined,
  run: (args: string[]) => number | null,
  report: (lines: string[]) => void,
  workers?: string,
): number {
  if (selection.once.length) {
    const command = repetitionArgs(selection.once, shard, workers);
    if (command) {
      report(["Direct importers and path readers: one local round."]);
      const status = run(command);
      if (status !== 0) {
        report(["Direct-reader round failed; edited-file rounds did not run."]);
        return status ?? 1;
      }
      report(["Direct-reader round passed."]);
    }
  }
  return runRepetitions(selection.repeat, shard, run, report, workers);
}

/**
 * The program and arguments that start a round. On Linux and macOS that is
 * pnpm with the round's arguments. On Windows pnpm is a .cmd file, which Node
 * starts only through a shell: without one the round never starts
 * (`spawnSync pnpm ENOENT`) and reads as a failed round, and a shell would
 * read a test file's name as its own words. So on Windows a round starts the
 * program `pnpm exec vitest` names (`packageProgram`) through Node itself.
 * Windows also refuses a command line past 32,767 characters, which a wide
 * selection's file names pass, so there the same Vitest arguments come back
 * as `listed`, for a file whose path follows `args` (listed-program.ts): the
 * round stays one run of the same files on every system.
 */
export function roundStart(
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  root = ROOT,
): { command: string; args: string[]; listed?: string[] } {
  if (platform !== "win32") return { command: "pnpm", args: [...args] };
  return {
    command: process.execPath,
    args: [LISTED_PROGRAM, packageProgram("vitest", "vitest", root)],
    listed: args.slice(PNPM_VITEST.length),
  };
}

/** Starts one round and waits for it; null when it was interrupted or could not start. */
export function startRound(args: readonly string[]): number | null {
  const { command, args: started, listed } = roundStart(args);
  const start = (rest: string[]) =>
    spawnSync(command, [...started, ...rest], { cwd: ROOT, stdio: "inherit" }).status;
  if (!listed) return start([]);
  const dir = mkdtempSync(join(tmpdir(), "unit-round-"));
  try {
    const list = join(dir, "arguments.json");
    writeFileSync(list, JSON.stringify(listed));
    return start([list]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function summaryLines(
  base: string,
  { repeat, once, onMac }: LocalSelection,
  shard?: string,
): string[] {
  const lines =
    repeat.length === 0
      ? [`No surviving Vitest file this change adds or edits since ${base} needs local rounds.`]
      : [
          shard === undefined
            ? `These files run ${REPEATS} total local rounds (ordinary coverage included), since ${base}:`
            : `Local Vitest shard ${shard} runs ${REPEATS} total rounds from these candidates, since ${base}; together the shards cover every file:`,
          ...repeat.map((file) => `- \`${file}\``),
        ];
  lines.push(
    "",
    "Unedited direct importers and literal path readers run once locally (no transitive reach):",
    ...once.map((file) => `- \`${file}\``),
  );
  if (onMac.length > 0)
    lines.push(
      "",
      "These included files need a Mac (scripts/mac-unit-tests.ts); they are not excluded from local rounds:",
      ...onMac.map((file) => `- \`${file}\``),
    );
  return lines;
}

function main(): void {
  const args = process.argv.slice(2);
  const value = (flag: string, fallback: string) => {
    const at = args.indexOf(flag);
    return at >= 0 ? (args[at + 1] ?? "") : fallback;
  };
  const base = value("--base", "origin/main");
  const report = (lines: string[]) => {
    console.log(lines.join("\n"));
    if (args.includes("--run") && process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        ["### Unit-file repeats", "", ...lines, ""].join("\n"),
      );
  };
  const changed = changedPaths(base, value("--head", "HEAD"));
  if (changed === undefined) {
    console.error(
      `The change's base ${base} cannot be read, so its edited test files are unknown.`,
    );
    process.exitCode = 1;
    return;
  }
  if (args.includes("--reach")) {
    const { run, elsewhere } = selectLinuxReach(changed);
    const timings = reachTimings();
    const parts = reachParts(run, timings);
    const seconds = (files: readonly string[]) =>
      Math.round([...fileWeights(files, timings).values()].reduce((sum, took) => sum + took, 0));
    if (args.includes("--later-parts")) {
      const later = laterParts(parts);
      console.log(
        later
          ? `The ${run.length} selected files hold about ${seconds(run)} measured seconds, so they run as ${parts.length} parts; the code checks start parts 2 to ${parts.length}: ${later}`
          : `The ${run.length} selected files hold about ${seconds(run)} measured seconds, one part.`,
      );
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `later=${later}\n`);
      return;
    }
    let mine: string[];
    try {
      mine = args.includes("--part") ? reachPart(parts, value("--part", "")) : run;
    } catch (error) {
      console.error((error as Error).message);
      process.exitCode = 1;
      return;
    }
    const lines = [
      `Edited test files, unedited direct importers and literal path readers since ${base}, one round in CI:`,
      ...run.map((file) => `- \`${file}\``),
    ];
    if (elsewhere.length > 0)
      lines.push(
        "",
        "Test files this round leaves to another run:",
        ...elsewhere.map(({ file, where }) => `- \`${file}\` (${where})`),
      );
    if (parts.length > 1)
      lines.push(
        "",
        `These files hold about ${seconds(run)} measured seconds, more than the ${REACH_PART_SECONDS} one part holds, so they run as ${parts.length} parts on as many machines side by side.`,
        ...(mine === run
          ? []
          : [
              `This step runs part ${value("--part", "")}, about ${seconds(mine)} measured seconds:`,
              ...mine.map((file) => `- \`${file}\``),
            ]),
      );
    report(lines);
    if (!args.includes("--run")) return;
    process.exitCode = runLinuxReach(mine, startRound, report);
    return;
  }
  const selection = selectLocalUnits(changed);
  const shard = args.includes("--shard") ? value("--shard", "") : undefined;
  const workers = args.includes("--workers") ? value("--workers", "") : undefined;
  report(summaryLines(base, selection, shard));
  if (!args.includes("--run") || selection.repeat.length + selection.once.length === 0) return;
  if (process.platform !== "darwin" && selection.onMac.length > 0)
    throw new Error(
      "This selected local batch includes native files that need a Mac; do not count skipped native cases as proof.",
    );
  process.exitCode = runLocalUnits(selection, shard, startRound, report, workers);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
