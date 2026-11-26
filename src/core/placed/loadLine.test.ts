import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatNumber } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
import { type LoadRun, loadRunWords } from "@shared/load";
import { RESOURCE_MAX_AGE_MS, type ResourceObservation } from "@shared/resources";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../../../tests/helpers/deferred";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import * as platform from "../platform";
import {
  JOURNAL_FILE,
  JOURNAL_MAX_BYTES,
  type LoadClaimAnswer,
  type LoadJobs,
  type LoadJournalEntry,
  LoadLine,
  LoadReceiptUnreadError,
} from "./loadLine";
import { type ProcessReading, processesFromPs } from "./processResources";

// INF-1685 accepted direction A: the plan's worked 14-core case and its busy
// lone-run rule. Identities are recorded Mac metadata from processResources.test.ts.
// The line owns admission; exercise its public claims and observed process windows,
// including two runs belonging to one task, rather than substituting task totals.
const identities =
  processesFromPs(`  118 1 118 1:17.87 45040 Tue Oct 27 11:03:36 2026
  119 1 119 0:01.46 6320 Tue Oct 27 11:03:36 2026
`) ?? [];
const reading: Extract<ResourceObservation, { status: "sampled" }> = {
  epoch: "4f0c2a8e-6b1d-4c3e-9a57-2d8f1e0b7c64",
  sequence: 1,
  status: "sampled",
  sampleMs: 2000,
  cpu: { logicalCpus: 14, idleFraction: 0 },
  memory: {
    totalBytes: 24 * 1024 ** 3,
    freeBytes: 16 * 1024 ** 3,
    availableBytes: 16 * 1024 ** 3,
    memoryPressure: "normal",
  },
};
const lines: LoadLine[] = [];
afterEach(() => {
  for (const line of lines.splice(0)) line.dispose();
});
function rowAt(rows: ProcessReading[], index: number): ProcessReading {
  const row = rows[index];
  if (!row) throw new Error("The recorded process identity is missing");
  return row;
}
/** A claim these tests expect a hold for: a readable table checked the caller. */
async function held(answer: Promise<LoadClaimAnswer>): Promise<LoadRun> {
  const run = await answer;
  if (!run.id) throw new Error("The claim was answered without a hold");
  return run;
}
function addWork(rows: ProcessReading[], cores: number, elapsedMs: number) {
  const row = rowAt(rows, 0);
  if (row.cpuMs === undefined) throw new Error("The recorded CPU counter is missing");
  rows[0] = { ...row, cpuMs: row.cpuMs + cores * elapsedMs };
}
function setup() {
  const rows: ProcessReading[] = identities.map((row) => ({ ...row }));
  const clock = { now: 0 };
  const line = new LoadLine({
    stateFile: join(scratchDir("cpu-line-"), "holds.json"),
    now: () => clock.now,
    processes: async () => rows,
    groupExists: () => true,
  });
  lines.push(line);
  const claim = (index: number, cpu = 4, memoryBytes = 1024 ** 3) =>
    held(
      line
        .forTask("same-task")
        .claim({ pid: rowAt(rows, index).pid, demand: { cpu, memoryBytes } }),
    );
  const receipt = async (hold: string, index = 0) => {
    const leader = rowAt(rows, index);
    // Recorded child metadata, placed under the admitted leader for this fixture.
    const child = rowAt(processesFromPs("1 0 1 2:01.03 23008 Tue Oct 27 11:03:29 2026") ?? [], 0);
    rows.push({ ...child, group: leader.pid, parent: leader.pid });
    const input = { hold, pid: leader.pid, payload: child.pid, started: child.started };
    await line.forTask("same-task").receipt(input);
    return input;
  };
  let sequence = 0;
  const sample = (start: number, end: number, idle = 9.5 / 14, epoch = reading.epoch) => {
    clock.now = end;
    line.observe(
      {
        ...reading,
        epoch,
        sequence: ++sequence,
        sampleMs: end - start,
        cpu: { ...reading.cpu, idleFraction: idle },
      },
      rows,
      end,
      undefined,
      { epoch, start, end },
    );
  };
  return { line, rows, claim, clock, receipt, sample };
}

// INF-2186: a posture witness needs live command ids, never a capacity sample.
it("reads declared task ids without checking capacity or sampling resources", async () => {
  const f = setup();
  await f.claim(0);
  const capacity = vi.spyOn(f.line as unknown as { capacity(): unknown }, "capacity");
  try {
    for (let row = 0; row < 40; row += 1) expect(f.line.taskIds()).toEqual(["same-task"]);
    expect(capacity).not.toHaveBeenCalled();
    f.line.snapshot();
    expect(capacity).toHaveBeenCalled();
  } finally {
    capacity.mockRestore();
  }
});

// INF-1978: an unavailable OS reading is not evidence that a waiting group ended.
// Recorded identities above drive the same public claim boundary as native wrappers.
describe("queued identity checks", () => {
  it("retains the same hold and queue position, but never grants on an unreadable table", async () => {
    let rows: ProcessReading[] | null = identities;
    const stateFile = join(scratchDir("identity-line-"), "holds.json");
    const line = new LoadLine({
      stateFile,
      processes: async () => rows,
      groupExists: () => true,
    });
    lines.push(line);
    const input = { pid: rowAt(identities, 0).pid, demand: { cpu: 4, memoryBytes: 1024 ** 3 } };
    const task = line.forTask("queued");
    const first = await task.claim(input);
    const following = line.forTask("following");
    const next = { ...input, pid: rowAt(identities, 1).pid };
    const second = await following.claim(next);
    const saved = readFileSync(stateFile, "utf8");
    rows = null;
    expect(await task.claim(input)).toEqual({ ...first, reason: "unavailable" });
    expect(await following.claim(next)).toEqual({ ...second, reason: "unavailable" });
    expect(readFileSync(stateFile, "utf8")).toBe(saved);
    expect(line.snapshot().runs.map((run) => run.taskId)).toEqual(["queued", "following"]);
    line.observe(reading, null);
    expect(line.snapshot().runs[0]?.state).toBe("running");
    expect(await task.claim(input)).toEqual({ ...first, reason: "unavailable" });
    rows = identities;
    expect(await task.claim(input)).toEqual({ ...first, state: "running", reason: undefined });
  });

  // Re-typed for INF-3192 (INF-3188's reproduction): while simulators booted, the
  // process table read ran out its time limit and first claims were refused, so
  // their runs ended. An unreadable table proves nothing about a caller, so a
  // claim it cannot check waits and asks again, granting nothing; only a readable
  // table that lacks the caller is still refused.
  it("answers a claim it cannot check on an unreadable table with a wait that grants nothing", async () => {
    let rows: ProcessReading[] | null = identities;
    const line = new LoadLine({
      stateFile: join(scratchDir("identity-refusal-"), "holds.json"),
      processes: async () => rows,
      groupExists: () => true,
    });
    lines.push(line);
    const input = { pid: rowAt(identities, 0).pid, demand: { cpu: 4, memoryBytes: 1024 ** 3 } };
    const task = line.forTask("queued");
    const kept = await task.claim(input);
    rows = null;
    const unread = { state: "waiting", reason: "unavailable" };
    // The verified caller keeps its place.
    expect(await task.claim(input)).toMatchObject({ ...unread, id: kept.id });
    for (const claim of [
      () => line.forTask("other").claim(input),
      () => task.claim({ ...input, pid: rowAt(identities, 1).pid }),
      () => task.claim({ ...input, demand: { ...input.demand, cpu: 5 } }),
      () => task.claim({ ...input, demand: { ...input.demand, memoryBytes: 2 * 1024 ** 3 } }),
      () => task.claim({ ...input, parent: kept.id }),
    ]) {
      const answer = await claim();
      expect(answer).toMatchObject(unread);
      expect(answer.id).toBeUndefined();
    }
    expect(line.snapshot().runs).toEqual([kept]);
    await expect(task.claim({ ...input, pid: 0 })).rejects.toThrow(
      "The run has no process identity.",
    );
    rows = identities.slice(1); // A readable table proves the original caller is missing.
    await expect(task.claim(input)).rejects.toThrow(
      "The run's process is not running; nothing started.",
    );
    rows = identities;
    await expect(task.claim({ ...input, demand: { ...input.demand, cpu: 5 } })).rejects.toThrow(
      "This process group already declared a different hold.",
    );
    expect(line.snapshot().runs).toEqual([kept]);
  });
});

describe("accepted counted-once admission", () => {
  // Re-typed for INF-2165 direction A (captain approved): a lone run is judged
  // against installed memory less the margin, not today's free reading, but
  // still needs a fresh reading and normal pressure.
  it("starts a lone run at zero idle and no free memory, but still requires a fresh reading and normal pressure", async () => {
    const { line, claim, clock } = setup();
    expect((await claim(0)).reason).toBe("unavailable");
    const empty = { ...reading, memory: { ...reading.memory, availableBytes: 0 } };
    line.observe({ ...empty, memory: { ...empty.memory, memoryPressure: "warning" } }, null);
    expect(line.snapshot().runs[0]?.reason).toBe("pressure");
    line.observe({ ...empty, memory: { ...empty.memory, memoryPressure: "critical" } }, null);
    expect(line.snapshot().runs[0]?.reason).toBe("pressure");
    // A reading taken longer ago than the freshness allowance starts nothing.
    clock.now = RESOURCE_MAX_AGE_MS + 1;
    line.observe(empty, null, 0);
    expect(line.snapshot().runs[0]).toMatchObject({ state: "waiting", reason: "unavailable" });
    line.observe(empty, null, clock.now);
    expect(line.snapshot().runs[0]?.state).toBe("running");
    expect((await claim(1)).state).toBe("waiting");
    console.info("Lone-run proof", JSON.stringify(line.snapshot()));
  });

  // INF-2165's worked case: the MacBook's 24 GB with 5.4 GB free admits a lone 4 GB run.
  // Re-typed for INF-6381 (captain approved): an ask above installed memory less the
  // 10 percent margin could never start and held the line behind it, so it is refused.
  it("judges a lone run's memory ask against installed memory less the margin", async () => {
    const { line, claim } = setup();
    const macBook = { ...reading, memory: { ...reading.memory, availableBytes: 5.4 * 1024 ** 3 } };
    line.observe(macBook, null);
    expect((await claim(0, 4, 4 * 1024 ** 3)).state).toBe("running");
    const other = setup();
    other.line.observe(reading, null);
    const total = reading.memory.totalBytes;
    const most = Math.floor(total * 0.9);
    await expect(other.claim(0, 1, most + 1024 ** 2)).rejects.toThrow(
      `Declare at most ${Math.floor(most / 1024 ** 2)} MiB`,
    );
    expect(other.line.snapshot().runs).toEqual([]);
    expect((await other.claim(0, 1, most)).state).toBe("running");
  });

  // INF-2165's worked case: a 4 GB run using its 4 GB with 4.0 GB free admits a 1 GB run,
  // because the reading already lacks the running group's resident memory.
  it("counts a running run's memory once, and reserves an unmeasured run's declaration", async () => {
    const { line, rows, claim } = setup();
    line.observe(reading, rows);
    expect((await claim(0, 1, 4 * 1024 ** 3)).state).toBe("running");
    // Idle processors leave room, so only memory decides the second run.
    const four = {
      ...reading,
      cpu: { ...reading.cpu, idleFraction: 1 },
      memory: { ...reading.memory, availableBytes: 4 * 1024 ** 3 },
    };
    // No process table: nothing measured, so nothing is added back and the 1 GB run waits.
    line.observe(four, null);
    expect(await claim(1, 1)).toMatchObject({ state: "waiting", reason: "capacity" });
    rows[0] = { ...rowAt(rows, 0), residentBytes: 4 * 1024 ** 3 };
    line.observe(four, rows);
    expect(line.snapshot().runs[1]?.state).toBe("running");
    console.info("Memory counted-once proof", JSON.stringify(line.snapshot()));
  });

  // INF-2228 approval explicitly replaces this obsolete persistent-CPU policy expectation.
  it("admits a second busy run after launch coverage, and debits that start on unchanged readings", async () => {
    const { line, rows, claim, clock, receipt, sample } = setup();
    line.observe(reading, null);
    const first = await claim(0);
    const window = { first: rows.map((row) => ({ ...row })), elapsedMs: 2000 };
    addWork(rows, 4, window.elapsedMs);
    clock.now = 1;
    await receipt(first.id);
    sample(2, 2002);
    expect((await claim(1)).state).toBe("running");
    // The next start still costs four processors. A new request cannot spend
    // that same 7.6-processor budget again via claim, timer or reconsideration.
    const third = rowAt(rows, 2);
    rows[2] = { ...third, group: third.pid }; // the same recorded identity is now an independent group
    const input = { pid: third.pid, demand: { cpu: 4, memoryBytes: 1024 ** 3 } };
    const queued = line.forTask("third");
    expect((await queued.claim(input)).state).toBe("waiting");
    line.reconsider();
    expect((await queued.claim(input)).state).toBe("waiting");
    console.info(
      "Measured busy admission and durable startup debit",
      JSON.stringify(line.snapshot()),
    );
  });

  // INF-2228 approved retyping: group CPU counters no longer create capacity or
  // a persistent maximum charge. A trustworthy aggregate interval is sufficient.
  it("uses observed idle without a busy-group add-back or per-group CPU requirement", async () => {
    const { line, claim, clock, receipt, sample, rows } = setup();
    line.observe(reading, null);
    const first = await claim(0);
    clock.now = 1;
    await receipt(first.id);
    for (const row of rows) delete row.cpuMs;
    // Old rule: 80% of (6 + 8), minus 8 = 3.2. New rule: 80% of 6 = 4.8.
    sample(2, 2002, 6 / 14);
    expect((await claim(1)).state).toBe("running");
    console.info("Aggregate-only admission", JSON.stringify(line.snapshot()));
  });
});

// Captain's approved INF-2228 plan: startup evidence, interval identity and
// restart boundaries own CPU coverage; memory and the living-group count do not change.
describe("verified processor startup coverage", () => {
  it("keeps a delayed or unconfirmed launch charged through duplicate claims and quiet readings", async () => {
    const { line, claim, sample } = setup();
    line.observe(reading, null);
    const first = await claim(0, 8);
    sample(1, 2001);
    expect((await claim(0, 8)).id).toBe(first.id);
    expect((await claim(1)).state).toBe("waiting");
    sample(2001, 4001);
    line.reconsider();
    expect(line.snapshot().runs[1]?.state).toBe("waiting");
  });

  it("does not mistake an overlapping interval, reused endpoint or older reply for coverage", async () => {
    const { line, claim, receipt, clock, sample, rows } = setup();
    line.observe(reading, null);
    const first = await claim(0, 8);
    sample(0, 2000);
    await receipt(first.id);
    sample(1000, 3000); // request completed after verification, aggregate began before it
    expect((await claim(1)).state).toBe("waiting");
    const repeated = {
      ...reading,
      sequence: 99,
      sampleMs: 500,
      cpu: { ...reading.cpu, idleFraction: 1 },
    };
    line.observe(repeated, rows, clock.now, undefined, {
      epoch: reading.epoch,
      start: 2500,
      end: 3000,
    });
    expect(line.snapshot().runs[1]?.state).toBe("waiting");
    line.observe({ ...repeated, sequence: 1 }, rows, clock.now, undefined, {
      epoch: reading.epoch,
      start: 2100,
      end: 2900,
    });
    expect(line.snapshot().runs[1]?.state).toBe("waiting");
    sample(3000, 5000);
    expect(line.snapshot().runs[1]?.state).toBe("running");
    console.info(
      "Post-launch interval boundary",
      JSON.stringify({ verifiedAt: 2000, covered: [3000, 5000], runs: line.snapshot().runs }),
    );
  });

  it("requires fresh coverage for a new sampler lifetime and refuses stale aggregate capacity", async () => {
    const { line, claim, receipt, sample, clock, rows } = setup();
    line.observe(reading, null);
    const first = await claim(0, 8);
    await receipt(first.id);
    sample(1, 2001);
    const otherEpoch = "773c6625-5bc8-46e5-8a4b-71a4c0554ac3";
    sample(2001, 4001, 9.5 / 14, otherEpoch); // new lifetime first observed, charge restored
    expect((await claim(1)).state).toBe("waiting");
    sample(4002, 6002, 9.5 / 14, otherEpoch);
    expect(line.snapshot().runs[1]?.state).toBe("running");
    clock.now += RESOURCE_MAX_AGE_MS + 1;
    // A late reply from the retired sampler cannot refresh capacity.
    sample(6002, clock.now, 1);
    expect(line.snapshot().runs).toHaveLength(2);
    const third = rowAt(rows, 2);
    rows[2] = { ...third, group: third.pid };
    expect(
      await line
        .forTask("stale")
        .claim({ pid: third.pid, demand: { cpu: 1, memoryBytes: 1024 ** 3 } }),
    ).toMatchObject({ state: "waiting", reason: "unavailable" });
  });

  it("saves launch evidence before acknowledgment, keeps duplicates stable and refuses mismatched or reused identities", async () => {
    const { line, claim, receipt, rows } = setup();
    line.observe(reading, null);
    const first = await claim(0);
    const input = await receipt(first.id);
    const task = line.forTask("same-task");
    await expect(task.receipt(input)).resolves.toBeUndefined();
    await expect(line.forTask("other").receipt(input)).rejects.toThrow("living admitted group");
    await expect(task.receipt({ ...input, hold: "another hold" })).rejects.toThrow(
      "living admitted group",
    );
    await expect(task.receipt({ ...input, started: rowAt(rows, 0).started })).rejects.toThrow(
      "living admitted group",
    );
    await expect(task.receipt(input, () => false)).rejects.toThrow("no longer");
    rows.pop();
    await expect(task.receipt(input)).rejects.toThrow("living admitted group");
    rows.push({ ...rowAt(rows, 1), pid: input.payload, group: input.pid });
    await expect(task.receipt(input)).rejects.toThrow("living admitted group");
  });

  it("keeps memory and pressure decisions unchanged after CPU coverage, and counts covered living groups", async () => {
    const { line, claim, receipt, clock, sample, rows } = setup();
    line.observe(reading, rows);
    const first = await claim(0, 8, 4 * 1024 ** 3);
    await receipt(first.id);
    sample(1, 2001);
    const memory = { ...reading.memory, availableBytes: 4 * 1024 ** 3 };
    const read = {
      ...reading,
      sequence: 3,
      cpu: { ...reading.cpu, idleFraction: 9.5 / 14 },
      memory,
    };
    clock.now = 4002;
    // Unknown resident memory reserves the full declaration, even after CPU coverage.
    line.observe(read, null, clock.now, undefined, {
      epoch: reading.epoch,
      start: 2002,
      end: clock.now,
    });
    expect((await claim(1, 1)).state).toBe("waiting");
    rows[0] = { ...rowAt(rows, 0), residentBytes: 4 * 1024 ** 3 };
    line.observe({ ...read, memory: { ...memory, memoryPressure: "warning" } }, rows);
    expect(line.snapshot().runs[1]?.reason).toBe("pressure");
    line.observe(read, rows);
    expect(line.snapshot().runs[1]?.state).toBe("running");
    console.info("Unchanged memory after processor coverage", JSON.stringify(line.snapshot()));
  });

  it("refuses a receipt for an exited payload or a reused supervisor without reviving the hold", async () => {
    const { line, claim, receipt, rows } = setup();
    line.observe(reading, rows);
    const first = await claim(0);
    const input = await receipt(first.id);
    const task = line.forTask("same-task");
    const child = rowAt(rows, 2);
    rows[2] = { ...child, exited: true };
    await expect(task.receipt(input)).rejects.toThrow("living admitted group");
    rows[2] = child;
    rows[0] = { ...rowAt(rows, 0), started: child.started };
    await expect(task.receipt(input)).rejects.toThrow("living admitted group");
    line.observe(reading, rows);
    await expect(task.receipt(input)).rejects.toThrow("living admitted group");
    expect(line.snapshot().runs).toEqual([]);
  });

  // A Windows wrapper runs in Git Bash, which cannot read Windows' birth stamp,
  // so its receipt names the payload by number alone. Rows are shaped like a
  // Windows reading: a leader reads no parent, and its job is its group.
  describe("a Windows launch receipt", () => {
    const birth = (pid: number) => `win:1340774113061${pid}`;
    const win = (pid: number, parent: number, group = 0): ProcessReading => ({
      pid,
      parent,
      group,
      started: birth(pid),
      residentBytes: 3_000_000,
    });
    async function windowsRuns() {
      const rows = [win(15884, 11208), win(16340, 15884), win(16020, 0), win(16412, 0)];
      const clock = { now: 0 };
      const stateFile = join(scratchDir("windows-receipt-"), "holds.json");
      const jobs: LoadJobs = { lead: (_pid, started) => started, adopt: () => true };
      const table = { unread: false };
      const line = new LoadLine({
        stateFile,
        now: () => clock.now,
        processes: async () => (table.unread ? null : rows),
        groupExists: () => true,
        jobs,
      });
      lines.push(line);
      let sequence = 0;
      // 7.6 processors measured idle: room for the later run's six, never beside the first's eight.
      const sample = (start: number, end: number) => {
        clock.now = end;
        line.observe(
          {
            ...reading,
            sequence: ++sequence,
            sampleMs: end - start,
            cpu: { ...reading.cpu, idleFraction: 9.5 / 14 },
          },
          rows,
          end,
          undefined,
          { epoch: reading.epoch, start, end },
        );
      };
      sample(-2000, 0);
      const task = line.forTask("windows");
      const first = await held(
        task.claim({ pid: 16020, caller: 16340, demand: { cpu: 8, memoryBytes: 1024 ** 3 } }),
      );
      expect(first.state).toBe("running");
      const later = () =>
        held(task.claim({ pid: 16412, demand: { cpu: 6, memoryBytes: 1024 ** 3 } }));
      expect((await later()).state).toBe("waiting");
      const saved = () =>
        (
          JSON.parse(readFileSync(stateFile, "utf8")) as Array<{ id: string; launch?: unknown }>
        ).find((row) => row.id === first.id)?.launch;
      return { line, rows, table, clock, sample, task, first, later, saved };
    }

    it("stamps the payload's birth from its own reading, and a covering interval then frees the run's processors", async () => {
      const f = await windowsRuns();
      f.rows.push(win(16500, 16020, 16020));
      f.clock.now = 1;
      const receipt = { hold: f.first.id, pid: 16020, payload: 16500 };
      await expect(f.task.receipt(receipt)).resolves.toBeUndefined();
      expect(f.saved()).toEqual({ pid: 16500, started: birth(16500) });
      // A repeat after a lost answer is the same launch.
      await expect(f.task.receipt(receipt)).resolves.toBeUndefined();
      // An interval that began no later than the verification proves nothing about the start.
      f.sample(1, 2001);
      expect((await f.later()).state).toBe("waiting");
      f.sample(2002, 4002);
      expect((await f.later()).state).toBe("running");
      expect(f.line.snapshot().runs.map((run) => run.state)).toEqual(["running", "running"]);
    });

    it("refuses a number outside the run's job, its leader's own, or one that names nothing, and keeps the charge", async () => {
      const f = await windowsRuns();
      for (const payload of [15884, 16020, 16999])
        await expect(f.task.receipt({ hold: f.first.id, pid: 16020, payload })).rejects.toThrow(
          "living admitted group",
        );
      expect(f.saved()).toBeUndefined();
      f.sample(2002, 4002);
      expect((await f.later()).state).toBe("waiting");
    });

    it("asks again while the table cannot be read, saving nothing, then verifies the same receipt", async () => {
      const f = await windowsRuns();
      f.rows.push(win(16500, 16020, 16020));
      const receipt = { hold: f.first.id, pid: 16020, payload: 16500 };
      f.table.unread = true;
      await expect(f.task.receipt(receipt)).rejects.toBeInstanceOf(LoadReceiptUnreadError);
      expect(f.saved()).toBeUndefined();
      // What no reading could say about this run stays a refusal: another task's
      // hold, a hold that does not exist, another leader and a run still waiting.
      const waiting = f.line.snapshot().runs[1]?.id ?? "";
      for (const [task, input] of [
        [f.line.forTask("other"), receipt],
        [f.task, { ...receipt, hold: "another hold" }],
        [f.task, { ...receipt, pid: 16412 }],
        [f.task, { hold: waiting, pid: 16412, payload: 16500 }],
      ] as const) {
        const refused = await task.receipt(input).catch((error: unknown) => error);
        expect(refused).not.toBeInstanceOf(LoadReceiptUnreadError);
        expect((refused as Error).message).toContain("living admitted group");
      }
      f.table.unread = false;
      // The unverified launch freed nothing: a complete interval after it leaves the charge.
      f.sample(2002, 4002);
      expect((await f.later()).state).toBe("waiting");
      await expect(f.task.receipt(receipt)).resolves.toBeUndefined();
      expect(f.saved()).toEqual({ pid: 16500, started: birth(16500) });
      f.sample(4003, 6003);
      expect((await f.later()).state).toBe("running");
    });

    it("keeps the first verified launch against another member or a reused number", async () => {
      const f = await windowsRuns();
      f.rows.push(win(16500, 16020, 16020), win(16501, 16500, 16020));
      await f.task.receipt({ hold: f.first.id, pid: 16020, payload: 16500 });
      await expect(
        f.task.receipt({ hold: f.first.id, pid: 16020, payload: 16501 }),
      ).rejects.toThrow("different launch");
      f.rows[4] = { ...win(16500, 16020, 16020), started: birth(16777) };
      await expect(
        f.task.receipt({ hold: f.first.id, pid: 16020, payload: 16500 }),
      ).rejects.toThrow("different launch");
      expect(f.saved()).toEqual({ pid: 16500, started: birth(16500) });
    });

    it("refuses a receipt with no birth where a run's group is not a Windows job", async () => {
      const { line, claim, rows } = setup();
      line.observe(reading, null);
      const first = await claim(0);
      const leader = rowAt(rows, 0);
      rows.push({ ...rowAt(rows, 1), pid: 4242, group: leader.pid, parent: leader.pid });
      const elsewhere = vi.spyOn(platform, "hostPlatform").mockReturnValue("darwin");
      try {
        await expect(
          line.forTask("same-task").receipt({ hold: first.id, pid: leader.pid, payload: 4242 }),
        ).rejects.toThrow("no process identity");
      } finally {
        elsewhere.mockRestore();
      }
    });
  });

  it("restores living verified groups with new coverage, while legacy holds retain their declarations", async () => {
    const dir = scratchDir("startup-restart-");
    const stateFile = join(dir, "holds.json");
    let now = 0;
    const rows = identities.map((row) => ({ ...row }));
    const options = {
      stateFile,
      now: () => now,
      processes: async () => rows,
      groupExists: () => true,
    };
    let line = new LoadLine(options);
    lines.push(line);
    line.observe(reading, rows);
    const input = { pid: rowAt(rows, 0).pid, demand: { cpu: 8, memoryBytes: 1024 ** 3 } };
    const first = await held(line.forTask("restart").claim(input));
    const child = { ...rowAt(rows, 1), parent: input.pid, group: input.pid };
    rows[1] = child;
    await line
      .forTask("restart")
      .receipt({ hold: first.id, pid: input.pid, payload: child.pid, started: child.started });
    const saved = readFileSync(stateFile, "utf8");
    expect(JSON.parse(saved)[0].launch).toEqual({ pid: child.pid, started: child.started });
    line.dispose();
    now = 0; // deliberately a different monotonic origin
    line = new LoadLine(options);
    lines.push(line);
    const nextRow = rowAt(processesFromPs("1 0 1 2:01.03 23008 Tue Oct 27 11:03:29 2026") ?? [], 0);
    rows.push(nextRow);
    const next = { pid: nextRow.pid, demand: { cpu: 4, memoryBytes: 1024 ** 3 } };
    line.observe({ ...reading, cpu: { ...reading.cpu, idleFraction: 9.5 / 14 } }, rows);
    expect((await line.forTask("next").claim(next)).state).toBe("waiting");
    now = 2001;
    line.observe(
      { ...reading, sampleMs: 2000, sequence: 2, cpu: { ...reading.cpu, idleFraction: 9.5 / 14 } },
      rows,
      now,
      undefined,
      { epoch: reading.epoch, start: 1, end: now },
    );
    expect(line.snapshot().runs[1]?.state).toBe("running");
    line.dispose();
    // Older saved shape deliberately has no launch field: never infer it from running state.
    const legacy = JSON.parse(saved);
    delete legacy[0].launch;
    writeFileSync(stateFile, JSON.stringify(legacy));
    line = new LoadLine(options);
    lines.push(line);
    now = 4002;
    line.observe(
      { ...reading, sequence: 3, sampleMs: 2000, cpu: { ...reading.cpu, idleFraction: 9.5 / 14 } },
      rows,
      now,
      undefined,
      { epoch: reading.epoch, start: 2002, end: now },
    );
    expect((await line.forTask("next").claim(next)).state).toBe("waiting");
    console.info("Restart and legacy startup accounting", JSON.stringify(line.snapshot()));
  });

  it("rechecks revocation after an interrupted live-identity read before saving a receipt", async () => {
    const stateFile = join(scratchDir("receipt-revocation-"), "holds.json");
    const entered = deferred<void>();
    const released = deferred<void>();
    const rows = identities.map((row) => ({ ...row }));
    let blocked = false;
    let permitted = true;
    const line = new LoadLine({
      stateFile,
      groupExists: () => true,
      processes: async () => {
        if (blocked) {
          entered.resolve();
          await released.promise;
        }
        return rows;
      },
    });
    lines.push(line);
    line.observe(reading, rows);
    const leader = rowAt(rows, 0);
    const child = rowAt(rows, 1);
    const task = line.forTask("revoked");
    const first = await held(
      task.claim({ pid: leader.pid, demand: { cpu: 8, memoryBytes: 1024 ** 3 } }),
    );
    rows[1] = { ...child, group: leader.pid };
    blocked = true;
    const receipt = task.receipt(
      { hold: first.id, pid: leader.pid, payload: child.pid, started: child.started },
      () => permitted,
    );
    await entered.promise;
    permitted = false;
    released.resolve();
    await expect(receipt).rejects.toThrow("no longer");
    expect(JSON.parse(readFileSync(stateFile, "utf8"))[0].launch).toBeUndefined();
  });

  it("asks a birth-stamped receipt again while the table cannot be read, then verifies it", async () => {
    const stateFile = join(scratchDir("receipt-unread-"), "holds.json");
    const rows = identities.map((row) => ({ ...row }));
    let unread = false;
    const line = new LoadLine({
      stateFile,
      groupExists: () => true,
      processes: async () => (unread ? null : rows),
    });
    lines.push(line);
    line.observe(reading, rows);
    const leader = rowAt(rows, 0);
    const child = rowAt(rows, 1);
    const task = line.forTask("unread");
    const first = await held(
      task.claim({ pid: leader.pid, demand: { cpu: 8, memoryBytes: 1024 ** 3 } }),
    );
    rows[1] = { ...child, group: leader.pid };
    const receipt = { hold: first.id, pid: leader.pid, payload: child.pid, started: child.started };
    unread = true;
    await expect(task.receipt(receipt)).rejects.toBeInstanceOf(LoadReceiptUnreadError);
    expect(JSON.parse(readFileSync(stateFile, "utf8"))[0].launch).toBeUndefined();
    unread = false;
    await expect(task.receipt(receipt)).resolves.toBeUndefined();
    expect(JSON.parse(readFileSync(stateFile, "utf8"))[0].launch).toEqual({
      pid: child.pid,
      started: child.started,
    });
  });

  it("never acknowledges a receipt whose durable write failed", async () => {
    const dir = scratchDir("receipt-store-failure-");
    const parent = join(dir, "state");
    const stateFile = join(parent, "holds.json");
    const rows = identities.map((row) => ({ ...row }));
    const line = new LoadLine({ stateFile, processes: async () => rows, groupExists: () => true });
    lines.push(line);
    line.observe(reading, rows);
    const leader = rowAt(rows, 0);
    const first = await held(
      line.forTask("store").claim({ pid: leader.pid, demand: { cpu: 8, memoryBytes: 1024 ** 3 } }),
    );
    const child = rowAt(rows, 1);
    rows[1] = { ...child, group: leader.pid };
    renameSync(parent, join(dir, "saved"));
    // Replace the parent folder with a file, using disposable data only.
    writeFileSync(parent, "not a folder");
    await expect(
      line
        .forTask("store")
        .receipt({ hold: first.id, pid: leader.pid, payload: child.pid, started: child.started }),
    ).rejects.toThrow();
    expect(
      JSON.parse(readFileSync(join(dir, "saved", "holds.json"), "utf8"))[0].launch,
    ).toBeUndefined();
  });
});

// INF-2570 direction 1, approved by the captain: "Free what nothing uses ... make
// reservations end with their programs and add the line's journal". The rows are
// Mac ps metadata in the recorded format above; pid 19260 is the 7.8 MB helper that
// kept INF-2413's 8-processor, 7.8 GiB reservation booked for six hours.
describe("reservations that nothing uses", () => {
  const wall = Date.parse("2026-11-03T22:41:00-08:00");
  const table = (text: string) => processesFromPs(text) ?? [];
  function line(
    rows: () => ProcessReading[],
    jobs?: LoadJobs,
    now = () => 0,
    folder = scratchDir("unused-line-"),
  ) {
    const created = new LoadLine({
      stateFile: join(folder, "holds.json"),
      now,
      wallClock: () => wall,
      processes: async () => rows(),
      groupExists: () => true,
      ...(jobs ? { jobs } : {}),
    });
    lines.push(created);
    const journal = (): LoadJournalEntry[] =>
      readFileSync(join(folder, JOURNAL_FILE), "utf8")
        .trim()
        .split("\n")
        .map((text) => JSON.parse(text));
    return { line: created, journal, folder };
  }
  const gib = 1024 ** 3;
  const busy = { ...reading, cpu: { ...reading.cpu, idleFraction: 9.5 / 14 } };

  it("drops an exited program's reservation to what its leftover processes use", async () => {
    let rows = table(`  4301  4210  4210 0:00.02  2800 Tue Nov  3 16:25:01 2026
  4302  4301  4302 0:00.04  3120 Tue Nov  3 16:25:01 2026
  4402  4210  4210 0:00.02  2800 Tue Nov  3 21:25:10 2026
  4403  4402  4403 0:00.03  3100 Tue Nov  3 21:25:10 2026
`);
    const f = line(() => rows);
    f.line.observe(busy, rows);
    const first = await f.line
      .forTask("INF-2413")
      .claim({ pid: 4302, demand: { cpu: 8, memoryBytes: 8 * gib } });
    expect(first.state).toBe("running");
    const second = { pid: 4403, demand: { cpu: 6, memoryBytes: 10 * gib } };
    expect((await f.line.forTask("INF-2225").claim(second)).state).toBe("waiting");

    // The program and its supervisor exit; only the test's helper is left in the group.
    rows = [
      ...rows.filter((row) => row.pid !== 4302),
      ...table("19260     1  4302 0:00.04  7980 Tue Nov  3 16:31:44 2026"),
    ];
    f.line.observe(busy, rows);
    const runs = f.line.snapshot().runs;
    expect(runs.find((run) => run.id === first.id)?.state).toBe("running");
    expect(runs.find((run) => run.taskId === "INF-2225")?.state).toBe("running");
    const journal = f.journal();
    expect(journal.find((entry) => entry.event === "exited")).toMatchObject({
      hold: first.id,
      taskId: "INF-2413",
      residentBytes: 7980 * 1024,
    });
    expect(journal.filter((entry) => entry.event === "release")).toEqual([]);

    // The helper ends too: the hold is released, once.
    rows = rows.filter((row) => row.pid !== 19260);
    f.line.observe(busy, rows);
    expect(f.line.snapshot().runs.map((run) => run.taskId)).toEqual(["INF-2225"]);
    expect(f.journal().filter((entry) => entry.event === "release")).toMatchObject([
      { hold: first.id, why: "its process group ended" },
    ]);
  });

  it("removes a waiter whose caller ended and refuses its next claim", async () => {
    let rows = table(`  4301  4210  4210 0:00.02  2800 Tue Nov  3 21:20:01 2026
  4302  4301  4302 0:00.04  3120 Tue Nov  3 21:20:01 2026
  4402  4210  4210 0:00.02  2800 Tue Nov  3 21:25:10 2026
  4403  4402  4403 0:00.03  3100 Tue Nov  3 21:25:10 2026
  4502  4210  4210 0:00.02  2800 Tue Nov  3 21:31:40 2026
  4503  4502  4503 0:00.03  3100 Tue Nov  3 21:31:40 2026
`);
    const f = line(() => rows);
    f.line.observe(busy, rows);
    const front = await f.line
      .forTask("running")
      .claim({ pid: 4302, demand: { cpu: 8, memoryBytes: 8 * gib } });
    const orphan = { pid: 4403, demand: { cpu: 6, memoryBytes: 10 * gib } };
    const behind = { pid: 4503, demand: { cpu: 2, memoryBytes: 10 * gib } };
    expect((await f.line.forTask("INF-2225").claim(orphan)).state).toBe("waiting");
    expect((await f.line.forTask("behind").claim(behind)).ahead).toBe(1);

    // The crewmate's shell ends: both outer wrappers are gone and the system adopts the leaders.
    const adopted = (pid: number) => (row: ProcessReading) =>
      row.pid === pid ? { ...row, parent: 1 } : row;
    rows = rows
      .filter((row) => row.pid !== 4301 && row.pid !== 4402)
      .map(adopted(4302))
      .map(adopted(4403));
    f.line.observe(busy, rows);
    // A running group keeps its hold whatever became of its caller; the waiter leaves.
    expect(f.line.snapshot().runs).toMatchObject([
      { id: front.id, state: "running" },
      { taskId: "behind", state: "waiting", ahead: 0 },
    ]);
    await expect(f.line.forTask("INF-2225").claim(orphan)).rejects.toThrow("caller has ended");
    expect(f.line.snapshot().runs.map((run) => run.taskId)).toEqual(["running", "behind"]);
    const journal = f.journal();
    expect(journal.filter((entry) => entry.taskId === "INF-2225")).toMatchObject([
      { event: "wait", ahead: 0 },
      { event: "blocked", running: 1 },
      { event: "release", why: "it left the line: its caller ended" },
      { event: "refuse", why: expect.stringContaining("caller has ended") },
    ]);
  });

  it("on Windows, removes a waiter whose wrapper's named caller ended", async () => {
    // INF-4253: Git Bash starts a heavy run's leader with no parent Windows can
    // name, so the wrapper names the shell that ran it. Rows are shaped like
    // the Windows live proof's: crewmate shell 15884 ran two wrappers, 16340
    // and 16388, whose leaders 16020 and 16412 read no parent.
    const birth = (n: number) => `win:1340774113061${n}`;
    const win = (pid: number, parent: number): ProcessReading => ({
      pid,
      parent,
      group: 0,
      started: birth(pid),
      residentBytes: 3_000_000,
    });
    let rows = [
      win(15884, 11208),
      win(16340, 15884),
      win(16020, 0),
      win(16388, 15884),
      win(16412, 0),
    ];
    const led: number[] = [];
    const jobs: LoadJobs = {
      lead: (pid, started) => {
        led.push(pid);
        return started;
      },
      adopt: () => true,
    };
    const f = line(() => rows, jobs);
    f.line.observe(busy, rows);
    const front = await f.line
      .forTask("running")
      .claim({ pid: 16020, caller: 16340, demand: { cpu: 8, memoryBytes: 8 * gib } });
    expect(front.state).toBe("running");
    const waiter = { pid: 16412, caller: 16388, demand: { cpu: 6, memoryBytes: 10 * gib } };
    expect((await f.line.forTask("INF-4253").claim(waiter)).state).toBe("waiting");
    expect(led).toEqual([16020, 16412]);

    // While the named caller runs, a leader with no parent keeps its place.
    f.line.observe(busy, rows);
    expect(f.line.snapshot().runs.map((run) => run.taskId)).toEqual(["running", "INF-4253"]);

    // The command is stopped: its wrapper 16388 ends, and the waiter leaves.
    rows = rows.filter((row) => row.pid !== 16388);
    f.line.observe(busy, rows);
    expect(f.line.snapshot().runs.map((run) => run.taskId)).toEqual(["running"]);
    expect(f.journal().filter((entry) => entry.taskId === "INF-4253")).toMatchObject([
      { event: "wait" },
      { event: "blocked" },
      { event: "release", why: "it left the line: its caller ended" },
    ]);
  });

  it("journals each admission and block with the capacity it compared against", async () => {
    const rows = table(`  4301  4210  4210 0:00.02  2800 Tue Nov  3 21:20:01 2026
  4302  4301  4302 0:00.04  3120 Tue Nov  3 21:20:01 2026
  4402  4210  4210 0:00.02  2800 Tue Nov  3 21:25:10 2026
  4403  4402  4403 0:00.03  3100 Tue Nov  3 21:25:10 2026
`);
    const f = line(() => rows);
    f.line.observe(busy, rows);
    const front = await f.line
      .forTask("front")
      .claim({ pid: 4302, demand: { cpu: 8, memoryBytes: 8 * gib } });
    const next = { pid: 4403, demand: { cpu: 6, memoryBytes: 10 * gib } };
    await f.line.forTask("next").claim(next);
    // Repeated passes with nothing new add no lines.
    f.line.observe(busy, rows);
    await f.line.forTask("next").claim(next);
    f.line.observe({ ...busy, memory: { ...busy.memory, memoryPressure: "warning" } }, rows);
    const journal = f.journal();
    expect(journal.every((entry) => entry.at === new Date(wall).toISOString())).toBe(true);
    expect(journal.map((entry) => [entry.event, entry.taskId])).toEqual([
      ["wait", "front"],
      ["admit", "front"],
      ["wait", "next"],
      ["blocked", "next"],
      ["blocked", "next"],
    ]);
    const [, admitted, , blocked, pressured] = journal;
    expect(admitted).toMatchObject({ hold: front.id, basis: "installed", running: 0 });
    expect(admitted?.capacity?.memoryBytes).toBeGreaterThanOrEqual(8 * gib);
    expect(blocked).toMatchObject({ demand: next.demand, running: 1, pressure: "normal" });
    expect(blocked?.capacity?.memoryBytes).toBeLessThan(next.demand.memoryBytes);
    expect(pressured).toMatchObject({ capacity: null, pressure: "warning" });
  });

  it("keeps the journal's newest lines within its size", async () => {
    const rows = table(`  4301  4210  4210 0:00.02  2800 Tue Nov  3 21:20:01 2026
  4302  4301  4302 0:00.04  3120 Tue Nov  3 21:20:01 2026
`);
    const f = line(() => rows);
    const old = `${JSON.stringify({ at: "2026-11-01T00:00:00.000Z", event: "wait", taskId: "old" })}\n`;
    writeFileSync(
      join(f.folder, JOURNAL_FILE),
      old.repeat(Math.ceil(JOURNAL_MAX_BYTES / old.length)),
    );
    await f.line.forTask("new").claim({ pid: 4302, demand: { cpu: 2, memoryBytes: gib } });
    const text = readFileSync(join(f.folder, JOURNAL_FILE), "utf8");
    expect(text.length).toBeLessThan(JOURNAL_MAX_BYTES);
    // With no reading yet, the new run is journaled waiting and blocked on an unread capacity.
    expect(f.journal().filter((entry) => entry.taskId === "new")).toMatchObject([
      { event: "wait" },
      { event: "blocked", capacity: null },
    ]);
    expect(f.journal()[0]).toMatchObject({ taskId: "old" });
  });

  // INF-6381, the captain's answers: a run too big for its computer is refused, a run
  // that fits may pass the first in line during its first 10 minutes of waiting, the
  // pressure stop stays, and "ahead" counts only runs waiting before it.
  describe("the line's order", () => {
    const minute = 60_000;
    // Recorded Mac rows: a crewmate's wrapper (parent 4210) leading each run's group.
    const leader = (pid: number) =>
      table(`  ${pid - 1}  4210  4210 0:00.02  2800 Tue Nov  3 21:25:10 2026
  ${pid}  ${pid - 1}  ${pid} 0:00.03  3100 Tue Nov  3 21:25:10 2026
`);
    const without = (rows: ProcessReading[], pid: number) =>
      rows.filter((row) => row.group !== pid && row.pid !== pid - 1);

    it("releases a saved waiting run too big for its computer and refuses its next claim", async () => {
      const rows = leader(4403);
      const folder = scratchDir("too-big-line-");
      const group = rowAt(rows, 1);
      const demand = { cpu: 1, memoryBytes: 22 * gib };
      // Saved by a version that let it wait: 22 GiB is above 24 GiB less the 2.4 GiB margin.
      writeFileSync(
        join(folder, "holds.json"),
        JSON.stringify([
          {
            id: "3f6c1d2e-8a4b-4c5d-9e7f-1a2b3c4d5e6f",
            taskId: "INF-6381",
            demand,
            pid: group.pid,
            started: group.started,
            state: "waiting",
          },
        ]),
      );
      const f = line(
        () => rows,
        undefined,
        () => 0,
        folder,
      );
      expect(f.line.snapshot().runs).toHaveLength(1);
      f.line.observe(busy, rows);
      expect(f.line.snapshot().runs).toEqual([]);
      await expect(f.line.forTask("INF-6381").claim({ pid: group.pid, demand })).rejects.toThrow(
        "Declare at most 22118 MiB",
      );
      expect(f.journal()).toMatchObject([
        {
          event: "release",
          why: "it left the line: it declares more memory than this computer can ever give one run",
        },
        { event: "refuse", demand, why: expect.stringContaining("more than this computer") },
      ]);
    });

    it("lets a run that fits pass the first in line only during its first 10 minutes", async () => {
      let rows = [...leader(4302), ...leader(4403), ...leader(4503), ...leader(4603)];
      const clock = { now: 0 };
      const f = line(
        () => rows,
        undefined,
        () => clock.now,
      );
      f.line.observe(busy, rows);
      // 7.6 processors to give: A takes 4, so B's 6 does not fit and C's 2 does.
      const a = { pid: 4302, demand: { cpu: 4, memoryBytes: 2 * gib } };
      const b = { pid: 4403, demand: { cpu: 6, memoryBytes: 4 * gib } };
      const c = { pid: 4503, demand: { cpu: 2, memoryBytes: gib } };
      const d = { pid: 4603, demand: { cpu: 1, memoryBytes: gib } };
      expect((await f.line.forTask("A").claim(a)).state).toBe("running");
      const front = await f.line.forTask("B").claim(b);
      expect(front).toMatchObject({ state: "waiting", reason: "capacity", ahead: 0 });

      // A memory warning still starts nothing, not even a run that fits.
      f.line.observe({ ...busy, memory: { ...busy.memory, memoryPressure: "warning" } }, rows);
      expect(await f.line.forTask("C").claim(c)).toMatchObject({
        state: "waiting",
        reason: "pressure",
      });
      clock.now = 9 * minute;
      f.line.observe(busy, rows);
      expect(f.line.snapshot().runs.map((run) => [run.taskId, run.state])).toEqual([
        ["A", "running"],
        ["B", "waiting"],
        ["C", "running"],
      ]);
      expect(
        f.journal().find((entry) => entry.event === "admit" && entry.taskId === "C"),
      ).toMatchObject({
        basis: "capacity",
        passed: front.id,
      });

      // After the window, D fits the 1.6 processors left but waits behind B.
      clock.now = 10 * minute;
      f.line.observe(busy, rows);
      expect(await f.line.forTask("D").claim(d)).toMatchObject({
        state: "waiting",
        reason: "line",
        ahead: 1,
      });
      // A and C finish: B starts alone, then D fits beside it.
      rows = without(without(rows, 4302), 4503);
      f.line.observe(busy, rows);
      expect(f.line.snapshot().runs.map((run) => [run.taskId, run.state])).toEqual([
        ["B", "running"],
        ["D", "running"],
      ]);
    });

    it("starts the first in line under a stream of small runs once its window and the passed runs end", async () => {
      // The plan's model: A (4 processors) runs 5 minutes, B (6) waits, and a
      // 1-processor run that lasts 3 minutes arrives every minute.
      const smallRuns = 30;
      let rows = [...leader(4302), ...leader(4403)];
      for (let k = 0; k < smallRuns; k++) rows.push(...leader(5002 + 10 * k));
      const clock = { now: 0 };
      const f = line(
        () => rows,
        undefined,
        () => clock.now,
      );
      f.line.observe(busy, rows);
      await f.line.forTask("A").claim({ pid: 4302, demand: { cpu: 4, memoryBytes: 2 * gib } });
      await f.line.forTask("B").claim({ pid: 4403, demand: { cpu: 6, memoryBytes: 4 * gib } });
      // When each small run started, by its group.
      const running = new Map<number, number>();
      let started: number | undefined;
      let passed = 0;
      for (let at = 0; at < smallRuns && started === undefined; at++) {
        clock.now = at * minute;
        if (at === 5) rows = without(rows, 4302);
        for (const [pid, since] of running)
          if (at - since >= 3) {
            rows = without(rows, pid);
            running.delete(pid);
          }
        f.line.observe(busy, rows);
        const pid = 5002 + 10 * at;
        await f.line
          .forTask(`small-${pid}`)
          .claim({ pid, demand: { cpu: 1, memoryBytes: gib / 4 } });
        const runs = f.line.snapshot().runs;
        if (runs.some((run) => run.taskId === "B" && run.state === "running")) started = at;
        for (const run of runs) {
          if (run.state !== "running" || started !== undefined) continue;
          const small = Number(run.taskId.slice("small-".length));
          if (
            run.taskId.startsWith("small-") &&
            !running.has(small) &&
            rows.some((row) => row.pid === small)
          ) {
            running.set(small, at);
            passed++;
          }
        }
      }
      expect(passed).toBeGreaterThan(0);
      expect(started).toBeDefined();
      expect(started).toBeLessThanOrEqual(10 + 3);
    });

    it("counts only runs waiting before it, and the first in line carries the room it waits for", async () => {
      let rows = [...leader(4302), ...leader(4403), ...leader(4503), ...leader(4603)];
      const f = line(() => rows);
      f.line.observe(busy, rows);
      await f.line.forTask("A").claim({ pid: 4302, demand: { cpu: 3, memoryBytes: gib } });
      // The lone-run rule started A; with 7.6 to give, B's 3 fits beside it.
      await f.line.forTask("B").claim({ pid: 4403, demand: { cpu: 3, memoryBytes: gib } });
      // B's program exits, leaving a recorded helper in its group.
      rows = [
        ...rows.filter((row) => row.pid !== 4403),
        ...table("19260     1  4403 0:00.04  7980 Tue Nov  3 16:31:44 2026"),
      ];
      f.line.observe(busy, rows);
      const c = await held(
        f.line.forTask("C").claim({ pid: 4503, demand: { cpu: 6, memoryBytes: gib } }),
      );
      const d = await held(
        f.line.forTask("D").claim({ pid: 4603, demand: { cpu: 5, memoryBytes: gib } }),
      );
      expect(c).toMatchObject({ state: "waiting", ahead: 0, reason: "capacity" });
      expect(d).toMatchObject({ state: "waiting", ahead: 1, reason: "line" });
      expect(d.free).toBeUndefined();
      const free = c.free;
      if (!free) throw new Error("The first in line carries no room");
      // A's uncovered start is charged; B's exited program reserves nothing more.
      expect(free.cpu).toBe(4.6);
      expect(loadRunWords(c, "Mac mini")).toContain(
        m.uiTaskResourceRunFree({
          processors: 4.6,
          memory: formatNumber(free.memoryBytes / gib, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          }),
        }),
      );
    });
  });
});
