import { join } from "node:path";
import type { MachineLoginOutcome } from "@shared/accounts";
import type { ClaudeAccessSource } from "@shared/claudeAccess";
import { REFRESH_TOKEN_LAPSED } from "@shared/credentialHealth";
import type { BackendId } from "@shared/providers";
import type { AuthInteractionBridge } from "../pi/piAuth";
import type { CredentialHealth, RenewalOutcome, RenewReason } from "./credentialHealth";

/**
 * The account-backend seam (account-broker phase 7): the AccountVault owns
 * the store MATRIX - how many accounts exist, where each store lives, its
 * 0700 isolation, and its deletion - while a backend owns what happens
 * INSIDE one store: the harness's own login, its logout, credential health
 * and renewal, and reading back whether that store currently holds a usable
 * credential. `status()` is a projection of `health()`.
 *
 * Infinitary never reads, parses, or forwards a credential through this seam.
 * The only value that crosses back out is an AccountBinding: locations, and
 * never a secret.
 *
 * Phase 7 registers the second backend (Claude) behind the first (Pi). The
 * shape is deliberately backend-neutral, but the set is closed: a supported
 * subscription runs through Pi, and Claude is the sole exception (captain,
 * 2026-09-24).
 */

/**
 * The one value the vault produces for a spawn or attach. Locations only.
 * `pi-runtime` is in-process (one ModelRuntime per account's auth file);
 * `default-login` is the first Claude login, the machine's default one
 * (CD-1=B) - no per-account store, CLAUDE_CONFIG_DIR left unset so the
 * client uses the bare Keychain item; `config-dir` is a further Claude
 * login, whose client runs with CLAUDE_CONFIG_DIR set to the account's own
 * folder (docs/claude-client.md, "Further logins").
 */
export type AccountBinding =
  | { via: "pi-runtime"; authPath: string; modelsPath: string }
  | { via: "default-login" }
  | { via: "config-dir"; configDir: string };

/**
 * A further Claude login's own Claude Code config folder, inside its store
 * directory (`AccountRef.ownLogin`). The first login's store never has it.
 */
export function claudeLoginFolder(storeDir: string): string {
  return join(storeDir, "claude");
}

export type AccountStatus = {
  connected: boolean;
  authType?: "oauth" | "api_key";
  /**
   * Harness-reported identity for the label suggestion and the account line,
   * when the backend has one. Claude reports an email address and a plan;
   * Pi reports a Copilot account's GitHub username, read when it signs in.
   */
  identity?: { label?: string; plan?: string };
  /** Where a Claude account's access comes from, when not a subscription (CredentialHealth). */
  access?: ClaudeAccessSource;
  /** Who set the address a Claude subscription's requests go to (CredentialHealth). */
  gateway?: ClaudeAccessSource;
  /**
   * Why connectedness could not be confirmed by the client's own status
   * read. Present only when this is not a positive client determination.
   * `{ connected: false }` is a genuine sign-out - callers treat it as
   * "sign in again" - so a probe or store that could not be read must not
   * take that shape.
   */
  reason?: string;
  /** The backend's own sentence for `reason`, when it has one (see CredentialHealth). */
  detail?: string;
};

/**
 * One account, named the way a backend needs it: which provider it signs
 * into, the vault's stable id for it, and the isolated store directory the
 * vault created for it. Never a credential.
 */
export type AccountRef = {
  providerId: string;
  accountId: string;
  /** The account's isolated store directory (already created, 0700). */
  dir: string;
  /**
   * A further Claude login, signed in inside its own folder in `dir`
   * (`claudeLoginFolder`) rather than standing on the computer's default
   * login. The vault's record says so; absent for every other account.
   */
  ownLogin?: boolean;
};

/** What signing an account out did to the login its vendor's client keeps for the whole macOS user. */
export type LogoutOutcome = { login: MachineLoginOutcome };

export type AccountLoginRequest = AccountRef & {
  type: "oauth" | "api_key";
  bridge: AuthInteractionBridge;
  /**
   * The GitHub Enterprise host a Copilot sign-in goes to, as the person
   * chose it; absent is github.com, or the host the account signed in to
   * before (INF-838). Other providers ignore it.
   */
  enterpriseHost?: string;
  /**
   * The account already exists and signs in again (`AccountVault.signIn`):
   * the login its store holds is the one the provider refused or that went
   * away, so the provider's own login runs rather than that login being
   * used once more. Absent on a first connect (`AccountVault.add`).
   */
  again?: boolean;
  /** Other stores of this provider, for sign-ins that replace a shared local identity. */
  relatedAccounts?: readonly AccountRef[];
  onRelatedRechecked?: (accountId: string) => Promise<void>;
};

export interface AccountBackend {
  readonly id: BackendId;
  /**
   * An account added beside this backend's first signs in inside a folder of
   * its own (`AccountRef.ownLogin`). Without it the vault refuses a second
   * account where the provider stands on one login for the whole computer.
   */
  readonly furtherLogins?: boolean;
  /**
   * Auth methods this backend offers for a provider, for the connect UI.
   * The renderer speaks only of subscriptions and keys - never of harnesses.
   */
  authTypes(providerId: string): ("oauth" | "api_key")[];
  /**
   * Why `authTypes` is empty right now, when the backend can say and the
   * provider should still be listed (disabled, with the words): the client
   * the person has to install, in the one sentence a chip shows. A backend
   * with nothing to say is simply not listed.
   */
  unavailable?(providerId: string): { note: string; detail: string } | undefined;
  /** Run the harness's own login INTO the account's store. */
  login(request: AccountLoginRequest): Promise<void>;
  /**
   * Best-effort upstream revocation; the vault's deletion is the guarantee.
   * A backend whose account stands on a login its vendor's client keeps for
   * the whole macOS user says what became of that login.
   */
  logout(account: AccountRef): Promise<LogoutOutcome | undefined>;
  /**
   * Richer than `connected: boolean`; `unknown` is a state, not a false.
   * `status()` is a projection of this so the vault's connected badge
   * keeps working.
   */
  health(account: AccountRef): Promise<CredentialHealth>;
  /**
   * Give Claude's delegated renewal a home and let Pi declare that resolve
   * is renewal; a backend with no renewal answers `unsupported` (spec §11.3).
   * Never a secret: a caller that needs the fresh credential re-resolves.
   */
  renew(account: AccountRef, reason: RenewReason): Promise<RenewalOutcome>;
  status(account: AccountRef): Promise<AccountStatus>;
  /** Locations for direct injection at spawn. Never a secret. */
  binding(account: AccountRef): AccountBinding;
  /**
   * Drop any cached handle on an account's store, so a removed account
   * leaves nothing behind that could still reach it.
   */
  forget?(accountId: string): void;
  /**
   * Resolves once any in-flight work against the account's store has
   * settled. An aborted login rejects while its runtime creation is still
   * running, and that work re-creates store files - so the vault sweeps the
   * store again after this resolves, and cleanup cannot be undone.
   */
  settled?(accountId: string): Promise<void>;
}

/** `status()` is this projection so existing connected-badge callers keep working. */
export function statusFromHealth(health: CredentialHealth): AccountStatus {
  if (health.state === "unsigned") return { connected: false };
  if (health.state === "needs_reauth") {
    return {
      connected: false,
      reason:
        health.reason === REFRESH_TOKEN_LAPSED || health.reason === undefined
          ? "unrenewable"
          : health.reason,
    };
  }
  return {
    connected: true,
    ...(health.authType ? { authType: health.authType } : {}),
    ...(health.identity ? { identity: health.identity } : {}),
    ...(health.access ? { access: health.access } : {}),
    ...(health.gateway ? { gateway: health.gateway } : {}),
    ...(health.reason ? { reason: health.reason } : {}),
    ...(health.detail ? { detail: health.detail } : {}),
  };
}
