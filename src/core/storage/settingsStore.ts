import { ownStylesSchema } from "@shared/ambientOwn";
import { type CostLimit, costLimitSchema, DEFAULT_COST_LIMIT } from "@shared/costLimit";
import {
  DEFAULT_DECISIONS,
  type DecisionsSettings,
  decisionsSettingsSchema,
} from "@shared/decisions";
import { type DecisionUseSwitches, decisionUseSwitchesSchema } from "@shared/decisionUses";
import {
  DEFAULT_DICTATION,
  type DictationKey,
  type DictationSettings,
  dictationSettingsSchema,
} from "@shared/dictation";
import { EMPTY_FIRST_RUN, type FirstRunRecord, firstRunRecordSchema } from "@shared/firstRun";
import { fontChoicesSchema } from "@shared/fonts";
import { readSavedKeymap, type SavedKeymap, type SavedKeymapRead } from "@shared/keymap";
import {
  DEFAULT_LOCAL_ORCHESTRATOR_SETTING,
  type LocalOrchestratorSetting,
  localOrchestratorSettingSchema,
} from "@shared/localOrchestrator";
import {
  EMPTY_MODEL_SLOTS,
  type ModelSlotsState,
  modelSlotsStateSchema,
  type SavedServedStarters,
  type ServedBaselines,
  savedServedStartersSchema,
  servedBaselinesSchema,
} from "@shared/modelSlots";
import {
  type Appearance,
  ambientStyleSchema,
  ambientVolumeSchema,
  appearanceSchema,
  DEFAULT_AMBIENT_VOLUME,
  DEFAULT_APPEARANCE,
  DEFAULT_LAYOUT,
  DEFAULT_PERSONAL_PANELS,
  foldAmbientPause,
  type Layout,
  languageChoiceSchema,
  layoutSchema,
  type PersonalPanels,
  panelArrangementSchema,
  personalPanelsSchema,
} from "@shared/preferences";
import {
  type PiModelRefView,
  piModelRefViewSchema,
  type RoutingSettings,
  routingSettingsSchema,
} from "@shared/quota";
import {
  type ReleaseTrackingRecord,
  releaseTrackingSchema,
  UNKNOWN_RELEASE_TRACKING,
} from "@shared/releaseTracking";
import { DEFAULT_SHARING, type Sharing, sharingSchema } from "@shared/sharing";
import { DEFAULT_SUMMARY_POINT, type SummaryPoint, summaryPointSchema } from "@shared/summaryPoint";
import { tagCheckReachSchema } from "@shared/tagCheck";
import { z } from "zod";
import { runbookStateSchema } from "../../shared/runbooks";
import { type SeatDigestEntry, seatDigestEntrySchema } from "../orchestrator/seatDigest";
import type { AppDatabase } from "./db";

const personalSeenSchema = z.object({ version: z.string(), since: z.number() });

const dockSchema = z.object({ showInDock: z.boolean() });

const projectsFolderSchema = z.object({ path: z.string().min(1) });

const firstmateMovedFromSchema = z.object({
  providerId: z.string(),
  accountId: z.string(),
  class: z.enum(["signed_out", "no_headroom", "refused", "client", "unavailable"]),
  offered: z.boolean().optional(),
});

/** A check of existing tasks kept across a restart (`getTagCheck`). */
const savedTagCheckSchema = z.strictObject({
  projectId: z.string().min(1),
  reach: tagCheckReachSchema,
  tagIds: z.array(z.string().min(1)).min(1).nullable(),
  at: z.number().finite(),
  total: z.number().int().nonnegative(),
});
export type SavedTagCheck = z.infer<typeof savedTagCheckSchema>;

export type FirstmateMovedFrom = z.infer<typeof firstmateMovedFromSchema>;

const firstmatePausedSchema = z.object({
  accountId: z.string(),
  class: z.enum(["signed_out", "no_headroom", "refused", "client", "unavailable"]),
  move: z.string().optional(),
});
export type FirstmatePaused = z.infer<typeof firstmatePausedSchema>;

/** What one launch left behind for the next one to read (Step 5). */
export const launchRecordSchema = z.object({
  /** True while a launch has not settled; a launch that finds it true is after a crash. */
  pending: z.boolean(),
  /** Consecutive launches that ended before settling. */
  earlyCrashes: z.number().int().min(0),
});
export type LaunchRecord = z.infer<typeof launchRecordSchema>;

/** The `panel-arrangement` row: where every panel sits, and the last More pick. */
const panelArrangementRowSchema = z.strictObject({
  arrangement: panelArrangementSchema,
  morePick: z.string().min(1).max(64).optional(),
});

/** The `card-maximize` row: whether Keep cards maximized is on, and whether cards are maximized now. */
const cardMaximizeRowSchema = z.strictObject({
  keep: z.boolean(),
  maximized: z.boolean(),
});

/** The `language` row: the language the captain chose (docs/i18n.md, "The language choice"). */
const languageRowSchema = z.strictObject({ language: languageChoiceSchema });

/** The `fonts` row: the fonts the captain chose (docs/fonts.md). */
const fontsRowSchema = z.strictObject({ fonts: fontChoicesSchema });

/** The `ambient-music` row: the ambient music's switch and volume (docs/ambient-music.md). */
const ambientMusicRowSchema = z.strictObject({ on: z.boolean(), volume: ambientVolumeSchema });

/** The `ambient-style` row: which style the ambient music plays (docs/ambient-music.md). */
const ambientStyleRowSchema = z.strictObject({ style: ambientStyleSchema });
/** The `ambient-own-styles` row: the person's own styles (docs/ambient-music.md, "Your own styles"). */
const ambientOwnRowSchema = z.strictObject({ styles: ownStylesSchema });

export class SettingsStore {
  private projection: Map<string, unknown> | undefined;

  /** Share validated settings only for one synchronous derived read. */
  readProjection<T>(read: () => T): T {
    if (this.projection) return read();
    this.projection = new Map();
    try {
      return read();
    } finally {
      this.projection = undefined;
    }
  }

  private projected<T>(key: string, read: () => T): T {
    if (this.projection?.has(key)) return this.projection.get(key) as T;
    const value = read();
    this.projection?.set(key, value);
    return value;
  }

  /** Learned points per listed-price dollar, keyed by login pool and window (INF-443). */
  getAllowancePrices(): Record<string, number> {
    const parsed = z
      .record(z.string(), z.number().positive().finite())
      .safeParse(this.get("allowance-prices"));
    return parsed.success ? parsed.data : {};
  }

  setAllowancePrices(prices: Record<string, number>): void {
    this.set("allowance-prices", prices);
  }

  constructor(
    private readonly db: AppDatabase,
    /**
     * The dictation key until the person picks one: right ⌥ on a Mac, right
     * Ctrl on Linux, where right Alt types accents (src/shared/platform.ts,
     * `desktopConventions`). The core passes its host's.
     */
    private readonly dictationKey: DictationKey = DEFAULT_DICTATION.key,
  ) {}

  private has(key: string): boolean {
    return this.db.prepare("SELECT 1 FROM settings WHERE key = ?").get(key) !== undefined;
  }

  private get(key: string): unknown {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value);
    } catch {
      return undefined;
    }
  }

  private set(key: string, value: unknown): void {
    this.projection?.delete(key);
    this.db
      .prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, JSON.stringify(value));
  }

  private remove(key: string): void {
    this.projection?.delete(key);
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  getRoutingSettings(): RoutingSettings {
    return this.projected("routing", () => {
      const parsed = routingSettingsSchema.safeParse(this.get("routing"));
      return parsed.success
        ? { ...parsed.data, dynamicRouting: true }
        : { dynamicRouting: true, pins: [] };
    });
  }

  setRoutingSettings(settings: RoutingSettings): void {
    if (!settings.dynamicRouting) return; // A legacy client cannot turn routing off.
    const current = this.getRoutingSettings();
    const dormant = current.dormantPins;
    if (dormant?.length && settings.dormantPins === undefined) return;
    const dormantPins = settings.dormantPins?.length === 0 ? undefined : dormant;
    this.set("routing", {
      dynamicRouting: true,
      pins: settings.pins,
      ...(dormantPins?.length ? { dormantPins } : {}),
    });
  }

  /**
   * The install's model-slot record. An offering absent from `assignments`
   * is off; an offering absent from `seen` has never been seeded.
   */
  getModelSlots(): ModelSlotsState {
    return this.projected("model-slots", () => {
      const parsed = modelSlotsStateSchema.safeParse(this.get("model-slots"));
      return parsed.success ? parsed.data : { ...EMPTY_MODEL_SLOTS, assignments: {}, seen: [] };
    });
  }

  setModelSlots(state: ModelSlotsState): void {
    this.set("model-slots", state);
  }

  /** The last successful catalog read per account (docs/model-lists.md). */
  getServedBaselines(): ServedBaselines {
    const parsed = servedBaselinesSchema.safeParse(this.get("served-baselines"));
    return parsed.success ? parsed.data : {};
  }

  setServedBaselines(baselines: ServedBaselines): void {
    this.set("served-baselines", baselines);
  }

  /** The served starter list as last read (docs/model-lists.md), or none. */
  getServedStarters(): SavedServedStarters | null {
    const parsed = savedServedStartersSchema.safeParse(this.get("served-starters"));
    return parsed.success ? parsed.data : null;
  }

  setServedStarters(saved: SavedServedStarters): void {
    this.set("served-starters", saved);
  }

  /**
   * Which model answers typed decisions, and whether a native one's egress
   * is on (S7, `src/shared/decisions.ts`). Absent - every install before
   * S7, and every fresh one - is the adapter's own walk over the cheapest
   * slotted model, which is what the app already did. The KEY is not here:
   * it lives in its own 0700 store, so this row carries no secret.
   */
  getDecisions(): DecisionsSettings {
    const parsed = decisionsSettingsSchema.safeParse(this.get("decisions"));
    return parsed.success ? parsed.data : DEFAULT_DECISIONS;
  }

  private readonly decisionListeners = new Set<() => void>();
  /** Hears every change to the decisions row or the use switches. */
  onDecisionsChanged(listener: () => void): () => void {
    this.decisionListeners.add(listener);
    return () => this.decisionListeners.delete(listener);
  }

  setDecisions(decisions: DecisionsSettings): void {
    this.set("decisions", decisions);
    this.decisionsChanged();
  }

  /**
   * The person's decision model use switches (`src/shared/decisionUses.ts`),
   * a row of their own so an older build reading the decisions row never
   * meets a field it does not know. Absent or unreadable: every use at its
   * kind's default.
   */
  getDecisionUses(): DecisionUseSwitches {
    const parsed = decisionUseSwitchesSchema.safeParse(this.get("decision-uses"));
    return parsed.success ? parsed.data : {};
  }

  setDecisionUses(switches: DecisionUseSwitches): void {
    this.set("decision-uses", switches);
    this.decisionsChanged();
  }

  private decisionsChanged(): void {
    for (const listener of this.decisionListeners) {
      try {
        listener();
      } catch {
        console.warn("[settings] decision observer failed");
      }
    }
  }

  /**
   * The captain's presentation choices (src/shared/preferences.ts). Held
   * here, not in the window, so they survive a relaunch with a fresh window
   * profile and are readable by anything but the renderer.
   */
  getAppearance(): Appearance {
    const parsed = appearanceSchema.safeParse(this.get("appearance"));
    let appearance = parsed.success ? parsed.data : DEFAULT_APPEARANCE;
    if (parsed.success && !this.has("wash-opacity-v2")) {
      // The old slider was a percentage of 78% opacity. The old default
      // (100) now follows the accepted 20% look; preserve other deliberate
      // strengths as their approximate visual opacity.
      const oldStrength = parsed.data.washStrength ?? 100;
      const converted = {
        ...parsed.data,
        washStrength: oldStrength === 100 ? 20 : Math.round(oldStrength * 0.78),
      };
      this.set("appearance", converted);
      this.set("wash-opacity-v2", true);
      appearance = converted;
    }
    if (!this.has("wash-default-zero-v1")) {
      if (appearance.washStrength === 20) {
        appearance = { ...appearance, washStrength: 0 };
        this.set("appearance", appearance);
      }
      this.set("wash-default-zero-v1", true);
    }
    const maximize = cardMaximizeRowSchema.safeParse(this.get("card-maximize"));
    const language = languageRowSchema.safeParse(this.get("language"));
    const fonts = fontsRowSchema.safeParse(this.get("fonts"));
    const ambient = ambientMusicRowSchema.safeParse(this.get("ambient-music"));
    const style = ambientStyleRowSchema.safeParse(this.get("ambient-style"));
    const own = ambientOwnRowSchema.safeParse(this.get("ambient-own-styles"));
    return foldAmbientPause({
      ...DEFAULT_APPEARANCE,
      ...appearance,
      ...(maximize.success
        ? { keepCardsMaximized: maximize.data.keep, cardsMaximized: maximize.data.maximized }
        : {}),
      ...(language.success ? { language: language.data.language } : {}),
      ...(fonts.success && Object.keys(fonts.data.fonts).length > 0
        ? { fonts: fonts.data.fonts }
        : {}),
      ...(ambient.data?.on && this.get("ambient-paused") === true ? { ambientPaused: true } : {}),
      ...(this.get("ambient-away-plays") === true ? { ambientPlaysWhenAway: true } : {}),
      ...(ambient.success
        ? { ambientMusic: ambient.data.on, ambientVolume: ambient.data.volume }
        : {}),
      ...(style.success ? { ambientStyle: style.data.style } : {}),
      ...(own.success && own.data.styles.length > 0 ? { ambientOwnStyles: own.data.styles } : {}),
    });
  }

  /**
   * Saves the look. Keep cards maximized and whether cards are maximized go
   * to their own row (`card-maximize`), so the `appearance` row stays one an
   * older build parses (docs/saved-data-compatibility.md); a look without
   * them keeps the saved ones. The language goes to its own row too
   * (`language`), and a look without it follows the computer again: the
   * window always writes the whole look, so a missing language is the
   * captain's choice to follow the computer. The fonts go to their own row
   * (`fonts`) the same way, and a look without them takes Infinitary's own.
   * The ambient music's switch and volume go to their own row
   * (`ambient-music`), and a look without them keeps the saved ones; its
   * style goes to `ambient-style` the same way. Keep playing while away is
   * `ambient-away-plays`, kept only while on. A look saved paused, by this
   * build's read of the old `ambient-paused` row or by an older view, is
   * saved off and the row removed (`foldAmbientPause`). The person's own styles go to
   * `ambient-own-styles`; a look without them keeps the saved ones, and an
   * empty list removes the row.
   */
  setAppearance(appearance: Appearance): void {
    const { language: _saved, fonts: _savedFonts, ...was } = this.getAppearance();
    const {
      keepCardsMaximized,
      cardsMaximized,
      language,
      fonts,
      ambientMusic,
      ambientPaused: _paused,
      ambientPlaysWhenAway,
      ambientVolume,
      ambientStyle,
      ambientOwnStyles,
      ...look
    } = foldAmbientPause({
      ...was,
      ...appearance,
    });
    if (ambientMusic !== undefined || ambientVolume !== undefined)
      this.set("ambient-music", {
        on: ambientMusic ?? false,
        volume: ambientVolume ?? DEFAULT_AMBIENT_VOLUME,
      });
    if (ambientStyle !== undefined) this.set("ambient-style", { style: ambientStyle });
    if (ambientOwnStyles !== undefined) {
      if (ambientOwnStyles.length === 0) this.remove("ambient-own-styles");
      else this.set("ambient-own-styles", { styles: ambientOwnStyles });
    }
    this.remove("ambient-paused");
    if (ambientPlaysWhenAway) this.set("ambient-away-plays", true);
    else this.remove("ambient-away-plays");
    if (language === undefined) this.remove("language");
    else this.set("language", { language });
    if (fonts === undefined || Object.keys(fonts).length === 0) this.remove("fonts");
    else this.set("fonts", { fonts });
    this.set("appearance", look);
    this.set("wash-opacity-v2", true);
    if (keepCardsMaximized !== undefined || cardsMaximized !== undefined)
      this.set("card-maximize", {
        keep: keepCardsMaximized ?? false,
        maximized: cardsMaximized ?? false,
      });
  }

  /**
   * The rails' layout: the `layout` row, with the arrangement and the last
   * More pick from a row of their own (`panel-arrangement`), so an older
   * build, which reads `layout` strictly, still parses it and keeps the
   * collapse choices (docs/saved-data-compatibility.md).
   */
  getLayout(): Layout {
    const parsed = layoutSchema.safeParse(this.get("layout"));
    const {
      arrangement: _row,
      morePick: _pick,
      ...layout
    } = parsed.success ? parsed.data : DEFAULT_LAYOUT;
    const arranged = panelArrangementRowSchema.safeParse(this.get("panel-arrangement"));
    if (!arranged.success) return layout;
    return {
      ...layout,
      arrangement: arranged.data.arrangement,
      ...(arranged.data.morePick ? { morePick: arranged.data.morePick } : {}),
    };
  }

  /**
   * Saves the layout. One without an arrangement keeps the saved
   * arrangement and More pick; one with an arrangement saves both as given.
   */
  setLayout(layout: Layout): void {
    const { arrangement, morePick, ...rest } = layout;
    this.set("layout", rest);
    if (arrangement)
      this.set("panel-arrangement", { arrangement, ...(morePick ? { morePick } : {}) });
  }

  /**
   * The host-owned switch over the captain's own panels (Step 5). Absent
   * (every install before Step 5) means on, which is what the app did.
   */
  getPersonalPanels(): PersonalPanels {
    const parsed = personalPanelsSchema.safeParse(this.get("panels"));
    return parsed.success ? parsed.data : DEFAULT_PERSONAL_PANELS;
  }

  setPersonalPanels(panels: PersonalPanels): void {
    this.set("panels", panels);
  }

  /**
   * The keys a person changed on this Mac (docs/keyboard.md, "Changing
   * keys"). Absent is nothing changed; a row that cannot be read is the
   * catalog's keys, said so, and stays as it was until the next change.
   */
  getKeymap(): SavedKeymapRead {
    return readSavedKeymap(this.has("keyboard") ? (this.get("keyboard") ?? null) : undefined);
  }

  setKeymap(keymap: SavedKeymap): void {
    this.set("keyboard", keymap);
  }

  /**
   * A missing row is a fresh install (Diagnostics on). A row that is
   * there but unreadable could have been someone's "off", so it reads as
   * off rather than as the default.
   */
  getSharing(): Sharing {
    const raw = this.get("sharing");
    if (raw === undefined && !this.has("sharing")) return DEFAULT_SHARING;
    const parsed = sharingSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    return { ...DEFAULT_SHARING, diagnostics: { ...DEFAULT_SHARING.diagnostics, enabled: false } };
  }

  setSharing(sharing: Sharing): void {
    this.set("sharing", sharing);
  }

  /** The dev-only local seat's row (roadmap 1.7); a packaged build never reads it. */
  getLocalOrchestrator(): LocalOrchestratorSetting {
    const parsed = localOrchestratorSettingSchema.safeParse(this.get("local-orchestrator"));
    return parsed.success ? parsed.data : DEFAULT_LOCAL_ORCHESTRATOR_SETTING;
  }

  setLocalOrchestrator(setting: LocalOrchestratorSetting): void {
    this.set("local-orchestrator", setting);
  }

  /**
   * The launch marker safe mode is decided from (Step 5, `personal/
   * safeMode.ts`): a row written at boot and cleared once the app has been
   * up long enough to call the launch good, or on a clean quit. A launch
   * that finds the previous one still pending is counting a crash.
   */
  getLaunchRecord(): LaunchRecord {
    const parsed = launchRecordSchema.safeParse(this.get("launch"));
    return parsed.success ? parsed.data : { pending: false, earlyCrashes: 0 };
  }

  setLaunchRecord(record: LaunchRecord): void {
    this.set("launch", record);
  }

  /**
   * Which app version this profile last ran (docs/release-notes.md "Version
   * tracking"). A missing or unreadable row has no known baseline; nothing is
   * inferred from it.
   */
  getReleaseTracking(): ReleaseTrackingRecord {
    const parsed = releaseTrackingSchema.safeParse(this.get("release-tracking"));
    return parsed.success ? parsed.data : UNKNOWN_RELEASE_TRACKING;
  }

  setReleaseTracking(record: ReleaseTrackingRecord): void {
    this.set("release-tracking", releaseTrackingSchema.parse(record));
  }

  /**
   * The first-launch record (docs/first-launch.md): when the host welcomed
   * the captain and when their first turn was accepted, plus durable welcome
   * eligibility/identity. New welcomedAt means committed creation; legacy
   * values mean wake scheduling. The gate remains derived from serving facts.
   */
  getFirstRun(): FirstRunRecord {
    const parsed = firstRunRecordSchema.safeParse(this.get("first-run"));
    return parsed.success ? parsed.data : EMPTY_FIRST_RUN;
  }

  setFirstRun(record: FirstRunRecord): void {
    this.set("first-run", record);
  }

  getDictation(): DictationSettings {
    const parsed = dictationSettingsSchema.safeParse(this.get("dictation"));
    return parsed.success ? parsed.data : { ...DEFAULT_DICTATION, key: this.dictationKey };
  }

  setDictation(setting: DictationSettings): void {
    this.set("dictation", setting);
  }

  getRunbookStates(): Record<string, boolean> {
    const parsed = runbookStateSchema.safeParse(this.get("runbooks"));
    if (!parsed.success) return {};
    // Batched pull requests was saved as `queue` before its id became `batches`: the choice carries.
    const { queue, ...states } = parsed.data;
    return queue === undefined || states.batches !== undefined
      ? states
      : { ...states, batches: queue };
  }

  setRunbookStates(states: Record<string, boolean>): void {
    this.set("runbooks", runbookStateSchema.parse(states));
  }

  /** Global instructions and skills for new crewmate sessions, off by default. */
  getPersonalResourcesEnabled(): boolean {
    return this.get("personal-resources") === true;
  }

  setPersonalResourcesEnabled(enabled: boolean): void {
    this.set("personal-resources", enabled);
  }

  /**
   * Where long conversations summarize (Settings → Intelligence; INF-6693),
   * Automatic until the person picks another point. A value this build does
   * not offer reads as Automatic.
   */
  getSummaryPoint(): SummaryPoint {
    const parsed = summaryPointSchema.safeParse(this.get("summary-point"));
    return parsed.success ? parsed.data : DEFAULT_SUMMARY_POINT;
  }

  setSummaryPoint(point: SummaryPoint): void {
    this.set("summary-point", summaryPointSchema.parse(point));
  }

  /**
   * The home's personal set as it last read it: its fingerprint and since
   * when it has had it (docs/personal-resources.md, "One set, kept on each
   * computer"); undefined before the first read.
   */
  getPersonalVersion(): { version: string; since: number } | undefined {
    const parsed = personalSeenSchema.safeParse(this.get("personal-version"));
    return parsed.success ? parsed.data : undefined;
  }

  setPersonalVersion(seen: { version: string; since: number }): void {
    this.set("personal-version", personalSeenSchema.parse(seen));
  }

  /**
   * The app's own cost limit (docs/usage.md, "The cost limit"): the limit a
   * task follows when neither it nor its project sets one, $50 until the
   * captain changes it.
   */
  getTaskCostLimit(): CostLimit {
    const parsed = costLimitSchema.safeParse(this.get("task-cost-limit"));
    return parsed.success ? parsed.data : DEFAULT_COST_LIMIT;
  }

  setTaskCostLimit(limit: CostLimit): void {
    this.set("task-cost-limit", costLimitSchema.parse(limit));
  }

  /**
   * The check of existing tasks under way (docs/task-tags.md, "Checking
   * existing tasks"), kept so a restart resumes it; null once it ends or
   * stops. `at` is when it started, which fixes the tasks it reads.
   */
  getTagCheck(): SavedTagCheck | null {
    const parsed = savedTagCheckSchema.safeParse(this.get("tag-check"));
    return parsed.success ? parsed.data : null;
  }

  setTagCheck(check: SavedTagCheck | null): void {
    if (check) this.set("tag-check", savedTagCheckSchema.parse(check));
    else this.remove("tag-check");
  }

  /**
   * Where automatic tagging's reads of new tasks start: set when it begins
   * asking, so turning it on, or a first start of a build that has it,
   * leaves the tasks filed before to a check; then moved up to the newest
   * task each time nothing is owed. Absent until it first begins.
   */
  getTagAutoSince(): number | null {
    const parsed = z.number().finite().safeParse(this.get("tag-auto-since"));
    return parsed.success ? parsed.data : null;
  }

  setTagAutoSince(at: number): void {
    this.set("tag-auto-since", at);
  }

  /** Notifications when the window is not front (P2): default on. */
  getNotificationsEnabled(): boolean {
    return this.get("notifications") !== false;
  }

  setNotificationsEnabled(enabled: boolean): void {
    this.set("notifications", enabled);
  }

  /**
   * The folder the person chose for new projects (Settings -> Projects);
   * null = the app's own fleet root. `RepoRegistry` validates every write.
   */
  getProjectsFolder(): string | null {
    const parsed = projectsFolderSchema.safeParse(this.get("projects-folder"));
    return parsed.success ? parsed.data.path : null;
  }

  setProjectsFolder(path: string | null): void {
    this.set("projects-folder", path === null ? null : { path });
  }

  /**
   * The connection file this computer reads custom connections from
   * (Settings → Intelligence); null = none. `CustomApiFileSource` checks each write.
   */
  getCustomApiFile(): string | null {
    const parsed = projectsFolderSchema.safeParse(this.get("custom-api-file"));
    return parsed.success ? parsed.data.path : null;
  }

  setCustomApiFile(path: string | null): void {
    this.set("custom-api-file", path === null ? null : { path });
  }

  /** Presence default (D-17): dock on. Start-at-login lives with the OS. */
  getShowInDock(): boolean {
    const parsed = dockSchema.safeParse(this.get("dock"));
    return parsed.success ? parsed.data.showInDock : true;
  }

  setShowInDock(showInDock: boolean): void {
    this.set("dock", { showInDock });
  }

  getFlag(key: string): boolean {
    return this.get(`flag:${key}`) === true;
  }

  setFlag(key: string, value: boolean): void {
    this.set(`flag:${key}`, value);
  }

  /**
   * The fixed model the Firstmate agent runs on (captain decision Q2).
   * Null means not chosen yet; the agent derives a subscription-based
   * default once and persists it here so behavior never silently changes.
   */
  getFirstmateModel(): PiModelRefView | null {
    return this.projected("firstmate-model", () => {
      const parsed = piModelRefViewSchema.safeParse(this.get("firstmate-model"));
      return parsed.success ? parsed.data : null;
    });
  }

  setFirstmateModel(model: PiModelRefView | null): void {
    this.set("firstmate-model", model);
  }

  /** Persist the model and its provider-compatible account as one attachment choice. */
  setFirstmateBinding(model: PiModelRefView | null, accountId: string | null): void {
    this.db.transaction(() => {
      this.setFirstmateModel(model);
      this.setFirstmateAccount(accountId);
    })();
  }

  /**
   * The flagship account the Firstmate agent is bound to (broker phase 6):
   * a broker-derived default chosen once and persisted, exactly parallel to
   * the fixed Firstmate model - user-visible, never silently changed except
   * by the sibling-rebind ladder, which announces itself.
   */
  getFirstmateAccount(): string | null {
    const value = this.get("firstmate-account");
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  setFirstmateAccount(accountId: string | null): void {
    this.set("firstmate-account", accountId);
  }

  /** The Firstmate agent's rolling session file (captain decision Q4). */
  getFirstmateSessionFile(): string | null {
    const value = this.get("firstmate-session-file");
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  setFirstmateSessionFile(path: string | null): void {
    this.set("firstmate-session-file", path);
  }

  /**
   * The Firstmate's rolling session on the Claude seat, by the client's
   * session id: the Claude backend's resume pointer beside the Pi file's.
   */
  getFirstmateClaudeSession(): string | null {
    const value = this.get("firstmate-claude-session");
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  setFirstmateClaudeSession(sessionId: string | null): void {
    this.set("firstmate-claude-session", sessionId);
  }

  /**
   * Where the Firstmate's seat was when the captain moved it off a paused
   * account (W1 S9): the provider and account it left and why, and whether
   * the "move back" card has been offered since that account served again.
   * Null once the seat is back, or the captain chose another model.
   */
  getFirstmateMovedFrom(): FirstmateMovedFrom | null {
    const parsed = firstmateMovedFromSchema.safeParse(this.get("firstmate-moved-from"));
    return parsed.success ? parsed.data : null;
  }

  setFirstmateMovedFrom(movedFrom: FirstmateMovedFrom | null): void {
    this.set("firstmate-moved-from", movedFrom);
  }

  /**
   * The pause the Firstmate's seat is in (W1 S9): the account, its class,
   * and where its card offered to move. Durable, so a restart neither
   * repeats the pause's feed line and ledger row nor leaves its card up
   * once the account serves again. Null while the seat serves.
   */
  getFirstmatePaused(): FirstmatePaused | null {
    const parsed = firstmatePausedSchema.safeParse(this.get("firstmate-paused"));
    return parsed.success ? parsed.data : null;
  }

  setFirstmatePaused(paused: FirstmatePaused | null): void {
    this.set("firstmate-paused", paused);
  }

  /**
   * The bounded record of the Firstmate's recent turns a seat move carries
   * across (`seatDigest.ts`), oldest first. An unreadable record is empty.
   */
  getFirstmateSeatDigest(): SeatDigestEntry[] {
    const parsed = z.array(seatDigestEntrySchema).safeParse(this.get("firstmate-seat-digest"));
    return parsed.success ? parsed.data : [];
  }

  setFirstmateSeatDigest(entries: readonly SeatDigestEntry[]): void {
    this.set("firstmate-seat-digest", entries);
  }

  /** The supervision session's rolling session file (design B). */
  getSupervisionSessionFile(): string | null {
    const value = this.get("supervision-session-file");
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  setSupervisionSessionFile(path: string | null): void {
    this.set("supervision-session-file", path);
  }
}
