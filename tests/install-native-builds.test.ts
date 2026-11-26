import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadYamlFile } from "./helpers/releaseWorkflows";

/**
 * Intent: a fresh install finishes on a computer with no C++ toolchain, such
 * as a Windows PC without Visual Studio's build tools, where the install
 * failed in node-gyp before the project's own postinstall ran.
 *
 * pnpm builds an installed package it is allowed to build
 * (pnpm-workspace.yaml's allowBuilds). For a package with a binding.gyp and
 * neither an install nor a preinstall script, that build is pnpm's own
 * `node-gyp rebuild`, and node-gyp looks for a compiler before it reads the
 * binding.gyp, so the install fails without one even when the file would
 * compile nothing.
 */

const root = join(__dirname, "..");
const store = join(root, "node_modules", ".pnpm");

type Manifest = { name: string; scripts?: Record<string, string> };

/** Each installed package's own folder: pnpm keeps it beside links to what it needs. */
function installedPackages(): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(store)) {
    const modules = join(store, entry, "node_modules");
    if (entry === "node_modules" || !existsSync(modules)) continue;
    for (const name of readdirSync(modules)) {
      const inside = name.startsWith("@")
        ? readdirSync(join(modules, name)).map((scoped) => join(modules, name, scoped))
        : [join(modules, name)];
      // A link is another package's folder; lstat leaves it unfollowed.
      found.push(...inside.filter((dir) => lstatSync(dir).isDirectory()));
    }
  }
  return found;
}

function buildsWithNodeGyp(dir: string): boolean {
  if (!existsSync(join(dir, "binding.gyp"))) return false;
  const { scripts = {} } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
  return scripts.install === undefined && scripts.preinstall === undefined;
}

const nameOf = (dir: string) =>
  (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest).name;

describe("the builds an install is allowed", () => {
  it("leave out each package pnpm would build with its own node-gyp rebuild", () => {
    const allowBuilds = loadYamlFile("pnpm-workspace.yaml").allowBuilds as Record<string, unknown>;
    const built = [...new Set(installedPackages().filter(buildsWithNodeGyp).map(nameOf))];
    // A walk that found no such package would pass the loop below unchecked.
    expect(built).toContain("better-sqlite3");
    for (const name of built) {
      expect(allowBuilds[name], `pnpm would run node-gyp rebuild for ${name}`).toBe(false);
    }
  });
});
