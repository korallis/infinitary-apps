import type { ManagedAuth } from "./auth";

export type QuotaResponse = {
  status: number;
  json?: unknown;
  bytes?: Uint8Array;
  /** Response headers, lower-cased. gRPC-web puts its verdict here. */
  headers?: Record<string, string>;
  /** RFC 9110 Retry-After, verbatim, when the vendor sent one. */
  retryAfter?: string;
};

export type QuotaRequest = {
  method?: string;
  headers?: Record<string, string>;
  /** A request body, for a vendor whose meter is a POST (Grok gRPC-web). */
  body?: Uint8Array<ArrayBuffer>;
  /**
   * How to read the answer. `json` (the default) parses the body; `bytes`
   * returns it raw, for a binary (gRPC-web) meter. Either way the body is
   * read bounded and refused past the limit before it is parsed.
   */
  responseType?: "json" | "bytes";
  /**
   * The most the answer may be. BODY_LIMIT_BYTES unless a reader names its
   * own: an account's model list is legitimately larger than a meter.
   */
  limitBytes?: number;
  /**
   * The caller's own cancel, beside the transport's 15 s bound. The request
   * and the read of its body both stop when it fires.
   */
  signal?: AbortSignal;
  /**
   * What a redirect answer does: followed (the default), or `error`, which
   * fails the request as `network` before a second request is sent.
   */
  redirect?: "follow" | "error";
};

export type QuotaHttp = (url: string, init: QuotaRequest) => Promise<QuotaResponse>;

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * The most a meter or a decision model (Jev, or one through OpenRouter) may
 * answer with, JSON or binary. A usage reading is about a kilobyte and a
 * usage config about a hundred bytes; anything approaching this is not the
 * response we asked for, and it is refused before it is buffered.
 */
export const BODY_LIMIT_BYTES = 64 * 1024;

/**
 * Why a request did not produce an answer, in our own vocabulary. A thrown
 * request used to be indistinguishable from a 429 (both became `error`), which
 * is what made the 2026-09-04 quota investigation need a second machine.
 * `oversized` is a body that ran past its limit: never read to the end,
 * never parsed. `aborted` is the caller's own cancel; a caller whose signal
 * is a deadline (`AbortSignal.timeout`) gets `timeout`, as from ours.
 */
export type QuotaTransportFailure = "timeout" | "network" | "oversized" | "aborted";

export class QuotaTransportError extends Error {
  constructor(readonly failure: QuotaTransportFailure) {
    super(`quota request ${failure}`);
    this.name = "QuotaTransportError";
  }
}

export function createQuotaHttp(fetchImpl: typeof fetch = fetch): QuotaHttp {
  return async (url, init) => {
    const deadline = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: init.method ?? "GET",
        headers: init.headers,
        ...(init.body ? { body: init.body } : {}),
        ...(init.redirect ? { redirect: init.redirect } : {}),
        signal,
      });
    } catch (caught) {
      // The abort signals are the only stops we set; everything else the
      // platform throws here is the network not answering.
      throw new QuotaTransportError(failureOf(caught, init.signal));
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const retryAfter = headers["retry-after"];
    const base = { status: response.status, headers, ...(retryAfter ? { retryAfter } : {}) };
    const bytes = await readBoundedBody(response, init.limitBytes ?? BODY_LIMIT_BYTES, init.signal);
    if (init.responseType === "bytes") return { ...base, bytes };
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      json = undefined;
    }
    return { ...base, json };
  };
}

/**
 * Read a body without ever holding more than `limit` bytes of it: the
 * declared length is checked first, and a stream that runs past the limit
 * is cancelled where it stands. Also bounds a reply another reader (Pi's
 * classifier) would otherwise read whole (`pi/decisionModels.ts`).
 */
export async function readBoundedBody(
  response: Response,
  limit: number,
  caller: AbortSignal | undefined,
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new QuotaTransportError("oversized");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) {
        await reader.cancel().catch(() => undefined);
        throw new QuotaTransportError("oversized");
      }
      chunks.push(value);
    }
  } catch (caught) {
    if (caught instanceof QuotaTransportError) throw caught;
    throw new QuotaTransportError(failureOf(caught, caller));
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

/**
 * What stopped a request. The caller's cancel is named apart from our own
 * deadline, so a decision cut short by its caller is not recorded as a slow
 * vendor.
 */
function failureOf(caught: unknown, caller: AbortSignal | undefined): QuotaTransportFailure {
  if (caller?.aborted) {
    const reason = caller.reason as { name?: unknown } | undefined;
    return reason?.name === "TimeoutError" ? "timeout" : "aborted";
  }
  return isTimeout(caught) ? "timeout" : "network";
}

function isTimeout(caught: unknown): boolean {
  const name = (caught as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

export function requestHeaders(
  auth: ManagedAuth,
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = { ...extra, ...auth.headers };
  const hasAuth = Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
  if (!hasAuth && auth.apiKey) {
    headers.Authorization = `Bearer ${auth.apiKey}`;
  }
  return headers;
}

/**
 * A 401 is the vendor's verdict on the credential. A 403 is NOT: it is also
 * how a network policy or WAF refuses a request, so it is treated as an
 * ordinary failure and never as evidence that a sign-in is needed.
 */
export function isAuthFailure(status: number): boolean {
  return status === 401;
}

export function isRateLimited(status: number): boolean {
  return status === 429;
}

export function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}
