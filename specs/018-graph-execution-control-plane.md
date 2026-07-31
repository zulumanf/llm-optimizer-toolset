# Spec 018 — Graph Execution & Control Plane

> Status: done (Phase 1-4, 6 — see "Not built" below)
> Depends on: specs/003 (runs), specs/008 (claims), specs/009 (gaps), specs/010 (content), specs/017 (weekly cycle), docs/02, docs/15
> Branch: feat/018-graph-execution-control-plane

## Goal

Replace ad-hoc job chaining with a **versioned directed graph** as the unit of
work. Today every multi-step process in this repository is a bespoke state
machine (`lib/cycles/service.ts`), a hand-written job chain (`execute_run →
parse_response → compute_scores`), or a service that calls the next service
directly. Each one re-invents retry semantics, halting, idempotency, and
"what is this waiting on?".

When this is done, a process is **declared** as nodes and edges with typed
inputs and outputs, executed by one engine that owns dependency resolution,
bounded fan-out, fan-in gates, retries, timeouts, cost caps, durable human
approval waits, and a complete transition history. The cycle's contract —
*automate the work, stop at the judgement* — becomes a property of the engine
rather than a property of one hand-written service.

## Existing capabilities discovered (2026-07-29 audit)

| Capability | State | Where |
|---|---|---|
| Durable queue with lease/backoff/reclaim | ✅ solid | `db/jobs.ts` — `FOR UPDATE SKIP LOCKED`, 3 attempts, exponential backoff, stale-lease reclaim |
| Worker dispatch loop, graceful shutdown | ✅ solid | `workers/index.ts` |
| Deterministic fan-out of provider work | ✅ but bespoke | `lib/runs/cells.ts` + `lib/runs/execute.ts` — cells are a fan-out, hard-coded to benchmarks |
| Idempotency on the capture path | ✅ | `responses_cell_success_unique` partial unique index |
| A multi-step state machine with halting | ✅ but bespoke | `lib/cycles/service.ts` — 7 states, self-rescheduling tick |
| Structured agent runner (pinned model, Zod, cost) | ✅ | `lib/ai/agent.ts` |
| Approval as a state transition + audit | ✅ but per-feature | `lib/tasks/service.ts` TRANSITIONS, `content_assets.status` |
| Immutability enforcement in Postgres | ✅ | `forbid_mutation()` triggers on `responses`, `evidence_artifacts`, … |
| Audit log | ✅ | `audit_log` + `db/audit.ts` |
| Cross-client attention feed | ✅ | `db/operations.ts` |

## Gaps

1. **No dependency model.** Job B runs because job A's handler enqueued it. A
   graph cannot be inspected, versioned, visualised, or resumed at a node.
2. **No fan-in.** Nothing waits for *n* branches; `advanceCycle` polls the world
   on a 120-second tick, which is a poll, not a gate.
3. **No durable human wait.** `cycle_runs` *halts* — it terminates and a human
   restarts the process. There is no state that resumes on a signal.
4. **Retries are per-job, not per-node.** A retried job re-runs a handler that
   may have already done half its work; safety comes from each handler being
   individually idempotent, which is convention, not enforcement.
5. **No per-run cost cap or concurrency control.** `budgetUsd` exists for
   benchmark runs only, and provider concurrency is a fixed constant.
6. **No autonomy model.** Whether a step may execute without a human is encoded
   in each service's branches.
7. **Failure is invisible mid-graph.** A failed job appears on the Today feed as
   `job_failed` with no notion of which process it belonged to.

## Workflow-engine decision

**Keep the Postgres queue. Add a graph layer on top of it. Do not adopt
Temporal, Trigger.dev, or Inngest.**

`DECISIONS.md` (2026-07-27) recorded the revisit point as "when multi-step
graphs outgrow the queue"; `docs/audits/architecture-consolidation-recommendations.md`
#8 restated it as "DAG dependencies or human-wait steps measured in days".
Both conditions are now true, so the revisit is due — and the answer is that
the queue is still the right substrate:

- **Why the existing approach is insufficient (as-is):** no dependency
  resolution, no fan-in, no resumable human wait. All three are *missing
  tables*, not missing infrastructure. The queue already provides the two hard
  parts — durable at-least-once delivery and crash recovery.
- **Operational cost of an external engine:** a second runtime to host, a
  second failure domain, a second place where state lives. For a
  single-operator internal platform this doubles the operational surface for a
  capability we can express in ~600 lines of SQL and TypeScript.
- **Migration impact:** every existing job handler would need re-homing inside
  a foreign execution model, against a codebase whose baseline is 246 green
  tests.
- **Local development impact:** Temporal needs a server + UI + worker;
  Trigger.dev/Inngest need a tunnel or cloud account. Today `npm run app` is
  enough, and integration tests run against a plain Postgres container in CI.
- **Vendor lock-in:** Postgres rows are portable; a Temporal workflow history
  is not.
- **Transactionality:** node completion, state transition, audit row, and the
  next node's enqueue must be **one transaction**. With Postgres they are. With
  an external engine they cannot be, and we would need an outbox.

The escape hatch is the `WorkflowEngine` interface below. Everything outside
`lib/workflow/engine.ts` depends on the interface, so a durable orchestrator
can be substituted without touching a single workflow template, node handler,
or UI page. Recorded in `DECISIONS.md`.

## Proposed architecture

```
                     ┌───────────────────────────────────────────┐
   templates  ──────▶│  registration (lib/workflow/engine.ts)    │
   (versioned TS)    │  validate → hash → publish a version       │
                     └───────────────┬───────────────────────────┘
                                     │ registerDefinition()
                     ┌───────────────▼───────────────────────────┐
   startWorkflow ───▶│  engine (lib/workflow/engine.ts)          │
   resumeWorkflow    │  ─ plan: which nodes are ready?            │
   cancelWorkflow    │  ─ advance: run one ready node, in a tx    │
   retryNode         │  ─ gates, fan-out, fan-in, approvals       │
                     └───────────────┬───────────────────────────┘
                                     │ enqueueJob('advance_workflow')
                     ┌───────────────▼───────────────────────────┐
                     │  existing Postgres queue + worker          │
                     └───────────────────────────────────────────┘
```

The engine is a **tick function**: `advanceWorkflow(runId)` claims the run,
computes the ready set, executes at most `maxParallel` ready nodes, records
transitions, and re-enqueues itself while work remains. This mirrors
`advanceCycle`, which is proven in production and in tests, but generalised.

Node handlers are pure-ish functions registered by name:

```ts
type NodeHandler = (ctx: NodeContext) => Promise<NodeResult>;
```

`NodeContext` carries the tenant scope (`projectId`), the resolved inputs from
upstream nodes, the node's fan-out item when applicable, an evidence packet
when the node declares one, and a budget/cost accumulator. A handler returns
`{ status, output, evidenceIds, confidence, cost }` — it never writes workflow
state itself.

## Database changes (migration `017_workflow_graph.sql`)

New tables (all tenant-scoped through `project_id` where a run is client-bound):

- `workflow_definitions` — logical process (`key`, `name`, `autonomy_level`).
- `workflow_versions` — immutable snapshot of a definition's graph
  (`graph_hash`, `spec` jsonb, `status`), unique on `(definition_id, version)`.
  **Insert-only**; `forbid_mutation()` trigger after publish.
- `workflow_nodes` — one row per node in a version (all fields from Part 3 of
  the request: type, schemas, handler, agent version, timeout, retry policy,
  risk level, approval requirement, idempotency strategy, failure strategy).
- `workflow_edges` — `(from_node, to_node, condition, priority, required,
  on_failure)`.
- `workflow_runs` — a live execution: version, project, trigger, state,
  idempotency key (unique), cost caps, counters, timestamps.
- `node_runs` — one row per node **instance** (fan-out produces many per node);
  `(workflow_run_id, node_id, fan_key)` unique; attempt counter, state,
  input/output jsonb, confidence, cost, timings.
- `workflow_transitions` — append-only history: previous state, new state,
  actor, reason, versions. Immutability trigger.
- `workflow_signals` — external inputs (approvals, external-system callbacks);
  append-only, consumed-at marker.
- `workflow_approvals` — durable approval requests: node run, requested
  role, risk, decision, decided_by, decided_at, rationale. Decisions immutable.
- `workflow_exceptions` — the unified exception queue (Part 13).
- `quality_gate_results` — gate evaluations with component detail.
- `agent_definitions` / `agent_versions` — the registry (Part 9).
- `autonomy_policies` — per (project, workflow, action type) override.

Rollback drops all of the above; no existing table is altered destructively.
`jobs` gains no columns — the graph rides on the existing payload.

## Service boundaries

| Module | Owns |
|---|---|
| `lib/workflow/types.ts` | Every graph type + state enum. No I/O. |
| `lib/workflow/graph.ts` | Pure graph algebra: validation, cycle detection, ready-set, critical path. No I/O. **Fully unit-tested.** |
| `lib/workflow/engine.ts` | Registration (validate + hash + publish), the `WorkflowEngine` implementation, and the tick. |
| `lib/workflow/handlers.ts` | Node-type dispatch (deterministic/agent/gate/approval/…). |
| `lib/workflow/gates.ts` | The six reusable quality gates. |
| `lib/workflow/autonomy.ts` | Autonomy level resolution and enforcement. |
| `lib/workflow/agent-versions.ts` | The set of agent versions a graph may name. Both agent-owning modules register into it at import; `registerDefinition` validates against it. |
| `lib/workflow/exceptions.ts` | Exception raise/resolve + prioritisation formula. |
| `lib/workflow/templates/*.ts` | Versioned workflow templates; `index.ts` exposes `bootstrapWorkflows()`. |
| `lib/agents/registry.ts` | Agent definitions, versions, evaluation hooks. |
| `lib/knowledge/packet.ts` | Evidence packet assembly (spec 019 shares it). |
| `db/workflow.ts` | All SQL for the above. Nothing else touches these tables. |

## Workflow definitions shipped

Node lists below are the graphs **as built**. Where a step named in the goal is
not a node, it is stated — the graph is the thing an operator reads when a run
stops, so a step it does not contain must not be described as if it does.

1. `benchmark_v1` (autonomy 4) — `validate_baseline → start_capture →
   await_capture → fan_providers → provider_evidence → join_providers →
   evidence_gate → terminal`. Per the migration strategy, this **wraps**
   `startRun`/`executeRun` rather than replacing them: capture, classification,
   confidence routing, and independent verification happen inside that proven
   path, and `await_capture` waits on it. The graph's own fan-out is by
   provider, over the evidence of a completed capture — prompt × provider ×
   repetition fan-out lives in `lib/runs/cells.ts` and is not re-expressed here.
2. `content_production_v1` (autonomy 2) — `load_asset → build_packet → draft
   (agent) → fact_verify (verification) → adversarial (verification, fresh
   context) → claim_gate → approval → record_action → terminal`. It starts from
   an existing content asset: gap finding and the brief are upstream of the
   graph, in `lib/gaps` and `lib/content/service.ts`, not nodes.
3. `weekly_brief_v1` (autonomy 3) — `resolve_period → client_health →
   compose_brief → join → terminal`. `compose_brief` is one deterministic node
   that calls `generateWeeklyBrief`, which runs the brief agent and applies the
   executive reporting gate internally; a failed gate safe-stops the run and
   raises an exception, so the brief is withheld rather than written. The gate
   is therefore real but **not a node** — the graph cannot show which of the two
   steps stopped the run. Splitting them is the obvious next revision.

## Security requirements

- Every run carries `project_id`; every query in `db/workflow.ts` filters on it.
  A node handler receives only its run's project scope — there is no ambient
  "all clients" read inside a node.
- Evidence packets are built server-side from **approved** claims only, with
  privacy-restricted claims filtered at retrieval time.
- Approval decisions record `decided_by` and are immutable.
- `assertRole` guards every mutating server action; approvals require the
  role named on the node (`operator` or `admin`).
- Cost caps are enforced before each agent node, not after.

## Migration strategy

Additive and parallel. Nothing existing is rewritten in this spec:

1. Ship the tables + engine + templates. Existing job chains keep working.
2. `benchmark_v1` wraps `startRun`/`executeRun` rather than replacing them, so
   the proven capture path is unchanged.
3. `lib/cycles/service.ts` stays as-is for one release; the weekly cycle gains
   the ability to *start* a `weekly_brief_v1` workflow. Retiring `cycle_runs`
   is a follow-up with its own spec once the graph has run a full quarter.

## Testing strategy

- **Unit** (no DB): graph validation, cycle detection, bounded-loop
  declaration, ready-set computation, fan-out key generation, fan-in
  completion rules, retry policy, state-transition legality, critical path,
  autonomy resolution, exception priority formula, all six gates.
- **Integration** (test DB): start → fan out → partial branch failure → fan-in
  waits → low-confidence routing → verification → approval pause → signal →
  resume → completion; duplicate start via idempotency key; cancellation;
  cost-cap breach; tenant isolation.
- **E2E scenario** (`tests/integration/workflow-e2e.test.ts`): the 25-step
  scenario in Part 30 of the request, end to end against seeded fixtures.

## Acceptance criteria

- [ ] Workflows are defined as versioned directed graphs; publishing a changed
      graph creates a new version and never mutates the old one.
- [ ] Graph validation rejects: unknown node references, unreachable nodes,
      missing terminals, and cycles that are not declared bounded loops.
- [ ] Every reference a graph makes resolves at publish time, not at 3am: an
      agent node names an agent version, and a version in no registry is a
      publish-time error exactly as an unregistered handler is.
- [ ] Independent nodes execute concurrently up to a configured bound.
- [ ] Fan-in gates wait for every *required* upstream branch and disclose
      partial failures rather than silently proceeding.
- [ ] Workflow and node state survive a process restart (state lives in
      Postgres; the tick is re-entrant).
- [ ] A retried node does not duplicate completed work (idempotency key per
      `(run, node, fan_key)`).
- [ ] Every transition records previous state, new state, actor, reason,
      timestamp, and workflow/node versions.
- [ ] An approval node pauses the run durably; a signal resumes it; the
      decision is immutable and audited.
- [ ] Autonomy levels are enforced: a level-2 action cannot execute without an
      approval record.
- [ ] Cost caps stop a run safely (`safely_stopped`), never mid-write.
- [ ] Exceptions from any source appear in one prioritised queue with the
      formula and component scores shown.
- [ ] Critical path and per-node timings are queryable for any finished run.
- [ ] `npm run typecheck`, `npm run lint`, `npm test` pass; migration applies
      and rolls back.

## Risks

- **Tick latency.** A poll-based engine adds queue latency per node. Mitigated
  by advancing *all* currently-ready nodes per tick and re-enqueueing with zero
  delay while work remains.
- **Long-running node handlers block a worker slot.** Mitigated by keeping
  handlers short and using `waiting_for_external_system` for anything that
  polls (the benchmark node hands off to the existing run executor).
- **Graph sprawl.** Mitigated by requiring every template to declare acceptance
  criteria and by the edge rule: an edge only exists for a genuine data
  dependency.

## Assumptions

- One Postgres, one worker process (possibly several) — the lease model already
  makes multiple workers safe.
- Dev-mode auth (spec 014 is blocked on a Supabase project); tenant isolation
  is therefore enforced in services, not by RLS. RLS is added in the same
  change as real auth.

## Open questions

- Should `cycle_runs` be migrated to a workflow definition or kept as the
  scheduler that *starts* workflows? Current answer: the latter, revisited
  after one quarter of graph runs.
- Fan-out cardinality cap: currently 500 node runs per fan-out node. Raise only
  with evidence from a real client's prompt volume.

---

## Not built (2026-07-29) — stated so nothing here is over-claimed

- **Cycle migration.** `lib/cycles/service.ts` and `cycle_runs` are untouched
  and still drive the weekly cycle. The graph runs alongside them. Retiring
  `cycle_runs` needs its own spec after a quarter of graph runs.
- **15 of 26 registry agents are `declared`, not `implemented`** (11 implemented,
  verified 2026-07-31). Their contracts (schemas, scopes, prohibitions) are fixed
  and visible at `/agents`; no runner is wired. `implementedAgents()` in
  `lib/agents/registry.ts` is the authority — if this line and that function
  disagree, this line is the one that is wrong. A graph may still *name* a
  declared agent: its version is publishable, and the node safe-stops for want
  of a handler, not for want of a contract.
- **Node types no shipped graph uses yet:** `condition`, `notification`,
  `delay`/`timer`, and `manual_task` have built-in or trivial handlers, but
  neither the three templates here nor the 18 automation-library workflows
  exercise them, so they are untested beyond the graph algebra.
- **Row-level security.** Tenant isolation is a service-layer invariant with
  integration tests. RLS lands in the same change as real auth (spec 014,
  blocked on a Supabase project).
- **Graph visualisation** is a layered list, not an interactive canvas — and
  deliberately never required for a workflow to run.
