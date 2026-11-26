import { backendForProvider, CLAUDE_PROVIDER_ID } from "@shared/providers";
import { servedProviderOf } from "@shared/quota";
import { claudeReasoningCapabilities } from "../claude/reasoning";
import type { DeviceSignIns } from "../devices/deviceSignIns";
import type { ServedModels } from "../models/servedModels";
import { createServedStarters } from "../models/servedStarters";
import type { Ticker } from "../orchestrator/ticker";
import type { AccountVault } from "../pi/accountVault";
import { createModelCapabilityLookup } from "../pi/modelCapability";
import type { PiAuthService } from "../pi/piAuth";
import { piReasoningCapabilities } from "../pi/reasoning";
import type { QuotaService } from "../quota/quotaService";
import type { StandIns } from "../standIns";
import type { DecisionStore } from "../storage/decisionStore";
import type { SettingsStore } from "../storage/settingsStore";
import { AccountSelector } from "./accountRouter";
import { computerBoardModels } from "./computerPool";
import { ModelSlots } from "./modelSlots";
import type { PlacedWorkScores } from "./placedWork";
import { Router } from "./router";

/**
 * The home's routing (docs/model-lists.md): the pool every signed-in
 * account serves, each model's capability, the slot record and the served
 * starter list, the pools a decision model draws from, and the account
 * selector and router every automatic selection goes through.
 */
export type HomeRouting = {
  /** The routing pool: account-served models plus base-runtime custom providers. */
  availableModels: () => { provider: string; id: string }[];
  capabilityFor: ReturnType<typeof createModelCapabilityLookup>;
  slots: ModelSlots;
  /** The routing boundary: the sign-in gate, then the slot record. */
  routableModels: () => ReturnType<ModelSlots["routable"]>["models"];
  /** The decision-model pool (W1 S10). */
  decisionServedModels: () => ReturnType<ModelSlots["routable"]>["models"];
  /** What a named decision offering may bind. */
  decisionNamedModels: () => { provider: string; id: string }[];
  accounts: AccountSelector;
  router: Router;
  /** Each computer's sign-ins reach the slot record once they exist. */
  attachComputerSignIns: (view: () => ReturnType<DeviceSignIns["view"]>) => void;
  /** Hears each login a pick took as a provider's login in use (docs/quota.md). */
  attachLoginInUse: (said: (providerId: string, accountId: string) => void) => void;
};

export function startHomeRouting(options: {
  standIns: Pick<StandIns, "startersUrl">;
  settings: SettingsStore;
  vault: AccountVault;
  served: ServedModels;
  auth: PiAuthService;
  quota: QuotaService;
  placedWork: PlacedWorkScores;
  /** The one decision ledger (P6). */
  ledger: DecisionStore;
  ticker: Ticker;
  /** A committed crew decision dropped a level or waits on these providers' spent allowance. */
  onSpentAt?: (piProviders: string[], deviceId?: string) => void;
  /** A committed crew decision chose an account that keeps going on credits (`RoutePreview.creditsAt`). */
  onCreditsAt?: (piProviders: string[], deviceId?: string) => void;
}): HomeRouting {
  const { standIns, settings, vault, served, auth, quota, placedWork, ledger, ticker } = options;
  // The routing pool: account-served models plus base-runtime custom
  // providers (models.json). Provider credentials live only in the vault.
  const availableModels = () => {
    const seen = new Set<string>();
    const models: { provider: string; id: string }[] = [];
    for (const model of [...vault.availableModels(), ...auth.customProviderModels()]) {
      const key = `${model.provider}/${model.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      models.push(model);
    }
    return models;
  };
  // Capability at routing time (redesign stage 1): a candidate's def is
  // resolved from the same runtimes the session will use, so a model that
  // cannot carry the turn is skipped BEFORE it is chosen rather than 400ing
  // mid-turn. withHonestReasoning has already corrected these defs.
  const capabilityFor = createModelCapabilityLookup(() => [
    ...vault.piModelRuntimes(),
    auth.modelRuntime,
  ]);
  // The slot record: which of the user's models Firstmate may spend on its
  // own, and as what. Seeded from the starter map per offering; live-catalog
  // newcomers arrive off unless the map names them.
  // Filled once device sign-ins exist. The board reads it when it draws, not now.
  const computerSignIns: { view?: () => ReturnType<DeviceSignIns["view"]> } = {};
  const slots = new ModelSlots({
    settings,
    speeds: () => {
      // Each computer's word is read, and narrowed, once for the whole board.
      const now = Date.now();
      const servedThere = (computerSignIns.view?.() ?? [])
        .filter(
          (device) =>
            device.reach === "in-reach" &&
            device.asOf !== undefined &&
            now - device.asOf < 24 * 60 * 60 * 1000,
        )
        .flatMap(
          (device) =>
            device.signIns?.served?.flatMap((row) =>
              device.signIns?.accounts.some(
                (account) => account.id === row.accountId && account.enabled && account.connected,
              )
                ? row.models
                : [],
            ) ?? [],
        );
      return (accountId, ref) => {
        const here = served.speeds(accountId, ref.id);
        const there = servedThere
          .filter(
            (model) =>
              model.provider === ref.provider &&
              model.id === ref.id &&
              model.speedsUntil !== undefined &&
              model.speedsUntil > now,
          )
          .flatMap((model) => model.speeds ?? []);
        return here || there.length ? [...new Set([...(here ?? []), ...there])] : undefined;
      };
    },
    reasoningCapabilities: (ref) => {
      if (ref.provider === CLAUDE_PROVIDER_ID) return claudeReasoningCapabilities(ref.id);
      for (const runtime of [...vault.piModelRuntimes(), auth.modelRuntime]) {
        const capabilities = piReasoningCapabilities(runtime.getModel(ref.provider, ref.id));
        if (capabilities) return capabilities;
      }
      return undefined;
    },
    accounts: () => {
      const home = vault.availableModelsByAccount().map((row) => ({
        accountId: row.accountId,
        accountLabel: row.accountLabel,
        providerId: row.providerId,
        models: row.models,
      }));
      const catalogProviders = new Set(
        (quota.latestModels()?.models ?? []).map((model) => servedProviderOf(model.provider)),
      );
      return [...home, ...computerBoardModels(computerSignIns.view?.() ?? [], catalogProviders)];
    },
    quotaModels: () => quota.latestModels(),
    // Pins and the Firstmate model keep a model listed like a slot does.
    kept: () => {
      const refs = settings.getRoutingSettings().pins.map((pin) => ({
        provider: servedProviderOf(pin.provider),
        id: pin.id,
      }));
      const firstmateModel = settings.getFirstmateModel();
      return firstmateModel ? [...refs, firstmateModel] : refs;
    },
    // A client-served account announces arrivals only from a successful
    // read; a Pi account's catalog is always Pi's own answer.
    canAnnounce: (accountId) => {
      const account = vault.get(accountId);
      if (!account || backendForProvider(account.providerId) === "pi") return true;
      return served.read(accountId) !== undefined;
    },
    now: ticker.now,
  });
  // The served starter list moves the starting levels with no release
  // (docs/model-lists.md, "The served starter list"): asked at start, then
  // once a day. A development or end-to-end run may name its own file; a
  // packaged app never reads that setting.
  const servedStarters = createServedStarters({
    settings,
    ...(standIns.startersUrl ? { url: standIns.startersUrl } : {}),
    now: ticker.now,
  });
  void servedStarters.refresh();
  ticker.register("served-starters", 60 * 60 * 1000, () => servedStarters.refresh());
  /**
   * The routing boundary: the sign-in gate, then the slot record, with the
   * starter-map fallback behind it. Every automatic selection reads THIS;
   * `availableModels` stays the raw pool for pins, names, and the quota
   * gate, and a picker reads its listed part (`slots.listedOf`).
   */
  const routableModels = () => slots.routable(availableModels()).models;
  /**
   * The decision-model pool (W1 S10): every routable model a classifier
   * session can be created on - Pi-served in process, Claude-served on the
   * machine's own client - in one low-first walk (the owner's Q3 a). An
   * account a cut-off withholds, or one with no client, has no models in
   * the routable pool, so it is out of this one too.
   */
  const decisionServedModels = () =>
    routableModels().filter((model) => model.provider !== "anthropic");
  /**
   * What a named decision offering may bind: the whole signed-in pool pins
   * read, slot or no slot - a model that is not in use is still available,
   * and naming it is its own placement - which is the pool the picker lists.
   */
  const decisionNamedModels = () =>
    availableModels().filter((model) => model.provider !== "anthropic");
  // Filled once the low-login watch exists; a pick before then pins without a feed line.
  const loginInUse: { said?: (providerId: string, accountId: string) => void } = {};
  const accounts = new AccountSelector({
    pool: vault,
    placedWork,
    quota,
    flagshipAccountId: () => settings.getFirstmateAccount(),
    decisions: ledger,
    accountModels: () => vault.availableModelsByAccount(),
    loginInUse: {
      whenLow: () => settings.getWhenLoginLow(),
      pin: (providerId, accountId) => {
        vault.setPin(providerId, accountId);
        loginInUse.said?.(providerId, accountId);
      },
    },
  });
  const router = new Router({
    quota,
    placedWork,
    settings,
    decisions: ledger,
    availableModels,
    poolRead: () => vault.poolRead(),
    slots,
    capabilityFor,
    withheldModels: () => vault.withheldModels(),
    crewAccount: (provider, model, placed) => accounts.crewAccount(provider, model, placed),
    ...(options.onSpentAt ? { onSpentAt: options.onSpentAt } : {}),
    ...(options.onCreditsAt ? { onCreditsAt: options.onCreditsAt } : {}),
  });
  return {
    availableModels,
    capabilityFor,
    slots,
    routableModels,
    decisionServedModels,
    decisionNamedModels,
    accounts,
    router,
    attachComputerSignIns: (view) => {
      computerSignIns.view = view;
    },
    attachLoginInUse: (said) => {
      loginInUse.said = said;
    },
  };
}
