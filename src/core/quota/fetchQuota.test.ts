import { KEYCHAIN_VALUE_FAILURE_DETAIL, QUOTA_TO_PI_PROVIDER, servedModelKey } from "@shared/quota";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { clearKeychainLock, readClaudeStore } from "../claude/claudeQuota";
import type { HostKeychain } from "../host";
import { QUOTA_PROVIDERS, type QuotaAuth, type QuotaProviderId } from "./auth";
import { buildModelsCatalog } from "./catalog";
import { managedFromClaudeStore } from "./claudeAuthResolve";
import { createQuotaFetcher } from "./fetchQuota";
import { type QuotaHttp, QuotaTransportError } from "./http";
import { keychainFailureOutcome, type ProviderOutcome } from "./outcome";
import { paceForWindow } from "./pace";
import { fetchClaudeQuota, parseClaudeUsage } from "./providers/claude";
import { chatgptAccountId, parseCodexUsage } from "./providers/codex";
import { fetchGrokQuota, GROK_NO_WINDOW_DETAIL } from "./providers/grok";

const NOW = Date.parse("2026-08-14T12:00:00Z");

describe("provider parsers", () => {
  it("maps Codex primary/secondary slots by duration", () => {
    const parsed = parseCodexUsage(
      {
        plan_type: "plus",
        rate_limit: {
          primary_window: {
            used_percent: 26,
            reset_after_seconds: 3600,
            limit_window_seconds: 18_000,
          },
          secondary_window: {
            used_percent: 40,
            reset_after_seconds: 86_400,
            limit_window_seconds: 604_800,
          },
        },
      },
      NOW,
    );
    expect(parsed.plan).toBe("plus");
    expect(parsed.windows[0]).toMatchObject({
      id: "five_hour",
      label: "session",
      percentRemaining: 74,
    });
    expect(parsed.windows[1]).toMatchObject({
      id: "weekly",
      label: "weekly",
      percentRemaining: 60,
    });
  });

  it("names a Codex primary slot by its own length when it is the 7-day window", () => {
    // A Pro plan's reading: the week arrives as primary_window, with no secondary.
    const parsed = parseCodexUsage(
      {
        plan_type: "pro",
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: {
            used_percent: 3,
            limit_window_seconds: 604_800,
            reset_after_seconds: 518_400,
          },
          secondary_window: null,
        },
      },
      NOW,
    );
    expect(parsed.windows).toHaveLength(1);
    expect(parsed.windows[0]).toMatchObject({
      id: "weekly",
      label: "weekly",
      percentRemaining: 97,
      windowSeconds: 604_800,
      resetsAtMs: NOW + 518_400_000,
    });
  });

  it("names a Codex slot by its position only when it gives no length", () => {
    const parsed = parseCodexUsage(
      {
        rate_limit: {
          primary_window: { used_percent: 10, reset_after_seconds: 3600 },
          secondary_window: { used_percent: 20, reset_after_seconds: 86_400 },
        },
      },
      NOW,
    );
    expect(parsed.windows.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "five_hour", label: "session" },
      { id: "weekly", label: "weekly" },
    ]);
  });

  it("reads chatgpt_account_id from a Codex JWT", () => {
    const payload = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" } }),
    ).toString("base64url");
    expect(chatgptAccountId(`eyJhbGciOiJub25lIn0.${payload}.sig`)).toBe("acct_1");
  });

  it("keeps the api-key credits probe, and discloses when it carries no credit fields", async () => {
    const withCredits = await fetchGrokQuota(
      async () => ({ status: 200, json: { remaining_credits: 40, credit_limit: 80 } }),
      { apiKey: "xai-key", usingOAuth: false },
      NOW,
    );
    expect(withCredits.status).toBe("ok");
    expect(withCredits.windows[0]).toMatchObject({ id: "credits", percentRemaining: 50 });

    const without = await fetchGrokQuota(
      async () => ({ status: 200, json: { name: "key" } }),
      { apiKey: "xai-key", usingOAuth: false },
      NOW,
    );
    expect(without).toMatchObject({
      status: "not_measured",
      windows: [],
      detail: GROK_NO_WINDOW_DETAIL,
    });
  });

  it("reads Claude usage the way the vendor's own client does", () => {
    // The shape below is the live response captured 2026-09-04: `limits` is
    // the authoritative list, model scopes are objects, and the top level
    // also carries unreleased codenames with the very same window shape.
    const parsed = parseClaudeUsage(
      {
        five_hour: { utilization: 4, resets_at: "2026-08-14T15:00:00Z" },
        seven_day: { utilization: 66, resets_at: "2026-08-20T00:00:00Z" },
        nimbus_quill: { utilization: 0, resets_at: null },
        tangelo: null,
        extra_usage: { is_enabled: false, utilization: 0 },
        limits: [
          { kind: "session", group: "session", percent: 4, resets_at: "2026-08-14T15:00:00Z" },
          { kind: "weekly_all", group: "weekly", percent: 66, resets_at: "2026-08-20T00:00:00Z" },
          {
            kind: "weekly_scoped",
            group: "weekly",
            percent: 64,
            resets_at: "2026-08-20T00:00:00Z",
            scope: { model: { id: null, display_name: "Fable" } },
          },
        ],
        note: "hi",
        count: 3,
      },
      NOW,
    );
    expect(parsed.windows.map((window) => window.id)).toEqual([
      "five_hour",
      "model:fable",
      "seven_day",
    ]);
    const byId = new Map(parsed.windows.map((window) => [window.id, window]));
    expect(byId.get("five_hour")).toMatchObject({
      label: "session",
      percentRemaining: 96,
      windowSeconds: 18_000,
      resetsAtMs: Date.parse("2026-08-14T15:00:00Z"),
    });
    expect(byId.get("seven_day")).toMatchObject({ percentRemaining: 34, windowSeconds: 604_800 });
    expect(byId.get("model:fable")).toMatchObject({
      label: "Fable weekly",
      percentRemaining: 36,
      windowSeconds: 604_800,
    });
  });

  it("keeps a one-percent Claude limits session from looking exhausted", () => {
    const parsed = parseClaudeUsage(
      {
        limits: [
          { kind: "session", group: "session", percent: 1, resets_at: "2026-08-14T15:00:00Z" },
        ],
      },
      NOW,
    );

    expect(parsed.windows).toMatchObject([{ id: "five_hour", percentRemaining: 99 }]);
  });

  it("reads top-level Claude utilization as whole percents, so 1 is 1% used", () => {
    // The live response carries the same number in `utilization` and in
    // `limits[].percent` (4 and 4, 66 and 66), so a value at or below 1 is a
    // small percent, never a fraction of the whole.
    const remaining = (utilization: number) =>
      parseClaudeUsage(
        { five_hour: { utilization, resets_at: "2026-08-14T15:00:00Z" } },
        NOW,
      ).windows.map((window) => window.percentRemaining);

    expect(remaining(0)).toEqual([100]);
    expect(remaining(0.5)).toEqual([99.5]);
    expect(remaining(1)).toEqual([99]);
    expect(remaining(2)).toEqual([98]);
    expect(remaining(100)).toEqual([0]);
  });

  it("never renders a vendor codename or a switched-off feature as a meter", () => {
    const parsed = parseClaudeUsage(
      {
        five_hour: { utilization: 4, resets_at: "2026-08-14T15:00:00Z" },
        nimbus_quill: { utilization: 0, resets_at: "2026-08-20T00:00:00Z" },
        cinder_cove: { utilization: 0, resets_at: "2026-08-20T00:00:00Z" },
        extra_usage: { is_enabled: false, utilization: 0 },
      },
      NOW,
    );
    expect(parsed.windows.map((window) => window.id)).toEqual(["five_hour"]);
  });

  it("shows purchased extra usage only while it is switched on", () => {
    const parsed = parseClaudeUsage({ extra_usage: { is_enabled: true, utilization: 25 } }, NOW);
    expect(parsed.windows).toMatchObject([{ id: "extra_usage", percentRemaining: 75 }]);
  });

  it("falls back to the top-level periods when the response has no limits list", () => {
    const parsed = parseClaudeUsage(
      { five_hour: { utilization: 25 }, seven_day_opus: { utilization: 12 } },
      NOW,
    );
    expect(parsed.windows.map((window) => window.id)).toEqual(["five_hour", "seven_day_opus"]);
    expect(parsed.windows[0]?.percentRemaining).toBe(75);
  });

  it("fetches Claude usage with the account token and treats 401/403 as the verdict", async () => {
    const seen: { url?: string; headers?: Record<string, string> } = {};
    const ok = await fetchClaudeQuota(
      async (url, init) => {
        seen.url = url;
        seen.headers = init.headers ?? {};
        return {
          status: 200,
          json: { five_hour: { utilization: 10, resets_at: "2026-08-14T15:00:00Z" } },
        };
      },
      { apiKey: "access-token", usingOAuth: true },
      NOW,
    );
    expect(ok.status).toBe("ok");
    expect(ok.windows).toHaveLength(1);
    expect(seen.url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(seen.headers?.Authorization).toBe("Bearer access-token");
    expect(seen.headers?.["anthropic-beta"]).toBe("oauth-2025-04-20");

    const denied = await fetchClaudeQuota(
      async () => ({ status: 401, json: {} }),
      { apiKey: "stale", usingOAuth: true },
      NOW,
    );
    expect(denied).toMatchObject({ status: "auth_required", reason: "vendor_rejected" });

    // A 403 is also how a network policy or WAF refuses. It is not a verdict
    // on the credential and must never read as "sign in again".
    const forbidden = await fetchClaudeQuota(
      async () => ({ status: 403, json: {} }),
      { apiKey: "fine", usingOAuth: true },
      NOW,
    );
    expect(forbidden).toMatchObject({ status: "unavailable", reason: "http_403" });

    const limited = await fetchClaudeQuota(
      async () => ({ status: 429, json: {}, retryAfter: "120" }),
      { apiKey: "fine", usingOAuth: true },
      NOW,
    );
    expect(limited).toMatchObject({ status: "rate_limited", retryAfter: "120" });

    const missing = await fetchClaudeQuota(
      async () => ({ status: 200, json: {} }),
      { usingOAuth: true },
      NOW,
    );
    expect(missing).toMatchObject({ status: "unavailable", reason: "credential_unavailable" });
  });
});

describe("pace and reset text", () => {
  it("classifies ahead/on_pace/behind against the linear clock", () => {
    const resetsAtMs = NOW + 9_000 * 1000;
    expect(
      paceForWindow({ percentRemaining: 20, resetsAtMs, windowSeconds: 18_000, now: NOW }),
    ).toBe("ahead");
    expect(
      paceForWindow({ percentRemaining: 50, resetsAtMs, windowSeconds: 18_000, now: NOW }),
    ).toBe("on_pace");
    expect(
      paceForWindow({ percentRemaining: 80, resetsAtMs, windowSeconds: 18_000, now: NOW }),
    ).toBe("behind");
  });
});

describe("createQuotaFetcher (per-account sensor)", () => {
  const account = (accountId: string, quotaId: QuotaProviderId, accountLabel = "Personal") => {
    const entry = QUOTA_PROVIDERS.find((provider) => provider.quotaId === quotaId);
    if (!entry) throw new Error(`no quota provider ${quotaId}`);
    return {
      accountId,
      accountLabel,
      quotaId,
      piId: entry.piId,
      providerLabel: entry.label,
    };
  };

  it("fetches once per account and isolates one account's failure from its siblings", async () => {
    const resolve = vi.fn(async (accountId: string) => {
      if (accountId === "acct_grok") throw new Error("boom");
      return { apiKey: `key-for-${accountId}`, usingOAuth: true };
    });
    const auth: QuotaAuth = {
      accounts: () => [
        account("acct_c1", "codex", "Personal"),
        account("acct_c2", "codex", "Work #2"),
        account("acct_grok", "grok"),
        account("acct_claude", "claude"),
      ],
      resolve,
    };
    const http: QuotaHttp = async (url) => {
      if (url.includes("chatgpt.com")) return { status: 500, json: { error: "nope" } };
      if (url.includes("api.anthropic.com")) {
        return {
          status: 200,
          json: { five_hour: { utilization: 8, resets_at: "2026-08-14T15:00:00Z" } },
        };
      }
      throw new Error(`unexpected ${url}`);
    };
    const fetchQuota = createQuotaFetcher({
      auth,
      http,
      models: () => [{ provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5" }],
      now: () => NOW,
    });
    const { snapshot, catalog } = await fetchQuota();
    const byAccount = Object.fromEntries(
      snapshot.providers.map((provider) => [provider.accountId, provider]),
    );
    expect(byAccount.acct_c1).toMatchObject({
      provider: "codex",
      accountLabel: "Personal",
      status: "unavailable",
      reason: "http_500",
    });
    expect(byAccount.acct_c2).toMatchObject({ accountLabel: "Work #2", status: "unavailable" });
    // The store could not be read at all. That is not knowing, not a
    // sign-out: it must never clear the account's card.
    expect(byAccount.acct_grok).toMatchObject({
      status: "unavailable",
      reason: "credential_unavailable",
    });
    expect(byAccount.acct_claude?.status).toBe("ok");
    expect(resolve).toHaveBeenCalledWith("acct_c1", { allowPrompt: false });
    expect(resolve).toHaveBeenCalledWith("acct_c2", { allowPrompt: false });
    expect(catalog.models[0]?.id).toBe("gpt-5.5");
  });

  it("reports a fresh ok reading as the vendor accepting that login, not a cached one", async () => {
    const accepted: string[] = [];
    const http = vi.fn(async () => ({
      status: 200,
      json: { five_hour: { utilization: 8, resets_at: "2026-08-14T15:00:00Z" } },
    }));
    const fetchQuota = createQuotaFetcher({
      auth: {
        accounts: () => [account("acct_claude", "claude")],
        resolve: async () => ({ apiKey: "k", usingOAuth: true }),
      },
      http,
      models: () => [],
      now: () => NOW,
      onAccepted: (accountId, windows) => accepted.push(`${accountId}:${windows.length}`),
    });
    await fetchQuota();
    await fetchQuota();
    // With the sensor's own windows, for a hold that a top-up ends early.
    expect(accepted).toEqual(["acct_claude:1"]);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it("never throws when a provider HTTP call throws", async () => {
    const fetchQuota = createQuotaFetcher({
      auth: {
        accounts: () => [account("a1", "codex"), account("a2", "grok")],
        resolve: async () => ({ apiKey: "k", usingOAuth: true }),
      },
      http: async () => {
        throw new Error("socket hang up");
      },
      models: () => [],
      now: () => NOW,
    });
    const { snapshot } = await fetchQuota();
    expect(snapshot.providers).toHaveLength(2);
    expect(snapshot.providers.every((provider) => provider.status === "unavailable")).toBe(true);
  });

  it("does not read ambient credentials: no accounts means no HTTP at all", async () => {
    const http = vi.fn(async () => ({ status: 200, json: {} }));
    const fetchQuota = createQuotaFetcher({
      auth: { accounts: () => [], resolve: async () => undefined },
      http,
      models: () => [],
      now: () => NOW,
    });
    const { snapshot } = await fetchQuota();
    expect(http).not.toHaveBeenCalled();
    expect(snapshot.providers).toEqual([]);
  });
});

describe("buildModelsCatalog across accounts", () => {
  // FI3-1806: a row names its provider by allowance id (claude, codex, grok),
  // and every comparison with a served model goes through servedModelKey.
  it("names each row so it matches the served model it was built from", () => {
    const served = [
      { provider: "anthropic-claude", id: "claude-opus-5-5", name: "Claude Opus 5.5" },
      { provider: "openai-codex", id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
      { provider: "xai", id: "grok-4.7", name: "Grok 4.7" },
      { provider: "kimi-coding", id: "k3", name: "Kimi K3" },
      { provider: "github-copilot", id: "claude-opus-5.5", name: "Claude Opus 5.5" },
    ];
    const catalog = buildModelsCatalog(served, [], "2026-10-15T12:00:00Z");
    expect(catalog.models.map((row) => row.provider).sort()).toEqual(
      Object.keys(QUOTA_TO_PI_PROVIDER).sort(),
    );
    expect(catalog.models.map(servedModelKey).sort()).toEqual(served.map(servedModelKey).sort());
  });

  it("takes the best account's headroom as a model's effective remaining", () => {
    const catalog = buildModelsCatalog(
      [{ provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5" }],
      [
        {
          provider: "codex",
          label: "Codex",
          accountId: "acct_low",
          accountLabel: "Personal",
          status: "ok",
          stale: false,
          windows: [{ id: "weekly", label: "weekly", percentRemaining: 8, pace: "behind" }],
        },
        {
          provider: "codex",
          label: "Codex",
          accountId: "acct_high",
          accountLabel: "Work #2",
          status: "ok",
          stale: false,
          windows: [{ id: "weekly", label: "weekly", percentRemaining: 62, pace: "ahead" }],
        },
      ],
      "2026-08-14T12:00:00Z",
    );
    expect(catalog.models[0]).toMatchObject({
      id: "gpt-5.5",
      effectivePercentRemaining: 62,
      paceStatus: "ahead",
    });
  });

  it("orders models by spend priority computed from fixture windows", () => {
    // Constructed readings: claude's account-wide scalar is 0.8130 and
    // codex's 0.6933, so claude ranks first even though codex has far more
    // raw headroom (88% vs 40%). By hand, at 3h of 5h and 1.75 of 7 days
    // left: codex gap = (88 - 0.48 * 75) / 75 = 0.69333; claude 5h gap =
    // (90 - 0.25 * 60) / 60 = 1.25 and 7d gap = (40 - 0.8 * 25) / 25 = 0.8,
    // cycle-weighted to 506,340 / 622,800 = 0.81301; the fable window adds
    // gap (42 - (58 / 75) * 25) / 25 = 0.90667, giving 0.85915.
    const parityNow = Date.parse("2026-10-14T12:00:00.000Z");
    const catalog = buildModelsCatalog(
      [
        { provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5" },
        { provider: "anthropic-claude", id: "claude-opus-5-5", name: "Claude Opus 5.5" },
        { provider: "anthropic-claude", id: "claude-fable-5", name: "Claude Fable 5" },
      ],
      [
        {
          provider: "codex",
          label: "Codex",
          accountId: "acct_codex",
          accountLabel: "Personal",
          status: "ok",
          stale: false,
          windows: [
            {
              id: "weekly",
              label: "weekly",
              percentRemaining: 88,
              resetsAtMs: Date.parse("2026-10-19T18:00:00.000Z"),
              windowSeconds: 604_800,
            },
          ],
        },
        {
          provider: "claude",
          label: "Claude",
          accountId: "acct_claude",
          accountLabel: "Personal Max",
          status: "ok",
          stale: false,
          windows: [
            {
              id: "five_hour",
              label: "session",
              percentRemaining: 90,
              resetsAtMs: Date.parse("2026-10-14T15:00:00.000Z"),
              windowSeconds: 18_000,
            },
            {
              id: "seven_day",
              label: "weekly",
              percentRemaining: 40,
              resetsAtMs: Date.parse("2026-10-16T06:00:00.000Z"),
              windowSeconds: 604_800,
            },
            {
              id: "model:fable",
              label: "Fable week",
              percentRemaining: 42,
              resetsAtMs: Date.parse("2026-10-16T06:00:00.000Z"),
              windowSeconds: 604_800,
            },
          ],
        },
      ],
      "2026-10-14T12:00:00.000Z",
      parityNow,
    );
    expect(catalog.models.map((model) => model.id)).toEqual([
      "claude-fable-5",
      "claude-opus-5-5",
      "gpt-5.5",
    ]);
    const byId = new Map(catalog.models.map((model) => [model.id, model]));
    // The account-wide scope serves models without a model window...
    expect(byId.get("claude-opus-5-5")?.spendPriority).toBeCloseTo(0.813, 3);
    expect(byId.get("gpt-5.5")?.spendPriority).toBeCloseTo(0.6933, 3);
    // ...and the fable model window narrows only its own model's scope.
    expect(byId.get("claude-fable-5")?.spendPriority).toBeCloseTo(0.8591, 3);
    // The model window never drags the account-wide minimum down: opus's
    // effective remaining is bounded by five_hour+seven_day only.
    expect(byId.get("claude-opus-5-5")?.effectivePercentRemaining).toBe(40);
  });

  it("keeps a model unmeasured when no account has usable windows", () => {
    const catalog = buildModelsCatalog(
      [{ provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5" }],
      [
        {
          provider: "codex",
          label: "Codex",
          accountId: "acct_1",
          accountLabel: "Personal",
          status: "auth_required",
          stale: false,
          windows: [],
        },
      ],
      "2026-08-14T12:00:00Z",
    );
    expect(catalog.models[0]?.effectivePercentRemaining).toBeUndefined();
  });
});

/**
 * Session-pushed quota (the unsensed-provider path, and mid-session
 * freshening): rows recorded from a session's own readings enter the
 * snapshot from a separate source and have to reach routing exactly like
 * every fetched row. The mechanics are provider-agnostic and tested with a
 * claude-shaped row.
 */
describe("session-pushed quota in the snapshot", () => {
  const pushedRow = {
    provider: "claude",
    label: "Claude",
    accountId: "acct_claude",
    accountLabel: "Personal Max",
    status: "ok" as const,
    stale: false,
    windows: [
      { id: "five_hour", label: "session", percentRemaining: 55, pace: "on_pace" as const },
    ],
  };

  it("merges pushed rows into the same snapshot as fetched ones", async () => {
    const fetcher = createQuotaFetcher({
      auth: {
        accounts: () => [
          {
            accountId: "acct_codex",
            accountLabel: "Personal",
            quotaId: "codex" as const,
            piId: "openai-codex",
            providerLabel: "Codex",
          },
        ],
        resolve: async () => ({ apiKey: "k", usingOAuth: true }),
      },
      http: async () => ({ status: 200, json: {} }),
      models: () => [],
      pushed: () => [pushedRow],
      now: () => 1_000,
    });

    const { snapshot } = await fetcher();
    expect(snapshot.providers.map((row) => row.provider)).toEqual(["codex", "claude"]);
    expect(snapshot.providers[1]).toMatchObject({
      accountId: "acct_claude",
      accountLabel: "Personal Max",
    });
  });

  it("lays what the account's own sessions said over its sensed row, on every outcome", async () => {
    const seen: string[] = [];
    const fetcher = createQuotaFetcher({
      auth: {
        accounts: () => [
          {
            accountId: "acct_claude",
            accountLabel: "Personal",
            quotaId: "claude" as const,
            piId: "anthropic-claude",
            providerLabel: "Claude",
          },
          {
            accountId: "acct_codex",
            accountLabel: "Work",
            quotaId: "codex" as const,
            piId: "openai-codex",
            providerLabel: "Codex",
          },
        ],
        resolve: async (accountId) => {
          if (accountId === "acct_codex") throw new Error("store unreadable");
          return { apiKey: "k", usingOAuth: true };
        },
      },
      http: async () => {
        throw new Error("boom");
      },
      models: () => [],
      overlay: (view, now) => {
        seen.push(`${view.accountId}@${now}`);
        return { ...view, reason: "overlaid" };
      },
      now: () => 1_000,
    });
    const { snapshot } = await fetcher();
    expect(seen.sort()).toEqual(["acct_claude@1000", "acct_codex@1000"]);
    expect(snapshot.providers.every((row) => row.reason === "overlaid")).toBe(true);
  });
});

/**
 * A backend with no renewer answers `unsupported`; the vendor's own 401 then
 * stands as the verdict rather than being rewritten into a renewal failure.
 */
describe("a vendor 401 with no renewer", () => {
  it("stands, rather than becoming renewal_unsupported", async () => {
    const result = await createQuotaFetcher({
      auth: {
        accounts: () => [
          {
            accountId: "acct_codex",
            accountLabel: "Personal",
            quotaId: "codex" as const,
            piId: "openai-codex",
            providerLabel: "Codex",
          },
        ],
        resolve: async () => ({ apiKey: "dead", usingOAuth: true }),
        renew: async () => ({ outcome: "unsupported" }),
      },
      http: async () => ({ status: 401, json: {} }),
      models: () => [],
      now: () => NOW,
    })();
    expect(result.snapshot.providers[0]).toMatchObject({
      status: "auth_required",
      reason: "vendor_rejected",
    });
  });
});

/**
 * The credential lifecycle the captain's Settings depends on: routine expiry
 * has to recover on its own, and every way recovery can fail to happen has to
 * stay distinguishable from "this sign-in is finished".
 */
describe("delegated renewal (routine expiry recovers without a sign-in)", () => {
  const claudeAccount = {
    accountId: "acct_claude",
    accountLabel: "Personal",
    quotaId: "claude" as const,
    piId: "anthropic-claude",
    providerLabel: "Claude",
  };
  const usage = { five_hour: { utilization: 8, resets_at: "2026-08-14T15:00:00Z" } };

  const fetcherWith = (auth: QuotaAuth, http: QuotaHttp) =>
    createQuotaFetcher({ auth, http, models: () => [], now: () => NOW });

  const rowOf = async (auth: QuotaAuth, http: QuotaHttp) =>
    (await fetcherWith(auth, http)()).snapshot.providers[0];

  it("renews after a vendor rejection and retries once - the reading lands", async () => {
    const seen: string[] = [];
    const renew = vi.fn(async () => ({
      outcome: "renewed" as const,
      auth: { apiKey: "fresh", usingOAuth: true },
    }));
    const row = await rowOf(
      {
        accounts: () => [claudeAccount],
        resolve: async () => ({ apiKey: "expired", usingOAuth: true }),
        renew,
      },
      async (_url, init) => {
        const sent = init.headers?.Authorization ?? "";
        seen.push(sent);
        return sent.includes("fresh") ? { status: 200, json: usage } : { status: 401, json: {} };
      },
    );
    expect(renew).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(["Bearer expired", "Bearer fresh"]);
    // The row carries the ONE positive trace a renewal leaves. Without it an
    // `ok` after a failure is indistinguishable from plain network recovery,
    // and nobody reading a snapshot could confirm recovery ever worked.
    expect(row).toMatchObject({ status: "ok", measuredAt: NOW, reason: "renewal_succeeded" });
    expect(row?.windows).toHaveLength(1);
  });

  // The captain's choice on the review of pooled logins: an allowance is
  // said to be checked only when a share of it was read.
  it("marks an answer that names a reset and no share as no reading of the allowance", async () => {
    const auth = {
      accounts: () => [claudeAccount],
      resolve: async () => ({ apiKey: "live", usingOAuth: true }),
    };
    const resetOnly = await rowOf(auth, async () => ({
      status: 200,
      json: { five_hour: { resets_at: "2026-08-14T15:00:00Z" } },
    }));
    expect(resetOnly?.windows).toMatchObject([{ id: "five_hour" }]);
    expect(resetOnly?.windows[0]?.percentRemaining).toBeUndefined();
    expect(resetOnly).toMatchObject({ status: "ok", measuredAt: NOW, unread: true });
    const read = await rowOf(auth, async () => ({ status: 200, json: usage }));
    expect(read?.windows[0]?.percentRemaining).toBe(92);
    expect(read?.unread).toBeUndefined();
  });

  it("marks nothing on an ordinary reading that never needed renewing", async () => {
    const renew = vi.fn(async () => ({ outcome: "renewed" as const, auth: { usingOAuth: true } }));
    const row = await rowOf(
      {
        accounts: () => [claudeAccount],
        resolve: async () => ({ apiKey: "fine", usingOAuth: true }),
        renew,
      },
      async () => ({ status: 200, json: usage }),
    );
    expect(renew).not.toHaveBeenCalled();
    expect(row?.status).toBe("ok");
    expect(row?.reason).toBeUndefined();
  });

  it("does not claim renewal for a retry that landed on something other than a reading", async () => {
    const row = await rowOf(
      {
        accounts: () => [claudeAccount],
        resolve: async () => ({ apiKey: "expired", usingOAuth: true }),
        renew: async () => ({ outcome: "renewed", auth: { apiKey: "fresh", usingOAuth: true } }),
      },
      async (_url, init) =>
        (init.headers?.Authorization ?? "").includes("fresh")
          ? { status: 429, json: {}, retryAfter: "30" }
          : { status: 401, json: {} },
    );
    expect(row).toMatchObject({ status: "rate_limited", reason: "rate_limited" });
  });

  it("never renews on anything but the vendor's own rejection", async () => {
    const renew = vi.fn(async () => ({ outcome: "renewed" as const, auth: { usingOAuth: true } }));
    const auth: QuotaAuth = {
      accounts: () => [claudeAccount],
      resolve: async () => ({ apiKey: "fine", usingOAuth: true }),
      renew,
    };
    await rowOf(auth, async () => ({ status: 200, json: usage }));
    await rowOf(auth, async () => ({ status: 500, json: {} }));
    await rowOf(auth, async () => ({ status: 429, json: {} }));
    await rowOf(auth, async () => {
      throw new QuotaTransportError("timeout");
    });
    expect(renew).not.toHaveBeenCalled();
  });

  it.each([
    ["unchanged", "renewal_unchanged"],
    ["unreadable", "renewal_unreadable"],
    ["failed", "renewal_failed"],
    ["deferred_session", "renewal_deferred_session"],
    ["deferred_busy", "renewal_deferred_busy"],
    ["no_credential", "renewal_no_credential"],
    // A refused account is never renewed; its sensor's 401 is not a sign-out.
    ["withheld", "renewal_withheld"],
  ] as const)(
    "a renewal that reports %s is not knowing, never a sign-out",
    async (outcome, reason) => {
      const row = await rowOf(
        {
          accounts: () => [claudeAccount],
          resolve: async () => ({ apiKey: "expired", usingOAuth: true }),
          renew: async () => ({ outcome }),
        },
        async () => ({ status: 401, json: {} }),
      );
      expect(row).toMatchObject({ status: "unavailable", reason });
    },
  );

  it("only a rejection that SURVIVES a renewal asks for a sign-in", async () => {
    const row = await rowOf(
      {
        accounts: () => [claudeAccount],
        resolve: async () => ({ apiKey: "expired", usingOAuth: true }),
        renew: async () => ({
          outcome: "renewed",
          auth: { apiKey: "also-dead", usingOAuth: true },
        }),
      },
      async () => ({ status: 401, json: {} }),
    );
    expect(row).toMatchObject({ status: "auth_required", reason: "rejected_after_renewal" });
  });

  it("a lapsed refresh token is needs_reauth proof without asking the vendor", async () => {
    const http = vi.fn(async () => ({ status: 200, json: usage }));
    const row = await rowOf(
      {
        accounts: () => [claudeAccount],
        resolve: async () => undefined,
        unresolved: () => ({
          status: "auth_required",
          windows: [],
          reason: "refresh_token_lapsed",
        }),
        renew: async () => ({ outcome: "renewed", auth: { usingOAuth: true } }),
      },
      http,
    );
    expect(row).toMatchObject({ status: "auth_required", reason: "refresh_token_lapsed" });
    expect(http).not.toHaveBeenCalled();
  });

  it("a GitHub sign-in GitHub refuses is a lapsed one, with no renewal tried (INF-560)", async () => {
    // The captain's answer on INF-560: an old Copilot account loads, and its
    // row says to sign in again once its token has lapsed. Copilot's meter
    // reads with the GitHub sign-in itself, which no renewal replaces.
    const renew = vi.fn(async () => ({
      outcome: "renewed" as const,
      auth: { apiKey: "never-used", usingOAuth: true },
    }));
    const http = vi.fn(async () => ({ status: 401, json: { message: "Bad credentials" } }));
    const row = await rowOf(
      {
        accounts: () => [
          {
            accountId: "acct_copilot",
            accountLabel: "Old work",
            quotaId: "copilot",
            piId: "github-copilot",
            providerLabel: "Copilot",
          },
        ],
        resolve: async () => ({
          apiKey: "gho_revoked",
          baseUrl: "https://api.github.com",
          usingOAuth: true,
        }),
        renew,
      },
      http,
    );
    expect(row).toMatchObject({ status: "auth_required", reason: "refresh_token_lapsed" });
    expect(http).toHaveBeenCalledTimes(1);
    expect(renew).not.toHaveBeenCalled();
  });

  it("a Keychain miss stays retryable even when a renew hook exists", async () => {
    const http = vi.fn(async () => ({ status: 200, json: usage }));
    const row = await rowOf(
      {
        accounts: () => [claudeAccount],
        resolve: async () => undefined,
        unresolved: () => keychainFailureOutcome("keychain_no_interactive_session"),
        renew: async () => ({ outcome: "renewed", auth: { usingOAuth: true } }),
      },
      http,
    );
    expect(row).toMatchObject({
      status: "unavailable",
      reason: "keychain_no_interactive_session",
    });
    expect(http).not.toHaveBeenCalled();
  });

  it("a renewal that throws is not knowing either", async () => {
    const row = await rowOf(
      {
        accounts: () => [claudeAccount],
        resolve: async () => ({ apiKey: "expired", usingOAuth: true }),
        renew: async () => {
          throw new Error("client unavailable");
        },
      },
      async () => ({ status: 401, json: {} }),
    );
    expect(row).toMatchObject({ status: "unavailable", reason: "renewal_failed" });
  });

  it("keeps a timeout, a network drop and a rate limit apart", async () => {
    const auth: QuotaAuth = {
      accounts: () => [claudeAccount],
      resolve: async () => ({ apiKey: "fine", usingOAuth: true }),
    };
    const timedOut = await rowOf(auth, async () => {
      throw new QuotaTransportError("timeout");
    });
    const offline = await rowOf(auth, async () => {
      throw new QuotaTransportError("network");
    });
    const limited = await rowOf(auth, async () => ({
      status: 429,
      json: {},
      retryAfter: "60",
    }));
    expect(timedOut).toMatchObject({ status: "unavailable", reason: "timeout" });
    expect(offline).toMatchObject({ status: "unavailable", reason: "network" });
    expect(limited).toMatchObject({
      status: "rate_limited",
      reason: "rate_limited",
      retryAfter: "60",
    });
    expect(timedOut?.status).not.toBe(limited?.status);
  });

  it("renews per account: one account's expiry never touches a sibling", async () => {
    const renewed: string[] = [];
    const { snapshot } = await createQuotaFetcher({
      auth: {
        accounts: () => [
          claudeAccount,
          { ...claudeAccount, accountId: "acct_other", accountLabel: "Work" },
        ],
        resolve: async (accountId) => ({
          apiKey: accountId === "acct_claude" ? "expired" : "fine",
          usingOAuth: true,
        }),
        renew: async (accountId) => {
          renewed.push(accountId);
          return { outcome: "renewed", auth: { apiKey: "fresh", usingOAuth: true } };
        },
      },
      http: async (_url, init) => {
        const sent = init.headers?.Authorization ?? "";
        return sent.includes("expired") ? { status: 401, json: {} } : { status: 200, json: usage };
      },
      models: () => [],
      now: () => NOW,
    })();
    expect(renewed).toEqual(["acct_claude"]);
    expect(snapshot.providers.map((provider) => provider.status)).toEqual(["ok", "ok"]);
  });
});

describe("Claude Keychain VALUE refusal (CL-C / D-3)", () => {
  const cred = JSON.stringify({ claudeAiOauth: { accessToken: "kc-ok", expiresAt: 9e15 } });

  function decliningThenAllowingKeychain(kind: "denied" | "blocked"): {
    keychain: HostKeychain;
    valueReads: () => number;
    allow: () => void;
  } {
    let allow = false;
    let valueReads = 0;
    const keychain: HostKeychain = {
      findGenericPassword: async () => ({ kind: "found" }),
      readGenericPassword: async () => {
        valueReads += 1;
        if (!allow) {
          return kind === "denied"
            ? { kind: "failed", code: -128, message: "User canceled the request." }
            : { kind: "failed", code: -25308, message: "User interaction is not allowed." };
        }
        return { kind: "value", value: cred };
      },
    };
    return {
      keychain,
      valueReads: () => valueReads,
      allow: () => {
        allow = true;
      },
    };
  }

  it("a decline is a visible retryable failure, and a later retry that succeeds is a working meter", async () => {
    clearKeychainLock();
    const dir = scratchDir("infinitary-quota-keychain-");
    const { keychain, valueReads, allow } = decliningThenAllowingKeychain("denied");
    const lastFailure = new Map<string, ProviderOutcome>();
    const auth: QuotaAuth = {
      accounts: () => [
        {
          accountId: "acct_claude",
          accountLabel: "Personal",
          quotaId: "claude",
          piId: "anthropic-claude",
          providerLabel: "Claude",
        },
      ],
      resolve: async (accountId, options) => {
        const mapped = managedFromClaudeStore(
          await readClaudeStore(dir, {
            keychain,
            env: { USER: "kun" },
            allowPrompt: options?.allowPrompt,
          }),
        );
        if (mapped.unresolved) lastFailure.set(accountId, mapped.unresolved);
        else lastFailure.delete(accountId);
        return mapped.managed;
      },
      unresolved: (accountId) => lastFailure.get(accountId),
    };
    const http: QuotaHttp = async () => ({
      status: 200,
      json: { five_hour: { utilization: 10, resets_at: "2099-01-01T00:00:00Z" } },
    });
    const fetchQuota = createQuotaFetcher({ auth, http, models: () => [], now: () => NOW });

    const declined = await fetchQuota("interval");
    expect(declined.snapshot.providers[0]).toMatchObject({
      status: "unavailable",
      reason: "keychain_access_denied",
      windows: [],
      detail: KEYCHAIN_VALUE_FAILURE_DETAIL.keychain_access_denied,
    });
    expect(valueReads()).toBe(1);

    const background = await fetchQuota("interval");
    expect(valueReads()).toBe(1);
    expect(background.snapshot.providers[0]?.reason).toBe("keychain_access_denied");

    allow();
    const retried = await fetchQuota("demand");
    expect(valueReads()).toBe(2);
    expect(retried.snapshot.providers[0]?.status).toBe("ok");
    expect(retried.snapshot.providers[0]?.windows.length).toBeGreaterThan(0);
    expect(retried.snapshot.providers[0]?.windows[0]?.percentRemaining).toBe(90);
  });

  it("a missing grant retries on every tick and a later read is a working meter", async () => {
    clearKeychainLock();
    const dir = scratchDir("infinitary-quota-keychain-");
    const { keychain, valueReads, allow } = decliningThenAllowingKeychain("blocked");
    const lastFailure = new Map<string, ProviderOutcome>();
    const auth: QuotaAuth = {
      accounts: () => [
        {
          accountId: "acct_claude",
          accountLabel: "Personal",
          quotaId: "claude",
          piId: "anthropic-claude",
          providerLabel: "Claude",
        },
      ],
      resolve: async (accountId, options) => {
        const mapped = managedFromClaudeStore(
          await readClaudeStore(dir, {
            keychain,
            env: { USER: "kun" },
            allowPrompt: options?.allowPrompt,
          }),
        );
        if (mapped.unresolved) lastFailure.set(accountId, mapped.unresolved);
        else lastFailure.delete(accountId);
        return mapped.managed;
      },
      unresolved: (accountId) => lastFailure.get(accountId),
    };
    const http: QuotaHttp = async () => ({
      status: 200,
      json: { five_hour: { utilization: 10, resets_at: "2099-01-01T00:00:00Z" } },
    });
    const fetchQuota = createQuotaFetcher({ auth, http, models: () => [], now: () => NOW });

    // A background tick suppresses the macOS dialog on purpose, so an item
    // Infinitary has not been granted access to yet fails here. That is a missing
    // grant, not a session that cannot show dialogs: the meter must ask for
    // the one Always Allow rather than send the captain off to relaunch.
    const blocked = await fetchQuota("interval");
    expect(blocked.snapshot.providers[0]).toMatchObject({
      status: "unavailable",
      reason: "keychain_needs_grant",
      windows: [],
      detail: KEYCHAIN_VALUE_FAILURE_DETAIL.keychain_needs_grant,
    });
    expect(valueReads()).toBe(1);

    const background = await fetchQuota("interval");
    expect(valueReads()).toBe(2);
    expect(background.snapshot.providers[0]?.reason).toBe("keychain_needs_grant");

    allow();
    const recovered = await fetchQuota("interval");
    expect(valueReads()).toBe(3);
    expect(recovered.snapshot.providers[0]?.status).toBe("ok");
    expect(recovered.snapshot.providers[0]?.windows.length).toBeGreaterThan(0);
  });
});

describe("Claude usage asks", () => {
  const claudeUsage = (percent: number) => ({
    five_hour: { utilization: percent, resets_at: "2026-08-14T15:00:00Z" },
  });
  const auth: QuotaAuth = {
    accounts: () => [
      { accountId: "c1", quotaId: "claude", providerLabel: "Claude", accountLabel: "me" },
    ],
    resolve: async () => ({ apiKey: "tok", usingOAuth: true }),
  } as unknown as QuotaAuth;
  const setup = (statuses: number[]) => {
    let at = NOW;
    let asks = 0;
    const http: QuotaHttp = async () => {
      asks += 1;
      const status = statuses[Math.min(asks - 1, statuses.length - 1)] ?? 200;
      return { status, json: status === 200 ? claudeUsage(20) : {}, retryAfter: "0" };
    };
    const fetcher = createQuotaFetcher({ auth, http, models: () => [], now: () => at });
    return {
      fetcher,
      asks: () => asks,
      advance: (ms: number) => {
        at += ms;
      },
    };
  };

  it("asks once per five minutes however many refreshes arrive, and Retry always asks", async () => {
    const t = setup([200]);
    const first = await t.fetcher("startup");
    t.advance(60_000);
    const focus = await t.fetcher("focus");
    expect(t.asks()).toBe(1);
    expect(focus.snapshot.providers[0]).toEqual(first.snapshot.providers[0]);
    t.advance(60_000);
    await t.fetcher("demand");
    expect(t.asks()).toBe(2);
    t.advance(5 * 60_000);
    await t.fetcher("interval");
    expect(t.asks()).toBe(3);
  });

  it("waits out a slow-down for ten minutes even when the vendor says retry-after 0", async () => {
    const t = setup([429, 200]);
    const limited = await t.fetcher("startup");
    expect(limited.snapshot.providers[0]?.status).toBe("rate_limited");
    t.advance(5 * 60_000);
    const during = await t.fetcher("interval");
    expect(t.asks()).toBe(1);
    expect(during.snapshot.providers[0]?.status).toBe("rate_limited");
    t.advance(5 * 60_000);
    const after = await t.fetcher("interval");
    expect(t.asks()).toBe(2);
    expect(after.snapshot.providers[0]?.status).toBe("ok");
  });
  // INF-1079: the captain switched the machine's Claude login while the old
  // one's allowance was spent, and the app kept showing the old reading.
  it("never serves an answer the previous login got, and drops one that lands after a switch", async () => {
    let at = NOW;
    let login = "login-a";
    let observedLogin = login;
    let asks = 0;
    let percent = 100;
    let landing: (() => void) | undefined;
    const http: QuotaHttp = async () => {
      asks += 1;
      const answer = { status: 200, json: claudeUsage(percent), retryAfter: "0" };
      if (!landing) return answer;
      await new Promise<void>((resolve) => {
        landing = resolve;
      });
      return answer;
    };
    const fetcher = createQuotaFetcher({
      auth: {
        ...auth,
        resolve: async (accountId, options) => {
          // INF-2318: only the store read, not a separate focus scan, observes the swap.
          observedLogin = login;
          return auth.resolve(accountId, options);
        },
      },
      http,
      models: () => [],
      now: () => at,
      loginOf: () => observedLogin,
    });
    const spent = await fetcher("startup");
    expect(spent.snapshot.providers[0]?.windows[0]?.percentRemaining).toBe(0);

    // Another login a minute later: the five-minute wait is the old login's.
    login = "login-b";
    percent = 20;
    at += 60_000;
    const switched = await fetcher("focus");
    expect(asks).toBe(2);
    expect(switched.snapshot.providers[0]?.windows[0]?.percentRemaining).toBe(80);

    // A request login-b started lands after a switch back to login-a.
    landing = () => {};
    at += 5 * 60_000;
    const late = fetcher("interval");
    await vi.waitFor(() => expect(asks).toBe(3));
    login = "login-a";
    observedLogin = login; // A concurrent health read saw the external swap.
    landing();
    const dropped = await late;
    expect(dropped.snapshot.providers[0]).toMatchObject({ status: "skipped", windows: [] });
  });
});
