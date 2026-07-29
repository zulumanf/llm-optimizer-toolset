# Capability Matrix — Five Connected Products

> 2026-07-29. Statuses: PRODUCTION-READY (PR) · FUNCTIONAL BUT INCOMPLETE
> (FBI) · PARTIALLY IMPLEMENTED (PI) · SCAFFOLDED (SC) · DOCUMENTED ONLY
> (DO) · MISSING (M) · CANNOT VERIFY (CV). Scores are capability-level
> maturity (not the product-level weighted scores in the main audit).
> "PR" here still assumes the platform-wide auth ceiling documented in the
> main audit (dev-mode single user) — nothing is client-facing-ready.

## Product 1 — AI Visibility Intelligence

| Capability | Status | Score | Evidence | Missing pieces | Risk | Next step |
|---|---|---|---|---|---|---|
| Multi-client + entity mgmt (aliases, subject scoping, separation) | FBI | 75 | migration 008; `lib/claims/service.ts setSubjectCompany`; `db/companies.listCompaniesForProject`; no-cross-talk test | No access-level separation; no team-member/market sub-entities (spec 012) | Operator error mixes clients only via UI misuse | Vertical-pack entity vocab (spec 012) |
| Prompt library + freezing + versioning | PR | 90 | migrations 002; `lib/prompts/set-service.ts` freeze/no-silent-replace; frozen views UI | Paraphrase clusters, intent/difficulty scores (DO — spec 012) | — | Cluster metadata in spec 012 |
| Holdout prompts | FBI | 70 | migration 011 `prompts.is_holdout`; frozen into snapshot; excluded from denominators (`lib/scoring/compute.ts`); tests | No holdout UI toggle on prompt form; no holdout report section beyond explorer | Analysts can't set holdout without API | Add checkbox + report section |
| Experiment execution (providers, reps, retries, budget, idempotency, partial runs, cancel) | PR | 88 | `lib/runs/execute.ts`; `lib/ai/retry.ts`; partial unique index; crash-recovery + duplicate tests | Location/market context per run (M); session types beyond API (M) | — | Market context lands with spec 012 |
| Search vs non-search instruments | FBI | 80 | `lib/ai/openai.ts` `+search` (Responses API, live-verified); DECISIONS | Search-tool fee not in cost math (flagged); other providers' search modes unbuilt | Under-reported run cost | Verify fee billing; add per-call fee constant |
| Scheduled/baseline/monthly runs | PI | 55 | `app/api/cron/weekly-baseline/route.ts`; baseline settings UI (`/settings`); jobs `run_after` | CRON_SECRET unset — nothing actually scheduled; no monthly/quarterly cadences | Trend line never accumulates | Set secret + real scheduler entry |
| Raw evidence (prompt, response, payload, timestamps, hashes, immutability) | PR | 92 | migration 003 trigger; migration 011 hash trigger + backfill; tamper test | Screenshots/recordings (DO — deferred adapter); market context | — | Browser-capture spec when consumer evidence needed |
| Citations/retrieved sources | FBI | 75 | `lib/ai/citations.ts` (4 provider shapes; openai live-verified); parse-time merge; sources table | `sources` global not project-scoped; no per-response source rows | Cross-client source counts blur | Scope sources by project |
| Classification (mention/rec/position/sentiment/competitors) | FBI | 60 | `lib/parsing/classify.ts` heuristic-v1 + confidence + review queue (migration 004); revisions | **Name-collision false positives (proven live)**; no market/specialty association; no LLM classifier | **Wrong numbers shown to clients — P0** | LLM parser v2 with fresh-context verify |
| Independent verification + human review + versioned corrections | PR | 85 | review queue UI; correct-with-reason audited; retraction revisions; timeout policy (docs/06) | LLM fresh-context verifier not yet (human is the verifier) | — | Part of parser v2 |
| Metrics (mention/rec/SoV/citation/coverage/consistency, versioned) | PR | 88 | `lib/scoring/metrics.ts` + known-answer fixtures; provider-segmented; docs/06 | Top-three not stored (derived in explorer); correct-association rate M | — | Next scoring version |
| Numerator/denominator/period disclosure + drill-down | PR | 90 | `lib/evidence/observations.ts` re-derivation + mismatch flag; Evidence Explorer; dashboard tile "x of n" | Reports show sample sizes but not all tiles linkified | — | Linkify remaining metric displays |
| Stability labels | PR | 90 | `lib/evidence/stability.ts` + unit table tests; explorer per-prompt view | — | — | — |
| Evidence portal (filters, raw view, history, hashes) | FBI | 78 | explorer + response detail (RAW banner, hashes, revision history) | Internal-only (no client login); no screenshots | Client must trust exports instead | Client read-only access (Supabase) |
| Evidence exports + hash verification | PR | 85 | `lib/evidence/export.ts` manifest+tar; verification test unpacks and re-hashes | No PDF; recordings/screenshots dirs absent for API runs (by design) | — | — |
| Audit samples (seeded, constraints) | FBI | 75 | `lib/evidence/sampler.ts` + `createAuditSample`; reproducibility test | No rerun/recording workflow attached to samples | Sample exists but audit rerun is manual | Attach rerun flow later |
| Client validation runs | SC/PI | 45 | migration 011 tables; `lib/evidence/service.ts` (seeded selection, instructions, separation, comparison) + tests | **No UI page**; no screenshot upload path wired | Feature invisible to operators | Small UI page |
| Competitive intelligence (who appears, category dominance, source support) | PI | 50 | competitor matrix (`db/competitors.ts`); brand discovery; gap detectors' source_target | "Why they win" evidence profiles (DO — spec 009 v2); replicability analysis M | Advice stays shallow | Spec 009 LLM enrichment |
| Trends/baseline change | FBI | 70 | authority trend chart (version-annotated); report deltas; intervention verdicts (docs/06 rule) | Cross-run explorer; per-cluster trend view | — | Cluster trend view |

## Product 2 — Reputation Accuracy

| Capability | Status | Score | Evidence | Missing | Risk | Next step |
|---|---|---|---|---|---|---|
| Verified knowledge base (canonical name, aliases, positioning) | FBI | 65 | claims register (migration 008); companies aliases/domain | Typed fact schema (volumes, awards, team, licenses) — free-form keys only | Facts exist but not machine-consumable per type | Spec 012 claim-key vocabulary |
| Claim management (status, as-of, evidence, supersede, approval) | PR | 85 | `lib/claims/service.ts`; one-approved-per-key; audit; tests | Expiration dates; claim categories; confidence levels | — | Add expiry → feeds alerts |
| Evidence management | PI | 50 | `evidence` table (url kind, notes); claim links | Quality/freshness/independence ratings; document uploads | — | Extend when correction workflow lands |
| Factual-accuracy monitoring (LLM errors vs approved claims) | M | 5 | — (fact-verify agent exists for OWN content only — `lib/content/prompts.ts` FACT_VERIFY_V1) | The whole capability | Client misinformation goes unseen | **Build: compare responses against claims — reuses fact-verify pattern** |
| Public profile audit (Zillow/LinkedIn/GBP/…) | M | 0 | — | Everything (needs fetching + vertical packs) | — | After spec 012 |
| Correction workflow (finding→wording→submit→before/after→recheck) | PI | 30 | Generic tasks + evidence + interventions can carry corrections manually | Typed corrections, platform owners, recheck automation | Corrections untracked as corrections | Model on tasks with a correction type |
| Monitoring & alerts | M | 0 | No notification system exists platform-wide | All | Silent drift | Needs shared notifications primitive |

## Product 3 — Authority Execution

| Capability | Status | Score | Evidence | Missing | Risk | Next step |
|---|---|---|---|---|---|---|
| Evidence-gap diagnosis (typed) | FBI | 70 | 6 detectors + tests; live-validated findings | Freshness/technical/reviews/conversion gap types; LLM evidence enrichment | Deterministic-only depth | Spec 009 v2 |
| Action prioritization (transparent scoring) | FBI | 75 | 30/25/20/15/10 weights in `lib/gaps/detect.ts` (documented assumptions, reproducible) | Cost/time/client-dependency inputs; learning from verdicts | Static weights | Feed verdict outcomes back (loop step 14) |
| Action management (tasks, approvals, evidence, outcomes) | FBI | 72 | state machine + gates + complete-as-intervention (spec 007; tests) | Owners beyond single user, dependencies, deadlines, recurrence | Single-operator assumption | With real auth |
| Content operations (opportunity→brief→draft→verify→approve→publish→measure) | FBI | 75 | `lib/content/*`; citation gate; immutable versions; publish→intervention; live-validated | Compliance = generic superlative rule only (spec 012 packs); indexation/citation tracking post-publish; content-type breadth | Vertical compliance absent for realtors/medical | Spec 012 before first regulated client |
| Transaction-to-authority | DO | 5 | specs/011 draft + docs/15 mention | All | — | Vertical-pack dependent |
| Ranking operations (RealTrends/TRD…) | DO | 5 | specs/011 draft | All | — | First real-estate client trigger |
| Media/journalist operations | DO | 8 | specs/011 draft (registry, matching, Gmail-draft-only, follow-up rules designed) | All implementation | — | Spec 011 implementation |
| Agentic workflows (structured IO, bounded, no self-approval, observable) | FBI | 78 | `lib/ai/agent.ts` (Zod, retry, cost logs, injectable); fresh-context verifier; deterministic gates; DECISIONS | Agent registry; per-agent tool permissions (agents have no tools today — inherently bounded) | — | Registry when >5 agents |
| Execution verification (completion evidence, before/after, measurement window) | FBI | 76 | interventions + verdicts + confound/instrument flags (spec 007, tested) | Before/after artifacts for profile changes | — | With correction workflow |

## Product 4 — AI-to-Revenue Attribution

| Capability | Status | Score | Evidence | Missing | Risk | Next step |
|---|---|---|---|---|---|---|
| GA4 / analytics integration | M | 0 | — | All | Pilot promise unmeetable in-system | P1: CSV import first, OAuth later |
| AI-referral classification rules | M | 0 | — | All (referrer rules for chatgpt.com/perplexity.ai/…) | Overclaiming risk if built sloppily | Confirmed vs probable labels from day one |
| Website behavior metrics | M | 0 | — | All | — | — |
| Lead capture (source question, prompt language, consent) | M | 0 | — | All | — | Simple lead table + form spec |
| CRM integration | M | 0 | — | All | — | P3 |
| Offline outcomes / pipeline / revenue | M | 0 | — | All | — | P3 |
| Attribution models (first/last/assisted, confidence labels) | M | 0 | — | All | — | — |
| Visibility→traffic mapping (cluster→citation→landing page→lead) | M | 2 | Interventions skeleton could anchor windows | All | — | — |
| Privacy/data governance for client analytics | M | 0 | — | All | PII risk when built | Design before ingesting |

## Product 5 — Executive Advisory

| Capability | Status | Score | Evidence | Missing | Risk | Next step |
|---|---|---|---|---|---|---|
| Executive summary generation | PI | 40 | Report narrative sections + deterministic drafter; citation-gated edits | LLM synthesis across products; "decisions needed" framing | Reads as data, not advice | LLM drafter version (planned, DECISIONS) |
| Weekly cadence | PI | 35 | Weekly baseline cron (unscheduled) + report engine | Distinct pulse format; change-only filtering; delivery | — | Cadence templates |
| Monthly cadence | PI | 40 | Reports over any period; deltas; work-completed via interventions | Lead outcomes (product 4); action-plan section | — | — |
| Quarterly cadence / QBR | M | 5 | — | All (category ownership, investment recs) | — | P4 phase |
| Category-ownership map | PI | 30 | Ingredients exist: per-category rates (`drilldown`), stability labels, gap scores | The synthesized map view | — | Compose from existing data — cheap win |
| Market-expansion intelligence | M | 0 | — | All (needs spec 012 markets) | — | — |
| Decision support (action+reason+evidence+cost+owner) | PI | 35 | Suggested tasks carry evidence + scores + priority | Cost/time/confidence fields; approval routing | — | Extend task schema |
| What-if planning | M | 0 | — | All | — | P4 |
| Reporting quality (facts vs interpretation, sample sizes, no mystery scores) | PR | 85 | Evidence gate blocks uncited numerics; sample sizes everywhere; authority score always shown with components (docs/06); confound honesty in verdicts | — | — | Keep it |

## Shared platform

| Capability | Status | Score | Evidence | Missing | Risk | Next step |
|---|---|---|---|---|---|---|
| Multi-tenancy (data) | FBI | 70 | Project scoping + subject isolation (tested) | RLS, per-client access | Single-operator honeypot | Supabase milestone |
| Auth & roles | PI | 25 | Role gates coded; dev-mode user hardcoded (`lib/auth.ts`) | Real login, client roles | **P0 before client data** | Supabase auth |
| Approval system | PR | 88 | Uniform suggested→approved+audit across 5 modules | — | — | — |
| Auditability | PR | 92 | Immutability triggers ×5 tables, hashes, revisions, audit_log, exports | Artifact-access logging | — | — |
| Workflow engine | FBI | 78 | `db/jobs.ts` leases/retries/backoff/run_after; crash tests | DAG dependencies; observability UI beyond health tile | Fine at this scale | Revisit at content-graph scale (DECISIONS) |
| Agent framework | FBI | 75 | One runner, versioned prompts, gates | Registry, eval harness | — | — |
| Notifications | M | 0 | — | Everything | Operators must poll | Shared primitive before products 2/5 alerts |
| Reporting/export | FBI | 70 | CSV, tar.gz+manifest, immutable reports | PDF, scheduling, portal | — | — |
| Security | PI | 30 | Single .env; no key leakage found; role gates | Real auth, backups, retention, signed URLs | **No backups of client evidence — P0** | pg_dump + var/ backup job |
| Reliability | FBI | 75 | Classified errors, retry/backoff, budget caps, idempotency, health tile | Uptime/alerting | — | — |
