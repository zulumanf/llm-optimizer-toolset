# Spec NNN — <Feature Name>

> Status: draft | ready | in-progress | done
> Depends on: specs/NNN, docs/NN
> Branch: feat/NNN-<slug>

## Goal
One paragraph: what exists when this is done, and why it matters.

## User stories
- As an operator, I can … so that …

## UI
ASCII mockup(s) of every screen/state this spec adds. Reference `docs/04-ui-design-system.md` components by name. Include loading/empty/error states if non-obvious.

## Database changes
Migration list: new tables/columns/indexes/triggers, referencing `docs/03-database-schema.md`. Include rollback notes.

## API (server actions / routes)
For each action: name, input (Zod shape), result union, authorization, audit-log event.

## Validation rules
Every input constraint, uniqueness rule, and state-transition guard.

## Edge cases
Enumerated, each with the decided behavior — no "TBD" in a `ready` spec.

## Acceptance criteria
- [ ] Checkbox list. Objective, testable statements only.

## Test cases
Concrete unit / integration / E2E cases mapping to the acceptance criteria.

## Definition of done
All acceptance criteria pass · tests written and green · `npm run lint` and `npm run typecheck` clean · migration applies and rolls back · relevant docs updated (`docs/05`, `DECISIONS.md` if decisions were made) · demoed against seeded data.
