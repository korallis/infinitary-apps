import { z } from "zod";
import { formatNumber } from "./i18n/format.ts";
import * as m from "./i18n/messages.generated.ts";

export const secretRefSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
export const secretRuleSchema = z.strictObject({
  id: z.string().min(1),
  effect: z.enum(["never", "ask", "allow"]),
  secret: secretRefSchema,
  operation: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  note: z.string().optional(),
});
export const secretStateSchema = z.enum([
  "waiting",
  "executing",
  "completed",
  "denied",
  "cancelled",
  "expired",
  "invalidated",
  "unavailable",
  "unknown",
]);
export const SECRET_STATE_WORDS: Record<z.infer<typeof secretStateSchema>, string> = {
  waiting: "Waiting for approval",
  executing: "Running",
  completed: "Completed",
  denied: "Denied",
  cancelled: "Cancelled",
  expired: "Expired",
  invalidated: "Needs a new request",
  unavailable: "Unavailable",
  unknown: "Outcome unknown",
};
/** An app service that keeps hidden entries of its own outside Integrations (docs/secrets.md, "App sign-ins"). */
export const secretConsumerSchema = z.enum(["usage-report"]);
export type SecretConsumer = z.infer<typeof secretConsumerSchema>;

export const secretMetadataSchema = z.strictObject({
  ref: secretRefSchema,
  label: z.string(),
  version: z.number().int().positive(),
  revision: z.string().regex(/^[0-9a-f]{64}$/),
  updatedAt: z.number(),
  environment: z.string(),
  lastRequest: z.number().nullable(),
  /**
   * The title of the task that made the last request, when the home still
   * knows it: what the Secrets page names beside when.
   */
  lastTask: z.string().optional(),
  /** The last use was the captain's own Copy value (docs/secrets.md, "Copying a value"). */
  lastCopied: z.literal(true).optional(),
  /**
   * A sign-in the app keeps for one of its own services, hidden from the crew
   * (docs/secrets.md, "App sign-ins"): the page offers its Integrations row,
   * never Replace, Forget or a saved decision.
   */
  kept: z.literal(true).optional(),
  /**
   * With `kept`: a key the app keeps for a program it starts, such as an MCP
   * server's (docs/secrets.md, "Programs that keep running"). The person gave
   * it with the program, which is the consent, so its uses ask nothing.
   */
  forProgram: z.literal(true).optional(),
  /**
   * With `kept`: the app service that keeps it, when not an Integrations
   * sign-in; the page names that service and where to change it.
   */
  consumer: secretConsumerSchema.optional(),
  /**
   * With `consumer`: no saved setting of that service names it any more, so
   * the page offers Forget.
   */
  unnamed: z.literal(true).optional(),
});
export const secretUseSchema = z.strictObject({
  request: z.string(),
  state: secretStateSchema,
  reason: z.string(),
  recipient: z.string(),
  facts: z.array(z.strictObject({ name: z.string(), value: z.string() })),
  /** Each secret as the use prepared it; an empty environment means the captain gave none. */
  secrets: z.array(
    z.strictObject({
      ref: z.string(),
      label: z.string(),
      version: z.number(),
      environment: z.string(),
    }),
  ),
  shortReadEligible: z.boolean(),
  expires: z.number().nullable(),
  exitCode: z.number().optional(),
});
export const secretHistorySchema = z.strictObject({
  request: z.string(),
  intent: z.string(),
  program: z.string(),
  secrets: z.array(z.string()),
  reason: z.string(),
  requestedAt: z.number(),
  state: secretStateSchema,
  exitCode: z.number().optional(),
  approval: z.enum(["local", "remote", "rule", "short-read"]).optional(),
  /**
   * The app spent its own sign-in, made in the app, which was the consent
   * (docs/secrets.md, "App sign-ins"): no one approved it, so it has no `approval`.
   */
  signIn: z.literal(true).optional(),
  /**
   * A program started with the keys the person gave with it, which was the
   * consent (docs/secrets.md, "Programs that keep running"): no one approved
   * it, so it has no `approval`.
   */
  given: z.literal(true).optional(),
  /** The computer that runs work the program ran on, when it was not this one (docs/secrets.md, "On a computer that runs work"). */
  computer: z.string().optional(),
  /** A bring, by the tool it brought secrets from (docs/secrets.md, "Bringing secrets from another tool"). */
  brought: z.string().optional(),
  /** The captain copied the value in Settings (docs/secrets.md, "Copying a value"); no program received it. */
  copied: z.literal(true).optional(),
  device: z.string().optional(),
  reconciled: z.literal(true).optional(),
  /** Historical metadata imported from a recovery archive, never live authority. */
  recoveredFrom: z.string().optional(),
  recoveredAt: z.number().optional(),
});
export const SECRET_APPROVAL_WORDS: Record<
  NonNullable<z.infer<typeof secretHistorySchema>["approval"]>,
  string
> = {
  local: "Confirmed here",
  remote: "Confirmed on an enrolled device",
  rule: "Saved decision",
  "short-read": "Bounded read",
};
export const secretReadPermissionSchema = z.strictObject({
  id: z.string(),
  key: z.string(),
  label: z.string(),
  destination: z.string(),
  secrets: z.array(z.string()),
  expires: z.number(),
  remaining: z.number().int().nonnegative(),
});
/**
 * A device enrolled to approve uses from elsewhere (docs/secrets.md, "Remote
 * decisions"), as Settings lists it: never its key, only the code the captain
 * compared when it enrolled.
 */
export const secretApprovalDeviceSchema = z.strictObject({
  device: z.string(),
  label: z.string(),
  generation: z.number().int().positive(),
  code: z.string(),
  /** The paired device that offered this key, whose row in Settings -> Devices carries its switch. */
  paired: z.string().optional(),
  /** The question that stops its approvals is waiting for the captain. */
  stopping: z.boolean().optional(),
});
/**
 * A paired phone on its way to approving uses (docs/secrets.md, "Remote
 * decisions"): the captain turned its switch on in Settings -> Devices and the
 * home waits for it to offer its key (`waiting`), or its key's card, with the
 * code to compare, is up (`comparing`).
 */
export const secretPhoneSetupSchema = z.strictObject({
  paired: z.string(),
  state: z.enum(["waiting", "comparing"]),
  /** The card with the code to compare, while it is up. */
  card: z.string().optional(),
});
/**
 * The one question Settings asks on the row it is about (docs/secrets.md,
 * "Asking in place"): Forget on a secret's row, Remove on a saved decision,
 * Stop approvals on an approving device, and Delete history. Each answer is a
 * one-time pass the host made for this question; only this computer's window
 * reads the view and spends one through the `answer` action.
 */
export const secretQuestionSchema = z.strictObject({
  about: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("forget"), ref: secretRefSchema }),
    z.strictObject({ kind: z.literal("rule"), rule: z.string() }),
    z.strictObject({ kind: z.literal("device"), device: z.string() }),
    z.strictObject({ kind: z.literal("history") }),
  ]),
  title: z.string(),
  lines: z.array(z.string()),
  confirm: z.strictObject({ label: z.string(), pass: z.string() }),
  keep: z.strictObject({ label: z.string(), pass: z.string() }),
});
export const secretsViewSchema = z.strictObject({
  availability: z.enum([
    "not-enabled",
    "available",
    "locked",
    "unavailable",
    "uninitialized",
    "lost",
    "tampered",
  ]),
  home: z.string().nullable(),
  offeredCard: z.string().nullable(),
  /** The question waiting on its row in Settings; absent from an older home. */
  question: secretQuestionSchema.nullable().optional(),
  entries: z.array(secretMetadataSchema),
  uses: z.array(secretUseSchema),
  rules: z.array(secretRuleSchema),
  history: z.array(secretHistorySchema),
  historyBytes: z.number().nonnegative(),
  recoveryAvailable: z.boolean(),
  reads: z.array(secretReadPermissionSchema),
  devices: z.array(secretApprovalDeviceSchema),
  /** Paired phones the captain is turning on; absent from an older home. */
  phones: z.array(secretPhoneSetupSchema).optional(),
  /**
   * Whether Copy value can work here (docs/secrets.md, "Copying a value"):
   * `no-confirmation` where this computer cannot confirm the person now.
   * Absent where this computer has no private clipboard writer, or from an
   * older home, and then no row offers Copy value.
   */
  copy: z.enum(["ready", "no-confirmation"]).optional(),
  /**
   * The value Copy value last put on the clipboard, while Infinitary still
   * means to clear it: its secret and when it clears. `concealed` is false
   * where the platform's one write could not tell clipboard history tools to
   * skip it.
   */
  copied: z
    .strictObject({ ref: secretRefSchema, clears: z.number(), concealed: z.boolean() })
    .optional(),
  message: z.string().nullable(),
  /**
   * Only on the answer to a Settings entry: the record it saved, so an entry
   * whose reference the controller chose can be found in this view.
   */
  saved: z.strictObject({ ref: secretRefSchema, version: z.number().int().positive() }).optional(),
});
export const secretEntryInputSchema = z.strictObject({
  /**
   * Absent on a new entry: the controller makes a stable reference from the
   * name, never one a saved rule already names. A replacement names its own.
   */
  ref: secretRefSchema.optional(),
  label: z.string().trim().min(1),
  value: z.string().min(1),
  /** Zero adds a new entry; a replacement must still name its displayed version. */
  expectedVersion: z.number().int().nonnegative(),
  /** Null adds an absent entry; a replacement binds the exact sealed record shown by Settings. */
  expectedRevision: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  environment: z.string(),
});
export const secretRehearsalInputSchema = z.strictObject({
  argv: z.array(z.string()).min(1),
  cwd: z.string().min(1),
  env: z.record(z.string(), secretRefSchema),
});
export const secretRehearsalSchema = z
  .strictObject({
    effect: z.enum(["never", "ask", "allow"]),
    operation: z.string(),
    matched: z.array(z.string()),
    facts: z.array(z.strictObject({ name: z.string(), value: z.string() })),
  })
  .nullable();
export const secretActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("unlock") }),
  z.strictObject({ kind: z.literal("review-use"), request: z.string() }),
  z.strictObject({ kind: z.literal("cancel-use"), request: z.string() }),
  z.strictObject({ kind: z.literal("end-read"), id: z.string() }),
  z.strictObject({ kind: z.literal("save-rules"), rules: z.array(secretRuleSchema) }),
  z.strictObject({ kind: z.literal("forget"), ref: secretRefSchema }),
  z.strictObject({ kind: z.literal("delete-history") }),
  z.strictObject({ kind: z.literal("backup-recovery") }),
  z.strictObject({ kind: z.literal("restore-recovery") }),
  // Only where storage reads lost or tampered: a fresh, empty store under fresh confirmation.
  z.strictObject({ kind: z.literal("start-over") }),
  z.strictObject({ kind: z.literal("forget-device"), device: z.string() }),
  // Settings -> Devices' switch on a paired phone: ask it to offer its key, or stop asking.
  z.strictObject({ kind: z.literal("ask-phone"), paired: z.string().min(1).max(64) }),
  z.strictObject({ kind: z.literal("cancel-phone"), paired: z.string().min(1).max(64) }),
  // The answer to the question on a Settings row: the one-time pass the view carried.
  z.strictObject({ kind: z.literal("answer"), pass: z.string().min(1).max(64) }),
  // Copy value on a secret's row, bound to the record the row shows; the answer never holds the value.
  z.strictObject({
    kind: z.literal("copy"),
    ref: secretRefSchema,
    version: z.number().int().positive(),
    revision: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  // Clear now: takes the copied value off the clipboard while it still holds it.
  z.strictObject({ kind: z.literal("clear-copy") }),
]);

/**
 * A phone's own name for its approval capability: a random id it keeps beside
 * its approval key, so a new key re-enrolls the same device at a higher
 * generation. An id, never authority: the signature is the gate.
 */
export const approvalDeviceIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
/** What a phone asks: its own enrollment and the uses waiting now. */
export const secretApprovalsInputSchema = z.strictObject({ device: approvalDeviceIdSchema });
export const secretApprovalsSchema = z.strictObject({
  availability: secretsViewSchema.shape.availability,
  /** The enforcing home a decision names; null until storage opens. */
  home: z.string().nullable(),
  /** This device's enrollment, with the key the computer holds for it. */
  device: z
    .strictObject({
      label: z.string(),
      generation: z.number().int().positive(),
      /** SPKI DER, base64: the phone compares it with its own key. */
      key: z.string(),
    })
    .nullable(),
  /** An enrollment offer from this device is waiting on the computer. */
  offered: z.boolean(),
  /**
   * The captain turned on this paired device's switch in Settings -> Devices,
   * so it offers its key now; absent from an older home.
   */
  asked: z.boolean().optional(),
  waiting: z.array(
    z.strictObject({
      request: z.string(),
      /** The approval card the computer raised for this use, when it raised one. */
      card: z.string().nullable(),
      digest: z.string(),
      expires: z.number(),
      /** The challenge this device signs; null unless this device is enrolled. */
      nonce: z.string().nullable(),
      reason: z.string(),
      recipient: z.string(),
      /** The title of the task that asked, as the approval card names it; null when no task asked. */
      task: z.string().nullable().optional(),
      /**
       * Each secret as the use prepared it: its name, with the environment label
       * and reference that tell two of one name apart. An empty environment
       * means the captain gave none.
       */
      secrets: z.array(
        z.strictObject({
          ref: secretRefSchema,
          label: z.string(),
          version: z.number(),
          environment: z.string(),
          /**
           * The name the computer's card gives it, among every saved secret
           * (`secretNames.secretName`), so the phone names it the same way.
           * An older computer sends none.
           */
          name: z.string().optional(),
        }),
      ),
      /** The checked facts the approval card lists, in its order. */
      facts: z.array(z.strictObject({ name: z.string(), value: z.string() })),
    }),
  ),
});
/** An enrollment offer: the captain confirms it on the computer before it counts. */
export const secretEnrollInputSchema = z.strictObject({
  device: approvalDeviceIdSchema,
  label: z.string().min(1).max(64),
  /** P-256 SPKI DER, base64. */
  key: z.string().min(1).max(512),
});
/** A phone's decision: an Allow signed by its enrolled key, or a refusal, which needs none. */
export const secretDecisionInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("allow"),
    request: z.string(),
    device: approvalDeviceIdSchema,
    generation: z.number().int().positive(),
    nonce: z.string().min(1).max(128),
    /** ECDSA P-256 over SHA-256 of the decision message, DER, base64. */
    signature: z.string().min(1).max(256),
  }),
  z.strictObject({ kind: z.literal("deny"), request: z.string() }),
]);
export const secretDecisionSchema = z.strictObject({ state: secretStateSchema });
export type SecretsView = z.infer<typeof secretsViewSchema>;
export type SecretEntryInput = z.infer<typeof secretEntryInputSchema>;
export type SecretAction = z.infer<typeof secretActionSchema>;
export type SecretRehearsalInput = z.infer<typeof secretRehearsalInputSchema>;
export type SecretRehearsal = z.infer<typeof secretRehearsalSchema>;
export type SecretApprovals = z.infer<typeof secretApprovalsSchema>;
export type SecretApprovalsInput = z.infer<typeof secretApprovalsInputSchema>;
export type SecretEnrollInput = z.infer<typeof secretEnrollInputSchema>;
export type SecretDecisionInput = z.infer<typeof secretDecisionInputSchema>;
export type SecretDecision = z.infer<typeof secretDecisionSchema>;

/**
 * How long a value Copy value put on the clipboard stays there before
 * Infinitary clears it: the captain's choice of 90 seconds on the plan.
 */
export const SECRET_COPY_SECONDS = 90;

/**
 * The start of a Settings item that opens one secret's row (`settingsItem`),
 * followed by the secret's name or reference: the first mate's
 * `secrets-page` offer for a value the captain reads back with Copy value.
 */
export const SECRET_ROW_ITEM = "secret:";

/** Captain's bounded-read choice, shared by enforcement and its visible permission label. */
export const SHORT_READ_SECONDS = 600;
export const SHORT_READ_USES = 20;

/**
 * The disclosures on the Secrets management page.
 */
export const SECRETS_AREAS = [
  { value: "decisions", label: "Saved decisions" },
  { value: "phone", label: "Approving devices" },
  { value: "history", label: "Use history" },
  { value: "copy", label: "Backup and restore" },
] as const;

/**
 * Copy value's words (docs/secrets.md, "Copying a value"): the row's button,
 * its status line and the controller's answers. None names a value.
 */
export const SECRET_COPY_WORDS = {
  get copy() {
    return m.settingsSecretsCopyValue();
  },
  get clearNow() {
    return m.settingsSecretsClearNow();
  },
  /** The row's status while the copied value is on the clipboard; `concealed` false where history tools were not told to skip it. */
  copiedUntil: (time: string, concealed: boolean) =>
    concealed
      ? m.settingsSecretsCopiedUntil({ time })
      : m.settingsSecretsCopiedUntilVisible({ time }),
  get cannotConfirm() {
    return m.settingsSecretsCopyCannotConfirm();
  },
  /** A row's last-use line when its last use was a copy. */
  copiedOn: (when: string) => m.settingsSecretsCopiedOn({ when }),
  /** Use history's line for a copy, where a use names its program. */
  get byYou() {
    return m.settingsSecretsCopiedByYou();
  },
  /** The system confirmation's reason, naming the secret as Settings names it. */
  reason: (name: string) => m.settingsSecretsCopyReason({ name }),
  get refused() {
    return m.settingsSecretsCopyRefused();
  },
  get changed() {
    return m.settingsSecretsCopyChanged();
  },
  get unavailable() {
    return m.settingsSecretsCopyUnavailable();
  },
  get unknown() {
    return m.settingsSecretsCopyUnknown();
  },
  get cleared() {
    return m.settingsSecretsCopyCleared();
  },
};

export const SECRETS_WORDS = {
  title: "Secrets",
  protected: "Protected secrets",
  signedInSites: "Signed-in sites",
  management: "Access, history & recovery",
  access: "Access",
  historyAndRecovery: "History and recovery",
  /**
   * On Linux any program the person runs can read the unlocked secret store
   * (docs/secrets.md, "Native custody"), so only a Mac promises the crew never
   * sees a value.
   */
  custody: (mac: boolean) =>
    mac
      ? m.settingsSecretsCustodyMac()
      : "Kept on this computer. Your crew uses them only with your approval, but any program you run can reach them while your system's secret store is unlocked.",
  disabled: "Protected storage is not enabled in this build.",
  unavailable: "Secrets could not open its protected storage. No access was granted.",
  stale: "This secret changed. Read its current version before replacing it.",
  saved: "Secret saved. New uses ask for approval.",
  value: "Secret value",
  nameRequired: "Enter a name for this secret.",
  valueRequired: "Enter the secret value.",
  name: "Name",
  place: "Place (optional)",
  placeHint: "For example, staging or production",
  save: "Save secret",
  historyRegion: "Secrets history",
  add: "Add secret",
  replace: "Replace",
  forget: "Forget",
  /** What happened's line for a use an app sign-in covered (`signIn`). */
  yourSignIn: "Your sign-in",
  get once() {
    return m.secretsAllowOnce();
  },
  get always() {
    return m.secretsAllowAlways();
  },
  get short() {
    return m.secretsAllowShort({ minutes: SHORT_READ_SECONDS / 60 });
  },
  get deny() {
    return m.secretsDeny();
  },
  waiting: "Review request",
  waitingFor: (names: string) =>
    `${names} ${names.includes(", ") ? "are" : "is"} waiting for your answer.`,
  end: "End access",
  devicesRegion: "Devices that approve uses",
  noDevices:
    "No phone or Mac approves uses. To add one, turn on Approves secret uses beside it in Settings → Devices.",
  stopApprovals: "Stop approvals",
  history: "History stays here until you delete it. Exports contain metadata, never secret values.",
  get noReveal() {
    return m.settingsSecretsNoReveal();
  },
  search: "Search secrets",
  noMatch: "No matching secrets.",
  noneYet: "No secrets added yet.",
  waitingStorage: "Secrets will appear when storage is available.",
  decisionsRegion: "Saved decisions",
  noDecisions: "No saved decisions. Every use asks you first.",
  remove: "Remove",
  notUsed: "Not used yet",
  inUse: "In use now",
  waitingRow: "Waiting for your answer",
  readingUntil: (time: string) => `Reading until ${time}`,
  used: (when: string, task?: string) => (task ? `Used ${when} by ${task}` : `Used ${when}`),
  today: "today",
  yesterday: "yesterday",
  noPhone: "Not set up",
  historySummary: (count: number, newest: string) =>
    `${count} ${count === 1 ? "use" : "uses"}, newest ${newest}`,
  noHistory: "Nothing yet",
  storageUse: (size: string) => `${size} kept on this computer`,
} as const;

/** A saved decision as one sentence; the run is the one its approval card named, when it named one. */
export function decisionWords(rule: z.infer<typeof secretRuleSchema>, name: string): string {
  const run = rule.note ?? "one exact run";
  if (rule.effect === "never")
    return rule.operation ? `Never give ${name} to ${run}.` : `Never give ${name} to anyone.`;
  if (rule.effect === "allow") return `Always give ${name} to ${run}.`;
  return rule.operation
    ? `Ask before giving ${name} to ${run}.`
    : `Ask before giving ${name} to anyone.`;
}

export const SECRETS_RECOVERY_WORDS = {
  region: "Secrets recovery",
  recoveredHistory: "Recovered history, not a current approval",
  reconciledAfterRestart: "checked after restart",
  saveButton: "Save encrypted backup",
  restoreButton: "Restore from backup",
  /** The notice where storage reads lost or tampered, such as a data folder removed beside its custody. */
  needed:
    "Infinitary can no longer read the secrets and saved decisions kept on this computer, so no use is allowed. Restore them from a backup, or start over with an empty list.",
  options: "Recovery options",
  startOverButton: "Start over",
  /** Beside Start over: what it resets, since a platform's own confirmation may not say. */
  startOverNote:
    "Start over clears your stored secrets, saved decisions, phone approvals and temporary access, and it cannot be undone.",
  startOver: {
    started:
      "Secrets started over with an empty list. Add each secret again; every use asks you first. History was kept.",
    unneeded: "Secrets can already be used, so nothing changed.",
    refused: "Secrets did not start over. Confirmation was not accepted.",
    busy: "Wait for running secret uses and their results to finish before starting over.",
    changed:
      "Protected storage changed while starting over, so Secrets did not start over. Check what Secrets shows before trying again.",
    locked: "Protected storage is locked. Unlock it before starting over.",
    unavailable: "Secrets did not start over. Nothing changed.",
    unknown:
      "Whether Secrets started over is unknown. Check what Secrets shows before doing anything else, and do not start over again until then.",
  },
  unavailable:
    "Recovery files are available only in this computer's native app when Secrets is enabled.",
  choosing: "Finish the open recovery dialog first.",
  cancelled: "No recovery files selected. Nothing changed.",
  unreadable: "The recovery files could not be read. No restore was attempted.",
  save: {
    saved:
      "Encrypted archive and recovery key saved. Keep the key separately; there is no key reset.",
    partial:
      "The backup did not finish. Newly created files remain at your chosen locations. Keep any earlier working backup and key.",
    cancelled: "No recovery files saved.",
    unavailable:
      "No complete backup was saved. Choose new, writable file names; existing files are never replaced.",
    refused: "No recovery files saved. Confirmation was not accepted.",
    unknown:
      "The save result is unknown. Check both chosen locations before trying again; existing files will not be replaced.",
  },
  restore: {
    restored:
      "Secrets restored. Rules, device approvals and temporary access were reset. History was kept; archived history cannot authorize a use.",
    refused: "Secrets were not restored. Confirmation was not accepted.",
    invalid: "The archive and key do not match, or the archive is damaged. Nothing changed.",
    busy: "Wait for running secret uses and their results to finish before restoring.",
    changed:
      "Protected storage changed while restoring. The staged copy was not activated; read the current entries before trying again.",
    locked: "Protected storage is locked. The staged copy was not activated.",
    unavailable: "Restore did not finish. Current entries and saved permissions remain unchanged.",
    unknown:
      "The restore result is unknown. Check the current entries before doing anything else; do not repeat the restore without reconciling them.",
  },
} as const;

/** The words of a phone's or Mac's Secrets approvals on this computer, around the label the device offered. */
export const SECRET_DEVICE_WORDS = {
  enrollTitle: (label: string) => `Let ${label} approve Secrets uses?`,
  confirm: "Confirm and allow",
  notNow: "Not now",
  enrolled: (label: string) => `${label} can approve Secrets uses.`,
  stopTitle: (label: string) => `Stop approvals from ${label}?`,
  keep: "Keep approvals",
  stopped: (label: string) => `${label} no longer approves Secrets uses.`,
  unchanged: "Nothing changed. Confirmation failed or Secrets changed while you were deciding.",
  /** The switch on a paired phone's or Mac's row in Settings -> Devices. */
  approves: "Approves secret uses",
  on: (code: string) =>
    `Each Allow there asks for its own Face ID, Touch ID, passcode or password. Code ${code}.`,
  waiting: (name: string) => `Waiting for ${name}. Open Infinitary there to show its code.`,
  comparing: (name: string) =>
    `${name} offered its key. Check that the card's code matches the one ${name} shows.`,
  compare: "Compare codes",
  stopLines: (label: string) => [
    `${label} will no longer approve Secrets uses. Uses it could approve wait for you on this computer instead.`,
    `${label} stays paired. The system will ask you to confirm.`,
  ],
  cancelled: "The switch was turned off before this device was confirmed.",
} as const;

/** What a Mac that approves Secrets uses for another computer says in its own window. */
export const SECRET_MAC_WORDS = {
  /** The reason macOS shows beside Touch ID or the password prompt. */
  confirm: (home: string) => `allow one Secrets use on ${home}`,
  /** Added to the home's enrollment card in this Mac's window, for the comparison. */
  code: (code: string) => `This Mac shows the code ${code}.`,
  notSetUp: (home: string) =>
    `This Mac does not approve Secrets uses. To set it up, turn on Approves secret uses on its row in Settings, Devices, then confirm it on ${home}.`,
  /** Where this window cannot keep an approval key at all, as on Linux. */
  cannotApprove: (home: string) =>
    `This computer cannot approve Secrets uses. Allow this use on ${home}, or on a phone or Mac set up to approve them.`,
  saveOnHome: (home: string) => `Save a decision on ${home}. This Mac can allow one use at a time.`,
  gone: "This use no longer waits for an answer.",
  notConfirmed: "Nothing was allowed. This Mac did not confirm you.",
  refused: (home: string) => `${home} did not take this approval.`,
} as const;

/** The secrets a title names: "the X secret", "the X and Y secrets", or a count, from names `secretNames.secretName` gave. */
export function secretsNamed(names: readonly string[]): string {
  if (names.length > 2) return `${names.length} secrets`;
  return secretsListed(names);
}

/** Every secret by name, for a sentence that must say exactly which: "the X, Y and Z secrets". */
export function secretsListed(names: readonly string[]): string {
  if (names.length === 1) return `the ${names[0]} secret`;
  const last = names.at(-1);
  return `the ${names.slice(0, -1).join(", ")} and ${last} secrets`;
}

/**
 * The approval card's own words (INF-1690's plan, piece 2): its title names the
 * secrets and who asks, its body says who asks, what runs and why, and its
 * answers include the two decisions a person can save.
 */
export const SECRET_APPROVAL_CARD_WORDS = {
  /** Who asks: the task's crewmate, its title in quotes, or Infinitary itself when no task asked. */
  title: (secrets: string, task: string | null) =>
    task ? m.secretsApprovalTitleTask({ secrets, task }) : m.secretsApprovalTitleApp({ secrets }),
  /** Under the reason: the title names the task, so this says only who wrote it. */
  asked: (task: string | null) =>
    task ? m.secretsApprovalAskedTask() : m.secretsApprovalAskedApp(),
  /** The open rows' labels, one fact each. */
  get secret() {
    return m.secretsApprovalSecret();
  },
  get secrets() {
    return m.secretsApprovalSecrets();
  },
  get goesIn() {
    return m.secretsApprovalGoesIn();
  },
  get runs() {
    return m.secretsApprovalRuns();
  },
  get in() {
    return m.secretsApprovalFolder();
  },
  /** The computer that runs work a program runs on, when it is not the home (docs/secrets.md, "On a computer that runs work"). */
  get on() {
    return m.secretsApprovalComputer();
  },
  get sends() {
    return m.secretsApprovalSends();
  },
  get request() {
    return m.secretsApprovalRequest();
  },
  get reason() {
    return m.secretsApprovalReason();
  },
  /** One line per allow button, beside its label, saying what that button covers. */
  once: (many: boolean) => (many ? m.secretsApprovalOnceMany() : m.secretsApprovalOnceOne()),
  get read() {
    return m.secretsApprovalRead({ uses: SHORT_READ_USES });
  },
  get always() {
    return m.secretsApprovalAlways();
  },
  /** The same line for a run on a computer that runs work, whose saved decision covers only that computer. */
  alwaysOn: (computer: string) => m.secretsApprovalAlwaysOn({ computer }),
  /** The standing sentences after the button lines; `confirm` ends them. */
  keep: (many: boolean) => (many ? m.secretsApprovalKeepMany() : m.secretsApprovalKeepOne()),
  get never() {
    return m.secretsApprovalNever();
  },
  get checked() {
    return m.secretsApprovalChecked();
  },
  get confirm() {
    return m.secretsApprovalConfirm();
  },
  /** The system's own confirmation, which names what one Allow covers. */
  get confirmOnce() {
    return m.secretsApprovalConfirmOnce();
  },
  get confirmAlways() {
    return m.secretsApprovalConfirmAlways();
  },
  get confirmRead() {
    return m.secretsApprovalConfirmRead({
      minutes: formatNumber(SHORT_READ_SECONDS / 60),
      uses: SHORT_READ_USES,
    });
  },
  get allowed() {
    return m.secretsApprovalAllowed();
  },
  get notKept() {
    return m.secretsApprovalNotKept();
  },
  /** The labels screen readers hear for the card's lists. */
  get listSecrets() {
    return m.secretsApprovalListSecrets();
  },
  get listRequest() {
    return m.secretsApprovalListRequest();
  },
  get listChecked() {
    return m.secretsApprovalListChecked();
  },
  get listAllows() {
    return m.secretsApprovalListAllows();
  },
};

/**
 * The secrets an approval card's title names, in the person's language:
 * one or two by name, more by count (`secretsNamed` is the English the crew reads).
 */
export function secretsNamedWords(names: readonly string[]): string {
  if (names.length > 2) return m.secretsApprovalNamedMany({ count: names.length });
  if (names.length === 2)
    return m.secretsApprovalNamedTwo({ first: names[0] as string, second: names[1] as string });
  return m.secretsApprovalNamedOne({ name: names[0] ?? "" });
}

/**
 * The checked facts under an approval card's "Everything that was checked",
 * one line each (docs/secrets.md, "The crew's pre-check"): what was checked
 * on the left, what it was checked to be on the right, in words, with a
 * fingerprint's first characters where a file was bound by its content.
 */
export const SECRET_CHECKED_WORDS = {
  /** Each requested secret by name, reference and version. */
  secret: "Secret",
  program: "Program",
  interpreter: "Interpreter",
  file: "File",
  arguments: "Arguments",
  folder: "Working folder",
  /** A program that runs on a computer that runs work, which checks its files again right before it starts. */
  computer: "Runs on",
  computerValue: (name: string) => `${name}, which checks these files again right before it starts`,
  secrets: "Secrets go in as",
  gets: "gets",
  output: "Output",
  outputValue: "Stays private. The crew hears only whether it finished and its exit code.",
  limit: "Not checked",
  limitValue: "Other files the program reads while it runs, and what it does with the secrets.",
  /** A file this user could change runs from a copy taken when it was checked. */
  copied: "runs from a private copy taken when it was checked",
  /** A file nothing this user runs can change runs where it is. */
  inPlace: "nothing you run can change it",
  /**
   * A Windows program runs where it is, since it needs the files beside it,
   * and is hashed again right before it starts (docs/secrets.md, "The recipient").
   */
  inPlaceWindows: "runs where it is and is checked again right before it starts",
  /** An argument naming a file is always read from a copy. */
  input: "read from a private copy taken when it was checked",
  fingerprint: "fingerprint",
  destination: "Sends to",
  operation: "Request",
  result: "Result",
  read: "Reads only",
  readYes: "Yes, it changes nothing there",
  readNo: "No, it may change something there",
  request: "Exact request",
  /** A program a service starts and keeps talking to (docs/secrets.md, "Programs that keep running"). */
  startsInPlace: "runs where it is, checked again right before it starts",
  readInPlace: "read where it is; what it holds is not checked",
  keepsRunningOutput: "Goes to Infinitary, which keeps talking to the program until it stops.",
  keepsRunningLimit:
    "The rest of the program's environment, what the files it names hold, other files it reads while it runs, programs it starts, and what it does with the secrets.",
} as const;

/** The words of the questions Settings asks on a row (`secretQuestionSchema`), and what each answer reports. */
export const SECRET_QUESTION_WORDS = {
  forgetTitle: (name: string) => `Forget the ${name} secret?`,
  forgetLines: [
    "Infinitary removes it from this computer, and no task can use it after this.",
    "This does not turn it off where it was made, and it cannot take back a copy a program already received.",
  ],
  forget: "Forget secret",
  keepSecret: "Keep secret",
  forgotten: "Secret forgotten locally.",
  notForgotten: "This secret changed or storage is locked. Nothing was forgotten.",
  historyTitle: "Delete Secrets history?",
  historyLines: [
    "Infinitary forgets which tasks asked for your secrets, and when. It never kept the secrets themselves there.",
    "Uses still waiting or running keep their record until they end. Export the history first if you want a copy; backups and copies you exported stay as they are.",
  ],
  deleteHistory: "Delete history",
  keepHistory: "Keep history",
  historyDeleted: "Secrets history deleted.",
  historyBusy: "Wait for pending or running uses to end before deleting history.",
} as const;

export const SAVED_DECISION_WORDS = {
  removeTitle: "Remove this saved decision?",
  removeBody: "After this, the crew asks you again before using it.",
  removeConfirm: "Remove decision",
  keep: "Keep it",
  onlyRemove:
    "Nothing changed. A decision is saved only on a request's card; here you can remove one.",
  confirm: "Your computer asks you to confirm.",
  saved: "Saved decision removed. The crew asks you again before using it.",
  unchanged:
    "Your saved decisions did not change. Confirmation failed or they changed while you were deciding.",
} as const;

/**
 * Which answer a use card's action gives, written at the start of its pass
 * (`allow-once:<id>`), so a window on another computer knows which answer to
 * sign with its own key (docs/secrets.md, "Remote decisions").
 */
export const SECRET_USE_ANSWERS = ["allow-once", "deny", "allow-short", "allow-always"] as const;
export type SecretUseAnswer = (typeof SECRET_USE_ANSWERS)[number];

export function secretUseAnswerOf(pass: string): SecretUseAnswer | undefined {
  const kind = pass.slice(0, pass.indexOf(":"));
  return (SECRET_USE_ANSWERS as readonly string[]).includes(kind)
    ? (kind as SecretUseAnswer)
    : undefined;
}

/**
 * One secret an agent asked the captain to keep (docs/secrets.md, "Asking to
 * keep a secret"): a name, an optional place, and the kept secret it
 * replaces with the version the card named. Never a value.
 */
export const secretAskFieldSchema = z.strictObject({
  /** The field's id on its card, which the window's Keep names beside each value. */
  id: z.string().regex(/^[a-z0-9-]{1,32}$/),
  name: z.string().trim().min(1),
  place: z.string().optional(),
  replaces: z
    .strictObject({ ref: secretRefSchema, version: z.number().int().positive() })
    .optional(),
});
export type SecretAskField = z.infer<typeof secretAskFieldSchema>;

/**
 * What the ask card's Keep in Secrets button carries as its host effect's
 * `arg`, as JSON: the fields the window draws, one masked field each. The
 * button's id is the one-time pass the window's Keep sends.
 */
export const secretKeepOfferSchema = z.strictObject({
  fields: z.array(secretAskFieldSchema).min(1),
});
export type SecretKeepOffer = z.infer<typeof secretKeepOfferSchema>;

/** The fields a host card's Keep button offers, or none: an agent's card never draws one. */
export function secretKeepFields(card: {
  author: string;
  actions: readonly { id: string; effect?: unknown }[];
}): { pass: string; fields: SecretAskField[] } | undefined {
  if (card.author !== "host") return undefined;
  for (const action of card.actions) {
    const effect = action.effect as { kind?: unknown; op?: unknown; arg?: unknown } | undefined;
    if (effect?.kind !== "host" || effect.op !== "secrets-keep" || typeof effect.arg !== "string")
      continue;
    try {
      const offer = secretKeepOfferSchema.safeParse(JSON.parse(effect.arg));
      if (offer.success) return { pass: action.id, fields: offer.data.fields };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The window's Keep on an ask card (`inf:secrets:keep`): its pass and one
 * value per field. The values go straight to the protected owner and are
 * zero-filled there; nothing records them.
 */
export const secretKeepInputSchema = z.strictObject({
  pass: z.string().min(1).max(64),
  values: z.array(z.strictObject({ field: z.string().min(1).max(32), value: z.string() })).min(1),
});
export type SecretKeepInput = z.infer<typeof secretKeepInputSchema>;
/** Whether the values were kept, and the host's words for the card when they were not. */
export const secretKeepSchema = z.strictObject({
  kept: z.boolean(),
  words: z.string().optional(),
});
export type SecretKeep = z.infer<typeof secretKeepSchema>;

/**
 * The ask card's own words (INF-4239, direction A; INF-5516's plan): Add
 * and Save, never Keep, in the person's language. Its title names the
 * secrets alone; who asks is said under the reason.
 */
export const SECRET_ASK_CARD_WORDS = {
  /** One or two secrets by name, more by count; Replace when every secret on the card replaces a saved one. */
  title: (names: readonly string[], replace: boolean) => {
    const [first = "", second = ""] = names;
    if (names.length > 2)
      return replace
        ? m.secretsAskReplaceMany({ count: names.length })
        : m.secretsAskTitleMany({ count: names.length });
    if (names.length === 2)
      return replace
        ? m.secretsAskReplaceTwo({ first, second })
        : m.secretsAskTitleTwo({ first, second });
    return replace
      ? m.secretsAskReplaceOne({ name: first })
      : m.secretsAskTitleOne({ name: first });
  },
  /** Under the reason: who wrote it, the task by its title. */
  asked: (task: string | null) =>
    task ? m.secretsAskAskedTask({ task }) : m.secretsAskAskedFirstMate(),
  /** The heading over the asker's how-to. */
  how: (many: boolean) => (many ? m.secretsAskHowMany() : m.secretsAskHowOne()),
  /** Under the how-to: who wrote it, and to check each address. */
  by: (task: string | null) => (task ? m.secretsAskByCrewmate() : m.secretsAskByFirstMate()),
  /** Beside a field's name: the place it is saved under, and the version it replaces. */
  place: (place: string) => m.secretsAskPlace({ place }),
  replaces: (version: number) => m.secretsAskReplaces({ version: formatNumber(version) }),
  get placeholder() {
    return m.secretsAskPlaceholder();
  },
  /** Under the fields: where each value goes, and what the crew gets. */
  note: (many: boolean) => (many ? m.secretsAskNoteMany() : m.secretsAskNoteOne()),
  /** The fields' group, for screen readers. */
  get fields() {
    return m.secretsAskFields();
  },
  /** Shown only where the window draws no field: an older window or phone. */
  get elsewhere() {
    return m.secretsAskElsewhere();
  },
  save: (many: boolean) => (many ? m.secretsAskSaveMany() : m.secretsAskSaveOne()),
  get dontSave() {
    return m.secretsAskDontSave();
  },
  get unlock() {
    return m.secretsAskUnlock();
  },
  /** Above the card's body when the last Save could not finish. */
  get locked() {
    return m.secretsAskLocked();
  },
  get recovery() {
    return m.secretsAskRecovery();
  },
  get unavailable() {
    return m.secretsAskUnavailable();
  },
  get stale() {
    return m.secretsAskStale();
  },
  get empty() {
    return m.secretsAskEmpty();
  },
  get closed() {
    return m.secretsAskClosed();
  },
  get gone() {
    return m.secretsAskGone();
  },
  /** The line a seen card keeps once its ask ended. */
  get ended() {
    return m.secretsAskEnded();
  },
};
