# DECISIONS.md — Architecture Decision Log

Append-only. Every non-obvious technical decision gets a dated entry: the decision, the why, and what was rejected. Never edit past entries — supersede them with a new dated entry.

---

## 2026-07-27 — Re-scope to a multi-client agentic operations platform

The operator adopted an agentic-workflow blueprint (drafted for a real-estate
brokerage) as the product direction: one platform serving many client
engagements across verticals (the pilot client first, then realtors, plastic surgeons,
…). Superseded: the "not multi-tenant, single-subject" framing in docs/00 —
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
word-boundary alias scanning (domain-aware boundaries so "Lumina" ≠
"lumina.com" ≠ "Luminate"), list-position detection, recommendation/sentiment
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
definition — a version bump would have severed the client's baseline
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
the pilot client's name is contested territory in retrieval (several
unrelated same-name companies rank for it) — the entity problem is about winning a
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

---

## 2026-07-29 — Graph execution: keep the Postgres queue, add a graph layer (spec 018)

The recorded revisit point ("our Postgres queue is the orchestrator until
multi-step graphs outgrow it", 2026-07-27; restated as "DAG dependencies or
human-wait steps measured in days" in `docs/audits/architecture-consolidation-recommendations.md`
#8) came due: the content and reporting workflows need real dependencies,
fan-in, and approvals that pause for days. **The answer is still the queue.**

What was actually missing was *tables*, not *infrastructure*: dependency
resolution, fan-in, and a resumable human wait. The queue already provides the
two hard parts — durable at-least-once delivery and crash recovery — and it
provides one thing no external engine can: node completion, state transition,
audit row, and the next node's enqueue all commit in **one transaction**. With
Temporal/Trigger.dev/Inngest they cannot, and we would need an outbox to fake
it. Rejected, with the costs stated: a second runtime and failure domain, a
tunnel or cloud account for local dev, re-homing every existing handler in a
foreign execution model against a 246-test baseline, and a workflow history
that is not portable the way Postgres rows are.

The engine is a **tick** (`advanceWorkflow(runId)`), generalising the proven
shape of `lib/cycles/service.ts` from one hard-coded process to any declared
graph. Substitution stays cheap: everything outside `lib/workflow/engine.ts`
depends on the `WorkflowEngine` interface, so a durable orchestrator can be
dropped in without touching a template, handler, or page.

## 2026-07-29 — Autonomy gates the nodes that act, not every node (spec 018)

First implementation demanded an approval for every node in a level-≤2
workflow. That makes `content_production_v1` unusable — its claim gate,
fact verification, and adversarial review would each need a human decision
before the actual publish approval — and an operator asked to approve nine
things to publish one thing will rubber-stamp all nine, which is worse than
having no gate. Autonomy now gates **effectful** node types
(`deterministic_task`, `agent_task`, `integration_task`, `manual_task`) plus
anything declaring `requiresApproval`; gates, conditions, fan-outs, and
verifications are the checks that guard the act, not the act. Templates name
each node's own `config.actionType`, so the approval lands on the consequential
step. See `isEffectful()` in `lib/workflow/autonomy.ts`.

## 2026-07-29 — Edge semantics: settled is not the same as succeeded (spec 018)

Found by the integration suite. An edge with no explicit condition means "B
needs A's output"; a source that failed, timed out, or was cancelled has no
output, so it blocks its target. Error-routing edges say so explicitly with a
`node_state` condition. Two related rules fell out of the same review:

- A node with incoming edges needs at least **one** satisfied. Without it, a
  node reachable only by an optional error-routing edge fired immediately,
  before its source had run — "not required" is not "not waited for".
- A `fan_in` is the exception: it receives the failed branches too, because
  disclosing what did not arrive is its entire job. A fan-in that silently
  proceeds on whatever showed up is the undisclosed-partial-sample failure
  this platform exists to prevent.

## 2026-07-29 — Correlation is capped in code, not in prose (spec 019)

`outcome_relationships.confidence_label` is guarded by `boundConfidence()`:
an agent can never write `confirmed` at any confidence, and deterministic code
reaches it only with a matching identifier or a client self-report. A lowered
label records *why* it was lowered in `basis`, so a reader sees the system
declined to overclaim rather than merely lacking data. The rows are immutable,
so nobody upgrades a label later without a new, attributable row.

## 2026-07-29 — Capacity and automation are measured or withheld (spec 019)

`supportableClients` is `null` below 20 human-touch observations and the view
says "insufficient data" rather than printing an extrapolation from two weeks
of one client. Automation rate is computed from `node_runs` settled without a
human transition — the architectural targets in
`docs/architecture/automation-quality-operating-model.md` are stated as intent
and shown next to the measured number, never as a claim about current
performance.

## 2026-07-29 — `timeout` added to the ErrorKind taxonomy

Node timeouts are a distinct failure class from `internal`: they are expected,
bounded, and retryable, and the operator's response differs. One-word addition
to `lib/errors.ts`; no consumer switches exhaustively on `ErrorKind`.

## 2026-07-29 — The automation layer is first-party, on the spec-018 engine

`specs/native-automation-and-connector-layer.md` asked for an
`AutomationRuntime`. It is a ~250-line **adapter** over
`lib/workflow/engine.ts`, not a second execution model. A run's state, retry
semantics, audit trail and "what is this waiting on?" must have exactly one
home; spec 018 already built it, and the revisit conditions it recorded
(external orchestrator when multi-worker throughput or 30-day waits bite) are
still not met. The adapter adds only what does not belong in a graph engine:
run mode, connector preflight, per-client concurrency, and exception querying.

Full build-vs-borrow reasoning, including what we deliberately refuse to build
(arbitrary code nodes, a connector marketplace, a customer-facing builder), is
in `docs/architecture/build-vs-borrow-boundaries.md`.

## 2026-07-29 — `transform: postgres.camel` rewrites JSON keys, not just columns

Discovered while wiring test-mode fixtures: the shared client's camel transform
rewrites keys **inside jsonb** on read. A stored `analytics.fetch_sessions`
comes back as `analytics.fetchSessions`, and `__test` comes back as `_Test`.

Consequences, both now enforced:

- Any name that must survive a round trip lives in a **value**, not a key.
  `WorkflowFixtureBundle` is therefore an array of `{capability, response}`
  entries, not an object keyed by capability.
- Reserved keys in stored JSON are camelCase with no leading underscores
  (`automationTestConfig`).

Workflow definitions were audited and are safe: every node `config` key is
already camelCase, and capability names appear only as values.

## 2026-07-29 — Edges govern execution; paths govern reading

A template routinely needs a value produced several nodes back — a report's
approval node needs the metric section computed four nodes earlier. The obvious
fix, adding a shortcut edge, is actively unsafe: `computeReady` fires a node
when *any* incoming edge is satisfied, so a shortcut around a gate would let
the gated node run before its gate cleared.

So `lib/automation/nodes/paths.ts` resolves a config path from direct upstream
outputs, then the run input, then any node in the run that has already
**succeeded**. That is a read, never a permission: a node that has not run has
no output, so a bypassed gate still starves its downstream nodes.
`validateNodePaths` refuses a path rooted at a node that is not an ancestor,
because nothing orders it first — that one is a genuine race.

## 2026-07-29 — Per-node action types, so a level-2 workflow is usable

`lib/workflow/autonomy.ts` classifies `deterministic_task`, `agent_task` and
`integration_task` as effectful, and gates every effectful node at autonomy ≤ 2.
Without a per-node action type, a level-2 workflow would demand a human decision
on every read and every calculation — which that same file warns "would train
the operator to rubber-stamp, which is worse than no gate at all".

`lib/automation/workflows/helpers.ts` therefore sets `config.actionType` per node
category (reads → `analytics_ingestion`, calculations → `metric_calculation`,
agent drafts → `content_drafting`), following the convention spec 018's own
`content_production_v1` established. Nodes that actually act inherit the
workflow's action type and stay gated.

## 2026-07-29 — Adapter status is labelled, never inflated

Sixteen connector adapters ship. Five are `verified` — fixture, CSV, manual,
internal notification, local file store — and every one of those runs entirely
inside this platform. Nine provider adapters are `implemented_unverified`:
written against the documented HTTP contract, shape-tested against captured
fixtures, and **never executed against the live API**, because no provider
credentials exist in this environment. Two are `contract_only`.

`tests/unit/connector-security.test.ts` asserts that no adapter talking to a
third party can claim `verified`, and that every non-verified adapter documents
what remains. The connectors page states the same thing in prose.

## 2026-07-29 — Labour savings are not reported

The request asks for human-time-saved metrics "unless actual baseline and
operating data exist". None does, so `businessMetrics().humanTimeSavedHours` is
typed `null` and the dashboard prints "not measured". What *is* reported is
`manualInterventionRate` — the share of live runs where a human had to touch a
node — computed from `node_runs.human_touch`. That is the number that says
whether the automation is helping, and it needs no baseline to be honest.

## 2026-07-29 — Tenant is the project; no tenant_id column

The knowledge-compilation spec asked for strict multi-tenant isolation with a
tenant id on every table. `CLAUDE.md` says the opposite: "Not multi-tenant. One
team, internal only." Every workflow and event table already uses `project_id`
as the tenant key and says so in a comment.

Adding `tenant_id` would fabricate a dimension the product does not have, and
every row would carry the same value forever. So `project_id` remains the
isolation boundary, and every isolation test is written **client-to-client**,
which is the leakage that can actually occur here: two clients of the same
internal team, whose data must never mix in a packet or a compiled page.

## 2026-07-29 — Compiled wiki pages are rows, not files

The spec allowed generated Markdown files. They were rejected.

A `.md` file on disk is editable by anything with filesystem access, and an
editable artifact that reads as authoritative is exactly the failure this layer
exists to prevent. Rows get version identity, a `forbid_mutation()` trigger,
dependency joins and provenance foreign keys for free.

`wiki_page_versions` therefore stores the rendered Markdown **and** a structured
JSON mirror, and the content hash covers both — two renderings with the same
prose but different data are different pages. Export to Markdown is a read
operation, never the store.

## 2026-07-29 — Provenance lives in tables, not in YAML front matter

The spec suggested a `section_id / claim_ids / evidence_ids` block inside the
page body. Front matter would be unqueryable, hand-editable, and duplicated in
every rendering of the same section.

`wiki_section_provenance` is a table with one row per section, so the UI joins
it directly and the compiler writes it without polluting what a human reads.

## 2026-07-29 — Hot files are wiki pages, not a parallel system

A hot file is a `wiki_pages` row with `page_type = 'hot_file'` and a hard token
budget. One compiler, one dependency graph, one build engine, one provenance
model. A second subsystem for "the same thing but shorter" would have needed its
own staleness rules and would have drifted from the first one within a release.

## 2026-07-29 — Retrieval is lexical and structural; no vector index

Selection is deterministic for everything that governs what an agent may *say* —
identity, approved claims, instructions, methodology, the named entities and
date range, privacy filtering. Postgres full-text plus entity traversal only
ranks *supporting* material.

`pgvector` is not in this stack, and the rules that matter here are structural
(client scope, category, entity, date, privacy, freshness), not similarity-
shaped. An embedding store would add a dependency, a sync problem and a
staleness failure mode without changing which claims a drafting agent is
permitted to use. Revisit when a measured retrieval evaluation (spec 025) shows
lexical recall is the binding constraint.

## 2026-07-29 — `unpdf` and `read-excel-file`; `exceljs` rejected

PDF text extraction uses `unpdf` (no native binaries, ships the pdf.js text
layer). Spreadsheet extraction uses `read-excel-file`, which is read-only —
which is all this layer needs.

`exceljs` was tried first and rejected: it pulls in 95 packages and added seven
audit findings, almost all through the `archiver` write path this layer never
uses. The chosen pair adds **zero** audit findings. `xlsx@0.18.5` on npm carries
known advisories and was not considered.

Both are imported dynamically, so a missing or broken install degrades to
`extraction_status = 'unsupported'` with a stated reason rather than crashing
ingestion. Neither performs OCR: a scanned PDF is reported `empty` with an
explicit note, never as a successful extraction of nothing.

## 2026-07-29 — Token savings are measured; quality is not

`lib/knowledge/context/experiment.ts` compares four context strategies — raw
documents, full wiki, hot files, task packet — by counting input tokens locally
and deterministically, at zero cost, in CI.

On the seeded client the measured figures are: raw 8,289 tokens → full wiki
2,041 (75.4% fewer) → hot files 1,399 (83.1%) → task packet 492 (**94.1%**).
Those are real counts from `npm run seed:knowledge`, not estimates, and they
depend on corpus size — a client with three short documents shows no reduction
at all, which the harness reports honestly.

Accuracy, unsupported-claim rate, human-correction time and verifier-rejection
rate are **not measured**. Measuring them means running a real provider across
all four modes and spending money, which is the opt-in live harness deferred to
spec 025. Every result object carries `qualityMeasured: false` so no reader
mistakes a cost figure for a quality claim.

## 2026-07-29 — Staleness must never roll back the change that caused it

`publishEvent` marks dependent pages stale inside the publisher's transaction,
so a claim approval and the invalidation it causes commit together.

The first implementation wrapped that in a try/catch and logged a warning. That
was not enough: a failed statement aborts the **caller's** entire transaction in
Postgres, so a malformed id in an event payload would have rolled back a
legitimate claim approval. The fix is to validate ids against the uuid shape
*before* issuing the query — a non-uuid can never match a `uuid` column anyway.
Caught by the existing `automation-layer` suite, which publishes events with
test ids like `"c-1"`.

## 2026-07-29 — One claim-selection implementation

`buildEvidencePacket` (spec 018) and the new `buildPacket` (spec 022) both need
"approved claims, privacy filtered, freshness assessed". Rather than let two
queries drift, `lib/knowledge/packet.ts` now delegates to
`selectClaims` in the context builder and keeps only its own legacy shape and
rendering. Four workflow templates keep working unchanged.

---

## 2026-07-30 — The database moved to Supabase; only `public` went with it

Spec 014 was unblocked by a real Supabase project, so identity and data both
moved. Three decisions were forced during the move, none of them obvious.

**Only the `public` schema was restored.** A full `pg_restore` of the local dump
would have carried our own `auth.uid()` stub — migration 025 installs one when
the real function is absent, and local development is exactly that case. The
dump contains `SCHEMA auth` and `FUNCTION auth.uid()`, so restoring it wholesale
would have overwritten Supabase's genuine `auth.uid()`, which migration 025's
own comment calls catastrophic. `pg_restore -n public` leaves it untouched;
verified afterwards by reading `prosrc` on the server. The migration ledger came
across inside `schema_migrations`, so the 27 migrations are recorded as applied
rather than re-run.

**`anon` and `authenticated` were stripped of every privilege on `public`.**
Supabase's default ACLs grant `arwdDxtm` on every new table created by
`postgres`, and PostgREST exposes those tables to anyone holding the
publishable key — which is public by design. Restoring 111 tables under those
defaults would have published the raw response captures, `claims`, `audit_log`
and `connector_credentials` to the internet, writable. This hazard does not
exist locally, which is why nothing in the repo guarded against it: there is no
PostgREST and no `anon` role on a laptop. Default privileges were revoked before
the restore and explicit grants after it; every table now returns 401 through
the REST API. The app is unaffected because it connects as the owner over
postgres.js — `anon` was never in its path. RLS (migration 025) remains defence
in depth for the Supabase-client path, not the primary control.

**The operator's auth user was minted with the id it already had.**
`app/auth/callback/route.ts` adopts the Supabase uid on first sign-in with
`update users set id = …`. That statement cannot succeed for an account with
history: five foreign keys reference `users(id)` with no `ON UPDATE CASCADE`,
and 253 of the referencing rows live in `audit_log`, whose immutability trigger
forbids UPDATE outright. The append-only guarantee that makes the evidence
trustworthy also makes the user id un-rewritable. Rather than weaken either,
the auth user was created through the admin API with the existing uuid, so the
rewrite branch never executes. The branch is still a trap for the next account
provisioned after it has accumulated audit rows; fixing it properly means
provisioning identity and row together, and is not attempted here.

## 2026-07-30 — A search result is a lead, never evidence (spec 027)

External discovery could have stored what a search returned: the snippet, the
title, the model's summary. It stores none of them. A candidate URL is fetched,
hashed and written to `source_artifacts`, and only then may a claim be proposed
from it — so every claim cites bytes we hold and can re-read, not a description
of a page we never saw.

The cost of that rule is visible and deliberate: a page that 404s, blocks us, or
renders its content in JavaScript produces **no claim**, however good the
snippet looked. The alternative — proposing a claim from a search summary — is
exactly the fabricated-evidence failure PRINCIPLES #5 forbids, wearing the
costume of a citation.

Queries are templated and filled deterministically (`external-discovery-v1`,
docs/13) rather than composed by an agent. An agent writing its own searches
returns a different corpus every run, and two enrichments of the same client
stop being comparable — which would quietly undo the reproducibility every other
number here depends on.

`scripts/jc-enrich.ts` stays as the record of how this was done by hand.

## 2026-07-30 — Three fixes the first live discovery run earned

Run 1 (10 searches, 5 pages, $0.28) produced 91 proposed claims and 3
contradictions. Almost all of it was unusable, and each failure had a distinct
cause worth fixing separately rather than tuning away.

**A source must have an identifiable publisher.** Two of five captures were PDFs
in S3 buckets — one an SEO vendor's artifact, one an unrelated press-release
dump — contributing 38 claims, all rejected by hand. The rule added is not
"these are low quality"; it is that `attributionPrefix` would yield
"s3.amazonaws.com reports that", which names a filesystem. A claim whose best
provenance is a bucket path cannot be defended to a client. Object storage,
shorteners and generic document hosts are now screened out *before* the fetch.
A legitimate press release hosted only on S3 is lost by this; accepted, because
nobody could attribute it anyway.

**A claim on a third-party page is usually not about the client.** Three of five
pages hit the extractor's 20-claim ceiling, proposing things like "The James
unveiled two penthouses" — true, sourced, verbatim, and about a different
building. `extractClaimsFromSource` now takes an optional `subjectAllowList`
(client, aliases, named people); discovery supplies one, and callers reading a
client-supplied document still omit it and keep everything. `probable` name
matching counts, so "JC Luxury at SERHANT." is recognised as the client written
the way a journalist writes it.

**Different objects are two facts, not a disagreement.** All 3 contradictions
read "Overlapping claims disagree on general: 25165 versus 3737" — bare unit
counts for unrelated buildings sharing a subject and predicate.
`value_divergence` now requires the objects to match. Noise here is worse than
silence: an operator who learns the contradiction queue is junk stops reading
the one that matters.

Run 2, same client, same cost: claims per page fell from ~18 to 6, all on-topic;
12 unattributable pages were skipped before costing a fetch; contradictions went
from 3 to 0. The searches also found *more* (76 pages vs 60) — the corpus was
never the constraint, the filtering was.

## 2026-07-30 — Discovery honours robots.txt; the site crawler still does not

`lib/knowledge/sources/discover.ts` does not read robots.txt, and that is
defensible for what it does: it crawls the client's own site, which the operator
has permission to read.

Discovery fetches third-party sites nobody asked. The publisher's stated
preference is the only signal available, and ignoring it while calling this an
evidence platform would be a poor trade for a handful of pages. So
`lib/knowledge/discovery/robots.ts` implements the subset that matters —
user-agent groups, `Disallow`, `Allow`, longest-match wins — and treats an
unreachable or unparseable robots.txt as permitting the fetch, which is the
standard reading: a 500 is a broken server, not a prohibition.

The spec claimed this was reused from `discover.ts`. It was not; the spec is
corrected rather than the claim quietly dropped.

## 2026-07-30 — The sidebar renders nothing without a session

`AUTH_MODE=supabase` made `/login` return 500. The root layout renders
`Sidebar`, which called `getCurrentUser()` and threw — and `/login` lives inside
that layout, so the one page whose job is to resolve an unauthenticated state
crashed before it could render. The workspace was unenterable.

963 tests did not catch it, and could not: they run under `AUTH_MODE=dev`, where
a user always exists, so the throwing path is unreachable. That is the same
blind spot for any component doing identity work above the page level.

`Sidebar` now returns `null` without a session and loads projects and unread
counts only after the caller is known. It is a rendering decision, not a
security boundary — every page and server action still calls `getCurrentUser()`
and throws on its own.

## 2026-07-31 — `agentVersion` is a validated reference, not a label

Auditing spec 018 turned up a node field that meant two different things.
`lib/workflow/templates/*` put an agent *version* in `NodeDefinition.agentVersion`
(`content-draft-v1`); `lib/automation/workflows/helpers.ts` put an agent *key*
in the same field (`draft_content`). Nothing validated either, because
`validateGraph` checked every other reference a graph makes — node keys,
handlers, terminals, cycles — and not this one.

Two consequences, one latent and one live. Latent: a typo in an agent version
published cleanly and failed, if at all, inside a node run. Live: `agentMetrics()`
groups by `workflow_nodes.agent_version`, so the agent-performance table was
bucketing two identifier spaces at once and no bucket meant what the column
header said.

`agentVersion` is now a version everywhere, and validation enforces it: an
`agent_task` or `verification_task` without one is a publish-time error, and a
version in no registry is a publish-time error. Because two modules own agents —
`lib/agents/registry.ts` and `lib/automation/prompts.ts` — the known set is a
small registry (`lib/workflow/agent-versions.ts`) that both write into at import,
rather than an import from `graph.ts`, which stays pure and takes the set as an
argument. A *declared* agent's version is publishable: its contract is fixed, and
the node safe-stops for want of a handler, not for want of a contract.

Fixing the automation helpers changes those graphs' hashes, so the next bootstrap
publishes version 2 of each. That is the versioning model working, not a
migration: version 1 stays exactly as it ran.

## 2026-07-31 — Project access is a layout concern; denial is a 404

The full-repo audit (docs/current-system-audit.md) found `visibleProjectIds`
with zero call sites: every project page trusted its URL parameter, three
download routes served any client's artifacts to any authenticated user, and
two server actions ran with no caller at all. Authorization was
authentication-deep only.

The gate now lives in `app/projects/[id]/layout.tsx` rather than in each of
the ~30 workspace pages — a page added next month cannot forget a check it
never had to write. Server actions and route handlers do not pass through
layouts, so the download routes and run-scoped job actions carry their own
`assertProjectAccess` call.

Two shapes were chosen deliberately:

- **Denial renders as 404, not 403.** `ProjectAccessError` is classified
  `not_found` because telling a client account "this project exists but is
  not yours" confirms another client's existence — the exact leak the check
  prevents.
- **Listing scope is a SQL filter, not an app-side filter.** For client
  roles, other clients' names never leave the database
  (`listActiveProjects`/`listPortfolio` take the caller's grant). Staff pass
  `null`, meaning unrestricted — an explicit list for staff would silently
  drop newly created projects.

Same commit: the four cron routes share one constant-time secret comparison
(`lib/security/cron-auth.ts`) — three of them compared with `!==`, a timing
side-channel on the exact header an attacker controls; and the evidence
drill-down asked `scores` for `citation_rate` where scoring writes
`citation_score`, so its stored-score check was vacuously green for the one
metric it never actually looked up. The drill-down now uses the stored name
and re-derives the same denominator scoring uses (responses with any
citation), with a regression test that fails on either regression.

## 2026-07-31 — Client intelligence is not shared telemetry (migration 029)

Three tables aggregated data across clients on globally-unique natural keys:
`sources.citation_count` and `brand_candidates.hit_count` blended every
client's runs into one counter, and `evidence` — the table every
`evidence_ids[]` array points into — had no tenant column at all.

Each now carries `project_id`. Two shapes worth recording:

- **Nullable, with an honest backfill.** Historical rows whose project can
  be derived with certainty are attributed (evidence through its ref chain,
  brand candidates through `first_seen_run_id`, sources only when exactly
  one project's mentions cite the URL). Ambiguous rows stay null as
  "legacy, unattributed" — a wrong tenant label is worse than a missing one.
  Legacy null rows no longer absorb new counts; the parse upserts target
  `(project_id, url)` and `(project_id, normalized)`.
- **The down migration is lossy and says so.** Restoring the global unique
  constraints requires collapsing per-project duplicates; the down keeps one
  row per natural key and records the loss in the migration comment.

Same batch: `assertCanWrite` now guards every mutating service that takes a
request caller (46 functions across 20 modules — previously enforced in
exactly one). Two exceptions are deliberate: `startRun` gates only when a
user is present, because every scheduled caller (cycles, cron, attribution
offsets) passes null by design; and worker-path synthetic users carry an
explicit `role: "operator"` rather than a roleless cast that the new gate
would reject at runtime.

## 2026-07-31 — Exclusivity conflicts are structural, and checks are decisions

Spec 028. Two shapes worth recording beyond the spec:

- **Geography is an explicit containment tree, not geocoding.** Verdicts
  derive from same/inside/contains/sibling relations that an operator can
  read off the tree; the sibling relation is capped at two shared-ancestor
  levels so "both are in the USA" can never manufacture a conflict. The
  detector is pure and takes `today` as an argument — a check is a decision
  made at a moment, and tests hold that moment still.
- **A check is append-only because it is a business decision record.** The
  result, the verdict, and any override rationale are frozen at decision
  time (forbid_mutation trigger); overrides are admin-only with a required
  written reason.

**Unresolved dev-DB conflict, needs operator decision:** the hosted dev
database contains tables from an orphan migration `028_markets.sql`
(applied 2026-07-31 01:38, file absent from this repo): `markets` (7 rows,
geography_id + service_category_id + price_segment + audience shape),
`geographies` (23), `service_categories` (5), `project_markets` (0) — a
competing market model, presumably from a parallel session that never
committed its migration. Repo migration 032 therefore cannot apply to dev
(name collision on `markets`). Nothing in this repository references those
tables. Options: (a) drop the orphan tables and apply 032, losing that
seeded tree; (b) merge the richer dimensions (price segment, audience)
into spec 028's model first. Deliberately NOT resolved unilaterally —
dropping another workstream's data is not this branch's call. CI and the
test database are unaffected (they build from repo migrations only).

## 2026-07-31 — Orphan market model resolved: keep spec 028, keep their data

Resolution of the conflict recorded above, decided with the operator. The
orphan model's schema is gone; its *work product* is not:

1. All four orphan tables were exported to `var/backups/orphan-028-*.csv`
   (35 rows) before anything was dropped.
2. The 23-node geography tree — the genuinely valuable part — was imported
   into spec 028's `markets` table with ids, parents, and timestamps
   preserved (`country`/`metro` fold into kind `region`; city, borough,
   neighborhood map 1:1).
3. The orphan tables, their enum types, and the phantom
   `schema_migrations` row were dropped in one transaction; migration 032
   then applied cleanly.

The tuple dimensions the orphan model carried (price segment, audience,
service-category tree) were deliberately NOT resurrected as tables: in
spec 028 a protected tuple is a property of an agreement *scope*, not of
geography — `service_category` and `segment` live there. The five
service-category keys (residential, luxury-residential, new-development,
rentals, commercial) are the recommended vocabulary for scope categories;
the backup CSVs hold the exact seven market tuples if they are ever
wanted verbatim.

## 2026-07-31 — Source classification is deterministic lists, not a model

Roadmap 2.2 (spec 030 batch two). A source's type (portal, news, social…)
comes from named domain lists in `lib/sources/classify.ts`, and its
relationship (owned / competitor / third_party) from the project's own
tracked domains. A wrong deterministic label is debuggable and fixable in
one line; a wrong model label is a mood. LLM-assisted classification for
the long tail is deferred until it can ship WITH a validation set
(docs/12) — the honest label for an unknown domain is `other`, not a
guess. Versioned (`source-classifier-v1`) so a v2 reclassifies exactly
once per row. Legacy project-less source rows stay unclassified:
relationship is project-relative and they have no subject to be relative
to.

Same batch closes the audit's "declared but producer-less events" gap for
the core loop: benchmark.started/completed/partially_failed now publish
transactionally with the run writes, and visibility.materially_declined
publishes after scoring with a (run, metric) dedupe key so a re-score
cannot double-fire the automation layer.

## 2026-07-31 — Pilot-first finish plan; attribution stays deferred

Full-platform QA audit (295 items, nine-agent code trace, this date)
scored the system at ~64% with the measurement/reporting core solid and
the automation library non-functional live. Operator decision: drive to a
sellable paid pilot first (~3 weeks solo), then grow toward five clients
— rather than finishing the full checklist or gating launch on 5-client
infrastructure. Revenue attribution remains deferred (re-confirmed);
solo operation for the quarter moves RLS depth and multi-operator role
separation to the post-pilot track and moves correctness P0s up: mock
provider reachable in production, crash-mid-node runs reported
`completed`, approval timeouts never firing, unpriced models disabling
budget caps, scoring-version mixing in dashboards. Plan and sequencing:
`docs/pilot-launch-plan.md` (supersedes the completed phases 0–3 of
`docs/implementation-roadmap.md`; its Phase 4 items fold into the
post-pilot track).

## 2026-08-01 — Prospect acquisition (spec 032): link, don't fork, the measurement core

The acquisition slice models a prospect benchmark as a LINK to an existing
scored run (`prospect_benchmarks(prospect_id, run_id, company_id)`), with
every metric read from `scores`/`mentions` at render time. Rejected
alternative: prospect-owned runs via a `projects.kind='prospect'` marker —
correct long-term (roadmap Phase 2) but touches four load-bearing couplings
(`runs.project_id`, the subject-company parse gate, the
`listCompaniesForProject` share-of-voice denominator, global name uniques),
and getting the denominator wrong would silently change existing clients'
numbers. Linking costs nothing, can never drift from the scoring engine,
and covers the common case where the prospect is already tracked as a
market competitor.

Related choices, same date and spec:
- Finding candidates and outreach drafts are DETERMINISTIC (template +
  threshold generators, versioned as `prospect-findings-v1+deterministic` /
  `reply-first-email-v1`). An LLM generator is Phase 2, behind the same
  evidence gate; the slice must not be able to fabricate a claim.
- Prohibited-wording enforcement (`PROHIBITED_PHRASES`) blocks approval of
  findings and drafts containing revenue-loss/causality/hype language —
  validation at approval time, mirroring D4's "the gate enforces wording".
- The prospect audit page is the platform's first anonymous surface:
  256-bit `base64url` token minted at publish, snapshot-only rendering
  (internal fields structurally absent, not filtered), published rows
  DB-locked except revocation, wrong/revoked/expired tokens all 404.
  `/audit` added to middleware PUBLIC_PREFIXES.
- A blocked exclusivity verdict during a stage transition COMMITS the check
  record and conflict status but skips the stage change (the tx returns an
  outcome instead of throwing — a thrown error would roll back the
  evidence that the check happened). Found by the integration test.
- Prospect-facing views are tracked in a dedicated insert-only
  `prospect_audit_views` table rather than widening
  `artifact_access_log`'s CHECK constraint — that table's types are
  report/evidence artifacts and its rows are project-scoped; audit views
  are anonymous and prospect-scoped.

## 2026-08-01 — MCP is one thin server over existing services, not a new system (spec 033)

An audit for the "AI Visibility Intelligence system" request
(docs/ai-visibility-system-audit.md, four parallel deep reads) concluded the
requested system already substantially exists in this repository; the only
wholly absent layer was an MCP interface. Decisions taken:

- **One MCP server with tool groups (observer/operator), not the three
  services the request sketched.** This is one app with a ~15-tool surface;
  separate services would manufacture infrastructure. Groups keep the split
  seam visible.
- **Handlers are transport-free delegations.** `lib/mcp/tools.ts` calls the
  same services and `db/` readers the UI uses, zero business logic; the SDK
  touches only `mcp/server.ts`. Contract tests never load the SDK.
- **MCP adds no role model.** The server refuses non-staff identities
  (startup + per-invocation), and writes pass through the services' own
  `assertCanWrite` — which permits all staff, reviewers included, exactly as
  the UI does. An earlier draft assumed reviewers were read-only; the
  integration test caught the discrepancy and the spec was corrected to
  match the platform rather than forking authorization semantics.
- **Mutations are ledgered append-only** (`mcp_invocations`, migration 039)
  with optional idempotency keys. Because the ledger is insert-only there is
  no pre-execution claim: truly concurrent duplicate keys can both execute,
  and the unique index turns the second record into an explicit conflict
  naming both entities — honesty over pretend-replay.
- **No external-action tools.** Publishing/sending/connectors are not
  exposed; the approval boundary stays upstream and UI-only. `run_prompt_set`
  and `create_experiment` are the only mutations (internal, budget-capped,
  same gates as the forms).
- **The actor is never the system principal.** MCP work is operator-
  initiated; attributing it to the platform would erase who acted.

## 2026-08-01 — Audit phase 1: five named defects, one outbound-fetch policy

Fix pass for the correctness/security findings of
docs/ai-visibility-system-audit.md (§H/§I), branch fix/visibility-audit-phase-1.
Non-obvious choices:

- **One `safeFetch`, not per-caller patches.** The SSRF redirect bypass
  existed because three call sites each owned their own fetch. The policy
  (scheme check, private-host refusal, per-hop manual redirects, DNS
  resolution check, streaming byte caps) now lives once in
  `lib/security/safe-fetch.ts`; ingestion, crawling, and robots.txt all go
  through it. `isPrivateHost` moved there; ingest re-exports it.
- **The ambient DNS check is disabled under vitest.** Integration suites
  stub the global fetch with fictional hostnames; resolving them for real
  would couple tests to a resolver. The DNS path is not untested — unit
  tests inject a resolver and prove a public name resolving privately is
  refused, per hop. The resolve-then-connect TOCTOU race is documented in
  the module rather than half-solved.
- **Evidence manifests now report `parserVersions` (plural), read from the
  run's own classification rows.** The deprecated `PARSER_VERSION` constant
  stamped v1+heuristic into every manifest regardless of what ran; it is
  deleted, not just unused. Plural because the export ships every revision,
  and a re-parsed run legitimately carries two versions.
- **Position-rate drill-downs share mention_rate's denominator** (all valid
  cells, docs/06 v1.1) — the per-response current-mention join already
  counts distinct responses, so the numerator definition is one predicate.
- **Provider timeout is one constant (180s) on the SDK clients**, not a
  wrapper: retries already live in lib/ai/retry.ts and classify timeouts as
  transient; a second timing layer would fight the first. Instrument
  settings (temperature etc.) remain unrecorded because no adapter sets
  them — there is nothing true to record.

## 2026-08-02 — Prospect benchmark projects (spec 032 Phase 2.1): kind, not status

Prospect-owned benchmark runs are `projects` rows with a new `kind` column
('client' | 'prospect', migration 041) rather than a new status value or a
parallel entity. `startRun` needed no change — kind is orthogonal to the
active/archived lifecycle. The one semantic change is in
`listCompaniesForProject`: the no-cross-talk exclusion now applies only to
CLIENT subjects, because spec 008's promise is between clients — a prospect
subject was an ordinary measured company the day before the prospect
existed, and excluding it would silently shrink every client's
share-of-voice denominator. Regression-tested: client scores are
byte-identical across runs before/after a prospect project claims the
company. Prospect projects are filtered out of client-facing and portfolio
surfaces (sidebar, /projects, control-tower counts, Today feed, weekly
cycles, knowledge maintenance sweep) but the measurement pipeline runs on
them unchanged. `createBenchmarkProject` composes existing services and
reuses an already-registered company by name instead of failing on the
collision (why `onboardClient` couldn't be reused directly); the launch's
other prospects are pre-tracked as competitors; the prompt set is
deliberately left to a human in the project workspace (docs/07).

Note: the migration file is 041 (not 039/040) because specs 033/034 landed
migrations concurrently; the schema_migrations ledger on dev and test was
updated in place when the file was renumbered.

## 2026-08-02 — Learning loop closed (spec 034): measured, not assumed

- **Outcome measurement sources are the platform's own numbers**: visibility
  = subject mention_rate (provider 'all', current scoring version), citations
  = owned-citation count in the compared run. Traffic/leads/pipeline stay
  null until a real data source exists — null is not zero, and the label
  logic already treats it so.
- **The sweep needs no window claim.** measureAction is write-once behind
  FOR UPDATE, so any number of heartbeats measure each due outcome exactly
  once; idempotency is structural, like the trigger layer's fire keys.
- **A stuck outcome settles honestly.** No comparable post-action run after
  60 days past due → measured with nulls → 'insufficient_measurement',
  ending the retry loop with a recorded "we waited, nothing became
  comparable" rather than pending forever.
- **Learnings are never auto-generated.** A measured outcome suggests one; a
  person (or an operator explicitly acting through MCP) records it.
  'confirmed'/'strongly_supported' require measured source outcomes — a
  label that asserts evidence must point at it. Learnings retire with a
  reason instead of being edited: what a past decision cited stays readable
  as cited.
- Confidence vocabulary is shared with outcome_relationships (spec 019) —
  one language for "how sure are we" across the graph and the store.

## 2026-08-02 — Prompt intelligence is rules first, and refuses to guess (spec 035)

- **The classifier returns null for an unmatched prompt** instead of a
  default category — the same stance as source classification ("the honest
  label for an unknown domain is `other`, not a guess"). Import surfaces
  those rows as rejections the operator resolves; nothing enters the
  library with a category no one chose. The hand-labeled fixture set in
  tests/unit/prompt-classify.test.ts is the seed validation set an LLM v2
  must beat before it ships (docs/12).
- **Rule order is specificity, not preference**: brand > comparison >
  how-to > recommendation > problem, so "best alternatives to X" lands in
  comparison despite saying "best".
- **Clusters are computed on read, not stored.** v1 (category + salient-term
  Jaccard, greedy, order-stable) exists to make coverage discussable;
  storing versioned cluster snapshots before the algorithm has been used in
  anger would freeze a shape nobody has validated.
- **Format detection is a rule, not a heuristic**: a first CSV cell of
  "text" means header-mapped CSV; anything else is plain lines with commas
  preserved — real questions contain commas, and a paste must never be
  silently reinterpreted as columns.
- **MCP dry-run imports skip brand matching** — a dry run reads no registry
  state it doesn't disclose; the real import uses the project's
  companies/aliases for the branded rule.
- No demand/search-volume fields anywhere: no legitimate source exists, and
  a fabricated number is worse than none (re-confirmed).

## 2026-08-02 — Win rates are analyses, not scores (spec 036)

- **Head-to-head and citation profiles are derived on read, never stored.**
  Storing a win rate would demand a scoring-version bump and forward-only
  re-scoring ceremony (docs/06) for a number that is cheap to re-derive
  and whose definition is still settling. Movement (spec 030) set this
  precedent; competitive depth follows it. If win rate ever enters
  reports, THAT is the moment it becomes a versioned scored metric.
- **An unranked co-mention is a tie, not a loss.** Being mentioned without
  a list position is a different observation from being ranked below
  someone; calling it a loss would fabricate an ordering the answer never
  expressed.
- **Win rate is null when nothing is contested** — the null-is-not-zero
  rule from scoring applies to analyses too.
- **Citation profiles say "co-occurrence" in the payload itself.** The
  note rides the API response and the UI copy, not just documentation —
  a number that travels without its caveat becomes a causal claim.
- Archived competitors stay in run-scoped analyses, flagged: a run is
  history, and history includes everyone who was in it.

## 2026-08-02 — Discovery's entry point is a job an identified human requests

Spec-027 wiring (the last "not wired" gap in the visibility roadmap's
Phase 4). Choices:

- **The crawl runs as the system principal; the request is audited to the
  human.** B3's rule holds — background work is the platform's act — but
  the `discovery.requested` audit row and the job payload's `requestedBy`
  keep "who asked" answerable without impersonating anyone in a worker.
- **One in-flight discovery per project**, enforced against the jobs table
  ('queued'/'running'), not a new table — a second click while one runs is
  a conflict, because two concurrent crawls of the same identity would
  double-spend and double-ingest.
- **No subject company → refused at click time**, not discovered as a
  failed job later. The queries are built from the subject's identity;
  requesting a search for nobody is an operator error worth an immediate,
  named message.
- The integration test drives the real worker handler keylessly: searches
  fail per-query by design and the run settles with zero candidates —
  proving the plumbing without touching the network, and matching the
  spec's standing honesty that no live provider run has ever executed.

## 2026-08-02 — Nav consolidation: tabs over route moves (spec 037)

The sidebar had grown 3× past docs/04's design (16 flat project sections,
11 global links) by accretion — every spec added a link, none merged one.
Choices:

- **Merged pages keep their URLs; the merge is a link-tab bar.** Moving
  routes (e.g. /gaps → /findings/gaps) would have meant redirects, link
  rewrites, and test churn across five pages for zero user-visible gain
  over tabs. `PageTabs` renders on each sibling; the sidebar shows one
  entry, active for any member. Bookmarks, cross-links, and the entire
  integration suite survive untouched.
- **The reading order became visible.** The operator-question grouping
  (Overview / Measure / Findings / Act) lived in a sections.ts comment;
  now it is the rendered structure, enforced by a covering test: every
  section reachable exactly once, no orphans, no duplicates.
- **Machinery is demoted, not hidden**: Control tower, Workflows,
  Automation, Agents, Companies, Exclusivity live in a collapsed System
  group (persisted per browser, auto-opens when one of its pages is
  active — the current page must never be invisible).
- **Attention is badges on fewer doors**: unread on Today (the Inbox
  entry was a duplicate — Today already renders the attention feed),
  pending count on Approvals, review-queue count on the Runs tab.
- **The ⌘K palette keeps every destination** including demoted ones — the
  escape hatch must not shrink with the sidebar.
- New rule recorded in docs/04: a feature earns a tab or a group slot by
  default; a new sidebar entry requires a spec that says why no group fits.

## 2026-08-02 — Contacts get their own do-not-contact, and drafts meet the suppression list (spec 032, 2.2/2.3)

Outreach goes to a person, not a business, so refusal must exist at both
levels: `prospects.do_not_contact` (the account) and
`prospect_contacts.do_not_contact` (the human). Choices:

- **The recipient gate runs at approval AND record-sent, in fixed order:**
  account DNC → contact DNC → global `suppression_entries` match on the
  recipient's normalised email/phone (reusing `checkSuppression` from
  `lib/outreach/suppression.ts` — the prospect path previously bypassed
  the platform's suppression list entirely, a gap the audit flagged).
  Fail-closed; no second matcher was written, so `x+tag@y.com` cannot
  slip past a suppression on `x@y.com` here either.
- **Suppression checks run with `projectId: null`** — prospect outreach is
  not client-scoped, so only global entries apply. A client-scoped
  suppression suppresses that client's sends, not agency prospecting.
- **A draft with no email or phone on file skips the list check** (there
  is nothing to match) but never skips the DNC gates. The real send gate
  (`assertSendAllowed`) still stands between any future automated send and
  the world; these gates protect the human-sends-it path we have today.
- **`outreach_drafts.contact_id` same-prospect rule lives in the service**
  (the only insert path); a plain FK cannot express "the contact belongs
  to this draft's prospect" without a composite-key rework migration 042
  deliberately avoided.
- **CSV import persists through `createProspect`/`addContact`**, not its
  own insert path — dedup (unique per launch), validation, audit rows, and
  provenance labels cannot fork between manual and imported prospects. One
  provenance label is applied per file (the file is one source); per-fact
  URLs remain the job of authority signals.
- Migration 042 was numbered behind the already-committed 043; the runner
  keys on filename so it applies cleanly, recorded in docs/qa.

## 2026-08-02 — Authority and valuable visibility are derived on read, not scored rows (spec 038)

Phase B of the implementation plan needed a 0–100 local-authority score, an
intent-weighted visibility score, and their gap. Choices:

- **Derived on read, never stored** — the spec-036 precedent (win rates) and
  the spec-032 rule (benchmark deltas computed at render). The alternative,
  new metric rows under a bumped `scoring_version`, would have orphaned every
  already-linked benchmark run (reads pin the current version) or required a
  historical re-scoring pass the roadmap explicitly defers. Each computation
  carries a code version shown with the number (`authority-v1`,
  `valuable-visibility-v1`); changing a formula means bumping the constant.
- **One commercial-intent model.** `CATEGORY_VALUE` moved verbatim from
  `lib/gaps/detect.ts` into `lib/scoring/intent.ts`; tiers (persisted since
  migration 030, consumed by nothing until now) take precedence when present.
  A regression test pins the table so gap scores stayed byte-identical.
- **Global evidence is excluded, not discounted.** "Global sales volume must
  not automatically count as local authority" — a discounted contribution
  still counts, so `scope='global'` signals earn zero points and a stated
  reason. Same for `kind='other'`: unclassifiable evidence earns display,
  not points.
- **`verification_status` was NOT added** to signals despite the original
  plan sketch: the provenance label already carries the verification axis
  (verified requires a source URL, service-enforced). A second column would
  be the duplicate-concept pattern the audit criticized.
- **Max per kind, not sum**: five press mentions score once — the best one.
  Signal stuffing cannot inflate authority; all signals still render as
  evidence.
- **The gap needs both sides.** No signals → authority null; no organic
  cells → visibility null; either null → no gap, and the audit snapshot
  omits the section entirely rather than rendering a one-sided number.
- Weights remain named module constants (the `AUTHORITY_WEIGHTS` pattern);
  Phase C's configurable weights table is where they migrate — a fifth
  hardcoded table was avoided by making intent.ts shared now.

## 2026-08-02 — Fixability and the final score: one weights mechanism, stored with its explanation (spec 039)

Phase C needed the 0–100 fixability rubric and the configurable final
prospect score. Choices:

- **`scoring_weight_sets` is THE weights mechanism** — versioned rows, one
  active per name, refusing to score when weights don't sum to 1
  (`lib/scoring/weights.ts`). New scoring uses it; the legacy hardcoded
  tables (AUTHORITY_WEIGHTS, gap factors) migrate on their next
  scoring-version bump rather than being silently changed.
- **The final score is STORED, unlike the derived-on-read spec-038 scores** —
  deliberately: the list filters/sorts on it, and a stored score is a
  snapshot computed at a known time whose breakdown records every component,
  weight, weight-set version, fixability category, and flag that produced
  it. Recompute is an explicit audited action.
- **Underivable fixability inputs are operator-recorded facts**
  (`prospect_assessments`, upsert per item, identity kept), never guesses.
  "unknown" is a recorded answer distinct from never-asked; unanswered
  items make a category "not measured". Raw fixability is a rate over
  MEASURED categories only — unknown is never scored as bad or good — and
  missing coverage lowers data confidence instead (adjusted = raw ×
  confidence; the three shown separately).
- **Hard flags downgrade and explain, never delete**; reputation_concern
  additionally sets needsReview. A flagged prospect keeps its score.
- **Override never erases the computed score** — separate columns, required
  reason, audited both ways; lists filter on the effective value
  (override wins).
- **JSONB keys must be camelCase in this codebase**: db/client.ts uses
  `transform: postgres.camel`, which rewrites snake_case JSONB keys ON READ
  — a snake_case weights seed came back as different strings than were
  stored and silently dropped five of six components. Weight-set and
  breakdown keys are camelCase; recorded here so the next JSONB vocabulary
  doesn't rediscover it.
- Buying signals (Phase F) are a declared component whose weight
  redistributes until the data exists — the breakdown says "not measured"
  rather than pretending a zero.

## 2026-08-02 — Market packs are data, installed into the one markets tree (spec 040)

Phase D needed per-city geography, vocabulary, and prompt templates for five
launch markets. Choices:

- **Packs are code-versioned data (`lib/markets/packs.ts`), not DB config
  and not per-city code** — the vertical-pack philosophy applied to place.
  Adding a city is adding a registry entry; a structural test validates
  every pack (placeholders known, exclusions exist in the hierarchy, tiers
  legal). No core logic changes per city.
- **One hierarchy.** Packs install into the exclusivity `markets` tree
  (kinds widened to country/state/metro/county/zip) instead of creating a
  parallel geo model — the audit counted three market representations
  already. The installer matches by name-or-alias under the same parent, so
  re-installs duplicate nothing and cross-pack ancestors ("United States")
  converge on one row. Installs are recorded with the exact definition
  snapshot (`market_pack_installs`).
- **ZIP rows are not materialized** — hundreds of rows nobody prompts
  against; ZIPs ride the pack as data, `kind='zip'` exists when a real need
  appears.
- **A cycle guard trigger now protects `markets.parent_id`** (audit §10:
  conflict detection recurses over this tree; a cycle would hang it).
- **Generation is deterministic, capped with a report, and idempotent** —
  no LLM, same input → same prompts; texts already in the set are skipped;
  cap overflow is counted, never silent. Ambiguous place names (Chinatown,
  The Heights, Downtown Miami) stay in the hierarchy but are excluded from
  expansion with stated reasons: an unattributable prompt measures nothing.
- **Lineage on prompts** (`audience`, `price_tier`, `template_ref`,
  `source='expansion'`). Extending FrozenPrompt with audience/price-tier is
  deferred until a consumer exists — tier already flows into snapshots and
  is what valuable visibility reads.

## 2026-08-02 — Discovery lands as candidates; a brokerage is not the team (spec 041)

Phase E added provider-based prospect discovery and entity resolution.
Choices:

- **Adapter output is never a prospect.** `ProspectSourceAdapter` results
  land as candidates with the full SourceRecord envelope (provider, source
  URL, retrieval date, confidence, provenance label) and their raw payload;
  only human approval creates a prospect — through `createProspect`, the
  one persistence path. A same-name conflict is a recorded `duplicate`
  outcome, not an error. The mock adapter (obviously fictional fixture
  teams) is refused outside tests via the same `mockProviderAllowed` guard
  as the mock AI provider.
- **One name matcher.** The resolver reuses `scoreNameMatch`/`bestMatch`
  semantics from `lib/knowledge/normalize.ts` (exact 0.9 / probable 0.65 /
  ambiguous 0.45) plus the two signals prospects uniquely have: website
  domain (0.95, decisive — companies.domain existed unused) and brokerage
  affiliation.
- **The brokerage rule is an exclusion, not a penalty**: a company whose
  match is explained by the affiliation at least as well as by the business
  name — with no domain tie — is excluded from candidacy and reported as a
  collision with the reason. "Rivera Team at Compass" can never resolve to
  the company "Compass". A domain tie overrides: identity beats affiliation.
- **Ambiguity stays ambiguous**: equal top scores → `possible`, never a
  coin toss; `possible` never auto-links — it renders as a detail-page
  suggestion whose confirmation goes through the audited `updateProspect`.
- **Deviations recorded:** CSV/manual ingestion keeps its existing
  provenance shape (refactoring shipped code onto SourceRecord would be
  churn for symmetry); discovery runs execute inline while the only adapter
  is the instant mock — a network adapter moves execution onto the jobs
  queue.
- Cross-launch dedup is a read surface (same normalized name / domain /
  company), and "merging" is linking both rows to one canonical company —
  prospects stay launch-scoped by design (spec 032).

## 2026-08-02 — Diagnoses are typed and honest; intent evidence expires (spec 042)

Phase F added the diagnosis layer, buying signals, and freshness. Choices:

- **Diagnoses are derived on read** with a version constant, from data the
  platform already trusts. Eleven computable keys, each with a triggering
  and non-triggering test. **Absence-of-research diagnoses ("no review
  footprint recorded") are about OUR evidence base**, carry 0.4 confidence,
  and say "gap in our research" — never presented as measured facts about
  the prospect. Suggested actions are a static reviewable map, no LLM.
- **Buying signals have a hard floor**: source URL and observed date are
  NOT NULL at the table, not just service-validated — the target rule
  ("every buying signal requires a source and date") made structural.
- **Intent evidence goes cold**: score contribution = 25 × provenance ×
  recency, where recency is 1.0 within the 180-day window, 0.5 to 2×, then
  0. Zero recorded signals = null (not measured, weight redistributes);
  recorded-but-expired = 0 (intent measured and gone cold). The distinction
  matters and is tested.
- **Freshness windows are named constants** (benchmark 90d, authority
  signals 365d, buying signals 180d, contacts 180d, assessments 365d) with
  a pure injectable-clock `staleness` helper. A stale benchmark **fails
  publishAudit closed** with the run's age in the message; publishing
  anyway requires `acknowledgeStale: true`, and the acknowledgment lands in
  the audit log with the age. The UI offers the acknowledgment through an
  explicit confirm, never silently.

## 2026-08-02 — Spec-011 reconciliation: the red level is "human-decided, machine-enforced", not "no code path" (roadmap 3.1)

docs/15's red level said sending outreach must have **no code path**; migration
020 later shipped `assertSendAllowed`, a seven-check fail-closed send gate —
a code path. The written reconciliation, unblocking Phase 3:

**The gated send stands; the red level's wording is superseded by its
intent.** The intent was that no automation contacts the outside world
without a human decision. "No code path" turned out to be the weaker
implementation of that intent: it pushes real sends into untracked personal
mailboxes, where the suppression list, the artifact-hash approval binding,
and the compliance checks protect no one. A send path that *refuses* to
work without a recorded human decision enforces the red level better than
the absence of one.

Standing rules going forward:
1. Every platform send passes `assertSendAllowed` — suppression on
   normalised identifiers, tenant match, recipient authorization or stated
   business purpose, approval bound to the exact artifact hash, opt-out
   path. Fail-closed, no warn-and-continue.
2. **First-touch prospect outreach is additionally human-dispatched**: a
   human clicks send (or records a send) per message. Autonomous first
   contact remains forbidden.
3. Autonomous *sequence* steps (roadmap 3.3) stay per-step human-approved
   until a separate recorded decision lifts that — this entry does not.
4. docs/15's red-level table reads as "human-only decision, machine-enforced
   execution"; "no code path exists" applies only to fully autonomous sends.

## 2026-08-02 — The send bridge: every dispatch and every refusal is ledgered (spec 043)

Phase G implemented the credential-free half of outreach activation on top
of the spec-011 reconciliation above. Choices:

- **`sendProspectDraft` is the bridge between the two outreach stacks** the
  audit flagged as disconnected: prospect drafts now pass the full
  fail-closed chain (approval state → account DNC → contact DNC →
  suppression on normalised identifiers → prohibited phrases → stated
  business purpose → opt-out present) before ANY channel is reached.
- **Refusals are evidence.** `prospect_outreach_sends` is an insert-only
  ledger (forbid_mutation trigger) recording the full gate verdict, the
  sha256 of the exact outgoing text, and the stated business purpose — for
  refusals as well as sends. The refusal path RETURNS from the transaction
  instead of throwing, precisely so the ledger row commits.
- **Channels are dispatch mechanisms behind a human click.** 'manual'
  records a send the human made from their own mailbox — the record-sent
  UI now routes through it, so even mailbox sends get suppression/DNC
  checks and a ledger. 'mock' is CI-only behind the standard mock guard. A
  real Gmail/ESP channel is an append to channels.ts after live
  verification — interface first, credentials later.
- **Cold email carries a reply-based opt-out**: transmitting channels
  append a footer with sender identity and an unsubscribe instruction, and
  the gate asserts an opt-out mention exists. Opt-out replies belong on the
  suppression list, which the gate then enforces forever.
- **The funnel counts ever-reached, not snapshots** — a contracted prospect
  fills every earlier stage; conversion is null (never 0) on an empty base;
  exits are counted beside the ladder, not inside it.
- **The feedback loop recommends, humans reweight**: cohort comparison
  (reached `replied`+ vs not) refuses below 5-per-cohort, reports means
  with sample sizes, and every report ends with the fixed epilogue that
  weights change only through scoring_weight_sets. Nothing is written
  automatically — target req. 21's rule, made structural.
- **Deferrals recorded:** live Gmail/ESP verification, OAuth flow, reply
  ingest + classification (roadmap 3.2's live half, 3.4) are blocked on
  funded credentials, not architecture; deal economics (3.5) and
  prospect→client conversion (3.6) remain open roadmap items.

## 2026-08-03 — The assistant's only hands are the observer tools (spec 044)

The workspace chat dock answers from live platform data. Choices:

- **Its entire data access is the MCP observer registry via invokeTool,
  as the logged-in user** — same staff assertion, zod validation, and
  classified errors as the MCP server; zero duplicated business logic.
  Mutating (operator) tools never enter its catalog, so the model cannot
  even see them: v1 reads and explains, it does not act.
- **One agent runner** (lib/ai/agent.ts): strict two-shape JSON protocol
  per iteration (tool call or answer), at most 6 lookups per question,
  then the prompt forces an answer. Invalid tool names/inputs return to
  the model as tool errors instead of crashing the turn. Injectable
  caller keeps CI keyless.
- **Transcripts are records**: insert-only assistant_messages carrying
  the tool calls each reply rests on plus per-turn cost; conversations
  are per-user (another user's conversation reads as not-found).
- **Honesty in the prompt** (docs/13, workspace-assistant-v1): every
  figure names the tool it came from; "not measured" is an answer; if
  asked to act, the assistant points at the page that does it.
- Rendering follows the sidebar rule (nothing without a staff session);
  the boundary stays the service, which re-asserts staff per call.

## 2026-08-03 — Report periods are UTC-anchored, not session-timezone (bug fix)

Found live: the weekly pulse failed to draft every Sunday evening in
negative-offset timezones. weekStart is a UTC Monday, but
`started_at >= period::date` makes Postgres cast the date in the SESSION
timezone — so between UTC midnight and local midnight, a cycle's own
benchmark run fell before its period and buildSnapshot saw "no completed
runs". Fixed by casting period bounds explicitly as UTC timestamptz in
lib/reports/snapshot.ts (both bounds + previous-run lookup) and the
cycle's run-reuse window. Verified inside the failure window itself.
Grep found no other `::date` comparisons against timestamptz on hot
paths; any new period math must anchor its timezone explicitly.

## 2026-08-03 — Dev auth fails closed in a production process (phase 0.1, production-readiness plan)

`AUTH_MODE` defaults to `dev`, and dev mode returns a hardcoded admin for
every request. That default was correct for the test suite and wrong for the
internet: the single most likely deploy mistake (one forgotten env var) would
have published the whole workspace as a passwordless admin session. Decision:
a production process refuses to serve under dev auth — 503 in middleware,
`forbidden` at `getCurrentUser()` — with `ALLOW_DEV_AUTH_IN_PROD=1` as the
explicit override, mirroring `ALLOW_MOCK_PROVIDER`. The `next build`
prerender phase is exempt (`NEXT_PHASE=phase-production-build`) so CI can
keep building with dev auth; the check re-fires on every served request.
One predicate owns the rule (`devAuthRefusalReason` in `lib/env.ts`) so the
middleware and the auth boundary cannot drift.

## 2026-08-03 — Phase 2/3 of the production-readiness plan: provenance closes, the last mile opens

Phase 2 (measurement provenance): the parser stamp now records what actually
ran (a fallback parse stamps v1, and scoring readiness accepts any known
version so honesty doesn't stall runs); mock captures are excluded from
scoring and refused by linkBenchmark outside the test harness; scores got
the forbid_mutation trigger every peer table already had (052); executeCell
captures before pricing, with unknown cost as NULL — never $0 — and a halt
(053); orphaned benchmark runs are reaped to 'failed' by the worker's idle
sweep; DAILY_SPEND_CEILING_USD caps the rolling day portfolio-wide; the
rate gate is process-level, one clock per provider account.

Phase 3 (prospecting last mile), the choices that weren't in the plan text:
- **Send channel stays assisted-manual for v1.** "Open in mail app"
  prefills recipient/subject/body via mailto:; the platform still transmits
  nothing. Gmail OAuth remains open as the operator's decision — the gap
  that mattered (retyping the email and pasting the link by hand) is gone
  without new credentials or deliverability surface.
- **Draft editing = a new version through createOutreachDraft**, not an
  UPDATE path: drafts are versioned rows and approval re-runs the
  prohibited-phrase gate on the saved text. No second mutation path to
  audit.
- **Audit links default to 45-day expiry** (AUDIT_LINK_DEFAULT_EXPIRY_DAYS);
  "Expire link" kills the token while the audit stays published — revoke
  keeps its mandatory reason for "should not have gone out".
- **The generated email carries the audit link when one is published**
  (built from APP_URL, never window.location) and the ask matches the
  page's CTA chip: reply "show me". Unpublished → the old reply-first ask.
- **Staff opens of the audit page are labeled is_internal** and excluded
  from view counts and the activity timeline (session read is label-only;
  content still renders solely from the snapshot).
- **Deep vertical-neutral copy is deferred** until a non-real-estate market
  pack exists; fixed now: the broken "the monitored market" fallback and
  the sentence structure around the market name. All five packs are
  residential RE; the reader the page is designed for is an RE agent.
- **Discover hides when no real source adapter is configured** — a button
  that errors on submit is worse than absence; CSV/manual are the universe
  sources until an adapter ships.

## 2026-08-03 — Phase 4/5: the portal stops leaking by default, the portfolio gets a work layer

Phase 4 (client-access hardening): interventions gained `client_visible`
(054), deny-by-default like tasks, with an explicit toggle; portal services
take the user and re-assert project access per read — Next.js layouts are
not an authorization boundary; export routes were audited and found clean
(the evidence package selects cost/tokens but never serializes them; CSV/
HTML export published-report content only), and Next's production error
redaction covers server-component messages, so 4.3/4.5 closed as
verification results, not code.

Phase 5 (agency layer) — the non-obvious choices:
- **audit_log.project_id resolves itself in the database** (055): a
  before-insert trigger maps entity → owning project centrally instead of
  touching ~150 writeAudit call sites; an explicit projectId from a writer
  wins, unknown entities stay null. Backfill by the same joins. The
  /projects/[id]/activity page is the log's first reader.
- **The work board is a read, not a new object**: /work lists open tasks
  across active clients (overdue first) straight off the columns that
  already existed.
- **Overdue tasks enter the control-tower queue** as source `task_overdue`
  — the formula itself is unchanged, so no version bump; a new input, not
  new math.
- **Plan items activate into real tasks** born 'approved' (activating an
  item of an approved plan IS the human decision), carrying the item's
  evidence; task completion flips the item to done via the transition
  hook; dropping requires a recorded reason. Migration 026's dead columns
  now have writers.
- **Contract value (056) beats the spend proxy when present**; the two
  scales normalise separately and unpriced clients keep the honest spend
  fallback. Set per client in Settings → Portfolio.
- **Digest delivery is a Slack-compatible webhook** (DIGEST_WEBHOOK_URL),
  the first channel needing no OAuth; cadence belongs to the scheduler
  (?digest=1 on the notifications cron), not the code.
- **Today embeds the control tower's top five** so the two attention
  surfaces agree on "what first" instead of ranking independently.

## 2026-08-03 — Spec 049: the UI gets its own test layer (Playwright)

The 1,400-test suite stopped at the service boundary; nothing verified a
page renders or a button does what its label says. Choices: Playwright with
chromium only and ONE worker (the suite shares a seeded database — serial
and deterministic beats parallel and racy at this scale); a fully isolated
runtime — database llm_optimizer_e2e, port 3100, build dir .next-e2e via
NEXT_DIST_DIR — so the shared-.next trap is designed out and the suite runs
while a dev server is live; fixtures seeded through the REAL services with
the mock provider (scripts/seed-e2e.ts) — if the pipeline can't produce a
state, the UI shouldn't be tested against it; AUTH_MODE=dev, because E2E
covers the operator and anonymous-prospect experiences while role denial
stays with the SQL-level portal isolation tests. project-sections.spec
iterates PROJECT_SECTIONS from the nav registry, so a new section cannot
ship without a rendering check.

## 2026-08-04 — Stable audit links: supersede moves the token, revoke burns it (057)

The operator wants one link per prospect across republishes. Chosen
semantics: publishing over a live audit SUPERSEDES it in place — the old
snapshot is frozen forever under a new 'superseded' status (as immutable
as published; the lock trigger allows exactly one transition: status
change + token vacated) and the token moves to the successor in the same
transaction, so the prospect's bookmark always shows the latest published
version. Revocation keeps its meaning — the link is burned and the next
publish mints a fresh token — so "update in place" and "cut the cord"
remain distinct, deliberate acts. publishAudit returns `replaced` so the
UI can say which one happened.

## 2026-08-04 — Four-lens cleanup audit: what was fixed, what is backlogged

Four parallel audits (dead code, house-rule compliance, patterns/correctness,
structure), each required to verify with call-site evidence. Fixed in this
pass: three confirmed bugs (publishAudit's reads escaping its own
transaction → pool-deadlock + isolation break; a run cell able to hold both
a success and an error row on an insert-only table; the recommendation_rate
threshold measuring the legacy global is_self brand for every project),
plus the systemic guards — session TimeZone pinned to UTC, the one
production sql.unsafe made safe at the sink, the NUL byte that hid a
350-line file from grep, and the codebase's only runtime import cycle.

**The design-system ratchet was inverted and is now frozen.** The layout
guard computed its exemption list as "pages that don't import the
primitives", so non-compliance granted its own exemption and width drift
widened after the guard shipped (6 → 10 widths). The 62 offenders are now a
literal list that can only shrink, and the hex/inline-style checks cover
components/ too — which immediately caught chart chrome hardcoded to
dark-only hex.

Consolidated: 15 copies of the server-action `run()` wrapper into
`lib/actions/run.ts` (parameterized on revalidate targets, no default — a
wrong default silently breaks cache invalidation), and 10 copies of the
test `unwrap()` into `tests/helpers/result.ts`. Deleted 27 zero-reference
exports and `scripts/_tmp-discover.ts` (which hard-coded a personal email).

**Backlogged deliberately** (in docs/cleanup-backlog.md): the 3,000-line
prospects service split, 39 inline SQL queries in pages, 109 `as never`
casts pending a typed json() helper, the `date-fns` rule with no
dependency installed, 22 copies of the current-revision SQL predicate, 9
divergent percent formatters, and the write-only tables. Each needs either
a product decision or a wide mechanical diff, and none is a correctness
risk today.

## 2026-08-09 — Spec 050: truth hardening (branch feat/050-truth-hardening)

**Mock scoring is a separate permission from mock running.**
`ALLOW_MOCK_PROVIDER` was one flag doing two jobs: letting the mock provider
run (a dev convenience) and letting its fabricated captures fold into score
rows (fabricated evidence). Split: `mockScoringAllowed()` requires the test
runner or an explicit `ALLOW_MOCK_SCORING=1`, and returns false under
`AUTH_MODE=supabase` unconditionally — the real-auth posture never scores
fiction, whatever the flags say. Seeds/e2e opt in explicitly.

**The instrument is recorded, not inferred.** `responses.request_params`
stores what each adapter actually sent (provider defaults recorded AS
"provider_default" — a truthful statement, unlike omission); mentions and
response_parses carry `classifier_model` + `classifier_prompt_version`.
A pinned SHA-256 unit test fails CI when a classifier prompt is edited
without bumping its version constant. Why: parser_version named the family
but not the instrument, so a model/prompt change altered every future
client metric with no stamp changing and no CI signal.

**One spend pool.** Insert-only `llm_calls` written from inside `runAgent`
(success and terminal failure — the spend happened either way);
`spendLast24hUsd()` and per-client rollups now include agent spend. The
daily ceiling semantics deliberately changed: classification/content/
accuracy traffic draws down the same $25/day as benchmark runs, because a
cap that ignores the highest-volume caller is a receipt, not a cap.

**Team/Group equality is a hypothesis, not a match.** `scoreNameMatch`
demotes name equality that exists only because `group`/`team` were stripped
to `probable` (requires review); legal suffixes and "the" still collapse; a
domain tie still auto-matches. "Rivera Team" vs "Rivera Group" are
frequently different real-estate firms, and a team is not the agent it is
named after. Consequence accepted: discovery auto-links less and surfaces
more `possible` verdicts for a human. `createBenchmarkProject` now resolves
through the one resolver (match links / possible refuses with candidates
named / none creates) instead of exact-lower(name)-or-create, which minted
duplicate companies.

**The production classifier is measured.** Versioned gold corpus
(`classifier-gold-v1`, real-estate traps: brokerage-vs-team, Team/Group
collisions, agent-vs-team, same-name-other-industry) runs through
`classifyResponseLlm` itself; metrics are pure math against exported
floors; every evaluation persists to insert-only `classifier_evaluations`.
CI proves the harness with stub callers (an all-positive classifier fails
the shipped corpus); `scripts/eval-classifier.ts` runs it live and is
required before any instrument change ships. The review queue's human
verdicts become `classifierDisagreementRate()` — a continuously-produced
accuracy signal that was previously discarded.

## 2026-08-09 — Spec 051: value loop closure (branch feat/051-value-loop)

**Verdicts are frozen into the snapshot, not recomputed for display.**
`SnapshotIntervention.verdictSummaries` is computed by the existing
`computeVerdicts` at snapshot-build time and stored in the immutable body:
the client's report records exactly what was known at publication — later
post-runs change future reports, never a delivered one. One shared helper
(`interventionVerdictSummaries`) feeds the snapshot and the portal; one
translation (`verdictLine`) turns verdicts into client language, and it
deliberately says "no clear change yet", never "didn't work" — absence of
a notable delta at one offset is not a negative result.

**The causal gate rides the evidence gate.** `CAUSAL_PHRASES` is exported
from the workflow gates (one list) and `validateNarrative` blocks causal
sentences at publish regardless of digits. Why: the digit rule alone let
"our work drove your gains" publish clean, and that sentence is precisely
what the attribution system exists to prevent asserting without labels.

**Live verification is a job, not a promise.** `url_verifications` is
append-only; `createIntervention` enqueues `verify_intervention_urls`
transactionally with the insert, the worker fetches through `safeFetch`
(one egress policy), and a failed page is a recorded fact — never an
exception. Accuracy findings now pass through `fix_in_progress`;
`corrected` requires the linked task done (`markFindingCorrected`,
audited) — the old path wrote `corrected` at task creation.

**One outcome spine.** `createIntervention` records an `action_outcomes`
row with `intervention_id` in the same transaction (+6w horizon matching
the retest schedule), so the intervention-verdict loop and the
outcomes→learnings loop finally share a row and a learning can cite a real
intervention's verdict. Interventions carry `owner_id`/`cost_usd`;
approval workflow stays deferred (audit F3, P2).

**Delivery is a ledger, not an integration.** `report_deliveries` is
insert-only and published-only; the operator's mail client remains the
transport — the same honest pattern as the prospect manual channel — so no
ESP/sender-identity decision (spec 052) is preempted while "was this ever
sent, to whom, when" becomes answerable.

## 2026-08-09 — Spec 052: manual outbound safety (branch feat/052-outbound-safety)

**Audit numbers are bound to score rows, and publish verifies the binding.**
Snapshot comparison rows carry the immutable `scores` row id per metric;
`publishAudit` refuses any rate that is unbound or does not exactly match
its referenced row. Traceability on the prospect surface was a code-review
invariant (the assembly happened to read from scores); it is now
architecture — the prospect-facing twin of the report citation gate.

**The missing sender decision blocks sends instead of producing
non-compliant ones.** `outreach_sender_identity` (one active row, admin-
set, append-and-deactivate) is required by draft generation and the send
gate; the opt-out footer now carries the truthful sender, company, and the
physical postal address CAN-SPAM §7704(a)(5) requires. A published audit
whose link cannot resolve (`APP_URL` unset) refuses draft generation — the
silent no-link fallback was exactly how the first real email would have
shipped without its proof.

**Re-contact guards are ledger queries, not new state.** The insert-only
send ledger already knew who was contacted when; the gate now reads it:
same email under another prospect within 30 days refuses, and a brokerage
is capped at 3 allowed sends per 30 days. Windows are constants, not
config — changing them is a policy decision that belongs in a diff.

**Every send re-checks territory.** `exclusivity_agreements` gains
`reserved` (a pending-proposal hold that occupies the territory exactly
like active; dates still govern), and the send gate re-runs conflict
detection per send, honoring a recorded admin override. No sweep needed:
signing or reserving suppresses conflicting in-flight sends because
nothing sends without re-checking.

**Erasure and immutability reconciled.** Measurement data (responses,
mentions, scores) is immutable and contains no contact PII; contact PII is
deletable on request. What must survive is the never-contact-again
promise, and it lives in the suppression list as a normalized match key —
tombstone and erasure commit in ONE transaction, so neither ever exists
without the other. `stalePiiReport` makes retention visible before a
retention policy exists.

**Access grants are doors, not records.** `revokeClientAccess` deletes the
grant (access control is deletable; the users row and audit history stay)
and `setUserActive` finally gives the product a hand on the `users.active`
switch auth always honored — never on yourself.

## 2026-08-09 — Spec 053: fleet drift & sentinel (branch feat/053-fleet-drift)

**One signal, not N client stories.** The fleet detector groups
comparable-pair subject deltas across all client projects and opens ONE
drift signal per (provider, metric, direction) fingerprint naming every
affected project — the floor is ≥3 projects AND ≥50% of the *measurable*
fleet (projects without a comparable pair are unknown, not stable, and
leave the denominator). Pure math, known-answer tested; no model near it.

**Open-fingerprint dedupe instead of a scheduler contract.** The detector
is safe on any cadence because a partial unique index allows one OPEN
signal per fingerprint; acknowledging (audited, with a note) re-arms
detection for a recurrence. This is what lets it ride the existing cron
heartbeat with zero new scheduling machinery.

**Shape drift is now data.** `responses.shape_recognized` persists the
adapter's verdict that previously died in an error log; a week's window of
false flags per provider is a standing signal until acknowledged.

**Sentinels are ordinary projects.** `kind='sentinel'` reuses the entire
measurement stack (prompt sets, runs, scoring, scheduling) and inherits
exclusion from client/portfolio surfaces from the existing kind='client'
filters. On a sentinel, ANY comparable-pair movement is the anomaly —
that inversion is the whole design. Weekly-cycle inclusion for sentinels
is a deliberate follow-up, not an accident.

## 2026-08-10 — Spec 054: shared market captures (branch feat/054-shared-captures)

**Capture reuse, not shared runs.** Runs stay project-owned (budgets,
evidence, immutability, scheduling all key on project); the saving comes
from satisfying a cell with a copy of another project's recent capture of
the byte-identical prompt. Moving run ownership to markets would have
reworked half the platform for no additional saving.

**Same-project never reuses.** A retest or weekly cycle must sample fresh
— reusing within a project would let a measurement "measure" its own
baseline. Cross-project reuse inside a 72h window is the deliberate
inverse: same-market clients measured in the same cycle should see the
same market reality (it improves comparability, not just cost).

**Provenance always points at the paid original.** Copies never serve as
sources (`reused_from is null` in the eligibility query), so every copy
is one hop from the capture the platform actually paid for. Cost is
recorded as 0 on copies — the ledger stays truthful about what was spent,
and `reused_from` answers "did we pay for this answer or share it?".

**Mock never participates.** Test and demo behavior is a contract other
suites rely on; excluding the mock keeps every existing suite's
call-counting semantics intact and costs nothing (the mock is free).

## 2026-08-10 — Spec 055: model routing tiers (branch feat/055-model-routing)

**Routing is a table in code, fail-closed, with a rationale per row.**
`lib/ai/routing.ts` maps every recurring LLM task to a tier; an unknown
task THROWS, so a new LLM task cannot ship without an explicit routing
decision in a reviewable diff. Routing changes are policy changes — they
belong in code review, not config (the standing rule). Tiers resolve to
the existing model constants, so a model bump stays a one-line change and
the table survives it untouched.

**runAgent's frontier default is gone — model is required.** The audit's
finding A2 was not that frontier was wrong for everything; it was that
frontier was the DEFAULT, so 16 of 19 automation agents ran it without
anyone deciding. Now every caller resolves through the table, and the
pinned policy tests make a tier change a same-diff test change.

**Downgrades follow A4; the floor follows A5.** Cheap tier: the mention
classifier/verifier (gold-set gated), narrow extraction that lands in a
human-approved proposed state, internal summarize/repurpose/followup
drafts, and the authority-action explainer (the ranking is deterministic;
the agent only explains it). Frontier stays wherever a wrong answer costs
more than the tokens saved: everything client-facing, every gate that
decides whether work ships (content verify, adversarial review, artifact
verification), accuracy analysis, contradiction detection, outreach.

**Provenance shows the route.** The classifier instrument stamps
(spec 050) and the llm_calls ledger record the RESOLVED model, so a
routing change is visible in the data, not just the diff.

## 2026-08-10 — Spec 056: entity architecture (branch feat/056-entity-architecture)

**Company-first relationships.** The relationship write path takes company
ids, not knowledge-entity ids: companies are what operators see and what
the groups rollup joins on. Each side bridges to a typed knowledge entity
(created on demand via the existing upsertEntity), so the rich graph fills
in behind the surface operators already use. Proposals land `proposed`;
approval is a human decision (the schema's own design); a brokerage move
is an end date plus a successor proposal — history is never edited.

**Market scoping via a null-bucket coalesce index.** One active company
name per market, plus one in the global (null-market) bucket — existing
rows stay global, nothing migrates. Cross-market same names deliberately
reach the prospect resolver as a tie → `possible` → human, which is
exactly the spec-050 contract: representable ambiguity, never a silent
pick. The alias false-merge check scopes to the same bucket.

**Merges move the future, never the past.** mergeCompanies moves the name
and aliases to the survivor (future parsing credits it), repoints
prospects, re-tracks competitors — and leaves every historical mention and
score on the merged row, because those measurements were of the entity as
then understood; rewriting them onto the survivor would be fabrication.
Refusals: self, chains at write time, double-merge, and merging two
active client subjects (that would merge two clients). Unmerge is possible
precisely because nothing was destroyed: the audit row records the exact
alias set that moved, and unmergeCompany restores it.

## 2026-08-10 — Spec 057: prospect→client promotion (branch feat/057-prospect-promotion)

**Convert, don't copy — and never as a stage side effect.** Promotion is an
explicit, audited action available at `contracted`, not a hidden
consequence of a stage click: creating a client is a deliberate act. The
benchmark project flips kind in place, so the pre-signing baseline —
captures, mentions, scores, competitor set — IS the client's first
baseline, and the first client report gets a comparable prior for free
(same frozen prompt-set version, same scoring version; the comparability
rules work unchanged). Copying rows into a new project would have broken
immutability; re-running the research would have paid twice (audit B5).

**Territory locks at close.** Unless declined, promotion creates an ACTIVE
exclusivity agreement scoped to the launch's market + service category +
segment starting today — closing audit 12.2's "signing creates no
agreement" hole. Reserved pre-close holds are not project-parented and
stay the operator's to terminate via the existing surface.

**Rename yields to collisions.** The promoted project takes the business
name unless an active project already owns it; then the benchmark name
survives and the audit detail says so. A promotion must never fail over a
label.

**Agreement-before-core ordering.** createAgreement runs its own
transaction before the core promotion commit; a failure between the two
leaves an audited agreement on an unpromoted project — visible and
repairable — never a promoted client without its recorded close.

## 2026-08-10 — Spec 058: learning-loop closure (branch feat/058-learning-loop)

**Learnings re-order; they never add or remove.** learning-adjust-v1 is a
deterministic, versioned, capped rank adjustment inside composePlan:
confirmed/strongly-supported learnings move a play ±10/−15 opportunity
points (cap ±20) per their declared direction; weaker labels annotate
nothing and move nothing. The play catalog and its precondition gates stay
the sole authority on what work is possible — the loop only re-orders and
explains, and the plan baseline records the adjustment version.

**Direction is a required field.** A learning about a play must say which
way it cuts (supports|cautions). Without it, "we learned something about
directory cleanup" is unusable by any ranking rule, and the audit's
retrieve-comparable-outcomes vision reduces to full-text search.

**Derivation over data entry.** recordLearning fills intervention, gap
type, and cost from the cited measured outcomes when the operator doesn't
— the highest-integrity path (citing real outcomes) is also the
lowest-effort one. Explicit input always wins; derivation only fills
blanks.

**No ML yet, deliberately.** The audit's own guidance (§29): don't
recommend ML before enough clean outcomes exist. The dimensions and the
supports/cautions counts make that moment visible; until then the
adjustment stays a constant-weight rule a reviewer can read in one
sitting.

## 2026-08-10 — Spec 059: productionization groundwork (branch feat/059-productionization)

**Ship everything the host decision doesn't block.** Dockerfiles, compose,
health, heartbeat, alerting, encrypted off-box backups, the env contract,
and truthful docs are host-agnostic; building them now turns the eventual
host choice into an hour of wiring. The GH-Actions heartbeat is an honest
stopgap scheduler (5-min granular, best-effort) — acceptable because every
cron-driven job is windowed and deduped by design; the runbook says to
move to the host's scheduler when one exists.

**One health route, two audiences.** Platform health checks can't send
headers, and the full report leaks operational detail. The same GET serves
minimal {ok, db, worker} unauthenticated and the full report under the
CRON_SECRET bearer — no second endpoint to drift.

**Alerts dedupe or they don't exist.** One post per alert kind per hour,
re-armed on acknowledgment-by-time — an alarm that cries on every tick is
an alarm nobody hears (the same reasoning as the drift-signal open-
fingerprint dedupe). Alerts still RETURN in the cron response even with no
webhook: silence must never be silent failure.

**A visible audit report, not a blocking gate.** npm audit fails today on
transitive advisories with no upstream fix (sharp/libvips via Next); a
blocking gate would freeze the repo and train people to ignore it.
Dependabot files the fix PRs; the CI report keeps the state in every run;
docs/10 now says exactly that instead of claiming a gate that never
existed.

**The restore drill earned its keep immediately:** it caught the manifest
hashing itself (shell redirection creates the file before some shells
expand the glob) — exactly the class of bug a drill exists to find before
an incident does.

## 2026-08-12 — Spec 060: citation acquisition engine

**One opportunity row per (project, domain), not per URL.** The ledger
(response_citations, migration 033) already keeps every URL-level fact
immutably; the opportunity is the operator's unit of work, and operators
pursue "get onto hobokengirl.com", not "get onto /best-agents-2026?utm=x".
URL-level opportunities can arrive later without a schema break (the
ledger has the data); domain-level dedup by construction kills the
www/query-param duplicate class outright.

**ACVS carries no backlink-authority inputs — by omission, enforced by
shape.** The DomainStats interface has no DA/DR/traffic field to misuse.
A source scores highly only because AI answers in this project actually
cite it (frequency, prompt intent, cross-engine spread, recommendation
co-occurrence, persistence), plus operator-recorded feasibility and the
deterministic source-type classifier. Weights live in the existing
scoring_weight_sets mechanism ('citation-acvs' v1); every stored score
carries components + explanation + scorer and weight-set versions.

**Unknown is null, never zero.** Unchecked client presence, untiered
prompt sets, and unclassified sources redistribute their weight (the
authority-score convention) instead of silently penalizing. clientGap only
becomes 1 after a presence check verifiably finds the client absent —
"we didn't look" must never rank a source as if we had.

**A placement IS an intervention.** linkPlacement calls createIntervention
(spec 007/051) rather than growing a parallel measurement path: baselines,
live URL verification, +2/+6/+12w retests on the same instrument, verdict
math, and the action_outcomes spine all come from the one existing system.
successful vs inconclusive is a human reading measured verdicts — the
lifecycle refuses outcome statuses from anywhere but `measuring`.

**Guarantee language joined the causal-phrase gate rather than a fourth
list.** "guaranteed / will improve / ranks because / directly resulted /
proven to / ensures" extend CAUSAL_PHRASES (spec 051's single list), so
executive briefs and client narratives are hardened everywhere at once;
ACVS explanation templates are unit-tested against the same list.

**Fixability points unchanged.** The citation pipeline feeds
third_party_opportunity as evidence lines only — changing the point
formula is a fixability-v2 version bump with a recompute story, deliberately
deferred, because stored prospect scores reference the rubric version.

## 2026-08-12 — Spec 060 QA fixes (post-merge review)

A six-angle review of PR #42 found nine correctness bugs; all fixed same
day. The decisions worth keeping:

**Presence verdicts are page-scoped, and the default page is the cited
one.** A homepage fetch says nothing about the article the engines cited,
so checks now default to the domain's most-cited ledger URL, presence
aggregates as "found on ANY successfully checked page" (bool_or), and the
stored explanation says "not found on the N page(s) checked", never "does
not appear on this source". HTML is stripped by the registered html-v1
extractor (entity decoding) — an encoded name must not become an immutable
false absence.

**`measuring` belongs to linkPlacement.** Operators cannot select it, and
outcomes refuse without an intervention_id — otherwise "successful" was
reachable with zero measurement behind it. linkPlacement claims the row
(guarded UPDATE) before creating the intervention, so a double submit
loses the claim instead of minting a duplicate experiment.

**One count for recommendation influence.** Competitor + client
co-occurrence counted the same answer twice and could exceed the
denominator; the stats contract now carries a single distinct-answer
count, making the impossible fraction unrepresentable.

**Subject over is_self, suffix over string-equality, null over stale.**
Run metrics resolve the client via the project's subject (prospect
benchmarks were misreporting); discovery exclusion matches by domain
suffix plus ledger owner-attribution; a domain that vanishes from the
ledger has its ACVS cleared, and path/difficulty edits rescore
immediately — a stored score may never contradict its own row.

**Causal-phrase gates match word boundaries.** "ensures" no longer fires
inside "censures"; hedged sentences containing a listed phrase still
block by design — reword the sentence, not the gate.

## 2026-08-13 — Spec 062: intervention lifecycle + graded comparability (branch feat/062-intervention-lifecycle)

**The lifecycle is observational, not aspirational.** The whole-OS audit's
top finding was that `interventions` had no status at all, while
`citation_opportunities` carried a full validated transition map. Rather
than importing the brief's PROPOSED/APPROVED/IN_PROGRESS pipeline, which
already exists as `tasks`, the intervention's states record what the run
history shows: shipped, retest_pending, blocked (reason required, DB-checked),
retested, cancelled. One backward move exists on purpose: retest_pending →
shipped, because an operator can empty the retest schedule and a row
claiming "pending" with nothing queued would be a standing lie.

**System and human moves are disjoint.** The heartbeat sync only advances
toward what completed runs prove (never unblocks, never cancels); block,
unblock, and cancel are operator actions, transition-validated and
audit-logged. A skipped scheduled retest now blocks the intervention with
the skip reason instead of vanishing into a warn log, and blocked
interventions enter the control-tower queue as their own source.

**Comparability is graded and argued, never stored.** `comparability-v1`
composes facts the runs already carry (scoring versions, prompt-set version,
provider set, models, repetitions, baseline count) into
high/medium/low/not_comparable with one reason per triggered rule, worst
rule wins. It replaces the boolean `instrumentChanged` and contextualizes
verdicts without ever editing them — the same derived-on-read discipline as
verdicts themselves. Report-snapshot period comparability is a separate
read path, deliberately untouched.
## 2026-08-13 — Spec 063: prompt attribute freeze + coverage (branch feat/063-prompt-attribute-freeze)

**Audience and price tier freeze as metadata, not identity.** Same rule as
tier (migration 030): `isSameContent` still compares only text/category/
language, so retagging segments never forces a new version, and no
scoring-version bump is needed because scores don't consume the fields.
Forward-only: pre-063 frozen versions simply lack the attributes and
coverage degrades to category+intent dimensions for those runs. This was
the audit's most time-sensitive gap — every run frozen before this landed
is permanently unsegmentable.

**Coverage is derived on read, counted, and omission-honest.** coverage-v1
reuses the single intent model (commercialIntentWeight at
HIGH_INTENT_THRESHOLD — no second high-intent definition), excludes
holdouts like scoring, respects the latest-mention-revision rule including
reviewed-away mentions (`mentioned = false`), reports counts never bare
percentages, and omits a dimension entirely when nothing is tagged rather
than rendering "unspecified: 100%".

**KPI naming settled in docs/06**: the externally-named "AI Recommendation
Share" is `recommendation_rate`; no separate quantity is to be invented for
the public name.
## 2026-08-13 — Spec 064: gap-finding epistemics (branch feat/064-gap-finding-evidence)

**Epistemic labels became data, not prose.** gap_findings now carries the
platform's four-level classification and a confidence value; deterministic
detectors label counted facts (citation, source_target) as observations and
counted comparisons as supported findings, with working_hypothesis reserved
in the enum for the future LLM enrichment detector. Confidence is one pure
banding over the finding's own denominator (n≥30→0.9, n≥10→0.7, else 0.5):
deterministic arithmetic is certain, sample size is what varies. Legacy
detector-v1 rows stay honestly unlabeled — no backfill invents confidence
that was never computed.

**Evidence refs point at what was actually counted.** Detector v1.1 (scores
byte-identical to v1) emits typed refs: stored score-row ids for the rates a
finding compares, sampled immutable response ids for payload-derived
findings. analyzeRun resolves them into the evidence registry inside the
existing transaction, so a deduped re-analysis creates no orphan rows.

**The placeholder task evidence is gone.** Task promotion previously
attached the run's first score row of any company as "evidence" — it now
reuses the finding's own evidence rows verbatim (suggestTask gained
evidenceIds, existence-verified in-project) and records task_id on the
finding, closing the evidence → finding → task walk in both directions.
The first-score fallback survives only for pre-064 findings.
## 2026-08-13 — Spec 065: QA preflight + dead gates deleted (branch feat/065-qa-preflight)

**One preflight vocabulary, two publish paths.** lib/qa/preflight.ts
(qa-preflight-v1) owns the block/warn check shapes; publishReport and
publishAudit both consume it. Blockers can never be acknowledged away
(missing scoring version, mock responses where policy forbids); warnings
always can, with the acknowledgment recorded in the audit log. The report
page computes the same preflight the action runs, so the operator sees
what they would be acknowledging before clicking publish, not in a
failed-submit toast.

**Source-link liveness is a warning, not a block.** Every prospect-visible
receipt URL is fetched through safeFetch at audit publish; dead links join
the spec-052 acknowledge-with-reason flow. A 404 receipt undermines the
evidence posture, but a transiently-down site must not hard-block an
operator who verified it by hand. The suite never touches the network:
tests/setup.ts sets QA_SOURCE_LINK_CHECKS=off, and tests that exercise the
check inject a stub fetch through an explicit test seam.

**Audit snapshots now stamp their instrument.** instrumentVersions
(scoring + parser versions from the benchmark's own rows) freezes into the
snapshot at publish — the audit found numbers frozen with no record of the
methodology that produced them. Optional field; pre-065 snapshots render
unchanged (presentation-only rule).

**contentQualityGate and publicationGate deleted, not wired.** They shipped
with spec 018 and were never invoked: they assume a publication pipeline
(canonical URLs, analytics tagging, compliance sign-off fields) the
platform does not track, so wiring them would mean permanent
insufficient_evidence theater. The real publication controls are
publishReport's narrative gate + QA preflight, publishAudit's
evidence/warning flow, and lib/content/validate.ts. No quality_gate_results
rows carry the deleted types.
## 2026-08-14 — Spec 066: model agreement read model (branch feat/066-model-agreement)

**Agreement describes, never explains.** model-agreement-v1 turns
per-provider mention/recommendation counts into one labeled read per company
("consensus: recommended", "one assistant only", "assistants disagree") on
the competitors page. Every summary is counted with denominators, and no
causal language leaves the module — whether a pattern is systemic or
platform-shaped is the finding; why is not claimable from this data.

**Precedence is pinned, not vibes.** insufficient → absent →
consensus_recommended → single_provider → divergent (mention-rate spread
≥ 0.35) → consensus_mentioned → majority; first match wins, every edge
unit-tested. The two judgment calls: a consensus recommendation outranks
divergence (the stronger claim carries the row), and a single-provider
presence outranks divergence (one assistant IS maximal spread; the crisper
label wins).

**One-model runs refuse to read as consensus.** Providers with N < 10 (the
docs/06 reporting rule) render their counts but are excluded from the
verdict, and fewer than two sufficient providers labels the row
insufficient — the UI states plainly that a cross-model read needs at least
two providers instead of drawing a one-column table. Derived on read like
head-to-head (spec 036); nothing stored.

## 2026-08-14 — Pre-outreach launch fixes (branch chore/prospects-service-simplify)

**Prompt-echo is one predicate, whole-word.** Four surfaces (prospect
stakes/excerpts, valuable visibility, prospect diagnosis, gap organic rates)
each carried their own copy of "the prompt named this company", all built on
unbounded `ilike '%name%'` — which silently suppressed common-word brands
("Compass" matched "encompassing") and disagreed with the parser's own
word-boundary rule. All four now import `lib/scoring/prompt-echo.ts`:
case-insensitive ARE whole-word/phrase match with metacharacters escaped
(so "RE/MAX (NJ)" matches literally). The gap module's old "skip tokens
≤ 3 chars" mitigation is retired — it existed to blunt substring matching
and made short-named brands classify differently across surfaces.

**The audit page claims completeness only when it is provable.** The
transcript appendix is capped (AUDIT_TRANSCRIPT_CAP = 400, page-weight
bound) and the snapshot now stamps `transcriptTotal`; "every answer is
published" renders only when shown == total, otherwise the pages state
shown-of-total. Legacy snapshots lack the total and never claim
completeness. A falsifiable "all answers" line was one ⌘F away from
destroying the page's trust device.

**Run health gates prospect publishing.** `publishAudit` hard-blocks runs
that are not finished (`running`/`failed`/zero valid captures — never
acknowledgeable) and routes `partial` runs through the existing
disqualifying-warning path: publishable only with a written reason,
recorded in the audit log. `runSummary.promptCount` now counts prompts
with ≥ 1 valid capture (`error is null`), so "we asked N questions" can
never include questions that produced no answer.

**Warning acknowledgment is an operator action, not an env var.** The
publish button now opens a reason dialog when the server refuses with
disqualification signals (dead source link, weak pitch, partial run),
mirroring the report publish controls — previously the only escape was
`QA_SOURCE_LINK_CHECKS=off`, which is not an operator control and skips
the record.

## 2026-08-15 — RealTrends verified-production evidence (branch feat/074-realtrends-authority)

**One signal system, classified — not a parallel ranking database.** RealTrends
records land in `prospect_authority_signals` via `lib/prospects/realtrends.ts`:
migration 074 adds `source_type` ('independent' | 'self_reported' | 'derived')
and a `metadata` jsonb payload (rank, mandatory rank_scope, scope_comparable,
volume, sides, geography, capture date). Independent evidence uses the existing
provenance='verified' factor (1.0 > publicly_sourced 0.85), so "independently
verified outranks self-reported" required no new weights.

**Scope is load-bearing.** A rank never travels without its exact scope:
`formatVerifiedProduction` renders "#N — <scope>" atomically, category pages
carry scope_comparable=false and are excluded from publishAudit's cross-company
rank math (rho, rank callout, comparison column), and mixed scopes filter to
the prospect's own. The Sutherlin/VIP team-size categories could not be
verified from the JS-gated category pages — their records carry no rank claim
until an operator confirms the exact category.

**Derived is displayed, never scored.** avg_deal_value = volume ÷ sides is
stored with source_type='derived' and excluded from the authority profile with
a reason ("never scored twice"); copy calls it "average closed volume per
side", never an average sale/home price. RealTrends labels may not contain the
word "commission" (tested); the page's commission line is now an explicitly
"illustrative estimate at an assumed rate… production volume, not commission
income", demoted below the verified-production block.

**Archetype, not a new score.** prospect-score-v2 adds a named, inspectable
priority archetype (verified_authority_underrepresented: independent
production + rec share ≤5% + a rival ≥15% + fixability ≥30) applied as a
visible ×1.15 multiplier after the composite — weight set untouched, breakdown
still self-explanatory.

## 2026-08-16 — Self-referential URLs come from APP_URL, never the request

The first real login attempt on Railway surfaced it: every redirect the app
issued about itself — magic-link callback landings, the middleware's bounce to
/login — was built from `url.origin` / `request.url`, and behind Railway's
proxy that origin is the container's internal hostname
(`https://98d71eb6ee29:8080`), unreachable from any browser. The operator was
redirected into the void on every sign-in. `publicOrigin()` in lib/env.ts now
prefers APP_URL (already required for outbound audit links) and falls back to
the request origin only for dev, where APP_URL is unset by design. Rule going
forward: any absolute URL the app emits about itself goes through APP_URL.

## 2026-08-16 — The refresh queue prepares; only the click publishes (spec 075)

The weekly baseline now produces fresh prospect-market data with no consumer.
The tempting fix — republish audits automatically — would break PRINCIPLES #8
exactly where it matters most: an audit is an outbound claims document about
a real business. Spec 075 instead builds the autonomy-ladder level-2 shape as
structure: the `audit_refresh_v1` workflow contains no act or human node
because everything it does is preparation (queue rows, generated findings
left `candidate`), and the approval lives in `approveAuditRefresh`, whose
click runs the unchanged `reviewFinding` + `publishAudit` gates. Two
consequences worth recording: candidates carry their preparation errors as
`needs_attention` cards rather than vanishing (a silent skip reads as
"nothing changed"), and the delta computation flags `claimStillTrue: false`
when the prospect now leads the rival — the one situation where republishing
the same pitch would be actively wrong, surfaced before the click instead of
after the send.

## 2026-08-17 — The worker owns the clock; GitHub only watches the door

The GitHub Actions heartbeat (spec 059's stopgap scheduler) took the whole
account over the free Actions tier — a 4-second curl every 10 minutes bills
144 rounded-up minutes a day, and when the quota ran out GitHub silently
refused ALL jobs, including CI and, worse, the ticks themselves: the platform
lost its clock for 20 hours and Monday's weekly kick did not fire. The fix
inverts the dependency: the always-on Railway worker now ticks
`lib/ops/tick.ts` every 10 minutes itself (automation dispatch, weekly kick,
daily connector health — plus notification sync, which had NO production
scheduler at all since launchd retired). The cron routes stay, thinned to
shared-implementation calls, for manual pokes and any future external
scheduler; every tick body was already windowed/idempotent, so two clocks
racing is safe by construction. GitHub's workflow shrinks to the one thing an
external vantage point genuinely does better — noticing the site is down —
every 30 minutes, no CRON_SECRET. Billing amounts to ~50 uptime-minutes a
month instead of ~4,300.

## 2026-08-17 — Branded audit links: the name is cosmetic, the key is the lock (spec 076)

The operator wanted vanity audit URLs for outreach. A guessable
`/audit/<team-name>` would let anyone enumerate names and read competitive
claims about businesses that never consented — the high-entropy token IS the
access control (spec 032) and that does not bend. The shape that keeps both:
`/audit/<slug>/<key>` where the slug is kebab-cased branding and a 16-char
(96-bit) key is the sole credential. Two structural choices worth recording:
the link row points at the PROSPECT, not the audit — so supersede (057) and
refresh (075) keep emailed links alive by construction, and published-row
immutability is never touched; and `revokeAudit` burns branded keys in the
same transaction, because burn-the-link must close every door at once. The
branded routes delegate to the existing `[token]` pages (one renderer, two
front doors) rather than duplicating 900 lines of prospect-facing rendering.
front doors) rather than duplicating 900 lines of prospect-facing rendering.

## 2026-08-17 — The sense-check describes; it never rewrites (spec 077)

The audit QA agent could have been a copy-editor: read the page, return
better wording. It deliberately is not. An agent that suggests replacement
copy becomes the author of prospect-visible text — the exact thing
PRINCIPLES #8 and the prospect-voice rules reserve for humans and the
deterministic template — and its schema therefore has no field that can
carry a rewrite. Binding is by content hash: a concern gates publication
(via the existing acknowledge-with-reason machinery) only when the stored
check read byte-identical content to what is being published; anything
else — stale check, absent check, failed call — degrades to an advisory,
because an assistant that blocks on stale information trains the operator
to bypass it. Failed calls are stored as failures with empty findings:
an absent verdict must never masquerade as a clean one.
## 2026-08-17 — The tick runs weekly baselines for ANY project kind

The worker clock's first production tick exposed dead wiring:
`startWeeklyCycles` serves `kind='client'` only (a cycle is client
machinery), and the standalone /api/cron/weekly-baseline route — the thing
that runs enrolled non-client projects — had had NO caller since launchd
retired on deploy day. The enrolled Jersey City prospect benchmark would
have silently never run. The sweep now lives in lib/ops/tick.ts
(`runWeeklyBaselines`, any kind, ISO-week deduped), called by the worker
tick with the route kept as a thin wrapper. Lesson recorded: when a
scheduler is replaced, enumerate every route the OLD schedulers called —
the one nobody lists is the one that dies quietly.

## 2026-08-17 — Authority evidence scales with its magnitude (spec 078)

Twenty prospects clustered at 35–39 because authority-v1 scored kinds of
receipts at fixed points, magnitude-blind — $219M/#1 and $23M/#3 both
being volume+count+ranking = 35. v1's shape was honest while values were
sparse; with 15/17 volumes and 13/14 rankings now quantified, blindness
became the dishonesty. v2 multiplies kind points by a magnitude factor:
log curves for volume/count/reviews (production is log-distributed),
bands for rank (ordinal), floors so a small quantified fact still beats
no fact — and, deliberately, a MISSING number scores at the floor, never
above a present one, so the incentive always favors recording the real
figure. Anti-stuffing (max-per-kind), provenance discounts, and component
caps are untouched.

## 2026-08-17 — Perplexity finds; the operator verifies (spec 079)

The enrichment adapter could have written what it found straight into
contacts and signals. It stages instead: found ≠ true (spec 027), so an
email is `ai_inferred` until a human approves it and a cited production
figure is `publicly_sourced` — never `verified`, which remains the
spec-074 flow where the operator confirms the source page. Token
efficiency is structural, not aspirational: the question builder returns
null for a fully-known prospect (zero calls), asks only for missing
fields, the sweep skips anything researched within 30 days, and the base
sonar model with a capped output is the default with no silent
escalation. Every call ledgers under prospect-enrichment-v1.

## 2026-08-17 — Discovery finds names; enrichment digs facts (spec 080)

The Perplexity discovery adapter deliberately asks a market-level question
and nothing else — no emails, no production figures. Splitting shallow
discovery (one cheap sweep proposing names into the review queue) from
per-prospect enrichment (spec 079's missing-fields-only research with its
email-validity gate) keeps each call small, keeps garbage out of the
sweep, and means approving a candidate is a cheap decision that never
smuggles unverified facts in with the name. Provenance is ai_inferred at
the envelope level: a search answer that lists a team is a lead about the
team's existence, not a verified fact about anything.

## 2026-08-17 — Timing research rides the same call (spec 081)

Buying-signal research could have been a second Perplexity query per
prospect. It is a SECTION of spec 079's single call instead, appearing
only when signal research is stale — so the one-call-per-prospect
invariant survives, and "fully known" honestly includes knowing what
happened lately. Two smaller judgments: an unsourced development is never
staged (a rumor is not a signal), and the daily tick's sweep needs no
cadence bookkeeping because per-prospect freshness windows already make
it self-limiting — cadence as a property of the data, not a scheduler.
