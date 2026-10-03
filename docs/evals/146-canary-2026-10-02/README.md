# Spec 146 post-promotion canary — 2026-10-02

`scripts/canary-detect-contradictions.ts`, run against the local test database:

```
env -u OPENAI_API_KEY DATABASE_URL=postgres://localhost:5433/llm_optimizer_test AUTH_MODE=dev \
  CANARY_OUT=docs/evals/146-canary-2026-10-02/canary.json \
  npx tsx scripts/canary-detect-contradictions.ts
```

- `canary.log`: the console output (route, per-run lines, `CANARY_SUMMARY`).
- `canary.json`: every run (workflow run id, `llm_calls` id, backend, model, cost, latency, outcome, validation, reported and expected pairs, `has_error` branch), plus each case's page wording and approved facts for the manual review.

Path exercised: the registered `reputation_profile_correction_v1` version (stored `compare` node: `contextPaths`, `detect-contradictions-v2` pin) → one `workflow_runs` row per case, with `canonical_extract` and `approved_facts` as succeeded `node_runs` → the registered `agt.detect_contradictions` handler (`resolveAgentContext` → `AUTOMATION_PROMPTS` routing → `runAgent` → Ollama `qwen3:30b` → deterministic guard) → the registered `ctl.condition` handler for `has_error`. Nothing after `has_error` runs, and nothing external is called.

Inputs: 20 new cases (not gold fixtures), with fictional subjects. Each was labelled before the run. 11 contain a contradiction and 9 do not. The cases alternate between two projects.

Result: 20/20 correct, 0 false positives, 0 false negatives, 0 validator, schema or runtime failures. Latency: p50 35.5 s, p95 69.0 s, max 77.7 s (warm-up 31.2 s, ungraded). All 20 `llm_calls` rows are `ollama` / `qwen3:30b` / cost 0 / 1 attempt.
