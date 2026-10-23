import { describe, expect, it } from "vitest";
import {
  inferenceTargetForTask,
  INTERNAL_TASK_TARGETS,
} from "@/lib/ai/routing";
import { LOCAL_INTERNAL_TARGETS } from "@/lib/ai/internal/registry";
import { AUTOMATION_PROMPTS } from "@/lib/automation/prompts";

describe("support triage open-weight promotion", () => {
  it("pins summarize_support_request to the approved local cheap target", () => {
    expect(
      INTERNAL_TASK_TARGETS.summarize_support_request
    ).toEqual(LOCAL_INTERNAL_TARGETS.cheap);

    expect(
      inferenceTargetForTask(
        "summarize_support_request"
      )
    ).toEqual(LOCAL_INTERNAL_TARGETS.cheap);
  });

  it("propagates the local backend and model into the production prompt", () => {
    const target =
      inferenceTargetForTask(
        "summarize_support_request"
      );

    const prompt =
      AUTOMATION_PROMPTS.summarize_support_request;

    expect(prompt.backend).toBe(
      target.backend
    );

    expect(prompt.model).toBe(
      target.model
    );

    expect(target.backend).toBe(
      "ollama"
    );

    expect(target.execution).toBe(
      "local"
    );
  });

  it("does not bulk-migrate unevaluated tasks", () => {
    expect(
      inferenceTargetForTask(
        "classify_lead"
      ).backend
    ).toBe("openai");

    expect(
      inferenceTargetForTask(
        "extract_claims"
      ).backend
    ).toBe("openai");
  });
});
