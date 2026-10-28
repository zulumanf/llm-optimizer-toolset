# Spec 169 — Market-leader email covers "increase your ranking" teams

> Status: implemented (2026-10-28), not committed
> Depends on: specs/168
> Audience: PROSPECT (cold email)

## Why

Positioning (founder, 2026-10-28): the go-to for (A) teams out-recommended by
lower-producing teams — mismatch v2 — and (B) teams that want to rank higher.
Spec 168 excluded every prospect with 3+ recommendations, i.e. segment B.

## Rule (`leaderClearlyAhead`, pure, `LEADER_THRESHOLDS`)

- Nearly absent (≤ 2 recommendations): leader ≥ 6 ahead (was 10).
- Already recommended (≥ 3): leader ≥ 10 ahead **and** ≥ 2× the prospect, so
  "far more often" stays literally true.
- Same entity level, benchmark ≤ 14 days, everything else from spec 168.
- Used by `evaluateLeader` and by draft QA at approve and send.

## Acceptance criteria

- [x] Unit tests for both segments and their boundaries.
- [x] Full suite, lint, typecheck pass.
