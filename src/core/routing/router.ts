import { type Slot, slotSchema } from "@shared/modelSlots";
import {
  type CatalogModelView,
  type IntelligenceBucket,
  SLOTS,
  servedModelKey,
  servedProviderOf,
} from "@shared/quota";
import { CREW_NEAR_FLOOR_PERCENT } from "@shared/quotaSignals";
import type { RuleId, WorkShape } from "@shared/routingPolicy";
import type { QuotaService } from "../quota/quotaService";
import type { DecisionStore, RoutingCandidateFact, SelectionFacts } from "../storage/decisionStore";
import type { SettingsStore } from "../storage/settingsStore";
import {
  estimateTokens,
  type ModelCapabilityLookup,
  PROMPT_CONTEXT_HEADROOM_TOKENS,
} from "./capability";
import type { ModelSlots } from "./modelSlots";
import type { PlacedWorkData, PlacedWorkScores, RankedModel } from "./placedWork";
import { tierFor } from "./policy";
import {
  allowanceless,
  fallbackRank,
  isDowngrade,
  type PiModelRef,
  preferenceMiss,
  type RoutingInput,
  route,
} from "./routingEngine";

/** What the supervisor consumes: the choice plus the fallback signals (P7). */
export type RouteResult = {
  choice?: PiModelRef;
  bucket: IntelligenceBucket;
  /** Set when the choice came from another slot than requested. */
  servedBucket?: IntelligenceBucket;
  /** Set when the catalog had models but none could serve at all. */
  unserveable?: true;
  /** Set beside either signal when no available model sits in the requested slot. */
  emptyBucket?: true;
  /**
   * Set beside a downgrade when the slot asked for would have served from a
   * model whose account is withheld (a standing sign-out or refusal, no
   * client to run it): that model's provider and the account's reason, so
   * the feed says what kept it out instead of blaming an allowance.
   */
  withheld?: { provider: string; reason: string };
  /**
   * Set beside a downgrade, or a level nothing could serve, when the turn
   * carries pictures and every model placed at the level asked for reads
   * text only, whatever its allowance (`RoutingDecision.picturesUnread`), and
   * no withheld account explains it: the feed and the hold say that instead
   * of blaming an allowance.
   */
  picturesUnread?: true;
  /** The policy row that asked for this tier (S2), for the record. */
  rule: RuleId;
  /** Why a review's preferred model did not take the turn (`RoutingDecision.preferPassed`). */
  preferPassed?: string;
};

/** A model a withheld account would serve, with why it is withheld (`AccountVault.withheldModels`). */
export type WithheldModel = PiModelRef & { reason: string };

/**
 * Models to route among other than this Mac's own: a task that runs on a
 * computer that runs work is routed among what that computer's own sign-ins
 * serve (`computerPool`), with the allowance as read there.
 */
export type RoutingPool = {
  available: PiModelRef[];
  /** The quota catalog of those models, with the allowance as read where they run. */
  catalog: CatalogModelView[];
  /** Whose sign-ins these are, for the record. */
  note: string;
  /** The computer these sign-ins are on, by name, for the record. */
  place?: string;
  /** The computer these sign-ins are on, by id: its run-out card names it. */
  deviceId?: string;
  readings?: import("@shared/quota").QuotaProviderView[];
  /** The computer's existing account-binding policy, before session attachment. */
  modelAccounts?: ReadonlyMap<string, string>;
  accounts?: ReadonlyMap<string, string>;
  /** Models the quota catalog does not list, admitted only by slot membership. */
  unowned?: PiModelRef[];
};

/** A read-only evaluation: smaller rank preserves the stronger requested preference. */
export type RoutePreview = {
  accountId?: string;
  result: RouteResult;
  reasons: string[];
  preferenceRank: number;
  /**
   * The model the captain named for the task (rule R0), as named, and
   * whether this routing serves it: Automatic places such a task only where
   * it is served, or waits and asks (`evaluatePlacement`).
   */
  named?: { model: string; served: boolean };
  requiresReasoningWait: boolean;
  /** Every candidate weighed, with its score and reading; saved with the decision. */
  candidates?: RoutingCandidateFact[];
  /** How the choice was made, saved with the decision (INF-1714). */
  selection?: SelectionFacts;
  /**
   * Providers whose spent allowance at the asked level made this work drop
   * a level or wait: their run-out card may offer Keep going on credits
   * once the decision is committed.
   */
  spentAt?: string[];
  /**
   * Providers whose allowance is spent at the asked level and whose chosen
   * account keeps going on credits: a saved reset is weighed as that work
   * starts on credits, which serve it until the reset lands (docs/quota.md,
   * "Saved resets on their own").
   */
  creditsAt?: string[];
  /** The computer that runs work whose sign-ins `spentAt` names; absent, this Mac's own. */
  spentOn?: string;
};

export type RouteOptions = {
  /**
   * Reviewer placement (delivery rigor phase 3, Q5): the Pi provider
   * that served the builder, which the ladder prefers away from at the
   * same tier. Recorded as rule R9; the tier still comes from the
   * shape's own row.
   */
  avoidProvider?: string;
  /**
   * A provider left out entirely, with no fallback to it: a started task
   * moved off the provider that failed it (INF-849) routes only among the
   * others, and finds nothing when none can serve.
   */
  withoutProvider?: string;
  /**
   * The only models routed among, with no fallback to others: a task routed
   * again off a model that left every level stays on its custom connection,
   * or on the backend its open conversation there speaks.
   */
  only?: (model: { provider: string; id: string }) => boolean;
  /**
   * The models to route among instead of this Mac's own: a task that
   * runs on a computer that runs work takes only what that computer's
   * own sign-ins serve (docs/helper.md, "Its own sign-ins").
   */
  pool?: RoutingPool;
  /**
   * The turn routed for carries the captain's pictures (`briefCarriesPictures`
   * in `orchestrator/crewBrief.ts`): a model whose def takes text only is
   * skipped with its reason (`capability.ts`), never chosen to refuse them
   * at its first prompt.
   */
  images?: boolean;
};

export type PreparedRouteOptions = RouteOptions & { placed: PlacedWorkData };

/**
 * Binds the pure routing engine to live inputs (quota catalog, Pi
 * availability, persisted pins, user slots) and records every decision
 * with its reasons - the "why this model" surface.
 */
export class Router {
  private placement: Promise<unknown> = Promise.resolve();

  /** Preparation through commitment is one ordered operation across all placement callers. */
  inOrder<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.placement.then(operation);
    this.placement = next.catch(() => undefined);
    return next;
  }
  constructor(
    private readonly options: {
      quota: QuotaService;
      placedWork?: PlacedWorkScores;
      settings: SettingsStore;
      decisions: DecisionStore;
      availableModels: () => PiModelRef[];
      /** Whether this Mac's pool is read, so an empty one is known empty. */
      poolRead?: () => boolean;
      /** The slot record; omitted means every available model routes at medium. */
      slots?: ModelSlots;
      /** Resolves a candidate's def so it is checked before it is chosen. */
      capabilityFor?: ModelCapabilityLookup;
      /**
       * Models a withheld account would serve. They never route; a
       * downgrade reads them to tell a withheld account from a spent
       * allowance.
       */
      withheldModels?: () => WithheldModel[];
      /**
       * The account of this Mac a crewmate on that model would bind now
       * (`AccountSelector.crewAccount`): the model is ranked by its reading.
       */
      crewAccount?: (
        piProviderId: string,
        model: string,
        placed: PlacedWorkData,
      ) => string | undefined;
      /**
       * A committed decision dropped a level or waits because these
       * providers' allowance is spent at the asked level: the crew's
       * run-out card (docs/quota.md "Keep going on credits").
       */
      onSpentAt?: (piProviders: string[], deviceId?: string) => void;
      /**
       * A committed decision chose an account that keeps going on credits
       * past its spent allowance (`RoutePreview.creditsAt`).
       */
      onCreditsAt?: (piProviders: string[], deviceId?: string) => void;
    },
  ) {}

  /** Read and score history apart from the window before the synchronous policy runs. */
  async prepare(options: RouteOptions = {}): Promise<PreparedRouteOptions> {
    const rows = options.pool
      ? (options.pool.readings ?? [])
      : (this.options.quota.latest()?.providers ?? []);
    const placed = await this.options.placedWork?.prepare(rows);
    return { ...options, placed: placed ?? { work: [], samples: [], charges: {}, readings: rows } };
  }

  reasoningChoice(ref: PiModelRef, slot: Slot) {
    return this.options.slots?.reasoningChoice(ref, slot);
  }

  /**
   * The tier comes from the work-shape policy (S2, `./policy.ts`), never
   * from a judgment: `shape` is what the host established about the work
   * and `tierFor` maps it to a slot through the captain's table. `prompt`
   * is only what the turn will send, for the context-window check, and
   * `options.images` whether the captain's pictures ride with it.
   *
   * R0 is the one rule that names a model instead of a slot: the captain's
   * `override_model_id` becomes a one-off pin for this call only - matched
   * against what Pi can actually serve, tried before the persisted settings
   * pins and never written back to them - and the slot that model sits in
   * is recorded as the tier. It accepts either a bare model id or Pi's
   * provider-qualified `provider/model` key, which disambiguates models
   * offered by more than one provider.
   */
  decide(
    taskId: string,
    prompt: string,
    shape: WorkShape,
    options: PreparedRouteOptions,
  ): RouteResult {
    return this.commit(taskId, this.preview(prompt, shape, options));
  }

  /** Record the preview chosen by atomic placement, never another speculative candidate. */
  commit(taskId: string, evaluation: RoutePreview): RouteResult {
    const {
      result,
      reasons,
      candidates,
      accountId,
      selection,
      spentAt,
      creditsAt,
      spentOn,
      named,
    } = evaluation;
    if (spentAt && spentAt.length > 0) this.options.onSpentAt?.(spentAt, spentOn);
    if (creditsAt && creditsAt.length > 0) this.options.onCreditsAt?.(creditsAt, spentOn);
    this.options.decisions.recordRouting({
      taskId,
      provider: result.choice?.provider ?? null,
      model: result.choice?.id ?? null,
      bucket: result.bucket,
      rule: result.rule,
      served: result.choice ? (result.servedBucket ?? result.bucket) : null,
      reasons,
      ...((candidates && candidates.length > 0) || accountId || selection || named
        ? {
            facts: {
              kind: "routing-candidates" as const,
              candidates: candidates ?? [],
              ...(accountId ? { accountId } : {}),
              ...(selection ? { selection } : {}),
              ...(named ? { named: named.served } : {}),
            },
          }
        : {}),
    });
    return result;
  }

  /**
   * Evaluate this computer's pool without recording a speculative routing row.
   * The ordinary decide path uses this same evaluation and remains the writer.
   * Call again at commitment: this preview is evidence, not a model reservation.
   */
  preview(prompt: string, shape: WorkShape, options: PreparedRouteOptions): RoutePreview {
    return this.evaluate(prompt, shape, options);
  }

  /**
   * The reviewer question's models (INF-5021; docs/delivery-rigor.md,
   * "Which model reviews"): the usual pick, evaluated as `preview` does and
   * recorded nowhere, and each model a person placed at a level, premium
   * included, that the pool serves, with why it cannot take this review
   * now by the ladder's own per-model checks (`preferenceMiss`).
   */
  reviewerModels(
    prompt: string,
    shape: WorkShape,
    options: PreparedRouteOptions,
  ): { usual: RoutePreview; models: { ref: PiModelRef; slots: Slot[]; miss?: string }[] } {
    const { input } = this.inputFor(prompt, shape, options);
    const models = new Map<string, { ref: PiModelRef; slots: Slot[]; miss?: string }>();
    for (const placed of input.slotted ?? []) {
      const key = `${placed.provider}/${placed.id}`;
      const ref = { provider: placed.provider, id: placed.id };
      const known = models.get(key);
      if (known) {
        if (!known.slots.includes(placed.slot)) known.slots.push(placed.slot);
        continue;
      }
      const miss = preferenceMiss(input, ref);
      models.set(key, { ref, slots: [placed.slot], ...(miss ? { miss } : {}) });
    }
    return { usual: this.evaluate(prompt, shape, options), models: [...models.values()] };
  }

  /** The engine's input for one evaluation, and the facts the record reads beside it. */
  private inputFor(prompt: string, shape: WorkShape, options: PreparedRouteOptions) {
    const { pins } = this.options.settings.getRoutingSettings();
    // What the router may pick: the catalog only describes, so leaving a
    // provider out of what serves leaves it out of the pick.
    const without = options.withoutProvider;
    const only = options.only;
    const kept = <T extends { provider: string; id: string }>(models: T[]): T[] =>
      models.filter((model) => (!without || model.provider !== without) && (!only || only(model)));
    const rawCatalog = options.pool
      ? options.pool.catalog
      : (this.options.quota.latestModels()?.models ?? []);
    // Each model is ranked by the account that would serve it: a computer's
    // own binding there, or this Mac's crew account pick.
    const pool = options.pool;
    const crewAccount = this.options.crewAccount;
    const bound = pool
      ? (model: CatalogModelView) =>
          pool.modelAccounts?.get(servedModelKey(model)) ??
          pool.accounts?.get(servedProviderOf(model.provider))
      : crewAccount
        ? (model: CatalogModelView, placed: PlacedWorkData) =>
            crewAccount(servedProviderOf(model.provider), model.id, placed)
        : undefined;
    const catalog =
      this.options.placedWork?.catalog(
        rawCatalog,
        options.placed?.readings ??
          (pool ? (pool.readings ?? []) : (this.options.quota.latest()?.providers ?? [])),
        Date.now(),
        bound,
        options.placed,
        // The pools are this computer's own logins: another computer ranks by its own readings.
        pool ? undefined : this.options.quota.latest()?.pools,
      ) ?? rawCatalog;
    const pooled = (options.pool?.available ?? this.options.availableModels()).filter(
      (model) => !without || model.provider !== without,
    );
    const available = kept(pooled);
    // The levels are read from the whole pool, so a model `only` passes over
    // never lets the starter map stand in; `only` then narrows what they hold.
    const levels = this.options.slots?.routable(pooled);
    const routable =
      levels && only ? { ...levels, models: levels.models.filter((model) => only(model)) } : levels;
    const tier = tierFor(shape);
    const modelId = tier.pin;
    const askPin = modelId
      ? available.find((model) =>
          modelId.includes("/")
            ? `${model.provider}/${model.id}` === modelId
            : model.id === modelId,
        )
      : undefined;
    // R0's tier is whichever slot the named model sits in; a model in no
    // slot (off, but still pinnable) leaves the engine's medium default.
    const bucket = tier.bucket ?? (askPin ? this.slotOf(askPin) : undefined);
    // Taking turns (INF-3782) reads, for each model a person placed that has
    // no allowance row, the newest routing row that chose it.
    const unowned = options.pool?.unowned ? kept(options.pool.unowned) : undefined;
    const catalogKeys = new Set(catalog.map((model) => servedModelKey(model)));
    const unownedKeys = new Set((unowned ?? []).map((ref) => `${ref.provider}/${ref.id}`));
    const turnTakers = routable?.placed
      ? routable.models.filter(
          (ref) =>
            !catalogKeys.has(`${ref.provider}/${ref.id}`) &&
            (allowanceless(ref) || unownedKeys.has(`${ref.provider}/${ref.id}`)),
        )
      : [];
    const input: RoutingInput = {
      catalog,
      available,
      ...(routable ? { slotted: routable.models, slotNote: routable.note } : {}),
      ...(unowned ? { unowned } : {}),
      pins: kept(askPin ? [askPin, ...pins] : pins),
      ...(bucket ? { bucket } : {}),
      ...(this.options.capabilityFor ? { capabilityFor: this.options.capabilityFor } : {}),
      ...(options.avoidProvider ? { avoidProvider: options.avoidProvider } : {}),
      ...(turnTakers.length >= 2
        ? { turns: { lastPicked: this.options.decisions.lastChosenIds(turnTakers) } }
        : {}),
      needs: {
        contextTokens: estimateTokens(prompt) + PROMPT_CONTEXT_HEADROOM_TOKENS,
        ...(options.images ? { images: true } : {}),
      },
    };
    // A review's preferred model, never written back as a pin.
    const prefer = shape.review_model
      ? available.find((model) => `${model.provider}/${model.id}` === shape.review_model)
      : undefined;
    if (prefer) input.prefer = prefer;
    return {
      input,
      pins,
      catalog,
      pool,
      tier,
      modelId,
      askPin,
      without,
      preferMissing: Boolean(shape.review_model && !prefer),
    };
  }

  private evaluate(prompt: string, shape: WorkShape, options: PreparedRouteOptions): RoutePreview {
    const { input, pins, catalog, pool, tier, modelId, askPin, without, preferMissing } =
      this.inputFor(prompt, shape, options);
    const decision = route(input);
    if (preferMissing) {
      decision.preferPassed = "no sign-in serves it here";
      decision.reasons.push(
        `passed over the preferred ${shape.review_model}: ${decision.preferPassed}`,
      );
    }
    // This Mac's own withheld accounts; a computer's pool says nothing of its own.
    const withheld =
      !options.pool && decision.servedBucket && isDowngrade(decision.bucket, decision.servedBucket)
        ? this.withheldCause(input)
        : undefined;
    if (withheld) {
      decision.reasons.push(
        `${withheld.provider}/${withheld.id} would serve ${decision.bucket} but its account is withheld (${withheld.reason})`,
      );
    }
    const picturesUnread = !withheld && decision.picturesUnread === true;
    if (picturesUnread) {
      decision.reasons.push(
        `no ${decision.bucket} model reads pictures: each one placed there takes text only`,
      );
    }
    // An unavailable pin leaves routing to the normal ladder and is recorded,
    // so a fallback is diagnosable; Automatic placement reads `named` and
    // never starts such a preview's task (`evaluatePlacement`).
    if (modelId && !askPin) {
      decision.reasons.push(`requested pin ${modelId} is not available; ignoring it`);
    }
    // The shape and the rule lead the record (S2): what the work was taken
    // to be is why this slot was asked for, so a routing decision reads
    // top to bottom without a second table. Reviewer placement (R9) is
    // recorded as the rule and names the tier row it rode on.
    const rule: RuleId = options.avoidProvider ? "R9" : tier.rule;
    decision.reasons.unshift(
      ...shapeReasons(shape),
      options.avoidProvider
        ? `rule R9: reviewer placement away from ${options.avoidProvider}; tier from ${tier.reason}`
        : tier.reason,
      ...(options.pool ? [`routed among ${options.pool.note}`] : []),
      ...(without ? [`left out ${without}, the provider the task moved off`] : []),
    );
    const result: RouteResult = {
      bucket: decision.bucket,
      rule,
      ...(decision.servedBucket ? { servedBucket: decision.servedBucket } : {}),
      ...(decision.unserveable ? { unserveable: true as const } : {}),
      ...(decision.emptyBucket ? { emptyBucket: true as const } : {}),
      ...(withheld ? { withheld: { provider: withheld.provider, reason: withheld.reason } } : {}),
      ...(picturesUnread ? { picturesUnread: true as const } : {}),
      ...(decision.choice ? { choice: decision.choice } : {}),
      ...(decision.preferPassed ? { preferPassed: decision.preferPassed } : {}),
    };
    // A named model first, then saved pins in their order, then the existing
    // slot ladder. Do not infer quality by parsing the reasons or model name.
    const matches = (pin: { provider: string; id: string }) =>
      decision.choice !== undefined && servedModelKey(decision.choice) === servedModelKey(pin);
    const pinned = pins.findIndex(matches);
    const offset = modelId ? 1 : 0;
    const preferenceRank =
      askPin && matches(askPin)
        ? 0
        : pinned >= 0
          ? offset + pinned
          : offset +
            pins.length +
            fallbackRank(decision.bucket, decision.servedBucket ?? decision.bucket);
    return {
      result,
      accountId: decision.choice
        ? (options.pool?.modelAccounts?.get(servedModelKey(decision.choice)) ??
          options.pool?.accounts?.get(decision.choice.provider) ??
          (catalog as RankedModel[]).find(
            (model) => servedModelKey(model) === servedModelKey(decision.choice!),
          )?.charge?.accountId)
        : undefined,
      reasons: decision.reasons,
      preferenceRank,
      ...(modelId ? { named: { model: modelId, served: Boolean(askPin && matches(askPin)) } } : {}),
      requiresReasoningWait: requiresReasoningWait(shape, result),
      ...spentAtLevel(decision, options.pool),
      ...creditsAtLevel(decision, catalog as RankedModel[], options.pool),
      candidates: decision.candidates.map((candidate) => {
        const ranked = (catalog as RankedModel[]).find(
          (model) => servedModelKey(model) === `${candidate.provider}/${candidate.model}`,
        );
        return {
          ...candidate,
          ...(ranked?.rawSpendPriority !== undefined
            ? { rawSpendPriority: ranked.rawSpendPriority }
            : {}),
          ...(ranked?.accountId ? { accountId: ranked.accountId } : {}),
          ...(ranked?.measuredAt !== undefined ? { measuredAt: ranked.measuredAt } : {}),
          ...(ranked?.resetsAtMs !== undefined ? { resetsAtMs: ranked.resetsAtMs } : {}),
          ...(ranked?.charge ? { charge: ranked.charge } : {}),
        };
      }),
      ...(decision.decidedBy
        ? {
            selection: {
              version: 1 as const,
              decidedBy:
                decision.decidedBy === "pin"
                  ? askPin && matches(askPin)
                    ? ("named" as const)
                    : ("pinned" as const)
                  : decision.decidedBy,
              floorPercent: CREW_NEAR_FLOOR_PERCENT,
              computer: pool?.place ?? "home",
              ...(decision.turns ? { turns: true as const } : {}),
            },
          }
        : {}),
    };
  }

  /**
   * The Pi provider a task's newest routing decision chose, for reviewer
   * placement (R9): what its builder was served by, read off
   * the ledger's routing rows rather than guessed from the account.
   * Undefined when the task never routed or nothing was chosen.
   */
  servedProvider(taskId: string): string | undefined {
    return this.options.decisions.latestChosenSlots([taskId])[0]?.provider ?? undefined;
  }

  /**
   * The model and slot a task's newest routing decision chose - its start's
   * or its newest move's - for a reopen to ask for again, so a conversation
   * that starts over never opens on the client's own default. The slot is
   * the one served, as `servedSlots` reads it. Undefined when the task never
   * routed or the row's slot is not one.
   */
  servedChoice(taskId: string): { model: PiModelRef; slot: Slot; named: boolean } | undefined {
    const row = this.options.decisions.latestChosenSlots([taskId])[0];
    const slot = slotSchema.safeParse(row?.served ?? row?.bucket);
    if (!row?.provider || !row.model || !slot.success) return undefined;
    return {
      model: { provider: row.provider, id: row.model },
      slot: slot.data,
      // A model named - at the start or by a move - and served; a row from
      // before that was recorded reads its rule.
      named: row.named ?? row.rule === "R0",
    };
  }

  /**
   * Whether routing would still place `ref` at all (docs/routing.md, "A
   * model that left every level"): a Settings pin names it, a level in
   * Settings → Intelligence → Models holds it, or, while the starter map or
   * the listed models stand in for placements of the person's own
   * (`ModelSlots.routable`), those defaults include it among `available` -
   * this Mac's models, or a computer's own pool. With no slot record every
   * model counts as held; a pool known to be empty - a computer's, or this
   * Mac's once every account said what it serves - holds none but a pin or
   * level. Undefined: this Mac's pool is not read yet - empty, or with the
   * defaults leaving the model out while an account has not said what it
   * serves - so whether the defaults hold it is not known until it is.
   */
  holdsAtALevel(ref: PiModelRef, available?: readonly PiModelRef[]): boolean | undefined {
    const key = servedModelKey(ref);
    if (this.options.settings.getRoutingSettings().pins.some((pin) => servedModelKey(pin) === key))
      return true;
    const slots = this.options.slots;
    if (!slots || slots.slotsOf(ref).length > 0) return true;
    const models = [...(available ?? this.options.availableModels())];
    // Nothing read here yet: not known; a pool known to be empty holds it not.
    if (models.length === 0)
      return available === undefined && this.options.poolRead?.() !== true ? undefined : false;
    const routable = slots.routable(models);
    if (routable.placed === true) return false;
    if (routable.models.some((model) => servedModelKey(model) === key)) return true;
    // Left out while an account here has not said what it serves: not known.
    return available === undefined && this.options.poolRead?.() === false ? undefined : false;
  }

  /**
   * What routing reads here of Settings and the models, for a wait to compare
   * (`TaskMoves.waitsForModel`): the pins and levels, the slot record - a
   * model only another computer serves included - what each level holds
   * here, the models this Mac's accounts serve, and which models' allowance
   * is spent.
   */
  routingState(): string {
    const available = this.options.availableModels();
    return JSON.stringify([
      this.options.settings.getRoutingSettings(),
      this.options.poolRead?.() ?? null,
      this.options.slots?.state() ?? null,
      (this.options.quota.latestModels()?.models ?? []).map(
        (model) => `${model.provider}/${model.id}:${model.effectivePercentRemaining === 0}`,
      ),
      (this.options.slots?.routable(available).models ?? []).map(
        (model) => `${servedModelKey(model)}@${model.slot}`,
      ),
      available.map((model) => servedModelKey(model)),
    ]);
  }

  /**
   * One offering named the way the captain knows it, through the one
   * model-name lookup (`ModelSlots.nameOf`): its Settings row's name
   * ("Fable 5"), the raw id otherwise. The settle card's model fact reads
   * the task record's model through this - the model the session reported
   * serving, kept current when the backend swapped it (FI3-967) - never the
   * newest routing choice, which can disagree with it (review F1).
   */
  modelLabel(ref: PiModelRef): string {
    return this.options.slots?.nameOf(ref) ?? ref.id;
  }

  /**
   * The withheld model that would have served a downgraded task at the slot
   * it asked for: the same ladder over the same catalog, pins and checks,
   * with the withheld accounts' models back in the pool and slotted as the
   * pool's own are. Undefined when that ladder still falls back, or picks a
   * model that was never withheld - then the withheld account is not why.
   */
  private withheldCause(input: RoutingInput): WithheldModel | undefined {
    const pooled = new Set(input.available.map((model) => `${model.provider}/${model.id}`));
    const held = (this.options.withheldModels?.() ?? []).filter(
      (model) => !pooled.has(`${model.provider}/${model.id}`),
    );
    if (held.length === 0) return undefined;
    const available = [...input.available, ...held.map(({ provider, id }) => ({ provider, id }))];
    const routable = this.options.slots?.routable(available);
    const unheld = route({
      ...input,
      available,
      ...(routable ? { slotted: routable.models, slotNote: routable.note } : {}),
    });
    const choice = unheld.choice;
    if (!choice || unheld.servedBucket) return undefined;
    return held.find((model) => model.provider === choice.provider && model.id === choice.id);
  }

  /**
   * The slot a pinned offering sits in. A model placed in several is read
   * at its strongest - pinning a premium-slotted model records premium,
   * not whatever weaker slot it also sits in.
   */
  private slotOf(ref: PiModelRef): IntelligenceBucket | undefined {
    const slots = this.options.slots?.slotsOf(ref) ?? [];
    return SLOTS.find((slot) => slots.includes(slot));
  }
}

/**
 * The providers whose spent allowance at the asked level made a decision on
 * this Mac's own sign-ins, or on one computer that runs work's, drop a level
 * or find nothing.
 */
function spentAtLevel(
  decision: ReturnType<typeof route>,
  pool: RoutingPool | undefined,
): { spentAt?: string[]; spentOn?: string } {
  if (pool && !pool.deviceId) return {};
  const dropped =
    !decision.choice ||
    (decision.servedBucket !== undefined && isDowngrade(decision.bucket, decision.servedBucket));
  if (!dropped) return {};
  const status = `skipped: exhausted at ${decision.bucket}`;
  const providers = [
    ...new Set(
      decision.candidates
        .filter((candidate) => candidate.status === status)
        .map((candidate) => candidate.provider),
    ),
  ];
  if (providers.length === 0) return {};
  return { spentAt: providers, ...(pool?.deviceId ? { spentOn: pool.deviceId } : {}) };
}

/**
 * The provider of a decision's choice when the account it binds keeps going
 * on credits past its spent allowance, on this Mac's own sign-ins or on one
 * computer that runs work's.
 */
function creditsAtLevel(
  decision: ReturnType<typeof route>,
  catalog: readonly RankedModel[],
  pool: RoutingPool | undefined,
): { creditsAt?: string[]; spentOn?: string } {
  if (pool && !pool.deviceId) return {};
  const choice = decision.choice;
  if (!choice) return {};
  const chosen = catalog.find((model) => servedModelKey(model) === servedModelKey(choice));
  if (chosen?.onCredits !== true) return {};
  return { creditsAt: [choice.provider], ...(pool?.deviceId ? { spentOn: pool.deviceId } : {}) };
}

/** Premium asks and escalation keep the supervisor's existing never-downward gate. */
export function requiresReasoningWait(
  shape: WorkShape | null | undefined,
  routed: RouteResult,
): boolean {
  return Boolean(
    (shape?.premium_ask || shape?.escalation) &&
      (routed.unserveable ||
        (routed.servedBucket && isDowngrade(routed.bucket, routed.servedBucket))),
  );
}

/**
 * What the shape said about the work, for the record. The tier's own
 * reason line follows these, so `routing_decisions.reasons` carries the
 * input and the rule that read it - which is what the offline corpus
 * needs to score a classification (C5).
 */
function shapeReasons(shape: WorkShape): string[] {
  const kind = shape.kind_source ? `${shape.kind} (${shape.kind_source})` : shape.kind;
  const lines = [`shape kind=${kind}`];
  // How it was established, when there is anything to say: a native
  // decision model's certainty, or the note that one failed and the
  // adapter answered in its place.
  if (shape.kind_detail) lines.push(shape.kind_detail);
  if (shape.basis) {
    lines.push(`basis ${shape.basis} ${shape.basis_verified ? "verified" : "unverified"}`);
  }
  if (shape.escalation) {
    lines.push(`escalation attempt ${shape.escalation.attempt} from ${shape.escalation.from}`);
  }
  return lines;
}

/**
 * The slot each task's crewmate is served on, for the task board
 * (`TaskView.tier`) and so for the crewmate's solid on the crew orbit: the
 * newest routing decision that chose something, its `served` slot - the
 * weaker one when the ladder fell back (S5) - or, on a row written before
 * `served` existed, the slot it asked for. A task that never routed is
 * simply absent; a value that is not a slot is never guessed into one.
 */
export function servedSlots(
  decisions: DecisionStore,
  taskIds: readonly string[],
): Map<string, Slot> {
  const out = new Map<string, Slot>();
  for (const row of decisions.latestChosenSlots(taskIds)) {
    const slot = slotSchema.safeParse(row.served ?? row.bucket);
    if (slot.success) out.set(row.taskId, slot.data);
    else out.delete(row.taskId);
  }
  return out;
}
