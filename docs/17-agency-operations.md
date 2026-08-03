# 17 — Finishing the AI Visibility System (Agency Readiness)

> 2026-07-29. Written when the operator refocused from optimising one client
> to running the platform as an AI-visibility agency with many clients.
> Baseline for this plan: `docs/audits/five-connected-products-audit.md`
> (Product 1 scored 78/100 as a *single-client* measurement system).

## The reframe

Product 1 is strong at measuring **one** client. Running an **agency** is a
different problem: the work is no longer "measure one client well," it is
"onboard client N in minutes, run twenty benchmarks a week without touching
them, know which clients need me today, and hand each one a deliverable that
stands up to scrutiny." Almost everything below is about *repeatability,
attention management, and separation* — not about better measurement.

## What "finished" means — three tiers

### Tier A — cannot run an agency without these

| # | Capability | Status | Why it blocks |
|---|---|---|---|
| A1 | **Repeatable client onboarding** (vertical packs → generated prompt sets) | ✅ **DONE** (spec 012 — realtor onboards in 0.1s, 33 prompts) | Today onboarding is artisanal: hand-write prompts, invent categories, guess competitors. Inconsistent per client, ~an hour each, and quality depends on who did it. |
| A2 | **Real auth + client separation + roles** | ❌ spec 014, BLOCKED on operator (Supabase project) | Client data behind a hardcoded dev user; no client-viewer access; no RLS. Disqualifying for paid work. |
| A3 | **Cross-client operations console** | ✅ **DONE** (`/` Today view — rule-ranked attention feed + per-client cost) | The portfolio lists clients but cannot answer "what needs me today across all of them" — the core agency question. |
| A4 | **Hosted deployment + reliable scheduling** | ❌ laptop only | launchd fires only while the machine is awake and `npm run app` is serving. Twenty clients cannot depend on that. |

### Tier B — required for agency credibility

| # | Capability | Status | Why |
|---|---|---|---|
| B1 | **Multi-provider coverage** (Gemini, Perplexity, Claude live) | ◐ adapters exist, never run, prices placeholder | Clients ask "what about Gemini?"; docs/06's ≥2-provider rule means single-provider verdicts can never reach "notable". |
| B2 | **Notifications / digests** | ✅ **DONE** — derived inbox that self-resolves, unread badge, copyable digest, hourly cron endpoint | Nobody polls twenty clients by hand. |
| B3 | **Per-client cost tracking + caps** | ◐ tracking DONE (cost-per-client table on Today); per-client monthly caps still missing | Margin per client is unknown; a runaway client can't be capped. |
| B4 | **Client-facing deliverable** (read-only portal or shareable report) | ◐ exports only | Exports work but every delivery is manual. |

### Tier C — scale and margin

| # | Capability | Status |
|---|---|---|
| C1 | Templates library (competitor sets, claim vocabularies per vertical) | partial via A1 |
| C2 | Cross-client benchmarks ("realtors average X% recommendation rate") | ❌ needs ≥5 clients of data |
| C3 | Weekly cycle automation (baseline → parse → score → analyse → draft pulse) | ✅ **DONE** (spec 017 — self-driving state machine that halts at judgement calls) |
| C4 | Provider-cost optimisation (cheaper models for classification, caching) | ◐ partially done (classifier on mini) |

## Execution order (and why)

1. **A1 — vertical packs + onboarding wizard.** Start here: it is the
   agency's core operation ("add a client"), it has no external
   dependencies, and it makes every later client cheaper. Also unblocks the
   compliance half of the content engine for regulated verticals.
2. **A3 — operations console.** Once several clients exist, attention
   management becomes the bottleneck. Pairs naturally with B2 (digests).
3. **B3 — per-client cost + caps.** Cheap to build on existing run costs;
   needed before volume.
4. **A2 — auth** the moment the operator creates a Supabase project
   (spec 014 is written and ready).
5. **A4 — deployment** with A2 (they share the same milestone: hosted app,
   hosted cron, client access).
6. **B1 — providers** as keys arrive; **B4 — portal** after A2.

## Verification (added 2026-07-29)
CI runs on every push and PR (`.github/workflows/ci.yml`): typecheck, lint,
migrations applied AND reversed, full test suite against a Postgres service
container, and a production build. Before this, nothing but a human ran the
246 tests.

## Non-goals for this phase
Revenue attribution (product 4, deferred by the operator), media/outreach
CRM (spec 011), and QBR-grade executive synthesis (P4). None of them block
agency operation of the *visibility* system.
