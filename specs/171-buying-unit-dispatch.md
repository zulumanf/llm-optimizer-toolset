# Spec 171 — Port dispatch policy v2: buying-unit collision replaces the brokerage cap

> Status: implemented (2026-10-30), not committed
> Source: founder directive 2026-09-15; commit 84360fa on the unmerged `feat/143-send-cap-ramp` (send-gate part only)
> Audience: operator (internal); changes which prospect emails may send

## Why

Live week of 2026-10-28: 35 Touch 1 sent, **31 refused**, every one by
`recontact_brokerage` (spec 120: 3 sends per brokerage per market per 30 days).
It treats every independent team under Coldwell Banker, KW, Compass, eXp or
RE/MAX as one buyer. The 2026-09-15 founder decision retired it; the code lived
only on an unmerged branch (DECISIONS 2026-09-25: "15 sends parked because
production still enforces spec 120's per-brokerage cap").

## Change (send gate v6)

- `recontact_buying_unit` (blocks): another prospect of the same canonical
  company already received a cold send, or holds an active/paused sequence.
- `recontact_local_office` (blocks): only for an evidence-backed entry in
  `LOCAL_OFFICE_COLLISION_REGISTRY` (empty today); one send per office per 30 days.
- `brand_concentration` (reports only): today's sends from the same brand
  versus `dailyBrandCap()` (30% of the daily quota).
- Unchanged: person 30-day window, DNC, suppression, territory, daily cap,
  provenance, QA and evidence release.
- `lib/prospects/dispatch-policy.ts` (pure) ported; cohort planner and spend
  guard parts of 84360fa are out of scope.

## Acceptance criteria

- [x] Independent teams under one brand send; a second cold sequence into the
      same canonical business is refused (integration).
- [x] Pure policy unit tests (units, office registry, day planner).
- [x] Full suite, lint, typecheck pass.
