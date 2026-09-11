# Spec 133 — Acquisition control panel (Analyze tab)

**Audience:** operator only (`/prospects/dashboard?view=analyze`). Nothing here is client- or prospect-visible.

## Why

The Analyze tab pooled every cohort into audit-view and open-signal rates built for the audit-link era. The operator now runs one customer-acquisition experiment (competitive-mismatch Touch 1 with T2/T3 over frozen evidence) and needs, inside thirty seconds: is it working, the positive-reply rate, live leads, the current bottleneck, T1 inventory, evidence-QA state, and today's action.

## What

One facts bundle (`lib/prospects/acquisition-facts.ts`) → one pure derivation (`lib/prospects/acquisition.ts`) → one layout (`components/prospects/acquisition-panel.tsx`). No persisted metrics, no new events, no chart library.

Hierarchy: current experiment health → bottleneck → today's priorities → live revenue opportunities → acquisition funnel → era comparison → supply/inventory → follow-up pipeline → evidence QA → ICP learnings → markets → operational losses → economics → next decision point → campaign week → Diagnostics (opens, report views, the former cohort tables).

## Semantics (acceptance criteria)

1. **Touch 1** = an allowed send whose draft chain froze `competitive_mismatch*` evidence, excluding drafts with `reply_to_id`, the report-delivery template and the correction template. The report reply to a positive lead is never a second T1.
2. **Unique T1 recipients** are prospect-unique; **delivered** = not hard-bounced (suppression entry OR contact DNC `hard_bounce%`). Positive-reply rate = positive prospects / delivered.
3. **Reply classification** = the latest row recorded for a message (same prospect + received time); `out_of_office` is not a human reply.
4. **T2/T3** come from `sequence_id` + `touch_number`; **corrections** and **founder replies** are counted apart and never enter T1/T2/T3. Replies are "after Touch N" (last touch before them), never caused by it.
5. **Era 1** = contacted prospects with no Touch 1; shown beside Era 2, never pooled.
6. **QA fixtures** (`QA131*` markets/launches/projects) and archived rows never count; signed fixture engagements are not clients.
7. **Status label** is deterministic: INSUFFICIENT DATA under 30 delivered; HEALTHY with a client or ≥5 positives at ≥2%; PROMISING at ≥2% with <5 positives; WATCH at 1–2%; WEAK under 1%.
8. **Inventory**: ready = approved, unsent, unslotted, no send error; scheduled = approved and slotted; runway = ceil(inventory / (cap − headroom − follow-up load per day over the next 5 business days)); zero inventory → 0 days.
9. **Bottleneck** rules fire in a fixed order (data integrity → deliverability → supply → follow-up pipeline → T1 reply rate → reply to conversation → report consumption → conversation to offer → offer to client); primary = first, secondary = second. Supply names CONTACT VERIFICATION when that is the biggest sourcing drop.
10. **Evidence QA** shows accurate / count-corrected / material / no-longer-eligible / human review / paused correction sequences; ATTENTION REQUIRED when a no-longer-eligible sequence is active or a corrected claim is unresolved (no correction sent, sequence still open, no positive reply).
11. **Funnel stages** that are derived proxies (offer presented) are labeled NOT FULLY INSTRUMENTED; report/conversation stages under 5 read INSUFFICIENT SAMPLE.
12. **ICP cuts** are the preregistered three (recommendations 0 vs ≥1, competitor rank #1 / top 3 / other, agent vs team); rows under 10 read SMALL SAMPLE; the hypothesis never moves past POSSIBLE under 5 positives.
13. **Opens** are diagnostics only (ANY_OPEN vs LIKELY_HUMAN_OPEN), never a hero metric or a lead rank.
14. **Mobile** shows hero, bottleneck, priorities, opportunities, inventory and decision point; full tables are desktop-only; no horizontal page scroll (`tests/e2e/mobile.spec.ts`).

## Tests

`tests/unit/acquisition.test.ts` (rules 1–12), `tests/integration/acquisition-facts.test.ts` (fixture exclusion, T1 identity against the ledger), `tests/e2e/mobile.spec.ts` (rule 14).
