# Spec 062 — Intervention Lifecycle & Graded Retest Comparability

## Why

The 2026-08-12 whole-OS audit (operator brief "Discover → … → Learn") found the
two weakest links in the operating loop sit on the same table:

1. **`interventions` has no lifecycle.** Status is inferred from
   `intervention_runs` counts; nothing can be blocked or owned as work, the
   execution workspace is a shipped-log, the attention queue cannot say
   "intervention blocked", and the future case-study engine has no state to
   gate on. Ironically `citation_opportunities` (spec 060) carries the exact
   validated-transition-map design the parent concept lacks.
2. **Comparability is binary and one-dimensional.** `verdict.ts` emits
   `not_comparable` only on scoring-version mismatch, while the instrument
   data that actually drifts — provider set, model string, repetitions,
   baseline count — is already stored on `runs.providers` (spec 058 keeps
   `request_params` per response) and simply never composed. Every retest
   verdict is asserted over unexamined instrument drift: the single
   highest-risk correctness gap in the platform's core promise.

Scope note: the brief's PROPOSED/APPROVED/IN_PROGRESS pre-ship pipeline
already EXISTS as `tasks` (suggested → approved → in_progress → done) linked
via `interventions.task_id`. This spec does not duplicate it. The
intervention's own lifecycle begins where the task's ends: at ship time.

## 1. Intervention status

Migration 072 adds to `interventions`:

- `status text not null default 'shipped'` with CHECK over
  `('shipped','retest_pending','blocked','retested','cancelled')`
- `blocked_reason text` + CHECK `status != 'blocked' or blocked_reason is not null`
- `status_changed_at timestamptz not null default now()`
- partial index on `(status)` where `archived_at is null`

Meaning (observable states, not aspirations):

| status | means |
|---|---|
| `shipped` | recorded; no retest scheduled (typically: no baseline existed) |
| `retest_pending` | post runs scheduled or started, none completed yet |
| `retested` | at least one post run completed — verdicts exist. Terminal. |
| `blocked` | retest cannot proceed; requires a reason. Human-resolved only. |
| `cancelled` | measurement abandoned deliberately, with audit trail. Terminal. |

Transition map (`lib/attribution/lifecycle.ts`, client-safe pure module,
`LIFECYCLE_VERSION = "intervention-lifecycle-v1"`):

```
shipped        → retest_pending | blocked | cancelled
retest_pending → retested | blocked | cancelled
blocked        → shipped | retest_pending | retested | cancelled
retested       → (terminal)
cancelled      → (terminal)
```

Writers:
- **createIntervention** sets the initial status from what it just did:
  `retest_pending` when post runs were scheduled, else `shipped`.
- **System sync** (`syncInterventionStatuses`, ridden by the automation
  heartbeat next to `measureDueActionOutcomes`): moves
  `shipped/retest_pending → retested` when a completed/partial post run
  exists, `shipped → retest_pending` when a post is scheduled. Idempotent;
  never unblocks and never cancels.
- **startScheduledRun** skip paths (archived instrument, no baseline config)
  set `blocked` with the skip reason instead of only logging — a silently
  skipped retest is exactly the failure the attention queue must see.
- **Operator action** `setInterventionStatus` (server action): block (reason
  required), unblock (back to the observed state), cancel. Every change is
  transition-validated and audit-logged.

Backfill in the migration mirrors the sync derivation: completed post run →
`retested`; else any post run or queued `start_scheduled_run` job →
`retest_pending`; else `shipped` (the default).

## 2. Graded comparability

`lib/attribution/comparability.ts` (pure, known-answer-testable,
`COMPARABILITY_VERSION = "comparability-v1"`):

```
assessComparability(baselines: InstrumentSnapshot[], post: InstrumentSnapshot)
  → { grade: 'high'|'medium'|'low'|'not_comparable', reasons: string[] }
```

`InstrumentSnapshot` = prompt-set version id, `ProviderConfig[]`
(provider/model/repetitions), and the scoring versions present on the run's
scores. Rules, worst triggered rule wins, every triggered rule contributes a
reason string:

- **not_comparable**: no baselines; scoring-version mismatch or mixed
  baseline versions (the existing verdict.ts rule, restated); prompt-set
  version differs.
- **low**: provider set differs; same provider measured on a different model.
- **medium**: total repetitions differ by more than 2×; single baseline run.
- **high**: none of the above.

Integration: `interventionView` returns per-post-run
`{ runId, offsetLabel, grade, reasons }` (replacing the boolean
`instrumentChanged`, whose one consumer is the detail page). Verdicts remain
computed exactly as today — the grade contextualizes them, it never edits
them, and nothing is stored (comparability is derived-on-read like verdicts).

## 3. Surfaces

- **Interventions list** (`app/projects/[id]/interventions`): adds Status
  (badge; blocked shows its reason), Owner (from `owner_id`, spec 051), and
  Next retest (earliest queued `start_scheduled_run`). Existing columns stay.
- **Intervention detail**: status badge + block/unblock/cancel controls
  (new client component + server actions in `app/attribution/actions.ts`);
  per-post-run comparability badge with reasons replacing the single
  "instrument changed" flag.
- **Attention queue** (`lib/control-tower/queue.ts`): new source
  `intervention_blocked` — blocked, non-archived interventions, severity
  high, linked to the detail page. One source, not a notification system.

## 4. Testing

- Transition map: every allowed and forbidden edge
  (`tests/unit/intervention-lifecycle.test.ts`).
- Comparability: known-answer fixtures per rule and for grade precedence
  (`tests/unit/comparability.test.ts`).
- Migration 072 up → down → up on the local database.
- Full suite, lint, typecheck green.

## Acceptance criteria

- [ ] Migration 072 applies and rolls back; backfilled statuses match
      observable history (completed post → retested, etc.).
- [ ] createIntervention writes the correct initial status.
- [ ] Sweep advances statuses idempotently; skip paths in startScheduledRun
      leave a blocked intervention with a reason, not just a log line.
- [ ] Operator can block (reason required), unblock, cancel; forbidden
      transitions are rejected; all changes audit-logged.
- [ ] Detail page shows a comparability grade with reasons for each post run;
      list page shows status/owner/next-retest.
- [ ] Blocked interventions appear in the control-tower queue.
- [ ] Unit tests for lifecycle + comparability pass; full suite green.

## Out of scope (deliberate, from the same audit)

Pre-ship approval pipeline (exists as `tasks`), model-agreement read model,
prompt-attribute freezing/coverage metrics, findings-confidence columns,
case-study candidate detection (blocked on this spec), report-snapshot
period-comparability grading (separate read path), entity/market vocabulary
work. Each stays in the audit backlog with its own priority.
