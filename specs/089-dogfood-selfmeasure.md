# Spec 089 — RecommendedFirst Dogfood: Measure Ourselves

> Status: done
> Depends on: specs/002 (prompt library), specs/003 (runs), specs/032 (project kinds), specs/038 (valuable visibility / echo exclusion), specs/063 (coverage), specs/086 (provenance)
> Branch: feat/089-dogfood-selfmeasure

## Goal

RecommendedFirst becomes its own most demanding customer: an internal
project measured by the exact client pipeline, so we can prove — with
archived model responses — where we started, who AI assistants recommend
instead of us, what evidence supports them, what we changed, and what
measurably happened afterward. Internal product QA, GEO experimentation
environment, citation-acquisition feedback loop, and (eventually)
defensible marketing evidence. Honest even when the results are bad.

## What is reused (audit result — do not rebuild)

- The full measurement chain: prompt sets → frozen versions → runs →
  immutable responses → mentions/scores → citations → gaps →
  interventions → reports. Zero duplicated infrastructure.
- Prompt-echo exclusion (`lib/scoring/prompt-echo.ts`): branded control
  prompts name the brand, so every visibility rate already excludes them.
- `valuableVisibility` (high-intent rates), `runCoverage` (prompt
  coverage), entity discovery (competitors are response-derived, never a
  hardcoded list), source taxonomy + provenance, technical scans (088),
  the interventions lifecycle (072), and all project detail surfaces.
- Weekly baseline enrollment (`baseline_prompt_set_id`) for repeat
  snapshots; runs start from the existing runs UI with budget caps.

## What this adds

1. **`projects.kind = 'internal'`** (migration 084). Client surfaces
   filter `kind='client'`, prospect surfaces read the prospects table —
   so internal data is excluded from client portfolios, counts, and
   benchmarks by construction. Down-migration re-kinds to 'prospect';
   nothing is deleted.
2. **Seed script** `scripts/onboard-recommendedfirst.ts` (idempotent):
   internal project, subject company (recommendedfirst.com), and the
   33-prompt universe from `lib/dogfood/prompts.ts` (15 tier-1 direct
   commercial, 11 tier-2 problem-aware, 4 tier-3 informational, 3 branded
   recognition controls), frozen as v1. No seeded competitors.
3. **`/dogfood`** (staff-gated): KPI row — unbranded visibility,
   high-intent visibility, prompt coverage, independent citation support,
   share of voice, change vs baseline ("insufficient history" until two
   scored runs) — plus a visibility-over-runs table and links into the
   standard project tabs. The baseline is the earliest scored run,
   derived at read time; there is nothing to mark and nothing to mutate.
4. **Query additions**: `getInternalProject` (db/projects),
   `subjectScoreHistory` + `citationSupport` (db/dashboard).

## Non-goals

No parallel run system, no new intent model, no scheduler, no causality
claims (deltas are "observed change", never attributed), no automatic
publication of case-study numbers, no fabricated data of any kind.

## Acceptance criteria

- Internal project invisible to `listPortfolio` / `listProjects` /
  `listActiveProjects`; full project detail still works
  (tests/integration/internal-dogfood.test.ts).
- Branded controls all name the brand (echo guarantee) and no unbranded
  prompt does; 25–40 prompts with tier-1/2 mass
  (tests/unit/dogfood-prompts.test.ts).
- Migration 084 reversible both directions.
- /dogfood renders empty, pre-baseline, and scored states without
  fabricating numbers.
