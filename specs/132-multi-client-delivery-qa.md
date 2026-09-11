# Spec 132 — Multi-client delivery QA and the client delivery orchestrator

> Status: implemented 2026-09-06
> Depends on: 131 (engagements, baseline packages, work provenance), 028/052 (exclusivity), 007/062 (tasks, interventions), 031 (portal), 044/055 (agent runner, model routing), 019 (control tower queue)

## Goal
Recommended First can run 5, 10, 25 simultaneously active retained clients without founder memory: important state is explicit, deterministic, auditable and fail-closed. Every active client has a visible position in MEASURE → DIAGNOSE → CHANGE → REMEASURE, and one page answers "what requires attention today across every client" and "is every client receiving the service we sold them".

## Architecture
```
CANONICAL DATA  (projects, client_engagements, tasks, engagement_measurements, billing_events,
                 exclusivity_agreements, markets, user_project_access, audit_log)
        ↓  one batched read (lib/engagements/portfolio.ts loadPortfolioData: a fixed handful of queries for N clients)
SEVEN QA LANES  (lib/engagements/qa.ts — pure, deterministic)
   1 activation   2 evidence   3 execution   4 measurement   5 communication   6 portfolio   7 security (tests)
        ↓  material outcomes → engagement_qa_events (open → resolved / overridden with actor, time, reason, previous result)
CLIENT DELIVERY ORCHESTRATOR  (portfolioScan: alerts ranked safety → client waiting on us → measurement → approvals/communication → routine)
        ↓
TODAY ("Clients today" + queue items) · CLIENTS index (active engagements table) · ENGAGEMENT page (Delivery QA, Ask the client, communication QA)
```
LLM reviewers sit beside lane 5 and the evidence interpretation, receive a constrained fact pack, and return advisory issues stored as P2 events. They never decide counts, payments, exclusivity, baselines, approvals, access, comparability, completion or stage.

## Deterministic lanes (exact checks)
- **Activation** (`activationQa`): entity linked · primary contact · terms · dates valid · contract signed + reference · payment or founder override (override is P2, never hidden) · market definition confirmed · exclusivity active · no market conflict · competitor set non-empty / client-confirmed · baseline exists, non-empty, immutability trigger present, resolver policy current, not stale (>120 days) · priority captured · access resolved. Verdict PASS / BLOCKED / REVIEW_REQUIRED. `markActive` refuses on BLOCKED.
- **Evidence** (`evidenceDriftQa`, daily `evidenceDriftScan`): recompute each frozen baseline from its run → COUNT_DRIFT; aliases changed → BASELINE_ENTITY_DRIFT; resolver policy changed → ENTITY_DRIFT; competitor archived/merged → COMPETITOR_MISMATCH; recompute failure → RECOMPUTE_FAILED. The package is never mutated.
- **Execution** (`executionState`, `executionStartQa`, `executionCompleteQa`; wired into `startTask`/`completeTask` for projects with a live engagement): states PASS / BLOCKED_CLIENT / BLOCKED_INTERNAL / BLOCKED_THIRD_PARTY / APPROVAL_REQUIRED / OUT_OF_SCOPE / EVIDENCE_MISSING. Start refuses on any of those plus SCOPE_SUSPECTED (adjacent-service vocabulary not named in the engagement scope). Complete refuses without after state, before state, target, when the title is activity language ("optimized", "worked on", "improved citations", "did SEO", "fixed visibility") with no after state, when approval is outstanding, or while blocked.
- **Measurement** (`comparabilityLabel`, `causalLanguageIssues`): HIGH_COMPARABILITY only for grade high on a completed run; PARTIAL for medium/low or partial runs; NON_COMPARABLE otherwise. Causal, guarantee and unsupported-percent language is flagged.
- **Communication** (`communicationQa` over the composed weekly draft and any edited draft): client name present · no other client's name (P0) · every "X of N" is canonical (P0) · no causal/guarantee language · no prospecting vocabulary · no operator notes (P0) · no internal jargon (P2) · DONE bullets match completed items, IN PROGRESS bullets are not completed · remeasurement dates match the planned slot.
- **Portfolio** (`portfolioAlerts`, `billingState`, `loopPosition`, `offboardingQa`): CLIENT_WAITING_ON_US · CLIENT_APPROVAL_WAITING · CLIENT_INPUT_WAITING · THIRD_PARTY_WAITING · NO_ACTIVE_WORK · NO_WORK_COMPLETED_RECENTLY (21 days) · CLIENT_UPDATE_DUE (7-day cadence) · MEASUREMENT_DUE (≤3 days) · MEASUREMENT_OVERDUE · BILLING_ATTENTION (UNKNOWN never reads as current) · RENEWAL_REVIEW_DUE · ENGAGEMENT_ENDING (14 days) · EXCLUSIVITY_CONFLICT · PORTAL_ACCESS_ISSUE · ONBOARDING_INCOMPLETE · LOOP_LINK_MISSING · OFFBOARDING_INCOMPLETE · echoes of open evidence/activation events. QA status CLEAR / ATTENTION / BLOCKED / P0 — no numeric score.
- **Security**: `tests/integration/multi-client-portfolio.test.ts` (A cannot read B across portal reads; client roles cannot write any service; fact packs exclude other clients) and the spec 131 dry run; runs in CI on every deploy.

## Orchestrator
`portfolioScan()` returns per-client alerts, waiting-on, QA status, loop position, billing state, headline and a ranked `priorities` list. Today renders it as "Clients today"; the control-tower queue takes the same alerts as items (no per-client queries). Capacity line: live engagements, waiting on us, approvals out, client-input blocked, measurements due, P0.

## Schedule
Event-driven: activation (markActive), execution (start/complete), communication (draft composition; reviewer on demand), measurement (recordMeasurement). Periodic: `runDailyDeliveryQa` on the automation tick (windowed 20h): portfolio scan persisted + evidence drift scan. LLM review only on demand.

## Multi-client onboarding
`onboardingQuestions`: REQUIRED_CORE (priorities incl. buyer/seller, competitor set confirm-with-default, editable assets/access) hidden once a context item answers them; CONDITIONAL (own site, brokerage, approver) only when the record lacks the fact. Context provenance stays PUBLIC_OBSERVATION / CLIENT_CONFIRMED / CLIENT_PRIORITY.

## Out of scope
Stripe, DocuSign, CRM, new task/portal systems, agent swarm, event bus, health score, time tracking, Slack bot, automatic client communication, autonomous public-site editing.

## Acceptance criteria
- [x] Unit: 17 deterministic-lane cases (`tests/unit/engagement-qa.test.ts`).
- [x] Integration A–E: isolation, nested-market refusal, sibling allowed, Today ranking, execution refusal of vague completion and adjacent-service start, communication P0 on other-client name, drift flagged without mutation, override trail, offboarding incomplete visible, renewal by calendar.
- [x] 10 and 25 active clients scanned with the batched loader; timing logged; 25-client scan bounded relative to 10.
- [x] Migration 106 reversible; typecheck, lint, build.
