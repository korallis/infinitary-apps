import { describe, expect, it } from "vitest";
import type { QuotaHttp, QuotaRequest, QuotaResponse } from "../http";
import type { ProxyApp } from "./proxyApp";
import { createProxyPoolReader, guardedProxyHttp, UNREAD_RETRY_MS } from "./proxyPools";

// The task's constraints: the reader sends only reads, never the proxy's
// usage queue, quota reset or any write; and the captain's choice asks a
// login the proxy has not read once through the proxy (docs/quota.md, "A
// proxy's pooled logins").
const APP: ProxyApp = {
  origin: "http://127.0.0.1:8317",
  port: 8317,
  key: "Mk7q2Vz9Lp4X",
  clientKey: "sk-client-one",
};
const NOW = Date.parse("2026-11-25T16:40:00Z");

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

type Sent = { url: string; method: string; body?: unknown };

function standIn(answers: (sent: Sent) => QuotaResponse): { http: QuotaHttp; sent: Sent[] } {
  const sent: Sent[] = [];
  const http: QuotaHttp = async (url: string, init: QuotaRequest) => {
    const entry: Sent = {
      url,
      method: init.method ?? "GET",
      ...(init.body ? { body: JSON.parse(new TextDecoder().decode(init.body)) } : {}),
    };
    sent.push(entry);
    return answers(entry);
  };
  return { http, sent };
}

describe("guardedProxyHttp", () => {
  const { http, sent } = standIn(() => ({ status: 200, json: {} }));
  const guarded = guardedProxyHttp(http, APP);
  const usageCall = (url: string, data?: string) => ({
    method: "POST",
    body: encode({ auth_index: "a1", method: "GET", url, header: {}, ...(data ? { data } : {}) }),
  });

  it.each([
    ["the usage queue", `${APP.origin}/v0/management/usage-queue`, { method: "GET" }],
    ["a quota reset", `${APP.origin}/v0/management/reset-quota`, { method: "POST" }],
    ["a change to a login", `${APP.origin}/v0/management/auth-files`, { method: "PATCH" }],
    ["another computer", "http://192.168.1.20:8317/v8/management/credentials", { method: "GET" }],
    ["a read with a query", `${APP.origin}/v8/management/credentials?all=1`, { method: "GET" }],
    [
      "a request tool call to another address",
      `${APP.origin}/v0/management/api-call`,
      usageCall("https://api.anthropic.com/v1/messages"),
    ],
    [
      "a request tool call that sends a body",
      `${APP.origin}/v0/management/api-call`,
      usageCall("https://api.anthropic.com/api/oauth/usage", "{}"),
    ],
  ])("refuses %s before it is sent", async (_name, url, init) => {
    await expect(guarded(url, init)).rejects.toThrow("refused proxy request");
    expect(sent).toHaveLength(0);
  });

  it("sends the reads and a usage read of a login", async () => {
    await guarded(`${APP.origin}/v8/management/credentials`, {});
    await guarded(`${APP.origin}/v1/models`, {});
    await guarded(
      `${APP.origin}/v0/management/api-call`,
      usageCall("https://chatgpt.com/backend-api/wham/usage"),
    );
    expect(sent.map((entry) => `${entry.method} ${new URL(entry.url).pathname}`)).toEqual([
      "GET /v8/management/credentials",
      "GET /v1/models",
      "POST /v0/management/api-call",
    ]);
  });
});

const unreadClaude = { provider: "claude", auth_index: "a1", status: "active", disabled: false };
const models = {
  data: [
    { id: "claude-opus-5-5", owned_by: "anthropic" },
    { id: "gpt-5.5", owned_by: "openai" },
    { id: "grok-5", owned_by: "xai" },
  ],
};
// Anthropic's usage answer, as the proxy's request tool returns it.
const usageAnswer = {
  status_code: 200,
  header: {},
  body: JSON.stringify({
    five_hour: { utilization: 25, resets_at: "2026-11-25T19:00:00Z" },
    seven_day: { utilization: 40, resets_at: "2026-11-30T09:00:00Z" },
  }),
};

describe("createProxyPoolReader", () => {
  it("asks an unread login once and keeps its answer for the next reads", async () => {
    let now = NOW;
    const { http, sent } = standIn((entry) => {
      const path = new URL(entry.url).pathname;
      if (path === "/v8/management/credentials")
        return { status: 200, json: { files: [unreadClaude] } };
      if (path === "/v1/models") return { status: 200, json: models };
      return { status: 200, json: usageAnswer };
    });
    const read = createProxyPoolReader({ app: async () => APP, http, now: () => now });

    const first = await read();
    now += 5 * 60_000;
    const second = await read();

    const asks = sent.filter((entry) => entry.url.endsWith("/api-call"));
    expect(asks).toHaveLength(1);
    expect(asks[0]?.body).toMatchObject({
      auth_index: "a1",
      method: "GET",
      url: "https://api.anthropic.com/api/oauth/usage",
      header: { Authorization: "Bearer $TOKEN$" },
    });
    for (const reading of [first, second]) {
      expect(reading?.status).toBe("ok");
      if (reading?.status !== "ok") continue;
      expect(reading.logins[0]?.windows).toEqual([
        expect.objectContaining({ id: "five_hour", percentRemaining: 75 }),
        expect.objectContaining({ id: "seven_day", percentRemaining: 60 }),
      ]);
      expect([...reading.modelPools]).toEqual([
        ["claude-opus-5-5", "claude"],
        ["gpt-5.5", "chatgpt"],
      ]);
    }
  });

  it("asks a login whose ask failed again only after the wait", async () => {
    let now = NOW;
    const { http, sent } = standIn((entry) => {
      const path = new URL(entry.url).pathname;
      if (path === "/v8/management/credentials")
        return { status: 200, json: { files: [unreadClaude] } };
      if (path === "/v1/models") return { status: 200, json: models };
      return { status: 200, json: { status_code: 429, header: {}, body: "" } };
    });
    const read = createProxyPoolReader({ app: async () => APP, http, now: () => now });
    const asks = () => sent.filter((entry) => entry.url.endsWith("/api-call")).length;

    await read();
    now += UNREAD_RETRY_MS - 1;
    await read();
    expect(asks()).toBe(1);
    now += 1;
    await read();
    expect(asks()).toBe(2);
  });

  it("reads the older route on a proxy before version 8", async () => {
    const { http, sent } = standIn((entry) => {
      const path = new URL(entry.url).pathname;
      if (path === "/v8/management/credentials") return { status: 404 };
      if (path === "/v0/management/auth-files") return { status: 200, json: { files: [] } };
      return { status: 200, json: models };
    });
    const reading = await createProxyPoolReader({ app: async () => APP, http })();
    expect(reading?.status).toBe("ok");
    expect(sent.map((entry) => new URL(entry.url).pathname).slice(0, 2)).toEqual([
      "/v8/management/credentials",
      "/v0/management/auth-files",
    ]);
  });

  it("reads a refused key as an unavailable proxy, never as spent logins", async () => {
    const { http } = standIn(() => ({ status: 401, json: { error: "invalid management key" } }));
    const reading = await createProxyPoolReader({ app: async () => APP, http })();
    expect(reading).toMatchObject({ status: "unavailable", reason: "proxy_key_refused" });
  });
});
