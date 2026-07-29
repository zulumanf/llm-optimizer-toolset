# DECISIONS.md — Architecture Decision Log

Append-only. Every non-obvious technical decision gets a dated entry: the decision, the why, and what was rejected. Never edit past entries — supersede them with a new dated entry.

---

## 2026-07-27 — Re-scope to a multi-client agentic operations platform

The operator adopted an agentic-workflow blueprint (drafted for a real-estate
brokerage) as the product direction: one platform serving many client
engagements across verticals (Parva first, then realtors, plastic surgeons,
…). Superseded: the "not multi-tenant, Parva only" framing in docs/00 —
amended to "project = client engagement; still not self-serve SaaS."
Rationale for evolving this codebase rather than starting the blueprint's
repo from scratch: specs/001–007 already implement its Phase 1–2 measurement
and learning graphs with the same doctrine (agents prepare, workflows
control, humans approve = PRINCIPLES.md), and everything is already
partitioned by project. Rejected from the blueprint's stack, same reasoning
as the original decisions: Temporal/Trigger.dev (our Postgres queue is the
orchestrator until multi-step graphs outgrow it — revisit at specs/010),
Drizzle/Prisma (schema-as-SQL is the product), Clerk/PostHog (deferred).
Adopted: the shared agent contract (docs/15), formalized green/yellow/red
approval levels, and specs/008–012. See docs/15-agentic-operations.md for
the full mapping.

## 2026-07-27 — Initial decisions

### Why Postgres?
Experiments are relational to the core: projects → prompt sets → runs → responses → mentions → scores. We need transactions (freezing a prompt set atomically), foreign keys (a score must always trace to a response), and mature JSON support (raw provider payloads in `jsonb`). Rejected: document stores (weak integrity guarantees for an evidence system), SQLite (fine locally, but we need concurrent workers + hosted access).

### Why Next.js (App Router)?
One deployable for UI + API via server actions, first-class TypeScript, and the team already works in React. Internal tool → no need for a separate API service. Rejected: separate SPA + Express API (two deployables, duplicated types), Remix (no team familiarity advantage).

### Why Supabase?
Managed Postgres with auth, row-level security, and storage in one place — minimal ops for an internal tool. We use it as *hosted Postgres first*; features like RLS are additive. Rejected: self-hosted Postgres (ops burden), PlanetScale (MySQL, weaker JSON).

### Why immutable prompt runs and raw responses?
The entire product is an evidence system. If historical data can change, every report becomes unfalsifiable and every trend line untrustworthy. Insert-only raw responses + append-only runs make results reproducible and auditable forever. Cost (storage growth) is trivial next to the value.

### Why version prompt sets (freeze before run)?
Comparing week-over-week scores is only valid if the prompts are identical. Freezing creates an immutable snapshot (`prompt_set_versions`) that runs reference. Editing prompts creates a new version; old runs keep pointing at the version they used.

### Why version scoring methodology?
Weights and equations will evolve. If we silently change them, historical comparisons break. Every computed score row stores `scoring_version`; changing methodology means a new version applied forward (with optional re-scoring stored as *additional* rows, never overwriting).

### Why no microservices?
One team, one internal tool. Microservices buy independent scaling and team isolation — we need neither. They cost deployment complexity, network failure modes, and duplicated logic. A monolith + one worker process covers everything on the roadmap.

### Why a provider abstraction for AI calls (`lib/ai/`)?
We query 4+ providers whose SDKs, auth, and response shapes differ and change. One interface (`runPrompt(provider, model, prompt) → RawResponse`) isolates churn, centralizes retry/rate-limit logic, and makes "add a provider" a one-file change. Rejected: calling vendor SDKs from features (already burned every team that tried).

### Why dev-mode auth before Supabase auth?
No Supabase project exists yet, and spec 001 needs identity for audit rows and role checks. `lib/auth.ts` is a small abstraction: `AUTH_MODE=dev` serves a single env-configured local user (stable UUID); `AUTH_MODE=supabase` is wired to fail loudly until implemented. Role enforcement lives in services either way, so swapping the identity source later touches one file. Supersede this entry when Supabase auth lands.

### Why postgres.js + a hand-rolled migration runner (no ORM)?
The schema is the product (`docs/03`) — we want hand-written SQL with triggers (insert-only enforcement) that ORMs make awkward. `postgres` (postgres.js) gives tagged-template queries, transactions, and camelCase mapping with zero codegen. Migrations are plain SQL files with `-- +migrate up/down` markers run by `scripts/migrate.ts` (~100 lines, transactional, tracked in `schema_migrations`). Rejected: Prisma/Drizzle (schema drift between ORM DSL and the trigger-heavy SQL we actually need), Supabase CLI migrations (couples us to Supabase tooling before we're on Supabase).

### Local dev database
Homebrew `postgresql@14`, pre-existing install, configured on **port 5433** (left as found). Databases `llm_optimizer_dev` and `llm_optimizer_test`; integration tests remap `DATABASE_URL` to `TEST_DATABASE_URL` in `tests/setup.ts` so they can never touch dev data.

### Official provider SDKs with our own retry layer (spec 003)
Adapters use `@anthropic-ai/sdk` and `openai` rather than raw fetch — typed
errors, correct auth handling, maintained request shapes. SDK-internal retries
are disabled (`maxRetries: 0`) so `lib/ai/retry.ts` is the single retry policy
for every provider: uniform backoff, budget checks between attempts, refusals
never retried (docs/12). Cost math uses integer micro-dollars (µ$ = tokens ×
$/MTok) to avoid float drift; per-model prices are pinned in
`lib/ai/pricing.ts` with a verified flag — unverified models are called out in
the run-estimate UI.

### Baseline cron config as columns on projects (spec 003)
The weekly baseline needs per-project config (which set, which providers,
what budget). Rather than a settings table for two fields, they live as
`baseline_prompt_set_id` + `baseline_config` jsonb on projects, set via SQL
for now. Promote to a settings UI when a second consumer appears.

### Heuristic-first parser (spec 004)
Mention parser v1 (`mention-parser-v1+heuristic`) is fully deterministic:
word-boundary alias scanning (domain-aware boundaries so "Parva" ≠
"parva.com" ≠ "Parvati"), list-position detection, recommendation/sentiment
lexicons, verbatim-excerpt selection. No LLM call — provider keys don't exist
yet, and an untestable LLM stage would be riskier than an honest heuristic
whose uncertainty routes to human review via the docs/06 confidence formula
(heuristic certainty caps keep ambiguous parses below the 0.7 threshold).
The MENTION_PARSER_V1 LLM stage from docs/13 lands as a *new* parser_version
when keys arrive; old parses stay, per the revision model. Accuracy harness
gates precision ≥ 0.90 in CI (currently 0.958/1.0 on 22 labeled cases).

### Citation measurement from response text, not new response columns (spec 005)
`responses` is insert-only, so citation data can't be added to old rows.
Rather than a schema change, citation denominators are derived at scoring
time by deterministically re-extracting URLs from stored response_text, and
per-company attribution comes from the parser's domain matching. Provider-
native citation fields (e.g. Perplexity search results) are preserved in
raw_payload; a future parser version can mine them without any migration —
that's the payoff of capturing everything verbatim.

### Deterministic report drafter behind a strict evidence gate (spec 006)
The narrative drafter v1 is pure templating over the snapshot, so every
numeric sentence carries a [score:id]/[response:id] citation by construction.
The publish-time validator (evidence gate) is the real invariant: any
narrative — templated, hand-edited, or a future LLM drafter — must have
every numeric claim cited and every citation resolvable inside the snapshot,
or publish fails. This ordering (gate first, fancy drafter later) means
swapping in REPORT_DRAFTER_V1 when keys exist cannot weaken the guarantee.
Bug caught by our own gate during implementation: the drafter's coverage
caveat contained an uncited count — reworded rather than weakening the gate.

### Attribution verdicts computed on read, scheduled via the jobs queue (spec 007)
Verdicts (pooled baseline vs each post run, docs/06 rule) are derived fresh
from score rows on every view — storing them would create a second source of
truth that could drift from the immutable scores. Post-run scheduling reuses
the existing Postgres jobs queue (`run_after` in the future) rather than a
separate scheduler; the worker treats a due `start_scheduled_run` like any
other job, so crash-recovery, leasing, and retries come for free. Strictness
note: the ≥2-provider consistency requirement means single-provider setups
can never produce a "notable" verdict — kept deliberately; robustness of the
claim is the point, and real baselines run multiple providers.

### Classifier v2: deterministic recall, LLM precision, mini model (spec 013)
The alias prepass keeps recall deterministic (and costs nothing when no
candidate matches); the LLM only adjudicates precision — identity
resolution first, then recommendation/position/sentiment. Identity ground
truth comes from spec 008 approved claims, never model recollection.
Model: `gpt-5.4-mini-2026-03-17` (CLASSIFIER_MODEL) — this runs on every
observation, and live results matched flagship judgment at ~6× lower cost.
Verifier policy: verification can only ADD oversight — disagreement (or a
failed verification call) forces `needs_review`; agreement never clears the
docs/06 confidence-threshold review. Parser version is now resolved at
parse time (`lib/parsing/version.ts`) so heuristic and LLM rows are
self-describing and mixed histories stay legible. Test setup now strips
provider keys (tests/setup.ts): without that, the LLM parse path would have
made the integration suite spend tokens and depend on network reachability.

### Evidence audit trail: hashes computed in Postgres; holdout without a scoring bump
Capture-time SHA-256 hashes for response text and raw payload are computed
by a BEFORE INSERT trigger in Postgres, not in JS — one canonicalization
(jsonb::text) shared by capture, the one-time migration backfill (immutability
trigger disabled for that single additive-metadata statement, raw content
untouched), and integrity verification, which recomputes in SQL and treats
any mismatch as tampering. Metric drill-down re-derives numerator/denominator
from mentions at read time and displays a mismatch with the stored score
rather than trusting either silently. Holdout prompts (locked into
frozen_prompts at freeze) are excluded from standard metric denominators
WITHOUT a scoring-version bump: no historical run contains holdout prompts,
so every historical value is bit-identical under the clarified eligible-set
definition — a version bump would have severed Parva's baseline
comparability for zero measurement benefit. Deferred with named integration
points rather than half-built: consumer-interface capture (browser runner) →
EvidenceCaptureAdapter interface; per-client portal logins → Supabase auth
milestone; stored top-three metric → next scoring version.

### Search-enabled runs as a distinct instrument; citations from payloads at read time
Search-mode models (e.g. `gpt-5.4-mini-2026-03-17+search`, Responses API +
web_search, shape verified live 2026-07-28) are separate pinned model ids —
a searched answer is a different measurement instrument than a parametric
one (docs/07), and it is closer to consumer ChatGPT, which searches by
default. Retrieval citations (url_citation annotations; Perplexity
citations/search_results; Anthropic web-search citations; Gemini grounding
chunks) are extracted at READ time from immutable raw_payload
(lib/ai/citations.ts) — no schema change, works retroactively on every
capture — and feed sources, mention citation attribution, the citation_rate
metric, and the source_target gap detector. Caveat kept visible: OpenAI
bills the search tool per call outside token usage, so +search pricing rows
stay flagged unverified. First live search baseline promptly exposed that
the "Parva" name is contested territory in retrieval (parvahealth.com,
parvaconsulting.com, getparva.com) — the entity problem is about winning a
collision, not filling a void.

### First LLM agents, behind deterministic gates (spec 010)
The content engine introduces real LLM agents (brief/draft/fact-verify on
pinned gpt-5.4) through one runner (lib/ai/agent.ts): JSON mode, Zod
validation with a single retry, cost accounting, and an injectable caller so
tests inject canned outputs. The load-bearing decision: agents never gate
themselves — the deterministic citation validator (subject sentences must
cite approved claims, no uncited numbers/superlatives) runs on every draft
and at verify time, and the fresh-context verifier is a different agent than
the drafter. The live smoke proved the design: the gates blocked the
system's own first real draft (citation-after-period formatting) and the
verifier flagged a pedantic edge — both fixed as validator/prompt
refinements without weakening enforcement.

### Playwright E2E deferred to the CI milestone
Spec 001's unit/integration coverage exercises every acceptance criterion including DB triggers and role checks. Browser E2E adds most value once there's a multi-step flow (freeze → run → review, specs 002–004); installing browser tooling now would slow the vertical slice. Recorded as a scope cut in spec 001; E2E lands with CI setup before spec 003 completes.

### Why `specs/` separate from `docs/`?
`docs/` explains why the system exists and how it holds together — stable, read for context. `specs/` are executable work orders — one feature, implemented exactly, then done. Mixing them makes docs churn and specs vague.
