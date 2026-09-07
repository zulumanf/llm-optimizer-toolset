# Spec 097 — City Prospecting Pipeline ("run prospecting in X city, A→Z")

**Status:** In progress
**Branch:** `feat/097-city-pipeline`
**Source:** Operator request 2026-08-20: one chat command runs the whole
prospecting flow for a city — RealTrends-focused Perplexity research seeds
the prospect list, the LLM benchmark measures who the assistants actually
recommend, scoring and findings follow — without babysitting each step.

## Architecture: a tick-driven state machine, not a chat marathon

A benchmark run takes minutes; a chat turn does not. The pipeline is a
durable row (`city_prospecting_pipelines`, migration 089) the worker's tick
advances step by step — idempotent, logged, resumable — kicked off by ONE
confirm-gated assistant tool whose confirmation states the city, the
prospect target, and the **budget ceiling** the run may not exceed.

States: `installing → discovering → seeding → benchmarking → running →
scoring → completed | failed`. Each step composes an existing, tested
service; the pipeline owns ordering and state, never business logic:

1. **installing** — launch exists? else `draftMarketPack` →
   `installMarketPackDraft` (idempotent since #105).
2. **discovering** — `runProspectDiscovery` (Perplexity; segment defaults to
   "highest-performing and RealTrends-ranked teams"; limit = target × 2).
3. **seeding** — candidates with confidence ≥ 0.7 auto-approve into
   prospects (`reviewDiscoveryCandidate`); ambiguous/low-confidence stay
   staged for human review, counted in the log. Each new prospect's company
   is tracked as a competitor on the benchmark project.
4. **benchmarking** — `bootstrapMarketBenchmark`; estimate the run; refuse
   (→ failed, with the numbers) if the estimate exceeds the confirmed
   budget; else `startRun` with that budget as its hard cap.
5. **running** — wait for `runs.status = completed` + scores present.
6. **scoring** — per prospect: `linkBenchmark` → `computeProspectScore` →
   `generateFindings`. Findings are candidates — approval stays human.
7. **completed** — the log states what exists and what awaits review.

## The human-gate ledger (PRINCIPLES #8 accounting)

- **One confirm at kickoff** authorizes: internal artifact creation
  (market, launch, prospects from high-confidence candidates, prompts) and
  ONE benchmark run within the stated budget. Recorded in the audit log.
- **Auto-approved prospects** are internal, reversible (archive), and
  provenance-stamped; the 0.7 threshold is a named constant and a recorded
  decision. Everything external — findings approval, audit publish,
  outreach — keeps its existing gates untouched.
- A pipeline never sends, publishes, or spends beyond its confirmed budget.

## Assistant surface

- `run_city_prospecting` (confirm tier): city, state, target_prospects,
  budget_usd — the confirm card reads "Run A→Z prospecting for {city}:
  up to ~{target} prospects, one benchmark run ≤ ${budget}".
- `get_city_prospecting` (read): status + step log for a city/pipeline —
  "how's Wilmington going?" answered from the row.

## Acceptance criteria

- [ ] State machine walks A→Z on a seeded city with the mock provider and
      mock discovery source (integration test): prospects exist, run
      completed, scores computed, findings staged; log names each step.
- [ ] Budget refusal: an estimate above the ceiling fails the pipeline with
      the numbers, starts nothing (test).
- [ ] Low-confidence candidates stay staged; only ≥ 0.7 auto-approve (test).
- [ ] Kickoff is confirm-gated through the assistant; the pending-action
      summary states city, target, and budget (test).
- [ ] Tick lane is isolated (a pipeline failure never fails dispatch) and
      idempotent (re-advancing a completed pipeline is a no-op).
- [ ] Migration 089 reversible; lint, typecheck, full suite green.
