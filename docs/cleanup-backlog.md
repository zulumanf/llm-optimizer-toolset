# Cleanup backlog

Rewritten 2026-08-18 after the whole-codebase audit (three sweeps: lib/db/
workers duplication+dead code, schema/docs/config drift, app/components/
tests hygiene). The 2026-08-04 numbering is retired; items fixed by the
2026-08-18 cleanup batches (PRs `chore/cleanup-*`) are listed at the bottom
so their absence isn't mistaken for "never found". Ranked by
(pain relieved ÷ risk).

## In flight (2026-08-18 cleanup batches)

- **Batch 1 — merged path**: migration rollback by applied order; down
  cleanups for 008/046/079; one SSRF guard (discovery robots → safeFetch);
  18 dead exports deleted; truthful comments. (PR `chore/cleanup-1-…`)
- **Batch 2 — test fixture**: migrate-once-per-run via global setup;
  in-process `migrate()`; actor factories. Started by an agent, unfinished
  (spend limit); worktree `chore/cleanup-2-test-fixture` holds partial work.
- **Batch 3 — consolidations**: one `lib/html/`, one sitemap parser, shared
  crawl constants, `formatPercent`, confidence module, shared CSV parser,
  current-revision fragment. Partial worktree (`chore/cleanup-3-…`).
- **Batch 4 — UI idioms**: `useAction` hook, StatusBadge registry, PageTabs
  reuse, `makeActionRunner` result-derived targets. Partial worktree.
- **Batch 5 — docs/config truth**: this file, docs 02/03/08 corrections,
  target-gap banner, CLAUDE.md fixes, spec template, ESLint flat config,
  node pins, env schema, DECISIONS index. (PR `chore/cleanup-5-…`)

## Worth doing next

1. **Renumber `071_audit_requests.sql` → 084+ on `feat/061-marketing-site`
   before that branch merges.** With batch 1's applied-order rollback the
   ordering bug no longer bites, but a lower-than-HEAD number merging late
   is still confusing. Also resolve the CLAUDE.md "no marketing pages"
   tension before merging 061.
2. **`lib/prospects/service.ts` (2,559 lines) split** into its ~9
   subsystems behind a barrel. The audits.ts extraction proved the seam
   pattern; audits.ts itself (1,325) is next.
3. **`lib/audit/view-model.ts`** — extract the ~110 lines of prospect-facing
   derivation from `app/audit/[handle]/page.tsx` (984 lines) into a pure,
   unit-testable view model; split the four monolithic sections into
   components. Highest correctness value of the page splits.
4. **`app/prospects/[id]/page.tsx` (1,053 lines)**: extract the `nextStep`
   policy cascade to `lib/prospects/next-step.ts` (untested today), batch
   the ~6 serial awaits after the initial Promise.all, split the 13
   sections into server components.
5. **Typed `json()` helper in `db/client.ts`** to delete the ~109
   `as never` casts (largest unsanctioned type escape).
6. **Inline-SQL pages** (39 queries across 18 pages; 6 carry business
   logic). Opportunistic, one page at a time.
7. **Badge-variant maps** — batch 4 seeds `lib/ui/variants.ts` for 5 sites;
   ~15 more remain. Add a layout-consistency-style test that fails on new
   inline `Record<string, "default" | …>` literals in `app/`.
8. **`truncateAll` test helper** and converting the 75 hand-maintained
   per-suite truncate lists (deliberately NOT done in batch 2's mechanical
   pass — each list is scoped; converting needs per-file review).
9. **URL normalizer split**: `lib/knowledge/normalize.ts` vs
   `lib/connectors/mapping.ts` produce different keys for the same URL
   (tracking-param handling). The connectors copy feeds suppression keys —
   verify no missed suppressions, then unify deliberately.
10. **Confidence-curve unification** (banded vs logarithmic) — a
    scoring-version decision, since the numbers reach prospect surfaces.
    Batch 3 co-locates the curves; unification is deliberately deferred.
11. **Worker tick vs queue**: the tick runs trigger dispatch / event
    delivery / connector sweeps inline; a slow sweep blocks the loop.
    Either enqueue from the tick or accept and document the coupling.
12. **`/prospects/sources` reachability** — 229-line page reachable only
    from a conditional per-row link; decide whether it deserves a nav slot.

## Needs a product decision, not a refactor

13. **`eraseProspectAccountPii` has no caller** — a GDPR/CCPA erasure
    request currently requires a hand-written script invocation. Wire an
    admin path or document the script as the procedure. (Annotated in code,
    batch 1.)
14. **`rotateCredential` dead** — key rotation exists as code nothing
    calls. (Annotated.)
15. **`storeArtifact` dead ⇒ `evidence_artifacts` can never be non-empty**,
    yet two readers query it. Ship evidence capture or remove the readers.
    (Annotated.)
16. **`BUILD_MAX_ATTEMPTS` not enforced** — knowledge build retries are
    bounded only by the job queue. Wire into `compileAffected` or delete.
    (Annotated.)
17. **Entity-merge feature**: batch 1 deleted its 5 dead exports; the
    `entity_aliases`/`merged_into` schema remains. Re-spec or drop.
18. **`interventions.intervention_type` written, never read** — the 081
    taxonomy exists for the learning loop; add the grouping reader or stop
    writing it.
19. **15 agents declared with no runner** (`lib/agents/registry.ts`
    `declaredOnly`) — confirm no UI lists them unfiltered.
20. **Write-only tables**: `retrieval_evaluations` (now writer-less too),
    `context_packet_templates`, `operator_capacity_snapshots`,
    `knowledge_build_manifests`, `market_pack_installs`, `extraction_runs`,
    `discovery_candidates`, `audit_samples`; untouched: `acquisition_providers`,
    `agent_evaluations`, `wiki_annotations`. Surface or stop writing.
    `extraction_runs` and `knowledge_build_manifests` hurt most (no
    observability into extraction/builds).
21. **`runChangeDrivers` (spec 087 P1) has no UI consumer yet** — wire into
    the reports surface or fold into the weekly brief.

## Doc truth fixes owed (survivors from 2026-08-04)

22. `docs/11:13` says `app/ → lib/ → db/` but ~66 app files import `db/`
    directly. Sanction app→db for reads or fix the doc.
23. `docs/11:52` mandates `date-fns`; the dependency is not installed.
    Amend the rule or add the dep.
24. `docs/13:3` and `docs/12:28` cite `lib/ai/prompts/`, which does not
    exist; ~20 authored prompts live in `lib/automation/prompts.ts`
    unregistered.
25. **12 server actions skip Zod** (`app/automation/actions.ts` ×8,
    control-tower, jobs ×2, onboarding — onboarding's `previewPrompts`
    also lacks a try/catch, so auth failures escape as unhandled
    rejections). 6 pages pass unvalidated `searchParams` into queries.
26. `middleware.ts:25` comment still calls the audit route "the
    high-entropy token (spec 032)" — route is `[handle]/[key]` since 076.
27. `lib/scoring/weights.ts` header promises AUTHORITY_WEIGHTS migrates
    into weight sets "on the next scoring-version bump" — still hardcoded
    in `lib/scoring/metrics.ts`.

## Test gaps (carried from 2026-08-04, still open)

28. Role-denial through the browser (client_viewer session scope; login
    flow) — needs a Supabase test rig.
29. Review-queue correction → revision, and report publish → locked, at
    the browser layer.
30. `deliverDigest` webhook delivery needs a fetch mock.
31. Onboarding wizard / approvals decide / CSV import submit flows in the
    browser.
32. `tests/integration/workflow-engine.test.ts:487` — the one real-time
    3 s sleep; confirm it can't be fake-timered.

## Deliberately NOT doing (recorded so it isn't re-litigated)

- Merging trivial one-line helpers (`clamp01`, `sleep`) across unrelated
  domains — the import coupling costs more than 2 duplicated lines.
- Renaming the two same-named-but-different `ratio` helpers
  (`classifier-eval` rounds, `acvs` clamps) into one — they are different
  functions; if touched, rename rather than merge.
- Deleting `app/api/cron/*` — they are the only non-worker recovery path
  for a stuck tick, documented as manual pokes, and tested.
- Deleting the 4 queue handlers the tick duplicates — the dispatch tests
  are built on `sync_notifications`, and a manual re-run path is worth the
  8 lines; comments now state the reality (batch 1).

## Fixed 2026-08-18 (for the record)

Applied-order rollback; 008/046/079 down cleanups; discovery robots via
safeFetch with a size cap; 18 dead exports (~354 lines); COMMON_* /
scope() / escapeRegex dedup; version-constant literals in discoverability;
stale tier/banding/coverage comments; docs 02 (Vercel→Railway, knowledge
graph, auth audiences), 03 (demoted to conventions + spine), 08 (rewritten
thin), target-gap banner; CLAUDE.md audit route + migration-numbering
note; spec template rewritten to the real shape; ESLint flat config +
`eslint .` (lint now also covers scripts/ and tests/ — 7 latent warnings
fixed); CI node 22 to match production + `engines` field + @types/node 22;
`ALLOW_DEV_AUTH_IN_PROD`/`QA_SOURCE_LINK_CHECKS` in the env schema;
`.env.example` stale comments; DECISIONS.md index. Verified-not-bugs: all
26 current-revision predicates carry the company correlate; 057/061/062/081
down paths already cleaned correctly.
