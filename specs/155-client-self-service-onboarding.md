# Spec 155 — Client self-service onboarding and question review

> Status: implemented locally (2026-10-21) on `feat/155-client-self-service-onboarding`. Not committed, not deployed.
> Depends on: 154 (client delivery — uncommitted; this branch carries it as its base), 131, 132, 140, 031/085.
> Prerequisite closed in this branch: audit finding **P1-13** (staff actions without role checks; ungated `/learnings`).
> Audience: **client** (`/portal/[projectId]/welcome`, `/portal/[projectId]/*`, deny-by-default) and **operator** (`/projects/[id]/delivery`, section "Client onboarding").

## Why

Spec 154 gives a retained client a portal they can read, but every client step still says "reply by email and we record your decision". A nontechnical agent who has hired a done-for-you service should be able to open the portal for the first time, confirm a few prefilled details in about two minutes, and land on a calm dashboard. They should also be able to review the proposed customer questions on their own time. Neither may weaken the commercial gate, tenant isolation, baseline immutability or the decision trail.

## Decisions

1. **One narrow client write path.** `lib/auth.ts` gains `isClient(user)` and `assertClientRespondent(user, projectId)`. It requires a client role (`client_viewer` or `client_validator`) and a project grant. Staff are refused, because nobody may answer for the client through the portal; staff keep recording channel decisions on the delivery page. `assertCanWrite` is unchanged. Every other write stays staff-only. Any granted client user may respond, and each decision records who made it. The `client_validator` distinction is deferred.
2. **The project decides the engagement.** Client actions take a `projectId` only. The engagement is always resolved from it server-side, never from a client-supplied engagement id.
3. **No parallel onboarding system.** Onboarding stores its working state on one row per engagement (`client_onboardings`). It stores its outcome in the existing ledgers:
   - context items with client provenance, written through the same insert helper as `addContextItem`;
   - an `engagement_client_decisions` row with `subject_kind = 'intake'`, `decision = 'approved'`, `channel = 'portal'`.

   Spec 154's journey therefore derives "details confirmed" with no new rule.
4. **The operator prepares, the client confirms.** The operator prepares the four priorities and the known contacts on the delivery page. These are prefilled from records: the latest client-confirmed minimum value, market name, contact on file and recorded approver. Nothing is hardcoded in a component. The client sees onboarding only once the operator marks it ready **and** the engagement has passed the commercial gate (stage `onboarding` or `active`).
5. **Commercially sensitive edits are recorded, not applied.** The client's market wording is recorded as their stated priority. It never changes `client_engagements.market_definition` or exclusivity. If it differs from the engagement's market, the operator sees it flagged. Contact edits are recorded as client-confirmed identity items. The engagement row is not rewritten.
6. **Per-question review is append-only.** `client_question_reviews` holds one row per decision (approve, request edit or remove, plus an optional comment). The latest row per question is its state. Review progress is derived, so save and resume need no extra state.
7. **Approval only by explicit action.** Viewing a page records nothing. Confirming the priorities and pressing Continue on contacts are the only onboarding writes. The set-level question decision is written only when the client presses "Send my review" after every question is reviewed.
8. **The freeze gate respects the portal review.** `acceptProtocol` already requires an approved question-set decision. It now also refuses when any question on the cited version has an open portal request (`edit_requested` or `removed` as the latest state). `recordSubjectDecision` refuses to record `approved` on such a version. The operator must import a revised version.
9. **The portal has its own chrome.** The workspace shell no longer wraps `/portal` (the same rule as `/audit`), so clients never see the internal top bar. The portal routes split into a minimal onboarding shell (`welcome`, no navigation) and a `(dashboard)` route group with Overview | Results | 90-Day Plan | Approvals | Reports. URLs are unchanged.

## Data (migration 141, additive, reversible)

- `client_onboardings`
  - Keys: `engagement_id` unique, `project_id`.
  - `status`: `draft` | `ready` | `completed`.
  - Prepared values (operator): `prepared_priorities` jsonb, `prepared_contacts` jsonb.
  - Client working copy: `client_priorities` jsonb, `client_contacts` jsonb (null means unchanged).
  - Timestamps and actors: `priorities_confirmed_at`/`_by`, `completed_at`/`_by`, `prepared_by`, `ready_at`.
  - Triggers: never deleted; a `completed` row is immutable.
- `client_question_reviews`: append-only (`forbid_mutation`). Columns: `engagement_id`, `project_id`, `prompt_set_version_id`, `prompt_id`, `decision` (`approved` | `edit_requested` | `removed`), `comment`, `decided_by` (users), `client_actor`, `decided_at`.

Priorities shape: `{ primaryFocus: 'sellers' | 'buyers' | 'buyers_and_sellers', minPropertyValueUsd: int | null, additionalOpportunity: string, market: string }`.
Contacts shape: `{ primaryName, primaryEmail, approverName, approverEmail, approverIsPrimary }`. Empty strings mean unknown, and only unknown values are asked.

## Client screens

`/portal/[id]` redirects a client to `/portal/[id]/welcome` while onboarding is `ready` and not completed. Staff see a read-only preview with a "Preview" note and disabled actions.

The onboarding container is centred, `max-w-xl` (about 600px), on a neutral background, one column, with no navigation and a quiet step indicator ("Step 1 of 3"). An action error appears as one short plain-English line; technical messages are never shown.

1. **Confirm your priorities.**
   - Headline: "Welcome, {client name}." Lead: "We've already prepared your workspace. Just confirm a few details so we can get started."
   - Four read-only rows: Primary focus, Minimum property value, Additional opportunity, Market.
   - Primary action: **Looks good**. Secondary action: **Edit details**, which turns the rows into inline fields (select, currency, text, text) with Save and Cancel. Save stores the working copy; Looks good confirms.
2. **Who should we work with?**
   - Shows the known contact, email and approver. Only blank values become inputs.
   - Approver defaults to "Same as {primary}" when no approver is on file, with a link to name someone else.
   - Body: "We'll handle the work and reach out when something needs your approval." A small line says "We'll never ask for passwords. You can invite colleagues later."
   - **Continue** completes onboarding: decision, context items and audit in one transaction.
3. **You're all set. We'll take it from here.**
   - Three numbered next steps, then **Go to my dashboard**.

Returning midway resumes at the first unconfirmed step with the working copy intact.

### Dashboard Overview: four sections only

- **This week's focus.** Up to two client-visible in-progress task titles ("This week we're working on …"). Otherwise one sentence for the current journey step, from a copy table in `lib/portal/client-copy.ts`.
- **Progress.** With a published plan: completed / in progress / upcoming counts plus "{n} of {total} delivered". Otherwise: "We'll share your 90-day roadmap once your starting point is measured."
- **Needs your attention.** Outstanding client actions: question review, change approvals, access requests and the protocol. With none: "Nothing needed from you right now."
- **Latest update.** The most recent of the latest sent update and the latest comparable frozen measurement, with a link to details. With neither and no baseline: "We're establishing your starting point." No numbers appear without a frozen snapshot.

### Question review: `/portal/[id]/approvals/questions`

- A short explanation of why the questions matter.
- "{reviewed} of {total} reviewed · {remaining} remaining", derived from the frozen version (never a hardcoded 64).
- Questions grouped by segment (price tier, then audience, else "Other questions").
- Per question: Approve, Request edit or Remove, each with an optional comment. A comment is prompted for Request edit, but not required.
- **Approve all remaining** per group and for the whole set: one transaction, only undecided questions.
- Every decision saves immediately, so leaving and returning resumes.
- **Send my review** is enabled when all questions are reviewed. It writes the set decision: `approved` if every question is approved, else `changes_requested`. Once an approved decision exists on the version, the review is locked.

## Operator

`/projects/[id]/delivery` gains a "Client onboarding" section:
- prepare or edit the draft (prefilled from records), shown only while not completed and not yet confirmed by the client;
- mark ready (refused before the commercial gate);
- status and the client's confirmed values, with a flag where they differ from the prepared values or the engagement market;
- per-question review counts and open requests.

## Acceptance criteria

- [x] P1-13: every exported staff action refuses a client user (enumeration test over `app/**/actions.ts`); `/learnings` is staff-gated.
- [x] A client is refused every onboarding/review write on a project they are not granted (404 semantics); a staff user is refused every client write.
- [x] Onboarding is invisible before the operator marks it ready, and cannot be marked ready before the commercial gate.
- [x] Editing priorities stores a working copy; "Looks good" confirms; leaving and returning resumes at the right step with edits intact.
- [x] Missing contact values are asked; known values are shown, not re-asked; invalid email gets a short message.
- [x] Completing onboarding writes one `intake` portal decision and client-provenance context items, idempotently; the market is never written to the engagement; a completed onboarding is immutable in the database.
- [x] Dashboard with no baseline shows "We're establishing your starting point." and no percentage or zero anywhere; with no actions, "Nothing needed from you right now."
- [x] Question review: decisions append; progress derives; batch approve touches only undecided; save/resume; "Send my review" refuses until all reviewed; locked once approved.
- [x] `acceptProtocol` and staff `recordSubjectDecision(approved)` refuse while a portal edit/remove request is open on the version.
- [x] Screens checked at 1280px and 390px, keyboard-only, light and dark.
- [x] Migration up/down; typecheck, lint, tests green.

## Out of scope

Inviting collaborators from the portal; email sending; the `client_validator` distinction; client approval of task changes and protocol in the portal (still recorded by staff from the client's channel); spec 152 commercial fields.
