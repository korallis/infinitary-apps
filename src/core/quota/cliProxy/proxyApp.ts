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
 * address and port the same file names, while that program listens there. The keys stay in memory: they are
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

/** A running proxy program, with the ports it listens on. */
export type ProxyListener = { program: string; ports: readonly number[] };

export type FindProxyListeners = () => Promise<ProxyListener[]>;

/**
 * The running proxy programs and the TCP ports each listens on, asked of
 * the system on every call. Windows answers through its own process and
 * connection lists; elsewhere `lsof` names each listening process and `ps`
 * its program's path.
 */
export const findProxyListeners: FindProxyListeners = async () => {
  if (process.platform === "win32") {
    // i18n-exempt: a PowerShell command, never shown
    const script = `Get-CimInstance Win32_Process -Filter "Name='${PROXY_PROGRAM}.exe'" | ForEach-Object { $p = $_; Get-NetTCPConnection -State Listen -OwningProcess $p.ProcessId -ErrorAction SilentlyContinue | ForEach-Object { "$($p.ExecutablePath)\t$($_.LocalPort)" } }`;
    const lines = await run(windowsPowerShell(), [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encodedCommand(script),
    ]);
    return listenersOf(
      lines.flatMap((line) => {
        const [program, port] = line.split("\t");
        return program && port ? [{ program, port: Number(port) }] : [];
      }),
    );
  }
  const listening = await run("lsof", ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-Fpn"]);
  const portsOf = new Map<string, number[]>();
  let pid: string | undefined;
  for (const line of listening) {
    if (line.startsWith("p")) pid = line.slice(1);
    else if (line.startsWith("n") && pid) {
      const port = Number(/:(\d+)$/.exec(line)?.[1]);
      if (Number.isInteger(port)) portsOf.set(pid, [...(portsOf.get(pid) ?? []), port]);
    }
  }
  if (portsOf.size === 0) return [];
  const programs = await run("ps", ["-axww", "-o", "pid=,comm="]);
  return listenersOf(
    programs.flatMap((line) => {
      const match = /^(\d+)\s+(.+)$/.exec(line);
      const [, pid, program] = match ?? [];
      if (!pid || !program?.includes(PROXY_PROGRAM)) return [];
      return (portsOf.get(pid) ?? []).map((port) => ({ program, port }));
    }),
  );
};

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

function listenersOf(entries: { program: string; port: number }[]): ProxyListener[] {
  const byProgram = new Map<string, number[]>();
  for (const { program, port } of entries) {
    if (!Number.isInteger(port)) continue;
    byProgram.set(program, [...(byProgram.get(program) ?? []), port]);
  }
  return [...byProgram].map(([program, ports]) => ({ program, ports }));
}

/**
 * The proxy app's settings, read on each call from beside the running
 * program that listens on the port they name. Its keys go only to a port
 * the proxy program itself listens on now: a settings file left by a proxy
 * that exited, or a port another program took, is not read. While no proxy
 * runs, the system is asked at most once every `lookAgainMs`.
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
      if (app && listener.ports.includes(app.port)) {
        missedAt = undefined;
        return app;
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
