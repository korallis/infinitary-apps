# Usage

Settings → Usage reports the model usage the first mate records across the fleet: the first mate's own conversation, every crewmate's task work, and the model calls made for neither.
It answers how much, on which models, where it went and how much work finished, in tokens or in estimated US dollars.
The captain chose the Overview direction of FI3-925's prototypes, with estimated dollars offered and quiet milestones on (FI3-926).
How it looks and reads is the design skill's `components/usage/UsageTab.prompt.md`.

| Piece | Where |
| --- | --- |
| The ledger and its one writer | `usage_events`, `UsageStore.record` (`src/core/storage/usageStore.ts`) |
| Its daily totals, which the reads add up | `usage_days` and `usage_days_state`, `foldUsageDays` (`src/core/storage/usageDays.ts`) |
| The summary the tab reads | `UsageStore.summary`, served as `services.usage.summary` on `inf:usage:summary` |
| The read the tab subscribes to | `usage.summary` in the read catalog (`src/shared/reads.ts`) |
| Its recent tasks | `UsageStore.tasks`, served as `services.usage.tasks` on `inf:usage:tasks`, read as `usage.tasks` |
| Its cost per task | `UsageStore.taskCosts`, served as `services.usage.taskCosts` on `inf:usage:task-costs`, read as `usage.taskCosts` |
| Its shapes and pure math | `src/shared/usage.ts` |
| What leaves the computer, and in which format | Infinitary's own usage report (`docs/usage-report.md`) |
| The tab, its words and numbers | `src/renderer/src/settings/UsageTab.tsx`, `UsageCostPerTask.tsx`, `usageWords.ts`, `usage.css` |
| The remembered unit | `appearance.usageUnit` (`src/shared/preferences.ts`), written through `setAppearance` |
| The two commands | `settings.usage` and `usage.unit` (`src/shared/keyboardCommands.ts`, `docs/keyboard.md`) |

## What the ledger records

Each session's `turn_end` carries reported usage (`FmUsage`, `src/shared/events.ts`), and `UsageStore.record` writes it.
A rolling Claude session can report each completed call before its enclosing turn ends; its final result carries only the unrecorded remainder.
A completed Pi context-shortening call carries its reported usage on the progress tool's `tool_end`, not a conversational turn end.
The session delivers one completion per call, including manual, threshold and overflow recovery; failed, aborted and unreported calls supply no usage.
The first mate and crewmate owners record it under the serving task, account and requested model, including calls settling while a task closes.
Usage subscribers refresh on these completions as well as ordinary replies.

- **Models.**
  Claude reports a running total for every model a turn called (`modelUsage`: the main loop, subagents, compaction).
  A client that resumes a session starts those totals from the ones it restored from the session's transcript, not from zero, so a result's first total after a resume is not that turn's spend.
  Each result of a current client also states the calls it counted since its previous result, model by model (`model_usage_since_last_result`), and the normalizer (`claudeEvents.ts`) reports that statement as each model's own share in `usage.models`.
  From a client that states none, the normalizer subtracts each model's last result totals instead.
  Local call reports (`claudeCallUsage.ts`) queue matched requests as they arrive, flush them at the next main `message_start` or result, and subtract those same counters from the result delta; the ledger writes each share once, named by the model Claude says served it, `model_source = 'served'`.
  Claude books a refusal fallback's retry under the model that answered it, so the turn a fallback happened in has a row for each model (`docs/claude-client.md`, "The model that answers").
  Without a statement, a reported total below its previously reported value means the client started counting over for that model, so its reported figures are the turn's own and its old baselines are discarded; a result reported twice spends nothing.
  An omitted field stays unknown for that result and retains its last known baseline until it returns, rather than resetting or charging its previous total again.
  Pi names the model the session asked for, so its rows carry `model_source = 'requested'`.
  An OpenRouter decision is the exception: its reply names the model that answered, recorded as `served` (`docs/decision-models.md`).
  A row written before migration 66 has no source: it names the model recorded then, and an older Claude row may sum several models.
  The app never splits such a row after the fact.
- **Known and missing.**
  A token category the session did not report stays null, never zero.
  Custom-provider turns carry an empty usage object when the server reports nothing, so the record still contributes to coverage.
- **Estimates.**
  `cost` is the session's own estimate in US dollars: Pi prices a message from the model's listed per-category rates (`cost_source = 'listed-prices'`, with `cost_input`, `cost_output`, `cost_cache_read` and `cost_cache_write`), and Claude makes its own estimate per model and turn (`cost_source = 'claude'`, no split).
  An OpenRouter decision records the cost its reply states for the call (`cost_source = 'reported'`, no split).
  A model with no listed rates prices a message at zero, which proves nothing, so Pi's normalizer records no cost at all for it.
  The summary and the cost limit count a record as priced only when its cost is above zero, or zero from listed prices on a custom connection, so an older zero is never read as free (`PRICED_RECORD`, `src/core/storage/usageDays.ts`).
  That listed zero comes only from a custom model the person stated as free, since a catalog entry listing every rate at zero counts as no price; Pi's normalizer records it only when the turn measured tokens.
  Custom models take a name and price stated on their line, else listed price metadata from an exact model-id match in the local catalog (`docs/custom-api.md`); unpriced ids or unreported counts stay unavailable.
  Nothing is repriced: a record keeps the estimate it was written with.

## Claude calls during a turn

Rolling Claude sessions use the client's standard OpenTelemetry request-cost export, not its experimental live usage request.
`ClaudeCostReports` (`src/core/claude/claudeCostReports.ts`) owns one lazy receiver per factory on the computer running the session, bound to `127.0.0.1` with an unguessable path per client attachment.
The client keeps its five-second default log batching; the app makes no allowance request or transcript-history scan for these reports.
With no company setup ("A company's Claude Code setup" below) it disables content, metric and trace exports for this app-owned path.
It projects only required request-cost fields, and never persists the raw export, prompts, identity metadata or endpoint secret.
The last attachment removes its route and stops the receiver; a failed startup or malformed export never fails the model prompt.
A reporting choice in the host environment other than a company setup's keys, an exporter the receiver cannot carry (one other than OTLP), a managed reporting setting, a policy helper or an unavailable policy read keeps result-only accounting rather than overwriting that configuration (`claudeCostPolicy.ts`).
The policy read loads no personal settings or credential.

A provider request ID must join a completed SDK-streamed call to the client's price; model IDs use the existing canonical model-name owner.
A repeated content block or export counts once, exports can arrive in either order, and settling a result forgets its pending request IDs so a late report cannot charge it again.
A price arriving during text or a running tool is not a turn boundary; queued charges wait for the next main request or result so live text, tool records and runaway state are not cleared mid-turn.
Result-boundary charges follow the ordinary failure classification, and cost rounding uses the client's cumulative counter scale rather than only a small turn delta.
Counters and prices never match calls by equal amounts or arrival-time guesses.
A resumed attachment gets a fresh receiver route and request set, without replaying earlier session-file rows.
Calls without a usable ID or streamed completion, model-label mismatches and advisor iterations whose price cannot be split remain on the ordinary terminal path.
The ordinary result normalizer keeps its cumulative-counter and restart rules; live recording does not replace it or fetch a second total.
A failed or interrupted turn still records the measured calls and its final unrecorded remainder.

A delivered report can trigger the existing cost-limit owner before the turn ends, but this is not a hard time or dollar ceiling.
Batching, a missing report and the next safe stopping point can delay the hold.
If live reporting is unavailable, the existing terminal report still records spend; if the client crashes without that report, it cannot supply the missing usage either.

## A company's Claude Code setup

A company that reads Claude Code's own usage reports (OpenTelemetry) usually has each developer keep the setup in their own Claude settings file's `env` block or in their shell, as Claude Code's guide says.
Infinitary reads that setup and passes Claude's own records on to the company's collector, so work done here counts there (`src/core/claude/claudeReporting.ts`).
Every other provider's work reaches the same collector, and a managed setup's, in Claude Code's names through Infinitary's own usage report (`docs/usage-report.md`).

- **Where it is read.**
  The keys are `CLAUDE_CODE_ENABLE_TELEMETRY` and every `OTEL_*` key, from the app's launch environment, then the login shell, then the person's own settings file, a later place winning, as Claude Code lays its settings file over the environment it started in (`readClaudeCompanyReporting`).
  The login shell's keys come from the same one-time ask that reads its search path: awk prints only those keys inside the shell, so no other variable reaches the app (`readLoginShellPath`, `src/core/userBin.ts`).
  The settings file's `otelHeadersHelper`, a command that prints a JSON object of headers, is read too; each attachment reads the setup again.
- **Who sends.**
  Claude's client reports only to the app's local receiver: the setup's keys leave the client's environment, and the receiver's take their place.
  With a setup that exports logs or metrics over OTLP, the receiver also takes the client's metrics, each signal in the encoding the collector takes (JSON for `http/json`, protobuf for `http/protobuf` and `grpc`).
  It prices each call from the logs as before, so cost limits stay live (a batch over 1 MiB is passed on unpriced, up to the collector's default 20 MiB), and posts each batch's bytes unchanged to the collector, over OTLP/HTTP or as one gRPC call; the collector's answer goes back to the client's exporter, so the client's own retries apply and a repeated batch is priced once.
  The setup's other keys, such as `OTEL_RESOURCE_ATTRIBUTES`, an export interval or the switches that put prompts in the logs, reach the client unchanged, so the company receives what Claude's client would have sent; traces stay off.
- **Headers.**
  The setup's static headers and what its header command prints (run with the session's environment, at most once each 29 minutes, as Claude Code runs it) ride each post; they are held in memory only, redirects are not followed, and a failed command sends without its headers, leaves one log line without its output and runs again after 10 seconds.
- **Certificates.**
  A secure collector is checked as Claude's client checks it: against the file `OTEL_EXPORTER_OTLP_CERTIFICATE` names, which replaces every other authority, or else against Node's own list with any `NODE_EXTRA_CA_CERTS` and the computer's trusted certificates as Node read them when the app started, less those past their end date.
  `OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE` and `OTEL_EXPORTER_OTLP_CLIENT_KEY` are sent as a pair, over OTLP/HTTP and gRPC alike; each key's signal form (`OTEL_EXPORTER_OTLP_LOGS_CERTIFICATE`) wins over the general one, an empty one reads as unset, and a path resolves against the folder the client runs in.
  A file that cannot be read, or a pair that does not fit, is left out with a log line, as the client leaves it out with a warning.
  The usage report's posts to the same collector go the same way (`docs/usage-report.md`, "Sending"), so every other provider's work reaches it too.
  A gRPC address with no scheme (`collector.example.com:4317`) is secure unless the setup's `OTEL_EXPORTER_OTLP_INSECURE` is `true`, as in Claude's gRPC exporter.
- **A managed setup.**
  An administrator's managed setup reaches Claude's client directly and cannot be overridden; there the receiver stays off as before and Infinitary passes nothing on, so nothing is counted twice.
- **What a person sees.**
  Usage shows one line naming where usage is reported (`usage.reporting`, `companyDestination`'s `reporting`): the host the usage report sends every model's work to, an administrator's managed setup included, or else, marked Claude work only, the host of a setup it cannot send to, such as one over gRPC, where Claude's own client or the receiver still reports Claude's records; each computer that runs work follows its own setup for Claude work, which the line says.
  When a collector of the person's setup keeps failing, its first and latest failure a minute or more apart with no batch taken between them (`REFUSAL_LASTS_MS`, past one batch's retries within the client's ten-second export limit), the line turns to a warning that Claude work is not reaching it and why: it could not be reached, the connection could not be made secure (an untrusted certificate, or a client certificate it turned away or missed), or it answered with a refusal.
  One failed batch followed by no more work stays quiet, and the next batch the collector takes brings the line back (`lastingRefusal`).
  A managed collector's answers reach only Claude's client, so its line never warns.

`claudeReporting.integration.test.ts` holds this on the client the product would run, boxed, with stand-in collectors over OTLP/HTTP JSON, protobuf and gRPC and a header command: the collector gets the client's own batches byte for byte, the token and cost counters among them, the person's resource attributes on logs and metrics, prompts only where the person's `OTEL_LOG_USER_PROMPTS` asks, and a managed setup leaves the collector empty.
Collectors on a certificate authority of their own, over OTLP/HTTP and gRPC, take only the setup's client certificate and get every priced call; one the computer's trusted list vouches for is reached with no certificate key, and an untrusted one is named as not connecting securely.
`usageReporter.integration.test.ts` holds the same for the usage report: a Codex call reaches a collector that takes only the setup's client certificate, and one the computer's trusted list vouches for, while an untrusted one drops the batch with a log line saying the connection could not be made secure.

## Daily totals

The summary, the recent tasks, the cost per task and Observe's `byTask` add up daily totals, never every ledger record (INF-4393 measured 100 to 380 ms of main-thread time per read over 226,027 records).
`usage_days` holds one row per local day, task, provider, recorded model, model source and price source, with each amount column already summed: records, reporting counts, tokens, the priced estimate and its parts, and the first and last moment.
An estimate nothing on the row priced stays null, so adding rows up again answers exactly what adding the records would.
`usage_days_state` says through which ledger row the totals are folded and in which time zone their days were counted.
Before each read, `foldUsageDays` adds the records written since its last fold to their days' rows, whoever wrote them, an older build included.
When there is no fold yet, or the time zone differs from the one recorded, it counts every day again from the ledger, once.
The totals are derived, never a second ledger: they add no migration or saved-data format, the first read on a connection makes their tables, and an older build ignores them.
Nothing deletes or rewrites ledger rows; a writer that did would have to count the days again.

## The summary

`UsageStore.summary(query, { now, names })` answers one period (`7d`, `30d`, `all`) and one kind of work (`all`, `task`, `firstmate`, `other`) in tokens and dollars at once, so switching the unit asks nothing new.
The summary reads the task contract and routing fields it needs for work kind without assembling the full saved task shape.

- **Work.**
  `firstmate` is the first mate's own task id; `task` is any record whose task is on the record, its supporting model calls (classifiers, decisions made for it) included; `other` is everything else, a call made for no task or for a task the record no longer has.
  Usage is never dropped for want of a task.
- **Days.**
  The ledger is grouped by local calendar day; a period covers every day through today, which is still partial, and all time starts on the first day anything was recorded.
  A day with no records is no activity, not a measured zero.
- **Amounts.**
  Every amount carries the four token categories, each counted once, the records it sums, how many reported tokens, per-category reporting counts (`tokenReported`), the known estimate over the priced records, and how many were priced and split by category (`usageAmountSchema`).
  A token category no record reported reads Not available, distinct from a reported zero.
  Coverage counts include explicit zeros and use all records as their denominator, independently of pricing.
  Older homes may omit `tokenReported`; clients disclose unavailable coverage rather than inferring it from the any-token `counted` flag.
  An amount with nothing priced has a null estimate, which the tab shows as Not available.
  The total, the days and the models each add up to the same aggregate (`usageStore.test.ts`).
- **Models.**
  One row per provider and recorded model, never the newest model of a task, named by the name Settings gives it (`modelNames`) and its provider's name, a connected custom API by its connection name.
  `attribution` is the weakest naming among its records, and `priceSources` where its estimates came from.
- **Where it went.**
  `where` holds the first mate, each project's task work, and other work.
  A project carries its subtotal and the same usage by the kind of work its tasks' shapes saved (`tasks.shape_json`): plan, research, retrieval, reproduce, implement, fix, chore or review.
  A task with no saved kind, `unclear`, or a kind the list does not know is null, other task work in its project; nothing guesses a kind from a title.
  A task whose project the record no longer has sums under a null project.
  The first mate, the project subtotals and other work add up to the total, and a project's kinds add up to its subtotal, never to more.
  Each model's `where` is the same grouping over that model's records alone.
  `places` still names the first mate, other work and the largest tasks by tokens and by estimate, for the published summary's clients; the tab reads `where`.
- **Finished work.**
  A task counts as finished when it is done, not an operation, has a crewmate and started, closed within the period; `finishedEver` counts the same over all retained history.
  Dropped tasks and unstarted grouping parents never count.

## Recent tasks

`UsageStore.tasks({ period, scope, limit }, { now })` answers the tasks with recorded usage in the period and work, newest created first.
Only `all` and `task` work has tasks; the first mate and other work are never one.
A tie on the moment a task was created breaks by task id, so a longer read lists a shorter one's tasks first, in the same order, and a refresh neither repeats nor skips one.
It answers the first `limit` of them, at most `USAGE_TASKS_MAX`, and `matching`, how many there are.
Each task carries its key, title and project, when it was created, its amount over the period alone (its supporting model calls included once), and how many records reported each token category (`reported`) and how many priced records split their estimate into each (`costReported`), so a category no record reported is told from a measured zero.

## Cost per task

`UsageStore.taskCosts({ period }, { now })` answers each task that finished in the period, and in the week before it, with what it spent over its whole life (INF-6217's plan).
It shows whether tasks in a project take more work than before, as complexity or debt grows.

- **Finished.**
  The summary's rule: done, not an operation, with a crewmate, started and closed.
  A task counts at the moment it closed.
- **Reviews.**
  A review is a task under the one it checks whose saved kind is review.
  It, and anything under it, adds its tokens and estimate to the task it reviews and is never a task of its own, so Reviews is not one of the kinds.
  A separate task filed under a finished one is a task of its own and adds nothing to it.
- **Each task.**
  It carries when it closed, its project (null when the record no longer has it), its saved kind, and its tokens and known estimate with its reviews'.
  Tokens are null when no record reported any, and the estimate is null unless something was priced above zero.
- **The window.**
  Each point is the median of the selected tasks that closed in the `COST_WINDOW_DAYS` (7) days before it, with the middle half of them as a band around it.
  The period draws `COST_POINTS` (150) evenly spaced windows from its first moment to now; the week before the period gives its first point a full window.
  A window with fewer than `COST_MIN_TASKS` (5) tasks has no median, and the line breaks there instead of reading 0.
  All time starts on the local day of the first finished task.
- **The unit.**
  It follows the tab's unit; a task with no value in it is left out and the legend counts the ones in the period.
- **Readouts.**
  Median now is the window ending now, At the start the period's first window with a median, and Change the one against the other as a whole percent.
- **Filters.**
  Projects and Kinds pick from the projects and kinds the period's tasks name, most tasks first; no box ticked is All.
  Each opens a solid menu under its row, even on the see-through window, and only one is open at a time: a press anywhere outside it, or focus moving past it, closes it.
  They start at All on every opening of the tab and stay through a new period, work or unit.
- The section shows when the work is all or task work, since the first mate and other work have no finished tasks.
- The medians are `costSeries` in `src/shared/usage.ts`, pure math over the read; Values gives each local day's window, today ending now.
- It sends no alert and changes nothing on the phone's Usage page.

## The tab

The captain's design (FI3-925, Overview): the header with the Tokens / Estimated $ switch, Period and Work, three readouts, the daily bars with their Daily values table, tokens per model beside Where it went, a model's details, and the milestone strip.
FI3-993 took the lines from between rows, grouped Where it went by project, and added Recent tasks under the milestone strip.
INF-6217's plan added Cost per task under the daily bars.

- Where it went lists the first mate first whenever the work includes it, "No activity" when it has no record, then each project by its subtotal with its kinds of work beneath it under category names (Plans, Research, Lookups and explanations, Issue reproduction, Implementation, Fixes, Maintenance, Reviews, Other task work), then other work.
  Projects and kinds go largest first in the unit shown, those with no value in it after, and names break ties.
- Recent tasks lists ten tasks, then ten more each time See more is chosen, each with Input, Output, Cache read, Cache write and Total in full in the unit shown.
  A category no record reported reads "Not available", and one some records reported says how many; in dollars only an estimate's recorded parts appear, never a total split after the fact.
  The list starts over at ten when the period or the work changes and stays as it is when the unit does; a read that fails keeps the tasks shown and offers Try again.

- The unit switch changes every amount together, within Usage only; counts stay counts.
  The core keeps it (`appearance.usageUnit`); Usage opens in estimated dollars until the captain picks tokens (`DEFAULT_USAGE_UNIT`).
  Period and Work start over at the last 30 days and all work on every opening.
- Token totals count known categories only; with incomplete coverage the total's readout says it holds reported categories only.
  Model details show each category’s reporting count beside its value, including zero reporting records.
- Estimated dollars are approximate pay-as-you-go value, never a bill, a share of a subscription, an allowance or savings; a partial total says how many records it covers.
- Milestones count finished tasks at 1, 10, 25 and 50 over all retained history, and keep the last reached after 50.
  There are no streaks, scores, notifications, token targets or anything that rewards spending more.
- A computer that controls a first mate shows that first mate's Usage, read there, and its two commands work the same (`docs/view.md`, "Settings on a view").
- It re-reads after every model response and task change while it is open.

## The cost limit

A task, and everything under it, that passes its cost limit stops at a safe point and asks the captain before it spends more (INF-3112's plan, built by INF-3131).
The limit is an amount in the same estimated dollars the ledger keeps, or no limit, and it is a ceiling, never a forecast.
The first explicit answer wins, read live: the task itself, the nearest task above it, its project, then the app (`CostLimitStore.taskLimit` and `effectiveCostLimit`).
A raised amount or No limit on a task covers its parts unless a part has its own answer.
The app's own limit starts at $50, the captain's choice drawn from their own ledger, and lives in Settings → Intelligence (`CostLimitRow.tsx`), whose row also says how many of the task families that spent anything in the last 30 days would have asked under it.
Settings → Projects adds Cost limit to the Tasks group of each repository's settings on its project's page: Follow app, Own amount or No limit, saved through `project-settings` as `costLimit` (`null`, `{ usd }`, or `{ none: true }`).
The first mate changes the app's value through the asked `cost-limit` action and a project's value through the existing asked `project-settings` action, with the same authority and trail as the controls.
Task Info shows Spend as "$12 of $50", or "$12 · No limit", in its compact fact strip.
Resting the pointer on the amount or focusing it with Tab shows the limit's source and explains that the estimate includes all parts.
It counts unpriced responses explicitly rather than calling them free, and reads through `TaskDetail.cost` from `CostLimitStore.familySpend` and `effectiveCostLimit`, never a second ledger.
An older home without this reading shows no Spend row.
An open record refreshes after model responses (including a part's), project configuration and app-setting actions.

| Piece | Where |
| --- | --- |
| The limit's shape, the default and the card's words | `src/shared/costLimit.ts` |
| The app's limit | `SettingsStore.getTaskCostLimit`, served on `inf:settings:cost-limit:get` and `:set` |
| Task and project limits, and the holds | `cost_limits` and `cost_holds`, `CostLimitStore` (`src/core/storage/costLimitStore.ts`) |
| The crossing, the card and its answers | `CostLimits` (`src/core/orchestrator/costLimits.ts`) |

- What a task spends is its own ledger records and those of every task under it, its parts, pieces and review included (`CostLimitStore.familySpend`); the first mate's own conversation counts against no task.
- After each model response is recorded, `CostLimits.recorded` walks from the outermost open task down and holds the first whose family spend reached its limit.
  A task whose limit is no limit, or whose captain's words passed the `cost-limit` hold (`docs/delivery-rigor.md`, "The holds"), is skipped.
- A hold stops every running turn in the family at its next safe point, as an update does (`stopSafely`), and holds their lanes so nothing new is delivered (`CrewFacts.laneHeld`).
  A turn already past its limit when the response arrives can spend up to one more turn's cost before it stops, and the card says so.
- The host raises one card, `card-cost-<task>`, which the first mate answers: Allow more raises the task's own limit by one step, the nearest answer above it or its project's or the app's limit, past what it has spent; No limit for this task lifts it; Stop here sends the family's started work to the backlog with its work kept.
  The first two resume each stopped turn with a `turn-resumed` row.
- The captain's words move it too: `update_task`'s `cost_limit` sets the task's own limit, `none` lifts it and `follow` returns it to the nearest answer above it, then its project's or the app's, and the `override` passes the hold for the task's current version.
- Responses the ledger could not price add nothing to the spend, and the card counts them.

## Keys

Usage works from the keyboard (`docs/keyboard.md`).
Open Usage (`settings.usage`) opens Settings at Usage from anywhere with focus on the unit switch; Switch Usage units (`usage.unit`) switches the unit and opens Usage.
Neither has a default key.
In the tab the unit switch takes the arrows, Tab reaches Period, Work, Daily values and each model; Enter or Space on a model opens its details with focus on Close details, and Escape closes them and puts focus back on the model, leaving Settings open.
Each recent task's key is a link to that task, a Tab stop of its own (FI3-1271; the design skill's core rule "Task keys"): resting on it or focusing it opens the task's summary, and a click or Enter leaves Settings and opens the task on the main view.
Under the daily bars Tab reaches Cost per task's Projects and Kinds; Enter or Space opens one, Tab moves through All and each choice and Space ticks one, Tab past the last choice closes it, and Escape closes it and leaves focus on its row with Settings open.
Its Values table, also a Tab stop, gives every day's median, middle half and task count, so nothing the line shows needs a pointer.
Tab reaches See more under the recent tasks, past their keys; Enter or Space adds the next ten and puts focus on the first of them, and the count under the list is announced.

## Tests

- `src/core/claude/claudeEvents.test.ts` ("a turn's usage, model by model"): each model's share, running totals, a resumed client's turns from its own results (`tests/fixtures/claude-resume`), a result reported twice, a client that starts over, a turn that names no model.
- `src/core/pi/piEvents.test.ts`: the listed-prices estimate and its split, and no cost for a model with no listed prices.
- `src/core/storage/usageDays.test.ts`: one daily row per day, task and model; records written after a fold, by this writer or straight into the ledger, answer as a full recount does for every period; a changed time zone counts the days again.
- `src/core/storage/usageStore.test.ts`: one row per served model; the summary reconciles days, models and where it went to one total, names models and places, groups by project and saved kind, counts finished work, filters, and answers an empty ledger; recent tasks in order, ties, limits, the period and each category's reporting; cost per task with its reviews and what sits under them, the week before the period, unpriced and silent tasks.
- `src/shared/usage.test.ts`: the sliding median, its window, too few tasks, the change, tasks left out and the Values days.
- `src/core/storage/settingsMigrations.test.ts` ("migration 66").
- `src/renderer/src/settings/usageWords.test.ts`: every printed word and number.
- `src/renderer/src/settings/UsageTab.test.tsx`: the recent tasks while a read is out, after one fails, with nothing to list, and with more to show; cost per task's line breaking where a week has too few tasks, and no line at zero.
- `src/core/storage/costLimitStore.test.ts` and `src/core/orchestrator/costLimits.test.ts`: the cost limit's spend, its 30-day count, the crossing, the card and each of its answers.
- `src/core/core.settings.test.ts`: the first mate changes app and project limits through their catalog actions, task/project/app precedence, and invalid amounts leave the saved limit unchanged.
- `tests/e2e/cost-limit.spec.ts`: the app default, project choices and persistence by keys, plus family spend and a live limit update in task Info.
- `tests/e2e/usage.spec.ts`: a real first mate turn lands in the ledger, and the captain opens Usage in dollars, switches units, filters, opens and closes a model's details and finds the unit kept after a reload, all by keys; over a seeded ledger, Where it went lists the first mate, each project and other work, and See more adds ten tasks at a time by keys, kept across a unit switch and started over by a new period.
  Over five seeded weeks of finished work, Cost per task opens in dollars, its median matches the read, a project and a kind are picked and Escape closes a filter, Values lists every day, and the filters start at All again, all by keys.
  `tests/e2e/usage.ts` holds its hooks and the seeded ledgers.
- `tests/browser/usage-cost-filters.test.tsx`: over the same five seeded weeks, Cost per task's Projects and Kinds menus close on a press outside, on opening the other and on Tab past the last choice, stay open for a choice ticked inside, and paint solid where the see-through window gives the section's boxes 55% fills.

## Historical context-shortening records

The recording fix applies to new completed calls only; opening an existing session does not replay or import its saved usage.
Historical recovery requires a separately approved import, not a migration or an automatic rewrite.
A recovery proposal must inventory app-owned saved compaction entries read-only, identify each call by session and entry ID, and verify its task, serving account, requested model and original completion time from saved facts.
Duplicate copies of a session or branch must resolve to the same call identity; a new call with identical usage is still a different call.
Only original reported token categories and cost parts may be imported, with absent categories left unknown and unpriced zero estimates left unpriced.
No model, account, tariff or completion time may be guessed from a task's current settings.
Ambiguous attribution, malformed entries and calls already represented in the ledger must be held out and listed with reasons.
The proposed import must preview affected task, day, model and project totals, retain provenance per call and demonstrate an idempotent second run on a disposable database before approval.
The current ledger has no historical compaction identity, so equal amounts or nearby timestamps alone cannot prove a call is missing or already recorded.
No historical import is implemented or authorized by the live recording fix.

## Reported thinking counts

Pi's optional reasoning count crosses the shared turn event and is stored in `usage_events.reasoning`.
It is already part of output tokens, so existing category totals and price calculations never add it again.
Missing remains null in saved records; there is no separate Usage column or historical repricing.

### Operations

Where it went groups a task whose saved deliverable is operation as “Operations”, ahead of its saved kind.
Other tasks retain their saved kinds and labels, including past lookups; no kind or usage ledger row is rewritten.

## Amazon Bedrock

Amazon Bedrock records usage per model and account using the built-in agent's listed prices.
The Subscriptions row sums known costs for that account this calendar month and labels incomplete sums as partial estimates.
Requests refused before inference do not change the estimate, and entirely unknown spend is not shown as zero.
The estimate covers only work Infinitary records, not other AWS users, credits or charges; the AWS bill is final.
