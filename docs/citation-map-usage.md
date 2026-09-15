# Citation map — usage

The citation map (`citation_map_targets`, migration 115; logic in `lib/citations/citation-map.ts`; persistence in `db/citation-map.ts`) is the placement-level record behind `citation_opportunities` (one row per project × domain). One target = one URL a client (or Recommended First itself) could plausibly be added to, with the evidence for why, the person to contact, and what happened after.

## Field coverage
| Requirement | Column |
|---|---|
| Target phrase | `target_phrase` |
| Market | `market` |
| Provider / model | `provider`, `model_label` |
| Prompt | `prompt_id` |
| Cited URL / domain | `cited_url`, `cited_domain` |
| Source class | `source_class` (same taxonomy as `sources.source_type`) |
| Citation frequency | `citation_frequency` (distinct answers citing the domain) |
| Competitor presence | `competitor_presence` (tracked competitors already on the page) |
| Page type | `page_type` |
| Freshness | `publication_date`, `last_checked_at` |
| Relevance | `relevance_score` |
| Contribution opportunity | `insertability_score`, `proposed_contribution` |
| Contact person | `author_or_editor`, `contact_url` |
| Outreach status | `status` |
| Live placement URL | `live_placement_url` |
| Recheck date | `recheck_on` |
| Citation change | `citation_change_after_placement` (+ `baseline_run_id`, `remeasure_run_id`) |
| Control entity / changed URL / change description | `interventions.control_company_id`, `changed_url`, `change_description` |

Pipeline: `discovered → qualified → contact_identified → pitched → approved → live → indexed → remeasured`; `declined` / `dropped` exit from any stage except `remeasured`. Transitions are enforced by `canTransitionCitationTarget`; movement is recorded only through `recordCitationMapRemeasurement`, so a `remeasured` row always carries both run ids.

## Scoring
`scoreCitationTarget` = 100 × (0.30 citation frequency + 0.20 topic relevance + 0.15 competitor presence + 0.15 source credibility + 0.10 freshness + 0.10 contribution opportunity). Inputs are observed counts from the client's own benchmark and a class-based credibility table; there is no domain-authority input. Unknown publication dates score 0.5, not 0.

## How it supports Recommended First's own citations
Targets for RF itself are the publications in `docs/citation_outreach_playbook.md`: the "cited URL" is the section or article to contribute to, the target phrase is the finding offered, the market is the finding's market, and remeasurement checks whether RF's research pages appear as citations in later benchmarks. The same rules apply: no sends without approval, and movement is reported, never claimed as caused.

## How it supports client work
After a benchmark, `marketSourceGraph` and `citationProfilesForProject` show which domains cite the client's competitors where the client is absent; each such URL becomes a target with its observed frequency and competitor presence. Qualification, contact and pitch are human steps; the row records them. A placement is remeasured on the same frozen prompt set under `docs/intervention_remeasurement_protocol.md`.

## Migration 115 safety
Additive and idempotent (`if not exists`); `down` drops only what `up` created. It reads or rewrites no benchmark data. Apply with the worker stopped (`docs/deployment.md`), then restart the worker; the table is empty until an operator creates targets.
