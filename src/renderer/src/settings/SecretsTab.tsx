import { formatDate, formatDateTime, formatTime } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
import { needsReference, secretName } from "@shared/secretNames";
import {
  decisionWords,
  SECRET_APPROVAL_WORDS,
  SECRET_COPY_WORDS,
  SECRET_ROW_ITEM,
  SECRET_STATE_WORDS,
  SECRETS_AREAS,
  SECRETS_RECOVERY_WORDS,
  SECRETS_WORDS,
  type SecretAction,
  type SecretEntryInput,
  type SecretsView,
  secretEntryInputSchema,
} from "@shared/secrets";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { openIntegrations, openUsageConnection } from "../app/shellCommands";
import { useShellStore } from "../app/store";
import { Badge, Button, Input, SecretField } from "../design";
import { thisDesktop } from "../design/core/desktop";
import { SecretQuestion } from "./SecretQuestion";
import { startSecretsMove } from "./secretsMove";
import { LABEL_GAP, ROW_GAP, SECTION_GAP, SectionLabel, SettingError } from "./settingRows";
import { WebsiteSignInsSection } from "./WebsiteSignInsSection";
import "./secrets.css";

type Entry = SecretsView["entries"][number];
type Rule = SecretsView["rules"][number];
type Area = (typeof SECRETS_AREAS)[number]["value"];
type Act = (action: SecretAction) => Promise<void>;
/** Where a question was asked from, so it opens beside the button clicked: a secret's row, or the area under the list. */
type Asked = { at: string };
/**
 * Asks the host a question for this row: `asks` names the button that asked
 * (its `data-secret-asks`), so Keep returns focus to it once it is drawn
 * again, and `at` the place it sits.
 */
type Ask = (action: SecretAction, asks: string, at: string) => void;
/** Sends one answer's pass; the page never decides by itself. */
type Answer = (pass: string, confirmed: boolean) => void;
type Asking = { view: SecretsView; asked: Asked | null; ask: Ask; answer: Answer; busy: boolean };
/** A badge only when something is wrong; a working store says nothing about itself. */
const PROBLEM: Partial<Record<SecretsView["availability"], string>> = {
  get locked() {
    return m.settingsSecretsStorageLocked();
  },
  get unavailable() {
    return m.settingsSecretsStorageUnavailable();
  },
  get lost() {
    return m.settingsSecretsRecoveryNeeded();
  },
  get tampered() {
    return m.settingsSecretsPermissionsRecovery();
  },
};

/**
 * Trusted application chrome only. No value is rendered back or passed to an
 * agent frame; Copy value asks the host to copy one, and the value never
 * reaches this page (docs/secrets.md, "Copying a value").
 */
export function SecretsTab() {
  const [view, setView] = useState<SecretsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [managing, setManaging] = useState(false);
  const managementBack = useRef<HTMLButtonElement>(null);
  const managementTrigger = useRef<HTMLButtonElement | null>(null);
  const [opened, setOpened] = useState<ReadonlySet<Area>>(new Set());
  const [editing, setEditing] = useState<Entry | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const searchId = useId();
  const entryTrigger = useRef<HTMLButtonElement | null>(null);
  const returnEntryFocus = useRef(false);
  const root = useRef<HTMLElement>(null);
  const [asked, setAsked] = useState<Asked | null>(null);
  const questionTrigger = useRef<string | null>(null);
  const focusAfter = useRef<(() => HTMLElement | null | undefined) | null>(null);
  const question = view?.question ?? null;
  const openQuestion = useRef(question);
  openQuestion.current = question;
  // Leaving Settings drops an open question: its Keep pass changes nothing.
  useEffect(
    () => () => {
      const open = openQuestion.current;
      if (open)
        void window.infinitary.secrets
          .action({ kind: "answer", pass: open.keep.pass })
          .catch(() => undefined);
    },
    [],
  );
  useLayoutEffect(() => {
    const pick = focusAfter.current;
    if (!pick || question) return;
    focusAfter.current = null;
    // Only focus the question took with it: a person who moved on keeps where they are.
    const active = root.current?.ownerDocument.activeElement;
    if (active && active !== active.ownerDocument.body && active.isConnected) return;
    pick()?.focus();
  }, [question]);
  useLayoutEffect(() => {
    if (editing !== null || !returnEntryFocus.current) return;
    returnEntryFocus.current = false;
    // The replacement may no longer match the search. Choose after React's
    // commit, never in a frame that can still contain the about-to-be-removed row.
    if (entryTrigger.current?.isConnected) entryTrigger.current.focus();
    else root.current?.querySelector<HTMLButtonElement>("[data-secret-add]")?.focus();
  }, [editing]);
  useLayoutEffect(() => {
    if (managing) managementBack.current?.focus();
    else if (managementTrigger.current) {
      const trigger = managementTrigger.current;
      managementTrigger.current = null;
      (trigger.isConnected
        ? trigger
        : root.current?.querySelector<HTMLElement>("[data-secrets-heading]")
      )?.focus();
    }
  }, [managing]);
  const refresh = useCallback(() => window.infinitary.secrets.view().then(setView), []);
  useEffect(() => {
    let live = true;
    const reload = () => {
      void window.infinitary.secrets
        .view()
        .then((next) => {
          if (live) setView(next);
        })
        .catch(() => {
          if (live) setError(SECRETS_WORDS.unavailable);
        });
    };
    reload();
    const off = window.infinitary.secrets.onChange(reload);
    return () => {
      live = false;
      off();
    };
  }, []);
  const act: Act = async (input) => {
    setError(null);
    setBusy(true);
    try {
      const next = await window.infinitary.secrets.action(input);
      setView(next);
      if (next.offeredCard) {
        const shell = useShellStore.getState();
        shell.setView("home");
        shell.focusCard(next.offeredCard);
      }
    } catch {
      setError(SECRETS_WORDS.unavailable);
    } finally {
      setBusy(false);
    }
  };
  const ask: Ask = (action, asks, at) => {
    questionTrigger.current = asks;
    setAsked({ at });
    void act(action);
  };
  const answer: Answer = (pass, confirmed) => {
    const asks = questionTrigger.current;
    const forgetting = confirmed && question?.about.kind === "forget";
    // After Forget the row is gone: focus the next secret, or Add secret when none is left.
    const row = forgetting
      ? root.current?.querySelector("[data-secret-question]")?.closest("li")
      : null;
    const next = row?.nextElementSibling ?? row?.previousElementSibling ?? null;
    focusAfter.current = forgetting
      ? () =>
          (next?.isConnected ? next.querySelector<HTMLElement>("summary") : null) ??
          root.current?.querySelector<HTMLElement>("[data-secret-add]")
      : () =>
          (asks
            ? root.current?.querySelector<HTMLElement>(
                `[data-secret-asks="${CSS.escape(asks)}"] button`,
              )
            : null) ?? root.current?.querySelector<HTMLElement>("[data-secrets-heading]");
    void act({ kind: "answer", pass });
  };
  /** Closing the row or area a question sits in drops it, and changes nothing. */
  const drop = (at: string) => {
    if (question && asked?.at === at) {
      focusAfter.current = null;
      void act({ kind: "answer", pass: question.keep.pass });
    }
  };
  const beginEntry = (entry: Entry | "new", trigger: HTMLButtonElement) => {
    entryTrigger.current = trigger;
    setEditing(entry);
  };
  const finishEntry = () => {
    returnEntryFocus.current = true;
    setEditing(null);
  };
  const toggleArea = (area: Area, open: boolean) => {
    if (!open) drop(area);
    setOpened((current) => {
      if (current.has(area) === open) return current;
      const next = new Set(current);
      if (open) next.add(area);
      else next.delete(area);
      return next;
    });
  };
  const openManagement = (trigger: HTMLButtonElement, recovery = false) => {
    if (asked) drop(asked.at);
    managementTrigger.current = trigger;
    setOpened(new Set(recovery ? ["copy"] : []));
    setManaging(true);
  };
  // A page a card or a panel named (`settingsItem`): Manage opens on that
  // page, as its own row's click opens it.
  const arrival = useShellStore((s) =>
    s.settingsItem?.section === "secrets" ? s.settingsItem.item : null,
  );
  // A secret's row the first mate's offer named (`secret:` and its name or
  // reference) opens once the list is read; a name that matches nothing
  // leaves Secrets as it is.
  const [rowArrival, setRowArrival] = useState<string | null>(null);
  useEffect(() => {
    if (arrival === null) return;
    useShellStore.getState().clearSettingsItem();
    if (arrival.startsWith(SECRET_ROW_ITEM)) {
      setRowArrival(arrival.slice(SECRET_ROW_ITEM.length).trim());
      return;
    }
    const area = SECRETS_AREAS.find((option) => option.value === arrival)?.value;
    if (!area) return;
    setOpened(new Set([area]));
    setManaging(true);
  }, [arrival]);
  useEffect(() => {
    if (rowArrival === null || !view) return;
    setRowArrival(null);
    const named = rowArrival.toLocaleLowerCase();
    const entry =
      view.entries.find((candidate) => candidate.ref === rowArrival) ??
      view.entries.find((candidate) => candidate.label.toLocaleLowerCase() === named);
    if (!entry) return;
    setSearch("");
    setManaging(false);
    // The row exists once Manage has closed and the search no longer hides it.
    requestAnimationFrame(() => {
      const row = root.current?.querySelector<HTMLDetailsElement>(
        `[data-secret-row="${CSS.escape(entry.ref)}"] > details`,
      );
      if (!row) return;
      row.open = true;
      row.querySelector<HTMLElement>("summary")?.focus();
    });
  }, [rowArrival, view]);
  const leaveManagement = () => {
    if (asked) drop(asked.at);
    setManaging(false);
  };
  const all = view?.entries ?? [];
  const query = search.trim().toLocaleLowerCase();
  const entries = all
    .filter((entry) =>
      [entry.label, entry.environment, entry.lastTask ?? ""]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query),
    )
    .sort((a, b) => a.label.localeCompare(b.label) || a.ref.localeCompare(b.ref));
  const canWrite = view?.availability === "available" || view?.availability === "uninitialized";
  const notEnabled = view?.availability === "not-enabled";
  const recoveryNeeded = view?.availability === "lost" || view?.availability === "tampered";
  const problem = view ? PROBLEM[view.availability] : undefined;
  const entryNote = !canWrite
    ? SECRETS_WORDS.unavailable
    : editing
      ? m.settingsSecretsFinishForm()
      : undefined;
  const waiting = (view?.uses ?? []).filter((use) => use.state === "waiting");
  return (
    <section
      ref={root}
      className="fm-secrets"
      aria-label={SECRETS_WORDS.title}
      style={
        {
          "--secret-row-gap": ROW_GAP,
          "--secret-section-gap": SECTION_GAP,
          "--secret-label-gap": LABEL_GAP,
        } as React.CSSProperties
      }
    >
      <header className="fm-secrets-heading">
        <h2 data-secrets-heading="" tabIndex={-1}>
          {SECRETS_WORDS.title}
        </h2>
        {problem && <Badge tone="warn">{problem}</Badge>}
      </header>
      {notEnabled ? (
        <div className="fm-secrets-empty">
          <p role="status">{SECRETS_WORDS.disabled}</p>
        </div>
      ) : !view ? (
        <p role="status">{m.settingsSecretsReading()}</p>
      ) : (
        <>
          {view.message && <p role="status">{view.message}</p>}
          {recoveryNeeded ? (
            <div className="fm-secrets-notice">
              <p>{SECRETS_RECOVERY_WORDS.needed}</p>
              <div className="fm-secrets-actions">
                <Button
                  variant="secondary"
                  onClick={(event) =>
                    managing ? toggleArea("copy", true) : openManagement(event.currentTarget, true)
                  }
                >
                  {SECRETS_RECOVERY_WORDS.options}
                </Button>
                <Button
                  variant="secondary"
                  pending={busy}
                  aria-description={SECRETS_RECOVERY_WORDS.startOverNote}
                  onClick={() => void act({ kind: "start-over" })}
                >
                  {SECRETS_RECOVERY_WORDS.startOverButton}
                </Button>
              </div>
              <p className="fm-secrets-muted fm-secrets-consequence">
                {SECRETS_RECOVERY_WORDS.startOverNote}
              </p>
            </div>
          ) : (
            !canWrite && (
              <div className="fm-secrets-notice">
                <p>{m.settingsSecretsUnlockToUse()}</p>
                <Button
                  variant="secondary"
                  onClick={() => void act({ kind: "unlock" })}
                  pending={busy}
                >
                  {m.settingsSecretsUnlockAgain()}
                </Button>
              </div>
            )
          )}
          {waiting.map((use) => (
            <div key={use.request} className="fm-secrets-notice" data-secret-waiting="">
              <p>
                {SECRETS_WORDS.waitingFor(
                  use.secrets.length
                    ? use.secrets.map((secret) => secretName(all, secret.ref)).join(", ")
                    : use.recipient || SECRETS_WORDS.title,
                )}
              </p>
              <Button
                variant="secondary"
                pending={busy}
                onClick={() => void act({ kind: "review-use", request: use.request })}
              >
                {SECRETS_WORDS.waiting}
              </Button>
            </div>
          ))}
          <div hidden={managing} className="fm-secrets-collection">
            <SectionLabel>
              {SECRETS_WORDS.protected}
              {!problem && <> · {all.length}</>}
            </SectionLabel>
            {!problem && (
              <p className="fm-secrets-muted">{SECRETS_WORDS.custody(thisDesktop().mac)}</p>
            )}
            <div className="fm-secrets-toolbar">
              {all.length > 0 && (
                <label htmlFor={searchId} className="fm-secrets-grow">
                  <span className="fm-secrets-visually-hidden">{SECRETS_WORDS.search}</span>
                  <Input
                    id={searchId}
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={SECRETS_WORDS.search}
                  />
                </label>
              )}
              <Button
                data-secret-add=""
                variant={editing ? "secondary" : "primary"}
                off={!canWrite || editing !== null}
                note={entryNote}
                onClick={(event) => beginEntry("new", event.currentTarget)}
              >
                {SECRETS_WORDS.add}
              </Button>
              <Button
                variant="secondary"
                data-secrets-move=""
                off={!canWrite}
                note={canWrite ? undefined : SECRETS_WORDS.unavailable}
                onClick={() => startSecretsMove()}
              >
                {m.settingsSecretsMove()}
              </Button>
            </div>
            {editing && (
              <SecureEntry
                key={editing === "new" ? "new" : editing.ref}
                entry={editing === "new" ? undefined : editing}
                onCancel={finishEntry}
                onSaved={(next) => {
                  setView(next);
                  finishEntry();
                }}
              />
            )}
            <div className="fm-settings-list">
              {entries.length === 0 ? (
                <div className="fm-secrets-empty">
                  <p>
                    {all.length
                      ? SECRETS_WORDS.noMatch
                      : canWrite
                        ? SECRETS_WORDS.noneYet
                        : SECRETS_WORDS.waitingStorage}
                  </p>
                </div>
              ) : (
                <ul className="fm-secrets-entries">
                  {entries.map((entry) => (
                    <SecretRow
                      key={entry.ref}
                      entry={entry}
                      asking={{ view, asked, ask, answer, busy }}
                      onClose={() => drop(`row:${entry.ref}`)}
                      act={act}
                      canWrite={canWrite}
                      entryNote={entryNote}
                      onReplace={(trigger) => beginEntry(entry, trigger)}
                    />
                  ))}
                </ul>
              )}
              <button
                type="button"
                className="fm-settings-list-line"
                data-secrets-management=""
                disabled={busy || editing !== null}
                onClick={(event) => openManagement(event.currentTarget)}
              >
                <span>{SECRETS_WORDS.management}</span>
              </button>
            </div>
          </div>
          {managing && (
            <div className="fm-secrets-collection">
              <Button
                ref={managementBack}
                variant="ghost"
                size="sm"
                data-secrets-management-back=""
                onClick={leaveManagement}
              >
                <span aria-hidden="true">‹</span> {SECRETS_WORDS.title}
              </Button>
              <h3>{SECRETS_WORDS.management}</h3>
              <div className="fm-secrets-group">
                <SectionLabel>{SECRETS_WORDS.access}</SectionLabel>
                <div className="fm-settings-list">
                  <QuietRow
                    area="decisions"
                    summary={view.rules.length ? String(view.rules.length) : ""}
                    open={opened.has("decisions")}
                    onToggle={toggleArea}
                  >
                    <section className="fm-secrets-area" aria-label={SECRETS_WORDS.decisionsRegion}>
                      <Decisions
                        rules={view.rules}
                        at="decisions"
                        asking={{ view, asked, ask, answer, busy }}
                      />
                    </section>
                  </QuietRow>
                  <QuietRow
                    area="phone"
                    summary={
                      view.devices.length
                        ? view.devices.map((device) => device.label).join(", ")
                        : SECRETS_WORDS.noPhone
                    }
                    open={opened.has("phone")}
                    onToggle={toggleArea}
                  >
                    <ApprovalDevices asking={{ view, asked, ask, answer, busy }} />
                  </QuietRow>
                </div>
              </div>
              <div className="fm-secrets-group">
                <SectionLabel>{SECRETS_WORDS.historyAndRecovery}</SectionLabel>
                <div className="fm-settings-list">
                  <QuietRow
                    area="history"
                    summary={historySummary(view.history)}
                    open={opened.has("history")}
                    onToggle={toggleArea}
                  >
                    <History asking={{ view, asked, ask, answer, busy }} refresh={refresh} />
                  </QuietRow>
                  <QuietRow area="copy" summary="" open={opened.has("copy")} onToggle={toggleArea}>
                    <Recovery view={view} act={act} busy={busy || editing !== null} />
                  </QuietRow>
                </div>
              </div>
            </div>
          )}
        </>
      )}
      <SettingError error={error} surface="secrets" />
      {/* Last, in every storage state: the sign-ins keep their own storage
          (docs/task-browser.md, "Signed-in sites"). */}
      <div hidden={managing && !notEnabled}>
        <WebsiteSignInsSection inSecrets />
      </div>
    </section>
  );
}

function SecretRow({
  entry,
  asking,
  onClose,
  act,
  canWrite,
  entryNote,
  onReplace,
}: {
  entry: Entry;
  asking: Asking;
  onClose: () => void;
  act: Act;
  canWrite: boolean;
  entryNote: string | undefined;
  onReplace: (trigger: HTMLButtonElement) => void;
}) {
  const { view } = asking;
  const uses = view.uses.filter((use) => use.secrets.some((secret) => secret.ref === entry.ref));
  const reads = view.reads.filter((read) => read.secrets.includes(entry.ref));
  const rules = view.rules.filter((rule) => rule.secret === entry.ref);
  const status = uses.some((use) => use.state === "executing")
    ? SECRETS_WORDS.inUse
    : uses.some((use) => use.state === "waiting")
      ? SECRETS_WORDS.waitingRow
      : entry.lastRequest === null
        ? SECRETS_WORDS.notUsed
        : entry.lastCopied
          ? SECRET_COPY_WORDS.copiedOn(
              formatDate(entry.lastRequest, { month: "short", day: "numeric" }),
            )
          : SECRETS_WORDS.used(dayOf(entry.lastRequest), entry.lastTask);
  return (
    <li className="fm-secrets-key" data-secret-row={entry.ref}>
      <details
        className="fm-secrets-entry"
        onToggle={(event) => {
          if (!event.currentTarget.open) onClose();
        }}
      >
        <summary className="fm-settings-list-line">
          <span className="fm-secrets-key-name">
            <strong>{entry.label}</strong>
            {entry.environment && (
              <span className="fm-secrets-entry-environment">{entry.environment}</span>
            )}
            {needsReference(view.entries, entry) && (
              <span className="fm-secrets-entry-reference fm-secrets-mono">{entry.ref}</span>
            )}
          </span>
          <span className="fm-secrets-key-status">{status}</span>
        </summary>
        <div className="fm-secrets-key-body">
          {entry.kept && entry.unnamed ? (
            <LeftOver entry={entry} asking={asking} canWrite={canWrite} />
          ) : entry.kept && entry.consumer ? (
            <KeptForConnection />
          ) : entry.kept ? (
            <Kept
              forProgram={entry.forProgram === true}
              copy={
                entry.forProgram ? (
                  <CopyValue entry={entry} view={view} act={act} busy={asking.busy} />
                ) : null
              }
            />
          ) : (
            <OwnSecret
              entry={entry}
              asking={asking}
              canWrite={canWrite}
              entryNote={entryNote}
              onReplace={onReplace}
              rules={rules}
              copy={<CopyValue entry={entry} view={view} act={act} busy={asking.busy} />}
            />
          )}
          <CopiedLine entry={entry} view={view} act={act} busy={asking.busy} />
        </div>
      </details>
      {reads.map((read) => (
        <div key={read.id} className="fm-secrets-key-read">
          <span>{SECRETS_WORDS.readingUntil(timeOf(read.expires))}</span>
          <Button variant="secondary" onClick={() => void act({ kind: "end-read", id: read.id })}>
            {SECRETS_WORDS.end}
          </Button>
        </div>
      ))}
    </li>
  );
}

/** The captain's own secret: Replace, Forget and its saved decisions; Forget asks on this row. */
function OwnSecret({
  entry,
  asking,
  canWrite,
  entryNote,
  onReplace,
  rules,
  copy,
}: {
  entry: Entry;
  asking: Asking;
  canWrite: boolean;
  entryNote: string | undefined;
  onReplace: (trigger: HTMLButtonElement) => void;
  rules: SecretsView["rules"];
  copy: React.ReactNode;
}) {
  const { view, busy } = asking;
  const at = `row:${entry.ref}`;
  const question =
    view.question?.about.kind === "forget" && view.question.about.ref === entry.ref
      ? view.question
      : null;
  return (
    <>
      {question ? (
        <SecretQuestion question={question} answering={busy} onAnswer={asking.answer} />
      ) : (
        <div className="fm-secrets-actions">
          {copy}
          <Button
            variant="secondary"
            off={!canWrite || entryNote !== undefined}
            note={entryNote}
            onClick={(event) => onReplace(event.currentTarget)}
          >
            {SECRETS_WORDS.replace}
          </Button>
          <span data-secret-asks={`forget:${entry.ref}`}>
            <Button
              variant="ghost"
              off={busy || !canWrite}
              note={
                !canWrite
                  ? SECRETS_WORDS.unavailable
                  : busy
                    ? m.settingsSecretsWaitForChange()
                    : undefined
              }
              onClick={() =>
                asking.ask({ kind: "forget", ref: entry.ref }, `forget:${entry.ref}`, at)
              }
            >
              {SECRETS_WORDS.forget}
            </Button>
          </span>
        </div>
      )}
      {rules.length > 0 && <Decisions rules={rules} at={at} asking={asking} />}
    </>
  );
}

/**
 * A key the app keeps for one of its own services, changed where it was made
 * (docs/secrets.md, "App sign-ins", "Programs that keep running"): a sign-in
 * made in Integrations, or a key given with a server added there. Signing in
 * or giving the key was the consent, so it has no Replace, Forget or
 * decisions here.
 */
function Kept({ forProgram, copy }: { forProgram: boolean; copy: React.ReactNode }) {
  return (
    <div className="fm-secrets-kept" data-secrets-kept>
      <p className="fm-secrets-kept-note">
        {forProgram ? m.settingsSecretsKeptForProgram() : m.settingsSecretsKeptSignIn()}
      </p>
      <div className="fm-secrets-actions">
        {copy}
        <Button variant="secondary" onClick={openIntegrations}>
          {m.settingsSecretsManageInIntegrations()}
        </Button>
      </div>
    </div>
  );
}

/**
 * A reporting connection's header (docs/secrets.md, "App sign-ins"): saving
 * the connection in Settings → Intelligence was the consent, and it is
 * changed or removed there.
 */
function KeptForConnection() {
  return (
    <div className="fm-secrets-kept" data-secrets-kept="usage-report">
      <p className="fm-secrets-kept-note">{m.settingsSecretsKeptUsageReport()}</p>
      <div className="fm-secrets-actions">
        <Button variant="secondary" onClick={openUsageConnection}>
          {m.settingsSecretsManageInIntelligence()}
        </Button>
      </div>
    </div>
  );
}

/**
 * A service's hidden entry its saved settings no longer name, left by a
 * crash or a forget refused while Secrets was closed: nothing uses it, so
 * Forget asks on this row as for the person's own secret.
 */
function LeftOver({
  entry,
  asking,
  canWrite,
}: {
  entry: Entry;
  asking: Asking;
  canWrite: boolean;
}) {
  const { view, busy } = asking;
  const question =
    view.question?.about.kind === "forget" && view.question.about.ref === entry.ref
      ? view.question
      : null;
  return (
    <div className="fm-secrets-kept" data-secrets-kept="left-over">
      <p className="fm-secrets-kept-note">{m.settingsSecretsKeptLeftOver()}</p>
      {question ? (
        <SecretQuestion question={question} answering={busy} onAnswer={asking.answer} />
      ) : (
        <div className="fm-secrets-actions">
          <span data-secret-asks={`forget:${entry.ref}`}>
            <Button
              variant="ghost"
              off={busy || !canWrite}
              note={!canWrite ? SECRETS_WORDS.unavailable : undefined}
              onClick={() =>
                asking.ask(
                  { kind: "forget", ref: entry.ref },
                  `forget:${entry.ref}`,
                  `row:${entry.ref}`,
                )
              }
            >
              {SECRETS_WORDS.forget}
            </Button>
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Copy value (docs/secrets.md, "Copying a value"): the host asks the system to
 * confirm the person, then copies the value itself. Absent where this
 * computer has no private clipboard writer.
 */
function CopyValue({
  entry,
  view,
  act,
  busy,
}: {
  entry: Entry;
  view: SecretsView;
  act: Act;
  busy: boolean;
}) {
  if (!view.copy) return null;
  const cannot = view.copy === "no-confirmation";
  return (
    <span data-secret-copy="">
      <Button
        variant="secondary"
        off={cannot || busy}
        note={
          cannot
            ? SECRET_COPY_WORDS.cannotConfirm
            : busy
              ? m.settingsSecretsWaitForChange()
              : undefined
        }
        onClick={() =>
          void act({
            kind: "copy",
            ref: entry.ref,
            version: entry.version,
            revision: entry.revision,
          })
        }
      >
        {SECRET_COPY_WORDS.copy}
      </Button>
    </span>
  );
}

/** While a copied value is on the clipboard: when it leaves, and Clear now. */
function CopiedLine({
  entry,
  view,
  act,
  busy,
}: {
  entry: Entry;
  view: SecretsView;
  act: Act;
  busy: boolean;
}) {
  const copied = view.copied?.ref === entry.ref ? view.copied : undefined;
  if (!copied) return null;
  return (
    <div className="fm-secrets-key-read" data-secret-copied="">
      <span aria-live="polite">
        {SECRET_COPY_WORDS.copiedUntil(
          formatTime(copied.clears, { hour: "numeric", minute: "2-digit", second: "2-digit" }),
          copied.concealed,
        )}
      </span>
      <Button
        variant="secondary"
        off={busy}
        onClick={(event) => {
          // Clear now leaves with the line it sits in: focus goes back to the row's Copy value.
          const row = event.currentTarget.closest("li");
          void act({ kind: "clear-copy" }).then(() =>
            row?.querySelector<HTMLElement>("[data-secret-copy] button")?.focus(),
          );
        }}
      >
        {SECRET_COPY_WORDS.clearNow}
      </Button>
    </div>
  );
}

/** A rare thing, kept under the list: one quiet row that opens in place. */
function QuietRow({
  area,
  summary,
  open,
  onToggle,
  children,
}: {
  area: Area;
  summary: string;
  open: boolean;
  onToggle: (area: Area, open: boolean) => void;
  children: React.ReactNode;
}) {
  const label = SECRETS_AREAS.find((option) => option.value === area)?.label;
  return (
    <details
      className="fm-secrets-quiet"
      data-secrets-area={area}
      open={open}
      onToggle={(event) => onToggle(area, event.currentTarget.open)}
    >
      <summary className="fm-settings-list-line">
        <span>{label}</span>
        {summary && <span className="fm-secrets-quiet-summary">{summary}</span>}
      </summary>
      <div className="fm-secrets-quiet-body">{children}</div>
    </details>
  );
}

/** Saved decisions in plain sentences. Removing one asks on its own row; nothing here edits a decision. */
function Decisions({ rules, at, asking }: { rules: readonly Rule[]; at: string; asking: Asking }) {
  const { view, busy } = asking;
  if (rules.length === 0) return <p className="fm-secrets-muted">{SECRETS_WORDS.noDecisions}</p>;
  const writable = view.availability === "available";
  return (
    <ul className="fm-secrets-decisions">
      {rules.map((rule) => (
        <li key={rule.id} className="fm-secrets-row">
          {view.question?.about.kind === "rule" &&
          view.question.about.rule === rule.id &&
          asking.asked?.at === at ? (
            // The question names the decision in its first line, so the row's sentence steps aside.
            <SecretQuestion
              question={view.question}
              answering={busy}
              onAnswer={asking.answer}
              first
            />
          ) : (
            <>
              <span>{decisionWords(rule, secretName(view.entries, rule.secret))}</span>
              <span data-secret-asks={`rule:${at}:${rule.id}`}>
                <Button
                  variant="ghost"
                  pending={busy}
                  off={!writable}
                  note={writable ? undefined : SECRETS_WORDS.unavailable}
                  onClick={() =>
                    asking.ask(
                      {
                        kind: "save-rules",
                        rules: view.rules.filter((saved) => saved.id !== rule.id),
                      },
                      `rule:${at}:${rule.id}`,
                      at,
                    )
                  }
                >
                  {SECRETS_WORDS.remove}
                </Button>
              </span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

function SecureEntry({
  entry,
  onCancel,
  onSaved,
}: {
  entry?: Entry;
  onCancel: () => void;
  onSaved: (view: SecretsView) => void;
}) {
  const prefix = useId();
  const [label, setLabel] = useState(entry?.label ?? "");
  const [value, setValue] = useState("");
  const [environment, setEnvironment] = useState(entry?.environment ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    form.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, []);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    // A new secret names no reference: the controller makes a stable one from its name.
    const input: SecretEntryInput = {
      ...(entry ? { ref: entry.ref } : {}),
      label,
      value,
      environment,
      expectedVersion: entry?.version ?? 0,
      expectedRevision: entry?.revision ?? null,
    };
    const parsed = secretEntryInputSchema.safeParse(input);
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      setError(field === "label" ? SECRETS_WORDS.nameRequired : SECRETS_WORDS.valueRequired);
      requestAnimationFrame(() => {
        const id = `${prefix}-${field === "label" ? "name" : "value"}`;
        form.current?.ownerDocument.getElementById(id)?.focus();
      });
      return;
    }
    setValue("");
    setBusy(true);
    setError(null);
    try {
      const next = await window.infinitary.secrets.entry(input);
      const saved = next.entries.find((row) => row.ref === next.saved?.ref);
      if (
        saved?.version === input.expectedVersion + 1 &&
        next.saved?.version === saved.version &&
        (!input.ref || saved.ref === input.ref) &&
        next.message === SECRETS_WORDS.saved
      )
        onSaved(next);
      else setError(next.message ?? SECRETS_WORDS.unavailable);
    } catch {
      setError(SECRETS_WORDS.unavailable);
    } finally {
      input.value = "";
      setBusy(false);
    }
  };
  return (
    <form
      ref={form}
      className="fm-secrets-form"
      onSubmit={(event) => void save(event)}
      autoComplete="off"
      aria-label={entry ? SECRETS_WORDS.replace : SECRETS_WORDS.add}
    >
      <h3>{entry ? `${SECRETS_WORDS.replace} ${entry.label}` : SECRETS_WORDS.add}</h3>
      <label htmlFor={`${prefix}-name`}>
        {SECRETS_WORDS.name}
        <Input
          id={`${prefix}-name`}
          required
          value={label}
          disabled={busy}
          onChange={(event) => setLabel(event.target.value)}
          placeholder={m.settingsSecretsNamePlaceholder()}
        />
      </label>
      <label htmlFor={`${prefix}-value`}>
        {SECRETS_WORDS.value}
        <SecretField
          id={`${prefix}-value`}
          required
          value={value}
          disabled={busy}
          onValue={setValue}
        />
      </label>
      <p className="fm-secrets-muted">{SECRETS_WORDS.noReveal}</p>
      <label htmlFor={`${prefix}-place`}>
        {SECRETS_WORDS.place}
        <Input
          id={`${prefix}-place`}
          value={environment}
          disabled={busy}
          onChange={(event) => setEnvironment(event.target.value)}
          placeholder={SECRETS_WORDS.placeHint}
        />
      </label>
      <SettingError error={error} surface="secret-entry" />
      <div className="fm-secrets-actions">
        <Button type="submit" pending={busy} pendingLabel={m.settingsSecretsSaving()}>
          {SECRETS_WORDS.save}
        </Button>
        <Button
          type="button"
          variant="ghost"
          off={busy}
          note={busy ? m.settingsSecretsWaitForSaving() : undefined}
          onClick={() => {
            setValue("");
            onCancel();
          }}
        >
          {m.settingsSecretsCancel()}
        </Button>
      </div>
    </form>
  );
}

/** INF-1109's phone approvals (docs/secrets.md, "Remote decisions"): each enrolled device, and the way to stop it. */
function ApprovalDevices({ asking }: { asking: Asking }) {
  const { view, busy } = asking;
  return (
    <section className="fm-secrets-area" aria-label={SECRETS_WORDS.devicesRegion}>
      {view.devices.length === 0 ? (
        <p className="fm-secrets-muted">{SECRETS_WORDS.noDevices}</p>
      ) : (
        view.devices.map((device) => (
          <div key={device.device} className="fm-secrets-row">
            <div>
              <strong>{device.label}</strong>
              <p className="fm-secrets-muted">
                {m.settingsSecretsDeviceCode({ code: device.code })}
              </p>
            </div>
            {view.question?.about.kind === "device" &&
            view.question.about.device === device.device ? (
              <SecretQuestion question={view.question} answering={busy} onAnswer={asking.answer} />
            ) : (
              <span data-secret-asks={`device:${device.device}`}>
                <Button
                  variant="ghost"
                  pending={busy}
                  onClick={() =>
                    asking.ask(
                      { kind: "forget-device", device: device.device },
                      `device:${device.device}`,
                      "phone",
                    )
                  }
                >
                  {SECRETS_WORDS.stopApprovals}
                </Button>
              </span>
            )}
          </div>
        ))
      )}
    </section>
  );
}

function History({ asking, refresh }: { asking: Asking; refresh: () => Promise<void> }) {
  const { view, busy } = asking;
  const [message, setMessage] = useState<string | null>(null);
  return (
    <section className="fm-secrets-area" aria-label={SECRETS_WORDS.historyRegion}>
      <p>{SECRETS_WORDS.history}</p>
      <p className="fm-secrets-muted">{SECRETS_WORDS.storageUse(sizeOf(view.historyBytes))}</p>
      {view.question?.about.kind === "history" ? (
        <SecretQuestion question={view.question} answering={busy} onAnswer={asking.answer} />
      ) : (
        <div className="fm-secrets-actions">
          <Button
            variant="secondary"
            onClick={() => {
              void window.infinitary.secrets
                .exportHistory()
                .then((result) =>
                  setMessage(
                    result.saved ? m.settingsSecretsHistoryExported() : m.settingsSecretsNoExport(),
                  ),
                )
                .catch(() => setMessage(m.settingsSecretsExportFailed()));
            }}
          >
            {m.settingsSecretsExportHistory()}
          </Button>
          <span data-secret-asks="history">
            <Button
              variant="ghost"
              pending={busy}
              onClick={() => asking.ask({ kind: "delete-history" }, "history", "history")}
            >
              {m.settingsSecretsDeleteHistory()}
            </Button>
          </span>
          <Button variant="ghost" onClick={() => void refresh()}>
            {m.settingsSecretsRefresh()}
          </Button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
      {view.history.length === 0 ? (
        <p>{m.settingsSecretsNoHistory()}</p>
      ) : (
        [...view.history].reverse().map((item) => (
          <div className="fm-secrets-history" key={item.request}>
            <div className="fm-secrets-actions">
              <strong>{item.secrets.map((ref) => secretName(view.entries, ref)).join(", ")}</strong>
              <span className="fm-secrets-muted">
                {SECRET_STATE_WORDS[item.state]} · {dateOf(item.requestedAt)}
              </span>
            </div>
            {!item.copied && <p>{item.reason}</p>}
            {item.recoveredFrom && (
              <details>
                <summary>{SECRETS_RECOVERY_WORDS.recoveredHistory}</summary>
                <p className="fm-secrets-mono">
                  {m.settingsSecretsRecoveredSource({ source: item.recoveredFrom })}
                </p>
                <p className="fm-secrets-mono">
                  {m.settingsSecretsRecoveredAt({ at: dateOf(item.recoveredAt ?? null) })}
                </p>
              </details>
            )}
            <p className="fm-secrets-muted">
              {item.copied ? (
                SECRET_COPY_WORDS.byYou
              ) : (
                <span className="fm-secrets-mono">{item.program}</span>
              )}
              {item.approval ? ` · ${SECRET_APPROVAL_WORDS[item.approval]}` : ""}
              {item.signIn ? ` · ${SECRETS_WORDS.yourSignIn}` : ""}
              {item.given ? ` · ${m.settingsSecretsAddedWithProgram()}` : ""}
              {item.brought ? ` · ${m.settingsSecretsBroughtFrom({ tool: item.brought })}` : ""}
              {item.reconciled && !item.recoveredFrom
                ? ` · ${SECRETS_RECOVERY_WORDS.reconciledAfterRestart}`
                : ""}
            </p>
          </div>
        ))
      )}
    </section>
  );
}

function Recovery({ view, act, busy }: { view: SecretsView; act: Act; busy: boolean }) {
  const ready = view.recoveryAvailable && view.availability === "available";
  const restoreReady = view.recoveryAvailable && view.availability !== "locked";
  const waiting = m.settingsSecretsFinishFormOrChange();
  return (
    <section className="fm-secrets-area" aria-label={SECRETS_RECOVERY_WORDS.region}>
      {!view.recoveryAvailable && <p role="status">{SECRETS_RECOVERY_WORDS.unavailable}</p>}
      <div className="fm-secrets-recovery-choice">
        <div>
          <p>{m.settingsSecretsBackupNote()}</p>
        </div>
        <Button
          variant="secondary"
          off={busy || !ready}
          note={
            busy
              ? waiting
              : !view.recoveryAvailable
                ? SECRETS_RECOVERY_WORDS.unavailable
                : !ready
                  ? SECRETS_WORDS.unavailable
                  : undefined
          }
          onClick={() => void act({ kind: "backup-recovery" })}
        >
          {SECRETS_RECOVERY_WORDS.saveButton}
        </Button>
      </div>
      <div className="fm-secrets-recovery-choice">
        <div>
          <p>{m.settingsSecretsRestoreNote()}</p>
        </div>
        <Button
          variant="secondary"
          off={busy || !restoreReady}
          note={
            busy
              ? waiting
              : !view.recoveryAvailable
                ? SECRETS_RECOVERY_WORDS.unavailable
                : !restoreReady
                  ? m.settingsSecretsUnlockBeforeRestore()
                  : undefined
          }
          onClick={() => void act({ kind: "restore-recovery" })}
        >
          {SECRETS_RECOVERY_WORDS.restoreButton}
        </Button>
      </div>
      <p className="fm-secrets-muted">{m.settingsSecretsRecoveryFiles()}</p>
    </section>
  );
}

function historySummary(history: SecretsView["history"]): string {
  if (history.length === 0) return SECRETS_WORDS.noHistory;
  const newest = Math.max(...history.map((item) => item.requestedAt));
  return SECRETS_WORDS.historySummary(history.length, dayOf(newest));
}

function dayOf(at: number): string {
  const day = new Date(at);
  const today = new Date();
  const start = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((start(today) - start(day)) / 86_400_000);
  if (days === 0) return SECRETS_WORDS.today;
  if (days === 1) return SECRETS_WORDS.yesterday;
  return formatDate(day, { month: "short", day: "numeric" });
}

function timeOf(at: number): string {
  return formatTime(at, { hour: "numeric", minute: "2-digit" });
}

function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function dateOf(at: number | null): string {
  return at === null ? m.settingsSecretsNotRequested() : formatDateTime(at);
}
