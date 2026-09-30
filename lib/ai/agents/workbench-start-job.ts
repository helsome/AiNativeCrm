import type { JobRow } from "@/lib/agent-engine/queue/queue";
import type { Pool } from "pg";
import { loadAgentVersionConfig } from "@/lib/agent-engine/agent/agent-config";
import { executePiTurnModelCall } from "@/lib/agent-engine/agent/pi-turn-execution";
import { requestTurnDeps } from "@/lib/agent-engine/agent/request-deps";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { buildMcpTurnTools } from "@/lib/agent-engine/edge/crm/mcp-tools";
import type { ToolSet } from "@/lib/agent-engine/edge/llm/run-model-call";
import { appendWorkbenchEvent } from "@/lib/ai/agents/workbench-events";
import { appendWorkbenchObservation, parseRuntimeMessages } from "@/lib/ai/agents/workbench-state";
import { executeReversibleLeadUpdate } from "@/lib/ai/agents/reversible-lead-update";
import { workbenchToolEffect } from "@/lib/ai/agents/tool-effects";
import { resolveWorkbenchScope } from "@/lib/ai/agents/workbench-scope";
import { runResumedWorkbenchTurn } from "@/lib/ai/agents/run-resumed-workbench-turn";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertWorkbenchJobLease } from "@/lib/ai/agents/workbench-job-lease";
import { selectCollaborationPlan } from "@/lib/ai/agents/collaboration";
import { formatCollaborationContext } from "@/lib/ai/agents/collaboration-runtime";
import { runWorkbenchCollaboration } from "@/lib/ai/agents/workbench-collaboration";
import { extractProductFinalAnswer } from "@/lib/ai/agents/final-answer";

/** Execute a start run from durable CRM state; retries resume the saved Pi messages. */
export async function runWorkbenchStartJob(
  job: JobRow,
  pool: Pool,
  workerId: string,
): Promise<void> {
  const runId = job.payload.runId;
  if (typeof runId !== "string") throw new Error("workbench_start_run_id_missing");
  const admin = createAdminClient();
  const { data: run, error } = await admin
    .from("ai_workbench_runs")
    .select("id, agent_id, actor_user_id, task, mode, status, runtime_state, scope, budget")
    .eq("organization_id", job.organization_id)
    .eq("id", runId)
    .maybeSingle();
  if (error) throw new Error("workbench_start_run_read_failed");
  if (!run || run.status === "cancelled") return;
  if (run.status !== "queued" && run.status !== "running") return;
  const beforeSideEffect = () => assertWorkbenchJobLease(pool, job, workerId);
  await beforeSideEffect();

  const runtime = run.runtime_state as {
    versionId?: unknown;
    agentOperationRevision?: unknown;
    replyContextRevision?: unknown;
    phase?: unknown;
    collaborationMode?: unknown;
  };
  if (typeof runtime.versionId !== "string") throw new Error("workbench_start_version_missing");
  if (run.status === "queued") {
    await beforeSideEffect();
    const { data: claimed, error: claimError } = await admin
      .from("ai_workbench_runs")
      .update({ status: "running", started_at: new Date().toISOString() })
      .eq("organization_id", job.organization_id)
      .eq("id", runId)
      .eq("status", "queued")
      .select("id")
      .maybeSingle();
    if (claimError) throw new Error("workbench_start_claim_failed");
    if (!claimed) return;
  }

  const scopeInput =
    run.scope && typeof run.scope === "object" ? (run.scope as Record<string, unknown>) : {};
  const scope = await resolveWorkbenchScope(admin, job.organization_id, {
    ...(typeof scopeInput.contactId === "string" ? { contactId: scopeInput.contactId } : {}),
    ...(typeof scopeInput.leadId === "string" ? { leadId: scopeInput.leadId } : {}),
    ...(typeof scopeInput.conversationId === "string"
      ? { conversationId: scopeInput.conversationId }
      : {}),
    ...(typeof scopeInput.pipelineId === "string" ? { pipelineId: scopeInput.pipelineId } : {}),
  });
  const { data: savedState, error: stateReadError } = await admin
    .from("ai_agent_run_states")
    .select("messages")
    .eq("organization_id", job.organization_id)
    .eq("run_id", runId)
    .maybeSingle();
  if (stateReadError) throw new Error("workbench_start_state_read_failed");
  const resumeMessages = savedState ? parseRuntimeMessages(savedState.messages) : null;
  if (savedState && !resumeMessages) throw new Error("workbench_start_state_corrupt");

  await beforeSideEffect();
  await appendWorkbenchEvent(admin, {
    organizationId: job.organization_id,
    runId,
    type: "context_loaded",
    payload: {
      contactId: scope.contactId,
      leadId: scope.leadId,
      conversationId: scope.conversationId,
      pipelineId: scope.pipelineId,
    },
  });

  const budget =
    run.budget && typeof run.budget === "object"
      ? (run.budget as {
          maxSteps?: number | null;
          tokenBudget?: number | null;
          costBudgetCents?: number | null;
        })
      : {};
  if (runtime.phase === "resume" && resumeMessages) {
    await runResumedWorkbenchTurn({
      admin,
      organizationId: job.organization_id,
      runId,
      jobId: job.id,
      agentId: run.agent_id,
      versionId: runtime.versionId,
      task: run.task,
      mode: run.mode as "inspect" | "act",
      scope,
      messages: resumeMessages,
      budget,
      priorFinalText: null,
      beforeSideEffect,
    });
    return;
  }
  const { data: priorProposals, error: proposalsReadError } = await admin
    .from("ai_agent_action_proposals")
    .select("id,status,tool_name,tool_args")
    .eq("organization_id", job.organization_id)
    .eq("run_id", runId);
  if (proposalsReadError) throw new Error("workbench_start_proposals_read_failed");
  if (priorProposals?.length) {
    for (const proposal of priorProposals) {
      if (proposal.status !== "pending" || proposal.tool_name !== "send_message") continue;
      const { data: draft, error: draftReadError } = await admin
        .from("ai_reply_drafts")
        .select("id")
        .eq("organization_id", job.organization_id)
        .eq("workbench_run_id", runId)
        .eq("workbench_proposal_id", proposal.id)
        .maybeSingle();
      if (draftReadError) throw new Error("workbench_reply_recovery_read_failed");
      if (draft) continue;
      const args = proposal.tool_args as { body?: unknown };
      if (
        typeof args?.body !== "string" ||
        typeof runtime.agentOperationRevision !== "number" ||
        typeof runtime.replyContextRevision !== "number"
      )
        throw new Error("workbench_reply_recovery_state_invalid");
      const { rows } = await getRequestPool().query<{ draft_id: string }>(
        "select public.fn_reply_workbench_stage($1,$2,$3,$4,$5,$6,$7) as draft_id",
        [
          job.organization_id,
          runId,
          proposal.id,
          runtime.versionId,
          runtime.replyContextRevision,
          runtime.agentOperationRevision,
          args.body,
        ],
      );
      if (!rows[0]?.draft_id) throw new Error("workbench_reply_recovery_failed");
    }
    const uncertainAutoWrite = priorProposals.some(
      (proposal) => proposal.status === "pending" && proposal.tool_name === "crm_update_lead",
    );
    const hasPending = priorProposals.some((proposal) => proposal.status === "pending");
    if (uncertainAutoWrite) {
      await beforeSideEffect();
      const { error: proposalRecoveryError } = await admin
        .from("ai_agent_action_proposals")
        .update({
          status: "failed",
          result_summary: { outcome: "reconciliation_required", code: "write_may_have_completed" },
        })
        .eq("organization_id", job.organization_id)
        .eq("run_id", runId)
        .eq("status", "pending");
      if (proposalRecoveryError) throw new Error("workbench_write_recovery_failed");
    }
    const status = hasPending && !uncertainAutoWrite ? "awaiting_confirmation" : "partial";
    await beforeSideEffect();
    const { error: reconcileError } = await admin
      .from("ai_workbench_runs")
      .update({
        status,
        ...(status === "awaiting_confirmation"
          ? {}
          : {
              error_code: "proposal_reconciliation_required",
              completed_at: new Date().toISOString(),
            }),
      })
      .eq("organization_id", job.organization_id)
      .eq("id", runId)
      .eq("status", "running");
    if (reconcileError) throw new Error("workbench_start_reconcile_failed");
    if (status === "partial")
      await appendWorkbenchEvent(admin, {
        organizationId: job.organization_id,
        runId,
        type: "run_partial",
        payload: {
          status: "partial",
          reason: uncertainAutoWrite
            ? "write_may_have_completed"
            : "proposal_reconciliation_required",
        },
      });
    return;
  }
  const deps = requestTurnDeps();
  const abortController = new AbortController();
  let watching = true;
  const watcher = (async () => {
    while (watching && !abortController.signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      if (!watching) break;
      const { data } = await admin
        .from("ai_workbench_runs")
        .select("status")
        .eq("organization_id", job.organization_id)
        .eq("id", runId)
        .maybeSingle();
      if (!data || data.status === "cancelled") abortController.abort();
    }
  })();
  let workbenchMcp: Awaited<ReturnType<typeof buildMcpTurnTools>> = null;

  try {
    await beforeSideEffect();
    const modelAgentConfig = await loadAgentVersionConfig(
      getRequestPool(), job.organization_id, run.agent_id, runtime.versionId,
    );
    if (!modelAgentConfig) throw new Error("workbench_agent_config_missing");
    modelAgentConfig.pipelineIds = scope.pipelineId ? [scope.pipelineId] : [];
    const { data: agentMetadata, error: agentMetadataError } = await admin
      .from("ai_agents")
      .select("builtin_key")
      .eq("organization_id", job.organization_id)
      .eq("id", run.agent_id)
      .maybeSingle();
    if (agentMetadataError) throw new Error("workbench_agent_metadata_read_failed");
    const collaborationPlan = selectCollaborationPlan({
      builtinKey: agentMetadata?.builtin_key,
      leadId: scope.leadId,
      disabled: runtime.collaborationMode === "disabled",
    });
    const collaboration = collaborationPlan
      ? await runWorkbenchCollaboration({
          admin,
          deps,
          plan: collaborationPlan,
          root: {
            organizationId: job.organization_id,
            parentRunId: runId,
            rootJobId: job.id,
            agentId: run.agent_id,
            actorUserId: run.actor_user_id,
            task: run.task,
            scope: {
              contactId: scope.contactId,
              leadId: scope.leadId,
              conversationId: scope.conversationId,
              pipelineId: scope.pipelineId,
            },
            budget,
          },
          agentConfig: modelAgentConfig,
          signal: abortController.signal,
        })
      : null;
    workbenchMcp = await buildMcpTurnTools(
      deps.crmCfg,
      { organizationId: job.organization_id, jobId: runId },
      modelAgentConfig,
      deps.log,
      { readOnly: run.mode === "inspect", workbenchProposalTools: true },
    );
    const proposalInputs: Array<{ tool: string; arguments: unknown }> = [];
    let toolResultCount = 0;
    const effectByTool = new Map<string, NonNullable<ReturnType<typeof workbenchToolEffect>>>();
    const gatedTools: Record<string, unknown> = {};
    for (const [name, definition] of Object.entries(workbenchMcp?.tools ?? {})) {
      const effect = workbenchToolEffect(name);
      if (!effect) continue; // Unknown effects fail closed and are never exposed to Pi.
      effectByTool.set(name, effect);
      const original = definition as {
        execute?: (args: unknown, options: unknown) => Promise<unknown>;
      };
      if (typeof original.execute !== "function") continue;
      gatedTools[name] = {
        ...(definition as object),
        execute: async (args: unknown, options: unknown) => {
          if (effect.effect === "read") return original.execute!(args, options);
          if (run.mode === "inspect") {
            return { content: "Blocked by inspect-only policy; no CRM state was changed.", isError: true };
          }
          proposalInputs.push({ tool: name, arguments: args });
          return {
            content: effect.effect === "reversible_write"
              ? "Staged for the CRM Harness to apply with an audit diff and compensation; do not claim completion yet."
              : "Staged for human confirmation; do not perform or claim the external action.",
          };
        },
      };
    }
    const selectedScopeLines = [
      scope.contactId ? `contact_id: ${scope.contactId}` : null,
      scope.leadId ? `lead_id: ${scope.leadId}` : null,
      scope.conversationId ? `conversation_id: ${scope.conversationId}` : null,
      scope.pipelineId ? `pipeline_id: ${scope.pipelineId}` : null,
    ].filter((value): value is string => value !== null);
    let taskWithScope = selectedScopeLines.length
      ? `${run.task}\n\n已校验的当前 CRM 目标范围（由工作台选择；请先用只读工具读取这些精确对象，不要猜选其他记录）：\n${selectedScopeLines.join("\n")}`
      : run.task;
    if (collaboration) taskWithScope += formatCollaborationContext(collaboration);
    const remainingMaxSteps = Math.max(
      1,
      (budget.maxSteps ?? modelAgentConfig.maxSteps) - (collaboration?.usage.modelTurns ?? 0),
    );
    const remainingTokenBudget =
      typeof budget.tokenBudget === "number"
        ? budget.tokenBudget -
          (collaboration?.usage.inputTokens ?? 0) -
          (collaboration?.usage.outputTokens ?? 0)
        : null;
    const remainingCostBudget =
      typeof budget.costBudgetCents === "number" && collaboration?.usage.costCents !== null
        ? budget.costBudgetCents - (collaboration?.usage.costCents ?? 0)
        : budget.costBudgetCents ?? null;
    if (
      (remainingTokenBudget !== null && remainingTokenBudget <= 0) ||
      (remainingCostBudget !== null && remainingCostBudget <= 0)
    ) {
      const finalText = collaboration
        ? formatCollaborationContext(collaboration).trim()
        : "运行预算在父 Agent 汇总前已耗尽。";
      await beforeSideEffect();
      await admin
        .from("ai_workbench_runs")
        .update({
          status: "partial",
          final_text: finalText,
          error_code: "collaboration_budget_exhausted",
          completed_at: new Date().toISOString(),
        })
        .eq("organization_id", job.organization_id)
        .eq("id", runId)
        .eq("status", "running");
      await appendWorkbenchEvent(admin, {
        organizationId: job.organization_id,
        runId,
        type: "run_partial",
        payload: { status: "partial", pendingProposals: 0 },
      });
      await appendWorkbenchEvent(admin, {
        organizationId: job.organization_id,
        runId,
        type: "usage_reported",
        payload: {
          inputTokens: collaboration?.usage.inputTokens ?? 0,
          outputTokens: collaboration?.usage.outputTokens ?? 0,
          costCents: collaboration?.usage.costCents ?? null,
          calls: collaboration?.results.length ?? 0,
        },
      });
      return;
    }
    const modelResult = await executePiTurnModelCall(
      { pool: getRequestPool(), llmCfg: deps.llmCfg, log: deps.log, runtime: deps.runtime },
      {
        tenantId: job.organization_id,
        jobId: job.id,
        workbenchRunId: runId,
        agentId: run.agent_id,
        purpose: "agent_turn",
        model: modelAgentConfig.model,
        llmOverride: { provider: modelAgentConfig.provider, credentialId: modelAgentConfig.credentialId },
        system: `${modelAgentConfig.systemPrompt}\n\nUse CRM tools to verify facts. Follow the run mode and tool policy. Never claim a staged write or external action is complete. 最终报告不超过 2200 个中文字符；优先保留关键事实、冲突、证据缺口和可验证下一步，不复述内部分析过程。`,
        messages: resumeMessages ? [] : [{ role: "user", content: taskWithScope }],
        ...(resumeMessages ? { runtimeMessages: resumeMessages as never } : {}),
        tools: gatedTools as ToolSet,
        maxSteps: remainingMaxSteps,
        abortSignal: abortController.signal,
        shouldStopAfterTurn: ({ cumulativeUsage, costCents }) =>
          (remainingTokenBudget !== null && cumulativeUsage.totalTokens >= remainingTokenBudget) ||
          (remainingCostBudget !== null && costCents !== null && costCents >= remainingCostBudget),
        onEvent: async (event) => {
        await beforeSideEffect();
        const data = event.data;
        const tool = typeof data.tool_name === "string" ? data.tool_name : undefined;
        const toolCallId = typeof data.tool_call_id === "string" ? data.tool_call_id : undefined;
        if (event.type === "tool_execution_start" && tool) {
          const effect = effectByTool.get(tool);
          await appendWorkbenchEvent(admin, {
            organizationId: job.organization_id,
            runId,
            type: effect?.effect === "read" ? "tool_started" : "policy_checked",
            payload: effect?.effect === "read"
              ? { tool, toolCallId }
              : { tool, decision: run.mode === "inspect" ? "blocked_inspect_only" : effect?.effect === "reversible_write" ? "allowed_reversible_write" : "requires_human_confirmation" },
          });
        } else if (event.type === "tool_execution_end") {
          toolResultCount += 1;
          await appendWorkbenchEvent(admin, {
            organizationId: job.organization_id,
            runId,
            type: "tool_completed",
            payload: { tool, toolCallId, status: data.is_error ? "error" : "success" },
          });
        } else if (event.type === "turn_end")
          await appendWorkbenchEvent(admin, {
            organizationId: job.organization_id,
            runId,
            type: "model_decision",
            payload: { toolResultCount },
          });
      },
      },
    );
    const { error: persistError } = await admin.from("ai_agent_run_states").upsert(
      { organization_id: job.organization_id, run_id: runId, messages: modelResult.result.runtimeMessages as never },
      { onConflict: "run_id" },
    );
    if (persistError) throw new Error("workbench_runtime_state_persist_failed");
    const finalAnswer = extractProductFinalAnswer(modelResult.result.text);
    const answerImpediments = [
      ...(finalAnswer.inspection.internalDraftCodes.length > 0 && !finalAnswer.sanitized
        ? [{ code: "unsafe_internal_draft", message: "内部组织稿无法安全分离。" }]
        : []),
      ...(finalAnswer.inspection.likelyTruncated
        ? [{ code: "answer_likely_truncated", message: "最终答案疑似被截断。" }]
        : []),
    ];
    const result = {
      proposals: proposalInputs,
      candidates: [] as Array<{ body: string; trace: Array<{ gate: string; verdict: string; code: string }> }>,
      impediments: answerImpediments as Array<{ code: string; message: string }>,
      finalText: finalAnswer.text,
    };

    const { data: latestRun } = await admin
      .from("ai_workbench_runs")
      .select("status")
      .eq("organization_id", job.organization_id)
      .eq("id", runId)
      .maybeSingle();
    if (latestRun?.status === "cancelled") return;
    await beforeSideEffect();

    await appendWorkbenchEvent(admin, {
      organizationId: job.organization_id,
      runId,
      type: "model_decision",
      payload: {
        proposedToolCount:
          result.proposals.length +
          (run.mode === "act" && scope.conversationId ? result.candidates.length : 0),
        candidateReplyCount: result.candidates.length,
        impedimentCount: result.impediments.length,
      },
    });
    for (const candidate of result.candidates) {
      for (const gate of candidate.trace) {
        await appendWorkbenchEvent(admin, {
          organizationId: job.organization_id,
          runId,
          type: "policy_checked",
          payload: {
            decision: gate.verdict,
            tool: "send_message",
            gate: gate.gate,
            verdict: gate.verdict,
            code: gate.code,
          },
        });
      }
    }

    const sendProposals =
      run.mode === "act" && scope.conversationId
        ? result.candidates.map((candidate) => ({
            tool: "send_message",
            arguments: { body: candidate.body.trim() },
          }))
        : [];
    const proposals = [...result.proposals, ...sendProposals];
    const baseConfig =
      run.mode === "act"
        ? await loadAgentVersionConfig(
            getRequestPool(),
            job.organization_id,
            run.agent_id,
            runtime.versionId,
          )
        : null;
    const agentConfig = baseConfig
      ? { ...baseConfig, pipelineIds: scope.pipelineId ? [scope.pipelineId] : [] }
      : null;
    const mcp = agentConfig
      ? await buildMcpTurnTools(
          deps.crmCfg,
          { organizationId: job.organization_id, jobId: runId },
          agentConfig,
          deps.log,
        )
      : null;
    const proposalRows: Array<{ id: string; tool: string; status: "pending" | "executed" }> = [];
    const observations: Array<{ tool: string; status: "executed"; result: unknown }> = [];
    let lastSequence = 0;
    try {
      const { data: prior } = await admin
        .from("ai_agent_action_proposals")
        .select("sequence")
        .eq("organization_id", job.organization_id)
        .eq("run_id", runId)
        .order("sequence", { ascending: false })
        .limit(1)
        .maybeSingle();
      lastSequence = prior?.sequence ?? 0;
      for (const proposal of proposals) {
        await beforeSideEffect();
        const sequence = ++lastSequence;
        const { data: saved, error: proposalError } = await admin
          .from("ai_agent_action_proposals")
          .upsert(
            {
              organization_id: job.organization_id,
              run_id: runId,
              sequence,
              tool_name: proposal.tool,
              tool_args: proposal.arguments as never,
              preview: {
                requiresHumanConfirmation: true,
                ...(proposal.tool === "send_message" ? { externalEffect: "customer_message" } : {}),
              },
              status: "pending",
            },
            { onConflict: "run_id,sequence", ignoreDuplicates: true },
          )
          .select("id,status,tool_name")
          .maybeSingle();
        if (proposalError) throw new Error("action_proposal_persist_failed");
        const existing =
          saved ??
          (
            await admin
              .from("ai_agent_action_proposals")
              .select("id,status,tool_name")
              .eq("organization_id", job.organization_id)
              .eq("run_id", runId)
              .eq("sequence", sequence)
              .maybeSingle()
          ).data;
        if (!existing) throw new Error("action_proposal_missing_after_upsert");
        proposalRows.push({
          id: existing.id,
          tool: existing.tool_name,
          status: existing.status === "executed" ? "executed" : "pending",
        });
        if (saved) {
          await appendWorkbenchEvent(admin, {
            organizationId: job.organization_id,
            runId,
            type: "tool_proposed",
            payload: { proposalId: saved.id, tool: proposal.tool },
          });
          if (proposal.tool === "send_message") {
            await beforeSideEffect();
            if (!scope.conversationId || !scope.replyContextRevision)
              throw new Error("workbench_send_requires_scoped_conversation");
            const { rows } = await getRequestPool().query<{ draft_id: string }>(
              "select public.fn_reply_workbench_stage($1,$2,$3,$4,$5,$6,$7) as draft_id",
              [
                job.organization_id,
                runId,
                saved.id,
                runtime.versionId,
                scope.replyContextRevision,
                Number(runtime.agentOperationRevision),
                (proposal.arguments as { body: string }).body,
              ],
            );
            if (!rows[0]?.draft_id) throw new Error("workbench_reply_stage_failed");
          }
          let reversible: Awaited<ReturnType<typeof executeReversibleLeadUpdate>> = null;
          if (run.mode === "act" && proposal.tool === "crm_update_lead" && mcp) {
            await appendWorkbenchEvent(admin, {
              organizationId: job.organization_id,
              runId,
              type: "policy_checked",
              payload: {
                proposalId: saved.id,
                decision: "allowed_reversible_write",
                tool: proposal.tool,
              },
            });
            await appendWorkbenchEvent(admin, {
              organizationId: job.organization_id,
              runId,
              type: "tool_started",
              payload: { proposalId: saved.id, tool: proposal.tool },
            });
            await beforeSideEffect();
            reversible = await executeReversibleLeadUpdate({
              args: proposal.arguments,
              tools: mcp.tools as never,
            });
          }
          if (reversible) {
            const { error: updateError } = await admin
              .from("ai_agent_action_proposals")
              .update({
                status: "executed",
                compensation_args: reversible.compensationArgs as never,
                preview: reversible.preview as never,
                result_summary: { outcome: "executed", effect: "reversible_write" },
              })
              .eq("organization_id", job.organization_id)
              .eq("id", saved.id)
              .eq("status", "pending");
            if (updateError) throw new Error("action_proposal_update_failed_after_write");
            proposalRows[proposalRows.length - 1]!.status = "executed";
            observations.push({
              tool: proposal.tool,
              status: "executed",
              result: reversible.result,
            });
            await appendWorkbenchEvent(admin, {
              organizationId: job.organization_id,
              runId,
              type: "tool_completed",
              payload: { proposalId: saved.id, tool: proposal.tool, status: "success" },
            });
            await appendWorkbenchEvent(admin, {
              organizationId: job.organization_id,
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
              organizationId: job.organization_id,
              runId,
              type: "policy_checked",
              payload: {
                proposalId: saved.id,
                decision: "requires_human_confirmation",
                tool: proposal.tool,
              },
            });
            await appendWorkbenchEvent(admin, {
              organizationId: job.organization_id,
              runId,
              type: "human_confirmation_requested",
              payload: { proposalId: saved.id, tool: proposal.tool },
            });
          }
        }
      }
    } finally {
      await mcp?.cleanup();
    }

    let finalText = result.finalText || result.candidates
      .map((candidate) => candidate.body)
      .filter(Boolean)
      .join("\n\n");
    if (observations.length) {
      await beforeSideEffect();
      const { data: state } = await admin
        .from("ai_agent_run_states")
        .select("messages")
        .eq("organization_id", job.organization_id)
        .eq("run_id", runId)
        .maybeSingle();
      let messages = parseRuntimeMessages(state?.messages);
      if (!messages) throw new Error("workbench_runtime_state_missing_after_write");
      for (const observation of observations)
        messages = appendWorkbenchObservation(messages, observation);
      const { error: stateUpdateError } = await admin
        .from("ai_agent_run_states")
        .update({ messages: messages as never })
        .eq("organization_id", job.organization_id)
        .eq("run_id", runId);
      if (stateUpdateError) throw new Error("workbench_runtime_state_persist_failed");
      const pending = proposalRows.some((proposal) => proposal.status === "pending");
      if (
        !pending &&
        !result.impediments.some(
          (item) => item.code === "token_budget_exhausted" || item.code === "cost_budget_exhausted",
        )
      ) {
        await beforeSideEffect();
        const { error: phaseError } = await admin
          .from("ai_workbench_runs")
          .update({ runtime_state: { ...runtime, phase: "resume" } })
          .eq("organization_id", job.organization_id)
          .eq("id", runId)
          .eq("status", "running");
        if (phaseError) throw new Error("workbench_resume_phase_persist_failed");
        await appendWorkbenchEvent(admin, {
          organizationId: job.organization_id,
          runId,
          type: "run_resumed",
          payload: { afterAutomaticWrites: observations.length },
        });
        await runResumedWorkbenchTurn({
          admin,
          organizationId: job.organization_id,
          runId,
          jobId: job.id,
          agentId: run.agent_id,
          versionId: runtime.versionId,
          task: run.task,
          mode: "act",
          scope,
          messages,
          budget,
          priorFinalText: finalText || null,
          beforeSideEffect,
        });
        return;
      }
    }
    if (proposalRows.some((proposal) => proposal.tool === "send_message"))
      finalText = "Agent 回复草稿已保存在 CRM，尚未发送。批准后将进入正式发送队列。";
    const pending = proposalRows.some((proposal) => proposal.status === "pending");
    const exhausted = result.impediments.some(
      (item) => item.code === "token_budget_exhausted" || item.code === "cost_budget_exhausted",
    );
    const answerInvalid = result.impediments.some(
      (item) => item.code === "unsafe_internal_draft" || item.code === "answer_likely_truncated",
    );
    const emptyFinalAnswer = !finalText.trim();
    const status = pending
      ? "awaiting_confirmation"
      : exhausted || answerInvalid || emptyFinalAnswer
        ? "partial"
        : "completed";
    await beforeSideEffect();
    const { error: closeError } = await admin
      .from("ai_workbench_runs")
      .update({
        status,
        final_text: finalText || null,
        runtime_state: {
          ...runtime,
          proposals: lastSequence,
          impediments: [
            ...result.impediments.map((item) => item.code),
            ...(emptyFinalAnswer && !exhausted ? ["empty_final_answer"] : []),
          ],
        },
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
        ...(pending ? {} : { completed_at: new Date().toISOString() }),
      })
      .eq("organization_id", job.organization_id)
      .eq("id", runId)
      .in("status", ["queued", "running"]);
    if (closeError) throw new Error("workbench_run_update_failed");
    if (!pending)
      await appendWorkbenchEvent(admin, {
        organizationId: job.organization_id,
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
          proposalCount: proposalRows.length,
        },
      });
    const { rows: usageRows } = await getRequestPool().query<{
      input_tokens: number | null;
      output_tokens: number | null;
      cost_cents: number | null;
    }>(
      "select input_tokens, output_tokens, cost_cents from llm_calls where organization_id=$1 and job_id=$2",
      [job.organization_id, job.id],
    );
    const usage = usageRows.reduce(
      (sum, row) => ({
        inputTokens: sum.inputTokens + (row.input_tokens ?? 0),
        outputTokens: sum.outputTokens + (row.output_tokens ?? 0),
        costCents: sum.costCents + Number(row.cost_cents ?? 0),
        calls: sum.calls + 1,
      }),
      { inputTokens: 0, outputTokens: 0, costCents: 0, calls: 0 },
    );
    await appendWorkbenchEvent(admin, {
      organizationId: job.organization_id,
      runId,
      type: "usage_reported",
      payload: usage,
    });
  } catch (error) {
    const { data: latest } = await admin
      .from("ai_workbench_runs")
      .select("status")
      .eq("organization_id", job.organization_id)
      .eq("id", runId)
      .maybeSingle();
    if (latest?.status === "cancelled") return;
    if (job.attempts >= job.max_attempts) {
      await beforeSideEffect();
      const reason = error instanceof Error ? error.name : "runtime_error";
      await admin
        .from("ai_workbench_runs")
        .update({
          status: "failed",
          error_code: "runtime_failed",
          error_summary: reason,
          completed_at: new Date().toISOString(),
        })
        .eq("organization_id", job.organization_id)
        .eq("id", runId)
        .in("status", ["queued", "running"]);
      await appendWorkbenchEvent(admin, {
        organizationId: job.organization_id,
        runId,
        type: "run_failed",
        payload: { code: "runtime_failed", errorType: reason },
      });
      return;
    }
    throw error;
  } finally {
    watching = false;
    await workbenchMcp?.cleanup();
    await watcher;
  }
}
