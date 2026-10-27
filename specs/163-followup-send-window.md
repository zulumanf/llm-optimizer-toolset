# Spec 163 — Follow-ups leave only inside the recipient-local window (G3)

> Status: implemented (2026-10-26), not committed
> Depends on: specs/127, specs/159
> Branch: feat/162-workflow-send-gates (stacked on 162)
> Audience: operator (internal). Affects prospect email timing only.

## Goal

Close gap G3 from spec 159. Touch 2/3 drafts are slotted into a
recipient-local business-day morning window (`FOLLOWUP_SEND_WINDOW`,
09:03–10:28), but `drainScheduledSends` sends anything whose
`scheduled_send_at` has passed. After a pause (worker stopped, outbound off),
a touch up to 24 h late leaves whenever the drain next runs, e.g. 03:00 local.

## Decisions

- **D1 — Window check at dispatch.** In phase 1 of `drainScheduledSends`,
  after the stale-claim and spec 159 D3 (too-late) checks, a draft with a
  `sequence_id` is claimed only if, in the sequence's `timezone`, `now` is a
  business day, on the same local date as `scheduled_send_at`, and between
  `startHour:00` and `startHour:00 + maxOffsetMinutes +
  FOLLOWUP_DISPATCH_GRACE_MINUTES` (30) local.
- **D2 — Otherwise defer, don't send.** The draft's `scheduled_send_at` moves
  to `slotFor(sequence, now)` (the next window slot, same deterministic
  offset). No claim, no attempt counted. One audit row
  (`prospect.followup_send_deferred`) and one activity row record it. All
  send-time gates (follow-up preflight, sequence age, QA) still run when it
  leaves.
- **D3 — Pure decision.** `followupDispatchDecision(seq, scheduledAt, now)` in
  `lib/prospects/followups.ts` returns `{ send: true }` or
  `{ send: false, deferTo }`. Unit-tested without a database.
- More than 24 h late still parks (spec 159 D3). Touch 1, replies and
  handoffs are unchanged (not sequence drafts).

## Acceptance criteria

- [x] Due inside the window → send.
- [x] Same local day, after the window end + grace → defer to the next
      business-day slot.
- [x] Previous local day (< 24 h late), before the window → defer to today's slot.
- [x] Weekend → defer to Monday's slot.
- [x] Drain: an out-of-window sequence draft is not claimed, gets the new
      `scheduled_send_at`, and is reported as `deferred`.
- [x] `npm run typecheck`, lint, tests pass; `DECISIONS.md` entry;
      `docs/deployment.md` G3 marked closed.
