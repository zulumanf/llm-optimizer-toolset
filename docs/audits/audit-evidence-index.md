# Audit Evidence Index

> Everything inspected for the 2026-07-29 five-products audit, with the
> verification commands run. Reproduce any conclusion from these sources.

## Checks executed (all passing at audit time, commit range up to `main`@evidence-audit merge)

- `npx tsc --noEmit` — clean
- `npm run lint` — 0 warnings/errors (`--max-warnings 0`)
- `npm run test` — 181/181 across 24 files (vitest; integration tests run
  against local Postgres `llm_optimizer_test`)
- `npm run build` — clean production build
- Migration reversibility — `scripts/migrate.ts` up/down exercised for 011
  during its build; all 11 apply from empty schema in every integration
  suite's beforeAll
- Marker grep — `TODO|FIXME|placeholder|not implemented|hard-coded|demo
  only|fake|stub` over lib/app/components/workers/db/scripts

## Governance & documentation

- CLAUDE.md · PRINCIPLES.md · DECISIONS.md (13 dated decisions)
- docs/00-vision (incl. 2026-07-27 multi-client amendment) · 01-prd ·
  02-architecture · 03-database-schema · 04-ui-design-system ·
  05-feature-specs · 06-scoring-methodology (v1.0) · 07-experiment-protocol
  · 08-roadmap (phase 2 added 2026-07-27) · 09-testing · 10-security ·
  11-coding-standards · 12-ai-guidelines · 13-prompts (5 registered) ·
  14-future-ideas · 15-agentic-operations
- specs/001–010 (status: done, with implementation notes) · specs/011,
  012 (drafts) · specs/llm-evidence-capture-and-audit-trail.md (done)

## Database (db/migrations/001–011)

projects (+subject_company_id) · prompt_sets/prompts(+is_holdout)/
prompt_set_versions (frozen_prompts jsonb) · runs · responses (immutable,
+response_hash/payload_hash/hashed_at) · jobs · companies · mentions
(revisioned) · response_parses · sources · brand_candidates · competitors ·
scores · reports (immutable when published) · interventions ·
intervention_runs · evidence · tasks · claims · gap_findings ·
content_assets · content_versions (immutable) · evidence_artifacts
(immutable) · audit_samples · client_validation_runs/observations
(insert-only) · evidence_exports · audit_log (append-only) ·
forbid_mutation()/compute_response_hashes()/compute_validation_hash()
trigger functions.

## Services (lib/)

ai/ (openai incl. +search Responses API, anthropic, google, perplexity,
mock, registry, retry, pricing, citations, agent runner) · prompts/ (set +
prompt services, freeze) · runs/ (validation, cells, service, execute) ·
parsing/ (prepass, classify heuristic-v1, candidates, service) · mentions/
(review queue) · scoring/ (metrics, compute) · competitors/ · reports/
(snapshot, drafter, validate, service) · attribution/ (interventions,
verdicts — note rename recommendation) · tasks/ · claims/ · gaps/ (detect,
service) · content/ (prompts, validate, service) · evidence/ (stability,
sampler, observations, integrity, storage, service, export) · projects/
(incl. baseline) · companies/ · auth (dev-mode) · env · errors · logger ·
constants.

## Application surface

24 page routes (portfolio, companies, and per-project: dashboard,
knowledge, prompts+versions, runs+new+detail+responses+evidence, review,
gaps, content+detail, competitors, reports+detail, interventions+detail,
tasks, settings) · 3 route handlers (cron weekly-baseline, reports CSV,
evidence export download) · server actions per module (app/*/actions.ts) ·
workers/index.ts (execute_run, parse_response, compute_scores,
start_scheduled_run) · components/ per feature + shadcn ui/.

## Tests (tests/)

unit: scoring-metrics · run-cells · report-validate · attribution ·
gap-detect · content-validate · citations · evidence (stability+sampler) ·
others. integration: projects-and-auth · prompts · runs (incl. crash
recovery, budget, idempotency) · classification (review, reparse,
retraction) · competitors (SoV, discovery, backfill) · reports (lifecycle,
gate, immutability, snapshot self-containment) · attribution (baselines,
scheduling, verdicts, confounds, loop closure) · knowledge (subjects,
no-cross-talk, claims supersede) · gaps (analysis idempotency, task
creation) · content (full lifecycle, gate blocks, verifier blocks,
immutable versions) · evidence (hash+tamper, drill-down reproduction,
holdout, audit samples, validation separation, export verification).

## Live-data verification referenced

Runs in dev DB: Baseline #1 (gpt-5.4-mini, 16 cells) · Search baseline #1
(+search, 8 cells, citations) · content asset c1bb9a80… (approved) ·
5 gap findings · evidence explorer/export verified against Search
baseline #1.

## Not inspectable (recorded as CANNOT VERIFY)

Anthropic/Google/Perplexity live behavior (no keys) · cron under a real
scheduler · multi-client load · consumer-interface capture (not built).
