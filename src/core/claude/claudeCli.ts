import { execFile, spawn } from "node:child_process";
import { accessSync, constants, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { withoutAwsEnvironment } from "@shared/awsEnvironment";
import { CLAUDE_CLIENT_MISSING_TEXT, claudeClientOutdatedText } from "@shared/claudeClient";
import { settingFrom } from "@shared/envSettings";
import { returnsToLoopback } from "@shared/signIns";
import { hostEnv, loginPathCapture } from "../hostEnv";
import { hostPlatform, hostPlatformProfile } from "../platform";

/**
 * Locating and driving Claude's own first-party client, which is what makes
 * a Claude subscription reachable at all: its OAuth is refused for any other
 * client, so Infinitary runs it rather than reimplementing it.
 *
 * The client is the one the person installed (F14, captain lock of
 * 2026-09-20): the app ships no copy and downloads none. It is the same
 * install that holds the machine's default `claude login` (CD-1=B), so
 * "installed" and "signed in" are established the same way. The SDK still
 * carries a copy in node_modules for the linux CI runner's tool-surface
 * capture; nothing here ever resolves it.
 *
 * Everything Claude-specific stays behind src/core/claude/ the way every Pi
 * touchpoint stays behind src/core/pi/ (Biome noRestrictedImports enforces
 * both). Nothing in THIS module reads a credential: the vendor's own client
 * owns the machine's default login, Infinitary only reads it. The one sanctioned
 * read is the in-process quota sensor (claudeQuota.ts). Claude runs leave
 * CLAUDE_CONFIG_DIR unset so the client uses the bare Keychain item.
 */

/** How long a status read may take before we treat the store as unreadable. */
export const STATUS_TIMEOUT_MS = 20_000;
/** The client's non-interactive status request; it owns any refresh this causes. */
export const CLAUDE_AUTH_STATUS_ARGS = ["auth", "status", "--json"] as const;
/** A login is a human-paced browser flow; give it room, but not forever. */
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** A `--version` read is instant; anything slower is a wedged binary. */
export const VERSION_TIMEOUT_MS = 10_000;
/** A login shell can stall on a prompt; the lookup gets this and no more. */
export const SHELL_LOOKUP_TIMEOUT_MS = 3_000;
/** A failed login-shell lookup is not repeated before this much time passes. */
export const SHELL_LOOKUP_RETRY_MS = 5 * 60 * 1000;

const CLIENT_FILE = hostPlatform() === "win32" ? "claude.exe" : "claude";

let cachedExecutable: string | undefined;
let shellFound: string | undefined;
let shellFailedAt = 0;
let shellLookup: Promise<string | undefined> | undefined;
let cachedFloor: string | undefined | null = null;
const versionCache = new Map<string, { key: string; version: string }>();

/** Forget every remembered lookup. For tests, which exercise the rungs one at a time. */
export function resetClaudeClientCache(): void {
  cachedExecutable = undefined;
  shellFound = undefined;
  shellFailedAt = 0;
  shellLookup = undefined;
  cachedFloor = null;
  versionCache.clear();
}

/**
 * Where the installers put the client, in the order worth trying: the
 * native installer (`~/.local/bin/claude`, a symlink into
 * `~/.local/share/claude/versions/<v>` that the client's own updater keeps
 * pointing at the current build), the older local installer's shim,
 * Homebrew on Apple silicon and on Intel, then the Node version managers'
 * global bins. A Finder-launched app sees the login PATH - on a stock Mac
 * just /usr/bin:/bin:/usr/sbin:/sbin - so these are checked before PATH.
 */
export function knownClaudeHomes(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME?.trim() || homedir();
  const homes = [
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".volta", "bin"),
    join(home, ".npm-global", "bin"),
  ];
  for (const version of nodeVersionDirs(join(home, ".nvm", "versions", "node"))) {
    homes.push(join(version, "bin"));
  }
  return homes;
}

function nodeVersionDirs(root: string): string[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^v?\d+\.\d+\.\d+$/.test(name))
    .sort((a, b) => compareVersions(b.replace(/^v/, ""), a.replace(/^v/, "")))
    .map((name) => join(root, name));
}

export type ResolveClaudeOptions = {
  /**
   * The directories to look in instead of `knownClaudeHomes`. Tests pass
   * their own so a developer's real install never leaks into a run; the
   * result is then not remembered.
   */
  homes?: string[];
};

/**
 * The client executable, or nothing. An explicit `INFINITARY_CLAUDE_CLI` wins
 * outright (dev, and e2e, which points it at a stub) and a missing override
 * is "no client", never a fallback. Otherwise the installed client: the
 * known homes, then the host search path (`hostEnv.ts`: the person's own
 * shell's path, captured once at boot), then whatever
 * `primeClaudeExecutable` learned from a login shell. A found path is
 * remembered for as long as it stays executable, so an update that moves
 * the binary is noticed on the next read; nothing is remembered about
 * absence, so an install during the app's life is found on the next tick.
 */
export function resolveClaudeExecutable(
  env: NodeJS.ProcessEnv = hostEnv(),
  options: ResolveClaudeOptions = {},
): string | undefined {
  const override = settingFrom(env, "CLAUDE_CLI")?.trim();
  if (override) return spawnableExecutable(override);
  if (options.homes === undefined && cachedExecutable !== undefined) {
    if (isExecutable(cachedExecutable)) return cachedExecutable;
    cachedExecutable = undefined;
  }
  const homes = options.homes ?? knownClaudeHomes(env);
  const found =
    homes.map((dir) => join(dir, CLIENT_FILE)).find(isExecutable) ??
    findOnPath(env) ??
    (shellFound !== undefined && isExecutable(shellFound) ? shellFound : undefined);
  if (options.homes === undefined && found !== undefined) cachedExecutable = found;
  return found;
}

function findOnPath(env: NodeJS.ProcessEnv): string | undefined {
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    if (!entry) continue;
    const candidate = join(entry, CLIENT_FILE);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The resolver plus its one slow rung: a person whose install lives
 * somewhere no known home names still has it on their login shell's PATH,
 * so when nothing else finds it, ask that shell once (`command -v claude`,
 * non-interactive, bounded). A hit is remembered like any other; a miss is
 * not retried for `SHELL_LOOKUP_RETRY_MS`, so a machine with no client
 * does not spawn a shell on every status tick. An override is never
 * second-guessed here, and a run whose settings file named the folders asks
 * no shell (`configureSettingsPath`, `hostEnv.ts`): nobody may be logged in
 * there to answer it.
 */
export async function primeClaudeExecutable(
  env: NodeJS.ProcessEnv = hostEnv(),
  options: ResolveClaudeOptions = {},
): Promise<string | undefined> {
  const found = resolveClaudeExecutable(env, options);
  if (found !== undefined || settingFrom(env, "CLAUDE_CLI")?.trim()) return found;
  if (hostPlatform() === "win32" || loginPathCapture()?.source === "settings") return undefined;
  if (Date.now() - shellFailedAt < SHELL_LOOKUP_RETRY_MS) return undefined;
  shellLookup ??= lookupThroughLoginShell(env).then((path) => {
    shellLookup = undefined;
    if (path === undefined) {
      shellFailedAt = Date.now();
      return undefined;
    }
    shellFound = path;
    cachedExecutable = path;
    return path;
  });
  return shellLookup;
}

function lookupThroughLoginShell(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const shell = env.SHELL?.trim() || hostPlatformProfile().loginShell;
  return new Promise((resolve) => {
    execFile(
      shell,
      ["-lc", "command -v claude"],
      { timeout: SHELL_LOOKUP_TIMEOUT_MS, env: { ...env }, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        const line = String(stdout).trim().split("\n").pop()?.trim();
        resolve(line?.startsWith("/") && isExecutable(line) ? line : undefined);
      },
    );
  });
}

/** The first x.y.z in a client's `--version` line (`2.1.278 (Claude Code)`). */
export function parseClaudeVersion(text: string): string | undefined {
  const match = text.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : undefined;
}

/** Numeric x.y.z order: negative when `a` is older than `b`. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * The oldest client the SDK in this build is known to drive: the one it
 * was released with. The SDK and the client are co-released (SDK 0.3.N
 * with client 2.1.N) and the SDK checks no version of its own, so the floor
 * is read off the SDK's own manifest rather than kept by hand - bumping the
 * dependency moves it. Unreadable means no floor, never a refusal.
 */
export function claudeClientFloor(): string | undefined {
  if (cachedFloor !== null) return cachedFloor;
  cachedFloor = readSdkManifestVersion();
  return cachedFloor;
}

function readSdkManifestVersion(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const sdkEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
    const manifest = JSON.parse(readFileSync(join(dirname(sdkEntry), "manifest.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof manifest.version === "string" ? parseClaudeVersion(manifest.version) : undefined;
  } catch {
    return undefined;
  }
}

export type ReadClientVersion = (executable: string) => Promise<string | undefined>;

export const readClaudeClientVersion: ReadClientVersion = (executable) =>
  new Promise((resolve) => {
    execFile(
      executable,
      ["--version"],
      { timeout: VERSION_TIMEOUT_MS, env: claudeEnvFor(), windowsHide: true },
      (error, stdout) => {
        resolve(error ? undefined : parseClaudeVersion(String(stdout)));
      },
    );
  });

/**
 * The installed client's version, read once per build of the binary: the
 * cache key is the file's identity, so the client's own updater (which
 * replaces the file behind the symlink) invalidates it. A failed read is
 * not remembered.
 */
export async function claudeClientVersion(
  executable: string,
  read: ReadClientVersion = readClaudeClientVersion,
): Promise<string | undefined> {
  const key = fileIdentity(executable);
  const cached = versionCache.get(executable);
  if (cached && cached.key === key) return cached.version;
  const version = await read(executable);
  if (version !== undefined) versionCache.set(executable, { key, version });
  return version;
}

function fileIdentity(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "absent";
  }
}

export type ClaudeClientCheck =
  | { state: "ready"; executable: string; version?: string }
  | { state: "missing" }
  | { state: "outdated"; executable: string; version: string; floor: string };

export type CheckClaudeClientOptions = ResolveClaudeOptions & {
  /** The floor to hold the client to; production reads the SDK's manifest. */
  floor?: string;
  /** How to read a version; production spawns `claude --version`. */
  read?: ReadClientVersion;
};

/**
 * The one question every Claude touchpoint asks before it spawns: is there
 * a client, and is it new enough. A client that reports no version is
 * taken as ready - the floor is a guard against known drift, not a reason
 * to refuse a client that merely spoke differently.
 */
export async function checkClaudeClient(
  env: NodeJS.ProcessEnv = hostEnv(),
  options: CheckClaudeClientOptions = {},
): Promise<ClaudeClientCheck> {
  const executable =
    options.homes === undefined
      ? await primeClaudeExecutable(env)
      : resolveClaudeExecutable(env, { homes: options.homes });
  if (executable === undefined) return { state: "missing" };
  const version = await claudeClientVersion(executable, options.read);
  const floor = options.floor ?? claudeClientFloor();
  if (version !== undefined && floor !== undefined && compareVersions(version, floor) < 0) {
    return { state: "outdated", executable, version, floor };
  }
  return { state: "ready", executable, ...(version !== undefined ? { version } : {}) };
}

/** The health reason a check stamps on the account, or nothing when it can serve. */
export function claudeClientIssueReason(
  check: ClaudeClientCheck,
): "client_missing" | "client_outdated" | undefined {
  if (check.state === "missing") return "client_missing";
  if (check.state === "outdated") return "client_outdated";
  return undefined;
}

/** The one sentence a surface shows for a check that cannot serve. */
export function claudeClientIssueText(check: ClaudeClientCheck): string | undefined {
  if (check.state === "missing") return CLAUDE_CLIENT_MISSING_TEXT;
  if (check.state === "outdated") return claudeClientOutdatedText(check.version, check.floor);
  return undefined;
}

/** A path segment that is an asar archive, plus the separator after it. */
const ASAR_SEGMENT = /([^/\\]+\.asar)([/\\])/;

/**
 * The same file as it really sits on disk, next to the archive rather than
 * inside it. electron-builder unpacks native trees to `<name>.asar.unpacked/`
 * for exactly this reason. No client ships in the archive any more (F14),
 * but an override may still name one, and the guard costs nothing.
 */
export function unpackedAsarPath(path: string): string | undefined {
  return ASAR_SEGMENT.test(path) ? path.replace(ASAR_SEGMENT, "$1.unpacked$2") : undefined;
}

/**
 * A path this module may hand to `spawn`, or nothing.
 *
 * In a packaged app the client resolves to a path INSIDE app.asar, and
 * Electron's asar shim answers `existsSync` for it - so the obvious check
 * passes and the spawn then fails ENOTDIR, because only `execFile` is
 * asar-aware (Electron's "Executing binaries inside asar archive" rule).
 * That is a lie we must not repeat: a status read that fails this way looks
 * exactly like a signed-out account, which drops the whole provider out of
 * the models catalog and raises a false "sign in again" (captain dogfood,
 * packaged build, 2026-09-01). So an in-archive path is mapped to the
 * unpacked copy, and only a real on-disk file is returned.
 */
function spawnableExecutable(candidate: string): string | undefined {
  const unpacked = unpackedAsarPath(candidate);
  // A check on the in-archive path would be answered by the asar shim, so
  // the unpacked copy is the only honest evidence there.
  if (unpacked !== undefined) return isExecutable(unpacked) ? unpacked : undefined;
  return isExecutable(candidate) ? candidate : undefined;
}

/**
 * The label every Claude client the app starts carries (`CLAUDE_CODE_ENTRYPOINT`),
 * which the client passes on to every command it runs.
 */
export const INFINITARY_ENTRYPOINT = "infinitary";

/**
 * The environment a Claude client run sees: the machine's default login
 * (CLAUDE_CONFIG_DIR left unset, so the client uses the bare Keychain item)
 * and nothing ambient, on the host search path (`hostEnv.ts`) so every
 * shell the client runs for a crewmate sees what the person installed.
 * Setting the variable even to ~/.claude would suffix the service name and
 * miss the everyday login (docs/claude-client.md). A further login names its
 * own folder in `ownConfigDir`, the one case that sets the variable; gateway
 * headers this process inherited are the person's default login's, so that
 * run loses them.
 */
export function claudeEnvFor(
  base: NodeJS.ProcessEnv = hostEnv(),
  ownConfigDir?: string,
): NodeJS.ProcessEnv {
  const env = withoutAwsEnvironment(base);
  // Identify our own app, never an inherited SDK or first-party client.
  // Claude Code issue 97074's workaround requires an explicit overwrite.
  env.CLAUDE_CODE_ENTRYPOINT = INFINITARY_ENTRYPOINT;
  // CD-1=B: the vendor's own default login, unless this run is a further
  // login's, whose folder the caller names; never an inherited one.
  delete env.CLAUDE_CONFIG_DIR;
  if (ownConfigDir) {
    env.CLAUDE_CONFIG_DIR = ownConfigDir;
    delete env.ANTHROPIC_CUSTOM_HEADERS;
  }
  // Ambient credentials would silently serve a key the user never connected
  // here. The machine login, and a token command an organization or the
  // person set up for Claude Code with the address it is sent to
  // (`claudeAccess.ts`, handed over as settings, never as environment), are
  // the only credential sources a run of ours may have.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  return env;
}

export type ClaudeRunResult = { code: number | null; stdout: string; stderr: string };

export type RunClaude = (
  args: string[],
  configDir: string,
  options?: {
    timeoutMs?: number;
    onStdout?: (chunk: string) => void;
    /**
     * A code the client asks to have pasted: stdin stays open until this
     * settles, the code is written to it once, and a rejection stops the
     * client. Without it stdin closes at once.
     */
    paste?: Promise<string>;
    /** Laid over the client's environment for this run alone. */
    env?: NodeJS.ProcessEnv;
  },
) => Promise<ClaudeRunResult>;

/**
 * What a run's `BROWSER` names when no browser may open on this Mac: a
 * program that takes the link and does nothing. The client runs the opener
 * `BROWSER` names rather than the system's (measured on Claude Code 2.1.288,
 * `docs/helper.md` "Its own sign-ins").
 */
export const NO_BROWSER = "/usr/bin/true";

/**
 * Run the client with no controlling terminal - piped stdio only, exactly
 * how Electron's main process spawns it. The plan's phase-7 gate probe
 * (claudeLoginProbe.test.ts) is what establishes this is viable: the login
 * prints its authorize URL on stdout and completes over a loopback callback,
 * so no PTY is needed on the happy path.
 */
export const runClaude: RunClaude = (args, configDir, options = {}) => {
  // Lease identity for callers; the spawn leaves CLAUDE_CONFIG_DIR unset
  // unless the caller names a further login's folder in `options.env`.
  void configDir;
  const executable = resolveClaudeExecutable();
  if (!executable) {
    return Promise.reject(new Error(CLAUDE_CLIENT_MISSING_TEXT));
  }
  return new Promise<ClaudeRunResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: withoutAwsEnvironment({
        ...claudeEnvFor(undefined, options.env?.CLAUDE_CONFIG_DIR),
        ...options.env,
      }),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("Claude did not respond in time."));
    }, options.timeoutMs ?? STATUS_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      options.onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (caught) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(caught);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    // The login offers a paste fallback on stdin. The loopback callback
    // completes the flow with stdin open or closed; a computer that runs
    // work, and a sign-in whose page never comes back, paste the code.
    // Without a paste promise stdin closes, so the client is not left
    // waiting on a terminal that will never exist.
    child.stdin.on("error", () => {});
    const { paste } = options;
    if (!paste) {
      child.stdin.end();
      return;
    }
    paste.then(
      (code) => {
        if (settled) return;
        child.stdin.write(`${code}\n`);
        child.stdin.end();
      },
      (caught: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        reject(caught instanceof Error ? caught : new Error(String(caught)));
      },
    );
  });
};

export function extractAuthUrl(text: string): string | undefined {
  const match = text.match(/https:\/\/[^\s"'<>]+/);
  return match ? match[0] : undefined;
}

/**
 * The sign-in link whose page shows a code to paste back, once the client
 * has printed it whole: the first one that does not send the browser back
 * to this Mac's own loopback (the one the client hands its browser opener).
 */
export function pasteCodeLink(output: string): string | undefined {
  const whole = [...output.matchAll(/https:\/\/[^\s"'<>]+(?=\s)/g)].map((match) => match[0]);
  return whole.find((link) => {
    try {
      new URL(link);
      return !returnsToLoopback(link, "paste-code");
    } catch {
      return false;
    }
  });
}
