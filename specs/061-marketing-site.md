# Spec 061 — Public Marketing Site (Evidence-Led)

## Why

The platform has no inbound surface. The apex domain (recommendedfirst.com) is
unused while the app lives on app.recommendedfirst.com; "landing page" has been
an open operator blocker since deployment. This spec creates the public
marketing site as a new audience surface: **prospect, anonymous, indexable** —
distinct from the token-gated audit pages (no token, no client data) and the
internal workspace (no auth, no chrome).

Positioning follows the operator's V2 brief (2026-08-12): **AI Recommendation
Intelligence + Visibility Engineering for real estate**, proof before pitch.
The site reads as an intelligence product, not an agency funnel. Core sentence:
"We show market-leading real estate teams where they're being overlooked by AI,
investigate why, implement evidence-backed improvements, and measure what
changes."

## Surfaces

New route group `app/(marketing)/`, all public, all indexable:

| Route | Content |
|---|---|
| `/home` | Homepage: hero → interactive illustrative audit demo → visibility gap → metrics (AI Recommendation Share, AI Visibility Index) → competitive diagnosis → recommendation moments → Measure/Diagnose/Engineer/Verify → evidence standard → interventions → GEO vs SEO → done-for-you → illustrative dashboard → baseline/intervention/retest → sample audit preview → example measurement framework → fit/not-fit → exclusivity → why now → FAQ → request form → footer |
| `/methodology` | How we measure AI visibility: prompt universe, model coverage, repeat testing, recommendation share, citation/entity analysis, diagnosis framework, retesting, confidence classification, known limitations, versioning |
| `/sample-audit` | Report-viewer-shaped sample audit, every number labeled illustrative |

Brand: **Recommended First** (text wordmark; the live domain is the brand
name). No logo asset exists; none is fabricated.

## Routing & shell

- `MARKETING_PREFIXES` in `lib/marketing/constants.ts`, shared by:
  - `middleware.ts` — added to public prefixes; plus an apex-host rewrite:
    when `MARKETING_HOST` env matches the request host and path is `/`,
    rewrite to `/home`. The app host keeps `/` = operator dashboard.
  - `components/layout/app-shell.tsx` — marketing paths render without
    workspace chrome (same escape as `/audit`).
- Route group layout `app/(marketing)/layout.tsx` owns marketing nav + footer
  and its own `metadata` (indexable, unlike audit pages).

## Audit request form (primary conversion)

- Table `audit_requests` (migration 071): insert-only lead capture — name,
  work email, company, website, market, optional specialization, status
  `new`, source `marketing_site`, created_at. Reversible migration.
- Server action (public — documented exception to the auth-gate convention,
  like the audit page): zod validation, length caps, honeypot field dropped
  silently. Data access in `db/audit-requests.ts`, logic in
  `lib/marketing/audit-requests.ts`.
- Post-submit copy is honest about the manual process: "Requests are
  reviewed before analysis" — no fake instant-generation theater.
- Leads surface later in the prospects workflow (out of scope here).

## Truth rules (non-negotiable, from the brief §58 + prospect-voice)

- No client data exists on these pages. Every demo number is deterministic
  fixture data labeled **Illustrative example — not client data**, visible at
  the point of every chart/metric, not a footnote.
- No invented case studies, testimonials, logos, adoption stats, or
  "trusted by" claims. The case-study slot ships as "what a result will look
  like," labeled hypothetical.
- Competitors in demos are "Competitor A/B/C" — never realistic invented names.
- `PROHIBITED_PHRASES` discipline applies; claim language is "we measure /
  we observe / evidence suggests," never ranking guarantees or algorithm
  knowledge. AI Visibility Index carries its disclaimer inline.
- Market exclusivity section states conflict-of-interest management only —
  true operationally (spec 028) — no scarcity theater.

## Design

Governed by `.claude/skills/audit-page-design` ("any future public surface"):
pinned dials (variance 3-4, motion 2-3, density 3-4), existing tokens only,
color budget (destructive = the gap numbers, primary = the CTA, nothing else),
tabular-nums, Tailwind 4 + existing fonts (Inter/JetBrains Mono; Newsreader
serif route-local for display lines, matching the audit page). Charts are SVG
presentation attributes (RateBar pattern) — no inline styles, no hex. Two CTA
intents sitewide: "Check your AI visibility" (form) and "View the sample
audit". Client JS only where interaction is real: audit demo tabs, mobile nav,
form state. FAQ uses native `<details>`. `prefers-reduced-motion` respected.

## Guard amendments (deliberate law changes)

`tests/unit/layout-consistency.test.ts`: `app/(marketing)/` pages are a
declared surface class — exempt from the workspace shell/h1/width rules, with
their own type-scale allowance (`text-xs/sm/lg/2xl` + `text-4xl` display).
Hex/inline-style bans still apply. A new marketing-copy guard runs
`findProhibitedPhrase` over all `app/(marketing)/` sources.

## Acceptance criteria

- [ ] `/home`, `/methodology`, `/sample-audit` render logged-out (public in
      middleware), with no workspace chrome, in both themes.
- [ ] `/` on the app host still requires auth; apex-host rewrite covered by
      unit-testable helper.
- [ ] Audit request form: valid submit inserts a row and shows the honest
      confirmation; invalid submit shows inline errors; honeypot silently no-ops.
- [ ] Migration 071 applies and rolls back cleanly.
- [ ] Every illustrative figure is labeled at point of display.
- [ ] No prohibited phrases in marketing sources (test-enforced).
- [ ] Lint, typecheck, and full unit suite pass.

## Out of scope (deliberate)

Insights/research section and city studies (§53–54 of the brief — routes can
be added under `(marketing)` later), A/B testing infra, analytics events,
email notification on new leads, sticky scroll-storytelling interaction,
sitemap.xml. Recorded in the brief as P2.
