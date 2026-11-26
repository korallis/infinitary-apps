import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Server, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RESOURCE_REFRESH_MS, type ResourceObservation } from "@shared/resources";
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
import { JOURNAL_FILE, LoadLine, LoadReceiptUnreadError } from "./loadLine";
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
// Git Bash names a program by its last `/` part, as a crewmate's PATH gives it.
const LAUNCHER = join(AXI_BIN, "infinitary-load-axi").replace(/\\/g, "/");

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

  /** One run through the real launcher under Git Bash: what it said and how it ended. */
  function heavyRun(env: NodeJS.ProcessEnv, dir: string, command: string[], processors = 2) {
    const child = spawn(
      windowsBash() ?? "bash",
      [LAUNCHER, "run", "--processors", `${processors}`, "--memory-mib", "512", "--", ...command],
      { cwd: dir, env: hostEnv(env), stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
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
    // `close` waits for every holder of the run's streams, not only the wrapper.
    const closed = once(child, "close").then(([code]) => code as number | null);
    return { child, said, ended, closed };
  }
  /** The living programs of the job a hold's leader leads, by Windows number. */
  async function jobMembers(leader: number): Promise<number[]> {
    return ((await readProcesses()) ?? [])
      .filter((row) => row.group === leader && !row.exited)
      .map((row) => row.pid)
      .sort((a, b) => a - b);
  }
  /**
   * A line whose receipts are never answered, as a host too busy to answer
   * leaves them. The app runs each command in a process of its own, outside
   * every run's job, so a job that empties says nothing about that process:
   * `commands` counts the ones still running.
   */
  async function silentHost(prefix: string) {
    const dir = scratchDir(prefix);
    const stateFile = join(dir, "load.json");
    const line = new LoadLine({ stateFile });
    line.observe(reading, null);
    const fresh = setInterval(() => line.observe(reading, null), 1_000);
    const started: Array<{ exited: boolean }> = [];
    const spawner = forkChildProcess(await bundleAxiProcess());
    const channel = await AxiChannel.open({
      spawner: {
        spawn: () => {
          const child = spawner.spawn();
          const command = { exited: false };
          started.push(command);
          child.onExit(() => {
            command.exited = true;
          });
          return child;
        },
      },
      binDir: AXI_BIN,
      version: "9.9.9-test",
      keysDir: join(dir, "keys"),
    });
    /** Each receipt asked, and whether the line may still save a launch for its asker. */
    const asked: Array<{ hold: string; payload: number; permitted: () => boolean }> = [];
    const shell = channel.grant("heavy", {
      load: {
        ...line.forTask("heavy"),
        receipt: (input, permitted) => {
          asked.push({
            hold: input.hold,
            payload: input.payload,
            permitted: permitted ?? (() => true),
          });
          return new Promise<void>(() => {});
        },
      },
    });
    return {
      dir,
      stateFile,
      env: shell.env,
      asked,
      commands: () => started.filter((command) => !command.exited).length,
      /** The run is over once its job is empty: the wrapper's own end does not say so. */
      released: () =>
        expect
          .poll(
            async () => {
              line.observe(reading, await readProcesses());
              return line.snapshot().runs;
            },
            { timeout: 30_000 },
          )
          .toEqual([]),
      close: () => {
        clearInterval(fresh);
        channel.close();
        line.dispose();
      },
    };
  }

  // The wrapper's receipt worker names the program to the line; a later run then
  // waits only until a complete reading that began after that launch. The fixed
  // reading leaves 6.16 processors: room for one run of five, never for two.
  it.each(payloads)(
    "verifies the launch of $kind, then starts a later run on measured idle while it still runs",
    async ({ file, text, command }) => {
      expect(windowsBash()).toBeDefined();
      const dir = scratchDir("infinitary-windows-receipt-");
      const stateFile = join(dir, "load.json");
      const line = new LoadLine({ stateFile });
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
      // Readings with no processor interval keep capacity fresh and can cover no launch.
      line.observe(reading, null);
      const fresh = setInterval(() => line.observe(reading, null), 1_000);
      const channel = await AxiChannel.open({
        spawner: forkChildProcess(await bundleAxiProcess()),
        binDir: AXI_BIN,
        version: "9.9.9-test",
        keysDir: join(dir, "keys"),
      });
      const shell = channel.grant("heavy", { load: line.forTask("heavy") });
      const program = join(dir, file).replace(/\\/g, "/");
      writeFileSync(program, text);
      const run = () => heavyRun(shell.env, dir, command(program), 5);
      const saved = () =>
        JSON.parse(readFileSync(stateFile, "utf8")) as Array<{
          id: string;
          pid: number;
          state: string;
          launch?: { pid: number; started: string };
        }>;
      // Before the first run exists: an interval from here began before any launch.
      const before = performance.now();
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
        // The program prints its own Windows number: the launch is that program,
        // not the leader, the worker or the copy of the wrapper it started as.
        await expect.poll(() => first.said.output, { timeout: 30_000 }).toMatch(/^\d+\s*$/);
        expect(held?.launch?.pid).toBe(Number(first.said.output.trim()));
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
        // A complete reading that ends now and began before the launch overlaps
        // the program's start: it proves nothing about the run's own use.
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

  // A table the app cannot read while it checks a receipt proves nothing about
  // the launch. The command answers the typed interruption with the reading
  // cadence, the worker asks again at that cadence, and the same program is
  // verified once the table reads; a refusal the table could not change stays one.
  it("asks again after a receipt met an unreadable table, then verifies the same launch", async () => {
    const bash = windowsBash();
    expect(bash).toBeDefined();
    const dir = scratchDir("infinitary-windows-unread-");
    const stateFile = join(dir, "load.json");
    let unread = false;
    const line = new LoadLine({
      stateFile,
      processes: async () => (unread ? null : readProcesses()),
    });
    line.observe(reading, null);
    const fresh = setInterval(() => line.observe(reading, null), 1_000);
    const channel = await AxiChannel.open({
      spawner: forkChildProcess(await bundleAxiProcess()),
      binDir: AXI_BIN,
      version: "9.9.9-test",
      keysDir: join(dir, "keys"),
    });
    const task = line.forTask("heavy");
    // Each receipt in `misses` is checked against a table that cannot be read.
    let misses = 2;
    const receipts: Array<{ at: number; payload: number; answer: string }> = [];
    const shell = channel.grant("heavy", {
      load: {
        ...task,
        receipt: async (input, permitted) => {
          const entry = { at: performance.now(), payload: input.payload, answer: "verified" };
          receipts.push(entry);
          unread = misses-- > 0;
          try {
            await task.receipt(input, permitted);
          } catch (error) {
            entry.answer = error instanceof LoadReceiptUnreadError ? "unread" : "refused";
            throw error;
          } finally {
            unread = false;
          }
        },
      },
    });
    const [native] = payloads;
    const program = join(dir, native?.file ?? "").replace(/\\/g, "/");
    writeFileSync(program, native?.text ?? "");
    const saved = () =>
      JSON.parse(readFileSync(stateFile, "utf8")) as Array<{
        id: string;
        pid: number;
        launch?: { pid: number; started: string };
      }>;
    /** One receipt sent as the worker sends it, with the command's own answer. */
    const ask = (hold: string, leader: number, payload: number) =>
      new Promise<{ code: number | null; said: string }>((done) => {
        const child = spawn(
          bash ?? "bash",
          [LAUNCHER, "receipt", "--hold", hold, "--pid", `${leader}`, "--payload", `${payload}`],
          {
            cwd: dir,
            env: hostEnv(shell.env),
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          },
        );
        children.push(child);
        let said = "";
        child.stdout?.on("data", (chunk) => {
          said += chunk.toString();
        });
        child.once("close", (code) => done({ code, said }));
      });
    const first = heavyRun(shell.env, dir, native?.command(program) ?? []);
    try {
      await expect
        .poll(() => existsSync(stateFile) && saved()[0]?.launch, { timeout: 30_000 })
        .toBeTruthy()
        .catch((error: unknown) => {
          throw new Error(
            `no launch was verified; the run said: ${first.said.errors}; receipts ${JSON.stringify(receipts)}`,
            { cause: error },
          );
        });
      const payload = Number(first.said.output.trim());
      expect(receipts.map(({ payload, answer }) => ({ payload, answer }))).toEqual([
        { payload, answer: "unread" },
        { payload, answer: "unread" },
        { payload, answer: "verified" },
      ]);
      // The worker waited out the reading cadence before each repeat.
      for (const index of [1, 2])
        expect((receipts[index]?.at ?? 0) - (receipts[index - 1]?.at ?? 0)).toBeGreaterThanOrEqual(
          RESOURCE_REFRESH_MS - 250,
        );
      const [held] = saved();
      expect(held?.launch?.pid).toBe(payload);

      misses = 1;
      const again = await ask(held?.id ?? "", held?.pid ?? 0, payload);
      expect(again.code).toBe(1);
      expect(again.said).toMatch(/^code: RECEIPT_UNAVAILABLE$/m);
      expect(again.said).toMatch(new RegExp(`^retrySeconds: ${RESOURCE_REFRESH_MS / 1000}$`, "m"));
      // A hold that is not this run's is refused whatever the table says, with no cadence to repeat at.
      misses = 1;
      const refused = await ask("another-hold", held?.pid ?? 0, payload);
      expect(refused.code).toBe(1);
      expect(refused.said).toMatch(/^code: REFUSED$/m);
      expect(refused.said).not.toContain("retrySeconds");
      expect(saved()[0]?.launch).toEqual(held?.launch);

      first.child.stdin?.end("finish\n");
      expect(await first.ended).toBe(7);
    } finally {
      clearInterval(fresh);
      first.child.stdin?.end("finish\n");
      channel.close();
      line.dispose();
      await first.ended;
    }
  });

  // Git Bash starts every program as a copy of the wrapper, which then becomes
  // the program. A copy that takes seconds over it is still the wrapper's own
  // shell, a living member of the run's job that proves no launch: no receipt
  // names it, and the launch verified is the program it becomes. The copy is
  // known by the wrapper's whole argument list, so a program is verified though
  // its own arguments repeat the wrapper's words.
  it("verifies the program a copy of the wrapper becomes, never the copy", async () => {
    const bash = windowsBash();
    expect(bash).toBeDefined();
    const dir = scratchDir("infinitary-windows-copy-");
    const stateFile = join(dir, "load.json");
    const line = new LoadLine({ stateFile });
    line.observe(reading, null);
    const fresh = setInterval(() => line.observe(reading, null), 1_000);
    const channel = await AxiChannel.open({
      spawner: forkChildProcess(await bundleAxiProcess()),
      binDir: AXI_BIN,
      version: "9.9.9-test",
      keysDir: join(dir, "keys"),
    });
    const task = line.forTask("heavy");
    const asked: number[] = [];
    const shell = channel.grant("heavy", {
      load: {
        ...task,
        receipt: (input, permitted) => {
          asked.push(input.payload);
          return task.receipt(input, permitted);
        },
      },
    });
    const [native] = payloads;
    const program = join(dir, native?.file ?? "").replace(/\\/g, "/");
    writeFileSync(program, native?.text ?? "");
    const node = process.execPath.replace(/\\/g, "/");
    const first = heavyRun(shell.env, dir, [
      "eval",
      `( sleep 3; exec "${node}" "${program}" _group run --processors 2 )`,
    ]);
    try {
      await expect.poll(() => first.said.output, { timeout: 30_000 }).toMatch(/^\d+\s*$/);
      const payload = Number(first.said.output.trim());
      const saved = () =>
        JSON.parse(readFileSync(stateFile, "utf8")) as Array<{ launch?: { pid: number } }>;
      await expect
        .poll(() => saved()[0]?.launch, { timeout: 30_000 })
        .toBeTruthy()
        .catch((error: unknown) => {
          throw new Error(
            `no launch was verified; the run said: ${first.said.errors}; receipts named ${JSON.stringify(asked)}`,
            { cause: error },
          );
        });
      expect(saved()[0]?.launch?.pid).toBe(payload);
      expect(asked.filter((named) => named !== payload)).toEqual([]);
      first.child.stdin?.end("finish\n");
      expect(await first.ended).toBe(7);
      // The worker may still be reading its answer: the run is over once its job is empty.
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
      channel.close();
      line.dispose();
      await first.ended;
    }
  });

  // A builtin runs in the leader's own shell, so the jobs it starts are that
  // shell's, and the receipt worker is none of them. Each case first sees the
  // run's own receipt asked and left unanswered: only then is a worker there
  // for the builtin's `wait` to wait for, or for its return to signal in
  // place of the builtin's job.
  it("ends a builtin's wait with the job it started while the run's receipt is unanswered", async () => {
    expect(windowsBash()).toBeDefined();
    const host = await silentHost("infinitary-windows-builtin-wait-");
    const node = process.execPath.replace(/\\/g, "/");
    // The program ends once this file exists.
    const go = join(host.dir, "go");
    const waited = join(host.dir, "waited.js").replace(/\\/g, "/");
    writeFileSync(
      waited,
      `console.log(process.pid);setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(go)}))process.exit(4)},100)`,
    );
    try {
      const run = heavyRun(host.env, host.dir, ["eval", `"${node}" "${waited}" & wait`]);
      await expect.poll(() => run.said.output, { timeout: 30_000 }).toMatch(/^\d+\s*$/);
      const program = Number(run.said.output.trim());
      await expect
        .poll(() => host.asked.map((receipt) => receipt.payload), { timeout: 30_000 })
        .toContain(program);
      writeFileSync(go, "");
      await expect.poll(() => alive(program), { timeout: 30_000 }).toBe(false);
      const ended = performance.now();
      expect(await run.ended).toBe(0);
      // The unanswered receipt would hold a waited-for worker for a minute.
      expect(performance.now() - ended).toBeLessThan(15_000);
      await host.released();
      // The worker took its request along, and the app's command for it stopped too.
      await expect.poll(host.commands, { timeout: 15_000 }).toBe(0);
    } finally {
      writeFileSync(go, "");
      host.close();
    }
  });

  it("leaves the job a builtin started running when the builtin returns while the run's receipt is unanswered", async () => {
    expect(windowsBash()).toBeDefined();
    const host = await silentHost("infinitary-windows-builtin-leave-");
    const node = process.execPath.replace(/\\/g, "/");
    // The builtin returns once this file exists, and its program writes its own file five seconds later.
    const gate = join(host.dir, "gate").replace(/\\/g, "/");
    const left = join(host.dir, "left.js").replace(/\\/g, "/");
    const survived = join(host.dir, "survived");
    writeFileSync(
      left,
      `const fs=require('node:fs');const seen=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(gate)}))return;clearInterval(seen);setTimeout(()=>fs.writeFileSync(${JSON.stringify(survived)},''),5000)},100)`,
    );
    try {
      // `read` waits on the run's own input, which stays open and silent, so
      // the builtin starts no program but its one job for the worker to name.
      const run = heavyRun(host.env, host.dir, [
        "eval",
        `"${node}" "${left}" </dev/null >/dev/null 2>&1 & until [ -e "${gate}" ]; do read -r -t 0.2 || :; done`,
      ]);
      await expect.poll(() => host.asked.length, { timeout: 30_000 }).toBeGreaterThan(0);
      expect(host.asked.every(({ permitted }) => permitted())).toBe(true);
      writeFileSync(gate, "");
      expect(await run.ended).toBe(0);
      expect(existsSync(survived)).toBe(false);
      await expect.poll(() => existsSync(survived), { timeout: 30_000 }).toBe(true);
      await host.released();
      await expect.poll(host.commands, { timeout: 15_000 }).toBe(0);
    } finally {
      writeFileSync(gate, "");
      host.close();
    }
  });

  // A wrapper stopped by force cancels nothing, and its program runs on. The
  // worker still ends with the wrapper, though its receipt is unanswered, and
  // signals nothing: only the program is left in the run's job. The app's
  // command for that receipt runs outside the job and stops with its caller,
  // after which no reading could save a launch for it.
  it("ends the receipt worker with a wrapper stopped by force, and leaves its program running", async () => {
    expect(windowsBash()).toBeDefined();
    const host = await silentHost("infinitary-windows-forced-");
    // The program runs until this file exists: the test closes the run's input
    // when the stopped wrapper ends, so the program must not end with its input.
    const stop = join(host.dir, "stop");
    const program = join(host.dir, "stays.js").replace(/\\/g, "/");
    writeFileSync(
      program,
      `console.log(process.pid);setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(stop)}))process.exit(7)},100)`,
    );
    const first = heavyRun(host.env, host.dir, [process.execPath, program]);
    try {
      await expect.poll(() => first.said.output, { timeout: 30_000 }).toMatch(/^\d+\s*$/);
      const payload = Number(first.said.output.trim());
      await expect
        .poll(() => host.asked.map((receipt) => receipt.payload), { timeout: 30_000 })
        .toContain(payload);
      const [held] = JSON.parse(readFileSync(host.stateFile, "utf8")) as Array<{ pid: number }>;
      const leader = held?.pid ?? 0;
      // Git Bash keeps a process of its own for a Windows program it started, as that program's parent.
      const beside = ((await readProcesses()) ?? []).find((row) => row.pid === payload)?.parent;
      const kept = [beside ?? 0, payload].sort((a, b) => a - b);
      // More than those two and the leader: the worker with its pending request.
      const before = await jobMembers(leader);
      expect(before).toEqual(expect.arrayContaining([leader, ...kept]));
      expect(before.length).toBeGreaterThan(3);
      await expect.poll(host.commands, { timeout: 15_000 }).toBe(1);
      expect(host.asked.every(({ permitted }) => permitted())).toBe(true);
      process.kill(leader);
      await expect.poll(() => jobMembers(leader), { timeout: 15_000, interval: 250 }).toEqual(kept);
      await expect.poll(host.commands, { timeout: 15_000 }).toBe(0);
      expect(host.asked.some(({ permitted }) => permitted())).toBe(false);
      expect(alive(payload)).toBe(true);
      writeFileSync(stop, "");
      await expect.poll(() => alive(payload), { timeout: 30_000 }).toBe(false);
      await host.released();
    } finally {
      writeFileSync(stop, "");
      host.close();
    }
  });

  // A run that ends before its receipt is sent, and a shell builtin, which has
  // no program for the worker to find: the worker holds none of the run's
  // streams, and the run's job empties when the wrapper ends.
  it("passes a short run's input, both outputs and status through, and leaves nothing of it behind", async () => {
    expect(windowsBash()).toBeDefined();
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
    const program = join(dir, "short.js").replace(/\\/g, "/");
    writeFileSync(
      program,
      `let said='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>{said+=d});process.stdin.on('end',()=>{process.stdout.write('out:'+said);process.stderr.write('err:'+said);process.exitCode=3})`,
    );
    const run = async (command: string[], input: string) => {
      const { child, said, closed } = heavyRun(shell.env, dir, command);
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
