# Spec 003 — Experiment Runs

> Status: done (2026-07-27) — except the real-provider smoke run in the DoD,
> which is blocked on OPENAI_API_KEY / ANTHROPIC_API_KEY being added to .env.
> All acceptance criteria verified against the mock provider, including a live
> worker-executed run through the real queue.
> Depends on: specs/002 · docs/02 (worker/queue) · docs/07 (protocol) · docs/12 (retry rules)
> Branch: feat/003-experiment-runs
>
> Implementation notes: adapters use the official SDKs (@anthropic-ai/sdk,
> openai) with SDK retries disabled — lib/ai/retry.ts owns the one retry
> policy. Pinned models: claude-opus-5, claude-sonnet-5 (pricing verified),
> gpt-5.1, gpt-5 (pricing UNVERIFIED — flagged in the estimate UI; verify ids
> and prices in lib/ai/pricing.ts before the first paid run). Cost math is
> integer micro-dollars. Baseline cron config lives on projects
> (baseline_prompt_set_id + baseline_config jsonb), set via SQL until a
> settings UI lands. Response detail is a page rather than a drawer
> (docs/04 allows either). Anthropic refusals (stop_reason) are captured as
> valid measurements per docs/12.

## Goal
Execute a frozen prompt-set version across providers/models with N repetitions, through a resumable job queue, capturing every raw response immutably with cost tracking. After this spec, the weekly baseline can run unattended. This is the largest spec; it includes the provider abstraction (`lib/ai/`: OpenAI + Anthropic), the `jobs` queue, and the worker process.

## User stories
- As an operator, I can configure and start a run (version × providers/models × repetitions) after seeing a cost estimate.
- As an operator, I can watch progress (completed/failed cells) and inspect any raw response as soon as it lands.
- As an operator, I can retry a run's failed cells without touching successful ones.
- As the system, the weekly baseline starts itself via cron using the designated set's latest version.

## UI

New run (`/projects/[id]/runs/new`):
```
┌ New run ─────────────────────────────────────────────────────┐
│ Prompt set version  [Core Visibility Set — v4 ▾]             │
│ Providers   [x] OpenAI    model [gpt-…-2026-05 ▾]            │
│             [x] Anthropic model [claude-…-2026-06 ▾]         │
│ Repetitions [5]        Budget cap  [$ 15.00]                 │
│ Label       [Weekly baseline 2026-W31_______]                │
│ Estimate: 12 prompts × 2 providers × 5 reps = 120 calls      │
│           ≈ $7.80 (est.)          [Cancel]  [Start run]      │
└──────────────────────────────────────────────────────────────┘
```

Run detail (`/projects/[id]/runs/[runId]`):
```
│ Weekly baseline 2026-W31   ● running   set v4 · started 06:00│
│ ▓▓▓▓▓▓▓▓░░░░ 84/120 done · 3 failed · $5.12 spent            │
│ [Retry failed (3)]  (enabled when status partial/completed)  │
│ Cells table: prompt · provider · model · rep · status ·      │
│   latency · cost   → row click opens raw-response drawer     │
│   (docs/04 raw response viewer: text + collapsible JSON)     │
```
Runs index: table of runs (label, version, status badge, coverage, cost, dates).

## Database changes
Migration `003_runs.sql`: `runs`, `responses`, `jobs` per `docs/03`, plus:
- **Insert-only trigger on `responses`** (the core invariant — UPDATE/DELETE raise).
- Unique partial index on `responses (run_id, prompt_id, provider, model, repetition)` **where error is null** — one success per cell; failed attempts may accumulate.
- `jobs` lease columns + index on `(status, run_after)`.
- Rollback: drop tables/triggers (last pre-data-milestone rollback; from spec 004 on, expand/contract).

## `lib/ai/` (provider abstraction)
Per `docs/02`: `AIProvider` interface; `openai.ts`, `anthropic.ts` adapters; registry keyed by `ProviderId`. Pinned model id lists as constants. Retry policy per `docs/12` (backoff+jitter, max 3, refusals not retried, budget checked before each call). Cost computed from token usage × pinned price table (`lib/ai/pricing.ts` — a constants file with a source-URL comment and last-verified date). Errors normalized to `ClassifiedError`.

## Worker (`workers/`)
Single Node process (`npm run worker`): poll `jobs` with `FOR UPDATE SKIP LOCKED`, lease, execute, heartbeat. `execute_run` job: expand run config into cells → execute with bounded concurrency (per-provider limiter) → insert `responses` row per attempt outcome → update run counters → finish `completed` (0 failed) / `partial` (some) / `failed` (all or aborted). Idempotent resume: on restart, skip cells that already have a success row. Budget: stop launching new cells once `cost_usd ≥ cap`, mark `partial`, reason recorded.

## API

| Action | Input | Auth | Audit |
|---|---|---|---|
| `startRun` | `{ projectId, promptSetVersionId, providers: [{provider, model, repetitions 1–10}], budgetUsd 0.5–100, label 1–80 }` | operator | `run.start` |
| `retryFailedCells` | `{ runId }` | operator | `run.retry_failed` |
| `cancelRun` | `{ runId }` | operator | `run.cancel` |
| `estimateRun` | same shape as startRun minus label | operator | — (read) |

Route handler `POST /api/cron/weekly-baseline` (CRON_SECRET auth per `docs/10`): enqueues `startRun` for the project's designated baseline set's **latest frozen version** with stored default config; refuses (and alerts) if a baseline run for this ISO week already exists.

Reads: `listRuns(projectId)`, `getRun(runId)` (with cell aggregates), `getResponse(id)`.

## Validation rules
- Version must belong to the project; ≥1 provider; model id must be in the pinned list; repetitions 1–10; budget within bounds.
- `retryFailedCells` only when status ∈ {partial, completed, failed}; retries append to the same run (protocol: retry-within-run allowed, rerun = new run).
- `cancelRun` only while pending/running → status `partial` with `cancelled` detail; in-flight cells finish and are kept.
- Runs are never deleted or edited after completion; label fixed at start.

## Edge cases
- Provider outage mid-run → affected cells fail after retries with classified errors; run `partial`; other provider unaffected.
- Worker crash mid-run → lease expires, another poll resumes; unique index guarantees no duplicate successful cells.
- Budget exhausted at cell 90/120 → `partial`, "budget cap reached", remaining cells recorded as not-attempted (coverage math per `docs/06` counts them as attempted-scope).
- Refusal responses → stored as successful captures (a refusal is a measurement, `docs/12`); flagged `refusal` for parser.
- Cron fires but set never frozen / project archived → job no-ops with an alert log, nothing crashes.
- Two manual runs started simultaneously → both valid (distinct runs); per-provider rate limiter is global across jobs to respect vendor limits.
- Clock/week boundary on cron dedupe → dedupe key is ISO week of `started_at` in UTC.

## Acceptance criteria
- [ ] A run against a mock provider produces exactly cells = prompts × providers × reps `responses` rows (successes + terminal failures), each with full `raw_payload`.
- [ ] UPDATE/DELETE on `responses` fails at DB level.
- [ ] Killing the worker mid-run and restarting completes the run with zero duplicate cells.
- [ ] Budget cap halts a run as `partial` with accurate `cost_usd`.
- [ ] Retry-failed re-attempts only failed cells; successful rows untouched (verified by ids).
- [ ] Cost estimate within ±30% of actual on the mock pricing fixture.
- [ ] Cron endpoint: wrong secret → 401 + audit; duplicate week → no-op + alert; happy path → run appears.
- [ ] Run detail live-updates progress (polling is fine) and opens raw responses in the drawer.

## Test cases
- **Unit:** cell expansion, cost estimation, retry classification (rate-limit retries, auth fails fast, refusal not retried), budget math with micro-dollar accumulation.
- **Integration:** full run against mock provider through the real queue; crash-resume; duplicate-cell unique constraint; immutability trigger; cancel semantics; cron dedupe.
- **E2E:** configure → estimate → start → watch progress → open a raw response → retry failed.
- **Fixtures:** recorded real OpenAI/Anthropic payloads for adapter shape tests (`docs/09`).

## Definition of done
Per `specs/_TEMPLATE.md`, plus: one real (non-mock) smoke run executed manually against both providers with a 2-prompt set, and its data spot-audited.
