import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { DEFAULT_COST_LIMIT } from "@shared/costLimit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { integrationKeys } from "../../../tests/helpers/integrationKeys";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { openInMemoryDatabase } from "../storage/db";
import { homeUsage } from "../storage/homeUsage";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import type { CompanyHosts } from "./companyDestination";
import {
  QUIT_SEND_MS,
  USAGE_CONNECTION_FILE,
  type UsageConnection,
  usageConnection,
  withinQuit,
} from "./usageConnection";

/**
 * INF-6587's approved plan, piece 3: the reporting connection a person adds
 * in Settings → Intelligence, its headers kept in Secrets, sending the
 * crew's usage once saved. The collector is a real local HTTP server and
 * Secrets the real controller over disposable custody.
 */

type Received = { path: string; headers: Record<string, string | string[] | undefined>; body: any };

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
});

async function collector(): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  const listening = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => {
      text += chunk;
    });
    request.on("end", () => {
      received.push({ path: request.url ?? "", headers: request.headers, body: JSON.parse(text) });
      response.end("{}");
    });
  });
  servers.push(listening);
  await new Promise<void>((done) => listening.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${(listening.address() as AddressInfo).port}`, received };
}

const TOKEN = "glc_invented-grafana-cloud-token";

function setup(
  resolve?: (hostname: string) => Promise<string[]>,
  options: { email?: string; company?: CompanyHosts } = {},
) {
  const secrets = integrationKeys();
  const file = join(scratchDir("usage-connection-"), USAGE_CONNECTION_FILE);
  const connection = usageConnection({
    file,
    keys: secrets.keys,
    ...(resolve ? { resolve } : {}),
    ...(options.email ? { email: () => options.email } : {}),
  });
  const db = openInMemoryDatabase();
  const tasks = new TaskService({ db });
  seedTask(tasks, {
    id: "task-1",
    title: "Fix the login timeout",
    status: "queued",
    startPolicy: "on-request",
    shape: { kind: "fix" },
  });
  const usage = homeUsage(db, {
    appLimit: () => DEFAULT_COST_LIMIT,
    projectLimit: () => null,
    isTask: (taskId) => tasks.get(taskId) !== undefined,
    hearEvents: () => {},
    reportDestinations: () => connection.destinations(options.company),
  });
  return { secrets, file, connection, usage };
}

/** A Codex crewmate call as Pi reports it. */
const CODEX_CALL = {
  taskId: "task-1",
  accountId: "acct-codex",
  model: { provider: "openai-codex", id: "gpt-5.5" },
  usage: {
    input: 1200,
    output: 340,
    cacheRead: 8000,
    cost: 0.0123,
    costSource: "listed-prices" as const,
    costParts: { input: 0.0015, output: 0.0034, cacheRead: 0.0074 },
  },
};

/** A Claude crewmate result as the normalizer reports it. */
const CLAUDE_CALL = {
  taskId: "task-1",
  accountId: "acct-claude",
  model: { provider: "anthropic-claude", id: "claude-opus-5-5" },
  usage: {
    input: 12,
    output: 900,
    cacheRead: 40000,
    cacheWrite: 3000,
    cost: 0.41,
    costSource: "claude" as const,
    models: [
      {
        model: "claude-opus-5-5",
        input: 12,
        output: 900,
        cacheRead: 40000,
        cacheWrite: 3000,
        cost: 0.41,
        costSource: "claude" as const,
      },
    ],
  },
};

function metricsAt(received: Received[], path: string) {
  return received
    .filter((entry) => entry.path === path)
    .flatMap((entry) => entry.body.resourceMetrics)
    .flatMap((resource: any) => resource.scopeMetrics)
    .flatMap((scope: any) => scope.metrics);
}

/** Each point's model, by Claude Code's `model` or the conventions' `gen_ai.*.model`. */
function modelsOf(metric: any): string[] {
  return metric.sum.dataPoints.map(
    (point: any) =>
      point.attributes.find((attribute: any) => /(^|\.)model$/.test(attribute.key)).value
        .stringValue,
  );
}

async function save(connection: UsageConnection, url: string, extra = {}) {
  return connection.save({
    endpoint: url,
    format: "standard",
    headers: [{ name: "Authorization", value: `Bearer ${TOKEN}` }],
    ...extra,
  });
}

describe("usageConnection", () => {
  it("sends what waits once, with its kept header, without asking and without the value on disk", async () => {
    const { url, received } = await collector();
    const { secrets, file, connection, usage } = setup();
    expect(await save(connection, url)).toEqual({
      saved: true,
      view: { endpoint: url, format: "standard", headers: [{ name: "Authorization" }] },
    });

    usage.recordUsage(CODEX_CALL);
    await usage.usageReporter.flush();
    usage.recordUsage({ ...CODEX_CALL, model: { provider: "openai-codex", id: "gpt-5.5-mini" } });
    await usage.usageReporter.flush();
    expect(received).toEqual([]);
    await connection.stop();

    expect(received.map((entry) => entry.path).sort()).toEqual(["/v1/metrics", "/v1/traces"]);
    for (const entry of received) expect(entry.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const costs = metricsAt(received, "/v1/metrics").filter(
      (metric: any) => metric.name === "infinitary.cost.usage",
    );
    expect(costs.flatMap(modelsOf).sort()).toEqual(["gpt-5.5", "gpt-5.5-mini"]);
    expect(secrets.cards).toEqual([]);
    expect((await secrets.keys.view()).history).toHaveLength(1);
    expect(readFileSync(file, "utf8")).not.toContain(TOKEN);
  });

  it("sends Claude's own work from the ledger in Claude Code's format", async () => {
    const { url, received } = await collector();
    const { connection, usage } = setup();
    await save(connection, url, { format: "claude-code", headers: [] });
    usage.recordUsage(CODEX_CALL);
    usage.recordUsage(CLAUDE_CALL);
    await usage.usageReporter.flush();
    await connection.stop();

    const cost = metricsAt(received, "/v1/metrics").find(
      (metric: any) => metric.name === "claude_code.cost.usage",
    );
    expect(modelsOf(cost).sort()).toEqual(["claude-opus-5-5", "gpt-5.5"]);
  });

  it("saves a signal's own address as the base it sits under", async () => {
    const { url } = await collector();
    const { connection } = setup();
    const saved = await save(connection, `${url}/v1/traces`, { headers: [] });
    expect(saved.saved && saved.view?.endpoint).toBe(url);
  });

  it("names why an address or header cannot be saved", async () => {
    const { url } = await collector();
    const publicName = async () => ["93.184.215.14"];
    const { connection } = setup(publicName);
    const problem = async (input: Parameters<UsageConnection["save"]>[0]) => {
      const saved = await connection.save(input);
      return saved.saved ? "saved" : saved.problem;
    };
    const plain = { format: "standard" as const, headers: [] };
    expect(await problem({ endpoint: "ftp://otel.example.com", ...plain })).toBe("address");
    expect(await problem({ endpoint: "http://otel.example.com", ...plain })).toBe("plain-http");
    expect(
      await problem({
        endpoint: url,
        format: "standard",
        headers: [{ name: "Authorization" }],
      }),
    ).toBe("header-value");
    expect(
      await problem({
        endpoint: url,
        format: "standard",
        headers: [{ name: "Bad Name", value: "x" }],
      }),
    ).toBe("header");
    const missing = setup(async () => {
      throw new Error("ENOTFOUND");
    }).connection;
    const lost = await missing.save({ endpoint: "https://otel.invalid", ...plain });
    expect(lost.saved ? "saved" : lost.problem).toBe("not-found");
    expect(connection.view()).toBeNull();
  });

  it("keeps a header's value on an edit at the same address, and asks for it again at a new one", async () => {
    const first = await collector();
    const second = await collector();
    const { secrets, connection } = setup();
    await save(connection, first.url);
    const kept = (await secrets.entries()).map((entry) => entry.ref);

    const edited = await connection.save({
      endpoint: first.url,
      format: "claude-code",
      headers: [{ name: "Authorization" }],
    });
    expect(edited.saved).toBe(true);
    expect((await secrets.entries()).map((entry) => entry.ref)).toEqual(kept);

    const moved = await connection.save({
      endpoint: second.url,
      format: "standard",
      headers: [{ name: "Authorization" }],
    });
    expect(moved).toEqual({ saved: false, problem: "header-value" });
  });

  // docs/usage-report.md, "The person's reporting connection": a save that changes the address or format drops what waits.
  it("drops what waits when a save changes the format, and keeps it for an edit of the headers alone", async () => {
    const { url, received } = await collector();
    const { connection, usage } = setup();
    await save(connection, url);
    usage.recordUsage(CODEX_CALL);
    await usage.usageReporter.flush();
    await connection.save({
      endpoint: url,
      format: "standard",
      headers: [{ name: "Authorization", value: "Bearer glc_invented-rotated-token" }],
    });
    await connection.stop();
    expect(received.map((entry) => entry.path).sort()).toEqual(["/v1/metrics", "/v1/traces"]);
    expect(received[0]?.headers.authorization).toBe("Bearer glc_invented-rotated-token");

    received.length = 0;
    usage.recordUsage(CODEX_CALL);
    await usage.usageReporter.flush();
    await connection.save({
      endpoint: url,
      format: "claude-code",
      headers: [{ name: "Authorization" }],
    });
    await connection.stop();
    expect(received).toEqual([]);
  });

  it("forgets the kept headers and what waits when removed", async () => {
    const { url, received } = await collector();
    const { secrets, file, connection, usage } = setup();
    await save(connection, url);
    expect(await secrets.entries()).toHaveLength(1);
    usage.recordUsage(CODEX_CALL);
    await usage.usageReporter.flush();

    expect(await connection.remove()).toBeNull();
    expect(await secrets.entries()).toEqual([]);
    expect(() => readFileSync(file)).toThrow();
    expect(connection.destinations()).toEqual([]);

    const next = await collector();
    await connection.save({ endpoint: next.url, format: "standard", headers: [] });
    await connection.stop();
    expect(received).toEqual([]);
    expect(next.received).toEqual([]);
  });

  it("names the person by their Claude Code sign-in email on each record, in both formats", async () => {
    const { url, received } = await collector();
    const { connection, usage } = setup(undefined, { email: "ana@example.com" });
    await save(connection, url, { headers: [] });
    usage.recordUsage(CODEX_CALL);
    await usage.usageReporter.flush();
    await connection.stop();
    await connection.save({ endpoint: url, format: "claude-code", headers: [] });
    usage.recordUsage(CODEX_CALL);
    await usage.usageReporter.flush();
    await connection.stop();

    const emails = (metric: any) =>
      (metric.sum ?? metric.histogram).dataPoints.map(
        (point: any) =>
          point.attributes.find((attribute: any) => attribute.key === "user.email")?.value
            .stringValue,
      );
    const metrics = metricsAt(received, "/v1/metrics");
    const standard = metrics.find((metric: any) => metric.name === "infinitary.cost.usage");
    const claudeCode = metrics.find((metric: any) => metric.name === "claude_code.cost.usage");
    expect(emails(standard)).toEqual(["ana@example.com"]);
    expect(emails(claudeCode)).toEqual(["ana@example.com"]);
  });

  it("sends nothing to a host the company setup already sends every model's work to", async () => {
    const { url, received } = await collector();
    const { connection, usage } = setup(undefined, {
      company: { allWork: ["127.0.0.1"], claudeWork: "127.0.0.1" },
    });
    await save(connection, url, { headers: [] });
    usage.recordUsage(CODEX_CALL);
    await usage.usageReporter.flush();
    await connection.stop();
    expect(received).toEqual([]);
  });

  it("leaves out Claude's work where Claude's own client already reports to the same host", async () => {
    const { url, received } = await collector();
    const { connection, usage } = setup(undefined, {
      company: { allWork: [], claudeWork: "127.0.0.1" },
    });
    await save(connection, url, { format: "claude-code", headers: [] });
    usage.recordUsage(CODEX_CALL);
    usage.recordUsage(CLAUDE_CALL);
    await usage.usageReporter.flush();
    await connection.stop();

    const cost = metricsAt(received, "/v1/metrics").find(
      (metric: any) => metric.name === "claude_code.cost.usage",
    );
    expect(modelsOf(cost)).toEqual(["gpt-5.5"]);
  });

  it("marks its kept headers as the reporting connection's, and offers Forget only on one it no longer names", async () => {
    const { url } = await collector();
    const { secrets, connection } = setup();
    await save(connection, url);
    const [named] = await secrets.entries();
    // An entry a crash left between keeping it and saving the connection.
    const left = await secrets.keys.keepHidden({
      label: "Usage reporting: X-Team",
      value: Buffer.from("invented-left-over", "utf8"),
      consumer: "usage-report",
    });
    const view = await secrets.keys.view();
    expect(view.entries.find((entry) => entry.ref === named?.ref)).toMatchObject({
      kept: true,
      consumer: "usage-report",
    });
    expect(view.entries.find((entry) => entry.ref === named?.ref)?.unnamed).toBeUndefined();
    expect(view.entries.find((entry) => entry.ref === left)).toMatchObject({
      kept: true,
      consumer: "usage-report",
      unnamed: true,
    });

    await secrets.keys.action({ kind: "forget", ref: named?.ref ?? "" });
    expect((await secrets.keys.view()).question).toBeNull();
    await secrets.keys.action({ kind: "forget", ref: left ?? "" });
    expect((await secrets.keys.view()).question?.about).toEqual({ kind: "forget", ref: left });
  });

  it("forgets a header no saved connection names once its broker joins an open Secrets, and none while the file is damaged", async () => {
    const leftOver = async (secrets: ReturnType<typeof integrationKeys>) =>
      secrets.keys.keepHidden({
        label: "Usage reporting: X-Team",
        value: Buffer.from("invented-left-over", "utf8"),
        consumer: "usage-report",
      });
    const fresh = integrationKeys();
    const swept = await leftOver(fresh);
    usageConnection({
      file: join(scratchDir("usage-connection-"), USAGE_CONNECTION_FILE),
      keys: fresh.keys,
    });
    await fresh.keys.view();
    expect((await fresh.entries()).map((entry) => entry.ref)).not.toContain(swept);

    const damaged = integrationKeys();
    const kept = await leftOver(damaged);
    const file = join(scratchDir("usage-connection-"), USAGE_CONNECTION_FILE);
    writeFileSync(file, "{ damaged");
    const connection = usageConnection({ file, keys: damaged.keys });
    expect(connection.view()).toBeNull();
    await damaged.keys.view();
    expect((await damaged.entries()).map((entry) => entry.ref)).toContain(kept);
  });

  it("lets quit go once the deadline passes while a send never answers", async () => {
    vi.useFakeTimers();
    try {
      let gone = false;
      void withinQuit(new Promise(() => undefined)).then(() => {
        gone = true;
      });
      await vi.advanceTimersByTimeAsync(QUIT_SEND_MS - 1);
      expect(gone).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(gone).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
