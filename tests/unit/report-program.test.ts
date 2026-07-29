import { describe, expect, it } from "vitest";
import { draftNarrative, validateNarrative } from "@/lib/reports/narrative";
import type { ReportBody } from "@/lib/reports/types";

const SCORE_ID = "11111111-2222-4333-8444-555555555555";
const FINDING_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ACCURACY_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

function body(overrides: Partial<ReportBody> = {}): Omit<ReportBody, "narrative"> {
  return {
    kind: "monthly",
    scoringVersion: "v1.0",
    generatedAt: "2026-07-29T00:00:00Z",
    runs: [{ id: "r1", label: "Baseline", startedAt: "2026-07-29T00:00:00Z" }],
    currentRunId: "r1",
    previousRunId: null,
    comparable: false,
    comparabilityNote: "New baseline.",
    scores: [
      {
        scoreId: SCORE_ID,
        companyId: "c1",
        companyName: "Parva",
        isSelf: true,
        metric: "recommendation_rate",
        provider: "all",
        value: 0.125,
        sampleSize: 8,
        scoringVersion: "v1.0",
      },
    ],
    deltas: [],
    excerpts: [],
    coverage: {
      runCount: 1,
      capturedCells: 8,
      failedCells: 0,
      refusals: 0,
      pendingReview: 0,
    },
    program: {
      gapFindings: [
        {
          findingId: FINDING_ID,
          gapType: "entity",
          finding: "Absent from unbranded answers while Linktree appears often.",
          opportunityScore: 88,
          status: "open",
        },
      ],
      accuracyFindings: [
        {
          accuracyId: ACCURACY_ID,
          kind: "entity_confusion",
          severity: "high",
          quote: "Parva is a healthcare claims operations platform.",
          status: "open",
        },
      ],
      interventions: [
        {
          interventionId: "i1",
          title: "Published category page",
          shippedAt: "2026-07-20",
          measuredVerdicts: 1,
          notableVerdicts: 0,
        },
      ],
      tasksCompleted: [{ taskId: "t1", title: "Fix profile", priority: "p1" }],
      contentPublished: [
        { assetId: "a1", title: "Link-in-bio guide", url: "https://parva.io/guide" },
      ],
    },
    categoryOwnership: [
      {
        category: "recommendation",
        label: "contested",
        observations: 8,
        mentions: 1,
        recommendations: 0,
        leadingCompetitor: "Linktree",
        leadingCompetitorMentions: 6,
      },
    ],
    ...overrides,
  } as Omit<ReportBody, "narrative">;
}

describe("weekly pulse narrative (spec 016)", () => {
  const pulse = draftNarrative(body({ kind: "weekly_pulse" }));

  it("leads with new high-severity accuracy findings, cited", () => {
    expect(pulse.summary).toContain("high-severity accuracy finding");
    expect(pulse.summary).toContain(`[accuracy:${ACCURACY_ID}]`);
  });

  it("surfaces the top open gap with a resolvable citation", () => {
    expect(pulse.summary).toContain(`[finding:${FINDING_ID}]`);
  });

  it("points at program tables instead of putting uncited numbers in prose", () => {
    expect(pulse.summary).toContain("program section");
  });

  it("passes the evidence gate as drafted", () => {
    const result = validateNarrative(pulse, body({ kind: "weekly_pulse" }));
    expect(result.uncitedSentences).toEqual([]);
    expect(result.unresolvedCitations).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("monthly narrative + category ownership", () => {
  const monthly = draftNarrative(body());

  it("includes the ownership map as labels, with counts left to the table", () => {
    expect(monthly.competitors).toContain("Category ownership");
    expect(monthly.competitors).toContain("contested");
    expect(monthly.competitors).toContain("Linktree leads it");
  });

  it("does not lead with pulse-only change lines", () => {
    expect(monthly.summary).not.toContain("New high-severity accuracy finding");
  });

  it("passes the evidence gate", () => {
    expect(validateNarrative(monthly, body()).ok).toBe(true);
  });
});

describe("extended citation gate", () => {
  it("accepts finding/accuracy citations that resolve", () => {
    const result = validateNarrative(
      {
        summary: `We logged 1 high-severity problem [accuracy:${ACCURACY_ID}] and 1 gap [finding:${FINDING_ID}].`,
      },
      body()
    );
    expect(result.ok).toBe(true);
  });

  it("rejects finding citations that do not resolve", () => {
    const result = validateNarrative(
      { summary: `We logged 3 problems [accuracy:cccccccc-3333-4333-8333-cccccccccccc].` },
      body()
    );
    expect(result.ok).toBe(false);
    expect(result.unresolvedCitations).toHaveLength(1);
  });

  it("still blocks uncited numbers regardless of new token kinds", () => {
    const result = validateNarrative({ summary: "We found 5 problems." }, body());
    expect(result.ok).toBe(false);
    expect(result.uncitedSentences).toHaveLength(1);
  });
});
