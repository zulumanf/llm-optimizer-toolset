# Native Automation Runtime

> Companion to `docs/architecture/graph-native-platform-architecture.md`.
> Specs: `specs/native-automation-and-connector-layer.md` and its three
> companions.

## Why there is no second engine

Spec 018 built a workflow engine and recorded, in `DECISIONS.md`, why it lives
on the Postgres queue rather than on Temporal. The automation layer inherits
that decision wholesale. The request that produced this work asked for an
`AutomationRuntime` interface; the answer is that `AutomationRuntime` is an
**adapter**, roughly 200 lines, over `lib/workflow/engine.ts`.

```
AutomationRuntime.startWorkflow(input)
  → resolve autonomy + connectors + mode
  → engine.startWorkflow({ ...input, idempotencyKey })
      → workflow_runs row (unique idempotency_key)
      → enqueueJob('advance_workflow')
          → worker → advanceWorkflow(runId) → tick
```

Introducing a second execution model would have meant two places where a run's
state lives, two retry semantics, two audit trails, and two answers to "what is
this waiting on?". The interface exists so the *caller* has the vocabulary the
domain needs; the *mechanism* stays singular.

What the adapter adds on top of the engine:

| Adapter responsibility | Why it is not in the engine |
|---|---|
| Resolve `mode` (live/test) and stamp the run | Test mode is an automation-layer product concept, not a graph concept |
| Validate required connectors are connected and healthy | The engine knows nothing about connectors, by design |
| Render idempotency keys from templates | Trigger-specific; the engine takes a key, it does not invent one |
| Enforce workflow-level concurrency and max-duration | Policy, expressed per definition, not per graph |
| `listExceptions` with automation filters | A query, not an execution concern |

## Layer map

```
app/automation/*                        UI + server actions
      │
lib/automation/                         runtime, node library, test mode, metrics
      ├── runtime.ts                     AutomationRuntime (adapter)
      ├── testmode.ts                    guards + would-have-happened ledger
      ├── nodes/*.ts                     the node library
      └── workflows/*.ts                 17 definitions
      │
lib/triggers/                           schedule · webhook · event · threshold · manual
lib/events/                             typed bus: catalog, publish, deliver, replay
lib/connectors/                         SDK, registry, credentials, execute, health, mapping
      └── adapters/*.ts                  the only place a vendor contract appears
      │
lib/workflow/  (spec 018, unchanged)    engine · graph · gates · autonomy · exceptions
      │
db/*.ts                                 all SQL. Nothing above touches a table directly.
      │
Postgres                                queue · graph · events · connections · audit
```

The dependency arrow never reverses. `lib/workflow` does not import
`lib/automation`, `lib/connectors` or `lib/events` — the engine remains
substitutable, which was the point of the seam.

## Execution invariants

1. **A handler never writes workflow state.** Inherited from spec 018 and
   preserved by every new node.
2. **A handler never holds a credential.** `NodeContext` has no `secret`, no
   `sql`, no connection. An integration node passes a capability name and an
   input to `executeCapability`, which owns the secret for the duration of one
   call.
3. **An event and the state change that caused it commit together.**
   `publishEvent` takes the caller's transaction.
4. **Idempotency is an index, not a convention.** Four unique indexes carry it:
   `node_runs (run, node, fan_key)`, `workflow_runs (idempotency_key)`,
   `event_delivery_attempts (event_id, subscription_id)`,
   `trigger_fires (trigger_id, fire_key)`.
5. **Nothing consequential happens without a decision.** Either a human
   approval row, or an autonomy policy that explicitly permits it, recorded on
   the run.

## Restart and replay

A run's entire state is durable rows. `advanceWorkflow` recomputes the ready
set from scratch on every tick, so a worker that dies mid-tick loses at most
one node attempt, and the `(run, node, fan_key)` index stops that attempt from
duplicating completed work.

Replay is supported where it is safe and refused where it is not:

- **Events**: an operator may replay a dead-lettered delivery. Idempotent
  consumption makes this safe.
- **Nodes**: `retryNode` re-arms a failed node. Safe because idempotency is
  per-instance.
- **Test runs**: fully replayable from stored fixtures.
- **Live consequential nodes** (send, publish, invoice): replay is refused.
  Re-running requires a new run with a new idempotency key and a fresh
  approval, because "we already sent this" is not a state a retry may guess at.

## Cost and rate control

Cost caps are enforced *before* an agent or connector node executes (spec 018's
rule: a cap checked afterwards is a receipt). The automation layer adds
per-client send rate limits, evaluated by `ctl.rate_limit`, which safe-stops
rather than silently dropping — a dropped message that nobody knows about is
the failure mode this platform exists to avoid.

## Observability

Every layer writes durable rows rather than metrics-only telemetry, so any
number the UI shows can be drilled into:

- `workflow_transitions` → durations, critical path, wait vs work
- `connector_sync_runs` / `connector_health_checks` → freshness, success rate
- `domain_events` / `event_delivery_attempts` → delivery latency, DLQ depth
- `workflow_exceptions` → per-client exception load and SLA breaches
- `node_runs.human_touch` → manual-intervention rate, the number that tells the
  operator whether automation is actually helping

Labour savings are **not** computed. Doing so needs a measured manual baseline
that does not exist; the automation analytics page says that instead of showing
an invented figure.
