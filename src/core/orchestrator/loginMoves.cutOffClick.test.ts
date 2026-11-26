import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type FakeCrewmate,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  reboot,
  tick,
} from "../../../tests/helpers/crewHarness";
import { boundAccount, seedRunning, threeLogins } from "../../../tests/helpers/loginMovesHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { crewmateHandoverDir } from "../paths";
import { startLowLogins } from "../quota/homeLowLogins";
import type { LoginReading } from "../quota/lowLogins";
import type { Router } from "../routing/router";
import { SettingsStore } from "../storage/settingsStore";
import { keepHandoverFiles } from "../tasks/handoverFiles";
import { seedTask } from "../tasks/seedTask";
import { SUPERVISOR_STEER } from "./crewRuntime";
import { BACKLOG_STEER_LINE } from "./crewTurns";
import { loginLowAsked, loginLowCardId } from "./loginCards";

fakeCrewTimersEachTest();

// The approved plan for several logins of one provider, piece 3, "Ask": a
// Move click the app quit on is finished or refused at the next launch, and
// what was sent to its tasks meanwhile is delivered once. Each case drives a
// real CrewSupervisor through the crew harness.

describe("the low-login card's Move click, cut off as the app quits", () => {
  const MODEL = { provider: "openai-codex", id: "gpt-6.1-terra" };
  const TASKS = ["t-move", "t-other"];
  const reading = (accountId: string, label: string, percent: number): LoginReading => ({
    accountId,
    label,
    enabled: true,
    connected: true,
    effectivePercentRemaining: percent,
  });

  type Vault = { pin: string; quitsAtPin: boolean; quitsAfterPin?: boolean; savedAtPin?: unknown };

  /** The home's watch over a supervisor, with the vault's pin and each login's reading. */
  function watching(
    h: ReturnType<typeof threeLogins>,
    supervisor: ReturnType<typeof reboot>,
    vault: Vault,
    readings: () => LoginReading[],
    choice: "ask" | "wait" = "ask",
  ) {
    const settings = new SettingsStore(h.db);
    return startLowLogins({
      settings: {
        getWhenLoginLow: () => choice,
        getLoginAnswersOver: () => settings.getLoginAnswersOver(),
        setLoginAnswersOver: (over) => settings.setLoginAnswersOver(over),
      },
      vault: {
        list: (providerId) =>
          providerId === "openai-codex"
            ? readings().map((login) => ({
                id: login.accountId,
                label: login.label,
                enabled: true,
              }))
            : [],
        pinnedAccount: () => vault.pin,
        setPin: (_providerId, accountId) => {
          // What the saved record names for the tasks as the pin is about to move.
          vault.savedAtPin = settings.getLoginMoves();
          if (vault.quitsAtPin) throw new Error("the app quit");
          vault.pin = accountId ?? vault.pin;
          if (vault.quitsAfterPin) throw new Error("the app quit");
        },
        onCutOffChange: () => {},
        cutOff: () => undefined,
      },
      routing: { accounts: { logins: readings }, attachLoginInUse: () => {} },
      quota: { latest: () => undefined },
      supervisor,
      broadcastEvent: () => {},
    });
  }

  it("moves every task on the low login to the login the click named, at its next delivery after the relaunch, though another login has more room by then", async () => {
    const h = threeLogins("openai-codex", fakeCrewmate({}), fakeCrewmate({}), false);
    for (const id of TASKS) {
      seedRunning(h, MODEL, `/tmp/${id}.jsonl`, id);
      // Its cost limit keeps each task's move from being made before the quit.
      h.costs.placeHold({ taskId: id, limitUsd: 50, spentUsd: 51.5, at: Date.now() });
    }
    const vault: Vault = {
      pin: "acct_personal",
      quitsAtPin: true,
    };
    const first = watching(h, h.supervisor, vault, () => [
      reading("acct_personal", "Personal", 4),
      reading("acct_work", "Work", 40),
      reading("acct_spare", "Spare", 60),
    ]);
    first.read();
    const cardId = loginLowCardId("openai-codex");
    // Each move is saved with the card raising its click answered.
    const click = loginLowAsked(h.supervisor.cards.stored(cardId)?.body ?? "")?.askId;
    expect(click).toBeTruthy();
    const named = { from: "acct_personal", to: "acct_spare", click };
    const bothNamed = { "t-move": named, "t-other": named };
    expect(h.supervisor.cards.stored(cardId)?.actions?.[0]?.label).toBe("Move to Spare");

    // The click; the app quits as the pin is about to be saved.
    expect(() =>
      h.supervisor.cardActions.act(cardId, "move-login-acct_personal-acct_spare"),
    ).toThrow("the app quit");
    expect(vault.savedAtPin).toEqual(bothNamed);
    expect(vault.pin).toBe("acct_personal");
    await h.supervisor.disposeAll();

    // The next launch: Work has the most room now, and the click named Spare.
    const boots: FakeCrewmate[] = [];
    const specs: { binding?: unknown }[] = [];
    const relaunched = reboot(
      h,
      async (spec: { binding?: unknown }) => {
        specs.push(spec);
        const boot = fakeCrewmate({});
        boots.push(boot);
        return boot;
      },
      { router: h.router as unknown as Router, ...h.relaunchWith },
    );
    vault.quitsAtPin = false;
    // A wake at startup, before the watch has checked the click: each task
    // waits, on neither the login it leaves nor the named one.
    for (const id of TASKS) h.costs.clearHold(id);
    for (const id of TASKS) await relaunched.steer.steerCrewmate(id, "Check the footer too.");
    await relaunched.watch.sweepInbox(Date.now());
    await tick();
    expect(specs).toEqual([]);
    expect(TASKS.map((id) => relaunched.loginMoves.awaitsCheck(id))).toEqual([true, true]);

    const second = watching(h, relaunched, vault, () => [
      reading("acct_personal", "Personal", 4),
      reading("acct_work", "Work", 95),
      reading("acct_spare", "Spare", 60),
    ]);
    second.read();
    second.read();
    await tick();
    expect(vault.pin).toBe("acct_spare");
    expect(vault.savedAtPin).toEqual(bothNamed);
    // The captain is not asked to choose again.
    expect(relaunched.cards.get(cardId)).toBeUndefined();

    await vi.waitFor(() =>
      expect(boots.filter((boot) => boot.promptCalls.length > 0)).toHaveLength(2),
    );
    expect(
      specs.map((spec) => (spec.binding as { accountId?: string } | undefined)?.accountId),
    ).toEqual(["acct_spare", "acct_spare"]);
    expect(TASKS.map((id) => h.tasks.get(id)?.accountId)).toEqual(["acct_spare", "acct_spare"]);
    expect(new SettingsStore(h.db).getLoginMoves()).toEqual({});
    await relaunched.disposeAll();
  });

  /** Two held tasks on Personal, the card up offering Spare, and the click cut off at the pin. */
  async function clickCutOff() {
    const h = threeLogins("openai-codex", fakeCrewmate({}), fakeCrewmate({}), false);
    for (const id of TASKS) {
      seedRunning(h, MODEL, `/tmp/${id}.jsonl`, id);
      h.costs.placeHold({ taskId: id, limitUsd: 50, spentUsd: 51.5, at: Date.now() });
    }
    const vault: Vault = {
      pin: "acct_personal",
      quitsAtPin: true,
    };
    const offeringSpare = () => [
      reading("acct_personal", "Personal", 4),
      reading("acct_work", "Work", 40),
      reading("acct_spare", "Spare", 60),
    ];
    const first = watching(h, h.supervisor, vault, offeringSpare);
    first.read();
    return { h, vault, first, cardId: loginLowCardId("openai-codex") };
  }

  it("opens no task on the named login when that login has run low by the relaunch, though the tasks' moves were already saved", async () => {
    const { h, vault, cardId } = await clickCutOff();
    expect(() =>
      h.supervisor.cardActions.act(cardId, "move-login-acct_personal-acct_spare"),
    ).toThrow("the app quit");
    expect(Object.keys(new SettingsStore(h.db).getLoginMoves())).toEqual(TASKS);
    await h.supervisor.disposeAll();

    const specs: { binding?: unknown }[] = [];
    const boots: FakeCrewmate[] = [];
    const relaunched = reboot(
      h,
      async (spec: { binding?: unknown }) => {
        specs.push(spec);
        const boot = fakeCrewmate({});
        boots.push(boot);
        return boot;
      },
      { router: h.router as unknown as Router, ...h.relaunchWith },
    );
    vault.quitsAtPin = false;
    // Spare has 3% left now; Work has room.
    const second = watching(h, relaunched, vault, () => [
      reading("acct_personal", "Personal", 4),
      reading("acct_work", "Work", 40),
      reading("acct_spare", "Spare", 3),
    ]);
    // Until the watch has read the logins, a wake opens no task anywhere.
    for (const id of TASKS) h.costs.clearHold(id);
    for (const id of TASKS) await relaunched.steer.steerCrewmate(id, "Check the footer too.");
    await relaunched.watch.sweepInbox(Date.now());
    await tick();
    expect(specs).toEqual([]);

    second.read();
    await tick();
    expect(TASKS.map((id) => relaunched.loginMoves.bindsTask(id))).toEqual([false, false]);
    expect(vault.pin).toBe("acct_personal");
    expect(new SettingsStore(h.db).getLoginMoves()).toEqual({});
    // The captain is asked about what is true now.
    expect(relaunched.cards.get(cardId)?.actions?.[0]?.label).toBe("Move to Work");

    // Refused, the click holds the tasks no longer: they carry on where they are.
    await relaunched.watch.sweepInbox(Date.now());
    await vi.waitFor(() =>
      expect(boots.filter((boot) => boot.promptCalls.length > 0)).toHaveLength(2),
    );
    expect(
      specs.map((spec) => (spec.binding as { accountId?: string } | undefined)?.accountId),
    ).toEqual(["acct_personal", "acct_personal"]);
    await relaunched.disposeAll();
  });

  it("keeps both tasks' moves to the named login when the app quit after the login in use was saved", async () => {
    const { h, vault, cardId } = await clickCutOff();
    vault.quitsAtPin = false;
    vault.quitsAfterPin = true;
    expect(() =>
      h.supervisor.cardActions.act(cardId, "move-login-acct_personal-acct_spare"),
    ).toThrow("the app quit");
    expect(vault.pin).toBe("acct_spare");
    await h.supervisor.disposeAll();

    const specs: { binding?: unknown }[] = [];
    const boots: FakeCrewmate[] = [];
    const relaunched = reboot(
      h,
      async (spec: { binding?: unknown }) => {
        specs.push(spec);
        const boot = fakeCrewmate({});
        boots.push(boot);
        return boot;
      },
      { router: h.router as unknown as Router, ...h.relaunchWith },
    );
    vault.quitsAfterPin = false;
    for (const id of TASKS) h.costs.clearHold(id);
    for (const id of TASKS) await relaunched.steer.steerCrewmate(id, "Check the footer too.");
    const second = watching(h, relaunched, vault, () => [
      reading("acct_personal", "Personal", 4),
      reading("acct_work", "Work", 95),
      reading("acct_spare", "Spare", 60),
    ]);
    second.read();
    await vi.waitFor(() =>
      expect(boots.filter((boot) => boot.promptCalls.length > 0)).toHaveLength(2),
    );
    expect(
      specs.map((spec) => (spec.binding as { accountId?: string } | undefined)?.accountId),
    ).toEqual(["acct_spare", "acct_spare"]);
    expect(vault.pin).toBe("acct_spare");
    expect(Object.keys(new SettingsStore(h.db).getLoginAnswersOver())).toEqual(["openai-codex"]);
    await relaunched.disposeAll();
  });

  it("names no task, moves no login in use and keeps the answer when the tasks' moves cannot be saved, then makes the whole move at the next reading", async () => {
    const { h, vault, first, cardId } = await clickCutOff();
    vault.quitsAtPin = false;
    const settings = new SettingsStore(h.db);
    const write = vi.spyOn(SettingsStore.prototype, "setLoginMoves").mockImplementationOnce(() => {
      throw new Error("the record could not be written");
    });
    expect(() =>
      h.supervisor.cardActions.act(cardId, "move-login-acct_personal-acct_spare"),
    ).toThrow("the record could not be written");
    expect(TASKS.map((id) => h.supervisor.loginMoves.bindsTask(id))).toEqual([false, false]);
    expect(settings.getLoginMoves()).toEqual({});
    expect(vault.pin).toBe("acct_personal");
    expect(settings.getLoginAnswersOver()).toEqual({});

    first.read();
    await tick();
    write.mockRestore();
    const click = loginLowAsked(h.supervisor.cards.stored(cardId)?.body ?? "")?.askId;
    expect(click).toBeTruthy();
    const named = { from: "acct_personal", to: "acct_spare", click };
    expect(settings.getLoginMoves()).toEqual({ "t-move": named, "t-other": named });
    expect(vault.pin).toBe("acct_spare");
    expect(Object.keys(settings.getLoginAnswersOver())).toEqual(["openai-codex"]);
    await h.supervisor.disposeAll();
  });

  it("opens neither task where it is while only the click is saved, then moves both to the named login once the logins are read", async () => {
    const { h, vault, cardId } = await clickCutOff();
    vault.quitsAtPin = false;
    // The app stops before any task's move is saved: the card's answer is all there is.
    const write = vi.spyOn(SettingsStore.prototype, "setLoginMoves").mockImplementationOnce(() => {
      throw new Error("the app quit");
    });
    expect(() =>
      h.supervisor.cardActions.act(cardId, "move-login-acct_personal-acct_spare"),
    ).toThrow("the app quit");
    write.mockRestore();
    expect(new SettingsStore(h.db).getLoginMoves()).toEqual({});
    await h.supervisor.disposeAll();

    const specs: { binding?: unknown }[] = [];
    const boots: FakeCrewmate[] = [];
    const relaunched = reboot(
      h,
      async (spec: { binding?: unknown }) => {
        specs.push(spec);
        const boot = fakeCrewmate({});
        boots.push(boot);
        return boot;
      },
      { router: h.router as unknown as Router, ...h.relaunchWith },
    );
    expect(TASKS.map((id) => relaunched.loginMoves.bindsTask(id))).toEqual([false, false]);
    // A wake at startup, before the logins are read.
    for (const id of TASKS) h.costs.clearHold(id);
    for (const id of TASKS) await relaunched.steer.steerCrewmate(id, "Check the footer too.");
    await relaunched.watch.sweepInbox(Date.now());
    await tick();
    expect(specs).toEqual([]);
    expect(TASKS.map((id) => relaunched.loginMoves.awaitsCheck(id))).toEqual([true, true]);

    const second = watching(h, relaunched, vault, () => [
      reading("acct_personal", "Personal", 4),
      reading("acct_work", "Work", 95),
      reading("acct_spare", "Spare", 60),
    ]);
    second.read();
    await vi.waitFor(() =>
      expect(boots.filter((boot) => boot.promptCalls.length > 0)).toHaveLength(2),
    );
    expect(
      specs.map((spec) => (spec.binding as { accountId?: string } | undefined)?.accountId),
    ).toEqual(["acct_spare", "acct_spare"]);
    expect(vault.pin).toBe("acct_spare");
    expect(TASKS.map((id) => relaunched.loginMoves.awaitsCheck(id))).toEqual([false, false]);
    await relaunched.disposeAll();
  });

  /**
   * After the click was cut off and the app relaunched, both tasks wait in
   * the backlog: one is sent a message, the other a message whose files
   * have crossed, while the click is still to be checked.
   */
  async function sentToBacklogBeforeTheCheck() {
    const { h, vault, cardId } = await clickCutOff();
    expect(() =>
      h.supervisor.cardActions.act(cardId, "move-login-acct_personal-acct_spare"),
    ).toThrow("the app quit");
    await h.supervisor.disposeAll();

    const specs: { binding?: unknown }[] = [];
    const boots: FakeCrewmate[] = [];
    const relaunched = reboot(
      h,
      async (spec: { binding?: unknown }) => {
        specs.push(spec);
        const boot = fakeCrewmate({});
        boots.push(boot);
        return boot;
      },
      { router: h.router as unknown as Router, ...h.relaunchWith },
    );
    vault.quitsAtPin = false;
    for (const id of TASKS) {
      h.costs.clearHold(id);
      expect(
        relaunched.hostOps.moveToBacklog(id, { actor: "firstmate", via: "tool", decision: null })
          .ok,
      ).toBe(true);
    }
    await expect(relaunched.steer.steerCrewmate("t-move", "Check the footer too.")).resolves.toBe(
      "recorded-held",
    );
    seedTask(h.tasks, { id: "t-finder", title: "Find the screenshot", status: "idle" });
    const picture = join(scratchDir("infinitary-handed-"), "clipped card.png");
    writeFileSync(picture, "a picture of the clipped card");
    await keepHandoverFiles([picture], crewmateHandoverDir(h.paths, "t-finder"));
    await relaunched.steer.steerAfterFiles("t-finder", "t-other", "look at it", {
      response: { mode: "guidance-only" as const },
    });
    await relaunched.watch.sweepInbox(Date.now());
    await tick();
    expect(specs).toEqual([]);
    const prompts = () => boots.flatMap((boot) => boot.promptCalls);
    const accounts = () =>
      specs.map((spec) => (spec.binding as { accountId?: string } | undefined)?.accountId);
    return { h, vault, relaunched, boots, prompts, accounts };
  }

  it("delivers what was sent to backlog tasks before the check on the named login once the click is accepted, with no second message or Start", async () => {
    const { h, vault, relaunched, boots, prompts, accounts } = await sentToBacklogBeforeTheCheck();
    watching(h, relaunched, vault, () => [
      reading("acct_personal", "Personal", 4),
      reading("acct_work", "Work", 95),
      reading("acct_spare", "Spare", 60),
    ]).read();
    await vi.waitFor(() =>
      expect(boots.filter((boot) => boot.promptCalls.length > 0)).toHaveLength(2),
    );
    expect(accounts()).toEqual(["acct_spare", "acct_spare"]);
    expect(prompts().every((prompt) => prompt.startsWith(BACKLOG_STEER_LINE))).toBe(true);
    expect(prompts().some((prompt) => prompt.includes("Check the footer too."))).toBe(true);
    expect(
      prompts().some((prompt) => /Files handed to you from [^\n]*\n\nlook at it/.test(prompt)),
    ).toBe(true);
    expect(TASKS.map((id) => h.tasks.get(id)?.backlogSince != null)).toEqual([true, true]);
    await relaunched.disposeAll();
  });

  it("delivers what was sent to backlog tasks before the check where they are once the click is refused, with no second message or Start", async () => {
    const { h, vault, relaunched, boots, prompts, accounts } = await sentToBacklogBeforeTheCheck();
    // Spare has 3% left now.
    watching(h, relaunched, vault, () => [
      reading("acct_personal", "Personal", 4),
      reading("acct_work", "Work", 40),
      reading("acct_spare", "Spare", 3),
    ]).read();
    await vi.waitFor(() =>
      expect(boots.filter((boot) => boot.promptCalls.length > 0)).toHaveLength(2),
    );
    expect(accounts()).toEqual(["acct_personal", "acct_personal"]);
    expect(prompts().every((prompt) => prompt.startsWith(BACKLOG_STEER_LINE))).toBe(true);
    expect(prompts().some((prompt) => prompt.includes("Check the footer too."))).toBe(true);
    expect(
      prompts().some((prompt) => /Files handed to you from [^\n]*\n\nlook at it/.test(prompt)),
    ).toBe(true);
    await relaunched.disposeAll();
  });

  it("delivers what was sent before the check as soon as the tasks' moves are named, whatever else the reading settles", async () => {
    const { h, vault, relaunched, boots, prompts, accounts } = await sentToBacklogBeforeTheCheck();
    // Nothing but the naming of the moves tells the tasks the click was checked.
    const forget = vi.spyOn(relaunched.loginMoves, "forget").mockImplementation(() => {});
    watching(h, relaunched, vault, () => [
      reading("acct_personal", "Personal", 4),
      reading("acct_work", "Work", 95),
      reading("acct_spare", "Spare", 60),
    ]).read();
    await vi.waitFor(() =>
      expect(boots.filter((boot) => boot.promptCalls.length > 0)).toHaveLength(2),
    );
    forget.mockRestore();
    expect(accounts()).toEqual(["acct_spare", "acct_spare"]);
    expect(prompts().every((prompt) => prompt.startsWith(BACKLOG_STEER_LINE))).toBe(true);
    await relaunched.disposeAll();
  });

  it("delivers what was sent to a backlog task with its conversation open before the check, on the named login once the click is accepted", async () => {
    const { h, vault, first, cardId } = await clickCutOff();
    for (const id of TASKS) {
      h.costs.clearHold(id);
      expect(
        h.supervisor.hostOps.moveToBacklog(id, { actor: "firstmate", via: "tool", decision: null })
          .ok,
      ).toBe(true);
    }
    await h.supervisor.sessions.resumeTask("t-move");
    expect(boundAccount(h, 0)).toBe("acct_personal");
    expect(() =>
      h.supervisor.cardActions.act(cardId, "move-login-acct_personal-acct_spare"),
    ).toThrow("the app quit");
    await expect(h.supervisor.steer.steerCrewmate("t-move", "Check the footer too.")).resolves.toBe(
      "recorded-held",
    );
    await tick();
    expect(h.inbox.allFor("t-move").filter((row) => row.deliveredAt == null)).toHaveLength(1);

    vault.quitsAtPin = false;
    first.read();
    await vi.waitFor(() =>
      expect(h.inbox.allFor("t-move").filter((row) => row.deliveredAt == null)).toHaveLength(0),
    );
    expect(h.tasks.get("t-move")?.accountId).toBe("acct_spare");
    expect(boundAccount(h, 1)).toBe("acct_spare");
    expect(h.tasks.get("t-move")?.backlogSince != null).toBe(true);
    await h.supervisor.disposeAll();
  });

  /**
   * The click was cut off and the app relaunched; both tasks are in the
   * backlog and nothing has read the logins yet.
   */
  async function relaunchedInBacklog() {
    const { h, vault, cardId } = await clickCutOff();
    expect(() =>
      h.supervisor.cardActions.act(cardId, "move-login-acct_personal-acct_spare"),
    ).toThrow("the app quit");
    await h.supervisor.disposeAll();
    const specs: { binding?: unknown }[] = [];
    const boots: FakeCrewmate[] = [];
    const relaunched = reboot(
      h,
      async (spec: { binding?: unknown }) => {
        specs.push(spec);
        const boot = fakeCrewmate({});
        boots.push(boot);
        return boot;
      },
      { router: h.router as unknown as Router, ...h.relaunchWith },
    );
    vault.quitsAtPin = false;
    for (const id of TASKS) {
      h.costs.clearHold(id);
      expect(
        relaunched.hostOps.moveToBacklog(id, { actor: "firstmate", via: "tool", decision: null })
          .ok,
      ).toBe(true);
    }
    const prompts = () => boots.flatMap((boot) => boot.promptCalls);
    const accounts = () =>
      specs.map((spec) => (spec.binding as { accountId?: string } | undefined)?.accountId);
    const read = (spare: number) =>
      watching(h, relaunched, vault, () => [
        reading("acct_personal", "Personal", 4),
        reading("acct_work", "Work", spare < 10 ? 40 : 95),
        reading("acct_spare", "Spare", spare),
      ]).read();
    return { h, relaunched, boots, prompts, accounts, read };
  }

  // docs/inbox.md: the host's own steer waits on a started task's lane in the backlog until a Start.
  it("starts no turn in the backlog for the host's own notice kept while the click was unchecked", async () => {
    const { h, relaunched, prompts, read } = await relaunchedInBacklog();
    await expect(
      relaunched.steer.steerInternal("t-move", "Checks passed.", SUPERVISOR_STEER),
    ).resolves.toBe("recorded-held");
    read(60);
    await tick();
    await relaunched.watch.sweepInbox(Date.now());
    await tick();
    expect(prompts()).toEqual([]);
    expect(h.inbox.allFor("t-move").filter((row) => row.deliveredAt == null)).toHaveLength(1);
    expect(h.tasks.get("t-move")?.backlogSince != null).toBe(true);
    await relaunched.disposeAll();
  });

  it("keeps a sent message's wake through a cost limit that outlasts the click's check, and delivers it on the named login when the limit is lifted", async () => {
    const { h, relaunched, prompts, accounts, read } = await relaunchedInBacklog();
    await expect(relaunched.steer.steerCrewmate("t-move", "Check the footer too.")).resolves.toBe(
      "recorded-held",
    );
    h.costs.placeHold({ taskId: "t-move", limitUsd: 50, spentUsd: 51.5, at: Date.now() });
    read(60);
    await tick();
    await relaunched.watch.sweepInbox(Date.now());
    await tick();
    expect(prompts()).toEqual([]);

    h.costs.clearHold("t-move");
    await relaunched.watch.sweepTaskLane("t-move", Date.now());
    await vi.waitFor(() => expect(prompts()).toHaveLength(1));
    expect(prompts()[0]?.startsWith(BACKLOG_STEER_LINE)).toBe(true);
    expect(prompts()[0]).toContain("Check the footer too.");
    expect(accounts()).toEqual(["acct_spare"]);
    expect(h.tasks.get("t-move")?.backlogSince != null).toBe(true);
    // Taken, it is owed no more: a later sweep opens nothing.
    await relaunched.watch.sweepTaskLane("t-move", Date.now());
    await tick();
    expect(prompts()).toHaveLength(1);
    await relaunched.disposeAll();
  });

  it("starts no turn for the host's own notice kept while the click was unchecked, in a backlog task whose conversation is open", async () => {
    const { h, vault, first, cardId } = await clickCutOff();
    for (const id of TASKS) {
      h.costs.clearHold(id);
      expect(
        h.supervisor.hostOps.moveToBacklog(id, { actor: "firstmate", via: "tool", decision: null })
          .ok,
      ).toBe(true);
    }
    await h.supervisor.sessions.resumeTask("t-move");
    expect(() =>
      h.supervisor.cardActions.act(cardId, "move-login-acct_personal-acct_spare"),
    ).toThrow("the app quit");
    await expect(
      h.supervisor.steer.steerInternal("t-move", "Checks passed.", SUPERVISOR_STEER),
    ).resolves.toBe("recorded-held");

    vault.quitsAtPin = false;
    first.read();
    await vi.waitFor(() => expect(h.tasks.get("t-move")?.accountId).toBe("acct_spare"));
    await tick();
    await h.supervisor.watch.sweepInbox(Date.now());
    await tick();
    expect(h.inbox.allFor("t-move").filter((row) => row.deliveredAt == null)).toHaveLength(1);
    await h.supervisor.disposeAll();
  });

  it("keeps a sent message's wake when a cost limit is reached as the conversation opens after the click is refused, and delivers it when the limit is lifted", async () => {
    const { h, relaunched, prompts, accounts, read } = await relaunchedInBacklog();
    await expect(relaunched.steer.steerCrewmate("t-move", "Check the footer too.")).resolves.toBe(
      "recorded-held",
    );
    const resume = relaunched.sessions.resumeTask.bind(relaunched.sessions);
    const open = vi
      .spyOn(relaunched.sessions, "resumeTask")
      .mockImplementationOnce(async (...args) => {
        const opened = await resume(...args);
        h.costs.placeHold({ taskId: "t-move", limitUsd: 50, spentUsd: 51.5, at: Date.now() });
        return opened;
      });
    read(3);
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    await tick();
    expect(prompts()).toEqual([]);

    h.costs.clearHold("t-move");
    await relaunched.watch.sweepTaskLane("t-move", Date.now());
    await vi.waitFor(() => expect(prompts()).toHaveLength(1));
    expect(prompts()[0]?.startsWith(BACKLOG_STEER_LINE)).toBe(true);
    expect(accounts()).toEqual(["acct_personal"]);
    await relaunched.disposeAll();
  });

  // docs/inbox.md: a refused delivery backs off, and the host's own notice waits in the backlog for a Start.
  it.each([
    { click: "accepted", spare: 60, account: "acct_spare" },
    { click: "refused", spare: 3, account: "acct_personal" },
  ])(
    "backs a kept sent message off at once when its conversation does not open after the click is $click, starts no turn for a host notice due beside it, and delivers it when it is due",
    async ({ spare, account }) => {
      const { h, relaunched, prompts, accounts, read } = await relaunchedInBacklog();
      await expect(relaunched.steer.steerCrewmate("t-move", "Check the footer too.")).resolves.toBe(
        "recorded-held",
      );
      const open = vi
        .spyOn(relaunched.sessions, "resumeTask")
        .mockRejectedValueOnce(new Error("could not open"));
      const now = Date.now();
      read(spare);
      await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
      await tick();
      expect(prompts()).toEqual([]);
      expect(h.tasks.get("t-move")?.accountId).toBe(account);
      const next = Math.max(...h.inbox.allFor("t-move").map((row) => row.nextAttemptAt ?? 0));
      expect(next).toBeGreaterThan(now);

      // The host's own notice is due now; the sent message is not.
      await expect(
        relaunched.steer.steerInternal("t-move", "Checks passed.", SUPERVISOR_STEER),
      ).resolves.toBe("recorded-held");
      await relaunched.watch.sweepTaskLane("t-move", now);
      await tick();
      expect(open).toHaveBeenCalledTimes(1);
      expect(prompts()).toEqual([]);

      vi.setSystemTime(next);
      await relaunched.watch.sweepTaskLane("t-move", next);
      await vi.waitFor(() => expect(prompts()).toHaveLength(1));
      expect(prompts()[0]?.startsWith(BACKLOG_STEER_LINE)).toBe(true);
      expect(prompts()[0]).toContain("Check the footer too.");
      expect(accounts()).toEqual([account]);
      await relaunched.disposeAll();
    },
  );

  // docs/inbox.md: a refused delivery spends the try of the rows it was made for.
  it.each([
    { click: "accepted", spare: 60 },
    { click: "refused", spare: 3 },
  ])(
    "spends no try of a host notice that arrives while a kept sent message's conversation is opening, when that opening fails after the click is $click",
    async ({ spare }) => {
      const { h, relaunched, prompts, read } = await relaunchedInBacklog();
      await expect(relaunched.steer.steerCrewmate("t-move", "Check the footer too.")).resolves.toBe(
        "recorded-held",
      );
      let fail: (caught: Error) => void = () => {};
      const open = vi.spyOn(relaunched.sessions, "resumeTask").mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            fail = reject;
          }),
      );
      const now = Date.now();
      read(spare);
      await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
      await expect(
        relaunched.steer.steerInternal("t-move", "Checks passed.", SUPERVISOR_STEER),
      ).resolves.toBe("recorded-held");
      fail(new Error("could not open"));
      await tick();
      expect(prompts()).toEqual([]);
      const [sent, notice] = h.inbox.allFor("t-move");
      expect(sent?.attempts).toBe(1);
      expect(sent?.nextAttemptAt ?? 0).toBeGreaterThan(now);
      expect(notice?.attempts).toBe(0);
      expect(notice?.nextAttemptAt).toBeNull();
      await relaunched.disposeAll();
    },
  );

  it("leaves a row another delivery took while the conversation was opening as that delivery left it, when the opening fails", async () => {
    const { h, relaunched, read } = await relaunchedInBacklog();
    await expect(relaunched.steer.steerCrewmate("t-move", "Check the footer too.")).resolves.toBe(
      "recorded-held",
    );
    let fail: (caught: Error) => void = () => {};
    const open = vi.spyOn(relaunched.sessions, "resumeTask").mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    read(3);
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    const taken = h.inbox.allFor("t-move").map((row) => row.id);
    h.inbox.markDelivered(taken);
    fail(new Error("could not open"));
    await tick();
    expect(taken).toHaveLength(1);
    const sent = h.inbox.get(taken[0] ?? -1);
    expect(sent?.deliveredAt).toEqual(expect.any(Number));
    expect(sent?.attempts).toBe(1);
    await relaunched.disposeAll();
  });

  // docs/inbox.md: guidance a failed turn gives back is tried again.
  it("delivers a kept sent message again when it is due, after the turn that took it failed and a sweep ran while that turn held it", async () => {
    const { h, relaunched, boots, prompts, read } = await relaunchedInBacklog();
    await expect(relaunched.steer.steerCrewmate("t-move", "Check the footer too.")).resolves.toBe(
      "recorded-held",
    );
    read(60);
    await vi.waitFor(() => expect(prompts()).toHaveLength(1));
    expect(prompts()[0]).toContain("Check the footer too.");

    // Another row waits on the lane and the lane is swept while the turn holds the sent row.
    h.inbox.enqueue("t-move", "A note from the host.");
    await relaunched.watch.sweepTaskLane("t-move", Date.now());
    await tick();
    boots[0]?.emit({ type: "turn_failed", taskId: "t-move", error: '{"detail":"Bad Request"}' });
    boots[0]?.emit({ type: "turn_end", taskId: "t-move" });
    boots[0]?.finishPrompt();
    await tick();
    expect(prompts()).toHaveLength(1);
    expect(h.tasks.get("t-move")?.backlogSince != null).toBe(true);

    const next = Math.max(...h.inbox.allFor("t-move").map((row) => row.nextAttemptAt ?? 0));
    expect(next).toBeGreaterThan(Date.now());
    vi.setSystemTime(next);
    await relaunched.watch.sweepTaskLane("t-move", next);
    await vi.waitFor(() => expect(prompts()).toHaveLength(2));
    expect(prompts()[1]?.startsWith(BACKLOG_STEER_LINE)).toBe(true);
    expect(prompts()[1]).toContain("Check the footer too.");
    await relaunched.disposeAll();
  });

  // docs/inbox.md: a message the captain or first mate sends still reaches a started task in the backlog.
  it.each([
    { click: "accepted", spare: 60 },
    { click: "refused", spare: 3 },
  ])(
    "reads a kept sent message in the first turn it wakes, behind a full page of override notices that alone start none, after the click is $click",
    async ({ spare }) => {
      const { h, relaunched, prompts, read } = await relaunchedInBacklog();
      const override = (i: number) => ({
        facts: {
          kind: "task-override-changed" as const,
          task: { id: "t-move", key: "INA-1", title: "Move" },
          override: {
            words: `Override note ${i}.`,
            holds: ["asks-first" as const],
            until: "task" as const,
          },
        },
      });
      const waiting = h.inbox.pending("t-move").length;
      for (let i = 0; waiting + i < 50; i++) h.inbox.enqueue("t-move", override(i));
      expect(h.inbox.pending("t-move")).toHaveLength(50);
      // The notices alone start no turn in the backlog.
      await relaunched.watch.sweepTaskLane("t-move", Date.now());
      await tick();
      expect(prompts()).toEqual([]);

      await expect(relaunched.steer.steerCrewmate("t-move", "Check the footer too.")).resolves.toBe(
        "recorded-held",
      );
      read(spare);
      await vi.waitFor(() => expect(prompts()).toHaveLength(1));
      expect(prompts()[0]?.startsWith(BACKLOG_STEER_LINE)).toBe(true);
      expect(prompts()[0]).toContain("Check the footer too.");
      expect(prompts()[0]).toContain("Override note 0.");
      expect(h.tasks.get("t-move")?.backlogSince != null).toBe(true);
      await relaunched.disposeAll();
    },
  );

  it.each([
    { where: "behind a full page of override notices", before: 50 },
    {
      where: "with the files line last on a full page and the message first on the next",
      before: 49,
    },
  ])(
    "reads a file hand-over's line and its message in the first turn they wake, $where",
    async ({ before }) => {
      const { h, relaunched, prompts, read } = await relaunchedInBacklog();
      const waiting = h.inbox.pending("t-move").length;
      for (let i = 0; waiting + i < before; i++)
        h.inbox.enqueue("t-move", {
          facts: {
            kind: "task-override-changed",
            task: { id: "t-move", key: "INA-1", title: "Move" },
            override: { words: `Override note ${i}.`, holds: ["asks-first"], until: "task" },
          },
        });
      seedTask(h.tasks, { id: "t-finder", title: "Find the screenshot", status: "idle" });
      const picture = join(scratchDir("infinitary-handed-"), "clipped card.png");
      writeFileSync(picture, "a picture of the clipped card");
      await keepHandoverFiles([picture], crewmateHandoverDir(h.paths, "t-finder"));
      await relaunched.steer.steerAfterFiles("t-finder", "t-move", "look at it", {
        response: { mode: "guidance-only" as const },
      });
      await vi.waitFor(() => expect(relaunched.steer.handingOver("t-move")).toBe(false));
      await tick();
      expect(prompts()).toEqual([]);
      expect(h.inbox.allFor("t-move")).toHaveLength(before + 2);

      read(60);
      await vi.waitFor(() => expect(prompts()).toHaveLength(1));
      expect(prompts()[0]?.startsWith(BACKLOG_STEER_LINE)).toBe(true);
      expect(prompts()[0]).toMatch(/Files handed to you from [^\n]*\n\nlook at it/);
      expect(prompts()[0]).toContain("Override note 0.");
      await relaunched.disposeAll();
    },
  );

  // docs/inbox.md: a refused delivery spends the try of the rows it was made for.
  it("backs off a file hand-over's line, last on a full page, and its message, first on the next, with the rows that would have gone with them, when the conversation does not open", async () => {
    const { h, relaunched, prompts, read } = await relaunchedInBacklog();
    const waiting = h.inbox.pending("t-move").length;
    for (let i = 0; waiting + i < 49; i++) h.inbox.enqueue("t-move", `Host note ${i}.`);
    seedTask(h.tasks, { id: "t-finder", title: "Find the screenshot", status: "idle" });
    const picture = join(scratchDir("infinitary-handed-"), "clipped card.png");
    writeFileSync(picture, "a picture of the clipped card");
    await keepHandoverFiles([picture], crewmateHandoverDir(h.paths, "t-finder"));
    await relaunched.steer.steerAfterFiles("t-finder", "t-move", "look at it", {
      response: { mode: "guidance-only" as const },
    });
    await vi.waitFor(() => expect(relaunched.steer.handingOver("t-move")).toBe(false));
    h.costs.placeHold({ taskId: "t-move", limitUsd: 50, spentUsd: 51.5, at: Date.now() });
    read(60);
    await tick();
    h.costs.clearHold("t-move");
    const open = vi
      .spyOn(relaunched.sessions, "resumeTask")
      .mockRejectedValueOnce(new Error("could not open"));
    const now = Date.now();
    await relaunched.watch.sweepTaskLane("t-move", now);
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    await tick();
    expect(prompts()).toEqual([]);
    const rows = h.inbox.allFor("t-move");
    expect(rows).toHaveLength(51);
    // The files line and its message, with the 48 oldest rows; the 49th row gave up its place.
    expect(rows.map((row) => row.attempts)).toEqual([...Array(48).fill(1), 0, 1, 1]);
    for (const sent of rows.slice(49)) expect(sent.nextAttemptAt ?? 0).toBeGreaterThan(now);
    expect(rows[48]?.nextAttemptAt ?? 0).toBeLessThanOrEqual(now);
    await relaunched.disposeAll();
  });

  // docs/inbox.md: a refused delivery spends the try of the rows it was made for.
  it("backs off the kept sent message behind a full page, with the rows that would have gone with it, when its conversation does not open at the lane's sweep", async () => {
    const { h, relaunched, prompts, read } = await relaunchedInBacklog();
    const waiting = h.inbox.pending("t-move").length;
    for (let i = 0; waiting + i < 50; i++) h.inbox.enqueue("t-move", `Host note ${i}.`);
    await expect(relaunched.steer.steerCrewmate("t-move", "Check the footer too.")).resolves.toBe(
      "recorded-held",
    );
    h.costs.placeHold({ taskId: "t-move", limitUsd: 50, spentUsd: 51.5, at: Date.now() });
    read(60);
    await tick();
    h.costs.clearHold("t-move");
    const open = vi
      .spyOn(relaunched.sessions, "resumeTask")
      .mockRejectedValueOnce(new Error("could not open"));
    const now = Date.now();
    await relaunched.watch.sweepTaskLane("t-move", now);
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    await tick();
    expect(prompts()).toEqual([]);
    const rows = h.inbox.allFor("t-move");
    const sent = rows[rows.length - 1];
    expect(sent?.attempts).toBe(1);
    expect(sent?.nextAttemptAt ?? 0).toBeGreaterThan(now);
    // 49 older rows were in the batch with it; the page's newest row was not.
    expect(rows.filter((row) => row.attempts === 1)).toHaveLength(50);
    expect(rows[rows.length - 2]?.attempts).toBe(0);
    await relaunched.disposeAll();
  });

  it("delivers files whose crossing ended while the click was unchecked to a backlog task with its conversation open, on the named login once the click is accepted", async () => {
    const { h, vault, first, cardId } = await clickCutOff();
    for (const id of TASKS) {
      h.costs.clearHold(id);
      expect(
        h.supervisor.hostOps.moveToBacklog(id, { actor: "firstmate", via: "tool", decision: null })
          .ok,
      ).toBe(true);
    }
    await h.supervisor.sessions.resumeTask("t-other");
    expect(boundAccount(h, 0)).toBe("acct_personal");
    expect(() =>
      h.supervisor.cardActions.act(cardId, "move-login-acct_personal-acct_spare"),
    ).toThrow("the app quit");
    seedTask(h.tasks, { id: "t-finder", title: "Find the screenshot", status: "idle" });
    const picture = join(scratchDir("infinitary-handed-"), "clipped card.png");
    writeFileSync(picture, "a picture of the clipped card");
    await keepHandoverFiles([picture], crewmateHandoverDir(h.paths, "t-finder"));
    await h.supervisor.steer.steerAfterFiles("t-finder", "t-other", "look at it", {
      response: { mode: "guidance-only" as const },
    });
    await vi.waitFor(() => expect(h.supervisor.steer.handingOver("t-other")).toBe(false));
    await tick();
    const waiting = () => h.inbox.allFor("t-other").filter((row) => row.deliveredAt == null);
    expect(waiting().length).toBeGreaterThan(0);

    vault.quitsAtPin = false;
    first.read();
    await vi.waitFor(() => expect(waiting()).toHaveLength(0));
    expect(h.tasks.get("t-other")?.accountId).toBe("acct_spare");
    expect(boundAccount(h, 1)).toBe("acct_spare");
    expect(h.tasks.get("t-other")?.backlogSince != null).toBe(true);
    await h.supervisor.disposeAll();
  });

  it("delivers files whose crossing ended after the click was cut off, on the named login once the click is checked", async () => {
    const { h, vault } = await clickCutOff();
    await h.supervisor.disposeAll();
    const specs: { binding?: unknown }[] = [];
    const boots: FakeCrewmate[] = [];
    const relaunched = reboot(
      h,
      async (spec: { binding?: unknown }) => {
        specs.push(spec);
        const boot = fakeCrewmate({});
        boots.push(boot);
        return boot;
      },
      { router: h.router as unknown as Router, ...h.relaunchWith },
    );
    // The card the last launch left open is still to be answered.
    const watch = watching(h, relaunched, vault, () => [
      reading("acct_personal", "Personal", 4),
      reading("acct_work", "Work", 95),
      reading("acct_spare", "Spare", 60),
    ]);
    for (const id of TASKS) {
      h.costs.clearHold(id);
      expect(
        relaunched.hostOps.moveToBacklog(id, { actor: "firstmate", via: "tool", decision: null })
          .ok,
      ).toBe(true);
    }
    seedTask(h.tasks, { id: "t-finder", title: "Find the screenshot", status: "idle" });
    const picture = join(scratchDir("infinitary-handed-"), "clipped card.png");
    writeFileSync(picture, "a picture of the clipped card");
    await keepHandoverFiles([picture], crewmateHandoverDir(h.paths, "t-finder"));
    // Sent with no click made yet; the click is cut off while the files cross.
    await relaunched.steer.steerAfterFiles("t-finder", "t-other", "look at it", {
      response: { mode: "guidance-only" as const },
    });
    expect(relaunched.steer.handingOver("t-other")).toBe(true);
    expect(() =>
      relaunched.cardActions.act(
        loginLowCardId("openai-codex"),
        "move-login-acct_personal-acct_spare",
      ),
    ).toThrow("the app quit");
    await vi.waitFor(() => expect(relaunched.steer.handingOver("t-other")).toBe(false));
    await tick();
    expect(specs).toEqual([]);

    vault.quitsAtPin = false;
    watch.read();
    await vi.waitFor(() =>
      expect(boots.filter((boot) => boot.promptCalls.length > 0)).toHaveLength(1),
    );
    const prompt = boots.flatMap((boot) => boot.promptCalls)[0] ?? "";
    expect(prompt.startsWith(BACKLOG_STEER_LINE)).toBe(true);
    expect(prompt).toMatch(/Files handed to you from [^\n]*\n\nlook at it/);
    expect(
      specs.map((spec) => (spec.binding as { accountId?: string } | undefined)?.accountId),
    ).toContain("acct_spare");
    expect(h.tasks.get("t-other")?.accountId).toBe("acct_spare");
    await relaunched.disposeAll();
  });

  it("takes down at the first reading a card left open by the last launch, once the choice is wait", async () => {
    const { h, vault, cardId } = await clickCutOff();
    expect(h.supervisor.cards.get(cardId)).toBeDefined();
    await h.supervisor.disposeAll();

    const relaunched = reboot(h, async () => fakeCrewmate({}), {
      router: h.router as unknown as Router,
      ...h.relaunchWith,
    });
    // The card store brought the unanswered card back.
    expect(relaunched.cards.get(cardId)).toBeDefined();
    const second = watching(
      h,
      relaunched,
      vault,
      () => [
        reading("acct_personal", "Personal", 4),
        reading("acct_work", "Work", 40),
        reading("acct_spare", "Spare", 60),
      ],
      "wait",
    );
    second.read();
    expect(relaunched.cards.get(cardId)).toBeUndefined();
    await relaunched.disposeAll();
  });
});
