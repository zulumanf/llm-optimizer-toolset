# Spec 001 — Project Management

> Status: done (2026-07-27)
> Depends on: repo scaffolding (auth, layout, migrations working)
> Branch: feat/001-project-management
>
> Implementation notes: prompt-set/run counts hardcoded to 0 in `db/projects.ts`
> until specs 002/003 create those tables (option chosen per the API section).
> Cut from v1: Playwright E2E — covered by integration tests for now, deferred
> to the CI milestone (see DECISIONS.md 2026-07-27). Auth runs in dev mode
> (single local user) until a Supabase project exists.

## Goal
Operators can create, view, edit, and archive **projects** — the container every prompt set, run, competitor, report, and task belongs to. Ships the first end-to-end vertical slice: migration → query layer → server actions → UI → tests.

## User stories
- As an operator, I can create a project with a name and description so work is grouped by initiative.
- As an operator, I can see all projects with status and key counts, and switch between them.
- As an operator, I can edit a project's name/description.
- As an admin, I can archive a project so it leaves active views but loses no data.
- As an operator, I cannot delete a project — ever.

## UI

Projects index (`/projects`):
```
┌──────────────────────────────────────────────────────────────┐
│ Projects                                        [+ New]      │
├──────────────────────────────────────────────────────────────┤
│ Name          Status    Prompt sets  Runs   Created          │
│ Parva Core    ● active  3            12     2026-07-27       │
│ Launch X      ● active  1            2      2026-07-27       │
│ Old Test      ◌ archived 1           1      2026-06-01       │
└──────────────────────────────────────────────────────────────┘
   Row click → /projects/[id].  "Show archived" toggle, off by default.
   Empty state: "No projects yet — create your first project. [+ New]"
```

Create/edit dialog (shadcn Dialog — ≤3 fields so a dialog is fine per `docs/04`):
```
┌ New project ────────────────────────────┐
│ Name        [___________________]       │
│ Description [___________________]       │
│             [Cancel]  [Create]          │
└─────────────────────────────────────────┘
```

Project detail (`/projects/[id]`): header with name/status/description + Edit + Archive (admin, destructive confirm naming the project). Tabbed shell (Prompts · Runs · …) with empty-state placeholders that later specs fill in. Sidebar project-switcher lists active projects.

## Database changes
Migration `001_projects.sql`:
- `projects` table per `docs/03` (id, name unique, description, status enum default 'active', created_at, archived_at).
- `audit_log` table per `docs/03` + insert-only trigger (needed from day one — every spec after this logs to it).
- Rollback: drop both tables (safe — pre-data milestone; later data-bearing migrations follow expand/contract per `docs/09`).

## API (server actions in `app/projects/actions.ts`)

| Action | Input (Zod) | Result | Auth | Audit event |
|---|---|---|---|---|
| `createProject` | `{ name: string 1–80, description?: string ≤500 }` | `{ok, data: project} \| {ok: false, error}` | operator | `project.create` |
| `updateProject` | `{ id: uuid, name?, description? }` | same union | operator | `project.update` |
| `archiveProject` | `{ id: uuid }` | same union | **admin** | `project.archive` |
| `unarchiveProject` | `{ id: uuid }` | same union | **admin** | `project.unarchive` |

Reads via query layer `db/projects.ts`: `listProjects({includeArchived})`, `getProject(id)` with prompt-set/run counts (counts return 0 until later specs create those tables — guard with `to_regclass` or introduce counts in spec 002/003; decide in implementation and note in PR).

## Validation rules
- Name: required, trimmed, 1–80 chars, unique among **non-archived** projects (case-insensitive); duplicate → `conflict` error surfaced inline on the field.
- Description: optional, ≤500 chars.
- Archive: only `active` → `archived`; sets `archived_at`. Unarchive reverses; blocked if name now collides with an active project (prompt rename).
- Edits to archived projects: blocked (`conflict`) except unarchive.

## Edge cases
- Duplicate name differing only by case/whitespace → rejected as duplicate.
- Archiving the currently selected project → switcher falls back to first active project; detail page shows archived banner.
- Zero active projects (all archived) → index empty state still offers "+ New"; switcher shows "No active project".
- Concurrent edit (stale form) → last-write-wins is acceptable at this scale; audit log records both edits.

## Acceptance criteria
- [ ] Operator can create a project and is navigated to its detail page.
- [ ] Duplicate active name is rejected with an inline field error.
- [ ] Editing name/description persists and is audit-logged with user id.
- [ ] Archive requires admin role, requires typed confirm, hides project from default views, and preserves the row (`archived_at` set, nothing deleted).
- [ ] Non-admin calling `archiveProject` gets an authorization error — verified at the server action, not just hidden in UI.
- [ ] All four states per `docs/04` exist on the index: loading skeleton, empty, error with retry, populated.
- [ ] Every mutation writes an `audit_log` row; `audit_log` rejects UPDATE/DELETE (trigger test).

## Test cases
- **Unit:** name validation (trim, length, case-insensitive duplicate), Zod schemas reject bad shapes.
- **Integration:** create → list → update → archive → unarchive round-trip against real Postgres; unique constraint race (two creates, same name — one gets `conflict`); audit-log immutability trigger; role check on archive.
- **E2E (Playwright):** create project via dialog → appears in list and switcher; archive flow with confirm; empty state renders on fresh DB.

## Definition of done
Per `specs/_TEMPLATE.md`: acceptance criteria checked, tests green, lint/typecheck clean, migration up+down verified, `docs/05` unchanged (already describes this), demo on seeded data.
