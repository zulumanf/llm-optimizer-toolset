import { describe, expect, it } from "vitest";
import { changeVerdict } from "@/lib/reports/deltas";
import { validateNarrative, draftNarrative } from "@/lib/reports/narrative";
import { reportScoresCsv } from "@/lib/reports/service";
import type { ReportBody, SnapshotScore } from "@/lib/reports/types";

const agg = (current: number, previous: number, n = 40) => ({
  current,
  previous,
  nCurrent: n,
  nPrevious: n,
});
const prov = (provider: string, current: number, previous: number) => ({
  provider,
  current,
  previous,
  nCurrent: 40,
  nPrevious: 40,
});

describe("changeVerdict (docs/06 change detection)", () => {
  it("notable: |Δ|≥0.10, N≥30/side, direction consistent across ≥2 providers", () => {
    expect(
      changeVerdict("recommendation_rate", agg(0.55, 0.4), [
        prov("openai", 0.5, 0.38),
        prov("anthropic", 0.6, 0.45),
      ])
    ).toBe("notable");
  });

  it("within noise below the 0.10 threshold", () => {
    expect(
      changeVerdict("recommendation_rate", agg(0.45, 0.4), [
        prov("openai", 0.45, 0.4),
        prov("anthropic", 0.45, 0.4),
      ])
    ).toBe("within_noise");
  });

  it("within noise when providers disagree on direction", () => {
    expect(
      changeVerdict("recommendation_rate", agg(0.55, 0.4), [
        prov("openai", 0.7, 0.4),
        prov("anthropic", 0.4, 0.45),
      ])
    ).toBe("within_noise");
  });

  it("insufficient below N=30 per side", () => {
    expect(
      changeVerdict("recommendation_rate", agg(0.6, 0.4, 10), [])
    ).toBe("insufficient");
  });

  it("authority score gets no noise verdict (null)", () => {
    expect(changeVerdict("authority_score", agg(80, 60), [])).toBeNull();
  });
});

const SCORE_ID = "11111111-2222-4333-8444-555555555555";
const RESPONSE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function snapshotBase(): Omit<ReportBody, "narrative"> {
  const score: SnapshotScore = {
    scoreId: SCORE_ID,
    companyId: "c1",
    companyName: "Parva",
    isSelf: true,
    metric: "authority_score",
    provider: "all",
    value: 72.4,
    sampleSize: 40,
    scoringVersion: "v1.0",
  };
  const rec: SnapshotScore = {
    ...score,
    scoreId: "22222222-3333-4444-8555-666666666666",
    metric: "recommendation_rate",
    value: 0.45,
  };
  return {
    scoringVersion: "v1.0",
    generatedAt: "2026-07-27T00:00:00Z",
    runs: [{ id: "r1", label: "W31", startedAt: "2026-07-27T00:00:00Z" }],
    currentRunId: "r1",
    previousRunId: null,
    comparable: false,
    comparabilityNote:
      "No comparable prior run exists (same frozen prompt set and scoring version) — this report is a new baseline with no deltas.",
    scores: [score, rec],
    deltas: [],
    excerpts: [
      {
        responseId: RESPONSE_ID,
        companyName: "Parva",
        provider: "mock",
        runLabel: "W31",
        excerpt: "Parva is a solid option.",
        recommended: true,
      },
    ],
    coverage: {
      runCount: 1,
      capturedCells: 40,
      failedCells: 0,
      refusals: 0,
      pendingReview: 0,
    },
  };
}

describe("validateNarrative (the evidence gate)", () => {
  const body = snapshotBase();

  it("passes fully cited text and fails uncited numeric sentences", () => {
    const good = validateNarrative(
      { summary: `Authority is 72.4 [score:${SCORE_ID}]. All clear.` },
      body
    );
    expect(good.ok).toBe(true);

    const bad = validateNarrative(
      { summary: "Authority is 72.4 and improving." },
      body
    );
    expect(bad.ok).toBe(false);
    expect(bad.uncitedSentences).toHaveLength(1);
  });

  it("rejects citations that don't resolve inside the snapshot", () => {
    const result = validateNarrative(
      { summary: `Value 9 [score:99999999-0000-4000-8000-000000000000].` },
      body
    );
    expect(result.ok).toBe(false);
    expect(result.unresolvedCitations).toHaveLength(1);
  });

  it("accepts response citations for excerpts", () => {
    const result = validateNarrative(
      { notable_responses: `"Quote 1" [response:${RESPONSE_ID}]` },
      body
    );
    expect(result.ok).toBe(true);
  });
});

describe("draftNarrative", () => {
  it("produces a draft that passes its own evidence gate", () => {
    const body = snapshotBase();
    const narrative = draftNarrative(body);
    const validation = validateNarrative(narrative, body);
    expect(validation.uncitedSentences).toEqual([]);
    expect(validation.unresolvedCitations).toEqual([]);
    expect(validation.ok).toBe(true);
    expect(narrative.summary).toContain("[score:");
    expect(narrative.notable_responses).toContain(`[response:${RESPONSE_ID}]`);
  });

  it("states the new-baseline caveat when not comparable", () => {
    const narrative = draftNarrative(snapshotBase());
    expect(narrative.summary).toMatch(/new baseline/);
  });
});

describe("reportScoresCsv", () => {
  it("emits a header and one row per score with quoting", () => {
    const body = { ...snapshotBase(), narrative: {} } as unknown as ReportBody;
    const csv = reportScoresCsv(body);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("company,metric,provider,value,sample_size,scoring_version");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"Parva",authority_score,all,72.4,40,v1.0');
  });
});
