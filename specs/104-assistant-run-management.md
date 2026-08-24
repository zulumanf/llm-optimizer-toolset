# Spec 104 — Assistant Run Management (cancel / retry a benchmark)

> Status: ready
> Depends on: specs/096, specs/102
> Branch: feat/104-assistant-run-management

## Goal

The assistant can start a benchmark run (`start_benchmark_run`) and watch
it (`list_runs`, `get_run_status`), but a run that hangs, overspends, or
partially fails can only be handled in the /runs UI. Two confirm-tier
tools close that: cancel a pending/running run, and retry a finished
run's failed cells. Both services exist (`lib/runs/service.ts`); no
migration, no new logic.

## User stories

- As an operator, I can cancel a run from chat (confirm click) when it is
  spending against the wrong config or hanging; captured cells are kept.
- As an operator, I can retry a partial/failed run's failed cells from
  chat (confirm click) — it re-enters the worker queue and spends budget
  only on what failed.

## UI / Database changes

None.

## API (assistant tools)

| Tool | Tier | Input (zod) | Backing call |
|---|---|---|---|
| `cancel_run` | confirm | `{ run_id: uuid }` | `cancelRun` (`lib/runs/service.ts:167`) |
| `retry_failed_cells` | confirm | `{ run_id: uuid }` | `retryFailedCells` (`lib/runs/service.ts:132`) |

Tier rationale: cancel reverses a human-confirmed start (spec-102
precedent); retry re-executes cells — live provider spend.

## Validation / Edge cases

- The services' own guards surface verbatim: cancel conflicts unless the
  run is `pending`/`running` (ends `partial`/`cancelled`, captured cells
  kept — raw data is never deleted); retry conflicts while the run is
  still executing (only `partial`/`completed`/`failed` retry), resets the
  run to `pending`, and enqueues `execute_run` for the worker.
- `retry_` and `cancel_` prefixes are already covered by the spec-102
  catalog assertion.

## Acceptance criteria

- [ ] Both tools confirm-tier with summaries; catalog tests pass unchanged
      in structure (names added to MUST_CONFIRM).
- [ ] Model invocation stages a pending action and executes nothing; a
      confirmed `cancel_run` flips a running run to `partial`/`cancelled`;
      a confirmed `retry_failed_cells` flips a partial run to `pending`
      with an `execute_run` job enqueued (integration).
- [ ] Lint, typecheck, full suite pass.

## Test cases

- Unit: MUST_CONFIRM additions.
- Integration (`assistant-operator.test.ts`): seed a run per state; mint +
  confirm both tools; assert run status, job row, and audit actions
  (`run.cancel`, `run.retry_failed`).

## Definition of done

Acceptance criteria pass · tests green · lint/typecheck clean · `docs/05`
updated · demoed against seeded data.
