# Spec 063 — Prompt Attribute Freeze & Coverage by Segment

## Why

The 2026-08-12 whole-OS audit's single most time-sensitive finding: prompt
lineage attributes (`audience`, `price_tier`, migration 046) are stored on
`prompts` but omitted from `FrozenPrompt`, so they die at the freeze
boundary. Every run measured before this lands is permanently unsegmentable
by market segment — no seller-side coverage, no price-tier coverage, no
"which neighborhoods do we lose" read, regardless of any future UI work.
Spec 040 deferred the freeze deliberately; the deferral has now become the
bottleneck for the platform's own positioning (coverage by segment is what
the product promises to measure).

Second finding folded in: **prompt coverage by category does not exist** as
a metric. `audience`/`price_tier` have zero consumers beyond generation, and
the only "coverage" the reports know is captured/failed cells.

## 1. Freeze the attributes (forward-only)

`FrozenPrompt` gains `audience?: string | null` and `priceTier?: string |
null`, captured by `freezePromptSet` exactly like `tier`: **metadata, not
identity**. `isSameContent` continues to compare only (text, category,
language) — retagging audience or price tier never forces a new version,
because it changes nothing about what a run sends to providers.

Historical frozen versions simply lack the fields (absent = unspecified).
No migration, no backfill, no scoring-version bump: `frozen_prompts` is a
jsonb snapshot and scores do not consume the new fields.

## 2. Coverage by segment (`coverage-v1`, derived on read)

New pure module `lib/scoring/coverage.ts`:

- Input: the run's frozen prompts + the subject's per-prompt presence
  (mentioned / recommended, latest mention revision, mirroring
  `computeScores`' revision rule).
- A prompt is **covered-mentioned** when at least one of its responses in
  the run carries a latest-revision mention of the subject; **covered-
  recommended** when at least one carries `recommended = true`.
- Holdout prompts are excluded from denominators (same rule as scoring).
- Dimensions: `category`; `intent` (high vs standard, using the existing
  single intent model — `commercialIntentWeight(prompt) >=
  HIGH_INTENT_THRESHOLD` from lib/scoring/valuable.ts, no second
  definition); `audience`; `price_tier`.
- A dimension where every prompt is unspecified is omitted entirely —
  a table of "unspecified: 100%" is noise, not honesty. Where some prompts
  are tagged, untagged ones bucket as "unspecified".
- Output rows carry counts (`x of y prompts`), never bare percentages —
  3/4 and 30/40 are different claims (prospect-voice discipline).

Nothing is stored. Coverage is derived on read like verdicts and
head-to-head (spec 036 precedent), so classification re-reviews and parser
re-runs are always reflected. `COVERAGE_VERSION = "coverage-v1"` stamps the
module for future methodology references.

`runCoverage(runId)` (same module, lazy db import) resolves the subject
company, the frozen prompts, and the presence map, and returns the rows.

## 3. Surface

Run detail page (`app/projects/[id]/runs/[runId]`) gains a **Coverage**
section between Scores and the cell table: one table (Dimension · Segment ·
Prompts · Brought up · Recommended), rendered only when scores exist for
the run and at least one dimension survives the omission rule. Counts are
tabular; the subject's zero segments read as `0/N`, never hidden.

docs/06 gains a short "Prompt coverage" subsection defining covered-
mentioned/covered-recommended and naming `recommendation_rate` as the
canonical metric behind the externally-named "AI Recommendation Share" KPI
(the audit found the public name mapped to no stored quantity).

## Testing

- Unit (`tests/unit/coverage.test.ts`): grouping fixtures, holdout
  exclusion, unspecified bucketing, all-unspecified omission, high-intent
  banding reusing `commercialIntentWeight` (tier beats category), counts.
- Unit (`tests/unit/prompt-freeze.test.ts`): audience/priceTier are
  metadata, not identity.
- Integration (`tests/integration/runs.test.ts`): tag prompts, freeze,
  verify the snapshot carries the fields; after a scored run,
  `runCoverage` returns segment rows with correct counts.

## Acceptance criteria

- [ ] Freezing captures audience/priceTier; retagging them alone does not
      create a new version.
- [ ] `runCoverage` returns correct counts on a real scored run; holdouts
      excluded; pre-063 versions degrade to category+intent dimensions only.
- [ ] Run page shows the Coverage table with counts, omitting untagged
      dimensions.
- [ ] docs/06 defines coverage and the Recommendation Share naming.
- [ ] Lint, typecheck, full suite green.

## Out of scope

Per-prompt importance weights and the approve/reject generation gate
(audit backlog P1), coverage in report snapshots/portal (needs design for
period pooling), prompt-family clustering as a dimension, storing coverage
as scores rows.
