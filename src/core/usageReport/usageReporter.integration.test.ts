import { writeFileSync } from "node:fs";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { DEFAULT_COST_LIMIT } from "@shared/costLimit";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type CollectorTls, collectorTlsFixture } from "../../../tests/helpers/collectorTlsFixture";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { companyReportingFrom, useSystemRootsForTests } from "../claude/claudeReporting";
import { openInMemoryDatabase } from "../storage/db";
import { homeUsage } from "../storage/homeUsage";
import { companyDestination } from "./companyDestination";

/**
 * INF-6710: the usage report reaches a company's secure collector as
 * Claude's own reports do, with the setup's certificate files or the
 * computer's trusted list, so every other provider's work arrives there too.
 * The collector is a real local HTTPS server on certificates OpenSSL made
 * for the run, under an authority no computer trusts.
 */

let tls: CollectorTls;
beforeAll(() => {
  tls = collectorTlsFixture(scratchDir("infinitary-usage-report-tls-"));
});

const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  useSystemRootsForTests();
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

/** One batch as the collector got it, and the name on the client certificate it came with. */
type Received = { path: string; headers: IncomingHttpHeaders; body: string; client?: string };

/**
 * The company's collector: a certificate its own authority signed and, with
 * `asks`, a connection only for a client certificate that authority signed.
 */
async function secureCollector(asks: boolean): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createHttpsServer(
    {
      cert: tls.serverCert,
      key: tls.serverKey,
      ...(asks ? { ca: tls.ca, requestCert: true, rejectUnauthorized: true } : {}),
    },
    (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const name = (req.socket as TLSSocket).getPeerCertificate().subject?.CN;
        received.push({
          path: req.url ?? "",
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
          ...(typeof name === "string" ? { client: name } : {}),
        });
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    },
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`, received };
}

/** A Codex crewmate call recorded in the ledger and reported from it. */
async function reportCodexCall(keys: Record<string, string>): Promise<void> {
  await (await codexReporter(keys))();
}

/** One app run's usage report under this setup: each call records a Codex crewmate call and reports it. */
async function codexReporter(keys: Record<string, string>): Promise<() => Promise<void>> {
  const setup = companyReportingFrom({
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20company-secret-token",
    ...keys,
  });
  const source = companyDestination({
    env: () => ({}),
    managed: async () => undefined,
    costReportingAllowed: async () => true,
    read: async () => setup,
    email: async () => undefined,
  });
  await source.refresh();
  const usage = homeUsage(openInMemoryDatabase(), {
    appLimit: () => DEFAULT_COST_LIMIT,
    projectLimit: () => null,
    isTask: () => false,
    hearEvents: () => {},
    reportDestinations: source.destinations,
  });
  return async () => {
    usage.recordUsage({
      taskId: "task-1",
      accountId: "acct-codex",
      model: { provider: "openai-codex", id: "gpt-5.5" },
      usage: {
        input: 1200,
        output: 340,
        cacheRead: 8000,
        cost: 0.0123,
        costSource: "listed-prices",
        costParts: { input: 0.0015, output: 0.0034, cacheRead: 0.0074 },
      },
    });
    await usage.usageReporter.flush();
  };
}

describe("the usage report to a company's secure collector", () => {
  it("reaches one on the company's own authority that takes only its client certificates", async () => {
    const collector = await secureCollector(true);
    await reportCodexCall({
      OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
      OTEL_EXPORTER_OTLP_CERTIFICATE: tls.caPath,
      OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE: tls.clientCertPath,
      OTEL_EXPORTER_OTLP_CLIENT_KEY: tls.clientKeyPath,
    });
    expect(collector.received.map((r) => r.path).sort()).toEqual(["/v1/logs", "/v1/metrics"]);
    expect(
      collector.received.map((r) => r.client),
      "every batch came with the developer's client certificate",
    ).toEqual(["dev@example.com", "dev@example.com"]);
    for (const batch of collector.received) {
      expect(batch.headers.authorization).toBe("Bearer company-secret-token");
      expect(batch.body).toContain('"stringValue":"openai-codex"');
    }
  });

  it("reaches one the computer's trusted list vouches for, with no certificate key in the setup", async () => {
    const collector = await secureCollector(false);
    useSystemRootsForTests(() => [tls.ca]);
    await reportCodexCall({ OTEL_EXPORTER_OTLP_ENDPOINT: collector.url });
    expect(collector.received.map((r) => r.path).sort()).toEqual(["/v1/logs", "/v1/metrics"]);
  });

  it("uses a certificate authority file renewed in place from the next batch", async () => {
    // A company renews its certificate files at the same paths, and the report keeps its
    // connections for the whole app run, so it must not go on sending the old file.
    const collector = await secureCollector(false);
    const renewed = join(scratchDir("infinitary-usage-report-renewal-"), "company-ca.pem");
    writeFileSync(renewed, collectorTlsFixture(scratchDir("infinitary-usage-report-old-tls-")).ca);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const report = await codexReporter({
      OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
      OTEL_EXPORTER_OTLP_CERTIFICATE: renewed,
    });
    await report();
    expect(collector.received, "the old authority does not vouch for the collector").toEqual([]);
    writeFileSync(renewed, tls.ca);
    await report();
    expect(collector.received.map((r) => r.path).sort()).toEqual(["/v1/logs", "/v1/metrics"]);
  });

  it("drops a batch to one it cannot trust, saying the connection could not be made secure", async () => {
    const collector = await secureCollector(false);
    useSystemRootsForTests(() => []);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await reportCodexCall({ OTEL_EXPORTER_OTLP_ENDPOINT: collector.url });
    expect(collector.received).toEqual([]);
    const host = new URL(collector.url).host;
    expect(warn.mock.calls.map((call) => String(call[0])).sort()).toEqual([
      `[usage report] ${host} unreachable for a logs batch (secure-connection); dropped`,
      `[usage report] ${host} unreachable for a metrics batch (secure-connection); dropped`,
    ]);
  });
});
