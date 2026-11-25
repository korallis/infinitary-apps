import { CLAUDE_ACCESS_ALLOWANCE_TEXT, type ClaudeAccessSource } from "@shared/claudeAccess";
import {
  KEYCHAIN_VALUE_FAILURE_DETAIL,
  type KeychainValueFailure,
  type QuotaCreditsView,
  type QuotaPoolView,
  type QuotaSavedResetsView,
  type QuotaWindowView,
} from "@shared/quota";
import { isAuthFailure, isRateLimited, isSuccess, type QuotaResponse } from "./http";

/**
 * What one provider fetch established. Every distinction the surface is
 * allowed to draw is made here and nowhere else, so a timeout can never again
 * be reported as the same thing as a rate limit.
 */
export type ProviderOutcome = {
  status: "ok" | "auth_required" | "rate_limited" | "unavailable" | "not_measured";
  windows: QuotaWindowView[];
  /** Paying past the allowance, when the reading says it. */
  credits?: QuotaCreditsView;
  savedResets?: QuotaSavedResetsView;
  /** A CLI proxy's pool of logins the windows were pooled from. */
  pool?: QuotaPoolView;
  /** The reading is a CLI proxy's, whether or not it answered. */
  fromProxy?: true;
  plan?: string;
  account?: string;
  /** User-facing disclosure for a row with no window. */
  detail?: string;
  /** Sanitized machine reason: our own vocabulary, never vendor text. */
  reason?: string;
  retryAfter?: string;
};

/** No credential could be resolved: nothing was asked of the vendor. */
export const CREDENTIAL_UNAVAILABLE: ProviderOutcome = {
  status: "unavailable",
  windows: [],
  reason: "credential_unavailable",
};

/** Why a Claude account on access set up for Claude Code is not measured. */
export const CLAUDE_ACCESS_REASON = "claude_access";

/**
 * A Claude account on access an organization or the person set up for
 * Claude Code: the limits are the gateway's, and Infinitary reads none of
 * them. Not measured, never a zero, and never a sign-in to redo.
 */
export function claudeAccessOutcome(source: ClaudeAccessSource): ProviderOutcome {
  return {
    status: "not_measured",
    windows: [],
    reason: CLAUDE_ACCESS_REASON,
    detail: CLAUDE_ACCESS_ALLOWANCE_TEXT[source],
  };
}

/**
 * The Claude Keychain VALUE read was declined, denied, timed out, or
 * otherwise failed. A real failure: no windows, a named reason, and a
 * user-facing detail the meter can retry from. Never a fabricated reading.
 * A computer that runs work says it in its own words (`details`), since
 * nothing there can be retried by asking.
 */
export function keychainFailureOutcome(
  reason: KeychainValueFailure,
  details: Record<KeychainValueFailure, string> = KEYCHAIN_VALUE_FAILURE_DETAIL,
): ProviderOutcome {
  return {
    status: "unavailable",
    windows: [],
    reason,
    detail: details[reason],
  };
}

/**
 * Classify a non-2xx response. A 401 is the vendor's verdict on the
 * credential; a 429 is a back-off instruction; everything else - 403 included,
 * because that is also how a network policy refuses - is simply "we could not
 * find out this time".
 */
export function failureFromResponse(result: QuotaResponse): ProviderOutcome {
  if (isAuthFailure(result.status)) {
    return { status: "auth_required", windows: [], reason: "vendor_rejected" };
  }
  if (isRateLimited(result.status)) {
    return {
      status: "rate_limited",
      windows: [],
      reason: "rate_limited",
      ...(result.retryAfter ? { retryAfter: result.retryAfter } : {}),
    };
  }
  return { status: "unavailable", windows: [], reason: `http_${result.status}` };
}

export function succeeded(result: QuotaResponse): boolean {
  return isSuccess(result.status);
}
