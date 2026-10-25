# Spec 154 — Client onboarding and 90-day delivery

> Status: implemented locally (2026-10-21) on `feat/154-client-onboarding-delivery` (branched from `ca48d67`, which includes 147-committed, 148 and 150). Not committed, not deployed.
> Depends on: 131 (engagements), 132 (delivery QA), 140 (intake/commercial), 026 (program plans), 035 (prompt import), 031/085 (portal).
> Reference client: Medina Real Estate (Albuquerque). No Medina value is hardcoded in any generic component; Medina appears only in synthetic, clearly labelled test fixtures.
> Audiences: **operator** (`/projects/[id]/delivery`, internal) and **client** (`/portal/[projectId]/*`, deny-by-default, client-visible + sent/published only).

## Why

The engagement machinery from spec 131 exists, but a client cannot yet follow their own engagement from welcome to Day 90, and four contract-critical steps have no record at all: the client's approval of the question set, an accepted measurement protocol, a client-visible roadmap with dates, and an archive of what we told them each week. The September Medina readiness audit (P0-01) also showed that "Freeze baseline" could lock the wrong run.

## Capability matrix (inspected 2026-10-19 on `ca48d67`)

| Capability | State before | Decision |
|---|---|---|
| Sign → contract → payment gate → onboarding (`signClient`, `recordContractStatus`, `recordBillingEvent`, `startOnboarding`) | Implemented, integration-tested | **Reuse** unchanged. |
| Exclusivity reserve/activate, market pause | Implemented | **Reuse**. |
| Client login (`inviteClientViewer`) | Implemented; needs `AUTH_MODE=supabase` | **Reuse**; welcome message added; sending stays manual. |
| Intake prefill (`onboardingPrefill`, `completeOnboardingIntake`) | Implemented (identity, website, priorities, access) | **Extend**: segments, minimum property value, ranked neighborhoods, surrounding markets, aliases, approvers. |
| Prompt import (`importPrompts`) | text/category/language/tier only; segment attributes dropped | **Extend** with segment columns; add client-review import + validation. |
| Prompt freeze | Implemented, immutable versions | **Reuse**. |
| Client approval of the question set | **Missing** | Add decision ledger. |
| Measurement protocol | **Missing** (spec 152 unbuilt) | Add versioned protocol, immutable once accepted. |
| Baseline freeze | Implemented but **unsafe** (defaults to prospect run; no parse/review/reuse gate) | **Repair**: explicit run, accepted protocol, same question version/provider, aliases present, readiness gate. |
| Segment results | **Missing** (snapshot has category only) | **Extend** snapshot with frozen segment attributes (new snapshots only). |
| 90-day plan (`program_plans`/`plan_items`) | Implemented; phases but no dates/dependencies; composes only from findings | **Extend**: due dates, dependencies, proof URL, manual draft, edits; approval = publication. |
| Tasks with provenance + client decisions | Implemented | **Extend**: decision binds to exact wording; changed wording re-requires approval. |
| Weekly update | Text composed on the fly, never stored; `recordClientUpdateSent` stores audit only | **Extend**: stored draft → explicit "mark sent" → immutable, archived in portal. |
| Check-ins | **Missing** | Add meetings (manual scheduling). Google Calendar connector exists but is not connected for clients; **not used**. |
| External measurement (Ahrefs) | **Absent**; no API client, no credentials in repo | **Manual import** with explicit provenance; never blended. |
| Portal | Overview/Work/Reports; overview hero reads `scores` (not like-for-like, audit P1-06) | **Repair**: engaged clients see snapshot-only numbers; five areas. |
| Offboarding (`closeEngagement`) | Implemented (revoke, cancel, cooldown) | **Reuse**; add derived offboarding checklist. |
| Fee decision | Spec 152 unbuilt | **Not automated** — displayed as "decided under the agreed protocol". |

Deployment limits (unchanged by this spec): production is at migration 118; 119–125 (spec 147) and 126–134 (spec 151) are unmerged; the production worker is stopped pending 148/150 deploy (audit P0-04). This spec's migration is **140** so it never collides with either branch.

## Journey and states

Derived, never typed "done" (`deliveryJourney`):

1. **Commercial gate** — contract signed + activation payment (existing gate). Before this, the client sees nothing new.
2. **Welcome** — at least one portal grant **and** a sent `welcome` update.
3. **Details confirmed** — intake recorded (client-confirmed identity + priority).
4. **Questions approved** — a client `approved` decision on a frozen question-set version.
5. **Protocol accepted** — an `accepted` protocol citing that approved version.
6. **Baseline locked** — frozen baseline whose run uses the protocol's question version and provider.
7. **Roadmap published** — program plan `approved`/`active`.
8. **Delivery** — weekly updates sent within cadence; check-ins every 14 days.
9. **Day-90 review** — a `final` measurement frozen (comparable or explicitly not comparable) and a `final_review` update sent.
10. **Closed** — engagement completed/churned.

Each step has `done | current | blocked | upcoming`, a plain client label, an operator label and one next action.

## Data (migration 140, additive, reversible)

- `engagement_protocols` — versioned; draft editable; once `accepted` every content column is frozen by trigger; may only move `accepted → superseded`; never deleted. One accepted per engagement.
- `engagement_client_decisions` — append-only (subject: question_set | protocol | roadmap | intake | final_review | other; decision; channel; client actor; snapshot of what was decided).
- `engagement_updates` — welcome / weekly / final_review; `draft → sent | discarded`; immutable once sent; never deleted.
- `engagement_meetings` — check-ins with agenda, notes, action items; never deleted (cancel instead).
- `external_measurements` — manual import of an external instrument's export: provider label, instrument, reference URL, window, raw export + SHA-256, whether it distinguishes recommendation from mention, QA status, client visibility (default false). Raw fields immutable; never deleted. No cost column.
- `plan_items` + `due_on`, `depends_on`, `proof_url`. `program_plans` unchanged.
- `task_client_decisions` + `client_actor`, `wording_snapshot`, `target_url_snapshot`.

## Rules

- **Baseline gate** (`freezeBaseline`): requires an explicit `runId`; an accepted protocol; the run's question version = the protocol's; provider = the protocol's; every protocol alias present on the subject company; readiness: 0 valid answers without a parse, 0 pending reviews on current revisions, 0 reused captures. Heuristic-parser rows are a warning that needs explicit acknowledgement. Refusals list every reason.
- **Comparable rate**: the client sees only engagement snapshots: baseline, then the latest snapshot graded `high`/`medium`/`low`. Every number shows provider, model(s), capture window, denominator, scoring and methodology versions, and caveats. No snapshot → "pending", never 0%.
- **Uncertainty**: Wilson 95% interval per rate; difference interval by Newcombe's method; both labelled as treating answers as independent (answers to the same question are correlated, so true uncertainty is wider).
- **Segments**: price band / neighborhood / audience from frozen prompt attributes; old snapshots show "unspecified".
- **Weekly update** body is built only from rows: client-visible tasks done in the window (with URL, after-state, evidence count), in progress, blocked, approvals waiting, measurements frozen in the window, plan items due next 7 days, next check-in. No comparable measurement in window ⇒ the text says so. Operator intro note refuses percentages and causal verbs.
- **Approval binding**: a task decision snapshots the after-state and URL; if the operator later changes either, approval returns to `required`.
- **Question import** (CSV export of the client review sheet): columns `text` (required), `segment`/`price_tier`, `neighborhood`, `audience`, `property_type`, `category`, `client_decision`, `client_comment`. Blocking: duplicate text, empty, names a tracked company (branded), `revise` or `check service area` rows unresolved, lower price bound below the engagement minimum (when recorded). `remove` rows are excluded and listed. Warnings: no seller-intent wording, unparseable price band. The import creates a new prompt set in the client project and freezes it as the proposed version.
- **Fee**: never computed. The Day-90 view shows the agreed success criteria text and states that the outcome is decided by people under the agreed protocol.
- **Ahrefs**: no API client. External results appear only after `verified` QA **and** client visibility, in a separate, labelled block; never merged into the OpenAI rate.

## Permissions

All writes: `assertCanWrite` (staff). Protocol acceptance, plan publication, update send: staff (operator records client's channel and name). Clients: read-only through `lib/portal/delivery.ts`, which re-asserts `assertProjectAccess` per read and filters in SQL (client-visible tasks, sent updates, approved plans, client-visible meetings, verified + client-visible external measurements). A verbatim answer is viewable only if its id is in a frozen snapshot of the project's engagement or its run belongs to the project. Client self-service approval is **not** built (spec 131 kept client roles read-only; no safe write path exists yet) — the portal says "reply by email; we record your decision", and shows the recorded trail.

## Screens

Operator: `/projects/[id]/delivery` (journey + forms for welcome, intake, questions, protocol, baseline readiness, roadmap, weekly update, check-ins, external measurements, offboarding checklist). Plan page gains dates/dependencies and manual items.

Client portal (five areas): Overview `/portal/[id]`, Results `/portal/[id]/results` (+ `/answers/[responseId]`), 90-Day Plan `/portal/[id]/plan`, Approvals `/portal/[id]/approvals`, Reports `/portal/[id]/reports` (updates, check-ins, published reports). `/portal/[id]/work` kept for old links.

## Acceptance criteria

- [x] Onboarding never starts without the commercial gate (existing) — regression covered.
- [x] Prefill shows verified fields and stores the extended intake as client-confirmed context; nothing overwrites aliases on the company record.
- [x] A 64-question reviewed CSV imports, validates, freezes as a proposed version; branded/duplicate/below-floor/unresolved rows block; `remove` rows are excluded.
- [x] Protocol cannot be accepted before the question version is approved; accepted protocol is immutable in the database.
- [x] Baseline refuses without protocol, with a different question version, with missing aliases, with unparsed answers or pending reviews.
- [x] Portal shows "pending" (never 0%) without a baseline; with one, numbers carry provider/model/window/denominator/versions; non-comparable measurements show no delta.
- [x] Verbatim answer access is scoped; a foreign response id is a 404 for a client.
- [x] Weekly update reflects only canonical rows; once sent it is immutable and appears in the portal; drafts never do.
- [x] Changing approved wording re-requires approval; decisions are append-only with actor, channel, timestamp, wording.
- [x] External measurement absent ⇒ portal fully usable; present but unverified ⇒ invisible to client.
- [x] No code path decides a fee.
- [x] Client cannot call any new write; cannot read another tenant.
- [x] Migration up/down; typecheck, lint, tests, build green.

## Out of scope

Client self-service write actions; email delivery; calendar sync; Ahrefs API; spec 152 commercial fields; PDF export; automatic remeasurement scheduling.
