# Spec 032 — Prospect Acquisition (vertical slice)

> Status: done (2026-08-01) — slice implemented and test-verified; see acceptance checklist
> Depends on: specs/028 (exclusivity) · specs/003–005 (runs/classification/competitors) · specs/014 (auth) · docs/prospect-acquisition-{current-state,gap-analysis,roadmap}.md
> Branch: feat/032-prospect-acquisition

## Goal

Turn existing benchmark evidence into a persisted, human-reviewed acquisition workflow: a market launch holds prospects; a prospect links to real run data for a canonical company; transparent metrics plus verified authority signals produce candidate reality-to-AI findings; a human approves one; the approved finding powers a securely shared audit page, a reply-first outreach draft, and a screen-recording plan; the prospect moves through a pipeline gated by exclusivity checks; everything leaves history. **This module never sends anything, never calls an AI provider, and never fabricates a metric** — the slice is deterministic over data the measurement core already trusts.

## User stories

- As an operator, I can create a market launch and add prospects with provenance-labeled facts, so the target list lives in the platform, not a spreadsheet.
- As an operator, I can link a prospect to a completed run where its canonical company was scored, and see the same metrics the scoring engine stored — with sample sizes.
- As an operator, I can generate candidate findings comparing real-world authority to AI visibility, and approve exactly one primary finding; approval is impossible without linked evidence.
- As an operator, I can publish a prospect audit page and share a high-entropy link that can expire and be revoked; views are tracked.
- As an operator, I can generate, edit (as new versions), and approve a reply-first outreach draft and a screen-recording plan; sends are recorded manually.
- As an admin, I can override a conflict-blocked stage transition with a written rationale; as an operator, I cannot.
- As a client user, I can see none of this, ever.

## UI

- `/prospects` (staff-gated): PageShell; launches table (name, market, status, prospects, owner) + "New launch" dialog; prospects table (name, launch, stage, conflict, owner, next action) + "New prospect" dialog. EmptyStates explain the workflow.
- `/prospects/[id]` (staff-gated): PageHeader (name, stage badge, conflict badge); Sections: Overview (facts + provenance labels), Authority signals (list + add form), Benchmark (link form; metrics StatGrid + competitor comparison table with n), Findings (candidates with evidence counts; approve/reject; primary badge), Audit (publish/preview/copy-link/revoke; view stats), Outreach (draft versions; approve; record-sent), Recording plan (script + storyboard; status select), Pipeline (stage select + history), Activity (timeline).
- `/audit/[token]` (public, anonymous): renders **only** the published snapshot: headline, benchmark overview (market, date range, engines, prompt count, executions, confidence note, limitations), key finding, competitive comparison, prompt evidence excerpts, methodology, low-pressure CTA. No nav, no internal data, noindex.
- Sidebar: global "Prospects" link between Companies and Exclusivity.

## Database changes (migration 038, reversible)

New tables (all with created_at; FKs as noted; indexes on the common filters — launch_id, prospect_id, stage, status):

- `market_launches` — name (unique active), market_id→markets, property_category, price_segment, customer_segment, service_category, target_prospect_count, owner_id→users, status ∈ {researching, benchmarking, outreach_ready, outreach_active, in_conversation, partner_selected, protected, paused, closed}, priority ∈ {1,2,3}, starts_on, target_close_on, exclusivity_model, notes, created_by, archived_at.
- `prospects` — launch_id→market_launches, business_name (unique per launch, active), prospect_type ∈ {brokerage, team, individual_agent, developer, new_dev_marketing}, company_id→companies (nullable; canonical entity), brokerage_affiliation, team_leader, website, email, phone, socials jsonb, neighborhoods text[], specialties text[], price_segment, est_transaction_volume_usd, est_team_size, source ∈ {manual, csv, referral, research}, field_provenance jsonb (field → {verified, publicly_sourced, estimated, manual, ai_inferred}), owner_id, qualification_score 0–100, relationship_strength ∈ {none, weak, warm, strong}, stage (17-stage pipeline, default `identified`), next_action, next_action_on, do_not_contact bool, do_not_contact_reason, conflict_status ∈ {unchecked, clear, possible, partial, direct, blocked, override}, last_exclusivity_check_id→exclusivity_checks, notes, created_by, archived_at.
- `prospect_authority_signals` — prospect_id, kind (enumerated signal types), label, value_number, value_text, source_url, provenance (same enum), confidence 0–1, notes, created_by.
- `prospect_benchmarks` — prospect_id, run_id→runs, company_id→companies, note, created_by; unique (prospect_id, run_id). Metrics are **computed on read** from `scores`/`mentions` — never stored here.
- `prospect_findings` — prospect_id, benchmark_id→prospect_benchmarks, kind ∈ {authority_visibility_gap, competitor_contrast, absence, citation_gap}, title, explanation, metrics jsonb, signal_ids uuid[], response_ids uuid[], competitor_company_ids uuid[], confidence, severity ∈ {low, medium, high}, business_relevance, suggested_angle, rank_score, generator_version, status ∈ {candidate, approved, rejected, archived}, is_primary bool, reviewed_by, reviewed_at. **CHECK: status='approved' ⇒ response_ids non-empty.** Partial unique: one (prospect_id) where is_primary and status='approved'.
- `prospect_audits` — prospect_id, finding_id→prospect_findings, headline, snapshot jsonb, status ∈ {draft, published, revoked}, access_token (unique, 256-bit base64url, set at publish), expires_at, published_by/at, revoked_by/at, revoke_reason, created_by. **Trigger: published audits allow only revocation fields + status to change.**
- `prospect_audit_views` — audit_id, viewed_at, ip, user_agent, is_internal. **Insert-only (forbid_mutation).**
- `outreach_drafts` — prospect_id, finding_id, channel ∈ {email, linkedin_message, followup_email, warm_intro}, version, parent_id→outreach_drafts, subject, body, tone, cta, generated_by ∈ {system, operator}, model, prompt_version, status ∈ {draft, approved, superseded}, approved_by/at, sent_recorded_at/by, created_by. **Trigger: approved drafts allow only status→superseded and sent_recorded fields to change.**
- `screen_recording_plans` — prospect_id, finding_id, script, storyboard jsonb, estimated_duration_seconds, claims_to_verify jsonb, cta, status ∈ {not_started, script_ready, recorded, sent, viewed, replied, meeting_booked}, generator_version, created_by, updated_at.
- `prospect_stage_history` — prospect_id, from_stage, to_stage, reason, exclusivity_check_id, changed_by, changed_at. **Insert-only.**
- `prospect_activities` — prospect_id, kind, detail jsonb, actor_id (nullable — audit views are anonymous), occurred_at. **Insert-only.**

Rollback drops the 11 tables and their triggers.

## API (server actions → lib/prospects/service.ts, all staff-only via assertCanWrite; audits/overrides admin where noted)

| Action | Input (Zod) | Audit event |
|---|---|---|
| createLaunch / updateLaunchStatus | launch fields / {launchId, status} | launch.create / launch.status |
| createProspect / updateProspect | prospect fields | prospect.create / prospect.update |
| addAuthoritySignal | {prospectId, kind, label, provenance, sourceUrl?, …} | prospect.signal_add |
| linkBenchmark | {prospectId, runId} — run must be completed/partial **and** have scores for the prospect's company | prospect.benchmark_link |
| generateFindings | {prospectId, benchmarkId} — deterministic, replaces prior candidates | prospect.findings_generate |
| reviewFinding | {findingId, decision: approved\|rejected, makePrimary?} | prospect.finding_review |
| publishAudit | {prospectId, expiresAt?} — requires a primary approved finding; builds snapshot; mints token | prospect.audit_publish |
| revokeAudit | {auditId, reason} | prospect.audit_revoke |
| createOutreachDraft / approveOutreachDraft / recordDraftSent | draft fields / {draftId} / {draftId} | prospect.draft_* |
| generateRecordingPlan / setRecordingStatus | {prospectId} / {planId, status} | prospect.recording_* |
| transitionStage | {prospectId, toStage, reason?, override?, overrideRationale?} | prospect.stage_change |
| addActivityNote | {prospectId, note} | prospect.note |

Public (no auth): `getAuditByToken(token)` — published ∧ not revoked ∧ not expired, else null (page 404s); records a view row.

## Validation rules

- Every input validated with Zod in the service; unknown → validation failure with first message.
- `transitionStage`: target must be a known stage; stages at or past `outreach_ready` require `conflict_status ∈ {clear, override}`; `do_not_contact` prospects cannot enter contact stages (`contacted`+); `blocked` conflict requires admin + rationale to proceed (recorded as override on the prospect and in history).
- The exclusivity check runs inside `transitionStage` when entering `qualified`→beyond, via `detectConflicts` against the launch's market; the resulting check row id is stored on the prospect and in stage history.
- `reviewFinding(approved)`: finding must have ≥1 response id and (for authority-contrast kinds) ≥1 signal id; title+explanation must not contain prohibited revenue/causality phrasing (`PROHIBITED_PHRASES`).
- `approveOutreachDraft`: body must reference the approved primary finding's prospect; prohibited phrasing blocked; `do_not_contact` blocks approval and record-sent.
- `publishAudit`: snapshot is built server-side from the approved finding + benchmark reads; internal fields (notes, qualification score, owner, rationale, competitor internal data beyond published metrics) are never included; token minted with `crypto.randomBytes(32)`.
- `recordDraftSent`: allowed only on approved drafts, once.

## Edge cases

- Prospect without `company_id` → linkBenchmark fails with guidance ("create/link the canonical company first").
- Run parsed but prospect company has no `scores` rows → refuse link (honest: "not scored in this run").
- Two audits: publishing while a published audit exists → conflict (revoke first).
- Expired token → 404 (same as revoked/garbage — no oracle).
- Approving a second finding as primary → previous primary loses `is_primary` in the same transaction.
- Editing an approved draft → creates version n+1 (status draft), previous stays approved until the new one is approved (then superseded).
- Deleting is not supported anywhere — archive only.

## Acceptance criteria

- [x] Migration 038 applies and rolls back cleanly (verified `up`/`down`/`up` on the test DB; applied to dev DB).
- [x] Full slice flow works against a real database (tests/integration/prospects.test.ts, 9 cases).
- [x] Client-role users are denied on every prospect surface (404/denial), and no `/prospects` data is reachable from the portal.
- [x] Audit tokens are ≥256-bit, non-sequential; revoked/expired tokens stop working immediately.
- [x] Approved findings always link to real response evidence; approval without evidence is impossible (DB CHECK + service).
- [x] Prohibited revenue-claim phrasing cannot be approved in findings or drafts.
- [x] Benchmark metrics shown equal the `scores` rows for that run/company (no reimplementation drift — read, not recomputed).
- [x] Stage transitions are transactional, gated by exclusivity, and produce history + activity + audit rows.
- [x] do_not_contact prospects cannot have drafts approved/recorded-sent or enter contact stages.
- [x] Published audit snapshots contain no internal notes; render page uses only the snapshot.
- [x] `npm run lint`, `npm run typecheck`, unit + integration tests pass (1166 tests, 82 files, full suite green 2026-08-01).

## Test cases

Unit (`tests/unit/prospect-findings.test.ts`, `prospect-stages.test.ts`): candidate generator produces evidence-linked candidates with safe wording and stable ranking; wording validator catches prohibited phrases; stage-gate logic (order, conflict gates, do_not_contact gates) as a pure function.

Integration (`tests/integration/prospects.test.ts`): seeds a project + companies + run + responses + mentions + scores, then exercises: launch/prospect creation; signal add; benchmark link (including refusal for unscored company); findings generate/approve (evidence + wording enforcement, primary uniqueness); audit publish/token fetch/view recording/revoke/expiry; draft version/approve/record-sent (+ do_not_contact block); recording plan; stage transitions (conflict block, admin override with rationale, history rows); client_viewer denial on every action; insert-only triggers on views/history/activities.

## Definition of done

All acceptance criteria pass · tests green · lint/typecheck clean · migration reversible · `docs/prospect-acquisition-*.md` current · decisions appended to `DECISIONS.md`.
