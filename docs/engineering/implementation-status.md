# Implementation status — spec 151 (2026-10-16)

- **Branch / worktree:** `feat/151-platform-v2` at `/Users/francisco/rf-platform`, based on `ca48d67`.
- **Commit status:** nothing is committed. `AGENTS.md` reserves commits for the founder.
- **Production:** nothing is deployed. No production database, email, billing or third-party system was touched.

> **Release hardening (2026-10-16):** see `release-151-log.md` and `deployment-checklist-151.md`.
> - The v1.2 bump is now a backward-compatible, switch-controlled cutover with dual write.
> - Migrations refuse destructive rollbacks.
> - Lease loss aborts runs.
> - All CMS publishing is gated on validated, approved content.
> - Offline prediction evaluation was added (migration 133).
> - Totals: 306 files / 3,333 vitest tests; 77 Playwright tests.

## Summary

| Milestone | Implemented | Tested | Blockers | Production readiness |
|---|---|---|---|---|
| A. Measurement v2 | Per-instrument estimates with Wilson and prompt-clustered intervals; served model and capture time; pinned instruments; frozen cohorts; dot-boundary domains; normalized aliases; echo-excluded organic scope; rescore script; per-model estimates on the run page; blind gold-annotation workflow (`/evaluation`) | Unit: stats, estimates, entity normalization, gold metrics. Integration: measurement-v2, capture-reuse, gold-annotations | Production migrations + rescore (B1, B2). Human labels needed before any precision/recall claim | Code-ready; unverified in production |
| B. Optimization & experimentation | Unified opportunities with lifecycle, dedupe and approval via source engines; source presence; JSON-LD from approved claims; pre-registered, frozen, versioned plans; DiD/paired evaluator with evidence tiers and verdicts; descriptive cross-client learning | Unit: optimization, experiment-evaluate (simulated effects). Integration: optimization-plan, intervention-plans | No real interventions exist. Plan-drafting UI and adjudication UI not built (service actions only) | Code-ready; value unproven until clients exist |
| C. Client operations & economics | Onboarding checklist, prepare-measurement (two baseline waves), initial analysis; exception queue (`/operations`); job lease renewal and fencing; client outcomes; labor ledger; measured unit economics; scenario calculator; report v2 measurement section | Unit: economics-scenarios, logger-forward. Integration: job-fencing, exceptions, economics, client-lifecycle-rehearsal (end to end on the mock) | No live engagement; infrastructure costs not recorded | Code-ready; rehearsal is not commercial validation |
| D. Foundations | Brokerage organizations, grants and roster (`/organizations`, `/portal/organizations/[id]`); backup script with database URL and encrypted-file pruning; restore script fix; `.dockerignore`; `ARTIFACT_ROOT`; error webhook; Ollama health in the exception queue; personal-data files moved out of tracked paths; docs and diligence checklist | Integration: organizations. Local backup + restore drill (encrypted, 9 s, test database) | Shared artifact storage (B3), inference host (B4), production backup schedule (B5), legal items (`production-readiness.md` §6) | Partially ready; blockers are operational and legal |

## Database migrations (all additive and reversible)

| Migration | Adds |
|---|---|
| 126 `measurement_v2` | `responses.served_model`, `.captured_at`; `measurement_instruments`, `competitor_cohorts`, `score_estimates` (insert-only) |
| 127 `gold_annotations` | `gold_samples`, `gold_sample_items`, `gold_annotations`, `gold_adjudications` (insert-only) |
| 128 `opportunities` | `opportunities`, `opportunity_events` (events insert-only) |
| 129 `intervention_plans` | `intervention_plans` + `intervention_plan_guard` trigger |
| 130 `outcomes_and_labor` | `client_outcomes`, `labor_entries` (insert-only) |
| 131 `organizations` | `organizations`, `organization_entities`, `organization_grants` |

## Significant code changes to existing behaviour

| Area | File(s) | Change |
|---|---|---|
| Scoring | `lib/scoring/compute.ts`, `lib/constants.ts` | `SCORING_VERSION` v1.1 → v1.2; compute delegates to `lib/scoring/estimates.ts`. Adds `computeScores(runId, { publishMovement })` |
| Parsing | `lib/parsing/{service,classify,classify-llm}.ts`, `lib/gaps/service.ts` | Six `endsWith` ownership checks → `domainBelongsTo` |
| Parsing | `lib/parsing/prepass.ts` | Normalized second match path for multi-token names |
| Capture | `lib/runs/execute.ts`, `lib/runs/reuse.ts` | Store `served_model`; reused captures carry the source's `captured_at` |
| Market bootstrap | `lib/markets/bootstrap.ts` | `suggestedProviders` = the project's pinned instrument (named default on first use) |
| Engagements | `lib/engagements/service.ts` | `freezeBaseline` freezes the competitor cohort |
| Jobs | `db/jobs.ts`, `workers/core.ts` | Lease renewal; fenced `completeJob`/`failJob`; new `start_baseline_wave` handler |
| Reports | `lib/reports/snapshot.ts`, `lib/reports/types.ts` | Report body gains an optional `measurement` section |
| Logging | `lib/logger.ts` | Optional `ERROR_WEBHOOK_URL` forwarding |
| Storage | `lib/evidence/storage.ts`, `lib/knowledge/sources/storage.ts`, `lib/video/constants.ts` | Root from `ARTIFACT_ROOT` |
| Navigation | `components/layout/sections.ts`, `components/layout/sidebar-nav.tsx` | "Optimize" project tab; Operations / Brokerages / Classifier check system links |
| Files | `scripts/*-contacts.json`, `scripts/*-drafts.json`, `data/internal/` → `.local-data/`; `tmp-run-followups.mts` removed | Scripts repointed; `.gitignore` rules added |

## Test results (local, 2026-10-16)

| Check | Base (`ca48d67`) | After spec 151 |
|---|---|---|
| `tsc --noEmit` | pass | pass |
| `eslint --max-warnings 0 .` | — | pass (0 warnings) |
| `vitest run` (unit + integration, real Postgres 14 at `rf_platform_test`) | 281 files / 3,192 tests pass | **298 files / 3,292 tests pass** |
| Migrations 131 → 126 down, then up again | — | pass |
| `next build` (with `DATABASE_URL` set, as in CI) | — | pass; new routes compiled |
| Runtime smoke (`next start`, dev auth, test DB): `/operations`, `/evaluation`, `/organizations`, `/organizations/[id]`, `/portal`, `/portal/organizations/[id]`, `/projects/[id]/optimization` | — | all 200; an invalid org id renders the 404 page |
| Backup → encrypted artifact → prune → restore drill (test DB) | restore failed (non-ASCII variable bug) | pass, 9 s |
| Playwright e2e | — | **not run** |

Fixed during verification:
- **City pipeline:** 4 tests failed because they depended on the old "copy the newest run anywhere" rule. They now pin an explicit, validated `MEASUREMENT_DEFAULT_INSTRUMENT` override.
- **Pre-existing bug in `scripts/restore.sh`:** `$TARGET_DB…` was read as a different variable name on macOS bash.

## Independent review (2026-10-16): findings and disposition

| Finding | Disposition |
|---|---|
| H1 parser logic changed without a version | Fixed: `mentions.matcher_version = entity-matcher-v2` on new rows (parser labels drive class-first precedence and are left unchanged) |
| H2 normalized matching crossed sentences and lists | Fixed: `. ! ? , ; :` and line breaks are hard boundaries; regression tests added |
| H3 v1.2 views empty until rescore | Documented as a mandatory pre-traffic deploy step (`production-readiness.md` §2) |
| H4 rescore applied a later cohort | Fixed: `cohortForRun` (cohort frozen at or before run start); test added |
| M1 loose "no detectable change" | Fixed: equivalence rule (interval inside ±MDE); test added |
| M2 baseline after ship / served-model disappearance / answer scope | First two fixed and tested. Scope documented: experiments use all answers on the instrument; plans should name unbranded prompts |
| M3 MDE approximation | Labelled in code and in the report limitations |
| M4 lost lease does not abort the handler | **Partly fixed (release hardening):** `execute_run` aborts and does not finalize; other long handlers ignore the signal, so stay at one worker |
| M5 existing markets would switch instrument | Fixed: first pin copies the project's own latest completed run; test added |
| M6 prepare-measurement double click / partial failure | Fixed: session advisory lock; resumable per wave; repeat-click test added |
| M7 approved opportunities rewritten on rebuild | Fixed: only `proposed` rows refresh. Task creation still happens before the guarded status write (rare orphan task on a concurrent conflict): **open** |
| M8 personal data in git history | **Open: founder decision** (history rewrite needs explicit authorization) |
| L1 unapproved proposals in report bodies | Fixed: approved/in-progress only |
| L2 roster run status, archived projects, malformed id | Fixed |
| L3 scoring CPU and row-by-row inserts | **Open:** ~2,000 bootstrap draws per estimate on the worker thread; batch inserts and a cheaper resample are follow-ups |
| L4 "TS twin" claim | Fixed (comment corrected; the SQL echo rule is exact-only) |
| L5 `gold_samples` mutable | Fixed (trigger). Gold reads rely on staff-gated pages |
| L6 provider rows dropped for multi-instrument providers | By design; documented |

## Known limitations (honest list)

1. **Two answer scopes.** `scores` stays all-answers; `score_estimates` is organic. Dashboards and trends still read `scores`; moving them to estimates is next.
2. **No human labels yet.** Classifier precision and recall are unknown until two people label a sample.
3. **No real client.** Every intervention, outcome and economics path runs only on fixtures and mock answers.
4. **`content_production_v2` still duplicates drafting** and bypasses `lib/content/validate.ts`. Bounded by its two human approvals.
   Migration plan: replace its `draft_content` agent node with a domain node that calls `lib/content/service.generateDraft`, run `verifyDraft` instead of `verify_content`, then retire the duplicate prompt routes in `lib/ai/routing.ts`.
5. **`action_outcomes` (spec 019) remains alongside interventions.** It was not merged in this pass.
6. **Cross-market sentinel controls are not wired into the evaluator.**
7. **The report v2 section renders on the internal report page only,** not yet in the portal.
8. **Object storage is not implemented.** `ARTIFACT_ROOT` only helps when both containers share a filesystem.
9. **RLS, CSP/HSTS, public-endpoint rate limits and one-click List-Unsubscribe are unchanged.**
10. **The full Playwright e2e suite was not run in this session.**

## Required manual approvals before activation

1. Merge (founder).
2. Production migrations and rescore (founder).
3. `ARTIFACT_ROOT` / object-storage decision.
4. Inference host decision for the Ollama-routed tasks.
5. Production backup schedule and restore drill.
6. Legal checklist items (counsel).
7. Any history rewrite to purge personal data (explicit authorization).

## Estimated ongoing operating costs (measurable parts only)

| Cost | Source |
|---|---|
| ~$5 per market benchmark run | `DECISIONS.md` 2026-09-14 |
| Second baseline wave | One extra run per client at onboarding |
| Re-measurement | +2/+6/+12-week retests per intervention, at the pinned instrument's per-run cost (measured in `responses.cost_usd`) |
| Rescore | $0 (no provider calls) |
| Ollama health probe | $0 |
| Hosting, database, TTS, email | Not recorded in the platform |

## Next recommended engineering steps

1. Apply 126–131 and rescore in production; label a 200-pair gold sample with two annotators.
2. Move dashboards and trends to `score_estimates`; render report v2 in the portal.
3. Build a plan-drafting form and an adjudication form (services exist).
4. Object storage for artifacts; a decision on the inference host.
5. Consolidate `content_production_v2` onto `lib/content/service`; fold `action_outcomes` into interventions.
6. Wire the cross-market sentinel as an optional control in `evaluateExperiment`.

## Final release audit (2026-10-17)

| Check | Result |
|---|---|
| `tsc`, `eslint` | pass |
| `vitest run` | 308 files passed (+1 S3-gated file skipped) / 3,356 tests passed |
| Real S3-compatible server (SeaweedFS) | 8/8 |
| `next build` | pass |
| Playwright e2e (production build) | **80/80** |
| Migrations 126–134 up/down/up, fresh database | pass |
| Local backup → restore drill | pass (~1 s) |

Milestone D foundation blockers are updated: shared artifact storage is **built and verified** (a bucket is still needed), and the backup workflows are **ready** but inert. Readiness classification per capability: `final-release-audit-151.md` §10.
