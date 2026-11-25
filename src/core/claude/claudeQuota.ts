import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { KEYCHAIN_READ_INCOMPLETE_CODE, type KeychainValueFailure } from "@shared/quota";
import type { CredentialStamp } from "../accounts/credentialHealth";
import {
  absentKeychain,
  type HostKeychain,
  type HostKeychainOutcome,
  type HostKeychainUnlockOutcome,
} from "../host";

/**
 * The machine's default Claude login, as Infinitary is allowed to read it
 * (captain CD-1=B): the access token behind the same read-only usage
 * request the client itself makes, its advisory expiry and its current
 * identity in one present/absent/unreadable result.
 *
 * Infinitary never mints or refreshes Anthropic OAuth. It reads what the vendor's
 * own `claude login` maintains: a `.credentials.json` in the default config
 * root (`~/.claude`) when the Keychain is unavailable, otherwise the bare
 * login-Keychain item `Claude Code-credentials` (no per-account suffix),
 * under whatever account the client keyed it on (findClaudeKeychainItem).
 * Setting CLAUDE_CONFIG_DIR would hash a suffix onto that name and miss the
 * everyday login - the login probe measured that, which is why Claude runs
 * on that login leave the variable unset. A further login's own folder is
 * never read here (docs/claude-client.md, "Further logins").
 *
 * macOS may ask before the Keychain item can be read. On a Claude Code item
 * with an apple-tool partition, even Always Allow for Infinitary's decrypt ACL
 * does not grant Infinitary's process access; the host first tries the direct
 * read and, only when that one item's access rules already trust Apple's
 * security tool without a password, uses that trusted path
 * (see darwinKeychain.ts). Neither
 * path changes the item's ACL. A declined, denied, or timed-out read remains
 * retryable, never a process-lifetime poison (CL-C).
 */

export type ClaudeQuotaAuth = {
  accessToken: string;
  /** Advisory only: the vendor's 401 is the definitive expiry signal. */
  expiresAt?: number;
  /** The plan the client saved, so health need not spawn it just to name the plan. */
  subscriptionType?: string;
};

const SEC_ITEM_NOT_FOUND_CLI = 44;
/** errSecItemNotFound as Security.framework OSStatus. */
const SEC_ITEM_NOT_FOUND = -25300;
/** errSecInteractionNotAllowed - no SecurityAgent dialog could be presented. */
const SEC_INTERACTION_NOT_ALLOWED = -25308;
/** errSecInteractionRequired - the same refusal, as newer macOS reports it. */
const SEC_INTERACTION_REQUIRED = -25315;

/**
 * A declined VALUE read must not re-ask until Retry. Four reasons are not
 * declines and stay out of `keychainLocks`: a read that ran out of time says
 * nothing about the item, a blocked session is
 * environmental, and a missing grant or a locked store heals the moment the
 * user acts - possibly in Keychain Access, or by unlocking the Mac, rather
 * than through our Retry - so the next tick must be free to discover that.
 * A background tick on a locked store costs one silent attribute read.
 */
function holdKeychainLock(reason: KeychainValueFailure): boolean {
  return (
    reason !== "keychain_no_interactive_session" &&
    reason !== "keychain_needs_grant" &&
    reason !== "keychain_locked" &&
    reason !== "keychain_read_incomplete"
  );
}

/**
 * Config roots whose Keychain VALUE read was declined, denied, or timed
 * out, with the reason the meter should show. A background tick must not
 * re-ask; a user-initiated retry (`allowPrompt`) clears the lock and tries
 * again. This is the CL-C fix: never a process-lifetime Set with no reason.
 */
const keychainLocks = new Map<string, KeychainValueFailure>();

/**
 * The store identity a lock was taken under. A store that names another
 * login or was rewritten since is not the one that was declined, so a
 * background tick may make one fresh (never prompting) read of it instead of
 * waiting for Retry; a decline there locks again under the new identity.
 */
const keychainLockIdentity = new Map<string, ObservedStoreIdentity>();

/** A user-initiated read (sign-in, Retry) clears the lock so we can ask again. */
export function clearKeychainLock(configDir?: string): void {
  if (configDir === undefined) {
    keychainLocks.clear();
    keychainLockIdentity.clear();
  } else {
    keychainLocks.delete(configDir);
    keychainLockIdentity.delete(configDir);
  }
}

/**
 * The credential a Keychain VALUE read produced, per config root, held in
 * memory for exactly as long as it is still the current one.
 *
 * The macOS ask is the scarce thing here, not the read. Without this, every
 * quota tick (five minutes, plus window focus, resume, and startup) spends its
 * own VALUE read: on a Mac whose Claude login lives only in the Keychain -
 * no `.credentials.json` sidecar - a grant that did not stick bought exactly
 * one measurement, and the meter failed again minutes later inside the same
 * session. One grant should carry a session.
 *
 * Never persisted, never logged, and never handed across the preload
 * boundary; it is the same value the resolver already returns to its caller.
 * Each entry also records the non-secret account config's UUID and mtime, so
 * an external login or account swap invalidates it without another Keychain
 * VALUE read.
 */
type ObservedStoreIdentity = {
  accountUuid?: string;
  configMtimeMs?: number;
  configPath?: string;
  keychainModifiedAt?: string;
  keychainAccount?: string;
};

type CredentialCacheEntry = {
  auth: ClaudeQuotaAuth;
  storeIdentity: ObservedStoreIdentity;
};

const credentialCache = new Map<string, CredentialCacheEntry>();
const fileCredentialCache = new Map<string, { modifiedAt: number; auth: ClaudeQuotaAuth }>();
const identityCache = new Map<string, AccountIdentityRecord>();
const readsInFlight = new WeakMap<HostKeychain, Map<string, Promise<ClaudeStoreRead>>>();

function sameStoreIdentity(left: ObservedStoreIdentity, right: ObservedStoreIdentity): boolean {
  return (
    left.configPath === right.configPath &&
    left.accountUuid === right.accountUuid &&
    left.configMtimeMs === right.configMtimeMs &&
    left.keychainModifiedAt === right.keychainModifiedAt &&
    left.keychainAccount === right.keychainAccount
  );
}

function rememberedCredential(
  configDir: string,
  storeIdentity: ObservedStoreIdentity | undefined,
): ClaudeQuotaAuth | undefined {
  const entry = credentialCache.get(configDir);
  if (!entry) return undefined;
  if (storeIdentity === undefined || !sameStoreIdentity(entry.storeIdentity, storeIdentity)) {
    credentialCache.delete(configDir);
    return undefined;
  }
  return entry.auth;
}

/** A saved expiry is advisory; only a changed store or explicit retry invalidates its value. */
function rememberCredential(
  configDir: string,
  auth: ClaudeQuotaAuth,
  storeIdentity: ObservedStoreIdentity | undefined,
): void {
  // Config metadata alone cannot date a credential rotation. A Keychain-only
  // store must expose the item's modification date before we can cache it.
  if (storeIdentity?.keychainModifiedAt === undefined) return;
  credentialCache.set(configDir, { auth, storeIdentity });
}

/** Forget the remembered credential for a store. Sign-out; tests between cases. */
export function clearClaudeCredentialCache(configDir?: string): void {
  if (configDir === undefined) {
    credentialCache.clear();
    fileCredentialCache.clear();
    identityCache.clear();
  } else {
    credentialCache.delete(configDir);
    fileCredentialCache.delete(configDir);
    identityCache.delete(configDir);
  }
}

/**
 * The bare Keychain item the vendor's own `claude login` writes when
 * CLAUDE_CONFIG_DIR is unset. A suffixed name is the per-account store we
 * retired (CD-1=B); do not derive one from a config root.
 */
export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

export function keychainServiceFor(): string {
  return CLAUDE_KEYCHAIN_SERVICE;
}

/**
 * The config root the client uses for that same default login: `~/.claude`.
 * File-store fallback and identity live here; the Keychain item does not
 * take a suffix from this path (setting CLAUDE_CONFIG_DIR would).
 */
export function defaultClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME?.trim() || safeHomedir();
  return join(home, ".claude");
}

function safeHomedir(): string {
  try {
    return homedir();
  } catch {
    return "";
  }
}

/**
 * The account name the client keys its Keychain item on when it runs with
 * this USER: asked for first, never required (findClaudeKeychainItem).
 */
export function keychainAccountName(env: NodeJS.ProcessEnv = process.env): string {
  const candidate = env.USER?.trim() || safeUsername();
  return candidate && /^[A-Za-z0-9._@-]{1,128}$/.test(candidate) ? candidate : "claude-code-user";
}

/** Which item presence found, and the account every later read of it names. */
type ClaudeKeychainItem = { presence: HostKeychainOutcome; account?: string };

/**
 * The client's Keychain item: the exact service, under whatever account the
 * client keyed it on. The client names it after USER, but its runtime (Bun)
 * names an unset USER "unknown" where this process would name the real user,
 * and other versions or launchers may differ again. So the name the client
 * keys on with this USER is asked first - when both exist, that is the item
 * the client itself reads - and on a definite miss the service alone, which
 * still matches only Claude's own items, never another saved password.
 * Attributes only, never the value. The returned account is the found
 * item's own, so the value read, the unlock and the Apple tool all reach
 * that one item.
 */
async function findClaudeKeychainItem(
  keychain: HostKeychain,
  env: NodeJS.ProcessEnv,
): Promise<ClaudeKeychainItem> {
  const service = keychainServiceFor();
  const account = keychainAccountName(env);
  const exact = await keychain.findGenericPassword({ service, account });
  if (!isAbsentOutcome(exact)) return { presence: exact, account };
  const any = await keychain.findGenericPassword({ service });
  const found = any.kind === "found" ? any.account : undefined;
  return { presence: any, ...(found !== undefined ? { account: found } : {}) };
}

function safeUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
}

/**
 * The file's or Keychain item's contents as a login, as no login, or as
 * contents this reader does not understand. The client keeps other entries
 * in the same store and leaves it behind without a login: signing out leaves
 * the entries it does not own, and a refused renewal blanks the login's
 * tokens in place. A store like that holds no login, the same as a missing
 * one.
 */
function parseCredentials(raw: string): ClaudeQuotaAuth | "none" | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const oauth = (parsed as Record<string, unknown>).claudeAiOauth;
  if (oauth === undefined || oauth === null) return "none";
  if (typeof oauth !== "object") return undefined;
  const record = oauth as Record<string, unknown>;
  const accessToken = typeof record.accessToken === "string" ? record.accessToken : undefined;
  if (!accessToken) return "none";
  const expiresAt = typeof record.expiresAt === "number" ? record.expiresAt : undefined;
  return {
    accessToken,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(typeof record.subscriptionType === "string"
      ? { subscriptionType: record.subscriptionType }
      : {}),
  };
}

type CredentialsFileRead =
  | { kind: "absent" }
  | { kind: "unreadable"; modifiedAt?: number }
  | { kind: "auth"; auth: ClaudeQuotaAuth; modifiedAt: number };

function isMissingCredentialsFile(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

/**
 * The plain-file store, with absence kept apart from a read or parse that
 * failed. A missing file, or one that holds no login, is a lookup miss. A
 * directory, a permission error, or contents this reader does not
 * understand is unreadable, not missing.
 */
async function readCredentialsFile(
  configDir: string,
  bypassCache: boolean,
): Promise<CredentialsFileRead> {
  const path = join(configDir, ".credentials.json");
  let modifiedAt: number | undefined;
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      fileCredentialCache.delete(configDir);
      return { kind: "unreadable" };
    }
    modifiedAt = info.mtimeMs;
    const cached = fileCredentialCache.get(configDir);
    if (!bypassCache && cached?.modifiedAt === info.mtimeMs) {
      return { kind: "auth", ...cached };
    }
    fileCredentialCache.delete(configDir);
    const auth = parseCredentials(await readFile(path, "utf8"));
    if (auth === "none") return { kind: "absent" };
    if (!auth) return { kind: "unreadable", modifiedAt };
    const read = { auth, modifiedAt: info.mtimeMs };
    fileCredentialCache.set(configDir, read);
    return { kind: "auth", ...read };
  } catch (error) {
    fileCredentialCache.delete(configDir);
    return isMissingCredentialsFile(error)
      ? { kind: "absent" }
      : { kind: "unreadable", ...(modifiedAt !== undefined ? { modifiedAt } : {}) };
  }
}

type KeychainRead =
  | { kind: "auth"; auth: ClaudeQuotaAuth; modifiedAt?: string }
  | { kind: "locked"; reason: KeychainValueFailure }
  | { kind: "absent" };

/**
 * Classify a failed Keychain VALUE or presence read. The codes are macOS
 * Security.framework OSStatus values as the host reports them. Residual
 * `security(1)` shapes (exit 44, a killed child) stay for the classifier
 * tests and any leftover error objects.
 */
export function classifyKeychainValueError(error: unknown): KeychainValueFailure {
  const err = error as {
    killed?: boolean;
    code?: unknown;
    message?: string;
    stderr?: string;
  } | null;
  if (err?.code === KEYCHAIN_READ_INCOMPLETE_CODE) return "keychain_read_incomplete";
  if (err?.killed === true) return "keychain_prompt_timeout";
  const message = `${err?.message ?? ""}\n${err?.stderr ?? ""}`.toLowerCase();
  if (/timed out|timeout/.test(message)) return "keychain_prompt_timeout";
  const code = err?.code;
  // The dialog could not be presented. Match before the generic "not allowed"
  // denied class: nobody declined. WHY it could not be presented is not in the
  // status - see `interactionFailure`, which knows whether we were the ones
  // who suppressed it.
  if (
    code === SEC_INTERACTION_NOT_ALLOWED ||
    code === SEC_INTERACTION_REQUIRED ||
    /user interaction is not allowed|interaction (is )?required|cssmerr_csp_no_user_interaction/.test(
      message,
    )
  ) {
    return "keychain_no_interactive_session";
  }
  // errSecUserCanceled (-128), errSecAuthFailed (-25293), and the 128 that
  // some `security` builds surface for a dismissed dialog.
  if (code === -128 || code === -25293 || code === 128 || code === "128") {
    return "keychain_access_denied";
  }
  if (/cancel|denied|not allowed|auth failed/.test(message)) {
    return "keychain_access_denied";
  }
  return "keychain_unavailable";
}

function classifyHostFailure(outcome: { code?: number; message: string }): KeychainValueFailure {
  return classifyKeychainValueError({ code: outcome.code, message: outcome.message });
}

function isAbsentOutcome(outcome: HostKeychainOutcome | HostKeychainUnlockOutcome): boolean {
  if (outcome.kind === "absent") return true;
  if (outcome.kind !== "failed") return false;
  return outcome.code === SEC_ITEM_NOT_FOUND || outcome.code === SEC_ITEM_NOT_FOUND_CLI;
}

function lockFromFailure(
  configDir: string,
  reason: KeychainValueFailure,
  persistLock: boolean,
  storeIdentity?: ObservedStoreIdentity,
): KeychainRead {
  if (persistLock && holdKeychainLock(reason)) {
    keychainLocks.set(configDir, reason);
    if (storeIdentity) keychainLockIdentity.set(configDir, storeIdentity);
    else keychainLockIdentity.delete(configDir);
  }
  return { kind: "locked", reason };
}

/**
 * Why no dialog could be presented. macOS reports the same status whether the
 * session has no SecurityAgent at all or WE suppressed the dialog for a
 * background read - but we do not have to guess, because we are the ones who
 * chose. A background read of an item Infinitary has not been granted access to
 * lands here on every tick, and "relaunch it from the Dock" sends the captain
 * somewhere there is nothing to find: what that item needs is one Always Allow.
 */
function interactionFailure(
  reason: KeychainValueFailure,
  allowPrompt: boolean,
): KeychainValueFailure {
  if (reason !== "keychain_no_interactive_session") return reason;
  return allowPrompt ? reason : "keychain_needs_grant";
}

/**
 * Why an unlock the person asked for did not leave the store unlocked. A
 * cancelled or unanswered dialog, a wrong password, a dialog macOS could not
 * draw: the store is still locked and the next Retry asks again, so all of
 * them are `keychain_locked`. Two are not: a session that can present no
 * dialog at all, and a host that could not run the unlock (no status).
 */
function unlockFailure(
  outcome: Extract<HostKeychainUnlockOutcome, { kind: "failed" }>,
): KeychainValueFailure {
  const reason = classifyHostFailure(outcome);
  if (reason === "keychain_no_interactive_session") return reason;
  if (reason === "keychain_unavailable" && outcome.code === undefined) return reason;
  return "keychain_locked";
}

type KeychainReadOptions = {
  configDir: string;
  keychain: HostKeychain;
  env: NodeJS.ProcessEnv;
  allowPrompt: boolean;
  persistLock: boolean;
  /** False when the caller must observe the credential itself (renewal). */
  useCache: boolean;
  accountIdentity: AccountIdentityRecord | undefined;
};

async function readKeychain(options: KeychainReadOptions): Promise<KeychainRead> {
  const { configDir, keychain, env, allowPrompt, persistLock, useCache, accountIdentity } = options;
  const { presence, account } = await findClaudeKeychainItem(keychain, env);
  const query = {
    service: keychainServiceFor(),
    ...(account !== undefined ? { account } : {}),
    ...(allowPrompt ? { interactive: true as const } : {}),
  };
  if (isAbsentOutcome(presence)) {
    credentialCache.delete(configDir);
    return { kind: "absent" };
  }
  // The attribute read asks nobody, so its failure declined nothing: report
  // it, but never hold it - the next background tick must look again.
  if (presence.kind === "failed")
    return lockFromFailure(configDir, classifyHostFailure(presence), false);
  const keychainModifiedAt = presence.kind === "found" ? presence.modifiedAt : undefined;
  const storeIdentity =
    accountIdentity?.observed || keychainModifiedAt
      ? {
          ...accountIdentity?.observed,
          keychainAccount: account,
          ...(keychainModifiedAt ? { keychainModifiedAt } : {}),
        }
      : undefined;
  if (useCache) {
    const remembered = rememberedCredential(configDir, storeIdentity);
    if (remembered) return { kind: "auth", auth: remembered, modifiedAt: keychainModifiedAt };
  }
  const lockedUnder = keychainLockIdentity.get(configDir);
  if (
    lockedUnder !== undefined &&
    storeIdentity !== undefined &&
    !sameStoreIdentity(lockedUnder, storeIdentity)
  ) {
    clearKeychainLock(configDir);
  }
  const locked = keychainLocks.get(configDir);
  if (locked !== undefined && !allowPrompt) return { kind: "locked", reason: locked };
  if (allowPrompt) clearKeychainLock(configDir);

  // A locked store. The VALUE read cannot succeed until it is unlocked, and
  // from a background tick it must not even be tried: whether this process
  // may show the unlock dialog was settled at its first touch of the store,
  // and a read is the one call that would show it. So a tick reports the
  // lock; a Retry or sign-in asks the host to unlock first (in a process
  // that can still show the dialog), then reads here as always.
  let storeLocked = presence.kind === "found" && presence.locked === true;
  if (storeLocked) {
    if (!allowPrompt)
      return lockFromFailure(configDir, "keychain_locked", persistLock, storeIdentity);
    if (keychain.unlockKeychain) {
      const unlocked = await keychain.unlockKeychain(query);
      if (unlocked.kind === "failed") {
        if (isAbsentOutcome(unlocked)) return { kind: "absent" };
        return lockFromFailure(configDir, unlockFailure(unlocked), persistLock, storeIdentity);
      }
      storeLocked = false;
    }
  }

  const secret = await keychain.readGenericPassword(query);
  if (isAbsentOutcome(secret)) return { kind: "absent" };
  if (secret.kind === "failed") {
    // `allowPrompt` is what the host was told about THIS read, so it is the
    // one fact that separates a suppressed dialog from an absent session.
    const reason = interactionFailure(classifyHostFailure(secret), allowPrompt);
    // A refusal from a store presence saw locked is the lock, not a grant
    // the person declined: no "Always Allow" would fix it.
    return lockFromFailure(
      configDir,
      storeLocked && reason === "keychain_access_denied" ? "keychain_locked" : reason,
      persistLock,
      storeIdentity,
    );
  }
  if (secret.kind !== "value") {
    return lockFromFailure(configDir, "keychain_unavailable", persistLock, storeIdentity);
  }
  clearKeychainLock(configDir);
  const auth = parseCredentials(secret.value.trim());
  if (auth === "none") {
    credentialCache.delete(configDir);
    return { kind: "absent" };
  }
  if (!auth) {
    return lockFromFailure(configDir, "keychain_unreadable", persistLock, storeIdentity);
  }
  rememberCredential(configDir, auth, storeIdentity);
  return { kind: "auth", auth, modifiedAt: keychainModifiedAt };
}

/** Whether this account's Keychain VALUE read is currently locked after a refusal. */
export function isKeychainLocked(configDir: string): boolean {
  return keychainLocks.has(configDir);
}

export type ReadClaudeStoreOptions = {
  /** Host Keychain seam. Tests inject a fake; production passes `host.keychain`. */
  keychain?: HostKeychain;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /**
   * Read the Keychain even when the file store answered. The vendor's own
   * 401 is the one signal worth spending the macOS ask on: it is the moment
   * a sidecar could be masking a live item.
   */
  preferKeychain?: boolean;
  /**
   * User-initiated: sign-in or an explicit retry. May raise the macOS ask,
   * and clears a previous decline so the read is actually retried. Background
   * quota ticks omit this: a locked account stays locked until the user asks.
   */
  allowPrompt?: boolean;
  /**
   * When false, a failed Keychain VALUE read is still classified but does not
   * write `keychainLocks`. A computer running work uses this because
   * nobody may be at that screen to answer a Retry.
   */
  persistLock?: boolean;
  /**
   * Observe the store itself rather than the credential we last read from it.
   * Login and renewal need this to compare actual credentials even if the
   * store was rewritten within its modification date's resolution.
   * A bypassing read still refreshes what is remembered -
   * what it finds is by definition the current credential.
   */
  bypassCache?: boolean;
};

/**
 * Read both of the client's stores and return what the quota sensor should
 * do with them: a credential, a named Keychain lock, or nothing.
 *
 * Order matters and used to be wrong. The client keeps the Keychain
 * authoritative on macOS and can leave a `.credentials.json` behind as a
 * stale sidecar; reading the file first therefore resolves a token that may
 * be days older than the live one, and the vendor answers 401 while a good
 * credential sits one branch away. Measured on a real machine 2026-09-04: a
 * sidecar 2.4 days past expiry next to a live Keychain item. So: whichever
 * store holds the later expiry wins, and the Keychain wins when neither says.
 */
/** One read of Claude Code's store, shared by health, identity and allowance. */
export type ClaudeStoreRead =
  | { state: "present"; auth: ClaudeQuotaAuth; identity: ClaudeStoreIdentity; written?: string }
  | { state: "absent" }
  | { state: "unreadable"; reason?: KeychainValueFailure };

export type ClaudeStoreIdentity = {
  label?: string;
  accountUuid?: string;
  organizationUuid?: string;
};

export function readClaudeStore(
  configDir: string,
  options: ReadClaudeStoreOptions = {},
): Promise<ClaudeStoreRead> {
  const keychain = options.keychain ?? absentKeychain;
  let pending = readsInFlight.get(keychain);
  if (!pending) {
    pending = new Map();
    readsInFlight.set(keychain, pending);
  }
  // An explicit Retry never joins a silent poll; they have different consent.
  const key = JSON.stringify([
    configDir,
    (options.env ?? process.env).HOME,
    (options.env ?? process.env).USER,
    (options.env ?? process.env).CLAUDE_CONFIG_DIR,
    options.allowPrompt === true,
    options.preferKeychain === true,
    options.bypassCache === true,
    options.persistLock !== false,
  ]);
  const current = pending.get(key);
  if (current) return current;
  const read = readStore(configDir, options).finally(() => pending.delete(key));
  pending.set(key, read);
  return read;
}

async function readStore(
  configDir: string,
  options: ReadClaudeStoreOptions,
): Promise<ClaudeStoreRead> {
  const keychain = options.keychain ?? absentKeychain;
  const env = options.env ?? process.env;
  const at = (options.now ?? Date.now)();
  const allowPrompt = options.allowPrompt === true;
  const accountIdentity = await readAccountIdentityRecord(configDir, env);
  const identity = accountIdentity?.identity ?? {};
  const file = await readCredentialsFile(configDir, options.bypassCache === true || allowPrompt);
  const presentFile = (): ClaudeStoreRead =>
    file.kind === "auth"
      ? { state: "present", auth: file.auth, identity, written: `file:${file.modifiedAt}` }
      : { state: file.kind };
  const fromFile = file.kind === "auth" ? file.auth : undefined;
  const fileMayBeCurrent =
    fromFile !== undefined && (fromFile.expiresAt === undefined || fromFile.expiresAt > at);
  if (fileMayBeCurrent && !options.preferKeychain) return presentFile();
  let fromKeychain: KeychainRead;
  try {
    fromKeychain = await readKeychain({
      configDir,
      keychain,
      env,
      allowPrompt,
      persistLock: options.persistLock !== false,
      useCache: options.bypassCache !== true && !allowPrompt,
      accountIdentity,
    });
  } catch (error) {
    fromKeychain = { kind: "locked", reason: classifyKeychainValueError(error) };
  }
  if (fromKeychain.kind === "locked") {
    return fromFile ? presentFile() : { state: "unreadable", reason: fromKeychain.reason };
  }
  if (fromKeychain.kind === "absent") return presentFile();
  if (fromFile && (fromFile.expiresAt ?? 0) > (fromKeychain.auth.expiresAt ?? 0)) {
    return presentFile();
  }
  return {
    state: "present",
    auth: fromKeychain.auth,
    identity,
    // Keep the refusal record's existing file-first date when a sidecar
    // exists; selecting a newer Keychain token alone is not a rewritten store.
    ...(file.kind !== "absent" && file.modifiedAt !== undefined
      ? { written: `file:${file.modifiedAt}` }
      : fromKeychain.modifiedAt
        ? { written: `keychain:${fromKeychain.modifiedAt}` }
        : {}),
  };
}

/**
 * An opaque, in-memory-only marker for "the store still holds the same
 * credential". It exists so a renewal can be OBSERVED rather than presumed:
 * the token value never leaves this module, is never logged and is never
 * persisted - only the equality of two markers is ever used.
 */
export function credentialMarker(auth: ClaudeQuotaAuth | undefined): string | undefined {
  if (!auth) return undefined;
  return createHash("sha256")
    .update(`${auth.accessToken}:${auth.expiresAt ?? ""}`)
    .digest("hex");
}

type AccountIdentityRecord = {
  identity: ClaudeStoreIdentity;
  observed: ObservedStoreIdentity;
};

/**
 * Locate and read the account config the way Claude Code does. The legacy
 * config inside the config home wins when present; otherwise the default
 * login's oauthAccount lives at the home root, not inside `.claude`.
 */
async function readAccountIdentityRecord(
  configDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AccountIdentityRecord | undefined> {
  const legacyPath = join(configDir, ".config.json");
  const home = env.CLAUDE_CONFIG_DIR?.trim() || env.HOME?.trim() || safeHomedir();
  let identityPath = legacyPath;
  try {
    const info = await stat(identityPath);
    if (!info.isFile()) throw new Error("legacy config is not a file");
  } catch {
    identityPath = join(home, ".claude.json");
  }

  try {
    const info = await stat(identityPath);
    const cached = identityCache.get(configDir);
    if (
      cached?.observed.configPath === identityPath &&
      cached.observed.configMtimeMs === info.mtimeMs
    ) {
      return cached;
    }
    identityCache.delete(configDir);
    const raw = await readFile(identityPath, "utf8");
    const observed: ObservedStoreIdentity = {
      configMtimeMs: info.mtimeMs,
      configPath: identityPath,
    };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { identity: {}, observed };
    }
    if (!parsed || typeof parsed !== "object") return { identity: {}, observed };
    const oauth = (parsed as Record<string, unknown>).oauthAccount;
    if (!oauth || typeof oauth !== "object") return { identity: {}, observed };
    const record = oauth as Record<string, unknown>;
    const email =
      typeof record.emailAddress === "string" && record.emailAddress
        ? { label: record.emailAddress }
        : {};
    const accountUuid =
      typeof record.accountUuid === "string" && record.accountUuid
        ? { accountUuid: record.accountUuid }
        : {};
    const organizationUuid =
      typeof record.organizationUuid === "string" && record.organizationUuid
        ? { organizationUuid: record.organizationUuid }
        : {};
    const result = {
      identity: { ...email, ...accountUuid, ...organizationUuid },
      observed: { ...observed, ...accountUuid },
    };
    identityCache.set(configDir, result);
    return result;
  } catch {
    identityCache.delete(configDir);
    return undefined;
  }
}

/** The email address of the Claude Code login kept in this config home, when it has one. */
export async function claudeLoginEmail(
  configDir: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  return (await readAccountIdentityRecord(configDir, env))?.identity.label;
}

/**
 * The real-refusal and made-login records keep their existing non-secret
 * equality key. This is a pure projection of the one read, not another
 * identity reader or focus-time digest scan; existing records stay valid.
 */
export function claudeCredentialStamp(read: ClaudeStoreRead): CredentialStamp {
  if (read.state !== "present") return {};
  const { accountUuid, organizationUuid } = read.identity;
  const login =
    accountUuid || organizationUuid
      ? createHash("sha256")
          .update(`${accountUuid ?? ""}\n${organizationUuid ?? ""}`)
          .digest("hex")
          .slice(0, 16)
      : undefined;
  return { ...(login ? { login } : {}), ...(read.written ? { written: read.written } : {}) };
}
