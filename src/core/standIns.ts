import { settingFrom } from "@shared/envSettings";

/**
 * Every development and end-to-end stand-in the app wiring reads
 * (`createServices` and its wiring modules), read in one place: a setting a
 * test or a development run names in the environment (`settingFrom`), so a
 * journey need not wait out a design's period, or reach a real service, a
 * real network or this Mac's own logs. A packaged app reads none of them,
 * whatever the environment says, so a build anyone runs cannot be pointed
 * anywhere else.
 *
 * A stand-in an owner reads itself stays with that owner: the ticker's
 * period (`tickPeriodFor`), a task browser's hosts (`browserLookup`), the
 * forge endpoints, Google's client, the local seat, Observe and the freeze
 * recorder's gates, and the computer names a test gives.
 */
export type StandIns = {
  /** The window a launch has to survive before safe mode counts it (`LaunchWatch`). */
  earlyLaunchMs?: number;
  /** The grace between the durable inbox's delivery attempts. */
  inboxGraceMs?: number;
  /** How long a moved first mate's destination stays out of reach before Start here is offered (docs/devices.md). */
  homeMoveOfferMs?: number;
  /** The rows that move the task board to its delta carrier. */
  taskDeltaRows?: number;
  /** Fixture files the quota sensor reads instead of the live APIs. */
  quotaFixtureDir?: string;
  /**
   * The usage endpoints the quota sensor reads instead of the real ones;
   * present, maybe empty, on every unpackaged run.
   */
  quotaEndpoints?: {
    claudeUsageUrl?: string;
    grokUsageUrl?: string;
    grokKeyUrl?: string;
    kimiUsageUrl?: string;
    copilotUsageUrl?: string;
  };
  /**
   * A CLI proxy app's settings file the quota sensor reads instead of
   * finding a running proxy app (docs/quota.md, "A proxy's pooled logins").
   * An unpackaged run with none reads no proxy.
   */
  cliProxySettings?: string;
  /** Local Bedrock endpoint owned by the hermetic launcher. */
  bedrockUrl?: string;
  /** Absolute path of the disposable AWS CLI used by recovery journeys. */
  awsCli?: string;
  /** Disposable server-managed settings used to exercise placed Claude admission. */
  placedClaudePolicy?: string;
  /** The served starter list's address (docs/model-lists.md). */
  startersUrl?: string;
  /** The connection kept to loopback at a port of its own (`tests/e2e/launch.ts`). */
  loopbackPort?: number;
  /** The addresses a development picture shows as this Mac's own. */
  addresses?: string[];
  /** Every device that joins stands in for another Mac, so two apps on one Mac read as two Macs. */
  joinsFromAnotherMac: boolean;
  /** This Mac's network name, instead of asking the network. */
  networkName?: string;
  /** The account set up from your first mate's computer names here, instead of this run's own. */
  user?: string;
  /** The loopback port of the throwaway SSH server every one of this computer's addresses answers with. */
  ownSshPort?: number;
  /** The tap a computer of another system gets its Infinitary from. */
  publishedTap?: string;
  /** The program that stands in for the captain's own SSH. */
  ssh?: string;
  /** The program that stands in for macOS's dns-sd. */
  dnsSd?: string;
  /** The program that stands in for macOS's privacy log reader. */
  privacyLog?: string;
  /** The folder the stand-in integration tells an event for each line added to. */
  integrationDir?: string;
  /** Where the inbox command's link goes, instead of /usr/local/bin. */
  inboxLinkDir?: string;
  /** The native decision model's endpoint. */
  jevUrl?: string;
  openRouterDecisionsBaseUrl?: string;
  releaseNotesDir?: string;
  /** Where card pushes to a phone are posted instead of Infinitary's relay (docs/phone-push.md). */
  pushRelayUrl?: string;
};

const PACKAGED: StandIns = { joinsFromAnotherMac: false };

function text(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  return settingFrom(env, name)?.trim() || undefined;
}

function count(env: Readonly<Record<string, string | undefined>>, name: string): number {
  return Number.parseInt(settingFrom(env, name) ?? "", 10);
}

export function readStandIns(
  packaged: boolean,
  env: Readonly<Record<string, string | undefined>>,
): StandIns {
  if (packaged) return PACKAGED;
  const earlyLaunchMs = count(env, "EARLY_LAUNCH_MS");
  const inboxGraceMs = count(env, "INBOX_GRACE_MS");
  const taskDeltaRows = count(env, "TASK_DELTA_ROWS");
  const homeMoveOfferMs = count(env, "HOME_MOVE_OFFER_MS");
  const loopbackPort = count(env, "CONNECTION_LOOPBACK_PORT");
  const ownSshPort = count(env, "STAND_IN_OWN_SSH_PORT");
  const addresses = (settingFrom(env, "STAND_IN_ADDRESSES")?.trim() ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return {
    ...(Number.isFinite(earlyLaunchMs) && earlyLaunchMs > 0 ? { earlyLaunchMs } : {}),
    ...(Number.isFinite(inboxGraceMs) && inboxGraceMs > 0 ? { inboxGraceMs } : {}),
    ...(Number.isFinite(taskDeltaRows) && taskDeltaRows >= 0 ? { taskDeltaRows } : {}),
    ...(Number.isFinite(homeMoveOfferMs) && homeMoveOfferMs > 0 ? { homeMoveOfferMs } : {}),
    quotaFixtureDir: text(env, "QUOTA_FIXTURE_DIR"),
    quotaEndpoints: {
      claudeUsageUrl: text(env, "CLAUDE_USAGE_URL"),
      grokUsageUrl: text(env, "GROK_USAGE_URL"),
      grokKeyUrl: text(env, "GROK_KEY_URL"),
      kimiUsageUrl: text(env, "KIMI_USAGE_URL"),
      copilotUsageUrl: text(env, "COPILOT_USAGE_URL"),
    },
    cliProxySettings: text(env, "CLI_PROXY_SETTINGS"),
    bedrockUrl: text(env, "BEDROCK_TEST_URL"),
    awsCli: text(env, "AWS_CLI"),
    placedClaudePolicy: text(env, "PLACED_CLAUDE_POLICY_FIXTURE"),
    startersUrl: text(env, "STARTERS_URL"),
    ...(loopbackPort > 0 && loopbackPort < 65_536 ? { loopbackPort } : {}),
    ...(addresses.length > 0 ? { addresses } : {}),
    joinsFromAnotherMac: settingFrom(env, "JOINS_FROM_ANOTHER_MAC") === "1",
    networkName: text(env, "STAND_IN_NETWORK_NAME"),
    user: text(env, "STAND_IN_USER"),
    ...(ownSshPort > 0 && ownSshPort < 65_536 ? { ownSshPort } : {}),
    publishedTap: text(env, "PUBLISHED_TAP"),
    ssh: text(env, "SSH"),
    dnsSd: text(env, "DNS_SD"),
    privacyLog: text(env, "PRIVACY_LOG"),
    integrationDir: text(env, "STAND_IN_INTEGRATION"),
    inboxLinkDir: text(env, "INBOX_LINK_DIR"),
    jevUrl: text(env, "JEV_URL"),
    openRouterDecisionsBaseUrl: text(env, "OPENROUTER_DECISIONS_BASE_URL"),
    releaseNotesDir: text(env, "RELEASE_NOTES_DIR"),
    pushRelayUrl: text(env, "PUSH_RELAY_URL"),
  };
}
