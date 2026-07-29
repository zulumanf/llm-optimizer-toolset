# LLM Optimizer Toolset

Internal tool for measuring and growing Parva's visibility in AI assistants (ChatGPT, Claude, Gemini, Perplexity). Runs versioned prompt experiments against AI providers, captures raw responses immutably, scores mentions/recommendations/citations with transparent methodology, and produces evidence-backed reports and tasks.

This README covers **only the repository** — setup, stack, structure, commands. Product decisions live in `docs/`, executable feature specs in `specs/`, working rules in `CLAUDE.md`, unbreakable rules in `PRINCIPLES.md`.

## Stack

- **Framework:** Next.js (App Router) + React, TypeScript strict
- **Database:** Supabase (Postgres) — migrations in `db/migrations/`
- **UI:** Tailwind CSS + shadcn/ui, dark mode, desktop-first
- **AI providers:** OpenAI, Anthropic, Google, Perplexity via the abstraction in `lib/ai/`
- **Background jobs:** worker processes in `workers/` (experiment execution, parsing)
- **Testing:** Vitest (unit/integration), Playwright (E2E)

## Setup

```bash
git clone <repo>
cd LLM_Optimizer_Toolset
npm install
cp .env.example .env        # fill in keys — see below
npm run db:migrate
npm run dev
```

### Environment variables (single `.env`, never committed)

```
DATABASE_URL=               # Supabase Postgres connection string
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_API_KEY=
PERPLEXITY_API_KEY=
```

## Commands

```bash
npm run dev            # Next.js dev server
npm run build          # production build
npm run worker         # start background worker (experiment runner)
npm run db:migrate     # apply pending migrations
npm run db:rollback    # revert last migration
npm run seed:graph     # demo portfolio: 3 clients, workflow runs, exceptions, an approval
npm run test           # unit + integration tests
npm run test:e2e       # Playwright E2E
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
├── tests/             # unit, integration, E2E, fixtures (captured raw responses)
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

## Deployment

Internal only. Runs on Vercel (app) + Supabase (database) + a single worker process (Railway/Fly/local cron). No public signup; access restricted to the Parva team (see `docs/10-security.md`).
