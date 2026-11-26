import type {
  BrowserActInput,
  BrowserAnswer,
  BrowserCaptureInput,
  BrowserCloseInput,
  BrowserInspectInput,
  BrowserNavigateInput,
} from "../browser/crewmateCommands";
import type { FeedbackOp, FeedbackReply } from "./feedbackCommands";
import type { FilesOp, FilesReply } from "./fileCommands";
import type { LoadOp } from "./loadCommands";
import type { SecretsOp, SecretsReply } from "./secretsCommands";
import type { StopsOp, StopsReply } from "./stopCommands";

/**
 * What passes between the app and the command process that runs one
 * `infinitary-<tool>-axi` command (docs/axi-commands.md, "The channel"). The app
 * starts the process for one command and sends `run`; the command's table
 * reaches the task's own tool only through `call`, which the app answers
 * for that one task; the process ends with `done`, carrying what the shell
 * prints and its exit code. Nothing here names a task: the app bound the
 * process to the task its key named before it started.
 */

/**
 * The header a request carries its key in: a task's key file is that one
 * header line, which the launcher's curl sends as it is. A request to
 * `infinitary-axi` that carries it comes from a crewmate's shell and is
 * refused (docs/axi-commands.md, "Infinitary from your terminal").
 */
export const AXI_KEY_HEADER = "x-infinitary-axi-key";

/** The task browser's operations a command may ask for: `CrewmateBrowser`'s, nothing more. */
export type BrowserOp = "navigate" | "inspect" | "act" | "capture" | "close" | "pages";

export type BrowserOpInput = {
  navigate: BrowserNavigateInput;
  inspect: BrowserInspectInput;
  act: BrowserActInput;
  capture: BrowserCaptureInput;
  close: BrowserCloseInput;
  pages: Record<string, never>;
};

/** A browser answer as it crosses into the command process: never the picture's bytes. */
export type ChannelAnswer = Omit<BrowserAnswer, "image">;

/**
 * The integrations' operations a command may ask for (docs/integrations.md,
 * "How a crewmate reaches them"): the roster, one integration's actions,
 * and one call - `IntegrationsService`'s, for this task, nothing more.
 */
export type IntegrationOp = "integrations.list" | "integrations.show" | "integrations.call";

export type IntegrationOpInput = {
  "integrations.list": Record<string, never>;
  "integrations.show": { name: string };
  "integrations.call": { name: string; action: string; input: unknown; reason?: string };
};

/**
 * The inbox's operations its command may ask for (docs/integrations.md,
 * "The inbox"): drop one event and read the receipts after a cursor -
 * `InboxDoor`'s, nothing more.
 */
export type InboxOp = "inbox.note" | "inbox.receipts";

export type InboxOpInput = {
  "inbox.note": { text: string; requestId?: string; source?: string };
  "inbox.receipts": { after: number };
};

/**
 * What `infinitary-axi` may ask of the app as the captain
 * (docs/axi-commands.md, "Infinitary from your terminal"): one read of the
 * published contract, a channel's argument list, and the changes pushed
 * after a cursor - `CommandDoor`'s, nothing more.
 */
export type CaptainOp = "captain.request" | "captain.channels" | "captain.watch";

export type CaptainOpInput = {
  "captain.request": { channel: string; args: unknown[] };
  "captain.channels": { channel?: string };
  "captain.watch": { after?: string; waitMs: number; channels?: string[]; full?: boolean };
};

export type IntegrationChannelAnswer = {
  data?: Record<string, unknown>;
  text?: string;
  refused?: "refused" | "invalid";
  /** What a load receipt the line could not check is told: its command leaves as interrupted, free to ask again. */
  unread?: string;
};

/**
 * How the app answered one operation. Within the shell's own limit it is
 * the answer. Past it, the operation keeps running and its answer is kept
 * for the task's next command (`running`), which then gets it instead of
 * running (`earlier`), or hears that it still runs (`busy`): an action is
 * never sent twice.
 */
export type ChannelReply<Answer> =
  | { kind: "answer"; answer: Answer }
  | { kind: "running"; command: string }
  | { kind: "earlier"; command: string; answer: Answer }
  | { kind: "busy"; command: string };

export type BrowserReply = ChannelReply<ChannelAnswer>;
export type IntegrationReply = ChannelReply<IntegrationChannelAnswer>;
export type InboxReply = ChannelReply<IntegrationChannelAnswer>;
export type CaptainReply = ChannelReply<IntegrationChannelAnswer>;

/** The app's first and only instruction to a command process. */
export type AxiRunMessage = {
  type: "run";
  /** The command's name as the shell ran it: `infinitary-browser-axi`. */
  tool: string;
  argv: string[];
  /** Where the shell found it, for the home view's path. */
  bin: string;
  /** The working folder the shell ran it in. */
  cwd: string;
  /** The app's version, which every command answers to `-v`. */
  version: string;
};

export type AxiCallMessage = {
  type: "call";
  id: number;
  /** The command as the crewmate named it (`click`), for the words of a kept answer. */
  command: string;
  op:
    | BrowserOp
    | IntegrationOp
    | InboxOp
    | CaptainOp
    | SecretsOp
    | LoadOp
    | FilesOp
    | StopsOp
    | FeedbackOp;
  input: unknown;
};

export type AxiResultMessage = {
  type: "result";
  id: number;
  reply: BrowserReply | IntegrationReply | SecretsReply | FilesReply | StopsReply | FeedbackReply;
};

export type AxiDoneMessage = { type: "done"; stdout: string; exitCode: number };

/** From the app to the command process. */
export type AxiParentMessage = AxiRunMessage | AxiResultMessage;

/** From the command process to the app. */
export type AxiChildMessage = AxiCallMessage | AxiDoneMessage;
