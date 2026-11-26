import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { renderTasksQueryResult } from "../pi/taskTools";
import { LOCAL_MACHINE_ID } from "../session/session";
import { DATABASE_VERSION, openDatabase, openInMemoryDatabase } from "../storage/db";
import { TaskSessionStore } from "../storage/taskSessionStore";
import { exportTaskRecords, parseTaskExport } from "./taskExport";
import { queryTasks } from "./taskQuery";
import { TaskService } from "./taskService";

// INF-1288 approved pieces: a table, one row per conversation, discoverable
// by task key; a stronger-model attempt names, rather than copies, its source.
function setup() {
  const db = openInMemoryDatabase();
  let now = 1_000;
  const tasks = new TaskService({ db, repos: { get: () => undefined }, now: () => now });
  const task = tasks.create({
    id: "crew",
    title: "Trace the saved conversations",
    prompt: "p",
    repoId: null,
  });
  return {
    db,
    tasks,
    task,
    advance: () => {
      now += 100;
    },
  };
}

function facts(file: string, began = "start") {
  return {
    file,
    computer: "Work computer",
    device_id: "work",
    provider: "openai-codex",
    model: "gpt-5",
    account_id: "work-account",
    began,
  };
}

describe("task conversation associations (INF-1288)", () => {
  // INF-1484 E2: completed turns reread the same supplied facts; only transitions are history.
  it.each([
    ["file", { file: "/work/moved/pi-1.jsonl" }, undefined],
    ["computer", { computer: "Home computer" }, undefined],
    ["device", { device_id: "home" }, undefined],
    ["provider", { provider: "anthropic-claude" }, undefined],
    ["model", { model: "gpt-6" }, undefined],
    ["account", { account_id: "home-account" }, undefined],
    ["conversation", {}, "5f0c2a4e-1111-4222-8333-944455556666"],
  ] as const)("records a changed %s but not identical turn-end facts", (_field, changed, token) => {
    const { db, tasks, advance } = setup();
    const file = "/work/crewmates/crew/sessions/pi-1.jsonl";
    tasks.turns.setSessionFile("crew", file, facts(file));
    const original = tasks.archive.sessionObservations("crew");
    advance();
    tasks.turns.setSessionFile("crew", file, facts(file, "resume"));
    expect(tasks.archive.sessionObservations("crew")).toEqual(original);
    expect(tasks.archive.recordedSessions("crew")[0]?.last_at).toBe(1_100);
    advance();
    tasks.turns.setSessionFile("crew", token ?? file, { ...facts(file), ...changed });
    expect(tasks.archive.sessionObservations("crew")).toHaveLength(2);
    advance();
    tasks.turns.setSessionFile("crew", file, facts(file));
    const restored = tasks.archive.sessionObservations("crew");
    expect(restored).toHaveLength(3);
    expect(restored[0]).toEqual(original[0]);
    advance();
    tasks.turns.setSessionFile("crew", file, facts(file));
    expect(tasks.archive.sessionObservations("crew")).toEqual(restored);
    db.close();
  });

  it("restores identical historical observations without applying prospective deduplication", () => {
    const { db, tasks } = setup();
    const file = "/work/crewmates/crew/sessions/pi-1.jsonl";
    tasks.turns.setSessionFile("crew", file, facts(file));
    const first = tasks.archive.sessionObservations("crew")[0];
    if (!first) throw new Error("The initial supplied facts were not observed");
    const { id: _id, seq: _seq, taskId: _task, ...retained } = first;
    new TaskSessionStore(db).observe("crew", retained, "retained-duplicate-observation");
    const lines = exportTaskRecords(tasks, 2_000);
    const other = openInMemoryDatabase();
    const imported = new TaskService({ db: other });
    imported.archive.importRecords(parseTaskExport(lines));
    expect(imported.archive.sessionObservations("crew")).toHaveLength(2);
    expect(exportTaskRecords(imported, 2_000)).toEqual(lines);
    imported.turns.setSessionFile("crew", file, facts(file));
    expect(imported.archive.sessionObservations("crew")).toHaveLength(2);
    other.close();
    db.close();
  });
  it("retains one row across turns, restarts and model changes, with a separate row for a replacement", () => {
    const { db, tasks, advance } = setup();
    const pi = "/work/crewmates/crew/sessions/2026-09-26_pi-1.jsonl";
    tasks.turns.setSessionFile("crew", pi, facts(pi));
    advance();
    tasks.turns.setSessionFile("crew", pi, { ...facts(pi, "resume"), model: "gpt-6" });
    const restarted = new TaskService({ db, repos: { get: () => undefined }, now: () => 1_200 });
    restarted.turns.setSessionFile("crew", pi, facts(pi, "resume"));
    const claude = "5f0c2a4e-1111-4222-8333-944455556666";
    const file = `/work/crewmates/crew/sessions/${claude}.jsonl`;
    restarted.turns.setSessionFile("crew", claude, {
      ...facts(file, "move"),
      provider: "anthropic-claude",
      model: "claude-opus-4-1",
    });
    expect(restarted.archive.sessions("crew")).toEqual([
      {
        ...facts(pi),
        conversation: "2026-09-26_pi-1",
        opened_at: 1_000,
        last_at: 1_200,
        current: false,
      },
      {
        ...facts(file, "move"),
        provider: "anthropic-claude",
        model: "claude-opus-4-1",
        conversation: claude,
        opened_at: 1_200,
        last_at: 1_200,
        current: true,
      },
    ]);
    db.close();
  });

  it("lists retained Pi and Claude files without inventing historical metadata or duplicating sidecars and recorded rows", () => {
    const { db, tasks, task } = setup();
    const dir = scratchDir("infinitary-task-sessions-");
    const pi = join(dir, "2026-09-26_pi-1.jsonl");
    const claude = "5f0c2a4e-1111-4222-8333-944455556666";
    // Real on-disk dialects from sessionReader's provider fixtures.
    writeFileSync(
      pi,
      `${JSON.stringify({ type: "session", version: 3, id: "pi-1", timestamp: "2026-09-26T10:00:00.000Z" })}\n`,
    );
    writeFileSync(
      join(dir, `${claude}.jsonl`),
      `${JSON.stringify({ type: "user", sessionId: claude, uuid: "u1", timestamp: "2026-09-26T10:00:00.000Z", message: { role: "user", content: "Trace the saved conversations" } })}\n`,
    );
    writeFileSync(
      join(dir, `${claude}.served.jsonl`),
      `${JSON.stringify({ kind: "contract", at: 1_000, version: "crewmate" })}\n`,
    );
    tasks.turns.setSessionFile(task.id, claude);
    const reach = { sessionFolderOf: () => ({ dir, computer: "Home computer" }) };
    const query = () =>
      queryTasks(tasks, { key: task.key }, undefined, undefined, undefined, reach);
    const rows = query().rows[0]?.sessions;
    expect(rows).toHaveLength(2);
    expect(rows?.find((row) => row.current)).toMatchObject({
      conversation: claude,
      model: null,
      began: null,
      opened_at: null,
      last_at: null,
    });
    tasks.turns.setSessionFile(task.id, pi, facts(pi));
    expect(query().rows[0]?.sessions).toHaveLength(2);
    console.info(
      "By-key task read with one recorded and one historical conversation:\n" +
        renderTasksQueryResult(query()),
    );
    db.close();
  });

  // A first mate that moved here from another computer brought each conversation it held into
  // this folder, while the row keeps the location the old home saved (docs/devices.md, "A home
  // on another system"). One of the two locations is another system's wherever this runs.
  it.each([
    [
      "a Windows PC",
      "C:\\Users\\ada\\AppData\\Roaming\\infinitary\\crewmates\\crew\\sessions\\pi-1.jsonl",
    ],
    [
      "a Mac",
      "/Users/ada/Library/Application Support/infinitary/crewmates/crew/sessions/pi-1.jsonl",
    ],
  ])(
    "names a conversation the home holds by the file in its own folder when %s saved its location, and leaves one another computer holds as recorded",
    (_system, location) => {
      const { db, tasks, task } = setup();
      const dir = scratchDir("infinitary-task-sessions-");
      const here = join(dir, "pi-1.jsonl");
      for (const id of ["pi-1", "pi-2"])
        writeFileSync(
          join(dir, `${id}.jsonl`),
          `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-26T10:00:00.000Z" })}\n`,
        );
      const home = { computer: "Home computer", device_id: LOCAL_MACHINE_ID };
      // As the old home recorded it: the id is the file's name by that home's folder rules.
      new TaskSessionStore(db).record(task.id, {
        ...facts(location),
        ...home,
        conversation: "pi-1",
        resume_token: location,
        opened_at: 1_000,
        last_at: 1_000,
      });
      // Another computer holds this one, and the folder here keeps a copy of it.
      const elsewhere = "/work/crewmates/crew/sessions/pi-2.jsonl";
      tasks.turns.setSessionFile(task.id, elsewhere, facts(elsewhere));
      // The arrival points the task at the file that came over.
      tasks.turns.setSessionFile(task.id, here);
      const reach = {
        sessionFolderOf: () => ({ dir, computer: home.computer, device: home.device_id }),
      };
      expect(
        queryTasks(tasks, { key: task.key }, undefined, undefined, undefined, reach).rows[0]
          ?.sessions,
      ).toEqual([
        {
          ...facts(here),
          ...home,
          conversation: "pi-1",
          opened_at: 1_000,
          last_at: 1_000,
          current: true,
        },
        {
          ...facts(elsewhere),
          conversation: "pi-2",
          opened_at: 1_000,
          last_at: 1_000,
          current: false,
        },
      ]);
      db.close();
    },
  );

  it("names the earlier attempt by key, keeping its sessions on its own by-key read and off list reads", () => {
    const { db, tasks, task } = setup();
    const pi = "/work/crewmates/crew/sessions/pi-1.jsonl";
    tasks.turns.setSessionFile(task.id, pi, facts(pi));
    const retry = tasks.create({
      id: "retry",
      title: "A stronger-model attempt",
      prompt: "p",
      repoId: null,
      shape: { kind: "implement", escalate_from: task.id },
    });
    const read = queryTasks(tasks, { key: retry.key }).rows[0];
    expect(read).toMatchObject({ earlier_attempt: task.key, sessions: [] });
    expect(queryTasks(tasks, { key: read?.earlier_attempt }).rows[0]?.sessions).toHaveLength(1);
    for (const row of queryTasks(tasks, {}).rows) expect(row).not.toHaveProperty("sessions");
    console.info(
      "Stronger-model task read:\n" +
        renderTasksQueryResult({ rows: read ? [read] : [], total: 1 }),
    );
    db.close();
  });

  it("exports and reloads every recorded conversation, preserving the exact association", () => {
    const { db, tasks } = setup();
    const pi = "/work/crewmates/crew/sessions/pi-1.jsonl";
    tasks.turns.setSessionFile("crew", pi, facts(pi));
    const lines = exportTaskRecords(tasks, 2_000);
    const other = openInMemoryDatabase();
    const imported = new TaskService({ db: other, repos: { get: () => undefined } });
    imported.archive.importRecords(parseTaskExport(lines));
    expect(imported.archive.sessions("crew")).toEqual(tasks.archive.sessions("crew"));
    expect(exportTaskRecords(imported, 2_000)).toEqual(lines);
    other.close();
    db.close();
  });

  it("upgrades a populated earlier database without changing its resume pointer", () => {
    const dir = scratchDir("infinitary-task-session-migration-");
    const old = openDatabase(dir, DATABASE_VERSION - 1);
    const tasks = new TaskService({ db: old, repos: { get: () => undefined } });
    tasks.create({ id: "old", title: "Earlier work", prompt: "p", repoId: null });
    tasks.turns.setSessionFile("old", "/work/old.jsonl");
    old.close();
    const upgraded = openDatabase(dir);
    const current = new TaskService({ db: upgraded, repos: { get: () => undefined } });
    expect(current.get("old")?.sessionFile).toBe("/work/old.jsonl");
    expect(current.archive.sessions("old")).toEqual([]);
    current.turns.setSessionFile("old", "/work/old.jsonl", facts("/work/old.jsonl", "resume"));
    expect(current.archive.sessions("old")).toHaveLength(1);
    expect(current.archive.purge()).toBe(1);
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM task_sessions").get()).toEqual({ n: 0 });
    upgraded.close();
  });
});
