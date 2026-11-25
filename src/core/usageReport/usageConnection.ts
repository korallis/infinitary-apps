import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import * as m from "@shared/i18n/messages.generated";
import type { SecretConsumer } from "@shared/secrets";
import {
  type UsageConnectionProblem,
  type UsageConnectionSave,
  type UsageConnectionSaved,
  type UsageConnectionView,
  usageConnectionFormatSchema,
} from "@shared/usageConnection";
import { z } from "zod";
import { claudeLoginEmail, defaultClaudeConfigDir } from "../claude/claudeQuota";
import type { CoreServices } from "../coreServices";
import { hostEnv } from "../hostEnv";
import {
  guardedMcpFetch,
  holdMcpDestination,
  type McpResolver,
} from "../integrations/providers/mcp/guardedFetch";
import type { IntegrationKeys } from "../integrations/secrets";
import {
  assertCustomHeaders,
  type CustomNetworkMode,
  classifyCustomApiAddresses,
  customApiHostname,
} from "../pi/customApiPolicy";
import type { SecretBroker } from "../secrets/brokers";
import { canonical, sha256 } from "../secrets/custody";
import { type CompanyHosts, companyUsageDestinations, hostnameOf } from "./companyDestination";
import type { UsageReportDestination } from "./usageReporter";
import type { OtlpSignal } from "./usageReportFormats";

/** The connection's one file in the app's data folder. */
export const USAGE_CONNECTION_FILE = "usage-connection.json";

/** The broker every send with kept headers goes through (docs/secrets.md, "App sign-ins"). */
export const USAGE_REPORT_BROKER = "usage-report";

/**
 * A connection's batches go out at most this often, and once more as the app
 * quits: each send with kept headers is one use in Secrets, whose history
 * keeps every use until the person deletes it, so a working day adds a few
 * dozen lines rather than a few thousand, and a dashboard lags this much.
 */
export const CONNECTION_SEND_MS = 10 * 60_000;

const POST_TIMEOUT_MS = 10_000;
const SIGNALS = ["metrics", "logs", "traces"] as const satisfies readonly OtlpSignal[];

const savedSchema = z.object({
  endpoint: z.string(),
  mode: z.enum(["public", "private", "local"]),
  format: usageConnectionFormatSchema,
  headers: z.array(z.object({ name: z.string(), ref: z.string() })),
});
type SavedConnection = z.infer<typeof savedSchema>;

export type UsageConnectionDeps = {
  /** `userData/usage-connection.json`, 0600; its one writer is this module. */
  file: string;
  keys: IntegrationKeys;
  resolve?: McpResolver;
  /** Where a send goes; the guarded fetch of the saved address unless a check stands one in. */
  fetchFor?: (saved: { endpoint: string; mode: CustomNetworkMode }) => typeof fetch;
  /**
   * The person's Claude Code sign-in email, read now, which every record
   * carries as `user.email` so a per-person view counts their work.
   */
  email?: () => string | undefined;
};

export type UsageConnection = {
  view(): UsageConnectionView;
  save(input: UsageConnectionSave): Promise<UsageConnectionSaved>;
  remove(): Promise<UsageConnectionView>;
  /**
   * The connection as the report's destination, or none. `company` names the
   * hosts the company setup already reaches: one the report sends every
   * other model's work to gets nothing again, and one only Claude's own
   * client reports to gets no Claude work.
   */
  destinations(company?: CompanyHosts): readonly UsageReportDestination[];
  /** The saved address's host, for Settings → Usage's line. */
  host(): string | null;
  /** Sends what is waiting, once, as the app stops. */
  stop(): Promise<void>;
};

class Refused extends Error {
  constructor(readonly problem: UsageConnectionProblem) {
    super(problem);
  }
}

const lookupAll: McpResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((answer) => answer.address);

/**
 * The reporting connection a person adds (docs/usage-report.md, "The
 * person's reporting connection"): an OTLP/HTTP address reached the way an
 * MCP server's is - its network class read on Save and held on every send -
 * its headers kept as hidden Secrets entries the module never reads back,
 * and the one format the tool reading it takes. Save is the person's
 * consent to send the crew's usage there with those headers, as signing in
 * is to a sign-in's use, so a send asks nothing.
 */
export function usageConnection(deps: UsageConnectionDeps): UsageConnection {
  const resolve = deps.resolve ?? lookupAll;
  const fetchFor =
    deps.fetchFor ??
    ((saved) =>
      guardedMcpFetch(holdMcpDestination(saved.endpoint, saved.mode), resolve) as typeof fetch);
  const loaded = read(deps.file);
  let saved = loaded.saved;
  /** A file this build could not read whole names nothing for certain, so no sweep forgets by it. */
  let unreadable = loaded.unreadable;
  /** Each signal's resource entries waiting for the next send, as OTLP's request arrays. */
  let waiting: Partial<Record<OtlpSignal, unknown[]>> = {};
  let timer: ReturnType<typeof setTimeout> | undefined;

  deps.keys.registerBroker(
    reportBroker(
      () => saved,
      fetchFor,
      () => (unreadable ? undefined : (saved?.headers.map((header) => header.ref) ?? [])),
    ),
  );

  const send = async (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const batch = waiting;
    waiting = {};
    const connection = saved;
    if (!connection) return;
    const bodies: Partial<Record<OtlpSignal, string>> = {};
    for (const signal of SIGNALS) {
      const entries = batch[signal];
      if (entries?.length) bodies[signal] = JSON.stringify({ [OTLP_ARRAY[signal]]: entries });
    }
    if (Object.keys(bodies).length === 0) return;
    const host = new URL(connection.endpoint).host;
    let statuses: Partial<Record<OtlpSignal, number>>;
    try {
      if (connection.headers.length === 0) {
        statuses = await postAll(connection, bodies, fetchFor(connection));
      } else {
        const used = await deps.keys.use({
          id: randomUUID(),
          reason: m.settingsUsageConnectionUseReason({ host }),
          broker: USAGE_REPORT_BROKER,
          input: { bodies },
        });
        if (used.state !== "completed" || !used.result || typeof used.result !== "object") {
          console.warn(`[usage report] ${host}: kept headers unavailable (${used.state}); dropped`);
          return;
        }
        statuses = used.result as Partial<Record<OtlpSignal, number>>;
      }
    } catch (caught) {
      const reason = caught instanceof Error ? caught.name : "error";
      console.warn(`[usage report] ${host} unreachable (${reason}); dropped`);
      return;
    }
    for (const [signal, status] of Object.entries(statuses))
      if (status < 200 || status >= 300)
        console.warn(`[usage report] ${host} refused a ${signal} batch (HTTP ${status}); dropped`);
  };

  const destination = (
    connection: SavedConnection,
    withoutClaude: boolean,
  ): UsageReportDestination => ({
    id: "person-connection",
    format: connection.format,
    endpoints: Object.fromEntries(
      SIGNALS.map((signal) => [signal, `${connection.endpoint}/v1/${signal}`]),
    ),
    // Kept headers never leave Secrets: `post` sends through the broker.
    headers: () => Promise.resolve({}),
    resource: {},
    ...personOf(deps.email?.()),
    ...(withoutClaude
      ? { withoutClaude: true as const }
      : connection.format === "claude-code"
        ? { claudeFromLedger: true as const }
        : {}),
    post: (signal, body) => {
      const entries = (body as Record<string, unknown>)[OTLP_ARRAY[signal]];
      if (Array.isArray(entries) && entries.length > 0) {
        waiting[signal] = [...(waiting[signal] ?? []), ...entries];
        if (!timer) {
          timer = setTimeout(() => void send(), CONNECTION_SEND_MS);
          timer.unref?.();
        }
      }
      return Promise.resolve(202);
    },
  });

  return {
    view: () => viewOf(saved),
    host: () => (saved ? new URL(saved.endpoint).host : null),
    destinations: (company) => {
      if (!saved) return [];
      const host = hostnameOf(saved.endpoint);
      if (company?.allWork.includes(host)) return [];
      return [destination(saved, company?.claudeWork === host)];
    },
    stop: send,
    async save(input) {
      const kept: string[] = [];
      try {
        const place = await placeOf(input.endpoint, resolve);
        const sameAddress = saved?.endpoint === place.endpoint;
        const headers = input.headers.map((header) => {
          const value = header.value ?? "";
          const old = sameAddress
            ? saved?.headers.find((each) => each.name.toLowerCase() === header.name.toLowerCase())
            : undefined;
          if (!value && !old) throw new Refused("header-value");
          return { name: header.name, value, old };
        });
        try {
          // A kept value is checked when it was given; a stand-in fills its place here.
          assertCustomHeaders(
            headers.map(({ name, value }) => ({ name, value: value || "kept" })),
            false,
          );
        } catch {
          throw new Refused("header");
        }
        if (headers.length > 0 && !deps.keys.shown()) throw new Refused("no-secrets");
        const next: SavedConnection = { ...place, format: input.format, headers: [] };
        for (const header of headers) {
          if (!header.value && header.old) {
            next.headers.push({ name: header.name, ref: header.old.ref });
            continue;
          }
          const ref = await deps.keys.keepHidden({
            label: m.settingsUsageConnectionSecretLabel({ name: header.name }),
            value: Buffer.from(header.value, "utf8"),
            consumer: USAGE_REPORT_CONSUMER,
          });
          if (!ref) throw new Refused("secrets-locked");
          kept.push(ref);
          next.headers.push({ name: header.name, ref });
        }
        const before = saved;
        write(deps.file, next);
        saved = next;
        unreadable = false;
        // What waits was built in the old format for the old address; sent now it would reach
        // the new address, or a tool reading the new format, in the old format, so it is dropped.
        if (before?.endpoint !== next.endpoint || before?.format !== next.format) dropWaiting();
        await forgetUnnamed(before, next);
        return { saved: true, view: viewOf(saved) };
      } catch (caught) {
        for (const ref of kept) await deps.keys.forgetHidden(ref).catch(() => false);
        if (caught instanceof Refused) return { saved: false, problem: caught.problem };
        throw caught;
      }
    },
    async remove() {
      const before = saved;
      // What waits was meant for the connection being removed: it is not sent.
      dropWaiting();
      rmSync(deps.file, { force: true });
      saved = null;
      unreadable = false;
      await forgetUnnamed(before, null);
      return null;
    },
  };

  function dropWaiting() {
    if (timer) clearTimeout(timer);
    timer = undefined;
    waiting = {};
  }

  async function forgetUnnamed(before: SavedConnection | null, after: SavedConnection | null) {
    const named = new Set(after?.headers.map((header) => header.ref));
    for (const header of before?.headers ?? [])
      if (!named.has(header.ref)) await deps.keys.forgetHidden(header.ref).catch(() => false);
  }
}

/** The Secrets owner of the connection's kept headers (docs/secrets.md, "App sign-ins"). */
const USAGE_REPORT_CONSUMER = "usage-report" satisfies SecretConsumer;

function personOf(email: string | undefined): Pick<UsageReportDestination, "person"> {
  return email ? { person: { "user.email": email } } : {};
}

/** The top-level array of each signal's OTLP/HTTP JSON request. */
const OTLP_ARRAY: Record<OtlpSignal, string> = {
  metrics: "resourceMetrics",
  logs: "resourceLogs",
  traces: "resourceSpans",
};

function viewOf(saved: SavedConnection | null): UsageConnectionView {
  return saved
    ? {
        endpoint: saved.endpoint,
        format: saved.format,
        headers: saved.headers.map(({ name }) => ({ name })),
      }
    : null;
}

/** The address's network class now, from every DNS answer of its name, as an MCP server's is read. */
async function placeOf(
  endpoint: string,
  resolve: McpResolver,
): Promise<{ endpoint: string; mode: CustomNetworkMode }> {
  let hostname: string;
  try {
    hostname = customApiHostname(endpoint.trim());
  } catch {
    throw new Refused("address");
  }
  let addresses: readonly string[];
  try {
    addresses = isIP(hostname) ? [hostname] : await resolve(hostname);
  } catch {
    throw new Refused("not-found");
  }
  let mode: CustomNetworkMode;
  try {
    mode = classifyCustomApiAddresses(addresses);
  } catch {
    throw new Refused("destination");
  }
  if (endpoint.trim().toLowerCase().startsWith("http:") && mode !== "local")
    throw new Refused("plain-http");
  try {
    const base = holdMcpDestination(endpoint.trim(), mode).baseUrl;
    // A signal's own address, as a tool's guide often shows, saves as the base it sits under.
    return { endpoint: base.replace(/\/v1\/(?:metrics|logs|traces)$/, ""), mode };
  } catch {
    throw new Refused("address");
  }
}

async function postAll(
  connection: SavedConnection,
  bodies: Partial<Record<OtlpSignal, string>>,
  send: typeof fetch,
  headers: Headers = new Headers(),
): Promise<Partial<Record<OtlpSignal, number>>> {
  const statuses: Partial<Record<OtlpSignal, number>> = {};
  for (const signal of SIGNALS) {
    const body = bodies[signal];
    if (body === undefined) continue;
    const sent = new Headers(headers);
    sent.set("content-type", "application/json");
    const response = await send(`${connection.endpoint}/v1/${signal}`, {
      method: "POST",
      headers: sent,
      body,
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    await response.body?.cancel();
    statuses[signal] = response.status;
  }
  return statuses;
}

/**
 * A batch to the saved address - what waited up to ten minutes, or the
 * last send at quit - its kept headers applied inside Secrets. It binds the saved address and each signal's body; a body never
 * reaches the journal, only its digest.
 */
function reportBroker(
  current: () => SavedConnection | null,
  fetchFor: (saved: SavedConnection) => typeof fetch,
  named: () => readonly string[] | undefined,
): SecretBroker {
  return {
    id: USAGE_REPORT_BROKER,
    signIn: true,
    keeps: { consumer: USAGE_REPORT_CONSUMER, named },
    async prepare(input) {
      const connection = current();
      const bodies =
        input && typeof input === "object" && !Array.isArray(input) ? input.bodies : undefined;
      if (!connection || connection.headers.length === 0 || !bodies || typeof bodies !== "object")
        return undefined;
      const bound: Partial<Record<OtlpSignal, string>> = {};
      for (const [signal, body] of Object.entries(bodies)) {
        if (!SIGNALS.includes(signal as OtlpSignal) || typeof body !== "string") return undefined;
        bound[signal as OtlpSignal] = body;
      }
      const secrets = Object.fromEntries(
        connection.headers.map((header, index) => [`header${index}`, header.ref]),
      );
      return {
        facts: {
          broker: USAGE_REPORT_BROKER,
          label: m.settingsUsageConnectionTitle(),
          destination: new URL(connection.endpoint).origin,
          operation: m.settingsUsageConnectionUseOperation({
            host: new URL(connection.endpoint).host,
          }),
          inputDigest: sha256(canonical({ endpoint: connection.endpoint, bodies: bound })),
          read: false,
          result: m.settingsUsageConnectionUseResult(),
          secrets,
        },
        async run(values) {
          const headers = new Headers();
          connection.headers.forEach((header, index) => {
            const value = values[`header${index}`];
            // i18n-exempt: never shown; the broker turns a failed run into its own outcome.
            if (!value) throw new Error("Credential unavailable.");
            headers.set(header.name, value.toString("utf8"));
          });
          return postAll(connection, bound, fetchFor(connection), headers);
        },
      };
    },
  };
}

/**
 * Where the usage report goes: the company's Claude Code setup and the
 * person's own connection, which repeats nothing the setup already sends to
 * the same host. The connection's headers live behind the integrations'
 * keys, which are built after the report starts, so it joins once `keys`
 * hands them over; until then it reads as none.
 */
export function usageReportRoutes(userData: string) {
  const company = companyUsageDestinations();
  const email = claudeEmail();
  let connection: UsageConnection | undefined;
  const reads: Pick<CoreServices["usage"], "reporting" | "connection"> = {
    reporting: async () => {
      const host = connection?.host();
      return { ...(await company.reporting()), ...(host ? { connection: host } : {}) };
    },
    connection: {
      view: () => connection?.view() ?? null,
      save: async (input) => {
        if (!connection) throw new Error("The reporting connection is not ready yet.");
        return connection.save(input);
      },
      remove: async () => (await connection?.remove()) ?? null,
    },
  };
  return {
    destinations: (): readonly UsageReportDestination[] => [
      ...company.destinations(),
      ...(connection?.destinations(company.hosts()) ?? []),
    ],
    /** Builds the connection over the integrations' keys, and returns them unchanged. */
    keys(keys: IntegrationKeys): IntegrationKeys {
      connection = usageConnection({
        file: join(userData, USAGE_CONNECTION_FILE),
        keys,
        email: email.current,
      });
      return keys;
    },
    reads,
    /** The last sends as the app quits: the report's own flush, then what the connection holds. */
    stop: (flushed: () => Promise<void>): Promise<void> =>
      withinQuit(flushed().then(() => connection?.stop())),
  };
}

/**
 * Each post has its own timeout, and the report's flush and the
 * connection's signals go one after another, so a collector that never
 * answers could hold quit for half a minute; quit waits at most this long
 * for all of it, and a send still running then is lost.
 */
export const QUIT_SEND_MS = 5_000;

export function withinQuit(sends: Promise<unknown>): Promise<void> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    sends.then(() => undefined),
    new Promise<void>((done) => {
      deadline = setTimeout(done, QUIT_SEND_MS);
      deadline.unref?.();
    }),
  ]).finally(() => clearTimeout(deadline));
}

/**
 * The person's Claude Code sign-in email as the report last read it, read
 * again at most once a minute in the background, so a destination built
 * synchronously can carry it.
 */
function claudeEmail(): { current(): string | undefined } {
  let held: string | undefined;
  let readAt = Date.now();
  const reread = () => {
    const env = hostEnv();
    void claudeLoginEmail(defaultClaudeConfigDir(env), env)
      .then((found) => {
        held = found;
      })
      .catch(() => undefined);
  };
  reread();
  return {
    current() {
      if (Date.now() - readAt >= EMAIL_REREAD_MS) {
        readAt = Date.now();
        reread();
      }
      return held;
    },
  };
}

const EMAIL_REREAD_MS = 60_000;

/** The saved connection; a file there that does not parse reads as none and `unreadable`. */
function read(file: string): { saved: SavedConnection | null; unreadable: boolean } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (caught) {
    const missing = (caught as NodeJS.ErrnoException).code === "ENOENT";
    return { saved: null, unreadable: !missing };
  }
  try {
    const parsed = savedSchema.safeParse(JSON.parse(text));
    return parsed.success
      ? { saved: parsed.data, unreadable: false }
      : { saved: null, unreadable: true };
  } catch {
    return { saved: null, unreadable: true };
  }
}

/** The one file, written whole and never readable by anyone else even mid-write. */
function write(file: string, connection: SavedConnection): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(connection)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}
