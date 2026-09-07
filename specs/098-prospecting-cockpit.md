# Spec 098 — Prospecting Cockpit (intent, attribution, engagement)

> Amended by spec 099 (intent guardrails): weights, labels, cadence in
> business days, the Unresolved label, and the unattended send gate. Where
> the two disagree, 099 wins.

**Status:** Implemented 2026-08-20
**Branch:** `feat/097-city-pipeline` (stacked on spec 097's uncommitted work)
**Supersedes:** the hero/queue/funnel sections of spec 095; keeps its
honesty rules (ledger-derived contacted, human-like views only, opens as an
upper bound).

## Questions the page answers, in order

1. Who needs my attention? — `Act today`: prospects ranked by priority tier
   (conversation → CTA → high authority + high intent → repeat activity →
   deep engagement → one visit → follow-up due → silent → uncontacted).
2. What happened? — cohort KPIs + funnel with explicit denominators.
3. Where is it leaking? — "possible bottleneck" only when ≥10 contacted and
   ≥2 days old; otherwise "not enough data".
4. Is the machine healthy? — Gmail auth (P0 banner when not `active`), 24h
   transport capacity, scheduled, suppression, parked sends, research queue
   (collapsed: count + top 3 by quality + `View all`).
5. Pipeline table, priority-sorted, lean filters (intent / activity /
   outreach / sales) + window (`today|7d|30d|batch`) + market selector.

## Concepts kept apart

- **Quality** = `coalesce(qualification_override, qualification_score)`;
  high authority at ≥ 70. Never recomputed here.
- **Intent** = what the AUDIT PAGE received after the first allowed send.
- **Stage** = recorded pipeline stage; reply / meeting / proposal / won
  derive from stage history (`audit_sent`/`audit_viewed` are NOT replies).

## Metric definitions (lib/prospects/intent.ts)

- Contacted: prospects with ≥1 allowed send in `prospect_outreach_sends`.
- Audit view: a `prospect_audit_views` row that is not internal, has a
  non-script user agent, is off `INTERNAL_VIEW_IPS`, and is outside the
  120s post-send scanner window.
- Post-outreach view: view at/after the prospect's first allowed send.
- Audit viewers: contacted prospects with ≥1 post-outreach view.
- Session: distinct beacon `session_id` among post-outreach views; a view
  with no beacon counts as its own session. Repeat = ≥2 sessions.
- Browser identities: distinct beacon `visitor_id`; ≥2 = "possible
  additional visitor" (never "forwarded internally").
- Engaged time: max cumulative seconds per session, summed.
- Meaningfully engaged: ≥30s engaged OR ≥75% scroll OR evidence expanded
  OR competitor section viewed OR CTA clicked.
- Time to first view: first post-outreach view − first send (seconds).
- Outside-ledger activity: human-like views on a never-contacted prospect
  (sent another way). Ranked in Act today, excluded from the funnel.

## Attribution

`attributed_link` (post-outreach view carried a branded-link key — spec 076
link = the emailed link) · `unattributed_external` · `pre_outreach_only` ·
`none`. Link-level, not send-level; never an identity claim.

## Intent score (INTENT_WEIGHTS)

view +2 · ≥30s +1 / ≥60s +2 (replaces) · ≥75% +2 · competitor +1 ·
evidence +1 · CTA +3 · repeat +3 · 3+ sessions +2 · 2nd identity +1 ·
reply +5 · meeting +10. Labels: Cold 0 · Aware 1–2 · Interested 3–5 ·
High intent 6–9 · Engaged ≥10 · Opportunity = any reply/meeting.

## Follow-up due (FOLLOW_UP_RULES)

Contacted, no reply, <3 touches; 3 days after the last send with no
activity, or 1 day after audit activity that followed the last send.
Recommendation only — nothing sends.

## Data model (migration 090, additive)

- `prospect_audit_views` + `link_key`, `referrer` (stamped at insert).
- `prospect_audit_engagement_events` (view_id, session_id, visitor_id,
  kind ∈ engaged_time|scroll|section_viewed|evidence_expanded|cta_clicked,
  value, target, occurred_at), insert-only.

## Beacon (components/audit/engagement-beacon.tsx → POST /api/audit-signal)

sendBeacon, batched every 5s + pagehide; milestones fire once; engaged
time counts only visible + active (30s idle cutoff); sections via
`data-signal-section`, drawers via `data-signal-evidence`, CTA via
`data-signal-cta`. Always 204; internal views never grow rows; no
fingerprinting, no heatmaps, no recording.

## Tests

`tests/unit/prospect-intent.test.ts` (scoring, thresholds, attribution,
follow-up, priority order, denominators, diagnostics) and
`tests/integration/prospect-dashboard.test.ts` (beacon route, exclusions,
facts query, cockpit, timeline, machine health).
