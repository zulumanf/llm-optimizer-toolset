import { describe, expect, it } from "vitest";

import {
  inferenceTargetForTask,
  INTERNAL_TASK_TARGETS,
} from "@/lib/ai/routing";
import {
  LOCAL_INTERNAL_TARGETS,
} from "@/lib/ai/internal/registry";

describe("canonical knowledge claim extraction open-weight promotion", () => {
  it("pins canonical knowledge extraction to evaluated GPT-OSS", () => {
    expect(
      INTERNAL_TASK_TARGETS.knowledge_claim_extraction
    ).toEqual(
      LOCAL_INTERNAL_TARGETS.qa
    );

    expect(
      inferenceTargetForTask(
        "knowledge_claim_extraction"
      )
    ).toEqual({
      backend: "ollama",
      model: "gpt-oss:20b",
      execution: "local",
    });
  });

  it("does not promote the weaker automation extract_claims task", () => {
    const target =
      inferenceTargetForTask(
        "extract_claims"
      );

    expect(target.backend).toBe(
      "openai"
    );

    expect(target.execution).toBe(
      "paid_api"
    );
  });
});
