# Spec 053 — Fleet Drift Detection & Sentinel

**Status:** In progress
**Branch:** `feat/053-fleet-drift` (stacked on `feat/052-outbound-safety`)
**Source:** Architecture gap audit 2026-08-09 (measurement §8 P0s): provider shape-drift dies in stdout; movement detection is strictly per-project; no sentinel exists. "Did 14 of our 20 clients all drop 8 points this week?" — the single strongest signal distinguishing a provider change from real client movement — is a question nothing can ask.

## Why

Every drift instrument today is per-client. When a provider silently changes its model or its answer format, the platform would produce N coincidentally-similar client stories, each potentially triggering a client-facing "your visibility dropped" narrative — the exact misattribution the truth layer exists to prevent. And when an adapter stops recognizing a payload shape, the flag is logged at error level and thrown away: detected drift with no consequence chain.

## Scope

### A. Drift signal ledger (migration 063)
- `drift_signals`: kind (`fleet_movement` | `provider_shape` | `sentinel_deviation`), provider, metric, direction, magnitude, affected (project deltas, jsonb), summary, detail, `detector_version`, status (`open` | `acknowledged`) with acknowledged_by/at. A partial unique index dedupes open signals per (kind, provider, metric, direction) — re-running the detector amends nothing and duplicates nothing.
- `responses.shape_recognized boolean` — the adapter's shape verdict finally persisted (null = predates the column). The executor writes it on every capture.
- `projects.kind` gains `sentinel`.

### B. Deterministic detector (`lib/drift/detect.ts`, `drift-detector-v1`)
- **Fleet movement:** for every active client project, take the latest scored run and its most recent *comparable* prior (same frozen prompt-set version and scoring version — the movement.ts comparability rule), and compute the subject's per-provider deltas for `mention_rate`/`recommendation_rate`. Group across projects: when ≥ `FLEET_MIN_PROJECTS` (3) **and** ≥ `FLEET_MIN_SHARE` (50%) of measurable projects move the same direction beyond `FLEET_DELTA` (0.10) on one (provider, metric), that is one fleet signal naming every affected project — not N client insights. Pure grouping math, unit-tested.
- **Provider shape drift:** any `shape_recognized = false` capture in the trailing 7 days raises one open signal per provider (the P0: detection existed, persistence didn't).
- **Sentinel deviation:** projects marked `kind='sentinel'` measure deliberately stable entities; *any* comparable-pair delta ≥ `SENTINEL_DELTA` (0.10) on a sentinel is a signal — on a sentinel, movement *is* the anomaly. Sentinel projects reuse the entire measurement stack (prompt sets, runs, scoring) and are excluded from client/portfolio surfaces for free by the existing `kind='client'` filters; cadence rides the project's own scheduled runs (extending the weekly cycle to sentinels is a follow-up).
- `detectDriftSignals()` runs all three; wired into the cron automation heartbeat, isolated so a detector failure never fails dispatch.

### C. Operator surface
- Open drift signals join the control-tower action queue as a seventh source (high risk weight — a fleet signal affects many clients at once) and are listed on the control tower with an acknowledge action (operator, audited). Acknowledging records who decided the signal was understood; the row survives as history.

## Out of scope
- Parser-regression replay harness (re-parse frozen samples across versions) — the data exists (`response_parses` revisions); separate spec.
- Automatic suppression of client-facing deltas during an open fleet signal — policy decision; for now the signal is loud and the operator holds the pen.
- Sentinel prompt-content guidance (which stable entities to measure) — operator judgment, documented in runbook later.

## Acceptance criteria
- [ ] Fleet: 3 projects moving the same direction on one provider+metric produce exactly one open signal naming all three; a 4th run of the detector adds nothing (test).
- [ ] Below-threshold movement (2 projects, or <50% share, or delta <0.10) produces no signal (unit tests on the grouping math).
- [ ] A `shape_recognized=false` capture produces one open provider_shape signal; the executor persists the flag on new captures (test).
- [ ] A sentinel project with a comparable-pair delta ≥0.10 produces a sentinel_deviation signal; sentinel projects stay off client/portfolio surfaces (test).
- [ ] Acknowledge flips status with actor + audit row; acknowledged signals stop deduping new ones (test).
- [ ] Drift signals appear in the control-tower queue (test) and the control tower lists them with an acknowledge action.
- [ ] Migration 063 reversible; `npm test`, lint, typecheck green.
