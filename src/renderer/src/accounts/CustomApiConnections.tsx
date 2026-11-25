import { CUSTOM_READS_PICTURES, CUSTOM_TOKEN_FAILURE, type CustomApiView } from "@shared/customApi";
import { useCallback, useEffect, useRef, useState } from "react";
import { useShellStore } from "../app/store";
import { Badge, Button, QuotaMicroMeter, StatusDot } from "../design";
import { CUSTOM_EXCEPTION_WORDS } from "./customApiFailures";
import "./customApi.css";
import {
  type CustomApiFileView,
  type CustomFileDefinition,
  customHomeDefinition,
} from "@shared/customApiFile";
import { HERE } from "@shared/deviceNames";
import * as m from "@shared/i18n/messages.generated";
import {
  POOL_CREDITS_PROVIDER,
  QUOTA_POOL_NAMES,
  type QuotaProviderView,
  type QuotaSnapshotView,
} from "@shared/quota";
import { windowSignals } from "@shared/quotaSignals";
import { type DeviceSignIns, signInPlace } from "@shared/signIns";
import { useFirstMatePlace } from "../devices/useFirstMatePlace";
import {
  creditsLine,
  EMPTY_QUOTA_TEXT,
  poolLine,
  poolUsageLabel,
} from "../settings/subscriptionsWords";
import { useDeviceSignIns } from "../settings/useDeviceSignIns";
import { CustomApiFileRow, FileApproval, FileConnectionRow, FileWarnings } from "./CustomApiFile";
import { type FirstmateModel, FirstmateRadio } from "./CustomApiFirstmate";
import {
  type CustomApiClient,
  CustomApiDialog,
  CustomApiForm,
  deviceCustomClient,
} from "./CustomApiForm";

/**
 * What each of the first mate's computer's own connections says now, by its
 * account id there, as a computer that runs work follows it. Read only while
 * `active`, such as while a computer has a connection approved from one of them.
 */
export function useHomeCustomDefinitions(active: boolean): Map<string, CustomFileDefinition> {
  const [definitions, setDefinitions] = useState(new Map<string, CustomFileDefinition>());
  useEffect(() => {
    if (!active) return;
    let live = true;
    const read = () =>
      void Promise.all([
        window.infinitary.accounts.custom.list(),
        window.infinitary.accounts.custom.file().catch(() => undefined),
      ])
        .then(([views, file]) => {
          if (!live) return;
          const next = new Map<string, CustomFileDefinition>();
          for (const view of views) {
            const definition = customHomeDefinition(view, file);
            if (view.accountId && definition) next.set(view.accountId, definition);
          }
          setDefinitions(next);
        })
        .catch(() => {});
    read();
    const timer = setInterval(read, 3000);
    const off = window.infinitary.models.onChanged(read);
    return () => {
      live = false;
      clearInterval(timer);
      off();
    };
  }, [active]);
  return definitions;
}

/**
 * One connection saved on a computer that runs work: status, Edit, Pause or
 * Resume, and Disconnect. No Firstmate choice — that model stays on this Mac.
 */
export function RemoteCustomConnection({
  view,
  homeDefinition,
  replaced = false,
  client,
  place,
  onDisconnect,
  onSetEnabled,
  pauseOff,
}: {
  view: CustomApiView;
  /** What the first mate's computer's connection it was approved from says now. */
  homeDefinition?: CustomFileDefinition;
  /** Approved again there as a new connection, the same home connection already runs; this one only waits to be disconnected. */
  replaced?: boolean;
  client: CustomApiClient;
  place: { who: string; on: string };
  onDisconnect: (accountId: string) => void;
  /** Pauses or resumes it, saved on that computer. */
  onSetEnabled: (accountId: string, enabled: boolean) => void;
  /** Why Pause is off while that computer's Infinitary cannot take it yet. */
  pauseOff?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [armed, setArmed] = useState(false);
  const home = useFirstMatePlace();
  const accountId = view.accountId ?? "";
  const checked = view.models.length > 0 && view.models.every((model) => model.checked);
  // A change at the home to its address, protocol or headers holds it there until approved again.
  const held = Boolean(view.home && view.home.state !== "current");
  const ready = view.enabled && checked && !held;
  return (
    <section className="fm-custom-conn" data-custom-account={accountId}>
      <div className="fm-custom-conn-head">
        <h3>{view.label}</h3>
        <span className="fm-custom-mono fm-custom-address">{view.baseUrl}</span>
        {view.baseUrl.startsWith("http:") && (
          <span className="fm-custom-tag" data-tone="warn">
            {m.accountsCustomApiUnencrypted()}
          </span>
        )}
        {view.home && (
          <span className="fm-custom-tag" data-custom-home-tag>
            {m.accountsCustomApiHomeTag({ home: home.this })}
          </span>
        )}
        <span
          className="fm-custom-tag"
          data-tone={view.tokenCommandFailed ? "danger" : ready ? "ok" : "idle"}
        >
          {view.tokenCommandFailed
            ? CUSTOM_TOKEN_FAILURE.status
            : ready
              ? m.accountsCustomApiStatusReady()
              : view.enabled && !held
                ? m.accountsCustomApiStatusNotChecked()
                : checked
                  ? m.accountsCustomApiStatusPaused()
                  : m.accountsCustomApiStatusPausedNotChecked()}
        </span>
        <span className="fm-custom-acts">
          {replaced ? null : view.home?.state === "changed" && homeDefinition ? (
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
              {m.accountsCustomApiFileApproveAgain()}
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              {m.accountsCustomApiEdit()}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            off={Boolean(pauseOff) || (!view.enabled && !checked)}
            note={
              pauseOff ??
              (!view.enabled && !checked ? m.accountsCustomApiResumeNeedsCheck() : undefined)
            }
            onClick={() => onSetEnabled(accountId, !view.enabled)}
          >
            {view.enabled ? m.accountsCustomApiPause() : m.accountsCustomApiResume()}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setArmed(true)}>
            {m.accountsCustomApiDisconnect()}
          </Button>
        </span>
      </div>
      {view.tokenCommandFailed && (
        <p role="alert" className="fm-custom-field-error">
          {CUSTOM_TOKEN_FAILURE.row}
        </p>
      )}
      <div className="fm-custom-lrow fm-custom-lcols" aria-hidden="true">
        <span>{m.accountsCustomApiColumnModel()}</span>
        <span>{m.accountsCustomApiColumnStatus()}</span>
      </div>
      {view.models.map((model) => (
        <div className="fm-custom-lrow" key={model.id} data-custom-model={model.id}>
          <span className="fm-custom-mono fm-custom-model-id">{model.id}</span>
          <span className="fm-custom-status">
            <StatusDot
              tone={model.checked ? (view.enabled && !held ? "ok" : "idle") : "ring"}
              label={
                model.checked
                  ? view.enabled && !held
                    ? m.accountsCustomApiStatusReady()
                    : m.accountsCustomApiStatusChecked()
                  : m.accountsCustomApiStatusNotChecked()
              }
              nativeTitle={false}
            />
            {model.checked
              ? view.enabled && !held
                ? m.accountsCustomApiStatusReady()
                : m.accountsCustomApiStatusChecked()
              : m.accountsCustomApiStatusNotChecked()}
            {model.readsPictures && <Badge tone="accent">{CUSTOM_READS_PICTURES}</Badge>}
          </span>
        </div>
      ))}
      {view.home?.state === "changed" && (
        <p className="fm-custom-lock" data-custom-home-held>
          {replaced
            ? m.accountsCustomApiHomeReplaced({ home: home.this, who: place.who })
            : m.accountsCustomApiHomeChanged({ home: home.this, who: place.who })}
        </p>
      )}
      {view.home?.state === "missing" && (
        <p className="fm-custom-lock" data-custom-home-held>
          {m.accountsCustomApiHomeGone({ home: home.this, who: place.who })}
        </p>
      )}
      <p className="fm-custom-lock">{m.accountsCustomApiCrewUseRemote({ who: place.who })}</p>
      {armed && (
        <div className="fm-custom-disconnect">
          <p>{m.accountsCustomApiDisconnectRemote({ who: place.who, here: HERE.This })}</p>
          <div className="fm-custom-acts">
            <Button variant="secondary" size="sm" onClick={() => onDisconnect(accountId)}>
              {m.accountsCustomApiDisconnect()}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setArmed(false)}>
              {m.accountsCustomApiKeepConnection()}
            </Button>
          </div>
        </div>
      )}
      {editing && (
        <CustomApiDialog
          label={m.accountsCustomApiEditTitle({ name: view.label })}
          onClose={() => setEditing(false)}
        >
          <CustomApiForm
            original={view}
            {...(view.home && homeDefinition
              ? { fromHome: { name: view.home.name, definition: homeDefinition } }
              : {})}
            client={client}
            place={place}
            onClose={() => setEditing(false)}
          />
        </CustomApiDialog>
      )}
    </section>
  );
}

/** The Settings list: one block per connection, one line per model. */

/**
 * A connection to a CLI proxy's pools (docs/quota.md, "A proxy's pooled
 * logins"): one line per pool its models are served from, with that pool's
 * meters and how its logins stand, as an account row in Settings shows them.
 */
function PooledUsage({ rows, now }: { rows: readonly QuotaProviderView[]; now: number }) {
  if (rows.length === 0) return null;
  return (
    <div className="fm-custom-pools" data-custom-pools="">
      {rows.map((row) => (
        <div
          className="fm-subs-flow fm-custom-pool"
          key={row.pool?.kind ?? "unread"}
          data-custom-pool={row.pool?.kind ?? ""}
        >
          <span className="fm-custom-pool-name">
            {row.pool ? QUOTA_POOL_NAMES[row.pool.kind] : poolUsageLabel()}
          </span>
          {row.windows.map((window) => {
            const signals = windowSignals(window, now);
            return (
              <QuotaMicroMeter
                key={window.id}
                label={window.label}
                {...(window.percentRemaining !== undefined
                  ? { percentRemaining: window.percentRemaining }
                  : {})}
                pace={window.pace ?? "unknown"}
                {...(window.resetText ? { resetText: window.resetText } : {})}
                {...(signals.kind === "measured"
                  ? { clockPercent: signals.timeRemainingPercent }
                  : {})}
                stale={row.stale}
              />
            );
          })}
          {row.pool ? (
            <span className="fm-subs-credits" data-pool="">
              {poolLine(row.pool, now)}
            </span>
          ) : (
            <span className="fm-subs-state">{EMPTY_QUOTA_TEXT.unread}</span>
          )}
          {row.pool && <PoolCredits row={row} />}
        </div>
      ))}
    </div>
  );
}

/** A pool's credits, in its vendor's words; the proxy keeps them, so nothing here turns them on. */
function PoolCredits({ row }: { row: QuotaProviderView }) {
  const line = row.pool
    ? creditsLine(POOL_CREDITS_PROVIDER[row.pool.kind], row.credits)
    : undefined;
  if (!line) return null;
  return (
    <span className="fm-subs-credits" data-credits="">
      {line}
    </span>
  );
}

export function CustomApiAccountsSection({ quota }: { quota?: QuotaSnapshotView | null }) {
  const [views, setViews] = useState<CustomApiView[]>([]);
  const [providers, setProviders] = useState<Record<string, string>>({});
  const [chosen, setChosen] = useState<FirstmateModel>(null);
  // A choice in flight is shown at once; the poll does not put the old one back meanwhile.
  const choosing = useRef(false);
  const [editing, setEditing] = useState<CustomApiView>();
  const [approving, setApproving] = useState<CustomApiView>();
  // One of these connections being used on a computer that runs work.
  const [using, setUsing] = useState<{
    view: CustomApiView;
    definition: CustomFileDefinition;
    device: DeviceSignIns;
  }>();
  const computers = useDeviceSignIns();
  const [file, setFile] = useState<CustomApiFileView>();
  const [armed, setArmed] = useState<string>();
  const [error, setError] = useState("");
  const refresh = useCallback(() => {
    void useShellStore.getState().loadFirstRun();
    void Promise.all([
      window.infinitary.accounts.custom.list(),
      window.infinitary.accounts.list(),
      window.infinitary.settings.getFirstmateModel(),
    ])
      .then(([custom, accounts, selected]) => {
        setViews(custom);
        setProviders(
          Object.fromEntries(accounts.map((account) => [account.id, account.providerId])),
        );
        if (!choosing.current) setChosen(selected);
      })
      .catch(() => setError(m.accountsCustomApiListFailed()));
    // On its own: a home too old to read a connection file still lists every connection.
    window.infinitary.accounts.custom.file().then(setFile, () => setFile(undefined));
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 3000);
    // A connection saved from Add appears at once, not at the next poll.
    const off = window.infinitary.models.onChanged(refresh);
    return () => {
      clearInterval(timer);
      off();
    };
  }, [refresh]);
  const failed = (fallback: string) => (caught: unknown) =>
    setError(caught instanceof Error ? caught.message : fallback);
  const fileConnection = (view: CustomApiView) =>
    view.file && file?.connections.find((entry) => entry.name === view.file?.name);
  // The file's connections no saved one follows yet.
  const pending =
    file?.connections.filter(
      (entry) =>
        !views.some((view) => view.file?.name === entry.name && view.file.state !== "missing"),
    ) ?? [];
  return (
    <div className="fm-custom-list" data-custom-api-accounts>
      <CustomApiFileRow
        file={file}
        onChanged={(next) => {
          setFile(next);
          refresh();
        }}
      />
      {views.map((view) => {
        const accountId = view.accountId ?? "";
        const provider = providers[accountId] ?? "";
        const checked = view.models.length > 0 && view.models.every((model) => model.checked);
        // A change in the file to its address, protocol or headers holds it until approved again.
        const held = Boolean(view.file && view.file.state !== "current");
        // Held by the file, it runs nothing, though its checks still stand.
        const running = view.enabled && !held;
        const ready = running && checked;
        const fromFile = fileConnection(view);
        // Approved again as a new connection, the same entry already runs; this one only waits to be disconnected.
        const replaced =
          view.file?.state === "changed" &&
          views.some(
            (other) =>
              other !== view &&
              other.file?.name === view.file?.name &&
              other.file?.state === "current",
          );
        return (
          <section className="fm-custom-conn" data-custom-account={accountId} key={accountId}>
            {view.tokenCommandFailed && (
              <p role="alert" className="fm-custom-field-error">
                {CUSTOM_TOKEN_FAILURE.row}
              </p>
            )}
            <div className="fm-custom-conn-head">
              <h3>{view.label}</h3>
              <span className="fm-custom-mono fm-custom-address">{view.baseUrl}</span>
              {view.baseUrl.startsWith("http:") && (
                <span className="fm-custom-tag" data-tone="warn">
                  {m.accountsCustomApiUnencrypted()}
                </span>
              )}
              {view.tokenCommand && (
                <span className="fm-custom-tag">{m.accountsCustomApiTokenCommand()}</span>
              )}
              {view.addressException && (
                <span className="fm-custom-tag" data-tone="warn">
                  {CUSTOM_EXCEPTION_WORDS.tag}
                </span>
              )}
              {view.file && (
                <span className="fm-custom-tag" data-custom-file-tag>
                  {m.accountsCustomApiFileTag()}
                </span>
              )}
              <span
                className="fm-custom-tag"
                data-tone={view.tokenCommandFailed ? "danger" : ready ? "ok" : "idle"}
              >
                {view.tokenCommandFailed
                  ? CUSTOM_TOKEN_FAILURE.status
                  : ready
                    ? m.accountsCustomApiStatusReady()
                    : checked
                      ? m.accountsCustomApiStatusPaused()
                      : m.accountsCustomApiStatusPausedNotChecked()}
              </span>
              <span className="fm-custom-acts">
                {replaced ? null : view.file?.state === "changed" && fromFile?.definition ? (
                  <Button variant="secondary" size="sm" onClick={() => setApproving(view)}>
                    {m.accountsCustomApiFileApproveAgain()}
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => (fromFile?.definition ? setApproving(view) : setEditing(view))}
                  >
                    {m.accountsCustomApiEdit()}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  off={!view.enabled && !checked}
                  note={
                    !view.enabled && !checked ? m.accountsCustomApiResumeNeedsCheck() : undefined
                  }
                  onClick={() =>
                    void window.infinitary.accounts
                      .setEnabled(accountId, !view.enabled)
                      .then(refresh)
                      .catch(failed(m.accountsCustomApiChangeFailed()))
                  }
                >
                  {view.enabled ? m.accountsCustomApiPause() : m.accountsCustomApiResume()}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setArmed(accountId)}>
                  {m.accountsCustomApiDisconnect()}
                </Button>
              </span>
            </div>
            <PooledUsage
              rows={(quota?.providers ?? []).filter(
                (row) => row.accountId === accountId && (row.pool || row.status === "unavailable"),
              )}
              now={Date.now()}
            />
            <div className="fm-custom-lrow fm-custom-lcols" aria-hidden="true">
              <span>{m.accountsCustomApiColumnModel()}</span>
              <span>{m.accountsCustomApiColumnStatus()}</span>
              <span>{m.accountsCustomApiColumnFirstmate()}</span>
            </div>
            {view.models.map((model) => {
              const usable = Boolean(provider) && running && model.checked;
              const isChosen = chosen?.provider === provider && chosen.id === model.id;
              return (
                <div className="fm-custom-lrow" key={model.id} data-custom-model={model.id}>
                  <span className="fm-custom-mono fm-custom-model-id">{model.id}</span>
                  <span className="fm-custom-status">
                    <StatusDot
                      tone={model.checked ? (running ? "ok" : "idle") : "ring"}
                      label={
                        model.checked
                          ? running
                            ? m.accountsCustomApiStatusReady()
                            : m.accountsCustomApiStatusChecked()
                          : m.accountsCustomApiStatusNotChecked()
                      }
                      nativeTitle={false}
                    />
                    {model.checked
                      ? running
                        ? m.accountsCustomApiStatusReady()
                        : m.accountsCustomApiStatusChecked()
                      : m.accountsCustomApiStatusNotChecked()}
                    {model.readsPictures && <Badge tone="accent">{CUSTOM_READS_PICTURES}</Badge>}
                  </span>
                  <FirstmateRadio
                    model={model.id}
                    chosen={isChosen}
                    off={
                      held
                        ? m.accountsCustomApiFileApproveToUse()
                        : usable
                          ? undefined
                          : model.checked
                            ? m.accountsCustomApiResumeToUse()
                            : m.accountsCustomApiCheckModelFirst()
                    }
                    onChoose={() => {
                      const before = chosen;
                      choosing.current = true;
                      setChosen({ provider, id: model.id });
                      void window.infinitary.settings
                        .setFirstmateModel({ provider, id: model.id })
                        .then(setChosen, (caught: unknown) => {
                          setChosen(before);
                          failed(m.accountsCustomApiChooseFailed())(caught);
                        })
                        .finally(() => {
                          choosing.current = false;
                          refresh();
                        });
                    }}
                  />
                </div>
              );
            })}
            {view.file?.state === "changed" && (
              <p className="fm-custom-lock" data-custom-file-held>
                {replaced ? m.accountsCustomApiFileReplaced() : m.accountsCustomApiFileChanged()}
              </p>
            )}
            {view.file?.state === "missing" && (
              <p className="fm-custom-lock" data-custom-file-held>
                {m.accountsCustomApiFileGone()}
              </p>
            )}
            {fromFile && <FileWarnings connection={fromFile} approved />}
            {(() => {
              const definition = held ? undefined : customHomeDefinition(view, file);
              // Each computer in reach that takes it and does not follow it yet.
              const offered = definition
                ? computers.filter(
                    (device) =>
                      device.customFromHome &&
                      device.reach === "in-reach" &&
                      device.signIns &&
                      !device.signIns.custom?.some(
                        (there) => there.home?.name === accountId && there.home.state !== "missing",
                      ),
                  )
                : [];
              return definition && offered.length > 0 ? (
                <p className="fm-custom-lock fm-custom-acts" data-custom-use-there>
                  {offered.map((device) => (
                    <Button
                      key={device.deviceId}
                      variant="ghost"
                      size="sm"
                      onClick={() => setUsing({ view, definition, device })}
                    >
                      {m.accountsCustomApiUseOn({ on: signInPlace(device).where })}
                    </Button>
                  ))}
                </p>
              ) : null;
            })()}
            {held ? null : !checked ? (
              <p className="fm-custom-lock">{m.accountsCustomApiCheckBeforeUse()}</p>
            ) : !view.enabled ? (
              <p className="fm-custom-lock">{m.accountsCustomApiPausedHint()}</p>
            ) : null}
            <p className="fm-custom-lock">{m.accountsCustomApiCrewUse()}</p>
            {armed === accountId && (
              <div className="fm-custom-disconnect">
                <p>{m.accountsCustomApiDisconnectWarning()}</p>
                <div className="fm-custom-acts">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      void window.infinitary.accounts
                        .remove(accountId)
                        .then(() => {
                          setArmed(undefined);
                          refresh();
                        })
                        .catch(failed(m.accountsCustomApiDisconnectFailed()))
                    }
                  >
                    {m.accountsCustomApiStopAndDisconnect()}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setArmed(undefined)}>
                    {m.accountsCustomApiKeepConnection()}
                  </Button>
                </div>
              </div>
            )}
          </section>
        );
      })}
      {pending.map((connection) => (
        <FileConnectionRow key={connection.name} connection={connection} onSaved={refresh} />
      ))}
      {approving &&
        (() => {
          const connection = fileConnection(approving);
          return connection ? (
            <FileApproval
              connection={connection}
              original={approving}
              onClose={() => {
                setApproving(undefined);
                refresh();
              }}
              onSaved={refresh}
            />
          ) : null;
        })()}
      {using &&
        (() => {
          const place = signInPlace(using.device);
          const close = () => {
            setUsing(undefined);
            refresh();
          };
          return (
            <CustomApiDialog
              label={m.accountsCustomApiUseTitle({ name: using.definition.label, on: place.where })}
              onClose={close}
            >
              <CustomApiForm
                fromHome={{ name: using.view.accountId ?? "", definition: using.definition }}
                client={deviceCustomClient(using.device.deviceId)}
                place={{ who: place.who, on: place.where }}
                onClose={close}
              />
            </CustomApiDialog>
          );
        })()}
      {editing && (
        <CustomApiDialog
          label={m.accountsCustomApiEditTitle({ name: editing.label })}
          onClose={() => {
            setEditing(undefined);
            refresh();
          }}
        >
          <CustomApiForm
            original={editing}
            onClose={() => {
              setEditing(undefined);
              refresh();
            }}
            onSaved={refresh}
          />
        </CustomApiDialog>
      )}
      {error && (
        <p role="alert" className="fm-custom-field-error">
          {error}
        </p>
      )}
    </div>
  );
}
