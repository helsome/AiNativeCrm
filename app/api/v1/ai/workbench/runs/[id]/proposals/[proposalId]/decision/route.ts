import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { appendWorkbenchEvent } from "@/lib/ai/agents/workbench-events";
import { appendWorkbenchObservation, parseRuntimeMessages } from "@/lib/ai/agents/workbench-state";
import { resolveWorkbenchScope } from "@/lib/ai/agents/workbench-scope";
import { executeReversibleLeadUpdate } from "@/lib/ai/agents/reversible-lead-update";
import { workbenchToolEffect } from "@/lib/ai/agents/tool-effects";
import { validateWorkbenchToolArgs } from "@/lib/ai/agents/validate-workbench-tool-args";
import { requestTurnDeps } from "@/lib/agent-engine/agent/request-deps";
import { loadAgentVersionConfig } from "@/lib/agent-engine/agent/agent-config";
import { buildMcpTurnTools } from "@/lib/agent-engine/edge/crm/mcp-tools";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { enqueueJob } from "@/lib/agent-engine/queue/queue";
import { VALID_TOOL_IDS } from "@/lib/mcp/tools/catalog";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { ASK_INTERNAL_COLLEAGUE_TOOL } from "@/lib/ai/agents/internal-question-contract";
import {
  approveProposedFeishuQuestion, InternalQuestionError,
} from "@/lib/ai/internal-collaboration/feishu-question";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const decisionSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    reason: z.string().trim().max(1000).optional(),
  })
  .strict();
type RouteCtx = { params: Promise<{ id: string; proposalId: string }> };

/** Record one human decision, then continue the persisted Pi conversation. */
export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id, proposalId } = await ctx.params;
  if (!UUID_RX.test(id) || !UUID_RX.test(proposalId))
    return fail("invalid_request", "run/proposal id 无效。", 400, { requestId });
  const authz = await requireRole("manager", { requestId, resource: "ai_workbench" });
  if (!authz.ok) return authz.response;
  const supportDenied = await requireSupportWrite(authz.org.orgId);
  if (supportDenied) return supportDenied;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", "请求体必须是 JSON。", 400, { requestId });
  }
  const parsed = decisionSchema.safeParse(raw);
  if (!parsed.success)
    return fail("validation_failed", "决策参数无效。", 422, {
      requestId,
      details: parsed.error.flatten(),
    });

  const admin = createAdminClient();
  const { data: run } = await admin
    .from("ai_workbench_runs")
    .select(
      "id, agent_id, mission_id, actor_user_id, task, mode, status, runtime_state, final_text, scope, budget",
    )
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!run) return fail("not_found", "run 不存在。", 404, { requestId });
  if (run.status !== "awaiting_confirmation")
    return fail("state_conflict", "run 当前不等待确认。", 409, { requestId });
  const { data: proposal } = await admin
    .from("ai_agent_action_proposals")
    .select("id, sequence, tool_name, tool_args, status")
    .eq("organization_id", authz.org.orgId)
    .eq("run_id", id)
    .eq("id", proposalId)
    .maybeSingle();
  if (!proposal) return fail("not_found", "待确认动作不存在。", 404, { requestId });
  if (proposal.status !== "pending")
    return fail("state_conflict", "这个动作已经处理过。", 409, { requestId });
  if (parsed.data.decision === "approve" && run.mode !== "act")
    return fail("inspect_read_only", "只读检查运行不能批准或执行 CRM 写入。", 409, { requestId });
  if (parsed.data.decision === "approve" && !workbenchToolEffect(proposal.tool_name))
    return fail("tool_effect_unclassified", "此工具没有安全效果分类，操作保持未执行。", 409, {
      requestId,
    });
  const validatedArgs = validateWorkbenchToolArgs(proposal.tool_name, proposal.tool_args);
  if (parsed.data.decision === "approve" && !validatedArgs.ok)
    return fail(
      "proposal_arguments_invalid",
      "提案参数未通过 CRM 工具校验；操作保持未执行。",
      409,
      { requestId },
    );

  if (proposal.tool_name === ASK_INTERNAL_COLLEAGUE_TOOL && parsed.data.decision === "approve") {
    if (!run.mission_id)
      return fail("state_conflict", "此提案没有关联商机任务，不能发送内部问题。", 409, { requestId });
    try {
      let result: Awaited<ReturnType<typeof approveProposedFeishuQuestion>> | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          result = await approveProposedFeishuQuestion(getRequestPool(), {
            organizationId: authz.org.orgId,
            missionId: run.mission_id,
            runId: id,
            proposalId,
            approverUserId: authz.user.id,
            reason: parsed.data.reason,
          });
          break;
        } catch (error) {
          const pgCode = error && typeof error === "object" && "code" in error
            ? error.code : null;
          // A worker may append its final usage event just as approval reads
          // the next sequence. Roll back the whole transaction and retry;
          // never replay only the outbox insertion.
          if (attempt === 2 || !["23505", "40P01", "40001"].includes(String(pgCode)))
            throw error;
        }
      }
      if (!result) throw new Error("internal_question_approval_unavailable");
      void audit({
        action: "ai_workbench.action_approved",
        actorUserId: authz.user.id,
        organizationId: authz.org.orgId,
        resourceType: "ai_agent_action_proposal",
        resourceId: proposalId,
        requestId,
        metadata: { run_id: id, tool: ASK_INTERNAL_COLLEAGUE_TOOL,
          question_id: result.questionId, delivery: "queued" },
      });
      return ok({ proposal_id: proposalId, status: "executed", run_status: "completed",
        question_id: result.questionId, delivery: "queued" }, { requestId });
    } catch (error) {
      if (error instanceof InternalQuestionError) {
        const code = error.code;
        const unavailable = code === "channel_unavailable" || code === "recipient_unavailable";
        return fail(code, unavailable
          ? "飞书渠道或收件人目前不可用；没有创建发送任务。"
          : "任务、Agent 或提案状态已变化；没有创建发送任务。",
        unavailable ? 503 : 409, { requestId });
      }
      return fail("internal_error", "无法安全保存内部提问；没有创建发送任务。", 500,
        { requestId });
    }
  }

  // Compare-and-set the run to serialize approvals and prevent duplicate writes
  // when two browser tabs decide at the same time.
  const { data: claimed } = await admin
    .from("ai_workbench_runs")
    .update({ status: "running" })
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .eq("status", "awaiting_confirmation")
    .select("id")
    .maybeSingle();
  if (!claimed)
    return fail("state_conflict", "另一个决策正在处理，请刷新运行详情。", 409, { requestId });

  if (parsed.data.decision === "approve" && run.mission_id) {
    const { data: mission, error: missionError } = await admin.from("ai_missions")
      .select("status")
      .eq("organization_id", authz.org.orgId)
      .eq("id", run.mission_id)
      .maybeSingle();
    if (missionError || !mission || ["cancelled", "completed"].includes(mission.status)) {
      await restoreAwaitingConfirmation(admin, authz.org.orgId, id);
      return fail("mission_not_active", "业务任务已停止，不能再批准关联动作。", 409, { requestId });
    }
  }

  const decidedAt = new Date().toISOString();
  const decision = parsed.data.decision;
  if (
    decision === "approve" &&
    proposal.tool_name !== "send_message" &&
    !VALID_TOOL_IDS.includes(proposal.tool_name as never)
  ) {
    await restoreAwaitingConfirmation(admin, authz.org.orgId, id);
    return fail("tool_not_allowed", "提议工具不在当前 CRM 工具目录中。", 409, { requestId });
  }

  let observation: { tool: string; status: "executed" | "rejected" | "failed"; result?: unknown };
  if (proposal.tool_name === "send_message") {
    const { data: draft } = await admin
      .from("ai_reply_drafts")
      .select("id, revision, original_body")
      .eq("organization_id", authz.org.orgId)
      .eq("workbench_run_id", id)
      .eq("workbench_proposal_id", proposalId)
      .maybeSingle();
    if (!draft || !validatedArgs.ok || draft.original_body !== validatedArgs.args.body) {
      await restoreAwaitingConfirmation(admin, authz.org.orgId, id);
      return fail("reply_draft_missing", "已确认的回复草稿不可用；没有创建发送任务。", 409, {
        requestId,
      });
    }
    const userDb = await createClient();
    const { data: jobId, error: actionError } = await userDb.rpc("fn_reply_action", {
      p_org: authz.org.orgId,
      p_id: draft.id,
      p_revision: String(draft.revision),
      p_action: decision,
      p_body: decision === "approve" ? draft.original_body : null,
      p_feedback: parsed.data.reason ?? null,
    });
    if (actionError) {
      const { data: changed } = await admin
        .from("ai_agent_action_proposals")
        .select("status, result_summary")
        .eq("organization_id", authz.org.orgId)
        .eq("run_id", id)
        .eq("id", proposalId)
        .maybeSingle();
      if (changed?.status !== (decision === "approve" ? "executed" : "rejected")) {
        await restoreAwaitingConfirmation(admin, authz.org.orgId, id);
        return fail(
          actionError.message.includes("stale") ? "reply_context_stale" : "reply_not_authorized",
          actionError.message.includes("stale")
            ? "会话或 Agent 上下文已变化；没有创建发送任务，请重新运行并审核新草稿。"
            : "当前登录会话未满足 CRM 回复批准策略；没有创建发送任务。",
          actionError.message.includes("stale") ? 409 : 403,
          { requestId },
        );
      }
      observation = {
        tool: proposal.tool_name,
        status: decision === "approve" ? "executed" : "rejected",
        ...(decision === "approve" ? { result: changed.result_summary } : {}),
      };
    } else {
      observation = {
        tool: proposal.tool_name,
        status: decision === "approve" ? "executed" : "rejected",
        ...(decision === "approve" ? { result: { delivery: "queued", jobId } } : {}),
      };
    }
    await appendWorkbenchEvent(admin, {
      organizationId: authz.org.orgId,
      runId: id,
      type: "human_confirmation_received",
      payload: { proposalId, decision, actorUserId: authz.user.id },
    });
    await appendWorkbenchEvent(admin, {
      organizationId: authz.org.orgId,
      runId: id,
      type: "policy_checked",
      payload: {
        proposalId,
        decision: decision === "approve" ? "approved" : "rejected",
        tool: proposal.tool_name,
      },
    });
    if (decision === "approve") {
      await appendWorkbenchEvent(admin, {
        organizationId: authz.org.orgId,
        runId: id,
        type: "tool_started",
        payload: { proposalId, tool: proposal.tool_name },
      });
    }
    await appendWorkbenchEvent(admin, {
      organizationId: authz.org.orgId,
      runId: id,
      type: "tool_completed",
      payload: {
        proposalId,
        tool: proposal.tool_name,
        status: decision === "approve" ? "queued" : "rejected",
      },
    });
    void audit({
      action:
        decision === "approve" ? "ai_workbench.action_approved" : "ai_workbench.action_rejected",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "ai_agent_action_proposal",
      resourceId: proposalId,
      requestId,
      metadata: {
        run_id: id,
        tool: proposal.tool_name,
        delivery: decision === "approve" ? "queued" : "not_sent",
      },
    });
  } else if (decision === "reject") {
    const { data: rejected } = await admin
      .from("ai_agent_action_proposals")
      .update({
        status: "rejected",
        decision_by: authz.user.id,
        decision_reason: parsed.data.reason ?? null,
        decision_at: decidedAt,
        result_summary: { outcome: "rejected" },
        ...(proposal.tool_name === ASK_INTERNAL_COLLEAGUE_TOOL
          ? { tool_args: {}, preview: { externalEffect: "feishu_internal_question",
              requiresHumanConfirmation: true, redacted: true } }
          : {}),
      })
      .eq("organization_id", authz.org.orgId)
      .eq("id", proposalId)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (!rejected) {
      await restoreAwaitingConfirmation(admin, authz.org.orgId, id);
      return fail("state_conflict", "这个动作已被其他请求处理。", 409, { requestId });
    }
    observation = { tool: proposal.tool_name, status: "rejected" };
    await appendWorkbenchEvent(admin, {
      organizationId: authz.org.orgId,
      runId: id,
      type: "human_confirmation_received",
      payload: { proposalId, decision, actorUserId: authz.user.id },
    });
  } else {
    const state = run.runtime_state as { versionId?: unknown };
    if (typeof state?.versionId !== "string") {
      await restoreAwaitingConfirmation(admin, authz.org.orgId, id);
      return fail("run_state_missing", "无法恢复这次运行的 Agent 版本。", 409, { requestId });
    }
    const agentBase = await loadAgentVersionConfig(
      getRequestPool(),
      authz.org.orgId,
      run.agent_id,
      state.versionId,
    );
    const scopeInput = run.scope as {
      contactId?: string;
      leadId?: string;
      conversationId?: string;
      pipelineId?: string;
    };
    const pipelineIds = scopeInput.pipelineId ? [scopeInput.pipelineId] : [];
    const agent = agentBase ? { ...agentBase, pipelineIds } : null;
    if (!agent || !agent.toolIds.includes(proposal.tool_name)) {
      await restoreAwaitingConfirmation(admin, authz.org.orgId, id);
      return fail("tool_not_allowed", "这个 Agent 当前版本未授权该 CRM 工具。", 409, { requestId });
    }

    const deps = requestTurnDeps();
    const mcp = await buildMcpTurnTools(
      deps.crmCfg,
      { organizationId: authz.org.orgId, jobId: id },
      agent,
      deps.log,
      proposal.tool_name === "crm_request_human_handoff"
        ? { confirmationTools: ["crm_request_human_handoff"] }
        : undefined,
    );
    const tool = mcp?.tools[proposal.tool_name];
    if (!tool || typeof tool.execute !== "function") {
      await mcp?.cleanup();
      await restoreAwaitingConfirmation(admin, authz.org.orgId, id);
      return fail("tool_not_allowed", "该动作无法通过当前 CRM Harness 安全执行。", 409, {
        requestId,
      });
    }
    await appendWorkbenchEvent(admin, {
      organizationId: authz.org.orgId,
      runId: id,
      type: "human_confirmation_received",
      payload: { proposalId, decision, actorUserId: authz.user.id },
    });
    await appendWorkbenchEvent(admin, {
      organizationId: authz.org.orgId,
      runId: id,
      type: "policy_checked",
      payload: { proposalId, decision: "approved", tool: proposal.tool_name },
    });
    await appendWorkbenchEvent(admin, {
      organizationId: authz.org.orgId,
      runId: id,
      type: "tool_started",
      payload: { proposalId, tool: proposal.tool_name },
    });
    try {
      const reversible =
        proposal.tool_name === "crm_update_lead"
          ? await executeReversibleLeadUpdate({
              args: validatedArgs?.ok ? validatedArgs.args : proposal.tool_args,
              tools: mcp.tools as never,
            })
          : null;
      const output =
        reversible?.result ??
        (await tool.execute(validatedArgs?.ok ? validatedArgs.args : proposal.tool_args, {
          toolCallId: randomUUID(),
          messages: [],
          context: {},
        }));
      const result = output as { isError?: boolean; ok?: boolean } | null;
      if (result?.isError || result?.ok === false) throw new Error("crm_tool_reported_error");
      observation = { tool: proposal.tool_name, status: "executed", result: output };
      const { error } = await admin
        .from("ai_agent_action_proposals")
        .update({
          status: "executed",
          ...(reversible
            ? {
                compensation_args: reversible.compensationArgs as never,
                preview: reversible.preview as never,
              }
            : {}),
          decision_by: authz.user.id,
          decision_reason: parsed.data.reason ?? null,
          decision_at: decidedAt,
          result_summary: { outcome: "executed", tool: proposal.tool_name },
        })
        .eq("organization_id", authz.org.orgId)
        .eq("id", proposalId)
        .eq("status", "pending");
      if (error) throw new Error("proposal_update_failed");
      await appendWorkbenchEvent(admin, {
        organizationId: authz.org.orgId,
        runId: id,
        type: "tool_completed",
        payload: { proposalId, tool: proposal.tool_name, status: "success" },
      });
      await appendWorkbenchEvent(admin, {
        organizationId: authz.org.orgId,
        runId: id,
        type: "crm_state_changed",
        payload: {
          proposalId,
          tool: proposal.tool_name,
          ...(reversible
            ? {
                resource: "crm_leads",
                targetId: reversible.preview.resourceUuid,
                changedFields: reversible.preview.changedFields,
              }
            : {}),
        },
      });
      void audit({
        action: "ai_workbench.action_approved",
        actorUserId: authz.user.id,
        organizationId: authz.org.orgId,
        resourceType: "ai_agent_action_proposal",
        resourceId: proposalId,
        requestId,
        metadata: { run_id: id, tool: proposal.tool_name },
      });
    } catch {
      observation = {
        tool: proposal.tool_name,
        status: "failed",
        result: { error: "operation_failed" },
      };
      await admin
        .from("ai_agent_action_proposals")
        .update({
          status: "failed",
          decision_by: authz.user.id,
          decision_reason: parsed.data.reason ?? null,
          decision_at: decidedAt,
          result_summary: { outcome: "failed" },
        })
        .eq("organization_id", authz.org.orgId)
        .eq("id", proposalId)
        .eq("status", "pending");
      await appendWorkbenchEvent(admin, {
        organizationId: authz.org.orgId,
        runId: id,
        type: "tool_completed",
        payload: { proposalId, tool: proposal.tool_name, status: "error" },
      });
    } finally {
      await mcp?.cleanup();
    }
  }

  if (decision === "reject")
    void audit({
      action: "ai_workbench.action_rejected",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "ai_agent_action_proposal",
      resourceId: proposalId,
      requestId,
      metadata: { run_id: id, tool: proposal.tool_name },
    });

  const { data: runState } = await admin
    .from("ai_agent_run_states")
    .select("messages")
    .eq("organization_id", authz.org.orgId)
    .eq("run_id", id)
    .maybeSingle();
  const messages = parseRuntimeMessages(runState?.messages);
  if (!messages) {
    await failRun(admin, authz.org.orgId, id, "resume_state_missing");
    return fail(
      "run_state_missing",
      "无法安全恢复 Pi 的持久化消息状态。该动作已记录，请从 CRM 核对结果。",
      409,
      { requestId },
    );
  }
  const continuedMessages = appendWorkbenchObservation(messages, observation);
  const { error: stateError } = await admin
    .from("ai_agent_run_states")
    .update({ messages: continuedMessages as never })
    .eq("organization_id", authz.org.orgId)
    .eq("run_id", id);
  if (stateError) {
    await failRun(admin, authz.org.orgId, id, "resume_state_write_failed");
    return fail(
      "run_state_write_failed",
      "动作已处理，但无法保存 Pi 恢复状态；请检查 CRM 当前结果。",
      500,
      { requestId },
    );
  }

  const { count: pendingCount } = await admin
    .from("ai_agent_action_proposals")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", authz.org.orgId)
    .eq("run_id", id)
    .eq("status", "pending");
  if ((pendingCount ?? 0) > 0) {
    await restoreAwaitingConfirmation(admin, authz.org.orgId, id);
    return ok(
      { proposal_id: proposalId, status: observation.status, run_status: "awaiting_confirmation" },
      { requestId },
    );
  }

  try {
    await appendWorkbenchEvent(admin, {
      organizationId: authz.org.orgId,
      runId: id,
      type: "run_resumed",
      payload: { proposalId },
    });
  } catch {
    await failRun(admin, authz.org.orgId, id, "resume_event_persist_failed");
    return fail(
      "resume_event_persist_failed",
      "动作已记录，但无法追加运行事件；请核对 CRM 状态。",
      500,
      { requestId },
    );
  }
  try {
    await resolveWorkbenchScope(admin, authz.org.orgId, scopeInputFromRun(run.scope));
  } catch {
    await failRun(admin, authz.org.orgId, id, "scope_no_longer_available");
    return fail("scope_not_found", "CRM 对象范围已变化，操作已记录，但无法继续 Agent。", 409, {
      requestId,
    });
  }
  const runtimeState = run.runtime_state as { versionId?: unknown };
  if (typeof runtimeState?.versionId !== "string") {
    await failRun(admin, authz.org.orgId, id, "resume_version_missing");
    return fail("run_state_missing", "无法读取原 Agent 版本。", 409, { requestId });
  }
  try {
    await enqueueJob(getRequestPool(), authz.org.orgId, {
      kind: "workbench_resume",
      sourceEventId: proposalId,
      payload: { runId: id },
      maxAttempts: 3,
    });
  } catch {
    await failRun(admin, authz.org.orgId, id, "resume_queue_unavailable");
    return fail(
      "resume_queue_unavailable",
      "动作已记录，但运行队列暂不可用；请核对 CRM 状态后重试。",
      503,
      { requestId },
    );
  }
  return ok(
    { proposal_id: proposalId, status: observation.status, run_status: "running" },
    { requestId },
  );
}

function scopeInputFromRun(value: unknown) {
  const scope = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    ...(typeof scope.contactId === "string" ? { contactId: scope.contactId } : {}),
    ...(typeof scope.leadId === "string" ? { leadId: scope.leadId } : {}),
    ...(typeof scope.conversationId === "string" ? { conversationId: scope.conversationId } : {}),
    ...(typeof scope.pipelineId === "string" ? { pipelineId: scope.pipelineId } : {}),
  };
}

async function restoreAwaitingConfirmation(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  runId: string,
) {
  await admin
    .from("ai_workbench_runs")
    .update({ status: "awaiting_confirmation" })
    .eq("organization_id", organizationId)
    .eq("id", runId)
    .eq("status", "running");
}

async function failRun(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  runId: string,
  code: string,
) {
  await admin
    .from("ai_workbench_runs")
    .update({ status: "partial", error_code: code, completed_at: new Date().toISOString() })
    .eq("organization_id", organizationId)
    .eq("id", runId)
    .eq("status", "running");
  await appendWorkbenchEvent(admin, {
    organizationId,
    runId,
    type: "run_partial",
    payload: { status: "partial", pendingProposals: 0 },
  });
}
