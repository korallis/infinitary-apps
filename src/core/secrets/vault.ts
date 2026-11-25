import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { type SecretConsumer, secretConsumerSchema, secretRefSchema } from "@shared/secrets";
import { canonical, type RootKeys, sha256, writePrivateFile } from "./custody";

/** Metadata only. A label is the captain's own words; `version` rises on every replacement. */
export type VaultEntry = {
  ref: string;
  label: string;
  version: number;
  /** Opaque identity of this exact sealed record, including a recreated entry at the same version. */
  revision: string;
  /** Whether agents may discover and request it. New entries start hidden. */
  discoverable: boolean;
  updatedAt: number;
  /** The captain's own label for where it belongs, such as staging; never authority. */
  environment?: string;
  /**
   * A hidden entry an app service keeps for a program it starts, such as an
   * MCP server's key (docs/secrets.md, "Programs that keep running"): its uses
   * ask and its saved decisions apply, unlike an app sign-in's.
   */
  forProgram?: true;
  /**
   * The app service a hidden entry belongs to, when it is not an Integrations
   * sign-in: the person's reporting connection's header (docs/secrets.md,
   * "App sign-ins"), so Settings names it and its service can sweep one it
   * no longer names.
   */
  consumer?: SecretConsumer;
};

export type SecretMetadataInput = {
  discoverable?: boolean;
  environment?: string;
  forProgram?: true;
  consumer?: SecretConsumer;
};

/**
 * A record as sealed. An older record may also carry organizational discovery
 * links: they stay in its authenticated bytes and are never read as metadata.
 */
type Stored = { entry: Omit<VaultEntry, "revision">; mac: string; sealed: string };

/**
 * Derived, not persisted: old sealed records retain their authenticated encoding,
 * and only the fields this version understands leave the record.
 */
function metadata(stored: Stored): VaultEntry {
  const { ref, label, version, discoverable, updatedAt, environment, forProgram, consumer } =
    stored.entry;
  return {
    ref,
    label,
    version,
    revision: sha256(canonical(stored)),
    discoverable,
    updatedAt,
    ...(environment !== undefined ? { environment } : {}),
    ...(forProgram === true ? { forProgram } : {}),
    ...(consumer !== undefined ? { consumer } : {}),
  };
}

export function validRef(ref: unknown): ref is string {
  return secretRefSchema.safeParse(ref).success;
}

/**
 * Sealed values on disk (docs/secrets.md, "The vault"). Each value is
 * AES-256-GCM under the root's value key, bound to its own metadata, and each
 * record's metadata carries its own check so a relabelled or re-versioned file
 * is refused rather than shown. Replacement is atomic and versioned. There is no
 * reveal: `open` serves the owner's delivery to an approved recipient only.
 */
export class SecretVault {
  constructor(
    private readonly dir: string,
    private readonly keys: RootKeys,
    private readonly now: () => number = Date.now,
  ) {}

  static async hasRecords(dir: string): Promise<boolean> {
    try {
      return (await readdir(join(dir, "values"))).some((name) => name.endsWith(".json"));
    } catch (error) {
      // An unreadable folder is not proof that it is safe to initialize custody.
      return (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
  }

  /** Every intact record's metadata. A record that fails its check is left out, never repaired. */
  async list(): Promise<VaultEntry[]> {
    const entries: VaultEntry[] = [];
    for (const file of await recordFiles(join(this.dir, "values"))) {
      const stored = await this.read(join(this.dir, "values", file));
      if (stored) entries.push(metadata(stored));
    }
    return entries.sort((a, b) => a.ref.localeCompare(b.ref));
  }

  /** Recovery cannot silently omit a damaged or unreadable value file. */
  async recoveryEntries(): Promise<VaultEntry[] | undefined> {
    let files: string[];
    try {
      files = await readdir(join(this.dir, "values"));
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : undefined;
    }
    const entries: VaultEntry[] = [];
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      const stored = await this.read(join(this.dir, "values", file));
      if (!stored) return undefined;
      entries.push(metadata(stored));
    }
    return entries.sort((a, b) => a.ref.localeCompare(b.ref));
  }

  async entry(ref: string): Promise<VaultEntry | undefined> {
    if (!validRef(ref)) return undefined;
    const stored = await this.read(this.path(ref));
    return stored ? metadata(stored) : undefined;
  }

  /** Add or replace a value: trusted secure entry only, never an agent operation. */
  async put(
    ref: string,
    label: string,
    value: Buffer,
    options: SecretMetadataInput = {},
  ): Promise<VaultEntry> {
    if (!validRef(ref)) throw new Error("Invalid secret reference.");
    if (typeof label !== "string" || label.trim().length === 0) throw new Error("Invalid label.");
    if (value.length === 0) throw new Error("A secret needs a value.");
    const previous = (await this.read(this.path(ref)))?.entry;
    const entry: Stored["entry"] = {
      ref,
      label: label.trim(),
      version: (previous?.version ?? 0) + 1,
      discoverable: options.discoverable ?? previous?.discoverable ?? false,
      updatedAt: this.now(),
      ...(options.environment !== undefined
        ? { environment: options.environment }
        : previous?.environment === undefined
          ? {}
          : { environment: previous.environment }),
      ...((options.forProgram ?? previous?.forProgram) ? { forProgram: true as const } : {}),
      ...((options.consumer ?? previous?.consumer)
        ? { consumer: options.consumer ?? previous?.consumer }
        : {}),
    };
    const text = canonical(entry);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.keys.key("values"), iv);
    cipher.setAAD(Buffer.from(text));
    const body = Buffer.concat([cipher.update(value), cipher.final()]);
    const sealed = Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
    const stored: Stored = { entry, mac: this.keys.mac("entries", text), sealed };
    await writePrivateFile(this.path(ref), JSON.stringify(stored));
    return metadata(stored);
  }

  /** The owner's delivery read. The caller zeroes the buffer when the recipient has it. */
  async open(ref: string): Promise<{ entry: VaultEntry; value: Buffer } | undefined> {
    if (!validRef(ref)) return undefined;
    const stored = await this.read(this.path(ref));
    if (!stored) return undefined;
    const raw = Buffer.from(stored.sealed, "base64");
    if (raw.length < 29) return undefined;
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.keys.key("values"),
        raw.subarray(0, 12),
      );
      decipher.setAAD(Buffer.from(canonical(stored.entry)));
      decipher.setAuthTag(raw.subarray(12, 28));
      const value = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
      return { entry: metadata(stored), value };
    } catch {
      return undefined;
    }
  }

  /** Local forgetting. It does not revoke a copy a recipient made or the provider's credential. */
  async remove(ref: string): Promise<void> {
    if (!validRef(ref)) return;
    await rm(this.path(ref), { force: true });
  }

  private path(ref: string): string {
    return join(this.dir, "values", `${sha256(ref).slice(0, 32)}.json`);
  }

  private async read(path: string): Promise<Stored | undefined> {
    let parsed: Stored;
    try {
      parsed = JSON.parse(await readFile(path, "utf8")) as Stored;
    } catch {
      return undefined;
    }
    const entry = parsed?.entry;
    if (
      !entry ||
      !validRef(entry.ref) ||
      typeof entry.label !== "string" ||
      !Number.isInteger(entry.version) ||
      typeof entry.discoverable !== "boolean" ||
      (entry.forProgram !== undefined && entry.forProgram !== true) ||
      (entry.consumer !== undefined && !secretConsumerSchema.safeParse(entry.consumer).success) ||
      typeof parsed.sealed !== "string" ||
      path !== this.path(entry.ref) ||
      !this.keys.verify("entries", canonical(entry), parsed.mac)
    )
      return undefined;
    return parsed;
  }
}

async function recordFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
}
