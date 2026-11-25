import type { QuotaCreditsView, QuotaPoolKind } from "@shared/quota";
import type { PoolLogin, PoolLoginWindow } from "@shared/quotaSignals";
import { asNumber, asRecord, asString, clampPercent } from "../json";
import { claudeWindowLabel } from "../providers/claude";

/**
 * One login of the proxy as Infinitary keeps it (docs/quota.md, "A proxy's
 * pooled logins"): its pool, how it stands, and its last limit reading.
 * Nothing that names the person - email, label, file path, id token - is
 * kept: the reader picks these fields and drops the rest of the entry.
 * `authIndex` and `chatgptAccount` stay in memory only, to ask an unread
 * login once through the proxy (`askUnread`).
 */
export type ProxyLogin = PoolLogin & {
  kind: QuotaPoolKind;
  authIndex?: string;
  chatgptAccount?: string;
};

const POOL_OF_PROVIDER: Record<string, QuotaPoolKind> = { claude: "claude", codex: "chatgpt" };

/**
 * The logins of a `/v8/management/credentials` (or `/v0/management/auth-files`)
 * answer that belong to a pool. An answer that is not that shape reads as no
 * logins, never as spent ones.
 */
export function parseProxyCredentials(body: unknown, nowMs: number): ProxyLogin[] {
  const files = asRecord(body)?.files;
  if (!Array.isArray(files)) return [];
  return files.flatMap((raw) => {
    const entry = asRecord(raw);
    const kind = POOL_OF_PROVIDER[asString(entry?.provider)?.toLowerCase() ?? ""];
    if (!entry || !kind) return [];
    return [loginOf(entry, kind, nowMs)];
  });
}

function loginOf(entry: Record<string, unknown>, kind: QuotaPoolKind, nowMs: number): ProxyLogin {
  const authIndex = asString(entry.auth_index) ?? numberText(entry.auth_index);
  const chatgptAccount =
    kind === "chatgpt" ? asString(asRecord(entry.id_token)?.chatgpt_account_id) : undefined;
  const weight = asNumber(entry.weight);
  const signals = latestSignals(entry);
  const reading = signals
    ? kind === "claude"
      ? claudeReading(signals)
      : codexReading(signals)
    : undefined;
  const base: ProxyLogin = {
    kind,
    state: "serving",
    ...(authIndex ? { authIndex } : {}),
    ...(chatgptAccount ? { chatgptAccount } : {}),
    ...(weight !== undefined && weight > 0 ? { weight } : {}),
    ...(reading && reading.windows.length > 0 ? { windows: reading.windows } : {}),
    ...(reading?.credits ? { credits: reading.credits } : {}),
  };
  if (entry.disabled === true || asString(entry.status) === "disabled")
    return { ...base, state: "switched_off" };
  const expiresAtMs = timeOf(entry.access_token_expires_at);
  // The proxy could not renew the sign-in: past its expiry it serves no
  // more, and before it the login serves until then.
  const renewalFailing =
    entry.requires_sign_in === true || asRecord(entry.refresh_error) !== undefined;
  if (renewalFailing && expiresAtMs !== undefined && expiresAtMs <= nowMs)
    return { ...base, state: "sign_in_ended" };
  const backAtMs = quotaRetryAt(entry, nowMs);
  if (backAtMs !== undefined) return { ...base, state: "spent", backAtMs };
  return {
    ...base,
    ...(entry.requires_sign_in === true && expiresAtMs !== undefined
      ? { signInByMs: expiresAtMs }
      : {}),
  };
}

function numberText(value: unknown): string | undefined {
  const number = asNumber(value);
  return number !== undefined ? String(number) : undefined;
}

function timeOf(value: unknown): number | undefined {
  const text = asString(value);
  if (!text) return undefined;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * When a login whose allowance ran out serves again: the proxy's own
 * cooldown on the whole login for a quota reason, still ahead of now. A
 * cooldown for any other reason, or on one model, is not a spent allowance.
 */
function quotaRetryAt(entry: Record<string, unknown>, nowMs: number): number | undefined {
  const cooldowns = Array.isArray(entry.cooldowns) ? entry.cooldowns : [];
  const times = cooldowns.flatMap((raw) => {
    const cooldown = asRecord(raw);
    if (asString(cooldown?.scope) !== "credential") return [];
    if (!asString(cooldown?.reason)?.includes("quota")) return [];
    const at = timeOf(cooldown?.retry_at);
    return at !== undefined && at > nowMs ? [at] : [];
  });
  if (times.length > 0) return Math.max(...times);
  if (entry.quota_blocked === true) {
    const at = timeOf(entry.next_retry_after);
    if (at !== undefined && at > nowMs) return at;
  }
  return undefined;
}

/**
 * The limit headers of the login's last answer: the login-wide reading when
 * the proxy keeps one, else the newest reading it keeps for one model.
 */
function latestSignals(entry: Record<string, unknown>): Map<string, string> | undefined {
  const candidates: { at: number; signals: Record<string, unknown> }[] = [];
  const own = asRecord(entry.quota);
  const ownSignals = asRecord(own?.signals);
  if (ownSignals && Object.keys(ownSignals).length > 0)
    candidates.push({ at: timeOf(own?.observed_at) ?? 0, signals: ownSignals });
  if (candidates.length === 0) {
    for (const raw of Object.values(asRecord(entry.model_quotas) ?? {})) {
      const observed = asRecord(raw);
      const signals = asRecord(observed?.signals);
      if (signals && Object.keys(signals).length > 0)
        candidates.push({ at: timeOf(observed?.observed_at) ?? 0, signals });
    }
  }
  const newest = candidates.sort((a, b) => b.at - a.at)[0];
  if (!newest) return undefined;
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(newest.signals)) {
    const text = typeof value === "string" ? value : numberText(value);
    if (text !== undefined) map.set(key.toLowerCase(), text.trim());
  }
  return map;
}

/**
 * Anthropic's unified limit headers: `-5h-`, `-7d-` and `-7d_<scope>-`
 * windows, each a used fraction from 0 to 1 and a reset in Unix seconds.
 */
const CLAUDE_HEADER = /^anthropic-ratelimit-unified-([a-z0-9]+(?:_[a-z0-9]+)?)-utilization$/;

function claudeWindowId(claim: string): string {
  if (claim === "5h") return "five_hour";
  if (claim === "7d") return "seven_day";
  if (claim === "7d_oi") return "seven_day_overage_included";
  if (claim.startsWith("7d_")) return `seven_day_${claim.slice(3)}`;
  return claim;
}

function claudeReading(signals: Map<string, string>): {
  windows: PoolLoginWindow[];
  credits?: QuotaCreditsView;
} {
  const windows: PoolLoginWindow[] = [];
  for (const [key, value] of signals) {
    const claim = CLAUDE_HEADER.exec(key)?.[1];
    const used = Number(value);
    if (!claim || value === "" || !Number.isFinite(used)) continue;
    const id = claudeWindowId(claim);
    const reset = Number(signals.get(`anthropic-ratelimit-unified-${claim}-reset`));
    windows.push({
      id,
      label: claudeWindowLabel(id),
      percentRemaining: clampPercent(100 - used * 100),
      ...(Number.isFinite(reset) && reset > 0 ? { resetsAtMs: reset * 1000 } : {}),
    });
  }
  return { windows: windows.sort((a, b) => a.id.localeCompare(b.id)) };
}

const SESSION_MINUTES = 300;
const WEEKLY_MINUTES = 10_080;

/**
 * ChatGPT's `x-codex-primary-*` and `x-codex-secondary-*` headers: a used
 * percent, a reset in Unix seconds and the window's length in minutes,
 * which names it as the usage reading's own length does. A length of zero
 * is no such window. `x-codex-credits-*` say whether credits answer.
 */
function codexReading(signals: Map<string, string>): {
  windows: PoolLoginWindow[];
  credits?: QuotaCreditsView;
} {
  const windows: PoolLoginWindow[] = [];
  for (const slot of ["primary", "secondary"] as const) {
    const usedText = signals.get(`x-codex-${slot}-used-percent`);
    const minutes = Number(signals.get(`x-codex-${slot}-window-minutes`));
    const used = Number(usedText);
    if (usedText === undefined || usedText === "" || !Number.isFinite(used)) continue;
    if (Number.isFinite(minutes) && minutes === 0) continue;
    const id =
      minutes === SESSION_MINUTES
        ? "five_hour"
        : minutes === WEEKLY_MINUTES
          ? "weekly"
          : slot === "primary"
            ? "five_hour"
            : "weekly";
    if (windows.some((window) => window.id === id)) continue;
    const reset = Number(signals.get(`x-codex-${slot}-reset-at`));
    windows.push({
      id,
      label: id === "five_hour" ? "session" : "weekly",
      percentRemaining: clampPercent(100 - used),
      ...(Number.isFinite(reset) && reset > 0 ? { resetsAtMs: reset * 1000 } : {}),
    });
  }
  const has = signals.get("x-codex-credits-has-credits")?.toLowerCase();
  const unlimited = signals.get("x-codex-credits-unlimited")?.toLowerCase() === "true";
  const balance = signals.get("x-codex-credits-balance");
  const credits: QuotaCreditsView | undefined = unlimited
    ? { state: "available", unlimited: true }
    : has === "true"
      ? { state: "available", ...(balance ? { balance } : {}) }
      : has === "false"
        ? { state: "off" }
        : undefined;
  return { windows, ...(credits ? { credits } : {}) };
}
