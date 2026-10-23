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
  when,
} from "@/lib/automation/workflows/helpers";
import {
  PROFILE_CHECK_IDEMPOTENCY_TEMPLATE,
  PROFILE_CHECK_MAX_PROFILES_PER_PROJECT,
  PROFILE_CHECK_REQUESTED_EVENT,
  EXTERNAL_SUBMISSION_APPROVAL_NODE,
  PROFILE_CORRECTION_APPROVAL_NODE,
  PROFILE_CORRECTION_REQUEST_VERSION,
  PROFILE_CORRECTION_READY_EVENT,
  PROFILE_DRAFT_IDEMPOTENCY_TEMPLATE,
  PROFILE_DRAFT_PROVIDER,
  PROFILE_RECHECK_DUE_EVENT,
  PROFILE_RECHECK_IDEMPOTENCY_TEMPLATE,
  PROFILE_EXTERNAL_APPROVAL_EVENT,
  PROFILE_EXTERNAL_APPROVAL_TEMPLATE,
  SEND_CONFIRMATION_NODE,
} from "@/lib/profile-corrections/constants";

/** Every correction node reads the same validated upstream outputs. */
const CORRECTION_NODE_CONFIG = {
  requestVersion: PROFILE_CORRECTION_REQUEST_VERSION,
  fetchPath: "fetch_profile",
  extractPath: "canonical_extract",
  approvedFactsPath: "approved_facts",
  comparePath: "compare",
};

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
    // Release 151 consolidation: what reaches the CMS is never this
    // workflow's agent draft (an internal research artifact). It is the
    // approved, validator- and fact-verified lib/content asset, re-checked
    // by the same gate the connector boundary enforces.
    step("canonical_content", "dom.canonical_publish_input", "Use the approved, verified content asset", {
      mode: "draft",
      assetIdPath: "entry.payload.contentAssetId",
    }),
    act(
      "cms_draft",
      "cms.create_draft",
      "Create the CMS draft",
      { inputPath: "canonical_content" },
      { riskLevel: "medium" }
    ),
    step("publish_input", "dom.canonical_publish_input", "Bind the approved asset and approval to publication", {
      mode: "publish",
      assetIdPath: "entry.payload.contentAssetId",
      draftPath: "cms_draft",
    }),
    act(
      "publish",
      "cms.publish_approved_asset",
      "Publish the approved asset",
      { inputPath: "publish_input", actionType: "cms_public_publishing" },
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
    edge("client_approval", "canonical_content"),
    edge("canonical_content", "cms_draft"),
    edge("cms_draft", "publish_input"),
    edge("publish_input", "publish"),
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

/**
 * The frozen comparison path (Specs 145B–146), shared verbatim by the check
 * and the recheck so the two can never drift. A fresh copy per call: node
 * definitions are plain objects and must not be shared by reference.
 */
function frozenComparisonNodes() {
  return [
    // Canonical path (spec 145B): ingest the observed page as a source artifact,
    // then extract proposed claims from that artifact.
    step(
      "canonical_extract",
      "dom.extract_canonical_claims",
      "Extract the profile's claims (canonical)",
      { contextPath: "fetch_profile" }
    ),
    step("approved_facts", "dom.build_evidence_packet", "Load the approved facts", {
      purpose: "profile_correction",
      audience: "public",
    }),
    // Observed and approved stay separate so the comparison cannot mistake a
    // proposed claim for an approved fact.
    verify("compare", "detect_contradictions", "Compare against approved facts", {
      contextPaths: {
        observedClaims: "canonical_extract.claims",
        approvedFacts: "approved_facts",
      },
    }),
  ];
}

export const PROFILE_CORRECTION_KEY = "reputation_profile_correction_v1";

export const profileCorrectionWorkflow = defineWorkflow({
  key: PROFILE_CORRECTION_KEY,
  name: "Reputation and profile correction",
  description:
    "Check a client-confirmed public profile, compare its claims against the approved knowledge graph, build and verify a deterministic correction request, and record a human approval bound to that request. Destination routing, drafting and live rechecks follow in later Spec 147 slices.",
  domain: "reputation",
  owner: "fulfilment operator",
  actionType: "profile_correction",
  autonomyLevel: 2,
  riskClassification: "high",
  maxCostMicroUsd: 2_500_000,
  maxDurationMinutes: 10_080,
  maxParallel: 6,
  // Spec 147 §3.1: a per-project ceiling on PARKED runs only. Inference is
  // bounded globally by the profile-check dispatcher, not by this number.
  maxConcurrentRuns: PROFILE_CHECK_MAX_PROFILES_PER_PROJECT,
  requiredApprovals: ["approve_profile_correction"],
  // Spec 147 §4: the public fetch needs no connector, and nothing in this
  // slice drafts or sends.
  requiredConnectors: [],
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
    {
      kind: "domain_event",
      eventType: PROFILE_CHECK_REQUESTED_EVENT,
      autonomyNote:
        "Released by the bounded profile-check dispatcher for one client-confirmed URL. The run only reads a public page and records proposed claims and a comparison; nothing is drafted, sent or published.",
      idempotencyTemplate: PROFILE_CHECK_IDEMPOTENCY_TEMPLATE,
      description: "A client-confirmed profile URL was released for a check",
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
    // Only an event carries a profile URL (spec 145C). A scheduled scan has
    // none and stops here with the entry-kind mismatch.
    trigger("entry", "domain_event", "Profile check requested"),
    // Spec 147 §4: a public page is read through safeFetch, with no connector.
    // The URL comes only from the event payload and is never invented.
    step("fetch_profile", "dom.fetch_public_profile", "Fetch the public profile", {
      urlPath: "payload.profileUrl",
    }),
    ...frozenComparisonNodes(),
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
    // Spec 147 slice 2: the correction request is built and verified in code
    // from compare's validated pairs — no model drafts or judges it — then
    // waits for a human. Nothing leaves the platform in this workflow.
    step("build_correction", "dom.build_profile_correction", "Build the correction request", {
      ...CORRECTION_NODE_CONFIG,
    }),
    step("verify_correction", "dom.verify_profile_correction", "Verify and record the correction request", {
      ...CORRECTION_NODE_CONFIG,
      requestPath: "build_correction",
    }),
    human(
      PROFILE_CORRECTION_APPROVAL_NODE,
      "approve_profile_correction",
      "Approve the correction request",
      { artifactPath: "verify_correction", evidenceIdsPath: "verify_correction.request.evidenceIds" },
      { riskLevel: "high", approvalRole: "operator" }
    ),
    step(
      "record_approval",
      "dom.record_profile_correction_approval",
      "Bind the approval to the request and re-prove its facts",
      { ...CORRECTION_NODE_CONFIG, approvalNode: PROFILE_CORRECTION_APPROVAL_NODE }
    ),
    // Spec 147 slice 3: route the approved request by the profile's active,
    // operator-recorded destination. None → destination_required; a client
    // editor → ready_to_draft; a publisher → its own authorization workflow.
    step("route_correction", "dom.route_profile_correction", "Route the approved request", {
      requestVersion: PROFILE_CORRECTION_REQUEST_VERSION,
    }),
    success("done", "Profile checked; any correction approved and routed"),
  ],
  edges: [
    edge("entry", "fetch_profile"),
    edge("fetch_profile", "canonical_extract"),
    edge("canonical_extract", "approved_facts"),
    edge("approved_facts", "compare"),
    edge("compare", "has_error"),
    branch("has_error", "no_error", false),
    branch("has_error", "severity", true),
    edge("severity", "build_correction"),
    edge("build_correction", "verify_correction"),
    edge("verify_correction", PROFILE_CORRECTION_APPROVAL_NODE),
    edge(PROFILE_CORRECTION_APPROVAL_NODE, "record_approval"),
    edge("record_approval", "route_correction"),
    // Either branch ends the run; neither may wait for the other.
    edge("route_correction", "done", { required: false }),
    edge("no_error", "done", { required: false }),
  ],
});

// ---------------------- 10b. Profile correction: publisher authorization

export const PROFILE_CORRECTION_AUTHORIZE_KEY = "reputation_profile_correction_authorize_v1";

/**
 * Spec 147 slice 3: a correction routed to a PUBLISHER is a submission to a
 * third party on the client's behalf. It needs the external-submission
 * approval — bound to the request hash and the exact destination — before it
 * can be drafted. Started per (request, destination); nothing is sent here.
 */
export const profileCorrectionAuthorizeWorkflow = defineWorkflow({
  key: PROFILE_CORRECTION_AUTHORIZE_KEY,
  name: "Profile correction: publisher authorization",
  description:
    "Ask a human to authorize submitting an approved, hash-bound correction request to a specific publisher on the client's behalf, then mark it ready to draft.",
  domain: "reputation",
  owner: "fulfilment operator",
  actionType: "profile_correction",
  autonomyLevel: 2,
  riskClassification: "high",
  maxCostMicroUsd: 100_000,
  maxDurationMinutes: 10_080,
  maxParallel: 1,
  maxConcurrentRuns: PROFILE_CHECK_MAX_PROFILES_PER_PROJECT,
  requiredApprovals: ["approve_external_submission"],
  requiredConnectors: [],
  triggers: [
    {
      kind: "domain_event",
      eventType: PROFILE_EXTERNAL_APPROVAL_EVENT,
      autonomyNote:
        "Started when an approved correction is routed to a publisher. It only asks a human for the external-submission approval and records it; nothing is drafted, sent or submitted.",
      idempotencyTemplate: PROFILE_EXTERNAL_APPROVAL_TEMPLATE,
      description: "An approved correction was routed to a publisher destination",
    },
  ],
  acceptanceCriteria: [
    "Nothing is submitted to a third party without this approval.",
    "The approval binds to the request hash and the exact destination shown.",
    "A request re-routed since the approval was requested cannot use it.",
  ],
  nodes: [
    trigger("entry", "domain_event", "Routed to a publisher"),
    step("load_external", "dom.load_external_submission", "Load the request and its publisher", {
      requestVersion: PROFILE_CORRECTION_REQUEST_VERSION,
    }),
    human(
      EXTERNAL_SUBMISSION_APPROVAL_NODE,
      "approve_external_submission",
      "Authorize the submission to this publisher",
      { artifactPath: "load_external", evidenceIdsPath: "load_external.request.evidenceIds" },
      { riskLevel: "high", approvalRole: "operator" }
    ),
    step(
      "record_external_approval",
      "dom.record_external_submission_approval",
      "Bind the authorization and mark the request ready to draft",
      { requestVersion: PROFILE_CORRECTION_REQUEST_VERSION, approvalNode: EXTERNAL_SUBMISSION_APPROVAL_NODE }
    ),
    success("done", "Submission authorized; ready to draft"),
  ],
  edges: [
    edge("entry", "load_external"),
    edge("load_external", EXTERNAL_SUBMISSION_APPROVAL_NODE),
    edge(EXTERNAL_SUBMISSION_APPROVAL_NODE, "record_external_approval"),
    edge("record_external_approval", "done"),
  ],
});

// ----------------------------- 10c. Profile correction: Gmail draft + send

export const PROFILE_CORRECTION_DRAFT_KEY = "reputation_profile_correction_draft_v1";

/**
 * Spec 147 slice 4: one drafting attempt for a ready_to_draft correction.
 * The deterministic email becomes a Gmail DRAFT — never a send. The request
 * only becomes `sent` when a human confirms they sent exactly that draft;
 * that confirmation queues the 14-day recheck.
 */
export const profileCorrectionDraftWorkflow = defineWorkflow({
  key: PROFILE_CORRECTION_DRAFT_KEY,
  name: "Profile correction: Gmail draft and send confirmation",
  description:
    "Render the approved correction request as a deterministic email to its active destination, create it as a Gmail draft (never sent), and record the send only after a human confirms they sent that exact draft.",
  domain: "reputation",
  owner: "fulfilment operator",
  actionType: "profile_correction",
  autonomyLevel: 2,
  riskClassification: "high",
  maxCostMicroUsd: 100_000,
  maxDurationMinutes: 10_080,
  maxParallel: 1,
  maxConcurrentRuns: PROFILE_CHECK_MAX_PROFILES_PER_PROJECT,
  requiredApprovals: ["confirm_profile_correction_sent"],
  // The Gmail connection is checked by prepare_draft, which fails the attempt
  // with a reason instead of dead-lettering the start event.
  requiredConnectors: [],
  triggers: [
    {
      kind: "domain_event",
      eventType: PROFILE_CORRECTION_READY_EVENT,
      autonomyNote:
        "Started per drafting attempt for an approved, routed correction. It creates a Gmail draft only; nothing is sent, and the request is marked sent only after a human confirms the send.",
      idempotencyTemplate: PROFILE_DRAFT_IDEMPOTENCY_TEMPLATE,
      description: "A correction is ready for a Gmail draft attempt",
    },
  ],
  acceptanceCriteria: [
    "The email is exactly the deterministic rendering of the approved request for the active destination.",
    "A Gmail draft is created, never sent; there is no send capability in this workflow.",
    "A request becomes sent only on a human confirmation bound to the request hash, destination and draft.",
    "Exactly one recheck is queued per sent correction.",
  ],
  nodes: [
    trigger("entry", "domain_event", "Ready to draft"),
    step("prepare_draft", "dom.prepare_profile_correction_draft", "Check every precondition and render the email", {
      requestVersion: PROFILE_CORRECTION_REQUEST_VERSION,
    }),
    act(
      "submit",
      "email.create_draft",
      "Create the Gmail draft (never sent)",
      // Creating a draft sends nothing; the human gate below is the send.
      { inputPath: "prepare_draft", provider: PROFILE_DRAFT_PROVIDER, actionType: "content_drafting" },
      { riskLevel: "high" }
    ),
    step("record_draft", "dom.record_profile_correction_draft", "Record the Gmail draft", {
      requestVersion: PROFILE_CORRECTION_REQUEST_VERSION,
      submitPath: "submit",
    }),
    human(
      SEND_CONFIRMATION_NODE,
      "confirm_profile_correction_sent",
      "Confirm you sent this Gmail draft",
      { artifactPath: "record_draft", evidenceIdsPath: "record_draft.evidenceIds" },
      { riskLevel: "high", approvalRole: "operator" }
    ),
    step("record_sent", "dom.record_profile_correction_sent", "Record the send and queue the recheck", {
      requestVersion: PROFILE_CORRECTION_REQUEST_VERSION,
      approvalNode: SEND_CONFIRMATION_NODE,
    }),
    success("done", "Correction sent by a human; recheck queued"),
  ],
  edges: [
    edge("entry", "prepare_draft"),
    edge("prepare_draft", "submit"),
    edge("submit", "record_draft"),
    edge("record_draft", SEND_CONFIRMATION_NODE),
    edge(SEND_CONFIRMATION_NODE, "record_sent"),
    edge("record_sent", "done"),
  ],
});

// ------------------------------------- 10d. Profile correction: recheck

export const PROFILE_RECHECK_KEY = "reputation_profile_recheck_v1";

/**
 * Spec 147 slice 5: the 14-day recheck of a sent correction, released by the
 * same bounded dispatcher as checks. The same profile URL is fetched again; a
 * page byte-identical to the before page, or matching an older processed
 * version, is classified without any model call. Only a changed page runs the
 * frozen comparison path. The result is recorded; nothing is sent.
 */
export const profileRecheckWorkflow = defineWorkflow({
  key: PROFILE_RECHECK_KEY,
  name: "Profile correction: 14-day recheck",
  description:
    "Fetch a corrected profile again, compare it with the before-page evidence and, if it changed, run the frozen comparison; classify every correction item and record the result.",
  domain: "reputation",
  owner: "fulfilment operator",
  actionType: "profile_correction",
  autonomyLevel: 3,
  riskClassification: "medium",
  maxCostMicroUsd: 2_500_000,
  maxDurationMinutes: 1_440,
  maxParallel: 1,
  maxConcurrentRuns: PROFILE_CHECK_MAX_PROFILES_PER_PROJECT,
  requiredConnectors: [],
  triggers: [
    {
      kind: "domain_event",
      eventType: PROFILE_RECHECK_DUE_EVENT,
      autonomyNote:
        "Released by the bounded profile-check dispatcher when a sent correction's recheck falls due. It reads a public page and records a classification; nothing is drafted, sent or published.",
      idempotencyTemplate: PROFILE_RECHECK_IDEMPOTENCY_TEMPLATE,
      description: "A sent correction's recheck is due",
    },
  ],
  acceptanceCriteria: [
    "An unreachable page is never recorded as corrected.",
    "An unchanged page is still incorrect, with no model call.",
    "Corrected requires the page to restate the approved fact, not merely omit the error.",
    "Exactly one immutable result per sent correction.",
  ],
  nodes: [
    trigger("entry", "domain_event", "Recheck due"),
    step("load_request", "dom.load_profile_correction_recheck", "Load the sent correction", {
      requestVersion: PROFILE_CORRECTION_REQUEST_VERSION,
    }),
    step("fetch_profile", "dom.fetch_public_profile", "Fetch the same public profile", {
      urlPath: "load_request.profileUrl",
    }),
    step("precheck", "dom.precheck_profile_recheck", "Compare with the before-page evidence", {
      requestVersion: PROFILE_CORRECTION_REQUEST_VERSION,
      fetchPath: "fetch_profile",
      requestPath: "load_request",
    }),
    ...frozenComparisonNodes(),
    step("classify", "dom.classify_profile_recheck", "Classify and record the recheck", {
      requestVersion: PROFILE_CORRECTION_REQUEST_VERSION,
      requestPath: "load_request",
      precheckPath: "precheck",
      extractPath: "canonical_extract",
      approvedFactsPath: "approved_facts",
      comparePath: "compare",
    }),
    success("done", "Recheck recorded"),
  ],
  edges: [
    edge("entry", "load_request"),
    edge("load_request", "fetch_profile"),
    edge("fetch_profile", "precheck"),
    when("precheck", "canonical_extract", "proceedToCompare", true),
    when("precheck", "classify", "proceedToCompare", false),
    edge("canonical_extract", "approved_facts"),
    edge("approved_facts", "compare"),
    // Optional: on the fast paths the comparison never runs. `classify` waits
    // for it only when the page changed (computeReady: an optional edge never
    // blocks, and at least one incoming edge must be satisfied).
    edge("compare", "classify", { required: false }),
    edge("classify", "done"),
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
  profileCorrectionAuthorizeWorkflow,
  profileCorrectionDraftWorkflow,
  profileRecheckWorkflow,
  competitorIntelligenceWorkflow,
  transactionToAuthorityWorkflow,
];
