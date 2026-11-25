import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@shared/ipc";
import { fenceClosing, fenceOpening } from "@shared/outsideData";
import {
  type PlacedSpec,
  placedTaskFolders,
  type WorkOrderChannel,
  workRequests,
} from "@shared/work";
import { describe, expect, it, vi } from "vitest";
import { expectBytesEqual } from "../../../tests/helpers/expectBytes";
import { scriptedClaudeWorld } from "../../../tests/helpers/scriptedClaudeContract";
import {
  api,
  MODEL,
  model,
  OTHER_MODEL,
  PROVIDER,
  placed,
  sessionHostHooks,
  TASK,
} from "../../../tests/helpers/sessionHostWorld";
import { CONTRACT_CHANGES } from "../connection/contractChanges";
import { answersDir, savedAnswerText } from "../session/answerFiles";
import { SESSION_COMPACTION } from "../session/compaction";
import type { SessionSpec } from "../session/session";
import { PlacedTasks } from "./placedTasks";
import { PLACED_REQUEST_WAIT_MS } from "./toolWait";

/**
 * A crewmate's conversation held on a computer that runs work
 * (`tests/helpers/sessionHostWorld.ts`): forwarding to the home, prompt runs, drops and callbacks, check and story declarations, and the orders it refuses.
 */

sessionHostHooks();

describe("a conversation held on a computer that runs work", () => {
  // INF-1109's required main update absorbs completed-operation observations into
  // the work major. A real placed session must send them without a retired minor name.
  it("sends completed-operation facts to the current work major without a minor name", async () => {
    const at = await placed({ homeChanges: [] });
    await at.open();
    model([
      { tools: [{ name: "tasks", args: { status: "open", limit: 1 } }] },
      { text: "Listed the open tasks." },
    ]);
    await at.order("inf:session:prompt", [
      { orderId: "completed-operation:1", task: TASK, text: "List the open tasks." },
    ]);
    await at.ended(1);
    await expect
      .poll(() =>
        at.home.events
          .filter((record) => record.event.type === "tool_observation")
          .map((record) => record.event),
      )
      .toContainEqual(
        expect.objectContaining({
          type: "tool_observation",
          // Whether the call failed crosses to the home (`repetition-outcome.md`).
          fact: expect.objectContaining({ kind: "completed", toolName: "tasks", failed: false }),
        }),
      );
  });

  it("INF-2214 preserves response correlation through the home", async () => {
    const at = await placed();
    await at.open();
    model([
      {
        tools: [
          {
            name: "report",
            args: {
              text: "The remover is at the verified target path.",
              responses: [
                { request_id: "path-request", response_id: "path-answer", status: "answered" },
              ],
            },
          },
        ],
      },
      { text: "Response submitted." },
    ]);
    await at.order("inf:session:prompt", [
      { orderId: "path:1", task: TASK, text: "Answer path-request." },
    ]);
    await at.ended(1);
    const reports = at.home.effects.filter((effect) => effect.channel === "inf:work:report");
    expect(reports[0]?.request).toMatchObject({
      declared: {
        responses: [{ requestId: "path-request", responseId: "path-answer", status: "answered" }],
      },
    });
  });
  // INF-3042: major 15 absorbs shared-card correction. Connection admission
  // owns incompatible peers; these admitted sessions need no duplicate version callback.
  it.each([true, false])(
    "sends shared-card corrections after admission (explicit version: %s)",
    async (supported) => {
      const at = await placed({
        ...(supported ? { homeVersion: PROTOCOL_VERSION } : {}),
        homeChanges: [],
      });
      at.spec.tools.push("revise_required_action");
      await at.open();
      model([
        {
          tools: [
            {
              name: "revise_required_action",
              args: {
                action: "card-fm-required-action-op1",
                source: "DOP-208",
                action_id: "remove-job-host",
                expected_generation: 1,
                patch: { instructions: ["Run C:\\FleetCheckSetup\\shell-pc-job-host-remove.cmd"] },
                reason: "The remover path was wrong",
                operation_id: "op-remover-path",
                same_action: true,
              },
            },
          ],
        },
        { text: "Corrected." },
      ]);
      await at.order("inf:session:prompt", [
        { orderId: "fix:1", task: TASK, text: "Correct the remover path." },
      ]);
      await at.ended(1);
      const sent = at.home.effects.filter(
        (effect) => effect.channel === "inf:work:revise-required-action",
      );
      const ended = at.home.events.find(
        (record) =>
          record.event.type === "tool_end" && record.event.toolName === "revise_required_action",
      )?.event;
      expect(sent).toHaveLength(1);
      expect(sent[0]?.request).toMatchObject({
        input: {
          action: "card-fm-required-action-op1",
          expectedGeneration: 1,
          operationId: "op-remover-path",
          sameAction: true,
        },
      });
      expect(ended).toMatchObject({ isError: false });
    },
  );
  // INF-2589, the captain: "any too big answer gets stored in a file and we
  // return the path to the file instead of the full answer". The file is
  // saved where the crewmate's shell runs, so it can open it.
  it("saves an answer too long to read whole in the task's temporary folder there, and the model reads its path", async () => {
    // A real answer past the band: the captured INF-91 record as one read serves it whole.
    const answer = JSON.stringify(
      JSON.parse(readFileSync("tests/fixtures/accepted-plan/inf91.json", "utf8")),
      null,
      2,
    );
    const at = await placed();
    at.spec.tools.push("github_read");
    at.home.answer("inf:work:github-read", { text: answer });
    await at.open();
    model([
      {
        tools: [
          { name: "github_read", args: { path: "/repos/acme/shop/actions/runs?per_page=100" } },
        ],
      },
      { text: "Read the runs." },
    ]);
    await at.order("inf:session:prompt", [
      { orderId: "runs:1", task: TASK, text: "List the latest runs." },
    ]);
    await at.ended(1);
    const answers = answersDir(placedTaskFolders(join(at.dataDir, "tasks"), TASK).temp);
    const [saved] = readdirSync(answers);
    const path = join(answers, saved ?? "");
    expect(readFileSync(path, "utf8")).toBe(answer);
    const result = api.requests
      .at(-1)
      ?.body.messages?.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .findLast((block: { type?: string }) => block.type === "tool_result") as
      | { content?: string | { text?: string }[] }
      | undefined;
    const served =
      typeof result?.content === "string"
        ? result.content
        : result?.content?.map((block) => block.text ?? "").join("\n");
    expect(served).toBe(savedAnswerText(path, answer));
    expect(
      at.home.events.find(
        (record) => record.event.type === "tool_end" && record.event.toolName === "github_read",
      )?.event,
    ).toMatchObject({ isError: false });
  });

  // INF-2599 (the captain: "Send a crewmate its directions once, and again
  // only when they change"): the home sends directions again after a fold,
  // so it must hear one. INF-3042: every admitted work peer knows folds.
  it.each([true, false])(
    "reports Claude folds after admission (explicit version: %s)",
    async (supported) => {
      const claude = await scriptedClaudeWorld();
      const at = await placed({
        claude,
        ...(supported ? { homeVersion: PROTOCOL_VERSION } : {}),
        homeChanges: [],
      });
      const spec: PlacedSpec = { ...at.spec, binding: { backend: "claude" }, model: claude.model };
      claude.answer({ text: "Counted every press." });
      await at.order("inf:session:open", [{ orderId: "open:fold", task: TASK, spec }]);
      await at.order("inf:session:prompt", [
        { orderId: "rows:fold", task: TASK, text: "Count every press." },
      ]);
      await at.ended(1);
      claude.fold();
      // The home hears what the conversation did in order: a model it named
      // after the fold is heard after the fold too, with or without it.
      claude.answer({ text: "Counted the long presses." });
      await at.order("inf:session:prompt", [
        { orderId: "rows:after-fold", task: TASK, text: "Count the long presses." },
      ]);
      await at.ended(2);
      const folds = at.home.events.filter(({ event }) => event.type === "context_compacted");
      expect(folds.map(({ event }) => event)).toEqual([{ type: "context_compacted" }]);
    },
  );
  // Protected Secrets includes the preceding first-release capability on the new work major.
  it.each([{ homeChanges: ["first-release-reports"] }, { homeChanges: [] }])(
    "forwards first-release facts and pagination with $homeChanges (INF-1607)",
    async ({ homeChanges }) => {
      const at = await placed({ homeChanges });
      await at.open();
      const release = {
        version: "0.6.0",
        url: "https://github.com/infinitary-labs/infinitary/releases/tag/v0.6.0",
        evidence: "Published source contains the task's merge; earlier published sources do not.",
        tasks: ["INF-1607"],
      };
      model([
        { tools: [{ name: "tasks", args: { status: "done", skip: 100 } }] },
        {
          tools: [
            {
              name: "report",
              args: {
                text: "Verified the first published release of the merged fix.",
                first_release: release,
              },
            },
          ],
        },
        { text: "Reported the release verification." },
      ]);
      await at.order("inf:session:prompt", [
        { orderId: "release:1", task: TASK, text: "Record the verified release." },
      ]);
      await at.ended(1);
      const queries = at.home.effects.filter((effect) => effect.channel === "inf:work:tasks");
      expect(queries).toHaveLength(1);
      expect(queries[0]?.request).toMatchObject({ input: { status: "done", skip: 100 } });
      const reports = at.home.effects.filter((effect) => effect.channel === "inf:work:report");
      expect(reports).toHaveLength(1);
      expect(reports[0]?.request).toMatchObject({ declared: { firstRelease: release } });
      expect(
        at.home.events.find(
          (record) => record.event.type === "tool_end" && record.event.toolName === "report",
        )?.event,
      ).toMatchObject({ isError: false });
    },
  );

  // Protected Secrets preserves task-list snapshots after the preceding name retires.
  it.each([true, false])(
    "asks for a task list's cut with or without its retired name (INF-1746 R9; advertised: %s)",
    async (advertised) => {
      const at = await placed({ homeChanges: advertised ? ["task-list-snapshot"] : [] });
      await at.open();
      model([
        { tools: [{ name: "tasks", args: { status: "open", limit: 1 } }] },
        { text: "Listed." },
      ]);
      await at.order("inf:session:prompt", [
        { orderId: "list:1", task: TASK, text: "List the open work." },
      ]);
      await at.ended(1);
      const [query] = at.home.effects.filter((effect) => effect.channel === "inf:work:tasks");
      const input = (query?.request as { input?: Record<string, unknown> } | undefined)?.input;
      expect(input).toMatchObject({ status: "open", limit: 1 });
      expect(input?.snapshot).toBe(true);
      expect(
        at.home.events.find(
          (record) => record.event.type === "tool_end" && record.event.toolName === "tasks",
        )?.event,
      ).toMatchObject({ isError: false });
    },
  );

  it("runs the home's prompt there, does each callback once at the home, and tells the home every event once, in order", async () => {
    const at = await placed();
    const opened = await at.open();
    expect(opened.state).toMatchObject({
      backend: "pi",
      streaming: false,
      model: { provider: PROVIDER, id: MODEL },
      controlProfile: { backgroundWork: "host" },
    });
    model([
      { tools: [{ name: "note_progress", args: { text: "Started." } }] },
      { tools: [{ name: "report", args: { text: "All done.", summary: "It is done." } }] },
      { text: "Reported." },
    ]);
    expect(
      await at.order("inf:session:prompt", [{ orderId: "rows:1", task: TASK, text: "Do it." }]),
    ).toEqual({ turn: 1 });
    await at.ended(1);

    const served = api.requests.at(-1)?.body;
    expect(JSON.stringify(served?.system)).toContain("You are a crewmate on another Mac.");
    expect(served?.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["emit_card", "report", "note_progress", "file_followup", "tasks"]),
    );

    // Each callback once, as the computer itself, after every event before it.
    expect(at.home.effects.map((effect) => effect.channel)).toEqual([
      "inf:work:progress",
      "inf:work:report",
    ]);
    expect(at.home.effects[1]?.request).toMatchObject({
      task: TASK,
      text: "All done.",
      summary: "It is done.",
    });
    expect(at.home.actors.length).toBeGreaterThan(0);
    for (const actor of at.home.actors)
      expect(actor).toEqual({ kind: "device", deviceId: at.deviceId });
    const reportStart = at.home.events.find(
      (record) => record.event.type === "tool_start" && record.event.toolName === "report",
    );
    expect(at.home.effects[1]?.after).toBeGreaterThanOrEqual(reportStart?.seq ?? Number.NaN);

    expect(at.home.events.map((record) => record.seq)).toEqual(
      at.home.events.map((_, index) => index + 1),
    );
    const types = at.home.types();
    expect(types[0]).toBe("turn_started");
    expect(types.at(-1)).toBe("turn_ended");
    expect(types).toEqual(expect.arrayContaining(["tool_start", "tool_end", "turn_end"]));
    expect(at.home.events.at(-1)?.event).toMatchObject({
      type: "turn_ended",
      turn: 1,
      outcome: "done",
      undelivered: [],
      state: { streaming: false, resume: expect.stringMatching(/\.jsonl$/) },
    });
    // What the home keeps, the computer forgets: its outbox holds nothing kept.
    const outbox = join(placedTaskFolders(join(at.dataDir, "tasks"), TASK).root, "outbox.jsonl");
    await expect.poll(() => readFileSync(outbox, "utf8")).toBe("");
  });

  it("answers an order it already applied as it did, without doing it again", async () => {
    const at = await placed();
    const opened = await at.open();
    model([{ text: "Once." }]);
    const prompt = [{ orderId: "rows:7", task: TASK, text: "Say it once." }];
    expect(await at.order("inf:session:prompt", prompt)).toEqual({ turn: 1 });
    await at.ended(1);
    const requests = api.requests.length;

    expect(await at.order("inf:session:prompt", prompt)).toEqual({ turn: 1 });
    expect((await at.open()).state.sessionId).toBe(opened.state.sessionId);
    expect(api.requests.length).toBe(requests);
    expect(at.home.types().filter((type) => type === "turn_started")).toHaveLength(1);

    // A steer after the turn ended reached nothing, so the home puts its words back.
    expect(
      await at.order("inf:session:steer", [{ orderId: "rows:8", task: TASK, text: "Late." }]),
    ).toEqual({ delivered: false });
  });

  it("rebinds an idle conversation when a later open names a tool it lacked (INF-398)", async () => {
    const at = await placed();
    const opened = await at.open();
    model([{ text: "Started." }, { text: "Has the tool." }]);
    await at.order("inf:session:prompt", [{ orderId: "rows:1", task: TASK, text: "Start." }]);
    await at.ended(1);
    expect(api.requests.at(-1)?.body.tools?.map((tool) => tool.name)).not.toContain(
      "prepare_change",
    );
    const held = await at.open();
    expect(held.state.sessionId).toBe(opened.state.sessionId);
    expect(held.state.resume).toBeTruthy();

    const again = await at.order("inf:session:open", [
      {
        orderId: `open:${TASK}:2`,
        task: TASK,
        spec: {
          ...at.spec,
          tools: [...at.spec.tools, "prepare_change"],
          resume: held.state.resume,
        },
      },
    ]);
    expect(again.state?.resume).toBe(held.state.resume);
    await at.order("inf:session:prompt", [{ orderId: "rows:2", task: TASK, text: "Continue." }]);
    await at.ended(2);
    expect(api.requests.at(-1)?.body.tools?.map((tool) => tool.name)).toContain("prepare_change");
  });

  // Intent: a task routed again re-opens its idle conversation there on the new model (docs/helper.md).
  it("re-opens an idle conversation on the model a later open names", async () => {
    const at = await placed();
    const opened = await at.open();
    expect(opened.state.model).toEqual({ provider: PROVIDER, id: MODEL });
    model([{ text: "Started." }, { text: "On the other model." }]);
    await at.order("inf:session:prompt", [{ orderId: "rows:1", task: TASK, text: "Start." }]);
    await at.ended(1);

    const again = await at.order("inf:session:open", [
      {
        orderId: `open:${TASK}:2`,
        task: TASK,
        spec: { ...at.spec, model: { provider: PROVIDER, id: OTHER_MODEL } },
      },
    ]);
    expect(again.state?.model).toEqual({ provider: PROVIDER, id: OTHER_MODEL });
    await at.order("inf:session:prompt", [{ orderId: "rows:2", task: TASK, text: "Continue." }]);
    await at.ended(2);
    expect(api.requests.at(-1)?.body.model).toBe(OTHER_MODEL);
  });

  // INF-5438 round 9 finding 6: a held conversation asked for one model that
  // runs another is not what the same open gets back: it opens again.
  it("opens again when the held conversation runs another model than the same open asks", async () => {
    const at = await placed();
    await at.open();
    const factory = (
      at.host() as unknown as {
        options: { factories: { pi: { open: (spec: never) => Promise<{ modelRef(): unknown }> } } };
      }
    ).options.factories.pi;
    const open = factory.open.bind(factory);
    let drifts = true;
    vi.spyOn(factory, "open").mockImplementation(async (spec) => {
      const session = await open(spec);
      if (drifts) {
        drifts = false;
        // The runtime could not serve the model asked and runs the first one.
        session.modelRef = () => ({ provider: PROVIDER, id: MODEL });
      }
      return session;
    });
    const other = { ...at.spec, model: { provider: PROVIDER, id: OTHER_MODEL } };
    const drifted = await at.order("inf:session:open", [
      { orderId: `open:${TASK}:2`, task: TASK, spec: other },
    ]);
    expect(drifted.state?.model).toEqual({ provider: PROVIDER, id: MODEL });
    const again = await at.order("inf:session:open", [
      { orderId: `open:${TASK}:3`, task: TASK, spec: other },
    ]);
    expect(again.state?.model).toEqual({ provider: PROVIDER, id: OTHER_MODEL });
  });

  // INF-5438 round 10 finding 5: an idle held conversation that says no
  // model is not what an open asking one gets back: it opens again.
  it("opens again when an idle held conversation says no model and the same open asks one", async () => {
    const at = await placed();
    const factory = (
      at.host() as unknown as {
        options: { factories: { pi: { open: (spec: never) => Promise<{ modelRef(): unknown }> } } };
      }
    ).options.factories.pi;
    const open = factory.open.bind(factory);
    let silent = true;
    vi.spyOn(factory, "open").mockImplementation(async (spec) => {
      const session = await open(spec);
      if (silent) {
        silent = false;
        session.modelRef = () => undefined;
      }
      return session;
    });
    const first = await at.order("inf:session:open", [
      { orderId: `open:${TASK}:1`, task: TASK, spec: at.spec },
    ]);
    expect(first.state?.model).toBeUndefined();
    const again = await at.order("inf:session:open", [
      { orderId: `open:${TASK}:2`, task: TASK, spec: at.spec },
    ]);
    expect(again.state?.model).toEqual(at.spec.model);
  });

  // INF-5438 round 11 finding 1: a fresh open asks for a new conversation
  // and never gets back the one held - even one opened with no resume
  // token, whose contract is the same - while one still in a turn opens
  // nothing yet, so the home asks again (`fresh-open.md`).
  it("opens a new conversation for a fresh open, replacing the idle one held and never a busy one", async () => {
    const at = await placed();
    const first = await at.open();
    model([{ text: "Started." }]);
    await at.order("inf:session:prompt", [{ orderId: "rows:1", task: TASK, text: "Start." }]);
    await at.ended(1);
    // The same open with no resume, not asked fresh, keeps what is held.
    const same = await at.order("inf:session:open", [
      { orderId: `open:${TASK}:2`, task: TASK, spec: at.spec },
    ]);
    expect(same.state?.resume).toBe(first.state.resume);
    const host = at.host() as unknown as { busy(held: unknown): boolean };
    const busy = vi.spyOn(host, "busy").mockReturnValue(true);
    await expect(
      at.order("inf:session:open", [
        { orderId: `open:${TASK}:3`, task: TASK, spec: { ...at.spec, fresh: true } },
      ]),
    ).rejects.toThrow("still in a turn");
    busy.mockRestore();
    const kept = await at.order("inf:session:open", [
      { orderId: `open:${TASK}:4`, task: TASK, spec: at.spec },
    ]);
    expect(kept.state?.resume).toBe(first.state.resume);
    const restarted = await at.order("inf:session:open", [
      { orderId: `open:${TASK}:5`, task: TASK, spec: { ...at.spec, fresh: true } },
    ]);
    expect(restarted.state?.resume).toBeTruthy();
    expect(restarted.state?.resume).not.toBe(first.state.resume);
  });

  // INF-5438 round 10 finding 4: an open that fails once its conversation
  // began says it left nothing here only after letting that conversation go,
  // and only to a home that asks; to any other it fails as before.
  it("answers that an open left nothing here once the conversation it began is let go", async () => {
    const at = await placed();
    const factory = (
      at.host() as unknown as {
        options: {
          factories: { pi: { open: (spec: never) => Promise<{ takeRenewal(): unknown }> } };
        };
      }
    ).options.factories.pi;
    const open = factory.open.bind(factory);
    vi.spyOn(factory, "open").mockImplementation(async (spec) => {
      const session = await open(spec);
      session.takeRenewal = () => {
        throw new Error("The renewal could not be read.");
      };
      return session;
    });
    const answer = await at.order("inf:session:open", [
      { orderId: `open:${TASK}:1`, task: TASK, spec: { ...at.spec, notOpened: true } },
    ]);
    expect(answer).toEqual({ notOpened: "The renewal could not be read." });
    const roster = await at.order("inf:session:roster", []);
    expect(roster.tasks.find((entry) => entry.task === TASK)?.open).not.toBe(true);
    await expect(
      at.order("inf:session:open", [{ orderId: `open:${TASK}:2`, task: TASK, spec: at.spec }]),
    ).rejects.toThrow("The renewal could not be read.");
  });

  // INF-5438 finding 1: an open asked only to reattach never creates or
  // replaces a conversation there; it answers that a new one is needed, so
  // the home routes first (`reattach-only-open.md`).
  it("answers that a new conversation is needed when asked only to reattach and nothing is held", async () => {
    const at = await placed();
    const answer = await at.order("inf:session:open", [
      { orderId: `open:${TASK}:1`, task: TASK, spec: { ...at.spec, reattach: true } },
    ]);
    expect(answer).toEqual({ needsOpen: true });
    const roster = await at.order("inf:session:roster", []);
    expect(roster.tasks.find((entry) => entry.task === TASK)?.open).not.toBe(true);
  });

  // INF-5438 round 7 finding 7: a reattach adopts the held conversation as it
  // runs, answering its own model, rather than asking the home to open anew.
  it("keeps an idle conversation's model when asked only to reattach on another", async () => {
    const at = await placed();
    await at.open();
    model([{ text: "Started." }, { text: "Still on the first model." }]);
    await at.order("inf:session:prompt", [{ orderId: "rows:1", task: TASK, text: "Start." }]);
    await at.ended(1);

    const asked = await at.order("inf:session:open", [
      {
        orderId: `open:${TASK}:2`,
        task: TASK,
        spec: { ...at.spec, model: { provider: PROVIDER, id: OTHER_MODEL }, reattach: true },
      },
    ]);
    expect(asked).toMatchObject({ state: { model: { provider: PROVIDER, id: MODEL } } });
    await at.order("inf:session:prompt", [{ orderId: "rows:2", task: TASK, text: "Continue." }]);
    await at.ended(2);
    expect(api.requests.at(-1)?.body.model).toBe(MODEL);
  });

  // INF-5438 finding 2: a cleanup that lets the conversation go leaves it
  // closed for the home to open again after routing it, rather than opening
  // it there again on the model it had.
  it("opens nothing again after a cleanup the home asked to hold the reopen of", async () => {
    const at = await placed();
    await at.open();
    model([{ text: "Read the mail." }]);
    await at.order("inf:session:prompt", [{ orderId: "rows:1", task: TASK, text: "Read it." }]);
    await at.ended(1);
    const read = Date.parse("2026-11-01T00:00:00.000Z");
    const sessions = placedTaskFolders(join(at.dataDir, "tasks"), TASK).sessions;
    const [file] = readdirSync(sessions).filter((name) => name.endsWith(".jsonl"));
    if (!file) throw new Error("The conversation saved no record.");
    const fence = { label: "gmail", value: "0123456789abcdef", at: read };
    writeFileSync(
      join(sessions, file),
      `${readFileSync(join(sessions, file), "utf8")}${JSON.stringify({ type: "note", text: `${fenceOpening(fence)} a message ${fenceClosing(fence.label, fence.value)}` })}\n`,
    );

    const answer = await at.order("inf:session:delete-outside", [
      {
        orderId: "outside:1",
        task: TASK,
        kinds: [{ label: fence.label, until: read + 1, note: "A message was removed." }],
        legacy: [],
        holdReopen: true,
      },
    ]);
    expect(answer).toMatchObject({ status: "changed", reopen: true });
    expect(answer).not.toHaveProperty("state");
    const roster = await at.order("inf:session:roster", []);
    expect(roster.tasks.find((entry) => entry.task === TASK)?.open).not.toBe(true);
  });

  // Intent: INF-311's accepted whole-call deadline includes waiting for prior events.
  it.each(["inf:work:report", "inf:work:events"])(
    "ends the whole tool call after 24 days while waiting on %s (INF-312)",
    async (channel) => {
      const at = await placed();
      await at.open();
      const held = at.home.hold(channel);
      model([
        { tools: [{ name: "report", args: { text: "Across the deadline." } }] },
        { text: "Checked the timeout." },
      ]);
      const first = api.requests.length;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      await at.order("inf:session:prompt", [{ orderId: "deadline", task: TASK, text: "Report." }]);
      await held.reached;
      // Wait for the model's tool-start event before moving only the deadline clock.
      await expect
        .poll(() => {
          const outbox = new PlacedTasks(at.dataDir).outbox(TASK, 0);
          return outbox.some((record) => record.event.type === "tool_start");
        })
        .toBe(true);
      try {
        await vi.advanceTimersByTimeAsync(PLACED_REQUEST_WAIT_MS);
      } finally {
        vi.useRealTimers();
      }
      held.open();
      await at.ended(1);
      const transcript = JSON.stringify(
        api.requests.slice(first).map((request) => request.body.messages),
      );
      expect(transcript).toContain(
        channel === "inf:work:report" ? "may already be done" : "was not sent",
      );
      if (channel === "inf:work:events")
        expect(
          at.home.effects.filter((effect) => effect.channel === "inf:work:report"),
        ).toHaveLength(0);
      console.info("Whole-call deadline:", channel, transcript.slice(-1200));
    },
  );

  it("keeps the turn running through a drop: a waiting callback is asked again under its id, done once, and the home catches up exactly", async () => {
    const at = await placed();
    await at.open();
    const report = at.home.hold("inf:work:report");
    model([
      { tools: [{ name: "report", args: { text: "Across the drop." } }] },
      { text: "Carried on." },
    ]);
    await at.order("inf:session:prompt", [{ orderId: "rows:2", task: TASK, text: "Report." }]);
    await report.reached;

    await at.dropAndReturn();
    // The same call, asked again on the new connection, while the first still waits.
    await expect
      .poll(() => at.home.asked.filter((ask) => ask.channel === "inf:work:report").length)
      .toBe(2);
    const [first, second] = at.home.asked.filter((ask) => ask.channel === "inf:work:report");
    expect(second?.callId).toBe(first?.callId);
    report.open();
    await at.ended(1);

    expect(at.home.effects.filter((effect) => effect.channel === "inf:work:report")).toHaveLength(
      1,
    );
    expect(at.home.events.map((record) => record.seq)).toEqual(
      at.home.events.map((_, index) => index + 1),
    );
    expect(at.home.types().filter((type) => type === "turn_ended")).toHaveLength(1);
    expect(at.home.events.at(-1)?.event).toMatchObject({ type: "turn_ended", outcome: "done" });
  });

  it("holds several callbacks waiting at once, and answers each once after a drop", async () => {
    const at = await placed();
    await at.open();
    const progress = at.home.hold("inf:work:progress");
    const followup = at.home.hold("inf:work:followup");
    model([
      {
        tools: [
          { name: "note_progress", args: { text: "Two at once." } },
          {
            name: "file_followup",
            args: { title: "A gap", goal: "Close it.", why: "Found it." },
          },
        ],
      },
      { text: "Both answered." },
    ]);
    await at.order("inf:session:prompt", [{ orderId: "rows:3", task: TASK, text: "Both." }]);
    await Promise.all([progress.reached, followup.reached]);

    await at.dropAndReturn();
    await expect.poll(() => at.home.asked.length).toBe(4);
    progress.open();
    followup.open();
    await at.ended(1);
    expect(at.home.effects.map((effect) => effect.channel).sort()).toEqual([
      "inf:work:followup",
      "inf:work:progress",
    ]);
  });

  // INF-125 proof custody also keeps INF-312's cancellation rule: a stopped
  // proof transfer must not go on to send its report.
  it.each([false, true])(
    "INF-125: transfers kept validation bytes before the report (cancelled: %s)",
    async (cancelled) => {
      const controller = new AbortController();
      const at = await placed(cancelled ? { toolSignal: controller.signal } : {});
      await at.open();
      model([
        {
          tools: [
            {
              name: "note_progress",
              args: { text: "The paired work connection delivered this observation." },
            },
          ],
        },
        { text: "Recorded." },
      ]);
      await at.order("inf:session:prompt", [
        { orderId: "proof:observe", task: TASK, text: "Record one observation." },
      ]);
      await at.ended(1);
      const transcript = JSON.stringify(
        at.home.effects.filter((item) => item.channel === "inf:work:progress"),
      );
      expect(JSON.parse(transcript)).toHaveLength(1);
      const folders = placedTaskFolders(join(at.dataDir, "tasks"), TASK);
      const path = join(folders.evidence, "paired-observation.json");
      writeFileSync(path, transcript);
      const start = at.home.effects.length;
      const head = "a".repeat(40);
      model([
        {
          tools: [
            {
              name: "report",
              args: {
                text: "The actual paired work connection delivered the observation.",
                validation: {
                  kind: "run",
                  id: "paired-run",
                  head,
                  scenarioRevision: 1,
                  completion: "complete",
                  verdict: "go",
                  reason: "The local paired helper and home exchanged the actual report call.",
                  observations: [
                    {
                      scenario: "paired-report",
                      result: "pass",
                      live: true,
                      actual: "The home recorded the helper's progress call.",
                      evidence: ["received"],
                      standIns: ["Two local processes, not two physical computers; scripted model"],
                      unproven: [],
                      attempted: [],
                    },
                  ],
                  evidence: [
                    {
                      id: "received",
                      path,
                      description: "The actual progress call received by the home.",
                    },
                  ],
                },
              },
            },
          ],
        },
        { text: "Reported." },
      ]);
      const media = cancelled ? at.home.hold("inf:work:media") : undefined;
      try {
        await at.order("inf:session:prompt", [
          { orderId: "proof:report", task: TASK, text: "Keep that observed call with its report." },
        ]);
        if (media) {
          await media.reached;
          controller.abort(new Error("The provider stopped waiting for the proof transfer"));
          await at.ended(2);
          expect(at.home.asked.filter((request) => request.channel === "inf:work:report")).toEqual(
            [],
          );
          expect(
            at.home.effects.slice(start).filter((effect) => effect.channel === "inf:work:report"),
          ).toEqual([]);
          console.info(
            "INF-125 cancelled proof: the held transfer ended without sending a report.",
          );
          return;
        }
        await at.ended(2);
      } finally {
        media?.open();
      }
      const effects = at.home.effects.slice(start);
      expect(effects.map((item) => item.channel)).toEqual(["inf:work:media", "inf:work:report"]);
      const proof = workRequests["inf:work:report"].request.parse([effects[1]?.request])[0].declared
        ?.validation;
      if (!proof || proof.kind !== "run")
        throw new Error("The paired report lost its validation run.");
      expect(proof).toMatchObject({
        head,
        scenarioRevision: 1,
        completion: "complete",
        observations: [{ scenario: "paired-report", evidence: ["received"] }],
      });
      const received = proof.evidence[0]!;
      expect(received.text).toBe(transcript);
      expectBytesEqual(
        at.home.recordings.get(String(effects[0]?.request.id)) as Buffer,
        Buffer.from(transcript),
      );
      expect(effects[0]?.request).toMatchObject({
        extension: "json",
        size: Buffer.byteLength(transcript),
        offset: 0,
      });
    },
  );

  // INF-1109's required main integration absorbs INF-1555 F12 into the work major:
  // INF-3042: retired names do not block an already admitted work session;
  // connection tests own major admission.
  it.each(
    [PROTOCOL_VERSION, undefined].flatMap((homeVersion) =>
      [[], ["check-declarations"], ["check-declarations", "merge-offer-readiness"]].map(
        (homeChanges) => ({ homeVersion, homeChanges }),
      ),
    ),
  )(
    "forwards check declarations after work admission ($homeVersion, $homeChanges)",
    async ({ homeVersion, homeChanges }) => {
      const at = await placed({ ...(homeVersion ? { homeVersion } : {}), homeChanges });
      await at.order("inf:session:open", [
        {
          orderId: `open:${TASK}:1`,
          task: TASK,
          spec: { ...at.spec, tools: [...at.spec.tools, "check_change"] },
        },
      ]);
      const input = {
        declaration: {
          headSha: "93355db9d04e964513879db74d068a7789cb4c16",
          verdict: "flake",
          check: "linux-checks",
          evidence: "The failed log differs from the successful same-version rerun.",
        },
      };
      model([{ tools: [{ name: "check_change", args: input }] }, { text: "Recorded the result." }]);
      await at.order("inf:session:prompt", [
        { orderId: "check-judgment", task: TASK, text: "Record the check judgment." },
      ]);
      await at.ended(1);
      const effects = at.home.effects.filter(
        (effect) => effect.channel === "inf:work:check-change",
      );
      expect(effects.map((effect) => effect.request.input)).toEqual([input]);
    },
  );

  // INF-1109's required update absorbs INF-1932 into the work major. A current home needs no
  // retired name or duplicated version callback after connection admission (INF-3042).
  it.each([
    { supported: true, listed: true },
    { supported: true, listed: false },
    { supported: false, listed: true },
    { supported: false, listed: false },
  ])(
    "asks for artifact selections after admission (explicit version: $supported, retired name: $listed)",
    async ({ supported, listed }) => {
      const at = await placed({
        ...(supported ? { homeVersion: PROTOCOL_VERSION } : {}),
        homeChanges: listed
          ? [...CONTRACT_CHANGES.names, "artifact-parts"]
          : CONTRACT_CHANGES.names,
      });
      await at.order("inf:session:open", [
        {
          orderId: `open:${TASK}:1`,
          task: TASK,
          spec: { ...at.spec, tools: [...at.spec.tools, "download_artifact"] },
        },
      ]);
      const whole = { runId: 41007625484, artifactId: 12960596943 };
      const selected = { ...whole, files: ["ipad/join/48-xcodebuild.log"] };
      model([
        {
          tools: [
            { name: "download_artifact", args: whole },
            { name: "download_artifact", args: selected },
          ],
        },
        { text: "Read the log." },
      ]);
      await at.order("inf:session:prompt", [
        { orderId: "artifact-parts", task: TASK, text: "Read the iPad join log." },
      ]);
      await at.ended(1);
      const asked = at.home.effects
        .filter((effect) => effect.channel === "inf:work:download-artifact")
        .map((effect) => effect.request.input);
      expect(asked).toEqual([whole, selected]);
    },
  );

  // INF-2330: the home saves one exact workflow file into task evidence.
  it("sends an exact workflow file to the home", async () => {
    const at = await placed();
    await at.order("inf:session:open", [
      {
        orderId: `open:${TASK}:1`,
        task: TASK,
        spec: { ...at.spec, tools: [...at.spec.tools, "download_artifact"] },
      },
    ]);
    const input = {
      runId: 41464279524,
      artifactId: 13168688886,
      file: "ipad/rest/77D9D1B4-0109-473B-849C-B88EBF3250C7.mp4",
    };
    model([
      { tools: [{ name: "download_artifact", args: input }] },
      { text: "Read the recording." },
    ]);
    await at.order("inf:session:prompt", [
      { orderId: "evidence-file", task: TASK, text: "Read the recording." },
    ]);
    await at.ended(1);
    const asked = at.home.effects
      .filter((effect) => effect.channel === "inf:work:download-artifact")
      .map((effect) => effect.request.input);
    expect(asked).toEqual([input]);
  });

  // INF-3042: major 15 absorbs INF-3022; every admitted home can start programs,
  // whether or not it advertises the retired minor name.
  it.each([{ changes: [] as string[] }, { changes: ["crewmate-programs"] }])(
    "sends start_program after work admission ($changes)",
    async ({ changes }) => {
      const at = await placed({ homeChanges: changes });
      await at.order("inf:session:open", [
        {
          orderId: `open:${TASK}:1`,
          task: TASK,
          spec: { ...at.spec, tools: [...at.spec.tools, "start_program"] },
        },
      ]);
      const input = {
        title: "Read the website",
        goal: "Say what the README holds.",
        script: "return 1;",
        bound: 1,
      };
      model([{ tools: [{ name: "start_program", args: input }] }, { text: "Done." }]);
      await at.order("inf:session:prompt", [
        { orderId: "rows:program", task: TASK, text: "Use start_program to do this." },
      ]);
      await at.ended(1);
      const asked = at.home.effects.filter((effect) => effect.channel === "inf:work:start-program");
      expect(asked.map((effect) => effect.request.input)).toEqual([input]);
    },
  );

  // The required Secrets major absorption includes INF-3060's story-fact-copies:
  // every admitted home compares copies, with or without the retired name.
  // Connection tests own other-major refusal; completion tests own exact-copy
  // acceptance and differing-copy refusal at the home. Keep both caller cases.
  it.each([{ changes: [] as string[] }, { changes: ["story-fact-copies"] }])(
    "sends a saved-story card's copied facts after work admission ($changes)",
    async ({ changes }) => {
      const at = await placed({ homeChanges: changes });
      await at.order("inf:session:open", [
        { orderId: `open:${TASK}:1`, task: TASK, spec: at.spec },
      ]);
      const input = {
        title: "fix(meter): keep the confirmed receipt",
        presentation: 1,
        actions: [{ id: "merge", default: true, effect: { kind: "merge", after: "close" } }],
        required_actions: [],
      };
      model([{ tools: [{ name: "emit_card", args: input }] }, { text: "Done." }]);
      await at.order("inf:session:prompt", [
        { orderId: "story-copy", task: TASK, text: "Show the merge card." },
      ]);
      await at.ended(1);
      const shown = at.home.effects.filter((effect) => effect.channel === "inf:work:card");
      expect(
        shown.map(
          (effect) => (effect.request.card as { requiredActions?: unknown }).requiredActions,
        ),
      ).toEqual([[]]);
    },
  );

  // INF-497: a home before `STORY_AROUND_SINCE` strips around from open_change and
  // would answer as if the words had been changed; the computer refuses first.
  it("refuses to change the words around a story through a home too old to keep the story, sending nothing", async () => {
    const at = await placed({ homeVersion: "10.0.0" });
    await at.order("inf:session:open", [
      {
        orderId: `open:${TASK}:1`,
        task: TASK,
        spec: { ...at.spec, tools: [...at.spec.tools, "open_change"] },
      },
    ]);
    const title = "feat(validation): require reviewed live proof for careful changes";
    model([
      {
        tools: [
          {
            name: "open_change",
            args: {
              title,
              presentation: 2,
              around: {
                from: "This first publication advances the published protocol to 9.0.0.",
                to: "The published protocol advances to 10.0.0.",
              },
            },
          },
        ],
      },
      { tools: [{ name: "open_change", args: { title, presentation: 2 } }] },
      { text: "Reported." },
    ]);
    await at.order("inf:session:prompt", [
      { orderId: "rows:around", task: TASK, text: "Correct the summary above the story." },
    ]);
    await at.ended(1);

    expect(at.home.effects.map((effect) => effect.channel)).toEqual(["inf:work:open-change"]);
    expect(at.home.effects[0]?.request).toMatchObject({ input: { title, presentation: 2 } });
    expect(at.home.effects[0]?.request).not.toHaveProperty("input.around");
    const ends = at.home.events.filter(
      (record) => record.event.type === "tool_end" && record.event.toolName === "open_change",
    );
    expect(ends.map((record) => record.event)).toMatchObject([{ isError: true }, {}]);
    expect(JSON.stringify(api.requests.at(-1)?.body?.messages)).toContain(
      "runs an older Infinitary that cannot change the words around a story; nothing was sent",
    );
  });

  // INF-2184 / INF-3042: a named branch survives forwarding after work admission.
  it.each([true, false])(
    "opens the named branch after admission (explicit version: %s)",
    async (supported) => {
      const at = await placed({
        ...(supported ? { homeVersion: PROTOCOL_VERSION } : {}),
        homeChanges: [],
      });
      await at.order("inf:session:open", [
        {
          orderId: `open:${TASK}:1`,
          task: TASK,
          spec: { ...at.spec, tools: [...at.spec.tools, "open_change"] },
        },
      ]);
      const input = {
        title: "chore(main): release 0.1.8",
        body: "The release the captain asked to open.",
        branch: "release-please--branches--main",
      };
      model([{ tools: [{ name: "open_change", args: input }] }, { text: "Reported." }]);
      await at.order("inf:session:prompt", [
        { orderId: "open-branch", task: TASK, text: "Open the release pull request." },
      ]);
      await at.ended(1);
      const asked = at.home.effects
        .filter((effect) => effect.channel === "inf:work:open-change")
        .map((effect) => effect.request.input);
      expect(asked).toEqual([input]);
    },
  );

  it("keeps a crewmate's builds and tests below the UI as another user on the home's own Mac", async () => {
    // Captain on INF-255. This world joins by a link for another user here (`work`).
    const at = await placed();
    await at.open();
    expect(at.belowUi()).toBe(true);
  });

  // A user's report: crew conversations summarized far past their model's
  // 272,000-token price step. INF-6693: one held on a computer that runs work
  // opens with the one summary rule the first mate and a crewmate at home carry.
  it("opens a crewmate's conversation with the shared rule to summarize at 300,000 or below the price step", async () => {
    const at = await placed();
    const factory = (
      at.host() as unknown as {
        options: { factories: { pi: { open: (spec: SessionSpec) => Promise<unknown> } } };
      }
    ).options.factories.pi;
    const open = vi.spyOn(factory, "open");
    await at.open();
    expect(open.mock.calls.map(([spec]) => spec.compaction)).toEqual([SESSION_COMPACTION]);
  });

  // INF-6693's plan: the home's summary point travels with the open, and an
  // older home that sends none leaves the computer on the app's own rule.
  it("opens a crewmate's conversation with the summary point the home sends", async () => {
    const at = await placed();
    const factory = (
      at.host() as unknown as {
        options: { factories: { pi: { open: (spec: SessionSpec) => Promise<unknown> } } };
      }
    ).options.factories.pi;
    const open = vi.spyOn(factory, "open");
    await at.order("inf:session:open", [
      {
        orderId: `open:${TASK}:1`,
        task: TASK,
        spec: { ...at.spec, compaction: { maxContextTokens: 500_000 } },
      },
    ]);
    expect(open.mock.calls.map(([spec]) => spec.compaction)).toEqual([
      { maxContextTokens: 500_000 },
    ]);
  });

  it("refuses an order it does not know, a malformed one, and one for a task it never opened", async () => {
    const at = await placed();
    await expect(at.order("inf:session:launch" as WorkOrderChannel, [])).rejects.toThrow(
      "not a request this computer answers",
    );
    await expect(at.order("inf:session:prompt", [{ task: TASK }])).rejects.toThrow("malformed");
    await expect(
      at.order("inf:session:prompt", [{ orderId: "rows:9", task: TASK, text: "Hi." }]),
    ).rejects.toThrow("No conversation is open");
    // Nothing open to stop: nothing done, and nothing kept for a task it never held.
    expect(await at.order("inf:session:abort", [{ orderId: "stop:1", task: TASK }])).toEqual({
      ok: true,
    });
    expect((await at.order("inf:session:roster", [])).tasks).toEqual([]);
    // A computer that keeps no working copies holds a task's work in its
    // folder, so it never removes one.
    await expect(
      at.order("inf:session:remove", [{ orderId: "remove:1", task: TASK }]),
    ).rejects.toThrow("keeps a task's work in its folder");
    await expect(
      at.order("inf:session:open", [{ orderId: "open:x", task: "../escape", spec: at.spec }]),
    ).rejects.toThrow("malformed");
    expect(existsSync(join(at.dataDir, "escape"))).toBe(false);
  });
});
