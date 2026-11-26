import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { CUT_OFF_CLASSES } from "@shared/authFailure";
import type { CredentialStamp } from "../accounts/credentialHealth";
import type { AccountRecord } from "./accountVault";

/**
 * Writes the accounts registry: staged whole, with its permissions, and put
 * in place in one step, so a save that fails leaves the registry on disk as
 * it was. `AccountVault` is its one writer.
 */
export function saveRegistryFile(path: string, registry: unknown): void {
  const staged = `${path}.pending`;
  try {
    writeFileSync(
      staged,
      `${JSON.stringify(registry, null, 2)}
`,
      { mode: 0o600 },
    );
    chmodSync(staged, 0o600);
    renameSync(staged, path);
  } finally {
    rmSync(staged, { force: true });
  }
}

/**
 * A row as read from disk, its cut-off kept only in a shape this build
 * knows. A row from before the field has none, which is no cut-off.
 */
export function withReadableCutOff(account: AccountRecord): AccountRecord {
  const { cutOff, ...rest } = account;
  if (cutOff === undefined) return account;
  const known =
    cutOff !== null &&
    typeof cutOff === "object" &&
    CUT_OFF_CLASSES.includes(cutOff.class) &&
    typeof cutOff.since === "number" &&
    (cutOff.resetsAt === undefined || typeof cutOff.resetsAt === "number") &&
    (cutOff.leftPercent === undefined || typeof cutOff.leftPercent === "number") &&
    cutOff.stamp !== null &&
    typeof cutOff.stamp === "object";
  if (!known) return rest;
  const stamp: CredentialStamp = {};
  for (const part of ["login", "written", "client"] as const) {
    const value = cutOff.stamp[part];
    if (typeof value === "string") stamp[part] = value;
  }
  return { ...rest, cutOff: { ...cutOff, stamp } };
}
