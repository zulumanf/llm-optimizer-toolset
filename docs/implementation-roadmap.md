# Implementation Roadmap — AI Visibility Operating System

> Date: 2026-07-31 · Derived from `current-system-audit.md` and
> `target-gap-analysis.md`. Complexity: S (< half day), M (1–2 days),
> L (3–5 days), XL (> a week). Every task follows the repo's standing
> rule: spec first for new capabilities, tests green, DECISIONS updated.
> Tasks marked **[operator]** require actions only the human can take
> (dashboards, secrets, hosting) — the system can prepare but not finish
> them.

---

## Phase 0 — Foundation and critical fixes

Goal: make the authorization story true, stop cross-client blur, fix the
one known metric-integrity hole. Nothing client-facing ships before this.

| # | Task | Business value | Technical scope | Dependencies | Risk | Acceptance criteria | Size |
|---|---|---|---|---|---|---|---|
| 0.0 | **[operator] Rotate the Supabase database password; move the app off the superuser role** | Removes the single highest-severity exposure | Supabase dashboard + new `DATABASE_URL`; optionally a least-privilege app role | None | Low (config) | Old credential invalid; app healthy on new one | S |
| 0.1 | **Enforce project-level authorization** | Any authenticated user can currently open any client by URL — disqualifying for agency operation | Wire `visibleProjectIds()` + a new `assertProjectAccess(user, projectId)` into project-scoped actions and pages; scope `listActiveProjects` for client roles; staff see all | None | Medium — touches many call sites; mitigate with a shared helper + tests | Tenant-isolation tests prove a `client_viewer` with access to project A gets 403/not-found on project B's pages, actions, and data | M |
| 0.2 | **Enforce client read-only writes globally** | `client_viewer` could write via ~19 services today | `assertCanWrite` at the service boundary of every mutating service (pattern already exists in `lib/plans/service.ts`) | 0.1 helper | Low | Authorization test: client role attempting each mutating action gets a typed denial | M |
| 0.3 | **Scope the three export API routes + close unauthenticated server actions** | Export routes leak any client's artifacts by id; jobs/notifications actions run without auth | Project-access check on report CSV, evidence export, plan export; `getCurrentUser()` in `app/jobs/actions.ts`, `app/notifications/actions.ts`, onboarding preview; constant-time compare on all 4 cron routes | 0.1 | Low | Tests: cross-project export returns 404; unauthenticated action rejected; `timingSafeEqual` everywhere | S |
| 0.4 | **Project-scope `sources` and `brand_candidates`; give `evidence` a project column** | Citation counts and brand hit-counts currently blur across clients; evidence refs are unverifiable | Migrations (add `project_id`, backfill from run linkage, re-key uniques per project); update upserts + queries | None | Medium — backfill correctness; mitigated by reversible migrations + fixtures | Migration up+down tested; per-project citation counts diverge in a two-project fixture; no orphan evidence | M |
| 0.5 | **Fix `citation_rate` vs `citation_score` mismatch** | The citation drill-down's stored-value check is vacuous — silent evidence-integrity hole | Align the drill-down metric name with the stored metric | None | Low | Drill-down finds the stored score; `matchesStored` meaningful; regression test | S |
| 0.6 | **Set `CRON_SECRET`; document scheduler entry [operator for hosting]** | All scheduled automation is currently off; trend lines never accumulate | Generate secret, set in `.env`, verify 401→200, launchd/hosted entry | None | Low | Weekly cycle + notification sync fire on schedule | S |

## Phase 1 — Minimum viable agency operating system

Goal: complete the metric set, make prompts carry their strategy, make
tasks manageable, and build the two missing first-class objects the
agency sells with: exclusivity and campaigns.

| # | Task | Business value | Technical scope | Dependencies | Risk | Acceptance criteria | Size |
|---|---|---|---|---|---|---|---|
| 1.1 | **Scoring v1.1: stored `first_position_rate`, `top_three_rate`, `stability`** | Target-spec core metrics; currently derived-only and invisible to reports | New metric functions + constants; bump `SCORING_VERSION`; old rows untouched (versioning model) | None | Low — pure functions + fixtures | Known-answer fixtures; both versions coexist; docs/06 changelog entry | S |
| 1.2 | **Persist prompt intent tier** | Funnel-stage segmentation is claimed but impossible today (tier generated then discarded) | `prompts.tier` column; thread through freeze snapshot, validation, onboarding; backfill nullable | None | Low | Frozen snapshots carry tier; drill-down can segment by tier | S |
| 1.3 | **Per-response citation ledger (`response_citations`)** | Foundation of citation intelligence per client; today only a global counter | Insert-only table written at parse time from existing extraction; retroactive backfill job from raw payloads | 0.4 | Low | Ledger rows match `extractCitations` on historical payloads; drill-down lists per-response citations | M |
| 1.4 | **Task management fields: owner, due date, client-visible flag; comments** | Tasks are an evidence ledger, not a work tracker — agencies need owners and dates | Migration (owner_id FK users, due_date, client_visible bool, + `task_comments`); UI on kanban; overdue feeds attention feed | None | Low | Assign/date/comment round-trips; overdue tasks appear on Today; client_visible defaults false | M |
| 1.5 | **Market exclusivity & conflict engine** (new spec) | The agency's exclusivity promise is currently tracked nowhere; conflicts found by memory | New spec + migrations: `markets` (structural: geo containment via parent_id, category, price segment), `exclusivity_agreements`, `exclusivity_scopes` (market + service category + segment + dates + grace period); pure `detectConflicts()` (direct/partial/possible with explanation); override with rationale + audit; prospect-check UI + control-tower tile | 0.1 (authz) | Medium — geo modelling; start with explicit containment edges, no geocoding | Unit tests: Manhattan-luxury vs Manhattan-luxury = direct; Brooklyn vs Manhattan = none; NYC vs Manhattan = partial (containment); expired + within-grace flagged distinctly; override requires rationale and is audited | L |
| 1.6 | **Campaigns as a grouping layer** (new spec) | Turns disconnected tasks/interventions into accountable client programs | `campaigns` table (objective, hypothesis, baseline snapshot, target metrics, status, timeline, owner) + join tables to prompts/findings/tasks/interventions; campaign view in workspace; rollup on control tower | 1.4 | Low–Medium | Campaign aggregates its members' metrics vs baseline; no orphan states; verdict language reused (no causal claims) | M |
| 1.7 | **Live-verify Anthropic + Perplexity adapters and pricing** [needs keys — present in `.env`] | Two of four engines have never produced a real measurement; ≥2-provider verdict rule starves | Small live smoke run per provider; correct model ids/prices; flip `verified` flags | None | Low | One real run each; prices verified or consciously flagged | S |

## Phase 2 — Automation and intelligence

| # | Task | Business value | Technical scope | Dependencies | Risk | Acceptance criteria | Size |
|---|---|---|---|---|---|---|---|
| 2.1 | Competitor snapshots over time + movement detection | "Competitor overtook you" is the alert clients pay for | Time-series view over existing `scores`; movement rules feed notification kinds | 0.6 | Low | Overtake event detected in fixture; deduped alert | M |
| 2.2 | Source classification (type, authority, owned/earned/competitor) + attainability | Citation intelligence answers "which citations should we pursue" | Columns on project-scoped `sources`; classification pass; gap-detector input | 1.3 | Medium (LLM-assisted classification needs validation) | Classified sources power a citation-gap view with evidence | M |
| 2.3 | Bridge knowledge entity graph ↔ measurement registry | Agent/team/brokerage rollups; real-estate entity model | FK `companies.knowledge_entity_id`; relationship-aware aggregation | None | Medium | Agent mention counts roll up to brokerage view | M |
| 2.4 | Verdict-outcome feedback into opportunity weights (loop step 14) | The system learns which actions actually move visibility | Weight adjustment proposal from accumulated verdicts; human-approved, versioned detector | ≥ 10 verdicts of data | Medium | Proposed weights shown with evidence; applied only on approval as `detector-v2` | M |
| 2.5 | Enable per-client automation triggers deliberately | 18 built workflows currently never fire | Operator UI to clone/enable platform triggers per client; keep ship-disabled default | 0.6 | Low | A client's weekly-operations workflow fires from cron and halts at judgement | S |
| 2.6 | Gap/task/benchmark domain-event producers | Event catalogue has no producers for the core loop; automation can't react to findings | `publishEvent` calls in gap/task/run services (transactional pattern exists) | None | Low | New finding emits event; subscription triggers workflow in test mode | S |
| 2.7 | Account owner + service tier on projects; control-tower filters | Target-spec §1 filters; portfolio operation at >5 clients | Columns + filter UI | None | Low | Filterable control tower | S |

## Phase 3 — Client-facing command center

| # | Task | Business value | Technical scope | Dependencies | Risk | Acceptance criteria | Size |
|---|---|---|---|---|---|---|---|
| 3.1 | Client portal (read-only): executive overview → metrics → evidence drill-down | The premium deliverable; ends manual export delivery | New route group under existing auth; `client_viewer` + `user_project_access`; progressive disclosure; observed/estimated labels from existing data | 0.1–0.3 hard-required | Medium | Isolation tests: client sees only granted project, never internal notes/costs; every metric traceable to evidence | L |
| 3.2 | Proof-of-work timeline (client-visible tasks + interventions + published content) | "What did we do and what changed" | Filtered activity view over existing data; `client_visible` flags | 1.4, 3.1 | Low | Internal-only items provably absent from client view | S |
| 3.3 | Branded PDF/print report + share delivery | Reports currently die in the internal app | Print-HTML path exists (plans) — extend to reports; per-project branding fields; share link under portal auth | 3.1 | Low | Branded report exports; date-range respected; evidence citations resolve | M |
| 3.4 | Monthly/quarterly executive-brief generators | Enum accepts them; nothing generates them | Extend `lib/reports/executive.ts` patterns | None | Low | Generated briefs pass the evidence gate | M |

## Phase 4 — Scale, optimization, advanced attribution

- **Hosted deployment + durable scheduling** [operator] — the laptop is
  the availability ceiling (XL, unblocks everything scheduled).
- **Cloud artifact storage + signed URLs** (M).
- **GA4 CSV import → OAuth; AI-referral classification (confirmed vs
  probable); self-reported lead log** — revenue attribution, deliberately
  last per the recorded operator decision (L–XL).
- **Website/technical audit family** (schema.org, metadata, canonicals)
  as detectors over crawl artifacts (L).
- **Outreach CRM completion** (spec 011: journalist registry, pitch
  drafting behind the existing 7-check send gate) (L).
- **Job-queue fairness + multi-worker supervision; migrate weekly cycle
  onto the graph engine** — retire the parallel execution system (M).
- **Vector/semantic retrieval for the knowledge layer; OCR** (M).
- **Cross-client benchmarks** (needs ≥5 clients of data) (M).

## Sequencing rationale

1. **Phase 0 is entirely about making existing claims true** — the
   security docs claim scoping that doesn't run; the metric system claims
   a check that's vacuous; the automation claims schedules that never
   fire. Truth first, features second.
2. **Exclusivity (1.5) and campaigns (1.6) are the only new builds in
   Phase 1** because they are sales-time capabilities with zero existing
   code — highest novelty risk taken while surface area is smallest.
3. **The portal (3.1) deliberately waits** for Phase 0 + task visibility
   flags: exposing data to clients before isolation enforcement would be
   irresponsible.
4. **Revenue attribution stays last** — an explicit, recorded operator
   decision; the intervention/verdict skeleton it will reuse already
   exists and keeps improving.
