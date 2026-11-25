import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACTION_NAMES, ACTIONS } from "@shared/actions";
import { SCHEDULE_DETAILS } from "@shared/automation";
import type { FmEvent } from "@shared/events";
import { feedLineFrom } from "@shared/feed";
import { englishOf, said } from "@shared/i18n/said";
import { type KeymapSnapshot, keymapSnapshot } from "@shared/keymap";
import { PANEL_SETTING_NAMES } from "@shared/panelSettingNames";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeHost, quotaFixture } from "../../tests/helpers/bootedCore";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { ForgeSignInStore } from "./forge/signIns";
import { type Core, startCore } from "./index";
import { automationWords } from "./orchestrator/scheduler";
import { createAppTools } from "./pi/appTools";
import { catalogRefreshesSettled } from "./pi/modelRuntime";
import { NO_PLACED_TASK } from "./placed/placedWork";
import { keptJobsAt } from "./tasks/keptJobs";
import { seedTask } from "./tasks/seedTask";
import { keptRoot } from "./tasks/taskStops";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("./utilityQos", async (importOriginal) =>
  (await import("../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

describe("the core, driven with no Electron in the process", () => {
  let userDataDir: string;
  let core: Core;
  let shell: ReturnType<typeof fakeHost>;

  beforeAll(async () => {
    userDataDir = scratchDir("infinitary-core-");
    // The same isolation e2e uses: no pi.dev catalog fetch, quota off files.
    process.env.PI_OFFLINE = "1";
    quotaFixture("infinitary-core-quota-", [
      {
        provider: "codex",
        label: "Codex",
        status: "ok",
        stale: false,
        windows: [{ id: "weekly", label: "weekly", percentRemaining: 62 }],
      },
    ]);
    shell = fakeHost(userDataDir);
    core = await startCore(shell.host);
  }, 60_000);

  afterAll(async () => {
    // Keep userData until the core has shut down and its background writes
    // have landed: removing it under a late write fails with ENOTEMPTY.
    await core?.dispose();
    await core?.services.workspace.poolSettled();
    await core?.services.workspace.deletionsSettled();
    await catalogRefreshesSettled();
    rmSync(userDataDir, { recursive: true, force: true });
    delete process.env.INFINITARY_QUOTA_FIXTURE_DIR;
  });

  it("answers the handshake from the host's own build identity", async () => {
    const health = await core.dispatch("inf:app:healthcheck", []);
    expect(health.ok).toBe(true);
    expect(health.version).toBe("9.9.9");
    expect(health.platform).toBe("test-os");
    expect(health.protocolVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("answers a work request only for a computer that runs work, and refuses it while no task runs on one", async () => {
    const report = [{ task: "t1", callId: "call-1", text: "Done." }];
    const device = { kind: "device" as const, deviceId: "mini" };
    // The window, Firstmate's own tools and a paired view ask as the captain or Firstmate.
    await expect(core.dispatch("inf:work:report", report)).rejects.toThrow(
      "asked only by a computer that runs work",
    );
    await expect(core.dispatch("inf:work:report", report, device)).rejects.toThrow(NO_PLACED_TASK);
    await expect(core.dispatch("inf:work:report", [{ task: "t1" }], device)).rejects.toThrow(
      "Rejected inf:work:report: malformed request",
    );
    await expect(core.dispatch("inf:app:healthcheck", [], device)).rejects.toThrow(
      "not a request a computer that runs work asks",
    );
  });

  it("persists dictation through validated dispatch and publishes the saved choice", async () => {
    const pushes: unknown[] = [];
    const detach = core.events.subscribe((channel, payload) => {
      if (channel === "inf:settings:dictation") pushes.push(payload);
    });
    expect(await core.dispatch("inf:settings:dictation:get", [])).toEqual({
      enabled: true,
      key: "AltRight",
    });
    const off = { enabled: false, key: "MetaRight" };
    await expect(
      core.dispatch("inf:settings:dictation:set", [off], {
        kind: "firstmate",
        wake: "captain",
        evidence: "not catalogued yet",
      }),
    ).rejects.toThrow("outside its action catalog");
    expect(await core.dispatch("inf:settings:dictation:get", [])).toEqual({
      enabled: true,
      key: "AltRight",
    });
    expect(await core.dispatch("inf:settings:dictation:set", [off])).toEqual(off);
    expect(await core.dispatch("inf:settings:dictation:get", [])).toEqual(off);
    expect(pushes).toEqual([off]);
    await expect(
      core.dispatch("inf:settings:dictation:set", [{ enabled: true, key: "KeyA" }]),
    ).rejects.toThrow("malformed request");
    await core.dispatch("inf:settings:dictation:set", [{ enabled: true, key: "AltRight" }]);
    detach();
  });

  // INF-6693's plan: Settings saves where long conversations summarize, and
  // the core refuses a point Settings does not offer.
  it("saves the summary point through validated dispatch and refuses one Settings does not offer", async () => {
    expect((await core.dispatch("inf:settings:summary-point:get", [])).point).toBe("automatic");
    expect((await core.dispatch("inf:settings:summary-point:set", [200_000])).point).toBe(200_000);
    expect((await core.dispatch("inf:settings:summary-point:get", [])).point).toBe(200_000);
    await expect(core.dispatch("inf:settings:summary-point:set", [250_000])).rejects.toThrow(
      "malformed request",
    );
    expect((await core.dispatch("inf:settings:summary-point:set", ["model"])).point).toBe("model");
    await core.dispatch("inf:settings:summary-point:set", ["automatic"]);
  });

  // INF-5326's approved piece 4: a panel reads the settings the action
  // catalog gives a panel value, cut to that value, and no other line.
  it("answers a panel's settings read with each line's panel value, refusing a line without one", async () => {
    const look = await core.dispatch("inf:settings:appearance:get", []);
    const layout = await core.dispatch("inf:settings:layout:get", []);
    await core.dispatch("inf:settings:appearance:set", [
      {
        ...look,
        theme: "light",
        ambientMusic: true,
        ambientStyle: "quiet-cove",
        ambientVolume: 25,
      },
    ]);
    // A hidden panel rides the same preferences the panels switch reads.
    await core.dispatch("inf:settings:layout:set", [
      { ...layout, hiddenPanels: { ...layout.hiddenPanels, activity: true } },
    ]);
    const read = await core.dispatch("inf:settings:current", [
      ["ambient-music", "theme", "panels-switch"],
    ]);
    expect(read).toEqual({
      "ambient-music": { on: true, paused: false, style: "quiet-cove", volume: 25 },
      theme: { theme: "light" },
      "panels-switch": {
        enabled: (await core.dispatch("inf:shell:preferences", [])).panels.enabled,
      },
    });
    // Every readable line at once is exactly its panel value: none of what sits
    // beside it in the answer it was read from (a hidden panel's id, the
    // language, the cost limit's recent tasks) reaches a panel.
    const notifications = await core.dispatch("inf:settings:notifications:get", []);
    const resources = await core.dispatch("inf:settings:personal-resources:get", []);
    const limit = await core.dispatch("inf:settings:cost-limit:get", []);
    await core.dispatch("inf:settings:appearance:set", [
      {
        ...(await core.dispatch("inf:settings:appearance:get", [])),
        language: "fr",
        fonts: { reading: "Iowan Old Style" },
        washStrength: 30,
        size: 110,
        showCrewModelNames: false,
      },
    ]);
    await core.dispatch("inf:settings:notifications:set", [false]);
    await core.dispatch("inf:settings:personal-resources:set", [true]);
    await core.dispatch("inf:settings:cost-limit:set", [{ usd: 75 }]);
    const all = await core.dispatch("inf:settings:current", [[...PANEL_SETTING_NAMES]]);
    expect(all).toEqual({
      theme: { theme: "light" },
      font: { fonts: { reading: "Iowan Old Style" } },
      "window-wash": { strength: 30 },
      "window-size": { size: 110 },
      "crew-model-names": { visible: false },
      "ambient-music": { on: true, paused: false, style: "quiet-cove", volume: 25 },
      notifications: { enabled: false },
      "cost-limit": { limit: { usd: 75 } },
      "personal-resources": { enabled: true },
      "panels-switch": {
        enabled: (await core.dispatch("inf:shell:preferences", [])).panels.enabled,
      },
    });
    await core.dispatch("inf:settings:notifications:set", [notifications]);
    await core.dispatch("inf:settings:personal-resources:set", [resources]);
    await core.dispatch("inf:settings:cost-limit:set", [limit.limit]);
    // A line with no panel value is refused, and so is one the catalog lacks.
    for (const name of ["project-settings", "firstmate-account", "dictation", "nothing-at-all"])
      await expect(core.dispatch("inf:settings:current", [[name]])).rejects.toThrow(
        "malformed request",
      );
    await core.dispatch("inf:settings:appearance:set", [look]);
    await core.dispatch("inf:settings:layout:set", [layout]);
  });

  // INF-3112's approved second piece: the captain can change the app and
  // project limits by talking, and each task record reads the winning limit.
  it("changes cost limits through the first mate action and reads them in task records", async () => {
    const original = await core.dispatch("inf:settings:cost-limit:get", []);
    const change = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake: "captain" }),
    }).find((tool) => tool.name === "app_change");
    if (!change) throw new Error("Missing app_change");
    const created = await core.services.repos.setup({ kind: "init", name: "cost-settings" });
    const task = seedTask(core.services.tasks, {
      id: "cost-record",
      status: "queued",
      title: "Review command search",
      repoId: created.repo.id,
      startPolicy: "on-request",
    });
    try {
      const changed = await change.run({
        action: "cost-limit",
        value: { limit: { usd: 75 } },
        evidence: "Ask me after a task spends $75",
      });
      expect(JSON.parse(changed.text).current).toEqual({ limit: { usd: 75 } });
      expect((await core.dispatch("inf:tasks:detail", [task.id])).cost).toEqual({
        usd: 0,
        unpriced: 0,
        limit: { usd: 75 },
        source: "app",
      });
      await change.run({
        action: "cost-limit",
        value: { limit: { none: true } },
        evidence: "Do not ask about cost by default",
      });
      expect((await core.dispatch("inf:tasks:detail", [task.id])).cost?.limit).toEqual({
        none: true,
      });
      const setProject = (costLimit: unknown) =>
        change.run({
          action: "project-settings",
          value: { repoId: created.repo.id, changes: { costLimit } },
          evidence: "Set this project's cost limit",
          on_words: true,
        });
      const projectChange = await setProject({ usd: 25 });
      expect(
        JSON.parse(projectChange.text).current.projects.find(
          (project: { id: string }) => project.id === created.repo.id,
        ).costLimit,
      ).toEqual({ usd: 25 });
      expect((await core.dispatch("inf:tasks:detail", [task.id])).cost).toMatchObject({
        limit: { usd: 25 },
        source: "project",
      });
      await setProject({ none: true });
      expect((await core.dispatch("inf:tasks:detail", [task.id])).cost).toMatchObject({
        limit: { none: true },
        source: "project",
      });
      core.services.supervisor.costLimits.setTaskLimit(task.id, { usd: 100 });
      expect((await core.dispatch("inf:tasks:detail", [task.id])).cost).toMatchObject({
        limit: { usd: 100 },
        source: "task",
      });
      core.services.supervisor.costLimits.setTaskLimit(task.id, null);
      await setProject(null);
      expect((await core.dispatch("inf:tasks:detail", [task.id])).cost).toMatchObject({
        limit: { none: true },
        source: "app",
      });
      const malformed = await change.run({
        action: "cost-limit",
        value: { limit: { usd: -1 } },
        evidence: "Set a negative limit",
      });
      expect(Array.isArray(JSON.parse(malformed.text))).toBe(true);
      expect((await core.dispatch("inf:settings:cost-limit:get", [])).limit).toEqual({
        none: true,
      });
    } finally {
      await core.dispatch("inf:settings:cost-limit:set", [original.limit]);
      core.services.tasks.close(task.id, { status: "dropped", reason: "cancelled", actor: "host" });
      core.services.repos.unregister(created.repo.id);
    }
  });

  // Intent: INF-4421's finding, a bug being fixed: the first mate's Try again on a held batch
  // rebuilt it and then answered with an error, because its confirmation read the request
  // from the held batches read back afterwards. The captain's direction lets the first mate
  // try a held batch again on its own judgment.
  it("confirms a held batch's answer by what was asked, from the first mate's judgment and from Settings", async () => {
    const change = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake: "other" }),
    }).find((tool) => tool.name === "app_change");
    if (!change) throw new Error("Missing app_change");
    const created = await core.services.repos.setup({ kind: "init", name: "held-batch" });
    const repoId = created.repo.id;
    const member = {
      taskId: "batch-member",
      branch: "fm/task-batch-member",
      head: "5f0c2a9e41b7d3c8a6e2f9b0d4c1a7e3b8f6d2c0",
      title: "fix(parser): read dates with a time zone",
      body: "",
      at: 1_000,
      commit: "1111111111111111111111111111111111111111",
    };
    const open = {
      branch: "infinitary-batch/3fa9c1d2",
      head: member.commit,
      base: "9d1c7e2a4b6f8091a3c5e7d9f1b3a5c7e9d1f3b5",
      number: 31,
      members: [member],
      since: 1_000,
    };
    const holdAt = (head: string) => {
      core.services.repos.recordBatch(repoId, {
        line: [],
        receipts: [],
        leftOut: [],
        open: {
          ...open,
          head,
          hold: { at: 2_000, head, reason: "checks", checks: ["unit-tests"] },
        },
      });
    };
    // The stand-in for the combine and push the answer runs where the project lives: the hold ends.
    const answered = vi
      .spyOn(core.services.batches, "answerOrThrow")
      .mockImplementation(async (id) => {
        core.services.repos.recordBatch(id, { line: [], receipts: [], leftOut: [], open });
        return { ok: true };
      });
    const titles = () =>
      core.services.tasks
        .list()
        .filter((task) => task.kind === "operation")
        .map((task) => task.title);
    try {
      holdAt(member.commit);
      const retried = await change.run({
        action: "project-batch-answer",
        value: { repoId, answer: { action: "try-again", head: member.commit } },
        evidence: "The failed journey passed three reruns; the batch's changes touch none of it.",
      });
      // Answered as done, with the held batches as they read now: none.
      expect(JSON.parse(retried.text)).toEqual({
        action: "project-batch-answer",
        current: { held: [] },
      });
      expect(titles()).toContain(
        ACTIONS["project-batch-answer"].done({
          repoId,
          answer: { action: "try-again", head: member.commit },
        }),
      );

      const head = "2222222222222222222222222222222222222222";
      holdAt(head);
      const sendBack = {
        action: "send-back" as const,
        head,
        changes: [{ taskId: member.taskId, reason: "its date test fails" }],
      };
      await core.dispatch("inf:repos:batch-answer", [repoId, sendBack]);
      expect(titles()).toContain(
        ACTIONS["project-batch-answer"].done({ repoId, answer: sendBack }),
      );
      expect(answered).toHaveBeenCalledTimes(2);
    } finally {
      answered.mockRestore();
      core.services.repos.unregister(repoId);
    }
  });

  it("tells Firstmate every own-words action from the catalog", () => {
    const change = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake: "captain" }),
    }).find((tool) => tool.name === "app_change");
    const ownWords = change?.description
      .match(/; ([^;]+) need their typed words/)?.[1]
      ?.split(", ");
    expect(ownWords).toEqual([
      "project-remove",
      "panel-remove",
      "integration-remove",
      "delete-outside",
      "forge-sign-out",
      "dictation",
      "account-keep-going",
      "account-use-reset",
      "account-use-saved-resets",
      "account-disconnect",
      "custom-connection-file",
      "projects-folder",
      "panel-retry",
      "private-site-remove",
      "secret-end-read",
    ]);
  });

  it("shares catalog changes, refusals and one trail per actor through the real core", async () => {
    const events: FmEvent[] = [];
    const detach = core.events.subscribe((channel, payload) => {
      if (channel === "inf:event") events.push(payload as FmEvent);
    });
    let wake: "captain" | "scheduled" | "other" = "captain";
    const tools = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake }),
    });
    const change = tools.find((tool) => tool.name === "app_change");
    const state = tools.find((tool) => tool.name === "app_state");
    if (!change || !state) throw new Error("Missing catalog tools");
    const initial = await core.dispatch("inf:settings:notifications:get", []);
    const count = () =>
      core.services.tasks.list().filter((task) => task.kind === "operation").length;
    const before = count();
    await core.dispatch("inf:settings:notifications:set", [!initial]);
    expect(count()).toBe(before + 1);
    expect(events.filter((e) => e.type === "personalized")).toHaveLength(1);
    const result = await change.run({
      action: "notifications",
      value: { enabled: initial },
      evidence: "turn notifications back",
    });
    expect(JSON.parse(result.text).current.enabled).toBe(initial);
    expect(count()).toBe(before + 2);
    expect(events.filter((e) => e.type === "personalized").map((e) => e.actor)).toEqual([
      "captain",
      "firstmate",
    ]);
    const recent = await core.dispatch("inf:feed:recent", []);
    expect(
      recent.some((line) => line.text === `Captain · notifications ${initial ? "off" : "on"}`),
    ).toBe(true);
    expect(
      recent.some((line) => line.text === `First mate · notifications ${initial ? "on" : "off"}`),
    ).toBe(true);
    await change.run({
      action: "notifications",
      value: { enabled: initial },
      evidence: "same value",
    });
    expect(count()).toBe(before + 2);
    // INF-751: his choice, relayed in a crewmate's report, applies on that
    // report's wake and leaves the same trail.
    wake = "other";
    const relayed = await change.run({
      action: "notifications",
      value: { enabled: !initial },
      evidence: 'The captain chose "Turn notifications off" on SCR-1\'s card.',
    });
    expect(JSON.parse(relayed.text).current.enabled).toBe(!initial);
    expect(await core.dispatch("inf:settings:notifications:get", [])).toBe(!initial);
    expect(count()).toBe(before + 3);
    await core.dispatch("inf:settings:notifications:set", [initial]);
    // His typed words in a schedule he set apply an own-words line.
    wake = "scheduled";
    const scheduledFolder = scratchDir("catalog-scheduled-");
    await change.run({
      action: "projects-folder",
      value: { path: scheduledFolder },
      evidence: "Each Monday, keep new projects in the scratch folder.",
    });
    expect((await core.dispatch("inf:repos:folder", [])).path).toBe(scheduledFolder);
    wake = "captain";
    const missing = join(scratchDir("catalog-folder-"), "missing");
    await expect(core.dispatch("inf:repos:folder:set", [missing])).rejects.toThrow(
      `No folder exists at ${missing}.`,
    );
    expect(
      (
        await change.run({
          action: "projects-folder",
          value: { path: missing },
          evidence: "use this folder",
        })
      ).text,
    ).toBe(`No folder exists at ${missing}.`);
    const folder = scratchDir("catalog-projects-");
    await change.run({
      action: "projects-folder",
      value: { path: folder },
      evidence: "keep new projects here",
    });
    expect((await core.dispatch("inf:repos:folder", [])).path).toBe(folder);
    await change.run({
      action: "projects-folder",
      value: { path: null },
      evidence: "restore default",
    });
    const appearance = await core.dispatch("inf:settings:appearance:get", []);
    await change.run({ action: "window-wash", value: { strength: 42 }, evidence: "wash 42" });
    expect(await core.dispatch("inf:settings:appearance:get", [])).toEqual({
      ...appearance,
      washStrength: 42,
    });
    await change.run({
      action: "crew-model-names",
      value: { visible: false },
      evidence: "hide names",
    });
    expect((await core.dispatch("inf:settings:appearance:get", [])).showCrewModelNames).toBe(false);
    // The approved font plan (INF-3982): a person can ask the first mate for a font.
    const fontLines: string[] = [];
    const detachFonts = core.events.subscribe((channel, payload) => {
      const event = payload as FmEvent;
      if (channel === "inf:event" && event.type === "personalized") fontLines.push(event.text);
    });
    await change.run({
      action: "font",
      value: { slot: "code", font: "ui-monospace" },
      evidence: "use my computer's own mono font for code",
    });
    expect((await core.dispatch("inf:settings:appearance:get", [])).fonts).toEqual({
      code: "ui-monospace",
    });
    await change.run({
      action: "font",
      value: { slot: "code", font: null },
      evidence: "put the code font back",
    });
    expect((await core.dispatch("inf:settings:appearance:get", [])).fonts).toBeUndefined();
    // The captain's own pick in Settings writes the whole look; its line names the place and font.
    await core.dispatch("inf:settings:appearance:set", [
      {
        ...(await core.dispatch("inf:settings:appearance:get", [])),
        fonts: { app: "Avenir Next" },
      },
    ]);
    await core.dispatch("inf:settings:appearance:set", [
      { ...(await core.dispatch("inf:settings:appearance:get", [])), fonts: undefined },
    ]);
    detachFonts();
    expect(fontLines.slice(0, 3)).toEqual([
      expect.stringMatching(/code ui-monospace/),
      expect.stringMatching(/Infinitary's own/),
      expect.stringMatching(/app font Infinitary's own → Avenir Next/),
    ]);
    for (const line of fontLines) expect(line).not.toMatch(/undefined/);
    await change.run({
      action: "panel-collapse",
      value: { surface: "activity", collapsed: true },
      evidence: "collapse activity",
    });
    expect((await core.dispatch("inf:settings:layout:get", [])).collapsedPanels.activity).toBe(
      true,
    );
    await expect(
      core.dispatch("inf:settings:sharing:set", ["diagnostics", false], {
        kind: "firstmate",
        wake: "captain",
        evidence: "asked",
      }),
    ).rejects.toThrow(/outside/);
    await expect(
      core.dispatch(
        "inf:settings:appearance:set",
        [{ ...appearance, theme: appearance.theme === "dark" ? "light" : "dark" }],
        { kind: "firstmate", wake: "captain", action: "window-wash", evidence: "wash" },
      ),
    ).rejects.toThrow(/named appearance/);
    expect(
      (
        await change.run({
          action: "notifications",
          value: { enabled: false, extra: true },
          evidence: "asked",
        })
      ).text,
    ).toMatch(/extra/);
    const lines = JSON.parse((await state.run({})).text);
    expect(lines.map((line: { action: string }) => line.action)).toEqual(ACTION_NAMES);
    expect(
      lines.every(
        (line: {
          action: keyof typeof ACTIONS;
          captainAllowed: boolean;
          firstmateAllowed: boolean;
        }) =>
          line.captainAllowed &&
          line.firstmateAllowed ===
            (["asked", "own-words", "judgment"].includes(ACTIONS[line.action].tier) ||
              ACTIONS[line.action].proposes === true),
      ),
    ).toBe(true);
    // INF-638, the captain: "why not just give first mate a tool to freely
    // read and write standing directions, and then rely on the agent's
    // judgment". A direction is a catalog line like any setting, so a turn a
    // crewmate's report began keeps one, with one trail and its reason kept.
    wake = "other";
    const rule = "A fix for a broken main merges on its own once all of its checks pass.";
    const kept = await change.run({
      action: "direction",
      value: { op: "add", id: "fix-merge", text: rule },
      evidence: "The captain chose Save the direction on the crewmate's card.",
    });
    expect(JSON.parse(kept.text).current.directions).toContainEqual(
      expect.objectContaining({ id: "d:fix-merge", text: rule, revision: 1 }),
    );
    expect(
      (await core.dispatch("inf:feed:recent", [])).filter(
        (line) => line.text === `First mate · saved the standing direction "${rule}"`,
      ),
    ).toHaveLength(1);
    expect(await core.dispatch("inf:knowledge:direction", [{ id: "fix-merge" }])).toMatchObject({
      direction: {
        origin: "captain-turn",
        history: [{ evidence: "The captain chose Save the direction on the crewmate's card." }],
      },
    });
    const listed = JSON.parse((await state.run({ area: "general" })).text).find(
      (line: { action: string }) => line.action === "direction",
    );
    expect(listed).toMatchObject({ tier: "judgment", firstmateAllowed: true, allowedNow: true });
    expect(listed.current.directions).toContainEqual(
      expect.objectContaining({ id: "d:fix-merge" }),
    );
    await change.run({
      action: "direction",
      value: { op: "retire", id: "d:fix-merge", expectedRevision: 1 },
      evidence: "The captain retired it.",
    });
    const after = JSON.parse((await state.run({ area: "general" })).text).find(
      (line: { action: string }) => line.action === "direction",
    );
    expect(after.current.directions).not.toContainEqual(
      expect.objectContaining({ id: "d:fix-merge" }),
    );
    wake = "captain";
    const personalBefore = await core.dispatch("inf:settings:personal-resources:get", []);
    const personal = await change.run({
      action: "personal-resources",
      value: { enabled: !personalBefore },
      evidence: "use my instructions and skills",
    });
    expect(JSON.parse(personal.text).current.enabled).toBe(!personalBefore);
    expect(await core.dispatch("inf:settings:personal-resources:get", [])).toBe(!personalBefore);
    // INF-751: on a report's wake, the choice it relays applies.
    wake = "other";
    const relayedPersonal = await change.run({
      action: "personal-resources",
      value: { enabled: personalBefore },
      evidence: "The captain chose to stop using his instructions and skills on SCR-1's card.",
    });
    expect(JSON.parse(relayedPersonal.text).current.enabled).toBe(personalBefore);
    expect(await core.dispatch("inf:settings:personal-resources:get", [])).toBe(personalBefore);
    await core.dispatch("inf:settings:personal-resources:set", [personalBefore]);
    await core.dispatch("inf:settings:appearance:set", [appearance]);
    await core.dispatch("inf:settings:layout:set", [
      { collapsedPanels: {}, hiddenPanels: {}, placements: {} },
    ]);
    detach();
  });

  // INF-752: everything Settings → Automation does to a schedule, the first
  // mate does through the same catalog path, and each change leaves one
  // trail - an operation and one feed line naming who changed it - in place
  // of the Scheduler's own unattributed line.
  it("runs Automation's changes and the first mate's through one path, with one trail each", async () => {
    const events: FmEvent[] = [];
    const detach = core.events.subscribe((channel, payload) => {
      if (channel === "inf:event") events.push(payload as FmEvent);
    });
    const tools = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake: "other" }),
    });
    const change = tools.find((tool) => tool.name === "app_change");
    if (!change) throw new Error("Missing app_change");
    const scheduler = core.services.scheduler;
    const audit = scheduler.create(
      { kind: "daily", hour: 9, minute: 0, timeZone: "America/Los_Angeles" },
      "Audit the dependencies and report anything out of date.",
      true,
      "Weekly dependency audit",
    );
    const digest = scheduler.create(
      { kind: "daily", hour: 8, minute: 0, timeZone: "America/Los_Angeles" },
      "Summarize what the crew finished overnight.",
      false,
      "Morning digest",
    );
    expect(digest.state).toBe("draft");
    const operations = () => core.services.tasks.list().filter((task) => task.kind === "operation");
    const trailOf = async (actor: "captain" | "firstmate", text: string) => {
      const line = feedLineFrom({ type: "personalized", text, actor });
      return (await core.dispatch("inf:feed:recent", [])).filter(
        (entry) => entry.text === line?.text,
      );
    };
    const notes = () => events.filter((event) => event.type === "firstmate_note");
    const notesBefore = notes().length;

    // The captain's Pause in Settings: one operation and one line, the captain's.
    const before = operations().length;
    await core.dispatch("inf:automation:state", [audit.id, "pause"]);
    expect(operations()).toHaveLength(before + 1);
    expect(operations().at(-1)).toMatchObject({ title: automationWords.paused(audit) });
    expect(await trailOf("captain", automationWords.paused(audit))).toHaveLength(1);

    // A turn a report began: pausing and resuming are the first mate's judgment.
    const resumed = JSON.parse(
      (
        await change.run({
          action: "automation-state",
          value: { id: audit.id, change: "resume" },
          evidence: "The crewmate's report says the audit is needed again.",
        })
      ).text,
    );
    expect(resumed.current.rules).toContainEqual({
      id: audit.id,
      label: "Weekly dependency audit",
      state: "enabled",
    });
    expect(await trailOf("firstmate", automationWords.resumed(audit))).toHaveLength(1);
    expect(operations()).toHaveLength(before + 2);

    // Turning a draft on stays the captain's to direct: it takes his words,
    // whatever began the turn, and a draft never resumes.
    expect(
      (await change.run({ action: "automation-edit", value: { id: digest.id, enable: true } }))
        .text,
    ).toMatch(/captain's words/);
    expect(
      (
        await change.run({
          action: "automation-state",
          value: { id: digest.id, change: "resume" },
          evidence: "resume it",
        })
      ).text,
    ).toMatch(/automation-edit/);
    expect(scheduler.rules().find((rule) => rule.id === digest.id)?.state).toBe("draft");
    const asked = (value: Record<string, unknown>) =>
      change.run({ action: "automation-edit", value, evidence: "Turn the morning digest on." });
    const edited = JSON.parse((await asked({ id: digest.id, enable: true })).text);
    expect(
      edited.current.rules.find((rule: { id: string }) => rule.id === digest.id),
    ).toMatchObject({
      state: "enabled",
      prompt: digest.prompt,
      name: "Morning digest",
      captainRequested: true,
    });
    expect(
      await trailOf("firstmate", automationWords.saved(true, digest.spec, digest.prompt)),
    ).toHaveLength(1);
    await asked({ id: digest.id, name: "Overnight digest" });
    expect(scheduler.rules().find((rule) => rule.id === digest.id)).toMatchObject({
      name: "Overnight digest",
      prompt: digest.prompt,
      state: "enabled",
    });
    expect((await asked({ id: "missing" })).text).toMatch(/No automation missing/);

    const running = scheduler.rules().filter((rule) => rule.state === "enabled").length;
    await change.run({ action: "automation-pause-all", value: {}, evidence: "Quiet week." });
    expect(scheduler.rules().every((rule) => rule.state !== "enabled")).toBe(true);
    expect(await trailOf("firstmate", automationWords.pausedAll(running))).toHaveLength(1);
    const quiet = operations().length;
    await change.run({
      action: "automation-state",
      value: { id: audit.id, change: "pause" },
      evidence: "Already paused.",
    });
    expect(operations()).toHaveLength(quiet);

    await change.run({
      action: "automation-delete",
      value: { id: audit.id },
      evidence: "The audit moved to CI.",
    });
    expect(await trailOf("firstmate", automationWords.cancelled(audit.prompt))).toHaveLength(1);
    await core.dispatch("inf:automation:delete", [digest.id]);
    expect(await trailOf("captain", automationWords.cancelled(digest.prompt))).toHaveLength(1);
    expect(scheduler.rules().filter((rule) => [audit.id, digest.id].includes(rule.id))).toEqual([]);
    // Every change above said its words once, as its trail; the Scheduler
    // added no line of its own beside them.
    expect(notes()).toHaveLength(notesBefore);
    detach();
  });

  // INF-4381's approved plan, piece 2: "The first mate can remove one when
  // asked, through the app action catalog." A job recorded as a merged close
  // keeps it, removed through app_change with the captain's ask as evidence:
  // its remove runs, it leaves the list, and one feed line names the first mate.
  it("removes a job kept running past its task's close when the first mate is asked", async () => {
    const jobs = keptJobsAt(core.services.paths.crewmatesDir);
    const folder = join(keptRoot(core.services.paths.crewmatesDir), "task-9-s1");
    mkdirSync(folder, { recursive: true });
    const marker = join(folder, "backup.timer");
    writeFileSync(marker, "[Timer]\n");
    const label = "Nightly backup of the notes folder";
    jobs.record(
      [
        {
          id: "s1",
          label,
          check: `test -f "${marker}"`,
          remove: `rm "${marker}"`,
          folder,
          account: "captain",
        },
      ],
      { computer: null, task: "task-9", key: "INF-9" },
    );
    const tools = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake: "captain" }),
    });
    const change = tools.find((tool) => tool.name === "app_change");
    if (!change) throw new Error("Missing app_change");
    expect(
      (await change.run({ action: "kept-job-remove", value: { id: "task-9-s1" } })).text,
    ).toMatch(/captain's words/);
    expect(existsSync(marker)).toBe(true);
    const answer = JSON.parse(
      (
        await change.run({
          action: "kept-job-remove",
          value: { id: "task-9-s1" },
          evidence: "Stop the nightly backup job, I moved the notes.",
        })
      ).text,
    );
    expect(answer.current.jobs).toEqual([]);
    expect(existsSync(folder)).toBe(false);
    expect(jobs.list()).toEqual([]);
    const said = `Removed the kept job "${label}" on`;
    const line = (await core.dispatch("inf:feed:recent", [])).find((entry) =>
      entry.text.includes(said),
    );
    expect(line?.text).toBeTruthy();
  });

  // The captain's choice on the review: Forget beside a remove that did not
  // finish takes the job off the list, runs nothing, and its feed line says
  // the job may still run on that computer.
  it("forgets a kept job on the captain's click with a feed line that it may still run", async () => {
    const jobs = keptJobsAt(core.services.paths.crewmatesDir);
    const folder = join(keptRoot(core.services.paths.crewmatesDir), "task-8-s1");
    mkdirSync(folder, { recursive: true });
    const label = "Weekly photo sync";
    jobs.record(
      [{ id: "s1", label, check: "true", remove: "exit 3", folder, account: "captain" }],
      { computer: null, task: "task-8", key: "INF-8" },
    );
    expect((await core.dispatch("inf:automation:kept-remove", ["task-8-s1"])).removed).toBe(false);
    expect(await core.dispatch("inf:automation:kept-forget", ["task-8-s1"])).toEqual({
      id: "task-8-s1",
    });
    expect(jobs.list()).toEqual([]);
    expect(existsSync(folder)).toBe(true);
    const line = (await core.dispatch("inf:feed:recent", [])).find((entry) =>
      entry.text.includes(`Forgot the kept job "${label}"`),
    );
    expect(line?.text).toContain("may still run on");
  });

  // INF-5326's piece 3: the first mate reads what Settings shows beyond the
  // action list's current values, on demand, through app_state's read.
  it("answers the first mate's named reads with what Settings reads, and refuses a read off the list", async () => {
    const tools = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake: "captain" }),
      platform: "darwin",
    });
    const state = tools.find((tool) => tool.name === "app_state");
    if (!state) throw new Error("Missing app_state");
    const read = async (name: string, args?: Record<string, unknown>) => {
      const text = (await state.run({ read: name, ...(args ? { args } : {}) })).text;
      return text.startsWith("{") ? JSON.parse(text) : text;
    };
    const jobs = keptJobsAt(core.services.paths.crewmatesDir);
    const folder = join(keptRoot(core.services.paths.crewmatesDir), "task-7-s1");
    mkdirSync(folder, { recursive: true });
    jobs.record(
      [
        {
          id: "s1",
          label: "Daily notes backup",
          check: "true",
          remove: "true",
          folder,
          account: "captain",
        },
      ],
      { computer: null, task: "task-7", key: "INF-7" },
    );
    const rule = await core.dispatch("inf:automation:save", [
      {
        name: "Morning review",
        spec: { kind: "daily", hour: 8, minute: 30, timeZone: "America/Los_Angeles" },
        prompt: "Review what waits on me.",
      },
    ]);
    const savedKeys = await core.dispatch("inf:settings:keys:get", []);
    try {
      // Each read answers what the request Settings asks answers, and changes nothing.
      // Usage stamps when it was read, so the rest of the answer is compared.
      const withoutAt = ({ at: _at, ...rest }: { at: number }) => rest;
      const summary = await read("usage.summary");
      expect(summary.read).toBe("usage.summary");
      expect(withoutAt(summary.value)).toEqual(
        withoutAt(await core.dispatch("inf:usage:summary", [{ period: "30d", scope: "all" }])),
      );
      expect((await read("usage.tasks", { period: "7d" })).value).toEqual(
        await core.dispatch("inf:usage:tasks", [{ period: "7d", scope: "all", limit: 10 }]),
      );
      expect((await read("automation.history", { id: rule.id })).value).toEqual(
        await core.dispatch("inf:automation:history", [rule.id]),
      );
      const kept = (await read("automation.kept")).value;
      expect(kept).toEqual(await core.dispatch("inf:automation:kept", []));
      expect(kept.jobs.map((job: { label: string }) => job.label)).toContain("Daily notes backup");
      expect((await read("update.status")).value).toEqual(
        await core.dispatch("inf:update:status", []),
      );
      // A reading carries live figures, so each computer's stable facts are
      // compared, after the feed's first sample has landed: a read starts
      // one, which would move the status between the two answers.
      await core.services.computerResourceFeed.readCurrent();
      const stable = (answer: {
        computers: { computerId: string | null; label: string; reading: { status: string } }[];
      }) =>
        answer.computers.map(({ computerId, label, reading }) => ({
          computerId,
          label,
          status: reading.status,
        }));
      const resources = stable((await read("computers.resources")).value);
      expect(resources.length).toBeGreaterThan(0);
      expect(resources).toEqual(stable(await core.dispatch("inf:computers:resources", [])));
      const preview = await read("automation.preview", { spec: rule.spec });
      expect(preview.value).toEqual(await core.dispatch("inf:automation:preview", [rule.spec]));
      expect(preview.value.dates.length).toBeGreaterThan(0);
      expect((await read("devices.copies")).value).toEqual(
        await core.dispatch("inf:standby:list", []),
      );
      // The keys a person changed read as changed; the first mate reads them only.
      await core.dispatch("inf:settings:keys:set", [
        {
          ...savedKeys.saved,
          keys: {
            ...savedKeys.saved.keys,
            "commands.search": [{ key: "p", meta: true, shift: true }],
          },
        },
      ]);
      const keys = (await read("keyboard.keys")).value;
      const search = keys.commands.find(
        (command: { id: string }) => command.id === "commands.search",
      );
      // This core has no window, so the keys read are the saved ones, and say so.
      expect(keys.source).toBe("saved");
      expect(search).toMatchObject({ changed: true, keys: ["⇧⌘P"] });
      expect(keys.commands.filter((command: { changed: boolean }) => command.changed)).toHaveLength(
        1,
      );
      // The names, what each answers and its args are listed on demand, not in the tool's words.
      const listed = JSON.parse((await state.run({ area: "reads" })).text);
      expect(listed.map((entry: { read: string }) => entry.read)).toContain("keyboard.keys");
      expect(
        listed.find((entry: { read: string }) => entry.read === "automation.history").args.required,
      ).toEqual(["id"]);
      expect(await read("accounts.list")).toMatch(/^No read "accounts.list"\. Reads: \[/);
      expect(await read("automation.history")).toMatch(/refused its args/);
      // Args left out read with the defaults; args that are not one object are refused.
      expect(await read("usage.summary", ["30d"] as never)).toMatch(/must be one object/);
      expect((await state.run({ read: "usage.summary", args: "30d" as never })).text).toMatch(
        /must be one object/,
      );
      expect(await read("devices.move-ready", { id: "no-such-computer" })).toMatch(
        /could not answer: This first mate cannot move to another computer\./,
      );
      const lines = JSON.parse((await state.run({ area: "automation" })).text);
      const edit = lines.find((line: { action: string }) => line.action === "automation-edit");
      for (const detail of SCHEDULE_DETAILS) expect(edit.line).toContain(detail.token);
    } finally {
      await core.dispatch("inf:settings:keys:set", [savedKeys.saved]);
      await core.dispatch("inf:automation:delete", [rule.id]);
      jobs.forget(null, folder);
    }
  });

  // The captain's choice on the review: with a window, the keys read is the
  // map the window installed, as Keyboard settings shows it, so a panel's
  // command given a built-in key takes it from that built-in command.
  it("reads the window's installed keys, a panel's command included, when a window installed them", async () => {
    const read = await core.dispatch("inf:settings:keys:get", []);
    const panels = [
      { id: "panel:notes/open" as const, label: "Open notes", panel: "Notes", keys: [] },
    ];
    const saved = {
      ...read.saved,
      keys: { ...read.saved.keys, "panel:notes/open": [{ key: "k", meta: true }] },
    };
    const keysRead = async (installedKeys?: () => KeymapSnapshot | null) => {
      const state = createAppTools({
        dispatch: core.dispatch,
        actor: () => ({ kind: "firstmate", wake: "captain" }),
        platform: "darwin",
        ...(installedKeys ? { installedKeys } : {}),
      }).find((tool) => tool.name === "app_state");
      if (!state) throw new Error("Missing app_state");
      return JSON.parse((await state.run({ read: "keyboard.keys" })).text).value;
    };
    const installed = await keysRead(() =>
      keymapSnapshot({ saved, unreadable: false }, 1, panels, "mac"),
    );
    type Command = { id: string; keys: string[]; changed: boolean };
    const byId = (answer: { commands: Command[] }, id: string) =>
      answer.commands.find((command) => command.id === id);
    expect(installed.source).toBe("installed");
    expect(byId(installed, "panel:notes/open")).toEqual({
      id: "panel:notes/open",
      label: "Open notes",
      panel: "Notes",
      keys: ["⌘K"],
      changed: true,
    });
    expect(byId(installed, "commands.search")?.changed).toBe(false);
    expect(byId(installed, "commands.search")?.keys).not.toContain("⌘K");
    // With no window the saved keys read the built-in key where it was.
    const without = await keysRead();
    expect(without.source).toBe("saved");
    expect(byId(without, "commands.search")?.keys).toContain("⌘K");
    expect(byId(without, "panel:notes/open")).toBeUndefined();
    // A window that closed hands no map, which reads as no window at all.
    expect(await keysRead(() => null)).toEqual(without);
  });

  // The device reads answer what Settings -> Devices asks, from a first mate
  // that can move and keep copies: a disposable core of its own.
  it("answers the first mate's device reads with what Settings -> Devices reads", async () => {
    const movable = await startCore(fakeHost(scratchDir("infinitary-core-move-")).host, {
      onHomeMoved: () => {},
    });
    try {
      const state = createAppTools({
        dispatch: movable.dispatch,
        actor: () => ({ kind: "firstmate", wake: "captain" }),
      }).find((tool) => tool.name === "app_state");
      if (!state) throw new Error("Missing app_state");
      const read = async (name: string, id: string) =>
        JSON.parse((await state.run({ read: name, args: { id } })).text);
      const move = await read("devices.move-ready", "other-mac");
      expect(move.value).toEqual(await movable.dispatch("inf:home-move:ready", ["other-mac"]));
      expect(move.value.gaps.map((gap: { id: string }) => gap.id)).toEqual(["not-work"]);
      const copy = await read("devices.copy-ready", "other-mac");
      expect(copy.read).toBe("devices.copy-ready");
      expect(copy.value).toEqual(await movable.dispatch("inf:standby:ready", ["other-mac"]));
    } finally {
      await movable.dispose();
    }
  }, 60_000);

  it("runs presence through the core and refuses captain-owned actions without side effects", async () => {
    const before = await core.dispatch("inf:presence:get", []);
    let wake: "captain" | "scheduled" | "other" = "captain";
    const handed: string[] = [];
    const tools = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake }),
      handover: (target, offer) => {
        handed.push(`${offer.cardId}:${target}`);
        return "button offered";
      },
    });
    const change = tools.find((t) => t.name === "app_change");
    const state = tools.find((t) => t.name === "app_state");
    if (!change || !state) throw new Error("Missing app tools");
    const ask = (action: string, value: unknown) =>
      change.run({ action, value, evidence: "captain asked" });
    const operationCount = () =>
      core.services.tasks.list().filter((t) => t.kind === "operation").length;
    const count = operationCount();
    expect(
      JSON.parse((await ask("start-at-login", { enabled: !before.startAtLogin })).text).current
        .enabled,
    ).toBe(!before.startAtLogin);
    expect(shell.loginItem()).toBe(!before.startAtLogin);
    expect((await core.dispatch("inf:presence:get", [])).showInDock).toBe(before.showInDock);
    expect(operationCount()).toBe(count + 1);
    wake = "scheduled";
    await ask("show-in-dock", { enabled: !before.showInDock });
    expect(await core.dispatch("inf:presence:get", [])).toEqual({
      startAtLogin: !before.startAtLogin,
      showInDock: !before.showInDock,
    });
    expect(operationCount()).toBe(count + 2);
    await expect(
      core.dispatch("inf:presence:set", [before], {
        kind: "firstmate",
        wake: "captain",
        action: "start-at-login",
        evidence: "asked",
      }),
    ).rejects.toThrow("Only the named presence");
    // INF-751: on a report's wake, the choice it relays applies.
    wake = "other";
    expect(
      JSON.parse((await ask("start-at-login", { enabled: before.startAtLogin })).text).current
        .enabled,
    ).toBe(before.startAtLogin);
    expect(shell.loginItem()).toBe(before.startAtLogin);
    expect(operationCount()).toBe(count + 3);
    wake = "captain";
    const sharing = await core.dispatch("inf:settings:sharing:get", []);
    for (const action of [
      "diagnostics",
      "contribution",
      "sharing-ask",
      "purge",
      "panels-switch",
      "recovery",
      "plugin-consent",
      "card-close",
      "ask-first-merge",
    ])
      expect((await ask(action, {})).text).toContain("stays with the captain");
    expect(await core.dispatch("inf:settings:sharing:get", [])).toEqual(sharing);
    expect(operationCount()).toBe(count + 3);
    for (const action of ["account-sign-in", "custom-connection", "decision-key", "device-address"])
      expect((await ask(action, {})).text).toBe("button offered");
    expect((await ask("integration-add", { kind: "gitlab" })).text).toBe("button offered");
    expect(handed).toHaveLength(5);
    expect(JSON.parse((await ask("voice-model", {})).text).current.ready).toBe(true);
    const forgeStore = new ForgeSignInStore(core.paths.forgesDir);
    const signIn = () =>
      forgeStore.write("github.com", {
        token: "disposable-forge-sign-in",
        scopes: [],
        login: "fixture",
        createdAt: 1,
      });
    signIn();
    // INF-751: his typed words in a schedule he set sign out on its wake.
    wake = "scheduled";
    await ask("forge-sign-out", { host: "github.com" });
    expect(forgeStore.read("github.com")).toBeUndefined();
    signIn();
    wake = "captain";
    await ask("forge-sign-out", { host: "github.com" });
    expect(forgeStore.read("github.com")).toBeUndefined();
    // Settings signs out of any host the app is signed in to, and so may the
    // first mate on the captain's typed words (INF-638's audit).
    forgeStore.write("gitlab.example.com", {
      token: "disposable-forge-sign-in",
      scopes: [],
      login: "fixture",
      createdAt: 1,
    });
    expect((await ask("forge-sign-out", { host: "git.example.org" })).text).toContain(
      "No sign-in to git.example.org",
    );
    await ask("forge-sign-out", { host: "gitlab.example.com" });
    expect(forgeStore.read("gitlab.example.com")).toBeUndefined();
    expect(
      (await core.dispatch("inf:feed:recent", [])).some(
        (line) => line.text === "First mate · gitlab.example.com signed out",
      ),
    ).toBe(true);
    const lines = JSON.parse((await state.run({ area: "general" })).text);
    expect(lines.find((l: { action: string }) => l.action === "purge")).toMatchObject({
      captainAllowed: true,
      firstmateAllowed: false,
      allowedNow: false,
    });
    expect((await ask("release-page", {})).text).toContain("release-page");
    expect(shell.opened.at(-1)).toMatch(/^https:/);
    const records = core.services.tasks
      .list()
      .filter((t) => t.kind === "operation")
      .filter((r) =>
        [
          "start at login on",
          "show in dock off",
          "release page opened",
          "GitHub signed out",
          "voice model ready",
        ].includes(r.title),
      );
    console.log(
      "Piece 3 API evidence",
      JSON.stringify({
        presence: await core.dispatch("inf:presence:get", []),
        sharingUnchanged: true,
        handed,
        records: records.map((r) => ({ title: r.title, id: r.id })),
      }),
    );
    await core.dispatch("inf:presence:set", [before]);
  });

  // INF-4280's audit, fixes 1 to 3: the first mate's account actions reach a computer that runs
  // work's own accounts and GitHub sign-in, and Refresh asks it to read its allowance now. The
  // computer itself is helper/signIns.test.ts's; here its home's link answers.
  it("reaches a computer that runs work's own accounts and GitHub sign-in through the first mate's actions", async () => {
    const tools = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake: "captain" }),
    });
    const change = tools.find((t) => t.name === "app_change");
    if (!change) throw new Error("Missing app tools");
    const ask = async (action: string, value: unknown) =>
      (await change.run({ action, value, evidence: "captain typed it" })).text;
    const computer = core.services.deviceSignIns;
    const account = {
      id: "acct-codex-mini",
      providerId: "openai-codex",
      kind: "subscription_oauth" as const,
      label: "Studio",
      enabled: true,
      connected: true,
      pinned: false,
      createdAt: 1,
    };
    let said = {
      providers: [],
      accounts: [account],
      quota: null,
      forges: {
        signIns: [
          { host: "github.com", name: "GitHub", login: "octo", state: "ok" as const, since: 1 },
        ],
        hosts: [{ host: "github.com", name: "GitHub" }],
      },
    };
    const lastSaid = vi
      .spyOn(computer, "lastSaid")
      .mockImplementation((id) => (id === "mini" ? said : null));
    const placeOf = vi
      .spyOn(computer, "placeOf")
      .mockImplementation((id) =>
        id === "mini" ? { label: "Mac mini", who: "Mac mini", where: "on Mac mini" } : undefined,
      );
    const setAccount = vi.spyOn(computer, "setAccount").mockImplementation(async (_id, order) => {
      if (order.kind === "set-enabled")
        said = { ...said, accounts: [{ ...account, enabled: order.enabled }] };
      return { ok: true };
    });
    const signOut = vi.spyOn(computer, "signOut").mockImplementation(async () => {
      said = { ...said, accounts: [] };
      return { ok: true };
    });
    const signOutForge = vi.spyOn(computer, "signOutForge").mockImplementation(async () => {
      said = { ...said, forges: { ...said.forges, signIns: [] } };
      return { ok: true };
    });
    const readAllowance = vi.spyOn(computer, "readAllowance").mockResolvedValue();
    const home = await core.dispatch("inf:accounts:list", []);
    const feed = async () => (await core.dispatch("inf:feed:recent", [])).map((line) => line.text);
    try {
      await ask("account-pause", { accountId: account.id, paused: true, deviceId: "mini" });
      expect(setAccount).toHaveBeenCalledWith("mini", {
        kind: "set-enabled",
        accountId: account.id,
        enabled: false,
      });
      expect(await feed()).toContain("First mate · account Studio on Mac mini paused");

      await ask("account-disconnect", { accountId: account.id, deviceId: "mini" });
      expect(signOut).toHaveBeenCalledWith("mini", account.id);
      expect(await feed()).toContain("First mate · account Studio on Mac mini disconnected");

      await ask("forge-sign-out", { host: "github.com", deviceId: "mini" });
      expect(signOutForge).toHaveBeenCalledWith("mini", "github.com");
      expect(await feed()).toContain("First mate · GitHub signed out on Mac mini");
      expect(await core.dispatch("inf:accounts:list", [])).toEqual(home);

      await core.dispatch("inf:quota:refresh", []);
      expect(readAllowance).toHaveBeenCalledTimes(1);
    } finally {
      for (const spy of [lastSaid, placeOf, setAccount, signOut, signOutForge, readAllowance])
        spy.mockRestore();
    }
  });

  // Intent: the approved plan's "a core request that re-reads the grant and
  // reuses the first mate's request builder, run as the captain with the
  // panel named on the feed". Fixture: the look panel (tests/fixtures/panel-settings/look),
  // saved into the workspace as a crewmate saves one.
  it("runs a panel's change of a setting it was granted as the captain, naming the panel, and re-reads the grant each time", async () => {
    const folder = join(core.paths.personalWorkspaceDir, "look");
    cpSync(join(process.cwd(), "tests", "fixtures", "panel-settings", "look"), folder, {
      recursive: true,
    });
    const granted = async () =>
      (await core.dispatch("inf:plugins:personal:list", [])).extensions.find(
        (extension) => extension.id === "look",
      )?.actions;
    const before = await core.dispatch("inf:settings:appearance:get", []);
    const lines: FmEvent[] = [];
    const detach = core.events.subscribe((channel, payload) => {
      if (channel === "inf:event" && (payload as FmEvent).type === "personalized")
        lines.push(payload as FmEvent);
    });
    try {
      await expect.poll(granted, { timeout: 30_000 }).toEqual(["theme", "window-size"]);
      const other = before.theme === "dark" ? "light" : "dark";
      expect(
        await core.dispatch("inf:plugins:settings:change", ["look", "theme", { theme: other }]),
      ).toEqual({ ok: true });
      // The same request the first mate's theme change builds: the rest of the look kept.
      expect(await core.dispatch("inf:settings:appearance:get", [])).toEqual({
        ...before,
        theme: other,
      });
      const line = lines.at(-1);
      expect(line).toMatchObject({ type: "personalized", actor: "captain", panel: "Look" });
      expect(feedLineFrom(line as FmEvent)?.text).toBe(
        englishOf(
          said("feedCaptainSetInPanel", {
            text: ACTIONS.theme.done({ theme: other }),
            panel: "Look",
          }),
        ),
      );

      // A setting the panel was not granted, and one no panel may have, change nothing.
      const notGranted = await core.dispatch("inf:plugins:settings:change", [
        "look",
        "crew-model-names",
        { show: true },
      ]);
      expect(notGranted).toEqual({
        ok: false,
        text: englishOf(said("panelChangeNotGranted", { setting: "crew-model-names" })),
      });
      expect((await core.dispatch("inf:plugins:settings:change", ["look", "purge", {}])).ok).toBe(
        false,
      );
      // A value its line refuses answers the line's own words.
      const malformed = await core.dispatch("inf:plugins:settings:change", [
        "look",
        "theme",
        { theme: "purple" },
      ]);
      expect(malformed.ok).toBe(false);
      expect((await core.dispatch("inf:settings:appearance:get", [])).theme).toBe(other);

      // Granted project settings still never move where a project's code
      // lives or is pushed: its folder, its git address, or upstream or fork.
      const at = join(folder, "manifest.json");
      const manifest = JSON.parse(readFileSync(at, "utf8"));
      const project = ["theme", "window-size", "project-settings"];
      writeFileSync(at, JSON.stringify({ ...manifest, actions: project }));
      await expect.poll(granted, { timeout: 30_000 }).toEqual(project);
      const repo = (await core.dispatch("inf:repos:list", []))[0];
      const elsewhere = join(core.paths.personalWorkspaceDir, "elsewhere");
      for (const changes of [
        { origin: elsewhere },
        { path: elsewhere },
        { contributionDestination: "fork" },
      ]) {
        const value = { repoId: repo?.id ?? "no-project", changes };
        expect(
          await core.dispatch("inf:plugins:settings:change", ["look", "project-settings", value]),
        ).toEqual({ ok: false, text: englishOf(said("panelChangeOrigin")) });
      }
      expect((await core.dispatch("inf:repos:list", []))[0]).toEqual(repo);

      // The grant taken out of the manifest: the next change is refused.
      writeFileSync(at, JSON.stringify({ ...manifest, actions: ["window-size"] }));
      await expect.poll(granted, { timeout: 30_000 }).toEqual(["window-size"]);
      expect(
        (await core.dispatch("inf:plugins:settings:change", ["look", "theme", before])).ok,
      ).toBe(false);
      expect((await core.dispatch("inf:settings:appearance:get", [])).theme).toBe(other);
    } finally {
      detach();
      rmSync(folder, { recursive: true, force: true });
      await core.dispatch("inf:settings:appearance:set", [before]);
    }
  });

  it("brings a closed card forward through the one show-card door for the captain and Firstmate alike", async () => {
    const events: FmEvent[] = [];
    const detach = core.events.subscribe((channel, payload) => {
      if (channel === "inf:event") events.push(payload as FmEvent);
    });
    let wake: "captain" | "scheduled" | "other" = "captain";
    const tools = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake }),
    });
    const change = tools.find((t) => t.name === "app_change");
    const state = tools.find((t) => t.name === "app_state");
    if (!change || !state) throw new Error("Missing app tools");
    const ask = (value: unknown) =>
      change.run({ action: "show-card", value, evidence: "captain asked for the earlier plan" });
    const shown = () => events.filter((e) => e.type === "past_card_shown");
    const operations = () => core.services.tasks.list().filter((t) => t.kind === "operation");
    const supervisor = core.services.supervisor;
    try {
      supervisor.cards.hostCards.addSystemNoteCard("card-show-open", "Still open", "On the stage.");
      supervisor.cards.hostCards.addSystemNoteCard(
        "card-show-past",
        "An earlier plan",
        "What it said.",
      );
      supervisor.pressNote("card-show-past");
      const stack = async () => (await core.dispatch("inf:cards:list", [])).map((c) => c.id);
      const stackBefore = await stack();
      const pastBefore = await core.dispatch("inf:cards:past", ["card-show-past"]);
      const operationsBefore = operations().length;
      // Firstmate discovers the door and how to find the id from the catalog.
      const line = JSON.parse((await state.run({ area: "general" })).text).find(
        (l: { action: string }) => l.action === "show-card",
      );
      expect(line).toMatchObject({
        captainAllowed: true,
        firstmateAllowed: true,
        allowedNow: true,
      });
      expect(line.line).toContain("resolution.card.id");
      // Firstmate's pointing: the stage is told, one line is written, no card is made.
      expect(JSON.parse((await ask({ cardId: "card-show-past" })).text).action).toBe("show-card");
      expect(shown()).toEqual([{ type: "past_card_shown", cardId: "card-show-past" }]);
      expect(operations()).toHaveLength(operationsBefore + 1);
      expect(events.filter((e) => e.type === "personalized").map((e) => [e.text, e.actor])).toEqual(
        [['showed the earlier card "An earlier plan"', "firstmate"]],
      );
      expect(await stack()).toEqual(stackBefore);
      // The captain's own gesture takes the same door and writes no line.
      const past = await core.dispatch("inf:cards:show-past", ["card-show-past"]);
      expect(past.id).toBe("card-show-past");
      expect(shown()).toHaveLength(2);
      expect(operations()).toHaveLength(operationsBefore + 1);
      expect(await core.dispatch("inf:cards:past", ["card-show-past"])).toEqual(pastBefore);
      // INF-476: the asked door now restores an open minimized card, without resolving it.
      await core.dispatch("inf:cards:minimize", ["card-show-open", true]);
      expect(
        (await core.dispatch("inf:cards:list", [])).find((card) => card.id === "card-show-open")
          ?.minimized,
      ).toBe(true);
      expect(JSON.parse((await ask({ cardId: "card-show-open" })).text).action).toBe("show-card");
      expect(
        (await core.dispatch("inf:cards:list", [])).find((card) => card.id === "card-show-open"),
      ).toMatchObject({ status: "ready" });
      expect(events).toContainEqual({ type: "open_card_shown", cardId: "card-show-open" });
      // Unknown cards still refuse; the compatible old door still refuses an open card.
      expect((await ask({ cardId: "no-such-card" })).text).toContain("No card");
      await expect(core.dispatch("inf:cards:show-past", ["card-show-open"])).rejects.toThrow(
        /No closed card/,
      );
      expect(shown()).toHaveLength(2);
      // INF-751: his request, relayed in a crewmate's report, takes the same door.
      wake = "other";
      expect(JSON.parse((await ask({ cardId: "card-show-past" })).text).action).toBe("show-card");
      expect(shown()).toHaveLength(3);
      await expect(
        core.dispatch("inf:cards:show-past", ["card-show-past"], {
          kind: "firstmate",
          wake: "captain",
          action: "theme",
          evidence: "asked",
        }),
      ).rejects.toThrow(/outside its action catalog|named/);
    } finally {
      detach();
      supervisor.pressNote("card-show-open");
    }
  });

  it("brings a release note forward through the one What's new door for the captain and Firstmate alike", async () => {
    const events: FmEvent[] = [];
    const detach = core.events.subscribe((channel, payload) => {
      if (channel === "inf:event") events.push(payload as FmEvent);
    });
    let wake: "captain" | "other" = "captain";
    const tools = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake }),
    });
    const change = tools.find((t) => t.name === "app_change");
    const state = tools.find((t) => t.name === "app_state");
    if (!change || !state) throw new Error("Missing app tools");
    const ask = (value: unknown) =>
      change.run({ action: "show-whats-new", value, evidence: "captain asked what is new" });
    const shown = () =>
      events.filter((e) => e.type === "past_card_shown" || e.type === "open_card_shown");
    const operations = () => core.services.tasks.list().filter((t) => t.kind === "operation");
    const { settings, supervisor } = core.services;
    const saved = settings.getReleaseTracking();
    const delivery = (cardId: string, entryIds: string[], deliveredAt: number) => ({
      boundary: { version: null, source: null },
      entryIds,
      coverage: "complete" as const,
      cardId,
      deliveredAt,
    });
    try {
      settings.setReleaseTracking({ ...saved, deliveries: {} });
      expect((await core.dispatch("inf:release-notes:list", [])).notes).toEqual([]);
      await expect(core.dispatch("inf:release-notes:show", [null])).rejects.toThrow(
        "No release notes yet.",
      );
      expect((await ask({})).text).toContain("No release notes yet.");
      expect(shown()).toEqual([]);

      // An earlier note that listed changes, closed; a newer one that said
      // nothing was new, still open.
      supervisor.cards.hostCards.addSystemNoteCard(
        "card-note-listed",
        "What’s new in stable 0.0.2",
        "Changes.",
      );
      supervisor.pressNote("card-note-listed");
      supervisor.cards.hostCards.addSystemNoteCard(
        "card-note-quiet",
        "Your alpha is now stable",
        "Nothing new.",
      );
      settings.setReleaseTracking({
        ...saved,
        deliveries: {
          "0.0.2": delivery("card-note-listed", ["a"], 1),
          "0.0.3": delivery("card-note-quiet", [], 2),
        },
      });
      const stack = async () => (await core.dispatch("inf:cards:list", [])).map((c) => c.id);
      const stackBefore = await stack();
      const operationsBefore = operations().length;

      // The captain's door: the newest note that listed changes comes back
      // read-only, past the newer one that said nothing was new; no line.
      expect(await core.dispatch("inf:release-notes:show", [null])).toMatchObject({
        version: "0.0.2",
        cardId: "card-note-listed",
        open: false,
      });
      expect(shown()).toEqual([{ type: "past_card_shown", cardId: "card-note-listed" }]);
      expect(await core.dispatch("inf:release-notes:show", ["0.0.3"])).toMatchObject({
        open: true,
      });
      expect(shown().at(-1)).toEqual({ type: "open_card_shown", cardId: "card-note-quiet" });
      expect(operations()).toHaveLength(operationsBefore);

      // Firstmate finds the versions in the catalog and takes the same door,
      // with one line and no card.
      const line = JSON.parse((await state.run({ area: "general" })).text).find(
        (l: { action: string }) => l.action === "show-whats-new",
      );
      expect(line).toMatchObject({
        firstmateAllowed: true,
        allowedNow: true,
        current: {
          notes: [
            { version: "0.0.3", listed: false },
            { version: "0.0.2", listed: true },
          ],
        },
      });
      expect(JSON.parse((await ask({})).text).action).toBe("show-whats-new");
      expect(shown().at(-1)).toEqual({ type: "past_card_shown", cardId: "card-note-listed" });
      expect(operations()).toHaveLength(operationsBefore + 1);
      expect(events.filter((e) => e.type === "personalized").map((e) => [e.text, e.actor])).toEqual(
        [["showed the release note for 0.0.2", "firstmate"]],
      );
      expect(await stack()).toEqual(stackBefore);
      expect((await ask({ version: "0.0.9" })).text).toContain("No release note for 0.0.9");
      expect(shown()).toHaveLength(3);
      // INF-751: his request, relayed in a crewmate's report, takes the same door.
      wake = "other";
      expect(JSON.parse((await ask({})).text).action).toBe("show-whats-new");
      expect(shown()).toHaveLength(4);
    } finally {
      detach();
      settings.setReleaseTracking(saved);
      supervisor.pressNote("card-note-quiet");
    }
  });

  it("keeps Settings responsive while the voice model downloads", async () => {
    if (!shell.host.voice) throw new Error("Missing boxed voice host");
    let finish: () => void = () => {};
    const downloading = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let signalStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const mock = vi.spyOn(shell.host.voice, "ensureModel").mockImplementation(async () => {
      signalStarted();
      await downloading;
    });
    const download = core.dispatch("inf:voice:ensure-model", []);
    await started;
    const previous = await core.dispatch("inf:settings:notifications:get", []);
    try {
      await expect(core.dispatch("inf:settings:notifications:set", [!previous])).resolves.toBe(
        !previous,
      );
    } finally {
      finish();
      await download;
      mock.mockRestore();
      await core.dispatch("inf:settings:notifications:set", [previous]);
    }
  });
});
