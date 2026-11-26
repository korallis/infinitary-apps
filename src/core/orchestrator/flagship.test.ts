import { accountPools } from "@shared/accountPools";
import type { QuotaSnapshotView } from "@shared/quota";
import { describe, expect, it, vi } from "vitest";
import type { ModelRuntime } from "../pi/types";
import { buildModelsCatalog } from "../quota/catalog";
import { QuotaService } from "../quota/quotaService";
import { quotaGateCleared } from "../routing/quotaGate";
import { openInMemoryDatabase } from "../storage/db";
import { Flagship, type FlagshipVaultView } from "./flagship";
import {
  firstmatePauseCard,
  KEEP_GOING_ON_CREDITS_LABEL,
  RECHECK_ALLOWANCE_LABEL,
} from "./hostCards";

type FakeAccount = {
  id: string;
  providerId: string;
  label: string;
  enabled: boolean;
  connected?: boolean;
  /** Connected, but withheld from serving: its reason (a missing client, a standing cut-off). */
  withheld?: string;
  cutOff?: { class: "signed_out" | "no_headroom" | "refused"; resetsAt?: number };
  /** Simulates a non-Pi store (the Claude backend, phase 7). */
  via?: string;
  keepGoingOnCredits?: boolean;
};

const baseRuntime = { kind: "base" } as unknown as ModelRuntime;

function vaultOf(accounts: FakeAccount[]): FlagshipVaultView & { runtimes: string[] } {
  const runtimes: string[] = [];
  return {
    runtimes,
    list: (providerId?: string) =>
      accounts.filter((account) => !providerId || account.providerId === providerId),
    get: (accountId) => accounts.find((account) => account.id === accountId),
    connectedSync: (accountId) => accounts.find((account) => account.id === accountId)?.connected,
    servesSync: (accountId) => {
      const account = accounts.find((entry) => entry.id === accountId);
      return account?.withheld ? false : account?.connected;
    },
    withheldReason: (accountId) => accounts.find((entry) => entry.id === accountId)?.withheld,
    withheldDetail: () => undefined,
    keepsGoingOnCredits: (accountId) =>
      accounts.find((entry) => entry.id === accountId)?.keepGoingOnCredits === true,
    cutOff: (accountId) => accounts.find((entry) => entry.id === accountId)?.cutOff,
    tryAgain: () => false,
    runtimeFor: async (accountId) => {
      runtimes.push(accountId);
      return { kind: `runtime-${accountId}` } as unknown as ModelRuntime;
    },
    binding: (accountId) => ({
      via: accounts.find((account) => account.id === accountId)?.via ?? "pi-runtime",
    }),
  };
}

function settingsOf(initial: string | null = null) {
  let value = initial;
  return {
    getFirstmateAccount: () => value,
    setFirstmateAccount: (accountId: string | null) => {
      value = accountId;
    },
  };
}

const snapshot = (
  rows: { accountId: string; percent?: number; resetText?: string }[],
): QuotaSnapshotView => ({
  generatedAt: "2026-08-17T12:00:00Z",
  fetchedAt: 0,
  providers: rows.map((row) => ({
    provider: "codex",
    label: "Codex",
    accountId: row.accountId,
    status: "ok" as const,
    stale: false,
    windows:
      row.percent === undefined
        ? []
        : [
            {
              id: "weekly",
              label: "weekly",
              percentRemaining: row.percent,
              ...(row.resetText ? { resetText: row.resetText } : {}),
            },
          ],
  })),
});

describe("Flagship", () => {
  it("keeps the persisted pin while it is healthy", async () => {
    const settings = settingsOf("acct_pin");
    const flagship = new Flagship({
      vault: vaultOf([
        { id: "acct_pin", providerId: "openai-codex", label: "Personal", enabled: true },
        { id: "acct_big", providerId: "openai-codex", label: "Work #2", enabled: true },
      ]),
      settings,
      quota: { latest: () => snapshot([{ accountId: "acct_big", percent: 99 }]) },
      baseRuntime,
    });
    const binding = await flagship.resolveBinding("openai-codex");
    expect(binding.accountId).toBe("acct_pin");
  });

  it("rejects a persisted account from a different provider than the selected model", async () => {
    const settings = settingsOf("acct_codex");
    const flagship = new Flagship({
      vault: vaultOf([
        { id: "acct_codex", providerId: "openai-codex", label: "Codex", enabled: true },
        { id: "acct_grok", providerId: "xai", label: "Grok", enabled: true },
      ]),
      settings,
      quota: { latest: () => undefined },
      baseRuntime,
    });

    const binding = await flagship.resolveBinding("xai");

    expect(binding.accountId).toBe("acct_grok");
    expect(settings.getFirstmateAccount()).toBe("acct_grok");
  });

  it("clears a persisted account when the selected provider has no matching account", async () => {
    const settings = settingsOf("acct_codex");
    const flagship = new Flagship({
      vault: vaultOf([
        { id: "acct_codex", providerId: "openai-codex", label: "Codex", enabled: true },
      ]),
      settings,
      quota: { latest: () => undefined },
      baseRuntime,
    });

    const binding = await flagship.resolveBinding("xai");

    expect(binding.accountId).toBeUndefined();
    expect(settings.getFirstmateAccount()).toBeNull();
  });

  it("derives the most-headroom account once and persists it (never silently changes)", async () => {
    const settings = settingsOf(null);
    const flagship = new Flagship({
      vault: vaultOf([
        { id: "acct_low", providerId: "openai-codex", label: "Personal", enabled: true },
        { id: "acct_high", providerId: "openai-codex", label: "Work #2", enabled: true },
      ]),
      settings,
      quota: {
        latest: () =>
          snapshot([
            { accountId: "acct_low", percent: 12 },
            { accountId: "acct_high", percent: 80 },
          ]),
      },
      baseRuntime,
    });
    const binding = await flagship.resolveBinding("openai-codex");
    expect(binding).toEqual({
      backend: "pi",
      accountId: "acct_high",
      runtime: { kind: "runtime-acct_high" },
    });
    expect(settings.getFirstmateAccount()).toBe("acct_high");
  });

  it("falls back to the base runtime when no eligible account exists", async () => {
    const flagship = new Flagship({
      vault: vaultOf([]),
      settings: settingsOf(null),
      quota: { latest: () => undefined },
      baseRuntime,
    });
    const binding = await flagship.resolveBinding("fm-mock");
    expect(binding).toEqual({ backend: "pi", runtime: baseRuntime });
  });

  it("is eligible only when the catalog role, a seat backend and its binding agree", () => {
    const flagship = new Flagship({
      vault: vaultOf([
        // A leftover Anthropic API row: a provider this build does not offer.
        {
          id: "acct_anthropic",
          providerId: "anthropic",
          label: "Max",
          enabled: true,
          via: "default-login",
        },
        { id: "acct_pi", providerId: "openai-codex", label: "Personal", enabled: true },
        { id: "acct_off", providerId: "openai-codex", label: "Paused", enabled: false },
        {
          id: "acct_dead",
          providerId: "openai-codex",
          label: "Dead",
          enabled: true,
          connected: false,
        },
      ]),
      settings: settingsOf(null),
      quota: { latest: () => undefined },
      baseRuntime,
    });
    expect(flagship.isEligible("acct_anthropic")).toBe(false);
    expect(flagship.isEligible("acct_pi")).toBe(true);
    expect(flagship.isEligible("acct_off")).toBe(false);
    expect(flagship.isEligible("acct_dead")).toBe(false);
  });

  it("never seats an account the serveability predicate withholds, though it stays connected", async () => {
    // A standing refusal or a missing client: connected, serving nothing.
    const flagship = new Flagship({
      vault: vaultOf([
        {
          id: "acct_held",
          providerId: "openai-codex",
          label: "Personal",
          enabled: true,
          connected: true,
          withheld: "refused",
        },
        { id: "acct_ok", providerId: "openai-codex", label: "Work", enabled: true },
      ]),
      settings: settingsOf("acct_held"),
      quota: {
        latest: () =>
          snapshot([
            { accountId: "acct_held", percent: 90 },
            { accountId: "acct_ok", percent: 10 },
          ]),
      },
      baseRuntime,
    });
    expect(flagship.isEligible("acct_held")).toBe(false);
    expect(flagship.isEligible("acct_ok")).toBe(true);
    expect(flagship.deriveForProvider("openai-codex")).toBe("acct_ok");
    expect(flagship.sibling("acct_ok")).toBeUndefined();
    expect(flagship.resolveAccountId("openai-codex")).toBe("acct_ok");
  });

  it("finds a sibling with measured headroom for the rung-1 rebind", () => {
    const flagship = new Flagship({
      vault: vaultOf([
        { id: "acct_a", providerId: "openai-codex", label: "Personal", enabled: true },
        { id: "acct_b", providerId: "openai-codex", label: "Work #2", enabled: true },
      ]),
      settings: settingsOf("acct_a"),
      quota: {
        latest: () =>
          snapshot([
            { accountId: "acct_a", percent: 0, resetText: "resets Fri" },
            { accountId: "acct_b", percent: 46 },
          ]),
      },
      baseRuntime,
    });
    expect(flagship.headroom("acct_a")).toBe(0);
    expect(flagship.resetText("acct_a")).toBe("resets Fri");
    expect(flagship.sibling("acct_a")).toEqual({ id: "acct_b", label: "Work #2" });
  });

  it("offers another provider for rung 2 only when one has measured headroom", () => {
    const flagship = new Flagship({
      vault: vaultOf([
        { id: "acct_codex", providerId: "openai-codex", label: "Personal", enabled: true },
        { id: "acct_grok", providerId: "xai", label: "Personal", enabled: true },
        // A retired provider can still sit in an old vault. It is not a rung.
        { id: "acct_cursor", providerId: "cursor", label: "Personal", enabled: true },
      ]),
      settings: settingsOf(null),
      quota: {
        latest: () => ({
          generatedAt: "",
          fetchedAt: 0,
          providers: [
            {
              provider: "grok",
              label: "Grok",
              accountId: "acct_grok",
              status: "ok" as const,
              stale: false,
              windows: [{ id: "weekly", label: "weekly", percentRemaining: 61 }],
            },
            {
              provider: "cursor",
              label: "Cursor",
              accountId: "acct_cursor",
              status: "ok" as const,
              stale: false,
              windows: [{ id: "weekly", label: "weekly", percentRemaining: 90 }],
            },
          ],
        }),
      },
      baseRuntime,
    });
    expect(flagship.otherProviderOption("openai-codex")).toEqual({
      providerId: "xai",
      providerName: "Grok",
    });
    expect(flagship.otherProviderOption("xai")).toBeUndefined();
  });
});

describe("a paused seat's class, words and ledger (W1 S9)", () => {
  const account = (overrides: Partial<FakeAccount>): FakeAccount => ({
    id: "acct",
    providerId: "openai-codex",
    label: "Personal",
    enabled: true,
    connected: true,
    ...overrides,
  });

  function over(entry: FakeAccount, percent?: number) {
    const ledger: unknown[] = [];
    const flagship = new Flagship({
      vault: vaultOf([entry]),
      settings: settingsOf(),
      quota: {
        latest: () => snapshot([{ accountId: entry.id, percent, resetText: "resets Fri" }]),
      },
      baseRuntime,
      decisions: {
        recordAccount: (input) => ledger.push(input),
      },
    });
    return { flagship, ledger };
  }

  it("reads each class from typed facts, never from words", () => {
    expect(over(account({}), 40).flagship.pause("acct")).toBeUndefined();
    expect(over(account({ enabled: false })).flagship.pause("acct")).toEqual({
      class: "unavailable",
    });
    expect(over(account({ connected: false })).flagship.pause("acct")).toEqual({
      class: "signed_out",
    });
    expect(over(account({ withheld: "signed_out" })).flagship.pause("acct")).toEqual({
      class: "signed_out",
    });
    expect(over(account({ withheld: "refused" })).flagship.pause("acct")).toEqual({
      class: "refused",
    });
    expect(over(account({ withheld: "client_missing" })).flagship.pause("acct")).toEqual({
      class: "client",
    });
    // A standing spent allowance carries its reset; a zero reading is one too.
    expect(
      over(account({ cutOff: { class: "no_headroom", resetsAt: 5_000 } }), 40).flagship.pause(
        "acct",
      ),
    ).toEqual({ class: "no_headroom", resetsAt: 5_000 });
    expect(over(account({}), 0).flagship.pause("acct")).toEqual({ class: "no_headroom" });
    // Unknown quota is never zero.
    expect(over(account({})).flagship.pause("acct")).toBeUndefined();
    expect(over(account({ via: "default-login" }), 40).flagship.pause("acct")).toEqual({
      class: "unavailable",
    });
  });

  it("reads a standing refusal before a lapsed sign-in, since signing in again does not clear it (review N2)", () => {
    const { flagship } = over(account({ connected: false, cutOff: { class: "refused" } }));
    expect(flagship.pause("acct")).toEqual({ class: "refused" });
  });

  it("keeps a pin a fact pauses bound, so admission pauses on it, and lets go of one that is gone (review S3)", () => {
    const settings = settingsOf("acct");
    const paused = account({ withheld: "refused" });
    const flagship = new Flagship({
      vault: vaultOf([paused]),
      settings,
      quota: { latest: () => snapshot([{ accountId: "acct", percent: 40 }]) },
      baseRuntime,
    });
    expect(flagship.resolveAccountId("openai-codex")).toBe("acct");
    expect(settings.getFirstmateAccount()).toBe("acct");
    // Paused by the captain in Settings is not a fact the seat waits out.
    paused.enabled = false;
    expect(flagship.resolveAccountId("openai-codex")).toBeUndefined();
    expect(settings.getFirstmateAccount()).toBeNull();
  });

  it("says why a withheld account cannot be the Firstmate in its class's words", () => {
    expect(over(account({ withheld: "refused" })).flagship.ineligibilityReason("acct")).toBe(
      "Codex is not answering your first mate right now.",
    );
    expect(over(account({ withheld: "signed_out" })).flagship.ineligibilityReason("acct")).toBe(
      "Personal needs you to sign in again.",
    );
    expect(over(account({ connected: false })).flagship.ineligibilityReason("acct")).toBe(
      "Personal needs you to sign in again.",
    );
    const { flagship } = over(account({}), 0);
    expect(flagship.ineligibilityReason("acct")).toBeUndefined();
    expect(flagship.pauseSentence("acct", { class: "no_headroom" })).toBe(
      "Personal has used up its allowance (resets Fri).",
    );
  });

  it("records each seat decision as an account row on the one ledger", () => {
    const { flagship, ledger } = over(account({}), 40);
    expect(flagship.resolveAccountId("openai-codex")).toBe("acct");
    flagship.record("paused", "acct", ["Personal: refused", "nothing else can serve"]);
    expect(ledger).toEqual([
      {
        taskId: "firstmate",
        provider: "openai-codex",
        accountId: "acct",
        reasons: [
          "seat derived",
          "no account pinned for openai-codex",
          "picked Personal: most headroom among eligible accounts",
        ],
      },
      {
        taskId: "firstmate",
        provider: "openai-codex",
        accountId: "acct",
        reasons: ["seat paused", "Personal: refused", "nothing else can serve"],
      },
    ]);
  });
});

describe("a Claude account seats the Firstmate on the machine's login (W1 S12)", () => {
  const claude = (overrides: Partial<FakeAccount> = {}): FakeAccount => ({
    id: "acct_claude",
    providerId: "anthropic-claude",
    label: "Claude Max",
    enabled: true,
    connected: true,
    via: "default-login",
    ...overrides,
  });
  const codex: FakeAccount = {
    id: "acct_codex",
    providerId: "openai-codex",
    label: "Codex",
    enabled: true,
    connected: true,
  };

  function flagshipOver(pool: FakeAccount[], initialPin: string | null = null) {
    const settings = settingsOf(initialPin);
    const vault = vaultOf(pool);
    return {
      settings,
      vault,
      flagship: new Flagship({
        vault,
        settings,
        quota: {
          latest: () =>
            snapshot([
              { accountId: "acct_claude", percent: 99 },
              { accountId: "acct_codex", percent: 0 },
            ]),
        },
        baseRuntime,
      }),
    };
  }

  it("is eligible while it serves, through the same three assertions as a Pi account", () => {
    const { flagship } = flagshipOver([claude(), codex]);
    expect(flagship.isEligible("acct_claude")).toBe(true);
    // The binding must be the one the Claude seat stands on: a Claude
    // account the vault would hand a Pi runtime is not seatable, and a Pi
    // account on the machine's default login is not either.
    expect(flagshipOver([claude({ via: "pi-runtime" })]).flagship.isEligible("acct_claude")).toBe(
      false,
    );
    expect(
      flagshipOver([{ ...codex, via: "default-login" }]).flagship.isEligible("acct_codex"),
    ).toBe(false);
    // The one serveability predicate still withholds it (S7).
    expect(flagshipOver([claude({ withheld: "refused" })]).flagship.isEligible("acct_claude")).toBe(
      false,
    );
    expect(
      flagshipOver([claude({ withheld: "client_missing" })]).flagship.isEligible("acct_claude"),
    ).toBe(false);
  });

  it("binds the Claude seat on its login, never reaching for a runtime", async () => {
    const { flagship, settings, vault } = flagshipOver([claude(), codex]);
    expect(await flagship.resolveBinding("anthropic-claude")).toEqual({
      backend: "claude",
      accountId: "acct_claude",
    });
    expect(settings.getFirstmateAccount()).toBe("acct_claude");
    expect(vault.runtimes).toEqual([]);
  });

  it("leaves an existing Pi pin exactly where it is", async () => {
    const { flagship, settings } = flagshipOver([claude(), codex], "acct_codex");
    expect(await flagship.resolveBinding("openai-codex")).toEqual({
      backend: "pi",
      accountId: "acct_codex",
      runtime: { kind: "runtime-acct_codex" },
    });
    expect(settings.getFirstmateAccount()).toBe("acct_codex");
  });

  it("stands on a Claude login a fact pauses, so admission pauses and asks, without pinning it", async () => {
    const { flagship, settings } = flagshipOver([claude({ withheld: "client_missing" }), codex]);
    expect(await flagship.resolveBinding("anthropic-claude")).toEqual({
      backend: "claude",
      accountId: "acct_claude",
    });
    expect(settings.getFirstmateAccount()).toBeNull();
    expect(flagship.pause("acct_claude")).toEqual({ class: "client" });
  });

  it("fails the attach for a Claude model with no account to stand on, rather than a Pi runtime", async () => {
    const { flagship } = flagshipOver([codex]);
    await expect(flagship.resolveBinding("anthropic-claude")).rejects.toThrow(
      "No signed-in model is available for your first mate: Claude is not connected.",
    );
  });

  it("is offered as a rung-2 move for a Pi seat that runs out, and still only asks (Q6 a)", () => {
    const { flagship } = flagshipOver([claude(), codex]);
    // Rung 1 is a sibling of the same provider; Claude has one login ever.
    expect(flagship.sibling("acct_claude")).toBeUndefined();
    expect(flagship.otherProviderOption("openai-codex")).toEqual({
      providerId: "anthropic-claude",
      providerName: "Claude",
    });
    // A refused login is no rung.
    expect(
      flagshipOver([claude({ withheld: "refused" }), codex]).flagship.otherProviderOption(
        "openai-codex",
      ),
    ).toBeUndefined();
  });

  it("serves the Firstmate only while an account the seat can stand on is there", () => {
    expect(flagshipOver([claude()]).flagship.servesFirstmate("anthropic-claude")).toBe(true);
    expect(
      flagshipOver([claude({ withheld: "refused" })]).flagship.servesFirstmate("anthropic-claude"),
    ).toBe(false);
    // No Claude login: nothing serves a Claude model, while a custom
    // provider with no accounts rides the base runtime.
    expect(flagshipOver([codex]).flagship.servesFirstmate("anthropic-claude")).toBe(false);
    expect(flagshipOver([codex]).flagship.servesFirstmate("fm-mock")).toBe(true);
    // A retired provider serves no role at all.
    expect(flagshipOver([codex]).flagship.servesFirstmate("cursor")).toBe(false);
  });

  it("stands on a login a typed cut-off pauses, not one with no client or never signed in", () => {
    for (const cutOff of [
      { class: "refused" as const },
      { class: "signed_out" as const },
      { class: "no_headroom" as const, resetsAt: Date.now() + 3_600_000 },
    ]) {
      expect(
        flagshipOver([claude({ withheld: cutOff.class, cutOff })]).flagship.standsOnCutOff(),
      ).toBe(true);
    }
    expect(flagshipOver([claude()]).flagship.standsOnCutOff()).toBe(false);
    expect(flagshipOver([claude({ withheld: "client_missing" })]).flagship.standsOnCutOff()).toBe(
      false,
    );
    expect(flagshipOver([claude({ connected: false })]).flagship.standsOnCutOff()).toBe(false);
    // A cut-off on an account the seat cannot stand on at all is not the seat's.
    expect(
      flagshipOver([
        claude({ via: "pi-runtime", cutOff: { class: "refused" } }),
      ]).flagship.standsOnCutOff(),
    ).toBe(false);
  });

  it("explains a withheld Claude login in the user's terms, never the machinery's", () => {
    expect(flagshipOver([claude()]).flagship.ineligibilityReason("acct_claude")).toBeUndefined();
    const reason = flagshipOver([claude({ withheld: "refused" })]).flagship.ineligibilityReason(
      "acct_claude",
    );
    expect(reason).toBe("Claude is not answering your first mate right now.");
    expect(reason).not.toMatch(/harness|agent-sdk|config-dir|backend/i);
  });
});

// INF-4104 piece 2: Keep going on credits, as the first mate's seat reads it.
describe("a seat whose allowance is spent but whose provider has credits", () => {
  const credited = (keepGoingOnCredits: boolean, cutOff?: FakeAccount["cutOff"]) =>
    new Flagship({
      vault: vaultOf([
        {
          id: "acct",
          providerId: "openai-codex",
          label: "Personal",
          enabled: true,
          connected: true,
          ...(cutOff ? { cutOff } : {}),
          ...(keepGoingOnCredits ? { keepGoingOnCredits: true } : {}),
        },
      ]),
      settings: settingsOf(),
      quota: {
        latest: () => {
          const spent = snapshot([{ accountId: "acct", percent: 0 }]);
          return {
            ...spent,
            providers: spent.providers.map((row) => ({
              ...row,
              credits: { state: "available" as const, balance: "120.5" },
              // The home lays no switch on a row the provider refused.
              ...(keepGoingOnCredits && cutOff?.class !== "no_headroom"
                ? { keepGoingOnCredits: true }
                : {}),
            })),
          };
        },
      },
      baseRuntime,
    });

  it("keeps answering with the switch on, and pauses with an offer to turn it on while it is off", () => {
    expect(credited(true).pause("acct")).toBeUndefined();
    expect(credited(true).creditsOffer("acct")).toBeUndefined();
    expect(credited(false).pause("acct")).toEqual({ class: "no_headroom" });
    expect(credited(false).creditsOffer("acct")).toEqual({ balance: "120.5" });
  });

  it("still pauses on the provider's own refusal with the switch on, and offers no switch already on", () => {
    const resetsAt = Date.now() + 60_000;
    const refused = credited(true, { class: "no_headroom", resetsAt });
    expect(refused.pause("acct")).toEqual({ class: "no_headroom", resetsAt });
    expect(refused.creditsOffer("acct")).toBeUndefined();
  });

  it("puts Keep going on credits first on the run-out card, with Recheck beside it", () => {
    const card = firstmatePauseCard("card-fm-no-headroom", {
      pause: "no_headroom",
      body: "",
      accountId: "acct",
      providerName: "Codex",
      credits: { balance: "120.5" },
    });
    expect(card.actions.map((action) => [action.label, action.default === true])).toEqual([
      [KEEP_GOING_ON_CREDITS_LABEL, true],
      [RECHECK_ALLOWANCE_LABEL, false],
      ["Open settings", false],
    ]);
    expect(card.actions[0]?.effect).toEqual({
      kind: "host",
      op: "keep-going-on-credits",
      arg: "acct",
    });
  });
});

// The review's ask on pooled logins (docs/quota.md, "A pool of your own
// logins"): the provider's wait, a level's wait and the first mate's seat
// agree, reading by reading, on when a spent pool serves again - with the
// first login that can serve, not with a login's first window to reset.
describe("a spent pool of two logins, across its resets", () => {
  const T = Date.parse("2026-11-25T16:40:00Z");
  const HOUR = 60 * 60 * 1000;
  type Left = [percent: number, resetsAtMs: number];
  const login = (accountId: string, session: Left, weekly: Left) => ({
    provider: "codex",
    label: "Codex",
    accountId,
    status: "ok" as const,
    stale: false,
    windows: [
      { id: "session", label: "session", percentRemaining: session[0], resetsAtMs: session[1] },
      { id: "weekly", label: "weekly", percentRemaining: weekly[0], resetsAtMs: weekly[1] },
    ],
  });
  const reading = (at: number, rows: ReturnType<typeof login>[]): QuotaSnapshotView => ({
    generatedAt: new Date(at).toISOString(),
    fetchedAt: at,
    providers: rows,
    pools: accountPools(
      rows,
      rows.map((row) => ({ accountId: row.accountId, provider: row.provider })),
      at,
    ),
  });
  const sol = { provider: "openai-codex", id: "gpt-6-sol" };
  const catalogOf = (snapshot: QuotaSnapshotView) =>
    buildModelsCatalog(
      [{ ...sol, name: "Sol" }],
      snapshot.providers,
      snapshot.generatedAt,
      snapshot.fetchedAt,
      snapshot.pools,
    );
  const standing = (snapshot: QuotaSnapshotView) =>
    standingOn({ latest: () => snapshot, latestModels: () => catalogOf(snapshot) });
  const standingOn = (
    quota: {
      latest: () => QuotaSnapshotView | undefined;
      latestModels: () => ReturnType<typeof catalogOf> | undefined;
    },
    /** The provider's own refusal of login B, while one stands. */
    refusedB?: () => FakeAccount["cutOff"],
  ) => {
    const cutOff = refusedB?.();
    const flagship = new Flagship({
      vault: vaultOf([
        { id: "a", providerId: "openai-codex", label: "A", enabled: true },
        {
          id: "b",
          providerId: "openai-codex",
          label: "B",
          enabled: true,
          ...(cutOff ? { cutOff } : {}),
        },
      ]),
      settings: settingsOf("a"),
      quota,
      baseRuntime,
    });
    const reads = { availableModels: () => [sol], slotsOf: () => ["high" as const], quota };
    return {
      provider: quotaGateCleared("codex", reads),
      level: quotaGateCleared("bucket:high", reads),
      seatA: flagship.pause("a")?.class,
      seatB: flagship.pause("b")?.class,
      moveTo: flagship.sibling("a")?.id,
      poolBackAt: quota.latest()?.pools?.[0]?.pool?.backAtMs,
      // The pooled meter, as Settings draws it: each window's share left.
      meter: Object.fromEntries(
        quota.latest()?.pools?.[0]?.windows.map((window) => [window.id, window.percentRemaining]) ??
          [],
      ),
    };
  };
  // Both logins spent: every window of the pool reads empty.
  const emptyMeter = { session: 0, weekly: 0 };
  const week = T + 72 * HOUR;

  it("holds every wait and the seat until the first login can serve, then clears them together", () => {
    // A's session resets in 1 hour and its week in 72; B's session in 2 hours.
    const spent = standing(
      reading(T, [login("a", [0, T + HOUR], [0, week]), login("b", [0, T + 2 * HOUR], [50, week])]),
    );
    expect(spent).toEqual({
      provider: false,
      level: false,
      seatA: "no_headroom",
      seatB: "no_headroom",
      moveTo: undefined,
      poolBackAt: T + 2 * HOUR,
      meter: emptyMeter,
    });

    // A's session has reset; its week still blocks it, so nothing serves yet.
    const firstReset = standing(
      reading(T + 1.1 * HOUR, [
        login("a", [100, T + 6 * HOUR], [0, week]),
        login("b", [0, T + 2 * HOUR], [50, week]),
      ]),
    );
    expect(firstReset).toEqual(spent);

    // B's session has reset: B serves, and every reader says so at once.
    expect(
      standing(
        reading(T + 2.1 * HOUR, [
          login("a", [100, T + 6 * HOUR], [0, week]),
          login("b", [100, T + 7 * HOUR], [50, week]),
        ]),
      ),
    ).toEqual({
      provider: true,
      level: true,
      seatA: "no_headroom",
      seatB: undefined,
      moveTo: "b",
      poolBackAt: week,
      // B read a full session and half its week; A, spent, weighs zero in each.
      meter: { session: 50, weekly: 25 },
    });
  });

  // One reading for the two clock-only cases below. A's session resets in 1
  // hour and its week in 72; B's session in 2 hours.
  const rows = [login("a", [0, T + HOUR], [0, week]), login("b", [0, T + 2 * HOUR], [50, week])];
  const pools = (snapshot: QuotaSnapshotView) =>
    accountPools(
      snapshot.providers,
      rows.map((row) => ({ accountId: row.accountId, provider: row.provider })),
      snapshot.fetchedAt,
    );
  const held = {
    provider: false,
    level: false,
    seatA: "no_headroom",
    seatB: "no_headroom",
    moveTo: undefined,
    poolBackAt: T + 2 * HOUR,
    meter: emptyMeter,
  };
  // B's used-up session is gone from its row: its week reads half, and A,
  // spent, weighs zero beside it.
  const serving = {
    provider: true,
    level: true,
    seatA: "no_headroom",
    seatB: undefined,
    moveTo: "b",
    poolBackAt: week,
    meter: { weekly: 25 },
  };

  // The captain's choice on the review's question: pooled work resumes at
  // the first reset that makes a login usable, with no new reading.
  it("clears them together when that reset passes, on the one reading it already has", async () => {
    let now = T;
    const refresh = vi.fn(async () => ({
      snapshot: { generatedAt: new Date(T).toISOString(), fetchedAt: T, providers: rows },
      catalog: { generatedAt: new Date(T).toISOString(), models: [] },
    }));
    const broadcast = vi.fn();
    const service = new QuotaService({
      refresh,
      db: openInMemoryDatabase(),
      broadcast,
      now: () => now,
      catalogFor: catalogOf,
      pools,
    });
    await service.refresh("demand");
    service.stop();
    expect(standingOn(service)).toEqual(held);

    // A's session has reset; its week still blocks it, so nothing serves yet.
    now = T + 1.1 * HOUR;
    expect(standingOn(service)).toEqual(held);

    // B's session has reset: B serves, and every reader says so at once.
    broadcast.mockClear();
    now = T + 2.1 * HOUR;
    expect(standingOn(service)).toEqual(serving);
    // Every surface is told once, and nothing was read again.
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  // The review's finding: a window's reset frees nothing while the
  // provider's own refusal of that login still stands.
  it("holds them past a login's reset while its provider still refuses it", async () => {
    let now = T;
    // B's provider refused it until an hour after its session resets.
    const refusedB = () =>
      now < T + 3 * HOUR ? { class: "no_headroom" as const, resetsAt: T + 3 * HOUR } : undefined;
    const service = new QuotaService({
      refresh: async () => ({
        snapshot: { generatedAt: new Date(T).toISOString(), fetchedAt: T, providers: rows },
        catalog: { generatedAt: new Date(T).toISOString(), models: [] },
      }),
      db: openInMemoryDatabase(),
      broadcast: () => {},
      now: () => now,
      catalogFor: catalogOf,
      pools,
      refusedUntil: (accountId) => (accountId === "b" ? refusedB()?.resetsAt : undefined),
    });
    await service.refresh("demand");
    service.stop();
    expect(standingOn(service, refusedB)).toEqual(held);

    // B's session has reset, and its provider still refuses it.
    now = T + 2.1 * HOUR;
    expect(standingOn(service, refusedB)).toEqual(held);

    // The refusal has ended: B serves.
    now = T + 3.1 * HOUR;
    expect(standingOn(service, refusedB)).toEqual(serving);
  });
});
