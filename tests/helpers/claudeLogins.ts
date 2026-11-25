import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunClaude } from "../../src/core/claude/claudeCli";

/**
 * Stand-ins the further Claude login tests share: the computer's default
 * login as its store files, and a Claude client that keeps one sign-in per
 * config folder.
 */

export const START = Date.parse("2026-11-20T09:00:00Z");
export const HOUR = 60 * 60_000;
export const FIRST_EMAIL = "first@example.invalid";
export const SECOND_EMAIL = "second@example.invalid";
export const FIRST_TOKEN = "stand-in-token-first";
/** The computer's default Claude login, as the client last wrote it. */
export function writeDefaultLogin(home: string): void {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      oauthAccount: {
        accountUuid: "uuid-first",
        organizationUuid: "org-first",
        emailAddress: FIRST_EMAIL,
      },
    }),
  );
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: FIRST_TOKEN,
        refreshToken: "stand-in-refresh-first",
        expiresAt: START + 30 * 24 * HOUR,
        subscriptionType: "max",
      },
    }),
  );
  const written = START / 1000;
  utimesSync(join(home, ".claude.json"), written, written);
  utimesSync(join(home, ".claude", ".credentials.json"), written, written);
}

export type ClientCall = { command: string; configDir?: string };

/**
 * A Claude client that keeps one sign-in per config folder. A command with
 * no folder named is the default login's, which these cases never ask it
 * about: the default login is read from its store.
 */
export function standInClient() {
  const calls: ClientCall[] = [];
  const signedIn = new Map<string, string>();
  const behavior = { loginFinishes: true, logoutThrows: false };
  const run: RunClaude = async (args, _dir, options) => {
    const configDir = options?.env?.CLAUDE_CONFIG_DIR;
    const command = args.slice(0, 2).join(" ");
    calls.push({ command, ...(configDir ? { configDir } : {}) });
    if (!configDir) return { code: 0, stdout: "{}", stderr: "" };
    if (command === "auth login") {
      if (!behavior.loginFinishes) return { code: 1, stdout: "", stderr: "" };
      signedIn.set(configDir, SECOND_EMAIL);
      return { code: 0, stdout: "Login successful.\n", stderr: "" };
    }
    if (command === "auth logout") {
      if (behavior.logoutThrows) throw new Error("the client is gone");
      signedIn.delete(configDir);
      return { code: 0, stdout: "", stderr: "" };
    }
    const email = signedIn.get(configDir);
    return {
      code: email ? 0 : 1,
      stdout: JSON.stringify(
        email
          ? { loggedIn: true, authMethod: "claude.ai", email, subscriptionType: "pro" }
          : { loggedIn: false, authMethod: "none" },
      ),
      stderr: "",
    };
  };
  return { run, calls, signedIn, behavior };
}
