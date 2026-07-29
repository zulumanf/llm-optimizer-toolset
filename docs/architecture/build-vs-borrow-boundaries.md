# Build vs Borrow Boundaries

Where this platform builds its own automation, where it borrows, and — most
importantly — where it refuses to go.

## The question this answers

"Why not just run n8n?" is a fair question, and the answer is not "n8n is bad".
n8n is excellent at what it does: connect arbitrary systems for arbitrary
industries with a visual builder and hundreds of nodes. The reason it is the
wrong substrate here is narrower and structural.

## What we build

| Built here | Why not borrowed |
|---|---|
| Workflow definition, versioning, execution | A finished client report must be reproducible three years later. That requires the graph, the run, the node outputs, the approvals and the evidence to live in **one** transactional store. An external orchestrator's history is a second source of truth we could not join to a claim. |
| Domain events | The events are domain nouns — `claim.conflict_detected`, `visibility.materially_declined`. Their payload schemas are the product. A generic bus would carry them; it would not validate or version them. |
| Approvals | An approval is evidence: who decided, on what artifact version, with what rationale, against what policy. It belongs in the same database as the artifact. |
| Autonomy policies | The distinguishing product feature. "Level 2 for content publishing at this client, level 4 for benchmarks" is domain configuration, not workflow plumbing. |
| Evidence, claims, attribution | The reason the company exists. Never delegated. |
| Connector SDK | Thin (≈400 lines). Owning it means capability names are domain-shaped and credentials never leave our process. |
| Node library | Nodes encode domain rules (evidence gates, materiality thresholds, suppression). A generic HTTP node cannot. |

## What we borrow

| Borrowed | From | Why |
|---|---|---|
| Durable queue semantics | Postgres (`FOR UPDATE SKIP LOCKED`) | Solved problem, zero operational surface |
| Cron scheduling entry point | The host's cron / launchd hitting an authenticated route | We need a heartbeat, not a scheduler product |
| LLM inference | OpenAI / Anthropic / Google / Perplexity via `lib/ai` | Obviously borrowed |
| Provider APIs | GA4, GSC, HubSpot, Gmail, Stripe, … | Obviously borrowed, behind adapters |
| UI primitives | shadcn/ui, Tailwind, Recharts | Obviously borrowed |
| Encryption | Node `crypto` AES-256-GCM | Never roll your own |

## What we refuse to build

Each of these is a real n8n feature, deliberately absent:

| Refused | Reason |
|---|---|
| Arbitrary code nodes / unrestricted JS | An auditable workflow cannot contain code nobody reviewed. Every transform is a closed enum. |
| Public connector marketplace | Every connector is a security and correctness surface for client data. |
| External developer plugins | Same. |
| Hundreds of generic application nodes | Node count is not the product; domain understanding is. |
| Customer-facing general workflow builder | Clients get outcomes and approvals, not a builder. |
| Anonymous or public workflows | Everything is tenant-scoped and attributable. |
| Agent-generated workflows executed unreviewed | An agent may *propose* a graph; only a human publishes a version. |
| Unrestricted cross-client data movement | The isolation boundary is the product's trust boundary. |
| External system as source of truth | A CRM stage is ingested and reconciled. It never becomes the authority for an approval, a claim, an attribution or an outcome. |

## The system-of-record rule

Stated once, enforced everywhere:

> External tools are **inputs and effectors**. They are never the authority for
> claims, evidence, workflow state, approvals, attribution, recommendations,
> client outcomes, or audit history.

Practically, that means:

- Ingestion writes to platform tables and records provenance
  (`connector_sync_runs`), rather than the platform reading through to a
  provider at query time.
- A write to an external system is recorded as an *action we took*, with its
  approval and its artifact version — the external object's later state does
  not rewrite ours.
- Reconciliation differences surface as exceptions, not as silent overwrites.

## When to revisit

Adopt an external orchestrator when **all** of these hold:

1. More than one worker process is genuinely required for throughput, and the
   Postgres queue is measurably the bottleneck.
2. Workflows routinely wait longer than 30 days (beyond comfortable row-based
   parking).
3. A second engineer is available to own the operational surface.

Adopt a general iPaaS for a *category* of integration when we have more than
~20 providers to support and the marginal adapter is pure boilerplate. At that
point the right move is still to keep the capability layer and put the iPaaS
*behind* an adapter — never in front of the system of record.

Recorded in `DECISIONS.md`.
