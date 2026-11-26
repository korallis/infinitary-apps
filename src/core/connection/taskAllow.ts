import { hasSince16, speaksSince } from "@shared/contractFeatures";
import { SECRET_BRING_ELSEWHERE_HIDDEN, SECRET_BRING_ELSEWHERE_SHOWN } from "@shared/secretBring";
import { contractChange, listsChange } from "./contractChanges";

/** Asking to keep a secret (`secrets-ask.md`). */
const SECRETS_ASK = contractChange("secrets-ask");
/** Bringing secrets from another tool (`secrets-bring.md`). */
const SECRETS_BRING = contractChange("secrets-bring");

/** A card's Use a saved reset (`use-saved-reset.md`). */
const USE_SAVED_RESET = contractChange("use-saved-reset");

/** A run-out card's Use saved resets on their own (`auto-saved-resets.md`). */
const AUTO_SAVED_RESETS = contractChange("auto-saved-resets");

/** The event screen's offer card's Turn on (`event-screen-offer.md`). */
const EVENT_SCREEN_OFFER = contractChange("event-screen-offer");

/** A low login's Move to another login (`when-login-runs-low.md`). */
const WHEN_LOGIN_RUNS_LOW = contractChange("when-login-runs-low");

/** Major 15 includes this button; older read-only views still need its historical name. */
export function readsTaskAllow(version: string, changes?: readonly string[]): boolean {
  return speaksSince(version, "15.0.0") || (changes?.includes("integration-task-allow") ?? false);
}

/**
 * Whether a view reads the Keep going on credits button: a desktop view has
 * it from major 16, or lists `keep-going-on-credits` on major 15
 * (`hasSince16`); the phone reads a host effect's operation as text.
 */
export function readsKeepGoing(
  version: string | undefined,
  changes?: readonly string[],
  system?: string,
): boolean {
  return system === "ios" || hasSince16(version, changes, "keep-going-on-credits");
}

/**
 * Whether a view draws the masked fields of an ask to keep a secret and
 * sends their values (`secrets-ask.md`): only a view, desktop or phone,
 * that lists the change. One without it reads the ask's words and its
 * line saying where to answer, with no Keep button.
 */
export function readsSecretKeep(changes?: readonly string[]): boolean {
  return listsChange(changes, SECRETS_ASK);
}

/**
 * Whether a view reads the event screen offer's Turn on
 * (`event-screen-offer.md`): a desktop view that lists the change; the phone
 * reads a host effect's operation as text. One without it gets the card with
 * Not now alone, and its words name Settings.
 */
export function readsEventScreenOffer(changes?: readonly string[], system?: string): boolean {
  return system === "ios" || listsChange(changes, EVENT_SCREEN_OFFER);
}

/**
 * Whether a view draws the tick rows of a bring card and sends the ticked
 * rows (`secrets-bring.md`): only a view that lists the change. One without
 * it reads the card's words, with no Bring into Secrets button.
 */
export function readsSecretBring(changes?: readonly string[]): boolean {
  return listsChange(changes, SECRETS_BRING);
}

/**
 * Whether a view reads a card's Use a saved reset (`use-saved-reset.md`):
 * only a view that lists the change, since without it the click's way on,
 * the account's row in Settings, does nothing there.
 */
export function readsSavedReset(changes?: readonly string[]): boolean {
  return listsChange(changes, USE_SAVED_RESET);
}

/**
 * Whether a view reads a run-out card's Use saved resets on their own
 * (`auto-saved-resets.md`): only a view that lists the change, since
 * without it the account's row the click opens does not turn it on there.
 */
export function readsAutoSavedResets(changes?: readonly string[]): boolean {
  return listsChange(changes, AUTO_SAVED_RESETS);
}

/**
 * Whether a view reads a card's Move to another login
 * (`when-login-runs-low.md`): a desktop view that lists the change; the phone
 * reads a host effect's operation as text. One without it gets the card with
 * its other buttons alone.
 */
export function readsMoveLogin(changes?: readonly string[], system?: string): boolean {
  return system === "ios" || listsChange(changes, WHEN_LOGIN_RUNS_LOW);
}

/** Which card buttons an older view reads strictly, and so must not be sent. */
export interface ActionReads {
  /** Allow for the rest of this task (`readsTaskAllow`). */
  taskAllow: boolean;
  /** Keep going on credits (`readsKeepGoing`). */
  keepGoing: boolean;
  /** Keep in Secrets on an ask to keep a secret (`readsSecretKeep`); absent reads as true. */
  secretKeep?: boolean;
  /** Turn on on the event screen's offer (`readsEventScreenOffer`); absent reads as true. */
  eventScreen?: boolean;
  /** Bring into Secrets on a bring card (`readsSecretBring`); absent reads as true. */
  secretBring?: boolean;
  /** Use a saved reset on a spent-allowance or run-out card (`readsSavedReset`); absent reads as true. */
  savedReset?: boolean;
  /** Use saved resets on their own on a run-out card (`readsAutoSavedResets`); absent reads as true. */
  autoSavedResets?: boolean;
  /** Move to another login on a low-login or pause card (`readsMoveLogin`); absent reads as true. */
  moveLogin?: boolean;
}

/** The markers only a frame carrying one of those buttons holds, so most frames pass as they are. */
const TASK_ALLOW_MARK = '"integration":"task"';
const KEEP_GOING_MARK = '"op":"keep-going-on-credits"';
const SECRET_KEEP_MARK = '"op":"secrets-keep"';
const EVENT_SCREEN_MARK = '"op":"turn-on-event-screen"';
const SECRET_BRING_MARK = '"op":"secrets-bring"';
const SAVED_RESET_MARK = '"op":"use-saved-reset"';
const AUTO_SAVED_RESETS_MARK = '"op":"use-saved-resets"';
const MOVE_LOGIN_MARK = '"op":"move-login"';

function effectOf(action: unknown): { kind?: unknown; integration?: unknown; op?: unknown } {
  return (action as { effect?: { kind?: unknown } } | null)?.effect ?? {};
}

function unread(action: unknown, reads: ActionReads): boolean {
  const effect = effectOf(action);
  if (!reads.taskAllow && effect.kind === "request_write" && effect.integration === "task")
    return true;
  if (reads.secretKeep === false && effect.kind === "host" && effect.op === "secrets-keep")
    return true;
  if (reads.eventScreen === false && effect.kind === "host" && effect.op === "turn-on-event-screen")
    return true;
  if (reads.secretBring === false && effect.kind === "host" && effect.op === "secrets-bring")
    return true;
  if (reads.savedReset === false && effect.kind === "host" && effect.op === "use-saved-reset")
    return true;
  if (reads.autoSavedResets === false && effect.kind === "host" && effect.op === "use-saved-resets")
    return true;
  if (reads.moveLogin === false && effect.kind === "host" && effect.op === "move-login")
    return true;
  return !reads.keepGoing && effect.kind === "host" && effect.op === "keep-going-on-credits";
}

export function withoutUnreadActions(value: unknown, reads: ActionReads): unknown {
  if (
    reads.taskAllow &&
    reads.keepGoing &&
    reads.secretKeep !== false &&
    reads.eventScreen !== false &&
    reads.secretBring !== false &&
    reads.savedReset !== false &&
    reads.autoSavedResets !== false &&
    reads.moveLogin !== false
  )
    return value;
  if (Array.isArray(value)) return value.map((entry) => withoutUnreadActions(entry, reads));
  if (!value || typeof value !== "object") return value;
  const actions = (value as { actions?: unknown }).actions;
  // A bring card that loses Bring into Secrets shows its line saying where to pick.
  const bringLeft =
    reads.secretBring === false &&
    Array.isArray(actions) &&
    actions.some((action) => {
      const effect = effectOf(action);
      return effect.kind === "host" && effect.op === "secrets-bring";
    });
  const entries = Object.entries(value).map(([key, entry]) => [
    key,
    key === "actions" && Array.isArray(entry)
      ? entry
          .filter((action) => !unread(action, reads))
          .map((action) => withoutUnreadActions(action, reads))
      : key === "body" && bringLeft && typeof entry === "string"
        ? entry.replace(SECRET_BRING_ELSEWHERE_HIDDEN, SECRET_BRING_ELSEWHERE_SHOWN)
        : withoutUnreadActions(entry, reads),
  ]);
  return Object.fromEntries(entries);
}

export function frameWithoutUnreadActions(text: string, reads: ActionReads): string {
  const carries =
    (!reads.taskAllow && text.includes(TASK_ALLOW_MARK)) ||
    (!reads.keepGoing && text.includes(KEEP_GOING_MARK)) ||
    (reads.secretKeep === false && text.includes(SECRET_KEEP_MARK)) ||
    (reads.eventScreen === false && text.includes(EVENT_SCREEN_MARK)) ||
    (reads.secretBring === false && text.includes(SECRET_BRING_MARK)) ||
    (reads.savedReset === false && text.includes(SAVED_RESET_MARK)) ||
    (reads.autoSavedResets === false && text.includes(AUTO_SAVED_RESETS_MARK)) ||
    (reads.moveLogin === false && text.includes(MOVE_LOGIN_MARK));
  return carries ? JSON.stringify(withoutUnreadActions(JSON.parse(text), reads)) : text;
}

export function withoutTaskAllow(value: unknown): unknown {
  return withoutUnreadActions(value, { taskAllow: false, keepGoing: true });
}

export function frameWithoutTaskAllow(text: string): string {
  return frameWithoutUnreadActions(text, { taskAllow: false, keepGoing: true });
}
