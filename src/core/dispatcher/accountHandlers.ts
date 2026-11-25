import { isCustomApiProvider } from "@shared/customApi";
import { said, saidLine } from "@shared/i18n/said";
import type { CoreInvokeChannel, InvokeRequest, InvokeResponse } from "@shared/ipc";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import type { CoreServices } from "../coreServices";
import type { CoreEventSink } from "../events";

type AccountHandlers = {
  [C in Extract<
    CoreInvokeChannel,
    | "inf:accounts:remove"
    | "inf:accounts:rename"
    | "inf:accounts:set-enabled"
    | "inf:accounts:keep-going"
    | "inf:accounts:pin"
  >]: (...args: InvokeRequest<C>) => Promise<InvokeResponse<C>> | InvokeResponse<C>;
};

/**
 * Where each account or project sign-in change names the computer that runs
 * work it is for (`computer-account-settings`), by its request's index:
 * the dispatcher reads that computer's own accounts or sign-ins for its trail.
 */
export const CHANGES_THERE: Partial<Record<string, number>> = {
  "inf:accounts:keep-going": 2,
  "inf:accounts:use-saved-resets": 2,
  "inf:accounts:rename": 2,
  "inf:accounts:set-enabled": 2,
  "inf:accounts:pin": 2,
  "inf:accounts:remove": 1,
  "inf:forges:sign-out": 1,
};

/**
 * The feed line when the Claude login the first mate runs on is removed:
 * the seat's own move is announced only at its next attachment, which may be
 * after a restart, so the removal says it now.
 */
export function firstmateLoginRemovedLine(label: string, another: boolean) {
  return saidLine(
    said(another ? "feedFirstMateLoginRemoved" : "feedFirstMateLoginRemovedNoOther", { label }),
  );
}

/**
 * An account's own settings and its disconnect, on this Mac or, given a
 * computer that runs work, on that computer's own account (docs/helper.md,
 * "Its own sign-ins"). The core dispatcher validates requests and
 * authority before these calls.
 */
export function accountHandlers(services: CoreServices, emit: CoreEventSink): AccountHandlers {
  return {
    "inf:accounts:remove": async (accountId, deviceId) => {
      // A computer that runs work's own account is signed out there.
      if (deviceId) return services.deviceSignIns.signOut(deviceId, accountId);
      const removed = services.vault.get(accountId);
      const custom = isCustomApiProvider(removed?.providerId ?? "");
      const seated =
        removed?.providerId === CLAUDE_PROVIDER_ID &&
        (services.firstmate.boundAccount() === accountId ||
          services.settings.getFirstmateAccount() === accountId);
      if (custom) {
        services.vault.customClose(accountId);
        await services.firstmate.disconnectAccount(accountId);
        await services.supervisor.sessions.disconnectAccount(accountId);
      }
      await services.vault.remove(accountId);
      services.servedModels.forget(accountId);
      if (custom && removed) {
        services.slots.forgetProvider(removed.providerId);
        const routing = services.settings.getRoutingSettings();
        services.settings.setRoutingSettings({
          ...routing,
          pins: routing.pins.filter((pin) => pin.provider !== removed.providerId),
        });
      }
      emit("inf:models:changed", { ok: true });
      // A removed flagship un-pins; the agent re-derives at the next idle
      // boundary and announces the move.
      if (!custom && services.settings.getFirstmateAccount() === accountId) {
        services.settings.setFirstmateAccount(null);
      }
      services.firstRun.reconcile();
      if (seated && removed)
        services.broadcastEvent({
          type: "firstmate_note",
          ...firstmateLoginRemovedLine(
            removed.label,
            services.vault.list().some((account) => account.enabled),
          ),
        });
      return { ok: true as const };
    },

    "inf:accounts:rename": async (accountId, label, deviceId) => {
      if (deviceId)
        return services.deviceSignIns.setAccount(deviceId, { kind: "rename", accountId, label });
      services.vault.rename(accountId, label);
      emit("inf:models:changed", { ok: true });
      return { ok: true as const };
    },

    "inf:accounts:set-enabled": async (accountId, enabled, deviceId) => {
      if (deviceId)
        return services.deviceSignIns.setAccount(deviceId, {
          kind: "set-enabled",
          accountId,
          enabled,
        });
      services.vault.setEnabled(accountId, enabled);
      if (enabled && isCustomApiProvider(services.vault.get(accountId)?.providerId ?? ""))
        await services.vault.runtimeFor(accountId);
      if (enabled) void services.servedModels.refresh(accountId);
      services.firstRun.reconcile();
      emit("inf:models:changed", { ok: true });
      return { ok: true as const };
    },

    "inf:accounts:keep-going": async (accountId, on, deviceId) => {
      await services.setKeepGoingOnCredits(accountId, on, deviceId);
      return { ok: true as const };
    },

    "inf:accounts:pin": async (providerId, accountId, deviceId) => {
      if (deviceId)
        return services.deviceSignIns.setAccount(deviceId, { kind: "pin", providerId, accountId });
      services.vault.setPin(providerId, accountId);
      return { ok: true as const };
    },
  };
}
