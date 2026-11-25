import * as m from "@shared/i18n/messages.generated";
import {
  type CostSelection,
  DEFAULT_USAGE_QUERY,
  USAGE_PERIODS,
  USAGE_SCOPES,
  USAGE_TASK_PAGE,
  USAGE_TASKS_MAX,
  type UsageModel,
  type UsagePeriod,
  type UsageQuery,
  type UsageReporting,
  type UsageScope,
  type UsageSummary,
  type UsageTasks,
  type UsageUnit,
  type UsageWhere,
  usageCategoryValue,
  usageValue,
} from "@shared/usage";
import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from "react";
import { useCommandKeys } from "../app/keyHints";
import { useShellStore } from "../app/store";
import { KeyedText } from "../cards/TaskKey";
import { Button, GroupedPills } from "../design";
import { appReadExecutor } from "../plugins/reads/appExecutor";
import { SectionLabel, SettingError } from "./settingRows";
import { CostPerTask } from "./UsageCostPerTask";
import "./usage.css";
import {
  createdWords,
  formatDay,
  formatRecorded,
  formatUsage,
  milestoneWords,
  modelLine,
  modelName,
  PERIOD_WORDS,
  periodLabel,
  provenance,
  readouts,
  SCOPE_WORDS,
  shortDate,
  sortedModels,
  taskCount,
  taskFigureLabels,
  taskFigures,
  taskNote,
  tokenCategoryCoverage,
  UNIT_WORDS,
  unitHeading,
  whereRows,
} from "./usageWords";

/** Cost per task's filters as the tab opens: every project and every kind. */
const ALL_TASKS: CostSelection = { projects: null, kinds: null };

/**
 * Settings → Usage (docs/usage.md; the design skill's
 * `components/usage/UsageTab.prompt.md`): recorded model usage across the
 * fleet, in estimated dollars or tokens. The unit is the captain's and the
 * core remembers it, dollars until the captain picks tokens; the period, the
 * kind of work and Cost per task's filters start over on every opening. The summary is the `usage.summary` read and the recent tasks
 * the `usage.tasks` read, each re-read after every model response while
 * the tab is open.
 */
export function UsageTab() {
  const unit = useShellStore((s) => s.usageUnit);
  const setUnit = useShellStore((s) => s.setUsageUnit);
  const unitKeys = useCommandKeys("usage.unit");
  const unitError = useShellStore((s) =>
    s.appearanceError?.choice === "usageUnit" ? s.appearanceError.message : null,
  );
  const [query, setQuery] = useState<UsageQuery>(DEFAULT_USAGE_QUERY);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const [openModel, setOpenModel] = useState<string | null>(null);
  // Cost per task's filters: All on every opening, kept across the period and work.
  const [costSelection, setCostSelection] = useState<CostSelection>(ALL_TASKS);
  const root = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const opening = useRef(false);

  // Opening reads the saved unit again, so reopening shows what is saved.
  useEffect(() => {
    useShellStore.getState().refreshAppearance();
  }, []);

  // Where a company's Claude Code setup has usage reported (docs/usage-report.md).
  const [reporting, setReporting] = useState<UsageReporting | null>(null);
  useEffect(
    () =>
      appReadExecutor().subscribe(
        "usage.reporting",
        {},
        {
          onValue: (value) => setReporting(value as UsageReporting),
          // An older home has no such read: no line.
          onError: () => setReporting(null),
        },
      ),
    [],
  );

  useEffect(() => {
    setFailed(false);
    return appReadExecutor().subscribe("usage.summary", query, {
      onValue: (value) => {
        setSummary(value as UsageSummary);
        setFailed(false);
      },
      onError: () => setFailed(true),
    });
  }, [query]);

  // A model that leaves the selection closes its details.
  const shown = summary?.query.period === query.period && summary.query.scope === query.scope;
  const model = shown ? summary.models.find((each) => each.id === openModel) : undefined;
  useEffect(() => {
    if (opening.current && model) {
      opening.current = false;
      close.current?.focus();
    }
  }, [model]);

  const modelButton = (id: string) =>
    root.current?.querySelector<HTMLElement>(`[data-usage-model="${CSS.escape(id)}"]`) ?? null;
  const closeModel = () => {
    const id = openModel;
    setOpenModel(null);
    if (id) modelButton(id)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || !openModel) return;
    // Escape closes the details alone, not Settings around them.
    event.stopPropagation();
    closeModel();
  };
  const choose = (next: Partial<UsageQuery>) => {
    setOpenModel(null);
    setQuery((current) => ({ ...current, ...next }));
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape from anywhere in the tab closes a model's details.
    <div ref={root} className="fm-usage" data-usage="" onKeyDown={onKeyDown}>
      <SectionLabel>{m.settingsUsageTitle()}</SectionLabel>
      <div className="fm-usage-head">
        <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
          {m.settingsUsageLead()}
        </p>
        <div data-usage-unit="">
          <GroupedPills<UsageUnit>
            name={m.settingsUsageShowAs()}
            htmlName="usage-unit"
            value={unit}
            options={(["tokens", "usd"] as const).map((value) => ({
              value,
              label: UNIT_WORDS[value],
            }))}
            onChange={setUnit}
            {...unitKeys}
          />
        </div>
      </div>
      {reporting && <ReportingLine reporting={reporting} />}
      {reporting?.connection && (
        <p className="fm-usage-muted" data-usage-reporting-connection="">
          {m.settingsUsageReportsConnectionTo({ host: reporting.connection })}
        </p>
      )}
      <SettingError error={unitError} surface="usage-unit" />
      <div className="fm-usage-filters">
        <label>
          {m.settingsUsagePeriodLabel()}
          <select
            data-usage-period=""
            value={query.period}
            onChange={(event) => choose({ period: event.target.value as UsagePeriod })}
          >
            {USAGE_PERIODS.map((period) => (
              <option key={period} value={period}>
                {PERIOD_WORDS[period]}
              </option>
            ))}
          </select>
        </label>
        <label>
          {m.settingsUsageWorkLabel()}
          <select
            data-usage-scope=""
            value={query.scope}
            onChange={(event) => choose({ scope: event.target.value as UsageScope })}
          >
            {USAGE_SCOPES.map((scope) => (
              <option key={scope} value={scope}>
                {SCOPE_WORDS[scope]}
              </option>
            ))}
          </select>
        </label>
        {shown && <span className="fm-usage-muted">{periodLabel(summary)}</span>}
      </div>
      {failed && <SettingError error={m.settingsUsageReadFailed()} surface="usage" />}
      {shown ? (
        <UsageBody
          summary={summary}
          unit={unit}
          costSelection={costSelection}
          onCostSelection={setCostSelection}
          model={model}
          onModel={(id) => {
            if (id === openModel) {
              setOpenModel(null);
              return;
            }
            opening.current = true;
            setOpenModel(id);
          }}
          onClose={closeModel}
          closeRef={close}
        />
      ) : (
        !failed && (
          <p className="fm-usage-muted" style={{ marginTop: "var(--space-5)" }}>
            {m.settingsUsageReading()}
          </p>
        )
      )}
    </div>
  );
}

function UsageBody({
  summary,
  unit,
  costSelection,
  onCostSelection,
  model,
  onModel,
  onClose,
  closeRef,
}: {
  summary: UsageSummary;
  unit: UsageUnit;
  costSelection: CostSelection;
  onCostSelection: (next: CostSelection) => void;
  model: UsageModel | undefined;
  onModel: (id: string) => void;
  onClose: () => void;
  closeRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <>
      {summary.total.records === 0 ? (
        <div className="fm-usage-empty" data-usage-empty="">
          <h3>{m.settingsUsageEmptyTitle()}</h3>
          <p className="fm-usage-muted">{m.settingsUsageEmptyLead()}</p>
          <p className="fm-usage-muted">{m.settingsUsageEmptyNote()}</p>
        </div>
      ) : (
        <>
          <div className="fm-usage-readouts">
            {readouts(summary, unit).map((readout, index) => (
              <div
                key={readout.label}
                className="fm-usage-readout"
                data-usage-readout={["usage", "finished", "models"][index]}
              >
                <span className="fm-usage-readout-label">{readout.label}</span>
                <span className="fm-usage-readout-value fm-usage-mono">{readout.value}</span>
                <span className="fm-usage-muted">{readout.note}</span>
              </div>
            ))}
          </div>
          <DailyUsage summary={summary} unit={unit} />
          {(summary.query.scope === "all" || summary.query.scope === "task") && (
            <CostPerTask
              period={summary.query.period}
              unit={unit}
              selection={costSelection}
              onSelection={onCostSelection}
            />
          )}
          <div className="fm-usage-columns">
            <ModelList summary={summary} unit={unit} open={model?.id ?? null} onModel={onModel} />
            <WhereItWent
              of="selection"
              where={summary.where}
              unit={unit}
              withFirstmate={summary.query.scope === "all" || summary.query.scope === "firstmate"}
              legend={m.settingsUsageWhereLegend()}
            />
          </div>
          {model && <ModelDetail model={model} unit={unit} onClose={onClose} closeRef={closeRef} />}
        </>
      )}
      <Milestone finishedEver={summary.finishedEver} />
      <RecentTasks
        key={`${summary.query.period}/${summary.query.scope}`}
        query={summary.query}
        unit={unit}
      />
    </>
  );
}

function DailyUsage({ summary, unit }: { summary: UsageSummary; unit: UsageUnit }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const values = summary.days.map((day) => usageValue(day.amount, unit) ?? 0);
  const max = Math.max(...values, 0);
  const partial = unit === "usd" && summary.total.priced < summary.total.records;
  const hoveredDay = hovered === null ? undefined : summary.days[hovered];
  const first = summary.days[0];
  return (
    <section className="fm-usage-section" data-usage-daily="">
      <div className="fm-usage-section-head">
        <h3>{m.settingsUsageDailyHeading()}</h3>
        <span className="fm-usage-muted">
          {m.settingsUsageDailyPartial({ unit: unitHeading(unit) })}
        </span>
      </div>
      <div
        className="fm-usage-chart"
        role="img"
        aria-label={
          unit === "tokens" ? m.settingsUsageDailyChartTokens() : m.settingsUsageDailyChartUsd()
        }
        onMouseLeave={() => setHovered(null)}
      >
        {summary.days.map((day, index) => {
          const value = values[index] ?? 0;
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: the pointer's rest names a day; the Daily values table is the keyboard's way to every value.
            <span
              key={day.date}
              className="fm-usage-day"
              data-today={index === summary.days.length - 1 ? "" : undefined}
              onMouseEnter={() => setHovered(index)}
            >
              <span
                data-active={value > 0 ? "" : undefined}
                style={{ height: max > 0 ? `${(value / max) * 100}%` : 0 }}
              />
            </span>
          );
        })}
      </div>
      <div className="fm-usage-chart-foot">
        <span>{first ? shortDate(first.date) : ""}</span>
        <span>{m.settingsUsageToday()}</span>
      </div>
      <p className="fm-usage-legend">
        {hoveredDay
          ? m.settingsUsageDayValue({
              date: shortDate(hoveredDay.date),
              value: formatDay(hoveredDay, unit),
            })
          : partial
            ? m.settingsUsageBarsPriced()
            : m.settingsUsageOpenModel()}
      </p>
      <details data-usage-daily-values="">
        <summary>{m.settingsUsageDailyValues()}</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">{m.settingsUsageLocalDate()}</th>
              <th scope="col">{unitHeading(unit)}</th>
            </tr>
          </thead>
          <tbody>
            {summary.days.map((day) => (
              <tr key={day.date}>
                <td>{day.date}</td>
                <td>{formatDay(day, unit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

function ModelList({
  summary,
  unit,
  open,
  onModel,
}: {
  summary: UsageSummary;
  unit: UsageUnit;
  open: string | null;
  onModel: (id: string) => void;
}) {
  const models = sortedModels(summary.models, unit);
  const max = Math.max(...models.map((model) => usageValue(model.amount, unit) ?? 0), 0);
  return (
    <section className="fm-usage-section" data-usage-models="">
      <div className="fm-usage-section-head">
        <h3>{unit === "usd" ? m.settingsUsageModelsUsd() : m.settingsUsageModelsTokens()}</h3>
        <span className="fm-usage-muted">{unitHeading(unit)}</span>
      </div>
      {models.map((model) => {
        const value = usageValue(model.amount, unit);
        return (
          <div key={model.id} className="fm-usage-row">
            <div style={{ minWidth: 0 }}>
              <button
                type="button"
                className="fm-usage-model"
                data-usage-model={model.id}
                aria-expanded={open === model.id}
                aria-controls={open === model.id ? "fm-usage-model-detail" : undefined}
                onClick={() => onModel(model.id)}
              >
                {modelName(model)}
              </button>
              <span className="fm-usage-muted">{modelLine(model)}</span>
            </div>
            <span className="fm-usage-mono">{formatUsage(value, unit)}</span>
            <span className="fm-usage-track" aria-hidden="true">
              <span style={{ width: max > 0 && value ? `${(value / max) * 100}%` : 0 }} />
            </span>
          </div>
        );
      })}
    </section>
  );
}

function WhereItWent({
  of,
  where,
  unit,
  withFirstmate,
  legend,
  heading,
}: {
  /** Whose usage: the whole selection, or one model's. */
  of: "selection" | "model";
  where: UsageWhere;
  unit: UsageUnit;
  withFirstmate: boolean;
  legend?: string;
  heading?: string;
}) {
  const rows = whereRows(where, unit, withFirstmate);
  return (
    <section className="fm-usage-section" data-usage-where={of}>
      <div className="fm-usage-section-head">
        <h3>{heading ?? m.settingsUsageWhereHeading()}</h3>
        <span className="fm-usage-muted">{unitHeading(unit)}</span>
      </div>
      {rows.firstmate && (
        <div className="fm-usage-row" data-usage-place="firstmate">
          <div style={{ minWidth: 0 }}>
            <span className="fm-usage-row-name">{m.settingsUsageWhereFirstmate()}</span>
            <span className="fm-usage-muted">{m.settingsUsageWhereFirstmateNote()}</span>
          </div>
          <span className="fm-usage-mono">{formatRecorded(rows.firstmate, unit)}</span>
        </div>
      )}
      {rows.projects.map((project) => (
        <section
          key={project.key}
          className="fm-usage-project"
          data-usage-project={project.key}
          aria-label={project.name}
        >
          <div className="fm-usage-project-head">
            <h4>{project.name}</h4>
            <span className="fm-usage-subtotal">
              <span className="fm-usage-mono" data-usage-subtotal="">
                {formatRecorded(project.amount, unit)}
              </span>
              <span className="fm-usage-subtotal-label">{m.settingsUsageSubtotal()}</span>
            </span>
          </div>
          {project.kinds.map((kind) => (
            <div key={kind.key} className="fm-usage-row fm-usage-kind" data-usage-kind={kind.key}>
              <span className="fm-usage-row-name">{kind.name}</span>
              <span className="fm-usage-mono">{formatRecorded(kind.amount, unit)}</span>
            </div>
          ))}
        </section>
      ))}
      {rows.other && (
        <div className="fm-usage-row fm-usage-other" data-usage-place="other">
          <div style={{ minWidth: 0 }}>
            <span className="fm-usage-row-name">{m.settingsUsageWhereOther()}</span>
            <span className="fm-usage-muted">{m.settingsUsageWhereOtherNote()}</span>
          </div>
          <span className="fm-usage-mono">{formatRecorded(rows.other, unit)}</span>
        </div>
      )}
      {legend && <p className="fm-usage-legend">{legend}</p>}
    </section>
  );
}

/**
 * Where usage is also reported, or, while the collector of the person's own
 * setup keeps refusing, that Claude work is not reaching it and why.
 */
export function ReportingLine({ reporting }: { reporting: UsageReporting }) {
  const { refusal, host, claudeOnly } = reporting;
  if (refusal)
    return (
      <p className="fm-usage-muted" data-usage-reporting="" data-tone="warn">
        {refusal.reason === "unreachable"
          ? m.settingsUsageReportingUnreachable({ host: refusal.host })
          : refusal.reason === "secure-connection"
            ? m.settingsUsageReportingSecure({ host: refusal.host })
            : m.settingsUsageReportingRefused({ host: refusal.host })}
      </p>
    );
  if (!host) return null;
  return (
    <p className="fm-usage-muted" data-usage-reporting="">
      {claudeOnly ? m.settingsUsageReportsClaudeTo({ host }) : m.settingsUsageReportsTo({ host })}
    </p>
  );
}

const CATEGORIES = ["input", "output", "cacheRead", "cacheWrite"] as const;

function categoryLabel(category: (typeof CATEGORIES)[number]): string {
  switch (category) {
    case "input":
      return m.settingsUsageFigureInput();
    case "output":
      return m.settingsUsageFigureOutput();
    case "cacheRead":
      return m.settingsUsageFigureCacheRead();
    case "cacheWrite":
      return m.settingsUsageFigureCacheWrite();
  }
}

function ModelDetail({
  model,
  unit,
  onClose,
  closeRef,
}: {
  model: UsageModel;
  unit: UsageUnit;
  onClose: () => void;
  closeRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <section
      id="fm-usage-model-detail"
      className="fm-usage-detail"
      data-usage-detail={model.id}
      aria-label={m.settingsUsageModelDetails({ model: modelName(model) })}
    >
      <div className="fm-usage-head">
        <div style={{ minWidth: 0 }}>
          <h3
            style={{
              margin: 0,
              fontSize: "var(--text-base)",
              fontWeight: 500,
              color: "var(--fg-1)",
            }}
          >
            {modelName(model)}
          </h3>
          <span className="fm-usage-muted">
            {unit === "tokens"
              ? m.settingsUsageModelBreakdownTokens({ line: modelLine(model) })
              : m.settingsUsageModelBreakdownUsd({ line: modelLine(model) })}
          </span>
        </div>
        <Button ref={closeRef} variant="secondary" size="sm" onClick={onClose}>
          {m.settingsUsageCloseDetails()}
        </Button>
      </div>
      <div className="fm-usage-detail-grid">
        {CATEGORIES.map((category) => (
          <div key={category} className="fm-usage-muted" data-usage-category={category}>
            {categoryLabel(category)}
            <strong data-usage-value={usageCategoryValue(model.amount, category, unit) ?? ""}>
              {formatUsage(usageCategoryValue(model.amount, category, unit), unit)}
            </strong>
            {unit === "tokens" && (
              <span
                className="fm-usage-mono"
                data-usage-token-coverage={category}
                data-usage-reported={model.amount.tokenReported?.[category] ?? ""}
                data-usage-records={model.amount.records}
              >
                {tokenCategoryCoverage(model.amount, category)}
              </span>
            )}
          </div>
        ))}
      </div>
      {provenance(model, unit).map((line) => (
        <p key={line} className="fm-usage-muted">
          {line}
        </p>
      ))}
      <WhereItWent
        of="model"
        where={model.where}
        unit={unit}
        withFirstmate={false}
        heading={m.settingsUsageItsWork()}
      />
    </section>
  );
}

function Milestone({ finishedEver }: { finishedEver: number }) {
  const words = milestoneWords(finishedEver);
  return (
    <div className="fm-usage-milestone" data-usage-milestone={finishedEver}>
      <svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">
        <circle cx="20" cy="20" r="15" style={{ fill: "none", stroke: "var(--line-2)" }} />
        {finishedEver > 0 && (
          <path
            d="M13 20l5 5 10-11"
            style={{ fill: "none", stroke: "var(--fg-2)", strokeWidth: 1.5 }}
          />
        )}
      </svg>
      <div>
        <p style={{ fontSize: "var(--text-sm)", color: "var(--fg-1)" }}>{words.title}</p>
        <p className="fm-usage-muted">{words.note}</p>
      </div>
    </div>
  );
}

/**
 * Recent tasks (FI3-993): the newest tasks with recorded usage in the
 * period and work, ten at first and ten more on each See more, focus going
 * to the first of them. The list starts over when the period or the work
 * changes (the tab mounts it anew); the unit keeps it as it is.
 */
function RecentTasks({ query, unit }: { query: UsageQuery; unit: UsageUnit }) {
  const [limit, setLimit] = useState(USAGE_TASK_PAGE);
  const [attempt, setAttempt] = useState(0);
  const [value, setValue] = useState<UsageTasks | null>(null);
  const [failed, setFailed] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  // The first row a See more asked for, focused once it arrives.
  const focusFrom = useRef<number | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the retry
  useEffect(() => {
    setFailed(false);
    return appReadExecutor().subscribe(
      "usage.tasks",
      { period: query.period, scope: query.scope, limit },
      {
        onValue: (next) => {
          setValue(next as UsageTasks);
          setFailed(false);
        },
        onError: () => setFailed(true),
      },
    );
  }, [query.period, query.scope, limit, attempt]);

  useEffect(() => {
    const from = focusFrom.current;
    if (from === null || !value || value.tasks.length <= from) return;
    focusFrom.current = null;
    list.current?.querySelectorAll<HTMLElement>("[data-usage-task]")[from]?.focus({
      preventScroll: true,
    });
  }, [value]);

  return (
    <RecentTasksView
      value={value}
      failed={failed}
      unit={unit}
      listRef={list}
      onMore={() => {
        const shown = value?.tasks.length ?? 0;
        focusFrom.current = shown;
        setLimit(Math.min(shown + USAGE_TASK_PAGE, USAGE_TASKS_MAX));
      }}
      onRetry={() => setAttempt((count) => count + 1)}
    />
  );
}

export type RecentTasksViewProps = {
  /** The last list read, kept while a longer one is read or fails. */
  value: UsageTasks | null;
  failed: boolean;
  unit: UsageUnit;
  listRef?: RefObject<HTMLOListElement | null>;
  onMore: () => void;
  onRetry: () => void;
};

export function RecentTasksView({
  value,
  failed,
  unit,
  listRef,
  onMore,
  onRetry,
}: RecentTasksViewProps) {
  const tasks = value?.tasks ?? [];
  const more = value !== null && tasks.length < value.matching && tasks.length < USAGE_TASKS_MAX;
  return (
    <section className="fm-usage-section fm-usage-recent" data-usage-recent="">
      <div className="fm-usage-section-head">
        <h3>{m.settingsUsageRecentHeading()}</h3>
        <span className="fm-usage-muted">{unitHeading(unit)}</span>
      </div>
      <p className="fm-usage-muted fm-usage-recent-lead">{m.settingsUsageRecentLead()}</p>
      <p className="fm-usage-legend fm-usage-recent-lead">
        {unit === "tokens" ? m.settingsUsageRecentTokensLegend() : m.settingsUsageRecentUsdLegend()}
      </p>
      {value === null ? (
        failed ? (
          <TasksRetry words={m.settingsUsageRecentFailed()} onRetry={onRetry} />
        ) : (
          <p className="fm-usage-muted">{m.settingsUsageRecentReading()}</p>
        )
      ) : tasks.length === 0 ? (
        <p className="fm-usage-muted fm-usage-tasks-empty" data-usage-tasks-empty="">
          {m.settingsUsageRecentEmpty()}
        </p>
      ) : (
        <>
          <div className="fm-usage-task fm-usage-task-head" aria-hidden="true">
            <span>{m.settingsUsageTaskColumn()}</span>
            {taskFigureLabels().map(([figure, label]) => (
              <span key={figure}>{label}</span>
            ))}
          </div>
          <ol ref={listRef} className="fm-usage-tasks" aria-label={m.settingsUsageRecentList()}>
            {tasks.map((each) => {
              const note = taskNote(each, unit);
              return (
                <li
                  key={each.task.key}
                  className="fm-usage-task"
                  data-usage-task={each.task.key}
                  tabIndex={-1}
                >
                  <div className="fm-usage-task-name">
                    <span className="fm-usage-row-name">{each.task.title}</span>
                    <span className="fm-usage-muted">
                      {each.task.project ? `${each.task.project} · ` : ""}
                      <span className="fm-usage-mono">
                        <KeyedText text={each.task.key} look="quiet" />
                      </span>
                    </span>
                    <span className="fm-usage-muted">{createdWords(each.createdAt)}</span>
                  </div>
                  <dl className="fm-usage-figures">
                    {taskFigures(each, unit).map((figure) => (
                      <div key={figure.figure} data-usage-figure={figure.figure}>
                        <dt>{figure.label}</dt>
                        <dd className="fm-usage-mono">{figure.value}</dd>
                        {figure.coverage && (
                          <dd className="fm-usage-coverage">{figure.coverage}</dd>
                        )}
                      </div>
                    ))}
                  </dl>
                  {note && <p className="fm-usage-task-note">{note}</p>}
                </li>
              );
            })}
          </ol>
          {failed && <TasksRetry words={m.settingsUsageMoreFailed()} onRetry={onRetry} />}
          <div className="fm-usage-tasks-foot" data-usage-tasks-foot="">
            <span className="fm-usage-muted" data-usage-task-count="" aria-live="polite">
              {taskCount(tasks.length, value.matching)}
            </span>
            {more && (
              <Button variant="secondary" size="sm" onClick={onMore}>
                {m.settingsUsageSeeMore()}
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function TasksRetry({ words, onRetry }: { words: string; onRetry: () => void }) {
  return (
    <p className="fm-usage-muted fm-usage-tasks-retry" data-usage-tasks-retry="">
      {words}{" "}
      <Button variant="secondary" size="sm" onClick={onRetry}>
        {m.settingsUsageTryAgain()}
      </Button>
    </p>
  );
}
