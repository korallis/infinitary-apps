#!/usr/bin/env node
// Answers whether a source keeps better-sqlite3's build off as it installs:
// exit status 0 when its pnpm-workspace.yaml says so beyond doubt, 1 otherwise.
//
// The headers step runs before the install, so no YAML reader is there yet,
// and a line reading `better-sqlite3: false` can stand anywhere in that file:
// under another key, or in a block of text. This reads the file's lines and
// answers yes only where they can mean nothing else:
//
// - one top-level `allowBuilds:` key opens a list;
// - every entry of that list sits at one indent and reads `name: true` or
//   `name: false`, so none of its lines is text or part of a deeper value;
// - one entry names better-sqlite3, in any of the spellings pnpm matches a
//   package by, and it reads exactly `better-sqlite3: false`;
// - no top-level setting allows every build, which pnpm 11 obeys over the list.
//
// Any other shape counts as still building. That costs a source that builds
// nothing only the check that Node's headers are there, while the other
// mistake starts node-gyp with no headers set up for it.
//
// Usage, from the source's folder:
//   node <this file> pnpm-workspace.yaml
import { readFileSync } from "node:fs";

const MODULE = "better-sqlite3";
const LIST_KEY = /^['"]?allowBuilds['"]?\s*:/;
const LIST_OPENS = /^allowBuilds:(\s+#.*)?\s*$/;
const ALLOWS_EVERY_BUILD = /^['"]?dangerouslyAllowAllBuilds['"]?\s*:(?!\s+false(\s+#.*)?\s*$)/;
const TOP_LEVEL = /^[^\s#]/;
const BLANK_OR_COMMENT = /^\s*(#.*)?$/;
const ENTRY = /^( +)([A-Za-z0-9_.~][^'"#:]*|'[^']*'|"[^"\\]*"):\s+(true|false)(\s+#.*)?\s*$/;

function buildIsOff(settings) {
  const lines = settings.split(/\r?\n/);
  if (lines.some((line) => ALLOWS_EVERY_BUILD.test(line))) return false;
  if (lines.filter((line) => LIST_KEY.test(line)).length !== 1) return false;
  const opens = lines.findIndex((line) => LIST_OPENS.test(line));
  if (opens < 0) return false;
  const after = lines.slice(opens + 1);
  const ends = after.findIndex((line) => TOP_LEVEL.test(line));
  const entries = after
    .slice(0, ends < 0 ? after.length : ends)
    .filter((line) => !BLANK_OR_COMMENT.test(line))
    .map((line) => ENTRY.exec(line));
  if (entries.some((entry) => entry === null || entry[1] !== entries[0][1])) return false;
  const named = entries.filter((entry) => entry[2].includes(MODULE));
  return named.length === 1 && named[0][2] === MODULE && named[0][3] === "false";
}

let settings = "";
try {
  settings = readFileSync(process.argv[2], "utf8");
} catch {
  // A source without the file keeps no such setting: an earlier release
  // listed its allowed builds in package.json.
}
process.exitCode = buildIsOff(settings) ? 0 : 1;
