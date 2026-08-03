# Current-State Audit — LLM Visibility Optimizer (AI Visibility OS)

Audit date: 2026-08-02 · Branch: `feat/032-contacts-and-import` · HEAD: `bcf448d`
Method: full repository inspection (schema, `lib/`, `app/`, `mcp/`, `workers/`, `tests/`, CI) plus execution of all safe validation commands. Every conclusion carries a file reference.

## 1. Validation results (recorded before any change)

| Command | Result |
|---|---|
| `npm ci` equivalent (deps installed) | OK — lockfile consistent |
| `npm run typecheck` (`tsc --noEmit`) | **Pass** |
| `npm run lint` (`next lint --max-warnings 0`) | **Fail (1 warning)** — `lib/prospects/service.ts:57` `parseProspectImport` imported but unused. This is the in-flight, uncommitted spec-032 work, not a regression. |
| `npm test` (Vitest) | **Pass** — 97 files, 1251 tests, ~186 s (integration tests run against local Postgres :5433) |
| `npm run build` (`next build`) | **Pass** — 60+ routes compile |
| Migrations | 43 committed + 1 uncommitted (`042`); CI applies up → down×N → up on every push (`.github/workflows/ci.yml`) |

Uncommitted working-tree state (preserved, not overwritten):

- `db/migrations/042_prospect_contacts_and_import.sql` (untracked) — `prospect_contacts` table + `outreach_drafts.contact_id`. Referenced by **zero** lines of TypeScript.
- `lib/prospects/import.ts` (untracked) — pure CSV parser (`parseCsv`, `parseProspectImport`, `IMPORT_ROW_CAP=200`). No caller, no persistence, no test.
- `lib/prospects/service.ts` (modified) — one added line: the unused import above.
- `mcp/server.ts` (modified) — `import "dotenv/config"` first-import fix (correct; matches `workers/index.ts:11`). Note `scripts/verify-providers.ts:10-11` still has the old hoisting-buggy form.
- Ordering note: `042` is untracked while `043_prompt_source.sql` is already committed. The runner (`scripts/migrate.ts`) keys on filename, so `042` will still apply, but out of ordinal order on any environment already at 043. Acceptable for a single-team internal tool; recorded here deliberately.

## 2. Architecture summary

One Next.js 15 (App Router, React 19) app + Postgres (postgres.js, no ORM) + a Postgres-queue worker (`workers/index.ts`, `db/jobs.ts` — `FOR UPDATE SKIP LOCKED`, 3 attempts, exponential backoff) + a stdio MCP server (`mcp/server.ts`, 21 tools in `lib/mcp/tools.ts`). Server actions for mutations; route handlers only for cron/webhooks/exports. Business logic lives entirely in `lib/` (200 files, ~54k lines, 47 subdirectories); data access in `db/`; 44 migrations under `db/migrations/`. Auth is dual-mode (`AUTH_MODE=dev|supabase`, `lib/auth.ts`) with five roles; staff gates on every prospect surface. Spec-driven: `specs/001–037` + `docs/00–17`.

This is **not** a greenfield: the measurement core (prompt sets → frozen versions → runs → immutable raw responses → parsed mentions → versioned scores → citations) is mature, tested, and production-shaped. The prospect-acquisition layer (spec 032/038) is a working vertical slice. What the target pipeline adds is mostly *around* these cores, not inside them.

## 3. Technology stack

TypeScript strict · Next 15 / React 19 · Tailwind 4 + shadcn/radix · postgres.js against Postgres 14 (:5433 local) · Vitest 3 (97 files, no browser E2E) · AI SDKs: openai, @anthropic-ai/sdk, @google/genai, Perplexity via OpenAI-compatible HTTP (`lib/ai/perplexity.ts`) · MCP SDK · zod everywhere · GitHub Actions CI (typecheck → lint → migrate up/down/up → test → build, deliberately keyless).

## 4. Existing database entities (130 tables, grouped)

- **Tenancy/identity/audit:** `projects` (+`kind` client|prospect, 041), `users`, `user_project_access`, `audit_log` (insert-only), `mcp_invocations`, `notifications`, `artifact_access_log`.
- **Markets/exclusivity:** `markets` (containment tree, `parent_id`, `aliases text[]`, kinds city|borough|neighborhood|region|custom — migration 032), `exclusivity_agreements/scopes/checks`, `vertical_packs`, `campaigns`.
- **Measurement core:** `prompt_sets`, `prompts` (+tier 030, +source 043), `prompt_set_versions` (immutable), `runs`, `responses` (insert-only trigger + SHA-256 hashes), `response_parses`, `mentions` (immutable revision chain), `scores` (versioned), `sources`, `response_citations`, `gap_findings`, `accuracy_findings`, `jobs`.
- **Evidence:** `evidence`, `evidence_artifacts`, `audit_samples`, `client_validation_*`, `evidence_exports`.
- **Knowledge graph:** `claims`(+versions), `knowledge_entities`, `entity_aliases`, `source_artifacts` (provider/url/retrieved_at/sha256), wiki tables, discovery tables (028).
- **Workflow/automation (017/020):** workflow engine tables, `domain_events` (+dead-letter on delivery attempts), triggers, connectors, `suppression_entries`, `outreach_sequences/messages`.
- **Prospect acquisition (038 + uncommitted 042):** `market_launches`, `prospects` (17-stage pipeline, `field_provenance` jsonb, conflict status), `prospect_authority_signals`, `prospect_benchmarks` (links, never copies, existing runs), `prospect_findings` (approved requires evidence — DB check), `prospect_audits` (published rows locked, tokened public page), `prospect_audit_views`, `outreach_drafts` (approved rows locked), `screen_recording_plans`, `prospect_stage_history`/`prospect_activities` (immutable), `prospect_contacts` (uncommitted).

`docs/03-database-schema.md` documents only migrations 001–024; 028–043 are undocumented there (doc drift).

## 5. Working functionality (verified by tests and inspection)

- **AI visibility execution:** 4 real providers + guarded mock (`lib/ai/registry.ts:29-49` — mock refused outside test unless `ALLOW_MOCK_PROVIDER=1`), search modes as distinct model ids, retry/backoff with rate-limit vs quota distinction (`lib/ai/retry.ts`), per-run USD budgets enforced between cells (`lib/runs/execute.ts`), micro-USD pricing that throws on unknown models (`lib/ai/pricing.ts`).
- **Raw-response immutability + parsing:** insert-only `responses` with payload hashes; parse prepass → heuristic or LLM classifier v2 with independent verifier (`lib/parsing/classify-llm.ts`); parser version stamped per mention; re-parse appends revisions.
- **Mention review queue:** `lib/mentions/service.ts` + `app/projects/[id]/review` — confirm/correct as immutable new revisions, bulk ops, keyboard-driven UI.
- **Scoring:** `lib/scoring/metrics.ts` — mention/recommendation rate, share of voice, position score, sentiment, citation score; null-not-zero semantics; `authorityScore` weighted sum with null-weight redistribution; versioned inserts; review gate before scoring. Known-answer tests in `tests/unit/scoring-metrics.test.ts`.
- **Prospect slice (spec 032):** launches → prospects → authority signals (with provenance labels + source URLs) → benchmark linkage or prospect-owned benchmark projects (041; client scores proven byte-identical, `tests/integration/prospect-benchmark-projects.test.ts`) → deterministic evidence-gated findings → human review → published tokened mini-audit (immutable snapshot) → versioned outreach drafts with prohibited-phrase gate → stage ladder with conflict/do-not-contact gates → immutable history/activity.
- **Exclusivity:** market containment tree + structural conflict verdicts (`lib/exclusivity/detect.ts`), fully tested.
- **SSRF-safe fetching:** `lib/security/safe-fetch.ts` — DNS-validated, redirect-revalidated, streaming size caps.
- **MCP interface:** 21 staff-gated tools, idempotency-keyed mutations, append-only invocation ledger.
- **Feedback machinery (client side):** `lib/outcomes/` (confidence ceilings by creator kind), `lib/learnings/`, `lib/attribution/` (baseline/post re-runs on the frozen instrument).

## 6. Requirements matrix vs the target pipeline

Statuses: Complete / Partial / Missing / Broken / Unclear / Out of scope.

| Pipeline capability | Status | Existing implementation | Problems | Required work |
|---|---|---|---|---|
| 1. Market selection & prospect filtering | Partial | `markets` tree + launches (`db/migrations/032`, `038`); `listProspects` (`lib/prospects/service.ts:420`) | Only `launchId/limit/offset` filters; `app/prospects/page.tsx` renders an unfiltered table; no stage/market/score/segment filters, no search, no pagination UI | Extend `listProspects` predicates + filter UI; score filters arrive with scoring work |
| 2. Geographic hierarchy (country→…→ZIP, aliases) | Partial | `markets` self-referencing tree with `aliases text[]` (`032:8`) | Kinds stop at city/borough/neighborhood/region/custom — no country/state/metro/county/ZIP; no cycle guard on `parent_id`; aliases are an array without provenance; a second unlinked geo model in `knowledge_entities` | Widen `kind` enum + seed hierarchies per market pack; add cycle guard; reconcile with knowledge entities later |
| 3. Prospect discovery (provider-based) | Partial → in flight | Manual entry (`createProspect`); `PROSPECT_SOURCES = manual/csv/referral/research`; CSV parser exists uncommitted (`lib/prospects/import.ts`) | No `ProspectSourceAdapter` interface, no adapters, CSV path unwired (no persistence/caller/test) | **This audit's implementation slice:** wire CSV import end-to-end; adapter interface next |
| 4. Prospect normalization (canonical record) | Partial | `prospects` (038:41): type, brokerage_affiliation, team_leader, website, contacts, socials, neighborhoods, specialties, `field_provenance` jsonb | Unique only per launch — same firm in two launches = two rows; no alias table; brokerage/team-leader are free text, not entities; no awards/media as structured fields (they live in authority signals — acceptable) | Cross-launch canonical linkage via `company_id`; prospect alias support |
| 5. Entity resolution | Partial | Mention-level: alias scan + LLM `isSameEntity` + review queue (`lib/parsing/`, `lib/mentions/`); `knowledge_entities` merge machinery; `source_normalizations` match statuses | No prospect-level resolver ("Smith Team" vs "John Smith at Compass"); `companies` vs `knowledge_entities` are two unreconciled registries; brokerage mention ≠ agent mention is vocabulary (`PROSPECT_TYPES`, `ENTITY_TYPES`) but not resolution logic | Prospect↔company resolution pass with confidence + review queue reuse |
| 6. Market packs | Partial | `vertical_packs` (014) + `lib/verticals/packs.ts`: variables, 13 real-estate templates, compliance rules, version-pinned per project | Industry packs, not city packs: no neighborhoods/ZIPs/price tiers/local publications/excluded place names per market; "market" has three unreconciled representations (pack variable, `markets` tree, knowledge entities) | Add market-pack data structure referencing `markets` rows; keep data-driven |
| 7. Prompt generation | Partial | `lib/verticals/expand.ts` deterministic template expansion (`{market}/{neighborhood}/{propertyType}/{clientType}`), tier-ordered, capped at 40; intent classifier (`lib/prompts/classify.ts`); branded vs non-branded via `PromptCategory` | No audience/price-tier fields on prompts; tiers persisted but consumed by nothing (`lib/verticals/types.ts:20-27`); two rival intent-value models (`IntentTier` vs `CATEGORY_VALUE` in `lib/gaps/detect.ts:72`); template→prompt lineage not stored | Market-pack-driven generation; unify intent value; store lineage + audience/price-tier |
| 8. AI visibility execution | Complete | `lib/ai/*`, `lib/runs/execute.ts`; execution environment honestly labeled (API ≠ consumer app, per `docs/07`) | Anthropic/Perplexity/`+search` adapters self-declared never run against live keys; no in-app provider health check (only `scripts/verify-providers.ts`); some prices are placeholders | Fund/verify keys (roadmap 4.5); add health check endpoint |
| 9. AI response parsing | Complete | `lib/parsing/` + `lib/ai/citations.ts` (all four payload shapes); competitors via `brand_candidates`; confidence-routed review | Prompt-injection defense is instruction-only (see §9) | Structural sanitization layer (security work) |
| 10. Valuable AI visibility (weighted) | Partial | Raw metrics complete (`lib/scoring/metrics.ts`); organic vs branded distinction exists but lives in `lib/gaps/detect.ts:32-49`, not scoring; stability labels in `lib/evidence/stability.ts` | No intent/relevance/position-weighted composite persisted to `scores`; weighted mention rate not a first-class metric | New scoring-version metric composing intent tier × position × recommendation strength; persist under `scoring_version` |
| 11. Real-world authority | Partial | `prospect_authority_signals` (16 kinds, provenance, source URL, confidence); `authorityScore` exists but scores *AI visibility*, not real-world authority | No numeric local-authority score computed from signals; signals lack `retrieved_at`/`verification_status` (038:103-106); global vs local volume not distinguished structurally | Authority score over signals with evidence display; add missing provenance columns |
| 12. Visibility gap | Partial | `prospect_findings.kind='authority_visibility_gap'` (deterministic generator, `lib/prospects/findings.ts`); `gap_findings` for clients | Qualitative finding, not a two-component numeric gap (authority score − weighted visibility) | Depends on 10+11; then a computed, evidence-linked gap number |
| 13. Diagnosis layer | Missing | Nearest: `gap_findings` 6 typed gaps, `accuracy_findings`, finding `explanation` text | No diagnosis taxonomy (missing-from-cited-sources, weak neighborhood content, entity confusion…), no per-diagnosis evidence/confidence/affected-prompts | New diagnosis module keyed off citations + findings |
| 14. Fixability scoring | Missing | Zero occurrences of "fixability" repo-wide; nearest analogue `opportunityScore` (`lib/gaps/detect.ts`) | No subscores, no confidence adjustment, no hard flags | New module per the 6-category rubric; store subscores + evidence |
| 15. Buying signals | Missing | `AUTHORITY_SIGNAL_KINDS` are authority evidence, not purchase intent; `prospect_audit_views` is the only behavioral signal | No signal table, no source+date capture | New `prospect_buying_signals` (mirror authority-signal shape) |
| 16. Contactability | Partial → in flight | `prospects.email/phone/socials`; uncommitted `prospect_contacts` (roles, channels, per-contact DNC, provenance) | Table unwired; no contactability score; no verification/bounce state | **This slice:** wire contacts CRUD + suppression matching; score later |
| 17. Final prospect score (configurable weights) | Missing | `prospects.qualification_score` is an unwritten column (038:63); four independent hardcoded weight tables (`AUTHORITY_WEIGHTS`, `GAP_FACTORS`+`CATEGORY_VALUE`, findings `rankScore`, control-tower priority) | No composite, no configurable weights, no explainability surface | Config-driven weights table + composite writer + UI explanation |
| 18. Prospect mini-audit | Complete | `publishAudit` (`lib/prospects/service.ts:974`): immutable snapshot, tokened public page (`app/audit/[token]`), methodology + limitations text, view tracking, revoke/expiry | No staleness warning on old snapshots; no in-place editor (by design — snapshot immutability) | Add benchmark-age display; extend snapshot as new scores land |
| 19. Human QA workflow | Complete (minor gaps) | 17-stage ladder + `validateTransition` (`lib/prospects/stages.ts`); findings approve/reject with evidence gate; mention correction; audited overrides for conflict gates | No score override-with-reason (no score yet to override); prospect suppression is `do_not_contact`, not a suppression-entry link | Add override plumbing when scores exist |
| 20. Outreach | Partial | Deterministic versioned drafts, prohibited-phrase gate, approve/record-sent (never auto-sends), supersession (`lib/prospects/outreach.ts`, service 1181–1398); platform send-gate `assertSendAllowed` (7 fail-closed checks, `lib/outreach/suppression.ts`) | **The two stacks don't talk:** `approveOutreachDraft` never consults `suppression_entries` nor (obviously) the unwired `prospect_contacts.do_not_contact`; no replies/meetings tables (stages carry it); spec-011 send contradiction still open (roadmap 3.1) | **This slice:** contact-level DNC + suppression matching in approve/record-sent |
| 21. Feedback loop | Partial | Client side complete (`lib/outcomes/`, `lib/learnings/`, `lib/attribution/`) | Nothing links outreach results back to the finding/draft that produced them; no acquisition funnel analytics (roadmap 3.7) | Phase 3 work |
| Internet data access layer | Partial | `safe-fetch.ts` (strong SSRF), robots parsing (`lib/knowledge/discovery/robots.ts`), politeness delays, content-hash idempotency, named UA | See `docs/integrations/internet-data-access.md`: `loadRobots` bypasses `safeFetch` (no DNS check/size cap); no cross-job host rate limiter; no HTTP cache/ETag; no domain allowlist; instruction-only injection defense | Fix robots fetch; add provider-adapter layer as providers are licensed |
| Jobs & queues | Partial | Postgres queue + 21 handlers; idempotency pervasive elsewhere (fan keys, dedupe keys, content hashes) | `jobs` itself has no idempotency key and no dead-letter (contrast `event_delivery_attempts.dead_lettered_at`); failed jobs sit terminal with no requeue path | Add dedupe key + requeue admin path |
| Data freshness | Partial | Strong for knowledge (`wiki_pages.freshness_status`, claim review dates, maintenance runs) | Absent for prospects/signals/benchmarks — a 6-month-old benchmark renders identically to a fresh one | Freshness windows + UI badges for prospect surfaces |
| Observability | Partial | `lib/logger.ts` structured JSON; in-product health (control tower, connector health, `mcp_invocations`); run cost tracking | No metrics/tracing/error service; no provider success-rate rollup; no score-distribution view | Incremental; not blocking |
| Security | Partial | Server-side secrets, zod input validation, cron constant-time auth, AES-GCM credential envelope, staff gates, audit log, immutability triggers | No Postgres RLS (known, blocked on Supabase project — `docs/08-roadmap.md`); env-schema drift (`AUTOMATION_CREDENTIAL_KEY`, `GOOGLE_API_KEY`, `PERPLEXITY_API_KEY` read ad hoc, not in `lib/env.ts` schema); robots fetch hole; instruction-only injection defense | Fix env drift + robots; RLS when hosted |
| Consumer-AI-chat scraping | Out of scope | Correctly absent; API-only with honest labeling (`docs/07-experiment-protocol.md`) | — | Keep it that way |

## 7. Broken functionality

- **Lint gate:** the one warning above (in-flight work). Nothing else found broken — the suite, typecheck, and build are green.
- **Latent:** `scripts/verify-providers.ts` dotenv-after-imports means provider keys may be unset when the module-load reads happen (same bug just fixed in `mcp/server.ts`).

## 8. Duplicate or conflicting functionality

1. Four independent weighted-scoring formulas, none config-driven: `AUTHORITY_WEIGHTS` (`lib/scoring/metrics.ts:7`), `CATEGORY_VALUE`+`GAP_FACTORS` (`lib/gaps/detect.ts:72-90`), `rankScore` (`lib/prospects/findings.ts`), control-tower priority (`lib/control-tower/queue.ts:47-58`). The target's "configurable final prospect score" should not become a fifth pattern — it should establish the shared mechanism.
2. Two prompt commercial-value models: `IntentTier` (persisted, unused) vs `CATEGORY_VALUE` (used by gaps).
3. Three "market" representations: vertical-pack variable strings, the `markets` tree, `knowledge_entities` market/neighborhood types.
4. Two entity registries with no bridge: `companies` (parser-facing) and `knowledge_entities` (claims-facing).
5. Two outreach stacks that never join: prospect drafts (038) vs sequences/suppression (020); `outreach_sequences.subject_ref` is bare text, not a prospect FK.
6. `organicMentionRate` lives in `lib/gaps/`, not `lib/scoring/`, and is never persisted.

## 9. Security concerns

- `lib/knowledge/discovery/robots.ts:150-176` fetches robots.txt with raw `fetch` — no DNS re-validation, no size cap (the only bypass of `safeFetch`).
- Prompt-injection defense for crawled third-party pages is instruction-only ("treat as data") with regex HTML stripping; no structural delimiter/escaping layer (`lib/knowledge/extraction/claims.ts:397` flags this itself).
- No Postgres RLS; tenant isolation is a service-layer invariant (tested, but the app connects as table owner and can disable immutability triggers — precedent in migration 011:28-34).
- Env-schema drift: three variables read ad hoc, failing at feature-use time instead of boot, contradicting `lib/env.ts`'s own contract. `DEV_USER_ROLE` can't simulate 3 of 5 roles.
- No global outbound host rate limiter — concurrent jobs multiply per-module politeness delays.

## 10. Data-integrity concerns

- `uuid[]` pseudo-FKs throughout (`prospect_findings.signal_ids/response_ids`, `claims.evidence_ids`, `tasks.evidence_ids`, …) — the evidence-cardinality DB check (038:156) validates count, not resolvability; zero GIN indexes so containment queries seq-scan.
- `prospects` and `prospect_authority_signals` are fully mutable with no history: a `provenance='verified'` label or source URL can change without trace, in a domain whose neighbors are immutable.
- `outreach_drafts.contact_id` (042) has no same-prospect constraint — cross-prospect contact assignment is possible at the DB level (must be enforced in service).
- `markets.parent_id` has no cycle guard; conflict detection walks the tree recursively.
- `prospect_findings_one_primary` frees the primary slot silently if an approved primary is later rejected (038:161).
- `responses.prompt_id` deliberately has no FK (points into frozen jsonb) — documented, acceptable.
- `jobs`: no idempotency column, no dead-letter table.
- Missing hot-path indexes: `scores (company_id, metric)`, `sources.company_id`, `response_citations.company_id`, mentions current-revision pattern.

## 11. Scalability concerns

Modest by design (internal, single team): single worker loop (one job at a time); array-containment seq scans; unbounded null-project `sources` duplicates (029 partial unique); 180 s provider timeout × sequential cells bounds run throughput. None block the pilot.

## 12. Test coverage gaps

Strong: scoring math, citations/parsing across all provider payload shapes, geo containment, provider guards/limits/retry, prospect findings/stages/benchmark isolation, migration reversibility, cron auth, safe-fetch.
Gaps (mapped to required-test list): city/stage filtering (no feature), prospect dedup beyond the per-launch unique index, prospect-level entity resolution, prompt generation from market packs (no feature), repeated-run aggregation semantics, fixability/final-score (no feature), staleness on prospect surfaces, outreach-against-revoked-audit, contact-level suppression (in-flight), UI/browser E2E (none exist).

## 13. Priority call

The highest-priority implementable work, in order (full sequencing in `docs/implementation-plan.md`):

1. **Complete the in-flight spec-032 slice** (repairs the lint break and delivers roadmap 2.2 + 2.3): wire `prospect_contacts` CRUD + CSV import persistence with per-field provenance, and close the suppression gap by making `approveOutreachDraft`/`recordDraftSent` check contact-level do-not-contact **and** `suppression_entries` on contact identifiers.
2. Authority score + weighted visibility + numeric gap (matrix rows 10–12) on the existing versioned-scores mechanism.
3. Fixability + configurable final score, establishing the single config-driven weights mechanism.
4. Market packs + prompt generation; discovery adapters; diagnosis layer; buying signals; freshness badges; security fixes (robots fetch, env drift) alongside.
