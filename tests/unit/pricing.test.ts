import { describe, expect, it } from "vitest";
import { costMicroUsd } from "@/lib/ai/pricing";

describe("per-call fees (spec 117)", () => {
  it("adds the web-search per-call fee for +search models", () => {
    const base = costMicroUsd("gpt-5.4-mini-2026-03-17", 1000, 100);
    const search = costMicroUsd("gpt-5.4-mini-2026-03-17+search", 1000, 100);
    expect(search - base).toBe(10_000);
  });

  it("charges no fee for models without one", () => {
    expect(costMicroUsd("gpt-5.4-mini-2026-03-17", 0, 0)).toBe(0);
  });
});
