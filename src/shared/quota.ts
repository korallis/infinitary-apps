import { z } from "zod";
import { formatUsd } from "./i18n/format";

export {
  AUTO_ROUTABLE_BUCKETS,
  AUTO_ROUTABLE_SLOTS,
  type IntelligenceBucket,
  intelligenceBucketSchema,
  isAutoRoutableBucket,
  isAutoRoutableSlot,
  PREMIUM_BUCKET,
  PREMIUM_SLOT,
  SLOTS,
  type Slot,
  slotSchema,
} from "./modelSlots";

/**
 * When an allowance comes back, in the words every reader shows it: the
 * time on the same day ("resets 1:10pm"), else the day ("resets Fri"). The
 * one formatter, shared by the usage readings the core builds and the
 * waiting line a card thread derives (docs/card-threads.md).
 */
/** A moment's local time of day the way the allowance words write it: "6pm", "2:30pm". */
export function clockTime(at: number): string {
  const date = new Date(at);
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const hour12 = hours % 12 || 12;
  const suffix = hours < 12 ? "am" : "pm";
  return minutes === 0
    ? `${hour12}${suffix}`
    : `${hour12}:${String(minutes).padStart(2, "0")}${suffix}`;
}

export function formatResetText(resetsAtMs: number, now: number): string | undefined {
  if (!Number.isFinite(resetsAtMs)) return undefined;
  const reset = new Date(resetsAtMs);
  const nowDate = new Date(now);
  if (reset.toDateString() === nowDate.toDateString()) return `resets ${clockTime(resetsAtMs)}`;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
  return `resets ${days[reset.getDay()]}`;
}

export function formatBedrockSpend(cost: number | null, partial: boolean): string {
  return cost === null
    ? "Billed by use on your AWS account. No estimate for this month yet."
    : `Billed by use on your AWS account. About ${formatUsd(cost, 2)} this month (${partial ? "partial estimate" : "estimate"}).`;
}

/**
 * Quota views (decision D-7): percent remaining, pace, and resets with
 * visible staleness and no live-accuracy guarantee. Filled from Infinitary's
 * own provider fetches using managed keys.
 */

export const quotaWindowViewSchema = z.object({
  id: z.string(),
  label: z.string(),
  percentRemaining: z.number().optional(),
  /**
   * Pace vocabulary: "ahead" is usage ahead of the reset
   * clock (burning faster than linear - conserve), "behind" is usage behind
   * the clock (allowance on track to go unused).
   */
  pace: z.enum(["ahead", "on_pace", "behind", "unknown"]).optional(),
  resetText: z.string().optional(),
  /**
   * The trusted cycle evidence: the window's own reset
   * instant and cycle length, when the vendor supplied them. Everything
   * derived - pace, runway, spend priority - is recomputed from these at
   * read time rather than persisted, so a stored snapshot never carries a
   * stale projection.
   */
  resetsAtMs: z.number().optional(),
  startsAtMs: z.number().optional(),
  windowSeconds: z.number().optional(),
});
export type QuotaWindowView = z.infer<typeof quotaWindowViewSchema>;

/**
 * What the provider says about paying past the plan allowance (INF-4104
 * piece 1, docs/quota.md "Credits past the allowance"): Claude's extra
 * usage, ChatGPT's Codex credits, Copilot's paid premium requests. A fact
 * beside the windows, never a window: it never bounds or raises a plan
 * window, and Infinitary neither buys credits nor sets their limit.
 * - `available` the provider will answer past the allowance on credits,
 * - `spent` the credits ran out, or their spend limit was reached,
 * - `off` the account has credits switched off or has none,
 * - `unknown` the provider said something this build cannot place.
 * No `credits` at all is also unknown, never `off`.
 */
export const QUOTA_CREDIT_STATES = ["available", "spent", "off", "unknown"] as const;
export type QuotaCreditState = (typeof QUOTA_CREDIT_STATES)[number];

export const quotaCreditsViewSchema = z.object({
  state: z.enum(QUOTA_CREDIT_STATES),
  /** The share of a monthly spend limit used, 0–100, where the provider gives one (Claude). */
  usedPercent: z.number().optional(),
  /** The balance left, in the provider's own words (ChatGPT's "15.00"). */
  balance: z.string().optional(),
  /** The provider says the credits have no limit. */
  unlimited: z.boolean().optional(),
  /** The provider says this account is answering on credits right now. */
  inUse: z.boolean().optional(),
});
export type QuotaCreditsView = z.infer<typeof quotaCreditsViewSchema>;

/**
 * Saved resets (docs/quota.md "Saved resets"): one-time resets of a plan's
 * allowance the provider keeps on the account until they are used or
 * expire, read from ChatGPT's Codex usage reading
 * (`rate_limit_reset_credits`). A fact beside the windows, never a window:
 * Infinitary uses one only on the captain's Use a saved reset, through Codex
 * (docs/codex-client.md), and routing reads nothing from it.
 * - `available` how many the account holds,
 * - `applicable` how many would take effect right now; absent is unknown.
 * No `savedResets` at all is unknown too, never zero.
 */
export const quotaSavedResetsViewSchema = z.object({
  available: z.number().int().nonnegative(),
  applicable: z.number().int().nonnegative().optional(),
});
export type QuotaSavedResetsView = z.infer<typeof quotaSavedResetsViewSchema>;

/**
 * Where a person uses a saved reset, for each provider whose reading says
 * them: the provider's own usage page, the address its own client points to.
 */
export const SAVED_RESETS_PAGE: Readonly<Record<string, string>> = {
  codex: "https://chatgpt.com/settings/usage",
};

export function savedResetsNow(
  row: Pick<QuotaProviderView, "provider" | "savedResets"> | undefined,
): number | undefined {
  if (!row || !SAVED_RESETS_PAGE[row.provider]) return undefined;
  const applicable = row.savedResets?.applicable;
  return applicable !== undefined && applicable > 0 ? applicable : undefined;
}

/**
 * The quota providers whose accounts offer the Keep going on credits switch
 * (INF-4104 piece 2, docs/quota.md "Keep going on credits"): Claude's extra
 * usage and ChatGPT's Codex credits. Copilot waits until its refusal can be
 * read.
 */
export const CREDITS_SWITCH_PROVIDERS: readonly string[] = ["claude", "codex"];

/**
 * What a run-out card offers of an account's credits: the provider is one
 * with the switch and says its credits are available. Undefined offers none.
 */
export function creditsOfferOf(
  row: Pick<QuotaProviderView, "provider" | "credits" | "pool"> | undefined,
): { usedPercent?: number; balance?: string } | undefined {
  // A proxy's pool keeps its credits with the proxy: Infinitary never turns them on.
  if (!row || row.pool || !CREDITS_SWITCH_PROVIDERS.includes(row.provider)) return undefined;
  if (row.credits?.state !== "available") return undefined;
  return {
    ...(row.credits.usedPercent !== undefined ? { usedPercent: row.credits.usedPercent } : {}),
    ...(row.credits.balance !== undefined ? { balance: row.credits.balance } : {}),
  };
}

/**
 * Whether an account answers on credits once its allowance is spent: its
 * Keep going on credits switch is on, and the provider has not said the
 * credits are off or spent. Unknown is never off. The one predicate routing,
 * the account pick, the first mate's pause and the quota gate read.
 */
export function answersOnCredits(
  row: Pick<QuotaProviderView, "provider" | "keepGoingOnCredits" | "credits" | "pool"> | undefined,
): boolean {
  if (!row?.keepGoingOnCredits || row.pool || !CREDITS_SWITCH_PROVIDERS.includes(row.provider))
    return false;
  return row.credits?.state !== "off" && row.credits?.state !== "spent";
}

/**
 * The pools a CLI proxy's logins fold into (docs/quota.md, "A proxy's
 * pooled logins"): every Claude login it holds is one allowance, and every
 * ChatGPT login another.
 */
export const QUOTA_POOL_KINDS = ["claude", "chatgpt"] as const;
export type QuotaPoolKind = (typeof QUOTA_POOL_KINDS)[number];

/** Each pool's name on its row. */
// i18n-exempt: product names, the same in every language
export const QUOTA_POOL_NAMES: Record<QuotaPoolKind, string> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
};

/**
 * How a pooled row's logins stand, beside its pooled windows: each count is
 * a number of the proxy's logins of that pool. Unread, switched-off and
 * sign-in-ended logins are counted here and never weigh in the windows as
 * zero; a spent login weighs as zero until `backAtMs`.
 */
export const quotaPoolViewSchema = z.object({
  kind: z.enum(QUOTA_POOL_KINDS),
  logins: z.number().int().nonnegative(),
  /** Serving logins whose limits were read: they make the pooled windows. */
  read: z.number().int().nonnegative(),
  /** Serving logins nothing has read yet. */
  unread: z.number().int().nonnegative(),
  /** Logins whose allowance is spent until they come back. */
  spent: z.number().int().nonnegative(),
  /** The earliest moment a spent login serves again. */
  backAtMs: z.number().optional(),
  /** Logins switched off in the proxy. */
  switchedOff: z.number().int().nonnegative(),
  /** Logins whose sign-in ended in the proxy: they cannot serve. */
  signInEnded: z.number().int().nonnegative(),
  /** Serving logins the proxy says need signing in again there. */
  signInSoon: z.number().int().nonnegative(),
  /** The earliest moment one of those stops serving. */
  signInByMs: z.number().optional(),
  /**
   * The connection's models this pool serves, on a custom connection's row:
   * the row measures those models alone (`rowMeasuresModel`). Absent on a
   * Claude account's row, which measures every model of its account.
   */
  models: z.array(z.string()).optional(),
});
export type QuotaPoolView = z.infer<typeof quotaPoolViewSchema>;

/** The provider whose credits words a pool's credits are read in. */
export const POOL_CREDITS_PROVIDER: Record<QuotaPoolKind, string> = {
  claude: "claude",
  chatgpt: "codex",
};

/**
 * Whether `row` measures model `modelId`: a custom connection's pool row
 * measures only the models its pool serves; every other row measures every
 * model of its account. Routing, the account pick, a computer's pool, the
 * first mate's pause and the reset gate all read a model's row by this one
 * rule (docs/quota.md, "A proxy's pooled logins").
 */
export function rowMeasuresModel(
  row: Pick<QuotaProviderView, "pool">,
  modelId: string | undefined,
): boolean {
  const models = row.pool?.models;
  if (!models) return true;
  return modelId !== undefined && models.includes(modelId);
}

/**
 * The row measuring `modelId` on account `accountId`. Without a model, an
 * account with several pools has no one row: none is chosen for it.
 */
export function quotaRowOf<Row extends Pick<QuotaProviderView, "accountId" | "pool">>(
  rows: readonly Row[] | undefined,
  accountId: string,
  modelId?: string,
): Row | undefined {
  const own = (rows ?? []).filter((row) => row.accountId === accountId);
  if (!own.some((row) => row.pool?.models)) return own[0];
  if (modelId !== undefined) return own.find((row) => rowMeasuresModel(row, modelId));
  const pooled = own.filter((row) => row.pool?.models);
  return pooled.length === 1 ? pooled[0] : undefined;
}

export const quotaProviderViewSchema = z.object({
  /** Quota provider id: codex, grok, claude, copilot. */
  provider: z.string(),
  label: z.string(),
  /**
   * The vault account these windows belong to (broker phase 2). Absent only
   * in legacy fixtures/snapshots, which render as a single unnamed account.
   */
  accountId: z.string().optional(),
  /** The account's user label ("Personal", "Work #2"). */
  accountLabel: z.string().optional(),
  plan: z.string().optional(),
  /** Provider-reported identity (an email or org), when the fetch knows it. */
  account: z.string().optional(),
  /**
   * What the sensor actually established, kept distinct so the surface can
   * say it (quota reliability, 2026-09-04):
   * - `ok` a real reading,
   * - `auth_required` the terminal re-auth state (CD-3): reached only from
   *   proof - a lapsed refresh token (`refresh_token_lapsed`) or a vendor
   *   rejection that SURVIVED a real renewal (`rejected_after_renewal`).
   *   The ONLY status that may say "sign in again", raise the re-auth card,
   *   or clear a recovered card. Transient failures never take this shape,
   * - `rate_limited` the vendor asked us to back off (`retryAfter` when given),
   * - `unavailable` we could not find out this time (network, timeout, a
   *   non-2xx, an unreadable store, a renewal that could not run). Transient
   *   by assumption; last-known-good survives it,
   * - `not_measured` Infinitary does not read a usage window for this sign-in.
   *   NOT a claim that the credential cannot expose one,
   * - `skipped` the account was not sensed on this pass.
   * `error` remains only so older persisted snapshots still parse.
   */
  status: z.enum([
    "ok",
    "auth_required",
    "rate_limited",
    "unavailable",
    "not_measured",
    "error",
    "skipped",
  ]),
  stale: z.boolean(),
  /**
   * When these windows were actually measured. Present whenever a row is
   * carried forward, so a stale card can state its age instead of borrowing
   * the new snapshot's fetch time.
   */
  measuredAt: z.number().optional(),
  /**
   * A sanitized machine reason for a non-ok status: a code from our own
   * vocabulary, never provider text, never a header, never a URL.
   */
  reason: z.string().optional(),
  /** RFC 9110 Retry-After, as the vendor sent it, when it sent one. */
  retryAfter: z.string().optional(),
  windows: z.array(quotaWindowViewSchema),
  /** Paying past the allowance, as the provider reports it (`quotaCreditsViewSchema`). */
  credits: quotaCreditsViewSchema.optional(),
  savedResets: quotaSavedResetsViewSchema.optional(),
  /**
   * The account's Keep going on credits switch is on, as the vault holds it
   * (`answersOnCredits`). Absent is off.
   */
  keepGoingOnCredits: z.boolean().optional(),
  /**
   * The row is a CLI proxy's pool of logins (`quotaPoolViewSchema`): its
   * windows are the pooled share left, and the logins' standing rides here.
   * The proxy's own sign-ins never make the row `auth_required`.
   */
  pool: quotaPoolViewSchema.optional(),
  /**
   * The row reads a CLI proxy, whether or not the proxy answered: a reading
   * it could not refresh keeps only the proxy's own last reading of the same
   * pool, never another source's (`mergeStaleProviders`).
   */
  fromProxy: z.literal(true).optional(),
  /**
   * Disclosed uncertainty, in the user's words, for a row with no window.
   * The surface renders it instead of a silent blank, and it is never a
   * substitute for a real window. It says what Infinitary did or did not do -
   * never that a credential is incapable of exposing usage, which no test
   * here has established.
   */
  detail: z.string().optional(),
});
export type QuotaProviderView = z.infer<typeof quotaProviderViewSchema>;

/**
 * Why a Claude Keychain VALUE read failed. Machine vocabulary for `reason`;
 * the user-facing `detail` is KEYCHAIN_VALUE_FAILURE_DETAIL. Never rendered
 * as "Keychain" - that word is machinery; the person's word is "saved
 * passwords", and the credential inside is "your sign-in" (the vocabulary).
 *
 * Captain decision D-3 / Option B (2026-09-09): a declined or failed value
 * read is a visible, retryable meter failure, never a process-lifetime poison.
 */
export const KEYCHAIN_VALUE_FAILURES = [
  "keychain_locked",
  "keychain_access_denied",
  "keychain_prompt_timeout",
  "keychain_unavailable",
  "keychain_unreadable",
  "keychain_needs_grant",
  "keychain_no_interactive_session",
  "keychain_read_incomplete",
] as const;
/**
 * The status the host reports when a read through Apple's tool ran out of
 * time or failed: not an OSStatus, and not a refusal. The read is simply tried
 * again on the next refresh.
 */
export const KEYCHAIN_READ_INCOMPLETE_CODE = -1;
export type KeychainValueFailure = (typeof KEYCHAIN_VALUE_FAILURES)[number];

/**
 * "Always Allow" is the whole difference between asking once and asking every
 * time: it writes the app into the item's access list, and every later read is
 * silent. Say the words the macOS dialog uses, on every failure a grant fixes -
 * and only there: a locked store is not a missing grant, no "Always Allow"
 * appears for it, and Retry asks macOS to unlock it with the person's password.
 */
export const KEYCHAIN_VALUE_FAILURE_DETAIL: Record<KeychainValueFailure, string> = {
  keychain_locked:
    "macOS has locked your saved passwords. Retry, then enter your password to unlock them.",
  keychain_access_denied:
    "macOS didn't allow reading your sign-in. Retry, then choose Always Allow so it only asks once.",
  keychain_prompt_timeout:
    "The permission prompt timed out. Retry, then choose Always Allow so it only asks once.",
  keychain_unavailable: "This account's sign-in couldn't be read. Retry to try again.",
  keychain_unreadable: "This account's sign-in couldn't be read. Retry to try again.",
  keychain_needs_grant:
    "macOS needs your permission to read your sign-in. Retry, then choose Always Allow so it only asks once.",
  keychain_no_interactive_session:
    "Infinitary was started where macOS can't ask for your saved passwords. Relaunch it from the Dock, then Retry and allow the read.",
  keychain_read_incomplete:
    "Reading your sign-in didn't finish this time. Infinitary tries again on the next refresh.",
};

const ASKS_THERE =
  "Infinitary can't read this allowance there: macOS asks before it may read your sign-in, and nobody may be at that screen to answer.";
const UNREADABLE_THERE =
  "Your sign-in there couldn't be read. Infinitary tries again in a few minutes.";

/**
 * The same failures on a computer that runs work, drawn at the home in that
 * computer's group (docs/helper.md, "Its own sign-ins"). That computer never
 * lets macOS ask - nobody may be at its screen to answer - so there is no
 * Retry and no Always Allow to choose: each says why the allowance is not
 * read there, and the computer reads again on its own clock.
 */
export const KEYCHAIN_VALUE_FAILURE_THERE: Record<KeychainValueFailure, string> = {
  keychain_locked:
    "macOS has locked the saved passwords there. Infinitary reads this allowance again once they are unlocked.",
  keychain_access_denied:
    "macOS there didn't let Infinitary read your sign-in, so this allowance isn't read.",
  keychain_prompt_timeout: ASKS_THERE,
  keychain_unavailable: UNREADABLE_THERE,
  keychain_unreadable: UNREADABLE_THERE,
  keychain_needs_grant: ASKS_THERE,
  keychain_no_interactive_session: ASKS_THERE,
  keychain_read_incomplete: UNREADABLE_THERE,
};

export function isKeychainValueFailure(reason: string | undefined): reason is KeychainValueFailure {
  return reason !== undefined && (KEYCHAIN_VALUE_FAILURES as readonly string[]).includes(reason);
}

export const quotaSnapshotViewSchema = z.object({
  generatedAt: z.string(),
  fetchedAt: z.number(),
  providers: z.array(quotaProviderViewSchema),
});
export type QuotaSnapshotView = z.infer<typeof quotaSnapshotViewSchema>;

/**
 * Slot names still ride routing_decisions.bucket, difficulty, and quota-gate
 * refs. The catalog itself no longer stamps a per-model intelligence tier;
 * the user's slot record supplies that (src/shared/modelSlots.ts).
 */
export const catalogModelViewSchema = z.object({
  /** Quota provider id. */
  provider: z.string(),
  id: z.string(),
  label: z.string(),
  effectivePercentRemaining: z.number().optional(),
  paceStatus: z.enum(["ahead", "on_pace", "behind", "unknown"]).optional(),
  /**
   * The per-scope selection signal: positive means paid
   * allowance is on track to reach reset unused (spend here first), zero is
   * exact utilization, negative is overdrawn against the reset clock.
   * Absent means unmeasurable - never rendered or ranked as zero.
   */
  spendPriority: z.number().optional(),
  /**
   * Whether every window bounding this scope is projected, at its observed
   * burn, to last until its reset (INF-898): true lasts, false runs out
   * first (or is spent). Absent means the runway is unknown.
   */
  lastsThroughReset: z.boolean().optional(),
  /**
   * Every allowance serving this model is spent, and an account serving it
   * answers on credits (`answersOnCredits`): the model still routes, in the
   * last band, after every included allowance. Absent is not on credits.
   */
  onCredits: z.boolean().optional(),
});
export type CatalogModelView = z.infer<typeof catalogModelViewSchema>;

/**
 * Models in spend-priority order for routing (highest reclaimable allowance
 * first), with remaining-quota runway order as
 * the fallback among models whose signal is unmeasurable.
 */
export const modelsCatalogViewSchema = z.object({
  generatedAt: z.string(),
  models: z.array(catalogModelViewSchema),
});
export type ModelsCatalogView = z.infer<typeof modelsCatalogViewSchema>;

export const modelPinSchema = z.object({ provider: z.string(), id: z.string() });
export type ModelPin = z.infer<typeof modelPinSchema>;

/** A Pi provider/model pair, as Pi resolves it (not quota provider ids). */
export const piModelRefViewSchema = z.object({ provider: z.string(), id: z.string() });
export type PiModelRefView = z.infer<typeof piModelRefViewSchema>;

export const routingSettingsSchema = z.object({
  // Kept on the wire for older paired views; the home always reports true.
  dynamicRouting: z.boolean(),
  pins: z.array(modelPinSchema),
  dormantPins: z.array(modelPinSchema).optional(),
});
export type RoutingSettings = z.infer<typeof routingSettingsSchema>;

/**
 * Quota provider ids to provider ids: routing needs both worlds (slots and
 * runway come from quota fetches, availability and sessions from the account's
 * own backend). Claude is here too - a broker-managed subscription with its
 * own backend, even though Pi never serves it. Read it only through the
 * functions below.
 */
export const QUOTA_TO_PI_PROVIDER: Readonly<Record<string, string>> = {
  codex: "openai-codex",
  grok: "xai",
  claude: "anthropic-claude",
  kimi: "kimi-coding",
  copilot: "github-copilot",
};

/**
 * The provider id a served model carries for one the allowance catalog or a
 * pin names (`claude` is `anthropic-claude`, `codex` is `openai-codex`,
 * `grok` is `xai`, `copilot` is `github-copilot`); any other id, a served one included, is its own. A place
 * that forgets this drops every Claude, Codex and Grok model without a word
 * (FI3-1783), so the translation lives here alone.
 */
export function servedProviderOf(provider: string): string {
  return isAllowanceProvider(provider) ? (QUOTA_TO_PI_PROVIDER[provider] ?? provider) : provider;
}

export function isAllowanceProvider(provider: string): boolean {
  return Object.hasOwn(QUOTA_TO_PI_PROVIDER, provider);
}

/**
 * The allowance catalog's provider id for a served one (`anthropic-claude`
 * is `claude`); undefined for a provider whose allowance nobody reads
 * (OpenRouter).
 */
export function allowanceProviderOf(provider: string): string | undefined {
  return Object.keys(QUOTA_TO_PI_PROVIDER).find((id) => QUOTA_TO_PI_PROVIDER[id] === provider);
}

/**
 * The `provider/id` key a model is compared by, in served names whichever
 * name it arrives in: every comparison between an allowance catalog row or
 * a pin and a served model goes through this, on both sides.
 */
export function servedModelKey(model: { provider: string; id: string }): `${string}/${string}` {
  return `${servedProviderOf(model.provider)}/${model.id}`;
}

/**
 * Restore, as Settings → Intelligence and the first mate's model-pins restore
 * write it: the saved (dormant) pins go back after the current ones, each
 * once, and nothing stays saved.
 */
export function restoredPins(routing: RoutingSettings): RoutingSettings {
  const kept = new Set(routing.pins.map(servedModelKey));
  const back = [
    ...new Map((routing.dormantPins ?? []).map((pin) => [servedModelKey(pin), pin])).values(),
  ];
  return {
    ...routing,
    pins: [...routing.pins, ...back.filter((pin) => !kept.has(servedModelKey(pin)))],
    dormantPins: [],
  };
}

/**
 * Whether Infinitary reads an allowance for this provider id. Sensed providers
 * (Codex, Grok, Claude, Kimi Code, Copilot) get a pending "reading…" row until the first
 * sensor pass lands; everyone else (OpenRouter today) keeps the no-reader
 * sentence. Matches the sensor's own catalog (`QUOTA_PROVIDERS` in core).
 */
export function isSensedProvider(providerId: string): boolean {
  return allowanceProviderOf(providerId) !== undefined;
}
