# Spec 067 — Retest Context: Provider Consistency + Agreement in One View

## Why

Specs 062 and 066 each shipped half of the sentence an operator needs when
reading a retest: 062 grades whether baseline and post are comparable at
all; 066 reads whether the assistants agree about a company on a run. But
the intervention detail page still shows a verdict ("notable, +0.14") with
no view of WHICH assistants moved — the per-provider deltas are computed
inside `computeVerdicts` and thrown away after feeding the noise rule. A
lift carried by one provider while two others declined renders identically
to a lift consistent across all of them, and those are different findings.

## What

### 1. Per-provider movement on every verdict (`retest-context-v1`)

`MetricVerdict` gains `providers`: for each provider measured on both sides
(rate metrics only, matching the docs/06 change-detection scope):

- `delta` (post − pooled baseline, that provider only),
- `movement`: `improved` / `declined` / `within_noise` using the one
  existing threshold (`NOTABLE_DELTA`), or `insufficient` when either side
  has `N < MIN_N_PER_SIDE` — the same constants the aggregate verdict uses,
  never a second definition,
- plus a derived `providerSummary` string ("improved on 3/4 providers,
  within noise on 1") and `consistent`: true when every provider that moved
  notably moved in the headline direction.

Pure, computed where the data already flows (`computeVerdicts`); additive
fields, existing consumers unchanged.

### 2. Post-run agreement for the subject

`interventionView` gains `postRunAgreement`: the subject company's
model-agreement row (spec 066) for the latest completed post run — its
label and counted summary ("mentioned on 2/2 eligible providers"). One
loader call, derived on read; null when no post run has completed.

### 3. One view on the detail page

The Verdicts table gains a Providers column (movement counts, per-provider
deltas in the title text). Rows whose post run graded below `high`
comparability carry the grade inline next to the verdict — the 062 grade
and the movement read side by side, so "high-comparability and consistent
across 3/4 assistants" (or its unhappy inverse) is one glance. The
post-run agreement line renders above the table when present.

No causal language anywhere: consistency describes where the movement
happened, never why.

## Testing

- Unit (`verdict.ts` fixtures): per-provider movement bands, insufficient
  exclusion, consistency true/false against headline direction, summary
  strings, non-rate metrics carrying no provider read.
- Integration (attribution suite): the scheduled-post-run test asserts
  verdicts carry the mock provider's movement and the view returns
  `postRunAgreement` for the subject.

## Acceptance criteria

- [ ] Every rate-metric verdict exposes per-provider deltas + movement
      using the existing NOTABLE_DELTA / MIN_N_PER_SIDE constants.
- [ ] Detail page shows movement counts beside each verdict and the
      comparability grade inline where it is below high.
- [ ] `postRunAgreement` renders the subject's counted agreement summary
      for the latest completed post run.
- [ ] Lint, typecheck, full suite green. No schema changes.

## Out of scope

Agreement history across retests, provider-level verdicts in reports/
portal, alerting on single-provider-carried lifts (attention-queue slice
later if operators want it).
