import type { AccountView } from "@shared/accounts";
import * as m from "@shared/i18n/messages.generated";
import type { AuthNotice, AuthPromptView, ProviderView } from "@shared/providers";
import {
  API_KEY_LABEL,
  CLAUDE_PROVIDER_ID,
  CODE_STEP_WORDS,
  catalogEntry,
  githubEnterpriseHost,
  providerServesRole,
  providerSignInNote,
} from "@shared/providers";
import type React from "react";
import { useId, useState } from "react";
import { Button, Input } from "../design";
import { useRestLabel } from "../design/core/restLabel";
import { useFirstMatePlace } from "../devices/useFirstMatePlace";
import { CopyCodeButton, useCopyCode } from "./CopyCode";
import { CustomApiDialog, CustomApiForm } from "./CustomApiForm";
import "./connectChips.css";

/**
 * The provider chip row and the sign-in aside, shared by the first-launch
 * gate on the stage and the Intelligence tab's "Add account" foot (design
 * skill `components/core/ConnectChips`). One row: the providers whose
 * accounts can serve Firstmate itself, and - a hairline apart, under the
 * micro label "crew only" - any whose accounts can only run crew. The
 * grouping is derived from the catalog's roles and is the guidance; every
 * provider in today's catalog serves Firstmate, so the row is one group.
 * Every chip stays a live button. Sign-in is the provider's
 * own flow (a browser bounce, a device code, a pasted key), rendered by the
 * same aside wherever the row sits; nothing here names the machinery.
 */

const plusIcon = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M5 12h14M12 5v14" />
  </svg>
);

/**
 * A connected account on the stage, in its chip's place: why it cannot
 * answer yet (or that it is connected) shows on rest, the pointer's or the
 * keyboard's focus, so it is a Tab stop of its own, and its accessible
 * description carries the same sentence (docs/keyboard.md, "Facts shown on
 * rest").
 */
function ConnectedAccount({
  providerId,
  why,
  unavailable,
  children,
}: {
  providerId: string;
  why: string;
  unavailable: boolean;
  children: React.ReactNode;
}) {
  const rest = useRestLabel(why, { fact: true });
  return (
    <span
      className="fm-connect-account"
      data-connect-account={providerId}
      data-unavailable={unavailable ? "true" : undefined}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a fact shown on rest is a stop of its own, so the keyboard reads it as the pointer does
      tabIndex={0}
      aria-description={why}
      {...rest}
    >
      {children}
    </span>
  );
}

/**
 * A provider's chip. One that cannot be pressed for a reason (nothing on
 * this computer runs it, or Claude already uses this computer's login)
 * stays a Tab stop, marked off rather than disabled, so the keyboard reaches
 * the reason: it shows on rest, the pointer's or the keyboard's focus, and
 * rides the chip's accessible description (docs/keyboard.md, "Facts shown
 * on rest"). A press there does nothing.
 */
function ProviderChip({
  providerId,
  name,
  reason,
  busy,
  onConnect,
  children,
}: {
  providerId: string;
  name: string;
  /** Why the chip cannot be pressed; absent while it can. */
  reason: string | undefined;
  busy: boolean;
  onConnect: () => void;
  children: React.ReactNode;
}) {
  const rest = useRestLabel(reason, { fact: true });
  return (
    <button
      type="button"
      className="fm-connect-chip"
      data-connect-provider={providerId}
      aria-label={name}
      title={reason === undefined ? name : undefined}
      aria-description={reason !== undefined && reason !== name ? reason : undefined}
      aria-disabled={reason !== undefined ? "true" : undefined}
      disabled={busy}
      {...rest}
      onClick={() => {
        if (reason === undefined) onConnect();
      }}
    >
      {children}
    </button>
  );
}

export type ProviderGroups = { firstmate: ProviderView[]; crew: ProviderView[] };

export function groupProviders(providers: readonly ProviderView[]): ProviderGroups {
  const groups: ProviderGroups = { firstmate: [], crew: [] };
  for (const provider of providers) {
    const serves = providerServesRole(provider.id, "firstmate");
    (serves ? groups.firstmate : groups.crew).push(provider);
  }
  return groups;
}

export type ProviderChipsProps = {
  providers: readonly ProviderView[];
  /** The accounts already connected; a provider with one reads differently. */
  accounts: readonly AccountView[];
  /** The provider whose sign-in is in flight, if any. */
  busyProviderId: string | null;
  /** Stops provider sign-in starts only; custom connection management stays available. */
  signInOff?: string;
  onConnect: (provider: ProviderView) => void;
  /**
   * `foot`: the Intelligence tab's row, where accounts are listed above and
   * a connected provider's chip offers another account. `stage`: the
   * first-launch gate, where a connected account - one that cannot answer
   * yet, or the gate would be down - shows in place of its chip, since
   * nothing else on the stage lists it.
   */
  variant: "foot" | "stage";
  /**
   * Where the accounts sign in: this Mac, or a computer that runs work,
   * which says Claude's words about that computer (docs/helper.md, "Its own
   * sign-ins"). A computer's Custom API chip is `custom`, drawn by its group.
   */
  place?: "here" | "there";
  /**
   * A computer's Custom API chip. `onOpen` absent keeps it disabled, with
   * `note` (an older Firstmate there).
   */
  custom?: { onOpen?: () => void; note?: string };
};

export function ProviderChips({
  providers,
  accounts,
  busyProviderId,
  signInOff,
  onConnect,
  variant,
  place = "here",
  custom,
}: ProviderChipsProps) {
  const [customOpen, setCustomOpen] = useState(false);
  const home = useFirstMatePlace();
  const groups = groupProviders(providers);
  const connected = new Map<string, AccountView>();
  for (const account of accounts) {
    if (!connected.has(account.providerId)) connected.set(account.providerId, account);
  }
  const chip = (provider: ProviderView) => {
    const busy = busyProviderId === provider.id;
    const account = connected.get(provider.id);
    // No way in, and the backend said why (a client the person installs,
    // F14): a chip stays, disabled, with its words.
    const unavailable = provider.authTypes.length === 0 ? provider.unavailable : undefined;
    if (variant === "stage" && account) {
      // An account on the stage while the gate is up says why it cannot
      // answer yet, when it knows: nothing to run it on this Mac, or a
      // login not signed in.
      const note =
        unavailable?.note ?? (account.connected ? undefined : m.accountsConnectNotSignedIn());
      const why =
        account.detail ??
        unavailable?.detail ??
        (account.connected
          ? undefined
          : m.accountsConnectNotSignedInYet({ provider: provider.name, here: home.this }));
      return (
        <ConnectedAccount
          key={provider.id}
          providerId={provider.id}
          why={why ?? m.accountsConnectConnected({ provider: provider.name })}
          unavailable={Boolean(note)}
        >
          <span className="fm-connect-account-dot" aria-hidden="true" />
          <b>{provider.name}</b>
          <span>{account.label}</span>
          {note && <span className="fm-connect-chip-note">{note}</span>}
        </ConnectedAccount>
      );
    }
    // A computer that runs work has the one Claude login it holds; here a
    // connected Claude offers another login, in a folder of its own.
    const claude = provider.id === CLAUDE_PROVIDER_ID && account !== undefined;
    const claudeTaken = claude && place === "there";
    const note =
      unavailable && provider.id === CLAUDE_PROVIDER_ID && place === "there"
        ? CONNECT_CHIP_NOTES.installClaudeThere
        : unavailable?.note;
    const name = claudeTaken
      ? m.accountsConnectClaudeLoginThere()
      : claude
        ? m.accountsConnectAddClaudeLogin()
        : account
          ? m.accountsConnectAddAnother({ provider: provider.name })
          : m.accountsConnectProvider({ provider: provider.name });
    // Why the chip cannot be pressed: what the backend said (F14), or the
    // login Claude already uses; a provider with no way in and no word why
    // says that it cannot be added.
    const reason =
      provider.authTypes.length === 0
        ? (unavailable?.detail ?? name)
        : claudeTaken
          ? name
          : undefined;
    return (
      <ProviderChip
        key={provider.id}
        providerId={provider.id}
        name={name}
        reason={signInOff ?? reason}
        busy={busy}
        onConnect={() => onConnect(provider)}
      >
        {plusIcon}
        <span>{busy ? m.accountsConnectConnecting() : provider.name}</span>
        {note && <span className="fm-connect-chip-note">{note}</span>}
        {providerSignInNote(provider) && (
          <span className="fm-connect-chip-note">{providerSignInNote(provider)}</span>
        )}
      </ProviderChip>
    );
  };
  return (
    <div className="fm-connect-chips" data-connect-chips={variant}>
      {groups.firstmate.map(chip)}
      {place === "here" && (
        <button
          type="button"
          className="fm-connect-chip"
          data-connect-custom-api
          onClick={() => setCustomOpen(true)}
        >
          {plusIcon}
          <span>{m.accountsConnectCustomApi()}</span>
        </button>
      )}
      {place === "there" && custom && (
        <button
          type="button"
          className="fm-connect-chip"
          data-connect-custom-api
          disabled={!custom.onOpen}
          title={custom.note}
          onClick={() => custom.onOpen?.()}
        >
          {plusIcon}
          <span>{m.accountsConnectCustomApi()}</span>
          {custom.note && <span className="fm-connect-chip-note">{custom.note}</span>}
        </button>
      )}
      {customOpen && (
        <CustomApiDialog label={m.accountsCustomApiAddTitle()} onClose={() => setCustomOpen(false)}>
          <CustomApiForm firstSetup={variant === "stage"} onClose={() => setCustomOpen(false)} />
        </CustomApiDialog>
      )}
      {groups.crew.length > 0 && (
        // The label and its chips wrap as one unit, so "crew only" never
        // ends a line with its group on the next.
        <span className="fm-connect-group" data-connect-group="crew">
          {groups.firstmate.length > 0 && <span className="fm-connect-sep" aria-hidden="true" />}
          <span className="fm-connect-label">{m.accountsConnectCrewOnly()}</span>
          {groups.crew.map(chip)}
        </span>
      )}
    </div>
  );
}

/** The notes a chip on a computer that runs work carries. */
export const CONNECT_CHIP_NOTES = {
  /** A Claude chip on a computer that runs work, where Claude Code is not installed. */
  get installClaudeThere() {
    return m.accountsConnectInstallClaudeThere();
  },
  /** A Custom API chip on a computer that runs an older Firstmate. */
  get updateThere() {
    return m.accountsConnectUpdateThere();
  },
} as const;

/**
 * The sign-in a provider offers; two means the person picks first. A
 * provider that signs in with a code (Copilot, Kimi Code) starts it at once
 * (INF-838).
 */
export function connectMethods(
  provider: Pick<ProviderView, "id" | "authTypes">,
): ("oauth" | "api_key")[] {
  const methods = provider.authTypes.filter((type) => type === "oauth" || type === "api_key");
  return catalogEntry(provider.id)?.codeSignIn && methods.includes("oauth") ? ["oauth"] : methods;
}

/**
 * How a sign-in that did not finish ended: the person's own Cancel, which
 * says nothing; a code that ran out, past the moment the provider's own
 * answer gave (`expiresAt`); or a failure whose words the caller shows.
 */
export function signInEnd(input: {
  cancelled: boolean;
  notice: AuthNotice | null | undefined;
  now: number;
}): "cancelled" | "expired" | "failed" {
  if (input.cancelled) return "cancelled";
  const expiresAt = input.notice?.kind === "device_code" ? input.notice.expiresAt : undefined;
  return expiresAt !== undefined && input.now >= expiresAt ? "expired" : "failed";
}

/**
 * A provider that signs in either way asks which, before anything opens:
 * the browser bounce, or a pasted key. Rendered like Pi's own select, in
 * the same aside, so the two flows read as one. A provider with one way in
 * never shows this.
 */
export function AuthMethodChoice({
  provider,
  onPick,
  onCancel,
  framed = false,
}: {
  provider: ProviderView;
  onPick: (type: "oauth" | "api_key") => void;
  onCancel: () => void;
  framed?: boolean;
}) {
  const body = (
    <div
      className="fm-connect-aside"
      data-connect-method={provider.id}
      style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 4 }}
    >
      <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-1)" }}>
        {m.accountsConnectHow({ provider: provider.name })}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button variant="secondary" size="sm" onClick={() => onPick("oauth")}>
          {m.accountsConnectBrowser()}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => onPick("api_key")}>
          {API_KEY_LABEL}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {m.accountsConnectCancel()}
        </Button>
      </div>
    </div>
  );
  return framed ? (
    <div className="fm-connect-aside-frame" data-connect-aside="">
      {body}
    </div>
  ) : (
    body
  );
}

export function AuthPromptPanel({
  prompt,
  promptValue,
  onPromptValue,
  onAnswer,
}: {
  prompt: AuthPromptView;
  promptValue: string;
  onPromptValue: (value: string) => void;
  onAnswer: (value: string | null) => void;
}) {
  return (
    <div
      className="fm-connect-aside"
      style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 4 }}
    >
      <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-1)" }}>{prompt.message}</div>
      {prompt.kind === "select" && prompt.options ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {prompt.options.map((option) => (
            <Button
              key={option.id}
              variant="secondary"
              size="sm"
              onClick={() => onAnswer(option.id)}
            >
              {option.label}
            </Button>
          ))}
          <Button variant="ghost" size="sm" onClick={() => onAnswer(null)}>
            {m.accountsConnectCancel()}
          </Button>
        </div>
      ) : (
        <form
          style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
          onSubmit={(event: React.FormEvent) => {
            event.preventDefault();
            onAnswer(promptValue);
          }}
        >
          <div style={{ flex: 1, minWidth: 220 }}>
            <Input
              mono
              type={prompt.kind === "secret" ? "password" : "text"}
              value={promptValue}
              placeholder={prompt.placeholder ?? ""}
              onChange={(event) => onPromptValue(event.target.value)}
              autoFocus
            />
          </div>
          <Button variant="primary" size="sm" type="submit">
            {m.accountsConnectSubmit()}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onAnswer(null)}>
            {m.accountsConnectCancel()}
          </Button>
        </form>
      )}
    </div>
  );
}

/**
 * A sign-in's notice and prompt, anchored under whatever started it: the
 * chip on the stage, the account row signing in again, or the "Add
 * account" foot for a new one. `framed` draws the panel the stage uses;
 * inside the tab's list box it sits flush.
 */
export function AuthAside({
  notice,
  prompt,
  promptValue,
  onPromptValue,
  onAnswerPrompt,
  onCancel,
  enterprise,
  framed = false,
}: {
  notice?: AuthNotice;
  prompt?: AuthPromptView;
  promptValue: string;
  onPromptValue: (value: string) => void;
  onAnswerPrompt: (value: string | null) => void;
  /** Stops the sign-in; a provider's code step shows it beside the code. */
  onCancel: () => void;
  /** The Use GitHub Enterprise row, on a new Copilot account's code step. */
  enterprise?: EnterpriseChoice;
  framed?: boolean;
}) {
  const site = notice ? catalogEntry(notice.providerId)?.codeSignIn?.site : undefined;
  const codeStep = notice?.kind === "device_code" && notice.userCode && site;
  const body = (
    <>
      {codeStep && notice.userCode ? (
        <CodeStep
          key={`${notice.providerId}:${notice.userCode}`}
          providerId={notice.providerId}
          site={site}
          code={notice.userCode}
          {...(notice.url ? { url: notice.url } : {})}
          onCancel={onCancel}
          {...(enterprise ? { enterprise } : {})}
        />
      ) : null}
      {notice && !codeStep && (
        <div
          className="fm-connect-aside"
          style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}
        >
          {notice.message}
          {notice.url && (
            <div style={{ marginTop: 8 }}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  const url = notice.url;
                  if (!url) return;
                  void window.infinitary.app.openExternal(url).catch(() => {});
                }}
              >
                {m.accountsConnectOpenSignIn()}
              </Button>
            </div>
          )}
          {notice.userCode && (
            <span
              style={{
                fontFamily: "var(--font-mono)",
                color: "var(--fg-1)",
                letterSpacing: "0.12em",
                background: "var(--bg-3)",
                borderRadius: "var(--radius-s)",
                padding: "2px 8px",
                marginInlineStart: 8,
              }}
            >
              {notice.userCode}
            </span>
          )}
        </div>
      )}
      {prompt && (
        <AuthPromptPanel
          prompt={prompt}
          promptValue={promptValue}
          onPromptValue={onPromptValue}
          onAnswer={onAnswerPrompt}
        />
      )}
    </>
  );
  return framed ? (
    <div className="fm-connect-aside-frame" data-connect-aside="">
      {body}
    </div>
  ) : (
    body
  );
}

/** The host a new Copilot account signs in to, and the restart onto another. */
export type EnterpriseChoice = {
  /** The Enterprise host this attempt uses; absent is github.com. */
  host?: string;
  /** Start again on a GitHub Enterprise host, or on github.com with null. */
  onUse: (host: string | null) => void;
};

/**
 * A provider's code step (INF-838), after the GitHub sign-in in Settings ->
 * Integrations: the code, Copy code, one button that copies the code and
 * opens the provider's page, Cancel, and a line that says the app is
 * waiting. Copilot adds that GitHub asks to approve a Copilot app, and a new
 * account's row to use GitHub Enterprise instead.
 */
function CodeStep({
  providerId,
  site,
  code,
  url,
  onCancel,
  enterprise,
}: {
  providerId: string;
  site: string;
  code: string;
  url?: string;
  onCancel: () => void;
  enterprise?: EnterpriseChoice;
}) {
  const { state, copy, status } = useCopyCode(code, true);
  const [enterpriseOpen, setEnterpriseOpen] = useState(false);
  const fieldId = useId();
  const [host, setHost] = useState("");
  const [hostError, setHostError] = useState<string | null>(null);
  // An Enterprise sign-in names the address its code is entered at, even
  // when signing in again took it from the account and not the field.
  const page =
    enterprise?.host ??
    (url && catalogEntry(providerId)?.codeSignIn?.enterprise ? githubEnterpriseHost(url) : null) ??
    site;
  if (enterprise && enterpriseOpen) {
    return (
      <form
        className="fm-connect-aside fm-code-step"
        data-code-step={providerId}
        data-enterprise-step=""
        onSubmit={(event: React.FormEvent) => {
          event.preventDefault();
          const chosen = githubEnterpriseHost(host);
          if (!chosen) {
            setHostError(CODE_STEP_WORDS.badEnterprise);
            return;
          }
          enterprise.onUse(chosen);
        }}
      >
        <label htmlFor={fieldId} className="fm-code-step-line">
          {CODE_STEP_WORDS.enterpriseLabel}
        </label>
        <div className="fm-code-step-actions">
          <div style={{ flex: 1, minWidth: 220 }}>
            <Input
              id={fieldId}
              mono
              value={host}
              placeholder={CODE_STEP_WORDS.enterprisePlaceholder}
              aria-invalid={hostError ? "true" : undefined}
              aria-describedby={hostError ? `${fieldId}-error` : undefined}
              onChange={(event) => {
                setHost(event.target.value);
                setHostError(null);
              }}
              autoFocus
            />
          </div>
          <Button variant="primary" size="sm" type="submit">
            {CODE_STEP_WORDS.getCode}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setEnterpriseOpen(false)}>
            {CODE_STEP_WORDS.useGitHubCom}
          </Button>
        </div>
        {hostError && (
          <p id={`${fieldId}-error`} role="alert" className="fm-code-step-error">
            {hostError}
          </p>
        )}
      </form>
    );
  }
  return (
    <div className="fm-connect-aside fm-code-step" data-code-step={providerId}>
      <div className="fm-code-step-line">
        {CODE_STEP_WORDS.enter(page)}
        <span className="fm-code-step-code" data-code-step-code="">
          {code}
        </span>
        <CopyCodeButton state={state} onCopy={() => void copy()} />
        {status}
      </div>
      <div className="fm-code-step-actions">
        {url && (
          <Button
            variant="primary"
            size="sm"
            autoFocus
            onClick={() => {
              void copy();
              void window.infinitary.app.openExternal(url).catch(() => {});
            }}
          >
            {CODE_STEP_WORDS.copyAndOpen(page)}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {m.accountsConnectCancel()}
        </Button>
        {enterprise && (
          <Button
            variant="ghost"
            size="sm"
            style={{ marginInlineStart: "auto" }}
            onClick={() => (enterprise.host ? enterprise.onUse(null) : setEnterpriseOpen(true))}
          >
            {enterprise.host ? CODE_STEP_WORDS.useGitHubCom : CODE_STEP_WORDS.useEnterprise}
          </Button>
        )}
      </div>
      <p className="fm-code-step-waiting" data-code-step-waiting="">
        {CODE_STEP_WORDS.waiting(page)}
        {catalogEntry(providerId)?.codeSignIn?.enterprise ? ` ${CODE_STEP_WORDS.approve}` : ""}
      </p>
    </div>
  );
}

/** A code that ran out: the step says so and offers a new one, as Integrations does. */
export function CodeExpired({
  providerId,
  onNewCode,
  onClose,
  framed = false,
}: {
  providerId: string;
  onNewCode: () => void;
  /** Leaves the step, back to the chips. */
  onClose: () => void;
  framed?: boolean;
}) {
  const body = (
    <div className="fm-connect-aside fm-code-step" data-code-expired={providerId}>
      <div className="fm-code-step-line">{CODE_STEP_WORDS.expired}</div>
      <div className="fm-code-step-actions">
        <Button variant="secondary" size="sm" autoFocus onClick={onNewCode}>
          {CODE_STEP_WORDS.newCode}
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {m.accountsConnectCancel()}
        </Button>
      </div>
    </div>
  );
  return framed ? (
    <div className="fm-connect-aside-frame" data-connect-aside="">
      {body}
    </div>
  ) : (
    body
  );
}
