# Routing

How a crewmate's model is chosen: the capability, premium and slot boundaries around the ladder, the computed tier, escalation, and same-tier order.
Model lists are `docs/model-lists.md`; decision models are `docs/decision-models.md`; the kind is `docs/kind-classifier.md`.

## Choosing a model

A model named for the task is tried first, then the eligible pins in the saved order, then a review's preferred model, then models ranked by the task’s level and available allowance.
A review's preferred model (`review_model`, the reviewer question's pick from the standing directions, `docs/decision-models.md`) is taken only while it passes the ladder's own per-model checks (`preferenceMiss`), and otherwise the ladder chooses as if it were not set.
The first mate’s own model is chosen separately in Settings → Intelligence.
`TaskPlacement.routeTask` uses the same capability, allowance and premium rules on every start and records the result in the task’s model explanation.
There is no global switch for model choice or requested recovery moves.

On upgrade from Dynamic routing Off, saved pins remain inactive until restored in Settings → Intelligence → Models.
Projects previously set to Automatic stay at home until you choose Automatic again under Projects → Runs on.
Unstarted tasks with their own or inherited Automatic request stay at home; existing device choices and committed placements are not changed.

## Pictures

A crewmate's first turn carries the captain's pictures its brief draws on (`docs/task-capture.md`, "Pictures stay with the task"): the task's own, those of the work its brief carries forward, and those of the message that started it.
Routing reads the same sources (`briefCarriesPictures` in `src/core/orchestrator/crewBrief.ts`) and sets the turn's `needs.images` when any of those pictures still has its saved copy.
Every start routes with it: a queued or spawned task's dispatch, Automatic's comparison of computers, and a review or repair assessment, whose basis is the builder whose pictures ride its brief.
A candidate whose def takes text only is then skipped with its reason on the routing record (`src/core/routing/capability.ts`), so the task starts on a model that reads pictures instead of failing when its first prompt refuses them.
When that skip drops the task below the level it asked for, or finds nothing there, and every model placed at that level reads text only, whatever its allowance, the route says so (`RouteResult.picturesUnread`, set by the engine beside `emptyBucket`, also a line in the routing reasons).
A model there that reads pictures but has spent its allowance comes back at its reset, and so does one no def describes, so then the words stay the allowance's.
The feed's downgrade line then says none of that level's models can read the pictures the task carries, a premium ask or a stronger-model retry is held with `held: no <level> model reads pictures`, and the first mate's `reasoning-wait` wake says no quota reset starts it: it waits until a model that reads pictures is placed at that level, unless the first mate starts it lower.
That hold's gate carries its cause (`TaskGate.cause`: `pictures`, or `empty` when no model is placed at the level), so the task's record says the same in its attention box, its wait and its queue line rather than naming the level's allowance (`docs/task-record.md`, "A held task says why"); a hold whose cause changes sets the gate again.
Whether a model reads pictures is the catalog's own label: its def lists `image` among its input, and a custom connection's model does only once its check proved **Reads pictures** (`docs/custom-api.md`).
A model no runtime knows, such as Claude on its own client, is unknown rather than text only, so it stays a candidate.
A pin bypasses the check as it bypasses the ladder: a model named for the task takes it, and its first prompt still refuses pictures it cannot read.
Every model move of a task whose brief carries pictures routes with the need too (`TaskMoves.planMove`), so it moves only to a model that reads them, even when its first turn, pictures and all, was never delivered.
A move to another computer checks before it moves that the destination serves the task's current model; the new conversation it opens there then follows "A model that left every level" below, which can route it to another model there.
Making pictures is not a routing need.

## Models no allowance is read for

A model whose allowance nobody reads has no quota-catalog row: a checked custom connection's, OpenRouter's (billed by the token), and a computer's own model this Mac's catalog lacks.
Routing admits such a model by its slot alone (`allowanceless` and `unowned` in `src/core/routing/routingEngine.ts`), in the unknown band, so a measured subscription in the same slot comes first; the account selector then picks the account that serves it, as for any model.
An install signed in only to OpenRouter has nothing placed, so the slot record's fallback places OpenRouter's listed aliases at medium and a crewmate starts on one under that key (INF-2523).
Beside a subscription whose starter models are placed, OpenRouter's models arrive off and route only once placed or named; if that subscription's account is withheld, the same fallback reaches them.
A provider the app does not offer, such as one in the base engine's own `models.json`, is still never a choice.
Before any allowance is read, the quota catalog is empty: at launch until the first reading lands, or while none lands.
Then every offered model's allowance is unknown, never zero, so routing admits a subscription's placed models by their slot alone too, ahead of a model nobody reads in the same slot, as their catalog rows would once a reading came back unknown (INF-2654).
Once the catalog has rows, a model it lacks keeps out and a spent one stays spent.

Models no allowance is read for take turns inside a slot (INF-3782): nothing ranks one above another, so when the slot's leader is such a model, the start goes to the one among them whose newest chosen routing row is oldest, and a model never chosen goes first, in list order.
Only models a person placed take turns (`ModelSlots.routable`'s `placed`); models the slot record's fallback placed keep list order, so an install signed in only to OpenRouter does not scatter its crewmates across that whole catalog.
A subscription in the same slot with a reading, or whose reading has not landed (above), still comes first, and an older model of a line among them sits out as same-line recency says.
`Router` reads each one's newest chosen routing row (`DecisionStore.lastChosenIds`, seeking `decisions_routing_model_recent`) and passes them to the pure engine as `turns`.
Every start, review, move, Automatic placement and named or pinned pick writes a routing row, so it counts as that model's turn, and each runs inside `Router.inOrder`, so the next one sees it; a restart keeps the turn because the record does.
A preview writes nothing and never advances the turn; a resume keeps its model while a level holds it ("A model that left every level" below), the first mate's model is picked once and kept, and the decision-model walk (`orderCandidates`) keeps pool order.
Such a choice records `decidedBy: runway-order` with `selection.turns`, and the models that took turns as candidates in the unknown band, so Why this model lists them and says they take turns.
When routing finds no model for a local start, the local runtime can use its own default only if it serves a model of its own (`PiAuthService.servesAnyModel`).
When routing chooses a model and no account can serve it, startup refuses unless the local runtime itself serves that exact standalone model.

## Bounded fact retrieval

R10 maps classifier-owned `retrieval` to low: the whole task must ask for a fact, or how or why something is so, read from what this app can already read - the code and its history, the task record, the docs, and the current state of the computers, checks and GitHub runs it connects to (`docs/kind-classifier.md`).
An answer that needs a cause traced across past runs, a computer the app does not reach, a reproduction, a measurement, the web or an outside report, an audit or a design excludes that route; ambiguous work still reaches R8 high.
A retrieval crewmate is the captain's quick answer: its card's first sentence answers the question as asked from what is inside that boundary, saying how sure it is, and it stops at the boundary rather than climbing on its own (INF-1430, INF-4344).
When the answer stops short, the card ends with a line beginning "Quick answer." that says what was not checked and what Look deeper adds, and makes Look deeper the default, which the first mate answers with a read-only research step built on that answer.
When its sources hold no meaningful answer, it shows no card and reports so, and the first mate starts that research step at once.
A reply under its card that asks for more than those sources hold - how to do something, what is usual, a source past the reach, or an action - gets one sentence of what the sources establish, and may get one more from general knowledge that begins "Not checked here:"; then the crewmate closes its card and hands the reply to the first mate with `needs_firstmate`, and the first mate starts the work the captain's words need at once, built on that answer (INF-4583).
The quick model answers in seconds and never climbs on its own; the hand-off is how a reply reaches a model that can solve it.
The app marks every crewmate card from a retrieval task with a Quick answer chip (`Card.quick`, `isQuickAnswer`).
R0 named models, R1a premium asks and R1b escalation remain above it, and pins, capability and availability keep their existing precedence and fallback.
Low is the requested slot, not a promise of the served model: both slots remain in the routing ledger.
The task record and crew summary say “Looking up or explaining from what is here” when R10 serves as requested, or retain the existing named-model, pin or fallback reason when one applies.
Settings → Usage calls the saved kind “Lookups and explanations”, past lookups included; older saved research and reproduction remain as they were.

## Declared intelligence and ongoing work

The first mate may request `intelligence` on spawn or create, the same typed choice program parts carry.
R11 reads that request before kind, below named models, premium asks and escalation.
A premium hint is never premium consent; without the captain's premium ask it falls through to ordinary routing.
`ongoing` declares that personal-workspace turns continue until explicitly finished, committing routine progress without a first-mate wake.
The compatibility migration translates the retired `teach` kind into `ongoing: true`, `intelligence: high` and `kind: unclear` while keeping saved records and historical routing decisions.
Lesson guidance and voice live only in the Lessons runbook (`docs/lessons.md`).

## A model that left every level

A running task's next conversation - a reopen after a quit, the restart after the model's context limit or repeated refusals, a reopen on a computer that runs work after that computer restarted, or the conversation a move to another computer opens there - asks for the model of its newest routing choice only while routing would still place that model where the conversation opens (`Router.holdsAtALevel`): a level in Settings → Intelligence → Models holds it, a Settings pin names it, or, while the starter map or the listed models stand in for placements of the person's own (`ModelSlots.routable`'s `placed`), those defaults include it among the models that computer's accounts serve.
With no slot record every model counts as held; a pool known to be empty, on this Mac or a computer that runs work, holds only a pinned or placed model.
While this Mac's pool is not yet read (`Router.poolRead`) - empty, or with the defaults leaving the model out while an account has not said what it serves - whether the defaults hold the model is not known: the conversation does not open and the task's lane holds, saying nothing, until the accounts said what they serve.
The task also keeps the model when its newest routing choice served a model named, at its start or by a move, so a reopen never undoes the latest model the person asked for; the routing row records whether the named model was served (`named` in its facts), and a row from before that counts as named when its selection was decided by the name.
Otherwise the task routes again on its own shape before its conversation opens (`TaskMoves.routeAgainIfLeft`), inside `Router.inOrder`, as its start did - a review still prefers a provider other than its builder's (R9) - among the models where it opens: this Mac's, or that computer's own sign-ins (docs/helper.md, "Its own sign-ins").
The levels are read from the whole pool there, and a replacement no account there serves is passed over within them, so passing one over never lets the starter map stand in.
A task on a custom connection routes only among that connection's models, on its account, so it never moves to another server on its own.
When the replacement chosen left its level while its account was picked, the task takes the one routing picks now.
The new routing row, the record's model and account, and one timeline and feed line naming the model that left and the one the task uses now commit in one transaction only once the conversation opened on the new model (`RoutedAgain.commit`), on this Mac and on a computer that runs work alike, the line saved as a fact any language words.
The commit reads routing again first, with what the accounts where it opened serve now - a computer that runs work is asked again for its sign-ins, and one that does not answer confirms nothing - and with the levels, pins and standing-in defaults as they are then: when the levels took the old model back meanwhile, or the replacement left them, the open is discarded and the task routes again, keeping the old model or taking the one routing picks now.
A conversation that opened on another model, or bound to an account that does not serve the model now - on a computer that runs work, the account that computer says it bound, which must list it there with its own allowance there not spent, never one this Mac guessed, and never none - takes no words: it is let go, that model on that account is passed over (the whole model only when no account was asked for it), and the task routes among the rest, another account there that serves the model first, waiting only when none is left.
There, each model is ranked on the account that would serve it now - its pin, else another that lists it, passing over one whose own allowance there is spent or that failed to open it (`servingNow`) - so a model is never dropped for a spent pinned account while a sibling there can serve it, and the open binds that same account.
A model whose serving account has no reading of its own is left unranked, its allowance unknown, never scored by the provider's whole reading or a spent sibling's.
A replacement whose conversation surely was not created - its open failed on this Mac, or that computer answered that its open left nothing new held there (`NothingOpenedThere`, `open-not-opened.md`), which an older computer never answers - is passed over the same way, and the words stay unspent for the next one; on this Mac the next pick passes over the account that failed and may take a sibling account on the same model.
One on a model the task keeps, with nothing to pass over, gives its words back unspent all the same, so a failed restart stays on its lane for the next sweep, and its failure is still said once (`OpenedNothingError`).
A notOpened answer that arrives after the session it answers was let go, or the task moved, passes nothing over.
The reopen that follows that computer's restart or cleanup asks for the same answer, and passes its routed pick over on it before the task's next open routes again.
An open whose outcome is unknown - that computer went before it answered, its answer could not be read or named no one outcome it may give (`openOutcome`), or it failed in any other way - passes nothing over: what it may hold there stays refused, and its words go back unspent (`NotAcceptedError`).
A context or refusal restart is kept on the task's lane before its new conversation is asked for, so a failure, a wait, a refusal or a quit before that conversation is accepted leaves the next open starting fresh too, never on the conversation it replaces.
On a computer that runs work the restart asks for a new conversation (`fresh`, `fresh-open.md`), and the home takes words only from an answer naming a conversation other than the one replaced, rerouted or not; one that names that same conversation, or none, is not accepted.
A move the person named opens on its model or takes no words, as any new conversation does, and keeps its model for the next open.
A conversation that kept its model and opened anew, routing nothing, is read the same way once it opened: when it opened on another model than it asked, or says no model at all, or its model left every level meanwhile, it takes no words and the task routes again; one reattached to, still open there, keeps its model.
Words sent while such a reopen routes wait for it - the conversation is the task's only once it is accepted, so a second message or a lane sweep before then reaches nothing - and go back to the task's lane unspent when it does not open, or opens and is not accepted, including when its check could not finish (`NotAcceptedError`).
A sibling account a resume moves to is written, recorded and said only once the conversation on it is accepted.
On this Mac the account picked must serve the replacement - on, connected, withheld by nothing, with allowance left, and listing it, or listing nothing while no sibling lists it (`AccountSelector.servesNow`) - or the replacement is passed over; it is marked selected only once that transaction committed (`AccountSelector.pickForSpawn`).
On a computer that runs work the open carries that computer's account for the model, an account whose sign-in lists it ahead of one only inferred from its provider, and the effort routing chose, Quick care a rung lower unless an effort was chosen.
A reopen or resume on a computer that runs work first only reattaches to a conversation still open there, which keeps whatever model it runs, routes nothing and records nothing; only an answer that it holds none routes again before a new conversation opens (docs/helper.md, "That computer restarts").
A conversation this Mac refused there, one that opened on a model or account it does not take, is never reattached to: the next open on that computer opens anew (`TaskMoves.refusedThere`), after this Mac restarts too, since the refusal is kept with the task's placed record (`PlacedLedger.keepRefused`) until a conversation there is accepted.
A new conversation there is marked refused before it is asked, so one that opened when this Mac quit, or whose open failed, before it was accepted is never reattached to unchecked either.
What an older computer answers, which may reattach or open anew, is checked as a new conversation, never taken as a live one.
An older computer that answers it holds no conversation opens anew the same way, and the conversation it opens is read as a new one.
The conversation then opens as a reopen does, and the newest routing row names a held model, so a later reopen keeps it and says nothing more.
When no other model on the levels that an account there serves can take the task, its conversation does not open: the task waits, its lane holds (`TaskMoves.waitsForModel`, a `model` lane hold, the `model-levels` hold in docs/delivery-rigor.md) and one timeline and feed line says so (`crewmateWaitsForModel`), said again only after the task routed again.
A restart that meets the wait stays on the task's lane as its restart reason, so it still opens a new conversation once a model can take it, after a relaunch too; a computer move's reopen waits without saying it could not reopen, and a waiting delivery spends none of its attempts.
On a computer that runs work, a reopen after it restarted lets its crewmate here go instead, so the next message opens the conversation through the ordinary resume; so does one whose replacement runs on the other backend, one that computer did not confirm open, and one adopted on another model than it asked, which has no spec to open again.
An older computer, one that cannot be asked only to reattach (`reattach-only-open.md`), could open a conversation it holds again on the model that left, so its reopen waits until that computer is updated or holds that conversation no more, whatever else could take the task, and its line says it needs an update (`crewmateWaitsForUpdate`); a message held meanwhile, and the task's paused line, give that same reason, as a wait while the accounts have not said what they serve gives that one (`TaskMoves.modelWaitCause`); before a cleanup of words from outside there, which opens the conversation again by itself, the home lets go of its own session, so the next words open one checked as new.
The wait ends when the task's routing choice, the levels, the pins, the slot record, whether this Mac's pool was read, any account's allowance - each of its scopes spent or not, or on credits, as the account pick reads it - the models this Mac's accounts list, what that computer last said of its sign-ins or a cut-off there whose reset passed, whether it opens only what it holds, or whether it holds the task's conversation open change, or when the task closes, and the next message or sweep tries again; a waiting restart is delivered then even with no crewmate held.
A move, a stop, a quit or a close that takes the task while it routes supersedes the reopen: it opens nothing, and the account it picked is recorded only with a move it commits.

## A level's words

A level names how hard a task is, so a person never reads it as the reasoning, whose words are Low, Medium, High and Extra high.
The saved values stay premium, high, medium and low; a person reads Premium, Hard, Normal and Simple (`src/shared/levelWords.ts`).
`levelWord` is the badge's word in the app's language, `levelList` names the work a model takes ("hard and normal tasks"), and `levelModel` and `levelModels` name a level's models in a sentence ("a model for hard tasks", "premium models").
Premium names models, since the app sorts no work into it on its own.
The task record's Difficulty is the level the task's routing asked for, not the level that served it.
The first mate's tools still take the saved values; its models list heads each level with both, such as `high (Hard)`, and spawn_crewmate's `intelligence` rule tells it to say the captain's word.

## Notes

Moved verbatim from `AGENTS.md` on 2026-09-24; `docs/README.md` lists this page.

- The routing redesign (captain decisions A/B/C, 2026-09-01; Three boundaries now sit around the ladder in `routingEngine.route()`, and each has a single home:
 - **Capability** (`src/core/routing/capability.ts`): a candidate's def is resolved BEFORE it is chosen (`src/core/pi/modelCapability.ts` reads it out of the same runtimes the session will use, so it is the `withHonestReasoning`-corrected def) and skipped with a recorded reason when it cannot carry the turn - images (the task's pictures, "Pictures" above) or context.
   High-slot placement is trusted fully (no reasoning skip).
   A def no runtime knows is UNKNOWN, not incapable.
   There is deliberately NO failure/incident ledger; the captain cut it.
 - **Premium** (`PREMIUM_SLOT` / `AUTO_ROUTABLE_SLOTS` in `src/shared/modelSlots.ts`): a fourth slot above high that crewmate automatic selection NEVER picks - not in `route()`'s ladder or the cheap-first candidate walk (`src/core/routing/candidates.ts`, including its uncatalogued tail).
   A review's preferred model may sit at premium: a standing direction naming it is the person's own choice, as a pin is, so `route()` takes it before the ladder, and an independent review's other-provider preference (R9) does not apply to it.
   The first mate's Auto instead tries high → medium → premium → low across Pi and Claude in one pool; premium is its automatic fallback before low.
   A premium starter row (`claude-fable-5-2` on Claude, `gpt-6-astra` on Codex) is pinnable without a settings trip; crew never auto-picks it.
   GPT-6.1 Sol is the high default, GPT-6.1 Terra the medium default and GPT-6 Luna the low default on Codex (`STARTER_SLOTS`; migration 39 moves a saved GPT-5.6 pick onto the GPT-6 Sol and Luna rows).
 - **Slots** (`src/core/routing/modelSlots.ts` + `src/shared/modelSlots.ts`): a per-OFFERING record (decision C - the same id can sit in two slots on two providers; never dedupe ids across providers).
   Seeded from `STARTER_SLOTS` on first activation only; a LISTED newcomer from a successful read arrives off unless the map names them, and is announced once, and a listed or kept model a later successful read no longer serves is announced once as gone (`ModelSlots.departures`).
   Off = in no slot.
   The fallback ladder is slotted → starter map virtually → every listed model at medium → the whole signed-in pool: a shortlist is a preference, never a way to brick routing.
   Pins bypass it - naming a model is its own placement.
   Per-account control is the account's pause, not a second toggle.
   Every skip and every rung lands in `routing_decisions` / `account_decisions`; never quiet it.
 - **The tier itself** is COMPUTED from the work's SHAPE, never judged (captain-approved 2026-09-18, `fm3000-intelligence-bucket-routing-s1/report.md`).
   Its two homes: `src/shared/routingPolicy.ts` is the shape (kind, basis, premium_ask, override_model_id, escalate_from, escalation) and the policy as DATA, so a later user override reads the same definition the way `model-slots` overrides `STARTER_SLOTS`; `src/core/routing/policy.ts` is `tierFor` - pure, reads no task text, and hands an `override_model_id` back as a pin because it knows no slot record (`Router.decide` resolves that pin's own slot as the tier).
   The kind comes from `KindClassifier` (`kindClassifier.ts`; the `none` implementation abstains, and `unclear` routes HIGH by the captain's call), never from the engine and never from the first mate.
   Premium stays unreachable automatically: only a captain ask, the bounded escalation rung or a review's preferred model, which a standing direction names.
   The spawn carries the facts (contract v2.8) and `TaskIntake.commission` builds the shape: it checks the basis against the record (done, or carrying an outcome - an unverified basis routes high; a verified basis routes `implement` work at medium under R4, with medium reasoning when served at medium; planning stays high under R2, and a grounded `fix` (R6) also routes medium) and stores the shape on `tasks.shape_json`, so a queued row dispatches from what it was commissioned with (a filed row takes a model the captain names later through `update_task override_model_id`, contract v4.46, into the same field); the rule lands on `routing_decisions.rule` beside the shape's reason lines, and the C5 join carries `shape`/`tier`/`rule` as the classification's label.
   A named model routes only when it can serve; otherwise every start waits for a computer that serves it - Automatic, This computer, a named computer, and Automatic's re-check of the computer it already chose - and the first mate hears that once and asks the captain, while a review's spawn is refused with the same ask, since a review has no queue to wait in (`docs/helper.md`, "Automatic starts"), so the first mate hears that work the captain named a model for has started only when the named one was not available or no model is recorded to confirm it, and then hears the model that took it (FI3-444, `src/core/orchestrator/namedModel.ts`, matched the way `Router.decide` matches the pin): the queued-started wake for work whose wait ended.
   Work `spawn_crewmate` (a review included) or `update_task start_now` started behind its answer (INF-3060), whose answer returns once the task is recorded, before any model takes it, wakes the first mate with `asked` only when it started on another model than the one named or with no model recorded; a start on the named model is no news, and the crew list in the first mate's context names each started task's `model` (INF-5123).
   `tasks.difficulty` still holds the tier, computed now - an older row (or a recorded spawn in replay) is translated by `legacyShapeFromDifficulty`.
   The first mate may declare the kind; undeclared work comes from a model (`docs/kind-classifier.md`; the implementation is `DecisionKindClassifier` over the decision-model class, and the default answerer is the question's one-shot on the session contract (`session/questionSession.ts`), served by `pi/session.ts` or by its Claude twin `claude/session.ts` when the walk binds a Claude model): one bounded call on the cheapest slotted model, the cheap-first binding walk, a byte-stable versioned instruction, and fail-soft - every failure and the model's own abstention are `unclear`, which R8 still routes high, each naming itself in `kind_source` (`KIND_SOURCE`).
   It is skipped, with a `skipped:` source, exactly where the table decides above the kind (R0/R1a/R1b), runs at most once per row (`kindEstablished`), costs one row in `usage_events` under the task, and reaches no user surface.
   `pnpm score:kinds` scores the labelled fixtures and the hand labels in `tests/fixtures/kind-classifier/`; bump `KIND_CLASSIFIER_INSTRUCTION_VERSION` when the instruction text changes and re-run it.
   The routing numbers - tier distribution, classifier-source share, downgrade rate, escalations per lineage - have ONE home, `scoreRouting` in `scripts/interaction-metrics.ts`, fed by `ObservedDispatch` rows so the replay gate and the offline corpus export (`manifest.routing`) cannot disagree; a distribution has no good direction, so those metric rows are `direction: "either"` - written to the baseline, never graded by the gate - while the downgrade rate and the escalation depth still are.
   Migration 35's `routing_decisions.served` is what makes a downgrade a join instead of a regex over the reasons prose, and Observe's crewmate header renders rule/tier/served/kind-stamp (`docs/dev-observe.md`) - the only surface in the app that shows them as recorded.
   The crewmate summary's reason line (below) says the same decision in the captain's words.
 - **Escalation** is that ladder's one automatic rung and the CAPTAIN opens it : `spawn_crewmate` carries `escalate_from` - no new tool, the count stays 24 - and the field is refused as text at the tool boundary on any turn that is not a captain turn (`CrewDelegate.isCaptainTurn`, the wake stamp `remember` reads), so a crewmate's own "I am blocked" never climbs; that report earns one decision card with a non-default premium way when it can serve, otherwise the stronger-model fallback when a rung remains, and only the captain's click is the say-so (O2).
   `resolveEscalation` in `workShape.ts` refuses before anything exists - an unknown task, one that never ran ("never on first dispatch"), a lineage past `maxEscalations` (2), or nothing above premium - then `applyEscalation` links the pair `discovered-from`, writes the two `escalated` timeline rows (the rejected attempt's is the move's ONE feed line; the supersede's own close is `feed: false`) and `supersedeAttempt` interrupts the attempt and closes it `dropped`/`superseded` with `escalated_to`, its worktree and branch retired like any close but ALWAYS saved first on its kept ref, which the brief names (O1).
   Discard, rework and cancel share a best-effort close of the abandoned attempt’s open pull request; success or a failure is recorded on its timeline, and a host failure never prevents local cleanup.
   A failed turn closes its task but never its pull request, which stays open for the captain to merge, close or carry on in a fresh attempt.
   A stronger-model retry of a failed task leaves that pull request open, and its brief names the pull request, its link and branch, so the fresh crewmate decides whether to build on top of it or overwrite it (`EscalationBriefFacts.previousPullRequest`).
   Discarding the failed task closes it (`TaskDrop.drop`), even though the task itself is already closed, unless an open task, such as that retry, now delivers through the same pull request; the discard's answer then names that task.
   Existing closed tasks are not revisited.
   The fresh row inherits kind, basis, repo and parent; a clicked premium way also carries `premium_ask` and stamps premium as the floor (R1a outranks R1b), while a stronger-model click takes the next rung.
   It is briefed by `renderEscalationBrief` (Q4 B: a fresh crewmate, never a resume).
   `neverDowngrades` is the never-downward gate: an escalation queues on its tier's quota reset rather than starting at the tier that already failed, at commission and at dispatch alike.
   A premium ask that cannot be served waits the same way, on a `bucket:<tier>` gate that `quotaGateCleared` (`src/core/routing/quotaGate.ts`) clears once an available model placed at that tier has headroom or unknown headroom.
   When no available model sits at that tier at all, the route says so (`emptyBucket`): no reset ends that wait, and the first mate's `reasoning-wait` wake says it ends once a model is placed there.
   When the tier's models read text only and the task carries pictures, the route says that instead (`picturesUnread`, "Pictures" above), and the wake says it ends once a model that reads pictures is placed there.
   An Automatic task is held the same way, with the same gate and one wake, when no computer serves its tier (`floorHold`; `docs/helper.md`, "Automatic starts").
   The task's record says why it waits and what ends the wait (`docs/task-record.md`, "A held task says why").
- Reasoning effort: a fresh crewmate with a routed model inherits the served slot's table level (`src/shared/routingPolicy.ts`: premium/high xhigh, medium/low medium).
  Pi clamps to the nearest offered level at or below it (or the lowest offered); Claude sends the level explicitly on its opening query for supported models and omits it for legacy Haiku.
  Haiku 5.5 receives medium for ordinary low-slot work and low for Quick; saved slot choices remain untouched.
  Settings → Intelligence → Models offers a reasoning menu beside each model in each used level.
  An explicit provider/model/served-level choice overrides that default, after routing, and keeps its chosen level under Quick care, bounded by the executing backend's capabilities.
  A reasoning effort the captain named for the task (`override_reasoning` on its shape) outranks that choice for this task alone and is treated the same way; the Settings choice is unchanged.
  An inherited choice whose derived rigor is Quick moves one offered rung below that clamped level, if possible.
  Standard and reviewed rigor, answers, reviewers and the personal workspace do not step down.
  A named model or premium ask with inherited reasoning still takes the adjustment; an escalation raises the slot first.
  A resumed conversation retains its opening level.
  The session says what it opened at (`ModelSession.reasoning()`, FI3-439: the level after the cap and the Quick step, why it is lower - `quick` or `capped` - `off` for a model the runtime marks as not reasoning, `default` where Claude sends none), the supervisor records it on the `dispatched` timeline row beside the model, and `TaskDetail.reasoning` carries the newest one while the record still names that model; the crewmate summary shows it.
- Same-tier routing order: spend priority first (the scope whose paid allowance is most on track to expire unused; a known signal, even negative, outranks an unmeasurable one, and unknown is NEVER zero), then a newer id within the same model line (dotted/dashed version tokens; the line is the id's prefix AND suffix around the version, so gpt-5.6-luna never outranks gpt-5.3-codex-spark) still overrides; unmeasurable candidates keep runway order, except that models no allowance is read for take turns ("Models no allowance is read for" above) (`newerId` + the ranked pool in `src/core/routing/routingEngine.ts`; the account pick in `accountPolicy.ts` ranks the same way).
  A crew task ranks by allowance band first (INF-1714, `spendBand` and `compareBandRank` in `src/shared/quotaSignals.ts`), decided from the raw, model-scoped reading before any placed-work charge: room (above the near-floor, a known score projected to last through every reset), conserve (above the near-floor, projected to run out first), near-floor (a known allowance at or below `CREW_NEAR_FLOOR_PERCENT`, 10%), then unknown (no usable, fresh reading), then credits (a spent allowance whose account keeps going on credits, `docs/quota.md` "Keep going on credits"; the published model choice names it `near_floor` with `onCredits`).
  So Claude at 20% that runs out still outranks Codex at 4%, whatever their scores: the larger remaining allowance is spent before a near-floor one.
  Inside a band the placed-work-adjusted spend priority orders candidates (INF-1680), and a placed-work charge never moves a candidate between bands.
  Recency overrides only inside the leader's band, and the reasons name a higher-scored model passed over because of its band.
  A model on credits stays at its level ahead of every weaker one, and the reasons and Why this model say it keeps going on credits.
  The first mate and the decision models keep the three groups of `compareSpendRank` (INF-898: lasts through every reset, runs out first, unmeasurable); only crew routing and the crew account pick read the bands.
  Nothing becomes ineligible for it: pins, slots, capability, the reviewer's provider, the 0% exclusion and the fallback ladder are unchanged, and a running crewmate keeps its model.
  The model catalog's best account per model, a computer's own pool and the account pick rank the same way.
- A task on a computer that runs work routes among that computer's own subscriptions, never this Mac's (`docs/helper.md`, "A task's model"): `Router.decide` takes a `pool` in place of this Mac's models and quota catalog, the slot record, pins and the ladder read it as they read this Mac's own, and its reasons name it.
  No account of this Mac's is selected for such a task.
  A sign-in there with a typed cut-off standing on it, as its rows say, leaves that pool as a withheld account here leaves this Mac's; when nothing else there serves, the task waits for that sign-in rather than starting.
- Serveability (`docs/quota.md` "The cut-off on the account"): an account withheld by a fact beside its credential - no client to run it, or a standing `refused` / `signed_out` cut-off - leaves the routing pool (`AccountVault.availableModelsByAccount`), is never the flagship, and is skipped by account selection with `withheld (<reason>)` in the spawn's `account` row, which also names a withheld account of another provider that routing never reached.
  One predicate, `servesModels`, answers for every reader.
  A spent allowance is not withheld: its pushed `rejected` reading is a zero window until the reset, read like any other headroom.
  A task served from a weaker slot than it asked for says so in the feed (`downgradeLine` in `src/core/orchestrator/starts.ts`), and the line names the cause from typed facts.
  `Router.preview` reruns the same ladder with the withheld accounts' models back in the pool (`AccountVault.withheldModels`); when that run serves the slot asked for from one of them, the route carries its provider and the account's reason (`RouteResult.withheld`, also a line in the routing reasons).
  The line then says that provider's models in the slot are paused until you sign in again, while it refuses your sign-in, or because it cannot run on this computer.
  With no withheld cause, a task whose pictures that slot's models cannot read gets a line saying so (`RouteResult.picturesUnread`, "Pictures" above).
  Otherwise, including when the withheld model's own allowance is spent, the line says that slot's models have used up their allowance; a computer's own pool carries no withheld cause.
- **A move leaves a provider out** (INF-849): `withoutProvider` removes one provider from what may serve - the available models, a computer's unlisted ones and the pins - with no fallback to it, unlike R9's `avoidProvider`, and adds a reason line naming it.
  A started task moving off the provider that failed it routes this way on its own shape, and finds nothing when only that provider serves (`docs/task-record.md`, "Moving a started task to another provider").
- **Why this model** (FI3-427, captain's pick 2026-10-01): the task record says why its model was chosen, under its Why this model disclosure since INF-1714 (`docs/crew-orbits.md` "The summary").
  `modelReasonOf` (`src/core/routing/modelReason.ts`) builds `TaskDetail.modelReason` from the TYPED columns of the task's newest routing decision that chose something - `rule`, `bucket`, `served` - beside the shape it was made from (the kind for R2, the basis key for R4/R6, the rejected attempt for R1b, the builder for a review, and whether another provider than the builder's served an R9 review, read off the builder's own decision at that time).
  It never reads the reasons prose.
  Two facts are derived at the read because the row has no column for them: `named` (R0, and the served model is the one the shape named) and `pinned` (the served model is a current Settings pin, which outranks every slot).
  It is absent when the task never routed, when the row predates the rule column, or when the record's model is not the one the decision chose, so the line never explains a model the crewmate is not on.
  The record's model follows the model that answers: when Claude Code moves a crewmate to another model, the record names it and the routing ledger keeps the router's decision as it was made (`docs/claude-client.md`, "The model that answers").
  `modelReasonLine` (`src/shared/modelReason.ts`) is the one wording: the captain's own choice first ("You asked for this model", "You pinned this model in Settings"), then a slot that could not serve ("None of your models for hard tasks could take it"), then the rule's reason ("Building from the plan in FI3-419").
  Since FI3-439 the line never leads with the level: the task record shows the task's Difficulty, the level its routing asked for, and the reasoning as their own labeled values, and the footnote says why the reasoning is lower ("Reasoning one step lower for Quick care.", `reasoningNote`); the summary shows the Difficulty badge beside the model.
  The task record shows this line, and why one model won over another inside a slot (band, spend priority, recency), under its Why this model disclosure ("Why this model on the task record" below); the summary shows neither.

## Read-only computer evaluation

`Router.preview` evaluates a computer's own pool with the same policy, pins, slots, capability checks, quota facts and premium boundary as `decide`, without writing a routing decision.
`decide` calls that path; Automatic placement records only its chosen preview through `Router.commit` inside the task commitment transaction.
Previews themselves neither write decisions, bind an account nor reserve allowance.
The preview carries the result, reasons, a preference rank and the existing premium/escalation waiting rule (`requiresReasoningWait`), which the supervisor also reads.
A named model ranks first, then saved pins in order, then the existing slot ladder's order (`fallbackRank`), where a review's preferred model ranks as the requested slot's first rung; the rank reads typed choices, never the reasons prose.

`evaluatePlacement` (`src/core/routing/placementEngine.ts`) is the pure computer-policy seam beside that model owner.
It consumes declared requirements, receiver-owned observations, per-computer model previews and pending reservations and returns a choice or a wait with typed candidate reasons.
Each computer comes with the core's one reach value (`reachFrom`), which its evaluation carries as it came: a connecting computer is still refused as out of reach, and its wait and saved explanation read connecting.
It performs no sampling, preparation, account access, database writes or task starts.
`AutomaticPlacement` calls it inside `TaskService.placement.commitPlacement` before a new Automatic task starts; explicit selections keep their existing start path.

### Requirements and defaults

`placementRequirementsSchema` (`src/shared/placement.ts`) describes optional OS, execution architecture, required tools and workload profile for a project or task.
Only the existing Mac and Linux work platforms qualify; the architecture is what the process executes, not inferred hardware capability or emulation support.
Task platform declarations intersect project declarations, required tools are united, and a task cannot lower a declared project resource profile.
Without a platform declaration, the home platform is the conservative default: a Mac task is not presumed portable to Linux, nor an Arm task to Intel.
The resolver says which platform fields it filled from the home's own (`inherited`), so an added computer that default leaves out is told rather than silent (`docs/helper.md`, "Automatic starts").
An unknown home platform or an empty intersection admits nothing.
A working copy requires git; every other tool must be declared by identity, never discovered by parsing task text.
The caller supplies typed access to the particular project and the tools on each computer; missing or unknown facts exclude that computer.
Project configuration and task tools persist declarations through their existing owners; `AutomaticPlacement` collects fresh compatibility facts before using this seam.

The profile is independent of model-routing kind: a research task may use a browser, and a build may launch large tools.
The default is `standard`; an explicit `conversation` profile requests 0.25 logical CPU and 512 MiB, `standard` requests 0.5 logical CPU and 2 GiB, and `heavy` requests 2 logical CPUs and 4 GiB.
These are initial admission allowances, not measured peaks, process-enforced limits or a guarantee about later work.
CPU capacity is 80% of the observed idle logical CPUs.
Memory room starts from installed memory minus the one memory-used figure, then keeps the larger of 512 MiB and 10% of installed RAM untouched, then subtracts pending demand.
The home's receiver works that figure out once for each fresh reading (`memoryUsedBytes` in `src/core/placed/memoryUsed.ts`).
A reading with no figure is refused, as a missing Linux estimate is.
Linux is a reading that carries its available-memory estimate: the figure counts installed memory minus that estimate as used.
A Mac is a reading that carries purgeable or file-backed bytes.
At normal pressure the figure counts free, speculative and inactive memory as free, and also free, purgeable and file-backed bytes, and keeps the larger free part, capped at installed memory.
At warning or critical pressure nothing counts as free, so the figure reads all installed memory as used and the Mac has no memory room.
A waiting task still says it is short of spare memory.
A Mac reading without pressure, or without inactive and speculative bytes, counts free, purgeable and file-backed bytes as free, as a reading from an older computer or a failed read does.
Anything else has no figure.
A Mac in ordinary use keeps almost no page free, so free bytes alone would read a Mac with room as full.
The observation still carries every raw count, and the figure is the only number a reader uses.
`tests/e2e/automatic-placement.spec.ts` starts an Automatic project task on the computer that runs the suite, once on a model routing names and once on that computer's own default when routing names none: the Mac mini on a pull request, the Mac that runs the full suite's desktop journeys job, and the hosted Linux virtual machines in the full suite.
Memory, macOS page and pressure reads, computer identity, program and project access remain that computer's own.
The journey replays captured CPU counters only inside its isolated Electron process (`tests/e2e/placementCpu.ts`); production sampling and admission are unchanged.
It first observes a fresh busy sample, asks for a task, checks that the task waits unstarted for CPU room, then releases available counters and checks that the next placement sweep starts it on its own branch.
The sampler still measures counter deltas over its real window, and the journey checks its resulting CPU observation.
A wait for anything other than CPU room or an outstanding comparison fails in the task's own words.
A wait because this computer had no current reading, unknown or too old, is still an outstanding comparison: on a slowed runner a read can overrun its deadline, and the next round reads again.
The shared Mac's other work cannot hold the replay busy: release follows the observed wait, not elapsed time or the real processor becoming idle.
The journey's ordinary load-clock deadlines still bound a missing comparison or start.
It also holds a premium ask that computer cannot serve on the premium reset, and checks that the first mate hears once.

### Filtering, sharing and order

Only in-reach, work-enabled computers with matching platform, known tools, project access, a model choice and fresh valid resources qualify.
A preview with no choice still qualifies a computer whose caller declares a runtime default (`runtimeDefault`); `AutomaticPlacement` declares it for the home only, which starts such a task as a This computer task starts.
No model choice without a runtime default, an absent preview, a premium/escalation downgrade, stale or missing resources, and an unreadable computer identity each carry a typed rejection.
A wait in which some computer was refused for the downgrade alone (`model-floor`) and none waits only for room is a wait for the task's own tier (`placementFloorHold`).
`floorHold` returns the route that wait holds on: a computer whose reset can end the wait first, then one whose models at that tier all read text only for a task with pictures (`picturesUnread`), then one with no model placed at that tier (`emptyBucket`), and within each one whose routing names a model, then the strongest preference.
So the held route names pictures or an empty tier, and the gate its cause, only when no computer's reset can start the task ("Pictures").
The caller may supply a binding resolved by the existing placement owner: explicit task or parent, review with its builder, local-only project or personal workspace.
A binding filters out every other computer; the evaluator never substitutes another when the bound computer cannot qualify.
It does not replace the existing manual or recovery paths.

The caller supplies a known computer group, the system identity its readings measure (`docs/helper.md`, "Automatic starts"), not a name, address or OS guess.
Several users in one group share the smallest fresh CPU and memory allowance observed for that group; allowances are never added.
Every pending reservation in that group subtracts once by order identity, including reservations for another user there.
An identical repeated order counts once; conflicting identities or malformed demand make the whole evaluation wait.
Already observed running work is not reserved again.
The dispatch owner must retain pending reservations across uncertain replies, and release or reconcile them only with evidence that preparation ended or a later observation includes their running demand.
The evaluator alone cannot make two concurrent starts atomic.

Among compatible computers with fresh facts, the best model preference is selected before checking room for a new task.
If that preference has no capacity, the result waits rather than quietly choosing a weaker model on an idle computer.
If no compatible fresh computer offers it, the existing fallback order ranks the available choices.
A runtime default names no model, so it ranks after every computer whose preview names one.
At equal model preference, the largest minimum of CPU headroom/demand and memory headroom/demand wins.
A computer id breaks an exact tie deterministically, independently of input order; the home participates in the same comparison, with no fallback penalty or capacity bonus.
The result includes the candidate readings and their ages, capacity, reserved demand, remaining room, missing tools, model preview and typed rejection reasons.
Automatic placement saves at most 64 candidate explanations, including the chosen computer, in one task-owned commitment snapshot.
That snapshot is historical, never a fresh observation after restart; `docs/helper.md`, "Automatic starts", owns the commitment and recovery rules.

## Placed work in the ranking

`PlacedWorkScores` (`src/core/routing/placedWork.ts`, INF-443 piece 3) adjusts the spend-priority score for work already placed, without changing the allowance reading.
The router uses it for the home and each computer's pool, and account selection uses it too.
One evaluation's `PlacedWorkData` shares the work and finished samples, allowance prices, per-reading window charges and per-task usage totals across model ranking and account binding.
The app prepares these charges in the read-only record process (`src/core/recordReads/`), apart from the window's main thread.
Concurrent requests collected in one event-loop batch share one committed work and finished-sample snapshot, including the per-task usage reads used by every account in that batch.
The process returns only per-reading window charges; task history never crosses back to the window's process.
A later batch reads committed usage and routes again, with no timed cache, and the local scoring policy uses the same readings that produced its charges.
Quota observations and price learning run in that process too, while `SettingsStore` remains the one writer of learned prices.
Callers replay their current snapshots to seed a restarted reader; an equal replay in a running reader never repeats learning's usage queries.
Task starts, Automatic placement and moves share one ordered preparation, decision and commitment chain, so each new placement sees its predecessor’s committed charge.
A review whose task row follows routing is created within that chain, including an independent repair assessment.
Computer facts and session reopening stay outside that chain.
Opening the reader and receiving an answer each have a ten-second bound.
A missing, stopped or timed-out reader rejects its pending requests rather than running history reads on the main thread.
Placement and account selection then proceed with the original allowance readings and no placed-work charges; agent task searches report the reader’s error rather than an empty result.
The next request can open a new reader.
A host without the record-process capability retains in-process scoring and matching task selection through their existing owners.
Failure of a configured reader never selects that synchronous path.
`Router.prepare` supplies required scoring data to routing; `AccountSelector.selectForSpawn` and `reselectForResume` are asynchronous attachment points, and synchronous policy previews require their already-prepared data.
The charge is independent of the candidate model, while each model's effective allowance, raw band and time-to-reset score are still derived separately.
The settings meters, 0% eligibility check, flagship reserve, pins, requested tier and reset waits still read the unadjusted meter.
An unpriced allowance takes no charge, as the captain selected in question 7; there is no one-task restriction or shipped starting price.

Task size is the average of at least five finished tasks from the last fourteen days: the same model and served level first, then that model at any level, then that provider.
A task already beyond that average uses the average of finished tasks costing at least as much as its logged usage, or its own logged spend when it exceeds every sample.
Missing costs do not become zero-cost samples.
Each allowance window learns points per listed-price dollar from its cycle's drop and the same sign-in's usage between those readings, once the pooled drop reaches three points.
Grok and Codex sign-ins pool by provider, while Claude pools by provider-reported login, falling back to the individual sign-in when it names no login.
Drops and usage are summed across those sign-ins, including the first mate's calls in usage; this deliberately counts shared Grok/Codex meters twice when two sign-ins report the same drop, as accepted in question 6.
Each window has its own price, and a model-specific window counts only matching model usage.
A reset or top-up begins a new observation interval; the last learned price remains available across resets and restarts.
Duplicate, older, stale and failed readings do not advance learning.
Only learned prices persist; local and other computers' observation intervals stay in memory.

A charge is the expected task cost minus its usage logged through the reading's measurement time, converted to points by that window's price.
It includes open tasks with a committed routing choice, including an Automatic placement still preparing, and closed tasks until the first reading strictly after closure.
The newest route's saved account identity attributes pre-attachment work to the login behind that score; an attached task's recorded account takes precedence.
Older decisions without that identity fall back to the first observed sign-in for that provider on the task's computer.
The first mate's own calls are not placed-task charges.
The router recomputes spend priority over charged windows to order candidates inside a band, but the band itself and every eligibility check read the raw headroom and runway, so a charge never moves a candidate between bands and a negative projection never invents an exhaustion hold.
Automatic placement commits its chosen route in the existing transaction, so the next start sees that choice without an additional allowance reservation.

## Why this model on the task record

The task record's fact strip ends with a Why this model disclosure (INF-1714, captain's pick A with the note to fold the model's reason into it and keep it off the hover preview; `ModelWhy` in `src/renderer/src/design/core/TaskFacts.tsx`); the crewmate summary shows none of it.
It holds the model's reason (`modelReasonLine`, "Why this model" above), one sentence on how the allowance decided (`modelChoiceLine` in `src/shared/modelChoice.ts`) and the ranked models with their band, remaining allowance, reading age, reset and any placed-work estimate.
`modelChoiceOf` (`src/core/routing/modelChoice.ts`) builds `TaskDetail.modelChoice` from the same routing row `modelReasonOf` reads, and only while the record's model is the one it chose.
The routing row's candidate facts carry each model's band, the score it ranked by, the raw score when placed work changed it, the account whose reading it used, when that reading was taken and when its limiting window resets; its `selection` records the facts version, what decided (`named`, `pinned`, `band`, `spend-priority`, `recency`, `runway-order` or `only-candidate`), the near-floor percent, the computer and, when models no allowance is read for took turns, `turns`.
A model the person named or pinned shows that reason and no comparison; a choice recorded before the bands reads "Comparison not recorded".
The projection reads only what was saved when the choice was made, so a later reading, a refresh or a restart never rewrites it.

Where the provider's own logins pool (`docs/quota.md`, "A pool of your own logins"), a candidate's share left, band and score come from all of the pool's logins, while the account the routing row records, its reset and its charge are the serving login's alone; a serving login that is spent or on credits is ranked by its own reading.

The crew account the model ranking reads is the account the task binds: at home `AccountSelector.crewAccount` previews the same model-scoped, pin-first, reserve-respecting choice `selectForSpawn` records, and on a computer that runs work the pool's own binding for that model.

## Operations

An operation is a deliverable, not a kind, declared by an `operation` constraint or `in_folder` work (INF-1430 piece 2).
The classifier is not asked and the record keeps `kind: unclear`, `kind_source: skipped:operation`.
R12 requests medium after R0, R1a, R1b and R11, before every kind rule.
The record’s result reads “Operation” and Usage groups its recorded work as “Operations” from the saved deliverable, without rewriting any saved kind.

## Program-selected intelligence

A program's `task()` call may choose `intelligence` for that part (INF-974, `docs/programs.md`).
The runner validates the slot, journals it as part of the call identity, and the supervisor persists it on `shape.program_part.intelligence`.
`tierFor` reads that typed declaration before kind rules and after a named model, premium ask or escalation.
Without a declaration the existing table is unchanged.
The supervisor refuses premium without the program's captain-origin `premium_ask`; an authorized premium part carries that ask into the existing availability wait.
R11 records low, medium or high program choices in the routing ledger, with the requested and served slots as usual.
R11 is ledger-only: the published model-reason vocabulary stays unchanged, and no kind-based explanation is shown for it.
Model selection, pins, allowance fallback and reasoning remain the router's, not the script's.
