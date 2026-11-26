import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AccountView, CredentialKind } from "@shared/accounts";
import {
  CUT_OFF_CLASSES,
  type CutOff,
  type CutOffClass,
  isLapsedRefresh,
} from "@shared/authFailure";
import { CLAUDE_ACCESS_ACCOUNT_LABEL, type ClaudeAccessSource } from "@shared/claudeAccess";
import { isClientIssueReason } from "@shared/claudeClient";
import {
  CUSTOM_API_PROVIDER_PREFIX,
  type CustomApiConnectInput,
  type CustomApiInput,
  isCustomApiProvider,
} from "@shared/customApi";
import type {
  CustomFileConnection,
  CustomFileDefinition,
  CustomHomeDefinition,
} from "@shared/customApiFile";
import { HERE } from "@shared/deviceNames";
import type { ReasoningCapabilities } from "@shared/modelSlots";
import type { BackendId } from "@shared/providers";
import {
  BEDROCK_PROVIDER_ID,
  backendForProvider,
  CLAUDE_PROVIDER_ID,
  CODE_STEP_WORDS,
  githubEnterpriseHost,
  isOfferedProvider,
  isRetiredProvider,
} from "@shared/providers";
import { allowanceProviderOf, CREDITS_SWITCH_PROVIDERS } from "@shared/quota";
import { cutText } from "@shared/textCut";
import {
  type AccountBackend,
  type AccountBinding,
  type AccountRef,
  type AccountStatus,
  claudeLoginFolder,
  type LogoutOutcome,
  statusFromHealth,
} from "../accounts/accountBackend";
import {
  type CredentialHealth,
  type CredentialStamp,
  CUT_OFF_REFUSED,
  CUT_OFF_SIGNED_OUT,
  isWithheldReason,
  type RenewalOutcome,
  type RenewReason,
  servesModels,
} from "../accounts/credentialHealth";
import type { AppPaths } from "../paths";
import { COPILOT_PROVIDER_ID, copilotMeterAuth } from "./copilotMeter";
import { modelLookup } from "./modelRuntime";
import { authPathIn, enforceAuthFileMode, PiAccountBackend } from "./piAccountBackend";
import type { AuthInteractionBridge, ResolvedProviderAuth } from "./piAuth";
import { piReasoningCapabilities } from "./reasoning";

/**
 * The AccountVault: the one owner of the multi-account store matrix
 * (account-broker phases 1+). It generalizes decision D-5 from one
 * app-scoped auth dir to an account-keyed tree of harness-native stores:
 *
 *   userData/accounts/registry.json                  non-secret metadata only
 *   userData/accounts/<providerId>/<accountId>/      0700, one per account
 *       Pi accounts:     auth.json (0600, written by Pi only) + models.json
 *       Claude accounts: bookkeeping only - the first's credential is the
 *                        default `claude login` (CD-1=B), a further one's claude/
 *
 * Infinitary owns the matrix - how many accounts exist, where each store
 * lives, isolation, and which run sees which. The harness owns each store's
 * contents (Pi's login()/getAuth refresh; Claude's own client). Infinitary code
 * never reads, parses, or forwards a token; removing an account deletes its
 * directory and structurally cannot touch a sibling. The vault is the sole
 * account-to-store mapper, so least exposure at spawn is enforced in one
 * place: a session bound to account A is handed exactly A's store.
 *
 * Which harness owns a store is the backend's business, not the vault's
 * (account-broker phase 7): the vault holds a backend per id and delegates
 * login, logout, health, renew, status and binding. Adding a subscription
 * that needs its own first-party client is a registration, not a change here.
 */

const REGISTRY_VERSION = 1;

/**
 * How long a status read stays good. Long enough that a polling tab does not
 * respawn a client every tick, short enough that a store which lost its
 * credential surfaces within one poll cycle.
 */
const STATUS_TTL_MS = 30_000;

export type AccountRecord = {
  id: string;
  providerId: string;
  kind: CredentialKind;
  label: string;
  enabled: boolean;
  createdAt: number;
  lastConnectedAt?: number;
  /** Round-robin cursor for selection among unknown-quota accounts. */
  lastSelectedAt?: number;
  /**
   * The login its store last named (`CredentialStamp.login`), for a backend
   * that can say: a different one later is a changed login (`onLoginChange`).
   */
  login?: string;
  /** A further Claude login, in its own folder in the store (docs/claude-client.md, "Further logins"). */
  ownLogin?: true;
  /**
   * A typed cut-off standing on this account (`noteCutOff`). Absent on a row
   * written before it existed, which is simply no cut-off.
   */
  cutOff?: AccountCutOff;
  /**
   * Keep going on credits (docs/quota.md): once the allowance is spent, the
   * account keeps serving on its provider's credits. Absent is off, as on a
   * row written before it existed.
   */
  keepGoingOnCredits?: boolean;
  /**
   * Use saved resets on their own (docs/quota.md "Saved resets on their
   * own"): with work waiting on the account's spent Codex allowance,
   * Infinitary may use one of its saved resets without a click. Absent is
   * off, as on a row written before it existed.
   */
  useSavedResets?: boolean;
  /**
   * The captain tried a spent allowance anyway (`tryPastSpent`): the
   * account goes by its provider's answers, not its allowance reading,
   * until the provider refuses it again or the store names another login.
   * The client can answer on a login the store does not name, such as a
   * token its launcher passes, and only the provider sees that one.
   */
  goesByAnswers?: boolean;
  /**
   * The attempt to use one of the account's saved Codex resets that Codex
   * has not answered clearly yet (docs/codex-client.md): its key is sent
   * again on the next try, so a lost answer never uses a second reset.
   */
  savedResetAttempt?: { key: string; creditId?: string };
};

/**
 * A cut-off recorded on an account (the cut-off contract, docs/quota.md
 * "Typed cut-offs"): the class a session observed, when, and the stamp -
 * the login and client it was seen under - so it clears only when a fact
 * changes, never on a timer:
 *
 * - `no_headroom` at `resetsAt`;
 * - `signed_out` when the store's credential is written again (a new
 *   sign-in; a dead login cannot renew itself), names another login, or the
 *   provider accepts that same login again (`noteAccepted`: a good allowance
 *   reading, a turn that succeeded, or the row's Sign in);
 * - `refused` when the store names another login, the client's version
 *   changes, or the captain says "Try Claude again" (`tryAgain`). A live
 *   credential renews itself routinely, so a rewrite alone is not a changed
 *   login for a refusal.
 *
 * A stamp part the note could not see is adopted from the next read that
 * does, never counted as a change.
 */
export type AccountCutOff = {
  class: CutOffClass;
  /** When it was observed, epoch ms. */
  since: number;
  /** When a spent allowance returns, epoch ms (`no_headroom` only). */
  resetsAt?: number;
  /**
   * The lowest percent left the sensor read since a spent allowance was
   * observed (`noteCutOff`, then `noteReading`): a later reading that shows
   * more ends the hold early, as after a top-up or a reset the vendor gave
   * back before the one it named.
   */
  leftPercent?: number;
  stamp: CredentialStamp;
};

type Registry = {
  version: number;
  accounts: AccountRecord[];
  /** Per-provider account pin: always wins selection while healthy. */
  pins: Record<string, string>;
};

export type { AccountBinding, AccountStatus };

export type AccountVaultOptions = {
  /** Told before the first further Claude login's record is saved, and after one is removed. */
  furtherLoginsHeld?: (held: boolean) => void;
  /** The Pi backend, named because in-process Pi has extra reach (runtimes). */
  pi?: PiAccountBackend;
  /** Every other registered backend. Pi alone is the phases 1-6 shape. */
  backends?: AccountBackend[];
  /**
   * The models a non-Pi account serves. Pi accounts report their own
   * availability from their runtime; Claude has no in-process catalog, so
   * its models come from the account's last successful catalog read, else
   * its module's shipped list (docs/model-lists.md). Each carries the name
   * that list gives it, which the Models board shows until the quota
   * catalog names it.
   */
  modelsForAccount?: (account: {
    accountId: string;
    providerId: string;
  }) => { provider: string; id: string; name?: string }[];
  /**
   * The account's own model list, when a successful read of it is in hand:
   * a Pi account then serves only the catalog ids it names. Undefined means
   * no filter - the Pi catalog as it is (docs/model-lists.md).
   */
  piModelFilter?: (accountId: string) => ReadonlySet<string> | undefined;
  /** The clock a cut-off is stamped and cleared by; production is `Date.now`. */
  now?: () => number;
  /**
   * Called before a sign-in or sign-out rewrites an account's store: the
   * Firstmate's seat stays off that account, and lets go of a client that
   * holds its store, until the returned release (W1 S9).
   */
  holdSeat?: (accountId: string) => Promise<() => void>;
  /**
   * Signs the Codex CLI out of an account's Codex home before the account
   * is removed (docs/codex-client.md); best effort, since removing the
   * folder is the guarantee.
   */
  signOutCodex?: (home: string) => Promise<void>;
};

export class AccountVault {
  private registry: Registry;
  private readonly backends = new Map<BackendId, AccountBackend>();
  /** Last-known status per account, for synchronous selection-time reads. */
  private readonly lastStatus = new Map<string, AccountStatus>();
  /** When each status was read, so a polling UI does not re-read constantly. */
  private readonly statusReadAt = new Map<string, number>();
  /** A status read in flight, so concurrent callers share one. */
  private readonly statusInFlight = new Map<string, Promise<AccountStatus>>();
  /**
   * Last-known health as the backend reported it, so a throw cannot
   * fabricate a sign-out. A standing cut-off is laid over it on the way out.
   */
  private readonly lastHealth = new Map<string, CredentialHealth>();
  private readonly healthReadAt = new Map<string, number>();
  private readonly healthInFlight = new Map<string, Promise<CredentialHealth>>();
  /** Pi accounts whose last credential read the provider refused the refresh token for. */
  private readonly lapsedRefresh = new Set<string>();

  private readonly pi: PiAccountBackend;
  private readonly now: () => number;
  /** Who hears a cut-off recorded or cleared (`onCutOffChange`). */
  private readonly cutOffListeners = new Set<(accountId: string) => void>();
  private readonly loginListeners = new Set<(accountId: string) => void>();
  /** A failed sign-in's second sweep, once its backend's own work settles. */
  private readonly sweeping = new Set<Promise<void>>();
  /** A Claude sign-in that has passed the account check and not settled. */
  private claudeLoginInFlight = false;
  /** The registry file is there but could not be read (`mayHoldAccounts`). */
  private registryUnread = false;
  /** Each connection's checks a connection file edit asked for, in order. */
  private readonly fileChecks = new Map<string, Promise<void>>();
  /** The models file edits cost a check, kept until a check of them runs to its end. */
  private readonly fileChecksOwed = new Map<string, Set<string>>();
  /** What the first mate's computer last sent, on a computer that runs work (`applyCustomHome`). */
  private homeDefinitions: CustomHomeDefinition[] | undefined;

  private constructor(
    private readonly paths: Pick<AppPaths, "accountsDir">,
    private readonly options: AccountVaultOptions,
  ) {
    this.registry = this.loadRegistry();
    // An unread registry says nothing of what it holds, so the mark stands.
    if (!this.registryUnread)
      options.furtherLoginsHeld?.(this.registry.accounts.some((entry) => entry.ownLogin));
    this.now = options.now ?? Date.now;
    this.pi = options.pi ?? new PiAccountBackend();
    for (const account of this.registry.accounts) {
      if (isCustomApiProvider(account.providerId))
        this.pi.custom.attach(this.refFor(account), account.enabled);
    }
    for (const backend of [this.pi, ...(options.backends ?? [])]) {
      this.backends.set(backend.id, backend);
    }
  }

  static create(
    paths: Pick<AppPaths, "accountsDir">,
    options: AccountVaultOptions = {},
  ): AccountVault {
    mkdirSync(paths.accountsDir, { recursive: true, mode: 0o700 });
    return new AccountVault(paths, options);
  }

  async warm(): Promise<void> {
    await Promise.all(
      this.liveAccounts()
        .filter((account) => account.enabled)
        .map(async (account) => {
          await this.status(account.id).catch(() => undefined);
          if (isCustomApiProvider(account.providerId) && this.pi.custom.checked(account.id))
            await this.runtimeFor(account.id).catch(() => undefined);
        }),
    );
  }

  list(providerId?: string): AccountRecord[] {
    const accounts = providerId
      ? this.liveAccounts().filter((account) => account.providerId === providerId)
      : this.liveAccounts();
    return accounts.map((account) => ({ ...account }));
  }

  /**
   * One registered account. A retired provider's row reads as unknown, the
   * way a removed account does: nothing binds, routes or resumes onto it.
   */
  get(accountId: string): AccountRecord | undefined {
    const account = this.liveAccounts().find((entry) => entry.id === accountId);
    return account ? { ...account } : undefined;
  }

  bedrockProfileUnavailable(accountId: string): boolean {
    const account = this.get(accountId);
    return (
      account?.providerId === BEDROCK_PROVIDER_ID &&
      this.pi.bedrockProfileUnavailable(accountId, this.refFor(account).dir)
    );
  }

  pinnedAccount(providerId: string): string | undefined {
    return this.registry.pins[providerId];
  }

  backendIdOf(accountId: string): BackendId | undefined {
    const account = this.get(accountId);
    return account ? backendForProvider(account.providerId) : undefined;
  }

  /** Account views for the renderer: metadata plus live connected status. */
  async views(): Promise<AccountView[]> {
    return Promise.all(
      this.liveAccounts().map(async (account) => {
        const status = await this.status(account.id);
        // Read after the status, so the row says what stands as it is sent.
        const cutOff = this.cutOff(account.id);
        return {
          id: account.id,
          providerId: account.providerId,
          kind: account.kind,
          label: account.label,
          enabled: account.enabled,
          connected: status.connected,
          pinned: this.registry.pins[account.providerId] === account.id,
          ...(account.keepGoingOnCredits === true ? { keepGoingOnCredits: true } : {}),
          ...(account.useSavedResets === true ? { useSavedResets: true } : {}),
          createdAt: account.createdAt,
          ...(account.lastConnectedAt ? { lastConnectedAt: account.lastConnectedAt } : {}),
          ...(status.identity?.label ? { identity: status.identity.label } : {}),
          ...(status.identity?.plan ? { plan: status.identity.plan } : {}),
          ...(status.access ? { access: status.access } : {}),
          ...(status.gateway ? { gateway: status.gateway } : {}),
          ...(status.detail && isClientIssueReason(status.reason) ? { detail: status.detail } : {}),
          ...(cutOff
            ? {
                cutOff: {
                  class: cutOff.class,
                  since: cutOff.since,
                  ...(cutOff.resetsAt !== undefined ? { resetsAt: cutOff.resetsAt } : {}),
                },
              }
            : {}),
        };
      }),
    );
  }

  /**
   * Add an account: create its isolated store, then run the provider's own
   * harness login into it - the harness mints and stores the credential; we
   * never see it. A failed or cancelled login leaves nothing behind.
   */
  async add(
    providerId: string,
    type: "oauth" | "api_key",
    bridge: AuthInteractionBridge,
    options: { enterpriseHost?: string } = {},
  ): Promise<AccountRecord> {
    if (!isOfferedProvider(providerId)) {
      throw new Error("This provider is not available to connect.");
    }
    const enterpriseHost =
      options.enterpriseHost === undefined
        ? undefined
        : githubEnterpriseHost(options.enterpriseHost);
    if (options.enterpriseHost !== undefined && !enterpriseHost)
      throw new Error(CODE_STEP_WORDS.badEnterprise);
    // One Claude account stands on the login already on this computer; one
    // added beside it is a login of its own where the backend makes them.
    const furtherClaude =
      providerId === CLAUDE_PROVIDER_ID &&
      this.registry.accounts.some(
        (account) => account.providerId === CLAUDE_PROVIDER_ID && !account.ownLogin,
      );
    if (furtherClaude && !this.requireBackend(providerId).furtherLogins) {
      throw new Error(`Claude uses the login already on ${HERE.this}.`);
    }
    // Set before any await, so a second click cannot start another login
    // while this one still holds the client. The button's own busy flag
    // lives in the mounted tab and does not survive leaving it.
    const claude = providerId === CLAUDE_PROVIDER_ID;
    if (claude) {
      if (this.claudeLoginInFlight) {
        throw new Error(`A Claude sign-in is already in progress on ${HERE.this}.`);
      }
      this.claudeLoginInFlight = true;
    }
    let backend: AccountBackend | undefined;
    let id: string | undefined;
    try {
      backend = this.requireBackend(providerId);
      id = `acct_${randomBytes(4).toString("hex")}`;
      const dir = this.storeDir(providerId, id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (furtherClaude) {
        const folder = claudeLoginFolder(dir);
        mkdirSync(folder, { mode: 0o700 });
        chmodSync(folder, 0o700);
      }
      const ref: AccountRef = {
        providerId,
        accountId: id,
        dir,
        ...(furtherClaude ? { ownLogin: true } : {}),
      };
      await backend.login({
        ...ref,
        type,
        bridge,
        ...(enterpriseHost ? { enterpriseHost } : {}),
      });
      const record: AccountRecord = {
        id,
        providerId,
        kind: type === "oauth" ? "subscription_oauth" : "api_key",
        label: await this.suggestedLabel(providerId, backend, ref),
        enabled: true,
        createdAt: Date.now(),
        lastConnectedAt: Date.now(),
        ...(furtherClaude ? { ownLogin: true as const } : {}),
      };
      if (furtherClaude) this.options.furtherLoginsHeld?.(true);
      this.registry.accounts.push(record);
      this.saveRegistry();
      return { ...record };
    } catch (caught) {
      // Sweep now, and again once the backend's in-flight work settles: an
      // aborted login rejects while its runtime creation is still running,
      // and that work re-creates the store dir after a lone immediate
      // sweep - the orphan-store leak (fm3000-devmode-auth-message-s1).
      if (backend && id) {
        const accountId = id;
        const owner = backend;
        const sweep = () => {
          owner.forget?.(accountId);
          this.removeStoreDir(providerId, accountId);
        };
        sweep();
        const settled = owner.settled?.(accountId);
        if (settled) {
          const swept = settled.then(sweep, sweep);
          this.sweeping.add(swept);
          void swept.finally(() => this.sweeping.delete(swept));
        }
      }
      throw caught;
    } finally {
      if (claude) this.claudeLoginInFlight = false;
    }
  }

  /**
   * Resolves once every failed sign-in's store is gone for good: whoever
   * stops the vault's owner, and then removes its folder, waits here first.
   */
  async swept(): Promise<void> {
    while (this.sweeping.size > 0) await Promise.allSettled([...this.sweeping]);
  }

  /** Custom credentials are submitted once to their Pi-bound owner, never returned. */
  customPrepare(input: CustomApiInput) {
    return this.pi.custom.prepare(input);
  }
  customProfiles() {
    return this.pi.custom.profiles();
  }
  /** Whoever stops the vault's owner, and then removes its folder, waits here first. */
  closeCustomCatalog(): Promise<void> {
    return this.pi.custom.closeCatalog();
  }
  customAddress(baseUrl: string) {
    return this.pi.custom.address(baseUrl);
  }
  customConnect(input: CustomApiConnectInput) {
    return this.pi.custom.connect(input);
  }
  customReview(baseUrl: string, mode: CustomApiInput["mode"], pem?: string) {
    return this.pi.custom.review(baseUrl, mode, pem);
  }
  customCheck(draftId: string, modelId: string) {
    return this.pi.custom.check(draftId, modelId);
  }
  customDiscover(draftId: string) {
    return this.pi.custom.discover(draftId);
  }
  customCancel(draftId: string) {
    this.pi.custom.cancel(draftId);
  }
  customViews() {
    return this.list()
      .filter((account) => isCustomApiProvider(account.providerId))
      .map((account) => this.pi.custom.view(account.id, account.label, account.enabled));
  }
  customChecked(accountId: string, modelId?: string) {
    return this.pi.custom.checked(accountId, modelId);
  }
  customUnchecked(accountId: string) {
    return this.pi.custom.unchecked(accountId);
  }

  /**
   * A saved connection's one fresh check (`CustomApiAccountOwner.recheck`).
   * Warm-up skipped the runtime while its checks did not count, so the
   * connection that comes back fully checked gets it here, as a checked
   * replacement does, and its models are offered again.
   */
  async customRecheck(accountId: string, only?: readonly string[]) {
    const account = this.requireAccount(accountId);
    if (!isCustomApiProvider(account.providerId))
      throw new Error("Only a custom connection has saved checks.");
    const view = await this.pi.custom.recheck(accountId, only);
    if (account.enabled && this.pi.custom.checked(accountId)) await this.runtimeFor(accountId);
    return { ...view, label: account.label };
  }
  /**
   * The connection file's newest good reading, applied to each connection
   * approved from it (`CustomApiAccountOwner.applyDefinition`), whose name
   * follows the file's; null, with no file chosen, ends every hold a file
   * made. Answers the fresh checks the reading asked for, each in the background.
   */
  applyCustomFile(connections: CustomFileConnection[] | null): Promise<void>[] {
    return this.applyFollowed("file", connections);
  }

  /**
   * On a computer that runs work: what the first mate's computer last sent of
   * its connections this computer approved one from, whole, so one left out
   * is gone there. Kept for `reapplyCustomHome`; answers as `applyCustomFile`.
   */
  applyCustomHome(definitions: CustomHomeDefinition[]): Promise<void>[] {
    this.homeDefinitions = definitions;
    return this.applyFollowed("home", definitions);
  }

  /**
   * Applies what the home last sent again, such as once a connection from it
   * is saved. A connection that send does not name is left as it is: one
   * just approved from the home's may be newer than that send, and the
   * home's next send says whether it is gone.
   */
  reapplyCustomHome(): Promise<void>[] {
    return this.homeDefinitions ? this.applyFollowed("home", this.homeDefinitions, true) : [];
  }

  private applyFollowed(
    kind: "file" | "home",
    entries: readonly { name: string; definition?: CustomFileDefinition }[] | null,
    onlyNamed = false,
  ): Promise<void>[] {
    const checks: Promise<void>[] = [];
    let renamed = false;
    for (const account of this.liveAccounts()) {
      if (!isCustomApiProvider(account.providerId)) continue;
      const source = this.pi.custom.source(account.id);
      if (source?.kind !== kind) continue;
      if (entries === null) {
        this.pi.custom.releaseFile(account.id);
        continue;
      }
      const entry = entries.find((each) => each.name === source.name);
      if (onlyNamed && !entry) continue;
      const definition = entry?.definition;
      const { applied, recheck } = this.pi.custom.applyDefinition(account.id, definition);
      if (applied && definition && account.label !== definition.label) {
        account.label = definition.label;
        renamed = true;
      }
      // A check this reading cancelled, by writing a newer record, runs again too.
      if (recheck.length || this.fileChecksOwed.get(account.id)?.size)
        checks.push(this.fileCheck(account.id, recheck));
      else if (applied && account.enabled && this.pi.custom.checked(account.id))
        void this.runtimeFor(account.id).catch(() => undefined);
    }
    if (renamed) this.saveRegistry();
    return checks;
  }

  /** One connection's checks after a file edit, run one after another however often it changes. */
  private fileCheck(accountId: string, models: readonly string[]): Promise<void> {
    const owed = this.fileChecksOwed.get(accountId) ?? new Set();
    for (const model of models) owed.add(model);
    this.fileChecksOwed.set(accountId, owed);
    const next = (this.fileChecks.get(accountId) ?? Promise.resolve()).then(async () => {
      const due = [...owed];
      if (!due.length) return;
      try {
        await this.customRecheck(accountId, due);
        // A failed model stays unchecked, as its line in Settings says.
        for (const model of due) owed.delete(model);
      } catch {
        // Cancelled by a newer reading or closed: the next check takes these too.
      }
    });
    this.fileChecks.set(accountId, next);
    void next.then(() => {
      if (this.fileChecks.get(accountId) === next) this.fileChecks.delete(accountId);
    });
    return next;
  }
  customReplacement(draftId: string) {
    return this.pi.custom.draftReplacement(draftId);
  }
  customClose(accountId: string) {
    this.pi.custom.close(accountId);
  }

  async customSave(draftId: string, paused: boolean): Promise<AccountRecord> {
    const replacementId = this.pi.custom.draftReplacement(draftId);
    if (replacementId) {
      const account = this.requireAccount(replacementId);
      const release = await this.options.holdSeat?.(account.id);
      const label = this.pi.custom.draftLabel(draftId);
      try {
        await this.pi.custom.save(draftId, this.refFor(account), paused);
        account.label = label;
        this.saveRegistry();
        await this.status(account.id, { refresh: true });
        // Warm-up skipped the runtime while the models were unchecked; the
        // checked replacement is what makes them offered.
        if (account.enabled && !paused) await this.runtimeFor(account.id);
        return account;
      } finally {
        release?.();
      }
    }
    const id = `acct_${randomBytes(8).toString("hex")}`;
    const providerId = `${CUSTOM_API_PROVIDER_PREFIX}${randomBytes(8).toString("hex")}`;
    const label = this.pi.custom.draftLabel(draftId);
    const account: AccountRecord = {
      id,
      providerId,
      label,
      kind: "api_key",
      enabled: !paused,
      createdAt: Date.now(),
    };
    const ref = this.refFor(account);
    mkdirSync(ref.dir, { recursive: true, mode: 0o700 });
    chmodSync(join(this.paths.accountsDir, providerId), 0o700);
    chmodSync(ref.dir, 0o700);
    try {
      await this.pi.custom.save(draftId, ref, paused);
      this.registry.accounts.push(account);
      this.saveRegistry();
      await this.status(id, { refresh: true });
      if (!paused) await this.runtimeFor(id);
      return { ...account };
    } catch (error) {
      this.registry.accounts = this.registry.accounts.filter((entry) => entry.id !== id);
      this.saveRegistry();
      await this.pi.custom.forget(id);
      this.removeStoreDir(providerId, id);
      throw error;
    }
  }

  /**
   * Sign an EXISTING account in again, into the store it already owns: the
   * row's inline "Sign in" after the vendor rejected a credential that a
   * renewal could not fix, or after a store lost its credential. Same
   * provider flow as `add`, same bridge tagging, but the registry row, its
   * label, its pin and its siblings all stay exactly where they are - only
   * the store's contents change, and only the harness writes them. The
   * backend hears it is a sign-in again (`again`), so it runs the
   * provider's own login rather than using the refused one once more.
   */
  async signIn(accountId: string, bridge: AuthInteractionBridge): Promise<void> {
    const account = this.requireAccount(accountId);
    if (isCustomApiProvider(account.providerId))
      throw new Error("Review or replace this connection's key in Intelligence.");
    const backend = this.requireBackend(account.providerId);
    const type = account.kind === "api_key" ? "api_key" : "oauth";
    // Sign in runs the vendor's own login over the one it holds, so a
    // second press while the first is open would start a second login.
    const claude = account.providerId === CLAUDE_PROVIDER_ID;
    if (claude) {
      if (this.claudeLoginInFlight) {
        throw new Error(`A Claude sign-in is already in progress on ${HERE.this}.`);
      }
      this.claudeLoginInFlight = true;
    }
    let release: (() => void) | undefined;
    try {
      // The seat is released once the fresh read is in, so its next turn
      // reads the account as the sign-in left it.
      release = await this.options.holdSeat?.(accountId);
      await backend.login({
        ...this.refFor(account),
        type,
        bridge,
        again: true,
        ...(account.providerId === BEDROCK_PROVIDER_ID
          ? {
              onRelatedRechecked: async (siblingId: string) => {
                if (!this.get(siblingId)) return;
                if (this.cutOff(siblingId)?.class === "signed_out") this.clearCutOff(siblingId);
                await this.status(siblingId, { refresh: true });
              },
              relatedAccounts: this.liveAccounts()
                .filter(
                  (entry) => entry.id !== accountId && entry.providerId === account.providerId,
                )
                .map((entry) => this.refFor(entry)),
            }
          : {}),
      });
      account.lastConnectedAt = Date.now();
      this.registry.accounts = this.registry.accounts.map((entry) =>
        entry.id === accountId ? { ...entry, lastConnectedAt: account.lastConnectedAt } : entry,
      );
      this.saveRegistry();
      // A sign-out waiting on a new write time may not see one: a store the
      // app cannot read now has none to compare. The captain's Sign in is
      // itself the way back. A refusal is not.
      if (this.cutOff(accountId)?.class === "signed_out") this.clearCutOff(accountId);
      // The next read must see the fresh credential, not the cached rejection.
      await this.status(accountId, { refresh: true });
    } finally {
      release?.();
      if (claude) this.claudeLoginInFlight = false;
    }
  }

  /**
   * Remove an account: best-effort harness logout (upstream revocation),
   * then delete the store directory. Sibling accounts are untouchable by
   * construction - each lives in its own directory. Resolves with what the
   * logout did to a login the vendor's client keeps for the whole macOS user,
   * when the backend says.
   */
  async remove(accountId: string): Promise<LogoutOutcome | undefined> {
    const account = this.requireAccount(accountId);
    const backend = this.requireBackend(account.providerId);
    const release = await this.options.holdSeat?.(accountId);
    let outcome: LogoutOutcome | undefined;
    try {
      outcome = await backend.logout(this.refFor(account));
    } catch {
      // Logout is best-effort; deletion is the guarantee.
    } finally {
      release?.();
    }
    const codexHome = this.codexHomeDir(account.providerId, accountId);
    if (this.options.signOutCodex && existsSync(codexHome))
      await this.options.signOutCodex(codexHome).catch(() => undefined);
    backend.forget?.(accountId);
    this.lastStatus.delete(accountId);
    this.statusReadAt.delete(accountId);
    this.lastHealth.delete(accountId);
    this.healthReadAt.delete(accountId);
    this.removeStoreDir(account.providerId, accountId);
    this.registry.accounts = this.registry.accounts.filter((entry) => entry.id !== accountId);
    if (this.registry.pins[account.providerId] === accountId) {
      delete this.registry.pins[account.providerId];
    }
    this.saveRegistry();
    this.options.furtherLoginsHeld?.(this.registry.accounts.some((entry) => entry.ownLogin));
    return outcome;
  }

  /**
   * Synchronous connected check from the last status read, for
   * selection-time candidate building. undefined = not yet checked (the
   * account stays eligible; uncertainty is not ineligibility).
   */
  connectedSync(accountId: string): boolean | undefined {
    if (!this.get(accountId)) return false;
    return this.lastStatus.get(accountId)?.connected;
  }

  /**
   * Whether the account serves models, from the last status read: the one
   * serveability predicate (`servesModels`) the routing pool, the flagship
   * and crew delivery read. undefined = not yet checked, which stays
   * eligible where eligibility is asked.
   */
  servesSync(accountId: string): boolean | undefined {
    const account = this.get(accountId);
    if (!account) return false;
    if (isCustomApiProvider(account.providerId))
      return account.enabled && this.pi.custom.checked(accountId);
    const status = this.lastStatus.get(accountId);
    if (status) return servesModels(status);
    // Nothing read yet (a restart): the durable fact still withholds.
    return this.withholdingReason(accountId) ? false : undefined;
  }

  /**
   * Why a connected account serves nothing right now, as its health reason
   * (`client_missing`, `refused`, ...), for the ledger row that skips it.
   * Before the first read, a standing cut-off's own reason.
   */
  withheldReason(accountId: string): string | undefined {
    const status = this.lastStatus.get(accountId);
    if (!status) return this.withholdingReason(accountId);
    return status.connected && isWithheldReason(status.reason) ? status.reason : undefined;
  }

  /**
   * The one sentence a missing or outdated client carries (F14), when that
   * is what withholds the account: what the person can do about it.
   */
  withheldDetail(accountId: string): string | undefined {
    const status = this.lastStatus.get(accountId);
    return status?.connected && isClientIssueReason(status.reason) ? status.detail : undefined;
  }

  /**
   * Record a typed cut-off a session observed on this account (crew
   * transport, the seat): a durable fact that survives a restart and clears
   * only when a fact changes (`AccountCutOff`). `signed_out` and `refused`
   * withhold the account at once - it stays connected, since only proof
   * shows "sign in again" (docs/quota.md), but it serves no model. A spent
   * allowance withholds nothing here: the quota reading carries it until
   * its reset. One with no known reset, or a reset already past, has
   * nothing to clear it and is not held.
   */
  noteCutOff(accountId: string, cutOff: CutOff, seen?: { leftPercent?: number }): void {
    const account = this.registry.accounts.find((entry) => entry.id === accountId);
    if (!account || !this.get(accountId)) return;
    const now = this.now();
    // The provider refused the allowance again, with or without a reset:
    // what the captain tried is answered.
    if (cutOff.class === "no_headroom" && account.goesByAnswers) {
      delete account.goesByAnswers;
      this.saveRegistry();
    }
    if (
      cutOff.class === "no_headroom" &&
      (cutOff.resetsAt === undefined || cutOff.resetsAt <= now)
    ) {
      return;
    }
    // A cut-off with a looser way back never replaces a stricter one that
    // stands: a refusal outlives a later lost sign-in or spent allowance
    // (a turn already in flight settling after it), or a clock or a routine
    // rewrite would clear it.
    const standing = this.cutOff(accountId);
    if (standing && CUT_OFF_RANK[cutOff.class] < CUT_OFF_RANK[standing.class]) return;
    // The same cut-off seen again is the fact that already stands; only a
    // spent allowance learns its reset.
    if (standing?.class === cutOff.class) {
      if (
        account.cutOff &&
        cutOff.resetsAt !== undefined &&
        cutOff.resetsAt !== standing.resetsAt
      ) {
        account.cutOff = { ...account.cutOff, resetsAt: cutOff.resetsAt };
        this.saveRegistry();
        this.cutOffChanged(accountId); // The return moved: whoever waits on it waits anew.
      }
      return;
    }
    // The stamp is left for the next read to adopt: the last one may predate
    // a renewal, and a stale stamp would clear the fact on the next read.
    account.cutOff = {
      class: cutOff.class,
      since: now,
      ...(cutOff.class === "no_headroom" && cutOff.resetsAt !== undefined
        ? { resetsAt: cutOff.resetsAt }
        : {}),
      ...(cutOff.class === "no_headroom" && seen?.leftPercent !== undefined
        ? { leftPercent: seen.leftPercent }
        : {}),
      stamp: {},
    };
    this.saveRegistry();
    this.reproject(accountId);
    this.cutOffChanged(accountId);
    void this.health(accountId, { refresh: true }).catch(() => undefined);
  }

  /**
   * Hear every cut-off recorded or cleared, on any account, once the fact
   * is saved and after the caller's own work: crew delivery re-reads
   * serveability at once rather than at the next tick. Returns the
   * unsubscription.
   */
  onCutOffChange(listener: (accountId: string) => void): () => void {
    this.cutOffListeners.add(listener);
    return () => this.cutOffListeners.delete(listener);
  }

  /**
   * Hear an account's store name a different login than it last did (a
   * person switched the machine's Claude login, say): every reading taken
   * under the old login is no longer this account's. Returns the
   * unsubscription.
   */
  onLoginChange(listener: (accountId: string) => void): () => void {
    this.loginListeners.add(listener);
    return () => this.loginListeners.delete(listener);
  }

  /** The login the account's store last named, when its backend can say. */
  loginSync(accountId: string): string | undefined {
    return this.registry.accounts.find((entry) => entry.id === accountId)?.login;
  }

  /**
   * Where a Claude account's access comes from when it is not a
   * subscription, as its backend last said (`CredentialHealth.access`).
   */
  accessSync(accountId: string): ClaudeAccessSource | undefined {
    return this.lastStatus.get(accountId)?.access;
  }

  /** Who the account's own client last said is signed in (an email), when it says. */
  identitySync(accountId: string): string | undefined {
    return this.lastStatus.get(accountId)?.identity?.label;
  }

  /**
   * A fresh credential read (health or allowance) names the current store.
   * No token crosses this seam. Refusal facts keep their persisted stamps;
   * Claude's row follows the current identity, not the old saved label:
   * on access set up for Claude Code that identity is the access, never
   * the subscription's email it carried before.
   */
  noteCredentialRead(
    accountId: string,
    stamp: CredentialStamp | undefined,
    identity?: { label?: string },
    access?: ClaudeAccessSource,
  ): void {
    this.settleCutOff(accountId, stamp);
    if (this.noteLogin(accountId, stamp?.login)) {
      this.healthReadAt.delete(accountId);
      this.statusReadAt.delete(accountId);
    }
    const account = this.registry.accounts.find((entry) => entry.id === accountId);
    const current = access ? CLAUDE_ACCESS_ACCOUNT_LABEL : identity?.label;
    if (account?.providerId === CLAUDE_PROVIDER_ID && current && account.label !== current) {
      account.label = current;
      this.saveRegistry();
      this.healthReadAt.delete(accountId);
      this.statusReadAt.delete(accountId);
    }
  }

  cutOff(accountId: string): AccountCutOff | undefined {
    const account = this.registry.accounts.find((entry) => entry.id === accountId);
    const standing = account?.cutOff;
    if (!account || !standing) return undefined;
    if (standing.class === "no_headroom" && (standing.resetsAt ?? 0) <= this.now()) {
      this.clearCutOff(accountId);
      return undefined;
    }
    return { ...standing, stamp: { ...standing.stamp } };
  }

  /**
   * A fresh allowance reading showed this much left. A spent allowance that
   * was observed against a lower reading ends: credits were added, or the
   * vendor reset the allowance, before the reset it named. A reading lower
   * than the one observed, or the first one for a hold observed before any,
   * is the sensor catching up with the refusal, so the hold keeps it.
   * Answers whether a hold ended.
   */
  noteReading(accountId: string, leftPercent: number): boolean {
    const standing = this.cutOff(accountId);
    if (standing?.class !== "no_headroom") return false;
    if (standing.leftPercent === undefined || leftPercent < standing.leftPercent) {
      const account = this.registry.accounts.find((entry) => entry.id === accountId);
      if (account?.cutOff) {
        account.cutOff = { ...account.cutOff, leftPercent };
        this.saveRegistry();
      }
      return false;
    }
    if (leftPercent === standing.leftPercent) return false;
    this.clearCutOff(accountId);
    return true;
  }

  /**
   * The provider accepted this account's login again: a good allowance
   * reading, or a turn that succeeded on it. A sign-out was waiting on a
   * rewrite a still-live login never makes, so this is what lets work resume.
   * A refusal is not a credential problem and stays. Answers whether a
   * sign-out stood.
   */
  noteAccepted(accountId: string): boolean {
    if (this.cutOff(accountId)?.class !== "signed_out") return false;
    this.clearCutOff(accountId);
    return true;
  }

  /**
   * The captain's "Try Claude again": a refusal clears on their word, and
   * the next turn is the attempt. Answers whether a refusal stood.
   */
  tryAgain(accountId: string): boolean {
    if (this.cutOff(accountId)?.class !== "refused") return false;
    this.clearCutOff(accountId);
    return true;
  }

  /**
   * The captain's Try again on a spent allowance a recheck saw unchanged:
   * the hold ends on their word, the account goes by its provider's
   * answers rather than its reading (`goesByAnswers`), and the next turn is
   * the attempt. A refusal of it is held again, as any other.
   */
  tryPastSpent(accountId: string): void {
    const account = this.registry.accounts.find((entry) => entry.id === accountId);
    if (!account || !this.get(accountId)) return;
    if (!account.goesByAnswers) {
      account.goesByAnswers = true;
      this.saveRegistry();
    }
    if (this.cutOff(accountId)?.class === "no_headroom") this.clearCutOff(accountId);
  }

  /** Whether the account goes by its provider's answers past its reading (`tryPastSpent`). */
  goesByAnswers(accountId: string): boolean {
    return this.registry.accounts.find((entry) => entry.id === accountId)?.goesByAnswers === true;
  }

  /**
   * A status read, cached briefly and single-flighted. The Subscriptions tab
   * polls while it is open and a spawned-client backend answers by starting
   * a process, so an uncached read would mean one process per account every
   * few seconds. `refresh` forces one where the answer must be current -
   * right after a login, or on the liveness sweep.
   *
   * Projection of `health()` (spec §11.2.5): a throw or unreadable store
   * is never `{ connected: false }`.
   */
  async status(accountId: string, options: { refresh?: boolean } = {}): Promise<AccountStatus> {
    return statusFromHealth(await this.health(accountId, options));
  }

  /**
   * Credential health for this account: the source `status()` projects.
   * A backend throw keeps last-known-good (or degrades); it never becomes
   * a fabricated sign-out.
   */
  async health(accountId: string, options: { refresh?: boolean } = {}): Promise<CredentialHealth> {
    const account = this.requireAccount(accountId);
    const readAt = this.healthReadAt.get(accountId);
    const cached = this.lastHealth.get(accountId);
    if (!options.refresh && cached && readAt !== undefined && Date.now() - readAt < STATUS_TTL_MS) {
      return this.withCutOff(accountId, cached);
    }
    const inFlight = this.healthInFlight.get(accountId);
    if (inFlight) return inFlight;
    const pending = (async () => {
      // However this read ends - a failed registry write included - it
      // leaves the flight, so the next read asks again instead of
      // re-answering this one's failure until restart.
      try {
        let health: CredentialHealth;
        let read = false;
        try {
          health = await this.requireBackend(account.providerId).health(this.refFor(account));
          read = true;
        } catch {
          health = this.lastHealth.get(accountId) ?? { state: "degraded", reason: "unknown" };
        }
        // A fresh read is where a changed login or client clears a cut-off.
        if (read) {
          this.noteCredentialRead(accountId, health.stamp, health.identity, health.access);
        }
        this.lastHealth.set(accountId, health);
        const reported = this.withCutOff(accountId, health);
        this.lastStatus.set(accountId, statusFromHealth(reported));
        this.healthReadAt.set(accountId, Date.now());
        this.statusReadAt.set(accountId, Date.now());
        return reported;
      } finally {
        this.healthInFlight.delete(accountId);
        this.statusInFlight.delete(accountId);
      }
    })();
    this.healthInFlight.set(accountId, pending);
    return pending;
  }

  /**
   * Ask this account's own credential owner to renew. Claude delegates to
   * its client; Pi's `getAuth` is the renewal. Never a secret.
   */
  async renew(accountId: string, reason: RenewReason): Promise<RenewalOutcome> {
    const account = this.requireAccount(accountId);
    // A refusal is not a credential problem: renewing cannot fix it, and
    // asking again is retrying into the wall. Nothing renews it, ever.
    if (this.cutOff(accountId)?.class === "refused") return { outcome: "withheld" };
    const outcome = await this.requireBackend(account.providerId).renew(
      this.refFor(account),
      reason,
    );
    if (outcome.outcome === "renewed") {
      this.healthReadAt.delete(accountId);
      this.statusReadAt.delete(accountId);
    }
    return outcome;
  }

  /**
   * The injection binding for a spawn/attach. Locations only - never a
   * secret, and never a sibling account's path.
   */
  binding(accountId: string): AccountBinding {
    const account = this.requireAccount(accountId);
    return this.requireBackend(account.providerId).binding(this.refFor(account));
  }

  /** A further Claude login's own Claude Code folder; nothing for any other account. */
  claudeConfigDir(accountId: string): string | undefined {
    const account = this.get(accountId);
    if (!account?.ownLogin) return undefined;
    return claudeLoginFolder(this.storeDir(account.providerId, account.id));
  }

  /** The account's own ModelRuntime (cached): the in-process Pi injection. */
  runtimeFor(accountId: string): Promise<ModelRuntime> {
    const account = this.requireAccount(accountId);
    if (backendForProvider(account.providerId) !== "pi") {
      throw new Error(`Account "${accountId}" does not run on Pi.`);
    }
    return this.pi.runtimeFor(this.refFor(account));
  }

  /**
   * Request auth for the quota sensor, resolved through the account's own
   * runtime (Pi refreshes OAuth inside getAuth, locked, and persists the
   * rotated credential into the account's store). Pi accounts only: Claude
   * never hands Infinitary a credential through this method.
   */
  async resolveForQuota(accountId: string): Promise<ResolvedProviderAuth | undefined> {
    const account = this.get(accountId);
    if (
      !account ||
      isCustomApiProvider(account.providerId) ||
      backendForProvider(account.providerId) !== "pi"
    )
      return undefined;
    // Copilot's allowance is read with the GitHub sign-in itself, not the
    // Copilot token Pi resolves for requests (copilotMeter.ts).
    if (account.providerId === COPILOT_PROVIDER_ID) {
      return copilotMeterAuth(authPathIn(this.storeDir(account.providerId, accountId)));
    }
    try {
      const runtime = await this.runtimeFor(accountId);
      const result = await runtime.getAuth(account.providerId);
      if (!result) return undefined;
      this.lapsedRefresh.delete(accountId);
      enforceAuthFileMode(this.storeDir(account.providerId, accountId));
      const headers = result.auth.headers
        ? Object.fromEntries(
            Object.entries(result.auth.headers).flatMap(([key, value]) =>
              typeof value === "string" ? [[key, value] as const] : [],
            ),
          )
        : undefined;
      return {
        ...(typeof result.auth.apiKey === "string" ? { apiKey: result.auth.apiKey } : {}),
        ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
        ...(typeof result.auth.baseUrl === "string" ? { baseUrl: result.auth.baseUrl } : {}),
        usingOAuth: runtime.isUsingOAuth(account.providerId),
      };
    } catch (caught) {
      // Only the provider refusing the refresh token is proof; any other
      // failure leaves what the last read established.
      if (
        caught instanceof Error &&
        isLapsedRefresh((caught as { code?: unknown }).code, caught.message)
      )
        this.lapsedRefresh.add(accountId);
      return undefined;
    }
  }

  /**
   * Whether this Pi account's last credential read was refused at its
   * refresh token: the lapsed-sign-in proof, until a read succeeds again.
   */
  refreshLapsed(accountId: string): boolean {
    return this.lapsedRefresh.has(accountId);
  }

  /**
   * Models the account pool can serve right now: the union over enabled
   * accounts' availability snapshots (deduplicated). Pi accounts report
   * theirs from their own runtime; a Claude account reports the models
   * its subscription serves.
   */
  availableModels(): { provider: string; id: string }[] {
    const seen = new Set<string>();
    const models: { provider: string; id: string }[] = [];
    for (const account of this.availableModelsByAccount()) {
      for (const model of account.models) {
        const key = `${model.provider}/${model.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        models.push(model);
      }
    }
    return models;
  }

  /**
   * Whether the pool above is read: every enabled account has said what it
   * serves - a Pi runtime that settled, another client's status - so an
   * empty pool is known empty, not yet unread.
   */
  poolRead(): boolean {
    return this.liveAccounts().every(
      (account) =>
        !account.enabled ||
        (backendForProvider(account.providerId) === "pi"
          ? this.pi.settledRuntime(account.id) !== undefined
          : this.lastStatus.has(account.id)),
    );
  }

  /**
   * The same pool, still attributed to the account that serves it. The union
   * above loses that. Slots are keyed by offering (provider/model), not
   * account; this attributed form is how Settings lists who can serve a
   * model and how seeding sees the live pool.
   */
  availableModelsByAccount(): {
    accountId: string;
    accountLabel: string;
    providerId: string;
    /** `name` is the catalog's display name, where the runtime has one. */
    models: {
      provider: string;
      id: string;
      name?: string;
      reasoningCapabilities?: ReasoningCapabilities;
    }[];
  }[] {
    const rows: {
      accountId: string;
      accountLabel: string;
      providerId: string;
      models: {
        provider: string;
        id: string;
        name?: string;
        reasoningCapabilities?: ReasoningCapabilities;
      }[];
    }[] = [];
    for (const account of this.liveAccounts()) {
      if (!account.enabled) continue;
      if (account.providerId === BEDROCK_PROVIDER_ID && this.withheldReason(account.id)) continue;
      const models: {
        provider: string;
        id: string;
        name?: string;
        reasoningCapabilities?: ReasoningCapabilities;
      }[] = [];
      if (backendForProvider(account.providerId) !== "pi") {
        // A connected credential still serves nothing when the machine has
        // no client to run it (F14), or while a cut-off stands on it: the
        // account stays, its models do not.
        const status = this.lastStatus.get(account.id);
        if (!status || !servesModels(status)) continue;
        models.push(
          ...(this.options.modelsForAccount?.({
            accountId: account.id,
            providerId: account.providerId,
          }) ?? []),
        );
      } else {
        const runtime = this.pi.settledRuntime(account.id);
        if (!runtime) continue;
        const filter = this.options.piModelFilter?.(account.id);
        const defOf = modelLookup(runtime);
        for (const model of runtime.getAvailableSnapshot()) {
          if (model.provider === "anthropic" || isRetiredProvider(model.provider)) continue;
          if (
            isCustomApiProvider(account.providerId) &&
            (model.provider !== account.providerId || !this.pi.custom.checked(account.id, model.id))
          )
            continue;
          // The account's own list narrows only its own provider's models;
          // a models.json provider every runtime reads is the user's list.
          if (filter && model.provider === account.providerId && !filter.has(model.id)) continue;
          models.push({
            provider: model.provider,
            id: model.id,
            name: model.name,
            reasoningCapabilities: piReasoningCapabilities(defOf(model.provider, model.id)),
          });
        }
      }
      rows.push({
        accountId: account.id,
        accountLabel: account.label,
        providerId: account.providerId,
        models,
      });
    }
    return rows;
  }

  /**
   * The models an account withheld by a fact beside its credential would
   * serve (`withheldReason`: a standing sign-out or refusal, no client to
   * run it), each with that reason. They never join the pool above; routing
   * reads them only to say why a task was served from a lower level than it
   * asked for (docs/routing.md, "Serveability").
   */
  withheldModels(): { provider: string; id: string; reason: string }[] {
    const models: { provider: string; id: string; reason: string }[] = [];
    for (const account of this.liveAccounts()) {
      if (!account.enabled || backendForProvider(account.providerId) === "pi") continue;
      const reason = this.withheldReason(account.id);
      if (!reason) continue;
      const served =
        this.options.modelsForAccount?.({
          accountId: account.id,
          providerId: account.providerId,
        }) ?? [];
      for (const model of served) models.push({ provider: model.provider, id: model.id, reason });
    }
    return models;
  }

  /**
   * What a Pi account's runtime serves of its own provider, before any
   * account-list filter: the ids the filter's safety rail checks an answer
   * against. Undefined while the runtime is still being created.
   */
  piCatalogIds(accountId: string): string[] | undefined {
    const account = this.get(accountId);
    if (!account || backendForProvider(account.providerId) !== "pi") return undefined;
    const runtime = this.pi.settledRuntime(accountId);
    if (!runtime) return undefined;
    return runtime
      .getAvailableSnapshot()
      .filter((model) => model.provider === account.providerId)
      .map((model) => model.id);
  }

  /**
   * The settled runtimes of enabled Pi accounts. The live pi.dev catalog
   * overlay lands per account (Pi only fetches it for a provider it holds a
   * credential for), so the provider-wide catalog is assembled from these
   * alongside the base runtime - see PiAuthService.catalogModels.
   */
  piModelRuntimes(): ModelRuntime[] {
    const runtimes: ModelRuntime[] = [];
    for (const account of this.liveAccounts()) {
      if (!account.enabled) continue;
      if (backendForProvider(account.providerId) !== "pi") continue;
      const runtime = this.pi.settledRuntime(account.id);
      if (runtime) runtimes.push(runtime);
    }
    return runtimes;
  }

  rename(accountId: string, label: string): void {
    const trimmed = label.trim();
    if (!trimmed) throw new Error("An account label cannot be empty.");
    const account = this.requireRegistryAccount(accountId);
    account.label = cutText(trimmed, 64);
    this.saveRegistry();
  }

  setEnabled(accountId: string, enabled: boolean): void {
    const account = this.requireRegistryAccount(accountId);
    if (isCustomApiProvider(account.providerId)) this.pi.custom.setEnabled(accountId, enabled);
    account.enabled = enabled;
    if (enabled && isCustomApiProvider(account.providerId))
      void this.runtimeFor(accountId).catch(() => undefined);
    this.saveRegistry();
  }

  /**
   * Keep going on credits, on or off (docs/quota.md): only an account whose
   * provider offers the switch (`CREDITS_SWITCH_PROVIDERS`) takes it.
   */
  setKeepGoingOnCredits(accountId: string, on: boolean): void {
    const account = this.requireRegistryAccount(accountId);
    const quotaId = allowanceProviderOf(account.providerId);
    if (on && (!quotaId || !CREDITS_SWITCH_PROVIDERS.includes(quotaId))) {
      throw new Error("This account cannot keep going on credits.");
    }
    if (on) account.keepGoingOnCredits = true;
    else delete account.keepGoingOnCredits;
    this.saveRegistry();
  }

  /**
   * Use saved resets on their own, on or off (docs/quota.md "Saved resets
   * on their own"): only a Codex account takes it.
   */
  setUseSavedResets(accountId: string, on: boolean): void {
    const account = this.requireRegistryAccount(accountId);
    if (on && allowanceProviderOf(account.providerId) !== "codex") {
      throw new Error("Only a Codex account can use saved resets on its own.");
    }
    if (on) account.useSavedResets = true;
    else delete account.useSavedResets;
    this.saveRegistry();
  }

  /** Whether the account's Use saved resets on their own switch is on. */
  usesSavedResets(accountId: string): boolean {
    return this.get(accountId)?.useSavedResets === true;
  }

  /**
   * The account's own Codex home (docs/codex-client.md): a folder in its
   * store, created private on first use, where the Codex CLI keeps its own
   * sign-in for this account. Removing the account removes it.
   */
  codexHome(accountId: string): string {
    const account = this.requireRegistryAccount(accountId);
    const dir = this.codexHomeDir(account.providerId, accountId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    return dir;
  }

  codexSignedIn(accountId: string): boolean {
    const account = this.get(accountId);
    return account
      ? existsSync(join(this.codexHomeDir(account.providerId, accountId), "auth.json"))
      : false;
  }

  /** The saved-reset attempt Codex has not answered clearly yet, if any. */
  savedResetAttempt(accountId: string): { key: string; creditId?: string } | undefined {
    const attempt = this.get(accountId)?.savedResetAttempt;
    return attempt ? { ...attempt } : undefined;
  }

  setSavedResetAttempt(
    accountId: string,
    attempt: { key: string; creditId?: string } | undefined,
  ): void {
    const account = this.requireRegistryAccount(accountId);
    if (attempt) account.savedResetAttempt = { ...attempt };
    else delete account.savedResetAttempt;
    this.saveRegistry();
  }

  keepsGoingOnCredits(accountId: string): boolean {
    return this.get(accountId)?.keepGoingOnCredits === true;
  }

  /**
   * Whether the switch lets the account serve past its allowance now: it is
   * on, and no refusal the provider gave is held as a spent allowance - a
   * refusal with the switch on is credits not answering, until a top-up
   * (`noteCreditsAvailable`) or the reset ends the hold.
   */
  servesOnCredits(accountId: string): boolean {
    return this.keepsGoingOnCredits(accountId) && this.cutOff(accountId)?.class !== "no_headroom";
  }

  /**
   * Credits answer again on an account that keeps going on them (a top-up,
   * say): a spent allowance held after a real refusal ends now, before its
   * reset. Answers whether a hold ended.
   */
  noteCreditsAvailable(accountId: string): boolean {
    if (!this.keepsGoingOnCredits(accountId)) return false;
    if (this.cutOff(accountId)?.class !== "no_headroom") return false;
    this.clearCutOff(accountId);
    return true;
  }

  /** Pin one account per provider (the selection override); null clears. */
  setPin(providerId: string, accountId: string | null): void {
    if (accountId === null) {
      delete this.registry.pins[providerId];
    } else {
      const account = this.requireAccount(accountId);
      if (account.providerId !== providerId) {
        throw new Error("The pinned account must belong to the provider.");
      }
      this.registry.pins[providerId] = accountId;
    }
    this.saveRegistry();
  }

  /** Selection bookkeeping: the round-robin cursor among unknown quota. */
  markSelected(accountId: string): void {
    const account = this.registry.accounts.find((entry) => entry.id === accountId);
    if (!account) return;
    account.lastSelectedAt = Date.now();
    this.saveRegistry();
  }

  /**
   * The low-frequency liveness sweep (app start + daily): a harness-owned
   * auth status read per enabled account. For Pi, getAuth makes it
   * self-refresh OAuth that is close to lapsing; for every backend, a store
   * that lost its credential surfaces as stale so a Reconnect card can
   * appear before a spawn hits it.
   */
  async sweepLiveness(): Promise<{ accountId: string; providerId: string; label: string }[]> {
    const stale: { accountId: string; providerId: string; label: string }[] = [];
    for (const account of this.liveAccounts()) {
      if (!account.enabled) continue;
      const alive =
        backendForProvider(account.providerId) === "pi"
          ? Boolean(await this.resolveForQuota(account.id))
          : (await this.status(account.id, { refresh: true })).connected;
      if (!alive) {
        stale.push({ accountId: account.id, providerId: account.providerId, label: account.label });
      }
    }
    return stale;
  }

  /**
   * Clear a cut-off a fresh read shows a changed fact for, and adopt the
   * stamp parts its note could not see.
   */
  private settleCutOff(accountId: string, stamp: CredentialStamp | undefined): void {
    const account = this.registry.accounts.find((entry) => entry.id === accountId);
    const standing = this.cutOff(accountId);
    if (!account?.cutOff || !standing) return;
    const seen = stamp ?? {};
    const changed = (part: keyof CredentialStamp) =>
      standing.stamp[part] !== undefined &&
      seen[part] !== undefined &&
      seen[part] !== standing.stamp[part];
    const cleared =
      (standing.class === "no_headroom" && changed("login")) ||
      (standing.class === "signed_out" && (changed("login") || changed("written"))) ||
      (standing.class === "refused" && (changed("login") || changed("client")));
    if (cleared) {
      this.clearCutOff(accountId);
      return;
    }
    const adopted = { ...seen, ...standing.stamp };
    if ((Object.keys(adopted) as (keyof CredentialStamp)[]).some((part) => !standing.stamp[part])) {
      account.cutOff = { ...account.cutOff, stamp: adopted };
      this.saveRegistry();
    }
  }

  /**
   * Keep the login a fresh read saw. The first one seen is adopted; an
   * unreadable one is no change. A different one is a changed login: what
   * stood on the old login (any cut-off) ends, and every listener hears it.
   * Answers whether the login changed.
   */
  private noteLogin(accountId: string, login: string | undefined): boolean {
    const account = this.registry.accounts.find((entry) => entry.id === accountId);
    if (!account || login === undefined || account.login === login) return false;
    const changed = account.login !== undefined;
    account.login = login;
    // The new login's reading is its own: nothing tried on the old one stands.
    if (changed) delete account.goesByAnswers;
    this.saveRegistry();
    if (!changed) return false;
    this.clearCutOff(accountId);
    for (const listener of this.loginListeners) queueMicrotask(() => listener(accountId));
    return true;
  }

  private clearCutOff(accountId: string): void {
    const account = this.registry.accounts.find((entry) => entry.id === accountId);
    if (!account?.cutOff) return;
    delete account.cutOff;
    this.saveRegistry();
    this.reproject(accountId);
    this.cutOffChanged(accountId);
  }

  private cutOffChanged(accountId: string): void {
    for (const listener of this.cutOffListeners) queueMicrotask(() => listener(accountId));
  }

  private withholdingReason(accountId: string): string | undefined {
    const standing = this.cutOff(accountId);
    if (standing?.class === "refused") return CUT_OFF_REFUSED;
    if (standing?.class === "signed_out") return CUT_OFF_SIGNED_OUT;
    return undefined;
  }

  /** Re-derive the synchronous status from the last read after a cut-off moved. */
  private reproject(accountId: string): void {
    const raw = this.lastHealth.get(accountId);
    if (raw) this.lastStatus.set(accountId, statusFromHealth(this.withCutOff(accountId, raw)));
  }

  /**
   * The backend's health with a withholding cut-off laid over it. Proof of
   * a sign-out still reads as one, and a missing client keeps its own
   * sentence: both already withhold, and each says more than the cut-off.
   */
  private withCutOff(accountId: string, health: CredentialHealth): CredentialHealth {
    const standing = this.cutOff(accountId);
    if (!standing || standing.class === "no_headroom") return health;
    if (health.state === "unsigned" || health.state === "needs_reauth") return health;
    if (isClientIssueReason(health.reason)) return health;
    const { detail: _detail, ...rest } = health;
    return {
      ...rest,
      state: "degraded",
      reason: standing.class === "refused" ? CUT_OFF_REFUSED : CUT_OFF_SIGNED_OUT,
    };
  }

  /** Registry rows for providers this build still offers. Retired rows stay on disk. */
  private liveAccounts(): AccountRecord[] {
    return this.registry.accounts.filter((account) => !isRetiredProvider(account.providerId));
  }

  private requireBackend(providerId: string): AccountBackend {
    const backend = this.backends.get(backendForProvider(providerId));
    if (!backend) throw new Error("This provider is not available to connect.");
    return backend;
  }

  private refFor(account: AccountRecord): AccountRef {
    return {
      providerId: account.providerId,
      accountId: account.id,
      dir: this.storeDir(account.providerId, account.id),
      ...(account.ownLogin ? { ownLogin: true } : {}),
    };
  }

  private codexHomeDir(providerId: string, accountId: string): string {
    return join(this.storeDir(providerId, accountId), "codex");
  }

  private storeDir(providerId: string, accountId: string): string {
    return join(this.paths.accountsDir, providerId, accountId);
  }

  private removeStoreDir(providerId: string, accountId: string): void {
    rmSync(this.storeDir(providerId, accountId), { recursive: true, force: true });
    try {
      rmdirSync(join(this.paths.accountsDir, providerId));
    } catch {
      // Non-empty (sibling accounts remain) or already gone - both fine.
    }
  }

  /**
   * The starting label. Where the harness reports an identity we suggest it
   * (a Claude account arrives knowing its own email); where it does not,
   * the label is positional and the user is invited to rename.
   */
  private async suggestedLabel(
    providerId: string,
    backend: AccountBackend,
    ref: AccountRef,
  ): Promise<string> {
    const identity = await backend
      .health(ref)
      .then((health) => {
        // The login just changed this store, so seed the cache from the read
        // rather than leaving the first poll to discover it.
        this.lastHealth.set(ref.accountId, health);
        this.lastStatus.set(ref.accountId, statusFromHealth(health));
        this.healthReadAt.set(ref.accountId, Date.now());
        this.statusReadAt.set(ref.accountId, Date.now());
        // Claude on access set up for Claude Code is named for the access.
        return health.access ? CLAUDE_ACCESS_ACCOUNT_LABEL : health.identity?.label;
      })
      .catch(() => undefined);
    if (identity) return cutText(identity, 64);
    const siblings = this.registry.accounts.filter(
      (account) => account.providerId === providerId,
    ).length;
    return siblings === 0 ? "Personal" : `Account #${siblings + 1}`;
  }

  private requireAccount(accountId: string): AccountRecord {
    const account = this.get(accountId);
    if (!account) throw new Error(`Unknown account "${accountId}".`);
    return account;
  }

  private requireRegistryAccount(accountId: string): AccountRecord {
    const account = this.registry.accounts.find((entry) => entry.id === accountId);
    if (!account) throw new Error(`Unknown account "${accountId}".`);
    return account;
  }

  private registryPath(): string {
    return join(this.paths.accountsDir, "registry.json");
  }

  /**
   * Whether an account may be saved here: one is, or the registry file is
   * there but could not be read, so it is never read as having none.
   */
  mayHoldAccounts(): boolean {
    return this.registryUnread || this.liveAccounts().length > 0;
  }

  private loadRegistry(): Registry {
    this.registryUnread = false;
    try {
      const raw = JSON.parse(readFileSync(this.registryPath(), "utf8")) as Partial<Registry>;
      if (raw && typeof raw === "object" && Array.isArray(raw.accounts)) {
        return {
          version: REGISTRY_VERSION,
          accounts: raw.accounts.map(withReadableCutOff),
          pins: raw.pins && typeof raw.pins === "object" ? raw.pins : {},
        };
      }
    } catch (error) {
      // Missing or unreadable: start empty (never crash on leftovers), but
      // note a file that is there, so it is never read as no accounts.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.registryUnread = true;
      return { version: REGISTRY_VERSION, accounts: [], pins: {} };
    }
    this.registryUnread = true;
    return { version: REGISTRY_VERSION, accounts: [], pins: {} };
  }

  private saveRegistry(): void {
    this.registryUnread = false;
    writeFileSync(this.registryPath(), `${JSON.stringify(this.registry, null, 2)}\n`, {
      mode: 0o600,
    });
    chmodSync(this.registryPath(), 0o600);
  }
}

/**
 * How strict each cut-off's way back is: a refusal clears only on the
 * captain's word or a changed login or client, a lost sign-in also on a
 * rewritten store, a spent allowance at a time. A looser one never replaces
 * a stricter one that stands.
 */
const CUT_OFF_RANK: Record<CutOffClass, number> = { no_headroom: 0, signed_out: 1, refused: 2 };

/**
 * A row as read from disk, its cut-off kept only in a shape this build
 * knows. A row from before the field has none, which is no cut-off.
 */
function withReadableCutOff(account: AccountRecord): AccountRecord {
  const { cutOff, ...rest } = account;
  if (cutOff === undefined) return account;
  const known =
    cutOff !== null &&
    typeof cutOff === "object" &&
    CUT_OFF_CLASSES.includes(cutOff.class) &&
    typeof cutOff.since === "number" &&
    (cutOff.resetsAt === undefined || typeof cutOff.resetsAt === "number") &&
    (cutOff.leftPercent === undefined || typeof cutOff.leftPercent === "number") &&
    cutOff.stamp !== null &&
    typeof cutOff.stamp === "object";
  if (!known) return rest;
  const stamp: CredentialStamp = {};
  for (const part of ["login", "written", "client"] as const) {
    const value = cutOff.stamp[part];
    if (typeof value === "string") stamp[part] = value;
  }
  return { ...rest, cutOff: { ...cutOff, stamp } };
}
