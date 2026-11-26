// The app's own git (git integration phase 2, docs/forge.md "The app's own
// git"): dugite-native's macOS git, for BOTH architectures, unpacked under
// vendor/git/darwin-<arch>/ so the universal build ships the two side by
// side (electron-builder.yml extraResources, the trees named by
// mac.x64ArchFiles) and an unpackaged checkout runs the same git
// (src/core/workspace/bundledGit.ts).
//
// The version is dugite's: its script/embedded-git.json names each
// platform's archive and checksum, so pinning dugite in package.json pins
// the git the app ships. dugite's own postinstall is switched off
// (pnpm-workspace.yaml allowBuilds) because it fetches only the machine's
// own architecture into node_modules, which a universal build cannot use.
//
// Each archive is verified against that checksum before anything is
// unpacked, cached under ~/Library/Caches so a second checkout or a
// reinstall costs no download (or in the folder INFINITARY_BUNDLED_GIT_CACHE
// names, which CI keeps in its own cache: .github/actions/electron-download),
// and unpacked once, beside it, into a tree
// that every working copy then clones (scripts/clone-or-copy.ts): on APFS
// the copies share that tree's blocks instead of each holding its own 55 MB,
// and a disk that cannot clone gets a plain copy. Both the cached tree and
// each working copy's are built in a sibling directory that is renamed into
// place only when complete. A tree whose stamp names the pinned archive is
// left alone, so a repeat install does no work.
//
// What is kept: git itself (bin/, the git-* programs, scalar, mergetools,
// share/, etc/). What is not: Git Credential Manager and the .NET runtime
// it brings (about 110 MB an architecture) - another sign-in that could
// answer or prompt for a host under the app, which the owner ruled out
// (one sign-in path, the app's) - and git-lfs, which nothing under the app
// configures; a person who set LFS up has their own on the search path,
// and the app's git still finds it there.
//
// It also builds the launcher a crewmate's shell runs that git through,
// vendor/git-bin/git (scripts/build-git-launcher.ts).
//
// Elsewhere than macOS this does nothing: a Linux package requires the
// system's git (docs/linux-packages.md, "Git"), and an unpackaged checkout
// without the trees runs the system git.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { ensureGitLauncher } from "./build-git-launcher.ts";
import { cloneOrCopy } from "./clone-or-copy.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ARCHES = ["arm64", "x64"] as const;
export type Arch = (typeof ARCHES)[number];

/** One platform's archive in dugite's manifest. */
export type ManifestEntry = { name: string; url: string; checksum: string };
const STAMP = ".infinitary-source";
/** The stamp Firstmate 3000's tooling wrote before the rename: a tree it placed still counts. */
const OLDER_STAMP = ".fm3000-source";

export function manifestEntry(arch: Arch, cwd: string = root): ManifestEntry {
  const require = createRequire(join(cwd, "package.json"));
  const manifest = JSON.parse(
    readFileSync(
      join(dirname(require.resolve("dugite/package.json")), "script", "embedded-git.json"),
      "utf8",
    ),
  ) as Record<string, Partial<ManifestEntry> | undefined>;
  const entry = manifest[`darwin-${arch}`];
  if (!entry?.url || !entry?.checksum || !entry?.name) {
    throw new Error(`dugite's embedded-git.json names no macOS ${arch} archive`);
  }
  return { name: entry.name, url: entry.url, checksum: entry.checksum };
}

/** Whether a name directly under libexec/git-core is git's own (see the header). */
export function isGitCoreEntry(name: string): boolean {
  if (name === "git-lfs" || name.startsWith("git-credential-manager")) return false;
  return name === "git" || name.startsWith("git-") || name === "scalar" || name === "mergetools";
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

async function cachedArchive(entry: ManifestEntry, cacheDir: string): Promise<string> {
  mkdirSync(cacheDir, { recursive: true });
  const file = join(cacheDir, entry.name);
  if (existsSync(file) && (await sha256(file)) === entry.checksum) return file;
  rmSync(file, { force: true });
  console.log(`[infinitary] downloading the app's git: ${entry.name}`);
  const response = await fetch(entry.url, { headers: { Accept: "application/octet-stream" } });
  if (!response.ok || !response.body) {
    throw new Error(`${entry.url} answered ${response.status}`);
  }
  const partial = `${file}.${process.pid}.partial`;
  await pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
    createWriteStream(partial),
  );
  const actual = await sha256(partial);
  if (actual !== entry.checksum) {
    rmSync(partial, { force: true });
    throw new Error(`${entry.name} checksum ${actual}, expected ${entry.checksum}`);
  }
  renameSync(partial, file);
  return file;
}

function isStamped(tree: string, entry: ManifestEntry): boolean {
  return [STAMP, OLDER_STAMP].some((name) => {
    const stamp = join(tree, name);
    return (
      existsSync(stamp) && readFileSync(stamp, "utf8").trim() === `${entry.name} ${entry.checksum}`
    );
  });
}

export function unpackTree(archive: string, entry: ManifestEntry, target: string): void {
  // The cached tree is shared by every working copy, and two installs may
  // unpack it at once: each works in its own partial directory.
  const partial = `${target}.${process.pid}.partial`;
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true });
  const untar = spawnSync("/usr/bin/tar", ["-xzf", archive, "-C", partial], { stdio: "inherit" });
  if (untar.status !== 0) throw new Error(`could not unpack ${archive}`);
  const core = join(partial, "libexec", "git-core");
  for (const name of readdirSync(core)) {
    if (!isGitCoreEntry(name)) rmSync(join(core, name), { recursive: true, force: true });
  }
  writeFileSync(join(partial, STAMP), `${entry.name} ${entry.checksum}\n`);
  try {
    renameSync(partial, target);
  } catch (error) {
    // Another install placed the same tree meanwhile and a working copy may
    // be cloning it, so it stays; only a stale or broken tree is replaced.
    if (isStamped(target, entry)) {
      rmSync(partial, { recursive: true, force: true });
      return;
    }
    if (!existsSync(target)) throw error;
    rmSync(target, { recursive: true, force: true });
    renameSync(partial, target);
  }
}

export function cachedTreeDir(entry: ManifestEntry, cacheDir: string): string {
  return join(cacheDir, "trees", entry.name.replace(/\.tar\.gz$/, ""));
}

export async function ensureBundledGit({
  vendorDir = join(root, "vendor", "git"),
  cacheDir = process.env.INFINITARY_BUNDLED_GIT_CACHE ||
    join(homedir(), "Library", "Caches", "infinitary", "bundled-git"),
  entryFor = manifestEntry,
}: {
  vendorDir?: string;
  cacheDir?: string;
  /** The archive to place for `arch`; dugite's manifest unless a test names one. */
  entryFor?: (arch: Arch) => ManifestEntry;
} = {}): Promise<void> {
  for (const arch of ARCHES) {
    const entry = entryFor(arch);
    const target = join(vendorDir, `darwin-${arch}`);
    if (isStamped(target, entry)) continue;
    const tree = cachedTreeDir(entry, cacheDir);
    if (!isStamped(tree, entry)) unpackTree(await cachedArchive(entry, cacheDir), entry, tree);
    const partial = `${target}.partial`;
    rmSync(partial, { recursive: true, force: true });
    mkdirSync(vendorDir, { recursive: true });
    cloneOrCopy(tree, partial);
    rmSync(target, { recursive: true, force: true });
    renameSync(partial, target);
    console.log(`[infinitary] the app's git for ${arch} is in ${target}`);
  }
}

// Elsewhere than macOS this ends by itself, never through process.exit: on
// Windows, Node 24 aborts on an exit this early in a TypeScript script (an
// assertion in libuv, in most runs), and that status failed the whole install
// (tests/bundled-git-step.test.ts).
if (process.argv[1] === fileURLToPath(import.meta.url) && process.platform === "darwin") {
  ensureBundledGit().catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(
      `[infinitary] the app's git could not be prepared (${reason}). ` +
        "A packaged build cannot ship without it - check network access and re-run `pnpm install`.",
    );
    process.exit(1);
  });
  try {
    ensureGitLauncher();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(
      `[infinitary] the app's git launcher could not be built (${reason}). ` +
        "A packaged build cannot ship without it - re-run `pnpm install`.",
    );
    process.exit(1);
  }
}
