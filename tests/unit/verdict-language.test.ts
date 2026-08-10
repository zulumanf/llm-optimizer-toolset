/**
 * Spec 051: the one translation from measured verdicts to client language,
 * and the report HTML actually rendering the program section — the "did it
 * work" answer that was computed and never shown (audit F24/F26).
 */
import { describe, expect, it } from "vitest";
import { verdictLine } from "@/lib/reports/verdict-language";
import { renderReportHtml } from "@/lib/reports/export-html";
import type { ReportBody } from "@/lib/reports/types";

describe("verdictLine", () => {
  it("no post measurements → scheduled, never a guess", () => {
    expect(verdictLine([])).toBe("Re-measurement scheduled");
  });

  it("measured but nothing notable → 'no clear change yet', never 'didn't work'", () => {
    const line = verdictLine([
      { metric: "mention_rate", delta: 0.02, verdict: "within_noise" },
      { metric: "recommendation_rate", delta: -0.01, verdict: "insufficient" },
    ]);
    expect(line).toBe("Re-measured — no clear change yet");
  });

  it("headline prefers recommendation rate and speaks client language", () => {
    const line = verdictLine([
      { metric: "mention_rate", delta: 0.2, verdict: "notable" },
      { metric: "recommendation_rate", delta: 0.12, verdict: "notable" },
    ]);
    expect(line).toBe(
      "Re-measured: Actively recommended +12 points (notable) and 1 more notable change"
    );
  });
});

function minimalBody(overrides: Partial<ReportBody>): ReportBody {
  return {
    kind: "monthly",
    scoringVersion: "v1.1",
    generatedAt: new Date(0).toISOString(),
    runs: [],
    currentRunId: "00000000-0000-4000-8000-000000000001",
    previousRunId: null,
    comparable: false,
    comparabilityNote: "",
    scores: [],
    deltas: [],
    excerpts: [],
    coverage: { runCount: 1, capturedCells: 1, failedCells: 0, refusals: 0, pendingReview: 0 },
    program: {
      gapFindings: [],
      accuracyFindings: [],
      interventions: [],
      tasksCompleted: [],
      contentPublished: [],
    },
    categoryOwnership: [],
    narrative: { summary: "", competitors: "", notable_responses: "", suggested_actions: "" },
    ...overrides,
  };
}

describe("report HTML program section", () => {
  it("renders measured and unmeasured interventions with honest states", () => {
    const html = renderReportHtml({
      clientName: "Rivera Team",
      title: "Monthly",
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      publishedAt: "2026-08-01T00:00:00Z",
      body: minimalBody({
        program: {
          gapFindings: [],
          accuracyFindings: [],
          interventions: [
            {
              interventionId: "00000000-0000-4000-8000-00000000000a",
              title: "Neighborhood guide",
              shippedAt: "2026-07-10",
              measuredVerdicts: 1,
              notableVerdicts: 1,
              verdictSummaries: [
                {
                  metric: "recommendation_rate",
                  postRunId: "00000000-0000-4000-8000-00000000000b",
                  delta: 0.15,
                  verdict: "notable",
                },
              ],
            },
            {
              interventionId: "00000000-0000-4000-8000-00000000000c",
              title: "Profile correction",
              shippedAt: "2026-07-28",
              measuredVerdicts: 0,
              notableVerdicts: 0,
              verdictSummaries: [],
            },
          ],
          tasksCompleted: [
            { taskId: "00000000-0000-4000-8000-00000000000d", title: "t", priority: "p1" },
          ],
          contentPublished: [],
        },
      }),
    });
    expect(html).toContain("What we did — and did it work");
    expect(html).toContain("Actively recommended +15 points (notable)");
    expect(html).toContain("Re-measurement scheduled");
  });

  it("an old snapshot without program fields renders without the section", () => {
    const html = renderReportHtml({
      clientName: "Rivera Team",
      title: "Monthly",
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      publishedAt: "2026-08-01T00:00:00Z",
      body: minimalBody({ program: undefined as unknown as ReportBody["program"] }),
    });
    expect(html).not.toContain("What we did");
  });

  it("delta rows render sample sizes when the snapshot carries them", () => {
    const html = renderReportHtml({
      clientName: "Rivera Team",
      title: "Monthly",
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      publishedAt: "2026-08-01T00:00:00Z",
      body: minimalBody({
        deltas: [
          {
            companyId: "00000000-0000-4000-8000-00000000000e",
            companyName: "Rivera Team",
            isSelf: true,
            metric: "mention_rate",
            current: 0.4,
            previous: 0.3,
            delta: 0.1,
            verdict: "within_noise",
            nCurrent: 40,
            nPrevious: 38,
          },
        ],
      }),
    });
    expect(html).toContain("(n=40)");
    expect(html).toContain("(n=38)");
  });
});
