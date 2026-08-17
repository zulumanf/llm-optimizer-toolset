# Spec 081 — Buying-Signal Research: The When, Not Just the Who

> Status: implemented — acceptance criteria verified 2026-08-17
> Depends on: specs/079 (enrichment pipeline — this rides it), specs/039 (buyingSignals score component), docs/12
> Branch: feat/081-buying-signal-research

## Why

The `buyingSignals` score component is null for every prospect — the one
ingredient nothing measures, and the only one that says WHEN to reach out
rather than who. The platform already has the vocabulary
(`BUYING_SIGNAL_KINDS`: brokerage_move, team_expansion, media_activity,
new_development_listings…), the manual entry dialog, and the recency-decay
scoring — what's missing is a feed.

## Design

**Rides spec 079's single call — not a second one.** The enrichment
question gains a `recentDevelopments` section (last ~90 days, mapped to
the platform's signal kinds) whenever the prospect's buying-signal
research is stale (> `SIGNAL_FRESHNESS_DAYS` = 30 since the last
buying-signal proposal). So: still ONE call per prospect; a prospect
missing nothing else but due for a signal refresh gets a signals-only
question; fresh-everything stays zero-cost.

- Result schema gains `recentDevelopments: [{kind, headline,
  date(YYYY-MM-DD)|null, sourceUrl|null}] | null`; unknown kinds map to
  `other`, never dropped silently.
- Staged as `enrichment_proposals` kind `buying_signal` (migration widens
  the check constraint); approval → existing `addBuyingSignal`
  (provenance `publicly_sourced` with a citation, else `ai_inferred`;
  `observedOn` = the found date or today). Rejection as usual. The
  existing proposals panel renders them.
- **Periodic, self-regulating**: the worker's daily tick (the
  includeHealth cadence) runs the enrichment sweep over active launches as
  the system principal. The 30-day freshness windows make the cadence
  self-limiting — zero API calls on 29 of 30 days per prospect; staged
  proposals only, approval always human (PRINCIPLES #8). Spend stays
  ledgered under the daily ceiling.

## Out of scope

Score changes (buyingSignalScore is untouched — it starts working the
moment signals exist); listing-count scraping (needs a data feed, not an
LLM); auto-approval.

## Acceptance criteria

- [x] Question includes the developments section only when stale; a
      prospect fresh on everything stays zero-cost (unit + integration).
- [x] Found developments stage as buying_signal proposals; approval
      materializes via addBuyingSignal with honest provenance and
      observedOn; unknown kinds map to other (integration, fake caller).
- [x] The sweep is freshness-self-limiting — a repeat sweep re-queries
      nothing (integration); the daily-tick wiring is composition over the
      tested sweep, verified in production.
- [x] After approving a signal, the prospect's score gains a non-null
      buyingSignals component (integration).

## Definition of done

Criteria pass · suites green · lint/typecheck clean · migration
reversible · docs/05 + DECISIONS updated · first real sweep reported.
