/**
 * Spec 130: a correction is a new row beside the frozen snapshot, never an
 * edit of it. The sent claim stays; readers overlay the corrected counts.
 */
import { describe, expect, it } from "vitest";
import { buildCorrectedSnapshot, correctionIsMaterial, type EvidenceCorrection } from "@/lib/prospects/evidence-corrections";
import { withEvidenceCorrection, type FollowupSequence } from "@/lib/prospects/followups";
import { renderFollowup } from "@/lib/prospects/followup-templates";
import { FOLLOWUP_TEMPLATE_VERSIONS, MISMATCH_THRESHOLDS } from "@/lib/prospects/constants";
import type { MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";

const original: MismatchEvidenceSnapshot = {
  templateVersion: "competitive_mismatch_reply_v1", runId: "68ed325d-f0e9-4a76-8c3b-3887a249a8ea", provider: "openai",
  answerCount: 256, modelCount: 1, capturedAt: "2026-08-31T11:13:56.777Z", completedAt: "2026-08-31T11:13:56.973Z",
  scopeCopy: "Grand Rapids buyer and seller questions", audiences: ["seller", "buyer", "general"],
  prospect: { companyId: "blu", prospectId: "ba48", name: "Blu House Properties", recommendationCount: 11, productionSignalId: "s1", productionSourceUrl: "licensed:realtrends-verified-2026", productionYear: 2025, productionValue: 81_103_589, productionDisplay: "$81.1M closed" },
  competitor: { companyId: "josh", prospectId: "6c67", name: "Josh May", recommendationCount: 38, productionSignalId: "s2", productionSourceUrl: "licensed:realtrends-verified-2026", productionYear: 2025, productionValue: 65_529_015, productionDisplay: "$65.5M closed", productionRatio: 0.808, recommendationGap: 27 },
  metricType: "closed_volume", thresholds: MISMATCH_THRESHOLDS,
};
const frozen = JSON.stringify(original);

describe("buildCorrectedSnapshot", () => {
  it("replaces both counts and the gap, keeps every other frozen fact, and leaves the original untouched", () => {
    const corrected = buildCorrectedSnapshot(original, { prospect: 23, competitor: 38 });
    expect(corrected.prospect.recommendationCount).toBe(23);
    expect(corrected.competitor.recommendationCount).toBe(38);
    expect(corrected.competitor.recommendationGap).toBe(15);
    expect(corrected.answerCount).toBe(256);
    expect(corrected.runId).toBe(original.runId);
    expect(corrected.prospect.productionDisplay).toBe("$81.1M closed");
    expect(JSON.stringify(original)).toBe(frozen);
  });
  it("is material only when a stated count changes", () => {
    expect(correctionIsMaterial(original, buildCorrectedSnapshot(original, { prospect: 11, competitor: 38 }))).toBe(false);
    expect(correctionIsMaterial(original, buildCorrectedSnapshot(original, { prospect: 12, competitor: 38 }))).toBe(true);
    expect(correctionIsMaterial(original, buildCorrectedSnapshot(original, { prospect: 11, competitor: 40 }))).toBe(true);
  });
});

describe("withEvidenceCorrection — unsent follow-ups read the corrected evidence", () => {
  const seq: FollowupSequence = {
    id: "seq", prospectId: "ba48", experimentId: "x", contactId: null, touch1DraftId: "d1", touch1SendId: "s1",
    touch1SentAt: new Date("2026-09-05T13:18:21Z"), competitorCompanyId: "josh", evidenceSnapshot: original,
    distinctCompetitorQuestions: 21, timezone: "America/Detroit", status: "active", stopReason: null, pausedUntil: null,
    pauseReason: null, nextTouch: 2, nextDueAt: null, lastTouchSendId: null, enrolledBy: "u",
  };
  const correction: EvidenceCorrection = {
    id: "c1", prospectId: "ba48", evidenceDraftId: "d1", sendId: "s1", sourceRunId: original.runId,
    originalSnapshot: original, correctedSnapshot: buildCorrectedSnapshot(original, { prospect: 23, competitor: 38 }),
    reason: "verified lead-agent alias", entityResolutionChange: { aliasesAdded: {}, mentionRowsAdded: {}, counts: { prospect: { before: 11, after: 23 }, competitor: { before: 38, after: 38 } } },
    correctedBy: "u", correctedAt: new Date("2026-09-05T18:00:00Z"),
  };
  it("overlays the corrected snapshot and keeps the stored row's value reachable through the correction", () => {
    const over = withEvidenceCorrection(seq, correction);
    expect(over.evidenceSnapshot.prospect.recommendationCount).toBe(23);
    expect(over.evidenceCorrection?.originalSnapshot.prospect.recommendationCount).toBe(11);
    expect(seq.evidenceSnapshot.prospect.recommendationCount).toBe(11);
    expect(withEvidenceCorrection(seq, null)).toBe(seq);
  });
  it("a Touch 2 rendered from the overlay states the corrected counts, never the sent claim", () => {
    const over = withEvidenceCorrection(seq, correction);
    const t2 = renderFollowup(FOLLOWUP_TEMPLATE_VERSIONS.t2NoEngagement, {
      firstName: "Ryan", marketName: "Grand Rapids, MI", snapshot: over.evidenceSnapshot, distinctCompetitorQuestions: 21,
      footerTail: ["Brooklyn, NY", 'If you\'d rather not hear from us, reply "unsubscribe" and we will not contact you again.'],
      entityType: "team", reportReady: false, categoryLine: null,
    });
    const body = t2.body;
    expect(body).toContain("23 of 256");
    expect(body).not.toContain("11 of 256");
  });
});
