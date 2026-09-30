import type pg from "pg";

import type { AgentRuntime } from "@/lib/agent-runtime";

import type { Logger } from "../obs/logger";
import {
  runModelCall,
  type LlmEdgeConfig,
  type RunModelCallInput,
} from "../edge/llm/run-model-call";

/**
 * Adapter seam for a CRM turn's model execution.
 *
 * The CRM turn still owns the business policy around a call (context, tool
 * outcomes, checkpoint validation, handoff, and persistence). The generic
 * model-call plumbing lives here so that the turn does not become a second
 * runtime: provider resolution, budget, usage/audit, and the Pi loop remain
 * behind the model gateway and injected AgentRuntime contract.
 */
export async function executePiTurnModelCall(
  deps: {
    pool: pg.Pool;
    llmCfg: LlmEdgeConfig;
    log: Logger;
    runtime?: AgentRuntime;
  },
  input: RunModelCallInput,
) {
  return runModelCall(deps.pool, deps.llmCfg, input, {
    log: deps.log,
    ...(deps.runtime ? { runtime: deps.runtime } : {}),
  });
}
