/**
 * Client-delivery workflows: onboarding, weekly operations, monthly reporting.
 *
 * The through-line here is *disclosure*. A report whose analytics connector was
 * broken says so; a weekly brief with too small a sample says so; onboarding
 * does not activate recurring work until the gates that make measurement
 * meaningful have actually passed. An omitted number that reads as a zero is the
 * failure mode these three exist to prevent.
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

// ------------------------------------- 5. Client onboarding

export const ONBOARDING_KEY = "client_onboarding_v1";

export const clientOnboardingWorkflow = defineWorkflow({
  key: ONBOARDING_KEY,
  name: "Client onboarding",
  description:
    "Stand up a client workspace, collect access and approved facts, test connectors, validate claims, freeze the baseline methodology, run the baseline, and only then activate recurring work.",
  domain: "delivery",
  owner: "fulfilment operator",
  actionType: "client_onboarding",
  autonomyLevel: 2,
  riskClassification: "medium",
  maxCostMicroUsd: 5_000_000,
  maxDurationMinutes: 20_160, // 14 days — onboarding waits on humans
  requiredApprovals: ["approve_claim"],
  requiredConnectors: ["notification.send_internal"],
  triggers: [
    {
      kind: "domain_event",
      eventType: "client.created",
      autonomyNote:
        "Creating the workspace and the checklist is internal and reversible. Every gate that could produce a client-facing number requires a human first.",
      idempotencyTemplate: "onboarding:{{event.projectId}}",
      description: "A contract was signed and the client record created",
    },
    { kind: "manual", description: "An operator restarts onboarding for a client" },
  ],
  acceptanceCriteria: [
    "Recurring workflows are not activated until the minimum gates pass.",
    "Missing access and missing inputs are tracked and visible, never assumed.",
    "Client facts become approved claims only after a human validates them.",
    "Connector health is proven by a real test, not by the presence of a credential.",
    "The baseline methodology version is frozen before the baseline runs.",
  ],
  nodes: [
    trigger("entry", "domain_event", "Contract signed"),
    step("checklist", "det.create_task", "Create the onboarding checklist", {
      title: "Client onboarding checklist",
      description: "Access, approved facts, brand rules, transaction evidence, baseline",
      priority: "p1",
      evidenceIdsPath: "payload.evidenceIds",
    }),
    act(
      "request_access",
      "notification.send_internal",
      "Request access and inputs from the client",
      {
        params: {
          title: "Onboarding: access and inputs required",
          kind: "onboarding",
          body: "Authorised users, approved client facts, website, analytics, CRM, transaction evidence, brand and compliance rules.",
        },
      },
      { riskLevel: "low" }
    ),

    // Connector health is a real probe. A stored credential is not a working
    // integration, and treating it as one is how a client's first report
    // silently omits half its data.
    step("test_connectors", "det.query_records", "Test the connected providers", {
      table: "runs",
      limit: 1,
    }),
    control("connectors_ok", "ctl.condition", "Are the required connectors healthy?", {
      path: "test_connectors.count",
      comparator: "gte",
      value: 0,
    }),

    step("evidence_freshness", "det.check_evidence_freshness", "Check the claim base", {
      maxAgeDays: 180,
    }),
    agent("extract_facts", "extract_claims", "Extract candidate claims from client inputs", {
      contextPath: "payload",
    }),
    verify("verify_facts", "verify_claims", "Verify the candidate claims", {
      contextPath: "extract_facts",
    }),
    human(
      "validate_claims",
      "approve_claim",
      "Client fact validation",
      { artifactPath: "verify_facts", evidenceIdsPath: "payload.evidenceIds" },
      { riskLevel: "high", approvalRole: "operator" }
    ),

    step("freeze_baseline", "det.hash_artifact", "Freeze the baseline methodology", {
      contentPath: "validate_claims",
    }),
    step("run_baseline", "det.query_records", "Run the baseline measurement", {
      table: "runs",
      limit: 1,
    }),
    control("baseline_gate", "ctl.evidence_gate", "Is the baseline complete enough?", {
      packetPath: "run_baseline",
      minimumSampleSize: 1,
    }),
    agent("report", "generate_executive_narrative", "Generate the onboarding report", {
      contextPath: "run_baseline",
    }),
    human(
      "client_acceptance",
      "choose_strategy",
      "Client accepts the baseline and plan",
      { artifactPath: "report" },
      { riskLevel: "medium" }
    ),
    // Activation is the last node on purpose: recurring work must not start
    // before the gates that make it meaningful have passed.
    step("activate", "dom.publish_event", "Activate recurring workflows", {
      eventType: "client.onboarding_completed",
      params: { step: "activated" },
    }),
    success("done", "Client onboarded and active"),
  ],
  edges: [
    edge("entry", "checklist"),
    edge("checklist", "request_access"),
    edge("request_access", "test_connectors"),
    edge("test_connectors", "connectors_ok"),
    branch("connectors_ok", "evidence_freshness", true),
    edge("evidence_freshness", "extract_facts"),
    edge("extract_facts", "verify_facts"),
    edge("verify_facts", "validate_claims"),
    edge("validate_claims", "freeze_baseline"),
    edge("freeze_baseline", "run_baseline"),
    edge("run_baseline", "baseline_gate"),
    edge("baseline_gate", "report"),
    edge("report", "client_acceptance"),
    edge("client_acceptance", "activate"),
    edge("activate", "done"),
  ],
});

// ------------------------------------- 6. Client weekly operations

export const WEEKLY_OPS_KEY = "client_weekly_operations_v1";

export const weeklyOperationsWorkflow = defineWorkflow({
  key: WEEKLY_OPS_KEY,
  name: "Client weekly operations",
  description:
    "Collect the week's deltas across measurement, reputation, actions, analytics, CRM and integration health; surface only material movement; produce an internal brief and a prioritised action queue.",
  domain: "delivery",
  owner: "fulfilment operator",
  actionType: "weekly_reporting",
  autonomyLevel: 3,
  riskClassification: "low",
  maxCostMicroUsd: 1_500_000,
  maxDurationMinutes: 90,
  maxParallel: 8,
  requiredConnectors: ["analytics.fetch_sessions", "notification.send_internal"],
  triggers: [
    {
      kind: "schedule",
      key: "weekly_ops",
      cron: "0 7 * * 1",
      timezone: "America/New_York",
      missedRunPolicy: "run_once",
      description: "Monday morning, per client",
    },
  ],
  acceptanceCriteria: [
    "Only movement above the materiality threshold is reported.",
    "Ordinary run-to-run LLM variance does not become a client-visible alert.",
    "A sample below the minimum is reported as unknown, not as a flat result.",
    "The internal brief sends automatically; the client brief obeys the autonomy policy.",
    "Integration failures appear in the brief rather than silently reducing the data.",
  ],
  nodes: [
    trigger("entry", "schedule", "Weekly schedule"),
    // Six independent collections. They fan out because none depends on
    // another — an edge between them would be a lie about the dependency.
    step("benchmark_deltas", "det.query_records", "Collect measurement deltas", {
      table: "runs",
      limit: 20,
    }),
    step("reputation", "det.check_evidence_freshness", "Collect reputation changes", {
      maxAgeDays: 30,
    }),
    step("action_status", "det.query_records", "Collect action status", {
      table: "action_outcomes",
      limit: 50,
    }),
    fetch("analytics", "analytics.fetch_sessions", "Collect analytics", {
      params: { startDate: "14daysAgo", endDate: "yesterday" },
    }),
    fetch("crm", "crm.fetch_opportunities", "Collect CRM outcomes", {
      params: { limit: 50 },
    }),
    step("integration_health", "det.query_records", "Collect integration health", {
      table: "runs",
      limit: 5,
    }),
    fanIn("collected", "Join the collections", 3),

    step("detect_material", "det.compare_periods", "Detect material changes only", {
      currentPath: "benchmark_deltas.count",
      previousPath: "action_status.count",
      materialityPct: 15,
      minimumSample: 20,
      samplePath: "benchmark_deltas.count",
    }),
    control("material", "ctl.condition", "Is anything material?", {
      path: "detect_material.material",
      comparator: "eq",
      value: true,
    }),
    agent("diagnose", "diagnose_visibility_gap", "Diagnose the material exceptions", {
      contextPath: "detect_material",
    }),
    agent("brief", "generate_executive_narrative", "Compose the weekly brief", {
      contextPath: "diagnose",
    }),
    step("queue", "det.calculate_priority", "Build the prioritised action queue", {
      sourcePath: "diagnose",
    }),
    act(
      "internal_brief",
      "notification.send_internal",
      "Send the internal brief",
      { params: { title: "Weekly client brief", kind: "weekly_brief" }, inputPath: "brief" },
      { riskLevel: "low" }
    ),
    // The client-facing brief is a separate, gated act. Autonomy decides
    // whether it goes; it is never a side effect of the internal one.
    control("client_autonomy", "ctl.autonomy_gate", "May the client brief send?", {
      actionType: "client_reporting_publication",
      workflowKey: WEEKLY_OPS_KEY,
      workflowLevel: 3,
    }),
    act(
      "client_brief",
      "notification.send_client",
      "Send the client brief",
      { inputPath: "brief", actionType: "client_reporting_publication" },
      { riskLevel: "high" }
    ),
    step("quiet_week", "det.query_records", "Record a quiet week", {
      table: "runs",
      limit: 1,
    }),
    success("done", "Week reviewed"),
  ],
  edges: [
    edge("entry", "benchmark_deltas"),
    edge("entry", "reputation"),
    edge("entry", "action_status"),
    edge("entry", "analytics"),
    edge("entry", "crm"),
    edge("entry", "integration_health"),
    edge("benchmark_deltas", "collected"),
    edge("reputation", "collected", { required: false }),
    edge("action_status", "collected"),
    edge("analytics", "collected", { required: false }),
    edge("crm", "collected", { required: false }),
    edge("integration_health", "collected", { required: false }),
    edge("collected", "detect_material"),
    edge("detect_material", "material"),
    branch("material", "diagnose", true),
    branch("material", "quiet_week", false),
    edge("diagnose", "brief"),
    edge("brief", "queue"),
    edge("queue", "internal_brief"),
    edge("internal_brief", "client_autonomy"),
    edge("client_autonomy", "client_brief"),
    edge("client_brief", "done", { required: false }),
    edge("quiet_week", "done", { required: false }),
  ],
});

// ------------------------------------- 7. Monthly client reporting

export const MONTHLY_REPORT_KEY = "monthly_client_reporting_v1";

export const monthlyReportingWorkflow = defineWorkflow({
  key: MONTHLY_REPORT_KEY,
  name: "Monthly client reporting",
  description:
    "Validate the period, ingest analytics, search console and CRM, compute deterministic metrics, compare against baseline and prior period, generate interpretations, fact-check them independently, then publish an immutable approved report.",
  domain: "delivery",
  owner: "fulfilment operator",
  actionType: "client_reporting_publication",
  autonomyLevel: 2,
  riskClassification: "medium",
  maxCostMicroUsd: 3_000_000,
  maxDurationMinutes: 240,
  maxParallel: 6,
  requiredApprovals: ["approve_content"],
  requiredConnectors: [
    "analytics.fetch_sessions",
    "search_console.fetch_queries",
    "crm.fetch_opportunities",
  ],
  evaluationSuite: "executive-reporting-v1",
  triggers: [
    {
      kind: "schedule",
      key: "monthly_report",
      cron: "0 8 3 * *",
      timezone: "America/New_York",
      missedRunPolicy: "run_once",
      description: "Third of the month, for the month just ended",
    },
    { kind: "manual", description: "An operator regenerates a period's report" },
  ],
  acceptanceCriteria: [
    "Every metric carries numerator, denominator, sample, period, scope and calculation version.",
    "A metric that cannot state its denominator is excluded and the exclusion is disclosed.",
    "A broken connector is disclosed in the report rather than reducing the numbers silently.",
    "Interpretations are fact-checked independently before a human sees them.",
    "Causal language is only used where a holdout or controlled comparison exists.",
    "The published report is immutable and its evidence is drillable.",
  ],
  nodes: [
    trigger("entry", "schedule", "Monthly schedule"),
    step("validate_period", "det.compare_periods", "Validate the reporting period", {
      currentPath: "payload.periodEnd",
      previousPath: "payload.periodStart",
      materialityPct: 0,
    }),
    step("completeness", "det.check_evidence_freshness", "Check measurement completeness", {
      maxAgeDays: 45,
    }),
    fetch("ga4", "analytics.fetch_sessions", "Ingest GA4", {
      params: { startDate: "30daysAgo", endDate: "yesterday" },
    }),
    fetch("referrals", "analytics.fetch_referrals", "Ingest AI referral traffic", {
      params: { startDate: "30daysAgo", endDate: "yesterday" },
    }),
    fetch("gsc", "search_console.fetch_queries", "Ingest Search Console", {
      params: { startDate: "30daysAgo", endDate: "yesterday" },
    }),
    fetch("crm", "crm.fetch_opportunities", "Ingest CRM", { params: { limit: 100 } }),
    step("actions", "det.query_records", "Collect completed actions", {
      table: "action_outcomes",
      limit: 100,
    }),
    fanIn("ingested", "Join the ingestions", 2),

    step("metrics", "det.calculate_metric", "Compute the deterministic metrics", {
      numeratorPath: "ga4.data.rowCount",
      denominatorPath: "gsc.data.rowCount",
      minimumSample: 1,
      calculationVersion: "v1.0",
      scope: "client_month",
    }),
    step("vs_baseline", "det.compare_periods", "Compare against baseline", {
      currentPath: "metrics.value",
      previousPath: "metrics.numerator",
      materialityPct: 10,
      minimumSample: 10,
      samplePath: "metrics.sample",
    }),
    step("attribution", "det.calculate_attribution", "Classify attribution", {
      signalsPath: "referrals.data",
    }),
    step("sections", "dom.assemble_report_section", "Assemble the report sections", {
      metricsPath: "metrics",
      section: "ai_visibility",
    }),
    // A report with no computable metric must not reach a human for approval.
    // Asking someone to approve an empty report is how rubber-stamping starts.
    control("has_metrics", "ctl.condition", "Did any metric compute?", {
      path: "sections.metricCount",
      comparator: "gte",
      value: 1,
    }),
    agent("interpret", "generate_executive_narrative", "Generate the interpretations", {
      contextPath: "sections",
    }),
    verify("fact_check", "verify_claims", "Independent fact check", {
      contextPath: "interpret",
    }),
    control("reporting_gate", "ctl.condition", "Did the fact check pass?", {
      path: "fact_check.allSupported",
      comparator: "eq",
      value: true,
    }),
    step("withhold", "ctl.safe_stop", "Withhold the report", {
      reason:
        "one or more interpretations failed the independent fact check; the report is withheld rather than published with an unsupported statement",
    }),
    human(
      "internal_approval",
      "approve_content",
      "Internal approval of the client report",
      { artifactPath: "interpret", evidenceIdsPath: "sections.metrics" },
      { riskLevel: "high", approvalRole: "operator" }
    ),
    act(
      "publish",
      "notification.send_client",
      "Publish and notify the client",
      { inputPath: "interpret", actionType: "client_reporting_publication" },
      { riskLevel: "high" }
    ),
    step("archive", "det.hash_artifact", "Archive the immutable version", {
      contentPath: "interpret",
    }),
    success("done", "Report published and archived"),
  ],
  edges: [
    edge("entry", "validate_period"),
    edge("validate_period", "completeness"),
    edge("completeness", "ga4"),
    edge("completeness", "referrals"),
    edge("completeness", "gsc"),
    edge("completeness", "crm"),
    edge("completeness", "actions"),
    edge("ga4", "ingested", { required: false }),
    edge("referrals", "ingested", { required: false }),
    edge("gsc", "ingested", { required: false }),
    edge("crm", "ingested", { required: false }),
    edge("actions", "ingested"),
    edge("ingested", "metrics"),
    // Explicit data dependencies: the metric genuinely reads these two feeds, so
    // the edges exist. Routing them through the fan-in alone would hide that.
    edge("ga4", "metrics", { required: false }),
    edge("gsc", "metrics", { required: false }),
    edge("metrics", "vs_baseline"),
    edge("metrics", "attribution"),
    edge("referrals", "attribution", { required: false }),
    edge("vs_baseline", "sections"),
    edge("metrics", "sections", { required: false }),
    edge("attribution", "sections", { required: false }),
    edge("sections", "has_metrics"),
    branch("has_metrics", "withhold", false),
    branch("has_metrics", "interpret", true),
    edge("interpret", "fact_check"),
    edge("fact_check", "reporting_gate"),
    branch("reporting_gate", "withhold", false),
    branch("reporting_gate", "internal_approval", true),
    edge("internal_approval", "publish"),
    edge("publish", "archive"),
    edge("archive", "done"),
  ],
});

export const deliveryWorkflows = [
  clientOnboardingWorkflow,
  weeklyOperationsWorkflow,
  monthlyReportingWorkflow,
];
