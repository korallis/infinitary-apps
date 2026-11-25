import type { QuotaProviderView } from "@shared/quota";
import { describe, expect, it } from "vitest";
import { quotaContextLine } from "./homeQuota";

// The review's finding on a CLI proxy (docs/quota.md, "A proxy's pooled
// logins"): a connection to the proxy has a row per pool, and the first
// mate's digest names each pool so the two do not read as one account.
describe("quotaContextLine", () => {
  it("names the pool of each row a connection to the proxy has", () => {
    const pooled = (kind: "claude" | "chatgpt", percentRemaining: number): QuotaProviderView => ({
      provider: "fm-custom-0123456789abcdef",
      label: "Proxy",
      accountId: "acct_proxy",
      accountLabel: "Proxy",
      status: "ok",
      stale: false,
      fromProxy: true,
      pool: {
        kind,
        logins: 2,
        read: 2,
        unread: 0,
        spent: 0,
        switchedOff: 0,
        signInEnded: 0,
        signInSoon: 0,
      },
      windows: [{ id: "weekly", label: "weekly", percentRemaining }],
    });
    const line = quotaContextLine({
      generatedAt: "2026-11-25T16:40:00Z",
      fetchedAt: Date.parse("2026-11-25T16:40:00Z"),
      providers: [pooled("claude", 40), pooled("chatgpt", 70)],
    });
    expect(line).toBe(
      "fm-custom-0123456789abcdef/Proxy Claude pool 40%; fm-custom-0123456789abcdef/Proxy ChatGPT pool 70%",
    );
  });
});
