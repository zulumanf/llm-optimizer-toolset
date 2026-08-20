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
];

describe("assistant tool catalog", () => {
  it("every consequential tool requires confirmation", () => {
    for (const name of MUST_CONFIRM) {
      expect(CONFIRM_REQUIRED.has(name), `${name} must be confirm-gated`).toBe(true);
    }
  });

  it("no tool name that sends, publishes, approves, or starts a live run is direct", () => {
    for (const tool of ASSISTANT_TOOLS) {
      if (tool.tier === "confirm") continue;
      expect(tool.name, `${tool.name} looks consequential but is ${tool.tier}`).not.toMatch(
        /^(send|publish|approve)_|^start_/
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
