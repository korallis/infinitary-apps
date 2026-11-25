import { ACCOUNT_LABEL_MAX, type AccountView, standingCutOff } from "@shared/accounts";
import { isCustomApiProvider } from "@shared/customApi";
import { hereAs } from "@shared/deviceNames";
import * as m from "@shared/i18n/messages.generated";
import type { AuthNotice, AuthPromptView, ProviderView } from "@shared/providers";
import { CLAUDE_PROVIDER_ID, catalogEntry } from "@shared/providers";
import {
  allowanceProviderOf,
  type PiModelRefView,
  type QuotaProviderView,
  type QuotaSnapshotView,
  type RoutingSettings,
  savedResetsNow,
} from "@shared/quota";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AuthAside,
  AuthMethodChoice,
  CodeExpired,
  connectMethods,
  ProviderChips,
  signInEnd,
} from "../accounts/ConnectChips";
import { CustomApiAccountsSection } from "../accounts/CustomApiConnections";
import {
  answeredSignInPrompt,
  forgetSignInNotice,
  lastSignInNotice,
  runAccountAdd,
  signInFlightSnapshot,
  subscribeSignInFlight,
} from "../accounts/signInFlight";
import { useCommandKeys } from "../app/keyHints";
import { useShellStore } from "../app/store";
import type { RowMenuItem } from "../design";
import { Button, Input, QuotaMicroMeter, RowMenu, StatusDot, Switch } from "../design";
import { useOverflowTitle } from "../design/core/overflowTitle";
import { useRestLabel } from "../design/core/restLabel";
import { clockOf, offersKeepGoing, rowView } from "./accountRows";
import { CostLimitRow } from "./CostLimitRow";
import { DeviceSignInGroups } from "./DeviceSignIns";
import { FIRSTMATE_SELECT_STYLE, FirstmateModelRow, SettingRow } from "./GeneralTab";
import { ModelsSection } from "./ModelsSection";
import { ROW_GAP, SECTION_GAP, SettingError } from "./settingRows";
import {
  CREDITS_SITE,
  CREW_PREFERRED_MARK,
  PERSONAL_RESOURCES_WORDS,
  SUBSCRIPTIONS_WORDS,
} from "./subscriptionsWords";
import { UsageConnectionRow } from "./UsageConnectionRow";
import { useSettingSave } from "./useSettingSave";
import "./subscriptions.css";
import { useFirstMatePlace, useHereAs } from "../devices/useFirstMatePlace";

/** The row rules live in `accountRows.ts`, which the phone runs too; this tab draws what they answer. */
export { rowView };

/**
 * The Subscriptions tab, Instruments direction (captain's pick from the
 * prototype review, 2026-09-05): ONE flat list of accounts, in catalog order
 * then age, where each row is a status dot, the provider, the account's
 * label and plan, every quota window as a micro-meter with the row's one
 * verdict at the end, and a kebab holding the actions. Providers not yet
 * connected are chips in the "Add account" foot, not empty cards. Sign-in is
 * the provider's own flow (a browser bounce or a short code); the user sees
 * providers and their subscriptions, labeled by them, and nothing of the
 * machinery underneath.
 *
 * The honesty rules the meters carry: a combined
 * bound is the effective minimum labeled by its LIMITING window and the
 * runway verdict comes from that scope; a stale row dims and says "as of 3h ago" where the verdict
 * would go and derives nothing; only `auth_required` says "sign in again",
 * and it keeps the one inline action; `not_measured` renders the sensor's
 * own detail verbatim; an unread window is "–", never 0. A Claude Keychain
 * VALUE refusal is `unavailable` with a `keychain_*` reason, the sensor's
 * detail, and a Retry - never a blank meter and never "sign in again". A
 * Claude row that is not signed in is first-run copy ("Sign in with Claude
 * on this Mac"), not an error and not a blank meter (CD-1=B).
 */

export const LABEL_STYLE = {
  fontSize: "var(--text-xs)",
  fontWeight: 500,
  letterSpacing: "var(--tracking-label)",
  textTransform: "uppercase",
  color: "var(--fg-3)",
} as const;

/**
 * Intelligence tab board below the account list: Firstmate's own model (and
 * its account, beside it in the same row), then the
 * models disclosure.
 */
export function IntelligenceBoard({
  firstmateModel,
  models,
  additionalSettings,
}: {
  firstmateModel: React.ReactNode;
  models: React.ReactNode;
  additionalSettings?: React.ReactNode;
}) {
  return (
    <div
      data-intelligence-board
      style={{
        display: "flex",
        flexDirection: "column",
        gap: ROW_GAP,
        marginTop: SECTION_GAP,
      }}
    >
      <div data-intelligence-block="firstmate-model">{firstmateModel}</div>
      {models ? <div data-intelligence-block="models">{models}</div> : null}
      {additionalSettings ? (
        <div
          data-intelligence-block="additional-settings"
          style={{ display: "flex", flexDirection: "column", gap: ROW_GAP }}
        >
          {additionalSettings}
        </div>
      ) : null}
    </div>
  );
}

export type FirstmateAccountChoice = { id: string; label: string; unavailable?: string };

/**
 * The accounts of the provider Firstmate answers with, in the list's order,
 * for the Firstmate account picker. One that cannot run Firstmate stays
 * listed with its row's own word for why - paused, sign in again, not
 * ready - and cannot be picked; anything else the app knows it refuses in
 * words. A choice needs two accounts that can answer (the captain, FI3-215),
 * so with fewer the picker offers nothing.
 */
export function firstmateAccountChoices(
  accounts: readonly AccountView[],
  providerId: string | undefined,
  quotaRowFor: (account: AccountView) => QuotaProviderView | undefined,
  now: number,
): FirstmateAccountChoice[] {
  if (!providerId) return [];
  const choices = accounts
    .filter((account) => account.providerId === providerId)
    .map((account): FirstmateAccountChoice => {
      const view = rowView(account, quotaRowFor(account), now);
      const blocked =
        view.kind === "paused" ||
        view.kind === "auth" ||
        view.kind === "disconnected" ||
        account.detail !== undefined;
      return {
        id: account.id,
        label: account.label,
        ...(blocked ? { unavailable: view.dotLabel } : {}),
      };
    });
  return choices.filter((choice) => choice.unavailable === undefined).length < 2 ? [] : choices;
}

/**
 * Which account Firstmate itself answers on, the dropdown beside its model:
 * the seat's own pin, apart from the account crew work prefers (the row
 * menu's ✱). A pick moves Firstmate at its next idle moment, never
 * mid-answer.
 */
export function FirstmateAccountSelect({
  choices,
  chosen,
  saving,
  onChoose,
}: {
  choices: readonly FirstmateAccountChoice[];
  chosen: string | null;
  saving: boolean;
  onChoose: (accountId: string) => void;
}) {
  const current = choices.some((choice) => choice.id === chosen) ? (chosen as string) : "";
  return (
    <select
      aria-label={m.settingsSubscriptionsFirstmateAccountLabel()}
      value={current}
      disabled={saving}
      onChange={(event) => {
        if (event.target.value) onChoose(event.target.value);
      }}
      style={{ ...FIRSTMATE_SELECT_STYLE, maxWidth: "calc(var(--space-9) * 2)" }}
    >
      {current === "" ? (
        <option value="" disabled>
          {m.settingsSubscriptionsNotChosenYet()}
        </option>
      ) : null}
      {choices.map((choice) => (
        <option key={choice.id} value={choice.id} disabled={choice.unavailable !== undefined}>
          {choice.unavailable ? `${choice.label} · ${choice.unavailable}` : choice.label}
        </option>
      ))}
    </select>
  );
}

/**
 * A mark beside an account's name (✱, firstmate) whose meaning is not
 * written out: a Tab stop of its own that shows its words on rest, the
 * pointer's or the keyboard's focus, and names itself with them
 * (docs/keyboard.md, "Facts shown on rest").
 */
function AccountMark({
  words,
  style,
  children,
  ...data
}: {
  words: string;
  style: React.CSSProperties;
  children: React.ReactNode;
} & Record<`data-${string}`, string>) {
  const rest = useRestLabel(words, { fact: true });
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a fact shown on rest is a stop of its own, so the keyboard reads it as the pointer does
    <span role="img" aria-label={words} tabIndex={0} {...rest} {...data} style={style}>
      {children}
    </span>
  );
}

/**
 * The row's Keep going on credits item (docs/quota.md "Keep going on
 * credits"): offered for a provider that sells credits past its allowance,
 * dim with the reason while the provider says they are off.
 */
export function keepGoingItem(
  account: AccountView,
  quotaRow: QuotaProviderView | undefined,
  onSelect: () => void,
): RowMenuItem {
  const provider = allowanceProviderOf(account.providerId);
  const off = !account.keepGoingOnCredits && quotaRow?.credits?.state === "off";
  return {
    id: "keep-going",
    label: m.settingsSubscriptionsMenuKeepGoing(),
    checked: account.keepGoingOnCredits === true,
    detail: off
      ? provider === "codex"
        ? m.settingsSubscriptionsMenuKeepGoingOffCodex({ site: CREDITS_SITE.codex ?? "" })
        : m.settingsSubscriptionsMenuKeepGoingOffClaude({ site: CREDITS_SITE.claude ?? "" })
      : m.settingsSubscriptionsMenuKeepGoingDetail(),
    ...(off ? { disabled: true } : {}),
    onSelect,
  };
}

/**
 * The row's Use saved resets on their own item (docs/quota.md "Saved resets
 * on their own"): a switch for each Codex account, off until turned on;
 * `off` dims it, saying why, while that computer cannot take it yet.
 */
export function autoResetsItem(
  account: AccountView,
  onSelect: () => void,
  off?: string,
): RowMenuItem {
  return {
    id: "use-saved-resets",
    label: m.settingsSubscriptionsMenuUseResets(),
    checked: account.useSavedResets === true,
    detail: off ?? m.settingsSubscriptionsMenuUseResetsDetail(),
    ...(off ? { disabled: true } : {}),
    onSelect,
  };
}

/**
 * The row's Use a saved reset item (docs/quota.md "Saved resets"): offered
 * while the account's reading says a saved reset would take effect now;
 * `off` dims it, saying why, while that computer cannot take it yet.
 */
export function savedResetItem(
  quotaRow: QuotaProviderView | undefined,
  onSelect: () => void,
  off?: string,
): RowMenuItem | null {
  if (savedResetsNow(quotaRow) === undefined) return null;
  return {
    id: "use-saved-reset",
    label: m.settingsSubscriptionsMenuUseReset(),
    detail: off ?? m.settingsSubscriptionsMenuUseResetDetail(),
    ...(off ? { disabled: true } : {}),
    onSelect,
  };
}

/**
 * One account's own settings and its Rename (never for Claude, which follows
 * its own identity), the same on this Mac and on a computer that runs work:
 * Prefer for crew work and Paused are on/off settings, drawn as switches at
 * the menu's top (design skill RowMenu, "Settings"); Rename is an action.
 * `off` dims each, saying why, while that computer cannot take them yet.
 */
export function accountSettingItems(
  account: AccountView,
  on: {
    onTogglePin: () => void;
    onStartRename: () => void;
    onSetEnabled: (enabled: boolean) => void;
  },
  off?: string,
): { prefer: RowMenuItem; paused: RowMenuItem; rename: RowMenuItem | null } {
  const dim = off ? { detail: off, disabled: true } : {};
  return {
    prefer: {
      id: "prefer",
      label: m.settingsSubscriptionsMenuPrefer(),
      checked: account.pinned,
      trailing: (
        <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)" }}>
          {CREW_PREFERRED_MARK}
        </span>
      ),
      onSelect: on.onTogglePin,
      ...dim,
    },
    paused: {
      id: "pause",
      label: m.settingsMenuPaused(),
      checked: !account.enabled,
      onSelect: () => on.onSetEnabled(!account.enabled),
      ...dim,
    },
    rename:
      account.providerId === CLAUDE_PROVIDER_ID
        ? null
        : {
            id: "rename",
            label: m.settingsSubscriptionsMenuRename(),
            onSelect: on.onStartRename,
            ...dim,
          },
  };
}

/**
 * The account menu's order (design skill RowMenu, "Settings"): its on/off
 * settings first, a line, its actions, a line, and Disconnect last.
 */
export function accountMenu(
  settings: (RowMenuItem | null)[],
  actions: (RowMenuItem | null)[],
  last: RowMenuItem[],
): RowMenuItem[] {
  const present = (items: (RowMenuItem | null)[]) =>
    items.filter((item): item is RowMenuItem => item !== null);
  const groups = [present(settings), present(actions), last].filter((group) => group.length > 0);
  return groups.flatMap((group, index) =>
    index === 0 ? group : [{ separator: true } as const, ...group],
  );
}

export function AccountRow({
  account,
  providerName,
  quotaRow,
  isFlagship,
  hasModels,
  renaming,
  signingIn,
  signInOff,
  refreshing,
  onStartRename,
  onRename,
  onCancelRename,
  onTogglePin,
  onKeepGoing,
  onUseSavedReset,
  onUseSavedResets,
  onSetEnabled,
  onDisconnect,
  onSignIn,
  onRetry,
  onShowModels,
  onResetSlots,
  menu,
  place,
}: {
  account: AccountView;
  providerName: string;
  quotaRow?: QuotaProviderView;
  isFlagship: boolean;
  hasModels: boolean;
  renaming: boolean;
  signingIn: boolean;
  signInOff?: string;
  refreshing: boolean;
  onStartRename: () => void;
  onRename: (label: string) => void;
  onCancelRename: () => void;
  onTogglePin: () => void;
  /** Turns its Keep going on credits switch (docs/quota.md); absent where the row offers none. */
  onKeepGoing?: () => void;
  /** Uses one of its saved resets through Codex (docs/codex-client.md); absent where the row offers none. */
  onUseSavedReset?: () => void;
  /** Turns its Use saved resets on their own switch (docs/quota.md); absent where the row offers none. */
  onUseSavedResets?: () => void;
  onSetEnabled: (enabled: boolean) => void;
  onDisconnect: () => void;
  onSignIn: () => void;
  /**
   * Reads this account's allowance again, asking macOS when it must. Absent
   * for an account on a computer that runs work, which never asks there:
   * the row says why and offers no Retry.
   */
  onRetry?: () => void;
  onShowModels: () => void;
  onResetSlots: () => void;
  /**
   * The row's menu in place of this Mac's own: an account on a computer that
   * runs work offers only what that computer does with it.
   */
  menu?: RowMenuItem[];
  /**
   * The computer that runs work this account is on, by the name its words
   * give "this computer". Absent, the account is the first mate's computer's:
   * this computer where it lives, its name on a computer that controls it.
   */
  place?: string;
}) {
  const [renameValue, setRenameValue] = useState(account.label);
  const [resetArmed, setResetArmed] = useState(false);
  useEffect(() => {
    if (renaming) setRenameValue(account.label);
  }, [renaming, account.label]);
  const here = useHereAs();
  const view = rowView(account, quotaRow, Date.now());
  // Its words say "this computer" of the computer the account is on.
  if (view.stateText)
    view.stateText = place === undefined ? here(view.stateText) : hereAs(view.stateText, place);
  const repeated =
    view.dotLabel === m.settingsSubscriptionsPaused() &&
    view.verdict?.text === m.settingsSubscriptionsPaused()
      ? view.verdict.text
      : view.dotLabel === m.settingsSubscriptionsDotSignInAgain() && view.stateText
        ? view.stateText
        : undefined;
  const repeatedFit = useOverflowTitle(repeated);

  const own = accountSettingItems(account, { onTogglePin, onStartRename, onSetEnabled });
  const items: RowMenuItem[] =
    menu ??
    accountMenu(
      [
        own.prefer,
        onKeepGoing ? keepGoingItem(account, quotaRow, onKeepGoing) : null,
        onUseSavedResets ? autoResetsItem(account, onUseSavedResets) : null,
        own.paused,
      ],
      [
        onUseSavedReset ? savedResetItem(quotaRow, onUseSavedReset) : null,
        own.rename,
        ...(hasModels
          ? [
              {
                id: "models",
                label: m.settingsSubscriptionsMenuModelSlots(),
                onSelect: onShowModels,
              },
              {
                id: "reset-slots",
                label: m.settingsSubscriptionsMenuResetSlots(),
                onSelect: () => setResetArmed(true),
              },
            ]
          : []),
      ],
      [
        {
          id: "disconnect",
          label: m.settingsSubscriptionsMenuDisconnect(),
          tone: "danger",
          onSelect: onDisconnect,
        },
      ],
    );

  return (
    <>
      <div
        className="fm-subs-row"
        data-account-row={account.id}
        data-row-kind={view.kind}
        data-hold={standingCutOff(account, Date.now())?.class}
        data-paused={account.enabled ? undefined : "true"}
      >
        <span className="fm-subs-dot">
          <StatusDot
            tone={view.dot}
            label={view.dotLabel}
            nativeTitle={repeated ? repeatedFit.hidden : true}
            focusable
          />
        </span>
        <span className="fm-subs-prov">{providerName}</span>
        <div className="fm-subs-who">
          {renaming ? (
            // Wraps inside its own column, so a cramped row stacks the
            // buttons under the input instead of overlapping the meters.
            <form
              style={{ display: "flex", gap: 6, flexWrap: "wrap", minWidth: 0 }}
              onSubmit={(event: React.FormEvent) => {
                event.preventDefault();
                onRename(renameValue);
              }}
            >
              <Input
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                placeholder={m.settingsSubscriptionsRenamePlaceholder()}
                maxLength={ACCOUNT_LABEL_MAX}
                autoFocus
                style={{ width: 140 }}
              />
              <Button variant="primary" size="sm" type="submit">
                {m.settingsSubscriptionsRenameSave()}
              </Button>
              <Button variant="ghost" size="sm" onClick={onCancelRename}>
                {m.settingsSubscriptionsRenameCancel()}
              </Button>
            </form>
          ) : (
            <>
              <span className="fm-subs-label">
                <span className="fm-subs-name" data-account-name="">
                  <span className="fm-subs-prov-inline">{providerName} · </span>
                  {account.label}
                </span>
                {account.pinned && (
                  <AccountMark
                    words={SUBSCRIPTIONS_WORDS.crewPreferredMarkTitle}
                    data-crew-preferred=""
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--text-sm)",
                      color: "var(--accent)",
                    }}
                  >
                    {CREW_PREFERRED_MARK}
                  </AccountMark>
                )}
                {isFlagship && (
                  <AccountMark
                    words={SUBSCRIPTIONS_WORDS.firstmateAccountTagTitle}
                    data-firstmate-account=""
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      letterSpacing: "var(--tracking-label)",
                      textTransform: "uppercase",
                      color: "var(--accent)",
                      border: "1px solid var(--line-2)",
                      borderRadius: "var(--radius-s)",
                      padding: "1px 6px",
                      whiteSpace: "nowrap",
                      lineHeight: 1.4,
                    }}
                  >
                    {SUBSCRIPTIONS_WORDS.firstmateAccountTag}
                  </AccountMark>
                )}
              </span>
              <span className="fm-subs-sub">{view.sub}</span>
            </>
          )}
        </div>
        <div className="fm-subs-flow">
          {view.meters.map((meter) => (
            <QuotaMicroMeter
              key={meter.id}
              label={meter.label}
              {...(meter.percent !== undefined ? { percentRemaining: meter.percent } : {})}
              pace={meter.pace}
              {...(meter.resetText ? { resetText: meter.resetText } : {})}
              {...(meter.clock !== undefined ? { clockPercent: meter.clock } : {})}
              stale={view.kind === "stale"}
            />
          ))}
          {view.verdict && (
            <span
              className="fm-subs-verdict"
              data-tone={view.verdict.tone}
              ref={repeated === view.verdict.text ? repeatedFit.ref : undefined}
            >
              {view.verdict.text}
            </span>
          )}
          {view.credits && (
            <span className="fm-subs-credits" data-credits="">
              {view.credits}
            </span>
          )}
          {view.savedResets && (
            <span className="fm-subs-credits" data-saved-resets="">
              {view.savedResets}
            </span>
          )}
          {view.stateText ? (
            <span
              className="fm-subs-state"
              data-tone={view.stateTone}
              ref={repeated === view.stateText ? repeatedFit.ref : undefined}
            >
              {view.stateText}
            </span>
          ) : null}
          {view.signIn && (
            <Button
              variant="secondary"
              size="sm"
              onClick={onSignIn}
              off={Boolean(signInOff)}
              note={signInOff}
              pending={signingIn}
              pendingLabel={m.settingsSubscriptionsConnecting()}
            >
              {view.signInLabel ?? m.settingsSubscriptionsSignIn()}
            </Button>
          )}
          {view.retry && onRetry && (
            <Button
              variant="secondary"
              size="sm"
              onClick={onRetry}
              pending={refreshing}
              pendingLabel={m.settingsSubscriptionsRetrying()}
            >
              {m.settingsSubscriptionsRetry()}
            </Button>
          )}
        </div>
        <span className="fm-subs-menu">
          <RowMenu
            label={m.settingsSubscriptionsRowActions({ account: account.label })}
            items={items}
          />
        </span>
      </div>
      {resetArmed && (
        <div
          className="fm-subs-reset-confirm"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            padding: "8px 18px 12px",
            background: "var(--bg-1)",
          }}
        >
          <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)", flex: 1, minWidth: 0 }}>
            {m.settingsSubscriptionsResetSlotsNote()}
          </span>
          <Button
            variant="danger"
            size="sm"
            onClick={() => {
              onResetSlots();
              setResetArmed(false);
            }}
          >
            {m.settingsSubscriptionsResetSlotsConfirm()}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setResetArmed(false)}>
            {m.settingsSubscriptionsResetSlotsCancel()}
          </Button>
        </div>
      )}
    </>
  );
}

/**
 * Asks the allowance sensor to read now, after a sign-in or an add ended,
 * rather than at its next tick. A refused reading changes nothing: the row
 * keeps what it last read, the attempt already said how it ended, and the
 * sensor's own tick reads again.
 */
function askSensorNow(apply: (snapshot: QuotaSnapshotView | null) => void): void {
  void window.infinitary.quota
    .refresh()
    .then(apply)
    .catch(() => {});
}

/** No accounts read yet, as one value so the list's readers keep their identity. */
const NO_ACCOUNTS: AccountView[] = [];

export function SubscriptionsTab() {
  const place = useFirstMatePlace();
  const [providers, setProviders] = useState<ProviderView[]>([]);
  // The list is the saved state an account's edit returns to when refused.
  const accountsSave = useSettingSave(() => window.infinitary.accounts.list());
  const accounts = accountsSave.value ?? NO_ACCOUNTS;
  // Which account the last edit was, so a refusal is told under its row.
  const [editedAccountId, setEditedAccountId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<QuotaSnapshotView | null>(null);
  const slotSave = useSettingSave(() => window.infinitary.models.slots());
  const decisionSave = useSettingSave(() => window.infinitary.models.decisions());
  const personalSave = useSettingSave(() => window.infinitary.settings.getPersonalResources());
  const routingSave = useSettingSave(() => window.infinitary.settings.getRouting());
  const slots = slotSave.value;
  const decisions = decisionSave.value;
  const routing = routingSave.value;
  // Firstmate's own seat: its account (beside the row menu's crew ✱) and the
  // model whose provider that account must belong to.
  const accountSave = useSettingSave(() => window.infinitary.settings.getFirstmateAccount());
  const flagshipAccountId = accountSave.value;
  const [seatModel, setSeatModel] = useState<PiModelRefView | null>(null);
  const [busyProvider, setBusyProvider] = useState<string | null>(null);
  const [busyAccount, setBusyAccount] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<AuthPromptView | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const [notices, setNotices] = useState<Record<string, AuthNotice>>({});
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [modelsOpen, setModelsOpen] = useState(true);
  const [modelsFocus, setModelsFocus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // How a sign-in ended when it did not end signed in: its words, or a code
  // that expired, beside the step it belongs to - the row signing in again,
  // or the "Add account" foot (INF-838). The person's own Cancel says nothing.
  const [signInEnded, setSignInEnded] = useState<{
    anchor: { accountId: string } | { foot: string };
    expired: boolean;
    text: string;
  } | null>(null);
  const cancelled = useRef(false);
  const restart = useRef<{ provider: ProviderView; host: string | undefined } | null>(null);
  const [enterpriseHost, setEnterpriseHost] = useState<string | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const refreshInFlight = useRef(false);
  // A computer that runs work signs in on its own; once one is listed,
  // this Mac's accounts sit under their own label.
  const [grouped, setGrouped] = useState(false);

  const refresh = useCallback(() => {
    void window.infinitary.auth
      .providers()
      .then(setProviders)
      .catch(() => {});
    void accountsSave.refresh();
    void accountSave.refresh();
    void window.infinitary.settings
      .getFirstmateModel()
      .then(setSeatModel)
      .catch(() => {});
    // The shortlist follows the routing pool, which moves when an account
    // attaches or the live catalog refreshes.
    void slotSave.refresh();
    // The Decisions group polls with the rest: a native model's row can
    // turn to `key rejected` from a background classification, and the row
    // is the only place that state is shown.
    void decisionSave.refresh();
  }, [accountsSave.refresh, accountSave.refresh, slotSave.refresh, decisionSave.refresh]);

  useEffect(() => {
    refresh();
    void window.infinitary.quota.snapshot().then(setSnapshot);
    void routingSave.refresh();
    void personalSave.refresh();
    // Status dots poll while the tab is open.
    const interval = setInterval(refresh, 10_000);
    const offSnapshot = window.infinitary.quota.onSnapshot((incoming) => {
      setSnapshot(incoming);
      // The same reading can discover a changed Claude login and row label.
      void accountsSave.refresh();
      void slotSave.refresh();
    });
    const offPrompt = window.infinitary.auth.onPrompt((incoming) => {
      setPrompt(incoming);
      setPromptValue("");
    });
    const offNotice = window.infinitary.auth.onNotice((notice) => {
      setNotices((current) => ({ ...current, [notice.providerId]: notice }));
    });
    // A Firstmate model change takes an account of its provider with it.
    const offModels = window.infinitary.models.onChanged(refresh);
    return () => {
      clearInterval(interval);
      offSnapshot();
      offPrompt();
      offNotice();
      offModels();
    };
  }, [refresh, routingSave.refresh, slotSave.refresh, personalSave.refresh, accountsSave.refresh]);

  const saveRouting = (next: RoutingSettings) => {
    void routingSave.save(() => window.infinitary.settings.setRouting(next));
  };

  const clearAuthFlow = useCallback((providerId: string) => {
    setPrompt(null);
    setNotices((current) => {
      const next = { ...current };
      delete next[providerId];
      return next;
    });
  }, []);

  // A provider that signs in either way asks which first (the same choice
  // the first-launch gate offers); one way goes at once.
  const [methodChoice, setMethodChoice] = useState<ProviderView | null>(null);
  const addAccount = (provider: ProviderView) => {
    const methods = connectMethods(provider);
    setSignInEnded(null);
    if (methods.length > 1) {
      setMethodChoice(provider);
      return;
    }
    startAdd(provider, methods[0] ?? "api_key");
  };
  // Reads only a ref and setters, so it never changes.
  const ended = useCallback(
    (anchor: { accountId: string } | { foot: string }, providerId: string, caught: unknown) => {
      const end = signInEnd({
        cancelled: cancelled.current,
        notice: lastSignInNotice(providerId),
        now: Date.now(),
      });
      if (end === "cancelled") return;
      setSignInEnded({
        anchor,
        expired: end === "expired",
        text: caught instanceof Error ? caught.message : String(caught),
      });
    },
    [],
  );
  const startAdd = (provider: ProviderView, type: "oauth" | "api_key", host?: string) => {
    setMethodChoice(null);
    setBusyProvider(provider.id);
    setSignInEnded(null);
    setEnterpriseHost(host);
    cancelled.current = false;
    void runAccountAdd(provider.id, () =>
      window.infinitary.accounts.add(
        provider.id,
        type,
        host ? { enterpriseHost: host } : undefined,
      ),
    )
      .then((added) => {
        // The sign-in finished in the browser: the window comes forward.
        void window.infinitary.app.controlWindow("front").catch(() => {});
        // Invite a rename right away ("Personal", "Work #2" are editable),
        // unless the sign-in named the account itself.
        if (!added.identity) setRenamingId(added.id);
      })
      .catch((caught) => ended({ foot: provider.id }, provider.id, caught))
      .finally(() => {
        setBusyProvider(null);
        clearAuthFlow(provider.id);
        refresh();
        // Same as signIn: ask the sensor now rather than wait for the tick,
        // so a sensed row leaves "reading…" once the first pass lands.
        askSensorNow(setSnapshot);
        const next = restart.current;
        restart.current = null;
        if (next) startAdd(next.provider, "oauth", next.host);
      });
  };
  const cancelSignIn = () => {
    cancelled.current = true;
    void window.infinitary.auth.cancel().catch(() => {});
  };

  // Leaving this tab used to drop the busy flag while the sign-in kept
  // running. Coming back joins that sign-in instead of starting another.
  useEffect(() => {
    let sawFlight = false;
    const apply = () => {
      const snap = signInFlightSnapshot();
      if (snap.providerId) {
        sawFlight = true;
        setBusyProvider(snap.providerId);
        const notice = snap.notice;
        if (notice) {
          setNotices((current) => ({ ...current, [notice.providerId]: notice }));
        }
        if (snap.prompt) setPrompt(snap.prompt);
        return;
      }
      if (!sawFlight) return;
      sawFlight = false;
      setBusyProvider(null);
      setPrompt(null);
      setNotices({});
    };
    apply();
    return subscribeSignInFlight(apply);
  }, []);

  const signIn = useCallback(
    (account: AccountView) => {
      setBusyAccount(account.id);
      setSignInEnded(null);
      cancelled.current = false;
      forgetSignInNotice(account.providerId);
      void window.infinitary.accounts
        .signIn(account.id)
        .then(() => {
          void window.infinitary.app.controlWindow("front").catch(() => {});
        })
        .catch((caught) => ended({ accountId: account.id }, account.providerId, caught))
        .finally(() => {
          setBusyAccount(null);
          clearAuthFlow(account.providerId);
          refresh();
          // The sensor's verdict on the old credential stands until it reads
          // the new one; ask now rather than at the next tick.
          askSensorNow(setSnapshot);
        });
    },
    [refresh, clearAuthFlow, ended],
  );

  /**
   * Uses one saved reset of this Mac's own account (docs/codex-client.md):
   * Codex signs in on the row first when it must, through the same link
   * and paste-back a sign-in shows; a refusal stays under the row, and the
   * feed says what it came to.
   */
  const applySavedReset = useCallback(
    (account: AccountView) => {
      setBusyAccount(account.id);
      setSignInEnded(null);
      cancelled.current = false;
      forgetSignInNotice(account.providerId);
      void window.infinitary.accounts
        .redeemSavedReset(account.id, { signIn: true })
        .catch((caught) => ended({ accountId: account.id }, account.providerId, caught))
        .finally(() => {
          setBusyAccount(null);
          clearAuthFlow(account.providerId);
          askSensorNow(setSnapshot);
        });
    },
    [clearAuthFlow, ended],
  );

  /**
   * Turns this Mac's own account's Use saved resets on their own on or off
   * (docs/quota.md). Turning it on lets Codex sign in on the row first when
   * it must, as a saved reset's use does; a refusal stays under the row.
   */
  const toggleAutoResets = useCallback(
    (account: AccountView) => {
      if (account.useSavedResets) {
        void window.infinitary.accounts
          .setUseSavedResets(account.id, false)
          .catch((caught) => ended({ accountId: account.id }, account.providerId, caught))
          .finally(() => void refresh());
        return;
      }
      setBusyAccount(account.id);
      setSignInEnded(null);
      cancelled.current = false;
      forgetSignInNotice(account.providerId);
      void window.infinitary.accounts
        .setUseSavedResets(account.id, true, { signIn: true })
        .catch((caught) => ended({ accountId: account.id }, account.providerId, caught))
        .finally(() => {
          setBusyAccount(null);
          clearAuthFlow(account.providerId);
          void refresh();
        });
    },
    [clearAuthFlow, ended, refresh],
  );

  // A run-out card's Use saved resets on their own lands here with this Mac's account.
  const pendingUseSavedResets = useShellStore((s) => s.pendingUseSavedResets);
  useEffect(() => {
    if (!pendingUseSavedResets || pendingUseSavedResets.includes("@")) return;
    const account = accounts.find((row) => row.id === pendingUseSavedResets);
    if (!account) return;
    useShellStore.getState().clearPendingUseSavedResets();
    if (!account.useSavedResets) toggleAutoResets(account);
  }, [pendingUseSavedResets, accounts, toggleAutoResets]);

  // A card's Use a saved reset lands here with this Mac's account to use.
  const pendingUseSavedReset = useShellStore((s) => s.pendingUseSavedReset);
  useEffect(() => {
    if (!pendingUseSavedReset || pendingUseSavedReset.includes("@")) return;
    const account = accounts.find((row) => row.id === pendingUseSavedReset);
    if (!account) return;
    useShellStore.getState().clearPendingUseSavedReset();
    applySavedReset(account);
  }, [pendingUseSavedReset, accounts, applySavedReset]);

  const pendingRestoreAccountId = useShellStore((s) => s.pendingRestoreAccountId);
  useEffect(() => {
    if (!pendingRestoreAccountId) return;
    const account = accounts.find((row) => row.id === pendingRestoreAccountId);
    if (!account) return;
    useShellStore.getState().clearPendingRestore();
    signIn(account);
  }, [pendingRestoreAccountId, accounts, signIn]);

  /**
   * One edit of an account, then the list as saved: a refused edit says why
   * under the account's row, and the row shows what is saved.
   */
  const editAccount = (accountId: string, edit: () => Promise<unknown>) => {
    setEditedAccountId(accountId);
    return accountsSave
      .save(async () => {
        await edit();
        return window.infinitary.accounts.list();
      })
      .then(refresh);
  };

  const disconnect = (account: AccountView) => {
    void editAccount(account.id, () => window.infinitary.accounts.remove(account.id));
  };

  const chooseFirstmateAccount = (accountId: string) => {
    void accountSave.save(() => window.infinitary.settings.setFirstmateAccount(accountId));
  };

  const togglePin = (account: AccountView) => {
    void editAccount(account.id, () =>
      window.infinitary.accounts.pin(account.providerId, account.pinned ? null : account.id),
    );
  };

  const keepGoing = (account: AccountView) => {
    void editAccount(account.id, () =>
      window.infinitary.accounts.keepGoing(account.id, !account.keepGoingOnCredits),
    );
  };

  const setEnabled = (account: AccountView, enabled: boolean) => {
    void editAccount(account.id, () => window.infinitary.accounts.setEnabled(account.id, enabled));
  };

  const rename = (accountId: string, label: string) => {
    const trimmed = label.trim();
    if (!trimmed) {
      setRenamingId(null);
      return;
    }
    void editAccount(accountId, () => window.infinitary.accounts.rename(accountId, trimmed)).then(
      () => setRenamingId(null),
    );
  };

  // A change to a computer that runs work's own account: a refusal (out of
  // reach, not updated) is said above the list, since its rows are that
  // computer's word, not this Mac's saved state.
  const thereSaid = (change: Promise<unknown>) =>
    change.then(
      () => setError(null),
      (caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)),
    );

  const answerPrompt = (value: string | null) => {
    if (!prompt) return;
    if (value === null) cancelled.current = true;
    void window.infinitary.auth.replyPrompt(prompt.promptId, value);
    answeredSignInPrompt(prompt.promptId);
    setPrompt(null);
  };

  const recheckKeys = useCommandKeys("allowance.recheck");
  const refreshQuota = () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    setError(null);
    void window.infinitary.quota
      .refresh()
      .then((next) => {
        setSnapshot(next);
        return slotSave.refresh(true);
      })
      .catch((caught) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        refreshInFlight.current = false;
        setRefreshing(false);
      });
  };

  const providerOrder = new Map(providers.map((provider, index) => [provider.id, index]));
  const providerName = (id: string) =>
    providers.find((provider) => provider.id === id)?.name ?? catalogEntry(id)?.name ?? id;
  const ordered = [...accounts].sort(
    (a, b) =>
      (providerOrder.get(a.providerId) ?? Number.MAX_SAFE_INTEGER) -
        (providerOrder.get(b.providerId) ?? Number.MAX_SAFE_INTEGER) || a.createdAt - b.createdAt,
  );
  const quotaRowFor = (account: AccountView): QuotaProviderView | undefined =>
    snapshot?.providers.find((row) => row.accountId === account.id);
  const seatProvider =
    seatModel?.provider ?? ordered.find((account) => account.id === flagshipAccountId)?.providerId;
  const firstmateChoices = firstmateAccountChoices(ordered, seatProvider, quotaRowFor, Date.now());
  const hasModels = (providerId: string) =>
    slots?.models.some((model) => model.provider === providerId) ?? false;
  // A sign-in's notice and prompt each land under whatever started them: the
  // existing row signing in again, or the "Add account" foot when the account
  // is not listed yet (its id is minted before the row exists).
  const listed = (accountId: string | undefined) =>
    accountId !== undefined && accounts.some((account) => account.id === accountId);
  const asideFor = (anchor: { accountId: string } | { foot: string }) => {
    const wanted = (id: string | undefined) =>
      "accountId" in anchor ? id === anchor.accountId : !listed(id);
    const notice = Object.values(notices).find(
      (entry) =>
        ("foot" in anchor ? entry.providerId === anchor.foot : true) && wanted(entry.accountId),
    );
    const anchoredPrompt =
      prompt &&
      ("foot" in anchor ? prompt.providerId === anchor.foot : true) &&
      wanted(prompt.accountId)
        ? prompt
        : undefined;
    const endedHere =
      signInEnded &&
      ("accountId" in anchor
        ? "accountId" in signInEnded.anchor && signInEnded.anchor.accountId === anchor.accountId
        : "foot" in signInEnded.anchor && signInEnded.anchor.foot === anchor.foot)
        ? signInEnded
        : null;
    if (!notice && !anchoredPrompt) {
      if (!endedHere) return null;
      const retry = () => {
        if ("accountId" in anchor) {
          const account = accounts.find((row) => row.id === anchor.accountId);
          if (account) signIn(account);
          return;
        }
        const provider = providers.find((entry) => entry.id === anchor.foot);
        if (provider) startAdd(provider, "oauth", enterpriseHost);
      };
      return endedHere.expired ? (
        <CodeExpired
          providerId={
            "accountId" in anchor
              ? (accounts.find((row) => row.id === anchor.accountId)?.providerId ?? "")
              : anchor.foot
          }
          onNewCode={retry}
          onClose={() => setSignInEnded(null)}
        />
      ) : (
        <div className="fm-connect-aside">
          <p role="alert" className="fm-code-step-error" data-settings-error="sign-in">
            {endedHere.text}
          </p>
        </div>
      );
    }
    const provider = "foot" in anchor ? providers.find((entry) => entry.id === anchor.foot) : null;
    return (
      <AuthAside
        {...(notice ? { notice } : {})}
        {...(anchoredPrompt ? { prompt: anchoredPrompt } : {})}
        promptValue={promptValue}
        onPromptValue={setPromptValue}
        onAnswerPrompt={answerPrompt}
        onCancel={cancelSignIn}
        {...(provider && catalogEntry(provider.id)?.codeSignIn?.enterprise
          ? {
              enterprise: {
                ...(enterpriseHost ? { host: enterpriseHost } : {}),
                onUse: (host: string | null) => {
                  restart.current = { provider, host: host ?? undefined };
                  cancelSignIn();
                },
              },
            }
          : {})}
      />
    );
  };

  return (
    <div data-subscriptions>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--space-4)",
          marginBottom: ROW_GAP,
        }}
      >
        <div style={LABEL_STYLE}>{m.settingsSubscriptionsHeading()}</div>
        {snapshot && snapshot.providers.length > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexShrink: 0,
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--fg-3)",
              whiteSpace: "nowrap",
            }}
          >
            <span>{m.settingsSubscriptionsAsOfTime({ time: clockOf(snapshot.fetchedAt) })}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={refreshQuota}
              {...recheckKeys}
              pending={refreshing}
              pendingLabel={m.settingsSubscriptionsRefreshing()}
            >
              {m.settingsSubscriptionsRefresh()}
            </Button>
          </div>
        )}
      </div>
      {grouped && (
        <div style={{ ...LABEL_STYLE, marginBottom: ROW_GAP }} data-sign-ins-group="this-mac">
          {place.This}
        </div>
      )}
      <div
        data-subscriptions-list
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--line-1)",
          borderRadius: "var(--radius-m)",
          overflow: "hidden",
        }}
      >
        {ordered
          .filter((account) => !isCustomApiProvider(account.providerId))
          .map((account) => {
            const row = quotaRowFor(account);
            return (
              <div key={account.id}>
                <AccountRow
                  account={account}
                  providerName={providerName(account.providerId)}
                  {...(row ? { quotaRow: row } : {})}
                  isFlagship={flagshipAccountId === account.id}
                  hasModels={hasModels(account.providerId)}
                  renaming={renamingId === account.id}
                  signingIn={busyAccount === account.id}
                  refreshing={refreshing}
                  onStartRename={() => setRenamingId(account.id)}
                  onRename={(label) => rename(account.id, label)}
                  onCancelRename={() => setRenamingId(null)}
                  onTogglePin={() => togglePin(account)}
                  {...(offersKeepGoing(account) ? { onKeepGoing: () => keepGoing(account) } : {})}
                  onUseSavedReset={() => applySavedReset(account)}
                  {...(allowanceProviderOf(account.providerId) === "codex"
                    ? { onUseSavedResets: () => toggleAutoResets(account) }
                    : {})}
                  onSetEnabled={(enabled) => setEnabled(account, enabled)}
                  onDisconnect={() => disconnect(account)}
                  onSignIn={() => signIn(account)}
                  onRetry={refreshQuota}
                  onShowModels={() => {
                    setModelsOpen(true);
                    setModelsFocus(account.id);
                  }}
                  onResetSlots={() => {
                    void slotSave.save(() =>
                      window.infinitary.models.resetSlots(account.providerId),
                    );
                  }}
                />
                {editedAccountId === account.id && accountsSave.error ? (
                  <div className="fm-connect-aside" data-account-error={account.id}>
                    <SettingError error={accountsSave.error} />
                  </div>
                ) : null}
                {asideFor({ accountId: account.id })}
              </div>
            );
          })}
        <div className="fm-subs-add">
          <span style={LABEL_STYLE}>{m.settingsSubscriptionsAddAccount()}</span>
          <ProviderChips
            providers={providers}
            accounts={accounts}
            busyProviderId={busyProvider}
            onConnect={addAccount}
            variant="foot"
          />
        </div>
        {methodChoice && (
          <AuthMethodChoice
            provider={methodChoice}
            onPick={(type) => startAdd(methodChoice, type)}
            onCancel={() => setMethodChoice(null)}
          />
        )}
        {providers.map((provider) => (
          <div key={provider.id}>{asideFor({ foot: provider.id })}</div>
        ))}
      </div>
      <DeviceSignInGroups
        providerName={providerName}
        onGroups={setGrouped}
        renderRow={(row) => (
          <AccountRow
            account={row.account}
            providerName={row.providerName}
            {...(row.quotaRow ? { quotaRow: row.quotaRow } : {})}
            isFlagship={false}
            hasModels={false}
            renaming={renamingId === row.account.id}
            signingIn={row.signingIn}
            signInOff={row.signInOff}
            refreshing={refreshing}
            onStartRename={() => setRenamingId(row.account.id)}
            onRename={(label) => {
              const trimmed = label.trim();
              if (!trimmed) {
                setRenamingId(null);
                return;
              }
              void thereSaid(row.settings.rename(trimmed)).then(() => setRenamingId(null));
            }}
            onCancelRename={() => setRenamingId(null)}
            onTogglePin={() => void thereSaid(row.settings.togglePin())}
            onSetEnabled={(enabled) => void thereSaid(row.settings.setEnabled(enabled))}
            onDisconnect={() => {}}
            onSignIn={row.onSignIn}
            onShowModels={() => {}}
            onResetSlots={() => {}}
            menu={(() => {
              const own = accountSettingItems(
                row.account,
                {
                  onTogglePin: () => void thereSaid(row.settings.togglePin()),
                  onStartRename: () => setRenamingId(row.account.id),
                  onSetEnabled: (enabled) => void thereSaid(row.settings.setEnabled(enabled)),
                },
                row.settings.updateNote,
              );
              return accountMenu(
                [
                  own.prefer,
                  row.keepGoing
                    ? {
                        ...keepGoingItem(row.account, row.quotaRow, row.keepGoing.onSelect),
                        ...(row.keepGoing.updateNote
                          ? { detail: row.keepGoing.updateNote, disabled: true }
                          : {}),
                      }
                    : null,
                  row.autoResets
                    ? autoResetsItem(
                        row.account,
                        row.autoResets.onSelect,
                        row.autoResets.updateNote,
                      )
                    : null,
                  own.paused,
                ],
                [
                  row.savedReset
                    ? savedResetItem(
                        row.quotaRow,
                        row.savedReset.onSelect,
                        row.savedReset.updateNote,
                      )
                    : null,
                  own.rename,
                ],
                row.menu,
              );
            })()}
            place={row.place}
          />
        )}
      />
      <CustomApiAccountsSection />
      <IntelligenceBoard
        firstmateModel={
          <FirstmateModelRow
            {...(seatProvider && firstmateChoices.length > 0
              ? {
                  account: {
                    providerName: providerName(seatProvider),
                    error: accountSave.error,
                    select: (
                      <FirstmateAccountSelect
                        choices={firstmateChoices}
                        chosen={flagshipAccountId}
                        saving={accountSave.saving}
                        onChoose={chooseFirstmateAccount}
                      />
                    ),
                  },
                }
              : {})}
          />
        }
        models={
          // Whenever any model can be placed, a custom API's alone included.
          routing?.dormantPins?.length ||
          (snapshot && snapshot.providers.length > 0) ||
          (slots && slots.models.length + slots.byName.length > 0) ? (
            <ModelsSection
              saving={slotSave.saving || decisionSave.saving || routingSave.saving}
              slots={slots}
              routing={routing}
              decisions={decisions}
              open={modelsOpen}
              onToggle={() => setModelsOpen((open) => !open)}
              focusAccountId={modelsFocus}
              onFocused={() => setModelsFocus(null)}
              onSaveRouting={saveRouting}
              routingError={routingSave.error}
              onSetSlotMembership={(key, slot, on) =>
                slotSave.save(() => window.infinitary.models.setSlotMembership(key, slot, on))
              }
              onSetSpeed={(key, speed) =>
                slotSave.save(() => window.infinitary.models.setSpeed(key, speed))
              }
              onSetReasoning={(key, slot, level) =>
                slotSave.save(() => window.infinitary.models.setReasoning(key, slot, level))
              }
              onResetSlots={() => {
                void slotSave.save(() => window.infinitary.models.resetSlots());
              }}
              onSetDecisions={(next) => {
                void decisionSave.save(() => window.infinitary.models.setDecisions(next));
              }}
              onSetDecisionKey={(id, key) =>
                decisionSave.save(() => window.infinitary.models.setDecisionKey(id, key))
              }
              onRemoveDecisionKey={(id) => {
                void decisionSave.save(() => window.infinitary.models.removeDecisionKey(id));
              }}
              onSetDecisionUse={(request) => {
                void decisionSave.save(() => window.infinitary.models.setDecisionUse(request));
              }}
            />
          ) : null
        }
        additionalSettings={
          <>
            <CostLimitRow />
            <UsageConnectionRow />
            <SettingRow
              id="personal-resources"
              error={personalSave.error}
              title={PERSONAL_RESOURCES_WORDS.title}
              description={PERSONAL_RESOURCES_WORDS.description}
              control={
                <Switch
                  aria-label={PERSONAL_RESOURCES_WORDS.title}
                  checked={personalSave.value ?? false}
                  disabled={personalSave.value === null || personalSave.saving}
                  onChange={(enabled) =>
                    void personalSave.save(() =>
                      window.infinitary.settings.setPersonalResources(enabled),
                    )
                  }
                />
              }
            />
          </>
        }
      />
      {editedAccountId !== null && accountsSave.error && !listed(editedAccountId) ? (
        // A disconnect that went through before failing has no row to stand under.
        <SettingError error={accountsSave.error} surface="accounts" />
      ) : null}
      <SettingError error={slotSave.error} surface="model-slots" />
      <SettingError error={decisionSave.error} surface="decisions" />
      {error && (
        <div
          role="alert"
          data-settings-error="subscriptions"
          style={{ marginTop: 12, fontSize: "var(--text-sm)", color: "var(--danger)" }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
