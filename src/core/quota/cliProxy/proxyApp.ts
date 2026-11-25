import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { hostEnv } from "../../hostEnv";
import { encodedCommand, windowsPowerShell } from "../../storage/ownerOnly";

/**
 * The CLI proxy app on this computer (docs/quota.md, "A proxy's pooled
 * logins"): EasyCLIProxyAPI keeps its settings in `config.toml` beside its
 * own program, with the port it listens on, the management key that reads
 * its logins and the client keys that list its models. Infinitary finds the
 * running program, reads that file, and sends the keys only to the loopback
 * address where that program listens on the port the same file names. The
 * keys stay in memory: they are never logged, stored or shown.
 */
export type ProxyApp = {
  /** `http://127.0.0.1:<port>` or `http://[::1]:<port>`: where the proxy listens on this computer. */
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
  return loopbackPortOf(address) === port;
}

/**
 * The port of a plain HTTP address on this computer, or undefined for any
 * other address: only such an address can be a proxy's.
 */
export function loopbackPortOf(address: string): number | undefined {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:") return undefined;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname.toLowerCase())) return undefined;
  return Number(url.port || 80);
}

/** One address and port a program listens on, as the system names it. */
export type ListenEndpoint = { address: string; port: number };

/** A running proxy program, with where it listens. */
export type ProxyListener = { program: string; endpoints: readonly ListenEndpoint[] };

export type FindProxyListeners = () => Promise<ProxyListener[]>;

/**
 * The running proxy programs and the TCP addresses and ports each listens
 * on, asked of the system on every call. Windows answers through its own
 * process and connection lists; elsewhere `lsof` names each listening
 * process with its address family, and `ps` its program's path.
 */
export const findProxyListeners: FindProxyListeners = async () => {
  if (process.platform === "win32") {
    // i18n-exempt: a PowerShell command, never shown
    const script = `Get-CimInstance Win32_Process -Filter "Name='${PROXY_PROGRAM}.exe'" | ForEach-Object { $p = $_; Get-NetTCPConnection -State Listen -OwningProcess $p.ProcessId -ErrorAction SilentlyContinue | ForEach-Object { "$($p.ExecutablePath)\t$($_.LocalAddress)\t$($_.LocalPort)" } }`;
    const lines = await run(windowsPowerShell(), [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encodedCommand(script),
    ]);
    return listenersOf(
      lines.flatMap((line) => {
        const [program, address, port] = line.split("\t");
        return program && address && port ? [{ program, address, port: Number(port) }] : [];
      }),
    );
  }
  const listening = await run("lsof", ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-Fptn"]);
  const endpointsOf = new Map<string, ListenEndpoint[]>();
  let pid: string | undefined;
  let family: string | undefined;
  for (const line of listening) {
    if (line.startsWith("p")) pid = line.slice(1);
    else if (line.startsWith("t")) family = line.slice(1);
    else if (line.startsWith("n") && pid) {
      const endpoint = lsofEndpoint(line.slice(1), family);
      if (endpoint) endpointsOf.set(pid, [...(endpointsOf.get(pid) ?? []), endpoint]);
    }
  }
  if (endpointsOf.size === 0) return [];
  const programs = await run("ps", ["-axww", "-o", "pid=,comm="]);
  return listenersOf(
    programs.flatMap((line) => {
      const match = /^(\d+)\s+(.+)$/.exec(line);
      const [, pid, program] = match ?? [];
      if (!pid || !program || basename(program) !== PROXY_PROGRAM) return [];
      return (endpointsOf.get(pid) ?? []).map((endpoint) => ({ program, ...endpoint }));
    }),
  );
};

/**
 * An `lsof` name field (`127.0.0.1:8317`, `[::1]:8317`, `*:8317`) as an
 * endpoint; `*` is the wildcard of the file's address family.
 */
export function lsofEndpoint(name: string, family: string | undefined): ListenEndpoint | undefined {
  const match = /^(.*):(\d+)$/.exec(name);
  if (!match?.[1] || !match[2]) return undefined;
  const host = match[1].replace(/^\[|\]$/g, "");
  const address = host === "*" ? (family === "IPv6" ? "::" : "0.0.0.0") : host;
  return { address, port: Number(match[2]) };
}

/**
 * Where on this computer a listener at `endpoint` answers, as an origin:
 * IPv4 loopback for one on IPv4 loopback or every IPv4 address, IPv6
 * loopback for one on IPv6 loopback or every IPv6 address. A listener on
 * another interface alone is not reachable here and answers nothing.
 */
export function loopbackOriginOf(endpoint: ListenEndpoint): string | undefined {
  if (endpoint.address === "127.0.0.1" || endpoint.address === "0.0.0.0")
    return `http://127.0.0.1:${endpoint.port}`;
  if (endpoint.address === "::1" || endpoint.address === "::")
    return `http://[::1]:${endpoint.port}`;
  return undefined;
}

function run(command: string, args: string[]): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { env: hostEnv(), timeout: FIND_TIMEOUT_MS, windowsHide: true },
      (error, stdout) =>
        resolve(
          error
            ? []
            : String(stdout)
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter((line) => line.length > 0),
        ),
    );
  });
}

function listenersOf(entries: ({ program: string } & ListenEndpoint)[]): ProxyListener[] {
  const byProgram = new Map<string, ListenEndpoint[]>();
  for (const { program, address, port } of entries) {
    if (!Number.isInteger(port)) continue;
    byProgram.set(program, [...(byProgram.get(program) ?? []), { address, port }]);
  }
  return [...byProgram].map(([program, endpoints]) => ({ program, endpoints }));
}

/**
 * The proxy app's settings, read on each call from beside the running
 * program that listens on the port they name. Its keys go only to the
 * loopback address where that program itself listens on that port now
 * (`loopbackOriginOf`), which becomes the app's origin: a settings file
 * left by a proxy that exited, or a port another program took, is not
 * read. While no proxy runs, the system is asked at most once every
 * `lookAgainMs`.
 */
export function createProxyAppReader(
  find: FindProxyListeners = findProxyListeners,
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
  now: () => number = Date.now,
  lookAgainMs = 5 * 60_000,
): () => Promise<ProxyApp | undefined> {
  let missedAt: number | undefined;
  return async () => {
    if (missedAt !== undefined && now() - missedAt < lookAgainMs) return undefined;
    for (const listener of await find()) {
      const app = await readAt(join(dirname(listener.program), SETTINGS_FILE), read);
      const origin = app
        ? listener.endpoints
            .filter((endpoint) => endpoint.port === app.port)
            .map(loopbackOriginOf)
            .sort()
            .find((entry) => entry !== undefined)
        : undefined;
      if (app && origin) {
        missedAt = undefined;
        return { ...app, origin };
      }
    }
    missedAt = now();
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
