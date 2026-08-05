# Spec 048 — Audit Page Conversion Pass (external feedback, reconciled)

> Status: implemented 2026-08-03. Source: operator-supplied external review of
> the audit landing page. Each item below was accepted, adapted, or rejected
> against the platform's integrity rules (prospect-voice, audit-page-design,
> PROHIBITED_PHRASES, snapshot immutability). This file is the record of that
> reconciliation — the page must not silently drift back.

## Accepted (implemented)

1. **Concrete hero when the data allows it.** When the snapshot carries a
   sourced market rank AND stakes counts, the hero renders derived text:
   "You're the #N team in {market}. In {X} AI answers, you were recommended
   {Y} times." — every token from the snapshot. Snapshots without a rank keep
   their approved headline. Presentation-only; no republish needed.
2. **Hope immediately after the sting.** A "good news" paragraph — rendered
   ONLY when sourced authority signals exist, so it is never an empty
   consolation: the record is fine, the representation is the gap.
3. **Authority vs visibility meters.** Two 0–100 bars from the already-
   computed spec-038 scores, shown alongside the stakes when both measured.
4. **Softened overclaims** (feedback item 4, all four):
   - "a listing appointment forming" → "the kind of answer that shapes a
     seller's shortlist"
   - "the exact sources AI reads" → "the sources these answers actually
     cited" (which is what topSources IS)
   - "whoever fixes this first becomes the default recommendation" →
     "teams that establish consistent signals early are hard to displace"
   - "what it takes to become the name in the answer" → "the first changes
     we'd prioritize"
5. **Counts before percentages.** Table and brand bars label "3/40" (pct in
   the title attribute); heading states the answer base; an overlap note
   explains why columns don't sum to 100%.
6. **Question above the excerpt.** evidenceExcerpts gained optional
   promptText (additive; old snapshots render unchanged).
7. **Diagnosis in the open.** whyItHappens (spec 042 whitelist) moved from a
   drawer to visible numbered cards with the fix line — proof of a problem
   earns attention; visible reasons earn the meeting. Receipts stay folded.
8. **Fixability, real not invented.** Snapshot gains spec-039's computed
   fixability (version, score, confidence, top measured strengths), embedded
   only when adjusted is non-null. Explicitly labeled "how addressable the
   gap is — not a promise of outcomes."
9. **Outcome-specific CTA copy**, "no deck" dropped, mailto mechanic kept.
10. **Market name in the table heading** (personalization).
11. **The scorecard strip.** Up to three tiles — market authority, AI
    visibility, fixability — rendered directly under the counted-moments
    punch, each 0–100 with a thin bar and a shared basis footnote. Only
    measured tiles render (absence is absence, never a zero); the strip
    consolidates what were separate meters and a mid-page fixability card,
    and the fixability *strengths* line now rides under the diagnosis where
    it explains the score.

## Rejected, and why

- **Invented scores** ("Market authority: 82/100" as static copy) — only
  computed, versioned scores render. The feedback's numbers were examples;
  the platform's are real, so this was accepted as *data*, rejected as copy.
- **Sticky CTA / landing-page chrome** — the page's differentiator is that
  it reads as an evidence document, not a funnel (audit-page-design: trust-
  first dials, pinned). A floating "Book" button is what every vendor pitch
  does; this page wins by not doing it.
- **"Book the walkthrough" calendar CTA** — no scheduling infrastructure
  exists, and spec 032 deliberately ships no calendar links. The reply
  mechanic ("show me") is the funnel and matches the outreach email.
- **Two-width layout (720px prose / 1200px tables)** — the document measure
  is the design; tables scroll within it. Revisit only with real prospect
  feedback, not speculative CRO.
- **Un-accordioning everything** — the five-second-read invariant keeps
  methodology, full question list, and transcripts folded. Diagnosis and
  fixability are the exceptions the feedback correctly identified.
- **Teams-vs-brokerages separation** — already shipped (the comparison table
  is teams-only; brand mentions are summarized beneath it). Feedback was
  reviewing an older render.
- **Intent-tier recommendation breakdown** ("0 of 12 seller questions") —
  accepted in principle, deferred: tier data exists in spec 038's cells but
  is not yet snapshot-shaped. Tracked as the next audit-page increment; must
  ship with per-tier sample sizes or not at all.
- **"Joelle Chilazi" quotation-mark error** — not reproducible in the
  template (curly quotes are consistent); likely a data-side excerpt
  artifact. Check the excerpt content on the next publish.

## Acceptance

- [x] Old snapshots (no rank, no fixability, no promptText) render exactly
      as before — all new blocks are guarded.
- [x] No fabricated numbers; every new figure traces to a snapshot field.
- [x] Layout test passes (type scale, no new violations).
- [x] Full suite, typecheck, lint green.

## Round 2 (2026-08-04): the reviewer converges, and walks one thing back

The second review independently arrives at this spec's governing rule —
"the discipline of a landing page, the surface language of an evidence
document" — and endorses the round-1 rejections. Three deltas accepted:

1. **Fixability leaves the scorecard strip.** Authority and visibility are
   defensible to a stranger (sourced record; counted answers). Fixability,
   however computed, reads as a proprietary vendor score in tile form. The
   number moves into the diagnosis section as an argued sentence beside its
   reasons; the strip becomes the pure authority-vs-visibility contrast —
   the page's strongest visual device.
2. **CTA supporting line** adopts the reviewer's research framing: "I'll
   show you the captured answers, the likely causes of the gap, and the
   first changes I'd prioritize."
3. **Color-budget repair:** the seller-moment quote used the action color
   for its border; it takes the neutral quote treatment (accent belongs to
   the CTA alone).

Held position: the two-tile contrast stays quantified — research restraint
means every number keeps its receipt, not fewer numbers.

## Round 3 (2026-08-04): CRO-psychology reassessment, self-initiated

Findings from a cold read of the rendered page:

1. **The document leaked its frame (fixed, the big one).** Signed-in staff
   saw the workspace shell — sidebar, command palette, assistant bar, and
   OTHER CLIENTS' NAMES — around the prospect document. Anonymous visitors
   were safe (chrome renders null without a staff session), but an operator
   could never preview what a prospect sees, and any staff screenshot
   carried internal names. `AppShell` now strips all chrome on /audit/* for
   everyone; an E2E test pins it under a staff session.
2. **Emotional sequence corrected to agitate → anchor → hope → ask.** The
   "good news" paragraph sat between the seller-moment sting and the
   average-sale anchor, deflating the second agitation. It now lands after
   the full weight of the problem.
3. **"One that should sting" told the reader how to feel** — replaced with
   "One moment from the capture" (show, don't instruct).
4. **Unreceipted trend claim** ("buyers increasingly ask ChatGPT") became a
   conditional the page itself proves: "When buyers and sellers ask ChatGPT
   who to hire, the answers name names" — the 35 counted recommendation
   moments are the receipt.
5. **"Market authority" renamed "Documented authority."** A #9-ranked team
   scoring 30/100 read as the page contradicting its own hero; the score
   measures what the sourced record PROVES, and the label now says so.
6. **One mid-page ask added** at peak conviction (after diagnosis +
   fixability) — a sentence with the reply link, not a button: the next
   research step, not a second funnel. Kept: exactly two button CTAs
   (top and close), zero-repetition of the prospect's 0 (the zero is the
   product), no sticky elements, no scarcity theater.

## Round 3b (2026-08-04): format & design pass, from rendered screenshots

Reviewed as pixels (desktop/mobile, light/dark), not JSX. Dark mode and the
overall editorial restraint hold. Fixed:

1. **The hero's payoff line was muted** — the setup outweighed the punch.
   Full ink now; only the red zero is colored.
2. **Excerpt data artifacts**: captured answers arrive wearing their own
   quotation marks and markdown bold markers — rendered ""like this"" and
   **like this**. Render-side sanitizer strips the formatting, never the
   words. The blockquote also now picks the most substantial excerpt
   rather than whichever company sorted first (a two-word quote read as a
   glitch).
3. **Mobile table crushed team names into four lines** — min-width + nowrap
   makes it scroll sideways instead.
4. **Scorecard tiles were under-weighted** for their conceptual load —
   wider container, more padding, thicker bars. Still two tiles, still
   quiet.

## Round 4 (2026-08-05): the recipe moves to the figures

Operator feedback: agents couldn't tell how the figures were compiled, so
they couldn't trust them. The four-step counting recipe now sits visibly
inside the comparison section, in plain words with live numbers ("we wrote
10 questions… asked each one 4 separate times… all 40 published below,
unedited… the table is those counts — nothing is estimated or projected"),
plus in-place definitions of brought-up vs recommended. The full method
and limitations stay in the "How this was measured" drawer for the second
read. Rule reaffirmed: a skeptic should never have to open a drawer to
learn how a number was made.

## Round 5 (2026-08-05): the subtractive pass

Four additive rounds each earned their lines; together they were ~14 lines
of supporting prose above the fold and the CTA had slipped below it. This
pass cut ~40% of the body words with zero receipts lost: the intro
collapsed to two sentences (the recipe owns the method now), the scorecard
footnote to one line, the sting lost its explanatory tail (the moment
speaks), the average-sale line lost its sales-math clause (their number
does the work), the good news tightened to three short sentences, the
recipe items to one line each, the definitions to the "X = Y" form.
Result: the entire argument — hero, counted moments, competitors,
scorecard, sting, anchor, hope, ask — fits in one viewport. Editing rule
recorded for future rounds: additions must displace words, not stack on
them.

## Round 6 (2026-08-05): the non-technical reader

Operator insight: many recipient agents are older and not tech-savvy —
the page assumed they knew people ask ChatGPT for agent recommendations
and that its answers vary. Fixes: (1) the intro now states the premise
("ChatGPT is the AI assistant millions now use the way they used to use
Google — and it answers with specific names"); (2) recipe step 2 explains
repetition with an analogy ("answers change a little on every ask — like
asking four different receptionists") and the count does the arithmetic;
(3) the methodology drawer opens with a plain-terms sentence before the
technical text; (4) ORDER: the brownstone story moves above the scorecard
— stories before statistics for this audience — and the scorecard lands
directly before "the good news," whose reframe it now visibly sets up.
Still one viewport.
