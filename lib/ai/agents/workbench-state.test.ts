import { describe, expect, it } from "vitest";
import {
  appendWorkbenchObservation,
  parseRuntimeMessages,
  specialistObservationEnvelope,
} from "./workbench-state";

describe("durable Pi workbench state", () => {
  it("parses only CRM runtime message shapes", () => {
    expect(parseRuntimeMessages([{ role: "user", content: "task" }])).toEqual([
      { role: "user", content: "task" },
    ]);
    expect(parseRuntimeMessages([{ role: "assistant", content: 9 }])).toBeNull();
  });

  it("appends a bounded result observation and removes credential-shaped fields", () => {
    const next = appendWorkbenchObservation([{ role: "user", content: "move the lead" }], {
      tool: "crm_move_lead_stage",
      status: "executed",
      result: { lead_id: "lead-1", api_key: "never" },
    });
    expect(next).toHaveLength(2);
    expect(next[1]?.role).toBe("user");
    expect(JSON.stringify(next)).not.toContain("never");
    expect(JSON.stringify(next)).toContain("[REDACTED]");
  });

  it("keeps specialist evidence in the database-required observation array", () => {
    const value = specialistObservationEnvelope([], []);
    expect(Array.isArray(value)).toBe(true);
    expect(value).toEqual([{ kind: "specialist_evidence", evidence: [], claims: [] }]);
  });
});
