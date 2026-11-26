import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import type { AutomationList } from "@shared/automation";
import type { RunbookView } from "@shared/runbooks";
import { expect, test, vi } from "vitest";
import { startPhoneHome } from "./helpers/phoneHome";
import { PHONE_SETTINGS_ACCOUNTS, PHONE_SETTINGS_PROJECTS } from "./helpers/phoneSettings";
import { scratchDir } from "./helpers/scratchDirs";

// INF-3563 puts Intelligence, Automation, Usage, Projects and Runbooks in the phone's Settings, each
// saying what the computer holds in the computer's own words: the phone reads the computer's answers
// and hands them to one script built from the computer's own row rules (docs/ios.md, "Settings pages
// in the computer's words"). This file owns that composition: the answers a paired phone may ask for,
// as they travel, become the pages the plan describes.
// Fixture: the phone check's own stand-in computer (tests/helpers/phoneSettings.ts), every answer read
// as a paired phone reads it, over the published contract, so an answer a phone may not ask refuses
// here. The script is the committed file the phone ships, run with nothing but the language itself,
// as the phone runs it.
// Budget: one local TLS home with two small git folders and a paired client; the Mac's slowest of
// three runs took 1.7 s.
const HOME = "Test Mac mini";

// What this file reads of each page the script answers (src/renderer/src/settings/phonePages.ts owns the whole).
type Fact = { term: string; value: string; lines?: string[] };
type Choice = { value: string };
type PhoneIntelligence = {
  summary: string;
  groups: {
    rows: {
      id: string;
      signIn?: string;
      meters: { label: string; text: string; reset?: string; stale: boolean }[];
    }[];
  }[];
};
type PhoneAutomation = {
  summary: string;
  rules: {
    title: string;
    when: string;
    next: { term?: string; value: string };
    action?: { id: string };
  }[];
  pauseAll: { enabled: boolean };
};
type PhoneRule = {
  id: string;
  facts: Fact[];
  action?: { id: string };
  review?: { facts: Fact[] };
  history: { runs: { prompt: string }[] };
};
type PhoneUsage = {
  empty?: unknown;
  readouts: { value: string }[];
  daily: { bars: unknown[] };
  where: { rows: { name: string; depth: number }[] };
};
type PhoneProjects = {
  summary: string;
  projects: { id: string; delivery: { choices: Choice[] } }[];
};
type PhoneRunbooks = {
  summary: string;
  groups: { books: { id: string; enabled: boolean }[] }[];
};

test("the phone's Settings pages say what the computer holds, in the computer's words", async () => {
  vi.stubEnv("PI_OFFLINE", "1");
  for (const name of ["INFINITARY_CONNECTION_LOOPBACK_PORT", "INFINITARY_DNS_SD"])
    vi.stubEnv(name, process.env[name]);
  const home = await startPhoneHome(scratchDir("infinitary-phone-settings-"), undefined, {
    settings: true,
  });
  try {
    const context = vm.createContext({});
    vm.runInContext(
      readFileSync(
        join(import.meta.dirname, "../ios/Infinitary/InfinitaryApp/SettingsWords.generated.js"),
        "utf8",
      ),
      context,
    );
    const build = vm.runInContext("PhoneSettingsWords.page", context) as (
      name: string,
      input: string,
    ) => string;
    const page = <Page>(name: string, input: unknown) =>
      JSON.parse(build(name, JSON.stringify(input))) as Page;

    const pages = await home.asPhone(async (ask) => {
      const read = async <Value = unknown>(channel: string, args: unknown[] = []) => {
        const line = await ask(channel, args);
        if (line.ok !== true) throw new Error(`${channel}: ${JSON.stringify(line)}`);
        return line.value as Value;
      };
      const now = Date.now();
      const list = await read<AutomationList>("inf:automation:list");
      const projects = await read("inf:projects:list");
      const books = await read<RunbookView[]>("inf:settings:runbooks:get");
      const usage = await read("inf:usage:summary", [{ period: "30d", scope: "all" }]);
      const rules: Record<string, PhoneRule> = {};
      for (const rule of list.rules) {
        const { dates } = await read<{ dates: number[] }>("inf:automation:preview", [rule.spec]);
        rules[rule.name ?? rule.id] = page<PhoneRule>("automationRule", {
          rule,
          dates,
          runs: await read("inf:automation:history", [rule.id]),
          projects,
          integrations: null,
          home: HOME,
          now,
        });
      }
      return {
        books,
        rules,
        intelligence: page<PhoneIntelligence>("intelligence", {
          accounts: await read("inf:accounts:list"),
          snapshot: await read("inf:quota:snapshot"),
          providers: await read("inf:auth:providers"),
          devices: [],
          firstmateAccount: await read("inf:settings:firstmate-account:get"),
          home: HOME,
          now,
        }),
        automation: page<PhoneAutomation>("automation", { list, home: HOME }),
        tokens: page<PhoneUsage>("usage", { summary: usage, unit: "tokens", home: HOME }),
        dollars: page<PhoneUsage>("usage", { summary: usage, unit: "usd", home: HOME }),
        projects: page<PhoneProjects>("projects", {
          repos: await read("inf:repos:list"),
          projects,
          folder: (await read<{ path: string }>("inf:repos:folder")).path,
          devices: null,
          home: HOME,
        }),
        runbooks: page<PhoneRunbooks>("runbooks", { books, home: HOME }),
      };
    });

    const { intelligence } = pages;
    expect(intelligence.summary).toBe("3 accounts · 1 needs a sign-in");
    expect(intelligence.groups).toHaveLength(1);
    // Two Codex accounts are in use, so their pooled row heads the list
    // (docs/quota.md, "A pool of your own logins").
    const [pool, personal, work, team] = intelligence.groups[0]?.rows ?? [];
    expect(intelligence.groups[0]?.rows).toHaveLength(4);
    expect(pool?.id).toBe("pool:codex");
    expect([personal?.id, work?.id, team?.id]).toEqual(Object.values(PHONE_SETTINGS_ACCOUNTS));
    expect(personal).toMatchObject({
      provider: "Codex",
      name: "Personal",
      sub: "Plus · ada@example.com",
      dot: "ok",
      verdict: { tone: "ok" },
    });
    expect(personal?.meters.map(({ label, text, reset }) => [label, text, reset])).toEqual([
      ["session", "74%", "resets in 2h"],
      ["weekly", "62%", "resets in 3d"],
    ]);
    expect(personal?.signIn).toBeUndefined();
    expect(work).toMatchObject({ name: "Work", dot: "danger", meters: [] });
    expect(work?.signIn).toBe(`Sign in on ${HOME}.`);
    expect(team).toMatchObject({ provider: "Grok", dot: "warn", verdict: { tone: "warn" } });
    expect(team?.meters).toMatchObject([{ text: "57%", stale: true }]);

    // Automation: each rule's state and the one thing the phone may do to it.
    const { automation, rules } = pages;
    expect(automation.summary).toBe("1 active · 1 paused");
    expect(automation.rules.map((rule) => [rule.title, rule.action?.id])).toEqual([
      ["Morning summary", "pause"],
      ["Check for outdated packages", "resume"],
      ["Friday wrap-up", "review"],
      ["Release notes reminder", undefined],
    ]);
    // Each row says its schedule, then its next run under its term, or its state alone when it has none.
    expect(automation.rules.map((rule) => rule.when)).toEqual([
      "Every day at 8:00 AM",
      "Mondays at 9:30 AM",
      "Fridays at 4:00 PM",
      expect.stringMatching(/^Once, /),
    ]);
    expect(automation.rules.map((rule) => rule.next)).toEqual([
      { term: "Next run", value: expect.stringMatching(/^\w+, \w+ \d+, /) },
      { value: "Paused" },
      { value: "Draft" },
      { value: "Done" },
    ]);
    expect(automation.pauseAll.enabled).toBe(true);
    const fact = (rule: PhoneRule | undefined, term: string) =>
      rule?.facts.find((one) => one.term === term)?.value;
    // A rule's project is named as the computer's Automation names it.
    expect(fact(rules["Morning summary"], "Project")).toBe("Website");
    // A rule that is on names its next run; one that is not leaves that to its state.
    expect(fact(rules["Morning summary"], "Next run")).toMatch(/^\w+, \w+ \d+, /);
    expect(fact(rules["Check for outdated packages"], "Next run")).toBeUndefined();
    // A draft turns on only after the computer's review: what it will do, and the next times it runs.
    const draft = rules["Friday wrap-up"];
    expect(draft?.action?.id).toBe("review");
    expect(draft?.review).toMatchObject({
      canTurnOn: true,
      save: { id: draft?.id, name: "Friday wrap-up", enable: true },
    });
    expect(draft?.review?.facts.find((one) => one.term === "Next runs")?.lines).toHaveLength(3);
    expect(rules["Morning summary"]?.review).toBeUndefined();
    // A rule that ran shows the run, with the prompt as the first mate got it.
    const [run] = rules["Release notes reminder"]?.history.runs ?? [];
    expect(rules["Release notes reminder"]?.history.runs).toHaveLength(1);
    expect(run?.prompt).toMatch(
      /^Remind me to send the release notes\. It is \w+, \w+ \d+, \d{4} /,
    );
    // A rule that ran once names that one time in its prompt, with nothing left to fill in.
    expect(fact(rules["Release notes reminder"], "Your first mate gets")).toBe(run?.prompt);
    expect(rules["Morning summary"]?.history.runs).toEqual([]);

    const { tokens, dollars } = pages;
    expect(tokens.readouts.map((readout) => readout.value)).toEqual(["19.00M", "8", "1"]);
    expect(dollars.readouts[0]?.value).toBe("$29.54");
    expect(tokens.empty).toBeUndefined();
    expect(tokens.daily.bars).toHaveLength(30);
    expect(tokens.where.rows.filter((row) => row.depth === 0).map((row) => row.name)).toEqual([
      "First mate",
      "Field notes",
      "Website",
      "Other work",
    ]);

    // Projects: each project's standing choices; one that lives only on the computer merges there.
    const { projects } = pages;
    expect(projects.summary).toBe("2 projects");
    const project = (id: string) => projects.projects.find((one) => one.id === id);
    expect(project(PHONE_SETTINGS_PROJECTS.website)).toMatchObject({
      name: "Website",
      delivery: { value: "direct-pr" },
      asks: { asksFirst: true, fixed: false },
      rigor: { value: "standard" },
      cost: { value: "follow" },
    });
    expect(
      project(PHONE_SETTINGS_PROJECTS.website)?.delivery.choices.map((choice) => choice.value),
    ).toEqual(["local-only", "direct-pr"]);
    expect(
      project(PHONE_SETTINGS_PROJECTS.app)?.delivery.choices.map((choice) => choice.value),
    ).toEqual(["local-only"]);

    const { runbooks, books } = pages;
    expect(books.length).toBeGreaterThan(0);
    expect(
      runbooks.groups.flatMap((group) => group.books.map((book) => [book.id, book.enabled])),
    ).toEqual(books.map((book) => [book.id, book.enabled]));
    const on = books.filter((book) => book.enabled).length;
    expect(runbooks.summary).toContain(`${on} on`);
  } finally {
    await home.close();
    vi.unstubAllEnvs();
  }
}, 20_000);
