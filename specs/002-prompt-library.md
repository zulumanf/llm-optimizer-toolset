# Spec 002 — Prompt Library

> Status: ready
> Depends on: specs/001 · docs/07 (freeze semantics)
> Branch: feat/002-prompt-library

## Goal
Author prompts, organize them into sets, and **freeze** sets into immutable versions that runs will reference. This spec delivers the reproducibility cornerstone: after it ships, nothing about a frozen version can ever change.

## User stories
- As an operator, I can create a prompt set inside a project and add/edit/reorder/archive prompts in it.
- As an operator, I can freeze a set, producing version N, and see exactly what each version contains.
- As an operator, I can diff two versions of a set.
- As an operator, I can duplicate a set (or a version) as a starting point for a new set.

## UI

Set detail (`/projects/[id]/prompts/[setId]`):
```
┌──────────────────────────────────────────────────────────────┐
│ Core Visibility Set          [Freeze v4]  [Duplicate] [⋮]    │
│ 12 prompts · last frozen v3 (2026-07-20) · edited since ⚠    │
├──────────────────────────────────────────────────────────────┤
│ ≡ 1  "What are the best tools for …"      recommendation  ⋮  │
│ ≡ 2  "Compare Parva and Acme for …"       comparison      ⋮  │
│ …                                     [+ Add prompt]         │
├──────────────────────────────────────────────────────────────┤
│ Versions: v3 · v2 · v1        (click → read-only view, diff) │
└──────────────────────────────────────────────────────────────┘
```
Freeze confirm dialog shows prompt count + "Version 4 will be immutable forever." Version view is read-only mono-font list with "Diff vs previous" (added/removed/changed prompts, changed shown as text diff).

## Database changes
Migration `002_prompt_library.sql`: `prompt_sets`, `prompts`, `prompt_set_versions` per `docs/03`, plus:
- Insert-only trigger on `prompt_set_versions` (no UPDATE/DELETE).
- Unique `(prompt_set_id, version)`; version assigned in a transaction as `max(version)+1`.
- Rollback: drop tables + triggers.

## API (server actions)

| Action | Input | Auth | Audit |
|---|---|---|---|
| `createPromptSet` | `{ projectId, name 1–80, description? ≤500 }` | operator | `prompt_set.create` |
| `updatePromptSet` / `archivePromptSet` | id + fields / id | operator | `.update` / `.archive` |
| `addPrompt` | `{ setId, text 1–2000, category enum, language? }` | operator | `prompt.add` |
| `updatePrompt` / `archivePrompt` | promptId + fields / promptId | operator | `.update` / `.archive` |
| `reorderPrompts` | `{ setId, orderedPromptIds: uuid[] }` | operator | `prompt.reorder` |
| `freezePromptSet` | `{ setId }` | operator | `prompt_set.freeze` |
| `duplicatePromptSet` | `{ setId \| versionId, newName }` | operator | `prompt_set.duplicate` |

Reads: `listSets(projectId)`, `getSet(setId)` (live prompts + version summaries), `getVersion(versionId)`, `diffVersions(a, b)` (computed in `lib/`, not SQL).

Categories: `recommendation | comparison | how-to | branded | problem` (per `docs/07`), constants in `lib/constants.ts`.

## Validation rules
- Set name unique per project (active sets, case-insensitive). Prompt text required, trimmed, ≤2000 chars; duplicate text within a set → warning, not block (intentional near-duplicates are legitimate).
- Freeze blocked when: set has 0 active prompts ("empty set"); or content is identical to the latest version ("no changes since v N"). Identity = ordered list of (text, category, language).
- `reorderPrompts` must include exactly the set's active prompt ids — anything else is `conflict` (stale UI).
- Archived prompts are excluded from freezing and reordering but remain visible in old versions.

## Edge cases
- Editing prompts after freeze → allowed; banner "edited since v N" (working copy diverges by design, `docs/07`).
- Freeze race (two operators) → transaction + unique constraint; loser gets `conflict` "v N was just created — review and refreeze".
- Deleting a set with versions → archive only; versions remain readable and runnable-against forever.
- A prompt archived then set frozen → not in the new version; still present in old versions (snapshot is jsonb, unaffected).
- Duplicate-from-version → new set's working prompts seeded from the frozen snapshot, no versions carried over.

## Acceptance criteria
- [ ] Freeze produces `prompt_set_versions` row with full jsonb snapshot, sequential version, `frozen_by`, audit event.
- [ ] UPDATE/DELETE on `prompt_set_versions` fails at the DB level (trigger test).
- [ ] Empty-set freeze and no-change freeze are blocked with the specified messages.
- [ ] Version view renders the snapshot even after every live prompt is edited/archived.
- [ ] Diff view correctly shows added/removed/changed between any two versions.
- [ ] Reorder persists and survives reload; stale reorder rejected.
- [ ] All list/detail views have loading/empty/error states.

## Test cases
- **Unit:** freeze-identity comparison (order, text, category changes each detected; whitespace-only edit counts as change? — no: text is trimmed on save, so trimmed-equal = no change); diff algorithm fixtures.
- **Integration:** freeze snapshot fidelity (edit everything post-freeze, version unchanged); concurrent freeze race; immutability trigger; sequential version numbering under concurrency.
- **E2E:** author set → freeze → edit prompt → banner appears → freeze v2 → diff v1..v2 shows the edit.

## Definition of done
Per `specs/_TEMPLATE.md`.
