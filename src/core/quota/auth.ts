import { type QuotaPoolKind, servedProviderOf } from "@shared/quota";
import type { ProviderOutcome } from "./outcome";

/**
 * Auth the quota sensor needs: Infinitary-managed credentials only, resolved
 * per account through that account's own Pi ModelRuntime.getAuth (which
 * refreshes OAuth inside the account's store). Never ambient machine keys.
 * Re-keyed from providerId to accountId in broker phase 2: each vault
 * account is its own sensor subject.
 */

export type ManagedAuth = {
  apiKey?: string;
  headers?: Record<string, string>;
  baseUrl?: string;
  usingOAuth: boolean;
  /** Current identity carried by the same store read as the credential, when known. */
  account?: string;
};

/** One quota-sensed account: the vault account plus its provider mapping. */
export type QuotaAccountRef = {
  accountId: string;
  /** The account's user label ("Personal", "Work #2"). */
  accountLabel: string;
  quotaId: QuotaProviderId;
  piId: string;
  providerLabel: string;
};

/**
 * What a delegated renewal achieved, reported rather than presumed. A renewal
 * that ran and changed nothing is NOT a sign-out, and neither is one that
 * could not run: only a vendor rejection that SURVIVES an actual renewal is.
 */
export type QuotaRenewal =
  | { outcome: "renewed"; auth: ManagedAuth }
  | {
      outcome:
        | "unchanged"
        | "unreadable"
        | "failed"
        | "deferred_session"
        | "deferred_busy"
        | "no_credential"
        | "unsupported"
        | "withheld";
    };

export type QuotaResolveOptions = {
  /**
   * User-initiated (Settings refresh / the meter's Retry). A Claude
   * Keychain VALUE read may raise the macOS ask. Background ticks omit this.
   */
  allowPrompt?: boolean;
};

export type QuotaAuth = {
  /** Enabled, quota-capable accounts to fetch, one sensor call each. */
  accounts: () => QuotaAccountRef[];
  resolve: (accountId: string, options?: QuotaResolveOptions) => Promise<ManagedAuth | undefined>;
  /**
   * Why `resolve` returned nothing for this account, when it is more specific
   * than an empty store. Claude uses this for a declined Keychain value read
   * so the meter can say so and offer a retry (D-3 / CL-C).
   */
  unresolved?: (accountId: string) => ProviderOutcome | undefined;
  /**
   * Ask this account's own credential owner to renew, called ONLY after the
   * vendor rejected what we sent. Optional: an account whose runtime already
   * refreshes inside `resolve` has nothing left to delegate.
   */
  renew?: (accountId: string) => Promise<QuotaRenewal>;
};

export type QuotaCatalogModel = {
  provider: string;
  id: string;
  name: string;
  /**
   * A custom connection's model a CLI proxy serves from one of its pools:
   * its catalog row reads the connection's row of that pool.
   */
  pool?: QuotaPoolKind;
};

/**
 * Quota view ids (UI/routing) to provider ids. `sensed` providers are polled
 * with a managed credential - Claude included: its plan windows are readable
 * from the vendor's own OAuth usage endpoint with the account's stored
 * credential (src/main/claude/claudeQuota.ts), and session pushes
 * (pushedQuota.ts) merely freshen the same picture mid-turn.
 */
export const QUOTA_PROVIDERS = (
  [
    { quotaId: "codex", label: "Codex", sensed: true },
    { quotaId: "grok", label: "Grok", sensed: true },
    { quotaId: "claude", label: "Claude", sensed: true },
    { quotaId: "kimi", label: "Kimi Code", sensed: true },
    { quotaId: "copilot", label: "Copilot", sensed: true },
  ] as const
).map((entry) => ({ ...entry, piId: servedProviderOf(entry.quotaId) }));

export type QuotaProviderId = (typeof QUOTA_PROVIDERS)[number]["quotaId"];
/** Quota ids the HTTP sensor can actually fetch. */
export type SensedQuotaProviderId = Extract<
  QuotaProviderId,
  "codex" | "grok" | "claude" | "kimi" | "copilot"
>;

export function quotaEntryForPiProvider(
  piId: string,
): (typeof QUOTA_PROVIDERS)[number] | undefined {
  return QUOTA_PROVIDERS.find((entry) => entry.piId === piId);
}
