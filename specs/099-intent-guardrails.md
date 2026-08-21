# Spec 099 — Intent guardrails before automated outreach

Amends spec 098. Triggered by an operator review of the live cockpit on
2026-08-20: the system was inferring more intent than the data supported
(four unattributed sessions → "High intent"; two shallow sessions ranked
above one deep read). Nothing here adds a metric — it makes the existing
ones more conservative and names what is still missing before any
follow-up may send without a human.

## Verified against the code (what was and wasn't true)

| Review claim | Finding |
|---|---|
| Unattributed activity reaches High intent | True. view 2 + repeat 3 + 3 sessions 2 = 7 ≥ 6. |
| Repeat outranks depth | True, in the score (repeat +3 vs ≥60s +2), the tier (4 vs 5), and the action. |
| Contacted = "allowed", not "transmitted" | `allowed` rows are written only AFTER `channel.dispatch` returns inside the same transaction; a dispatch throw rolls the row back. So allowed ≡ transmitted (gmail/mock) or operator-attested (manual). The label was misleading, the math was not. |
| Timestamps | Real bug. `toLocaleString(undefined, …)` runs on the server, so production rendered UTC with no zone label ("3:05 PM" was 11:05 AM ET). |
| Follow-up cadence | 3 calendar days silent / 1 day after activity, cap 3 touches. |
| Reply detection | Manual: a stage change on the prospect page. No Gmail inbox ingestion exists. Worse: the send gate did not check stage, so a scheduled follow-up would transmit after "replied" was recorded. |
| Filter links drop each other | False. `href()` merges every active param; filters compose. |
| Median time-to-view at n=1 | True; shown without sample size. |

## Rules (lib/prospects/intent.ts)

1. **Unattributed activity cannot produce intent.** A prospect with no
   allowed send (`outsideLedger`) gets the label `Unresolved` ("external
   activity — attribution unresolved"), regardless of score. It stays in
   Act today (tier 4, so a human resolves the ledger) but never reads as
   High intent, never enters the funnel.
2. **High intent needs a verified strong signal.** `High intent` and
   `Engaged` require `meaningfullyEngaged || ctaClicked`. Session count
   alone caps at `Interested`. Replies/meetings remain `Opportunity`.
3. **Depth outranks repetition.** Weights: repeat +1 (was +3), 3+ sessions
   +1 (was +2). Tiers: conversation → CTA → high authority + high intent →
   deep engagement → multiple sessions → one visit → follow-up due →
   contacted → not contacted. Recommended action follows the same order.
4. **"Multiple sessions", never "repeat visitor".** Without a durable
   visitor identity the sentence is "N sessions"; `repeat` stays a boolean
   fact (≥2 sessions) but every rendered string says "multiple sessions".
5. **Meaningful engagement** = ≥30s engaged OR ≥75% depth OR CTA OR
   (evidence expanded or competitor section) AND ≥10s engaged. An
   interaction with no dwell is not meaningful.
6. **Follow-up cadence in business days** (Mon–Fri, operator timezone):
   3 business days silent; 2 business days after audit activity. Cap 5
   touches (initial + 3 follow-ups + close-loop). Still recommendation
   only — nothing in this spec sends.
7. **Latency stats carry n.** Median time-to-first-view renders as
   "4m 12s · n=1" and is hidden below `LATENCY_MIN_SAMPLE = 5`.

## Send gate (lib/prospects/service.ts)

New check `stage_allows_outreach`: refuse when the prospect's stage is
≥ `replied` or an exit stage. This is the minimum reply safety: once a
human records a reply, no queued draft can transmit. The refusal is
ledgered like every other.

## Rendering

- All timestamps render through `formatOperatorTime` (lib/format.ts) with
  an explicit `OPERATOR_TIMEZONE` (America/New_York) and a zone suffix.
  Storage stays UTC.
- Cohort panel states scope: "Contacted = transmitted sends (gmail/mock
  dispatched, or a human-recorded manual send)". Data-confidence lists
  "N sessions on never-contacted audits excluded from campaign metrics".
- No-launch + batch reads "All markets · all recorded sends".

## Out of scope — separate spec required before autonomous follow-ups

- **Gmail inbound ingestion**: poll the connected mailbox, match
  In-Reply-To / thread id / sender to the send ledger, apply
  `dom.apply_reply_signal`, cancel scheduled drafts. Opt-out and bounce
  ride the same path.
- **Sent-mail reconciliation**: ingest the Gmail Sent folder, match
  recipient → contact → prospect, ledger `channel='manual_detected'`.
  Until then, a manual send is recorded by the operator via the manual
  channel on the prospect page (this is how the Team Moza send is fixed).

## Tests

Known-answer updates in tests/unit/prospect-intent.test.ts for every rule
above; copy discipline in tests/unit/dashboard-copy.test.ts for the
"multiple sessions" and transmitted wording; gate refusal covered by the
existing send-gate integration pattern.
