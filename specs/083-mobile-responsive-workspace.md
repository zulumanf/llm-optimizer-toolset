# Spec 083 — Mobile-Responsive Workspace

> Status: implemented — acceptance criteria verified 2026-08-17
> Depends on: docs/04 (design system — amended by this spec), layout primitives (components/layout/*), tests/unit/layout-consistency.test.ts
> Branch: feat/083-mobile-responsive-workspace

## Why

The workspace was built desktop-first by declared policy — but the
operator now runs a weekly loop (approve refresh cards, review enrichment
proposals, read view stats) that fits a phone better than a desk. Recon:
the primitives are already mostly safe (tables scroll horizontally, stat
grids stack, dialogs are shadcn), the audit pages are fully responsive —
the one structural blocker is the sidebar: a fixed 240px panel with zero
mobile handling that crushes every internal page on a phone.

## Design

1. **Sidebar → drawer on small screens** (the core). `AppShell` (already a
   client component) renders the sidebar slot two ways: static `lg:flex`
   as today, and below `lg` a slim top bar (brand + menu button) that
   opens the same sidebar content as a fixed slide-over with a backdrop;
   closes on backdrop tap and on navigation. Same server-rendered sidebar
   content — no second nav to drift.
2. **Shell breathing room**: `PageShell` padding `p-4 sm:p-6`;
   `PageHeader` already wraps.
3. **Page-level sweeps**: the prospects index funnel and any bare-width
   sections keep their `overflow-x-auto` containers; action button rows
   get `flex-wrap` where missing.
4. **Doc amendment**: docs/04 and CLAUDE.md drop "desktop-first" for
   "responsive; optimized for desktop density" — policy follows reality.
5. **Regression fence**: a Playwright mobile-viewport (390×844) smoke
   spec asserts the key operator pages (dashboard, prospects, prospect
   detail, refresh queue, notifications) render with **no horizontal page
   scroll** and a reachable nav. The layout-consistency unit suite keeps
   passing untouched.

## Out of scope

Per-page mobile redesigns (tables stay tables — scrollable); the portal
and marketing surfaces (own shells); touch gestures.

## Acceptance criteria

- [x] At 390px: sidebar hidden, top bar shows, menu opens/closes the
      drawer, navigation closes it (e2e mobile viewport).
- [x] Key operator pages have no horizontal page scroll at 390px (e2e
      asserts scrollWidth <= viewport for the document element).
- [x] Desktop layout is pixel-unchanged at lg+ (existing e2e suite passes
      untouched).
- [x] layout-consistency unit suite passes unchanged.

## Definition of done

Criteria pass · suites green · lint/typecheck clean · docs/04 + CLAUDE.md
amended · DECISIONS entry.
