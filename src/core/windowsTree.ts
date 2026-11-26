import { spawn } from "node:child_process";
import { join } from "node:path";
import { hostEnv } from "./hostEnv";

/** taskkill ends a tree in well under a second; one that takes this long is stuck. */
const TASKKILL_LIMIT_MS = 10_000;

/** A program Windows ships in its own folder, by its whole path: never one a search path picks. */
export function windowsSystemProgram(name: string): string {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);
}

/**
 * Ends a program and every program under it on Windows, by force. Windows
 * has no process group to signal, and ending a program there leaves the
 * programs it started running; its own taskkill ends the whole tree, and
 * only while the program at its top still runs, since it finds the others
 * through it.
 *
 * Answers true once taskkill has ended the tree. Where taskkill cannot
 * start, exits with a failure (the program had already ended, or one under
 * it could not be ended) or does not answer in `limitMs`, `fallback` runs
 * and the answer is false.
 */
export function endWindowsTree(
  pid: number,
  fallback: () => void,
  limitMs = TASKKILL_LIMIT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (ended: boolean): void => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      if (!ended) {
        try {
          fallback();
        } catch {
          // The program had already ended.
        }
      }
      resolve(ended);
    };
    const kill = spawn(windowsSystemProgram("taskkill.exe"), ["/F", "/T", "/PID", String(pid)], {
      env: hostEnv(),
      stdio: "ignore",
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      kill.kill();
      answer(false);
    }, limitMs);
    kill.once("error", () => answer(false));
    kill.once("exit", (code) => answer(code === 0));
  });
}
