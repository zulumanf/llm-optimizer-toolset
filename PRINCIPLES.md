# PRINCIPLES.md

These never change. If a feature request, refactor, or deadline conflicts with a principle, **the principle wins**. Amending this file requires an explicit, dated entry in `DECISIONS.md` explaining why.

1. **Everything measurable.** A feature that produces numbers must define exactly how they are computed before it ships.

2. **Everything reproducible.** Given the same frozen prompt set, provider, model, and scoring version, anyone can re-derive every score from the raw data.

3. **Raw data is sacred.** Raw AI responses are captured before anything else touches them, stored immutably, and never edited, re-parsed in place, or deleted.

4. **No hidden calculations.** Every score traces to a documented, versioned equation in `docs/06-scoring-methodology.md`. If the math isn't written down, the number doesn't exist.

5. **No fabricated evidence.** A failed run is a failed run. A missing data point is missing. We never interpolate, backfill, or let a model "fill in" results.

6. **Humans review conclusions.** Software parses and suggests; a human approves classifications below the confidence threshold and signs off on every report before it drives action.

7. **Optimize for truth, not vanity metrics.** A report that says "nothing changed" or "we got worse" is a successful report.

8. **Software suggests. Humans approve.** No automated action (task creation from findings, outreach, content changes) executes without human confirmation.

9. **Small experiments beat large assumptions.** Prefer a narrow, frozen, well-measured prompt set over a sprawling one-off analysis.

10. **Version everything that affects a number.** Prompt sets, parsers, scoring weights, models. A score without its versions attached is meaningless.
