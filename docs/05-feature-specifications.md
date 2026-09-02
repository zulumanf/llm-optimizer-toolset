# 05 — Feature Specifications (Overview)

One section per feature: purpose, user flow, edge cases, acceptance criteria. These are the stable product-level descriptions; the **executable, build-this-now versions live in `specs/`** with schema changes, endpoints, and test cases. When this file and a spec disagree, the spec (newer, more detailed) wins — then update this file.

| Feature | Executable spec |
|---|---|
| Project Management | `specs/001-project-management.md` |
| Prompt Library | `specs/002-prompt-library.md` |
| Experiment Runs | `specs/003-experiment-runs.md` |
| Response Classification & Review | `specs/004-response-classification.md` |
| Competitor Analysis | `specs/005-competitor-analysis.md` |
| Reporting Dashboard | `specs/006-reporting-dashboard.md` |
| Attribution | `specs/007-attribution.md` |

---

## Prompt Manager (Prompt Library)

**Purpose:** author the questions we ask AI assistants, organized into sets that can be frozen into immutable versions for reproducible runs.

**User flow:** create set → add prompts (text, category) → reorder → **Freeze** → set version becomes selectable when starting a run. Editing after freeze changes the working copy only; next freeze = next version.

**Edge cases:** freezing an empty set (blocked); freezing with no changes since last version (blocked, "no changes"); editing a prompt used in past runs (fine — past runs reference the frozen snapshot); deleting a set with versions (archive only).

**Acceptance criteria:** a frozen version's contents are bit-identical forever; every run displays exactly which version it used; diffs between versions viewable.

## Experiment Runs

**Purpose:** execute a frozen prompt set across providers/models with N repetitions, capturing raw responses immutably.

**User flow:** New Run → pick prompt-set version, providers/models, repetitions → cost estimate shown → confirm → progress view (completed/failed cells) → run completes → parsing kicks off automatically.

**Edge cases:** provider outage mid-run (cells fail with recorded errors, run ends `partial`, retry-failed-cells action); duplicate cell protection (idempotent jobs); budget cap exceeded (run pauses, operator decides); cron and manual runs colliding (queue serializes per project).

**Acceptance criteria:** every attempted call has a `responses` row (success or error); no response ever updated after insert; rerun never touches an old run's data.

## Response Classification & Review

**Purpose:** turn raw text into structured mentions (who was mentioned, recommended, at what position, with what sentiment and citations) with confidence, routing uncertain parses to humans.

**User flow:** automatic after each run → Review queue lists `needs_review` mentions with excerpt + highlighted raw response → operator confirms or corrects → correction saved as new revision, original kept.

**Edge cases:** brand alias collisions ("Lumina" vs. an unrelated "Lumina Labs"); answers with no brands at all (valid, counts in denominators); non-English answers; parser version upgrade (re-parse creates new revisions, never overwrites).

**Acceptance criteria:** every mention row carries `parser_version` + `confidence`; below-threshold parses never enter scoring until reviewed; correction history fully visible.

## Competitor Analysis

**Purpose:** the same metrics we compute for the client, computed for tracked competitors, compared.

**User flow:** manage competitor list per project (company + aliases + tier) → dashboard comparison view: share of voice, recommendation rate side by side, per provider, over time.

**Edge cases:** competitor added mid-history (metrics computed from existing raw data retroactively — raw data makes this free); competitor rebrands (alias update, re-parse forward); untracked brands appearing often (surfaced as "unrecognized brands" suggestions).

**Acceptance criteria:** identical methodology for the client and competitors — no metric exists for one and not the other.

## Reports

**Purpose:** immutable point-in-time snapshots for decision-making: scores, deltas vs. previous period, notable excerpts, suggested tasks.

**User flow:** generate draft for a period → operator edits narrative sections (never numbers) → publish → locked forever → shareable/exportable.

**Edge cases:** publishing with unreviewed low-confidence mentions in the period (blocked or explicitly flagged in the report); regenerating a draft after new data (allowed for drafts only).

**Acceptance criteria:** published reports render identically forever; every number links to its underlying scores/responses.

## Evidence & Tasks

**Purpose:** close the loop — findings become concrete work with proof attached.

**User flow:** from any score/mention/report, "Create task" → task drafted with evidence links → human approves → tracked to done → follow-up run measures effect (see `specs/007-attribution.md`).

**Edge cases:** task suggested with zero evidence (blocked); evidence's parent report superseded (task keeps original evidence — it pointed at immutable data).

**Acceptance criteria:** no suggested task without evidence; no task auto-executes anything (`PRINCIPLES.md` #8).

## Audit Refresh Queue

**Purpose:** consume the weekly baseline data flowing for prospect markets — every published audit gets a prepared refresh, and the operator's remaining work is one reviewed click per audit (`specs/075-audit-refresh-queue.md`).

**User flow:** scheduled market run finishes → `audit_refresh_v1` prepares a candidate per published audit (linked run, generated findings, week-over-week delta, dry-run preflight) → operator opens `/prospects/refresh-queue` → reviews the delta and finding, types/edits the required human finding, acknowledges any warnings → Approve & publish republishes through the unchanged `publishAudit` gates to the same token; Hold dismisses for the week.

**Edge cases:** preparation failure becomes a `needs_attention` card, never a silent skip; a claim that flipped (prospect now leads the rival) is flagged loudly before approval; promoted/revoked prospects are excluded and refuse late approval; a newer run supersedes undecided candidates; duplicate event delivery is idempotent per (prospect, run).

**Acceptance criteria:** nothing prospect-visible changes without `approveAuditRefresh` — a named staff click through the full publish gates (`PRINCIPLES.md` #8).

## Branded Audit Links

**Purpose:** the emailed audit URL leads with the prospect's own name instead of 43 characters of noise, without weakening the token-is-the-lock security model (`specs/076-branded-audit-links.md`).

**User flow:** first publication auto-mints `/audit/<name-slug>/<16-char-key>` → copy-link and outreach drafts prefer it → the link follows the prospect's current published audit through supersedes and refreshes → revocation burns branded and legacy doors together.

**Edge cases:** wrong slug + valid key permanently redirects to the canonical slug; valid slug + wrong key is a 404 indistinguishable from any bad token; a burned key never resurrects across republishes; legacy token URLs work forever.

**Acceptance criteria:** the key alone is the credential (96 bits); the slug grants nothing.
**Acceptance criteria:** the key alone is the credential (96 bits); the slug grants nothing.

## Audit Sense-Check

**Purpose:** an LLM second read of the assembled audit — coherence, overreach, numbers, copy, fairness — before a human decides to send it (`specs/077-audit-sense-check.md`).

**User flow:** operator clicks Sense check on the prospect page (or, post-075, it runs during weekly refresh preparation) → concerns render with severity, area, and quoted text → at publish, concern-severity findings on a content-hash-matching check join the acknowledge-with-reason gate; stale or absent checks are advisory only.

**Edge cases:** a failed LLM call stores the failure and fabricates nothing; content changed since the check → advisory "stale check" warning, never a block; quoted assistant answers are data under review, not instructions; polish-severity findings never gate.

**Acceptance criteria:** the agent describes problems and never writes prospect-visible copy; no code path publishes or blocks on its say-so alone (`PRINCIPLES.md` #8).
## Perplexity Enrichment

**Purpose:** find contact emails and independently published production data for prospects via search-grounded research — cited, staged, and operator-approved, never silently trusted (`specs/079-perplexity-enrichment.md`).

**User flow:** Run research on a prospect (or sweep a launch) → ONE Perplexity call asks only for that prospect's missing fields → findings stage as proposals with citations → operator approves (materializes a contact or a properly-provenanced authority signal feeding magnitude-aware scoring) or rejects.

**Edge cases:** fully-known prospect costs zero calls; freshness window stops re-queries; a failed call stores a failure row; emails are `ai_inferred` and signals `publicly_sourced` — never `verified` from research alone (spec 074 owns that); missing API key fails closed.

**Acceptance criteria:** no auto-approval at any confidence; every call in the LLM ledger under the daily ceiling.

## Perplexity Prospect Discovery

**Purpose:** the first real discovery adapter — one search-grounded call proposes a market's notable teams as review candidates (`specs/080-perplexity-discovery.md`).

**User flow:** Prospects → Discover → pick perplexity + segment → candidates stage with citations and `ai_inferred` provenance in the existing review queue → approve to create prospects → run spec-079 enrichment on approved ones for emails/production.

**Edge cases:** a failed sweep is a failed run, never filled in; missing key fails closed; discovery never asks for emails (spec 079's job, with its validity gate); each sweep ledgers under `prospect-discovery-v1`.

**Acceptance criteria:** nothing becomes a prospect without operator approval; the mock stays guarded out of production.

## Buying-Signal Research

**Purpose:** wake the `buyingSignals` score component — Perplexity finds recent developments (brokerage moves, expansions, press) and stages them for approval, telling the operator *when* to reach out (`specs/081-buying-signal-research.md`).

**User flow:** rides the same single enrichment call (a `recentDevelopments` section appears when signal research is >30 days stale) → sourced developments stage as proposals → approval materializes via the existing buying-signals machinery with recency-decayed scoring. The worker's daily tick sweeps active launches; freshness windows make it self-limiting.

**Edge cases:** an unsourced development is a rumor — never staged; unknown kinds map to `other`, surfaced not dropped; undated finds record today as the observation date.

**Acceptance criteria:** approval remains the only path to a signal (`PRINCIPLES.md` #8); still one call per prospect, ever.

## Market-Pack Drafts

**Purpose:** open a new city in minutes — one research call drafts the pack (neighborhoods, brokerages, publications) for review; installing creates the market tree and opens the launch (`specs/082-market-pack-drafts.md`).

**User flow:** Prospects → Draft new market → city + state → review the drafted names with citations → Install & open launch (or Reject) → run discovery (spec 080) for teams → enrichment (079/081) per approved prospect.

**Edge cases:** a draft is never a market until installed; failures store failed drafts; registry packs share the same installer byte-identically; standard prompt templates ride along unchanged.

**Acceptance criteria:** install-through-review is the only path from research to markets.

## Mobile-Responsive Workspace

**Purpose:** the operator's weekly loop works from a phone — sidebar becomes a drawer behind a top bar below lg, same server-rendered nav in both frames (`specs/083-mobile-responsive-workspace.md`).

**User flow:** identical to desktop; at phone width the menu button opens the drawer, navigation closes it, tables scroll horizontally in place.

**Edge cases:** /audit/* keeps zero workspace chrome at every width; desktop layout is pixel-unchanged at lg+.

**Acceptance criteria:** a 390px Playwright fence asserts no horizontal page scroll on the key operator surfaces.

## Score Blurbs

**Purpose:** the prospects table explains each score at a glance — a deterministic one-line rendering of the stored breakdown (`specs/084-score-blurbs.md`): strongest and weakest measured components, what isn't measured yet, and the priority-archetype boost.

**Acceptance criteria:** pure function over the stored breakdown, never a model; legacy rows without a breakdown render no blurb.

## Client Dashboard (The Four Questions)

**Purpose:** the portal overview answers what a client logs in asking (`specs/085-client-dashboard.md`): is it working (hero + delta since baseline); where do I stand vs named rivals; what have you done for me; when do I hear from you next.

**Edge cases:** one run → no delta claimed; no runs → setup message; measurement unconfigured → "measurement paused", never a fake date; every number keeps its sample size.

**Acceptance criteria:** deny-by-default reads unchanged; type-scale and phone fences pass on /portal.

## Assistant Pipeline Operator

**Purpose:** the workspace assistant manages what it starts (`specs/102-assistant-pipeline-operator.md`): list every city pipeline, cancel one, retry a failed one from the status it failed at, view the scheduled-send outbox (scheduled / parked / in-flight), cancel a scheduled send, and run the audit sense-check that `publish_audit` warns about — six thin-wrapper tools on the spec-096 belt.

**User flow:** "what pipelines are running?" → `list_city_pipelines`; a stuck or mistaken one → confirm-gated cancel (an in-flight benchmark run is cancelled too, captured cells kept) or retry (resumes at `failed_from_status`, worker advances next tick). "What's in the outbox?" → `list_scheduled_sends`; a scheduled send is cancelled behind the confirm gate. A stale-sense-check warning on publish → `run_sense_check` (direct tier), then publish.

**Edge cases:** cancelled pipelines are excluded from the tick's query and index and never block a fresh kickoff for the same city; pre-102 failures retry at a status derived from earned refs (run → running, version → benchmarking, launch → discovering, else installing); a worker-claimed send refuses cancellation with a conflict; parked rows keep their reason and in-flight claims are flagged, never auto-retried.

**Acceptance criteria:** cancel/retry/cancel-send are confirm-tier (catalog assertion extended to `cancel_`/`retry_` prefixes); migration 091 is reversible with cancelled rows mapped to failed on the way down.

## Assistant Review Loop

**Purpose:** the assistant decides the staged work it creates (`specs/103-assistant-review-loop.md`): list discovery candidates and a prospect's enrichment proposals, approve/dismiss a candidate, reject a proposal — four thin wrappers completing the loop `run_discovery` and `enrich_prospect` open.

**User flow:** "what's waiting on me?" → `list_discovery_candidates` (pending by default, per launch or overall, compact rows without raw payloads) → confirm-gated `review_discovery_candidate` (approval creates the prospect through the provenance-stamped path; same-name conflicts record duplicate). "What did enrichment find for X?" → `list_enrichment_proposals` (pending/failed only) → `approve_enrichment` or the new confirm-gated `reject_enrichment_proposal` with an optional audited reason.

**Edge cases:** already-decided candidates conflict; ambiguous company resolutions stay suggestions; decided proposals leave the review list by the service's contract.

**Acceptance criteria:** catalog assertion extended to `review_`/`reject_` prefixes; approve and reject round-trip through the confirm gate in integration tests.

## Assistant Run Management

**Purpose:** the assistant manages the benchmark runs it starts (`specs/104-assistant-run-management.md`): confirm-gated `cancel_run` (ends partial/cancelled, captured cells kept, spend stops) and `retry_failed_cells` (partial/completed/failed runs re-enter the worker queue; live spend on retried cells).

**Edge cases:** the services' guards surface verbatim — cancel conflicts unless pending/running; retry conflicts while still executing; a confirmed action that the service refuses is recorded in-thread as failed, never silently dropped.

**Acceptance criteria:** both confirm-tier; mint executes nothing; integration round trips assert run status, the enqueued execute_run job, and the run.cancel / run.retry_failed audit rows.

## Assistant Outreach Spine

**Purpose:** the compliance layer under sending, visible and manageable from chat (`specs/105-assistant-outreach-spine.md`): suppression list (list/suppress/lift), CAN-SPAM sender identity (get/set), outreach sequences (list/stop) — thin wrappers mirroring the existing server actions' `sql.begin` + role-gate shapes.

**Edge cases:** already-suppressed and already-stopped report honestly instead of erroring; lifting is admin-only (a non-admin's confirmed lift records the role failure in-thread and lifts nothing); chat stops are always reason `manual` — `opted_out`/`bounced` stay inbound-signal semantics; sequence rows never include message bodies.

**Acceptance criteria:** all four mutations confirm-tier (catalog regex extended to `suppress_`/`lift_`/`stop_`/`set_`); suppression and sequence round trips through the confirm gate in integration tests.

## Assistant Refresh Queue

**Purpose:** the weekly audit-refresh loop from chat (`specs/106-assistant-refresh-queue.md`): `list_audit_refresh_candidates` (compact rows with delta, preflight counts, and the prior-human-finding pre-fill), `prepare_audit_refresh` (direct — idempotent staging, force for manual-run backfill), and confirm-gated `approve_audit_refresh` (republishes under the same link; requires the human-finding attestation, acknowledge_stale / acknowledge_warnings pass through) and `dismiss_audit_refresh`.

**Edge cases:** needs_attention candidates refuse approval and point at the prospect page; a manual run without force reports notApplicable; a fixture published without a human finding lists a null pre-fill honestly.

**Acceptance criteria:** catalog regex extended to `dismiss_`; approve and dismiss round-trip through the confirm gate against the audit-refresh harness, republish landing on the new run.

## Assistant Catalog Compaction

**Purpose:** the tool catalog stopped growing the per-turn prompt (`specs/107-assistant-catalog-compaction.md`): the system prompt now carries a grouped compact catalog (name, confirm marker, derived first sentence — ~10.0k chars vs ~16.7k before at 64 tools), and full guidance + input shapes moved behind the free `describe_tools` meta-tool (batch up to 8 names).

**Edge cases:** summaries derive from descriptions (`summaryOf`) so they cannot drift; unknown names return `unknown` rows, never a dead step; the self-healing validation shape on a wrong-input attempt remains the alternative to describing first; an 11,000-char ratchet test fails the suite when growth erodes the compaction.

**Acceptance criteria:** every tool mapped to exactly one group (unit-enforced); describe-then-call round trip through the loop; prompt bumped to workspace-assistant-v3 and registered in docs/13.

## Assistant Operator MCP Tools

**Purpose:** the three operator-group MCP tools reach chat (`specs/108-assistant-operator-mcp-tools.md`): `import_prompts` (direct — dry-run-first bulk import of pre-freeze artifacts), `create_experiment` and `record_learning` (confirm — a measurement commitment with future spend, and a durable never-auto-generated learning where the confirm click is the explicit operator act). Schemas imported verbatim from `lib/mcp/schemas.ts`; execution rides `invokeTool`'s existing mutation gates.

## Assistant Prospect Insight Reads

**Purpose:** four cockpit computations reach chat as pure reads (`specs/109-assistant-prospect-insight-reads.md`): `diagnose_prospect` (versioned deterministic rule set), `prospect_timeline` (merged evidence, newest-first with omitted count), `prospect_intent` (null → "not derivable", never a guess), `upcoming_automation` (what the machine does next, per launch or overall).

## Assistant Streaming Progress

**Purpose:** long research chains show what the assistant is doing right now (`specs/110-assistant-streaming-progress.md`): the loop emits tool_start/tool_end/done events, an SSE route streams them, and the dock renders live step lines (spinner → ✓/✗) before the reply. The blocking server action stays as the transparent fallback.

**Edge cases:** an event-callback throw is logged and never fails the turn; the client falls back to the action only when the stream fails before any event arrived (afterwards a retry could run the turn twice — it shows a reconnect hint instead); a client disconnect never cancels the turn server-side.

**Acceptance criteria:** ordered event sequence asserted in integration; no change to loop semantics, tiers, or the confirm gate; the route is a thin adapter over the same service call the action makes.

## Assistant Close the Loop

**Purpose:** both ends of the prospect lifecycle from chat (`specs/111-assistant-close-the-loop.md`): `import_prospects_csv` (direct — ≤200 rows, per-row errors reported, provenance stamped, rows stay behind every downstream gate) and `promote_prospect_to_client` (confirm — the close creates a client project and by default an ACTIVE exclusivity agreement; the summary states whether one is created). Catalog regex extended to `promote_`.

## Assistant Conversation List

**Purpose:** previous chats stop being orphans (`specs/112-assistant-conversation-list.md`): a History control in the dock header lists the operator's own conversations (newest activity first, title + message count + date) and reopens any of them with its messages and pending actions; "New chat" is unchanged, the old thread just stays reachable.

**Edge cases:** own conversations only (ownership as `loadConversation` enforces); switching is blocked while a turn is in flight; loading and empty states present.

## Assistant Analytics Reads

**Purpose:** "analyze X" answers from the sanctioned metric module (`specs/113-assistant-analytics-reads.md`): `outreach_scorecard` (rates/funnel/diagnostic/insights), `outreach_breakdown` (bySegment with n + sample labels), `acquisition_funnel`, `outreach_sends` (compact per-send outcome rows, newest first). Assembly is the dashboard's own `prospectFacts → deriveIntent` glue; null rates pass through as null, never zero.

## Assistant Operator Preferences

**Purpose:** the assistant remembers how you work (`specs/114-assistant-operator-preferences.md`): a per-operator standing-preferences block (≤2000 chars, migration 092) rendered into every turn's prompt with "platform rules and confirmation gates always win"; set/cleared through confirm-gated `set_my_preferences`, read via `get_my_preferences`. Prompt v4 also tells the model to consult `search_learnings` before advising on approach. Preferences are prompt context only — nothing else reads them, so they can never override tiers or gates by construction.

## Assistant Tasks

**Purpose:** delegated multi-step jobs (`specs/115-assistant-tasks.md`): a confirm-gated `create_task` authorizes autonomous read/direct execution toward a goal within hard step and cost budgets; the worker's tick advances tasks through the chat loop's own extracted dispatch (`dispatchToolCall` — one implementation, gates cannot diverge); confirm-tier tools stage task-linked pending actions and park the task until the operator decides; every state change posts into the task's conversation and the dock header shows "Tasks: N running · M need you". `list_tasks`/`get_task` read; `cancel_task` (confirm) also cancels undecided stagings.

**Edge cases:** budgets fail loudly (never a silent partial success); dismissed stagings are instructions, not errors; recursion refused; transcript persists after every step so a crashed tick resumes at the last durable step; cancelled/failed tasks keep their transcripts.
