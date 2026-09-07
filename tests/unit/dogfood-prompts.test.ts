/**
 * Dogfood prompt-universe invariants. The branded/unbranded split is
 * load-bearing: branded controls are excluded from every visibility rate via
 * prompt-echo (they name the brand), so a branded prompt that does NOT name
 * the brand — or an unbranded one that does — silently corrupts the KPIs.
 */
import { describe, expect, it } from "vitest";
import {
  DOGFOOD_BRAND,
  DOGFOOD_PROMPTS,
  dogfoodTierCounts,
} from "@/lib/dogfood/prompts";

const branded = DOGFOOD_PROMPTS.filter((p) => p.category === "branded");
const unbranded = DOGFOOD_PROMPTS.filter((p) => p.category !== "branded");

describe("dogfood prompt universe", () => {
  it("is a 25-40 prompt universe with a small branded control group", () => {
    expect(DOGFOOD_PROMPTS.length).toBeGreaterThanOrEqual(25);
    expect(DOGFOOD_PROMPTS.length).toBeLessThanOrEqual(40);
    expect(unbranded.length).toBeGreaterThanOrEqual(25);
    expect(branded.length).toBeGreaterThanOrEqual(2);
    expect(branded.length).toBeLessThanOrEqual(5);
  });

  it("every branded control names the brand (guarantees echo exclusion)", () => {
    for (const p of branded) {
      expect(p.text).toContain(DOGFOOD_BRAND);
      expect(p.tier).toBe(4);
    }
  });

  it("no unbranded prompt names the brand (nothing leaks out of the rates)", () => {
    const brandWord = new RegExp(`\\b${DOGFOOD_BRAND}\\b|Recommended First`, "i");
    for (const p of unbranded) {
      expect(p.text).not.toMatch(brandWord);
    }
  });

  it("primary reporting has tier 1-2 mass and no duplicates", () => {
    const tiers = dogfoodTierCounts();
    expect(tiers[1] + tiers[2]).toBeGreaterThanOrEqual(20);
    const texts = new Set(DOGFOOD_PROMPTS.map((p) => p.text.toLowerCase()));
    expect(texts.size).toBe(DOGFOOD_PROMPTS.length);
  });
});
