# Spec 117 — Benchmark capture cost efficiency

## Why

The 2026-08-24/25 city expansion exhausted an OpenAI top-up twice, once
mid-run (integrity fallout: spec-116 context). Diagnosis from the ledger:
890 search-enabled capture calls in 26h, avg 8.4k input tokens each, plus a
per-call web-search fee our cost model explicitly does not count
(pricing.ts caveat) — so every budget cap and estimate undercounts real
spend. Call COUNT is methodology (64 prompts × reps × providers, one fresh
conversation per call) and is not reduced here; PRICE per call is waste.

## What

1. **Honest cost model** — `ModelPricing.perCallFeeMicroUsd` (optional):
   flat per-call fee added by `costMicroUsd`. Set on both `+search` OpenAI
   entries at $0.01/call, flagged ESTIMATE until verified against the
   OpenAI billing dashboard (operator step; update the constant + set
   `verified` when read).
2. **Flex service tier** — capture calls send `service_tier` from
   `OPENAI_CAPTURE_SERVICE_TIER` (default `flex`, ~50% token discount,
   slower). Applies ONLY to the benchmark capture path (`runPrompt`);
   latency is irrelevant there. Timeout ×3 for flex. Same model, same
   sampling — output distribution unchanged, so NOT a methodology change.
   Set the env to `default` to fall back instantly if a model/tier combo is
   rejected.
3. **Search context size** — the web_search tool passes
   `search_context_size` from `OPENAI_SEARCH_CONTEXT_SIZE` when set.
   UNSET by default: retrieval depth shapes answers, so this IS a
   methodology change — adopt only after an A/B run comparing scored
   metrics at `low` vs default on one market.
4. **Pre-flight quota probe** — `executeRun` makes one ~1-token real call
   per OpenAI-bearing run before executing cells; on a quota/billing
   refusal the run is marked failed/partial with a `preflight` detail and
   NO cells are attempted. Mid-run exhaustion (the 354/512 incident) is
   the most expensive failure mode this platform has hit.
5. **Repetition stability analysis** (read-only, `scripts/rep-stability.ts`)
   — from completed 4-rep runs, per-company recommendation/mention rates at
   rep subsets {1..2} and {1..3} vs all 4. If 3-rep rates track 4-rep
   within tolerance, a follow-up spec may drop OpenAI reps to 3 (−25% of
   the dominant cost). Analysis first; no methodology change here.

## Acceptance

- costMicroUsd adds the per-call fee for `+search` models (unit test).
- Capture calls carry the service tier; probe verified by code review +
  first live run.
- tsc + lint + tests clean.
