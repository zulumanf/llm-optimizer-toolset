# Spec 146A raw evaluation output (2026-10-02)

These are unedited outputs from the runs recorded in DECISIONS.md ("2026-10-02 — Spec 146A latency diagnosis and `qwen3:30b` reasoning-off retest").

The runs used the following setup:
- **Host:** Apple M5 Max with 36 GB of memory, running Ollama 0.35.0.
- **Model:** `qwen3:30b`, Q4_K_M quantization.
- **Code:** commit `2bbc7fb` plus the uncommitted Spec 146 and 146A working tree.
- **Gold dataset:** `d4c0ec53…`.
- **Paid API:** `OPENAI_API_KEY` was unset.
- **Logging:** eval calls were logged to the local test database (`llm_optimizer_test`).

| File | Command |
|---|---|
| `diag-think-default.csv` | `INTERNAL_EVAL_MODEL=qwen3:30b DIAG_REPS=2 DIAG_COLD_START=1 npx tsx scripts/diagnose-detect-contradictions-latency.ts` |
| `diag-think-false.csv` | the same, with `DIAG_THINK=false` |
| `eval-qwen3-30b-think-false.log` / `.json` | `INTERNAL_EVAL_MODEL=qwen3:30b EVAL_THINK=false EVAL_OUT=… npx tsx scripts/eval-detect-contradictions-internal.ts` (holdout split, 3 repetitions). **FAIL.** |
| `eval-qwen3-30b-think-default.log` / `.json` | the same, with `EVAL_THINK` unset, so reasoning on. This is the final promotion evaluation, started 21:46 UTC. **PASS.** `qwen3:30b` was the only resident model. The Mac was on battery (52% → 14%), with no thermal warnings. |

Every command ran with `DATABASE_URL=postgres://localhost:5433/llm_optimizer_test` and `npx tsx --tsconfig tsconfig.json`.
