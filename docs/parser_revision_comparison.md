# Parser revision comparison — revision 3 adjudication (2026-09-14)

Artifact: `data/internal/mention-revision-3/2026-09-14-regressed-runs-offline.json` (method `adjudication:offline-text-corroboration`, parser version `mention-parser-v3+adjudication`, judged 2026-09-14T12:47:15Z against production reads; no production writes). Classifier unavailable: OpenAI classifier unavailable: credit_balance_exhausted (insufficient_quota) on 2026-09-14.

## What happened
On 2026-09-13/14 the parse service ran without an LLM key (`llmClassificationAvailable()` false, `lib/parsing/version.ts`) and, because the parse ledger had no row for the heuristic version, re-parsed nine historical runs with `mention-parser-v1+heuristic`, writing new revisions (2–5) above the original `mention-parser-v2+llm` rows. Nothing was deleted or edited (immutable trigger); the platform's current-revision rule simply started reading the heuristic rows. Revision 2 was **not** an intended replacement: it is the documented degrade path for an unavailable classifier.

## Runs affected (all nine regressed runs)
| Run | id | verified (rev 3) | needs_manual_review | not_classified | pairs adjudicated |
|---|---|---|---|---|---|
| JC prospecting batch 1 — market run — 2026-08-15 | cedf73a5 | 149 | 7 | 34 | 190 |
| JC prospecting batch 2 — market run — 2026-08-15 | 9da9fe9d | 138 | 2 | 26 | 166 |
| Weekly baseline 2026-08-17 | ef14a12c | 113 | 4 | 30 | 147 |
| Dual-assistant benchmark (OpenAI + Perplexity) | a00feb79 | 200 | 8 | 25 | 233 |
| Wilmington DE market benchmark | 2557818a | 147 | 16 | 12 | 175 |
| Wilmington, Delaware market benchmark (A→Z, state-qualified) | 66af5cdb | 313 | 25 | 20 | 358 |
| Weekly baseline 2026-08-31 | 99af19b4 | 196 | 7 | 39 | 242 |
| Cohort 124 batch 1: Wilmington, NC | 62db6814 | 316 | 9 | 24 | 349 |
| Weekly baseline 2026-09-07 | 77660048 | 123 | 3 | 18 | 144 |

Totals: 2004 pairs; verified 1695, manual review 81, not classified 228. Pairs where the classifier and the heuristic agreed needed no revision-3 row: the verified classifier row already wins.

## What the disagreements were
| Kind | Pairs |
|---|---|
| classifier recommended, heuristic did not | 1432 |
| heuristic recommended, classifier did not | 328 |
| heuristic-only pair (no classifier row) | 228 |
| mention disagreement | 16 |

Row-level check of the answer text (every disagreement was compared, not sampled — the offline adjudicator tests the company name/alias against the text and the classifier's quoted excerpt against the text after markdown normalization): in the dominant kind, the heuristic produced **false negatives** — its cue-word regex (`recommend|suggest|top pick|best option…`) misses list-style answers such as "a strong first call would be **X**", "the strongest match … is **X**", "solid place to start is **X**". The classifier's excerpts for those rows are found verbatim (modulo markdown) in the answers. Examples (Jersey City, run 99af19b4): "a strong first call would be Michelle Mumoli at Compass" (classifier recommended, confidence 0.99; heuristic not recommended); "Andrea Alummootil (Keller Williams City Views), who has a 5.0 rating in Journal Square" (0.93 vs heuristic no); "Jill Biggs / The Jill Biggs Group (Coldwell Banker) — Zillow shows a 5.0 rating…" (0.99 vs heuristic no).

## Revision-3 rule (lib/parsing/precedence.ts, adjudicateOffline)
- Retain the verified classifier judgment as `verified` only if: a name or alias occurs in the text, the classifier's quoted excerpt is grounded in the text (markdown/punctuation-insensitive; every ellipsis fragment), and confidence ≥ 0.9 (docs/06 auto-accept line; 0.7–0.9 is "spot-check", which with a dissenting parser means a person looks).
- Otherwise `needs_manual_review` (never forced).
- No classifier row at all (company attached after the classifier parse) → `not_classified`: excluded from public counts, never a zero, disclosed.
- Every revision-3 row records parser version, timestamp (`created_at`), method (`classification_method`), source run (via response), reason (`classification_reason`), confidence and `verification_status`.

Precedence for public numbers (`PUBLIC_REVISION`): human-reviewed row > explicit `verified` > classifier row ≥ 0.7 without review flag; heuristic rows never count; a pair whose newest row needs manual review blocks every claim over its run (`PUBLIC_BLOCKED_PAIR`). Internal operator views keep the current-revision rule (unchanged behaviour); the divergence is deliberate and documented in DECISIONS.md.

## Manual-review queue
| Reason | Rows |
|---|---|
| rev1 confidence N is below the N auto-accept line while the heuristic dissents | 32 |
| rev1 excerpt is not found verbatim in the answer text | 24 |
| rev1 classifier said not mentioned but a name or alias occurs in the text; heuristic disse | 22 |
| rev1 classifier said mentioned but no name or alias occurs in the text | 3 |

These rows are inserted with `needs_review = true` and appear in the platform's review queue once the artifact is applied; a human correction is a new revision with `reviewed_by` set, which the precedence rule ranks above every parser. Until the queue is empty the release gate blocks.

## Final selected public values (staging recount, verified-only)
| Claim | Heuristic-downgraded (registry 2026-09-14 morning) | Revision-3 verified-only |
|---|---|---|
| Jersey City 2026-08-31: answers with a recommendation / entities | 87 / 29 | 102 / 33 |
| Jersey City OpenAI: entities / top entity | 20 / 14 of 64 | 27 / 25 of 64 |
| Jersey City Perplexity: entities / top entity | 18 / 17 of 64 | 20 / 22 of 64 |
| Corpus OpenAI / Perplexity answers with a recommendation | 2,036 / 2,050 | 2,124 / 2,130 |
| Wilmington DE OpenAI entities / top; Perplexity entities / top | 11 / 28; 18 / 27 | 17 / 42; 19 / 54 |

Reason for selection: the verified classifier rows are corroborated by the answer text pair by pair; the heuristic rows are a lower-fidelity fallback that the text contradicts. The values coincide with the pre-regression LLM values where no pair was sent to review, which is expected, not a goal.

## Release-gate output (staging, `--check`)
```
MANUAL REVIEW jc-2026-08-31-summary: 7 pair(s) in run 99af19b4 need manual review
MANUAL REVIEW jc-2026-08-31-by-provider: 7 pair(s) in run 99af19b4 need manual review
MANUAL REVIEW jc-2026-08-31-top-domains: 7 pair(s) in run 99af19b4 need manual review
MANUAL REVIEW corpus-aggregate: 85 pair(s) across corpus runs need manual review
MANUAL REVIEW corpus-top-domains: 85 pair(s) across corpus runs need manual review
MANUAL REVIEW mkt-wilmington-de: 25 pair(s) in run 66af5cdb need manual review
MANUAL REVIEW mkt-savannah: 2 pair(s) in run ed0528f2 need manual review
MANUAL REVIEW corpus-source-classes: 85 pair(s) across corpus runs need manual review
MANUAL REVIEW corpus-prompt-categories: 85 pair(s) across corpus runs need manual review
RELEASE GATE: 9 blocking issue(s)
```

## How to apply to production (human step; nothing here has touched production)
```
# 1. stop the worker (docs/deployment.md), then:
npx tsx scripts/migrate.ts up                     # applies 115 and 116 (additive, idempotent)
npx tsx scripts/mention-revision-3.ts apply --artifact data/internal/mention-revision-3/2026-09-14-regressed-runs-offline.json
npx tsx scripts/marketing-claims-verify.ts --check   # expect MANUAL REVIEW lines until the queue is cleared
# 2. clear the review queue in the app (Mentions → review), then re-run --check; regenerate the dataset if any value moved:
npx tsx scripts/public-dataset-export.ts --through 2026-09-07 --version 1.0.2
```

## Remaining limitations
- Revision 3 is an offline text corroboration, not a fresh classifier judgment; when OpenAI credits are restored, `judge` (without `--offline`) can produce a revision-4 artifact for the manual-review and not-classified pairs.
- 228 pairs are excluded as not classified; their entities are absent from public counts for those runs and this is disclosed as coverage, not as zero.
- The prod database still carries the heuristic rows as current revision for internal views until a product decision changes the internal rule.
