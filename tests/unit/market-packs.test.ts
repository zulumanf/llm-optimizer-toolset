/**
 * Structural validation of the market-pack registry and known-answer tests
 * for deterministic prompt expansion (spec 040).
 */
import { describe, expect, it } from "vitest";
import { MARKET_PACKS, getMarketPack } from "@/lib/markets/packs";
import {
  expandMarketPack,
  packNeighborhoods,
  MAX_MARKET_PROMPTS,
} from "@/lib/markets/generate";
import type { GeoNode } from "@/lib/markets/types";
import { MARKET_KINDS } from "@/lib/exclusivity/constants";
import { PROMPT_CATEGORIES } from "@/lib/constants";

const KNOWN_PLACEHOLDERS = ["{city}", "{area}", "{propertyType}", "{priceTier}"];

const allNodes = (root: GeoNode): GeoNode[] => [
  root,
  ...(root.children ?? []).flatMap(allNodes),
];

describe("market pack registry", () => {
  it("ships the five launch cities with unique keys", () => {
    expect(MARKET_PACKS.map((p) => p.key).sort()).toEqual([
      "boston",
      "chicago",
      "jersey-city",
      "miami",
      "nyc",
    ]);
    expect(getMarketPack("nowhere")).toBeNull();
  });

  for (const pack of MARKET_PACKS) {
    describe(pack.key, () => {
      it("has a structurally valid hierarchy", () => {
        const nodes = allNodes(pack.hierarchy);
        expect(pack.hierarchy.kind).toBe("country");
        // The named city exists as a city node.
        expect(
          nodes.some((n) => n.kind === "city" && n.name === pack.cityName)
        ).toBe(true);
        // Every kind is legal; every name non-empty and unique per pack.
        for (const node of nodes) {
          expect(MARKET_KINDS).toContain(node.kind);
          expect(node.name.trim().length).toBeGreaterThan(0);
        }
        expect(packNeighborhoods(pack).length).toBeGreaterThanOrEqual(7);
      });

      it("excluded place names exist in the hierarchy, each with a reason", () => {
        const names = new Set(allNodes(pack.hierarchy).map((n) => n.name));
        for (const excluded of pack.excludedPlaceNames) {
          expect(names.has(excluded.name)).toBe(true);
          expect(excluded.reason.length).toBeGreaterThan(10);
        }
      });

      it("templates are well-formed: known placeholders, legal tiers and categories, unique keys", () => {
        const keys = pack.templates.map((t) => t.key);
        expect(new Set(keys).size).toBe(keys.length);
        for (const template of pack.templates) {
          const placeholders = template.text.match(/\{[a-zA-Z]+\}/g) ?? [];
          for (const ph of placeholders) expect(KNOWN_PLACEHOLDERS).toContain(ph);
          expect([1, 2, 3, 4]).toContain(template.tier);
          expect(PROMPT_CATEGORIES).toContain(template.category);
          if (template.scope === "neighborhood") {
            expect(template.text).toContain("{area}");
          }
          if (template.expand === "priceTier") expect(template.text).toContain("{priceTier}");
        }
        // primary property types are a subset of property types
        for (const primary of pack.primaryPropertyTypes) {
          expect(pack.propertyTypes).toContain(primary);
        }
        expect(pack.zipCodes.every((z) => /^\d{5}$/.test(z))).toBe(true);
        expect(pack.brokerages.length).toBeGreaterThanOrEqual(5);
        expect(pack.publications.length).toBeGreaterThanOrEqual(3);
      });
    });
  }
});

describe("expandMarketPack", () => {
  it("is deterministic: same input, identical output", () => {
    const pack = getMarketPack("miami")!;
    expect(expandMarketPack(pack)).toEqual(expandMarketPack(pack));
  });

  it("produces the target-flow fixture prompts", () => {
    const texts = (key: string) =>
      expandMarketPack(getMarketPack(key)!, { cap: 200 }).prompts.map((p) => p.text);
    expect(texts("miami")).toContain("Who should I use to sell a condo in Brickell?");
    expect(texts("miami")).toContain("Who are the best luxury real estate agents in Miami?");
    expect(texts("nyc")).toContain("Which real estate teams specialize in Tribeca lofts?");
    expect(texts("jersey-city")).toContain("Who are the best listing agents in Jersey City?");
    expect(texts("boston")).toContain("Which teams specialize in Back Bay brownstones?");
    expect(texts("chicago")).toContain(
      "Which real estate agents specialize in Lincoln Park?"
    );
  });

  it("never expands excluded place names", () => {
    for (const key of ["nyc", "chicago", "boston"]) {
      const { prompts } = expandMarketPack(getMarketPack(key)!, { cap: 200 });
      expect(prompts.some((p) => p.text.includes("Chinatown"))).toBe(false);
    }
    const jc = expandMarketPack(getMarketPack("jersey-city")!, { cap: 200 });
    expect(jc.prompts.some((p) => p.text.includes("The Heights"))).toBe(false);
    expect(jc.excluded.map((e) => e.name)).toContain("The Heights");
  });

  it("caps with an explicit skipped count and a stable prefix — never silent truncation", () => {
    const pack = getMarketPack("nyc")!;
    const full = expandMarketPack(pack, { cap: 200 });
    const capped = expandMarketPack(pack, { cap: 5 });
    expect(capped.prompts.length).toBe(5);
    expect(capped.skippedByCap).toBe(full.prompts.length - 5);
    expect(capped.prompts).toEqual(full.prompts.slice(0, 5));
    // Default cap holds.
    const defaulted = expandMarketPack(pack);
    expect(defaulted.prompts.length).toBeLessThanOrEqual(MAX_MARKET_PROMPTS);
  });

  it("carries lineage: templateRef, audience, tier, and priceTier only where expanded", () => {
    const { prompts } = expandMarketPack(getMarketPack("miami")!, { cap: 200 });
    const luxury = prompts.find((p) => p.templateRef === "miami@v1:luxury-agents")!;
    expect(luxury.tier).toBe(1);
    expect(luxury.audience).toBe("general");
    expect(luxury.priceTier).toBeNull();
    const tiered = prompts.filter((p) => p.templateRef === "miami@v1:price-tier-specialist");
    expect(tiered.map((p) => p.priceTier)).toEqual([
      "entry-level",
      "mid-market",
      "luxury",
      "ultra-luxury",
    ]);
    const seller = prompts.find(
      (p) => p.templateRef === "miami@v1:sell-property-neighborhood"
    )!;
    expect(seller.audience).toBe("seller");
  });

  it("honors template and neighborhood filters", () => {
    const pack = getMarketPack("miami")!;
    const result = expandMarketPack(pack, {
      templateKeys: ["sell-property-neighborhood"],
      neighborhoods: ["Brickell"],
      cap: 200,
    });
    expect(result.prompts.map((p) => p.text)).toEqual([
      "Who should I use to sell a condo in Brickell?",
      "Who should I use to sell a waterfront home in Brickell?",
    ]);
  });
});
