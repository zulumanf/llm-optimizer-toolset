/**
 * Quality gates (spec 018 Part 8). Four reusable, fully deterministic gates.
 *
 * A gate returns `pass`, `fail`, or `insufficient_evidence` — never a score to
 * be interpreted. `insufficient_evidence` is a distinct outcome on purpose: the
 * difference between "this is wrong" and "I cannot tell" is the difference
 * between a system you can hand a client and one you cannot.
 *
 * Every gate is a pure function of its input so the whole set is unit-testable
 * without a database. The engine fetches the inputs; the gate judges them.
 *
 * Two gates were deleted (spec 065): content_quality and publication shipped
 * with spec 018 but were never invoked — they assumed a publication pipeline
 * (canonical URLs, analytics tagging, compliance sign-off fields) the
 * platform does not track. The real publication controls are publishReport's
 * narrative gate + QA preflight (lib/qa/preflight.ts), publishAudit's
 * evidence/warning flow, and lib/content/validate.ts.
 */

export const GATE_VERSION = "v1.0";

export type GateOutcome = "pass" | "fail" | "insufficient_evidence";

export interface GateCheck {
  name: string;
  passed: boolean;
  /** True when the check could not be evaluated at all. */
  indeterminate?: boolean;
  detail: string;
}

export interface GateResult {
  gateType: GateType;
  gateVersion: string;
  outcome: GateOutcome;
  checks: GateCheck[];
  /** Human-readable summary of why the gate landed where it did. */
  reason: string;
}

export const GATE_TYPES = [
  "evidence_completeness",
  "claim_verification",
  "attribution_confidence",
  "executive_reporting",
] as const;
export type GateType = (typeof GATE_TYPES)[number];

function settle(gateType: GateType, checks: GateCheck[]): GateResult {
  const indeterminate = checks.filter((c) => c.indeterminate);
  const failed = checks.filter((c) => !c.passed && !c.indeterminate);
  let outcome: GateOutcome;
  let reason: string;
  if (failed.length > 0) {
    outcome = "fail";
    reason = `${failed.length} check(s) failed: ${failed.map((c) => c.name).join(", ")}`;
  } else if (indeterminate.length > 0) {
    outcome = "insufficient_evidence";
    reason = `${indeterminate.length} check(s) could not be evaluated: ${indeterminate
      .map((c) => c.name)
      .join(", ")}`;
  } else {
    outcome = "pass";
    reason = `all ${checks.length} checks passed`;
  }
  return { gateType, gateVersion: GATE_VERSION, outcome, checks, reason };
}

const check = (name: string, passed: boolean, detail: string): GateCheck => ({
  name,
  passed,
  detail,
});
const unknown = (name: string, detail: string): GateCheck => ({
  name,
  passed: false,
  indeterminate: true,
  detail,
});

// ------------------------------------------------- A. evidence completeness

export interface EvidenceCompletenessInput {
  requiredUpstreamTotal: number;
  requiredUpstreamCompleted: number;
  sampleSize: number;
  minimumSampleSize: number;
  rawEvidenceCount: number;
  requiredArtifactKinds: string[];
  presentArtifactKinds: string[];
  hashesValid: boolean | null;
  classifiedCount: number;
  lowConfidenceCount: number;
  lowConfidenceRoutedCount: number;
  partialFailureCount: number;
  partialFailureDisclosed: boolean;
}

export function evidenceCompletenessGate(input: EvidenceCompletenessInput): GateResult {
  const missingArtifacts = input.requiredArtifactKinds.filter(
    (kind) => !input.presentArtifactKinds.includes(kind)
  );
  return settle("evidence_completeness", [
    check(
      "required_inputs_complete",
      input.requiredUpstreamCompleted >= input.requiredUpstreamTotal,
      `${input.requiredUpstreamCompleted}/${input.requiredUpstreamTotal} required upstream nodes completed`
    ),
    check(
      "minimum_sample_size",
      input.sampleSize >= input.minimumSampleSize,
      `sample ${input.sampleSize} vs minimum ${input.minimumSampleSize}`
    ),
    check("raw_evidence_present", input.rawEvidenceCount > 0, `${input.rawEvidenceCount} raw captures`),
    check(
      "required_artifacts_present",
      missingArtifacts.length === 0,
      missingArtifacts.length === 0 ? "all required artifacts present" : `missing: ${missingArtifacts.join(", ")}`
    ),
    input.hashesValid === null
      ? unknown("hashes_valid", "integrity was not verified for this evidence set")
      : check("hashes_valid", input.hashesValid, input.hashesValid ? "all hashes match" : "hash mismatch detected"),
    check(
      "classifications_present",
      input.classifiedCount >= input.sampleSize,
      `${input.classifiedCount}/${input.sampleSize} observations classified`
    ),
    check(
      "low_confidence_routed",
      input.lowConfidenceRoutedCount >= input.lowConfidenceCount,
      `${input.lowConfidenceRoutedCount}/${input.lowConfidenceCount} low-confidence observations routed to review`
    ),
    check(
      "partial_failure_disclosed",
      input.partialFailureCount === 0 || input.partialFailureDisclosed,
      input.partialFailureCount === 0
        ? "no partial failures"
        : `${input.partialFailureCount} partial failure(s) ${input.partialFailureDisclosed ? "disclosed" : "NOT disclosed"}`
    ),
  ]);
}

// ----------------------------------------------------- B. claim verification

export interface MaterialClaimUse {
  claimId: string | null;
  text: string;
  hasEvidence: boolean;
  evidenceAgeDays: number | null;
  evidenceQuality: number | null;
  usesApprovedWording: boolean;
  privacyPermitsUse: boolean;
  dateQualified: boolean;
}

export interface ClaimVerificationInput {
  materialClaims: MaterialClaimUse[];
  openContradictions: { severity: string }[];
  maxEvidenceAgeDays: number;
  minEvidenceQuality: number;
}

export function claimVerificationGate(input: ClaimVerificationInput): GateResult {
  const unsupported = input.materialClaims.filter((c) => !c.hasEvidence || c.claimId === null);
  const stale = input.materialClaims.filter(
    (c) => c.evidenceAgeDays !== null && c.evidenceAgeDays > input.maxEvidenceAgeDays
  );
  const unmeasured = input.materialClaims.filter((c) => c.evidenceQuality === null);
  const lowQuality = input.materialClaims.filter(
    (c) => c.evidenceQuality !== null && c.evidenceQuality < input.minEvidenceQuality
  );
  const wrongWording = input.materialClaims.filter((c) => !c.usesApprovedWording);
  const privacyBlocked = input.materialClaims.filter((c) => !c.privacyPermitsUse);
  const undated = input.materialClaims.filter((c) => !c.dateQualified);
  const severe = input.openContradictions.filter(
    (c) => c.severity === "high" || c.severity === "critical"
  );

  const checks: GateCheck[] = [
    check(
      "every_material_claim_has_evidence",
      unsupported.length === 0,
      unsupported.length === 0 ? "all claims evidenced" : `${unsupported.length} unsupported: ${unsupported.map((c) => c.text.slice(0, 60)).join(" | ")}`
    ),
    check(
      "evidence_is_current",
      stale.length === 0,
      stale.length === 0 ? `all evidence within ${input.maxEvidenceAgeDays}d` : `${stale.length} claim(s) rest on stale evidence`
    ),
    check(
      "evidence_quality_threshold",
      lowQuality.length === 0,
      lowQuality.length === 0 ? "quality threshold met" : `${lowQuality.length} claim(s) below ${input.minEvidenceQuality}`
    ),
    check(
      "no_unresolved_high_severity_contradiction",
      severe.length === 0,
      severe.length === 0 ? "no severe contradictions" : `${severe.length} unresolved high-severity contradiction(s)`
    ),
    check(
      "approved_wording_used",
      wrongWording.length === 0,
      wrongWording.length === 0 ? "wording matches approved phrasing" : `${wrongWording.length} claim(s) use non-approved wording`
    ),
    check(
      "privacy_permits_use",
      privacyBlocked.length === 0,
      privacyBlocked.length === 0 ? "privacy status permits every claim" : `${privacyBlocked.length} claim(s) are privacy-restricted`
    ),
    check(
      "date_qualification_present",
      undated.length === 0,
      undated.length === 0 ? "all time-sensitive claims are dated" : `${undated.length} claim(s) lack a date qualification`
    ),
  ];
  if (unmeasured.length > 0) {
    checks.push(
      unknown("evidence_quality_measured", `${unmeasured.length} claim(s) have no quality score`)
    );
  }
  return settle("claim_verification", checks);
}

// ------------------------------------------------- E. attribution confidence

export const ATTRIBUTION_CLASSES = [
  "confirmed",
  "strongly_supported",
  "correlated",
  "probable",
  "unknown",
] as const;
export type AttributionClass = (typeof ATTRIBUTION_CLASSES)[number];

export interface AttributionConfidenceInput {
  claimedClass: AttributionClass;
  hasReferralEvidence: boolean;
  hasSelfReportedEvidence: boolean;
  hasCrmRelationship: boolean;
  hasMatchingIdentifier: boolean;
  confidenceDisclosed: boolean;
  /** True when the class was produced by inference rather than an identifier. */
  inferred: boolean;
}

/**
 * The evidence classes each attribution label requires. `confirmed` needs a
 * hard identifier — a matching id or a client's own statement. Nothing else
 * earns that word.
 */
export function attributionConfidenceGate(input: AttributionConfidenceInput): GateResult {
  const hardEvidence = input.hasMatchingIdentifier || input.hasSelfReportedEvidence;
  const anyEvidence =
    hardEvidence || input.hasReferralEvidence || input.hasCrmRelationship;

  const sufficient =
    input.claimedClass === "unknown"
      ? true
      : input.claimedClass === "confirmed"
        ? hardEvidence
        : input.claimedClass === "strongly_supported"
          ? hardEvidence || (input.hasReferralEvidence && input.hasCrmRelationship)
          : anyEvidence;

  return settle("attribution_confidence", [
    check(
      "evidence_supports_claimed_class",
      sufficient,
      sufficient
        ? `evidence supports "${input.claimedClass}"`
        : `"${input.claimedClass}" is not supported by the available evidence`
    ),
    check(
      "confidence_disclosed",
      input.confidenceDisclosed,
      "the confidence label travels with the number"
    ),
    check(
      "inferred_not_labelled_confirmed",
      !(input.inferred && input.claimedClass === "confirmed"),
      input.inferred && input.claimedClass === "confirmed"
        ? "an inferred attribution is labelled confirmed — never permitted"
        : "no inferred attribution is labelled confirmed"
    ),
  ]);
}

// ------------------------------------------------- F. executive reporting

export interface ReportStatement {
  text: string;
  kind: "fact" | "calculation" | "interpretation" | "recommendation" | "correlation" | "causal" | "unknown";
  evidenceIds: string[];
  material: boolean;
  hasRationale?: boolean;
}

export interface ExecutiveReportingInput {
  periodComplete: boolean;
  sampleSizes: Record<string, number>;
  statements: ReportStatement[];
  risksDisclosed: boolean;
  uncertaintyDisclosed: boolean;
  /** Causal statements are only permitted when a human signed off on them. */
  causalStatementsHumanApproved: boolean;
}

/** The one causal-phrase list (spec 051, extended spec 060): shared by the
 * executive brief gate and the client report narrative gate — never a third
 * copy. The 060 additions cover guarantee-language a citation-acquisition
 * narrative is most tempted to slip into. */
export const CAUSAL_PHRASES = [
  "caused",
  "because of our",
  "drove the",
  "resulted in",
  "led to",
  "guaranteed",
  "will improve",
  "ranks because",
  "directly resulted",
  "proven to",
  "ensures",
];

// Word-boundary matching, not bare substrings: "ensures" must not fire
// inside "censures" nor "led to" inside "travelled to" — this gate hard-
// blocks publishing, so a false positive costs an operator a reword of
// innocent prose.
const CAUSAL_PHRASE_RES = CAUSAL_PHRASES.map(
  (phrase) =>
    new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")
);

/** The phrase the text trips on, or null. The one matcher for both gates. */
export function findCausalPhrase(text: string): string | null {
  const index = CAUSAL_PHRASE_RES.findIndex((re) => re.test(text));
  return index === -1 ? null : CAUSAL_PHRASES[index]!;
}

export function executiveReportingGate(input: ExecutiveReportingInput): GateResult {
  const materialWithoutEvidence = input.statements.filter(
    (s) => s.material && s.evidenceIds.length === 0
  );
  const recsWithoutRationale = input.statements.filter(
    (s) => s.kind === "recommendation" && s.hasRationale === false
  );
  const causal = input.statements.filter((s) => s.kind === "causal");
  // A statement labelled "correlation" that reads causally is the failure mode
  // this check exists for — the label is not enough, the wording must match.
  const mislabelledCausal = input.statements.filter(
    (s) => s.kind === "correlation" && findCausalPhrase(s.text) !== null
  );
  const kinds = new Set(input.statements.map((s) => s.kind));

  return settle("executive_reporting", [
    check("data_period_complete", input.periodComplete, "the reporting period has complete data"),
    check(
      "sample_sizes_present",
      Object.keys(input.sampleSizes).length > 0,
      `${Object.keys(input.sampleSizes).length} sample size(s) declared`
    ),
    check(
      "facts_separated_from_interpretation",
      input.statements.length === 0 || kinds.size > 1 || !kinds.has("interpretation"),
      "statements carry an explicit kind"
    ),
    check(
      "correlation_not_stated_as_causation",
      mislabelledCausal.length === 0,
      mislabelledCausal.length === 0
        ? "no correlation is worded causally"
        : `${mislabelledCausal.length} correlation statement(s) use causal language`
    ),
    check(
      "causal_claims_human_approved",
      causal.length === 0 || input.causalStatementsHumanApproved,
      causal.length === 0 ? "no causal claims" : `${causal.length} causal claim(s) require human sign-off`
    ),
    check(
      "material_claims_link_to_evidence",
      materialWithoutEvidence.length === 0,
      materialWithoutEvidence.length === 0
        ? "every material statement links to evidence"
        : `${materialWithoutEvidence.length} material statement(s) have no evidence`
    ),
    check(
      "recommendations_have_rationale",
      recsWithoutRationale.length === 0,
      recsWithoutRationale.length === 0 ? "recommendations carry rationale" : `${recsWithoutRationale.length} without rationale`
    ),
    check("risks_disclosed", input.risksDisclosed, "risks disclosed"),
    check("uncertainty_disclosed", input.uncertaintyDisclosed, "uncertainty disclosed"),
  ]);
}
