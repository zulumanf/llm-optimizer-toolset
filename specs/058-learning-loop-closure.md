# Spec 058 — Learning Loop Closure

**Status:** In progress
**Branch:** `feat/058-learning-loop`
**Source:** Architecture gap audit 2026-08-09 (F35/F36/F38, learning §29): the learnings ledger has excellent integrity constraints and **no feedback edge** — nothing in plan composition ever reads it, it lacks the dimensions to retrieve "what happened last time we ran this play for this kind of gap in this market", and it has no UI at all (MCP-only). The second engagement starts exactly as uninformed as the first.

## Why

Spec 051 built the spine (interventions now record `action_outcomes`; learnings already require measured outcomes for strong confidence labels). What's missing is the loop's return path: dimensions that make a learning *retrievable by situation*, a deterministic and versioned way for retrieved learnings to influence play prioritization, and an operator surface so learnings get recorded at all.

## Scope

### A. Dimensions (migration 067)
`learnings` gains nullable `gap_type`, `play_key`, `market_id`, `intervention_id`, `cost_usd`, `scoring_version`, and a required `direction` (`supports` | `cautions`, default supports) — a learning about a play must say which way it cuts. `recordLearning` accepts them and **auto-derives** what it can from the source outcomes (intervention id → its cost; the outcome's gap finding → gap type), so the highest-integrity path is also the lowest-effort one.

### B. Retrieval by situation
`findComparableLearnings({playKey?, gapType?, marketId?, projectId?})` — deterministic filters over active learnings, strongest confidence first. Market filter matches the market **or** cross-market rows; project filter matches the project **or** cross-project rows (a global pattern is evidence everywhere, a local one only locally).

### C. The feedback edge (`learning-adjust-v1`)
`composePlan` retrieves active learnings per candidate play (matching `play_key`, and `gap_type` within the play's gap types or null) and applies a **deterministic, versioned** ranking adjustment: each `confirmed`/`strongly_supported` learning adds `LEARNING_SUPPORT_BONUS` (+10 opportunity points) or subtracts `LEARNING_CAUTION_PENALTY` (−15) per its direction, capped at ±20 — weaker labels annotate but never move rank. The adjustment is *visible*: the item's rationale gains a plain-language sentence ("Measured outcomes from N comparable engagement(s) support prioritising this play." / "…caution against repeating it as-is."), and the plan records `learning-adjust-v1` in its composition. Weights are named constants — changing them is a reviewed diff, per the standing weights rule. Learnings never *add or remove* plays; they re-order and annotate — the play catalog and gates stay the authority on what is possible.

### D. Operator surface (F36)
`/learnings`: list (active first, filterable by category/status), a record dialog carrying the new dimensions, and retire-with-reason. Nothing here can edit a statement — retire-and-rewrite stays the only correction path.

## Out of scope
- ML/statistical weighting of learnings (audit §29: not before enough clean outcomes exist — the counts make that moment visible).
- Auto-recording learnings from verdicts (a learning is a human distillation; the intervention view already links outcomes for the human to cite).
- Prospect-scoring feedback (spec 043's cohort analysis already covers it, advisory-only).

## Acceptance criteria
- [ ] Dimensions persist; strong-confidence derivation fills intervention/cost/gap type from measured outcomes (test).
- [ ] `findComparableLearnings` filters by play/gap/market with global fallbacks (test).
- [ ] A confirmed supporting learning lifts a play above a higher-opportunity rival; a confirmed cautioning learning drops one below a lower-opportunity rival; weak labels change nothing; rationale carries the plain-language sentence; the plan records the adjustment version (tests).
- [ ] Learnings page lists, records (with dimensions), and retires; MCP tools keep working (existing tests green).
- [ ] Migration 067 reversible; `npm test`, lint, typecheck green.
