# Offline evaluation framework — RF Adaptive Intervention Engine

Status: **framework implemented and tested locally; no real predictions or outcomes exist yet.**
Code:
- `lib/experiments/prediction-scoring.ts` (pure scoring)
- `lib/experiments/predictions.ts` (recording and evaluation)
- migration `133_intervention_predictions.sql`

## Purpose

Before any engine is allowed to *recommend* interventions adaptively, it must show, on real history, that its predictions beat doing nothing. This framework is the scoreboard. It:
- records predictions **before** a change ships;
- compares them with what the evaluator later **observes**;
- says plainly how much (or how little) can be concluded.

It never trains a model, never uses synthetic outcomes, and never calls an observed change a causal effect.

## Reused tables

| Concept | Table |
|---|---|
| What to try | `opportunities` (spec 151 B1) |
| What will be measured, against what controls, on which instrument | `intervention_plans`: pre-registered, frozen on approval |
| What shipped and when | `interventions` (`shipped_at`) |
| Before/after waves | `intervention_runs` + `runs` / `responses` / `mentions` |
| Observed outcome | `evaluatePlan()`: verdict, estimate, interval, evidence tier, comparability. Computed on read, never stored |
| **New:** what was predicted, by which predictor, when | `intervention_predictions` (insert-only) |

One new table only. A prediction belongs to a plan, so it inherits the plan's primary metric, expected direction, instrument, controls and design.

## A prediction

The point prediction and its interval are **absolute changes** in the plan's primary metric on its instrument.

| Field | Meaning |
|---|---|
| `predicted_change` | Point prediction of the evaluator's estimate (paired or DiD, per the plan) |
| `predicted_low`, `predicted_high`, `interval_level` | Predictive interval, 80% by default |
| `probability_improvement` | Probability the evaluator will report `improvement_observed` |
| `basis` | `no_change_baseline`, `descriptive_prior`, `rule` or `human` |
| `features`, `rationale` | What the predictor looked at, stored with the prediction for audit |

**Timing rule.** `recordPrediction` refuses once the plan's change has shipped. The evaluator also marks any prediction created at or after `shipped_at` as `late`, and late predictions are never scored. Hindsight cannot enter the scoreboard.

## Benchmarks recorded automatically at plan approval

1. **`no-change-v1`**: predicts 0 (±0.10, P(improvement) = 0.5). Every other predictor is judged relative to it.
2. **`descriptive-prior-v1`**: the median and 10th–90th percentile of past **real, comparable, tier ≥2** evaluations for the same intervention type on the same instrument, with a Laplace-smoothed P(improvement).
   - It makes **no prediction** with fewer than 5 such evaluations.
   - It reads history; it does not train.

## Scoring

| Status | Rule |
|---|---|
| `scored` | Comparable outcome with an estimate, real data, recorded before shipping |
| `pending` | No linked intervention yet |
| `not_comparable`, `no_estimate`, `late`, `synthetic` | Counted and shown, never scored |

**Synthetic** means any baseline or post wave contains mock-provider answers, or the project is `internal` or `sentinel`.

Per scored pair:
- absolute error |predicted − estimate|;
- interval coverage;
- direction agreement (null when either value is 0);
- Brier score of P(improvement) against whether the verdict was `improvement_observed`.

Per predictor:
- mean absolute error, interval coverage, direction accuracy, Brier score, and calibration bins;
- **all withheld below 10 scored pairs** (`MIN_SCORED_PAIRS`), with the counts still reported.

## What this does not claim

- An evaluator estimate is an association under the plan's design. Tier 3/4 designs (pre-registered with controls, or staggered) support stronger statements than tier 1/2, but none is proof of cause. Report the tier next to any score.
- Small samples: a predictor beating the baseline on 10 pairs is weak evidence. Compare Brier scores with a paired bootstrap over plans before promoting anything (future work, once data exists).
- Selection: plans are not random samples of interventions. A predictor that looks good on what operators chose to try may not generalize.

## Promotion gate for any future adaptive predictor

All of the following must hold:
1. At least 30 scored real pairs across at least 5 clients.
2. Brier score and MAE better than `no-change-v1` on the same pairs, with a paired-bootstrap 95% interval excluding zero.
3. 80% intervals covering 70–90% of the time (calibrated, not just accurate).
4. No use of synthetic or late rows anywhere in its inputs (enforced in code).
5. A human-reviewed DECISIONS entry. The output stays decision support: plan approval remains human.

## Verification

- `tests/unit/prediction-scoring.test.ts`: eligibility, known-answer scores, withholding, calibration, the prior's refusal below 5 and its quantiles.
- `tests/integration/intervention-plans.test.ts`: approval records the benchmark; a post-shipping prediction is refused; the evaluation reports pairs, not aggregates, at n = 1; predictions are insert-only.
- **Rehearsal data is mock, so it is always classified `synthetic` and never scored.**
