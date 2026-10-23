# Intervention experiments — spec 151 milestone B

Goal: build evidence about which interventions change AI recommendations, under which conditions, at what cost. The system must never confuse association with cause.

## Lifecycle

```
opportunity (approved) ──> intervention_plans (draft) ──approve──> FROZEN
                                                        │
                       interventions (what shipped) <───┘ link once
                                │
                     intervention_runs post waves (+2w/+6w/+12w, existing scheduler)
                                │
                   evaluatePlan() — computed on read, never stored
```

## Pre-registration (`intervention_plans`, migration 129)

| Field | Content |
|---|---|
| hypothesis, intervention_type | What change is expected and what kind of intervention it is |
| entity_company_id | The entity measured |
| target_intent, target_prompt_ids | Treated prompts |
| control_prompt_ids, control_company_ids | Controls; must not overlap with targets, and the entity cannot be its own control |
| instrument_key | The single instrument the verdict is computed on |
| primary_metric, expected_direction, mde | Pre-stated metric, direction and minimum detectable effect |
| design | `descriptive` / `matched_comparison` / `preregistered_controlled` / `staggered` |
| planned_implementation, measurement_schedule, known_confounders | What will ship, when it is re-measured, what could confound it |
| baseline_run_ids, estimated_cost_usd, opportunity_id | Baseline waves, expected cost, source opportunity |

Approval rules:
- Approval requires at least one finished baseline run.
- Two waves at least 6 days apart are required, unless the approver records why one wave is acceptable. The reason is stored as a confounder.

The `intervention_plan_guard` trigger:
- forbids DELETE;
- freezes every column of an approved plan;
- allows only two changes: linking `intervention_id` once, and retiring the plan (`superseded` / `withdrawn`).

Revisions create version n+1 under the same `plan_key`, and supersede the old version.

## Estimators (`lib/experiments/evaluate.ts`)

Every Δ is a paired prompt-level difference; intervals are prompt-clustered bootstraps.

| Available control | Estimator |
|---|---|
| Control prompts | DiD: Δ(entity, treated) − Δ(entity, control prompts) |
| Control entities | DiD: Δ(entity, treated) − Δ(control entities, treated) |
| None | Paired before/after (descriptive) |

## Evidence tiers

| Tier | Meaning |
|---|---|
| 1 | Descriptive before/after (no controls) |
| 2 | Matched comparison, but the plan was not approved on or before the ship day |
| 3 | Pre-registered controlled analysis |
| 4 | Declared staggered design + pre-registration + controls. The rollout order is not verified by code; the label records the declared design |

## Verdicts

| Verdict | Condition |
|---|---|
| `not_comparable` | Any of: no baseline or post wave on the instrument; the served model changed; a post wave started before shipping |
| `improvement_observed` / `negative_change_observed` | CI excludes 0 (sign relative to `expected_direction`) |
| `no_detectable_change` | The whole CI lies inside (−MDE, +MDE): an equivalence result |
| `inconclusive` | CI too wide, or too few prompts |

The explanation always ends "An association under this design, not proof of cause."

## Confounders tracked

- Single baseline wave
- Not pre-registered
- Served-model change
- Declared confounders on the plan
- The existing overlap rule: interventions within 84 days on the same version are flagged by `lib/attribution`
- Competitor activity and index changes, absorbed by control prompts and entities. A cross-market sentinel control is not wired yet

## Learning across clients

`learningSummary` (staff only) groups evaluations by intervention type × instrument × evidence tier:
- It reports verdict counts.
- It reports a median estimate only when a group has ≥5 evaluations (`MIN_EVALUATIONS_FOR_SUMMARY`).
- There is no predictive model; hierarchical pooling waits for real data. Strategy doc 03 §4.3 gives the thresholds.

## Verification

- `tests/unit/experiment-evaluate.test.ts`: on simulated panels,
  - a +25-point effect is recovered inside the interval;
  - five null seeds are never called improvements;
  - a negative effect is detected;
  - tier downgrades and comparability refusals behave as specified.
- `tests/integration/intervention-plans.test.ts`: over real Postgres,
  - freeze, link and revise;
  - a constructed +0.5 DiD is evaluated exactly.
- `tests/integration/client-lifecycle-rehearsal.test.ts`: the mock answers identically before and after, and the system reports a zero estimate, not an improvement.

No real client outcome exists. Nothing has been inserted into production data.

## Not done

- A UI for drafting plans: today it is the service action, and the Optimize page lists plans.
- Wiring migration-115 columns (`control_company_id`, `changed_url`): superseded by `intervention_plans`; the 115 columns stay unused.
- Sentinel-panel controls.
- Persisted evaluation snapshots for reports. Reports store the evaluation in the frozen report body at draft time.
