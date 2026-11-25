import { randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { ProtectedAuthority } from "./authority";
import { type CustodySlot, RootKeys, type SecretCustody } from "./custody";
import { type JournalSnapshot, UseJournal } from "./journal";
import type { RecoveryContents } from "./recoveryArchive";
import { commitSecretHome, type HomeCommit, type HomeWitness } from "./recoveryHome";
import { SecretVault } from "./vault";

/** A private staging capability, never serialized or supplied by a caller's data. */
export type StagedRecovery = {
  commit: (native: SecretCustody, expected: HomeWitness) => Promise<HomeCommit>;
  dispose: () => Promise<void>;
};

async function sync(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Build and verify a fresh sealed generation before touching native custody.
 * This in-memory key holder is staging only, never a live fallback: the stage
 * becomes usable only when native custody atomically selects it. Starting over
 * stages no archive: no values and no imported history, only the local history
 * re-keyed beside a fresh root and empty authority.
 */
export async function stageRecovery(
  base: string,
  contents: RecoveryContents | undefined,
  history: JournalSnapshot,
  now: number,
): Promise<StagedRecovery> {
  const generation = randomUUID();
  const parent = join(base, "recovered");
  const dir = join(parent, generation);
  const slots = new Map<CustodySlot, Buffer>();
  const staging: SecretCustody = {
    read: async (slot) => {
      const bytes = slots.get(slot);
      return bytes ? { kind: "value", bytes: Buffer.from(bytes) } : { kind: "absent" };
    },
    write: async (slot, bytes) => {
      slots.get(slot)?.fill(0);
      slots.set(slot, Buffer.from(bytes));
      return "stored";
    },
  };
  let keys: RootKeys | undefined;
  let created = false;
  let attempted = false;
  let spent = false;
  const dispose = async () => {
    keys?.destroy();
    for (const bytes of slots.values()) bytes.fill(0);
    slots.clear();
    // After any native attempt, retain the stage: an unknown response may have committed it.
    if (created && !attempted) await rm(dir, { recursive: true, force: true });
  };
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await mkdir(dir, { mode: 0o700 });
    created = true;
    const opened = await RootKeys.open(staging, { initialize: true, hasRecords: false });
    if (typeof opened === "string") throw new Error("Recovery staging unavailable.");
    keys = opened;
    const authority = await ProtectedAuthority.load(dir, keys, staging);
    if (typeof authority === "string") throw new Error("Recovery staging unavailable.");
    const vault = new SecretVault(dir, keys, () => now);
    for (const entry of contents?.values ?? []) {
      const bytes = Buffer.from(entry.value, "base64");
      try {
        await vault.put(entry.ref, entry.label, bytes, {
          discoverable: entry.discoverable,
          environment: entry.environment,
          ...(entry.forProgram ? { forProgram: true as const } : {}),
          ...(entry.consumer ? { consumer: entry.consumer } : {}),
        });
        const read = await vault.open(entry.ref);
        try {
          if (!read?.value.equals(bytes))
            throw new Error("Recovery staging could not be verified.");
        } finally {
          read?.value.fill(0);
        }
      } finally {
        bytes.fill(0);
      }
    }
    await UseJournal.restore(
      dir,
      keys,
      history,
      contents && {
        id: randomUUID(),
        home: contents.sourceHome,
        at: now,
        uses: contents.history.map((item) => ({
          ...item,
          ...(item.state === "waiting"
            ? { state: "invalidated" as const, reconciled: true as const }
            : item.state === "executing"
              ? { state: "unknown" as const, reconciled: true as const }
              : {}),
        })),
      },
    );
    if ((contents?.values.length ?? 0) > 0) await sync(join(dir, "values"));
    await sync(dir);
    await sync(parent);
    await sync(base);
    return {
      commit: async (native, expected) => {
        if (spent) return "invalid";
        spent = true;
        const root = slots.get("root");
        const head = slots.get("authority-head");
        if (!root || !head) return "invalid";
        attempted = true;
        const result = await commitSecretHome(native, expected, { generation, root, head });
        if (result !== "committed" && result !== "unknown") attempted = false;
        return result;
      },
      dispose,
    };
  } catch {
    await dispose();
    throw new Error("Recovery staging could not be completed.");
  }
}
