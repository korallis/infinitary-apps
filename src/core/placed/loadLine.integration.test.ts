import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, readFileSync, realpathSync, renameSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { loadSnapshotSchema } from "@shared/load";
import { RESOURCE_MAX_AGE_MS, type ResourceObservation } from "@shared/resources";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { bundleAxiProcess } from "../../../tests/helpers/axiProcessBundle";
import { deferred } from "../../../tests/helpers/deferred";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { AxiChannel, type TaskShell } from "../axi/channel";
import { hostEnv } from "../hostEnv";
import { forkChildProcess } from "../sql/forkChildProcess";
import { ComputerLoads } from "./computerLoads";
import { LoadLine, type LoadReceipt } from "./loadLine";
import { ProcessAttribution, readProcesses } from "./processResources";
import { processRoots } from "./processRoots";
import { ResourceSampler } from "./resourceSampler";

// Native group cleanup and command polling use the existing two-second cadence.
// The budget covers consecutive poll/cleanup boundaries, channel startup and native handoffs.
vi.setConfig({ testTimeout: 35_000 });

// The ordinary-use Mac reading recorded by SCR-380, also used by placementEngine.test.ts.
// The test does not assert these numbers: it drives admission with a real recorded reading.
const reading: ResourceObservation = {
  epoch: "4f0c2a8e-6b1d-4c3e-9a57-2d8f1e0b7c64",
  sequence: 1,
  status: "sampled",
  sampleMs: 250,
  cpu: { logicalCpus: 10, idleFraction: 0.77 },
  memory: {
    totalBytes: 25_165_824 * 1024,
    freeBytes: 356_672 * 1024,
    purgeableBytes: 335_184 * 1024,
    fileBackedBytes: 6_852_624 * 1024,
  },
};
// In the app the sampler gives the line a new reading every RESOURCE_REFRESH_MS, so the reading
// it judges by is never older than RESOURCE_MAX_AGE_MS. These cases replay one reading with no
// sampler, so the line's clock stands still: the reading stays as fresh as when it was given,
// however long a loaded runner takes between steps. The stale-reading case owns its age.
const stillClock = () => 0;
const bin = resolve(__dirname, "../../../resources/axi-bin");
let entry: string;
const channels: AxiChannel[] = [];
const lines: LoadLine[] = [];
beforeAll(async () => {
  entry = await bundleAxiProcess();
}, 60_000);
afterEach(() => {
  vi.useRealTimers();
  for (const channel of channels.splice(0)) channel.close();
  for (const line of lines.splice(0)) line.dispose();
});

function run(
  shell: TaskShell,
  dir: string,
  argv: string[],
  demand = { processors: "4", memoryMiB: "4096" },
  launcher = join(bin, "infinitary-load-axi"),
): {
  child: ChildProcessWithoutNullStreams;
  output: () => string;
  errors: () => string;
  ended: Promise<number | null>;
} {
  const child = spawn(
    launcher,
    ["run", "--processors", demand.processors, "--memory-mib", demand.memoryMiB, "--", ...argv],
    {
      cwd: dir,
      // Starting the app inside an unrelated wrapped program must not make a new task nested.
      env: hostEnv({
        INFINITARY_LOAD_HOLD: "ca5b9ada-aff3-452b-a4ce-a7cd92324237",
        ...shell.env,
        LOAD_FIXTURE_VALUE: "original environment",
      }),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk.toString();
  });
  return {
    child,
    output: () => output,
    errors: () => errors,
    ended: once(child, "exit").then(([code]) => code as number | null),
  };
}

/**
 * INF-1621 piece 2: only admission waits; running work keeps its streams and exits itself.
 * Fixture: real native wrappers, task channel and command processes; the recorded ordinary-use
 * Mac reading above, with explicitly supplied pressure states (no real memory pressure).
 * Failure: an early grant, group leak, lost stdin/environment/argv, changed exit code or a
 * pressure action stopping the admitted program fails at this process/command boundary.
 */
describe("the declared heavy-run line through its native command", () => {
  it("starts a lone group on a busy CPU, queues another, and keeps running through pressure", async () => {
    const dir = scratchDir("infinitary-load-command-");
    const line = new LoadLine({ stateFile: join(dir, "load.json"), now: stillClock });
    lines.push(line);
    // INF-1685 direction A: replay the recorded fully busy CPU state from placementCpu.ts.
    line.observe({ ...reading, cpu: { ...reading.cpu, idleFraction: 0 } }, null);
    const channel = await AxiChannel.open({
      spawner: forkChildProcess(entry),
      binDir: bin,
      version: "9.9.9-test",
      keysDir: join(dir, "keys"),
    });
    channels.push(channel);
    const program = `console.log(JSON.stringify({ready:true,cwd:process.cwd(),value:process.env.LOAD_FIXTURE_VALUE,args:process.argv.slice(1)}));process.stdin.setEncoding('utf8');process.stdin.on('data',data=>{if(data.trim()==='finish'){process.exitCode=7;process.stdin.pause()}else console.log(data.trim())});process.stdin.on('end',()=>{process.exitCode=7})`;
    const first = run(channel.grant("first", { load: line.forTask("first") }), dir, [
      process.execPath,
      "-e",
      program,
      "literal --help",
      "two words",
    ]);
    let second: ReturnType<typeof run> | undefined;
    try {
      await expect.poll(first.output).toContain('"ready":true');
      expect(JSON.parse(first.output().trim())).toEqual({
        ready: true,
        cwd: realpathSync(dir),
        value: "original environment",
        args: ["literal --help", "two words"],
      });
      second = run(channel.grant("second", { load: line.forTask("second") }), dir, [
        process.execPath,
        "-e",
        program,
      ]);
      await expect
        .poll(() => line.snapshot().runs.map((row) => [row.taskId, row.state, row.ahead]))
        .toEqual([
          ["first", "running", 0],
          ["second", "waiting", 0],
        ]);
      expect(second.output()).toBe("");
      // INF-6381: the first in line tells its crewmate the room it waits for.
      await expect.poll(second.errors).toMatch(/free:\n {2}processors: [\d.]+\n {2}memoryMiB: \d+/);
      // A busy computer has none free; the home still reads the run (loadSnapshotSchema).
      expect(loadSnapshotSchema.parse(line.snapshot())).toEqual(line.snapshot());
      line.observe({ ...reading, memory: { ...reading.memory, memoryPressure: "warning" } }, null);
      first.child.stdin.write("still running\n");
      await expect.poll(first.output).toContain("still running");
      first.child.stdin.end("finish\n");
      expect(await first.ended).toBe(7);
      await expect
        .poll(() => line.snapshot().runs.map((row) => [row.taskId, row.state, row.reason]))
        .toEqual([["second", "waiting", "pressure"]]);
      expect(second.output()).toBe("");
      line.observe({ ...reading, memory: { ...reading.memory, memoryPressure: "normal" } }, null);
      await expect.poll(second.output).toContain('"ready":true');
      second.child.stdin.end("finish\n");
      expect(await second.ended).toBe(7);
      await expect.poll(() => line.snapshot().runs).toEqual([]);
      console.info(
        "Load command proof",
        JSON.stringify({
          first: first.output(),
          second: second.output(),
          waiting: second.errors(),
          remaining: line.snapshot(),
        }),
      );
    } finally {
      // Close the disposable fixtures' input, not their process groups.
      first.child.stdin.end("finish\n");
      second?.child.stdin.end("finish\n");
      channel.close();
      await first.ended;
      if (second) await second.ended;
    }
  });

  // INF-1978: a transient unreadable process table must not end a queued check.
  // Keep the real wrapper and its live identity; fault only the OS reader's null result.
  it("keeps a queued command waiting through an unreadable identity check, then starts it once", async () => {
    const dir = scratchDir("infinitary-load-unreadable-");
    let unavailable = false;
    const line = new LoadLine({
      stateFile: join(dir, "load.json"),
      now: stillClock,
      processes: async () => (unavailable ? null : readProcesses()),
    });
    lines.push(line);
    line.observe({ ...reading, memory: { ...reading.memory, memoryPressure: "warning" } }, null);
    const channel = await AxiChannel.open({
      spawner: forkChildProcess(entry),
      binDir: bin,
      version: "9.9.9-test",
      keysDir: join(dir, "keys"),
    });
    channels.push(channel);
    const waiting = run(channel.grant("unreadable", { load: line.forTask("unreadable") }), dir, [
      process.execPath,
      "-e",
      "console.log('requested check started')",
    ]);
    try {
      await expect.poll(waiting.errors).toContain("reason: pressure");
      const hold = line.snapshot().runs[0]?.id;
      unavailable = true;
      // Admission may advance independently while this caller cannot be verified.
      // It must not execute on that saved grant alone, or lose its place and exit.
      line.observe(reading, null);
      await expect.poll(waiting.errors).toContain("reason: unavailable");
      expect(waiting.child.exitCode).toBeNull();
      expect(waiting.output()).toBe("");
      expect(line.snapshot().runs[0]?.id).toBe(hold);
      unavailable = false;
      expect(await waiting.ended).toBe(0);
      expect(waiting.output()).toBe("requested check started\n");
      await expect.poll(() => line.snapshot().runs).toEqual([]);
      console.info(
        "Unreadable identity recovery proof",
        JSON.stringify({
          waiting: waiting.errors(),
          output: waiting.output(),
          remaining: line.snapshot(),
        }),
      );
    } finally {
      channel.close();
      await waiting.ended;
    }
  });

  // INF-2004: one timed-out claim must not end the waiting group or lose its place.
  // Use the real wrapper/channel/process table; delay only one OS-reading completion,
  // and advance the channel's own deadline rather than waiting a minute under load.
  it.each(["deadline", "start", "exit"] as const)(
    "keeps the same queued group after a claim %s interruption and starts only on a fresh answer",
    async (failure) => {
      const dir = scratchDir("infinitary-load-claim-timeout-");
      const delayed = deferred<void>();
      const entered = deferred<void>();
      const again = deferred<void>();
      let slow = false;
      let interruptProcess = false;
      let interrupted = false;
      const line = new LoadLine({
        stateFile: join(dir, "load.json"),
        now: stillClock,
        processes: async () => {
          if (slow) {
            slow = false;
            interrupted = true;
            entered.resolve();
            await delayed.promise;
          } else if (interrupted) again.resolve();
          return readProcesses();
        },
      });
      lines.push(line);
      line.observe({ ...reading, memory: { ...reading.memory, memoryPressure: "warning" } }, null);
      const native = forkChildProcess(entry);
      const channel = await AxiChannel.open({
        spawner: {
          spawn: () => {
            if (!interruptProcess) return native.spawn();
            interruptProcess = false;
            interrupted = true;
            entered.resolve();
            if (failure === "start") throw new Error("Command process unavailable");
            const child = native.spawn();
            // Exit with channel listeners installed, before it can answer.
            return { ...child, postMessage: () => child.kill() };
          },
        },
        binDir: bin,
        version: "9.9.9-test",
        keysDir: join(dir, "keys"),
      });
      channels.push(channel);
      const identities: number[] = [];
      const load = line.forTask("timeout");
      const claims: Promise<unknown>[] = [];
      const waiting = run(
        channel.grant("timeout", {
          load: {
            read: load.read,
            receipt: load.receipt,
            claim: (input) => {
              identities.push(input.pid);
              const work = load.claim(input);
              claims.push(work);
              return work;
            },
          },
        }),
        dir,
        [process.execPath, "-e", "console.log('requested check started')"],
      );
      try {
        await expect.poll(waiting.errors).toContain("reason: pressure");
        const before = line.snapshot();
        if (failure === "deadline") {
          slow = true;
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          await entered.promise;
          // The sole pending timeout is the command process's bound. Native polling
          // and the group's lifetime keep their real clocks and identity.
          vi.advanceTimersToNextTimer();
          vi.useRealTimers();
        } else {
          interruptProcess = true;
          await entered.promise;
        }
        const outcome = await Promise.race([
          again.promise.then(() => "claimed again"),
          waiting.ended.then((code) => `wrapper exited ${code}`),
        ]);
        console.info(
          "Interrupted claim before recovery",
          JSON.stringify({
            outcome,
            identities,
            waiting: waiting.errors(),
            output: waiting.output(),
            before,
            after: line.snapshot(),
          }),
        );
        expect(outcome).toBe("claimed again");
        expect(waiting.output()).toBe("");
        expect(line.snapshot()).toEqual(before);
        expect(new Set(identities).size).toBe(1);
        // Let the old request finish after its response was lost. It must not
        // grant execution; the wrapper still needs its own fresh running reply.
        delayed.resolve();
        await Promise.all(claims);
        expect(waiting.output()).toBe("");
        line.observe(reading, null);
        expect(await waiting.ended).toBe(0);
        expect(waiting.output()).toBe("requested check started\n");
        await expect.poll(() => line.snapshot().runs).toEqual([]);
        console.info(
          "Interrupted claim recovery proof",
          JSON.stringify({
            identities,
            hold: before.runs[0]?.id,
            waiting: waiting.errors(),
            output: waiting.output(),
            remaining: line.snapshot(),
          }),
        );
      } finally {
        vi.useRealTimers();
        delayed.resolve();
        await Promise.allSettled(claims);
        channel.close();
        await waiting.ended;
      }
    },
  );

  it("holds a surviving group after its leader exits and restores that hold after app restart", async () => {
    const dir = scratchDir("infinitary-load-descendant-");
    const stateFile = join(dir, "load.json");
    let port: number | undefined;
    let line = new LoadLine({ stateFile, now: stillClock });
    lines.push(line);
    line.observe(reading, null);
    const channel = await AxiChannel.open({
      spawner: forkChildProcess(entry),
      binDir: bin,
      version: "9.9.9-test",
      keysDir: join(dir, "keys"),
    });
    channels.push(channel);
    const descendant = `const server=require('node:net').createServer(c=>{c.on('data',()=>{c.end();server.close()})});server.listen(0,'127.0.0.1',()=>process.send({pid:process.pid,port:server.address().port}));`;
    const parent = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit','ipc']});c.once('message',m=>{console.log(JSON.stringify(m));c.disconnect();c.unref()});`;
    const first = run(channel.grant("surviving", { load: line.forTask("surviving") }), dir, [
      process.execPath,
      "-e",
      parent,
    ]);
    let second: ReturnType<typeof run> | undefined;
    let stopped = false;
    const stopDescendant = async () => {
      if (stopped || port === undefined) return;
      const client = createConnection({ port, host: "127.0.0.1" });
      await once(client, "connect");
      client.end("stop");
      await once(client, "close");
      stopped = true;
    };
    try {
      expect(await first.ended).toBe(0);
      const ready = JSON.parse(first.output().trim()) as { pid: number; port: number };
      const { pid } = ready;
      port = ready.port;
      expect(line.snapshot().runs.map((run) => run.state)).toEqual(["running"]);
      line.dispose();
      line = new LoadLine({ stateFile, now: stillClock });
      lines.push(line);
      const processes = await readProcesses();
      expect(processes?.some((row) => row.pid === pid)).toBe(true);
      line.observe(reading, processes);
      expect(
        new ProcessAttribution()
          .owners(processes ?? [], processRoots.read(), processRoots.readGroups())
          .get(pid),
      ).toBe("surviving");
      second = run(channel.grant("following", { load: line.forTask("following") }), dir, [
        process.execPath,
        "-e",
        "console.log('following admitted')",
      ]);
      // INF-2570 direction 1: its program has exited, so the surviving group keeps its
      // hold and attribution but reserves only what it measurably uses; the next run starts.
      expect(await second.ended).toBe(0);
      expect(second.output()).toContain("following admitted");
      // The line sees the following group end at its next lifetime pass.
      await expect
        .poll(() => line.snapshot().runs.map((run) => [run.taskId, run.state]))
        .toEqual([["surviving", "running"]]);
      await stopDescendant();
      await expect.poll(() => line.snapshot().runs).toEqual([]);
      console.info(
        "Group lifetime proof",
        JSON.stringify({
          leaderExit: 0,
          retainedAfterRestart: true,
          descendantAttributed: true,
          following: second.output(),
          remaining: line.snapshot(),
        }),
      );
    } finally {
      channel.close();
      await stopDescendant();
      await first.ended;
      if (second) await second.ended;
    }
  });

  it("keeps unknown and stale readings and a memory warning closed, and removes a revoked waiting command", async () => {
    const dir = scratchDir("infinitary-load-waiting-");
    let now = 0;
    const line = new LoadLine({ stateFile: join(dir, "load.json"), now: () => now });
    lines.push(line);
    const channel = await AxiChannel.open({
      spawner: forkChildProcess(entry),
      binDir: bin,
      version: "9.9.9-test",
      keysDir: join(dir, "keys"),
    });
    channels.push(channel);
    const blockedShell = channel.grant("blocked", { load: line.forTask("blocked") });
    const blocked = run(blockedShell, dir, [
      process.execPath,
      "-e",
      "console.log('should not run')",
    ]);
    let following: ReturnType<typeof run> | undefined;
    try {
      await expect.poll(() => line.snapshot().runs.map((run) => run.taskId)).toEqual(["blocked"]);
      following = run(channel.grant("following", { load: line.forTask("following") }), dir, [
        process.execPath,
        "-e",
        "console.log('following admitted')",
      ]);
      await expect.poll(() => line.snapshot().runs.length).toBe(2);
      expect(line.snapshot().runs.every((run) => run.reason === "unavailable")).toBe(true);
      expect(blocked.output() + following.output()).toBe("");
      // Re-typed for INF-6381 (captain approved): a front declaring more memory than the
      // computer has is now refused, so a memory warning holds the front here instead.
      line.observe({ ...reading, memory: { ...reading.memory, memoryPressure: "warning" } }, null);
      expect(line.snapshot().runs.map((run) => run.state)).toEqual(["waiting", "waiting"]);
      now = RESOURCE_MAX_AGE_MS + 1;
      channel.revoke("blocked");
      expect(await blocked.ended).not.toBe(0);
      await expect
        .poll(() => line.snapshot().runs.map((run) => [run.taskId, run.reason]))
        .toEqual([["following", "unavailable"]]);
      expect(following.output()).toBe("");
      line.observe({ ...reading, memory: { ...reading.memory, memoryPressure: "critical" } }, null);
      expect(line.snapshot().runs[0]?.reason).toBe("pressure");
      now += RESOURCE_MAX_AGE_MS + 1;
      expect(line.snapshot().runs[0]?.reason).toBe("unavailable");
      line.observe(reading, null);
      expect(await following.ended).toBe(0);
      expect(following.output()).toContain("following admitted");
      await expect.poll(() => line.snapshot().runs).toEqual([]);
    } finally {
      channel.close();
      await Promise.all([blocked.ended, following?.ended]);
    }
  });

  // INF-6381, the captain's 10 minutes: behind a first in line that does not fit, a
  // run that fits the measured room starts during that run's first 10 minutes there,
  // and after them a fitting run waits until the first in line starts.
  it("lets a fitting run pass a blocked first in line only during its 10-minute window", async () => {
    const dir = scratchDir("infinitary-load-passing-");
    let now = 0;
    const line = new LoadLine({ stateFile: join(dir, "load.json"), now: () => now });
    lines.push(line);
    // The recorded reading gives 6.16 processors: A takes 4, so B's 4 waits.
    line.observe(reading, null);
    const channel = await AxiChannel.open({
      spawner: forkChildProcess(entry),
      binDir: bin,
      version: "9.9.9-test",
      keysDir: join(dir, "keys"),
    });
    channels.push(channel);
    const program = `console.log('started');process.stdin.resume();process.stdin.on('end',()=>{})`;
    // Claims answered per task, so the test knows a waiting wrapper asked again.
    const claims = new Map<string, number>();
    const counted = (task: string) => {
      const load = line.forTask(task);
      return {
        ...load,
        claim: (input: Parameters<typeof load.claim>[0]) => {
          claims.set(task, (claims.get(task) ?? 0) + 1);
          return load.claim(input);
        },
      };
    };
    const start = (task: string, processors: string) =>
      run(channel.grant(task, { load: counted(task) }), dir, [process.execPath, "-e", program], {
        processors,
        memoryMiB: "64",
      });
    const states = () => line.snapshot().runs.map((row) => [row.taskId, row.state, row.ahead]);
    const started: ReturnType<typeof run>[] = [];
    try {
      const a = start("A", "4");
      started.push(a);
      await expect.poll(a.output).toContain("started");
      const b = start("B", "4");
      started.push(b);
      await expect.poll(states).toEqual([
        ["A", "running", 0],
        ["B", "waiting", 0],
      ]);
      // A busier reading changes the room B waits for: 5.6 processors, 1.6 beside A.
      now = 9 * 60_000;
      line.observe({ ...reading, cpu: { ...reading.cpu, idleFraction: 0.7 } }, null);
      const asked = claims.get("B") ?? 0;
      await expect.poll(() => claims.get("B") ?? 0).toBeGreaterThan(asked + 1);
      expect(line.snapshot().runs[1]?.free?.cpu).toBe(1.6);
      const c = start("C", "1");
      started.push(c);
      await expect.poll(c.output).toContain("started");
      expect(b.output()).toBe("");
      // The recorded reading again: 1.16 processors beside A and C, so D fits and
      // only the closed window holds it.
      now = 10 * 60_000;
      line.observe(reading, null);
      const d = start("D", "1");
      started.push(d);
      await expect.poll(states).toEqual([
        ["A", "running", 0],
        ["B", "waiting", 0],
        ["C", "running", 0],
        ["D", "waiting", 1],
      ]);
      // The line holds D before its wrapper has printed the answer it was given.
      await expect.poll(d.errors).toContain("reason: line");
      // A and C finish: B starts alone, and D fits beside it.
      a.child.stdin.end();
      c.child.stdin.end();
      expect(await a.ended).toBe(0);
      expect(await c.ended).toBe(0);
      await expect.poll(b.output).toContain("started");
      await expect.poll(d.output).toContain("started");
      // B's room changed while it waited; its crewmate was shown the wait once.
      expect(b.errors().match(/state: waiting/g)).toHaveLength(1);
    } finally {
      for (const each of started) each.child.stdin.end();
      channel.close();
      await Promise.all(started.map((each) => each.ended));
    }
  });

  // INF-6381: a run asking more memory than the computer can ever give could never
  // start and held every run behind it; its wrapper now ends at once, naming the most.
  it("refuses at once a run too big for its computer, and the run behind it starts", async () => {
    const dir = scratchDir("infinitary-load-too-big-");
    const line = new LoadLine({ stateFile: join(dir, "load.json"), now: stillClock });
    lines.push(line);
    line.observe(reading, null);
    const channel = await AxiChannel.open({
      spawner: forkChildProcess(entry),
      binDir: bin,
      version: "9.9.9-test",
      keysDir: join(dir, "keys"),
    });
    channels.push(channel);
    const installedMiB = reading.memory.totalBytes / 1024 ** 2;
    const tooBig = run(
      channel.grant("too-big", { load: line.forTask("too-big") }),
      dir,
      [process.execPath, "-e", "console.log('should not run')"],
      { processors: "1", memoryMiB: String(installedMiB) },
    );
    expect(await tooBig.ended).not.toBe(0);
    expect(tooBig.output()).toBe("");
    // A process's exit can come before the last of its output is read.
    await expect
      .poll(tooBig.errors)
      .toContain(
        `Declare at most ${Math.floor(installedMiB * 0.9)} MiB, its installed memory less the margin; nothing started.`,
      );
    const behind = run(channel.grant("behind", { load: line.forTask("behind") }), dir, [
      process.execPath,
      "-e",
      "console.log('behind admitted')",
    ]);
    try {
      expect(await behind.ended).toBe(0);
      await expect.poll(behind.output).toContain("behind admitted");
      console.info("Too-big refusal proof", JSON.stringify({ refused: tooBig.errors() }));
    } finally {
      channel.close();
      await behind.ended;
    }
  });

  it("refuses admission after a failed state write without hiding held runs or failing measured Use", async () => {
    const dir = scratchDir("infinitary-load-store-");
    const stateFile = join(dir, "load.json");
    const line = new LoadLine({ stateFile });
    lines.push(line);
    const reader = new ComputerLoads({
      local: line,
      overrides: () => [],
      work: {
        ask: async () => {
          throw new Error("No work computer");
        },
        inReach: () => false,
        takesCurrentWork: () => false,
        onWorkDevice: () => () => {},
      },
    });
    const channel = await AxiChannel.open({
      spawner: forkChildProcess(entry),
      binDir: bin,
      version: "9.9.9-test",
      keysDir: join(dir, "keys"),
    });
    channels.push(channel);
    const waiting = run(channel.grant("store", { load: line.forTask("store") }), dir, [
      process.execPath,
      "-e",
      "console.log('should not run')",
    ]);
    try {
      await expect.poll(() => line.snapshot().runs.map((run) => run.state)).toEqual(["waiting"]);
      const before = reader.read(null);
      renameSync(stateFile, join(dir, "before.json"));
      mkdirSync(stateFile); // A real failed atomic replacement, confined to this disposable store.
      expect(() => line.observe(reading, null)).not.toThrow();
      expect(reader.read(null)).toEqual({ ...before, status: "unknown" });
      const sampler = new ResourceSampler({
        memory: () => reading.memory,
        processes: readProcesses,
        observed: (observation, processes, started, window, cpuWindow) =>
          line.observe(observation, processes, started, window, cpuWindow),
      });
      expect((await sampler.read()).status).toBe("sampled");
      expect(await waiting.ended).not.toBe(0);
      expect(waiting.output()).toBe("");
      expect(waiting.errors()).toContain("holds could not be kept");
    } finally {
      reader.dispose();
      channel.close();
      await waiting.ended;
    }
  });

  // INF-2228 approved plan: a lost receipt acknowledgment never re-enters
  // admission/launch. Real native children and event barriers own the ordering.
  it("retries only a saved receipt, starts once, and admits later work after a covering interval", async () => {
    const dir = scratchDir("infinitary-load-receipt-");
    const stateFile = join(dir, "load.json");
    const saved = deferred<void>();
    const repeated = deferred<void>();
    const late = deferred<void>();
    let now = 0;
    const line = new LoadLine({ stateFile, now: () => now });
    lines.push(line);
    line.observe(reading, null);
    const load = line.forTask("receipt");
    const receipts: LoadReceipt[] = [];
    let claims = 0;
    let spawns = 0;
    const native = forkChildProcess(entry);
    const channel = await AxiChannel.open({
      spawner: {
        spawn: () => {
          // The second command is the first receipt. Only its own existing
          // command deadline advances; native payload and cadence clocks stay real.
          if (++spawns === 2) vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          return native.spawn();
        },
      },
      binDir: bin,
      version: "9.9.9-test",
      keysDir: join(dir, "keys"),
    });
    channels.push(channel);
    const first = run(
      channel.grant("receipt", {
        load: {
          read: load.read,
          claim: (input) => {
            claims++;
            return load.claim(input);
          },
          receipt: async (input, permitted) => {
            receipts.push(input);
            await load.receipt(input, permitted);
            if (receipts.length === 1) {
              saved.resolve();
              await late.promise;
            } else repeated.resolve();
          },
        },
      }),
      dir,
      [
        process.execPath,
        "-e",
        "console.log('one payload');process.stdin.resume();process.stdin.on('end',()=>process.exit(7))",
      ],
      { processors: "8", memoryMiB: "256" },
    );
    let second: ReturnType<typeof run> | undefined;
    let third: ReturnType<typeof run> | undefined;
    try {
      await saved.promise;
      const durable = JSON.parse(readFileSync(stateFile, "utf8"))[0];
      expect(durable.launch).toEqual({ pid: receipts[0]?.payload, started: receipts[0]?.started });
      vi.advanceTimersToNextTimer();
      vi.useRealTimers();
      await repeated.promise;
      late.resolve();
      expect(receipts).toHaveLength(2);
      expect(receipts[1]).toEqual(receipts[0]);
      expect(claims).toBe(1);
      await expect.poll(first.output).toBe("one payload\n");
      second = run(
        channel.grant("after-coverage", { load: line.forTask("after-coverage") }),
        dir,
        [
          process.execPath,
          "-e",
          "console.log('later payload');process.stdin.resume();process.stdin.on('end',()=>process.exit(0))",
        ],
        { processors: "4", memoryMiB: "256" },
      );
      await expect.poll(() => line.snapshot().runs[1]?.state).toBe("waiting");
      expect(second.output()).toBe("");
      now = 251;
      line.observe({ ...reading, sequence: 2 }, null, now, undefined, {
        epoch: reading.epoch,
        start: 1,
        end: now,
      });
      await expect.poll(second.output).toBe("later payload\n");
      // Replay a real fully-busy state; admitted programs keep running while
      // new ordinary work has no CPU headroom. No real CPU saturation is induced.
      now = 502;
      line.observe(
        { ...reading, sequence: 3, cpu: { ...reading.cpu, idleFraction: 0 } },
        null,
        now,
        undefined,
        { epoch: reading.epoch, start: 252, end: now },
      );
      third = run(
        channel.grant("burst", { load: line.forTask("burst") }),
        dir,
        [process.execPath, "-e", "console.log('post-burst payload')"],
        { processors: "1", memoryMiB: "256" },
      );
      await expect.poll(() => line.snapshot().runs[2]?.state).toBe("waiting");
      expect(third.output()).toBe("");
      expect(first.child.exitCode).toBeNull();
      expect(second.child.exitCode).toBeNull();
      first.child.stdin.end();
      second.child.stdin.end();
      expect(await first.ended).toBe(7);
      expect(await second.ended).toBe(0);
      expect(await third.ended).toBe(0);
      await expect.poll(() => line.snapshot().runs).toEqual([]);
      console.info(
        "Verified-launch admission proof",
        JSON.stringify({
          claims,
          receipts,
          first: first.output(),
          second: second.output(),
          third: third.output(),
          durableLaunch: durable.launch,
          remaining: line.snapshot(),
        }),
      );
    } finally {
      vi.useRealTimers();
      late.resolve();
      first.child.stdin.end();
      second?.child.stdin.end();
      await first.ended;
      if (second) await second.ended;
      channel.close();
      if (third) await third.ended;
    }
  });

  it("ends receipt pursuit with a short-lived payload, without retaining its streams or reviving an ended group", async () => {
    const dir = scratchDir("infinitary-load-short-receipt-");
    const stateFile = join(dir, "load.json");
    const entered = deferred<{ identity: LoadReceipt; heard: () => boolean }>();
    const release = deferred<void>();
    const line = new LoadLine({ stateFile, now: stillClock });
    lines.push(line);
    line.observe(reading, null);
    const load = line.forTask("short");
    let calls = 0;
    const results: Promise<void>[] = [];
    const channel = await AxiChannel.open({
      spawner: forkChildProcess(entry),
      binDir: bin,
      version: "9.9.9-test",
      keysDir: join(dir, "keys"),
    });
    channels.push(channel);
    const taskLoad = {
      ...load,
      receipt: (input: LoadReceipt, permitted?: () => boolean) => {
        calls++;
        entered.resolve({ identity: input, heard: permitted ?? (() => true) });
        const work = release.promise.then(() => load.receipt(input, permitted));
        results.push(work);
        return work;
      },
    };
    const payload = run(channel.grant("short", { load: taskLoad }), dir, [
      process.execPath,
      "-e",
      "console.log('short payload');process.stdin.resume();process.stdin.on('end',()=>process.exit(3))",
    ]);
    try {
      const { identity, heard } = await entered.promise;
      payload.child.stdin.end();
      expect(await payload.ended).toBe(3);
      await expect
        .poll(async () => (await readProcesses())?.some((row) => row.group === identity.pid))
        .toBe(false);
      // The supervisor canceled the worker's request with the payload. Once the app has
      // heard that connection close, the delayed check is refused for its caller's leaving,
      // before it looks at the group.
      await expect.poll(heard).toBe(false);
      release.resolve();
      await expect(results[0]).rejects.toThrow("no longer has a load command");
      // Asked with no caller to have left, the line itself refuses the ended group.
      await expect(load.receipt(identity)).rejects.toThrow("living admitted group");
      expect(JSON.parse(readFileSync(stateFile, "utf8"))).not.toContainEqual(
        expect.objectContaining({ launch: expect.anything() }),
      );
      expect(calls).toBe(1);
      expect(payload.output()).toBe("short payload\n");
      console.info(
        "Canceled receipt pursuit proof",
        JSON.stringify({ identity, calls, output: payload.output(), exit: 3 }),
      );
    } finally {
      release.resolve();
      payload.child.stdin.end();
      await Promise.allSettled(results);
      channel.close();
      await payload.ended;
    }
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "preserves a payload's %s handling through the native supervisor",
    async (signal) => {
      const dir = scratchDir("infinitary-load-signal-");
      // The packaged layout has no source-tree fallback. This exercises the
      // compiled helper that a person receives, without packaging or signing.
      const packaged = join(dir, "resources");
      const packagedBin = join(packaged, "axi-bin");
      cpSync(bin, packagedBin, { recursive: true });
      mkdirSync(join(packaged, "load-bin"));
      cpSync(
        resolve(bin, "../../vendor/load-bin/infinitary-load-supervisor"),
        join(packaged, "load-bin/infinitary-load-supervisor"),
      );
      const verified = deferred<LoadReceipt>();
      const line = new LoadLine({ stateFile: join(dir, "load.json"), now: stillClock });
      lines.push(line);
      line.observe(reading, null);
      const load = line.forTask("signal");
      const channel = await AxiChannel.open({
        spawner: forkChildProcess(entry),
        binDir: packagedBin,
        version: "9.9.9-test",
        keysDir: join(dir, "keys"),
      });
      channels.push(channel);
      const program = `process.on('${signal}',()=>{console.log('handled ${signal}');process.exit(23)});console.log('ready');process.stdin.resume()`;
      const shell = channel.grant("signal", {
        load: {
          ...load,
          receipt: async (input, permitted) => {
            await load.receipt(input, permitted);
            verified.resolve(input);
          },
        },
      });
      const payload = run(
        { ...shell, env: { ...shell.env, TZ: "Pacific/Honolulu", LC_ALL: "C" } },
        dir,
        [process.execPath, "-e", program],
        undefined,
        join(packagedBin, "infinitary-load-axi"),
      );
      try {
        const identity = await verified.promise;
        await expect.poll(payload.output).toContain("ready");
        process.kill(identity.pid, signal); // the disposable supervisor, not the entire group
        expect(await payload.ended).toBe(23);
        expect(payload.output()).toBe(`ready\nhandled ${signal}\n`);
        console.info(
          "Native signal proof",
          JSON.stringify({ signal, output: payload.output(), exit: 23 }),
        );
      } finally {
        payload.child.stdin.end();
        channel.close();
        await payload.ended;
      }
    },
  );

  it("reuses a nested hold, refuses a larger nested demand, and obeys only a recorded override", async () => {
    const dir = scratchDir("infinitary-load-nested-");
    const overrides = new Set<string>();
    const line = new LoadLine({
      stateFile: join(dir, "load.json"),
      overridden: (task) => overrides.has(task),
    });
    lines.push(line);
    const channel = await AxiChannel.open({
      spawner: forkChildProcess(entry),
      binDir: bin,
      version: "9.9.9-test",
      keysDir: join(dir, "keys"),
    });
    channels.push(channel);
    const nested = join(bin, "infinitary-load-axi");
    const program = `const {spawnSync}=require('node:child_process');const run=n=>spawnSync(${JSON.stringify(nested)},['run','--processors',n,'--memory-mib','4096','--',process.execPath,'-e','console.log("nested admitted")'],{encoding:'utf8'});const same=run('4'),larger=run('5');console.log(JSON.stringify({same:{status:same.status,stdout:same.stdout},larger:{status:larger.status,stderr:larger.stderr}}));process.stdin.resume();process.stdin.on('data',()=>process.stdin.pause());`;
    const first = run(channel.grant("nested", { load: line.forTask("nested") }), dir, [
      process.execPath,
      "-e",
      program,
    ]);
    try {
      await expect.poll(() => line.snapshot().runs.map((run) => run.state)).toEqual(["waiting"]);
      expect(first.output()).toBe("");
      overrides.add("nested");
      line.reconsider();
      await expect.poll(first.output).toContain('"same"');
      const result = JSON.parse(first.output().trim());
      expect(result.same).toEqual({ status: 0, stdout: "nested admitted\n" });
      expect(result.larger.status).not.toBe(0);
      expect(result.larger.stderr).toContain("outer run declared less");
      expect(line.snapshot().runs.map((run) => [run.taskId, run.state])).toEqual([
        ["nested", "running"],
      ]);
      first.child.stdin.end("finish\n");
      expect(await first.ended).toBe(0);
      await expect.poll(() => line.snapshot().runs).toEqual([]);
    } finally {
      first.child.stdin.end("finish\n");
      channel.close();
      await first.ended;
    }
  });
});
