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

## Phase 2 — Close the learning loop (partials that already have tables)

1. Wire `composePlan`/`approvePlan` (spec 026) to an entry point — the recommendation surface exists and is tested but unreachable.
2. Schedule `measureAction` (spec 019) so `action_outcomes` stop parking at `insufficient_measurement`; then the "which actions work" question becomes answerable.
3. Add `hypothesis` to `interventions`; consider a lightweight control-arm convention (holdout prompts already exist).
4. Cross-project learnings store (module L of the target design): a `learnings` table with confidence labels, fed from labeled `action_outcomes`; MCP read tools `search_learnings` / `record_learning` (record approval-gated).

## Phase 3 — Prompt intelligence (module B)

Import pipelines (CSV/manual sources first), clustering, intent classification of operator-written prompts — LLM-assisted only with a validation set per `docs/12-ai-guidelines.md`; no fabricated demand numbers (no search-volume claims without a legitimate source).

## Phase 4 — Deeper competitive/citation analysis

Win-rate / head-to-head metrics; overtake detection beyond `mention_rate`; citation-profile comparison per competitor (`compare_citation_profiles`); wiring spec 027 external discovery to a real entry point (after the Phase 1 SSRF fix).

## Phase 5 — Controlled external execution (only after operator decisions)

Blocked on: the spec-011 vs migration-020 send-path contradiction (operator decision recorded as needed in DECISIONS.md), live connector credentials + a connection-creation path, and hosted deployment. Until then, drafting is in-platform and publishing/sending stays human-executed with in-platform recording — which is a feature, not a gap.

## Explicitly rejected (do not build)

Three separate MCP services at this scale · a graph database for citations · autonomous community posting / mass messaging / undisclosed promotion (PRINCIPLES) · a proprietary composite score without published formula · search-volume integration without a legitimate licensed source.
