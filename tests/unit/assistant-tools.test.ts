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
  // Spec 106: approving republishes a prospect-facing page; dismissing
  // discards staged review work.
  "approve_audit_refresh",
  "dismiss_audit_refresh",
  // Spec 108: an experiment commits future spend; a learning is durable
  // and never auto-generated.
  "create_experiment",
  "record_learning",
  // Spec 111: the close creates a client project and an ACTIVE agreement.
  "promote_prospect_to_client",
  // Spec 114: standing preferences steer all future turns.
  "set_my_preferences",
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
        /^(send|publish|approve|cancel|retry|review|reject|suppress|lift|stop|set|dismiss|promote)_|^start_/
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

describe("catalog compaction (spec 107)", () => {
  it("every tool is mapped to exactly one group, and every mapping names a real tool", async () => {
    const { TOOL_GROUPS } = await import("@/lib/assistant/tools");
    const { MCP_TOOLS } = await import("@/lib/mcp/tools");
    for (const tool of ASSISTANT_TOOLS) {
      expect(TOOL_GROUPS[tool.name], `${tool.name} needs a group in TOOL_GROUPS`).toBeDefined();
    }
    const known = new Set([
      ...ASSISTANT_TOOLS.map((t) => t.name),
      ...MCP_TOOLS.map((t) => t.name),
    ]);
    for (const name of Object.keys(TOOL_GROUPS)) {
      expect(known.has(name), `TOOL_GROUPS names unknown tool "${name}"`).toBe(true);
    }
  });

  it("summaryOf takes the first sentence, deterministically", async () => {
    const { summaryOf } = await import("@/lib/assistant/tools");
    expect(summaryOf("First thing. Second thing.")).toBe("First thing.");
    expect(summaryOf("No trailing period at all")).toBe("No trailing period at all");
    expect(summaryOf("One sentence only.")).toBe("One sentence only.");
  });

  it("the compact catalog stays under the ratchet and lists every tool once", async () => {
    const { compactCatalog } = await import("@/lib/assistant/tools");
    const { MCP_TOOLS } = await import("@/lib/mcp/tools");
    const catalog = compactCatalog();
    // The spec-107 ratchet. Raised 11k → 12k with spec 114 (81 tools):
    // three rounds of first-sentence trims established ~135 chars/line as
    // the honest floor, so the old limit had become a per-tool tax, not a
    // compaction guard. Next conscious review when this fires again.
    expect(catalog.length).toBeLessThan(12_000);
    for (const tool of ASSISTANT_TOOLS) {
      expect(catalog).toContain(`- ${tool.name}`);
    }
    for (const tool of MCP_TOOLS.filter((t) => t.group === "observer")) {
      expect(catalog).toContain(`- ${tool.name}`);
    }
    // Confirm markers present; input shapes absent.
    expect(catalog).toContain("- send_draft (confirm):");
    expect(catalog).not.toContain("Input: {");
  });

  it("describe_tools returns full guidance + shape for known names, unknown rows for misses", async () => {
    const { runAssistantTool } = await import("@/lib/assistant/tools");
    const user = { id: "u", email: "u@test", name: "U", role: "operator" as const };
    const rows = (await runAssistantTool(user, "describe_tools", {
      names: ["send_draft", "list_projects", "no_such_tool", "send_draft"],
    })) as Array<Record<string, unknown>>;
    expect(rows.length).toBe(3); // deduped
    const send = rows.find((r) => r.name === "send_draft")!;
    expect(String(send.description)).toContain("REQUIRES OPERATOR CONFIRMATION");
    expect(String(send.input)).toContain('"business_purpose": string');
    const observer = rows.find((r) => r.name === "list_projects")!;
    expect(observer.tier).toBe("read");
    expect(String(observer.input)).toBeTruthy();
    expect(rows.find((r) => r.name === "no_such_tool")!.unknown).toBe(true);
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

  it("renders approve_audit_refresh's nested attestation shape", async () => {
    const { describeSchema, getAssistantTool } = await import("@/lib/assistant/tools");
    const shape = describeSchema(getAssistantTool("approve_audit_refresh")!.schema);
    expect(shape).toContain('"human_finding": {"text": string');
    expect(shape).toContain('"acknowledge_warnings"?: {"reason": string}');
  });
});
