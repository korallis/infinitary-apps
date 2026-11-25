import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PERSISTED_FORMAT_REVISION } from "../../src/core/storage/savedDataCompatibility";
import { UPDATE_CHANNEL_MARKER } from "../../src/core/update/updateChannels";
import type { UpdateChannel } from "../../src/shared/update";

/**
 * INF-2394 measure 4: predecessor/installer filesystem formats stay beside their declared readers.
 * These deliberately older or newer bytes are the compatibility journey's input, not current state writers.
 * @journey-area src/core/storage/savedDataCompatibility.ts
 * @journey-area src/core/update/
 * @journey-area src/core/orchestrator/
 */

export function seedProtectedProfile(userDataDir: string, futureFormat: boolean): void {
  if (futureFormat)
    writeFileSync(
      join(userDataDir, "saved-data-format.json"),
      JSON.stringify({ schemaVersion: 1, revision: PERSISTED_FORMAT_REVISION + 1 }),
    );
  mkdirSync(join(userDataDir, "accounts"));
  writeFileSync(join(userDataDir, "accounts", "sentinel.json"), '{"fake":"do not change"}');
  mkdirSync(join(userDataDir, "firstmate"));
  writeFileSync(join(userDataDir, "firstmate", "conversation.jsonl"), "saved conversation\n");
}

export function writeInstallerMarker(userDataDir: string, channel: UpdateChannel): void {
  writeFileSync(
    join(userDataDir, UPDATE_CHANNEL_MARKER),
    JSON.stringify({ schemaVersion: 1, channel }),
  );
}

/** The purge must remove transcripts but retain the retired supervisor's non-session files. */
export function seedRetiredTranscripts(userDataDir: string): {
  claudeDir: string;
  supervisionDir: string;
  supervisionHome: string;
} {
  const claudeDir = join(userDataDir, "firstmate", "claude");
  const supervisionDir = join(userDataDir, "supervision", "sessions");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, "seat.jsonl"), "{}\n");
  writeFileSync(join(claudeDir, "seat.served.jsonl"), "{}\n");
  mkdirSync(supervisionDir, { recursive: true });
  writeFileSync(join(supervisionDir, "retired.jsonl"), "{}\n");
  const supervisionHome = join(userDataDir, "supervision", "home");
  mkdirSync(supervisionHome, { recursive: true });
  writeFileSync(join(supervisionHome, "keep.txt"), "stay\n");
  return { claudeDir, supervisionDir, supervisionHome };
}

/** The sign-in file the retired Cursor store keeps, exactly as it was written. */
export const RETIRED_CURSOR_AUTH = '{"accessToken":"left-behind"}';

/** Cursor is deliberately no longer offered; its old store must remain untouched. */
export function seedRetiredCursorStore(userDataDir: string, accountId: string): string {
  const store = join(userDataDir, "accounts", "cursor", accountId, ".cursor");
  mkdirSync(store, { recursive: true, mode: 0o700 });
  writeFileSync(join(store, "auth.json"), RETIRED_CURSOR_AUTH, { mode: 0o600 });
  return store;
}
