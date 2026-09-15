# Real Estate AI Visibility Benchmark — public dataset v1.0.1

Aggregate, anonymized counts from Recommended First's benchmarks of how two search-enabled AI assistants answer "who should I hire" questions about real estate agents and teams in 17 U.S. markets, captured 2026-07-30 to 2026-09-07.

Instruments: the OpenAI model (gpt-5.4-mini, web search, API) and Perplexity (sonar, API). These are API captures, not consumer ChatGPT sessions.

Files: `real-estate-ai-visibility-benchmark.csv` (benchmark summary), `-domains.csv` (cited domains), `-entities.csv` (anonymized entities), `.json` (all tables + meta). Field definitions: `data-dictionary.md`. Collection method: `methodology.md`.

Only verified classifications are counted (see `methodology.md` §5 and `blocked_pairs` in the dictionary). No answer text, prompt text, entity names, contacts or licensed production data are included. Entities are labelled per benchmark and cannot be linked across benchmarks. Domains cited in only one market, or owned by a tracked agent/team, are bucketed.

Canonical page and citation format: https://recommendedfirst.com/research/ai-citation-sources-real-estate

Suggested citation: Recommended First. ChatGPT Real Estate Visibility Benchmark: 17 U.S. markets, 2026-07-30 to 2026-09-07, v1.0.1.

Licence: to be confirmed before external distribution (see `docs/external_dataset_submission_checklist.md`).
