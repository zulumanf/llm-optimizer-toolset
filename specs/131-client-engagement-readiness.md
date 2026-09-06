# Spec 131 — Client engagement readiness (first paying client)

> Status: implemented 2026-09-05 (readiness audit + smallest coherent build)
> Depends on: 057 (promotion), 028/052 (exclusivity), 007/062 (tasks, interventions, comparability), 031 (portal), 054 (shared market captures), 124/127/128/130 (mismatch evidence, frozen Touch 1, corrections), 020 (billing_events, encrypted credentials)
> Fixture: Ryan Ogle / Blu House Properties, Grand Rapids, 90 days, $7,500/month, $22,500

## Goal
When a prospect signs, the OS can represent the engagement commercially, protect the market, freeze an immutable baseline over the corrected pre-sale evidence, hold the work with provenance and client approvals, remeasure on the same instrument, report weekly, and renew or offboard — without inventing a process on the day. The product is MEASURE → DIAGNOSE → CHANGE → REMEASURE with every claim traceable.

## Audit findings that drove the build (2026-09-05)
- **No commercial record.** `projects` carried only `contract_value_usd` / `service_tier`; no term, fee, contract, payment, renewal or permissions state. `billing_events` existed but had no writer outside automation. → `client_engagements`.
- **Baseline continuity broke for shared-capture prospects.** Ryan's 64-question / 256-answer OpenAI benchmark is run `68ed325d` on the shared "Market benchmark: Grand Rapids" project (20 prospects share it); `benchmark_project_id` is null, so promotion would create an empty client project and the first report would have no comparable prior. → `engagement_measurements` freezes a baseline package over ANY finished run (counts, denominator, per-question rows, raw answer ids, aliases, methodology versions); a DB trigger makes a frozen snapshot immutable.
- **Exclusivity was gated at `outreach_ready` only.** Prospects already past the gate (Grand Rapids: 1 contacted, 18 identified, sequences queued) would keep receiving sends after a client signed. → the spec 052 send-time territory re-check already inside `sendProspectDraft` is kept as the ONE gate and extended so the client's own promoted prospect is exempt (`detectLaunchConflicts` `exceptProjectId`); plus a founder-run sweep (`pauseMarketOutreach`) and a one-live-engagement-per-market check at signing. (A duplicate gate was written first and removed once the audit found the spec 052 check — one implementation, imported everywhere.)
- **Work items lacked provenance and client-approval state.** `tasks` had title/evidence/owner/due/client_visible only. → observation, hypothesis, confidence, control, scope, client_approval, blocked_reason/note, target_url, before/after state, implemented_at; `startTask`/`completeTask` refuse while approval is required/rejected/edit_requested or the task is blocked; `task_client_decisions` is append-only.
- **No onboarding checklist, client context, change log, weekly update, renewal or offboarding logic.** All derived in `lib/engagements/rules.ts` (pure) and read through `engagementOverview`.

## Design (reuse first)
- **Project = client** (`kind='client'`, via spec 057 promotion). **Prospect** keeps pre-sale history (Touch 1, replies, corrections, report). `client_engagements` references both plus the market and the exclusivity agreement.
- **Lifecycle** continues where the prospect ladder ends: `contracted` → engagement `signed` → `onboarding` (commercial gate: signed contract + payment_received, or admin override with reason) → `active` (derived checklist complete) → `renewal_review` (by calendar, 21 days before end) → `renewed` | `completed` | `churned`. Nothing is typed "done".
- **Territory**: signing creates a `reserved` agreement (spec 052 semantics); `activateExclusivity` requires the human-reviewed market definition + gate passed and runs `detectConflicts` against every other live agreement; admin override with rationale is audited. `closeEngagement` terminates on the term end date.
- **Baseline package**: `freezeBaseline` defaults to the prospect's linked benchmark run, provider `openai`, subject = project subject company, competitors = tracked competitors (signing carries the mismatch rival into the project). Counting rules are the platform's one set (`providerRecommendationCounts` semantics: valid non-holdout answers of ONE provider; current-revision, echo-excluded recommendation mentions).
- **Remeasurement**: `recordMeasurement` freezes a new snapshot over a finished run, grades comparability (question-set version, question count, provider, subject, resolver policy, scoring version → not_comparable; model change / alias drift → medium; repetitions or valid-answer ratio → low) and stores a comparison phrased as observed movement, never attribution. Non-comparable runs are recorded as `non_comparable` with reasons.
- **Cadence**: planned rows at day 45 (midpoint diagnostic) and end−10 days (final), created at signing; the Today queue surfaces due slots.
- **Work**: existing `tasks` + new provenance columns; `blocked_reason` excludes a task from "overdue"; a task may be declined (`rejected`) from suggested, approved or in-progress — the client saying "not relevant" ends the item and clears its blocker (found by the production smoke, 2026-09-06); client decisions recorded by staff from the channel the client used (portal self-serve approval is out of scope for v1).
- **Change log**: derived from done tasks (before/after/url/why), shipped interventions, published content.
- **Weekly update**: `composeWeeklyUpdate` (DONE / IN PROGRESS / NEED FROM YOU / MEASUREMENT / NEXT); says so when nothing material happened; sending stays with the founder, `recordClientUpdateSent` records it for the cadence signal.
- **Portal**: `portalEngagement` (re-asserts project access; client-visible tasks only; no fees, invoices, override reasons, other prospects) rendered by `PortalEngagementBlock` on the overview.
- **Offboarding**: `closeEngagement` (admin) terminates exclusivity on the end date, revokes portal grants, cancels planned measurements, flags the prospect do-not-contact with a cooldown (default 180 days); records stay.
- **Renewal**: `renewEngagement` (admin) closes the current row as `renewed` and opens a new `signed` row with `previous_engagement_id`, a new reserved agreement and a new measurement plan. Never automatic.
- **Marketing permissions** default false (no public use); admin-only toggles.
- **Credentials**: context items refuse `password`/`secret`/`token` keys; access is tracked as delegated status only. If a secret must ever be held, it goes through the encrypted connector vault (`connector_credentials`, AES-GCM envelope) — not this table.

## Scope
- Migration 105: `client_engagements`, `engagement_measurements` (+ immutability trigger), `engagement_context_items`, `task_client_decisions`, task provenance columns.
- `lib/engagements/{constants,rules,measurement,service,exclusivity-gate}.ts`; `lib/tasks/service.ts` (provenance, block/unblock, client decision, gates); `lib/prospects/service.ts` + `lib/prospects/shared.ts` (own-prospect exemption on the spec 052 send-time re-check); `lib/control-tower/queue.ts` (engagement source; blocked ≠ overdue); `lib/portal/service.ts` (`portalEngagement`).
- UI: `/projects/[id]/engagement` (operator page + actions + dialogs), portal overview block, "Engagement" nav section.
- Docs: `docs/operations/first-client-delivery-runbook.md` (contract checklist, invoice workflow, onboarding call, cadence, failure modes).

## Out of scope (recorded, not built)
- Contract generation / e-signature integration (manual with checklist). Payment processor (manual ledger over `billing_events`).
- Client self-serve approval in the portal (client roles are read-only by `assertCanWrite`); decisions are captured by staff with an immutable trail.
- Automatic remeasurement run scheduling for engagements (interventions already schedule +2w/+6w/+12w retests; engagement slots are surfaced as due items and started by the operator).
- Weekly update delivery automation (draft composed; founder sends).

## Acceptance criteria
- [x] Signing a contracted (or verbal-yes) prospect creates the engagement, reserves territory, carries the mismatch rival as a competitor, plans midpoint/final measurements; a second live client in the same/contained market is refused without admin override (integration).
- [x] `startOnboarding` refuses without signed contract + payment (or admin override); `activateExclusivity` refuses without a confirmed market definition; `markActive` refuses until the derived checklist is complete (integration).
- [x] Baseline freezes over a shared-project run; second freeze refused; UPDATE/DELETE of the snapshot rejected by trigger; alias drift after the freeze does not alter it (integration).
- [x] Remeasurement on the same instrument grades `high` and yields a non-causal statement; a different question set is `non_comparable` with no comparison; an unfinished run is refused (integration).
- [x] Task start/complete refused while client approval is required/rejected or the task is blocked; decisions append-only (integration).
- [x] Client viewer sees only their project's engagement view with no commercial internals; another project is a 404-class error (integration).
- [x] Dispatch gate refuses an unattended send to a competing prospect in a protected market; the client's own prospect is exempt; sweep unschedules drafts and marks conflicts (integration).
- [x] Close terminates exclusivity on the end date, revokes portal grants, cancels planned slots, flags the former client do-not-contact with cooldown; renewal opens a linked new term (integration).
- [x] Pure rules: gate, checklist, schedule, comparability, comparison, renewal/stage by calendar, weekly update, next action (unit).
- [x] Migration reversible; typecheck, lint, layout-consistency green.
