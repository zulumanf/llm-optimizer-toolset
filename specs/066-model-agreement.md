# Spec 066 — Model Agreement / Disagreement Read Model

## Why

The whole-OS audit (2026-08-12) found per-provider values are computed and
consumed only as delta-noise inputs — never as a consensus read. "Recommended
by 4/4 platforms" vs "only ChatGPT surfaces them" is the most legible
competitive artifact the data already supports: it tells the operator whether
a visibility problem is systemic (every assistant agrees) or platform-shaped
(one assistant's retrieval differs), which changes what intervention makes
sense. Today that question requires manually cross-reading per-provider
score rows.

## What

`lib/competitors/agreement.ts` (`model-agreement-v1`), the spec-036 pattern
exactly: a pure fixture-testable core over eligible responses + current
mentions, a thin loader, derived on read, never stored.

Per tracked company (subject + competitors) for one run:

- **Readings**: per provider — eligible responses, mentioned count,
  recommended count, and whether the sample is sufficient
  (`N ≥ 10`, the docs/06 reporting rule; an insufficient provider reading is
  excluded from the verdict, never rendered as a number that looks equal).
- **Label** (documented precedence, first match wins):
  1. `insufficient` — fewer than two providers with sufficient sample; a
     cross-model comparison needs at least two models.
  2. `absent` — mentioned on no eligible provider.
  3. `consensus_recommended` — recommended on every eligible provider.
  4. `single_provider` — mentioned on exactly one of ≥2.
  5. `divergent` — mention-rate spread across eligible providers ≥ 0.35.
  6. `consensus_mentioned` — mentioned on every eligible provider.
  7. `majority` — everything else, stated as counts.
- **Summary**: one observational sentence per label ("Recommended by 3/4
  providers", "Mentioned only on perplexity", "Mention rate ranges from 8%
  (gemini) to 62% (openai)"). Counts with denominators, never bare
  percentages alone; no causal language — agreement describes the pattern,
  it never explains it.

Eligibility mirrors scoring and head-to-head: errored cells and holdout
prompts excluded, latest mention revision wins.

## Surface

Competitors page gains a **Model agreement** section: one row per company
(subject first), per-provider cells as `mentioned/N · recommended/N`, label
chip, summary sentence. On single-provider runs the section states plainly
that a cross-model read needs at least two providers instead of rendering a
one-column table that implies consensus. Footnote: agreement is a pattern
across assistants, not evidence of why any assistant behaves as it does.

## Testing

- Unit: pure core fixtures — every label with its precedence (a company
  that is both consensus-recommended and divergent labels consensus; a
  single-provider mention labels single_provider, not divergent),
  sufficiency exclusion, spread arithmetic, counts.
- Integration (competitors suite): `modelAgreementForProject` over the real
  mock pipeline returns per-provider readings and the honest `insufficient`
  label for a single-provider run.

## Acceptance criteria

- [ ] Pure core + loader in lib/competitors/agreement.ts; nothing stored.
- [ ] Insufficient provider samples are excluded from verdicts, not
      averaged in.
- [ ] Competitors page renders the section, with the honest single-provider
      state.
- [ ] Lint, typecheck, full suite green.

## Out of scope

Feeding agreement into retest verdict context (composes with spec 062's
comparability once both PRs land — separate slice), storing agreement
history/trends, MCP tool exposure, per-prompt-family agreement splits.
