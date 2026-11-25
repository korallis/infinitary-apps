import { z } from "zod";

/**
 * The reporting connection a person adds in Settings → Intelligence
 * (docs/usage-report.md, "The person's reporting connection"): an
 * OTLP/HTTP address, its headers kept in Secrets, and the one format the
 * tool reading it takes. A view never carries a header's value.
 */

export const USAGE_CONNECTION_FORMATS = ["standard", "claude-code"] as const;
export const usageConnectionFormatSchema = z.enum(USAGE_CONNECTION_FORMATS);
export type UsageConnectionFormat = z.infer<typeof usageConnectionFormatSchema>;

export const usageConnectionViewSchema = z
  .object({
    /** The address as saved: OTLP/HTTP's base, each signal under its `/v1/<signal>` path. */
    endpoint: z.string(),
    format: usageConnectionFormatSchema,
    headers: z.array(z.object({ name: z.string() })),
  })
  .nullable();
export type UsageConnectionView = z.infer<typeof usageConnectionViewSchema>;

export const usageConnectionSaveSchema = z.object({
  endpoint: z.string().max(4096),
  format: usageConnectionFormatSchema,
  /**
   * Each header by name; a header with no value keeps the value saved under
   * that name, at the same address only.
   */
  headers: z
    .array(z.object({ name: z.string().max(128), value: z.string().max(8192).optional() }))
    .max(20),
});
export type UsageConnectionSave = z.infer<typeof usageConnectionSaveSchema>;

/**
 * Why a save was refused, a closed set the form words: the address cannot
 * be used, is plain http away from this computer, cannot be found or points
 * somewhere the app does not connect to; a header is not one the app
 * sends, or one with no value is new; this computer keeps no secrets, or
 * Secrets could not keep a header now.
 */
export const USAGE_CONNECTION_PROBLEMS = [
  "address",
  "plain-http",
  "not-found",
  "destination",
  "header",
  "header-value",
  "no-secrets",
  "secrets-locked",
] as const;
export const usageConnectionProblemSchema = z.enum(USAGE_CONNECTION_PROBLEMS);
export type UsageConnectionProblem = z.infer<typeof usageConnectionProblemSchema>;

export const usageConnectionSavedSchema = z.discriminatedUnion("saved", [
  z.object({ saved: z.literal(true), view: usageConnectionViewSchema }),
  z.object({ saved: z.literal(false), problem: usageConnectionProblemSchema }),
]);
export type UsageConnectionSaved = z.infer<typeof usageConnectionSavedSchema>;
