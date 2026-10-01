import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ from: vi.fn(), evaluate: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn().mockResolvedValue({ ok: true, org: { orgId: "org" }, user: { id: "user" } }),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: mocks.from }) }));
vi.mock("@/lib/agent-engine/agent/agent-config", () => ({ loadAgentVersionConfig: vi.fn() }));
vi.mock("@/lib/agent-engine/agent/request-deps", () => ({ requestTurnDeps: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn() }));
vi.mock("@/lib/ai/evals/semantic-judge", () => ({
  LlmAgentSemanticJudge: vi.fn(),
  WORKBENCH_SEMANTIC_RUBRIC_REVISION: 1,
}));
vi.mock("@/lib/ai/evals/run-evaluation", () => ({ runAgentEvaluation: mocks.evaluate }));
import { GET } from "./route";
const id = "11111111-1111-4111-8111-111111111111";
function stub(failure?: string, corruptChild = false, missingState = false) {
  mocks.from.mockImplementation((table: string) => {
    let multiple = false;
    let child = false;
    const response = () => ({
      error: failure === table ? { message: "read failed" } : null,
      data:
        table === "ai_workbench_runs"
          ? child
            ? [{ id: "child", status: "completed", runtime_state: {} }]
            : {
                id,
                agent_id: "agent",
                task: "Read CRM",
                mode: "inspect",
                status: "completed",
                final_text: "Result",
                runtime_state: {},
                updated_at: "now",
              }
          : table === "ai_agent_run_states"
            ? multiple
              ? [{ run_id: "child", messages: corruptChild ? {} : [] }]
              : missingState ? null : { messages: [] }
            : table === "ai_agents"
              ? { origin: "user" }
              : [],
    });
    const builder = {
      select: () => builder,
      eq: (key: string) => {
        if (key === "parent_run_id") child = true;
        return builder;
      },
      in: () => {
        multiple = true;
        return builder;
      },
      order: () => builder,
      maybeSingle: () => Promise.resolve(response()),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(response()).then(resolve),
    };
    return builder;
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.evaluate.mockResolvedValue({ verdict: "pass" });
});
describe("real evaluation material is required", () => {
  it.each(["ai_agent_run_events", "ai_agent_action_proposals", "ai_agent_run_states", "ai_agents"])(
    "rejects incomplete %s instead of grading empty material",
    async (failure) => {
      stub(failure);
      const response = await GET(new NextRequest(`http://localhost/runs/${id}/evaluation`), {
        params: Promise.resolve({ id }),
      });
      expect(response.status).toBe(500);
      expect(mocks.evaluate).not.toHaveBeenCalled();
    },
  );
  it("rejects corrupt specialist messages instead of silently dropping them", async () => {
    stub(undefined, true);
    const response = await GET(new NextRequest(`http://localhost/runs/${id}/evaluation`), {
      params: Promise.resolve({ id }),
    });
    expect(response.status).toBe(409);
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
  it("does not grade a completed run whose persisted observations are missing", async () => {
    stub(undefined, false, true);
    const response = await GET(new NextRequest(`http://localhost/runs/${id}/evaluation`), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(409);
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
  it("computes the report from successfully loaded root and specialist material", async () => {
    stub();
    const response = await GET(new NextRequest(`http://localhost/runs/${id}/evaluation`), {
      params: Promise.resolve({ id }),
    });
    expect(response.status).toBe(200);
    expect(mocks.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        run: expect.objectContaining({
          runId: id,
          runtimeMessages: [],
          collaborationRuns: [expect.objectContaining({ id: "child" })],
        }),
      }),
    );
  });
});
