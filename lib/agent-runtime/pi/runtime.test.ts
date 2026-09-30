import { describe, expect, it, vi } from "vitest";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";

import { PiAgentRuntime } from "./runtime";

function runtimeWithFaux(
  responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0],
) {
  const faux = fauxProvider({
    provider: "crm-test-provider",
    models: [{ id: "crm-test-model" }],
  });
  faux.setResponses(responses);
  const runtime = new PiAgentRuntime(() => ({
    model: faux.getModel() as never,
    streamFn: faux.provider.streamSimple.bind(faux.provider) as never,
  }));
  return { runtime, faux };
}

const model = {
  provider: "crm-test-provider",
  model: "crm-test-model",
  apiKey: "test-key",
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("PiAgentRuntime", () => {
  it.skipIf(!process.env.OPENCODE_ZEN_TEST_KEY)(
    "uses OpenCode Zen through Pi Agent Core with a CRM-tool fixture",
    async () => {
      const apiKey = process.env.OPENCODE_ZEN_TEST_KEY;
      if (!apiKey) throw new Error("opencode_zen_test_key_missing");

      let crmReadCount = 0;
      const eventTypes: string[] = [];
      const runtime = new PiAgentRuntime();
      const result = await runtime.run({
        systemPrompt:
          "You are a CRM assistant. For contact facts, you must call crm_search_contacts before answering. Never invent tool results.",
        prompt:
          "请先调用 crm_search_contacts 按姓名精确查找‘林晓梅’，再根据工具返回回答她的商机阶段。",
        model: {
          provider: "opencode",
          model: "space-bunny-free",
          apiKey,
          temperature: 0,
        },
        tools: [
          {
            name: "crm_search_contacts",
            description: "按姓名搜索 CRM 联系人并返回关联商机事实。",
            inputSchema: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
              additionalProperties: false,
            },
            capability: "read",
            execute: async ({ name }) => {
              crmReadCount += 1;
              if (name !== "林晓梅") return { content: "没有找到联系人。" };
              return {
                content: "联系人：林晓梅；关联商机阶段：需求确认。",
                details: { source: "crm-test-fixture", contactName: name, leadStage: "需求确认" },
              };
            },
          },
        ],
        maxTurns: 4,
        abortSignal: AbortSignal.timeout(60_000),
        onEvent: (event) => {
          eventTypes.push(event.type);
        },
      });

      expect(crmReadCount, `runtime events: ${eventTypes.join(",")}`).toBe(1);
      expect(result.toolCalls).toEqual([
        expect.objectContaining({
          name: "crm_search_contacts",
          arguments: { name: "林晓梅" },
        }),
      ]);
      expect(result.events.some((event) => event.type === "tool_execution_start")).toBe(true);
      expect(result.events.some((event) => event.type === "tool_execution_end")).toBe(true);
      expect(result.finalText).toContain("需求确认");
    },
    90_000,
  );

  it("runs a basic turn through Pi Agent Core and exposes lifecycle events", async () => {
    const { runtime } = runtimeWithFaux([fauxAssistantMessage("ok")]);

    const result = await runtime.run({
      systemPrompt: "You are a CRM assistant.",
      prompt: "hello",
      model,
    });

    expect(result.finalText).toBe("ok");
    expect(result.events[0]?.type).toBe("agent_start");
    expect(result.events[1]?.type).toBe("turn_start");
    expect(result.events.at(-2)?.type).toBe("turn_end");
    expect(result.events.at(-1)?.type).toBe("agent_end");
    expect(result.events.filter((event) => event.type === "message_update").length).toBeGreaterThan(
      0,
    );
  });

  it("executes a tool and continues with its result", async () => {
    const { runtime } = runtimeWithFaux([
      fauxAssistantMessage(fauxToolCall("lookup", { id: "lead-1" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    const lookup = vi.fn(async () => ({ content: "lead found", details: { found: true } }));

    const result = await runtime.run({
      systemPrompt: "Use tools when needed.",
      prompt: "find the lead",
      model,
      tools: [
        {
          name: "lookup",
          description: "Look up a lead.",
          inputSchema: { type: "object", properties: { id: { type: "string" } } },
          capability: "read",
          execute: lookup,
        },
      ],
      maxTurns: 4,
    });

    expect(lookup).toHaveBeenCalledWith(
      { id: "lead-1" },
      expect.objectContaining({ toolCallId: expect.any(String) }),
    );
    expect(result.finalText).toBe("done");
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ name: "lookup", arguments: { id: "lead-1" } }),
    ]);
    expect(result.events.some((event) => event.type === "tool_execution_start")).toBe(true);
    expect(result.events.some((event) => event.type === "tool_execution_end")).toBe(true);
  });

  it("blocks a tool in beforeToolCall without executing its side effect", async () => {
    const { runtime } = runtimeWithFaux([
      fauxAssistantMessage(fauxToolCall("send_message", { body: "hello" }), {
        stopReason: "toolUse",
      }),
    ]);
    const send = vi.fn(async () => ({ content: "sent" }));

    const result = await runtime.run({
      systemPrompt: "Never bypass policy.",
      prompt: "send it",
      model,
      tools: [
        {
          name: "send_message",
          description: "Send a message.",
          inputSchema: { type: "object", properties: { body: { type: "string" } } },
          capability: "send",
          execute: send,
        },
      ],
      beforeToolCall: async () => ({
        block: true,
        reason: "blocked by CRM policy",
        terminate: true,
      }),
      maxTurns: 4,
    });

    expect(send).not.toHaveBeenCalled();
    expect(result.finalText).toBe("");
    expect(result.events.some((event) => event.type === "tool_execution_end")).toBe(true);
  });

  it("honors the CRM post-turn stop policy before requesting another model turn", async () => {
    const { runtime } = runtimeWithFaux([
      fauxAssistantMessage("first"),
      fauxAssistantMessage("second"),
    ]);
    const stopPolicy = vi.fn(async (_input: unknown) => true);

    const result = await runtime.run({
      systemPrompt: "Stop after the first completed turn.",
      prompt: "hello",
      model,
      maxTurns: 4,
      shouldStopAfterTurn: async (input) => {
        stopPolicy(input);
        return true;
      },
    });

    expect(stopPolicy).toHaveBeenCalledTimes(1);
    expect(result.finalText).toBe("first");
    expect(result.events.filter((event) => event.type === "turn_end")).toHaveLength(1);
  });

  it("accumulates usage across model turns in one CRM agent run", async () => {
    const usage = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    const { runtime } = runtimeWithFaux([
      {
        ...fauxAssistantMessage(fauxToolCall("continue", {}), { stopReason: "toolUse" }),
        usage: usage(10, 3, 1, 0),
      },
      { ...fauxAssistantMessage("second"), usage: usage(20, 5, 2, 4) },
    ]);
    const seenUsage: Array<{ inputTokens: number; outputTokens: number; totalTokens: number }> = [];

    const result = await runtime.run({
      systemPrompt: "Continue until the CRM policy stops the run.",
      prompt: "continue",
      model,
      maxTurns: 2,
      tools: [
        {
          name: "continue",
          description: "Continue the scripted run.",
          inputSchema: { type: "object", properties: {} },
          capability: "read",
          execute: async () => ({ content: "continued" }),
        },
      ],
      shouldStopAfterTurn: async ({ usage }) => {
        seenUsage.push(usage);
        return false;
      },
    });

    const perTurnUsage = result.messages.flatMap((message) =>
      message.role === "assistant" && message.usage !== undefined ? [message.usage] : [],
    );
    const expectedUsage = perTurnUsage.reduce(
      (total, current) => ({
        inputTokens: total.inputTokens + current.inputTokens,
        outputTokens: total.outputTokens + current.outputTokens,
        cacheReadTokens: total.cacheReadTokens + current.cacheReadTokens,
        cacheWriteTokens: total.cacheWriteTokens + current.cacheWriteTokens,
        totalTokens: total.totalTokens + current.totalTokens,
      }),
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
    );

    expect(seenUsage).toHaveLength(2);
    expect(seenUsage.at(-1)).toEqual(expectedUsage);
    expect(result.usage).toEqual(expectedUsage);
    expect(result.usage.outputTokens).toBeGreaterThan(perTurnUsage.at(-1)?.outputTokens ?? 0);
  });

  it.each([
    ["parallel", 2],
    ["sequential", 1],
  ] as const)(
    "executes a multi-tool batch in %s mode",
    async (toolExecution, expectedConcurrency) => {
      const { runtime } = runtimeWithFaux([
        fauxAssistantMessage([fauxToolCall("first", {}), fauxToolCall("second", {})], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("batch complete"),
      ]);
      let active = 0;
      let maximumConcurrency = 0;
      const execute = vi.fn(async () => {
        active += 1;
        maximumConcurrency = Math.max(maximumConcurrency, active);
        await wait(5);
        active -= 1;
        return { content: "ok" };
      });

      const result = await runtime.run({
        systemPrompt: "Use both tools.",
        prompt: "run the batch",
        model,
        toolExecution,
        tools: [
          {
            name: "first",
            description: "First operation.",
            inputSchema: { type: "object", properties: {} },
            capability: "read",
            execute,
          },
          {
            name: "second",
            description: "Second operation.",
            inputSchema: { type: "object", properties: {} },
            capability: "read",
            execute,
          },
        ],
        maxTurns: 4,
      });

      expect(result.finalText).toBe("batch complete");
      expect(execute).toHaveBeenCalledTimes(2);
      expect(maximumConcurrency).toBe(expectedConcurrency);
    },
  );

  it("applies afterToolCall to the tool result before continuation", async () => {
    const { runtime } = runtimeWithFaux([
      fauxAssistantMessage(fauxToolCall("lookup", { id: "lead-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const afterToolCall = vi.fn(async () => ({
      content: "policy-normalized result",
      details: { normalized: true },
    }));

    const result = await runtime.run({
      systemPrompt: "Use the lookup tool.",
      prompt: "find the lead",
      model,
      tools: [
        {
          name: "lookup",
          description: "Look up a lead.",
          inputSchema: { type: "object", properties: { id: { type: "string" } } },
          capability: "read",
          execute: async () => ({ content: "raw result" }),
        },
      ],
      afterToolCall,
      maxTurns: 4,
    });

    expect(afterToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ name: "lookup", args: { id: "lead-1" } }),
    );
    const toolResult = result.messages.find((message) => message.role === "tool");
    expect(toolResult).toMatchObject({ details: { normalized: true } });
    expect(toolResult && typeof toolResult.content === "object" ? toolResult.content : []).toEqual([
      { type: "text", text: "policy-normalized result" },
    ]);
  });

  it("routes CRM history through transformContext before Pi converts it to LLM messages", async () => {
    const { runtime } = runtimeWithFaux([fauxAssistantMessage("ok")]);
    const transformed = vi.fn(async (messages) => messages);

    await runtime.run({
      systemPrompt: "You are a CRM assistant.",
      messages: [{ role: "user", content: "previous CRM context" }],
      prompt: "continue",
      model,
      transformContext: transformed,
    });

    expect(transformed).toHaveBeenCalled();
    expect(transformed.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: "previous CRM context" })]),
    );
  });

  it("rejects before opening the provider when the caller is already aborted", async () => {
    const { runtime } = runtimeWithFaux([fauxAssistantMessage("must not run")]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      runtime.run({
        systemPrompt: "system",
        prompt: "cancel",
        model,
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});
