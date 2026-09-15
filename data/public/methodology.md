# Methodology — v1.0.1

Full text: https://recommendedfirst.com/methodology

1. **Prompts.** Versioned, frozen prompt sets generated deterministically from a market pack (template × area × property type × price tier, city state-qualified). Up to 64 prompts per market; 16 for the Jersey City weekly baseline; 40 and 12 in two early Jersey City pilots.
2. **Instruments.** OpenAI Responses API, model `gpt-5.4-mini-2026-03-17`, web search tool enabled, provider-default sampling; Perplexity API, model `sonar`. Recorded per answer. No consumer-app sessions.
3. **Repetitions.** Each prompt asked separately per assistant; 4 repetitions in market benchmarks (1 in the first pilot).
4. **Capture.** Raw payloads stored immutably before parsing; failed or refused calls recorded as failed and excluded from denominators.
5. **Classification.** Deterministic alias scan → language-model classifier (mention-parser-v2) with confidence; independent verifier below threshold; human review below 0.7; corrections as new revisions. Public counts use the highest VERIFIED revision of each (answer, entity) pair: a human-reviewed row, an explicit verified adjudication row (mention-parser-v3+adjudication), or a classifier row at or above 0.7 confidence with no review flag. Heuristic parser (v1) rows are never counted; they exist where the LLM parser was unavailable. Pairs whose newest classification needs manual review are excluded and disclosed as `blocked_pairs`. Prompts that name the entity are excluded from its counts. Precedence and adjudication rules: `docs/parser_revision_comparison.md`.
6. **Citations.** Extracted from stored payloads (OpenAI `url_citation` annotations; Perplexity `citations` and `search_results`). A domain counts once per answer.
7. **Anonymization.** No names, no answer or prompt text; entity labels per benchmark; agent-owned and single-market domains bucketed; no licensed production fields.
8. **Limitations.** API ≠ consumer app; one capture window per market; our question set, not observed buyer queries; markets chosen for prospecting; provider citation lists partial; no causal claims.
