import { REFRESH_TOKEN_LAPSED } from "@shared/credentialHealth";
import type {
  ModelsCatalogView,
  QuotaProviderView,
  QuotaSnapshotView,
  QuotaWindowView,
} from "@shared/quota";
import type {
  ManagedAuth,
  QuotaAccountRef,
  QuotaAuth,
  QuotaCatalogModel,
  QuotaRenewal,
  SensedQuotaProviderId,
} from "./auth";
import { buildModelsCatalog } from "./catalog";
import { type QuotaHttp, QuotaTransportError } from "./http";
import { CREDENTIAL_UNAVAILABLE, type ProviderOutcome } from "./outcome";
import { fetchClaudeQuota } from "./providers/claude";
import { fetchCodexQuota } from "./providers/codex";
import { fetchCopilotQuota } from "./providers/copilot";
import { fetchGrokQuota } from "./providers/grok";
import { fetchKimiQuota } from "./providers/kimi";

/** Anthropic's usage service is asked at most this often per account. */
export const CLAUDE_ASK_INTERVAL_MS = 5 * 60 * 1000;
/** After a 429 the next ask waits this long, or the vendor's retry-after if longer. */
export const CLAUDE_RATE_LIMIT_BACKOFF_MS = 10 * 60 * 1000;
/** Timer drift: a tick one interval after the last ask must not be skipped. */
const ASK_SLACK_MS = 2_000;

/** One answer from the usage service, under the login it was asked with. */
type ClaudeAsk = { at: number; nextAskAt: number; view: QuotaProviderView; login?: string };

export type QuotaFetchResult = {
  snapshot: QuotaSnapshotView;
  catalog: ModelsCatalogView;
};

export type QuotaFetcherOptions = {
  auth: QuotaAuth;
  http: QuotaHttp;
  models: () => QuotaCatalogModel[];
  /**
   * Account rows whose quota arrives on their own sessions rather than from
   * a sensor call (account-broker phase 7). They are merged into the same
   * snapshot so a row looks the same however it was measured.
   */
  pushed?: (now: number) => QuotaProviderView[];
  /**
   * What the account's own sessions said about a sensed row, laid over the
   * sensor's reading (a pushed refusal, `withRejectedReadings`).
   */
  overlay?: (view: QuotaProviderView, now: number) => QuotaProviderView;
  now?: () => number;
  /**
   * Endpoint overrides, for exercising the real sensor against a local stub.
   * Dev and e2e only: the stand-in reads (`standIns.ts`) refuse them in a
   * packaged app, the same gate the fixture seam already has.
   */
  endpoints?: {
    claudeUsageUrl?: string;
    grokUsageUrl?: string;
    grokKeyUrl?: string;
    kimiUsageUrl?: string;
    copilotUsageUrl?: string;
  };
  /**
   * The vendor just accepted this account's credential: a fresh allowance
   * reading came back ok. A cached answer is not a fresh acceptance, so a
   * throttled Claude row does not call this. `windows` is the sensor's own
   * reading, before any refusal is laid over it.
   */
  onAccepted?: (accountId: string, windows: QuotaWindowView[]) => void;
  /**
   * The login the account's store names now (`AccountVault.loginSync`): an
   * answer asked under another login is not this account's any more, so it
   * is never served from the ledger, and one that lands after the login
   * changed is dropped (docs/quota.md "A changed login").
   */
  loginOf?: (accountId: string) => string | undefined;
};

/**
 * The per-account quota sensor (broker phase 2): the provider fetchers are
 * unchanged - they take one ManagedAuth and return one outcome - but they run
 * once per enabled vault account instead of once per provider. Each account's
 * credential resolves from its own store; a failure on one account never
 * hides a sibling.
 */
export function createQuotaFetcher(
  options: QuotaFetcherOptions,
): (reason?: string) => Promise<QuotaFetchResult> {
  const now = options.now ?? (() => Date.now());
  // What Claude's usage service last answered, per account. Window focus,
  // resume and the interval share this one ledger, so extra refreshes between
  // asks serve the last answer instead of spending the vendor's rate limit.
  const claudeAsks = new Map<string, ClaudeAsk>();
  return async (reason = "interval") => {
    const fetchedAt = now();
    const generatedAt = new Date(fetchedAt).toISOString();
    const allowPrompt = reason === "demand";
    const providers = await Promise.all(
      options.auth.accounts().map((account) =>
        fetchOneAccount(account, options, fetchedAt, allowPrompt, claudeAsks)
          .catch(
            (): QuotaProviderView => ({
              provider: account.quotaId,
              label: account.providerLabel,
              accountId: account.accountId,
              accountLabel: account.accountLabel,
              status: "unavailable",
              reason: "sensor_error",
              stale: false,
              windows: [],
            }),
          )
          .then((view) => options.overlay?.(view, fetchedAt) ?? view),
      ),
    );
    const snapshot: QuotaSnapshotView = {
      generatedAt,
      fetchedAt,
      providers: [...providers, ...(options.pushed?.(fetchedAt) ?? [])],
    };
    const catalog = buildModelsCatalog(options.models(), snapshot.providers, generatedAt);
    return { snapshot, catalog };
  };
}

/**
 * `fetchQuota`'s `auth.renew` is one caller of `AccountBackend.renew`
 * (the reactive 401 path). Non-Claude proactive renew at expiresAt-lead
 * rides the supervisor tick via `CredentialHealthService`; Claude sessions
 * renew themselves and only an idle rejection asks their client once.
 *
 * Everything a renewal can honestly report stays distinct. A renewal that ran
 * and changed nothing, one that could not run, and one that stood down for a
 * live session are all "we could not find out this time" - never "sign in
 * again". Only a rejection that SURVIVES a real renewal is that.
 */
async function fetchOneAccount(
  account: QuotaAccountRef,
  options: QuotaFetcherOptions,
  now: number,
  allowPrompt: boolean,
  claudeAsks: Map<string, ClaudeAsk>,
): Promise<QuotaProviderView> {
  const { auth } = options;
  const throttled = account.quotaId === "claude";
  const base = {
    provider: account.quotaId,
    label: account.providerLabel,
    accountId: account.accountId,
    accountLabel: account.accountLabel,
    stale: false as const,
  };
  const view = (outcome: ProviderOutcome): QuotaProviderView => ({
    ...base,
    status: outcome.status,
    windows: outcome.windows,
    ...(outcome.windows.length > 0 ? { measuredAt: now } : {}),
    ...(outcome.credits ? { credits: outcome.credits } : {}),
    ...(outcome.savedResets ? { savedResets: outcome.savedResets } : {}),
    ...(outcome.pool ? { pool: outcome.pool } : {}),
    ...(outcome.plan ? { plan: outcome.plan } : {}),
    ...(outcome.account ? { account: outcome.account } : {}),
    ...(outcome.detail ? { detail: outcome.detail } : {}),
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    ...(outcome.retryAfter ? { retryAfter: outcome.retryAfter } : {}),
  });

  let managed: ManagedAuth | undefined;
  try {
    managed = await auth.resolve(account.accountId, { allowPrompt });
  } catch {
    managed = undefined;
  }
  if (!managed) return view(auth.unresolved?.(account.accountId) ?? CREDENTIAL_UNAVAILABLE);
  if (managed.account) base.accountLabel = managed.account;

  // Resolve the store before using a cached allowance: the current login
  // comes from that same read, without a separate focus-time scan.
  const login = options.loginOf?.(account.accountId);
  if (throttled) {
    const last = claudeAsks.get(account.accountId);
    // A person's Retry always asks; everything else waits out the interval,
    // unless the login changed since the last answer.
    if (last && last.login === login && !allowPrompt && now < last.nextAskAt - ASK_SLACK_MS)
      return last.view;
  }
  // From here the vendor is asked, so the answer is what the next refreshes serve.
  const answered = (outcome: ProviderOutcome): QuotaProviderView => {
    // The login changed while the vendor was asked: the answer is the old
    // login's, so it is neither kept nor shown as this account's.
    if (options.loginOf && options.loginOf(account.accountId) !== login)
      return { ...base, status: "skipped", windows: [] };
    const result = view(outcome);
    if (throttled) {
      const retryAfterMs = Number(outcome.retryAfter) * 1000;
      const wait =
        outcome.status === "rate_limited"
          ? Math.max(CLAUDE_RATE_LIMIT_BACKOFF_MS, Number.isFinite(retryAfterMs) ? retryAfterMs : 0)
          : CLAUDE_ASK_INTERVAL_MS;
      claudeAsks.set(account.accountId, {
        at: now,
        nextAskAt: now + wait,
        view: result,
        ...(login !== undefined ? { login } : {}),
      });
    }
    if (outcome.status === "ok") options.onAccepted?.(account.accountId, outcome.windows);
    return result;
  };
  const first = await attempt(account, options, managed, now);
  if (first.status !== "auth_required") return answered(first);
  // A provider-refused Pi/Copilot sign-in is already proof. Claude saved
  // dates never produce this reason.
  if (first.reason === REFRESH_TOKEN_LAPSED) return answered(first);
  if (!auth.renew) return answered(first);

  let renewal: QuotaRenewal;
  try {
    renewal = await auth.renew(account.accountId);
  } catch {
    renewal = { outcome: "failed" };
  }
  if (renewal.outcome !== "renewed") {
    // No renewer for this account (Pi after getAuth already refreshed):
    // the vendor 401 stands. A renewal that ran and could not
    // change the store is still "we could not find out this time".
    if (renewal.outcome === "unsupported") return answered(first);
    // A renewal that could not run is not an answer: ask again next refresh.
    return view({ status: "unavailable", windows: [], reason: `renewal_${renewal.outcome}` });
  }
  const second = await attempt(account, options, renewal.auth, now);
  if (second.status === "ok") {
    // The vendor rejected the credential, the account's own client renewed it,
    // and the retry landed. This marker is the ONLY positive trace a renewal
    // leaves: without it an `ok` row after a failure is indistinguishable from
    // plain network recovery, so nobody reading a snapshot could ever confirm
    // that recovery worked - only that it had not. A code, never a credential.
    return answered({ ...second, reason: "renewal_succeeded" });
  }
  if (second.status !== "auth_required") return answered(second);
  // Rejected again, with a credential the account's own client just rewrote.
  // That is the one state that may ask for a sign-in.
  return answered({ ...second, reason: "rejected_after_renewal" });
}

/** One bounded request, with a thrown transport turned into its own reason. */
async function attempt(
  account: QuotaAccountRef,
  options: QuotaFetcherOptions,
  managed: ManagedAuth,
  now: number,
): Promise<ProviderOutcome> {
  try {
    return await dispatch(account.quotaId as SensedQuotaProviderId, options, managed, now);
  } catch (caught) {
    if (caught instanceof QuotaTransportError) {
      return { status: "unavailable", windows: [], reason: caught.failure };
    }
    return { status: "unavailable", windows: [], reason: "sensor_error" };
  }
}

async function dispatch(
  quotaId: SensedQuotaProviderId,
  options: QuotaFetcherOptions,
  auth: ManagedAuth,
  now: number,
): Promise<ProviderOutcome> {
  const http = options.http;
  switch (quotaId) {
    case "codex":
      return fetchCodexQuota(http, auth, now);
    case "grok":
      return fetchGrokQuota(
        http,
        auth,
        now,
        options.endpoints?.grokUsageUrl,
        options.endpoints?.grokKeyUrl,
      );
    case "claude":
      return fetchClaudeQuota(http, auth, now, options.endpoints?.claudeUsageUrl);
    case "kimi":
      return fetchKimiQuota(http, auth, now, options.endpoints?.kimiUsageUrl);
    case "copilot":
      return fetchCopilotQuota(http, auth, now, options.endpoints?.copilotUsageUrl);
  }
}
