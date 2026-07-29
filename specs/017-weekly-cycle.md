# Spec 017 — Automated Weekly Cycle

> Status: done (2026-07-29)
>
> **Live: the cron started a real cycle and the worker drove it to
> completion unattended** — reused this week's existing scheduled run
> rather than double-spending, ran gap analysis (0 new; already analysed,
> idempotency working), found 6 new accuracy findings, and left a weekly
> pulse DRAFT. The step log reads: cycle created → benchmark → analyzing →
> gap findings: 0 → accuracy findings: 6 → drafting → completed.
>
> Two bugs the tests caught first: `week_start` returns a Date from Postgres
> where the report schema wants a YYYY-MM-DD string (the cycle's own step
> log diagnosed it — "pulse not drafted: Expected string, received date"),
> and a fixture that named a company the mock answers never mention, which
> made the review-gate test pass for the wrong reason.
> Depends on: specs/003 (runs) · 004 (review gate) · 009 (gaps) ·
> 015 (accuracy) · 016 (cadences) · docs/17 (agency operations)
> Branch: feat/ci-and-cycles

## Goal
Run the Monday-to-Monday operating cycle for **every client** without
clicking through five screens per client — while never letting automation
make a judgement a human owes the client.

## The contract: automate work, stop at judgement
Automation performs every step that is mechanical and reversible:
baseline run → parse → score → gap analysis → accuracy analysis → weekly
pulse **draft**.

Automation **stops and notifies** — never guesses — when:
- the review queue is non-empty (classifications need a human; scoring is
  already blocked by docs/06 and the cycle must not "clear" it),
- the run failed or came back partial,
- the project has no subject or no frozen baseline set,
- a draft report would contain uncited numbers (the evidence gate).

Publishing a report, approving a task, and shipping content stay manual.
The cycle produces a *draft* pulse and a full attention queue; the operator
reviews and sends.

## Mechanism (no new infrastructure)
A `cycle_runs` row per (project, week) tracks a small state machine, and a
self-rescheduling `advance_cycle` job drives it: each tick inspects the
current state, does the next mechanical thing, and either finishes,
re-enqueues itself with `run_after` (waiting on async work), or halts with a
reason. This reuses the existing queue's leases, retries, and crash
recovery rather than adding a workflow engine (DECISIONS: revisit only when
the queue genuinely cannot express the flow — a linear state machine can).

States: `started → running_benchmark → analyzing → drafting → completed`,
plus terminal `halted` (with `halt_reason`) and `failed`.

Idempotency: one cycle per (project_id, week_start) enforced by a unique
index; re-entering a state is a no-op if its work already exists (e.g. a
scored run for the week, or an existing draft for the period).

## Cron
`POST /api/cron/weekly-cycle` (shared secret) starts a cycle for every
active project with a configured baseline. Safe to fire repeatedly — the
unique index makes a second call in the same week a no-op.

## Acceptance criteria
- [ ] One call starts cycles for all eligible clients; a repeat call in the
      same week creates nothing new.
- [ ] A cycle waits for the benchmark to be scored before analysing.
- [ ] A non-empty review queue halts the cycle with a clear reason and a
      notification — it never confirms classifications.
- [ ] A failed/partial run halts the cycle rather than reporting on it.
- [ ] A completed cycle leaves a weekly-pulse DRAFT (never published).
- [ ] Cycle state is visible per client and on Today.
- [ ] Tests cover: happy path, review-queue halt, failed-run halt,
      idempotent restart, and crash resumption mid-cycle.

## Out of scope
Auto-publishing reports, auto-approving tasks, auto-clearing review (all
require judgement), and cross-client scheduling policy beyond "weekly".
