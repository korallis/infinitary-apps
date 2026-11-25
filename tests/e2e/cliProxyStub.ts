import { writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

/**
 * A CLI proxy on this computer, as CLIProxyAPI 8 answers its management
 * reads (docs/quota.md, "A proxy's pooled logins"): its logins' standing on
 * the credentials route, its model list for a client key, and every other
 * request passed on to the model server behind it, as the proxy routes a
 * model call. It holds one read Claude login, one read ChatGPT login with
 * credits left, and one Grok login, whose readings are relative to the
 * moment it answers.
 */
export type CliProxyStub = {
  server: Server;
  port: number;
  /** `METHOD /path` of every request it was sent, the passed-on ones included. */
  seen: string[];
  /** Writes the proxy app's settings file naming this stand-in, and answers its path. */
  writeSettings: (dir: string) => string;
};

const MANAGEMENT_KEY = "stub-management-key";
const CLIENT_KEY = "sk-stub-client";

/** The models the stand-in lists, under the owners the proxy names. */
export const CLI_PROXY_MODELS = { claude: "claude-opus-5-5", chatgpt: "gpt-5.5" } as const;

function credentials(now: number) {
  const inSeconds = (hours: number) => String(Math.floor((now + hours * 3600_000) / 1000));
  return {
    files: [
      {
        provider: "claude",
        auth_index: "a1",
        status: "active",
        disabled: false,
        requires_sign_in: false,
        quota: {
          observed_at: new Date(now).toISOString(),
          signals: {
            "Anthropic-Ratelimit-Unified-5h-Utilization": "0.62",
            "Anthropic-Ratelimit-Unified-5h-Reset": inSeconds(3),
            "Anthropic-Ratelimit-Unified-7d-Utilization": "0.31",
            "Anthropic-Ratelimit-Unified-7d-Reset": inSeconds(80),
          },
        },
      },
      {
        provider: "codex",
        auth_index: "c1",
        status: "active",
        disabled: false,
        quota: {
          observed_at: new Date(now).toISOString(),
          signals: {
            "X-Codex-Primary-Used-Percent": "12",
            "X-Codex-Primary-Window-Minutes": "300",
            "X-Codex-Primary-Reset-At": inSeconds(4),
            "X-Codex-Secondary-Used-Percent": "40",
            "X-Codex-Secondary-Window-Minutes": "10080",
            "X-Codex-Secondary-Reset-At": inSeconds(90),
            "X-Codex-Credits-Has-Credits": "true",
            "X-Codex-Credits-Balance": "15.00",
          },
        },
      },
      { provider: "xai", auth_index: "x1", status: "active", disabled: false },
    ],
  };
}

export async function startCliProxyStub(modelServerPort: number): Promise<CliProxyStub> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const path = req.url ?? "";
    seen.push(`${req.method} ${path}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path.startsWith("/v0/") || path.startsWith("/v8/")) {
      if (req.headers.authorization !== `Bearer ${MANAGEMENT_KEY}`)
        return json(401, { error: "invalid management key" });
      if (req.method === "GET" && path === "/v8/management/credentials")
        return json(200, credentials(Date.now()));
      return json(404, { error: "not found" });
    }
    if (req.method === "GET" && path === "/v1/models") {
      if (req.headers.authorization !== `Bearer ${CLIENT_KEY}`)
        return json(401, { error: "invalid api key" });
      return json(200, {
        object: "list",
        data: [
          { id: CLI_PROXY_MODELS.claude, object: "model", owned_by: "anthropic" },
          { id: CLI_PROXY_MODELS.chatgpt, object: "model", owned_by: "openai" },
        ],
      });
    }
    const upstream = request(
      { host: "127.0.0.1", port: modelServerPort, method: req.method, path, headers: req.headers },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on("error", () => json(502, { error: "model server stopped" }));
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    port,
    seen,
    writeSettings: (dir) => {
      const file = join(dir, "config.toml");
      writeFileSync(
        file,
        [
          `port = ${port}`,
          'host = ""',
          `management-secret-key = "${MANAGEMENT_KEY}"`,
          `api-keys = ["${CLIENT_KEY}"]`,
          "",
        ].join("\n"),
      );
      return file;
    },
  };
}
