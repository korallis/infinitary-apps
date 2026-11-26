import { type ChildProcess, execFile, type SpawnOptions, spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { hostPlatform } from "../platform";
import { windowsProgram } from "../userBin";
import { endWindowsTree, windowsSystemProgram } from "../windowsTree";

const execFileAsync = promisify(execFile);

export type InstallRun = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBuffer: number;
};

/**
 * What a failed run carries: `stderr`; `killed` once the time limit stopped
 * it, as `execFile`'s does; and `stillRunning` when programs it started
 * could not be ended, so nothing else may write into its folder yet.
 */
export type InstallFailure = Error & { stderr?: string; killed?: boolean; stillRunning?: boolean };

/** A batch file, which Windows runs only through cmd.exe. */
const BATCH_FILE = /\.(cmd|bat)$/i;

/**
 * What cmd.exe reads as one plain word. The batch file's arguments reach
 * cmd.exe joined by spaces, unquoted, so anything else is refused.
 */
const PLAIN_ARGUMENT = /^[\w./:=@-]+$/;

/** The variable of the run's own environment that cmd.exe reads the batch file's path from. */
const BATCH_PATH_VARIABLE = "INFINITARY_INSTALL_PROGRAM";

/** A stopped run's programs end in well under a second; past this they are reported as running. */
const END_LIMIT_MS = 10_000;

/**
 * One run of a package manager, to its end.
 *
 * On Windows the program is looked up here, since Node starts a bare name
 * only as an `.exe`: a pnpm that npm or Corepack installed is `pnpm.cmd`,
 * which reads as not installed (`spawn pnpm ENOENT`). The working copy is
 * not searched, so a project's own file named like the program never runs.
 * A batch file runs through cmd.exe, and a run stopped at its time limit or
 * for printing too much has every program under it ended before it fails:
 * ending cmd.exe alone would leave the install writing into the working
 * copy while the next attempt starts.
 */
export async function runInstall(
  file: string,
  args: readonly string[],
  run: InstallRun,
  platform: NodeJS.Platform = hostPlatform(),
): Promise<void> {
  if (platform !== "win32") {
    await execFileAsync(file, [...args], {
      cwd: run.cwd,
      timeout: run.timeoutMs,
      maxBuffer: run.maxBuffer,
      env: run.env,
    });
    return;
  }
  const program = isAbsolute(file) ? file : windowsProgram(file, run.env);
  if (!program) throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" });
  if (BATCH_FILE.test(program) && !args.every((arg) => PLAIN_ARGUMENT.test(arg))) {
    throw new Error(`${file} takes only plain arguments through cmd.exe`);
  }
  await new Promise<void>((resolve, reject) => {
    const child = startOnWindows(program, args, run);
    const command = `${file} ${args.join(" ")}`;
    let stderr = "";
    let stopped: InstallFailure | undefined;
    let settled = false;
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const settle = (failure?: InstallFailure): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(giveUp);
      if (failure) reject(Object.assign(failure, { stderr }));
      else resolve();
    };
    // taskkill finds a run's programs through the one at its top, so the tree
    // is ended while that one still runs, and the run fails only once every
    // program holding its output has gone - or the wait for that runs out.
    const stop = (failure: InstallFailure): void => {
      if (stopped || settled) return;
      stopped = failure;
      clearTimeout(timer);
      if (child.pid === undefined) child.kill();
      else void endWindowsTree(child.pid, () => child.kill(), END_LIMIT_MS / 2);
      giveUp = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(Object.assign(failure, { stillRunning: true }));
      }, END_LIMIT_MS);
    };
    for (const name of ["stdout", "stderr"] as const) {
      let size = 0;
      child[name]?.setEncoding("utf8");
      child[name]?.on("data", (chunk: string) => {
        if (stopped) return;
        size += Buffer.byteLength(chunk);
        if (size > run.maxBuffer) {
          stop(
            Object.assign(new RangeError(`${name} maxBuffer length exceeded`), {
              code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
            }),
          );
        } else if (name === "stderr") stderr += chunk;
      });
    }
    const timer = setTimeout(
      () => stop(Object.assign(new Error(`Command failed: ${command}`), { killed: true })),
      run.timeoutMs,
    );
    child.once("error", (error) => settle(error));
    child.once("close", (code) => {
      if (stopped) settle(stopped);
      else if (code === 0) settle();
      else settle(Object.assign(new Error(`Command failed: ${command}\n${stderr}`), { code }));
    });
  });
}

function startOnWindows(program: string, args: readonly string[], run: InstallRun): ChildProcess {
  const options: SpawnOptions = {
    cwd: run.cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  };
  if (!BATCH_FILE.test(program)) return spawn(program, [...args], { ...options, env: run.env });
  // cmd.exe expands a percent expression even inside quotes, and a folder
  // may be named like one, so the command line names a variable and never
  // the path: cmd.exe does not read an expanded value again. Its own file
  // is named whole, /d keeps a person's AutoRun commands out of the run and
  // /v:off keeps an exclamation mark in the path as it is.
  return spawn(
    windowsSystemProgram("cmd.exe"),
    ["/d", "/v:off", "/s", "/c", `""%${BATCH_PATH_VARIABLE}%" ${args.join(" ")}"`],
    {
      ...options,
      env: { ...run.env, [BATCH_PATH_VARIABLE]: program },
      windowsVerbatimArguments: true,
    },
  );
}
