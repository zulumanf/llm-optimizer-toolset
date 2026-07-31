/**
 * Authority and reputation workflows: content production, repurposing,
 * transaction-to-authority, profile correction, competitor intelligence.
 *
 * These are the workflows that put words in public on a client's behalf, so they
 * carry the strictest gates in the platform: claim verification, adversarial
 * review, privacy classification, and a human approval that cannot be bypassed
 * by an autonomy policy. A claim that cannot be supported blocks publication —
 * it is never softened into a hedge, because hedging conceals that we could not
 * support it.
 */
import {
  act,
  agent,
  branch,
  control,
  defineWorkflow,
  edge,
  fanIn,
  fanOut,
  fetch,
  human,
  step,
  success,
  trigger,
  verify,
} from "@/lib/automation/workflows/helpers";

// ------------------------------------- 8. Content production (v2)

export const CONTENT_V2_KEY = "content_production_v2";

export const contentProductionWorkflowV2 = defineWorkflow({
  key: CONTENT_V2_KEY,
  name: "Content production",
  description:
    "Take a content opportunity from commercial scoring through evidence assembly, research fan-out, brief, draft, claim verification, adversarial review, compliance, approval, CMS publication, live verification and scheduled remeasurement.",
  domain: "authority",
  owner: "fulfilment operator",
  actionType: "content_publishing",
  autonomyLevel: 2,
  riskClassification: "high",
  maxCostMicroUsd: 6_000_000,
  maxDurationMinutes: 10_080, // 7 days — client approval takes time
  maxParallel: 8,
  requiredApprovals: ["approve_content"],
  requiredConnectors: ["cms.create_draft", "cms.publish_approved_asset", "cms.fetch_public_page"],
  evaluationSuite: "content-quality-v1",
  triggers: [
    {
      kind: "domain_event",
      eventType: "content.opportunity_created",
      autonomyNote:
        "Research and drafting are internal and produce nothing public. Every node that could make text public is approval-gated at autonomy 2 regardless of client policy.",
      idempotencyTemplate: "content:{{payload.opportunityId}}",
      description: "An evidence gap became a content opportunity",
    },
    { kind: "manual", description: "An operator commissions an asset" },
  ],
  acceptanceCriteria: [
    "Every factual statement in the published asset maps to an evidence id.",
    "A blocking adversarial finding prevents publication; it does not become a caveat.",
    "Superlatives, guarantees, undocumented volume and confidential transaction detail are refused.",
    "Publication requires the id of the approval that released it.",
    "The live page is verified after publication, not assumed.",
    "Remeasurement is scheduled so the asset's effect becomes measurable.",
  ],
  nodes: [
    trigger("entry", "domain_event", "Content opportunity created"),
    step("commercial_value", "det.calculate_priority", "Score commercial value", {
      sourcePath: "payload",
    }),
    step("evidence_gap", "det.check_evidence_freshness", "Score the evidence gap", {
      maxAgeDays: 120,
    }),
    human(
      "approve_pursuit",
      "choose_strategy",
      "Approve pursuing this opportunity",
      { artifactPath: "commercial_value" },
      { riskLevel: "low" }
    ),
    step(
      "packet",
      "dom.build_evidence_packet",
      "Build the evidence packet",
      { purpose: "content_production", audience: "public" },
      { requiredEvidence: ["public_page", "document"] }
    ),
    // Research fans out so several angles are covered concurrently; the fan-in
    // discloses how many actually returned.
    fanOut("research_fan", "Fan out research angles", "packet.claims", "id"),
    agent("research", "analyze_competitor_evidence", "Research one angle", {
      contextPath: "research_fan",
    }),
    verify("verify_sources", "verify_claims", "Verify the sources", {
      contextPath: "research",
    }),
    fanIn("research_done", "Join the research", 1),
    control("evidence_gate", "ctl.evidence_gate", "Is the evidence sufficient to write?", {
      packetPath: "packet",
      minimumSampleSize: 2,
    }),

    agent("brief", "build_content_brief", "Create the brief", { contextPath: "packet" }),
    agent("draft", "draft_content", "Draft the asset", { contextPath: "brief" }),
    verify("claim_verification", "verify_content", "Verify every claim", {
      contextPath: "draft",
    }),
    // Adversarial review runs with fresh context. Its job is to find the reason
    // NOT to publish, which is a different task from verifying claims.
    verify("adversarial", "adversarial_content_review", "Adversarial review", {
      contextPath: "draft",
    }),
    control("publishable", "ctl.condition", "Did adversarial review clear it?", {
      path: "adversarial.publishable",
      comparator: "eq",
      value: true,
    }),
    step("block_publication", "ctl.safe_stop", "Block — blocking issues found", {
      reason:
        "adversarial review found a blocking issue; the asset is not published and the issues are returned for revision",
    }),
    control("claims_ok", "ctl.condition", "Are all claims supported?", {
      path: "claim_verification.allSupported",
      comparator: "eq",
      value: true,
    }),

    human(
      "internal_approval",
      "approve_content",
      "Internal approval",
      { artifactPath: "draft", evidenceIdsPath: "packet.evidenceIds" },
      { riskLevel: "high", approvalRole: "operator" }
    ),
    human(
      "client_approval",
      "approve_content",
      "Client approval",
      { artifactPath: "draft", evidenceIdsPath: "packet.evidenceIds" },
      { riskLevel: "high", approvalRole: "admin" }
    ),
    act(
      "cms_draft",
      "cms.create_draft",
      "Create the CMS draft",
      { inputPath: "draft" },
      { riskLevel: "medium" }
    ),
    act(
      "publish",
      "cms.publish_approved_asset",
      "Publish the approved asset",
      { inputPath: "cms_draft", actionType: "cms_public_publishing" },
      { riskLevel: "critical" }
    ),
    // Verify the page is actually live. "We called the publish endpoint" is not
    // the same fact as "the page exists".
    fetch("verify_live", "cms.fetch_public_page", "Verify the live page", {
      inputPath: "publish",
    }),
    step("record_outcome", "dom.record_action_outcome", "Record the action in the outcome graph", {
      actionPath: "draft",
      actionType: "content_published",
      expectedDaysToImpact: 45,
    }),
    step("schedule_remeasure", "det.schedule_remeasurement", "Schedule remeasurement", {
      days: 45,
    }),
    step("publish_event", "dom.publish_event", "Publish content.published", {
      eventType: "content.published",
      payloadPath: "cms_draft.data",
    }),
    success("done", "Asset published and scheduled for remeasurement"),
  ],
  edges: [
    edge("entry", "commercial_value"),
    edge("entry", "evidence_gap"),
    edge("commercial_value", "approve_pursuit"),
    edge("evidence_gap", "approve_pursuit", { required: false }),
    edge("approve_pursuit", "packet"),
    edge("packet", "research_fan"),
    edge("research_fan", "research"),
    edge("research", "verify_sources"),
    edge("verify_sources", "research_done"),
    edge("research_done", "evidence_gate"),
    edge("evidence_gate", "brief"),
    edge("brief", "draft"),
    edge("draft", "claim_verification"),
    edge("draft", "adversarial"),
    edge("adversarial", "publishable"),
    // Not publishable → blocked. Publishable → still has to clear claims.
    branch("publishable", "block_publication", false),
    branch("publishable", "claims_ok", true),
    edge("claim_verification", "claims_ok", { required: false }),
    branch("claims_ok", "block_publication", false),
    branch("claims_ok", "internal_approval", true),
    edge("internal_approval", "client_approval"),
    edge("client_approval", "cms_draft"),
    edge("cms_draft", "publish"),
    edge("publish", "verify_live"),
    edge("verify_live", "record_outcome"),
    edge("record_outcome", "schedule_remeasure"),
    edge("schedule_remeasure", "publish_event"),
    edge("publish_event", "done"),
  ],
});

// ------------------------------------- 9. Content repurposing

export const REPURPOSING_KEY = "content_repurposing_v1";

export const contentRepurposingWorkflow = defineWorkflow({
  key: REPURPOSING_KEY,
  name: "Content repurposing",
  description:
    "Turn an approved primary asset into channel-specific drafts, verifying that every derivative claim already appears in the approved source.",
  domain: "authority",
  owner: "fulfilment operator",
  actionType: "content_repurposing",
  autonomyLevel: 2,
  riskClassification: "medium",
  maxCostMicroUsd: 2_000_000,
  maxDurationMinutes: 240,
  maxParallel: 8,
  requiredApprovals: ["approve_content"],
  requiredConnectors: ["notification.send_internal"],
  triggers: [
    {
      kind: "domain_event",
      eventType: "content.published",
      autonomyNote:
        "Derivatives are drafted only. Nothing is published externally unless the client's autonomy policy explicitly permits that channel.",
      idempotencyTemplate: "repurpose:{{payload.assetId}}",
      description: "A primary asset went live",
    },
  ],
  acceptanceCriteria: [
    "A derivative may only use claims present in the approved source.",
    "Each format is drafted independently and joined with disclosure of failures.",
    "External publication requires the client's explicit autonomy permission.",
    "Derivative assets are recorded against their source.",
  ],
  nodes: [
    trigger("entry", "domain_event", "Primary asset published"),
    step("retrieve", "det.fetch_record", "Retrieve the approved version", {
      table: "content_assets",
      idPath: "payload.assetId",
    }),
    step("allowed_claims", "dom.build_evidence_packet", "Identify the allowed claims", {
      purpose: "content_repurposing",
      audience: "public",
    }),
    fanOut("format_fan", "Fan out by format", "allowed_claims.claims", "id"),
    agent("repurpose", "repurpose_content", "Create the channel draft", {
      contextPath: "format_fan",
    }),
    verify("verify_derivative", "verify_claims", "Verify against the primary asset", {
      contextPath: "repurpose",
    }),
    fanIn("formats_done", "Join the formats", 1),
    control("autonomy", "ctl.autonomy_gate", "May these publish externally?", {
      actionType: "content_repurposing",
      workflowKey: REPURPOSING_KEY,
      workflowLevel: 2,
    }),
    human(
      "approve",
      "approve_content",
      "Approve the derivative assets",
      { artifactPath: "formats_done", evidenceIdsPath: "allowed_claims.evidenceIds" },
      { riskLevel: "medium" }
    ),
    step("record", "dom.record_action_outcome", "Record the derivative assets", {
      actionType: "content_repurposed",
      expectedDaysToImpact: 30,
      actionPath: "retrieve.record",
    }),
    success("done", "Derivatives drafted and recorded"),
  ],
  edges: [
    edge("entry", "retrieve"),
    edge("retrieve", "allowed_claims"),
    edge("allowed_claims", "format_fan"),
    edge("format_fan", "repurpose"),
    edge("repurpose", "verify_derivative"),
    edge("verify_derivative", "formats_done"),
    edge("formats_done", "autonomy"),
    edge("autonomy", "approve"),
    edge("approve", "record"),
    edge("record", "done"),
  ],
});

// ------------------------------------- 10. Reputation / profile correction

export const PROFILE_CORRECTION_KEY = "reputation_profile_correction_v1";

export const profileCorrectionWorkflow = defineWorkflow({
  key: PROFILE_CORRECTION_KEY,
  name: "Reputation and profile correction",
  description:
    "Scan public profiles, compare their claims against the approved knowledge graph, score severity, draft an evidence-backed correction, submit it through a supported channel, and verify the correction live.",
  domain: "reputation",
  owner: "fulfilment operator",
  actionType: "profile_correction",
  autonomyLevel: 2,
  riskClassification: "high",
  maxCostMicroUsd: 2_500_000,
  maxDurationMinutes: 10_080,
  maxParallel: 6,
  requiredApprovals: ["approve_profile_correction"],
  requiredConnectors: ["cms.fetch_public_page", "email.create_draft"],
  triggers: [
    {
      kind: "schedule",
      key: "profile_scan",
      cron: "0 5 * * 2",
      timezone: "America/New_York",
      missedRunPolicy: "run_once",
      description: "Weekly profile scan",
    },
    {
      kind: "domain_event",
      eventType: "profile.error_detected",
      autonomyNote:
        "Detection and drafting are internal. Submitting anything to a third party on the client's behalf is approval-gated without exception.",
      idempotencyTemplate: "profile:{{payload.profileUrl}}",
      description: "An incorrect public profile was detected",
    },
  ],
  acceptanceCriteria: [
    "No correction is submitted without evidence.",
    "The approved knowledge graph is the reference, not the agent's recollection.",
    "Severity is computed deterministically from the type of inaccuracy.",
    "Before-and-after evidence is archived for every submitted correction.",
    "Corrections through unsupported channels become manual tasks, not silent failures.",
  ],
  nodes: [
    trigger("entry", "schedule", "Profile scan"),
    fetch("fetch_profile", "cms.fetch_public_page", "Fetch the profile", {
      inputPath: "payload",
    }),
    agent("extract", "extract_claims", "Extract the profile's claims", {
      contextPath: "fetch_profile.data",
    }),
    step("approved_facts", "dom.build_evidence_packet", "Load the approved facts", {
      purpose: "profile_correction",
      audience: "public",
    }),
    verify("compare", "detect_contradictions", "Compare against approved facts", {
      contextPath: "approved_facts",
    }),
    control("has_error", "ctl.condition", "Is there an omission or contradiction?", {
      path: "compare.contradictions.0.severity",
      comparator: "truthy",
    }),
    step("no_error", "det.query_records", "Record a clean profile", {
      table: "runs",
      limit: 1,
    }),
    step("severity", "det.classify_threshold", "Score severity", {
      valuePath: "compare.confidence",
      bands: [
        { label: "critical", min: 0.9 },
        { label: "high", min: 0.7, max: 0.9 },
        { label: "medium", min: 0.4, max: 0.7 },
        { label: "low", max: 0.4 },
      ],
    }),
    agent("draft_correction", "draft_outreach", "Draft the correction", {
      contextPath: "compare",
    }),
    verify("verify_correction", "verify_claims", "Verify the correction's claims", {
      contextPath: "draft_correction",
    }),
    human(
      "approve",
      "approve_profile_correction",
      "Approve the correction",
      { artifactPath: "draft_correction", evidenceIdsPath: "approved_facts.evidenceIds" },
      { riskLevel: "high", approvalRole: "operator" }
    ),
    act(
      "submit",
      "email.create_draft",
      "Submit through the supported channel",
      { inputPath: "draft_correction" },
      { riskLevel: "high" }
    ),
    step("archive_before_after", "det.hash_artifact", "Archive before-and-after evidence", {
      contentPath: "fetch_profile.data",
    }),
    step("schedule_verify", "det.schedule_remeasurement", "Schedule live verification", {
      days: 14,
    }),
    step("publish_event", "dom.publish_event", "Publish correction_approved", {
      eventType: "profile.correction_approved",
      payloadPath: "payload",
    }),
    success("done", "Correction submitted and tracked"),
  ],
  edges: [
    edge("entry", "fetch_profile"),
    edge("fetch_profile", "extract"),
    edge("extract", "approved_facts"),
    edge("approved_facts", "compare"),
    edge("compare", "has_error"),
    branch("has_error", "no_error", false),
    branch("has_error", "severity", true),
    edge("severity", "draft_correction"),
    edge("draft_correction", "verify_correction"),
    edge("verify_correction", "approve"),
    edge("approve", "submit"),
    edge("submit", "archive_before_after"),
    edge("archive_before_after", "schedule_verify"),
    edge("schedule_verify", "publish_event"),
    edge("publish_event", "done"),
    edge("no_error", "done", { required: false }),
  ],
});

// ------------------------------------- 11. Competitor intelligence

export const COMPETITOR_INTEL_KEY = "competitor_intelligence_v1";

export const competitorIntelligenceWorkflow = defineWorkflow({
  key: COMPETITOR_INTEL_KEY,
  name: "Competitor intelligence",
  description:
    "Detect material competitor and source changes weekly, classify each finding as verified change, interpretation, hypothesis or unknown, and surface only what matters.",
  domain: "intelligence",
  owner: "fulfilment operator",
  actionType: "competitor_intelligence",
  autonomyLevel: 3,
  riskClassification: "low",
  maxCostMicroUsd: 1_500_000,
  maxDurationMinutes: 120,
  maxParallel: 8,
  requiredConnectors: ["cms.fetch_public_page"],
  triggers: [
    {
      kind: "schedule",
      key: "competitor_scan",
      cron: "0 6 * * 3",
      timezone: "America/New_York",
      missedRunPolicy: "run_once",
      description: "Weekly competitor scan",
    },
  ],
  acceptanceCriteria: [
    "Every finding is labelled verified change, interpretation, hypothesis or unknown.",
    "A competitor's strategy is never stated as fact.",
    "Only material findings reach the weekly brief; noise is filtered and counted.",
    "Findings are scoped to the client's own competitor set.",
  ],
  nodes: [
    trigger("entry", "schedule", "Weekly schedule"),
    step("competitors", "det.query_records", "Load the approved competitor set", {
      table: "companies",
      limit: 25,
      allowUnscoped: true,
    }),
    fanOut("competitor_fan", "Fan out by competitor", "competitors.records", "id"),
    fetch("fetch_source", "cms.fetch_public_page", "Fetch the competitor source", {
      inputPath: "competitor_fan",
    }),
    agent("analyze", "analyze_competitor_evidence", "Classify the changes", {
      contextPath: "fetch_source.data",
    }),
    fanIn("analyzed", "Join the competitor analyses", 1),
    step("materiality", "det.classify_threshold", "Filter for materiality", {
      valuePath: "analyzed.completed",
      bands: [
        { label: "material", min: 1 },
        { label: "noise", max: 1 },
      ],
    }),
    step("record", "dom.record_action_outcome", "Update the client intelligence graph", {
      actionType: "competitor_intelligence",
      expectedDaysToImpact: 30,
      actionPath: "analyzed",
    }),
    success("done", "Competitor intelligence updated"),
  ],
  edges: [
    edge("entry", "competitors"),
    edge("competitors", "competitor_fan"),
    edge("competitor_fan", "fetch_source"),
    edge("fetch_source", "analyze"),
    edge("analyze", "analyzed"),
    edge("analyzed", "materiality"),
    edge("materiality", "record"),
    edge("record", "done"),
  ],
});

// ------------------------------------- 12. Transaction to authority

export const TRANSACTION_AUTHORITY_KEY = "transaction_to_authority_v1";

export const transactionToAuthorityWorkflow = defineWorkflow({
  key: TRANSACTION_AUTHORITY_KEY,
  name: "Transaction to authority",
  description:
    "Verify a transaction and the client's involvement, check privacy and brokerage restrictions, fan out opportunity analysis across ranking, case study, neighbourhood, press and profile angles, then execute only the approved actions.",
  domain: "authority",
  owner: "fulfilment operator",
  actionType: "transaction_authority",
  autonomyLevel: 2,
  riskClassification: "high",
  maxCostMicroUsd: 2_500_000,
  maxDurationMinutes: 10_080,
  maxParallel: 8,
  requiredApprovals: ["verify_transaction", "approve_external_submission"],
  requiredConnectors: ["notification.send_internal"],
  triggers: [
    {
      kind: "domain_event",
      eventType: "transaction.created",
      autonomyNote:
        "Analysis is internal. Nothing about a transaction becomes public until involvement is verified, privacy permits it, and a human has approved the specific use.",
      idempotencyTemplate: "transaction:{{payload.transactionId}}",
      description: "A transaction was recorded",
    },
  ],
  acceptanceCriteria: [
    "A transaction is not used publicly until involvement is verified.",
    "Privacy classification and brokerage rules are checked before any public use.",
    "Each opportunity type is analysed independently and prioritised deterministically.",
    "Required approvals are recorded against the specific public use, not in general.",
  ],
  nodes: [
    trigger("entry", "domain_event", "Transaction recorded"),
    human(
      "verify",
      "verify_transaction",
      "Verify the transaction and the client's involvement",
      { artifactPath: "payload", evidenceIdsPath: "payload.evidenceIds" },
      { riskLevel: "high", approvalRole: "operator" }
    ),
    step("privacy_check", "dom.build_evidence_packet", "Check privacy restrictions", {
      purpose: "transaction_public_use",
      // The `public` audience filters restricted and client-only claims at
      // retrieval, so a restricted transaction cannot reach a public asset.
      audience: "public",
    }),
    control("privacy_ok", "ctl.condition", "Does privacy permit public use?", {
      path: "privacy_check.claimCount",
      comparator: "gte",
      value: 1,
    }),
    step("privacy_blocked", "ctl.safe_stop", "Stop — privacy restricts public use", {
      reason:
        "the transaction's privacy classification does not permit public use; it stays internal",
    }),
    fanOut("opportunity_fan", "Fan out opportunity analysis", "privacy_check.claims", "id"),
    agent("analyze_opportunity", "prioritize_authority_actions", "Analyse the opportunity", {
      contextPath: "opportunity_fan",
    }),
    fanIn("opportunities", "Join the opportunity analyses", 1),
    step("prioritize", "det.calculate_priority", "Prioritise the actions", {
      sourcePath: "opportunities",
    }),
    human(
      "approve_actions",
      "approve_external_submission",
      "Approve the specific public uses",
      { artifactPath: "prioritize", evidenceIdsPath: "privacy_check.evidenceIds" },
      { riskLevel: "critical", approvalRole: "admin" }
    ),
    step("record", "dom.record_action_outcome", "Record the approved actions", {
      actionType: "transaction_authority",
      expectedDaysToImpact: 60,
      actionPath: "prioritize",
    }),
    step("publish_event", "dom.publish_event", "Publish transaction.verified", {
      eventType: "transaction.verified",
      payloadPath: "payload",
    }),
    success("done", "Approved authority actions recorded"),
  ],
  edges: [
    edge("entry", "verify"),
    edge("verify", "privacy_check"),
    edge("privacy_check", "privacy_ok"),
    branch("privacy_ok", "privacy_blocked", false),
    branch("privacy_ok", "opportunity_fan", true),
    edge("opportunity_fan", "analyze_opportunity"),
    edge("analyze_opportunity", "opportunities"),
    edge("opportunities", "prioritize"),
    edge("prioritize", "approve_actions"),
    edge("approve_actions", "record"),
    edge("record", "publish_event"),
    edge("publish_event", "done"),
  ],
});

export const authorityWorkflows = [
  contentProductionWorkflowV2,
  contentRepurposingWorkflow,
  profileCorrectionWorkflow,
  competitorIntelligenceWorkflow,
  transactionToAuthorityWorkflow,
];
