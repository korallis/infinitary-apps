import {
  FIRSTMATE_REQUEST_TIMEOUT_MS,
  FIRSTMATE_TURN_TIMEOUT_MS,
  type SeatBinding,
  type ServedInstructions,
  seatSessionSpec,
} from "../../src/core/orchestrator/seat";
import type { SessionResume, SessionSpec } from "../../src/core/session/session";
import type { BoundTool } from "../../src/core/session/tools";

/**
 * The seat as the seat's own backend tests describe it: where it runs and
 * keeps its record, what it is bound to, and the two watched bounds a test
 * may shorten or turn off (0). `seatSpec` opens it the way the agent does,
 * through the seat preset (`seatSessionSpec`), so a backend test drives
 * exactly the spec production hands the backend.
 */
export type SeatTestSpec = {
  /** The neutral firstmate home. */
  cwd: string;
  /** Where a Pi-served seat keeps its rolling file. */
  sessionsDir: string;
  /** Where a Claude-served seat keeps the app's copy of its transcript. */
  claudeDir?: string;
  binding: SeatBinding;
  model: { provider: string; id: string };
  tools: readonly BoundTool[];
  instructions?: ServedInstructions;
  resume?: SessionResume;
  /** The summary rule, as the agent passes the person's Settings choice. */
  compaction?: SessionSpec["compaction"];
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
};

export function seatSpec(input: SeatTestSpec): SessionSpec {
  const spec = seatSessionSpec({
    paths: {
      firstmateHomeDir: input.cwd,
      firstmateSessionsDir: input.sessionsDir,
      firstmateClaudeDir: input.claudeDir ?? input.sessionsDir,
    },
    binding: input.binding,
    model: input.model,
    tools: input.tools,
    ...(input.instructions ? { instructions: input.instructions } : {}),
    ...(input.resume ? { resume: input.resume } : {}),
    ...(input.compaction ? { compaction: input.compaction } : {}),
  });
  if (input.requestTimeoutMs === undefined && input.turnTimeoutMs === undefined) return spec;
  return {
    ...spec,
    bounds: {
      ...spec.bounds,
      watched: {
        requestTimeoutMs: input.requestTimeoutMs ?? FIRSTMATE_REQUEST_TIMEOUT_MS,
        turnTimeoutMs: input.turnTimeoutMs ?? FIRSTMATE_TURN_TIMEOUT_MS,
      },
    },
  };
}
