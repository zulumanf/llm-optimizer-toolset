# Spec 006 — Reporting Dashboard

> Status: done (2026-07-27)
> Depends on: specs/005 · docs/06 (reporting rules, evidence score) · docs/13 (REPORT_DRAFTER_V1)
> Branch: feat/006-reporting-dashboard
>
> Implementation notes / recorded cuts: the narrative drafter v1 is
> deterministic templating over the snapshot — fully cited by construction;
> REPORT_DRAFTER_V1 (LLM) lands as a later version when keys exist (same
> pattern as the parser, DECISIONS.md). The evidence gate (validator) is
> enforced at publish regardless of drafter. Export is CSV + the browser's
> print-to-PDF rather than server-rendered PDF (cut recorded). Draft
> generation is synchronous in the action (fast DB assembly) — no
> generate_report job type needed. Charts follow the dataviz method:
> reference palette slots validated against our surfaces, fixed provider→slot
> assignment, one axis per chart, version boundaries annotated. Dashboard
> replaced the project-detail card page as the project home.

## Goal
Two deliverables: (1) the **dashboard** — the project home showing current standing and trends; (2) **reports** — immutable, evidence-linked period snapshots with an AI-drafted narrative that a human edits and publishes.

## User stories
- As an operator, opening a project shows me: latest authority score + delta, recommendation rate trend, provider breakdown, competitor standing, data health (coverage, pending reviews, last baseline status).
- As an operator, I generate a draft report for a period, edit its narrative (never its numbers), and publish it — after which it is locked forever.
- As a reader, every number in a report links to its underlying scores and raw responses.
- As an operator, I export a published report (PDF/CSV).

## UI

Dashboard (`/projects/[id]`):
```
│ ┌Authority──┐ ┌Rec rate──┐ ┌SoV───────┐ ┌Data health────┐    │
│ │ 62  ▲+4   │ │ 42% ▲+3  │ │ 31% –    │ │ ✓ W31 base    │    │
│ │ vs W30    │ │ N=120    │ │ 3 comps  │ │ 0 pending rev │    │
│ └───────────┘ └──────────┘ └──────────┘ └───────────────┘    │
│ [Trend line: authority over runs, per provider, v-annotated] │
│ [Grouped bars: the client vs competitors by provider]             │
│ Recent runs table · Recent notable excerpts                  │
```
Stat tiles per `docs/04` (click → drill down). Every figure shows N + scoring version on hover.

Report editor (`/projects/[id]/reports/[id]`): left = rendered report (summary, by-provider, competitors, notable responses, suggested actions), right = narrative markdown editor for draft sections. Number blocks are rendered components fed from the snapshot — not editable text. Publish button runs the evidence gate and shows a "this becomes immutable" confirm. Published view: read-only + Export.

## Database changes
Migration `006_reports.sql`: `reports`, `evidence` per `docs/03`; trigger locking published reports (UPDATE allowed only `status: draft→published` transition fields; after published, no UPDATE/DELETE). `tasks` table is spec 007 — the "suggested actions" section stores suggestions inside `body` for now.

## Logic
- Draft generation job (`generate_report`): assemble snapshot jsonb (scores for the period, deltas vs previous comparable period, coverage, top excerpts by |delta| contribution) → `REPORT_DRAFTER_V1` narrative with `[score:id]`/`[response:id]` citations → validate: every claim sentence carries ≥1 citation resolvable against the snapshot; uncited claims bounce the draft back with the offending sentences listed (`evidence_score` must be 1.0, `docs/06`).
- Deltas only within same scoring version + same prompt-set version; otherwise the report states "new baseline — no comparable prior period".
- Publish: evidence gate re-run, pending-review check for the period (block or explicit flagged annotation, operator chooses per `docs/05`), then status flip + lock + audit.
- Export: server-rendered PDF (same React components, print CSS) + CSV of the score snapshot.

## API
| Action | Input | Auth | Audit |
|---|---|---|---|
| `generateReportDraft` | `{ projectId, periodStart, periodEnd, title }` | operator | `report.draft` |
| `updateReportNarrative` | `{ reportId, sectionKey, markdown }` (drafts only) | operator | `report.edit` |
| `regenerateDraft` | `{ reportId }` (drafts only; re-snapshots) | operator | `report.regenerate` |
| `publishReport` | `{ reportId }` | operator | `report.publish` |
| `exportReport` | `{ reportId, format: 'pdf' \| 'csv' }` (published only) | operator | `report.export` |

## Validation rules
- Period must contain ≥1 completed run; title 1–120 chars; one draft per (project, period) at a time.
- Narrative edits limited to narrative section keys; snapshot/body numbers rejected server-side.
- Publish blocked while evidence gate fails; publishing with excluded-review flags requires the operator to check an explicit acknowledgment recorded in the audit detail.

## Edge cases
- New data arrives after drafting → draft is stale; banner offers Regenerate (drafts only). Published reports never restate.
- Scoring version changed mid-period → report presents each version's span separately, no blended numbers (`docs/06` cross-version rule).
- A cited response is later re-parsed → citation points at the immutable response + the revision current at snapshot time; report renders identically forever (snapshot is self-contained).
- Empty period metrics (insufficient N) → rendered "insufficient data" exactly as the dashboard does.
- Drafter model outputs an uncited or fabricated figure → validation bounces it; after 2 bounces the section falls back to a plain generated table with no narrative (never publish unverifiable prose).

## Acceptance criteria
- [ ] Dashboard tiles/charts match `scores` exactly on seeded data; every figure exposes N + scoring version; drill-down reaches raw responses (the 1-minute traceability audit passes through the UI).
- [ ] Draft generation produces citation-complete narrative or a listed bounce; evidence score gate provably blocks an uncited claim (test fixture).
- [ ] Published reports reject UPDATE/DELETE at DB level; rendered snapshot is byte-stable (snapshot test).
- [ ] Numbers are not editable through any API path (server-side rejection test).
- [ ] PDF and CSV exports of a published report match the rendered content.
- [ ] Version-boundary annotation appears on all trend charts.

## Test cases
- **Unit:** delta computation incl. no-comparable-period; citation validator (uncited sentence detection); excerpt selection ranking.
- **Integration:** draft→edit→publish→lock lifecycle; stale-draft regeneration; acknowledgment flow for excluded reviews; snapshot self-containment (mutate everything mutable, report render unchanged).
- **E2E:** generate draft (mock drafter) → edit narrative → publish → verify locked + export.
- **Snapshot:** published report render (`docs/09`).

## Definition of done
Per `specs/_TEMPLATE.md`, plus one real weekly report produced for the client and reviewed by the team.
