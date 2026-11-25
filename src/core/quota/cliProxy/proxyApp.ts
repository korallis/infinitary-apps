import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostEnv } from "../../hostEnv";
import { encodedCommand, windowsPowerShell } from "../../storage/ownerOnly";

/**
 * The CLI proxy app on this computer (docs/quota.md, "A proxy's pooled
 * logins"): EasyCLIProxyAPI keeps its settings in `config.toml` beside its
 * own program, with the port it listens on, the management key that reads
 * its logins and the client keys that list its models. Infinitary finds the
 * running program, reads that file, and sends the keys only to the loopback
 * address and port the same file names. The keys stay in memory: they are
 * never logged, stored or shown.
 */
export type ProxyApp = {
  /** `http://127.0.0.1:<port>`: where the proxy answers on this computer. */
  origin: string;
  port: number;
  /** The management key. Never logged, stored or put in a message. */
  key: string;
  /** The first client key, for the proxy's own model list. Never logged or shown. */
  clientKey?: string;
};

/** The program whose folder holds the settings file. */
const PROXY_PROGRAM = "EasyCLIProxyAPI";
const SETTINGS_FILE = "config.toml";
const FIND_TIMEOUT_MS = 10_000;

type TomlValue = string | number | string[];

/**
 * The top-level `key = value` lines of a TOML file that this reader needs:
 * integers, quoted strings and one-line arrays of quoted strings, before the
 * first table. Anything else is not read.
 */
export function readProxySettings(text: string): ProxyApp | undefined {
  const values = new Map<string, TomlValue>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) break;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!match?.[1] || match[2] === undefined) continue;
    const value = tomlValue(match[2].trim());
    if (value !== undefined) values.set(match[1], value);
  }
  const port = values.get("port");
  const key = values.get("management-secret-key");
  const host = values.get("host");
  const clientKeys = values.get("api-keys");
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
    return undefined;
  if (typeof key !== "string" || key.length === 0) return undefined;
  // The keys go to this computer alone: a proxy set to listen elsewhere is
  // not read.
  if (host !== undefined && (typeof host !== "string" || !listensHere(host))) return undefined;
  const clientKey = Array.isArray(clientKeys)
    ? clientKeys.find((entry) => entry.length > 0)
    : typeof clientKeys === "string" && clientKeys.length > 0
      ? clientKeys
      : undefined;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    key,
    ...(clientKey ? { clientKey } : {}),
  };
}

function listensHere(host: string): boolean {
  return ["", "127.0.0.1", "localhost", "0.0.0.0", "::", "::1", "[::1]"].includes(
    host.toLowerCase(),
  );
}

const STRING = String.raw`"(?:[^"\\]|\\.)*"|'[^']*'`;
const SCALAR = new RegExp(String.raw`^(-?\d+|${STRING})\s*(?:#.*)?$`);
const ARRAY = new RegExp(String.raw`^\[\s*((?:(?:${STRING})\s*,?\s*)*)\]\s*(?:#.*)?$`);
const ITEM = new RegExp(STRING, "g");

function tomlValue(text: string): TomlValue | undefined {
  const scalar = SCALAR.exec(text);
  if (scalar?.[1] !== undefined) {
    if (/^-?\d+$/.test(scalar[1])) return Number(scalar[1]);
    return tomlString(scalar[1]);
  }
  const array = ARRAY.exec(text);
  if (array?.[1] === undefined) return undefined;
  const items: string[] = [];
  for (const item of array[1].match(ITEM) ?? []) {
    const value = tomlString(item);
    if (value === undefined) return undefined;
    items.push(value);
  }
  return items;
}

function tomlString(text: string): string | undefined {
  if (text.startsWith("'")) return text.slice(1, -1);
  try {
    return JSON.parse(text) as string;
  } catch {
    return undefined;
  }
}

/**
 * Whether an address goes to the proxy at `port` on this computer: plain
 * HTTP to a loopback name with that port. The Claude Code address and a
 * custom connection's base address are both matched this way.
 */
export function addressIsProxy(address: string, port: number): boolean {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname.toLowerCase())) return false;
  return Number(url.port || 80) === port;
}

export type FindProxyProgram = () => Promise<string[]>;

/**
 * The running proxy app's program paths. Windows answers through its own
 * process list; elsewhere `ps` names each program's path.
 */
export const findProxyPrograms: FindProxyProgram = () =>
  new Promise((resolve) => {
    const done = (stdout: string) =>
      resolve(
        stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && line.includes(PROXY_PROGRAM)),
      );
    if (process.platform === "win32") {
      // i18n-exempt: a PowerShell command, never shown
      const script = `Get-CimInstance Win32_Process -Filter "Name='${PROXY_PROGRAM}.exe'" | ForEach-Object { $_.ExecutablePath }`;
      execFile(
        windowsPowerShell(),
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand(script)],
        { env: hostEnv(), timeout: FIND_TIMEOUT_MS, windowsHide: true },
        (error, stdout) => done(error ? "" : String(stdout)),
      );
      return;
    }
    execFile(
      "ps",
      ["-axww", "-o", "comm="],
      { env: hostEnv(), timeout: FIND_TIMEOUT_MS },
      (error, stdout) => done(error ? "" : String(stdout)),
    );
  });

/**
 * Finds the proxy app's settings and reads them again on each call, so a
 * changed key or port is used at once. The program's folder is looked up
 * once, and again only after its file stops reading; while no proxy runs,
 * the process list is asked at most once every `lookAgainMs`.
 */
export function createProxyAppReader(
  find: FindProxyProgram = findProxyPrograms,
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
  now: () => number = Date.now,
  lookAgainMs = 5 * 60_000,
): () => Promise<ProxyApp | undefined> {
  let settingsPath: string | undefined;
  let lookedAt: number | undefined;
  return async () => {
    if (settingsPath) {
      const app = await readAt(settingsPath, read);
      if (app) return app;
      settingsPath = undefined;
    }
    if (lookedAt !== undefined && now() - lookedAt < lookAgainMs) return undefined;
    lookedAt = now();
    for (const program of await find()) {
      const path = join(dirname(program), SETTINGS_FILE);
      const app = await readAt(path, read);
      if (app) {
        settingsPath = path;
        lookedAt = undefined;
        return app;
      }
    }
    return undefined;
  };
}

async function readAt(
  path: string,
  read: (path: string) => Promise<string>,
): Promise<ProxyApp | undefined> {
  try {
    return readProxySettings(await read(path));
  } catch {
    return undefined;
  }
}
