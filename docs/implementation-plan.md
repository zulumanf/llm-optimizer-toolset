# Implementation Plan — closing the gap to the target pipeline

Derived from `docs/qa/current-state-audit.md` (matrix §6) and `docs/architecture/target-pipeline.md`. Ordered so every phase is a shippable vertical slice with tests, and no phase creates a duplicate of an existing mechanism. Aligns with `docs/prospect-acquisition-roadmap.md` (phase numbers referenced).

## Phase A — Repair + complete the in-flight slice ← current

*Roadmap 2.2 + 2.3. Fixes the only failing gate (lint) by finishing, not reverting, the uncommitted work.*

1. Commit migration `042` (contacts + `outreach_drafts.contact_id`) as-is.
2. `lib/prospects/contacts.ts`-level service functions in `service.ts`: `addContact`, `updateContact` (primary flip, per-contact DNC with reason, archived), `listContacts`; same-prospect constraint on draft `contact_id` enforced in service (DB can't express it).
3. Wire `parseProspectImport` → `importProspects(user, {launchId, csv, defaultProvenance, sourceUrl?})`: per-row create via the existing insert path, `source='csv'`, `field_provenance` per populated field, contact row when contact columns present, per-row `created|duplicate|error` report; row failures don't abort the batch.
4. Close the suppression gap: `createOutreachDraft` accepts `contactId`; `approveOutreachDraft` + `recordDraftSent` block, fail-closed, on contact DNC and on `suppression_entries` matches against normalized contact/prospect email (reusing `lib/outreach/suppression.ts` matching — no second matcher).
5. Server actions + UI: contacts card on prospect detail, CSV import on the prospects/launch page.
6. Tests: parser unit tests; integration — import happy path/dupes/cap, contact CRUD + one-primary + per-contact DNC blocking approval/record-sent, suppression match on contact email, cross-prospect contact refusal.
7. Drive-by (same bug class, 2 lines): `scripts/verify-providers.ts` dotenv-first fix.

**Acceptance:** roadmap 2.2 "imported rows labeled by provenance"; 2.3 "suppression checks match on contact identifiers"; lint/typecheck/tests/build green.

## Phase B — Authority, weighted visibility, numeric gap (matrix 10–12) — **done 2026-08-02, spec 038**

Shipped as `specs/038-prospect-authority-and-valuable-visibility.md`. Deviations from the
sketch below, recorded in DECISIONS.md: derived **on read** (spec-036 precedent) instead of
a bumped `scoring_version` — no stored copy to drift, old runs stay comparable;
`verification_status` NOT added (provenance already carries that axis); a `scope`
local|global column excludes global evidence with a reason instead. Modules:
`lib/scoring/intent.ts` (one commercial-intent model, gap detector byte-identical),
`lib/scoring/valuable.ts` + `valuableVisibility()` (intent-weighted credit over organic
cells), `lib/prospects/authority.ts` (rubric with per-component evidence),
`lib/prospects/gap.ts` (composition), migration 044. Surfaces: prospect detail section,
audit snapshot `authorityGap` (additive), public audit page. Tests:
`prospect-authority`, `valuable-visibility` (known-answer), `prospect-authority-gap`
(integration over a scored mock run).

## Phase C — Fixability + final score (matrix 14, 17) — **done 2026-08-02, spec 039**

Shipped as `specs/039-fixability-and-final-prospect-score.md`. Deviation from the sketch:
no `prospect_fixability` table — fixability is derived on read (038 pattern) from stored
facts (`prospect_assessments` for underivable inputs); only the final composite is stored
(`qualification_score` + self-explaining `qualification_breakdown`), because the list
filters/sorts on it. `scoring_weight_sets` (one active per name, sum-to-1 enforced) is
the single weights mechanism; override-with-reason never erases the computed score.
JSONB vocabularies must use camelCase keys (postgres.camel rewrites snake keys on read —
DECISIONS.md). Tests: 15 known-answer unit + 5 integration (weight switching included).

## Phase D — Market packs + prompt generation (matrix 2, 6, 7) — **done 2026-08-02, spec 040**

Shipped as `specs/040-market-packs-and-prompt-generation.md`. Deviation from the sketch:
packs are code-versioned data (`lib/markets/packs.ts`, vertical-pack precedent) with an
idempotent installer into the one `markets` tree + `market_pack_installs` provenance —
not a `market_packs` config table; generation is its own module (`lib/markets/generate.ts`),
not an `expand.ts` extension (different variable model). Five city packs, kinds widened
country→zip, cycle-guard trigger, prompt lineage columns (audience/price_tier/template_ref),
deterministic capped idempotent generation, set-page dialog. Tests: 22 unit
(registry validation + fixtures like "Who should I use to sell a condo in Brickell?") +
4 integration (containment via geoRelation, alias merge, cycle guard, generation lineage).

## Phase E — Discovery adapters + entity resolution (matrix 3, 5) — **done 2026-08-02, spec 041**

Shipped as `specs/041-prospect-discovery-and-entity-resolution.md`. Adapter contract +
mock (guarded like the mock AI provider); migration 047 candidate/run tables; approval
creates prospects only through `createProspect` with per-fact provenance; resolver
reuses the knowledge-layer name matcher + domain identity, with the brokerage-collision
exclusion ("Rivera Team at Compass" never resolves to "Compass"); match auto-links,
possible surfaces as an audited detail-page suggestion; cross-launch duplicates read.
Deviations recorded in DECISIONS: CSV/manual keep their existing provenance shape;
discovery runs inline until a network adapter exists (then → jobs queue). Tests:
11 unit + 4 integration.

## Phase F — Diagnosis, buying signals, freshness (matrix 13, 15, freshness) — **done 2026-08-02, spec 042**

Shipped as `specs/042-diagnosis-buying-signals-freshness.md`. Eleven typed diagnoses
derived on read (absence-of-research keys honestly low-confidence); migration 048
buying signals with NOT NULL source+date, decaying score contribution wired into the
final-score `buyingSignals` component (null-when-none vs 0-when-expired); freshness
windows as constants in `lib/prospects/constants.ts` (deviation: prospect-domain
constants live with the domain, not lib/constants.ts) with stale badges and a
fail-closed acknowledge-to-publish gate on stale benchmarks. Tests: 16 unit + 3
integration (incl. the 100-day-old-run publish gate end to end).

## Phase G — Outreach activation + feedback (matrix 20, 21; roadmap Phase 3) — **done (credential-free half) 2026-08-02, spec 043**

Shipped as `specs/043-outreach-activation-and-feedback.md`. Spec-011 contradiction
resolved in DECISIONS.md (gated send stands — "human-decided, machine-enforced";
first-touch stays human-dispatched). `sendProspectDraft` bridges the two outreach
stacks through the full fail-closed gate chain with an insert-only send ledger
(migration 049; refusals ledgered too); channels = manual + guarded mock, real
ESP/Gmail appends after live verification; record-sent now routes through the gate.
Acquisition funnel (ever-reached counts, null-not-zero conversions) and the
score-feedback report (cohort floor 5, recommendations only, human reweights) render
on /prospects. **Still open, blocked on funded credentials not architecture:** live
Gmail/ESP verify + OAuth (3.2), reply ingest (3.4); also 3.5 deal economics and
3.6 prospect→client conversion. Tests: 8 unit + 3 integration.

## Continuous (alongside every phase)

- Security: `loadRobots` → `safeFetch` path; env-schema drift fix (`AUTOMATION_CREDENTIAL_KEY`, `GOOGLE_API_KEY`, `PERPLEXITY_API_KEY` into `lib/env.ts`); structural LLM-input sanitization.
- Integrity: same-prospect draft-contact check (Phase A, service-level), missing hot-path indexes, jobs dead-letter/requeue.
- Docs: `docs/03-database-schema.md` catch-up (028+), DECISIONS.md entries for each non-obvious call.

## Rules of engagement

Spec before code for each phase (repo convention); smallest coherent vertical slice; tests first where practical; never a new scoring/weights/entity/outreach mechanism where one exists; all weights configurable through the Phase C mechanism once it lands.
