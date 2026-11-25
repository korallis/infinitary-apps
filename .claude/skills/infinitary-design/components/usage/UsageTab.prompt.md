Settings → Usage (the captain's pick on FI3-925: the Overview direction, estimated dollars offered, quiet milestones on): the model usage Infinitary records across the fleet, in tokens or estimated dollars.
A wide tab after Intelligence; on a computer that controls another it shows that first mate's usage.
What is recorded and how the numbers are summed are the app's `docs/usage.md`; this page is how they look and read.

**Header.**
The micro label `USAGE`, then one row: the `--text-sm --fg-2` line "Your first mate and your crew, across every project." on the left, and on the right a `GroupedPills` named "Show usage as" with Tokens and Estimated $.
The switch changes every amount in the tab together - readouts, bars, model rows, a model's categories, the daily values - and nothing outside it; counts stay counts.
The app remembers it; the tab opens in Estimated $ until the captain picks tokens.

**Where it is also reported.**
Under the header, when the Claude Code settings on the first mate's computer name a company's collector, one `--text-sm --fg-3` line names its host and says those settings ask for it: the crew's usage goes there (`settingsUsageReportsTo`), or only Claude work does (`settingsUsageReportsClaudeTo`).
While that collector keeps failing, its first and latest failure a minute or more apart with no batch taken between them, the same line in `--warn` takes its place, says Claude work is not reaching that host, and says why: the host keeps turning the reports away (`settingsUsageReportingRefused`), the app cannot connect to it securely (`settingsUsageReportingSecure`), or the app cannot reach it (`settingsUsageReportingUnreachable`).
The first two end by pointing the captain to the reporting settings their company gave them.
It names no certificate or connection detail, and leaves when the collector takes the work again.
When the captain has added a reporting connection in Settings → Intelligence, a second `--text-sm --fg-3` line under the company line or its warning names that connection's host (`settingsUsageReportsConnectionTo`); it shows alone when there is no company collector.

**Filters.**
Under the header, a row of two labeled selects in `--text-sm` on `--bg-2` with a `--line-1` hairline and `--radius-m`: Period (Last 7 days, Last 30 days, All recorded time) and Work (All work, Task work, First mate, Other work), then the dates in `--fg-3`: "Sep 6–Oct 5 · Local dates", or "Since Sep 6 · Local dates" for all time.
They open at Last 30 days and All work every time.

**Readouts.**
Three columns split by `--line-1` hairlines, each a `--text-sm --fg-2` label, a 26 px mono `--fg-1` number and a `--fg-3` line:
- "Recorded tokens" · "17.26M" · "Input, output and cache"; in dollars "Estimated value · USD" (or "Known estimate · USD" when some records have no price) · "$17.18" · "33 of 45 records priced".
- "Tasks finished" · "6" · "In this period and work".
- "Models used" (or "Recorded models" with older records) · "4" · "Across the selected work".

A value nothing supports reads "Not available", never 0.

**Daily usage.**
An `h3` "Daily usage" with "Tokens · Today is partial" (or "Estimated USD · Today is partial") on the right, then one quiet bar per local day, `--fg-3`, 2 px apart, rounded at the top, on a `--line-1` baseline 64 px high; today's bar is the one `--accent`.
A day with nothing recorded has no bar.
Under it, mono `--text-xs --fg-3` "Sep 6" at the left and "Today" at the right, and one `--fg-3` line: "Open a model to see its recorded usage.", in dollars with something unpriced "Bars show only priced activity.
Unpriced activity is left out.", and while the pointer rests on a bar that day's value, "Oct 3: 1.24M".
A `details` "Daily values" holds the same days as a table, Local date and the unit, a day with nothing recorded reading "No activity", its rows apart by space with no rule between them.

**Cost per task.**
Under the daily bars, when the work is all or task work (INF-6217's plan): an `h3` "Cost per task" with "Estimated USD · Median per task" (or "Tokens · Median per task") on the right, then the `--fg-3` line "Each finished task with its reviews.
A line that climbs means tasks are taking more work than before."
Then two filters, Projects and Kinds, each a dropdown row in `--text-sm` on `--bg-2` with a `--line-1` hairline and `--radius-m`: its `--fg-2` name, what it holds, "All projects", one or two names ("Website and Docs") or "3 picked", and the app's 14px down chevron in `--fg-3`, turned up while open; never the browser's disclosure triangle.
Open, it drops a solid `--bg-2` panel with a `--line-2` hairline and `--shadow-2` over the readouts and the line, the theme's opaque fill even on the see-through window: an All checkbox, then a checkbox for each project or kind the period's tasks name, its count in mono `--fg-3` at the right, most tasks first; no box ticked is All, and Reviews is never a kind here.
The choices scroll inside the panel's padding past 420px or 60% of the window, whichever is less.
One panel shows at a time: a press anywhere outside it, or focus moving past it, closes it, and Escape closes it onto its row.
Three readouts in the tab's readout shape: "Median now" · "$3.10" · "12 tasks in the last 7 days"; "At the start" · "$2.37" · "Window ending Sep 6"; "Change" · "Up 31%" (or "Down 12%", "No change") · "Over the period shown".
Then the line, drawn by hand 200 high in the 750 wide frame: three `--line-1` hairlines with mono `--text-xs --fg-3` values on the left, the middle half as an `--accent-dim` band and the median as a 2 px `--accent` line over it, "Sep 6" and "Today" under it.
A week with fewer than 5 finished tasks has no point: the line and band break there, and a selection with none at all reads "Too few finished tasks in this selection to draw a median.
Each point needs at least 5." instead of a line.
Under it one `--fg-3` line: "Each point is the median of the tasks that finished in the 7 days before it.
The band holds the middle half of them.", adding "3 tasks with no estimate are left out." when some are; while the pointer rests on the line a `--line-2` hairline and an `--accent` dot mark that point and the line reads "Oct 5, 3:00 PM: median $3.10, middle half $1.80 – $5.25, 12 tasks".
A `details` "Values" holds each local day's window as a table: Local date, Median, Middle half and Tasks, today last, a thin window reading "Not available" and "Too few tasks".

**Tokens per model and Where it went.**
Two columns, the models wider; in a narrow window they stack.
Each is an `h3` with the unit on the right ("Tokens per model", or "Estimated dollars per model") and rows apart by space, never by rules (FI3-993: "too many lines"): a name in `--fg-1`, a `--fg-3` line under it, the mono value at the right, and for a model a 3 px `--fg-3` bar on a `--bg-3` track across the whole row, scaled to the largest.
A model's name is a button that turns `--accent` on hover and while its details are open; its line is the provider, with "· Recorded model" for older records.
Models sort by the unit shown, a model with no value in it last.
Where it went lists the first mate ("Your conversation") first whenever the work includes it, reading "No activity" when it has no record.
Then each project: its name as an `h4` in `--text-sm --fg-1` with the mono subtotal at the right over a `--text-xs --fg-3` "Subtotal", and beneath it, indented by `--space-3`, a `--fg-2` row for each kind of work - Plans, Research, Issue reproduction, Implementation, Fixes, Maintenance, Reviews, Other task work - never repeating the project's name.
A task whose project is gone sits under "Project unavailable".
Projects and kinds go largest first, `--space-4` between projects and no box around them.
Other work ("No task available") comes last, then the line "Each subtotal includes the model calls made for its tasks."

**A model's details.**
A model's button opens a `--bg-1` panel under the two columns, `--line-2` hairline, `--radius-s`: its name, "Codex · Token breakdown" (or "Estimated USD breakdown"), and a small secondary Button "Close details" on the right.
Then four cells - Input, Output, Cache read, Cache write - each a `--fg-3` label over a mono `--fg-1` value, two by two in a narrow window; a token category no record reported or an estimate no record splits reads "Not available".
In tokens each cell adds its reporting count in `--fg-3`, such as "1 of 2 records", including "0 of 2 records" for an unreported category.
An older home without category counts shows "Coverage not available", never an inferred count.
Then `--fg-3` lines on how it is named ("Named by the provider that answered.", "Named by the model the app asked for; the provider did not say which model answered.") and, in dollars, where its estimates came from ("Estimates use the model's listed prices when each response was recorded.", "Estimates are Claude's own, made for each response.", "Estimates use the cost the provider reported for each response.") and "30 of 30 records priced.", then "Its work" in Where it went's shape.
Close details or Escape closes it and puts focus back on the model's name.

**Milestones.**
After a `--line-1` rule: a 40 px circle in `--line-2` holding a `--fg-2` check once a task has finished, beside "18 tasks finished · Next milestone at 25" in `--fg-1` and "All retained history.
Progress comes from finished work, not more tokens." in `--fg-3`.
The stops are 1, 10, 25 and 50 finished tasks; before the first it reads "No tasks finished yet · First milestone at 1", and after 50 "62 tasks finished · Reached 50".
It rewards finished work only: no streak, score, notification, target or anything about spending.

**Recent tasks.**
Under the milestones: an `h3` "Recent tasks" with the unit on the right, then `--fg-3` "Newest tasks first · Amounts in the selected period" and, in tokens, "Input excludes cached tokens.
Total counts each category once."
(in dollars "Category estimates use recorded prices only.
Their coverage can differ from the total.").
A `--text-xs --fg-3` head row names the columns: Task, Input, Output, Cache read, Cache write, Total.
Each task is a row apart by space: its title in `--fg-1`, "Website · " and the mono key in `--fg-3`, and "Created Oct 5, 3:12 PM" in `--fg-3`, beside five mono figures at the right, the Total in `--fg-1` weight 500 and the rest in `--fg-2`.
Tokens are written in full, "6,800,000"; a category no record reported reads "Not available", one some records reported carries "1 of 2 records" under it in `--text-xs --fg-3`, and a `--text-xs --fg-3` line across the row says what the figures leave out ("The total counts recorded tokens only; some categories were not reported.", "No estimate here is split by category.").
Under the list, the count in `--fg-3` at the left ("Showing 10 of 23 tasks", "All 23 tasks shown") and a small secondary Button "See more" at the right while more match; it adds ten and puts focus on the first of them.
When the tab is narrower than 850 px the figures go under the task, each with its label above it, and narrower than 540 px two to a line with the Total across the last.
Nothing to list reads "No task usage in this selection."; a read that fails says so beside a small secondary "Try again", keeping the tasks shown.

**Nothing recorded.**
Under the filters, centered: "No recorded activity" in `--fg-1`, then "Usage appears after the first mate or a crewmate finishes a model response." and "Nothing here means no records, not a measured zero." in `--fg-3`; the milestones and the recent tasks stay.

Words never shown: bill, billing, savings, budget, quota, allowance, request, turn, leaderboard, streak.
