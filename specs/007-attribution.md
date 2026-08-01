# Spec 007 — Attribution

> Status: done (2026-07-27)
> Depends on: specs/006 · docs/07 (intervention experiments) · docs/06 (change detection)
> Branch: feat/007-attribution
>
> Implementation notes: verdicts are computed on read (never stored/editable);
> the ≥2-provider direction-consistency rule means single-provider setups can
> never reach "notable" — by design per docs/06. Authority gets deltas only
> (no noise verdict, including no "insufficient"). Confound window: shipped
> dates within 84 days on the same frozen version, mutually flagged. Post runs
> reuse the latest baseline's exact provider config; instrument_changed flags
> config drift. Task suggestions from report "suggested actions" are cut
> (suggest-from-verdicts ships; reports keep suggestions as narrative).
> Scheduling uses the jobs queue's run_after — no separate scheduler.

## Goal
Close the loop: record **interventions** (things the client ships in the world — content, docs, PR), tie them to before/after measurement windows on frozen prompt sets, apply the change-detection rule, and manage **tasks** (suggested from findings, human-approved, evidence-linked) whose completion becomes the next intervention. After this spec, the system answers: *"did what we did move AI answers?"*

## User stories
- As an operator, I record an intervention (what shipped, when, URLs, which prompt set it targets).
- As an operator, I see an attribution view per intervention: baseline runs vs post runs (+2/+6/+12 weeks) on the same frozen version, with the change-detection verdict per metric.
- As an operator, findings (from reports or attribution views) become suggested tasks with evidence attached; I approve, work, and complete them; completing a task can spawn its intervention record.
- As the system, I schedule the post-intervention re-runs automatically and label them.

## UI

Intervention detail (`/projects/[id]/interventions/[id]`):
```
│ Comparison page: Lumina vs Acme       shipped 2026-08-03     │
│ Targets: set "Comparison" v2 · URLs: lumina.com/vs/acme      │
│ Baseline: runs W30, W31   Post: W33 ✓, W37 (scheduled), W43  │
│ ┌Verdict───────────────────────────────────────────────────┐ │
│ │ rec_rate  +0.12  N=120/120  2/2 providers ↑  → NOTABLE   │ │
│ │ mention   +0.04                              → within    │ │
│ │           noise                                          │ │
│ │ ⚠ confounded: intervention "Docs overhaul" overlaps      │ │
│ └──────────────────────────────────────────────────────────┘ │
```
Tasks board (`/projects/[id]/tasks`): columns suggested / approved / in progress / done, cards showing priority + evidence chips (click → underlying score/response/report). Rejected collapsed. "Complete task" offers "record as intervention?".

## Database changes
Migration `007_attribution.sql`:
- `interventions`: id, project_id, title, description, shipped_at (date), urls text[], prompt_set_version_id fk, created_by, created_at, archived_at.
- `intervention_runs` join: intervention_id, run_id, role enum(baseline, post), offset_label text ('+2w' …).
- `tasks` per `docs/03` (evidence_ids non-empty enforced for `suggested`); `task_id` nullable fk on interventions (task that spawned it).
- Scheduled post-runs: rows in `jobs` with `run_after` (reuses spec 003 queue — no new scheduler).

## Logic
- Creating an intervention with a target version + shipped date auto-proposes: baseline = the ≥2 most recent completed runs of that version before shipped_at (protocol requires ≥2, ≥1 week apart — warn and mark `baseline_weak` if unmet); schedules post runs at +2/+6/+12 weeks (operator can toggle each).
- Verdict per metric via `docs/06` change detection (|Δ| ≥ 0.10, N ≥ 30/side, direction-consistent across ≥2 providers), comparing pooled baseline vs each post run, same scoring version only.
- Confound detection: another intervention on the same prompt set with an overlapping window → both attribution views carry a permanent "confounded with X" flag (`docs/07`).
- Task suggestions: generated from report "suggested actions" and from attribution verdicts (e.g., competitor leads position score on provider Y → suggested task with the supporting score/excerpt evidence). Suggestions are created `suggested` and never auto-approved (`PRINCIPLES.md` #8).

## API
| Action | Input | Auth | Audit |
|---|---|---|---|
| `createIntervention` | `{ projectId, title, description?, shippedAt, urls?, promptSetVersionId, taskId? }` | operator | `intervention.create` |
| `updateInterventionSchedule` | `{ interventionId, postOffsets: subset of ['+2w','+6w','+12w'] }` | operator | `intervention.schedule` |
| `suggestTask` | `{ projectId, title, description, priority, evidenceIds ≥1 }` | system/operator | `task.suggest` |
| `approveTask` / `rejectTask` | `{ taskId, note? }` | operator | `task.approve` / `.reject` |
| `updateTaskStatus` | `{ taskId, status: in_progress \| done }` (approved+ only) | operator | `task.status` |
| `completeTaskAsIntervention` | `{ taskId, shippedAt, urls, promptSetVersionId }` | operator | `task.complete_as_intervention` |

## Validation rules
- shipped_at not in the future by more than 7 days; target version must have ≥1 completed run (else nothing to baseline — warn, allow, mark).
- Evidence ids must resolve to existing evidence rows; tasks cannot enter `in_progress` without `approved_by`.
- Scheduled post runs use the exact same frozen version and provider config as the latest baseline run (protocol: same instrument); config drift (model retired) → run proceeds with the replacement but the verdict is flagged `instrument_changed`.
- Verdicts are computed, never editable; the narrative around them is.

## Edge cases
- Post run lands `partial` below N≥30 → verdict "insufficient data", never a direction.
- Operator deletes/archives target set → intervention keeps functioning (references the immutable version).
- Two interventions same set, overlapping windows → both flagged confounded (no silent averaging).
- Scoring version bumped between baseline and post → verdict refuses cross-version comparison; offers re-scoring both sides under the new version as additional rows (`docs/06`), verdict computed on the matched pair only.
- Task evidence points at a report later superseded → fine; evidence targets immutable rows (`docs/05`).
- Model retired mid-experiment → `instrument_changed` flag; report language auto-includes the caveat.

## Acceptance criteria
- [ ] Creating an intervention proposes correct baselines from seeded history and schedules +2/+6/+12 jobs with the frozen config.
- [ ] Scheduled post runs execute via the existing queue, labeled and joined to the intervention.
- [ ] Verdicts match hand-computed change-detection fixtures, including within-noise, insufficient-data, and cross-version-refusal cases.
- [ ] Overlapping interventions are mutually flagged confounded, permanently.
- [ ] A suggested task cannot exist without evidence; cannot start without approval; the full suggested→approved→done→intervention loop works end-to-end.
- [ ] Attribution view drill-down reaches raw responses (traceability audit passes).

## Test cases
- **Unit:** change-detection rule fixtures (thresholds, provider consistency, pooled baseline math); baseline auto-proposal (recency, ≥1-week-apart, weak-baseline flag); confound overlap detection.
- **Integration:** intervention → scheduled jobs → post run → verdict pipeline on mock provider; instrument-change flagging; task state machine guards.
- **E2E:** record intervention → see baseline + schedule → (simulate time via seeded run) → verdict renders; suggest→approve→complete task as intervention.

## Definition of done
Per `specs/_TEMPLATE.md`, plus: one real intervention recorded for the client with its baseline captured — the loop is live.
