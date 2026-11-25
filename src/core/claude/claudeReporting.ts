import { exec } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { connect } from "node:http2";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { resolve as resolvePath } from "node:path";
import { createSecureContext, getCACertificates, type SecureContext } from "node:tls";
import type { ResolvedSettings } from "@anthropic-ai/claude-agent-sdk";
import type { UsageReporting, UsageReportingRefusalReason } from "@shared/usage";
import { loginPathCapture } from "../hostEnv";
import { type ResolveClaudeSettings, resolveSettings } from "./claudeAccess";
import { type ClaudeReportForward, hasClaudeReporting } from "./claudeCostReports";

/**
 * A company's Claude Code reporting setup kept where Claude Code's guide puts
 * it for each developer: the `env` block of the person's own
 * `~/.claude/settings.json`, their login shell, or the app's launch
 * environment (`docs/usage.md`, "A company's Claude Code setup").
 *
 * Claude's client never sends to it directly. It keeps reporting only to the
 * app's local receiver (`ClaudeCostReports`), which prices each call for the
 * ledger and passes each batch on unchanged to the collector this setup
 * names. An administrator's managed setup is not read here: it reaches the
 * client itself, and the receiver then stays off (`claudeCostPolicy.ts`).
 */

export type ReportingSignal = "logs" | "metrics";
export type ReportingProtocol = "http/json" | "http/protobuf" | "grpc";

/**
 * A setup's certificate files for a secure collector, as paths: its own
 * certificate authority, and a client certificate with its key.
 */
export type CertificateFiles = { ca?: string; cert?: string; key?: string };

/** Where one signal goes, in the protocol the setup asks for. */
export type CompanyDestination = {
  /** The full per-signal address for OTLP over HTTP; the collector's origin for gRPC. */
  endpoint: string;
  protocol: ReportingProtocol;
  /** The setup's static headers. Values often hold a company token: never logged. */
  headers: Record<string, string>;
  timeoutMs: number;
  tls?: CertificateFiles;
};

export type ClaudeCompanyReporting = {
  /** The collector's host, for the line in Settings → Usage. */
  host: string;
  signals: Partial<Record<ReportingSignal, CompanyDestination>>;
  /** The settings file's `otelHeadersHelper`, a command printing a JSON object of headers. */
  headersHelper?: string;
  /**
   * The setup's other keys, such as `OTEL_RESOURCE_ATTRIBUTES` or an export
   * interval, handed to the client unchanged so its records are the ones it
   * would have sent.
   */
  clientEnv: Record<string, string>;
};

/** The keys a setup is made of, wherever they are kept. */
export function isReportingKey(key: string): boolean {
  return key.startsWith("OTEL_") || key === "CLAUDE_CODE_ENABLE_TELEMETRY";
}

/** The launch environment without the setup's keys: the client gets the receiver's instead. */
export function withoutReportingKeys(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !isReportingKey(key)));
}

/**
 * A launch exporter the receiver's forward cannot carry - one other than
 * OTLP, such as Prometheus or the console - which only the client can honor.
 */
function uncarried(env: NodeJS.ProcessEnv): boolean {
  return Object.entries(env).some(
    ([key, value]) =>
      value !== undefined &&
      (key === "OTEL_LOGS_EXPORTER" || key === "OTEL_METRICS_EXPORTER") &&
      value.split(",").some((name) => !["", "otlp", "none"].includes(name.trim())),
  );
}

/**
 * Whether the receiver leaves a session's reporting to the client, as it
 * always has: a reporting choice in the launch environment other than a
 * setup the receiver passes on, or an exporter it cannot carry.
 */
export function receiverStepsAside(env: NodeJS.ProcessEnv): boolean {
  return hasClaudeReporting(withoutReportingKeys(env)) || uncarried(env);
}

/** The keys that say where and how to send; the receiver sets these for the client. */
const TRANSPORT_KEY =
  /^OTEL_(?:(?:LOGS|METRICS|TRACES)_EXPORTER|EXPORTER_OTLP_(?:(?:LOGS|METRICS|TRACES)_)?(?:ENDPOINT|PROTOCOL|HEADERS|COMPRESSION|TIMEOUT|CERTIFICATE|CLIENT_KEY|CLIENT_CERTIFICATE|INSECURE))$/;

const PROTOCOLS: readonly ReportingProtocol[] = ["http/json", "http/protobuf", "grpc"];

/** OTLP's default when the setup names no protocol (OpenTelemetry's exporter specification). */
const DEFAULT_PROTOCOL: ReportingProtocol = "http/protobuf";
const DEFAULT_TIMEOUT_MS = 10_000;

function truthy(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/i.test((value ?? "").trim());
}

/** OTLP's header list: `name=value` pairs joined by commas, values percent-encoded. */
export function parseOtlpHeaders(value: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of (value ?? "").split(",")) {
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    let text = pair.slice(at + 1).trim();
    try {
      text = decodeURIComponent(text);
    } catch {
      // A stray percent sign is the value itself.
    }
    if (name) headers[name] = text;
  }
  return headers;
}

function destination(
  keys: Record<string, string>,
  signal: ReportingSignal,
): CompanyDestination | undefined {
  const upper = signal.toUpperCase();
  // As Claude's client reads them: the signal's own key wins, and an empty one is unset.
  const pick = (name: string) =>
    keys[`OTEL_EXPORTER_OTLP_${upper}_${name}`]?.trim() ||
    keys[`OTEL_EXPORTER_OTLP_${name}`]?.trim() ||
    undefined;
  const exporters = (keys[`OTEL_${upper}_EXPORTER`] ?? "").split(",").map((name) => name.trim());
  if (!exporters.includes("otlp")) return undefined;
  const protocol = (keys[`OTEL_EXPORTER_OTLP_${upper}_PROTOCOL`] ??
    keys.OTEL_EXPORTER_OTLP_PROTOCOL ??
    DEFAULT_PROTOCOL) as ReportingProtocol;
  if (!PROTOCOLS.includes(protocol)) return undefined;
  const own = keys[`OTEL_EXPORTER_OTLP_${upper}_ENDPOINT`]?.trim();
  const base =
    keys.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
    (protocol === "grpc" ? "http://localhost:4317" : "http://localhost:4318");
  let address = own || base;
  // Claude's gRPC exporter takes a bare `host:port` as secure unless the
  // setup's insecure key is "true"; its HTTP exporters need the scheme.
  if (protocol === "grpc" && !/^[a-z][a-z\d+.-]*:\/\//i.test(address))
    address = `${pick("INSECURE")?.toLowerCase() === "true" ? "http" : "https"}://${address}`;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const endpoint =
    protocol === "grpc"
      ? url.origin
      : own
        ? url.href
        : `${url.href.replace(/\/+$/, "")}/v1/${signal}`;
  const timeout = Number(
    keys[`OTEL_EXPORTER_OTLP_${upper}_TIMEOUT`] ?? keys.OTEL_EXPORTER_OTLP_TIMEOUT,
  );
  const ca = pick("CERTIFICATE");
  const cert = pick("CLIENT_CERTIFICATE");
  const key = pick("CLIENT_KEY");
  return {
    endpoint,
    protocol,
    headers: {
      ...parseOtlpHeaders(keys.OTEL_EXPORTER_OTLP_HEADERS),
      ...parseOtlpHeaders(keys[`OTEL_EXPORTER_OTLP_${upper}_HEADERS`]),
    },
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
    ...(url.protocol === "https:" && (ca || cert || key)
      ? { tls: { ...(ca ? { ca } : {}), ...(cert ? { cert } : {}), ...(key ? { key } : {}) } }
      : {}),
  };
}

/**
 * The setup these keys make, or nothing when telemetry is off or no signal
 * is exported over OTLP. Traces stay with the client's own choice of none:
 * the receiver passes on logs and metrics.
 */
export function companyReportingFrom(
  keys: Record<string, string>,
  headersHelper?: string,
): ClaudeCompanyReporting | undefined {
  if (!truthy(keys.CLAUDE_CODE_ENABLE_TELEMETRY)) return undefined;
  const signals: ClaudeCompanyReporting["signals"] = {};
  for (const signal of ["logs", "metrics"] as const) {
    const found = destination(keys, signal);
    if (found) signals[signal] = found;
  }
  const first = signals.logs ?? signals.metrics;
  if (!first) return undefined;
  const clientEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(keys))
    if (key !== "CLAUDE_CODE_ENABLE_TELEMETRY" && !TRANSPORT_KEY.test(key)) clientEnv[key] = value;
  return {
    host: new URL(first.endpoint).host,
    signals,
    ...(headersHelper ? { headersHelper } : {}),
    clientEnv,
  };
}

function settingsKeys(
  resolved: ResolvedSettings,
  source: "user" | "managed" = "user",
): {
  keys: Record<string, string>;
  helper?: string;
} {
  const keys: Record<string, string> = {};
  let helper: string | undefined;
  for (const tier of resolved.sources) {
    if (tier.source !== source) continue;
    const settings = tier.settings as { env?: unknown; otelHeadersHelper?: unknown };
    const env = settings.env && typeof settings.env === "object" ? settings.env : {};
    for (const [key, value] of Object.entries(env as Record<string, unknown>))
      if (isReportingKey(key) && (typeof value === "string" || typeof value === "number"))
        keys[key] = String(value);
    if (typeof settings.otelHeadersHelper === "string" && settings.otelHeadersHelper.trim())
      helper = settings.otelHeadersHelper.trim();
  }
  return { keys, ...(helper ? { helper } : {}) };
}

/**
 * The setup from the launch environment, the login shell's keys and the
 * person's settings file, later ones winning, as Claude Code lays its
 * settings file's `env` over the environment it started in. A settings read
 * that fails reads as no settings keys.
 */
export async function readClaudeCompanyReporting(
  launch: NodeJS.ProcessEnv,
  options: {
    resolve?: ResolveClaudeSettings;
    shell?: () => Readonly<Record<string, string>> | undefined;
  } = {},
): Promise<ClaudeCompanyReporting | undefined> {
  const keys: Record<string, string> = {};
  for (const [key, value] of Object.entries(launch))
    if (isReportingKey(key) && value !== undefined) keys[key] = value;
  for (const [key, value] of Object.entries(
    (options.shell ?? (() => loginPathCapture()?.claudeKeys))() ?? {},
  ))
    if (isReportingKey(key)) keys[key] = value;
  let fromSettings: ReturnType<typeof settingsKeys> = { keys: {} };
  try {
    fromSettings = settingsKeys(
      await (options.resolve ?? resolveSettings)({ settingSources: ["user"] }),
    );
  } catch {
    // No settings keys; the environment's still count.
  }
  Object.assign(keys, fromSettings.keys);
  return companyReportingFrom(keys, fromSettings.helper);
}

/**
 * An administrator's managed reporting setup, which Claude's client sends
 * to directly: only the managed tiers are read, as the cost policy reads
 * them (`claudeCostPolicy.ts`). A read that fails reads as none.
 */
export async function readManagedClaudeReporting(
  resolve: ResolveClaudeSettings = resolveSettings,
): Promise<ClaudeCompanyReporting | undefined> {
  try {
    const managed = settingsKeys(await resolve({ settingSources: [] }), "managed");
    return companyReportingFrom(managed.keys, managed.helper);
  } catch {
    return undefined;
  }
}

/** Claude Code's own refresh period for `otelHeadersHelper`: 29 minutes. */
export const HEADERS_HELPER_REFRESH_MS = 29 * 60 * 1000;
const HEADERS_HELPER_TIMEOUT_MS = 10_000;
/** How soon a header command that failed runs again: a batch sent without its token is lost. */
const HEADERS_HELPER_RETRY_MS = 10_000;

const helperRuns = new Map<
  string,
  { at: number; headers: Promise<Record<string, string> | undefined> }
>();

/**
 * The setup's headers for one signal: its static ones and what its header
 * command prints, run as Claude's client would run it, at most once per
 * refresh period per command. A command that fails or prints something else
 * than a JSON object adds nothing and runs again after a short wait, and its
 * output never reaches a log.
 */
export async function companyHeaders(
  setup: ClaudeCompanyReporting,
  signal: ReportingSignal,
  env: NodeJS.ProcessEnv,
  now: () => number = Date.now,
  note: (line: string) => void = () => {},
): Promise<Record<string, string>> {
  const fixed = setup.signals[signal]?.headers ?? {};
  const command = setup.headersHelper;
  if (!command) return fixed;
  let run = helperRuns.get(command);
  if (!run || now() - run.at >= HEADERS_HELPER_REFRESH_MS) {
    run = { at: now(), headers: runHeadersHelper(command, env, note) };
    helperRuns.set(command, run);
  }
  const headers = await run.headers;
  if (!headers)
    run.at = Math.min(run.at, now() - HEADERS_HELPER_REFRESH_MS + HEADERS_HELPER_RETRY_MS);
  return { ...fixed, ...headers };
}

function runHeadersHelper(
  command: string,
  env: NodeJS.ProcessEnv,
  note: (line: string) => void,
): Promise<Record<string, string> | undefined> {
  return new Promise((resolve) => {
    exec(
      command,
      { env, timeout: HEADERS_HELPER_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        try {
          if (error) throw error;
          const parsed: unknown = JSON.parse(stdout);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
          resolve(
            Object.fromEntries(
              Object.entries(parsed).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string",
              ),
            ),
          );
        } catch {
          // i18n-exempt: a log line, never shown to a person
          note("the reporting header command did not print headers; sending without them");
          resolve(undefined);
        }
      },
    );
  });
}

export function resetHeadersHelperForTests(): void {
  helperRuns.clear();
}

/**
 * What the collector answered, as the client's exporter reads it back, and
 * why the batch was not taken when it was not.
 */
export type ForwardAnswer = {
  status: number;
  contentType?: string;
  body: Buffer;
  failure?: UsageReportingRefusalReason;
};

const GRPC_SERVICE: Record<ReportingSignal, string> = {
  logs: "/opentelemetry.proto.collector.logs.v1.LogsService/Export",
  metrics: "/opentelemetry.proto.collector.metrics.v1.MetricsService/Export",
};

/** gRPC codes OTLP names retryable: the client then sends the batch again. */
const GRPC_RETRYABLE = new Set([1, 4, 8, 10, 11, 14, 15]);

/**
 * Node's codes for a connection that failed while it was being made secure:
 * the collector's certificate is not one this computer trusts, or the
 * collector turned away the client certificate it was sent or missed.
 */
const SECURE_FAILURE =
  /^(?:ERR_SSL_|ERR_TLS_|UNABLE_TO_)|CERT|CRL|^(?:INVALID_CA|INVALID_PURPOSE|PATH_LENGTH_EXCEEDED|HOSTNAME_MISMATCH)$/;

function failureOf(error: unknown): UsageReportingRefusalReason {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && SECURE_FAILURE.test(code)
    ? "secure-connection"
    : "unreachable";
}

let readSystemRoots: () => readonly string[] = () => getCACertificates("system");
let systemRoots: { pem: string; endsAt: number }[] | undefined;

/**
 * The computer's trusted list as Claude's client builds it: Node's own list,
 * with any `NODE_EXTRA_CA_CERTS`, and the system's, leaving out system
 * certificates past their end date. Node reads the system's list once per
 * process and keeps it, so a certificate the computer trusts only after the
 * app started is not seen until the app starts again.
 */
function computerRoots(now = Date.now()): string[] {
  if (!systemRoots) {
    let system: readonly string[] = [];
    try {
      system = readSystemRoots();
    } catch {
      // A system list that cannot be read leaves Node's own.
    }
    systemRoots = system.flatMap((pem) => {
      try {
        return [{ pem, endsAt: new X509Certificate(pem).validToDate.getTime() }];
      } catch {
        return [];
      }
    });
  }
  const current = systemRoots.filter((root) => root.endsAt > now).map((root) => root.pem);
  return [...new Set([...getCACertificates("default"), ...current])];
}

/** Stands a list in for the system's, or restores the real one with none. */
export function useSystemRootsForTests(read?: () => readonly string[]): void {
  readSystemRoots = read ?? (() => getCACertificates("system"));
  systemRoots = undefined;
}

/**
 * The secure context for one destination, built as Claude's client builds
 * its exporter's: the setup's certificate authority in place of the
 * computer's trusted list, or else that list, and the client certificate
 * only with its key. A file that cannot be read, or a pair that does not
 * fit, is left out with a log line, as the client leaves it out with a
 * warning. Relative paths resolve against `cwd`.
 */
function secureContextFor(
  files: CertificateFiles | undefined,
  cwd: string,
  note: (line: string) => void,
): SecureContext {
  const read = (path: string | undefined, what: string) => {
    if (!path) return undefined;
    try {
      return readFileSync(resolvePath(cwd, path));
    } catch {
      // i18n-exempt: a log line, never shown to a person
      note(`could not read the reporting setup's ${what} file; sending without it`);
      return undefined;
    }
  };
  // i18n-exempt: names for a log line, never shown to a person
  const [ca, cert, key] = [
    read(files?.ca, "certificate authority") ?? computerRoots(),
    read(files?.cert, "client certificate"),
    read(files?.key, "client key"),
  ];
  if (cert && key)
    try {
      return createSecureContext({ ca, cert, key });
    } catch {
      // i18n-exempt: a log line, never shown to a person
      note("the reporting setup's client certificate and key do not fit; sending without them");
    }
  try {
    return createSecureContext({ ca });
  } catch {
    // i18n-exempt: a log line, never shown to a person
    note(
      "the reporting setup's certificate authority file holds no certificate; sending without it",
    );
    return createSecureContext({ ca: computerRoots() });
  }
}

/**
 * How long a kept connection to the collector stays open with nothing to
 * send, which also ends it once its owner does: a kept connection never
 * holds the app open.
 */
const IDLE_MS = 30_000;

/**
 * The connections to one OTLP/HTTP address, kept open between batches: over
 * https, secured with `secureContextFor`'s certificate files and trusted list.
 * The usage report connects to its collectors this way too, so both reach a
 * collector that needs certificates alike.
 */
export function collectorAgent(
  endpoint: string,
  files: CertificateFiles | undefined,
  cwd: string,
  note: (line: string) => void,
): HttpAgent {
  return new URL(endpoint).protocol === "https:"
    ? new HttpsAgent({
        keepAlive: true,
        timeout: IDLE_MS,
        secureContext: secureContextFor(files, cwd, note),
      })
    : new HttpAgent({ keepAlive: true, timeout: IDLE_MS });
}

/** One destination's connections: kept open between batches over HTTP, made per batch over gRPC. */
type Leg = { agent?: HttpAgent; secureContext?: SecureContext };

function legFor(to: CompanyDestination, cwd: string, note: (line: string) => void): Leg {
  if (to.protocol !== "grpc") return { agent: collectorAgent(to.endpoint, to.tls, cwd, note) };
  return new URL(to.endpoint).protocol === "https:"
    ? { secureContext: secureContextFor(to.tls, cwd, note) }
    : {};
}

/**
 * Send one batch, exactly the bytes Claude's client produced, to the
 * company's collector. OTLP over HTTP posts them as they are; gRPC frames
 * the same protobuf message as one unary call. Redirects are not followed:
 * the headers may hold a company token.
 */
function postCompany(
  to: CompanyDestination,
  leg: Leg,
  signal: ReportingSignal,
  body: Buffer,
  contentType: string,
  headers: Record<string, string>,
): Promise<ForwardAnswer> {
  if (to.protocol === "grpc") return postGrpc(to, leg, signal, body, headers);
  return postOtlpHttp(to.endpoint, leg.agent, body, contentType, headers, to.timeoutMs);
}

/**
 * One OTLP/HTTP export over `agent`'s connections, answered as the collector
 * answered it, or as a 503 naming why it was never reached. Redirects are not
 * followed: the headers may hold a company token.
 */
export function postOtlpHttp(
  endpoint: string,
  agent: HttpAgent | undefined,
  body: Buffer,
  contentType: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<ForwardAnswer> {
  return new Promise((resolve) => {
    const failed = (error: unknown) =>
      resolve({ status: 503, body: Buffer.alloc(0), failure: failureOf(error) });
    const url = new URL(endpoint);
    try {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          method: "POST",
          ...(agent ? { agent } : {}),
          headers: {
            // Node's fetch names itself so, for a proxy that refuses a request
            // naming nothing; the setup's own User-Agent wins.
            "user-agent": "node",
            ...headers,
            "content-type": contentType,
            "content-length": body.length,
          },
          signal: AbortSignal.timeout(timeoutMs),
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", failed);
          response.on("end", () => {
            const status = response.statusCode ?? 502;
            const type = response.headers["content-type"];
            resolve({
              status,
              ...(type ? { contentType: type } : {}),
              body: Buffer.concat(chunks),
              ...(status >= 200 && status < 300 ? {} : { failure: "refused" as const }),
            });
          });
        },
      );
      request.on("error", failed);
      request.end(body);
    } catch (caught) {
      failed(caught);
    }
  });
}

function postGrpc(
  to: CompanyDestination,
  leg: Leg,
  signal: ReportingSignal,
  body: Buffer,
  headers: Record<string, string>,
): Promise<ForwardAnswer> {
  return new Promise((resolve) => {
    let settled = false;
    let status: number | undefined;
    const finish = (code: number | undefined, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session.close();
      resolve(
        code === 0
          ? { status: 200, contentType: "application/x-protobuf", body: Buffer.alloc(0) }
          : {
              status: code === undefined || GRPC_RETRYABLE.has(code) ? 503 : 400,
              body: Buffer.alloc(0),
              // A gRPC status is the collector's own answer; none means it was never reached.
              failure: code === undefined ? failureOf(error) : "refused",
            },
      );
    };
    const session = connect(
      to.endpoint,
      leg.secureContext ? { secureContext: leg.secureContext } : {},
    );
    const timer = setTimeout(() => {
      session.destroy();
      finish(undefined);
    }, to.timeoutMs);
    session.on("error", (error) => finish(undefined, error));
    const lower = Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
    );
    let request: ReturnType<typeof session.request>;
    try {
      request = session.request({
        ...lower,
        ":method": "POST",
        ":path": GRPC_SERVICE[signal],
        "content-type": "application/grpc",
        te: "trailers",
      });
    } catch (caught) {
      finish(undefined, caught);
      return;
    }
    const read = (fields: Record<string, unknown>) => {
      const value = fields["grpc-status"];
      if (value !== undefined) status = Number(value);
    };
    request.on("response", (fields) => read(fields));
    request.on("trailers", (fields) => read(fields));
    request.on("error", (error) => finish(undefined, error));
    request.on("data", () => {});
    request.on("end", () => finish(status ?? 2));
    const frame = Buffer.alloc(5);
    frame.writeUInt32BE(body.length, 1);
    request.end(Buffer.concat([frame, body]));
  });
}

/**
 * How long a collector's failures must go on, with no batch taken between
 * them, before Settings → Usage says so: past one batch's retries, which end
 * within the client's ten-second export time limit, so a passing outage
 * stays quiet.
 */
export const REFUSAL_LASTS_MS = 60_000;

/**
 * Each destination's run of failures, by its address, while no batch gets
 * through: when it began, when its latest failure was, and why that one failed.
 */
const refusals = new Map<
  string,
  { since: number; latest: number; reason: UsageReportingRefusalReason }
>();

function recordAnswer(
  to: CompanyDestination,
  answer: ForwardAnswer,
  now: number,
  note: (line: string) => void,
): void {
  if (!answer.failure) {
    refusals.delete(to.endpoint);
    return;
  }
  const run = refusals.get(to.endpoint);
  // i18n-exempt: a log line, never shown to a person
  if (!run)
    note(
      `the company collector at ${new URL(to.endpoint).host} did not take a batch (${answer.failure})`,
    );
  refusals.set(to.endpoint, { since: run?.since ?? now, latest: now, reason: answer.failure });
}

/**
 * The first of this setup's collectors whose failures have gone on for at
 * least `REFUSAL_LASTS_MS`, its first and latest failure that far apart with
 * no batch taken between them, and why its latest one failed. One failed
 * batch followed by no more work is not a collector that keeps refusing. A
 * delivered batch ends the run.
 */
export function lastingRefusal(setup: ClaudeCompanyReporting): UsageReporting["refusal"] {
  for (const to of Object.values(setup.signals)) {
    const run = refusals.get(to.endpoint);
    if (run && run.latest - run.since >= REFUSAL_LASTS_MS)
      return { host: new URL(to.endpoint).host, reason: run.reason };
  }
  return undefined;
}

export function resetRefusalsForTests(): void {
  refusals.clear();
}

/**
 * The receiver's onward leg for one attachment, under this setup. `cwd` is
 * the folder the client runs in, which its certificate paths resolve
 * against.
 */
export function companyForward(
  setup: ClaudeCompanyReporting,
  env: NodeJS.ProcessEnv,
  note: (line: string) => void,
  options: { cwd?: string; now?: () => number } = {},
): ClaudeReportForward {
  const now = options.now ?? Date.now;
  const legs = new Map<ReportingSignal, Leg>();
  const signals: ClaudeReportForward["signals"] = {};
  for (const signal of ["logs", "metrics"] as const) {
    const to = setup.signals[signal];
    if (to) signals[signal] = { protocol: to.protocol };
  }
  return {
    signals,
    clientEnv: setup.clientEnv,
    send: async (signal, body, contentType) => {
      const to = setup.signals[signal];
      if (!to) return { status: 404, body: Buffer.alloc(0) };
      const headers = await companyHeaders(setup, signal, env, now, note);
      let leg = legs.get(signal);
      if (!leg) {
        leg = legFor(to, options.cwd ?? process.cwd(), note);
        legs.set(signal, leg);
      }
      const answer = await postCompany(to, leg, signal, body, contentType, headers);
      recordAnswer(to, answer, now(), note);
      return answer;
    },
  };
}
