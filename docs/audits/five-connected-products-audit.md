# Five Connected Products — Technical & Product Audit

> Date: 2026-07-29 · Auditor: Claude (senior-engineer session)
> **Bias disclosure:** the auditor implemented most of this codebase. Every
> conclusion below is therefore backed by fresh verification runs and
> concrete repository evidence, not recollection. Checks executed this
> audit: `tsc --noEmit` (clean), `next lint` (0 warnings), `vitest`
> (**181/181 pass**, 24 files), `next build` (clean), migration up/down
> (11 migrations apply and reverse), unfinished-marker grep (findings below).

## Verdict in one paragraph

This is a **strong single-product platform (AI Visibility Intelligence,
score 78/100) with a partially built execution layer (Authority Execution,
58) and a real but narrow source-of-truth layer (Reputation Accuracy, 40)**,
wrapped in unusually good data-integrity foundations (immutability triggers,
capture-time SHA-256 hashing, versioned everything, append-only audit log).
**AI-to-Revenue Attribution is essentially absent (3/100)** and Executive
Advisory is a reporting engine, not an advisory system (44/100). The five
products do NOT yet operate as one closed loop: the visibility→gap→action→
remeasure chain IS connected and functional; the revenue and advisory links
are missing. Weighted overall platform maturity: **~46/100** — an honest
"strong measurement core, thin commercial shell."

## Governance & architecture reviewed

CLAUDE.md, PRINCIPLES.md, DECISIONS.md, docs/00–15, specs/001–012 +
specs/llm-evidence-capture-and-audit-trail.md, package.json, `.env` shape
(lib/env.ts), db/migrations/001–011, workers/index.ts, all 24 app routes,
3 API route handlers, 25 lib/ modules, tests/ (24 files). Full file list:
`audit-evidence-index.md`.

Architecture actual: one Next.js App Router app + local Postgres 14 (port
5433) + a Postgres-queue worker (`db/jobs.ts`, `workers/index.ts` handling
`execute_run`/`parse_response`/`compute_scores`/`start_scheduled_run`) +
5 LLM adapters (`lib/ai/{openai,anthropic,google,perplexity,mock}.ts`) +
local artifact storage (`var/evidence/`, `lib/evidence/storage.ts`). No
microservices, no external workflow engine (recorded decision), no cloud
storage, auth = dev-mode single user (`lib/auth.ts` throws for
AUTH_MODE=supabase — "not implemented yet").

## Unfinished-work markers (verified)

- `lib/auth.ts:26` — Supabase auth **not implemented** (deferred, DECISIONS).
- `lib/ai/pricing.ts` — Google/Perplexity prices are **placeholders**,
  flagged `verified:false`; OpenAI/Anthropic verified.
- Google/Perplexity adapters (`lib/ai/google.ts`, `lib/ai/perplexity.ts`)
  are real implementations but have **never executed against live APIs**
  (no keys) — classify CANNOT VERIFY.
- All other grep hits are benign UI form placeholders.
- CRON_SECRET unset in `.env` → the weekly baseline cron
  (`app/api/cron/weekly-baseline/route.ts`) is wired but **not scheduled**.

---

# Product 1 — AI Visibility Intelligence · **78/100**

Purpose: measure where a client appears in AI answers, vs whom, backed by
inspectable evidence.

| Category | Points | Evidence / what's missing |
|---|---|---|
| Core functionality | 21/25 | Frozen prompt sets (`lib/prompts/set-service.ts` freeze + `prompt_set_versions.frozen_prompts`, migration 002); runs with repetition/budget/idempotent resume (`lib/runs/execute.ts` — dedup via partial unique index, verified in `tests/integration/runs.test.ts`); search vs non-search as distinct pinned instruments (`lib/ai/openai.ts` `+search` via Responses API, DECISIONS); classification with confidence routing + human review (`lib/parsing/*`, `lib/mentions/*`, migration 004); metrics with versioning (`lib/scoring/*`, docs/06 v1.0); drill-down that re-derives numerator/denominator and flags stored-score divergence (`lib/evidence/observations.ts`); stability labels (`lib/evidence/stability.ts`); holdout prompts (migration 011). Missing: prompt paraphrase clusters as first-class objects (categories only), commercial-intent/difficulty scores per prompt (spec 012 deferred), location/market context on runs, top-three as a stored metric. |
| Data model & integrity | 14/15 | Insert-only `responses` (trigger, migration 003) with capture-time SHA-256 via BEFORE INSERT trigger + backfill (migration 011); mention revisions never overwrite (migration 004); scores versioned; append-only `audit_log`. Tamper detection proven in `tests/integration/evidence.test.ts`. −1: `sources` table is global, not project-scoped. |
| Workflow completeness | 13/15 | Queue with lease/retry/crash-recovery (`db/jobs.ts`, tested); auto parse→score chain; scheduled weekly baseline exists but is NOT running (no CRON_SECRET); scoring blocks on pending review (docs/06). |
| UI & usability | 7/10 | Full workspace (24 routes) incl. Evidence Explorer with positive/negative filters and per-prompt stability; run live-refresh. Missing: cross-run trend drill-down, quarterly views. |
| Integrations | 6/10 | OpenAI live-verified incl. web-search citations (`lib/ai/citations.ts`, extraction shapes for all 4 providers). Anthropic implemented, keyless; Google/Perplexity implemented, never run, prices placeholder. No browser/consumer capture (deferred with `EvidenceCaptureAdapter` interface, `lib/evidence/storage.ts`). |
| Testing | 9/10 | 181 tests incl. known-answer scoring fixtures (`tests/unit/scoring-metrics.test.ts`), immutability, crash-recovery, drill-down reproduction, export hash verification. No E2E (Playwright deferred, DECISIONS). |
| Security & permissions | 2/5 | Role gates exist (admin-only unarchive/reparse — `lib/attribution/service.ts`, `lib/mentions/service.ts`) but auth is a hardcoded dev user; no client separation of access. |
| Observability | 4/5 | Structured logs (`lib/logger.ts`) on every pipeline step; job failures visible in data-health tile. No alerting. |
| Client readiness | 2/5 | Evidence exports with hash manifest (`lib/evidence/export.ts`) are client-deliverable today; no client login/portal. |

**Biggest real risk (not a score line): classification quality.** The
heuristic parser (`parser-heuristic-v1`) miscounts *other* entities named
like the client — proven live: "What is Parva?" answered with Mahabharata
content and was counted as a mention (memory + specs/009 notes; visible in
`mentions` for run `c777b034…`). An evidence portal faithfully displaying
wrong classifications is worse than no portal for a paying client. → P0.

# Product 2 — Reputation Accuracy · **40/100**

| Category | Points | Evidence / gaps |
|---|---|---|
| Core functionality | 8/25 | Verified claims register exists and is real: propose-with-evidence → approve/supersede/reject, one-approved-per-key, audited (`lib/claims/service.ts`, migration 008, `tests/integration/knowledge.test.ts`). Entity aliases + domains (`companies`). **Missing entirely: factual-accuracy monitoring** (no detector compares LLM answers against approved claims), profile auditing (no Zillow/LinkedIn/GBP ingestion), correction workflow (generic tasks exist but no finding→corrected-wording→before/after-proof→recheck chain), monitoring/alerts (none — no notification system exists at all). |
| Data model | 10/15 | `claims` (canonical text, as_of, evidence_ids, status chain), `evidence` incl. `url` kind. Missing: claim categories/expiration dates, evidence quality/freshness ratings, structured entity facts (team members, licenses, awards as typed claims — currently free-form keys). |
| Workflow completeness | 5/15 | Human approval loop works end-to-end in UI (`app/projects/[id]/knowledge/`). Nothing feeds claims FROM observations (hallucination detection is manual reading). |
| UI | 5/10 | Knowledge page (subject selector, claim cards, propose dialog). |
| Integrations | 0/10 | No external profile sources. |
| Testing | 6/10 | Supersede chain, evidence requirement, audit trail covered. |
| Security | 2/5 | Same dev-auth ceiling. |
| Observability | 3/5 | Audited actions; no drift alerts. |
| Client readiness | 1/5 | The "approved fact book" is exportable only by hand. |

# Product 3 — Authority Execution · **58/100**

| Category | Points | Evidence / gaps |
|---|---|---|
| Core functionality | 13/25 | Gap taxonomy real: 6 typed detectors + deterministic 30/25/20/15/10 opportunity scoring (`lib/gaps/detect.ts`, live-validated on Parva). Evidence-backed task state machine with approval gates (`lib/tasks/service.ts`, migration 007). Content graph brief→draft→fact-verify→approve→publish with LLM agents behind a deterministic citation gate (`lib/content/*`, `lib/ai/agent.ts`) — live-validated (~$0.06, gates caught the system's own agents; DECISIONS). Publish auto-creates measuring intervention (`markPublished` → `createIntervention`). **Missing: the entire third-party arm** — media/journalist ops, ranking ops, transaction-to-authority (specs/011 is a draft doc only — DOCUMENTED ONLY), profile-correction workflow, content indexation/citation tracking post-publish. |
| Data model | 11/15 | gap_findings, tasks+evidence, content_assets/immutable versions, interventions. No journalists/pitches/rankings/transactions tables. |
| Workflow completeness | 9/15 | finding→task→complete-as-intervention→scheduled remeasure is wired and tested (`tests/unit/attribution.test.ts` loop-closure test). Content publish is human-external (by design). No recurring work, no dependencies between tasks. |
| UI | 6/10 | Gaps, Tasks board, Content pages in workspace nav. |
| Integrations | 3/10 | OpenAI agents only. No Gmail drafts, no search enrichment for competitor evidence (gap detector v1 is deterministic; LLM v2 deferred in spec 009 notes). |
| Testing | 8/10 | Detector fixtures, state-machine guards, content-gate blocking, loop closure. |
| Security | 2/5 | Approval gates + audit everywhere; auth ceiling. Red-level actions have no code path (send/submit/publish) — genuinely enforced. |
| Observability | 4/5 | Agent runs logged with cost (`agent.run` events). |
| Client readiness | 2/5 | Action plans exist as tasks; no client-facing packaging. |

# Product 4 — AI-to-Revenue Attribution · **3/100**

**Status: MISSING.** No GA4 integration, no analytics tables, no referral
classification, no lead capture, no CRM objects, no revenue models —
confirmed by absence in migrations 001–011, lib/, app/, and docs/ (docs/14
"future ideas" mentions it only as an idea). The 3 points: the
interventions system (`lib/attribution/service.ts` — note the module name
measures *visibility* attribution, not revenue) provides the
action→measurement-window→verdict skeleton that revenue attribution would
reuse, and `docs/06` names AI-referred sessions as a future metric.
Nothing else exists. Every capability row in the matrix for this product is
MISSING except that skeleton.

# Product 5 — Executive Advisory · **44/100**

| Category | Points | Evidence / gaps |
|---|---|---|
| Core functionality | 8/25 | Evidence-gated immutable reports with citation-checked narratives, deltas vs previous run, CSV export (`lib/reports/*`, migration 006); verdict-driven task suggestions (`suggestTasksFromVerdicts`, spec 007). **Missing: cadence system** (no distinct weekly pulse/monthly exec/quarterly review — one report type), category-ownership map (stability labels + gap findings are the ingredients, not the map), market-expansion comparison, what-if scenario planning, per-audience action plans, budget allocation. |
| Data model | 8/15 | Immutable report snapshots are self-contained (proven: rename-later test). No cadence/approval-queue/decision objects. |
| Workflow | 6/15 | Draft→edit→evidence-gate→publish→locked works end-to-end with tests. Generation is deterministic (`report-drafter-deterministic-v1`) — honest but not "advisory." |
| UI | 6/10 | Reports pages with acknowledgment gates for pending reviews. |
| Integrations | 2/10 | Nothing external; no scheduled delivery, no PDF. |
| Testing | 7/10 | Lifecycle, gate, immutability, snapshot self-containment. |
| Security | 2/5 | Auth ceiling. |
| Observability | 3/5 | — |
| Client readiness | 2/5 | Published reports + CSVs are deliverable; nothing sends them. |

---

# Connected-system audit (the 14-step loop)

| # | Step | Status | Evidence |
|---|---|---|---|
| 1 | Prompt cluster underperforms | **Connected & functional** | scores + `drilldown()` per category |
| 2 | Identify competitors recommended instead | **Connected & functional** | `listComparisonCompanies`, mention data, brand discovery |
| 3 | Identify sources supporting them | **Connected but incomplete** | `sources` + search citations (`lib/ai/citations.ts`) name domains; per-competitor source profiles need spec 009's deferred LLM enrichment |
| 4 | Compare with client's evidence | **Connected but incomplete** | gap detectors compare rates + citations vs subject; no external evidence fetching |
| 5 | Create evidence-gap finding | **Connected & functional** | `analyzeRun` → `gap_findings` |
| 6 | Finding → prioritized action | **Connected & functional** | `createTaskFromFinding` (evidence attached, human approves) |
| 7 | Action → content/profile/ranking/media workflow | **Partially connected** | content: functional (`createBriefFromFinding`); profile/ranking/media: not built |
| 8 | Work approved & completed | **Connected & functional** | task state machine + content approval gates |
| 9 | Completion recorded with date | **Connected & functional** | `completeTaskAsIntervention`, `markPublished` |
| 10 | Related clusters remeasured | **Connected & functional** | scheduled +2/+6/+12w runs via jobs `run_after`; verdicts on read |
| 11 | AI referral traffic measured | **Not connected** | product 4 missing |
| 12 | Leads/revenue measured | **Not connected** | product 4 missing |
| 13 | Leadership gets evidence-backed recommendation | **Manually connected** | reports + suggested tasks exist; no advisory synthesis across products |
| 14 | System learns from outcome | **Data model exists, no workflow** | verdicts stored; nothing feeds them back into opportunity scoring weights |

**Manual copy points today:** GA4/any analytics (entirely outside),
publishing content to the real site, recording ranking/press activity
(no objects to record into), and weekly report delivery (no send).

# Shared platform capabilities (summary)

- **Multi-tenancy:** project = client with subject-scoped parse/score and a
  tested no-cross-talk guarantee (`tests/integration/knowledge.test.ts`).
  No RLS, no per-client access control — separation is data-level only.
- **Roles:** admin/operator/viewer exist and gate destructive actions;
  client-viewer/validator roles do not exist as logins (validation tables
  exist — migration 011).
- **Approvals:** consistent suggested/draft→approved patterns with audit
  across tasks, claims, content, reports, review queue. Strong.
- **Auditability:** the platform's standout. Immutable evidence + hashes +
  revisions + append-only audit_log + hash-verified export packages.
- **Workflow engine:** Postgres queue with leases, retries, crash recovery
  (tested), scheduling via `run_after`. No dependencies/parallel DAGs;
  fine at current scale (DECISIONS: revisit at content-graph scale).
- **Agent framework:** one runner (`lib/ai/agent.ts` — pinned model, JSON,
  Zod, one retry, injectable test caller, cost logging), versioned prompts
  in `lib/content/prompts.ts` + docs/13; creator-never-verifies enforced.
  No central agent registry yet (three agents; fine).
- **Notifications: none exist.** No email/slack/in-app alerts anywhere.
- **Reporting/export:** CSV + evidence tar.gz with manifest; no PDF, no
  scheduled delivery, no client portal.
- **Security:** dev-auth single user; secrets in one `.env`; no signed
  URLs (local disk); no retention/deletion policy for client data;
  **no database or artifact backups** — client evidence lives on one
  laptop's disk.
- **Reliability:** classified errors + retry with backoff on provider
  calls (`lib/ai/retry.ts`); budget caps; duplicate-cell prevention;
  job health surfaced. No uptime monitoring (single-box internal).

# Duplication & architecture findings

Remarkably little duplication (one implementation each for parsing,
scoring, gaps, agents). Findings:
1. **Two citation systems converged but not unified**: mention-level
   `cited_urls` (text-proximity, spec 004) vs payload search citations
   (`lib/ai/citations.ts`) — merged at parse time now, but `sources`
   remains global (should be project-scoped) and has no per-response link
   table (drill-down re-derives instead; acceptable, but normalize when
   product 2 monitoring lands).
2. **Naming**: `lib/attribution/` measures visibility attribution;
   product 4 will want the name "attribution" for revenue. Rename to
   `lib/interventions/` before building product 4 to avoid a collision.
3. **`evidence` (task evidence) vs `evidence_artifacts` (files)** — two
   tables, related concepts, defensible split but document it (task
   evidence = DB refs; artifacts = hashed files).
4. **Dead/scaffold surface:** `client_validation_*` tables + services have
   no UI page yet (service + tests only — SCAFFOLDED at UI level);
   `EvidenceCaptureAdapter` is an intentional interface-only seam.
5. **JSON vs normalized:** `frozen_prompts` jsonb is a deliberate,
   correct snapshot pattern (immutability), not a smell. `providers`
   jsonb on runs likewise. No unnecessary normalization found.
6. **No rewrite recommended.** The five products fit the existing
   architecture as modules over the shared spine (queue, claims, evidence,
   approvals). See `architecture-consolidation-recommendations.md`.

# Verification limits (CANNOT VERIFY)

- Anthropic/Google/Perplexity adapters against live APIs (no keys).
- Cron endpoint behavior under a real scheduler (never scheduled).
- Behavior at multi-client scale (only 1 real + test clients exist).
- Playwright/E2E paths (deferred by decision; no browser automation).
