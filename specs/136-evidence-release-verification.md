# Spec 136 — Evidence release verification (fail-closed competitive claims)

> Status: implemented
> Depends on: specs/124 (mismatch evidence snapshot), 127 (frozen Touch 1, sequences), 128/129 (private report, hand-off QA), 130 (verified lead aliases, correction ledger), 095 (RealTrends dataset)
> Branch: feat/136-evidence-release-verification

## Goal
No customer-facing competitive recommendation claim transmits unless ONE canonical verification layer says `EVIDENCE_RELEASE_VERIFIED`. Spec 130 fixed the Blu House undercount and gated entity resolution; it still validated copy against the snapshot, not the snapshot against the world. This spec verifies the frozen snapshot itself — identity, relationships, production records, frozen run, provider, completeness, denominator, both counts (independently recomputed), correction state — at approval, at sequence resume, at hand-off QA and again at transmission. UNKNOWN is never PASS.

## Reuse (no parallel truth system)
`classifyEntityResolution` / `entityResolutionStatuses` (spec 130 gate) · `leadAgentRelationships` + `deriveLeadAgentAliases` (licensed team-lead provenance) · `providerRecommendationCounts` (the primary count, unchanged) · `MismatchEvidenceSnapshot` on `outreach_drafts.evidence_snapshot` (the frozen claim) · `outreach_evidence_corrections` (insert-only ledger) · `realtrends_records` / `prospect_authority_signals` (production records by the snapshot's `productionSignalId`) · `prospect_outreach_sends.gate_verdict` (observability) · `KNOWN_PARSER_VERSIONS` · echo rule and prepass boundary (mirrored in code). No migration.

## The layer — `lib/prospects/evidence-release.ts`
- `shadowRecount(...)` — pure JavaScript recount over raw `responses` + `mentions` rows: provider isolation, error exclusion, holdout exclusion, current revision (max revision per answer×company), echo exclusion, one credit per answer, distinct questions. Never calls the primary counter.
- `rawOccurrence` / `identityNamesFor` — deterministic whole-word search of every verified identity name (company name, registry aliases, RealTrends team-lead forms) in valid answer text. A hit with no current mention row is a **coverage gap** (the parser never considered the entity there). Not classification — a reconciliation trigger.
- `composeReleaseVerdict(input)` — pure; runs every check (no short-circuit) and returns `verified`, deterministic `reasons`, the ordered `checks`, and `diagnostics` (versions, counts, denominators, records).
- `verifyEvidenceRelease(snapshot, {prospectId, sendId})` — loads and composes. Reads only.
- `verifyDraftEvidenceRelease(db, draft)` — the snapshot a draft states (own or nearest ancestor's), keyed to the sequence's Touch 1 send for the correction lookup.
- `derivedClaimFigures` — ratio %, recommendation multiple, absolute gap in code.

### Checks (in order) → reason on failure
PROSPECT_ENTITY_VERIFIED → `PROSPECT_ENTITY_UNVERIFIED` / `AMBIGUOUS_IDENTITY` · COMPETITOR_ENTITY_VERIFIED → `COMPETITOR_ENTITY_UNVERIFIED` / `AMBIGUOUS_IDENTITY` · ENTITY_LEVEL_COMPARABLE → `ENTITY_LEVEL_MISMATCH` (levels equal, and each production record's level equals the resolved level) · ALIAS_SET_VERIFIED → `ALIAS_COVERAGE_UNVERIFIED` · RELATIONSHIPS_VERIFIED → `RELATIONSHIP_UNVERIFIED` (a TEAM's lead comes from the licensed record) · PROSPECT/COMPETITOR_PRODUCTION_VERIFIED → `PRODUCTION_RECORD_UNVERIFIED` / `PRODUCTION_PERIOD_MISMATCH` / `PRODUCTION_VALUE_MISMATCH` (record found by the frozen id; year and value equal the snapshot) · PRODUCTION_COMPARABLE → `PRODUCTION_PERIOD_MISMATCH` / `ENTITY_LEVEL_MISMATCH` / `PRODUCTION_METRIC_MISMATCH` · FROZEN_RUN_PRESENT → `FROZEN_RUN_MISSING` · PROVIDER_VERIFIED → `PROVIDER_MISMATCH` (claim provider = `MISMATCH_PROVIDER`; other providers counted only as excluded) · RUN_COMPLETENESS_ACCEPTABLE → `BENCHMARK_INCOMPLETE` · DENOMINATOR_VERIFIED → `DENOMINATOR_MISMATCH` (stated = primary = shadow) · PRIMARY_*_COUNT_VERIFIED → `STATED_COUNT_MISMATCH` · SHADOW_*_COUNT_MATCH → `PRIMARY_SHADOW_COUNT_MISMATCH` · ZERO_COUNT_VERIFIED → `ZERO_NOT_VERIFIED` · RECOMMENDATION_SEMANTICS_VERIFIED → `RECOMMENDATION_SEMANTICS_UNVERIFIED` · NO_PENDING_CORRECTION → `PENDING_CORRECTION` · NO_UNRESOLVED_EVIDENCE_ISSUE → `UNRESOLVED_EVIDENCE_ISSUE`.

### Run completeness (canonical policy, made explicit)
Spec 124 accepts `completed` or `partial` runs with a completion time. This spec adds the smallest fail-closed refinement for the CLAIMED provider only: expected cells = non-holdout prompts × repetitions configured for that provider; every expected cell must be a valid capture. One missing or errored cell of the claimed provider blocks; other providers' failures (why cohort runs read `partial`) do not. Disagreement is `PRIMARY_SHADOW_COUNT_MISMATCH`/`DENOMINATOR_MISMATCH`; nothing is averaged or preferred.

## Consumers (one layer, several doors)
- `sendProspectDraft`: `entity_resolution_verified` (retained name, now sourced from the verdict) + `evidence_release_verified` with the full reason line and diagnostics on `gate_verdict` (`prospect-send-gate-v3`). Re-verified immediately before transmission — human and unattended sends alike.
- `approveOutreachDraft`: refuses approval of a blocked claim.
- `resumeFollowupSequence`: a paused sequence continues only when its effective snapshot (latest correction overlaid) verifies.
- `runReportHandoff`: the private report's evidence joins the deterministic QA pass.
Templates, reports and scripts keep consuming the frozen snapshot values; none recompute.

## Observability
Every send's `gate_verdict.checks[evidence_release_verified].detail` carries `diag={version, runId, provider, expected/valid/error/other cells, stated/primary/shadow counts+denominators, coverage gaps, entity levels, production record ids, parser versions, correction id}` — enough to reconstruct the verdict without new tables.

## Cohort re-resolution
`scripts/evidence-release-audit.ts` (read-only): A approved-unsent claims · B paused correction sequences · C known incidents (Blu House, every corrected prospect) · D stratified historical sample (prospect_type × zero/non-zero × market, md5 order). Classifies `VERIFIED_UNCHANGED | COUNT_CHANGED_DIRECTION_SAME | MATERIAL_CORRECTION | NO_LONGER_ELIGIBLE | HUMAN_REVIEW | SYSTEMIC_VERIFICATION_FAILURE` and assigns a root-cause class from the correction ledger / audit log / mention revisions where determinable. Sends nothing, resumes nothing.

## Acceptance criteria
- [x] Blu House property regression (unit + integration): lead-only answers credit the team once; omitted relationship fails closed; same-surname stranger never matches; ambiguous lead → `AMBIGUOUS_IDENTITY`.
- [x] 30-item matrix in `tests/unit/evidence-release.test.ts`; gold set in `tests/fixtures/evidence-release-gold.ts`.
- [x] Send gate refuses with deterministic reasons and ledgers diagnostics; approval, resume and hand-off consume the same layer.
- [x] Historical rows untouched (DB triggers exercised in the integration test).
