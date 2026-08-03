# 08 — Roadmap

Milestone-driven; one spec at a time, in order, done means *done* (acceptance criteria + tests + lint + typecheck pass — see `CLAUDE.md`). Dates are targets, order is the commitment.

## Week 1 — Foundation
- Repo scaffolding: Next.js + TypeScript strict + Tailwind + shadcn/ui + Supabase wiring, CI (lint, typecheck, test)
- Migration tooling, `users` + auth allowlist, base layout + navigation
- **`specs/001-project-management.md`** — projects CRUD, archive

## Week 2 — Prompt Library
- **`specs/002-prompt-library.md`** — prompt sets, prompts, freeze → immutable versions, version diff view

## Weeks 3–4 — Run Engine (the heart)
- **`specs/003-experiment-runs.md`** — provider abstraction (`lib/ai/`: OpenAI + Anthropic first), job queue + worker, run execution with repetitions, raw immutable capture, cost tracking, progress UI, retry-failed-cells
- Cron weekly baseline

## Weeks 5–6 — Classification & First Scores
- **`specs/004-response-classification.md`** — parser v1 with confidence, review queue UI, revisions
- Scoring engine v1.0 (mention rate, recommendation rate) + minimal trend dashboard
- **First real weekly baseline for the client starts here — everything after runs against live data**

## Week 7 — Competitors
- **`specs/005-competitor-analysis.md`** — companies/aliases, competitor tracking, share of voice, comparison views, unrecognized-brand discovery
- Add Google + Perplexity providers; citation score

## Week 8 — Reporting
- **`specs/006-reporting-dashboard.md`** — full dashboard (authority score, provider breakdown), report drafts → immutable publish, evidence links, export

## Weeks 9–10 — Loop Closure
- **`specs/007-attribution.md`** — interventions, before/after windows, tasks with evidence, finding → task → re-measurement flow
- Hardening: budget caps, alerting on failed runs/jobs, audit log UI

## Phase 2 — Agentic operations platform (adopted 2026-07-27, docs/15)

Specs/001–007 shipped as specified (the measurement + learning graphs). The
platform now grows into the multi-client operations system:

1. **`specs/008-client-knowledge-base.md`** — project = client engagement;
   per-project subject company; verified claims with evidence + approval
2. **`specs/009-evidence-gap-engine.md`** — competitor evidence profiles,
   typed gap findings, deterministic opportunity scoring → suggested tasks
3. **`specs/010-content-engine.md`** — opportunity → brief → draft →
   fact-verification against claim ids → compliance → human publish
4. **`specs/011-outreach-crm.md`** — journalist intelligence, pitch drafts
   (never sends), ranking-submission packages (never submits)
5. **`specs/012-vertical-packs.md`** — industries as versioned configuration
   (generic-product, real-estate-agent, medical-aesthetics)

## Done — the automation & connector layer (post-018/019)

`specs/native-automation-and-connector-layer.md` and its three companions.
Triggers, a typed domain event bus, a provider-neutral connector SDK with
encrypted credentials, 112 reusable nodes, 18 workflows, test mode, and the
outreach send gate — all on the spec-018 engine, no second runtime.

Next steps for this layer, in priority order:

1. **OAuth authorisation-code flow.** The credential store, refresh, rotation and
   revocation all work and are tested; the browser redirect is not built, so a
   connection is created by pasting a token.
2. **Run one adapter against a real provider.** Until that happens, nine adapters
   stay `implemented_unverified` and reporting that depends on them must disclose
   it. GA4 is the highest-value first target.
3. **Row-level security**, in the same change as real auth (spec 014, still
   blocked on a Supabase project). Tenant isolation is currently a service-layer
   invariant with security tests.
4. **Visual DAG editor.** Read-only visualisation, a template configurator and a
   test-run inspector ship now; the canvas is a UI project over data that is
   already in the right shape.
5. **Agent evaluation suites.** Workflows declare an `evaluationSuite`; three name
   one and none is implemented. Lead qualification and outreach drafting are the
   two worth building first.

## Future (prioritized backlog — see `docs/14-future-ideas.md` for the parked list)
1. Statistical inference upgrade to change detection (scoring v2)
2. Prompt-set coverage advisor (which query categories are unmeasured)
3. Source intelligence: which external domains drive citations in our category
4. Report scheduling + digest email
5. Historical re-scoring tooling across scoring versions

## Operating rules for this roadmap
- No starting spec N+1 while spec N has failing acceptance criteria.
- Scope cuts are recorded in the spec ("Cut from v1: …"), not silently dropped.
- Anything that threatens a principle gets rejected here, not negotiated in code review.
