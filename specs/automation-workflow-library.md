# Spec — Automation Node & Workflow Library

> Status: implemented
> Parent: `specs/native-automation-and-connector-layer.md`

## Goal

Make a new business process a **graph composed of existing nodes**, not a new
service. Today each of the three spec-018 templates carries bespoke handlers;
nothing is reusable. This spec defines the shared node library and the
seventeen workflows built from it.

## Existing capabilities

`lib/workflow/handlers.ts` already provides the registry and the built-ins
whose semantics belong to the engine: `fan_in`, `approval_gate`,
`terminal_success`, `terminal_failure`, `manual_task`, `delay`, `timer`. Those
are untouched. Everything below registers alongside them.

The six quality gates in `lib/workflow/gates.ts` (evidence completeness, claim
verification, content quality, executive reporting, confidence routing,
adversarial review) are reused verbatim as `evidence_gate` / verification
nodes.

## Node library

All handlers live under `lib/automation/nodes/`, one module per category, and
are registered by `registerAutomationNodes()`. Names are namespaced
(`ctl.condition`, `det.calculate_metric`, `int.crm_create_contact`) so a
template author can see the category at the call site.

**Shipped: 112 handlers.** The counts below are what is registered, not what
was requested — where a requested node is not built, this spec says so.

### A. Trigger nodes — 5 (`nodes/human.ts`)

`trg.schedule` · `trg.webhook` · `trg.domain_event` · `trg.threshold` ·
`trg.manual`

A trigger node is the graph's documented entry point. It does not *cause* the
run — the trigger system does — it **records and validates** what started it,
so a run's provenance is a node output rather than a log line. Each asserts
that the run's `trigger` field matches and echoes the triggering event's
correlation ID.

### B. Control nodes — 12 (`nodes/control.ts`)

| Node | Behaviour |
|---|---|
| `condition` | Evaluates a data-driven predicate over inputs; succeeds with `{ result }` for downstream edge conditions |
| `switch` | N-way branch; emits `{ branch }` |
| `fan_out` | Emits `fanKeys` from a declared source path, bounded by `MAX_FAN_OUT` |
| `fan_in` | Built-in (spec 018) — discloses partial completion |
| `wait` / `delay` | Durable wait; long waits park the run rather than sleeping a worker |
| `retry` | Declarative retry marker; the engine owns the mechanism |
| `rate_limit` | Bounds sends per window per client; over-limit ⇒ safe stop, not silent drop |
| `cost_limit` | Refuses to proceed when the remaining budget is below the node's estimate |
| `approval_gate` | Built-in (spec 018) |
| `evidence_gate` | Runs the evidence-completeness gate; insufficient ⇒ safe stop |
| `confidence_gate` | Routes below-threshold outputs to human review |
| `autonomy_gate` | Resolves the effective autonomy level and blocks level-0/2 actions without approval |
| `scope_gate` | Asserts the run's project scope matches every referenced record |
| `safe_stop` | An explicit, declared stop with a reason |
| `test_mode_guard` | Makes the test/live divergence explicit in the graph |
| `terminal_success` / `terminal_failure` | Built-ins (spec 018) |

`retry` is **not** a node: retry is a per-node policy the engine owns
(`maxAttempts`, `retryBackoffSeconds`), and a node that merely marked an
intention would be decoration.

### C. Deterministic nodes — 17 (`nodes/deterministic.ts`)

Records: `fetch_record`, `query_records`. Normalisation: `normalize_entity`
(which applies the url/email/phone normalisers from
`lib/connectors/mapping.ts`). Mapping: `map_fields`, `deduplicate`.
Calculation: `calculate_metric`, `compare_periods`, `classify_threshold`,
`calculate_priority`, `calculate_attribution`. Integrity: `hash_artifact`,
`validate_hash`. Checks: `check_evidence_freshness`, `check_claim_expiration`,
`check_permission`. Scheduling: `create_task`, `schedule_remeasurement`.

Every one is a pure function over inputs plus scoped reads. **No LLM.** Anything
a deterministic node computes is reproducible from the same inputs — that is
what makes a metric defensible in a client report.

Two guarantees worth naming:

- `query_records` and `fetch_record` operate on an **allowlist** of tables, each
  declaring its tenant-scope column and its own ordering column. Nothing can
  query a table nobody added deliberately.
- `create_task` refuses to create a suggested task with no evidence, matching
  the `tasks_suggested_need_evidence` constraint rather than colliding with it.

**Not built** (requested, deliberately deferred): `create_record`,
`update_record`, `append_version`, `validate_schema`, `normalize_url` /
`normalize_email` / `normalize_phone` as standalone nodes,
`calculate_client_health`, `transform_data`, `create_export`. Each either has an
existing service-layer equivalent (`lib/control-tower/health.ts`,
`lib/evidence/export.ts`) or would be a thin wrapper no shipped workflow needs.
Adding one is a small, deliberate act — which is the point of a registry.

### D. Agent nodes — 19 (`nodes/agent.ts`)

Agent nodes **draft and classify; they never act**. An agent output reaches the
outside world only through an integration node that a human or an autonomy
policy released. Each has a versioned prompt in `lib/automation/prompts.ts` and a
Zod output schema in `nodes/agent.ts`; the two are versioned together.

Implemented with runners: `classify_lead`, `draft_outreach`, `classify_reply`,
`extract_claims`, `verify_claims`, `build_content_brief`, `draft_content`,
`verify_content`, `adversarial_content_review`, `diagnose_visibility_gap`,
`prioritize_authority_actions`, `analyze_competitor_evidence`,
`summarize_meeting`, `draft_meeting_followup`, `summarize_support_request`,
`analyze_renewal_risk`, `detect_contradictions`,
`generate_executive_narrative`, `repurpose_content`.

`generate_executive_narrative` replaces the requested
`generate_weekly_brief` / `generate_monthly_report` / `generate_quarterly_review`
trio: all three produce statement lists from computed metrics, and three prompts
that differ only in audience would drift apart. The period and audience are node
config; the mandatory statement-kind field is the same in every case.

Three guarantees are structural rather than prompted:

- Every system prompt carries the same non-negotiables — no unsupported
  assertion, no correlation stated as cause, no inference of protected
  characteristics — asserted by `tests/unit/automation-workflows.test.ts`.
- No agent schema contains a field for a protected characteristic. A schema-level
  absence is a stronger guarantee than an instruction.
- Stop rules are read from explicit booleans (`shouldStopSequence`, `isOptOut`),
  never inferred from prose.

### E. Integration nodes — 30 (`nodes/integration.ts`)

One node per connector capability, all delegating to `executeCapability`.
Nothing provider-specific appears in a node. Consequential capabilities carry
`riskLevel: 'high'` and `requiresApproval: true` by default, which the autonomy
policy may relax per client but never silently.

### F. Human nodes — 10 (`nodes/human.ts`)

`approve_content`, `approve_outreach`, `approve_profile_correction`,
`verify_transaction`, `approve_claim`, `review_attribution`,
`review_low_confidence_result`, `choose_strategy`, `approve_invoice_exception`,
`approve_external_submission`. Each is an `approval_gate` with a typed summary
and the evidence IDs the approver needs — an approval request with no evidence
is a rejected pattern, not a shortcut.

### G. Domain nodes — 19 (`nodes/domain.ts`)

The ones that make this an AI-market-authority layer rather than a generic
engine: evidence packets (client and prospect), outreach sequences and their stop
rules, suppression, meeting briefs and decisions, support intake, deterministic
invoice amounts, billing events, event publication, the outcome graph, report
sections, and artifact hashing. None of it is expressible as "call an HTTP
endpoint", which is the argument for building this layer rather than configuring
a generic one.

### H. Data, notification, verification, terminal

Notification is an integration capability (`notification.send_internal` /
`send_client`), not a separate category — it goes through the same connector
boundary as every other outward action, so the send gate applies to it too.
Verification uses the agent nodes with `type: "verification_task"`, which
`isEffectful()` correctly treats as a guard rather than an act. Terminals are
spec-018 built-ins.

## Workflow catalogue

Definitions live in `lib/automation/workflows/`. Every one declares acceptance
criteria, an autonomy level, a risk classification, required connectors and
required approvals.

All eighteen are shipped, published, and validating (`content_production_v2`
supersedes spec 018's v1, which stays registered — hence eighteen definitions for
seventeen numbered processes, plus renewal risk).

| # | Key | Trigger | Autonomy | Risk | Required connectors |
|---|---|---|---|---|---|
| 1 | `prospect_audit_outreach_v1` | manual / event `prospect.identified` | 2 | high | email, crm |
| 2 | `inbound_lead_qualification_v1` | webhook / event `lead.created` | 3 | medium | crm, email |
| 3 | `client_onboarding_v1` | event `client.created` | 2 | medium | analytics, search_console, crm |
| 4 | `client_weekly_operations_v1` | schedule (weekly) | 3 | low | analytics, crm |
| 5 | `monthly_client_reporting_v1` | schedule (monthly) | 2 | medium | analytics, search_console, crm |
| 6 | `content_production_v2` | event `content.opportunity_created` | 2 | high | cms |
| 7 | `content_repurposing_v1` | event `content.published` | 2 | medium | cms, notification |
| 8 | `reputation_profile_correction_v1` | schedule (weekly) | 2 | high | — |
| 9 | `competitor_intelligence_v1` | schedule (weekly) | 3 | low | — |
| 10 | `transaction_to_authority_v1` | event `transaction.created` | 2 | high | — |
| 11 | `meeting_preparation_v1` | schedule (daily) | 3 | low | calendar, crm, email |
| 12 | `meeting_followup_v1` | event `meeting.completed` | 2 | medium | crm, email |
| 13 | `ai_to_revenue_attribution_v1` | schedule (daily) | 3 | medium | analytics, crm |
| 14 | `client_support_v1` | webhook / event `support.message_received` | 2 | medium | email |
| 15 | `billing_and_collections_v1` | schedule + event `invoice.overdue` | 3 | high | billing, email |
| 16 | `integration_health_v1` | schedule (daily) | 4 | low | all connected |
| 17 | `daily_control_tower_v1` | schedule (daily) | 4 | low | notification |
| 18 | `renewal_risk_v1` | schedule (monthly) + threshold | 3 | medium | notification |

`content_production_v2` supersedes spec 018's `content_production_v1`; the v1
definition and its runs stay intact and reproducible (that is what versioned
definitions are for), and the v1 key remains registered.

### Design notes that recur

- **Evidence before assertion.** Workflows 1, 6, 7, 8, 10 all route every
  outward-facing claim through claim verification against the approved
  knowledge graph. A claim with no evidence blocks the send; it does not
  degrade to a hedge.
- **Attribution is disclosed, never asserted.** Workflow 13 classifies into
  `confirmed_ai_referral`, `confirmed_self_reported_ai_discovery`,
  `ai_assisted`, `probable_ai_influence`, `unknown`, with the deterministic
  rule that produced each and its confidence. Correlation is never labelled
  confirmed.
- **No LLM arithmetic.** Workflow 15 computes invoice amounts from the contract
  record with `calculate_metric`; the agent's only role is drafting the
  human-readable reminder text, which a human or a level-4 policy releases.
- **Volatility discipline.** Workflow 4 reports only movement above the
  materiality threshold; ordinary LLM run-to-run variance is filtered out
  before anything reaches a client.
- **Stop conditions are first class.** Workflow 1's sequence stops on reply,
  opt-out, bounce or booking; every stop is a recorded state, not an absent
  next step.

## Internal workflow authoring

Shipped:

1. **Template gallery** (`/automation/workflows`) — every definition with
   version, autonomy, risk, triggers, required connectors, and validation
   status.
2. **Read-only graph visualisation** — a layered DAG rendering with node type,
   risk, approval requirement and current-run state overlay.
3. **Template configurator** — duplicate a template into a client-scoped
   configuration: parameters, triggers, schedule, connector selection,
   autonomy level, approvers, thresholds. Validation runs before save.
4. **Test-run inspector** — node inputs, outputs, routing decisions, evidence,
   confidence, estimated cost, and the would-have-happened list.
5. **Version history + publication/deprecation.**

Deliberately **not** shipped: a drag-and-drop canvas, arbitrary code nodes,
customer-facing builder. Path to a canvas: the graph is already data
(`workflow_versions.spec`), validation is already a pure function
(`validateGraph`), and the node palette is already a typed registry — a canvas
is a rendering-and-editing concern over those three, with no engine change
required. That is a UI project, not an architecture project.

## Test mode

`workflow_runs.mode`. A test run:

- resolves every connector to its fixture path for reads;
- **refuses** consequential capabilities (send, publish, invoice) and records
  what would have happened;
- refuses CRM mutation unless `allowCrmWrites` is explicitly set;
- tags every record it creates with `test: true` and a `testRunId`;
- shows node inputs/outputs, routing, evidence, confidence and estimated cost;
- supports replay from stored fixtures.

`assertNotTestMode()` guards every consequential path, and the guard is tested
from the *node* side, not just the connector side, so a new node cannot
accidentally bypass it.

## Testing

Per workflow: graph validation, a fixture-driven happy path, at least one
refusal path (missing evidence / low confidence / suppression / approval
rejection), and idempotent re-entry.

Four E2E demos: prospect outreach (16 steps), client content (11), monthly
reporting (9), failure recovery (6).

## Acceptance criteria

- [x] Every workflow validates as a graph and publishes a version.
- [x] Nodes are reused across workflows; no template re-implements a library
      node.
- [x] Every outward-facing claim is evidence-linked or blocked.
- [x] Test mode prevents live sends, publishes, invoices and CRM writes.
- [x] Every workflow declares acceptance criteria, autonomy, risk and required
      connectors.
- [x] Four E2E demos pass from fixtures.

## What shipped, measured

- **18 workflow definitions**, all passing `validateAutomationDefinition`
  (graph validity, path ordering, owner, cost cap, connector coverage,
  approval coverage for high-risk autonomy).
- **112 registered node handlers** across seven categories.
- **19 agents** with implemented runners, versioned prompts and Zod schemas.
- **4 end-to-end demos** passing from fixtures, spending nothing.

## Known limitations

- Agent nodes whose runners are not implemented remain `declared`; a workflow
  referencing one fails validation rather than silently skipping. The shipped
  workflows reference only implemented agents.
- A test run requires a fixture for every capability and agent it reaches. That
  is deliberate — a node with no fixture fails with a clear message rather than
  inventing data — but it does mean adding a node to a workflow can invalidate
  an existing stored fixture until it is extended.
- Graph visualisation is layered-list + SVG edges, not an interactive canvas.
- Workflow 8 submits corrections only through channels the platform can reach
  (CMS, email); portal-specific submission forms are recorded as manual tasks.
- Workflow 11's email context requires a Gmail connection; without one the
  brief is produced from CRM and platform data and says so.
