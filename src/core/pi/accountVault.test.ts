import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { accountPools } from "@shared/accountPools";
import { CLAUDE_CLIENT_MISSING_TEXT } from "@shared/claudeClient";
import { HERE } from "@shared/deviceNames";
import type { AuthNotice, AuthPromptView } from "@shared/providers";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { standInCodex } from "../../../tests/helpers/codexAppServer";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { type AccountBackend, type AccountRef, statusFromHealth } from "../accounts/accountBackend";
import type {
  CredentialHealth,
  CredentialStamp,
  RenewalOutcome,
  RenewReason,
} from "../accounts/credentialHealth";
import { CredentialHealthService } from "../accounts/credentialHealthService";
import { ClaudeAuthBackend } from "../claude/claudeAuth";
import { createNormalizerState, fmEventsFromClaudeMessage } from "../claude/claudeEvents";
import { claudeAvailableModels } from "../claude/claudeModels";
import { readClaudeStore } from "../claude/claudeQuota";
import { signOutCodexHome } from "../codex/savedResets";
import { appPathsFor } from "../paths";
import { createQuotaFetcher } from "../quota/fetchQuota";
import { PushedQuotaStore, withRejectedReadings } from "../quota/pushedQuota";
import { QuotaService } from "../quota/quotaService";
import { lowestLeft, recordCutOff } from "../quota/spentAllowance";
import { openInMemoryDatabase } from "../storage/db";
import type { AuthInteractionBridge } from "./piAuth";

/**
 * The vault runs against a fake ModelRuntime keyed by authPath: login
 * writes a marker credential file (as Pi would), logout deletes it, and
 * status reads it - so the isolation and lifecycle guarantees are asserted
 * against the real directory tree.
 */

type FakeRuntime = {
  authPath: string;
  login: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  hasConfiguredAuth: (providerId: string) => boolean;
  isUsingOAuth: () => boolean;
  getAuth: ReturnType<typeof vi.fn>;
  getAvailableSnapshot: () => { provider: string; id: string }[];
  getModel: () => undefined;
  getModels: () => [];
};

const fakes = vi.hoisted(() => ({
  runtimes: [] as { authPath: string; runtime: FakeRuntime; getAuth: FakeRuntime["getAuth"] }[],
  failNextCreate: { value: false },
  failNextLogin: { value: false },
  /** The registry's staged bytes cannot be put in place. */
  failRegistryPublish: { value: false },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const renameSync: typeof actual.renameSync = (from, to) => {
    if (fakes.failRegistryPublish.value && String(to).endsWith("registry.json"))
      throw new Error("the registry could not be put in place");
    actual.renameSync(from, to);
  };
  return { ...actual, default: { ...actual, renameSync }, renameSync };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  // Pi's own read of a stored credential, as the Copilot meter uses it.
  readStoredCredential: (await importOriginal<typeof import("@earendil-works/pi-coding-agent")>())
    .readStoredCredential,
  ModelRuntime: {
    create: vi.fn(async (options: { authPath: string; modelsPath: string }) => {
      if (fakes.failNextCreate.value) {
        fakes.failNextCreate.value = false;
        throw new Error("runtime create failed");
      }
      const runtime: FakeRuntime = {
        authPath: options.authPath,
        login: vi.fn(async (providerId: string) => {
          if (fakes.failNextLogin.value) {
            fakes.failNextLogin.value = false;
            throw new Error("Sign in cancelled");
          }
          writeFileSync(options.authPath, JSON.stringify({ [providerId]: { type: "oauth" } }));
        }),
        logout: vi.fn(async () => {}),
        hasConfiguredAuth: () => existsSync(options.authPath),
        isUsingOAuth: () => true,
        getAuth: vi.fn(async () => ({ auth: { apiKey: "resolved-token" } })),
        getAvailableSnapshot: () => [
          { provider: "openai-codex", id: "gpt-5.5" },
          { provider: "anthropic", id: "claude-opus-5" },
        ],
        getModel: () => undefined,
        getModels: () => [],
      };
      // Keep the upstream mock before the app wraps getAuth with its routing guard.
      fakes.runtimes.push({ authPath: options.authPath, runtime, getAuth: runtime.getAuth });
      return runtime;
    }),
  },
}));

const { AccountVault } = await import("./accountVault");

function bridge(): AuthInteractionBridge & { notices: AuthNotice[]; prompts: AuthPromptView[] } {
  const notices: AuthNotice[] = [];
  const prompts: AuthPromptView[] = [];
  return {
    notices,
    prompts,
    prompt: async (prompt) => {
      prompts.push(prompt);
      return "answer";
    },
    notify: (notice) => {
      notices.push(notice);
    },
    openExternal: async () => {},
  };
}

function freshPaths() {
  return appPathsFor(scratchDir("infinitary-vault-"));
}

beforeEach(() => {
  fakes.runtimes.length = 0;
  fakes.failNextCreate.value = false;
});

describe("AccountVault", () => {
  it("adds accounts into isolated 0700 stores with positional default labels", async () => {
    const paths = freshPaths();
    const vault = AccountVault.create(paths);
    const first = await vault.add("openai-codex", "oauth", bridge());
    const second = await vault.add("openai-codex", "oauth", bridge());

    expect(first.label).toBe("Personal");
    expect(second.label).toBe("Account #2");
    expect(first.kind).toBe("subscription_oauth");

    const firstDir = join(paths.accountsDir, "openai-codex", first.id);
    const secondDir = join(paths.accountsDir, "openai-codex", second.id);
    expect(statSync(firstDir).mode & 0o777).toBe(0o700);
    expect(statSync(secondDir).mode & 0o777).toBe(0o700);
    // Pi wrote the credential inside the store; the vault clamped it to 0600.
    expect(statSync(join(firstDir, "auth.json")).mode & 0o777).toBe(0o600);

    const views = await vault.views();
    expect(views).toHaveLength(2);
    expect(views.every((view) => view.connected && view.enabled)).toBe(true);
  });

  // The review of INF-5409: a first launch never reads a registry it cannot read as no accounts.
  it("may hold accounts once one is added, or while its registry cannot be read", async () => {
    const paths = freshPaths();
    expect(AccountVault.create(paths).mayHoldAccounts()).toBe(false);
    mkdirSync(paths.accountsDir, { recursive: true });
    writeFileSync(join(paths.accountsDir, "registry.json"), "{not json");
    const unread = AccountVault.create(paths);
    expect(unread.list()).toEqual([]);
    expect(unread.mayHoldAccounts()).toBe(true);
    const added = AccountVault.create(freshPaths());
    await added.add("openai-codex", "oauth", bridge());
    expect(added.mayHoldAccounts()).toBe(true);
  });

  it("tags login prompts and notices with the account id for row routing", async () => {
    const vault = AccountVault.create(freshPaths());
    const capture = bridge();
    const account = await vault.add("openai-codex", "oauth", capture);
    const runtime = fakes.runtimes.at(-1)?.runtime as FakeRuntime;
    const interaction = runtime.login.mock.calls[0]?.[2] as {
      prompt: (p: { type: string; message: string }) => Promise<string>;
      notify: (e: Record<string, unknown>) => void;
    };
    await interaction.prompt({ type: "secret", message: "Paste your key" });
    interaction.notify({ type: "auth_url", url: "https://provider.example/auth" });
    interaction.notify({
      type: "device_code",
      verificationUri: "https://provider.example/device",
      userCode: "KXQT-9F2M",
    });

    expect(capture.prompts[0]).toMatchObject({
      providerId: "openai-codex",
      accountId: account.id,
      kind: "secret",
    });
    expect(capture.notices[0]).toMatchObject({ kind: "auth_url", accountId: account.id });
    expect(capture.notices[1]).toMatchObject({
      kind: "device_code",
      accountId: account.id,
      userCode: "KXQT-9F2M",
    });
  });

  it("leaves nothing behind when a login fails or is cancelled", async () => {
    const paths = freshPaths();
    const vault = AccountVault.create(paths);
    fakes.failNextLogin.value = true;
    await expect(vault.add("openai-codex", "oauth", bridge())).rejects.toThrow("Sign in cancelled");
    expect(existsSync(join(paths.accountsDir, "openai-codex"))).toBe(false);
    expect(vault.list("openai-codex")).toHaveLength(0);

    fakes.failNextCreate.value = true;
    await expect(vault.add("xai", "oauth", bridge())).rejects.toThrow("runtime create failed");
    expect(existsSync(join(paths.accountsDir, "xai"))).toBe(false);
    expect(vault.list("xai")).toHaveLength(0);
  });

  it("removes one account without touching its siblings (structural isolation)", async () => {
    const paths = freshPaths();
    const vault = AccountVault.create(paths);
    const personal = await vault.add("openai-codex", "oauth", bridge());
    const work = await vault.add("openai-codex", "oauth", bridge());
    const grok = await vault.add("xai", "oauth", bridge());

    await vault.remove(work.id);

    const codexDir = join(paths.accountsDir, "openai-codex");
    expect(existsSync(join(codexDir, personal.id, "auth.json"))).toBe(true);
    expect(existsSync(join(codexDir, work.id))).toBe(false);
    expect(existsSync(join(paths.accountsDir, "xai", grok.id, "auth.json"))).toBe(true);
    expect(vault.list("openai-codex").map((account) => account.id)).toEqual([personal.id]);
    // Best-effort upstream revocation ran against the removed store only.
    const removedRuntime = fakes.runtimes.find((entry) =>
      entry.authPath.includes(work.id),
    )?.runtime;
    expect((removedRuntime as FakeRuntime).logout).toHaveBeenCalledWith("openai-codex");
  });

  // INF-5478's plan, piece 1: Codex's own sign-in for a saved reset goes with the account.
  it("signs Codex out of the account's Codex home and removes it with the account", async () => {
    const paths = freshPaths();
    const codex = standInCodex();
    const ready = async () =>
      ({ state: "ready", executable: "/usr/local/bin/codex", version: "0.155.1" }) as const;
    const vault = AccountVault.create(paths, {
      signOutCodex: (home) => signOutCodexHome(home, "0.8.5", { check: ready, start: codex.start }),
    });
    const work = await vault.add("openai-codex", "oauth", bridge());
    const untouched = await vault.add("openai-codex", "oauth", bridge());
    const home = vault.codexHome(work.id);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    writeFileSync(join(home, "auth.json"), "{}");
    expect(vault.codexSignedIn(work.id)).toBe(true);

    await vault.remove(untouched.id);
    // An account whose Codex never signed in starts no Codex.
    expect(codex.starts()).toBe(0);

    await vault.remove(work.id);
    expect(codex.homes).toEqual([home]);
    expect(codex.methods()).toEqual(["initialize", "initialized", "account/logout"]);
    expect(existsSync(home)).toBe(false);
  });

  it("signs an existing account in again into its own store, moving nothing else", async () => {
    const paths = freshPaths();
    const vault = AccountVault.create(paths);
    const personal = await vault.add("openai-codex", "oauth", bridge());
    const work = await vault.add("openai-codex", "oauth", bridge());
    vault.rename(work.id, "Muse box");
    vault.setPin("openai-codex", work.id);
    // The store lost its credential (a lapsed refresh token, say): the row
    // reads as signed out until someone signs in again.
    const workAuth = join(paths.accountsDir, "openai-codex", work.id, "auth.json");
    rmSync(workAuth);
    expect((await vault.status(work.id, { refresh: true })).connected).toBe(false);

    const capture = bridge();
    await vault.signIn(work.id, capture);

    // The harness wrote a fresh credential into the SAME store, the vault
    // clamped it, and the status read sees it without waiting out the cache.
    expect(existsSync(workAuth)).toBe(true);
    expect(statSync(workAuth).mode & 0o777).toBe(0o600);
    const view = (await vault.views()).find((entry) => entry.id === work.id);
    expect(view).toMatchObject({ connected: true, label: "Muse box", pinned: true });
    // Prompts still route to this row, and the sibling was never touched.
    const runtime = fakes.runtimes.find((entry) => entry.authPath === workAuth)?.runtime;
    expect((runtime as FakeRuntime).login).toHaveBeenCalledTimes(2);
    expect(vault.list("openai-codex").map((account) => account.id)).toEqual([personal.id, work.id]);
    expect(existsSync(join(paths.accountsDir, "openai-codex", personal.id, "auth.json"))).toBe(
      true,
    );
  });

  it("leaves a signed-out account signed out when its sign-in is cancelled", async () => {
    const paths = freshPaths();
    const vault = AccountVault.create(paths);
    const account = await vault.add("openai-codex", "oauth", bridge());
    const auth = join(paths.accountsDir, "openai-codex", account.id, "auth.json");
    rmSync(auth);
    fakes.failNextLogin.value = true;
    await expect(vault.signIn(account.id, bridge())).rejects.toThrow("Sign in cancelled");
    // The registry row survives - cancelling a sign-in is not a removal.
    expect(vault.list("openai-codex").map((entry) => entry.id)).toEqual([account.id]);
    expect(existsSync(auth)).toBe(false);
  });

  it("holds the Firstmate's seat off an account while a sign-in or removal rewrites its store (W1 S9)", async () => {
    const paths = freshPaths();
    const log: string[] = [];
    const vault = AccountVault.create(paths, {
      holdSeat: async (accountId) => {
        log.push(`hold ${accountId}`);
        return () => log.push(`release ${accountId}`);
      },
    });
    const account = await vault.add("openai-codex", "oauth", bridge());
    // Adding a new account rewrites no store the seat could be on.
    expect(log).toEqual([]);
    const runtime = () =>
      fakes.runtimes.find((entry) => entry.authPath.includes(account.id))?.runtime as FakeRuntime;
    runtime().login.mockImplementationOnce(async () => {
      log.push("login");
    });
    await vault.signIn(account.id, bridge());
    expect(log).toEqual([`hold ${account.id}`, "login", `release ${account.id}`]);

    // A cancelled sign-in releases the seat all the same.
    log.length = 0;
    fakes.failNextLogin.value = true;
    await expect(vault.signIn(account.id, bridge())).rejects.toThrow("Sign in cancelled");
    expect(log).toEqual([`hold ${account.id}`, `release ${account.id}`]);

    log.length = 0;
    await vault.remove(account.id);
    expect(log).toEqual([`hold ${account.id}`, `release ${account.id}`]);
  });

  it("produces bindings that reference only the account's own store and no secret", async () => {
    const paths = freshPaths();
    const vault = AccountVault.create(paths);
    const a = await vault.add("openai-codex", "oauth", bridge());
    const b = await vault.add("openai-codex", "oauth", bridge());

    const binding = vault.binding(a.id);
    expect(binding).toEqual({
      via: "pi-runtime",
      authPath: join(paths.accountsDir, "openai-codex", a.id, "auth.json"),
      modelsPath: join(paths.accountsDir, "openai-codex", a.id, "models.json"),
    });
    // Least exposure: nothing in A's binding references B's store.
    expect(JSON.stringify(binding)).not.toContain(b.id);
    expect(Object.keys(binding).sort()).toEqual(["authPath", "modelsPath", "via"]);
  });

  it("persists the registry across vault instances and keeps it non-secret", async () => {
    const paths = freshPaths();
    const vault = AccountVault.create(paths);
    const account = await vault.add("openai-codex", "oauth", bridge());
    vault.rename(account.id, "Work laptop");
    vault.setPin("openai-codex", account.id);
    vault.setEnabled(account.id, false);

    const reloaded = AccountVault.create(paths);
    const record = reloaded.get(account.id);
    expect(record).toMatchObject({ label: "Work laptop", enabled: false });
    expect(reloaded.pinnedAccount("openai-codex")).toBe(account.id);
    const registryRaw = statSync(join(paths.accountsDir, "registry.json"));
    expect(registryRaw.mode & 0o777).toBe(0o600);
  });

  it("clears the provider pin when the pinned account is removed", async () => {
    const vault = AccountVault.create(freshPaths());
    const account = await vault.add("openai-codex", "oauth", bridge());
    vault.setPin("openai-codex", account.id);
    await vault.remove(account.id);
    expect(vault.pinnedAccount("openai-codex")).toBeUndefined();
  });

  // The low-login move reads the pin to tell a move already made from one
  // still to make, so a pin that was not saved must not read as the pin.
  it("keeps the pin it had when the new one cannot be saved", async () => {
    const paths = freshPaths();
    const vault = AccountVault.create(paths);
    const first = await vault.add("openai-codex", "oauth", bridge());
    const second = await vault.add("openai-codex", "oauth", bridge());
    vault.setPin("openai-codex", first.id);
    // The new registry is written out whole, and then cannot be put in place.
    fakes.failRegistryPublish.value = true;
    try {
      expect(() => vault.setPin("openai-codex", second.id)).toThrow();
      expect(vault.pinnedAccount("openai-codex")).toBe(first.id);
      expect(() => vault.setPin("openai-codex", null)).toThrow();
      expect(vault.pinnedAccount("openai-codex")).toBe(first.id);
    } finally {
      fakes.failRegistryPublish.value = false;
    }
    // A relaunch reads the same pin, and nothing staged is left behind.
    expect(AccountVault.create(paths).pinnedAccount("openai-codex")).toBe(first.id);
    expect(readdirSync(paths.accountsDir).filter((name) => name.includes("pending"))).toEqual([]);
    // Once it can be saved, the pin is the new one in memory and on disk.
    vault.setPin("openai-codex", second.id);
    expect(AccountVault.create(paths).pinnedAccount("openai-codex")).toBe(second.id);
  });

  it("refuses to pin an account under a different provider", async () => {
    const vault = AccountVault.create(freshPaths());
    const account = await vault.add("openai-codex", "oauth", bridge());
    expect(() => vault.setPin("xai", account.id)).toThrow(/must belong to the provider/);
  });

  it("unions available models across enabled accounts, filtering Anthropic", async () => {
    const vault = AccountVault.create(freshPaths());
    const a = await vault.add("openai-codex", "oauth", bridge());
    await vault.add("openai-codex", "oauth", bridge());
    expect(vault.availableModels()).toEqual([{ provider: "openai-codex", id: "gpt-5.5" }]);
    vault.setEnabled(a.id, false);
    // Still served by the sibling account; disabling one is not a blackout.
    expect(vault.availableModels()).toEqual([{ provider: "openai-codex", id: "gpt-5.5" }]);
  });

  it("narrows a Pi account to its own model list when one is in hand", async () => {
    // docs/model-lists.md: the account list is a filter over Pi's catalog,
    // and only while a successful read of it is in hand.
    let filter: ReadonlySet<string> | undefined;
    const vault = AccountVault.create(freshPaths(), { piModelFilter: () => filter });
    const account = await vault.add("openai-codex", "oauth", bridge());
    expect(vault.availableModels()).toEqual([{ provider: "openai-codex", id: "gpt-5.5" }]);
    filter = new Set(["gpt-6-sol"]);
    expect(vault.availableModels()).toEqual([]);
    // The rail reads the catalog before any filter.
    expect(vault.piCatalogIds(account.id)).toEqual(["gpt-5.5"]);
    filter = undefined;
    expect(vault.availableModels()).toEqual([{ provider: "openai-codex", id: "gpt-5.5" }]);
  });

  it("resolves quota auth through the account's own runtime", async () => {
    const vault = AccountVault.create(freshPaths());
    const account = await vault.add("openai-codex", "oauth", bridge());
    const resolved = await vault.resolveForQuota(account.id);
    expect(resolved).toEqual({ apiKey: "resolved-token", usingOAuth: true });
    expect(await vault.resolveForQuota("acct_missing")).toBeUndefined();
  });

  it("sweeps liveness and reports accounts whose stores went stale", async () => {
    const vault = AccountVault.create(freshPaths());
    const healthy = await vault.add("openai-codex", "oauth", bridge());
    const stale = await vault.add("xai", "oauth", bridge());
    const staleRuntime = fakes.runtimes.find((entry) => entry.authPath.includes(stale.id));
    expect(staleRuntime).toBeDefined();
    staleRuntime?.getAuth.mockRejectedValue(new Error("refresh token expired"));

    const report = await vault.sweepLiveness();
    expect(report).toEqual([{ accountId: stale.id, providerId: "xai", label: "Personal" }]);
    expect(report.some((entry) => entry.accountId === healthy.id)).toBe(false);
  });

  /**
   * The captain's packaged dogfood build (2026-09-01): a Claude account whose
   * quota windows were being read live from its own store showed "sign in
   * again" AND vanished from the models catalog, because the one thing the
   * vault asked - can the client binary answer? - had failed for a reason
   * that had nothing to do with the credential (in a packaged app the client
   * resolves inside app.asar, where `spawn` cannot reach it).
   *
   * The invariant this pins: the store the quota sensor reads a window out of
   * and the store the connection check consults are ONE store, so an account
   * with a readable window cannot be reported as needing a sign-in - and it
   * keeps its models in the routing pool.
   */
  it("signs a Claude account in again with Claude's own login, one sign-in at a time (INF-2319)", async () => {
    const store = scratchDir("infinitary-claude-default-");
    const credential = join(store, "credential");
    let logins = 0;
    let releaseSecond: () => void = () => {};
    const vault = AccountVault.create(freshPaths(), {
      backends: [
        new ClaudeAuthBackend({
          available: () => true,
          configDir: () => store,
          readStore: async () =>
            existsSync(credential)
              ? {
                  state: "present" as const,
                  auth: { accessToken: readFileSync(credential, "utf8") },
                  identity: {},
                }
              : { state: "absent" as const },
          run: async (args) => {
            if (args[1] === "login") {
              logins += 1;
              if (logins === 2) {
                await new Promise<void>((resolve) => {
                  releaseSecond = resolve;
                });
              }
              writeFileSync(credential, `login-${logins}`);
              return { code: 0, stdout: "", stderr: "" };
            }
            const loggedIn = existsSync(credential);
            return { code: loggedIn ? 0 : 1, stdout: JSON.stringify({ loggedIn }), stderr: "" };
          },
        }),
      ],
    });
    const account = await vault.add(CLAUDE_PROVIDER_ID, "oauth", bridge());
    expect(logins).toBe(1);

    // The row's Sign in: the saved login is the one Anthropic refused.
    const signingIn = vault.signIn(account.id, bridge());
    await vi.waitFor(() => expect(logins).toBe(2));
    await expect(vault.signIn(account.id, bridge())).rejects.toThrow(
      `A Claude sign-in is already in progress on ${HERE.this}.`,
    );
    releaseSecond();
    await signingIn;
    expect(logins).toBe(2);
    expect(readFileSync(credential, "utf8")).toBe("login-2");
    expect((await vault.status(account.id)).connected).toBe(true);
  });

  it("keeps a Claude account connected and routable when only its client probe is broken", async () => {
    const store = scratchDir("infinitary-claude-default-");
    const vault = AccountVault.create(freshPaths(), {
      backends: [
        new ClaudeAuthBackend({
          available: () => true,
          configDir: () => store,
          readStore: async (configDir) => {
            try {
              readFileSync(join(configDir, ".credentials.json"), "utf8");
              return {
                state: "present" as const,
                auth: { accessToken: "fixture-token" },
                identity: {},
              };
            } catch {
              return { state: "absent" as const };
            }
          },
          // The client signs in and writes its own credential, exactly as it
          // does where no Keychain is available - and its STATUS read is the
          // thing that cannot run.
          run: async (args, configDir) => {
            if (args[1] === "login") {
              writeFileSync(
                join(configDir, ".credentials.json"),
                JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt: 4_000_000_000 } }),
              );
              return { code: 0, stdout: "", stderr: "" };
            }
            // A miss is confirmed before the first sign-in. After that, the
            // status probe is the thing that cannot run.
            if (!existsSync(join(configDir, ".credentials.json"))) {
              return { code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "" };
            }
            throw new Error("spawn ENOTDIR .../app.asar/.../claude");
          },
        }),
      ],
      modelsForAccount: ({ providerId }) =>
        providerId === CLAUDE_PROVIDER_ID ? claudeAvailableModels() : [],
    });
    const account = await vault.add(CLAUDE_PROVIDER_ID, "oauth", bridge());

    // The premise: this account's usage credential IS readable. That is what
    // put live quota bars on a card badged "sign in again".
    expect(vault.binding(account.id)).toEqual({ via: "default-login" });
    expect(
      await readClaudeStore(store, {
        keychain: {
          findGenericPassword: async () => ({ kind: "absent" }),
          readGenericPassword: async () => ({ kind: "absent" }),
        },
      }).then((read) => (read.state === "present" ? read.auth : undefined)),
    ).toMatchObject({
      accessToken: "tok",
    });

    const [view] = await vault.views();
    expect(view?.connected).toBe(true);
    // The half the captain actually felt: no Claude model left to route to.
    expect(vault.availableModels()).toEqual(claudeAvailableModels());
    expect(vault.connectedSync(account.id)).toBe(true);
    // ...and no false "a provider needs sign in" card behind it.
    expect(await vault.sweepLiveness()).toEqual([]);
  });

  it("still refuses a Claude account whose store holds no credential at all", async () => {
    const store = scratchDir("infinitary-claude-default-");
    const vault = AccountVault.create(freshPaths(), {
      backends: [
        new ClaudeAuthBackend({
          available: () => true,
          configDir: () => store,
          readStore: async () => ({ state: "absent" }),
          run: async () => ({ code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "" }),
        }),
      ],
      modelsForAccount: () => claudeAvailableModels(),
    });

    await expect(vault.add(CLAUDE_PROVIDER_ID, "oauth", bridge())).rejects.toThrow();
    expect(vault.availableModels()).toEqual([]);
  });

  /**
   * F14: the account's credential is live, the machine has no Claude Code.
   * The account stays (never a sign-out), its view carries the sentence,
   * and it serves no model - a spawn could only fail.
   */
  it("withholds every model from a Claude account whose machine has no client, and says why", async () => {
    const store = scratchDir("infinitary-claude-noclient-");
    // The account was added while the client was there; then the machine
    // lost it (an uninstall, a moved binary) - the credential is untouched.
    let installed = true;
    const vault = AccountVault.create(freshPaths(), {
      backends: [
        new ClaudeAuthBackend({
          available: () => installed,
          client: async () =>
            installed ? { state: "ready", executable: "/x/claude" } : { state: "missing" },
          configDir: () => store,
          readStore: async () => ({
            state: "present",
            auth: { accessToken: "fixture-token" },
            identity: { label: "kun@example.com" },
          }),
          run: async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: "" }),
        }),
      ],
      modelsForAccount: ({ providerId }) =>
        providerId === CLAUDE_PROVIDER_ID ? claudeAvailableModels() : [],
    });
    const account = await vault.add(CLAUDE_PROVIDER_ID, "oauth", bridge());
    expect(vault.availableModels()).toEqual(claudeAvailableModels());

    installed = false;
    await vault.status(account.id, { refresh: true });
    const [view] = await vault.views();
    expect(view).toMatchObject({
      connected: true,
      detail: CLAUDE_CLIENT_MISSING_TEXT,
      identity: "kun@example.com",
    });
    expect(view?.needsReauth).toBeUndefined();
    // The seat's pause card says the same one sentence.
    expect(vault.withheldDetail(account.id)).toBe(CLAUDE_CLIENT_MISSING_TEXT);
    expect(vault.availableModels()).toEqual([]);
    expect(vault.availableModelsByAccount()).toEqual([]);
    // Never a sign-out: no "a provider needs sign in" card behind it.
    expect(await vault.sweepLiveness()).toEqual([]);

    installed = true;
    await vault.status(account.id, { refresh: true });
    expect((await vault.views())[0]?.detail).toBeUndefined();
    expect(vault.withheldDetail(account.id)).toBeUndefined();
    expect(vault.availableModels()).toEqual(claudeAvailableModels());
  });

  it("rejects unoffered providers at add", async () => {
    const vault = AccountVault.create(freshPaths());
    await expect(vault.add("anthropic", "oauth", bridge())).rejects.toThrow(
      /not available to connect/,
    );
    await expect(vault.add("cursor", "oauth", bridge())).rejects.toThrow(
      /not available to connect/,
    );
  });

  it("loads a stored Cursor account without a row and without deleting it", async () => {
    const paths = freshPaths();
    mkdirSync(paths.accountsDir, { recursive: true });
    const retired = [
      {
        id: "acct_cursor_old",
        providerId: "cursor",
        kind: "subscription_oauth",
        label: "Work",
        enabled: true,
        createdAt: 2,
      },
    ];
    writeFileSync(
      join(paths.accountsDir, "registry.json"),
      JSON.stringify({ version: 1, accounts: retired, pins: { cursor: "acct_cursor_old" } }),
    );
    const vault = AccountVault.create(paths);
    expect(vault.list()).toEqual([]);
    expect(vault.list("cursor")).toEqual([]);
    expect(await vault.views()).toEqual([]);
    expect(vault.availableModels()).toEqual([]);
    expect(await vault.sweepLiveness()).toEqual([]);
    const stored = JSON.parse(readFileSync(join(paths.accountsDir, "registry.json"), "utf8")) as {
      accounts: { id: string }[];
    };
    expect(stored.accounts.map((account) => account.id)).toEqual(["acct_cursor_old"]);
  });

  it("loads a Kimi Code account stored before Kimi Code came back, with its pin", async () => {
    // INF-560, the captain's answer: "Load them, and let the row say sign in
    // again when the token has lapsed".
    const paths = freshPaths();
    mkdirSync(paths.accountsDir, { recursive: true });
    writeFileSync(
      join(paths.accountsDir, "registry.json"),
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: "acct_kimi",
            providerId: "kimi-coding",
            kind: "api_key",
            label: "Personal",
            enabled: true,
            createdAt: 1,
          },
        ],
        pins: { "kimi-coding": "acct_kimi" },
      }),
    );
    const vault = AccountVault.create(paths);
    expect(vault.list("kimi-coding").map((account) => account.id)).toEqual(["acct_kimi"]);
    expect((await vault.views()).map((view) => [view.id, view.providerId, view.pinned])).toEqual([
      ["acct_kimi", "kimi-coding", true],
    ]);
  });

  it("loads a Copilot account stored before, and reads its allowance with its GitHub sign-in", async () => {
    // The captain's answer on INF-560: accounts stored under Copilot's id
    // before it came back load again. Its allowance is read with the
    // GitHub sign-in Pi stored, never the short-lived Copilot token.
    const paths = freshPaths();
    const store = join(paths.accountsDir, "github-copilot", "acct_copilot");
    mkdirSync(store, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(store, "auth.json"),
      JSON.stringify({
        "github-copilot": {
          type: "oauth",
          refresh: "gho_stored-sign-in",
          access: "tid=stub;exp=1;proxy-ep=proxy.individual.githubcopilot.com",
          expires: 1,
        },
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      join(paths.accountsDir, "registry.json"),
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: "acct_copilot",
            providerId: "github-copilot",
            kind: "subscription_oauth",
            label: "Work",
            enabled: true,
            createdAt: 2,
          },
        ],
        pins: {},
      }),
    );
    const vault = AccountVault.create(paths);
    expect(vault.list().map((account) => [account.id, account.providerId])).toEqual([
      ["acct_copilot", "github-copilot"],
    ]);
    expect(await vault.resolveForQuota("acct_copilot")).toEqual({
      apiKey: "gho_stored-sign-in",
      baseUrl: "https://api.github.com",
      usingOAuth: true,
    });
    // The store is read, never rewritten: the expired Copilot token stays.
    expect(
      JSON.parse(readFileSync(join(store, "auth.json"), "utf8"))["github-copilot"].expires,
    ).toBe(1);
  });

  it("skips a stored Cursor account everywhere, keeping its store on disk", async () => {
    const paths = freshPaths();
    const store = join(paths.accountsDir, "cursor", "acct_cursor");
    mkdirSync(join(store, ".cursor"), { recursive: true });
    writeFileSync(join(store, ".cursor", "auth.json"), '{"accessToken":"kept"}');
    writeFileSync(
      join(paths.accountsDir, "registry.json"),
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: "acct_cursor",
            providerId: "cursor",
            kind: "subscription_oauth",
            label: "Pro",
            enabled: true,
            createdAt: 1,
          },
        ],
        pins: { cursor: "acct_cursor" },
      }),
    );
    const vault = AccountVault.create(paths);
    await vault.warm();
    expect(vault.list()).toEqual([]);
    expect(await vault.views()).toEqual([]);
    expect(vault.availableModels()).toEqual([]);
    expect(await vault.sweepLiveness()).toEqual([]);
    // Nothing binds, routes or resumes onto it: it reads as an account that
    // is no longer registered, never as a Pi account.
    expect(vault.get("acct_cursor")).toBeUndefined();
    expect(vault.backendIdOf("acct_cursor")).toBeUndefined();
    expect(vault.connectedSync("acct_cursor")).toBe(false);
    expect(() => vault.binding("acct_cursor")).toThrow(/Unknown account/);
    expect(() => vault.runtimeFor("acct_cursor")).toThrow(/Unknown account/);
    expect(await vault.resolveForQuota("acct_cursor")).toBeUndefined();
    expect(readFileSync(join(store, ".cursor", "auth.json"), "utf8")).toBe(
      '{"accessToken":"kept"}',
    );
    const stored = JSON.parse(readFileSync(join(paths.accountsDir, "registry.json"), "utf8")) as {
      accounts: { id: string }[];
    };
    expect(stored.accounts.map((account) => account.id)).toEqual(["acct_cursor"]);
  });

  it("skips an Antigravity account an earlier version connected, keeping its row and folder", async () => {
    // The captain removed Antigravity support on 2026-11-12, and an account
    // someone already connected must not break the app. This is the row and
    // empty store folder the alpha's Antigravity sign-in wrote.
    const paths = freshPaths();
    const store = join(paths.accountsDir, "google-antigravity", "acct_5e1f09ab");
    mkdirSync(store, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(paths.accountsDir, "registry.json"),
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: "acct_5e1f09ab",
            providerId: "google-antigravity",
            kind: "subscription_oauth",
            label: "Antigravity",
            enabled: true,
            createdAt: 1794470000000,
            lastConnectedAt: 1794470000000,
          },
        ],
        pins: { "google-antigravity": "acct_5e1f09ab" },
      }),
    );
    const vault = AccountVault.create(paths);
    await vault.warm();
    expect(vault.list()).toEqual([]);
    expect(await vault.views()).toEqual([]);
    expect(vault.availableModels()).toEqual([]);
    expect(await vault.sweepLiveness()).toEqual([]);
    expect(vault.backendIdOf("acct_5e1f09ab")).toBeUndefined();
    expect(() => vault.binding("acct_5e1f09ab")).toThrow(/Unknown account/);
    await expect(vault.add("google-antigravity", "oauth", bridge())).rejects.toThrow(
      /not available to connect/,
    );
    expect(existsSync(store)).toBe(true);
    const stored = JSON.parse(readFileSync(join(paths.accountsDir, "registry.json"), "utf8")) as {
      accounts: { id: string }[];
    };
    expect(stored.accounts.map((account) => account.id)).toEqual(["acct_5e1f09ab"]);
  });
});

/**
 * The cut-off contract on the account (W1 S7, docs/quota.md "Typed
 * cut-offs"): a typed cut-off a session observed is a durable fact on the
 * account, read through one predicate, and it clears only when a fact
 * changes - never on a timer, and a refusal never renews.
 */
describe("a typed cut-off on the account", () => {
  type Facts = {
    health: CredentialHealth;
    stamp: CredentialStamp;
    now: number;
  };

  function claudeWorld(initial: Partial<Facts> = {}) {
    const facts: Facts = {
      health: { state: "healthy", authType: "oauth" },
      stamp: { login: "login-a", written: "file:1", client: "2.1.234" },
      now: 1_800_000_000_000,
      ...initial,
    };
    const renew = vi.fn(
      async (_account: AccountRef, _reason: RenewReason): Promise<RenewalOutcome> => ({
        outcome: "renewed",
      }),
    );
    const backend: AccountBackend = {
      id: "claude",
      authTypes: () => ["oauth"],
      login: async () => {},
      logout: async () => undefined,
      health: async () => ({ ...facts.health, stamp: { ...facts.stamp } }),
      renew,
      status: async () => statusFromHealth(facts.health),
      binding: () => ({ via: "default-login" }),
    };
    const paths = freshPaths();
    const open = () =>
      AccountVault.create(paths, {
        backends: [backend],
        modelsForAccount: ({ providerId }) =>
          providerId === CLAUDE_PROVIDER_ID ? claudeAvailableModels() : [],
        now: () => facts.now,
      });
    return { facts, renew, paths, open };
  }

  async function signedInClaude(world: ReturnType<typeof claudeWorld>) {
    const vault = world.open();
    const account = await vault.add(CLAUDE_PROVIDER_ID, "oauth", bridge());
    expect(vault.availableModels()).toEqual(claudeAvailableModels());
    return { vault, id: account.id };
  }

  it("withholds a refused login everywhere at once, while it stays connected", async () => {
    const world = claudeWorld();
    const { vault, id } = await signedInClaude(world);

    vault.noteCutOff(id, { class: "refused" });

    // The synchronous readers see it before any read completes.
    expect(vault.servesSync(id)).toBe(false);
    expect(vault.withheldReason(id)).toBe("refused");
    expect(vault.availableModels()).toEqual([]);
    expect(vault.availableModelsByAccount()).toEqual([]);
    // Not a sign-out: nothing proved the credential bad.
    expect(vault.connectedSync(id)).toBe(true);
    expect(await vault.health(id, { refresh: true })).toMatchObject({
      state: "degraded",
      reason: "refused",
    });
    const [view] = await vault.views();
    expect(view).toMatchObject({ connected: true });
    expect(view?.needsReauth).toBeUndefined();
    expect(await vault.sweepLiveness()).toEqual([]);
  });

  it("says the cut-off in the account's row, as a computer that runs work tells its home, until it clears", async () => {
    const world = claudeWorld();
    const { vault, id } = await signedInClaude(world);
    expect((await vault.views())[0]?.cutOff).toBeUndefined();

    vault.noteCutOff(id, { class: "signed_out" });
    expect((await vault.views())[0]?.cutOff).toEqual({
      class: "signed_out",
      since: world.facts.now,
    });
    // A spent allowance names its reset; the stamp never leaves the vault.
    const spent = claudeWorld();
    const held = await signedInClaude(spent);
    held.vault.noteCutOff(held.id, { class: "no_headroom", resetsAt: spent.facts.now + 60_000 });
    expect((await held.vault.views())[0]?.cutOff).toEqual({
      class: "no_headroom",
      since: spent.facts.now,
      resetsAt: spent.facts.now + 60_000,
    });

    // Signed in again: the credential is written anew, and the row says none.
    world.facts.stamp = { ...world.facts.stamp, written: "file:2" };
    await vault.health(id, { refresh: true });
    expect((await vault.views())[0]?.cutOff).toBeUndefined();
  });

  // INF-443 piece 1, question 2: credits added before the reset end the hold.
  it("ends a spent allowance early when a later reading shows more left than at the refusal, and not before", async () => {
    const world = claudeWorld();
    const { vault, id } = await signedInClaude(world);
    const resetsAt = world.facts.now + 600 * 60_000;
    vault.noteCutOff(id, { class: "no_headroom", resetsAt }, { leftPercent: 19 });
    expect(vault.cutOff(id)).toMatchObject({ class: "no_headroom", resetsAt, leftPercent: 19 });

    expect(vault.noteReading(id, 19)).toBe(false);
    expect(vault.noteReading(id, 3)).toBe(false);
    expect(vault.cutOff(id)?.class).toBe("no_headroom");
    // The hold is not a row's own field.
    expect((await vault.views())[0]?.cutOff).toEqual({
      class: "no_headroom",
      since: world.facts.now,
      resetsAt,
    });

    // Credits were added: more left than at the refusal.
    const heard: string[] = [];
    vault.onCutOffChange((accountId) => heard.push(accountId));
    expect(vault.noteReading(id, 64)).toBe(true);
    expect(vault.cutOff(id)).toBeUndefined();
    await Promise.resolve();
    expect(heard).toEqual([id]);
  });

  // A pool of own logins waits on a refused login's return (docs/quota.md,
  // "A reset between readings"): when the provider names an earlier return,
  // the wait must hear it, with no new reading.
  it("tells its listeners when a spent allowance's return moves, and not when it is named again", async () => {
    const world = claudeWorld();
    const { vault, id } = await signedInClaude(world);
    const HOUR = 60 * 60_000;
    const start = world.facts.now;
    vault.noteCutOff(id, { class: "no_headroom", resetsAt: start + 3 * HOUR });
    await Promise.resolve();

    // The pooled login's used-up session reset an hour ago; the refusal holds it.
    const row = (accountId: string) => ({
      provider: "claude",
      label: "Claude",
      accountId,
      status: "ok" as const,
      stale: false,
      windows: [{ id: "session", label: "session", percentRemaining: 0, resetsAtMs: start - HOUR }],
    });
    const quota = new QuotaService({
      refresh: async () => ({
        snapshot: {
          generatedAt: new Date(start).toISOString(),
          fetchedAt: start,
          providers: [row(id), row("other")],
        },
        catalog: { generatedAt: new Date(start).toISOString(), models: [] },
      }),
      db: openInMemoryDatabase(),
      broadcast: () => {},
      now: () => world.facts.now,
      pools: (snapshot, refusedUntil) =>
        accountPools(
          snapshot.providers,
          [id, "other"].map((accountId) => ({ accountId, provider: "claude" })),
          snapshot.fetchedAt,
          refusedUntil,
        ),
      refusedUntil: (accountId) => (accountId === id ? vault.cutOff(id)?.resetsAt : undefined),
    });
    const heard: string[] = [];
    vault.onCutOffChange((accountId) => {
      heard.push(accountId);
      quota.restamp();
    });
    await quota.refresh("demand");
    quota.stop();
    const sessionOf = () =>
      quota
        .latest()
        ?.providers.find((entry) => entry.accountId === id)
        ?.windows.map((window) => window.id);
    expect(sessionOf()).toEqual(["session"]);

    // The same return named again is no news.
    vault.noteCutOff(id, { class: "no_headroom", resetsAt: start + 3 * HOUR });
    await Promise.resolve();
    expect(heard).toEqual([]);

    // The provider now says one hour, not three.
    vault.noteCutOff(id, { class: "no_headroom", resetsAt: start + HOUR });
    await Promise.resolve();
    expect(heard).toEqual([id]);
    expect(sessionOf()).toEqual(["session"]);
    world.facts.now = start + HOUR;
    expect(sessionOf()).toEqual([]);
  });

  // INF-4104 piece 2: Keep going on credits, and a top-up ending the hold.
  it("saves Keep going on credits on the account and ends a spent allowance's hold when credits answer again", async () => {
    const world = claudeWorld();
    const { vault, id } = await signedInClaude(world);
    vault.noteCutOff(id, { class: "no_headroom", resetsAt: world.facts.now + 60_000 });
    expect(vault.noteCreditsAvailable(id)).toBe(false);
    expect(vault.cutOff(id)?.class).toBe("no_headroom");

    vault.setKeepGoingOnCredits(id, true);
    expect((await vault.views())[0]?.keepGoingOnCredits).toBe(true);
    expect(world.open().keepsGoingOnCredits(id)).toBe(true);
    // The provider's refusal still holds: the switch serves nothing yet.
    expect(vault.servesOnCredits(id)).toBe(false);
    expect(vault.noteCreditsAvailable(id)).toBe(true);
    expect(vault.cutOff(id)).toBeUndefined();
    expect(vault.servesOnCredits(id)).toBe(true);

    vault.setKeepGoingOnCredits(id, false);
    expect((await vault.views())[0]?.keepGoingOnCredits).toBeUndefined();
  });

  it("refuses Keep going on credits for a provider that sells no credits past its allowance", async () => {
    const vault = AccountVault.create(freshPaths());
    const account = await vault.add("xai", "oauth", bridge());
    expect(() => vault.setKeepGoingOnCredits(account.id, true)).toThrow(
      "This account cannot keep going on credits.",
    );
    expect(vault.keepsGoingOnCredits(account.id)).toBe(false);
  });

  // INF-5478's plan, piece 2: Use saved resets on their own is a Codex account's switch, off unless turned on.
  it("saves Use saved resets on their own on a Codex account only, off by default", async () => {
    const vault = AccountVault.create(freshPaths());
    const codex = await vault.add("openai-codex", "oauth", bridge());
    expect(vault.usesSavedResets(codex.id)).toBe(false);
    vault.setUseSavedResets(codex.id, true);
    expect((await vault.views()).find((view) => view.id === codex.id)?.useSavedResets).toBe(true);
    vault.setUseSavedResets(codex.id, false);
    expect(
      (await vault.views()).find((view) => view.id === codex.id)?.useSavedResets,
    ).toBeUndefined();

    const grok = await vault.add("xai", "oauth", bridge());
    expect(() => vault.setUseSavedResets(grok.id, true)).toThrow(
      "Only a Codex account can use saved resets on its own.",
    );
    expect(vault.usesSavedResets(grok.id)).toBe(false);
  });

  it("keeps a lower reading than the one it saw, and ends on a reading above that", async () => {
    const world = claudeWorld();
    const { vault, id } = await signedInClaude(world);
    vault.noteCutOff(
      id,
      { class: "no_headroom", resetsAt: world.facts.now + 60_000 },
      { leftPercent: 20 },
    );
    // The sensor catching up with the refusal: the hold now stands on 0%.
    expect(vault.noteReading(id, 0)).toBe(false);
    expect(vault.cutOff(id)).toMatchObject({ class: "no_headroom", leftPercent: 0 });
    // The allowance came back, though not above the reading first seen.
    expect(vault.noteReading(id, 20)).toBe(true);
    expect(vault.cutOff(id)).toBeUndefined();
  });

  // Reported: after a Fable reset, Claude's "weekly (with overage)" meter read 0
  // in Infinitary while every other meter was green and the Claude client
  // served. The client streams the Fable limit's refusal as
  // seven_day_overage_included with the week's reset; a Fable reset gives the
  // usage back but keeps that reset time. Wired as homeQuota wires the sensor,
  // the refusal and the hold; only the vendor is stood in, in the client's
  // stream shape and the usage endpoint's (fetchQuota.test.ts's capture).
  it("ends a Claude refusal's hold and its 0% meter once a reading after a Fable reset shows the allowance back", async () => {
    const world = claudeWorld({ now: Date.parse("2026-11-10T17:00:00Z") });
    const { vault, id } = await signedInClaude(world);
    const pushed = new PushedQuotaStore(openInMemoryDatabase());
    const fableWeekResets = Date.parse("2026-11-14T17:00:00Z");
    const usage = (fableUsed: number) => ({
      five_hour: { utilization: 12, resets_at: "2026-11-11T20:00:00Z" },
      seven_day: { utilization: 41, resets_at: "2026-11-14T17:00:00Z" },
      extra_usage: { is_enabled: false, utilization: 0 },
      limits: [
        { kind: "session", group: "session", percent: 12, resets_at: "2026-11-11T20:00:00Z" },
        { kind: "weekly_all", group: "weekly", percent: 41, resets_at: "2026-11-14T17:00:00Z" },
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: fableUsed,
          resets_at: "2026-11-14T17:00:00Z",
          scope: { model: { id: null, display_name: "Fable" } },
        },
      ],
    });
    let answer = usage(98);
    // homeQuota's sensor wiring.
    const sensedLeft = new Map<string, number>();
    const refresh = createQuotaFetcher({
      auth: {
        accounts: () => [
          {
            accountId: id,
            accountLabel: "Personal",
            quotaId: "claude",
            piId: "anthropic",
            providerLabel: "Claude",
          },
        ],
        resolve: async () => ({ apiKey: "stand-in", usingOAuth: true }),
      },
      http: async () => ({ status: 200, json: answer }),
      models: () => [],
      now: () => world.facts.now,
      onAccepted: (accountId, windows) => {
        vault.noteAccepted(accountId);
        const left = lowestLeft(windows);
        if (left !== undefined) sensedLeft.set(accountId, left);
        if (left !== undefined && vault.noteReading(accountId, left)) {
          for (const window of pushed.windowsFor(accountId)) {
            if (window.status === "rejected")
              pushed.record(accountId, { ...window, status: "allowed", at: world.facts.now });
          }
        }
      },
      overlay: (view, now) =>
        view.accountId ? withRejectedReadings(view, pushed.windowsFor(view.accountId), now) : view,
    });
    const zeroMeters = async () =>
      (await refresh("demand")).snapshot.providers[0]?.windows
        .filter((window) => window.percentRemaining === 0)
        .map((window) => window.id);

    // Fable nearly spent, then the client refuses a turn on the Fable limit.
    await refresh("interval");
    world.facts.now = Date.parse("2026-11-10T18:00:00Z");
    const state = createNormalizerState();
    for (const message of [
      {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          resetsAt: fableWeekResets / 1000,
          rateLimitType: "seven_day_overage_included",
          overageStatus: "rejected",
          overageDisabledReason: "out_of_credits",
          isUsingOverage: false,
        },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "You've hit your Fable limit" }],
        },
        parent_tool_use_id: null,
        error: "rate_limit",
      },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        result: "You've hit your Fable limit",
        api_error_status: 429,
        total_cost_usd: 0,
        modelUsage: {},
      },
    ]) {
      const out = fmEventsFromClaudeMessage(message, "task-1", state);
      // homeQuota's recordClaudeRateLimit and noteCutOff.
      if (out.rateLimit?.windowId) {
        pushed.record(id, {
          windowId: out.rateLimit.windowId,
          status: out.rateLimit.status,
          ...(out.rateLimit.resetsAt !== undefined ? { resetsAt: out.rateLimit.resetsAt } : {}),
          at: world.facts.now,
        });
      }
      const cutOff = out.failure?.cutOff;
      if (cutOff) {
        recordCutOff(
          {
            providerOf: (accountId) => vault.get(accountId)?.providerId,
            latest: () => undefined,
            sensedLeft: (accountId) => sensedLeft.get(accountId),
            hold: (accountId, held, seen) => vault.noteCutOff(accountId, held, seen),
            holding: (accountId) => vault.cutOff(accountId)?.class === "no_headroom",
            refuse: () => {},
            refresh: () => {},
          },
          id,
          cutOff,
          world.facts.now,
        );
      }
    }
    expect(vault.cutOff(id)).toMatchObject({ class: "no_headroom", resetsAt: fableWeekResets });
    expect(await zeroMeters()).toEqual(["seven_day_overage_included"]);

    // The Fable reset is used: the usage answer is green, the week's reset unchanged.
    world.facts.now = Date.parse("2026-11-11T17:00:00Z");
    answer = usage(3);
    expect(await zeroMeters()).toEqual([]);
    expect(vault.cutOff(id)).toBeUndefined();
  });

  it("holds against the first reading after a hold that recorded none, and never ends a refusal on a reading", async () => {
    const world = claudeWorld();
    const { vault, id } = await signedInClaude(world);
    vault.noteCutOff(id, { class: "no_headroom", resetsAt: world.facts.now + 60_000 });
    expect(vault.noteReading(id, 90)).toBe(false);
    expect(vault.cutOff(id)).toMatchObject({ class: "no_headroom", leftPercent: 90 });

    const refused = claudeWorld();
    const held = await signedInClaude(refused);
    held.vault.noteCutOff(held.id, { class: "refused" });
    expect(held.vault.noteReading(held.id, 90)).toBe(false);
    expect(held.vault.cutOff(held.id)?.class).toBe("refused");
  });

  it("survives a restart, stamped with the login and client it was seen under", async () => {
    const world = claudeWorld();
    const { vault, id } = await signedInClaude(world);
    vault.noteCutOff(id, { class: "refused" });
    await vault.health(id, { refresh: true });

    const reopened = world.open();
    // Before any read the durable fact already withholds the account.
    expect(reopened.servesSync(id)).toBe(false);
    expect(reopened.withheldReason(id)).toBe("refused");
    expect(reopened.cutOff(id)).toEqual({
      class: "refused",
      since: world.facts.now,
      stamp: { login: "login-a", written: "file:1", client: "2.1.234" },
    });
    await reopened.status(id, { refresh: true });
    expect(reopened.servesSync(id)).toBe(false);
    expect(reopened.availableModels()).toEqual([]);
  });

  it("reads a registry an older build wrote as no cut-off, and drops a shape it cannot read", () => {
    const world = claudeWorld();
    mkdirSync(world.paths.accountsDir, { recursive: true });
    const row = {
      providerId: CLAUDE_PROVIDER_ID,
      kind: "subscription_oauth",
      label: "Claude",
      enabled: true,
      createdAt: 1,
    };
    writeFileSync(
      join(world.paths.accountsDir, "registry.json"),
      JSON.stringify({
        version: 1,
        accounts: [
          { ...row, id: "acct_old" },
          { ...row, id: "acct_bad", cutOff: { class: "banned", since: 1, stamp: {} } },
          {
            ...row,
            id: "acct_new",
            cutOff: { class: "refused", since: 5, stamp: { login: "x", written: 7 } },
          },
        ],
        pins: {},
      }),
    );
    const vault = world.open();
    expect(vault.get("acct_old")).toMatchObject({ id: "acct_old", label: "Claude" });
    expect(vault.cutOff("acct_old")).toBeUndefined();
    expect(vault.cutOff("acct_bad")).toBeUndefined();
    // A stamp part of a shape this build does not know is simply unseen.
    expect(vault.cutOff("acct_new")).toEqual({
      class: "refused",
      since: 5,
      stamp: { login: "x" },
    });
  });

  it("clears a refusal on a changed client or login, or the captain's word - never on a renewal's rewrite or the clock", async () => {
    const world = claudeWorld();
    const { vault, id } = await signedInClaude(world);
    vault.noteCutOff(id, { class: "refused" });
    await vault.health(id, { refresh: true });

    // The live credential renewed itself, and a day went by: still refused.
    world.facts.stamp = { ...world.facts.stamp, written: "file:2" };
    world.facts.now += 24 * 60 * 60 * 1000;
    await vault.health(id, { refresh: true });
    expect(vault.cutOff(id)?.class).toBe("refused");
    expect(vault.servesSync(id)).toBe(false);

    // A read that cannot see the login is not a changed login.
    world.facts.stamp = { written: "file:2", client: "2.1.234" };
    await vault.health(id, { refresh: true });
    expect(vault.cutOff(id)?.class).toBe("refused");

    world.facts.stamp = { login: "login-a", written: "file:2", client: "2.1.300" };
    await vault.health(id, { refresh: true });
    expect(vault.cutOff(id)).toBeUndefined();
    expect(vault.servesSync(id)).toBe(true);
    expect(vault.availableModels()).toEqual(claudeAvailableModels());

    vault.noteCutOff(id, { class: "refused" });
    await vault.health(id, { refresh: true });
    world.facts.stamp = { ...world.facts.stamp, login: "login-b" };
    await vault.health(id, { refresh: true });
    expect(vault.cutOff(id)).toBeUndefined();

    // The captain's "Try Claude again" clears it with nothing else changed.
    vault.noteCutOff(id, { class: "refused" });
    await vault.health(id, { refresh: true });
    expect(vault.tryAgain(id)).toBe(true);
    expect(vault.cutOff(id)).toBeUndefined();
    expect(vault.servesSync(id)).toBe(true);
    expect(vault.tryAgain(id)).toBe(false);
  });

  it("tells a listener each cut-off recorded or cleared, after the fact is saved and the caller's own work", async () => {
    const world = claudeWorld();
    const { vault, id } = await signedInClaude(world);
    const heard: { accountId: string; serves: boolean | undefined }[] = [];
    const stop = vault.onCutOffChange((accountId) =>
      heard.push({ accountId, serves: vault.servesSync(accountId) }),
    );
    vault.noteCutOff(id, { class: "refused" });
    // Not inside the note: the caller finishes first.
    expect(heard).toEqual([]);
    await Promise.resolve();
    expect(heard).toEqual([{ accountId: id, serves: false }]);
    vault.noteCutOff(id, { class: "refused" });
    await Promise.resolve();
    expect(heard).toHaveLength(1);
    expect(vault.tryAgain(id)).toBe(true);
    await Promise.resolve();
    expect(heard).toEqual([
      { accountId: id, serves: false },
      { accountId: id, serves: true },
    ]);
    // A spent allowance is heard when it is recorded and when its reset passes.
    world.facts.now += 1;
    vault.noteCutOff(id, { class: "no_headroom", resetsAt: world.facts.now + 1_000 });
    world.facts.now += 1_000;
    expect(vault.cutOff(id)).toBeUndefined();
    await Promise.resolve();
    expect(heard).toHaveLength(4);
    stop();
    vault.noteCutOff(id, { class: "refused" });
    await Promise.resolve();
    expect(heard).toHaveLength(4);
  });

  it("never renews a refused login: not on the tick, not on the sensor's rejection", async () => {
    // An expiring credential: the tick WOULD renew it (the control).
    const world = claudeWorld({ health: { state: "expiring", authType: "oauth" } });
    const { vault, id } = await signedInClaude(world);
    const service = new CredentialHealthService({
      host: {
        listEnabled: () => vault.list().map((account) => ({ accountId: account.id })),
        health: (accountId) => vault.health(accountId, { refresh: true }),
        renew: (accountId, reason) => vault.renew(accountId, reason),
      },
    });
    await service.tick();
    expect(world.renew).toHaveBeenCalledTimes(1);

    vault.noteCutOff(id, { class: "refused" });
    for (let tick = 0; tick < 5; tick++) await service.tick();
    expect(await vault.renew(id, "vendor_rejected")).toEqual({ outcome: "withheld" });
    expect(world.renew).toHaveBeenCalledTimes(1);
  });

  it("holds a lost sign-in until the store is written again, and lets proof say sign in again", async () => {
    const world = claudeWorld();
    const { vault, id } = await signedInClaude(world);
    vault.noteCutOff(id, { class: "signed_out" });
    expect(vault.servesSync(id)).toBe(false);
    // Only proof shows "sign in again": this is a withheld, connected account.
    expect(await vault.health(id, { refresh: true })).toMatchObject({
      state: "degraded",
      reason: "signed_out",
    });
    expect(vault.connectedSync(id)).toBe(true);
    // A lost sign-in is the one cut-off a renewal may answer (only a 401 renews).
    expect(await vault.renew(id, "vendor_rejected")).toEqual({ outcome: "renewed" });

    // Proof arrives: the sign-out reads as the sign-out it is.
    world.facts.health = { state: "needs_reauth", reason: "refresh_token_lapsed" };
    expect(await vault.health(id, { refresh: true })).toMatchObject({ state: "needs_reauth" });
    expect(vault.connectedSync(id)).toBe(false);
    expect(vault.cutOff(id)?.class).toBe("signed_out");

    // The person signs in again: the store is written, and the fact clears.
    world.facts.health = { state: "healthy", authType: "oauth" };
    world.facts.stamp = { ...world.facts.stamp, written: "file:2" };
    await vault.health(id, { refresh: true });
    expect(vault.cutOff(id)).toBeUndefined();
    expect(vault.servesSync(id)).toBe(true);
  });

  it("clears a sign-out when the same login is accepted again, without a rewrite", async () => {
    const world = claudeWorld();
    const { vault, id } = await signedInClaude(world);
    vault.noteCutOff(id, { class: "signed_out" });
    await vault.health(id, { refresh: true });
    expect(vault.cutOff(id)?.class).toBe("signed_out");
    expect(vault.servesSync(id)).toBe(false);

    // A good allowance reading, or a turn that succeeded, is the provider
    // accepting this login. The stamp did not move.
    vault.noteAccepted(id);
    expect(vault.cutOff(id)).toBeUndefined();
    expect(vault.servesSync(id)).toBe(true);

    // A refusal is not a credential problem, so acceptance does not clear it.
    vault.noteCutOff(id, { class: "refused" });
    vault.noteAccepted(id);
    expect(vault.cutOff(id)?.class).toBe("refused");

    // Signing in again to the same login rewrites nothing, and still clears
    // a sign-out.
    expect(vault.tryAgain(id)).toBe(true);
    vault.noteCutOff(id, { class: "signed_out" });
    await vault.signIn(id, bridge());
    expect(vault.cutOff(id)).toBeUndefined();
    expect(vault.servesSync(id)).toBe(true);
  });

  it("adopts the stamp from the first read that can see it, never counting that as a change", async () => {
    const world = claudeWorld({ stamp: {} });
    const { vault, id } = await signedInClaude(world);
    vault.noteCutOff(id, { class: "signed_out" });
    await vault.health(id, { refresh: true });
    expect(vault.cutOff(id)?.stamp).toEqual({});

    world.facts.stamp = { login: "login-a", written: "file:1" };
    await vault.health(id, { refresh: true });
    expect(vault.cutOff(id)).toMatchObject({
      class: "signed_out",
      stamp: { login: "login-a", written: "file:1" },
    });

    world.facts.stamp = { login: "login-a", written: "file:2" };
    await vault.health(id, { refresh: true });
    expect(vault.cutOff(id)).toBeUndefined();
  });

  it("never lets a looser cut-off replace a standing refusal", async () => {
    const world = claudeWorld();
    const { vault, id } = await signedInClaude(world);
    vault.noteCutOff(id, { class: "refused" });
    await vault.health(id, { refresh: true });
    const refused = vault.cutOff(id);

    // A turn already in flight settles on a spent allowance: the refusal stands,
    // and the allowance's reset does not clear it.
    const resetsAt = world.facts.now + 60 * 60 * 1000;
    vault.noteCutOff(id, { class: "no_headroom", resetsAt });
    expect(vault.cutOff(id)).toEqual(refused);
    expect(vault.servesSync(id)).toBe(false);
    world.facts.now = resetsAt + 1;
    await vault.health(id, { refresh: true });
    expect(vault.cutOff(id)?.class).toBe("refused");
    expect(vault.servesSync(id)).toBe(false);
    expect(await vault.renew(id, "vendor_rejected")).toEqual({ outcome: "withheld" });

    // Another settles on a lost sign-in, and then the store renews itself:
    // still refused.
    vault.noteCutOff(id, { class: "signed_out" });
    expect(vault.cutOff(id)?.class).toBe("refused");
    world.facts.stamp = { ...world.facts.stamp, written: "file:2" };
    await vault.health(id, { refresh: true });
    expect(vault.cutOff(id)?.class).toBe("refused");
    expect(vault.servesSync(id)).toBe(false);
  });

  it("lets a stricter cut-off replace a looser one", async () => {
    const world = claudeWorld();
    const { vault, id } = await signedInClaude(world);
    vault.noteCutOff(id, { class: "no_headroom", resetsAt: world.facts.now + 60_000 });
    vault.noteCutOff(id, { class: "signed_out" });
    expect(vault.cutOff(id)?.class).toBe("signed_out");
    vault.noteCutOff(id, { class: "no_headroom", resetsAt: world.facts.now + 60_000 });
    expect(vault.cutOff(id)?.class).toBe("signed_out");
    vault.noteCutOff(id, { class: "refused" });
    expect(vault.cutOff(id)?.class).toBe("refused");
  });

  it("keeps the first sighting when the same cut-off is seen again", async () => {
    const world = claudeWorld();
    const { vault, id } = await signedInClaude(world);
    vault.noteCutOff(id, { class: "refused" });
    await vault.health(id, { refresh: true });
    const first = vault.cutOff(id);
    world.facts.now += 60_000;
    vault.noteCutOff(id, { class: "refused" });
    expect(vault.cutOff(id)).toEqual(first);
  });

  it("clears a spent allowance when the machine's login changes, not on a rewrite or a read that cannot see the login", async () => {
    const world = claudeWorld();
    const { vault, id } = await signedInClaude(world);
    const resetsAt = world.facts.now + 60 * 60 * 1000;
    vault.noteCutOff(id, { class: "no_headroom", resetsAt });
    await vault.health(id, { refresh: true });

    // A routine rewrite of the same login, or a read that cannot see it.
    world.facts.stamp = { ...world.facts.stamp, written: "file:2" };
    await vault.health(id, { refresh: true });
    world.facts.stamp = { written: "file:3", client: "2.1.234" };
    await vault.health(id, { refresh: true });
    expect(vault.cutOff(id)?.class).toBe("no_headroom");

    // Another login is signed in: the old login's allowance no longer holds.
    world.facts.stamp = { login: "login-b", written: "file:4", client: "2.1.234" };
    await vault.health(id, { refresh: true });
    expect(vault.cutOff(id)).toBeUndefined();
    expect(world.open().cutOff(id)).toBeUndefined();
  });

  // INF-1079: the captain switches Claude's login elsewhere when one runs out.
  // INF-2318: the next store reading owns Claude's row, not its old saved label.
  it("updates Claude's label from health or allowance and keeps it through an unreadable read", async () => {
    const world = claudeWorld({
      health: { state: "healthy", authType: "oauth", identity: { label: "alex.one@example.com" } },
    });
    const { vault, id } = await signedInClaude(world);
    await vault.health(id, { refresh: true });
    expect(vault.get(id)?.label).toBe("alex.one@example.com");
    // An allowance read carries only the non-secret projection into the vault.
    vault.noteCredentialRead(
      id,
      { login: "login-b", written: "file:2" },
      { label: "alex.two@example.com" },
    );
    expect(vault.get(id)?.label).toBe("alex.two@example.com");
    world.facts.stamp = {};
    world.facts.health = { state: "degraded", reason: "unknown" };
    await vault.health(id, { refresh: true });
    expect(await vault.views()).toContainEqual(
      expect.objectContaining({ id, label: "alex.two@example.com", connected: true }),
    );
    expect(world.open().get(id)?.label).toBe("alex.two@example.com");
  });

  it("INF-3307 audit: one failed registry write during a health read does not break later reads", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const world = claudeWorld({
        health: {
          state: "healthy",
          authType: "oauth",
          identity: { label: "alex.one@example.com" },
        },
      });
      const { vault, id } = await signedInClaude(world);
      await vault.health(id, { refresh: true });
      expect(vault.get(id)?.label).toBe("alex.one@example.com");

      // The client now names another email, and the registry cannot be
      // written at that moment (a directory stands where the file was).
      const registry = join(world.paths.accountsDir, "registry.json");
      rmSync(registry);
      mkdirSync(registry);
      world.facts.health = {
        state: "healthy",
        authType: "oauth",
        identity: { label: "alex.two@example.com" },
      };
      await vault.health(id, { refresh: true }).catch(() => undefined);

      // The disk recovers; the next reads - a refresh, and the Subscriptions
      // list once its cached status is stale - answer again, no restart.
      rmSync(registry, { recursive: true });
      expect(await vault.health(id, { refresh: true })).toMatchObject({ state: "healthy" });
      vi.setSystemTime(Date.now() + 60_000);
      expect(await vault.views()).toContainEqual(expect.objectContaining({ id, connected: true }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("hears another login once from the unified health read and across a restart", async () => {
    const world = claudeWorld();
    const { vault, id } = await signedInClaude(world);
    await vault.health(id, { refresh: true });
    const heard: string[] = [];
    vault.onLoginChange((accountId) => heard.push(accountId));

    // A read that cannot see the login, or sees the same one, is no change.
    world.facts.stamp = { written: "file:2", client: "2.1.234" };
    await vault.health(id, { refresh: true });
    world.facts.stamp = { login: "login-a", written: "file:3", client: "2.1.234" };
    await vault.health(id, { refresh: true });
    await vi.waitFor(() => expect(vault.loginSync(id)).toBe("login-a"));
    expect(heard).toEqual([]);

    // Another login, seen in the next health read: what stood on the old
    // login ends, a spent allowance included.
    vault.noteCutOff(id, { class: "no_headroom", resetsAt: world.facts.now + 3_600_000 });
    // Let the cut-off's own health read finish before the external swap.
    await vault.health(id, { refresh: true });
    world.facts.stamp = { login: "login-b", written: "file:4", client: "2.1.234" };
    await vault.health(id, { refresh: true });
    await vi.waitFor(() => expect(heard).toEqual([id]));
    expect(vault.cutOff(id)).toBeUndefined();
    expect(vault.loginSync(id)).toBe("login-b");

    // Switched while the app was closed: the next start's first read hears it.
    world.facts.stamp = { login: "login-c", written: "file:5", client: "2.1.234" };
    const reopened = world.open();
    const afterRestart: string[] = [];
    reopened.onLoginChange((accountId) => afterRestart.push(accountId));
    await reopened.health(id, { refresh: true });
    await vi.waitFor(() => expect(afterRestart).toEqual([id]));
  });

  it("holds a spent allowance until its reset without withholding the account", async () => {
    const world = claudeWorld();
    const { vault, id } = await signedInClaude(world);
    const resetsAt = world.facts.now + 60 * 60 * 1000;

    // No reset named: nothing could clear it, so it is not held.
    vault.noteCutOff(id, { class: "no_headroom" });
    expect(vault.cutOff(id)).toBeUndefined();

    vault.noteCutOff(id, { class: "no_headroom", resetsAt });
    expect(vault.cutOff(id)).toMatchObject({ class: "no_headroom", resetsAt });
    // The quota reading carries a spent allowance; serveability does not.
    expect(vault.servesSync(id)).toBe(true);
    expect(vault.availableModels()).toEqual(claudeAvailableModels());
    expect(await vault.renew(id, "vendor_rejected")).toEqual({ outcome: "renewed" });

    world.facts.now = resetsAt - 1;
    expect(vault.cutOff(id)?.class).toBe("no_headroom");
    world.facts.now = resetsAt;
    expect(vault.cutOff(id)).toBeUndefined();
    expect(world.open().cutOff(id)).toBeUndefined();
  });
});
