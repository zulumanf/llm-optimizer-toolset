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
