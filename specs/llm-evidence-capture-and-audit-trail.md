# Spec — LLM Evidence Capture & Audit Trail

> Status: done (2026-07-29) — in-scope items complete; deferrals listed below
> Verified live: drill-down on the real search baseline reproduces stored
> scores exactly with all hashes verified; export package hash-validates.
> Depends on: specs/002–010 · docs/03 · docs/06 · docs/15
> Branch: feat/evidence-audit-trail

## Goal
Every reported metric must be independently inspectable and reproducible:
"recommended in 30% of 100 observations" must open the exact 100
observations — the 30 hits and the 70 misses — each backed by immutable,
hash-verifiable raw evidence and a complete classification history.

## Reconciliation with the existing system (do NOT rebuild)
The requesting blueprint assumes a green field. Most of it exists; adapted
mapping (its name → ours):

| Blueprint entity | Ours | Status |
|---|---|---|
| benchmark_sets / benchmark_prompts / freeze | prompt_sets + prompts + prompt_set_versions (frozen_prompts jsonb) | ✅ specs/002 — freezing, versioning, no post-freeze edits |
| prompt_clusters | prompt categories (recommendation/comparison/how-to/branded/problem) | ✅ adequate v1; cluster metadata (market/intent) deferred to specs/012 vertical packs |
| experiment_runs | runs (trigger, providers jsonb, budget, status) | ✅ specs/003 |
| run_observations | responses (immutable: insert-only trigger, raw_payload verbatim, refusal, error, latency, tokens) | ✅ specs/003 — **missing: capture hashes** → this spec |
| observation_sources | sources + mentions.cited_urls + lib/ai/citations.ts (payload search citations) | ✅ specs/004/005 + search-citations |
| observation_classifications (versioned) | mentions with revision + parser_version, retraction revisions, needs_review | ✅ specs/004 |
| classification_reviews | review queue verdicts (confirm/correct) + audit_log with reason | ✅ specs/004 (correction reason required) |
| audit_log | audit_log (append-only, user, action, detail) | ✅ specs/001 |
| metric_snapshots | scores (versioned, provider-segmented, sample_size) | ✅ specs/005 — **missing: numerator surfacing + drill-down** → this spec |
| evidence_artifacts | — | ❌ new table (this spec) |
| audit_samples | — | ❌ new (this spec) |
| client_validation_runs/observations | — | ❌ new (this spec) |
| evidence_exports | reports CSV route only | ❌ new package export (this spec) |
| holdout prompts | — | ❌ new flag (this spec) |
| stability labels | — | ❌ new (this spec) |

## In scope (this implementation)
1. **Capture-time hashing** — SHA-256 over raw response text and raw payload,
   computed by a Postgres BEFORE INSERT trigger (single canonicalization for
   capture, backfill, and later verification; `hashed_at` stamped). Backfill
   for existing rows runs inside the migration with the immutability trigger
   temporarily disabled — raw content untouched, integrity metadata added;
   recorded in DECISIONS.
2. **Integrity verification** — service that recomputes hashes in SQL and
   reports any response whose stored hash no longer matches (tamper canary).
3. **Metric drill-down** — `lib/evidence/observations.ts` re-derives, for a
   given (run, company, metric, provider), the exact observation list whose
   counts reproduce numerator/denominator; a mismatch with the stored score
   is surfaced, never hidden. Evidence Explorer page with filters
   (positive/negative/mention/recommended/provider/category/review status/
   holdout); header shows `numerator / denominator (value)`; the row count
   always equals the denominator. Dashboard tiles and the competitor matrix
   link into it. Observation detail (existing response page) gains: hashes,
   full classification revision history, and a "RAW EVIDENCE — UNEDITED"
   banner.
4. **Stability labels** — deterministic per-exact-prompt labels (Established
   4–5/5, Emerging 2–3/5, Volatile 1/5, Absent 0/5; proportional mapping at
   other n, always showing k/n) in the explorer's per-prompt view.
5. **Holdout prompts** — `prompts.is_holdout`, carried into frozen_prompts at
   freeze (immutable thereafter — moves after freeze require a new version,
   which freezing already enforces). Standard metrics' eligible set excludes
   holdout observations; holdout results display separately in the explorer.
   No scoring-version bump: with zero holdout prompts in every historical
   run, re-derived values are identical (recorded in DECISIONS).
6. **Seeded audit samples** — deterministic sample from a recorded integer
   seed (mulberry32); must include ≥1 positive, ≥1 negative, and >1 provider
   where available; stored with seed + method so anyone can reproduce the
   selection.
7. **evidence_artifacts** — immutable artifact rows (screenshot/raw_json/
   html/video/export_file) with sha256, stored under `var/evidence/`
   (gitignored), insert-only trigger, no delete path in the app.
8. **Evidence export package** — per run: `manifest.json` (files + sha256 +
   observation ids + versions), `methodology.md` (docs/06 summary +
   versions), `observations.csv`, `classifications.csv`, `sources.csv`,
   `audit-history.csv`, `raw-responses/*.json`; packed with system `tar`
   into a .tar.gz whose own sha256 is recorded as an artifact; download via
   authenticated route handler (same pattern as the reports CSV route).
9. **Client validation runs** — seeded prompt selection + instructions;
   client-performed observations stored in separate tables (never entering
   benchmark metrics), with optional screenshot artifact; directional
   comparison (their hit-rate vs ours) displayed.

## Explicitly deferred (documented, not silently skipped)
- **Consumer-interface capture (browser runner) + screen recordings** — no
  browser runner exists; running one against consumer ChatGPT requires
  credentialed sessions and ToS review. This spec ships the
  `EvidenceCaptureAdapter` TS interface as the integration point; a
  Playwright implementation is its own future spec. Evidence for API runs =
  raw JSON (which IS the complete provider response).
- **Per-client portal auth / RLS** — auth is dev-mode single-user until the
  Supabase milestone (DECISIONS); role gates (admin/operator/viewer) are
  enforced in services now, and every new page is read-only for viewers.
  True client logins land with Supabase auth.
- **Top-three inclusion rate as a stored metric** — displayed in the
  explorer (derived from list_position ≤ 3) but not persisted as a score row
  until the next scoring version bump; adding stored metrics mid-version
  would fragment score sets.
- **Prompt-cluster metadata** (target market/intent/difficulty) → specs/012.

## Assumptions & integration notes
- Hashing in Postgres (`sha256()` built-in, hex-encoded) rather than JS —
  one canonicalization (`response_text` bytes; `raw_payload::text` jsonb
  canonical form) shared by capture, backfill, and verification. JS-side
  hashing would drift from jsonb key ordering.
- `numerator = round(value × sample_size)` is exact for rate metrics (they
  are computed as k/n) — displays derive it live; the drill-down re-counts
  from mentions and flags any divergence from the stored score.
- Artifact storage is the local filesystem (`var/evidence/`), matching the
  single-box internal deployment; signed URLs become relevant only with
  cloud storage (Supabase Storage milestone).
- System `tar` is used for packaging (no new npm deps); macOS/Linux only,
  same as the rest of the tooling.

## Acceptance criteria
- [ ] Every new capture gets response/payload SHA-256 + hashed_at at insert;
      existing rows backfilled; verification service reports zero mismatches
      on untampered data and detects a manual tamper in tests.
- [ ] Every displayed rate links to an explorer view whose row count equals
      the denominator and whose positive count equals the numerator; stored
      score vs re-derived count mismatches are displayed as a warning.
- [ ] Positive and negative observations are equally listed and filterable;
      each opens full raw evidence with hashes and classification history.
- [ ] Stability labels match the deterministic table for n=5 and show k/n
      for all n.
- [ ] Freezing a set locks holdout membership; holdout observations are
      excluded from standard metric denominators and shown separately.
- [ ] Audit samples are reproducible from their recorded seed and satisfy
      the positive/negative/multi-provider constraints when satisfiable.
- [ ] The export package's manifest hashes match the files, the tarball's
      recorded hash matches, and `observations.csv` row counts reproduce the
      reported metrics.
- [ ] Client validation observations live in separate tables and never
      enter benchmark scores; a directional comparison renders.
- [ ] Corrections still only append mention revisions; artifacts and
      validation raw text are insert-only (DB triggers); tests, lint,
      typecheck green.

## Test plan
Unit: stability labels (n=5 table + proportional), seeded sampler
(determinism, constraint satisfaction, graceful degradation when no
positives exist), metric re-derivation math, manifest hashing helper.
Integration: capture→hash presence; tamper detection; drill-down counts ==
stored scores across metrics/providers; holdout exclusion; audit sample
reproducibility; export manifest verification; validation separation;
artifact immutability.
