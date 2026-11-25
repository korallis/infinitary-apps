---
name: personal-panel
description: How a personal panel should look and read - the component library, the design rules it inherits, the shapes that keep it calm, and the checks to run before reporting. Read this before writing or changing a panel in this workspace.
---

# Authoring a personal panel

You are building a surface the captain asked for, in his own app, while he
watches it appear. It has to look like the app, not like a widget bolted onto
it. Everything below exists to make that automatic.

This file is the one copy of how a panel is built: its shape, what the compiler
admits, the store, actions, cards, presence, what it should look like, and the
checks before you report. Look up a type you use in `infinitary-env.d.ts` beside the workspace
instructions (the `@infinitary/contracts` module). Do not read that file from
top to bottom.

The visual rules a panel needs are in this file. The design skill next to this
one (`.claude/skills/infinitary-design/`) is the same skill the crewmates
who build the app follow. Open `tokens/` when you need a token, and the
component file for a component you are unsure of. Do not read `readme.md`
unless the panel draws the character, the crew, or the first launch.

## Shape, imports, store and actions

An extension is one directory `<id>/` (kebab-case: `open-prs`, `tokyo-clock`) holding:

- `panel.tsx` - default-exports a React component. The host renders it inside its own panel
  chrome (title, collapse, the "yours" mark) on a rail. It receives `PanelProps`: the
  extension's `id`, its `store` (already bound to the extension), `invoke` for its own
  server actions, `reads` for the app's own data the manifest declared, the current
  `theme`, `cards` for its cards on the stack, `asks` for its header buttons' presses,
  `point` and `view` for the captain's tasks, `keys` for its own commands' keys, `tasks`
  when it asks for moves, `settings` when it names settings in `actions`, and `rail`.
- `cards/<view>.tsx` (optional, any number) - card views: each default-exports a component
  the host renders as one of the extension's cards on the main card stack (below). A view
  gets the same `PanelProps` plus `card`, the card it draws, and no `rail`.
- `server.ts` (optional) - exports `actions` (name to handler) and `background` (name to
  task). It runs in a process of its own, beside the app, with the app's own privilege: use
  it for anything that reads the machine or runs a command. It runs only when
  `manifest.json` says `"api": 2`. A service outside the captain's projects (GitHub, a
  calendar) is reached through its integrations, never fetched (below).
- `manifest.json` (optional) - `api`, `title`, `placement`, `order`, `size`, `presence`,
  `cards`, `header`, `commands`, `reads`, `integrations`, `moves`, `actions`, `origin`; see `PersonalManifest`. A panel
  with a `server.ts` sets `"api": 2`.
- a `.css` file (optional) - a stylesheet of its own, imported as text (below).
- local helper files, used only by this extension.

The host compiles every file on save and refuses anything off this list, naming the file:

- `panel.tsx` and the files it reaches: `react`, `react/jsx-runtime`, `@infinitary/ui`
  (the app's own component library), local files inside the extension directory, and a
  local stylesheet as text: `import styles from "./board.css"`, then `<style>{styles}</style>`.
- `server.ts` and the files it reaches: `node:*` built-ins, local files inside the
  extension directory.
- Either: `import type { ... } from "@infinitary/contracts"` - types only.

No npm packages, no path outside the extension directory (a `..` or a symlink is the same
escape), no dynamic `import()`. A refused file leaves the panel absent until it compiles.

Every extension has its own slice of the app's store, JSON values by key: `store.get`,
`store.set`, `store.delete`, `store.list(prefix)`, and `store.subscribe` in the panel;
`context.db` with the same four methods in `server.ts`, each returning a promise: `await`
every call, as in the panel. A write is kept once its promise resolves. A key is at most 128
characters, a value at most 256 KiB of JSON, a slice at most 1 MiB. Keep secrets out of it.

A panel calls `invoke("name", input)` to run `actions.name(input, context)` in the core and
get its return value. A background task `{ everyMs, run }` runs on the host's timer whether
or not the panel is open; the host clamps anything under 60 seconds up to 60 seconds, never
overlaps a run with itself, and logs a throw without stopping the timer. The usual pattern:
the task writes to the store, the panel subscribes to the store.

What `server.ts` says goes to the panel log, `logs/panels.log` in the app's data folder,
two folders above this workspace (`../../logs/panels.log`): every `context.log(message)`,
every line it prints with `console.log` or `console.error`, a throw the host logs, and the
app's own lines about the panel, such as why it stopped. Each line starts with its time and
names the panel. Read it when a panel misbehaves, before guessing; once it grows large the
file moves aside to `panels.old.log`.

The app watches `server.ts` from outside. Code that never gives its loop back - a loop that
cannot end, a blocking wait - for ten seconds, or a process that ends on its own, is
stopped: its actions are refused, its panel shows that its background work stopped with a
Retry, and it stays stopped through restarts and through your next save until the captain
presses Retry. Its store stays as it was. A slow `await` (a fetch, a command) is never
stopped. When you fix a stopped panel, say so in your report: the captain's Retry starts it.

## Services outside the captain's projects: integrations

A panel reaches GitHub, a calendar or any other service outside the captain's projects the
way the first mate and a crewmate do: through the connections the captain made in Settings ->
Integrations, never with a fetch, a key or a sign-in of its own. Name each one in
`manifest.json` `integrations`, with the actions it calls, the events it hears, and why, in
one sentence the captain reads on the approval card:

```json
"integrations": [
  { "integration": "github", "actions": ["read"], "why": "Shows the checks on your open pull requests." }
]
```

`props.integrations` in the panel and `context.integrations` in `server.ts` have `list()`,
`show(name)` (the actions it names, each with its input's JSON Schema) and
`call(name, action, input)`, answering `{ text }` or `{ text, refused }` exactly as the agents'
calls do (`PanelIntegrations`); a call the manifest does not name is refused, and the
compiler refuses a literal one. Each action follows its own rule in Settings: an action that
asks the captain answers that it waits on the approval card, and the window draws a line
above the panel with Ask again; once the captain chooses Always allow, its next call runs, so
show that state calmly and try again on the next run rather than looping. A panel's calls
spend no task's allowance.

`on(name, event, listener)` hears an event the manifest names (`"events": [...]`): the app
looks on that event's own cadence and hands over what arrived since, `{ id, summary }[]`; the
same items wait in the store under `integrations:<name>/<event>`. Words from a kind the app
keeps only for a while leave the panel's store with that kind's days, so rewrite what you keep.

## The app's own data, tasks and cards

`reads` in `manifest.json` names the app data the panel is served: `quota.snapshot` (the
latest quota reading across signed-in accounts, or `null` before the first), `tasks.board`
(open, underway and recently closed work with the projects' counts), `tasks.detail` (one
task in full, by id), `tasks.search` (every task a key or title finds, closed ones
included), `feed.recent` (the activity log, oldest first), `forge.changes` (the
captain's open pull requests) and `automation.list` (his automations - the prompts the first mate
gets on a schedule - with each one's state and next run). In the panel, `reads.subscribe(name, listener)` - or
`reads.subscribe("tasks.detail", { id }, listener)`, `reads.subscribe("tasks.search", { query },
listener)` - delivers the current value at once and
again on every change, and returns the unsubscribe; a name the manifest did not declare
throws. Values are read-only and typed in `infinitary-env.d.ts` (`PanelReadValue`). A server
module has no reads.

`settings.current` reads the captain's app settings a panel may show, by name: declare it in `reads`, then call `reads.subscribe("settings.current", { names: ["ambient-music", "theme"] }, listener)`.
Each name delivers its value (`PanelSettingValues`): `ambient-music` is `{ on, paused, style, volume }`, `theme` is `{ theme }`, and `font`, `window-wash`, `window-size`, `crew-model-names`, `notifications`, `cost-limit`, `summary-point`, `personal-resources` and `panels-switch` read the same way.
Any other setting is unreadable: settings that name projects, computers, accounts or sign-ins never reach a panel.
Naming one does not throw: the host refuses the read, the panel's console logs the refusal, and the listener is never called.
Only an undeclared read throws at the call.

`computers.resources` is the shared live CPU and RAM read: declare it in `reads`, then call `reads.subscribe("computers.resources", listener)`.
Its `computers` array names the home with `computerId: null` and each paired work computer by id and label.
A fresh `reading` carries `ageMs`, `memoryUsedBytes` when the reading has a figure, and an `observation` with CPU idle fraction, logical CPU count, installed memory and Mac pressure.
Show `memoryUsedBytes` divided by installed memory as RAM used, and installed memory minus the figure as free.
A missing figure is unknown: show RAM as unavailable, never as zero and never by adding the raw counts.
`memoryPressure` is an optional Mac fact (`normal`, `warning` or `critical`); absent is not zero and not a capacity number.
These are computer readings, not task limits or guaranteed capacity.
All screens and panels share one sampling source; do not add a server poller or write live refreshes to the store.
Unsubscribe when the view goes away.

A panel that reads `tasks.board` points at tasks by the ids it gave, or a closed one its own
`tasks.search` found: `point.openTask(id)` opens one as a Tasks row does,
`point.openRecord(id)` opens its record even while its card waits, `point.peekTask({ taskId, box })` (the row's box from
`getBoundingClientRect()`, or `null` to let go) opens its crew summary beside the panel, or in a card beside that row,
`point.showCard(waitingCardId)` brings its waiting card forward, and in a card view
`point.aim(id)` makes the captain's next message about that task while the card is shown
(`point.aim(null)` lets go, with no click needed).
`view.openTaskIds` and `view.shownTaskId` say which tasks he has open. With `"moves": true`
in `manifest.json` it also gets `tasks.run(id, move, review?)`, one of `start-task`, `start-again`,
`stop-task`, `continue-task`, `drop-task`, `queue-task` and `unqueue-task`, answering
`{ ok: true }` or `{ ok: false, text }` in the app's words; a live or dropped work row's `moves` says
which it allows now and why not, and a never-started `drop-task` sends the keys of the
row's `tasks.detail` `dropEffects` as its review. Opening, showing, aiming and moving count
only from the captain's own click or key in the panel or its card; otherwise they do nothing
and answer `false` (a move answers why). Merge and discard are never moves.
With `"actions": ["theme", "window-size"]` in `manifest.json` it gets
`settings.change(action, value)`, which changes one of those settings the way the first
mate's `app_change` does, with the same value (`PanelChangeSetting` lists the settings a panel
may name). It counts only while the captain's own click or key is in the panel, as a move
does, and answers `{ ok: true }` or `{ ok: false, text }` in the app's words; the feed names
the panel. A panel drawn on another computer's window or the phone gets no `settings`.
Any panel, whatever it reads, may start the captain's next message: `point.draft(words)`
puts one line at the head of the message field for him to finish, from his own click or key,
and sends nothing. Any panel may also open Settings from his own click or key:
`point.openSettings(section, item?)` opens a section by id (`automation`, say) and hands it
an item to show, such as an automation's id; it answers `false` for a section this window
does not offer.

`sql` in `manifest.json` names the published views of the app's record the extension may
query, by their versioned names (`"sql": ["v_usage_v1"]`). In the panel,
`reads.subscribe("sql", { sql, params }, listener)` runs one read-only SELECT over those
views and delivers the answer again whenever the record changes; in `server.ts`,
`await context.sql(sql, params)` asks once. The answer is `{ columns, rows, truncated,
elapsedMs }` or `{ refused, message }` (`SqlAnswer`). A manifest naming a view this
version does not publish mounts nothing. The views, their columns and the rules for
showing what they hold are the `usage` skill's.

An extension puts up cards on the main card stack, beside the captain's other cards, with
`cards.emit({ id, view, title, width, height, data })`: `view` names a file in `cards/`,
`width` is `regular`, `wide` (the default) or `full`, `height` is `content` (the default,
the card as tall as its view) or `fill` (as tall as a card may be, the view scrolling inside
it), and `data` (JSON, at most 3,072 bytes) reaches the view as `card.data`. It resolves to
the card's id. Emitting again with an open card's id revises that card in place, and its view
re-renders with the new data and one more `card.revision` (from 1), so a view hears each time
it is put up even with the same data; `cards.close(id)`
takes one down and `cards.open()` lists them. Any number may be open, at most 50 at once. A
card emitted from the captain's own click or key in the panel or a card comes to the front;
one emitted otherwise (a store change, a timer) waits behind the card he is reading, marked
new. The host draws each card's title row and Hide; Esc hides one unless its own field used
the key (`preventDefault`). Nothing about a card is saved: a relaunch, Hide, removing the
extension or turning the panels off takes it away.

Only the shown card runs, so paging away and back starts its view again. `card.keep(value)`
(JSON, at most 4,096 bytes) keeps its place - a scroll, a tab, what Find holds - until Hide,
and `card.kept` hands it back as the view starts: `useState(card.kept?.query ?? "")`.

`manifest.json` can name cards for the app to put up itself, so they work while the panel is
collapsed: `"cards": { "reader": { "view": "reader", "title": "Reading" } }` (its name is its
id); `"header"` buttons (at most three, `{ id, icon, label, emits?, data? }`, icons `open`,
`search`, `add`, `list`, `note`, `filter`, `clock`, `chart`) drawn in the panel's header; and
`"commands"` (`{ id, label, emits | presses, data?, key?, words? }`, `words` up to eight more
one-word terms search matches) listed in command search under the panel's title. A button or
command that `emits` puts up that named card, and its button is drawn while the panel is
collapsed too; a button that emits nothing, or a command that `presses` it, opens the panel
and reaches it through `asks.subscribe((button, via) => ...)` with the button's id and `via`,
`"click"` or `"key"`, and its button is drawn only while the panel is expanded.
`asks.onFocus(listener)` hears the keyboard moving into the panel (F6): put focus where a
person starts in it. `key` suggests a shortcut as a Mac writes it
(`"⌘J"`); the app gives it only when no other command already uses it. A name in the manifest
that points at nothing it has is reported and its cards, buttons and commands are left out.
`keys` holds the key each of its commands has now, by command id, as this computer draws it
(`{ keys: "⌃⌘J", "aria-keyshortcuts": "Control+Meta+J", "data-key-command": "find" }`), and
changes when the captain changes one in Settings → Keyboard: spread it onto the control that
does the same, as `<Button {...keys.find}>`, `<IconButton {...keys.find}>` or
`<RowMenu {...keys.move}>`, so the control names its key and a mouse click on it shows that key
at the bottom of the window. On a search field pass only its `aria-keyshortcuts`, never the
whole entry: a click into a field is a click to type, not a time to name its key. A command
with no key is not listed.
Reach every control with Tab, or the arrows inside a list, and draw the focus ring.

## Presence and what the host owns

A panel keeps running while its dock is collapsed: `rail.collapsed` says so, and
`rail.summarize([{ text: "2 waiting", strong: true }, { text: "1 working" }])` (at most three
parts of at most 32 characters, `null` to clear) is drawn in its collapsed header. One part may
be a line instead, the newest thing it holds: `{ line: "merged", lead: "FI3-12", tone: "ok" }`
(at most 500 characters, a lead of at most 32, a tone of info, ok, warn, danger or you) takes the
title's place while it shows, rises in when its words change, and opens the panel on a click.

Whether it shows at all: `"presence": { "store": "items", "when": "nonEmpty" }` shows the
panel only while that key holds something (not `null`, `""`, `[]` or `{}`);
`"presence": { "code": true }` lets its own code decide with `rail.show(true | false)` - it
starts off its rail, running out of sight, until it says `show(true)`; off it,
`rail.show(false, "Nothing to read yet")` (at most 60 characters) is what command search says
beside a command that would open it. With neither, the panel shows whenever it compiles.

The panel title, the collapse control, the attribution mark, the rail width and placement
are the host's; a rail holds any number of panels. A panel styles only its own body, from the
design tokens (`var(--fg-1)`, `var(--space-2)`, ...) and `@infinitary/ui`.

## What a panel is

A small, calm column docked on a side rail. It shows what IS. It is display
and pointing: it renders data, and a click at most brings something forward.
Every write still happens by talking to the first mate - except that a panel which
asks for moves may queue, start or drop one of his tasks on his own click,
and then it says in the row what the move will do before he makes it, and one that
names settings in `actions` may change one of them on each of his own clicks.

**Its title is host chrome.** The host draws the title from `manifest.json`,
with the collapse control, the "yours" mark, and a quiet dot while a task on
this panel is running. Never draw your own title bar, close button, border or
card around the body. You style the body region and nothing else.

A panel is never a dashboard. One idea, a handful of rows, a number the eye
finds in a second. If it needs a heading to explain itself, it is too big.

**What is bigger than a rail goes on a card.** When the captain needs room -
a board, a week, one item's notes - the panel opens one of its own cards on
his card stack instead of growing. The host draws the card's title row and
Hide, exactly as it draws the panel's; the card view styles its body only,
from the same library and the same rules as a panel, and never draws a second
title or a close of its own. Open a card from his click; one a panel opens on
its own waits behind what he is reading, so keep those for news he would want.
The look is the design skill's `components/cards/PanelCard.prompt.md`.

**Collapsed, it still speaks.** What the header says while the panel is
folded is a count or two, never a sentence: "2 waiting · 1 working", with the
one that needs the captain marked strong and nothing strong when nothing
does. Say nothing rather than "0 items"; hide the panel rather than show an
empty one.

## The library

`@infinitary/ui` is the app's own components - literally the modules the app
renders with, served from the host - so a panel cannot drift from the app even
by a pixel. Build from these before you write your own markup:

| Component | Use |
|---|---|
| `Row` | One list row: a status dot, a title, one trailing datum in mono. The row every list is built from. |
| `FeedLine` | One line of an event log: the text, and the kind over its age at the right. |
| `MicroLabel` | The uppercase tracked label that names a region, with an optional mono count. |
| `Empty` | One quiet line where a list would be. |
| `Disclosure` | A region that shows only its count until it is clicked. |
| `StatusDot` | State as one 6px dot: `ok` / `ring` / `warn` / `danger` / `idle` / `busy`. |
| `Badge`, `KeyCap`, `Switch`, `Input`, `Button`, `IconButton`, `RowMenu` | The controls, when a panel genuinely needs one. |
| `QuotaMicroMeter`, `QuotaMeter`, `SlotBadge` | Quota, in the app's own instrument. |
| `TaskStatusMark` with `taskStatusOf`, `taskStatusLabel` | A task's status mark and its words, exactly as the Tasks panel draws them. |
| `nowGroupOf`, `NOW_GROUP_LABELS` | The lane a task belongs in and the lane's name, as the Tasks panel and the board say them. |
| `focusWithRing`, `useInPlaceReveal` | The keyboard's ring when your code moves focus, and the drift a group opens with. |

A stylesheet of your own (`board.css`) is for layout: grids, gaps, columns.
Every color, size and radius in it is still a token, and the lint reads it
like any other file.

`CardStack`, `ResponseCard`, `SubscriptionCard` and `VoiceInput` are the
stage's furniture. They are exported because the library is one barrel; they
are not panel material, and a panel that renders one looks broken.

```tsx
import type { PanelProps } from "@infinitary/contracts";
import { Empty, MicroLabel, Row } from "@infinitary/ui";
import { useEffect, useState } from "react";

export default function Panel({ store }: PanelProps) {
  const [prs, setPrs] = useState<Pr[]>([]);
  useEffect(() => {
    const read = () => void store.get("prs").then((value) => setPrs(asPrs(value)));
    read();
    return store.subscribe(read);
  }, [store]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
      <MicroLabel count={prs.length}>Open</MicroLabel>
      {prs.length === 0 ? (
        <Empty>No open pull requests</Empty>
      ) : (
        prs.map((pr) => <Row key={pr.number} title={pr.title} tone={pr.checks} trailing={`#${pr.number}`} />)
      )}
    </div>
  );
}
```

Read the store, render it, and subscribe for changes. Never poll from the
panel; never fetch from it.

## Tokens only, and why

Every color, type size, space, radius, shadow and duration is a CSS variable
the app already defines: `var(--fg-2)`, `var(--text-sm)`, `var(--space-2)`,
`var(--radius-s)`, `var(--shadow-1)`, `var(--dur-fast)`. The whole scale is in
the design skill's `tokens/`.

The reason is not tidiness. The app ships a dark and a light theme and the
captain switches between them; a literal `#8a93a8` is right in one of them at
most, and wrong the moment the palette moves. A token is right in both. The
lint names the nearest token for any raw value, so the fix is one
substitution.

Layout numbers that are not on a scale - a 56px meter, a 6px dot - are fine as
plain numbers. Colors, type sizes, radii and shadows are not.

## One accent per panel

The app has exactly two chromatic families: ice cyan (`--accent`, calm) and
ember (`--hot`, `--danger`, hot). Inside one panel, one family lights the one
thing that is most current; everything else is `--fg-1` / `--fg-2` / `--fg-3`.
`--ok`, `--warn`, `--danger` and `--idle` are for real state - what something
IS - never for decoration or emphasis.

## Words and numbers

- Sentence case everywhere, including buttons: "Add a note", not "Add A Note".
- Micro labels are the exception: uppercase and tracked, through `MicroLabel`.
- Numbers, keys, percentages, times and ids are mono. `Row`'s trailing slot
  and `FeedLine`'s age already are.
- Calm and factual: no exclamation points, no cheerleading, no "Oops".
  The tested subject panel alone follows the lessons guide's warm voice.
- **No emoji.** Not in copy, not as a status icon, not in a title. A
  `StatusDot` says what a green check would, in the app's own voice.

## Shapes that stay calm

- **An empty panel is not on the rail at all.** That is what `presence`
  declares, not something you draw: no "all clear" box, no empty card. Use
  `Empty` for a SECTION that is empty inside a panel that is not.
- **No spinner.** Until the first value lands, render the empty state.
- **No motion.** A panel does not animate, pulse or slide. The only movement
  is a number changing.
- **No captain-facing machinery.** The words "extension" and "plugin" never
  appear in what a panel renders.
- **Nothing that writes the app.** No merge button, no "start this task", not
  even a control that "just asks the first mate". Talking to the first mate is how the
  captain writes.

## Where a panel's data comes from

Two places, and the skill for the data source you need (`github-prs`, `quota`,
`tasks-and-feed`, `clock-timer-scratchpad`) says which:

- **Outside the app**: its own `server.ts`, which runs in a process of its own
  with the app's privilege - run a command, read the machine, fetch. It writes the
  store; the panel renders the store; a background task keeps it fresh on the
  host's timer (never hotter than once a minute).
- **The app's own data** - quota, the task board, the activity feed - arrives
  through `reads`, declared in `manifest.json` and handed to the panel as a
  prop. A read is pushed on change and is read-only; a panel renders it and
  never keeps a second copy of it in the store. Declare only what the panel
  shows: an undeclared read is not served, and reaching for the app any other
  way is refused.

## Before you report

- `lint_panel` reads your files and answers with findings. A **refusal** is
  not mountable - fix it. A **warning** names the nearest token - take it. A
  **note** is a shape worth a second thought. When the extension does not
  compile, the compiler's verdict follows the findings.
- `capture_panel` screenshots the panel at rail width, dark and light. While
  you work it photographs your draft, drawn out of sight; the captain's rail
  keeps the version he had. Look at both. A panel that reads well in dark and
  turns to mud in light is not done; that is almost always a raw color.
- `place_panel` puts your version on the captain's own rail and answers with
  what his window did with it: drawn, or why not - another panel already holds
  its id, its module would not import, its body threw, its presence rule finds
  nothing to show, his layout hides it, or his rail is too short and folded it
  to its header or gathered it into the rail's More row. Then `capture_panel`
  again photographs it docked, as he sees it. Place it and look at it before
  every report, the first build and every change. Until you place it or
  report, the captain's rail keeps the panel's last commit and your version runs out of
  sight; a new panel is on no rail at all. It answers per panel in the
  window's own word: drawn (on which rail), collapsed, folded or in the More
  row, loading, stopped drawing, off its rail, hidden by the captain, or
  refused, with its reason. The placed version shows with the running dot
  until your report commits it; a save after placing runs out of sight again
  until you place again.

If the window drew it, report in one line what the panel does. If it folded it
for room or gathered it into the More row, the panel is built and on his rail,
which is only too short to show it all: report what the panel does and where
it sits, and never collapse, move or hide his other panels to make room. If it
did not draw it and the reason is in your files, fix them and place again; an
id another panel holds is a folder to rename. If the reason is outside your
files - his layout, his panels switched off - never move, hide or remove his
other panels. Report in plain words that the panel is built but not on his
rail, and why, with `waiting_on_captain`, so the task waits for him instead of
closing as done.

## What is refused

- An emoji, anywhere, including the manifest's title.
- An external URL in panel code: the renderer half loads nothing from the
  network. Fetch in `server.ts`, write the store, render the store.
- A direct reach for `window.infinitary` (or its older name, `window.firstmate`): the panel is handed `store`,
  `invoke`, `reads`, `id` and `theme`.
- An import that is not on the compiler's list in this skill.

## Fixing forward

There is no keep, no discard and no undo. The captain asks, you change the
files, place them on his rail to look, and your report keeps the change. "Make the rows smaller"
is a change to the panel you already wrote; "put it back" is another. Every
turn is a commit, so the history is the record.

## Updating a panel written for an earlier panel API

When the app stops serving the panel API a panel's `server.ts` is written for, it refuses
that file before any of it runs: the panel still draws, its saved data stays as it was, and
the window says its background work is paused, with an Update panel button for the captain.
The refusal names this section. Update the code, never the saved data:

- From API 1 (a manifest with no `api`, or `"api": 1`) to API 2: `context.db.get`, `set`,
  `delete` and `list` now return promises. Make each action, background task and local
  helper that touches `context.db` `async`, `await` every call, including those in helper
  files, and set `"api": 2` in `manifest.json`.

Keep what the panel does as it was. Run `lint_panel` and place the panel: once the app
accepts the file, the line on the panel goes and its background work starts on its own,
with no Retry.

## Tested lesson panel

`parts/lesson/` holds the tested subject-panel template the Lessons runbook uses after a finished round.
It is inert source in this workspace-owned authoring skill, not runbook guidance and not a mounted panel.
Keep the folder together when copying it: its imports are relative, and the lesson guide names the record path and title to fill in.
