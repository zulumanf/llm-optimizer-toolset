# Prospect Acquisition — Current State Audit

> Audited: 2026-08-01, branch `feat/032-prospect-acquisition` (from `feat/037-trust-the-numbers`).
> Method: four parallel code audits (measurement core, exclusivity/tenancy, CRM/outreach, reporting/sharing) verified against migrations, services, UI, and tests.
> Purpose: establish what already exists before building the account-based acquisition layer (spec 032).

## Summary

The platform has a **production-grade measurement and evidence core** and a **complete exclusivity engine**, but **no persisted prospect entity, no sales pipeline, no secure external sharing, and no acquisition analytics**. The word "prospect" appears in exactly two places today: a free-text `prospect_name` on append-only exclusivity checks, and transient workflow payloads in the automation layer. Everything between "we found a team worth pursuing" and "they signed" lives in nobody's database.

---

## 1. Relevant existing models and tables

| Model | Table(s) | Migration | Notes |
|---|---|---|---|
| Client | `projects` | 001, 008, 014, 035 | **Projects ARE clients** — no separate clients table. `subject_company_id`, `vertical_pack_id`, `account_owner_id`, `service_tier ('standard'\|'premium'\|'exclusive')`. Status enum is only `active\|archived`. |
| Entity registry | `companies` | 004 | Global (not project-scoped) canonical names + aliases + domain. Global unique on `lower(name)` (active rows). `is_self` is a legacy single-tenant flag. |
| Competitors | `competitors` | 005 | `project_id × company_id × tier`. Competitor metrics use the **identical code path** as the subject (`lib/scoring/compute.ts:124` loops over company ids). |
| Prompt instrument | `prompt_sets` → `prompts` → `prompt_set_versions` | 002, 030 | Versions are frozen and DB-immutable. Prompts carry category, tier 1–4, holdout flag. |
| Runs | `runs` → `responses` | 003, 011 | `runs.project_id` is `NOT NULL`. Responses immutable, SHA-256 hashed by Postgres trigger. Failed cells stored as evidence. |
| Classification | `mentions`, `response_citations`, `response_parses`, `brand_candidates` | 004, 029, 033 | Immutable; corrections are new revisions. LLM classifier v2 + heuristic v1 fallback. |
| Scores | `scores` | 004 | Per run × company × metric × provider × scoring_version. `SCORING_VERSION = "v1.1"`. |
| Markets | `markets` | 032 | Global containment tree (city → borough → neighborhood), aliases (currently write-only dead data). |
| Exclusivity | `exclusivity_agreements`, `exclusivity_scopes`, `exclusivity_checks` | 032 | Complete. Checks are append-only and store `prospect_name` as a **string** — no entity link. |
| Findings (client) | `gap_findings` | 009 | Deterministic detectors, severity, `opportunity_score`, `evidence_ids uuid[]`, status open→task_created/dismissed. The closest existing analogue to "prospect findings". |
| Accuracy findings | `accuracy_findings` | 012 | Verbatim-quote findings against approved claims. |
| Tasks | `tasks` | 007, 031 | DB CHECK: a `suggested` task must carry ≥1 evidence id — precedent for "no claim without evidence". |
| Reports | `reports` | 006, 013 | Draft→publish→lock (DB trigger blocks UPDATE/DELETE on published). Evidence-citation gate at publish. |
| Campaigns | `campaigns`, `campaign_members` | 034 | Grouping layer over interventions (spec 029, done). Not prospecting. |
| Outreach (automation) | `outreach_sequences`, `outreach_messages`, `suppression_entries` | 020 | See §4. `subject_ref` is a free string — no FK to any prospect. |
| Evidence layer | `evidence`, `evidence_artifacts`, `audit_samples`, `evidence_exports`, `client_validation_*` | 007, 011 | Hash-verified, immutable, exportable as tar.gz with manifest. Keyed on `run_id` — fully reusable. |
| Audit | `audit_log` | 001 | Immutable, transactional writer `writeAudit(tx, …)`. **No UI viewer.** |
| Access log | `artifact_access_log` | 025 | Insert-only, nullable `user_id`, but `artifact_type` CHECK is limited to 4 report/evidence types; only the report-HTML route writes it. |
| Events | `domain_events`, `event_subscriptions`, `event_delivery_attempts` | 020 | 47 typed events. `prospect.identified`, `lead.created`, `opportunity.created/stage_changed` are **declared with no publisher**. |
| Jobs | `jobs` | 003 | Real Postgres queue + worker (`workers/index.ts`), lease reclaim, dead-letter. |

## 2. Existing prospecting / CRM functionality

- **No `prospects`, `leads`, `contacts`, `deals`, or `activities` tables.** Confirmed across all 37 migrations.
- Prospects exist only as transient workflow payload (`lib/automation/workflows/revenue.ts:58-64`: `prospectId`, name, company, website, market, email — never persisted).
- `prospect_audit_outreach_v1` workflow (autonomy 2, approval-gated) runs end-to-end **in test mode** (proved by `tests/integration/automation-demos.test.ts:222` "Demo A"): suppression pre-check → qualification → evidence packet → thesis agent → draft agent → `verify_claims` → sequence → human approval → Gmail draft → gated send. But its trigger event `prospect.identified` has **no publisher**, so it only starts manually.
- Pipeline/deal stages exist **only via external CRM connectors** (HubSpot/Follow Up Boss `implemented_unverified`, Salesforce `contract_only`; OAuth redirect flow unbuilt — nothing has ever run against a live provider). `crm.create_opportunity` doesn't exist as a capability even though a workflow acceptance criterion depends on it.
- The inbound-lead workflow dedupes leads against the `companies` table (`lib/automation/workflows/revenue.ts:277-281`) — semantically wrong; that table holds measured brands.
- Spec 011 (Outreach CRM) is **journalist/media pitching for existing clients**, entirely unbuilt, and its red-level rule ("no send code path may exist") now contradicts the shipped gated send path in migration 020. Needs an explicit reconciliation decision.

## 3. Existing AI benchmark functionality

Fully functional pipeline: `startRun` → cell expansion + cost estimate → provider execution (concurrency-capped, budget-capped, resumable) → immutable raw capture → parse (LLM v2 / heuristic v1) → score → drill-down → hash-verified evidence export.

- Metrics (`lib/scoring/metrics.ts`): mention_rate, recommendation_rate, share_of_voice, position_score, citation_score, sentiment_index → weighted `authority_score` (documented weights, null-weight redistribution — **note: this is AI-visibility authority, not real-world authority**); standalone first_position_rate, top_three_rate. Null ≠ 0 throughout.
- Providers: **only OpenAI has a live key.** Anthropic/Google/Perplexity adapters are real code but unverified/unkeyed. Mock provider is properly fenced (`lib/ai/registry.ts:29-43` throws outside test unless `ALLOW_MOCK_PROVIDER=1` — the prior P0 is fixed). Grounded-search fees are not in the cost math.
- **Hard couplings that matter for prospects:**
  1. `runs.project_id NOT NULL`; `startRun` rejects non-`active` projects.
  2. Parsing throws without a project subject company (`lib/parsing/service.ts:40-47`).
  3. `listCompaniesForProject` (`db/companies.ts:66`) includes every active company **except other projects' subjects** — creating a prospect-as-project would silently shrink every client's share-of-voice denominator.
  4. Global unique names on `companies` and active `projects` — a prospect that is already a client's tracked competitor collides.
- **Highly reusable as-is:** pure metrics math, cell expansion, execution engine, workers, evidence layer (keyed on run_id), competitor scoring path, bounded competitor backfill (re-parse last 12 runs without re-spending tokens), `onboardClient` (`lib/verticals/onboarding.ts` — its own comment already anticipates "a prospect's website").

## 4. Existing email / outreach / notification functionality

- **No transactional email at all** (no resend/nodemailer/sendgrid/SMTP). Outbound = Gmail REST via connector OAuth tokens; `email.create_draft` and `email.send_approved_message` are `implemented_unverified`.
- Sequences (`lib/outreach/sequences.ts`, 424 lines): create, record-sent, apply-reply-signal, stop. Unsupported factual claims **block** draft storage. Suppression (`lib/outreach/suppression.ts`): normalized matching, 7-check send gate.
- **The follow-up dispatcher does not exist**: `dueSequences()` is called by nothing; steps 2–4 of every sequence never fire. `publishSequenceStopped()` is dead code, so booked meetings emit no event.
- **No reply/bounce ingest**: Gmail thread reader + reply-signal nodes exist but no workflow references them; no `classify_reply` prompt; no bounce webhook mapping.
- No suppression-add UI (server action exists, no caller). Outreach page (`app/automation/outreach/page.tsx`) is read-only counts + stop button.
- Internal notifications are DB rows (`notifications` table + inbox UI), not email.

## 5. Existing reporting / sharing / analytics

- Reports: draft→edit→publish→lock lifecycle with an enforced evidence-citation gate; print-HTML + CSV export (no PDF — recorded cut). Program reporting (spec 016) done.
- Client portal (spec 031 v1): authenticated, read-only, role-gated. **No share links, no branding.**
- **Secure external sharing does not exist anywhere.** Zero hits for share tokens/links across db/lib/app. The only unauthenticated routes are HMAC webhooks and bearer-token cron — the patterns a token route should follow.
- View tracking: `artifact_access_log` (insert-only, nullable user_id, ip/user-agent) exists but has one writer (report-HTML route) and zero UI readers.
- Dashboards: project dashboard, portfolio "Today", Control Tower (health/capacity/briefs), automation/events. **No acquisition analytics.**
- Design system: shadcn new-york, `PageShell`/`PageHeader`/`Section`/`EmptyState`/`StatGrid` primitives in `components/layout/page.tsx` (adopted by only 2/61 pages; new pages should use them). Nav: per-project sections in `components/layout/sections.ts`, global links hardcoded in `components/layout/sidebar-nav.tsx` + staff gate via `requireStaffPage()` in the segment layout.

## 6. Existing activity tracking

Three layers, none prospect-shaped:
- `audit_log` — transactional, immutable, `entity.verb` actions. No viewer UI.
- `domain_events` — typed catalog, transactional publish, delivery/dead-letter, event-log UI.
- `artifact_access_log` — see §5.
There is no per-record timeline view anywhere in the product.

## 7. Existing exclusivity logic

Complete and functional (spec 028): market containment tree, agreements with grace periods, scope overlap (market × service × segment), verdict ladder `direct > partial > possible > clear`, append-only checks, admin-only overrides with mandatory rationale, both test tiers green. Known defects: sibling-cap deviation on the "Miami vs Manhattan" acceptance case (test routes around it), `terminateAgreement`/`setMarketParent` have no UI, aliases are dead data, no market seed script, read functions rely on the page gate rather than their own role assertion.

**`checkProspect` takes a name string** — the acquisition layer must link checks to a real prospect entity and gate pipeline progression on the verdict.

## 8. Existing mock / demo / seed data

- "Demo A — prospect outreach" fixtures in `tests/integration/automation-demos.test.ts` (fictional "Ada Realtor / Gables Group"), plus `workflow_fixtures` test-mode machinery with `allowCrmWrites` guard.
- `scripts/seed-graph.ts` (outcome graph), `scripts/seed-knowledge.ts` (Northvale Demo Group), `scripts/onboard-jc-luxury.ts` (a real client). **No seed creates outreach, exclusivity, or prospect data** — those pages boot to empty states.

## 9. Incomplete workflows (relevant to acquisition)

1. Sequence follow-ups (no dispatcher).
2. Reply/bounce ingest and classification.
3. `prospect.identified` / `lead.created` events (no publisher).
4. CRM opportunity creation (capability missing entirely).
5. Journalist CRM (spec 011 — unbuilt and contradicted).
6. Evaluation suites `outreach-quality-v1` / `lead-qualification-v1` (declared, unimplemented).
7. Report delivery (no `report.*` events, no email).

## 10. Security and tenant-isolation posture

- Enforcement is `getCurrentUser()` + `assertRole`/`assertCanWrite`/`assertProjectAccess` **inside every action and page**; middleware is explicitly a convenience gate. Denials 404, never 403.
- Roles: `admin`, `operator`, `reviewer` (staff) vs `client_viewer`, `client_validator` (per-project grants via `user_project_access`, read-only). `AUTH_MODE=supabase` is live (spec 014's "still dev" note is stale).
- RLS exists as defence-in-depth only (app connects as owner).
- **Concerns for the acquisition layer:** prospecting data is agency-only and must never reach `client_*` roles (the portal reads are SQL-filtered; a new module must apply the same discipline); a public audit page will be the platform's **first anonymous content route** — middleware `PUBLIC_PREFIXES` must be extended deliberately, tokens must be high-entropy and revocable, and the page must render from a published snapshot (never live internal queries) so internal notes cannot leak.

## 11. Stale documentation found during audit

- `specs/028` header still claims a migration blocker that `DECISIONS.md` records as resolved.
- `specs/014` claims `AUTH_MODE` is still dev — `.env` says `supabase`.
- `docs/target-gap-analysis.md:14` still lists exclusivity as "Missing / Nothing".
