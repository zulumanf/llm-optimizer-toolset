/**
 * Revenue workflows: prospect audit & outreach, inbound lead qualification,
 * meeting preparation, meeting follow-up.
 *
 * The through-line: every outbound statement is evidence-linked or it is not
 * sent. `verify_claims` runs before the human sees the draft, so an approver is
 * reviewing a message that already passed verification rather than acting as the
 * verifier themselves.
 */
import {
  act,
  agent,
  branch,
  control,
  defineWorkflow,
  edge,
  fanIn,
  fetch,
  human,
  step,
  success,
  trigger,
  verify,
} from "@/lib/automation/workflows/helpers";

// ------------------------------------- 1. Prospect audit & outreach

export const PROSPECT_OUTREACH_KEY = "prospect_audit_outreach_v1";

export const prospectOutreachWorkflow = defineWorkflow({
  key: PROSPECT_OUTREACH_KEY,
  name: "Prospect audit and outreach",
  description:
    "Qualify a prospect, run a mini AI-visibility audit, build an evidence-backed opportunity thesis, and send an approved first message with every claim traceable.",
  domain: "revenue",
  // Prospects are not clients yet, so this runs at platform scope.
  clientScope: "platform_only",
  owner: "founder / sales",
  actionType: "prospect_outreach",
  autonomyLevel: 2,
  riskClassification: "high",
  maxCostMicroUsd: 3_000_000,
  maxDurationMinutes: 240,
  requiredApprovals: ["approve_outreach"],
  requiredConnectors: ["email.create_draft", "email.send_approved_message", "crm.create_contact"],
  evaluationSuite: "outreach-quality-v1",
  triggers: [
    {
      kind: "domain_event",
      eventType: "prospect.identified",
      autonomyNote:
        "Starting the audit unattended is safe: it only reads public data and produces a draft. Nothing leaves the building without the approval gate.",
      idempotencyTemplate: "prospect:{{payload.prospectId}}",
      description: "A prospect entered the pipeline",
    },
    { kind: "manual", description: "An operator audits a named prospect" },
  ],
  inputSchema: {
    "payload.prospectId": "string — the prospect's platform id",
    "payload.name": "string — decision maker's name",
    "payload.company": "string",
    "payload.website": "string",
    "payload.market": "string — the market they claim",
  },
  outputSchema: {
    qualificationScore: "0-100 with component scores and evidence",
    sequenceId: "the outreach sequence, when one was created",
    sent: "boolean — whether an approved message actually went out",
  },
  acceptanceCriteria: [
    "Every factual statement in the outreach maps to a stored evidence id.",
    "An unsupported claim blocks the send rather than being softened.",
    "A suppressed recipient stops the workflow before a draft exists.",
    "The first message always requires human approval, at any autonomy level.",
    "Reply, opt-out, bounce and booking each stop the sequence permanently.",
    "The qualification score records its components, weights and evidence.",
  ],
  nodes: [
    trigger("entry", "domain_event", "Prospect identified"),
    step("normalize", "det.normalize_entity", "Normalise the prospect record", {
      sourcePath: "payload",
    }),
    // Suppression is checked before anything is drafted: producing a message we
    // may not send is a trap for a later change.
    step("suppression_check", "dom.check_suppression", "Check the suppression list", {
      emailPath: "payload.email",
    }),
    control("suppressed", "ctl.condition", "Is the recipient suppressed?", {
      path: "suppression_check.suppressed",
      comparator: "eq",
      value: true,
    }),
    step("stop_suppressed", "ctl.safe_stop", "Stop — recipient is suppressed", {
      reason: "the prospect is on the suppression list; no outreach may be prepared",
    }),

    step("qualify", "det.calculate_priority", "Score qualification deterministically", {
      sourcePath: "normalize.normalized",
    }),
    // The mini audit reuses the platform's own measurement path rather than
    // inventing a second one.
    step("mini_audit", "det.query_records", "Collect the mini-audit observations", {
      table: "runs",
      limit: 5,
      allowUnscoped: true,
    }),
    // A prospect has no approved knowledge graph, so this assembles what we
    // actually observed rather than reading client claims that do not exist.
    step(
      "evidence_packet",
      "dom.build_prospect_evidence",
      "Assemble the prospect evidence",
      { observationsPath: "mini_audit.records", profilePath: "payload" },
      { requiredEvidence: ["public_page"] }
    ),
    control("evidence_gate", "ctl.evidence_gate", "Is the evidence sufficient?", {
      packetPath: "evidence_packet",
      minimumSampleSize: 1,
    }),

    agent("thesis", "diagnose_visibility_gap", "Generate the opportunity thesis", {
      contextPath: "evidence_packet",
    }),
    agent("draft", "draft_outreach", "Draft the first message", {
      contextPath: "thesis",
    }),
    verify("verify_claims", "verify_claims", "Verify every claim in the draft", {
      contextPath: "draft",
    }),
    control("claims_ok", "ctl.condition", "Are all claims supported?", {
      path: "verify_claims.allSupported",
      comparator: "eq",
      value: true,
    }),
    step("stop_unsupported", "ctl.safe_stop", "Stop — claims are unsupported", {
      reason:
        "the draft contains statements the evidence does not support; it will not be softened and sent",
    }),

    // The raw payload rather than the normalised record, because the sequence
    // needs the prospect's platform id for its subject reference — the
    // normaliser only produces contact fields.
    step("start_sequence", "dom.start_outreach_sequence", "Open the outreach sequence", {
      subjectPath: "payload",
      // Stated explicitly: every later lookup joins on this reference.
      subjectRefPath: "payload.prospectId",
      subjectKind: "prospect",
      maxSteps: 4,
    }),
    step("store_draft", "dom.draft_outreach_message", "Store the draft as step 1", {
      sequenceIdPath: "start_sequence.sequenceId",
      draftPath: "draft",
      step: 1,
    }),
    control("rate_limit", "ctl.rate_limit", "Respect the send rate limit", {
      scope: "outreach_sends",
      maxPerWindow: 40,
      windowHours: 24,
    }),

    human(
      "approve",
      "approve_outreach",
      "Approve the first message",
      {
        artifactPath: "store_draft",
        // The claim list, not an id list: prospect evidence is public sources
        // we cited rather than artifacts we stored, so the claims (each with its
        // source) are what the approver actually checks.
        evidenceIdsPath: "store_draft.claims",
      },
      { riskLevel: "high", approvalRole: "operator" }
    ),
    act("create_draft", "email.create_draft", "Create the provider draft", {
      inputPath: "store_draft",
    }),
    act(
      "send",
      "email.send_approved_message",
      "Send the approved message",
      { inputPath: "store_draft", actionType: "prospect_first_outreach" },
      { riskLevel: "critical" }
    ),
    step("record_sent", "dom.record_outreach_sent", "Record the send and schedule follow-up", {
      messageIdPath: "store_draft.messageId",
      sendResultPath: "send",
      followUpDays: 4,
    }),
    act(
      "crm_contact",
      "crm.create_contact",
      "Create the CRM contact",
      { inputPath: "normalize.normalized" },
      { riskLevel: "medium", failureStrategy: "continue" }
    ),
    fanIn("join", "Join send and CRM", 1),
    success("done", "Outreach sent and tracked"),
  ],
  edges: [
    edge("entry", "normalize"),
    edge("normalize", "suppression_check"),
    edge("suppression_check", "suppressed"),
    branch("suppressed", "stop_suppressed", true),
    branch("suppressed", "qualify", false),

    edge("qualify", "mini_audit"),
    edge("mini_audit", "evidence_packet"),
    edge("evidence_packet", "evidence_gate"),
    edge("evidence_gate", "thesis"),
    edge("thesis", "draft"),
    edge("draft", "verify_claims"),
    edge("verify_claims", "claims_ok"),
    branch("claims_ok", "stop_unsupported", false),
    branch("claims_ok", "start_sequence", true),

    edge("start_sequence", "store_draft"),
    edge("store_draft", "rate_limit"),
    edge("rate_limit", "approve"),
    edge("approve", "create_draft"),
    edge("create_draft", "send"),
    edge("send", "record_sent"),
    edge("record_sent", "crm_contact"),
    edge("record_sent", "join"),
    edge("crm_contact", "join", { required: false }),
    edge("join", "done"),
  ],
});

// ------------------------------------- 1b. Audit refresh preparation (spec 075)

export const AUDIT_REFRESH_KEY = "audit_refresh_v1";

/**
 * The weekly baseline's consumer: when a SCHEDULED run finishes on a
 * prospect-kind project, prepare one refresh candidate per published audit
 * fed by that project — new run linked, findings generated, delta computed,
 * preflight pre-run. Level-2 by construction: this workflow contains no act
 * or human node because the approval lives in the refresh queue UI
 * (`approveAuditRefresh`), where the operator's click publishes through the
 * unchanged publishAudit gates. Nothing prospect-visible changes here.
 */
export const auditRefreshWorkflow = defineWorkflow({
  key: AUDIT_REFRESH_KEY,
  name: "Audit refresh preparation",
  description:
    "After each scheduled prospect-market benchmark run, prepare a refreshed audit candidate per published audit — linked run, generated findings, week-over-week delta, dry-run preflight — for one-click human approval in the refresh queue.",
  domain: "revenue",
  clientScope: "platform_only",
  owner: "founder / sales",
  actionType: "audit_refresh_preparation",
  autonomyLevel: 2,
  riskClassification: "high",
  maxCostMicroUsd: 200_000,
  maxDurationMinutes: 30,
  triggers: [
    {
      kind: "domain_event",
      eventType: "benchmark.completed",
      autonomyNote:
        "Preparation is internal and reversible: candidates are queue rows, not publications. Nothing a prospect can see changes without approveAuditRefresh — a named staff click through the full publishAudit gates.",
      idempotencyTemplate: "audit-refresh:{{payload.runId}}",
      description: "A benchmark run finished completely",
    },
    {
      kind: "domain_event",
      eventType: "benchmark.partially_failed",
      autonomyNote:
        "A partial run still prepares candidates; the coverage hole is carried as a stored preflight warning the operator sees before approving.",
      idempotencyTemplate: "audit-refresh:{{payload.runId}}",
      description: "A benchmark run finished with failures",
    },
    { kind: "manual", description: "An operator backfills candidates for a named run" },
  ],
  inputSchema: {
    "payload.runId": "string — the finished benchmark run's id",
  },
  outputSchema: {
    prepared: "number — candidates ready for one-click approval",
    needsAttention: "number — candidates whose preparation hit a problem",
    skipped: "array — prospects skipped, each with its reason",
  },
  acceptanceCriteria: [
    "Only published, unrevoked, unpromoted prospects' audits get candidates.",
    "A preparation failure yields a needs_attention card, never a silent skip.",
    "Manual runs and non-prospect projects safe-stop instead of preparing.",
    "Re-delivery of the same run event prepares nothing twice.",
    "No node in this workflow publishes, sends, or changes anything a prospect can see.",
  ],
  nodes: [
    trigger("entry", "domain_event", "Scheduled benchmark run finished"),
    step("prepare", "dom.prepare_audit_refresh", "Prepare refresh candidates", {
      runIdPath: "payload.runId",
    }),
    success("done", "Candidates prepared for the refresh queue"),
  ],
  edges: [edge("entry", "prepare"), edge("prepare", "done")],
});

// ------------------------------------- 2. Inbound lead qualification

export const INBOUND_LEAD_KEY = "inbound_lead_qualification_v1";

export const inboundLeadWorkflow = defineWorkflow({
  key: INBOUND_LEAD_KEY,
  name: "Inbound lead qualification",
  description:
    "Validate, deduplicate and qualify an inbound lead, then create or update CRM records and route the response by score and risk.",
  domain: "revenue",
  clientScope: "platform_only",
  owner: "founder / sales",
  actionType: "lead_qualification",
  autonomyLevel: 3,
  riskClassification: "medium",
  maxCostMicroUsd: 500_000,
  maxDurationMinutes: 30,
  requiredConnectors: ["crm.create_contact", "email.create_draft"],
  evaluationSuite: "lead-qualification-v1",
  triggers: [
    {
      kind: "webhook",
      key: "lead_form",
      provider: "form",
      eventType: "lead.created",
      description: "A lead form was submitted",
    },
    {
      kind: "domain_event",
      eventType: "lead.created",
      autonomyNote:
        "Qualification reads and classifies only. The response is drafted, and whether it sends is decided by the confidence gate and the autonomy policy.",
      idempotencyTemplate: "lead:{{payload.leadId}}",
      description: "A lead arrived from any channel",
    },
  ],
  acceptanceCriteria: [
    "A duplicate submission does not create a second lead or a second CRM contact.",
    "Deterministic inputs are computed before the agent classifies.",
    "A below-threshold confidence routes to human review instead of auto-responding.",
    "No protected or sensitive personal characteristic is inferred or stored.",
    "A qualified lead produces a CRM opportunity; an unqualified one does not.",
  ],
  nodes: [
    trigger("entry", "domain_event", "Lead received"),
    step("normalize", "det.normalize_entity", "Validate and normalise the fields", {
      sourcePath: "payload",
    }),
    step("dedupe_check", "det.query_records", "Check for an existing lead", {
      table: "companies",
      limit: 50,
      allowUnscoped: true,
    }),
    step("suppression_check", "dom.check_suppression", "Check the suppression list", {
      emailPath: "payload.email",
    }),
    fetch("enrich", "crm.fetch_contacts", "Enrich from the CRM", {
      params: { limit: 10 },
    }),
    step("deterministic_score", "det.calculate_priority", "Compute the deterministic inputs", {
      sourcePath: "normalize.normalized",
    }),
    agent("classify", "classify_lead", "Classify the lead semantically", {
      contextPath: "normalize",
    }),
    control(
      "confidence",
      "ctl.confidence_gate",
      "Is the classification confident enough?",
      { confidencePath: "classify.confidence", threshold: 0.7 },
      { confidenceThreshold: 0.7 }
    ),
    control("qualified", "ctl.condition", "Is the lead qualified?", {
      path: "classify.qualificationScore",
      comparator: "gte",
      value: 60,
    }),
    act(
      "crm_contact",
      "crm.create_contact",
      "Create or update the CRM contact",
      { inputPath: "normalize.normalized" },
      { riskLevel: "medium", failureStrategy: "continue" }
    ),
    step("publish_qualified", "dom.publish_event", "Publish lead.qualified", {
      eventType: "lead.qualified",
      payloadPath: "classify",
    }),
    act(
      "draft_response",
      "email.create_draft",
      "Draft the response",
      { inputPath: "classify" },
      { riskLevel: "medium" }
    ),
    act(
      "notify_sales",
      "notification.send_internal",
      "Alert sales",
      { params: { title: "New qualified lead", kind: "lead" } },
      { riskLevel: "low", failureStrategy: "continue" }
    ),
    fanIn("join", "Join the qualification outputs", 1),
    success("done", "Lead qualified and routed"),
  ],
  edges: [
    edge("entry", "normalize"),
    edge("normalize", "dedupe_check"),
    edge("normalize", "suppression_check"),
    edge("dedupe_check", "enrich"),
    edge("suppression_check", "enrich", { required: false }),
    edge("enrich", "deterministic_score"),
    edge("deterministic_score", "classify"),
    edge("classify", "confidence"),
    edge("confidence", "qualified"),
    branch("qualified", "crm_contact", true),
    edge("crm_contact", "publish_qualified"),
    edge("publish_qualified", "draft_response"),
    edge("draft_response", "notify_sales"),
    edge("notify_sales", "join", { required: false }),
    edge("draft_response", "join"),
    branch("qualified", "join", false),
    edge("join", "done"),
  ],
});

// ------------------------------------- 3. Meeting preparation

export const MEETING_PREP_KEY = "meeting_preparation_v1";

export const meetingPrepWorkflow = defineWorkflow({
  key: MEETING_PREP_KEY,
  name: "Meeting preparation",
  description:
    "Detect upcoming meetings, assemble a client brief from relationship history, performance, open approvals and risks, and send it to the meeting owner.",
  domain: "revenue",
  owner: "fulfilment operator",
  actionType: "meeting_preparation",
  autonomyLevel: 3,
  riskClassification: "low",
  maxCostMicroUsd: 400_000,
  maxDurationMinutes: 30,
  requiredConnectors: ["calendar.fetch_events", "notification.send_internal"],
  triggers: [
    {
      kind: "schedule",
      key: "meeting_prep_daily",
      cron: "0 6 * * 1-5",
      timezone: "America/New_York",
      missedRunPolicy: "run_once",
      description: "Every weekday morning, ahead of the day's meetings",
    },
  ],
  acceptanceCriteria: [
    "A brief states which sources it used and which were unavailable.",
    "A missing email connection produces a thinner brief that says so, not a failure.",
    "The brief is delivered internally only; nothing reaches the client.",
    "Re-running for the same calendar event updates the brief rather than duplicating it.",
  ],
  nodes: [
    trigger("entry", "schedule", "Daily meeting scan"),
    fetch("calendar", "calendar.fetch_events", "Fetch upcoming events", {
      params: { limit: 25 },
    }),
    step("open_approvals", "det.query_records", "Collect open approvals", {
      table: "outreach_sequences",
      limit: 50,
    }),
    step("performance", "det.query_records", "Collect current performance", {
      table: "runs",
      limit: 5,
    }),
    step("evidence", "dom.build_evidence_packet", "Assemble approved client facts", {
      purpose: "meeting_brief",
      audience: "internal",
    }),
    agent("compose", "generate_executive_narrative", "Compose the meeting brief", {
      contextPath: "evidence",
    }),
    step("record", "dom.record_meeting_brief", "Record the brief", {
      briefPath: "compose",
      meetingPath: "calendar.data",
      sourcesUsed: ["calendar", "platform_performance", "approved_claims"],
      sourcesMissing: [],
    }),
    act(
      "deliver",
      "notification.send_internal",
      "Send the brief to the meeting owner",
      { params: { title: "Meeting brief", kind: "meeting_brief" } },
      { riskLevel: "low" }
    ),
    success("done", "Briefs delivered"),
  ],
  edges: [
    edge("entry", "calendar"),
    edge("calendar", "open_approvals"),
    edge("calendar", "performance"),
    edge("open_approvals", "evidence"),
    edge("performance", "evidence", { required: false }),
    edge("evidence", "compose"),
    edge("compose", "record"),
    edge("record", "deliver"),
    edge("deliver", "done"),
  ],
});

// ------------------------------------- 4. Meeting follow-up

export const MEETING_FOLLOWUP_KEY = "meeting_followup_v1";

export const meetingFollowupWorkflow = defineWorkflow({
  key: MEETING_FOLLOWUP_KEY,
  name: "Meeting follow-up",
  description:
    "Turn meeting notes into tracked decisions, action items and owners, then draft a follow-up that a human approves before it is sent.",
  domain: "revenue",
  owner: "fulfilment operator",
  actionType: "meeting_followup",
  autonomyLevel: 2,
  riskClassification: "medium",
  maxCostMicroUsd: 500_000,
  maxDurationMinutes: 60,
  requiredApprovals: ["approve_outreach"],
  requiredConnectors: ["email.create_draft", "email.send_approved_message"],
  triggers: [
    {
      kind: "domain_event",
      eventType: "meeting.completed",
      autonomyNote:
        "Extraction and task creation are internal and reversible. The outbound summary is approval-gated, and sensitive content blocks the auto-path entirely.",
      idempotencyTemplate: "meeting:{{payload.externalEventId}}",
      description: "A meeting finished and has notes",
    },
  ],
  acceptanceCriteria: [
    "Decisions, action items, owners and due dates are stored as tracked rows.",
    "An action item with no named owner is flagged for assignment, never assigned by guesswork.",
    "Notes containing sensitive or ambiguous content never auto-send.",
    "The follow-up email requires approval before sending.",
  ],
  nodes: [
    trigger("entry", "domain_event", "Meeting completed"),
    agent("summarize", "summarize_meeting", "Extract decisions and actions", {
      contextPath: "payload",
    }),
    step("record_decisions", "dom.record_meeting_decisions", "Record decisions and actions", {
      summaryPath: "summarize",
      workflowKey: MEETING_FOLLOWUP_KEY,
      evidenceSource: "meeting notes",
    }),
    control("sensitive", "ctl.condition", "Does it contain sensitive content?", {
      path: "summarize.containsSensitiveContent",
      comparator: "eq",
      value: true,
    }),
    // Sensitive content does not merely require approval — it leaves the
    // automated path entirely and becomes a human task.
    human(
      "human_handles",
      "choose_strategy",
      "Sensitive content — a human writes this follow-up",
      { artifactPath: "summarize", evidenceIdsPath: "summarize.decisions" },
      { riskLevel: "high", approvalRole: "admin" }
    ),
    agent("draft", "draft_meeting_followup", "Draft the follow-up", {
      contextPath: "summarize",
    }),
    control(
      "needs_review",
      "ctl.confidence_gate",
      "Is the draft confident enough to proceed?",
      { confidencePath: "draft.confidence", threshold: 0.75 },
      { confidenceThreshold: 0.75 }
    ),
    human(
      "approve",
      "approve_outreach",
      "Approve the follow-up",
      { artifactPath: "draft", evidenceIdsPath: "record_decisions.needsOwnerAssignment" },
      { riskLevel: "medium" }
    ),
    act("send", "email.send_approved_message", "Send the follow-up", {
      inputPath: "draft",
      actionType: "meeting_followup_send",
    }),
    success("done", "Follow-up sent and work tracked"),
  ],
  edges: [
    edge("entry", "summarize"),
    edge("summarize", "record_decisions"),
    edge("record_decisions", "sensitive"),
    branch("sensitive", "human_handles", true),
    branch("sensitive", "draft", false),
    edge("draft", "needs_review"),
    edge("needs_review", "approve"),
    edge("approve", "send"),
    edge("send", "done", { required: false }),
    edge("human_handles", "done", { required: false }),
  ],
});

export const revenueWorkflows = [
  prospectOutreachWorkflow,
  auditRefreshWorkflow,
  inboundLeadWorkflow,
  meetingPrepWorkflow,
  meetingFollowupWorkflow,
];
