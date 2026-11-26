import { cardSchema } from "@shared/cards";
import { PROTOCOL_VERSION } from "@shared/ipc";
import { SECRET_BRING_CARD_WORDS } from "@shared/secretBring";
import type { IntegrationAsk } from "@shared/writeAsk";
import { describe, expect, it } from "vitest";
import { connectClient } from "../../../tests/helpers/connectionClient";
import { home } from "../../../tests/helpers/connectionHome";
import { eventScreenOfferCard } from "../decisions/eventScreenOffer";
import type { CoreDispatch } from "../dispatcher";
import { creditsOfferCard, firstmatePauseCard, hostCard } from "../orchestrator/hostCards";
import { integrationApprovalCard } from "../orchestrator/integrationApprovalCard";
import { loginLowCard } from "../orchestrator/loginCards";
import { bringCardBody } from "../secrets/bringCard";
import { frameWithoutTaskAllow, readsTaskAllow } from "./taskAllow";

// INF-2993: a view that does not list `integration-task-allow` reads a
// request_write's choices strictly, so the home leaves Allow for the rest of
// this task off every card it sends that view, which shows the other three.
describe("a card frame for a view without Allow for the rest of this task (INF-2993)", () => {
  const ask: IntegrationAsk = {
    id: "pulls",
    kind: "integration",
    integration: "github",
    connection: "c-github",
    place: "GitHub",
    action: "write",
    label: "Change something on GitHub",
    description: "POST, PATCH, PUT or DELETE one path through the captain's GitHub sign-in.",
    effect: "changes",
    reason: "Open the proof pull request the task asks for.",
    signature: '["POST, PATCH, PUT or DELETE one path","changes"]',
    input: JSON.stringify({ method: "POST", path: "/repos/octo/queue-proof-4ca5/pulls" }),
    scope: {
      key: "POST /repos/octo/queue-proof-4ca5",
      words: "POST requests to octo/queue-proof-4ca5",
    },
    at: 1,
  };

  it("leaves that button off a pushed card and passes every other frame as it is", () => {
    const card = integrationApprovalCard(ask, {
      id: "task-1",
      title: "Open the proof pull request",
    });
    const frame = JSON.stringify({ channel: "inf:cards:changed", payload: { cards: [card] } });
    const sent = JSON.parse(frameWithoutTaskAllow(frame));
    expect(
      sent.payload.cards[0].actions.map(
        (action: { effect: { integration: string } }) => action.effect.integration,
      ),
    ).toEqual(["deny", "once", "always"]);
    expect(sent.payload.cards[0].title).toBe(card.title);
    const { scope: _none, ...unscoped } = ask;
    const other = JSON.stringify({
      channel: "inf:cards:changed",
      payload: { cards: [integrationApprovalCard(unscoped, { id: "task-1", title: "t" })] },
    });
    expect(frameWithoutTaskAllow(other)).toBe(other);
  });
});

// INF-3042: the major absorbs the named addition; older views still negotiate it.
it("recognizes task-wide Allow by major or the older advertised name", () => {
  expect(readsTaskAllow("15.0.0", [])).toBe(true);
  expect(readsTaskAllow("14.0.0", ["integration-task-allow"])).toBe(true);
  expect(readsTaskAllow("14.0.0", [])).toBe(false);
});

// INF-4104 piece 2, the captain's ruling on its review: an older desktop
// reads a host effect's operation strictly, so the home leaves the Keep
// going on credits button off every card it sends a view on major 15 that
// does not list the change, in pushes and in the list and show answers; a
// desktop on major 16, one on major 15 listing it and the phone, which reads
// the operation as text, get it. A desktop on major 15 says its floor in its
// hello, so it still changes things on a home one major on.
it("sends the Keep going on credits button only to views that read it", async () => {
  const card = cardSchema.parse({
    ...firstmatePauseCard("card-firstmate-paused", {
      pause: "no_headroom",
      body: "<p>Claude has used up its allowance until 9:00 PM.</p>",
      accountId: "claude-personal",
      providerName: "Claude",
      credits: { usedPercent: 12 },
    }),
    createdAt: 1000,
  });
  const at = await home({
    dispatch: (async (channel) => {
      if (channel === "inf:cards:list") return [card];
      if (channel === "inf:cards:show") return card;
      throw new Error("Unexpected request");
    }) as CoreDispatch,
  });
  const grant = await at.join();
  const old = await connectClient(grant, {
    protocolVersion: "15.0.0",
    viewFloor: 15,
    changes: [],
  });
  const named = await connectClient(grant, {
    protocolVersion: "15.0.0",
    viewFloor: 15,
    changes: ["keep-going-on-credits"],
  });
  const current = await connectClient(grant, { protocolVersion: PROTOCOL_VERSION, changes: [] });
  const phone = await connectClient(grant, { system: { system: "ios" }, changes: [] });
  const ids = (value: unknown) =>
    (value as { actions: { id: string }[] }).actions.map((action) => action.id);
  const without = ["recheck-allowance", "open-settings"];
  expect(ids((await old.invoke("inf:cards:list", []))[0])).toEqual(without);
  expect(ids(await old.invoke("inf:cards:show", [card.id]))).toEqual(without);
  expect((await named.invoke("inf:cards:list", []))[0]).toEqual(card);
  expect(await named.invoke("inf:cards:show", [card.id])).toEqual(card);
  expect((await current.invoke("inf:cards:list", []))[0]).toEqual(card);
  expect(await current.invoke("inf:cards:show", [card.id])).toEqual(card);
  expect((await phone.invoke("inf:cards:list", []))[0]).toEqual(card);
  at.events.emit("inf:cards", [card]);
  const oldPush = await old.push((push) => push.channel === "inf:cards");
  expect(ids((oldPush.payload as unknown[])[0])).toEqual(without);
  expect((await named.push((push) => push.channel === "inf:cards")).payload).toEqual([card]);
  expect((await current.push((push) => push.channel === "inf:cards")).payload).toEqual([card]);
  expect((await phone.push((push) => push.channel === "inf:cards")).payload).toEqual([card]);
  await old.close();
  await named.close();
  await current.close();
  await phone.close();
});

// INF-4239: an ask to keep a secret is answered with a Keep that sends the
// typed values in their own request, which an older window or phone does not
// make. The home leaves Keep in Secrets off every card it sends a view whose
// hello does not list `secrets-ask`, so that view shows the card's line
// saying where to answer it and its Don't keep still works.
it("sends Keep in Secrets only to views that list the ask", async () => {
  const card = cardSchema.parse({
    id: "card-secrets-ask-task-1-checkout",
    title: "Keep Stripe test key for “Wire up the checkout”?",
    body: "<p>Asked by the crewmate on this task.</p>",
    author: "host",
    meta: "Infinitary",
    priority: 1,
    status: "ready",
    createdAt: 1000,
    actions: [
      {
        id: "pass-dont",
        label: "Don't keep",
        effect: { kind: "host", op: "secrets-decision", arg: "pass-dont" },
      },
      {
        id: "pass-keep",
        label: "Keep in Secrets",
        default: true,
        effect: {
          kind: "host",
          op: "secrets-keep",
          arg: JSON.stringify({ fields: [{ id: "s1", name: "Stripe test key", place: "Test" }] }),
        },
      },
    ],
  });
  const at = await home({
    dispatch: (async (channel) => {
      if (channel === "inf:cards:list") return [card];
      if (channel === "inf:cards:show") return card;
      throw new Error("Unexpected request");
    }) as CoreDispatch,
  });
  const grant = await at.join();
  const old = await connectClient(grant, { protocolVersion: PROTOCOL_VERSION, changes: [] });
  const oldPhone = await connectClient(grant, { system: { system: "ios" }, changes: [] });
  const current = await connectClient(grant, {
    protocolVersion: PROTOCOL_VERSION,
    changes: ["secrets-ask"],
  });
  const phone = await connectClient(grant, {
    system: { system: "ios" },
    changes: ["secrets-ask"],
  });
  const ids = (value: unknown) =>
    (value as { actions: { id: string }[] }).actions.map((action) => action.id);
  for (const view of [old, oldPhone]) {
    expect(ids((await view.invoke("inf:cards:list", []))[0])).toEqual(["pass-dont"]);
    expect(ids(await view.invoke("inf:cards:show", [card.id]))).toEqual(["pass-dont"]);
  }
  for (const view of [current, phone]) {
    expect((await view.invoke("inf:cards:list", []))[0]).toEqual(card);
    expect(await view.invoke("inf:cards:show", [card.id])).toEqual(card);
  }
  at.events.emit("inf:cards", [card]);
  const oldPush = await old.push((push) => push.channel === "inf:cards");
  expect(ids((oldPush.payload as unknown[])[0])).toEqual(["pass-dont"]);
  expect((await current.push((push) => push.channel === "inf:cards")).payload).toEqual([card]);
  for (const view of [old, oldPhone, current, phone]) await view.close();
});

// INF-4667 finding 1: the event screen's offer card turns the screen on with
// a host operation an older window reads strictly. The home leaves Turn on
// off every card it sends a desktop view whose hello does not list
// `event-screen-offer`, so it shows Not now and the line naming Settings; the
// phone reads a host operation as text and always gets Turn on.
it("sends the event screen's Turn on only to views that read it", async () => {
  const card = cardSchema.parse({
    ...eventScreenOfferCard({
      rule: { label: "Microsoft email", waitsFor: "An email from Microsoft" },
      disclosure: { version: 1, text: ["Each new event's summary goes to the model."] },
      needsApproval: false,
    }),
    author: "host",
    priority: 1,
    status: "ready",
    createdAt: 1000,
  });
  const at = await home({
    dispatch: (async (channel) => {
      if (channel === "inf:cards:list") return [card];
      throw new Error("Unexpected request");
    }) as CoreDispatch,
  });
  const grant = await at.join();
  const old = await connectClient(grant, { protocolVersion: PROTOCOL_VERSION, changes: [] });
  const oldPhone = await connectClient(grant, { system: { system: "ios" }, changes: [] });
  const current = await connectClient(grant, {
    protocolVersion: PROTOCOL_VERSION,
    changes: ["event-screen-offer"],
  });
  const ids = (value: unknown) =>
    (value as { actions: { id: string }[] }).actions.map((action) => action.id);
  expect(ids((await old.invoke("inf:cards:list", []))[0])).toEqual(["not-now"]);
  expect((await oldPhone.invoke("inf:cards:list", []))[0]).toEqual(card);
  expect((await current.invoke("inf:cards:list", []))[0]).toEqual(card);
  expect(card.body).toContain("Settings → Intelligence → Decisions");
  at.events.emit("inf:cards", [card]);
  const oldPush = await old.push((push) => push.channel === "inf:cards");
  expect(ids((oldPush.payload as unknown[])[0])).toEqual(["not-now"]);
  for (const view of [old, oldPhone, current]) await view.close();
});

// Intent: INF-4718's plan, piece 1, and the captain's choice on its review:
// the line saying where to pick shows "only where the card cannot be
// answered". A view without the tick boxes gets no Bring into Secrets and
// sees that line; the home window and a current view keep it hidden.
it("sends Bring into Secrets only to views that list the bring, and shows the others where to pick", async () => {
  const body = bringCardBody({
    key: "task-1:av",
    task: "task-1",
    id: "av",
    // An agent's words that spell the line's marker must not move it.
    reason: "Move the staging keys, data-secret-bring-elsewhere hidden",
    tool: "Automic Vault",
    at: 1000,
    reads: "env0",
    source: {
      kind: "run",
      program: { path: "/usr/local/bin/av", sha256: "0".repeat(64) },
      argv: ["av", "inject", "staging"],
      folder: "/srv/app",
    },
    rows: [{ id: "s1", source: "STAGING_TOKEN", name: "STAGING_TOKEN", place: "", ticked: true }],
  });
  const card = cardSchema.parse({
    id: "card-secrets-bring-task-1-av",
    title: SECRET_BRING_CARD_WORDS.title(1, "Automic Vault"),
    body,
    author: "host",
    meta: "Infinitary",
    priority: 1,
    status: "ready",
    createdAt: 1000,
    actions: [
      {
        id: "pass-dont",
        label: SECRET_BRING_CARD_WORDS.dontBring,
        effect: { kind: "host", op: "secrets-decision", arg: "pass-dont" },
      },
      {
        id: "pass-bring",
        label: SECRET_BRING_CARD_WORDS.bring,
        default: true,
        effect: { kind: "host", op: "secrets-bring", arg: JSON.stringify({ pass: "pass-bring" }) },
      },
    ],
  });
  const at = await home({
    dispatch: (async (channel) => {
      if (channel === "inf:cards:list") return [card];
      throw new Error("Unexpected request");
    }) as CoreDispatch,
  });
  const grant = await at.join();
  const phone = await connectClient(grant, {
    system: { system: "ios" },
    changes: ["secrets-ask"],
  });
  const current = await connectClient(grant, {
    protocolVersion: PROTOCOL_VERSION,
    changes: ["secrets-ask", "secrets-bring"],
  });
  const shows = (html: string) => {
    const line = html.match(/<p[^>]*data-secret-bring-elsewhere[^>]*>/)?.[0];
    if (!line) throw new Error("The card has no line saying where to pick.");
    return !/\bhidden\b/.test(line);
  };
  expect(shows(card.body)).toBe(false);
  const [toPhone] = (await phone.invoke("inf:cards:list", [])) as (typeof card)[];
  expect(toPhone?.actions.map((action) => action.id)).toEqual(["pass-dont"]);
  expect(shows(toPhone?.body ?? "")).toBe(true);
  expect(toPhone?.body).toContain(SECRET_BRING_CARD_WORDS.elsewhere);
  expect((await current.invoke("inf:cards:list", []))[0]).toEqual(card);
  for (const view of [phone, current]) await view.close();
});

// INF-5478's plan, piece 1: a card's Use a saved reset lands an older view
// on the account's row, which does not start the use there, so the home
// sends the button only to a view that lists `use-saved-reset`; every other
// button on the card still goes.
it("sends a card's Use a saved reset only to views that list its change", async () => {
  const card = cardSchema.parse({
    ...firstmatePauseCard("card-firstmate-paused", {
      pause: "no_headroom",
      body: "<p>Codex has used up its allowance until 9:00 PM.</p>",
      accountId: "codex-work",
      providerName: "Codex",
      savedResets: true,
    }),
    createdAt: 1000,
  });
  const ids = (value: unknown) =>
    (value as { actions: { id: string }[] }).actions.map((action) => action.id);
  expect(ids(card)).toContain("use-saved-reset");
  const at = await home({
    dispatch: (async (channel) => {
      if (channel === "inf:cards:list") return [card];
      throw new Error("Unexpected request");
    }) as CoreDispatch,
  });
  const grant = await at.join();
  const old = await connectClient(grant, { protocolVersion: PROTOCOL_VERSION, changes: [] });
  const phone = await connectClient(grant, { system: { system: "ios" }, changes: [] });
  const current = await connectClient(grant, {
    protocolVersion: PROTOCOL_VERSION,
    changes: ["use-saved-reset"],
  });
  const without = ids(card).filter((id) => id !== "use-saved-reset");
  expect(ids((await old.invoke("inf:cards:list", []))[0])).toEqual(without);
  expect(ids((await phone.invoke("inf:cards:list", []))[0])).toEqual(without);
  expect((await current.invoke("inf:cards:list", []))[0]).toEqual(card);
  at.events.emit("inf:cards", [card]);
  expect(
    ids(((await old.push((push) => push.channel === "inf:cards")).payload as unknown[])[0]),
  ).toEqual(without);
  expect((await current.push((push) => push.channel === "inf:cards")).payload).toEqual([card]);
  for (const view of [old, phone, current]) await view.close();
});

// INF-5478's plan, piece 2: an older view's host does not know the
// use-saved-resets operation, so the home sends that button only to a view
// that lists `auto-saved-resets`; the card's other buttons still go.
it("sends a run-out card's Use saved resets on their own only to views that list its change", async () => {
  const card = cardSchema.parse({
    ...hostCard(
      creditsOfferCard({
        accountId: "codex-work",
        name: "Codex · Work",
        resetsAt: "9:00 PM",
        savedResets: { provider: "codex", count: 2 },
        offerAutoResets: true,
      }),
    ),
    createdAt: 1000,
  });
  const ids = (value: unknown) =>
    (value as { actions: { id: string }[] }).actions.map((action) => action.id);
  expect(ids(card)).toEqual(["use-saved-reset", "use-saved-resets"]);
  const at = await home({
    dispatch: (async (channel) => {
      if (channel === "inf:cards:list") return [card];
      throw new Error("Unexpected request");
    }) as CoreDispatch,
  });
  const grant = await at.join();
  const old = await connectClient(grant, {
    protocolVersion: PROTOCOL_VERSION,
    changes: ["use-saved-reset"],
  });
  const current = await connectClient(grant, {
    protocolVersion: PROTOCOL_VERSION,
    changes: ["use-saved-reset", "auto-saved-resets"],
  });
  expect(ids((await old.invoke("inf:cards:list", []))[0])).toEqual(["use-saved-reset"]);
  expect((await current.invoke("inf:cards:list", []))[0]).toEqual(card);
  for (const view of [old, current]) await view.close();
});

// The approved plan for several logins of one provider, piece 3: an older
// desktop view's host does not know the move-login operation, so the home
// sends Move to another login only to a view that lists
// `when-login-runs-low`, or to the phone; the card's other button still goes.
it("sends a low login's Move to another login only to views that read it", async () => {
  const card = cardSchema.parse({
    ...hostCard(
      loginLowCard({
        providerId: "openai-codex",
        providerName: "ChatGPT",
        accountId: "codex-personal",
        login: "Personal",
        percentLeft: 8,
        other: { accountId: "codex-work", label: "Work" },
      }),
    ),
    createdAt: 1000,
  });
  const ids = (value: unknown) =>
    (value as { actions: { id: string }[] }).actions.map((action) => action.id);
  expect(ids(card)).toEqual(["move-login-codex-personal-codex-work", "wait-for-refill"]);
  const at = await home({
    dispatch: (async (channel) => {
      if (channel === "inf:cards:list") return [card];
      throw new Error("Unexpected request");
    }) as CoreDispatch,
  });
  const grant = await at.join();
  const old = await connectClient(grant, { protocolVersion: PROTOCOL_VERSION, changes: [] });
  const phone = await connectClient(grant, { system: { system: "ios" }, changes: [] });
  const current = await connectClient(grant, {
    protocolVersion: PROTOCOL_VERSION,
    changes: ["when-login-runs-low"],
  });
  expect(ids((await old.invoke("inf:cards:list", []))[0])).toEqual(["wait-for-refill"]);
  expect((await phone.invoke("inf:cards:list", []))[0]).toEqual(card);
  expect((await current.invoke("inf:cards:list", []))[0]).toEqual(card);
  for (const view of [old, phone, current]) await view.close();
});
