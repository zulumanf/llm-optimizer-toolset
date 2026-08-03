# Spec 034 — Learning Loop Closure

> Status: done (2026-08-02) — implemented and test-verified; see acceptance checklist
> Depends on: specs/007 (attribution) · specs/019 (outcome graph) · specs/026 (program plans) · specs/033 (MCP) · docs/ai-visibility-roadmap.md Phase 2
> Branch: feat/034-learning-loop

## Goal

Close the "did it work, and what did we learn" half of the visibility loop. Today: `composePlan`/`approvePlan` are implemented and tested but unreachable from the product; `action_outcomes` are recorded but never measured (every row parks at `insufficient_measurement` forever); interventions carry no hypothesis; and validated learnings have no home. When this is done: plans are composable and approvable from the plan page; due action outcomes are measured automatically on the heartbeat with honest labels; experiments state what they expect to happen; and durable, confidence-labeled learnings are recordable and searchable — including by agents over MCP.

## Non-goals

- No auto-generated learnings. A measured outcome **suggests** a learning; only a person (or an explicitly acting operator via MCP) records one. "Do not treat an unvalidated observation as a universal rule."
- No traffic/leads/pipeline measurement — those columns stay null until a data source exists (connectors are not live). Null is not zero.
- No new dashboards. The plan page gains two buttons; learnings are MCP/DB-first.

## User stories

- As an operator, I can compose and approve a program plan from the plan page instead of it being test-only code.
- As an operator, actions the platform records get measured automatically once their expected-impact window passes, and the label tells me signal / no change / confounded / insufficient — never a silent zero.
- As an operator, I can state a hypothesis when registering an experiment, and see it later.
- As an operator or agent, I can record a learning tied to measured outcomes, and search learnings by text/project/category over MCP.

## UI

Plan page (`/projects/[id]/plan`): a "Compose plan" button (when no active plan or to supersede) and an "Approve plan" button on a draft plan — same client-component button pattern as `AnalyzeRunButton`. No other UI. Intervention form gains an optional "Hypothesis" textarea.

## Database changes (migration 040, reversible)

- `interventions` + `hypothesis text` (nullable — historical rows honestly have none).
- `learnings` — id, project_id nullable FK (null = cross-project), category text check in ('content','authority','entity','technical','distribution','process','other'), statement text (≤500), rationale text, confidence_label check in ('confirmed','strongly_supported','correlated','probable','unknown') — same vocabulary as `outcome_relationships`, source_action_outcome_ids uuid[], evidence_note text, status check in ('active','retired') default 'active', retired_reason text, created_by FK users, created_at, retired_at, retired_by. Indexes: (project_id), (status, category). Not immutable — a learning may be retired (status change only; statement edits are a new learning).
- Rollback: drop `learnings`, drop the column.

## Behavior

### Plan entry points
`app/plans/actions.ts`: `composePlanAction`, `approvePlanAction` — thin wrappers over the existing service (which already validates, supersedes, audits). No service changes.

### Outcome measurement sweep (`lib/outcomes/sweep.ts`)
Runs on every automation heartbeat (same try/catch isolation as knowledge maintenance; no window claim needed — `measureAction`'s write-once `measured_at` + `FOR UPDATE` make it idempotent).

- **Due**: `measured_at is null` and `coalesce(completed_on, created_at::date) + coalesce(expected_days_to_impact, 30) days ≤ today`.
- **After**: subject-company `mention_rate` (provider `all`, current `SCORING_VERSION`) from the latest scored run started **after** the action date; owned-citation count from that run (`response_citations.company_id = subject`).
- **Before**: stored `*_before` values if present, else the same pair from the latest scored run started **before** the action date, same scoring version (cross-version comparison stays forbidden — a version mismatch leaves the value null).
- **No post-action scored run yet**: skip (stays due; measured when a run lands) — unless overdue by more than 60 days past the due date, in which case measure with nulls, settling honestly as `insufficient_measurement` and ending the retry loop.
- **Confounders**: other action_outcomes in the same project whose action date falls within ±42 days (half of attribution's `CONFOUND_WINDOW_DAYS`) are listed by action_type; `labelEffectiveness` then yields `confounded` when movement exists.
- **Materiality**: `OUTCOME_MATERIALITY_THRESHOLD = 0.1` (the established 0.1 precedent from spec-019 tests/seed), named in `lib/outcomes/graph.ts`.

### Learnings (`lib/learnings/service.ts`)
- `recordLearning(user, raw)` — staff-only; `confirmed`/`strongly_supported` require ≥1 `source_action_outcome_ids` whose rows exist and are measured (a learning claiming confirmation must point at evidence); writes `audit_log`.
- `searchLearnings({ query?, projectId?, category?, includeRetired? })` — ILIKE over statement/rationale; project filter includes cross-project rows (project_id null).
- `retireLearning(user, { id, reason })` — status change with required reason; audited.

### MCP (registry 15 → 17 tools)
- `search_learnings` (observer) → `searchLearnings`.
- `record_learning` (operator: dry-run, idempotency key, ledger row) → `recordLearning`.
- `create_experiment` input gains optional `hypothesis` (≤500), passed through to the service.

### Interventions
`createIntervention` accepts optional `hypothesis`, stores it; the intervention detail page renders it (the page reads the full row); form field.

## Edge cases

- Sweep with no subject company or no scored runs at all → outcome skipped until overdue, then `insufficient_measurement` with nulls.
- Before-run exists only under an older scoring version → before stays null; a one-sided pair yields no movement for that metric (null ≠ 0 in `labelEffectiveness`).
- `record_learning` with `confirmed` but unmeasured source outcomes → `validation` error naming the unmeasured id.
- Retired learnings are excluded from `search_learnings` unless `include_retired`.
- Compose on a project with an approved plan supersedes it (existing service semantics — surfaced in the button copy).

## Acceptance criteria

- [x] "Compose plan" and "Approve plan" work end-to-end from the plan page (service behavior unchanged).
- [x] The heartbeat measures due outcomes: a backdated recorded action with before/after scored runs gets a real effectiveness label and `measured_at`; a second sweep pass changes nothing.
- [x] An action with no post-action run stays unmeasured until the 60-day give-up, then settles `insufficient_measurement`.
- [x] Confounding overlapping actions produce `confounded`, not a signal label.
- [x] `create_experiment`/intervention form persist a hypothesis; `interventionView` returns it.
- [x] Learnings: record/search/retire work; the confirmed-requires-measured-evidence gate holds; MCP exposes both tools with ledger + idempotency on `record_learning`.
- [x] Migration 040 applies and rolls back cleanly; suite, lint, typecheck green.

## Test cases

- Integration `outcomes-sweep.test.ts`: due/not-due boundaries; label correctness with hand-made score rows (positive, no-change, confounded); give-up path; idempotent second pass; scoring-version-mismatch leaves before null.
- Integration `learnings.test.ts`: record (each confidence label), confirmed-gate failure, search filters incl. cross-project rows, retire with reason, audit rows.
- Integration `mcp.test.ts`: registry count 17; `record_learning` dry-run/ledger/replay; `search_learnings` results; experiment hypothesis passthrough.
- Integration `program-plans.test.ts`: unchanged (service covered); actions are thin wrappers.
- Unit: sweep due-date math and confounder-window predicate (pure helpers).

## Definition of done

All acceptance criteria pass · suite/lint/typecheck green · migration up/down/up clean · `docs/ai-visibility-mcp-tools.md` + roadmap updated · DECISIONS.md records the measurement-source choice (mention_rate + owned-citation count) and the no-auto-learnings rule.
