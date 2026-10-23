# RF platform architecture after spec 151

One Next.js app, one Postgres database, one queue worker (now multi-worker safe). There are no new services, no new dependencies, no graph database and no new agents.

## The loop and where each step lives

| Step | Canonical module | Data |
|---|---|---|
| Discover (measure) | `lib/runs/execute.ts`, `lib/runs/reuse.ts`, `lib/ai/*` | `responses` (+ `served_model`, `captured_at`) |
| Pin the instrument | `lib/measurement/service.ts` | `measurement_instruments` |
| Parse | `lib/parsing/*` (`domainBelongsTo`, normalized alias matching) | `mentions`, `response_citations` |
| Score | `lib/scoring/compute.ts` → `lib/scoring/estimates.ts` → `lib/stats` | `scores` (compatibility), `score_estimates` |
| Freeze the cohort | `lib/measurement/service.ts` | `competitor_cohorts` |
| Validate the classifier | `lib/evaluation/*`, `/evaluation` | `gold_*` |
| Diagnose | `lib/gaps`, `lib/accuracy`, `lib/discoverability`, `lib/citations` (unchanged) | finding tables |
| Prioritize | `lib/optimization/plan.ts` | `opportunities`, `opportunity_events` |
| Execute (human-gated) | existing tasks, content, profile corrections; `lib/optimization/jsonld.ts` | `tasks`, … |
| Verify / measure | `lib/attribution` (retests), `lib/experiments` | `interventions`, `intervention_plans` |
| Learn | `lib/experiments/evaluate.ts#summarizeLearning` | computed on read |
| Report | `lib/reports/*` + `measurement-v2.ts` | `reports.body.measurement` |
| Operate | `lib/onboarding`, `lib/operations/exceptions.ts`, `lib/economics` | `client_outcomes`, `labor_entries` |
| Distribute | `lib/organizations/service.ts` | `organizations`, `organization_*` |

## Relational evidence graph (no graph database)

```
prompt_set_versions ─ runs ─ responses(served_model, captured_at) ─ mentions ─ companies ─ competitor_cohorts
                         │            └─ response_citations(domain) ─ source_presence_checks
                         └─ score_estimates(instrument_key, CI, cohort_id)
gap/site/accuracy findings, citation_opportunities ─ opportunities ─ tasks
opportunities ─ intervention_plans(frozen) ─ interventions ─ intervention_runs(baseline/post) ─ runs
client_outcomes, labor_entries, billing_events ─ projects ─ organization_entities ─ organizations
```

Every join is a bounded number of hops over indexed foreign keys. Provenance runs from every derived row back to immutable raw rows plus versions (scoring, parser, builder, evaluator, template).

## Invariants and their enforcement

| Invariant | Enforced by |
|---|---|
| Raw answers, scores, estimates, cohorts, pins, gold labels, outcomes and labor are insert-only | `forbid_mutation` triggers (migrations 003, 052, 126, 127, 130) |
| Approved experiment plans are frozen | `intervention_plan_guard` (129) |
| v1.1 scores are never touched | Unique key includes the version; tested in `measurement-v2.test.ts` |
| No blended instrument rows | `computeEstimates` rule; tested |
| Statistical interval ≠ classifier confidence | Separate columns and labels (`INTERVAL_LABEL`) |
| Client and brokerage surfaces are deny-by-default | `assertProjectAccess`, `assertOrganizationAccess`; tested |
| Human approval for public claims, outreach, website changes and publishing | Opportunity approval requirements, existing send and publish gates (unchanged) |
| Jobs complete once | Lease renewal + fenced completion; tested |

## Deliberately unchanged

- Prospecting and outreach (spec freeze per the strategy docs).
- The automation and workflow runtime.
- The knowledge layer.
- The video pipeline.
- The assistant.

The duplicate `content_production_v2` automation remains. It does not run the deterministic citation validator, so it is bounded only by its two human approvals. The migration plan is in `implementation-status.md`.
