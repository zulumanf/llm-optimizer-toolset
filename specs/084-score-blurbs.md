# Spec 084 — Score Blurbs: The Number Explains Itself in the Table

> Status: implemented — acceptance criteria verified 2026-08-17
> Depends on: specs/039/045 (score + stored breakdown), specs/078 (magnitude scoring)
> Branch: feat/084-score-blurbs

## Why

The prospects table shows a bare number; the WHY lives a click away in the
stored breakdown. The operator asked for the explanation at a glance —
"explain it for each business" — and the platform's own doctrine says the
stored number always explains itself. Render that explanation in words.

## Design

Deterministic, never an LLM: `scoreBlurb(breakdown)` in
`lib/prospects/score-blurb.ts` — a pure, known-answer-tested function over
the stored `qualification_breakdown`: names the strongest and weakest
MEASURED components in operator language ("verified authority", "AI
visibility upside", "reachability", "outreach timing"), flags what is not
yet measured, and notes the priority-archetype boost when applied.
`listProspects` returns the breakdown; the table renders the blurb as a
muted second line under the score. Null breakdown → no blurb (legacy
scores). Phone-width unaffected (text wraps; the fence stays green).

## Acceptance criteria

- [x] Known-answer blurbs for: full breakdown, missing components,
      archetype boost, null/legacy breakdown (unit).
- [x] Table renders the blurb under the score; layout guard + mobile
      fence pass (existing suites).

## Definition of done

Criteria pass · suites green (honest exits) · lint/typecheck clean ·
docs/05 line added.
