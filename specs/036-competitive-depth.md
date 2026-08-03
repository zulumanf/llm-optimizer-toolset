# Spec 036 — Competitive Intelligence Depth

> Status: done (2026-08-02) — implemented and test-verified; see acceptance checklist
> Depends on: specs/004 (mentions) · specs/005 (competitors) · specs/030 (movement) · migration 033 (citation ledger) · specs/033 (MCP) · docs/ai-visibility-roadmap.md Phase 4
> Branch: feat/034-learning-loop line (committed on feat/032-contacts-and-import — see DECISIONS)

## Goal

Answer acceptance scenarios B, C, and D of the visibility program with data the platform already captures immutably: **head-to-head win rates** ("which competitors outrank us, how often, on which prompts") and **citation-profile comparison** ("which domains are cited when Competitor Y is recommended, and which of those never cite us"). Both are versioned, derived-on-read analyses over `mentions` and `response_citations` — no new tables, no scoring-version bump, no stored numbers that could drift from their sources.

## Non-goals

- **Not stored metrics.** Win rate is an analysis, not a `scores` row — storing it would demand a scoring-version bump (docs/06 ceremony) for a number that is cheap to re-derive and still settling its definition. Same stance as movement (spec 030: "derived, never stored").
- No "influence" claims: a domain cited alongside a recommendation is an observed co-occurrence, and every label says so.
- No movement changes — overtake detection already covers both movement metrics (the spec-030 "not built" note predates the batch that widened `MOVEMENT_METRICS`; reconciled in this spec's docs).
- No external fetching. Spec-027 discovery wiring is a separate slice.

## User stories

- As an operator, I can see per competitor: contested responses, wins, losses, ties, and a win rate — for the latest scored run, from the competitors page or over MCP.
- As an operator, I can see which prompts I lose to a given competitor, so "which clusters do we lose" is one glance with the clusters section.
- As an operator, I can compare citation profiles: the domains cited in responses that recommend each company, with source type/relationship labels, and the **source gaps** — domains that back a competitor's recommendations but never appear when I'm recommended.
- As an agent over MCP, I can fetch both analyses with their version strings and sample sizes.

## Definitions (head-to-head-v1)

Per (self, competitor) over one run's **current** mentions (latest revision per response+company), one verdict per response:

- Neither mentioned → **uncontested** (excluded from the denominator).
- Self mentioned, competitor not → **self win**. Reverse → **competitor win**.
- Both mentioned, both hold list positions → lower position wins; equal → **tie**.
- Both mentioned, either position null → **tie** (an unranked co-mention is not a loss; the label is `both mentioned, unranked`).

`win_rate = self_wins / contested`, null when contested = 0. Errored cells and holdout prompts are excluded (same eligibility as scoring). Per-prompt detail carries the losing prompt texts for scenario B.

## Definitions (citation-profile-v1)

Per company over one run: the domains of `response_citations` rows attached to responses whose current mention of that company has `recommended = true`, with counts, joined to the project's `sources` registry for type/relationship labels (unclassified domains stay unlabeled, not guessed). **Source gap** for a competitor = domains in the competitor's profile with zero occurrences in the subject's profile. Framing in every output: co-occurrence, not causation.

## Architecture

```
lib/competitors/head-to-head.ts      # pure computeHeadToHead + headToHeadForRun/ForProject
lib/competitors/citation-profiles.ts # pure buildProfiles + citationProfilesForRun/ForProject
db/citation-profiles.ts              # reader: recommended-mention citation domains per company for a run
```

Readers reuse `currentMentionsForRun`, `listComparisonCompanies`, `latestScoredRunId`, run cell eligibility from `runs`/`responses`. UI: two sections on the competitors page. MCP (19 → 21): `get_head_to_head`, `compare_citation_profiles` (both observer; `{ project_id, run_id? }`, run defaults to the latest scored run).

## Edge cases

- No scored run → both tools return `run_id: null` with empty analyses, not errors.
- Competitor archived after the run: still reported for that run (the run is history), flagged `archived: true`.
- A company recommended in a response that carries zero citations contributes nothing to its profile — profiles measure citations, not recommendations.
- Ties never count toward either side's wins; they are reported separately.
- Multiple repetitions of one prompt are separate responses by design (same as scoring's unit).

## Acceptance criteria

- [x] Hand-computed fixtures: win/loss/tie/uncontested classification matches the definition table exactly, including the unranked-co-mention tie.
- [x] Win rate is null (not 0) when nothing is contested.
- [x] Losing-prompt lists name the exact prompts for a chosen competitor.
- [x] Citation profiles list domains + counts + labels per recommended company; source gaps are exactly the set difference; a no-citation run yields empty profiles.
- [x] Both analyses expose their version strings; MCP registry at 21; competitors page renders both sections with honest empty states.
- [x] Suite, lint, typecheck green. No migration (nothing to reverse).

## Test cases

- Unit `head-to-head.test.ts`: the verdict table (each row), null win rate, holdout/error exclusion, per-prompt losses.
- Unit `citation-profiles.test.ts`: profile assembly, gap set difference, empty-citation runs, label passthrough without guessing.
- Integration `competitive-depth.test.ts`: seeded mock run through parse+score → both services against real rows; archived-competitor flag.
- Integration `mcp.test.ts`: registry 21; both tools against seeded state incl. the no-scored-run empty state.

## Definition of done

All acceptance criteria pass · suite/lint/typecheck green · `docs/ai-visibility-mcp-tools.md` + roadmap updated (incl. reconciling spec-030's stale overtake note) · DECISIONS records the derived-not-stored choice and the tie semantics.
