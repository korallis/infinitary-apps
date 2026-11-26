import { spawn } from "node:child_process";
import { join } from "node:path";
import { hostEnv } from "./hostEnv";

/**
 * Ends a program and every program under it on Windows, by force. Windows
 * has no process group to signal, and ending a program there leaves the
 * programs it started running; its own taskkill ends the whole tree.
 * `fallback` runs where taskkill itself cannot start.
 */
export function endWindowsTree(pid: number, fallback: () => void): void {
  const root = process.env.SystemRoot ?? "C:\\Windows";
  const kill = spawn(join(root, "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(pid)], {
    env: hostEnv(),
    stdio: "ignore",
    windowsHide: true,
  });
  kill.once("error", fallback);
}
