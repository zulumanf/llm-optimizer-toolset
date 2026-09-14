# Citation outreach playbook

Purpose: get Recommended First's benchmark findings cited by publications that AI assistants already cite, by offering a useful finding first. Nothing here is sent automatically; every pitch is a draft for human approval. No emails are sent from this repository.

## Rules
1. Lead with a finding a reader of that publication would want, with its denominator and date. Never lead with "please add Recommended First".
2. One instrument label: "the OpenAI model (gpt-5.4-mini, web search, API)". Never "ChatGPT" for an API capture; "ChatGPT" only in the consumer sense with the caveat.
3. Offer data, a table or a short methods note; do not offer payment, links exchanges or reviews.
4. Attach only files from `data/public/` and links to canonical pages.
5. No claim of causation, ranking, revenue or lead effects.
6. A pitch is queued only after a person checks the editor/section is real and current (the queue below marks every contact as **needs verification**).
7. Record every send, reply and placement in the citation map (`citation_map_targets`, status pipeline Discovered → Qualified → Contact identified → Pitched → Approved → Live → Indexed → Remeasured) so movement is measured, never assumed.

## Finding menu (from the approved-claims registry, regenerated 2026-09-14; values are provisional until revision 3 is applied to production and the manual-review queue is cleared)
- F1. Across 34 runs in 17 U.S. markets (2026-07-30 to 2026-09-07), the OpenAI model (gpt-5.4-mini, web search, API) named a specific agent or team in 2,124 of 6,290 answers (34%); Perplexity (sonar, API) in 2,130 of 5,216 (41%).
- F2. Citations concentrate on portals: zillow.com appears in 8,748 answers, realtor.com in 7,268, homes.com in 5,145, out of 87,887 answer-domain pairs.
- F3. In every completed market benchmark (256 answers per assistant), the single most-recommended entity appeared in fewer than one OpenAI-model answer in six; between 15 and 22 entities were recommended per market on the OpenAI model.
- F4. Jersey City (2026-08-31, 16 prompts × 4 repetitions × 2 assistants): 102 of 128 answers named someone; 33 entities recommended; a painting contractor's blog was among the most-cited local sources.
- F5. Perplexity attached at least one citation to 5,216 of 5,216 answers; the OpenAI model to 5,901 of 6,290.

## Outreach queue (drafts; no sends)
| # | Publication | Why it fits | Section to target (verify) | Research angle | Specific contribution | Subject line | Supporting URL | Attachment | Approval |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Inman | Agent/broker trade press cited in the corpus's `news` class | Contributor/opinion or Technology desk — **verify current editor** | F1 + F3: assistants name agents in a third of answers, but no one dominates | 600-word methods-first column with the recommendation-rate-by-market table | "In 17 markets, AI assistants named an agent in 34% of answers — here's who they didn't name" | /research/chatgpt-real-estate-visibility-benchmark | benchmark summary CSV | pending |
| 2 | HousingWire | Industry data readership; runs vendor-neutral research pieces | Data/Research or Technology — **verify** | F2: portals capture the citations, brokerage sites rarely do | Table of top-20 cited domains with indexed frequency | "Zillow, Realtor.com and Homes.com are what AI assistants cite when asked for an agent" | /research/ai-citation-sources-real-estate | domains CSV | pending |
| 3 | RISMedia | Broker-owner audience; publishes practical tech guidance | Technology / Marketing — **verify** | F5 + methodology: answers carry citations almost always; the sources are checkable | Methods explainer on reading an AI answer's citations | "Every Perplexity answer about hiring an agent cites sources; here's what they are" | /methodology | none | pending |
| 4 | RealTrends | Rankings publisher; already cited (industry_ranking class) | Research/Rankings desk — **verify; also the licence contact for the dataset question** | Authority vs AI visibility (held until release-gate + licence) | Offer the anonymized contrast once cleared; meanwhile F3 | "Where AI recommendations and verified production disagree — a measured look (data on request)" | /research/real-estate-ai-visibility-index | none until cleared | blocked (licence) |
| 5 | Jersey Digs | Local Jersey City real-estate news; cited in corpus (local_press) | Editor — **verify** | F4 | Jersey City report summary with the local-source table | "What AI assistants say when asked who to hire in Jersey City (128 answers, counted)" | /research/jersey-city-ai-visibility-report | none | pending |
| 6 | NJBIZ | NJ business readership | Real estate beat — **verify** | F4 framed for business readers | Short data note | "AI assistants and Jersey City agents: 33 names in 128 answers" | /research/jersey-city-ai-visibility-report | none | pending |
| 7 | Real Estate News | National agent audience; covers AI search | Technology — **verify** | F1 with the API-vs-consumer caveat | Explainer on why API benchmarks differ from a consumer ChatGPT session | "What an 'AI recommended me' claim should come with: a denominator" | /research/chatgpt-real-estate-visibility-benchmark | benchmark summary CSV | pending |
| 8 | REALTOR® Magazine (NAR) | Member readership; conservative, methods-friendly | Technology / Business — **verify** | Methodology: how to measure without guarantees | Sidebar on definitions (named vs recommended vs cited) | "Named, recommended, cited: three different things an AI answer can do with your name" | /methodology | none | pending |
| 9 | Real Estate NJ | NJ commercial/residential trade | Editor — **verify** | F4 | Data note | "Counted: how AI answers about Jersey City agents cite their sources" | /research/jersey-city-ai-visibility-report | none | pending |
| 10 | The Real Deal | NYC/NJ market news; high scrutiny | Data/Tech — **verify** | F3 concentration finding | Table + one-paragraph methods | "No single agent dominates AI recommendations in any market we measured" | /research/real-estate-ai-recommendation-statistics | benchmark summary CSV | pending |

## Short pitch template (personalize the bracketed parts)
> Subject: [subject line]
>
> [Name], one number from a benchmark we ran that your [section] readers may find useful: [finding with denominator and date]. Method in one line: [instrument], [prompts × repetitions], raw answers stored before classification, counts recounted before publication. Full table and limitations: [URL]. If it is useful, I can share the market-level CSV or a 300-word methods note; no product mention needed.
>
> Francisco Zuluaga, Recommended First

## Pre-send checklist (human)
- [ ] Editor/section verified today; contact URL recorded in the citation map.
- [ ] Finding text matches the registry (`--check` passes).
- [ ] No "ChatGPT" describing an API capture.
- [ ] Attachment is from `data/public/` only.

## Pitch packages (drafts — not sent; every contact needs human verification)

### Inman
- Lead finding: F1 + F3
- Dataset scope: 34 benchmark runs, 6,290 OpenAI-model and 5,216 Perplexity valid answers, corpus through 2026-09-07
- Market: 17 U.S. markets
- Date: 2026-07-30 to 2026-09-07
- Methodology URL: https://recommendedfirst.com/methodology
- Canonical research URL: https://recommendedfirst.com/research/chatgpt-real-estate-visibility-benchmark
- Proposed chart / contribution: recommendation-rate-by-market table (chart: bar per market, one bar per assistant)
- RF disclosure: "Recommended First is a measurement practice for real estate teams; this data comes from its own benchmarks of the OpenAI model (gpt-5.4-mini, web search, API) and Perplexity (sonar, API), not from consumer ChatGPT sessions. No client is named."
- Human approval status: NOT APPROVED — contact and section unverified; numbers provisional until revision 3 is applied to production

### HousingWire
- Lead finding: F2
- Dataset scope: 34 benchmark runs, 6,290 OpenAI-model and 5,216 Perplexity valid answers, corpus through 2026-09-07
- Market: 17 U.S. markets
- Date: 2026-07-30 to 2026-09-07
- Methodology URL: https://recommendedfirst.com/methodology
- Canonical research URL: https://recommendedfirst.com/research/ai-citation-sources-real-estate
- Proposed chart / contribution: top-20 cited domains with indexed frequency (chart: horizontal bars)
- RF disclosure: "Recommended First is a measurement practice for real estate teams; this data comes from its own benchmarks of the OpenAI model (gpt-5.4-mini, web search, API) and Perplexity (sonar, API), not from consumer ChatGPT sessions. No client is named."
- Human approval status: NOT APPROVED — contact and section unverified; numbers provisional until revision 3 is applied to production

### RISMedia
- Lead finding: F5
- Dataset scope: 34 benchmark runs, 6,290 OpenAI-model and 5,216 Perplexity valid answers, corpus through 2026-09-07
- Market: 17 U.S. markets
- Date: 2026-07-30 to 2026-09-07
- Methodology URL: https://recommendedfirst.com/methodology
- Canonical research URL: https://recommendedfirst.com/methodology
- Proposed chart / contribution: methods explainer: how to read an AI answer's citations
- RF disclosure: "Recommended First is a measurement practice for real estate teams; this data comes from its own benchmarks of the OpenAI model (gpt-5.4-mini, web search, API) and Perplexity (sonar, API), not from consumer ChatGPT sessions. No client is named."
- Human approval status: NOT APPROVED — contact and section unverified; numbers provisional until revision 3 is applied to production

### RealTrends
- Lead finding: F3 (authority contrast withheld pending licence + release gate)
- Dataset scope: 34 benchmark runs, 6,290 OpenAI-model and 5,216 Perplexity valid answers, corpus through 2026-09-07
- Market: 5 completed markets
- Date: 2026-07-30 to 2026-09-07
- Methodology URL: https://recommendedfirst.com/methodology
- Canonical research URL: https://recommendedfirst.com/research/real-estate-ai-visibility-index
- Proposed chart / contribution: coverage table from the v0 index page
- RF disclosure: "Recommended First is a measurement practice for real estate teams; this data comes from its own benchmarks of the OpenAI model (gpt-5.4-mini, web search, API) and Perplexity (sonar, API), not from consumer ChatGPT sessions. No client is named."
- Human approval status: NOT APPROVED — contact and section unverified; numbers provisional until revision 3 is applied to production

### Jersey Digs
- Lead finding: F4
- Dataset scope: the Jersey City weekly baseline run of 2026-08-31 (128 valid answers)
- Market: Jersey City, NJ
- Date: 2026-08-31
- Methodology URL: https://recommendedfirst.com/methodology
- Canonical research URL: https://recommendedfirst.com/research/jersey-city-ai-visibility-report
- Proposed chart / contribution: Jersey City local-source table
- RF disclosure: "Recommended First is a measurement practice for real estate teams; this data comes from its own benchmarks of the OpenAI model (gpt-5.4-mini, web search, API) and Perplexity (sonar, API), not from consumer ChatGPT sessions. No client is named."
- Human approval status: NOT APPROVED — contact and section unverified; numbers provisional until revision 3 is applied to production

### NJBIZ
- Lead finding: F4
- Dataset scope: the Jersey City weekly baseline run of 2026-08-31 (128 valid answers)
- Market: Jersey City, NJ
- Date: 2026-08-31
- Methodology URL: https://recommendedfirst.com/methodology
- Canonical research URL: https://recommendedfirst.com/research/jersey-city-ai-visibility-report
- Proposed chart / contribution: one-paragraph data note + table
- RF disclosure: "Recommended First is a measurement practice for real estate teams; this data comes from its own benchmarks of the OpenAI model (gpt-5.4-mini, web search, API) and Perplexity (sonar, API), not from consumer ChatGPT sessions. No client is named."
- Human approval status: NOT APPROVED — contact and section unverified; numbers provisional until revision 3 is applied to production

### Real Estate News
- Lead finding: F1 with API-vs-consumer caveat
- Dataset scope: 34 benchmark runs, 6,290 OpenAI-model and 5,216 Perplexity valid answers, corpus through 2026-09-07
- Market: 17 U.S. markets
- Date: 2026-07-30 to 2026-09-07
- Methodology URL: https://recommendedfirst.com/methodology
- Canonical research URL: https://recommendedfirst.com/research/chatgpt-real-estate-visibility-benchmark
- Proposed chart / contribution: named-agent rate by instrument (chart: two bars)
- RF disclosure: "Recommended First is a measurement practice for real estate teams; this data comes from its own benchmarks of the OpenAI model (gpt-5.4-mini, web search, API) and Perplexity (sonar, API), not from consumer ChatGPT sessions. No client is named."
- Human approval status: NOT APPROVED — contact and section unverified; numbers provisional until revision 3 is applied to production

### REALTOR® Magazine
- Lead finding: definitions (named / recommended / cited)
- Dataset scope: 34 benchmark runs, 6,290 OpenAI-model and 5,216 Perplexity valid answers, corpus through 2026-09-07
- Market: 17 U.S. markets
- Date: 2026-07-30 to 2026-09-07
- Methodology URL: https://recommendedfirst.com/methodology
- Canonical research URL: https://recommendedfirst.com/methodology
- Proposed chart / contribution: sidebar of definitions
- RF disclosure: "Recommended First is a measurement practice for real estate teams; this data comes from its own benchmarks of the OpenAI model (gpt-5.4-mini, web search, API) and Perplexity (sonar, API), not from consumer ChatGPT sessions. No client is named."
- Human approval status: NOT APPROVED — contact and section unverified; numbers provisional until revision 3 is applied to production

### Real Estate NJ
- Lead finding: F4
- Dataset scope: the Jersey City weekly baseline run of 2026-08-31 (128 valid answers)
- Market: Jersey City, NJ
- Date: 2026-08-31
- Methodology URL: https://recommendedfirst.com/methodology
- Canonical research URL: https://recommendedfirst.com/research/jersey-city-ai-visibility-report
- Proposed chart / contribution: data note
- RF disclosure: "Recommended First is a measurement practice for real estate teams; this data comes from its own benchmarks of the OpenAI model (gpt-5.4-mini, web search, API) and Perplexity (sonar, API), not from consumer ChatGPT sessions. No client is named."
- Human approval status: NOT APPROVED — contact and section unverified; numbers provisional until revision 3 is applied to production

### The Real Deal
- Lead finding: F3
- Dataset scope: 34 benchmark runs, 6,290 OpenAI-model and 5,216 Perplexity valid answers, corpus through 2026-09-07
- Market: 5 completed markets
- Date: 2026-07-30 to 2026-09-07
- Methodology URL: https://recommendedfirst.com/methodology
- Canonical research URL: https://recommendedfirst.com/research/real-estate-ai-recommendation-statistics
- Proposed chart / contribution: concentration table
- RF disclosure: "Recommended First is a measurement practice for real estate teams; this data comes from its own benchmarks of the OpenAI model (gpt-5.4-mini, web search, API) and Perplexity (sonar, API), not from consumer ChatGPT sessions. No client is named."
- Human approval status: NOT APPROVED — contact and section unverified; numbers provisional until revision 3 is applied to production
