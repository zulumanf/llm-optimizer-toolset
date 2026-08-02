# AI Visibility Intelligence — Roadmap

> Sequenced continuation of the 2026-08-01 audit (`docs/ai-visibility-system-audit.md`). Phase 0 shipped with spec 033. Each later phase should get its own spec before code (CLAUDE.md rule). This roadmap coexists with `docs/pilot-launch-plan.md` (pilot P0s) — pilot correctness fixes always outrank new capability.

## Phase 0 — MCP interface (shipped, spec 033)

One stdio server, 13 read tools + 2 gated mutating tools, invocation ledger (migration 039). No external actions.

## Phase 1 — Correctness and security debt named by the audit (shipped 2026-08-01, `fix/visibility-audit-phase-1`)

1. ✅ Evidence exports now stamp the parser version(s) read from the run's own classification rows (`manifest.parserVersions`); the deprecated `PARSER_VERSION` constant is deleted.
2. ✅ SSRF: all operator/discovery URL fetching goes through `lib/security/safe-fetch.ts` — manual redirects with per-hop host validation, DNS resolution check (disabled under vitest, unit-tested via injected resolver), streaming size caps. Robots.txt fetches follow redirects manually too. Residual: resolve-then-connect TOCTOU race, documented in the module.
3. ✅ Claim-extraction prompts carry the "data, not instructions" framing and neutralize embedded fence markers.
4. ✅ `PROVIDER_TIMEOUT_MS` (180s) on all four benchmark provider clients; timeouts classify as retryable. (Instrument-settings capture: nothing to record — no adapter sets temperature/top_p/seed; revisit if one ever does.)
5. ✅ Drill-down re-derivation for `first_position_rate` / `top_three_rate` — every v1.1 metric is now independently re-derivable.

## Phase 2 — Close the learning loop (shipped 2026-08-02, spec 034, `feat/034-learning-loop` line)

1. ✅ `composePlan`/`approvePlan` reachable from the plan page (compose / re-compose-supersede / approve buttons; service untouched).
2. ✅ Outcome measurement sweep rides the automation heartbeat (`lib/outcomes/sweep.ts`): due actions measured against nearest same-scoring-version runs (mention_rate + owned-citation count), overlap → `confounded`, no comparable data → waits, then settles `insufficient_measurement` after 60 days' grace. Traffic/leads/pipeline stay null — no data source exists.
3. ✅ `interventions.hypothesis` (migration 040) through service, form, detail page, and `create_experiment`. Control-arm convention: still open (holdout prompts exist).
4. ✅ `learnings` table (migration 040) + `lib/learnings/service.ts` + MCP `search_learnings` / `record_learning` (17 tools). `confirmed`-class labels require measured source outcomes; learnings retire with a reason, never edit.

## Phase 3 — Prompt intelligence (deterministic slice shipped 2026-08-02, spec 035)

1. ✅ Bulk import (paste lines / header-mapped CSV) with per-row rejects, batch + existing-row dedupe, provenance (`prompts.source`, migration 043), UI dialog, and MCP `import_prompts`.
2. ✅ Deterministic intent classifier (`prompt-classifier-v1+deterministic`): rule-based category+tier suggestions, brand-aware via the project registry; unmatched prompts are rejected, never guessed. The hand-labeled fixture set doubles as the seed validation set for a future LLM v2.
3. ✅ Deterministic clusterer (`prompt-cluster-v1+deterministic`): category + salient-term grouping, computed on read; set-page section and MCP `get_prompt_clusters` (19 tools).
4. Still open (deliberately): LLM classifier v2 (needs the validation set grown in use), external prompt sources (Reddit/PAA/keyword tools), demand estimation (**no legitimate source — will not fabricate**).

## Phase 4 — Deeper competitive/citation analysis (shipped 2026-08-02, spec 036)

1. ✅ Head-to-head win rates (`head-to-head-v1`): per-response contests vs each competitor, derived on read (never a `scores` row), with losing-prompt lists; unranked co-mention is a tie; null win rate when uncontested. UI section + MCP `get_head_to_head`.
2. ✅ Citation-profile comparison (`citation-profile-v1`): domains cited in answers recommending each company, labeled from the sources registry, with per-competitor source gaps. UI section + MCP `compare_citation_profiles` (21 tools).
3. ✅ (Already closed earlier, spec-030 note was stale — reconciled): overtake detection covers both `MOVEMENT_METRICS`, not just mention_rate.
4. Still open: wiring spec-027 external discovery to a product entry point (service is complete and SSRF-hardened; needs a job type + button, and its search instrument uses the live-verified OpenAI `+search` model).

## Phase 5 — Controlled external execution (only after operator decisions)

Blocked on: the spec-011 vs migration-020 send-path contradiction (operator decision recorded as needed in DECISIONS.md), live connector credentials + a connection-creation path, and hosted deployment. Until then, drafting is in-platform and publishing/sending stays human-executed with in-platform recording — which is a feature, not a gap.

## Explicitly rejected (do not build)

Three separate MCP services at this scale · a graph database for citations · autonomous community posting / mass messaging / undisclosed promotion (PRINCIPLES) · a proprietary composite score without published formula · search-volume integration without a legitimate licensed source.
