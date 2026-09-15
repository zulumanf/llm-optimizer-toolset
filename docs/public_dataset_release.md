# Public dataset release — Real Estate AI Visibility Benchmark

Version 1.0.1 · generated 2026-09-14 · corpus through 2026-09-07 · classification precedence: verified-only (see changelog) · canonical page: https://recommendedfirst.com/research/ai-citation-sources-real-estate#downloads

Generator: `npx tsx scripts/public-dataset-export.ts --through 2026-09-07 --version 1.0.1` (read-only against the measurement database). Files live in `data/public/` and are served at `/research-data/<file>` from the committed JSON, so the download and the repository copy cannot diverge.

## Files
| File | Rows | Grain |
|---|---|---|
| `data/public/real-estate-ai-visibility-benchmark.csv` | 59 | one row per benchmark run × assistant |
| `data/public/real-estate-ai-visibility-benchmark-domains.csv` | 3,612 | one row per benchmark × assistant × cited domain (or bucket) |
| `data/public/real-estate-ai-visibility-benchmark-entities.csv` | 1,036 | one row per benchmark × assistant × anonymized entity |
| `data/public/real-estate-ai-visibility-benchmark.json` | — | all three tables plus `meta` |
| `data/public/data-dictionary.md`, `methodology.md`, `README.md` | — | documentation |

## What is included
Aggregate counts only, under the same eligibility rules as the public claims (valid cells, non-holdout prompts, highest VERIFIED mention revision, echo exclusion). Pairs awaiting manual review are excluded and disclosed per row as `blocked_pairs` (85 in this version). Corpus filter: runs with status completed or partial, not QA fixtures, not the non-real-estate project, completed on or before the `through` date; providers openai and perplexity only.

## What is excluded, and why
| Excluded | Reason |
|---|---|
| Answer text, raw payloads | Sensitive raw answers; may name individuals; provider terms |
| Prompt text | Not needed for the counts; prompt packs are versioned separately |
| Entity names | Prospects and non-clients; no consent. Entities are `E01…` per benchmark × assistant, ordered by recommendation count |
| Domains owned by tracked agent/team companies | Bucketed as `agent_or_team_owned_site` |
| Domains cited in only one market project | Bucketed as `single_market_domain` (personal sites would otherwise identify agents) |
| RealTrends fields (volume, sides, rank) | Licensed dataset; terms not yet confirmed for redistribution |
| Contacts, outreach, notes, run labels naming prospects | Private |
| Runs after 2026-09-07 | Window frozen for v1.0.0; T1 refresh runs of 2026-09-14 were in progress |

## Missing-data report (what a reader cannot do with this release)
- Reproduce per-answer classifications: answer-level rows are withheld (see above). A per-answer release would need a privacy review of answer text and provider terms.
- Map `E01…` labels across benchmarks: labels are per benchmark × assistant by design.
- Recover source classes per domain: `source_class` is not in v1.0.0 because 3,582 of 3,661 cited domains carry no label yet (classifier lists cover portals, brokerages, government and a few others). Planned for v1.1 once coverage is meaningful.
- Distinguish in-text from search-result citations: collapsed into "cited" for v1.0.0.

## Changelog
- **1.0.1 (2026-09-14)** — regenerated on a staging mirror after revision-3 adjudication (`docs/parser_revision_comparison.md`): verified-only precedence, heuristic rows never counted, `blocked_pairs` added, entity rows 940 → 1,036. Values changed versus 1.0.0 for the nine regressed runs (Jersey City, Wilmington DE/NC); every other row identical. Not yet reproducible from production until migration 116 and the artifact are applied there.
- **1.0.0 (2026-09-14)** — first generation, current-revision precedence; superseded, never uploaded.

## Known data-quality caveat (2026-09-14)
On 2026-09-13/14 a heuristic parser (`mention-parser-v1+heuristic`) wrote revision-2 mention rows over earlier LLM classifications on several historical runs (Jersey City batches and dual-assistant run, Wilmington NC) and revision-1 rows on the new T1 refresh runs. The current-revision rule makes those rows canonical, so v1.0.0 reflects them; the verifier flags the affected claims as `INTEGRITY`. v1.0.1 resolves this with the offline revision-3 adjudication; 85 pairs remain in manual review and are excluded.

## Versioning
Semantic: patch for recounts under the same window and rules; minor for new fields or a longer window; major for a change of eligibility rules. Each version is regenerated in full, never edited by hand.

## Approval status
NOT YET APPROVED FOR EXTERNAL UPLOAD. See `docs/external_dataset_submission_checklist.md`.
