# Spec 095 — Prospecting Dashboard (the operator's morning screen)

**Status:** In progress
**Branch:** `feat/095-prospecting-dashboard`
**Source:** Operator request 2026-08-20, the day the first real outreach
batch (12 emails) went out. The operator's questions, in the order they ask
them each morning, ARE the page:

1. **"Did anything happen?"** — engagement since yesterday: email opens,
   audit views, replies recorded. The dopamine row, but honest: opens
   labeled upper-bound; audit views are the intent signal.
2. **"Who do I act on right now?"** — an action queue, not a report:
   prospects who viewed their audit recently (hot — follow up), contacted
   with zero engagement after N days (nudge or park), sends parked/blocked,
   drafts awaiting approval, prospects missing a contact email, audits
   expiring within 7 days (the 45-day default is now live on 17 audits).
3. **"How's the funnel?"** — derived from MEASURED events, never the stage
   column (all 33 prospects read "identified" while 12 were emailed today —
   recorded stages lag reality, and the mismatch itself is surfaced as an
   action item): active prospects → audits published → contacted (allowed
   send in ledger) → opened (upper bound) → audit viewed (external) →
   replied → meetings → contracted, with counts and stage-to-stage rates.
4. **"Is the machine healthy?"** — daily send cap used, Gmail connection
   status, scheduled sends pending, suppression count, worker heartbeat.

## Where

`/prospects/dashboard`, linked from the Prospects page header (internal
surface — ui-conventions; dataviz rules for tiles/bars). Server component,
one load; no client JS beyond existing primitives.

## Data honesty rules

- Opens render with the upper-bound hint (mail-client prefetch inflation).
- Audit views EXCLUDE internal views AND script-like user agents
  (curl/node/python/go-http/undici/bot) — today's QA fetches recorded
  external view rows; a dashboard that counts our own scripts as prospect
  interest lies to the operator. Label: "human-like external views."
- "Not measured" over zero everywhere a signal cannot be distinguished.
- Funnel counts are event-derived with each stage's source named in a
  tooltip/hint (ledger, opens table, views table, activities).

## Queries (lib/prospects/dashboard.ts — db access stays out of the page)

One module exporting typed read functions; no new tables, no writes.

## Acceptance criteria

- [ ] Page renders the four blocks above from live data; every async state
      (loading/empty/error) present; layout-consistency test passes.
- [ ] Funnel numbers match hand-run SQL on the same definitions (integration
      test with seeded events).
- [ ] Script-agent views excluded (test: a curl UA view does not count).
- [ ] Opens tile carries the upper-bound label (copy test).
- [ ] Lint, typecheck, full suite pass.
