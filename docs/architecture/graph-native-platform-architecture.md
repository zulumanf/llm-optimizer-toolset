# Graph-Native Platform Architecture

> 2026-07-29 · Companion to `specs/018` and `specs/019`. Extends
> `docs/02-system-architecture.md`; does not replace it.

## The three graphs

The platform is organised around three graphs with strictly separated jobs.
Confusing them is the failure mode this architecture exists to prevent.

| Graph | Controls | Tables | Mutability |
|---|---|---|---|
| **Workflow graph** | how work is decomposed, executed, verified, approved | `workflow_definitions`, `workflow_versions`, `workflow_nodes`, `workflow_edges`, `workflow_runs`, `node_runs`, `workflow_transitions`, `workflow_signals`, `workflow_approvals` | versions immutable; runs append transitions |
| **Knowledge & evidence graph** | what the platform is allowed to believe, publish, or report | `claims`, `claim_versions`, `claim_contradictions`, `evidence`, `evidence_artifacts`, `evidence_packets`, `companies`, `sources` | claim versions and artifacts immutable |
| **Action-to-outcome graph** | what a completed action actually moved | `gap_findings`, `tasks`, `content_assets`, `interventions`, `action_outcomes`, `outcome_relationships` | outcomes append-only; relationship confidence never auto-promoted |

They connect at exactly three seams:

1. A workflow node may request an **evidence packet** from the knowledge graph.
   It never queries the knowledge graph directly.
2. A completed workflow that produced an asset writes an **action** node into
   the outcome graph.
3. A remeasurement workflow writes the *after* side of an outcome and proposes
   a relationship whose confidence label is bounded by its evidence class.

## Where deterministic code ends and agents begin

The dividing line is stated once and enforced structurally, not by prompt.

**Deterministic (code):** metric calculation, state transitions, scheduling,
retry, permissions, hashing, deduplication, URL normalisation, threshold
routing, date maths, attribution rules, sample selection, tenant scoping, all
database writes, idempotency, exports, priority scoring, health components,
capacity arithmetic.

**Semantic (agents):** classification, synthesis, gap diagnosis, evidence
interpretation, drafting, opportunity analysis, executive summarisation,
ambiguity resolution.

The enforcement is that agents run inside `agent_task` nodes, whose handler
returns a `NodeResult`. A `NodeResult` is data. The engine — not the agent —
performs the write. An agent physically cannot mutate `claims`, `scores`,
`workflow_runs`, or any protected table, because no agent code path holds a
transaction handle.

```
agent proposes ─▶ Zod schema validation ─▶ deterministic policy check
              ─▶ engine accepts/rejects ─▶ service performs the write
```

## Execution model

`advanceWorkflow(runId)` is the whole engine, called by the existing worker:

1. **Claim** the run row (`for update`), reject if terminal.
2. **Resolve** the ready set from `node_runs` + edges: a node is ready when
   every *required* incoming edge's source is `succeeded` and every edge
   condition evaluates true.
3. **Enforce** cost cap and concurrency bound.
4. **Execute** ready nodes (bounded, sequentially per tick — the queue provides
   parallelism across runs; within a run, `maxParallel` node executions happen
   per tick).
5. **Record** every transition with actor and reason, in the same transaction
   as the node's output.
6. **Re-enqueue** the tick if work remains; otherwise settle the run into a
   terminal state.

Because state lives entirely in Postgres and every step is a transaction, a
crash mid-tick loses at most one node attempt, and the stale-lease reclaim in
`db/jobs.ts` puts the tick back on the queue.

### Fan-out / fan-in

`fan_out` nodes generate a deterministic list of **fan keys** from their input
(prompt ids, provider names, repetition indices, claim ids …). Each key
produces one `node_run` per downstream node, and the `(run, node, fan_key)`
unique index is the idempotency guarantee: a retry cannot create a second
instance or double-count a completed one.

`fan_in` nodes wait until every required upstream instance has settled. A
fan-in **discloses** partial failure — it records `completed`/`failed` counts
in its output — rather than quietly proceeding on whatever arrived, because a
report drawn from an undisclosed partial sample is the exact inaccuracy this
platform exists to prevent.

### Edge discipline

An edge exists only when node B genuinely requires node A's output. The
question is asked explicitly in every template review. Independent work fans
out; it does not chain. Cycles are rejected by `validateGraph()` unless the
edge declares `loop: { maxIterations: n }`, making rework loops bounded and
visible.

## Why not an external workflow engine

Recorded in `DECISIONS.md` (2026-07-29) and argued in `specs/018`. Summary:
the missing capabilities were *tables*, not *infrastructure*; the queue already
provides durable at-least-once delivery and crash recovery; and node completion
+ transition + audit + next-enqueue must share one transaction, which only
works when the orchestrator lives in the same database. The `WorkflowEngine`
interface keeps the substitution cheap if that changes.

## Tenant isolation

`project_id` is the tenant key (project = client engagement, docs/15). Every
run carries it; `db/workflow.ts` filters every read by it; evidence packets are
assembled from that project's approved claims only. Row-level security is
deliberately deferred to the same milestone as real auth (spec 014, blocked on
a Supabase project) — until then isolation is a service-layer invariant with
integration tests that assert cross-project reads return nothing.

## Observability

Per run: duration, critical path (longest weighted path through settled
nodes), queue time, external wait, human wait, retry time, cost, automation
share. Per node: attempts, timing, confidence, cost. Per agent: schema failure
rate, confidence distribution, verifier disagreement rate, human override rate.
All of it is a query over `node_runs` + `workflow_transitions` — no separate
metrics store.
