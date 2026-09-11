# 08 — Roadmap

> Rewritten 2026-08-18. The original phased plan (specs 001–012) shipped in
> full and then 76 more specs landed on top of it; a week-by-week roadmap
> was the wrong instrument for that cadence. The durable records are
> `specs/` (what was built, in order), `DECISIONS.md` (why), and
> `docs/14-future-ideas.md` (what was deliberately postponed). This file
> now holds only the current phase and the near-term commitments — update
> it when those change, delete entries when they ship.

## Where the platform is (2026-08-18)

Deployed on Railway (web + worker) at app.recommendedfirst.com. The
measurement spine (specs 001–012), truth-hardening program (050–059),
prospect acquisition engine (032, 038, 042–049, 075–081), market packs +
intent universe (046, 082, 087), displacement + citation intelligence
(060, 069, 086, 087), and the technical discoverability engine (083/088)
are all live. Fourteen Jersey City audits are published on branded links
with weekly baselines enrolled.

## Now

- Merge order for parked work: renumber `071_audit_requests.sql` before
  `feat/061-marketing-site` merges (see cleanup backlog).
- Cleanup program batches 1–5 (2026-08-18 audit): migration safety, test
  fixture, consolidations, UI idioms, docs/config truth.
- Prod follow-ups: run `scripts/reclassify-sources.ts` (source taxonomy
  v2) and the first real technical scan (JC Luxury Group) once the worker
  deploys with migrations 081–083.

## Next (committed, not scheduled)

- Prospect-facing audit sections for displacement detail and technical
  discoverability — after real scans calibrate the copy (specs 087/088
  deferred items).
- Crawler-log analytics and entity-footprint checks — deferred from spec
  088 until log ingestion / licensed acquisition exist.
- Wire or retire the four annotated unwired paths: PII erasure, credential
  rotation, evidence artifact capture, BUILD_MAX_ATTEMPTS.

Anything further out lives in `docs/14-future-ideas.md`.
