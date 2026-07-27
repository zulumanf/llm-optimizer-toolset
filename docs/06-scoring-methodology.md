# 06 — Scoring Methodology

**Current version: `v1.0`** (changelog at bottom). Every equation and weight lives here. Every `scores` row stores the `scoring_version` it was computed with. Changing anything below — even a weight — requires a new version and a changelog entry. Old scores are never recomputed in place (`PRINCIPLES.md` #4, #10).

## Definitions

For a run *R*, company *C*, and provider *P*:

- A **cell** = one (prompt, provider, model, repetition) call.
- `N` = number of **valid cells** in scope (successful responses; errored cells are excluded from denominators but reported as coverage).
- Only mentions at their **highest revision** and with `confidence ≥ 0.7` or human review count toward scores. Unreviewed low-confidence mentions block scoring for their run until cleared (or 72h timeout → excluded and flagged in coverage).
- All rates are computed **per provider** first, then aggregated across providers by unweighted mean (each provider counts equally — sample sizes per provider are equal by design).

## Metrics (v1.0)

### Mention Rate
Fraction of valid cells where *C* is mentioned at all.

```
mention_rate(C) = cells_mentioning_C / N
```

### Recommendation Rate
Fraction of valid cells where *C* is **explicitly recommended** (the answer endorses choosing C, not merely names it).

```
recommendation_rate(C) = cells_recommending_C / N
```

The primary headline metric for Parva.

### Share of Voice
Parva's mentions relative to all tracked-company mentions in the run.

```
share_of_voice(C) = mentions_of_C / Σ mentions_of_all_tracked_companies
```

(Untracked brands are excluded from the denominator; they're surfaced separately as discovery.)

### Position Score
Quality of placement when the answer ranks/lists options. For each cell where *C* appears in a list of length ≥ 2:

```
cell_position_score = 1 / list_position          (1st → 1.0, 2nd → 0.5, 3rd → 0.33 …)
position_score(C)   = mean(cell_position_score)  over listing cells; null if < 5 listing cells
```

### Citation Score
How often answers cite sources owned by *C* (domain match via `companies.domain`).

```
citation_score(C) = cells_citing_C_owned_source / cells_with_any_citation
```

Null for providers that never return citations (don't punish what isn't measurable).

### Sentiment Index
Mentions mapped positive = 1, neutral/mixed = 0.5, negative = 0:

```
sentiment_index(C) = mean(mapped sentiment over mention cells); null if < 5 mention cells
```

### Authority Score (composite)
The single roll-up, computed per provider then averaged:

```
authority_score(C) = 100 × ( 0.35 × recommendation_rate
                           + 0.20 × mention_rate
                           + 0.15 × share_of_voice
                           + 0.15 × position_score
                           + 0.10 × citation_score
                           + 0.05 × sentiment_index )
```

Null components → weight redistributed proportionally across non-null components (documented so a null citation provider doesn't drag the composite). Range 0–100.

### Evidence Score (report-level)
Fraction of a report's claims with attached evidence rows:

```
evidence_score(report) = claims_with_evidence / total_claims
```

Must be 1.0 to publish. Not a trend metric — a quality gate.

## Confidence Score (parser output, not a visibility metric)

Attached to every mention by the parser (`docs/12-ai-guidelines.md`):

```
confidence = 0.5 × extraction_certainty      (parser model's self-reported certainty, 0–1)
           + 0.3 × alias_match_strength      (exact canonical = 1.0, alias = 0.8, fuzzy = 0.4)
           + 0.2 × structural_clarity        (explicit list/recommendation language = 1.0, prose inference = 0.5)
```

Thresholds: `≥ 0.9` auto-accept · `0.7–0.9` accept, spot-check sample · `< 0.7` human review required.

## Change detection (v1.0 — deliberately simple)

A week-over-week delta is **notable** when `|Δ| ≥ 0.10` on a rate metric with `N ≥ 30` per side, and consistent in direction across ≥ 2 providers. Everything else is reported as "within noise". No p-values in v1.0 — repetitions and honesty about noise first; proper inference is a future version.

## Reporting rules

- Every displayed score shows: value, sample size `N`, scoring version, coverage (valid cells / attempted cells).
- Cross-version comparisons are forbidden in UI and reports — charts break/annotate at version boundaries.
- A metric with `N < 10` renders as "insufficient data", never as a number.

## Changelog

| Version | Date | Change |
|---|---|---|
| v1.0 | 2026-07-27 | Initial methodology. |
