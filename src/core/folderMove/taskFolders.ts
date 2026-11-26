import { sep } from "node:path";
import type Database from "better-sqlite3";
import { pathsOf } from "./due";
import { fromOtherRules, moveColumnAcross } from "./folderRules";
import { readMoveRecord } from "./record";

function columns(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as {
    name: string;
  }[];
  return new Set(rows.map((row) => row.name));
}

/**
 * Rewrites one whole-path column, where the table has it, from each older
 * folder to `to`: in one statement for a folder written under this
 * computer's folder rules, row by row for one written under another
 * system's (./folderRules.ts).
 */
export function moveColumn(
  db: Database.Database,
  table: string,
  column: string,
  froms: readonly string[],
  to: string,
  where = "1",
): void {
  if (!columns(db, table).has(column)) return;
  const statement = db.prepare(
    `UPDATE ${table} SET ${column} = @to || substr(${column}, length(@from) + 1)
     WHERE (${where}) AND (${column} = @from OR substr(${column}, 1, length(@prefix)) = @prefix)`,
  );
  for (const from of froms) {
    if (fromOtherRules(from)) moveColumnAcross(db, table, column, where, from, to);
    else statement.run({ from, to, prefix: `${from}${sep}` });
  }
}

/**
 * A task's project folder and working copy name this Mac, so a folder move
 * rewrites both for every row. Its conversation file names the computer that
 * holds the conversation: this Mac's when `device_id` is null, and the other
 * computer's otherwise, which stays as it is (INF-416 piece C, finding R8).
 */
export function rewriteTaskFolders(
  db: Database.Database,
  froms: readonly string[],
  to: string,
): void {
  moveColumn(db, "tasks", "repo_dir", froms, to);
  moveColumn(db, "tasks", "worktree_dir", froms, to);
  // The resume token is on the task's execution row (INF-1296 piece 3), or
  // on the task row of a database from before it.
  const running = columns(db, "task_execution").has("session_file") ? "task_execution" : "tasks";
  const here = columns(db, running).has("device_id") ? "device_id IS NULL" : "1";
  moveColumn(db, running, "session_file", froms, to, here);
}

/**
 * A home that already moved still names the older folder on a task held
 * elsewhere: that move skipped the row. The next open applies the same
 * rewrite from the move's record. A folder the person kept is left alone,
 * and so is a move that has not committed. Idempotent: a path already in
 * the new folder matches nothing.
 */
export function repairMovedTaskFolders(userDataDir: string, db: Database.Database): void {
  const record = readMoveRecord(userDataDir);
  if (!record || record.state === "kept-own") return;
  if (record.state !== "done" && record.state !== "committed") return;
  db.transaction(() => rewriteTaskFolders(db, pathsOf(record.from), record.to))();
}
