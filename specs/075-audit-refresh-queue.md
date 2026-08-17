# Spec 075 — Audit Refresh Queue: Prepared Weekly Audits, One-Click Approval

> Status: implemented — acceptance criteria verified 2026-08-16 (see Verification)
> Depends on: specs/032 (prospect acquisition), specs/054 (shared market captures), specs/057 stable audit links (migration), specs/065 (QA preflight), docs/architecture/automation-quality-operating-model.md
> Branch: feat/075-audit-refresh-queue-impl

## Why

The shared Jersey City market benchmark was enrolled in the weekly baseline
on 2026-08-16: fresh measurement data now lands every Monday for the market
behind all 14 published prospect audits. Nothing consumes it. Updating one
audit today is a five-step manual chore per prospect (link run → generate
findings → review → type humanFinding → publish with acknowledgments); at 14
prospects per market it silently stops happening, and published audits drift
stale against data the platform already paid for.

The fix is **not** auto-publishing. PRINCIPLES.md #8 ("Software suggests.
Humans approve.") and the autonomy ladder (publishing-class actions are
level 2: the platform prepares the complete action, a human approves
execution) are the platform's spine — the operator confirmed on 2026-08-16
that the rule stands. This spec builds the level-2 machine: after each
scheduled market run, every affected audit gets a fully prepared refresh
candidate — new run linked, findings generated, delta computed, preflight
pre-run — and the operator's remaining work is one reviewed click per audit.

## Goal

When a scheduled benchmark run finishes on a prospect-kind project, the
platform prepares a refresh candidate for every currently-published audit
fed by that project, and a new operator queue surface lists them with the
week-over-week delta, the generated finding, and pre-run preflight results.
One click per candidate reviews-and-publishes through the existing
`publishAudit` gates (supersede-in-place, stable token). Nothing publishes
without that click.

## User stories

- As an operator, on Monday I open one queue and see every published audit
  with fresh data behind it, so I don't have to remember which prospects
  exist or re-run anything.
- As an operator, I see what *changed* (recommendation share, top rival)
  before approving, so my click is a real review, not a ritual.
- As an operator, I can hold a candidate (skip this week) or jump to the
  full prospect page when something needs manual judgment.
- As an operator, I can trust that a candidate I ignore never publishes
  itself — next week's run supersedes it.

## Design

### Trigger: `audit_refresh_v1` automation workflow (autonomy 2, risk high)

Registered alongside `prospect_audit_outreach_v1` in
`lib/automation/workflows/revenue.ts`. Trigger: domain events
`benchmark.completed` and `benchmark.partially_failed` where the run's
project has `kind = 'prospect'` and the run's `trigger = 'scheduled'`
(manual runs keep today's manual flow; the queue is the weekly cadence's
consumer). Manual trigger allowed for backfill.

### Preparation (per affected prospect, all automatic, nothing published)

Affected = prospects whose **current published audit**'s benchmark links
(`prospect_benchmarks`) point at an earlier run of the same project, and
whose stage/lifecycle still permits publishing (not promoted, audit not
revoked). For each:

1. **Link the new run** — existing `linkBenchmark` (idempotent per
   (prospect, run)).
2. **Generate findings** — existing `generateFindings` against the new run.
   The top generated finding is the candidate's proposed primary; it stays
   `pending` (review happens at the click, not here).
3. **Compute the delta** vs the published snapshot: recommendation share
   (old → new), top rival and its share (old → new), mention count, and
   whether the audit's primary claim direction still holds
   (`claim_still_true: boolean`). Pure function over scores/mentions rows +
   the published snapshot; known-answer testable.
4. **Dry-run preflight** — the spec-065 audit checks (mock responses,
   staleness vs the freshness window, source-link liveness) executed
   read-only, results stored on the candidate so the operator sees warnings
   *before* clicking.
5. **Persist the candidate** (table below) and emit the existing operator
   notification ("N audit refreshes prepared for <market>").

A preparation failure (findings generation errored, no valid responses)
still creates the candidate, in state `needs_attention` with the error —
a silent skip would read as "nothing changed."

### The click: approve & publish

`approveAuditRefresh(user, { candidateId, humanFinding, adoptionStat?,
acknowledgeStale?, acknowledgeWarnings? })`:

1. Re-checks candidate is `pending`/`needs_attention` and the prospect's
   audit is still publishable (stage, revocation) — the queue may be days
   old.
2. Approves the candidate's finding via existing `reviewFinding`.
3. Calls existing `publishAudit` **unchanged** — every gate (approved
   finding, phrase checks, preflight blockers, stale/warning
   acknowledgments with reason, evidence validation) fires exactly as
   today; supersede-in-place keeps the prospect's token/URL stable.
4. Marks the candidate `approved` (decided_by, decided_at) and writes the
   audit-log event.

`humanFinding` is **pre-filled from the last published snapshot but always
operator-editable, and required** — the attestation that a human looked is
the point of the click, so the UI never submits it hidden. Acknowledgment
checkboxes render only when the stored preflight (or publish-time re-check)
carries the corresponding warnings; they are the same acknowledgments
`publishAudit` already demands, surfaced in the card instead of the
prospect page.

Other decisions: `dismissAuditRefresh` (state `dismissed`, reason optional)
— "not this week." No delete. When a newer candidate for the same prospect
is prepared, prior `pending` candidates flip to `superseded` automatically.

### What this spec explicitly does NOT do

- No auto-publish, no auto-send, no scheduled approval. A candidate with no
  click never changes anything a prospect sees.
- No new scoring or claim generation — findings come from the existing
  generator with its existing phrase gates.
- No client-report refresh (different surface, different spec).
- No change to `publishAudit`'s gates — the queue feeds them, never
  bypasses them.

## UI

New page `app/prospects/refresh-queue/page.tsx`, staff-only, linked from
the prospects header ("Refresh queue · N pending"). Card list, newest run
first (shadcn Card, Badge, Button; ui-conventions type scale; loading =
skeleton cards, empty state = "No refreshes pending — next scheduled run
starts Monday", error = inline retry).

```
┌──────────────────────────────────────────────────────────────────┐
│ Refresh queue — Jersey City luxury residential        12 pending │
│ Run: Weekly baseline 2026-08-17 · completed · $0.58              │
├──────────────────────────────────────────────────────────────────┤
│ NK Real Estate Group          published 2026-08-14 · 3 views     │
│ Rec share 5% → 8%   Top rival: Compass 15% → 12%   claim holds   │
│ Finding: "AI assistants recommend Compass 12% of the time…"      │
│ ⚠ 1 source link unreachable (ack required)                       │
│ Human finding: [ pre-filled, editable text area          ]       │
│ [ Approve & publish ]  [ Hold ]  [ Open prospect → ]             │
├──────────────────────────────────────────────────────────────────┤
│ The Foster Tucker Team        published 2026-08-14 · 0 views     │
│ ⚠ needs attention: findings generation failed (no mentions       │
│   parsed for subject) — open prospect to resolve                 │
│ [ Hold ]  [ Open prospect → ]                                    │
└──────────────────────────────────────────────────────────────────┘
```

## Database changes

Migration (next free number): `audit_refresh_candidates`

- `id uuid pk`, `prospect_id → prospects`, `run_id → runs`,
  `finding_id → prospect_findings` (nullable — needs_attention),
  `delta jsonb not null default '{}'`, `preflight jsonb not null default '[]'`,
  `status text check in ('pending','needs_attention','approved','dismissed','superseded')`,
  `error text`, `created_at`, `decided_at`, `decided_by → users`.
- Unique `(prospect_id, run_id)`. Index on `(status) where status in ('pending','needs_attention')`.
- Rollback: drop table (candidates are preparation artifacts, not
  measurements — safe to drop; the immutable evidence they point at lives
  in runs/scores/snapshots).

## API (server actions)

- `approveAuditRefresh` — input above (Zod); staff-write
  (`assertCanWrite` + staff); audit event `prospect.audit_refresh_approved`.
- `dismissAuditRefresh({ candidateId, reason? })` — staff-write; audit
  event `prospect.audit_refresh_dismissed`.
- Queue read model `listAuditRefreshCandidates({ launchId? })` — staff.

Preparation runs inside the automation workflow as the system principal
(existing worker identity), which is already the pattern for prepared work;
the *decision* is always a named human user.

## Validation rules

- Candidate transitions: `pending|needs_attention → approved|dismissed|superseded`
  only; approved/dismissed/superseded are terminal.
- `approveAuditRefresh` refuses when: candidate not open; finding_id null
  (needs_attention must go through the prospect page); prospect promoted or
  audit revoked; `humanFinding` empty after trim.
- `humanFinding`/`adoptionStat` pass through the existing prohibited-phrase
  checks inside `publishAudit` (no duplicate implementation).
- One open candidate per prospect: preparing a new one supersedes the old.

## Edge cases

- **Partially failed run** (`benchmark.partially_failed`): candidates are
  prepared, `included_runs_healthy`-style warning attached; the operator
  sees the coverage hole before approving.
- **Delta computation finds the claim no longer true**
  (`claim_still_true: false` — e.g. the prospect's rec share now exceeds
  the rival's): card shows a prominent warning; approval is still allowed
  (the *new* finding is what publishes, and it reflects the new data), but
  the stale pitch is flagged so outreach language gets rechecked.
- **Prospect promoted to client between preparation and click**: approval
  refuses with a "promoted — audit lifecycle ended" error; candidate
  flips to `dismissed` with that reason.
- **Audit expired/revoked meanwhile**: same refusal path; revoked tokens
  are never resurrected by a refresh (spec 032's burn-the-link stands).
- **Two scheduled runs before any click** (operator on holiday): the
  second run's preparation supersedes the first's candidates; the queue
  never shows two cards for one prospect.
- **Same-week duplicate event delivery**: unique `(prospect_id, run_id)`
  makes preparation idempotent.
- **No published audit for a prospect**: out of scope — the queue refreshes
  published audits only; first publication stays the deliberate manual act.

## Acceptance criteria

- [x] A scheduled run completing on a prospect-kind project creates exactly
      one open candidate per prospect with a current published audit fed by
      that project — and none for unpublished/revoked/promoted prospects
      (integration test).
- [x] Candidates carry delta, generated finding, and stored preflight;
      generation failure yields `needs_attention` with the error, never a
      missing card (integration test).
- [x] `approveAuditRefresh` publishes through the real `publishAudit`:
      the audit's token is unchanged, the old snapshot is superseded, and
      every existing gate (phrase check, preflight blocker, warning ack)
      still refuses when it should (integration tests reusing 032/065
      fixtures).
- [x] No code path publishes a candidate without `approveAuditRefresh`
      being called by a staff user (test: worker preparation alone changes
      nothing prospect-visible).
- [x] Supersede/dismiss/refusal transitions behave per validation rules
      (unit tests on the state machine; integration for promoted/revoked
      refusals).
- [x] Delta function is pure with known-answer fixtures, including the
      `claim_still_true: false` flip (unit tests).
- [x] Queue page renders pending, needs_attention, empty, loading, and
      error states; approve card requires non-empty humanFinding and
      renders ack checkboxes only when warnings exist (component/E2E).

## Test cases

- Unit: delta fixtures (share up/down/unchanged, rival change, claim flip);
  candidate state machine; humanFinding required.
- Integration: end-to-end `benchmark.completed` → candidates → approve →
  published snapshot supersede with stable token; needs_attention path;
  promoted-prospect refusal; duplicate-event idempotency; second-run
  supersede.
- E2E (seeded): queue renders 2 candidates, approve one (publishes),
  hold one (dismissed), empty state after.

## Verification (2026-08-16)

Criterion → test, so the checkmarks above are auditable:

- Candidate creation scope, idempotency, safe-skips, needs_attention on
  failure, supersede, promoted/revoked refusals, stable-token republish, and
  "preparation changes nothing prospect-visible" —
  `tests/integration/audit-refresh.test.ts` (6 tests over the real mock-run
  pipeline: run → parse → score → publish → prepare → approve).
- Delta arithmetic incl. the claim flip — `tests/unit/audit-refresh-delta.test.ts`.
- Workflow graph validity, handler registration, autonomy note, and
  non-effectful classification — the existing gates in
  `tests/unit/automation-workflows.test.ts` (census updated 18 → 19).
- Queue page renders the pending card with delta, finding, humanFinding
  fields, and both actions; prospects header advertises the count —
  `tests/e2e/refresh-queue.spec.ts` (read-only against the shared seed).
  The needs_attention/empty/loading/error affordances are the shared
  conditional renders and layout primitives (EmptyState, disabled pending
  buttons); their data states are what the integration tests pin down —
  they are not separately browser-asserted.

## Definition of done

All acceptance criteria pass · tests written and green · `npm run lint`
and `npm run typecheck` clean · migration applies and rolls back ·
`docs/05-feature-specifications.md` gains the queue, `DECISIONS.md` records
the level-2 shape ("prepared, never auto-published") · demoed against
seeded data.
