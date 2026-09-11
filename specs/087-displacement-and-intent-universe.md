# Spec 087 — Recommendation Displacement + Real-Estate Intent Universe

> Status: done
> Depends on: specs/086 (source taxonomy v2, epistemics), specs/009 (gap findings), specs/060 (citation acquisition), specs/046 (market packs)
> Branch: feat/087-displacement-and-intent-universe

## Goal

When a target entity is absent from AI answers, the OS can say exactly **who
was recommended instead**, in which prompt clusters and dimensions, backed by
which sources — and turn that into a prioritized, playbook-backed execution
task on the existing gap→task→intervention spine. Alongside it, prompts gain
structured real-estate dimensions (neighborhood, building, property type) so
coverage of the buyer/seller decision space is measurable, and missing
high-value prompt variants can be **proposed** (staged, human-approved) rather
than silently added. Everything is derived from the immutable observation
ledger; nothing new is persisted except the staging table and prompt columns.

## What is reused (audit result — do not rebuild)

- Mentions/recommendation semantics: `mentions.recommended`, `list_position`,
  current-revision idiom (`db/mentions.ts` CURRENT).
- Prompt intent: `prompts.tier` + `lib/scoring/intent.ts` weights; clusters
  derived on read via `lib/prompts/cluster.ts` (per DECISIONS.md, not stored).
- Source taxonomy v2 (12 types) + `sources.relationship`; citation ledger
  `response_citations`; market source graph `lib/citations/market.ts`.
- Opportunity→execution spine: `gap_findings` (+ epistemics 073) →
  `tasks` (evidence-gated) → `interventions` (+ `intervention_runs`
  baseline/post) → verdicts. Citation pipeline `citation_opportunities`.
- Staged-proposal pattern: `enrichment_proposals` + pending/approve/reject
  lifecycle (spec 078/079) — mirrored, not extended, for prompt suggestions.
- Evidence thresholds: null-not-zero doctrine, `MIN_STABLE_SAMPLE = 6`.
- Epistemics: observations[] / explanation / suggestedAction split with
  hedged, non-causal language (spec 086 E).

## Database changes

One migration `082_intent_universe_and_displacement.sql`:

1. `prompts` — add nullable `neighborhood text`, `building text`,
   `property_type text` (free text like `audience`/`price_tier`).
2. `prompts.source` CHECK widened with `'generated'`, `'observed'`
   (approved suggestions land as `generated`; operator-transcribed real-world
   prompts as `observed`).
3. New table `prompt_suggestions` — staging for proposed prompt variants:
   project/prompt-set scoped, text + full dimension set, `origin`
   (`generated` | `observed`), `rationale`, `evidence jsonb`, `status`
   (`pending` | `approved` | `rejected` | `superseded`),
   `generator_version`, `promoted_prompt_id`, decided_by/at. Partial unique
   `(prompt_set_id, md5(lower(text)))` where status = 'pending'.
4. `gap_findings.gap_type` CHECK widened with `'displacement'`.

Rollback: drop columns/table; displacement findings are deleted on down
(same convention as 081: never silently remapped).

## New modules (all derived-on-read, all versioned)

- `lib/competitors/displacement.ts` — `DISPLACEMENT_VERSION =
  "recommendation-displacement-v1"`. For a run + subject company: valid
  responses only (error is null, non-mock unless allowed, current-revision
  mentions), split present/absent; on absent responses aggregate rivals with
  `recommended = true`, echo-excluded (prompts naming the rival don't count),
  ordered by count with mean list position; drilldowns by provider, category,
  tier band, audience, price tier, neighborhood, property type, cluster key.
  Rivals with < 2 displacing recommendations are reported but flagged below
  the meaningful threshold. < 6 absent responses → `insufficient_evidence`.
  Companion: observed source differences (citation domains on displacing
  responses vs subject's, labeled with source types) — observations +
  hedged inference only, never causal claims.
- `lib/scoring/recommendation-share.ts` — `REC_SHARE_VERSION =
  "recommendation-share-v1"`. AI Recommendation Share = distinct valid
  responses recommending the subject ÷ distinct valid responses recommending
  any tracked company ("recommendation moments" — same denominator as the
  audit stakes block). Raw counts always exposed. Same breakdown dimensions
  as displacement. Below-threshold segments → `insufficient_data`, never 0%.
- `lib/sources/playbooks.ts` — `SOURCE_PLAYBOOK_VERSION =
  "source-playbook-v1"`. Static map over the 12 existing `source_type`
  values → legitimate recommended actions + default `acquisition_path`
  (from the existing 15-value enum). No autonomous execution, no fake
  reviews/personas/manufactured recommendations — the module encodes the
  prohibition explicitly.
- `lib/prompts/suggest.ts` — `PROMPT_SUGGESTION_VERSION =
  "prompt-suggest-v1+deterministic"`. Proposes market-pack expansion
  combinations not present in the active set (dedup case-insensitive against
  active prompt texts and pending suggestions), capped; stages rows in
  `prompt_suggestions`; approve → `addPrompt` with `source='generated'` and
  structured dimensions; reject/supersede mirror the enrichment lifecycle.
- `lib/reports/drivers.ts` (P1) — `CHANGE_DRIVERS_VERSION =
  "change-drivers-v1"`. Decomposes the mention/recommendation delta between
  the two comparable runs of a report pair into per-provider, per-cluster
  contributions; lists newly observed domains and newly recommended rivals;
  lists interventions shipped between the two run dates with
  "occurred before the later measurement" language. Associative only —
  reuses the causal-language gate.

## Extensions to existing modules

- `lib/gaps/detect.ts` — new `displacement` finding (subject absent from ≥
  threshold of valid responses while ≥1 rival meets the meaningful
  displacement bar); detail carries top rivals, clusters, and source
  differences; `DETECTOR_VERSION` → `gap-detector-v1.2`; `GAP_FACTORS`
  entry for `displacement`. Priority banding helper `priorityBand(score)` →
  `do_now | do_next | test | low_priority` with named thresholds, mapped to
  existing task p1/p2/p3 on promotion.
- `lib/markets/generate.ts` — expansion stamps `neighborhood` /
  `property_type` as structured columns (it already knows them at
  substitution time).
- `lib/prompts/set-service.ts` — freeze carries `source`, `template_ref`,
  and the three new dimensions; `duplicatePromptSet` stops dropping
  `is_holdout`, `audience`, `price_tier`, `template_ref`, `source`.
- `lib/prompts/validation.ts` — `source` enum gains `import`, `generated`,
  `observed` (fixes existing DB/Zod mismatch); new optional dimension
  fields.
- `db/prompt-sets.ts` — `listActivePrompts` returns the dimension columns it
  already declares.
- `lib/scoring/coverage.ts` — coverage dimensions gain `neighborhood`,
  `property_type`, `building`; version bumps to `coverage-v2` because the
  segment key space changes.

## UI (minimal)

- Project gaps page renders `displacement` findings through the existing
  gap-findings list (works without change; verify labels).
- Prompt-set page: pending suggestions count + approve/reject list (reuse
  the enrichment-panel interaction pattern).
- No audit-page changes in this spec: "Recommended Instead" already exists
  as `stakes.competitorsNamed` in published snapshots. Displacement detail
  on audit pages is deferred.

## Edge cases

- Subject mentioned but not recommended: response is *not* displacement
  (subject present); it stays in the existing `recommendation` gap type.
- Prompt names the rival (echo): rival recommendation on that response never
  counts toward displacement.
- All responses failed → displacement returns `insufficient_evidence`, gap
  detector emits nothing.
- Mixed scoring/parser versions: displacement uses current-revision mentions
  only, so re-parses supersede cleanly.
- Suggestion approved twice: second approve is a no-op failure (status
  guard); promoted prompt id recorded.
- Market pack with no neighborhoods: generator proposes nothing, returns
  empty with reason, never errors.

## Acceptance criteria

- [ ] Migration applies and rolls back cleanly.
- [ ] Failed observations never contribute to displacement counts.
- [ ] Subject presence on a response excludes it from displacement.
- [ ] A rival appearing once is flagged below the meaningful threshold.
- [ ] Displacement counts reconcile to raw current-revision mentions.
- [ ] Recommendation share reconciles to mention evidence; raw counts
      exposed; small segments return `insufficient_data`.
- [ ] < 6 absent responses → `insufficient_evidence`.
- [ ] Every source_type has a playbook with ≥1 action and a valid default
      acquisition path; no playbook contains prohibited tactics.
- [ ] Prompt suggestions dedupe against active prompts and pending
      suggestions; approval creates a prompt with `source='generated'` and
      structured dimensions; provenance survives freeze.
- [ ] Displacement gap findings promote to tasks through the existing
      evidence-gated path; tasks link to interventions unchanged.
- [ ] Detector version bumped; historical findings untouched.
- [ ] Change drivers (P1) use associative language only (causal gate passes).
- [ ] `npm run lint`, `npm run typecheck`, targeted `vitest` suites green.

## Test cases

Unit: displacement invariants (failed/present/echo/threshold/reconcile),
recommendation-share reconciliation + insufficient_data, playbook coverage +
prohibition strings, prompt-suggest dedup/cap/provenance, detector v1.2
displacement finding + priority banding, drivers language gate.
Integration: suggestion approve→prompt→freeze carries dimensions;
displacement over the real mock-provider pipeline fixture.

## Definition of done

Acceptance criteria pass · lint/typecheck clean · migration up/down tested ·
DECISIONS.md updated with the derived-not-stored displacement decision.
