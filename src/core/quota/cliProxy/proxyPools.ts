import type { QuotaPoolKind } from "@shared/quota";
import { type QuotaHttp, QuotaTransportError } from "../http";
import { asRecord, asString } from "../json";
import { CLAUDE_USAGE_URL, parseClaudeUsage } from "../providers/claude";
import { CODEX_USAGE_URL, parseCodexUsage } from "../providers/codex";
import { type ProxyLogin, parseProxyCredentials } from "./credentials";
import type { ProxyApp } from "./proxyApp";

/**
 * The only requests the proxy reader sends (docs/quota.md, "A proxy's
 * pooled logins"). Each is a read: the logins' standing, the proxy's model
 * list, and one usage read through the proxy for a login it has not read.
 * Its usage queue is never asked - asking empties it - and nothing that
 * changes the proxy is ever sent.
 */
export const PROXY_ROUTES = {
  credentials: "/v8/management/credentials",
  credentialsBefore8: "/v0/management/auth-files",
  models: "/v1/models",
  apiCall: "/v0/management/api-call",
} as const;

/** The vendor addresses an unread login may be asked at, through the proxy. */
export const PROXY_USAGE_URLS: Record<QuotaPoolKind, string> = {
  claude: CLAUDE_USAGE_URL,
  chatgpt: CODEX_USAGE_URL,
};

/** A login whose ask failed is asked again no sooner than this. */
export const UNREAD_RETRY_MS = 10 * 60 * 1000;

/** The credentials answer grows with each login; a meter's 64 KB is too small. */
const CREDENTIALS_LIMIT_BYTES = 4 * 1024 * 1024;
const MODELS_LIMIT_BYTES = 1024 * 1024;

/**
 * The request seam every proxy request goes through. Anything but the four
 * reads above, to anywhere but the proxy's own origin, is refused before it
 * is sent.
 */
export function guardedProxyHttp(http: QuotaHttp, app: ProxyApp): QuotaHttp {
  return (url, init) => {
    const method = (init.method ?? "GET").toUpperCase();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return Promise.reject(new Error("refused proxy request"));
    }
    const allowed =
      parsed.origin === app.origin &&
      parsed.search === "" &&
      ((method === "GET" &&
        [PROXY_ROUTES.credentials, PROXY_ROUTES.credentialsBefore8, PROXY_ROUTES.models].includes(
          parsed.pathname as never,
        )) ||
        (method === "POST" &&
          parsed.pathname === PROXY_ROUTES.apiCall &&
          apiCallAllowed(init.body)));
    if (!allowed) return Promise.reject(new Error("refused proxy request"));
    return http(url, init);
  };
}

function apiCallAllowed(body: Uint8Array | undefined): boolean {
  if (!body) return false;
  try {
    const call = asRecord(JSON.parse(new TextDecoder().decode(body)));
    return (
      asString(call?.method) === "GET" &&
      Object.values(PROXY_USAGE_URLS).includes(asString(call?.url) ?? "") &&
      (call?.data === undefined || call.data === "")
    );
  } catch {
    return false;
  }
}

/** What one read of the proxy found. */
export type ProxyReading =
  | {
      status: "ok";
      port: number;
      logins: ProxyLogin[];
      /** Each model the proxy lists, by the pool its owner names. */
      modelPools: Map<string, QuotaPoolKind>;
      atMs: number;
    }
  | {
      /** The proxy app runs, but did not answer, or refused its own key. */
      status: "unavailable";
      port: number;
      reason: string;
      atMs: number;
    };

type Asked = {
  atMs: number;
  /** What the vendor answered, while the proxy has no reading of its own. */
  reading?: Pick<ProxyLogin, "windows" | "credits">;
  failed?: true;
};

const POOL_OF_OWNER: Record<string, QuotaPoolKind> = {
  anthropic: "claude",
  openai: "chatgpt",
};

/**
 * Reads the proxy's logins on each call. A serving login the proxy has not
 * read is asked once through the proxy's own request tool (the captain's
 * choice, docs/quota.md), and its answer stands in until the proxy reads the
 * login itself; a failed ask is tried again after `UNREAD_RETRY_MS`.
 */
export function createProxyPoolReader(options: {
  app: () => Promise<ProxyApp | undefined>;
  http: QuotaHttp;
  now?: () => number;
}): () => Promise<ProxyReading | undefined> {
  const now = options.now ?? Date.now;
  const asked = new Map<string, Asked>();
  return async () => {
    const app = await options.app();
    if (!app) return undefined;
    const http = guardedProxyHttp(options.http, app);
    const management = { Authorization: bearer(app.key), Accept: "application/json" };
    const atMs = now();
    let answer = await read(http, `${app.origin}${PROXY_ROUTES.credentials}`, management);
    // A proxy before version 8 answers the same listing on its older route.
    if (answer.status === 404)
      answer = await read(http, `${app.origin}${PROXY_ROUTES.credentialsBefore8}`, management);
    if (answer.status !== 200 || !answer.json) {
      return {
        status: "unavailable",
        port: app.port,
        reason:
          answer.status === 401 ? "proxy_key_refused" : (answer.failure ?? `http_${answer.status}`),
        atMs,
      };
    }
    const logins = parseProxyCredentials(answer.json, atMs);
    const modelPools = await listModelPools(http, app);
    const filled = await Promise.all(
      logins.map((login) => fillUnread(http, app, login, asked, atMs)),
    );
    return { status: "ok", port: app.port, logins: filled, modelPools, atMs };
  };
}

async function read(
  http: QuotaHttp,
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; json?: unknown; failure?: string }> {
  try {
    const result = await http(url, { headers, limitBytes: CREDENTIALS_LIMIT_BYTES });
    return { status: result.status, json: result.json };
  } catch (caught) {
    return {
      status: 0,
      failure: caught instanceof QuotaTransportError ? caught.failure : "sensor_error",
    };
  }
}

/**
 * The proxy's model list, each model under the pool its owner names
 * (`owned_by`: anthropic is Claude, openai is ChatGPT). A model of any other
 * owner, and every model when the list cannot be read, has no pool.
 */
async function listModelPools(http: QuotaHttp, app: ProxyApp): Promise<Map<string, QuotaPoolKind>> {
  const pools = new Map<string, QuotaPoolKind>();
  try {
    const result = await http(`${app.origin}${PROXY_ROUTES.models}`, {
      headers: {
        Accept: "application/json",
        ...(app.clientKey ? { Authorization: bearer(app.clientKey) } : {}),
      },
      limitBytes: MODELS_LIMIT_BYTES,
    });
    const data = asRecord(result.json)?.data;
    if (result.status !== 200 || !Array.isArray(data)) return pools;
    for (const raw of data) {
      const model = asRecord(raw);
      const id = asString(model?.id);
      const pool = POOL_OF_OWNER[asString(model?.owned_by)?.toLowerCase() ?? ""];
      if (id && pool) pools.set(id, pool);
    }
  } catch {
    return pools;
  }
  return pools;
}

async function fillUnread(
  http: QuotaHttp,
  app: ProxyApp,
  login: ProxyLogin,
  asked: Map<string, Asked>,
  atMs: number,
): Promise<ProxyLogin> {
  const key = login.authIndex ? `${login.kind}:${login.authIndex}` : undefined;
  if (!key || login.windows !== undefined) {
    // The proxy reads it now: its own reading is the one kept.
    if (key && login.windows !== undefined) asked.delete(key);
    return login;
  }
  if (login.state !== "serving") return login;
  const before = asked.get(key);
  if (before?.reading) return { ...login, ...before.reading };
  if (before && (!before.failed || atMs - before.atMs < UNREAD_RETRY_MS)) return login;
  const reading = await askUsage(http, app, login, atMs);
  asked.set(key, reading ? { atMs, reading } : { atMs, failed: true });
  return reading ? { ...login, ...reading } : login;
}

/**
 * One usage read of one login through the proxy's request tool: the proxy
 * puts the login's own token in place of `$TOKEN$`, so Infinitary never holds
 * it. The answer is parsed by the same reader a direct sign-in's is.
 */
async function askUsage(
  http: QuotaHttp,
  app: ProxyApp,
  login: ProxyLogin,
  atMs: number,
): Promise<Pick<ProxyLogin, "windows" | "credits"> | undefined> {
  const header: Record<string, string> =
    login.kind === "claude"
      ? {
          Authorization: bearer("$TOKEN$"),
          "anthropic-beta": "oauth-2025-04-20",
          Accept: "application/json",
        }
      : {
          Authorization: bearer("$TOKEN$"),
          Accept: "application/json",
          ...(login.chatgptAccount ? { "chatgpt-account-id": login.chatgptAccount } : {}),
        };
  const call = {
    auth_index: login.authIndex,
    method: "GET",
    url: PROXY_USAGE_URLS[login.kind],
    header,
  };
  try {
    const result = await http(`${app.origin}${PROXY_ROUTES.apiCall}`, {
      method: "POST",
      headers: {
        Authorization: bearer(app.key),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: new TextEncoder().encode(JSON.stringify(call)),
    });
    const answer = asRecord(result.json);
    if (result.status !== 200 || answer?.status_code !== 200) return undefined;
    const body = JSON.parse(asString(answer.body) ?? "") as unknown;
    const parsed =
      login.kind === "claude" ? parseClaudeUsage(body, atMs) : parseCodexUsage(body, atMs);
    // A window with no share left in the answer says nothing about the pool.
    const windows = parsed.windows.flatMap((window) =>
      window.percentRemaining === undefined
        ? []
        : [
            {
              id: window.id,
              label: window.label,
              percentRemaining: window.percentRemaining,
              ...(window.resetsAtMs !== undefined ? { resetsAtMs: window.resetsAtMs } : {}),
            },
          ],
    );
    if (windows.length === 0) return undefined;
    return {
      windows,
      ...(parsed.credits ? { credits: parsed.credits } : {}),
    };
  } catch {
    return undefined;
  }
}

function bearer(token: string): string {
  return `Bearer ${token}`; // i18n-exempt: an HTTP header value
}
