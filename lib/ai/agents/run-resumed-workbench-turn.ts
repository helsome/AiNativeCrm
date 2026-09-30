import { appendWorkbenchEvent } from "@/lib/ai/agents/workbench-events";
import { appendWorkbenchObservation } from "@/lib/ai/agents/workbench-state";
import { executeReversibleLeadUpdate } from "@/lib/ai/agents/reversible-lead-update";
import { workbenchToolEffect } from "@/lib/ai/agents/tool-effects";
import { executePiTurnModelCall } from "@/lib/agent-engine/agent/pi-turn-execution";
import type { RuntimeMessage } from "@/lib/agent-runtime";
import type { ToolSet } from "@/lib/agent-engine/edge/llm/run-model-call";
import { loadAgentVersionConfig } from "@/lib/agent-engine/agent/agent-config";
import { requestTurnDeps } from "@/lib/agent-engine/agent/request-deps";
import { buildMcpTurnTools } from "@/lib/agent-engine/edge/crm/mcp-tools";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import type { createAdminClient } from "@/lib/supabase/admin";
import { extractProductFinalAnswer } from "@/lib/ai/agents/final-answer";

type Admin = ReturnType<typeof createAdminClient>;

export async function runResumedWorkbenchTurn(input: {
  admin: Admin;
  organizationId: string;
  runId: string;
  jobId: string;
  agentId: string;
  versionId: string;
  task: string;
  mode: "inspect" | "act";
  scope: {
    contactId: string | null;
    leadId: string | null;
    conversationId: string | null;
    pipelineId: string | null;
    channelId: string | null;
    contact?: { name?: string; phone?: string };
  };
  messages: RuntimeMessage[];
  budget: {
    maxSteps?: number | null;
    tokenBudget?: number | null;
    costBudgetCents?: number | null;
  };
  priorFinalText: string | null;
  beforeSideEffect?: () => Promise<void>;
}): Promise<void> {
  const { admin, organizationId, runId } = input;
  const abortController = new AbortController();
  let watching = true;
  const watcher = (async () => {
    while (watching && !abortController.signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      if (!watching) break;
      const { data } = await admin
        .from("ai_workbench_runs")
        .select("status")
        .eq("organization_id", organizationId)
        .eq("id", runId)
        .maybeSingle();
      if (!data || data.status === "cancelled") abortController.abort();
    }
  })();

  try {
    const { rows: priorUsage } = await getRequestPool().query<{
      input_tokens: number | null;
      output_tokens: number | null;
      cost_cents: number | null;
    }>(
      `select c.input_tokens, c.output_tokens, c.cost_cents
       from llm_calls c
       join job_queue q on q.id = c.job_id and q.organization_id = c.organization_id
       where c.organization_id = $1 and q.payload->>'runId' = $2`,
      [organizationId, runId],
    );
    const spentTokens = priorUsage.reduce(
      (sum, row) => sum + (row.input_tokens ?? 0) + (row.output_tokens ?? 0),
      0,
    );
    const spentCost = priorUsage.reduce((sum, row) => sum + Number(row.cost_cents ?? 0), 0);
    const stepLimitReached =
      input.budget.maxSteps != null && priorUsage.length >= input.budget.maxSteps;
    const remainingTokens =
      input.budget.tokenBudget == null ? null : input.budget.tokenBudget - spentTokens;
    const remainingCost =
      input.budget.costBudgetCents == null ? null : input.budget.costBudgetCents - spentCost;
    if (
      stepLimitReached ||
      (remainingTokens != null && remainingTokens <= 0) ||
      (remainingCost != null && remainingCost <= 0)
    ) {
      await input.beforeSideEffect?.();
      await admin
        .from("ai_workbench_runs")
        .update({
          status: "partial",
          final_text: input.priorFinalText,
          completed_at: new Date().toISOString(),
          error_code: "budget_exhausted",
        })
        .eq("organization_id", organizationId)
        .eq("id", runId)
        .eq("status", "running");
      await appendWorkbenchEvent(admin, {
        organizationId,
        runId,
        type: "run_partial",
        payload: { status: "partial", pendingProposals: 0 },
      });
      await appendWorkbenchEvent(admin, {
        organizationId,
        runId,
        type: "usage_reported",
        payload: {
          inputTokens:
            spentTokens - priorUsage.reduce((sum, row) => sum + (row.output_tokens ?? 0), 0),
          outputTokens: priorUsage.reduce((sum, row) => sum + (row.output_tokens ?? 0), 0),
          costCents: spentCost,
          calls: priorUsage.length,
        },
      });
      return;
    }
    const deps = requestTurnDeps();
    const agentConfig = await loadAgentVersionConfig(
      getRequestPool(), organizationId, input.agentId, input.versionId,
    );
    if (!agentConfig) throw new Error("workbench_agent_config_missing");
    agentConfig.pipelineIds = input.scope.pipelineId ? [input.scope.pipelineId] : [];
    const mcp = await buildMcpTurnTools(
      deps.crmCfg,
      { organizationId, jobId: input.jobId },
      agentConfig,
      deps.log,
      { readOnly: input.mode === "inspect", workbenchProposalTools: true },
    );
    const proposalInputs: Array<{ tool: string; arguments: unknown }> = [];
    let toolResultCount = 0;
    const effectByTool = new Map<string, NonNullable<ReturnType<typeof workbenchToolEffect>>>();
    const gatedTools: Record<string, unknown> = {};
    for (const [name, definition] of Object.entries(mcp?.tools ?? {})) {
      const effect = workbenchToolEffect(name);
      if (!effect) continue;
      effectByTool.set(name, effect);
      const original = definition as { execute?: (args: unknown, options: unknown) => Promise<unknown> };
      if (typeof original.execute !== "function") continue;
      gatedTools[name] = {
        ...(definition as object),
        execute: async (args: unknown, options: unknown) => {
          if (effect.effect === "read") return original.execute!(args, options);
          if (input.mode === "inspect")
            return { content: "Blocked by inspect-only policy; no CRM state was changed.", isError: true };
          proposalInputs.push({ tool: name, arguments: args });
          return {
            content: effect.effect === "reversible_write"
              ? "Staged for the CRM Harness to apply with an audit diff and compensation; do not claim completion yet."
              : "Staged for human confirmation; do not perform or claim the external action.",
          };
        },
      };
    }
    const modelResult = await executePiTurnModelCall(
      { pool: getRequestPool(), llmCfg: deps.llmCfg, log: deps.log, runtime: deps.runtime },
      {
        tenantId: organizationId,
        jobId: input.jobId,
        workbenchRunId: runId,
        agentId: input.agentId,
        purpose: "agent_turn",
        model: agentConfig.model,
        llmOverride: { provider: agentConfig.provider, credentialId: agentConfig.credentialId },
        system: `${agentConfig.systemPrompt}\n\nUse CRM tools to verify facts. Follow the run mode and tool policy. Never claim a staged write or external action is complete. 最终报告不超过 2200 个中文字符；优先保留关键事实、冲突、证据缺口和可验证下一步，不复述内部分析过程。`,
        messages: [],
        runtimeMessages: input.messages,
        tools: gatedTools as ToolSet,
        maxSteps: input.budget.maxSteps ?? agentConfig.maxSteps,
        abortSignal: abortController.signal,
        shouldStopAfterTurn: ({ cumulativeUsage, costCents }) =>
          (remainingTokens != null && cumulativeUsage.totalTokens >= remainingTokens) ||
          (remainingCost != null && costCents !== null && costCents >= remainingCost),
        onEvent: async (event) => {
          await input.beforeSideEffect?.();
          const data = event.data;
          const tool = typeof data.tool_name === "string" ? data.tool_name : undefined;
          const toolCallId = typeof data.tool_call_id === "string" ? data.tool_call_id : undefined;
          if (event.type === "tool_execution_start" && tool) {
            const effect = effectByTool.get(tool);
            await appendWorkbenchEvent(admin, {
              organizationId, runId,
              type: effect?.effect === "read" ? "tool_started" : "policy_checked",
              payload: effect?.effect === "read"
                ? { tool, toolCallId }
                : { tool, decision: input.mode === "inspect" ? "blocked_inspect_only" : effect?.effect === "reversible_write" ? "allowed_reversible_write" : "requires_human_confirmation" },
            });
          } else if (event.type === "tool_execution_end") {
            toolResultCount += 1;
            await appendWorkbenchEvent(admin, {
              organizationId, runId, type: "tool_completed",
              payload: { tool, toolCallId, status: data.is_error ? "error" : "success" },
            });
          } else if (event.type === "turn_end") {
            await appendWorkbenchEvent(admin, {
              organizationId, runId, type: "model_decision", payload: { toolResultCount },
            });
          }
        },
      },
    );
    const { error: stateError } = await admin.from("ai_agent_run_states").upsert(
      { organization_id: organizationId, run_id: runId, messages: modelResult.result.runtimeMessages as never },
      { onConflict: "run_id" },
    );
    if (stateError) throw new Error("workbench_runtime_state_persist_failed");
    const extractedAnswer = extractProductFinalAnswer(modelResult.result.text);
    const answerImpediments = [
      ...(extractedAnswer.inspection.internalDraftCodes.length > 0 && !extractedAnswer.sanitized
        ? [{ code: "unsafe_internal_draft", message: "内部组织稿无法安全分离。" }]
        : []),
      ...(extractedAnswer.inspection.likelyTruncated
        ? [{ code: "answer_likely_truncated", message: "最终答案疑似被截断。" }]
        : []),
    ];
    const result = {
      proposals: proposalInputs,
      candidates: [] as Array<{ body: string; trace: Array<{ gate: string; verdict: string; code: string }> }>,
      impediments: answerImpediments as Array<{ code: string; message: string }>,
      finalText: extractedAnswer.text,
    };

    const { data: current } = await admin
      .from("ai_workbench_runs")
      .select("status")
      .eq("organization_id", organizationId)
      .eq("id", runId)
      .maybeSingle();
    if (current?.status === "cancelled") return;

    const { data: latest } = await admin
      .from("ai_agent_action_proposals")
      .select("sequence")
      .eq("organization_id", organizationId)
      .eq("run_id", runId)
      .order("sequence", { ascending: false })
      .limit(1)
      .maybeSingle();
    let sequence = latest?.sequence ?? 0;
    const newProposals: string[] = [];
    const observations: Array<{ tool: string; status: "executed"; result: unknown }> = [];
    try {
      for (const proposal of result.proposals) {
        await input.beforeSideEffect?.();
        sequence += 1;
        const { data: saved, error } = await admin
          .from("ai_agent_action_proposals")
          .insert({
            organization_id: organizationId,
            run_id: runId,
            sequence,
            tool_name: proposal.tool,
            tool_args: proposal.arguments as never,
            preview: { requiresHumanConfirmation: true },
            status: "pending",
          })
          .select("id")
          .single();
        if (error || !saved) throw new Error("action_proposal_persist_failed");
        newProposals.push(saved.id);
        await appendWorkbenchEvent(admin, {
          organizationId,
          runId,
          type: "tool_proposed",
          payload: { proposalId: saved.id, tool: proposal.tool },
        });
        const reversible =
          input.mode === "act" && proposal.tool === "crm_update_lead" && mcp
            ? await (async () => {
                await input.beforeSideEffect?.();
                return executeReversibleLeadUpdate({
                  args: proposal.arguments,
                  tools: mcp.tools as never,
                });
              })()
            : null;
        if (reversible) {
          const { error: updateError } = await admin
            .from("ai_agent_action_proposals")
            .update({
              status: "executed",
              compensation_args: reversible.compensationArgs as never,
              preview: reversible.preview as never,
              result_summary: { outcome: "executed", effect: "reversible_write" },
            })
            .eq("organization_id", organizationId)
            .eq("id", saved.id)
            .eq("status", "pending");
          if (updateError) throw new Error("action_proposal_update_failed_after_write");
          observations.push({ tool: proposal.tool, status: "executed", result: reversible.result });
          await appendWorkbenchEvent(admin, {
            organizationId,
            runId,
            type: "policy_checked",
            payload: {
              proposalId: saved.id,
              decision: "allowed_reversible_write",
              tool: proposal.tool,
            },
          });
          await appendWorkbenchEvent(admin, {
            organizationId,
            runId,
            type: "tool_completed",
            payload: { proposalId: saved.id, tool: proposal.tool, status: "success" },
          });
          await appendWorkbenchEvent(admin, {
            organizationId,
            runId,
            type: "crm_state_changed",
            payload: {
              proposalId: saved.id,
              tool: proposal.tool,
              targetId: reversible.preview.resourceUuid,
              changedFields: reversible.preview.changedFields,
            },
          });
        } else {
          await appendWorkbenchEvent(admin, {
            organizationId,
            runId,
            type: "policy_checked",
            payload: {
              proposalId: saved.id,
              decision: "requires_human_confirmation",
              tool: proposal.tool,
            },
          });
          await appendWorkbenchEvent(admin, {
            organizationId,
            runId,
            type: "human_confirmation_requested",
            payload: { proposalId: saved.id, tool: proposal.tool },
          });
        }
      }
    } finally {
      await mcp?.cleanup();
    }

    let continuationMessages = input.messages;
    if (observations.length > 0) {
      await input.beforeSideEffect?.();
      for (const observation of observations)
        continuationMessages = appendWorkbenchObservation(continuationMessages, observation);
      const { error } = await admin
        .from("ai_agent_run_states")
        .update({ messages: continuationMessages as never })
        .eq("organization_id", organizationId)
        .eq("run_id", runId);
      if (error) throw new Error("workbench_runtime_state_persist_failed");
    }

    const finalText = [
      input.priorFinalText,
      result.finalText,
      ...result.candidates.map((candidate) => candidate.body),
    ]
      .filter((value): value is string => Boolean(value))
      .join("\n\n");
    const { count: pendingCount } = await admin
      .from("ai_agent_action_proposals")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("run_id", runId)
      .eq("status", "pending");
    const exhausted = result.impediments.some(
      (item) => item.code === "token_budget_exhausted" || item.code === "cost_budget_exhausted",
    );
    const answerInvalid = result.impediments.some(
      (item) => item.code === "unsafe_internal_draft" || item.code === "answer_likely_truncated",
    );
    const emptyFinalAnswer = !finalText.trim();
    const status =
      (pendingCount ?? 0) > 0
        ? "awaiting_confirmation"
        : exhausted || answerInvalid || emptyFinalAnswer
          ? "partial"
          : "completed";
    if (observations.length > 0 && (pendingCount ?? 0) === 0 && !exhausted && !answerInvalid) {
      const lastAuto = newProposals.at(-1);
      if (lastAuto)
        await appendWorkbenchEvent(admin, {
          organizationId,
          runId,
          type: "run_resumed",
          payload: { proposalId: lastAuto },
        });
      await runResumedWorkbenchTurn({
        ...input,
        messages: continuationMessages,
        priorFinalText: finalText || input.priorFinalText,
      });
      return;
    }
    await input.beforeSideEffect?.();
    const { error: updateError } = await admin
      .from("ai_workbench_runs")
      .update({
        status,
        final_text: finalText || null,
        error_code:
          status === "partial"
            ? emptyFinalAnswer
              ? "empty_final_answer"
              : answerInvalid
                ? result.impediments.find((item) =>
                    ["unsafe_internal_draft", "answer_likely_truncated"].includes(item.code),
                  )?.code ?? null
                : null
            : null,
        runtime_state: {
          versionId: input.versionId,
          proposals: sequence,
          impediments: [
            ...result.impediments.map((item) => item.code),
            ...(emptyFinalAnswer && !exhausted ? ["empty_final_answer"] : []),
          ],
        },
        ...(status === "completed" || status === "partial"
          ? { completed_at: new Date().toISOString() }
          : {}),
      })
      .eq("organization_id", organizationId)
      .eq("id", runId)
      .eq("status", "running");
    if (updateError) throw new Error("workbench_run_update_failed");
    if (status !== "awaiting_confirmation")
      await appendWorkbenchEvent(admin, {
        organizationId,
        runId,
        type: status === "partial" ? "run_partial" : "run_completed",
        payload: {
          status,
          hasAnswer: !emptyFinalAnswer,
          ...(status === "partial"
            ? {
                reason: emptyFinalAnswer
                  ? "empty_final_answer"
                  : answerInvalid
                    ? result.impediments.find((item) =>
                        ["unsafe_internal_draft", "answer_likely_truncated"].includes(item.code),
                      )?.code
                    : "budget_exhausted",
              }
            : {}),
          proposalCount: newProposals.length,
        },
      });

    const { rows } = await getRequestPool().query<{
      input_tokens: number | null;
      output_tokens: number | null;
      cost_cents: number | null;
    }>(
      `select c.input_tokens, c.output_tokens, c.cost_cents
       from llm_calls c join job_queue q on q.id = c.job_id and q.organization_id = c.organization_id
       where c.organization_id=$1 and q.payload->>'runId'=$2`,
      [organizationId, runId],
    );
    const usage = rows.reduce(
      (sum, row) => ({
        inputTokens: sum.inputTokens + (row.input_tokens ?? 0),
        outputTokens: sum.outputTokens + (row.output_tokens ?? 0),
        costCents: sum.costCents + Number(row.cost_cents ?? 0),
        calls: sum.calls + 1,
      }),
      { inputTokens: 0, outputTokens: 0, costCents: 0, calls: 0 },
    );
    await appendWorkbenchEvent(admin, {
      organizationId,
      runId,
      type: "usage_reported",
      payload: usage,
    });
  } catch (error) {
    const { data: state } = await admin
      .from("ai_workbench_runs")
      .select("status")
      .eq("organization_id", organizationId)
      .eq("id", runId)
      .maybeSingle();
    if (state?.status !== "cancelled") {
      await input.beforeSideEffect?.();
      await admin
        .from("ai_workbench_runs")
        .update({
          status: "failed",
          error_code: "resume_failed",
          error_summary: error instanceof Error ? error.name : "runtime_error",
          completed_at: new Date().toISOString(),
        })
        .eq("organization_id", organizationId)
        .eq("id", runId)
        .eq("status", "running");
      await appendWorkbenchEvent(admin, {
        organizationId,
        runId,
        type: "run_failed",
        payload: {
          code: "resume_failed",
          errorType: error instanceof Error ? error.name : "runtime_error",
        },
      });
    }
  } finally {
    watching = false;
    await watcher;
  }
}
