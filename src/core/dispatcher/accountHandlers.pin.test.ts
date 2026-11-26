import { describe, expect, it } from "vitest";
import type { CoreServices } from "../coreServices";
import { accountHandlers } from "./accountHandlers";

// The approved plan for several logins of one provider, piece 3, "Ask": the
// card asks about the login in use. The captain choosing another login in
// the accounts list changes which one that is, so what is asked is read
// again then, not at the next allowance reading.

describe("choosing the login crew work prefers", () => {
  it("saves the choice, then has the low-login offers read again", async () => {
    const steps: string[] = [];
    const handlers = accountHandlers(
      {
        vault: {
          setPin: (providerId: string, accountId: string | null) => {
            steps.push(`pin ${providerId} ${accountId}`);
          },
        },
        whenLoginLowChanged: () => {
          steps.push("offers read again");
        },
      } as unknown as CoreServices,
      () => {},
    );
    await handlers["inf:accounts:pin"]("openai-codex", "work", undefined);
    expect(steps).toEqual(["pin openai-codex work", "offers read again"]);
  });
});
