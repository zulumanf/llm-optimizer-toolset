# Spec 060 — Citation Acquisition Engine

**Status:** In progress
**Branch:** `feat/060-citation-acquisition`
**Principle:** This is not backlink building. The engine answers one question with stored evidence: *which third-party sources appear to influence the AI answers that matter to this client, which are realistically obtainable, and did acquiring inclusion correlate with improved visibility?* AI citation importance ≠ traditional backlink authority — the data model and UI say so explicitly.

## QA: what already exists (reused, not rebuilt)

| Requested | Already in the OS |
|---|---|
| Citation ingestion, per-engine adapters | `response_citations` (immutable ledger, in_text vs search) via `lib/ai/citations.ts` adapters; re-parse-idempotent |
| Recommendation influence | `recommendedCitationDomains` (co-occurrence by construction, `db/citation-profiles.ts`) |
| Source quality/legitimacy | `lib/sources/classify.ts` (`source-classifier-v1`, deterministic domain lists; relationship = owned/competitor/third_party) |
| Commercial intent per prompt | `prompts.tier` (1–4), frozen into `prompt_set_versions` (migration 030) |
| Configurable weights | `scoring_weight_sets` (versioned, sum-to-1 enforced) |
| Experiments w/ baselines, retests, verification | `interventions` + `intervention_runs` (+2w/+6w/+12w on the same instrument) + `url_verifications` (051) + `action_outcomes` spine |
| Causal-language guardrails | `CAUSAL_PHRASES` (report + executive gates), `findProhibitedPhrase` (prospect surfaces) |
| Fixability | `fixability-v1` `third_party_opportunity` category already reads cited domains |
| URL/domain normalization | `normalizeUrl`/`normalizeDomain`/`urlDomain` (query params, www, trailing slash) |
| Approval-gated execution / outreach | 052 send gate; interventions are operator-created; nothing autonomous spends |

## What was missing → scope

### A. The opportunity record (migration 069)
`citation_opportunities` — one row per (project, domain), the unit the whole engine operates on: lifecycle `status` (discovered → researched → qualified → prioritized → outreach_ready → outreach_in_progress → negotiation → submitted → won → live → verified → measuring → successful | inconclusive | no_observed_lift, plus terminal exits rejected / not_eligible / not_worth_pursuing / spam_risk / unable_to_contact / lost), `acquisition_path` (the full 20-value taxonomy incl. `unknown`), difficulty, estimated cost/time-to-live, contact status, eligibility, notes, next action, optional `provider_id`, ACVS (+ components jsonb + explanation lines + version + computed_at), and `intervention_id` — a placement IS an intervention, so verification, retests, verdicts, and the learning spine come free. Transitions validated by an explicit map and audited.

`source_presence_checks` (append-only, immutable): on-demand fetch of a source page through `safeFetch`, scanned with the same `scanAliases` recall pass the parser uses — client/competitor presence ON the source becomes measured fact, not guesswork. Runs as a worker job.

`acquisition_providers`: the generic provider registry (provider_type taxonomy: outreach_agency, citation_marketplace, pr_platform, journalist_platform, directory_network, manual_outreach, internal_team, partner_network) — declarative rows, no vendor integration; nothing purchases anything.

Seeds the `citation-acvs` v1 weight set.

### B. ACVS — `acvs-v1` (deterministic, explained)
0–100 from ten components, each 0–1 or null (null = unmeasurable → weight proportionally redistributed, never scored as zero): citation frequency, prompt relevance, commercial intent (tier 1–2 share; null when the prompt set is untiered), cross-engine presence, recommendation influence (co-occurrence), competitor density, client gap, acquisition feasibility (from operator-set path+difficulty), source quality (from the deterministic classifier — spam/low-trust types score low), persistence (distinct runs citing / runs). Weights come from the active `citation-acvs` weight set. Both the final score, every component, and plain-language explanation lines are stored; explanations are template-generated from stored numbers (never model-written) and unit-tested against the causal/guarantee phrase lists. **No DA/DR/SEO inputs exist in v1** — deliberately; the UI carries the "AI citation importance ≠ backlink authority" line.

### C. Service + workflow
`discoverOpportunities` (aggregate the ledger per third-party domain across the project's scored runs → upsert at `discovered`, preserving operator fields → score), `rescoreOpportunities`, `updateOpportunity` (path/difficulty/cost/provider/notes + validated status transitions, audited), `requestPresenceCheck` (enqueues the worker job), `linkPlacement` (→ `createIntervention` with the placement URLs; status → `measuring`; the 051 machinery does baseline/verify/retest/outcome), `citationGapView` (filterable read model), `citationMetricsForRun` (prospect/report counts: unique sources, client vs competitor citation coverage, gap counts, obtainable-gap counts).

### D. Surfaces
- `/projects/[id]/citations`: the gap view — source, prompts cited, engines, competitor co-occurrence, client presence, frequency, intent share, feasibility, ACVS (with expandable "why"), status, next action; filters for status, path, client-absent, high-intent, min ACVS; discover/rescore actions; per-row manage dialog. Carries the not-backlinks framing line.
- Fixability: `third_party_opportunity` gains **evidence lines** naming identified/obtainable opportunity counts. Point formula unchanged — a rubric change is a `fixability-v2` version bump with a recompute story, deferred deliberately.
- Guardrails: `CAUSAL_PHRASES` extended with `guaranteed`, `will improve`, `ranks because`, `directly resulted`, `proven to`, `ensures` — strengthening the existing report/executive gates everywhere, not creating a fourth list.

## Deferred (named, not forgotten)
- Audit-page "Where AI gets its information" visual section (needs audit-page-design + prospect-voice pass on the PR-B page; metrics land now via `citationMetricsForRun`).
- Fixability point-formula integration (`fixability-v2` bump).
- Provider UI + any marketplace integration; automated contact discovery/outreach/purchasing (052's gates are the rails when they come).
- Syndicated-content detection across domains; URL-level (vs domain-level) opportunity rows.
- Historical trend dashboards (the ledger is immutable — trends are derivable when a UI earns its place).

## Acceptance criteria
- [ ] Discovery aggregates the ledger per domain (www/query-param variants collapse; owned/competitor domains excluded), upserts idempotently, preserves operator fields on re-discovery (tests).
- [ ] ACVS: known-answer component math; null components redistribute; weights come from the seeded set; explanations carry no causal/guarantee phrases (tests).
- [ ] Status transitions follow the map; invalid jumps refuse; every change audited (tests).
- [ ] Presence check fetches via safeFetch, records client/competitor presence append-only; client-present flips the clientGap component on rescore (test with stubbed fetch).
- [ ] `linkPlacement` creates a real intervention (baselines, retest jobs, URL verification enqueued) and stamps `intervention_id`, status `measuring` (test).
- [ ] Gap view filters (status/path/client-absent/high-intent/min-ACVS) return correct subsets (test).
- [ ] `citationMetricsForRun` returns the prospecting counts (test).
- [ ] Extended causal phrases block in the report gate (test).
- [ ] Migration 069 reversible; `npm test`, lint, typecheck green.
