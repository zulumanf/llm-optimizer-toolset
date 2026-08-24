# Spec 106 — Assistant Refresh Queue (weekly audit refreshes from chat)

> Status: ready
> Depends on: specs/075, specs/096, specs/102
> Branch: feat/106-assistant-refresh-queue

## Goal

The audit refresh queue (`lib/prospects/refresh.ts`) — the weekly loop
that keeps published prospect audits current — has zero assistant
exposure: the operator cannot ask "which audits need refreshing?" or act
on the answer. Four thin-wrapper tools close it: list the queue, prepare
candidates from a finished run, approve a refresh (republishes the
audit), dismiss one. All four backing functions exist; no migration.

## User stories

- As an operator, I can ask "what's in the refresh queue?" and see each
  candidate's prospect, delta, new finding, preflight state, and the
  prior human finding (the pre-fill approval requires).
- As an operator, I can stage refresh candidates from a finished run
  (including manual runs via force — the documented backfill path).
- As an operator, I can approve a refresh from chat (confirm click),
  supplying the required human-finding attestation — the audit
  republishes through the existing gates.
- As an operator, I can dismiss a candidate with a reason.

## UI / Database changes

None.

## API (assistant tools)

| Tool | Tier | Input (zod) | Backing call |
|---|---|---|---|
| `list_audit_refresh_candidates` | read | `{}` | `listAuditRefreshCandidates` (`lib/prospects/refresh.ts:553`) |
| `prepare_audit_refresh` | direct | `{ run_id: uuid, force?: bool }` | `prepareAuditRefreshCandidates` (`:162`) |
| `approve_audit_refresh` | confirm | `{ candidate_id: uuid, human_finding: { text 20–600, source_label 2–120, source_url: url, source_date: YYYY-MM-DD }, adoption_stat?: same shape, acknowledge_stale?: bool, acknowledge_warnings?: { reason 10–500 } }` | `approveAuditRefresh` (`:399`) |
| `dismiss_audit_refresh` | confirm | `{ candidate_id: uuid, reason?: string ≤500 }` | `dismissAuditRefresh` (`:484`) |

Tier rationale: prepare only stages reviewable candidates and is
idempotent per (prospect, run) — direct, the `run_discovery` precedent.
Approving **republishes a prospect-facing page** — confirm, the
`publish_audit` precedent; the required `human_finding` is the service's
own attestation contract ("a human looked" is the point of the click).
Dismissal discards staged review work — confirm, the spec-103 precedent.

The list returns the service's rows minus `preflight` details and
`findingExplanation` bodies (compact: preflight pass/warn counts only) —
transcript-budget discipline. `priorHumanFinding` IS included: it is the
pre-fill approval needs.

## Validation / Edge cases

- The service's guards surface verbatim: a `needs_attention` candidate
  without a finding refuses approval ("resolve it from the prospect
  page"); stale runs need `acknowledge_stale`; preflight warnings need
  `acknowledge_warnings.reason`; already-decided candidates conflict.
- `prepare_audit_refresh` on a manual run without `force` returns
  `notApplicable` — reported, not an error. It runs as the system
  principal by the service's own design (idempotent staging).
- Catalog invariant extended: `dismiss_` prefix must be confirm-tier
  (`approve_` already is).

## Acceptance criteria

- [ ] Four tools at the tiers above; catalog assertion covers `dismiss_`.
- [ ] Prepared candidates appear in the list through the loop; a
      confirmed approval republishes the audit; a confirmed dismissal
      closes the candidate (integration, reusing the audit-refresh
      harness).
- [ ] Lint, typecheck, full suite pass.

## Test cases

- Unit: MUST_CONFIRM additions + `dismiss_` prefix; describeSchema render
  of `approve_audit_refresh`'s nested shape.
- Integration: extend `tests/integration/audit-refresh.test.ts` (it owns
  the published-audit seed chain) with belt-tool round trips for
  approve and dismiss through the confirm gate.

## Definition of done

Acceptance criteria pass · tests green · lint/typecheck clean · `docs/05`
updated · demoed against seeded data.
