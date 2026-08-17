# Spec 078 — Magnitude-Aware Authority Scoring

> Status: implemented — acceptance criteria verified 2026-08-17
> Depends on: specs/038 (authority profile), specs/039 (final score), specs/045 (weight sets), migration 074 (source_type), docs/06-scoring-methodology.md
> Branch: feat/078-magnitude-aware-authority

## Why

The operator asked why 20 prospects cluster at 35–39. The trace: the
authority profile scores *kinds of evidence* at fixed points (verified
volume = 12, count = 8, ranking = 15), blind to the numbers inside them —
so Brian Spain ($23.3M, #3) and Properties by Southern ($219.3M, #1) both
land on 12+8+15 = 35. Presence-based scoring was the honest v1 while
magnitudes were sparse; production now has values on 15/17 volumes, 16/16
counts, and 13/14 rankings. A prioritisation score that cannot tell a
$219M team from a $23M one is leaving its best signal on the table.

## Goal

`authority-v2`: evidence points scale with the magnitude the signal
records, inside the existing per-kind points and per-component caps, with
every factor a named constant and every discount visible in the stored
breakdown. Kinds without magnitude semantics are unchanged. The composite
becomes `prospect-score-v3`. Old stored scores keep their stamped
versions; re-scoring is forward-only (docs/06 versioning rules).

## Design

Effective points become
`kindPoints × magnitudeFactor(kind, valueNumber) × provenanceFactor × confidence`.

`magnitudeFactor` (all constants exported from lib/prospects/authority.ts):

| Kind | Full points at | Curve | Missing value |
|---|---|---|---|
| transaction_volume | ≥ $100M local closed volume | log₁₀ scaled from $1M, floored at ⅓ | floor (⅓) |
| transaction_count | ≥ 200 sides | log₁₀ scaled from 1, floored at ⅓ | floor (⅓) |
| avg_deal_value | ≥ $2M | linear, floored at ⅓ | floor (⅓) |
| review_footprint | ≥ 100 reviews | log₁₀ scaled from 1, floored at ⅓ | floor (⅓) |
| ranking (valueNumber = the rank) | #1 → 1.0 | bands: ≤1: 1.0 · ≤3: 0.87 · ≤10: 0.73 · ≤25: 0.6 | 0.5 |
| all other kinds | — | 1.0 (no magnitude semantics) | 1.0 |

Rationale for the shapes: log curves because production is log-distributed
(a $10M→$20M jump matters more than $150M→$160M); floors because a
quantified-but-small fact still outranks no fact, and a MISSING number
must never outscore a small one (else the incentive is to omit numbers);
ranking bands because rank is ordinal, not linear.

- Missing-value floor equals the curve floor — an unquantified receipt
  scores as the smallest quantified one, never better.
- `AUTHORITY_PROFILE_VERSION` → `authority-v2`;
  `PROSPECT_SCORE_VERSION` → `prospect-score-v3`. Weight set untouched.
- `loadSignals` (lib/prospects/gap.ts) passes `valueNumber` through;
  `AuthoritySignalInput` gains the optional field.
- Max-per-kind, provenance factors, scope/derived exclusions, component
  caps, and confidence math are all unchanged.

## Expected effect on the live cohort (hand-computed)

Properties by Southern ($219M/#1) holds ≈37.6; Brian Spain ($23.3M/#3)
moves to ≈26; Kate Liu ($20.8M/#4) ≈23.7 — the pack spreads by verified
production instead of clustering at the receipt-type ceiling.

## Out of scope

- New weights per component (spec 045 weight sets already own that).
- Magnitude semantics for awards/press/notable sales (no honest scale yet).
- Backfilling valueNumbers (2 volumes, 1 ranking lack them — operator task).

## Acceptance criteria

- [x] magnitudeFactor known-answer tests: curve values, floors, rank
      bands, missing-value behavior, and monotonicity (bigger value never
      scores less) (unit).
- [x] A missing value never outscores a present one of any size (unit).
- [x] Kinds without magnitude semantics score exactly as in authority-v1
      (unit, existing cases updated with explicit saturating values).
- [x] Component caps still bind; profile version stamps authority-v2 and
      composite stamps prospect-score-v3 (unit/integration).
- [x] Full-cohort recompute in production spreads the 14 audit prospects'
      scores (verified post-deploy, before/after recorded in the PR).

## Definition of done

All criteria pass · tests green · lint/typecheck clean · docs/06 gains the
magnitude table · DECISIONS.md entry · production recompute executed and
reported.
