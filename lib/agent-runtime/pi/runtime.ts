import type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type * as PiAgentCoreModuleType from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type JsonObject,
  type Message,
  type ToolResultMessage,
  type Usage,
} from "@earendil-works/pi-ai";
import type * as PiAiModuleType from "@earendil-works/pi-ai";

import { importNativeEsm, isTsxWorker } from "./native-import";
import type {
  AgentRuntime,
  AgentRuntimeEvent,
  AgentTurnInput,
  AgentTurnResult,
  RuntimeContent,
  RuntimeMessage,
  RuntimeToolResult,
  RuntimeToolCall,
  RuntimeUsage,
} from "../types";
import { resolvePiModel } from "./model-adapter";
import type { ResolvedPiModel } from "./model-adapter";

type PiAgentCoreModule = typeof PiAgentCoreModuleType;
type PiAiModule = typeof PiAiModuleType;

function loadPiAgentCore(): Promise<PiAgentCoreModule> {
  return isTsxWorker()
    ? importNativeEsm<PiAgentCoreModule>("@earendil-works/pi-agent-core")
    : import("@earendil-works/pi-agent-core");
}

function loadPiAi(): Promise<PiAiModule> {
  return isTsxWorker()
    ? importNativeEsm<PiAiModule>("@earendil-works/pi-ai")
    : import("@earendil-works/pi-ai");
}

const EMPTY_USAGE: RuntimeUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
};

function now(): number {
  return Date.now();
}

function textOf(content: string | RuntimeContent[]): string {
  return typeof content === "string"
    ? content
    : content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
}

function usageOf(usage: Usage | undefined): RuntimeUsage {
  if (usage === undefined) return { ...EMPTY_USAGE };
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    totalTokens: usage.totalTokens,
  };
}

function addUsage(left: RuntimeUsage, right: RuntimeUsage): RuntimeUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function contentToPi(content: string | RuntimeContent[]) {
  return typeof content === "string"
    ? content
    : content.map((part) =>
        part.type === "text"
          ? { type: "text" as const, text: part.text }
          : { type: "image" as const, data: part.data, mimeType: part.mimeType },
      );
}

function messageToPi(message: RuntimeMessage, binding: AgentTurnInput["model"]): AgentMessage {
  const timestamp = now();
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content, timestamp };
    case "user":
      return { role: "user", content: contentToPi(message.content), timestamp };
    case "assistant":
      return {
        role: "assistant",
        content: [
          ...(typeof message.content === "string"
            ? [{ type: "text" as const, text: message.content }]
            : message.content.filter((part) => part.type === "text")),
          ...(message.toolCalls ?? []).map((call) => ({
            type: "toolCall" as const,
            id: call.id,
            name: call.name,
            arguments: call.arguments as unknown as JsonObject,
          })),
        ],
        api: "openai-completions",
        provider: binding.provider,
        model: binding.model,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp,
      } satisfies AssistantMessage;
    case "tool":
      return {
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content:
          typeof message.content === "string"
            ? [{ type: "text" as const, text: message.content }]
            : message.content,
        details: message.details as never,
        isError: message.isError === true,
        timestamp,
      } satisfies ToolResultMessage;
  }
}

function messageFromPi(message: AgentMessage): RuntimeMessage | null {
  if (message.role === "system") {
    const content = message.content;
    return {
      role: "system",
      content:
        typeof content === "string"
          ? content
          : content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join(""),
    };
  }
  if (message.role === "user") return { role: "user", content: message.content };
  if (message.role === "toolResult") {
    return {
      role: "tool",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: message.content,
      isError: message.isError,
      details: message.details,
    };
  }

  if (message.role !== "assistant") return null;
  const content = (message as AssistantMessage).content;
  return {
    role: "assistant",
    content: content
      .filter((part) => part.type === "text" || part.type === "thinking")
      .map((part) => ("text" in part ? part.text : part.thinking))
      .join(""),
    toolCalls: content
      .filter((part) => part.type === "toolCall")
      .map((part) => ({ id: part.id, name: part.name, arguments: part.arguments })),
    usage: usageOf((message as AssistantMessage).usage),
  };
}

function resultContent(result: RuntimeToolResult) {
  return typeof result.content === "string"
    ? [{ type: "text" as const, text: result.content }]
    : result.content;
}

function runtimeEvent(event: AgentEvent): AgentRuntimeEvent {
  switch (event.type) {
    case "agent_start":
    case "turn_start":
      return { type: event.type, data: {} };
    case "agent_end":
      return { type: event.type, data: { message_count: event.messages.length } };
    case "turn_end":
      return { type: event.type, data: { tool_result_count: event.toolResults.length } };
    case "message_start":
    case "message_end":
      return { type: event.type, data: { role: event.message.role } };
    case "message_update":
      return { type: event.type, data: { role: event.message.role } };
    case "tool_execution_start":
      return {
        type: event.type,
        data: { tool_call_id: event.toolCallId, tool_name: event.toolName, args: event.args },
      };
    case "tool_execution_update":
      return {
        type: event.type,
        data: {
          tool_call_id: event.toolCallId,
          tool_name: event.toolName,
          partial_result: event.partialResult,
        },
      };
    case "tool_execution_end":
      return {
        type: event.type,
        data: {
          tool_call_id: event.toolCallId,
          tool_name: event.toolName,
          is_error: event.isError,
        },
      };
  }
}

export class PiAgentRuntime implements AgentRuntime {
  constructor(
    private readonly resolveModel: (
      binding: AgentTurnInput["model"],
    ) => ResolvedPiModel | Promise<ResolvedPiModel> = resolvePiModel,
  ) {}

  async run(input: AgentTurnInput): Promise<AgentTurnResult> {
    // Pi attaches the signal to the active stream, but a signal that was
    // already aborted before prompt() can otherwise still produce one model
    // request. The CRM contract promises cancellation at the runtime boundary,
    // so reject before constructing the loop as well.
    input.abortSignal?.throwIfAborted();
    const [{ Agent }, { Type }, resolved] = await Promise.all([
      loadPiAgentCore(),
      loadPiAi(),
      this.resolveModel(input.model),
    ]);
    const events: AgentRuntimeEvent[] = [];
    const calls: RuntimeToolCall[] = [];
    const toolByName = new Map((input.tools ?? []).map((tool) => [tool.name, tool]));
    let turns = 0;
    let usage: RuntimeUsage = { ...EMPTY_USAGE };

    const tools: AgentTool[] = (input.tools ?? []).map((tool) => {
      const parameters = Type.Unsafe(tool.inputSchema);
      return {
        name: tool.name,
        label: tool.name,
        description: tool.description,
        parameters,
        execute: async (toolCallId, args, signal) => {
          const result = await tool.execute(args as Record<string, unknown>, {
            toolCallId,
            signal,
          });
          return {
            content: resultContent(result),
            details: result.details,
            ...(result.isError !== undefined ? { isError: result.isError } : {}),
            ...(result.terminate !== undefined ? { terminate: result.terminate } : {}),
          };
        },
      };
    });

    const agent = new Agent({
      initialState: {
        systemPrompt: input.systemPrompt,
        model: resolved.model,
        ...(tools.length > 0 ? { tools } : {}),
        ...(input.messages !== undefined
          ? { messages: input.messages.map((message) => messageToPi(message, input.model)) }
          : {}),
      },
      streamFn: resolved.streamFn,
      toolExecution: input.toolExecution ?? "parallel",
      transformContext: async (messages, signal) => {
        if (input.transformContext === undefined) return messages;
        const next = await input.transformContext(
          messages.flatMap((message) => {
            const converted = messageFromPi(message);
            return converted === null ? [] : [converted];
          }),
          signal,
        );
        return next.map((message) => messageToPi(message, input.model));
      },
      convertToLlm: (messages) =>
        messages.filter(
          (message): message is Message =>
            message.role === "system" ||
            message.role === "user" ||
            message.role === "assistant" ||
            message.role === "toolResult",
        ),
      beforeToolCall: async ({ toolCall, args }) => {
        const tool = toolByName.get(toolCall.name);
        calls.push({
          id: toolCall.id,
          name: toolCall.name,
          arguments: args as Record<string, unknown>,
        });
        if (tool === undefined || input.beforeToolCall === undefined) return undefined;
        return input.beforeToolCall({
          name: toolCall.name,
          args: args as Record<string, unknown>,
          toolCallId: toolCall.id,
        });
      },
      afterToolCall: async ({ toolCall, args, result, isError }) => {
        if (input.afterToolCall === undefined) return undefined;
        const decision = await input.afterToolCall({
          name: toolCall.name,
          args: args as Record<string, unknown>,
          toolCallId: toolCall.id,
          result: {
            content: result.content,
            details: result.details,
            isError,
            terminate: result.terminate,
          },
        });
        if (decision === undefined) return undefined;
        return {
          ...(decision.content !== undefined
            ? { content: resultContent({ content: decision.content }) }
            : {}),
          ...(decision.details !== undefined ? { details: decision.details } : {}),
          ...(decision.isError !== undefined ? { isError: decision.isError } : {}),
          ...(decision.terminate !== undefined ? { terminate: decision.terminate } : {}),
        };
      },
      shouldStopAfterTurn: async ({ message }) => {
        turns += 1;
        if (message.role === "assistant") {
          usage = addUsage(usage, usageOf(message.usage));
        }
        const converted = messageFromPi(message);
        const requested =
          converted === null
            ? false
            : await input.shouldStopAfterTurn?.({ message: converted, turn: turns, usage });
        return requested === true || (input.maxTurns !== undefined && turns >= input.maxTurns);
      },
    });

    agent.subscribe(async (event) => {
      const mapped = runtimeEvent(event);
      events.push(mapped);
      await input.onEvent?.(mapped);
    });

    const abort = () => agent.abort();
    input.abortSignal?.addEventListener("abort", abort, { once: true });

    try {
      await agent.prompt(input.prompt);
    } finally {
      input.abortSignal?.removeEventListener("abort", abort);
    }

    const messages = agent.state.messages.flatMap((message) => {
      const converted = messageFromPi(message);
      return converted === null ? [] : [converted];
    });
    const assistant = [...messages].reverse().find((message) => message.role === "assistant");
    return {
      messages,
      finalText: assistant === undefined ? "" : textOf(assistant.content),
      usage,
      events,
      toolCalls: calls,
    };
  }
}
