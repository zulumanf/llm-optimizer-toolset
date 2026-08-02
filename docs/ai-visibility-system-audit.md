# AI Visibility Intelligence System — Repository Audit

> Date: 2026-08-01 · Auditor: Claude (principal-engineer session)
> Method: four parallel deep-read audits (measurement core; orchestration/workers/automation; interfaces/security/observability; insight-to-action layer) at HEAD `54273bd` on `feat/032-prospect-acquisition`, cross-checked against `docs/current-system-audit.md` (2026-07-31), the 295-item QA audit, and `DECISIONS.md`.
> Purpose: determine what an internal "AI Visibility Intelligence system" (CrowdReply-class capability, run for our own brands) requires **beyond what this repository already contains**, and design the smallest compatible extension.

## Verdict in one paragraph

**The requested system substantially already exists.** This repository IS an AI visibility intelligence platform: versioned prompt sets, a provider-neutral runner (OpenAI/Anthropic/Google/Perplexity + mock), immutable raw-response capture with hashing, two-stage mention classification with human review, a per-response citation ledger, versioned transparent scoring, a deterministic gap engine, evidence-gated content drafting with adversarial review, approval-gated execution, and scheduled before/after intervention retests. The correct implementation is **not** a new system — it is (1) an **MCP interface layer** (entirely absent today) exposing the existing domain services as thin, validated, read-heavy tools; (2) closing a small set of named partials (recommendation triple, learnings loop, prompt discovery); and (3) fixing the specific correctness/security findings listed in §H/§I. Anything more would duplicate working, tested infrastructure.

---

## A. Current architecture summary

- **One Next.js 15 App Router app** (React 19, strict TypeScript, Tailwind 4 + shadcn/ui), server actions for mutations, route handlers only for cron/webhooks/downloads (9 route files total).
- **Postgres** (Supabase-hosted; local dev on :5433) via `postgres.js` raw SQL. 38 reversible migrations (`db/migrations/001…038`), migration runner `scripts/migrate.ts`, CI tests up/down/up for every migration.
- **Single background worker** (`workers/index.ts`) polling a Postgres `jobs` table (`FOR UPDATE SKIP LOCKED`, 3× exponential backoff, stale-lease reclaim). 18 job types.
- **Two execution systems, deliberately**: legacy bespoke chains (`execute_run → parse_response → compute_scores`, weekly cycle state machine) and the **spec-018 graph control plane** (`lib/workflow/` — immutable versioned graphs, autonomy policies, approval gates, cost caps, crash-safe ticks) with an automation library of 18 workflows on top.
- **Layering already matches the requested separation**: domain services in `lib/<domain>/service.ts`; data layer in `db/` + migrations; worker layer in `workers/` + `db/jobs.ts`; evaluation in `lib/parsing`, `lib/scoring`, `lib/evidence`, `lib/attribution`; orchestration in `lib/workflow` + `lib/automation`; UI in `app/`. **The only missing layer from the target list is MCP.**
- **Auth**: roles admin/operator/reviewer/client_viewer/client_validator; DB-read roles (instant revocation); denials are 404-not-403; system principal (`SYSTEM_USER_ID`) for background work; one anonymous surface (`/audit/[token]`, snapshot-only).
- **Deployment: laptop only.** launchd schedulers + localhost; no hosting config. Honestly documented as gap A4 in `docs/17-agency-operations.md`.
- **Tests**: ~1,166 tests across 82 files; provider-payload fixtures; suite advisory lock; test setup deletes provider keys and remaps to `TEST_DATABASE_URL`.

## B. Existing relevant capabilities (with locations)

| Loop step (from the request) | Implementation |
|---|---|
| 1. Discover commercially important prompts | Manual entry + vertical-pack templates with intent tiers (`lib/verticals/`); no import/cluster/classify |
| 2. Run prompts across answer engines | `lib/runs/execute.ts`, adapters `lib/ai/{openai,anthropic,google,perplexity,mock}.ts`, registry `lib/ai/registry.ts` |
| 3. Capture responses/citations/metadata | `responses` (immutable, hashed), `response_citations` ledger (mig 033), `lib/ai/citations.ts` (all 4 providers' citation shapes) |
| 4. Measure brand mentions | `lib/parsing/` prepass + `mention-classifier-v2` + verifier + review queue; `mentions` revision model |
| 5. Compare vs competitors | `lib/scoring/metrics.ts` (v1.1: mention/recommendation/SoV/position/citation/sentiment + first-position/top-three), `db/competitors.ts`, movement detection |
| 6. Why competitors are cited | `response_citations` + `sources` (typed: portal/news/social… × owned/competitor/third_party, `source-classifier-v1`), "Sources influencing answers" UI |
| 7. Identify gaps | `lib/gaps/detect.ts` — `gap-detector-v1`, six deterministic gap types with opportunity scores |
| 8. Recommend prioritized actions | Partial: `gap_findings → tasks` (p1–p3), program plans (spec 026, composer unreachable), control-tower queue |
| 9. Create tasks / draft assets | `lib/tasks/service.ts`; content engine `lib/content/` (7 asset types, citation gate, prohibited-wording gate, adversarial review) |
| 10. Publish via approved workflows | 16 `human()` approval gates; `assertSendAllowed` 7-check send gate; `cms.publish_approved_asset` approval-required; **no live external connector has ever run** |
| 11. Rerun after changes | `lib/attribution/service.ts` — interventions auto-schedule +2w/+6w/+12w reruns on the same frozen prompt-set version |
| 12. Measure change | `lib/attribution/verdict.ts` (computed on read, confound window), `lib/reports/deltas.ts` noise rules |
| 13. Store results and learn | Partial: `action_outcomes` graph exists but `measureAction` has no production caller; no cross-project learnings store |

## C. Capabilities that are complete

- Project/brand/competitor registry (aliases as `companies.aliases text[]`; brand-candidate discovery with human promotion).
- Prompt library + frozen, immutable, FK-referenced prompt-set versions (reproducibility enforced at DB level).
- Provider-neutral runner: per-provider rate gates, retry/backoff with one policy, budget caps in integer micro-USD, pricing-required-to-run validation, idempotent resume, quota short-circuit.
- Immutable raw capture with SHA-256 hashing in-DB; failures captured as evidence.
- Two-stage (plus verifier) mention classification, parser versioning, confidence thresholds, human review queue that hard-blocks scoring.
- Citation extraction (in-text ∪ provider search citations) and the immutable per-response citation ledger; source typing/relationship classification.
- Scoring v1.1: versioned, never recomputed in place, null≠0, holdout exclusion, cross-version comparison forbidden.
- Evidence machinery: drill-down re-derivation, seeded audit sampling, hash-verified tar.gz exports, integrity re-verification.
- Graph workflow engine with autonomy policies, approval gates (72h timeout sweep works), cost caps, exceptions, test mode.
- Weekly cycle end-to-end; monthly report library with immutable publish.
- Content engine with three enforced gates (deterministic citation gate, prohibited wording, adversarial review).
- Interventions with scheduled before/after retests; accuracy monitoring; campaigns; market exclusivity; prospect acquisition (spec 032) incl. the anonymous audit page.
- Auth/roles, client-portal isolation, evidence-grade audit patterns on 9+ immutable tables; testing infrastructure.

## D. Capabilities that are partial

| Capability | What exists | What's missing |
|---|---|---|
| Prompt discovery/intelligence | Manual CRUD, vertical-pack templates with hand-authored intent tiers 1–4, 5-value category enum | Import from external sources, clustering, intent classification of operator-written prompts, demand estimation |
| Recommendations | `gap_findings.opportunity_score`, tasks p1–p3, plan `effort_hours`, control-tower queue | No single object joins impact × effort × confidence; `composePlan`/`approvePlan` have **no production caller** (tests only) |
| Experiment engine | Interventions (+2/+6/+12w), verdicts w/ confound window, `campaigns.hypothesis`, `action_outcomes.hypothesis` | No hypothesis on `interventions`; no control/comparison arm; `measureAction`/`outcomeChain` never called in production → effectiveness never labeled |
| Learnings/knowledge base | Full client knowledge layer (claims, wiki, packets, rebuilds, maintenance) | No **cross-project** durable learnings/playbook store; `agent_evaluations` has no writer |
| External source discovery (spec 027) | `runExternalDiscovery` implemented + tested, robots.txt-polite crawler | Only caller is a temp script; no UI/job/workflow; never run live |
| Evidence linkage on gaps | Dedup'd findings with detector version | No `evidence_ids` on `gap_findings`; one synthetic score-evidence row created only at task time |
| Visibility drill-down | `mention_rate`, `recommendation_rate`, `citation_score` re-derivable | `first_position_rate`, `top_three_rate` have no drill-down |
| Competitor analysis | Comparison, movement, entity roll-up | No head-to-head win-rate concept; overtake detection on `mention_rate` only |
| Observability | Structured logger (~100 sites, consistent event names), append-only `audit_log`, artifact access log, node-level cost | `writeAudit` called from ~7 of 22 domains; no correlation-id propagation; no log sink |
| Automation library | Engine + 18 workflows + triggers + event bus all real | 9/18 workflows subscribe to events nothing publishes; 15/18 triggers ship disabled by design; connector layer has **no connection-creation path** |
| Scheduling/deployment | launchd + cron routes + `CRON_SECRET` auth | Laptop-only; no hosted target; monthly reporting has no live scheduler |

## E. Capabilities that are missing

1. **MCP layer — the only wholly absent architectural layer.** Zero MCP code, deps, docs, or specs (the sole grep hit is an unsatisfied peer-dep in `package-lock.json`). No tool interface for Claude/ChatGPT/agents to reach the domain services.
2. Prompt import/clustering/intent-classification pipeline (module B of the target design).
3. A recommendations object carrying problem/evidence/mechanism/impact/effort/confidence/status/retest-date (module H).
4. Cross-project learnings store with confidence labels (module L).
5. Win-rate / head-to-head metrics.
6. Search-volume/demand data integration (correctly absent — no legitimate source is wired; the repo refuses to fake it).
7. Live external publishing/sending (deliberately absent: gates exist, adapters `implemented_unverified`, no credentials — this is a feature, not a bug, per PRINCIPLES).

## F. Duplicated or conflicting implementations

- **Two prohibited-phrase systems**: per-claim `allowed_wording` + vertical compliance hits (`lib/content/validate.ts`) vs. hard-coded `PROHIBITED_PHRASES` (`lib/prospects/constants.ts`). Unrelated code paths; candidate for later consolidation, not now.
- **Two outreach systems**: migration-020 `outreach_messages` (gated send node, never live) vs. migration-038 `outreach_drafts` (record-that-a-human-sent-it). Spec 011 (journalist CRM) is still `draft` and stale — its red-level "no send path may exist" is contradicted in principle by the mig-020 gated send node. **Needs an operator decision before any sequence automation** (already flagged in DECISIONS).
- **Orphaned route**: `app/api/cron/weekly-baseline/route.ts` — no scheduler targets it; superseded by the weekly cycle.
- **Two execution systems** (legacy chains + graph engine) — deliberate and documented (spec 018), not accidental duplication.
- `PARSER_VERSION` constant deprecated in favor of `activeParserVersion()` but still imported (see §I.1).

## G. Technical debt affecting this system

1. No per-request **timeouts on benchmark provider calls** (`lib/ai/*`) — a hung call blocks a worker slot indefinitely (internal agent calls and connector HTTP do have timeouts).
2. Instrument settings (temperature/top_p/seed/max_tokens) not recorded on `responses` — reproducibility relies on model id only.
3. Anthropic/Perplexity model ids **declared but never executed** (keys never configured); Google uses preview (non-dated) ids. Honestly flagged in-file.
4. `enqueueForRun` dedupes only 3 of 18 job types; duplicate-enqueue safety otherwise relies on per-handler idempotency.
5. Single-process worker; `SKIP LOCKED` supports N>1 but is untested at N>1.
6. `agent_definitions.allowedTools` is `[]` for all 12 agents and never enforced — a declared contract with no gate (benign today: `lib/ai/agent.ts` grants no tools at all).
7. Laptop-only deployment; `CRON_SECRET`-guarded routes fail closed but nothing durable fires them.

## H. Security risks

Ranked; pre-existing, newly confirmed this audit:

1. **SSRF redirect bypass (most material finding).** `lib/knowledge/sources/ingest.ts` validates `isPrivateHost()` on the original URL, then fetches with `redirect: "follow"` — a public URL 302-ing to `169.254.169.254` bypasses the guard. Same pattern in `lib/knowledge/sources/discover.ts`. Also: hostname is string-checked, never DNS-resolved (rebinding), and ingestion fetches have no response-size cap (connector HTTP does: 2 MB).
2. **Prompt-injection fencing is weakest on the highest-exposure path.** `lib/knowledge/extraction/claims.ts` fences crawled page text with `--- DOCUMENT START/END ---` but lacks the "data, not instructions" phrasing used elsewhere and does no delimiter escaping (content containing the fence breaks out). Mitigating control: `lib/ai/agent.ts` is deliberately tool-free, so injection can only corrupt a JSON claim, not act.
3. **Mock provider reachable in production** (`lib/ai/registry.ts` gate + runs/new fallback) — known P0 A1; fabricated answers can flow into real scores when no keys are set.
4. `next.config.ts` sets no security headers/CSP; hand-rolled `escapeHtml` in plan/report HTML export paths.
5. `audit_log` coverage: ~7 of 22 server-action domains write audit rows — append-only but incomplete as a change record.
6. Supabase superuser password rotation still outstanding (long-standing operator blocker).
7. No route-level rate limiting on authenticated download routes.

Strong existing controls worth naming (they shape the MCP design): fail-closed cron auth with constant-time compare; AES-256-GCM envelope encryption with row-bound AAD for connector credentials; `server-only` guard on service-role key; PostgREST privileges revoked; 404-not-403 policy; test setup deletes provider keys; budget caps enforced pre-spend; approval-gated consequential capabilities.

## I. Data-quality risks

1. **Live bug — evidence exports stamp the wrong parser version.** `lib/evidence/export.ts` writes the deprecated `PARSER_VERSION` (always `mention-parser-v1+heuristic`) into `manifest.json`/`methodology.md` even for runs classified by `mention-parser-v2+llm`. Client-facing provenance is wrong.
2. Mock-provider fallback (H.3) is also a data-quality risk: fabricated rows are structurally indistinguishable from real ones once scored.
3. Google preview model ids weaken run-over-run comparability.
4. `first_position_rate`/`top_three_rate` cannot be independently re-derived via drill-down.
5. `action_outcomes` rows park at `insufficient_measurement` forever (no scheduled measurement), so any future "what worked" analysis over that table would read noise.
6. Two Perplexity/Anthropic adapters unverified by execution — first live run may reveal payload-shape drift (the `unknown*` fixture tests flag rather than mis-read, which contains the risk).

## J. Recommended reuse plan

Reuse **everything** in the loop table (§B) as-is. Specifically, the new MCP layer must call existing readers/services and add zero business logic:

- Registry reads: `db/projects.ts`, `db/companies.ts`, `db/competitors.ts`.
- Prompt sets: `db/prompt-sets.ts`, `lib/prompts/set-service.ts`.
- Runs: `lib/runs/service.ts` (`startRun`, `estimateRunForVersion`), `db/runs.ts`.
- Results: `db/mentions.ts`, `db/scores.ts`, `db/dashboard.ts` (`authorityTrend`), `lib/evidence/observations.ts` (drill-down).
- Citations: `response_citations` + `sources` readers (`db/competitors.ts::listTopSources` et al.).
- Gaps: `lib/gaps/service.ts::analyzeRun`, `db` gap readers.
- Experiments: `lib/attribution/service.ts::createIntervention`, `interventionView`.
- Approvals visibility: `db/workflow.ts::pendingApprovalsAcrossRuns`.
- Actor/audit: `lib/auth.ts` principals + `db/audit.ts::writeAudit`.

## K. Recommended deprecation plan

Nothing requires deprecation for this work. Housekeeping candidates (separate, later): delete orphaned `app/api/cron/weekly-baseline/route.ts`; remove deprecated `PARSER_VERSION` after fixing §I.1; update stale spec 011 status; consolidate the two prohibited-phrase lists behind one module.

## L. Proposed target architecture

**One MCP server, not three.** The request sketches observer/planner/operator servers; this codebase is one app with one process model, and the read surface is ~a dozen tools. Splitting now would manufacture services. The server is structured as **tool groups** (observer / planner / operator) inside one binary so a later split is a file move, not a redesign.

```
mcp/server.ts            # entry point (stdio transport), like workers/index.ts
lib/mcp/tools/*.ts       # thin tool defs: zod schema → call domain service → shape output
lib/mcp/context.ts       # actor resolution (MCP_USER_ID → users row), per-tool authz
lib/mcp/audit.ts         # every invocation → audit_log (tool, args hash, actor, outcome)
```

Rules (enforced in the slice): tools are zod-validated in and out; read tools are pure delegations; mutating tools (initially only `run_prompt_set`, `create_experiment`) require an explicit actor, support `dry_run`, write audit rows, and reuse the services' existing gates (budget caps, pricing-required, frozen-version checks). No publishing/sending tools at all — external action stays behind the existing approval-gated workflows and their UI. Deferred capabilities (prompt import/clustering, recommendation triple, learnings store) get designed in `docs/ai-visibility-roadmap.md`, not built speculatively.

## M. Exact files expected to change

- `package.json` / `package-lock.json` — add `@modelcontextprotocol/sdk`; add `mcp` script.
- `README.md` — command + one paragraph.
- `docs/02-system-architecture.md` — add the MCP interface layer to the diagram/text.
- `DECISIONS.md` — record the one-server-with-groups decision and audit findings.
- (No changes to `lib/runs`, `lib/scoring`, `lib/parsing`, `db/` query modules, or any migration — the slice is additive.)

## N. Exact files expected to be added

- `specs/033-mcp-visibility-interface.md` (spec-first, per CLAUDE.md).
- `mcp/server.ts`; `lib/mcp/context.ts`; `lib/mcp/audit.ts`; `lib/mcp/tools/{registry,prompts,runs,visibility,citations,gaps,experiments,approvals}.ts` (grouping may consolidate small files).
- `tests/unit/mcp-tools.test.ts` (schema/contract), `tests/integration/mcp.test.ts` (against TEST_DATABASE_URL).
- Docs: `docs/ai-visibility-architecture.md`, `docs/ai-visibility-data-model.md`, `docs/ai-visibility-security.md`, `docs/ai-visibility-mcp-tools.md`, `docs/ai-visibility-runbook.md`, `docs/ai-visibility-roadmap.md` (pointer-heavy; canonical content stays in existing numbered docs to avoid duplication).

## O. Open questions and assumptions

1. **Provider keys are still empty** (`ANTHROPIC/PERPLEXITY/GOOGLE`; OpenAI verified 2026-07). Live multi-engine measurement is operator-blocked; the slice runs against mock (test-gated) + OpenAI when keyed. Assumed acceptable.
2. **MCP actor identity**: assumed an operator-scoped local server (stdio) with `MCP_USER_ID` resolving to a real `users` row; refuses to boot without it in supabase mode. Alternative (per-tool tokens) deferred.
3. **Spec-011 vs migration-020 send contradiction** — pre-existing, operator decision needed; MCP deliberately exposes no send/publish tools so it does not depend on the resolution.
4. Assumed npm registry access to install the MCP SDK; if unavailable, the slice's transport layer stalls (tools + tests still land, since handlers are transport-independent).
5. Assumed the P0 fixes tracked in `docs/pilot-launch-plan.md` remain on their own track; this audit adds two items to that track (SSRF redirect, evidence parser-version stamp) rather than fixing them inside the MCP slice.

## P. Capability matrix

Legend — Maturity: ✅ complete · 🟡 partial · 📄 spec-only · ❌ missing. Action: **R**euse / **E**xtend / **P**lanned (roadmap) / **N**ew.

| Capability | Exists | Location | Maturity | Action | New work required | Priority | Risk |
|---|---|---|---|---|---|---|---|
| Project/brand/competitor registry | Yes | `db/migrations/001,004,005`, `lib/projects`, `lib/companies`, `lib/competitors` | ✅ | R | None (expose read tools) | P1 | Low |
| Brand aliases | Yes | `companies.aliases text[]`, prepass tiering | ✅ | R | None (no provenance table — acceptable) | P2 | Low |
| Prompt library + versioned sets | Yes | `lib/prompts/`, `prompt_set_versions` (immutable, FK'd from runs) | ✅ | R | None | P1 | Low |
| Prompt discovery/import/clustering | Partial | `lib/verticals/` templates + tiers only | 🟡 | P | Import + intent classifier w/ validation set | P3 | Med |
| Provider-neutral runner | Yes | `lib/ai/*`, `lib/runs/execute.ts` | ✅ | R | Add per-request timeouts (small) | P1 | Low |
| Mock/test provider + fixtures | Yes | `lib/ai/mock.ts`, `tests/fixtures/provider-payloads.ts` | ✅ | R | Prod-gate fix is P0 elsewhere | P1 | Med (H.3) |
| Rate/cost/budget controls | Yes | `lib/ai/limits.ts`, `lib/ai/pricing.ts`, budget-pre-spend checks | ✅ | R | None | P1 | Low |
| Immutable raw capture + hashing | Yes | `responses` + triggers + in-DB SHA-256 | ✅ | R | Capture temperature/seed later | P1 | Low |
| Mention parsing/classification | Yes | `lib/parsing/` 2-stage + verifier + review queue | ✅ | R | None | P1 | Low |
| Citation extraction + ledger | Yes | `lib/ai/citations.ts`, `response_citations`, `sources` typing | ✅ | R | None (Perplexity shape unverified live) | P1 | Med (I.6) |
| Visibility metrics (versioned) | Yes | `lib/scoring/metrics.ts` v1.1 | ✅ | R | Drill-down for 2 v1.1 metrics later | P1 | Low |
| Visibility history/trends | Yes | `scores` as time series, `authorityTrend`, movement | ✅ | R | None | P1 | Low |
| Competitor comparison | Yes | `db/competitors.ts`, movement, entity groups | ✅ | R | Win-rate metric later | P2 | Low |
| Citation graph analyses | Partial | Ledger + typed sources + top-sources UI (relational — correctly no graph DB) | 🟡 | E | `get_citation_sources`/compare-profile queries as MCP reads | P2 | Low |
| Competitor gap engine | Yes | `lib/gaps/detect.ts` v1 (6 deterministic types) | ✅ | R | LLM detector v2 stays deferred | P1 | Low |
| Recommendations (impact/effort/confidence) | Partial | opportunity_score + tasks p1–p3 + plans (composer unreachable) | 🟡 | P | Wire `composePlan` entry point; unified triple | P2 | Med |
| Content/asset drafting | Yes | `lib/content/` + 3 enforced gates | ✅ | R | None | P2 | Low |
| Controlled execution / approvals | Yes | `workflow_approvals`, autonomy, 72h sweep, `/approvals` | ✅ | R | Expose read-only pending-approvals tool | P1 | Low |
| External publishing/sending | Gated stubs | mig-020 send node, `cms.publish_approved_asset` — never live | 🟡 | P (deliberate) | Nothing in this phase; no MCP tool | P4 | High if rushed |
| Experiment engine | Yes | `lib/attribution/` (+2/+6/+12w retests, verdicts, confounds) | ✅ | E | Hypothesis field + `create_experiment` tool | P1 | Low |
| Learning store / playbooks | Partial | `action_outcomes` (measure path dead); knowledge layer is per-client | 🟡 | P | Wire `measureAction`; cross-project learnings | P3 | Med |
| Client knowledge base | Yes | specs 020–025, `lib/knowledge/` | ✅ | R | None | P2 | Low |
| External source discovery/crawl | Partial | spec 027 service complete, no entry point; SSRF gap §H.1 | 🟡 | P | Fix SSRF, then wire an entry point | P3 | **High (H.1)** |
| **MCP interface** | **No** | — (only an unsatisfied peer-dep) | ❌ | **N** | Server + tool groups + contract tests + docs | **P1** | Low |
| Observability / audit trail | Partial | `lib/logger.ts`, `audit_log`, access log, node costs | 🟡 | E | MCP invocation auditing; broaden `writeAudit` later | P2 | Med |
| Scheduling | Partial | launchd + cron routes (laptop-only) | 🟡 | R | Hosting is a separate operator track | P2 | Med |
| Deployment | No | No hosting config; documented | ❌ | P | Operator decision (Vercel+Supabase+worker host) | P2 | Med |

**Conclusion / go decision:** proceed with the MCP interface slice (spec 033) — additive, no migrations, no changes to measurement code, no external-action tools. Do **not** build: a new registry, a new runner, a new parser, a graph database, autonomous publishing, or three separate MCP services.
