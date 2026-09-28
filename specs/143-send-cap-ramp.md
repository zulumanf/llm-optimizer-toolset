# Spec 143 — Send cap ramp

> Status: in-progress
> Depends on: specs/091 (Gmail send channel), specs/119 (momentum scoreboard), dispatch policy v2 (PR #183)
> Branch: feat/143-send-cap-ramp

## Goal

Founder directive 2026-09-28: send 40–50 emails a day, reached by a ramp and
not a jump. The transport cap (25 per trailing 24h) and the daily Touch 1
quota (15) become a dated schedule in code, so the sender address keeps
warming while volume roughly doubles over two weeks. Every gate, planner and
dashboard reads the cap that is in force on the date in question.

## What is reused (audit result — do not rebuild)

- `GMAIL_DAILY_SEND_CAP`, `DAILY_SEND_QUOTA`, `SEND_CAP_HEADROOM`,
  `dailyBrandCap` — `lib/prospects/constants.ts`. They stay as the base step.
- The send gate check `daily_send_cap` — `lib/prospects/service.ts`
  (trailing-24h count of allowed gmail ledger rows). Unchanged in shape.
- `capAwareSlot` — `lib/prospects/followups.ts`. Same query, dated cap.
- `outreachHealth().capLimit` — `lib/prospects/dashboard.ts`, consumed by the
  brief, the acquisition panel and the assistant tool. No new field.
- `planDailyBatches` — `lib/prospects/dispatch-policy.ts`.
- `OPERATOR_TIMEZONE` — `lib/prospects/intent.ts`. Steps change at operator
  midnight.

## Database changes

None.

## New modules / Extensions

`lib/prospects/send-cap.ts` — `SEND_CAP_RAMP_VERSION = "send-cap-ramp-v1+deterministic"`.
Pure, derived on read.

| Effective (operator date) | Transport cap / trailing 24h | Touch 1 quota / day |
|---|---|---|
| base (before 2026-09-30) | 25 | 15 |
| 2026-09-30 | 35 | 30 |
| 2026-10-07 | 45 | 40 |
| 2026-10-14 | 50 | 45 |

- `sendCapStep(at)`, `gmailDailySendCap(at)`, `dailySendQuota(at)`.
- The quota stays under the cap at every step so follow-ups and founder
  replies never compete with Touch 1 for headroom (spec 119's rule).
- Raising, holding or rolling back a step is a diff to the schedule, reviewed
  like any policy constant. There is no environment override.

## UI

Minimal, operator only. Surfaces that print the cap or the quota print the
value in force today (acquisition panel "Daily cap", dashboard momentum
quota, brief cap warning).

## Edge cases

- **Trailing window across a step boundary.** The cap in force at send time
  applies to the whole trailing 24h count. On a step day the first sends see
  yesterday's volume against today's larger cap; this is intended.
- **Scheduling ahead.** `capAwareSlot` uses the cap in force at the candidate
  slot, so a follow-up planned for next week is judged by next week's cap.
- **Ledger periods spanning steps.** `campaign-ledger` capacity is the sum of
  each day's cap, not days × today's cap.
- **Dates before the first step** resolve to the base step (25 / 15), so
  historical scoreboards keep the quota that applied then.
- **Deliverability regression.** The ramp does not hold itself. A hard-bounce
  or spam-complaint problem is handled by a diff that removes or delays the
  next step. Automated holds are deferred (below).

## Acceptance criteria

- [ ] The send gate refuses the send past the cap in force at send time, with
      a ledgered refusal, and the message names that cap.
- [ ] `gmailDailySendCap` / `dailySendQuota` return 25/15 before 2026-09-30,
      35/30 from 2026-09-30, 45/40 from 2026-10-07, 50/45 from 2026-10-14,
      with the boundary at operator-timezone midnight.
- [ ] Every step has quota < cap and both are non-decreasing (test over the
      schedule, so a future edit cannot break it silently).
- [ ] No runtime module reads `GMAIL_DAILY_SEND_CAP` or `DAILY_SEND_QUOTA`
      directly except `send-cap.ts` and `constants.ts`.
- [ ] Ledger capacity for a period spanning a step equals the sum of daily caps.

## Definition of done

Acceptance criteria pass · unit tests green · lint and typecheck clean ·
DECISIONS.md entry · deployed to web and worker.

## Deferred

- Automatic hold on hard-bounce rate or spam complaints (needs bounce
  classification from spec 118, which is not implemented).
- DKIM alignment for the sending domain (DNS, operator action). Recommended
  before the 45 step.
