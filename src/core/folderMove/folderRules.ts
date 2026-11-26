import path, { type PlatformPath, posix, win32 } from "node:path";
import type Database from "better-sqlite3";

/**
 * A folder location saved on another computer is read by the folder rules of
 * the system that wrote it, never by this computer's: a first mate that moves
 * between a Windows PC and a Mac or Linux computer brings locations this
 * computer's own rules read as one oddly named file (docs/devices.md, "A home
 * on another system").
 */

/**
 * The rules a location was written under, told by its shape: a drive letter
 * or a network share is Windows', anything else POSIX's.
 */
export function rulesOf(location: string): PlatformPath {
  return /^[A-Za-z]:[\\/]/.test(location) || /^[\\/]{2}/.test(location) ? win32 : posix;
}

/** Whether `location` was written under other folder rules than this computer's. */
export function fromOtherRules(location: string, here: PlatformPath = path): boolean {
  return rulesOf(location).sep !== here.sep;
}

/**
 * The folders from `root` down to `location`, both read by the rules `root`
 * was written under: none when they are one place, null when `location` is
 * not inside. Windows' rules take either slash and any letter case, as its
 * disks do.
 */
export function stepsInside(root: string, location: string): string[] | null {
  const there = rulesOf(root);
  // `relative` would read a location of another shape against this process's own folder.
  if (rulesOf(location) !== there || !there.isAbsolute(location)) return null;
  const steps = there.relative(root, location);
  if (steps === "") return [];
  if (steps === ".." || steps.startsWith(`..${there.sep}`) || there.isAbsolute(steps)) return null;
  return steps.split(there.sep);
}

/**
 * `value` as the same place under `to` here, when it lies in `from`, a folder
 * of a computer with other folder rules; undefined when it does not.
 */
export function movedAcross(
  value: string,
  from: string,
  to: string,
  here: PlatformPath = path,
): string | undefined {
  const steps = stepsInside(from, value);
  if (!steps) return undefined;
  return steps.length ? here.join(to, ...steps) : to;
}

/**
 * Rewrites one whole-path column for `from`, a folder of a computer with
 * other folder rules: each row is read here, since SQLite cannot compare by
 * those rules.
 */
export function moveColumnAcross(
  db: Database.Database,
  table: string,
  column: string,
  where: string,
  from: string,
  to: string,
): void {
  // i18n-exempt: SQL, never shown to a person
  const rows = db
    .prepare(
      `SELECT rowid AS id, ${column} AS value FROM ${table}
       WHERE (${where}) AND typeof(${column}) = 'text'`,
    )
    .all() as { id: number; value: string }[];
  // i18n-exempt: SQL, never shown to a person
  const write = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
  for (const row of rows) {
    const moved = movedAcross(row.value, from, to);
    if (moved !== undefined && moved !== row.value) write.run(moved, row.id);
  }
}
