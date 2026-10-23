import { describe, expect, it } from "vitest";
import {
  AUTOMATION_AGENT_KEYS,
  AUTOMATION_PROMPTS,
} from "@/lib/automation/prompts";
import {
  inferenceTargetForTask,
  INTERNAL_TASK_TARGETS,
} from "@/lib/ai/routing";
import { LOCAL_INTERNAL_TARGETS } from "@/lib/ai/internal/registry";

describe("open-weight production routing", () => {
  it("migrates exactly the evaluated tasks, each to its evaluated local target", () => {
    expect(INTERNAL_TASK_TARGETS).toEqual({
      summarize_meeting: LOCAL_INTERNAL_TARGETS.cheap,
      summarize_support_request: LOCAL_INTERNAL_TARGETS.cheap,
      knowledge_claim_extraction: LOCAL_INTERNAL_TARGETS.qa,
      detect_contradictions: LOCAL_INTERNAL_TARGETS.reasoning,
    });
  });

  it("promotes summarize_meeting to the evaluated local target", () => {
    expect(
      inferenceTargetForTask("summarize_meeting")
    ).toEqual({
      backend: "ollama",
      model: "qwen3:8b",
      execution: "local",
    });

    expect(
      AUTOMATION_PROMPTS.summarize_meeting.backend
    ).toBe("ollama");

    expect(
      AUTOMATION_PROMPTS.summarize_meeting.model
    ).toBe("qwen3:8b");
  });

  it("does not silently migrate unevaluated automation tasks", () => {
    for (const key of AUTOMATION_AGENT_KEYS) {
      if (
        key === "summarize_meeting" ||
        key === "summarize_support_request" ||
        key === "detect_contradictions"
      ) {
        continue;
      }

      expect(
        inferenceTargetForTask(key).backend,
        key
      ).toBe("openai");
    }
  });
});
