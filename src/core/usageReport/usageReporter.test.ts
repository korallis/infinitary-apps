import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DEFAULT_COST_LIMIT } from "@shared/costLimit";
import type { FmEvent } from "@shared/events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolveClaudeSettings } from "../claude/claudeAccess";
import {
  companyForward,
  companyReportingFrom,
  REFUSAL_LASTS_MS,
  resetRefusalsForTests,
} from "../claude/claudeReporting";
import { openInMemoryDatabase } from "../storage/db";
import { homeUsage } from "../storage/homeUsage";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { companyDestination, readManagedReporting } from "./companyDestination";
import type { UsageReportDestination } from "./usageReporter";

/**
 * INF-6587's approved plan, piece 2: Infinitary's own usage report, in one
 * format per destination, read from the ledger rows `UsageStore.record`
 * writes. The collector is a real local HTTP server reading what arrives.
 */

type Received = { path: string; headers: Record<string, string | string[] | undefined>; body: any };

let server: Server | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function collector(statuses: number[] = []): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  const listening = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => {
      text += chunk;
    });
    request.on("end", () => {
      received.push({ path: request.url ?? "", headers: request.headers, body: JSON.parse(text) });
      response.statusCode = statuses.shift() ?? 200;
      response.end("{}");
    });
  });
  server = listening;
  await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(listening.address() as AddressInfo).port}`, received };
}

function destination(
  url: string,
  format: UsageReportDestination["format"],
  name: string,
): UsageReportDestination {
  return {
    id: name,
    format,
    endpoints: {
      metrics: `${url}/${name}/v1/metrics`,
      logs: `${url}/${name}/v1/logs`,
      traces: `${url}/${name}/v1/traces`,
    },
    headers: async () => ({ authorization: "Bearer company-secret-token" }),
    resource: { "user.email": "dev@example.com", team: "platform" },
  };
}

function home(destinations: () => readonly UsageReportDestination[]) {
  const db = openInMemoryDatabase();
  const tasks = new TaskService({ db });
  seedTask(tasks, {
    id: "task-1",
    title: "Fix the login timeout",
    status: "queued",
    startPolicy: "on-request",
    shape: { kind: "fix" },
  });
  let hear: (event: FmEvent) => void = () => {};
  const usage = homeUsage(db, {
    appLimit: () => DEFAULT_COST_LIMIT,
    projectLimit: () => null,
    isTask: (taskId) => tasks.get(taskId) !== undefined,
    hearEvents: (listener) => {
      hear = listener;
    },
    reportDestinations: destinations,
  });
  return { usage, hear: (event: FmEvent) => hear(event) };
}

/** A Codex crewmate call as Pi reports it: listed prices split by category. */
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

/** A Claude crewmate result as the normalizer reports it: each served model's own share. */
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

function metricsOf(received: Received[], path: string) {
  return received
    .filter((entry) => entry.path === path)
    .flatMap((entry) => entry.body.resourceMetrics)
    .flatMap((resource: any) => resource.scopeMetrics)
    .flatMap((scope: any) => scope.metrics);
}

function attrs(point: { attributes: { key: string; value: Record<string, unknown> }[] }) {
  return Object.fromEntries(
    point.attributes.map(({ key, value }) => [key, Object.values(value)[0]]),
  );
}

/** The metric names, log event names and span names one destination received. */
function namesAt(received: Received[], prefix: string): string[] {
  const at = received.filter((entry) => entry.path.startsWith(prefix));
  return [
    ...at.flatMap((entry) =>
      (entry.body.resourceMetrics ?? []).flatMap((resource: any) =>
        resource.scopeMetrics.flatMap((scope: any) =>
          scope.metrics.map((metric: any) => metric.name),
        ),
      ),
    ),
    ...at.flatMap((entry) =>
      (entry.body.resourceLogs ?? []).flatMap((resource: any) =>
        resource.scopeLogs.flatMap((scope: any) =>
          scope.logRecords.map((record: any) => record.body.stringValue),
        ),
      ),
    ),
    ...at.flatMap((entry) =>
      (entry.body.resourceSpans ?? []).flatMap((resource: any) =>
        resource.scopeSpans.flatMap((scope: any) => scope.spans.map((span: any) => span.name)),
      ),
    ),
  ];
}

describe("UsageReporter", () => {
  it("reports every provider but Claude's own client in Claude Code's names", async () => {
    const { url, received } = await collector();
    const { usage } = home(() => [destination(url, "claude-code", "company")]);
    usage.recordUsage(CODEX_CALL);
    usage.recordUsage(CLAUDE_CALL);
    await usage.usageReporter.flush();

    const metrics = metricsOf(received, "/company/v1/metrics");
    const cost = metrics.find((metric: any) => metric.name === "claude_code.cost.usage");
    expect(cost.unit).toBe("USD");
    expect(cost.sum.dataPoints.map((point: any) => [attrs(point), point.asDouble])).toEqual([
      [
        {
          model: "gpt-5.5",
          provider: "openai-codex",
          "infinitary.role": "crewmate",
          "infinitary.work_kind": "fix",
        },
        0.0123,
      ],
    ]);
    const tokens = metrics.find((metric: any) => metric.name === "claude_code.token.usage");
    expect(tokens.sum.dataPoints.map((point: any) => [attrs(point).type, point.asInt])).toEqual([
      ["input", "1200"],
      ["output", "340"],
      ["cacheRead", "8000"],
    ]);
    const logs = received
      .filter((entry) => entry.path === "/company/v1/logs")
      .flatMap((entry) => entry.body.resourceLogs[0].scopeLogs[0].logRecords);
    expect(logs.map((record: any) => [record.body.stringValue, attrs(record)])).toEqual([
      [
        "claude_code.api_request",
        expect.objectContaining({
          "event.name": "api_request",
          model: "gpt-5.5",
          provider: "openai-codex",
          cost_usd: 0.0123,
          input_tokens: "1200",
          output_tokens: "340",
          cache_read_tokens: "8000",
        }),
      ],
    ]);
    expect(JSON.stringify(received)).not.toContain("anthropic-claude");
    expect(received.map((entry) => entry.path)).not.toContain("/company/v1/traces");
    expect(
      attrs(
        received[0]?.body.resourceMetrics?.[0]?.resource ??
          received[0]?.body.resourceLogs[0].resource,
      ),
    ).toEqual({
      "service.name": "infinitary",
      "user.email": "dev@example.com",
      team: "platform",
    });
  });

  it("reports all work, Claude's included, in the standard names with one trace per settled turn", async () => {
    const { url, received } = await collector();
    const { usage, hear } = home(() => [destination(url, "standard", "tool")]);
    hear({ type: "assistant_delta", taskId: "task-1", text: "Reading the file." });
    hear({ type: "tool_start", taskId: "task-1", callId: "call-7", toolName: "read" });
    hear({
      type: "tool_end",
      taskId: "task-1",
      callId: "call-7",
      toolName: "read",
      isError: false,
    });
    hear({ type: "tool_start", taskId: "task-1", callId: "c-1", toolName: "compact_context" });
    usage.recordUsage(CODEX_CALL);
    // A session ends a step per model call; the turn goes on until the task settles it.
    hear({ type: "turn_end", taskId: "task-1" });
    hear({ type: "tool_start", taskId: "task-1", callId: "call-8", toolName: "edit" });
    hear({
      type: "tool_end",
      taskId: "task-1",
      callId: "call-8",
      toolName: "edit",
      isError: false,
    });
    hear({ type: "turn_end", taskId: "task-1" });
    hear({ type: "turn_end", taskId: "task-1" });
    hear({
      type: "task_changed",
      taskId: "task-1",
      key: "INF-1",
      kind: "work",
      status: "active",
      from: "active",
      activity: "idle",
      closedReason: null,
      seq: 1,
    });
    usage.recordUsage({ ...CLAUDE_CALL, taskId: "firstmate" });
    await usage.usageReporter.flush();

    const metrics = metricsOf(received, "/tool/v1/metrics");
    const cost = metrics.find((metric: any) => metric.name === "infinitary.cost.usage");
    expect(
      cost.sum.dataPoints.map((point: any) => [
        attrs(point)["gen_ai.provider.name"],
        attrs(point)["infinitary.role"],
        point.asDouble,
      ]),
    ).toEqual([
      ["openai-codex", "crewmate", 0.0123],
      ["anthropic-claude", "firstmate", 0.41],
    ]);
    const tokens = metrics.find((metric: any) => metric.name === "gen_ai.client.token.usage");
    expect(
      tokens.histogram.dataPoints.map((point: any) => [
        attrs(point)["gen_ai.provider.name"],
        attrs(point)["gen_ai.token.type"],
        point.sum,
      ]),
    ).toEqual([
      ["openai-codex", "input", 1200],
      ["openai-codex", "output", 340],
      ["openai-codex", "cache_read", 8000],
      ["anthropic-claude", "input", 12],
      ["anthropic-claude", "output", 900],
      ["anthropic-claude", "cache_read", 40000],
      ["anthropic-claude", "cache_creation", 3000],
    ]);
    expect(
      received.find((entry) => entry.path === "/tool/v1/metrics")?.body.resourceMetrics[0]
        .schemaUrl,
    ).toBe("https://opentelemetry.io/schemas/1.37.0");

    const spans = received
      .filter((entry) => entry.path === "/tool/v1/traces")
      .flatMap((entry) => entry.body.resourceSpans[0].scopeSpans[0].spans);
    const turn = spans.find((span: any) => span.name === "invoke_agent crewmate");
    expect(attrs(turn)).toEqual({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "crewmate",
      "infinitary.role": "crewmate",
      "infinitary.work_kind": "fix",
    });
    for (const name of ["execute_tool read", "chat gpt-5.5", "execute_tool edit"]) {
      const child = spans.find((span: any) => span.name === name);
      expect([child.traceId, child.parentSpanId]).toEqual([turn.traceId, turn.spanId]);
    }
    expect(spans.map((span: any) => span.name).sort()).toEqual([
      "chat claude-opus-5-5",
      "chat gpt-5.5",
      "execute_tool edit",
      "execute_tool read",
      "invoke_agent crewmate",
    ]);
    expect(JSON.stringify(received)).not.toContain("Reading the file.");
    expect(JSON.stringify(received)).not.toContain("Fix the login timeout");
  });

  it("sends each destination only its own format, each call once", async () => {
    const { url, received } = await collector();
    const { usage } = home(() => [
      destination(url, "claude-code", "company"),
      destination(url, "standard", "tool"),
    ]);
    usage.recordUsage(CODEX_CALL);
    await usage.usageReporter.flush();

    expect(namesAt(received, "/company/").sort()).toEqual([
      "claude_code.api_request",
      "claude_code.cost.usage",
      "claude_code.token.usage",
    ]);
    expect(namesAt(received, "/tool/").sort()).toEqual([
      "chat gpt-5.5",
      "gen_ai.client.token.usage",
      "infinitary.cost.usage",
    ]);
    for (const [path, name] of [
      ["/company/v1/metrics", "claude_code.cost.usage"],
      ["/tool/v1/metrics", "infinitary.cost.usage"],
    ]) {
      const points = metricsOf(received, path ?? "").find((metric: any) => metric.name === name).sum
        .dataPoints;
      expect(points.map((point: any) => point.asDouble)).toEqual([0.0123]);
    }
  });

  it("drops a refused batch with one line naming no header, and sends the next", async () => {
    const { url, received } = await collector([500]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const company = destination(url, "claude-code", "company");
    const { usage } = home(() => [
      { ...company, endpoints: { metrics: company.endpoints.metrics } },
    ]);
    usage.recordUsage(CODEX_CALL);
    await usage.usageReporter.flush();
    usage.recordUsage({ ...CODEX_CALL, usage: { ...CODEX_CALL.usage, cost: 0.5 } });
    await usage.usageReporter.flush();

    expect(warn.mock.calls).toEqual([
      [
        expect.stringMatching(
          /^\[usage report\] 127\.0\.0\.1:\d+ refused a metrics batch \(HTTP 500\); dropped$/,
        ),
      ],
    ]);
    expect(received.map((entry) => entry.headers.authorization)).toEqual([
      "Bearer company-secret-token",
      "Bearer company-secret-token",
    ]);
    const second = metricsOf([received[1] as Received], "/company/v1/metrics").find(
      (metric: any) => metric.name === "claude_code.cost.usage",
    );
    expect(second.sum.dataPoints.map((point: any) => point.asDouble)).toEqual([0.5]);
  });

  it("drops a batch for an unreachable collector without failing the recording", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { usage } = home(() => [destination("http://127.0.0.1:9", "claude-code", "company")]);
    expect(() => usage.recordUsage(CODEX_CALL)).not.toThrow();
    await usage.usageReporter.flush();
    expect(warn.mock.calls.map(([line]) => line)).toEqual([
      expect.stringMatching(
        /^\[usage report\] 127\.0\.0\.1:9 unreachable for a (metrics|logs) batch/,
      ),
      expect.stringMatching(
        /^\[usage report\] 127\.0\.0\.1:9 unreachable for a (metrics|logs) batch/,
      ),
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("company-secret-token");
  });

  it("keeps nothing while there is no destination", async () => {
    const { url, received } = await collector();
    let destinations: UsageReportDestination[] = [];
    const { usage, hear } = home(() => destinations);
    hear({ type: "tool_start", taskId: "task-1", callId: "call-7", toolName: "read" });
    usage.recordUsage(CODEX_CALL);
    destinations = [destination(url, "standard", "tool")];
    await usage.usageReporter.flush();
    expect(received).toEqual([]);
  });

  it("never costs the ledger its row or the seam its event when the report fails", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { usage, hear } = home(() => {
      throw new TypeError("unreadable destinations");
    });
    expect(() => usage.recordUsage(CODEX_CALL)).not.toThrow();
    expect(() =>
      hear({ type: "tool_start", taskId: "task-1", callId: "call-7", toolName: "read" }),
    ).not.toThrow();
    expect(usage.usageStore.latestForTask("task-1")).toMatchObject({ input: 1200, cost: 0.0123 });
    expect(warn.mock.calls.map(([line]) => line)).toEqual([
      "[usage report] skipped one update (TypeError)",
      "[usage report] skipped one update (TypeError)",
    ]);
  });
});

/**
 * The company's Claude Code setup as piece 1 reads it, mapped into the
 * report's "claude-code" destination: Claude Code's guide example, sent
 * over HTTP to a local collector.
 */
function companySetup(url: string, protocol = "http/protobuf") {
  return companyReportingFrom(
    {
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: protocol,
      OTEL_EXPORTER_OTLP_ENDPOINT: `${url}/otel`,
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20your-token",
      // As the user's setup keeps it: who they are, beside the team.
      OTEL_RESOURCE_ATTRIBUTES: "user.email=dev%40example.com,department=engineering",
    },
    `printf '{"X-Team-Token":"from-helper"}'`,
  );
}

describe("the company's Claude Code setup as a destination", () => {
  it("sends other providers' calls to the setup's collector with its headers and attributes", async () => {
    const { url, received } = await collector();
    const source = companyDestination({
      env: () => ({}),
      managed: async () => undefined,
      costReportingAllowed: async () => true,
      read: async () => companySetup(url),
      email: async () => "dev@example.com",
    });
    await source.refresh();
    const { usage } = home(source.destinations);
    usage.recordUsage(CODEX_CALL);
    await usage.usageReporter.flush();

    expect(received.map((entry) => entry.path).sort()).toEqual([
      "/otel/v1/logs",
      "/otel/v1/metrics",
    ]);
    for (const entry of received) {
      expect(entry.headers.authorization).toBe("Bearer your-token");
      expect(entry.headers["x-team-token"]).toBe("from-helper");
    }
    expect(namesAt(received, "/otel")).toEqual([
      "claude_code.cost.usage",
      "claude_code.token.usage",
      "claude_code.api_request",
    ]);
    for (const entry of received) {
      const resource = (entry.body.resourceMetrics ?? entry.body.resourceLogs)[0].resource;
      expect(attrs(resource)).toEqual({
        "service.name": "infinitary",
        "user.email": "dev@example.com",
        department: "engineering",
      });
    }
    // Where Claude's own records carry who the work is for, so per-person panels count it.
    const cost = metricsOf(received, "/otel/v1/metrics").find(
      (metric: any) => metric.name === "claude_code.cost.usage",
    );
    expect(attrs(cost.sum.dataPoints[0])["user.email"]).toBe("dev@example.com");
    const event = received.find((entry) => entry.path === "/otel/v1/logs")?.body.resourceLogs[0]
      .scopeLogs[0].logRecords[0];
    expect(attrs(event)["user.email"]).toBe("dev@example.com");
  });

  it("leaves out a signal the setup sends over gRPC", async () => {
    const { url, received } = await collector();
    const source = companyDestination({
      env: () => ({}),
      managed: async () => undefined,
      costReportingAllowed: async () => true,
      read: async () => companySetup(url, "grpc"),
      email: async () => undefined,
    });
    await source.refresh();
    const { usage } = home(source.destinations);
    usage.recordUsage(CODEX_CALL);
    await usage.usageReporter.flush();
    expect(received.map((entry) => entry.path)).toEqual(["/otel/v1/logs"]);
  });

  it("sends nothing where the receiver leaves reporting to Claude's client", async () => {
    const { url, received } = await collector();
    const source = companyDestination({
      // An exporter only Claude's client can honor.
      env: () => ({ OTEL_METRICS_EXPORTER: "prometheus" }),
      managed: async () => undefined,
      costReportingAllowed: async () => true,
      read: async () => companySetup(url),
      email: async () => "dev@example.com",
    });
    await source.refresh();
    expect(source.destinations()).toEqual([]);
    const { usage } = home(source.destinations);
    usage.recordUsage(CODEX_CALL);
    await usage.usageReporter.flush();
    expect(received).toEqual([]);
  });

  it("takes the certificate files each signal's setup names, and names every model's work in Usage", async () => {
    // INF-6710: a collector that needs certificates gets every provider's work, as Claude's own records reach it.
    const needsCertificate = companyReportingFrom({
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.com:4318",
      OTEL_EXPORTER_OTLP_LOGS_CERTIFICATE: "/etc/otel/logs-ca.pem",
      OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE: "/etc/otel/client.pem",
      OTEL_EXPORTER_OTLP_CLIENT_KEY: "/etc/otel/client.key",
    });
    const source = companyDestination({
      env: () => ({}),
      managed: async () => undefined,
      costReportingAllowed: async () => true,
      read: async () => needsCertificate,
      email: async () => "dev@example.com",
    });
    await source.refresh();
    const [destination] = source.destinations();
    expect(destination?.endpoints).toEqual({
      logs: "https://collector.example.com:4318/v1/logs",
      metrics: "https://collector.example.com:4318/v1/metrics",
    });
    expect(destination?.certificates).toEqual({
      logs: {
        ca: "/etc/otel/logs-ca.pem",
        cert: "/etc/otel/client.pem",
        key: "/etc/otel/client.key",
      },
      metrics: { cert: "/etc/otel/client.pem", key: "/etc/otel/client.key" },
    });
    expect(await source.reporting()).toEqual({ host: "collector.example.com:4318" });
  });

  it("sends other providers' calls to a managed setup's collector, which Claude's client reports to", async () => {
    const { url, received } = await collector();
    const managedResolve = async () =>
      ({
        effective: {},
        sources: [
          {
            source: "managed",
            settings: {
              env: {
                CLAUDE_CODE_ENABLE_TELEMETRY: "1",
                OTEL_METRICS_EXPORTER: "otlp",
                OTEL_LOGS_EXPORTER: "otlp",
                OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
                OTEL_EXPORTER_OTLP_ENDPOINT: `${url}/managed`,
                OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20managed-token",
                OTEL_RESOURCE_ATTRIBUTES: "department=finance",
              },
            },
          },
        ],
      }) as unknown as Awaited<ReturnType<ResolveClaudeSettings>>;
    const source = companyDestination({
      env: () => ({}),
      managed: (env) => readManagedReporting(env, managedResolve),
      // The receiver steps aside under a managed setup; the person's own setup is not used.
      costReportingAllowed: async () => false,
      read: async () => companySetup(url),
      email: async () => "dev@example.com",
    });
    await source.refresh();
    const { usage } = home(source.destinations);
    usage.recordUsage(CODEX_CALL);
    usage.recordUsage(CLAUDE_CALL);
    await usage.usageReporter.flush();

    expect(received.map((entry) => entry.path).sort()).toEqual([
      "/managed/v1/logs",
      "/managed/v1/metrics",
    ]);
    for (const entry of received) {
      expect(entry.headers.authorization).toBe("Bearer managed-token");
      const resource = (entry.body.resourceMetrics ?? entry.body.resourceLogs)[0].resource;
      expect(attrs(resource)).toEqual({ "service.name": "infinitary", department: "finance" });
    }
    expect(JSON.stringify(received)).toContain("openai-codex");
    expect(JSON.stringify(received)).not.toContain("anthropic-claude");
  });

  it("sends nothing under a managed policy helper, whose answer is never known here", async () => {
    const { url, received } = await collector();
    const source = companyDestination({
      env: () => ({}),
      managed: (env) =>
        readManagedReporting(
          env,
          async () =>
            ({
              effective: {},
              sources: [
                {
                  source: "managed",
                  settings: {
                    policyHelper: "/usr/local/bin/policy",
                    env: {
                      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
                      OTEL_LOGS_EXPORTER: "otlp",
                      OTEL_EXPORTER_OTLP_ENDPOINT: `${url}/managed`,
                    },
                  },
                },
              ],
            }) as unknown as Awaited<ReturnType<ResolveClaudeSettings>>,
        ),
      costReportingAllowed: async () => false,
      read: async () => companySetup(url),
      email: async () => "dev@example.com",
    });
    await source.refresh();
    expect(source.destinations()).toEqual([]);
    const { usage } = home(source.destinations);
    usage.recordUsage(CODEX_CALL);
    await usage.usageReporter.flush();
    expect(received).toEqual([]);
  });

  it("names in Settings → Usage where the report sends, or else where only Claude's records go", async () => {
    const { url } = await collector();
    const sourceWith = (
      managed: Awaited<ReturnType<typeof readManagedReporting>>,
      own: ReturnType<typeof companySetup>,
    ) =>
      companyDestination({
        env: () => ({}),
        managed: async () => managed,
        costReportingAllowed: async () => managed === undefined,
        read: async () => own,
        email: async () => undefined,
      });
    const host = new URL(url).host;
    const managed = companyReportingFrom({
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com",
    });
    const grpcOnly = companyReportingFrom({
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
      OTEL_EXPORTER_OTLP_ENDPOINT: url,
    });
    expect(await sourceWith(managed, undefined).reporting()).toEqual({ host: "otel.example.com" });
    expect(await sourceWith(undefined, companySetup(url)).reporting()).toEqual({ host });
    expect(await sourceWith(undefined, grpcOnly).reporting()).toEqual({ host, claudeOnly: true });
    const managedGrpc = companyReportingFrom({
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com:4317",
    });
    expect(await sourceWith(managedGrpc, undefined).reporting()).toEqual({
      host: "otel.example.com:4317",
      claudeOnly: true,
    });
    // A managed policy helper: Claude's client reports somewhere this app cannot know.
    expect(await sourceWith(null, companySetup(url)).reporting()).toEqual({ host: null });
    expect(await sourceWith(undefined, undefined).reporting()).toEqual({ host: null });
  });

  describe("while its collector keeps refusing", () => {
    afterEach(() => resetRefusalsForTests());

    it("warns beside the person's own setup, and not beside a managed one", async () => {
      const { url } = await collector([403, 403]);
      const host = new URL(url).host;
      const refusing = companyReportingFrom({
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        OTEL_LOGS_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_ENDPOINT: url,
      });
      if (!refusing) throw new Error("the setup reads as a setup");
      // The forward's first refusal came a minute before the read.
      let at = Date.now() - REFUSAL_LASTS_MS;
      const forward = companyForward(refusing, {}, () => {}, { now: () => at });
      await forward.send("logs", Buffer.from("{}"), "application/json");
      at = Date.now();
      await forward.send("logs", Buffer.from("{}"), "application/json");
      const sourceWith = (managed: typeof refusing | undefined) =>
        companyDestination({
          env: () => ({}),
          managed: async () => managed,
          costReportingAllowed: async () => true,
          read: async () => refusing,
          email: async () => undefined,
        });
      expect(await sourceWith(undefined).reporting()).toEqual({
        host,
        refusal: { host, reason: "refused" },
      });
      expect(await sourceWith(refusing).reporting()).toEqual({ host });
    });
  });
});
