import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AccountView } from "@shared/accounts";
import {
  deviceForgeGateRef,
  deviceForgeSignInCardId,
  deviceForgeWaitLine,
  deviceSetupCardId,
  noSignInsWaitLine,
} from "@shared/deviceSetup";
import { GITHUB_ENTERPRISE, GITLAB } from "@shared/forges";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import type { ComputerForges } from "@shared/signIns";
import { workOrders } from "@shared/work";
import { describe, expect, it, vi } from "vitest";
import { piStubRuntime } from "../../../tests/helpers/piStubRuntime";
import type { PlacedHome } from "../../../tests/helpers/placedHome";
import {
  adoptHere,
  api,
  CODEX_MEDIUM_STARTER,
  computerAccount,
  feed,
  GROK_THERE,
  gate,
  gitProject,
  model,
  placedWorldHooks,
  type ServedThere,
  said,
  THIS_MAC_ON_CODEX,
  THIS_MAC_ON_NEWER_CODEX,
  world,
} from "../../../tests/helpers/placedWorld";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { CLAUDE_MODELS } from "../claude/claudeModels";
import { Router } from "../routing/router";
import { SettingsStore } from "../storage/settingsStore";
import { couldNotStartOf, seedTask } from "../tasks/seedTask";
import { git } from "../workspace/git";

/** Keep the adopted address, but let real Git clone the disposable project. */
function routeFixtureClone(address: string, localOrigin: string): void {
  const config = join(scratchDir("placed-sign-in-git-"), "gitconfig");
  writeFileSync(config, `[url "${localOrigin}"]\n\tinsteadOf = ${address}\n`);
  vi.stubEnv("GIT_CONFIG_GLOBAL", config);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
}

/**
 * A task that runs on a computer that runs work (`tests/helpers/placedWorld.ts`):
 * the computer's own sign-ins and the models it serves, and the personal opt-in.
 */

// Integration budget (docs/test-cohorts.md): real git on the computer and
// here, the slowest test 1.28 s at its fastest of nineteen runs on an Apple
// silicon Mac, with git unclamped as below. A poll waits for work that
// crosses the connection and runs git on both sides - a closed task's
// working copy kept, brought home and deleted took 0.46 s alone and 1.7 s
// with sixteen copies of this file running at once - so it waits for the
// rest of the test's budget, never Vitest's 1 s (tests/helpers/waitWindow.ts).
vi.setConfig({ testTimeout: 10_000 });

// On a Mac the product runs every git below the UI (`taskpolicy -c
// utility`, utilityQos.ts), where it yields to every busier process. A case
// here runs up to about a hundred gits one after another, so on a Mac
// loaded by other runs it waited on that load rather than its own work and
// ran past its budget. This file is about placed tasks, not that clamp
// (utilityQos.test.ts holds it), so its git runs as on a Mac without
// taskpolicy, at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/** The home's one clock: the wall clock, moved on when a case waits out a backoff. */
let ahead = 0;
const now = () => Date.now() + ahead;
placedWorldHooks({
  now,
  reset: () => {
    ahead = 0;
  },
});

/** The Claude models this build's provider-wide catalog lists, as `createServices` hands `catalogModels`. */
const CLAUDE_CATALOG = CLAUDE_MODELS.map((model) => ({
  provider: CLAUDE_PROVIDER_ID,
  id: model.id,
  name: model.name,
}));

/**
 * A computer with two Codex accounts: the pinned one serves GPT-6 Sol alone,
 * and only the other serves the starter map's medium model that routing takes.
 */
const TWO_CODEX_THERE = {
  routing: THIS_MAC_ON_NEWER_CODEX,
  signedInTo: [
    computerAccount("acct_codex_pinned", "openai-codex", { pinned: true }),
    computerAccount("acct_codex_other", "openai-codex"),
  ],
  served: [
    {
      accountId: "acct_codex_pinned",
      models: [{ provider: "openai-codex", id: "gpt-6-sol", name: "GPT-6 Sol" }],
    },
    {
      accountId: "acct_codex_other",
      models: [
        { provider: "openai-codex", id: CODEX_MEDIUM_STARTER, name: CODEX_MEDIUM_STARTER },
        { provider: "openai-codex", id: "gpt-6-sol", name: "GPT-6 Sol" },
      ],
    },
  ],
};

/**
 * OpenRouter's list as Pi reads it on a computer signed in to it: more than
 * four hundred models (405 on 2026-10-09, Pi's own list merged with pi.dev's),
 * of which the board lists only OpenRouter's own aliases.
 */
function openRouterList(listed: readonly string[]): ServedThere["models"] {
  const others = Array.from({ length: 450 }, (_, n) => `vendor-${n}/model-${n}`);
  return [...listed, ...others].map((id) => ({ provider: "openrouter", id, name: id }));
}

/** The reasons a task's routing decisions recorded, oldest first. */
function routingReasons(home: PlacedHome, taskId: string): string[] {
  const rows = home.db
    .prepare("SELECT reasons_json FROM decisions WHERE kind = 'routing' AND task_id = ?")
    .all(taskId) as { reasons_json: string }[];
  return rows.flatMap((row) => JSON.parse(row.reasons_json) as string[]);
}

it("carries only the opt-in to the running computer, which reads its own local files", async () => {
  const at = await world();
  const computerHome = scratchDir("fm-personal-computer-home-");
  writeFileSync(join(computerHome, "AGENTS.md"), "Computer user's local style.");
  const skill = join(computerHome, ".agents", "skills", "computer-rivets");
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, "SKILL.md"),
    "---\nname: computer-rivets\ndescription: Computer rivet rules.\n---\nCount here.",
  );
  const sent = vi.spyOn(at.home().devices, "ask");
  new SettingsStore(at.home().db).setPersonalResourcesEnabled(true);
  vi.stubEnv("HOME", computerHome);
  model([
    { tools: [{ name: "report", args: { text: "Local resources served.", summary: "Served." } }] },
    { text: "Reported." },
  ]);
  const first = api.requests.length;
  await at.start("t-personal");
  await expect
    .poll(() => at.home().tasks.get("t-personal")?.outcome)
    .toBe("Local resources served.");
  const system = JSON.stringify(api.requests[first]?.body.system);
  expect(system).toContain("Computer user's local style.");
  expect(system).toContain("Computer rivet rules.");
  const open = sent.mock.calls.find((call) => call[1] === "inf:session:open");
  expect(open).toBeDefined();
  const [order] = workOrders["inf:session:open"].request.parse(open?.[2]);
  expect(order?.spec.personalResources).toBe(true);
  expect(order?.spec.instructions).not.toContain("Computer user's local style.");
  expect(order?.spec.instructions).not.toContain(computerHome);
  sent.mockRestore();
  const record = at.home().tasks.get("t-personal")?.sessionFile;
  expect(record).toBeTruthy();
  await expect
    .poll(() => (record ? readFileSync(record, "utf8") : ""))
    .toContain("personal-resources");
  console.info("Placed resources:", system.slice(system.indexOf("Personal instructions from")));
});
// INF-6693's plan: the person's summary point reaches the work sent to a
// computer that runs work, which opens the conversation with it.
it("sends the home's summary point to the running computer with the crewmate's open", async () => {
  const at = await world();
  const sent = vi.spyOn(at.home().devices, "ask");
  new SettingsStore(at.home().db).setSummaryPoint(150_000);
  model([
    { tools: [{ name: "report", args: { text: "Summary point served.", summary: "Served." } }] },
    { text: "Reported." },
  ]);
  await at.start("t-summary-point");
  await expect
    .poll(() => at.home().tasks.get("t-summary-point")?.outcome)
    .toBe("Summary point served.");
  const open = sent.mock.calls.find((call) => call[1] === "inf:session:open");
  const [order] = workOrders["inf:session:open"].request.parse(open?.[2]);
  expect(order?.spec.compaction).toEqual({ maxContextTokens: 150_000 });
  sent.mockRestore();
});
describe("a task that runs on a computer that runs work", () => {
  it("takes its model among the subscriptions that computer is signed in to, on its own account there, never this Mac's", async () => {
    const grok = await piStubRuntime(api.url, { provider: "xai", id: "grok-stub" });
    const at = await world(undefined, {
      routing: THIS_MAC_ON_CODEX,
      // The computer is signed in to Grok alone, which this Mac is not.
      signedInTo: [
        computerAccount("acct_codex_off", "openai-codex", { enabled: false }),
        computerAccount("acct_grok_there", "xai"),
      ],
      served: GROK_THERE,
      runtime: grok,
    });
    const home = at.home();
    const requests = api.requests.length;
    model([{ tools: [{ name: "report", args: { text: "The footer is fixed." } }] }]);
    await at.start("t-routed");
    await expect.poll(() => home.tasks.get("t-routed")?.outcome).toBe("The footer is fixed.");
    const [routed] = home.decisions.routing({ taskIds: ["t-routed"], chosen: true });
    expect(routed).toMatchObject({ provider: "xai", model: "grok-stub" });
    const who = home.placed.placeOf(at.deviceId).who;
    expect(routingReasons(home, "t-routed")).toContain(
      `routed among ${who}'s own sign-ins (xai): 1 model`,
    );
    // The computer was asked to bind its own account for that provider,
    // and no account of this Mac's serves the task.
    expect(at.bound).toEqual([{ backend: "pi", provider: "xai", accountId: "acct_grok_there" }]);
    expect(home.tasks.get("t-routed")?.accountId).toBeNull();
    expect(
      home.tasks.timeline("t-routed").find((event) => event.kind === "dispatched")?.text,
    ).toContain("xai/grok-stub");
    expect(said(api.requests[requests])).toContain("Fix the footer.");
  });

  it("takes only a model that computer's own sign-in serves there, never one only this Mac's catalog lists (INF-146)", async () => {
    // This Mac's catalog lists the starter map's medium Codex model; the
    // computer's Codex account serves GPT-6 Sol alone, as Automatic reads it.
    const sol = await piStubRuntime(api.url, { provider: "openai-codex", id: "gpt-6-sol" });
    const at = await world(undefined, {
      routing: THIS_MAC_ON_NEWER_CODEX,
      signedInTo: [computerAccount("acct_codex_there", "openai-codex")],
      served: [
        {
          accountId: "acct_codex_there",
          models: [{ provider: "openai-codex", id: "gpt-6-sol", name: "GPT-6 Sol" }],
        },
      ],
      runtime: sol,
    });
    const home = at.home();
    seedTask(home.tasks, {
      id: "t-served",
      title: "website",
      prompt: "Fix the footer.",
      status: "queued",
      deviceId: at.deviceId,
    });
    model([{ tools: [{ name: "report", args: { text: "The footer is fixed." } }] }]);
    await home.supervisor.starts.dispatchQueuedTask("t-served");
    const [routed] = home.decisions.routing({ taskIds: ["t-served"], chosen: true });
    expect(routed).toMatchObject({ provider: "openai-codex", model: "gpt-6-sol" });
    const who = home.placed.placeOf(at.deviceId).who;
    expect(routingReasons(home, "t-served")).toContain(
      `routed among ${who}'s own sign-ins (openai-codex): 1 model`,
    );
    await expect.poll(() => home.tasks.get("t-served")?.outcome).toBe("The footer is fixed.");
    expect(at.bound).toEqual([
      { backend: "pi", provider: "openai-codex", accountId: "acct_codex_there" },
    ]);
  });

  it("binds the account there that serves its model, not the provider's pinned one that does not (INF-146)", async () => {
    const starter = await piStubRuntime(api.url, {
      provider: "openai-codex",
      id: CODEX_MEDIUM_STARTER,
    });
    const at = await world(undefined, { ...TWO_CODEX_THERE, runtime: starter });
    const home = at.home();
    model([{ tools: [{ name: "report", args: { text: "The footer is fixed." } }] }]);
    await at.start("t-account");
    await expect.poll(() => home.tasks.get("t-account")?.outcome).toBe("The footer is fixed.");
    const [routed] = home.decisions.routing({ taskIds: ["t-account"], chosen: true });
    expect(routed).toMatchObject({ provider: "openai-codex", model: CODEX_MEDIUM_STARTER });
    expect(at.bound).toEqual([
      { backend: "pi", provider: "openai-codex", accountId: "acct_codex_other" },
    ]);
  });

  it("starts on a model or basis the captain named while it waited for that computer's subscriptions (INF-83)", async () => {
    // That computer serves its medium starter, which routing takes unless the
    // captain names GPT-6 Sol, and its conversations can run either.
    const runtime = await piStubRuntime(
      api.url,
      { provider: "openai-codex", id: CODEX_MEDIUM_STARTER },
      ["gpt-6-sol"],
    );
    const at = await world(undefined, { ...TWO_CODEX_THERE, runtime });
    const home = at.home();
    const decide = vi.spyOn(Router.prototype, "decide");
    /** Holds the start's next read of that computer's subscriptions, its last wait before routing. */
    const holdServed = () => {
      const reached = gate();
      const release = gate();
      const served = home.placed.served.bind(home.placed);
      vi.spyOn(home.placed, "served").mockImplementationOnce(async (machine) => {
        reached.open();
        await release.held;
        return served(machine);
      });
      return { reached: reached.held, release: release.open };
    };
    const queued = (id: string) =>
      seedTask(home.tasks, {
        id,
        title: "website",
        prompt: "Fix the footer.",
        status: "queued",
        deviceId: at.deviceId,
      });

    queued("t-model");
    const named = holdServed();
    model([{ tools: [{ name: "report", args: { text: "The footer is fixed." } }] }]);
    const starting = home.supervisor.starts.dispatchQueuedTask("t-model");
    await named.reached;
    home.tasks.updateFields("t-model", { model: "gpt-6-sol" }, "firstmate");
    named.release();
    await starting;
    await expect.poll(() => home.tasks.get("t-model")?.outcome).toBe("The footer is fixed.");
    expect(home.tasks.get("t-model")?.model).toBe("openai-codex/gpt-6-sol");

    // A basis named while it waits is the one its tier is read from, verified.
    const spec = home.tasks.create({
      id: "t-spec",
      title: "Footer spec",
      prompt: "p",
      repoId: null,
      startPolicy: "on-request",
    });
    home.tasks.turns.recordReport(spec.id, { text: "The footer reads the year from the clock." });
    queued("t-basis");
    const grounded = holdServed();
    model([{ tools: [{ name: "report", args: { text: "The footer is grounded." } }] }]);
    const basisStart = home.supervisor.starts.dispatchQueuedTask("t-basis");
    await grounded.reached;
    home.tasks.updateFields("t-basis", { basis: spec.key }, "firstmate");
    grounded.release();
    await basisStart;
    await expect.poll(() => home.tasks.get("t-basis")?.outcome).toBe("The footer is grounded.");
    const asked = decide.mock.calls.filter(([taskId]) => taskId === "t-basis");
    expect(asked.at(-1)?.[2]).toMatchObject({ basis: spec.key, basis_verified: true });
  });

  it("binds the same account there again when it resumes after both computers restart, not the provider's pinned one (INF-146)", async () => {
    const starter = await piStubRuntime(api.url, {
      provider: "openai-codex",
      id: CODEX_MEDIUM_STARTER,
    });
    const at = await world(undefined, { ...TWO_CODEX_THERE, runtime: starter });
    model([
      { text: "Started on the footer." },
      { tools: [{ name: "report", args: { text: "The header is fixed too." } }] },
    ]);
    await at.start("t-resumed");
    await expect.poll(() => at.home().tasks.get("t-resumed")?.activity).toBe("idle");
    expect(at.bound).toEqual([
      { backend: "pi", provider: "openai-codex", accountId: "acct_codex_other" },
    ]);

    // Neither side holds the conversation any more: this Mac resumes it from
    // its record, and the computer opens it again with the binding it names.
    await at.stopComputer();
    await at.restartHome();
    await at.restartComputer();
    await at.inReach("t-resumed");
    await at.home().supervisor.steer.steerCrewmate("t-resumed", "Fix the header too.");
    await expect
      .poll(() => at.home().tasks.get("t-resumed")?.outcome)
      .toBe("The header is fixed too.");
    // A resumed conversation names no model, only the account it is bound to.
    expect(at.bound.map((binding) => binding.accountId)).toEqual([
      "acct_codex_other",
      "acct_codex_other",
    ]);
  });

  it("takes this Mac's Claude catalog for a Claude account there that lists no models, as a computer on protocol 2.6.0 through 8.1.0 says (INF-146)", async () => {
    const at = await world(undefined, {
      routing: {
        ...THIS_MAC_ON_CODEX,
        catalogModels: [...THIS_MAC_ON_CODEX.catalogModels, ...CLAUDE_CATALOG],
      },
      signedInTo: [computerAccount("acct_claude_there", CLAUDE_PROVIDER_ID)],
      // Its vault lists the signed-in Claude account with no models at all.
      served: [{ accountId: "acct_claude_there", models: [] }],
    });
    const pool = await at.home().placed.served(at.deviceId);
    expect(pool.available).toEqual(CLAUDE_CATALOG.map(({ provider, id }) => ({ provider, id })));
    expect(
      CLAUDE_CATALOG.map((model) => pool.modelAccounts?.get(`${model.provider}/${model.id}`)),
    ).toEqual(CLAUDE_CATALOG.map(() => "acct_claude_there"));
  });

  // INF-5438 finding 10: a model binds the account there whose own list names
  // it, ahead of a pinned one that lists nothing and only stands in with this
  // Mac's catalog.
  it("binds a model to the account there that lists it before a pinned one that lists none", async () => {
    const [first, second] = CLAUDE_CATALOG;
    if (!first || !second) throw new Error("The Claude catalog lists fewer than two models.");
    const at = await world(undefined, {
      routing: {
        ...THIS_MAC_ON_CODEX,
        catalogModels: [...THIS_MAC_ON_CODEX.catalogModels, ...CLAUDE_CATALOG],
      },
      signedInTo: [
        computerAccount("acct_claude_unlisted", CLAUDE_PROVIDER_ID, { pinned: true }),
        computerAccount("acct_claude_listed", CLAUDE_PROVIDER_ID),
      ],
      served: [
        { accountId: "acct_claude_unlisted", models: [] },
        { accountId: "acct_claude_listed", models: [{ provider: first.provider, id: first.id }] },
      ],
    });
    const pool = await at.home().placed.served(at.deviceId);
    expect(pool.modelAccounts?.get(`${first.provider}/${first.id}`)).toBe("acct_claude_listed");
    // A model only the catalog stands in for still binds the account that lists none.
    expect(pool.modelAccounts?.get(`${second.provider}/${second.id}`)).toBe("acct_claude_unlisted");
  });

  it("starts a task on a computer signed in only to OpenRouter, on one of that account's OpenRouter models there (FI3-1355)", async () => {
    // OpenRouter is the one subscription this Mac's catalog does not list:
    // the computer's own list is what its tasks route among.
    const alias = "~anthropic/claude-sonnet-latest";
    const openrouter = await piStubRuntime(api.url, { provider: "openrouter", id: alias });
    const at = await world(undefined, {
      routing: THIS_MAC_ON_CODEX,
      signedInTo: [computerAccount("acct_or_there", "openrouter", { kind: "api_key" })],
      served: [{ accountId: "acct_or_there", models: openRouterList([alias]) }],
      runtime: openrouter,
    });
    const home = at.home();
    const requests = api.requests.length;
    model([{ tools: [{ name: "report", args: { text: "The footer is fixed." } }] }]);
    await at.start("t-openrouter");
    await expect.poll(() => home.tasks.get("t-openrouter")?.outcome).toBe("The footer is fixed.");
    const [routed] = home.decisions.routing({ taskIds: ["t-openrouter"], chosen: true });
    expect(routed).toMatchObject({ provider: "openrouter", model: alias });
    const who = home.placed.placeOf(at.deviceId).who;
    expect(routingReasons(home, "t-openrouter")).toContain(
      `routed among ${who}'s own sign-ins (openrouter): 451 models`,
    );
    expect(at.bound).toEqual([
      { backend: "pi", provider: "openrouter", accountId: "acct_or_there" },
    ]);
    expect(home.tasks.get("t-openrouter")?.accountId).toBeNull();
    expect(said(api.requests[requests])).toContain("Fix the footer.");
  });

  it("does not start a task whose computer is signed in to no subscription that can take it, and makes nothing there", async () => {
    const at = await world(undefined, {
      routing: THIS_MAC_ON_CODEX,
      signedInTo: [computerAccount("acct_grok_off", "xai", { enabled: false })],
    });
    const home = at.home();
    seedTask(home.tasks, {
      id: "t-bare",
      title: "website",
      prompt: "Fix the footer.",
      status: "queued",
      deviceId: at.deviceId,
    });
    await home.supervisor.starts.dispatchQueuedTask("t-bare");
    const who = home.placed.placeOf(at.deviceId).who;
    expect(home.tasks.get("t-bare")).toMatchObject({
      status: "open",
      gate: null,
    });
    expect(couldNotStartOf(home.tasks.get("t-bare"))).toBe(
      `${who} has no subscription of its own that can take this task now. Sign it in to one in Settings → Intelligence.`,
    );
    // Neither this Mac's Codex nor anything else was chosen in its place.
    expect(home.decisions.routing({ taskIds: ["t-bare"], chosen: true })).toEqual([]);
    expect(at.bound).toEqual([]);
    expect(at.holds()).toEqual({ tasks: [], workingCopies: [] });
  });

  it("waits for a computer with no sign-ins yet, says so once, and starts by itself once it has one (FI3-1350)", async () => {
    // The computer lists no account at all; one appears once the captain signs it in there.
    const accounts: AccountView[] = [];
    const at = await world(undefined, {
      routing: THIS_MAC_ON_CODEX,
      signedInTo: accounts,
      served: GROK_THERE,
    });
    const home = at.home();
    seedTask(home.tasks, {
      id: "t-none",
      title: "website",
      prompt: "Fix the footer.",
      status: "queued",
      deviceId: at.deviceId,
    });
    const { label } = home.placed.placeOf(at.deviceId);
    await home.supervisor.starts.dispatchQueuedTask("t-none");
    // Queued work with no gate: nothing to press, nothing tried there.
    expect(home.tasks.get("t-none")).toMatchObject({ status: "open", gate: null });
    expect(at.bound).toEqual([]);
    expect(at.holds()).toEqual({ tasks: [], workingCopies: [] });
    const waits = () =>
      feed(home).filter((line) => line === noSignInsWaitLine(label, "website's next task"));
    expect(waits()).toHaveLength(1);
    // Tried again at the next sweep, it still waits, and the feed says nothing twice.
    await home.supervisor.watch.sweepGates(now());
    expect(home.tasks.get("t-none")?.status).toBe("open");
    expect(waits()).toHaveLength(1);
    expect(
      await home.supervisor.starts.startQueuedNow("t-none", { audience: "captain" }),
    ).toContain("has no sign-ins yet");

    model([{ text: "Done." }]);
    accounts.push(computerAccount("acct_grok_there", "xai"));
    await home.signIns.refresh(at.deviceId);
    await expect.poll(() => home.tasks.get("t-none")?.status).toBe("active");
    await expect
      .poll(() => at.bound)
      .toEqual([{ backend: "pi", provider: "xai", accountId: "acct_grok_there" }]);
    await expect
      .poll(() => feed(home))
      .toContain(`website's next task started ${home.placed.placeOf(at.deviceId).where}.`);
  });

  it("holds a task for a GitHub project until its computer has its own GitHub sign-in, with the card and one feed line, and starts it once it does (FI3-1350)", async () => {
    const forges: ComputerForges = { hosts: [{ host: "github.com", name: "GitHub" }], signIns: [] };
    const at = await world(undefined, {
      routing: THIS_MAC_ON_CODEX,
      signedInTo: [computerAccount("acct_grok_there", "xai")],
      served: GROK_THERE,
      forges: () => forges,
    });
    const home = at.home();
    const project = await gitProject();
    const address = "https://github.com/octo/website.git";
    await git(project.home, ["remote", "set-url", "origin", address]);
    const { repo } = await adoptHere(home.repos, project.home);
    routeFixtureClone(address, project.origin);
    home.repos.setRunsOn(repo.id, at.deviceId);
    seedTask(home.tasks, {
      id: "t-github",
      title: "website",
      prompt: "Fix the footer.",
      status: "queued",
      repoId: repo.id,
    });
    await home.supervisor.starts.dispatchQueuedTask("t-github");
    const place = home.placed.placeOf(at.deviceId);
    const ref = deviceForgeGateRef("github.com", at.deviceId);
    expect(home.tasks.get("t-github")).toMatchObject({
      status: "open",
      deviceId: at.deviceId,
      gate: { kind: "captain", ref },
    });
    expect(at.bound).toEqual([]);
    expect(at.holds()).toEqual({ tasks: [], workingCopies: [] });
    expect(
      feed(home).filter(
        (line) => line === deviceForgeWaitLine(`${repo.name}'s next task`, place.who),
      ),
    ).toHaveLength(1);
    const cardId = deviceForgeSignInCardId("github.com", at.deviceId);
    await expect
      .poll(() => home.cards().find((card) => card.id === cardId))
      .toMatchObject({
        author: "host",
        title: `Sign in to GitHub ${place.where}`,
        actions: [
          expect.objectContaining({
            effect: {
              kind: "open",
              target: "projects",
              forgeSignInOn: { deviceId: at.deviceId, host: "github.com" },
            },
          }),
        ],
      });

    model([{ text: "Done." }]);
    forges.signIns.push({
      host: "github.com",
      name: "GitHub",
      login: "octo",
      state: "ok",
      since: 1,
    });
    await home.signIns.refresh(at.deviceId);
    await expect.poll(() => home.tasks.get("t-github")?.status).toBe("active");
    await expect.poll(() => home.cards().some((card) => card.id === cardId)).toBe(false);
    await expect.poll(() => at.holds().workingCopies).toEqual(["t-github"]);
  });

  // INF-4280's audit item 7: a computer that signs in to GitLab and GitHub
  // Enterprise from here holds a project there for its own sign-in too.
  it("holds a task for a GitLab project until its computer has its own GitLab sign-in, and starts it once it does", async () => {
    const forges: ComputerForges = {
      hosts: [{ host: "github.com", name: "GitHub" }],
      signIns: [],
      servers: [GITHUB_ENTERPRISE, GITLAB],
    };
    const at = await world(undefined, {
      routing: THIS_MAC_ON_CODEX,
      signedInTo: [computerAccount("acct_grok_there", "xai")],
      served: GROK_THERE,
      forges: () => forges,
    });
    const home = at.home();
    const project = await gitProject();
    const address = "https://gitlab.com/acme/website.git";
    await git(project.home, ["remote", "set-url", "origin", address]);
    const { repo } = await adoptHere(home.repos, project.home);
    routeFixtureClone(address, project.origin);
    home.repos.setRunsOn(repo.id, at.deviceId);
    seedTask(home.tasks, {
      id: "t-gitlab",
      title: "website",
      prompt: "Fix the footer.",
      status: "queued",
      repoId: repo.id,
    });
    await home.supervisor.starts.dispatchQueuedTask("t-gitlab");
    const place = home.placed.placeOf(at.deviceId);
    expect(home.tasks.get("t-gitlab")).toMatchObject({
      status: "open",
      deviceId: at.deviceId,
      gate: { kind: "captain", ref: deviceForgeGateRef("gitlab.com", at.deviceId) },
    });
    expect(at.bound).toEqual([]);
    expect(feed(home)).toContain(
      deviceForgeWaitLine(`${repo.name}'s next task`, place.who, "GitLab"),
    );
    const cardId = deviceForgeSignInCardId("gitlab.com", at.deviceId);
    await expect
      .poll(() => home.cards().find((card) => card.id === cardId))
      .toMatchObject({
        title: `Sign in to GitLab ${place.where}`,
        actions: [
          expect.objectContaining({
            effect: expect.objectContaining({
              forgeSignInOn: { deviceId: at.deviceId, host: "gitlab.com" },
            }),
          }),
        ],
      });

    model([{ text: "Done." }]);
    forges.signIns.push({
      host: "gitlab.com",
      name: "GitLab",
      login: "tanuki",
      state: "ok",
      since: 1,
      server: GITLAB,
    });
    await home.signIns.refresh(at.deviceId);
    await expect.poll(() => home.tasks.get("t-gitlab")?.status).toBe("active");
    await expect.poll(() => home.cards().some((card) => card.id === cardId)).toBe(false);
  });

  it("holds a task whose clone GitHub refused on its computer, typed, for that computer's own sign-in (FI3-1350)", async () => {
    let refuse = true;
    const at = await world(undefined, {
      routing: THIS_MAC_ON_CODEX,
      signedInTo: [computerAccount("acct_grok_there", "xai")],
      served: GROK_THERE,
      // It offers no GitHub sign-in from here, so nothing holds it before the clone.
      refuseClone: () => refuse,
    });
    const home = at.home();
    const project = await gitProject();
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.setRunsOn(repo.id, at.deviceId);
    seedTask(home.tasks, {
      id: "t-refused",
      title: "website",
      prompt: "Fix the footer.",
      status: "queued",
      repoId: repo.id,
    });
    await home.supervisor.starts.dispatchQueuedTask("t-refused");
    const place = home.placed.placeOf(at.deviceId);
    expect(home.tasks.get("t-refused")).toMatchObject({
      status: "open",
      deviceId: at.deviceId,
      gate: { kind: "captain", ref: deviceForgeGateRef("github.com", at.deviceId) },
    });
    // Nothing was cloned there; the task's own folder there is a failed start's, cleaned later.
    expect(at.holds().workingCopies).toEqual([]);
    expect(feed(home)).toContain(deviceForgeWaitLine(`${repo.name}'s next task`, place.who));
    await expect
      .poll(() =>
        home.cards().some((card) => card.id === deviceForgeSignInCardId("github.com", at.deviceId)),
      )
      .toBe(true);
    model([{ text: "Done." }]);
    refuse = false;
    await home.supervisor.placement.resumeDeviceForgeSignInTasks(at.deviceId, "github.com");
    await expect.poll(() => home.tasks.get("t-refused")?.status).toBe("active");
    expect(at.holds().workingCopies).toEqual(["t-refused"]);
  });

  it("holds a task whose clone GitLab refused on its computer behind that computer's own GitLab sign-in, not GitHub's", async () => {
    let refuse = true;
    const at = await world(undefined, {
      routing: THIS_MAC_ON_CODEX,
      signedInTo: [computerAccount("acct_grok_there", "xai")],
      served: GROK_THERE,
      // Its git is refused by gitlab.com for want of a GitLab sign-in there.
      refuseClone: () => refuse && "https://gitlab.com/acme/api.git",
    });
    const home = at.home();
    const project = await gitProject();
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.setRunsOn(repo.id, at.deviceId);
    seedTask(home.tasks, {
      id: "t-gitlab-refused",
      title: "api",
      prompt: "Fix the footer.",
      status: "queued",
      repoId: repo.id,
    });
    const place = home.placed.placeOf(at.deviceId);
    // The computer's setup card is up: it asks for github.com's sign-in
    // alone, so GitLab's card still goes up beside it.
    home.supervisor.cards.hostCards.raiseHostCard({
      id: deviceSetupCardId(at.deviceId),
      title: `Set up ${place.label}`,
      meta: place.label,
      body: "<p>Sign in to GitHub there.</p>",
      actions: [],
    });
    await home.supervisor.starts.dispatchQueuedTask("t-gitlab-refused");
    expect(home.tasks.get("t-gitlab-refused")).toMatchObject({
      status: "open",
      deviceId: at.deviceId,
      gate: { kind: "captain", ref: deviceForgeGateRef("gitlab.com", at.deviceId) },
    });
    expect(feed(home)).toContain(
      deviceForgeWaitLine(`${repo.name}'s next task`, place.who, "GitLab"),
    );
    await expect
      .poll(() =>
        home.cards().some((card) => card.id === deviceForgeSignInCardId("gitlab.com", at.deviceId)),
      )
      .toBe(true);
    expect(
      home.cards().some((card) => card.id === deviceForgeSignInCardId("github.com", at.deviceId)),
    ).toBe(false);
    // GitLab's sign-in there releases it; GitHub's would not.
    await home.supervisor.placement.resumeDeviceForgeSignInTasks(at.deviceId, "github.com");
    expect(home.tasks.get("t-gitlab-refused")?.status).toBe("open");
    model([{ text: "Done." }]);
    refuse = false;
    await home.supervisor.placement.resumeDeviceForgeSignInTasks(at.deviceId, "gitlab.com");
    await expect.poll(() => home.tasks.get("t-gitlab-refused")?.status).toBe("active");
  });

  it("starts nothing for a task whose computer takes no work, and never runs it here", async () => {
    const at = await world();
    const home = at.home();
    seedTask(home.tasks, {
      id: "t-waits",
      title: "website",
      status: "queued",
      deviceId: "a-mac-on-another-version",
    });
    await home.supervisor.starts.dispatchQueuedTask("t-waits");
    expect(home.tasks.get("t-waits")?.status).toBe("open");
    expect(home.placed.ready("a-mac-on-another-version", "t-waits")).toBe(false);
  });
});
