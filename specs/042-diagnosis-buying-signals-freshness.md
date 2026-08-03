# Spec 042 — Diagnosis Layer, Buying Signals, and Data Freshness

Phase F of `docs/implementation-plan.md`. Target-pipeline requirements 13 (why is this
prospect underrepresented — typed diagnoses with evidence, confidence, affected
prompts, competitors, suggested action), 15 (buying signals — every one with a source
and a date), and the freshness section (configurable windows, stale warnings where
evidence is consumed).

## Principles applied

- **Diagnoses are derived on read** (spec 038 pattern) from data the platform already
  trusts: current-revision mentions, response citations classified by the existing
  source classifier, authority signals, operator assessments, and the tracked-company
  registry. Version constant `prospect-diagnosis-v1` shown with the output.
- **Absence of evidence is labeled as such.** "No review footprint recorded" is a
  low-confidence diagnosis about *our research*, phrased that way — never presented
  as a measured fact about the prospect.
- **Buying signals are operator-recorded facts** with a **required source URL and
  observed date** (the target's hard rule). Their score contribution is deterministic
  and decays with age; zero recorded signals = "not measured" (weight redistributes),
  never a fake zero.
- **Staleness warns and gates, never silently blocks or silently passes.** Publishing
  an audit from a stale benchmark requires an explicit acknowledgment; the refusal
  message says exactly how old the run is.

## 1. Diagnosis — `lib/prospects/diagnose.ts`

Pure `deriveDiagnoses(inputs)` + read-side assembly `diagnoseProspect(prospectId)`
(latest linked benchmark, same data paths as valuable visibility). Each diagnosis:

```ts
{ key, title, explanation, confidence, suggestedAction,
  affectedPrompts: string[],        // up to 5 prompt texts
  competitors: string[],            // names, when relevant
  citedDomains: {domain, citations}[] }  // when relevant
```

Computable diagnoses (trigger conditions in the module, each unit-tested both ways):

| Key | From | Confidence |
|---|---|---|
| `no_organic_visibility` | 0 organic mentions across the run | sample-scaled |
| `mentioned_never_recommended` | organic mentions > 0, recommendations = 0 | sample-scaled |
| `missing_from_cited_sources` | run cites sources; prospect's domain never cited | sample-scaled |
| `competitors_dominate_sources` | ≥ 50% of citations resolve to tracked competitors' domains | sample-scaled |
| `missing_from_high_intent_prompts` | absent from every response of tier-1/2 (or recommendation-category) prompts while present elsewhere in the run | sample-scaled |
| `entity_ambiguity` | another tracked company's normalized name collides with the prospect's | 0.9 |
| `unstable_sample` | organic responses < 6 | 1.0 (it is a fact about the sample) |
| `website_not_indexable` | assessment says no | 1.0 (operator-stated) |
| `weak_structured_data` | assessment says no | 1.0 |
| `no_review_evidence` | no review_footprint signal recorded | 0.4 — absence of research, said so |
| `no_media_evidence` | no press_mention signal recorded | 0.4 |

Suggested actions are a static map (deterministic, reviewable). UI: "Diagnosis"
section on the prospect detail between the gap and contacts.

## 2. Buying signals — migration 048 + `lib/prospects/buying-signals.ts`

```sql
create table prospect_buying_signals (
  id, prospect_id →, kind check in (brokerage_move, team_expansion,
    hiring_marketing, website_redesign, new_market_launch,
    new_development_listings, media_activity, new_leadership,
    paid_marketing_active, seo_pr_investment, other),
  label text not null, source_url text not null,      -- required: no source, no signal
  observed_on date not null,                          -- required: no date, no signal
  provenance, confidence numeric, notes, created_by/at, archived_at
);
```

Service: `addBuyingSignal` (zod enforces source URL + date), `archiveBuyingSignal`,
`listBuyingSignals`. Pure scorer `buyingSignalScore(signals, today)`: per active
signal `25 × provenance factor × recency factor` where recency = 1.0 within the
freshness window, 0.5 within 2×, 0 beyond; capped at 100; **null when no signals
exist**. Wired into `final-score.ts` as the `buyingSignals` component (replacing the
Phase-C placeholder null). UI: card on the prospect detail with add/archive and
stale/decayed labels.

## 3. Freshness — `lib/prospects/constants.ts` + gates

```ts
export const FRESHNESS_WINDOWS_DAYS = {
  benchmark: 90, authoritySignal: 365, buyingSignal: 180,
  contact: 180, assessment: 365,
} as const;
```

Helper `staleness(observedAt, windowDays, now)` → `{ageDays, stale}` (pure, tested).
Surfaces:

- **Benchmark**: stale badge (with age) on the prospect detail benchmark section.
- **publishAudit**: a stale benchmark **fails closed** with the run's age in the
  message unless the caller passes `acknowledgeStale: true`; the acknowledgment is
  recorded in the audit-log detail.
- **Authority signals**: stale badge per signal (retrieved_at, else created_at).
- **Buying signals**: decayed/expired labels matching the scorer's recency factor.

## Acceptance criteria

- [x] Every diagnosis key has a triggering and a non-triggering unit test; evidence
      fields populated; absence-of-research diagnoses carry low confidence and honest
      wording.
- [x] Buying signals refuse creation without a source URL or observed date; scorer
      known-answer tests incl. decay bands and the null-when-none rule; final score
      picks the component up (integration) and redistributes when absent.
- [x] Stale benchmark blocks publishAudit with age in the message; acknowledgment
      publishes and is recorded; fresh benchmarks unaffected.
- [x] Staleness helper known-answer tests; badges render from real timestamps.
- [x] Migration 048 up/down; full gates green.
