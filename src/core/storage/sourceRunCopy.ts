import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATABASE_VERSION, readDatabaseSnapshot } from "./db";
import { KNOWLEDGE_DB_FILE, KNOWLEDGE_SCHEMA_VERSION } from "./knowledgeStore";
import { privateCopy } from "./privateCopy";
import { markFurtherLoginsFormat } from "./savedDataCompatibility";

/**
 * The copy of the saved record a run from source keeps before it first opens
 * the person's own data folder (docs/saved-data-compatibility.md, "A run from
 * source"). `pnpm dev` opens the folder the installed app keeps, and newer
 * source may migrate the record past what the installed app opens; the copy
 * is what to go back to. It is kept before the first run from source, and
 * again, replacing it, before any run whose build would change how the
 * record is saved (`formatChangeDue`), so the copy is always the record as it
 * stood just before the newest such change.
 */
export const SOURCE_RUN_COPY_DIR = "before-source-run";

/**
 * The files whose formats a newer build may move forward: the database with
 * its write-ahead log, the knowledge collection's, and the format marker.
 * Each is copied as it stands while this run holds the folder's lock, so a
 * database and its log are copied as one state.
 */
export const SOURCE_RUN_COPY_FILES = [
  "firstmate.db",
  "firstmate.db-wal",
  "saved-data-format.json",
  join("knowledge", KNOWLEDGE_DB_FILE),
  join("knowledge", `${KNOWLEDGE_DB_FILE}-wal`),
] as const;

/**
 * The kept copy's format marker follows the folder's while a further Claude
 * login is held (docs/saved-data-compatibility.md, "Further Claude logins"):
 * the copy holds no account records, so its older marker copied back beside
 * such a login would open the folder to a build that runs it on the default
 * login.
 */
export function markKeptCopyFurtherLogins(dataDir: string, held: boolean): void {
  const kept = join(dataDir, SOURCE_RUN_COPY_DIR);
  if (existsSync(join(kept, SOURCE_RUN_COPY_FILES[0]))) markFurtherLoginsFormat(kept, held);
}

/**
 * Whether this build would change how the record in `dataDir` is saved
 * when it opens it: a database migration the record has not had - in the
 * saved record or the knowledge collection - or no format marker yet. A
 * database this build cannot read is not due: the compatibility guard and
 * the knowledge collection refuse it and never migrate it, so the kept copy
 * stays the last good one.
 */
export function formatChangeDue(dataDir: string): boolean {
  if (!existsSync(join(dataDir, "saved-data-format.json"))) return true;
  const missing = (path: string, known: number) => {
    if (!existsSync(path)) return false;
    try {
      const applied = readDatabaseSnapshot(path, (db) => {
        const hasHistory = db
          .prepare(
            // i18n-exempt: SQL, never shown to a person
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
          )
          .get();
        if (!hasHistory) return new Set<number>();
        return new Set(
          // i18n-exempt: SQL, never shown to a person
          (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map(
            (row) => row.version,
          ),
        );
      });
      for (let version = 1; version <= known; version += 1) if (!applied.has(version)) return true;
      return false;
    } catch {
      return false;
    }
  };
  return (
    missing(join(dataDir, "firstmate.db"), DATABASE_VERSION) ||
    missing(join(dataDir, "knowledge", KNOWLEDGE_DB_FILE), KNOWLEDGE_SCHEMA_VERSION)
  );
}

/**
 * Keeps the copy, before anything opens the record, and answers where it
 * is; null, keeping nothing, when the folder holds no record yet, or a copy
 * is kept and this build changes nothing in how the record is saved. A new
 * copy replaces the older one. It is made beside its final place and moved
 * there whole, so a start that ends partway keeps the older copy and the
 * next start copies again. `copy` is `privateCopy`, which clones where the
 * disk can.
 */
export function keepRecordBeforeSourceRun(
  dataDir: string,
  copy: (from: string, to: string) => void = privateCopy,
): string | null {
  const kept = join(dataDir, SOURCE_RUN_COPY_DIR);
  // No record yet, as on a fresh computer or a view of another home: there
  // is nothing to go back to, and the first record this folder gets is kept
  // by the run that first finds it.
  if (!existsSync(join(dataDir, SOURCE_RUN_COPY_FILES[0]))) return null;
  if (existsSync(kept) && !formatChangeDue(dataDir)) return null;
  const partial = `${kept}.partial`;
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true, mode: 0o700 });
  for (const file of SOURCE_RUN_COPY_FILES) {
    const from = join(dataDir, file);
    if (!existsSync(from)) continue;
    const to = join(partial, file);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    copy(from, to);
  }
  const older = `${kept}.older`;
  rmSync(older, { recursive: true, force: true });
  if (existsSync(kept)) renameSync(kept, older);
  renameSync(partial, kept);
  rmSync(older, { recursive: true, force: true });
  return kept;
}
