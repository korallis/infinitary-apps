import type { QuotaSnapshotView } from "@shared/quota";
import type { WhenLoginLow } from "@shared/whenLoginLow";
import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../storage/db";
import { DecisionStore } from "../storage/decisionStore";
import { type AccountPool, AccountSelector } from "./accountRouter";

// The approved plan for several logins of one provider, piece 3, "Login in
// use": under `wait` and `ask` a pick serves only the provider's pin, and a
// provider with several logins and no pin gets the picked login as its pin;
// under `spread` and `move` the pick is by spend priority, as before.

type Login = { id: string; percent: number; enabled?: boolean };

function reading(logins: readonly Login[]): QuotaSnapshotView {
  return {
    generatedAt: "2026-08-17T12:00:00Z",
    fetchedAt: Date.parse("2026-08-17T12:00:00Z"),
    providers: logins.map((login) => ({
      provider: "codex",
      label: "Codex",
      accountId: login.id,
      accountLabel: login.id,
      status: "ok" as const,
      stale: false,
      windows: [{ id: "weekly", label: "weekly", percentRemaining: login.percent }],
    })),
  };
}

function selectorOver(
  logins: readonly Login[],
  choice: WhenLoginLow,
  pinned?: string,
  /** The models a login's sign-in lists, when it lists any. */
  lists: Record<string, string[]> = {},
) {
  const pins: { providerId: string; accountId: string }[] = [];
  let pin = pinned;
  const pool: AccountPool = {
    list: () =>
      logins.map((login) => ({
        id: login.id,
        providerId: "openai-codex",
        label: login.id,
        enabled: login.enabled ?? true,
      })),
    pinnedAccount: () => pin,
    connectedSync: () => true,
    withheldReason: () => undefined,
    markSelected: () => {},
  };
  const db = openInMemoryDatabase();
  const selector = new AccountSelector({
    pool,
    quota: { latest: () => reading(logins) },
    flagshipAccountId: () => null,
    decisions: new DecisionStore(db),
    accountModels: () =>
      Object.entries(lists).map(([accountId, models]) => ({
        accountId,
        models: models.map((id) => ({ provider: "openai-codex", id })),
      })),
    loginInUse: {
      whenLow: () => choice,
      pin: (providerId, accountId) => {
        pin = accountId;
        pins.push({ providerId, accountId });
      },
    },
  });
  const reasonsOf = (taskId: string) =>
    JSON.parse(
      (
        db.prepare("SELECT reasons_json FROM account_decisions WHERE task_id = ?").get(taskId) as {
          reasons_json: string;
        }
      ).reasons_json,
    ) as string[];
  return { selector, pins, reasonsOf };
}

describe("a pick under each choice for a login that runs low", () => {
  const spentPin = [
    { id: "personal", percent: 0 },
    { id: "work", percent: 80 },
  ];

  it.each(["wait", "ask"] as const)(
    "serves nothing under %s while the login in use is spent, though another login has room",
    async (choice) => {
      const t = selectorOver(spentPin, choice, "personal");
      expect(await t.selector.selectForSpawn("task-1", "openai-codex")).toBeUndefined();
      expect(t.reasonsOf("task-1").join(" ")).toContain(
        "personal is the openai-codex login in use; no other login serves until it is moved",
      );
      expect(t.pins).toEqual([]);
    },
  );

  it.each(["spread", "move"] as const)(
    "serves the login with room under %s while the pinned login is spent",
    async (choice) => {
      const t = selectorOver(spentPin, choice, "personal");
      expect(await t.selector.selectForSpawn("task-1", "openai-codex")).toBe("work");
      expect(t.pins).toEqual([]);
    },
  );

  it.each(["wait", "ask"] as const)(
    "keeps new work on the login in use under %s while it has room, whatever room another has",
    async (choice) => {
      const t = selectorOver(
        [
          { id: "personal", percent: 35 },
          { id: "work", percent: 90 },
        ],
        choice,
        "personal",
      );
      expect(await t.selector.selectForSpawn("task-1", "openai-codex")).toBe("personal");
      expect(t.reasonsOf("task-1")).toEqual(["picked personal: the login in use"]);
    },
  );

  it.each(["wait", "ask"] as const)(
    "takes the picked login as the login in use under %s when several logins have no pin",
    async (choice) => {
      const t = selectorOver(
        [
          { id: "personal", percent: 35 },
          { id: "work", percent: 90 },
        ],
        choice,
      );
      expect(await t.selector.selectForSpawn("task-1", "openai-codex")).toBe("work");
      expect(t.pins).toEqual([{ providerId: "openai-codex", accountId: "work" }]);
      // The next pick stays on it, and it is not pinned a second time.
      expect(await t.selector.selectForSpawn("task-2", "openai-codex")).toBe("work");
      expect(t.pins).toHaveLength(1);
    },
  );

  it.each(["spread", "move"] as const)("pins nothing under %s", async (choice) => {
    const t = selectorOver(
      [
        { id: "personal", percent: 35 },
        { id: "work", percent: 90 },
      ],
      choice,
    );
    expect(await t.selector.selectForSpawn("task-1", "openai-codex")).toBe("work");
    expect(t.pins).toEqual([]);
  });

  it("replaces a pin that names a login turned off, under ask", async () => {
    const t = selectorOver(
      [
        { id: "personal", percent: 60, enabled: false },
        { id: "work", percent: 20 },
        { id: "spare", percent: 70 },
      ],
      "ask",
      "personal",
    );
    expect(await t.selector.selectForSpawn("task-1", "openai-codex")).toBe("spare");
    expect(t.pins).toEqual([{ providerId: "openai-codex", accountId: "spare" }]);
  });

  const bothRoomy = [
    { id: "personal", percent: 60 },
    { id: "work", percent: 80 },
  ];
  const TERRA = { model: "gpt-6.1-terra" };
  const noPlacedWork = { work: [], samples: [], charges: {}, readings: [] };

  it.each(["wait", "ask"] as const)(
    "serves nothing under %s for a model the login in use does not list, though another login lists it",
    async (choice) => {
      const t = selectorOver(bothRoomy, choice, "personal", {
        personal: ["gpt-6.1-luna"],
        work: ["gpt-6.1-terra"],
      });
      expect(await t.selector.selectForSpawn("task-1", "openai-codex", TERRA)).toBeUndefined();
      expect(t.reasonsOf("task-1")).toEqual([
        "skipped personal: does not list this model",
        "personal is the openai-codex login in use; no other login serves until it is moved",
      ]);
      // Routing reads that as a model no account may serve, not as no information.
      expect(t.selector.crewAccount("openai-codex", "gpt-6.1-terra", noPlacedWork)).toBeNull();
    },
  );

  it("serves the login that lists the model under spread", async () => {
    const t = selectorOver(bothRoomy, "spread", "personal", {
      personal: ["gpt-6.1-luna"],
      work: ["gpt-6.1-terra"],
    });
    expect(await t.selector.selectForSpawn("task-1", "openai-codex", TERRA)).toBe("work");
  });

  it("serves nothing under ask once the login in use failed to open the model", async () => {
    const t = selectorOver(bothRoomy, "ask", "personal");
    const pick = await t.selector.pickForSpawn("task-1", "openai-codex", {
      ...TERRA,
      passing: ["personal"],
    });
    expect(pick.accountId).toBeUndefined();
    pick.record();
    expect(t.reasonsOf("task-1")[0]).toBe("skipped personal: failed to open this model");
  });

  it("keeps the login in use serving under ask while its sign-in lists nothing yet", async () => {
    const t = selectorOver(bothRoomy, "ask", "personal", { work: ["gpt-6.1-terra"] });
    expect(await t.selector.selectForSpawn("task-1", "openai-codex", TERRA)).toBe("personal");
  });

  it("ranks a model by a spent login in use, and by nothing when no login is known", () => {
    const spent = selectorOver(spentPin, "ask", "personal");
    expect(spent.selector.crewAccount("openai-codex", "gpt-6.1-terra", noPlacedWork)).toBe(
      "personal",
    );
    const none = selectorOver([], "ask");
    expect(
      none.selector.crewAccount("openai-codex", "gpt-6.1-terra", noPlacedWork),
    ).toBeUndefined();
  });

  it("picks only the named login for a low login's move, whatever the pin and the room elsewhere", async () => {
    const logins = [
      { id: "personal", percent: 0 },
      { id: "work", percent: 40 },
      { id: "spare", percent: 95 },
    ];
    const named = selectorOver(logins, "ask", "personal");
    const pick = await named.selector.pickForSpawn("task-1", "openai-codex", {
      ...TERRA,
      only: "work",
    });
    expect(pick.accountId).toBe("work");
    // A named login that does not list the model is not replaced by one that does.
    const unlisted = selectorOver(logins, "spread", undefined, {
      work: ["gpt-6.1-luna"],
      spare: ["gpt-6.1-terra"],
    });
    const none = await unlisted.selector.pickForSpawn("task-1", "openai-codex", {
      ...TERRA,
      only: "work",
    });
    expect(none.accountId).toBeUndefined();
  });

  it("picks no named login that has itself run low since it was named, under ask, spread and move", async () => {
    // Work was named with room and has 3% left by the task's next delivery.
    const logins = [
      { id: "personal", percent: 0 },
      { id: "work", percent: 3 },
      { id: "spare", percent: 95 },
    ];
    for (const choice of ["ask", "spread", "move"] as const) {
      const t = selectorOver(logins, choice, "personal");
      const pick = await t.selector.pickForSpawn("task-1", "openai-codex", {
        ...TERRA,
        only: "work",
      });
      expect([choice, pick.accountId]).toEqual([choice, undefined]);
    }
  });

  it("pins nothing for a provider with one login", async () => {
    const t = selectorOver([{ id: "personal", percent: 60 }], "ask");
    expect(await t.selector.selectForSpawn("task-1", "openai-codex")).toBe("personal");
    expect(t.pins).toEqual([]);
  });
});
