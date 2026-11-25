import type { AccountView } from "@shared/accounts";
import { automationRuleSchema, automationRunSchema, eventsWords } from "@shared/automation";
import * as m from "@shared/i18n/messages.generated";
import { quotaSnapshotViewSchema } from "@shared/quota";
import { deviceSignInsSchema } from "@shared/signIns";
import { describe, expect, it } from "vitest";
import { automationRulePage, intelligencePage } from "./phonePages";

/**
 * INF-3563's Intelligence page groups accounts by the computer they are on
 * (its done criteria: "grouped by computer", a waiting row "says to sign in
 * on the computer", a computer out of reach "keeps the last reading"). The
 * phone check's stand-in home runs no second computer, so this file owns
 * those three facts; tests/phone-settings-pages.test.ts owns the pages built
 * from a real home's answers.
 * Fixture: the account and reading shapes the home sends for a computer that
 * runs work, parsed by the published schema so a shape it would refuse fails
 * here.
 */
const NOW = Date.UTC(2026, 10, 12, 18, 0);

const account = (id: string, label: string, extra: Partial<AccountView> = {}): AccountView => ({
  id,
  providerId: "openai-codex",
  kind: "subscription_oauth",
  label,
  enabled: true,
  connected: true,
  pinned: false,
  createdAt: 1,
  ...extra,
});

const providers = [
  {
    id: "openai-codex",
    name: "Codex",
    tier: "subscription" as const,
    authTypes: ["oauth" as const],
    connected: true,
    billedPerToken: false,
  },
];

const mini = (reach: "in-reach" | "out-of-reach") =>
  deviceSignInsSchema.parse({
    deviceId: "mini",
    name: "Mac mini",
    onThisMac: false,
    reach,
    asOf: NOW - 5 * 60_000,
    signIns: {
      providers,
      accounts: [account("acct_m1", "Builder"), account("acct_m2", "Spare", { connected: false })],
      quota: {
        generatedAt: new Date(NOW - 5 * 60_000).toISOString(),
        fetchedAt: NOW - 5 * 60_000,
        providers: [
          {
            provider: "codex",
            label: "Codex",
            accountId: "acct_m1",
            status: "ok",
            stale: false,
            windows: [{ id: "weekly", label: "weekly", percentRemaining: 38 }],
          },
        ],
      },
    },
  });

const page = (reach: "in-reach" | "out-of-reach") =>
  intelligencePage({
    accounts: [account("acct_h1", "Personal")],
    snapshot: null,
    providers,
    devices: [mini(reach)],
    firstmateAccount: "acct_h1",
    home: "Studio",
    now: NOW,
  });

describe("the phone's Intelligence page with a computer that runs work", () => {
  it("groups each account under the computer it is on, and says where a waiting one signs in", () => {
    const { groups, summary } = page("in-reach");
    expect(groups.map((group) => [group.label, group.rows.map((row) => row.name)])).toEqual([
      ["Studio", ["Personal"]],
      ["Mac mini", ["Builder", "Spare"]],
    ]);
    expect(groups[1]?.note).toBeUndefined();
    expect(groups[1]?.rows[1]?.signIn).toBe("Sign in on Mac mini.");
    expect(summary).toBe("3 accounts · 1 needs a sign-in");
  });

  it("keeps the last reading of a computer that went out of reach, and says so", () => {
    const [, away] = page("out-of-reach").groups;
    expect(away?.note).toMatch(/^out of reach · as of /);
    expect(away?.rows[0]?.meters).toMatchObject([{ label: "weekly", text: "38%" }]);
  });
});

/**
 * The plan's Automation page shows each rule as the computer's Automation
 * does, and turns a draft on only after the computer's review. An event rule
 * may say what it waits for (docs/automation.md, "The event screen"): the
 * phone names it, reads a look that sent nothing as the computer's history
 * does, and hands the condition back when it turns the draft on. The phone
 * check's stand-in home screens no events, so this file owns those facts.
 * Fixture: a rule and its runs as the home sends them, parsed by the
 * published schemas, with the skipped look's prompt written by the
 * scheduler's own `eventsWords`.
 */
const WAITS_FOR = "invoices and quotes from suppliers";

const eventRule = (state: "enabled" | "draft") =>
  automationRuleSchema.parse({
    id: "rule_invoices",
    name: "Supplier invoices",
    state,
    spec: { kind: "event", integration: "Stand-in", event: "item_arrived", waitsFor: WAITS_FOR },
    prompt: "File what needs paying: {{events}}",
    revision: 2,
    nextFire: null,
    lastFired: state === "enabled" ? NOW - 60 * 60_000 : null,
    captainRequested: true,
    when: "An item arrives in Stand-in",
  });

const run = (id: number, extra: Record<string, unknown>) =>
  automationRunSchema.parse({
    id,
    revision: 2,
    plannedAt: NOW - id * 60 * 60_000,
    firedAt: NOW - id * 60 * 60_000,
    catchUp: false,
    missed: 0,
    settledAt: NOW - id * 60 * 60_000,
    tasks: [],
    cards: [],
    ...extra,
  });

const rulePage = (state: "enabled" | "draft") =>
  automationRulePage({
    rule: eventRule(state),
    dates: [],
    runs:
      state === "draft"
        ? []
        : [
            // Every new event was kept from the first mate: nothing was sent.
            run(1, {
              events: 0,
              screened: 2,
              delivery: "cancelled",
              prompt: eventsWords([
                { id: "m2", summary: "From Bo: Lunch on Friday?", screened: true },
                { id: "m5", summary: "From Ed: Team photo", screened: true },
              ]),
            }),
            // One event was sent and handled, one was kept back.
            run(2, {
              events: 1,
              screened: 1,
              delivery: "handled",
              prompt:
                "File what needs paying: - From Acme Supplies: Invoice 1042 due December 1 (id m1)",
            }),
          ],
    projects: [],
    integrations: null,
    home: "Studio",
    now: NOW,
  });

describe("the phone's page of an event rule that says what it waits for", () => {
  it("names the condition, and reads a look that sent nothing as skipped with the events it skipped", () => {
    const page = rulePage("enabled");
    expect(page.facts.find((fact) => fact.term === m.automationWaitsFor())?.value).toBe(WAITS_FOR);
    const [skipped, sent] = page.history.runs;
    expect([skipped?.state, skipped?.promptTitle, skipped?.note]).toEqual([
      m.automationRunSkippedState(),
      m.automationEventsSkipped(),
      m.automationScreenedNote(),
    ]);
    expect(skipped?.prompt).toContain("From Bo: Lunch on Friday?");
    expect([sent?.state, sent?.promptTitle]).toEqual([
      m.settingsAutomationDeliveryHandled(),
      m.settingsAutomationPromptAsSent(),
    ]);
    expect(sent?.line).toContain(m.automationRunAlsoSkipped({ count: "1" }));
  });

  it("shows the condition in a draft's review, and turns the draft on with it", () => {
    const { review } = rulePage("draft");
    expect(review?.facts.find((fact) => fact.term === m.automationWaitsFor())?.value).toBe(
      `${WAITS_FOR}. ${m.automationWaitsForNote()}`,
    );
    expect(review?.save).toMatchObject({ enable: true, spec: { waitsFor: WAITS_FOR } });
  });
});

/**
 * The captain's ask: the phone shows a CLI proxy's pooled Claude and ChatGPT
 * usage as the computer's Settings does (docs/quota.md, "A proxy's pooled
 * logins"). Fixture: a custom connection to the proxy, with the two pooled
 * rows the home sends for it, parsed by the published schema.
 */
describe("the phone's row of a connection to a proxy's pools", () => {
  it("shows each pool's meters under its name, and how its logins stand", () => {
    const pooled = (kind: "claude" | "chatgpt", percent: number, logins: number) => ({
      provider: "fm-custom-0123456789abcdef",
      label: kind === "claude" ? "Claude" : "ChatGPT",
      accountId: "acct_proxy",
      status: "ok",
      stale: false,
      windows: [{ id: "weekly", label: "weekly", percentRemaining: percent }],
      pool: {
        kind,
        logins,
        read: logins,
        unread: 0,
        spent: 0,
        switchedOff: 0,
        signInEnded: 0,
        signInSoon: 0,
      },
    });
    const snapshot = quotaSnapshotViewSchema.parse({
      generatedAt: new Date(NOW).toISOString(),
      fetchedAt: NOW,
      providers: [pooled("claude", 40, 3), pooled("chatgpt", 70, 2)],
    });
    const { groups } = intelligencePage({
      accounts: [account("acct_proxy", "Proxy", { providerId: "fm-custom-0123456789abcdef" })],
      snapshot,
      providers,
      devices: [],
      firstmateAccount: null,
      home: "Studio",
      now: NOW,
    });
    const row = groups[0]?.rows[0];
    expect(row?.meters.map((meter) => [meter.label, meter.text])).toEqual([
      ["Claude weekly", "40%"],
      ["ChatGPT weekly", "70%"],
    ]);
    expect(row?.state?.text).toBe(
      "Claude: 3 accounts pooled in your proxy app · ChatGPT: 2 accounts pooled in your proxy app",
    );
  });
});
