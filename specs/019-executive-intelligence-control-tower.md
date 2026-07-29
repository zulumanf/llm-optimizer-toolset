# Spec 019 — Executive Intelligence & Control Tower

> Status: done (queue, health, capacity, outcome graph, weekly brief — see "Not built" below)
> Depends on: specs/018 (graph execution), specs/006 (reporting), specs/007 (interventions), specs/009 (gaps), specs/016 (program reporting), docs/17
> Branch: feat/018-graph-execution-control-plane

## Goal

One operator runs a portfolio of clients. The question they ask is never
"how is client X doing?" — it is **"where is my attention worth the most right
now, across everyone?"** This spec turns the existing single-severity attention
feed into a control tower: a prioritised queue with a *shown* formula, client
health with drill-down to components, an action-to-outcome graph that records
what a completed action actually moved, and evidence-linked executive briefs.

The non-negotiable property: **nothing here invents a number.** Every tile,
score, and sentence resolves to component inputs, a data period, a sample size,
and a link to the evidence. A health score with no drill-down is a vanity
metric and is explicitly out of scope.

## Existing capabilities discovered

| Capability | State | Where |
|---|---|---|
| Cross-client attention feed with rule-assigned severity | ✅ | `db/operations.ts` `attentionFeed()` — 13 signal kinds |
| Per-client cost rollup | ✅ | `db/operations.ts` `clientCostRollup()` |
| Derived notification inbox + digest + hourly cron | ✅ | `lib/notifications/service.ts` |
| Report engine with immutability + evidence gate + deltas | ✅ | `lib/reports/*` — `weekly_pulse`, program reports |
| Interventions with ±windows and `notable`/`inconclusive` verdicts | ✅ | `lib/attribution/*` — already refuses to call correlation causation |
| Gap findings with deterministic opportunity scoring | ✅ | `lib/gaps/*` |
| Accuracy findings (reputation) | ✅ | `lib/accuracy/*` |

## Gaps

1. **Severity is a 3-value enum, not a priority.** Two `urgent` items cannot be
   ordered against each other; client value, commercial value, time-sensitivity
   and effort are not inputs.
2. **No client health.** Nothing rolls the per-signal facts into a per-client
   picture, so "which client is under-served" is answered by memory.
3. **No workload/capacity data.** The platform cannot say whether one operator
   can support 5, 20, or 50 clients, because human-touch minutes are not
   recorded.
4. **The learning loop stops at the intervention.** `interventions` links an
   action to visibility movement, but nothing links *gap → action → asset →
   publication → citation → traffic → lead → pipeline → revenue*, and nothing
   labels the strength of each link.
5. **Exceptions are computed, not managed.** The attention feed is derived on
   read, so an item has no owner, no due date, no SLA, and no resolution
   history.
6. **Automation is a claim, not a measurement.** There is no instrument that
   reports what fraction of delivery actually ran without a human.

## Proposed architecture

Three additions on top of spec 018's tables, plus one composition layer:

```
  workflow_exceptions ─┐
  gap_findings ────────┤
  accuracy_findings ───┼──▶ lib/control-tower/queue.ts ──▶ /control-tower
  workflow_approvals ──┤     (deterministic priority formula, shown)
  attentionFeed() ─────┘

  scores + runs + findings + approvals + exceptions + costs
        └──▶ lib/control-tower/health.ts ──▶ client_health_snapshots
             (components, weights, period, evidence, missing data, confidence)

  gap → action → asset → publication → measurement → lead → revenue
        └──▶ lib/outcomes/graph.ts ──▶ action_outcomes + outcome_relationships
             (labelled confirmed | strongly_supported | correlated |
              probable | unknown — never inferred upward)
```

### Priority formula (deterministic, versioned `v1.0`)

```
priority = 100 × Σ(weight_i × component_i)

  severity          0.30   critical 1.0 · high 0.7 · medium 0.4 · low 0.15
  time_sensitivity  0.20   overdue 1.0 · due ≤24h 0.8 · ≤7d 0.4 · none 0.1
  commercial_value  0.20   normalised expected value of the underlying item
  dependency_impact 0.15   fraction of blocked downstream work
  risk              0.10   legal/privacy/publication exposure
  effort            0.05   inverted: cheap wins break ties upward
```

The queue renders every component score next to the total. A number the
operator cannot decompose is not shown.

### Client health (versioned `v1.0`)

Eleven components, each `0..1` with an explicit `missing` state — a component
without data lowers **confidence**, it does not silently score zero:

visibility trend · authority progress · reputation accuracy · execution
velocity · approval velocity · attribution completeness · lead outcomes ·
integration health · scope utilisation · client engagement · renewal risk.

`client_health_snapshots` is append-only: a health score is a measurement, so
recomputing writes a new row and history stays reproducible.

### Action-to-outcome graph

`action_outcomes` records the full before/after envelope from Part 21 of the
request (state before, hypothesis, assets, dates, visibility/citation/traffic/
lead/pipeline before and after, confounders, human interpretation) and an
effectiveness label from a **fixed** vocabulary: `positive_signal`,
`no_detectable_change`, `negative_signal`, `inconclusive`,
`insufficient_measurement`, `confounded`.

`outcome_relationships` is the typed edge table (`from_kind/from_id →
to_kind/to_id`) with a confidence label. **Rule enforced in code:** only a
human, or a deterministic rule with a matching identifier (a referral parameter,
a CRM id, a self-report), may create `confirmed`. Agents and correlation-based
rules are capped at `correlated`; anything weaker is `probable` or `unknown`.

### Automation & capacity instrumentation

`operator_capacity_snapshots` aggregates, per period: human review minutes
(derived from approval request→decision intervals and review-queue actions),
exceptions per client, approvals per client, manual overrides, and workflow
automation rate (`node_runs` completed with no human transition ÷ total). The
capacity statement is then arithmetic, not assumption: *observed minutes per
client per week × N vs. a configured weekly operator budget.* Where data is
missing the view says so rather than extrapolating.

## UI

```
/control-tower
┌──────────────────────────────────────────────────────────────────────┐
│ Control tower                                    period: last 7 days │
├──────────────────────────────────────────────────────────────────────┤
│ [Active 4] [At risk 1] [Runs blocked 2] [Approvals overdue 3]        │
│ [Exceptions 7] [Automation 87%] [Capacity 6.2 / 10 clients]          │
├──────────────────────────────────────────────────────────────────────┤
│ ACTION REQUIRED (priority · formula v1.0 — click a score to expand)  │
│  92  Acme      Factual conflict: "largest in region" contradicted    │
│      └ severity .30·1.0  time .20·1.0  value .20·.8  dep .15·.4 …    │
│  81  Acme      Approval overdue 4d — content asset "Relocation…"     │
│  74  Northwind Low-confidence classification ×3                      │
│  …                                                                    │
├──────────────────────────────────────────────────────────────────────┤
│ CLIENT HEALTH                                                        │
│  Client     health  visibility  reputation  execution  renewal  conf │
│  Acme        0.71 ▲    0.80        0.55        0.90      low    0.8  │
│  Northwind   0.42 ▼    0.35        0.70        0.20      HIGH   0.6  │
└──────────────────────────────────────────────────────────────────────┘
```

Every row links to the underlying evidence. Loading, empty, error, and
missing-data states are required on each panel (docs/04).

## Database changes (migration `018_control_tower.sql`)

- `client_health_snapshots` (append-only; components jsonb, weights version,
  period, confidence, missing[]).
- `action_outcomes` (append-only measurement envelope + effectiveness label).
- `outcome_relationships` (typed edges + confidence label + evidence ids).
- `operator_capacity_snapshots` (append-only).
- `executive_briefs` (period, kind, generated content, evidence links, status).

Rollback drops all five.

## Security requirements

Same as spec 018: project-scoped queries throughout; briefs contain only
approved claims and computed metrics; no client PII enters an LLM context —
the brief agent receives pre-computed deltas and claim ids, never raw CRM rows.

## Testing strategy

- **Unit:** priority formula (each component and the total), health component
  computation including the missing-data path, effectiveness labelling,
  relationship-confidence guard (agent cannot write `confirmed`), capacity
  arithmetic, materiality thresholds for the weekly brief.
- **Integration:** exception → queue → resolve; health snapshot append-only;
  outcome chain construction from a real gap→action→asset fixture; brief
  generation refuses to emit when the data period is incomplete.

## Acceptance criteria

- [ ] One prioritised queue merges exceptions, approvals, gap findings,
      accuracy findings, and workflow failures across all clients.
- [ ] Every priority score displays its components and the formula version.
- [ ] Client health shows components, weights, period, evidence, missing data,
      and confidence — never a bare score.
- [ ] Health snapshots are append-only and historically reproducible.
- [ ] Action-to-outcome chains record before/after measurements with
      confounders and a fixed-vocabulary effectiveness label.
- [ ] Correlation is never auto-promoted to `confirmed`; the guard is tested.
- [ ] Capacity is computed from observed data and reports "insufficient data"
      when there is not enough of it.
- [ ] Weekly executive brief statements each link to evidence and are filtered
      by materiality thresholds.
- [ ] Automation rate is measured, not asserted.
- [ ] Typecheck, lint, tests pass; migration applies and rolls back.

## Risks

- **Health scores become the product.** Mitigated by the drill-down
  requirement and by refusing a single composite "AI visibility score"
  (`docs/audits` #10 / PRINCIPLES #4).
- **Capacity extrapolation from thin data.** Mitigated by an explicit
  minimum-observation threshold below which the view reports insufficient data.

## Assumptions

- GA4/CRM ingestion is **not** built here; the outcome graph accepts
  externally-supplied traffic/lead/pipeline figures and fixture data, and
  labels chains lacking that data `insufficient_measurement`.

## Open questions

- Weight tuning for the priority formula should be revisited once ≥100
  exceptions have been resolved, using time-to-resolution as the signal.

---

## Not built (2026-07-29) — stated so nothing here is over-claimed

- **Monthly report and quarterly review.** Only the weekly brief is built.
  `executive_briefs.kind` accepts `monthly`/`quarterly` and the reporting gate
  is shared, but no generator exists for either.
- **Category ownership map** (Part 19) and the **recommendation engine**
  (Part 20). Their inputs exist (per-category drilldowns, gap opportunity
  scores, stability labels); neither is composed yet.
- **GA4 / CRM ingestion.** The outcome graph accepts externally-supplied
  traffic/lead/pipeline figures. With none supplied, chains label
  `insufficient_measurement`, which is the correct reading, not a placeholder.
- **Commercial value** in the priority formula is normalised 30-day provider
  spend, because that is the only commercial signal in the schema. Contract
  value would be strictly better and needs a column first.
- **Effort estimates** in the queue are per-source constants. Replace with
  observed medians once `workflow_approvals` holds enough decided rows.
