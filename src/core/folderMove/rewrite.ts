import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { KNOWLEDGE_DB_FILE } from "../storage/knowledgeStore";
import { fromOtherRules, moveColumnAcross, movedAcross } from "./folderRules";
import type { OutsideChange } from "./record";
import { rewriteTaskFolders } from "./taskFolders";
import type { GitLink } from "./tree";

/**
 * What the one-time move rewrites in its staged copy (./move.ts), and only
 * there: the app's own absolute paths into the older folder, which now name
 * the new one. A path is rewritten only where the whole value is one - a
 * column, a JSON string, a link's target, a git link file - so prose keeps
 * the paths it was written with, as history (FI3-1720's plan: "Do not
 * rewrite prose"). Claude's transcript copies stay byte for byte, because
 * the app extends each one only while it is a prefix of the client's own
 * file (`storage/sessionRecordStore.ts`).
 */

/**
 * The older folder by every path that names it: as the app named it, and as
 * the disk resolves it where a link lies on the way (`/var` and
 * `/private/var` on a Mac), since a path the app stored and one git stored
 * may each have taken either (./move.ts `pathsOf`).
 */
export type Froms = readonly string[];

export function movedPath(value: string, froms: Froms, to: string): string | undefined {
  for (const from of froms) {
    if (fromOtherRules(from)) {
      const moved = movedAcross(value, from, to);
      if (moved !== undefined) return moved;
      continue;
    }
    if (value === from) return to;
    if (value.startsWith(`${from}${sep}`)) return `${to}${value.slice(from.length)}`;
  }
  return undefined;
}

export function movedJson(value: unknown, from: Froms, to: string): unknown {
  if (typeof value === "string") return movedPath(value, from, to) ?? value;
  if (Array.isArray(value)) return value.map((item) => movedJson(item, from, to));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, movedJson(item, from, to)]),
    );
  return value;
}

/** The app's databases, relative to the folder: the move checks each one and rewrites the first. */
export const DATABASES = ["firstmate.db", join("knowledge", KNOWLEDGE_DB_FILE)] as const;

function columns(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as {
    name: string;
  }[];
  return new Set(rows.map((row) => row.name));
}

function tables(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  ).map((row) => row.name);
}

function rowCounts(db: Database.Database): Record<string, number> {
  return Object.fromEntries(
    tables(db).map((table) => [
      table,
      (db.prepare(`SELECT count(*) AS n FROM ${JSON.stringify(table)}`).get() as { n: number }).n,
    ]),
  );
}

/** A database whose copy is not whole, said as a reason a move stops. */
export class DatabaseCheckError extends Error {
  constructor(
    readonly path: string,
    readonly what: string,
  ) {
    super(`The copy of ${path} did not pass its check (${what}).`);
    this.name = "DatabaseCheckError";
  }
}

/**
 * The whole-path columns of the main database (docs/saved-data-compatibility.md,
 * "The one-time move"): a project's folder, a task's project and working
 * copy and a Pi crewmate's session file. A task held on another computer
 * keeps its conversation file, which names that computer's file. Its project
 * folder and working copy name this Mac's, so they are rewritten with every
 * other task's (`rewriteTaskFolders`). A home that already moved is repaired
 * the next time it opens (`repairMovedTaskFolders`).
 */
function rewriteMainDatabase(db: Database.Database, froms: Froms, to: string): void {
  const update = (table: string, column: string, where = "1") => {
    if (!columns(db, table).has(column)) return;
    const statement = db.prepare(
      `UPDATE ${table} SET ${column} = @to || substr(${column}, length(@from) + 1)
       WHERE (${where}) AND (${column} = @from OR substr(${column}, 1, length(@prefix)) = @prefix)`,
    );
    for (const from of froms) {
      if (fromOtherRules(from)) moveColumnAcross(db, table, column, where, from, to);
      else statement.run({ from, to, prefix: `${from}${sep}` });
    }
  };
  update("repos", "path");
  rewriteTaskFolders(db, froms, to);
  if (columns(db, "plugins").has("source")) update("plugins", "spec", "source = 'path'");
  // Settings hold JSON: the Firstmate's own session file is one.
  const settings = db.prepare("SELECT key, value FROM settings").all() as {
    key: string;
    value: string;
  }[];
  const write = db.prepare("UPDATE settings SET value = ? WHERE key = ?");
  for (const row of settings) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      continue;
    }
    const moved = JSON.stringify(movedJson(parsed, froms, to));
    if (moved !== JSON.stringify(parsed)) write.run(moved, row.key);
  }
}

/**
 * Opens each database of the staged copy - which replays its committed
 * write-ahead log, so work the older app had not folded in yet comes over -
 * rewrites the main one's paths, folds the log in, and checks the result:
 * the same rows in every table, and SQLite's own check passes.
 */
export function rewriteDatabases(staged: string, from: Froms, to: string): string[] {
  const rewritten: string[] = [];
  for (const name of DATABASES) {
    const path = join(staged, name);
    if (!existsSync(path)) continue;
    const db = new Database(path, { fileMustExist: true });
    try {
      const before = rowCounts(db);
      if (name === "firstmate.db") {
        db.transaction(() => rewriteMainDatabase(db, from, to))();
        rewritten.push(name);
      }
      db.pragma("wal_checkpoint(TRUNCATE)");
      const after = rowCounts(db);
      if (JSON.stringify(after) !== JSON.stringify(before))
        throw new DatabaseCheckError(name, "a different number of rows");
      const check = db.pragma("quick_check", { simple: true });
      if (check !== "ok") throw new DatabaseCheckError(name, String(check));
    } finally {
      db.close();
    }
  }
  return rewritten;
}

/**
 * Files of the app's own that hold whole paths into its folder: what the
 * background work set up (its kept copy of the app) and what a removal could
 * not take away (docs/helper.md).
 */
export const PATH_FILES = [join("work", "installed.json"), join("work", "left.json")] as const;

export async function rewritePathFiles(staged: string, from: Froms, to: string): Promise<string[]> {
  const rewritten: string[] = [];
  for (const name of PATH_FILES) {
    const path = join(staged, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    const moved = movedJson(parsed, from, to);
    if (JSON.stringify(moved) === JSON.stringify(parsed)) continue;
    const mode = lstatSync(path).mode & 0o7777;
    await writeFile(path, `${JSON.stringify(moved, null, 2)}\n`, { mode });
    rewritten.push(name);
  }
  return rewritten;
}

export function rewriteLinks(
  staged: string,
  links: readonly string[],
  from: Froms,
  to: string,
): string[] {
  const rewritten: string[] = [];
  for (const link of links) {
    const path = join(staged, link);
    const target = movedPath(readlinkSync(path), from, to);
    if (!target) continue;
    unlinkSync(path);
    symlinkSync(target, path);
    rewritten.push(link);
  }
  return rewritten;
}

const GITDIR_LINE = /^gitdir: (.+?)\r?\n?$/;

/** What a git link file names: the path, and how to write another one in its place. */
function readGitLink(text: string, kind: GitLink["kind"]) {
  if (kind === "worktree") {
    const match = GITDIR_LINE.exec(text);
    return match?.[1] ? { target: match[1], write: (path: string) => `gitdir: ${path}\n` } : null;
  }
  const target = text.replace(/\r?\n$/, "");
  return target && !target.includes("\n") ? { target, write: (path: string) => `${path}\n` } : null;
}

/**
 * Git's links whose absolute path is inside the older folder now name the
 * new one: a working copy's `.git` file and a repository's
 * `worktrees/<id>/gitdir`, when both ends are in the folder. A relative
 * link needs nothing - the two folders sit side by side, so it resolves the
 * same from either.
 */
export async function rewriteGitLinks(
  staged: string,
  links: readonly GitLink[],
  from: Froms,
  to: string,
): Promise<string[]> {
  const rewritten: string[] = [];
  for (const link of links) {
    const path = join(staged, link.path);
    const parsed = readGitLink(readFileSync(path, "utf8"), link.kind);
    if (!parsed || !isAbsolute(parsed.target)) continue;
    const target = movedPath(parsed.target, from, to);
    if (!target) continue;
    await writeFile(path, parsed.write(target), { mode: lstatSync(path).mode & 0o7777 });
    rewritten.push(link.path);
  }
  return rewritten;
}

/**
 * The links in repositories outside both folders - a project the app works
 * on where the person keeps it - that name a working copy in the older
 * folder: each repository's `worktrees/<id>/gitdir`, with what it holds now
 * and what it will hold. Nothing is written here; the move changes them
 * after its commit and keeps this list, so a rollback can put them back.
 */
export function outsideGitLinks(
  root: string,
  links: readonly GitLink[],
  from: Froms,
  to: string,
): OutsideChange[] {
  const changes: OutsideChange[] = [];
  for (const link of links) {
    if (link.kind !== "worktree") continue;
    const worktree = dirname(join(root, link.path));
    const parsed = readGitLink(readFileSync(join(root, link.path), "utf8"), "worktree");
    if (!parsed) continue;
    const admin = resolve(worktree, parsed.target);
    if (movedPath(admin, from, to)) continue;
    const gitdir = join(admin, "gitdir");
    let before: string;
    try {
      before = readFileSync(gitdir, "utf8");
    } catch {
      continue;
    }
    const back = readGitLink(before, "admin");
    if (!back) continue;
    const moved = movedPath(resolve(admin, back.target), from, to);
    // The repository names this very working copy, by any path to it.
    if (moved !== join(to, dirname(link.path), ".git")) continue;
    const after = back.write(isAbsolute(back.target) ? moved : relative(admin, moved));
    changes.push({ path: gitdir, before, after });
  }
  return changes;
}
