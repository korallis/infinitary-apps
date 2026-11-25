import type { SecretConsumer } from "@shared/secrets";
import { canonical, sha256 } from "./custody";

/** JSON inputs only. The trusted adapter owns validation, transport and result handling. */
export type BrokerInput =
  | null
  | boolean
  | number
  | string
  | BrokerInput[]
  | { [key: string]: BrokerInput };

/** References and checked facts, never values or a full request body. */
export type BrokerFacts = {
  broker: string;
  label: string;
  destination: string;
  operation: string;
  inputDigest: string;
  /** A trusted adapter's declaration, never a requester's flag or an HTTP-method guess. */
  read: boolean;
  result: string;
  secrets: Record<string, string>;
  /**
   * A program that keeps running, from `programSecretBroker`: what starts, as
   * checked. Each secret goes in the variable that names it in `secrets`.
   */
  program?: ProgramFacts;
};

/** A program's checked start (docs/secrets.md, "Programs that keep running"). */
export type ProgramFacts = {
  /** The program as found, by its real path and digest. */
  executable: { path: string; sha256: string };
  /** The interpreter its `#!` line names, when that resolves. */
  interpreter?: { path: string; sha256: string; arg?: string };
  /** The program as named, then its arguments. */
  argv: string[];
  /**
   * Each argument naming a regular file, by its index and real path. What it
   * holds is not bound: a server's data file, such as its database, changes
   * as it runs.
   */
  inputs: { index: number; path: string }[];
  cwd: string;
};

export type BrokeredUse = {
  id: string;
  reason: string;
  broker: string;
  input: BrokerInput;
};

/**
 * Registered code only, injected at composition by the consumer's owner.
 * Neither a command, an IPC request nor a saved file registers an adapter.
 * The prepared closure binds the same checked inputs its facts describe.
 * Its result is for its trusted consumer, not the agent/receipt/UI surface.
 */
export type SecretBroker = {
  id: string;
  /**
   * The adapter spends a sign-in the person made in the app itself, at an
   * address its own code names or, for an MCP server's, one that sign-in's
   * documents named and the binding saved with it (docs/secrets.md, "App
   * sign-ins"). That sign-in is the consent: a use naming only hidden
   * entries runs with no question.
   */
  signIn?: true;
  /**
   * The adapter starts a program with the keys the person gave with it, such
   * as the values on an MCP server's Runs line (docs/secrets.md, "Programs
   * that keep running"). Giving them is the consent: a use naming only hidden
   * entries kept for a program runs with no question.
   */
  givenWithProgram?: true;
  /**
   * The hidden entries the adapter's service keeps outside Integrations, such
   * as the reporting connection's headers. `named` answers the references its
   * saved settings name, or undefined when they cannot be read whole, so a
   * damaged file forgets nothing; Secrets forgets the rest when it opens and
   * offers Forget on one left over.
   */
  keeps?: { consumer: SecretConsumer; named(): readonly string[] | undefined };
  prepare(input: BrokerInput): Promise<PreparedBroker | undefined>;
};

export type PreparedBroker = {
  facts: BrokerFacts;
  run(values: Readonly<Record<string, Buffer>>): Promise<unknown>;
  dispose?(): Promise<void>;
};

/** A changed submitted body under the same intent never executes a second operation. */
export function brokerInputDigest(input: BrokeredUse): string {
  return sha256(
    canonical({ kind: "broker", broker: input.broker, reason: input.reason, input: input.input }),
  );
}

export function validBrokeredUse(input: BrokeredUse): boolean {
  return (
    !!input &&
    Object.keys(input).every((key) => ["id", "reason", "broker", "input"].includes(key)) &&
    typeof input.id === "string" &&
    input.id.length > 0 &&
    typeof input.reason === "string" &&
    input.reason.trim().length > 0 &&
    typeof input.broker === "string" &&
    input.broker.length > 0 &&
    jsonInput(input.input)
  );
}

function jsonInput(value: unknown): value is BrokerInput {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonInput);
  return (
    !!value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value).every(jsonInput)
  );
}
