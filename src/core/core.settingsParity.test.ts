import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACTIONS, type ActionName } from "@shared/actions";
import { type OwnStyle, ownStyleId, type SavedOwnStyle } from "@shared/ambientOwn";
import type { DeviceView } from "@shared/devices";
import type { FmEvent } from "@shared/events";
import type { IntegrationsView } from "@shared/integrations";
import type { CoreInvokeChannel } from "@shared/ipc";
import { knownPanels } from "@shared/panelArrangement";
import { type Appearance, DEFAULT_AMBIENT_STYLE, type Layout } from "@shared/preferences";
import type { SecretsView } from "@shared/secrets";
import type { StandbyViews } from "@shared/standby";
import type { UpdateStatus } from "@shared/update";
import { answerKeyReminders, answerWindowAsk } from "@shared/windowAnswer";
import { WINDOW_ASK_WORDS } from "@shared/windowAsks";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeHost, quotaFixture } from "../../tests/helpers/bootedCore";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { createActionTrail } from "./dispatcher/actionTrail";
import { type CoreHandlers, createCatalogDispatch } from "./dispatcher/catalogDispatch";
import { HOME_MOVE_WORDS } from "./homeMove/words";
import { type Core, startCore } from "./index";
import { createAppTools } from "./pi/appTools";
import { catalogRefreshesSettled } from "./pi/modelRuntime";
import { STANDBY_WORDS } from "./standby/words";
import { keptJobsAt } from "./tasks/keptJobs";
import { keptRoot } from "./tasks/taskStops";
import { ViewWindows } from "./viewWindows";

// This file is not about the utility-QoS clamp, so what the product spawns
// runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("./utilityQos", async (importOriginal) =>
  (await import("../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/**
 * The captain's ask (INF-5326, piece 1 INF-5354): what a person can do in
 * Settings, the first mate can do through the same requests. Each new or
 * widened action runs through app_change in the whole core, changes only its
 * own part of its request and leaves one Activity line; what stays the
 * captain's is refused there, and app_state carries none of the captain's
 * private values.
 */
describe("the first mate's Settings actions, driven through the whole core", () => {
  let userDataDir: string;
  let core: Core;

  beforeAll(async () => {
    userDataDir = scratchDir("infinitary-parity-");
    process.env.PI_OFFLINE = "1";
    quotaFixture("infinitary-parity-quota-", []);
    core = await startCore(fakeHost(userDataDir).host);
  }, 60_000);

  afterAll(async () => {
    await core?.dispose();
    await core?.services.workspace.poolSettled();
    await core?.services.workspace.deletionsSettled();
    await catalogRefreshesSettled();
    rmSync(userDataDir, { recursive: true, force: true });
    delete process.env.INFINITARY_QUOTA_FIXTURE_DIR;
  });

  const tool = (name: "app_change" | "app_state") => {
    const found = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake: "captain" }),
    }).find((each) => each.name === name);
    if (!found) throw new Error(`Missing ${name}`);
    return found;
  };
  const operations = () => core.services.tasks.list().filter((task) => task.kind === "operation");
  /** Runs one action as the captain asked it; answers its reply and the Activity lines it left. */
  const asked = async (
    action: ActionName,
    value: Record<string, unknown>,
    evidence = "Please.",
  ) => {
    const before = new Set(operations().map((task) => task.id));
    const answer = await tool("app_change").run({ action, value, evidence });
    let reply: { action?: string; answer?: Record<string, unknown>; current?: unknown } = {};
    try {
      reply = JSON.parse(answer.text);
    } catch {
      throw new Error(`${action} was refused: ${answer.text}`);
    }
    return {
      reply,
      lines: operations()
        .filter((task) => !before.has(task.id))
        .map((task) => task.title),
    };
  };
  const appearance = () => core.dispatch("inf:settings:appearance:get", []);

  it("plays and stops music, and sets card size, language and usage units, each alone", async () => {
    const off = await appearance();
    const played = await asked("ambient-music", { on: true });
    // INF-6406: on true and on false turn the same switch the sound button turns.
    expect(await appearance()).toEqual({ ...off, ambientMusic: true, ambientVolume: 40 });
    expect(played.lines).toEqual([`ambient music on, volume 40%, style ${DEFAULT_AMBIENT_STYLE}`]);
    expect((await asked("ambient-music", { on: false })).lines).toEqual([
      `ambient music off, volume 40%, style ${DEFAULT_AMBIENT_STYLE}`,
    ]);
    expect((await appearance()).ambientMusic).toBe(false);

    const wasCards = await appearance();
    const sized = await asked("card-size", { size: "wide", keepMaximized: true });
    expect(await appearance()).toEqual({
      ...wasCards,
      defaultCardSize: "wide",
      keepCardsMaximized: true,
      cardsMaximized: false,
    });
    expect(sized.lines).toEqual(["cards open wide, keep maximized on"]);

    const wasUnit = await appearance();
    // Usage shows dollars until the captain picks tokens, so tokens is the change.
    const unit = await asked("usage-unit", { unit: "tokens" });
    expect(await appearance()).toEqual({ ...wasUnit, usageUnit: "tokens" });
    expect(unit.lines).toEqual(["usage shown in tokens"]);
  });

  it("switches Pause when you're away off and on, as its Settings switch does", async () => {
    const was = await appearance();
    const kept = await asked("ambient-away", { pause: false });
    expect(await appearance()).toEqual({ ...was, ambientPlaysWhenAway: true });
    expect(kept.lines).toEqual(["ambient music plays while you're away"]);
    const paused = await asked("ambient-away", { pause: true });
    expect((await appearance()).ambientPlaysWhenAway).not.toBe(true);
    expect(paused.lines).toEqual(["ambient music pauses while you're away"]);
  });

  // INF-6289, the captain's pick on INF-6278: own ambient styles reach the
  // first mate by name, so how many are saved costs it no context and the
  // cap of 12 goes. Fixture: the sample styles a first mate wrote
  // (src/renderer/src/ambient/own-samples/), saved under 13 names.
  it("names any number of own ambient styles and reads one whole by its name", async () => {
    const was = await appearance();
    const sample = (file: string): OwnStyle =>
      JSON.parse(
        readFileSync(
          join(process.cwd(), "src/renderer/src/ambient/own-samples", `${file}.json`),
          "utf8",
        ),
      );
    const lofi = sample("lofi");
    const samples = [lofi, ...["bossa", "bowls", "warm-sleep", "hard-techno"].map(sample)];
    // Three rounds of the five samples, cut at 13: the bowls' third round saves last and plays.
    const styles = [1, 2, 3]
      .flatMap((round) => samples.map((style) => ({ ...style, name: `${style.name} ${round}` })))
      .slice(0, 13);
    const last = "Still water 3";
    const names = styles.map((style) => style.name);
    const read = async (name: string) => {
      const text = (await tool("app_state").run({ read: "ambient.own-style", args: { name } }))
        .text;
      return text.startsWith("{") ? JSON.parse(text).value : text;
    };
    const said: string[] = [];
    const detach = core.events.subscribe((channel, payload) => {
      const event = payload as FmEvent;
      if (channel === "inf:event" && event.type === "personalized") said.push(event.text);
    });
    try {
      let saved: Awaited<ReturnType<typeof asked>> | undefined;
      for (const style of styles) saved = await asked("ambient-own-style", { save: style });
      // The value names each style by id and name alone, in the answer and in app_state.
      const named = {
        saved: names.map((name) => ({ id: ownStyleId(name), name })),
        playing: ownStyleId(last),
      };
      expect(saved?.reply.current).toEqual(named);
      // The line names every style, which Activity and an operation's title cut short.
      const ownLines = () =>
        said.filter((text) => text === ACTIONS["ambient-own-style"].done(named)).length;
      expect(ownLines()).toBe(1);
      const look = JSON.parse((await tool("app_state").run({ area: "appearance" })).text);
      expect(
        look.find((line: { action: string }) => line.action === "ambient-own-style").current,
      ).toEqual(named);
      // One style reads whole by its name in any case, as Settings reads it.
      const lateShift = (await appearance()).ambientOwnStyles?.find(
        (own) => own.name === "Late shift 1",
      );
      expect(await read("late shift 1")).toEqual(lateShift);
      expect(lateShift).toMatchObject({ words: lofi.words, bpm: lofi.bpm });
      expect(await read("Cold rain")).toMatch(
        `could not answer: No own style Cold rain. Saved: ${names.join(", ")}.`,
      );
      // The style playing, read whole and saved again slower under its name,
      // reads the same by name, yet the change leaves its line; saved again
      // the same, nothing does.
      const { id: _id, bpm, ...playing } = (await read(last)) as SavedOwnStyle;
      if (bpm === undefined) throw new Error(`${last} names no tempo of its own`);
      const slower = await asked("ambient-own-style", { save: { ...playing, bpm: bpm - 4 } });
      expect(slower.reply.current).toEqual(named);
      expect(slower.lines).toHaveLength(1);
      expect(ownLines()).toBe(2);
      expect((await read(last)).bpm).toBe(bpm - 4);
      expect(
        (await asked("ambient-own-style", { save: { ...playing, bpm: bpm - 4 } })).lines,
      ).toEqual([]);
      expect(ownLines()).toBe(2);
    } finally {
      detach();
      // A look without styles keeps the saved ones, so the restore names none.
      await core.dispatch("inf:settings:appearance:set", [
        { ...was, ambientOwnStyles: was.ambientOwnStyles ?? [] },
      ]);
    }
  });

  it("chooses a language by its tag and goes back to the default with null", async () => {
    const tag = (
      ACTIONS.language.value.safeParse({ language: "zh-Hans" }).success ? "zh-Hans" : null
    ) as string | null;
    if (!tag) throw new Error("This build ships no Chinese catalog to choose");
    const was = await appearance();
    expect((await asked("language", { language: tag })).lines).toEqual([`language ${tag}`]);
    expect(await appearance()).toEqual({ ...was, language: tag });
    expect((await asked("language", { language: null })).lines).toEqual(["language default"]);
    expect((await appearance()).language).toBeUndefined();
  });

  it("changes dictation in the captain's words, keeping what it leaves out", async () => {
    const was = await core.dispatch("inf:settings:dictation:get", []);
    const turned = await asked("dictation", { enabled: !was.enabled }, "Turn dictation off.");
    expect(await core.dispatch("inf:settings:dictation:get", [])).toEqual({
      ...was,
      enabled: !was.enabled,
    });
    expect(turned.lines).toHaveLength(1);
    await core.dispatch("inf:settings:dictation:set", [was]);
  });

  it("picks a panel to its slot's edge, then puts every panel back where it asks to be", async () => {
    const [first] = knownPanels(core.services.personal.snapshot());
    if (!first) throw new Error("The core knows no panel");
    const pick = await asked("panel", { surface: first.id, pick: true });
    expect((await core.dispatch("inf:settings:layout:get", [])).morePick).toBe(first.id);
    // A More pick is one line, even for a panel already at its slot's edge.
    expect(pick.lines).toHaveLength(1);
    await asked("panel", {
      surface: first.id,
      rail: first.preferred.x === "left" ? "right" : "left",
    });
    const reset = await asked("panel", { reset: true });
    const layout = await core.dispatch("inf:settings:layout:get", []);
    expect(layout.morePick).toBeUndefined();
    expect(layout.placements).toEqual({});
    expect(reset.lines).toHaveLength(1);
  });

  it("turns a decision model use off, and never on", async () => {
    const use = (await core.dispatch("inf:settings:decisions", [])).uses?.find(
      (each) => each.kind !== "always-on" && each.on,
    );
    if (!use) throw new Error("No decision model use is on to turn off");
    const off = await asked("decision-use-off", { use: use.id });
    expect(
      (await core.dispatch("inf:settings:decisions", [])).uses?.find((each) => each.id === use.id)
        ?.on,
    ).toBe(false);
    expect(off.lines).toEqual([`decision model use ${use.name} off`]);
    // The line's own request, asked for the other act, is refused and changes nothing.
    await expect(
      core.dispatch("inf:decisions:use:set", [{ id: use.id, on: true }], {
        kind: "firstmate",
        wake: "captain",
        action: "decision-use-off",
        evidence: "Turn it on.",
      }),
    ).rejects.toThrow("stays with the captain");
    expect(
      (await core.dispatch("inf:settings:decisions", [])).uses?.find((each) => each.id === use.id)
        ?.on,
    ).toBe(false);
    // The captain's own switch turns it back on, as Settings does.
    await core.dispatch("inf:decisions:use:set", [{ id: use.id, on: true }]);
  });

  it("checks a kept job, as its Check does", async () => {
    const jobs = keptJobsAt(core.services.paths.crewmatesDir);
    const folder = join(keptRoot(core.services.paths.crewmatesDir), "task-7-s1");
    mkdirSync(folder, { recursive: true });
    const marker = join(folder, "sync.timer");
    writeFileSync(marker, "[Timer]\n");
    const label = "Hourly sync of the photos folder";
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
      { computer: null, task: "task-7", key: "INF-7" },
    );
    const checked = await asked("kept-job-check", { id: "task-7-s1" });
    expect(checked.reply.answer).toEqual({ checked: "running" });
    expect(checked.lines).toEqual([`checked ${label}: running`]);
    await core.dispatch("inf:automation:kept-forget", ["task-7-s1"]);
  });

  it("checks for updates and changes the update channel through the update checker", async () => {
    const status = await core.dispatch("inf:update:status", []);
    const newer = { ...status, latestVersion: "10.0.0", updateAvailable: true };
    const check = vi.spyOn(core.services.updateChecker, "checkNow").mockResolvedValue(newer);
    const checked = await asked("update-check", {});
    expect(check).toHaveBeenCalledTimes(1);
    expect(checked.reply.answer).toEqual({ latest: "10.0.0", available: true });
    expect(checked.lines).toEqual(["checked for updates: 10.0.0 is ready"]);
    // A check that failed says so, never the status it still holds from before.
    check.mockResolvedValue({ ...newer, problem: "The release source did not answer." });
    const failed = await asked("update-check", {});
    expect(failed.reply.answer).toMatchObject({ problem: "The release source did not answer." });
    expect(failed.lines).toEqual(["could not check for updates"]);
    check.mockRestore();
    const refused = await tool("app_change").run({
      action: "update-channel",
      value: { channel: "alpha" },
      evidence: "Switch me to alpha.",
    });
    // A build that cannot choose its own channel says so, and nothing changes.
    if (!core.services.updateChecker.setChannel)
      expect(refused.text).toContain("does not support changing its update channel");
  });

  it("answers an act that found nothing to do, leaving no Activity line", async () => {
    for (const [action, value] of [
      ["device-try-again", {}],
      ["home-move-cancel", {}],
      ["panel-retry", { surface: "nothing-stopped" }],
    ] as const) {
      const ran = await asked(action, value);
      expect(ran.lines, action).toEqual([]);
      expect(ran.reply.answer, action).toBeDefined();
    }
  });

  it("refuses own-words and asked lines without the captain's words, and acts their line does not own", async () => {
    for (const action of [
      "panel-retry",
      "private-site-remove",
      "secret-end-read",
      "dictation",
    ] as const)
      expect(ACTIONS[action].tier).toBe("own-words");
    const change = tool("app_change");
    for (const [action, value] of [
      ["private-site-remove", { site: "wiki.corp.example" }],
      ["secret-end-read", { id: "read-1" }],
      ["copy-stop", { deviceId: "mini" }],
    ] as const) {
      const answer = await change.run({ action, value });
      expect(answer.text, action).toContain("Give the captain's words");
    }
    for (const [channel, args, action] of [
      ["inf:secrets:action", [{ kind: "delete-history" }], "secret-end-read"],
      ["inf:standby:name", ["mini", true], "copy-stop"],
    ] as const)
      await expect(
        core.dispatch(channel, args as never, {
          kind: "firstmate",
          wake: "captain",
          action,
          evidence: "Please.",
        }),
      ).rejects.toThrow("stays with the captain");
  });

  // The approved plan for several logins of one provider, piece 3, "Setting":
  // one saved choice, starting on ask, that the first mate changes only on
  // the captain's words, naming the terms risk of spread and move.
  it("sets what happens when a login runs low only on the captain's words", async () => {
    expect(ACTIONS["when-login-low"].tier).toBe("own-words");
    expect(ACTIONS["when-login-low"].line).toContain(
      "Before setting spread or move, name the terms risk",
    );
    expect(await core.dispatch("inf:settings:when-login-low:get", [])).toBe("ask");
    const refused = await tool("app_change").run({
      action: "when-login-low",
      value: { choice: "move" },
    });
    expect(refused.text).toContain("Give the captain's words");
    expect(await core.dispatch("inf:settings:when-login-low:get", [])).toBe("ask");

    const moved = await asked(
      "when-login-low",
      { choice: "move" },
      "Yes, I know the risk. Move my work between logins on its own.",
    );
    expect(moved.lines).toEqual(["when the login in use runs low: move"]);
    expect(await core.dispatch("inf:settings:when-login-low:get", [])).toBe("move");
    await expect(
      core.dispatch("inf:settings:when-login-low:set", ["sometimes" as never]),
    ).rejects.toThrow();
    await core.dispatch("inf:settings:when-login-low:set", ["ask"]);
  });

  it("leaves the captain's own clicks on newly claimed requests as they were", async () => {
    const before = operations().length;
    const copy = await core.dispatch("inf:standby:name", ["mini", true]);
    const secrets = await core.dispatch("inf:secrets:action", [{ kind: "delete-history" }]);
    // This core keeps no copies and has no Secrets turned on: each answers as Settings sees it.
    expect(copy).toEqual({ ok: false, text: STANDBY_WORDS.noCopies });
    expect(secrets.availability).toBe("not-enabled");
    // Starting a copy and every secret action but ending a read leave no line of the new actions.
    expect(operations()).toHaveLength(before);
  });

  it("keeps the captain's private values out of app_state (INF-5350, INF-5339)", async () => {
    await core.dispatch("inf:settings:sharing:set", ["diagnostics", true]);
    const sharing = await core.dispatch("inf:settings:sharing:get", []);
    const installId = sharing.diagnostics.installId;
    expect(installId).toBeTruthy();
    // A sign-in under way, a computer reached by its Remote Login and an MCP
    // server's command, as Settings reads each.
    const userCode = "WDJB-MJHT";
    const login = "kiran@studio-4.local";
    const runs = "npx -y @acme/notes-server --token-file /Users/sam/.notes-token";
    const forges = core.services.forges.view();
    const forgesView = vi.spyOn(core.services.forges, "view").mockReturnValue({
      ...forges,
      flow: {
        host: "github.com",
        userCode,
        verificationUri: "https://github.com/login/device",
        expiresAt: Date.now() + 600_000,
      },
    } as typeof forges);
    const devices = vi
      .spyOn(core.services.computers, "list")
      .mockReturnValue([device({ remoteLogin: login })]);
    const integrations = core.services.integrations.view();
    const integrationsView = vi.spyOn(core.services.integrations, "view").mockReturnValue({
      ...integrations,
      integrations: [
        ...integrations.integrations,
        {
          id: "notes",
          kind: "mcp",
          name: "Notes",
          account: null,
          health: "ok",
          paused: false,
          runs,
          actions: [],
        },
      ],
    } as IntegrationsView);
    try {
      const state = (await tool("app_state").run({})).text;
      // Each sentinel reached the reads app_state makes: the device and the integration are there.
      expect(forgesView).toHaveBeenCalled();
      expect(devices).toHaveBeenCalled();
      expect(state).toContain("Mac mini");
      expect(state).toContain("Notes");
      const lines = JSON.parse(state) as { action: string }[];
      for (const secret of [installId as string, userCode, login, runs])
        for (const line of lines)
          expect(JSON.stringify(line), `${line.action} reads ${secret}`).not.toContain(secret);
    } finally {
      forgesView.mockRestore();
      devices.mockRestore();
      integrationsView.mockRestore();
      await core.dispatch("inf:settings:sharing:set", ["diagnostics", false]);
    }
  });

  /** A Mac on Settings → Devices, as its row reads. */
  const device = (extra: Partial<DeviceView> = {}): DeviceView =>
    ({ id: "mini", kind: "mac", name: "Mac mini", inReach: true, ...extra }) as DeviceView;

  it("follows the alpha releases through the update checker's own channel", async () => {
    const status = await core.dispatch("inf:update:status", []);
    let channel = status.channel;
    const checker = core.services.updateChecker;
    const hadSetChannel = checker.setChannel;
    const read = vi
      .spyOn(checker, "getStatus")
      .mockImplementation(async () => ({ ...status, channel, channelChoice: true }));
    const setChannel = vi.fn(async (next: typeof channel) => {
      channel = next;
      return { ...status, channel, channelChoice: true };
    });
    checker.setChannel = setChannel as typeof checker.setChannel;
    try {
      const changed = await asked("update-channel", { channel: "alpha" });
      expect(setChannel).toHaveBeenCalledWith("alpha");
      expect((await core.dispatch("inf:update:status", [])).channel).toBe("alpha");
      expect(changed.lines).toEqual(["updates follow the alpha releases"]);
    } finally {
      read.mockRestore();
      checker.setChannel = hadSetChannel;
    }
  });

  it("makes the Infinitary command's link while it is offered", async () => {
    let state: "offered" | "linked" = "offered";
    const real = core.services.integrations.view();
    const view = vi.spyOn(core.services.integrations, "view").mockImplementation(
      () =>
        ({
          ...real,
          integrations: [
            {
              id: "inbox",
              kind: "inbox",
              name: "Inbox",
              account: null,
              health: "ok",
              paused: false,
              actions: [],
              door: {
                command: "/Applications/Infinitary.app/Contents/Resources/bin/infinitary",
                line: "infinitary inbox",
                link: { state, path: "/usr/local/bin/infinitary" },
              },
            },
          ],
        }) as IntegrationsView,
    );
    // Stands in for the link a click makes in /usr/local/bin, outside the scratch home.
    const link = vi.spyOn(core.services.integrationInbox, "link").mockImplementation(() => {
      state = "linked";
      return undefined as never;
    });
    try {
      const made = await asked("inbox-link", {});
      expect(link).toHaveBeenCalledTimes(1);
      expect(made.lines).toEqual(["Infinitary command link linked"]);
    } finally {
      view.mockRestore();
      link.mockRestore();
    }
  });

  it("retries a stopped panel and asks again for its integration call", async () => {
    const retry = vi.spyOn(core.services.personal, "retry").mockResolvedValue(true);
    const askAgain = vi.spyOn(core.services.personal, "askAgain").mockReturnValue(true);
    try {
      const retried = await asked("panel-retry", { surface: "tokyo" }, "Start Tokyo again.");
      expect(retry).toHaveBeenCalledWith("tokyo", undefined);
      expect(retried.reply.answer).toEqual({ retried: true });
      expect(retried.lines).toEqual(["tokyo started again"]);
      const again = await asked("panel-ask-again", {
        surface: "tokyo",
        integration: "calendar",
        action: "list-events",
      });
      expect(askAgain).toHaveBeenCalledWith("tokyo", "calendar", "list-events");
      expect(again.reply.answer).toEqual({ asked: true });
      expect(again.lines).toEqual(["asked again for tokyo's list-events"]);
    } finally {
      retry.mockRestore();
      askAgain.mockRestore();
    }
  });

  it("ends a permission to read secrets by its id, in the captain's words", async () => {
    const real = await core.dispatch("inf:secrets:view", []);
    const read = {
      id: "read-1",
      key: "k1",
      label: "the deploy token",
      destination: "INF-12",
      secrets: ["deploy"],
      expires: Date.now() + 600_000,
      remaining: 1,
    };
    let reads = [read];
    const view = vi
      .spyOn(core.services.secrets, "view")
      .mockImplementation(async () => ({ ...real, reads }) as SecretsView);
    const action = vi.spyOn(core.services.secrets, "action").mockImplementation(async () => {
      reads = [];
      return { ...real, reads } as SecretsView;
    });
    try {
      const ended = await asked("secret-end-read", { id: "read-1" }, "End the deploy read now.");
      expect(action).toHaveBeenCalledWith({ kind: "end-read", id: "read-1" });
      expect(ended.lines).toEqual(["ended the permission to read the deploy token"]);
    } finally {
      view.mockRestore();
      action.mockRestore();
    }
  });

  it("keeps a computer waiting to be removed, and asks a Mac to set up its work again", async () => {
    let removal: DeviceView["removal"] = "when-back";
    const list = vi
      .spyOn(core.services.computers, "list")
      .mockImplementation(() => [
        device({ ...(removal ? { removal } : {}), workSetup: { state: "blocked" } }),
      ]);
    const keep = vi.spyOn(core.services.computers, "keep").mockImplementation(() => {
      removal = undefined;
      return device({ workSetup: { state: "blocked" } });
    });
    const fixWork = vi.spyOn(core.services.computers, "fixWork").mockReturnValue(true);
    try {
      const kept = await asked("device-keep", { deviceId: "mini" });
      expect(keep).toHaveBeenCalledWith("mini");
      expect(kept.lines).toEqual(["Mac mini stays on the list"]);
      const fixed = await asked("device-fix-work", { deviceId: "mini" });
      expect(fixWork).toHaveBeenCalledWith("mini");
      expect(fixed.reply.answer).toEqual({ asked: true });
      expect(fixed.lines).toEqual(["asked Mac mini to set up its work again"]);
    } finally {
      list.mockRestore();
      keep.mockRestore();
      fixWork.mockRestore();
    }
  });

  it("tries an SSH connection again", async () => {
    const tryAgain = vi.spyOn(core.services.sshConnections, "tryAgain").mockReturnValue(1);
    try {
      const tried = await asked("device-try-again", { deviceId: "mini" });
      expect(tryAgain).toHaveBeenCalledWith("mini");
      expect(tried.reply.answer).toEqual({ tried: 1 });
      expect(tried.lines).toEqual(["tried 1 SSH connection again"]);
    } finally {
      tryAgain.mockRestore();
    }
  });

  it("removes a private site on the list, and leaves no line for one it never held", async () => {
    let sites = ["wiki.corp.example"];
    const store = {
      list: () => sites,
      add: (site: string) => {
        sites = [...sites, site];
        return { ok: true as const, sites };
      },
      remove: (site: string) => {
        sites = sites.filter((each) => each !== site);
        return { ok: true as const, sites };
      },
    };
    const had = core.services.browsers;
    // Stands in for the task browsers' own list where this core keeps none.
    const browsers = had ?? ({ privateSites: store } as unknown as NonNullable<typeof had>);
    const privateSites = had ? vi.spyOn(had, "privateSites", "get") : undefined;
    privateSites?.mockReturnValue(store as never);
    core.services.browsers = browsers;
    try {
      const removed = await asked(
        "private-site-remove",
        { site: "wiki.corp.example" },
        "Take wiki.corp.example off the private sites.",
      );
      expect(sites).toEqual([]);
      expect(removed.lines).toEqual(["removed wiki.corp.example from private sites"]);
      const absent = await asked(
        "private-site-remove",
        { site: "wiki.corp.example" },
        "Take wiki.corp.example off the private sites.",
      );
      expect(absent.lines).toEqual([]);
    } finally {
      privateSites?.mockRestore();
      core.services.browsers = had;
    }
  });

  it("stops no copy a computer does not keep, leaving no line", async () => {
    const stopped = await asked("copy-stop", { deviceId: "mini" });
    expect(stopped.reply.answer).toEqual({ ok: false, text: STANDBY_WORDS.noCopies });
    expect(stopped.lines).toEqual([]);
  });

  it("restores the saved model pins after the current ones", async () => {
    const settings = core.services.settings;
    const was = settings.getRoutingSettings();
    const pin = { provider: "xai", id: "grok-4" };
    // Only the always-route migration saves pins aside; this stands in for its result.
    let saved = true;
    const realGet = settings.getRoutingSettings.bind(settings);
    const realSet = settings.setRoutingSettings.bind(settings);
    const get = vi
      .spyOn(settings, "getRoutingSettings")
      .mockImplementation(() =>
        saved ? { ...realGet(), pins: [], dormantPins: [pin] } : realGet(),
      );
    const set = vi.spyOn(settings, "setRoutingSettings").mockImplementation((next) => {
      saved = false;
      realSet(next);
    });
    try {
      const restored = await asked("model-pins", { restore: true });
      expect(set).toHaveBeenCalledWith(expect.objectContaining({ pins: [pin], dormantPins: [] }));
      const after = await core.dispatch("inf:settings:routing:get", []);
      expect(after.pins).toEqual([pin]);
      expect(after.dormantPins ?? []).toEqual([]);
      expect(restored.lines).toEqual(["model pins xai/grok-4"]);
    } finally {
      get.mockRestore();
      set.mockRestore();
      settings.setRoutingSettings(was);
    }
  });

  it("hands reconnect to the scheduler, leaving no line when nothing moved", async () => {
    const created = await core.dispatch("inf:automation:save", [
      { name: "Morning", spec: { kind: "every", minutes: 60 }, prompt: "Say good morning." },
    ]);
    const update = vi.spyOn(core.services.scheduler, "update");
    try {
      const edited = await asked("automation-edit", { id: created.id, reconnect: true });
      expect(update).toHaveBeenCalledWith(
        created.id,
        expect.objectContaining({ reconnect: true }),
        expect.anything(),
      );
      // A timed rule has no connection to move, so nothing changed and no line is left.
      expect(edited.lines).toEqual([]);
    } finally {
      update.mockRestore();
      await core.dispatch("inf:automation:delete", [created.id]);
    }
  });

  it("cancels a running move and stops a kept copy, each leaving one line", async () => {
    // This core holds no move and keeps no copy, so a move that runs and a
    // copy on mini are the two requests' own state, behind the real catalog
    // checks and trail.
    let copies: StandbyViews = { standbys: [{ deviceId: "mini", state: "in-sync", copyAt: 1 }] };
    let moving = true;
    const held: Partial<CoreHandlers> = {
      "inf:app:healthcheck": () => core.dispatch("inf:app:healthcheck", []),
      "inf:home-move:cancel": () => {
        if (!moving) return { ok: false, text: HOME_MOVE_WORDS.notMoving };
        moving = false;
        return { ok: true, text: HOME_MOVE_WORDS.cancelling };
      },
      "inf:standby:list": () => copies,
      "inf:standby:name": (deviceId, on) => {
        if (on || !copies.standbys.some((copy) => copy.deviceId === deviceId))
          return { ok: false, text: STANDBY_WORDS.noCopies };
        copies = { standbys: copies.standbys.filter((copy) => copy.deviceId !== deviceId) };
        return { ok: true, text: STANDBY_WORDS.stopped("mini") };
      },
    };
    const handlers = new Proxy(held, {
      get: (own, channel: string) => {
        const handler = own[channel as keyof CoreHandlers];
        if (!handler) throw new Error(`Unexpected ${channel}`);
        return handler;
      },
    }) as CoreHandlers;
    const dispatch = createCatalogDispatch({
      services: core.services,
      handlers,
      ...createActionTrail(core.services, {}),
      automation: { said: undefined },
      viewWindows: new ViewWindows({ liveToView: () => false }),
    });
    const act = async (action: ActionName, channel: CoreInvokeChannel, args: unknown[]) => {
      const before = operations().length;
      await dispatch(channel as never, args, {
        kind: "firstmate",
        wake: "captain",
        action,
        evidence: "Please.",
      });
      return operations()
        .slice(before)
        .map((task) => task.title);
    };
    expect(await act("home-move-cancel", "inf:home-move:cancel", [])).toEqual([
      HOME_MOVE_WORDS.cancelling,
    ]);
    expect(moving).toBe(false);
    // Activity shows the words cut to its line's length.
    const stopped = await act("copy-stop", "inf:standby:name", ["mini", false]);
    expect(stopped).toHaveLength(1);
    expect(STANDBY_WORDS.stopped("mini").startsWith(stopped[0]?.replace(/…$/, "") ?? "-")).toBe(
      true,
    );
    expect(copies.standbys).toEqual([]);
    // Asked again, neither has anything left to do, and neither leaves a line.
    expect(await act("home-move-cancel", "inf:home-move:cancel", [])).toEqual([]);
    expect(await act("copy-stop", "inf:standby:name", ["mini", false])).toEqual([]);
  });

  it("reconnects a stopped event rule to what its integration is connected to now, leaving one line", async () => {
    const scheduler = core.services.scheduler;
    // What the mail integration is connected to: the rule's own connection, then a replacement.
    let connected = "mail-1";
    const mail = () => ({
      integration: "mail",
      connection: connected,
      name: "Mail",
      event: "new-mail",
      label: "New mail",
      every: 1,
    });
    const check = vi
      .spyOn(scheduler, "checkEvent")
      .mockImplementation((spec) => ({ spec, connection: connected }));
    const reading = vi.spyOn(scheduler, "eventsNow").mockReturnValue({ find: mail });
    const created = await core.dispatch("inf:automation:save", [
      {
        name: "Mail",
        spec: { kind: "event", integration: "mail", event: "new-mail" },
        prompt: "Read the new mail.",
      },
    ]);
    try {
      const ruleOf = () => scheduler.rules().find((rule) => rule.id === created.id);
      expect(ruleOf()?.connection).toBe("mail-1");
      // The connection was replaced, so the rule waits on the old one until it is reconnected.
      connected = "mail-2";
      const stoppedOf = async () =>
        (await core.dispatch("inf:automation:list", [])).rules.find(
          (rule) => rule.id === created.id,
        )?.stopped;
      expect(await stoppedOf()).toBeDefined();
      const edited = await asked("automation-edit", { id: created.id, reconnect: true });
      expect(ruleOf()?.connection).toBe("mail-2");
      expect(await stoppedOf()).toBeUndefined();
      expect(edited.lines).toEqual([expect.stringContaining("new-mail from mail")]);
      // Asked again, it already listens to mail-2: nothing moves and no line is left.
      const again = await asked("automation-edit", { id: created.id, reconnect: true });
      expect(ruleOf()?.connection).toBe("mail-2");
      expect(again.lines).toEqual([]);
    } finally {
      check.mockRestore();
      reading.mockRestore();
      await core.dispatch("inf:automation:delete", [created.id]);
    }
  });

  /**
   * The captain's pick on the review (add-window-target): what the first mate
   * changes of a window's own Settings goes to the window the captain names.
   * A Mac's window answers the live frame here through the window's own
   * answer (`answerWindowAsk`), from a look and key reminder of its own, as
   * `ViewBackend` answers from that Mac's own look.
   */
  const playWindow = (
    deviceId: string,
    own: {
      appearance: Appearance;
      layout?: Layout;
      reminders?: boolean;
      update?: UpdateStatus;
      /** The window's own Settings edit, made after the first mate read its look. */
      editsAfterRead?: (appearance: Appearance) => Appearance;
      /** The window's own Settings edit, made after the first mate read its layout. */
      layoutEditsAfterRead?: (layout: Layout) => Layout;
    },
  ) =>
    vi
      .spyOn(core.services.workDevices, "liveToView")
      .mockImplementation((to, channel, payload, change, one) => {
        if (to !== deviceId || channel !== "inf:view:ask" || change !== "window-asks" || !one)
          return false;
        void answerWindowAsk(
          payload,
          deviceId,
          async (asked, args) => {
            if (asked === "inf:settings:appearance:get") return own.appearance;
            if (asked === "inf:settings:appearance:set") {
              own.appearance = args[0] as Appearance;
              return own.appearance;
            }
            if (asked === "inf:settings:layout:get" && own.layout) return own.layout;
            if (asked === "inf:settings:layout:set") {
              own.layout = args[0] as Layout;
              return own.layout;
            }
            if ((asked === "inf:update:check" || asked === "inf:update:status") && own.update)
              return own.update;
            return answerKeyReminders(
              {
                current: () => ({ on: own.reminders ?? true, pressed: {} }),
                setOn: (on) => {
                  own.reminders = on;
                  return { on, pressed: {} };
                },
              },
              asked,
              args,
            );
          },
          (id, answer) =>
            core.dispatch("inf:view:answer", [id, answer], { kind: "captain", view: deviceId }),
        ).then(() => {
          // The window's own Settings change something after its look was read.
          if (own.editsAfterRead) {
            own.appearance = own.editsAfterRead(own.appearance);
            own.editsAfterRead = undefined;
          }
          if (own.layoutEditsAfterRead && own.layout) {
            own.layout = own.layoutEditsAfterRead(own.layout);
            own.layoutEditsAfterRead = undefined;
          }
        });
        return true;
      });

  it("changes the named Mac's own look through its window, and leaves this computer's alone", async () => {
    const devices = vi
      .spyOn(core.services.computers, "list")
      .mockReturnValue([device({ id: "studio", name: "Studio" })]);
    const theirs: Parameters<typeof playWindow>[1] = {
      appearance: { ...(await appearance()), usageUnit: "tokens" },
    };
    const window = playWindow("studio", theirs);
    try {
      const here = await appearance();
      const before = operations().length;
      const answer = await tool("app_change").run({
        action: "usage-unit",
        value: { unit: "usd" },
        evidence: "Show dollars on this Mac.",
        computer: "studio",
      });
      expect(JSON.parse(answer.text).current).toEqual({ unit: "usd" });
      expect(theirs.appearance.usageUnit).toBe("usd");
      expect(await appearance()).toEqual(here);
      expect(
        operations()
          .slice(before)
          .map((task) => task.title),
      ).toEqual(["usage shown in usd on Studio"]);
      // A setting of the first mate's computer is never asked of a window.
      const refused = await tool("app_change").run({
        action: "decision-use-off",
        value: { use: "anything" },
        evidence: "Turn it off there.",
        computer: "Studio",
      });
      expect(refused.text).toContain("only for a window's own setting");
      const unknown = await tool("app_change").run({
        action: "usage-unit",
        value: { unit: "tokens" },
        evidence: "Tokens on the laptop.",
        computer: "Laptop",
      });
      expect(unknown.text).toContain("No Mac that controls this one is named Laptop");

      // Its own Settings switch to a light theme after the first mate read its look:
      // the first mate's change of the usage unit keeps that edit, and its one
      // Activity line is the usage unit alone, never the window's own theme.
      theirs.appearance = { ...theirs.appearance, theme: "dark" };
      theirs.editsAfterRead = (look) => ({ ...look, theme: "light" });
      const overlapped = operations().length;
      await tool("app_change").run({
        action: "usage-unit",
        value: { unit: "tokens" },
        evidence: "Back to tokens on Studio.",
        computer: "Studio",
      });
      expect(theirs.appearance).toMatchObject({ theme: "light", usageUnit: "tokens" });
      expect(await appearance()).toEqual(here);
      expect(
        operations()
          .slice(overlapped)
          .map((task) => task.title),
      ).toEqual(["usage shown in tokens on Studio"]);

      // Its own Settings change the music after the first mate read it.
      const playThere = async (value: Record<string, unknown>) => {
        const was = operations().length;
        const answer = await tool("app_change").run({
          action: "ambient-music",
          value,
          evidence: "The music on Studio, please.",
          computer: "Studio",
        });
        return {
          text: answer.text,
          lines: operations()
            .slice(was)
            .map((task) => task.title),
        };
      };
      // Asked to play with no volume named while it moved from 40 to 70 there:
      // it plays, keeping that volume.
      theirs.appearance = { ...theirs.appearance, ambientMusic: false, ambientVolume: 40 };
      theirs.editsAfterRead = (look) => ({ ...look, ambientVolume: 70 });
      const played = await playThere({ on: true });
      expect(theirs.appearance).toMatchObject({ ambientMusic: true, ambientVolume: 70 });
      expect(played.lines).toHaveLength(1);
      // Asked to play at 40 while it moved from 40 to 70 there: nothing changes there.
      theirs.appearance = { ...theirs.appearance, ambientMusic: false, ambientVolume: 40 };
      theirs.editsAfterRead = (look) => ({ ...look, ambientVolume: 70 });
      const atForty = await playThere({ on: true, volume: 40 });
      expect(atForty.text).toContain(WINDOW_ASK_WORDS.changedThere(["ambientVolume"]));
      expect(atForty.lines).toEqual([]);
      expect(theirs.appearance).toMatchObject({ ambientMusic: false, ambientVolume: 70 });
      // Asked to keep playing music it switched off there: nothing changes there.
      theirs.appearance = { ...theirs.appearance, ambientMusic: true };
      theirs.editsAfterRead = (look) => ({ ...look, ambientMusic: false });
      const resumed = await playThere({ on: true });
      expect(resumed.text).toContain(WINDOW_ASK_WORDS.changedThere(["ambientMusic"]));
      expect(resumed.lines).toEqual([]);
      expect(theirs.appearance).toMatchObject({ ambientMusic: false });
      // Asked to play music it already started there: that part is done, and the volume is set.
      theirs.appearance = { ...theirs.appearance, ambientMusic: false, ambientVolume: 40 };
      theirs.editsAfterRead = (look) => ({ ...look, ambientMusic: true });
      const started = await playThere({ on: true, volume: 60 });
      expect(theirs.appearance).toMatchObject({ ambientMusic: true, ambientVolume: 60 });
      expect(started.lines).toHaveLength(1);

      // Its own Settings turn keep-maximized on after the read: the card size still changes.
      theirs.appearance = {
        ...theirs.appearance,
        defaultCardSize: "usual",
        keepCardsMaximized: false,
      };
      theirs.editsAfterRead = (look) => ({ ...look, keepCardsMaximized: true });
      const sized = await tool("app_change").run({
        action: "card-size",
        value: { size: "wide" },
        evidence: "Open cards wide on Studio.",
        computer: "Studio",
      });
      expect(sized.text).not.toContain(WINDOW_ASK_WORDS.changedThere(["keepCardsMaximized"]));
      expect(theirs.appearance).toMatchObject({
        defaultCardSize: "wide",
        keepCardsMaximized: true,
      });

      // Its own Settings hide another panel after the read: the move still runs, and
      // the hidden panel stays hidden.
      const [moved, other] = knownPanels(core.services.personal.snapshot());
      if (!moved || !other) throw new Error("The core knows fewer than two panels");
      theirs.layout = await core.dispatch("inf:settings:layout:get", []);
      theirs.layoutEditsAfterRead = (layout) => ({
        ...layout,
        hiddenPanels: { ...layout.hiddenPanels, [other.id]: true },
      });
      const homeLayout = await core.dispatch("inf:settings:layout:get", []);
      const move = await tool("app_change").run({
        action: "panel",
        value: { surface: moved.id, rail: moved.preferred.x === "left" ? "right" : "left" },
        evidence: "Move it across on Studio.",
        computer: "Studio",
      });
      expect(move.text).not.toContain("changed in this computer's own Settings");
      expect(theirs.layout?.hiddenPanels[other.id]).toBe(true);
      expect(theirs.layout?.arrangement).not.toEqual(homeLayout.arrangement);
      expect(await core.dispatch("inf:settings:layout:get", [])).toEqual(homeLayout);

      // Check for updates there checks that Mac's own app, and says where.
      theirs.update = {
        ...(await core.dispatch("inf:update:status", [])),
        currentVersion: "1.0.0",
        latestVersion: "1.0.1",
        updateAvailable: true,
      };
      const checked = operations().length;
      const update = await tool("app_change").run({
        action: "update-check",
        value: {},
        evidence: "Check for updates on Studio.",
        computer: "Studio",
      });
      expect(JSON.parse(update.text).answer).toMatchObject({ latest: "1.0.1", available: true });
      expect(
        operations()
          .slice(checked)
          .map((task) => task.title),
      ).toEqual(["checked for updates: 1.0.1 is ready on Studio"]);
    } finally {
      window.mockRestore();
      devices.mockRestore();
    }
  });

  it("asks this computer's own window for its key reminder, and says when no window answers", async () => {
    const window = playWindow("local", { appearance: await appearance(), reminders: true });
    try {
      const switched = await asked("key-reminders", { on: false });
      expect(switched.reply.current).toEqual({ on: false });
      expect(switched.lines).toEqual(["key reminders off on this computer"]);
    } finally {
      window.mockRestore();
    }
    const unanswered = await tool("app_change").run({
      action: "key-reminders",
      value: { on: true },
      evidence: "Turn key reminders on.",
    });
    expect(unanswered.text).toContain("is not connected now");
  });
});
