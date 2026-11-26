import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Server, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ResourceObservation } from "@shared/resources";
import { build } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bundleAxiProcess } from "../../../tests/helpers/axiProcessBundle";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { AxiChannel } from "../axi/channel";
import { withCrewShell } from "../claude/claudeCrewShell";
import { hostEnv } from "../hostEnv";
import { JobManager } from "../jobs/jobManager";
import { windowsBash } from "../pi/windowsBash";
import { forkChildProcess } from "../sql/forkChildProcess";
import { endHolder, findFolderHolders } from "./folderHolders";
import { JOURNAL_FILE, LoadLine } from "./loadLine";
import { loopbackCaller } from "./loopbackCaller";
import { descendsFrom, readProcesses } from "./processResources";
import { ShellGroups } from "./shellGroups";
import { readWindowsLoopbackOwners, WindowsJobs, windowsJobs } from "./windowsProcesses";
import { readWorkingFolders } from "./workingFolders";

// Each case starts two or three Node programs and reads the table a few times.
vi.setConfig({ testTimeout: 60_000 });

/**
 * INF-4243 piece 2: one Windows reading of programs serves the crew command
 * check, heavy runs and leftover-program stops. Fixture: real Node programs
 * this test starts, a real loopback connection, a real Git Bash shell through
 * the production JobManager, and the system's own table, connections and
 * jobs. Failure: a wrong field offset, a parent the system reused, a job that
 * loses what its leader started, a lost working folder or a holder not ended
 * fails at the reading itself. Windows only: other systems read ps, lsof and /proc.
 */
const windows = process.platform === "win32";
const AXI_BIN = resolve(__dirname, "../../../resources/axi-bin");

const children: ChildProcess[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const server of servers.splice(0)) server.close();
});

/** A Node program that prints its first line once ready and runs until its input ends. */
function start(source: string, cwd?: string): { child: ChildProcess; first: Promise<string> } {
  const child = spawn(process.execPath, ["-e", source], {
    ...(cwd ? { cwd } : {}),
    env: hostEnv(),
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });
  children.push(child);
  const first = new Promise<string>((resolve, reject) => {
    let text = "";
    child.stdout?.on("data", (chunk) => {
      text += chunk.toString();
      const end = text.indexOf("\n");
      if (end >= 0) resolve(text.slice(0, end).trim());
    });
    child.once("exit", (code) => reject(new Error(`exited ${code} before it was ready`)));
  });
  return { child, first };
}

/** A loopback server that answers each connection's two ports. */
async function listen(): Promise<{ port: number; next: () => Promise<Socket> }> {
  const sockets: Socket[] = [];
  const waiting: ((socket: Socket) => void)[] = [];
  const server = createServer((socket) => {
    // A client this test ends resets its connection; that is not a failure.
    socket.on("error", () => {});
    const wake = waiting.shift();
    if (wake) wake(socket);
    else sockets.push(socket);
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    port: address.port,
    next: () => {
      const ready = sockets.shift();
      return ready ? Promise.resolve(ready) : new Promise((resolve) => waiting.push(resolve));
    },
  };
}

const HOLD = "process.stdin.resume();process.stdin.on('end',()=>process.exit(0));";
const connect = (port: number) =>
  `const s=require('node:net').connect(${port},'127.0.0.1',()=>console.log(process.pid));s.on('error',()=>{});`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A Node program, `probe.js`, that writes whether it has a console window a person could see, then runs on. */
function writeProbe(dir: string): void {
  const koffi = createRequire(import.meta.url)
    .resolve("koffi")
    .replace(/\\/g, "/");
  writeFileSync(
    join(dir, "probe.js"),
    `const k=require(${JSON.stringify(koffi)});
const GetConsoleWindow=k.load('kernel32.dll').func('void* __stdcall GetConsoleWindow()');
const IsWindowVisible=k.load('user32.dll').func('int __stdcall IsWindowVisible(void* window)');
const window=GetConsoleWindow();
require('node:fs').writeFileSync(process.argv[2], JSON.stringify({pid:process.pid, visible: window ? IsWindowVisible(window)!==0 : false}));
setInterval(()=>{},1000);
`,
  );
}

/**
 * A stand-in for the app, built the way the app builds its code (one file,
 * its imports inlined, the native koffi left to Node): it runs the command
 * its first argument names in the folder its second names through the real
 * JobManager, prints the outcome and exits.
 */
async function bundleStandInApp(dir: string): Promise<string> {
  const root = resolve(__dirname, "../../..");
  const entry = join(dir, "standInApp.ts");
  writeFileSync(
    entry,
    `import { JobManager } from ${JSON.stringify(resolve(__dirname, "../jobs/jobManager.ts"))};
const jobs = new JobManager({ onExit: () => {} });
const outcome = await jobs.run({ ownerId: "task", command: process.argv[2] ?? "", cwd: process.argv[3] ?? "." });
console.log(JSON.stringify(outcome));
process.exit(0);
`,
  );
  const outDir = join(dir, "app");
  await build({
    configFile: false,
    logLevel: "silent",
    root,
    resolve: {
      alias: { "@core": resolve(root, "src/core"), "@shared": resolve(root, "src/shared") },
    },
    ssr: { noExternal: true, target: "node" },
    build: {
      ssr: entry,
      outDir,
      emptyOutDir: false,
      minify: false,
      target: "node24",
      rollupOptions: {
        external: ["koffi"],
        output: {
          format: "es",
          entryFileNames: "standInApp.mjs",
          paths: { koffi: pathToFileURL(createRequire(import.meta.url).resolve("koffi")).href },
        },
      },
    },
  });
  return join(outDir, "standInApp.mjs");
}

describe.skipIf(!windows)("the Windows reading of programs", () => {
  it("reads a program's number, parent, birth, processor time and memory", async () => {
    const before = Date.now();
    const { child, first } = start(
      `const mark=()=>{const u=process.cpuUsage();return u.user+u.system};while(mark()<150000){}const u=process.cpuUsage();console.log(process.pid+' '+Math.floor((u.user+u.system)/1000));${HOLD}`,
    );
    // The program's own count of the processor time it used is the work mark.
    const [pid, usedMs] = (await first).split(" ").map(Number);
    expect(pid).toBe(child.pid);
    const after = Date.now();
    const rows = await readProcesses();
    const row = rows?.find((candidate) => candidate.pid === child.pid);
    console.info("Windows table row", JSON.stringify({ count: rows?.length, row }));
    expect(row?.parent).toBe(process.pid);
    expect(row?.started).toMatch(/^win:\d+$/);
    expect(row?.bornMs).toBeGreaterThanOrEqual(before - 1);
    expect(row?.bornMs).toBeLessThanOrEqual(after);
    expect(usedMs).toBeGreaterThanOrEqual(150);
    expect(row?.cpuMs).toBeGreaterThanOrEqual(usedMs ?? Number.POSITIVE_INFINITY);
    expect(row?.residentBytes).toBeGreaterThan(0);
    expect(rows?.find((candidate) => candidate.pid === process.pid)).toBeDefined();
  });

  it("reads a parent that ended as no parent, so its old number names nothing", async () => {
    const { child, first } = start(
      `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',windowsHide:true});console.log(c.pid);c.unref();setTimeout(()=>process.exit(0),100);`,
    );
    const grandchild = Number(await first);
    await once(child, "exit");
    try {
      const rows = (await readProcesses()) ?? [];
      const byPid = new Map(rows.map((row) => [row.pid, row]));
      expect(byPid.get(grandchild)?.parent).toBe(0);
      expect(descendsFrom(grandchild, process.pid, byPid)).toBe(false);
    } finally {
      process.kill(grandchild);
    }
  });

  it("names the program holding the client end of a loopback connection", async () => {
    const server = await listen();
    const { child, first } = start(connect(server.port) + HOLD);
    expect(Number(await first)).toBe(child.pid);
    const socket = await server.next();
    const ends = { clientPort: socket.remotePort ?? 0, serverPort: socket.localPort ?? 0 };
    expect(readWindowsLoopbackOwners(ends)).toEqual([child.pid]);
    // This test started it, so it is the crew's; read as another app's, it is not.
    expect(await loopbackCaller(ends)).toEqual({ status: "checked", crew: true });
    expect(await loopbackCaller(ends, { appPid: child.pid ?? 0 })).toEqual({
      status: "checked",
      crew: false,
    });
  });

  it("keeps what a job's leader started in its group after the leader ends", async () => {
    const server = await listen();
    const { child, first } = start(
      `process.stdin.once('data',()=>{const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`${connect(server.port)}setInterval(()=>{},1000)`)}],{detached:true,stdio:['ignore','pipe','ignore'],windowsHide:true});c.stdout.once('data',d=>{process.stdout.write(d);process.exit(0)})});console.log('ready')`,
    );
    expect(await first).toBe("ready");
    const leader = child.pid ?? 0;
    const started = windowsJobs.lead(leader);
    expect(started).toMatch(/^win:\d+$/);
    const grandchildPid = new Promise<number>((resolve) =>
      child.stdout?.on("data", (chunk) => {
        const pid = Number(chunk.toString().trim());
        if (pid > 0) resolve(pid);
      }),
    );
    child.stdin?.write("go\n");
    const grandchild = await grandchildPid;
    await once(child, "exit");
    try {
      const socket = await server.next();
      const ends = { clientPort: socket.remotePort ?? 0, serverPort: socket.localPort ?? 0 };
      const rows = (await readProcesses()) ?? [];
      const row = rows.find((candidate) => candidate.pid === grandchild);
      expect(row).toMatchObject({ parent: 0, group: leader });
      // Started outside every tree this app reads: only its shell's group makes it the crew's.
      const shells = new ShellGroups();
      expect(
        await loopbackCaller(ends, { appPid: 4, shells: (group) => shells.of(group) }),
      ).toEqual({ status: "checked", crew: false });
      shells.add(leader, "task", started);
      expect(
        await loopbackCaller(ends, { appPid: 4, shells: (group) => shells.of(group) }),
      ).toEqual({ status: "checked", crew: true });
      // The app finds the job again by name after a restart.
      const restarted = new WindowsJobs();
      expect(restarted.adopt(leader, started ?? "")).toBe(true);
      expect(restarted.members()?.get(leader)).toEqual([grandchild]);
      expect(restarted.exists(leader)).toBe(true);
    } finally {
      process.kill(grandchild);
    }
    await expect.poll(() => windowsJobs.exists(leader)).toBe(false);
  });

  it("refuses the crew a program its Git Bash shell left running after the shell ended", async () => {
    const bash = windowsBash();
    expect(bash).toBeDefined();
    const dir = scratchDir("infinitary-windows-crew-");
    const server = await listen();
    const program = join(dir, "left.js");
    writeFileSync(program, `${connect(server.port)}setInterval(()=>{},1000);`);
    const shells = new ShellGroups();
    const exits: number[] = [];
    const jobs = new JobManager({
      onExit: (exit) => exits.push(exit.exitCode ?? -1),
      shellGroups: shells,
    });
    const node = process.execPath.replace(/\\/g, "/");
    const outcome = await jobs.run({
      ownerId: "task",
      command: `"${node}" "${program.replace(/\\/g, "/")}" > /dev/null 2>&1 & echo started`,
      cwd: dir,
    });
    expect(outcome).toMatchObject({ kind: "done", exitCode: 0 });
    const socket = await server.next();
    const ends = { clientPort: socket.remotePort ?? 0, serverPort: socket.localPort ?? 0 };
    const [left] = readWindowsLoopbackOwners(ends) ?? [];
    try {
      const rows = (await readProcesses()) ?? [];
      const row = rows.find((candidate) => candidate.pid === left);
      console.info("Program a shell left", JSON.stringify(row));
      expect(row?.group).toBeGreaterThan(0);
      expect(shells.of(row?.group ?? 0)).toMatchObject({ owner: "task", shellEnded: true });
      // Its shell ended, so no tree this app started holds it: its group does.
      expect(
        await loopbackCaller(ends, { appPid: 4, shells: (group) => shells.of(group) }),
      ).toEqual({ status: "checked", crew: true });
    } finally {
      if (left) process.kill(left);
    }
  });

  it("refuses the crew a program a Claude crewmate's command left running through the crew shell", async () => {
    // The client runs each command as Git Bash's bash with the app's prefix
    // and the command, each quoted, after -c; the prefix tells the channel
    // its Windows number and the app makes it lead a job before the command runs.
    const bash = windowsBash();
    expect(bash).toBeDefined();
    const dir = scratchDir("infinitary-windows-claude-");
    const shells = new ShellGroups();
    const channel = await AxiChannel.open({
      spawner: forkChildProcess(await bundleAxiProcess()),
      binDir: AXI_BIN,
      version: "9.9.9-test",
      keysDir: join(dir, "keys"),
      shellGroups: shells,
    });
    const server = await listen();
    const program = join(dir, "left.js");
    writeFileSync(program, `${connect(server.port)}setInterval(()=>{},1000);`);
    const grant = channel.grant("task", {});
    const env = withCrewShell(hostEnv(grant.env), { path: [AXI_BIN] });
    const prefix = env.CLAUDE_CODE_SHELL_PREFIX ?? "";
    expect(prefix).toMatch(/infinitary-crew-shell$/);
    const node = process.execPath.replace(/\\/g, "/");
    const command = `"${node}" "${program.replace(/\\/g, "/")}" > /dev/null 2>&1 & echo started`;
    const child = spawn(bash ?? "bash", ["-c", `'${prefix}' '${command}'`], {
      cwd: dir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    children.push(child);
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    let left: number | undefined;
    try {
      const [code] = await once(child, "exit");
      expect({ code, output: output.trim() }).toEqual({ code: 0, output: "started" });
      const socket = await server.next();
      const ends = { clientPort: socket.remotePort ?? 0, serverPort: socket.localPort ?? 0 };
      [left] = readWindowsLoopbackOwners(ends) ?? [];
      const rows = (await readProcesses()) ?? [];
      const row = rows.find((candidate) => candidate.pid === left);
      console.info("Program a Claude command left", JSON.stringify(row));
      expect(row?.group).toBeGreaterThan(0);
      expect(shells.of(row?.group ?? 0)).toMatchObject({ owner: "task" });
      expect(
        await loopbackCaller(ends, { appPid: 4, shells: (group) => shells.of(group) }),
      ).toEqual({ status: "checked", crew: true });
    } finally {
      if (left) process.kill(left);
      channel.close();
    }
  });

  it("keeps a Pi shell's programs hidden, and stopping its command ends every program it started", async () => {
    const dir = scratchDir("infinitary-windows-stop-");
    writeProbe(dir);
    const jobs = new JobManager({ onExit: () => {} });
    const node = process.execPath.replace(/\\/g, "/");
    const at = (name: string) => join(dir, name).replace(/\\/g, "/");
    const outcome = await jobs.run({
      ownerId: "task",
      command: `"${node}" "${at("probe.js")}" "${at("left.json")}" & "${node}" "${at("probe.js")}" "${at("waited.json")}"`,
      cwd: dir,
      background: true,
    });
    expect(outcome.kind).toBe("job");
    const report = (name: string) =>
      existsSync(join(dir, name))
        ? (JSON.parse(readFileSync(join(dir, name), "utf8")) as { pid: number; visible: boolean })
        : undefined;
    await expect
      .poll(() => report("left.json") && report("waited.json"), { timeout: 30_000 })
      .toBeTruthy();
    const programs = [report("left.json"), report("waited.json")];
    console.info("Programs a Pi shell started", JSON.stringify(programs));
    expect(programs.map((program) => program?.visible)).toEqual([false, false]);
    const pids = programs.map((program) => program?.pid ?? 0);
    expect(pids.every(alive)).toBe(true);
    jobs.killForOwner("task");
    await expect.poll(() => pids.filter(alive), { timeout: 30_000 }).toEqual([]);
  });

  it("keeps a program a Pi shell left running after the app that started it exits, until a stop ends it", async () => {
    const dir = scratchDir("infinitary-windows-outlive-");
    writeProbe(dir);
    const app = await bundleStandInApp(dir);
    const node = process.execPath.replace(/\\/g, "/");
    const at = (name: string) => join(dir, name).replace(/\\/g, "/");
    const command = `"${node}" "${at("probe.js")}" "${at("left.json")}" > /dev/null 2>&1 & echo started`;
    const child = spawn(process.execPath, [app, command, dir], {
      env: hostEnv(),
      stdio: ["ignore", "pipe", "inherit"],
      windowsHide: true,
    });
    children.push(child);
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    const [code] = await once(child, "exit");
    expect({ code, outcome: JSON.parse(output.trim() || "null") }).toMatchObject({
      code: 0,
      outcome: { kind: "done", exitCode: 0, output: "started" },
    });
    await expect.poll(() => existsSync(join(dir, "left.json")), { timeout: 30_000 }).toBe(true);
    const left = JSON.parse(readFileSync(join(dir, "left.json"), "utf8")) as {
      pid: number;
      visible: boolean;
    };
    console.info("Program a Pi shell left after the app exited", JSON.stringify(left));
    expect(left.visible).toBe(false);
    // The app has exited; a reading after that still finds the program.
    const rows = (await readProcesses()) ?? [];
    expect(rows.some((row) => row.pid === left.pid)).toBe(true);
    expect(alive(left.pid)).toBe(true);
    // A stop of the closed task's leftovers ends it.
    const reading = await findFolderHolders([dir], { protectDescendants: false });
    const holder =
      reading.status === "checked"
        ? reading.holders.find((row) => row.pid === left.pid)
        : undefined;
    expect(holder).toBeDefined();
    if (!holder) return;
    expect((await endHolder(holder, { graceMs: 2_000 })).outcome).toBe("ended");
    await expect.poll(() => alive(left.pid), { timeout: 30_000 }).toBe(false);
  });

  it("finds and ends a program working in a closed task's folder", async () => {
    const dir = scratchDir("infinitary-windows-holder-");
    const { child, first } = start(`console.log(process.pid);${HOLD}`, dir);
    const pid = Number(await first);
    expect(pid).toBe(child.pid);
    const folders = await readWorkingFolders([pid]);
    expect(folders?.get(pid)?.toLowerCase()).toBe(realpathSync(dir).toLowerCase());
    const reading = await findFolderHolders([dir], { protectDescendants: false });
    expect(reading.status).toBe("checked");
    const holder =
      reading.status === "checked" ? reading.holders.find((row) => row.pid === pid) : undefined;
    expect(holder?.name.toLowerCase()).toBe("node.exe");
    if (!holder) return;
    expect((await endHolder(holder, { graceMs: 2_000 })).outcome).toBe("ended");
    await once(child, "exit");
  });
});

// The ordinary-use Mac reading recorded by SCR-380, as loadLine.integration.test.ts drives admission with.
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

function journalEvents(dir: string): string[] {
  const file = join(dir, JOURNAL_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((entry) => (JSON.parse(entry) as { event: string }).event);
}

describe.skipIf(!windows)("a heavy run on Windows through its command", () => {
  // A native program, and a Git Bash one, whose exec by the wrapper would end
  // the leader's Windows process while the program still runs.
  const payloads = [
    {
      kind: "a native program",
      file: "payload.js",
      text: `console.log(process.pid);process.stdin.setEncoding('utf8');process.stdin.on('data',d=>{if(d.trim()==='finish'){process.exitCode=7;process.stdin.pause()}})`,
      command: (file: string) => [process.execPath, file],
    },
    {
      kind: "a Git Bash script",
      file: "payload.sh",
      text: 'cat /proc/$$/winpid\nwhile read -r line; do [ "$line" = finish ] && exit 7; done\n',
      command: (file: string) => ["/usr/bin/bash", file],
    },
  ];
  it.each(payloads)(
    "admits $kind in a job of its own, measures it there and releases it when it ends",
    async ({ file, text, command }) => {
      const bash = windowsBash();
      expect(bash).toBeDefined();
      const dir = scratchDir("infinitary-windows-load-");
      const line = new LoadLine({ stateFile: join(dir, "load.json") });
      line.observe(reading, null);
      // The app reads resources again every few seconds, and the line refuses a
      // reading older than its limit; opening the channel and starting Git Bash
      // on a busy computer can take longer than that.
      const fresh = setInterval(() => line.observe(reading, null), 1_000);
      const channel = await AxiChannel.open({
        spawner: forkChildProcess(await bundleAxiProcess()),
        binDir: resolve(__dirname, "../../../resources/axi-bin"),
        version: "9.9.9-test",
        keysDir: join(dir, "keys"),
      });
      const shell = channel.grant("heavy", { load: line.forTask("heavy") });
      // Git Bash names a program by its last `/` part, as a crewmate's PATH gives it.
      const launcher = resolve(__dirname, "../../../resources/axi-bin/infinitary-load-axi").replace(
        /\\/g,
        "/",
      );
      // A file, not -e: Git Bash reads a Windows command line its own way and
      // drops an inline program's quotes and braces.
      const program = join(dir, file).replace(/\\/g, "/");
      writeFileSync(program, text);
      const child = spawn(
        bash ?? "bash",
        [launcher, "run", "--processors", "2", "--memory-mib", "1024", "--", ...command(program)],
        { cwd: dir, env: hostEnv(shell.env), stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      );
      children.push(child);
      let output = "";
      let errors = "";
      child.stdout?.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        errors += chunk.toString();
      });
      const ended = once(child, "exit").then(([code]) => code as number | null);
      try {
        await expect
          .poll(() => output, { timeout: 30_000 })
          .toMatch(/^\d+\s*$/)
          .catch((error: unknown) => {
            // What the wrapper said is read when the wait gives up, not when it starts.
            throw new Error(
              `the run printed nothing; it said: ${errors}; the line held ${JSON.stringify(line.snapshot())}`,
              { cause: error },
            );
          });
        const payload = Number(output.trim());
        const [run] = line.snapshot().runs;
        expect(run).toMatchObject({ taskId: "heavy", state: "running" });
        const rows = (await readProcesses()) ?? [];
        const row = rows.find((candidate) => candidate.pid === payload);
        const leader = rows.find((candidate) => candidate.pid === row?.group);
        console.info("Windows heavy run", JSON.stringify({ payload: row, leader, errors }));
        // The program runs in the group the app made its wrapper lead.
        expect(row?.group).toBeGreaterThan(0);
        expect(leader?.group).toBe(leader?.pid);
        // A reading while the program runs finds its leader alive: the run has not ended.
        line.observe(reading, await readProcesses());
        expect(journalEvents(dir)).not.toContain("exited");
        child.stdin?.end("finish\n");
        expect(await ended).toBe(7);
        await expect.poll(() => line.snapshot().runs, { timeout: 30_000 }).toEqual([]);
      } finally {
        clearInterval(fresh);
        child.stdin?.end("finish\n");
        channel.close();
        line.dispose();
        await ended;
      }
    },
  );

  // The wrapper's receipt worker names the program to the line; a later run then
  // waits only until a complete reading that began after that launch. The fixed
  // reading leaves 6.16 processors: room for one run of five, never for two.
  it.each(payloads)(
    "verifies the launch of $kind, then starts a later run on measured idle while it still runs",
    async ({ file, text, command }) => {
      const bash = windowsBash();
      expect(bash).toBeDefined();
      const dir = scratchDir("infinitary-windows-receipt-");
      const stateFile = join(dir, "load.json");
      const line = new LoadLine({ stateFile });
      const before = performance.now();
      let sequence = 0;
      // A complete reading over the interval from `start` to now, with the system's own table.
      const sample = async (start: number) => {
        const rows = await readProcesses();
        const end = performance.now();
        line.observe(
          { ...reading, sequence: ++sequence, sampleMs: end - start },
          rows,
          end,
          undefined,
          { epoch: reading.epoch, start, end },
        );
      };
      // Readings that began before either run started keep capacity fresh and cover no launch.
      await sample(before);
      const fresh = setInterval(() => void sample(before), 1_000);
      const channel = await AxiChannel.open({
        spawner: forkChildProcess(await bundleAxiProcess()),
        binDir: AXI_BIN,
        version: "9.9.9-test",
        keysDir: join(dir, "keys"),
      });
      const shell = channel.grant("heavy", { load: line.forTask("heavy") });
      const launcher = join(AXI_BIN, "infinitary-load-axi").replace(/\\/g, "/");
      const program = join(dir, file).replace(/\\/g, "/");
      writeFileSync(program, text);
      const run = () => {
        const child = spawn(
          bash ?? "bash",
          [launcher, "run", "--processors", "5", "--memory-mib", "512", "--", ...command(program)],
          { cwd: dir, env: hostEnv(shell.env), stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
        );
        children.push(child);
        const said = { output: "", errors: "" };
        child.stdout?.on("data", (chunk) => {
          said.output += chunk.toString();
        });
        child.stderr?.on("data", (chunk) => {
          said.errors += chunk.toString();
        });
        const ended = once(child, "exit").then(([code]) => code as number | null);
        return { child, said, ended };
      };
      const saved = () =>
        JSON.parse(readFileSync(stateFile, "utf8")) as Array<{
          id: string;
          pid: number;
          state: string;
          launch?: { pid: number; started: string };
        }>;
      const first = run();
      let later: ReturnType<typeof run> | undefined;
      try {
        await expect
          .poll(() => existsSync(stateFile) && saved()[0]?.launch, { timeout: 30_000 })
          .toBeTruthy()
          .catch((error: unknown) => {
            throw new Error(
              `no launch was verified; the run said: ${first.said.errors}; the line held ${JSON.stringify(line.snapshot())}`,
              { cause: error },
            );
          });
        const [held] = saved();
        expect(held?.launch?.pid).not.toBe(held?.pid);
        expect(held?.launch?.started).toMatch(/^win:\d+$/);
        // The test's own program is outside the run's job, and the leader is not its payload.
        const task = line.forTask("heavy");
        for (const payload of [process.pid, held?.pid ?? 0])
          await expect(
            task.receipt({ hold: held?.id ?? "", pid: held?.pid ?? 0, payload }),
          ).rejects.toThrow("living admitted group");
        expect(saved()[0]?.launch).toEqual(held?.launch);

        later = run();
        // The line compared the later run and found 1.16 processors: the first run's five still count.
        await expect
          .poll(() => line.snapshot().runs[1], { timeout: 30_000 })
          .toMatchObject({ state: "waiting", reason: "capacity", free: { cpu: 1.16 } });
        clearInterval(fresh);
        await sample(before);
        expect(line.snapshot().runs.map((run) => run.state)).toEqual(["running", "waiting"]);

        // One complete reading that began after the launch was verified.
        const after = performance.now();
        await new Promise((resolve) => setTimeout(resolve, reading.sampleMs));
        await sample(after);
        expect(line.snapshot().runs.map((run) => run.state)).toEqual(["running", "running"]);
        const saidLater = later.said;
        await expect.poll(() => saidLater.output, { timeout: 30_000 }).toMatch(/^\d+\s*$/);
        // The first program still runs: nothing ended to make the room.
        expect(first.child.exitCode).toBeNull();
        expect(journalEvents(dir)).toEqual(["wait", "admit", "wait", "blocked", "admit"]);
        first.child.stdin?.end("finish\n");
        later.child.stdin?.end("finish\n");
        expect(await first.ended).toBe(7);
        expect(await later.ended).toBe(7);
        await expect
          .poll(
            async () => {
              line.observe(reading, await readProcesses());
              return line.snapshot().runs;
            },
            { timeout: 30_000 },
          )
          .toEqual([]);
      } finally {
        clearInterval(fresh);
        first.child.stdin?.end("finish\n");
        later?.child.stdin?.end("finish\n");
        channel.close();
        line.dispose();
        await Promise.all([first.ended, later?.ended]);
      }
    },
  );

  // A run that ends before its receipt is sent, and a shell builtin, which has
  // no program for the worker to find: the worker holds none of the run's
  // streams, and the run's job empties when the wrapper ends.
  it("passes a short run's input, both outputs and status through, and leaves nothing of it behind", async () => {
    const bash = windowsBash();
    expect(bash).toBeDefined();
    const dir = scratchDir("infinitary-windows-short-");
    const line = new LoadLine({ stateFile: join(dir, "load.json") });
    line.observe(reading, null);
    const fresh = setInterval(() => line.observe(reading, null), 1_000);
    const channel = await AxiChannel.open({
      spawner: forkChildProcess(await bundleAxiProcess()),
      binDir: AXI_BIN,
      version: "9.9.9-test",
      keysDir: join(dir, "keys"),
    });
    const shell = channel.grant("heavy", { load: line.forTask("heavy") });
    const launcher = join(AXI_BIN, "infinitary-load-axi").replace(/\\/g, "/");
    const program = join(dir, "short.js").replace(/\\/g, "/");
    writeFileSync(
      program,
      `let said='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>{said+=d});process.stdin.on('end',()=>{process.stdout.write('out:'+said);process.stderr.write('err:'+said);process.exitCode=3})`,
    );
    const run = async (command: string[], input: string) => {
      const child = spawn(
        bash ?? "bash",
        [launcher, "run", "--processors", "2", "--memory-mib", "512", "--", ...command],
        { cwd: dir, env: hostEnv(shell.env), stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      );
      children.push(child);
      const said = { output: "", errors: "" };
      child.stdout?.on("data", (chunk) => {
        said.output += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        said.errors += chunk.toString();
      });
      // `close` waits for every holder of the run's streams, not only the wrapper.
      const closed = once(child, "close").then(([code]) => code as number | null);
      child.stdin?.end(input);
      const code = await closed;
      await expect.poll(() => line.snapshot().runs, { timeout: 30_000 }).toEqual([]);
      return { ...said, code };
    };
    try {
      expect(await run([process.execPath, program], "the caller's words")).toEqual({
        code: 3,
        output: "out:the caller's words",
        errors: "err:the caller's words",
      });
      expect(await run(["test", "-n", ""], "")).toEqual({ code: 1, output: "", errors: "" });
      expect(journalEvents(dir)).toEqual(["wait", "admit", "release", "wait", "admit", "release"]);
    } finally {
      clearInterval(fresh);
      channel.close();
      line.dispose();
    }
  });

  it("takes a waiting run out of the line once the command that asked was stopped", async () => {
    const bash = windowsBash();
    expect(bash).toBeDefined();
    const dir = scratchDir("infinitary-windows-wait-");
    const stateFile = join(dir, "load.json");
    const line = new LoadLine({ stateFile });
    // Memory under pressure: the line admits nothing, so the run waits.
    const pressed: ResourceObservation = {
      ...reading,
      memory: { ...reading.memory, memoryPressure: "warning" },
    };
    line.observe(pressed, null);
    const channel = await AxiChannel.open({
      spawner: forkChildProcess(await bundleAxiProcess()),
      binDir: AXI_BIN,
      version: "9.9.9-test",
      keysDir: join(dir, "keys"),
    });
    const shell = channel.grant("heavy", { load: line.forTask("heavy") });
    const launcher = join(AXI_BIN, "infinitary-load-axi").replace(/\\/g, "/");
    const program = join(dir, "payload.js").replace(/\\/g, "/");
    const ran = join(dir, "ran");
    writeFileSync(program, `require('node:fs').writeFileSync(${JSON.stringify(ran)}, '')`);
    const child = spawn(
      bash ?? "bash",
      [
        launcher,
        "run",
        "--processors",
        "2",
        "--memory-mib",
        "1024",
        "--",
        process.execPath,
        program,
      ],
      { cwd: dir, env: hostEnv(shell.env), stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    children.push(child);
    let errors = "";
    child.stderr?.on("data", (chunk) => {
      errors += chunk.toString();
    });
    try {
      await expect
        .poll(() => line.snapshot().runs, { timeout: 30_000 })
        .toMatchObject([{ taskId: "heavy", state: "waiting" }])
        .catch((error: unknown) => {
          throw new Error(`the run never waited; it said: ${errors}`, { cause: error });
        });
      const [held] = JSON.parse(readFileSync(stateFile, "utf8")) as Array<{
        pid: number;
        caller?: { pid: number };
      }>;
      const rows = (await readProcesses()) ?? [];
      console.info(
        "Windows waiting run",
        JSON.stringify({
          held,
          leader: rows.find((row) => row.pid === held?.pid),
          caller: rows.find((row) => row.pid === held?.caller?.pid),
        }),
      );
      const caller = held?.caller?.pid ?? 0;
      expect(caller).toBeGreaterThan(0);
      // The crewmate's command is stopped: the wrapper that asked ends.
      process.kill(caller);
      await expect
        .poll(
          async () => {
            line.observe(pressed, await readProcesses());
            return line.snapshot().runs;
          },
          { timeout: 30_000 },
        )
        .toEqual([]);
      const released = readFileSync(join(dir, JOURNAL_FILE), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((entry) => JSON.parse(entry) as { event: string; why?: string })
        .filter((entry) => entry.event === "release");
      expect(released).toMatchObject([{ why: "it left the line: its caller ended" }]);
      // The wrapper that waited asks once more, hears its caller ended and stops,
      // while the line can still answer it; its program never started.
      await expect
        .poll(() => held !== undefined && alive(held.pid), { timeout: 30_000 })
        .toBe(false);
      expect(existsSync(ran)).toBe(false);
    } finally {
      channel.close();
      line.dispose();
    }
  });
});
