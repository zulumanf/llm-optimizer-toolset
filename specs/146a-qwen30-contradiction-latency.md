# Spec 146A — `qwen3:30b` Contradiction Latency

> **Status:** complete (2026-10-02). `qwen3:30b` with reasoning on passes every Spec 146 §8 gate under the warm-latency rule (warm p95 41.8 s). Reasoning off was rejected. Production routing is unchanged; the Spec 146 §10 change is next.
>
> **Parent:** Spec 146 (`detect_contradictions` open-weight migration).
>
> **Scope:** find out why `qwen3:30b` misses the Spec 146 §8 latency gate, and evaluate legitimate runtime and inference changes that could bring it under the gate. Nothing in this spec promotes a model or changes a production route. Spec 146's contract, quality semantics, gold dataset and gates are inputs to this spec, not things it may change.

## 1. Why this exists

In the Phase 1 holdout eval (recorded in DECISIONS.md, 2026-10-02), `qwen3:30b` passed every quality gate: critical 33/33; overall, recall, consistency and severity 100%; false positives 0%; no runtime, schema or validator failures. It failed one gate. Its p95 latency was 63.7 s against the §8 limit of p95 ≤ 60 s (p50 22.9 s).

The gap between p50 and p95 is large. That points to a few calls taking much longer than the rest, not to the model being slow across the board. The likely causes are all measurable:

1. **Hidden reasoning tokens.** `qwen3` models reason before they answer by default. Ollama returns that reasoning in a separate `thinking` stream. It costs generation time but is not part of the JSON answer.
2. **Prompt evaluation.** The `approvedFacts` context is the full evidence-packet node output, so long fixtures (for example `a5_buried`) mean a large prompt.
3. **Model load.** A model that has been unloaded must be read back into memory before its first call.
4. **The schema retry.** A first answer that fails validation doubles that call's time.

## 2. Gates and semantics that do not change

These are fixed by Spec 146. This spec may not change them:
- every §8 gate, including **p95 ≤ 60 s per call** and no call reaching the 300 s node timeout;
- the §2 contradiction contract, the v2 prompt text, the v2 schema, the deterministic validator and the grader;
- the 40 gold fixtures, their labels, their dev/holdout split and `GOLD_DATASET_SHA256`;
- the §3 input contract: the model receives exactly `{ context: { observedClaims, approvedFacts }, parameters }`, with no trimming, summarizing or reordering;
- the single schema retry in `runAgent`;
- production routing: `detect_contradictions` stays on its current route.

Latency is measured on the **same** graded runs that measure quality: every holdout fixture, 3 repetitions. Results may not come from a subset of fixtures, or from runs without the validator.

## 3. What may be tuned

**A. Reasoning mode (`think`).** Every internal inference request may carry an optional `think` flag through the provider-neutral contract (`InternalInferenceRequest.think`). The Ollama backend sends it as Ollama's `think` field. Backends without a reasoning switch ignore it. When the flag is left out, the request body is byte-for-byte what it was before this spec. Turning reasoning off changes how the model decodes, so `think: false` counts as a **different candidate configuration**. It must pass every Spec 146 §8 gate again on its own; it does not inherit the default configuration's quality results.

**B. Host runtime settings.** These are Ollama server and host settings, not code:
- `OLLAMA_KEEP_ALIVE`;
- `OLLAMA_FLASH_ATTENTION`;
- KV-cache type;
- `OLLAMA_NUM_PARALLEL`;
- `OLLAMA_MAX_LOADED_MODELS`;
- available memory.

Any configuration that passes must record the settings it was measured under in DECISIONS.md, because production has to reproduce them.

**Not allowed under this spec** (each would need its own spec): trimming or reshaping the context, a `num_predict` cap or any other output truncation, changing the prompt or schema, pulling a new model or quantization, or falling back to another model.

## 4. Measurement protocol

- **Evaluator** (`scripts/eval-detect-contradictions-internal.ts`, Spec 146 §9). It runs one **ungraded** warm-up call before the graded runs, so that the model's load time is not counted as one graded call's inference time. Graded runs are what §8's p95 is computed over. `EVAL_THINK` (unset, `true` or `false`) selects the reasoning configuration under test. The evaluator prints it with every result and includes it in `EVAL_SUMMARY` and `EVAL_OUT`. The evaluator does no latency breakdown and manages no model residency.
- **The latency gate measures warm, steady-state inference.** The operator accepted this on 2026-10-02. The production deployment for the selected model keeps it resident, so the model is already loaded when it answers a production call. The §8 p95 ≤ 60 s gate is therefore computed over warm graded calls, after the ungraded warm-up. The 60 s threshold itself does not change.
- **Cold start** is reported separately, by the diagnostic. Any configuration proposed for promotion records its cold-start time. That time must stay well under the 300 s node timeout, which still covers a cold load after a host restart or eviction.
- **Diagnostic** (`scripts/diagnose-detect-contradictions-latency.ts`). It is tooling only, and it grades and decides nothing. It sends the **same** request as production, through the production Ollama caller (`ollamaCaller`), with the same response schema (`responseSchemaFor`). It prints each call's breakdown:
  - wall time;
  - backend total, model load, prompt-evaluation and generation time;
  - input and output tokens and tokens per second;
  - the size of the hidden reasoning text and of the answer.

  Optionally, it unloads the model first and times the cold-start call. Unloading is a model-residency operation with no provider-neutral equivalent, so it is the one direct Ollama request, and it lives only in this script.

## 5. Code changes

- **`lib/ai/internal-inference.ts`:** adds the optional `think` field to requests, and an optional `timings` field to results (`loadMs`, `promptEvalMs`, `generationMs`, `reasoningChars`), reported when the backend exposes them. Both are provider-neutral and optional.
- **`lib/ai/internal/ollama.ts`:**
  - sends `think` only when it is set;
  - fills in `timings` from Ollama's response (`load_duration`, `prompt_eval_duration`, `eval_duration`, `message.thinking`);
  - exports `ollamaBaseUrl()`, so tooling resolves `OLLAMA_URL` the same way the caller does.
- **`lib/ai/agent.ts`:**
  - `runAgent` passes `think` through only when it is set;
  - `responseSchemaFor(schema)` is exported, so tooling uses exactly the JSON schema `runAgent` sends.

  `runAgent`'s result, retry behavior and ledger record are unchanged.
- **Scripts:** the evaluator and the diagnostic, as described in §4.

No production caller sets `think`, and no route, prompt or workflow changes.

## 6. Outcome and hand-off

- A configuration counts as passing only when the evaluator, run over the full holdout split with 3 repetitions, prints `RESULT: PASS` with every §8 gate passing, including p95 ≤ 60 s. That result is recorded in DECISIONS.md together with its `think` value, the host settings and the cold-start time.
- If one passes, Spec 146 §10 is still a separate reviewed change. That change must pin the passing configuration in the route: the route target gains the `think` value. This spec does not make that change.
- If none passes, the outcome is recorded and `detect_contradictions` stays where it is. The next options (another model, quantization, context shaping) each need their own spec.

## Acceptance Criteria
- [x] `think` is optional, provider-neutral and leaves requests unchanged when omitted (unit-tested).
- [x] Ollama timings are reported in the result without changing the request (unit-tested).
- [x] The diagnostic uses the production Ollama caller and `responseSchemaFor`; its only direct Ollama request is the model unload.
- [x] The evaluator has no Ollama-specific code; it carries the configuration under test (`think`) and is otherwise the Spec 146 evaluator.
- [x] Diagnostic results for `qwen3:30b`, with reasoning on and off, are recorded in DECISIONS.md. (2026-10-02; raw output in `docs/evals/146a-2026-10-02/`.)
- [x] A full holdout evaluator run for each configuration tried is recorded in DECISIONS.md, with PASS or FAIL against the unchanged §8 gates.
  - Reasoning off: **FAIL**, recorded 2026-10-02. Latency passed easily (p95 4.2 s), but critical cases 3, 4 and 5 failed on false positives.
  - Reasoning on (the model default): **PASS**, recorded 2026-10-02. Every §8 gate passed, with warm p95 41.8 s and max 43.1 s. The earlier operator-reported p95 of 63.7 s was not reproduced.

## Findings (2026-10-02)
- **The long tail comes from hidden reasoning, not from the prompt or the runtime.**
  - With reasoning on, generation is about 98% of each call (p50 21.9 s, p95 36.8 s).
  - Output is 1,949 tokens at p50 and 3,111 at p95. Nearly all of it is the hidden `thinking` stream (p50 7.0k characters) rather than the JSON answer (p50 0.4k characters).
  - Reasoning length varies from run to run on the same fixture: `s3` took 12.8 s on one call and 33.1 s on another, even at temperature 0.
  - Prompt evaluation is at most 2.1 s, model load is negligible once warm, and generation speed is steady at about 75–100 tokens/s.
- **Turning reasoning off removes the tail** (p50 2.1 s, p95 4.4 s; 178 output tokens at p50), **but it also removes the judgment the contract depends on.** In the holdout eval it reported compatible detail, different periods and different subjects as contradictions.
- **Reasoning off is not a viable configuration under Spec 146.** Any remaining latency work has to keep reasoning on.
- [x] No change to gates, labels, the dataset hash, the prompt, the schema, the validator, the grader or production routing.
- [x] Typecheck, lint, the full unit suite and `git diff --check` pass.

## Files Expected To Change
- `lib/ai/internal-inference.ts`, `lib/ai/internal/ollama.ts`, `lib/ai/agent.ts`.
- `scripts/eval-detect-contradictions-internal.ts`, `scripts/diagnose-detect-contradictions-latency.ts`.
- `tests/unit/ollama-think-option.test.ts`.
- `DECISIONS.md` (results), and Spec 146 (cross-reference).

> **UNRESOLVED QUESTIONS:** none
