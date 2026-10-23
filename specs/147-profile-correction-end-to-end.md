# Spec 147 — Profile Correction End to End

> **Status:** planned (2026-10-02). Revised the same day after an architecture correction pass that changed three things: the correction destination, how public profiles are fetched, and inference concurrency. See DECISIONS.md (2026-10-02, Spec 147). Nothing is implemented yet.
>
> **Audience:** internal operators only. Nothing in this spec is reachable by a client or prospect.
> - The output is an email **draft**, addressed to an explicitly recorded correction destination for each profile.
> - It is never sent automatically.
> - It is never addressed to the client just because the client's email is the only one on file.
>
> **Scope:** make `reputation_profile_correction_v1` work end to end:
> - an operator or weekly start, through a bounded inference queue;
> - a public fetch that needs no connector;
> - a deterministic correction request and validator;
> - human approval;
> - destination resolution;
> - a Gmail draft;
> - before-and-after evidence;
> - a 14-day recheck.
>
> **Frozen:** these keep their exact node definitions and handlers:
> - the front-half nodes `canonical_extract → approved_facts → compare`;
> - Specs 145B, 145D and 145E;
> - all of Spec 146: `detect-contradictions-v2`, the `qwen3:30b` route, the v2 schema and the Spec 146 validator.
>
> The single front-half change is `fetch_profile` (§4). It keeps its node key and its output contract, so `canonical_extract` is untouched.

## Slice 1 — implemented (2026-10-02)

Slice 1 covers this path: confirmed URL → durable queue → bounded dispatcher → `profile.check_requested` → profile-correction run → `dom.fetch_public_profile` → the unchanged `canonical_extract`.

**What was delivered:**
- `db/migrations/120_profile_check_requests.sql` (the queue);
- `lib/profile-corrections/{constants,config,urls,start,dispatch}.ts` and `db/profile-corrections.ts`;
- `dom.fetch_public_profile`;
- the new trigger, the event and `PROFILE_CHECK_MAX_INFERENCE_RUNS`;
- `runWeeklyKick`, the worker tick and the `profile_check_dispatch` job;
- the operator server action `startProfileChecks(projectId)`.

**Where the build deviates from the text below:**
- **Window keys.** They are prefixed (`week:YYYY-MM-DD` for the schedule, `day:YYYY-MM-DD` for an operator), so a Monday operator check never collides with that week's scheduled one.
- **Event payload.** It also carries `checkRequestId`, and the trigger's idempotency template keys on it.
- **Migration 120** creates only `profile_check_requests`. Its `correction_request_id` gets a foreign key in the slice 2 migration that creates `profile_correction_requests`.
- **Interim back half.** The paid `draft_outreach` / `verify_claims` back half and its Gmail requirement were removed now, not in slice 2. Leaving them would have exposed paid model calls on real traffic, and their `email.create_draft` preflight would have blocked every queued start. Until slice 2, `has_error → severity → correction_pending` (`ctl.safe_stop`) ends the run visibly. The validated pairs stay in the `compare` output, and nothing is drafted or sent.
- **Deferred to the slices that create the correction table:**
  - the `open_correction` skip;
  - reconciliation;
  - the "Profile checks" card (only the server action exists).

## Slice 2 — implemented (2026-10-03)

Slice 2 covers this path: validated contradiction pairs → `dom.build_profile_correction` → `dom.verify_profile_correction` (deterministic validation, then the persisted open request) → `approve` (`hum.approve_profile_correction`) → `dom.record_profile_correction_approval` → `done`.

**What was delivered:**
- `db/migrations/121_profile_correction_requests.sql`;
- `lib/profile-corrections/{request,approval,approval-binding}.ts`;
- the three domain nodes;
- the decision hook in `decideApprovalAction`;
- the `open_correction` skip at start and at release;
- `withdrawCorrectionRequest`, as a service and a server action.

**Where the build deviates from the text below:**
- **The `approved` status.**
  - It means the content is approved and the destination is not yet resolved. It is an open state, set by `record_approval` after the gate.
  - That node binds the approval to the request hash and re-proves the request against the database.
  - Slice 3's `route_correction` consumes `approved` and moves it to `ready_to_draft` or `destination_required`.
- **What the approver sees (`artifactPath: "verify_correction"`).**
  - The artifact is `{ request, requestSha256, requestVersion, correctionRequestId }`, so the operator sees the exact request, its hash and its version. The existing run page renders it as JSON.
  - The binding check (`approvalBindingError`) requires the shown request to hash to the shown hash, and that hash to equal the stored one.
- **Builder and validator inputs.**
  - Both also take `authority`: the current `claims` rows for every referenced approved claim (not filtered by project) and the before-page `source_artifacts` row. That makes the tenant, still-approved and exact-evidence-set checks pure and testable.
  - The validator additionally requires the request to be byte-identical to a fresh deterministic build. Nothing beyond validated data can pass.
- **Decisions.**
  - A rejection is persisted on the correction row inside the one approval-decision transaction.
  - An approval whose shown request does not bind to the stored hash is refused, and the decision rolls back.
  - Facts that change between building the request and approval close the row as `expired` (`closed_reason` records why), which frees the profile. The run stops.
- **Migration 121** creates `profile_correction_requests` without the destination, draft and recheck columns; later slices add them. It also adds the deferred foreign key from `profile_check_requests.correction_request_id`. A database trigger enforces tenant consistency for the run, the before page, the packet, the queue row and the context item. Request content is immutable, and deletes are forbidden.
- **Still not built:**
  - destinations (§7.3);
  - drafting (§7.4);
  - rechecks (§9);
  - reconciliation (§8.4). Until it lands, a timed-out approval leaves the request `awaiting_approval` until an operator withdraws it;
  - the dedicated approval view component (§7.1);
  - the Profile Checks card.

## Slice 3 — implemented (2026-10-03)

Slice 3 covers this path: `approved` → `dom.route_profile_correction` → one of `destination_required`, `awaiting_external_approval` or `ready_to_draft`. Nothing is drafted, sent or submitted.

**What was delivered:**
- `db/migrations/122_profile_correction_destinations.sql`;
- `lib/profile-corrections/{routing,destinations}.ts`;
- the route node, and the publisher authorization workflow `reputation_profile_correction_authorize_v1`;
- operator actions: `setCorrectionDestination`, `archiveCorrectionDestination`, `clientEditorPrefill`, plus the existing `withdrawCorrectionRequest`.

**Where the build deviates from the text below:**
- **A new open status, `awaiting_external_approval`.** It is withdrawable and re-routable.
- **Publisher authorization is its own workflow, not part of the draft workflow (§5.2).**
  - It runs once per (request, destination) and is started by `profile.external_approval_required`, with dedupe key and idempotency key `profile-external-approval:<request>:<destination>`.
  - The flow is `load_external → authorize_external (hum.approve_external_submission) → record_external_approval → ready_to_draft`.
  - The approval binds to the request hash AND the destination shown, both at decision time and at the record step.
  - A rejection returns the request to `destination_required` (destination cleared, decision audited).
- **Re-routing follows the profile's active destination.** Setting, replacing or archiving a destination re-routes, in the same transaction and under a per-profile advisory lock, every `destination_required`, `awaiting_external_approval` and `ready_to_draft` request for that profile, oldest first. Routing the same request to the same destination again is a no-op that publishes nothing.
- **`ready_to_draft` publishes no event yet.** The drafting trigger, `profile.correction_ready`, arrives with Slice 4. That slice must also start drafts for requests already `ready_to_draft`.
- **Database enforcement.** Destinations are append-plus-archive (enforced by a trigger, with deletes forbidden). One active destination is allowed per (project, profile URL). An attached `destination_id` must be an active destination of the same project and profile.
- **The dispatcher now claims one queued row at a time,** so a row skipped at release no longer uses a capacity slot.

## Slice 4 — implemented (2026-10-03)

Slice 4 covers this path: `ready_to_draft` → drafting attempt → `reputation_profile_correction_draft_v1` (`prepare_draft → submit (email.create_draft, Gmail) → record_draft → confirm_sent (hum.confirm_profile_correction_sent) → record_sent`) → `sent`, plus one recheck queue row due 14 days later. Recheck execution is not built.

**What was delivered:**
- `db/migrations/123_profile_correction_drafts.sql`;
- `lib/profile-corrections/{email,drafting,gmail}.ts`;
- three domain nodes;
- the `confirm_profile_correction_sent` human gate;
- the `profile_correction_draft_dispatch` job, and the draft sweep in the worker tick.

**Where the build deviates from the text below:**
- **Drafting attempts are durable rows (`profile_correction_drafts`).**
  - Each attempt starts its own run, via `profile.correction_ready`, keyed by the attempt (`profile-correction-draft:<attemptId>`).
  - `dispatchCorrectionDrafts` (advisory-locked; runs from the tick and from a job enqueued whenever a request becomes `ready_to_draft`) is the only way an attempt starts. So the Slice 3 backlog is picked up with no manual step.
  - A partial unique index allows exactly one active attempt (`pending`, `creating` or `created`) per request.
  - An attempt that stalls before Gmail is called becomes `failed` and is retried after `PROFILE_DRAFT_RETRY_MINUTES` (360).
  - An attempt that stalls after Gmail may have been called becomes `outcome_unknown` and is never retried automatically, because a second draft would be a duplicate.
  - A draft created after the request moved on is recorded as `orphaned`, with its Gmail ids, so it can be deleted.
- **A new open status, `awaiting_send_confirmation`.**
  - Creating a draft sends nothing. The `submit` node uses `actionType: content_drafting`, so the engine adds no approval on top of it.
  - The explicit send confirmation is a dedicated human gate. It binds to the request id, the request hash, the destination, the draft attempt and the Gmail draft id, and the destination must still be active. The binding is checked in the decision transaction and again by `record_sent`.
  - Declining closes the request as `withdrawn` and discards the draft.
- **Gmail preconditions are checked by `prepare_draft`, not by a connector preflight.** The draft workflow's `requiredConnectors` is `[]`. A missing or inactive Gmail connection, or a missing `sendAsAddress`, fails the attempt with the reason instead of dead-lettering the start event.
- **`prepare_draft` re-proves the stored request.** It reruns the request against its check run's recorded outputs and the current claims. If the facts changed, the request closes as `expired`.
- **The recheck is a `profile_check_requests` row** (`kind = 'recheck'`, `not_before = sent_at + 14 days`, unique per correction), as §9.1 specifies. The dispatcher still releases only `check` rows, so it waits for the recheck slice.

## Slice 5 — implemented (2026-10-03)

Slice 5 covers this path: a due recheck row → the same bounded dispatcher (`profile.recheck_due`) → `reputation_profile_recheck_v1`. The workflow runs `load_request → fetch_profile (dom.fetch_public_profile) → precheck`. Then:
- if the page changed: the frozen `canonical_extract → approved_facts → compare` path, then `classify`;
- otherwise: straight to `classify`.

The result goes into an immutable `profile_correction_rechecks` row, and the correction's lifecycle moves to that result. Nothing is sent, nothing else is scheduled, and no new correction is created.

**What was delivered:**
- `db/migrations/124_profile_correction_rechecks.sql`;
- `lib/profile-corrections/recheck.ts` (a pure classifier);
- three domain nodes;
- the dispatcher now releases `recheck` rows alongside `check` rows, under the same capacity, oldest first;
- the recheck workflow is counted as inference-active.

**Where the build deviates from, or sharpens, the text below:**
- **`corrected` needs positive evidence.** The incorrect statement must be gone, AND the current page must restate the approved fact: extraction matches an observation to that approved claim (Spec 145E `matched`, `existingStatus` `approved`). If the error is merely absent, the item is `needs_review`, never `corrected`. The same applies if the wrong wording is still observed but was not flagged, if the approved fact has gone from the packet, or if the claim is contradicted with different wording.
- **A comparison that fails never records a result.** Either the guard stops the run, or `classify` refuses to run without a comparison answer. The correction stays `sent`, and reconciliation (not built yet) will handle it. A comparison that does not validate inside `classify` gives `needs_review` for every item.
- **The overall result is decided in this order:** unreachable (page-level), then still_incorrect, then needs_review, then corrected. A new contradiction on an approved fact the request did not cover turns an otherwise corrected result into `needs_review`.
- **A refused fetch, or one with no URL, fails the run.** Only an HTTP or network failure is classified as `unreachable`.
- **Comparison nodes are shared code.** The frozen comparison nodes come from one `frozenComparisonNodes()` function used by both the check and the recheck, so their definitions cannot drift.
- **`normalizeStatement`** in the Spec 146 contract module gets an `export` keyword. This is the only edit to that module, as planned in §9.3, and it changes no behaviour.

## Slice 6 — implemented (2026-10-03)

Slice 6 delivers reconciliation of stuck requests, an operator-confirmed retry of uncertain Gmail drafts, and a withdrawal that neutralizes pending work.

**What was delivered:**
- `lib/profile-corrections/{reconcile-decision,reconcile,retry}.ts`;
- `db/migrations/125_profile_correction_draft_retries.sql`;
- `reconcileProfileCorrections()`, called from the worker tick and at the start of each project's `startProfileChecks`;
- `retryProfileCorrectionDraft`, as a service and a server action.

**Reconciliation (§8.4, as built):**
- **How it runs.**
  - It acts only when the run a request waits on can never progress. That means a stopped run state (`failed`, `cancelled`, `safely_stopped`, `timed_out`, `partially_completed`; approval time-outs come from the engine's own `checkApprovalTimeouts`), or a publisher authorization run that never started within `PROFILE_CHECK_RELEASE_TIMEOUT_MINUTES`.
  - Locking: advisory lock, then `for update skip locked`, with guarded moves.
  - It processes up to 50 requests per pass, stalest first, and can be scoped to one project.
- **What it does, by state:**

  | State | Condition | Result |
  |---|---|---|
  | `awaiting_approval` | run stopped | `rejected` if the human rejected it, otherwise `expired` |
  | `approved` | run stopped | `expired` |
  | `awaiting_external_approval` | run stopped or never started | `destination_required` |
  | `awaiting_send_confirmation` | run stopped | `ready_to_draft`. The created attempt becomes `outcome_unknown` with its Gmail ids kept. Nothing is marked sent, and nothing retries automatically. |
  | `sent` | no result, and the recheck run stopped or the recheck row failed or was skipped | `needs_review` (`closed_reason` records why; there is no result row). A released recheck row becomes `failed`. |

- **Boundaries.** A run that is still running or waiting, a healthy queued recheck, and every terminal state are left untouched. A completed run with no outcome is reported as an anomaly and not resolved.
- **Audit.** Every move is audited with the actor `system:reconcile`, the from and to states, the reason, and the related run, approval, draft attempt and recheck ids.

**Retry drafting:**
- **Preconditions.**
  - Operator role and project access.
  - The attempt is `outcome_unknown` or `orphaned`.
  - The request is `ready_to_draft`.
  - `confirmNoUsableDraft: true` is required.
  - The expected request hash and the active destination must equal the current ones; otherwise the operator must re-route first.
  - The content approval must still bind.
- **What it does.**
  - The uncertain attempt is superseded, not deleted, and its Gmail ids are kept.
  - Exactly one new attempt is created, recording `retry_of`. A unique index allows one retry per attempt, so a repeated call returns the same attempt.
  - `profile.correction_ready` is published for the new attempt.

**Withdrawal now neutralizes pending work:**
- pending attempts are superseded;
- the active created attempt is discarded (the Gmail draft is never deleted by the platform);
- a queued recheck is skipped;
- linked runs still waiting or running are cancelled.

History is kept throughout.

## 1. Current state (traced 2026-10-02)

| Area | What the code does today |
|---|---|
| Profile URLs | `completeOnboardingIntake` (`lib/engagements/onboarding-intake.ts:151-152`) stores the website and every `profileUrls[]` entry. Each is an `engagement_context_items` row with `kind = 'asset'`, `provenance = 'client_confirmed'`, and `label = source_ref = <url>` (migration `105_client_engagements.sql:151-173`; `addContextItem`, `lib/engagements/service.ts:910`). Each row carries `project_id`. There is no archive column and no `db/` reader. |
| Correction destination | **Nothing stores one.** No table, column, context-item kind or connector holds a profile's publisher contact, correction form or editor. The only emails are the client's `contactEmail` (inside the intake's `identity` item, `onboarding-intake.ts:149`) and `prospect_contacts`. `lib/sources/classify.ts` labels a domain's *type* (`portal`, `brokerage`, `news`, …), but not who corrects it. The operating model is set in the onboarding access question (`lib/engagements/onboarding-questions.ts:70`): *"Who on your team can edit your website and your Zillow, Realtor.com and Homes.com profiles? … for the profiles I will send exact field-by-field changes for your team to apply."* The `access` item records only free-text `implementationContact` for the **website**. Nothing records who edits a given profile, and nothing records a publisher's contact. |
| Starting a check | No product code publishes `profile.error_detected`. Its trigger template, `profile:{{payload.profileUrl}}`, makes every later event for the same URL collapse onto the first run. The `profile_scan` schedule template is installed disabled, and a cloned copy fails at `entry` (Spec 145C). |
| Public fetch | `fetch_profile` is `fetch(..., "cms.fetch_public_page")`, which is `int.cms_fetch_public_page` → `executeCapability`. The **only** provider is the WordPress adapter (`lib/connectors/adapters/business.ts:317-331`). So a run needs an unrelated WordPress connection just to read a Zillow page, and without one it records `no_connection` (Spec 145C §61). The adapter calls `ctx.http`, which is `connectorFetch` (`lib/connectors/http.ts:68`), a plain `fetch` with **no SSRF policy**. Its output (`url`, `status`, `reachable`, a 2,000-character `excerpt`) is only used as a reachability gate: `canonical_extract` re-fetches the page itself through `ingestSource(origin: "url_fetch")` → `fetchUrl` → `safeFetch` (`lib/knowledge/sources/ingest.ts:420`). `safeFetch` (`lib/security/safe-fetch.ts`) allows http(s) only, refuses private hosts and DNS results, re-validates every redirect hop by hand, caps size while streaming (`SOURCE_MAX_BYTES`), and applies `SOURCE_FETCH_TIMEOUT_MS`. Storage, sha256, versioning and supersession all happen in `ingestSource`. |
| Concurrency | The worker handles one job at a time (`workers/index.ts:78`, `dispatchOnce`). `tick()` runs a run's ready nodes **sequentially** (`engine.ts:255-`). So a single worker process makes at most one local model call at a time, but **only by accident**. `claimNextJob` uses `skip locked` and supports several workers, and nothing bounds Ollama calls across processes. Event delivery is not a queue either: if `startWorkflow` hits its concurrency limit it throws `conflict`, which is retried 3 times and then dead-lettered (`bus.ts`). `maxConcurrentRuns` (default 1, `helpers.ts:348`) counts every run that is not terminal, **including runs parked for up to 72 h awaiting approval** (`runtime.ts:341-357`). That makes it the wrong lever for inference backpressure. One check makes two local model calls: `canonical_extract` runs `knowledge_claim_extraction` on `gpt-oss:20b`, and `compare` runs `qwen3:30b`. On one host these contend; the Spec 146 canary measured p95 69 s under contention. |
| Back half | `draft_correction` is `agt.draft_outreach`, the prospect cold-outreach prompt, on paid OpenAI. `verify_correction` is `agt.verify_claims`, also paid OpenAI, and sees only the draft. `submit` has no `to`, so it would fail on a live run. `archive_before_after` hashes a 2,000-character excerpt. `schedule_verify` queues an `advance_workflow` job against a run that has already completed, so nothing is ever rechecked. `publish_event` emits an event that nothing consumes. |
| Approval UI | `/approvals` lists the item. `app/automation/runs/[runId]/page.tsx` shows `approval.detail` as raw JSON. Approve or Reject, with a rationale (`components/approvals/approval-decision.tsx`). |

## 2. Profile URL source (authoritative)

**Source:** `engagement_context_items` rows where:
- `project_id` = the project;
- `engagement_id` = its **live** engagement (`LIVE_ENGAGEMENT_STAGES`);
- `kind = 'asset'` and `provenance = 'client_confirmed'`;
- `source_ref` parses as an absolute `http:` or `https:` URL.

**Rules:**
- **No new URL storage.** Schedulers and queue rows read this source and never hold the list.
- **The website is included.** It is stored identically, and the client's own site is a public profile of the client.
- **One check per URL.** URLs are deduplicated by `new URL(source_ref).toString()`, keeping the oldest row, so its `id` (`contextItemId`) is stable.
- **Cap:** `PROFILE_CHECK_MAX_PROFILES_PER_PROJECT = 25` per start. Anything over it is reported as `over_cap`.
- **Removing a URL is out of scope** (§13).

**Reader:** `listConfirmedProfileUrls(projectId)` in `lib/profile-corrections/urls.ts`, over the SQL in `db/profile-corrections.ts`. It returns `{ contextItemId, profileUrl }[]` plus skipped rows with a reason (`no_url`, `invalid_url`, `duplicate_url`, `over_cap`).

## 3. Starting checks and the inference queue

### 3.1 Bounded concurrency (decision)

**Inference-active runs.** These are runs of `reputation_profile_correction_v1` or `reputation_profile_recheck_v1` in state `queued`, `initializing` or `running`, plus queue rows that have been released but have no run yet (§3.3). Runs parked in `waiting_for_approval` and terminal runs do not count, because they hold no inference.

**The limit:**
- **`PROFILE_CHECK_MAX_INFERENCE_RUNS`, global, default `1`.** It is configurable through `lib/env.ts` as an optional integer from 1 to `PROFILE_CHECK_MAX_PROFILES_PER_PROJECT`.
- **Why 1:** there is one inference host. Each check runs `gpt-oss:20b` and then `qwen3:30b`, and Spec 146's latency gate only holds without contention.
- **Raising it** is an operator decision, made only after the Spec 146 deferred SLO validation passes at that concurrency.

**What the engine provides, and what it does not.**
- It provides per-process serialization, which keeps one worker from overlapping calls.
- It provides no global bound, no queue for event starts, and no distinction between parked and active runs.
- So the bound lives in a dispatcher (§3.3), not in `maxConcurrentRuns`.

**`maxConcurrentRuns`.** It is set to `PROFILE_CHECK_MAX_PROFILES_PER_PROJECT` on the correction, recheck and draft workflows. This is only a per-project safety ceiling for **parked** runs, so a profile awaiting approval for 72 h never blocks the client's other profiles. It is not the throttle. It is a definition field, not part of `graphHash`.

### 3.2 Start function

`startProfileChecks(user, { projectId, origin })` in `lib/profile-corrections/start.ts`. It returns `{ queued, skipped: { contextItemId|null, profileUrl|null, reason }[] }`.

1. **Authorization.**
   - `origin = "operator"`: `assertRole(user, "operator")` and `assertProjectAccess(user, projectId)`. Client roles cannot start a check.
   - `origin = "schedule"`: called with `systemUser()`.
2. **Project preconditions.** On failure the project is `blocked` and nothing is queued.
   - The project is `status = 'active'` and has a live engagement.
   - At least one claim with `status = 'approved'` exists. With no approved facts, `compare` can only return `[]`, which would be a false clean profile.
   - **No connector preflight is needed.** The fetch is connector-free (§4), and drafting is a separate workflow with its own preflight (§7.4).
3. **Reconcile** stale correction rows (§8.4).
4. **Read the URLs** with `listConfirmedProfileUrls(projectId)`. **Zero URLs** gives `queued: 0, skipped: [{ reason: "no_confirmed_profiles" }]`, plus a `profile_checks.no_profiles` log. The UI explains how to add URLs.
5. **Per URL:**
   - Skip with `open_correction` if an open correction row exists for `(project_id, profile_url)` (§8.1).
   - Otherwise insert a `profile_check_requests` row: `kind = 'check'`, `status = 'queued'`, `not_before = now()`.
     - `window_key` is `weekStart()` (`lib/cycles/service.ts:39`) for the schedule, and the UTC date for the operator.
     - A conflict on the unique key is skipped as `already_requested`.
   - Each URL runs in its own `try`/`catch`. A failure is skipped as `queue_failed`, and the loop continues.
6. **Kick the dispatcher.** `enqueueDispatch()` enqueues one `profile_check_dispatch` job, unless one is already queued.
7. **Audit.** An `audit_log` row: `profile_checks.queued`, entity `project`, detail `{ origin, window, queued, skipped }`.

**Operator start.**
- **Server action:** `startProfileChecks(projectId)` in `app/projects/[id]/engagement/actions.ts`, through the file's existing `run()` wrapper.
- **UI:** a "Profile checks" card on `/projects/[id]/engagement` (`components/engagements/profile-checks.tsx`, shadcn, following `ui-conventions`). It shows:
  - each confirmed URL, with its queue state (queued, running) and its latest correction status;
  - its correction destination, if one is recorded (§7.3);
  - a **Check profiles** button, with the queued and skipped results after a click;
  - loading, empty and error states.

**Scheduled start.** `startWeeklyProfileChecks()` loops over `listLiveEngagements()`, with a `try`/`catch` per project (the `startWeeklyBriefs` pattern, `lib/cycles/service.ts:317`), and calls `startProfileChecks(systemUser, { projectId, origin: "schedule" })`.
- It is called from `runWeeklyKick()` (`lib/ops/tick.ts:363`). That function runs every worker tick and from `/api/cron/weekly-cycle`.
- The weekly `window_key` makes it queue once per week.
- The disabled `profile_scan` template is unchanged (Spec 145C tests still pin it).

### 3.3 Dispatcher

`dispatchProfileChecks()` lives in `lib/profile-corrections/dispatch.ts`. It is called by:
- the `profile_check_dispatch` job (`workers/core.ts`);
- every worker tick (`runAutomationTick`, `lib/ops/tick.ts`). This is the safety net, and it is what releases rechecks once they fall due.

It runs in one transaction under `pg_advisory_xact_lock(PROFILE_CHECK_DISPATCH_LOCK_KEY)`, so several workers cannot over-release:

1. **Release timeout.** Rows that are `released` with no `workflow_runs` row for their `run_idempotency_key` after `PROFILE_CHECK_RELEASE_TIMEOUT_MINUTES = 15` are marked `failed`, with a reason. This covers a dead-lettered event; the bus has already raised its exception. It frees capacity.
2. **Capacity:** `PROFILE_CHECK_MAX_INFERENCE_RUNS − active`. `active` counts released rows whose run is missing (not yet delivered), or whose run is in `queued`, `initializing` or `running`. It is joined on `workflow_runs.idempotency_key = run_idempotency_key`.
3. **Release.** It selects up to `capacity` queued rows with `not_before <= now()`, ordered by `not_before` and then `created_at`, using `for update skip locked`. For each row it re-checks the skip rules:
   - for a `check`: no open correction;
   - for a `recheck`: the correction row is still `sent`.

   It then publishes the row's event with `publishEvent(tx, …)`:

   | Row kind | Event | `dedupeKey` |
   |---|---|---|
   | `check` | `profile.check_requested` | `profile-check:<projectId>:<contextItemId>:<window_key>` |
   | `recheck` | `profile.recheck_due` | `profile-recheck:<correctionRequestId>` |

   It sets `status = 'released'`, `released_at` and `event_id`. A row that fails the re-check becomes `skipped`, with the reason.
4. **Continue.** If due rows are still queued, it enqueues the next `profile_check_dispatch` job with `run_after = now() + PROFILE_CHECK_DISPATCH_INTERVAL_SECONDS (60)`, unless one is already queued. This uses the existing `jobs` queue and the raw `run_after` insert pattern.

**How the rest of the queue waits.** Waiting URLs stay `queued` rows. They are durable, visible on the card, and survive restarts, and none is dropped. Throughput is about one check per inference slot.

**Per-profile isolation:**
- each row is its own event, delivery and run;
- a failed, safe-stopped or rejected run settles and frees its slot;
- a stuck release times out (step 1).

### 3.4 Events and triggers

**Catalog** (`lib/events/catalog.ts`; `requiresProject` defaults to `true`):
```ts
const profileCheckRequested = z.object({
  profileUrl: z.string().url(),
  contextItemId: z.string().uuid(),
  origin: z.enum(["operator", "schedule"]),
  window: z.string().min(1),
});
const profileRecheckDue = z.object({ correctionRequestId: z.string().uuid(), profileUrl: z.string().url() });
const profileCorrectionReady = z.object({ correctionRequestId: z.string().uuid() });
def("profile.check_requested", "A check of a client-confirmed profile URL was released from the queue", profileCheckRequested)
def("profile.recheck_due", "An approved profile correction is due for its live recheck", profileRecheckDue)
def("profile.correction_ready", "An approved correction has a destination and can be drafted", profileCorrectionReady)
```

**Triggers:**

| Workflow | Event | `idempotencyTemplate` |
|---|---|---|
| `reputation_profile_correction_v1` (added; the existing `profile.error_detected` trigger is unchanged) | `profile.check_requested` | `profile-check:{{event.projectId}}:{{payload.checkRequestId}}` (the queue row is already unique per project, item and window) |
| `reputation_profile_recheck_v1` | `profile.recheck_due` | `profile-recheck:{{payload.correctionRequestId}}` |
| `reputation_profile_correction_draft_v1` | `profile.correction_ready` | `profile-correction-draft:{{payload.correctionRequestId}}` |

Every queue row stores its `run_idempotency_key` as `live:` + the rendered template, which is exactly what the engine stores (`runtime.ts`, `${mode}:${idempotencyKey}`).

**Tenant.** The bus passes `event.projectId` to `startWorkflow`. Only rows read under that project are published.

**Queue bypass.** `profile.error_detected` and the admin `publishTestEvent` can still start a run outside the queue. Neither is a product path, and both are admin-only.

## 4. Public profile fetch (decision)

**Replace the connector capability with a deterministic node that uses the existing `safeFetch`. No new fetch implementation is added.**

```ts
step("fetch_profile", "dom.fetch_public_profile", "Fetch the profile", { urlPath: "payload.profileUrl" })
```
In the recheck workflow, `urlPath` is `"load_request.profileUrl"`.

**`dom.fetch_public_profile`** (`lib/automation/nodes/profile-correction.ts`):
- **No URL.** It resolves `urlPath`. If there is no non-empty string there, it returns `succeeded` with `{ ok: false, reason: "no_url" }`. It never invents a URL; this is the Spec 145C invariant.
- **Fetch.** `safeFetch(url, { timeoutMs: SOURCE_FETCH_TIMEOUT_MS, maxBytes: SOURCE_MAX_BYTES })`, the same policy and limits as `ingestSource`'s `fetchUrl`, from `lib/knowledge/constants.ts`.
- **Output.** It keeps the contract `canonical_extract` already reads (`claim-extraction.ts:71-103`):

  | Result | Output |
  |---|---|
  | an HTTP response | `{ ok: true, data: { url, finalUrl, status, reachable: response.ok } }` |
  | `ClassifiedError` `timeout` or `internal` (network, DNS, redirect failure) | `{ ok: true, data: { url, status: null, reachable: false, error } }`, meaning the page is unreachable |
  | `ClassifiedError` `validation` or `forbidden` (bad scheme, private host, size cap) | `{ ok: false, reason: "policy_refused", error }`, a refusal and not "unreachable" |

  No `provider` is emitted. `canonical_extract` then ingests with no `provider`, so a profile page is no longer mislabelled `wordpress` in `source_artifacts.provider`.
- **Test mode.** It returns `safe_stop`, as `canonical_extract` does.

**What stays the same:**
- `canonical_extract`'s config (`contextPath: "fetch_profile"`) and handler are **unchanged**.
- Its reachability safe-stops keep their behaviour.
- It still ingests through `ingestSource(origin: "url_fetch")` → `safeFetch`, with storage, sha256, versioning, the duplicate guard and provenance. Specs 145B, 145D and 145E are untouched.

**WordPress is removed from this workflow.**
- `requiredConnectors` for `reputation_profile_correction_v1` and `reputation_profile_recheck_v1` becomes `[]`.
- `cms.fetch_public_page` remains for its other users (content live verification, competitor intelligence), unchanged.

**Why not drop `fetch_profile` entirely.** `canonical_extract` needs its `{ ok, data.reachable, data.url }` input. Dropping the node would mean changing `canonical_extract`'s config or handler, which is frozen. The node also gives the recheck a clean unreachable versus refused signal without running extraction.

**Cost:** the page is fetched twice (the reachability check, then ingest), both through `safeFetch`. That is accepted, because removing the duplicate would mean changing the frozen `canonical_extract`.

**Spec 145C impact.** The `inputFields: { url: "payload.profileUrl" }` integration wiring is superseded by `urlPath`. Its invariants (the URL only from `payload.profileUrl`, never invented, and a missing URL stops at `canonical_extract`) are kept and retested. The `profile-correction-live-input.test.ts` cases that assert `executeCapability` for `fetch_profile` are rewritten against `dom.fetch_public_profile`. Its `entry`, trigger and `profile_scan` assertions are unchanged.

## 5. Workflows

### 5.1 `reputation_profile_correction_v1`

```
entry(trg.domain_event) → fetch_profile* → canonical_extract → approved_facts → compare → has_error
has_error ─false→ no_error → done
has_error ─true→ severity → build_correction → verify_correction → approve → route_correction → done
```

\* `fetch_profile` uses its new handler (§4). Every other front-half node and edge (`entry`, `canonical_extract`, `approved_facts`, `compare`, `has_error`, `no_error`, `severity`) is pinned by a deep-equality test.

| Node | Handler | Purpose |
|---|---|---|
| `build_correction` | `step`, `dom.build_profile_correction`, `{ requestVersion }` | Deterministic builder (§5.4). |
| `verify_correction` | `step`, `dom.verify_profile_correction`, `{ requestVersion }` | Deterministic validator, then inserts the correction row (§6). |
| `approve` | `human(..., "approve_profile_correction", { artifactPath: "verify_correction.request", evidenceIdsPath: "verify_correction.request.evidenceIds" }, { riskLevel: "high", approvalRole: "operator" })` | Human approval of the correction content (§7.1). |
| `route_correction` | `step`, `dom.route_profile_correction`, `{ requestVersion }` | Records the approval and resolves the destination (§7.2). |

**Removed:**
- `draft_correction` (`agt.draft_outreach`) and `verify_correction` (`agt.verify_claims`), both paid OpenAI;
- `submit`, `archive_before_after`, `schedule_verify` and `publish_event`.

**Settings:**
- `requiredConnectors: []`;
- `maxConcurrentRuns: 25`;
- the stale-version guard on every new `dom.*` node: `ctx.config.requestVersion !== PROFILE_CORRECTION_REQUEST_VERSION` returns `failed_terminal` before any work.

Before deploy, cancel any non-terminal runs on the old version. In practice none exist; record the count.

### 5.2 `reputation_profile_correction_draft_v1` (new)

**Settings:**
- `clientScope: "client_required"`;
- autonomy 2, `riskClassification: "high"`;
- `requiredConnectors: ["email.create_draft"]`;
- `maxConcurrentRuns: 25`;
- trigger: `profile.correction_ready`.

```
entry(trg.domain_event) → load_ready
load_ready ─destinationKind="publisher"→ authorize_external → prepare_draft
load_ready ─destinationKind="client_editor"→ prepare_draft
prepare_draft → submit → record_sent → done
```

The branches are `when(...)` edges with `required: false`. `prepare_draft` uses the readiness rule in `lib/workflow/graph.ts:299-345`: an optional edge never blocks, and at least one incoming edge must be satisfied.

| Node | Handler |
|---|---|
| `load_ready` | `dom.load_profile_correction` with `{ expect: "ready_to_draft" }`. It loads the row by `payload.correctionRequestId`, requires `project_id = ctx.projectId`, `status = 'ready_to_draft'` and an active destination, and records `draft_run_id` (guarded). Outputs: `{ correctionRequestId, request, destinationKind, destination }`. |
| `authorize_external` | The existing `hum.approve_external_submission`, `{ artifactPath: "load_ready", evidenceIdsPath: "load_ready.request.evidenceIds" }`, risk high. It runs **only** for publisher destinations, which are contact with a third party on the client's behalf. |
| `prepare_draft` | `dom.prepare_profile_correction_draft` (§7.4). |
| `submit` | The existing `act("submit", "email.create_draft", { inputPath: "prepare_draft" })`. It creates a Gmail **draft**. Level-2 autonomy keeps the engine's existing approval on `submit`, which is the **send confirmation**. |
| `record_sent` | `dom.record_profile_correction_sent` (§9.1). |

### 5.3 `reputation_profile_recheck_v1` (new)

This is described in §9.3. Its `fetch_profile` uses `dom.fetch_public_profile` with `urlPath: "load_request.profileUrl"`, and `requiredConnectors` is `[]`.

### 5.4 Deterministic correction builder

`buildProfileCorrectionRequest(input)` is pure, in `lib/profile-corrections/request.ts`. No model is called.

**Input:** `projectId` (from `ctx.projectId`), `workflowRunId`, `profileUrl` (`fetch_profile.data.url`), `canonical_extract` (`sourceArtifactId`, `sha256`, `claims`), `approved_facts` (`packetId`, `claims`), and `compare`.

**Steps:**
1. Re-run the Spec 146 `contradictionContextError` and `validateContradictionOutput` unchanged.
2. Zero contradictions fails closed.
3. Build one item per validated pair from the observed claim and the approved claim. Fail closed if the approved claim is `stale` or has no `evidenceIds`.
4. **Ordering:** severity rank (critical first), then `approvedClaimKey`, then `observedClaimId`. `evidenceIds` is the sorted union of the items'.
5. **Hash:** `requestSha256 = sha256(canonicalJson(request))`, using `lib/prospects/fact-manifest.ts:93`.

The model's `explanation` and any other unvalidated field are never copied. **The request carries no recipient and no email.** It is the approved *content*; the destination and email are resolved after approval (§7).

```ts
export const PROFILE_CORRECTION_REQUEST_VERSION = "profile-correction-request-v1";

export const profileCorrectionItemSchema = z.object({
  observedClaimId: z.string().min(1),             // = validated pair.observedClaimId
  approvedClaimId: z.string().uuid(),             // = validated pair.approvedClaimId (claims.id)
  approvedClaimKey: z.string().min(1),            // = PacketClaim.key
  observedStatement: z.string().min(1),           // = validated pair.statementA
  pageWording: z.string().min(1),                 // = observed claim originalWording (verbatim)
  approvedStatement: z.string().min(1),           // = PacketClaim.text, copied verbatim
  approvedAsOf: z.string().nullable(),            // = PacketClaim.asOf ?? effectiveDate ?? null
  severity: z.enum(SEVERITIES),                   // = validated pair.severity
  evidenceIds: z.array(z.string().uuid()).min(1), // = PacketClaim.evidenceIds
}).strict();

export const profileCorrectionRequestSchema = z.object({
  version: z.literal(PROFILE_CORRECTION_REQUEST_VERSION),
  projectId: z.string().uuid(),
  workflowRunId: z.string().uuid(),
  profileUrl: z.string().url(),
  beforeSourceArtifactId: z.string().uuid(),      // = canonical_extract.sourceArtifactId
  beforeSha256: z.string().regex(/^[0-9a-f]{64}$/),
  evidencePacketId: z.string().uuid(),            // = approved_facts.packetId
  items: z.array(profileCorrectionItemSchema).min(1),
  evidenceIds: z.array(z.string().uuid()).min(1),
  maxSeverity: z.enum(SEVERITIES),
}).strict();
```

`SEVERITIES` is imported from the Spec 146 contract module.

**Node output:** `{ request, requestSha256 }`. On any failure it returns `safe_stop` with the reason.

## 6. Deterministic correction validator

`validateProfileCorrectionRequest(request, context)` is pure. It returns `{ ok: true } | { ok: false, errors }`. `context` is `{ projectId, workflowRunId, profileUrl, canonicalExtract, approvedFacts, compare }`. **No model judges anything.**

1. **Schema.** The strict schema parses. Malformed, empty or extra-key input fails, and the strict schema leaves no room for free text.
2. **Scope.** `projectId`, `workflowRunId`, `profileUrl`, `beforeSourceArtifactId`, `beforeSha256` and `evidencePacketId` equal the context's values.
3. **The pairs are still valid.** The Spec 146 `validateContradictionOutput(compare, { observedClaims, approvedFacts })` passes.
4. **Coverage is exact.** The item pairs equal the `compare.contradictions` pairs: none missing, none extra or unrelated, none duplicated.
5. **Each item matches its pair:**
   - `observedStatement === pair.statementA`;
   - `pageWording` equals the observed claim's `originalWording`;
   - `approvedStatement` equals the approved claim's `text` exactly (check 3 already ties it to `statementB`);
   - `approvedClaimKey`, `approvedAsOf` and `severity` match;
   - `evidenceIds` equals the claim's `evidenceIds` as a set and is not empty.
6. **No stale approved facts.**
7. **Derived fields.** `evidenceIds` is the sorted union of the items', and `maxSeverity` is the highest item severity.

**Database check** (in the node): `select id, evidence_ids from claims where id = any($ids) and project_id = $projectId and status = 'approved'` covers every item, and each row's `evidence_ids` contains that item's `evidenceIds`. `evidence` has no `project_id`, so evidence is scoped through the claim that owns it.

**`dom.verify_profile_correction`:**
- **On failure** it returns `safe_stop` with all errors.
- **On success** it reconciles (§8.4), then inserts the correction row with `status = 'awaiting_approval'`. A unique violation returns `safe_stop`: "open correction exists (request, run)". It outputs `{ request, requestSha256, correctionRequestId }`.
- **In test mode** it returns `safe_stop`.

## 7. Approval, destination and email draft

### 7.1 Content approval

**The existing gate.** The `approve` node creates the existing `workflow_approvals` row (72 h deadline), listed on `/approvals` and linked to `/automation/runs/[runId]`.

**What the operator sees.** When `approval.detail.output.artifact.version === PROFILE_CORRECTION_REQUEST_VERSION`, the new `components/profile-corrections/correction-request-view.tsx` is rendered above the raw JSON. It shows:
- the profile URL and the before artifact;
- per item: the page wording, the approved fact (as of its date), the severity and the evidence count;
- `requestSha256`;
- **the destination state.** Either "will be drafted to `<name> <email>` (`client_editor` | `publisher`, basis …)", or **"No correction destination recorded. After approval this request waits as `destination_required`."**

**The decision** is the existing `ApprovalDecision` → `decideApprovalAction`: Approve or Reject with a rationale, written to `audit_log` as `workflow.approval.<decision>`.

**There is no in-place editing.** To change a request, reject it, fix the underlying claims or approved facts, and re-run the check, which rebuilds and revalidates everything.

### 7.2 Destination resolution: `dom.route_profile_correction`

Runs after approval, in one transaction:
1. Load the row for `ctx.runId` and `ctx.projectId`, with `status = 'awaiting_approval'`.
2. Require the run's `approve` approval to be `decision = 'approved'`, and `sha256(canonicalJson(approval.detail.output.artifact)) === row.request_sha256`. On failure it returns `failed_terminal`.
3. Record `approval_id`.
4. Look up the **active** destination for `(project_id, profile_url)` (§7.3).
   - **Found:** set `destination_id`, set `status = 'ready_to_draft'`, and `publishEvent(tx, { type: "profile.correction_ready", projectId, payload: { correctionRequestId }, dedupeKey: "profile-correction-draft:<id>" })`.
   - **Not found:** set `status = 'destination_required'`. **No email draft is created, and no event is published.** The run completes, and the card and run page show the request as waiting for a destination.
5. Write an audit row: `profile_correction.<status>`.

### 7.3 Correction destination: data model (decision)

**Rules:**
- A third-party profile correction is **never** sent to the client just because the client's email is the only one known.
- A destination exists only when an operator records one explicitly, for one profile URL, with a basis.
- The client's confirmed contact has exactly one legitimate role. It is a candidate prefill for a `client_editor` destination, offered when the operator records that the client's team edits that page, which is the documented model for portals (`onboarding-questions.ts:70`). It is never a default, and it is never inferred from the domain.

```sql
create table profile_correction_destinations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  profile_url text not null,
  -- client_editor: the client's own team applies the change on this page
  --   (their site; their Zillow/Realtor.com/Homes.com agent profile).
  -- publisher: the page's publisher accepts corrections from us on the
  --   client's behalf (news, ranking, directory, another firm's site).
  kind text not null check (kind in ('client_editor', 'publisher')),
  recipient_name text not null check (length(trim(recipient_name)) > 0),
  email text not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  -- Why this is the right destination, in the operator's words
  -- ("Client confirmed on 2026-10-01 that Maria edits the Zillow profile").
  basis text not null check (length(trim(basis)) > 0),
  -- Where a publisher's corrections address was found. Required for publishers.
  source_url text,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by uuid references users(id),
  constraint profile_correction_destinations_publisher_source
    check (kind <> 'publisher' or source_url is not null)
);
create unique index profile_correction_destinations_one_active
  on profile_correction_destinations (project_id, profile_url) where archived_at is null;
```

**Lifecycle:**
- **Insert-only, plus archive.** Changing a destination archives the active row and inserts a new one in the same transaction. No update trigger allows any other column to change.
- **Email channel only in v1.** A publisher that accepts corrections only through a web form has no destination. Its requests stay `destination_required`, visible on the card, and the operator can withdraw them (below).

**Operator actions** (`app/projects/[id]/engagement/actions.ts` → `lib/profile-corrections/destinations.ts`; operator role plus `assertProjectAccess`; each writes an `audit_log` row):
- **`setCorrectionDestination(projectId, { profileUrl, kind, recipientName, email, basis, sourceUrl? })`.** The URL must be one of the project's confirmed URLs (§2). The prefill candidates are the confirmed contact (identity `value.contactEmail` plus the engagement's `primary_contact_name`), offered only when `kind = 'client_editor'` is chosen.

  In the same transaction, every `destination_required` row for that URL moves to `ready_to_draft`, with `destination_id` set, and publishes `profile.correction_ready`. **This is how "supply the destination later" resumes.**
- **`archiveCorrectionDestination(projectId, destinationId, reason)`.**
- **`withdrawCorrectionRequest(projectId, correctionRequestId, reason)`.** It moves a `destination_required` or `ready_to_draft` row to `withdrawn`, which frees the profile for future checks.

**UI:** the "Profile checks" card shows each URL's destination and a small shadcn form to set or replace it, plus Withdraw on waiting requests.

### 7.4 Email draft

**`dom.prepare_profile_correction_draft`** (draft workflow):
1. **Reload.** Reload the row (`ready_to_draft`, same project) and the active destination. The destination must be unchanged since routing. If it was archived, the row returns to `destination_required` (guarded) and the node returns `safe_stop`.
2. **Revalidate before any draft exists:**
   - The original run's `approve` approval is `approved`, and its artifact hash equals `row.request_sha256`.
   - For publishers, this run's `authorize_external` approval is `approved`.
   - `validateProfileCorrectionRequest` is re-run against the **original run's stored node outputs** (`canonical_extract`, `approved_facts`, `compare`, loaded from `node_runs` by `row.workflow_run_id`), together with the claims database check, so a fact unapproved since approval fails.

   Any failure returns `failed_terminal`, and no connector is called.
3. **Render** `renderProfileCorrectionEmail(request, destination, subjectName)` (`lib/profile-corrections/email.ts`; pure; versioned constants). `subjectName` comes from `loadClientSubjectIdentity` (`lib/knowledge/entities/subject-identity.ts`).

   | Destination | Template | Content |
   |---|---|---|
   | `client_editor` | `profile-correction-email-client-editor-v1` | A greeting to `recipient_name`. The page was checked against the facts the client approved. Per item, `The page says: "<pageWording>"` and `Approved fact: "<approvedStatement>"` (as of …). A request to update the page, and a note that it will be rechecked in `PROFILE_RECHECK_DAYS` days. |
   | `publisher` | `profile-correction-email-publisher-v1` | A greeting to `recipient_name`. A statement that we are writing on behalf of `subjectName` about the page at `profileUrl`. The same per-item lines. A request to correct the page. |

   Neither template includes internal ids, severity wording or model text. Every factual line is a validated, quoted statement.
4. **Output** exactly `{ to: destination.email, subject, body }`, plus `templateVersion` and `emailSha256` recorded on the row. The row's `email` column is written once and is immutable afterwards.

**Draft and send.**
- `submit` uses the existing `email.create_draft` (the Gmail adapter, `POST /users/{id}/drafts`). `from` comes from the connection's `sendAsAddress`; if it is missing, the node returns `failed_terminal`.
- The engine's level-2 approval on `submit` is the **send confirmation**. The operator reviews the Gmail draft, sends it from Gmail, then approves. Rejecting, or the 72 h timeout, ends the run; reconciliation sets the row to `expired`, and the draft stays in Gmail.
- `email.send_approved_message` appears nowhere in any of these workflows.

## 8. Records

### 8.1 `profile_correction_requests` (a slice 2 migration, reversible; slice 1's migration 120 creates only the queue, §8.5)

```sql
create table profile_correction_requests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  workflow_run_id uuid not null unique references workflow_runs(id),
  context_item_id uuid references engagement_context_items(id),
  profile_url text not null,
  request_version text not null,
  request jsonb not null,
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  before_source_artifact_id uuid not null references source_artifacts(id),
  before_sha256 text not null,
  evidence_packet_id uuid not null references evidence_packets(id),
  status text not null default 'awaiting_approval' check (status in (
    'awaiting_approval', 'destination_required', 'ready_to_draft', 'sent',
    'rejected', 'expired', 'withdrawn',
    'corrected', 'still_incorrect', 'needs_review', 'unreachable')),
  approval_id uuid references workflow_approvals(id),
  destination_id uuid references profile_correction_destinations(id),
  draft_run_id uuid references workflow_runs(id),
  email jsonb,
  email_draft_id text,
  sent_confirmed_at timestamptz,
  recheck_due_at timestamptz,
  recheck_run_id uuid references workflow_runs(id),
  after_source_artifact_id uuid references source_artifacts(id),
  outcome jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index profile_correction_requests_one_open
  on profile_correction_requests (project_id, profile_url)
  where status in ('awaiting_approval', 'destination_required', 'ready_to_draft', 'sent');
```

The **same migration** also creates `profile_correction_destinations` (§7.3) and `profile_check_requests` (§8.5).

**Immutability triggers:**
- `profile_correction_requests`: the identity, request and before columns can never change, `email` can be set once, and `delete` is forbidden.
- `profile_correction_destinations`: only `archived_at` and `archived_by` can be set, once each, and `delete` is forbidden.

**Down migration:** drops the triggers, the functions and the three tables, in reverse dependency order. It is tested up, down and up.

### 8.2 Status lifecycle

```
awaiting_approval ─approve→ ready_to_draft (destination known) | destination_required (unknown)
destination_required ─operator sets destination→ ready_to_draft
destination_required | ready_to_draft ─operator withdraws→ withdrawn
ready_to_draft ─send confirmed (record_sent)→ sent
sent ─recheck→ corrected | still_incorrect | needs_review | unreachable
awaiting_approval ─run stopped→ rejected (approval rejected) | expired
ready_to_draft ─draft run stopped→ expired
```

Every transition is a guarded `update ... where status = $expected returning id`, written with an `audit_log` row (`profile_correction.<status>`, scoped to the project).

### 8.3 Audit trail

For one correction:
- the `profile_check_requests` row;
- the `domain_events` rows;
- the check run and its outputs;
- the before `source_artifacts` row;
- the `evidence_packets` row;
- the content approval;
- the destination row, with its basis and author;
- for publishers, the external-submission approval;
- the draft run;
- `connector.email.create_draft`;
- the send confirmation;
- the correction row and its audit rows;
- the recheck run and the after artifact.

### 8.4 Reconciliation

`reconcileProfileCorrections(projectId)` runs at start, inside `verify_correction`'s insert, and when the card loads:

| Row status | Condition | New status |
|---|---|---|
| `awaiting_approval` | the check run is stopped (`safely_stopped`, `failed`, `cancelled`, `timed_out`, `partially_completed`) | `rejected` if the approval was rejected, otherwise `expired` |
| `ready_to_draft` | the draft run is stopped, or there has been no draft run for `PROFILE_CHECK_RELEASE_TIMEOUT_MINUTES` since the row became `ready_to_draft` | `expired`, with the reason |
| `sent` | the recheck request is `failed` or `skipped`, or the recheck run ended in a non-`completed` state | `needs_review`, with the reason |

### 8.5 `profile_check_requests` (the queue)

```sql
create table profile_check_requests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  kind text not null check (kind in ('check', 'recheck')),
  context_item_id uuid references engagement_context_items(id),
  correction_request_id uuid references profile_correction_requests(id),
  profile_url text not null,
  origin text not null check (origin in ('operator', 'schedule', 'recheck')),
  window_key text not null,
  not_before timestamptz not null default now(),
  status text not null default 'queued'
    check (status in ('queued', 'released', 'skipped', 'failed')),
  reason text,
  run_idempotency_key text not null,
  event_id uuid references domain_events(id),
  requested_by uuid references users(id),
  created_at timestamptz not null default now(),
  released_at timestamptz,
  constraint profile_check_requests_kind_ref check (
    (kind = 'check' and context_item_id is not null and correction_request_id is null) or
    (kind = 'recheck' and correction_request_id is not null))
);
create unique index profile_check_requests_one_check
  on profile_check_requests (project_id, context_item_id, window_key) where kind = 'check';
create unique index profile_check_requests_one_recheck
  on profile_check_requests (correction_request_id) where kind = 'recheck';
create index profile_check_requests_due on profile_check_requests (status, not_before);
```

## 9. Before and after evidence, and the recheck

### 9.1 `dom.record_profile_correction_sent`

Runs after the send confirmation, in one transaction:
1. Require the row to be `ready_to_draft` for this draft run and project, `submit.ok === true`, and a non-empty `submit.data.draftId`. A test-mode skip is never recorded as sent.
2. Set `status = 'sent'`, `email_draft_id`, `sent_confirmed_at = now()`, and `recheck_due_at = now() + PROFILE_RECHECK_DAYS (14) days`, guarded by `status = 'ready_to_draft' and recheck_due_at is null`.
3. Only if that update returned the row, insert one `profile_check_requests` row: `kind = 'recheck'`, `origin = 'recheck'`, `not_before = recheck_due_at`, `window_key = 'recheck'`, and `run_idempotency_key = 'live:profile-recheck:<id>'`. The unique index allows only one per correction.

**Nothing new handles the scheduling.** The dispatcher (§3.3) releases the row once it falls due, under the same inference bound. There is no separate delayed job type. `det.schedule_remeasurement` is not used.

### 9.2 Evidence

- **Before:** the full stored page from `canonical_extract`'s `source_artifacts` row (`before_source_artifact_id`, `before_sha256`).
- **Link:** the row ties together the request, `request_sha256`, `approval_id`, `destination_id`, `email`, `email_draft_id` and `sent_confirmed_at`.
- **After:** the recheck's `source_artifacts` row (`after_source_artifact_id`). An unreachable page has no after artifact, and its status is kept in `outcome`.

### 9.3 `reputation_profile_recheck_v1`

**Settings:**
- `clientScope: "client_required"`;
- autonomy 3, risk medium;
- `requiredConnectors: []`;
- `maxConcurrentRuns: 25`;
- trigger: `profile.recheck_due`.

It reuses `canonical_extract`, `approved_facts` and `compare` with **identical** configs (the v2 pin included).

```
entry(trg.domain_event) → load_request → fetch_profile → precheck
precheck ─proceedToCompare=true→ canonical_extract → approved_facts → compare → classify
precheck ─proceedToCompare=false→ classify
classify → done
```

The branches are `when(...)` edges, and `compare → classify` has `required: false`. Under `computeReady` (`graph.ts:299-345`), on the changed path `classify` waits for `compare`. On the other paths it runs straight from `precheck`, and the branch not taken never becomes ready.

**`load_request`** (`dom.load_profile_correction` with `{ expect: "sent" }`):
- It requires `row.project_id === ctx.projectId`, `row.profile_url === payload.profileUrl` and `status = 'sent'`. Any mismatch returns `failed_terminal`.
- It records `recheck_run_id`, guarded by `recheck_run_id is null`. A different id already set is a duplicate and returns `failed_terminal`.

**`fetch_profile`:** `dom.fetch_public_profile` with `{ urlPath: "load_request.profileUrl" }`. The URL comes from the immutable row.

**`precheck`** (`dom.precheck_profile_recheck`):
- **Refused or missing URL.** If `fetch_profile.ok !== true` (a policy refusal or no URL), it returns `failed_terminal`. A refusal is never recorded as "unreachable".
- **Unreachable.** If `data.reachable !== true`, the result is `unreachable` (with `status`), and `proceedToCompare` is `false`.
- **Otherwise** it calls `ingestSource` exactly as `canonical_extract` does:

  | Ingest result | Precheck result | `proceedToCompare` |
  |---|---|---|
  | duplicate, and the artifact equals `beforeSourceArtifactId` | `unchanged` | `false` |
  | duplicate of another artifact already in `claims_proposed` | `previously_seen` | `false` |
  | anything else | `changed` | `true` |

  A freshly ingested artifact is `normalized` or `pending` (`ingest.ts:333`). So on `changed`, `canonical_extract`'s re-ingest finds it is not `claims_proposed` and extracts normally.

**`classify`** (`dom.classify_profile_recheck`). It calls the pure `classifyProfileRecheck` in `lib/profile-corrections/recheck.ts`.

The precheck result decides first:

| Precheck result | Outcome |
|---|---|
| `unreachable` | `unreachable` |
| `unchanged` | `still_incorrect`, with no model call |
| `previously_seen` | `needs_review` |
| `changed` | decided per item, as below |

For `changed`, each item is classified by its `approvedClaimId`:
- `needs_review` if the approved claim is no longer present;
- `still_incorrect` if a current contradiction has the same approved id and a `statementA` matching `observedStatement` or `pageWording` under `normalizeStatement`;
- `needs_review` if a current contradiction has the same approved id with different wording;
- `corrected` otherwise.

The run outcome for `changed` is `still_incorrect` if any item is still incorrect; otherwise `needs_review` if any item needs review or a new contradiction exists; otherwise `corrected`.

The node updates the row, guarded by `status = 'sent' and recheck_run_id = ctx.runId`, and writes an audit row.

**`normalizeStatement`** is the private helper in `lib/automation/contradictions/contract.ts`. It gets an `export` keyword, which is its only edit and changes no behaviour.

**Failure.** A safe-stop on the changed path records no outcome, and reconciliation later sets `needs_review`. A failed recheck is never recorded as `corrected`, and a recheck never drafts anything.

## 10. Fail-closed behaviour

| Condition | Result |
|---|---|
| Missing or invalid URL | Skipped at start (`no_url`, `invalid_url`). In a run, `fetch_profile` reports `ok: false`, and `canonical_extract` or `precheck` stops. |
| Private or forbidden host, or over the size cap | `safeFetch` refuses it, so `ok: false, policy_refused`. The check safe-stops, and a recheck returns `failed_terminal`, never "unreachable". |
| Zero confirmed profiles | `queued: 0`, `no_confirmed_profiles`. |
| No approved facts | The project is `blocked`, so there is no false clean. |
| Approved fact missing, unapproved, stale, from another project, or with no evidence | `safe_stop` before approval. At draft time, `failed_terminal`. |
| Invalid contradiction pair | The Spec 146 guard at `compare`, then `safe_stop` in the builder and validator. |
| Invented, edited or extra statement, wrong fact or evidence, missing, duplicate or unrelated pair | The validator returns `safe_stop`. |
| Tenant mismatch | `ctx.projectId` everywhere, the claims database check, `load_*` checks, the bus check, and the destination's URL limited to the project's confirmed URLs. |
| Stale workflow version | The `requestVersion` pin on every new node, plus Spec 146's `agentVersion` guard. |
| Unreachable page | The first check safe-stops (unchanged). The recheck records `unreachable`. |
| Duplicate correction | The open-row unique index, plus the `open_correction` skip at queue and at release. |
| Duplicate check or recheck | Queue unique indexes, event `dedupeKey`, idempotency keys, row guards. |
| **Unknown destination** | `destination_required`. No draft and no event, until an operator records a destination or withdraws the request. |
| Destination changed after routing | `prepare_draft` returns the row to `destination_required` and safe-stops. |
| Missing approval (content, external submission or send) | `route_correction` or `prepare_draft` returns `failed_terminal`, and no Gmail call is made. Without a send confirmation there is no `sent` status and no recheck. |
| Inference saturation | Rows wait `queued`. At most `PROFILE_CHECK_MAX_INFERENCE_RUNS` runs are inference-active. A stuck release fails after 15 minutes and frees its slot. |

## 11. Paid model calls removed

| Node | Before | After |
|---|---|---|
| `draft_correction` (`draft_outreach`) | `openai` / `gpt-5.4-2026-03-05` / `paid_api` | Removed. The builder and template are deterministic. |
| `verify_correction` (`verify_claims`) | `openai` / `gpt-5.4-2026-03-05` / `paid_api` | Removed. The validator is deterministic. |

The only `agt.*` node in any of the three workflows is `compare`: `detect_contradictions` on `ollama` / `qwen3:30b`, locally. `canonical_extract` keeps its local `gpt-oss:20b` extraction. Routing tables are unchanged.

## 12. Tests

### Unit tests (`tests/unit/`)

- **`profile-corrections-start.test.ts`**
  - the operator and scheduled starts queue one row per confirmed URL;
  - URLs from another project are never read;
  - zero URLs; one URL failing while the rest queue; one project failing in the weekly loop;
  - the skip reasons;
  - `blocked` with no approved facts;
  - a client role is rejected.
- **`profile-corrections-dispatch.test.ts`**
  - releases never exceed `PROFILE_CHECK_MAX_INFERENCE_RUNS`, whether the default of 1 or a configured value;
  - parked (`waiting_for_approval`) runs do not count;
  - release order is FIFO by `not_before`;
  - a released row with no run times out to `failed`;
  - a recheck row is not released before `not_before`;
  - an open correction found at release becomes `skipped`;
  - the env value is validated.
- **`profile-fetch-public.test.ts`** (`safeFetch` mocked)
  - 200 gives reachable;
  - 404 gives `ok: true` but unreachable;
  - a timeout or DNS error gives unreachable;
  - a private host or over-size response gives `policy_refused` with `ok: false`;
  - no URL gives `ok: false`;
  - no `provider` is emitted;
  - `executeCapability` is never called.
- **`profile-correction-request.test.ts`** (known-answer fixtures)
  - an exact pair produces the expected item;
  - each of these is rejected: an invented statement, edited page wording, a wrong approved fact, a wrong evidence id, empty evidence, a missing, duplicate or unrelated pair, a stale fact, an extra key, a scope mismatch, and malformed or empty input;
  - ordering and the hash are stable.
- **`profile-correction-email.test.ts`**
  - both templates render known output;
  - only validated fields appear.
- **`profile-correction-destinations.test.ts`**
  - setting a destination for a URL outside the project's confirmed list is rejected;
  - a publisher with no `source_url` is rejected;
  - replacing a destination archives the old one;
  - the client contact is offered as a prefill only for `client_editor`;
  - setting a destination moves `destination_required` rows to `ready_to_draft` and publishes the event.
- **`profile-correction-recheck.test.ts`**
  - corrected;
  - still incorrect, both for an unchanged page and for the same wording;
  - needs review, for changed wording, a missing fact, and a new contradiction;
  - unreachable;
  - previously seen.
- **`profile-correction-workflow.test.ts`** (extended)
  - the front half deep-equals its pre-147 definitions, except `fetch_profile`, which is asserted separately;
  - the back half matches §5.1, and the draft and recheck graphs match §5.2–§5.3;
  - no `agt.draft_outreach`, `agt.verify_claims`, `int.cms_fetch_public_page`, `email.send_approved_message` or `det.schedule_remeasurement` appears in any of the three workflows;
  - every `agt.*` resolves to `execution: "local"`;
  - `requiredConnectors` is `[]` for check and recheck, and `["email.create_draft"]` for draft;
  - `validateAutomationDefinition` and `validateNodePaths` return `[]`.
- **`profile-correction-nodes.test.ts`**
  - `route_correction` refuses a missing or hash-mismatched approval;
  - `prepare_draft` makes no connector call when the content approval is missing, pending or rejected, when a publisher has no external authorization, when the hash differs (a simulated edit), when revalidation fails, or when the destination was archived;
  - a `requestVersion` mismatch fails in every node;
  - test mode refuses.
- **Updated:**
  - `automation-workflows.test.ts`: the count goes from 19 to 22;
  - `automation-mapping.test.ts`: three new events;
  - `profile-correction-live-input.test.ts`: the fetch cases are rewritten (§4); entry, trigger and schedule are unchanged.

### Integration tests (`tests/integration/profile-correction-e2e.test.ts`, real test database; `safeFetch`, the Gmail adapter and `runAgent` stubbed)

- **Starting.** Two projects; the URLs queue per project only, and a repeat in the same window queues nothing.
- **Concurrency.** Three URLs with the limit at 1: one run is active, two rows stay queued, and the next is released only after the first parks at approval.
- **No WordPress.** A full check succeeds with no `connector_connections` rows.
- **Known destination.** check → contradiction → `awaiting_approval` → approve → `ready_to_draft` → draft run → Gmail draft with exactly `{ to, subject, body }` → send confirmation → `sent` → one recheck queue row due in 14 days.
- **Unknown destination.** approve → `destination_required`, with no draft run and no Gmail call → the operator sets a destination → `ready_to_draft` → draft.
- **Publisher destination.** `authorize_external` is required, and a rejection means no draft.
- **Approval.** No draft before approval. A rejection ends with the row `rejected` and no draft.
- **Duplicate.** A second open request for the same profile safe-stops.
- **Tenant.** An approved claim id from another project safe-stops.
- **Recheck.** Dispatching a due recheck gives corrected (page changed, `[]`), still wrong (unchanged, with no `compare` call), or unreachable. A second dispatch, or a `record_sent` retry, gives exactly one recheck.
- **Migration 120** up, down and up. The immutable columns and deletes are rejected.

### Regression (unchanged and passing)

- Specs 145B, 145D and 145E: `profile-canonical-claim-extraction`, `profile-subject-filtering`, `claim-cross-artifact-dedup`, `knowledge-layer`, `discovery`.
- Spec 145C: the rewritten `profile-correction-live-input`.
- Spec 146: `detect-contradictions-contract`, `detect-contradictions-open-weight-routing`, `internal-production-routing`, `support-triage-open-weight-routing`.
- The full unit suite; `workflow-engine`, `automation-layer`, `automation-dispatch`.
- Typecheck, lint and `git diff --check`.

## 13. Non-goals

- Measurement providers; any Spec 146 change; any change to Specs 145B, 145D or 145E.
- Onboarding redesign: website/profile distinction, archiving context items, collecting destinations at intake.
- Automatic sending. Web-form or API submission to publishers (email destinations only). Inferring a destination from the domain.
- A CRM, a generic scheduler or queue, or a semantic rewriting model.
- UI beyond the "Profile checks" card (with destination form, withdraw and queue state) and the correction-request view.
- Changing `cms.fetch_public_page`, `det.schedule_remeasurement`, or the disabled `profile_scan` template.
- Omission detection.

## 14. Operational prerequisites (checked at deploy)

- **Gmail.** A Gmail connection with `gmail.compose` and `sendAsAddress`, for the draft workflow only. The adapter is `implemented_unverified`, so the first live draft is checked by hand.
- **No old-version runs.** No non-terminal runs of `reputation_profile_correction_v1` on its old version.
- **Concurrency.** Keep `PROFILE_CHECK_MAX_INFERENCE_RUNS = 1` until the Spec 146 deferred SLO validation passes. Raise it only after re-measuring at the higher concurrency.

## Acceptance Criteria

- [ ] `listConfirmedProfileUrls` matches §2.
- [ ] `startProfileChecks` and `startWeeklyProfileChecks` queue as in §3.2. The dispatcher bounds inference-active runs as in §3.3.
- [ ] `PROFILE_CHECK_MAX_INFERENCE_RUNS` is in `lib/env.ts`, with a default of 1.
- [ ] `fetch_profile` uses `dom.fetch_public_profile` through `safeFetch`. No profile workflow requires a WordPress connection.
- [ ] `canonical_extract`, `approved_facts`, `compare`, `has_error`, `no_error` and `severity` are unchanged, proven by deep equality.
- [ ] The correction, draft and recheck workflows match §5 and §9.3. The removed nodes are gone.
- [ ] The builder, validator and both email templates are pure and versioned, with known-answer tests.
- [ ] Destinations follow §7.3. An unknown destination leads to `destination_required` with no draft. Setting a destination resumes it. Publishers require `approve_external_submission`.
- [ ] Migration 120 creates the three tables, the indexes and the immutability triggers. It is reversible and tested.
- [ ] The approval view, the card, the destination form and withdraw exist, with loading, empty and error states.
- [ ] Reconciliation follows §8.4. A failed recheck is never recorded as `corrected`.
- [ ] Every test in §12 passes, along with typecheck, lint and `git diff --check`.
- [ ] `docs/03-database-schema.md` is updated. DECISIONS.md is updated.

## Files Expected To Change

- **New:**
  - `db/migrations/120_profile_check_requests.sql` (slice 1: the queue), plus a slice 2 migration for the correction and destination tables
  - `db/profile-corrections.ts`
  - `lib/profile-corrections/constants.ts`, `start.ts`, `dispatch.ts`, `request.ts`, `email.ts`, `destinations.ts`, `recheck.ts`, `reconcile.ts`
  - `lib/automation/nodes/profile-correction.ts`
  - `components/engagements/profile-checks.tsx`
  - `components/profile-corrections/correction-request-view.tsx`
  - the tests in §12
- **Changed:**
  - `lib/automation/workflows/authority.ts`: the correction back half, `fetch_profile`, the triggers, `requiredConnectors` and `maxConcurrentRuns`; plus the draft and recheck workflows and `authorityWorkflows`
  - `lib/automation/nodes/index.ts`
  - `lib/automation/contradictions/contract.ts`: `export` on `normalizeStatement` only
  - `lib/events/catalog.ts`
  - `lib/env.ts`
  - `lib/ops/tick.ts`: `runWeeklyKick` and `runAutomationTick`
  - `workers/core.ts`: `profile_check_dispatch`
  - `app/projects/[id]/engagement/actions.ts` and `page.tsx`
  - `app/automation/runs/[runId]/page.tsx`
  - `tests/unit/automation-workflows.test.ts`, `automation-mapping.test.ts`, `profile-correction-workflow.test.ts`, `profile-correction-live-input.test.ts`
  - `docs/03-database-schema.md`, `DECISIONS.md`

> **UNRESOLVED QUESTIONS:** none on design. The §14 items are operational checks.
