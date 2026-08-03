# Spec 005 — Competitor Analysis

> Status: done (2026-07-27)
> Depends on: specs/004 · docs/06 (share of voice, position, citation, sentiment, authority)
> Branch: feat/005-competitor-analysis
>
> Implementation notes / recorded cuts: trend charts (with version-boundary
> annotation) are deferred to specs/006 where the dashboard is the core
> deliverable — this spec ships the comparison table with n/a for
> null/insufficient metrics. Google + Perplexity adapters are implemented
> (@google/genai; Perplexity via the OpenAI-compatible endpoint) but their
> model ids and prices are UNVERIFIED pending API keys — flagged in
> lib/ai/pricing.ts and the estimate UI. Citation denominators derive from
> URLs in response text at scoring time (deterministic, avoids new columns
> on the immutable responses table); provider-native citation fields ride in
> raw_payload for a future parser version. SoV denominators use all active
> companies (single-project reality; revisit if projects diverge). Backfill
> re-parses the last 12 completed runs (BACKFILL_RUN_LIMIT).

## Goal
Track a competitor set per project and compute the **full v1.0 metric suite** (share of voice, position score, citation score, sentiment index, authority score) for the client and every tracked competitor with identical methodology, plus discovery of untracked brands appearing in answers. Also adds the Google and Perplexity provider adapters (citations become meaningful).

## User stories
- As an operator, I manage the project's competitor list (company, tier primary/secondary).
- As an operator, I compare the client vs competitors: authority score, share of voice, recommendation rate — per provider, over time.
- As an operator, I see "unrecognized brands" that appear frequently in answers and can promote one to a tracked company in two clicks.
- As an operator, adding a competitor retroactively computes its metrics from existing raw data.

## UI

Competitors page (`/projects/[id]/competitors`):
```
│ Competitors                                  [+ Add]         │
│ Company    Tier      Auth score  SoV    Rec rate   Trend     │
│ Lumina ★    self      62          31%    42%        ▲ +4      │
│ Acme       primary   71          38%    55%        ▼ −2      │
│ Beta Inc   secondary 40          12%    9%         – 0       │
├──────────────────────────────────────────────────────────────┤
│ Unrecognized brands seen ≥3× last 4 runs:                    │
│  "Gamma Tools" (7 hits)  [Track]   "Delta" (3)  [Track]      │
```
Comparison view: grouped bar per provider (Recharts, scoring version annotated), line chart over runs per metric with version-boundary annotations (`docs/04`). Company drill-down: metric history + supporting excerpts (click-through to raw responses).

## Database changes
Migration `005_competitors.sql`: `competitors` join table per `docs/03`; add `unrecognized_hits` counter view or table `brand_candidates` (name, first_seen_run_id, hit_count) populated by the parser pre-pass; extend nothing on immutable tables.

## Logic changes
- Parser pre-pass records capitalized product/company-like entities that match no tracked alias into `brand_candidates` (deterministic heuristic + the parser model's entity list; no auto-tracking — humans promote, `PRINCIPLES.md` #8).
- `lib/scoring/` implements remaining v1.0 metrics exactly per `docs/06`, including null-component weight redistribution for authority score and per-provider-then-mean aggregation.
- Retroactive computation: adding a competitor enqueues `parse_response` revisions **only for the new company** across responses in scope (bounded: last 12 runs by default, operator-expandable), then scoring for runs lacking that company's score rows.

## API

| Action | Input | Auth | Audit |
|---|---|---|---|
| `addCompetitor` | `{ projectId, companyId, tier }` | operator | `competitor.add` |
| `updateCompetitorTier` / `archiveCompetitor` | ids + tier / id | operator | `.update` / `.archive` |
| `trackBrandCandidate` | `{ candidateId, aliases?, domain?, tier }` → creates company + competitor + backfill | operator | `competitor.track_candidate` |
| `backfillCompetitor` | `{ competitorId, runIds? }` | operator | `competitor.backfill` |

Reads: comparison aggregates per project/provider/metric/date-range from `scores` (indexed reads only; materialized view when slow, per `docs/02`).

## Validation rules
- A company can be competitor in a project once; the platform's own brand (`is_self`) is implicitly compared and cannot be added/archived as a competitor.
- Tier required; candidate promotion requires a canonical name that passes company validation (spec 004 collision rules).
- Backfill respects the review gate: retro-parsed low-confidence mentions enter the same review queue before that company's scores compute for those runs.

## Edge cases
- Competitor added mid-history → charts show its line starting where backfill coverage starts, annotated "tracked since run X (backfilled)".
- Competitor archived → excluded from new parsing/scoring and default views; historical scores remain and render in historical charts (never deleted).
- Rebrand (Acme → AcmeHQ) → alias update on the company + `reparseRun` forward; historical revisions stand; annotation on charts optional v2.
- Share-of-voice denominator changes when the tracked set changes → SoV charts annotate tracked-set-change boundaries exactly like scoring-version boundaries (comparing SoV across different competitor sets is misleading; `docs/06` reporting rules apply).
- Google/Perplexity citation shapes differ → adapters normalize into `cited_urls` + `sources`; providers without citations render citation score as null/“n/a”, never 0.

## Acceptance criteria
- [ ] Every v1.0 metric in `docs/06` computes for self and all tracked competitors with identical code paths (verified: same function, company id is the only parameter).
- [ ] Authority score matches hand-computed fixtures including null-component redistribution.
- [ ] Adding a competitor triggers bounded backfill → review gate → scores appear; audit-logged.
- [ ] Unrecognized brands with ≥3 hits surface; promoting one creates company + competitor + backfill in one flow.
- [ ] SoV and version boundaries annotated on charts; cross-boundary deltas not rendered as trends.
- [ ] Google + Perplexity adapters pass recorded-payload shape tests; citations populate `sources` with domain attribution.

## Test cases
- **Unit:** each metric known-answer fixtures (incl. null citation provider, <5-cell nulls); SoV denominator with tracked-set changes; candidate heuristic (no false hits on common words).
- **Integration:** backfill pipeline end-to-end on seeded historical runs; archived competitor exclusion; identical-methodology property test (swap company ids, symmetric results).
- **E2E:** add competitor → backfill → comparison chart renders both lines; promote a candidate from the discovery panel.

## Definition of done
Per `specs/_TEMPLATE.md`, plus a real 4-provider smoke run with at least 2 competitors, spot-audited.
