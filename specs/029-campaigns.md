# Spec 029 — Campaigns

> Status: done (2026-07-31) — see "Not built"
>
> **Not built (deliberate):** `updateCampaign` (draft field edits — create
> covers current need; edit lands with real usage); member-attach UI on the
> gaps/tasks pages (service accepts members from anywhere; the detail page
> lists them); owner assignment UI (column exists).
> Depends on: specs/007 (interventions), specs/009 (gaps), specs/026 (plans), docs/06
> Branch: `feat/029-campaigns-citations`

## Goal

Group related work into an accountable program with a stated objective and
an honest before/after: "Become recommended for Manhattan luxury seller
prompts" as an object, not a memory. The intervention/verdict machinery
(specs/007) already measures individual actions; campaigns are the missing
**grouping layer** — a named objective + baseline snapshot + target
metrics, with prompts, findings, tasks, interventions, and content assets
attached as members. Deliberately thin: campaigns add no new execution
mechanics and never claim causation — verdict language stays specs/007's.

## Non-goals (this pass)

- Budgets, risks, per-campaign owners beyond one owner field.
- Automatic member attachment or campaign generation.
- Attaching members from the gaps/tasks pages (UI affordance recorded as
  follow-up; the service accepts members from anywhere).
- Experiment objects — interventions already carry hypothesis-shaped
  measurement; formalizing beyond that waits for real usage.

## Data model (migration 034)

- `campaigns` — id, project_id FK, name, objective text NOT NULL,
  hypothesis text, status CHECK (draft|active|completed|abandoned) default
  draft, starts_on date, ends_on date, owner_id FK users, baseline jsonb
  (captured at activation: subject scores by metric from the latest scored
  run + scoring_version + run id + captured_at), target_metrics jsonb
  (`[{metric, target}]`), created_by, created_at, updated_at. Partial
  unique (project_id, lower(name)) where status != 'abandoned'.
- `campaign_members` — campaign_id FK, kind CHECK
  (prompt|gap_finding|task|intervention|content_asset), ref_id uuid,
  added_by, added_at. PK (campaign_id, kind, ref_id). Tenant integrity is
  enforced in the service: a member must resolve to the campaign's project
  through its own table (no cross-table FK can express this).

Rollback: drop both.

## Behavior

- **Activation captures the baseline.** `draft → active` snapshots the
  subject's latest scored-run metrics into `baseline`. No scored run yet →
  activation refuses (a campaign without a baseline cannot report change
  honestly).
- **Progress is computed on read**, never stored: current = subject scores
  from the latest scored run at the same scoring_version; a version
  mismatch renders `not_comparable` (docs/06 rule) rather than a number.
  Deltas reuse the noise-aware language conventions; no causal claims.
- Members: added/removed by staff with audit rows; removal allowed (the
  grouping is organizational, not evidentiary — evidence lives on the
  members themselves).
- Status transitions: draft→active→completed|abandoned; draft→abandoned.
  Completion/abandonment are terminal.

## API (lib/campaigns/service.ts, staff-gated writes, project access)

`createCampaign`, `updateCampaign` (name/objective/hypothesis/targets/
owner/dates, draft only), `transitionCampaign` (activate/complete/
abandon), `addCampaignMember`, `removeCampaignMember`,
`listCampaigns(projectId)`, `campaignDetail(campaignId)` (members with
titles resolved per kind + progress vs baseline). Actions in
`app/campaigns/actions.ts` following the house run-wrapper.

## UI

- `PROJECT_SECTIONS` entry "Campaigns" → `/projects/[id]/campaigns`:
  table (name, status, objective, owner, member count, activated date) +
  create dialog. Empty state explains the grouping model.
- `/projects/[id]/campaigns/[campaignId]`: objective/hypothesis header,
  baseline-vs-current table per target metric (value, target, delta or
  `not comparable`), members grouped by kind, status transitions.

## Acceptance criteria

- [ ] Create draft → activate captures baseline from latest scored run.
- [ ] Activation without a scored run refuses with a clear error.
- [ ] Member from another project is rejected.
- [ ] Progress shows per-metric baseline/current/delta; scoring-version
      mismatch renders not_comparable, never a cross-version delta.
- [ ] client_viewer denied on all writes; audit rows on every mutation.
- [ ] Migration applies and rolls back.

## Test cases

Integration (`tests/integration/campaigns.test.ts`): lifecycle incl.
baseline capture and refusal, member project-mismatch, cross-version
not_comparable, client denial, audit rows.

## Definition of done

Criteria pass · tests green · lint/typecheck clean · migration up+down ·
DECISIONS.md entry if decisions arise · spec updated to done.
