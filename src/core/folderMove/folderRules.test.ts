import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { movedAcross } from "./folderRules";

/**
 * The ask these guard: a first mate that moves between a Windows PC and a Mac
 * keeps every saved folder location on a real place (docs/devices.md, "A home
 * on another system"). Each case names the system it arrives on, so both
 * directions run on every system the checks run on.
 */

const WINDOWS_DATA = "C:\\Users\\ada\\AppData\\Roaming\\infinitary";
const MAC_DATA = "/Users/ada/Library/Application Support/infinitary";

describe("a folder location saved on a Windows PC, read on a Mac", () => {
  const onMac = (value: string) => movedAcross(value, WINDOWS_DATA, MAC_DATA, posix);

  it("names the same place under the new folder, written with the Mac's slashes", () => {
    expect(onMac("C:\\Users\\ada\\AppData\\Roaming\\infinitary\\worktrees\\task-1")).toBe(
      "/Users/ada/Library/Application Support/infinitary/worktrees/task-1",
    );
    expect(onMac(WINDOWS_DATA)).toBe(MAC_DATA);
  });

  it("reads either slash and any letter case, as a Windows disk does", () => {
    expect(onMac("c:/users/ada/appdata/roaming/infinitary/crewmates/Task-1/one.jsonl")).toBe(
      "/Users/ada/Library/Application Support/infinitary/crewmates/Task-1/one.jsonl",
    );
  });

  it("leaves a location that is not inside the folder", () => {
    // Beside it with a name that starts the same way, above it, on another disk, and on another system.
    expect(onMac("C:\\Users\\ada\\AppData\\Roaming\\infinitary-dev\\fleet\\site")).toBeUndefined();
    expect(onMac("C:\\Users\\ada\\AppData\\Roaming")).toBeUndefined();
    expect(onMac("D:\\Users\\ada\\AppData\\Roaming\\infinitary\\fleet")).toBeUndefined();
    expect(onMac("/Users/ada/Library/Application Support/infinitary/fleet")).toBeUndefined();
  });

  it("leaves a sentence that mentions the folder", () => {
    expect(
      onMac("Look in C:\\Users\\ada\\AppData\\Roaming\\infinitary\\fleet for it."),
    ).toBeUndefined();
  });
});

describe("a folder location saved on a Mac, read on a Windows PC", () => {
  const onWindows = (value: string) => movedAcross(value, MAC_DATA, WINDOWS_DATA, win32);

  it("names the same place under the new folder, written with Windows' slashes", () => {
    expect(onWindows("/Users/ada/Library/Application Support/infinitary/worktrees/task-1")).toBe(
      "C:\\Users\\ada\\AppData\\Roaming\\infinitary\\worktrees\\task-1",
    );
  });

  it("leaves a folder beside it whose name starts the same way", () => {
    expect(
      onWindows("/Users/ada/Library/Application Support/infinitary-dev/fleet/site"),
    ).toBeUndefined();
  });
});
