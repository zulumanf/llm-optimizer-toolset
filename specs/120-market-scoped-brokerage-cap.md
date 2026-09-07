# Spec 120 — Market-scoped brokerage send cap

Status: implementing
Branch: feat/120-market-scoped-brokerage-cap

## Why

The spec-052 brokerage cap (3 sends / brokerage / 30 days) matches the
`brokerage_affiliation` string globally across every market. Luxury teams
concentrate in national brands, so by 2026-08-25 Compass, Coldwell Banker
Realty, and eXp were 3/3 nationwide and 14 of 15 approved initial drafts were
gate-blocked — including prospects in markets where that brand had received
zero sends. The risk the cap guards against (several intrusions into one
actual office in one week) is market-local; Compass Jersey City and Compass
Savannah share only the brand. Operator decision 2026-08-25: scope the cap
per market.

Second defect, same check: naming variants dodge the cap — "Long & Foster
Real Estate Inc." and "Carriage Properties, LLC." don't match their plain
forms, so the cap can be bypassed by a suffix.

## What

1. The `recontact_brokerage` gate counts prior sends only within the
   prospect's own `launch_id` (one launch = one metro market). The cap value
   (3) and window (30d) are unchanged.
2. Both sides of the comparison are normalized: lowercase, trim, cut
   everything from the first comma, cut a trailing " inc"/" llc" token
   (optional period). "Long & Foster Real Estate Inc." now matches
   "Long & Foster Real Estate"; "Compass GA LLC" → "compass ga" stays
   distinct from "Compass" (different licensee — intended).
3. Normalization is one pure exported function (`normalizeBrokerage`) whose
   regexes are shared with the SQL expression, unit-tested.

## Acceptance

- Existing spec-052 test (3 same-launch sends refuse the 4th) still passes.
- New: 3 sends to the same brokerage in a DIFFERENT launch do not refuse.
- New: a suffix variant ("… Inc.") counts toward the same cap bucket.
- `normalizeBrokerage` unit tests cover comma cut, inc/llc cut, no-op cases.
- Lint + typecheck clean. Policy constants unchanged.
