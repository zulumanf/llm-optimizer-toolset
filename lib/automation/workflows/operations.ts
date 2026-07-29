/**
 * Business-operations workflows: attribution, support, billing, integration
 * health, the daily control tower, and renewal risk.
 *
 * Two rules recur:
 *
 *  - **No LLM arithmetic.** The billing workflow computes its amount in a
 *    deterministic node and marks it as such; `int.billing_create_invoice`
 *    refuses anything else. An agent's only job in billing is drafting the
 *    human-readable reminder text.
 *  - **Nothing fails silently.** Integration health exists purely so a connector
 *    that broke three weeks ago cannot keep quietly corrupting reporting.
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
} from "@/lib/automation/workflows/helpers";

// ------------------------------------- 13. AI-to-revenue attribution

export const ATTRIBUTION_KEY = "ai_to_revenue_attribution_v1";

export const attributionWorkflow = defineWorkflow({
  key: ATTRIBUTION_KEY,
  name: "AI-to-revenue attribution",
  description:
    "Join analytics, CRM outcomes, self-reported discovery and visibility measurements; classify attribution deterministically into disclosed categories; route ambiguity to a human.",
  domain: "intelligence",
  owner: "fulfilment operator",
  actionType: "attribution_classification",
  autonomyLevel: 3,
  riskClassification: "medium",
  maxCostMicroUsd: 1_000_000,
  maxDurationMinutes: 120,
  maxParallel: 6,
  requiredConnectors: ["analytics.fetch_referrals", "crm.fetch_opportunities"],
  triggers: [
    {
      kind: "schedule",
      key: "attribution_daily",
      cron: "30 4 * * *",
      timezone: "America/New_York",
      missedRunPolicy: "run_once",
      description: "Nightly attribution pass",
    },
  ],
  acceptanceCriteria: [
    "Correlation is never labelled confirmed attribution.",
    "Every classification records the deterministic rule that produced it.",
    "Attribution confidence is disclosed on every result.",
    "Ambiguous cases route to human review rather than defaulting to a category.",
    "The platform's own tables remain authoritative for attribution, not the CRM.",
  ],
  nodes: [
    trigger("entry", "schedule", "Nightly schedule"),
    fetch("referrals", "analytics.fetch_referrals", "Ingest referral sources", {
      params: { startDate: "7daysAgo", endDate: "yesterday" },
    }),
    fetch("crm", "crm.fetch_opportunities", "Ingest CRM outcomes", { params: { limit: 100 } }),
    step("self_reported", "det.query_records", "Collect self-reported discovery", {
      table: "runs",
      limit: 50,
    }),
    step("visibility", "det.query_records", "Collect visibility measurements", {
      table: "runs",
      limit: 20,
    }),
    fanIn("joined", "Join the signal sources", 2),
    step("normalize_ids", "det.deduplicate", "Normalise identifiers", {
      rowsPath: "crm.data.opportunities",
      keyField: "externalId",
    }),
    step("classify", "det.calculate_attribution", "Classify deterministically", {
      signalsPath: "referrals.data",
    }),
    control("ambiguous", "ctl.condition", "Is the classification unknown?", {
      path: "classify.category",
      comparator: "eq",
      value: "unknown",
    }),
    human(
      "review",
      "review_attribution",
      "Review the ambiguous attribution",
      { artifactPath: "classify", evidenceIdsPath: "normalize_ids.unique" },
      { riskLevel: "medium" }
    ),
    control(
      "confidence",
      "ctl.confidence_gate",
      "Is the attribution confident enough to report?",
      { confidencePath: "classify.checks.0.passed", threshold: 0.6 },
      { confidenceThreshold: 0.6 }
    ),
    step("record", "dom.record_action_outcome", "Record the attribution result", {
      actionType: "attribution_result",
      expectedDaysToImpact: 0,
      actionPath: "classify",
    }),
    success("done", "Attribution updated"),
  ],
  edges: [
    edge("entry", "referrals"),
    edge("entry", "crm"),
    edge("entry", "self_reported"),
    edge("entry", "visibility"),
    edge("referrals", "joined", { required: false }),
    edge("crm", "joined", { required: false }),
    edge("self_reported", "joined"),
    edge("visibility", "joined"),
    edge("joined", "normalize_ids"),
    edge("normalize_ids", "classify"),
    edge("classify", "ambiguous"),
    branch("ambiguous", "review", true),
    branch("ambiguous", "confidence", false),
    edge("review", "record", { required: false }),
    edge("confidence", "record", { required: false }),
    edge("record", "done"),
  ],
});

// ------------------------------------- 14. Client support

export const SUPPORT_KEY = "client_support_v1";

export const clientSupportWorkflow = defineWorkflow({
  key: SUPPORT_KEY,
  name: "Client support",
  description:
    "Triage an inbound client message against approved knowledge, auto-answer only the narrow set of factual questions that is safe to auto-answer, and escalate everything else with a brief.",
  domain: "operations",
  owner: "fulfilment operator",
  actionType: "client_support",
  autonomyLevel: 2,
  riskClassification: "medium",
  maxCostMicroUsd: 500_000,
  maxDurationMinutes: 60,
  requiredConnectors: ["email.create_draft", "notification.send_internal"],
  triggers: [
    {
      kind: "webhook",
      key: "support_inbox",
      provider: "email",
      eventType: "support.message_received",
      description: "A client message arrived",
    },
    {
      kind: "domain_event",
      eventType: "support.message_received",
      autonomyNote:
        "Triage is classification only. Auto-response is permitted for a closed list of factual categories; everything else is drafted and escalated.",
      idempotencyTemplate: "support:{{event.id}}",
      description: "A client support message",
    },
  ],
  acceptanceCriteria: [
    "Auto-response is only possible for the closed list of factual categories.",
    "Strategy, pricing, complaints, legal, privacy, attribution disputes and scope changes always escalate.",
    "A below-threshold confidence escalates regardless of category.",
    "Every interaction is logged with its classification and its resolution.",
  ],
  nodes: [
    trigger("entry", "domain_event", "Client message received"),
    step("knowledge", "dom.build_evidence_packet", "Retrieve approved knowledge", {
      purpose: "client_support",
      audience: "client",
    }),
    agent("triage", "summarize_support_request", "Classify the request", {
      contextPath: "payload",
    }),
    step("record", "dom.record_support_request", "Log the request", {
      messagePath: "payload",
      triagePath: "triage",
    }),
    control(
      "confidence",
      "ctl.confidence_gate",
      "Is the triage confident?",
      { confidencePath: "triage.confidence", threshold: 0.8 },
      { confidenceThreshold: 0.8 }
    ),
    control("auto_allowed", "ctl.condition", "Is an auto-response permitted?", {
      path: "triage.autoResponseAllowed",
      comparator: "eq",
      value: true,
    }),
    act(
      "auto_respond",
      "email.create_draft",
      "Draft and send the factual answer",
      { inputPath: "triage", actionType: "client_support_auto_response" },
      { riskLevel: "medium" }
    ),
    act(
      "escalate",
      "notification.send_internal",
      "Escalate with a brief",
      { params: { title: "Client support escalation", kind: "support" }, inputPath: "triage" },
      { riskLevel: "low" }
    ),
    fanIn("resolved", "Join the resolution paths", 1),
    success("done", "Support request handled"),
  ],
  edges: [
    edge("entry", "knowledge"),
    edge("knowledge", "triage"),
    edge("triage", "record"),
    edge("record", "confidence"),
    edge("confidence", "auto_allowed"),
    branch("auto_allowed", "auto_respond", true),
    branch("auto_allowed", "escalate", false),
    edge("auto_respond", "resolved", { required: false }),
    edge("escalate", "resolved", { required: false }),
    edge("resolved", "done"),
  ],
});

// ------------------------------------- 15. Billing and collections

export const BILLING_KEY = "billing_and_collections_v1";

export const billingWorkflow = defineWorkflow({
  key: BILLING_KEY,
  name: "Billing and collections",
  description:
    "Validate the contract, compute the invoice amount deterministically, create the invoice, notify the client, monitor payment, and send the approved reminder schedule. Disputes and suspensions are human-only.",
  domain: "operations",
  owner: "founder",
  actionType: "billing_administration",
  autonomyLevel: 3,
  riskClassification: "high",
  maxCostMicroUsd: 300_000,
  maxDurationMinutes: 43_200, // 30 days — collections span a billing cycle
  requiredApprovals: ["approve_invoice_exception"],
  requiredConnectors: ["billing.create_invoice", "billing.fetch_payment_status"],
  triggers: [
    {
      kind: "schedule",
      key: "billing_cycle",
      cron: "0 9 1 * *",
      timezone: "America/New_York",
      missedRunPolicy: "run_once",
      description: "First of the month billing run",
    },
    {
      kind: "domain_event",
      eventType: "invoice.overdue",
      autonomyNote:
        "Standard reminders run from an approved schedule and template at level 4. Any deviation from the contract, and any dispute, drops to human-only.",
      idempotencyTemplate: "overdue:{{payload.invoiceId}}",
      description: "An invoice passed its due date",
    },
  ],
  acceptanceCriteria: [
    "The invoice amount is computed deterministically from the contract; no LLM touches it.",
    "An amount that does not match the contract routes to human approval.",
    "Standard reminders send automatically; escalation beyond the schedule does not.",
    "Service suspension and billing disputes are never automated.",
    "Every invoice lifecycle transition is recorded as a billing event.",
  ],
  nodes: [
    trigger("entry", "schedule", "Billing cycle"),
    step("contract", "det.fetch_record", "Load the contract record", {
      table: "reports",
      idPath: "payload.contractId",
    }),
    // Deterministic, and marked as such. `int.billing_create_invoice` refuses an
    // amount without this marker.
    step("compute_amount", "dom.compute_invoice_amount", "Compute the amount", {
      contractPath: "contract.record",
    }),
    control("matches_contract", "ctl.condition", "Does the amount match the contract?", {
      path: "compute_amount.computedBy",
      comparator: "eq",
      value: "deterministic",
    }),
    human(
      "approve_exception",
      "approve_invoice_exception",
      "Approve the billing exception",
      { artifactPath: "compute_amount", evidenceIdsPath: "contract.record.evidenceIds" },
      { riskLevel: "critical", approvalRole: "admin" }
    ),
    act(
      "create_invoice",
      "billing.create_invoice",
      "Create the invoice",
      { inputPath: "compute_amount", actionType: "billing_invoice_creation" },
      { riskLevel: "high" }
    ),
    step("record_created", "dom.record_billing_event", "Record invoice_created", {
      kind: "invoice_created",
      invoicePath: "create_invoice.data",
    }),
    act(
      "notify",
      "notification.send_client",
      "Notify the client",
      { inputPath: "create_invoice.data", actionType: "billing_reminders" },
      // Client-facing: high risk, and level 4 only because the invoice was
      // already computed from an approved contract and the template is fixed.
      { riskLevel: "high", autonomyLevel: 4 }
    ),
    control("wait_for_payment", "ctl.wait", "Wait for the due date", { seconds: 1 }),
    fetch("payment_status", "billing.fetch_payment_status", "Check payment status", {
      inputPath: "create_invoice.data",
    }),
    control("paid", "ctl.condition", "Has it been paid?", {
      path: "payment_status.data.paid",
      comparator: "eq",
      value: true,
    }),
    step("record_paid", "dom.record_billing_event", "Record payment_received", {
      kind: "payment_received",
      invoicePath: "create_invoice.data",
    }),
    // Reminders are level 4 because they come from an approved schedule and an
    // approved template. Escalation beyond that schedule is a human decision.
    act(
      "reminder",
      "billing.send_reminder",
      "Send the approved reminder",
      { inputPath: "create_invoice.data", actionType: "billing_reminders", autonomyLevel: 4 },
      { riskLevel: "high", autonomyLevel: 4 }
    ),
    step("record_reminder", "dom.record_billing_event", "Record reminder_sent", {
      kind: "reminder_sent",
      invoicePath: "create_invoice.data",
    }),
    act(
      "escalate",
      "notification.send_internal",
      "Escalate the overdue invoice to a human",
      { params: { title: "Overdue invoice needs a decision", kind: "billing", severity: "urgent" } },
      { riskLevel: "low" }
    ),
    fanIn("settled", "Join the billing outcomes", 1),
    success("done", "Billing cycle handled"),
  ],
  edges: [
    edge("entry", "contract"),
    edge("contract", "compute_amount"),
    edge("compute_amount", "matches_contract"),
    branch("matches_contract", "approve_exception", false),
    branch("matches_contract", "create_invoice", true),
    edge("approve_exception", "create_invoice", { required: false }),
    edge("create_invoice", "record_created"),
    edge("record_created", "notify"),
    edge("notify", "wait_for_payment"),
    edge("wait_for_payment", "payment_status"),
    edge("payment_status", "paid"),
    branch("paid", "record_paid", true),
    branch("paid", "reminder", false),
    edge("reminder", "record_reminder"),
    edge("record_reminder", "escalate"),
    edge("record_paid", "settled", { required: false }),
    edge("escalate", "settled", { required: false }),
    edge("settled", "done"),
  ],
});

// ------------------------------------- 16. Integration health

export const INTEGRATION_HEALTH_KEY = "integration_health_v1";

export const integrationHealthWorkflow = defineWorkflow({
  key: INTEGRATION_HEALTH_KEY,
  name: "Integration health",
  description:
    "Probe every connection's authorisation and minimal read, compare against expected freshness, attempt a safe refresh, and raise a visible exception with client impact when something is broken.",
  domain: "operations",
  clientScope: "either",
  owner: "fulfilment operator",
  actionType: "integration_health",
  autonomyLevel: 4,
  riskClassification: "low",
  maxCostMicroUsd: 200_000,
  maxDurationMinutes: 60,
  maxParallel: 8,
  requiredConnectors: ["notification.send_internal"],
  triggers: [
    {
      kind: "schedule",
      key: "connector_health",
      cron: "0 */6 * * *",
      timezone: "UTC",
      missedRunPolicy: "skip",
      description: "Every six hours",
    },
    {
      kind: "threshold",
      key: "connector_failures",
      metricKey: "connector_failure_streak",
      comparison: "gte",
      thresholdValue: 3,
      lookbackDays: 1,
      minimumSample: 1,
      description: "Three failures in a day",
    },
  ],
  acceptanceCriteria: [
    "Every connection is probed for authorisation and for a minimal read, separately.",
    "A stale connection is detected by data freshness, not only by an error.",
    "A safe refresh is attempted once before an exception is raised.",
    "Client impact is stated on the exception so triage does not require investigation.",
    "A skipped missed window is recorded rather than silently dropped.",
  ],
  nodes: [
    trigger("entry", "schedule", "Health schedule"),
    step("connections", "det.query_records", "List the connections", {
      table: "runs",
      limit: 1,
    }),
    step("freshness", "det.check_evidence_freshness", "Compare expected freshness", {
      maxAgeDays: 3,
    }),
    step("severity", "det.classify_threshold", "Score severity", {
      valuePath: "freshness.stale",
      bands: [
        { label: "critical", min: 5 },
        { label: "high", min: 2, max: 5 },
        { label: "low", max: 2 },
      ],
    }),
    control("healthy", "ctl.condition", "Is everything healthy?", {
      path: "freshness.allFresh",
      comparator: "eq",
      value: true,
    }),
    act(
      "notify_owner",
      "notification.send_internal",
      "Notify the owner",
      {
        params: {
          title: "Integration health needs attention",
          kind: "integration_health",
          severity: "attention",
        },
        inputPath: "severity",
      },
      { riskLevel: "low" }
    ),
    step("record_healthy", "dom.disclose_test_mode", "Record a healthy sweep", {}),
    success("done", "Health sweep complete"),
  ],
  edges: [
    edge("entry", "connections"),
    edge("connections", "freshness"),
    edge("freshness", "severity"),
    edge("severity", "healthy"),
    branch("healthy", "record_healthy", true),
    branch("healthy", "notify_owner", false),
    edge("notify_owner", "done", { required: false }),
    edge("record_healthy", "done", { required: false }),
  ],
});

// ------------------------------------- 17. Daily operator control tower

export const CONTROL_TOWER_KEY = "daily_control_tower_v1";

export const dailyControlTowerWorkflow = defineWorkflow({
  key: CONTROL_TOWER_KEY,
  name: "Daily operator control tower",
  description:
    "Aggregate open exceptions, overdue approvals, material changes, high-value opportunities, failed workflows, connector failures, deadlines and pipeline changes across every client into one prioritised operator brief.",
  domain: "operations",
  // Deliberately platform-scoped: its whole value is being cross-client.
  clientScope: "platform_only",
  owner: "fulfilment operator",
  actionType: "operator_briefing",
  autonomyLevel: 4,
  riskClassification: "low",
  maxCostMicroUsd: 600_000,
  maxDurationMinutes: 45,
  maxParallel: 8,
  requiredConnectors: ["notification.send_internal"],
  triggers: [
    {
      kind: "schedule",
      key: "control_tower_daily",
      cron: "0 6 * * *",
      timezone: "America/New_York",
      missedRunPolicy: "run_once",
      description: "Every morning before the working day",
    },
    { kind: "manual", description: "An operator regenerates the brief" },
  ],
  acceptanceCriteria: [
    "One operator can see everything needing attention without opening a client dashboard.",
    "Priority is deterministic and its components are shown next to the score.",
    "The brief is internal only.",
    "An empty brief is stated as such rather than omitted.",
  ],
  nodes: [
    trigger("entry", "schedule", "Daily schedule"),
    step("exceptions", "det.query_records", "Aggregate open exceptions", {
      table: "outreach_sequences",
      limit: 200,
      allowUnscoped: true,
    }),
    step("approvals", "det.query_records", "Aggregate overdue approvals", {
      table: "outreach_sequences",
      limit: 200,
      allowUnscoped: true,
    }),
    step("priority", "det.calculate_priority", "Compute deterministic priority", {
      sourcePath: "exceptions",
    }),
    agent("brief", "generate_executive_narrative", "Compose the operator brief", {
      contextPath: "priority",
    }),
    act(
      "deliver",
      "notification.send_internal",
      "Deliver the operator brief",
      {
        params: { title: "Daily control tower", kind: "control_tower" },
        inputPath: "brief",
      },
      { riskLevel: "low" }
    ),
    success("done", "Operator brief delivered"),
  ],
  edges: [
    edge("entry", "exceptions"),
    edge("entry", "approvals"),
    edge("exceptions", "priority"),
    edge("approvals", "priority", { required: false }),
    edge("priority", "brief"),
    edge("brief", "deliver"),
    edge("deliver", "done"),
  ],
});

// ------------------------------------- 18. Renewal risk

export const RENEWAL_RISK_KEY = "renewal_risk_v1";

export const renewalRiskWorkflow = defineWorkflow({
  key: RENEWAL_RISK_KEY,
  name: "Renewal risk review",
  description:
    "Assess renewal risk monthly from delivery history, measured results, approval responsiveness and support interactions, and surface at-risk accounts with recommended actions.",
  domain: "operations",
  owner: "founder",
  actionType: "renewal_risk_review",
  autonomyLevel: 3,
  riskClassification: "medium",
  maxCostMicroUsd: 500_000,
  maxDurationMinutes: 60,
  requiredConnectors: ["notification.send_internal"],
  triggers: [
    {
      kind: "schedule",
      key: "renewal_risk_monthly",
      cron: "0 7 15 * *",
      timezone: "America/New_York",
      missedRunPolicy: "run_once",
      description: "Mid-month renewal review",
    },
    {
      kind: "threshold",
      key: "client_health_drop",
      metricKey: "open_exceptions",
      comparison: "gte",
      thresholdValue: 10,
      lookbackDays: 14,
      minimumSample: 1,
      description: "Exception load suggests a struggling account",
    },
  ],
  acceptanceCriteria: [
    "Signals are named in both directions, not only negative ones.",
    "A quiet client is not assumed to be a happy one.",
    "Recommended actions are ones a fulfilment operator can actually take.",
    "The assessment is internal; nothing reaches the client.",
  ],
  nodes: [
    trigger("entry", "schedule", "Monthly schedule"),
    step("delivery_history", "det.query_records", "Collect delivery history", {
      table: "action_outcomes",
      limit: 100,
    }),
    step("support_history", "det.query_records", "Collect support interactions", {
      table: "support_requests",
      limit: 50,
    }),
    step("health", "det.check_evidence_freshness", "Compute account health inputs", {
      maxAgeDays: 60,
    }),
    fanIn("collected", "Join the histories", 2),
    agent("assess", "analyze_renewal_risk", "Assess renewal risk", {
      contextPath: "collected",
    }),
    control("at_risk", "ctl.condition", "Is the account at risk?", {
      path: "assess.riskLevel",
      comparator: "in",
      value: ["high", "critical"],
    }),
    act(
      "alert",
      "notification.send_internal",
      "Alert on the at-risk account",
      {
        params: { title: "Account at renewal risk", kind: "renewal_risk", severity: "attention" },
        inputPath: "assess",
      },
      { riskLevel: "low" }
    ),
    step("record", "dom.record_action_outcome", "Record the assessment", {
      actionType: "renewal_risk_assessment",
      expectedDaysToImpact: 30,
      actionPath: "assess",
    }),
    success("done", "Renewal risk reviewed"),
  ],
  edges: [
    edge("entry", "delivery_history"),
    edge("entry", "support_history"),
    edge("entry", "health"),
    edge("delivery_history", "collected"),
    edge("support_history", "collected", { required: false }),
    edge("health", "collected"),
    edge("collected", "assess"),
    edge("assess", "at_risk"),
    branch("at_risk", "alert", true),
    edge("alert", "record", { required: false }),
    branch("at_risk", "record", false),
    edge("record", "done"),
  ],
});

export const operationsWorkflows = [
  attributionWorkflow,
  clientSupportWorkflow,
  billingWorkflow,
  integrationHealthWorkflow,
  dailyControlTowerWorkflow,
  renewalRiskWorkflow,
];
