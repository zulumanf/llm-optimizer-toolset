/**
 * Unit tests for the six quality gates (spec 018 Part 8).
 *
 * The property that matters most below: `insufficient_evidence` is a distinct
 * outcome from `fail`. "I cannot tell" and "this is wrong" lead to different
 * operator actions, and collapsing them is how automated systems end up
 * shipping confident nonsense.
 */
import { describe, expect, it } from "vitest";
import {
  evidenceCompletenessGate,
  claimVerificationGate,
  contentQualityGate,
  publicationGate,
  attributionConfidenceGate,
  executiveReportingGate,
  type EvidenceCompletenessInput,
  type ClaimVerificationInput,
  type MaterialClaimUse,
} from "@/lib/workflow/gates";

const completeEvidence: EvidenceCompletenessInput = {
  requiredUpstreamTotal: 3,
  requiredUpstreamCompleted: 3,
  sampleSize: 30,
  minimumSampleSize: 5,
  rawEvidenceCount: 30,
  requiredArtifactKinds: [],
  presentArtifactKinds: [],
  hashesValid: true,
  classifiedCount: 30,
  lowConfidenceCount: 2,
  lowConfidenceRoutedCount: 2,
  partialFailureCount: 0,
  partialFailureDisclosed: true,
};

describe("evidenceCompletenessGate", () => {
  it("passes a complete evidence set", () => {
    expect(evidenceCompletenessGate(completeEvidence).outcome).toBe("pass");
  });

  it("fails when the sample is below the minimum", () => {
    const result = evidenceCompletenessGate({ ...completeEvidence, sampleSize: 3 });
    expect(result.outcome).toBe("fail");
    expect(result.checks.find((c) => c.name === "minimum_sample_size")?.passed).toBe(false);
  });

  it("fails when low-confidence observations were not routed to review", () => {
    const result = evidenceCompletenessGate({
      ...completeEvidence,
      lowConfidenceCount: 5,
      lowConfidenceRoutedCount: 1,
    });
    expect(result.outcome).toBe("fail");
    expect(result.checks.find((c) => c.name === "low_confidence_routed")?.passed).toBe(false);
  });

  it("fails when partial failures exist but were not disclosed", () => {
    const result = evidenceCompletenessGate({
      ...completeEvidence,
      partialFailureCount: 4,
      partialFailureDisclosed: false,
    });
    expect(result.outcome).toBe("fail");
  });

  it("passes when partial failures exist AND are disclosed", () => {
    const result = evidenceCompletenessGate({
      ...completeEvidence,
      partialFailureCount: 4,
      partialFailureDisclosed: true,
    });
    expect(result.outcome).toBe("pass");
  });

  it("returns insufficient_evidence — not fail — when integrity was never checked", () => {
    const result = evidenceCompletenessGate({ ...completeEvidence, hashesValid: null });
    expect(result.outcome).toBe("insufficient_evidence");
  });

  it("fails on a hash mismatch", () => {
    expect(evidenceCompletenessGate({ ...completeEvidence, hashesValid: false }).outcome).toBe(
      "fail"
    );
  });

  it("reports missing required artifacts by name", () => {
    const result = evidenceCompletenessGate({
      ...completeEvidence,
      requiredArtifactKinds: ["screenshot", "raw_json"],
      presentArtifactKinds: ["raw_json"],
    });
    expect(result.outcome).toBe("fail");
    expect(result.checks.find((c) => c.name === "required_artifacts_present")?.detail).toContain(
      "screenshot"
    );
  });
});

const goodClaim: MaterialClaimUse = {
  claimId: "c1",
  text: "We closed 120 transactions in 2025.",
  hasEvidence: true,
  evidenceAgeDays: 30,
  evidenceQuality: 1,
  usesApprovedWording: true,
  privacyPermitsUse: true,
  dateQualified: true,
};

const claimInput: ClaimVerificationInput = {
  materialClaims: [goodClaim],
  openContradictions: [],
  maxEvidenceAgeDays: 365,
  minEvidenceQuality: 0.5,
};

describe("claimVerificationGate", () => {
  it("passes a fully evidenced, current, approved claim", () => {
    expect(claimVerificationGate(claimInput).outcome).toBe("pass");
  });

  it("fails an unevidenced material claim", () => {
    const result = claimVerificationGate({
      ...claimInput,
      materialClaims: [{ ...goodClaim, hasEvidence: false }],
    });
    expect(result.outcome).toBe("fail");
  });

  it("fails a claim whose id is unknown — an invented citation is unsupported", () => {
    const result = claimVerificationGate({
      ...claimInput,
      materialClaims: [{ ...goodClaim, claimId: null }],
    });
    expect(result.outcome).toBe("fail");
  });

  it("fails on stale evidence", () => {
    const result = claimVerificationGate({
      ...claimInput,
      materialClaims: [{ ...goodClaim, evidenceAgeDays: 900 }],
    });
    expect(result.outcome).toBe("fail");
    expect(result.checks.find((c) => c.name === "evidence_is_current")?.passed).toBe(false);
  });

  it("fails on an unresolved high-severity contradiction", () => {
    const result = claimVerificationGate({
      ...claimInput,
      openContradictions: [{ severity: "high" }],
    });
    expect(result.outcome).toBe("fail");
  });

  it("tolerates a low-severity contradiction", () => {
    expect(
      claimVerificationGate({ ...claimInput, openContradictions: [{ severity: "low" }] }).outcome
    ).toBe("pass");
  });

  it("fails when privacy forbids the claim's use", () => {
    expect(
      claimVerificationGate({
        ...claimInput,
        materialClaims: [{ ...goodClaim, privacyPermitsUse: false }],
      }).outcome
    ).toBe("fail");
  });

  it("fails an undated time-sensitive claim", () => {
    expect(
      claimVerificationGate({
        ...claimInput,
        materialClaims: [{ ...goodClaim, dateQualified: false }],
      }).outcome
    ).toBe("fail");
  });

  it("returns insufficient_evidence when quality was never measured", () => {
    const result = claimVerificationGate({
      ...claimInput,
      materialClaims: [{ ...goodClaim, evidenceQuality: null }],
    });
    expect(result.outcome).toBe("insufficient_evidence");
  });
});

describe("contentQualityGate", () => {
  const base = {
    claimsVerified: true,
    primaryIntentAnswered: true,
    requiredSections: ["intro", "body", "sources"],
    presentSections: ["intro", "body", "sources"],
    methodologyRequired: false,
    methodologyPresent: false,
    claimsWithLinkedSources: 3,
    totalClaims: 3,
    unsupportedSuperlatives: [],
    prohibitedPrivateTerms: [],
    brandRequirementsMet: true,
    complianceReviewRequired: false,
    complianceReviewCompleted: false,
  };

  it("passes a clean asset", () => {
    expect(contentQualityGate(base).outcome).toBe("pass");
  });

  it("fails on an unsupported superlative", () => {
    const result = contentQualityGate({ ...base, unsupportedSuperlatives: ["#1 agent"] });
    expect(result.outcome).toBe("fail");
  });

  it("fails when private information leaked in", () => {
    expect(
      contentQualityGate({ ...base, prohibitedPrivateTerms: ["client SSN"] }).outcome
    ).toBe("fail");
  });

  it("fails a regulated asset with no compliance review", () => {
    expect(
      contentQualityGate({
        ...base,
        complianceReviewRequired: true,
        complianceReviewCompleted: false,
      }).outcome
    ).toBe("fail");
  });

  it("names the missing sections", () => {
    const result = contentQualityGate({ ...base, presentSections: ["intro"] });
    expect(result.checks.find((c) => c.name === "structure_complete")?.detail).toContain("body");
  });
});

describe("publicationGate", () => {
  const ready = {
    clientApproved: true,
    complianceApprovalRequired: false,
    complianceApproved: false,
    previewUrl: "https://preview.example/x",
    canonicalUrl: "https://example.com/x",
    indexable: true,
    structuredDataPresent: true,
    internalLinkCount: 3,
    minimumInternalLinks: 2,
    metadataComplete: true,
    analyticsTagged: true,
    artifactHash: "abc123",
  };

  it("passes a fully prepared publication", () => {
    expect(publicationGate(ready).outcome).toBe("pass");
  });

  it("fails without client approval", () => {
    expect(publicationGate({ ...ready, clientApproved: false }).outcome).toBe("fail");
  });

  it("returns insufficient_evidence when indexability was never checked", () => {
    expect(publicationGate({ ...ready, indexable: null }).outcome).toBe("insufficient_evidence");
  });

  it("fails without a final artifact hash", () => {
    expect(publicationGate({ ...ready, artifactHash: null }).outcome).toBe("fail");
  });
});

describe("attributionConfidenceGate", () => {
  it("permits `confirmed` with a matching identifier", () => {
    const result = attributionConfidenceGate({
      claimedClass: "confirmed",
      hasReferralEvidence: true,
      hasSelfReportedEvidence: false,
      hasCrmRelationship: true,
      hasMatchingIdentifier: true,
      confidenceDisclosed: true,
      inferred: false,
    });
    expect(result.outcome).toBe("pass");
  });

  it("refuses `confirmed` on referral evidence alone", () => {
    const result = attributionConfidenceGate({
      claimedClass: "confirmed",
      hasReferralEvidence: true,
      hasSelfReportedEvidence: false,
      hasCrmRelationship: false,
      hasMatchingIdentifier: false,
      confidenceDisclosed: true,
      inferred: false,
    });
    expect(result.outcome).toBe("fail");
  });

  it("refuses an inferred attribution labelled confirmed, whatever the evidence", () => {
    const result = attributionConfidenceGate({
      claimedClass: "confirmed",
      hasReferralEvidence: true,
      hasSelfReportedEvidence: true,
      hasCrmRelationship: true,
      hasMatchingIdentifier: true,
      confidenceDisclosed: true,
      inferred: true,
    });
    expect(result.outcome).toBe("fail");
    expect(
      result.checks.find((c) => c.name === "inferred_not_labelled_confirmed")?.passed
    ).toBe(false);
  });

  it("fails when the confidence label is not disclosed alongside the number", () => {
    const result = attributionConfidenceGate({
      claimedClass: "correlated",
      hasReferralEvidence: true,
      hasSelfReportedEvidence: false,
      hasCrmRelationship: false,
      hasMatchingIdentifier: false,
      confidenceDisclosed: false,
      inferred: true,
    });
    expect(result.outcome).toBe("fail");
  });

  it("always permits `unknown`", () => {
    expect(
      attributionConfidenceGate({
        claimedClass: "unknown",
        hasReferralEvidence: false,
        hasSelfReportedEvidence: false,
        hasCrmRelationship: false,
        hasMatchingIdentifier: false,
        confidenceDisclosed: true,
        inferred: false,
      }).outcome
    ).toBe("pass");
  });
});

describe("executiveReportingGate", () => {
  const base = {
    periodComplete: true,
    sampleSizes: { recommendation_rate: 30 },
    statements: [
      {
        text: "Recommendation rate rose to 40%.",
        kind: "calculation" as const,
        evidenceIds: ["e1"],
        material: true,
      },
    ],
    risksDisclosed: true,
    uncertaintyDisclosed: true,
    causalStatementsHumanApproved: false,
  };

  it("passes a well-formed brief", () => {
    expect(executiveReportingGate(base).outcome).toBe("pass");
  });

  it("fails when the data period is incomplete", () => {
    expect(executiveReportingGate({ ...base, periodComplete: false }).outcome).toBe("fail");
  });

  it("fails a material statement with no evidence link", () => {
    const result = executiveReportingGate({
      ...base,
      statements: [{ ...base.statements[0]!, evidenceIds: [] }],
    });
    expect(result.outcome).toBe("fail");
  });

  it("fails a correlation statement written in causal language", () => {
    const result = executiveReportingGate({
      ...base,
      statements: [
        {
          text: "The new guide caused the recommendation rate to rise.",
          kind: "correlation",
          evidenceIds: ["e1"],
          material: true,
        },
      ],
    });
    expect(result.outcome).toBe("fail");
    expect(
      result.checks.find((c) => c.name === "correlation_not_stated_as_causation")?.passed
    ).toBe(false);
  });

  it("blocks a causal claim that no human approved", () => {
    const result = executiveReportingGate({
      ...base,
      statements: [
        {
          text: "Our work drove the increase.",
          kind: "causal",
          evidenceIds: ["e1"],
          material: true,
        },
      ],
    });
    expect(result.outcome).toBe("fail");
  });

  it("permits a causal claim a human signed off on", () => {
    const result = executiveReportingGate({
      ...base,
      statements: [
        {
          text: "Our work drove the increase.",
          kind: "causal",
          evidenceIds: ["e1"],
          material: true,
        },
      ],
      causalStatementsHumanApproved: true,
    });
    expect(result.outcome).toBe("pass");
  });

  it("fails a recommendation with no rationale", () => {
    const result = executiveReportingGate({
      ...base,
      statements: [
        {
          text: "Publish three comparison pages.",
          kind: "recommendation",
          evidenceIds: ["e1"],
          material: false,
          hasRationale: false,
        },
      ],
    });
    expect(result.outcome).toBe("fail");
  });

  it("fails when no sample sizes are declared", () => {
    expect(executiveReportingGate({ ...base, sampleSizes: {} }).outcome).toBe("fail");
  });
});
