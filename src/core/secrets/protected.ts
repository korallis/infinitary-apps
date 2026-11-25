import { randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type FreshAuthentication,
  LocalApprovals,
  type LocalProof,
  RemoteApprovals,
} from "./approvals";
import { type Authority, type Evaluation, ProtectedAuthority } from "./authority";
import type { SourceOutput } from "./bringOutput";
import {
  type BrokeredUse,
  type BrokerFacts,
  brokerInputDigest,
  type SecretBroker,
} from "./brokers";
import { type CustodyRefusal, canonical, RootKeys, type SecretCustody, sha256 } from "./custody";
import { type HistoryItem, type JournalEntry, type JournalSnapshot, UseJournal } from "./journal";
import { ReadAccess, type ReadPermission, SHORT_READ_SECONDS, SHORT_READ_USES } from "./readAccess";
import {
  keepsHostVariable,
  type PreparedRecipient,
  prepareRecipient,
  type RecipientFacts,
} from "./recipient";
import {
  clearRecovery,
  openRecovery,
  type RecoveryContents,
  type RecoveryFiles,
  sealRecovery,
} from "./recoveryArchive";
import {
  hasSecretHomeRecords,
  observeSecretHome,
  openSecretHome,
  type SecretHome,
  secretHistoryFiles,
} from "./recoveryHome";
import { type StagedRecovery, stageRecovery } from "./recoveryStage";
import {
  type ElsewhereCheck,
  type ElsewhereUse,
  type Injection,
  inputDigest,
  type PreparedUse,
  type SecretReference,
  type SecretsBackend,
  type UseCheck,
  type UseCheckInput,
  type UseComputer,
  type UseReceipt,
  type UseState,
  validInjection,
} from "./requests";
import { type SecretMetadataInput, SecretVault, type VaultEntry } from "./vault";

/** Whether this owner can serve uses, or why not. Every state but `available` refuses every use. */
export type SecretsAvailability = "available" | CustodyRefusal | "tampered";

export type ProtectedSecretsOptions = {
  /** The owner's private folder, outside every project: `<userData>/secrets`. */
  dir: string;
  custody: SecretCustody;
  /** Absent on a computer that cannot confirm the person (a headless start): human Allow waits. */
  authentication?: FreshAuthentication;
  /** The host environment a recipient's few base variables come from (`hostEnv`). */
  environment: () => NodeJS.ProcessEnv;
  now?: () => number;
  /** Trusted consumer adapters, supplied as code by composition, never from agent or saved input. */
  brokers?: readonly SecretBroker[];
  /**
   * Create the root key when nothing was ever sealed here. Only the trusted
   * controller's first Add sets it; an ordinary start never creates custody.
   */
  initialize?: boolean;
};

/**
 * One secret as the use prepared it: the record's name, reference, version and
 * environment label, read once at preparation, so a later replacement never
 * changes what an approval screen names. Never its value.
 */
export type PreparedSecret = Pick<VaultEntry, "ref" | "label" | "version" | "environment">;

/** What a trusted approval screen shows: checked facts, and the requester's words beside them. */
export type UseDescription = {
  request: string;
  /** The operation key a saved Allow names (`recipient.ts`), so a card can save this exact run. */
  operation: string;
  facts: RecipientFacts;
  /** The computer the program runs on, when it is not this one. */
  computer?: UseComputer;
  secrets: PreparedSecret[];
  reason: string;
  evaluation: Evaluation;
};

export type BrokerUseDescription = {
  request: string;
  /** The operation key a saved Allow names, as for a program. */
  operation: string;
  facts: BrokerFacts;
  secrets: PreparedSecret[];
  reason: string;
  evaluation: Evaluation;
  shortReadEligible: boolean;
};

type KeptBroker = {
  description: BrokerUseDescription;
  key: string;
  permission?: string;
  permissionEpoch?: number;
  permissionExpires?: number;
};

type Ready = {
  home: SecretHome;
  keys: RootKeys;
  vault: SecretVault;
  authority: ProtectedAuthority;
  journal: UseJournal;
  local: LocalApprovals;
  remote: RemoteApprovals;
};

type Ended = Exclude<UseState, "waiting" | "executing" | "completed">;
export type RecoverySave = "saved" | "partial" | "cancelled" | "unavailable";
export type RecoveryBackup = RecoverySave | "refused" | "unknown";
export type RecoveryRestore =
  | "restored"
  | "refused"
  | "invalid"
  | "busy"
  | "changed"
  | "locked"
  | "unavailable"
  | "unknown";
/**
 * A Copy value's outcome (docs/secrets.md, "Copying a value"), never the
 * value: `refused` when the system confirmed no one, `changed` when the
 * secret is not the record the row showed, `unknown` when the writer failed
 * after the copy was journaled.
 */
export type SecretCopy = "copied" | "refused" | "changed" | "unavailable" | "unknown";
/** A start-over's outcome; `unneeded` when storage does not read lost or tampered. */
export type SecretsStartOver =
  | "started"
  | "unneeded"
  | "refused"
  | "busy"
  | "changed"
  | "locked"
  | "unavailable"
  | "unknown";

const RESTORE_REASON =
  "Restore the selected Secrets archive, replace this computer's stored values and reset all saved permissions and approval devices.";
const STANDBY_REPLACE_REASON =
  "Use the Secrets kept with your first mate's copy, replace this computer's stored values and reset all saved permissions and approval devices.";
const START_OVER_REASON =
  "Start Secrets over with no stored values, leave the values it can no longer read unreadable for good and reset all saved permissions and approval devices.";

/**
 * The protected Secrets backend (docs/secrets.md): native root custody, a
 * sealed vault, protected rules, an exact recipient, a durable journal and
 * trusted approvals behind `SecretRequests`. It refuses whenever any of them is
 * unavailable - there is no plaintext, environment or unprotected fallback. The
 * app builds it on macOS and Linux from the host's native custody
 * (src/main/host/nativeSecrets.ts); without that capability every use refuses.
 */
export class ProtectedSecrets implements SecretsBackend {
  private readonly described = new Map<string, UseDescription>();
  private readonly now: () => number;
  private readonly brokers: Map<string, SecretBroker>;
  private readonly brokered = new Map<string, KeptBroker>();
  private readonly brokerResults = new Map<string, unknown>();
  private readonly readAccess: ReadAccess;
  private readEpoch = 0;
  private materialEpoch = 0;
  private mutation: Promise<unknown> = Promise.resolve();
  private recovering = false;
  private retired = false;

  private constructor(
    private readonly options: ProtectedSecretsOptions,
    readonly availability: SecretsAvailability,
    private readonly ready?: Ready,
  ) {
    this.now = options.now ?? Date.now;
    this.readAccess = new ReadAccess(this.now);
    this.brokers = new Map();
    for (const broker of options.brokers ?? []) this.registerBroker(broker);
  }

  /** A core consumer's code capability, never accepted from a command, IPC or saved record. */
  registerBroker(broker: SecretBroker): void {
    if (this.brokers.has(broker.id)) throw new Error("Duplicate secret broker.");
    this.brokers.set(broker.id, broker);
  }

  /**
   * Open the owner. Always answers: an owner that cannot open is a refusing one,
   * so a headless start with no custody reports `unavailable` honestly. Private
   * run folders a previous process left are removed first, whatever happens next.
   */
  static async open(options: ProtectedSecretsOptions): Promise<ProtectedSecrets> {
    const now = options.now ?? Date.now;
    await mkdir(options.dir, { recursive: true, mode: 0o700 });
    await rm(join(options.dir, "runs"), { recursive: true, force: true });
    const home = await openSecretHome(options.dir, options.custody);
    if (typeof home === "string") return new ProtectedSecrets(options, home);
    const keys = await RootKeys.open(home.custody, {
      initialize: options.initialize === true,
      hasRecords: await hasSecretHomeRecords(options.dir),
    });
    if (typeof keys === "string") return new ProtectedSecrets(options, keys);
    const authority = await ProtectedAuthority.load(home.dir, keys, home.custody).catch(
      () => "unavailable" as const,
    );
    if (typeof authority === "string") {
      keys.destroy();
      return new ProtectedSecrets(options, authority);
    }
    return new ProtectedSecrets(options, "available", {
      home,
      keys,
      vault: new SecretVault(home.dir, keys, now),
      authority,
      journal: await UseJournal.open(home.dir, keys, now),
      local: new LocalApprovals(options.authentication, now),
      remote: new RemoteApprovals(now),
    });
  }

  async list(): Promise<SecretReference[]> {
    const entries = await this.metadata();
    return this.retired
      ? []
      : entries
          .filter((entry) => entry.discoverable)
          .map(({ ref, label, version, environment }) => ({
            ref,
            label,
            version: String(version),
            // Context for telling two of one name apart, never a filter.
            ...(environment ? { environment } : {}),
          }));
  }

  restored(): { intent: string; inputDigest: string; receipt: UseReceipt }[] {
    return this.ready?.journal.restored() ?? [];
  }

  /** Live owner facts, rechecked synchronously at delivery after all awaited validation. */
  private authorizationCurrent(materialEpoch: number, authorityRevision: number): boolean {
    return (
      !this.recovering &&
      !this.retired &&
      materialEpoch === this.materialEpoch &&
      this.ready?.authority.authority.revision === authorityRevision
    );
  }

  async prepare(
    input: Injection,
    request: string,
    _expires: number,
  ): Promise<PreparedUse | undefined> {
    return this.prepareProgram(input, request);
  }

  /** Bring is a one-time protected use: saved Allow never releases a key to an import. */
  async prepareBringProgram(
    input: Injection,
    request: string,
    capture: { limitMs: number; authorized(): boolean; receive(output: SourceOutput): void },
  ): Promise<PreparedUse | undefined> {
    if (!validInjection(input)) return undefined;
    return this.prepareProgram(input, request, capture);
  }

  private async prepareProgram(
    input: Injection,
    request: string,
    capture?: { limitMs: number; authorized(): boolean; receive(output: SourceOutput): void },
  ): Promise<PreparedUse | undefined> {
    if (this.recovering || this.retired) return undefined;
    const ready = this.ready;
    const epoch = this.materialEpoch;
    if (!ready || !input.cwd || !(await this.custodyCurrent())) return undefined;
    const entries = await this.crewEntries(ready, input.env);
    if (!entries) return undefined;
    const runDir = join(this.options.dir, "runs", request);
    const base = this.options.environment();
    const recipient = await prepareRecipient(
      { argv: input.argv, cwd: input.cwd, env: input.env },
      runDir,
      base.PATH ?? "",
      capture,
    ).catch(() => undefined);
    if (!recipient || "refused" in recipient) {
      await rm(runDir, { recursive: true, force: true });
      return undefined;
    }
    return this.offerUse(
      ready,
      epoch,
      request,
      input,
      entries,
      recipient,
      base,
      undefined,
      !!capture,
    );
  }

  /**
   * A use whose program runs on a computer that runs work (docs/secrets.md,
   * "On a computer that runs work"). That computer's recipient bound the
   * facts; this owner checks the secrets, meets the saved decisions with an
   * operation key that names the computer too, journals the use, raises the
   * same approval, and at the start hands the values to that computer once,
   * after its last authorization check. The computer checks its bound facts
   * again right before the program starts.
   */
  async prepareElsewhere(
    use: ElsewhereUse,
    request: string,
    _expires: number,
  ): Promise<PreparedUse | undefined> {
    if (this.recovering || this.retired) return undefined;
    const ready = this.ready;
    const epoch = this.materialEpoch;
    const input = elsewhereInjection(use);
    if (!ready || !input || !(await this.custodyCurrent())) return undefined;
    const entries = await this.crewEntries(ready, input.env);
    if (!entries) return undefined;
    const facts = structuredClone(use.facts);
    const recipient: PreparedRecipient = {
      facts,
      operation: elsewhereOperation(use.computer.id, facts),
      // That computer checks its bound files again right before the start.
      check: async () => true,
      launch: async (values, _base, authorized, launched) =>
        authorized() ? use.hand(request, values, authorized, launched) : "changed",
      dispose: async () => {},
    };
    return this.offerUse(ready, epoch, request, input, entries, recipient, {}, use.computer);
  }

  /** Every secret a crew request names, each one the crew may use; nothing when any is not. */
  private async crewEntries(
    ready: Ready,
    env: Record<string, string>,
  ): Promise<VaultEntry[] | undefined> {
    const entries: VaultEntry[] = [];
    for (const ref of [...new Set(Object.values(env))].sort()) {
      const entry = await ready.vault.entry(ref);
      // Unknown and hidden references answer the same: unavailable, naming nothing.
      if (!entry?.discoverable) return undefined;
      entries.push(entry);
    }
    return entries;
  }

  /**
   * The checked crew use, here or on a computer that runs work: its saved
   * decision, digest and journal lines, and the launch behind every check.
   */
  private async offerUse(
    ready: Ready,
    epoch: number,
    request: string,
    input: Injection,
    entries: VaultEntry[],
    recipient: PreparedRecipient,
    base: NodeJS.ProcessEnv,
    computer?: UseComputer,
    freshOnly = false,
  ): Promise<PreparedUse | undefined> {
    const refs = entries.map((entry) => entry.ref);
    const authority = ready.authority.authority;
    const saved = ready.authority.evaluate(refs, recipient.operation);
    const evaluation: Evaluation =
      freshOnly && saved.effect === "allow" ? { effect: "ask", matched: [] } : saved;
    const versions = entries.map(({ ref, version, revision }) => ({ ref, version, revision }));
    const digest = sha256(
      canonical({
        home: authority.home,
        request,
        operation: recipient.operation,
        facts: recipient.facts,
        secrets: versions,
        authority: authority.revision,
        ...(freshOnly ? { delivery: "bring" } : {}),
      }),
    );
    try {
      await ready.journal.append({
        kind: "requested",
        request,
        intent: input.id,
        inputDigest: inputDigest(input),
        digest,
        secrets: refs,
        program: recipient.facts.executable.path,
        reason: input.reason,
        rule: evaluation.effect,
        ...(computer ? { computer: computer.label } : {}),
      });
      if (evaluation.effect === "allow")
        await ready.journal.append({ kind: "approved", request, method: "rule" });
    } catch {
      // A use the journal cannot hold is never offered.
      await recipient.dispose();
      return undefined;
    }
    this.described.set(request, {
      request,
      operation: recipient.operation,
      facts: recipient.facts,
      ...(computer ? { computer: { ...computer } } : {}),
      secrets: entries.map(preparedSecret),
      reason: input.reason,
      evaluation,
    });

    let recorded = false;
    const end = async (state: Ended) => {
      if (recorded) return;
      recorded = true;
      await ready.journal.append({ kind: "ended", request, state }).catch(() => {});
    };
    const authorized = () => this.authorizationCurrent(epoch, authority.revision);
    const current = async (): Promise<boolean> => {
      if (!(await this.custodyCurrent()) || !authorized()) return false;
      for (const { ref, version, revision } of versions) {
        const entry = await ready.vault.entry(ref);
        if (
          !authorized() ||
          !entry?.discoverable ||
          entry.version !== version ||
          entry.revision !== revision
        )
          return false;
      }
      return (await recipient.check()) && authorized();
    };

    return {
      digest,
      rule: evaluation.effect,
      current,
      execute: async (began) => {
        try {
          await ready.journal.append({ kind: "consumed", request });
        } catch {
          // Consumption could not be made durable: nothing starts.
          await end("unavailable");
          return { state: "unavailable" };
        }
        const values: Record<string, Buffer> = {};
        try {
          for (const [name, ref] of Object.entries(input.env)) {
            const opened = await ready.vault.open(ref);
            const bound = versions.find((one) => one.ref === ref);
            if (
              !opened ||
              !bound ||
              opened.entry.version !== bound.version ||
              opened.entry.revision !== bound.revision
            ) {
              opened?.value.fill(0);
              await end("invalidated");
              return { state: "invalidated" };
            }
            values[name] = opened.value;
          }
          if (!(await current())) {
            await end("invalidated");
            return { state: "invalidated" };
          }
          const launched = await recipient
            .launch(values, base, authorized, began)
            .catch(() => "failed" as const);
          if (launched === "changed") {
            await end("invalidated");
            return { state: "invalidated" };
          }
          if (launched === "undeliverable") {
            await end("unavailable");
            return { state: "unavailable" };
          }
          if (launched === "failed" || "signal" in launched) {
            await end("unknown");
            return { state: "unknown" };
          }
          recorded = true;
          await ready.journal
            .append({ kind: "completed", request, exitCode: launched.exitCode })
            .catch(() => {
              // The effect happened; the next open reads this use as unknown, which is honest.
            });
          return { exitCode: launched.exitCode };
        } finally {
          for (const value of Object.values(values)) value.fill(0);
        }
      },
      dispose: async (ended) => {
        this.described.delete(request);
        ready.remote.forget(request);
        try {
          await recipient.dispose();
        } catch (failure) {
          await end("unknown");
          throw failure;
        }
        if (ended !== "waiting" && ended !== "executing" && ended !== "completed") await end(ended);
      },
    };
  }

  /**
   * The broker uses this owner's custody, protected rules, journal and approvals.
   * A bounded grant never covers a launch, renewal or write, nor an explicit Ask rule.
   * Results stay private for the trusted adapter's consumer; the command gets a receipt only.
   */
  async prepareBrokered(
    input: BrokeredUse,
    request: string,
    _expires: number,
  ): Promise<PreparedUse | undefined> {
    if (this.recovering || this.retired) return undefined;
    const ready = this.ready;
    const adapter = this.brokers.get(input.broker);
    const epoch = this.materialEpoch;
    if (!ready || !adapter || !(await this.custodyCurrent())) return undefined;
    const prepared = await adapter.prepare(structuredClone(input.input));
    if (!prepared) return undefined;
    const facts = structuredClone(prepared.facts);
    const refs = [...new Set(Object.values(facts.secrets))].sort();
    const entries: VaultEntry[] = [];
    for (const ref of refs) {
      const entry = await ready.vault.entry(ref);
      // A registered app service may use hidden credentials; registration alone is not approval.
      if (!entry) {
        await prepared.dispose?.();
        return undefined;
      }
      entries.push(entry);
    }
    if (
      facts.broker !== adapter.id ||
      refs.length === 0 ||
      !/^[0-9a-f]{64}$/.test(facts.inputDigest)
    ) {
      await prepared.dispose?.();
      return undefined;
    }
    const authority = ready.authority.authority;
    const operation = sha256(canonical({ kind: "broker", facts }));
    // The person's own giving is the consent, so the use meets no saved decision
    // and asks nothing: a sign-in made in the app, spent by an adapter declaring
    // `signIn` (docs/secrets.md, "App sign-ins"), or keys given with a program,
    // started by one declaring `givenWithProgram` ("Programs that keep running").
    // Every secret is hidden, and kept for a program exactly when the adapter
    // starts one; anything else, a crew-visible entry above all, is evaluated as
    // always.
    const hidden = entries.every((entry) => !entry.discoverable);
    const consent: "sign-in" | "given" | undefined = !hidden
      ? undefined
      : adapter.signIn === true && entries.every((entry) => entry.forProgram !== true)
        ? "sign-in"
        : adapter.givenWithProgram === true && entries.every((entry) => entry.forProgram === true)
          ? "given"
          : undefined;
    const evaluation: Evaluation = consent
      ? { effect: "allow", matched: [] }
      : ready.authority.evaluate(refs, operation);
    const versions = entries.map(({ ref, version, revision }) => ({ ref, version, revision }));
    const key = sha256(
      canonical({
        home: authority.home,
        operation,
        secrets: versions,
        authority: authority.revision,
      }),
    );
    const digest = sha256(canonical({ key, request }));
    const shortReadEligible =
      !consent && facts.read && evaluation.effect === "ask" && evaluation.matched.length === 0;
    const permission = shortReadEligible ? this.readAccess.find(key) : undefined;
    const kept: KeptBroker = {
      key,
      ...(permission
        ? {
            permission: permission.id,
            permissionEpoch: this.readEpoch,
            permissionExpires: permission.expires,
          }
        : {}),
      description: {
        request,
        operation,
        facts,
        secrets: entries.map(preparedSecret),
        reason: input.reason,
        evaluation,
        shortReadEligible,
      },
    };
    try {
      await ready.journal.append({
        kind: "requested",
        request,
        intent: input.id,
        inputDigest: brokerInputDigest(input),
        digest,
        secrets: refs,
        program: facts.label,
        reason: input.reason,
        rule: evaluation.effect,
        ...(consent === "given" ? { given: true as const } : {}),
      });
      if (consent !== "given" && (evaluation.effect === "allow" || permission))
        await ready.journal.append({
          kind: "approved",
          request,
          method: consent ?? (permission ? "short-read" : "rule"),
        });
    } catch {
      await prepared.dispose?.();
      return undefined;
    }
    this.brokered.set(request, kept);
    let ended = false;
    const end = async (state: Ended) => {
      if (ended) return;
      ended = true;
      await ready.journal.append({ kind: "ended", request, state });
    };
    const authorized = () =>
      this.authorizationCurrent(epoch, authority.revision) &&
      (kept.permission === undefined ||
        (kept.permissionEpoch === this.readEpoch && this.now() < (kept.permissionExpires ?? 0)));
    const current = async () => {
      if (!(await this.custodyCurrent()) || !authorized()) return false;
      for (const { ref, version, revision } of versions) {
        const entry = await ready.vault.entry(ref);
        if (!authorized() || !entry || entry.version !== version || entry.revision !== revision)
          return false;
      }
      return authorized();
    };
    return {
      digest,
      rule: permission ? "allow" : evaluation.effect,
      current,
      execute: async (began) => {
        if (kept.permission && !this.readAccess.consume(kept.permission, key)) {
          await end("invalidated");
          return { state: "invalidated" };
        }
        try {
          await ready.journal.append({ kind: "consumed", request });
        } catch {
          await end("unavailable").catch(() => {});
          return { state: "unavailable" };
        }
        const values: Record<string, Buffer> = Object.create(null);
        try {
          for (const [name, ref] of Object.entries(facts.secrets)) {
            const opened = await ready.vault.open(ref);
            const bound = versions.find((one) => one.ref === ref);
            if (
              !opened ||
              !bound ||
              opened.entry.version !== bound.version ||
              opened.entry.revision !== bound.revision
            ) {
              opened?.value.fill(0);
              await end("invalidated");
              return { state: "invalidated" };
            }
            values[name] = opened.value;
          }
          if (!(await current()) || !authorized()) {
            await end("invalidated");
            return { state: "invalidated" };
          }
          began?.();
          const result = await prepared.run(values);
          // A response object belongs only to the registered consumer. It never enters the journal.
          this.brokerResults.set(request, result);
          ended = true;
          await ready.journal.append({ kind: "completed", request }).catch(() => {});
          return { completed: true };
        } catch {
          await end("unknown").catch(() => {});
          return { state: "unknown" };
        } finally {
          for (const value of Object.values(values)) value.fill(0);
        }
      },
      dispose: async (state) => {
        this.brokered.delete(request);
        ready.remote.forget(request);
        try {
          await prepared.dispose?.();
        } catch (error) {
          this.brokerResults.delete(request);
          await end("unknown");
          throw error;
        }
        if (state !== "waiting" && state !== "executing" && state !== "completed") await end(state);
      },
    };
  }

  async authenticate(
    request: string,
    digest: string,
    expires: number,
    proof: unknown,
  ): Promise<boolean> {
    const ready = this.ready;
    if (!ready) return false;
    const epoch = this.readEpoch;
    let device: string | undefined;
    const broker = this.brokered.get(request);
    const shortRead =
      broker?.description.shortReadEligible === true &&
      ready.local.consume(proof, `short-read:${request}`, this.shortReadDigest(digest));
    const local = shortRead || ready.local.consume(proof, `use:${request}`, digest);
    if (!local) {
      const authority = ready.authority.authority;
      device = ready.remote.consume(proof, {
        home: authority.home,
        request,
        digest,
        devices: authority.devices,
      });
      if (!device) return false;
    }
    try {
      await ready.journal.append({
        kind: "approved",
        request,
        method: local ? "local" : "remote",
        ...(device ? { device } : {}),
      });
    } catch {
      return false;
    }
    if (shortRead && broker) {
      if (epoch !== this.readEpoch || this.now() >= expires) return false;
      broker.permission = this.readAccess.grant({
        key: broker.key,
        label: broker.description.facts.label,
        destination: broker.description.facts.destination,
        secrets: broker.description.secrets.map((secret) => secret.ref),
      });
      broker.permissionEpoch = epoch;
      broker.permissionExpires = this.readAccess.find(broker.key)?.expires;
    }
    return true;
  }

  // Trusted controller only. None of what follows is reachable from the agent facade.

  describeBrokered(request: string): BrokerUseDescription | undefined {
    const described = this.brokered.get(request)?.description;
    return described ? structuredClone(described) : undefined;
  }

  /** The registered consumer takes its response once; never exposed through AXI or a general IPC. */
  takeBrokerResult(request: string): unknown {
    const result = this.brokerResults.get(request);
    this.brokerResults.delete(request);
    return result;
  }

  readPermissions(): ReadPermission[] {
    return this.readAccess.list();
  }
  endReadAccess(id?: string): void {
    this.readEpoch += 1;
    this.readAccess.end(id);
  }

  async confirmShortRead(
    request: string,
    digest: string,
    expires: number,
    reason: string,
  ): Promise<LocalProof | undefined> {
    if (!this.brokered.get(request)?.description.shortReadEligible) return undefined;
    return this.ready?.local.confirm(
      `short-read:${request}`,
      this.shortReadDigest(digest),
      expires,
      reason,
    );
  }

  private shortReadDigest(digest: string): string {
    return sha256(
      canonical({
        digest,
        epoch: this.readEpoch,
        seconds: SHORT_READ_SECONDS,
        uses: SHORT_READ_USES,
      }),
    );
  }

  /** The checked facts of a waiting use, for the trusted approval screen. */
  describe(request: string): UseDescription | undefined {
    const description = this.described.get(request);
    return description ? structuredClone(description) : undefined;
  }

  /** Metadata for the trusted Settings view, including entries hidden from agents. */
  async metadata(): Promise<VaultEntry[]> {
    if (this.retired) return [];
    try {
      const entries = (await this.ready?.vault.list()) ?? [];
      return this.retired ? [] : entries;
    } catch (error) {
      // A read already in flight can meet retirement's cleared derived keys.
      if (this.retired) return [];
      throw error;
    }
  }

  /** Report a lock or a replaced root without opening a new owner or changing system locking. */
  async status(): Promise<SecretsAvailability> {
    if (this.recovering || this.retired) return "unavailable";
    if (!this.ready) return this.availability;
    try {
      const read = await this.ready.home.custody.read("root");
      if (read.kind !== "value") return read.kind === "absent" ? "lost" : read.kind;
      const same = sha256(read.bytes).slice(0, 16) === this.ready.keys.fingerprint;
      read.bytes.fill(0);
      return this.retired || this.recovering ? "unavailable" : same ? "available" : "lost";
    } catch {
      return "unavailable";
    }
  }

  /** Ask the system to confirm the person for this exact use; the proof passes `approve` once. */
  async confirmUse(
    request: string,
    digest: string,
    expires: number,
    reason: string,
  ): Promise<LocalProof | undefined> {
    return this.ready?.local.confirm(`use:${request}`, digest, expires, reason);
  }

  /**
   * One confirmation for "Always allow this": a proof for this exact use and a
   * proof for the exact next authority that saves it, each spent once by its
   * own owner (`approve`, then `saveAuthority`).
   */
  async confirmUseAndAuthority(
    use: { request: string; digest: string; expires: number },
    authority: { digest: string; expires: number },
    reason: string,
  ): Promise<{ use: LocalProof; authority: LocalProof } | undefined> {
    const proofs = await this.ready?.local.confirmEach(
      [
        { subject: `use:${use.request}`, digest: use.digest, expires: use.expires },
        { subject: "authority", digest: authority.digest, expires: authority.expires },
      ],
      reason,
    );
    const [usable, saving] = proofs ?? [];
    return usable && saving ? { use: usable, authority: saving } : undefined;
  }

  /** The nonce an enrolled device signs with its decision on this use. */
  challenge(
    request: string,
    digest: string,
    expires: number,
  ): { nonce: string; home: string } | undefined {
    const ready = this.ready;
    if (!ready || (!this.described.has(request) && !this.brokered.has(request))) return undefined;
    const challenge = ready.remote.challenge(request, digest, expires);
    return challenge ? { ...challenge, home: ready.authority.authority.home } : undefined;
  }

  authority(): Authority | undefined {
    return this.ready?.authority.authority;
  }

  /** The next revision and the digest the captain approves before it is saved. */
  proposeAuthority(
    next: Pick<Authority, "rules" | "devices">,
  ): { authority: Authority; digest: string } | undefined {
    return this.ready?.authority.proposal(next);
  }

  async confirmAuthority(
    digest: string,
    expires: number,
    reason: string,
  ): Promise<LocalProof | undefined> {
    return this.ready?.local.confirm("authority", digest, expires, reason);
  }

  /** Save rules and approval devices: only with a fresh local proof for this exact revision. */
  async saveAuthority(
    authority: Authority,
    proof: unknown,
  ): Promise<"stored" | "refused" | "invalid" | "locked" | "unavailable"> {
    return this.change(async () => {
      const ready = this.ready;
      if (!ready || !(await this.custodyCurrent())) return "unavailable";
      if (!ready.local.consume(proof, "authority", sha256(canonical(authority)))) return "refused";
      try {
        const saved = await ready.authority.save(authority);
        if (saved === "stored") this.endReadAccess();
        return saved;
      } catch (error) {
        // The native head may have moved. No old rule or prepared use remains
        // authority until reopening reconciles the pending record.
        this.retired = true;
        this.endReadAccess();
        throw error;
      }
    });
  }

  /**
   * The crew's pre-check (docs/secrets.md, "The crew's pre-check"): the same
   * checks `prepare` makes before any card - every named secret, the working
   * folder, the program, its interpreter and file arguments - and the saved
   * decision the exact run meets, without journaling, approving or running
   * anything. A failure names which check, never a path or a value; an
   * unknown and a hidden secret answer alike.
   */
  async check(input: UseCheckInput): Promise<UseCheck> {
    if (this.recovering || this.retired) return { problem: "unavailable" };
    const ready = this.ready;
    if (!ready || !(await this.custodyCurrent())) return { problem: "unavailable" };
    if (!input.cwd) return { problem: "folder" };
    if (!validInjection({ ...input, id: "check", reason: "Check before asking" }))
      return { problem: "variable" };
    const refs = [...new Set(Object.values(input.env))].sort();
    for (const ref of refs)
      if (!(await ready.vault.entry(ref))?.discoverable) return { problem: "secret" };
    const runDir = join(this.options.dir, "runs", `check-${randomUUID()}`);
    try {
      const recipient = await prepareRecipient(
        { argv: input.argv, cwd: input.cwd, env: input.env },
        runDir,
        this.options.environment().PATH ?? "",
      ).catch(() => undefined);
      if (!recipient) return { problem: "unavailable" };
      if ("refused" in recipient) return { problem: recipient.refused };
      const { facts } = recipient;
      return {
        decision: ready.authority.evaluate(refs, recipient.operation).effect,
        program: facts.executable.path,
        ...(facts.interpreter ? { interpreter: facts.interpreter.path } : {}),
        files: facts.inputs.map((file) => file.path),
        folder: facts.cwd,
      };
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  }

  /**
   * The crew's pre-check for a run on a computer that runs work: that
   * computer checked the folder, program and files and bound their facts;
   * this owner checks each named secret and the saved decision the exact run
   * there meets, without journaling, approving or running anything.
   */
  async checkElsewhere(computer: string, facts: RecipientFacts): Promise<ElsewhereCheck> {
    if (this.recovering || this.retired) return { problem: "unavailable" };
    const ready = this.ready;
    if (!ready || !(await this.custodyCurrent())) return { problem: "unavailable" };
    const input = elsewhereInjection({
      id: "check",
      reason: "Check before asking",
      facts,
      computer: { id: computer, label: computer },
      hand: async () => "undeliverable",
    });
    if (!input) return { problem: "unavailable" };
    const refs = [...new Set(Object.values(input.env))].sort();
    for (const ref of refs)
      if (!(await ready.vault.entry(ref))?.discoverable) return { problem: "secret" };
    return { decision: ready.authority.evaluate(refs, elsewhereOperation(computer, facts)).effect };
  }

  /**
   * Metadata-only rehearsal for the `inf:secrets:rehearse` request: which rules
   * a use would meet and its checked facts, without journaling, approving or
   * running anything. No surface calls it since the crew's pre-check (`check`)
   * took its place; the request goes with the contract's next major.
   */
  async rehearse(
    input: UseCheckInput,
  ): Promise<{ evaluation: Evaluation; operation: string; facts: RecipientFacts } | undefined> {
    const ready = this.ready;
    if (
      !ready ||
      !input.cwd ||
      !validInjection({ ...input, id: "rehearsal", reason: "Check rules without running" })
    )
      return undefined;
    const runDir = join(this.options.dir, "runs", `rehearsal-${randomUUID()}`);
    try {
      const recipient = await prepareRecipient(
        { argv: input.argv, cwd: input.cwd, env: input.env },
        runDir,
        this.options.environment().PATH ?? "",
      ).catch(() => undefined);
      if (!recipient || "refused" in recipient) return undefined;
      const refs = [...new Set(Object.values(input.env))].sort();
      return {
        evaluation: ready.authority.evaluate(refs, recipient.operation),
        operation: recipient.operation,
        facts: recipient.facts,
      };
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  }

  /** Trusted secure entry's write. Never an agent operation, and there is no reveal. */
  async putSecret(
    ref: string,
    label: string,
    value: Buffer,
    options: SecretMetadataInput & {
      expectedVersion?: number;
      expectedRevision?: string | null;
    } = {},
  ): Promise<VaultEntry | undefined> {
    return this.change(async () => {
      if (!(await this.custodyCurrent())) return undefined;
      const previous = await this.ready?.vault.entry(ref);
      if (
        (options.expectedVersion !== undefined &&
          options.expectedVersion !== (previous?.version ?? 0)) ||
        (options.expectedRevision !== undefined &&
          options.expectedRevision !== (previous?.revision ?? null))
      )
        return undefined;
      // Invalidate already-prepared uses even if a remove/add would reuse a version number.
      this.materialEpoch += 1;
      this.endReadAccess();
      return this.ready?.vault.put(ref, label, value, options);
    });
  }

  async forgetSecret(
    ref: string,
    expectedVersion?: number,
    expectedRevision?: string,
  ): Promise<boolean> {
    return this.change(async () => {
      if (!(await this.custodyCurrent())) return false;
      const current = await this.ready?.vault.entry(ref);
      if (
        (expectedVersion !== undefined && current?.version !== expectedVersion) ||
        (expectedRevision !== undefined && current?.revision !== expectedRevision)
      )
        return false;
      this.materialEpoch += 1;
      this.endReadAccess();
      await this.ready?.vault.remove(ref);
      return true;
    });
  }

  /**
   * Trusted native recovery writer only. Its destinations are chosen before this
   * call; no archive, key or decoded value is returned through a general API.
   * Fresh confirmation covers one export, not later uses or a reusable grant.
   */
  async backupRecovery(
    write: (files: RecoveryFiles) => Promise<RecoverySave>,
  ): Promise<RecoveryBackup> {
    return this.change(async () => {
      const ready = this.ready;
      if (!ready || !(await this.custodyCurrent())) return "unavailable";
      let confirmed = false;
      try {
        confirmed =
          (await this.options.authentication?.confirm(
            "Save an encrypted Secrets recovery archive and its separate recovery key.",
          )) === true;
      } catch {
        // Failed or cancelled native confirmation authorizes no export.
      }
      if (!confirmed) return "refused";
      if (!(await this.custodyCurrent())) return "unavailable";
      const contents = await this.recoveryContents(ready);
      if (!contents) return "unavailable";
      let files: RecoveryFiles | undefined;
      try {
        if (!(await this.custodyCurrent())) return "unavailable";
        files = sealRecovery(contents);
        try {
          return await write(files);
        } catch {
          // A writer may have saved either file before its response failed.
          return "unknown";
        }
      } catch {
        return "unavailable";
      } finally {
        clearRecovery(contents);
        files?.archive.fill(0);
        files?.key.fill(0);
      }
    });
  }

  /** Whether this computer can confirm the person now; a headless start cannot. */
  async canConfirm(): Promise<boolean> {
    try {
      return (await this.options.authentication?.available()) === true;
    } catch {
      return false;
    }
  }

  /**
   * Copy value (docs/secrets.md, "Copying a value"): the captain's own read of
   * one value, handed to the host's clipboard writer in this process. Every
   * copy asks the system to confirm the person again, with `reason` naming the
   * secret, and nothing an earlier confirmation covered is reused. The copy is
   * journaled before the value moves, so a journal that cannot be written
   * refuses it. Only a secret the person gave copies, never a sign-in the app
   * keeps for one of its own services. No answer holds the value.
   */
  async copyValue(
    ref: string,
    shown: { version: number; revision: string },
    reason: (label: string) => string,
    write: (value: Buffer) => Promise<boolean>,
  ): Promise<SecretCopy> {
    return this.change(async () => {
      const ready = this.ready;
      if (!ready || !(await this.custodyCurrent())) return "unavailable";
      const same = (entry: VaultEntry | undefined): entry is VaultEntry =>
        entry?.version === shown.version && entry.revision === shown.revision;
      const entry = await ready.vault.entry(ref);
      if (!same(entry)) return "changed";
      if (!entry.discoverable && !entry.forProgram) return "unavailable";
      let confirmed = false;
      try {
        confirmed = (await this.options.authentication?.confirm(reason(entry.label))) === true;
      } catch {
        // Failed or cancelled native confirmation authorizes no copy.
      }
      if (!confirmed) return "refused";
      if (!(await this.custodyCurrent())) return "unavailable";
      if (!same(await ready.vault.entry(ref))) return "changed";
      const request = randomUUID();
      try {
        await ready.journal.append({
          kind: "requested",
          request,
          intent: `copy:${request}`,
          inputDigest: sha256(canonical({ copy: ref, revision: shown.revision })),
          digest: sha256(canonical({ request, copy: ref, revision: shown.revision })),
          secrets: [ref],
          program: "",
          reason: "",
          rule: "ask",
          copied: true,
        });
        await ready.journal.append({ kind: "approved", request, method: "local" });
        await ready.journal.append({ kind: "consumed", request });
      } catch {
        return "unavailable";
      }
      const end = (state: "unavailable" | "unknown") =>
        ready.journal.append({ kind: "ended", request, state }).catch(() => undefined);
      const opened = await ready.vault.open(ref).catch(() => undefined);
      try {
        if (opened?.entry.revision !== shown.revision) {
          await end("unavailable");
          return "changed";
        }
        let written: boolean;
        try {
          written = await write(opened.value);
        } catch {
          // The writer may have replaced the clipboard before it failed.
          await end("unknown");
          return "unknown";
        }
        if (!written) {
          await end("unavailable");
          return "unavailable";
        }
        await ready.journal.append({ kind: "completed", request }).catch(() => undefined);
        return "copied";
      } finally {
        opened?.value.fill(0);
      }
    });
  }

  /**
   * Every value with its metadata and this home's history, as a recovery
   * archive holds them; undefined when a value cannot be read whole now. The
   * caller clears it (`clearRecovery`).
   */
  private async recoveryContents(ready: Ready): Promise<RecoveryContents | undefined> {
    const contents: RecoveryContents = {
      format: 1,
      createdAt: this.now(),
      sourceHome: ready.authority.authority.home,
      values: [],
      // A build that predates runs elsewhere, brings or copies reads an
      // archive strictly, so the computer a use ran on, the tool a bring read
      // and the mark of a copy stay with this home's own history.
      history: structuredClone(ready.journal.history()).map(
        ({ computer: _, brought: __, copied: ___, ...item }) => item,
      ),
    };
    try {
      const entries = await ready.vault.recoveryEntries();
      if (!entries) throw new Error("Secrets could not be listed.");
      for (const entry of entries) {
        const opened = await ready.vault.open(entry.ref);
        try {
          if (!opened || opened.entry.revision !== entry.revision)
            throw new Error("A secret changed while it was read.");
          contents.values.push({
            ref: entry.ref,
            label: entry.label,
            discoverable: entry.discoverable,
            ...(entry.environment !== undefined ? { environment: entry.environment } : {}),
            ...(entry.forProgram ? { forProgram: true as const } : {}),
            ...(entry.consumer ? { consumer: entry.consumer } : {}),
            value: opened.value.toString("base64"),
          });
        } finally {
          opened?.value.fill(0);
        }
      }
      return contents;
    } catch {
      clearRecovery(contents);
      return undefined;
    }
  }

  /**
   * What the values are now, without opening one (docs/devices.md, "Secrets
   * on a computer that keeps a copy"): this home and each record's opaque
   * revision, so the sealed copy is made again only when one changed.
   */
  async sealedState(): Promise<{ home: string; revisions: string[] } | undefined> {
    const ready = this.ready;
    if (!ready || this.retired || this.recovering) return undefined;
    const entries = await ready.vault.recoveryEntries().catch(() => undefined);
    if (!entries) return undefined;
    return {
      home: ready.authority.authority.home,
      revisions: entries.map((entry) => `${entry.ref}:${entry.revision}`).sort(),
    };
  }

  /**
   * The values sealed for the computers that keep a copy (docs/devices.md,
   * "Secrets on a computer that keeps a copy"): a recovery archive under a
   * fresh key, handed with this home's id to `seal`, which seals that key to
   * each computer's own lock and keeps only what it returns. The captain
   * confirmed each lock on its own computer; no confirmation is asked here,
   * and the archive and key are cleared once `seal` returns.
   */
  sealForStandbys<T>(seal: (files: RecoveryFiles, home: string) => T): Promise<T | "unavailable"> {
    return this.change(async () => {
      const ready = this.ready;
      if (!ready || !(await this.custodyCurrent())) return "unavailable";
      const contents = await this.recoveryContents(ready);
      if (!contents) return "unavailable";
      let files: RecoveryFiles | undefined;
      try {
        if (!(await this.custodyCurrent())) return "unavailable";
        files = sealRecovery(contents);
        return seal(files, ready.authority.authority.home);
      } catch {
        return "unavailable";
      } finally {
        clearRecovery(contents);
        files?.archive.fill(0);
        files?.key.fill(0);
      }
    });
  }

  /**
   * A home started from a copy takes the values sealed to this computer's own
   * lock (docs/devices.md, "Secrets on a computer that keeps a copy"): the
   * archive opens only with the key that lock opened, and becomes a new home
   * of Secrets exactly as a restore does - a fresh root, no saved decisions
   * and no approving devices. Where Secrets here hold none of their own it
   * asks no confirmation, since the captain confirmed this computer's lock on
   * it when it was named; replacing values this computer keeps (`replaceOwn`)
   * asks a fresh confirmation, as a restore does.
   */
  adoptStandby(
    files: RecoveryFiles,
    pause: () => Promise<(() => void) | undefined>,
    replaceOwn = false,
  ): Promise<RecoveryRestore> {
    const archive = Buffer.from(files.archive);
    const key = Buffer.from(files.key);
    return this.change(async () => {
      let contents: RecoveryContents | undefined;
      try {
        if (this.retired) return "unavailable";
        if (this.brokerResults.size > 0) return "busy";
        contents = openRecovery(archive, key);
        if (!contents) return "invalid";
        return await this.replaceHome(replaceOwn ? STANDBY_REPLACE_REASON : null, contents, pause);
      } catch {
        return "unavailable";
      } finally {
        if (contents) clearRecovery(contents);
        archive.fill(0);
        key.fill(0);
      }
    });
  }

  /** A private native source and a pause capability from this owner's request coordinator. */
  restoreRecovery(
    files: RecoveryFiles,
    pause: () => Promise<(() => void) | undefined>,
  ): Promise<RecoveryRestore> {
    const archive = Buffer.from(files.archive);
    const key = Buffer.from(files.key);
    return this.change(async () => {
      let contents: RecoveryContents | undefined;
      try {
        if (this.retired) return "unavailable";
        if (this.brokerResults.size > 0) return "busy";
        contents = openRecovery(archive, key);
        if (!contents) return "invalid";
        return await this.replaceHome(RESTORE_REASON, contents, pause);
      } catch {
        return "unavailable";
      } finally {
        if (contents) clearRecovery(contents);
        archive.fill(0);
        key.fill(0);
      }
    });
  }

  /**
   * Start over where storage needs recovery (docs/secrets.md, "Starting over"):
   * a fresh root and empty authority, activated by the one native write a
   * restore makes, with no archive. A removed data folder beside its custody
   * items reads as tampered, as a rolled-back record does; the owner cannot tell
   * them apart, so only the captain's confirmed choice replaces that custody.
   * Values sealed under the old root are left unreadable and history is kept.
   */
  startOver(pause: () => Promise<(() => void) | undefined>): Promise<SecretsStartOver> {
    return this.change(async () => {
      try {
        if (this.retired) return "unavailable";
        const reading = await this.status();
        if (reading === "available" || reading === "uninitialized") return "unneeded";
        if (reading === "locked" || reading === "unavailable") return reading;
        const result = await this.replaceHome(START_OVER_REASON, undefined, pause);
        return result === "restored" ? "started" : result === "invalid" ? "unavailable" : result;
      } catch {
        return "unavailable";
      }
    });
  }

  /**
   * Restore's and start-over's shared activation: fresh native confirmation of
   * `reason` (none, null, for a copy's sealed values where none are kept here), a paused
   * coordinator, a synced stage, then one native write over the custody
   * observed before confirmation. The caller serializes it.
   */
  private async replaceHome(
    reason: string | null,
    contents: RecoveryContents | undefined,
    pause: () => Promise<(() => void) | undefined>,
  ): Promise<RecoveryRestore> {
    let stage: StagedRecovery | undefined;
    let resume: (() => void) | undefined;
    try {
      if (this.brokerResults.size > 0) return "busy";
      const expected = await observeSecretHome(this.options.custody);
      if (typeof expected === "string") return expected === "lost" ? "unavailable" : expected;
      // Only a copy's sealed values where none are kept here come with no confirmation (`adoptStandby`).
      let confirmed = reason === null;
      try {
        if (reason !== null)
          confirmed = (await this.options.authentication?.confirm(reason)) === true;
      } catch {
        /* No fresh confirmation means no replacement. */
      }
      if (!confirmed) return "refused";
      resume = await pause();
      if (!resume || this.brokerResults.size > 0) return "busy";
      this.recovering = true;
      this.materialEpoch += 1;
      this.endReadAccess();
      const history = await this.recoveryHistory();
      if (typeof history === "string") return history;
      stage = await stageRecovery(this.options.dir, contents, history, this.now());
      const result = await stage.commit(this.options.custody, expected);
      if (result === "committed" || result === "unknown") {
        this.retired = true;
        this.ready?.keys.destroy();
        this.described.clear();
        this.brokered.clear();
      }
      return result === "committed" ? "restored" : result;
    } finally {
      try {
        await stage?.dispose();
      } catch {
        /* An unused encrypted stage may remain; never claim erasure. */
      }
      this.recovering = false;
      resume?.();
    }
  }

  /** Authority may be damaged while the root still authenticates the local journal. */
  private async recoveryHistory(): Promise<JournalSnapshot | "locked" | "unavailable"> {
    if (this.ready) return this.ready.journal.snapshot();
    const home = await openSecretHome(this.options.dir, this.options.custody);
    if (typeof home === "string") return home === "lost" ? { entries: [], recovered: [] } : home;
    const keys = await RootKeys.open(home.custody, {
      initialize: false,
      hasRecords: await hasSecretHomeRecords(this.options.dir),
    });
    if (typeof keys === "string")
      return keys === "lost" || keys === "uninitialized" ? { entries: [], recovered: [] } : keys;
    try {
      return await (await UseJournal.open(home.dir, keys, this.now)).snapshot();
    } finally {
      keys.destroy();
    }
  }

  private change<T>(write: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(write);
    this.mutation = next.catch(() => {});
    return next;
  }

  history(): HistoryItem[] {
    return this.ready?.journal.history() ?? [];
  }

  /** A bring's lines in the use journal (`bring.ts`): metadata only, never a value. */
  async journalBring(entry: JournalEntry): Promise<void> {
    if (!this.ready || this.retired || this.recovering)
      throw new Error("Secrets history is unavailable.");
    await this.ready.journal.append(entry);
  }

  async storageUse(): Promise<number> {
    let bytes = 0;
    for (const path of await secretHistoryFiles(this.options.dir)) bytes += (await stat(path)).size;
    return bytes;
  }

  exportHistory(): string | undefined {
    return this.ready?.journal.export();
  }

  async clearHistory(): Promise<"cleared" | "busy" | "unavailable"> {
    return this.change(async () => {
      if (this.retired || this.recovering) return "unavailable";
      if (!this.ready) return "unavailable";
      // All generations are removed inside the journal's writer turn, never
      // after a new request has been allowed to create the current file again.
      return this.ready.journal.clear(await secretHistoryFiles(this.options.dir));
    });
  }

  /** Custody is read again at every consumption: a locked or replaced root stops the use. */
  private async custodyCurrent(): Promise<boolean> {
    const ready = this.ready;
    if (!ready || this.recovering || this.retired) return false;
    try {
      const read = await ready.home.custody.read("root");
      if (read.kind !== "value") return false;
      const same = sha256(read.bytes).slice(0, 16) === ready.keys.fingerprint;
      read.bytes.fill(0);
      return same && !this.retired && !this.recovering;
    } catch {
      return false;
    }
  }
}

function preparedSecret({ ref, label, version, environment }: VaultEntry): PreparedSecret {
  return { ref, label, version, ...(environment !== undefined ? { environment } : {}) };
}

/**
 * The operation key a saved decision names for a run on a computer that runs
 * work: its bound facts and that computer, so a decision saved for a run
 * there never covers the same run here or on another computer.
 */
export function elsewhereOperation(computer: string, facts: RecipientFacts): string {
  return sha256(canonical({ computer, facts }));
}

/**
 * The request a run elsewhere stands for, checked as a request here is: no
 * variable a recipient keeps from its computer or a launcher controls, and
 * facts that name each variable and argument as the injection would.
 */
function elsewhereInjection(use: ElsewhereUse): Injection | undefined {
  const input: Injection = {
    id: use.id,
    reason: use.reason,
    env: { ...use.facts.env },
    argv: [...use.facts.argv],
    cwd: use.facts.cwd,
  };
  if (!validInjection(input)) return undefined;
  if (Object.keys(input.env).some((name) => keepsHostVariable(name))) return undefined;
  if (use.facts.delivery !== "environment") return undefined;
  return input;
}
