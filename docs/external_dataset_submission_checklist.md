# External dataset submission checklist (Zenodo · GitHub · Harvard Dataverse / Figshare)

Status: **PREPARED, NOT SUBMITTED.** Nothing is uploaded anywhere until every approval box below is checked by a person. The canonical source of the dataset remains https://recommendedfirst.com; repository records link back to it.

## Record metadata (proposed)
| Field | Value |
|---|---|
| Title | Real Estate AI Visibility Benchmark: recommendation and citation counts from search-enabled AI assistants in 17 U.S. markets (v1.0.1) |
| Version | 1.0.1 (corpus through 2026-09-07; generated 2026-09-14; verified-only classification precedence) |
| Description | Aggregate, anonymized counts of how the OpenAI model (gpt-5.4-mini, web search, API) and Perplexity (sonar, API) answered frozen who-to-hire questions about real estate agents and teams: valid answers, answers naming or recommending an entity, distinct entities, cited domains. No answer text, prompt text, entity names or licensed production data. |
| Authors | Francisco Zuluaga (Recommended First). ORCID: **needs human input** |
| Organization | Recommended First — legal entity name **needs human verification** (see `MARKETING_CONTACT`) |
| Date | 2026-09-14 (generation); publication date on approval |
| Keywords | AI visibility; generative engine measurement; real estate; recommendation systems; citation analysis; benchmark |
| License recommendation | CC BY 4.0 for the data files (attribution keeps the canonical link); documentation same. **Do not** select CC0: attribution to the canonical page is the point of the release. Confirm no RealTrends-derived value is present (none in v1.0.0). |
| Citation format | Recommended First. ChatGPT Real Estate Visibility Benchmark: 17 U.S. markets, 2026-07-30 to 2026-09-07, v1.0.1. https://recommendedfirst.com/research/chatgpt-real-estate-visibility-benchmark — DOI: **[placeholder, assigned by Zenodo on publish]** |
| Canonical RF URL | https://recommendedfirst.com/research/ai-citation-sources-real-estate#downloads (dataset) and https://recommendedfirst.com/research/chatgpt-real-estate-visibility-benchmark (report) |
| Related identifiers | isSupplementTo → the two canonical URLs above |

## Files to upload
- `data/public/real-estate-ai-visibility-benchmark.csv`
- `data/public/real-estate-ai-visibility-benchmark-domains.csv`
- `data/public/real-estate-ai-visibility-benchmark-entities.csv`
- `data/public/real-estate-ai-visibility-benchmark.json`
- `data/public/README.md`, `data-dictionary.md`, `methodology.md`
- `docs/public_dataset_release.md` (as release notes)

## Per-repository notes
- **Zenodo**: create a concept DOI on first version; later versions attach to the concept. Add "Recommended First" as a community only if one exists (do not create a fake one). Upload type: Dataset.
- **GitHub**: a public `recommendedfirst/real-estate-ai-visibility-benchmark` repository containing only `data/public/` and the three docs; tag `v1.0.0`; enable the Zenodo–GitHub integration so tags mint DOIs. **Needs decision**: this platform's repository stays private.
- **Harvard Dataverse / Figshare**: same files; Dataverse requires a data-use statement — use the licence above and the anonymization section of the release notes.

## Privacy review (must all be true)
- [ ] No agent, team, prospect or client name appears in any file (`rg -i` against the prospect and company name list before upload).
- [ ] No answer text or prompt text.
- [ ] No RealTrends volume, sides or rank values.
- [ ] Every domain named was cited in ≥ 2 market projects and is not agent-owned (export rule verified).
- [ ] Run ids are acceptable to publish (they are opaque uuids; they let RF re-derive any row internally).

## Publication approval
- [ ] Revision 3 applied to production (migration 116 + artifact) and the manual-review queue cleared; `docs/parser_revision_comparison.md` gates satisfied.
- [ ] `npx tsx scripts/marketing-claims-verify.ts --check --strict` passes.
- [ ] Legal entity and author details confirmed.
- [ ] Licence chosen and RealTrends terms confirmed as not applicable to v1.0.0 content.
- [ ] Founder sign-off recorded in `DECISIONS.md` with the date.

## Changelog (included in the record description)
- 1.0.1 (2026-09-14): counts recomputed under the verified-only classification precedence (human review > explicit verified adjudication > classifier rows ≥ 0.7; heuristic rows never counted). Adds `blocked_pairs` (pairs awaiting manual review, excluded from counts). Entity rows 1,032 (was 940). Reason: a heuristic re-parse on 2026-09-13/14 had superseded classifier rows on nine runs; see `docs/parser_revision_comparison.md`.
- 1.0.0 (2026-09-14): first release; superseded, never uploaded.
