import { accountPools } from "@shared/accountPools";
import { AUTOMATIC_COMPUTER } from "@shared/placement";
import type { QuotaProviderView, QuotaSnapshotView } from "@shared/quota";
import type { RepoView } from "@shared/repos";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeCrewmate, setup } from "../../../tests/helpers/crewHarness";
import { freshDatabase } from "../../../tests/helpers/database";
import { AT, CODEX, FINISHED, GROK, row, snapshot } from "../../../tests/helpers/placedWorkRecord";
import { AutomaticPlacement } from "../placed/automaticPlacement";
import { ComputerResourceFeed } from "../placed/computerResourceFeed";
import { ComputerResources } from "../placed/computerResources";
import type { WorkDevices } from "../placed/workDevices";
import { buildModelsCatalog, effectiveFromProvider } from "../quota/catalog";
import type { QuotaService } from "../quota/quotaService";
import { DecisionStore } from "../storage/decisionStore";
import { SettingsStore } from "../storage/settingsStore";
import { UsageStore } from "../storage/usageStore";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { AccountSelector } from "./accountRouter";
import { PlacedWorkScores } from "./placedWork";
import { Router } from "./router";

function world(samples = FINISHED, sampleModel = GROK, level = "medium", db = freshDatabase()) {
  const settings = new SettingsStore(db);
  const tasks = new TaskService({ db, now: () => AT });
  const decisions = new DecisionStore(db);
  const usage = new UsageStore(db);
  const scores = new PlacedWorkScores(db, settings);
  const log = (taskId: string, cost: number, at: number, accountId = "mini-grok") =>
    usage.record({
      taskId,
      accountId,
      model: GROK,
      usage: { cost, costSource: "listed-prices" },
      at,
    });
  const seed = (id: string, deviceId?: string) =>
    seedTask(tasks, {
      id,
      title: id,
      status: "running",
      ...(deviceId ? { deviceId } : {}),
      createdAt: AT - 86400000,
    });
  const route = (id: string, model = GROK, level = "medium") =>
    decisions.recordRouting({
      taskId: id,
      provider: model.provider,
      model: model.id,
      bucket: level,
      served: level,
      rule: "R4",
      reasons: [],
    });
  for (const [i, cost] of samples.entries()) {
    const id = `finished-${i}`;
    seed(id);
    route(id, sampleModel, level);
    log(id, cost, AT - 3600000);
    tasks.close(id, { status: "done", reason: "finished", actor: "host" });
  }
  const learn = () => {
    const before = AT - 3600000;
    scores.observe("mini", snapshot(before, [row("grok", "mini-grok", 38)]));
    scores.observe("home", snapshot(before, [row("grok", "home-grok", 38)]));
    log("firstmate", 289.61, AT - 1000);
    log("firstmate", 0.6, AT - 1000, "home-grok");
    scores.observe("mini", snapshot(AT, [row()]));
    scores.observe("home", snapshot(AT, [row("grok", "home-grok")]));
  };
  return { db, settings, tasks, decisions, scores, usage, log, seed, route, learn };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(AT);
});
afterEach(() => vi.useRealTimers());
describe("INF-443 learned placed-work ranking", () => {
  it("replays the twelve-task burst through Router commits: one Grok, then eleven Codex; the raw meter is unchanged", () => {
    vi.useFakeTimers();
    vi.setSystemTime(AT);
    const w = world();
    w.learn();
    const rows = [row(), row("codex", "mini-codex", 84)];
    const catalog = buildModelsCatalog([GROK, CODEX], rows, new Date(AT).toISOString(), AT);
    const router = new Router({
      settings: w.settings,
      decisions: w.decisions,
      placedWork: w.scores,
      quota: { latestModels: () => catalog, latest: () => snapshot(AT, rows) } as QuotaService,
      availableModels: () => [GROK, CODEX],
    });
    const picked: string[] = [];
    for (let i = 0; i < 12; i++) {
      const id = `audit-${i}`;
      w.seed(id, "mini");
      picked.push(
        router.decide(
          id,
          "Build the accepted audit piece",
          {
            kind: "implement",
            basis: "plan",
            basis_verified: true,
          },
          {
            ...{
              pool: {
                available: [GROK, CODEX],
                catalog: catalog.models,
                readings: rows,
                note: "Mac mini",
              },
            },
            placed: w.scores.data(AT),
          },
        )!.choice!.provider,
      );
    }
    expect(picked).toEqual(["xai", ...Array<string>(11).fill("openai-codex")]);
    const facts = w.db
      .prepare("SELECT facts_json FROM decisions WHERE task_id = 'audit-1' AND kind = 'routing'")
      .get() as { facts_json: string };
    const grok = JSON.parse(facts.facts_json).candidates.find(
      (c: { provider: string }) => c.provider === "xai",
    );
    expect(grok.percentRemaining).toBe(19);
    expect(grok.charge.windows[0].pointsPerDollar).toBeCloseTo(38 / 290.21);
    expect(grok.charge.windows[0].points).toBeGreaterThan(4);
    expect(catalog.models.find((m) => m.provider === "grok")!.effectivePercentRemaining).toBe(19);
    console.log(
      JSON.stringify({
        scenario: "INF-438 twelve-task replay",
        picked,
        secondGrokCandidate: grok,
        rawMeter: 19,
      }),
    );
    w.db.close();
  });

  it("charges nothing until learning, keeps a learned price over restart/reset, and ignores duplicate or stale readings", () => {
    const w = world();
    w.seed("new", "mini");
    w.route("new");
    w.scores.observe("mini", snapshot(AT, [row()]));
    expect(w.scores.score(row(), AT, undefined, w.scores.data(AT)).charge!.windows[0]!.points).toBe(
      0,
    );
    w.learn();
    const price = w.settings.getAllowancePrices();
    expect(Object.values(price)[0]).toBeGreaterThan(0);
    w.scores.observe("mini", snapshot(AT, [row("grok", "mini-grok", 0)]));
    w.scores.observe("mini", snapshot(AT + 1, [{ ...row(), stale: true }]));
    expect(w.settings.getAllowancePrices()).toEqual(price);
    const restarted = new PlacedWorkScores(w.db, new SettingsStore(w.db));
    const reset = row("grok", "mini-grok", 100);
    reset.windows[0]!.resetsAtMs! += 604800000;
    restarted.observe("mini", snapshot(AT + 1000, [reset]));
    expect(
      restarted.score(reset, AT + 1000, undefined, restarted.data(AT + 1000)).charge!.windows[0]!
        .points,
    ).toBeGreaterThan(0);
    w.db.close();
  });

  it("counts placed work toward the runway: a charge can make a window run out before its reset (INF-898)", () => {
    const w = world();
    w.learn();
    // 22% of Grok's week left with 33.9 hours to go lasts at its observed burn.
    const reading = row("grok", "mini-grok", 22);
    expect(effectiveFromProvider(reading, AT).lastsThroughReset).toBe(true);
    expect(w.scores.score(reading, AT, undefined, w.scores.data(AT)).lastsThroughReset).toBe(true);
    // One running task placed there brings the projection short of the reset.
    w.seed("running", "mini");
    w.route("running");
    const scored = w.scores.score(reading, AT, undefined, w.scores.data(AT));
    expect(scored.charge!.windows[0]!.points).toBeGreaterThan(2);
    expect(scored.lastsThroughReset).toBe(false);
    w.db.close();
  });

  it("subtracts metered usage, grows a large task from the conditional average, and releases only after a post-finish reading", () => {
    const w = world();
    w.learn();
    w.seed("running", "mini");
    w.route("running");
    const first = w.scores.score(row(), AT, undefined, w.scores.data(AT)).charge!.windows[0]!
      .points;
    w.log("running", 20, AT - 100);
    const partial = w.scores.score(row(), AT, undefined, w.scores.data(AT)).charge!.windows[0]!
      .points;
    expect(partial).toBeCloseTo(
      (FINISHED.reduce((sum, cost) => sum + cost, 0) / FINISHED.length - 20) * (38 / 290.21),
    );
    w.log("running", 30, AT + 100);
    expect(
      w.scores.score(row(), AT + 100, undefined, w.scores.data(AT + 100)).charge!.windows[0]!
        .points,
    ).toBeGreaterThan(partial);
    w.tasks.close("running", { status: "done", reason: "finished", actor: "host" });
    expect(
      w.scores.score(row(), AT, undefined, w.scores.data(AT)).charge!.windows[0]!.points,
    ).toBeGreaterThan(0);
    w.scores.observe("mini", snapshot(AT + 200, [row("grok", "mini-grok", 18)]));
    expect(
      w.scores.score(row("grok", "mini-grok", 18), AT + 200, undefined, w.scores.data(AT + 200))
        .charge!.windows[0]!.points,
    ).toBe(0);
    w.db.close();
  });

  it("can rank a charged allowance below zero without exhausting it or changing a pin", () => {
    vi.useFakeTimers();
    vi.setSystemTime(AT);
    const w = world();
    w.learn();
    for (let i = 0; i < 12; i++) {
      w.seed(`placed-${i}`, "mini");
      w.route(`placed-${i}`);
    }
    const rows = [row()];
    const catalog = buildModelsCatalog([GROK], rows, new Date(AT).toISOString(), AT);
    const router = new Router({
      settings: w.settings,
      decisions: w.decisions,
      placedWork: w.scores,
      quota: { latestModels: () => catalog, latest: () => snapshot(AT, rows) } as QuotaService,
      availableModels: () => [GROK],
    });
    expect(
      router.decide(
        "next",
        "Build",
        { kind: "implement", basis_verified: true },
        { placed: w.scores.data(AT) },
      )!.choice,
    ).toMatchObject({ provider: "xai" });
    expect(
      router.decide(
        "pin",
        "Build",
        { kind: "unclear", override_model_id: GROK.id },
        { placed: w.scores.data(AT) },
      )!.choice,
    ).toMatchObject({ provider: "xai" });
    w.db.close();
  });
  // Regression: the responsiveness repair must preserve ordered commitment for simultaneous starts.
  it.each(["existing", "new"] as const)(
    "orders nine simultaneous %s task starts through the committed placed-work score",
    async (state) => {
      vi.useFakeTimers();
      vi.setSystemTime(AT);
      let w: ReturnType<typeof world> | undefined;
      const h = setup(fakeCrewmate(), {
        realRouter: (db) => {
          const record = world(FINISHED, GROK, "medium", db);
          w = record;
          record.learn();
          const rows = [row("grok", "home-grok"), row("codex", "home-codex", 84)];
          return new Router({
            settings: record.settings,
            decisions: record.decisions,
            placedWork: record.scores,
            quota: {
              latestModels: () =>
                buildModelsCatalog([GROK, CODEX], rows, new Date(AT).toISOString(), AT),
              latest: () => snapshot(AT, rows),
            } as QuotaService,
            availableModels: () => [GROK, CODEX],
          });
        },
      });
      if (!w || !h.router) throw new Error("normal placement needs its real routing owner");
      const ids = Array.from({ length: 9 }, (_, index) => `normal-${index}`);
      if (state === "existing")
        for (const id of ids) seedTask(h.tasks, { id, title: "Audit", status: "queued" });
      const shape = { kind: "implement", basis: "plan", basis_verified: true } as const;
      const routed = await Promise.all(
        ids.map((id) =>
          h.supervisor.placement.routeTask(
            id,
            "Audit",
            shape,
            null,
            undefined,
            state === "new"
              ? () => {
                  seedTask(h.tasks, { id, title: "Audit", status: "queued" });
                }
              : undefined,
          ),
        ),
      );
      expect(routed.map((route) => route?.choice?.provider)).toEqual([
        GROK.provider,
        ...ids.slice(1).map(() => CODEX.provider),
      ]);
      const failed = h.router.inOrder(async () => {
        throw new Error("placement refused");
      });
      const next = h.router.inOrder(async () => "next placement");
      await expect(failed).rejects.toThrow("placement refused");
      await expect(next).resolves.toBe("next placement");
      await h.supervisor.disposeAll();
      w.db.close();
    },
  );

  it("concurrent Automatic starts see the first committed charge before either attaches to an account", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(AT);
    const w = world();
    w.learn();
    const rows = [row("grok", "home-grok"), row("codex", "home-codex", 84)];
    const catalog = buildModelsCatalog([GROK, CODEX], rows, new Date(AT).toISOString(), AT);
    const router = new Router({
      settings: w.settings,
      decisions: w.decisions,
      placedWork: w.scores,
      quota: { latestModels: () => catalog, latest: () => snapshot(AT, rows) } as QuotaService,
      availableModels: () => [GROK, CODEX],
    });
    const work = { onWorkDevice: () => () => {}, inReach: () => false } as unknown as WorkDevices;
    let sequence = 0;
    const resources = new ComputerResources({
      work,
      now: () => AT,
      local: {
        read: async () => ({
          epoch: "4f0c2a8e-6b1d-4c3e-9a57-2d8f1e0b7c64",
          sequence: ++sequence,
          status: "sampled",
          sampleMs: 250,
          cpu: { logicalCpus: 10, idleFraction: 0.77 },
          memory: {
            totalBytes: 25165824 * 1024,
            freeBytes: 356672 * 1024,
            purgeableBytes: 335184 * 1024,
            fileBackedBytes: 6852624 * 1024,
          },
        }),
      },
    });
    const feed = new ComputerResourceFeed({
      resources,
      computers: () => [{ computerId: null, label: "This computer" }],
      onComputers: () => () => {},
      onContact: () => () => {},
      emit: () => {},
      now: () => AT,
    });
    const repo = {
      id: "repo",
      name: "Audit",
      path: "/projects/audit",
      setupKind: "clone",
      kind: "project",
      origin: "https://github.com/o/audit.git",
      host: { kind: "github", name: "github.com" },
      delivery: "direct-pr",
      autonomy: false,
      rigor: null,
      runsOn: AUTOMATIC_COMPUTER,
      placementRequirements: { systems: ["macos"], chips: ["arm64"] },
    } as RepoView;
    const placement = new AutomaticPlacement({
      tasks: w.tasks,
      resources: feed,
      work,
      devices: () => [],
      router,
      repo: () => repo,
      catalog: () => [GROK, CODEX],
      now: () => AT,
      running: () => false,
      localFacts: async () => ({
        system: "macos",
        chip: "arm64",
        physicalComputerId: "a".repeat(64),
        tools: { git: "available" },
        projectAccess: "available",
      }),
    });
    try {
      const first = seedTask(w.tasks, { id: "auto-first", title: "Audit first", status: "queued" });
      const second = seedTask(w.tasks, {
        id: "auto-second",
        title: "Audit second",
        status: "queued",
      });
      const shape = { kind: "implement", basis: "plan", basis_verified: true } as const;
      await Promise.all([
        placement.choose(first, repo, first.title, shape),
        placement.choose(second, repo, second.title, shape),
      ]);
      expect(w.decisions.latestRouting(first.id)?.provider).toBe("xai");
      expect(w.decisions.latestRouting(second.id)?.provider).toBe("openai-codex");
      expect(w.tasks.get(first.id)?.accountId).toBeNull();
      console.log(
        JSON.stringify({
          scenario: "concurrent Automatic starts before account attachment",
          first: w.decisions.latestRouting(first.id),
          second: w.decisions.latestRouting(second.id),
        }),
      );
    } finally {
      placement.dispose();
      feed.dispose();
      w.db.close();
    }
  });

  it.each([4, 5])(
    "needs five finished samples, widening model/level groups before charging (%s samples)",
    (count) => {
      const w = world(FINISHED.slice(0, count), GROK, "high");
      w.learn();
      w.seed("new", "mini");
      w.route("new", { ...GROK, id: "grok-4.3" });
      const points = w.scores.score(row(), AT, undefined, w.scores.data(AT)).charge!.windows[0]!
        .points;
      expect(points > 0).toBe(count >= 5);
      w.db.close();
    },
  );

  it("keeps Claude logins separate and learns each window independently", () => {
    const w = world(FINISHED, { ...GROK, provider: "anthropic-claude", id: "claude-fable-5-1" });
    const claude = (accountId: string, account: string, remaining: number): QuotaProviderView => ({
      ...row("claude", accountId, remaining),
      account,
      windows: [
        { ...row().windows[0]!, id: "seven_day", percentRemaining: remaining },
        {
          ...row().windows[0]!,
          id: "five_hour",
          percentRemaining: remaining,
          windowSeconds: 18000,
          resetsAtMs: AT + 3600000,
        },
      ],
    });
    w.scores.observe(
      "home",
      snapshot(AT - 1000, [
        claude("c1", "one@example.com", 80),
        claude("c2", "two@example.com", 80),
      ]),
    );
    w.usage.record({
      taskId: "firstmate",
      accountId: "c1",
      model: { provider: "anthropic-claude", id: "claude-fable-5-1" },
      usage: { cost: 60 },
      at: AT - 500,
    });
    const one = claude("c1", "one@example.com", 74);
    one.windows[1]!.percentRemaining = 77;
    const two = claude("c2", "two@example.com", 80);
    w.scores.observe("home", snapshot(AT, [one, two]));
    w.seed("claude-work");
    w.route("claude-work", { ...GROK, provider: "anthropic-claude", id: "claude-fable-5-1" });
    // Bind through the task owner; the other login must not inherit this work.
    w.tasks.starts.dispatch("claude-work", {
      workspace: { repoDir: "", worktreeDir: "", branch: "" },
      accountId: "c1",
      assignee: "crewmate",
    });
    const first = w.scores.score(one, AT, undefined, w.scores.data(AT)).charge!.windows;
    expect(first[0]!.pointsPerDollar).toBeCloseTo(0.1);
    expect(first[1]!.pointsPerDollar).toBeCloseTo(0.05);
    expect(first[0]!.points).toBeCloseTo(first[1]!.points * 2);
    expect(
      w.scores
        .score(two, AT, undefined, w.scores.data(AT))
        .charge!.windows.every((window) => window.points === 0),
    ).toBe(true);
    w.db.close();
  });

  it("account selection records the charge and still uses actual headroom for the flagship reserve", async () => {
    const w = world();
    w.learn();
    w.seed("placed", "mini");
    w.route("placed");
    const selector = new AccountSelector({
      decisions: w.decisions,
      placedWork: w.scores,
      quota: { latest: () => snapshot(AT, [row()]) },
      flagshipAccountId: () => null,
      pool: {
        list: () => [{ id: "mini-grok", providerId: "xai", label: "Grok", enabled: true }],
        connectedSync: () => true,
        withheldReason: () => undefined,
        pinnedAccount: () => undefined,
        markSelected: () => {},
      },
    });
    expect(await selector.selectForSpawn("next", "xai")).toBe("mini-grok");
    const saved = w.db.prepare("SELECT facts_json FROM decisions WHERE kind = 'account'").get() as {
      facts_json: string;
    };
    const candidate = JSON.parse(saved.facts_json).candidates[0];
    expect(candidate.percentRemaining).toBe(19);
    expect(candidate.charge.windows[0].points).toBeGreaterThan(0);
    w.db.close();
  });
  it("a fresh unpriced allowance keeps the old twelve-task order, without a one-task restriction", () => {
    vi.useFakeTimers();
    vi.setSystemTime(AT);
    const w = world();
    const rows = [row(), row("codex", "mini-codex", 84)];
    w.scores.observe("mini", snapshot(AT, rows));
    const catalog = buildModelsCatalog([GROK, CODEX], rows, new Date(AT).toISOString(), AT);
    const router = new Router({
      settings: w.settings,
      decisions: w.decisions,
      placedWork: w.scores,
      quota: { latestModels: () => catalog, latest: () => snapshot(AT, rows) } as QuotaService,
      availableModels: () => [GROK, CODEX],
    });
    for (let i = 0; i < 12; i++) {
      const id = `cold-${i}`;
      w.seed(id, "mini");
      expect(
        router.decide(
          id,
          "Build",
          { kind: "implement", basis_verified: true },
          { placed: w.scores.data(AT) },
        )?.choice?.provider,
      ).toBe("xai");
    }
    expect(w.settings.getAllowancePrices()).toEqual({});
    w.db.close();
  });

  it("waits for three points of observed drop, not just a positive drop", () => {
    const w = world();
    w.scores.observe("mini", snapshot(AT - 1000, [row("grok", "mini-grok", 22)]));
    w.log("firstmate", 60, AT - 500);
    w.scores.observe("mini", snapshot(AT, [row("grok", "mini-grok", 20)]));
    expect(w.settings.getAllowancePrices()).toEqual({});
    w.scores.observe("mini", snapshot(AT + 1, [row()]));
    expect(Object.values(w.settings.getAllowancePrices())).toEqual([3 / 60]);
    w.db.close();
  });

  // INF-1714: an estimate of placed work orders candidates inside a band and
  // never moves one between bands; only a fresh reading can.
  it("keeps a charged allowance in the band of its unadjusted reading", () => {
    const w = world();
    w.learn();
    const reading = row("grok", "mini-grok", 22);
    w.seed("running", "mini");
    w.route("running");
    const scored = w.scores.score(reading, AT, undefined, w.scores.data(AT));
    expect(scored.lastsThroughReset).toBe(false);
    expect(scored.band).toBe("room");
    expect(w.scores.score(row("grok", "mini-grok", 9), AT, undefined, w.scores.data(AT)).band).toBe(
      "near_floor",
    );
    w.db.close();
  });

  // INF-2056 (the captain's app froze for seconds every few seconds): one
  // preview read the finished tasks again for every account of every model.
  it("reads placed and finished work once per routing preview, however many accounts and models", () => {
    const w = world();
    w.learn();
    w.seed("running", "mini");
    w.route("running");
    const models = [GROK, { ...GROK, id: "grok-4.3" }, { ...GROK, id: "grok-4.1" }];
    const rows = [row("grok", "home-grok", 84), row("grok", "mini-grok", 19)];
    const catalog = buildModelsCatalog(models, rows, new Date(AT).toISOString(), AT);
    const accounts = new AccountSelector({
      decisions: w.decisions,
      placedWork: w.scores,
      quota: { latest: () => snapshot(AT, rows) },
      flagshipAccountId: () => null,
      pool: {
        list: () =>
          ["home-grok", "mini-grok"].map((id) => ({
            id,
            providerId: "xai",
            label: id,
            enabled: true,
          })),
        connectedSync: () => true,
        withheldReason: () => undefined,
        pinnedAccount: () => undefined,
        markSelected: () => {},
      },
    });
    const router = new Router({
      settings: w.settings,
      decisions: w.decisions,
      placedWork: w.scores,
      quota: { latestModels: () => catalog, latest: () => snapshot(AT, rows) } as QuotaService,
      availableModels: () => models,
      crewAccount: (provider, model, placed) => accounts.crewAccount(provider, model, placed),
    });
    const reads = w.scores as unknown as { work(): unknown; finished(now: number): unknown };
    const work = vi.spyOn(reads, "work");
    const finished = vi.spyOn(reads, "finished");
    // INF-2255: one routing preview must not read identical usage totals or
    // allowance prices again for each model and its account selection.
    const score = vi.spyOn(w.scores, "score");
    const prices = vi.spyOn(w.settings, "getAllowancePrices");
    const statement = Object.getPrototypeOf(w.db.prepare("SELECT 1"));
    const originalGet = statement.get;
    const sums = new Map<string, number>();
    statement.get = function (this: { source: string }, ...args: unknown[]) {
      if (this.source.includes("SUM(cost) AS logged")) {
        const key = JSON.stringify(args);
        sums.set(key, (sums.get(key) ?? 0) + 1);
      }
      return originalGet.apply(this, args);
    };
    try {
      const preview = router.preview(
        "Build",
        { kind: "implement", basis_verified: true },
        { placed: w.scores.data(AT) },
      );
      expect(preview?.result.choice?.provider).toBe("xai");
      expect(finished).toHaveBeenCalledTimes(1);
      expect(work).toHaveBeenCalledTimes(1);
      console.info(
        JSON.stringify({
          intent: "INF-2255 routing evaluation reads",
          models: models.length,
          accounts: rows.length,
          workReads: work.mock.calls.length,
          finishedReads: finished.mock.calls.length,
          scoreCalls: score.mock.calls.length,
          priceReads: prices.mock.calls.length,
          usageReads: [...sums.values()].reduce((a, b) => a + b, 0),
          uniqueUsageReads: sums.size,
          repeatsPerUsageRead: [...new Set(sums.values())],
          preview,
        }),
      );
      expect(sums.size).toBe(FINISHED.length + 1);
      expect([...sums.values()]).toEqual([...sums].map(() => 1));
      expect(prices).toHaveBeenCalledTimes(1);
      // A later evaluation sees new usage, rather than reusing this one's charge.
      const before = preview?.candidates?.[0]?.charge?.windows[0]?.points;
      w.log("running", Math.max(...FINISHED) + 1, AT + 1);
      const next = router.preview(
        "Build",
        { kind: "implement", basis_verified: true },
        { placed: w.scores.data(AT) },
      );
      expect(next?.candidates?.[0]?.charge?.windows[0]?.points).toBeGreaterThan(before!);
    } finally {
      statement.get = originalGet;
      score.mockRestore();
      prices.mockRestore();
      work.mockRestore();
      finished.mockRestore();
      w.db.close();
    }
  });

  // INF-1714: the model is ranked by the account that will serve it, so the
  // model ranking and the account binding read the same reading.
  it("ranks a model by the account bound to serve it, and saves which one", () => {
    const w = world();
    const rows = [row("grok", "home-grok", 84), row("grok", "mini-grok", 19)];
    w.scores.observe("home", snapshot(AT, rows));
    const [best] = w.scores.catalog(
      [{ provider: "grok", id: GROK.id, label: "Grok" }],
      rows,
      AT,
      undefined,
      w.scores.data(AT),
    );
    expect(best).toMatchObject({ accountId: "home-grok", effectivePercentRemaining: 84 });
    const [bound] = w.scores.catalog(
      [{ provider: "grok", id: GROK.id, label: "Grok" }],
      rows,
      AT,
      () => "mini-grok",
      w.scores.data(AT),
    );
    expect(bound).toMatchObject({
      accountId: "mini-grok",
      effectivePercentRemaining: 19,
      measuredAt: AT,
      resetsAtMs: rows[1]!.windows[0]!.resetsAtMs,
    });
    w.db.close();
  });

  // INF-5438 round 11 finding 5: a model is ranked only by the account bound
  // to serve it; when that account has no reading, its allowance stays
  // unknown and never borrows a spent sibling's, which would drop the model.
  it("leaves a model unranked when the account bound to serve it has no reading of its own", () => {
    const w = world();
    const rows = [row("grok", "home-grok", 0)];
    w.scores.observe("home", snapshot(AT, rows));
    const [model] = buildModelsCatalog([GROK], rows, new Date(AT).toISOString(), AT).models;
    if (!model) throw new Error("The catalog lists Grok.");
    expect(model.effectivePercentRemaining).toBe(0);
    const [unread] = w.scores.catalog([model], rows, AT, () => "mini-grok", w.scores.data(AT));
    expect(unread).toEqual({ provider: "grok", id: GROK.id, label: GROK.name });
    const [spent] = w.scores.catalog([model], rows, AT, () => "home-grok", w.scores.data(AT));
    expect(spent).toMatchObject({ accountId: "home-grok", effectivePercentRemaining: 0 });
    w.db.close();
  });

  // The captain's ask: where a provider's own logins pool, the pool orders
  // its models and the login in use decides whether one can start now
  // (docs/quota.md, "A pool of your own logins").
  it("ranks a model by its provider's pool of logins, served by the bound login", () => {
    const w = world();
    const rows = [row("codex", "home-codex", 84), row("codex", "work-codex", 8)];
    w.scores.observe("home", snapshot(AT, rows));
    const pools = accountPools(
      rows,
      rows.map((each) => ({ accountId: each.accountId ?? "", provider: each.provider })),
      AT,
    );
    const model = { provider: "codex", id: CODEX.id, label: "Codex" };
    const rank = (boundId: string, pooled: boolean, readings = rows) =>
      w.scores.catalog(
        [model],
        readings,
        AT,
        () => boundId,
        w.scores.data(AT),
        pooled ? pools : undefined,
      )[0];

    // Alone, the login in use is near its floor.
    expect(rank("work-codex", false)).toMatchObject({
      accountId: "work-codex",
      effectivePercentRemaining: 8,
      band: "near_floor",
    });
    // Pooled, the model has (84 + 8) / 2 left and leaves the near-floor band;
    // the login in use still names who serves and until when.
    const pooled = rank("work-codex", true);
    expect(pooled).toMatchObject({
      accountId: "work-codex",
      effectivePercentRemaining: 46,
      resetsAtMs: rows[1]!.windows[0]!.resetsAtMs,
    });
    expect(pooled?.band).not.toBe("near_floor");
    // Whichever login is in use, the pool ranks the model the same.
    expect(rank("home-codex", true)?.effectivePercentRemaining).toBe(46);

    // A spent login in use keeps its own reading: nothing starts on it.
    const spent = [row("codex", "home-codex", 84), row("codex", "work-codex", 0)];
    expect(rank("work-codex", true, spent)).toMatchObject({
      accountId: "work-codex",
      effectivePercentRemaining: 0,
    });
    w.db.close();
  });

  // The review's ask: the pool orders a model, and the login in use alone
  // decides whether it can start and whether it is paid from credits.
  it("leaves whether a pooled model can start, and its credits, to the login in use", () => {
    const w = world();
    const model = { provider: "codex", id: CODEX.id, label: "Codex" };
    const rank = (rows: QuotaProviderView[], boundId: string) =>
      w.scores.catalog(
        [model],
        rows,
        AT,
        () => boundId,
        w.scores.data(AT),
        accountPools(
          rows,
          rows.map((each) => ({ accountId: each.accountId ?? "", provider: each.provider })),
          AT,
        ),
      )[0];

    // The login in use is spent and answers on credits: it stays a credits
    // pick, read from itself, though the pool has (84 + 0) / 2 left.
    const credited: QuotaProviderView = {
      ...row("codex", "work-codex", 0),
      keepGoingOnCredits: true,
      credits: { state: "available" },
    };
    expect(rank([row("codex", "home-codex", 84), credited], "work-codex")).toMatchObject({
      accountId: "work-codex",
      effectivePercentRemaining: 0,
      onCredits: true,
    });

    // The other login alone reports this model's own window, used up. The
    // pooled window reads 0, yet the login in use has 60 left for the model:
    // the model has (0 + 60) / 2 left and is not spent.
    const home = row("codex", "home-codex", 84);
    const modelSpent: QuotaProviderView = {
      ...home,
      windows: [...home.windows, { id: "model:sol", label: "Sol", percentRemaining: 0 }],
    };
    expect(rank([modelSpent, row("codex", "work-codex", 60)], "work-codex")).toMatchObject({
      accountId: "work-codex",
      effectivePercentRemaining: 30,
    });
    w.db.close();
  });
  // The approved plan for several logins of one provider, piece 3, "Login
  // in use": under wait and ask only the pin serves, so a model the pin
  // cannot serve is not available on a sibling's reading.
  it("leaves a model no account may serve unranked, never on a sibling's reading", () => {
    const w = world();
    const rows = [row("grok", "home-grok", 84)];
    w.scores.observe("home", snapshot(AT, rows));
    const [model] = buildModelsCatalog([GROK], rows, new Date(AT).toISOString(), AT).models;
    if (!model) throw new Error("The catalog lists Grok.");
    const [blocked] = w.scores.catalog([model], rows, AT, () => null, w.scores.data(AT));
    expect(blocked).toEqual({ provider: "grok", id: GROK.id, label: GROK.name });
    w.db.close();
  });

  it.each([
    ["ask", undefined],
    ["spread", "xai"],
  ] as const)(
    "under %s, routes a model whose login in use does not list it to %s",
    (choice, provider) => {
      const w = world();
      const rows = [row("grok", "home-grok", 84), row("grok", "mini-grok", 60)];
      const catalog = buildModelsCatalog([GROK], rows, new Date(AT).toISOString(), AT);
      const accounts = new AccountSelector({
        decisions: w.decisions,
        placedWork: w.scores,
        quota: { latest: () => snapshot(AT, rows) },
        flagshipAccountId: () => null,
        pool: {
          list: () =>
            ["home-grok", "mini-grok"].map((id) => ({
              id,
              providerId: "xai",
              label: id,
              enabled: true,
            })),
          connectedSync: () => true,
          withheldReason: () => undefined,
          // The login in use is the one whose sign-in lists another model.
          pinnedAccount: () => "mini-grok",
          markSelected: () => {},
        },
        accountModels: () => [
          { accountId: "home-grok", models: [{ provider: "xai", id: GROK.id }] },
          { accountId: "mini-grok", models: [{ provider: "xai", id: "grok-4.1" }] },
        ],
        loginInUse: { whenLow: () => choice, pin: () => {} },
      });
      const router = new Router({
        settings: w.settings,
        decisions: w.decisions,
        placedWork: w.scores,
        quota: { latestModels: () => catalog, latest: () => snapshot(AT, rows) } as QuotaService,
        availableModels: () => [GROK],
        crewAccount: (piProvider, model, placed) => accounts.crewAccount(piProvider, model, placed),
      });
      const preview = router.preview(
        "Build",
        { kind: "implement", basis_verified: true },
        { placed: w.scores.data(AT) },
      );
      expect(preview?.result.choice?.provider).toBe(provider);
      w.db.close();
    },
  );
});
