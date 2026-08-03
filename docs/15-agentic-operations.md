# 15 — Agentic Operations (Multi-Client Platform)

Adopted 2026-07-27 from the operator's agentic-workflow blueprint (originally
drafted for a real-estate brokerage client). This doc generalizes it to any
client in any vertical — the original pilot engagement was client #1; real-estate agents, plastic
surgeons, and others follow. It maps the blueprint onto what specs/001–007
already built and defines what specs/008+ add.

## Doctrine (unchanged — it already is PRINCIPLES.md)

> **Agents analyze and prepare. Workflows control. Humans approve
> consequential actions.**

- Deterministic code handles scheduling, API calls, writes, dedup, scoring
  math, retries, exports, permissions, logging (docs/11, docs/12 rule 4).
- AI agents handle semantic classification, competitive interpretation,
  research synthesis, gap diagnosis, drafting, matching, prioritization
  rationale.
- The agent that creates work never verifies its own work (our review queue
  and evidence gate already encode this).

## Blueprint → platform mapping

| Blueprint component | Status | Where |
|---|---|---|
| Experiment runner (deterministic fan-out, raw capture) | ✅ built | specs/003 — queue, worker, immutable responses |
| Prompt strategy: versioned, frozen, never silently replaced | ✅ built | specs/002 — freeze mechanism |
| Response classification + independent verification | ✅ built (heuristic v1) | specs/004 — parser, confidence routing, human review queue. LLM classifier + fresh-context verifier become new parser versions |
| Core metrics (mention/recommendation/position/citation/SoV) | ✅ built | docs/06 v1.0 — no mystery "GEO score"; components always shown |
| Competitor evidence (who appeared, discovery) | ◐ partial | specs/005 — metrics + brand discovery; the "why were they retrieved" evidence agent is specs/009 |
| Monthly benchmark + report with deltas | ✅ built | specs/003 cron + specs/006 evidence-gated reports (weekly; monthly is a config choice) |
| Learning loop (action → measurement window → association) | ✅ built | specs/007 — interventions, ±windows, verdicts, "association not causation" is exactly our confound/instrument flags |
| Approval levels (green/yellow/red) | ✅ built as pattern | tasks state machine, publish gates, audit log — formalized below |
| Verified client knowledge base (claims, evidence, aliases) | ❌ new | **specs/008** |
| Evidence-gap engine (why not retrieved → typed gaps → actions) | ❌ new | **specs/009** |
| Content production graph (opportunity → brief → draft → fact-check → approve) | ❌ new | **specs/010** |
| Outreach CRM (journalists/rankings; drafts only, human sends) | ❌ new | **specs/011** |
| Vertical packs (prompt categories, compliance rules per industry) | ❌ new | **specs/012** |
| Transaction/ranking ledgers (RealTrends, TRD) | later | vertical-pack extensions once a real-estate client signs (docs/14) |

## Multi-client model

**Project = client engagement.** Everything is already partitioned by
`project_id` (sets, runs, competitors, reports, interventions, tasks). Two
changes complete the model (specs/008):

1. The "self" company becomes **per-project** (`projects.subject_company_id`)
   instead of the global `is_self` — each client is the subject of its own
   measurements, competitors stay scoped per project.
2. A **client knowledge base** per project: verified claims with evidence
   links, canonical wording, as-of dates, and approval status. Agents must
   use approved claims — never invent, never recall.

Still **not self-serve SaaS**: no billing, no client logins, no tenant
isolation beyond project scoping. Operators (you) run every engagement; the
docs/00 non-goal is amended to say exactly this.

## The agent contract (our version)

The blueprint's YAML agent spec maps onto machinery we already have. Every
agent is a versioned prompt (docs/13) executed by a worker job, returning the
shared result envelope:

```ts
interface AgentResult<TOutput> {
  status: "completed" | "needs_review" | "failed";
  confidence: number;          // docs/06 formula where applicable
  output: TOutput;             // Zod-validated, schema per agent
  evidenceIds: string[];       // every claim traceable (evidence table)
  warnings: string[];
}
```

Rules, enforced structurally rather than by prompt hope:
- **Allowed inputs**: agents read the knowledge base + immutable captures —
  services pass them data; agents never query at will.
- **Prohibited actions**: agents produce rows in draft/suggested states only.
  Publishing, sending, and submitting are human-only actions behind the
  existing approval gates and audit log.
- **Self-verification ban**: verifier agents run with fresh context and a
  different parser/agent version string; disagreement → human review queue.
- **Stop conditions**: missing evidence or conflicting client data →
  `needs_review`, never a guess (PRINCIPLES #5).

## Approval levels (formalized)

| Level | Meaning | Mechanism |
|---|---|---|
| **Green** — automatic | run prompts, store captures, classify, compute scores, draft internal reports/tasks, dashboards | worker jobs; audit log |
| **Yellow** — prepared, human approves | content drafts, profile-change recommendations, pitch drafts, ranking ledgers, claim canonicalization | rows in `draft`/`suggested` status; approval transitions audited |
| **Red** — human-only | sending outreach, publishing, submitting rankings, disclosing client info, legal/compliance calls | no code path exists to do these; the system produces packages/drafts only |

## Build order (extends docs/08)

1. **specs/008 — Client Knowledge Base** (per-project subject + claims/evidence). Unblocks everything; also finally answers "what is the client" as data, not folklore.
2. **specs/009 — Evidence-Gap Engine** (competitor evidence + typed gaps + deterministic opportunity scoring). The most commercially valuable layer.
3. **specs/010 — Content Engine** (opportunity → brief → draft → fact-verify against claim IDs → approve). First LLM agents beyond classification; gated by the same evidence discipline as reports.
4. **specs/011 — Outreach CRM** (journalists/rankings; match + draft only).
5. **specs/012 — Vertical Packs** (per-industry prompt templates + compliance checklists: fair-housing for real estate, medical-advertising rules for surgeons).

## What we deliberately keep from our stack (vs the blueprint's)

Same conclusions, simpler tools at this scale (see DECISIONS.md):
Next.js + Postgres stay; **the Postgres jobs queue is the workflow
orchestrator** (Temporal/Trigger.dev when multi-step graphs outgrow it);
Drizzle/Prisma not adopted (schema-as-SQL is the product); PostHog/Clerk
deferred with Supabase auth; one internal model adapter already exists
(lib/ai). The blueprint's `/agents/*.md` specs live in docs/13 as versioned
prompts; its `/workflows/*.md` are the deterministic services + job chains.
