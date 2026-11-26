import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { hostPlatform } from "../platform";
import { windowsProgram } from "../userBin";
import { endWindowsTree } from "../windowsTree";

const execFileAsync = promisify(execFile);

export type InstallRun = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBuffer: number;
};

/** A batch file, which Windows runs only through cmd.exe. */
const BATCH_FILE = /\.(cmd|bat)$/i;

/**
 * What cmd.exe reads as one plain word. The batch file's arguments reach
 * cmd.exe joined by spaces, unquoted, so anything else is refused.
 */
const PLAIN_ARGUMENT = /^[\w./:=@-]+$/;

/**
 * One run of a package manager, to its end. A failure carries `stderr`, and
 * `killed` once the time limit stopped the run, as `execFile`'s does.
 *
 * On Windows the program is looked up here, since Node starts a bare name
 * only as an `.exe`: a pnpm that npm or Corepack installed is `pnpm.cmd`,
 * which reads as not installed (`spawn pnpm ENOENT`). The working copy is
 * not searched, so a project's own file named like the program never runs.
 * A batch file runs through cmd.exe, and the time limit ends every program
 * under the run: ending cmd.exe alone would leave the install writing into
 * the working copy while the next attempt starts.
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
  const batch = BATCH_FILE.test(program);
  if (batch && !args.every((arg) => PLAIN_ARGUMENT.test(arg))) {
    throw new Error(`${file} takes only plain arguments through cmd.exe`);
  }
  await new Promise<void>((resolve, reject) => {
    const options = { cwd: run.cwd, maxBuffer: run.maxBuffer, env: run.env, windowsHide: true };
    let timedOut = false;
    const ended = (error: Error | null, _stdout: string, stderr: string): void => {
      clearTimeout(timer);
      if (!error) resolve();
      else reject(Object.assign(error, { stderr, ...(timedOut ? { killed: true } : {}) }));
    };
    const child = batch
      ? // One command line and no argument list: Node then passes it to
        // cmd.exe as it is, and cmd.exe strips only the outer quotes Node adds.
        execFile(`"${program}" ${args.join(" ")}`, { ...options, shell: true }, ended)
      : execFile(program, [...args], options, ended);
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid === undefined) child.kill();
      else endWindowsTree(child.pid, () => child.kill());
    }, run.timeoutMs);
  });
}
