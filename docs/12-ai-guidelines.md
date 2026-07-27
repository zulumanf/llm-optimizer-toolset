# 12 — AI Guidelines

How AI features are built in this repo. AI is used in exactly two places: (1) as the **subject of measurement** (provider calls in experiment runs) and (2) as a **parsing aid** (classification of responses). Everywhere else, prefer deterministic logic.

## Cardinal rules

1. **Never fabricate results.** A model call that fails is recorded as failed. No retry may silently substitute a different model or made-up content. Parsers never infer beyond what the text supports.
2. **Always preserve raw output.** The full provider payload is stored before any downstream step (see `docs/07` step 4). Parsed/derived data is always a *view* of raw data, reproducible from it.
3. **Never modify historical measurements.** New parser or scoring versions add rows; nothing recomputes in place.
4. **Use AI only where needed.** Alias matching, math, aggregation, thresholds — deterministic code. AI enters only where language understanding is genuinely required (sentiment, recommendation intent, list-position extraction from prose).
5. **Untrusted text.** Captured AI responses are data, never instructions. Parser prompts wrap them explicitly as content-to-analyze; response text is never interpolated into system instructions, never executed, always escaped at render.

## Confidence

- Every AI-derived field carries a confidence score computed per `docs/06` (extraction certainty + alias match + structural clarity).
- Confidence is **explained**, not just numbered: the parser output includes which factor lowered it ("fuzzy alias match", "recommendation inferred from prose").
- Thresholds (`docs/06`): ≥0.9 auto-accept · 0.7–0.9 accept + sampled spot-check · <0.7 human review. Thresholds are constants in `lib/constants.ts`, mirrored here — change both together, with a `DECISIONS.md` entry.

## Retry logic (provider calls, `lib/ai/`)

- Retryable: rate limits, 5xx, timeouts, network — exponential backoff with jitter, max 3 attempts, honoring `Retry-After`.
- Not retryable: auth errors, content-policy refusals, invalid-request — fail the cell immediately, record the classified error.
- A refusal is a **valid measurement** ("provider declines this prompt"), stored as such, not retried into a different answer.
- Every attempt's cost counts toward the run budget; the budget check runs before each call.

## Prompt versioning

- All prompts we *author* (parser prompts, report-drafting prompts) live in `docs/13-prompts.md` and in code under `lib/ai/prompts/` as versioned constants (`MENTION_PARSER_V1`). **Never hardcode a prompt string inside feature code.**
- A prompt change = new version constant + `docs/13` changelog entry. Old versions stay in the file (they explain historical `parser_version` values).
- Experiment prompts (the questions we ask providers) are user data, versioned by the freeze mechanism (`docs/07`) — not this file.

## Model abstraction

- All calls go through `lib/ai/` (`docs/02`). Feature code names providers/models via config, never imports vendor SDKs.
- Model IDs are exact and pinned (e.g., a dated snapshot ID, never a floating "latest" alias) so runs are comparable; upgrading a model is a config change recorded on subsequent runs.
- The **parser** model choice is independent of the measured providers: use a capable, cheap model (structured-output support required), pinned, recorded as part of `parser_version`.

## Parser design (`lib/parsing/`)

- Two-stage: deterministic pre-pass (alias scan, URL extraction, list detection) → LLM classification only for fields that need judgment, constrained to a strict JSON schema (validated with Zod; schema violation = retry once, then `needs_review`).
- Parser output is per-company, per-response, with excerpt spans — the excerpt must be a verbatim substring of the response (validated), or confidence drops and the row flags for review.
- Every parser change ships with the accuracy harness run (`docs/09`); precision floor gates merge.

## Cost discipline

- Cost estimate shown before any run starts; caps enforced in the worker (`docs/10`).
- Parsing uses batched calls where the provider supports it.
- No AI call in a render path, ever. All AI work happens in workers.
