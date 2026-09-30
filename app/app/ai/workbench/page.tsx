import { redirect } from "next/navigation";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { roleAtLeast } from "@/lib/auth/types";
import { ensureBuiltinAgents } from "@/lib/ai/agents/ensure-builtins";
import { BUILTIN_AGENTS } from "@/lib/ai/agents/builtins";
import { createAdminClient } from "@/lib/supabase/admin";
import { AgentCrmWorkbench } from "./_components/AgentCrmWorkbench";

export const dynamic = "force-dynamic";

export default async function AgentCrmWorkbenchPage() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org || !roleAtLeast(org.role, "manager")) redirect("/403");
  await ensureBuiltinAgents(org.orgId);
  const admin = createAdminClient();
  const { data: agents, error } = await admin
    .from("ai_agents")
    .select("id, name, description, builtin_key, builtin_revision, model_binding_mode")
    .eq("organization_id", org.orgId)
    .eq("origin", "builtin")
    .is("archived_at", null)
    .order("created_at", { ascending: true });
  const { data: organization } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", org.orgId)
    .maybeSingle();
  const llm = (organization?.settings as { llm?: unknown } | null)?.llm as
    { provider?: unknown; default_model?: unknown } | undefined;
  const modelConfigured =
    typeof llm?.provider === "string" &&
    Boolean(llm.provider.trim()) &&
    typeof llm?.default_model === "string" &&
    Boolean(llm.default_model.trim());

  return (
    <main className="mx-auto w-full max-w-[1600px] px-5 py-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-muted-foreground">Pi Native CRM</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Agent–CRM 工作台</h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            选一个内置 Agent，让它读取真实 CRM
            上下文、提出下一步操作，并在同一处查看策略判断和数据变化。
          </p>
        </div>
        <a className="text-sm underline underline-offset-4" href="/app/ai/providers">
          模型与凭据设置
        </a>
      </header>
      {!modelConfigured && (
        <div
          role="status"
          className="mb-5 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm"
        >
          先连接组织的真实模型，内置 Agent 可先查看但暂时不能运行。系统不会使用模拟模型。
        </div>
      )}
      {error ? (
        <p role="alert">加载内置 Agent 失败，请刷新重试。</p>
      ) : (
        <AgentCrmWorkbench
          canCopy={roleAtLeast(org.role, "admin")}
          agents={(agents ?? []).map((agent) => {
            const definition = BUILTIN_AGENTS.find((item) => item.key === agent.builtin_key);
            return {
              ...agent,
              scenarios: definition?.scenarios ?? [],
              builtinKey: agent.builtin_key ?? "",
              knowledgePolicy: definition?.knowledgePolicy,
              evalProfile: definition?.evalProfile,
            };
          })}
          modelConfigured={modelConfigured}
        />
      )}
    </main>
  );
}
