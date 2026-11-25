import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { secretConsumerSchema, secretHistorySchema, secretRefSchema } from "@shared/secrets";
import { z } from "zod";
import { canonical } from "./custody";

// File-format fields, not resource limits. The key is independent of native custody.
const MAGIC = Buffer.from("infinitary-secrets-recovery/1\n");
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const base64 = z.string().refine((value) => {
  const decoded = Buffer.from(value, "base64");
  try {
    return decoded.length > 0 && decoded.toString("base64") === value;
  } finally {
    decoded.fill(0);
  }
});

const recoveryValueSchema = z.strictObject({
  ref: secretRefSchema,
  label: z.string().trim().min(1),
  discoverable: z.boolean(),
  environment: z.string().optional(),
  forProgram: z.literal(true).optional(),
  consumer: secretConsumerSchema.optional(),
  value: base64,
});
/** Private archive contents. No permission, enrollment, native root or live approval is exported. */
const recoveryContentsSchema = z.strictObject({
  format: z.literal(1),
  createdAt: z.number().finite(),
  sourceHome: z.string().min(1),
  values: z.array(recoveryValueSchema),
  // Recovered history is evidence from the archive, never a live receipt or authority.
  history: z.array(secretHistorySchema),
});
/**
 * What an archive may hold: an older one's values may also carry the project and
 * computer discovery links that organized them. They are checked as part of the
 * authenticated archive, then left behind; an archive written now has none.
 */
const archivedContentsSchema = recoveryContentsSchema.extend({
  values: z.array(
    recoveryValueSchema.extend({
      links: z
        .array(z.strictObject({ project: z.string().min(1), device: z.string().min(1) }))
        .optional(),
    }),
  ),
});
export type RecoveryContents = z.infer<typeof recoveryContentsSchema>;
export type RecoveryFiles = { archive: Buffer; key: Buffer };

function unique(contents: RecoveryContents): RecoveryContents {
  const refs = new Set(contents.values.map(({ ref }) => ref));
  if (refs.size !== contents.values.length) throw new Error("Repeated recovery reference.");
  return contents;
}

function checked(contents: unknown): RecoveryContents {
  const result = recoveryContentsSchema.safeParse(contents);
  if (!result.success) throw new Error("Invalid recovery contents.");
  return unique(result.data);
}

function archived(contents: unknown): RecoveryContents {
  const result = archivedContentsSchema.safeParse(contents);
  if (!result.success) throw new Error("Invalid recovery contents.");
  return unique({
    ...result.data,
    values: result.data.values.map(({ links: _links, ...value }) => value),
  });
}

/** Trusted owner only: give both buffers to its native file writer, never IPC, AXI or a card. */
export function sealRecovery(contents: RecoveryContents): RecoveryFiles {
  const body = Buffer.from(canonical(checked(contents)));
  const key = randomBytes(KEY_BYTES);
  try {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(MAGIC);
    const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
    return { archive: Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), encrypted]), key };
  } catch {
    key.fill(0);
    throw new Error("Recovery files could not be created.");
  } finally {
    body.fill(0);
  }
}

/** Authentication and schema validation finish before the caller may stage or change any store. */
export function openRecovery(archive: Buffer, key: Buffer): RecoveryContents | undefined {
  if (key.length !== KEY_BYTES) return undefined;
  const bodyStart = MAGIC.length + NONCE_BYTES + TAG_BYTES;
  if (archive.length <= bodyStart || !archive.subarray(0, MAGIC.length).equals(MAGIC))
    return undefined;
  let partial: Buffer | undefined;
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      archive.subarray(MAGIC.length, MAGIC.length + NONCE_BYTES),
    );
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(archive.subarray(MAGIC.length + NONCE_BYTES, bodyStart));
    partial = decipher.update(archive.subarray(bodyStart));
    plaintext = Buffer.concat([partial, decipher.final()]);
    return archived(JSON.parse(plaintext.toString("utf8")));
  } catch {
    // The caller gets one refusal, never parser output that could contain an archived value.
    return undefined;
  } finally {
    partial?.fill(0);
    plaintext?.fill(0);
  }
}

/** Clear the private objects as far as JS permits; immutable strings remain subject to GC. */
export function clearRecovery(contents: RecoveryContents): void {
  for (const value of contents.values) value.value = "";
  contents.values.length = 0;
  contents.history.length = 0;
}
