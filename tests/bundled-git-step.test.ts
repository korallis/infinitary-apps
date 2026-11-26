import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Intent: the project's postinstall runs whole on a Windows PC. Its step for
 * the app's own git (scripts/ensure-bundled-git.ts) has work only on a Mac.
 * Elsewhere it left through process.exit(0) as soon as it started, and on
 * Windows Node 24 aborted there in most runs, so the step's status failed the
 * install.
 *
 * This runs the step as the install does, as its own process, and reads the
 * status it ends with.
 */

const step = join(__dirname, "..", "scripts", "ensure-bundled-git.ts");

// On a Mac the step fetches and places the app's git (tests/install-clones.test.ts).
describe.skipIf(process.platform === "darwin")("the install's own git step, off macOS", () => {
  it("ends with status 0", () => {
    // The abort was a race that a single run could miss.
    for (let run = 1; run <= 3; run += 1) {
      const ended = spawnSync(process.execPath, [step], { encoding: "utf8" });
      expect({ status: ended.status, signal: ended.signal }, `run ${run}: ${ended.stderr}`).toEqual(
        { status: 0, signal: null },
      );
    }
  });
});
