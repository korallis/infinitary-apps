/**
 * The limits ledger (INF-484 move 8; docs/agents-reach.md, "The limits
 * ledger"). Every named limit in the host's code - a `const` whose name
 * carries a limit word (`MAX`, `MIN`, `CAP`, `LIMIT`, `BUDGET`, `CEILING`,
 * `FLOOR`) in `src/core`, `src/shared`, `src/main` or `src/preload` - is in
 * this file once, so a new one cannot slip in unclassified:
 *
 *   LIMITS    a limit that rests on a fact (one the app holds, or one
 *             outside it), on consent, or on a physical limit of the
 *             process, with its way out: what an agent or a person does
 *             when work meets it;
 *   BASELINE  a limit that rests on a number the app made up - a verdict
 *             still in code (docs/principles.md, "Build the agent's reach,
 *             never its verdicts"). It only shrinks: a limit leaves it when
 *             its verdict goes to the agent, and a new entry is a move its
 *             pull request explains, as a moved replay number is.
 *
 * What a limit rests on is a judgment its author and reviewer make by the
 * four questions, never this check, which only keeps the ledger and the code
 * in step. The words match the hold registry's (`src/shared/holds.ts`).
 * Plain Node type stripping, no install; `pnpm check` runs it.
 *
 *   node scripts/limits.ts            exits 1 naming each limit out of step
 *   node scripts/limits.ts --counts   counts by what each limit rests on
 *   node scripts/limits.ts --list     every named limit, where it is and its entry
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** What a classified limit rests on: the hold registry's words, less a made-up number. */
export type LimitRests = "record" | "outside fact" | "consent" | "physical limit";

export type LimitEntry = { rests: LimitRests; way: string };

/** The code the ledger reads: the host's, never the window's drawing or a test, and the phone check's command
 * deadlines (INF-5387's plan, piece 1), each of which rests on recorded times, and the size check's two lines
 * on AGENTS.md, the captain's picks. */
export const LIMIT_ROOTS = [
  "src/core",
  "src/shared",
  "src/main",
  "src/preload",
  "scripts/phone-deadlines.ts",
  "scripts/agent-memory.ts",
] as const;

/** A name is a limit's when one of its words, split at `_`, is one of these. */
export const LIMIT_WORDS = ["MAX", "MIN", "CAP", "LIMIT", "LIMITS", "BUDGET", "CEILING", "FLOOR"];

const record = (way: string): LimitEntry => ({ rests: "record", way });
const outside = (way: string): LimitEntry => ({ rests: "outside fact", way });
const physical = (way: string): LimitEntry => ({ rests: "physical limit", way });

/** Each limit that rests on a fact, consent or a physical limit, by file, with its way out. */
export const LIMITS: Record<string, Record<string, LimitEntry>> = {
  // The captain's two lines for AGENTS.md (docs/testing.md, "The size check on AGENTS.md"),
  // over a trimmed file of 75 lines and about 1,050 words.
  "scripts/agent-memory.ts": {
    AGENTS_WORD_CEILING: {
      rests: "consent",
      way: "pnpm check refuses the change; move detail to the page that owns it, or raise the number in a change that says why",
    },
    AGENTS_WARNING_WORD_LIMIT: {
      rests: "consent",
      way: "a run on main fails and starts one trim task, holding nothing; raise the number in a change that says why",
    },
  },
  "scripts/phone-deadlines.ts": {
    PHONE_COMMAND_BUDGET_MS: record(
      "the command is ended and its processes and simulator kept in hung-*.txt; the check fails naming it, retries nothing, and its failed job is requested again",
    ),
    PHONE_BUILD_BUDGET_MS: record("the build is ended and kept as hung-*.txt; the check fails naming it and is requested again"),
    PHONE_PACKAGE_TESTS_BUDGET_MS: record(
      "the package tests are ended and kept as hung-*.txt; their failure is reported and the simulator tests still run",
    ),
    PHONE_JOB_BUDGET_MS: record(
      "a request whose passes, and the starts of a job's later devices, add up to more is dealt into more jobs, each on its own phone Mac; a pass longer by itself runs in a job of its own, still stopped at the gate step's 30 minutes",
    ),
    PHONE_PART_BUDGET_FLOOR_MS: record(
      "a part past twice its recorded time fails naming itself; a part that grew records its new time in scripts/phone-part-times.json",
    ),
  },
  "src/core/claude/claudeCostReports.ts": {
    CLAUDE_COST_REPORT_BODY_MAX: physical("a local export over 1 MiB is refused; terminal usage accounting remains available"),
    CLAUDE_FORWARD_BODY_MAX: physical(
      "a batch over the collector's default 20 MiB request limit is refused; terminal usage accounting remains available",
    ),
  },
  "src/core/pi/customApiToken.ts": {
    CUSTOM_TOKEN_RECENT_LIMIT: {
      rests: "consent",
      way: "captain chose a short bounded history; current and running-request tokens stay guarded independently",
    },
  },
  "src/core/axi/commandDoor.ts": {
    WATCH_WAIT_CEILING_MS: physical(
      "watch answers what it has with its cursor; the next watch --after reads on",
    ),
  },
  "src/core/axi/channel.ts": {
    CAP_MARGIN_MS: physical("the op keeps running; the shell's next command gets its kept answer"),
    REQUEST_MAX: physical("refused in words: arguments too long; the 1 MiB bound is not named"),
    FEEDBACK_BODY_FILE_MAX: outside(
      "four of GitHub's issue bodies; refused in words: the body file is too long to read",
    ),
  },
  "src/core/secrets/bringReaders.ts": {
    BRING_VALUE_MAX_BYTES: outside(
      "Automic Vault holds at most 1 MiB per secret; a larger value arrives unticked as too large and stays where it is",
    ),
  },
  "src/core/secrets/bringJson.ts": {
    JSON_DEPTH_MAX: physical("invalid source; ask the tool for a flat object with the names to keep"),
  },
  "src/core/secrets/bringOutput.ts": {
    BRING_OUTPUT_MAX_BYTES: physical(
      "the source is stopped and nothing is kept; the crewmate asks again for fewer secrets at a time",
    ),
  },
  "src/core/browser/crewmateCommands.ts": {
    DID_NAME_MAX: physical("clipped with an ellipsis on the line; the action itself is unchanged"),
  },
  "src/core/browser/diagnostics.ts": {
    TEXT_MAX: physical("clipped; the rest of the console line or address is not kept"),
  },
  "src/core/browser/outline.ts": {
    FULL_TEXT_MAX: physical("clipped; the answer counts the characters left unread, no way on"),
    NAME_MAX: physical("cut short and marked so; snapshot @ref reads the passage in full"),
  },
  "src/core/browser/pageNotices.ts": {
    NOTICE_MAX: physical("clipped with an ellipsis; the rest of the notice is not kept"),
  },
  "src/core/browser/taskBrowsers.ts": {
    TASK_BROWSERS_MAX: physical("refused in words; stop one, or try again once one closes"),
  },
  "src/core/browser/window.ts": {
    FOLD_MIN: physical("a repeat folds to a pointer naming the line of its first copy"),
    CONTEXT_MAX: physical("three lines show above instead; a window from a line reads more"),
  },
  "src/core/claude/claudeSessionOptions.ts": {
    CLAUDE_THINKING_FLOOR_TOKENS: outside("thinking turns off when the output cap is at or under it"),
    // The captain chose 3 days (2026-11-04), a policy value, not a measured need.
    CLAUDE_COMMAND_TIME_CEILING_MS: {
      rests: "consent",
      way: "the client stops the command; the crewmate starts it again with a fresh limit",
    },
  },
  "src/core/connection/journal.ts": {
    DEFAULT_JOURNAL_LIMITS: physical("the oldest pushes drop; a device behind them is told to reload"),
  },
  "src/core/decisions/correctionSources.ts": {
    // The captain chose today's sizes on INF-4527: "at most about 1,800 words, up to 600 of them from the card".
    CORRECTION_EXCERPT_BYTE_LIMIT: {
      rests: "consent",
      way: "an oversized exact reply is not checked; the person can still keep the instruction by asking",
    },
    CORRECTION_CARD_BYTE_LIMIT: {
      rests: "consent",
      way: "the card excerpt says content was left out; the reply itself is always sent whole",
    },
  },
  "src/core/decisions/jev/jevClient.ts": {
    JEV_MAX_OPTIONS: outside("the question answers its abstention, reason too-many-options recorded"),
  },
  "src/core/devices/dial.ts": {
    ANSWER_MAX_BYTES: physical("pairing fails in words: the home's answer is too long"),
  },
  "src/core/devices/findHome.ts": {
    ANNOUNCED_HOMES_MAX: physical(
      "each name and address is a process; the rest go unheard this look, and the next try looks again",
    ),
  },
  "src/core/devices/publishedBuilds.ts": {
    MAX_BYTES: physical("file deleted; said as a download that stopped, bound not named"),
  },
  "src/core/devices/relay.ts": {
    SAID_MAX: physical("clipped to 1 KiB; the rest of nc's stderr is not kept"),
  },
  "src/core/devices/ssh.ts": {
    SOCKET_PATH_LIMIT: outside("refused in words: folder too deep for a socket; it lives under /tmp"),
  },
  "src/core/freeze/freezeRecorder.ts": {
    RECORD_MAX_LINES: physical(
      "the oldest lines drop so the file on disk stays small; the newest stalls are kept",
    ),
    PASS_RECORD_MAX_LINES: physical(
      "the oldest passes drop so the file on disk stays small; the newest day is kept",
    ),
  },
  "src/core/freeze/memoryRecorder.ts": {
    MEMORY_RECORD_MAX_LINES: physical(
      "the oldest readings drop so the file on disk stays small; the newest week is kept",
    ),
  },
  "src/core/forge/api.ts": {
    API_REQUEST_MAX_BYTES: physical("refused in words naming 256 KiB; send a smaller body"),
    API_RESPONSE_MAX_BYTES: physical("refused in words naming 256 KiB; ask a smaller page with per_page"),
    API_PER_PAGE_MAX: outside("refused in words: per_page must be 1 to 100; follow nextPath"),
  },
  "src/core/forge/providers/github/attachments.ts": {
    RESPONSE_LIMIT: physical("upload said uncertain; a deliberate retry after the orphan is checked"),
  },
  "src/core/forge/providers/github/conditionalGets.ts": {
    KEPT_ANSWER_MAX_BYTES: physical("not kept; that read is answered in full each time, nothing refused"),
    KEPT_ANSWERS_MAX_BYTES: physical("the oldest kept answer is forgotten; its next read is answered in full"),
  },
  "src/core/forge/providers/bitbucket/client.ts": {
    MAX_DOWNLOAD_REDIRECTS: physical("refused in words: redirected too many times; nothing further"),
  },
  "src/core/web/publicPage.ts": {
    PAGE_MAX_BYTES: physical("the page's text is cut there and the answer says so; read a smaller page"),
    MAX_REDIRECTS: physical("refused in words: redirected too many times; nothing read, call again with the last address"),
  },
  "src/core/forge/providers/bitbucket/contributions.ts": {
    MAX_PAGES: physical("refused in words, nothing made; adding the fork as a project contributes from it"),
  },
  "src/core/forge/providers/bitbucket/dataCenterContributions.ts": {
    MAX_PAGES: physical("refused in words, nothing made; adding the fork as a project contributes from it"),
  },
  "src/core/forge/providers/bitbucket/dataCenterProjects.ts": {
    MAX_REPOSITORY_PAGES: physical("listing says some were not read; a pasted link or KEY/slug is looked up"),
  },
  "src/core/forge/providers/bitbucket/projects.ts": {
    MAX_PAGES: physical("listing says some were not read; a pasted link or workspace/name is looked up"),
  },
  "src/core/forge/providers/github/githubForge.ts": {
    MAX_RULE_PAGES: physical("refused in words: more rules than the app reads; no way past it"),
    MAX_CHECK_PAGES: physical("one pending item stands for the rest; never reads green, no way past"),
    MAX_LISTED_PROJECTS: physical("listing says newest only; an exact owner/name is looked up directly"),
  },
  "src/core/forge/providers/gitlab/attachments.ts": {
    RESPONSE_LIMIT: physical("upload said uncertain; a deliberate retry after the orphan is checked"),
  },
  "src/core/forge/providers/gitlab/client.ts": {
    GITLAB_READ_MAX_BYTES: physical("refused in words: GitLab's answer is too large to read; no paging"),
    MAX_DOWNLOAD_REDIRECTS: physical("refused in words: redirected too many times; nothing further"),
  },
  "src/core/forge/providers/gitlab/gitlabForge.ts": {
    MAX_JOB_PAGES: physical("a pending item says more jobs than the app reads; never reads green"),
    MAX_MERGE_COMMIT_READS: physical("none yet: later merged-result pipelines go uncounted, silently"),
  },
  "src/core/forge/providers/gitlab/oauth.ts": {
    MAX_BYTES: physical("sign-in fails in words: oversized sign-in answer; sign in again"),
  },
  "src/core/forge/providers/gitlab/projects.ts": {
    MAX_PAGES: physical("listing says newest only; an exact owner/name is looked up directly"),
  },
  "src/core/forge/releaseFile.ts": {
    RELEASE_UPLOAD_MAX_BYTES: outside("refused in words naming the 2 GB cap; send a smaller file"),
    PATH_MAX: physical("refused in words that do not name the bound; give a shorter path"),
  },
  "src/core/forge/signIns.ts": {
    HEALTH_LOG_MAX_BYTES: physical("the oldest lines drop; the newest half is kept"),
  },
  "src/core/forge/workflows.ts": {
    WORKFLOW_LOG_MAX_BYTES: physical("refused in words naming 8 MiB; no way to read a longer log"),
    WORKFLOW_ARTIFACT_MAX_BYTES: physical("refused in words naming 64 MiB; list a larger one and save selected files"),
  },
  "src/core/forge/zipParts.ts": {
    ZIP_MAX_ENTRIES: outside("refused in words naming 65,534 files; save the selection in parts"),
  },
  "src/core/gifFormat.ts": {
    MAX_GIF_DEMO_LONG_SIDE: physical("refused in words naming 1280 by 720; scale it down"),
    MAX_GIF_DEMO_SHORT_SIDE: physical("refused in words naming 1280 by 720; scale it down"),
    MAX_GIF_DEMO_BYTES: physical("refused in words naming 8 MB; shorten it or make it smaller"),
    MAX_CODES: outside("none needed: the GIF format's own bound"),
  },
  "src/core/helper/route.ts": {
    SOCKET_PATH_MAX_BYTES: outside("refused (no-socket); the folder is made under /tmp to fit"),
  },
  "src/core/hostEnv.ts": {
    SHELL_CAP_ENV: record("the operation goes on; the command prints running: and how to read it"),
  },
  "src/core/integrations/readerReach.ts": {
    READER_INTEGRATION_ANSWER_MAX: outside(
      "not served, in words naming the length and asking for fewer items, one item or a narrower query",
    ),
  },
  "src/core/integrations/store.ts": {
    OLDER_BUILD_OFF_MAX: outside("an older build reads the first ones; the whole list is in actions-off.json"),
  },
  "src/core/jobs/jobManager.ts": {
    SYNC_CAP_MS: record("the command goes on as a background job; its exit wakes the owner"),
    OUTPUT_CAP: physical("tail kept; the rest spills to a file the output names"),
  },
  "src/core/knowledge/access.ts": {
    KNOWLEDGE_LIMITS: physical("pages carry a cursor; a write past 16 KB is refused: split it"),
  },
  "src/core/knowledge/sources.ts": {
    SOURCE_TEXT_MAX_BYTES: physical("refused in words naming 32 KB; cite fewer lines"),
    SOURCE_FILE_MAX_BYTES: physical("refused in words naming 2 MB; a larger file cannot be cited"),
  },
  "src/core/models/piAccountLists.ts": {
    ACCOUNT_LIST_LIMIT_BYTES: physical("the read fails and is logged; the shipped catalog serves the account"),
  },
  "src/core/models/servedModels.ts": {
    CATALOG_READ_CEILING_MS: physical("the read fails as timeout and is logged; the shipped catalog serves"),
  },
  "src/core/notifications.ts": {
    NOTICE_BODY_LIMIT: outside("cut at a whole word with an ellipsis; the whole card stays in the app"),
  },
  "src/core/phonePush.ts": {
    APPLE_PAYLOAD_LIMIT: outside(
      "a withdrawal names the pushes that fit, still-to-go ones first and the rest in the next; when Infinitary opens, the phone removes notifications for cards no longer on the stage or already seen",
    ),
  },
  "src/core/observe/liveBuffer.ts": {
    LIVE_TEXT_MAX: physical("keeps the newest text; the session file has the turn once it ends"),
    LIVE_TOOLS_MAX: physical("keeps the newest 200 tools; the session file has the turn once it ends"),
  },
  "src/core/observe/transcript.ts": {
    TOOL_TEXT_LIMIT: physical("clipped with the omitted count; the session file keeps it whole"),
  },
  "src/core/orchestrator/changePresentations.ts": {
    GITHUB_STORY_BODY_LIMIT: outside("refused in words naming the limit; shorten the story or its text"),
  },
  "src/core/orchestrator/firstmateContext.ts": {
    RESOLVED_CONTEXT_LIMIT: record("the rest are counted; each task's record holds them (tasks by key)"),
    THREAD_CONTEXT_LIMIT: physical("older threads drop out uncounted; each card's thread stays on record"),
    CARD_EXCERPT_LIMIT: physical("clipped with an ellipsis; the card itself keeps the whole body"),
  },
  "src/core/orchestrator/githubGateway.ts": {
    READER_ANSWER_MAX: outside(
      "read again at the largest page that fits; refused in words naming per_page, one item or a narrower path",
    ),
  },
  "src/core/orchestrator/scheduler.ts": {
    MISSED_COUNT_CAP: physical("none in practice: a longer gap reads as 10,000 missed"),
  },
  "src/core/orchestrator/seat.ts": {
    FIRSTMATE_MAX_OUTPUT_TOKENS: record("the turn fails in words naming the 8192-token limit"),
    FIRSTMATE_MAX_MODEL_TURNS: physical("the turn ends saying it stopped after 40 model requests"),
    CLASSIFIER_MAX_OUTPUT_TOKENS: physical("a cut-short answer is still read for its option word"),
  },
  // INF-6664's approved plan set 12 rows; the captain's review choice puts rows marked new first, then oldest first.
  "src/core/orchestrator/standingWork.ts": {
    STANDING_ROW_CAP: {
      rests: "consent",
      way: "the rest are counted as more; each task's record holds them (tasks by key); raise the number in a change that says why",
    },
  },
  "src/core/orchestrator/workflowEvidence.ts": {
    SHORT_READ_MAX_CHARS: physical("jobs past it are left out; the answer counts how many"),
  },
  "src/core/overflow.ts": {
    MESSAGE_EXCERPT_LIMIT: physical("spilled whole to a file; the excerpt carries a pointer to it"),
  },
  "src/core/panels/panelLog.ts": {
    PANEL_LOG_MAX_BYTES: physical(
      "the file moves aside to panels.old.log, replacing the one before; its lines are read there",
    ),
  },
  "src/core/panels/panelProtocol.ts": {
    PANEL_MESSAGE_MAX_BYTES: physical("refused in words naming the bound; the panel sends less"),
  },
  "src/core/personal/panelGraph.ts": {
    PANEL_FILE_CAP: physical("mount refused in words that do not name the bound"),
    PANEL_BYTES_CAP: physical("mount refused in words that do not name the bound"),
  },
  "src/core/personal/sequencesSkill.ts": {
    SEQUENCES_MAX_BYTES: physical("the built-in text serves; a feed line says the file is over 16 KB"),
  },
  "src/core/pi/cardBodyFile.ts": {
    MAX_CARD_BODY_LENGTH: physical("refused in words naming 64KB; emit a smaller card"),
    MAX_FILE_BYTES: physical("refused in words naming 64KB; emit a smaller card"),
  },
  "src/core/pi/cardImages.ts": {
    MAX_PICTURE_BYTES: physical("refused in words naming 8MB; show a smaller picture"),
    MAX_DEMO_BYTES: physical("refused in words naming 16MB; shorten it or lower its quality"),
    MAX_SOUND_CLIP_BYTES: physical("refused in words naming 16MB; shorten it or lower its bitrate"),
    MAX_CARD_PICTURE_BYTES: physical("refused in words naming 64MB; show fewer or smaller ones"),
    MAX_TYPEFACE_BYTES: physical("refused in words naming 8MB; name a smaller subset of the font"),
    MAX_DATA_FILE_BYTES: physical("refused in words naming 8MB; leave out what the card does not draw"),
  },
  "src/core/pi/cardLint.ts": {
    DECISION_ACTIONS_MIN: record("refused in words naming the count; add the other choice or send a note"),
    DECISION_ACTIONS_MAX: record("refused in words naming the count; keep the 2 or 3 that matter"),
    MIN_RENDERED_TYPE: record("refused in words; draw at most 750 units or use larger type"),
  },
  "src/core/pi/cardWidth.ts": {
    NARROW_COPY_LIMIT: record("none needed: it only picks width; a wide/full hint or setting widens"),
  },
  "src/core/pi/customApiCertificates.ts": {
    MAX_PEM_BYTES: physical("refused with a generic certificate sentence that names no bound"),
  },
  "src/core/pi/customApiFile.ts": {
    MAX_MODELS: record("the entry is shown as not read, as a malformed one is; a connection holds 100 models, as the form allows"),
  },
  "src/core/pi/customApiFileSource.ts": {
    MAX_FILE_BYTES: physical("the row says the file cannot be read and the last good reading stands; split or trim the file"),
  },
  "src/core/pi/customApiTransport.ts": {
    MAX_BYTES: physical("a big request is refused as overflow so Pi compacts; big replies fail"),
    LIST_LIMITS: physical("fails in words (too slow, too large); models can be typed by hand"),
    CUSTOM_API_CHECK_LIMITS: physical("the check fails in words; Save paused without checking saves anyway"),
    CUSTOM_API_TURN_LIMITS: physical("the turn fails in words: stalled, timeout or oversized; no auto retry"),
  },
  "src/core/pi/ollamaProfile.ts": {
    OLLAMA_MIN_CONTEXT: physical("refused in words; choose a model with a larger context window"),
  },
  "src/core/pi/personalizeTool.ts": {
    SURFACES_CONTEXT_LIMIT: physical("the rest are a count; an unknown id is refused with every id"),
  },
  "src/core/placed/computerChoice.ts": {
    DIRECTIONS_BUDGET_CHARS: outside("whole directions past it are left out and counted on the question"),
  },
  "src/core/placed/loadLine.ts": {
    JOURNAL_MAX_BYTES: physical(
      "the oldest lines drop so the file on disk stays small; the newest half is kept",
    ),
  },
  "src/core/placed/placedCopies.ts": {
    HAVE_MAX: physical("extra haves drop; the bundle then carries more history"),
  },
  "src/core/plugins/pluginSource.ts": {
    PLUGIN_FILE_CAP: physical("install refused in words naming both caps; ship a smaller panel"),
    PLUGIN_BYTES_CAP: physical("install refused in words naming both caps; ship a smaller panel"),
  },
  "src/core/program/programRunner.ts": {
    PROGRAM_PARTS_CAP: physical("a call past it waits until one of the program's open parts closes"),
  },
  "src/core/prompts/cardContract.ts": {
    CLAUDE_TOOL_DESCRIPTION_CAP: outside("none needed: the client's own cap; tests keep descriptions under it"),
  },
  "src/core/quota/cliProxy/proxyPools.ts": {
    CREDENTIALS_LIMIT_BYTES: physical("refused unread as oversized; the proxy reads unavailable, reason named"),
    MODELS_LIMIT_BYTES: physical("refused unread; its models join no pool and their slots alone admit them"),
  },
  "src/core/quota/grpcWeb.ts": {
    MAX_FIELD_NUMBER: outside("none needed: the format's own bound; a bad message reads as protocol"),
  },
  "src/core/quota/http.ts": {
    BODY_LIMIT_BYTES: physical("refused unread as oversized; the meter reads unavailable, reason named"),
  },
  "src/core/releaseNotes/catalog.ts": {
    MAX_HERO_WIDTH: physical("the release check lists it naming the cap; scale the picture down"),
    MAX_HERO_BYTES: physical("the release check lists it naming the cap; compress the picture"),
    MAX_HIGHLIGHTS: record("a stable takes exactly three picks; the captain chooses them"),
  },
  "src/core/routing/decisionKindClassifier.ts": {
    LIMITS: physical("clipped with ... for the classifier; the whole text stays on the task"),
  },
  "src/core/session/answerFiles.ts": {
    ANSWER_WHOLE_MAX_CHARACTERS: outside(
      "saved whole in the task's temporary folder; the crewmate reads the file it names",
    ),
  },
  "src/core/session/personalSet.ts": {
    PERSONAL_SET_BUDGET_BYTES: physical(
      "the set travels in one frame; a skill past it stays out whole and the home's log names it",
    ),
  },
  "src/core/sharing/sharingService.ts": {
    DIAGNOSTICS_PENDING_CAP: physical("none yet: a new event past it is silently dropped"),
    CONTRIBUTION_PREVIEW_LIMIT: physical("the viewer shows 20 in full and counts the rest"),
  },
  "src/core/storage/inboxStore.ts": {
    INBOX_BACKOFF_CEILING_MS: record("retried every 15 minutes, forever, until the provider answers"),
    // The captain's "after the third identical failure" (INF-3714, direction A).
    STUCK_REFUSAL_LIMIT: {
      rests: "consent",
      way: "the lane stops retrying and the first mate is told once: a steer, a fresh conversation or another model goes on",
    },
  },
  "src/core/storage/scheduleStore.ts": {
    RUN_RETENTION_CAP: physical("the oldest settled runs are deleted for good"),
  },
  "src/shared/ambientOwn.ts": {
    OWN_STYLE_NOTES_MAX: physical(
      "the style is refused in words naming its count and the bound; the first mate writes fewer or sparser parts and saves again",
    ),
    OWN_STYLE_CHARS_MAX: physical(
      "the style is refused in words naming the length; the first mate says it in fewer parts and saves again",
    ),
  },
  "src/shared/automation.ts": {
    // The captain's choice on INF-4208: "About 8,000 characters, around 1,200 words".
    RULE_NOTES_MAX_CHARS: {
      rests: "consent",
      way: "a longer page is refused in words naming both sizes; the crewmate or the captain removes lines and saves again",
    },
  },
  "src/core/tasks/crewActions.ts": {
    ACTION_TEXT_MAX: physical("clipped with an ellipsis; the session file keeps the whole call"),
    FOLLOWED_MAX: physical("the least recently read file is let go and read again from the start"),
  },
  "src/core/tasks/crewTranscript.ts": {
    FOLLOWED_MAX: physical("the least recently read is let go and rebuilt at its next read"),
    LIVE_TEXT_MAX: physical("keeps the newest text; the session has it all after the next call"),
  },
  "src/core/tasks/taskProtocol.ts": {
    SEARCH_LIMIT: physical("older matches drop out unnamed; type more words to narrow"),
  },
  "src/core/tasks/taskTimeline.ts": {
    WORDS_TASKS_MAX: physical("the least recently read task's card words are let go and read again at its next read"),
  },
  "src/core/tasks/taskGraph.ts": {
    MAX_HIERARCHY_WALK: physical("none yet: the ancestor walk stops silently at 64"),
  },
  "src/core/tasks/taskQuery.ts": {
    TASK_QUERY_DEFAULT_LIMIT: physical("the answer says N of total; pass a larger limit, up to 100"),
    TASK_QUERY_MAX_LIMIT: physical("the answer says N of total; narrow by project, status, text, parent"),
  },
  "src/core/tasks/timelineCompaction.ts": {
    TIMELINE_CAP: physical("the oldest fold into one counted head; their words are gone"),
  },
  "src/core/videoFormat.ts": {
    MAX_DEMO_LONG_SIDE: physical("refused in words naming 1920 by 1080; scale it down"),
    MAX_DEMO_SHORT_SIDE: physical("refused in words naming 1920 by 1080; scale it down"),
  },
  "src/core/workspace/projectLocator.ts": {
    MAX_RESULTS: physical("the rest drop unnamed; a fuller name narrows the search"),
  },
  "src/core/workspace/taskBranches.ts": {
    // The captain's approved branch-naming plan chose 48 for a title's slug.
    SLUG_MAX: {
      rests: "consent",
      way: "the slug is cut at a hyphen; the first mate writes the task's branch name instead",
    },
  },
  "src/core/workspace/worktreePool.ts": {
    MAX_IDLE_AGE_MS: physical("the idle slot is retired; the next task builds a fresh copy"),
  },
  "src/main/frames/frameMounts.ts": {
    FRAME_MOUNT_CAP: physical("refused in words naming the cap: unmount one first"),
    CARD_MOUNT_CAP: physical("refused in words naming the cap: unmount one first"),
    PANEL_MOUNT_CAP: physical("refused in words naming the cap: unmount one first"),
  },
  "src/main/host/claudeKeychainTool.ts": {
    MAX_OUTPUT: physical("the read counts as incomplete or untrusted; the next refresh retries"),
  },
  "src/main/host/panelCapture.ts": {
    CAPTURE_STABLE_MAX_POLLS: physical("photographs the last measured box anyway"),
  },
  "src/main/host/chrome/chromeEngine.ts": {
    MIN_CHROME_MAJOR: outside("an older Chrome opens the task browser in the built-in engine, logged as too-old"),
  },
  "src/main/host/pageProtocol.ts": {
    FULL_PAGE_MAX_HEIGHT: physical("cut at 8,000 px without saying so; scroll and photograph the rest"),
  },
  "src/main/keyboard.ts": {
    WITNESSES_MAX: physical("the oldest key's witness drops; its late offer runs nothing, as typed text"),
  },
  "src/shared/attachments.ts": {
    ATTACHMENT_MAX_BYTES: physical("a notice says it is too big; nothing attaches, not even its path"),
    CHOSEN_FILES_MAX: physical("files past twenty are silently not read; choose them again"),
  },
  "src/shared/cardNotes.ts": {
    NOTE_LINE_POINTS_MAX: physical("a longer line is thinned evenly as it is drawn; its start and end are kept"),
    NOTE_PLACE_LINES_MAX: physical("refused as an invalid note; the window writes one line to a note"),
  },
  "src/shared/cards.ts": {
    CARD_CHANGE_MARKS_MAX: physical("past it new parts are counted in the line, not drawn as bars"),
    CARD_MAX_ANSWERS: physical("none yet: the reading is dropped; a click sends an older one or none"),
    CARD_MAX_ANSWER_VALUES: physical("none yet: the reading is dropped; a click sends an older one or none"),
    CARD_ANSWER_NAME_MAX: physical("none yet: the reading is dropped; a click sends an older one or none"),
    CARD_ANSWER_TEXT_MAX: physical("none yet: the reading is dropped; a click sends an older one or none"),
    CARD_ANSWERS_MAX_BYTES: physical("click refused: shorten the answers and try again; picks stay"),
    ANYTHING_ELSE_MAX_CHARS: record("the box stops at 4,000 with a count from 80 percent"),
    CARD_QUESTION_LABEL_MAX: physical("clipped; the definition records the gap label-truncated"),
    CARD_QUESTIONS_MAX_BYTES: physical("definitions not sent, gap too-large; the answers still go"),
    REVISION_TARGETS_MAX: physical("past it the revision offers one Whole card target"),
    TURN_IMAGES_MAX: physical("refused out loud: up to 4 per message; briefs name extras by path"),
    TURN_IMAGE_MAX_BYTES: physical("refused out loud naming 5 MB; the picture is not added"),
    CARD_OBSERVATION_NOTE_MAX: physical("clipped in the observation; the card's resolution keeps the reason"),
  },
  "src/shared/composer.ts": {
    PASTE_FILE_MAX_BYTES: physical("refused in a notice beside the field; held files stay"),
  },
  "src/shared/connection.ts": {
    PAIR_BODY_MAX_BYTES: physical("answered 413; the app's own pairing body never comes close"),
    CONNECTION_MAX_FRAME_BYTES: physical("the socket closes on a larger frame; nothing names why"),
  },
  "src/shared/conversation.ts": {
    // One page's rounds, each read with its card and answer, in one message to the window.
    CONVERSATION_PAGE_MAX: physical("refused by the channel; read the next page from the last round"),
  },
  "src/shared/costLimit.ts": {
    // The captain chose $50 on INF-3112's plan, drawn from their own ledger.
    COST_LIMIT_DEFAULT_USD: {
      rests: "consent",
      way: "the task asks on its card; the captain allows more, lifts it, or changes it in Settings",
    },
    DEFAULT_COST_LIMIT: {
      rests: "consent",
      way: "the task asks on its card; the captain allows more, lifts it, or changes it in Settings",
    },
  },
  "src/shared/feedback.ts": {
    FEEDBACK_LINK_MAX: outside(
      "GitHub refuses longer addresses; the earliest steps go first, then the words are cut with a line saying so",
    ),
    GITHUB_ISSUE_TITLE_MAX: outside("GitHub's issue title limit; refused in words: shorten the title"),
    GITHUB_ISSUE_BODY_MAX: outside(
      "GitHub's issue body limit; the earliest steps go first, then refused in words: shorten it",
    ),
  },
  "src/shared/crewTranscript.ts": {
    CREW_RESULT_TEXT_MAX: physical("clipped; the fold names how many characters were cut"),
    CREW_TEXT_MAX: physical("clipped with an ellipsis; the session file keeps the whole text"),
    CREW_CALL_TEXT_MAX: physical("clipped with an ellipsis; the session file keeps the whole call"),
    CREW_TRANSCRIPT_LINES_MAX: physical("earlier lines are counted, not sent; the tab names how many"),
    CREW_DIFF_LINES_MAX: physical("the rest are counted; the line names how many more"),
  },
  "src/shared/devices.ts": {
    PAIRING_LINK_ALSO_MAX: outside("installed readers refuse more; a link carries the first, the welcome all"),
  },
  "src/shared/emotes.ts": {
    EMOTE_WORDS_MAX: record("refused in words naming 40; nothing shows; resend fewer words"),
  },
  "src/shared/feed.ts": {
    FEED_REPORT_LIMIT: physical("clipped; the whole report stays on the task's record"),
  },
  "src/shared/ipc.ts": {
    VIEW_FLOOR: record(
      "a view below it reads only and is told which side to update; only a major whose file says views break moves it",
    ),
  },
  "src/shared/keyboard.ts": {
    PANEL_COMMAND_ID_MAX: record("the panel's manifest is refused in words; shorten the command's id"),
  },
  "src/shared/keymap.ts": {
    MAX_PANEL_COMMANDS: physical("none yet: the whole list is refused silently; no panel key installs"),
  },
  "src/shared/knowledge.ts": {
    KNOWLEDGE_GRAPH_LIMITS: physical("shown beside total; focus or Find narrows the graph"),
    QUERY_MAX: physical("none yet: a longer Find is refused at the IPC check, unnamed"),
    KNOWLEDGE_REFS_MAX: physical("ids past 32 stay plain text, unlinked"),
  },
  "src/shared/mergeReview.ts": {
    MERGE_REVIEW_CAP: physical("the oldest drops; a card naming it is refused; prepare it again"),
  },
  "src/shared/personal/manifest.ts": {
    MIN_BACKGROUND_INTERVAL_MS: physical("clamped up to 60 s; the panel's snapshot shows the clamped cadence"),
    PERSONAL_STORE_MAX_BYTES: physical("the write throws naming the cap; delete something first"),
    PERSONAL_STORE_VALUE_MAX_BYTES: physical("the write throws naming the bound; nothing changes"),
    PERSONAL_STORE_KEY_MAX_LENGTH: physical("the write throws naming the bound; nothing changes"),
    PERSONAL_REFUSED_MAX: physical("the panels past it are named in the panel log alone"),
  },
  "src/shared/personal/mounts.ts": {
    PANEL_MOUNT_WHY_MAX: physical("clipped with an ellipsis at the window; the rest is not sent"),
    PANEL_MOUNTS_MAX: physical("refused runbook panels past it are left out of the answer; the snapshot still lists them"),
  },
  "src/shared/placement.ts": {
    RESOLVED_TOOL_LIMIT: record("none needed: no resolved set can exceed it"),
    FLOOR_REJECTIONS: record("the start is held until that level's reset, then placed again"),
  },
  "src/shared/quotaSignals.ts": {
    // INF-1714: the captain chose 10%, a policy value, not a measured safe limit.
    CREW_NEAR_FLOOR_PERCENT: {
      rests: "consent",
      way: "none needed: a near-floor allowance still serves, after every one above it",
    },
  },
  "src/shared/plugins/bridge.ts": {
    ACTION_VALUE_MAX_BYTES: physical("refused with value_too_large naming the bound; send less"),
    FRAME_MAX_SUBSCRIPTIONS: physical("refused naming the bound; unsubscribe one first"),
    FRAME_MAX_IN_FLIGHT: physical("refused naming the bound; wait for an answer and ask again"),
    FRAME_MAX_PICTURES: physical("none yet: the image message is dropped; the picture does not open"),
    FRAME_PICTURE_SRC_MAX: physical("none yet: the image message is dropped; the picture does not open"),
    FRAME_FIND_TEXT_MAX: physical("none yet: a page's words past the bound are not read, so a match there is not found"),
    FRAME_PICTURE_ALT_MAX: physical("none yet: the image message is dropped; the picture does not open"),
    FRAME_EXPAND_STATE_MAX: physical("inf.expand returns false and posts nothing; the part opens its still picture"),
    FRAME_DEMO_SRC_MAX: record("none needed: every name the host serves fits; others are dropped"),
    FRAME_DEMO_CAPTION_MAX: physical("clipped for the player; the card body keeps the whole caption"),
    FRAME_LOG_SRC_MAX: record("none needed: every log name the host serves fits; others are dropped"),
    FRAME_LOG_NAME_MAX: physical("clipped by the bridge; the card body keeps the whole line"),
    FRAME_STORE_KEY_MAX: physical("refused as a malformed request (bad_request); the bound is unnamed"),
    FRAME_DATA_SRC_MAX: record("none needed: every data address the host mints fits; others are refused"),
  },
  "src/shared/plugins/frameDocument.ts": {
    FRAME_TEMPLATE_MAX_BYTES: physical(
      "every card is measured against it before it is shown and handed back to its author with each part's size (cardSizeRefusal); a card body over it still opens words only, its scripts off",
    ),
    FRAME_TITLE_MAX: physical("a longer card title is shortened with an ellipsis before the mount"),
  },
  "src/shared/plugins/manifest.ts": {
    STORAGE_KV_MAX_BYTES: physical("the manifest is refused with the issue; ask for less storage"),
  },
  "src/shared/plugins/panelCards.ts": {
    PANEL_HEADER_MAX: physical("manifest refused with the issue at header; the panel does not load"),
    PANEL_CARD_DATA_MAX_BYTES: physical("refused in words naming the bound; send smaller data"),
    PANEL_CARD_KEPT_MAX_BYTES: physical("refused in words naming the bound; keep less"),
  },
  "src/shared/releaseTracking.ts": {
    // The captain chose up to three asks, 30 or more days apart, on INF-6429.
    STAR_ASKS_MAX: {
      rests: "consent",
      way: "later notes leave the ask out; the project's page stays a link anyone can open",
    },
  },
  "src/shared/remoteLogin.ts": {
    REMOTE_LOGIN_TIME_LIMIT_MS: physical("stopped in words naming 30 minutes; nothing changed there, ask again"),
  },
  "src/shared/savedResets.ts": {
    CODEX_SAVED_RESET_FLOOR: outside(
      "the oldest Codex CLI whose app-server names each saved reset; an older one is refused in words that say to update Codex, or to use the reset on chatgpt.com",
    ),
  },
  "src/shared/signIns.ts": {
    SIGN_IN_ANSWER_MAX_CHARS: physical("none yet: the IPC refuses it and the window drops the error silently"),
    SERVED_MODELS_MAX: physical("past 2,000 the board's listed models go first, the rest drop"),
    ACCOUNT_LIST_ID_MAX: physical("a longer id is left out; the rest of the list still reads"),
  },
  "src/shared/sql.ts": {
    SQL_LIMITS: physical("cut at a whole row, marked truncated; a narrower query reads more"),
  },
  "src/shared/sshConnection.ts": {
    SSH_MESSAGE_MAX_BYTES: physical("a longer line ends the SSH session; the app's own lines stay short"),
  },
  "src/shared/taskBrowser.ts": {
    TASK_BROWSER_PAGE_MIN: physical("the view's room is clamped up to it; the page lays out there"),
    TASK_BROWSER_PAGE_MAX: physical("the view's room is clamped down to it; the page lays out there"),
    TASK_BROWSER_PASTE_MAX: physical("a longer paste carries no words; the page pastes from its own clipboard"),
    TASK_BROWSER_PLACES_MAX: physical("later things are left out of the read; a mark there still names its box"),
  },
  "src/shared/taskKeys.ts": {
    TASK_KEYS_MAX: physical("later keys stay plain text, unlinked"),
  },
  "src/shared/taskPlan.ts": {
    PLAN_LINE_MAX: physical("the line folds its tail; the record lists every item"),
  },
  "src/shared/taskTitle.ts": {
    TASK_TITLE_MAX: physical("an author is refused naming 64 and its length; a host title ends on a whole word"),
  },
  "src/shared/usage.ts": {
    USAGE_TASKS_MAX: physical("none yet: Show more stops at 5,000; older tasks are not listed"),
    COST_MIN_TASKS: {
      rests: "consent",
      way: "the captain's approved Cost per task plan; a thinner window reads too few tasks and its count, never 0",
    },
  },
  "src/shared/voice.ts": {
    VOICE_CLIP_MAX_SAMPLES: physical("never met: capture stops at 120 s; past it, refused as too long"),
  },
  "src/shared/work.ts": {
    PLACED_EVENTS_MAX_PER_REQUEST: physical("batched: the rest go in the next request"),
    PICTURE_DATA_MAX_CHARS: physical("none needed: the card tool refuses pictures over 8 MiB first"),
    RECORDING_PIECE_MAX_CHARS: physical("none needed: the sender cuts recordings into 1 MiB pieces"),
    RECORDING_MAX_BYTES: physical("the card tool refuses first, naming 16MB: shorten or lower quality"),
    SESSION_COPY_FROM_MAX: physical(
      "past it the home names staged skills only for sessions that computer still holds",
    ),
  },
  "src/shared/writeAsk.ts": {
    WRITE_ASK_CAP: physical(
      "answered asks drop first; a waiting one that drops is refused at once; ask again",
    ),
  },
};

/** Each limit that rests on a number the app made up, by file, with its way out ("none yet" when it has none). */
export const BASELINE: Record<string, Record<string, string>> = {
  "src/core/accounts/credentialHealth.ts": {
    CREDENTIAL_RENEW_MAX_ATTEMPTS: "proactive renewal stops; a vendor rejection or a remedy still renews",
  },
  "src/core/forge/projects.ts": {
    MAX_LISTED: "first 8 shown, hidden matches uncounted; a fuller name narrows it",
  },
  "src/core/gifFormat.ts": {
    MAX_GIF_DEMO_SECONDS: "refused in words naming 10 seconds; trim it to the action",
    MAX_GIF_DEMO_FRAME_RATE: "refused in words naming the rate; re-encode at 10 or fewer",
    MAX_GIF_DEMO_FRAMES: "refused in words naming seconds and rate; trim or slow it",
    MIN_DELAY_CS: "refused in words naming the rate; re-encode at 10 or fewer",
  },
  "src/core/knowledge/access.ts": {
    MAX: "refused in words naming the field's bound; shorten it",
  },
  "src/core/orchestrator/mergeAuthorization.ts": {
    MAX_RETRY_MS: "re-read on the tick at least every 30 min; a new wait or head resets",
  },
  "src/core/orchestrator/reportPlausibility.ts": {
    MIN_REPORT_WORDS: "refused naming the bound; the crewmate stays steerable to report again",
  },
  "src/core/orchestrator/runWatch.ts": {
    RUN_WATCH_LIMIT: "refused in words; read it with read_workflow once a slot is free",
  },
  "src/core/pi/cardTool.ts": {
    STABLE_CARD_ID_MAX: "refused in words naming 64; choose a shorter kebab-case id",
  },
  "src/core/pi/customApiCertificates.ts": {
    MAX_CERTIFICATES: "refused with a generic certificate sentence that names no bound",
  },
  "src/core/quota/fetchQuota.ts": {
    CLAUDE_RATE_LIMIT_BACKOFF_MS: "waited out (or a longer retry-after); the last reading serves",
  },
  "src/core/routing/accountRouter.ts": {
    FLAGSHIP_RESERVE_FLOOR_PERCENT: "none needed: only quoted in the reason; the flagship goes last anyway",
  },
  "src/core/storage/inboxStore.ts": {
    INBOX_ATTEMPT_MAX: "set aside; the first mate is told, with the guidance, to act on it",
  },
  "src/core/storage/scheduleStore.ts": {
    MIN_INTERVAL_MINUTES: "refused in words naming 15 minutes; choose a longer interval",
  },
  "src/core/videoFormat.ts": {
    MAX_DEMO_SECONDS: "refused in words naming 30 seconds; trim it to the action",
    MAX_DEMO_FRAME_RATE: "refused in words naming 30; re-encode at 30 or fewer",
  },
  "src/shared/accounts.ts": {
    ACCOUNT_LABEL_MAX: "the rename field stops typing at 64; IPC refuses a longer label",
  },
  "src/shared/cards.ts": {
    LIVE_ATTACHMENT_LABEL_MAX: "card refused in words naming the bound; emit a shorter label",
    PROJECT_PAGE_PATH_MAX: "card refused with the path rule, which does not name the length",
    RISK_WHY_MAX: "card refused in words naming the bound; emit a shorter line",
    CARD_WRITTEN_MAX: "the field stops typing at 500 (maxlength); a reading is clipped",
    CARD_REPLY_MAX_CHARS: "refused naming the bound; say it shorter, or paste it as a file",
    CONVERSE_TEXT_MAX_CHARS: "send refused in words: trim it, or paste the long part as a file",
  },
  "src/shared/composer.ts": {
    PASTE_FILES_MAX: "refused in a notice: up to 4 files; send, then add the rest",
  },
  "src/shared/customApi.ts": {
    CUSTOM_API_MAX_HEADERS: "Add header hides at 20; Save refuses more, words name no count",
  },
  "src/shared/keymap.ts": {
    MAX_KEYS_PER_COMMAND: "the save is refused beside the row; remove a key first",
  },
  "src/shared/personal/contracts.ts": {
    PANEL_DRAFT_MAX: "point.draft throws naming the bound; nothing is drafted",
  },
  "src/shared/personal/manifest.ts": {
    PERSONAL_ID_MAX_LENGTH: "add refused in words naming 48; nothing renames the panel",
  },
  "src/shared/placement.ts": {
    PLACEMENT_FACT_MAX_AGE_MS: "an older reading counts as unknown; the computer is not chosen on it",
  },
  "src/shared/plugins/bridge.ts": {
    FRAME_DRAFT_MAX: "none yet: a longer draft press is dropped; the author is not told",
  },
  "src/shared/plugins/panelCards.ts": {
    PANEL_COMMANDS_MAX: "manifest refused with the issue at commands; panel does not load",
    PANEL_CARD_VIEWS_MAX: "compile or manifest refused in words naming the bound",
    PANEL_OPEN_CARDS_MAX: "refused naming the bound; close one with cards.close first",
    PANEL_COMMAND_WORDS_MAX: "manifest refused with the issue at words; panel does not load",
    PANEL_COMMAND_WORD_MAX: "manifest refused with the issue at words; panel does not load",
  },
  "src/shared/resources.ts": {
    RESOURCE_MAX_SAMPLE_MS: "reads as unknown (interrupted); a later read samples again",
    RESOURCE_MAX_AGE_MS: "a stale reading counts as unknown; the computer waits for a fresh one",
  },
  "src/shared/taskBrowser.ts": {
    TASK_BROWSER_PAGES_MAX: "refused and named; close a page, or open its address yourself",
    TASK_BROWSER_REQUEST_MAX: "the card is refused in words naming 200; resend it shorter",
  },
};

export type NamedLimit = { path: string; line: number; name: string };

/** Every named limit `text` declares, in order; a `const` a comment quotes declares none. */
export function namedLimitsIn(path: string, text: string): NamedLimit[] {
  const limits: NamedLimit[] = [];
  for (const match of text.matchAll(/^[ \t]*(?:export[ \t]+)?const[ \t]+([A-Z][A-Z0-9_]*)[ \t]*[:=]/gm)) {
    const name = match[1] ?? "";
    if (!name.split("_").some((word) => LIMIT_WORDS.includes(word))) continue;
    limits.push({ path, line: text.slice(0, match.index).split("\n").length, name });
  }
  return limits;
}

export function readsFile(path: string): boolean {
  return (
    LIMIT_ROOTS.some((root) => path === root || path.startsWith(`${root}/`)) &&
    /\.tsx?$/.test(path) &&
    !/\.test\.tsx?$/.test(path)
  );
}

export function limitProblems(
  limits: readonly NamedLimit[],
  ledger: Record<string, Record<string, LimitEntry>>,
  baseline: Record<string, Record<string, string>>,
): string[] {
  const problems: string[] = [];
  const found = new Set(limits.map((limit) => `${limit.path} ${limit.name}`));
  const reported = new Set<string>();
  for (const limit of limits) {
    const key = `${limit.path} ${limit.name}`;
    if (reported.has(key)) continue;
    reported.add(key);
    const classified = ledger[limit.path]?.[limit.name];
    const made = baseline[limit.path]?.[limit.name];
    if (classified && made !== undefined)
      problems.push(
        `${limit.path}:${limit.line}: ${limit.name} is in both LIMITS and BASELINE; keep the one entry that says what it rests on`,
      );
    else if (!classified && made === undefined)
      problems.push(
        `${limit.path}:${limit.line}: ${limit.name} is a named limit the ledger does not hold; add it to LIMITS in scripts/limits.ts with what it rests on and its way out, or, if it rests on a number the app made up, give that judgment to the agent instead (docs/agents-reach.md)`,
      );
    else if (classified && !classified.way.trim())
      problems.push(`${limit.path}:${limit.line}: ${limit.name} names no way out; say what work does when it meets the limit`);
    else if (made !== undefined && !made.trim())
      problems.push(`${limit.path}:${limit.line}: ${limit.name} names no way out; say what passes it, or "none yet"`);
  }
  for (const [part, entries] of [
    ["LIMITS", ledger],
    ["BASELINE", baseline],
  ] as const)
    for (const [path, names] of Object.entries(entries))
      for (const name of Object.keys(names))
        if (!found.has(`${path} ${name}`))
          problems.push(
            `scripts/limits.ts: ${part} holds ${name} in ${path}, which the code no longer declares; remove the entry${part === "BASELINE" ? ", and the baseline shrinks" : ""}`,
          );
  return problems;
}

/** Every named limit at `root`, in its tracked files and in new ones git does not ignore. */
export function namedLimits(root: string): NamedLimit[] {
  const paths = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...LIMIT_ROOTS],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\0")
    .filter(readsFile);
  return paths.flatMap((path) => {
    try {
      return namedLimitsIn(path, readFileSync(resolve(root, path), "utf8"));
    } catch {
      // A tracked file deleted in the working copy.
      return [];
    }
  });
}

function main(argv: string[]): number {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const limits = namedLimits(root);
  const restsOn = (limit: NamedLimit): string =>
    LIMITS[limit.path]?.[limit.name]?.rests ??
    (BASELINE[limit.path]?.[limit.name] !== undefined ? "made-up number" : "UNCLASSIFIED");
  if (argv.includes("--list")) {
    for (const limit of limits) {
      const way = LIMITS[limit.path]?.[limit.name]?.way ?? BASELINE[limit.path]?.[limit.name] ?? "";
      console.log(`${restsOn(limit)}\t${limit.name}\t${limit.path}:${limit.line}\t${way}`);
    }
    return 0;
  }
  if (argv.includes("--counts")) {
    const counts = new Map<string, number>();
    const seen = new Set<string>();
    for (const limit of limits) {
      const key = `${limit.path} ${limit.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      counts.set(restsOn(limit), (counts.get(restsOn(limit)) ?? 0) + 1);
    }
    for (const [rests, count] of [...counts].sort())
      console.log(`${String(count).padStart(6)}  ${rests}${rests === "made-up number" ? " (the baseline)" : ""}`);
    console.log(`${String(seen.size).padStart(6)}  every named limit`);
    return 0;
  }
  const problems = limitProblems(limits, LIMITS, BASELINE);
  for (const problem of problems) console.error(problem);
  if (problems.length) {
    console.error(`limits: ${problems.length} out of step with the ledger`);
    return 1;
  }
  const baseline = Object.values(BASELINE).reduce((sum, names) => sum + Object.keys(names).length, 0);
  console.log(`limits: ${new Set(limits.map((limit) => `${limit.path} ${limit.name}`)).size} named limits, each in the ledger; ${baseline} in the baseline`);
  return 0;
}

// An exit code, not process.exit, so a piped list is written whole.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
