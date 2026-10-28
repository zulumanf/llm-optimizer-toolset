# Spec 166 — Seller-intent prompt set v2 (≈ 48 calls per market instead of 256)

> Status: pilot (2026-10-27). Generator change only after the pilot passes.
> Depends on: specs/124 (competitive mismatch), specs/136 (evidence release), docs/07-experiment-protocol.md
> Audience: operator (internal). Changes what prospect emails are based on.

## Why

Evidence from the 2026-10-27 refresh (8 markets, ~1,900 OpenAI answers):

- City-wide seller questions name ~3 agents per answer; neighborhood ×
  property-type questions name ~0.6, and are 85% of the 256 calls.
- The three property types come from `research.propertyTypes.slice(0,3)`
  (`lib/markets/research.ts:89`) and produce combinations sellers don't ask
  ("historic home in Millard"); their lists differ no more than repeat asks.
- Any single answer is noisy: 60–70% of agents named appear in 1 of 4 asks.
  The signal is frequency across asks of the right questions.
- 64 × 4 was never decided (default in `lib/markets/bootstrap.ts:43`).
- Cost: $4.70 per market; most of it buys low-signal answers.

## Design (v2, per market)

| Block | Prompts | Reps |
|---|---|---|
| City seller core | 6: best listing agents; who to sell my house with; who gets the highest price; who sells fastest; best real estate teams; best luxury listing agent — each "in {city}" | 4 |
| Neighborhood seller | 6: "Who is the best real estate agent to sell my home in {neighborhood}, {city}?" for the pack's first 6 neighborhoods | 4 |

12 prompts × 4 reps = 48 OpenAI calls (~$0.90). Reps stay 4 so v1/v2 differ in
prompts only. Buyer, "specializes in" and property-type variants are dropped.
v2 is a new frozen prompt set version (protocol: never edit a frozen set).

## Pilot (this spec's first deliverable)

Run v2 on Omaha, Reno and Kansas City, which have fresh v1 runs from
2026-10-27, through the same scoring, findings and mismatch code. Compare per
market:

1. Prospects with an approved finding / passing `MISMATCH_THRESHOLDS` under v1
   vs v2 (the counts are absolute: `minRecommendationGap 2`,
   `FOLLOWUP_SEVERAL_QUESTIONS_MIN 3`, `MIN_RESPONSES_FOR_FINDINGS 5`).
2. Overlap of the top-10 recommended agents (v1 vs v2).
3. Recommendations per call.

**Pass:** v2 qualifies ≥ 80% of the prospects v1 qualifies, top-10 overlap ≥ 60%,
and recommendations per call ≥ 2× v1. Otherwise adjust (e.g. reps 5) and re-pilot.

## After a pass

- `standardTemplates` / `expandMarketPack`: v2 templates, `MAX_MARKET_PROMPTS`
  and the bootstrap default become 12; property-type expansion off for T1.
- Refreshes use v2 (new baseline per market).
- Update "64 × 4" copy: `lib/marketing/evaluation.ts:5`, `vendors.ts:48`,
  `faq.ts:30`, `approved-claims.json`.
- Phase 2: per-prospect neighborhoods (2–3 ZIPs/areas) via the existing
  `neighborhoods` filter in `lib/markets/generate.ts:72` once collected.

## Acceptance criteria (pilot)

- [ ] v2 prompt sets frozen in the three market projects; runs labelled
      `T1 v2 pilot 2026-10-27: <market>`; OpenAI only.
- [ ] Comparison table recorded here and in `DECISIONS.md`.
- [ ] No outreach draft is created from pilot runs.
