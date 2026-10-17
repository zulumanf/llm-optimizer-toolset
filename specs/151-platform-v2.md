# Spec 151 — Platform v2: measurement validity, optimization plan, controlled interventions, client operations, unit economics, brokerage foundation

Status: in progress (branch `feat/151-platform-v2`) · Owner: founder · Source: `docs/strategy/acquisition-readiness/` (2026-10-16) and the founder's platform-build brief of 2026-10-16.

Build plan: `docs/engineering/rf-platform-build-plan.md`. Status: `docs/engineering/implementation-status.md`.

## Why

The acquisition-readiness audit found that provenance is strong but the inference layer is weak. Specifically:
- There are no uncertainty estimates.
- Models are merged inside one provider score.
- The share-of-voice denominator is the global registry.
- Own-domain matching uses a suffix with no dot boundary.
- The measurement instrument for a market is copied from the last run anywhere.
- Reused captures are re-timestamped.
- The served model is never recorded.

On top of measurement, there are four further gaps:
- No single, auditable optimization plan joins the existing finding engines.
- Interventions have no pre-registration or controls.
- Delivery has no labor or cost instrumentation.
- The customer model has no organization (brokerage) layer.

## Scope (milestones)

### A. Measurement v2 (scoring version `v1.2`)

A1. **Instrument identity.** An instrument is `(provider, requested model id, search mode, location context, sampling)`. The requested model id already encodes the snapshot and the `+search` mode.
- `responses.served_model` is extracted from the provider payload at capture. Old rows are resolved on read by the same pure function.
- `responses.captured_at` holds the time the answer was actually produced. For reused rows it is the source capture's time.

A2. **Per-instrument estimates.** A new insert-only table `score_estimates` is keyed by `(run, company, metric, instrument_key, scoring_version)`. Each row carries:
- numerator, denominator and distinct prompts
- the Wilson 95% interval
- the prompt-clustered bootstrap 95% interval (seeded, so it is reproducible)
- the frozen cohort version used

A3. **No silent blending.**
- Under `v1.2`, a provider-level row in `scores` is written only when that provider ran exactly one instrument in the run.
- The `all` row is the unweighted mean over instruments and is labelled as an aggregate.
- `v1.1` rows are never touched.

A4. **Echo exclusion.** Core v1.2 rates exclude answers to prompts that name the company: an organic denominator per company, using the same whole-word rule as the parser. The excluded count is stored.

A5. **Frozen competitor cohorts.**
- `competitor_cohorts` is versioned and insert-only.
- When a project has a cohort, v1.2 scores only cohort companies and uses the cohort as the share-of-voice denominator.
- Without a cohort, v1.2 behaves as v1.1 and records `cohort_version_id = null`.
- Freezing a baseline (`freezeBaseline`) freezes a cohort if none exists.

A6. **Domain boundary fix.** `domainBelongsTo(host, ownerDomain)` is the one canonical rule: an exact host or a dot-bounded subdomain. All owner-attribution call sites use it. v1.2 also recomputes owned citations at scoring time with this rule, so historical mention rows score correctly without being edited.

A7. **Alias normalization.** Matching folds `&`/`and`, possessives and punctuation. The canonical form is used only as an additional match path after the exact match. Precision fixtures pin the trade-off.

A8. **Pinned instruments.**
- `measurement_instruments` pins one instrument config per project, versioned and insert-only.
- The market bootstrap pins a named default (`DEFAULT_MEASUREMENT_INSTRUMENT`) instead of copying the newest run anywhere.
- An existing pin is reused.

A9. **Statistics library.** `lib/stats/` is pure, has known-answer tests, and contains:
- Wilson interval
- seeded PRNG
- prompt-clustered bootstrap for a rate
- paired prompt-level difference with a bootstrap CI
- difference-in-differences with a bootstrap CI
- an intraclass correlation (ICC) estimate
- the design-effect minimum detectable effect (MDE)

A10. **Rescoring.**
- `scripts/rescore.ts` computes `v1.2` for historical runs from immutable rows and is idempotent.
- `computeScores` writes both the compatibility rows and the estimates.

A11. **Classifier validation workflow.**
- `gold_annotations` stores human labels on real captured `(response, company)` pairs, one row per annotator, insert-only.
- Includes stratified sampling, disagreement listing and adjudication.
- Precision and recall are computed only over pairs with an adjudicated or unanimous human label.
- An operator page is provided. No labels are fabricated, and no human validation is claimed without one.

### B. Optimization and experimentation

B1. **Unified opportunities.** The `opportunities` table and `lib/optimization/plan.ts` compose existing findings rather than reimplementing them:
- gap findings
- citation opportunities
- technical site findings
- accuracy findings

Opportunity lifecycle:
- Each opportunity has a deterministic `dedupe_key` and the lifecycle `proposed → approved → in_progress → implemented → measuring → closed | dismissed`.
- Every transition is audited.
- Approval requires a human.
- The plan is regenerated idempotently: existing keys keep their status.

B2. **Source presence.**
- For each client, this produces the market's most-cited domains (from the client's own answer citations), marked as citing competitors, citing the client, or neither.
- "Citation frequency" is labelled as such and is never called influence.

B3. **Structured data templates.**
- JSON-LD for `RealEstateAgent`, `Person` and `Organization` is generated deterministically from approved claims only.
- A missing fact means the field is omitted.

B4. **Intervention pre-registration.**
- `intervention_plans` is versioned and becomes immutable once approved. It stores the hypothesis, target intent and prompts, instrument key, primary metric, expected direction, MDE, measurement schedule, controls (control prompt ids, control company ids) and known confounders.
- A change is a new version.

B5. **Outcome evaluation.**
- `lib/experiments/evaluate.ts` produces the estimate, CI, sample sizes, comparability, an evidence tier (1 descriptive, 2 matched comparison, 3 pre-registered controlled, 4 staggered/randomized), confounders and cost.
- Verdicts are: `improvement_observed | no_detectable_change | negative_change_observed | inconclusive | not_comparable`.
- A simulated fixture recovers a known effect.

B6. **Cross-client learning view.** Descriptive summaries grouped by intervention type, entity level, instrument and evidence tier. No predictive model.

### C. Client operations and unit economics

C1. **Onboarding orchestrator.** `lib/onboarding/` composes the existing engagement service. A checklist state is derived from records, with one next action per step. It pins the instrument, freezes the cohort and schedules two baseline waves.

C2. **Job lease renewal.** While a handler runs, its job lease is renewed. Completion and failure are fenced by `locked_by`, so a reclaimed job cannot be completed by its old worker.

C3. **Exceptions view.** One read model covers:
- failed runs and failed jobs
- overdue retests
- expired approvals
- pending reviews
- spend over budget
- stale reports
- connector failures

C4. **Client outcomes.** `client_outcomes` is manual, insert-only and labelled `self_reported` or `client_system_export`. It covers leads, inquiry source, AI-discovery mentions, referral sessions and closed transactions (only when the client volunteers them).

C5. **Labor ledger and cost attribution.** `labor_entries` records minutes per activity per project and engagement. The unit-economics read model includes:
- inference cost by project from `responses` and `llm_calls`
- labor hours
- revenue from the existing billing ledger
- contribution margin, labelled as contribution margin

C6. **Scenario model.** Pure functions with the assumptions passed in explicitly. The model shows what 50–60% EBITDA would require at $0.5M, $1M, $2M and $3M revenue. Every output is labelled hypothetical.

C7. **Monthly report v2 data.** Per-instrument rows with CIs, the MDE, intervention verdicts, client outcomes and next actions. It reuses the report draft and publish gates (human sign-off is unchanged).

### D. Strategic foundations

D1. **Organizations.**
- `organizations` (kind `brokerage`), `organization_entities` (organization → company, with level) and `organization_grants` (user → organization, read-only).
- The roster read model returns the latest v1.2 estimates per member entity, only for authorized users.
- No RealTrends fields appear.

D2. **Operations hardening.**
- The backup script takes `DATABASE_URL` and prunes encrypted files.
- A `.dockerignore` is added.
- Tracked prospect contact files are moved out of the index. The files are kept locally and history is not rewritten.
- `tmp-run-followups.mts` is removed.

D3. **Documentation and legal diligence checklists.** No legal conclusions.

## Non-goals

- Deploying anything.
- Applying migrations to production.
- Sending email.
- Making live billing calls.
- Scraping consumer UIs.
- Adding a graph database.
- Adding new agents.
- Introducing new dependencies.
- Building a predictive model of intervention effects.
- Making licensed RealTrends data visible to customers.

## Invariants

1. `responses`, `mentions`, `scores`, `score_estimates`, `competitor_cohorts`, `measurement_instruments`, `gold_annotations`, `client_outcomes` and approved `intervention_plans` are insert-only or immutable by trigger.
2. `v1.1` scores remain byte-identical after any v1.2 computation.
3. No score row blends two instruments without being labelled as the `all` aggregate.
4. Statistical intervals and classifier confidence are separate fields with separate names.
5. Every client-visible surface is deny-by-default (`assertProjectAccess`, organization grants).
6. Public numbers still come only from `lib/marketing/approved-claims.json`.

## Acceptance

- Typecheck, lint and the full vitest suite pass, apart from failures already present on the base branch, which are documented.
- Every new migration has a reversible down section that has been exercised by the migration test.
- Known-answer tests cover the Wilson interval, the bootstrap (reproducible with a seed), DiD effect recovery and the MDE.
- Integration tests cover:
  - per-instrument scoring
  - v1.1 immutability
  - cohort denominators
  - reuse timestamps
  - the pinned instrument
  - the opportunity lifecycle
  - plan immutability
  - outcome capture
  - unit economics
  - organization isolation
  - lease fencing
