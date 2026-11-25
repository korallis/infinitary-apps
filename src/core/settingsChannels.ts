import type { SummaryPoint, SummaryPointView } from "@shared/summaryPoint";
import type { CoreServices } from "./coreServices";
import { priceSteps } from "./models/priceSteps";
import { modelLookup } from "./pi/modelRuntime";

/**
 * Settings' channels that only hand their arguments to one service and emit
 * nothing: the runbook switches (docs/runbooks.md), the personal-resource
 * switch, which sends the home's set to its computers when it turns on, and
 * the app's cost limit (docs/usage.md, "The cost limit") and where long
 * conversations summarize (INF-6693). The dispatcher
 * spreads them into its table, so it stays under the size check's ceiling.
 */
export function plainSettingsChannels(
  services: Pick<
    CoreServices,
    "runbooks" | "costLimit" | "settings" | "auth" | "availableModels" | "slots"
  > &
    Partial<Pick<CoreServices, "placed">>,
) {
  return {
    "inf:settings:runbooks:get": () => services.runbooks.list(),
    "inf:settings:runbooks:copy": (id: string, copyId: string, name: string) =>
      services.runbooks.copy(id, copyId, name),
    "inf:settings:runbooks:set": (id: string, enabled: boolean) =>
      services.runbooks.set(id, enabled),
    "inf:settings:personal-resources:get": () => services.settings.getPersonalResourcesEnabled(),
    "inf:settings:personal-resources:set": (enabled: boolean) => {
      services.settings.setPersonalResourcesEnabled(enabled);
      // Turned on, the home's set goes to each computer in reach at once.
      if (enabled) void services.placed?.bringPersonal?.();
      return services.settings.getPersonalResourcesEnabled();
    },
    "inf:settings:cost-limit:get": () => services.costLimit.view(),
    "inf:settings:cost-limit:set": (limit: Parameters<CoreServices["costLimit"]["set"]>[0]) =>
      services.costLimit.set(limit),
    "inf:settings:summary-point:get": () => summaryPointView(services),
    "inf:settings:summary-point:set": (point: SummaryPoint) => {
      services.settings.setSummaryPoint(point);
      return summaryPointView(services);
    },
  };
}

/**
 * The summary point row's view: the saved choice, and the price step of each
 * model on the person's accounts, read from the catalog's prices.
 */
function summaryPointView(
  services: Pick<CoreServices, "settings" | "auth" | "availableModels" | "slots">,
): SummaryPointView {
  return {
    point: services.settings.getSummaryPoint(),
    steps: priceSteps(
      services.availableModels(),
      modelLookup(services.auth.modelRuntime),
      (model) => services.slots.nameOf(model),
    ),
  };
}
