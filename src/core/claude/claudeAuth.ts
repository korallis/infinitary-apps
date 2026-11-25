import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MachineLoginOutcome } from "@shared/accounts";
import { CLAUDE_ACCESS_IN_USE_TEXT } from "@shared/claudeAccess";
import { CLAUDE_CHIP_INSTALL_NOTE, CLAUDE_CLIENT_MISSING_TEXT } from "@shared/claudeClient";
import { HERE } from "@shared/deviceNames";
import * as m from "@shared/i18n/messages.generated";
import { desktopConventions } from "@shared/platform";
import {
  type AccountBackend,
  type AccountBinding,
  type AccountLoginRequest,
  type AccountRef,
  type AccountStatus,
  claudeLoginFolder,
  type LogoutOutcome,
  statusFromHealth,
} from "../accounts/accountBackend";
import type { CredentialHealth, RenewalOutcome, RenewReason } from "../accounts/credentialHealth";
import { askedFromAView } from "../askedFromAView";
import { absentKeychain, type HostKeychain } from "../host";
import { hostPlatform } from "../platform";
import { type ClaudeAccess, type ClaudeAccessRead, readClaudeAccess } from "./claudeAccess";
import {
  CLAUDE_AUTH_STATUS_ARGS,
  type ClaudeClientCheck,
  checkClaudeClient,
  claudeClientIssueReason,
  claudeClientIssueText,
  LOGIN_TIMEOUT_MS,
  NO_BROWSER,
  pasteCodeLink,
  type RunClaude,
  resolveClaudeExecutable,
  runClaude,
} from "./claudeCli";
import {
  type ClaudeStoreRead,
  claudeCredentialStamp,
  clearClaudeCredentialCache,
  clearKeychainLock,
  credentialMarker,
  defaultClaudeConfigDir,
  type ReadClaudeStoreOptions,
  readClaudeStore,
} from "./claudeQuota";
import { runExclusiveStoreTask, tryExclusiveStoreTask } from "./claudeStoreLease";

/**
 * The Claude account backend (account-broker phase 7, CD-1=B). The first
 * Claude account is the machine's default `claude login`: Infinitary reads it
 * and never mints or refreshes Anthropic OAuth. The vault keeps a bookkeeping
 * directory for that row; it is not CLAUDE_CONFIG_DIR and is not a credential
 * store. Its login, status, quota and crewmate runs all target the vendor's
 * own default store (`~/.claude` + the bare Keychain item).
 *
 * A further Claude account (`LoginStore.own`) is a login of its own: the
 * client runs with CLAUDE_CONFIG_DIR set to the folder the vault made in the
 * account's directory (`claudeLoginFolder`), signs in there with its own
 * login, and keeps that sign-in itself. Infinitary never opens that folder's
 * credentials or its Keychain item: whether it is signed in is the client's
 * own `auth status` word, asked while no session holds the folder.
 *
 * The client those runs spawn is the one installed on the machine (F14):
 * Infinitary ships none. A missing or too-old client is a fact about the
 * account, not about its credential - the health carries it as
 * `client_missing` / `client_outdated` with the one sentence to show, the
 * credential is still never a sign-out, and the account serves no model
 * until the client is there (`src/shared/claudeClient.ts`).
 *
 * Removing the first account does not run `claude auth logout` - that would
 * sign the user out of Claude Code. Disconnect is unbind only, but for one
 * login: the one Firstmate made on a computer that runs work from a code the
 * captain pasted (`pasteCode`), which it records when it makes it
 * (`MADE_LOGIN_FILE`) and signs out again (`signOutMadeLogin`). Removing a
 * further account signs its own folder out, since nothing else uses it.
 */

/**
 * Where one Claude account's login lives: the machine's default store, or a
 * further login's own folder (`own`), which only the client reads.
 */
type LoginStore = { dir: string; own: boolean };

/** What stood in a store before a sign-in ran: the store's read, or for an own folder the client's word. */
type LoginBaseline = ClaudeStoreRead | { state: "client-word"; connected: boolean };

/** How long an own folder's `auth status` word is kept before the client is asked again. */
export const OWN_LOGIN_STATUS_TTL_MS = 5 * 60 * 1000;

/**
 * The record a sign-in with a pasted code keeps in the account's own folder:
 * Firstmate made the login on this Mac, and which login it was (the stamp's
 * digest of its account and organisation, never a token). A login that was
 * already here when the account connected has none, so nothing ever signs
 * it out.
 */
export const MADE_LOGIN_FILE = "made-login.json";

type MadeLogin = { version: 1; login?: string; at: number };

/** What a sign-in decides from the store under its lease (`loginDecision`). */
type LoginDecision =
  | { kind: "adopt" }
  | { kind: "refuse" }
  | { kind: "login"; before: LoginBaseline };

type LoginOutcome =
  | { kind: "adopt" }
  | { kind: "refuse" }
  | { kind: "signed_in" }
  | { kind: "unfinished"; ran: Awaited<ReturnType<RunClaude>> };

export function readMadeLogin(file: string): MadeLogin | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const { version, login, at } = parsed as Record<string, unknown>;
    if (version !== 1 || typeof at !== "number") return null;
    return typeof login === "string" ? { version, login, at } : { version, at };
  } catch {
    return null;
  }
}

/**
 * Sign in over a store that could not be read: Infinitary starts no new sign-in
 * that could replace a login it cannot see. Only a desktop with a Dock is told
 * to reopen Infinitary from it, since a Mac launched another way can be refused
 * its Keychain item; every other desktop is told to open it again.
 */
export function claudeLoginUnreadableText(platform: string = hostPlatform()): string {
  const here = m.placeThisComputer();
  return desktopConventions(platform).dock
    ? m.accountsClaudeLoginUnreadable({ here })
    : m.accountsClaudeLoginUnreadableReopen({ here });
}

/**
 * The same refusal on a computer that runs work (`pasteCode`), read at its
 * home under that computer's sign-in: the login is there, not on the Mac
 * the captain reads it on.
 */
export const CLAUDE_LOGIN_UNREADABLE_THERE_TEXT =
  "Infinitary couldn't read the Claude login there, so it didn't start a new sign-in over it. Try again.";

/**
 * A sign-in that ended without Claude saying why. The browser page can say
 * the person is set up even then. The sentence names Claude's failure and
 * the login the person can finish in Claude Code, which we then use.
 */
export const CLAUDE_LOGIN_UNFINISHED_TEXT =
  "Claude failed to sign in. Open Terminal, start the Claude Code CLI, and run /login. Then connect Claude here again.";

/** The same on a computer that runs work (`pasteCode`), read at its home. */
export const CLAUDE_LOGIN_UNFINISHED_THERE_TEXT =
  "Claude failed to sign in there. On that computer, start the Claude Code CLI and run /login. Then try again.";

export type ClaudeAuthBackendOptions = {
  /** Injectable for tests; production spawns the real client. */
  run?: RunClaude;
  /** Injectable for tests; production looks for the installed executable. */
  available?: () => boolean;
  /**
   * Injectable for tests; production runs `checkClaudeClient` (the installed
   * client and its version against the SDK's floor). A test that injects
   * only `available` gets a client that counts as ready.
   */
  client?: () => Promise<ClaudeClientCheck>;
  /** One store reader for health, identity and login ownership; tests inject scratch stores. */
  readStore?: (configDir: string, options?: ReadClaudeStoreOptions) => Promise<ClaudeStoreRead>;
  /**
   * Host Keychain seam. Production passes `host.keychain` so the grant is
   * Infinitary's. Tests that inject `readStore` can omit this.
   */
  keychain?: HostKeychain;
  /**
   * The vendor's default config root. Production is `~/.claude`; tests pass
   * a throwaway dir so they never touch the developer's login.
   */
  configDir?: () => string;
  /** Injectable clock for the pasted-code login record; production is `Date.now`. */
  now?: () => number;
  /**
   * Sign in with a code pasted back, and open no browser here: a computer
   * that runs work for another Mac, where a browser would open on a screen
   * nobody watches (docs/helper.md, "Its own sign-ins"). A first connect
   * uses a login already here, as on this Mac; otherwise the vendor's own
   * login runs with its browser opener stubbed, its link goes to the
   * bridge, and the code its page shows comes back as the answer to a
   * prompt, onto the client's stdin. A lookup miss is confirmed with the
   * client before that sign-in starts: nobody at that screen would see one
   * replaced.
   */
  pasteCode?: boolean;
  /**
   * Claude access an organization or the person set up for Claude Code (a
   * token command, `claudeAccess.ts`). Production reads it with the client
   * library's own settings reader; a test that injects `readStore` or
   * `available` and not this gets none, so no unit test reads the
   * developer's own Claude settings.
   */
  access?: () => Promise<ClaudeAccessRead>;
  /**
   * A Claude account added beside the one on the default login signs in
   * inside its own Claude Code folder (docs/claude-client.md, "Further
   * logins"). On only where the owner's sessions run each account in its
   * folder; off, a second Claude account is refused, as on a computer that
   * runs work.
   */
  furtherLogins?: boolean;
};

export class ClaudeAuthBackend implements AccountBackend {
  readonly id = "claude" as const;
  readonly furtherLogins: boolean;
  private readonly run: RunClaude;
  private readonly available: () => boolean;
  private readonly client: () => Promise<ClaudeClientCheck>;
  private readonly readStore: NonNullable<ClaudeAuthBackendOptions["readStore"]>;
  private readonly configDir: () => string;
  private readonly now: () => number;
  private readonly pasteCode: boolean;
  private readonly readAccess: () => Promise<ClaudeAccessRead>;
  /** Each own folder's last `auth status` word and when the client gave it. */
  private readonly ownWords = new Map<string, { at: number; word: AccountStatus }>();

  constructor(options: ClaudeAuthBackendOptions = {}) {
    const keychain = options.keychain ?? absentKeychain;
    this.furtherLogins = options.furtherLogins === true;
    this.run = options.run ?? runClaude;
    this.available = options.available ?? (() => resolveClaudeExecutable() !== undefined);
    // An injected `available` is a test's stand-in for the client PROBE, not
    // for the install: with it and no `client`, the client counts as fine so
    // no unit test ever spawns the developer's real Claude Code. The product
    // injects neither and checks the machine.
    this.client =
      options.client ??
      (options.available
        ? async () => ({ state: "ready", executable: "injected" })
        : () => checkClaudeClient());
    this.readStore =
      options.readStore ??
      ((dir, readOptions) => readClaudeStore(dir, { ...readOptions, keychain }));
    this.configDir = options.configDir ?? defaultClaudeConfigDir;
    this.now = options.now ?? Date.now;
    this.pasteCode = options.pasteCode ?? false;
    this.readAccess =
      options.access ??
      (options.readStore || options.available ? async () => ({}) : () => readClaudeAccess());
  }

  /**
   * The token command the client would sign in with, when an organization
   * or the person set one up for Claude Code. It comes ahead of a
   * subscription sign-in, as it does in the client.
   */
  async access(): Promise<ClaudeAccess | undefined> {
    return (await this.readAccess()).access;
  }

  /**
   * A Claude subscription signs in through Claude itself. There is no
   * key-paste path here on purpose: this backend exists to reach the
   * subscription, and a console key is a different product on a different
   * bill.
   */
  authTypes(): ("oauth" | "api_key")[] {
    return this.available() ? ["oauth"] : [];
  }

  /** No client on this Mac (F14): the chip stays, disabled, and says so. */
  unavailable(): { note: string; detail: string } | undefined {
    return this.available()
      ? undefined
      : { note: CLAUDE_CHIP_INSTALL_NOTE, detail: CLAUDE_CLIENT_MISSING_TEXT };
  }

  /**
   * Attach the machine's default Claude login, or sign it in again.
   *
   * A first connect (`AccountVault.add`) uses a login already here, with no
   * browser bounce. Otherwise it runs the vendor's own `claude auth login`
   * with CLAUDE_CONFIG_DIR unset, so it writes the everyday item - not a
   * private Infinitary store. That sign-in starts only from current,
   * consistent evidence that a new login is needed, decided under the store
   * lease after any wait. A lookup miss is not a sign-out until the client
   * says it is signed out. A store we cannot read, or one that becomes
   * unreadable while we wait, is used only on the client's own word that it
   * is signed in, and is otherwise refused in a sentence - a new vendor
   * sign-in replaces the stored login and can sign out every Claude Code
   * session already running.
   *
   * The row's Sign in on an account that exists (`again`) never uses the
   * login the store holds once more: that is the login Anthropic refused,
   * so the vendor's own login runs over it, whether or not Infinitary can
   * read it now (INF-2319). Only a store with nothing in it goes the first
   * connect's way. The sign-in counts only when the store then holds a
   * different login (`newLogin`).
   */
  async login(request: AccountLoginRequest): Promise<void> {
    if (request.type !== "oauth") {
      throw new Error("A Claude subscription signs in through Claude, not with a key.");
    }
    // No client, no account: the sentence says what to do (F14). An
    // existing machine login changes nothing here - nothing could run it.
    const issue = claudeClientIssueText(await this.client());
    if (issue) throw new Error(issue);
    const store = this.storeOf(request);
    if (store.own) {
      this.ownWords.delete(store.dir);
      try {
        if (this.pasteCode) await this.loginWithPastedCode(request, store);
        else await this.loginWithBrowser(request, store);
      } finally {
        this.ownWords.delete(store.dir);
      }
      return;
    }
    // The access an organization or the person set up for Claude Code is
    // what the client signs in with: nothing to sign in to here, no browser,
    // on Connect and on the row's Try again alike.
    const access = await this.access();
    if (access) {
      request.bridge.notify({
        providerId: request.providerId,
        accountId: request.accountId,
        kind: "info",
        message: CLAUDE_ACCESS_IN_USE_TEXT[access.source],
      });
      return;
    }
    mkdirSync(store.dir, { recursive: true, mode: 0o700 });
    if (this.pasteCode) {
      await this.loginWithPastedCode(request, store);
      return;
    }
    await this.loginWithBrowser(request, store);
  }

  /**
   * The account's login store: its own folder for a further login, else the
   * default. A folder that went missing is made again, empty, so the client
   * says it is signed out there rather than the account moving to the
   * default login.
   */
  private storeOf(account: AccountRef): LoginStore {
    if (!account.ownLogin) return { dir: this.configDir(), own: false };
    const dir = claudeLoginFolder(account.dir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    return { dir, own: true };
  }

  /**
   * One client command against a login store. An own folder is named to the
   * client in CLAUDE_CONFIG_DIR; the default store is reached by leaving it
   * unset (`claudeEnvFor`).
   */
  private runIn(
    store: LoginStore,
    args: string[],
    options: NonNullable<Parameters<RunClaude>[2]> = {},
  ): ReturnType<RunClaude> {
    return this.run(
      args,
      store.dir,
      store.own ? { ...options, env: { ...options.env, CLAUDE_CONFIG_DIR: store.dir } } : options,
    );
  }

  /**
   * Use the login here, start the vendor's sign-in, or refuse, from the
   * store as it is now. Caller holds the exclusive store lease, so the
   * status read is the already-held one: a nested lease would defer and look
   * like no answer. A sign-in keeps what the store held before it, so its
   * end can tell a new login from the one that was there.
   */
  private async loginDecision(store: LoginStore, again: boolean): Promise<LoginDecision> {
    const { dir } = store;
    if (store.own) {
      // Only the client reads an own folder: its word is the evidence. With
      // no word there is no knowing what a new sign-in would replace.
      const word = await this.statusNow(store);
      if (!word) return { kind: "refuse" };
      if (word.connected && !again) return { kind: "adopt" };
      return { kind: "login", before: { state: "client-word", connected: word.connected } };
    }
    // Login compares actual credentials on both sides of the client's write.
    // A rewrite can share the previous modification date, so a cached baseline
    // could count a credential that was already there as a successful sign-in.
    const evidence = await this.readStore(dir, { bypassCache: true });
    if (again && evidence.state !== "absent") return { kind: "login", before: evidence };
    if (evidence.state === "present") return { kind: "adopt" };
    const word = await this.statusNow(store);
    if (word?.connected === true) return { kind: "adopt" };
    // The status read can rewrite the store, and a wait can change what we
    // could not read. Only the reading after that is current.
    const latest = await this.readStore(dir, { bypassCache: true });
    if (latest.state === "present") return { kind: "adopt" };
    if (latest.state === "unreadable") return { kind: "refuse" };
    if (word?.connected === false) return { kind: "login", before: latest };
    return { kind: "refuse" };
  }

  /**
   * Whether the store holds a new login since `before`, whatever the client
   * process did. Caller holds the store lease. The login that was there
   * before is not a new one: on Sign in it is the one Anthropic refused.
   * Where the store was empty, Claude had said it was signed out, so
   * anything there now, or Claude's word that it is signed in, is new.
   * Otherwise a store that cannot tell the two apart counts only on a run
   * that finished cleanly and the client's own word that it is signed in.
   */
  private async newLogin(
    store: LoginStore,
    before: LoginBaseline,
    code?: number | null,
  ): Promise<boolean> {
    const { dir } = store;
    if (before.state === "client-word") {
      // An own folder that was signed in holds the refused login: only a
      // run that finished cleanly replaced it.
      if (before.connected && code !== 0) return false;
      return (await this.statusNow(store))?.connected === true;
    }
    // The client may have saved within the file or Keychain date's resolution.
    // Read through the cache without changing the read's prompting consent.
    const after = await this.readStore(dir, { bypassCache: true });
    if (after.state === "present" && before.state === "present") {
      return credentialMarker(after.auth) !== credentialMarker(before.auth);
    }
    if (before.state === "absent" && after.state !== "absent") return true;
    if (before.state !== "absent" && code !== 0) return false;
    return (await this.statusNow(store))?.connected === true;
  }

  /**
   * The vendor's own login on this computer. The client opens the browser,
   * but for a paired view's request, where no browser opens here and the
   * link it prints opens on that view (docs/view.md, "Pages it would open").
   * The link it prints is kept, so the person can open that page again, and
   * a code the page shows can be pasted back: stdin stays open for that,
   * and cancelling the prompt stops the client. The whole wait, including
   * time spent behind another sign-in, is the one five-minute bound.
   *
   * A first connect already waiting re-reads the store once it holds the
   * lease. If the one in front saved a login, this one uses it and starts
   * no second browser login. The vendor sends a failed token exchange to the
   * same page as success; that page is not the sign-in, and a run that
   * stops after saving a new login is still a new login.
   */
  private async loginWithBrowser(request: AccountLoginRequest, store: LoginStore): Promise<void> {
    const { dir } = store;
    const started = Date.now();
    const { bridge } = request;
    const fromAView = askedFromAView();
    let pasted: (code: string) => void = () => {};
    let stopped: (reason: unknown) => void = () => {};
    const paste = new Promise<string>((resolve, reject) => {
      pasted = resolve;
      stopped = reject;
    });
    // A paste the run never waited for (it ended first) is nobody's failure.
    paste.catch(() => {});
    const stop = () => stopped(new Error("Sign in cancelled"));
    bridge.signal?.addEventListener("abort", stop, { once: true });
    let output = "";
    let asked = false;
    const timedOut = () => new Error("Claude did not respond in time.");
    try {
      const outcome = await runExclusiveStoreTask(dir, async (): Promise<LoginOutcome> => {
        // A login the sign-in in front saved is used even after a long wait;
        // only a new browser sign-in needs time left.
        const decision = await this.loginDecision(store, request.again === true);
        if (decision.kind !== "login") return decision;
        const left = LOGIN_TIMEOUT_MS - (Date.now() - started);
        if (left <= 0) throw timedOut();
        bridge.notify({
          providerId: request.providerId,
          accountId: request.accountId,
          kind: "progress",
          message: "Opening Claude in your browser to sign in...",
        });
        let ran: Awaited<ReturnType<RunClaude>>;
        try {
          ran = await this.runIn(store, ["auth", "login", "--claudeai"], {
            timeoutMs: left,
            ...(fromAView ? { env: { BROWSER: NO_BROWSER } } : {}),
            paste,
            onStdout: (chunk) => {
              output += chunk;
              if (asked) return;
              const link = pasteCodeLink(output);
              if (!link) return;
              asked = true;
              if (fromAView) bridge.openExternal(link).catch(() => {});
              bridge.notify({
                providerId: request.providerId,
                accountId: request.accountId,
                kind: "auth_url",
                message: "Finish signing in with your browser, then come back here.",
                url: link,
              });
              bridge
                .prompt({
                  promptId: randomUUID(),
                  providerId: request.providerId,
                  accountId: request.accountId,
                  kind: "manual_code",
                  message: "Paste the code the page shows, if it asks for one.",
                  placeholder: "paste the code",
                })
                .then(pasted, stopped);
            },
          });
        } catch (caught) {
          // A client we stopped may already have saved the login. The store,
          // not the thrown timer, says whether this sign-in finished.
          if (await this.newLogin(store, decision.before)) return { kind: "signed_in" };
          throw caught;
        }
        // The store is the authority, not the exit code, and not the page the
        // vendor showed. A failed exchange still redirects there.
        return (await this.newLogin(store, decision.before, ran.code))
          ? { kind: "signed_in" }
          : { kind: "unfinished", ran };
      });
      if (outcome.kind === "adopt") {
        this.finishAdopted(request);
        return;
      }
      if (outcome.kind === "refuse") {
        throw new Error(
          store.own ? m.accountsClaudeFurtherLoginNoAnswer() : claudeLoginUnreadableText(),
        );
      }
      if (outcome.kind === "unfinished") {
        throw new Error(
          unfinishedWords(
            outcome.ran,
            store.own ? m.accountsClaudeFurtherLoginUnfinished() : CLAUDE_LOGIN_UNFINISHED_TEXT,
          ),
        );
      }
    } finally {
      bridge.signal?.removeEventListener("abort", stop);
      stop();
    }
  }

  /** The machine login is already here: say so, and do not open a browser. */
  private finishAdopted(request: AccountLoginRequest): void {
    request.bridge.notify({
      providerId: request.providerId,
      accountId: request.accountId,
      kind: "info",
      message: `Using the Claude login on ${HERE.this}.`,
    });
  }

  /**
   * The vendor's own login with no browser here (`pasteCode`): its link,
   * the one whose page shows a code, goes to the bridge as a link to open
   * elsewhere, the code comes back as the answer to one prompt, and the
   * client takes it on its stdin and finishes the exchange itself. The
   * store, not the exit code, says whether it signed in. Stopping the
   * sign-in stops the client.
   *
   * A login it made is recorded in the account's folder (`MADE_LOGIN_FILE`),
   * so signing the account out, or removing the computer, signs that login
   * out too, and never one that was here before.
   */
  private async loginWithPastedCode(
    request: AccountLoginRequest,
    store: LoginStore,
  ): Promise<void> {
    const { dir } = store;
    const { bridge } = request;
    let pasted: (code: string) => void = () => {};
    let stopped: (reason: unknown) => void = () => {};
    const paste = new Promise<string>((resolve, reject) => {
      pasted = resolve;
      stopped = reject;
    });
    // A paste the run never waited for (it ended first) is nobody's failure.
    paste.catch(() => {});
    const stop = () => stopped(new Error("Sign in cancelled"));
    bridge.signal?.addEventListener("abort", stop, { once: true });
    let output = "";
    let asked = false;
    try {
      const outcome = await runExclusiveStoreTask(dir, async (): Promise<LoginOutcome> => {
        const decision = await this.loginDecision(store, request.again === true);
        if (decision.kind !== "login") return decision;
        let ran: Awaited<ReturnType<RunClaude>>;
        try {
          ran = await this.runIn(store, ["auth", "login", "--claudeai"], {
            timeoutMs: LOGIN_TIMEOUT_MS,
            env: { BROWSER: NO_BROWSER },
            paste,
            onStdout: (chunk) => {
              output += chunk;
              if (asked) return;
              const link = pasteCodeLink(output);
              if (!link) return;
              asked = true;
              bridge.notify({
                providerId: request.providerId,
                accountId: request.accountId,
                kind: "auth_url",
                message: "Open the link in your browser and sign in. Then paste the code it shows.",
                url: link,
              });
              bridge
                .prompt({
                  promptId: randomUUID(),
                  providerId: request.providerId,
                  accountId: request.accountId,
                  kind: "manual_code",
                  message: "Paste the code Claude shows.",
                  placeholder: "paste the code",
                })
                .then(pasted, stopped);
            },
          });
        } catch (caught) {
          if (await this.newLogin(store, decision.before)) return { kind: "signed_in" };
          throw caught;
        }
        return (await this.newLogin(store, decision.before, ran.code))
          ? { kind: "signed_in" }
          : { kind: "unfinished", ran };
      });
      if (outcome.kind === "adopt") {
        this.finishAdopted(request);
        return;
      }
      if (outcome.kind === "refuse") {
        throw new Error(
          store.own ? m.accountsClaudeFurtherLoginNoAnswer() : CLAUDE_LOGIN_UNREADABLE_THERE_TEXT,
        );
      }
      if (outcome.kind === "unfinished") {
        throw new Error(
          unfinishedWords(
            outcome.ran,
            store.own
              ? m.accountsClaudeFurtherLoginUnfinished()
              : CLAUDE_LOGIN_UNFINISHED_THERE_TEXT,
          ),
        );
      }
    } finally {
      bridge.signal?.removeEventListener("abort", stop);
      stop();
    }
    // An own folder is signed out with its account whoever made the login,
    // so it needs no record of who did.
    if (store.own) return;
    const { login } = claudeCredentialStamp(
      await this.readStore(dir).catch((): ClaudeStoreRead => ({ state: "unreadable" })),
    );
    const made: MadeLogin = { version: 1, ...(login ? { login } : {}), at: this.now() };
    try {
      writeFileSync(join(request.dir, MADE_LOGIN_FILE), `${JSON.stringify(made)}\n`, {
        mode: 0o600,
      });
    } catch {
      // The account is signed in; only its sign-out will keep the login here.
    }
  }

  /**
   * Unbind, and sign out the login only when Firstmate made it here from a
   * pasted code (`signOutMadeLogin`). Any other login is the user's own
   * Claude Code login, which Infinitary does not own: running `claude auth
   * logout` over it would sign them out of Claude Code.
   */
  async logout(account: AccountRef): Promise<LogoutOutcome | undefined> {
    const store = this.storeOf(account);
    if (store.own) {
      this.ownWords.delete(store.dir);
      // Nothing else uses this folder, so its login goes with the account.
      // The vault deletes the folder whatever the client answers.
      await runExclusiveStoreTask(store.dir, () => this.runIn(store, ["auth", "logout"]));
      return undefined;
    }
    const login = await this.signOutMadeLogin(join(account.dir, MADE_LOGIN_FILE));
    clearKeychainLock(this.configDir());
    clearClaudeCredentialCache(this.configDir());
    return { login };
  }

  /**
   * Signs out the login Firstmate made here, as `file` records it, with the
   * vendor's own `claude auth logout`: `kept` with no record (a login it
   * adopted) or once another login took its place, and only while the login
   * here is still the one it made. Whose login it is comes from the stamp's
   * digest, which a renewal does not change; when either side cannot be
   * read it signs nothing out. The client's own word afterwards says whether
   * the login went. It runs where the work runs, in this user's login
   * session, since the client keeps the login in that session's Keychain
   * (docs/helper.md, "Removed").
   */
  async signOutMadeLogin(file: string): Promise<MachineLoginOutcome> {
    const made = readMadeLogin(file);
    if (!made) return "kept";
    const dir = this.configDir();
    const store: LoginStore = { dir, own: false };
    return runExclusiveStoreTask(dir, async (): Promise<MachineLoginOutcome> => {
      // Gone already: signed out by hand, or by an earlier try.
      if ((await this.statusNow(store))?.connected === false) return "signed-out";
      const { login } = claudeCredentialStamp(
        await this.readStore(dir).catch((): ClaudeStoreRead => ({ state: "unreadable" })),
      );
      if (login !== undefined && made.login !== undefined && login !== made.login) return "kept";
      if (login === undefined || made.login === undefined) return "not-signed-out";
      try {
        await this.run(["auth", "logout"], dir);
      } catch {
        return "not-signed-out";
      }
      return (await this.statusNow(store))?.connected === false ? "signed-out" : "not-signed-out";
    });
  }

  /**
   * Sessions own renewal. After a vendor rejection only, ask the idle client
   * once and observe its store; no proactive refresh, command ladder or wait.
   * This keeps AccountBackend.renew as the one recovery seam for every provider.
   */
  async renew(account: AccountRef, reason: RenewReason): Promise<RenewalOutcome> {
    if (reason !== "vendor_rejected") return { outcome: "unsupported" };
    const own = this.storeOf(account);
    if (own.own) return this.renewOwn(own);
    // The client runs the token command again itself after a refusal; the
    // app has nothing of its own to renew.
    if (await this.access()) return { outcome: "unsupported" };
    const dir = this.configDir();
    const claimed = await tryExclusiveStoreTask(dir, async (): Promise<RenewalOutcome> => {
      const options = { preferKeychain: true, bypassCache: true };
      const before = await this.readStore(dir, options);
      if (before.state !== "present") {
        return { outcome: before.state === "absent" ? "no_credential" : "unreadable" };
      }
      let code: number | null;
      try {
        ({ code } = await this.run([...CLAUDE_AUTH_STATUS_ARGS], dir));
      } catch {
        return { outcome: "failed" };
      }
      const after = await this.readStore(dir, options);
      if (after.state !== "present") return { outcome: "unreadable" };
      if (credentialMarker(after.auth) !== credentialMarker(before.auth)) {
        return { outcome: "renewed" };
      }
      return { outcome: code === 0 ? "unchanged" : "failed" };
    });
    return claimed.ran
      ? claimed.value
      : { outcome: claimed.refusal === "session_active" ? "deferred_session" : "deferred_busy" };
  }

  /**
   * Health reads the default store, never a refreshing client status poll.
   * Its modification-date cache follows the live client's writes. Saved expiry
   * remains advisory; only an absent store is unsigned, unreadable is degraded.
   */
  async health(account: AccountRef): Promise<CredentialHealth> {
    const client = await this.client();
    const version = client.state === "missing" ? undefined : client.version;
    const store = this.storeOf(account);
    if (store.own) return withClientIssue(await this.ownHealth(store, version), client);
    const { access, gateway } = await this.readAccess();
    // A token command set up for Claude Code is what the client signs in
    // with, ahead of any subscription in the store: the store is not read,
    // and the access's digest is the login a refusal is recorded under. An
    // address alone leaves the subscription serving, through that address.
    const health: CredentialHealth = access
      ? {
          state: "healthy",
          authType: "api_key",
          access: access.source,
          stamp: { login: `access:${access.digest}`, ...(version ? { client: version } : {}) },
        }
      : { ...(await this.storeHealth(version)), ...(gateway ? { gateway } : {}) };
    return withClientIssue(health, client);
  }

  /**
   * An own folder's health from the client's own word, never from its
   * credentials. The word is kept for `OWN_LOGIN_STATUS_TTL_MS` and asked
   * again only while no session holds the folder and no other command runs
   * in it (the client's status read can renew, and a refresh token is single
   * use); otherwise the last word stands. With no word yet, the login is
   * unknown, never signed out.
   */
  private async ownHealth(
    store: LoginStore,
    version: string | undefined,
  ): Promise<CredentialHealth> {
    const word = await this.ownWord(store);
    if (!word) return { state: "degraded", reason: "unknown" };
    if (!word.connected) return { state: "unsigned" };
    const email = word.identity?.label;
    const stamp = {
      ...(email ? { login: createHash("sha256").update(email).digest("hex").slice(0, 16) } : {}),
      ...(version ? { client: version } : {}),
    };
    return {
      state: "healthy",
      authType: word.authType ?? "oauth",
      ...(word.identity ? { identity: word.identity } : {}),
      ...(Object.keys(stamp).length > 0 ? { stamp } : {}),
    };
  }

  private async ownWord(store: LoginStore): Promise<AccountStatus | undefined> {
    const kept = this.ownWords.get(store.dir);
    if (kept && this.now() - kept.at < OWN_LOGIN_STATUS_TTL_MS) return kept.word;
    const asked = await tryExclusiveStoreTask(store.dir, () => this.statusNow(store));
    if (!asked.ran || !asked.value) return kept?.word;
    this.ownWords.set(store.dir, { at: this.now(), word: asked.value });
    return asked.value;
  }

  /**
   * After a rejection, an own folder's client is asked once whether it is
   * still signed in; asking is also what lets it renew. Its word is all
   * there is to observe, so a login it still vouches for is `unchanged`.
   */
  private async renewOwn(store: LoginStore): Promise<RenewalOutcome> {
    const asked = await tryExclusiveStoreTask(store.dir, () => this.statusNow(store));
    if (!asked.ran) {
      return {
        outcome: asked.refusal === "session_active" ? "deferred_session" : "deferred_busy",
      };
    }
    if (!asked.value) return { outcome: "failed" };
    this.ownWords.set(store.dir, { at: this.now(), word: asked.value });
    return { outcome: asked.value.connected ? "unchanged" : "no_credential" };
  }

  /** Health, identity and the real-refusal stamp from one silent read of the store. */
  private async storeHealth(version: string | undefined): Promise<CredentialHealth> {
    const read = await this.readStore(this.configDir());
    const credential = this.credentialHealth(read);
    const stamp = { ...claudeCredentialStamp(read), ...(version ? { client: version } : {}) };
    return Object.keys(stamp).length > 0 ? { ...credential, stamp } : credential;
  }

  /** A store we cannot read is stale, never evidence that a login went away. */
  private credentialHealth(read: ClaudeStoreRead): CredentialHealth {
    if (read.state === "present") {
      const identity = {
        ...(read.identity.label ? { label: read.identity.label } : {}),
        ...(read.auth.subscriptionType ? { plan: planLabel(read.auth.subscriptionType) } : {}),
      };
      return {
        state: "healthy",
        authType: "oauth",
        ...(Object.keys(identity).length ? { identity } : {}),
        ...(read.auth.expiresAt !== undefined ? { expiresAt: read.auth.expiresAt } : {}),
      };
    }
    return read.state === "unreadable"
      ? { state: "degraded", reason: read.reason ?? "unknown" }
      : { state: "unsigned" };
  }

  async status(account: AccountRef): Promise<AccountStatus> {
    return statusFromHealth(await this.health(account));
  }

  /** The client's own status read, inside a store task already held; nothing when it cannot answer. */
  private async statusNow(store: LoginStore): Promise<AccountStatus | undefined> {
    try {
      return parseJsonStatus((await this.runIn(store, [...CLAUDE_AUTH_STATUS_ARGS])).stdout);
    } catch {
      return undefined;
    }
  }

  binding(account: AccountRef): AccountBinding {
    const store = this.storeOf(account);
    return store.own ? { via: "config-dir", configDir: store.dir } : { via: "default-login" };
  }
}

/**
 * The client is a fact beside the credential (F14): a live login with no
 * client to run it is degraded with the sentence, never a sign-out, and a
 * sign-out stays a sign-out whatever the client's state.
 */
function withClientIssue(health: CredentialHealth, client: ClaudeClientCheck): CredentialHealth {
  const issue = claudeClientIssueReason(client);
  if (issue === undefined || health.state === "unsigned" || health.state === "needs_reauth") {
    return health;
  }
  const detail = claudeClientIssueText(client);
  return { ...health, state: "degraded", reason: issue, ...(detail ? { detail } : {}) };
}

export function parseStatus(stdout: string): AccountStatus {
  return parseJsonStatus(stdout) ?? { connected: false };
}

/**
 * The same read, keeping the one distinction `status` turns on: `undefined`
 * means the client did not give us an answer at all, which is not the same
 * claim as "this store is signed out".
 */
function parseJsonStatus(stdout: string): AccountStatus | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.loggedIn !== "boolean") return undefined;
  if (!record.loggedIn) return { connected: false };
  const email = typeof record.email === "string" ? record.email : undefined;
  const plan =
    typeof record.subscriptionType === "string" ? planLabel(record.subscriptionType) : undefined;
  const identity =
    email || plan ? { ...(email ? { label: email } : {}), ...(plan ? { plan } : {}) } : undefined;
  return {
    connected: true,
    authType: record.authMethod === "apiKey" ? "api_key" : "oauth",
    ...(identity ? { identity } : {}),
  };
}

/** Plan names as the user knows them, not as the API spells them. */
function planLabel(subscriptionType: string): string {
  const known: Record<string, string> = {
    max: "Max",
    pro: "Pro",
    team: "Team",
    enterprise: "Enterprise",
  };
  return known[subscriptionType] ?? subscriptionType;
}

/**
 * Why a login run left no new login. A run that ended cleanly said what it
 * did on stdout, which is no reason; only what it wrote as an error is.
 */
function unfinishedWords(ran: Awaited<ReturnType<RunClaude>>, text: string): string {
  return loginFailure(ran.stderr, ran.code === 0 ? "" : ran.stdout, text);
}

/**
 * Claude's own words when a sign-in fails; a generic message helps nobody.
 * Its error stream says why when it says anything, before what it printed
 * while it waited. A line ending in a colon only introduces a reason, so an
 * error stream of those alone ("Login failed: ") gives none: the sign-in
 * then ends with `unfinished`, never the bare label or a waiting line.
 */
function loginFailure(stderr: string, stdout: string, unfinished: string): string {
  const lines = (stream: string) =>
    stream
      .split("\n")
      .map((line) => line.trim())
      // What it printed while it waited is not why it stopped: the authorize
      // URL is machinery, and by failure time it is spent, as are its prompts.
      .filter(
        (line) =>
          line &&
          !line.includes("https://") &&
          !line.startsWith("Opening browser") &&
          !line.includes("Paste code here"),
      );
  const why = lines(stderr);
  const said = (why.length > 0 ? why : lines(stdout)).filter((line) => !line.endsWith(":"));
  return said.slice(-3).join(" ") || unfinished;
}
