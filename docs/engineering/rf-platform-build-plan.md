# RF Platform Build Plan (spec 151)

- **Date:** 2026-10-16
- **Branch / worktree:** `feat/151-platform-v2` at `/Users/francisco/rf-platform`
- **Test DB:** `rf_platform_test`
- **Base commit:** `ca48d67`

Status: phases A–D implemented and tested locally; see `implementation-status.md`. Nothing is committed. `AGENTS.md` forbids the coding agent from committing or deploying; the founder reviews the diff.

## 1. Audit findings re-verified against current code

| Finding (audit doc) | Verified at | Still true |
|---|---|---|
| Models merged inside provider scores | `lib/scoring/compute.ts:106-140` | Yes |
| No intervals/tests | `lib/confidence.ts`, `lib/reports/deltas.ts` | Yes |
| Global-registry SOV denominator | `db/companies.ts:63-79`, `compute.ts:125` | Yes |
| Domain suffix bug | `lib/parsing/service.ts:162,227,256`, `lib/parsing/classify-llm.ts:250`, `lib/parsing/classify.ts:100`, `lib/gaps/service.ts:209` | Yes (6 sites). `lib/citations/market.ts`, `lib/citations/service.ts` and `lib/sources/classify.ts` are already dot-bounded |
| Instrument copied from newest run anywhere | `lib/markets/bootstrap.ts:206-214`, consumed by `lib/prospects/city-pipeline.ts:505` | Yes |
| Reused captures re-timestamped | `lib/runs/execute.ts:195-205` (insert defaults `requested_at = now()`) | Yes |
| Served model not stored | no reader of `payload.model` | Yes |
| Job leases never renewed; completion not fenced | `db/jobs.ts` | Yes |
| Backup targets local DB | `scripts/backup.sh:15-16` | Yes |

## 2. Canonical implementations (what is reused, not rebuilt)

| Concern | Canonical module | Extension in this build |
|---|---|---|
| Capture | `lib/runs/execute.ts`, `lib/runs/reuse.ts` | `served_model`, `captured_at` columns |
| Parsing | `lib/parsing/service.ts`, `prepass.ts` | `domainBelongsTo`, normalized alias path |
| Scoring | `lib/scoring/compute.ts`, `metrics.ts` | v1.2: per-instrument estimates, cohort, echo |
| Statistics | none existed | **new** `lib/stats/` (pure) |
| Competitors | `competitors` table, `lib/competitors/` | `competitor_cohorts` (frozen versions) |
| Market bootstrap | `lib/markets/bootstrap.ts` | `measurement_instruments` pin |
| Findings | `lib/gaps`, `lib/citations`, `lib/discoverability`, `lib/accuracy` | read by `lib/optimization/plan.ts` |
| Interventions | `lib/attribution/*` | `intervention_plans`, `lib/experiments/evaluate.ts` |
| Engagement lifecycle | `lib/engagements/service.ts` | `lib/onboarding/checklist.ts` (derived state) |
| Reports | `lib/reports/*` | v2 data section (`lib/reports/measurement-v2.ts`) |
| Billing | `billing_events` ledger | read by unit economics |
| Access control | `lib/auth.ts` (`assertProjectAccess`) | organization grants |
| Jobs | `db/jobs.ts`, `workers/core.ts` | lease renewal + fencing |

## 3. Dependency map

```
lib/stats (pure) ──┬─> lib/scoring/estimates ─> score_estimates ─┬─> reports v2 ─> client report
                   │                                              ├─> organization roster
                   └─> lib/experiments/evaluate <─ intervention_plans <─ interventions (existing)
served_model / captured_at ─> instrument key ─┘
competitor_cohorts ─> scoring v1.2 (SOV denominators)
measurement_instruments ─> market bootstrap, onboarding
gap/citation/site/accuracy findings ─> lib/optimization/plan ─> opportunities ─> tasks (existing) ─> interventions
labor_entries + responses.cost_usd + llm_calls + billing_events ─> lib/economics/unit
client_outcomes ─> reports v2, economics
jobs lease renewal ─> every handler
```

## 4. Implementation sequence

| Step | Content | Migration |
|---|---|---|
| A0 | Statistics library + tests | — |
| A1 | Domain boundary + alias normalization + tests | — |
| A2 | `served_model`, `captured_at`; reuse timestamp fix | 126 |
| A3 | `competitor_cohorts`, `measurement_instruments`, `score_estimates` | 127 |
| A4 | Scoring v1.2 (compute + estimates + compatibility rule) + rescore script | — |
| A5 | Pinned instrument in bootstrap | — |
| A6 | Gold annotation workflow (db, lib, page) | 128 |
| B1 | `opportunities` + plan builder + lifecycle + source presence + JSON-LD | 129 |
| B2 | `intervention_plans` + evaluate + learning summary | 130 |
| C1 | Lease renewal + fencing | — |
| C2 | `client_outcomes`, `labor_entries`; onboarding checklist; exceptions; unit economics; scenario model | 131 |
| D1 | `organizations`, entities, grants, roster | 132 |
| D2 | Ops hardening, docs, diligence checklists | — |

## 5. Migration plan

- Every migration is additive: new tables, plus nullable columns on existing tables.
- Every migration has a down section that drops only what it added.
- Insert-only tables reuse `forbid_mutation()` from migration 001.
- No migration rewrites or backfills an immutable row.
- Old rows get `served_model` and `captured_at` resolved on read (`coalesce(captured_at, requested_at)`).
- Production apply order is 126 → 132, followed by `scripts/rescore.ts --version v1.2` (read-only against raw tables; insert-only into `scores` and `score_estimates`). This is a deployment step that needs the founder's approval.

## 6. Critical invariants

1. v1.1 rows are byte-identical before and after (integration test).
2. Raw tables are never updated.
3. No unlabeled blend: v1.2 per-provider rows exist only for single-instrument providers.
4. Intervals and classifier confidence are distinct names. Docs and the UI say "95% interval (statistical)" and "classifier confidence".
5. Bootstrap results are reproducible: seed = hash of (run, company, metric).
6. Deny-by-default for portal and organization surfaces.
7. Human gates are unchanged: opportunity approval, plan approval, report publish and every send.

## 7. Integration contracts

- **`computeScores(runId)`.** Unchanged signature. It now writes `scores` (v1.2) and `score_estimates`. It is idempotent: `on conflict do nothing`.
- **`estimateRate(clusters, seedKey)`.** Returns `{ k, n, prompts, wilson: [lo, hi], bootstrap: [lo, hi] }`.
- **`buildOptimizationPlan(user, projectId)`.** Returns `ActionResult<{ created, unchanged, total }>`. Existing statuses are preserved.
- **`evaluateIntervention(interventionId)`.** Pure over loaded rows, so it is never stored and always reproducible.
- **`unitEconomics({ projectId?, from, to })`.** Each value carries `source: measured | ledger | not_recorded`.

## 8. Test strategy

- **Unit:** stats known answers; domain/alias matching; served-model extraction; v1.2 instrument grouping (pure); opportunity dedupe keys; JSON-LD templates; experiment evaluation with a simulated effect; scenario model; lease fencing logic.
- **Integration (real Postgres):** scoring v1.2 end to end; v1.1 immutability; cohort denominators; reuse captured_at; pinned instrument; gold annotation metrics; opportunity lifecycle; plan immutability; outcome capture; unit economics; organization isolation; job fencing; a synthetic client lifecycle rehearsal.
- **Migration:** the existing down/up loop (`scripts/migrate.ts`).

## 9. Operational risks

| Risk | Mitigation |
|---|---|
| Dashboards empty after the version bump until rescore runs | The rescore script is part of the deploy runbook. Readers pin `SCORING_VERSION`, so the switch is atomic once rescored |
| Rescore cost | None: no provider calls; it reads immutable rows only |
| Cohort freezing changes SOV values | It is a new version only. Old values stay; the change is documented in docs/06 |
| Wider CIs look worse | Intended (Principle 7) |

## 10. Effort (estimate) and definition of done

| Phase | Effort | Done when |
|---|---|---|
| A | largest | Spec 151 acceptance (A) tests pass; docs/06 updated |
| B | medium | Plan and plan-evaluation tests pass; simulated effect recovered |
| C | medium | Rehearsal test runs a synthetic client through onboarding → baseline → plan → intervention → report data |
| D | small | Organization isolation test passes; ops docs current |

Anything not finished is listed in `implementation-status.md`.
