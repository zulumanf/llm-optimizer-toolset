# Client operations — spec 151 milestones B and C

## Optimization plan (`/projects/[id]/optimization`, tab "Optimize")

- `lib/optimization/plan.ts` composes the existing finding engines into `opportunities` (migration 128):
  - gap findings, from the latest analyzed run;
  - citation opportunities, excluding exits;
  - site findings, from the latest scan;
  - accuracy findings.
- Each opportunity has:
  - a run-independent `dedupe_key`;
  - observed problem, recommended action, target intent and location, affected URL, evidence refs, competitors;
  - priority and band, effort, cost, confidence;
  - limitations (deterministic copy: no promised outcomes, "frequency is not influence");
  - approval requirements (`public_claim`, `third_party_outreach`, `client_website_change`, `content_publication`);
  - a measurement plan.
- Lifecycle: `proposed → approved → in_progress → implemented → measuring → closed`, plus `dismissed` (needs a reason) and reopen.
  - Every transition writes an insert-only `opportunity_events` row and an audit row.
  - Approval creates the task through the source engine's own task path (`createTaskFromFinding`, `createTaskFromSiteFinding`, `createCorrectionTask`), so the finding becomes a task exactly one way.
  - `measuring` requires a linked intervention.
- Regeneration is idempotent and never changes status.

## Supporting views

- **Source presence** (`lib/optimization/source-presence.ts`): domains cited in the latest run, with:
  - answers citing the domain;
  - answers that also named a competitor or the client (co-occurrence in the answer);
  - client-owned flag;
  - page presence, only from fetched `source_presence_checks`.
- **Structured data** (`lib/optimization/jsonld.ts`): `RealEstateAgent` / `Person` JSON-LD built only from approved claims. It falls back to the real-estate pack keys `brokerage` and `markets_served`. It never emits ratings or reviews, drops non-URL `sameAs` entries, and reports missing recommended facts.

## Onboarding (`lib/onboarding/service.ts`)

- **`onboardingChecklist`**: twelve steps derived from records. Nothing is stored, so the checklist cannot drift. Each step has an actor (system / operator / client) and a next action.
- **`prepareMeasurement`**: one confirmed action that
  1. pins the instrument;
  2. freezes the cohort;
  3. starts baseline wave 1;
  4. enqueues `start_baseline_wave` for wave 2 at +7 days, using the instrument version recorded at scheduling. It is idempotent by label.
- **`runInitialAnalysis`**: gap analysis on the latest scored baseline wave, then the plan.

## Exception queue (`/operations`, `lib/operations/exceptions.ts`)

Covered:
- failed runs and failed jobs;
- overdue retests (`start_scheduled_run` queued >24 h past due);
- overdue approvals (`workflow_approvals.due_at`);
- pending reviews older than 48 h, which block scoring;
- over-budget runs, and 24 h spend ≥90% of the ceiling;
- live engagements with no published report in 35 days;
- failing connector health checks;
- stalled approved opportunities (30 days);
- approved plans never linked to what shipped;
- an unreachable or incomplete internal inference host. Promoted tasks fail closed by design; this makes that visible.

## Jobs (`db/jobs.ts`, `workers/core.ts`)

- The lease is renewed every 60 s while a handler runs.
- `completeJob` / `failJob` take the worker id and only land while that worker holds the lease. A job reclaimed by the stale sweep cannot be completed by its original worker.
- Unfenced calls keep the old behaviour, for scripts and tests.
- Together these make more than one worker safe.

## Reports (`lib/reports/measurement-v2.ts`)

New report drafts carry a `measurement` section:
- per-model estimates with intervals;
- per-model paired change since the previous comparable run, or "not comparable" / "baseline";
- the MDE of the current panel;
- experiment verdicts, including nulls;
- client outcomes for the period, labelled by provenance;
- the top 5 next actions;
- limitations (API instrument, statistical vs classifier confidence, correlation only).

Rendered on the internal report page. Publishing and sign-off are unchanged. The portal does not render the section yet.

## Business outcomes

- `client_outcomes` (migration 130) is insert-only. Supersession via `supersedes` hides the old row; nothing is deleted.
- Provenance is `self_reported` or `client_system_export`.
- An outcome with no figures is refused: empty is not zero.
- Capture form: Optimize page → Client outcomes.

## Rehearsal

`tests/integration/client-lifecycle-rehearsal.test.ts` takes a synthetic client through:
1. setup;
2. pinned (mock) instrument;
3. two baseline waves (worker-driven);
4. analysis and plan;
5. pre-registered plan, approval, shipped intervention, link;
6. scheduled post wave and evaluation;
7. outcome and labor capture;
8. economics;
9. report draft with measurement v2.

Recorded human actions (13): create project, set subject, add competitor, review and freeze prompts, pin instrument (rehearsal only; production uses the default automatically), confirm prepare measurement, run initial analysis, pre-register, approve plan, record what shipped, link plan, record outcome, log labor.

Remaining manual bottlenecks:
- prompt review;
- recording what shipped and linking it: two steps that could become one;
- outcome capture;
- engagement signing (covered by `client-engagement-dry-run`, not this rehearsal).

This validates wiring on fabricated mock answers. It does not validate commercial delivery; no live engagement has run.
