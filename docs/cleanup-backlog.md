# Cleanup backlog (four-lens audit, 2026-08-04)

Verified findings NOT fixed in the audit pass, each with why it waited.
Ranked by (pain relieved ÷ risk). Nothing here is a live correctness bug —
those were fixed; see DECISIONS.md 2026-08-04.

## Worth doing next

1. **`lib/prospects/service.ts` (3,027 lines) split.** Extract the audit
   snapshot assembler first (~450 lines, now already outside the
   transaction, so the seam is clean), then the 6 banner sections into
   cohesive modules. `logActivity` (26 call sites) and `lockProspect` (17)
   must move to a shared internal module. Keep `service.ts` as a barrel so
   the 17 importers and 59 test call sites don't churn.
2. **22 copies of the current-revision mentions predicate** across 16
   files — two are byte-identical named constants with identical doc
   comments. Export one fragment from `db/mentions.ts`; the SQL aliases
   must be normalized at each call site, which is the real work.
3. **Typed `json()` helper in `db/client.ts`** to delete 109 `as never`
   casts — the repo's largest unsanctioned type escape, currently
   undocumented despite CLAUDE.md requiring a decision record.
4. **9 `pct()` formatters with 3 different behaviours** — the same rate
   renders `12%` in a plan and `12.3%` in a report. One `formatPercent` in
   `lib/format.ts`; needs a deliberate call on digits for prospect-facing
   surfaces.
5. **39 inline SQL queries across 18 pages.** Six carry real business
   logic (accuracy, validation, interventions ×2, automation runs,
   automation outreach) and account for 78 of the 155 page-level casts.
   `app/projects/[id]/settings/page.tsx` queries the same `projects` row
   `getProject()` already read; `app/projects/[id]/interventions/page.tsx`
   re-implements the typed `listInterventions()` that already exists in
   `db/interventions.ts`. Do these opportunistically, one page at a time.
6. **`tests/helpers/db.ts` for the 53 copies of drop-schema + migrate +
   seedTestActors.** Extract the body, not the lifecycle hook — the
   `__dirname` depth is the one place this silently breaks. Do NOT merge
   the 37 per-suite truncate lists; they are deliberately scoped.

## Needs a product decision, not a refactor

7. **`storeArtifact` is dead ⇒ `evidence_artifacts` can never be
   non-empty**, yet two live readers query it. Either evidence capture
   ships or the readers go.
8. **Entity-merge feature** (`lib/knowledge/entities/service.ts`, 5 dead
   exports) and **outreach sequence draining** (`dueSequences` dead — no
   scheduler drains sequences) were specced and never wired.
9. **`rotateCredential` is dead** — connector credential rotation exists
   as code nothing calls. Security-relevant absence.
10. **Write-only tables**: `discovery_candidates`, `prospect_outreach_sends`
    (send history has no UI), `knowledge_build_manifests`,
    `context_packet_templates`, `operator_capacity_snapshots`,
    `market_pack_installs`, `source_normalizations`. Each: surface it or
    stop writing it.
11. **Dead tables safe to drop**: `wiki_annotations`, `agent_evaluations`,
    `retrieval_evaluations`, `webhook_endpoints`, `workflow_fixtures` —
    all appear only in test truncate lists.
12. **3 dead exports in template-literal-heavy files** (`db/triggers.ts`,
    `db/workflow.ts`, `lib/knowledge/maintenance/exceptions.ts`) — the
    scripted removal mangled the SQL templates, so these need hand edits.

## Doc truth fixes owed

13. `docs/11:13` says `app/ → lib/ → db/` but 66 app files import `db/`
    directly. Either sanction app→db for reads or accept two-thirds of
    `app/` violates the standard — the doc is currently silently false.
14. `docs/11:52` mandates `date-fns`; **the dependency is not installed**
    and 23 sites hand-roll ms arithmetic, incl. an ISO week-number
    calculation in `lib/knowledge/maintenance/service.ts`. Amend the rule
    or add the dep.
15. `docs/13:3` and `docs/12:28` cite `lib/ai/prompts/`, **which does not
    exist**; 20 authored prompts (19 in `lib/automation/prompts.ts`, 1 in
    the claim extractor) are unregistered in the prompt registry.
16. `lib/env.ts` validates 10 env vars; 5 more are read ad hoc
    (`AUTOMATION_CREDENTIAL_KEY`, `GOOGLE_API_KEY`, `PERPLEXITY_API_KEY`,
    `DIGEST_WEBHOOK_URL`, `DAILY_SPEND_CEILING_USD`). Two are marked
    "unused" in `.env.example` while being used today.
17. **12 server actions skip Zod** (`app/automation/actions.ts` ×8,
    control-tower, jobs ×2, onboarding) and 6 pages pass unvalidated
    `searchParams` into queries. Not exploitable (postgres.js
    parameterizes) but a stated trust-boundary rule.

## CI

18. **The e2e job is `continue-on-error` as of 2026-08-04.** Green locally
    (47/47) but the hosted runner boots the compiled server then produces
    no test output until timeout. Diagnose, then remove the flag — a
    non-blocking test job is a decorative one.

## Test gaps (assessed 2026-08-04, after the regression additions)

19. **Role-denial through the browser.** All E2E runs under AUTH_MODE=dev
    (staff). SQL-level portal isolation is well tested, but no browser test
    proves a client_viewer session sees only the portal, or that the login
    flow works. Needs a Supabase test rig (local supabase or a dedicated
    test project) — the one infrastructure piece standing between here and
    honest auth E2E.
20. **The two docs/09 flows still not browser-tested**: review-queue
    correction → revision recorded, and report publish → locked. Both are
    integration-tested at the service layer; the browser layer needs a
    seed with low-confidence mentions (review queue) and a draft report.
21. **deliverDigest** (webhook delivery) — needs a fetch mock; currently
    only the not-configured path is implicitly exercised.
22. **Onboarding wizard, approvals inbox decide, CSV import dialog** —
    render-tested only; their submit flows are untested in the browser.
