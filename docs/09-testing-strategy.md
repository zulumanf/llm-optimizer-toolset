# 09 — Testing Strategy

Philosophy: **the numbers must be right.** This is a measurement instrument; a UI glitch is annoying, a wrong score is product failure. Test effort concentrates on scoring, parsing, and data invariants.

Stack: **Vitest** (unit/integration) · Testcontainers-style disposable Postgres (or Supabase local) for integration · CI runs lint + typecheck + all tests on every PR; red CI blocks merge.

## Unit tests (`tests/unit/`)
- **Every scoring function** (`lib/scoring/`): known-answer fixtures — hand-computed inputs → exact expected outputs, including edge cases: N=0, all-errored cells, null components and weight redistribution, insufficient-data thresholds.
- **Every parser function** (`lib/parsing/`): alias matching (exact/alias/fuzzy/collision), confidence formula, position extraction.
- **Every provider payload parser** (`lib/ai/payloads.ts`): each known response shape, plus the unknown-shape path — an unrecognised payload must be flagged, never read as an empty answer (`tests/unit/ai-payloads.test.ts`).
- **Every document extractor** (`lib/knowledge/sources/extractors/`): real generated PDF and XLSX bytes, not mocked parsers (`tests/unit/knowledge-documents.test.ts`).
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

## E2E (Playwright, `tests/e2e/`) — NOT BUILT

Planned, never implemented. There is no `tests/e2e/` directory, no Playwright
dependency, and no `test:e2e` script. This section described an intention, and
until 2026-07-30 the README advertised the suite as if it existed — which is
the kind of unearned claim `PRINCIPLES.md` #5 exists to prevent, applied to our
own tooling rather than to a measurement.

The three flows below remain the right ones to build first, against a seeded
local stack with the **mock AI provider** (deterministic canned responses — E2E
must never spend provider tokens):
1. Create project → prompt set → freeze → run → see captured responses
2. Review queue: correct a mention → revision recorded
3. Publish report → verify locked

What covers this ground today: `tests/integration/workflow-e2e.test.ts` drives
a full workflow graph end to end at the service layer. That is not a substitute
— it never renders a page or exercises a server action through the UI — but it
does mean the critical paths are not unverified, only unverified *through the
browser*.

## Performance tests
Lightweight checks, not a rig: dashboard queries < 500ms on a seeded 100k-response dataset; worker throughput logged per run. Revisit only when real numbers degrade.

## Manual QA
Before each milestone ships: run the real weekly baseline end-to-end, spot-audit 10 random scores back to raw responses (the 1-minute traceability check from the PRD), review one report for evidence completeness.

## What we deliberately don't test
- shadcn/ui internals, Next.js framework behavior
- Live provider APIs in CI (adapters are tested against recorded payloads; a nightly *manual* smoke run hits real APIs)
