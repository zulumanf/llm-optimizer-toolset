/** Spec 137 test fixtures: a verified release verdict and a compiled fact
 * manifest over a snapshot, without a database. */
import { EVIDENCE_RELEASE_VERSION, type EvidenceReleaseVerdict } from "@/lib/prospects/evidence-release";
import { compileFactManifest, type FactManifest } from "@/lib/prospects/fact-manifest";
import type { MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";
import type { ProspectEntityType } from "@/lib/prospects/followup-templates";

export function verifiedVerdictFor(s: MismatchEvidenceSnapshot, over: Partial<EvidenceReleaseVerdict> = {}): EvidenceReleaseVerdict {
  return {
    version: EVIDENCE_RELEASE_VERSION, verified: true, reasons: [], checks: [],
    diagnostics: {
      runId: s.runId, provider: s.provider, expectedCells: s.answerCount, validCells: s.answerCount, errorCells: 0, otherProviderCells: 0,
      stated: { prospect: s.prospect.recommendationCount, competitor: s.competitor.recommendationCount, denominator: s.answerCount },
      primary: { prospect: s.prospect.recommendationCount, competitor: s.competitor.recommendationCount, denominator: s.answerCount },
      shadow: { prospect: s.prospect.recommendationCount, competitor: s.competitor.recommendationCount, denominator: s.answerCount },
      coverageGaps: { prospect: 0, competitor: 0 },
      entityLevels: { prospect: "team", competitor: "team" },
      productionRecords: { prospect: s.prospect.productionSignalId, competitor: s.competitor.productionSignalId },
      parserVersions: ["llm-v2"], correctionId: null,
    },
    ...over,
  };
}

export function manifestFor(s: MismatchEvidenceSnapshot, entityType: ProspectEntityType = "team", approved: { exampleIds?: string[]; firstActionId?: string | null } = {}): FactManifest {
  const r = compileFactManifest({ snapshot: s, verdict: verifiedVerdictFor(s), market: "Reno", prospectEntityType: entityType, approvedExampleIds: approved.exampleIds ?? ["r1"], approvedFirstActionId: approved.firstActionId ?? "priority-1:abc" });
  if (!r.ok) throw new Error(r.reason);
  return r.manifest;
}
