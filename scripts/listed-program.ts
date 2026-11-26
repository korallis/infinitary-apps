import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * `node scripts/listed-program.ts <program> <list>` runs a Node program with
 * the arguments a file lists, a JSON array, as though they had followed the
 * program on its own command line.
 *
 * Windows starts a program with a command line of at most 32,767 characters
 * and answers `spawn ENAMETOOLONG` past it, which the test files of one round
 * can pass: 1,000 of this project's names take about 41,000. So a round on
 * Windows hands Vitest its arguments this way (`roundStart` in
 * unit-repeats.ts), in one run, where splitting the files across several runs
 * would change what a round and a shard hold.
 */

/** The command line the program reads: Node, the program, then each listed argument in order. */
export function listedCommandLine(
  [node = "", , program = "", list = ""]: readonly string[],
  read: (file: string) => string = (file) => readFileSync(file, "utf8"),
): string[] {
  return [node, resolve(program), ...(JSON.parse(read(list)) as string[])];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const line = listedCommandLine(process.argv);
  // The program reads its arguments from the process, and runs in this one, so
  // its output, exit code and signals stay its own.
  process.argv.splice(0, process.argv.length, ...line);
  await import(pathToFileURL(line[1] ?? "").href);
}
