# Spec 161 — Contractual fresh capture (Medina P0, "Spec B")

> Status: ready
> Depends on: specs/054 (shared captures), specs/131, specs/160
> Branch: feat/161-contractual-fresh-capture

## Goal

A client's measurement is always the client's own capture, asked of the
provider for that run. Capture reuse (spec 054) stays available where it was
designed to save money, on prospect benchmark projects, and is impossible
on client projects. Every copied answer that does exist (from prospect runs,
and historical copies) states its true origin: the time the provider was
actually asked, and the source answer. A measurement containing copies is
never presented as comparable to the baseline.

This closes Medina audit P0-02.

## What is reused (audit result — do not rebuild)

- **`findReusableCapture`** (`lib/runs/reuse.ts`): the single eligibility
  query. It is unchanged; the decision of *whether* to reuse moves to run
  creation plus one executor guard.
- **`runs.reuse_captures`** (migration 064): the per-run flag. Only its
  default and who sets it change.
- **`projects.kind`** (`client` | `prospect`, migration 041): the only
  signal needed. A client project is anything not a prospect benchmark.
- **`responses.reused_from`**: provenance of every copy. Historical copies
  get their true capture time through it, so no backfill is needed.
  Responses are insert-only and are never updated.
- **`baselineReadiness`**: already blocks a baseline with copied answers
  (spec 154/160).
- **`assessMeasurementComparability`** (`lib/engagements/rules.ts`): the
  one comparability rule set, extended here.

## Database changes

`db/migrations/143_reuse_default_off.sql` (spec 161):

- `alter table runs alter column reuse_captures set default false`. Who sets
  it to true is decided in code (B1). The down migration restores `true`.

No change to responses (insert-only).

## Changes

### B1 — Reuse is decided at run creation, and never on a client project

- `startRunSchema` gains an optional `reuseCaptures: boolean`.
- **`startRun` decides `runs.reuse_captures`:**
  - On a **client** project it is always `false`. An explicit
    `reuseCaptures: true` is refused with a validation error: "Client
    measurements are always captured fresh; capture reuse is for prospect
    benchmarks only."
  - On a **prospect** project it is `reuseCaptures ?? true`, keeping spec
    054's savings by default and allowing an explicit opt-out.
- **The executor guard:** `executeRun` reuses only when the run's flag is
  true **and** its project's kind is `prospect` at execution time. This
  covers historical client runs created with the old default `true`, a
  resumed run, and a project converted from prospect to client
  (`lib/prospects/service.ts` sets `kind = 'client'` on conversion).
- **Retry failed** (`retryFailedCells`) inherits the run's flag, under the
  same guard.

### B2 — A copy carries the time the provider was asked

- **New copies are inserted with `requested_at` = the source's
  `requested_at`** (the copy no longer takes the insert time).
  `latency_ms = 0` and `cost_usd = 0` stay as they are: the platform paid
  once, at the original.
- **One read helper**, `captureTimeOf(response)`: for a copy, the source's
  `requested_at` (via `reused_from`); otherwise its own. It covers
  historical copies stamped with copy time. Measurement snapshots use it for
  `capturedAt`/`capturedFrom`.

### B3 — The answer page shows a copy for what it is (STAFF_ONLY)

- `getResponse` returns `reused_from`, plus the source's `requested_at`,
  run, project id and project name.
- The response page shows a **Copied capture** badge instead of
  **captured**, and the description reads "Copied from an answer captured
  <date> on <project> (run <label>) — not asked by this run". It links to
  the source answer, an internal page that is also staff-gated.

### B4 — Measurements with copies are not comparable

- `MeasurementSnapshot` gains `reusedCount?: number`: answers in the
  snapshot that are copies. `buildMeasurementSnapshot` always sets it;
  older snapshots don't have it.
- **`assessMeasurementComparability` flags `not_comparable`** when either
  side's `reusedCount > 0`: "N answer(s) were copied from another project's
  capture — not a fresh measurement". Unknown (`undefined`) on an older
  snapshot is never treated as zero copies and never flagged, because there
  is no basis either way. A remeasurement recorded with copies is therefore
  stored as `non_comparable`, with that reason.

### B5 — Operator UI (STAFF_ONLY)

- **On a prospect project**, the new-run form shows a checked checkbox
  "Reuse identical answers captured by other projects in the last
  72 hours (saves cost; prospect benchmarks only)".
- **On a client project** it shows a static line: "Client measurements are
  always captured fresh."

## Edge cases

- **A client run started before this spec (`reuse_captures = true`) and
  resumed:** the executor guard refuses reuse, and the remaining cells are
  asked fresh.
- **A prospect project converted to client mid-run:** the guard reads the
  kind at execution, so no further copies are made. Copies already made stay
  as they are, and readiness/comparability catch them.
- **A copy whose source is in a project the viewer can't see:** the page is
  staff-only, so it's not a client-visible leak. The source project name is
  shown to staff.
- **The scheduled and city-pipeline callers of `startRun` pass no flag.**
  They get the kind default: fresh for client projects, reuse for
  prospects.
- **`capturedAt` for a run that mixes copies and fresh answers:** it is the
  maximum true capture time, as before but with true times.

## Acceptance criteria

- [ ] `startRun` on a client project stores `reuse_captures = false`, and
      refuses `reuseCaptures: true`.
- [ ] On a prospect project the default is `true`, and the explicit `false`
      is stored.
- [ ] A client-project run whose flag is (historically) `true` never copies:
      every cell is asked fresh, even with an eligible source.
- [ ] A prospect run still copies an eligible source. The copy's
      `requested_at` equals the source's.
- [ ] `captureTimeOf` returns the source time for a historical copy stamped
      with copy time.
- [ ] Snapshot `reusedCount` counts copies. Comparability is
      `not_comparable` when either side has copies, and is unchanged when
      `reusedCount` is undefined. A remeasurement with copies is stored
      `non_comparable`.
- [ ] The response page shows the copied badge and source.
- [ ] Migration 143 applies and rolls back.
- [ ] Every spec 156 suite still passes unchanged, and the full suite, lint,
      typecheck and Playwright are green.

## Definition of done

All acceptance criteria pass · `DECISIONS.md` entry · deferred: whether a
client's own captures may serve as a reuse *source* for prospect runs
(answers to public prompts; not a measurement risk for the client — revisit
with spec 054 owners).
