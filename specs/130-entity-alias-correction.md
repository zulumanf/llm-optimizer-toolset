# Spec 130 — Verified lead-agent aliases, evidence corrections, cohort re-resolution

> Status: in-progress
> Depends on: specs/124 (mismatch evidence), 127 (frozen Touch 1, sequences), 128 (private report), 129 (handoff QA), 013 (mention classifier v2), 004 (company registry)
> Branch: feat/130-entity-alias-correction

## Goal
A competitive-mismatch prospect canonically represented by a team/company (RealTrends entity level "team") is credited when a captured answer recommends the team's verified lead agent by name. The 2026-09-05 Ryan Ogle reply exposed that "Blu House Properties" was counted while 22 answers naming "Ryan Ogle" carried no mention row, so Touch 1 stated 11 of 256 when the same 256 answers resolve to more. This spec (1) fixes the resolver durably through verified relationships, not fuzzy matching; (2) re-resolves the SAME frozen runs (no new captures); (3) preserves what was sent while recording a provenanced correction that future reports and follow-ups read; (4) audits the whole cohort and pauses anything unsent that restates a possibly-wrong count.

## Root cause (Phase 1)
1. **Data.** `companies.aliases` is empty for every cohort company. The city pipeline mints companies from RealTrends `entity_name` only; `realtrends_records.team_lead` (the licensed dataset's own person→team relationship) is stored but never becomes an alias. The parser's deterministic recall (`scanAliases`) sees name + aliases only, so an answer naming the lead agent never becomes a candidate — no LLM call, no row, counted as zero (correct behavior for an unknown name; wrong because the name was known).
2. **Identity gate.** Even with the alias supplied, `mention-classifier-v2` returned `isSameEntity=false` for 10 of 22 answers ("Ryan Ogle the individual, not the company"): the identity block only carries approved-claim facts for the project subject, so the model has no verified relationship to lean on. Identity facts must state the relationship.

## Reuse (no parallel system)
`companies.aliases` + `upsertCompany` collision check (spec 004/056) · `realtrends_records.team_lead` (licensed, high_confidence/confirmed) · `prospect_contacts` (primary leadership contact) · `parseCompanyIntoRun` (append-only mention revisions over the same responses) · `identityContext` on `classifyResponseLlm` · `providerRecommendationCounts` (the one count) · `deliveredTouch1` / `getFollowupSequence` (frozen evidence readers) · `mismatchBlockForProspect` + `MismatchReport` · `pauseFollowupSequence` / `cancelQueuedTouches` · `outreach_reply_learning_log` view (migration 102) · `recordProspectReply` (insert-only ledger) · `qaDraftContent` / `lintFollowupCopy`.

## Entity relationship policy (Phase 2 / 6)
A person name becomes an alias of a team company ONLY when all hold:
- the company is linked to a RealTrends record with `entity_type='team'`, `match_status in (high_confidence, confirmed)`, and a non-null `team_lead`;
- the alias is the `team_lead` as recorded, plus its "First Last" form when the record carries a middle name/suffix (Jr, Sr, II, III, IV are dropped) — a single-token `team_lead` is never an alias (→ `ENTITY_REVIEW_REQUIRED`);
- a primary contact name is added only when its last name equals the team lead's last name (nickname forms like "Tina Caul" for "Matina F Caul");
- the alias does not equal the company name and does not collide with another active company's name/alias in the market bucket (`upsertCompany` refuses → `ENTITY_REVIEW_REQUIRED`).
Individuals (`entity_type='individual'`) and brokerages get no person alias. Agent ≠ team ≠ brokerage stay distinct entities. Provenance (RealTrends record id, contact id) is written to the audit log with the alias change.

Identity facts: for every candidate company with such a relationship the classifier receives an approved-fact line ("Team led by {team_lead} per RealTrends {year}; an answer naming the lead agent refers to this team") through the existing `identityContext`, in both `parseResponse` and `parseCompanyIntoRun`. No prompt-template change → classifier version unchanged.

## Counting rules (Phase 3)
- Denominator unchanged: valid, non-holdout answers of the provider (`providerRecommendationCounts`).
- One mention row per (answer, company) current revision → an answer naming both "Ryan Ogle" and "Blu House Properties" is one appearance and at most one recommendation. `scanAliases` returns one hit per company (canonical name first).
- Recommendation still means explicit endorsement by the classifier; mention ≠ recommendation. Echo exclusion unchanged.

## Database changes (migration 104)
- `outreach_evidence_corrections` (insert-only, `forbid_mutation` trigger): `prospect_id`, `evidence_draft_id` (the frozen Touch 1 draft), `send_id`, `source_run_id`, `original_snapshot` jsonb, `corrected_snapshot` jsonb, `reason`, `entity_resolution_change` jsonb (aliases added, mention rows added, per-side counts before/after), `corrected_by`, `corrected_at`. Latest row per `evidence_draft_id` wins.
- `outreach_reply_learning_log` recreated with `sent_claim_prospect/competitor`, `corrected_recommendations_prospect/competitor`, `corrected_recommendation_gap`, `evidence_corrected_at`, `pricing_requested`, `phone_provided`, `hours_to_reply`.

## Behavior
- `deliveredTouch1` returns the effective snapshot (corrected when a correction exists) plus `originalSnapshot` and `correction`; the "body states its evidence" check keeps using the original.
- `getFollowupSequence`/`sequenceForProspect` overlay the latest correction onto `evidenceSnapshot`; the stored row is untouched. Unsent Touch 2/3 drafts of an affected sequence are superseded and the sequence paused (`operator: evidence correction …`) until the operator resumes.
- `mismatchBlockForProspect` uses corrected counts and adds `correction` (original vs corrected, note) and `changeFirst` (≤ 3 rows: observed / change / test) derived from counted evidence; the page renders a quiet correction line under the header and a "What I'd change first" section after the finding. `serializeReportForReview` includes both.
- Draft QA: a bracketed ALL-CAPS placeholder (`[FOUNDER_PRICING]`) fails `artifacts` and `followup_copy`.
- Gmail adapter: HTML-only messages decode `text/html` (tags stripped) instead of falling back to the subject.
- Cohort audit script `scripts/entity-alias-audit.ts` (`--apply` writes): derive → apply aliases → `parseCompanyIntoRun` per affected company/run → recount → bucket (`UNAFFECTED`, `CORRECTED_BUT_STILL_ELIGIBLE`, `MATERIAL_COUNT_CHANGE`, `NO_LONGER_ELIGIBLE`, `NEEDS_HUMAN_REVIEW`) → correction rows for delivered Touch 1s → pause/supersede unsent.

## Acceptance criteria
- [ ] Alias derivation: team + RealTrends team lead → aliases; single-token lead → review; individual → none; collision → review.
- [ ] Classifier receives the relationship fact; a same-name unrelated agent is not merged (alias absent → no candidate).
- [ ] Correction row keeps original and corrected snapshots; Touch 1 draft/send rows unchanged; report and follow-ups read corrected counts.
- [ ] `[FOUNDER_PRICING]` fails draft QA.
- [ ] HTML-only Gmail reply yields its text body.
- [ ] Cohort audit output lists every prospect with a bucket; affected unsent outreach paused.

## Test cases
`tests/unit/entity-aliases.test.ts`, `tests/unit/evidence-corrections.test.ts`, additions to `classify-llm`, `draft-qa`/`followups`, `google-adapter` parse, `audit-mismatch` (correction/changeFirst).
