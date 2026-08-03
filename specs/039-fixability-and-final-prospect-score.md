# Spec 039 — Fixability Scoring and the Configurable Final Prospect Score

Phase C of `docs/implementation-plan.md`. Requirements 14 and 17 of the target pipeline:
a 0–100 fixability score across six evidence-backed categories with hard flags and a
confidence adjustment, and a final prospect score over configurable weights — the
platform's **single** configurable-weights mechanism, ending the audit's finding of four
independent hardcoded weight tables.

## Principles applied

- **Never fabricate.** Fixability inputs the platform cannot derive (website control,
  publishing access) are **operator-recorded facts** with notes and identity
  (`prospect_assessments`), not guesses. Underivable categories read "not measured" and
  lower data confidence; they are never silently scored.
- **Derived vs stored.** Fixability and its inputs are derived on read (spec 038
  pattern). The **final composite is stored** on the prospect — deliberately: the list
  view filters and sorts on it, and a stored score is a snapshot an operator computed at
  a known time from named component values (the breakdown records all of them plus the
  weight-set version). Recompute is an explicit, audited action, not a drift-prone
  live value.
- **Hard flags downgrade and explain, never delete.** A flagged prospect keeps its
  score and shows why it was flagged; `reputation_concern` additionally recommends
  human review.
- **Null is never zero.** A component with no data drops out and its weight
  redistributes (the `authorityScore` convention); the breakdown lists what was
  missing.

## 1. Migration 045

```sql
create table scoring_weight_sets (
  id uuid primary key default gen_random_uuid(),
  name text not null,                -- e.g. 'prospect-final'
  version int not null,
  weights jsonb not null,            -- {component: weight}, must sum to 1
  active boolean not null default false,
  notes text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (name, version)
);
create unique index scoring_weight_sets_one_active
  on scoring_weight_sets (name) where active;

create table prospect_assessments (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects(id),
  item text not null,                -- ASSESSMENT_ITEMS vocabulary
  value text not null check (value in ('yes', 'no', 'unknown')),
  note text,
  recorded_by uuid references users(id),
  recorded_at timestamptz not null default now(),
  unique (prospect_id, item)         -- latest answer wins via upsert
);

alter table prospects add column qualification_breakdown jsonb;
alter table prospects add column qualification_override int
  check (qualification_override between 0 and 100);
alter table prospects add column qualification_override_reason text;
alter table prospects add column qualification_override_by uuid references users(id);
alter table prospects add column qualification_override_at timestamptz;
```

Seed: `('prospect-final', 1, {commercialAuthority: .30, visibilityGap: .25,
adjustedFixability: .20, competitorAdvantage: .10, buyingSignals: .10,
contactability: .05}, active)`. Component keys are **camelCase**: the client's
`transform: postgres.camel` rewrites snake_case JSONB keys on read, so snake
keys would come back as different strings than were stored.

Assessment items (`lib/prospects/constants.ts`): `website_control`,
`content_publishing_access`, `marketing_resources`, `can_obtain_reviews`,
`website_indexable`, `has_dedicated_website`, `services_markets_clear`,
`credentials_visible`, `neighborhood_content`, `structured_data_consistent`,
`reputation_concern`.

## 2. `lib/scoring/weights.ts`

`getActiveWeightSet(name)` (DB read, validated: weights sum to 1 ± 1e-6) and
`weightedComposite(components, weights)` — the shared null-redistribution composite.
`authorityScore` in `metrics.ts` is left untouched (client scoring stays byte-identical);
it migrates here in a future scoring-version bump.

## 3. `lib/prospects/fixability.ts` — pure, `fixability-v1`

Input: authority profile (038), valuable visibility (038), signal details, citation
domains of the linked run (classified via `classifySource`), assessment answers,
contacts summary. Categories (max = 100 total):

| Category | Max | Derivation |
|---|---|---|
| Existing authority | 20 | authority.score / 100 × 20; unmeasured when authority is null |
| Website readiness | 20 | 6 assessment items (indexable, dedicated site, services clear, credentials, neighborhood content, structured data), equal split over **answered** items; unmeasured when none answered |
| Evidence availability | 15 | signals with source URLs: transaction kinds 5 · notable deals 3 · review footprint 3 · market report 2 · awards/licenses 2; provenance-factored |
| Third-party opportunity | 20 | share of the run's cited domains whose type is attainable (portal, directory, review, social, video) × 20; unmeasured without citations |
| Competitive difficulty | 15 | 15 × max(0, 1 − dominantRivals/3), dominant = benchmark recommendation rate ≥ 0.5; unmeasured without a benchmark |
| Ability to implement | 10 | 4 assessment items (control, publishing, marketing, reviews) at 2 each + reachable decision-maker (primary contact with email) at 2 |

- **Raw fixability** = 100 × Σ measured points ÷ Σ measured max — a rate over what was
  measurable, not a penalty for what wasn't.
- **Data confidence** = 0.6 × (measured max ÷ 100) + 0.4 × mean provenance factor of
  contributing signals (1 when no signals contribute, coverage term still applies).
- **Adjusted fixability** = raw × confidence. All three shown separately.
- Hard flags (each `{flag, explanation}`): `unverifiable_authority` (signals exist,
  none verified/publicly-sourced with a URL), `no_local_evidence` (no local-scope
  signals), `already_dominant` (valuable visibility ≥ 70), `insufficient_sample`
  (organic responses < 6), `restrictive_website_control` (website_control = no),
  `unobtainable_sources` (measured attainable share < 0.2), `reputation_concern`
  (assessment item yes → `needsReview: true`).

## 4. Final score — `lib/prospects/final-score.ts` + service writer

Components (each 0–100 or null): `commercial_authority` = authority score ·
`visibility_gap` = clamp(gap, 0, 100) · `adjusted_fixability` · `competitor_advantage`
= 100 × (1 − top rival recommendation rate) · `buying_signals` = null (lands Phase F —
weight redistributes, breakdown says "not measured") · `contactability` = deterministic
rubric over contacts (primary contact 40 · email on record 30 · preferred channel 10 ·
provenance verified/publicly-sourced 20; **0 with a flag when the account or primary
contact is do-not-contact**; null when no contact data exists at all).

`computeProspectScore(user, {prospectId})`: assembles components, applies the active
`prospect-final` weight set via `weightedComposite`, multiplies by fixability data
confidence, and stores `qualification_score` (rounded) + `qualification_breakdown`
(components, weights, weight-set version, fixability categories + flags, computed_at,
computed_by, versions) — transactional, audited, activity-logged.

`overrideProspectScore(user, {prospectId, score, reason})`: admin/operator override
with a required reason, stored in the override columns, audited; clearing an override
is likewise audited. The list and detail views show the override distinctly with its
reason — the computed score is not erased.

## 5. UI

- Prospect detail: "Prospect score" section — final score (or override, labeled, with
  reason), component table with weights and null notes, fixability categories with
  points/max/evidence, hard flags, data confidence, compute/recompute + override
  actions; assessment checklist dialog (11 items, yes/no/unknown + note).
- Prospect list: score column (override shown flagged); `listProspects` gains a
  `minScore` filter.

## Acceptance criteria

- [x] Every fixability category has known-answer unit tests, including its unmeasured
      state; raw/confidence/adjusted verified separately; every hard flag has a
      triggering and a non-triggering test.
- [x] Final score: weight redistribution over null components; confidence multiplier;
      weight-set switching changes the composite (integration); breakdown explains
      every number (components, weights, versions, flags).
- [x] Override requires a reason, is audited, and never erases the computed score.
- [x] Assessments are upserts with recorded identity; unknown ≠ no.
- [x] Migration 045 up/down; seeded weight set sums to 1 and is active.
- [x] Full suite, typecheck, lint, build green; client scoring untouched.
