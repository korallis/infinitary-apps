import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { recordNewerMigration } from "../../../tests/helpers/database";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { assertSavedDataCompatible, openDatabase, openInMemoryDatabase } from "./db";
import { markFurtherLoginsFormat, UnsupportedSavedDataError } from "./savedDataCompatibility";

function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir)
      .sort()
      .map((name) => [name, readFileSync(join(dir, name)).toString("base64")]),
  );
}

describe("saved-data compatibility before writable initialization", () => {
  it("opens fresh, current and supported older databases", () => {
    const current = openInMemoryDatabase();
    const expected = current.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get();
    current.close();
    for (const through of [undefined, 1, 40]) {
      const dir = scratchDir("fm-compat-supported-");
      openDatabase(dir, through).close();
      const db = openDatabase(dir);
      expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual(expected);
      db.close();
      expect(JSON.parse(readFileSync(join(dir, "saved-data-format.json"), "utf8"))).toEqual({
        schemaVersion: 1,
        revision: 1,
      });
    }
  });

  it("refuses future migrations without altering database, views or saved files", () => {
    const dir = scratchDir("fm-compat-future-");
    const db = openDatabase(dir);
    recordNewerMigration(db);
    db.close();
    writeFileSync(join(dir, "saved-conversation.jsonl"), "protected notes\n");
    const before = snapshot(dir);
    expect(() => openDatabase(dir)).toThrow(UnsupportedSavedDataError);
    expect(snapshot(dir)).toEqual(before);
  });

  it("sees a future migration committed only in WAL without changing the source sidecars", () => {
    const dir = scratchDir("fm-compat-wal-");
    const db = openDatabase(dir);
    try {
      db.pragma("wal_autocheckpoint = 0");
      recordNewerMigration(db);
      const before = snapshot(dir);
      expect(() => assertSavedDataCompatible(dir)).toThrow(UnsupportedSavedDataError);
      expect(snapshot(dir)).toEqual(before);
    } finally {
      db.close();
    }
  });

  it.each([
    "{",
    '{"schemaVersion":1,"revision":3}',
    '{"schemaVersion":2,"revision":1}',
    '{"schemaVersion":1,"revision":1,"unknown":true}',
  ])("refuses unsupported format %s without writing", (format) => {
    const dir = scratchDir("fm-compat-format-");
    openDatabase(dir).close();
    writeFileSync(join(dir, "saved-data-format.json"), format);
    const before = snapshot(dir);
    expect(() => openDatabase(dir)).toThrow(UnsupportedSavedDataError);
    expect(snapshot(dir)).toEqual(before);
  });

  // The captain's choice on the review of several Claude logins: block
  // older versions from a folder that holds one, with a safe way back.
  it("marks a folder that holds a further Claude login as revision 2, opens it, and hands it back once none is left", () => {
    const dir = scratchDir("fm-compat-further-");
    openDatabase(dir).close();
    const marker = () => JSON.parse(readFileSync(join(dir, "saved-data-format.json"), "utf8"));
    markFurtherLoginsFormat(dir, true);
    expect(marker()).toEqual({ schemaVersion: 1, revision: 2 });
    openDatabase(dir).close();
    markFurtherLoginsFormat(dir, true);
    expect(marker()).toEqual({ schemaVersion: 1, revision: 2 });
    markFurtherLoginsFormat(dir, false);
    expect(marker()).toEqual({ schemaVersion: 1, revision: 1 });
  });

  it("marks a folder from before the marker, and leaves a marker it cannot read as it is", () => {
    const legacy = scratchDir("fm-compat-further-legacy-");
    markFurtherLoginsFormat(legacy, false);
    expect(readdirSync(legacy), "nothing to hand back, so nothing is written").toEqual([]);
    markFurtherLoginsFormat(legacy, true);
    expect(JSON.parse(readFileSync(join(legacy, "saved-data-format.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      revision: 2,
    });
    const newer = scratchDir("fm-compat-further-newer-");
    writeFileSync(join(newer, "saved-data-format.json"), '{"schemaVersion":1,"revision":3}');
    markFurtherLoginsFormat(newer, true);
    markFurtherLoginsFormat(newer, false);
    expect(readFileSync(join(newer, "saved-data-format.json"), "utf8")).toBe(
      '{"schemaVersion":1,"revision":3}',
    );
  });

  it("does not guess a database with unknown tables or invalid migration history", () => {
    const dir = scratchDir("fm-compat-unknown-");
    const db = new Database(join(dir, "firstmate.db"));
    db.exec("CREATE TABLE unknown_data (value TEXT)");
    db.close();
    expect(() => assertSavedDataCompatible(dir)).toThrow(UnsupportedSavedDataError);
    const known = scratchDir("fm-compat-gap-");
    const old = openDatabase(known);
    old.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(0);
    old.close();
    expect(() => assertSavedDataCompatible(known)).toThrow(UnsupportedSavedDataError);
  });
});
