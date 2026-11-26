import { once } from "node:events";
import { readFileSync } from "node:fs";
import { type ClientRequest, request as httpRequest } from "node:http";
import { join, resolve } from "node:path";
import { LOAD_COMMAND } from "@shared/load";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../../../tests/helpers/deferred";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { HostChildProcess } from "../host";
import type { LoadClaimAnswer } from "../placed/loadLine";
import { AXI_ADDRESS_ENV, AXI_KEY_ENV, AxiChannel, type TaskShell } from "./channel";
import { AXI_KEY_HEADER, type AxiParentMessage } from "./protocol";

/**
 * A command whose caller closes its connection before the answer. The
 * channel is the real one on its loopback port; the command process is a
 * stand-in that asks its one operation and waits, as the real one does, so
 * the test reads whether the app stopped it and what it was sent.
 */

const channels: AxiChannel[] = [];

afterEach(() => {
  for (const channel of channels.splice(0)) channel.close();
});

async function open() {
  const processes: Array<{ killed: boolean; results: unknown[] }> = [];
  const spawn = (): HostChildProcess => {
    const state = { killed: false, results: [] as unknown[] };
    processes.push(state);
    let hear: (message: unknown) => void = () => {};
    const exits: Array<(code: number | null) => void> = [];
    return {
      pid: undefined,
      onMessage: (listener) => {
        hear = listener;
      },
      onExit: (listener) => {
        exits.push(listener);
      },
      kill: () => {
        if (state.killed) return;
        state.killed = true;
        for (const exit of exits) exit(null);
      },
      postMessage: (raw) => {
        const message = raw as AxiParentMessage;
        if (message.type === "result") state.results.push(message);
        else {
          const [command = ""] = message.argv;
          hear({ type: "call", id: 1, command, op: `load.${command}`, input: {} });
        }
      },
    };
  };
  const channel = await AxiChannel.open({
    spawner: { spawn },
    binDir: resolve(__dirname, "../../../resources/axi-bin"),
    version: "9.9.9-test",
    keysDir: join(scratchDir("infinitary-axi-caller-"), "task-channel"),
  });
  channels.push(channel);
  /** Whether the line may still save a launch, as each receipt's check was told to ask. */
  const receipts: Array<() => boolean> = [];
  const claim = deferred<LoadClaimAnswer>();
  let claims = 0;
  const shell = channel.grant("task", {
    load: {
      read: () => ({ runs: [] }),
      claim: () => {
        claims += 1;
        return claim.promise;
      },
      receipt: (_input, permitted) => {
        receipts.push(permitted ?? (() => true));
        return new Promise<void>(() => {});
      },
    },
  });
  return { shell, processes, receipts, claim, claims: () => claims };
}

/** One request as the launcher sends it; `key` false leaves the task's key out. */
function ask(shell: TaskShell, argv: string[], key = true): ClientRequest {
  const address = shell.env[AXI_ADDRESS_ENV] ?? "";
  const header =
    readFileSync(shell.env[AXI_KEY_ENV] ?? "", "utf8")
      .trim()
      .split(": ")[1] ?? "";
  const request = httpRequest({
    host: "127.0.0.1",
    port: Number(address.split(":")[1]),
    method: "POST",
    path: "/run",
    setHost: false,
    headers: { host: address, ...(key ? { [AXI_KEY_HEADER]: header } : {}) },
  });
  // Node reports a request its own caller destroyed as a failed one.
  request.on("error", () => {});
  request.end(
    new URLSearchParams([["tool", LOAD_COMMAND], ...argv.map((arg) => ["arg", arg])]).toString(),
  );
  return request;
}

describe("a load command whose caller's connection closes before its answer", () => {
  it("stops a receipt's command process and lets its check save no launch from then on", async () => {
    const { shell, processes, receipts } = await open();
    const request = ask(shell, ["receipt", "--hold", "held", "--pid", "1", "--payload", "2"]);
    await vi.waitFor(() => expect(receipts).toHaveLength(1), { timeout: 3_000 });
    expect(processes).toEqual([{ killed: false, results: [] }]);
    expect(receipts[0]?.()).toBe(true);

    request.destroy();

    await vi.waitFor(() => expect(processes[0]?.killed).toBe(true), { timeout: 3_000 });
    expect(receipts[0]?.()).toBe(false);
  });

  it("leaves a claim's command process running, and answers it", async () => {
    const { shell, processes, claim, claims } = await open();
    const request = ask(shell, ["claim", "--pid", "1", "--processors", "2", "--memory-mib", "512"]);
    await vi.waitFor(() => expect(claims()).toBe(1), { timeout: 3_000 });

    await new Promise((closed) => request.once("close", closed).destroy());
    // An answered request after it: the app has heard the first connection close by now.
    const [refusal] = await once(ask(shell, [], false), "response");
    expect(refusal.statusCode).toBe(200);
    refusal.resume();

    claim.resolve({ state: "waiting", ahead: 0, reason: "unavailable" });
    await vi.waitFor(() => expect(processes[0]?.results).toHaveLength(1), { timeout: 3_000 });
    expect(processes[0]?.killed).toBe(false);
  });
});
