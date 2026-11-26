import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { FEEDBACK_COMMAND, GITHUB_ISSUE_BODY_MAX } from "@shared/feedback";
import { FILES_COMMAND, type FilesAnswer } from "@shared/files";
import { STOPS_COMMAND } from "@shared/leftoverPrograms";
import { LOAD_COMMAND } from "@shared/load";
import { RESOURCE_REFRESH_MS } from "@shared/resources";
import { HERE } from "../../shared/deviceNames";
import { BROWSER_COMMAND } from "../browser/commandWords";
import type { CrewmateBrowser } from "../browser/taskBrowsers";
import type { FeedbackAnswer, TaskFeedback } from "../feedback/feedbackCommand";
import type { TaskFiles } from "../files/taskFiles";
import type { HostChildProcess, HostChildSpawner } from "../host";
import {
  INBOX_COMMAND,
  INFINITARY_COMMAND,
  INTEGRATIONS_COMMAND,
  type InboxDoor,
  isIntegrationAnswer,
  type TaskIntegrations,
} from "../integrations";
import {
  type LoadClaim,
  type LoadReceipt,
  LoadReceiptUnreadError,
  loadWaitWords,
  type TaskLoad,
} from "../placed/loadLine";
import { claimShellGroup, type ShellGroups } from "../placed/shellGroups";
import type { SecretAskInput } from "../secrets/asks";
import type { SecretBringRequest } from "../secrets/bring";
import {
  checkWords,
  SECRET_ASK_WORDS,
  SECRET_BRING_WORDS,
  SECRETS_CHECK_WORDS,
  SECRETS_ELSEWHERE_HELP,
} from "../secrets/commandWords";
import {
  type Injection,
  SECRETS_COMMAND,
  type SecretsCatalog,
  type SecretsCommand,
  type UseCheckInput,
} from "../secrets/requests";
import type { TaskStopsAnswer, TaskStopsCommand } from "../tasks/taskStops";
import type { FeedbackOpInput } from "./feedbackCommands";
import type { FilesOpInput } from "./fileCommands";
import { CREW_SHELL_PROGRAM, ownTaskCommand } from "./names";
import {
  AXI_KEY_HEADER,
  type AxiCallMessage,
  type AxiChildMessage,
  type BrowserOp,
  type CaptainOp,
  type CaptainOpInput,
  type ChannelAnswer,
  type ChannelReply,
  type InboxOpInput,
  type IntegrationChannelAnswer,
  type IntegrationOpInput,
} from "./protocol";
import type { SecretsAnswer } from "./secretsCommands";
import type { StopsOpInput } from "./stopCommands";

const NO_LEFT_BEHIND: TaskStopsAnswer = {
  text: "This computer keeps no record of what finished tasks left.",
  refused: "refused",
};

/**
 * The task channel (docs/axi-commands.md, "The channel"): how a crewmate's
 * `infinitary-<tool>-axi` command reaches its own task's tools in the app.
 *
 * The app listens on a port of this Mac's loopback for the run. Each task
 * that is granted a tool gets its own key, written to a file only its owner
 * can read (0600) in a folder of the app's data only its owner can open
 * (0700), and its shell is told the port and where that file is - never the
 * key itself, on a command line or in the environment. A request carries
 * the key (read from the file), the command's name, its arguments and the
 * working folder; the key alone names the task, so a command reaches only
 * the tools of the task whose key it holds, and a task id in the arguments
 * means nothing. A request a web page could make - one naming another host
 * or carrying an origin - is refused before its key is read. The task's
 * close revokes its key; the folder is emptied when the channel opens and
 * closes, so a run that was killed leaves no key behind for long.
 *
 * Each command runs in a process of its own (`./axiProcess.ts`), which the
 * host starts per request: the SDK it runs writes `process.exitCode`. Its
 * table reaches the task's tool only through `call`, answered here against
 * the browser the task was granted - `TaskBrowsers`, with every guard it
 * keeps.
 *
 * A shell that answers within a limit (Pi's, 3 seconds, which it names in
 * `INFINITARY_SHELL_CAP_MS`) gets its answer within that limit, counted from
 * when the shell started (`INFINITARY_SHELL_STARTED_MS`) while that shell can
 * still answer, not from when this request arrives: a slow launcher must not
 * answer after Pi has already turned the command into a background job. A
 * request that arrives once that limit has run out counts from receipt. An
 * operation still running then goes on, and its answer is kept for the task's
 * next command, which gets it instead of running, even when the limit has
 * already run out. Nothing is ever sent twice.
 *
 * The answer still has to come back through the shell, and a loaded Mac can
 * hold up that way back, or this process, past the limit, which no margin
 * covers. So a request tells its shell, by the id the shell gave it
 * (`INFINITARY_SHELL_ID`), that its command reached the app (`answering`):
 * the shell then waits for the answer rather than turning it into a job.
 */

export type { TaskShell } from "../session/session";

/**
 * The tools a task was granted: its browser, the integrations its crewmate
 * reaches (`infinitary-integrations-axi`, docs/integrations.md), and the
 * files on the captain's other computers (`infinitary-files-axi`,
 * docs/files.md).
 */
export type TaskTools = {
  browser?: CrewmateBrowser;
  integrations?: TaskIntegrations;
  files?: TaskFiles;
  secrets?: SecretsCommand;
  load?: TaskLoad;
  /**
   * The task's registered stops (`infinitary-stops-axi`,
   * docs/leftover-programs.md), kept on the computer that runs the task.
   */
  stops?: TaskStopsCommand;
  /**
   * A /feedback report's command (`infinitary-feedback-axi`,
   * docs/feedback.md), for a task on this Mac.
   */
  feedback?: TaskFeedback;
  /**
   * The Secrets catalog alone, for a task on another computer: its command
   * lists and shows, and every use answers unavailable (docs/secrets.md).
   */
  secretsCatalog?: SecretsCatalog;
  /**
   * The inbox's door (docs/integrations.md, "The inbox"): only the
   * captain's own command reaches it (`person`), never a task's.
   */
  inbox?: InboxDoor;
  /**
   * What `infinitary-axi` asks as the captain (`CommandDoor`,
   * docs/axi-commands.md, "Infinitary from your terminal"): only a request
   * the connection's local door admitted reaches it (`person`).
   */
  captain?: CaptainTool;
};

/** A captain's ask the contract refuses as it is written: the command exits 2. */
export class CaptainInvalid extends Error {}

/** The captain's reads, the contract's channels and the changes pushed, as `CommandDoor` answers them. */
export type CaptainTool = {
  [Op in CaptainOp]: (input: CaptainOpInput[Op]) => Promise<Record<string, unknown>>;
};

type OpAnswer =
  | ChannelAnswer
  | IntegrationChannelAnswer
  | SecretsAnswer
  | FilesAnswer
  | TaskStopsAnswer
  | FeedbackAnswer;

export type AxiChannelOptions = {
  /** Starts the process that runs one command: a utility process in the app, a fork in tests. */
  spawner: HostChildSpawner;
  /** The folder holding the launcher and its `infinitary-<tool>-axi` names (`resources/axi-bin`). */
  binDir: string;
  /** The app's version, which `-v` prints. */
  version: string;
  /** The app's own folder for the keys (`AppPaths.taskChannelDir`); emptied at open and close. */
  keysDir: string;
  /**
   * Told the id of the shell a command came from once it reached the app
   * (`JobManager.answering`), so that shell waits for its answer.
   */
  answering?: (shell: string) => void;
  /**
   * Where a Claude crewmate's shell that names itself is kept
   * (`CREW_SHELL_PROGRAM`), so the command door refuses what it leaves
   * running until its task closes. Without it, nothing is kept.
   */
  shellGroups?: Pick<ShellGroups, "add">;
};

/** The variables a task's shell carries (`resources/axi-bin/infinitary-axi` reads them). */
export const AXI_ADDRESS_ENV = "INFINITARY_AXI_ADDRESS";
export const AXI_KEY_ENV = "INFINITARY_AXI_KEY";
export const AXI_VERSION_ENV = "INFINITARY_AXI_VERSION";
export { SHELL_CAP_ENV, SHELL_ID_ENV, SHELL_STARTED_ENV } from "../hostEnv";

/** The header a request carries its key in; the key file is that one header line. */
const KEY_HEADER = AXI_KEY_HEADER;

/** Time a command needs around its operation: the launcher, the process, the answer's way back. */
const CAP_MARGIN_MS = 750;
/** A command process that has not answered by now is stopped. */
const PROCESS_BOUND_MS = 60_000;
/** The largest request a command sends: its arguments and working folder. */
const REQUEST_MAX = 1024 * 1024;

/** A feedback draft's body file at most, in bytes: GitHub's longest issue body at four bytes a character (docs/feedback.md). */
const FEEDBACK_BODY_FILE_MAX = 4 * GITHUB_ISSUE_BODY_MAX;
/** The loopback address the channel listens on; a shell reaches it by this name only. */
const LOOPBACK = "127.0.0.1";

const OPS: ReadonlySet<BrowserOp> = new Set([
  "navigate",
  "inspect",
  "act",
  "capture",
  "close",
  "pages",
]);

type Grant = {
  taskId: string;
  keyFile: string;
  digest: string;
  tools: TaskTools;
  /**
   * An operation that ran past its shell's limit, kept for the task's next
   * command of the same tool: a browser's answer never reaches an
   * integrations command, nor the other way.
   */
  parked: Map<string, { command: string; work: Promise<OpAnswer> }>;
};

type Outcome = { exitCode: number; stdout: string };

const TIMEOUT = Symbol("timeout");

function digestOf(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * When the shell's limit runs out. Count from when the shell started only
 * while it can still answer (`received` before `started + cap`): that is the
 * window a slow launcher would otherwise answer after Pi had given up. At or
 * after that, or with no start, count from receipt, as before. A start after
 * receipt cannot be this shell's start, so it must not push the deadline
 * later. No cap: the shell waits for every answer.
 */
function shellDeadline(
  received: number,
  capRaw: string | null,
  startedRaw: string | null,
): number | undefined {
  const cap = Number(capRaw || Number.NaN);
  if (!Number.isFinite(cap) || cap <= 0) return undefined;
  const started = Number(startedRaw || Number.NaN);
  const stillAnswering = Number.isFinite(started) && started > 0 && received < started + cap;
  const origin = stillAnswering ? Math.min(started, received) : received;
  return origin + cap - CAP_MARGIN_MS;
}

/**
 * Wait for `work` until `deadline`, or for good without one. A deadline
 * already past still lets a settled answer win: a later command in the same
 * shell shares that deadline, and a finished kept answer must not become
 * `BUSY` forever.
 */
async function within<T>(
  work: Promise<T>,
  deadline: number | undefined,
): Promise<T | typeof TIMEOUT> {
  if (deadline === undefined) return work;
  const left = Math.max(0, deadline - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), left);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One error line the launcher prints as it is, and its exit code. */
function failed(message: string, code: string, exitCode = 1): Outcome {
  return { exitCode, stdout: `error: ${message}\ncode: ${code}\n` };
}

export class AxiChannel {
  private readonly grants = new Map<string, Grant>();
  private readonly byDigest = new Map<string, Grant>();
  private readonly running = new Set<HostChildProcess>();
  private closed = false;

  private constructor(
    private readonly options: AxiChannelOptions,
    private readonly dir: string,
    /** Where a shell reaches the channel: this Mac's loopback and the run's port. */
    readonly address: string,
    private readonly server: Server,
  ) {}

  static async open(options: AxiChannelOptions): Promise<AxiChannel> {
    const dir = options.keysDir;
    // Keys a killed run left answer nothing now; none of them may linger.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    let channel: AxiChannel | undefined;
    const server = createServer((request, response) => {
      void channel?.handle(request, response);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, LOOPBACK, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    const { port } = server.address() as AddressInfo;
    channel = new AxiChannel(options, dir, `${LOOPBACK}:${port}`, server);
    return channel;
  }

  /**
   * Give a task its tools' commands: its key file once, then what its shell
   * carries. A task granted again keeps its key, so a shell already given
   * it still answers, and takes the tools it is granted now.
   */
  grant(taskId: string, tools: TaskTools): { env: Record<string, string>; path: string[] } {
    if (this.closed) throw new Error("The task channel is closed.");
    let grant = this.grants.get(taskId);
    if (!grant) {
      const key = randomBytes(32).toString("hex");
      const keyFile = join(this.dir, `${randomBytes(9).toString("hex")}.key`);
      writeFileSync(keyFile, `${KEY_HEADER}: ${key}\n`, { mode: 0o600, flag: "wx" });
      grant = { taskId, keyFile, digest: digestOf(key), tools, parked: new Map() };
      this.grants.set(taskId, grant);
      this.byDigest.set(grant.digest, grant);
    } else {
      grant.tools = tools;
    }
    return {
      env: {
        [AXI_ADDRESS_ENV]: this.address,
        [AXI_KEY_ENV]: grant.keyFile,
        [AXI_VERSION_ENV]: this.options.version,
        // A new task shell is not nested inside the program that started the app.
        ...(tools.load ? { INFINITARY_LOAD_HOLD: "" } : {}),
      },
      path: [this.options.binDir],
    };
  }

  /**
   * One request of the captain's own command, `infinitary-axi` or its old
   * name, which the connection's local door admitted by its key
   * (docs/axi-commands.md, "Infinitary from your terminal"). It reaches the
   * tools it is given and no task's. A request that also carries a task's
   * key came from a crewmate's shell and is refused: the command is the
   * captain's, never the crew's. The door refuses one from a program the
   * app started before it gets here (`CommandDoor`), as the refusal it
   * passes. No shell's limit applies: the captain's program waits for its
   * answer.
   */
  async person(
    request: IncomingMessage,
    response: ServerResponse,
    tools: TaskTools | { refused: string; help?: string },
  ): Promise<void> {
    const answer = (outcome: Outcome): void => {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end(`${outcome.exitCode}\n${outcome.stdout}`);
    };
    if (this.closed) {
      request.resume();
      answer(failed("Infinitary is quitting.", "NO_CHANNEL"));
      return;
    }
    if (request.headers[KEY_HEADER] !== undefined) {
      request.resume();
      answer(failed(`${INFINITARY_COMMAND} is for you, never for the crew.`, "REFUSED"));
      return;
    }
    const body = await this.readBody(request);
    if (body === undefined) {
      answer(failed("The command's arguments are too long.", "VALIDATION_ERROR", 2));
      return;
    }
    const form = new URLSearchParams(body);
    const tool = form.get("tool") ?? "";
    if (tool !== INFINITARY_COMMAND && tool !== INBOX_COMMAND) {
      answer(failed(`${tool || "That"} is not a command this door runs.`, "NO_TOOL"));
      return;
    }
    // The old name's last use, so Settings can say what still runs it before it is retired.
    if (tool === INBOX_COMMAND && !("refused" in tools))
      tools.inbox?.oldNameRan(form.get("cwd") ?? "");
    if ("refused" in tools) {
      answer({
        exitCode: 1,
        stdout: `error: ${tools.refused}\ncode: REFUSED\n${tools.help ? `help[1]: ${tools.help}\n` : ""}`,
      });
      return;
    }
    answer(
      await this.run(
        { taskId: "person:captain", keyFile: "", digest: "", tools, parked: new Map() },
        {
          tool,
          argv: form.getAll("arg"),
          bin: form.get("bin") || tool,
          cwd: form.get("cwd") ?? "",
        },
      ),
    );
  }

  granted(taskId: string): boolean {
    return this.grants.has(taskId);
  }

  /** The task closed: its key answers nothing from now on, and its file goes. */
  revoke(taskId: string): void {
    const grant = this.grants.get(taskId);
    if (!grant) return;
    this.grants.delete(taskId);
    this.byDigest.delete(grant.digest);
    try {
      unlinkSync(grant.keyFile);
    } catch {
      // Already gone with the folder.
    }
  }

  /** The app quits: nothing more is answered, every running command stops, the keys go. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const child of this.running) child.kill();
    this.running.clear();
    this.grants.clear();
    this.byDigest.clear();
    this.server.close();
    rmSync(this.dir, { recursive: true, force: true });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const received = Date.now();
    const answer = (outcome: Outcome): void => {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end(`${outcome.exitCode}\n${outcome.stdout}`);
    };
    // Heard from the start, since the caller can leave while its request is still read.
    const left = new AbortController();
    response.once("close", () => {
      if (!response.writableEnded) left.abort();
    });
    // A web page could reach a loopback port too: it names another host
    // (a name rebound to this Mac) or carries its origin. The launcher does neither.
    if (
      request.method !== "POST" ||
      request.url !== "/run" ||
      request.headers.host !== this.address ||
      request.headers.origin !== undefined
    ) {
      request.resume();
      answer(failed("This is not a request a task command makes.", "NO_CHANNEL"));
      return;
    }
    const key = request.headers[KEY_HEADER];
    const grant =
      typeof key === "string" && /^[0-9a-f]{64}$/.test(key)
        ? this.byDigest.get(digestOf(key))
        : undefined;
    if (!grant) {
      request.resume();
      answer(
        failed(
          "This shell's key names no task this app is running: run the command in your task's own shell.",
          "NO_CHANNEL",
        ),
      );
      return;
    }
    const body = await this.readBody(request);
    if (body === undefined) {
      answer(failed("The command's arguments are too long.", "VALIDATION_ERROR", 2));
      return;
    }
    const form = new URLSearchParams(body);
    // A Claude crewmate's shell naming its process number: no command runs,
    // and its answer says nothing either way, so the command it runs next
    // starts as it would have.
    if (form.get("tool") === CREW_SHELL_PROGRAM) {
      const pid = Number(form.get("pid"));
      const groups = this.options.shellGroups;
      if (groups && Number.isSafeInteger(pid) && pid > 0) {
        const kept = await claimShellGroup(groups, grant.taskId, pid).catch(() => false);
        if (!kept)
          console.warn(
            `[task-commands] kept no shell group for program ${pid} of task ${grant.taskId}, so the command door cannot refuse what it leaves running`,
          );
      }
      answer({ exitCode: 0, stdout: "" });
      return;
    }
    // Every answer from here comes back through the shell, a refusal too.
    const shell = form.get("shell");
    if (shell) this.options.answering?.(shell);
    // Firstmate 3000's name for a command is the same command.
    const tool = ownTaskCommand(form.get("tool") ?? "");
    const deadline = shellDeadline(received, form.get("cap"), form.get("started"));
    const has =
      (tool === BROWSER_COMMAND && grant.tools.browser !== undefined) ||
      (tool === INTEGRATIONS_COMMAND && grant.tools.integrations !== undefined) ||
      (tool === SECRETS_COMMAND &&
        (grant.tools.secrets !== undefined || grant.tools.secretsCatalog !== undefined)) ||
      (tool === LOAD_COMMAND && grant.tools.load !== undefined) ||
      (tool === FILES_COMMAND && grant.tools.files !== undefined) ||
      (tool === STOPS_COMMAND && grant.tools.stops !== undefined) ||
      (tool === FEEDBACK_COMMAND && grant.tools.feedback !== undefined);
    if (!has) {
      answer(
        failed(
          `This task has no ${tool || "such"} command: it runs only where its task has that tool.`,
          "NO_TOOL",
        ),
      );
      return;
    }
    const argv = form.getAll("arg");
    answer(
      await this.run(grant, {
        tool,
        argv,
        bin: form.get("bin") || tool,
        cwd: form.get("cwd") ?? "",
        deadline,
        // A receipt's worker is stopped with its run and takes its request
        // along: nobody is left to read the answer or to ask again. Any other
        // command runs on without its caller: its operation may have effects,
        // and the next command may be handed its answer.
        ...(tool === LOAD_COMMAND && argv[0] === "receipt" ? { left: left.signal } : {}),
      }),
    );
  }

  private readBody(request: IncomingMessage): Promise<string | undefined> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let over = false;
      request.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > REQUEST_MAX) over = true;
        else chunks.push(chunk);
      });
      request.on("end", () => resolve(over ? undefined : Buffer.concat(chunks).toString("utf8")));
      request.on("error", () => resolve(undefined));
    });
  }

  /** Run one command in its own process, answering its calls for this task alone. */
  private run(
    grant: Grant,
    command: {
      tool: string;
      argv: string[];
      bin: string;
      cwd: string;
      deadline?: number;
      /** Aborted once the caller's connection closed with no answer sent; only a load receipt names it. */
      left?: AbortSignal;
    },
  ): Promise<Outcome> {
    // An operation that waits on another computer answers before this is stopped.
    const stopsAt = Date.now() + PROCESS_BOUND_MS;
    // Claims adopt the same living group; receipts verify its one launch.
    // Neither creates a payload, so only these typed operations may repeat.
    // Other commands may have effects: an interrupted answer is not retry permission.
    const interrupted = (message: string): Outcome => {
      const operation = command.argv[0];
      if (command.tool !== LOAD_COMMAND || (operation !== "claim" && operation !== "receipt"))
        return failed(message, "FAILED");
      const answer = failed(
        message,
        operation === "claim" ? "CLAIM_UNAVAILABLE" : "RECEIPT_UNAVAILABLE",
      );
      return {
        ...answer,
        stdout: `${answer.stdout}retrySeconds: ${RESOURCE_REFRESH_MS / 1000}\n`,
      };
    };
    const stopped = interrupted("The command stopped before it answered.");
    return new Promise((resolve) => {
      if (command.left?.aborted) {
        resolve(stopped);
        return;
      }
      let child: HostChildProcess;
      try {
        child = this.options.spawner.spawn();
      } catch {
        resolve(interrupted(`${HERE.This} could not start the command right now.`));
        return;
      }
      this.running.add(child);
      let finished = false;
      const finish = (outcome: Outcome): void => {
        if (finished) return;
        finished = true;
        clearTimeout(bound);
        this.running.delete(child);
        child.kill();
        resolve(outcome);
      };
      const bound = setTimeout(
        () => finish(interrupted("The command did not answer in time.")),
        PROCESS_BOUND_MS,
      );
      bound.unref?.();
      child.onExit(() => finish(stopped));
      // Without this its process would wait out the whole bound for a line too busy to answer.
      command.left?.addEventListener("abort", () => finish(stopped), { once: true });
      child.onMessage((raw) => {
        const message = raw as AxiChildMessage;
        if (message?.type === "done") {
          finish({
            exitCode: Number.isInteger(message.exitCode) ? message.exitCode : 1,
            stdout: String(message.stdout ?? ""),
          });
          return;
        }
        if (message?.type === "call") {
          void this.call(grant, command, message, stopsAt).then((reply) => {
            if (finished) return;
            // The command process can print a refusal but not the reading
            // cadence, so an unread receipt leaves here as the interruption it is.
            if (reply.kind === "answer" && "unread" in reply.answer && reply.answer.unread)
              finish(interrupted(reply.answer.unread));
            else child.postMessage({ type: "result", id: message.id, reply });
          });
        }
      });
      child.postMessage({
        type: "run",
        tool: command.tool,
        argv: command.argv,
        bin: command.bin,
        cwd: command.cwd,
        version: this.options.version,
      });
    });
  }

  /**
   * One operation on the task's tool, within the shell's limit. A kept
   * answer goes first: the command of that tool that comes after one gets
   * it instead of running, or hears that it still runs.
   */
  private async call(
    grant: Grant,
    command: { tool: string; cwd: string; deadline?: number; left?: AbortSignal },
    message: AxiCallMessage,
    stopsAt: number,
  ): Promise<ChannelReply<OpAnswer>> {
    const { tool, deadline } = command;
    const parkedKey =
      tool === LOAD_COMMAND && (message.op === "load.claim" || message.op === "load.receipt")
        ? `${tool}:${message.command}`
        : tool;
    const parked = grant.parked.get(parkedKey);
    if (parked) {
      const settled = await within(parked.work, deadline);
      if (settled === TIMEOUT) return { kind: "busy", command: parked.command };
      if (grant.parked.get(parkedKey) === parked) grant.parked.delete(parkedKey);
      return { kind: "earlier", command: parked.command, answer: settled };
    }
    const work: Promise<OpAnswer> =
      tool === LOAD_COMMAND
        ? this.load(grant, message, command.left)
        : tool === INTEGRATIONS_COMMAND
          ? this.integrate(
              grant,
              message,
              AbortSignal.timeout(Math.max(0, stopsAt - CAP_MARGIN_MS - Date.now())),
            )
          : tool === SECRETS_COMMAND
            ? this.secret(grant, message, command.cwd)
            : tool === INFINITARY_COMMAND || tool === INBOX_COMMAND
              ? message.op.startsWith("inbox.")
                ? this.inbox(grant, message)
                : this.captain(grant, message)
              : tool === FILES_COMMAND
                ? this.files(grant, message)
                : tool === STOPS_COMMAND
                  ? this.stops(grant, message, command.cwd)
                  : tool === FEEDBACK_COMMAND
                    ? this.feedback(grant, message, command.cwd)
                    : this.operate(grant, message, command.cwd);
    // A copy may outlast the command's process: it is kept for the next
    // command before the process is stopped, rather than lost with it.
    const settled = await within(
      work,
      tool === FILES_COMMAND
        ? Math.min(deadline ?? Number.POSITIVE_INFINITY, stopsAt - CAP_MARGIN_MS)
        : deadline,
    );
    if (settled === TIMEOUT) {
      grant.parked.set(parkedKey, { command: message.command, work });
      return { kind: "running", command: message.command };
    }
    return { kind: "answer", answer: settled };
  }

  private async load(
    grant: Grant,
    message: AxiCallMessage,
    left?: AbortSignal,
  ): Promise<IntegrationChannelAnswer> {
    const load = grant.tools.load;
    if (!load) return { text: "This task has no load command.", refused: "refused" };
    try {
      if (message.op === "load.read") return { data: load.read() };
      if (message.op === "load.receipt") {
        // A launch is saved only for an asker that is still there to hear it.
        await load.receipt(
          message.input as LoadReceipt,
          () => this.grants.get(grant.taskId) === grant && !left?.aborted,
        );
        return { data: { verified: true } };
      }
      if (message.op !== "load.claim")
        return { text: "That is not a load operation.", refused: "invalid" };
      const run = await load.claim(message.input as LoadClaim);
      return {
        data: {
          state: run.state,
          ...(run.id ? { hold: run.id } : {}),
          ahead: run.ahead,
          ...(run.reason ? { reason: run.reason, note: loadWaitWords() } : {}),
          ...("free" in run && run.free
            ? {
                free: {
                  processors: run.free.cpu,
                  memoryMiB: Math.floor(run.free.memoryBytes / 1024 ** 2),
                },
              }
            : {}),
        },
      };
    } catch (error) {
      return {
        text: error instanceof Error ? error.message : String(error),
        refused: "refused",
        ...(error instanceof LoadReceiptUnreadError ? { unread: error.message } : {}),
      };
    }
  }

  /**
   * One of the integrations' operations, for this task alone
   * (`TaskIntegrations`). `signal` ends, before its command process is
   * stopped, a wait on the home a computer that runs work asks for each.
   */
  private async integrate(
    grant: Grant,
    message: AxiCallMessage,
    signal: AbortSignal,
  ): Promise<IntegrationChannelAnswer> {
    const integrations = grant.tools.integrations;
    if (!integrations) return { text: "This task has no integrations.", refused: "refused" };
    try {
      switch (message.op) {
        case "integrations.list":
          return { data: { integrations: await integrations.list(signal) } };
        case "integrations.show": {
          const { name } = (message.input ?? {}) as IntegrationOpInput["integrations.show"];
          const shown = await integrations.show(String(name ?? ""), signal);
          return isIntegrationAnswer(shown) ? shown : { data: shown };
        }
        case "integrations.call": {
          const { name, action, input, reason } = (message.input ??
            {}) as IntegrationOpInput["integrations.call"];
          return await integrations.call(
            String(name ?? ""),
            String(action ?? ""),
            input,
            signal,
            reason,
          );
        }
        default:
          return { text: "That is not an integrations operation.", refused: "invalid" };
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        text: `The integration could not do that: ${reason.replace(/\.$/, "")}.`,
        refused: "refused",
      };
    }
  }

  /**
   * One of the files command's operations, for this task alone
   * (`TaskFiles`): the home decides every one, and a copy runs on past the
   * shell's limit with its answer kept.
   */
  private async files(grant: Grant, message: AxiCallMessage): Promise<FilesAnswer> {
    const files = grant.tools.files;
    if (!files) return { text: "This task has no files command.", refused: "refused" };
    try {
      switch (message.op) {
        case "files.computers":
          return await files.computers();
        case "files.list": {
          const { target } = (message.input ?? {}) as FilesOpInput["files.list"];
          return await files.list(String(target ?? ""));
        }
        case "files.copy": {
          const { target } = (message.input ?? {}) as FilesOpInput["files.copy"];
          return await files.copy(String(target ?? ""));
        }
        default:
          return { text: "That is not a files operation.", refused: "invalid" };
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        text: `The files command could not do that: ${reason.replace(/\.$/, "")}.`,
        refused: "refused",
      };
    }
  }

  /**
   * One of the feedback command's operations, for this task alone: a
   * draft's body is read from the file the crewmate named, relative to the
   * folder its shell was in.
   */
  private async feedback(
    grant: Grant,
    message: AxiCallMessage,
    cwd: string,
  ): Promise<FeedbackAnswer> {
    const feedback = grant.tools.feedback;
    // i18n-exempt: the feedback command's answers are read by a crewmate, in English
    if (!feedback) return { text: "This task has no feedback command.", refused: "refused" };
    try {
      switch (message.op) {
        case "feedback.diagnostics": {
          const { task } = (message.input ?? {}) as FeedbackOpInput["feedback.diagnostics"];
          return await feedback.diagnostics(typeof task === "string" ? { task } : {});
        }
        case "feedback.similar": {
          const { words } = (message.input ?? {}) as FeedbackOpInput["feedback.similar"];
          return await feedback.similar({ words: String(words ?? "") });
        }
        case "feedback.draft": {
          const input = (message.input ?? {}) as FeedbackOpInput["feedback.draft"];
          const named = String(input.bodyFile ?? "");
          const path = isAbsolute(named) ? named : resolve(cwd || ".", named);
          let body: string;
          try {
            if (statSync(path).size > FEEDBACK_BODY_FILE_MAX)
              // i18n-exempt: the feedback command's answers are read by a crewmate, in English
              return { text: "The body file is too long for an issue.", refused: "invalid" };
            body = readFileSync(path, "utf8");
          } catch {
            // i18n-exempt: the feedback command's answers are read by a crewmate, in English
            return { text: `Cannot read the body file ${named}.`, refused: "invalid" };
          }
          return await feedback.draft({
            kind: String(input.kind ?? ""),
            title: String(input.title ?? ""),
            body,
            ...(typeof input.commentOn === "number" ? { commentOn: input.commentOn } : {}),
            ...(typeof input.task === "string" ? { task: input.task } : {}),
          });
        }
        default:
          // i18n-exempt: the feedback command's answers are read by a crewmate, in English
          return { text: "The feedback command does not do that.", refused: "invalid" };
      }
    } catch (caught) {
      return {
        text: caught instanceof Error ? caught.message : String(caught),
        refused: "refused",
      };
    }
  }

  /**
   * One of the stops command's operations, for this task alone: a stop is
   * registered with the folder its shell was in, where the close runs it.
   */
  private async stops(
    grant: Grant,
    message: AxiCallMessage,
    cwd: string,
  ): Promise<TaskStopsAnswer> {
    const stops = grant.tools.stops;
    if (!stops) return { text: "This task has no stops command.", refused: "refused" };
    try {
      switch (message.op) {
        case "stops.list":
          return stops.list();
        case "stops.add": {
          const { label, command } = (message.input ?? {}) as StopsOpInput["stops.add"];
          return stops.add({
            label: String(label ?? ""),
            command: String(command ?? ""),
            ...(cwd ? { cwd } : {}),
          });
        }
        case "stops.keep": {
          const { label, check, remove } = (message.input ?? {}) as StopsOpInput["stops.keep"];
          return stops.keep({
            label: String(label ?? ""),
            check: String(check ?? ""),
            remove: String(remove ?? ""),
            ...(cwd ? { cwd } : {}),
          });
        }
        case "stops.drop": {
          const { id } = (message.input ?? {}) as StopsOpInput["stops.drop"];
          return stops.drop(String(id ?? ""));
        }
        case "stops.left":
          return stops.left ? await stops.left() : NO_LEFT_BEHIND;
        case "stops.rerun": {
          const { task, id } = (message.input ?? {}) as StopsOpInput["stops.rerun"];
          return stops.rerun
            ? await stops.rerun(String(task ?? ""), String(id ?? ""))
            : NO_LEFT_BEHIND;
        }
        case "stops.dropKept": {
          const { task, id } = (message.input ?? {}) as StopsOpInput["stops.dropKept"];
          return stops.dropKept
            ? await stops.dropKept(String(task ?? ""), String(id ?? ""))
            : NO_LEFT_BEHIND;
        }
        case "stops.end": {
          const { task, pid } = (message.input ?? {}) as StopsOpInput["stops.end"];
          return stops.end ? await stops.end(String(task ?? ""), Number(pid)) : NO_LEFT_BEHIND;
        }
        default:
          return { text: "That is not a stops operation.", refused: "invalid" };
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        text: `The stop could not be saved: ${reason.replace(/\.$/, "")}.`,
        refused: "refused",
      };
    }
  }

  /** One of the captain's reads, as `CommandDoor` answers it. */
  private async captain(grant: Grant, message: AxiCallMessage): Promise<IntegrationChannelAnswer> {
    const captain = grant.tools.captain;
    const op = message.op as CaptainOp;
    if (!captain || !Object.hasOwn(captain, op))
      return { text: "That is not an infinitary-axi operation.", refused: "invalid" };
    try {
      return { data: await captain[op]((message.input ?? {}) as never) };
    } catch (error) {
      const invalid = error instanceof CaptainInvalid;
      return {
        text: error instanceof Error ? error.message : String(error),
        refused: invalid ? "invalid" : "refused",
      };
    }
  }

  /** One of the inbox's operations, through the door the captain's command holds. */
  private async inbox(grant: Grant, message: AxiCallMessage): Promise<IntegrationChannelAnswer> {
    const inbox = grant.tools.inbox;
    if (!inbox) return { text: "This key has no inbox.", refused: "refused" };
    try {
      switch (message.op) {
        case "inbox.note": {
          const { text, requestId, source } = (message.input ?? {}) as InboxOpInput["inbox.note"];
          return {
            data: inbox.note({
              text: String(text ?? ""),
              ...(typeof requestId === "string" ? { requestId } : {}),
              ...(typeof source === "string" ? { source } : {}),
            }),
          };
        }
        case "inbox.receipts": {
          const { after } = (message.input ?? {}) as InboxOpInput["inbox.receipts"];
          return { data: inbox.receipts(Number.isInteger(after) ? after : 0) };
        }
        default:
          return { text: "That is not an inbox operation.", refused: "invalid" };
      }
    } catch (error) {
      return {
        text: error instanceof Error ? error.message : String(error),
        refused: "refused",
      };
    }
  }

  /** Operation authority is checked by Secrets, never by this same-user bearer channel. */
  private async secret(grant: Grant, message: AxiCallMessage, cwd: string): Promise<SecretsAnswer> {
    const secrets = grant.tools.secrets;
    // A task on another computer lists the same catalog and has no use at all.
    const catalog = secrets ?? grant.tools.secretsCatalog;
    if (!catalog) return { unavailable: true };
    try {
      switch (message.op) {
        case "secrets.list":
          return { secrets: await catalog.list(), requests: secrets?.receipts() ?? [] };
        case "secrets.show": {
          const ref = (message.input as { ref: string }).ref;
          const secret = (await catalog.list()).find((secret) => secret.ref === ref);
          return secret ? { secret } : { unavailable: true };
        }
      }
      if (!secrets) return { unavailable: true, help: SECRETS_ELSEWHERE_HELP };
      switch (message.op) {
        case "secrets.check": {
          // The same working folder inject binds, so the check is of the same run.
          const check = await secrets.check({
            ...(message.input as UseCheckInput),
            ...(cwd ? { cwd } : {}),
          });
          return { check, help: checkWords(check) };
        }
        case "secrets.inject": {
          // The shell's working folder, as its launcher reported it: where relative
          // arguments resolve, shown on the approval, never authority.
          const receipt = await secrets.inject({
            ...(message.input as Injection),
            ...(cwd ? { cwd } : {}),
          });
          // A request that failed a check raised no card; the pre-check names which.
          return receipt.state === "unavailable"
            ? { receipt, help: SECRETS_CHECK_WORDS.refused }
            : { receipt };
        }
        case "secrets.bring": {
          if (!secrets.bring) return { unavailable: true, help: SECRET_BRING_WORDS.notHere };
          // The shell's working folder: where a source's program resolves when it names none.
          const answer = await secrets.bring(message.input as SecretBringRequest, cwd || undefined);
          return {
            bring:
              answer.state === "unavailable"
                ? { bring: answer.bring, state: answer.state }
                : answer,
            help: answer.state === "unavailable" ? answer.help : SECRET_BRING_WORDS.waiting,
          };
        }
        case "secrets.status": {
          const id = (message.input as { request: string }).request;
          // A bring answers by the id it was asked with: its state and each outcome, never a value.
          const bring = secrets.bringStatus?.(id);
          if (bring) return { bring };
          const receipt = await secrets.status(id);
          return receipt ? { receipt } : { unavailable: true };
        }
        case "secrets.ask": {
          if (!secrets.ask) return { unavailable: true, help: SECRET_ASK_WORDS.notHere };
          const answer = await secrets.ask(message.input as SecretAskInput);
          // The help line is said once, beside the ask, never inside it too.
          return {
            ask: answer.state === "unavailable" ? { ask: answer.ask, state: answer.state } : answer,
            help:
              answer.state === "unavailable"
                ? answer.help
                : answer.state === "kept"
                  ? SECRET_ASK_WORDS.kept
                  : answer.without === "how"
                    ? SECRET_ASK_WORDS.waitingWithoutHow
                    : SECRET_ASK_WORDS.waiting,
          };
        }
        case "secrets.cancel": {
          const request = (message.input as { request: string }).request;
          // An ask this task is waiting on is withdrawn by the same id it asked with.
          if (await secrets.cancelAsk?.(request))
            return { ask: { ask: request, state: "withdrawn" } };
          if (secrets.cancelBring?.(request))
            return { bring: { bring: request, state: "withdrawn" } };
          const receipt = await secrets.cancel(request);
          return receipt ? { receipt } : { unavailable: true };
        }
        default:
          return { unavailable: true };
      }
    } catch {
      // A backend error can contain a credential; no arbitrary text crosses this seam.
      return { unavailable: true };
    }
  }

  /** The browser's own operation, never its picture's bytes. */
  private async operate(
    grant: Grant,
    message: AxiCallMessage,
    cwd: string,
  ): Promise<ChannelAnswer> {
    const browser = grant.tools.browser;
    const op = message.op as BrowserOp;
    if (!browser || !OPS.has(op)) {
      return { text: "This task has no browser.", refused: "refused" };
    }
    const asked = (message.input ?? {}) as { start?: object };
    // A saved start runs in the folder the command's shell was in, as the channel knows it.
    const input = (
      op === "navigate" && asked.start ? { ...asked, start: { ...asked.start, cwd } } : asked
    ) as never;
    try {
      const { image: _image, ...answer } = await (op === "pages"
        ? browser.pages()
        : browser[op](input));
      return answer;
    } catch (error) {
      return {
        text: `The browser could not do that: ${error instanceof Error ? error.message : String(error)}.`,
        refused: "refused",
      };
    }
  }
}
