---
name: ui-conventions
description: The internal workspace's UI rules — enforced type scale, layout primitives, shadcn-only, dark mode, async states. Load before building or changing ANY app/ page or component. Prospect-facing pages (app/audit/**) additionally follow audit-page-design, which wins there.
---

# Workspace UI conventions

Source of truth: `docs/04-ui-design-system.md`. This skill is the operational
digest plus the rules that are ENFORCED BY TESTS — violating them fails CI,
not just review.

## Enforced by tests/unit/layout-consistency.test.ts — read it before styling

- **Type scale: `text-xs`, `text-sm`, `text-lg`, `text-2xl` only.**
  `text-base` implicitly (unclassed), but `text-xl`, `text-3xl` and larger are
  BANNED on app pages. Headline presence comes from weight/tracking/space.
  This has failed builds twice; check the test when in doubt.
- Pages use the shared shell primitives, not hand-rolled headers.

## Layout primitives (components/layout/page.tsx) — never hand-roll these

`PageShell` → `PageHeader` (crumbs, title, description, badge, actions) →
`Section` (title, description, actions) → `StatGrid columns={n}` + `Stat`
(label, value, hint) → `EmptyState` (message, optional action).

Every async view needs loading, empty, AND error affordances. Empty states say
what to DO next, not just what's absent ("No story yet. Run a benchmark and
add proof above, then hit Generate"), and may carry an action button.

## Components and styling

- **shadcn/ui only** (components/ui/*): Button, Dialog, Input, Label, Select,
  Table, Badge, Textarea, Skeleton, AlertDialog. No new UI libraries.
- **Tailwind 4 utilities only** — no CSS files, no inline styles. Use theme
  tokens (`bg-background`, `text-muted-foreground`, `border`, `bg-muted/40`,
  `text-primary`) so dark mode works for free; never hardcode colors.
- **Icons: lucide-react**, size-4 inline with text.
- Numbers get `tabular-nums`. Dates via `toLocaleDateString/String`.

## Established patterns (copy these, don't reinvent)

- **Dialogs**: client component, `useState` open + `useTransition` pending,
  calls a server action, `toast.success/error` (sonner), closes and resets on
  success. Reference: `components/prospects/signal-dialog.tsx`.
- **Server actions**: thin wrappers in `app/<area>/actions.ts` —
  `getCurrentUser()` → service call → `revalidatePath` on ok. Logic lives in
  `lib/`, never in components or actions.
- **Row actions**: small client components taking ids
  (`components/prospects/contact-actions.tsx`).
- **Badges** for statuses: `variant` mapping — destructive for blocking states,
  secondary for neutral, outline for ok, default for emphasis.
- Escape user-visible apostrophes in JSX as `&apos;` (react/no-unescaped-entities
  is an error, not a warning).

## Page voice (internal)

Plain operator language in titles and descriptions — "Proof they're good",
not "Authority signals"; say what a section is FOR. No spec numbers or version
strings in prose (versions live in data/hints). Pages that have a natural next
action should compute and show it (the "Next step" banner pattern,
app/prospects/[id]/page.tsx).

## Precedence

Internal pages: this skill + docs/04. Prospect-facing pages (app/audit/**,
future public surfaces): `audit-page-design` overrides where they conflict;
the layout-test constraints apply everywhere regardless.
