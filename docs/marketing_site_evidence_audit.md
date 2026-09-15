# Marketing Site Evidence Audit — recommendedfirst.com

Date: 2026-09-13, revised 2026-09-14 (see Change log at the end). Data pulled from the production database; T1 refresh runs dated 2026-09-14 UTC are excluded from every figure.
Scope: what the public site may claim, with denominators; what it must not; and the crawlability / citation-readiness work shipped alongside this document.
Machine-readable companion: `lib/marketing/approved-claims.json` (verified by `npx tsx scripts/marketing-claims-verify.ts --check`).

Conventions used throughout:
- **Instrument labels.** "OpenAI model (gpt-5.4-mini-2026-03-17, web search tool, Responses API)" and "Perplexity (sonar, API)". Never "ChatGPT" for an API capture (`lib/prospects/terminology.ts`, enforced in `report-handoff.ts`).
- **Answer** = one valid captured response (`responses.error is null`, not refused). Failed calls are excluded from denominators and reported as coverage.
- **Recommendation** = classifier judged "use/contact this entity" (`mention-parser-v2+llm`, confidence < 0.7 → verifier → human review). One credit per answer. Prompts that name the entity are excluded (echo rule).
- **Answer-domain pair** = one answer citing one domain at least once (dedup inside an answer).
- **Needs source verification** = value not derivable from the repo/DB, or derivable but gated on a human check listed next to it.

---

## Part 1 — Evidence for the marketing site

### 1. Benchmark inventory

Only real-estate market benchmarks on the two production instruments are listed. QA fixture runs (labels `QA131…`, `QA134…`, provider `qa-fixture`/`mock`), the July Gemini 2.5 Flash trial (20 valid of 73, provider `google`), and the non-real-estate "Parva Core" project are excluded from all public aggregates.

Common facts for every run below unless stated: prompt category `recommendation` only; 4 repetitions per provider (`runs.providers[].repetitions = 4`; `responses.repetition` 1..4); sampling = provider default (never set; recorded as `request_params.sampling = "provider_default"`); raw payload immutable (`responses_immutable` trigger); classifier `mention-parser-v2+llm`; citations extracted from raw payload (`lib/ai/citations.ts`).

| # | Benchmark (run label) | Market | Captured | Instruments | Prompts | Reps | Possible answers | Valid | Excluded | Production data | Rec. credits* | Distinct entities rec. | Answer-domain pairs / domains | Confidence | Publishable? | Cannot be claimed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Weekly baseline 2026-08-31 (`99af19b4`) | Jersey City, NJ | 2026-08-31 | OpenAI + Perplexity | 16 | 4 | 128 | 128 | 0 | RealTrends 2025 for some entities (internal) | 102 answers with ≥1 rec | 33 | 1,166 / 82 | High (complete run, 0 review rows) | **Yes, aggregate only** (published as research page) | Per-entity counts, entity names, anything about buyer behaviour |
| 2 | Dual-assistant benchmark (`a00feb79`) | Jersey City, NJ | 2026-08-17 | OpenAI + Perplexity | 16 | 4 | 128 | 128 | 0 | same | 254 raw rec rows | 33 | 1,772 raw citations / 73 domains | High | Aggregate only (superseded by #1) | Same |
| 3 | Weekly baseline 2026-08-17 (`ef14a12c`) | Jersey City, NJ | 2026-08-17 | OpenAI only | 16 | 4 | 64 | 64 | 0 | same | 150 raw | 28 | 504 / 31 | High | Aggregate only | Same; single provider |
| 4 | JC prospecting batch 1 / batch 2 (`cedf73a5`, `9da9fe9d`) | Jersey City, NJ | 2026-08-15 | OpenAI only | 16 | 4 | 64 each | 64 each | 0 | same | 189 / 172 raw | 28 / 29 | 506/25, 458/25 | High | Aggregate only | Same |
| 5 | Prospect audit — search-enabled (`6442205e`, project "JC Luxury Group") | Jersey City, NJ | 2026-07-30 | OpenAI only | 40 | 1 | 40 | 40 | 0 | none | 9 raw | 5 | 318 / 42 | Low (1 repetition = anecdote) | **No** (single-rep pilot; 1 review row) | Anything |
| 6 | Wilmington, Delaware A→Z (`66af5cdb`) | Wilmington, DE | 2026-08-25 | OpenAI + Perplexity | 64 | 4 | 512 | 512 | 8 retries not counted | none linked | 879 raw | 25 | 6,433 raw / 429 | High | Aggregate (in stats table) | Entity names |
| 7 | Annapolis ×2 (`40719c6d`, `9ee8f5f6`) | Annapolis, MD | 2026-08-25/26 | OpenAI + Perplexity | 64 | 4 | 512 | 512 (partial run: 322) | — | none | 510 / 212 raw | 14 / 16 | ~6.8k / 340 | High / Medium (one run partial) | Aggregate | Entity names |
| 8 | Charleston ×2 (`56d332e8`, `9c1a14c6`) | Charleston, SC | 2026-08-25/26 | OpenAI + Perplexity | 64 | 4 | 512 each | 512 each | 0 | none | 883 / 367 raw | 21 / 19 | ~7.0k / 270–279 | High | Aggregate (stats table uses `9c1a14c6`) | Entity names |
| 9 | Savannah ×2 (`965834e3`, `ed0528f2`) | Savannah, GA | 2026-08-25/26 | OpenAI + Perplexity | 64 | 4 | 512 each | 512 each | 2 review rows each | none | 1,448 / 805 raw | 24 / 22 | ~7.1k / 365 | High | Aggregate (stats table uses `ed0528f2`) | Entity names |
| 10 | Princeton ×2 (`6bc980f0`, `2daa6246`) | Princeton, NJ | 2026-08-26 | OpenAI + Perplexity | 64 | 4 | 512 | 512 / 327 (partial) | — | none | 772 / 676 raw | 16 / 20 | ~6.9k / 312–322 | High / Medium | Aggregate | Entity names |
| 11 | Cohort 124 batch 1: Greenville, SC (`234722e6`) | Greenville, SC | 2026-08-31 | OpenAI + Perplexity | 64 | 4 | 512 | 512 | 0 | RealTrends 2025 volume for 25 sampled teams | 245 raw | 27 | 6,302 raw / 410 | High | Aggregate; production contrast **pending** (see claim `greenville-2026-08-31-contrast`) | Named mismatch; "top-5 team" phrasing; causation |
| 12 | Cohort 124 batch 1: Virginia Beach, VA (`7faf71c8`) | Virginia Beach, VA | 2026-08-31 | OpenAI + Perplexity | 64 | 4 | 512 | 512 | 0 | RealTrends (internal) | 194 raw | 25 | 6,747 / 404 | High | Aggregate | Entity names |
| 13 | Cohort 124 batch 1 — partial runs: Raleigh NC (501 valid), St. Louis MO (499), Indianapolis IN (498), Colorado Springs CO (494), Reno NV (493), Richmond VA (335), Knoxville TN (317), Grand Rapids MI (256 — Perplexity 0 valid), Wilmington NC (496) | various | 2026-08-31 | OpenAI + Perplexity | 64 | 4 | 512 each | as listed | Perplexity failures (`status = partial`) | RealTrends (internal) | — | 20–35 | 1.3k–6.6k raw | Medium (partial coverage) | Aggregate only, with the partial status stated | Any per-provider comparison where Perplexity coverage < 90% |
| 14 | Weekly baseline 2026-09-07 (`77660048`) | Jersey City, NJ | 2026-09-07 | OpenAI + Perplexity | 16 | 4 | 128 | 64 (Perplexity 0 valid) | 64 | same as #1 | 150 raw | 25 | 474 / 22 | Medium | Not separately | Any Perplexity figure |

\* "raw" = `mentions.recommended` rows before the canonical per-answer/echo/current-revision rules; the canonical figures used publicly are in the registry.

**Corpus aggregate (approved claim `corpus-aggregate`, window 2026-07-30 → 2026-09-07):** 34 runs, 17 market projects. OpenAI: 6,290 valid answers, 2,124 with ≥1 recommendation (34%), 5,901 with ≥1 citation. Perplexity: 5,216 valid, 2,130 with ≥1 recommendation (41%), 5,216 with ≥1 citation. 87,887 answer-domain pairs across 3,661 domains.

**Production dataset:** `realtrends_records` = licensed "2026 RealTrends Verified Agent Team Download with City", production year 2025, 74,847 rows; 377 high-confidence + 3 confirmed company links, 20 review-required, 74,447 unmatched. Internal-only (`REALTRENDS_DATASET_SOURCE_REF = licensed:realtrends-verified-2026`); **needs source verification** that licence terms permit quoting individual volume figures publicly before any production-contrast claim goes live.

**Published prospect audits:** 117 published of 268 created (2026-08-15 → 2026-09-11). These are private, token-gated, `noindex`; none is publishable as a case study (no client consent; prospects, not clients). Client count: 0 signed (`client_engagements` readiness only).

### 2. Approved public claims

Full table with values in `lib/marketing/approved-claims.json`. Summary:

| Claim id | Claim (approved wording) | Source | Denominator | Benchmark / date | Prohibited stronger wording |
|---|---|---|---|---|---|
| `jc-2026-08-31-summary` | "In our 2026-08-31 Jersey City benchmark, 102 of 128 captured answers named at least one specific agent or team as a recommendation. 33 different entities were recommended across those answers." | run `99af19b4`, tables responses/mentions | 128 valid answers (16 × 4 × 2) | Jersey City, 2026-08-31 | "most buyers use AI", "X% of buyers", any causation, "ranking" |
| `jc-2026-08-31-by-provider` | "The OpenAI model recommended 27 different entities across 64 answers; the single most-recommended entity appeared in 25 of 64. Perplexity recommended 20 … 22 of 64." | same, canonical counts | 64 per provider | same | "ChatGPT recommended", "the top agent in Jersey City is" |
| `jc-2026-08-31-top-domains` | Table: zillow.com 103, realtor.com 88, compass.com 61, homes.com 58, agentpronto.com 51, fastexpert.com 48, reddit.com 44, expertise.com 30, listwithclever.com 28, homelight.com 27 (answers citing, of 128) | response_citations | 1,166 pairs / 128 answers | same | "AI trusts Zillow", "get listed on X to be recommended" |
| `corpus-aggregate` | "Across 34 benchmark runs in 17 U.S. real-estate markets (July 30 to September 7, 2026), the OpenAI model named at least one specific agent or team in 2,124 of 6,290 answers (34%); Perplexity did so in 2,130 of 5,216 answers (41%)." | all market runs, filter in verifier | 6,290 / 5,216 | 2026-07-30 → 09-07 | "nationally representative", "X% of AI searches", "industry-wide" |
| `corpus-top-domains` | Top-20 table with OpenAI/Perplexity split (zillow.com 8,748; realtor.com 7,268; homes.com 5,145 …) | same | 87,887 pairs | same | "the sources AI trusts most" |
| `mkt-*` (Charleston, Greenville, Virginia Beach, Wilmington DE, Savannah) | Market statistics table: entities recommended and top-entity count out of 256 per assistant | runs listed in registry | 256 per provider | 2026-08-25/26/31 | "the leading team in <market>" |
| `greenville-2026-08-31-contrast` — **PENDING, not rendered** | "…the highest-volume team in our sample (by 2025 RealTrends closed volume, 25 teams with a record) was recommended in 0 of 256 answers from the OpenAI model, while a team with about a fifth of its volume was recommended in 17 of 256." | run `234722e6`, `providerRecommendationCounts`, `realtrends_records` | 256 OpenAI answers | Greenville SC, 2026-08-31 | "top-5 Greenville team", "lost listings", "AI prefers smaller teams", "ChatGPT ignores", revenue/causation |

The user's example claim ("top-5 Greenville team 0/256 vs lower-production competitor 17/256") is **supported by data but blocked**: the subject is the #1 team by volume in the sample (not merely top-5), both providers show 0/256 for it, the rival shows 17/256 on OpenAI and 0/256 on Perplexity. Release requires (a) spec-136 checks `ALIAS_SET_VERIFIED` and `ZERO_COUNT_VERIFIED` run for the subject entity (a zero is never published without them), and (b) RealTrends licence confirmation. Neither team is a client; both stay anonymous.

### 3. Homepage fact check (state before this change; what changed)

| Location | Finding | Type | Action |
|---|---|---|---|
| `home/page.tsx` metadata description (old) | "We measure how ChatGPT, Gemini, Claude and Perplexity represent and recommend…" | Vague/inaccurate provider labels: production benchmarks use OpenAI API + Perplexity; Gemini/Claude adapters exist but are not run | **Fixed**: description now comes from the page registry ("search-enabled AI assistants"); hero sentence at L136–140 still names ChatGPT/Gemini/Claude — left as a capability statement, **human decision** whether to reword to "the OpenAI model, Perplexity and other search-enabled assistants" |
| Hero H1 "Your competitors are being recommended by AI. Are you?" | Unsupported as a universal statement; supported as a question | Borderline | Keep (it is a question), flagged |
| Homepage KPI tiles 18% / 34 of 190 / AI Visibility Index 24/100 with sub-scores | Fixture numbers, labeled "Illustrative example, not client data" | Illustrative, labeled | OK as long as label stays; **do not** reuse in Lovable copy as data |
| Dashboard deltas "21% → 28%", "33% → 47%", "14 → 23", "61% → 84%" | Fixtures with disclaimer "not typical or promised outcomes" | Illustrative | OK; never quote as results |
| `sample-audit` "24 prompts / 192 responses / 15 (8%) / Competitor A 119 (62%)", "12 relevant sources vs 3", sources 31/24/17 | Entire page is hardcoded fixture (`CONTENTS`, `PROMPT_RESULTS`, `ACTIONS`); market "Manhattan luxury (example)" — a market never benchmarked | Illustrative; **mixed-market risk** (site now publishes real NJ/SE data next to a fictional Manhattan example) | Keep the "(example)" labels; recommend a banner linking to `/research` for real numbers (**human decision**) |
| FAQ "Can you guarantee…" → "No." | Correct | — | Kept; FAQ moved to `lib/marketing/faq.ts` and expanded with instrument, API-vs-consumer, repetitions, failure handling, no case studies |
| Methodology (old) "Every prompt is asked multiple separate times" | True but unquantified | Vague | **Fixed**: 4 reps, 64/16 prompts, 512 answers, instruments, echo rule, failure handling, 90-day staleness, 14-day mismatch age, RealTrends comparison rules, what cannot be proven |
| Methodology "four confidence labels … confidence percentage only from a statistical model" | Matches `gap_findings.classification` enum | OK | — |
| Footer: no legal entity, address, email, privacy/terms | Missing | Gap | `/about` renders "Not published yet" for entity/address; **needs human input** (`MARKETING_CONTACT` in constants) |
| Any "guarantee"-sounding wording | None found in copy; `findProhibitedPhrase` now tested against FAQ and page descriptions | — | Test added |
| Stale dates | No dates existed on any public page | Gap | Every page now prints `updated`; research pages print benchmark date and window |

### 4. Methodology details (publishable, code-verified)

- **Prompt sets.** Deterministic expansion of a versioned market pack (`lib/markets/packs.ts`, `generate.ts`): template × area × property type × price tier, city always state-qualified. Market benchmark ≤ 64 prompts (`MAX_MARKET_PROMPTS = 60`, bootstrap cap 64); prospect benchmark 16. Categories: recommendation, comparison, how-to, branded, problem (production runs so far: recommendation only). Sets are frozen (`prompt_set_versions.frozen_prompts`) before a run; re-tests reuse the frozen version.
- **Repetitions.** Configured per provider per run; production = 4 (docs default 5, `MAX_REPETITIONS = 10`). Cells = prompts × Σ reps.
- **Capture.** `responses` insert-only (trigger), `raw_payload` verbatim, one success per cell, failures accumulate with `error`; `refusal` flag. Sampling = provider default, recorded.
- **Classification.** Alias prepass → LLM classifier `mention-classifier-v2` (model `gpt-5.4-mini-2026-03-17`) → `isSameEntity` gate → verifier on low confidence → human review < 0.7 (`CONFIDENCE_REVIEW_THRESHOLD`), corrections as new revisions. Recommendation credit: one per answer, current revision, echo-excluded, non-holdout prompts.
- **Citations.** From raw payload: OpenAI `url_citation` annotations; Perplexity `citations[]` + `search_results[]`; `response_citations(url, domain, kind in_text|search, company_id)`, immutable. Domain counts = distinct answers.
- **Production comparison.** RealTrends verified record, same year, same metric (`closed_volume` if both have it, else `sides`), same entity level; mismatch = rival recommended ≥ 2 more times on OpenAI with ≤ 0.9× production; benchmark ≤ 14 days old; fail-closed reason codes.
- **Invalid answers.** `error is not null` or `refusal` → excluded from every denominator, reported as coverage; run marked `partial`.
- **Retesting.** Weekly scheduled baselines (ISO-week dedup), refresh queue on completion, 90-day benchmark freshness window, instrument change ⇒ "not comparable".
- **Release gate (spec 136).** 20 checks incl. entity/alias verification, production comparability, run completeness, denominator parity between SQL and shadow recount, zero-count verification, no pending review. Any UNKNOWN ⇒ blocked.
- **Limitations / cannot prove.** API ≠ consumer app; snapshot-in-time; non-determinism; our question set ≠ buyer queries; no causation; no revenue/lead/market-share inference; partial provider citation lists.

### 5. Citation intelligence details

Published verbatim on `/citation-intelligence`. Field sources: `response_citations` (url, domain, kind, company_id; immutable); `sources` (+ `source_type`, `relationship owned|competitor|third_party`, `classifier_version = source-classifier-v2`); taxonomy `client_site, brokerage, portal, news, directory, social, video, review, government, industry_ranking, local_press, other`; authority signals `independent|self_reported|derived|sponsored`; provenance tiers A–D (`lib/runs/provenance.ts`); market source graph `market-citations-v1` (`MIN_MARKET_CITATIONS = 10`, per-domain `citations, responsesCiting, responseShare, runsCiting, providers, topUrls, companiesInCitingAnswers`, per-prospect `ownDomainCitations, presentInDomains`); citation profiles `citation-profile-v1` (`domains`, `sourceGap`); displacement `recommendation-displacement-v1`; entity clarity (`entity_ambiguity` diagnosis 0.9, alias-collision block, gap types `entity`/`branded_recognition` thresholds 0.1/0.3/0.5); gap scoring formula + bands (`PRIORITY_BANDS 70/50/30`); ACVS weights (0.15/0.10/0.15/0.10/0.15/0.10/0.10/0.05/0.05/0.05, `ACVS_STRONG_THRESHOLD = 50`, quality-by-type table); link-health ledger (`evidence_link_checks.state healthy|redirected|broken|unavailable|superseded`, 7-day staleness); remeasurement via frozen engagement snapshots. Existing UI: `/prospects/sources`, `/projects/[id]/citations|competitors|gaps|technical|engagement`, report section "Where AI got its information".

### 6. Research pages

| Page | Status | Available data | Missing data | Safe angle | Unsafe claims |
|---|---|---|---|---|---|
| `/research/jersey-city-ai-visibility-report` | **Published now** | Run `99af19b4` aggregates (registry) | Per-entity results (withheld by policy); consumer-app validation; buyer-query data | "What two search-enabled assistants answered on one day, counted" | Naming teams; "JC's best agent per AI"; buyer-behaviour rates; causation |
| `/research/ai-citation-sources-real-estate` | **Published now** | 87,887 pairs / 3,661 domains, top-20 with provider split | Source-type labels per row (available internally, not yet in registry); temporal trend; markets outside our prospecting set | "Which domains the answers cited, counted per answer" | "AI trusts X"; "get on X to rank"; representativeness |
| `/research/real-estate-ai-search-statistics` | **Published, strictly scoped** | Recommendation/citation rates per assistant; 5-market concentration table | Any consumer search-volume, adoption or conversion statistic (none exist in repo) | "Statistics from our captured answers" with an explicit "statistics we do not have" section | Any "% of buyers use AI" figure; funnel numbers |
| Real Estate AI Visibility Index | **Should remain placeholder** | Per-market entity/concentration counts | A defined, versioned index method applied uniformly across markets; comparable coverage (9 of 14 cohort runs are partial); ≥ 2 time points | Not yet | An "index" implies ranking markets/teams; not supported |
| Worth adding: "Provider coverage report" (share of partial runs, Perplexity failure rate by week) | Needs more data | Run status table | A stable second time point | "How reliable the instruments were" | — |
| Worth adding: "Mismatch report — production vs recommendation" | Needs verification | Greenville contrast (pending), 17 RealTrends-eligible mismatches in cohort 124 | Release-gate runs on each zero; licence check | Anonymized, aggregate count of mismatches per market | Naming, "top-5", loss language |

---

## Part 2 — Crawlability and citation readiness (implemented)

### Crawlability
- `app/robots.ts`: `User-agent: *`, `Allow: /`, disallow `/api/ /auth/ /login /audit/ /report/ /portal/ /mcp /healthz /_next/`; sitemap + host. No per-bot rules, so Googlebot, Bingbot, OAI-SearchBot, ChatGPT-User, PerplexityBot, ClaudeBot and others are treated identically. Private surfaces already carry `X-Robots-Tag: noindex` (next.config).
- `app/sitemap.ts`: every registry page, canonical URLs, `lastModified` from `updated`.
- Middleware: `/robots.txt`, `/sitemap.xml`, `/llms.txt` added to public prefixes (previously the auth middleware would 307 a crawler to `/login` under `AUTH_MODE=supabase`).
- Canonicals: `marketingMetadata()` sets `alternates.canonical` (`/home` → origin root), OpenGraph, Twitter, `robots index/follow`; layout sets `metadataBase` from `MARKETING_HOST`.
- All new pages are server components; every table is HTML `<table>`; no client interaction needed. Titles/descriptions unique (tested).
- **Needs verification on prod**: 200 status on each URL from the marketing host, and that `MARKETING_HOST` is set to `recommendedfirst.com,www.recommendedfirst.com` (canonical origin falls back to `https://recommendedfirst.com`).

### Structured data
`Organization` + `WebSite` (layout), `BreadcrumbList` (every page), `FAQPage` (`/faq`, homepage abridged), `Article` (research reports), `Dataset` (JC report and citation-sources report only — both publish a described collection method and a denominator-bearing table). No `ProfessionalService`/`LocalBusiness` (requires a verified postal address — `MARKETING_CONTACT.postalAddress` is null). No ratings, reviews, awards.

### Source pages
`/methodology` (tightened), `/citation-intelligence`, `/research`, three research reports, `/faq`, `/about`. Each: one H1, dated `updated` line, answer-first sections, definitions, limitations, related links, tables.

### llms.txt
`/llms.txt` generated from the page registry (`lib/marketing/llms-txt.ts`): identity, what the product does/does not, page map with dates, contact path, "no guarantees" statement. `llms-full.txt` deliberately not added: it would duplicate page bodies and go stale; the registry-driven `llms.txt` plus crawlable pages is maintainable.

### Claims guardrails
`lib/marketing/approved-claims.json` (+ `lib/marketing/claims.ts` loader). Pages read numbers only through `claim()/claimNumber()/domainRows()`; a non-approved claim throws at render. `scripts/marketing-claims-verify.ts --check` recounts every claim from the immutable tables with canonical rules and exits 1 on drift. Unit tests enforce required fields, denominators, banned phrases (`PROHIBITED_PHRASES`) and label truth.

### Citation readiness (which pages are citable, what is missing)

| Page | Citable now? | Why / what would make it citable |
|---|---|---|
| `/research/ai-citation-sources-real-estate` | **Most likely** | Only source-of-truth with a large denominator (87,887 pairs) and a unique table; add source-type labels per domain and a second time window for trend |
| `/research/jersey-city-ai-visibility-report` | Likely, locally | Dated, single-market, specific; add a second date point (weekly baselines exist) for a "changed / unchanged" line |
| `/research/real-estate-ai-search-statistics` | Moderate | The 34% / 41% "names a specific agent" rates are quotable; page title promises "search statistics" that we cannot supply — consider renaming to "AI Recommendation Statistics" (**human decision**) |
| `/methodology`, `/citation-intelligence` | Moderate (definitional) | Cited for definitions and thresholds; keep versions and dates current |
| `/faq`, `/about` | Low | Trust pages; complete entity/address/email |

Missing primary sources: RealTrends licence terms (for any production-contrast claim); per-domain `source_type` export to the registry; consumer-app validation captures (`consumer_ui` provenance tier A exists in code, no public data); any third-party adoption statistic (none — do not add without URL + date).

Recommended original research assets (in order): (1) monthly re-cut of the citation-sources table with a diff; (2) instrument reliability report (partial-run rates); (3) anonymized mismatch census across cohort 124 once release checks run per entity; (4) a JC longitudinal series from the weekly baselines.

---

## Human verification checklist
1. `MARKETING_HOST` on Railway = `recommendedfirst.com,www.recommendedfirst.com`; curl each sitemap URL for 200 after deploy.
2. Fill `MARKETING_CONTACT` (legal entity, postal address, public email) or leave null (renders "Not published yet").
3. Decide hero wording (ChatGPT/Gemini/Claude) and the sample-audit "Manhattan (example)" banner.
4. RealTrends licence: may individual 2025 volumes be quoted anonymized? Until yes, `greenville-2026-08-31-contrast` stays pending.
5. Run the spec-136 zero-count checks for the Greenville subject before approving that claim.
6. Verify `hobokenpainter.com` (40 JC answers cited it) — likely an expired/redirected domain; excluded from the public table until checked.
7. Re-run `npx tsx scripts/marketing-claims-verify.ts --check` before each marketing deploy; bump `lastVerified`.


---

## Change log — 2026-09-14 (spec 141: citation readiness and evidence distribution)

### Data-quality finding (CRITICAL, human decision required)
`scripts/marketing-claims-verify.ts --check` found drift on four claims. Cause, confirmed by querying `mentions`: on 2026-09-13/14 a heuristic parser (`mention-parser-v1+heuristic`) wrote **revision 2** rows over the earlier LLM (`mention-parser-v2+llm`) classifications on the Jersey City batch-1/batch-2 runs, the dual-assistant run and the Wilmington NC cohort run, and revision-1 heuristic rows on the new T1 refresh runs (the LLM parser is used only when `OPENAI_API_KEY` is present — `lib/parsing/version.ts`; the T1 refresh/supply scripts from the other session are the likely trigger). Under the platform's current-revision rule the heuristic rows are canonical, so the registry now carries the recounted values and each affected claim has an `updateHistory` entry; the verifier prints `INTEGRITY` for them and `--strict` fails. Values changed:

| Claim | Before (LLM parse) | After (heuristic revision 2) |
|---|---|---|
| Jersey City 2026-08-31: answers with a recommendation / entities | 102 / 33 | 87 / 29 |
| Jersey City OpenAI: entities / top entity | 27 / 25 of 64 | 20 / 14 of 64 |
| Jersey City Perplexity: entities / top entity | 20 / 22 of 64 | 18 / 17 of 64 |
| Corpus OpenAI / Perplexity answers with a recommendation | 2,124 / 2,130 | 2,036 / 2,050 |
| Wilmington DE OpenAI entities / top entity; Perplexity | 17 / 42; 19 / 54 | 11 / 28; 18 / 27 |

Required before deploy: decide whether to re-run the LLM parser as revision 3 on the affected runs (then rerun the verifier, regenerate the dataset as v1.0.1) or to accept the heuristic revisions. Until then the public pages are internally consistent but rest on a downgraded parse.

### Terminology and evidence corrections
- Homepage hero now says "AI search systems (today: the OpenAI model through its web-search API, and Perplexity)"; no Gemini/Claude claim remains in production copy. The sample-audit demo still shows illustrative "ChatGPT / Gemini / Claude / Perplexity" columns under an "Illustrative example" label — flagged, unchanged.
- Every benchmark page carries the verbatim instrument note (`INSTRUMENT_NOTE` in `components/marketing/research.tsx`).
- Statistics page renamed to `/research/real-estate-ai-recommendation-statistics` ("AI Recommendation Statistics for Real Estate"); it states the consumer statistics it does not have.
- Greenville contrast claim stays `pending_verification` (release-gate zero-count + entity checks, RealTrends licence).
- `hobokenpainter.com`: verified live 2026-09-14 (HTTP 301 → www; blog listicles "luxury-realtors", "best-realtors-for-sellers-in-hudson-bergen-counties-nj"; 69 + 18 citing answers, both instruments; classified `other`). Decision: **shown** in the Jersey City table as a third-party business blog, with that description; excluding an active, off-topic source would misrepresent what the assistants cited.
- Contact facts remain "Not published yet".

### New public routes
`/research/chatgpt-real-estate-visibility-benchmark` (flagship), `/research/real-estate-ai-visibility-index` (v0 coverage table, no composite), `/chatgpt-visibility-audit-for-real-estate`, `/ai-search-optimization-for-real-estate-agents`, `/best-ai-visibility-tools-for-real-estate`, `/recommended-first-alternatives`, `/recommended-first-vs-sorn-ai`, `/recommended-first-vs-rankfender`, `/research-data/<file>` (dataset downloads). Comparison pages quote only vendor self-descriptions (`lib/marketing/vendors.ts`) with source URL and retrieval date; Recommended First has not tested either product. The flagship page keeps "ChatGPT" in its name per the public route while stating in its first line that the instrument is the OpenAI web-search API.

### Registry additions
`corpus-source-classes`, `corpus-prompt-categories`; per-market `answersWithRecommendation`; `updateHistory` field; `publicExclude` no longer lists hobokenpainter.com. Source-class distribution: 53,854 of 87,887 pairs are on unlabelled ("other") domains — the classifier lists cover portals (25,662 pairs, 10 domains), brokerages, government and a few others; a labelled release is deferred to dataset v1.1.

### Dataset, citation map, docs
- `data/public/` v1.0.0 (59 benchmark rows, 3,612 domain rows, 940 entity rows) generated by `scripts/public-dataset-export.ts`; served at `/research-data/`. Release notes, dictionary, methodology, README, and `docs/external_dataset_submission_checklist.md` (NOT submitted).
- Migration `115_citation_map_and_intervention_controls.sql` (NOT applied to prod): `citation_map_targets` with the requested fields and the Discovered → … → Remeasured pipeline; `interventions.control_company_id / changed_url / change_description`. Scoring in `lib/citations/citation-map.ts` (weights 0.30/0.20/0.15/0.15/0.10/0.10, no Domain Rating); persistence in `db/citation-map.ts`; unit tests.
- `docs/citation_outreach_playbook.md` (10-publication queue, all contacts marked needs-verification, no sends), `docs/rf_entity_footprint_checklist.md`, `docs/consumer_chatgpt_benchmark_assessment.md` (recommendation: no scraper; manual clean-session tier only), `docs/intervention_remeasurement_protocol.md`.

## Change log — 2026-09-14 (release hardening: revision 3, verifier gates, dataset v1.0.1)

- **Parser regression resolved at row level, on staging.** Nine runs had heuristic revisions 2–5 written above classifier rows with no LLM key. Every disagreeing pair was compared against the answer text (`docs/parser_revision_comparison.md`): the heuristic produced false negatives. Revision 3 (`mention-parser-v3+adjudication`, offline text corroboration because the OpenAI account has no credits) verifies 1,695 pairs, sends 81 to manual review, marks 228 not classified. Artifact committed under `data/internal/mention-revision-3/`; **not applied to production**.
- **Precedence rule.** Public numbers use the highest verified revision (human > explicit verified > classifier ≥ 0.7); heuristic rows never count; a pair awaiting review blocks its run's claims. Internal views unchanged. Migration 116 adds `classification_method`, `classification_reason`, `verification_status` (additive, idempotent, reversible — verified down/up on staging with no data loss).
- **Verifier gates** (`--check` exits 1): drift, MANUAL REVIEW, INTEGRITY (unadjudicated downgrades), denominator vs canonical eligibility, missing source/date/market/instrument, dataset/registry disagreement, banned wording in registry and marketing sources, dataset version mismatch, missing migration.
- **Registry values (staging recount, provisional until applied to production):** Jersey City 102 of 128 answers, 33 entities; OpenAI 27 entities / 25 of 64; Perplexity 20 / 22 of 64; corpus 2,124 of 6,290 (34%) and 2,130 of 5,216 (41%); Wilmington DE 17 / 42 of 256 and 19 / 54 of 256. Every change carries an `updateHistory` note rendered on the pages.
- **Dataset v1.0.1** regenerated on staging (59 benchmark rows, 3,612 domain rows, 1,036 entity rows, 85 blocked pairs disclosed); v1.0.0 superseded, never uploaded.
- **Wording:** instrument sentence updated to the approved text on every benchmark page; sample-audit demo labelled "Illustrative example — not a production benchmark"; static wording scan enforced by verifier and unit test.
- **Release state:** BLOCKED. Production verifier: FAIL (migration 116 not applied). Staging verifier: 9 MANUAL REVIEW lines (85 pairs). Human gates in `docs/human-verification-gates.md`.
