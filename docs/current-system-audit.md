# Current System Audit — AI Visibility Operating System

> Date: 2026-07-31 · Auditor: Claude (lead-architect session)
> Method: four parallel deep-read audits (data model, measurement loop,
> execution/automation, auth/reporting/knowledge/UI) plus verification runs
> executed this session: `tsc --noEmit` (clean), `next lint` (0 warnings),
> `vitest` (**1014/1014 pass**, 63 files), Postgres live on :5433,
> migrations 001–028 applied. Companion documents:
> `target-gap-analysis.md`, `implementation-roadmap.md`. Earlier audits in
> `docs/audits/` (2026-07-29) covered migrations 001–011 only and are
> superseded by this document for current-state claims.

## Verdict in one paragraph

This is a **working single-operator agency platform with an
evidence-grade measurement core, a production-shaped workflow engine, and
a deep knowledge layer** — not a prototype. The full vertical slice
(onboard client → generate prompts → freeze → run → parse → classify →
review → score → gaps → tasks → interventions → remeasure → report) is
wired, tested against a real Postgres queue, and has been run live.
The honest weaknesses are: **authorization is authentication-deep only**
(project-level access control is dead code; client roles exist but cannot
be issued safely), several **cross-client tables blur tenant data**
(`evidence`, `sources`, `brand_candidates`), the **task layer is an
evidence ledger, not a work-management tool** (no owners/due dates/
dependencies/comments), scheduling is **built but inert** (`CRON_SECRET`
unset), and four target-spec pillars have **no implementation at all**:
market exclusivity/conflicts, campaigns/experiments as first-class
objects, a client-facing portal, and revenue attribution.

---

## 1. Current architecture

- **One Next.js 15 App Router app** (React 19, TypeScript strict, Tailwind
  v4 + shadcn/ui, dark mode, desktop-first). 52 server-rendered pages, all
  reading live data — zero placeholder pages.
- **Postgres via `postgres.js`** (raw SQL, camel transform), currently a
  Supabase-hosted database; local dev DB on :5433. 28 reversible
  migrations, 108 tables.
- **Single background worker** (`workers/index.ts`, `npm run worker`)
  polling a Postgres `jobs` table with leases, retries (3 × exponential
  backoff), stale-lease reclaim, graceful shutdown. ~17 job types.
- **Two parallel execution systems** (deliberate, spec 018):
  1. Legacy bespoke chains — `execute_run → parse_response →
     compute_scores`, weekly cycle state machine (`lib/cycles/`).
  2. Graph execution control plane (`lib/workflow/`) — versioned immutable
     workflow graphs, 15 node types, autonomy policies, approval gates,
     cost caps, crash-safe re-entrant ticks — with an automation library
     on top (`lib/automation/`: ~110 node handlers, 18 workflow
     definitions, triggers, domain-event bus, connector SDK).
- **AI provider abstraction** (`lib/ai/`): OpenAI (live-verified),
  Gemini (live-verified), Anthropic + Perplexity (implemented, never run
  live), mock. Search mode is a distinct pinned instrument (`+search`
  model-id suffix). Centralized retry/rate-limit/pricing.
- **Auth**: Supabase Auth (magic link), `AUTH_MODE=dev|supabase`, both
  functional; middleware session gate; roles `admin/operator/reviewer/
  client_viewer/client_validator`.
- **Storage**: local content-addressed filesystem (`var/`), hash-verified
  evidence exports; no cloud storage, no signed URLs.
- **Deployment**: laptop only. CI on push/PR (typecheck, lint, migrations
  up+down, full tests, build). Backups via `npm run backup`/`restore`.

## 2. Current data model (summary)

108 tables. Full inventory is in the migration files; the shape:

- **Tenancy**: `projects` is the client/tenant root (53 tables carry
  `project_id`; most others derive it via FK). `companies` is a global
  registry with per-project subject resolution.
- **Measurement**: `prompt_sets → prompts → prompt_set_versions` (frozen
  jsonb snapshots, immutable); `runs → responses` (insert-only, SHA-256
  at capture via trigger); `mentions` (append-only revisions);
  `scores` (versioned, never recomputed in place); `sources` (global
  citation registry).
- **Execution**: `gap_findings`, `tasks` (+evidence constraint),
  `interventions`/`intervention_runs`, `content_assets`/`content_versions`,
  `program_plans`/`plan_items`.
- **Workflow graph**: `workflow_definitions/versions/nodes/edges`
  (immutable), `workflow_runs/node_runs/transitions/signals/approvals/
  exceptions`, `agent_definitions/versions`, `autonomy_policies`,
  `quality_gate_results`.
- **Control tower**: `client_health_snapshots`, `action_outcomes`,
  `outcome_relationships`, `operator_capacity_snapshots`,
  `executive_briefs`.
- **Automation**: `domain_events` (transactional, immutable, causal
  chain), `event_subscriptions/delivery_attempts` (dead-letter),
  `automation_triggers`, `trigger_fires`, `webhook_endpoints/receipts`,
  `connector_connections/credentials` (AES-256-GCM envelope encryption),
  outreach sequences/messages/suppression.
- **Knowledge**: claims + immutable versions, source artifacts
  (content-addressed, legal-hold aware), extraction runs, entity graph
  (`knowledge_entities/entity_aliases/entity_relationships`), wiki pages
  with section-level provenance, incremental builds, context packets
  (immutable, token-budgeted, omissions recorded), maintenance runs,
  external discovery (spec 027).
- **Auth**: `users` (Supabase uid), `user_project_access` (read grants),
  `artifact_access_log` (immutable download log).
- **Reporting**: `reports` (weekly_pulse/monthly/quarterly kinds,
  published-immutable), `report` snapshots self-contained; `notifications`
  (derived, deduped, self-resolving); `cycle_runs`.

**Integrity discipline is the platform's standout**: `forbid_mutation`
triggers on 32 tables, capture-time hashing, append-only revisions,
versioned everything (parser, scoring, detectors, gates, health weights,
plans, graphs, packs — each with a code-side version constant), and an
83-call-site `audit_log`.

## 3. Existing major features (traced, not assumed)

| Feature | State | Evidence |
|---|---|---|
| Client onboarding (vertical pack → project + subject + claims + competitors + generated prompt set + background site crawl) | **Working, live-proven** (0.1 s, 33 prompts for a real-estate client) | `lib/verticals/onboarding.ts`, spec 012 |
| Prompt library with freeze/versioning/diff/holdouts | **Working** | `lib/prompts/set-service.ts` |
| Run execution (providers × repetitions, budget caps, idempotent resume, cancel, quota stop) | **Working** | `lib/runs/execute.ts`, `tests/integration/runs.test.ts` |
| Classification v2 (deterministic recall + LLM precision + fresh-context verifier + review queue + immutable revisions) | **Working**; silently degrades to heuristic v1 without `OPENAI_API_KEY` | `lib/parsing/*`, spec 013 |
| Scoring v1.0 (7 metrics, versioned, review-gated, independently re-derivable drill-down) | **Working** | `lib/scoring/*`, `lib/evidence/observations.ts`, docs/06 |
| Gap engine (6 deterministic detectors, documented 30/25/20/15/10 priority formula, organic-rate hygiene) | **Working** | `lib/gaps/detect.ts` |
| Tasks (evidence-required, approval-gated state machine) → interventions → scheduled +2/+6/+12-week remeasurement → read-time verdicts with confound detection | **Working** | `lib/tasks/`, `lib/attribution/` |
| Content engine (brief → draft → deterministic citation gate → fresh-context verify → approve → publish → auto-intervention) | **Working, live-proven (~$0.06)** | `lib/content/` |
| Program plans (14 real-estate plays, code-composed 90-day plans, client-facing HTML/Markdown export) | **Working** | `lib/plans/` |
| Weekly cycle (self-driving state machine that halts at judgement calls) | **Working, proven live**; not migrated to the graph engine | `lib/cycles/service.ts` |
| Graph execution control plane (versioned graphs, autonomy levels 0–4, approval gates with 72 h timeout, cost caps checked before spend, fan-out/fan-in, crash-safe) | **Production-shaped**; 3 shipped templates; 4 node types untested by any shipped graph | `lib/workflow/` |
| Control tower (cross-client queue merged from 5 sources with decomposable priority formula, client health with confidence, capacity, automation rate) | **Working** | `lib/control-tower/` |
| Automation library (18 workflow definitions, ~110 node handlers, triggers, transactional event bus, test mode with would-have-happened ledger) | **Built but inert by default** — client triggers ship disabled; 10/15 external connectors never executed live | `lib/automation/` |
| Knowledge layer (ingestion, extraction, claims, contradiction detection, wiki compilation with provenance, context packets, incremental rebuilds, maintenance, external discovery) | **Working**; deepest subsystem (~11,400 lines); no OCR, no vector retrieval, discovery has no UI and no live search run | `lib/knowledge/` |
| Reports (draft → evidence-gated publish → immutable; weekly/monthly/quarterly kinds; category-ownership map in snapshot; CSV export) | **Working**; no PDF, no branding, no delivery, no client surface | `lib/reports/` |
| Notifications (derived attention state, severity, dedup, self-resolving, digest) | **Working**; in-app only; hourly sync inert (cron) | `lib/notifications/` |
| Auth (magic link, roles, middleware, provisioning check) | **Working** (`AUTH_MODE=supabase` live); see §6 for the authorization gap | spec 014 |
| Evidence audit trail (hash verification, seeded samples, stability labels, exports, access log) | **Working** | `lib/evidence/` |

## 4. Existing user flows

1. **Onboard**: `/onboarding` wizard → project + pack + subject + claims +
   competitors + prompt set (unfrozen, for review) + queued site crawl.
2. **Measure**: freeze set → start run (`/projects/[id]/runs`) → worker
   executes cells → auto-parse → review queue (`/review`) → auto-score.
3. **Diagnose**: `/gaps` (detect from run) → create evidence-backed task
   or content brief; `/accuracy` for factual findings.
4. **Execute**: `/tasks` kanban (approve → start → complete-as-
   intervention); `/content` pipeline; `/plan` 90-day program.
5. **Verify**: `/interventions` — baseline vs post runs, verdicts.
6. **Report**: `/reports` — draft, narrative edit, evidence-gated publish,
   CSV; plan export for clients.
7. **Operate the portfolio**: `/` Today attention feed, `/notifications`,
   `/control-tower`, `/workflows`, `/agents`, `/automation/*` (nav-hidden).

## 5. Existing integrations & AI functionality

- **AI providers**: OpenAI + Gemini live-verified (incl. search
  grounding); Anthropic + Perplexity implemented but never run (keys now
  present in `.env` — verification is a small task); pricing verified for
  OpenAI/Anthropic, **placeholder for Google/Perplexity**; search-tool
  fees not in cost math.
- **Agents**: 26 registered with I/O schemas, tool/data-scope permissions,
  cost ceilings, verifier separation (creator-never-verifies enforced by
  allow-list); **11 implemented, 15 declared** (contract-only).
- **Connectors**: 16 adapters — 5 verified (internal), 9 implemented but
  never executed live (GA4, Search Console, Gmail, Calendar, HubSpot,
  Follow Up Boss, Stripe, WordPress, Slack), 2 contract-only (Salesforce,
  Webflow). OAuth flow not wired — tokens are pasted.
- **Crawling**: own-site crawler (sitemap-first, backoff; ignores
  robots.txt by documented decision) + external discovery (honours
  robots.txt; never run against a live search provider).

## 6. Security & data-isolation concerns (ranked)

1. **Supabase `DATABASE_URL` embeds the `postgres` superuser password in
   plaintext `.env`**, on a publicly resolvable host. Rotate; move the app
   to a least-privilege role. *(Operator action.)*
2. **Project-level authorization is dead code.** `visibleProjectIds()`
   (`lib/auth.ts:146`) and `user_project_access` have zero production call
   sites; every list query is unscoped; any authenticated user can open
   any project by URL. RLS exists on 3 of 108 tables and never applies
   anyway (the app connects as table owner). `docs/10-security.md`'s claim
   that `visibleProjectIds` is "the primary control" is **false today**.
3. **`assertCanWrite()` (client read-only gate) is enforced in exactly one
   module** (`lib/plans/service.ts`). Every other write service would
   accept a write from a `client_viewer`. Client roles must not be issued
   until this is closed.
4. **Three export API routes have no project scoping** (report CSV,
   evidence export, plan export) — any authenticated user can fetch any
   client's artifacts by id.
5. **Server actions with no auth check**: `app/jobs/actions.ts`
   (spends provider tokens), `app/notifications/actions.ts` (returns
   cross-client digest text), `app/onboarding/actions.ts:previewPrompts`.
6. **Cross-client tables**: `evidence` (no tenant column, untyped
   `ref_id`, target of every `evidence_ids[]` array), `sources`
   (globally unique URL, citation counts accumulate across clients),
   `brand_candidates` (global hit counts).
7. **Constant-time comparison** used for only one of four cron routes;
   the other three use `!==`.
8. **`CRON_SECRET` unset** → all scheduled automation (weekly baseline,
   weekly cycle, notifications sync, automation heartbeat, knowledge
   maintenance) is fail-closed **off**.
9. `created_by`/`approved_by`/`reviewed_by` on ~24 tables are bare uuids
   with no FK to `users`.
10. One `sql.unsafe()` site (`lib/reports/program.ts:23`) — validated
    upstream, but the validation lives two modules away.
11. `audit_log` has no `project_id` — per-client audit extraction requires
    per-entity resolution.

## 7. Mocks, placeholders, incomplete features

**The repo has zero TODO/FIXME comments; incompleteness is expressed as
status enums and spec "Not built" sections.** Verified inventory:

- Mock AI provider + fixture-mode connectors + injected search callers —
  properly quarantined to tests/demo seeds; CI runs keyless.
- Google/Perplexity token prices: placeholders (flagged in UI).
- Effort estimates (control-tower queue, plan plays): constants, not
  observed medians. Commercial value: 30-day provider spend as proxy.
- Intent tier: generated at onboarding, **never persisted** — the claimed
  per-tier report segmentation is impossible as built.
- `citation_rate` (drill-down name) vs `citation_score` (stored metric):
  the drill-down's stored-value check is vacuous.
- First-position/top-three: derived at read time, not stored metrics
  (deliberate deferral to a future scoring version).
- Monthly/quarterly executive-brief generators: enum accepts them, no
  generator. LLM report drafter: deferred since spec 006.
- Spec 011 (outreach CRM): draft status — journalist registry,
  newsworthiness, pitch drafting, ranking submissions all unbuilt; what
  exists is the safety layer (sequences, suppression, 7-check send gate).
- Spec 027 (external discovery): service works, **no UI, no live run**.
- Client validation: tables + service + tests + UI exist; deliberately
  never feeds benchmark metrics.
- Layout primitives (`PageShell` etc.): only 2/52 pages use them; the
  consistency test auto-exempts bespoke pages (honest but toothless).
- Loading/error states: 3 loading + 2 error files for 52 pages; zero
  `<Suspense>`; all pages force-dynamic.
- Knowledge-graph entity relationships (agent ↔ brokerage) are **not
  joined** to the measurement `companies` registry — two disconnected
  identity systems.
- No E2E/browser tests (recorded decision).

## 8. Technical strengths

1. Evidence integrity: immutability triggers, capture-time hashes,
   append-only revisions, hash-verified exports, seeded reproducible
   sampling, re-derivable metrics with divergence surfacing.
2. Versioning of every derived artifact, with cross-version comparison
   forbidden in UI/reports.
3. Honest uncertainty: null-not-zero discipline, confidence on health
   scores, `insufficient_measurement` outcome labels, unverified prices
   flagged, verdicts require ≥2 providers.
4. Idempotency at every layer (run cells, jobs, cycles, workflow starts,
   node instances, trigger fires, event delivery, findings, bootstrap).
5. Safety architecture: handlers cannot write workflow state; autonomy
   resolved per execution; approvals require rationale + evidence;
   test mode records would-have-happened actions; every human decision
   sets `human_touch` (making the automation-rate metric real).
6. 1014 passing tests including full-pipeline integration tests against
   the real queue; CI runs migrations both directions.

## 9. Technical weaknesses

1. Authorization depth (§6 items 2–5) — the one structural gap that
   blocks everything client-facing.
2. Task layer too thin for agency work management (no owners, due dates,
   dependencies, comments, recurrence).
3. Two parallel execution systems (cycles vs graph) — deliberate but a
   standing migration debt.
4. Event catalogue (~50 types) far ahead of producers (~20 call sites,
   none for gaps/tasks/benchmark lifecycle) — declared contracts without
   producers.
5. Single FIFO job queue without per-type fairness; single worker
   process; laptop deployment; local-disk artifacts.
6. UI consistency debt (50/52 bespoke shells), sparse loading/error
   states.
7. No region/locale in the provider contract; `prompts.language` unused
   by adapters.
