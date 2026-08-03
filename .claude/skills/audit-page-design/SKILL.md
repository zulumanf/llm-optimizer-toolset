---
name: audit-page-design
description: Design rules for PROSPECT-FACING pages (app/audit/** and any future public surface). Load whenever styling or redesigning those pages; also load taste-core and taste-redesign, over which this file takes precedence.
---

# Prospect-facing page design — house rules

The audit page is an **evidence document a skeptical agent reads from a cold
email**. Two vendored skills (`taste-core`, `taste-redesign`) provide the craft;
this file decides where they yield. **Order of authority: platform integrity
rules → docs/04 + the layout test → this file → the taste skills.**

## The design read (fixed — don't re-infer)

> Reading this as: a trust-first evidence report for a commercial audience,
> minimalist/editorial language, restrained motion.

Taste-core dials, pinned: `DESIGN_VARIANCE: 3-4 · MOTION_INTENSITY: 2-3 ·
VISUAL_DENSITY: 3-4` (its own "trust-first / regulated" row). Never the 8/6/4
baseline — an Awwwards audit page reads as marketing, and marketing reads as
untrustworthy here.

## Hard overrides (where the taste skills are wrong for this repo)

1. **Everything on these pages is real.** Taste-redesign's Content section
   ("invent believable names", "use organic messy data", picsum placeholder
   imagery) is demo-site advice — **forbidden here**. Every name, number, quote,
   and date comes from the snapshot. No stock photos, no decorative imagery, no
   invented anything. An evidence page with a fake garnish loses the case.
2. **No fabricated-loss copy.** `PROHIBITED_PHRASES`
   (lib/prospects/constants.ts) applies to page copy: no "losing deals",
   "costing you", "guaranteed", etc. Stakes are counted moments and the
   prospect's own arithmetic.
3. **Type scale is enforced by a test** (tests/unit/layout-consistency.test.ts):
   `text-xs/sm/lg/2xl` only — `text-xl`, `text-3xl+` fail CI. Headline
   "presence" comes from weight, tracking, and space, not size.
4. **Stack stays put**: Tailwind 4 utilities only, existing tokens
   (`bg-background`, `text-muted-foreground`, `border`), dark mode must keep
   working, no new dependencies without checking package.json, no CSS files.
   Server components; no client JS for decoration (native `<details>` is the
   approved disclosure mechanism).
5. **Lucide icons stay** (repo standard); prefer no icons over new icon sets.
6. **Fonts**: Inter + JetBrains Mono are loaded in the root layout. A serif
   display face for audit headlines is allowed ONLY via `next/font` in the
   audit route, self-hosted/Google — decide deliberately, never swap the
   workspace font.

## What to take from the taste skills (they're right about these)

- Tabular figures for every number (`tabular-nums` — already conventional here).
- **Color budget is semantic and fixed (CRO pass, 2026-08-03):**
  `text-destructive` marks the pain only (the prospect's zero/low numbers);
  `bg-primary` marks the action only (the CTA buttons). Nothing else on the
  page gets color. Two meanings, two colors, zero decoration.
- The CTA is a one-click mailto button ("show me" prefilled in subject+body)
  when the snapshot carries preparedBy.email; text fallback otherwise.
  Commitment bar stated next to it: "15 minutes, no deck, no obligation."
  No fake urgency, no invented social proof — the evidence is the proof.
- Optical alignment over mathematical; asymmetry in measured doses.
- Hover/focus/active states on every interactive element; visible focus rings.
- ~65ch body measure; `text-wrap: balance` on headlines; sentence case.
- Whitespace as hierarchy: the punch line earns its space by what's NOT around it.
- Plain, specific language; no "Elevate/Seamless/Unleash"; no "Oops!".

## Page-specific invariants (spec 032/045 — do not regress)

- The five-second read: first screen carries the whole punch (counted moments,
  who got named, the reply ask). Depth stays folded in `<details>`.
- Every claim keeps its receipt: appendix link, source links, capture dates,
  the preparedBy signature, "not measured" over zero.
- The page renders from the immutable snapshot only — design changes are
  presentation-only and must never require republishing to look right
  (guard optional fields).
