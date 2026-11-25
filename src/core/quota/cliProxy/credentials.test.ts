import { describe, expect, it } from "vitest";
import { parseProxyCredentials } from "./credentials";

// The captain's ask: read every Claude and ChatGPT login's limits from the
// CLI proxy (docs/quota.md, "A proxy's pooled logins"). The entries follow
// the shape CLIProxyAPI 8's management credentials route answers with, read
// from that proxy on a Windows PC, with names, addresses and ids replaced.
const NOW = Date.parse("2026-11-25T16:40:00Z");

const claudeRead = {
  provider: "claude",
  auth_index: "a1",
  email: "someone@example.com",
  label: "work",
  path: "C:/proxy/auths/claude-work.json",
  id: "claude-work.json",
  status: "active",
  disabled: false,
  unavailable: false,
  cooldowns: null,
  requires_sign_in: false,
  quota_blocked: false,
  access_token_expires_at: "2026-11-25T20:00:00Z",
  quota: {
    observed_at: "2026-11-25T16:33:12Z",
    signals: {
      "Anthropic-Ratelimit-Unified-5h-Utilization": "0.62",
      "Anthropic-Ratelimit-Unified-5h-Reset": "1795631400",
      "Anthropic-Ratelimit-Unified-5h-Status": "allowed",
      "Anthropic-Ratelimit-Unified-7d-Utilization": "0.31",
      "Anthropic-Ratelimit-Unified-7d-Reset": "1796054400",
      "Anthropic-Ratelimit-Unified-7d-Surpassed-Threshold": "0.25",
      "Anthropic-Ratelimit-Unified-Representative-Claim": "five_hour",
      "Anthropic-Ratelimit-Unified-Status": "allowed",
    },
  },
};

const claudeSpent = {
  provider: "claude",
  auth_index: "a2",
  email: "second@example.com",
  status: "error",
  status_message: "credential_quota",
  disabled: false,
  unavailable: true,
  cooldowns: [
    {
      scope: "credential",
      reason: "credential_quota",
      retry_at: "2026-11-27T09:00:00Z",
      remaining_seconds: 145_200,
    },
  ],
  requires_sign_in: false,
  quota_blocked: true,
  next_retry_after: "2026-11-27T09:00:00Z",
};

const claudeModelCooldown = {
  provider: "claude",
  auth_index: "a3",
  status: "active",
  disabled: false,
  cooldowns: [
    {
      scope: "model",
      reason: "credential_quota",
      retry_at: "2026-11-25T18:00:00Z",
      remaining_seconds: 4_800,
    },
  ],
  requires_sign_in: false,
  model_quotas: {
    "claude-fable-5-2": { observed_at: "2026-11-25T11:09:51Z", signals: { "Retry-After": "3600" } },
  },
};

const claudeSignInEnded = {
  provider: "claude",
  auth_index: "a4",
  status: "error",
  status_message: "invalid grant (retrying)",
  disabled: false,
  unavailable: true,
  requires_sign_in: true,
  access_token_expires_at: "2026-11-24T08:00:00Z",
  refresh_error: { code: "invalid_grant", message: "invalid grant", http_status: 400 },
};

const claudeSignInSoon = {
  provider: "claude",
  auth_index: "a5",
  status: "active",
  disabled: false,
  requires_sign_in: true,
  access_token_expires_at: "2026-11-25T22:15:00Z",
};

const codexRead = {
  provider: "codex",
  auth_index: "c1",
  email: "third@example.com",
  id_token: { chatgpt_account_id: "acct-0000", plan_type: "pro" },
  status: "active",
  disabled: false,
  quota: {
    observed_at: "2026-11-25T16:20:00Z",
    signals: {
      "X-Codex-Primary-Used-Percent": "12",
      "X-Codex-Primary-Window-Minutes": "300",
      "X-Codex-Primary-Reset-At": "1795640000",
      "X-Codex-Secondary-Used-Percent": "40",
      "X-Codex-Secondary-Window-Minutes": "10080",
      "X-Codex-Secondary-Reset-At": "1796100000",
      "X-Codex-Credits-Has-Credits": "False",
    },
  },
};

const codexOff = { provider: "codex", auth_index: "c2", status: "disabled", disabled: true };

const grok = { provider: "xai", auth_index: "x1", status: "active", disabled: false };

const answer = {
  observed_at: "2026-11-25T16:40:00Z",
  files: [
    claudeRead,
    claudeSpent,
    claudeModelCooldown,
    claudeSignInEnded,
    claudeSignInSoon,
    codexRead,
    codexOff,
    grok,
  ],
};

describe("parseProxyCredentials", () => {
  const logins = parseProxyCredentials(answer, NOW);
  const byIndex = (index: string) => logins.find((login) => login.authIndex === index);

  it("keeps each Claude and ChatGPT login in its pool and leaves a login of no pool out", () => {
    expect(logins.map((login) => [login.authIndex, login.kind])).toEqual([
      ["a1", "claude"],
      ["a2", "claude"],
      ["a3", "claude"],
      ["a4", "claude"],
      ["a5", "claude"],
      ["c1", "chatgpt"],
      ["c2", "chatgpt"],
    ]);
  });

  it("reads Anthropic's unified limit headers as share left and reset", () => {
    expect(byIndex("a1")).toMatchObject({
      state: "serving",
      windows: [
        { id: "five_hour", label: "session", percentRemaining: 38, resetsAtMs: 1_795_631_400_000 },
        { id: "seven_day", label: "weekly", percentRemaining: 69, resetsAtMs: 1_796_054_400_000 },
      ],
    });
  });

  it("reads ChatGPT's headers by window length, with credits switched off", () => {
    expect(byIndex("c1")).toMatchObject({
      state: "serving",
      chatgptAccount: "acct-0000",
      windows: [
        { id: "five_hour", label: "session", percentRemaining: 88, resetsAtMs: 1_795_640_000_000 },
        { id: "weekly", label: "weekly", percentRemaining: 60, resetsAtMs: 1_796_100_000_000 },
      ],
      credits: { state: "off" },
    });
  });

  it("marks a login on a quota cooldown spent until the proxy tries it again", () => {
    expect(byIndex("a2")).toMatchObject({
      state: "spent",
      backAtMs: Date.parse("2026-11-27T09:00:00Z"),
    });
  });

  it("keeps a login serving when only one model cools down, and unread without limit headers", () => {
    const login = byIndex("a3");
    expect(login?.state).toBe("serving");
    expect(login?.windows).toBeUndefined();
  });

  it("ends a login whose renewal failed once its sign-in has expired", () => {
    expect(byIndex("a4")?.state).toBe("sign_in_ended");
  });

  it("says by when a login that needs signing in again stops serving", () => {
    expect(byIndex("a5")).toMatchObject({
      state: "serving",
      signInByMs: Date.parse("2026-11-25T22:15:00Z"),
    });
  });

  it("marks a login switched off in the proxy", () => {
    expect(byIndex("c2")?.state).toBe("switched_off");
  });

  it("keeps nothing that names the person", () => {
    const kept = JSON.stringify(logins);
    for (const word of ["example.com", "work", "C:/proxy", "claude-work.json", "pro"]) {
      expect(kept).not.toContain(word);
    }
  });

  it("reads an answer of another shape as no logins", () => {
    expect(parseProxyCredentials({ error: "unauthorized" }, NOW)).toEqual([]);
  });
});
