# Measurement v2 (scoring v1.2) — spec 151 milestone A

Methodology summary for readers of numbers: `docs/06-scoring-methodology.md`. This document explains the implementation.

## What changed and why

| Audit defect (strategy doc 03 §2.2) | Fix | Where |
|---|---|---|
| M1 no uncertainty | Wilson and prompt-clustered bootstrap intervals on every binomial rate | `lib/stats/index.ts`, `lib/scoring/estimates.ts` |
| M2 fixed 10-point change rule | Paired prompt-level difference with bootstrap CI; difference-in-differences for interventions; MDE with design effect | `lib/stats`, `lib/reports/measurement-v2.ts`, `lib/experiments/evaluate.ts` |
| M3 models merged within provider | Per-instrument `score_estimates`; provider rows in `scores` only when one instrument | `lib/scoring/estimates.ts` |
| M4 global-registry SOV denominator | Versioned `competitor_cohorts`, frozen at baseline (also by `freezeBaseline` and onboarding) | `lib/measurement/service.ts`, `db/measurement.ts` |
| M5 domain suffix bug | `domainBelongsTo` (dot boundary), used at all six former call sites and at scoring time | `lib/parsing/prepass.ts` |
| M6 instrument copied from newest run anywhere | `measurement_instruments` pin per project. First pin = the project's OWN latest completed run, else `DEFAULT_MEASUREMENT_INSTRUMENT` (overridable for first pins by validated JSON in `MEASUREMENT_DEFAULT_INSTRUMENT`, recorded in the pin's reason) | `lib/measurement/*`, `lib/markets/bootstrap.ts` |
| M7 served model / reuse timestamp | `responses.served_model` extracted at capture; `responses.captured_at` = the source's time for reused captures | `lib/ai/served-model.ts`, `lib/runs/execute.ts`, `lib/runs/reuse.ts` |
| M8 synthetic 13-case gold set | Blind human annotation of real captured answers, adjudication, precision/recall with Wilson CIs, Cohen's kappa | `lib/evaluation/*`, `/evaluation` |
| M9 exact-alias recall | Normalized second match path (`&`/`and`, possessives), multi-token terms only. Sentence ends, commas, colons and line breaks are HARD boundaries; the domain-continuation guard is kept. New mention rows are stamped `matcher_version = entity-matcher-v2` (parser labels unchanged, because class-first precedence keys on them) | `lib/parsing/prepass.ts`, `mentions.matcher_version` |
| M10 echo in core rates | Organic scope in `score_estimates` (`excluded_echo` stored); `scores` keeps the v1.1 scope | `lib/scoring/estimates.ts` |
| M11 rescoring no-op | `scripts/rescore.ts` writes the current version forward, idempotently, with no events and no provider calls | `scripts/rescore.ts` |

## Instrument identity

`instrumentKey = provider | requested model | location context | sampling`

- **Requested model.** The id encodes the snapshot and search mode (`+search`).
- **Location context.** Always `prompt_text_only`: no adapter sends a user location. Geography is in the prompt.
- **Sampling.** Read from `request_params.sampling`; every adapter is `provider_default` today.
- **Served model.** Stored as `served_models[]` on each estimate, not as part of the key. A served-model change makes intervention and report comparisons `not_comparable` rather than splitting the key.

## Tables (migration 126)

| Table | Rows | Mutability |
|---|---|---|
| `responses.served_model`, `.captured_at` | new nullable columns; historical rows resolve on read | insert-only (unchanged) |
| `measurement_instruments` | one versioned provider config per project | insert-only |
| `competitor_cohorts` | one versioned company set per project | insert-only |
| `score_estimates` | per (run, company, metric, instrument, scoring version): numerator, denominator, distinct prompts, excluded echo, rate, Wilson low/high, clustered low/high, ICC (mention rate), cohort id, served models | insert-only |

## Statistics (`lib/stats`)

Pure functions with known-answer tests (`tests/unit/stats.test.ts`).

| Function | Purpose |
|---|---|
| `wilsonInterval` | Wilson score interval |
| `estimateRate` | Rate with Wilson interval plus a prompt-clustered percentile bootstrap (2,000 draws, seeded); null below 5 prompts |
| `pairedDifference` | After − before over shared prompts, prompts resampled as pairs |
| `differenceInDifferences` | Treated Δ − control Δ |
| `estimateIcc` | ANOVA estimator for binary clustered data |
| `designEffect` | Design effect from the ICC |
| `minimumDetectableEffect` | Two waves, α 0.05, power 0.8 |

Seeds come from `seedFromKey(run|company|metric|instrument)`, so a recomputation is byte-identical.

## Classifier validation

1. Draw a sample at `/evaluation`. It is seeded and stratified by provider × classifier label, and includes rejected pairs as hard negatives. Mock answers are excluded.
2. Two staff members label each pair blind; the classifier label is never sent to the page.
3. Disputes need an adjudication with a reason.
4. Precision and recall count only unanimous (≥2 annotators) or adjudicated pairs. Single-annotator pairs are reported separately and never counted.

No labels exist yet; the workflow is built, but no human validation has happened. Adjudication is available as a server action (`adjudicateItemAction`); a dedicated UI is a follow-up.

## Cohort used by a run

`cohortForRun`: the latest cohort frozen at or before the run **started**.
- Rescoring an old run never applies a later cohort.
- A baseline run that predates `freezeBaseline` keeps the project universe, so its share-of-voice denominator differs from later cohort runs. Compare share of voice only between runs with the same `cohort_id`.
- Rates other than share of voice are unaffected.

## Compatibility and rollout

- `SCORING_VERSION` is now `v1.2`. Readers pin the version, so a run shows no current-version scores until it is rescored. **This includes audit generation and prospect benchmarks over existing market runs** (`lib/prospects/benchmark.ts`), so the rescore must complete BEFORE the new web build takes traffic.
- Production rollout:
  1. Apply migrations 126–131.
  2. Deploy.
  3. `npx tsx scripts/rescore.ts` (dry run) → `--apply`.

  See `production-readiness.md`.
- Public numbers are unaffected. `lib/marketing/approved-claims.json` and `scripts/marketing-claims-verify.ts` recount from raw rows with their own eligibility rules.
- The prospect send gates and the evidence release (`verifyEvidenceRelease`) count raw rows directly and do not read `scores`.

## Known limitations

- `scores` (compatibility) and `score_estimates` (organic) have different answer scopes by design. The run page labels the estimates table.
- Core trend views (`db/dashboard.ts`) still read `scores`. Moving dashboards to estimates is next-step work.
- Gemini grounding redirect URIs are still unresolved (Gemini is not in production).
- Normalization does not handle nicknames or name-order variants. Recall beyond aliases still depends on the release-time alias sweep.
