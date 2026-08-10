# LLM Optimizer Toolset

Internal tool for measuring and growing the client's visibility in AI assistants (ChatGPT, Claude, Gemini, Perplexity). Runs versioned prompt experiments against AI providers, captures raw responses immutably, scores mentions/recommendations/citations with transparent methodology, and produces evidence-backed reports and tasks.

This README covers **only the repository** — setup, stack, structure, commands. Product decisions live in `docs/`, executable feature specs in `specs/`, working rules in `CLAUDE.md`, unbreakable rules in `PRINCIPLES.md`.

## Stack

- **Framework:** Next.js (App Router) + React, TypeScript strict
- **Database:** Postgres 14 — local dev via Homebrew on **port 5433**, Supabase-hosted in production; migrations in `db/migrations/` (reversibility CI-proven)
- **UI:** Tailwind CSS + shadcn/ui, dark mode, desktop-first
- **AI providers:** OpenAI, Anthropic, Google, Perplexity via the abstraction in `lib/ai/`
- **Background jobs:** worker processes in `workers/` (experiment execution, parsing)
- **Testing:** Vitest (1,400+ unit/integration) + Playwright e2e — both merge-blocking in CI (`docs/09-testing-strategy.md`, spec 049)

## Setup

```bash
git clone <repo>
cd llm-optimizer-toolset
npm install
cp .env.example .env        # every variable documented inline
npm run app                 # Postgres + migrations + WORKER + dev server, one command
```

`npm run dev` alone starts only the web server — **runs will queue forever
without the worker** (`npm run worker`). `npm run app` starts everything.
Deployment (containers, scheduling, backups, health): `docs/deployment.md`.

### Environment variables (single `.env`, never committed)

`.env.example` is the authoritative, fully-commented list — copy it and
fill in. Highlights: `DATABASE_URL` (local: `postgres://localhost:5433/llm_optimizer_dev`),
`AUTH_MODE` (`dev` locally, `supabase`+keys in production), provider keys,
`CRON_SECRET`, `APP_URL`, `AUTOMATION_CREDENTIAL_KEY`, backup/alert knobs.
`lib/env.ts` validates at boot; production refuses to serve dev auth.

## Commands

```bash
npm run dev            # Next.js dev server
npm run build          # production build
npm run worker         # start background worker (experiment runner)
npm run mcp            # stdio MCP server exposing read/analysis tools to AI agents (spec 033)
npm run db:migrate     # apply pending migrations
npm run db:rollback    # revert last migration
npm run seed:graph     # demo portfolio: 3 clients, workflow runs, exceptions, an approval
npm run seed:knowledge # demo knowledge base: sources, claims, wiki, packets, token comparison
npm run test           # unit + integration tests
npm run lint           # ESLint (zero warnings policy)
npm run typecheck      # tsc --noEmit
```

## Folder structure

```
├── CLAUDE.md          # how Claude Code works in this repo
├── PRINCIPLES.md      # unbreakable rules
├── DECISIONS.md       # dated architecture decision log
├── docs/              # product spec: vision, PRD, architecture, schema, methodology…
├── specs/             # executable feature specs, implemented one at a time
├── app/               # Next.js App Router pages, layouts, server actions
├── components/        # React components (no business logic, no DB access)
├── lib/               # business logic, scoring, parsing, AI provider abstraction
├── db/                # schema, migrations, query layer
├── workers/           # background jobs (run execution, parsing, workflow ticks)
├── tests/             # unit, integration, fixtures (recorded provider payloads)
└── scripts/           # one-off operational scripts
```

## The graph platform (specs/018, specs/019)

Multi-step work is declared as a **versioned directed graph** and executed by
one engine over the existing Postgres queue — no external workflow runtime
(`DECISIONS.md`, 2026-07-29).

- `lib/workflow/` — graph algebra, engine, gates, autonomy, exceptions, templates
- `lib/agents/` — versioned agent registry, independent verification, adversarial QA
- `lib/knowledge/` — task-scoped evidence packets (privacy filtered at retrieval)
- `lib/outcomes/` — action-to-outcome graph with guarded confidence labels
- `lib/control-tower/` — prioritised queue, client health, operator capacity

Operator surfaces: `/control-tower` (portfolio + one prioritised queue),
`/workflows` (definitions and runs), `/workflows/[runId]` (live graph,
transitions, gates, approvals), `/agents` (registry contracts).

To see it working locally:

```bash
npm run db:migrate
npm run seed:graph     # 3 demo clients; one run parked on an approval
npm run app            # Postgres + worker + Next.js
```

Then open `/control-tower`, decide the pending approval, and watch the paused
run resume. The demo needs no API keys — capture uses the deterministic mock
provider.

## The automation & connector layer (`specs/native-automation-and-connector-layer.md`)

Spec 018 gave the platform a workflow **engine**. This layer gives it a way for
work to *start* without a human and to *touch* the outside world — without
becoming a generic automation product (`docs/architecture/build-vs-borrow-boundaries.md`).

- `lib/events/` — typed, versioned, append-only domain event bus (38 event types).
  Publishing is transactional with the change that caused it.
- `lib/triggers/` — schedule (real cron + IANA timezones + DST), webhook (HMAC,
  replay protection), domain event, threshold (deterministic, fires on transition),
  manual (role + reason + audited)
- `lib/connectors/` — provider-neutral capability SDK, AES-256-GCM credentials,
  health probes, deterministic field mapping. 16 adapters, status labelled
  honestly — see below.
- `lib/automation/` — `AutomationRuntime` (a thin adapter over the spec-018
  engine, not a second one), test mode, 112 node handlers, 18 workflows
- `lib/outreach/` — global suppression and the seven-check external-send gate

Operator surfaces: `/automation` (what is running, waiting, broken),
`/automation/workflows` (templates + read-only graph), `/automation/runs/[id]`
(node inputs/outputs, routing, gates, and for a test run the
would-have-happened ledger), `/automation/connectors`, `/automation/triggers`,
`/automation/events`, `/automation/outreach`.

Entry points: `POST /api/cron/automation` (per-minute heartbeat; fires due
triggers, sweeps event delivery) and `POST /api/webhooks/[slug]` (the single
signed inbound path — it publishes an event and never starts a workflow
directly).

### Connector honesty

**No adapter in this repository has been executed against a live provider API**,
because no provider credentials exist here. Five adapters are `verified`
(fixture, CSV, manual, internal notification, local file store) and all run
inside the platform. Nine are `implemented_unverified`: written against the
documented HTTP contract, shape-tested against captured fixtures, never run
live. Two are `contract_only`. The connectors page says the same thing, and a
unit test prevents any third-party adapter from claiming otherwise.

### Safety, in one paragraph

A test run cannot send, publish, or invoice — the distinction is a database
column, not a convention, and it records what it *would* have sent. An external
send passes seven checks in order (mode, suppression, tenant match, recipient
authorisation, approval, message version, compliance fields) and fails closed on
each. Credentials are decrypted in exactly one module; a node handler's context
has no accessor for one. Nothing labels a correlation as confirmed attribution.
Labour savings are not reported, because no measured baseline exists.

To exercise it end to end without spending anything:

```bash
npm test -- automation-demos    # prospect outreach, content, reporting, failure recovery
```

## Deployment

Operated by one internal team, with scoped client portal access and tokenized prospect audit pages. Ships as two containers (web + worker, `Dockerfile`/`Dockerfile.worker`) plus Postgres — host-agnostic; see `docs/deployment.md`. No public signup; access restricted to the operating team (see `docs/10-security.md`).
