# Spec 160 — Baseline freeze integrity (Medina P0, "Spec A")

> Status: ready
> Depends on: specs/131, specs/154, specs/155 (amendment R3), specs/159
> Branch: feat/160-baseline-freeze-integrity

## Goal

The Day-0 baseline (the number the contract is judged against) can only be
locked from a complete, fully classified, fresh capture of **this client's**
project, under the accepted protocol. The operator sees exactly what they
are locking and confirms it. A wrong lock is corrected through an audited,
admin-only void that keeps the old snapshot forever, not by database
surgery.

This closes Medina audit P0-01. It also enforces the P1-02 and P1-04 freeze
gates: no unrecognised or empty answers, no keyword-fallback
classifications.

## What is reused (audit result — do not rebuild)

- **`freezeBaseline`** in `lib/engagements/service.ts`, as spec 154 left it:
  - explicit `runId`;
  - accepted protocol required, with the same provider and question-set
    version;
  - agreed aliases present on the subject company;
  - refuses a second baseline.

  Its checks keep their order; this spec adds to them.
- **`baselineReadiness`** in `lib/engagements/measurement.ts` (spec 154):
  unparsed, pending review and copied captures are blockers. It is extended
  here, not duplicated.
- **`buildMeasurementSnapshot`**: the counting rules (one provider,
  non-holdout prompts, current revision, echo-excluded) are unchanged.
- **`engagement_measurements`**:
  - the immutability trigger already forbids changing a frozen snapshot,
    its run, provider, version or companies;
  - the unique index allows one `frozen` baseline per engagement;
  - every reader already filters `status = 'frozen'`.
- **The staff runner** in `app/projects/[id]/delivery/actions.ts`
  (`requireProjectStaffPage`, `makeActionRunner`), from spec 156.
- **`FreezeBaselineDialog`** in `components/delivery/delivery-controls.tsx`:
  replaced in place.

## Database changes

`db/migrations/142_baseline_void.sql` (spec 160):

- `engagement_measurements.status` CHECK gains `'voided'`.
- New columns `voided_at timestamptz`, `voided_by uuid references users`,
  and `void_reason text`. A CHECK requires all three when
  `status = 'voided'`, and a non-empty reason.
- The immutability trigger is extended:
  - a frozen row may change status only to `voided`;
  - a voided row can never change again (status, void fields or anything
    else).

  The snapshot fields stay immutable exactly as today.
- The one-baseline unique index is unchanged
  (`role = 'baseline' and status = 'frozen'`), so a void frees the slot.
- **Down:** refuse while any row is `voided`, because narrowing the CHECK
  would orphan audited history. Otherwise drop the columns and restore the
  previous CHECK and trigger.

## Changes

### A1 — Readiness counts what the snapshot counts, and blocks on everything incomplete

`baselineReadiness(runId, provider)` reports, for that provider:

| Count | Definition | Effect |
|---|---|---|
| `expectedCells` | every frozen prompt (holdouts included, as captured) × each `(model, repetitions)` config of the provider on the run | — |
| `outstandingCells` | expected cells with **no successful answer** (failed and never retried, or never attempted). Insert-only history means a failed row followed by a successful retry is **not** outstanding. | **blocker** ("retry failed cells first") |
| `unparsed` | valid answers without a `response_parses` row | blocker (existing) |
| `pendingReview` | current mentions with `needs_review` and no reviewer | blocker (existing) |
| `reused` | valid answers with `reused_from` | blocker (existing) |
| `heuristicRows` | current mentions from the keyword fallback that no human has reviewed (a human review outranks any machine judgment) | **blocker** (was a warning) |
| `unrecognized` | valid answers with `shape_recognized = false` | **blocker** (new) |
| `empty` | valid answers whose text is empty or whitespace and that are not refusals | **blocker** (new) |

`warnings` stays in the shape for future use; nothing currently produces
one. `acknowledgeWarnings` is still accepted and still required whenever a
warning exists.

### A2 — The run must be this client's, and finished

`freezeBaseline` refuses with a validation error if:

- **`run.project_id` is not the engagement's project.** This covers the
  prospect benchmark and every other project ("This run belongs to another
  project. A client baseline is captured on the client's own project.").
- **The run is not `completed` or `partial`.** This check exists already. A
  `partial` run passes only once A1 shows zero outstanding cells.

`recordMeasurement` gets the same project check. A remeasurement compared
with the client's baseline must also be captured on the client's own
project.

### A3 — Preview, then a confirmation the server checks

- **New read, `previewBaselineFreeze(user, { engagementId, runId })`**
  (staff only). It returns:
  - run id, label, status and started time;
  - question set name, version and prompt count;
  - provider and model(s);
  - repetitions;
  - the protocol version and its aliases;
  - the readiness counts, blockers and warnings;
  - when there are no blockers, the would-be snapshot headline: answer
    count, subject recommended count, and the number of competitors.
- **The freeze requires `confirmedAnswerCount`.** It must equal the answer
  count of the snapshot built at freeze time. If it differs, the freeze is
  refused as a conflict: "The run changed since you reviewed it. Check it
  again." The lock is therefore of exactly what was previewed.
- **The readiness check runs twice:** once before building the snapshot and
  once after. Both must be clean with the same valid-answer count, which
  catches a re-parse or review that lands mid-freeze.
- **The insert maps a unique-index violation** (a concurrent second freeze)
  to `conflict` "This engagement already has a frozen baseline."
- **The snapshot's audit entry** records the readiness counts and the
  confirmed count.

### A4 — Admin-only, audited void

`voidBaseline(user, { engagementId, measurementId, reason })`:

- **Admin only**, using `assertRole(user, "admin")` before any read.
- **The reason** must be at least 20 characters.
- **It refuses if:**
  - the measurement is not this engagement's frozen baseline;
  - any later measurement of the engagement is `frozen` or
    `non_comparable`, because they were compared against this baseline
    ("Void the later measurements' comparison first" is out of scope, so
    the void is simply refused).
- **In one transaction** it sets `status = 'voided'` with who, when and
  why, and writes the audit entry `engagement.baseline_voided` with the
  run id, the snapshot headline and the reason.
- **The snapshot row stays forever.** After a void, a new baseline can be
  frozen, and the protocol is no longer locked by it.

### A5 — Operator UI (staff delivery page; audience: STAFF_ONLY)

- **`FreezeBaselineDialog` becomes check-then-lock.**
  1. The operator picks one of the engagement project's runs on the
     protocol version.
  2. **Check readiness** shows the preview from A3.
  3. Blockers are listed in plain words, and Lock is disabled while any
     exist.
  4. With none, the operator ticks "I checked every agreed name variant
     against the stored answers (recall QA)". **Lock baseline** sends
     `confirmedAnswerCount`.
- **A voided baseline** shows on the delivery page as a muted history line
  (date, by, reason). An admin sees **Void baseline** on a frozen one,
  which opens a dialog with a reason field and a destructive confirm.
- **Server actions:** `previewBaselineFreeze` and `voidBaseline` go through
  the same staff runner. Every gate is server-side; the UI is a
  convenience.

## Edge cases

- **A run with holdout prompts:** they count toward expected cells (they
  were captured) but not toward the snapshot denominator. That is
  unchanged.
- **Multiple model configs for one provider:** each config's repetitions
  are expected.
- **A refusal with empty text** is a valid answer (`refusal = true`), not
  empty, and is counted as not recommending anyone, as today.
- **`shape_recognized` is null** (captures from before migration 063): not
  counted as unrecognised. Unknown never becomes a blocker by itself.
  Empty text still is.
- **A void after the client saw the baseline in the portal:** allowed, with
  the reason; the portal then shows no baseline until a new one is frozen.
  The audit trail is the record.
- **Concurrent freeze:** the unique index wins, and the loser gets a
  conflict.
- **Concurrent void and freeze:** the void locks the row (`for update`). A
  freeze started before the void commits sees the old baseline and is
  refused.

## Acceptance criteria

- [ ] **Freeze is refused, with nothing written, when:**
  - the run belongs to another project (including a prospect benchmark);
  - parse jobs are still queued (unparsed > 0);
  - a review is pending;
  - a keyword-fallback row is current;
  - an answer is unrecognised or empty;
  - a cell's only attempts failed.
- [ ] A cell that failed and then succeeded on retry does **not** block.
- [ ] `recordMeasurement` refuses a run from another project.
- [ ] A clean run freezes when `confirmedAnswerCount` matches. A stale
      count is refused as a conflict, with nothing written.
- [ ] The preview returns the run, version, provider and model, aliases,
      readiness and headline. It is refused for non-staff.
- [ ] **The void:**
  - is refused for operators and for a reason under 20 characters;
  - is refused while a later measurement is frozen;
  - otherwise sets `voided` with who, when and why plus an audit row;
  - afterwards allows a new baseline to be frozen.
- [ ] **The database:**
  - a voided row cannot be changed again;
  - a frozen row cannot change status to anything but `voided`;
  - the snapshot is still immutable;
  - the migration applies and rolls back, and down refuses while voided
    rows exist.
- [ ] New staff actions pass the spec 156 structural and runtime suites,
      which are not weakened.
- [ ] The full suite, lint, typecheck and Playwright are green.

## Definition of done

All acceptance criteria pass · runbook note in `docs/deployment.md` not
needed (operator flow is on the delivery page) · `DECISIONS.md` entry ·
deferred: void of later measurements; P1-03 (re-parse overrides review)
and P1-04 "defer, don't degrade" classifier behaviour (Spec P1 list).
