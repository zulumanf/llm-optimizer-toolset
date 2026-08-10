# Spec 055 — Model Routing Tiers

**Status:** In progress
**Branch:** `feat/055-model-routing`
**Source:** Architecture gap audit 2026-08-09 (cost A2/A4/A5): "there is no routing layer — two hardcoded tiers and a default that lands on frontier." 16 of 19 automation agents ran the flagship model, including narrow summarize/repurpose/extract tasks the audit named as cheap-tier work, while the false-economy warning (A5) cuts the other way: client-facing judgment must not silently drift down-tier.

## Why

Which model runs a task is a routing decision that was scattered across a default parameter and per-call constants. Nothing declared *why* a task deserves frontier spend, nothing made a downgrade (or upgrade) reviewable as policy, and an unrouted new task silently inherited the most expensive model in the fleet.

## Design

**One table, in code, fail-closed.** `lib/ai/routing.ts` declares `TASK_ROUTES`: every recurring LLM task → `{tier, rationale}`, `ROUTING_VERSION` stamped. Tiers resolve to the existing model constants (cheap → `CLASSIFIER_MODEL`, frontier → `AGENT_MODEL`) so a model bump stays a one-line change. `modelForTask(task)` **throws on an unknown task** — a new LLM task cannot ship without an explicit, rationale-carrying routing decision in a diff. Routing changes are policy changes and belong in code review, not config (the repo's standing rule).

**Routed down per the audit (A4):** `summarize_meeting`, `draft_meeting_followup`, `repurpose_content`, `extract_claims` (both the automation prompt and the knowledge-extraction pipeline — narrow extraction, human-approved downstream), `prioritize_authority_actions` (the ranking is deterministic; the agent only explains it), joining the three already-cheap classifiers. **Kept frontier with rationale (A5):** everything client-facing or judgment-heavy — content drafting/verification, adversarial review, accuracy analysis, contradiction detection, outreach drafting, executive reporting.

**Wiring:** the automation prompt registry loses its frontier default — every prompt passes `modelForTask(key)` explicitly; `classify-llm`, the accuracy analyzer, and the knowledge claim extractor route through the table. The instrument stamps (mentions.classifier_model, classifier evaluations — spec 050) record the *routed* model, so a routing change is visible in provenance, and the llm_calls ledger already records model per call.

## Out of scope
- A local/self-hosted tier (T1) — no local model exists; the table adds a tier value when one does.
- Per-client or per-project routing overrides — no use case yet.
- Automation `agent_versions` re-registration mechanics — versions carry the model at registration; existing behavior unchanged.

## Acceptance criteria
- [ ] `modelForTask` resolves every declared task and throws on unknown tasks (test).
- [ ] Every routed model is priced — `costMicroUsd` does not throw for any route (test).
- [ ] The five audit-named downgrades are cheap-tier; mention classification/verification are cheap; content/adversarial/accuracy stay frontier (pinned test — changing a route means changing this test in the same diff).
- [ ] No automation prompt relies on an implicit model default (compile-time: the default parameter is gone).
- [ ] Classifier instrument stamps record the routed model (existing 050 tests stay green).
- [ ] `npm test`, lint, typecheck green.
