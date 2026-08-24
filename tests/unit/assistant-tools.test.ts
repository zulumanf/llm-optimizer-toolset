/**
 * Spec 096 catalog discipline: every tool that spends money or crosses a
 * consequence line is confirm-gated — asserted structurally, like the MCP
 * observer/operator split. A new consequential tool that forgets its tier
 * fails here, not in production.
 */
import { describe, expect, it } from "vitest";
import { ASSISTANT_TOOLS, CONFIRM_REQUIRED } from "@/lib/assistant/tools";

const MUST_CONFIRM = [
  "start_benchmark_run",
  "approve_finding",
  "publish_audit",
  "approve_draft",
  "send_draft",
  "schedule_send",
  "approve_enrichment",
  "advance_stage",
  // Spec 102: cancels reverse a human-confirmed decision; retry re-enters
  // budget-spending lanes.
  "cancel_city_pipeline",
  "retry_city_pipeline",
  "cancel_scheduled_send",
  // Spec 103: reviewing creates or discards staged work; rejecting is the
  // approve twin.
  "review_discovery_candidate",
  "reject_enrichment_proposal",
  // Spec 104: cancel reverses a confirmed start; retry re-spends budget.
  "cancel_run",
  "retry_failed_cells",
  // Spec 105: the outreach compliance spine.
  "suppress_contact",
  "lift_suppression",
  "set_sender_identity",
  "stop_sequence",
];

describe("assistant tool catalog", () => {
  it("every consequential tool requires confirmation", () => {
    for (const name of MUST_CONFIRM) {
      expect(CONFIRM_REQUIRED.has(name), `${name} must be confirm-gated`).toBe(true);
    }
  });

  it("no tool name that sends, publishes, approves, reviews, rejects, cancels, retries, or starts a live run is direct", () => {
    for (const tool of ASSISTANT_TOOLS) {
      if (tool.tier === "confirm") continue;
      expect(tool.name, `${tool.name} looks consequential but is ${tool.tier}`).not.toMatch(
        /^(send|publish|approve|cancel|retry|review|reject|suppress|lift|stop|set)_|^start_/
      );
    }
  });

  it("every confirm tool carries a human-readable summary builder", () => {
    for (const tool of ASSISTANT_TOOLS.filter((t) => t.tier === "confirm")) {
      expect(tool.summarize, `${tool.name} needs summarize`).toBeDefined();
    }
  });

  it("tool names are unique across the belt", () => {
    const names = ASSISTANT_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("describeSchema — the catalog can never drift from validation", () => {
  it("renders research_market's exact shape", async () => {
    const { describeSchema, getAssistantTool } = await import("@/lib/assistant/tools");
    const shape = describeSchema(getAssistantTool("research_market")!.schema);
    expect(shape).toBe('{"city_name": string, "state": string}');
  });

  it("renders uuids, enums, optionals, arrays and datetimes readably", async () => {
    const { describeSchema, getAssistantTool } = await import("@/lib/assistant/tools");
    expect(describeSchema(getAssistantTool("schedule_send")!.schema)).toContain('"draft_id": uuid');
    expect(describeSchema(getAssistantTool("schedule_send")!.schema)).toContain("iso-datetime");
    expect(describeSchema(getAssistantTool("start_benchmark_run")!.schema)).toContain('"providers": [{');
    expect(describeSchema(getAssistantTool("enrich_prospect")!.schema)).toContain('"force"?: boolean');
  });

  it("renders the spec-102 operator tools' shapes", async () => {
    const { describeSchema, getAssistantTool } = await import("@/lib/assistant/tools");
    expect(describeSchema(getAssistantTool("list_city_pipelines")!.schema)).toBe(
      '{"status"?: "active"|"failed"|"completed"|"cancelled"|"all", "limit"?: number}'
    );
    expect(describeSchema(getAssistantTool("cancel_city_pipeline")!.schema)).toBe(
      '{"pipeline_id": uuid, "reason": string}'
    );
    expect(describeSchema(getAssistantTool("run_sense_check")!.schema)).toBe(
      '{"prospect_id": uuid}'
    );
  });

  it("renders the spec-103 review tools' shapes", async () => {
    const { describeSchema, getAssistantTool } = await import("@/lib/assistant/tools");
    expect(describeSchema(getAssistantTool("review_discovery_candidate")!.schema)).toBe(
      '{"candidate_id": uuid, "decision": "approve"|"dismiss", "company_id"?: uuid}'
    );
    expect(describeSchema(getAssistantTool("list_discovery_candidates")!.schema)).toContain(
      '"status"?: "pending"|"approved"|"dismissed"|"duplicate"|"all"'
    );
  });
});
