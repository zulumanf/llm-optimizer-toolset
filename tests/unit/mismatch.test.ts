import { describe, expect, it } from "vitest";
import {
  benchmarkScopeCopy,
  buildEvidenceSnapshot,
  evaluateMismatch,
  formatProductionDisplay,
  implicationLine,
  marketShortName,
  recencyPhrase,
  type CompetitiveMismatchReview,
  type MismatchEntityInput,
  type MismatchEvaluationInput,
} from "@/lib/prospects/mismatch";
import { generateCompetitiveMismatchEmail } from "@/lib/prospects/outreach";
import { findProhibitedPhrase, MISMATCH_TEMPLATE_VERSION } from "@/lib/prospects/constants";
import type { ProductionEvidence } from "@/lib/prospects/realtrends";

const NOW = new Date("2026-08-28T12:00:00Z"); // Friday ET

const prod = (over: Partial<ProductionEvidence> = {}): ProductionEvidence => ({
  signalId: "sig-p",
  prospectId: "p1",
  entityType: "team",
  source: "RealTrends America's Best",
  rank: 1,
  rankScope: "Jersey City, NJ — teams by closed volume",
  scopeComparable: true,
  volumeUsd: 47_200_000,
  sides: 52,
  avgPerSideUsd: 907_692,
  productionYear: 2025,
  sourceUrl: "https://www.realtrends.com/rankings/jc-teams",
  retrievedOn: "2026-08-20",
  ...over,
});

const candidate = (over: Partial<MismatchEntityInput> = {}): MismatchEntityInput => ({
  companyId: "c2",
  prospectId: "p2",
  displayName: "Harbor View Group",
  production: prod({ signalId: "sig-c", prospectId: "p2", volumeUsd: 29_400_000, sides: 33, rank: 4 }),
  recommendationCount: 14,
  ...over,
});

const input = (over: Partial<MismatchEvaluationInput> = {}): MismatchEvaluationInput => ({
  now: NOW,
  firstName: "Joelle",
  prospect: { companyId: "c1", production: prod(), recommendationCount: 7 },
  candidates: [candidate()],
  benchmark: { answerCount: 64, completedAt: new Date("2026-08-26T09:00:00Z") },
  ...over,
});

describe("evaluateMismatch — eligibility matrix", () => {
  it("a clean inversion is eligible and selects the candidate", () => {
    const e = evaluateMismatch(input());
    expect(e.eligible).toBe(true);
    expect(e.reasonCodes).toEqual([]);
    expect(e.selected?.companyId).toBe("c2");
    expect(e.selected?.recommendationGap).toBe(7);
  });

  it("a competitor that produces more is ineligible", () => {
    const e = evaluateMismatch(
      input({ candidates: [candidate({ production: prod({ volumeUsd: 60_000_000 }) })] })
    );
    expect(e.eligible).toBe(false);
    expect(e.reasonCodes).toContain("NO_LOWER_PRODUCING_COMPETITOR");
  });

  it("a competitor recommended less is ineligible", () => {
    const e = evaluateMismatch(input({ candidates: [candidate({ recommendationCount: 3 })] }));
    expect(e.reasonCodes).toContain("NO_HIGHER_RECOMMENDATION_COMPETITOR");
  });

  it("a one-recommendation gap is under the threshold", () => {
    const e = evaluateMismatch(input({ candidates: [candidate({ recommendationCount: 8 })] }));
    expect(e.reasonCodes).toContain("RECOMMENDATION_GAP_TOO_SMALL");
  });

  it("a marginal production gap (over 90%) is never forced", () => {
    const e = evaluateMismatch(
      input({ candidates: [candidate({ production: prod({ volumeUsd: 45_000_000 }) })] })
    );
    expect(e.reasonCodes).toContain("PRODUCTION_GAP_TOO_SMALL");
  });

  it("different production years never compare", () => {
    const e = evaluateMismatch(
      input({ candidates: [candidate({ production: prod({ volumeUsd: 29_400_000, productionYear: 2024 }) })] })
    );
    expect(e.reasonCodes).toContain("PRODUCTION_PERIOD_MISMATCH");
  });

  it("volume never compares to sides", () => {
    const e = evaluateMismatch(
      input({
        prospect: { companyId: "c1", production: prod({ sides: 0 }), recommendationCount: 7 },
        candidates: [candidate({ production: prod({ volumeUsd: 0, sides: 33 }) })],
      })
    );
    expect(e.reasonCodes).toContain("PRODUCTION_METRIC_MISMATCH");
  });

  it("sides is the fallback metric when both sides report it and volume is absent", () => {
    const e = evaluateMismatch(
      input({
        prospect: {
          companyId: "c1",
          production: prod({ volumeUsd: 0, sides: 83 }),
          recommendationCount: 7,
        },
        candidates: [candidate({ production: prod({ volumeUsd: 0, sides: 40 }) })],
      })
    );
    expect(e.eligible).toBe(true);
    expect(e.selected?.metricType).toBe("sides");
  });

  it("team never compares to individual", () => {
    const e = evaluateMismatch(
      input({ candidates: [candidate({ production: prod({ volumeUsd: 29_400_000, entityType: "individual" }) })] })
    );
    expect(e.reasonCodes).toContain("ENTITY_LEVEL_MISMATCH");
  });

  it("unverified competitor production fails closed", () => {
    const e = evaluateMismatch(input({ candidates: [candidate({ production: null })] }));
    expect(e.reasonCodes).toContain("PRODUCTION_DATA_UNVERIFIED");
  });

  it("unverified prospect production fails closed", () => {
    const e = evaluateMismatch(
      input({ prospect: { companyId: "c1", production: null, recommendationCount: 7 } })
    );
    expect(e.eligible).toBe(false);
    expect(e.reasonCodes).toContain("PRODUCTION_DATA_UNVERIFIED");
  });

  it("a stale benchmark fails regardless of the comparison", () => {
    const e = evaluateMismatch(
      input({ benchmark: { answerCount: 64, completedAt: new Date("2026-08-01T09:00:00Z") } })
    );
    expect(e.eligible).toBe(false);
    expect(e.reasonCodes).toContain("BENCHMARK_TOO_OLD");
  });

  it("no OpenAI answers = no template, whatever the production says", () => {
    const e = evaluateMismatch(
      input({ benchmark: { answerCount: 0, completedAt: new Date("2026-08-26T09:00:00Z") } })
    );
    expect(e.reasonCodes).toContain("CHATGPT_DATA_UNAVAILABLE");
  });

  it("an unresolved prospect entity fails closed", () => {
    const e = evaluateMismatch(
      input({ prospect: { companyId: null, production: prod(), recommendationCount: 7 } })
    );
    expect(e.reasonCodes).toContain("ENTITY_RESOLUTION_UNCERTAIN");
  });

  it("no candidates at all reports NO_VALID_COMPETITOR", () => {
    const e = evaluateMismatch(input({ candidates: [] }));
    expect(e.reasonCodes).toEqual(["NO_VALID_COMPETITOR"]);
  });

  it("a missing first name fails closed", () => {
    const e = evaluateMismatch(input({ firstName: null }));
    expect(e.reasonCodes).toContain("NO_RECIPIENT_FIRST_NAME");
  });
});

describe("competitor priority", () => {
  it("larger recommendation gap wins; production inversion breaks ties", () => {
    const weakGap = candidate({ companyId: "c3", prospectId: "p3", displayName: "A Team", recommendationCount: 10 });
    const strongGap = candidate();
    const strongerInversion = candidate({
      companyId: "c4",
      prospectId: "p4",
      displayName: "B Team",
      recommendationCount: 14,
      production: prod({ prospectId: "p4", volumeUsd: 20_000_000 }),
    });
    const e = evaluateMismatch(input({ candidates: [weakGap, strongGap, strongerInversion] }));
    expect(e.eligibleCandidates.map((c) => c.companyId)).toEqual(["c4", "c2", "c3"]);
  });
});

describe("copy helpers", () => {
  it("scope copy follows the run's actual audiences", () => {
    expect(benchmarkScopeCopy("Jersey City, NJ", ["buyer", "seller"])).toBe(
      "Jersey City buyer and seller questions"
    );
    expect(benchmarkScopeCopy("Jersey City", ["seller"])).toBe(
      "questions Jersey City sellers ask when choosing an agent"
    );
    expect(benchmarkScopeCopy("Jersey City", ["general"])).toBe(
      "Jersey City real estate questions"
    );
  });
  it("implication line matches scope and never claims a loss", () => {
    expect(implicationLine(["seller"])).toBe(
      "When someone asks who to call, they can see them first."
    );
    expect(implicationLine(["buyer", "seller"])).toContain("before they see you");
    expect(findProhibitedPhrase(implicationLine(["buyer"]))).toBeNull();
  });
  it("recency is truthful, never hardcoded", () => {
    expect(recencyPhrase(new Date("2026-08-26T09:00:00Z"), NOW)).toBe("Earlier this week");
    expect(recencyPhrase(new Date("2026-08-20T09:00:00Z"), NOW)).toBe("Last week");
    expect(recencyPhrase(new Date("2026-08-10T09:00:00Z"), NOW)).toBe("Recently");
  });
  it("production displays carry no false precision", () => {
    expect(formatProductionDisplay("closed_volume", 47_200_000)).toBe("$47.2M closed");
    expect(formatProductionDisplay("closed_volume", 125_000_000)).toBe("$125M closed");
    expect(formatProductionDisplay("sides", 83)).toBe("83 closed sides");
  });
  it("market short name drops the state", () => {
    expect(marketShortName("Wilmington, DE")).toBe("Wilmington");
    expect(marketShortName("Jersey City")).toBe("Jersey City");
  });
});

// ---------------------------------------------------------------- rendering

function review(): CompetitiveMismatchReview {
  const evaluation = evaluateMismatch(input());
  return {
    prospectId: "p1",
    runId: "run-1",
    marketName: "Jersey City, NJ",
    audiences: ["buyer", "seller"],
    scopeCopy: benchmarkScopeCopy("Jersey City, NJ", ["buyer", "seller"]),
    benchmark: {
      provider: "openai",
      answerCount: 64,
      modelCount: 1,
      capturedAt: new Date("2026-08-26T09:00:00Z"),
      recommendedByCompany: { c1: 7, c2: 14 },
    },
    benchmarkCompletedAt: new Date("2026-08-26T09:00:00Z"),
    firstName: "Joelle",
    prospect: {
      companyId: "c1",
      displayName: "The Sutherlin Group",
      production: prod(),
      recommendationCount: 7,
    },
    evaluation,
  };
}

describe("generateCompetitiveMismatchEmail", () => {
  const r = review();
  const draft = generateCompetitiveMismatchEmail(r, r.evaluation.selected!, NOW);

  it("renders the exact five-line comparison", () => {
    expect(draft.subject).toBe("Joelle — Jersey City");
    expect(draft.body).toBe(
      [
        "Joelle —",
        "",
        "Earlier this week I ran Jersey City buyer and seller questions through " +
          "the OpenAI model behind ChatGPT. It recommended Harbor View Group " +
          "more often than your team, even though RealTrends has you ahead on closed volume.",
        "",
        "Your team: $47.2M closed · recommended in 7 of 64 answers",
        "Harbor View Group: $29.4M closed · recommended in 14 of 64 answers",
        "",
        "When people use ChatGPT to research who to work with, they can see them before they see you.",
        "",
        "I have the exact questions and the side-by-side. Want me to send them?",
      ].join("\n")
    );
    expect(draft.promptVersion).toBe(MISMATCH_TEMPLATE_VERSION);
  });

  it("is plain text with nothing that was banned from touch 1", () => {
    for (const banned of [
      "http",
      "**",
      "<b>",
      "calendar",
      "Calendly",
      "attached",
      "GEO",
      "AEO",
      "LLM",
      "visibility",
      "guarantee",
      "Publicis",
      "Bank of America",
      "one team per market",
    ]) {
      expect(draft.body).not.toContain(banned);
    }
    expect(findProhibitedPhrase(draft.body)).toBeNull();
    expect(findProhibitedPhrase(draft.subject)).toBeNull();
  });

  it("pluralizes the tested-system phrase by model count", () => {
    const multi = review();
    multi.benchmark!.modelCount = 2;
    const d = generateCompetitiveMismatchEmail(multi, multi.evaluation.selected!, NOW);
    expect(d.body).toContain("the OpenAI models behind ChatGPT. They recommended");
  });

  it("freezes an evidence snapshot whose denominator is the answer count", () => {
    const snap = buildEvidenceSnapshot(r, r.evaluation.selected!);
    expect(snap.answerCount).toBe(64);
    expect(snap.provider).toBe("openai");
    expect(snap.templateVersion).toBe(MISMATCH_TEMPLATE_VERSION);
    expect(snap.prospect.recommendationCount).toBe(7);
    expect(snap.competitor.recommendationCount).toBe(14);
    expect(snap.competitor.productionSourceUrl).toContain("realtrends.com");
    expect(snap.metricType).toBe("closed_volume");
  });
});
