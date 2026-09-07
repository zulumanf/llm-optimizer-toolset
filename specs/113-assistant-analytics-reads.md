# Spec 113 — Assistant Analytics Reads ("analyze X" answers from the metric module)

> Status: ready
> Depends on: specs/101, specs/107
> Branch: feat/113-assistant-analytics-reads

## Goal

"Which subject lines convert?" and "how is outreach doing?" currently
force the assistant to decline — the spec-101 metric module (the ONLY
sanctioned definitions of outreach rates) has no chat exposure. Four
read tools assemble `prospectFacts → deriveIntent` exactly as the
Operate/Analyze views do and hand the module's own outputs to the model,
so analysis quotes the platform's numbers, never approximations.

## API (assistant tools — all read, group `outreach`)

| Tool | Input | Returns |
|---|---|---|
| `outreach_scorecard` | `{ launch_id?: uuid }` | `outreachMetrics` + `funnelConversion` + `funnelDiagnostic` + `yieldPer100` + `insights` (`lib/prospects/analytics.ts`) |
| `outreach_breakdown` | `{ dimension: enum('quality','market','type'), launch_id?: uuid }` | `bySegment` rows |
| `acquisition_funnel` | `{ launch_id?: uuid }` | `acquisitionFunnel` (`lib/prospects/funnel.ts:73`) |
| `outreach_sends` | `{ launch_id?: uuid, limit?: int 1–100 = 50 }` | `sendOutcomes` rows (compact), newest first with omitted count — named to avoid the `send_` confirm-prefix invariant |

Assembly is the dashboard's own glue
(`prospectFacts(filter).map(f => deriveIntent(f, now))` —
`lib/prospects/dashboard.ts:262` precedent); no metric is redefined.
Sample labels and null rates pass through untouched — "positive reply
rate null until a reply classification exists" stays visible to the
model, and the prompt's honesty rules already forbid filling it in.

## Edge cases

- Empty cohorts return the module's own insufficient-sample shapes, not
  zeros invented by the wrapper.
- `send_outcomes` slices newest-first to the limit with an omitted count
  (transcript budget).

## Acceptance criteria

- [ ] Four read tools grouped/cataloged (ratchet holds <11k).
- [ ] `outreach_scorecard` + `send_outcomes` round-trip through the loop
      against seeded sends (integration); rates match the module's
      values, never recomputed.
- [ ] Lint, typecheck, full suite pass.

## Definition of done

Criteria pass · tests green · lint/typecheck clean · docs/05 updated.
