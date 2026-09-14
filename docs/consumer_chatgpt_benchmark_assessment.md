# Consumer ChatGPT benchmark — feasibility assessment (2026-09-14)

## What is measured today
The OpenAI model `gpt-5.4-mini-2026-03-17` through the Responses API with the web search tool enabled and provider-default sampling (`lib/ai/openai.ts`), plus Perplexity `sonar` through its API. Provenance tier B ("search-enabled provider API", `lib/runs/provenance.ts`). All public figures and every prospect-facing count are from this instrument and are labelled "the OpenAI model", never "ChatGPT".

## What is not measured
Any consumer ChatGPT session (web or app), Google AI Overviews / AI Mode, Gemini app, Copilot. The platform has a tier-A path — staff-recorded, clean-session observations (`client_validation_runs` / `client_validation_observations`, collector `chatgpt` / `consumer_web` / `manual_ui`, status `manual_only`) — which never enter scores and are used only for validation exhibits. No consumer observations are included in any public number.

## API versus consumer UI differences
| Dimension | API instrument | Consumer ChatGPT |
|---|---|---|
| Model selection | Fixed id, recorded | Chosen by product; changes without notice |
| Web search | Tool explicitly enabled | Decided by the product per query |
| Personalization / memory | None | Account memory, custom instructions, prior chats |
| Location | None sent | Inferred from IP/account |
| Sampling | Provider default, recorded | Unknown |
| Reproducibility | High (same call, same parameters) | Low |
| Terms | Standard API terms permit automated use | Automated access to the consumer UI is restricted by OpenAI's terms; scraping and account automation risk suspension |

## Feasibility of a browser-based workflow
Technically a Playwright session against chatgpt.com could submit prompts and capture answers. It would require a logged-in account (or logged-out limits), would break on UI changes, would be subject to rate limits and bot detection, and would violate or strain the consumer terms of service. Authentication risks: credential storage, session invalidation, account bans affecting the founder's own account. Reproducibility risks: memory and personalization contaminate every answer unless a fresh account per run is used, which itself conflicts with terms.

## Recommendation
Do **not** build an automated consumer scraper. Instead:
1. Keep tier A as it is: manual, clean-session (temporary chat, memory off, logged-out where possible) observations recorded by staff with screenshot and timestamp, labelled "consumer ChatGPT observation", small N, used for validation only.
2. If a consumer-facing measurement becomes a product requirement, evaluate an officially sanctioned route first (OpenAI's own product APIs or licensed data providers) and record the decision in `DECISIONS.md`.
3. Publish the API/consumer distinction on every benchmark page (done: `INSTRUMENT_NOTE`).

## Cost / complexity if a design spec were authorized
Design-only estimate: 1–2 weeks for a manual-observation UI with protocol enforcement (clean session checklist, screenshot upload, provenance stamping) reusing `client_validation_observations`; ongoing cost is staff time (≈ 2 minutes per observation). An automated scraper is not estimated because it is not recommended.

## Build now or later
Later, and only the manual-protocol UI. Blockers for anything more: terms of service review, a written protocol, and a decision that consumer-session figures are needed for a client deliverable.
