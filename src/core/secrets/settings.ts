import { randomUUID } from "node:crypto";
import { type Card, FIRSTMATE_CARD_META } from "@shared/cards";
import { secretName as nameOf } from "@shared/secretNames";
import {
  decisionWords,
  SAVED_DECISION_WORDS,
  SECRET_APPROVAL_CARD_WORDS,
  SECRET_COPY_SECONDS,
  SECRET_COPY_WORDS,
  SECRET_DEVICE_WORDS,
  SECRET_QUESTION_WORDS,
  SECRETS_RECOVERY_WORDS,
  SECRETS_WORDS,
  type SecretAction,
  type SecretApprovals,
  type SecretConsumer,
  type SecretDecision,
  type SecretDecisionInput,
  type SecretEnrollInput,
  type SecretEntryInput,
  type SecretKeep,
  type SecretKeepInput,
  type SecretRehearsal,
  type SecretRehearsalInput,
  type SecretsView,
  type SecretUseAnswer,
  secretsNamedWords,
} from "@shared/secrets";
import type {
  PlacedSecretAskAnswer,
  PlacedSecretAskInput,
  PlacedSecretTakeAnswer,
  PlacedSecretUseAnswer,
  PlacedSecretUseInput,
} from "@shared/workSecrets";
import { askingView } from "../askedFromAView";
import type { HostSecretsRecovery } from "../host";
import { escapeCardText } from "../orchestrator/cardText";
import {
  brokerCheckedFacts,
  checkedFacts,
  runWords,
  type SecretAsk,
  type SecretIdentities,
  secretApprovalBody,
} from "./approvalCard";
import { approvalCode, approvalKey, type RemoteDecision } from "./approvals";
import type { SecretAskAnswer, SecretAskEnded, SecretAskInput } from "./asks";
import { SecretAsks } from "./askToKeep";
import type { ApprovalDevice, Rule } from "./authority";
import { type BrokeredUse, type SecretBroker, validBrokeredUse } from "./brokers";
import type { SecretClipboard } from "./clipboard";
import { SecretHandoffs } from "./handoffs";
import type { HistoryItem } from "./journal";
import type { ProtectedSecrets, ProtectedSecretsOptions, RecoveryRestore } from "./protected";
import type { RecipientFacts } from "./recipient";
import type { RecoveryFiles } from "./recoveryArchive";
import { newReference } from "./references";
import {
  type EndedUseReceipt,
  type Injection,
  SECRET_REQUEST_LIFETIME_MS,
  SecretRequests,
  type SecretsCommand,
  type UseCheckInput,
  type UseComputer,
  type UseReceipt,
  type UseState,
  validInjection,
} from "./requests";

export type SecretsSettingsOptions = {
  /** Waited on before a secret is used, which cannot be taken back (docs/devices.md). */
  beforeUse?: () => Promise<void>;
  open?: (initialize: boolean) => Promise<ProtectedSecrets>;
  unlock?: () => Promise<boolean>;
  recovery?: HostSecretsRecovery;
  /** The host's private clipboard writer; absent, no row offers Copy value. */
  clipboard?: SecretClipboard;
  raise: (card: Omit<Card, "author" | "priority" | "status" | "createdAt">) => void;
  openCard?: (id: string) => Pick<Card, "actions"> | undefined;
  withdraw: (id: string, reason: string) => void;
  changed: () => void;
  /** A waiting requester hears the terminal receipt through the existing task inbox, never values. */
  settled?: (task: string, receipt: EndedUseReceipt) => void;
  /** A task's title, so the approval card says which task asks and the page which task last used a secret. */
  taskTitle?: (task: string) => string | undefined;
  /** Where the asks waiting for the captain are kept across a restart (`SecretAskBook`); none keeps them in memory. */
  asksFile?: string;
  /**
   * An ask ended (docs/secrets.md, "Asking to keep a secret"): its asker, a
   * task or the first mate (null), hears once through its inbox, never a value.
   */
  asked?: (task: string | null, ended: SecretAskEnded) => void;
  /** Whether an asking task is still open: a closed task's ask keeps nothing. */
  taskOpen?: (task: string) => boolean;
  now?: ProtectedSecretsOptions["now"];
};
type Owner = { protected: ProtectedSecrets; requests: SecretRequests };
/**
 * Where an offer's answer comes from: a host card's chrome, the question on
 * its row in Settings, or an ask card's Keep, which only `keep` spends with
 * the values the window sends (`ask` names the waiting ask).
 */
type Offer = {
  group: string;
  run: () => Promise<void>;
  place: "card" | "settings" | "keep";
  kind?: SecretUseAnswer;
  ask?: string;
};
type Question = NonNullable<SecretsView["question"]>;

/** Kept here too: the secrets journey reads it from this module. */
export { newReference } from "./references";

/**
 * Trusted Settings/controller facade. It shares the protected owner and coordinator with
 * brokered consumers; no plaintext getter, approval proof or broker result crosses its view.
 * Agent commands receive only commandFor's metadata/receipt methods, never this controller.
 * Offers are process-local and single-use: a persisted host card after restart grants nothing.
 * Asks to keep a secret, their cards and their Keep are `SecretAsks`' (`askToKeep.ts`).
 */
export class SecretsSettings {
  private opening: Promise<Owner> | undefined;
  private owner: Owner | undefined;
  private readonly offers = new Map<string, Offer>();
  private readonly taskOf = new Map<string, Set<string>>();
  private readonly awaiting = new Map<string, Set<string>>();
  private readonly brokers = new Map<string, SecretBroker>();
  /** The sweep of left-over service entries now running, which never rejects. */
  private sweeping: Promise<void> = Promise.resolve();
  /** Values of approved uses whose programs run on a computer that runs work, each handed once. */
  private readonly handoffs = new SecretHandoffs();
  /** The computer each such use runs on, by request: only that computer and task take or end it. */
  private readonly elsewhereOf = new Map<string, { computer: string; task: string }>();
  /** Host consumers awaiting a use's end (`use`), by request. */
  private readonly ending = new Map<string, (receipt: UseReceipt) => void>();
  /** Each card choice still running, by its card's group. */
  private readonly deciding = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private message: string | null = null;
  /** The value Copy value last put on the clipboard, while its clearing is still to come. */
  private copied: { ref: string; clears: number; timer: ReturnType<typeof setTimeout> } | null =
    null;
  private offeredCard: string | null = null;
  /** The one question waiting on its row in Settings, with the passes that answer it. */
  private question: (Question & { group: string }) | null = null;
  private choosingRecovery = false;
  /** Uses whose approval card is up: a phone draws its own Allow and Deny on that card. */
  private readonly useCards = new Set<string>();
  /**
   * Paired phones whose switch the captain turned on in Settings -> Devices:
   * each offers its key when it next reads its approvals. Process-local, like
   * the cards it leads to; nothing is enrolled until the code card is confirmed.
   */
  private readonly askedPhones = new Set<string>();
  /** The paired device each waiting enrollment offer came from, by its approval device. */
  private readonly offeredFrom = new Map<string, string>();
  private viewEpoch = 0;
  private readonly asks: SecretAsks;

  constructor(private readonly options: SecretsSettingsOptions) {
    this.now = options.now ?? Date.now;
    // Every published change invalidates older async snapshots, including ones
    // that kept the same owner (for example an explicit history deletion).
    this.options = {
      ...options,
      changed: () => {
        this.viewEpoch += 1;
        options.changed();
      },
    };
    this.asks = new SecretAsks({
      options: this.options,
      offers: this.offers,
      ready: (initialize) => this.ready(initialize),
      now: () => this.now(),
      owner: () => this.owner,
      letGo: () => {
        this.owner = undefined;
      },
    });
  }

  async ready(initialize = false): Promise<Owner | undefined> {
    if (!this.options.open) return undefined;
    if (this.opening) await this.opening;
    if (this.owner && !(initialize && this.owner.protected.availability === "uninitialized"))
      return this.owner;
    const opening = this.options.open(initialize).then((protectedOwner) => {
      const changed = (receipt: UseReceipt) => this.receiptChanged(receipt);
      const before = this.options.beforeUse;
      const requests = new SecretRequests(protectedOwner, this.now, changed, before);
      return { protected: protectedOwner, requests };
    });
    this.opening = opening;
    try {
      const opened = await opening;
      for (const broker of this.brokers.values()) opened.protected.registerBroker(broker);
      this.owner = opened;
      await this.sweepUnnamed(opened);
      return this.owner;
    } finally {
      if (this.opening === opening) this.opening = undefined;
    }
  }

  private receiptChanged(receipt: UseReceipt): void {
    this.handoffs.wake(receipt.request);
    if (receipt.state !== "waiting" && receipt.state !== "executing") {
      const group = `use-${receipt.request}`;
      for (const [id, offer] of this.offers) if (offer.group === group) this.offers.delete(id);
      const card = `card-secrets-${group}`;
      this.options.withdraw(card, "This Secrets request is no longer waiting.");
      if (this.offeredCard === card) this.offeredCard = null;
      this.useCards.delete(receipt.request);
      this.ending.get(receipt.request)?.(receipt);
      const tasks = this.awaiting.get(receipt.request);
      this.awaiting.delete(receipt.request);
      for (const task of tasks ?? []) {
        this.options.settled?.(task, { ...receipt, state: receipt.state });
      }
    }
    this.options.changed();
  }

  private track(owner: Owner, receipt: UseReceipt, task: string): void {
    const tasks = this.taskOf.get(receipt.request) ?? new Set<string>();
    tasks.add(task);
    this.taskOf.set(receipt.request, tasks);
    if (receipt.state !== "waiting" && receipt.state !== "executing") return;
    const waiting = this.awaiting.get(receipt.request) ?? new Set<string>();
    waiting.add(task);
    this.awaiting.set(receipt.request, waiting);
    // An allowed operation can finish between returning its initial receipt and this continuation.
    const settled = owner.requests.settled(receipt.request);
    if (settled) this.receiptChanged(settled);
  }

  /** Whether this build keeps protected storage at all; it never opens the storage to answer. */
  shown(): boolean {
    return !!this.options.open;
  }

  async view(): Promise<SecretsView> {
    const owner = await this.ready().catch(() => undefined);
    // An entry a sweep is forgetting is not shown as left over.
    await this.sweeping;
    const epoch = this.viewEpoch;
    const empty: SecretsView = {
      availability: this.options.open ? "unavailable" : "not-enabled",
      home: null,
      offeredCard: this.offeredCard,
      question: this.questionView(),
      entries: [],
      uses: [],
      rules: [],
      history: [],
      historyBytes: 0,
      recoveryAvailable: !!this.options.open && !!this.options.recovery,
      reads: [],
      devices: [],
      message: this.message,
    };
    if (!owner) return empty;
    const authority = owner.protected.authority();
    const history = owner.protected.history();
    const metadata = await owner.protected.metadata();
    const snapshot: SecretsView = {
      ...empty,
      availability: await owner.protected.status(),
      home: authority?.home ?? null,
      entries: metadata.map(
        ({
          ref,
          label,
          version,
          revision,
          updatedAt,
          environment,
          discoverable,
          forProgram,
          consumer,
        }) => ({
          ref,
          label,
          version,
          revision,
          updatedAt,
          environment: environment ?? "",
          ...this.lastUse(history.filter((item) => item.secrets.includes(ref)).at(-1)),
          ...(discoverable
            ? {}
            : {
                kept: true as const,
                ...(forProgram ? { forProgram: true as const } : {}),
                ...(consumer ? { consumer } : {}),
                ...(consumer && this.namedFor(consumer)?.includes(ref) === false
                  ? { unnamed: true as const }
                  : {}),
              }),
        }),
      ),
      uses: owner.requests.receipts().map((receipt) => this.receiptView(owner, receipt)),
      rules: withoutKept(authority?.rules ?? [], metadata),
      history,
      historyBytes: await owner.protected.storageUse(),
      reads: owner.protected.readPermissions(),
      devices: (authority?.devices ?? []).map(
        ({ device, label, generation, publicKey, paired }) => ({
          device,
          label,
          generation,
          code: approvalCode(publicKey),
          ...(paired ? { paired } : {}),
          ...(this.offering(`forget-device-${device}`) ? { stopping: true } : {}),
        }),
      ),
      phones: this.phoneSetups(),
      ...(await this.copyView(owner)),
    };
    // Recovery can replace the owner; other changes can invalidate its snapshot
    // while native status or metadata is being read.
    return this.owner === owner && this.viewEpoch === epoch ? snapshot : this.view();
  }

  /** Whether rows offer Copy value, and the copy still on the clipboard. */
  private async copyView(owner: Owner): Promise<Pick<SecretsView, "copy" | "copied">> {
    const clipboard = this.options.clipboard;
    if (!clipboard) return {};
    const confirms = await owner.protected.canConfirm();
    return {
      copy: confirms ? "ready" : "no-confirmation",
      ...(this.copied
        ? {
            copied: {
              ref: this.copied.ref,
              clears: this.copied.clears,
              concealed: clipboard.concealed,
            },
          }
        : {}),
    };
  }

  /**
   * Copy value on a secret's row (docs/secrets.md, "Copying a value"): the
   * owner confirms and journals, the host writes, and the clipboard is
   * cleared after `SECRET_COPY_SECONDS` while it still holds the value. A
   * second copy replaces the first and starts the time again.
   */
  private async copy(owner: Owner, action: Extract<SecretAction, { kind: "copy" }>): Promise<void> {
    const clipboard = this.options.clipboard;
    if (!clipboard) {
      this.message = SECRET_COPY_WORDS.unavailable;
      return;
    }
    const entries = await owner.protected.metadata();
    const result = await owner.protected.copyValue(
      action.ref,
      { version: action.version, revision: action.revision },
      () => SECRET_COPY_WORDS.reason(nameOf(identitiesOf(entries), action.ref)),
      (value) => clipboard.write(value),
    );
    if (result === "copied") {
      this.forgetCopy();
      const timer = setTimeout(() => void this.clearCopy(), SECRET_COPY_SECONDS * 1000);
      // A pending clear never keeps a quitting process alive; the host clears on quit.
      timer.unref?.();
      this.copied = { ref: action.ref, clears: this.now() + SECRET_COPY_SECONDS * 1000, timer };
      return;
    }
    if (result === "unknown") await this.clearCopy();
    this.message = SECRET_COPY_WORDS[result];
  }

  private forgetCopy(): void {
    if (this.copied) clearTimeout(this.copied.timer);
    this.copied = null;
  }

  /** Clears the copied value while the clipboard still holds it; its time, or Clear now. */
  private async clearCopy(): Promise<void> {
    this.forgetCopy();
    await this.options.clipboard?.clear().catch(() => undefined);
    this.options.changed();
  }

  private questionView(): SecretsView["question"] {
    if (!this.question) return null;
    const { group: _group, ...question } = this.question;
    return structuredClone(question);
  }

  /** Whether a card or question of this group still waits for the captain's choice. */
  private offering(group: string): boolean {
    return [...this.offers.values()].some((offer) => offer.group === group);
  }

  /** Paired phones on their way to approving: a key's card is up, or the home waits for the key. */
  private phoneSetups(): NonNullable<SecretsView["phones"]> {
    const comparing = new Map(
      [...this.offeredFrom]
        .filter(([device]) => this.offering(`enroll-${device}`))
        .map(([device, paired]) => [paired, `card-secrets-enroll-${device}`]),
    );
    return [
      ...[...comparing].map(([paired, card]) => ({ paired, state: "comparing" as const, card })),
      ...[...this.askedPhones]
        .filter((paired) => !comparing.has(paired))
        .map((paired) => ({ paired, state: "waiting" as const })),
    ];
  }

  /** The switch on a paired phone turned off before its key enrolled: stop asking, and take down its card. */
  private cancelPhone(paired: string): void {
    this.askedPhones.delete(paired);
    for (const [device, from] of this.offeredFrom) {
      if (from !== paired) continue;
      this.offeredFrom.delete(device);
      const group = `enroll-${device}`;
      for (const [id, offer] of this.offers) if (offer.group === group) this.offers.delete(id);
      this.options.withdraw(`card-secrets-${group}`, SECRET_DEVICE_WORDS.cancelled);
    }
  }

  private lastUse(item: HistoryItem | undefined): {
    lastRequest: number | null;
    lastTask?: string;
  } {
    if (!item) return { lastRequest: null };
    const task = this.taskOf.get(item.request)?.values().next().value ?? intentTask(item.intent);
    const title = task ? this.options.taskTitle?.(task) : undefined;
    return {
      lastRequest: item.requestedAt,
      ...(title ? { lastTask: title } : {}),
      ...(item.copied ? { lastCopied: true as const } : {}),
    };
  }

  private receiptView(owner: Owner, receipt: UseReceipt): SecretsView["uses"][number] {
    const script = owner.protected.describe(receipt.request);
    const broker = owner.protected.describeBrokered(receipt.request);
    const historical = owner.protected.history().find((item) => item.request === receipt.request);
    return {
      ...receipt,
      reason: script?.reason ?? broker?.reason ?? historical?.reason ?? "",
      recipient: script?.facts.executable.path ?? broker?.facts.label ?? historical?.program ?? "",
      facts: script
        ? checkedFacts(script.facts, script.secrets, script.computer?.label)
        : broker
          ? brokerCheckedFacts(broker.facts, broker.secrets)
          : [],
      // The record the use prepared, never a later lookup that could describe a replacement.
      secrets: (script?.secrets ?? broker?.secrets ?? []).map(
        ({ ref, label, version, environment }) => ({
          ref,
          label,
          version,
          environment: environment ?? "",
        }),
      ),
      shortReadEligible: broker?.shortReadEligible ?? false,
      expires: owner.requests.pending(receipt.request)?.expires ?? null,
    };
  }

  /**
   * Only secure Settings entry invokes this; the value is not stored in cards, receipts or history.
   * Every entry saved here joins the one catalog every crewmate's command lists; listing grants no use.
   */
  async put(input: SecretEntryInput): Promise<SecretsView> {
    const value = Buffer.from(input.value);
    let saved: SecretsView["saved"];
    try {
      const owner = await this.ready(true);
      if (!owner) this.message = SECRETS_WORDS.disabled;
      else {
        const metadata = await owner.protected.metadata();
        const replacing = input.expectedVersion !== 0 || input.expectedRevision !== null;
        // An app sign-in is replaced only by signing in again where it was made.
        const kept = metadata.some((entry) => entry.ref === input.ref && !entry.discoverable);
        const ref =
          input.ref ??
          (replacing
            ? undefined
            : newReference(input.label, [
                ...metadata.map((entry) => entry.ref),
                ...(owner.protected.authority()?.rules.map((rule) => rule.secret) ?? []),
                ...owner.protected.history().flatMap((item) => item.secrets),
              ]));
        const written =
          ref && !kept
            ? await owner.protected.putSecret(ref, input.label, value, {
                discoverable: true,
                expectedVersion: input.expectedVersion,
                expectedRevision: input.expectedRevision,
                environment: input.environment,
              })
            : undefined;
        if (written) {
          this.message = SECRETS_WORDS.saved;
          saved = { ref: written.ref, version: written.version };
        } else {
          const current = (await owner.protected.metadata()).find((entry) => entry.ref === ref);
          this.message =
            ref &&
            ((current?.version ?? 0) !== input.expectedVersion ||
              (current?.revision ?? null) !== input.expectedRevision)
              ? SECRETS_WORDS.stale
              : SECRETS_WORDS.unavailable;
        }
      }
    } catch {
      this.message = SECRETS_WORDS.unavailable;
    } finally {
      value.fill(0);
      this.options.changed();
    }
    const view = await this.view();
    return saved ? { ...view, saved } : view;
  }

  async action(action: SecretAction): Promise<SecretsView> {
    if (action.kind === "answer") {
      await this.decide(action.pass, "settings");
      return this.view();
    }
    this.message = null;
    this.offeredCard = null;
    // Starting another Secrets action drops a question still open, and changes nothing.
    this.dropQuestion();
    const owner = await this.ready();
    if (!owner) return this.view();
    switch (action.kind) {
      case "backup-recovery":
      case "restore-recovery":
        await this.recoveryAction(owner, action.kind);
        break;
      case "start-over":
        await this.startOver(owner);
        break;
      case "unlock":
        if (this.options.unlock) await this.options.unlock();
        if (owner.protected.availability !== "available") this.owner = undefined;
        this.message = null;
        break;
      case "review-use": {
        const group = `use-${action.request}`;
        const id = `card-secrets-${group}`;
        const card = this.options.openCard?.(id);
        if (
          owner.requests.pending(action.request) &&
          card?.actions.length &&
          card.actions.every(({ id: pass }) => this.offers.get(pass)?.group === group)
        ) {
          this.offeredCard = id;
        } else if (!this.deciding.has(group)) {
          await this.offerUse(owner, action.request);
        }
        break;
      }
      case "cancel-use":
        await owner.requests.cancel(action.request);
        break;
      case "end-read":
        owner.protected.endReadAccess(action.id);
        break;
      case "forget": {
        const entries = await owner.protected.metadata();
        // An app sign-in is forgotten by signing out where it was made, never here; a service's
        // entry its saved settings no longer name is left over, and nothing else can forget it.
        const entry = entries.find(
          (one) =>
            one.ref === action.ref &&
            (one.discoverable ||
              (one.consumer !== undefined &&
                this.namedFor(one.consumer)?.includes(one.ref) === false)),
        );
        if (entry)
          this.askInPlace(
            `forget-${entry.ref}`,
            { kind: "forget", ref: entry.ref },
            SECRET_QUESTION_WORDS.forgetTitle(nameOf(identitiesOf(entries), entry.ref)),
            SECRET_QUESTION_WORDS.forgetLines,
            {
              confirm: {
                label: SECRET_QUESTION_WORDS.forget,
                run: async () => {
                  const forgotten = await owner.protected.forgetSecret(
                    entry.ref,
                    entry.version,
                    entry.revision,
                  );
                  this.message = forgotten
                    ? SECRET_QUESTION_WORDS.forgotten
                    : SECRET_QUESTION_WORDS.notForgotten;
                },
              },
              keep: SECRET_QUESTION_WORDS.keepSecret,
            },
          );
        break;
      }
      case "forget-device": {
        const device = owner.protected
          .authority()
          ?.devices.find((one) => one.device === action.device);
        if (!device) break;
        this.askInPlace(
          `forget-device-${device.device}`,
          { kind: "device", device: device.device },
          SECRET_DEVICE_WORDS.stopTitle(device.label),
          SECRET_DEVICE_WORDS.stopLines(device.label),
          {
            confirm: {
              label: SECRETS_WORDS.stopApprovals,
              run: async () => {
                const saved = await this.saveDevices(
                  owner,
                  (devices) => devices.filter((one) => one.device !== device.device),
                  `Stop Secrets approvals from ${device.label}.`,
                );
                this.message = saved
                  ? SECRET_DEVICE_WORDS.stopped(device.label)
                  : SECRET_DEVICE_WORDS.unchanged;
              },
            },
            keep: SECRET_DEVICE_WORDS.keep,
          },
        );
        break;
      }
      case "ask-phone":
        this.askedPhones.add(action.paired);
        break;
      case "cancel-phone":
        this.cancelPhone(action.paired);
        break;
      case "copy":
        await this.copy(owner, action);
        break;
      case "clear-copy":
        await this.clearCopy();
        this.message = SECRET_COPY_WORDS.cleared;
        break;
      case "delete-history":
        this.askInPlace(
          "delete-history",
          { kind: "history" },
          SECRET_QUESTION_WORDS.historyTitle,
          SECRET_QUESTION_WORDS.historyLines,
          {
            confirm: {
              label: SECRET_QUESTION_WORDS.deleteHistory,
              run: async () => {
                const result = await owner.protected.clearHistory();
                this.message =
                  result === "cleared"
                    ? SECRET_QUESTION_WORDS.historyDeleted
                    : result === "busy"
                      ? SECRET_QUESTION_WORDS.historyBusy
                      : SECRETS_WORDS.unavailable;
              },
            },
            keep: SECRET_QUESTION_WORDS.keepHistory,
          },
        );
        break;
      case "save-rules": {
        const authority = owner.protected.authority();
        if (!authority) break;
        const entries = await owner.protected.metadata();
        this.offerDecisions(
          owner,
          withoutKept(authority.rules, entries),
          structuredClone(action.rules),
          entries,
        );
        break;
      }
    }
    this.options.changed();
    return this.view();
  }

  private async recoveryAction(
    owner: Owner,
    kind: "backup-recovery" | "restore-recovery",
  ): Promise<void> {
    const files = this.options.recovery;
    if (!files) {
      this.message = SECRETS_RECOVERY_WORDS.unavailable;
      return;
    }
    if (this.choosingRecovery) {
      this.message = SECRETS_RECOVERY_WORDS.choosing;
      return;
    }
    this.choosingRecovery = true;
    let selected: RecoveryFiles | undefined;
    let restoring = false;
    try {
      if (kind === "backup-recovery") {
        const writer = await files.chooseSave();
        this.message = writer
          ? SECRETS_RECOVERY_WORDS.save[await owner.protected.backupRecovery(writer)]
          : SECRETS_RECOVERY_WORDS.cancelled;
      } else {
        selected = await files.chooseRestore();
        if (!selected) {
          this.message = SECRETS_RECOVERY_WORDS.cancelled;
          return;
        }
        restoring = true;
        const result = await owner.protected.restoreRecovery(selected, () =>
          owner.requests.pauseForRecovery(),
        );
        this.message = SECRETS_RECOVERY_WORDS.restore[result];
        if (result === "restored" || result === "unknown") this.homeReplaced();
      }
    } catch {
      this.message =
        kind === "restore-recovery"
          ? restoring
            ? SECRETS_RECOVERY_WORDS.restore.unknown
            : SECRETS_RECOVERY_WORDS.unreadable
          : SECRETS_RECOVERY_WORDS.save.unknown;
    } finally {
      selected?.archive.fill(0);
      selected?.key.fill(0);
      this.choosingRecovery = false;
    }
  }

  /**
   * Start over where storage needs recovery (docs/secrets.md, "Starting over").
   * It stays on the home, and the owner asks the system to confirm, so no card,
   * crewmate or phone can start over by itself.
   */
  private async startOver(owner: Owner): Promise<void> {
    if (this.choosingRecovery) {
      this.message = SECRETS_RECOVERY_WORDS.choosing;
      return;
    }
    this.choosingRecovery = true;
    try {
      // An owner that opened without its records keeps the reading it opened
      // with. Open again first, as Unlock does, so a data folder or root item
      // that came back is read now, and used rather than replaced.
      const opened = owner.protected.availability === "available";
      if (!opened && this.owner === owner) this.owner = undefined;
      const current = opened ? owner : await this.ready();
      if (!current) {
        this.message = SECRETS_RECOVERY_WORDS.startOver.unavailable;
        return;
      }
      const result = await current.protected.startOver(() => current.requests.pauseForRecovery());
      this.message = SECRETS_RECOVERY_WORDS.startOver[result];
      if (result === "started" || result === "unknown") this.homeReplaced();
    } catch {
      this.message = SECRETS_RECOVERY_WORDS.startOver.unknown;
    } finally {
      this.choosingRecovery = false;
    }
  }

  private async openOwner(initialize = false): Promise<Owner | undefined> {
    const owner = await this.ready(initialize).catch(() => undefined);
    return owner?.protected.availability === "available" ? owner : undefined;
  }

  async sealedState(): Promise<{ home: string; revisions: string[] } | undefined> {
    return (await this.openOwner())?.protected.sealedState();
  }

  /** The values sealed for the copies (`ProtectedSecrets.sealForStandbys`); no card asks. */
  async sealForStandbys<T>(seal: (files: RecoveryFiles, home: string) => T) {
    return (await this.openOwner())?.protected.sealForStandbys(seal) ?? "unavailable";
  }

  /** Takes a copy's sealed values as a restore would, where none are kept here or by choice. */
  async adoptStandby(
    files: RecoveryFiles,
    replaceOwn = false,
  ): Promise<RecoveryRestore | "kept-own"> {
    const owner = this.choosingRecovery ? undefined : await this.openOwner(true);
    const state = await owner?.protected.sealedState();
    if (!owner || !state) return "unavailable";
    if (state.revisions.length > 0 && !replaceOwn) return "kept-own";
    this.choosingRecovery = true;
    try {
      const result = await owner.protected.adoptStandby(
        files,
        () => owner.requests.pauseForRecovery(),
        replaceOwn,
      );
      if (result === "restored" || result === "unknown") this.homeReplaced();
      this.options.changed();
      return result;
    } finally {
      this.choosingRecovery = false;
    }
  }

  /** A restore or start-over replaced the home: earlier offers no longer apply, and the next read reopens. */
  private homeReplaced(): void {
    const groups = new Set(
      [...this.offers.values()].filter((offer) => offer.place === "card").map((o) => o.group),
    );
    this.offers.clear();
    this.offeredCard = null;
    this.question = null;
    this.owner = undefined;
    for (const group of groups) {
      if (group.startsWith("ask-")) continue;
      try {
        this.options.withdraw(
          `card-secrets-${group}`,
          "Recovery changed protected storage. This earlier choice no longer applies.",
        );
      } catch {
        /* A failed presentation update cannot restore the retired authority. */
      }
    }
    // An ask still waits, but what it replaces is read again from the new home.
    this.asks.homeReplaced();
  }

  /**
   * What a phone reads (docs/secrets.md, "Remote decisions"): its own
   * enrollment and the uses waiting now, described as the approval card
   * describes them. The challenge it signs goes only to an enrolled device; no
   * value, rule or other device crosses.
   */
  async approvals(device: string): Promise<SecretApprovals> {
    const view = askingView();
    const owner = await this.ready().catch(() => undefined);
    const authority = owner?.protected.authority();
    const enrolled = authority?.devices.find((one) => one.device === device);
    const saved = owner ? await savedIdentities(owner) : [];
    const waiting = owner
      ? owner.requests.receipts().flatMap((receipt) => {
          const pending = owner.requests.pending(receipt.request);
          if (!pending) return [];
          const use = this.receiptView(owner, receipt);
          const identities = withUse(saved, use.secrets);
          const challenge = enrolled
            ? owner.protected.challenge(receipt.request, pending.digest, pending.expires)
            : undefined;
          return [
            {
              request: receipt.request,
              card: this.useCards.has(receipt.request)
                ? `card-secrets-use-${receipt.request}`
                : null,
              digest: pending.digest,
              expires: pending.expires,
              nonce: challenge?.nonce ?? null,
              reason: use.reason,
              recipient: use.recipient,
              task: this.ask(owner, receipt.request).task,
              secrets: use.secrets.map(({ ref, label, version, environment }) => ({
                ref,
                label,
                version,
                environment,
                name: nameOf(identities, ref),
              })),
              facts: use.facts,
            },
          ];
        })
      : [];
    return {
      availability: owner
        ? await owner.protected.status()
        : this.options.open
          ? "unavailable"
          : "not-enabled",
      home: authority?.home ?? null,
      device: enrolled
        ? { label: enrolled.label, generation: enrolled.generation, key: enrolled.publicKey }
        : null,
      offered: this.offering(`enroll-${device}`),
      asked: !!view && this.askedPhones.has(view),
      waiting,
    };
  }

  /**
   * A phone offers its approval key. Nothing changes until the captain compares
   * the code on both screens and confirms on this computer; a new key for the
   * same device enrolls it at the next generation.
   */
  async enroll(input: SecretEnrollInput): Promise<SecretApprovals> {
    // The paired device that asks, so its row in Settings -> Devices carries the switch.
    const paired = askingView();
    const owner = await this.ready().catch(() => undefined);
    const current = owner?.protected
      .authority()
      ?.devices.find((one) => one.device === input.device);
    // Only Secrets that are set up and open can take an approval device. The same
    // key offered again from a paired device the home has not linked it to links
    // it, through the same comparison and confirmation as a new key.
    if (
      owner &&
      (await owner.protected.status()) === "available" &&
      approvalKey(input.key) &&
      (current?.publicKey !== input.key || (!!paired && current.paired !== paired))
    ) {
      if (paired) this.offeredFrom.set(input.device, paired);
      else this.offeredFrom.delete(input.device);
      const settled = () => {
        if (paired) this.askedPhones.delete(paired);
        this.offeredFrom.delete(input.device);
      };
      const label = escapeCardText(input.label);
      this.offer(
        `enroll-${input.device}`,
        SECRET_DEVICE_WORDS.enrollTitle(input.label),
        `<p>${label} asks to approve Secrets uses from where it is.</p>
        <p>Check that this code matches the one Infinitary shows on ${label}:</p>
        <p><code class="inf-mono" style="font-size:14px">${approvalCode(input.key)}</code></p>
        <p>If the codes differ, choose Not now.</p>
        <p>Each Allow from ${label} needs its own Face ID, Touch ID, passcode or password, for that one use. It never receives a secret, and your saved decisions still apply.</p>
        ${current && current.publicKey !== input.key ? `<p>This replaces the approvals ${escapeCardText(current.label)} could give before.</p>` : ""}
        <p>The system will ask you to confirm.</p>`,
        [
          {
            label: SECRET_DEVICE_WORDS.confirm,
            run: async () => {
              const saved = await this.saveDevices(
                owner,
                (devices) => {
                  const previous = devices.find((one) => one.device === input.device);
                  return [
                    ...devices.filter((one) => one.device !== input.device),
                    {
                      device: input.device,
                      label: input.label,
                      generation: (previous?.generation ?? 0) + 1,
                      publicKey: input.key,
                      ...(paired ? { paired } : {}),
                    },
                  ];
                },
                `Let ${input.label} approve Secrets uses.`,
              );
              settled();
              this.message = saved
                ? SECRET_DEVICE_WORDS.enrolled(input.label)
                : SECRET_DEVICE_WORDS.unchanged;
            },
          },
          { label: SECRET_DEVICE_WORDS.notNow, run: async () => settled() },
        ],
      );
      this.options.changed();
    }
    return this.approvals(input.device);
  }

  /** A phone's decision on one use: Allow passes only with its enrolled signature; a refusal needs none. */
  async decideRemotely(input: SecretDecisionInput): Promise<SecretDecision> {
    const owner = await this.ready().catch(() => undefined);
    if (!owner) return { state: "unavailable" };
    if (input.kind === "deny") {
      return { state: (await owner.requests.deny(input.request))?.state ?? "unavailable" };
    }
    const decision: RemoteDecision = {
      kind: "remote",
      device: input.device,
      generation: input.generation,
      nonce: input.nonce,
      signature: input.signature,
    };
    const receipt = await owner.requests.approve(input.request, decision, "started");
    return { state: receipt?.state ?? "unavailable" };
  }

  /** Rules stay as saved; only the approval devices change, under fresh local confirmation. */
  private async saveDevices(
    owner: Owner,
    change: (devices: ApprovalDevice[]) => ApprovalDevice[],
    reason: string,
  ): Promise<boolean> {
    const authority = owner.protected.authority();
    if (!authority) return false;
    return this.saveAuthority(
      owner,
      authority.rules,
      change(structuredClone(authority.devices)),
      reason,
    );
  }

  /**
   * The next saved decisions and approval devices, under fresh local
   * confirmation. A card shown against an older revision saves nothing.
   */
  private async saveAuthority(
    owner: Owner,
    rules: Rule[],
    devices: ApprovalDevice[],
    reason: string,
    revision?: number,
  ): Promise<boolean> {
    const current = owner.protected.authority();
    if (!current || (revision !== undefined && current.revision !== revision)) return false;
    const proposal = owner.protected.proposeAuthority({
      rules: withoutKept(rules, await owner.protected.metadata()),
      devices,
    });
    if (!proposal) return false;
    const proof = await owner.protected.confirmAuthority(
      proposal.digest,
      this.now() + SECRET_REQUEST_LIFETIME_MS,
      reason,
    );
    return !!proof && (await owner.protected.saveAuthority(proposal.authority, proof)) === "stored";
  }

  async rehearse(input: SecretRehearsalInput): Promise<SecretRehearsal> {
    const owner = await this.ready();
    const result = await owner?.protected.rehearse(input);
    return result
      ? { ...result.evaluation, operation: result.operation, facts: checkedFacts(result.facts, []) }
      : null;
  }

  async exportHistory(): Promise<string | undefined> {
    return (await this.ready())?.protected.exportHistory();
  }

  /** Who asks and what runs, for the card: from the use's checked facts, never the requester's words. */
  private ask(owner: Owner, request: string): SecretAsk & { operation: string } {
    const task = this.taskOf.get(request)?.values().next().value;
    const title = task ? (this.options.taskTitle?.(task) ?? null) : null;
    const script = owner.protected.describe(request);
    if (script)
      return {
        task: title,
        operation: script.operation,
        run: {
          kind: "program",
          program: script.facts.executable.path,
          argv: script.facts.argv,
          cwd: script.facts.cwd,
          env: script.facts.env,
          ...(script.computer ? { computer: script.computer.label } : {}),
        },
      };
    const broker = owner.protected.describeBrokered(request);
    return {
      task: title,
      operation: broker?.operation ?? "",
      run: {
        kind: "service",
        label: broker?.facts.label ?? "",
        destination: broker?.facts.destination ?? "",
        operation: broker?.facts.operation ?? "",
      },
    };
  }

  /**
   * The approval card (INF-1690's plan, piece 2). Its title names the secrets and
   * who asks; its answers are Allow once, Always allow this (Allow for 10
   * minutes for an eligible read) and Don't allow. The one decision a person can
   * save is born here: Always allow this saves today's exact-run Allow. Don't
   * allow only refuses this use and saves nothing, so the next run asks again.
   */
  private async offerUse(owner: Owner, request: string, notice?: string): Promise<void> {
    const saved = await savedIdentities(owner);
    const pending = owner.requests.pending(request);
    if (!pending) return;
    const use = this.receiptView(owner, { request, state: "waiting" });
    const ask = this.ask(owner, request);
    const words = SECRET_APPROVAL_CARD_WORDS;
    const identities = withUse(saved, use.secrets);
    const names = use.secrets.map((secret) => nameOf(identities, secret.ref));
    const named = secretsNamedWords(names);
    const waiting = async (): Promise<boolean> => {
      if (!owner.requests.pending(request)) {
        this.message = "This request is no longer waiting. Check its current result in Secrets.";
        return false;
      }
      if ((await owner.protected.status()) !== "available") {
        this.message =
          "This use is still waiting. Unlock the system’s secret store, then review it again.";
        await this.offerUse(owner, request, this.message);
        return false;
      }
      return true;
    };
    const stillWaiting = async () => {
      if (owner.requests.status(request)?.state === "waiting") {
        this.message = "No confirmation was accepted. This request is still waiting.";
        await this.offerUse(owner, request, this.message);
      }
    };
    const confirm = async (short: boolean) => {
      if (!(await waiting())) return;
      const proof = short
        ? await owner.protected.confirmShortRead(
            request,
            pending.digest,
            pending.expires,
            words.confirmRead,
          )
        : await owner.protected.confirmUse(
            request,
            pending.digest,
            pending.expires,
            words.confirmOnce,
          );
      if (proof) await owner.requests.approve(request, proof);
      await stillWaiting();
    };
    const always = async () => {
      if (!(await waiting())) return;
      const authority = owner.protected.authority();
      if (!authority || !ask.operation) return;
      const refs = use.secrets.map((secret) => secret.ref);
      const covers = (rule: Rule) =>
        refs.includes(rule.secret) &&
        (rule.operation === undefined || rule.operation === ask.operation);
      // An Ask that covers this run would outrank the new Allow; the person just answered it.
      const rules: Rule[] = [
        ...authority.rules.filter((rule) => !(rule.effect === "ask" && covers(rule))),
        ...refs.map((secret) => ({
          id: randomUUID(),
          effect: "allow" as const,
          secret,
          operation: ask.operation,
          note: runWords(ask.run),
        })),
      ];
      const proposal = owner.protected.proposeAuthority({
        rules: withoutKept(rules, await owner.protected.metadata()),
        devices: authority.devices,
      });
      if (!proposal) return;
      const proofs = await owner.protected.confirmUseAndAuthority(
        { request, digest: pending.digest, expires: pending.expires },
        { digest: proposal.digest, expires: this.now() + SECRET_REQUEST_LIFETIME_MS },
        words.confirmAlways,
      );
      if (!proofs) {
        await stillWaiting();
        return;
      }
      // The run first: a saved change to decisions ends any use still waiting on the
      // older ones. Save once the run has begun, while the confirmation is fresh,
      // never after a long run has ended.
      await owner.requests.approve(request, proofs.use, "launched");
      if (owner.requests.status(request)?.state === "waiting") {
        await stillWaiting();
        return;
      }
      const saved = await owner.protected.saveAuthority(proposal.authority, proofs.authority);
      this.message = saved === "stored" ? words.allowed : words.notKept;
    };
    const deny = async () => {
      await owner.requests.deny(request);
    };
    this.useCards.add(request);
    this.offer(
      `use-${request}`,
      words.title(named, ask.task),
      secretApprovalBody(use, ask, identities, notice),
      // The footer draws the default last, so this reads Don't allow, the
      // second allow, then Allow once: the refusal stands apart (INF-4087).
      [
        { label: SECRETS_WORDS.once, run: () => confirm(false), kind: "allow-once" },
        { label: SECRETS_WORDS.deny, run: deny, kind: "deny" },
        use.shortReadEligible
          ? { label: SECRETS_WORDS.short, run: () => confirm(true), kind: "allow-short" }
          : { label: SECRETS_WORDS.always, run: always, kind: "allow-always" },
      ],
      this.taskOf.get(request)?.values().next().value,
    );
    // A phone reads which card is this use's once the card is up.
    this.options.changed();
  }

  /**
   * Settings removes one saved decision, in its plain sentence, saved only after the
   * system confirms the person. A decision is made only on a request's approval card
   * (INF-1690: "Only from the approval card"), so any other change is refused here.
   */
  private offerDecisions(
    owner: Owner,
    current: readonly Rule[],
    next: Rule[],
    entries: readonly { ref: string; label: string; environment?: string }[],
  ): void {
    const words = SAVED_DECISION_WORDS;
    const named = identitiesOf(entries);
    const same = (a: Rule, b: Rule) =>
      a.id === b.id &&
      a.effect === b.effect &&
      a.secret === b.secret &&
      a.operation === b.operation &&
      a.note === b.note;
    const removed = current.filter((rule) => !next.some((one) => same(one, rule)));
    const kept = next.every((rule) => current.some((one) => same(one, rule)));
    const authority = owner.protected.authority();
    const [rule] = removed;
    if (!kept || removed.length !== 1 || !rule || !authority) {
      this.message = words.onlyRemove;
      return;
    }
    this.askInPlace(
      "rules",
      { kind: "rule", rule: rule.id },
      words.removeTitle,
      [decisionWords(rule, nameOf(named, rule.secret)), words.removeBody, words.confirm],
      {
        confirm: {
          label: words.removeConfirm,
          run: async () => {
            const saved = await this.saveAuthority(
              owner,
              next,
              authority.devices,
              "Confirm the exact change to your saved Secrets decisions shown in Infinitary.",
              authority.revision,
            );
            this.message = saved ? words.saved : words.unchanged;
          },
        },
        keep: words.keep,
      },
    );
  }

  offer(
    group: string,
    title: string,
    body: string,
    actions: { label: string; run: () => Promise<void>; kind?: SecretUseAnswer }[],
    taskId?: string,
  ): void {
    for (const [id, offer] of this.offers) if (offer.group === group) this.offers.delete(id);
    // A use card's pass names its answer, so a window on another computer
    // answers it with that computer's own key (docs/secrets.md, "Remote decisions").
    const offered = actions.map((action) => ({
      ...action,
      id: action.kind ? `${action.kind}:${randomUUID()}` : randomUUID(),
    }));
    for (const action of offered)
      this.offers.set(action.id, {
        group,
        run: action.run,
        place: "card",
        ...(action.kind ? { kind: action.kind } : {}),
      });
    this.offeredCard = `card-secrets-${group}`;
    // A use a task asked for is its crewmate's to talk over: a reply under
    // the card reaches it, and the head names its task.
    const asker = taskId ? this.options.taskTitle?.(taskId) : undefined;
    this.options.raise({
      id: this.offeredCard,
      title,
      body,
      meta: asker ?? FIRSTMATE_CARD_META,
      ...(taskId ? { answeredBy: "crewmate" as const } : {}),
      ...(taskId ? { taskId } : {}),
      actions: offered.map((action, i) => ({
        id: action.id,
        label: action.label,
        ...(i === 0
          ? { default: true, variant: "primary" as const }
          : { variant: "ghost" as const }),
        effect: { kind: "host" as const, op: "secrets-decision" as const, arg: action.id },
      })),
    });
  }

  /**
   * A question Settings asks on the row it is about (Forget, Remove, Stop
   * approvals, Delete history), never on a card. The host still makes a
   * one-time pass for each answer, and only this computer's own window, which
   * reads the view, can spend one through the `answer` action. Keep has focus
   * on the page, so Enter never confirms.
   */
  private askInPlace(
    group: string,
    about: Question["about"],
    title: string,
    lines: readonly string[],
    answers: { confirm: { label: string; run: () => Promise<void> }; keep: string },
  ): void {
    this.dropQuestion();
    for (const [id, offer] of this.offers) if (offer.group === group) this.offers.delete(id);
    const confirm = randomUUID();
    const keep = randomUUID();
    this.offers.set(confirm, { group, run: answers.confirm.run, place: "settings" });
    this.offers.set(keep, { group, run: async () => {}, place: "settings" });
    this.question = {
      group,
      about,
      title,
      lines: [...lines],
      confirm: { label: answers.confirm.label, pass: confirm },
      keep: { label: answers.keep, pass: keep },
    };
  }

  private dropQuestion(): void {
    if (!this.question) return;
    const { group } = this.question;
    for (const [id, offer] of this.offers) if (offer.group === group) this.offers.delete(id);
    this.question = null;
  }

  /**
   * Spends one pass, once: a host card's chrome answers a card, and the
   * Settings page answers its own question (`place`). A stale pass after
   * restart, one already spent, or one from the other place is inert.
   */
  async decide(id: string, place: Offer["place"] = "card"): Promise<void> {
    const offer = this.offers.get(id);
    if (!offer || offer.place !== place) return;
    // An Allow pressed in a window on another computer needs that computer's
    // own key and confirmation (`inf:secrets:decide`), never this computer's:
    // the pass stays unspent and the use keeps waiting.
    if (offer.kind && offer.kind !== "deny" && askingView()) return;
    for (const [key, sibling] of this.offers)
      if (sibling.group === offer.group) this.offers.delete(key);
    if (this.question?.group === offer.group) this.question = null;
    this.message = null;
    this.offeredCard = null;
    const running = offer.run().catch(() => {
      this.message = SECRETS_WORDS.unavailable;
    });
    this.deciding.set(offer.group, running);
    try {
      await running;
    } finally {
      if (this.deciding.get(offer.group) === running) this.deciding.delete(offer.group);
    }
    this.options.changed();
  }

  /**
   * One task's command. Discovery is global: every crewmate lists the same
   * catalog of secrets the captain added, metadata only, and listing grants
   * no use. The task names its own receipts and inbox, never authority.
   */
  commandFor(context: { task: string }): SecretsCommand {
    return {
      receipts: () =>
        (this.owner?.requests.receipts() ?? []).filter((receipt) =>
          this.taskOf.get(receipt.request)?.has(context.task),
        ),
      list: async () => (await this.ready())?.protected.list() ?? [],
      // The crew's pre-check: the same checks a request meets, with no card or record.
      check: async (input: UseCheckInput) => {
        const owner = await this.ready();
        return owner ? owner.requests.check(structuredClone(input)) : { problem: "unavailable" };
      },
      inject: async (input: Injection) => {
        const copied = structuredClone(input);
        if (!validInjection(copied)) throw new Error("Invalid injection request.");
        const owner = await this.ready();
        if (!owner) return { request: copied.id, state: "unavailable" as const };
        const receipt = await owner.requests.inject({
          ...copied,
          id: taskIntent(context.task, copied.id),
        });
        this.track(owner, receipt, context.task);
        if (receipt.state === "waiting") await this.offerUse(owner, receipt.request);
        return receipt;
      },
      status: async (request: string) => (await this.ready())?.requests.status(request),
      ask: (input: SecretAskInput) => this.askToKeep(context.task, input),
      cancelAsk: (id: string) => this.cancelAsk(context.task, id),
      cancel: async (request: string) => {
        const owner = await this.ready();
        // The caller receives its cancellation directly; other requesters still need the result.
        this.awaiting.get(request)?.delete(context.task);
        return owner?.requests.cancel(request);
      },
    };
  }

  /**
   * A task's Secrets on a computer that runs work (docs/secrets.md, "On a
   * computer that runs work"): what that computer asks for its task, with
   * the facts its recipient bound there. The home decides each use with the
   * same card, saved decisions and history as one here; an approved use's
   * values go to that computer once, through `take`. The computer and task
   * are the work route's own, never the request's words.
   */
  async elsewhere(
    context: { task: string; computer: UseComputer },
    input: PlacedSecretUseInput,
  ): Promise<PlacedSecretUseAnswer> {
    const owner = await this.ready();
    const mine = (request: string) => {
      const placed = this.elsewhereOf.get(request);
      return placed?.computer === context.computer.id && placed.task === context.task;
    };
    const receipt = (found: UseReceipt | undefined) =>
      found ? { request: found.request, state: found.state, ...exitOf(found) } : null;
    switch (input.op) {
      case "check":
        return {
          check: owner
            ? await owner.requests.checkElsewhere(
                context.computer.id,
                input.facts as RecipientFacts,
              )
            : { problem: "unavailable" },
        };
      case "inject": {
        if (!owner) return { receipt: { request: input.id, state: "unavailable" } };
        // The computer names the intent too, so a run there never answers one asked here.
        const intent = taskIntent(context.task, `${context.computer.id}\u0000${input.id}`);
        const handed = await owner.requests.injectElsewhere(intent, {
          id: input.id,
          reason: input.reason,
          facts: input.facts as RecipientFacts,
          computer: { ...context.computer },
          hand: (request, values, authorized, launched) =>
            this.handoffs.hand(request, values, authorized, launched),
        });
        if (!this.elsewhereOf.has(handed.request))
          this.elsewhereOf.set(handed.request, {
            computer: context.computer.id,
            task: context.task,
          });
        if (!mine(handed.request))
          throw new Error("This intent already names a different operation.");
        this.track(owner, handed, context.task);
        if (handed.state === "waiting") await this.offerUse(owner, handed.request);
        return { receipt: receipt(owner.requests.status(handed.request) ?? handed) };
      }
      case "status":
        return {
          receipt:
            owner && mine(input.request) ? receipt(owner.requests.status(input.request)) : null,
        };
      case "cancel": {
        if (!owner || !mine(input.request)) return { receipt: null };
        this.awaiting.get(input.request)?.delete(context.task);
        return { receipt: receipt(await owner.requests.cancel(input.request)) };
      }
      case "ended":
        if (mine(input.request)) this.handoffs.ended(input.request, input.result);
        return { ok: true };
    }
  }

  /**
   * That computer's take of an approved use's values: once, after the home's
   * last authorization check and that use's start, or the state it reached
   * without them. It waits while the use waits for approval, at most until
   * the use's own lifetime ends.
   */
  async take(
    context: { task: string; computer: UseComputer },
    request: string,
    call: string,
  ): Promise<PlacedSecretTakeAnswer> {
    const owner = await this.ready();
    if (!owner) return { state: "unavailable" };
    for (;;) {
      // Checked at each wake: a take its computer forgot, gone with its conversation, takes nothing.
      const placed = this.elsewhereOf.get(request);
      if (placed?.computer !== context.computer.id || placed.task !== context.task)
        return { state: "unavailable" };
      // The work route asks a cut-off call again under its own id: that call receives the same values.
      const given = this.handoffs.take(request, call);
      if ("values" in given) return given;
      if (given.none === "taken") return { state: "taken" };
      if (given.none === "changed") return { state: "invalidated" };
      const status = owner.requests.status(request);
      if (!status) return { state: "unavailable" };
      if (status.state === "executing" && !this.handoffs.taken(request)) {
        // Started, its values not yet handed: they follow at once.
        await this.handoffs.wait(request, this.now() + SECRET_REQUEST_LIFETIME_MS, this.now());
        continue;
      }
      if (status.state !== "waiting") return { state: status.state };
      const expires = owner.requests.pending(request)?.expires ?? this.now();
      await this.handoffs.wait(request, expires, this.now());
    }
  }

  /**
   * The task's conversation on that computer closed for good or restarted
   * there, so nothing there follows its uses any more: a use whose values it
   * took ends unknown, one started but not taken ends unsent, one still
   * waiting is cancelled, and a take still waiting from before answers
   * unavailable instead of spending values later.
   */
  elsewhereGone(context: { task: string; computer: string }): void {
    for (const [request, placed] of [...this.elsewhereOf]) {
      if (placed.computer !== context.computer || placed.task !== context.task) continue;
      this.elsewhereOf.delete(request);
      this.handoffs.gone(request);
      if (this.owner?.requests.status(request)?.state === "waiting")
        void this.owner.requests.cancel(request).catch(() => undefined);
      this.handoffs.wake(request);
    }
  }

  askToKeep(task: string | null, input: SecretAskInput): Promise<SecretAskAnswer> {
    return this.asks.askToKeep(task, input);
  }

  /**
   * A task's ask to keep a secret from a computer that runs work, or its
   * withdrawal (docs/secrets.md, "Asking to keep a secret"): the same ask as
   * one from here, keyed by the task, raised on this computer's own card. The
   * task is the work route's own, never the request's words, and whether the
   * captain kept it reaches that task's inbox once.
   */
  async askElsewhere(task: string, input: PlacedSecretAskInput): Promise<PlacedSecretAskAnswer> {
    if (input.op === "cancel") return { withdrawn: this.cancelAsk(task, input.id) };
    const { op: _op, ...ask } = input;
    return { ask: await this.askToKeep(task, ask) };
  }

  firstMateAsks() {
    return {
      ask: (input: SecretAskInput) => this.askToKeep(null, input),
      cancel: (id: string) => this.cancelAsk(null, id),
    };
  }

  cancelAsk(task: string | null, id: string): boolean {
    return this.asks.cancelAsk(task, id);
  }

  resumeAsks(): void {
    this.asks.resumeAsks();
  }

  /** Keep on an ask card, with the values typed on it (`SecretAsks.keep`). */
  keep(input: SecretKeepInput): Promise<SecretKeep> {
    return this.asks.keep(input);
  }

  /** Core composition supplies executable adapters, never data from a renderer or agent. */
  registerBroker(broker: SecretBroker): void {
    if (this.brokers.has(broker.id)) throw new Error("Duplicate secret broker.");
    this.owner?.protected.registerBroker(broker);
    this.brokers.set(broker.id, broker);
    const owner = this.owner;
    if (owner) this.sweeping = this.sweeping.then(() => this.sweepUnnamed(owner));
  }

  /** The references a service's saved settings name for `consumer`; undefined while unknown. */
  private namedFor(consumer: SecretConsumer): readonly string[] | undefined {
    for (const broker of this.brokers.values())
      if (broker.keeps?.consumer === consumer) return broker.keeps.named();
    return undefined;
  }

  /**
   * Forgets each hidden entry a service keeps that its saved settings no
   * longer name, left by a crash between keeping and saving or a forget
   * refused while Secrets was closed (docs/secrets.md, "App sign-ins").
   */
  private async sweepUnnamed(owner: Owner): Promise<void> {
    try {
      for (const entry of await owner.protected.metadata()) {
        if (entry.discoverable || !entry.consumer) continue;
        const named = this.namedFor(entry.consumer);
        if (named && !named.includes(entry.ref)) {
          await owner.protected.forgetSecret(entry.ref, entry.version, entry.revision);
          this.options.changed();
        }
      }
    } catch {
      // A sweep that cannot run now leaves the entry for Forget on the Secrets page.
    }
  }

  /** Host-registered consumers only. The caller keeps raw results inside its trusted boundary. */
  async broker(input: BrokeredUse, task?: string): Promise<UseReceipt> {
    const copied = structuredClone(input);
    if (!validBrokeredUse(copied)) throw new Error("Invalid brokered request.");
    const owner = await this.ready();
    if (!owner) return { request: copied.id, state: "unavailable" };
    const receipt = await owner.requests.broker(copied);
    if (task) this.track(owner, receipt, task);
    if (receipt.state === "waiting") await this.offerUse(owner, receipt.request);
    return receipt;
  }
  async takeBrokerResult(request: string): Promise<unknown> {
    return (await this.ready())?.protected.takeBrokerResult(request);
  }

  /**
   * A host-registered consumer's use, awaited to its end (docs/secrets.md,
   * "App services"): the receipt once it is no longer waiting or running,
   * and the broker's private result when it completed. A use with no saved
   * decision raises the ordinary exact-use card and waits on it.
   */
  async use(input: BrokeredUse): Promise<{ state: UseState; result?: unknown }> {
    let resolve: (receipt: UseReceipt) => void = () => {};
    const ended = new Promise<UseReceipt>((done) => {
      resolve = done;
    });
    const owner = await this.ready();
    if (!owner) return { state: "unavailable" };
    const receipt = await this.broker(input);
    let final: UseReceipt = receipt;
    if (receipt.state === "waiting" || receipt.state === "executing") {
      this.ending.set(receipt.request, resolve);
      const settled = owner.requests.settled(receipt.request);
      if (settled) resolve(settled);
      // Expiry is read lazily: reading the receipt once its time is up ends it.
      const expires = owner.requests.pending(receipt.request)?.expires;
      const timer =
        expires === undefined
          ? undefined
          : setTimeout(
              () => owner.requests.status(receipt.request),
              Math.max(0, expires - this.now()) + 1,
            );
      timer?.unref?.();
      try {
        final = await ended;
      } finally {
        if (timer) clearTimeout(timer);
        this.ending.delete(receipt.request);
      }
    }
    // Always allow this saves its rule once the use has begun: the consumer's next use waits for it.
    await this.deciding.get(`use-${final.request}`);
    if (final.state !== "completed") return { state: final.state };
    return { state: "completed", result: owner.protected.takeBrokerResult(final.request) };
  }

  /**
   * A host consumer's own credential (docs/secrets.md, "App services"),
   * kept hidden from the crew's catalog and shown in Settings by its label.
   * Without a reference, the controller makes a fresh one no entry, rule or
   * history names. Answers the reference, or undefined when protection
   * cannot keep it now.
   */
  async keepHidden(input: {
    ref?: string;
    label: string;
    value: Buffer;
    /** Kept for a program the service starts (docs/secrets.md, "Programs that keep running"). */
    forProgram?: true;
    /** The app service it belongs to, when not an Integrations sign-in. */
    consumer?: SecretConsumer;
  }): Promise<string | undefined> {
    try {
      const owner = await this.ready(true);
      if (!owner) return undefined;
      const current = input.ref
        ? (await owner.protected.metadata()).find((entry) => entry.ref === input.ref)
        : undefined;
      // A consumer replaces only its own hidden entry, never one the captain added.
      if (current?.discoverable) return undefined;
      const ref = input.ref ?? (await this.freshReference(owner, input.label));
      const written = await owner.protected.putSecret(ref, input.label, input.value, {
        discoverable: false,
        ...(input.forProgram ? { forProgram: true as const } : {}),
        ...(input.consumer ? { consumer: input.consumer } : {}),
      });
      return written?.ref;
    } catch {
      return undefined;
    } finally {
      input.value.fill(0);
      this.options.changed();
    }
  }

  /** A reference for a hidden entry before it is written, so a move can record it first. */
  async reference(label: string): Promise<string | undefined> {
    const owner = await this.ready(true);
    return owner ? this.freshReference(owner, label) : undefined;
  }

  /**
   * Every hidden entry kept for a program, so its service can forget one no
   * saved program names; undefined when Secrets cannot answer now.
   */
  async programKeys(): Promise<string[] | undefined> {
    try {
      const owner = await this.ready();
      if (!owner) return undefined;
      return (await owner.protected.metadata())
        .filter((entry) => !entry.discoverable && entry.forProgram === true)
        .map((entry) => entry.ref);
    } catch {
      return undefined;
    }
  }

  /** Forget a host consumer's hidden entry; the captain's own entries are never touched. */
  async forgetHidden(ref: string): Promise<boolean> {
    try {
      const owner = await this.ready();
      if (!owner) return false;
      const current = (await owner.protected.metadata()).find((entry) => entry.ref === ref);
      if (!current) return true;
      if (current.discoverable) return false;
      return await owner.protected.forgetSecret(ref, current.version, current.revision);
    } catch {
      return false;
    } finally {
      this.options.changed();
    }
  }

  private async freshReference(owner: Owner, label: string): Promise<string> {
    return newReference(label, [
      ...(await owner.protected.metadata()).map((entry) => entry.ref),
      ...(owner.protected.authority()?.rules.map((rule) => rule.secret) ?? []),
      ...owner.protected.history().flatMap((item) => item.secrets),
    ]);
  }
}

function exitOf(receipt: UseReceipt): { exitCode?: number } {
  return receipt.exitCode === undefined ? {} : { exitCode: receipt.exitCode };
}

/** Namespace idempotency, not authority: two tasks may choose the same local intent name. */
function taskIntent(task: string, id: string): string {
  return JSON.stringify([task, id]);
}

/** The task a crewmate's intent names (`taskIntent`), or undefined for any other intent. */
function intentTask(intent: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(intent);
    return Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      parsed[0] !== "" &&
      typeof parsed[1] === "string"
      ? parsed[0]
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The saved decisions without those naming a hidden entry (docs/secrets.md,
 * "App sign-ins", "Programs that keep running"): signing in, or giving a key
 * with a program, is its consent, so such a decision no longer applies, is
 * not shown, and the next confirmed save leaves it out.
 */
function withoutKept(
  rules: readonly Rule[],
  entries: readonly { ref: string; discoverable?: boolean }[],
): Rule[] {
  const kept = new Set(entries.filter((entry) => !entry.discoverable).map((entry) => entry.ref));
  return rules.filter((rule) => !kept.has(rule.secret));
}

/** Secrets as a sentence tells them apart: name, place (empty when none) and reference. */
function identitiesOf(
  entries: readonly { ref: string; label: string; environment?: string }[],
): SecretIdentities {
  return entries.map(({ ref, label, environment }) => ({
    ref,
    label,
    environment: environment ?? "",
  }));
}

/** Every saved secret, to name a use's secrets among as Settings does; an unreadable list names none. */
async function savedIdentities(owner: Owner): Promise<SecretIdentities> {
  return identitiesOf(await owner.protected.metadata().catch(() => []));
}

/**
 * The use's own secrets as it prepared them, never a later replacement's name
 * or place, among every other saved secret.
 */
function withUse(
  saved: SecretIdentities,
  secrets: readonly { ref: string; label: string; environment?: string }[],
): SecretIdentities {
  return [
    ...identitiesOf(secrets),
    ...saved.filter((one) => !secrets.some((secret) => secret.ref === one.ref)),
  ];
}
