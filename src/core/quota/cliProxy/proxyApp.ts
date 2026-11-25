import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { hostEnv } from "../../hostEnv";
import { encodedCommand, windowsPowerShell } from "../../storage/ownerOnly";

/**
 * The CLI proxy app on this computer (docs/quota.md, "A proxy's pooled
 * logins"): EasyCLIProxyAPI keeps its settings in `config.toml` in its own
 * folder, with the port its proxy program listens on, the management key
 * that reads its logins and the client keys that list its models; the proxy
 * program itself (`cli-proxy-api`) runs from a folder inside it. Infinitary
 * finds the running proxy program, reads that file, and sends the keys only
 * to a loopback address where that program listens on the port the same
 * file names. The keys stay in memory: they are never logged, stored or
 * shown.
 */
export type ProxyApp = {
  /** `http://127.0.0.1:<port>` or `http://[::1]:<port>`: where the keys are sent. */
  origin: string;
  /**
   * Every loopback origin the proxy program itself listens on at its port,
   * `origin` first: an address in the app is the proxy's only when it names
   * one of these (`addressIsProxy`).
   */
  origins: readonly string[];
  port: number;
  /** The management key. Never logged, stored or put in a message. */
  key: string;
  /** The first client key, for the proxy's own model list. Never logged or shown. */
  clientKey?: string;
};

/**
 * The proxy program EasyCLIProxyAPI starts, from a folder of its own
 * (`cpa-core`) inside the app's folder that holds the settings file.
 */
const PROXY_PROGRAM = "cli-proxy-api";
const SETTINGS_FILE = "config.toml";
const FIND_TIMEOUT_MS = 10_000;

type TomlValue = string | number | string[];

/**
 * The top-level `key = value` lines of a TOML file that this reader needs:
 * integers, quoted strings and one-line arrays of quoted strings, before the
 * first table. EasyCLIProxyAPI writes its client keys as a one-line array of
 * inline tables, each `{ key = "...", remark = "..." }`: such an array reads
 * as each table's `key`. Anything else is not read.
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
  const origin = loopbackOrigin("127.0.0.1", port);
  return {
    origin,
    origins: [origin],
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
const TABLE_ARRAY = /^\[\s*((?:\{[^{}]*\}\s*,?\s*)*)\]\s*(?:#.*)?$/;
const TABLE = /\{([^{}]*)\}/g;
const TABLE_KEY = new RegExp(String.raw`(?:^|,)\s*key\s*=\s*(${STRING})\s*(?:,|$)`);

function tomlValue(text: string): TomlValue | undefined {
  const scalar = SCALAR.exec(text);
  if (scalar?.[1] !== undefined) {
    if (/^-?\d+$/.test(scalar[1])) return Number(scalar[1]);
    return tomlString(scalar[1]);
  }
  const tables = TABLE_ARRAY.exec(text);
  if (tables?.[1] !== undefined) {
    const keys: string[] = [];
    for (const table of tables[1].matchAll(TABLE)) {
      const key = TABLE_KEY.exec(table[1] ?? "")?.[1];
      const value = key === undefined ? undefined : tomlString(key);
      if (value === undefined) return undefined;
      keys.push(value);
    }
    return keys;
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
 * Whether an address goes to the proxy on this computer: plain HTTP to a
 * loopback origin the proxy listens on (`ProxyApp.origins`). IPv4 and IPv6
 * loopback are told apart, since another program can hold the same port on
 * the other; `localhost`, which a client may reach on either, is the proxy
 * only when the proxy listens on both. The Claude Code address and a custom
 * connection's base address are both matched this way.
 */
export function addressIsProxy(address: string, origins: readonly string[]): boolean {
  const port = loopbackPortOf(address);
  if (port === undefined) return false;
  const ipv4 = loopbackOrigin("127.0.0.1", port);
  const ipv6 = loopbackOrigin("[::1]", port);
  const host = new URL(address).hostname.toLowerCase();
  if (host === "localhost") return origins.includes(ipv4) && origins.includes(ipv6);
  return origins.includes(host === "[::1]" ? ipv6 : ipv4);
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
  const endpointsOf = lsofListening(
    await run("lsof", ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-Fptn"]),
  );
  if (endpointsOf.size === 0) return [];
  const programs = await run("ps", ["-axww", "-o", "pid=,comm="]);
  const entries = await Promise.all(
    programs.map(async (line) => {
      const match = /^(\d+)\s+(.+)$/.exec(line);
      const [, pid, name] = match ?? [];
      if (!pid || !name || basename(name) !== PROXY_PROGRAM) return [];
      // `ps` names a program by its path on a Mac and by its name alone on
      // Linux, where the process's own link gives the path.
      const program = name.includes("/")
        ? name
        : await readlink(`/proc/${pid}/exe`).catch(() => undefined);
      if (!program) return [];
      return (endpointsOf.get(pid) ?? []).map((endpoint) => ({ program, ...endpoint }));
    }),
  );
  return listenersOf(entries.flat());
};

/**
 * Each process's listening endpoints in `lsof -Fptn` output: a `p` line per
 * process, then per open file an `f` line, its family (`t`) and its name
 * (`n`). A file's family never carries over to the next file or process.
 */
export function lsofListening(lines: readonly string[]): Map<string, ListenEndpoint[]> {
  const endpointsOf = new Map<string, ListenEndpoint[]>();
  let pid: string | undefined;
  let family: string | undefined;
  for (const line of lines) {
    if (line.startsWith("p")) {
      pid = line.slice(1);
      family = undefined;
    } else if (line.startsWith("f")) family = undefined;
    else if (line.startsWith("t")) family = line.slice(1);
    else if (line.startsWith("n") && pid) {
      const endpoint = lsofEndpoint(line.slice(1), family);
      if (endpoint) endpointsOf.set(pid, [...(endpointsOf.get(pid) ?? []), endpoint]);
    }
  }
  return endpointsOf;
}

/**
 * An `lsof` name field (`127.0.0.1:8317`, `[::1]:8317`, `*:8317`) as an
 * endpoint; `*` is the wildcard of the file's address family, and with no
 * family `lsof` named, a wildcard is no endpoint: where it answers is not
 * guessed.
 */
export function lsofEndpoint(name: string, family: string | undefined): ListenEndpoint | undefined {
  const match = /^(.*):(\d+)$/.exec(name);
  if (!match?.[1] || !match[2]) return undefined;
  const host = match[1].replace(/^\[|\]$/g, "");
  const wildcard = family === "IPv4" ? "0.0.0.0" : family === "IPv6" ? "::" : undefined;
  const address = host === "*" ? wildcard : host;
  return address ? { address, port: Number(match[2]) } : undefined;
}

/**
 * Where on this computer a listener at `endpoint` answers, as an origin:
 * IPv4 loopback for one on IPv4 loopback or every IPv4 address, IPv6
 * loopback for one on IPv6 loopback or every IPv6 address. A listener on
 * another interface alone is not reachable here and answers nothing.
 */
export function loopbackOriginOf(endpoint: ListenEndpoint): string | undefined {
  if (endpoint.address === "127.0.0.1" || endpoint.address === "0.0.0.0")
    return loopbackOrigin("127.0.0.1", endpoint.port);
  if (endpoint.address === "::1" || endpoint.address === "::")
    return loopbackOrigin("[::1]", endpoint.port);
  return undefined;
}

/**
 * A loopback origin written as `URL.origin` writes it, which leaves out port
 * 80: discovery, attribution and the request guard compare these strings, so
 * they are all made here.
 */
export function loopbackOrigin(host: "127.0.0.1" | "[::1]", port: number): string {
  return new URL(`http://${host}:${port}`).origin;
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
 * The proxy app's settings, read on each call from the running proxy
 * program's folder and the app's folder above it, while that program listens
 * on the port they name. When both files name a port it listens on, they
 * must name the same port and hold the same keys: which one the running
 * proxy uses is not known, so differing files are read as no settings. Its keys go only to a
 * loopback address where that program itself listens on that port now
 * (`loopbackOriginOf`), IPv4 first: a settings file left by a proxy that
 * exited, or a port another program took, is not read. While no proxy runs,
 * the system is asked at most once every `lookAgainMs`.
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
      const folder = dirname(listener.program);
      const found: ProxyApp[] = [];
      for (const path of [join(folder, SETTINGS_FILE), join(dirname(folder), SETTINGS_FILE)]) {
        const settings = await readAt(path, read);
        if (settings && listener.endpoints.some((endpoint) => endpoint.port === settings.port))
          found.push(settings);
      }
      const app = found.every(
        (other) =>
          other.port === found[0]?.port &&
          other.key === found[0]?.key &&
          other.clientKey === found[0]?.clientKey,
      )
        ? found[0]
        : undefined;
      // "http://127..." sorts before "http://[::1]...": IPv4 comes first.
      const origins = app
        ? [
            ...new Set(
              listener.endpoints
                .filter((endpoint) => endpoint.port === app.port)
                .flatMap((endpoint) => loopbackOriginOf(endpoint) ?? []),
            ),
          ].sort()
        : [];
      const origin = origins[0];
      if (app && origin) {
        missedAt = undefined;
        return { ...app, origin, origins };
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
