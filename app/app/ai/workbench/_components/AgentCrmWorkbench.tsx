"use client";

import { useEffect, useMemo, useState } from "react";

type Scenario = { title: string; task: string; harnessFocus: string };
type Agent = {
  id: string;
  name: string;
  description: string | null;
  builtinKey: string;
  scenarios: readonly Scenario[];
  knowledgePolicy?: {
    namespaces: readonly string[];
    citationMode: string;
    unavailableBehavior: string;
  };
  evalProfile?: string;
};
type Run = {
  id: string;
  agent_id: string;
  task: string;
  mode: string;
  status: string;
  final_text: string | null;
  error_code: string | null;
  created_at: string;
};
type EventRow = {
  id: string;
  sequence: number;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
};
type Proposal = {
  id: string;
  sequence: number;
  tool_name: string;
  status: string;
  preview: Record<string, unknown>;
  result_summary?: Record<string, unknown> | null;
  draft_body?: string;
  can_undo?: boolean;
};
type Detail = Run & {
  events: EventRow[];
  proposals: Proposal[];
  specialists: Array<{
    id: string;
    specialist_key: string | null;
    collaboration_key: string | null;
    status: string;
    error_code: string | null;
  }>;
  usage?: { inputTokens: number; outputTokens: number; costCents: number; calls: number };
  evaluation?: EvaluationReport;
};
type EvaluationReport = {
  verdict: "pass" | "fail" | "needs_review" | "not_run";
  score: number | null;
  profileKey: string;
  dimensions: Array<{
    key: string;
    label: string;
    verdict: string;
    score: number | null;
    findings: Array<{ code: string; message: string }>;
  }>;
  summary: {
    toolCalls: number;
    toolErrors: number;
    knowledgeSearches: number;
    groundedEvidenceItems: number;
    specialistRuns: number;
    specialistFailures: number;
    structuredClaims: number;
  };
  semanticJudge: {
    status: string;
    verdict?: string;
    score?: number;
    findings?: Array<{ code: string; message: string }>;
  };
};
type ObjectKind = "contact" | "lead" | "conversation" | "pipeline";
type Scope = { contactId?: string; leadId?: string; conversationId?: string; pipelineId?: string };
type ScopeOption = {
  id: string;
  label: string;
  detail?: string | null;
  pipelineId?: string;
  contactId?: string | null;
};

const EVENT_LABELS: Record<string, string> = {
  run_started: "任务开始",
  context_loaded: "CRM 上下文已加载",
  model_decision: "Agent 已完成决策",
  tool_proposed: "提出 CRM 操作",
  policy_checked: "策略检查通过",
  tool_started: "工具开始执行",
  tool_completed: "工具执行结束",
  crm_state_changed: "CRM 状态已变化",
  human_confirmation_requested: "等待人工确认",
  human_confirmation_received: "收到人工决策",
  run_resumed: "运行已恢复",
  run_completed: "运行完成",
  run_partial: "部分完成",
  run_failed: "运行失败",
  run_cancelled: "运行已取消",
  collaboration_started: "多 Agent 审查开始",
  specialist_started: "只读 Specialist 开始",
  specialist_completed: "只读 Specialist 完成",
  specialist_failed: "只读 Specialist 失败",
  collaboration_conflict: "Specialist 证据冲突",
  collaboration_completed: "多 Agent 审查完成",
  usage_reported: "用量已记录",
};

const TOOL_LABELS: Record<string, string> = {
  crm_request_human_handoff: "请求转交人工",
  crm_update_lead: "更新商机字段",
  send_message: "发送客户回复",
};

function eventLabel(event: EventRow): string {
  if (event.event_type === "policy_checked") {
    const verdict = event.payload.verdict ?? event.payload.decision;
    if (verdict === "veto") return "发送策略拦截";
    if (verdict === "pass") return "发送策略允许";
    if (verdict === "skipped") return "发送策略跳过此项";
    if (verdict === "requires_human_confirmation") return "此 CRM 操作需要人工确认";
    if (verdict === "allowed_reversible_write") return "允许自动执行可逆写入";
  }
  return EVENT_LABELS[event.event_type] ?? event.event_type;
}

export function AgentCrmWorkbench({
  agents,
  modelConfigured,
  canCopy,
}: {
  agents: Agent[];
  modelConfigured: boolean;
  canCopy: boolean;
}) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [task, setTask] = useState("");
  const [mode, setMode] = useState<"inspect" | "act">("inspect");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [objectKind, setObjectKind] = useState<ObjectKind>("contact");
  const [objectQuery, setObjectQuery] = useState("");
  const [objectOptions, setObjectOptions] = useState<ScopeOption[]>([]);
  const [scope, setScope] = useState<Scope>({});
  const [scopeLabel, setScopeLabel] = useState("");
  const selected = agents.find((agent) => agent.id === agentId) ?? agents[0];

  const fetchRuns = async (): Promise<Run[]> => {
    const response = await fetch("/api/v1/ai/workbench/runs");
    const body = await response.json();
    return response.ok && Array.isArray(body.data) ? body.data : [];
  };
  const fetchDetail = async (runId: string): Promise<Detail> => {
    const [detailResponse, evalResponse] = await Promise.all([
      fetch(`/api/v1/ai/workbench/runs/${runId}`),
      fetch(`/api/v1/ai/workbench/runs/${runId}/evaluation`),
    ]);
    const detailBody = await detailResponse.json();
    if (!detailResponse.ok) throw new Error(detailBody.error?.message ?? "无法读取运行详情");
    const evalBody = await evalResponse.json();
    return {
      ...detailBody.data,
      ...(evalResponse.ok && evalBody.data ? { evaluation: evalBody.data } : {}),
    };
  };
  const loadRuns = async () => setRuns(await fetchRuns());
  useEffect(() => {
    let active = true;
    void fetchRuns().then((initialRuns) => {
      if (active) setRuns(initialRuns);
    });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const runId = new URLSearchParams(window.location.search).get("run");
    if (!runId) return;
    let active = true;
    void fetchDetail(runId)
      .then((loaded) => {
        if (active) setDetail(loaded);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "无法读取运行详情");
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      void fetch(
        `/api/v1/ai/workbench/objects?kind=${objectKind}&q=${encodeURIComponent(objectQuery)}`,
      )
        .then((response) => response.json())
        .then((body) => setObjectOptions(body.data ?? []))
        .catch(() => setObjectOptions([]));
    }, 180);
    return () => clearTimeout(timer);
  }, [objectKind, objectQuery]);

  const chooseScope = (item: ScopeOption) => {
    const next: Scope =
      objectKind === "contact"
        ? { contactId: item.id }
        : objectKind === "lead"
          ? { leadId: item.id, ...(item.pipelineId ? { pipelineId: item.pipelineId } : {}) }
          : objectKind === "conversation"
            ? { conversationId: item.id, ...(item.contactId ? { contactId: item.contactId } : {}) }
            : { pipelineId: item.id };
    setScope(next);
    setScopeLabel(item.label);
    setObjectOptions([]);
  };

  const run = async () => {
    if (!selected || !task.trim() || !modelConfigured) return;
    setBusy(true);
    setError("");
    setDetail(null);
    try {
      const response = await fetch("/api/v1/ai/workbench/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: selected.id,
          task,
          mode,
          ...(Object.keys(scope).length ? { scope } : {}),
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "运行失败");
      const runId = body.data.run_id as string;
      const initialDetail = await fetchDetail(runId);
      setDetail(initialDetail);
      await streamRunEvents(runId, initialDetail.events ?? [], initialDetail.status);
      const [finalDetail] = await Promise.all([fetchDetail(runId), loadRuns()]);
      setDetail(finalDetail);
      setTask("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "运行失败");
    } finally {
      setBusy(false);
    }
  };

  const streamRunEvents = async (
    runId: string,
    initialEvents: EventRow[],
    initialStatus: string,
  ) => {
    let sequence = initialEvents.reduce((max, event) => Math.max(max, event.sequence), 0);
    // The worker can finish before the first detail request reaches the browser.
    // In that case the initial event page already contains the terminal event;
    // starting the stream at its last sequence would otherwise wait forever for
    // a terminal event that has intentionally been skipped during replay.
    let status = initialStatus;
    while (
      !["completed", "partial", "failed", "cancelled", "awaiting_confirmation"].includes(status)
    ) {
      const response = await fetch(`/api/v1/ai/workbench/runs/${runId}/events?after=${sequence}`);
      if (!response.ok || !response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
          if (!dataLine) continue;
          try {
            const event = JSON.parse(dataLine.slice(6)) as EventRow;
            if (!event.sequence || event.sequence <= sequence) continue;
            sequence = event.sequence;
            setDetail((current) =>
              current?.id === runId ? { ...current, events: [...current.events, event] } : current,
            );
            if (
              ["run_completed", "run_partial", "run_failed", "run_cancelled"].includes(
                event.event_type,
              )
            ) {
              status =
                event.event_type === "run_completed"
                  ? "completed"
                  : event.event_type === "run_partial"
                    ? "partial"
                    : event.event_type === "run_failed"
                      ? "failed"
                      : "cancelled";
            }
          } catch {
            /* 忽略心跳与不完整片段，下一块继续解析。 */
          }
        }
      }
      if (status === "running" || status === "queued") {
        const latest = await fetch(`/api/v1/ai/workbench/runs/${runId}`).then((r) => r.json());
        status = latest.data?.status ?? "failed";
      }
    }
  };

  const cancelRun = async () => {
    if (!detail) return;
    const response = await fetch(`/api/v1/ai/workbench/runs/${detail.id}/cancel`, {
      method: "POST",
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error?.message ?? "取消失败");
      return;
    }
    setDetail(await fetchDetail(detail.id));
    await loadRuns();
  };

  const runSemanticJudge = async () => {
    if (!detail) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/ai/workbench/runs/${detail.id}/evaluation`, {
        method: "POST",
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "语义 Judge 运行失败");
      setDetail((current) =>
        current?.id === detail.id ? { ...current, evaluation: body.data } : current,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "语义 Judge 运行失败");
    } finally {
      setBusy(false);
    }
  };

  const decide = async (proposalId: string, decision: "approve" | "reject") => {
    if (!detail) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/v1/ai/workbench/runs/${detail.id}/proposals/${proposalId}/decision`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision }),
        },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "决策失败");
      const updated = await fetchDetail(detail.id);
      setDetail(updated);
      if (body.data?.run_status === "running") {
        await streamRunEvents(detail.id, updated.events ?? [], updated.status);
        setDetail(await fetchDetail(detail.id));
      }
      await loadRuns();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "决策失败");
    } finally {
      setBusy(false);
    }
  };

  const undo = async (proposalId: string) => {
    if (!detail) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/v1/ai/workbench/runs/${detail.id}/proposals/${proposalId}/undo`,
        { method: "POST" },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "撤销失败");
      setDetail(await fetchDetail(detail.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "撤销失败");
    } finally {
      setBusy(false);
    }
  };

  const copyBuiltin = async () => {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/ai/agents/${selected.id}/copy-builtin`, {
        method: "POST",
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "复制 Agent 失败");
      window.location.assign(`/app/ai/agents/${body.data.agent.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "复制 Agent 失败");
    } finally {
      setBusy(false);
    }
  };

  const pending = useMemo(
    () => detail?.proposals.filter((proposal) => proposal.status === "pending") ?? [],
    [detail],
  );

  return (
    <div className="grid min-h-[650px] gap-3 xl:grid-cols-[240px_minmax(320px,1fr)_300px]">
      <aside className="space-y-4 rounded-lg border bg-card p-4">
        <div>
          <h2 className="font-semibold">内置 Agent</h2>
          <p className="mt-1 text-xs text-muted-foreground">锁定原件，可运行或复制定制</p>
        </div>
        <div className="space-y-2">
          {agents.map((agent) => (
            <button
              key={agent.id}
              onClick={() => {
                setAgentId(agent.id);
                setDetail(null);
              }}
              className={`w-full rounded-lg border p-3 text-left ${selected?.id === agent.id ? "border-primary bg-primary/5" : "hover:bg-muted/60"}`}
            >
              <span className="block font-medium">{agent.name}</span>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                {agent.description}
              </span>
            </button>
          ))}
        </div>
        {selected && (
          <div className="border-t pt-3">
            <div className="mb-3 rounded-md bg-muted/60 p-2.5 text-xs text-muted-foreground">
              <p>知识域：{selected.knowledgePolicy?.namespaces.join(" · ") || "CRM context"}</p>
              <p className="mt-1">Eval：{selected.evalProfile ?? "crm_agent_default_v1"}</p>
            </div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">快速场景</p>
            {selected.scenarios.map((scenario) => (
              <button
                key={scenario.title}
                onClick={() => setTask(scenario.task)}
                className="mb-2 w-full rounded-md bg-muted/60 p-2.5 text-left hover:bg-muted"
              >
                <span className="block text-sm font-medium">{scenario.title}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  展示：{scenario.harnessFocus}
                </span>
              </button>
            ))}
          </div>
        )}
        {canCopy && (
          <button
            disabled={busy}
            onClick={() => void copyBuiltin()}
            className="w-full rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
          >
            复制并定制
          </button>
        )}
      </aside>

      <section className="flex min-h-[650px] flex-col rounded-lg border bg-card">
        <div className="border-b p-4">
          <h2 className="font-semibold">任务与执行时间线</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Task → Context → Decision → Tool → Observation → State
          </p>
        </div>
        <div className="flex-1 space-y-3 overflow-auto p-4">
          {!detail && !busy && (
            <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
              选择一个场景或输入目标。Agent 会读取当前组织的真实 CRM 数据。
            </div>
          )}
          {busy && (
            <p className="animate-pulse text-sm text-muted-foreground">
              Pi Agent 正在读取上下文并执行…
            </p>
          )}
          {detail?.events.map((event) => (
            <div key={event.id} className="flex gap-3 text-sm">
              <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary" />
              <div>
                <p className="font-medium">{eventLabel(event)}</p>
                <p className="text-xs text-muted-foreground">
                  {new Date(event.created_at).toLocaleTimeString()} ·{" "}
                  {Object.entries(event.payload ?? {})
                    .filter(([key]) => !/id$/.test(key))
                    .map(([key, value]) => `${key}: ${String(value)}`)
                    .join(" · ")}
                </p>
              </div>
            </div>
          ))}
          {detail?.final_text && (
            <article className="mt-5 rounded-lg bg-muted/50 p-4 text-sm leading-6 whitespace-pre-wrap">
              {detail.final_text}
            </article>
          )}
          {error && (
            <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <div className="space-y-3 border-t p-4">
          <div className="grid gap-2 sm:grid-cols-[150px_1fr]">
            <select
              aria-label="CRM 对象类型"
              className="rounded-md border bg-background px-3 py-2 text-sm"
              value={objectKind}
              onChange={(event) => {
                setObjectKind(event.target.value as ObjectKind);
                setScope({});
                setScopeLabel("");
              }}
            >
              <option value="contact">联系人</option>
              <option value="lead">商机</option>
              <option value="conversation">会话</option>
              <option value="pipeline">销售漏斗</option>
            </select>
            <input
              aria-label="搜索 CRM 对象"
              value={objectQuery}
              onChange={(event) => setObjectQuery(event.target.value)}
              placeholder="按名称或内容搜索 CRM…"
              className="rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>
          {scopeLabel ? (
            <div className="flex items-center justify-between rounded-md bg-muted px-3 py-2 text-xs">
              <span>目标对象：{scopeLabel}</span>
              <button
                onClick={() => {
                  setScope({});
                  setScopeLabel("");
                }}
                className="underline"
              >
                清除
              </button>
            </div>
          ) : (
            <div className="max-h-32 space-y-1 overflow-auto">
              {objectOptions.map((item) => (
                <button
                  key={item.id}
                  onClick={() => chooseScope(item)}
                  className="flex w-full justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
                >
                  <span className="truncate">{item.label}</span>
                  {item.detail && (
                    <span className="shrink-0 text-muted-foreground">{item.detail}</span>
                  )}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="run-mode" className="text-sm font-medium">
              执行模式
            </label>
            <select
              id="run-mode"
              className="rounded-md border bg-background px-3 py-2 text-sm"
              value={mode}
              onChange={(event) => setMode(event.target.value as "inspect" | "act")}
            >
              <option value="inspect">只读检查</option>
              <option value="act">分级自治（可逆写入自动执行）</option>
            </select>
          </div>
          <textarea
            value={task}
            onChange={(event) => setTask(event.target.value)}
            placeholder="例如：找出停滞商机并建议明天的跟进计划…"
            className="min-h-24 w-full resize-y rounded-lg border bg-background p-3 text-sm focus:ring-2 focus:ring-ring"
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">真实模型 · 组织级权限 · 操作留痕</span>
            <button
              disabled={!modelConfigured || busy || !task.trim() || !selected}
              onClick={() => void run()}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {busy ? "运行中…" : "运行 Agent"}
            </button>
          </div>
        </div>
      </section>

      <aside className="space-y-4 rounded-lg border bg-card p-4">
        <div>
          <h2 className="font-semibold">CRM 变化与策略</h2>
          <p className="mt-1 text-xs text-muted-foreground">执行状态、待确认动作与用量</p>
        </div>
        {detail ? (
          <>
            <div className="rounded-lg bg-muted/60 p-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">状态</span>
                <span>{detail.status}</span>
              </div>
              <div className="mt-2 flex justify-between">
                <span className="text-muted-foreground">模式</span>
                <span>{detail.mode === "act" ? "分级自治" : "只读检查"}</span>
              </div>
            </div>
            {(detail.proposals.find((proposal) => proposal.tool_name === "send_message")
              ?.draft_body ||
              detail.final_text) && (
              <section className="rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">Agent 回复草稿</h3>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                    未发送
                  </span>
                </div>
                <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap">
                  {detail.proposals.find((proposal) => proposal.tool_name === "send_message")
                    ?.draft_body ?? detail.final_text}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  草稿仅供审核，不会自动发送给客户。
                </p>
              </section>
            )}
            {pending.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold">待确认动作</h3>
                {pending.map((proposal) => (
                  <div key={proposal.id} className="rounded-lg border p-3">
                    <p className="text-sm font-medium">
                      {TOOL_LABELS[proposal.tool_name] ?? proposal.tool_name}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {proposal.tool_name === "send_message"
                        ? "草稿尚未发送。批准后创建 CRM 审核发送任务，由正式 worker 重新检查实时策略和会话状态。"
                        : "Agent 未执行此动作。批准后由 CRM Harness 再次校验并调用。"}
                    </p>
                    <div className="mt-3 flex gap-2">
                      <button
                        disabled={busy}
                        onClick={() => void decide(proposal.id, "approve")}
                        className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground"
                      >
                        {proposal.tool_name === "send_message" ? "批准并进入发送队列" : "批准执行"}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => void decide(proposal.id, "reject")}
                        className="rounded-md border px-3 py-1.5 text-xs"
                      >
                        拒绝
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {["running", "queued"].includes(detail.status) && (
              <button
                onClick={() => void cancelRun()}
                className="w-full rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive"
              >
                取消运行
              </button>
            )}
            {detail.proposals
              .filter((proposal) => proposal.status !== "pending")
              .map((proposal) => (
                <div key={proposal.id} className="rounded-lg border p-3 text-sm">
                  <span className="font-medium">
                    {TOOL_LABELS[proposal.tool_name] ?? proposal.tool_name}
                  </span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {proposal.tool_name === "send_message" && proposal.status === "executed"
                      ? "已进入 CRM 发送队列"
                      : proposal.status}
                  </span>
                  {proposal.status === "executed" && proposal.can_undo && (
                    <button
                      disabled={busy}
                      onClick={() => void undo(proposal.id)}
                      className="ml-3 rounded-md border px-2 py-1 text-xs"
                    >
                      撤销
                    </button>
                  )}
                  {Array.isArray(proposal.preview.changedFields) &&
                    proposal.preview.changedFields.length > 0 && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        变更字段：{proposal.preview.changedFields.join("、")}
                      </p>
                    )}
                </div>
              ))}
            <div className="rounded-lg border p-3 text-xs">
              <p className="font-medium">Harness 记录</p>
              <p className="mt-1 text-muted-foreground">
                {detail.events.length} 个事件 · {detail.proposals.length} 个操作提案
              </p>
            </div>
            {detail.specialists.length > 0 && (
              <section className="rounded-lg border p-3 text-xs">
                <p className="font-medium">Specialist 子运行</p>
                <div className="mt-2 space-y-2">
                  {detail.specialists.map((specialist) => (
                    <div
                      key={specialist.id}
                      className="flex items-center justify-between gap-3 text-muted-foreground"
                    >
                      <span>{specialist.specialist_key ?? "unknown"}</span>
                      <span>{specialist.status}</span>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-muted-foreground">
                  Specialist 只读；CRM 写入仍由父 Agent 和 Harness 单写者路径处理。
                </p>
              </section>
            )}
            {detail.evaluation && (
              <section className="rounded-lg border p-3 text-xs" data-testid="agent-run-evaluation">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-medium">Run Eval</p>
                  <span>
                    {detail.evaluation.verdict}
                    {detail.evaluation.score === null ? "" : ` · ${detail.evaluation.score}`}
                  </span>
                </div>
                <div className="mt-2 space-y-1">
                  {detail.evaluation.dimensions.map((dimension) => (
                    <div
                      key={dimension.key}
                      className="flex justify-between gap-3 text-muted-foreground"
                    >
                      <span>{dimension.label}</span>
                      <span>{dimension.verdict}</span>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-muted-foreground">
                  {detail.evaluation.summary.toolCalls} 次工具 ·{" "}
                  {detail.evaluation.summary.toolErrors} 次失败 ·{" "}
                  {detail.evaluation.summary.groundedEvidenceItems} 条知识证据 ·{" "}
                  {detail.evaluation.summary.specialistRuns} 个 Specialist
                  {detail.evaluation.summary.structuredClaims > 0
                    ? ` · ${detail.evaluation.summary.structuredClaims} 条 Claims`
                    : ""}
                </p>
                {detail.evaluation.semanticJudge.status === "completed" ? (
                  <div className="mt-2 rounded-md bg-muted p-2 text-muted-foreground">
                    语义 Judge：{detail.evaluation.semanticJudge.verdict}
                    {detail.evaluation.semanticJudge.score === undefined
                      ? ""
                      : ` · ${detail.evaluation.semanticJudge.score}`}
                  </div>
                ) : (
                  <>
                  <p className="mt-1 text-muted-foreground">
                    {detail.evaluation.semanticJudge.status === "failed"
                      ? "语义 Judge 上次未完成；确定性 Harness 结果仍然有效。"
                      : "当前为确定性 Harness 评测；语义 Judge 需要显式运行。"}
                  </p>
                    <button
                      type="button"
                      disabled={busy || !modelConfigured || !["completed", "partial"].includes(detail.status)}
                      onClick={() => void runSemanticJudge()}
                      className="mt-2 rounded-md border px-2 py-1 font-medium disabled:opacity-50"
                    >
                      运行语义 Judge（消耗模型额度）
                    </button>
                  </>
                )}
              </section>
            )}
          </>
        ) : (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            运行后这里显示策略结果、待确认动作和 CRM 状态变化。
          </p>
        )}
        <div className="border-t pt-3">
          <h3 className="mb-2 text-sm font-semibold">最近运行</h3>
          <div className="max-h-60 space-y-1 overflow-auto">
            {runs.slice(0, 8).map((item) => (
              <button
                key={item.id}
                onClick={() => void fetchDetail(item.id).then((loaded) => setDetail(loaded))}
                className="w-full rounded-md p-2 text-left hover:bg-muted"
              >
                <span className="block truncate text-xs">{item.task}</span>
                <span className="text-[11px] text-muted-foreground">
                  {item.status} · {new Date(item.created_at).toLocaleString()}
                </span>
              </button>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}
