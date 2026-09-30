import { describe, expect, it } from "vitest";
import { redactEventPayload } from "./workbench-events";

describe("CRM workbench event payloads", () => {
  it("keeps only the product-safe fields for each event", () => {
    expect(redactEventPayload("context_loaded", {
      contactId: "contact-1", conversationId: "conversation-1", messageBody: "private customer content",
    })).toEqual({ contactId: "contact-1", conversationId: "conversation-1" });
  });

  it("redacts secret-shaped fields even when nested in an allowed field", () => {
    expect(redactEventPayload("tool_proposed", {
      tool: "crm_update_lead", proposalId: "proposal-1", api_key: "never-store-this", extra: "discard",
    })).toEqual({ tool: "crm_update_lead", proposalId: "proposal-1" });
  });

  it("keeps send-policy trace labels without persisting customer text", () => {
    expect(redactEventPayload("policy_checked", {
      decision: "veto", verdict: "veto", tool: "send_message", gate: "opt_out", code: "blocked",
      body: "private draft",
    })).toEqual({ decision: "veto", verdict: "veto", tool: "send_message", gate: "opt_out", code: "blocked" });
  });
});
