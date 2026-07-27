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
- **First real weekly baseline for Parva starts here — everything after runs against live data**

## Week 7 — Competitors
- **`specs/005-competitor-analysis.md`** — companies/aliases, competitor tracking, share of voice, comparison views, unrecognized-brand discovery
- Add Google + Perplexity providers; citation score

## Week 8 — Reporting
- **`specs/006-reporting-dashboard.md`** — full dashboard (authority score, provider breakdown), report drafts → immutable publish, evidence links, export

## Weeks 9–10 — Loop Closure
- **`specs/007-attribution.md`** — interventions, before/after windows, tasks with evidence, finding → task → re-measurement flow
- Hardening: budget caps, alerting on failed runs/jobs, audit log UI

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
