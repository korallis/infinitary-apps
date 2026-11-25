import type { SecretConsumer } from "@shared/secrets";
import type { BrokeredUse, SecretBroker } from "../secrets/brokers";
import type { UseState } from "../secrets/requests";

/**
 * Where an integration keeps a key (docs/integrations.md, "Keys"): in
 * Secrets (docs/secrets.md, "App services"), as a hidden entry the crew's
 * catalog never lists, used only through a broker the binding registers -
 * so a value is applied to one checked request, or given to one checked
 * program as it starts, inside the protected owner and never returns to the
 * binding. A sign-in made in the app is its own consent ("App sign-ins"),
 * and so is a key the person gave with a program the binding starts
 * ("Programs that keep running"), so neither use asks. `SecretsSettings`
 * implements it; a run without Secrets keeps no key.
 */
export interface IntegrationKeys {
  /** Whether this run keeps Secrets at all; it never opens the storage to answer. */
  shown(): boolean;
  /** A fresh reference for a key about to be kept, so a move can record it first. */
  reference(label: string): Promise<string | undefined>;
  /**
   * Keep a key under its reference (a fresh one without), answering it;
   * undefined when Secrets cannot now. `forProgram` marks a key a program
   * the binding starts receives.
   */
  keepHidden(input: {
    ref?: string;
    label: string;
    value: Buffer;
    forProgram?: true;
    /** The app service it belongs to, when not an Integrations sign-in. */
    consumer?: SecretConsumer;
  }): Promise<string | undefined>;
  /** Every key kept for a program, so the binding can forget one nothing names; undefined when Secrets cannot answer now. */
  programKeys(): Promise<string[] | undefined>;
  /** Forget a key the integration kept; answers whether it is gone. */
  forgetHidden(ref: string): Promise<boolean>;
  /** Code registered once at composition; never data from an agent or a renderer. */
  registerBroker(broker: SecretBroker): void;
  /** One use through a registered broker, awaited to its end, with the broker's private result. */
  use(input: BrokeredUse): Promise<{ state: UseState; result?: unknown }>;
}

/** The words a key is replaced with wherever it might leave. */
export const REDACTED = "[a kept key]";
