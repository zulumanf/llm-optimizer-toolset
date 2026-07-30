# Spec 026 — 90-Day Program Plans

> Status: done (2026-07-30) — see "Not built" below
> Depends on: specs/009 (gap findings), specs/010 (content), specs/018 (workflow graph), docs/06, docs/15
> Branch: `feat/018-graph-execution-control-plane`

## Goal

Turn ranked gap findings into a **sequenced, evidence-backed 90-day program**
that a client can be shown and an operator can execute against — and that
reports honestly on what it cannot yet know.

Today the platform produces findings with opportunity scores, and can turn a
single finding into a single task. What it cannot do is answer the question a
prospect actually asks: *"so what are you going to do for me over the next
three months, in what order, and how will we know it worked?"* Answering that
by hand loses the traceability that makes every other number in this system
defensible.

## Existing capabilities (2026-07-30 audit)

| Capability | State | Where |
|---|---|---|
| Ranked findings with deterministic opportunity scores | ✅ | `gap_findings`, `lib/gaps/detect.ts` |
| Finding → task | ✅ but one at a time | `createTaskFromFinding` |
| Task → intervention → outcome | ✅ | `lib/tasks/service.ts`, `action_outcomes` |
| Content brief → draft → verify → approve → publish | ✅ | `lib/content/service.ts` |
| Cross-client prioritisation | ✅ | `lib/control-tower/queue.ts` |
| Weekly operating cadence | ✅ | `cycle_runs`, specs/017 |
| **A plan object** | ❌ | nothing |
| **Sequencing / phasing** | ❌ | nothing |
| **Plan-level measurement targets** | ❌ | nothing |

## Design decision: deterministic composition, not a generated plan

An LLM asked to "write a 90-day plan" produces something fluent, plausible, and
untraceable — the exact failure mode this repository is built to avoid. So the
plan is **composed by code** from ranked findings and known play templates.
Each item states which finding produced it and which evidence supports it.

An agent may later *explain* a plan (the `action_prioritization` agent is
declared for exactly this). It may never decide what goes in one.

## Phasing model

Three 30-day phases, assigned by what each play depends on rather than by
arbitrary calendar slicing:

| Phase | Days | Admits plays that… |
|---|---|---|
| `foundation` | 0–30 | fix identity, correct the public record, need no new content |
| `authority` | 31–60 | build proof on surfaces the retrieval path already reads |
| `compounding` | 61–90 | need the first two phases to have landed before they can work |

A play whose prerequisites are unmet cannot be scheduled earlier than the phase
that satisfies them. That ordering is a property of the data, not a judgement
typed into a slide.

## Play templates

Each template declares `gapTypes` it answers, a phase, effort, an owner, and a
`requires` list of preconditions checked against the client's actual state
(claims, evidence, citations). A play whose preconditions fail is **excluded
with a stated reason** rather than silently dropped — an operator needs to know
that "get listed on Zillow" was skipped because we have no Zillow data, not to
wonder why it is missing.

## Measurement targets

Every plan carries the baseline it was composed from (`baseline_run_id`,
organic mention rate, top competitor rate, citation counts) so that a
re-measurement can be compared against the state at composition time. Targets
are expressed as **movements to measure, not outcomes promised** — this platform
does not guarantee rankings (docs/12), and a plan that promises a mention rate
is a plan that will be quoted back.

## Database changes

- `program_plans` — one row per composed plan: project, horizon, status,
  baseline snapshot, composer version, approval.
- `plan_items` — the sequenced plays: phase, order, play key, title, rationale,
  source finding, evidence ids, effort, owner, status, exclusion reason.
- Plans are versioned by composition: re-composing creates a new plan and marks
  the previous `superseded`. A plan shown to a client stays reproducible.

## Acceptance criteria

- [x] A plan is composed deterministically from findings — same input, same plan.
- [x] Every item names the finding and evidence it came from.
- [x] Plays with unmet preconditions are excluded **with a reason**, never hidden.
- [x] Phases respect prerequisites; nothing is scheduled before its dependency.
- [x] The baseline is snapshotted so progress is measurable against it.
- [x] Targets are movements to measure, never outcomes promised.
- [x] Re-composing supersedes rather than overwrites.
- [x] A plan with no findings produces no plan, not an empty ceremony.

## Not built (2026-07-30)

- **No agent explanation.** `action_prioritization` stays `declared`. The plan
  is composed and ranked deterministically; nothing narrates it yet.
- **No effort calibration.** Effort hours are per-play constants, the same
  approach spec 019 took for the queue, and should be replaced with observed
  medians once enough plan items have actually been completed.
- **No client-facing export.** The plan renders in the internal UI. Turning it
  into a deliverable is spec 016's reporting path and is not wired here.
- **No automatic re-composition.** A plan is composed on request. Wiring it to
  the weekly cycle is deferred until the phasing has been used in anger.
