import { describe, expect, it } from "vitest";
import {
  AUTOMATION_AGENT_KEYS,
  AUTOMATION_PROMPTS,
} from "@/lib/automation/prompts";
import {
  inferenceTargetForTask,
} from "@/lib/ai/routing";

describe("open-weight production routing", () => {
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
      if (key === "summarize_meeting") {
        continue;
      }

      expect(
        inferenceTargetForTask(key).backend,
        key
      ).toBe("openai");
    }
  });
});
