import { z } from "zod";
import { tool, type ToolSet } from "@/lib/agent-engine/edge/llm/run-model-call";

export const SUBMIT_WORKBENCH_RESULT_TOOL = "submit_workbench_result";
export const WORKBENCH_RESULT_REVISION = 1;

/** Safe scalar CRM fields only; never ask the model to echo names, messages or contact details. */
export const WORKBENCH_FACT_FIELDS = [
  "is_blocked", "is_anonymized", "cpf_available",
  "status", "stage_id", "value_cents", "currency", "expected_close_date",
  "channel", "unread_count",
] as const;

export const workbenchResultSchema = z.object({
  summary: z.string().trim().min(1).max(2200),
  evidence: z.array(z.object({
    sourceType: z.enum(["contact", "lead", "conversation", "knowledge", "specialist", "run_event"]),
    sourceId: z.string().uuid(),
    claim: z.string().trim().min(1).max(300),
    assertions: z.array(z.object({
      field: z.enum(WORKBENCH_FACT_FIELDS),
      equals: z.union([z.string().max(80), z.number().finite(), z.boolean(), z.null()]),
    }).strict()).max(4).optional(),
  }).strict()).max(12),
  missingInformation: z.array(z.string().trim().min(1).max(240)).max(8),
  nextStep: z.string().trim().max(500),
  wakeCondition: z.enum(["none", "customer_reply", "human_approval", "internal_response", "deadline"]),
}).strict();

export type WorkbenchResultSubmission = z.infer<typeof workbenchResultSchema>;
export const workbenchResultDocumentSchema = workbenchResultSchema.extend({
  revision: z.literal(WORKBENCH_RESULT_REVISION),
  trust: z.literal("model_submitted"),
}).strict();

/** An in-memory output port. It cannot read or mutate CRM and is not an approval. */
export function createWorkbenchResultChannel(): {
  tools: ToolSet;
  submitted: () => WorkbenchResultSubmission | null;
} {
  let value: WorkbenchResultSubmission | null = null;
  const tools = {
    [SUBMIT_WORKBENCH_RESULT_TOOL]: tool({
      description: "Submit the user-visible result once, after reading evidence. For contact/lead/conversation evidence, optionally include safe scalar assertions copied from the observed CRM tool result. This records an assessment; it does not execute, approve, or verify CRM actions. Never include secrets or personal contact details in assertions.",
      inputSchema: workbenchResultSchema,
      execute: async (candidate) => {
        const parsed = workbenchResultSchema.safeParse(candidate);
        if (!parsed.success) return { accepted: false, reason: "invalid_schema" };
        if (value !== null) return { accepted: false, reason: "already_submitted" };
        value = parsed.data;
        return { accepted: true };
      },
    }),
  } satisfies ToolSet;
  return { tools, submitted: () => value };
}

export function resultDocument(submission: WorkbenchResultSubmission) {
  return {
    revision: WORKBENCH_RESULT_REVISION,
    trust: "model_submitted" as const,
    ...submission,
  };
}

/** Run completion is not business-outcome verification; evidence gaps remain partial. */
export function workbenchResultPartialReason(input: {
  finalText: string;
  submission: WorkbenchResultSubmission | null;
  answerInvalidCode?: string | null;
  budgetExhausted: boolean;
}): string | null {
  if (!input.finalText.trim()) return "empty_final_answer";
  if (!input.submission) return "structured_result_missing";
  if (input.answerInvalidCode) return input.answerInvalidCode;
  if (input.submission.missingInformation.length > 0) return "missing_material";
  if (input.budgetExhausted) return "budget_exhausted";
  return null;
}

export function workbenchFinalText(input: {
  submission: WorkbenchResultSubmission | null;
  priorText: string | null;
  fallbackText: string;
  candidateBodies: string[];
}): string {
  if (input.submission) return input.submission.summary;
  return [input.priorText, input.fallbackText, ...input.candidateBodies]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
}

export const WORKBENCH_RESULT_INSTRUCTION = [
  `最终必须调用 ${SUBMIT_WORKBENCH_RESULT_TOOL} 一次提交用户可见结果，不要将最终答案写成普通文本。`,
  "summary 只写已经有证据支持的事实；不能宣称待审提案、排队发送或业务目标已经完成。",
  "evidence 只填实际读取过的 CRM/知识/专家/运行事件的 UUID；没有证据则留空，不得编造引用。",
  "若工具结果包含联系人 is_blocked/is_anonymized/cpf_available、商机 status/stage_id/value_cents/currency/expected_close_date 或会话 status/channel/unread_count，可在对应 evidence.assertions 填入实际看到的字段和值；不要推测缺失字段，也不要提交姓名、电话、消息正文或密钥。",
  "missingInformation 列出仍缺的事实；nextStep 写一个可验证的下一步；wakeCondition 只描述建议，实际唤醒由 CRM 决定。",
  "结构化提交不执行任何 CRM 动作，也不代替人工批准。",
].join("\n");
