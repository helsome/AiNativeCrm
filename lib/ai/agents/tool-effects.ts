import { catalogEntry } from "@/lib/mcp/tools/catalog";
import type { ToolEffect } from "@/lib/agent-runtime";

export interface WorkbenchToolEffect {
  effect: ToolEffect;
  resource: string;
  compensationTool?: string;
}

const OVERRIDES: Record<string, WorkbenchToolEffect> = {
  send_message: { effect: "external", resource: "messages" },
  crm_update_lead: {
    effect: "reversible_write",
    resource: "crm_leads",
    compensationTool: "crm_update_lead",
  },
  crm_send_whatsapp_message: { effect: "external", resource: "messages" },
  crm_start_conversation_and_send: { effect: "external", resource: "conversations" },
  crm_request_human_handoff: { effect: "external", resource: "conversations" },
};

/** Unknown tools are unclassified and must be denied by the workbench harness. */
export function workbenchToolEffect(name: string): WorkbenchToolEffect | null {
  const explicit = OVERRIDES[name];
  if (explicit) return explicit;
  const catalog = catalogEntry(name);
  if (!catalog) return null;
  if (catalog.category === "read") return { effect: "read", resource: catalog.oQueToca };
  if (catalog.category === "handoff") return { effect: "external", resource: catalog.oQueToca };
  // Writes default to human-confirmed irreversible until a concrete business
  // compensation implementation is registered.
  return { effect: "irreversible", resource: catalog.oQueToca };
}
