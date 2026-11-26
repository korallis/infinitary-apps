import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { endWindowsTree } from "./windowsTree";

// Integration budget (docs/test-cohorts.md): real programs and Windows' own taskkill.
vi.setConfig({ testTimeout: 30_000 });

describe.runIf(process.platform === "win32")("ending a program's tree on Windows", () => {
  /**
   * A program that starts another under it; both write down their process
   * numbers and wait. The second is started detached: Node ends a program's
   * own with it otherwise, and ending the first alone would look like
   * ending the tree.
   */
  function tree() {
    const dir = scratchDir("infinitary-windows-tree-");
    const log = join(dir, "started.log");
    const script = join(dir, "tree.cjs");
    writeFileSync(
      script,
      `require("node:fs").appendFileSync(${JSON.stringify(log)}, process.pid + "\\n");
if (process.argv[2] === "top") {
  require("node:child_process").spawn(process.execPath, [__filename], { stdio: "ignore", detached: true, windowsHide: true });
}
setTimeout(() => {}, 600000);
`,
    );
    const top = spawn(process.execPath, [script, "top"], { stdio: "ignore", windowsHide: true });
    const started = () =>
      existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(Number) : [];
    const running = () =>
      started().filter((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
    const end = () => {
      for (const pid of started()) {
        try {
          process.kill(pid);
        } catch {
          // Already ended, as the test expects.
        }
      }
    };
    const bothStarted = () =>
      vi.waitFor(() => expect(started()).toHaveLength(2), { timeout: 20_000, interval: 100 });
    return { pid: top.pid as number, running, end, bothStarted };
  }

  it("ends the program and the one under it, and answers that it did", async () => {
    const programs = tree();
    try {
      await programs.bothStarted();
      const fallback = vi.fn();
      expect(await endWindowsTree(programs.pid, fallback)).toBe(true);
      expect(fallback).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(programs.running()).toEqual([]), {
        timeout: 10_000,
        interval: 100,
      });
    } finally {
      programs.end();
    }
  });

  it("runs the fallback, and answers that the tree was not ended, when the program had already ended", async () => {
    const ended = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
    await new Promise((resolve) => ended.once("exit", resolve));
    const fallback = vi.fn();
    expect(await endWindowsTree(ended.pid as number, fallback)).toBe(false);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("runs the fallback when Windows does not answer in the time it is given", async () => {
    const programs = tree();
    try {
      await programs.bothStarted();
      const fallback = vi.fn();
      // No program starts and ends inside one millisecond.
      expect(await endWindowsTree(programs.pid, fallback, 1)).toBe(false);
      expect(fallback).toHaveBeenCalledTimes(1);
    } finally {
      programs.end();
    }
  });
});
