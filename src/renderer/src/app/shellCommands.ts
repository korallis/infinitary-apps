import { FEEDBACK_DRAFT } from "@shared/feedback";
import {
  isPanelCommandId,
  isShellCommand,
  type PanelCommandId,
  type ShellCommandId,
  type WindowCommandId,
} from "@shared/keyboard";
import { openStyleList } from "../ambient/styleList";
import { openCardFind, stepCardFind, useCardFind } from "../cards/cardFind";
import { cardTaskOf } from "../cards/cardTask";
import { askQuestionStep } from "../cards/questionEvent";
import {
  isRecordView,
  shownTaskTabs,
  type TabCommand,
  tabKindOf,
  tabShownOf,
  tabTargetOf,
  tabTaskOf,
} from "../cards/taskTabs";
import { crewOrbit } from "../character/crew/crewSignal";
import { SAVE_PICTURE_EVENT } from "../design/cards/PictureViewer";
import { focusWithRing } from "../design/focus";
import { giveFocusBack, moveInFrame } from "../plugins/frames/frameFocus";
import { pluginHost } from "../plugins/host";
import { panelCommandRefusal, runPanelCommand } from "../plugins/panelCommands";
import { boardOnScreen } from "../plugins/reads/appExecutor";
import { HOME_UPDATE_ROW } from "../settings/HomeUpdateRow";
import { startSecretsMove } from "../settings/secretsMove";
import { signInsInSecrets } from "../settings/WebsiteSignInsSection";
import { cardStage } from "./cardStage";
import { commandRefusal, type WindowFacts } from "./commandRefusals";
import { mainMessageRefusal } from "./composer";
import { landLostFocus, typingWhereFocusRested } from "./focusLanding";
import { available, modalOpen } from "./focusRecovery";
import { type CommandVia, pressForCommand } from "./pressInput";
import { projectFocus } from "./projectFocus";
import { enterCard, moveToRegion, moveToRegionToward } from "./regions";
import { isHeldEntry, shownEntry } from "./stack";
import { type ShellState, useShellStore } from "./store";
import {
  checkForUpdates,
  checksUpdates,
  savingForUpdate,
  setUpdateNoticeOpen,
  updateLater,
  useUpdateState,
} from "./updateState";
import { markWindowKeys } from "./windowKeysMark";

/**
 * The window commands the shell page runs (docs/keyboard.md). The main
 * process hears their keys wherever focus is, a card's or a panel's frame
 * included, and names the command; whether it may run now is decided here
 * (./commandRefusals), against the window as it is when the command arrives,
 * and a refused command's key does nothing.
 */

/** Keyboard settings' search field, which Open Keyboard settings gives the caret. */
const KEYBOARD_SEARCH = "[data-keyboard-settings] [data-keyboard-search] input";
/** Settings → Panels' one Tab stop among its rows (PanelsTab.tsx). */
const PANELS_ROW = '[data-panels-settings] [data-panels-row][tabindex="0"]';

/** Usage's unit switch, its first control, where Open Usage puts focus. */
const USAGE_UNIT = '[data-settings-section="usage"] [data-usage-unit] input:checked';

function onShownCard(act: (stage: NonNullable<ReturnType<typeof cardStage>>) => void): void {
  const stage = cardStage();
  if (stage && stage.shownId === shownEntry(useShellStore.getState())?.id) act(stage);
}

/** A tab command on the shown task card's strip, while the store still shows that card. */
function toTab(command: TabCommand): void {
  const shell = useShellStore.getState();
  const entry = shownEntry(shell);
  if (entry && !isHeldEntry(entry)) {
    // A card about a task: its tab opens in front of the card, which Hide
    // returns to (INF-358); the refusal already said when it cannot.
    const task = cardTaskOf(entry);
    const wanted = tabKindOf(command);
    if (!task || !wanted) return;
    const from = { cardId: entry.id };
    if (isRecordView(wanted)) shell.openRecord(task.id, from, wanted);
    else if (wanted === "crewmate") shell.openCrewmateView(task.id, from);
    else shell.openBrowserView(task.id, from);
    return;
  }
  const taskId = entry && tabTaskOf(entry);
  const kind = entry && tabShownOf(entry);
  const handle = taskId && kind ? shownTaskTabs(taskId, kind) : undefined;
  const to = handle ? tabTargetOf(command, handle) : null;
  if (handle && to !== null) handle.go(to);
}

/**
 * Runs `then` once `ready` holds, checking each frame for about half a
 * second: a view the command just went home to draws on the next frames.
 */
function whenReady(ready: () => boolean, then: () => void, frames = 30): void {
  if (ready()) {
    then();
    return;
  }
  if (frames > 0) requestAnimationFrame(() => whenReady(ready, then, frames - 1));
}

function shownPart(entryId: string, selector: string): HTMLElement | null {
  const part = document.querySelector<HTMLElement>(
    `[data-card-layer] [data-stage-entry="shown"][data-stage-entry-id="${CSS.escape(entryId)}"] ${selector}`,
  );
  return part && available(part) ? part : null;
}

/** The open picture viewer's Point at, where its picture takes a mark (docs/card-threads.md, "Pointing at a place"). */
const viewerPointAt = () =>
  document.querySelector<HTMLElement>(
    "[data-picture-viewer] [data-viewer-point-at]:not([aria-disabled=true])",
  );

/** The shown Browser tab's Point at, while it shows a page (docs/task-browser.md, "Pointing at a page"). */
const browserPointAt = (entryId: string) =>
  shownPart(entryId, "[data-browser-point-at]:not(:disabled):not([aria-disabled=true])");

const browserControlButton = (entryId: string) =>
  shownPart(entryId, "[data-browser-handoff] button:not(:disabled):not([aria-disabled=true])");

/** The shown task record's Move to a computer, while its task may move. */
const moveComputerButton = (entryId: string) =>
  shownPart(entryId, "[data-record-move-open]:enabled");

const closeDoneButton = (entryId: string) => shownPart(entryId, "[data-record-close-done]:enabled");

/** The shown record's Edit tags, on its Info tab while its project has tags. */
const editTagsButton = (entryId: string) => shownPart(entryId, "[data-record-tags] button");

/**
 * Whether the shown card or task tab is about a task whose project has tags
 * or that carries one, as the board last presented it: Edit tags then opens
 * the record's Info tab first (docs/task-tags.md).
 */
function shownTaskTaggable(): boolean {
  const entry = shownEntry(useShellStore.getState());
  if (!entry) return false;
  const taskId = isHeldEntry(entry) ? tabTaskOf(entry) : cardTaskOf(entry)?.id;
  const board = boardOnScreen();
  const task = taskId ? board?.tasks.find((row) => row.id === taskId) : undefined;
  if (!task) return false;
  const project = board?.projects.find((row) => row.id === task.projectId);
  return (project?.tags?.length ?? 0) > 0 || (task.tags?.length ?? 0) > 0;
}

function editTags(): void {
  const entryId = shownEntry(useShellStore.getState())?.id;
  if (entryId && !editTagsButton(entryId)) toTab("cards.show-info");
  toShownPart(editTagsButton, (button) => button.click());
}

/** The shown card's jump down in its thread, while the captain reads above its foot. */
const threadJumpButton = (entryId: string) => shownPart(entryId, "[data-thread-jump]");

/** The shown card's sound strip's Play or Pause (docs/card-authoring.md, "Sound clips"). */
const soundToggle = (entryId: string) =>
  shownPart(entryId, "[data-card-sound] button[data-sound-toggle]:not(:disabled)");

const answerDoneButton = (entryId: string) =>
  shownPart(entryId, "button[data-answer-done-control]:not(:disabled)");

/** The shown decision's way to say no (INF-3108): the app's Decline or the author's own. */
const declineButton = (entryId: string) =>
  shownPart(entryId, "[data-card-actions] button[data-card-declines]:not(:disabled)");

/** The shown card's field, or that of the request docked beside a shown browser's page. */
const replyField = (cardId: string) =>
  shownPart(cardId, `[data-card-reply="${CSS.escape(cardId)}"] textarea`) ??
  shownPart(cardId, "[data-browser-request] [data-card-reply] textarea") ??
  shownPart(cardId, "[data-browser-crew] [data-crew-composer] textarea");

/** The request folded to its latest line under a shown browser's page. */
const foldedRequest = (entryId: string) =>
  shownPart(entryId, "[data-browser-request-folded], [data-browser-crew-folded]");

/** The Chat of a card whose thread opens before its field (an ask to keep a secret). */
const chatOpens = (entryId: string) => shownPart(entryId, "[data-card-chat-opens]");

/** The shown browser's page, while the captain holds it and it takes his keys. */
const browserPage = (entryId: string) =>
  shownPart(entryId, '[data-browser-page][data-browser-input="captain"]');

/** Back to the card docked beside the shown browser's page, where its choices are. */
const browserCardBack = (entryId: string) =>
  shownPart(entryId, "[data-browser-request] button[data-browser-card-back]");

/** The shown entry's body, the one place it scrolls. */
const cardBody = (entryId: string) => shownPart(entryId, "[data-card-body]");

const cardButton = (cardId: string) =>
  shownPart(cardId, "[data-card-actions] button[data-card-action-default]:enabled") ??
  shownPart(cardId, "[data-card-actions] button:enabled") ??
  answerDoneButton(cardId);

/**
 * Presses the shown card's nth choice (`choiceOrder`), the click the pointer
 * would make, saying that `command` pressed it and how it came (./pressInput).
 */
function pressCardChoice(index: number, command: ShellCommandId, via: CommandVia): void {
  const entryId = shownEntry(useShellStore.getState())?.id;
  if (!entryId) return;
  const button = shownPart(entryId, `[data-card-actions] [data-card-choice="${index}"]`);
  if (button) pressForCommand(button, command, via);
}

/**
 * Goes to a place in the entry the store shows now (docs/keyboard.md,
 * "Cards and frames"), from Settings by going home first: once it is drawn,
 * `enter` puts focus there, and only while that entry is still the shown
 * one, never another shown since.
 */
function toShownPart(
  find: (entryId: string) => HTMLElement | null,
  enter: (place: HTMLElement) => void,
): void {
  const s = useShellStore.getState();
  const entryId = shownEntry(s)?.id;
  if (!entryId) return;
  if (s.view !== "home") s.setView("home");
  const stillShown = () => shownEntry(useShellStore.getState())?.id === entryId;
  whenReady(
    () => !stillShown() || find(entryId) !== null,
    () => {
      const place = stillShown() ? find(entryId) : null;
      if (place) enter(place);
    },
  );
}

/**
 * The body takes focus as the place to read it: the reading keys scroll it,
 * and Tab goes on to the first control inside. It is no Tab stop of its
 * own, so a click on it never takes focus from the main message.
 */
function enterBody(body: HTMLElement): void {
  body.tabIndex = -1;
  body.addEventListener("blur", () => body.removeAttribute("tabindex"), { once: true });
  focusWithRing(body, { preventScroll: true });
}

/**
 * What's new (docs/release-notes.md "Reading a note again"): goes home and
 * asks the core's one door for the note shown for `version`, or else the
 * newest that listed changes. The core brings it forward on every window: an
 * open note to the front of the stack, a closed one read-only.
 */
export function showReleaseNote(version: string | null): void {
  const s = useShellStore.getState();
  if (s.view !== "home") s.setView("home");
  void window.infinitary.releaseNotes.show(version).catch(() => {});
}

/** What had focus when command search opened: where Escape returns it. */
let searchOpener: Element | null = null;

function searchField(): HTMLElement | null {
  const field = document.querySelector<HTMLElement>("[data-command-search] input");
  return field && available(field) ? field : null;
}

export function openCommandSearch(): void {
  const s = useShellStore.getState();
  if (s.commandSearchOpen) return;
  searchOpener = document.activeElement;
  s.setCommandSearchOpen(true);
  // Every opening puts the caret in the field, also one that arrives before
  // the window has drawn the last closing, which leaves the field drawn.
  const open = () => useShellStore.getState().commandSearchOpen;
  whenReady(
    () => !open() || searchField() !== null,
    () => {
      if (open()) searchField()?.focus({ preventScroll: true });
    },
  );
}

/**
 * Closes command search and gives focus back at once, before any command
 * chosen in it runs: to what had it, or else to the main message. Escape,
 * its own key, a click beside it and a chosen command all close it here.
 * Focus that was inside a card's or a panel's frame goes back to the field
 * inside it, its caret where it was, as when the picture viewer closes
 * (../plugins/frames/frameFocus).
 */
export function closeCommandSearch(): void {
  const s = useShellStore.getState();
  if (!s.commandSearchOpen) return;
  s.setCommandSearchOpen(false);
  const opener = searchOpener;
  searchOpener = null;
  // With nothing to give focus back to, focus lands by the window's rule
  // (./focusLanding): the main message while typing, unless the command
  // search runs next puts it somewhere itself; else the shown card.
  if (giveFocusBack(opener) || s.view !== "home") return;
  if (typingWhereFocusRested()) s.focusMainMessage({ yields: true });
  else landLostFocus();
}

/** Each shell command, told how it came: a card's button it presses says so. */
const SHELL_COMMANDS: Readonly<Record<ShellCommandId, (via: CommandVia) => void>> = {
  // Its own key closes it again.
  "commands.search": () => {
    if (useShellStore.getState().commandSearchOpen) closeCommandSearch();
    else openCommandSearch();
  },
  "focus.main-message": () => useShellStore.getState().focusMainMessage(),
  // From Settings it goes home first; the words and caret wait in the field.
  "focus.card-reply": () => {
    // A request folded under its browser's page opens beside it, its field with it,
    // and so does the thread of a card whose Chat opens it.
    const id = shownEntry(useShellStore.getState())?.id;
    if (id && replyField(id) === null && (foldedRequest(id) !== null || chatOpens(id) !== null))
      onShownCard((stage) => stage.thread?.());
    toShownPart(replyField, (field) => field.focus());
  },
  "focus.card-body": () => toShownPart(cardBody, enterBody),
  // Focus only: the button is pressed by its own key, through the click's checks.
  "focus.card-actions": () => toShownPart(cardButton, (button) => focusWithRing(button)),
  // The click itself: unanswered questions, pending and disabled stay the button's.
  "cards.choice-1": (via) => pressCardChoice(0, "cards.choice-1", via),
  "cards.choice-2": (via) => pressCardChoice(1, "cards.choice-2", via),
  "cards.choice-3": (via) => pressCardChoice(2, "cards.choice-3", via),
  "cards.choice-4": (via) => pressCardChoice(3, "cards.choice-4", via),
  "regions.next": () => moveToRegion(1),
  "regions.previous": () => moveToRegion(-1),
  "regions.left": () => moveToRegionToward("left"),
  "regions.down": () => moveToRegionToward("down"),
  "regions.up": () => moveToRegionToward("up"),
  "regions.right": () => moveToRegionToward("right"),
  "computers.previous": () => crewOrbit().setPage(crewOrbit().page - 1),
  "computers.next": () => crewOrbit().setPage(crewOrbit().page + 1),
  "project-focus.open": () => projectFocus.askOpen(),
  "project-focus.clear": () => projectFocus.pick(null),
  "cards.previous": () => onShownCard((stage) => stage.page(-1)),
  "cards.next": () => onShownCard((stage) => stage.page(1)),
  "cards.next-new": () => onShownCard((stage) => stage.showNew()),
  "cards.minimize": () => onShownCard((stage) => stage.minimize?.()),
  // INF-4002: every entry aside, or on an empty stage every card put aside back.
  "cards.minimize-all": () => {
    const shell = useShellStore.getState();
    if (shownEntry(shell)) shell.putEveryCardAside();
    else shell.bringBackEveryCard();
  },
  "cards.done": (via) =>
    toShownPart(answerDoneButton, (button) => pressForCommand(button, "cards.done", via)),
  "cards.decline": (via) =>
    toShownPart(declineButton, (button) => pressForCommand(button, "cards.decline", via)),
  "cards.maximize": () => onShownCard((stage) => stage.toggleSize()),
  "cards.find": () => openCardFind(false),
  "cards.find-next": () => stepCardFind(1),
  "cards.find-previous": () => stepCardFind(-1),
  "cards.next-revision": () =>
    toShownPart(cardBody, (body) =>
      body.dispatchEvent(new Event("fm-next-revision", { bubbles: true })),
    ),
  "cards.next-question": () => toShownPart(cardBody, (body) => askQuestionStep(body, 1)),
  "cards.previous-question": () => toShownPart(cardBody, (body) => askQuestionStep(body, -1)),
  "cards.unanswered-question": () =>
    toShownPart(cardBody, (body) => askQuestionStep(body, 1, true)),
  // The picture viewer's own Point at while it is open, a Browser tab's over its page, else the card's.
  "cards.point-at": () => {
    const viewer = viewerPointAt();
    if (viewer) viewer.click();
    else
      toShownPart(
        (id) => browserPointAt(id) ?? shownPart(id, `[data-card-point-at="${CSS.escape(id)}"]`),
        (button) => button.click(),
      );
  },
  "viewer.save-picture": () => {
    document.querySelector("[data-picture-viewer]")?.dispatchEvent(new Event(SAVE_PICTURE_EVENT));
  },
  "cards.thread": () => onShownCard((stage) => stage.thread?.()),
  "cards.thread-new": () => toShownPart(threadJumpButton, (button) => button.click()),
  "cards.sound": () => toShownPart(soundToggle, (button) => button.click()),
  "cards.show-info": () => toTab("cards.show-info"),
  "cards.show-cards": () => toTab("cards.show-cards"),
  "cards.show-activity": () => toTab("cards.show-activity"),
  "cards.show-crewmate": () => toTab("cards.show-crewmate"),
  "browser.control": () => toShownPart(browserControlButton, (button) => button.click()),
  "browser.page": () => toShownPart(browserPage, (page) => focusWithRing(page)),
  "browser.card": () => toShownPart(browserCardBack, (button) => button.click()),
  // The click itself: the picker opens with focus on its first computer.
  "task.move-computer": () => toShownPart(moveComputerButton, (button) => button.click()),
  // The click itself: the one confirm opens with focus on Cancel.
  "task.close-done": () => toShownPart(closeDoneButton, (button) => button.click()),
  // The click itself: the menu opens with focus on its first tag.
  "task.edit-tags": editTags,
  "cards.show-browser": () => toTab("cards.show-browser"),
  "cards.next-tab": () => toTab("cards.next-tab"),
  "cards.previous-tab": () => toTab("cards.previous-tab"),
  "settings.open": () => useShellStore.getState().setView("settings"),
  "settings.keyboard": () =>
    openSettingsAt("keyboard", KEYBOARD_SEARCH, (search) => search.focus({ preventScroll: true })),
  "settings.panels": () => openSettingsAt("panels", PANELS_ROW),
  "updates.show": () => setUpdateNoticeOpen(true),
  "updates.later": () => {
    void updateLater();
  },
  // Settings → General, with focus on Check for updates, which it presses.
  "updates.check": () => {
    openSettingsAt("general", UPDATE_CHECK);
    void checkForUpdates();
  },
  // Settings → General, with focus on the first mate's computer's update row.
  "updates.home": () => openSettingsAt("general", HOME_UPDATE_ROW),
  "whats-new.show": () => showReleaseNote(null),
  // Home, with /feedback started in the message box for the person's words.
  "feedback.start": () => {
    const shell = useShellStore.getState();
    if (mainMessageRefusal(shell) !== null) return;
    shell.focusMainMessage();
    shell.beginDraft(FEEDBACK_DRAFT);
  },
  "firstmate.reply": () => {
    const s = useShellStore.getState();
    if (s.view !== "home") s.setView("home");
    s.openConversation();
  },
  "settings.runbooks": () => openSettingsAt("runbooks", "[data-runbooks] button"),
  "runbooks.open-folder": () =>
    openSettingsAt("runbooks", "[data-runbooks-open-folder]", (button) => button.click()),
  "settings.usage": openUsage,
  "settings.automation": openAutomation,
  "settings.integrations": openIntegrations,
  "settings.secrets": () => openSettingsAt("secrets", "[data-secrets-heading]"),
  "secrets.move": () => {
    startSecretsMove();
  },
  "automation.pause-all": () => {
    openAutomation();
    window.infinitary.automation.pauseAll().catch((error: unknown) => {
      console.warn("[infinitary] Pause all automations did not run:", error);
    });
  },
  // The first mate's recheck: a card paused on a spent allowance says it checks.
  "allowance.recheck": () => {
    void window.infinitary.quota.refresh().catch(() => {});
  },
  // Settings → Devices, where each Mac this Mac stopped trying over its own
  // SSH is tried once more and says how it went.
  "devices.try-again": () => {
    useShellStore.setState({ view: "settings", settingsSection: "devices" });
    void window.infinitary.devices.tryAgain().catch(() => {});
  },
  "ambient.toggle": () => {
    const s = useShellStore.getState();
    s.setAmbientMusic(!s.ambientMusic);
  },
  "ambient.style": () => openStyleList(),
  // The other unit, saved by the core, seen in Usage.
  "usage.unit": () => {
    const s = useShellStore.getState();
    s.setUsageUnit(s.usageUnit === "tokens" ? "usd" : "tokens");
    openUsage();
  },
};

/**
 * Opens Settings at `section`, from anywhere, Settings included, and puts
 * focus on the first `place` there once the section draws it. A window that
 * paints late draws it many frames on, after a person may already have
 * pressed into the section: focus they moved there since stays where they
 * put it (INF-963).
 */
function openSettingsAt(
  section: string,
  place: string,
  enter: (found: HTMLElement) => void = focusWithRing,
): void {
  const from = document.activeElement;
  useShellStore.setState({ view: "settings", settingsSection: section });
  whenReady(
    () => document.querySelector(place) !== null,
    () => {
      const now = document.activeElement;
      if (now !== from && now?.closest(`[data-settings-section="${CSS.escape(section)}"]`)) return;
      const found = document.querySelector<HTMLElement>(place);
      if (found) enter(found);
    },
  );
}

/**
 * A task browser's Manage: Website sign-ins in view, in Secrets where this
 * window offers that tab and in General otherwise (`signInsInSecrets`).
 * Focus rests on the section itself, so Tab goes on to its first row.
 */
export function openSavedSignIns(): void {
  const { secretsShown, thisMac } = useShellStore.getState();
  openSettingsAt(
    signInsInSecrets(secretsShown, thisMac) ? "secrets" : "general",
    "[data-website-sign-ins]",
    (found) => {
      found.scrollIntoView({ block: "start" });
      found.focus({ preventScroll: true });
    },
  );
}

/** The Version row's Check for updates (UpdateCheck.tsx). */
const UPDATE_CHECK = "[data-update-check]";

function openAutomation(): void {
  openSettingsAt("automation", "[data-automation-new]");
}

/** Settings → Integrations, with focus on its first row or add chip; Secrets' app sign-in rows open it too. */
export function openIntegrations(): void {
  openSettingsAt("integrations", INTEGRATIONS_FIRST);
}

/** Settings → Intelligence at the reporting connection's row; Secrets' rows for its headers open it. */
export function openUsageConnection(): void {
  openSettingsAt("subscriptions", "[data-usage-connection-edit], [data-usage-connection-add]");
}

/** The tab's first control: a row's disclosure, or an add chip with nothing connected. */
const INTEGRATIONS_FIRST = "[data-integration-toggle], [data-integration-add]";

function openUsage(): void {
  openSettingsAt("usage", USAGE_UNIT);
}

function windowFacts(): WindowFacts {
  return {
    dialogOpen: modalOpen(),
    viewerPointAt: viewerPointAt() !== null,
    viewerOpen: document.querySelector("[data-picture-viewer]") !== null,
    browserPointAt: (() => {
      const id = shownEntry(useShellStore.getState())?.id;
      return !!id && browserPointAt(id) !== null;
    })(),
    cardFinding: useCardFind.getState().open,
    answerDoneReady: (() => {
      const id = shownEntry(useShellStore.getState())?.id;
      return !!id && answerDoneButton(id) !== null;
    })(),
    declineReady: (() => {
      const id = shownEntry(useShellStore.getState())?.id;
      return !!id && declineButton(id) !== null;
    })(),
    browserControl: (() => {
      const id = shownEntry(useShellStore.getState())?.id;
      return !!id && browserControlButton(id) !== null;
    })(),
    browserReply: (() => {
      const id = shownEntry(useShellStore.getState())?.id;
      return !!id && (replyField(id) !== null || foldedRequest(id) !== null);
    })(),
    browserPage: (() => {
      const id = shownEntry(useShellStore.getState())?.id;
      return !!id && browserPage(id) !== null;
    })(),
    browserCard: (() => {
      const id = shownEntry(useShellStore.getState())?.id;
      return !!id && browserCardBack(id) !== null;
    })(),
    threadJump: (() => {
      const id = shownEntry(useShellStore.getState())?.id;
      return !!id && threadJumpButton(id) !== null;
    })(),
    soundStrip: (() => {
      const id = shownEntry(useShellStore.getState())?.id;
      return !!id && soundToggle(id) !== null;
    })(),
    taskMove: (() => {
      const id = shownEntry(useShellStore.getState())?.id;
      return !!id && moveComputerButton(id) !== null;
    })(),
    taskCloseDone: (() => {
      const id = shownEntry(useShellStore.getState())?.id;
      return !!id && closeDoneButton(id) !== null;
    })(),
    taskEditTags: (() => {
      const id = shownEntry(useShellStore.getState())?.id;
      return !!id && (editTagsButton(id) !== null || shownTaskTaggable());
    })(),
    updateAvailable: useUpdateState.getState().status?.updateAvailable ?? false,
    checksUpdates: checksUpdates(useUpdateState.getState().status),
    savingForUpdate: savingForUpdate(useUpdateState.getState().status),
    computers: { page: crewOrbit().page, pages: crewOrbit().pages },
    projectFocus: { shown: projectFocus.state().shown, focus: projectFocus.state().focus },
    panelCommand: (id, recording) => panelCommandRefusal(pluginHost, id, recording),
  };
}

/**
 * Why a window command cannot run now, in the words a person reads, or null
 * (./commandRefusals). Command search reads its rows as the window would
 * stand once it closes.
 */
export function windowCommandRefusal(
  id: WindowCommandId | PanelCommandId,
  s: ShellState = useShellStore.getState(),
): string | null {
  return commandRefusal(id, s, windowFacts());
}

/**
 * How long a panel's card a command put up may take to draw before it is
 * given focus, in frames (about two seconds): a card born with the command
 * starts a page of its own, which reads and draws before the stage shows it.
 */
const PANEL_CARD_DRAW_FRAMES = 120;

/**
 * A panel's card a command put up takes the keyboard's focus once the stage
 * shows it drawn, as F6 enters a card: its page, when it has one. Once the
 * captain pages away or opens command search, the pending move is forgotten,
 * even if that card comes to the front again before it draws.
 */
export function focusPanelCard(entryId: string): void {
  const root = () =>
    document.querySelector<HTMLElement>(
      `[data-card-layer] [data-stage-entry="shown"][data-stage-entry-id="${CSS.escape(entryId)}"]`,
    );
  let shown = shownEntry(useShellStore.getState())?.id === entryId;
  let forgotten = false;
  const ready = () => {
    const s = useShellStore.getState();
    const front = shownEntry(s)?.id === entryId;
    shown ||= front;
    forgotten ||= s.commandSearchOpen || (shown && !front);
    // Finish the wait without entering a card the captain moved on from.
    if (forgotten) return true;
    const entry = root();
    if (entry === null || !available(entry) || entry.style.opacity === "0") return false;
    // A card in a page of its own takes focus once that page's frame is there.
    const page = entry.querySelector("[data-panel-card-page]");
    return page === null || page.querySelector("iframe") !== null;
  };
  whenReady(
    ready,
    () => {
      const entry = root();
      if (!forgotten && entry && shownEntry(useShellStore.getState())?.id === entryId)
        enterCard(entry);
    },
    PANEL_CARD_DRAW_FRAMES,
  );
}

/**
 * Runs a window command if it may run now: the shell's here, the main
 * process's by asking it, a panel's through its panel. Returns whether it
 * ran. Command search closes itself before it runs what was chosen in it.
 */
export function runWindowCommand(id: WindowCommandId | PanelCommandId, via: CommandVia): boolean {
  if (windowCommandRefusal(id) !== null) return false;
  if (isPanelCommandId(id)) runPanelCommand(pluginHost, id, focusPanelCard);
  else if (isShellCommand(id)) SHELL_COMMANDS[id](via);
  else void window.infinitary.keyboard.run(id).catch(() => {});
  return true;
}

/**
 * Runs each window command the main process names, for as long as the shell
 * lives. The window's keys are marked as reaching the shell (`markWindowKeys`)
 * after one round trip to the main process, which handles this page's
 * messages in order: by then it holds every panel's keys the page told it
 * before it drew.
 */
export function followShellCommands(): () => void {
  let following = true;
  // The main process names a command for its key, or for an app menu item;
  // no menu item presses a card's button (src/main/appMenu.ts), so a card's
  // press it names came from its key.
  const stopCommands = window.infinitary.keyboard.onCommand(({ command }) =>
    runWindowCommand(command, "key"),
  );
  // A movement command's key for a frame (docs/keyboard.md, "Moving by a key of your own").
  const stopMoves = window.infinitary.keyboard.onMove(({ key, frame }) => moveInFrame(key, frame));
  const stop = () => {
    stopCommands();
    stopMoves();
  };
  void window.infinitary.keyboard
    .keymap()
    .then(() => {
      if (following) markWindowKeys("commands");
    })
    .catch(() => {});
  return () => {
    following = false;
    stop();
    markWindowKeys(null);
  };
}
