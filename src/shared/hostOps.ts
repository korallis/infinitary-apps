/**
 * The host's own operations, carried only by the cards it authors (the
 * agent-down set, the consent card, and the idle-stall card): re-run an
 * account's sign-in (`arg` = account id), move the Firstmate flagship to
 * another provider (`arg` = provider id), retry the failed Firstmate turn,
 * try a refused account again (`arg` = account id; the only way a refusal
 * clears on the captain's word, W1 S9), turn an account's Keep going on
 * credits switch on from a run-out card (`arg` = account id; docs/quota.md),
 * use one of a Codex account's saved resets from a run-out card or the
 * spent-allowance card (`arg` = the account's key; docs/codex-client.md),
 * turn a Codex account's Use saved resets on their own on from a run-out
 * card (`arg` = the account's key; docs/quota.md), move the crew's login
 * in use of a provider, or the first mate, to another login of the same
 * provider (`arg` = `crew:` or `firstmate:` and the account id; docs/quota.md,
 * "When the login in use runs low"),
 * add or turn down a plugin waiting on the captain's consent (`arg` =
 * plugin id; one plugin vehicle, Phase A, A2a), add or turn down a project
 * Firstmate proposed on the setup card (`arg` = the card's offer as JSON,
 * `ProjectSetupOffer`; Add project also reads the card's answers), tell a stuck
 * crewmate to carry on or stop its task, or park it in the backlog with its
 * work kept (`arg` = task id; idle crew recovery, INF-3143), move a started task off the provider that failed it to the
 * app's pick (`arg` = task id and that provider, joined by a colon; INF-849),
 * start a charted task now (`arg` = task id), answer a task's cost limit
 * card - Allow more, No limit for this task or Stop here (`arg` = task id;
 * docs/usage.md, "The cost limit") - and send a message
 * Firstmate never answered once more (`arg` = the message's id). Secrets'
 * own cards spend a one-time pass with `secrets-decision` (`arg` = the pass)
 * and keep what an agent asked for with `secrets-keep` (`arg` = the fields the
 * window draws as JSON, `SecretKeepOffer`): the window sends that one with the
 * typed values on `inf:secrets:keep`, never as a card choice; `secrets-bring`
 * (`arg` = the rows the window draws as JSON, `SecretBringOffer`) goes the
 * same way with the ticked rows on `inf:secrets:bring`. The offer of
 * the event screen turns Screen automation events on with
 * `turn-on-event-screen` (`arg` = the disclosure version the card showed;
 * docs/automation.md, "Offering the screen"). `plan-queue`
 * and `keep-delivery` are retired: a card saved by an earlier version may
 * still carry one, and it does nothing. An effect is
 * never declared to a body's frame, so only the captain's click on the
 * card's own controls runs one.
 *
 * The task record's footer (`TASK_LIFECYCLE_OPS`, `inf:task:run`) runs the
 * same start, stop and continue ops, plus Drop task on never-started work,
 * and the task board adds queue and unqueue. Drop task, queue and unqueue
 * are not card effects. Merge, discard and keep stay on cards.
 */
export const HOST_OPS = [
  "restore-account",
  "move-flagship",
  "retry-firstmate",
  "try-again",
  "keep-going-on-credits",
  "use-saved-reset",
  "use-saved-resets",
  "move-login",
  "add-plugin",
  "decline-plugin",
  "apply-project-change",
  "decline-project-change",
  "plan-queue",
  "keep-delivery",
  "add-project",
  "decline-project",
  "continue-task",
  "backlog-task",
  "move-task",
  "stop-task",
  "start-task",
  "ask-again",
  "confirm-required-action",
  "defer-required-action",
  "allow-cost",
  "lift-cost-limit",
  "stop-at-cost",
  "secrets-decision",
  "secrets-keep",
  "turn-on-event-screen",
  "secrets-bring",
] as const;
