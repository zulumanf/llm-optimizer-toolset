# 09 — Testing Strategy

Philosophy: **the numbers must be right.** This is a measurement instrument; a UI glitch is annoying, a wrong score is product failure. Test effort concentrates on scoring, parsing, and data invariants.

Stack: **Vitest** (unit/integration) · **Playwright** (E2E) · Testcontainers-style disposable Postgres (or Supabase local) for integration · CI runs lint + typecheck + all tests on every PR; red CI blocks merge.

## Unit tests (`tests/unit/`)
- **Every scoring function** (`lib/scoring/`): known-answer fixtures — hand-computed inputs → exact expected outputs, including edge cases: N=0, all-errored cells, null components and weight redistribution, insufficient-data thresholds.
- **Every parser function** (`lib/parsing/`): alias matching (exact/alias/fuzzy/collision), confidence formula, position extraction.
- Utilities, validation schemas.
- Pure functions only — no DB, no network, no mocks of our own code.

## Integration tests (`tests/integration/`)
- Query layer against a real disposable Postgres.
- **Immutability invariants as tests:** UPDATE/DELETE on `responses` must throw; published `reports` locked; mention corrections create revisions and never mutate originals.
- Job queue: idempotency (same job twice → no duplicate rows), crash-resume, retry/backoff.
- Server actions end-to-end against the DB: freeze flow, run creation, review flow.

## AI parser tests (`tests/fixtures/responses/`)
- A growing corpus of **real captured provider responses** (sanitized) as fixtures — every classification bug becomes a fixture before it becomes a fix.
- Parser accuracy harness: run parser vs. human-labeled fixture set; CI fails if precision/recall drops below the floor (start: 0.90 precision on `mentioned`).
- Provider response-shape tests: each `lib/ai/` adapter parses current known payload shapes; unknown shape → captured raw + flagged, never silently dropped.

## Snapshot tests
- Report rendering: a published report body → stable snapshot (immutability made visible).
- Parser output snapshots per fixture (any drift is reviewed, not auto-accepted).

## Migration tests
- Every migration applies **and** rolls back cleanly on CI against a seeded database.
- Rollback of a data-bearing migration must not lose experiment data — if it would, the migration is redesigned (expand-migrate-contract).

## E2E (Playwright, `tests/e2e/`)
Thin but real, against a seeded local stack with a **mock AI provider** (deterministic canned responses — E2E never spends provider tokens):
1. Create project → prompt set → freeze → run → see captured responses
2. Review queue: correct a mention → revision recorded
3. Publish report → verify locked

## Performance tests
Lightweight checks, not a rig: dashboard queries < 500ms on a seeded 100k-response dataset; worker throughput logged per run. Revisit only when real numbers degrade.

## Manual QA
Before each milestone ships: run the real weekly baseline end-to-end, spot-audit 10 random scores back to raw responses (the 1-minute traceability check from the PRD), review one report for evidence completeness.

## What we deliberately don't test
- shadcn/ui internals, Next.js framework behavior
- Live provider APIs in CI (adapters are tested against recorded payloads; a nightly *manual* smoke run hits real APIs)
