# Spec 086 — Observation Provenance, Measurement Tiers, and Market Citation Intelligence

**Status:** In progress
**Branch:** `feat/086-observation-provenance`
**Principle:** Every AI observation must say how it was collected, what consumer
surface it reflects, and why it was measured — derived from facts the platform
already stores, never independently editable. Market-level citation intelligence
turns the per-project citation ledger into the market question that drives
prospecting: *which sources do AI answers in this market actually rely on, and
which prospects are missing from them?*

## QA: what already exists (reused, not rebuilt)

| Requested | Already in the OS |
|---|---|
| Immutable raw observations | `responses` (003) — insert-only, hashed (011), `request_params` per response (058) |
| Manual consumer-UI observations | `client_validation_runs` / `client_validation_observations` (011) — clean-session instructions, screenshots via `evidence_artifacts`, never enter scores |
| Search vs model-only instrumentation | `+search` model variants; `request_params.tools` records `web_search` / `googleSearch`; "a search-enabled run is a different instrument" (lib/ai/openai.ts) |
| Run purpose facts | `projects.kind` (041), `runs.trigger` (003), `intervention_runs.role` (007) |
| Citation ledger + normalization | `response_citations` (033), `urlDomain`, `cleanUrl` |
| Per-project citation aggregation | `projectDomainStats`, citation profiles (036), ACVS (069) |
| Source classification | `lib/sources/classify.ts` `source-classifier-v1`, stored on `sources` (036) |
| Gap/diagnosis epistemics | `prospect_findings` evidence arrays (038), diagnosis confidence + sample gates (042), `gap_findings` classification (073) |
| Evidence-tiered audit page | frozen `prospect_audits.snapshot` + `instrumentVersions` (065) |

## What was missing → scope

### A. Observation provenance vocabulary (`lib/runs/provenance.ts`, no migration)

Provenance is **derived on read** from stored facts — the platform's standing
doctrine — because every fact needed already exists:

- `collection_method`: `api` for every `responses` row (the executor is the
  only writer), `manual_ui` for `client_validation_observations` (staff-recorded),
  `consumer_ui` reserved for future client-performed rows, `licensed_provider` /
  `serp_provider` reserved for future adapters. Exported as constants.
- `surface` for API rows: `web_search` when `request_params.tools` includes a
  search tool, the model id carries `+search`, or the provider is Perplexity
  (inherently grounded); else `model_only`. Consumer observations are
  `consumer_web` by construction (clean-session browser instructions).
- **Measurement tier** (deterministic, never editable): Tier A = consumer UI
  observed; Tier B = search-enabled provider API; Tier C = licensed/third-party
  dataset (unused today, reserved); Tier D = model-only API. Tier communicates
  how directly an observation reflects the consumer experience — it is not an
  accuracy ranking, and the UI copy must not imply one.
- **Measurement purpose** derived from `projects.kind` × `runs.trigger` ×
  `intervention_runs.role`: post-intervention → `experiment_followup`;
  baseline-role → `client_baseline`; prospect project → `prospecting`;
  client project scheduled → `client_monitoring`, manual → `client_baseline`.
  Consumer validation runs → `audit_validation`.
- Minimal collector registry as typed constants (provider × surface ×
  collector_type × status × citation/screenshot support). No DB table — rows
  are code-reviewed facts, and nothing automated consumes them yet.

No headless-browser collection is introduced. API responses can never be
labeled consumer observations because the label derives from which table the
row lives in.

### B. Migration 081 (additive, reversible)

- Widen `sources.source_type` CHECK with `industry_ranking` and `local_press`
  (real-estate authority signals the generic v1 taxonomy folds into
  `news`/`other`).
- `interventions.intervention_type text` nullable CHECK — the GEO action
  taxonomy (entity_page_created, citation_acquired, press_mention_acquired,
  local_content_created, …) so the learning loop can group outcomes by action
  type. Nullable: legacy rows stay unlabeled, never guessed.

### C. Source classifier v2 (`source-classifier-v2`)

`realtrends.com` → `industry_ranking`; Jersey-market local press
(jerseydigs.com, nj.com, hudsoncountyview.com, patch.com) → `local_press`;
optional `localPressDomains` context lets market packs extend the list.
Existing rows keep their v1 labels until next parse touches them;
`scripts/reclassify-sources.ts` re-runs classification explicitly.

### D. Market citation intelligence (`lib/citations/market.ts`, version `market-citations-v1`)

For a market launch: aggregate `response_citations` across the benchmark runs
of the launch's prospects (`prospects.benchmark_project_id`), grouped by
domain — citation count, responses citing, providers, top pages, source type,
and per-prospect presence/absence (cited `company_id` vs each prospect's
canonical company). Counts reconcile to `response_citations` rows; failed
responses are excluded by the ledger's construction (citations only parse from
captured payloads). Rendered as a "What AI relies on in this market" section
on the prospects workspace. Insufficient evidence (< MIN_MARKET_CITATIONS
citations) renders as insufficient evidence, not an empty ranking.

### E. Prospect diagnosis epistemics + audit page provenance

- `diagnoseProspect` diagnoses gain `observations: string[]` — the measured
  facts (counts, domains, rates) stated separately from the inference
  (`explanation`) and the recommendation (`suggestedAction`).
- `AuditSnapshot` gains optional `collection` (api observation count,
  search-enabled vs model-only split, tier labels, purpose) and optional
  `consumerValidation` (per-provider observed/mentioned counts from the
  benchmark project's validation runs, dated). Assembled at publish, frozen
  like everything else. Old snapshots lack the fields and render unchanged.
- Audit page: "How this was measured" states collection method and tier
  split; when consumer validation exists it renders as a separate section
  with its own denominator (never merged); when only API observations exist
  the page says so plainly. Diagnosis sections label Observed / Inference /
  Recommendation.

## Invariants (tested)

- API responses can never appear as consumer observations (structural + test).
- Consumer validation counts never enter benchmark denominators (existing
  invariant, re-asserted in the new snapshot section).
- Market citation aggregates reconcile exactly to `response_citations` rows.
- Tier and purpose are pure functions of stored facts.
- Snapshots published before 086 render without the new fields.

## Out of scope (deferred)

- Automated consumer-UI collection (browser fleet) — P2.
- Licensed/SERP provider adapters — reserved enum values only.
- Page-title capture on citations - P1.
- Cross-market citation intelligence dashboards — P2.
