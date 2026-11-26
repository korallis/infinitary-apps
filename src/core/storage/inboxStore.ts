import { createHash, randomUUID } from "node:crypto";
import type { CrewResponse, ResponseRequest, SavedCrewResponse } from "@shared/crewResponses";
import { SERVED_ORIGINS, type ServedOrigin, type ServedWakeOrigin } from "@shared/servedFrame";
import type { TypedWake, WakeBody, WakeEnvelope } from "../orchestrator/wakes";
import { capWithOverflow } from "../overflow";
import type { AppDatabase } from "./db";
import { prepared } from "./statements";

/**
 * The durable inbox (migration 12): fm_inbox generalized to every recipient.
 * One lane per recipient - "firstmate" for the orchestrator's [fm-op]
 * traffic, a task id for guidance addressed to that crewmate - with the
 * source mechanism's semantics (firstmate's fm-task-inbox-lib.sh, adapted
 * to one Electron process):
 *
 * - Enqueue is delivery: the durable row is the message; the in-process
 *   delivery attempt is only the doorbell, free to re-ring.
 * - Acknowledge after handling: a row is deleted only when the turn that
 *   consumed it ended without error. A failed turn releases the row for
 *   retry; a process death leaves it in-flight, and the boot sweep resets
 *   in-flight rows to pending (at-least-once - a rare duplicate is chosen
 *   over a silent loss, exactly the source's trade). A turn a quit or crash
 *   cut is not the crewmate refusing the guidance either: the reset gives
 *   its attempt back and counts the cut in `cuts` (migration 74), so the
 *   replay says what it is and repeated quits never spend the ladder.
 * - The retry ladder: one delivery attempt per grace period, counted in
 *   `attempts`. Task-lane rows whose budget is spent escalate loudly and
 *   stop retrying; the firstmate lane never escalates - its rows simply
 *   keep waiting at the grace cadence, because operational messages have
 *   nowhere else to go.
 *
 * - The honest retry (migration 45, captain's Q1 of 2026-09-26): a turn the
 *   PROVIDER failed is not the crewmate refusing the guidance, and a task
 *   lane has nowhere else to go either. Such a release spends no attempt:
 *   it counts in `failures` and backs off (`INBOX_BACKOFF_MS`, then every
 *   15 minutes, forever), so the row is delivered on the first attempt
 *   after the provider answers again. Only refusals - a steer or a resume
 *   that throws, a sign-in failure - spend the ladder's attempts.
 *
 * - Wakes dedupe by content (interaction P0, WI-3; migration 22): a wake
 *   identical to the last one on its lane and ref is not a new event, so
 *   `enqueueWake` records nothing for it. The last one is the newest live
 *   row, or the newest acked row while it is inside the dedupe window
 *   (`inbox_acks` remembers it, since the ack deletes the row). This
 *   dedupes content, never delivery attempts: a row that exists is
 *   delivered, released, and reset at boot exactly as before.
 *
 * - A wake that goes out once per fact names it (`TypedWake.once`; migration
 *   49): `enqueueWake` records the name for the wake's task in `inbox_once`,
 *   in the transaction that queues the row, and never queues a wake with
 *   that name about that task again - across a restart, an intervening wake
 *   and any time after the ack, none of which the content dedupe covers.
 *   A host steer that goes out once per fact records its name the same way
 *   (`enqueueSteerOnce`); a plain `enqueue` never reads or records one.
 *
 * - Every firstmate- and supervision-lane row carries its `origin` (migration
 *   32, `ServedOrigin`): the emitter says what the message is, so the reader
 *   classifies it structurally and never by the `[fm-op]`/`[user]` wording
 *   in the payload. Task-lane rows (guidance to a crewmate) carry none.
 *
 * - The payload is a typed wake envelope (migration 48, the primitives
 *   review's P3; `orchestrator/wakes.ts`): `{v, facts, ways}` for every
 *   wake the host composes, `{v, text}` for prose someone wrote. A row
 *   read back IS the envelope, with its `origin` and `ref` columns; the
 *   reader renders it with `renderWake` where it is served, never here. A
 *   typed wake's content identity is its origin and facts, never its
 *   wording; prose keeps the hash of its text.
 *
 * Not an event bus: every row has exactly one recipient and one
 * acknowledgement - no fan-out - which is what keeps ack-after-handling
 * and the ladder coherent.
 */

/** Delivery-attempt spacing, matching the source's FM_TASK_INBOX_GRACE_SECS. */
export const INBOX_GRACE_MS = 90_000;
/**
 * The wake-diet coalescing window (interaction P3, WI-13): a first pending
 * wake is held this long for its siblings so near-simultaneous wakes drain as
 * one turn instead of one turn each. Anchored to the oldest pending row's
 * `createdAt` and checked against the clock, not a wall-timer, so a replay's
 * frozen clock coalesces exactly as production's real one does. A captain turn
 * never waits it out - it carries the pending rows with it.
 */
export const WAKE_COALESCE_MS = 3_000;
/** Attempts before a task-lane row escalates (FM_TASK_INBOX_RING_MAX). */
export const INBOX_ATTEMPT_MAX = 3;
/**
 * The honest retry's backoff after the nth provider failure of a row (the
 * captain's Q1): 90 s, 3 min, 5 min, 10 min, then every 15 min, forever.
 */
export const INBOX_BACKOFF_MS: readonly number[] = [
  90_000,
  3 * 60_000,
  5 * 60_000,
  10 * 60_000,
  15 * 60_000,
];
const INBOX_BACKOFF_CEILING_MS = 15 * 60_000;

export function inboxBackoffMs(failures: number): number {
  return INBOX_BACKOFF_MS[Math.max(failures, 1) - 1] ?? INBOX_BACKOFF_CEILING_MS;
}
/**
 * How many provider failures in a row with the same words make a task lane
 * stuck at its provider (INF-3714's direction A, the captain's "after the
 * third identical failure"): the lane stops retrying, keeps its rows, and
 * the first mate is told once (docs/inbox.md, "Stuck at its provider").
 */
export const STUCK_REFUSAL_LIMIT = 3;
export const FIRSTMATE_RECIPIENT = "firstmate";
/** The supervision session's lane (design B); its owner drains it. */
export const SUPERVISION_RECIPIENT = "supervision";
/**
 * How long an acked wake still counts as the lane's last one (WI-3). Long
 * enough to swallow a replay storm (Sep 14: one stale text re-sent for five
 * minutes), short enough that a real recurrence later is heard again.
 */
export const INBOX_DEDUPE_WINDOW_MS = 5 * 60_000;

/** The content identity of prose (the `content_hash` column of a `{v, text}` row). */
export function inboxContentHash(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

/** The payload's schema version (migration 48): every row carries it. */
export const WAKE_ENVELOPE_VERSION = 1;

/**
 * The content identity a wake is deduped by: `{origin, ref, facts}` for a
 * typed wake (the ref is the lane's, matched by the query), and the text's
 * own hash for prose - so a prose row from before the envelope still
 * dedupes the same prose after it.
 */
export function wakeIdentity(body: WakeBody, origin: ServedOrigin | null): string {
  if (typeof body === "string") return inboxContentHash(body);
  return inboxContentHash(canonicalJson({ origin, facts: body.facts }));
}

export function encodeWake(body: WakeBody): string {
  return JSON.stringify(
    typeof body === "string"
      ? { v: WAKE_ENVELOPE_VERSION, text: body }
      : { v: WAKE_ENVELOPE_VERSION, facts: body.facts, ways: body.ways },
  );
}

/**
 * A payload column read back as the envelope's body. A row that is not an
 * envelope - prose an older build wrote after this one migrated the table -
 * is read as the prose it is.
 */
function decodeWake(payload: string): Pick<WakeEnvelope, "v" | "facts" | "ways" | "text"> {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (isEnvelope(parsed)) {
      return {
        v: WAKE_ENVELOPE_VERSION,
        ...(parsed.facts !== undefined ? { facts: parsed.facts } : {}),
        ...(parsed.ways !== undefined ? { ways: parsed.ways } : {}),
        ...(parsed.text !== undefined ? { text: parsed.text } : {}),
      };
    }
  } catch {
    // Not JSON: prose.
  }
  return { v: WAKE_ENVELOPE_VERSION, text: payload };
}

function isEnvelope(value: unknown): value is Partial<WakeEnvelope> {
  if (typeof value !== "object" || value === null) return false;
  const envelope = value as Record<string, unknown>;
  if (envelope.v !== WAKE_ENVELOPE_VERSION) return false;
  if (typeof envelope.text === "string") return true;
  const facts = envelope.facts as Record<string, unknown> | null | undefined;
  return typeof facts === "object" && facts !== null && typeof facts.kind === "string";
}

/** JSON with every object's keys sorted, so equal facts hash equal whatever built them. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "object" && entry !== null && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : entry,
  );
}

export type InboxRow = WakeEnvelope & {
  id: number;
  recipient: string;
  createdAt: number;
  /** Set while a live session holds the row, awaiting the handling ack. */
  deliveredAt: number | null;
  attempts: number;
  lastAttemptAt: number | null;
  /** Task-lane ladder spent: surfaced loudly, retries stopped. */
  escalatedAt: number | null;
  /** Provider failures this row has met since it last went through (the honest retry). */
  failures: number;
  failingSince: number | null;
  /** When the row is next due; null means now. */
  nextAttemptAt: number | null;
  /** Turns serving this row that a quit or crash cut short; each was given its attempt back. */
  cuts: number;
  /** Provider failures in a row this row met with the same words (`STUCK_REFUSAL_LIMIT`). */
  refusals: number;
  /** When its lane stopped retrying, stuck at its provider; null while it is not. */
  stuckAt: number | null;
};

type ResponseRequestRow = {
  id: string;
  inbox_id: number;
  source_session: string | null;
  source_message: string | null;
  target_task: string;
  target_session: string | null;
  body: string;
  card_json: string | null;
  state: ResponseRequest["state"];
  created_at: number;
};

function responseRequestOf(row: ResponseRequestRow): ResponseRequest {
  return {
    id: row.id,
    inboxId: row.inbox_id,
    sourceSession: row.source_session,
    sourceMessage: row.source_message,
    targetTask: row.target_task,
    targetSession: row.target_session,
    body: row.body,
    card: row.card_json ? JSON.parse(row.card_json) : null,
    state: row.state,
    createdAt: row.created_at,
  };
}

type SavedCrewResponseRow = {
  response_id: string;
  request_id: string;
  contributor_task: string;
  contributor_session: string | null;
  status: CrewResponse["status"];
  text: string;
  at: number;
  wake_id: number;
  delivered_at: number | null;
  handled_at: number | null;
  card_message_id: number | null;
};

function savedCrewResponseOf(row: SavedCrewResponseRow): SavedCrewResponse {
  return {
    responseId: row.response_id,
    requestId: row.request_id,
    contributorTask: row.contributor_task,
    contributorSession: row.contributor_session,
    status: row.status,
    text: row.text,
    at: row.at,
    wakeId: row.wake_id,
    deliveredAt: row.delivered_at,
    handledAt: row.handled_at,
    ...(row.card_message_id !== null ? { cardMessageId: row.card_message_id } : {}),
  };
}

type Row = {
  id: number;
  recipient: string;
  payload: string;
  created_at: number;
  delivered_at: number | null;
  attempts: number;
  last_attempt_at: number | null;
  escalated_at: number | null;
  failures: number | null;
  failing_since: number | null;
  next_attempt_at: number | null;
  cuts: number | null;
  refusals: number | null;
  stuck_at: number | null;
  ref: string | null;
  origin: string | null;
};

function originOf(value: string | null): ServedOrigin | null {
  return SERVED_ORIGINS.find((origin) => origin === value) ?? null;
}

function fromRow(row: Row): InboxRow {
  return {
    ...decodeWake(row.payload),
    id: row.id,
    recipient: row.recipient,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    attempts: row.attempts,
    lastAttemptAt: row.last_attempt_at,
    escalatedAt: row.escalated_at,
    failures: row.failures ?? 0,
    failingSince: row.failing_since,
    nextAttemptAt: row.next_attempt_at,
    cuts: row.cuts ?? 0,
    refusals: row.refusals ?? 0,
    stuckAt: row.stuck_at ?? null,
    ref: row.ref,
    origin: originOf(row.origin),
  };
}

function placeholders(ids: readonly unknown[]): string {
  return ids.map(() => "?").join(", ");
}

export class InboxStore {
  private readonly serviceRecipients = new Set([FIRSTMATE_RECIPIENT, SUPERVISION_RECIPIENT]);

  /** A composition-root ownership fact: task recovery must not consume another service's lane. */
  reserveServiceRecipient(recipient: string): void {
    this.serviceRecipients.add(recipient);
  }

  isServiceRecipient(recipient: string): boolean {
    return this.serviceRecipients.has(recipient);
  }

  private readonly enqueueListeners = new Set<(row: InboxRow) => void>();

  /**
   * Observe new accepted rows synchronously, before their original delivery.
   * A listener may enqueue ancillary work in the caller's transaction, but
   * must not run external effects here. Its own savepoint isolates a failed
   * listener from the original message; replay reads do not notify it.
   */
  onEnqueue(listener: (row: InboxRow) => void): () => void {
    this.enqueueListeners.add(listener);
    return () => this.enqueueListeners.delete(listener);
  }

  /** Invalidation is coalesced after the enclosing synchronous transaction. */
  private readonly changeListeners = new Set<() => void>();
  private changeQueued = false;
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }
  private changed(): void {
    if (this.changeQueued || this.changeListeners.size === 0) return;
    this.changeQueued = true;
    queueMicrotask(() => {
      this.changeQueued = false;
      for (const listener of this.changeListeners) listener();
    });
  }

  /**
   * The clock every time this store stamps or compares - the grace, the
   * honest retry's backoff, the dedupe window - is read from: the host's
   * one clock (the ticker's, `docs/architecture.md` §17).
   */
  private readonly now: () => number;
  /** The spacing between delivery attempts: `INBOX_GRACE_MS` unless a development run shortens it. */
  private readonly graceMs: number;

  constructor(
    private readonly db: AppDatabase,
    options: { now?: () => number; graceMs?: number } = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.graceMs = options.graceMs ?? INBOX_GRACE_MS;
  }

  /**
   * Durably record one message. The row IS the delivery; returns its id.
   * Always inserts: steers, briefs and job results are the captain's or the
   * crewmate's own acts, and their callers hold the returned id. A message
   * for the firstmate or supervision lane names its `origin`.
   */
  enqueue(recipient: string, body: WakeBody, ref?: string, origin?: ServedOrigin): number {
    this.changed();
    const info = this.db
      .prepare(
        "INSERT INTO inbox (recipient, payload, created_at, ref, content_hash, origin) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        recipient,
        encodeWake(body),
        this.now(),
        ref ?? null,
        wakeIdentity(body, origin ?? null),
        origin ?? null,
      );
    const id = Number(info.lastInsertRowid);
    if (this.enqueueListeners.size > 0) {
      const row = this.get(id);
      if (row) {
        for (const listener of this.enqueueListeners) {
          try {
            this.db.transaction(() => listener(row))();
          } catch {
            // Neither the input nor an error containing it belongs in a log.
            console.warn("[inbox] enqueue observer failed");
          }
        }
      }
    }
    return id;
  }

  /**
   * A host steer on a task lane that goes out once per fact (the check
   * watch's, `orchestrator/checkWatch.ts`): the row and its once-name, about
   * the task, in one transaction. It always inserts, as a steer does; the
   * emitter reads `woken` before it steers, so the name keeps a restart
   * between the steer and the emitter's own bookkeeping from sending it
   * twice.
   */
  enqueueSteerOnce(taskId: string, body: TypedWake & { once: string }): number {
    return this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO inbox_once (ref, once_key, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
        )
        .run(taskId, body.once, this.now());
      return this.enqueue(taskId, body);
    });
  }

  /**
   * Record a wake unless it repeats the lane's last one (WI-3): the same
   * content (`wakeIdentity`) as the newest row on this recipient with this
   * ref, or as the newest acked row there when that ack is newer and inside
   * `INBOX_DEDUPE_WINDOW_MS` - or unless it names a `once` already recorded
   * for its ref, which it records otherwise. Returns the new row's id, or
   * null when the wake carried nothing new and nothing was recorded.
   */
  enqueueWake(
    recipient: string,
    body: WakeBody,
    origin: ServedWakeOrigin,
    ref?: string,
  ): number | null {
    const hash = wakeIdentity(body, origin);
    const once = typeof body === "string" ? undefined : body.once;
    return this.transaction(() => {
      const now = this.now();
      if (
        once !== undefined &&
        this.db
          .prepare(
            "INSERT INTO inbox_once (ref, once_key, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
          )
          .run(ref ?? "", once, now).changes === 0
      ) {
        return null;
      }
      const live = this.db
        .prepare(
          "SELECT id, content_hash FROM inbox WHERE recipient = ? AND ref IS ? ORDER BY id DESC LIMIT 1",
        )
        .get(recipient, ref ?? null) as { id: number; content_hash: string | null } | undefined;
      const acked = this.db
        .prepare(
          "SELECT row_id, content_hash, acked_at FROM inbox_acks WHERE recipient = ? AND ref = ?",
        )
        .get(recipient, ref ?? "") as
        | { row_id: number; content_hash: string; acked_at: number }
        | undefined;
      const repeats =
        acked && (!live || acked.row_id > live.id)
          ? acked.content_hash === hash && now - acked.acked_at <= INBOX_DEDUPE_WINDOW_MS
          : live?.content_hash === hash;
      if (repeats) return null;
      return this.enqueue(recipient, body, ref, origin);
    });
  }

  /**
   * Record a once-name about `ref` with no wake of its own: a delivery that
   * carries several facts marks each one told (the heartbeat's standing
   * rows, docs/report-sort.md "The standing list"). False when it already was.
   */
  recordOnce(ref: string, once: string): boolean {
    return (
      this.db
        .prepare(
          // i18n-exempt: SQL, never shown to a person
          "INSERT INTO inbox_once (ref, once_key, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
        )
        .run(ref, once, this.now()).changes > 0
    );
  }

  /**
   * Whether a wake named `once` about `ref` was already queued: what an
   * emitter reads before the side effects of building it again.
   */
  woken(ref: string, once: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM inbox_once WHERE ref = ? AND once_key = ?").get(ref, once) !==
      undefined
    );
  }

  /**
   * The names recorded about `ref` that start with `prefix`: the facts a
   * wake already went out once for, for an emitter that must say later
   * that such a fact ended - across a restart, when no memory holds it.
   */
  wokenNames(ref: string, prefix: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT once_key FROM inbox_once WHERE ref = ? AND substr(once_key, 1, length(?)) = ? ORDER BY at, once_key",
      )
      .all(ref, prefix, prefix) as { once_key: string }[];
    return rows.map((row) => row.once_key);
  }

  /**
   * Move rows to another lane, resetting their ladder: the supervision
   * fallback (design B) - a broken supervision session's pending wakes
   * become ordinary firstmate ops with one UPDATE, today's behavior, never
   * a lost event. Returns how many moved.
   */
  reassign(ids: number[], recipient: string): number {
    this.changed();
    if (ids.length === 0) return 0;
    return this.db
      .prepare(
        `UPDATE inbox SET recipient = ?, attempts = 0, last_attempt_at = NULL, escalated_at = NULL, delivered_at = NULL,
           failures = 0, failing_since = NULL, next_attempt_at = NULL, cuts = 0,
           refusal = NULL, refusals = 0, stuck_at = NULL
         WHERE id IN (${placeholders(ids)})`,
      )
      .run(recipient, ...ids).changes;
  }

  /**
   * Rows due a delivery attempt, oldest first: pending (not in-flight, not
   * escalated) and past their `next_attempt_at` - a fresh row is due
   * immediately, a released one waits out the grace or its backoff.
   * `maxAttempts` (task lanes) additionally excludes rows whose ladder
   * budget is spent; the firstmate lane omits it and retries forever at
   * the grace cadence.
   */
  pending(
    recipient: string,
    now = this.now(),
    options: { maxAttempts?: number; limit?: number } = {},
  ): InboxRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM inbox
         WHERE recipient = ? AND delivered_at IS NULL AND escalated_at IS NULL AND stuck_at IS NULL
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           ${options.maxAttempts !== undefined ? "AND attempts < ?" : ""}
         ORDER BY id LIMIT ?`,
      )
      .all(
        recipient,
        now,
        ...(options.maxAttempts !== undefined ? [options.maxAttempts] : []),
        options.limit ?? 50,
      ) as Row[];
    return rows.map(fromRow);
  }

  /**
   * A delivery attempt begins: in-flight, attempts+1, and the grace clock
   * resets - a row a dead process left in flight is due again one grace
   * after this attempt began.
   */
  markDelivered(ids: number[]): void {
    this.changed();
    if (ids.length === 0) return;
    const now = this.now();
    this.db
      .prepare(
        `UPDATE inbox SET delivered_at = ?, attempts = attempts + 1, last_attempt_at = ?, next_attempt_at = ?
         WHERE id IN (${placeholders(ids)})`,
      )
      .run(now, now, now + this.graceMs, ...ids);
  }

  retireTypedWakes(
    recipient: string,
    kinds: readonly NonNullable<WakeEnvelope["facts"]>["kind"][],
  ): number {
    const ids = this.allFor(recipient)
      .filter((row) => row.facts && kinds.includes(row.facts.kind))
      .map((row) => row.id);
    this.ack(ids);
    return ids.length;
  }

  /**
   * Handled: the consuming turn ended without error. The ack is deletion;
   * the newest acked content per lane and ref is remembered for the dedupe
   * window (WI-3), and memories past it are dropped.
   */
  ack(ids: number[]): void {
    this.changed();
    if (ids.length === 0) return;
    const now = this.now();
    this.transaction(() => {
      for (const id of ids)
        this.db
          .prepare(
            "UPDATE crew_responses SET handled_at = COALESCE(handled_at, ?) WHERE wake_id = ?",
          )
          .run(now, id);
      this.db
        .prepare(
          `INSERT INTO inbox_acks (recipient, ref, row_id, content_hash, acked_at)
           SELECT recipient, COALESCE(ref, ''), id, content_hash, ? FROM inbox
           WHERE id IN (${placeholders(ids)}) AND content_hash IS NOT NULL ORDER BY id
           ON CONFLICT (recipient, ref) DO UPDATE SET
             row_id = excluded.row_id, content_hash = excluded.content_hash, acked_at = excluded.acked_at
           WHERE excluded.row_id > inbox_acks.row_id`,
        )
        .run(now, ...ids);
      this.db.prepare(`DELETE FROM inbox WHERE id IN (${placeholders(ids)})`).run(...ids);
      this.db
        .prepare("DELETE FROM inbox_acks WHERE acked_at < ?")
        .run(now - INBOX_DEDUPE_WINDOW_MS);
    });
  }

  /**
   * The delivery was refused - a steer or a resume that threw, a turn that
   * failed for a reason the ladder was built for: back to pending, due one
   * grace after the attempt began, and the attempt stays spent.
   */
  release(ids: number[]): void {
    this.changed();
    if (ids.length === 0) return;
    this.db
      .prepare(
        `UPDATE inbox SET delivered_at = NULL, next_attempt_at = COALESCE(last_attempt_at, ?) + ?
         WHERE id IN (${placeholders(ids)})`,
      )
      .run(this.now(), this.graceMs, ...ids);
  }

  /**
   * A steer the session accepted but no turn took in (it landed in the
   * turn's own tail): back to pending and due now, with the attempt it was
   * marked with given back - the delivery never happened, so it neither
   * waits out a grace nor spends the ladder's budget.
   */
  reparkUndelivered(ids: number[]): void {
    this.changed();
    if (ids.length === 0) return;
    this.db
      .prepare(
        `UPDATE inbox SET delivered_at = NULL, attempts = MAX(attempts - 1, 0), next_attempt_at = NULL
         WHERE id IN (${placeholders(ids)})`,
      )
      .run(...ids);
  }

  /**
   * Rows whose first try reached no task were never tried: the delivery
   * that does reach their task is their first (`lastAttemptAt`). Their
   * attempt count and backoff stay as the try left them, so call it after
   * `release`, which reads the attempt's time.
   */
  neverAttempted(ids: number[]): void {
    this.changed();
    if (ids.length === 0) return;
    this.db
      .prepare(`UPDATE inbox SET last_attempt_at = NULL WHERE id IN (${placeholders(ids)})`)
      .run(...ids);
  }

  /**
   * The turn failed at the provider (the honest retry): back to pending
   * WITHOUT spending the attempt, one more failure counted, and due after
   * the backoff for that count - or at `notBefore` when that is later: a
   * spent allowance is not asked again before it resets (the cut-off
   * contract). `refusal`, the words of a request the provider refused,
   * counts the refusals in a row that met the same words (`refusals`); a
   * failure in other words, or no refusal, starts that count again. Returns the highest failure count among the
   * rows, after this one, and the highest same-words count.
   */
  releaseAfterProviderFailure(
    ids: number[],
    options: { notBefore?: number; refusal?: string } = {},
  ): { failures: number; refusals: number } {
    this.changed();
    if (ids.length === 0) return { failures: 0, refusals: 0 };
    const now = this.now();
    const notBefore = options.notBefore ?? 0;
    const refusal = options.refusal !== undefined ? inboxContentHash(options.refusal) : null;
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT id, failures, refusal, refusals FROM inbox WHERE id IN (${placeholders(ids)})`,
        )
        .all(...ids) as {
        id: number;
        failures: number;
        refusal: string | null;
        refusals: number | null;
      }[];
      const update = this.db.prepare(
        `UPDATE inbox SET delivered_at = NULL, attempts = MAX(attempts - 1, 0), failures = ?,
           failing_since = COALESCE(failing_since, ?), next_attempt_at = ?, refusal = ?, refusals = ?
         WHERE id = ?`,
      );
      let highest = 0;
      let same = 0;
      for (const row of rows) {
        const failures = row.failures + 1;
        const refusals =
          refusal === null ? 0 : row.refusal === refusal ? (row.refusals ?? 0) + 1 : 1;
        update.run(
          failures,
          now,
          Math.max(now + inboxBackoffMs(failures), notBefore),
          refusal,
          refusals,
          row.id,
        );
        highest = Math.max(highest, failures);
        same = Math.max(same, refusals);
      }
      return { failures: highest, refusals: same };
    });
  }

  /**
   * The lane is stuck at its provider (docs/inbox.md, "Stuck at its
   * provider"): every row still waiting on it stops being attempted and is
   * kept, until an answer - a steer, a fresh conversation or another model
   * - unsticks it (`unstick`, `movedProvider`), or a turn goes through
   * (`endOutage`).
   */
  holdStuck(recipient: string): void {
    this.changed();
    this.db
      .prepare(
        `UPDATE inbox SET stuck_at = ?
         WHERE recipient = ? AND delivered_at IS NULL AND escalated_at IS NULL AND stuck_at IS NULL`,
      )
      .run(this.now(), recipient);
  }

  /**
   * Whether the lane is stuck at its provider, and since when and after how
   * many same-words failures; undefined while it is not.
   */
  stuck(recipient: string): { since: number; refusals: number } | undefined {
    const row = prepared(
      this.db,
      `SELECT MIN(stuck_at) AS since, MAX(refusals) AS refusals FROM inbox
       WHERE recipient = ? AND stuck_at IS NOT NULL AND delivered_at IS NULL AND escalated_at IS NULL`,
    ).get(recipient) as { since: number | null; refusals: number | null };
    return row.since === null ? undefined : { since: row.since, refusals: row.refusals ?? 0 };
  }

  /**
   * An answer reached a stuck lane: its kept rows are due now. Their
   * same-words count stays, so an answer that meets the same refusal again
   * makes the lane stuck at once. Returns whether the lane was stuck.
   */
  unstick(recipient: string): boolean {
    this.changed();
    return (
      this.db
        .prepare(
          `UPDATE inbox SET stuck_at = NULL, next_attempt_at = NULL
           WHERE recipient = ? AND stuck_at IS NOT NULL`,
        )
        .run(recipient).changes > 0
    );
  }

  /**
   * A lane's provider outage, read from its rows: the most failures any
   * waiting row has met and when the earliest of them first failed. Zero
   * failures means the lane is not in an outage.
   */
  outage(recipient: string): { failures: number; since: number | null } {
    // Every posture read asks it, so it is compiled once (INF-683).
    const row = prepared(
      this.db,
      `SELECT MAX(failures) AS failures, MIN(failing_since) AS since FROM inbox
       WHERE recipient = ? AND escalated_at IS NULL AND failures > 0`,
    ).get(recipient) as { failures: number | null; since: number | null };
    return { failures: row.failures ?? 0, since: row.since };
  }

  /**
   * The provider answered on this lane: its outage is over, so every row
   * still backing off is due now, with its failures cleared.
   */
  endOutage(recipient: string): void {
    this.changed();
    this.db
      .prepare(
        `UPDATE inbox SET failures = 0, failing_since = NULL, next_attempt_at = NULL,
           refusal = NULL, refusals = 0, stuck_at = NULL
         WHERE recipient = ? AND (failures > 0 OR stuck_at IS NOT NULL) AND delivered_at IS NULL`,
      )
      .run(recipient);
  }

  /**
   * The lane's task moved to another provider (INF-849): what waits on it
   * is due now, with the attempts and failures the provider it left spent
   * given back, so the new provider gets the whole budget, and a lane stuck
   * at the provider it left goes on. The same-words count stays, so the new
   * provider refusing the same way makes it stuck at once. Rows already set
   * aside stay set aside.
   */
  movedProvider(recipient: string): void {
    this.changed();
    this.db
      .prepare(
        `UPDATE inbox SET attempts = 0, failures = 0, failing_since = NULL, next_attempt_at = NULL,
           stuck_at = NULL
         WHERE recipient = ? AND delivered_at IS NULL AND escalated_at IS NULL`,
      )
      .run(recipient);
  }

  /**
   * Whether the lane holds guidance that will still be delivered: not in
   * flight, not set aside, not stuck at its provider, budget not spent -
   * due now or waiting out its grace or backoff. The idle ladder's "moving"
   * witness.
   */
  hasDeliverable(recipient: string, maxAttempts: number): boolean {
    return (
      prepared(
        this.db,
        `SELECT 1 FROM inbox
         WHERE recipient = ? AND delivered_at IS NULL AND escalated_at IS NULL AND stuck_at IS NULL
           AND attempts < ?
         LIMIT 1`,
      ).get(recipient, maxAttempts) !== undefined
    );
  }

  /**
   * Whether a row about `ref` still waits on the recipient's lane - due or
   * backing off, not yet handed to a turn and not set aside: what the idle
   * ladder reads before it counts a wake to the Firstmate as ignored.
   */
  holdsUndelivered(recipient: string, ref: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM inbox
           WHERE recipient = ? AND ref = ? AND delivered_at IS NULL AND escalated_at IS NULL
           LIMIT 1`,
        )
        .get(recipient, ref) !== undefined
    );
  }

  /**
   * Whether a row about `ref` is still on the recipient's lane - waiting, or
   * handed to a turn that has not ended - and not set aside: the recipient
   * has not yet finished a turn on that news. A container reads it before it
   * closes on its last part's close (INF-3846, docs/task-graph.md "The close
   * rules").
   */
  holdsUnhandled(recipient: string, ref: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM inbox WHERE recipient = ? AND ref = ? AND escalated_at IS NULL LIMIT 1",
        )
        .get(recipient, ref) !== undefined
    );
  }

  /**
   * Whether the captain's choice on a card still waits on the recipient's
   * lane, not yet handed to a turn: its author has not heard the answer
   * (INF-1389 friction 1, `CardService` refuses a revision written blind).
   */
  holdsUndeliveredChoice(recipient: string, cardId: string): boolean {
    return this.allFor(recipient).some((row) => {
      type Facts = { kind?: unknown; card?: { id?: unknown }; guidance?: unknown };
      let facts = row.facts as Facts | undefined;
      // A crewmate's choice with pictures waits wrapped with their copies (`withAttachmentsKept`).
      if (facts?.kind === "attachments-kept" && typeof facts.guidance === "object")
        facts = facts.guidance as Facts;
      return facts?.kind === "card-choice" && facts.card?.id === cardId;
    });
  }

  /**
   * Boot sweep: rows a dead process left in-flight go back to pending and
   * re-deliver (at-least-once). A quit or crash cut the turn serving them,
   * which is not the crewmate refusing them: each is given its attempt back
   * and counts one more cut, so the replay says it follows a restart and
   * repeated quits inside one long turn never set it aside. It stays due one
   * grace after its attempt began. Returns how many were reset. The lanes in
   * `keep` stay as they are: their turn went on without this process, on a
   * computer that runs work, which says where it is once it is back.
   */
  resetInFlight(keep: readonly string[] = []): number {
    this.changed();
    const kept = keep.length > 0 ? ` AND recipient NOT IN (${placeholders(keep)})` : "";
    return this.db
      .prepare(
        `UPDATE inbox SET delivered_at = NULL, attempts = MAX(attempts - 1, 0), cuts = cuts + 1
         WHERE delivered_at IS NOT NULL${kept}`,
      )
      .run(...keep).changes;
  }

  spent(recipient: string, maxAttempts: number): InboxRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM inbox
         WHERE recipient = ? AND delivered_at IS NULL AND escalated_at IS NULL AND attempts >= ?
         ORDER BY id`,
      )
      .all(recipient, maxAttempts) as Row[];
    return rows.map(fromRow);
  }

  /** One row by its id, in flight or not; undefined once it was acknowledged or removed. */
  get(id: number): InboxRow | undefined {
    const row = this.db.prepare("SELECT * FROM inbox WHERE id = ?").get(id) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  /**
   * The sender takes back messages no turn was handed yet: rows that are
   * not in flight are deleted, and their ids answered. A row a turn holds
   * stays, to be acknowledged or released as usual (docs/inbox.md,
   * "Taking back a message").
   */
  withdraw(ids: readonly number[]): number[] {
    if (ids.length === 0) return [];
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT id FROM inbox WHERE id IN (${placeholders(ids)}) AND delivered_at IS NULL ORDER BY id`,
        )
        .all(...ids) as { id: number }[];
      const taken = rows.map((row) => row.id);
      if (taken.length > 0) {
        this.changed();
        this.db.prepare(`DELETE FROM inbox WHERE id IN (${placeholders(taken)})`).run(...taken);
      }
      return taken;
    });
  }

  /**
   * The sender rewrites a message no turn was handed yet: the row keeps its
   * id, place, attempts and backoff, and carries `body` from now on. False
   * when the row is in flight or gone, which changes nothing (docs/inbox.md,
   * "Taking back a message").
   */
  revise(id: number, body: WakeBody): boolean {
    const row = this.db
      .prepare("SELECT origin FROM inbox WHERE id = ? AND delivered_at IS NULL")
      .get(id) as { origin: string | null } | undefined;
    if (!row) return false;
    this.changed();
    this.db
      .prepare(
        "UPDATE inbox SET payload = ?, content_hash = ? WHERE id = ? AND delivered_at IS NULL",
      )
      .run(encodeWake(body), wakeIdentity(body, originOf(row.origin)), id);
    return true;
  }

  /**
   * Every message no turn was handed yet written again through `scrub`,
   * which answers its payload with the words from outside it found due
   * replaced (INF-952; docs/task-retention.md, "Words from outside"): a
   * rule's delivery waiting when the captain deletes them carries the note
   * instead. Each row keeps its id, place, attempts and backoff, as
   * `revise` keeps them. Answers how many it replaced.
   */
  rewritePending(scrub: (payload: unknown) => { value: unknown; replaced: number }): number {
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          "SELECT id, payload, origin FROM inbox WHERE delivered_at IS NULL AND instr(payload, '[[') > 0",
        )
        .all() as { id: number; payload: string; origin: string | null }[];
      const update = this.db.prepare(
        "UPDATE inbox SET payload = ?, content_hash = ? WHERE id = ? AND delivered_at IS NULL",
      );
      let replaced = 0;
      for (const row of rows) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.payload);
        } catch {
          continue;
        }
        const done = scrub(parsed);
        if (done.replaced === 0) continue;
        const payload = JSON.stringify(done.value);
        const read = decodeWake(payload);
        // The same identity `revise` gives a body: its facts, or its prose.
        const body =
          read.facts !== undefined
            ? ({ facts: read.facts, ways: read.ways } as WakeBody)
            : (read.text ?? payload);
        update.run(payload, wakeIdentity(body, originOf(row.origin)), row.id);
        replaced += done.replaced;
      }
      if (replaced > 0) this.changed();
      return replaced;
    });
  }

  /** Ladder spent: surfaced loudly once; excluded from retries thereafter. */
  markEscalated(id: number): void {
    this.changed();
    this.db.prepare("UPDATE inbox SET escalated_at = ? WHERE id = ?").run(this.now(), id);
  }

  /** Every not-in-flight row for a recipient (pending + escalated), oldest first. */
  allFor(recipient: string): InboxRow[] {
    const rows = this.db
      .prepare("SELECT * FROM inbox WHERE recipient = ? AND delivered_at IS NULL ORDER BY id")
      .all(recipient) as Row[];
    return rows.map(fromRow);
  }

  /** The rows a live session holds for a recipient, awaiting their ack, oldest first. */
  inFlight(recipient: string): InboxRow[] {
    const rows = this.db
      .prepare("SELECT * FROM inbox WHERE recipient = ? AND delivered_at IS NOT NULL ORDER BY id")
      .all(recipient) as Row[];
    return rows.map(fromRow);
  }

  /** Recipients holding undelivered rows - what the tick sweep visits. */
  recipientsWithRows(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT recipient FROM inbox WHERE delivered_at IS NULL")
      .all() as { recipient: string }[];
    return rows.map((row) => row.recipient);
  }

  /** Teardown or reset: the lane's rows go with their owner. */
  deleteFor(recipient: string): void {
    this.changed();
    this.transaction(() => {
      this.db.prepare("DELETE FROM inbox WHERE recipient = ?").run(recipient);
      this.db.prepare("DELETE FROM inbox_acks WHERE recipient = ?").run(recipient);
      this.db.prepare("DELETE FROM inbox_once WHERE ref = ?").run(recipient);
    });
  }

  /**
   * A task closed (interaction P0, WI-2): its own lane goes, and so does
   * every wake still queued ABOUT it on the supervision and firstmate lanes
   * (`ref` names the task) - in-flight rows included, whose later ack or
   * release then touches nothing. Nothing from a dead task is triaged or
   * reaches the Firstmate. Callers run it inside the close's transaction.
   * Returns how many rows went.
   */
  purgeTask(taskId: string): number {
    this.changed();
    this.db.prepare("DELETE FROM inbox_acks WHERE recipient = ? OR ref = ?").run(taskId, taskId);
    this.db.prepare("DELETE FROM inbox_once WHERE ref = ?").run(taskId);
    return this.db
      .prepare("DELETE FROM inbox WHERE recipient = ? OR (ref = ? AND recipient IN (?, ?))")
      .run(taskId, taskId, SUPERVISION_RECIPIENT, FIRSTMATE_RECIPIENT).changes;
  }

  /**
   * Record a first mate message and its response expectation together, before
   * any transport attempts it. Its inbox identity is also its source message
   * when the caller has no recorded first mate decision reference.
   */
  requestResponse(
    taskId: string,
    body: string,
    source: {
      session?: string | null;
      message?: string | null;
      targetSession?: string | null;
      card?: ResponseRequest["card"];
    } = {},
    guidance: WakeBody = body,
  ): { request: ResponseRequest; inboxId: number; body: TypedWake } {
    return this.transaction(() => {
      const id = randomUUID();
      const requestBody = typeof guidance === "string" ? guidance : undefined;
      const wrapped: TypedWake = {
        facts: {
          kind: "response-request",
          requestId: id,
          guidance: requestBody ?? (guidance as TypedWake).facts,
        },
        ...(typeof guidance !== "string" && guidance.ways ? { ways: guidance.ways } : {}),
      };
      const inboxId = this.enqueue(taskId, wrapped);
      // Keep the original words separately from the durable steer envelope;
      // the storage owner never imports the orchestration renderer.
      this.db
        .prepare(
          "INSERT INTO response_requests (id, inbox_id, source_session, source_message, target_task, target_session, body, card_json, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
        )
        .run(
          id,
          inboxId,
          source.session ?? null,
          source.message ?? String(inboxId),
          taskId,
          source.targetSession ?? null,
          body,
          source.card ? JSON.stringify(source.card) : null,
          this.now(),
        );
      return { request: this.responseRequest(id)!, inboxId, body: wrapped };
    });
  }

  responseRequest(id: string): ResponseRequest | undefined {
    const row = this.db.prepare("SELECT * FROM response_requests WHERE id = ?").get(id) as
      | ResponseRequestRow
      | undefined;
    return row ? responseRequestOf(row) : undefined;
  }

  pendingResponses(taskId: string): ResponseRequest[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM response_requests WHERE target_task = ? AND state = 'pending' ORDER BY created_at, rowid",
        )
        .all(taskId) as ResponseRequestRow[]
    ).map(responseRequestOf);
  }

  /**
   * Whether a request still waits for its answer: `pending` while open, or
   * `unread` once answered with the wake carrying that answer still waiting
   * on the first mate's lane; `undefined` once it waits no longer.
   */
  requestOpen(id: string): "pending" | "unread" | undefined {
    const request = this.responseRequest(id);
    if (!request) return undefined;
    if (request.state === "pending") return "pending";
    if (request.state !== "answered") return undefined;
    const unread =
      this.db
        .prepare(
          // i18n-exempt: SQL, never shown to a person
          `SELECT 1 FROM crew_responses AS responses JOIN inbox ON inbox.id = responses.wake_id
         WHERE responses.request_id = ? AND inbox.delivered_at IS NULL LIMIT 1`,
        )
        .get(id) !== undefined;
    return unread ? "unread" : undefined;
  }

  /** Cancellation is a sender declaration, never inferred from closing work. */
  cancelResponse(id: string): void {
    const request = this.responseRequest(id);
    if (!request) throw new Error(`Unknown response request ${id}. Nothing changed.`);
    if (request.state === "answered") throw new Error("An answered request cannot be cancelled.");
    this.db.prepare("UPDATE response_requests SET state = 'cancelled' WHERE id = ?").run(id);
  }

  savedResponse(id: string): SavedCrewResponse | undefined {
    const row = this.db.prepare("SELECT * FROM crew_responses WHERE response_id = ?").get(id) as
      | SavedCrewResponseRow
      | undefined;
    return row ? savedCrewResponseOf(row) : undefined;
  }

  /**
   * One answer writer. Exact text, authenticated contributor and first mate
   * row commit together. No task ref on the wake: purgeTask must not erase it.
   * The returned row id is a queued fact, never a read/handled claim.
   *
   * A response a card line carries names that line (docs/card-threads.md,
   * "Shared cards"): the line is its exact answer, so a report naming the
   * same response identity afterwards is the same response, kept once with
   * one notification, whatever the report's own words.
   */
  submitResponse(
    input: CrewResponse,
    contributor: { task: string; session: string | null },
    text: string,
    line?: { cardId: string; messageId: number },
  ): SavedCrewResponse {
    if (!text.trim()) throw new Error("A response needs its exact answer text.");
    return this.transaction(() => {
      const previous = this.savedResponse(input.responseId);
      if (previous) {
        const sameShape =
          previous.requestId === input.requestId &&
          previous.status === input.status &&
          previous.contributorTask === contributor.task;
        const sameWords = previous.cardMessageId !== undefined || previous.text === text;
        if (!sameShape || !sameWords || (line && previous.cardMessageId !== line.messageId))
          throw new Error(
            "That response identity already names different content. Corrected answers need a new response identity.",
          );
        return previous;
      }
      const request = this.responseRequest(input.requestId);
      if (!request)
        throw new Error(`Unknown response request ${input.requestId}. Nothing changed.`);
      if (request.state === "cancelled")
        throw new Error("That response request was cancelled. Nothing changed.");
      const at = this.now();
      const wakeId = this.enqueue(
        FIRSTMATE_RECIPIENT,
        {
          facts: {
            kind: "requested-response",
            requestId: request.id,
            responseId: input.responseId,
            taskId: request.targetTask,
            contributorTask: contributor.task,
            status: input.status,
            question: capWithOverflow(request.body, "response-question"),
            excerpt: capWithOverflow(text, "requested-response"),
          },
        },
        undefined,
        "crewmate-report",
      );
      this.db
        .prepare(
          "INSERT INTO crew_responses (response_id, request_id, contributor_task, contributor_session, status, text, at, wake_id, card_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.responseId,
          input.requestId,
          contributor.task,
          contributor.session,
          input.status,
          text,
          at,
          wakeId,
          line?.messageId ?? null,
        );
      if (input.status === "answered")
        this.db
          .prepare("UPDATE response_requests SET state = 'answered' WHERE id = ?")
          .run(request.id);
      return this.savedResponse(input.responseId)!;
    });
  }

  /** Backend-confirmed receipt of the exact served input, before clean handling. */
  responsesDelivered(ids: readonly number[]): void {
    this.transaction(() => {
      for (const id of ids)
        this.db
          .prepare(
            "UPDATE crew_responses SET delivered_at = COALESCE(delivered_at, ?) WHERE wake_id = ?",
          )
          .run(this.now(), id);
    });
  }

  /** Called only after the session gave back its unread suffix and ended clean. */
  noteMissingResponses(
    taskId: string,
    consumedIds: readonly number[],
    turn: { id: string; since: number; report?: string; session?: string; reportEventId?: number },
  ): number[] {
    return this.transaction(() =>
      consumedIds.flatMap((inboxId) => {
        const row = this.db
          .prepare(
            "SELECT * FROM response_requests WHERE inbox_id = ? AND target_task = ? AND state = 'pending'",
          )
          .get(inboxId, taskId) as ResponseRequestRow | undefined;
        if (!row) return [];
        const answeredThisTurn = this.db
          .prepare(
            "SELECT 1 FROM crew_responses WHERE request_id = ? AND contributor_task = ? AND at >= ? LIMIT 1",
          )
          .get(row.id, taskId, turn.since);
        if (answeredThisTurn) return [];
        const id = this.enqueueWake(
          FIRSTMATE_RECIPIENT,
          {
            facts: {
              kind: "response-missing",
              requestId: row.id,
              taskId,
              turnId: turn.id,
              references: {
                inboxId,
                startedAt: turn.since,
                ...(turn.session ? { session: turn.session } : {}),
                ...(turn.reportEventId !== undefined ? { reportEventId: turn.reportEventId } : {}),
              },
              question: capWithOverflow(responseRequestOf(row).body, "response-question"),
              ...(turn.report
                ? { report: capWithOverflow(turn.report, "response-turn-report") }
                : {}),
            },
            once: `response-missing:${row.id}:${turn.id}`,
          },
          "agent",
        );
        return id === null ? [] : [id];
      }),
    );
  }

  /** One transaction over the inbox and whatever else shares its database. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
