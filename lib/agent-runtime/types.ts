/**
 * CRM-facing runtime contract.
 *
 * This file deliberately has no dependency on Pi, Vercel AI SDK, or a provider
 * SDK. The CRM domain supplies messages and tools through these small value
 * objects; a runtime adapter owns execution details.
 */

export type RuntimeJsonSchema = Record<string, unknown>;

export type EvaluationRuntimeMode = "shadow";
export type RuntimeMode = "pi" | EvaluationRuntimeMode;
export const RUNTIME_EVALUATION_MODE: EvaluationRuntimeMode = "shadow";

export type RuntimeContent =
  { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface RuntimeToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type RuntimeMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | RuntimeContent[] }
  | {
      role: "assistant";
      content: string | RuntimeContent[];
      toolCalls?: RuntimeToolCall[];
      usage?: RuntimeUsage;
    }
  | {
      role: "tool";
      toolCallId: string;
      toolName: string;
      content: string | RuntimeContent[];
      isError?: boolean;
      details?: unknown;
    };

export interface RuntimeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

export interface RuntimeToolResult {
  content: string | RuntimeContent[];
  details?: unknown;
  isError?: boolean;
  terminate?: boolean;
}

export type ToolEffect = "read" | "reversible_write" | "external" | "irreversible";

export interface ActionPreview {
  resource: string;
  targetId?: string;
  changedFields: Array<{ field: string; before: unknown; after: unknown }>;
}

export interface CompensationResult {
  ok: boolean;
  message?: string;
}

export interface RuntimeTool {
  name: string;
  description: string;
  inputSchema: RuntimeJsonSchema;
  capability: "read" | "write" | "send" | "handoff" | "external";
  /** Optional at the generic adapter boundary; CRM workbench rejects missing classification. */
  effect?: ToolEffect;
  resource?: string;
  execute(
    args: Record<string, unknown>,
    context: { toolCallId: string; signal?: AbortSignal },
  ): Promise<RuntimeToolResult>;
  preview?(args: Record<string, unknown>): Promise<ActionPreview>;
  compensate?(args: Record<string, unknown>): Promise<CompensationResult>;
}

export interface RuntimeModelBinding {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface BeforeToolCallDecision {
  block?: boolean;
  reason?: string;
  terminate?: boolean;
}

export interface AfterToolCallDecision {
  content?: string | RuntimeContent[];
  details?: unknown;
  isError?: boolean;
  terminate?: boolean;
}

export interface AgentRuntimeEvent {
  type:
    | "agent_start"
    | "agent_end"
    | "turn_start"
    | "turn_end"
    | "message_start"
    | "message_update"
    | "message_end"
    | "tool_execution_start"
    | "tool_execution_update"
    | "tool_execution_end";
  data: Record<string, unknown>;
}

export interface AgentTurnInput {
  systemPrompt: string;
  messages?: RuntimeMessage[];
  prompt: string;
  model: RuntimeModelBinding;
  abortSignal?: AbortSignal;
  tools?: RuntimeTool[];
  maxTurns?: number;
  toolExecution?: "parallel" | "sequential";
  transformContext?: (
    messages: RuntimeMessage[],
    signal?: AbortSignal,
  ) => RuntimeMessage[] | Promise<RuntimeMessage[]>;
  beforeToolCall?: (input: {
    name: string;
    args: Record<string, unknown>;
    toolCallId: string;
  }) => BeforeToolCallDecision | undefined | Promise<BeforeToolCallDecision | undefined>;
  afterToolCall?: (input: {
    name: string;
    args: Record<string, unknown>;
    toolCallId: string;
    result: RuntimeToolResult;
  }) => AfterToolCallDecision | undefined | Promise<AfterToolCallDecision | undefined>;
  shouldStopAfterTurn?: (input: {
    message: RuntimeMessage;
    turn: number;
    usage: RuntimeUsage;
  }) => boolean | Promise<boolean>;
  onEvent?: (event: AgentRuntimeEvent) => void | Promise<void>;
}

export interface AgentTurnResult {
  messages: RuntimeMessage[];
  finalText: string;
  usage: RuntimeUsage;
  events: AgentRuntimeEvent[];
  toolCalls: RuntimeToolCall[];
}

export interface AgentRuntime {
  run(input: AgentTurnInput): Promise<AgentTurnResult>;
}
