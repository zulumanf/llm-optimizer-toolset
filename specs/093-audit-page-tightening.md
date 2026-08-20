# Spec 093 — Audit Page Tightening (evidence-first, caveats twice, not everywhere)

**Status:** In progress
**Branch:** `feat/093-audit-tightening`
**Source:** Operator-relayed reader feedback on the live Team Moza audit
(2026-08-20). Verdict: the proof is strong but the page over-explains — the
same caveat (sample limits, causality, non-guarantees) appears at every turn,
and a prospect stops reading when they feel qualified at each step. Target:
25–35% shorter above the first CTA. The governing sentence: the report should
feel like *"here is the evidence, here is why it may be happening, here is how
we'd investigate"* — not *"here is the evidence, followed by paragraphs about
why you should not overinterpret the evidence."*

## Principle applied

Caveats live in exactly TWO places: one compact scope line directly under the
hero, and the "How this was measured" drawer (which absorbs everything else).
Every cut below preserves the semantic guarantee somewhere — the
copy-discipline test updates only where a phrase legitimately moved, never by
deleting a guarantee.

## Changes (all presentation-only — live links update without republish)

1. **Hero qualifier** → "Point-in-time sample — the captured prompts and test
   dates, not market share, lead volume, or a permanent AI ranking." The
   "judgment of service quality" clause moves into the methodology drawer.
2. **Intro paragraph** ("AI answers may shape early consideration…") →
   replaced by one supporting line derived from snapshot data: "We put
   {promptCount} real {market} buyer and seller questions to {testedSystem},
   each asked {reps}; {published-below clause}."
3. **Adoption stat** (the "millions use ChatGPT" framing) moves from the hero
   to the methodology drawer — the page demonstrates the result; it doesn't
   need the trend claim up front.
4. **Team/brand mention split line** (94/95) cut from the stakes block; the
   compact totals row (mentions, yours, "buyers heard instead") + the
   one-line units note stay.
5. **Commission economics** collapse into a drawer ("Why this could matter
   financially — an illustrative calculation") below the track-record line;
   full illustrative-estimate disclaimer unchanged inside.
6. **Counting recipe above the table**: four-step list → two sentences;
   definitions footnote keeps Brought up/Recommended and says the overlap
   caveat once.
7. **Cut "No individual team owns the answers yet — that space is still
   open"** from the brand-mentions block — it contradicts a rival-variant
   hero (29/64) and reads as sales copy; the open-variant hero already owns
   that message when it is true.
8. **Source diagnosis caveats collapse to one sentence** that keeps the
   pinned phrase: "Citation frequency does not establish that any one source
   caused a recommendation — the list identifies the public information
   environment the models surfaced." COMPETITOR_SURFACE_NOTE drops from the
   page (the "(competitor-owned)" tag in the source list stays).
9. **Final CTA block**: closing line → "The clearest opportunity: make
   {prospect}'s credentials consistently visible across the credible public
   sources that appeared in these answers." The "How to read this report"
   paragraph moves into the methodology drawer.
10. **Generator (future publishes only): the citation-count observation**
    (lib/prospects/diagnose.ts) labels its number precisely — "Across the
    captured answers we recorded N source citations (each displayed citation
    counted, repeats included); your own site appeared 0 times." The
    already-published Team Moza snapshot keeps its frozen wording until a
    republish.

## Out of scope

- Redesign of layout/typography (copy + structure only).
- Rewriting frozen snapshot text at render time (immutability).
- The answers appendix page.

## Acceptance criteria

- [ ] Above-the-fold word count measurably reduced; caveats appear only under
      the hero and inside drawers (manual review of rendered page).
- [ ] Copy-discipline + terminology unit tests updated alongside moved
      phrases; every semantic guarantee still asserted (scope line, units
      note, illustrative commission, causality caveat, prohibited-phrase
      scan).
- [ ] Layout-consistency test passes (type scale, primitives).
- [ ] diagnose.ts labels the citation count precisely; unit test covers the
      new wording.
- [ ] Lint, typecheck, full suite pass.
