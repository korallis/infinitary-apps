import type { QuotaCreditsView, QuotaSavedResetsView, QuotaWindowView } from "@shared/quota";
import type { ManagedAuth } from "../auth";
import { type QuotaHttp, requestHeaders } from "../http";
import { asNumber, asRecord, asString, remainingFromUsedPercent } from "../json";
import {
  CREDENTIAL_UNAVAILABLE,
  failureFromResponse,
  type ProviderOutcome,
  succeeded,
} from "../outcome";
import {
  buildWindow,
  resetsAtFromRemainingSeconds,
  SESSION_WINDOW_SECONDS,
  WEEKLY_WINDOW_SECONDS,
} from "../pace";

export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const JWT_CLAIM = "https://api.openai.com/auth";

export function chatgptAccountId(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    const claim = asRecord(asRecord(payload)?.[JWT_CLAIM]);
    return asString(claim?.chatgpt_account_id);
  } catch {
    return undefined;
  }
}

export function parseCodexUsage(
  body: unknown,
  now: number,
): {
  windows: QuotaWindowView[];
  credits?: QuotaCreditsView;
  savedResets?: QuotaSavedResetsView;
  plan?: string;
} {
  const root = asRecord(body);
  if (!root) return { windows: [] };
  const rate = asRecord(root.rate_limit) ?? asRecord(root.rateLimit) ?? root;
  const windows: QuotaWindowView[] = [];
  // A slot's own length names it: a Pro plan sends its 7-day window as
  // primary. The slot's position names it only when no length is given.
  const slots = [
    { slot: asRecord(rate.primary_window) ?? asRecord(rate.primaryWindow), fallback: "five_hour" },
    {
      slot: asRecord(rate.secondary_window) ?? asRecord(rate.secondaryWindow),
      fallback: "weekly",
    },
  ];
  for (const { slot, fallback } of slots) {
    if (!slot) continue;
    const id = durationId(slot) ?? fallback;
    const parsed = windowFromSlot(slot, id, labelFor(id), now);
    if (parsed) windows.push(parsed);
  }

  for (const [key, node] of Object.entries(rate)) {
    if (key === "primary_window" || key === "primaryWindow") continue;
    if (key === "credits" || key === "spend_control" || key === "spendControl") continue;
    if (key === "secondary_window" || key === "secondaryWindow") continue;
    const slot = asRecord(node);
    if (!slot) continue;
    const id = slotId(key, slot);
    const parsed = windowFromSlot(slot, id, labelFor(id), now);
    if (parsed) windows.push(parsed);
  }

  const plan = asString(root.plan_type) ?? asString(root.plan);
  const credits = codexCredits(root, rate);
  const savedResets = codexSavedResets(root);
  return {
    windows,
    ...(credits ? { credits } : {}),
    ...(savedResets ? { savedResets } : {}),
    ...(plan ? { plan } : {}),
  };
}

/**
 * ChatGPT's saved resets (docs/quota.md, "Saved resets"), from the usage
 * reading's `rate_limit_reset_credits`: `available_count` is how many the
 * account holds, `applicable_available_count` how many would take effect
 * now. A reading without a count says nothing, which is unknown, never zero.
 */
function codexSavedResets(root: Record<string, unknown>): QuotaSavedResetsView | undefined {
  const node = asRecord(root.rate_limit_reset_credits) ?? asRecord(root.rateLimitResetCredits);
  const available = countOf(node?.available_count ?? node?.availableCount);
  if (available === undefined) return undefined;
  const applicable = countOf(node?.applicable_available_count ?? node?.applicableAvailableCount);
  return { available, ...(applicable !== undefined ? { applicable } : {}) };
}

/** A count as the reading sends it: a whole number, never below zero. */
function countOf(value: unknown): number | undefined {
  const count = asNumber(value);
  return count !== undefined && Number.isInteger(count) && count >= 0 ? count : undefined;
}

/**
 * ChatGPT's credits as a credits fact (docs/quota.md, "Credits past the
 * allowance"), from the usage reading's `credits` (`has_credits`,
 * `unlimited`, `balance`, `overage_limit_reached`) and
 * `spend_control.reached`: a reached spend or overage limit is `spent`,
 * credits the account has are `available`, and an account with none is
 * `off`. A reading without `credits` stays unknown.
 */
function codexCredits(
  root: Record<string, unknown>,
  rate: Record<string, unknown>,
): QuotaCreditsView | undefined {
  const node = asRecord(root.credits) ?? asRecord(rate.credits);
  const spend =
    asRecord(root.spend_control) ??
    asRecord(root.spendControl) ??
    asRecord(rate.spend_control) ??
    asRecord(rate.spendControl);
  if (spend?.reached === true) return { state: "spent" };
  if (!node) return undefined;
  if (node.overage_limit_reached === true) return { state: "spent" };
  const hasCredits = node.has_credits ?? node.hasCredits;
  if (node.unlimited === true) return { state: "available", unlimited: true };
  const balance =
    asString(node.balance) ??
    (asNumber(node.balance) !== undefined ? String(asNumber(node.balance)) : undefined);
  if (hasCredits === true) return { state: "available", ...(balance ? { balance } : {}) };
  if (hasCredits === false) return { state: "off" };
  return undefined;
}

function windowSecondsOf(slot: Record<string, unknown>): number | undefined {
  return (
    asNumber(slot.limit_window_seconds) ?? asNumber(slot.window_seconds) ?? asNumber(slot.limit)
  );
}

function durationId(slot: Record<string, unknown>): "five_hour" | "weekly" | undefined {
  const seconds = windowSecondsOf(slot);
  if (seconds === SESSION_WINDOW_SECONDS) return "five_hour";
  if (seconds === WEEKLY_WINDOW_SECONDS) return "weekly";
  return undefined;
}

function slotId(key: string, slot: Record<string, unknown>): string {
  const duration = durationId(slot);
  return duration ? `${key}_${duration}` : key;
}

function labelFor(id: string): string {
  if (id.includes("five_hour") || id === "five_hour") return "session";
  if (id.includes("weekly") || id === "weekly") return "weekly";
  return id.replaceAll("_", " ");
}

function windowFromSlot(
  slot: Record<string, unknown> | undefined,
  id: string,
  label: string,
  now: number,
): QuotaWindowView | undefined {
  if (!slot) return undefined;
  const used =
    asNumber(slot.used_percent) ?? asNumber(slot.usedPercent) ?? asNumber(slot.percent_used);
  const remaining =
    asNumber(slot.percent_remaining) ??
    (used !== undefined ? remainingFromUsedPercent(used) : undefined);
  const windowSeconds = windowSecondsOf(slot);
  const resetsAtMs = resetsAtFromRemainingSeconds(
    slot.reset_after_seconds ?? slot.resetAfterSeconds ?? slot.resets_in_seconds,
    now,
  );
  if (remaining === undefined && resetsAtMs === undefined) return undefined;
  return buildWindow({
    id,
    label,
    ...(remaining !== undefined ? { percentRemaining: remaining } : {}),
    ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
    ...(windowSeconds !== undefined ? { windowSeconds } : {}),
    now,
  });
}

export async function fetchCodexQuota(
  http: QuotaHttp,
  auth: ManagedAuth,
  now: number,
): Promise<ProviderOutcome> {
  const token = auth.apiKey;
  if (!token) return CREDENTIAL_UNAVAILABLE;
  const accountId = chatgptAccountId(token);
  const result = await http(CODEX_USAGE_URL, {
    headers: requestHeaders(auth, {
      ...(accountId ? { "chatgpt-account-id": accountId } : {}),
    }),
  });
  if (!succeeded(result)) return failureFromResponse(result);
  return { status: "ok", ...parseCodexUsage(result.json, now) };
}
