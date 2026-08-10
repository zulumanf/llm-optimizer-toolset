# Spec 051 — Value Loop Closure

**Status:** In progress
**Branch:** `feat/051-value-loop` (stacked on `feat/050-truth-hardening`)
**Source:** Architecture gap audit 2026-08-09 (F10, F11, F19, F21, F24, F26, F28, F43): the loop intervention → live verification → retest → verdict → evidence → client report computes its answer and never delivers it.

## Why

The platform's whole promise to a client is "we changed something, we re-measured with the same instrument, here is whether it worked." Today:

- The retest verdict is computed (`interventionView`/`computeVerdicts`) and never rendered — the portal work tab prints the literal string "Shipped — remeasured on schedule" (F24) and the published report HTML omits the snapshotted program section entirely (F26). "Did it work" is unanswerable from anything a client sees.
- An operator can hand-write "our work drove your gains" into report narrative and publish clean, because the evidence gate only checks sentences containing digits (F19). The causal-phrase linter exists and is applied only to the internal executive brief.
- Nothing verifies a shipped intervention is actually live (F11), and `createCorrectionTask` marks accuracy findings `corrected` at task **creation** — a client can be shown "corrected" for a problem nobody has touched (F10).
- The two outcome systems never meet: `action_outcomes.intervention_id` exists and is never populated on any product path, so a learning can never cite a real intervention's verdict (F43).
- There is no record of a report ever being delivered (F28), the delta table shows no sample sizes, and `first_position_rate` — a headline portal metric — gets no noise verdict (F21).

## Scope

### A. Verdicts reach the client
- `SnapshotIntervention` gains `verdictSummaries` (metric, delta, verdict per measured post-run, computed by the existing `computeVerdicts` at snapshot-build time and **frozen into the immutable body** — the report records what was known at publication, consistent with the snapshot philosophy).
- `renderReportHtml` renders the program section from the snapshot: what we found, what we shipped (each intervention with its measured verdicts or "remeasure scheduled"), tasks completed, content published. Old snapshots without the new fields render defensively.
- `portalWork` replaces the static intervention detail with a computed verdict line in plain client language ("Re-measured at +2w: recommendation rate +12 points (notable)" / "Re-measured — no clear change yet" / "Re-measurement scheduled"), capped to the most recent 20 interventions to bound per-request work.
- `SnapshotDelta` gains `nCurrent`/`nPrevious` (optional — old bodies lack them); the delta table renders sample sizes.
- `RATE_METRICS` gains `first_position_rate` and `top_three_rate` so headline metrics get noise verdicts like every other rate.

### B. Causal-language gate on the client path
- `CAUSAL_PHRASES` is exported from `lib/workflow/gates.ts` (one list, not a third copy) and `validateNarrative` gains a `causalSentences` check: a narrative sentence containing a causal phrase blocks publish with the sentence quoted. Causal claims belong to the attribution system's labeled outcomes, not narrative prose.

### C. Live verification (migration 061)
- `url_verifications` (append-only): intervention_id, url, ok, http_status, note, checked_at. Re-checks append; latest-per-URL is the current state.
- New worker job `verify_intervention_urls` fetches each intervention URL through `safeFetch` (the platform's one egress policy) and records the result. Enqueued automatically by `createIntervention` when URLs are present — `markPublished` flows through it and gets verification for free.
- `interventionView` returns `urlChecks` (latest per URL).
- Accuracy findings stop self-certifying: migration adds `fix_in_progress` to the status vocabulary; `createCorrectionTask` sets `fix_in_progress` (not `corrected`); new `markFindingCorrected` requires the linked task to be `done` and writes an audit row. Reports/portal render the honest status.

### D. Lifecycle + one outcome spine (migration 061)
- `interventions` gain `owner_id` and `cost_usd` (nullable; accepted by `createIntervention`'s schema, shown in views). Approval workflow stays deferred (audit F3, P2).
- `createIntervention` records an `action_outcomes` row in the same transaction with `intervention_id`, `task_id`, `landing_urls`, `completed_on = shipped_at`, and `expected_days_to_impact = 42` (matching the +6w retest) — Loop A (intervention verdicts) and Loop B (outcome sweep → learnings) finally share a spine; the existing sweep measures it with no changes.

### E. Delivery ledger (migration 061)
- `report_deliveries` (insert-only): report_id, channel (`manual_email` | `portal` | `other`), recipient, note, delivered_by, delivered_at. `recordReportDelivery` requires the report be published; audited. The operator's mail client remains the transport (same honest pattern as the prospect `manual` outreach channel — no ESP decision is preempted); the ledger makes "was this ever sent, to whom, when" answerable.
- Report detail page gets a record-delivery affordance and shows the delivery history.

## Out of scope
- Automated email send (needs the ESP/sender-identity decision — spec 052 territory).
- Intervention approval workflow (F3) and per-type executors (F6–F8) — later specs.
- Confidence intervals on deltas (statistical layer — scale phase).

## Acceptance criteria
- [ ] Published report HTML contains the program section: interventions with frozen verdict summaries, honest "not yet measured" states, tasks, content (test renders both a measured and an unmeasured intervention).
- [ ] Portal work tab shows a computed verdict line for a measured intervention and "Re-measurement scheduled" for an unmeasured one (test).
- [ ] `validateNarrative` blocks a numberless causal sentence; publish path refuses with the sentence named (test). The existing digit-citation rule is unchanged (existing tests stay green).
- [ ] Delta rows carry and render sample sizes; `first_position_rate` yields a real verdict instead of null (test).
- [ ] `createIntervention` with URLs enqueues `verify_intervention_urls`; the worker records per-URL results via safeFetch (test with stubbed fetch); `interventionView` exposes them.
- [ ] `createCorrectionTask` sets `fix_in_progress`; `markFindingCorrected` refuses while the task is open and succeeds once done, audited (test).
- [ ] `createIntervention` writes an `action_outcomes` row with `intervention_id` populated (test) — and the outcome sweep can measure it unchanged.
- [ ] `owner_id`/`cost_usd` accepted and persisted (test).
- [ ] `recordReportDelivery` refuses unpublished reports, writes an insert-only row + audit (test); report page shows the history.
- [ ] Migration 061 reversible; `npm test`, lint, typecheck green.
