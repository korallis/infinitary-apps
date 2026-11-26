import { chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { windowsProgram } from "./userBin";

function folderWith(...files: string[]): string {
  const dir = scratchDir("infinitary-user-bin-");
  for (const file of files) {
    writeFileSync(join(dir, file), "");
    chmodSync(join(dir, file), 0o755);
  }
  return dir;
}

describe("the file Windows starts for a program's name", () => {
  it("is the batch file beside the shim a Git Bash runs, never the shim", () => {
    const npm = folderWith("pnpm", "pnpm.cmd", "pnpm.ps1");
    expect(windowsProgram("pnpm", { PATH: npm, PATHEXT: ".COM;.EXE;.BAT;.CMD" })).toBe(
      join(npm, "pnpm.cmd"),
    );
  });

  it("is the first search-path folder's, by the first ending Windows runs a program by", () => {
    const empty = folderWith();
    const both = folderWith("pnpm.cmd", "pnpm.exe");
    const later = folderWith("pnpm.com");
    const env = { PATH: [empty, both, later].join(";"), PATHEXT: ".COM;.EXE;.BAT;.CMD" };
    expect(windowsProgram("pnpm", env)).toBe(join(both, "pnpm.exe"));
    expect(windowsProgram("pnpm", { ...env, PATHEXT: ".CMD;.EXE" })).toBe(join(both, "pnpm.cmd"));
  });

  it("passes over an ending the app cannot start, wherever the environment lists it", () => {
    const npm = folderWith("pnpm.cmd", "pnpm.ps1", "pnpm.js");
    expect(windowsProgram("pnpm", { PATH: npm, PATHEXT: ".PS1;.JS;.CMD;.EXE" })).toBe(
      join(npm, "pnpm.cmd"),
    );
  });

  // Two drives have no relative path between them.
  it.skipIf(isAbsolute(relative(process.cwd(), tmpdir())))(
    "passes over a folder the search path names by a relative path",
    () => {
      const here = relative(process.cwd(), folderWith("pnpm.cmd"));
      const whole = folderWith("pnpm.cmd");
      expect(windowsProgram("pnpm", { PATH: here })).toBe(undefined);
      expect(windowsProgram("pnpm", { PATH: [".", here, whole].join(";") })).toBe(
        join(whole, "pnpm.cmd"),
      );
    },
  );

  it("reads the endings Windows ships with when the environment names none", () => {
    const dir = folderWith("pnpm.cmd");
    expect(windowsProgram("pnpm", { PATH: dir })).toBe(join(dir, "pnpm.cmd"));
  });

  it("is nothing when no folder holds the program under an ending Windows runs", () => {
    const shimOnly = folderWith("pnpm", "pnpm.ps1");
    expect(windowsProgram("pnpm", { PATH: shimOnly, PATHEXT: ".COM;.EXE;.BAT;.CMD" })).toBe(
      undefined,
    );
    expect(windowsProgram("pnpm", {})).toBe(undefined);
  });
});
