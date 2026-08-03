# Pilot Launch Plan — Finish the Tool

> Date: 2026-07-31 · Derived from the full 295-item platform QA audit
> (nine-agent code trace, this date; findings summarized per section in
> the audit conversation and cross-referenced against
> `current-system-audit.md` / `target-gap-analysis.md` /
> `audits/paid-pilot-readiness.md`).
>
> **Scope decision (operator, 2026-07-31):** drive to a sellable paid
> pilot first, then grow toward five clients. Revenue attribution stays
> deferred (re-confirmed). Solo operator for the next quarter — RLS
> depth and multi-operator role separation move to the post-pilot track;
> correctness and the operator loop move up.
>
> Sizes: S (< half day) · M (1–2 days) · L (3–5 days). Standing rules
> apply: spec first for new capabilities, tests green before the next
> item, DECISIONS.md updated for non-obvious calls. **[operator]** marks
> steps only the human can perform.
>
> Estimated calendar to "sell the pilot": **~3 weeks solo** (15–18
> working days, milestones A–E in order).

---

## Milestone A — Trust the numbers (P0 correctness) · ~3–4 days

Nothing client-facing ships while any of these are open. Each one is a
path by which the platform can report something false.

| # | Task | Defect being fixed | Acceptance criteria | Size |
|---|---|---|---|---|
| A1 | **Make the mock provider unreachable in production** | `lib/ai/registry.ts:14` registers `mock` unconditionally and `app/projects/[id]/runs/new/page.tsx:20` falls back to `["mock"]` when no keys are configured — fabricated answers flow into real `scores` | `getProvider("mock")` throws outside test/dev-explicit; run creation with zero configured providers is a hard error with instructions, not a silent fallback; regression test | S |
| A2 | **Fix pricing coverage; unknown model = loud** | `lib/ai/pricing.ts` lacks entries for `gemini-3-*-preview` and `*+search` Anthropic ids; `costMicroUsd` returns 0 for unknown models, silently disabling the run budget cap | All model ids offered by adapters have priced (or consciously-flagged) entries; unknown model raises/flags instead of returning 0; budget-cap test with a Gemini id | S |
| A3 | **Crash recovery: stale-`running` reaper + honest settle** | Worker death mid-node strands `node_runs` at `running`; `settleRun` then marks the run `completed` ("no reachable work remains", `lib/workflow/engine.ts:723-728`) — an interrupted run reported as done | Reaper (worker sweep) resets `running` nodes past `started_at + timeoutSeconds` to `failed_retryable`; `settleRun` refuses `completed` while any instance is unsettled (safe-stop + exception instead); integration test simulates a mid-node crash | M |
| A4 | **Make approval timeouts actually fire** | `checkApprovalTimeouts` is only reachable inside a tick, and a run parking at `awaiting_approval` enqueues no follow-up tick — unanswered approvals wait forever | Parking a run enqueues a delayed `advance_workflow`; test with a short SLA proves timeout → node `timed_out`, run `safely_stopped`, exception raised | S |
| A5 | **Test the crash-recovery substrate** | `reclaimStaleJobs` (the only worker-crash recovery) and the entire `workers/index.ts` dispatch loop have zero test coverage; the e2e test reimplements the loop | Tests: stale lease reclaimed exactly once; a running job is not double-claimed; dead-letter after `JOB_MAX_ATTEMPTS`; the worker loop itself imported (extract a testable `dispatchOnce()`) | M |
| A6 | **Scoring-version hygiene in the UI** | `db/dashboard.ts` and `db/competitors.ts` mix scoring versions in trends (forbidden by `lib/constants.ts:29-31`); dashboard hardcodes "v1.0" while `SCORING_VERSION="v1.1"`; run page renders authority 0–100 as a percentage ("5520.0%") | All score reads filter `scoring_version`; version label sourced from the constant; authority renders correctly; regression tests | S |
| A7 | **Approval version-pinning made real** | The bodyHash check reads `detail.bodyHash` but the engine writes `detail.output.artifact.bodyHash` → always soft-passes "no hash recorded" | `insertApproval` stores an `artifact_hash`; absent hash **fails** the send check instead of passing; the existing gate test exercises the real write path, not a hand-inserted shape | S |

**Gate A:** full suite green including the new tests.

## Milestone B — Verify the instrument · ~2 days

| # | Task | Acceptance criteria | Size |
|---|---|---|---|
| B1 | **[operator]** Live-verify Anthropic + Perplexity via `scripts/verify-providers.ts`; record results in the spec header and flip the in-file `verified` notes | One real measurement per provider exists; prices verified or flagged | S |
| B2 | **[operator]** Turn scheduling on: set `CRON_SECRET`, install launchd entries for weekly-cycle, automation heartbeat, and notification sync; add a missed-cycle alert (stale-client notification kind exists) | Monday cycle fires unattended; a skipped week produces an alert, not silence | S |
| B3 | Give workers a system principal — `analyze_gaps` / `analyze_accuracy` / `build_evidence_export` handlers stop calling `getCurrentUser()` (no request context; breaks under `AUTH_MODE=supabase`) | Handlers run under an explicit system actor; audit rows distinguish "platform" from "unknown" | S |
| B4 | Concurrency lock for the test DB — concurrent `npm test` invocations currently corrupt each other (`drop schema public cascade` race) | Second concurrent run fails fast with a clear message (advisory lock), instead of both failing weirdly | S |

## Milestone C — Close the operator loop · ~4–5 days

The pilot week is operated through these surfaces; today several loops
can be *seen* but not *completed*.

| # | Task | Defect | Acceptance criteria | Size |
|---|---|---|---|---|
| C1 | Add `/automation` to sidebar nav + command palette | The repo's best operational surface (connectors, triggers, workflow gallery, richest run detail) has zero inbound links | Reachable from nav; palette finds it | S |
| C2 | Build `/approvals` inbox; converge the two divergent approval components into one | No inbox exists; two components with different validation rules call different actions against the same table; control tower deep-links automation approvals to the weaker legacy page | One inbox lists all pending approvals with age/SLA; one component; queue rows link to it | M |
| C3 | Wire exception resolution into the control-tower queue | `resolveExceptionAction` / `resolveAutomationException` exist with zero UI callers — exceptions are visible in three places, resolvable in none | Resolve (with rationale) from the queue row; resolved items leave the queue | S |
| C4 | Fix the weekly executive brief: populate `evidenceIds` on material statements; add a reader page; put `weekly_brief_v1` on the weekly cron | Brief currently fails its own evidence gate in any week where something material happened, and `executive_briefs` is write-only | A week with real deltas produces a brief; the brief is readable in-app; health snapshots populate the control tower without manual runs | M |
| C5 | Surface the computed-but-invisible metrics; fix the mislabeled tile | `completionRate`/`failureRate`/`safeStopRate` and `agentMetrics()` have zero consumers; control tower's "Failed runs (7d)" counts *benchmark* runs inside the workflow grid | Rates rendered on `/automation`; agent table shows measured values; tile renamed or re-sourced | S |
| C6 | Notifications feed includes `workflow_exceptions` | An operator watching `/notifications` never sees a failed workflow ("no silent failures" hole) | Failed workflow appears in the feed with a deep link | S |

## Milestone D — Content quality + knowledge write paths · ~4–5 days

The content the pilot buys must go through the safety machinery that
already exists but is bypassed.

| # | Task | Defect | Acceptance criteria | Size |
|---|---|---|---|---|
| D1 | Route drafting through the packet + adversarial review; feed verifier output into redrafts | `lib/content/service.ts` hands the drafting agent **every** approved claim (no privacy/freshness/budget) while building and discarding a packet; adversarial review isn't on the shipped path; a failed verify redrafts with no memory of why | `generateDraft`/`createBriefFromFinding` consume `buildValidatedPacket(content_drafting)`; adversarial review runs before approval; the prior verification report is in the redraft prompt; existing content tests updated | M |
| D2 | Claim lifecycle write paths: `review_date`/`effective_date` UI, contradiction resolution, per-project weekly scan | All three expiry detectors key on `review_date`, which nothing writes; `resolveContradiction` has zero callers; the cron scan passes no `projectId` so it never runs | Dates settable on a claim; expired-claim detection fires on a fixture; contradictions resolvable with rationale + audit; weekly scan iterates projects | M |
| D3 | Source upload + extraction trigger + instruction write path | Operators cannot add a PDF/CSV/transcript (no upload UI or route); ingested sources sit at `normalized` forever (`extractClaimsFromSource` has no production trigger); `knowledge_instructions` is empty in production so drafting has no brand-voice/prohibited rules | Upload → ingest → extract → proposed claims for a real PDF; instruction create/revise/approve from the UI; packets stop emitting `missing_instruction` | M |
| D4 | Prohibited-wording enforcement | Columns read in four places, written only by the seed script; `validateContent` never checks them | Wording editable on a claim; a draft using prohibited wording fails the deterministic gate | S |

## Milestone E — Pilot dry run, then sell · ~2–3 days

| # | Task | Acceptance criteria | Size |
|---|---|---|---|
| E1 | Full dress rehearsal on a real client project: scheduled weekly cycle end-to-end (measure → classify → review → score → gaps → accuracy → pulse), one published monthly report with category ownership, one intervention with scheduled remeasurement | Every step through the real UI, zero manual SQL; the report's every number citation-resolves | M |
| E2 | **[operator]** Portal check in Supabase auth mode: invite a test client login, verify isolation and the reports tab | Client sees only their project, published reports, client-visible work | S |
| E3 | Write the pilot scope one-pager (sold: measurement, reports, interventions, portal · not sold: attribution, live integrations, automated workflows) — mirrors `audits/paid-pilot-readiness.md` | Doc exists; sales conversation has a boundary | S |

**Gate E = launch:** A–D green, dress rehearsal clean. Sell the pilot.

---

## Post-pilot track (toward five clients — start only after launch)

Ordered; pull items forward only if a signed client forces them.

1. **Connector front door** — connection-create server action + admin page
   (pasted token first; OAuth redirect later). Then verify **GA4 live** as
   the first external adapter. Unblocks the nine `implemented_unverified`
   adapters, which are currently unreachable (0 connections ever created).
2. **`notification.send_client` adapter** (email via Gmail adapter or
   internal→email bridge) — three delivery workflows' only client-facing
   output currently throws `not_found`.
3. **Wire the automation library for real**: publish the ten producer-less
   domain events from existing code paths (`client.created` from
   onboarding, `content.opportunity_created` from gaps, …); pass
   `approvalId` into the two send nodes; replace the placeholder
   `det.query_records` nodes in the workflows worth keeping.
4. **Delete-or-wire pass** — shrink the surface a solo operator carries:
   hollow workflow twins (integration-health, weekly-ops, monthly-report
   duplicates of real services), `verifyArtifact`/`isDisagreement`,
   `lockRun`, `loop.maxIterations`, `report_cadences`, unused
   `waiting_for_external_system`. Each is either wired with a test or
   deleted with a DECISIONS entry.
5. **Hosted deployment + real auth**: Supabase project, worker host,
   durable scheduling; RLS on client-data tables via a non-owner app role
   (the second isolation layer that today protects nothing). Spec 014
   completion.
6. **Client offboarding spec** — reconcile "never delete experiment data"
   with contractual deletion; portal-grant revocation; retention sweep.
   Record the resolution in DECISIONS.md.
7. **Agent accountability**: `agent_invocations` trace table written by
   `runAgent`; one real eval suite (start with the mention classifier
   against accumulated human corrections — the corpus writes itself).
8. **Attribution-minimal** (only when a client asks for ROI): self-reported
   discovery field + configurable AI-referrer domain list + GA4-rows →
   `AttributionSignals` mapper + persist classifications. The classifier
   and confidence guards are already built and tested.

## Sequencing rationale

1. **A before everything**: each A-item is a way the platform lies —
   fabricated measurements (A1), infinite budgets (A2), crashed runs
   reported complete (A3), approvals that never expire (A4), mixed-version
   trends (A6). The product's one non-negotiable is that the numbers are
   true.
2. **C before D**: the operator loop (approve, resolve, read the brief) is
   exercised every pilot week; content quality (D) is exercised only when
   content ships. Both precede selling.
3. **The automation library stays post-pilot** deliberately: the weekly
   cycle (`lib/cycles`) — the one workflow that genuinely runs end-to-end —
   covers the pilot's operating rhythm. Fixing 18 dead graphs buys nothing
   a single pilot needs.
4. **Attribution stays deferred** — re-confirmed operator decision. The
   honest pilot pitch is measurement and authority work, not ROI claims
   the schema cannot support.
