import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { repairMovedTaskFolders } from "../folderMove/taskFolders";
import {
  addCardAfterMerge,
  addCardAnswerer,
  addCardContributions,
  addCardFiles,
  addCardLiveReads,
  clearInterimAnswers,
} from "./cardMigrations";
import { addOriginalCaptainText } from "./correctionMigrations";
import { addCrewResponses } from "./inboxMigrations";
import { migrateChanges } from "./migrateChanges";
import {
  addHousekeepingIndexes,
  addPluginKind,
  addPushedShareTime,
  addTaskPin,
  MIGRATIONS,
} from "./migrations";
import { privateCopy } from "./privateCopy";
import { createQueryIndexes } from "./queryIndexes";
import {
  assertPersistedFormatsSupported,
  recordPersistedFormat,
  UnsupportedSavedDataError,
} from "./savedDataCompatibility";
import {
  migrateTaskDeliveryRecords,
  migrateTaskExecution,
  migrateTaskPolicies,
  migrateTaskReferences,
  retireReviewEdges,
} from "./taskRecordMigrations";
import { migrateTaskRecordRetirement } from "./taskRecordProjection";
import { REPETITION_TABLES } from "./taskRepetitionStore";
import { registerTaskSearch } from "./taskSelection";
import {
  createViews,
  dropViews,
  migratePublishedViews,
  registerViewFunctions,
  viewsCurrent,
} from "./views";

/**
 * userData/firstmate.db: better-sqlite3 in WAL mode with forward-only
 * embedded migrations (docs/architecture.md section 7). Each migration runs
 * once, in order, inside a transaction. The ledger is migrations.ts; the
 * steps that need code live with their owners (taskRecordMigrations.ts,
 * inboxMigrations.ts, cardMigrations.ts), and the optional query indexes
 * in queryIndexes.ts. This file opens the database, refuses saved data it
 * does not know, and names the migrations upgrade fixtures stop at.
 */

export type AppDatabase = Database.Database;

/** The response migration's identity, including for exact predecessor-schema fixtures. */
export const CREW_RESPONSE_VERSION = MIGRATIONS.indexOf(addCrewResponses) + 1;

/** The shared-card migration's identity (INF-2225), for exact predecessor-schema fixtures. */
export const CARD_CONTRIBUTIONS_VERSION = MIGRATIONS.indexOf(addCardContributions) + 1;

/** The migration that cleared the answers interim lines kept (INF-2730). */
export const INTERIM_ANSWERS_VERSION = MIGRATIONS.indexOf(clearInterimAnswers) + 1;

/** The current database format, derived from the embedded migration ledger. */
export const DATABASE_VERSION = MIGRATIONS.length;

/** Source captions introduced for new input only, never reconstructed from old text. */
export const CAPTAIN_TEXT_VERSION = MIGRATIONS.indexOf(addOriginalCaptainText) + 1;

/** The migration that made the change record (INF-1868 piece 1). */
export const CHANGES_VERSION = MIGRATIONS.indexOf(migrateChanges) + 1;

/** The migration that removed the host's review edges (INF-1876). */
export const REVIEW_EDGES_VERSION = MIGRATIONS.indexOf(retireReviewEdges) + 1;

/** The incremental completed-operation state (INF-1998). */
export const TOOL_REPETITION_VERSION = MIGRATIONS.indexOf(REPETITION_TABLES) + 1;

export const CARD_ANSWERER_MIGRATION_VERSION = MIGRATIONS.indexOf(addCardAnswerer) + 1;
export const CARD_AFTER_MERGE_MIGRATION_VERSION = MIGRATIONS.indexOf(addCardAfterMerge) + 1;
export const CARD_FILES_MIGRATION_VERSION = MIGRATIONS.indexOf(addCardFiles) + 1;
export const CARD_LIVE_READS_MIGRATION_VERSION = MIGRATIONS.indexOf(addCardLiveReads) + 1;
export const PLUGIN_KIND_MIGRATION_VERSION = MIGRATIONS.indexOf(addPluginKind) + 1;
export const PUSHED_SHARE_TIME_MIGRATION_VERSION = MIGRATIONS.indexOf(addPushedShareTime) + 1;

/** Named boundaries keep upgrade fixtures tied to their migration, not the newest release. */
export const HOUSEKEEPING_INDEXES_MIGRATION_VERSION =
  MIGRATIONS.indexOf(addHousekeepingIndexes) + 1;

/** The migration that moved each task's references out of its work shape (INF-1296 piece 2). */
export const TASK_REFERENCES_VERSION = MIGRATIONS.indexOf(migrateTaskReferences) + 1;

/** The migration that moved each task's running work to its own row (INF-1296 piece 3). */
export const TASK_EXECUTION_VERSION = MIGRATIONS.indexOf(migrateTaskExecution) + 1;

/** The migration that moved each task's policy inputs out of its work shape (INF-1296 piece 3). */
export const TASK_POLICIES_VERSION = MIGRATIONS.indexOf(migrateTaskPolicies) + 1;

/** The migration that moved each task's change evidence and permissions to their own rows (INF-1296 piece 4). */
export const TASK_DELIVERY_RECORDS_VERSION = MIGRATIONS.indexOf(migrateTaskDeliveryRecords) + 1;

export const TASK_RECORD_RETIREMENT_VERSION = MIGRATIONS.indexOf(migrateTaskRecordRetirement) + 1;

/** The migration that added when a task was pinned (INF-3127 piece 1). */
export const TASK_PIN_VERSION = MIGRATIONS.indexOf(addTaskPin) + 1;

/** The migration that published the views; every later one re-creates them. */
const VIEWS_VERSION = MIGRATIONS.indexOf(migratePublishedViews) + 1;

/**
 * Read a SQLite file through a private, read-only copy of it and its WAL.
 * Even a readonly SQLite connection can create WAL/SHM sidecars, so
 * inspecting the copy is what keeps an inspection - and a refusal - from
 * changing even those files. The copy is a clone where the disk can make
 * one (`privateCopy`), so a large database costs milliseconds, not a full
 * read and write. Whatever `read` throws, or the copy fails to open with,
 * reaches the caller; the copy is removed either way.
 */
export function readDatabaseSnapshot<T>(path: string, read: (db: AppDatabase) => T): T {
  const snapshot = mkdtempSync(join(tmpdir(), "fm-saved-data-check-"));
  let db: AppDatabase | undefined;
  try {
    const copy = join(snapshot, "snapshot.db");
    privateCopy(path, copy);
    if (existsSync(`${path}-wal`)) privateCopy(`${path}-wal`, `${copy}-wal`);
    db = new Database(copy, { readonly: true, fileMustExist: true });
    return read(db);
  } finally {
    db?.close();
    rmSync(snapshot, { recursive: true, force: true });
  }
}

/**
 * Whether a database's recorded schema history is one this build knows:
 * no history with no tables is a fresh file; tables without history, or any
 * recorded version outside 1..known, is not. Every recorded migration must
 * be known, not just the newest row.
 */
export function schemaHistoryKnown(db: AppDatabase, known: number): boolean {
  const hasHistory = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!hasHistory) return !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table'").get();
  const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
    version: number;
  }[];
  return rows.every(
    (row) => Number.isInteger(row.version) && row.version >= 1 && row.version <= known,
  );
}

/** Inspect before the first writable connection, including WAL setup and derived views. */
export function assertSavedDataCompatible(userDataDir: string): void {
  assertPersistedFormatsSupported(userDataDir);
  const path = join(userDataDir, "firstmate.db");
  if (!existsSync(path)) return;
  // Startup owns the app's single-instance lock; no normal service writer is running.
  let known: boolean;
  try {
    known = readDatabaseSnapshot(path, (db) => schemaHistoryKnown(db, DATABASE_VERSION));
  } catch {
    // Unreadable/corrupt or unrecognized history is not permission to migrate.
    throw new UnsupportedSavedDataError("database");
  }
  if (!known) throw new UnsupportedSavedDataError("database");
}

export function openDatabase(userDataDir: string, throughVersion?: number): AppDatabase {
  assertSavedDataCompatible(userDataDir);
  return openCheckedDatabase(userDataDir, throughVersion);
}

/**
 * Open a folder whose saved data this start has already checked with
 * `assertSavedDataCompatible`, with nothing written to it since: the first
 * mate's start checks before anything else and opens later, so it reads
 * the database's history once, not twice.
 */
export function openCheckedDatabase(userDataDir: string, throughVersion?: number): AppDatabase {
  mkdirSync(userDataDir, { recursive: true });
  const db = new Database(join(userDataDir, "firstmate.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Keep hot housekeeping pages in SQLite instead of repeatedly copying
  // them through the small default cache. Negative units are KiB (32 MiB),
  // an advisory cache target, not a preallocation or a bound on the database.
  db.pragma("cache_size = -32768");
  registerViewFunctions(db);
  registerTaskSearch(db);
  migrate(db, throughVersion);
  // A home that already moved still names the older folder on a task held
  // elsewhere. The rewrite is idempotent, and a folder with no move record
  // is left alone (folderMove/taskFolders.ts).
  repairMovedTaskFolders(userDataDir, db);
  recordPersistedFormat(userDataDir);
  return db;
}

export function openInMemoryDatabase(throughVersion?: number): AppDatabase {
  const db = new Database(":memory:");
  registerViewFunctions(db);
  registerTaskSearch(db);
  migrate(db, throughVersion);
  return db;
}

function migrate(db: AppDatabase, throughVersion?: number): void {
  const through = throughVersion ?? DATABASE_VERSION;
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)");
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map(
      (row) => row.version,
    ),
  );
  const fresh = applied.size === 0;
  MIGRATIONS.forEach((migration, index) => {
    const version = index + 1;
    if (version > through) return;
    if (applied.has(version)) return;
    const run = db.transaction(() => {
      // A view pins the columns it reads: a later migration runs with the
      // views gone and puts them back as its last step (views.ts).
      if (version > VIEWS_VERSION) dropViews(db);
      if (typeof migration === "string") db.exec(migration);
      else migration(db, fresh);
      if (version > VIEWS_VERSION) createViews(db);
      db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(version);
    });
    run();
  });
  if (through === DATABASE_VERSION) createQueryIndexes(db);
  // An edit to views.ts reaches an existing database without a migration of
  // its own: the views are derived, so a drift is re-created, never altered.
  if (through >= VIEWS_VERSION && !viewsCurrent(db)) db.transaction(() => createViews(db))();
}
