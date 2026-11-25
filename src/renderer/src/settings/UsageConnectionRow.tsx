import * as m from "@shared/i18n/messages.generated";
import type {
  UsageConnectionFormat,
  UsageConnectionProblem,
  UsageConnectionView,
} from "@shared/usageConnection";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button, Input, SecretField } from "../design";
import { focusWithRing } from "../design/focus";
import { SettingError, SettingRow } from "./settingRows";
import "./usageConnection.css";

const PROBLEM_WORDS: Record<UsageConnectionProblem, () => string> = {
  address: m.settingsUsageConnectionProblemAddress,
  "plain-http": m.settingsUsageConnectionProblemPlainHttp,
  "not-found": m.settingsUsageConnectionProblemNotFound,
  destination: m.settingsUsageConnectionProblemDestination,
  header: m.settingsUsageConnectionProblemHeader,
  "header-value": m.settingsUsageConnectionProblemHeaderValue,
  "no-secrets": m.settingsUsageConnectionProblemNoSecrets,
  "secrets-locked": m.settingsUsageConnectionProblemSecretsLocked,
};

type HeaderDraft = { key: number; name: string; value: string; kept: boolean };

const ROW = '[data-setting="usage-connection"]';
/** Where the keyboard goes when the form or the remove question closes: the row's own button. */
const ROW_BUTTON = "[data-usage-connection-edit], [data-usage-connection-add]";

/**
 * Moves focus, with its ring, to what `selector` names under `within` once
 * the next render has drawn it, since the control a key pressed has just
 * unmounted (docs/keyboard.md).
 */
function useFocusAfter(within: () => ParentNode | null | undefined, deps: readonly unknown[]) {
  const [selector, setSelector] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: it runs after each render the callers name
  useEffect(() => {
    if (!selector) return;
    const target = within()?.querySelector<HTMLElement>(selector);
    if (target) {
      focusWithRing(target);
      setSelector(null);
    }
  }, [selector, ...deps]);
  return setSelector;
}

/**
 * The reporting connection a person adds (docs/usage-report.md, "The
 * person's reporting connection"): one row in Settings → Intelligence
 * beside the cost limit, saying where the crew's usage goes, with a form
 * to add, edit or remove it. Save is the consent to send there; a kept
 * header's value never comes back to the window.
 */
export function UsageConnectionRow() {
  const [view, setView] = useState<UsageConnectionView | undefined>();
  const [editing, setEditing] = useState(false);
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    void window.infinitary.settings
      .getUsageConnection()
      .then(setView)
      // A home without the connection's channels answers nothing: the row stays hidden.
      .catch(() => undefined);
  }, []);
  useEffect(refresh, [refresh]);
  const focusAfter = useFocusAfter(() => document.querySelector(ROW), [view, editing, armed]);
  if (view === undefined) return null;
  const host = view ? new URL(view.endpoint).host : null;
  return (
    <SettingRow
      id="usage-connection"
      title={m.settingsUsageConnectionTitle()}
      error={error}
      description={
        view && host
          ? view.format === "claude-code"
            ? m.settingsUsageConnectionClaudeCode({ host })
            : m.settingsUsageConnectionStandard({ host })
          : m.settingsUsageConnectionNone()
      }
      detail={
        editing ? (
          <UsageConnectionForm
            original={view}
            onClose={() => {
              setEditing(false);
              focusAfter(ROW_BUTTON);
            }}
            onSaved={(next) => {
              setView(next);
              setEditing(false);
              focusAfter(ROW_BUTTON);
            }}
          />
        ) : armed ? (
          <div className="fm-usage-conn-remove">
            <p>{m.settingsUsageConnectionRemoveWarning()}</p>
            <div className="fm-usage-conn-acts">
              <Button
                variant="secondary"
                size="sm"
                data-usage-connection-confirm=""
                onClick={() =>
                  void window.infinitary.settings
                    .removeUsageConnection()
                    .then((next) => {
                      setView(next);
                      setArmed(false);
                      setError(null);
                      focusAfter(ROW_BUTTON);
                    })
                    .catch(() => setError(m.settingsUsageConnectionFailed()))
                }
              >
                {m.settingsUsageConnectionRemoveConfirm()}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setArmed(false);
                  focusAfter(ROW_BUTTON);
                }}
              >
                {m.settingsUsageConnectionKeep()}
              </Button>
            </div>
          </div>
        ) : null
      }
      control={
        editing || armed ? null : view ? (
          <div className="fm-usage-conn-acts">
            <Button
              variant="ghost"
              size="sm"
              data-usage-connection-edit=""
              onClick={() => setEditing(true)}
            >
              {m.settingsUsageConnectionEdit()}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setArmed(true);
                focusAfter("[data-usage-connection-confirm]");
              }}
            >
              {m.settingsUsageConnectionRemove()}
            </Button>
          </div>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            data-usage-connection-add=""
            onClick={() => setEditing(true)}
          >
            {m.settingsUsageConnectionAdd()}
          </Button>
        )
      }
    />
  );
}

function UsageConnectionForm({
  original,
  onClose,
  onSaved,
}: {
  original: UsageConnectionView;
  onClose: () => void;
  onSaved: (view: UsageConnectionView) => void;
}) {
  const id = useId();
  const [endpoint, setEndpoint] = useState(original?.endpoint ?? "");
  const [format, setFormat] = useState<UsageConnectionFormat>(original?.format ?? "standard");
  const [headers, setHeaders] = useState<HeaderDraft[]>(
    (original?.headers ?? []).map((header, key) => ({
      key,
      name: header.name,
      value: "",
      kept: true,
    })),
  );
  const [nextKey, setNextKey] = useState(headers.length);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const focusAfter = useFocusAfter(() => formRef.current, [headers]);
  const change = (key: number, edit: Partial<HeaderDraft>) =>
    setHeaders((rows) => rows.map((row) => (row.key === key ? { ...row, ...edit } : row)));
  const save = () => {
    setSaving(true);
    setProblem(null);
    void window.infinitary.settings
      .saveUsageConnection({
        endpoint: endpoint.trim(),
        format,
        headers: headers.map((header) => ({
          name: header.name.trim(),
          ...(header.value ? { value: header.value } : {}),
        })),
      })
      .then((saved) => {
        if (saved.saved) onSaved(saved.view);
        else setProblem(PROBLEM_WORDS[saved.problem]());
      })
      .catch(() => setProblem(m.settingsUsageConnectionFailed()))
      .finally(() => setSaving(false));
  };
  return (
    <form
      ref={formRef}
      className="fm-usage-conn-form"
      data-usage-connection-form=""
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <div className="fm-usage-conn-field">
        <label htmlFor={`${id}-endpoint`}>{m.settingsUsageConnectionAddress()}</label>
        <Input
          id={`${id}-endpoint`}
          value={endpoint}
          spellCheck={false}
          autoFocus
          // i18n-exempt: an address's scheme
          placeholder="https://"
          onChange={(event) => setEndpoint(event.target.value)}
        />
        <span className="fm-usage-conn-hint">{m.settingsUsageConnectionAddressHint()}</span>
      </div>
      <div className="fm-usage-conn-field">
        <label htmlFor={`${id}-format`}>{m.settingsUsageConnectionReads()}</label>
        <select
          id={`${id}-format`}
          value={format}
          onChange={(event) => setFormat(event.target.value as UsageConnectionFormat)}
        >
          <option value="standard">{m.settingsUsageConnectionReadsStandard()}</option>
          <option value="claude-code">{m.settingsUsageConnectionReadsClaudeCode()}</option>
        </select>
      </div>
      <fieldset className="fm-usage-conn-headers">
        <legend>{m.settingsUsageConnectionHeaders()}</legend>
        <span className="fm-usage-conn-hint">{m.settingsUsageConnectionHeadersHint()}</span>
        {headers.map((header) => (
          <div
            className="fm-usage-conn-header"
            key={header.key}
            data-usage-connection-header={header.key}
          >
            <Input
              aria-label={m.settingsUsageConnectionHeaderName()}
              placeholder={m.settingsUsageConnectionHeaderName()}
              value={header.name}
              spellCheck={false}
              onChange={(event) => change(header.key, { name: event.target.value, kept: false })}
            />
            <SecretField
              aria-label={m.settingsUsageConnectionHeaderValue()}
              placeholder={
                header.kept
                  ? m.settingsUsageConnectionHeaderKept()
                  : m.settingsUsageConnectionHeaderValue()
              }
              value={header.value}
              onValue={(value) => change(header.key, { value })}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                const at = headers.findIndex((row) => row.key === header.key);
                const neighbor = headers[at + 1] ?? headers[at - 1];
                setHeaders((rows) => rows.filter((row) => row.key !== header.key));
                focusAfter(
                  neighbor
                    ? `[data-usage-connection-header="${neighbor.key}"] input`
                    : "[data-usage-connection-add-header]",
                );
              }}
            >
              {m.settingsUsageConnectionRemoveHeader()}
            </Button>
          </div>
        ))}
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-usage-connection-add-header=""
            onClick={() => {
              setHeaders((rows) => [...rows, { key: nextKey, name: "", value: "", kept: false }]);
              setNextKey(nextKey + 1);
              focusAfter(`[data-usage-connection-header="${nextKey}"] input`);
            }}
          >
            {m.settingsUsageConnectionAddHeader()}
          </Button>
        </div>
      </fieldset>
      <span className="fm-usage-conn-hint">{m.settingsUsageConnectionSaveLine()}</span>
      <span className="fm-usage-conn-hint">{m.settingsUsageConnectionEmailLine()}</span>
      <SettingError error={problem} surface="usage-connection" />
      <div className="fm-usage-conn-acts">
        <Button type="submit" variant="primary" size="sm" disabled={saving || !endpoint.trim()}>
          {m.settingsUsageConnectionSave()}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {m.settingsUsageConnectionCancel()}
        </Button>
      </div>
    </form>
  );
}
