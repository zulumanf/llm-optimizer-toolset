# Spec 123 — Public Audit Page Rebuild (first-principles prospect story)

> Status: done
> Depends on: specs/032/045/048/076/086/090/093 (audit page lineage), spec 122 (Arm B-v3 outreach the page must corroborate)
> Branch: feat/123-audit-page-rebuild

## Goal

Rebuild the public prospect audit page (`app/audit/[handle]/page.tsx`) so a
non-technical, successful real-estate agent understands it in under 60
seconds. Hormozi principles: obvious problem, obvious value, obvious cost of
ignoring, concrete proof, no jargon, minimal friction.

Banned terms in the primary experience: GEO, AEO, LLM, model retrieval,
citation graph, entity authority, provenance, recommendation-intent subset,
prompt monitoring.

Seven things the prospect must understand: (1) people ask AI which agents to
work with; (2) we tested what AI currently tells them; (3) their team shows
up less than it should; (4) other local teams show up instead; (5) we can
help improve that; (6) we can prove every result; (7) they can see the plan
if they want. Mental model: "Your real-world reputation and your AI
reputation are not the same thing."

## Hard lines that override the brief where they conflict

- prospect-voice skill: no fabricated losses (`PROHIBITED_PHRASES`), every
  number is a receipt, "not measured" over zero, absences need total proof,
  nothing invented ever.
- audit-page-design skill: enforced type scale (`text-xs/sm/lg/2xl` only —
  "one very large number" is rendered with weight/space, not size), color
  budget (destructive = the prospect's pain numbers only, primary = CTA
  only), native `<details>`, snapshot-only rendering, graceful degradation
  for older snapshots.
- terminology layer (`lib/prospects/terminology.ts`): an API benchmark is
  never described as "we asked ChatGPT". Consumer names (ChatGPT,
  Perplexity) appear only via `verifySuggestionApps`-derived phrasing ("the
  systems behind ChatGPT and Perplexity") and as exhibit labels; the precise
  tested-system phrase stays in methodology.
- Copy-discipline gates (tests/unit/audit-copy-discipline.test.ts) keep all
  required strings: mention units at the number, point-in-time scope, "how
  to read this report", illustrative commission labeling, citation-causality
  sentence.

## Page structure (~7 sections)

1. **Hero** — label "AI visibility check", team · market, state-adapted
   headline, the recommendation count as the one focal number, one
   denominator sentence ("We tested N AI answers…"), "Other {market} teams
   were recommended instead" when counted true, scope line, CTA button.
2. **Who showed up instead** — 3–5 strongest rival teams with counts,
   prospect's own row visually obvious at the bottom; full comparison table
   (brought-up counts, ranks, brand-level names) folded in a drawer; one
   verbatim excerpt as the sting.
3. **Why this matters** — 2–3 short sentences, adoption stat with receipt
   when the snapshot carries one, no causality overclaim.
4. **The gap** — verified reputation facts vs the AI count; rank-vs-
   recommendations sentence when the data shows divergence; the operator's
   human finding.
5. **What we'd change** — max 4 plain items derived from the snapshot's
   diagnoses when present, else the four service workstreams.
6. **Where AI is getting its information** — bar list of top cited source
   sites with counts, owned-site row highlighted when present, honest
   "did not appear among the most-cited sources" otherwise, single
   causality caveat.
7. **CTA** — "Want to see what I'd change first?", button "Show me the
   plan" (existing mailto mechanics + `data-signal-cta="walkthrough"`),
   "15 minutes · no obligation", signature.

Level 2 (collapsed drawers): key finding, questions asked, track-record
receipts, "How we ran the test" (plain-English opener + full methodology,
dates, model identifiers, limitations), illustrative commission arithmetic,
full comparison table. Raw-answer proof section ("Want to verify it
yourself?" → "View the answers") with honest shown-of-captured metadata —
"every answer" claimed only when provably complete.

## Number hierarchy

One denominator in the primary experience: `benchmark.responseCount` (e.g.
512 = 64 questions × 2 assistants × 4 repetitions). When comparison-row
sample sizes differ from it (e.g. Wilmington's frozen 354-answer counting
basis), one sentence at the table explains the basis; never a bare "0 / 354".
Published-appendix subsets (e.g. 400 of 512, or a 50-answer legacy cap)
stated as shown-of-total, never as completeness.

## Narrative states

Computed in `components/audit/narrative.ts` from the snapshot (pure,
unit-tested): ZERO (0 recommendations), LOW (< visibilityThreshold), STRONG
(≥ threshold, not top), LEADER (≥ threshold and no rival counted higher),
LEGACY (no stakes block on old snapshots → generator headline). Same page
structure for all; the story matches the evidence.

## Analytics

All existing signals preserved (`competitors`, `authority`, `methodology`
sections; `prompts` evidence; `walkthrough` CTA; beacon scroll/engaged-time).
New section-view signals via the same `data-signal-*` mechanism: `sources`,
`raw-answers`, plus `comparison` evidence for the full-table drawer.

## Tests

- tests/unit/audit-narrative.test.ts — zero/low/strong/leader/legacy states,
  headline wording, denominator/basis sentences, no "every answer" overclaim.
- tests/unit/audit-copy-discipline.test.ts — unchanged gates, new
  `components/audit/narrative.ts` added to the scanned surfaces.
- tests/e2e/audit-page.spec.ts — updated to the rebuilt labels; not-found
  and no-chrome invariants unchanged.
- tests/e2e/mobile.spec.ts — audit page renders phone-width with no
  horizontal scroll.

## Round 2 (ruthless simplification, 2026-08-30)

Operator review demanded a second pass: the page is a simple evidence-backed
sales diagnostic, not a benchmark report. A reader who scans only headings,
bold text, numbers, competitor names, and buttons gets the whole pitch.

- **Eight blocks**: hero → competitor contrast → why this matters (2
  sentences) → reputation vs AI presence ("Real-world proof" vs "AI
  recommendations", "That's the gap") → What we do (1 sentence + 3 steps) →
  Where AI got its information → CTA → "Want to verify the data?" with ALL
  proof collapsed (full competitor table, diagnoses, questions, receipts,
  commission arithmetic, How we ran the test, Limitations).
- **Hero**: eyebrow "Private AI visibility report", team · market,
  state-adapted headline, a genuinely large number (`text-6xl` — the
  workspace type-scale gate now scope-exempts `app/audit/` per
  audit-page-design precedence; see DECISIONS.md), "Across the 512 ChatGPT
  and Perplexity answers we tested." (provider-derived via
  `answersTestedPhrase`), one opportunity line ("No {market} team dominates
  these answers yet." only when no rival cleared the visibility threshold),
  CTA, and a "How this was measured ↓" anchor. No caveats above the fold —
  they live in the Limitations drawer, said once.
- **One dominant denominator**: the primary flow shows bare counts against
  the headline denominator only; a differing comparison basis (354-of-512)
  is explained once, in the methodology drawer. The published-answers note
  states the exact published count ("400 published answers of the 512
  captured…").
- **One CTA promise**: "Show me the plan" + "15 minutes · no obligation",
  identical at both placements (top per prospect-voice, bottom before the
  proof).
- **Cut**: keyFinding paragraph drawer, repeated definitions, repeated
  "not estimates"/"skepticism welcome" lines, second methodology recital,
  hero scope lines. Diagnoses (`whyItHappens`) fold into "Where the gap
  shows up — what we counted".
- **Copy caps honored**: why-matters 2 sentences; reputation ≤3 sentences +
  sourced facts; what-we-do 1 sentence + 3 steps ≤15 words each; sources
  list + 2 sentences + hedged causality line.

## Non-goals

- No snapshot/publish changes (`lib/prospects/audits.ts` untouched) — the
  page renders any published snapshot, old or new.
- No outreach, dashboard, or scripts changes.
- No new dependencies, fonts (Newsreader stays), or client JS beyond the
  existing beacon.
