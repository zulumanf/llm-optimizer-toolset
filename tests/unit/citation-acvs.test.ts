/**
 * Spec 060: ACVS is pure math over observed citation behavior — known-answer
 * component checks, null redistribution, lifecycle rules, and the guardrail
 * that explanation templates never speak causally. No database.
 */
import { describe, expect, it } from "vitest";
import {
  componentsFromStats,
  computeAcvs,
  explainComponents,
  type AcquisitionFacts,
  type DomainStats,
} from "@/lib/citations/acvs";
import {
  canTransition,
  EXIT_STATUSES,
  OUTCOME_STATUSES,
  PIPELINE_STATUSES,
} from "@/lib/citations/constants";
import { CAUSAL_PHRASES } from "@/lib/workflow/gates";
import type { WeightSet } from "@/lib/scoring/weights";

const stats = (over: Partial<DomainStats> = {}): DomainStats => ({
  domain: "localnews.example",
  totalResponses: 100,
  citingResponses: 20,
  totalPrompts: 10,
  citingPrompts: 5,
  tieredCitingResponses: 10,
  highIntentCitingResponses: 6,
  totalProviders: 4,
  providersCiting: 2,
  totalRuns: 5,
  runsCiting: 4,
  competitorRecommendedCoOccurrence: 8,
  competitorsRecommendedDistinct: 3,
  trackedCompetitors: 6,
  clientRecommendedCoOccurrence: 2,
  clientPresent: false,
  presenceCheckedAt: new Date("2026-08-01"),
  sourceType: "news",
  ...over,
});

const facts = (over: Partial<AcquisitionFacts> = {}): AcquisitionFacts => ({
  acquisitionPath: "local_media",
  acquisitionDifficulty: "moderate",
  ...over,
});

// Equal weights over ten components — keeps expected values hand-computable.
const weightSet: WeightSet = {
  id: "ws-test",
  name: "citation-acvs",
  version: 1,
  weights: {
    citationFrequency: 0.1,
    promptRelevance: 0.1,
    commercialIntent: 0.1,
    crossEngine: 0.1,
    recommendationInfluence: 0.1,
    competitorDensity: 0.1,
    clientGap: 0.1,
    feasibility: 0.1,
    sourceQuality: 0.1,
    persistence: 0.1,
  },
};

describe("componentsFromStats (acvs-v1)", () => {
  it("computes every component from the observed ratios", () => {
    const c = componentsFromStats(stats(), facts());
    expect(c.citationFrequency).toBeCloseTo(0.2);
    expect(c.promptRelevance).toBeCloseTo(0.5);
    expect(c.commercialIntent).toBeCloseTo(0.6);
    expect(c.crossEngine).toBeCloseTo(0.5);
    expect(c.recommendationInfluence).toBeCloseTo(0.5); // (8+2)/20
    expect(c.competitorDensity).toBeCloseTo(0.5);
    expect(c.clientGap).toBe(1); // verified absent = the gap is real
    expect(c.feasibility).toBeCloseTo(0.6);
    expect(c.sourceQuality).toBe(1); // news
    expect(c.persistence).toBeCloseTo(0.8);
  });

  it("a verified-present client zeroes the gap; unchecked is null, not a gap", () => {
    expect(componentsFromStats(stats({ clientPresent: true }), facts()).clientGap).toBe(0);
    expect(
      componentsFromStats(stats({ clientPresent: null }), facts()).clientGap
    ).toBeNull();
  });

  it("an unknown path caps feasibility even when difficulty says easy", () => {
    const c = componentsFromStats(
      stats(),
      facts({ acquisitionPath: "unknown", acquisitionDifficulty: "easy" })
    );
    expect(c.feasibility).toBe(0.5);
  });

  it("untiered prompt sets leave commercial intent unmeasured, never zero", () => {
    const c = componentsFromStats(
      stats({ tieredCitingResponses: 0, highIntentCitingResponses: 0 }),
      facts()
    );
    expect(c.commercialIntent).toBeNull();
  });

  it("a single-occurrence source scores low but real — no divide-by-zero", () => {
    const c = componentsFromStats(
      stats({
        citingResponses: 1,
        citingPrompts: 1,
        providersCiting: 1,
        runsCiting: 1,
        tieredCitingResponses: 1,
        highIntentCitingResponses: 1,
        competitorRecommendedCoOccurrence: 0,
        clientRecommendedCoOccurrence: 0,
        competitorsRecommendedDistinct: 0,
      }),
      facts()
    );
    expect(c.citationFrequency).toBeCloseTo(0.01);
    expect(c.recommendationInfluence).toBe(0);
    expect(c.persistence).toBeCloseTo(0.2);
  });
});

describe("computeAcvs", () => {
  it("known answer: equal weights average the measured components", () => {
    const result = computeAcvs(stats(), facts(), weightSet);
    // (0.2+0.5+0.6+0.5+0.5+0.5+1+0.6+1+0.8)/10 = 0.62
    expect(result.acvs).toBeCloseTo(62.0, 1);
    expect(result.missing).toEqual([]);
    expect(result.explanation.length).toBeGreaterThan(4);
  });

  it("null components redistribute weight instead of dragging the score down", () => {
    const result = computeAcvs(
      stats({ clientPresent: null, sourceType: null, tieredCitingResponses: 0, highIntentCitingResponses: 0 }),
      facts(),
      weightSet
    );
    expect(result.missing.sort()).toEqual([
      "clientGap",
      "commercialIntent",
      "sourceQuality",
    ]);
    // (0.2+0.5+0.5+0.5+0.5+0.6+0.8)/7 = 0.5142857
    expect(result.acvs).toBeCloseTo(51.4, 1);
    expect(result.explanation.some((l) => l.includes("drop out"))).toBe(true);
  });

  it("nothing measurable → null score, never a fabricated zero", () => {
    const empty = stats({
      totalResponses: 0,
      citingResponses: 0,
      totalPrompts: 0,
      citingPrompts: 0,
      tieredCitingResponses: 0,
      highIntentCitingResponses: 0,
      totalProviders: 0,
      providersCiting: 0,
      totalRuns: 0,
      runsCiting: 0,
      trackedCompetitors: 0,
      competitorRecommendedCoOccurrence: 0,
      competitorsRecommendedDistinct: 0,
      clientRecommendedCoOccurrence: 0,
      clientPresent: null,
      sourceType: null,
    });
    // feasibility is operator-derived, so exclude it too via unknown facts
    const result = computeAcvs(empty, facts(), {
      ...weightSet,
      weights: { ...weightSet.weights, feasibility: 0 },
    });
    expect(result.acvs).toBeNull();
  });
});

describe("explanation guardrails (spec 060 §9)", () => {
  const allStats = [
    stats(),
    stats({ clientPresent: null, sourceType: null }),
    stats({ clientPresent: true, tieredCitingResponses: 0, highIntentCitingResponses: 0 }),
  ];
  it("template lines never use causal or guarantee language", () => {
    for (const s of allStats) {
      for (const f of [facts(), facts({ acquisitionPath: "unknown" })]) {
        const lines = [
          ...explainComponents(s, f, componentsFromStats(s, f)),
          ...computeAcvs(s, f, weightSet).explanation,
        ];
        for (const line of lines) {
          for (const phrase of CAUSAL_PHRASES) {
            expect(line.toLowerCase(), `"${line}" contains "${phrase}"`).not.toContain(
              phrase
            );
          }
        }
      }
    }
  });

  it("the extended phrase list carries the spec-060 guarantee terms", () => {
    for (const phrase of [
      "guaranteed",
      "will improve",
      "ranks because",
      "directly resulted",
      "proven to",
      "ensures",
    ]) {
      expect(CAUSAL_PHRASES).toContain(phrase);
    }
  });

  it("co-occurrence is labelled as such in the explanation", () => {
    const s = stats();
    const lines = explainComponents(s, facts(), componentsFromStats(s, facts()));
    expect(lines.some((l) => l.includes("not attribution"))).toBe(true);
  });
});

describe("opportunity lifecycle", () => {
  it("moves forward through the pipeline, including skips", () => {
    expect(canTransition("discovered", "researched")).toBe(true);
    expect(canTransition("discovered", "won")).toBe(true);
    expect(canTransition("won", "qualified")).toBe(false);
    expect(canTransition("discovered", "discovered")).toBe(false);
  });

  it("outcomes only from measuring; exits from any non-terminal state", () => {
    for (const outcome of OUTCOME_STATUSES) {
      expect(canTransition("measuring", outcome)).toBe(true);
      expect(canTransition("won", outcome)).toBe(false);
    }
    for (const exit of EXIT_STATUSES) {
      expect(canTransition("discovered", exit)).toBe(true);
      expect(canTransition("negotiation", exit)).toBe(true);
    }
  });

  it("terminal states never leave", () => {
    for (const terminal of [...OUTCOME_STATUSES, ...EXIT_STATUSES]) {
      for (const target of [...PIPELINE_STATUSES, ...EXIT_STATUSES]) {
        expect(canTransition(terminal, target), `${terminal} → ${target}`).toBe(false);
      }
    }
  });
});
