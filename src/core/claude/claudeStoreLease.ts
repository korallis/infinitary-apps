/**
 * One live-session count and one slot for client operations on each Claude
 * login store: the default one, and each further login's own folder.
 * Sessions renew themselves; an idle rejection may ask status
 * once through the same slot as login, logout and catalog reads. A refresh
 * token is single use, so the check and claim are synchronous, and a client
 * attach waits for the slot before it starts. Background operations never
 * queue behind the slot or a live session.
 */

type LeaseState = {
  /** Live client sessions holding the store open. */
  readers: number;
  /** A one-shot store task is running right now. */
  writer: boolean;
  /** Resolvers waiting for the current writer to finish. */
  waiting: (() => void)[];
};

const leases = new Map<string, LeaseState>();

function stateFor(configDir: string): LeaseState {
  let state = leases.get(configDir);
  if (!state) {
    state = { readers: 0, writer: false, waiting: [] };
    leases.set(configDir, state);
  }
  return state;
}

function releaseWriter(state: LeaseState): void {
  state.writer = false;
  const waiting = state.waiting;
  state.waiting = [];
  for (const resolve of waiting) resolve();
}

export type StoreLeaseRefusal = "session_active" | "store_busy";

export type StoreLeaseResult<T> =
  | { ran: true; value: T }
  | { ran: false; refusal: StoreLeaseRefusal };

/**
 * Hold the store open for one live client session. Waits out an in-flight
 * one-shot task (bounded by that task's own timeout) so a session never starts
 * while the store is mid-rewrite, then registers before any client is spawned.
 */
export async function acquireSessionLease(configDir: string): Promise<() => void> {
  const state = stateFor(configDir);
  while (state.writer) {
    await new Promise<void>((resolve) => state.waiting.push(resolve));
  }
  state.readers += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.readers = Math.max(0, state.readers - 1);
  };
}

/** Whether a live client session currently holds this account's store. */
export function hasActiveSession(configDir: string): boolean {
  return (leases.get(configDir)?.readers ?? 0) > 0;
}

/**
 * Run a one-shot store task only if the store is free RIGHT NOW, and never
 * behind a live session. The check and the claim happen in one tick, so the
 * caller cannot lose a race between deciding and spawning.
 */
export async function tryExclusiveStoreTask<T>(
  configDir: string,
  task: () => Promise<T>,
): Promise<StoreLeaseResult<T>> {
  const state = stateFor(configDir);
  if (state.readers > 0) return { ran: false, refusal: "session_active" };
  if (state.writer) return { ran: false, refusal: "store_busy" };
  state.writer = true;
  try {
    return { ran: true, value: await task() };
  } finally {
    releaseWriter(state);
  }
}

/**
 * Run a one-shot store task, waiting for another one to finish. Used by the
 * user-initiated paths (login, logout), which must happen rather than defer.
 * It still never overlaps another store task.
 */
export async function runExclusiveStoreTask<T>(
  configDir: string,
  task: () => Promise<T>,
): Promise<T> {
  const state = stateFor(configDir);
  while (state.writer) {
    await new Promise<void>((resolve) => state.waiting.push(resolve));
  }
  state.writer = true;
  try {
    return await task();
  } finally {
    releaseWriter(state);
  }
}

/** Test seam: forget every lease. Never called in production. */
export function resetStoreLeasesForTest(): void {
  leases.clear();
}
