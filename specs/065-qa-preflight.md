# Spec 065 — QA Preflight: One Pre-Publication Check Layer

## Why

The whole-OS audit (2026-08-12) found the QA layer is "six good gates, two
of which are dead, invoked from four unrelated places": each publish path
reinvented its own subset, and nothing anywhere checks methodology-version
presence, failed runs in the window, measurement freshness on reports, or
the liveness of the source URLs an audit ships to a prospect. Meanwhile
`contentQualityGate` and `publicationGate` exist only in their unit tests —
they check inputs the platform never tracks (canonical URLs, analytics
tagging, brand requirements), so they can never run.

This spec adds one shared preflight vocabulary, wires the missing checks
into both client-facing publish paths, and deletes the two dead gates
honestly.

## 1. `lib/qa/preflight.ts` (`qa-preflight-v1`)

Shared shapes: `PreflightCheck { id, level: 'block' | 'warn', ok, detail }`
and `settlePreflight(checks) → { blockers, warnings }`. Check builders are
pure (known-answer testable); the gatherers touch the database.

Report checks (`reportPreflight(body)`), composing what `ReportBody`
already carries plus two queries:

- `methodology_version` (**block**): `body.scoringVersion` present. A
  report without its scoring version can never be compared honestly later.
- `included_runs_healthy` (**warn**): any of `body.runs` finished
  `partial`/`failed` — with each run's `status_detail`, so the operator
  knows what portion of the instrument is missing.
- `no_unexamined_failed_runs` (**warn**): project runs that failed in the
  report's window (previous run start → generation) and are NOT in the
  body — a silent hole in the period.
- `measurement_fresh` (**warn**): current run older than the spec-042
  benchmark freshness window (90d), reusing `staleness()`.

Audit checks (inside `publishAudit`, which already has the
`acknowledgeStale` / `acknowledgeWarnings {reason}` machinery):

- `no_mock_responses` (**block**): the benchmark run's responses include
  provider `mock` while `mockScoringAllowed()` (lib/ai/registry — the one
  policy) says production. Defense in depth behind the scoring guard: a
  mock-fed audit must be unpublishable at every layer.
- `source_links_alive` (**warn, ack-required**): every prospect-visible
  source URL (humanFinding, adoptionStat, example-chat exhibits, authority
  signal sources) is fetched through `safeFetch` (the platform's one egress
  policy; short timeout, capped count). Dead links join the existing
  acknowledge-with-reason warning flow — a snapshot that ships a 404 as its
  "receipt" undermines the whole evidence posture, but a transiently-down
  site must not hard-block an operator who checked by hand.
- Methodology stamp: the published snapshot gains
  `instrumentVersions { scoring: string[], parser: string[] }` from the
  benchmark's scores/mentions rows (the audit found `prospect_audits.
  snapshot` froze numbers with no version). Additive, optional field —
  presentation guards optional fields, old snapshots unaffected.

## 2. Publish-path wiring

- `publishReport`: after the existing narrative/evidence gate — blockers
  throw; warnings require new `acknowledgeWarnings: boolean` (the
  `acknowledgePendingReviews` param and behavior are unchanged); the audit
  log records the acknowledged warnings and `qa-preflight-v1`.
- Report detail page computes the same preflight and passes warnings into
  `PublishControls`, which shows them with an acknowledgment checkbox —
  the same pattern pending reviews already use. The operator sees what
  they are acknowledging before clicking, not after a failed submit.
- `publishAudit`: mock check hard-fails; dead-link warnings append to the
  existing ack-required warning list; `instrumentVersions` stamped into
  the snapshot.

## 3. Dead gates deleted

`contentQualityGate` and `publicationGate` (+ input types, GATE_TYPES
entries, unit tests) are removed. Rationale recorded in DECISIONS.md: they
assumed a publication pipeline (canonical URLs, analytics tagging,
compliance sign-off fields) the platform does not track; the real
publication controls are `publishReport`'s narrative gate, `publishAudit`'s
evidence/warning flow, and `lib/content/validate.ts`. No
`quality_gate_results` rows carry these types (never invoked; `gate_type`
has no CHECK constraint), so nothing dangles.

## Testing

- Unit: every pure check builder (pass/fail/boundary), settle precedence.
- Integration (reports): publish blocked on missing scoring version;
  warnings require acknowledgment and are audit-logged; clean body
  publishes untouched.
- Integration (audits): dead source link requires acknowledgment with
  reason; snapshot carries `instrumentVersions`; mock leak blocked when
  policy disallows.
- Existing gate tests updated (two describes removed); full suite green.

## Acceptance criteria

- [ ] One module owns the preflight vocabulary; both publish paths run it.
- [ ] Blockers cannot be acknowledged away; warnings always can, with the
      acknowledgment recorded.
- [ ] Report page shows preflight warnings before publish, not after.
- [ ] Audit snapshots stamp instrument versions.
- [ ] Dead gates gone; lint, typecheck, full suite, both migrations n/a
      (no schema change).

## Out of scope

Content-asset publish flow (already gated by lib/content/validate.ts),
retro-stamping old audit snapshots, periodic re-verification of source
links after publish (verify-urls-style sweep — future), consolidating the
four LIVE workflow gates (they are wired and versioned where they belong).
