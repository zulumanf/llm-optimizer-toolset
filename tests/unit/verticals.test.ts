import { describe, expect, it } from "vitest";
import {
  expandPack,
  missingRequiredVariables,
  MAX_GENERATED_PROMPTS,
} from "@/lib/verticals/expand";
import { VERTICAL_PACKS, findPack } from "@/lib/verticals/packs";
import { validateContent } from "@/lib/content/validate";

const realEstate = findPack("real-estate-agent")!;

describe("vertical pack definitions", () => {
  it("every pack has unique keys, templates, and compliance rules", () => {
    const keys = VERTICAL_PACKS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const pack of VERTICAL_PACKS) {
      expect(pack.promptTemplates.length).toBeGreaterThan(5);
      expect(pack.claimKeys.length).toBeGreaterThan(0);
      expect(pack.compliance.length).toBeGreaterThan(0);
      // Every compliance pattern must actually compile
      for (const rule of pack.compliance) {
        expect(() => new RegExp(rule.pattern, "i")).not.toThrow();
      }
    }
  });

  it("every template placeholder is either a declared variable or reserved", () => {
    for (const pack of VERTICAL_PACKS) {
      const declared = new Set([
        ...pack.variables.map((v) => v.key),
        "brand",
        "competitor",
      ]);
      for (const template of pack.promptTemplates) {
        for (const match of template.text.matchAll(/\{(\w+)\}/g)) {
          expect(declared.has(match[1] as string)).toBe(true);
        }
      }
    }
  });

  it("each pack ships at least one holdout template", () => {
    for (const pack of VERTICAL_PACKS) {
      expect(pack.promptTemplates.some((t) => t.isHoldout)).toBe(true);
    }
  });
});

describe("expandPack", () => {
  const variables = {
    market: ["Jersey City", "Hoboken"],
    clientType: ["first-time buyers"],
    neighborhood: ["Downtown"],
    propertyType: ["condo"],
  };

  it("substitutes variables, brand, and competitors", () => {
    const prompts = expandPack({
      pack: realEstate,
      variables,
      brand: "Gambino Group",
      competitors: ["Compass"],
    });
    const texts = prompts.map((p) => p.text);
    expect(texts).toContain(
      "Who is the best real estate agent in Jersey City for first-time buyers?"
    );
    expect(texts.some((t) => t.includes("Gambino Group"))).toBe(true);
    expect(texts.some((t) => t.includes("Compass"))).toBe(true);
    expect(texts.every((t) => !t.includes("{"))).toBe(true);
  });

  it("is deterministic — same inputs, same benchmark", () => {
    const once = expandPack({ pack: realEstate, variables, brand: "X", competitors: ["Y"] });
    const twice = expandPack({ pack: realEstate, variables, brand: "X", competitors: ["Y"] });
    expect(once.map((p) => p.text)).toEqual(twice.map((p) => p.text));
  });

  it("skips templates whose variables the operator left blank", () => {
    const prompts = expandPack({
      pack: realEstate,
      variables: { market: ["Jersey City"], clientType: ["investors"] },
      brand: "X",
      competitors: [],
    });
    // neighborhood/propertyType templates must not appear with empty slots
    expect(prompts.every((p) => !p.text.includes("undefined"))).toBe(true);
    expect(prompts.some((p) => p.text.includes("neighborhood"))).toBe(false);
    // …and competitor templates vanish when no competitor is tracked
    expect(prompts.some((p) => p.text.includes("{competitor}"))).toBe(false);
  });

  it("caps generation and prioritises high-intent tiers", () => {
    const prompts = expandPack({
      pack: realEstate,
      variables: {
        market: ["A", "B", "C", "D", "E"],
        clientType: ["1", "2", "3", "4"],
        neighborhood: ["N1", "N2", "N3"],
        propertyType: ["P1", "P2", "P3"],
      },
      brand: "X",
      competitors: ["Y", "Z"],
    });
    expect(prompts).toHaveLength(MAX_GENERATED_PROMPTS);
    expect(prompts[0]?.tier).toBe(1);
  });

  it("deduplicates identical generated prompts", () => {
    const prompts = expandPack({
      pack: realEstate,
      variables: { market: ["Miami", "Miami"], clientType: ["sellers"] },
      brand: "X",
      competitors: [],
    });
    const texts = prompts.map((p) => p.text);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("reports missing required variables by label", () => {
    expect(missingRequiredVariables(realEstate, {})).toEqual([
      "Primary market(s)",
      "Client situation(s)",
    ]);
    expect(
      missingRequiredVariables(realEstate, {
        market: ["Miami"],
        clientType: ["buyers"],
      })
    ).toEqual([]);
  });
});

describe("pack compliance rules in the content gate", () => {
  const claimId = "11111111-2222-4333-8444-555555555555";
  const approved = new Set([claimId]);

  it("blocks fair-housing language for real-estate clients", () => {
    const result = validateContent(
      `We serve this market [claim:${claimId}]. It is a family-friendly neighborhood.`,
      ["Gambino"],
      approved,
      realEstate.compliance
    );
    expect(result.ok).toBe(false);
    expect(result.complianceHits.some((h) => h.ruleId === "fair-housing")).toBe(true);
    expect(result.complianceHits[0]?.severity).toBe("block");
  });

  it("blocks guaranteed-outcome language", () => {
    const result = validateContent(
      "We guarantee a sale within thirty days.",
      ["Gambino"],
      approved,
      realEstate.compliance
    );
    expect(result.complianceHits.some((h) => h.ruleId === "guaranteed-outcome")).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("warns without blocking on brokerage mentions", () => {
    const result = validateContent(
      "Choosing a realtor takes research.",
      ["Gambino"],
      approved,
      realEstate.compliance
    );
    const hits = result.complianceHits.filter((h) => h.severity === "block");
    expect(hits).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it("medical pack blocks outcome guarantees and superiority claims", () => {
    const medical = findPack("medical-aesthetics")!;
    const result = validateContent(
      "Dr Smith is the best surgeon and results are permanent results.",
      ["Dr Smith"],
      approved,
      medical.compliance
    );
    expect(result.ok).toBe(false);
    const ids = result.complianceHits.map((h) => h.ruleId);
    expect(ids).toContain("superiority-claim");
  });

  it("generic clients are unaffected when no rules are supplied", () => {
    const result = validateContent(
      `Parva is a link-in-bio tool [claim:${claimId}].`,
      ["Parva"],
      approved
    );
    expect(result.complianceHits).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
