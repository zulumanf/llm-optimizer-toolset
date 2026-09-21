import { describe, expect, it } from "vitest";
import {
  LOCAL_INTERNAL_TARGETS,
  localTargetForRole,
} from "@/lib/ai/internal/registry";

describe("internal inference routing (spec 142)", () => {
  it("pins the intended local worker brains", () => {
    expect(localTargetForRole("cheap")).toEqual({
      backend: "ollama",
      model: "qwen3:8b",
      execution: "local",
    });

    expect(localTargetForRole("reasoning")).toEqual({
      backend: "ollama",
      model: "qwen3:30b",
      execution: "local",
    });

    expect(localTargetForRole("qa")).toEqual({
      backend: "ollama",
      model: "gpt-oss:20b",
      execution: "local",
    });
  });

  it("keeps QA on a different model family from the reasoning worker", () => {
    expect(LOCAL_INTERNAL_TARGETS.qa.model).not.toBe(
      LOCAL_INTERNAL_TARGETS.reasoning.model
    );
  });

  it("keeps every local role out of the measurement-provider registry concept", () => {
    for (const target of Object.values(LOCAL_INTERNAL_TARGETS)) {
      expect(target.backend).toBe("ollama");
      expect(target.execution).toBe("local");
    }
  });
});
