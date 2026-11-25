import type { UsageReporting } from "@shared/usage";
import { type ResolveClaudeSettings, resolveSettings } from "../claude/claudeAccess";
import { claudeCostReportingAllowed } from "../claude/claudeCostPolicy";
import { hasClaudeReporting } from "../claude/claudeCostReports";
import { claudeLoginEmail, defaultClaudeConfigDir } from "../claude/claudeQuota";
import {
  type ClaudeCompanyReporting,
  companyHeaders,
  companyReportingFrom,
  isReportingKey,
  lastingRefusal,
  parseOtlpHeaders,
  readClaudeCompanyReporting,
  receiverStepsAside,
} from "../claude/claudeReporting";
import { hostEnv } from "../hostEnv";
import type { UsageReportDestination } from "./usageReporter";

/** The company setup is read again at most this often, as the reporter asks on every heard event. */
const SETUP_REREAD_MS = 60_000;

export type CompanyDestinationDeps = {
  env(): NodeJS.ProcessEnv;
  /**
   * The administrator's managed setup: undefined when it sets no reporting,
   * null when it does but cannot be read here (a policy helper, or no OTLP).
   */
  managed(env: NodeJS.ProcessEnv): Promise<ClaudeCompanyReporting | null | undefined>;
  costReportingAllowed(): Promise<boolean>;
  read(env: NodeJS.ProcessEnv): Promise<ClaudeCompanyReporting | undefined>;
  /** The person's own Claude Code login's email, which Claude's records carry as `user.email`. */
  email(env: NodeJS.ProcessEnv): Promise<string | undefined>;
};

/**
 * The company's Claude Code reporting setup (`claudeReporting.ts`) as the
 * report's one "claude-code" destination: Claude's own records already reach
 * it through the receiver, so every other provider's calls go there under
 * Claude Code's names, with the setup's headers and resource attributes and
 * the person's Claude Code login email where Claude's records carry it.
 *
 * A managed setup comes first: Claude's own client reports there itself,
 * and every other provider's calls go there too. Otherwise the person's own
 * setup, unless the receiver steps aside (`receiverStepsAside`), the rule
 * Settings → Usage names its host by.
 * A signal the setup sends over gRPC takes no JSON request, so it is left
 * out; Claude's own records still reach it through the receiver or Claude's
 * own client. A signal's certificate files go with its requests.
 * The line warns while the person's own setup keeps refusing the receiver's
 * forward (`lastingRefusal`); a managed collector's answers reach only
 * Claude's client, so it carries no refusal.
 */
export function companyDestination(deps: CompanyDestinationDeps): {
  destinations(): readonly UsageReportDestination[];
  refresh(): Promise<void>;
  reporting(): Promise<UsageReporting>;
} {
  let held: readonly UsageReportDestination[] = [];
  /** The setup read last, where Claude's own records go even when the report cannot send there. */
  let setupHost: string | null = null;
  /** The person's own setup read last, whose collector the receiver passes Claude's records on to. */
  let ownSetup: ClaudeCompanyReporting | undefined;
  let readAt = Number.NEGATIVE_INFINITY;
  let reading: Promise<void> | undefined;

  const refresh = (): Promise<void> => {
    readAt = Date.now();
    reading ??= (async () => {
      const env = deps.env();
      const managed = await deps.managed(env).catch(() => null);
      const setup =
        managed !== undefined
          ? (managed ?? undefined)
          : !receiverStepsAside(env) && (await deps.costReportingAllowed().catch(() => false))
            ? await deps.read(env).catch(() => undefined)
            : undefined;
      const email = setup ? await deps.email(env).catch(() => undefined) : undefined;
      held = setup ? toDestination(setup, deps.env, email) : [];
      setupHost = setup?.host ?? null;
      ownSetup = managed === undefined ? setup : undefined;
    })().finally(() => {
      reading = undefined;
    });
    return reading;
  };

  return {
    destinations() {
      if (Date.now() - readAt >= SETUP_REREAD_MS) void refresh();
      return held;
    },
    refresh,
    /**
     * Settings → Usage's line: where the report sends every other model's
     * work, or else where only Claude's own records go: a managed setup's
     * client, or the receiver for the person's own, reports Claude's work to
     * a setup the report cannot send to over gRPC.
     */
    async reporting() {
      await refresh();
      const refusal = ownSetup ? lastingRefusal(ownSetup) : undefined;
      const endpoint = held[0]?.endpoints.logs ?? held[0]?.endpoints.metrics;
      const line: UsageReporting = endpoint
        ? { host: new URL(endpoint).host }
        : setupHost
          ? { host: setupHost, claudeOnly: true }
          : { host: null };
      return refusal ? { ...line, refusal } : line;
    },
  };
}

function toDestination(
  setup: ClaudeCompanyReporting,
  env: () => NodeJS.ProcessEnv,
  email: string | undefined,
): UsageReportDestination[] {
  const endpoints: UsageReportDestination["endpoints"] = {};
  const certificates: NonNullable<UsageReportDestination["certificates"]> = {};
  for (const signal of ["logs", "metrics"] as const) {
    const found = setup.signals[signal];
    if (!found || found.protocol === "grpc") continue;
    endpoints[signal] = found.endpoint;
    if (found.tls) certificates[signal] = found.tls;
  }
  if (!endpoints.logs && !endpoints.metrics) return [];
  const serviceName = setup.clientEnv.OTEL_SERVICE_NAME?.trim();
  return [
    {
      id: "company-claude-code",
      format: "claude-code",
      endpoints,
      ...(Object.keys(certificates).length > 0 ? { certificates } : {}),
      headers: (signal) =>
        signal === "traces" ? Promise.resolve({}) : companyHeaders(setup, signal, env()),
      // OTLP's resource attribute list has the header list's shape.
      resource: {
        ...parseOtlpHeaders(setup.clientEnv.OTEL_RESOURCE_ATTRIBUTES),
        ...(serviceName ? { "service.name": serviceName } : {}),
      },
      ...(email ? { person: { "user.email": email } } : {}),
    },
  ];
}

/** The production source: the app's environment, the managed policy and the person's setup. */
export function companyUsageDestinations(): ReturnType<typeof companyDestination> {
  return companyDestination({
    env: () => hostEnv(),
    managed: (env) => readManagedReporting(env),
    costReportingAllowed: () => claudeCostReportingAllowed(),
    read: (env) => readClaudeCompanyReporting(env),
    email: (env) => claudeLoginEmail(defaultClaudeConfigDir(env), env),
  });
}

/**
 * The reporting setup an administrator manages for the whole computer, as
 * Claude Code lays it over the environment it starts in. Read from the
 * managed tier only, as `claudeCostReportingAllowed` reads it.
 */
export async function readManagedReporting(
  launch: NodeJS.ProcessEnv,
  resolve: ResolveClaudeSettings = resolveSettings,
): Promise<ClaudeCompanyReporting | null | undefined> {
  let resolved: Awaited<ReturnType<ResolveClaudeSettings>>;
  try {
    resolved = await resolve({ settingSources: [] });
  } catch {
    return null;
  }
  const keys: Record<string, string> = {};
  for (const [key, value] of Object.entries(launch))
    if (isReportingKey(key) && value !== undefined) keys[key] = value;
  let managed = false;
  let helper: string | undefined;
  for (const tier of resolved.sources) {
    if (tier.source !== "managed") continue;
    const settings = tier.settings as {
      env?: Record<string, unknown>;
      otelHeadersHelper?: unknown;
      policyHelper?: unknown;
    };
    // What a policy helper prints at Claude's startup is never known here.
    if (settings.policyHelper !== undefined) return null;
    const env = settings.env && typeof settings.env === "object" ? settings.env : {};
    const strings: Record<string, string> = {};
    for (const [key, value] of Object.entries(env))
      if (typeof value === "string" || typeof value === "number") strings[key] = String(value);
    if (!hasClaudeReporting(strings)) continue;
    managed = true;
    for (const [key, value] of Object.entries(strings)) if (isReportingKey(key)) keys[key] = value;
    if (typeof settings.otelHeadersHelper === "string" && settings.otelHeadersHelper.trim())
      helper = settings.otelHeadersHelper.trim();
  }
  if (!managed) return undefined;
  return companyReportingFrom(keys, helper) ?? null;
}
