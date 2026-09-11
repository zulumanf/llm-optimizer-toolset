# Spec 094 — Finding Template Precision (sense-check-driven)

**Status:** In progress
**Branch:** `fix/sense-check-schema-drift` (stacked on the sense-check v2 fix
that surfaced these findings)
**Source:** First full sense-check sweep (2026-08-20, agent v2) returned
readsFair=false on all 14 live audits, with 40 blocking concerns reducing to
three systemic template flaws in the finding generator — the same class of
overreach the human review rounds caught in page copy (specs 090/093), now
caught in the frozen finding text by the platform's own QA.

## The three flaws → fixes (lib/prospects/findings.ts, generator v2)

1. **Overreach (13/14 audits):** "AI visibility appears weaker than X's
   documented market position … underrepresented relative to its documented
   position" asserts the rank should predict AI visibility — a benchmark the
   data does not establish. → The finding states the two measurements side
   by side without asserting the relationship: the sourced record, then the
   counted visibility, and the observation that both are true at once.
2. **"The team" applied to individuals (8/14):** template says "the team"
   regardless of prospect type. → Use the prospect's name; no entity-kind
   nouns.
3. **Rounding up in our favor:** `pct()` rounds 1/64 (1.5625%) to "2%". →
   Counts are the primary unit everywhere ("1 of 64"); where a rate is
   still written, sub-10% rates keep one decimal.

Plus the fairness concern (5/14): the comparison set mixes individuals,
teams, and brands without saying how it was chosen. → One sentence, in both
places that need it: the audit page's table footnote, and the sense-check
content serialization (the checker must see the same explanation the reader
gets): the set is every entity the captured answers named — not a curated
peer group.

## Versioning

- `FINDING_GENERATOR_VERSION` → `prospect-findings-v2+deterministic`.
  Existing approved findings keep their v1 text (findings are immutable
  evidence of what was approved); v2 applies on regeneration.
- Rollout: regenerate candidates for the 14, operator approves the corrected
  primaries, republish (tokens preserved), sense-check re-run to verify
  green — all before the first outreach sends.

## Out of scope

- Authority-signal near-duplicate rows (data hygiene per prospect, not
  template) — surfaced to the operator, cleaned separately.
- Sequences/automation stack findings.

## Acceptance criteria

- [ ] Generator emits no "underrepresented relative to", no "the team", no
      rounded-up sub-10% percentages (unit tests).
- [ ] Prohibited-phrase guard still passes on all generated text.
- [ ] Audit page footnote + sense-check serialization state the
      comparison-set construction (copy test + unit test).
- [ ] Regenerated findings for the 14 re-approved and republished;
      sense-check sweep shows no template-class concerns remaining.
- [ ] Lint, typecheck, full suite pass.
