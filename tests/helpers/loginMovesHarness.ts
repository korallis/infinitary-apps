import { DEFAULT_COST_LIMIT } from "@shared/costLimit";
import { vi } from "vitest";
import type {
  AccountAttachment,
  CrewSupervisorOptions,
} from "../../src/core/orchestrator/crewSupervisorOptions";
import { loginMoveUnchecked } from "../../src/core/quota/homeLowLogins";
import { type AccountPool, AccountSelector } from "../../src/core/routing/accountRouter";
import { CardStore } from "../../src/core/storage/cardStore";
import { CostLimitStore } from "../../src/core/storage/costLimitStore";
import { DecisionStore } from "../../src/core/storage/decisionStore";
import { SettingsStore } from "../../src/core/storage/settingsStore";
import { seedTask } from "../../src/core/tasks/seedTask";
import { type FakeCrewmate, fakeCrewmate, setup } from "./crewHarness";
import type { FakeSessionOptions } from "./fakeSession";

// The stand-ins the login-move delivery tests share: three logins of one
// provider over a real CrewSupervisor (`setup`), and a task running on one.

/** A crewmate whose backend queues words sent during a turn on its lane. */
export function queueingCrewmate(options: FakeSessionOptions): FakeCrewmate {
  return {
    ...fakeCrewmate(options),
    controlProfile: {
      steer: "followup-queue",
      interruptGranularity: "process",
      quotaEvents: false,
      backgroundWork: "host",
      failureSignals: "text",
    },
    steer: vi.fn(async () => {
      throw new Error("this crewmate cannot be steered mid-turn");
    }),
  };
}

/** A provider's typed run-out on a login, as the vault keeps it; it refills a day after the fake clock's start. */
export const RAN_OUT = { class: "no_headroom" as const, since: 0, resetsAt: 86_400_000 * 20_000 };

/** Three logins of one provider: Personal, where the task runs, Work and Spare. */
export function threeLogins(
  provider: string,
  first: FakeCrewmate,
  second: FakeCrewmate,
  claude: boolean,
  cutOffs = new Map<string, typeof RAN_OUT>(),
  /** Each account pick waits for this, as a pick that reads a login's models does. */
  beforePick: () => Promise<void> = async () => {},
  /** The model a task commissioned here is routed to; it starts on Personal. */
  routedModel?: { provider: string; id: string },
) {
  let costs: CostLimitStore | undefined;
  const pool: AccountPool = {
    list: () =>
      [
        { id: "acct_personal", label: "Personal" },
        { id: "acct_work", label: "Work" },
        { id: "acct_spare", label: "Spare" },
      ].map((login) => ({ ...login, providerId: provider, enabled: true })),
    // The click already made Work the login in use.
    pinnedAccount: () => "acct_work",
    connectedSync: () => true,
    withheldReason: () => undefined,
    cutOff: (accountId) => cutOffs.get(accountId),
    markSelected: () => {},
  };
  let accounts: AccountSelector | undefined;
  const attachment: AccountAttachment = {
    selectForSpawn: () => (routedModel ? "acct_personal" : undefined),
    pickForSpawn: async (...args) => {
      await beforePick();
      return (accounts as AccountSelector).pickForSpawn(...args);
    },
    reselectForResume: (...args) => (accounts as AccountSelector).reselectForResume(...args),
    labelOf: (accountId) => (accounts as AccountSelector).labelOf(accountId),
  };
  // The app's own saved record of the moves still to make.
  let moveRecord: NonNullable<CrewSupervisorOptions["loginMoveRecord"]> | undefined;
  const h = setup(first, {
    loginMoveRecord: (db) => {
      const settings = new SettingsStore(db);
      moveRecord = {
        read: () => settings.getLoginMoves(),
        write: (moves) => settings.setLoginMoves(moves),
        // As the home wires it: read from the saved card and the record of ended answers.
        unchecked: (move) => {
          const cards = new CardStore(db);
          return loginMoveUnchecked(
            {
              cards: {
                chosenAction: (id) => cards.chosenAction(id),
                stored: (id) => cards.get(id),
              },
              settings,
              vault: {
                list: (providerId) => pool.list().filter((a) => a.providerId === providerId),
              },
            },
            move,
          );
        },
      };
      return moveRecord;
    },
    crewmates: [second],
    costLimits: (db) => {
      costs = new CostLimitStore(db);
      return { store: costs, appLimit: () => DEFAULT_COST_LIMIT };
    },
    serveability: {
      cutOff: (accountId) => cutOffs.get(accountId),
      providerName: () => "ChatGPT",
    },
    ...(claude
      ? {
          alsoServes: ["claude"] as const,
          bind: async (accountId) => ({ backend: "claude" as const, accountId: accountId ?? "" }),
        }
      : {}),
    ...(routedModel ? { routedModel } : {}),
    accounts: attachment,
  });
  accounts = new AccountSelector({
    pool,
    quota: { latest: () => undefined },
    flagshipAccountId: () => null,
    decisions: new DecisionStore(h.db),
    loginInUse: { whenLow: () => "ask", pin: () => {} },
  });
  return {
    ...h,
    costs: costs as CostLimitStore,
    /** What the next launch is built with over the same saved state (`reboot`). */
    relaunchWith: {
      accounts: attachment,
      loginMoveRecord: moveRecord as NonNullable<CrewSupervisorOptions["loginMoveRecord"]>,
      costLimits: { store: costs as CostLimitStore, appLimit: () => DEFAULT_COST_LIMIT },
    },
  };
}

export function seedRunning(
  h: ReturnType<typeof setup>,
  model: { provider: string; id: string },
  sessionFile: string,
  id = "t-move",
) {
  seedTask(h.tasks, {
    id,
    title: "Fix the login form",
    prompt: "old work",
    repoId: null,
    repoDir: "/tmp/repo",
    worktreeDir: `/tmp/wt-${id}`,
    branch: `fm/task-${id}`,
    sessionFile,
    accountId: "acct_personal",
    model,
    status: "idle",
    createdAt: Date.now(),
  });
  h.tasks.recordBrief(id, ["Goal: fix the login form."]);
}

/** How many times the center was told something sent reached a crewmate. */
export const reached = (h: ReturnType<typeof setup>) =>
  h.events.filter((event) => event.type === "task_event" && event.kind === "reached").length;

export const boundAccount = (h: ReturnType<typeof setup>, index: number) =>
  (h.sessionSpecs[index]?.binding as { accountId?: string } | undefined)?.accountId;
