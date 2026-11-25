import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The newest non-database format revision this build reads. Advance it
 * before any incompatible non-database format is written. A folder is marked
 * with the newest revision whose format it holds, so a build from before
 * that revision refuses it.
 */
export const PERSISTED_FORMAT_REVISION = 2;
/** What a folder holds until a later revision's format is first written in it. */
const BASE_FORMAT_REVISION = 1;
/**
 * Revision 2: an account record may be a further Claude login (`ownLogin`),
 * which a build from before it would run on the computer's default login.
 */
const FURTHER_LOGINS_FORMAT_REVISION = 2;
export const SAVED_DATA_REFUSAL_TITLE = "This version cannot open your saved work";
export const SAVED_DATA_REFUSAL_MESSAGE =
  "Your saved work was opened by a newer version of Infinitary. Keep or reinstall a compatible alpha version, or wait for a compatible stable version. Your saved work has not been changed.";

export class UnsupportedSavedDataError extends Error {
  readonly code = "unsupported-saved-data";
  constructor(readonly reason: "database" | "persisted-format") {
    super(SAVED_DATA_REFUSAL_MESSAGE);
    this.name = "UnsupportedSavedDataError";
  }
}

const FORMAT_FILE = "saved-data-format.json";

/** The marked revision: the base one when no marker is there; malformed or unknown is never guessed. */
function markedRevision(userDataDir: string): number {
  const path = join(userDataDir, FORMAT_FILE);
  if (!existsSync(path)) return BASE_FORMAT_REVISION;
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).sort().join(",") !== "revision,schemaVersion" ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("revision" in value) ||
    typeof value.revision !== "number" ||
    !Number.isInteger(value.revision) ||
    value.revision < BASE_FORMAT_REVISION ||
    value.revision > PERSISTED_FORMAT_REVISION
  ) {
    throw new Error("unsupported format");
  }
  return value.revision;
}

function writeMarker(userDataDir: string, revision: number): void {
  const path = join(userDataDir, FORMAT_FILE);
  const pending = `${path}.tmp`;
  writeFileSync(pending, `${JSON.stringify({ schemaVersion: 1, revision })}\n`, { mode: 0o600 });
  renameSync(pending, path);
}

/** Missing is the supported legacy format; every revision up to this build's is read as it is. */
export function assertPersistedFormatsSupported(userDataDir: string): void {
  try {
    markedRevision(userDataDir);
  } catch {
    throw new UnsupportedSavedDataError("persisted-format");
  }
}

/** Only after compatibility succeeds and database initialization completes. */
export function recordPersistedFormat(userDataDir: string): void {
  if (existsSync(join(userDataDir, FORMAT_FILE))) return;
  writeMarker(userDataDir, BASE_FORMAT_REVISION);
}

/**
 * Marks whether the folder holds a further Claude login. Call it with
 * `true` before the first such account record is saved, so no older build
 * ever reads one, and with `false` once none is left, which hands the folder
 * back to older builds. A marker this build cannot read is left as it is.
 */
export function markFurtherLoginsFormat(userDataDir: string, held: boolean): void {
  let marked: number;
  try {
    marked = markedRevision(userDataDir);
  } catch {
    return;
  }
  if (held && marked < FURTHER_LOGINS_FORMAT_REVISION) {
    writeMarker(userDataDir, FURTHER_LOGINS_FORMAT_REVISION);
  } else if (!held && marked === FURTHER_LOGINS_FORMAT_REVISION) {
    writeMarker(userDataDir, BASE_FORMAT_REVISION);
  }
}
