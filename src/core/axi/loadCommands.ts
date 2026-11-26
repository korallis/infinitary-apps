import { LOAD_COMMAND, loadDemandSchema } from "@shared/load";
import { RESOURCE_REFRESH_MS } from "@shared/resources";
import { encode } from "@toon-format/toon";
import { AxiError } from "axi-sdk-js";
import type { LoadClaim, LoadReceipt } from "../placed/loadLine";
import type { TaskAxiCli } from "./cli";
import type { ChannelReply, IntegrationChannelAnswer } from "./protocol";

export type LoadOp = "load.claim" | "load.read" | "load.receipt";
export type LoadConnection = {
  call: (
    command: string,
    op: LoadOp,
    input: LoadClaim | LoadReceipt | Record<string, never>,
  ) => Promise<ChannelReply<IntegrationChannelAnswer>>;
};

function output(reply: ChannelReply<IntegrationChannelAnswer>): string {
  if (reply.kind !== "answer")
    throw new AxiError("The load request has not answered. No wrapped command started.", "BUSY");
  if (reply.answer.refused)
    throw new AxiError(reply.answer.text ?? "The load request was refused.", "REFUSED");
  return `${encode(reply.answer.data ?? {})}\n`;
}

export function loadAxi(
  version: string,
  connect: () => Promise<LoadConnection>,
): TaskAxiCli<LoadConnection> {
  return {
    name: LOAD_COMMAND,
    description:
      "This task's declared heavy runs, in this computer's line. Running work is never stopped or slowed.",
    version,
    connect,
    home: async (connection) =>
      `${output(await connection.call("load", "load.read", {}))}${encode({ help: [`Use ${LOAD_COMMAND} run --processors <number> --memory-mib <number> -- <program> [arguments]`, "The caller declares the whole run's needs, including processes it starts outside its tree."] })}\n`,
    commands: {
      receipt: {
        usage: "receipt --hold <hold> --pid <supervisor> --payload <child> [--started <birth>]",
        description:
          "Verify this hold's one payload launch. Repeating it never launches work. Only a Windows wrapper leaves the birth out.",
        flags: { "--hold": "value", "--pid": "value", "--payload": "value", "--started": "value" },
        run: async (args, connection) => {
          const pid = Number(args.flags["--pid"]);
          const payload = Number(args.flags["--payload"]);
          const hold = args.flags["--hold"];
          const started = args.flags["--started"];
          if (
            args.positional.length ||
            !Number.isSafeInteger(pid) ||
            pid <= 0 ||
            !Number.isSafeInteger(payload) ||
            payload <= 0 ||
            typeof hold !== "string" ||
            !hold ||
            (started !== undefined && (typeof started !== "string" || !started))
          )
            throw new AxiError(
              "Name the hold and both live process identities.",
              "VALIDATION_ERROR",
            );
          return output(
            await connection.call(
              `receipt:${hold}:${pid}:${payload}:${started ?? ""}`,
              "load.receipt",
              { hold, pid, payload, ...(started !== undefined ? { started } : {}) },
            ),
          );
        },
      },
      run: {
        usage: "run --processors <number> --memory-mib <number> -- <program> [arguments]",
        description:
          "Wait in this computer's line, then run the program with its original input, output, environment and exit status. Processors stay reserved until a complete reading covers verified launch; memory growth stays reserved until the group exits.",
        flags: { "--processors": "value", "--memory-mib": "value" },
        run: async () => {
          throw new AxiError(
            "Run this through the supplied infinitary-load-axi launcher.",
            "REFUSED",
          );
        },
      },
      claim: {
        usage:
          "claim --pid <group> --processors <number> --memory-mib <number> [--parent <hold>] [--caller <pid>]",
        description:
          "The run wrapper's admission request. It registers only its live process group; it cannot release a running hold.",
        flags: {
          "--pid": "value",
          "--processors": "value",
          "--memory-mib": "value",
          "--parent": "value",
          "--caller": "value",
        },
        run: async (args, connection) => {
          const pid = Number(args.flags["--pid"]);
          const parsed = loadDemandSchema.safeParse({
            cpu: Number(args.flags["--processors"]),
            memoryBytes: Number(args.flags["--memory-mib"]) * 1024 ** 2,
          });
          if (args.positional.length || !Number.isSafeInteger(pid) || pid <= 0 || !parsed.success)
            throw new AxiError(
              "Name a positive processor count and memory amount in MiB for this run.",
              "VALIDATION_ERROR",
            );
          const parent = args.flags["--parent"];
          const caller =
            args.flags["--caller"] === undefined ? undefined : Number(args.flags["--caller"]);
          if (caller !== undefined && (!Number.isSafeInteger(caller) || caller <= 0))
            throw new AxiError(
              "Name the caller by its positive process number.",
              "VALIDATION_ERROR",
            );
          const reply = await connection.call(`claim:${pid}:${parent ?? ""}`, "load.claim", {
            pid,
            demand: parsed.data,
            ...(typeof parent === "string" ? { parent } : {}),
            ...(caller !== undefined ? { caller } : {}),
          });
          return `${output(reply)}retrySeconds: ${RESOURCE_REFRESH_MS / 1000}\n`;
        },
      },
    },
  };
}
