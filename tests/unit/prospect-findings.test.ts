/**
 * Unit tests for the deterministic reality-to-AI finding generator and the
 * prohibited-wording guard (spec 032).
 */
import { describe, expect, it } from "vitest";
import {
  generateFindingCandidates,
  type BenchmarkEntityMetrics,
  type GeneratorInput,
} from "@/lib/prospects/findings";
import {
  findProhibitedPhrase,
  MIN_RESPONSES_FOR_FINDINGS,
} from "@/lib/prospects/constants";

const entity = (
  overrides: Partial<BenchmarkEntityMetrics> & { companyId: string; name: string }
): BenchmarkEntityMetrics => ({
  mentionRate: null,
  recommendationRate: null,
  shareOfVoice: null,
  citationScore: null,
  sampleSize: 40,
  scoreIds: {},
  ...overrides,
});

const baseInput = (): GeneratorInput => ({
  prospectName: "The Rivera Team",
  prospect: entity({
    companyId: "p1",
    name: "The Rivera Team",
    mentionRate: 0.1,
    recommendationRate: 0.08,
    shareOfVoice: 0.05,
    sampleSize: 40,
  }),
  competitors: [
    entity({
      companyId: "c1",
      name: "Acme Realty",
      mentionRate: 0.6,
      recommendationRate: 0.55,
      citationScore: 0.3,
      sampleSize: 40,
    }),
  ],
  signals: [
    {
      id: "s1",
      kind: "ranking",
      label: "Ranked #2 Manhattan team by closed volume (The Real Deal, 2025)",
      provenance: "publicly_sourced",
    },
  ],
  absence: [{ competitorCompanyId: "c1", responseIds: ["r1", "r2", "r3"] }],
  prospectAbsentResponseIds: ["r1", "r2", "r3", "r4"],
});

describe("generateFindingCandidates", () => {
  it("produces authority-gap, contrast, absence and citation candidates with evidence", () => {
    const candidates = generateFindingCandidates(baseInput());
    const kinds = candidates.map((c) => c.kind);
    expect(kinds).toContain("authority_visibility_gap");
    expect(kinds).toContain("competitor_contrast");
    expect(kinds).toContain("absence");
    expect(kinds).toContain("citation_gap");
    for (const c of candidates) {
      expect(c.responseIds.length).toBeGreaterThan(0);
      expect(c.confidence).toBeGreaterThan(0);
      expect(c.confidence).toBeLessThanOrEqual(0.95);
    }
  });

  it("never emits prohibited revenue/causality wording", () => {
    const candidates = generateFindingCandidates(baseInput());
    for (const c of candidates) {
      expect(findProhibitedPhrase(c.title)).toBeNull();
      expect(findProhibitedPhrase(c.explanation)).toBeNull();
      expect(findProhibitedPhrase(c.businessRelevance)).toBeNull();
      expect(findProhibitedPhrase(c.suggestedAngle)).toBeNull();
    }
  });

  it("v2 precision (spec 094): no asserted benchmark, no 'the team', counts as the unit", () => {
    const candidates = generateFindingCandidates(baseInput());
    for (const c of candidates) {
      const text = `${c.title} ${c.explanation}`;
      // The rank-predicts-visibility overreach the sense-check flagged on
      // all 14 live audits.
      expect(text).not.toMatch(/underrepresented relative to/i);
      expect(text).not.toMatch(/weaker than .* documented market position/i);
      // Entity-neutral language: the prospect may be an individual.
      expect(text).not.toMatch(/\bthe team\b/i);
    }
    // Counts are the primary unit: 0.08 × 40 = "3 of 40", never "8%".
    const gap = candidates.find((c) => c.kind === "authority_visibility_gap")!;
    expect(gap.explanation).toContain("3 of 40");
    const contrast = candidates.find((c) => c.kind === "competitor_contrast")!;
    expect(contrast.explanation).toContain("recommended in 22");
    expect(contrast.explanation).toContain("recommended in 3");
    const absence = candidates.find((c) => c.kind === "absence")!;
    expect(absence.explanation).toContain("4 of 40");
    expect(absence.explanation).toContain("(10%)");
  });

  it("is deterministic and ranked", () => {
    const a = generateFindingCandidates(baseInput());
    const b = generateFindingCandidates(baseInput());
    expect(a).toEqual(b);
    for (let i = 1; i < a.length; i += 1) {
      expect(a[i - 1]!.rankScore).toBeGreaterThanOrEqual(a[i]!.rankScore);
    }
  });

  it("refuses to reason over tiny samples", () => {
    const input = baseInput();
    input.prospect.sampleSize = MIN_RESPONSES_FOR_FINDINGS - 1;
    expect(generateFindingCandidates(input)).toEqual([]);
  });

  it("skips the authority-gap finding without a verifiable signal", () => {
    const input = baseInput();
    input.signals = [
      { id: "s1", kind: "ranking", label: "Probably a top team", provenance: "estimated" },
    ];
    const kinds = generateFindingCandidates(input).map((c) => c.kind);
    expect(kinds).not.toContain("authority_visibility_gap");
  });

  it("skips competitor contrast when the gap is small or unevidenced", () => {
    const input = baseInput();
    input.competitors = [
      entity({
        companyId: "c1",
        name: "Acme Realty",
        recommendationRate: 0.15, // gap 0.07 < 0.15 threshold
        sampleSize: 40,
      }),
    ];
    const kinds = generateFindingCandidates(input).map((c) => c.kind);
    expect(kinds).not.toContain("competitor_contrast");

    const input2 = baseInput();
    input2.absence = []; // big gap but no evidence responses
    const kinds2 = generateFindingCandidates(input2).map((c) => c.kind);
    expect(kinds2).not.toContain("competitor_contrast");
  });

  it("treats null metrics as unmeasured, not zero", () => {
    const input = baseInput();
    input.prospect.mentionRate = null;
    input.prospect.recommendationRate = null;
    const kinds = generateFindingCandidates(input).map((c) => c.kind);
    expect(kinds).not.toContain("absence");
    expect(kinds).not.toContain("authority_visibility_gap");
    expect(kinds).not.toContain("competitor_contrast");
  });
});

describe("findProhibitedPhrase", () => {
  it("catches revenue-loss claims case-insensitively", () => {
    expect(findProhibitedPhrase("You are LOSING REVENUE every day")).toBe("losing revenue");
    expect(findProhibitedPhrase("this gap is Costing You $2m")).toBe("costing you");
    expect(findProhibitedPhrase("our revolutionary approach")).toBe("revolutionary");
  });
  it("passes observation language", () => {
    expect(
      findProhibitedPhrase(
        "The team appears underrepresented and is recommended less frequently than competitors."
      )
    ).toBeNull();
  });
});
