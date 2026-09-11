# Spec NNN — <Feature Name>

> Status: draft | ready | in-progress | done
> Depends on: specs/NNN, docs/NN
> Branch: feat/NNN-<slug>

<!-- Rewritten 2026-08-18 to match the shape recent specs (086–088) actually
converged on. Migration numbers are independent of spec numbers — cite the
spec in the migration's header comment. Sections marked (optional) may be
dropped when they add nothing; the reused/do-not-rebuild section may not. -->

## Goal
One paragraph: what exists when this is done, and why it matters to the
business chain (authority → discoverability → understanding → evidence →
recommendation visibility → measured outcome).

## What is reused (audit result — do not rebuild)
The highest-value section. Before designing, search the repo and list the
existing tables, services, versions, and conventions this spec builds on —
with file paths. Anything listed here must NOT be reimplemented; a reviewer
should be able to reject the PR from this section alone if it duplicates.

## Database changes
Migration list: tables/columns/indexes/CHECKs, with rollback notes. A down
that narrows a CHECK must clean the rows its up enabled. `db/migrations/`
is the schema source of truth — no separate schema doc to update.

## New modules / Extensions
Per module: home (`lib/<domain>/`), the exported version constant
(`<slug>-vN`, `+deterministic` when no LLM), and the derived-vs-stored
decision (derived-on-read is the default; justify persistence).

## UI (optional — "minimal" is a valid answer)
Which surfaces change, which audience each serves (operator / client /
prospect — deny-by-default for the latter two), and which existing
primitives/skills apply. Loading/empty/error states if non-obvious.

## Edge cases
Enumerated, each with the decided behavior — no "TBD" in a `ready` spec.
Unknown data must never become a definitive negative.

## Acceptance criteria
- [ ] Checkbox list. Objective, testable statements only — business
      invariants first, wiring second.

## Definition of done
All acceptance criteria pass · tests green (unit + the integration paths
this touches) · `npm run lint` and `npm run typecheck` clean · migration
applies and rolls back (with data, not just empty-schema) · DECISIONS.md
entry if a non-obvious call was made · deferred items listed explicitly.
