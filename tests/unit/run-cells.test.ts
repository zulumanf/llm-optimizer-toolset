import { describe, expect, it } from "vitest";
import { expandCells, estimateRun } from "@/lib/runs/cells";
import { costMicroUsd, usdToMicro, microToUsd } from "@/lib/ai/pricing";
import type { FrozenPrompt } from "@/lib/prompts/types";

const prompts: FrozenPrompt[] = [
  { promptId: "p1", text: "What are the best tools?", category: "recommendation", language: "en", position: 1 },
  { promptId: "p2", text: "Compare Parva and Acme", category: "comparison", language: "en", position: 2 },
];

describe("expandCells", () => {
  it("produces prompts × providers × repetitions cells in prompt order", () => {
    const cells = expandCells(prompts, [
      { provider: "mock", model: "mock-model", repetitions: 3 },
      { provider: "anthropic", model: "claude-opus-5", repetitions: 2 },
    ]);
    expect(cells).toHaveLength(2 * (3 + 2));
    expect(cells[0]).toMatchObject({ promptId: "p1", model: "mock-model", repetition: 1 });
    expect(cells[4]?.model).toBe("claude-opus-5");
    // repetitions are 1-indexed and sequential per (prompt, provider, model)
    const reps = cells
      .filter((c) => c.promptId === "p1" && c.model === "mock-model")
      .map((c) => c.repetition);
    expect(reps).toEqual([1, 2, 3]);
  });

  it("respects frozen position ordering, not array order", () => {
    const shuffled = [...prompts].reverse();
    const cells = expandCells(shuffled, [
      { provider: "mock", model: "mock-model", repetitions: 1 },
    ]);
    expect(cells.map((c) => c.promptId)).toEqual(["p1", "p2"]);
  });
});

describe("estimateRun", () => {
  it("estimates with documented assumptions (chars/4 in, 600 out)", () => {
    const est = estimateRun(
      [prompts[0]!],
      [{ provider: "anthropic", model: "claude-opus-5", repetitions: 2 }]
    );
    // "What are the best tools?" = 24 chars → 6 tokens in; 600 out
    // µ$ per cell = 6×5 + 600×25 = 15030; two reps = 30060
    expect(est.cellCount).toBe(2);
    expect(est.estimatedMicroUsd).toBe(30060);
    expect(est.unverifiedPricing).toEqual([]);
  });

  it("flags models with unverified pricing", () => {
    const est = estimateRun(
      [prompts[0]!],
      [{ provider: "google", model: "gemini-2.5-pro", repetitions: 1 }]
    );
    expect(est.unverifiedPricing).toEqual(["gemini-2.5-pro"]);
  });
});

describe("micro-dollar cost math", () => {
  it("computes integer micro-dollars from token usage", () => {
    // opus-5: $5/MTok in, $25/MTok out → 1000 in + 200 out = 5000 + 5000 µ$
    expect(costMicroUsd("claude-opus-5", 1000, 200)).toBe(10_000);
    expect(microToUsd(10_000)).toBeCloseTo(0.01);
  });

  it("accumulates without float drift across many small calls", () => {
    let total = 0;
    for (let i = 0; i < 1000; i += 1) {
      total += costMicroUsd("mock-model", 10, 50); // 60 µ$ each
    }
    expect(total).toBe(60_000);
  });

  it("round-trips budget caps", () => {
    expect(usdToMicro(15)).toBe(15_000_000);
    expect(usdToMicro(0.5)).toBe(500_000);
  });

  it("throws for unknown models rather than recording $0 (A2: a silent 0 disables budget caps)", () => {
    expect(() => costMicroUsd("unknown-model", 1000, 1000)).toThrowError(
      /No pricing entry/
    );
  });
});
