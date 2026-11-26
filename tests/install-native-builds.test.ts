import { describe, expect, it } from "vitest";
import { loadYamlFile } from "./helpers/releaseWorkflows";

/**
 * Intent: a fresh install finishes on a computer with no C++ toolchain, such
 * as a Windows PC without Visual Studio's build tools, where the install
 * failed in node-gyp before the project's own postinstall ran.
 *
 * pnpm builds an installed package it is allowed to build
 * (pnpm-workspace.yaml's allowBuilds). better-sqlite3 has a binding.gyp and
 * neither an install nor a preinstall script, so that build is pnpm's own
 * `node-gyp rebuild`, and node-gyp looks for a compiler before it reads the
 * binding.gyp: the install fails without one even though the file compiles
 * nothing beside the build the package carries for each system.
 */

describe("the builds an install is allowed", () => {
  it("leave out better-sqlite3, which pnpm would build with its own node-gyp rebuild", () => {
    const workspace = loadYamlFile("pnpm-workspace.yaml") as {
      allowBuilds?: Record<string, unknown>;
    };
    expect(workspace.allowBuilds?.["better-sqlite3"]).toBe(false);
  });
});
