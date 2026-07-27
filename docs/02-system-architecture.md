# 02 — System Architecture

One Next.js monolith + one worker process + Supabase. No microservices (see `DECISIONS.md`).

```
┌─────────────────────────────────────────────────────────────┐
│                      Next.js App (Vercel)                   │
│  ┌──────────────┐  ┌────────────────┐  ┌────────────────┐   │
│  │  App Router  │  │ Server Actions │  │ Route Handlers │   │
│  │  (pages/UI)  │  │  (mutations)   │  │ (cron/webhook) │   │
│  └──────┬───────┘  └───────┬────────┘  └───────┬────────┘   │
└─────────┼──────────────────┼───────────────────┼────────────┘
          │                  │                   │
          ▼                  ▼                   ▼
┌─────────────────────────────────────────────────────────────┐
│                  lib/  (business logic)                     │
│   scoring/   parsing/   ai/ (provider abstraction)   ...    │
└───────────────┬─────────────────────────────┬───────────────┘
                │                             │
                ▼                             ▼
┌───────────────────────────┐   ┌────────────────────────────┐
│   db/ (query layer)       │   │  AI Providers              │
│   Supabase Postgres       │   │  OpenAI · Anthropic ·      │
│   (migrations, RLS)       │   │  Google · Perplexity       │
└───────────────▲───────────┘   └────────────▲───────────────┘
                │                            │
        ┌───────┴────────────────────────────┴───────┐
        │            workers/ (job runner)           │
        │  run-executor · parser · scorer · reporter │
        └────────────────────────────────────────────┘
```

## Layers

### Frontend (`app/`, `components/`)
Next.js App Router. Server components for data display, client components only where interactive. Components render data and call server actions — **no business logic, no DB access** in components. Tailwind + shadcn/ui per `docs/04-ui-design-system.md`.

### API (`app/` server actions + route handlers)
- **Server actions** for all user-initiated mutations (create prompt, freeze set, approve classification). Validate input with Zod at the boundary.
- **Route handlers** only for machine entry points: `/api/cron/*` (scheduled runs, protected by secret header), future webhooks.
- No general-purpose REST API — internal tool, the UI is the only client.

### Business logic (`lib/`)
Pure TypeScript modules: `lib/scoring/`, `lib/parsing/`, `lib/experiments/`, `lib/ai/`. Deterministic, unit-tested, no framework imports. This is the only place equations and classification logic live.

### AI provider abstraction (`lib/ai/`)
One interface all features use:

```ts
interface AIProvider {
  id: ProviderId;                       // 'openai' | 'anthropic' | 'google' | 'perplexity'
  runPrompt(req: PromptRequest): Promise<RawResponse>; // full payload, never trimmed
  listModels(): ModelInfo[];
}
```

Centralizes: auth, retries with exponential backoff, rate limiting, timeout, cost estimation, error normalization. Adding a provider = one new file implementing the interface. Vendor SDKs are imported **nowhere else**.

### Database (Supabase Postgres, `db/`)
Schema in `docs/03-database-schema.md`. Access only through the query layer in `db/` (typed query functions). Migrations in `db/migrations/`, forward + rollback, applied via `npm run db:migrate`. Raw responses in `jsonb`, insert-only enforced by trigger (no UPDATE/DELETE on `responses`).

### Workers (`workers/`)
A single Node process polling a Postgres-backed job queue (`jobs` table — no Redis dependency; see `DECISIONS.md` if this changes). Job types:

- `execute_run` — fan out prompt × provider × model × repetition calls, capture raw responses
- `parse_response` — run classification, write mentions + confidence
- `compute_scores` — apply current scoring version to parsed runs
- `generate_report` — assemble report snapshots

Jobs are idempotent and resumable: each records progress; a crashed run continues, never restarts into duplicate data.

### Analytics
No third-party analytics. The dashboard reads computed score tables directly. Heavy aggregates become materialized views when needed — not before.

### Storage
Postgres for everything including raw payloads. Supabase Storage only for report exports (PDF/CSV) if/when needed.

### Authentication
Supabase Auth, email allowlist (Parva team only). Every session maps to a `users` row; all approvals/reviews record `user_id`. Details in `docs/10-security.md`.

### Background job scheduling
Vercel Cron hits `/api/cron/weekly-baseline` → enqueues `execute_run` for the active baseline prompt-set version. Manual runs enqueue the same job type from a server action — one code path.

### Future integrations
Deliberately absent (see `docs/14-future-ideas.md`): knowledge graph, browser automation of consumer AI UIs, PR automation, external task-tracker sync. Nothing in the current design should special-case for them.

## Key data flow (one experiment run)

1. Operator freezes prompt set → `prompt_set_versions` row (immutable snapshot).
2. Operator (or cron) starts run → `runs` row (`status: pending`) + `execute_run` job.
3. Worker executes each cell (prompt × provider × model × rep) → inserts `responses` (raw, immutable) — **capture before parse, always**.
4. Parser jobs classify each response → `mentions` rows with confidence; low-confidence flagged `needs_review`.
5. Human clears review queue → corrections stored as new revision rows, original parse retained.
6. Scorer computes metrics → `scores` rows stamped with `scoring_version`.
7. Report generator snapshots scores + excerpts → immutable `reports` row.
