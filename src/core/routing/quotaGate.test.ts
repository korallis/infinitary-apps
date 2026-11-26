import { accountPools } from "@shared/accountPools";
import type { QuotaProviderView } from "@shared/quota";
import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../storage/db";
import { SettingsStore } from "../storage/settingsStore";
import { type AccountModels, ModelSlots } from "./modelSlots";
import { quotaGateCleared } from "./quotaGate";

const grok: AccountModels = {
  accountId: "acct-grok",
  accountLabel: "work",
  providerId: "xai",
  models: [{ provider: "xai", id: "grok-4.7" }],
};

describe("a premium ask's wait", () => {
  it("holds while no model sits at premium and clears once one is placed there (FI3-848)", () => {
    // A Grok-only person: the starter map places Grok 4.7 at medium and
    // leaves premium empty, and Grok has allowance the whole time.
    const slots = new ModelSlots({
      settings: new SettingsStore(openInMemoryDatabase()),
      accounts: () => [grok],
      quotaModels: () => undefined,
    });
    slots.reconcile();
    const reads = {
      availableModels: () => grok.models.map(({ provider, id }) => ({ provider, id })),
      slotsOf: (ref: { provider: string; id: string }) => slots.slotsOf(ref),
      quota: {
        latest: () => undefined,
        latestModels: () => ({
          generatedAt: "2026-10-11T00:00:00.000Z",
          models: [
            { provider: "grok", id: "grok-4.7", label: "Grok 4.7", effectivePercentRemaining: 80 },
          ],
        }),
      },
    };
    expect(quotaGateCleared("bucket:premium", reads)).toBe(false);

    // The Models board's add: the same membership call Settings makes.
    slots.setSlotMembership("xai/grok-4.7", "premium", true);
    expect(quotaGateCleared("bucket:premium", reads)).toBe(true);
  });
});

// INF-4104 piece 2: a wait for a spent allowance ends when its account keeps going on credits.
describe("a wait for a spent allowance", () => {
  const astra = { provider: "openai-codex", id: "gpt-6-astra" };
  const reads = (onCredits: boolean) => ({
    availableModels: () => [astra],
    slotsOf: () => ["high" as const],
    quota: {
      latest: () => ({
        generatedAt: "2026-11-13T21:00:00.000Z",
        fetchedAt: 0,
        providers: [
          {
            provider: "codex",
            label: "Codex",
            accountId: "acct-codex",
            status: "ok" as const,
            stale: false,
            windows: [{ id: "weekly", label: "weekly", percentRemaining: 0 }],
            credits: { state: "available" as const, balance: "120.5" },
            ...(onCredits ? { keepGoingOnCredits: true } : {}),
          },
        ],
      }),
      latestModels: () => ({
        generatedAt: "2026-11-13T21:00:00.000Z",
        models: [
          {
            provider: "codex",
            id: "gpt-6-astra",
            label: "GPT-6 Astra",
            effectivePercentRemaining: 0,
            ...(onCredits ? { onCredits: true } : {}),
          },
        ],
      }),
    },
  });

  it("holds while the switch is off and clears once the account keeps going on credits", () => {
    expect(quotaGateCleared("bucket:high", reads(false))).toBe(false);
    expect(quotaGateCleared("codex", reads(false))).toBe(false);
    expect(quotaGateCleared("bucket:high", reads(true))).toBe(true);
    expect(quotaGateCleared("codex", reads(true))).toBe(true);
  });
});

// The captain's ask: where a provider's own logins pool, the reset gate
// holds only when the whole pool is spent (docs/quota.md, "A pool of your
// own logins").
describe("a wait for a provider whose own logins pool", () => {
  const login = (accountId: string, session: number, weekly: number): QuotaProviderView => ({
    provider: "claude",
    label: "Claude",
    accountId,
    status: "ok",
    stale: false,
    windows: [
      { id: "five_hour", label: "session", percentRemaining: session },
      { id: "seven_day", label: "weekly", percentRemaining: weekly },
    ],
  });
  const reads = (providers: QuotaProviderView[]) => ({
    availableModels: () => [],
    slotsOf: () => [],
    quota: {
      latest: () => ({
        generatedAt: "2026-11-25T16:40:00.000Z",
        fetchedAt: 0,
        providers,
        pools: accountPools(
          providers,
          providers.map((row) => ({ accountId: row.accountId ?? "", provider: row.provider })),
          Date.parse("2026-11-25T16:40:00.000Z"),
        ),
      }),
      latestModels: () => undefined,
    },
  });

  it("clears while one login has allowance, and holds once every login is spent", () => {
    expect(
      quotaGateCleared("claude", reads([login("personal", 0, 80), login("work", 40, 60)])),
    ).toBe(true);
    // Both sessions are used up; each login's week still has allowance, which
    // serves nothing until a session resets.
    expect(
      quotaGateCleared("claude", reads([login("personal", 0, 80), login("work", 0, 60)])),
    ).toBe(false);
  });

  it("clears on a spent pool when one login keeps going on credits", () => {
    const credited: QuotaProviderView = {
      ...login("personal", 0, 80),
      keepGoingOnCredits: true,
      credits: { state: "available" },
    };
    expect(quotaGateCleared("claude", reads([credited, login("work", 0, 60)]))).toBe(true);
  });
});
