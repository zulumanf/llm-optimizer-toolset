# Spec 102 — Assistant Pipeline Operator ("manage what you started")

> Status: done
> Depends on: specs/091, specs/096, specs/097, docs/12
> Branch: feat/102-assistant-pipeline-operator

## Goal

Spec 096 made the assistant a *starter*: it can kick off an A→Z city
pipeline, schedule a send, publish an audit — and then can only watch.
This spec makes it an *operator* for the things it starts. Six tools close
the start-but-can't-manage hole: list all city pipelines, cancel one,
retry a failed one, view the scheduled-send outbox (including parked
sends), cancel a scheduled send, and run the audit sense-check the
publish gate already warns about. Everything stays a thin wrapper over
services; the spec-096 trust model (read / direct / confirm) decides each
tool's tier by consequence.

## User stories

- As an operator, I can ask "what pipelines are running?" and see every
  city pipeline with its status, step log tail, and error — not just one
  city at a time.
- As an operator, I can cancel a stuck or mistaken city pipeline from
  chat (with a confirm click), and an in-flight benchmark run linked to
  it stops spending budget.
- As an operator, I can retry a failed pipeline from the step it failed
  at (confirm click), instead of re-running the whole city from scratch.
- As an operator, I can ask "what's in the outbox?" and see scheduled
  sends (when, to whom, by whom) and parked sends with the reason they
  parked.
- As an operator, I can cancel a scheduled send from chat (confirm
  click) before the worker claims it.
- As an operator, I can tell the assistant to run the sense-check on a
  prospect's audit content, so the "no/stale sense-check" warning on
  `publish_audit` is actionable in the same conversation.

## UI

No new UI. All six tools surface through the existing assistant dock
(`components/assistant/assistant-dock.tsx`): the catalog is derived from
`lib/assistant/tools.ts` at module load, and confirm-tier tools reuse the
existing pending-action card (Confirm / Dismiss). Loading/empty/error
states are the dock's existing ones.

## Database changes

Migration `091_city_pipeline_operator.sql`:

- `city_prospecting_pipelines`:
  - Add `'cancelled'` to the `status` check constraint (drop + re-add).
  - Add `failed_from_status text` — the status the pipeline held when the
    tick marked it `failed`; written by `advanceCityPipelines` at failure
    time, read by retry. Nullable (rows failed before this migration have
    none).
  - Recreate `city_prospecting_pipelines_active_idx` with predicate
    `status not in ('completed','failed','cancelled')` — without this the
    tick would select cancelled rows forever.
- No changes to `outreach_drafts` — the outbox view and cancel reuse
  existing columns (`scheduled_send_at`, `send_claimed_at`,
  `send_attempts`, `last_send_error`, `sent_recorded_at`).

Rollback: down-migration maps `status = 'cancelled'` rows to `'failed'`
(with `error = 'cancelled (rolled back from spec 102)'`) before restoring
the old constraint and index, then drops `failed_from_status`.

## API (assistant tools + service functions)

No new server actions or routes. New/changed service functions, and the
six belt tools in `lib/assistant/tools.ts`:

### Service layer

- `listCityPipelines(filter)` — new, `lib/prospects/city-pipeline.ts`.
  Read-only; returns pipelines newest-first with city, state, status,
  params, linked ids, error, `failed_from_status`, and the last 3 log
  entries per row.
- `cancelCityProspecting(user, raw)` — new, `lib/prospects/city-pipeline.ts`.
  Input `{ pipelineId: uuid, reason: string }`. `assertCanWrite`. Row
  locked `for update`; conflict unless status is active (not
  `completed`/`failed`/`cancelled`). Sets `status='cancelled'`,
  `error=reason`. If `run_id` is set and that run is still in a
  cancellable state, calls existing `cancelRun` (`lib/runs/service.ts:167`)
  as the same user and appends the outcome to the pipeline log either
  way. Audit: `prospect.city_pipeline_cancelled` with `{ reason }`.
  Log entry step `"cancelled"`.
- `retryCityProspecting(user, raw)` — new, `lib/prospects/city-pipeline.ts`.
  Input `{ pipelineId: uuid }`. `assertCanWrite`. Conflict unless status
  is `failed`. Resume status = `failed_from_status`; when null (pre-102
  failure), derive deterministically from populated refs:
  `run_id → 'running'`, `prompt_set_version_id → 'benchmarking'`,
  `launch_id → 'discovering'`, else `'installing'` (steps already reuse
  existing artifacts, e.g. "Existing launch reused"). Clears `error` and
  `failed_from_status`, sets the resume status; the worker's next tick
  advances it. Audit: `prospect.city_pipeline_retried` with
  `{ resumedFrom: <status> }`. Log entry step `"retried"`.
- `advanceCityPipelines` — changed: the failure branch additionally
  writes `failed_from_status = <status at failure>`; its select adds
  `'cancelled'` to the excluded statuses.
- `listScheduledOutbox(limit)` — new, `lib/prospects/scheduled-sends.ts`.
  Read-only. Returns approved, unsent drafts in two groups:
  **scheduled** (`scheduled_send_at is not null`, soonest first — with
  prospect name, contact email, `scheduled_send_at`, `send_attempts`,
  `send_claimed_at`, scheduled-by) and **parked**
  (`scheduled_send_at is null and last_send_error is not null`, with the
  park reason). A claimed-but-unresolved draft is flagged `inFlight`.
- `cancelScheduledSend` — already exists
  (`lib/prospects/service.ts:1932`), unchanged.
- `runSenseCheck` — already exists (`lib/prospects/sense-check.ts:144`),
  unchanged; the belt wrapper passes through the injectable `AgentCaller`
  the same way the loop's other LLM-backed tools do in tests.

### Assistant belt tools

| Tool | Tier | Input (zod) | Backing call |
|---|---|---|---|
| `list_city_pipelines` | read | `{ status?: enum('active','failed','completed','cancelled','all') = 'active', limit?: int 1–50 = 20 }` | `listCityPipelines` |
| `list_scheduled_sends` | read | `{ limit?: int 1–50 = 20 }` | `listScheduledOutbox` |
| `run_sense_check` | direct | `{ prospect_id: uuid }` | `runSenseCheck` |
| `cancel_city_pipeline` | confirm | `{ pipeline_id: uuid, reason: string 5–500 }` | `cancelCityProspecting` |
| `retry_city_pipeline` | confirm | `{ pipeline_id: uuid }` | `retryCityProspecting` |
| `cancel_scheduled_send` | confirm | `{ draft_id: uuid }` | `cancelScheduledSend` |

Tier rationale (PRINCIPLES #8, spec 096 trust model):

- The two lists are pure reads.
- `run_sense_check` spends internal LLM tokens but only *creates a
  reviewable artifact* — same consequence class as `research_market`
  (direct). It is already cost-ledgered by `runAgent`.
- Cancelling a pipeline or a scheduled send **reverses a decision a human
  confirmed**; retrying re-enters lanes that spend provider budget
  (benchmarking starts a live run). All three are confirm-tier: the model
  mints a pending action, only a human click executes.

Prompt/catalog: no hand-edits — the catalog and input shapes derive from
the tool definitions (`describeSchema`). The confirm gate
(`lib/assistant/confirm.ts`) needs no changes; new confirm tools ride the
existing mint/claim/execute path.

## Validation rules

- All ids are UUIDs, validated by zod at the tool boundary and re-validated
  by the service (`safeParse` on raw input, per house pattern).
- `cancel_city_pipeline.reason`: 5–500 chars, stored in `error` truncated
  to 500 (matches the failure path's truncation).
- State-transition guards:
  - cancel: only from `installing | discovering | seeding | benchmarking |
    running | scoring` → `cancelled`. `completed`/`failed`/`cancelled` →
    `conflict`.
  - retry: only from `failed` → resume status. Anything else → `conflict`.
  - `cancelScheduledSend` keeps its existing guards: `not_found` on
    missing draft, `conflict` when `send_claimed_at` is set (worker may be
    transmitting), idempotent on an unscheduled draft.
- `list_*` limits clamp at 50 (tool results truncate at 6,000 chars into
  the transcript — keep payloads inside it).
- Catalog invariant (extends the spec-096 source-level assertion): every
  tool that cancels, retries, sends, publishes, approves, or spends
  provider budget is confirm-tier.

## Edge cases

- **Cancel while the benchmark run is mid-flight.** `cancelRun` marks the
  run `partial`/`cancelled`; captured cells are kept (raw responses are
  immutable — never deleted). The pipeline log records whether the run
  was cancelled, already terminal, or the cancel attempt failed; the
  pipeline itself still becomes `cancelled` in every case.
- **Cancel races the tick.** The row is locked `for update`; the tick's
  per-pipeline try/catch means a mid-step cancel at worst lets the
  current step finish, after which the (now-cancelled) pipeline is no
  longer selected. No zombie state.
- **Retry a pre-102 failure** (`failed_from_status` null): deterministic
  derivation from populated refs (table above). Resuming one step early
  is acceptable — steps detect and reuse existing artifacts.
- **Retry after the linked run failed/was cancelled.** Resume status
  `running` immediately re-fails on the tick (`run.status === 'failed' ||
  'cancelled'` branch) with a clear log line; the operator then retries
  from `benchmarking` — the spec does not special-case this beyond the
  log message. (Recorded so it is a decision, not an oversight.)
- **Cancel a scheduled send the worker already claimed.** Existing
  `conflict` from `cancelScheduledSend` surfaces verbatim to the model —
  it tells the operator to check the send ledger. Not retryable in-loop.
- **Cancel an already-cancelled schedule.** Idempotent success (existing
  behavior).
- **Sense-check on a prospect with no assembled audit content**
  (no approved finding, etc.): `assembleAuditContent`'s classified error
  surfaces to the model as the tool result; the assistant reports it,
  never fabricates a verdict (docs/12 — a failed run is recorded as
  failed).
- **Sense-check LLM failure**: `runSenseCheck` already records the failed
  check row; the tool returns that row's status like any other result.
- **Parked send with `send_claimed_at` still set** (process died between
  Gmail accept and commit): shown as `inFlight: true` in
  `list_scheduled_sends` with the existing "never auto-retried" caveat in
  the row payload, so the assistant explains it correctly.
- **More than 50 pipelines / outbox rows**: truncated to the limit,
  and the tool result says how many were omitted (no silent caps).

## Acceptance criteria

- [ ] Migration 091 applies and rolls back; a `'cancelled'` row survives
      up→down→up mapping per the rollback note.
- [ ] `list_city_pipelines` returns all active pipelines (not just
      lookup-by-city), filterable by status, with log tails.
- [ ] `cancel_city_pipeline` invoked by the model executes nothing; a
      confirm click cancels the pipeline, attempts `cancelRun` on an
      in-flight linked run, writes audit + log entries.
- [ ] A cancelled pipeline is never selected by `advanceCityPipelines`
      again (query + index predicate both updated).
- [ ] Tick failure writes `failed_from_status`; confirmed retry resumes
      at that status, clears `error`, and the next tick advances it.
- [ ] Retry of a pre-102 failed row (null `failed_from_status`) resumes
      at the derived status per the table.
- [ ] `list_scheduled_sends` shows scheduled, parked, and in-flight
      drafts distinctly with reasons/attempts.
- [ ] Confirmed `cancel_scheduled_send` clears the schedule; a claimed
      draft returns the existing conflict unchanged.
- [ ] `run_sense_check` executes direct (no pending action), returns the
      check row, and a subsequent `publish_audit` no longer warns stale
      for unchanged content.
- [ ] Catalog assertion extended: the three new mutating tools are
      confirm-tier; the two lists and `run_sense_check` are not.
- [ ] Lint, typecheck, full suite pass.

## Test cases

Unit (`tests/unit/`):

- `assistant-tools.test.ts` extensions: catalog tiers for all six tools;
  zod boundary rejections (bad uuid, reason too short, limit > 50) return
  the self-healing schema shape.
- `city-pipeline` transitions: cancel from each active status succeeds;
  cancel from `completed`/`failed`/`cancelled` conflicts; retry only from
  `failed`; derivation table for null `failed_from_status` (all four
  branches).
- `advanceCityPipelines` failure branch stamps `failed_from_status`.
- `listScheduledOutbox` grouping: scheduled vs parked vs in-flight
  fixtures.

Integration (`tests/integration/`):

- Confirm-gate round trip for each confirm tool: model invocation mints a
  pending action, nothing mutates; confirm executes; second confirm is a
  no-op (single-use); expiry and wrong-user refusal (reuses spec-096
  harness).
- Cancel pipeline with a queued linked run: run ends `partial/cancelled`,
  pipeline log records it.
- Retry round trip: seed a `failed` row with `failed_from_status =
  'benchmarking'`, confirm retry, run one tick with mocked providers,
  assert it advances.
- `run_sense_check` through the assistant loop with an injected
  `AgentCaller` (no network), then `publish_audit` mint shows no
  stale-sense-check warning.

Migration test: 091 up/down/up per house rule (every migration reversible
and tested both directions).

## Definition of done

All acceptance criteria pass · tests written and green · `npm run lint`
and `npm run typecheck` clean · migration applies and rolls back ·
`docs/05-feature-specifications.md` updated with the six tools ·
`DECISIONS.md` entry for the tier assignments and the
retry-derivation fallback · demoed against seeded data.
