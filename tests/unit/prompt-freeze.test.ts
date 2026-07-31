import { describe, expect, it } from "vitest";
import { isSameContent } from "@/lib/prompts/freeze";
import { diffVersions } from "@/lib/prompts/diff";
import { addPromptSchema, updatePromptSchema } from "@/lib/prompts/validation";
import type { FrozenPrompt } from "@/lib/prompts/types";

function fp(overrides: Partial<FrozenPrompt> & { position: number }): FrozenPrompt {
  return {
    promptId: overrides.promptId ?? `id-${overrides.position}`,
    text: overrides.text ?? `prompt ${overrides.position}`,
    category: overrides.category ?? "recommendation",
    language: overrides.language ?? "en",
    position: overrides.position,
  };
}

describe("isSameContent (freeze identity)", () => {
  const base = [fp({ position: 1 }), fp({ position: 2 })];

  it("matches identical content regardless of prompt ids", () => {
    const other = base.map((p, i) => ({ ...p, promptId: `different-${i}` }));
    expect(isSameContent(base, other)).toBe(true);
  });

  it("detects text, category, and language changes", () => {
    expect(
      isSameContent(base, [fp({ position: 1, text: "reworded" }), base[1]!])
    ).toBe(false);
    expect(
      isSameContent(base, [fp({ position: 1, category: "comparison" }), base[1]!])
    ).toBe(false);
    expect(
      isSameContent(base, [fp({ position: 1, language: "es" }), base[1]!])
    ).toBe(false);
  });

  it("detects order changes and length changes", () => {
    const swapped = [
      { ...base[1]!, position: 1 },
      { ...base[0]!, position: 2 },
    ];
    expect(isSameContent(base, swapped)).toBe(false);
    expect(isSameContent(base, [base[0]!])).toBe(false);
  });

  it("is insensitive to raw position values, only order matters", () => {
    const renumbered = [
      { ...base[0]!, position: 10 },
      { ...base[1]!, position: 20 },
    ];
    expect(isSameContent(base, renumbered)).toBe(true);
  });

  it("treats tier as metadata, not identity (migration 030)", () => {
    // Retagging tiers changes nothing about what a run sends to providers,
    // so it must not force a new frozen version.
    const tiered = [
      { ...base[0]!, tier: 1 },
      { ...base[1]!, tier: 4 },
    ];
    const retiered = [
      { ...base[0]!, tier: 2 },
      { ...base[1]!, tier: null },
    ];
    expect(isSameContent(base, tiered)).toBe(true);
    expect(isSameContent(tiered, retiered)).toBe(true);
  });
});

describe("frozen snapshots carry tier", () => {
  it("preserves tier on FrozenPrompt entries, null and absent included", () => {
    const snapshot: FrozenPrompt[] = [
      { ...fp({ position: 1 }), tier: 1 },
      { ...fp({ position: 2 }), tier: null },
      fp({ position: 3 }), // pre-migration-030 snapshot shape
    ];
    expect(snapshot[0]?.tier).toBe(1);
    expect(snapshot[1]?.tier).toBeNull();
    expect(snapshot[2]?.tier).toBeUndefined();
  });
});

describe("prompt tier validation (migration 030 bounds)", () => {
  const valid = {
    setId: "3e0a1c9a-0000-4000-8000-000000000001",
    text: "best crm for realtors",
    category: "recommendation",
  };

  it("accepts tiers 1-4 and an absent tier", () => {
    for (const tier of [1, 2, 3, 4]) {
      expect(addPromptSchema.safeParse({ ...valid, tier }).success).toBe(true);
    }
    expect(addPromptSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects out-of-range and non-integer tiers", () => {
    for (const tier of [0, 5, -1, 2.5]) {
      expect(addPromptSchema.safeParse({ ...valid, tier }).success).toBe(false);
    }
  });

  it("updatePromptSchema enforces the same bounds", () => {
    const promptId = "3e0a1c9a-0000-4000-8000-000000000002";
    expect(updatePromptSchema.safeParse({ promptId, tier: 3 }).success).toBe(true);
    expect(updatePromptSchema.safeParse({ promptId, tier: 0 }).success).toBe(false);
    expect(updatePromptSchema.safeParse({ promptId, tier: 5 }).success).toBe(false);
  });
});

describe("diffVersions", () => {
  it("classifies added, removed, changed, and unchanged", () => {
    const before = [
      fp({ promptId: "keep", position: 1 }),
      fp({ promptId: "gone", position: 2 }),
      fp({ promptId: "edit", position: 3, text: "old wording" }),
    ];
    const after = [
      fp({ promptId: "keep", position: 1 }),
      fp({ promptId: "edit", position: 2, text: "new wording" }),
      fp({ promptId: "new", position: 3 }),
    ];
    const diff = diffVersions(before, after);
    expect(diff.added.map((p) => p.promptId)).toEqual(["new"]);
    expect(diff.removed.map((p) => p.promptId)).toEqual(["gone"]);
    expect(diff.changed.map((c) => c.after.promptId)).toEqual(["edit"]);
    expect(diff.changed[0]?.before.text).toBe("old wording");
    expect(diff.unchangedCount).toBe(1);
  });

  it("treats a category change as changed, not add/remove", () => {
    const before = [fp({ promptId: "x", position: 1 })];
    const after = [fp({ promptId: "x", position: 1, category: "branded" })];
    const diff = diffVersions(before, after);
    expect(diff.changed).toHaveLength(1);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it("returns empty diff for identical snapshots", () => {
    const snap = [fp({ position: 1 }), fp({ position: 2 })];
    const diff = diffVersions(snap, snap);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
    expect(diff.unchangedCount).toBe(2);
  });
});
