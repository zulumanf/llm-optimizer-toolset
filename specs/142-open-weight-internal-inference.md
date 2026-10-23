# Spec 142 — Open-Weight Internal Inference

## Goal

Allow AI Visibility OS to use self-hosted/open-weight models for internal AI work without changing the provider layer used to measure external AI visibility.

## Architectural boundary

Two AI concepts must remain separate:

1. Measurement providers
   - OpenAI
   - Anthropic
   - Google
   - Perplexity
   - Used to measure what external AI systems say.

2. Internal inference
   - OpenAI initially
   - Ollama/local open-weight models
   - Future remote open-weight inference servers
   - Used for classification, analysis, drafting, planning, and QA.

A local model must never accidentally appear as a benchmark measurement provider.

## Phase 1

Introduce a provider-neutral internal inference contract while preserving all existing runtime behavior.

Acceptance criteria:

- Existing `AgentCaller` call sites continue to compile unchanged.
- OpenAI remains the default internal inference backend.
- Benchmark provider registry is unchanged.
- Typecheck passes.
- Lint passes.

## Phase 2

Add an Ollama internal inference backend.

Acceptance criteria:

- Ollama is implemented behind `InternalInferenceCaller`.
- Ollama URL is configurable and defaults to localhost.
- Model is explicitly identified on every call.
- Structured JSON output is supported.
- Token counts are returned when Ollama supplies them.
- Connection/model failures are explicit.
- No benchmark provider behavior changes.
- No task is migrated to Ollama merely by adding the backend.

## Phase 3

Add explicit internal model routing.

Initial intended roles:

- cheap internal classification/extraction: `qwen3:8b`
- internal reasoning/planning: `qwen3:30b`
- independent QA: `gpt-oss:20b`

Routing must remain fail-closed and reviewable.

## Phase 4

Migrate one low-risk task and evaluate it against the current OpenAI baseline before migrating additional tasks.

Initial candidate:
- `summarize_meeting`

The evaluation must compare at minimum:

- schema compliance
- task correctness
- latency
- token usage
- failure rate

A local model does not replace the existing model unless the evaluation passes.

## Non-goals

- Do not replace OpenAI/Anthropic/Google/Perplexity benchmark instruments.
- Do not bulk-migrate all agents.
- Do not silently fall back between models.
- Do not treat local inference as free compute without recording provenance.
- Do not merge FranciscoOS and AI Visibility into one runtime.

## Safety

Independent QA should not use the same model instance/family as the creator when a suitable independent model is available.

Every internal inference result must retain model/backend provenance.
