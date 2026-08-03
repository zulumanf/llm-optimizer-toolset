# 04 — UI Design System

Internal operator tool: dense, fast, legible. Desktop-first, dark mode required, Tailwind + shadcn/ui only. No inline styles, no bespoke CSS files. If a component isn't listed here, add it here before building it.

## Foundations

### Colors
Semantic tokens only — never raw hex in components. Defined as CSS variables in `app/globals.css` (shadcn convention), light + dark values for each:

| Token | Use |
|---|---|
| `background` / `foreground` | page base |
| `card` / `card-foreground` | panels, stat tiles |
| `muted` / `muted-foreground` | secondary text, table headers |
| `primary` | actions, links, active nav |
| `destructive` | irreversible actions, failures |
| `border` / `input` / `ring` | outlines, focus |

Status colors (badges, trends): `success` (green) = improvement/completed, `warning` (amber) = needs review/partial, `destructive` (red) = failure/decline, `muted` = neutral/no change. Trend deltas always pair color with a sign/arrow — never color alone (accessibility).

### Typography
- Font: Inter (UI), JetBrains Mono (raw responses, prompt text, IDs).
- Scale: `text-2xl` page title · `text-lg` section · `text-sm` body/tables · `text-xs` metadata. Nothing else.
- Numbers in tables and stat tiles: `tabular-nums`.

### Spacing & layout
- Tailwind default scale; page padding `p-6`, card padding `p-4`, stack gap `gap-4`.
- Layout: fixed left sidebar (240px) navigation + scrollable content, max content width `max-w-7xl`.
- Density over whitespace: this is a workbench, not a landing page.

## Navigation

Two sidebar states (spec 037), one source of truth (`components/layout/sections.ts` — the nav-structure test enforces coverage):

- **Global:** Today (unread badge) · Approvals (pending badge) · Clients · Prospects, then the Active clients list, then a collapsible **System** group (default collapsed, persisted; auto-opens on its own pages): Control tower · Workflows · Automation · Agents · Companies · Exclusivity.
- **Project**, grouped in the operator's reading order: **Overview** (Dashboard · Plan · Knowledge) · **Measure** (Prompts · Runs) · **Findings** (Findings · Competitors) · **Act** (Content · Work · Reports) · Settings.
- **Same-question routes share one entry and a link-tab bar** (`PageTabs`), never separate sidebar links: Runs ⇄ Review (pending count on the tab), Gaps ⇄ Accuracy, Tasks ⇄ Campaigns ⇄ Interventions, Reports ⇄ Validation. Every merged page keeps its URL.
- The ⌘K palette lists **every** destination including demoted ones — it is the escape hatch and must not shrink.
- Active item highlighted with `primary`; a merged entry is active on any of its tab siblings. Breadcrumbs on detail pages (`Runs / Weekly baseline 2026-W31`).

Rule going forward: a new feature earns a **tab on an existing entry or a place in an existing group** by default; a brand-new sidebar entry requires a spec that says why no group fits.

## Page primitives (`components/layout/page.tsx`) — use these, don't hand-roll

This section exists because the rules above were documented from day one and
drifted anyway: an audit on 2026-07-30 found **six different container widths
across 52 pages, 35 of them hand-rolling the same breadcrumb-and-title block**.
A design system nobody can import is a style guide, and style guides lose to
whatever the last page did.

| Primitive | Use |
|---|---|
| `PageShell` | The page container. One width (`max-w-7xl`), one padding (`p-6`). Never set a page width by hand. |
| `PageHeader` | Breadcrumbs, `h1`, description, status badge, actions. Owns the only `h1` on the page. |
| `Section` | A titled block at `text-lg`. No page invents its own heading size. |
| `EmptyState` | The mandatory empty state: one sentence saying *why* it is empty, plus an action where one exists. |
| `StatGrid` / `Stat` | Metric tiles. `tabular-nums` built in; pass `"not measured"` rather than `0` when nothing was observed. |

`tests/unit/layout-consistency.test.ts` enforces the mechanically checkable
rules — content width, the type scale, one `h1` per page, no raw hex, no inline
styles — by reading the page files. It also prints how many pages remain on a
hand-rolled shell, so the migration debt is visible in CI rather than
discovered a year later.

## Components (shadcn/ui unless noted)

- **Buttons:** `default` for primary action (one per view), `outline` secondary, `ghost` inline row actions, `destructive` for irreversible ops — destructive always behind a confirm dialog naming the object ("Archive project 'Acme Core'?").
- **Cards:** stat tiles (metric name, big value, delta badge vs. previous run), section panels. Stat tile click → drill into underlying data (traceability in the UI).
- **Tables:** shadcn Table + TanStack. Sortable headers, sticky header, row click → detail drawer or page. Pagination beyond 50 rows. Every table has an empty state (see below).
- **Forms:** react-hook-form + Zod (same schema as the server action). Inline field errors, disabled submit while pending, toast on success/failure.
- **Dialogs:** confirmations and small forms only. Anything with a table or >6 fields gets a page or drawer, not a dialog.
- **Drawer (right side):** response detail, mention review — keeps table context visible.
- **Badges:** status (`running`, `needs review`, `published`…), provider (OpenAI/Anthropic/Google/Perplexity each a fixed color), confidence (`high ≥0.9`, `med ≥0.7`, `low <0.7`).
- **Icons:** lucide-react only, `size-4` inline, `size-5` navigation.
- **Charts:** Recharts. Line for trends over runs, grouped bar for provider/competitor comparison. Always label the scoring version on the chart. No pie charts.
- **Raw response viewer:** mono font, preserved whitespace, brand-mention highlighting, collapsible raw JSON payload underneath. Raw text is never edited for display beyond safe escaping.

## States (mandatory for every async view)

- **Loading:** skeletons matching final layout (shadcn Skeleton). No unlabeled full-page spinners.
- **Empty:** icon + one sentence + primary action ("No prompt sets yet — Create one").
- **Error:** what failed in plain words + Retry button + error id for logs. Never a blank screen, never a raw stack trace.
- **Partial:** runs can be `partial` (some cells failed) — show completed/failed counts, never pretend completeness.

## Accessibility

- Full keyboard operability; visible focus rings (`ring` token) everywhere.
- Labels on all inputs (no placeholder-as-label), `aria-live` for toasts and run status changes.
- Contrast ≥ 4.5:1 for text in both themes; color never the only signal.
- Prefer `<button>`/`<a>` semantics; no clickable `div`s.

## Voice

UI copy is terse and factual: "Run failed: 3 of 40 calls errored", not "Oops! Something went wrong". Timestamps absolute with relative hint ("2026-07-27 06:00 · 3h ago"). Never hide bad news.
