import type { AccountView } from "@shared/accounts";
import {
  AUTOMATION_UNREADABLE,
  type AutomationList,
  type AutomationRule,
  type AutomationRun,
  type AutomationSave,
} from "@shared/automation";
import {
  automationDateWords,
  automationEventWords,
  automationLooksFailingWords,
  automationNextWords,
  automationRuleTitle,
  automationStateTone,
  automationStateWords,
  automationSummary,
  automationWhenWords,
  automationZoneOf,
  automationZoneWords,
} from "@shared/automationWords";
import { COST_LIMIT_DEFAULT_USD, type CostLimit } from "@shared/costLimit";
import { isCustomApiProvider } from "@shared/customApi";
import { hereAs } from "@shared/deviceNames";
import * as m from "@shared/i18n/messages.generated";
import type { IntegrationsView } from "@shared/integrations";
import { catalogEntry, type ProviderView } from "@shared/providers";
import { QUOTA_POOL_NAMES, type QuotaSnapshotView } from "@shared/quota";
import { hostTakesBatches, projectDeliveryChoices, type RepoView } from "@shared/repos";
import type { RunbookView } from "@shared/runbooks";
import { runbooksSummary } from "@shared/runbookWords";
import { type DeviceSignIns, signInPlace } from "@shared/signIns";
import type { ProjectView } from "@shared/tasks";
import {
  DEFAULT_USAGE_QUERY,
  type UsagePeriod,
  type UsageSummary,
  type UsageUnit,
  usageValue,
} from "@shared/usage";
import {
  AUTONOMY_SWITCH_NAME,
  AUTONOMY_WORDS,
  PROJECT_DELIVERY_WORDS,
  RIGOR_WORDS,
} from "@shared/vocabulary";
import { quotaMicroMeterLook } from "../design/quota/quotaMeterLook";
import { accountsSummary, awayNote, clockOf, DEVICE_SIGN_INS_WORDS, rowView } from "./accountRows";
import {
  AUTOMATION_SHEET_WORDS,
  DELIVERY_TONES,
  deliveryNote,
  type ListenedEvent,
  localClockWords,
  previewPrompt,
  reviewCanTurnOn,
  reviewFacts,
  ruleProjectWords,
  runPromptTitle,
  runStateWords,
  runWords,
} from "./automationWords";
import { PROJECT_COST_WORDS } from "./projectCostWords";
import { projectEntries } from "./projectGroups";
import {
  batchNoHostWords,
  PROJECT_POLICY_WORDS,
  PROJECT_ROW_WORDS,
  projectRowWords,
  projectsSummary,
  runsOnWhere,
} from "./projectsWords";
import { CREW_PREFERRED_MARK, SUBSCRIPTIONS_WORDS } from "./subscriptionsWords";
import {
  formatAmount,
  formatRecorded,
  milestoneWords,
  modelLine,
  modelName,
  PERIOD_WORDS,
  periodLabel,
  readouts,
  SCOPE_WORDS,
  shortDate,
  sortedModels,
  UNIT_WORDS,
  usageSummaryLine,
  whereRows,
} from "./usageWords";

/**
 * The phone's Settings pages, built on the computer's own row rules and
 * words (docs/ios.md, "Settings pages in the computer's words"). The phone
 * reads what the computer's Settings reads, runs these functions on it and
 * draws what they answer, so an account's verdict, a rule's next run or a
 * project's rigor reads on the phone exactly as it does on the computer,
 * with no second copy of a rule or a sentence in Swift.
 *
 * Each function is pure: the raw answers in, one page of display rows out.
 * `home` is the name of the computer the first mate lives on, which every
 * sentence that says "this computer" names instead, as a computer that
 * controls it does (docs/view.md, "Settings on a view"). What a page
 * changes goes through the computer's existing actions; signing in, and
 * making, editing or deleting, stay on the computer, and each page says so.
 */

/** Sentences only the phone says: where the things it leaves to the computer are done. */
export const PHONE_SETTINGS_WORDS = {
  /** Where a waiting account signs in: "Sign in on Mac mini.", with the row's own action where it has one. */
  signIn: (where: string, action = m.settingsPhoneSignInAction()) =>
    m.settingsPhoneSignIn({ action, where }),
  accountsThere: (home: string) => m.settingsPhoneAccountsThere({ home }),
  get noAccounts() {
    return m.settingsPhoneNoAccounts();
  },
  /** When the allowance was last read, opposite the accounts' count. */
  asOf: (time: string) => m.settingsSubscriptionsAsOfTime({ time }),
  noAutomations: (home: string) => m.settingsPhoneNoAutomations({ home }),
  automationsThere: (home: string) => m.settingsPhoneAutomationsThere({ home }),
  pauseAllAsk: (count: number) => m.settingsPhonePauseAllAsk({ count }),
  /** Why a rule stopped, then where its integration is picked again. */
  stoppedThere: (reason: string, home: string) => m.settingsPhoneStoppedThere({ reason, home }),
  get byFirstMate() {
    return m.settingsPhoneByFirstMate();
  },
  get nextRun() {
    return m.settingsPhoneNextRun();
  },
  get lastRan() {
    return m.settingsPhoneLastRan();
  },
  usageThere: (home: string) => m.settingsPhoneUsageThere({ home }),
  projectsThere: (home: string) => m.settingsPhoneProjectsThere({ home }),
  noProjects: (home: string) => m.settingsPhoneNoProjects({ home }),
  get save() {
    return m.settingsPhoneSave();
  },
  get runbooksLead() {
    return m.settingsPhoneRunbooksLead();
  },
};

type DotTone = "ok" | "ring" | "warn" | "danger" | "idle" | "busy" | "captain";

export type PhoneMeter = {
  id: string;
  label: string;
  /** "74%", or "–" for a window that was not read. */
  text: string;
  fill: number;
  bar: string;
  figure: string;
  clock?: number;
  stale: boolean;
  reset?: string;
};

export type PhoneAccountRow = {
  id: string;
  provider: string;
  name: string;
  sub: string;
  dot: DotTone;
  dotLabel: string;
  /** The marks beside its name, in the computer's order: crew work prefers it, the first mate runs on it. */
  marks: string[];
  meters: PhoneMeter[];
  verdict?: { text: string; tone: "ok" | "danger" | "warn" | "neutral" };
  state?: { text: string; danger: boolean };
  /** Where to sign in, on a row that waits for one: the phone starts no sign-in. */
  signIn?: string;
};

export type PhoneAccountGroup = {
  id: string;
  label?: string;
  line?: string;
  note?: string;
  empty?: string;
  rows: PhoneAccountRow[];
};

export type PhoneIntelligence = {
  summary: string;
  asOf?: string;
  groups: PhoneAccountGroup[];
  /** What a mark beside an account's name means, for each mark some row shows. */
  marks: { mark: string; words: string }[];
  foot: string;
};

export type IntelligenceInput = {
  accounts: AccountView[];
  snapshot: QuotaSnapshotView | null;
  providers: ProviderView[];
  /** The computers that run work, or none where the first mate offers no Devices. */
  devices: DeviceSignIns[];
  firstmateAccount: string | null;
  home: string;
  now: number;
};

function accountRow(
  account: AccountView,
  quota: QuotaSnapshotView | null | undefined,
  providerName: (id: string) => string,
  place: { who: string; where: string },
  firstmate: boolean,
  now: number,
): PhoneAccountRow {
  const rows = quota?.providers.filter((entry) => entry.accountId === account.id) ?? [];
  const row = rows[0];
  const view = rowView(account, row, now);
  // A connection to a CLI proxy has a row per pool it serves: the phone shows
  // each pool's meters under its name, and how its logins stand as the state.
  const pools = rows.length > 1 && rows.every((entry) => entry.pool) ? rows : undefined;
  if (pools) {
    const views = pools.map((entry) => ({ entry, view: rowView(account, entry, now) }));
    view.meters = views.flatMap(({ entry, view: each }) =>
      each.meters.map((meter) => ({
        ...meter,
        id: `${entry.pool?.kind}:${meter.id}`,
        label: `${QUOTA_POOL_NAMES[entry.pool?.kind ?? "claude"]} ${meter.label}`,
      })),
    );
    const lines = views.flatMap(({ entry, view: each }) =>
      each.pool ? [`${QUOTA_POOL_NAMES[entry.pool?.kind ?? "claude"]}: ${each.pool}`] : [],
    );
    if (!view.stateText && lines.length > 0) view.stateText = lines.join(" · ");
  } else if (!view.stateText && view.pool) view.stateText = view.pool;
  const stale = view.kind === "stale";
  // The first-run sentence already says where to sign in; every other waiting row gets the line.
  const saysWhere = view.stateText === SUBSCRIPTIONS_WORDS.claudeFirstRun;
  return {
    id: account.id,
    provider: providerName(account.providerId),
    name: account.label,
    sub: view.sub,
    dot: view.dot,
    dotLabel: view.dotLabel,
    marks: [
      ...(account.pinned ? [CREW_PREFERRED_MARK] : []),
      ...(firstmate ? [SUBSCRIPTIONS_WORDS.firstmateAccountTag] : []),
    ],
    meters: view.meters.map((meter) => {
      const look = quotaMicroMeterLook({
        percentRemaining: meter.percent,
        pace: meter.pace,
        clockPercent: meter.clock,
        stale,
      });
      return {
        id: meter.id,
        label: meter.label,
        text: look.text,
        fill: look.fill,
        bar: look.bar,
        figure: look.figure,
        ...(look.clock !== undefined ? { clock: look.clock } : {}),
        stale,
        ...(meter.resetText ? { reset: meter.resetText } : {}),
      };
    }),
    ...(view.verdict ? { verdict: view.verdict } : {}),
    ...(view.stateText
      ? {
          state: {
            text: hereAs(view.stateText, place.who),
            danger: view.stateTone === "danger",
          },
        }
      : {}),
    ...(view.signIn && !saysWhere
      ? { signIn: PHONE_SETTINGS_WORDS.signIn(place.where, view.signInLabel) }
      : {}),
  };
}

/** Settings → Intelligence on the phone: every account, grouped by the computer it is on. Read only. */
export function intelligencePage(input: IntelligenceInput): PhoneIntelligence {
  const { accounts, snapshot, providers, devices, home, now } = input;
  const order = new Map(providers.map((provider, index) => [provider.id, index]));
  const nameIn = (list: readonly ProviderView[]) => (id: string) =>
    list.find((provider) => provider.id === id)?.name ??
    providers.find((provider) => provider.id === id)?.name ??
    catalogEntry(id)?.name ??
    (isCustomApiProvider(id) ? m.settingsGeneralCustomApi() : id);
  const ordered = [...accounts].sort(
    (a, b) =>
      (order.get(a.providerId) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(b.providerId) ?? Number.MAX_SAFE_INTEGER) || a.createdAt - b.createdAt,
  );
  const homeRows = ordered.map((account) =>
    accountRow(
      account,
      snapshot,
      nameIn(providers),
      { who: home, where: `on ${home}` },
      input.firstmateAccount === account.id,
      now,
    ),
  );
  const groups: PhoneAccountGroup[] = [
    {
      id: "home",
      ...(devices.length > 0 ? { label: home } : {}),
      ...(homeRows.length === 0 ? { empty: PHONE_SETTINGS_WORDS.noAccounts } : {}),
      rows: homeRows,
    },
    ...devices.map((device): PhoneAccountGroup => {
      const place = signInPlace(device);
      const note = awayNote(device);
      const rows = (device.signIns?.accounts ?? []).map((account) =>
        accountRow(
          account,
          device.signIns?.quota,
          nameIn(device.signIns?.providers ?? []),
          place,
          false,
          now,
        ),
      );
      return {
        id: device.deviceId,
        label: place.label,
        line: DEVICE_SIGN_INS_WORDS.own(place.where),
        ...(note ? { note } : {}),
        ...(rows.length === 0
          ? {
              empty: device.unanswered
                ? DEVICE_SIGN_INS_WORDS.unanswered(place.who, home)
                : DEVICE_SIGN_INS_WORDS.none,
            }
          : {}),
        rows,
      };
    }),
  ];
  const every = groups.flatMap((group) => group.rows);
  return {
    summary: accountsSummary(every.map((row) => ({ signIn: row.signIn !== undefined }))),
    ...(snapshot && snapshot.providers.length > 0
      ? { asOf: PHONE_SETTINGS_WORDS.asOf(clockOf(snapshot.fetchedAt)) }
      : {}),
    groups,
    marks: [
      ...(every.some((row) => row.marks.includes(CREW_PREFERRED_MARK))
        ? [{ mark: CREW_PREFERRED_MARK, words: SUBSCRIPTIONS_WORDS.crewPreferredMarkTitle }]
        : []),
      ...(every.some((row) => row.marks.includes(SUBSCRIPTIONS_WORDS.firstmateAccountTag))
        ? [
            {
              mark: SUBSCRIPTIONS_WORDS.firstmateAccountTag,
              words: SUBSCRIPTIONS_WORDS.firstmateAccountTagTitle,
            },
          ]
        : []),
    ],
    foot: PHONE_SETTINGS_WORDS.accountsThere(home),
  };
}

/** What a rule's one button does: pause or resume it, or open a draft's review. */
export type PhoneRuleAction = { id: "pause" | "resume" | "review"; label: string };

export type PhoneRuleRow = {
  id: string;
  title: string;
  tone: DotTone;
  /** The schedule in a few words. */
  when: string;
  /** Its next run under its term, in the rule's own time zone; its state alone when it has none. */
  next: { term?: string; value: string };
  action?: PhoneRuleAction;
};

export type PhoneAutomation = {
  summary: string;
  lead: string;
  unreadable?: string;
  rules: PhoneRuleRow[];
  empty?: string;
  pauseAll: { label: string; ask: string; enabled: boolean };
  foot: string;
};

function ruleWhen(rule: AutomationRule): string {
  return rule.stopped
    ? AUTOMATION_SHEET_WORDS.stoppedWhen
    : automationWhenWords(rule.spec, rule.when);
}

function runsNext(rule: AutomationRule): boolean {
  return rule.state === "enabled" && rule.nextFire !== null;
}

function ruleAction(rule: AutomationRule): PhoneRuleAction | undefined {
  if (rule.state === "enabled") return { id: "pause", label: m.settingsAutomationPause() };
  if (rule.state === "paused") return { id: "resume", label: m.settingsAutomationResume() };
  // A stopped event rule waits for its integration, which is picked on the computer.
  if (rule.state === "draft" && !rule.stopped)
    return { id: "review", label: m.settingsAutomationEnable() };
  return undefined;
}

/** Settings → Automation on the phone: every rule with its state, schedule and next run. */
export function automationPage(input: { list: AutomationList; home: string }): PhoneAutomation {
  const { list, home } = input;
  const unreadable = list.state === "unavailable";
  const running = list.rules.filter((rule) => rule.state === "enabled").length;
  return {
    summary: automationSummary(list.rules, unreadable).join(" · "),
    lead: m.settingsPhoneAutomationLead(),
    ...(unreadable ? { unreadable: AUTOMATION_UNREADABLE } : {}),
    rules: list.rules.map((rule) => {
      const action = ruleAction(rule);
      return {
        id: rule.id,
        title: automationRuleTitle(rule),
        tone: automationStateTone(rule),
        when: ruleWhen(rule),
        next: {
          ...(runsNext(rule) ? { term: PHONE_SETTINGS_WORDS.nextRun } : {}),
          value: automationNextWords(rule),
        },
        ...(action ? { action } : {}),
      };
    }),
    ...(list.rules.length === 0 && !unreadable
      ? { empty: PHONE_SETTINGS_WORDS.noAutomations(home) }
      : {}),
    pauseAll: {
      label: m.settingsAutomationPauseAll(),
      ask: PHONE_SETTINGS_WORDS.pauseAllAsk(running),
      enabled: running > 0,
    },
    foot: PHONE_SETTINGS_WORDS.automationsThere(home),
  };
}

/** One fact of a page: its term over its value, or over `lines` when the value is a list read one a line. */
export type PhoneFact = { term: string; value: string; lines?: string[]; prompt?: true };

export type PhoneRun = {
  id: number;
  tone: DotTone;
  state: string;
  line: string;
  note?: string;
  led: string[];
  /** What the kept prompt is called: the prompt as sent, or the events a look skipped. */
  promptTitle: string;
  prompt: string;
};

export type PhoneRule = {
  id: string;
  title: string;
  tone: DotTone;
  state: string;
  notes: string[];
  facts: PhoneFact[];
  action?: PhoneRuleAction;
  /** A draft's review: what turning it on means, and the save that turns it on. */
  review?: {
    title: string;
    facts: PhoneFact[];
    turnOn: string;
    back: string;
    canTurnOn: boolean;
    save: AutomationSave;
  };
  history: {
    title: string;
    empty: string;
    ledTo: string;
    /** Whether the runs have been read: until then the page says nothing about them. */
    read: boolean;
    runs: PhoneRun[];
  };
  foot: string;
};

export type RuleInput = {
  rule: AutomationRule;
  /** The rule's next dates as the computer plans them (`inf:automation:preview`), or null while they are unread. */
  dates: number[] | null;
  /** Its runs, newest first, or null while they are unread. */
  runs: AutomationRun[] | null;
  /** The projects a rule can be about, as the computer's Automation lists them (`inf:projects:list`). */
  projects: Pick<ProjectView, "id" | "name" | "archived">[];
  integrations: IntegrationsView | null;
  home: string;
  now: number;
};

function listenedOf(
  rule: AutomationRule,
  view: IntegrationsView | null,
): ListenedEvent | undefined {
  const spec = rule.spec;
  if (spec.kind !== "event") return undefined;
  const integration = view?.integrations.find((one) => one.id === spec.integration);
  const event = integration?.events?.find((one) => one.name === spec.event);
  if (!integration || !event) return undefined;
  return {
    when: rule.when ?? automationEventWords(event.label, integration.name),
    every: event.every,
    ...(event.filters ? { filters: event.filters } : {}),
  };
}

/** One rule's page: what it is, the prompt as the first mate gets it, its one action and its runs. */
export function automationRulePage(input: RuleInput): PhoneRule {
  const { rule, home, now } = input;
  const dates = input.dates ?? [];
  const projects = input.projects.filter((one) => !one.archived);
  const zone = automationZoneOf(rule.spec);
  const calendar = rule.spec.kind === "daily" || rule.spec.kind === "weekly";
  // A rule that runs once names that one time, whether it is still to come or has passed.
  const prompt = previewPrompt(
    rule.spec,
    rule.prompt,
    rule.spec.kind === "once" ? [rule.spec.at] : dates,
    now,
  );
  const action = ruleAction(rule);
  const listened = listenedOf(rule, input.integrations);
  return {
    id: rule.id,
    title: automationRuleTitle(rule),
    tone: automationStateTone(rule),
    state: automationStateWords(rule),
    notes: [
      ...(rule.failing ? automationLooksFailingWords(rule.failing) : []),
      ...(rule.stopped ? [PHONE_SETTINGS_WORDS.stoppedThere(rule.stopped, home)] : []),
      ...(rule.state === "draft" && !rule.stopped ? [AUTOMATION_SHEET_WORDS.draftNote] : []),
      ...(rule.captainRequested ? [] : [PHONE_SETTINGS_WORDS.byFirstMate]),
    ],
    facts: [
      { term: m.settingsAutomationWhen(), value: ruleWhen(rule) },
      ...(calendar
        ? [
            {
              term: m.settingsAutomationTimeZone(),
              value: zone ? automationZoneWords(zone) : localClockWords(home),
            },
          ]
        : []),
      // What an event rule waits for, which a skipped look's note in the runs below refers to.
      ...(rule.spec.kind === "event" && rule.spec.waitsFor
        ? [{ term: m.automationWaitsFor(), value: rule.spec.waitsFor }]
        : []),
      { term: m.settingsAutomationProject(), value: ruleProjectWords(rule.projectId, projects) },
      // The state above already says why a rule has no next run.
      ...(runsNext(rule)
        ? [{ term: PHONE_SETTINGS_WORDS.nextRun, value: automationNextWords(rule) }]
        : []),
      ...(rule.lastFired !== null
        ? [{ term: PHONE_SETTINGS_WORDS.lastRan, value: automationDateWords(rule.lastFired) }]
        : []),
      // The prompt names its scheduled time from the next dates, so it waits for them.
      ...(input.dates === null
        ? []
        : [{ term: m.settingsAutomationFirstMateGets(), value: prompt, prompt: true as const }]),
    ],
    ...(action ? { action } : {}),
    ...(action?.id === "review"
      ? {
          review: {
            title: m.settingsAutomationTurnOnQuestion(),
            facts: reviewFacts(
              { spec: rule.spec, dates, prompt, projectId: rule.projectId, listened },
              projects,
              home,
            ),
            turnOn: m.settingsAutomationTurnOn(),
            back: m.settingsAutomationBack(),
            canTurnOn: reviewCanTurnOn(rule.spec, dates),
            save: {
              id: rule.id,
              name: rule.name ?? "",
              spec: rule.spec,
              prompt: rule.prompt,
              ...(rule.projectId ? { projectId: rule.projectId } : {}),
              enable: true,
            },
          },
        }
      : {}),
    history: {
      title: m.settingsAutomationHistory(),
      empty: m.settingsAutomationNothingRun(),
      ledTo: m.settingsAutomationLedTo(),
      read: input.runs !== null,
      runs: (input.runs ?? []).map((run) => {
        const note = deliveryNote(run);
        return {
          id: run.id,
          tone: DELIVERY_TONES[run.delivery],
          state: runStateWords(run),
          line: `${runWords(run)} · ${m.settingsAutomationVersion({ version: String(run.revision) })}`,
          ...(note ? { note } : {}),
          led: [
            ...run.tasks.map((task) => `${task.key} ${task.title}`),
            ...run.cards.map((card) =>
              card.open
                ? m.settingsAutomationCard({ title: card.title })
                : m.settingsAutomationPastCard({ title: card.title }),
            ),
          ],
          promptTitle: runPromptTitle(run),
          prompt: run.prompt,
        };
      }),
    },
    foot: PHONE_SETTINGS_WORDS.automationsThere(home),
  };
}

export type PhoneUsage = {
  summary: string;
  periods: { value: UsagePeriod; label: string }[];
  units: { value: UsageUnit; label: string }[];
  period: UsagePeriod;
  unit: UsageUnit;
  label: string;
  /** Nothing recorded in the period: the title and its line, in place of every figure. */
  empty?: { title: string; line: string };
  readouts: { label: string; value: string; note: string }[];
  daily: {
    title: string;
    note: string;
    first: string;
    last: string;
    peak: string;
    /** Each day's share of the largest day, 0-1, oldest first, today last. */
    bars: { date: string; share: number; value: string }[];
  };
  models: { title: string; rows: { id: string; name: string; line: string; value: string }[] };
  where: {
    title: string;
    legend: string;
    rows: { id: string; name: string; value: string; depth: 0 | 1 }[];
  };
  milestone: { title: string; note: string };
  foot: string;
};

/** Settings → Usage on the phone: the period's readouts, days, models and where it went. Read only. */
export function usagePage(input: {
  summary: UsageSummary;
  unit: UsageUnit;
  home: string;
}): PhoneUsage {
  const { summary, unit, home } = input;
  const values = summary.days.map((day) => usageValue(day.amount, unit) ?? 0);
  const max = Math.max(0, ...values);
  const where = whereRows(
    summary.where,
    unit,
    summary.query.scope === "all" || summary.query.scope === "firstmate",
  );
  const first = summary.days[0]?.date;
  const last = summary.days.at(-1)?.date;
  return {
    summary: usageSummaryLine(summary),
    periods: (Object.keys(PERIOD_WORDS) as UsagePeriod[]).map((value) => ({
      value,
      label: PERIOD_WORDS[value],
    })),
    units: (Object.keys(UNIT_WORDS) as UsageUnit[]).map((value) => ({
      value,
      label: UNIT_WORDS[value],
    })),
    period: summary.query.period,
    unit,
    label: periodLabel(summary),
    ...(summary.total.records === 0
      ? {
          empty: { title: m.settingsUsageEmptyTitle(), line: m.settingsUsageEmptyLead() },
        }
      : {}),
    readouts: readouts(summary, unit),
    daily: {
      title: m.settingsUsageDailyHeading(),
      note: m.settingsPhoneTodayPartial(),
      first: first ? shortDate(first) : "",
      last: last ? shortDate(last) : "",
      peak: formatAmount(
        summary.days.reduce(
          (best, day) =>
            (usageValue(day.amount, unit) ?? 0) > (usageValue(best, unit) ?? 0) ? day.amount : best,
          summary.days[0]?.amount ?? summary.total,
        ),
        unit,
      ),
      bars: summary.days.map((day, index) => ({
        date: shortDate(day.date),
        share: max > 0 ? (values[index] ?? 0) / max : 0,
        value: formatRecorded(day.amount, unit),
      })),
    },
    models: {
      title: unit === "usd" ? m.settingsUsageModelsUsd() : m.settingsUsageModelsTokens(),
      rows: sortedModels(summary.models, unit).map((model) => ({
        id: model.id,
        name: modelName(model),
        line: modelLine(model),
        value: formatAmount(model.amount, unit),
      })),
    },
    where: {
      title: m.settingsUsageWhereHeading(),
      legend: m.settingsUsageWhereLegend(),
      rows: [
        ...(where.firstmate
          ? [
              {
                id: "firstmate",
                name: SCOPE_WORDS.firstmate,
                value: formatRecorded(where.firstmate, unit),
                depth: 0 as const,
              },
            ]
          : []),
        ...where.projects.flatMap((project) => [
          {
            id: `project:${project.key}`,
            name: project.name,
            value: formatAmount(project.amount, unit),
            depth: 0 as const,
          },
          ...project.kinds.map((kind) => ({
            id: `project:${project.key}:${kind.key}`,
            name: kind.name,
            value: formatAmount(kind.amount, unit),
            depth: 1 as const,
          })),
        ]),
        ...(where.other
          ? [
              {
                id: "other",
                name: SCOPE_WORDS.other,
                value: formatAmount(where.other, unit),
                depth: 0 as const,
              },
            ]
          : []),
      ],
    },
    milestone: milestoneWords(summary.finishedEver),
    foot: PHONE_SETTINGS_WORDS.usageThere(home),
  };
}

/** The period and work the phone's Usage opens on, as the computer's does. */
export const PHONE_USAGE_QUERY = DEFAULT_USAGE_QUERY;

export type PhoneChoice = { value: string; label: string };

export type PhoneProject = {
  id: string;
  name: string;
  /**
   * The project of several repositories this row is one of (INF-4220): its
   * id, its name and its line, drawn once above its rows; absent for a
   * project of one.
   */
  group?: { id: string; name: string; line: string };
  /** How the project differs from a new one, in the row's own words; empty for none. */
  line: string;
  path?: string;
  personal: boolean;
  delivery: {
    title: string;
    description: string;
    /** The one thing a personal workspace says here, in place of a choice. */
    fixed?: string;
    value: string;
    choices: PhoneChoice[];
  };
  asks: { title: string; label: string; description: string; fixed: boolean; asksFirst: boolean };
  rigor: {
    title: string;
    description: string;
    fixed?: string;
    value: string;
    choices: PhoneChoice[];
  };
  cost?: {
    title: string;
    description: string;
    value: "follow" | "amount" | "none";
    choices: PhoneChoice[];
    /** The amount Own amount starts from or holds, in estimated dollars. */
    usd: number;
    amountLabel: string;
    /** The amount's own button: the phone's number pad has no Return. */
    save: string;
  };
  notes: { text: string; warn: boolean }[];
};

export type PhoneProjects = {
  summary: string;
  projects: PhoneProject[];
  empty?: string;
  foot: string;
};

function costOf(limit: CostLimit | null | undefined): PhoneProject["cost"] {
  if (limit === undefined) return undefined;
  return {
    title: PROJECT_COST_WORDS.title,
    description: PROJECT_COST_WORDS.description,
    value: !limit ? "follow" : "usd" in limit ? "amount" : "none",
    choices: PROJECT_COST_WORDS.choices.map((choice) => ({ ...choice })),
    usd: limit && "usd" in limit ? limit.usd : COST_LIMIT_DEFAULT_USD,
    amountLabel: PROJECT_COST_WORDS.amount,
    save: PHONE_SETTINGS_WORDS.save,
  };
}

/** Settings → Projects on the phone: each project and the standing choices its row holds. */
export function projectsPage(input: {
  repos: RepoView[];
  /** The projects the repositories belong to (`inf:projects:list`); absent from an older phone. */
  projects?: ProjectView[];
  /** The projects folder, or null while it is unread. */
  folder: string | null;
  /** The computers that run work, or null where the first mate offers no Devices. */
  devices: DeviceSignIns[] | null;
  home: string;
}): PhoneProjects {
  const { repos, folder, devices, home } = input;
  // A project of several repositories is one group, named once above its rows (INF-4220).
  const entries = projectEntries(repos, input.projects ?? []);
  const groupOf = new Map<string, NonNullable<PhoneProject["group"]>>();
  for (const entry of entries)
    if (entry.kind === "several")
      for (const repo of entry.repos)
        groupOf.set(repo.id, {
          id: entry.project.id,
          name: entry.project.name,
          line: `${entry.project.key} · ${m.settingsProjectsRepositoryCount({ count: entry.repos.length })}`,
        });
  const ordered = entries.flatMap((entry) => (entry.kind === "one" ? [entry.repo] : entry.repos));
  const projects = ordered.map((repo): PhoneProject => {
    const group = groupOf.get(repo.id);
    const personal = repo.kind === "personal";
    // As the computer's row: a project with an address can be placed even before any computer is paired.
    const computers =
      devices?.length || (repo.kind === "project" && repo.origin) ? (devices ?? []) : null;
    const words = projectRowWords(repo, folder, computers ? runsOnWhere(repo, computers) : null);
    const cost = personal ? undefined : costOf(repo.costLimit);
    return {
      id: repo.id,
      name: repo.name,
      ...(group ? { group } : {}),
      line: words.join(" · "),
      ...(!personal && folder !== null && words.includes(PROJECT_ROW_WORDS.linked)
        ? { path: repo.path }
        : {}),
      personal,
      delivery: {
        title: PROJECT_POLICY_WORDS.deliveryTitle(personal),
        description: personal
          ? PROJECT_POLICY_WORDS.workspace
          : PROJECT_POLICY_WORDS.delivery(
              repo.batchesOffered !== false || repo.delivery === "queue-pr",
            ),
        ...(personal ? { fixed: PROJECT_ROW_WORDS.personal } : {}),
        value: repo.delivery,
        choices: personal
          ? []
          : projectDeliveryChoices(repo).map((value) => ({
              value,
              label: PROJECT_DELIVERY_WORDS[value],
            })),
      },
      asks: {
        title: AUTONOMY_SWITCH_NAME,
        label: repo.autonomy ? AUTONOMY_WORDS.putsInItself : AUTONOMY_WORDS.asksFirst,
        description: PROJECT_POLICY_WORDS.asks(personal, repo.autonomy),
        fixed: personal,
        asksFirst: !repo.autonomy,
      },
      rigor: {
        title: PROJECT_POLICY_WORDS.rigorTitle,
        description: PROJECT_POLICY_WORDS.rigor(personal),
        ...(personal ? { fixed: PROJECT_POLICY_WORDS.rigorNone } : {}),
        value: repo.rigor ?? "standard",
        choices: personal
          ? []
          : (["quick", "standard", "reviewed"] as const).map((value) => ({
              value,
              label: RIGOR_WORDS[value],
            })),
      },
      ...(cost ? { cost } : {}),
      notes: personal
        ? []
        : [
            ...(repo.batchesOffered !== false &&
            repo.origin &&
            repo.host &&
            !hostTakesBatches(repo.host)
              ? [{ text: batchNoHostWords(), warn: false }]
              : []),
            ...(repo.delivery === "local-only" && repo.rigor === "reviewed"
              ? [{ text: PROJECT_POLICY_WORDS.carefulLocal, warn: true }]
              : []),
          ],
    };
  });
  return {
    summary: projectsSummary(
      entries.map((entry) => (entry.kind === "one" ? entry.repo : (entry.repos[0] as RepoView))),
    ),
    projects,
    ...(repos.every((repo) => repo.kind === "personal")
      ? { empty: PHONE_SETTINGS_WORDS.noProjects(home) }
      : {}),
    foot: PHONE_SETTINGS_WORDS.projectsThere(home),
  };
}

export type PhoneRunbook = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  error?: string;
};

export type PhoneRunbooks = {
  summary: string;
  lead: string;
  groups: { id: "builtin" | "yours"; label: string; empty?: string; books: PhoneRunbook[] }[];
  foot: string;
};

/** Settings → Runbooks on the phone: the built-in ones and the person's own, each with its switch. */
export function runbooksPage(input: { books: RunbookView[]; home: string }): PhoneRunbooks {
  const { books, home } = input;
  const row = (book: RunbookView): PhoneRunbook => ({
    id: book.id,
    name: book.name,
    description: book.description,
    enabled: book.enabled,
    ...(book.error ? { error: book.error } : {}),
  });
  const builtin = books.filter((book) => book.source === "builtin");
  const yours = books.filter((book) => book.source !== "builtin");
  return {
    summary: runbooksSummary(books),
    lead: PHONE_SETTINGS_WORDS.runbooksLead,
    groups: [
      { id: "builtin", label: m.settingsRunbooksBuiltIn(), books: builtin.map(row) },
      {
        id: "yours",
        label: m.settingsRunbooksYours(),
        ...(yours.length === 0 ? { empty: m.settingsRunbooksYoursEmpty() } : {}),
        books: yours.map(row),
      },
    ],
    foot: m.settingsRunbooksFolderRemote({ computer: home }),
  };
}

/** Every page by the name the phone asks for it. */
export const PHONE_PAGES = {
  intelligence: intelligencePage,
  automation: automationPage,
  automationRule: automationRulePage,
  usage: usagePage,
  projects: projectsPage,
  runbooks: runbooksPage,
} as const;

export type PhonePageName = keyof typeof PHONE_PAGES;

/**
 * One page from the raw answers, both as JSON text: the whole seam between
 * the phone's Swift and this code. An unknown page or an input a function
 * cannot read throws, and the phone keeps the page it last drew.
 */
export function phonePage(name: string, input: string): string {
  const page = PHONE_PAGES[name as PhonePageName] as ((input: never) => unknown) | undefined;
  if (!page) throw new Error(`No Settings page is named ${name}`);
  return JSON.stringify(page(JSON.parse(input) as never));
}
