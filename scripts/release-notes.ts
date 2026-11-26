/**
 * The release-notes ledger, from the command line (docs/release-notes.md).
 * The producer is `src/core/releaseNotes/catalog.ts`; this file reads the
 * repository and git, hands the facts over, and writes what comes back.
 * Nothing here publishes, tags or signs. Plain Node 24 type stripping, no
 * install: the release workflow runs it before anything else is set up.
 *
 *   node scripts/release-notes.ts validate
 *     The ledger's own consistency: schema, unique ids, references, promotion
 *     mappings, each entry's area and hero picture (or its reason for none)
 *     and the picture files themselves, and that every committed manifest
 *     still equals what its source commit contains. Exits 1 with every
 *     problem. Its git-free part is `ledgerProblems`, which `change` runs.
 *
 *   node scripts/release-notes.ts change --base <ref>
 *     The pull request's own check, under a second, with no install and only
 *     the base commit fetched: the commits since the merge base of <ref> and
 *     HEAD add a file under release-notes/changes/ declaring a note or an
 *     exclusion - the file that credits the change's squash commit at the next
 *     alpha - and the ledger passes `ledgerProblems`. ci.yml runs it first.
 *
 *   node scripts/release-notes.ts batch --base <ref>
 *     A batch pull request's check (batch-checks.yml's notes job), with full
 *     history: each commit since the merge base of <ref> and HEAD - one per
 *     approved change the batch combined - is covered by a note or an
 *     exclusion as `check` counts it for the alpha, and the ledger passes
 *     `ledgerProblems`. A branch built on a batch's version, as a held
 *     batch's fix is, skips `change` in its own check (ci.yml), so the batch
 *     is where its note is read.
 *
 *   node scripts/release-notes.ts check --source <sha> [--channel alpha|stable]
 *       [--version <v>] [--promoted-from <alpha>] [--reviewed <sha>] [--rehearsal]
 *     Everything a release needs before it verifies or signs: the validation
 *     above, a record for every published release before this one, the
 *     candidate match (alpha: `--reviewed` is the candidate, the commit the
 *     release crewmate committed its review on), and that every source change
 *     since the previous release has a note or a reviewed exclusion. A stable
 *     promotion instead proves its editorial source equals its alpha's. An
 *     exact-main cut (`--verified-main`), a promotion, and a `--rehearsal`
 *     that names no candidate read past releases from their tags instead of
 *     requiring their records.
 *
 *   node scripts/release-notes.ts installer-source --source <sha> --main <sha>
 *     Print the merged signing source or an empty source for an unaffected alpha.
 *   node scripts/release-notes.ts desktop-changes --source <sha>
 *     What a rolling alpha at the source would ship that the previous release
 *     did not: that release and the changed paths on the desktop build list
 *     (scripts/desktop-build.ts), as JSON. release.yml's resolve job reads it.
 *
 *   node scripts/release-notes.ts generate --version <v> --source <sha> --out <file>
 *     The offline catalog one release packages, with its highlights' hero
 *     pictures in release-notes/pictures/ beside it. `generate --dev --out
 *     <file>` writes the placeholder every non-release build carries.
 *
 *   node scripts/release-notes.ts stable-highlights --catalog <file> [--picks <id>,<id>,<id>]
 *     A stable promotion's highlights (docs/alpha.md "Promoting an alpha").
 *     Lists the changes since the last stable that the captain picks them
 *     from, with the rank each alpha review gave; with `--picks`, rewrites
 *     the catalog `generate` wrote so those are its only highlights, lead
 *     first, with their hero pictures beside it. release.yml runs it from the
 *     workflow's own commit, over a catalog the alpha's own tooling built.
 *
 *   node scripts/release-notes.ts manifest --version <v> [--highlights <ids>] [--write]
 *     The immutable manifest of a published release, derived from its tag. A
 *     promoted stable's record keeps its picked highlights, as its private
 *     release names them. While this history is the one the record of past
 *     releases archives, writing a manifest pins that record again with it.
 *
 *   node scripts/release-notes.ts verify-package --catalog <file> --version <v> --source <sha>
 *     The packaged catalog is this exact version and source commit, and each
 *     hero picture beside it is the file the catalog hashed.
 *
 *   node scripts/release-notes.ts archive [--repository <owner/name>] [--write]
 *     The record of past releases (release-notes/archive.json), pinned from
 *     the full history: every published release's manifest by its hash, and
 *     the newest version each channel published. `--repository` names where
 *     that history lives the first time. A checkout that starts a
 *     fresh history from that tree checks those releases by their hashes and
 *     numbers every new one above them (docs/release-notes.md "A fresh
 *     history").
 *
 * `--repo <dir>` points at another checkout (the tests do).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readPicture } from "../src/core/pictureFormat.ts";
import { printErrors } from "./github-errors.ts";
import {
  ARCHIVE_FILE,
  archiveOf,
  archiveProblems,
  buildCatalog,
  type CatalogPicture,
  coveredCommits,
  entryCommits,
  heroFiles,
  highlightCandidates,
  type LedgerFile,
  membership,
  type NoteEntry,
  PACKAGED_PICTURES_DIR,
  PICTURES_DIR,
  parseArchive,
  parseManifest,
  parseNoteFile,
  pickHighlights,
  pictureProblems,
  type ReleaseArchive,
  type ReleaseManifest,
  recordedHighlightProblems,
  uncoveredCommits,
  unreachableNotes,
  validateLedger,
  verifyCatalog,
} from "../src/core/releaseNotes/catalog.ts";
import { compareSemver, isAlphaVersion, isStableVersion, parseSemver } from "../src/shared/semver.ts";
import { isRegenerated } from "./batch-regenerate.ts";
import { isDesktopPath, signedInstallerChanges } from "./desktop-build.ts";

const NOTES_DIR = "release-notes";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

class Refusal extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(problems.join("\n"));
    this.problems = problems;
  }
}

function args(argv: string[]): { command: string; flags: Map<string, string | true> } {
  const [command = "", ...rest] = argv;
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i] as string;
    if (!flag.startsWith("--")) throw new Refusal([`unexpected argument "${flag}"`]);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) flags.set(flag.slice(2), true);
    else {
      flags.set(flag.slice(2), next);
      i += 1;
    }
  }
  return { command, flags };
}

function need(flags: Map<string, string | true>, name: string): string {
  const value = flags.get(name);
  if (typeof value !== "string") throw new Refusal([`--${name} is required`]);
  return value;
}

class Repo {
  private readonly ancestorCache = new Map<string, Set<string>>();
  private added: Map<string, string> | null = null;
  private tagCache: { version: string; commit: string }[] | null = null;

  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  git(...args: string[]): string {
    return this.gitRaw(...args).trim();
  }

  changedPaths(from: string, to: string): string[] {
    return this.gitRaw("diff", "--name-only", "--no-renames", "-z", from, to, "--")
      .split("\0")
      .filter(Boolean);
  }

  /** A file's text at a commit, or null where the commit has no such file. */
  fileAt(commit: string, path: string): string | null {
    if (this.gitRaw("ls-tree", "--name-only", "-z", commit, "--", path) === "") return null;
    return this.gitRaw("show", `${commit}:${path}`);
  }

  private gitRaw(...args: string[]): string {
    try {
      return execFileSync("git", args, {
        cwd: this.root,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const stderr = (error as { stderr?: Buffer | string }).stderr?.toString().trim();
      throw new Refusal([`git ${args.join(" ")} failed: ${stderr ?? String(error)}`]);
    }
  }

  assertFullHistory(): void {
    if (this.git("rev-parse", "--is-shallow-repository") === "true")
      throw new Refusal(["the checkout is shallow; fetch full history and tags (fetch-depth: 0)"]);
  }

  resolve(rev: string): string {
    return this.git("rev-parse", "--verify", `${rev}^{commit}`);
  }

  /** Whether this checkout shares history with the commit, not just its objects. */
  sharesHistory(commit: string): boolean {
    try {
      this.git("merge-base", "HEAD", commit);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether a release at `commit` stands on `source`'s history: an ancestor
   * of it, or a release candidate off one - a commit that changes nothing
   * but the notes since the history the two share (docs/alpha.md).
   */
  standsOn(commit: string, source: string): boolean {
    if (this.ancestors(source).has(commit)) return true;
    let base: string;
    try {
      base = this.git("merge-base", commit, source);
    } catch {
      return false;
    }
    return this.changedPaths(base, commit).every((path) => path.startsWith(`${NOTES_DIR}/`));
  }

  ancestors(commit: string): Set<string> {
    let set = this.ancestorCache.get(commit);
    if (!set) {
      set = new Set(this.git("rev-list", commit).split("\n").filter(Boolean));
      this.ancestorCache.set(commit, set);
    }
    return set;
  }

  /**
   * The commit that first added `path`, or null when history does not show one.
   * One pass over the notes' history answers every path: one lookup per note
   * file took minutes once the ledger held thousands. No rename detection, so
   * a renamed note counts as added where it took its new name, as a lookup of
   * that one path saw it.
   */
  addedBy = (path: string): string | null => {
    if (!this.added) {
      this.added = new Map();
      let commit = "";
      const out = this.git(
        "log",
        "--diff-filter=A",
        "--no-renames",
        "--name-only",
        "--format=%x00%H",
        "HEAD",
        "--",
        `${NOTES_DIR}/`,
      );
      // Newest first, so the oldest commit that added a path is written last.
      for (const line of out.split("\n")) {
        if (line.startsWith("\0")) commit = line.slice(1);
        else if (line) this.added.set(line, commit);
      }
    }
    return this.added.get(path) ?? null;
  };

  date(commit: string): string {
    return this.git("log", "-1", "--format=%cs", commit);
  }

  tags(): { version: string; commit: string }[] {
    if (this.tagCache) return this.tagCache;
    const out: { version: string; commit: string }[] = [];
    for (const tag of this.git("tag", "--list", "v*").split("\n").filter(Boolean)) {
      const version = tag.slice(1);
      const parsed = parseSemver(version);
      if (!parsed || parsed.build.length > 0) continue;
      out.push({ version, commit: this.resolve(tag) });
    }
    this.tagCache = out;
    return out;
  }

  /**
   * Whether a commit is a merge batch's regenerated commit (docs/testing.md,
   * "The swept batch"): it carries the trailer scripts/batch-regenerate.ts
   * words it with, and every file it changes is marked generated by the
   * .gitattributes of the version it builds on. No crewmate wrote it, and
   * the changes whose sources it follows carry their own notes.
   */
  regenerated(sha: string): boolean {
    if (!isRegenerated(this.git("log", "-1", "--format=%B", sha))) return false;
    const parents = this.git("rev-list", "--parents", "-n", "1", sha).split(" ").slice(1);
    if (parents.length !== 1) return false;
    const files = this.changedPaths(parents[0] as string, sha);
    if (files.length === 0) return false;
    const answer = this.gitRaw(
      "check-attr",
      "-z",
      `--source=${parents[0]}`,
      "linguist-generated",
      "--",
      ...files,
    ).split("\0");
    const values = answer.filter((_, place) => place % 3 === 2);
    return values.length === files.length && values.every((value) => value === "set" || value === "true");
  }

  /** Non-merge commits in (since, until], newest first. */
  commits(since: string | null, until: string): { sha: string; subject: string }[] {
    const range = since ? `${since}..${until}` : until;
    return this.git("log", "--no-merges", "--format=%H%x09%s", range)
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha = "", ...subject] = line.split("\t");
        return { sha, subject: subject.join("\t") };
      });
  }
}

type Loaded = {
  files: LedgerFile[];
  manifests: { path: string; manifest: ReleaseManifest }[];
  archive: ReleaseArchive | null;
  /** Each manifest file's SHA-256, by version. */
  hashes: Map<string, string>;
};

function jsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(dir, name));
}

function load(repo: { root: string }): Loaded {
  const problems: string[] = [];
  const read = (absolute: string): unknown => {
    try {
      return JSON.parse(readFileSync(absolute, "utf8"));
    } catch (error) {
      problems.push(`${absolute.slice(repo.root.length + 1)}: not valid JSON (${String(error)})`);
      return undefined;
    }
  };
  const files: LedgerFile[] = [];
  for (const [folder, selfCovering] of [
    ["changes", true],
    ["history", false],
  ] as const) {
    for (const absolute of jsonFiles(join(repo.root, NOTES_DIR, folder))) {
      const path = `${NOTES_DIR}/${folder}/${basename(absolute)}`;
      const value = read(absolute);
      if (value === undefined) continue;
      const parsed = parseNoteFile(value, path);
      problems.push(...parsed.problems);
      files.push({ path, file: parsed.file, selfCovering });
    }
  }
  const manifests: Loaded["manifests"] = [];
  const hashes = new Map<string, string>();
  for (const absolute of jsonFiles(join(repo.root, NOTES_DIR, "releases"))) {
    const path = `${NOTES_DIR}/releases/${basename(absolute)}`;
    const value = read(absolute);
    if (value === undefined) continue;
    const parsed = parseManifest(value, path);
    problems.push(...parsed.problems);
    if (parsed.manifest) {
      if (path !== `${NOTES_DIR}/releases/${parsed.manifest.version}.json`)
        problems.push(`${path}: a manifest is named for its version`);
      manifests.push({ path, manifest: parsed.manifest });
      hashes.set(parsed.manifest.version, sha256(readFileSync(absolute)));
    }
  }
  let archive: ReleaseArchive | null = null;
  const archivePath = join(repo.root, ARCHIVE_FILE);
  if (existsSync(archivePath)) {
    const value = read(archivePath);
    if (value !== undefined) {
      const parsed = parseArchive(value, ARCHIVE_FILE);
      problems.push(...parsed.problems);
      archive = parsed.archive;
    }
  }
  if (problems.length > 0) throw new Refusal(problems);
  return { files, manifests, archive, hashes };
}

const detachedCache = new WeakMap<Loaded, Map<string, ReleaseManifest>>();

/** The pinned manifests whose source history is not the checkout's own. */
function detachedReleases(repo: Repo, loaded: Loaded): Map<string, ReleaseManifest> {
  const cached = detachedCache.get(loaded);
  if (cached) return cached;
  const detached = new Map<string, ReleaseManifest>();
  if (loaded.archive)
    for (const { manifest } of loaded.manifests)
      if (Object.hasOwn(loaded.archive.releases, manifest.version) && !repo.sharesHistory(manifest.sourceCommit))
        detached.set(manifest.version, manifest);
  detachedCache.set(loaded, detached);
  return detached;
}

/** Whether the most recently archived history is not the one being built. */
function freshHistory(repo: Repo, loaded: Loaded): boolean {
  return loaded.archive !== null && detachedReleases(repo, loaded).has(loaded.archive.stable);
}

/**
 * Promotion origin: the published alpha a stable was built from, if any - on
 * the stable's own commit, or on its parent for a stable a release pull
 * request once tagged one commit above its alpha.
 */
function promotedFromTag(repo: Repo, version: string, source: string): string | null {
  if (parseSemver(version)?.prerelease.length !== 0) return null;
  const alphaAt = (commit: string) =>
    repo
      .tags()
      .filter((tag) => tag.commit === commit && isAlphaVersion(tag.version))
      .map((tag) => tag.version)
      .sort((a, b) => compareSemver(a, b) ?? 0)
      .at(-1) ?? null;
  const own = alphaAt(source);
  if (own) return own;
  try {
    return alphaAt(repo.resolve(`${source}^1`));
  } catch {
    return null;
  }
}

function derive(
  repo: Repo,
  loaded: Loaded,
  release: { version: string; sourceCommit: string; promotedFrom: string | null },
): ReleaseManifest {
  const commits = entryCommits(loaded.files, repo.addedBy);
  const entryIds = membership(commits, repo.ancestors(release.sourceCommit));
  // A fresh history's first commit takes the archived tree whole, so a
  // release on it carries everything the archived releases did, though the
  // commits their notes name are not here.
  const inherited = [...detachedReleases(repo, loaded).values()].flatMap((item) => item.entryIds);
  return {
    version: release.version,
    channel: isAlphaVersion(release.version) ? "alpha" : "stable",
    sourceCommit: release.sourceCommit,
    date: repo.date(release.sourceCommit),
    promotedFrom: release.promotedFrom,
    entryIds: inherited.length > 0 ? [...new Set([...entryIds, ...inherited])].sort() : entryIds,
  };
}

function publishedReleases(repo: Repo, loaded: Loaded): ReleaseManifest[] {
  const out = loaded.manifests.map((item) => item.manifest);
  const pinned = new Set(out.map((manifest) => manifest.version));
  for (const tag of repo.tags()) {
    if (pinned.has(tag.version)) continue;
    out.push(
      derive(repo, loaded, {
        version: tag.version,
        sourceCommit: tag.commit,
        promotedFrom: promotedFromTag(repo, tag.version, tag.commit),
      }),
    );
  }
  return out;
}

function heroReader(root: string): (file: string) => Buffer | null {
  return (file) => {
    const path = join(root, PICTURES_DIR, file);
    return existsSync(path) ? readFileSync(path) : null;
  };
}

/** Everything the ledger can be checked for without git: what the pull request's unit test runs. */
function staticProblems(root: string, loaded: Loaded): string[] {
  const manifests = loaded.manifests.map((item) => item.manifest);
  return [
    ...validateLedger(loaded),
    ...pictureProblems(loaded.files, heroReader(root)),
    ...(loaded.archive ? archiveProblems(loaded.archive, manifests, loaded.hashes) : []),
  ];
}

/**
 * The ledger checked without git history - schema, ids, references,
 * promotions, each entry's area and hero picture, and the picture files -
 * for the pull request's unit test over the real ledger. Every problem,
 * none thrown.
 */
export function ledgerProblems(root: string): string[] {
  try {
    return staticProblems(root, load({ root }));
  } catch (error) {
    if (error instanceof Refusal) return error.problems;
    throw error;
  }
}

function validate(repo: Repo, loaded: Loaded, extendingArchive = false): string[] {
  const problems = staticProblems(repo.root, loaded);
  problems.push(...unreachableNotes(loaded.files, repo.addedBy));
  const tags = new Map(repo.tags().map((tag) => [tag.version, tag.commit]));
  const detached = detachedReleases(repo, loaded);
  for (const { path, manifest } of loaded.manifests) {
    if (detached.has(manifest.version)) {
      // Its hash is checked above. A fetched tag may still name its archived
      // source, but this history cannot retag that published version.
      const tagged = tags.get(manifest.version);
      if (tagged !== undefined && tagged !== manifest.sourceCommit)
        problems.push(
          `${path}: v${manifest.version} was published from the archived history, so this history never tags it`,
        );
      continue;
    }
    if (!extendingArchive && loaded.archive && !freshHistory(repo, loaded) && !Object.hasOwn(loaded.archive.releases, manifest.version))
      problems.push(
        `${path}: the record of past releases does not list it; pin the record again with \`node scripts/release-notes.ts archive --write\``,
      );
    let source: string;
    try {
      source = repo.resolve(manifest.sourceCommit);
    } catch {
      problems.push(`${path}: source commit ${manifest.sourceCommit} is not in this checkout`);
      continue;
    }
    if (extendingArchive && !repo.sharesHistory(source)) {
      problems.push(`${path}: only an existing archive pin can attest to a source outside this history`);
      continue;
    }
    const tagged = tags.get(manifest.version);
    if (tagged !== undefined && tagged !== source)
      problems.push(`${path}: tag v${manifest.version} points at ${tagged}, not ${source}`);
    const expected = derive(repo, loaded, manifest);
    if (expected.entryIds.join("\n") !== manifest.entryIds.join("\n"))
      problems.push(
        `${path}: published membership changed; a published release is immutable (declare corrections on a new entry)`,
      );
  }
  return problems;
}

/**
 * A change - every commit since `--base`'s merge base with HEAD, squashed as
 * one at merge - adds a changes file declaring a note or an exclusion, and the
 * ledger it leaves is consistent. The squash commit is the commit that adds the
 * file, so this is the alpha's coverage rule for one change, before it merges.
 */
function change(repo: Repo, flags: Map<string, string | true>): string {
  const base = repo.git("merge-base", need(flags, "base"), "HEAD");
  const added = new Set(
    repo
      .git("diff", "--name-only", "--diff-filter=A", base, "HEAD", "--", `${NOTES_DIR}/changes/`)
      .split("\n")
      .filter((path) => path.endsWith(".json")),
  );
  const problems = ledgerProblems(repo.root);
  if (problems.length > 0) throw new Refusal(problems);
  const declared = load(repo).files.filter(
    (item) => added.has(item.path) && item.file.entries.length + item.file.exclusions.length > 0,
  );
  if (declared.length === 0)
    throw new Refusal([
      `this change adds no file under ${NOTES_DIR}/changes/ with a note or an exclusion.`,
      "Add a plain-language note for a change a person notices, or an exclusion with a reason for internal work, in a new file (docs/release-notes.md).",
    ]);
  return `this change adds ${declared.map((item) => item.path).join(", ")}, and the release-notes ledger is consistent`;
}

/**
 * A batch - one commit per approved change since `--base`'s merge base with
 * HEAD, kept as they are when it merges - leaves each commit covered by a note
 * or an exclusion, as the alpha's check counts it, and the ledger consistent:
 * `change` for every change of the batch at once, on the commits that reach
 * the default branch.
 */
function batch(repo: Repo, flags: Map<string, string | true>): string {
  repo.assertFullHistory();
  const base = repo.git("merge-base", need(flags, "base"), "HEAD");
  const problems = ledgerProblems(repo.root);
  if (problems.length > 0) throw new Refusal(problems);
  // The batch's regenerated commit is no change of its own.
  const range = repo.commits(base, "HEAD").filter((commit) => !repo.regenerated(commit.sha));
  const missing = uncoveredCommits(range, coveredCommits(load(repo).files, repo.addedBy));
  if (missing.length > 0)
    throw new Refusal([
      `this batch's changes below add no file under ${NOTES_DIR}/changes/ with a note or an exclusion (${missing.length} of ${range.length}):`,
      ...missing.map((commit) => `  ${commit.sha.slice(0, 12)} ${commit.subject}`),
      "Add a plain-language note for a change a person notices, or an exclusion with a reason for internal work, in a new file on that change's branch (docs/release-notes.md).",
    ]);
  return `each of this batch's ${range.length} change(s) adds its note or exclusion, and the release-notes ledger is consistent`;
}

function previousRelease(
  repo: Repo,
  loaded: Loaded,
  version: string | null,
  source: string,
): { version: string; commit: string } | null {
  const known = new Map<string, string>();
  const detached = detachedReleases(repo, loaded);
  for (const tag of repo.tags()) known.set(tag.version, tag.commit);
  for (const { manifest } of loaded.manifests)
    if (!detached.has(manifest.version))
      known.set(manifest.version, manifest.sourceCommit);
  let best: { version: string; commit: string } | null = null;
  for (const [candidate, commit] of known) {
    if (candidate === version || commit === source || !repo.standsOn(commit, source)) continue;
    if (!best || (compareSemver(candidate, best.version) ?? 0) > 0)
      best = { version: candidate, commit };
  }
  return best;
}

/**
 * What a rolling alpha at `source` would ship that the previous release did
 * not (docs/alpha.md, "An alpha with nothing new to build"): the previous
 * release by the same rule the notes check uses, and the paths on the desktop
 * build list (scripts/desktop-build.ts) that changed since it, as JSON. With
 * no previous release, `previous` is null and the alpha cuts.
 */
function desktopChanges(repo: Repo, flags: Map<string, string | true>): string {
  repo.assertFullHistory();
  const source = repo.resolve(need(flags, "source"));
  const previous = previousRelease(repo, load(repo), null, source);
  const changed = previous
    ? repo
        .git("diff", "--name-only", previous.commit, source)
        .split("\n")
        .filter((path) => path && isDesktopPath(path))
    : [];
  return JSON.stringify({ previous: previous?.version ?? null, changed });
}

/**
 * Select merged code for the post-merge installer gate, or an empty source
 * when nothing it guards changed since the previous release
 * (scripts/desktop-build.ts, signedInstallerChanges). Why goes to the log.
 */
function installerSource(repo: Repo, flags: Map<string, string | true>): string {
  repo.assertFullHistory();
  const source = repo.resolve(need(flags, "source"));
  const main = repo.resolve(need(flags, "main"));
  const previous = previousRelease(repo, load(repo), null, source);
  const merged = repo.git("merge-base", main, source);
  if (repo.changedPaths(merged, source).some((path) => !path.startsWith(`${NOTES_DIR}/`))) {
    throw new Refusal(["Signed installer verification requires release code already merged into main."]);
  }
  if (previous === null) {
    console.error("Signed installer check: there is no previous release, so this alpha runs it.");
    return `source=${merged}`;
  }
  const reasons = signedInstallerChanges(repo.changedPaths(previous.commit, source), (path, side) =>
    repo.fileAt(side === "before" ? previous.commit : source, path),
  );
  console.error(
    reasons.length > 0
      ? `Signed installer check: runs, since v${previous.version} changed ${reasons.join(", ")}.`
      : `Signed installer check: skipped, since v${previous.version} changed none of its inputs.`,
  );
  return `source=${reasons.length > 0 ? merged : ""}`;
}

function check(repo: Repo, flags: Map<string, string | true>): string {
  repo.assertFullHistory();
  const source = repo.resolve(need(flags, "source"));
  if (repo.resolve("HEAD") !== source)
    throw new Refusal([`the checkout is at ${repo.resolve("HEAD")}, not the release source ${source}`]);
  const channel = (flags.get("channel") ?? "alpha") as string;
  if (channel !== "alpha" && channel !== "stable")
    throw new Refusal([`channel "${channel}" is neither alpha nor stable`]);
  const loaded = load(repo);
  const problems = validate(repo, loaded);
  if (problems.length > 0) throw new Refusal(problems);

  const rehearsal = flags.get("rehearsal") === true;
  const reviewed = flags.get("verified-main") ?? flags.get("reviewed");
  if (channel === "alpha") {
    if (typeof reviewed === "string") {
      if (reviewed !== source)
        throw new Refusal([
          `the candidate ${reviewed} is not the workflow's resolved source ${source}: dispatch the commit the review was committed on`,
        ]);
    } else if (!rehearsal)
      throw new Refusal([
        "a candidate is required: the release crewmate commits its notes review and dispatches that commit",
      ]);
  }

  const version = typeof flags.get("version") === "string" ? (flags.get("version") as string) : null;
  const promoted = typeof flags.get("promoted-from") === "string" ? (flags.get("promoted-from") as string) : "";
  // A rehearsal that names nothing to release, neither a candidate nor a
  // promoted alpha, builds the dispatched commit: it publishes no tag and
  // pins nothing, so no later release stands on it.
  const dispatchedRehearsal = rehearsal && reviewed === undefined && !promoted;
  // Every published release this one stands on keeps its record, so a record
  // a merge dropped, or one never pinned, stops the next release. The release
  // being cut and the alpha it promotes have none yet: a record is pinned
  // after its release publishes.
  const pinned = new Set(loaded.manifests.map((item) => item.manifest.version));
  const unpinned = repo
    .tags()
    .filter(
      (tag) =>
        !pinned.has(tag.version) &&
        tag.version !== version &&
        tag.version !== promoted &&
        repo.standsOn(tag.commit, source),
    )
    .map((tag) => tag.version)
    .sort((a, b) => compareSemver(a, b) ?? 0);
  // Automatic exact-main cuts keep immutable tags as their source records;
  // publishedReleases already derives any manifest not committed afterward.
  // A promotion keeps its alpha source unchanged and uses the same tags, and
  // so does a rehearsal of the dispatched commit.
  // A manual notes-only candidate still carries reviewed historical pins, and
  // a rehearsal of one checks them as its live release would.
  if (
    unpinned.length > 0 &&
    flags.get("verified-main") !== source &&
    !(channel === "stable" && promoted) &&
    !dispatchedRehearsal
  )
    throw new Refusal([
      `${unpinned.length} published release(s) have no record in ${NOTES_DIR}/releases/: ${unpinned.join(", ")}`,
      "Pin each with `node scripts/release-notes.ts manifest --version <v> --write` on the release's branch, commit it, then dispatch again.",
    ]);
  if (channel === "stable" && promoted) {
    const alpha = repo.tags().find((tag) => tag.version === promoted);
    if (!alpha) throw new Refusal([`the promoted alpha ${promoted} has no tag in this checkout`]);
    const changed = repo.git("diff", "--name-only", alpha.commit, source, "--", NOTES_DIR);
    if (changed)
      throw new Refusal([
        `a stable promotion edits the notes source (${changed.split("\n").join(", ")}); correct the prose in a new alpha instead`,
      ]);
    return `stable ${version ?? ""} keeps the editorial source of ${promoted} unchanged`.replace("  ", " ");
  }

  const previous = previousRelease(repo, loaded, version, source);
  const range = repo.commits(previous?.commit ?? null, source);
  const missing = uncoveredCommits(
    range.filter((commit) => !repo.regenerated(commit.sha)),
    coveredCommits(loaded.files, repo.addedBy),
  );
  if (missing.length > 0)
    throw new Refusal([
      `${missing.length} source change(s) since ${previous ? `v${previous.version}` : "the beginning"} have no note or reviewed exclusion:`,
      ...missing.map((commit) => `  ${commit.sha.slice(0, 12)} ${commit.subject}`),
      "Add a note (or an exclusion with a reason) under release-notes/changes/ and merge it before cutting the release.",
    ]);
  return `${range.length} source change(s) since ${previous ? `v${previous.version}` : "the beginning"} are all covered`;
}

/**
 * A development or end-to-end build has no release identity, so it carries an
 * honest placeholder: a packaged copy of it never passes `verify-package`, and
 * the app reads it as notes unavailable, never as an empty history.
 */
function placeholder(flags: Map<string, string | true>): string {
  const out = resolve(need(flags, "out"));
  mkdirSync(dirname(out), { recursive: true });
  // No pictures either: an empty folder, so packaging finds what it ships.
  resetPictures(dirname(out));
  writeFileSync(
    out,
    `${JSON.stringify({ schema: 1, unavailable: "A development build carries no release catalog." }, null, 2)}\n`,
  );
  return `wrote the development placeholder to ${out}`;
}

/** The packaged pictures folder beside a catalog, emptied of any earlier build's files. */
function resetPictures(catalogDir: string): string {
  const dir = join(catalogDir, PACKAGED_PICTURES_DIR);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function heroPicture(root: string): (file: string) => CatalogPicture | null {
  const read = heroReader(root);
  return (file) => {
    const bytes = read(file);
    const picture = bytes ? readPicture(bytes) : undefined;
    return bytes && picture ? { sha256: sha256(bytes), ...picture.size } : null;
  };
}

/** The highlighted entries' hero files, read from the ledger with their hash and size. */
function heroPictures(root: string, entries: NoteEntry[]): Record<string, CatalogPicture> {
  const problems: string[] = [];
  const pictures: Record<string, CatalogPicture> = {};
  const read = heroPicture(root);
  for (const file of heroFiles(entries)) {
    const picture = read(file);
    if (!picture) problems.push(`${PICTURES_DIR}/${file} cannot be read as a picture`);
    else pictures[file] = picture;
  }
  if (problems.length > 0) throw new Refusal(problems);
  return pictures;
}

/** A catalog and its pictures beside it, written where the release packages them. */
function writeCatalog(root: string, out: string, catalog: { pictures?: unknown }): number {
  mkdirSync(dirname(out), { recursive: true });
  const pictures = resetPictures(dirname(out));
  const files = Object.keys(catalog.pictures ?? {});
  for (const file of files)
    writeFileSync(join(pictures, file), readFileSync(join(root, PICTURES_DIR, file)));
  writeFileSync(out, `${JSON.stringify(catalog, null, 2)}\n`);
  return files.length;
}

function generate(repo: Repo, flags: Map<string, string | true>): string {
  if (flags.get("dev") === true) return placeholder(flags);
  repo.assertFullHistory();
  const version = need(flags, "version");
  const source = repo.resolve(need(flags, "source"));
  if (!parseSemver(version)) throw new Refusal([`"${version}" is not a version`]);
  if (repo.resolve("HEAD") !== source)
    throw new Refusal([`the checkout is at ${repo.resolve("HEAD")}, not the release source ${source}`]);
  const loaded = load(repo);
  const problems = validate(repo, loaded);
  if (problems.length > 0) throw new Refusal(problems);
  const target = derive(repo, loaded, {
    version,
    sourceCommit: source,
    promotedFrom: promotedFromTag(repo, version, source),
  });
  const entries = loaded.files.flatMap((item): NoteEntry[] => item.file.entries);
  const wanted = new Set(target.entryIds);
  const { catalog, problems: built } = buildCatalog({
    target,
    entries,
    releases: publishedReleases(repo, loaded),
    pictures: heroPictures(
      repo.root,
      entries.filter((entry) => wanted.has(entry.id)),
    ),
  });
  if (!catalog) throw new Refusal(built);
  const verified = verifyCatalog(catalog, { version, sourceCommit: source });
  if (verified.length > 0) throw new Refusal(verified);
  const out = resolve(need(flags, "out"));
  const pictures = writeCatalog(repo.root, out, catalog);
  return `wrote the catalog for ${version} (${catalog.entries.length} entries, ${catalog.releases.length} releases, ${pictures} pictures) to ${out}`;
}

/** `--picks` or `--highlights`: entry ids, lead first. */
function idList(flags: Map<string, string | true>, name: string): string[] | null {
  const value = flags.get(name);
  if (value === undefined) return null;
  if (value === true) throw new Refusal([`--${name} names the picked entry ids, lead first`]);
  return value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

/** A stable promotion's highlights: the changes to pick from, or the catalog rewritten with the picks. */
function stableHighlights(repo: Repo, flags: Map<string, string | true>): string {
  const path = resolve(need(flags, "catalog"));
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Refusal([`the catalog ${path} cannot be read: ${String(error)}`]);
  }
  const picks = idList(flags, "picks");
  if (picks === null) {
    const { version, since, candidates, problems } = highlightCandidates(value);
    if (problems.length > 0) throw new Refusal(problems);
    const rank = (entry: NoteEntry) => entry.highlight ?? Number.POSITIVE_INFINITY;
    const rows = [
      ["review rank", "picture", "id", "kind", "area", "title"],
      ...[...candidates]
        .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
        .map((entry) => [
          String(entry.highlight ?? "-"),
          entry.picture ? "yes" : "no",
          entry.id,
          entry.kind,
          entry.area ?? "other",
          entry.title,
        ]),
    ];
    const widths = rows[0]?.map((_, column) =>
      Math.max(...rows.map((row) => (row[column] as string).length)),
    );
    return [
      `stable ${version} picks its highlights from ${candidates.length} change(s) since ${since ? `stable ${since}` : "the beginning"}; only a change with a picture can lead.`,
      ...rows.map((row) =>
        row.map((cell, column) => cell.padEnd(widths?.[column] ?? 0)).join("  ").trimEnd(),
      ),
    ].join("\n");
  }
  const { catalog, problems } = pickHighlights(value, picks, heroPicture(repo.root));
  if (!catalog) throw new Refusal(problems);
  const pictures = writeCatalog(repo.root, path, catalog);
  const { version } = catalog.release as { version: string };
  return `stable ${version}'s highlights are ${picks.map((id, index) => `${index + 1}. ${id}`).join(", ")}, with ${pictures} pictures, in ${path}`;
}

function manifest(repo: Repo, flags: Map<string, string | true>): string {
  repo.assertFullHistory();
  const version = need(flags, "version");
  const tag = repo.tags().find((item) => item.version === version);
  if (!tag) throw new Refusal([`v${version} is not a tag in this checkout`]);
  const loaded = load(repo);
  const derived = derive(repo, loaded, {
    version,
    sourceCommit: tag.commit,
    promotedFrom: promotedFromTag(repo, version, tag.commit),
  });
  const picks = idList(flags, "highlights");
  const { entryIds, ...facts } = derived;
  const pinned: ReleaseManifest = { ...facts, ...(picks ? { highlights: picks } : {}), entryIds };
  if (picks) {
    const problems = recordedHighlightProblems(
      pinned,
      publishedReleases(repo, loaded),
      loaded.files.flatMap((item): NoteEntry[] => item.file.entries),
    );
    if (problems.length > 0) throw new Refusal(problems);
  } else if (pinned.promotedFrom !== null && flags.get("write") === true)
    throw new Refusal([
      `stable ${version} was promoted from ${pinned.promotedFrom}, so its record keeps the highlights the captain picked: pass --highlights <id>,<id>,<id>, lead first, as its private release names them`,
    ]);
  const text = `${JSON.stringify(pinned, null, 2)}\n`;
  if (flags.get("write") === true) {
    const path = join(repo.root, NOTES_DIR, "releases", `${version}.json`);
    if (existsSync(path)) throw new Refusal([`${path} exists; a published manifest is never rewritten`]);
    // An existing pin is authority for detached releases, never freshly hashed bytes.
    const archive = loaded.archive && !freshHistory(repo, loaded)
      ? extendArchive(repo, {
          ...loaded,
          manifests: [...loaded.manifests, { path, manifest: pinned }],
          hashes: new Map([...loaded.hashes, [version, sha256(Buffer.from(text))]]),
        }, loaded.archive.repository, loaded.archive.previousRepositories)
      : null;
    if (loaded.archive && !archive) {
      const problems = validate(repo, loaded, true);
      if (problems.length) throw new Refusal(problems);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, { flag: "wx" });
    if (archive) {
      writeArchive(repo.root, archive);
      return `pinned ${version}, and the record of past releases with it`;
    }
    return `pinned ${version}`;
  }
  return text.trim();
}

function writeArchive(root: string, record: ReleaseArchive): void {
  writeFileSync(join(root, ARCHIVE_FILE), `${JSON.stringify(record, null, 2)}\n`);
}

/** Validate against the old trust set before admitting any new pins. */
function extendArchive(
  repo: Repo,
  loaded: Loaded,
  repository: string,
  previousRepositories?: string[],
): ReleaseArchive {
  const problems = validate(repo, loaded, true);
  if (problems.length > 0) throw new Refusal(problems);
  const hashes = new Map([...loaded.hashes, ...Object.entries(loaded.archive?.releases ?? {})]);
  const record = {
    ...archiveOf(repository, loaded.manifests.map((item) => item.manifest), hashes),
    ...(previousRepositories ? { previousRepositories } : {}),
  };
  const parsed = parseArchive(record, ARCHIVE_FILE);
  if (!parsed.archive) throw new Refusal(parsed.problems);
  return parsed.archive;
}

/**
 * The record of past releases, pinned from the full history: every published
 * release's manifest by its hash, and the newest version each channel
 * published. Only a checkout with that history can pin it, after the ledger
 * checks out against it; it is pinned again whenever another release is.
 */
function archive(repo: Repo, flags: Map<string, string | true>): string {
  repo.assertFullHistory();
  const loaded = load(repo);
  const flag = flags.get("repository");
  const repository = typeof flag === "string" ? flag : loaded.archive?.repository;
  if (!repository) throw new Refusal(["--repository names where the history lives, as owner/name"]);
  const chain = loaded.archive && repository !== loaded.archive.repository;
  if (!chain && freshHistory(repo, loaded))
    throw new Refusal([
      `${ARCHIVE_FILE} is pinned from the history it records, which this checkout does not have; name this history with --repository to chain it`,
    ]);
  const previousRepositories = chain && loaded.archive
    ? [...(loaded.archive.previousRepositories ?? []), loaded.archive.repository]
    : loaded.archive?.previousRepositories;
  const tags = repo.tags().filter((tag) => isStableVersion(tag.version) || isAlphaVersion(tag.version));
  const historyTags = tags.filter((tag) => repo.sharesHistory(tag.commit));
  if (chain && (!historyTags.some((tag) => isStableVersion(tag.version)) || !historyTags.some((tag) => isAlphaVersion(tag.version))))
    throw new Refusal(["Chaining requires this history's published stable and alpha tags."]);
  const pinned = new Set(loaded.manifests.map((item) => item.manifest.version));
  const files = new Map<string, string>();
  const manifests = [...loaded.manifests];
  const hashes = new Map(loaded.hashes);
  for (const tag of historyTags) {
    if (pinned.has(tag.version)) continue;
    const manifest = derive(repo, loaded, {
      version: tag.version,
      sourceCommit: tag.commit,
      promotedFrom: promotedFromTag(repo, tag.version, tag.commit),
    });
    const path = `${NOTES_DIR}/releases/${tag.version}.json`;
    const text = `${JSON.stringify(manifest)}\n`;
    files.set(path, text);
    manifests.push({ path, manifest });
    hashes.set(tag.version, sha256(Buffer.from(text)));
  }
  const record = extendArchive(repo, { ...loaded, manifests, hashes }, repository, previousRepositories);
  if (flags.get("write") !== true) return JSON.stringify(record, null, 2);
  mkdirSync(join(repo.root, NOTES_DIR, "releases"), { recursive: true });
  for (const [path, text] of files) writeFileSync(join(repo.root, path), text, { flag: "wx" });
  writeArchive(repo.root, record);
  return `pinned the record of ${Object.keys(record.releases).length} past releases: stable ${record.stable}, alpha ${record.alpha}`;
}

function verifyPackage(flags: Map<string, string | true>): string {
  const path = need(flags, "catalog");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Refusal([`the packaged catalog ${path} cannot be read: ${String(error)}`]);
  }
  const problems = verifyCatalog(value, {
    version: need(flags, "version"),
    sourceCommit: need(flags, "source"),
  });
  if (problems.length > 0) throw new Refusal(problems);
  const pictures = (value as { pictures?: Record<string, CatalogPicture> }).pictures ?? {};
  for (const [file, picture] of Object.entries(pictures)) {
    const packaged = join(dirname(path), PACKAGED_PICTURES_DIR, file);
    if (!existsSync(packaged)) problems.push(`the packaged picture ${file} is missing`);
    else if (sha256(readFileSync(packaged)) !== picture.sha256)
      problems.push(`the packaged picture ${file} is not the file the catalog hashed`);
  }
  if (problems.length > 0) throw new Refusal(problems);
  const count = Object.keys(pictures).length;
  return `the packaged catalog is ${need(flags, "version")} from ${need(flags, "source")}${count > 0 ? `, with its ${count} pictures` : ""}`;
}

/** Runs one command; returns what to print. Exported for the tests. */
export function run(argv: string[]): string {
  const { command, flags } = args(argv);
  const repoFlag = flags.get("repo");
  const repo = new Repo(
    typeof repoFlag === "string"
      ? resolve(repoFlag)
      : resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  );
  switch (command) {
    case "validate": {
      repo.assertFullHistory();
      const problems = validate(repo, load(repo));
      if (problems.length > 0) throw new Refusal(problems);
      return "the release-notes ledger is consistent";
    }
    case "change":
      return change(repo, flags);
    case "batch":
      return batch(repo, flags);
    case "check":
      return check(repo, flags);
    case "installer-source":
      return installerSource(repo, flags);
    case "desktop-changes":
      return desktopChanges(repo, flags);
    case "generate":
      return generate(repo, flags);
    case "stable-highlights":
      return stableHighlights(repo, flags);
    case "manifest":
      return manifest(repo, flags);
    case "verify-package":
      return verifyPackage(flags);
    case "archive":
      return archive(repo, flags);
    default:
      throw new Refusal([
        "usage: release-notes.ts validate | change | batch | check | desktop-changes | installer-source | generate | stable-highlights | manifest | verify-package | archive",
      ]);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(run(process.argv.slice(2)));
  } catch (error) {
    if (error instanceof Refusal) {
      printErrors(error.problems, { title: "Release notes" });
      process.exit(1);
    }
    throw error;
  }
}
