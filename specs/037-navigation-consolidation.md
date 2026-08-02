# Spec 037 — Navigation Consolidation

> Status: done (2026-08-02) — implemented; manual browser QA by operator pending
> Depends on: docs/04 (design system) · components/layout/sections.ts · every project section spec (001–036)
> Branch: feat/034-learning-loop line (committed on feat/032-contacts-and-import — see DECISIONS)

## Goal

The sidebar stops being an inventory and becomes a map. The nav grew 3× past its design (docs/04 specifies 8 project sections; there are 16, plus 11 global links) by accretion — every spec added a link, none merged one. This spec: groups the project nav by the operator's reading order (already encoded as a comment in `sections.ts`, invisible on screen), collapses the machinery-inspection pages into a System group, merges same-question destinations into linked tab bars, and moves attention counts onto fewer entries as badges. **No route changes**: every existing URL keeps working — merges are tab bars over existing sibling routes, so bookmarks, cross-links, and tests survive untouched.

## Non-goals

- No route moves, no redirects, no page deletions. `/projects/[id]/review` et al. remain real URLs.
- No mobile nav work (desktop-first internal tool, docs/04).
- No portal changes (client shell is separate, spec 031).
- No new pages — Findings/Work are groupings of existing pages, not new surfaces.

## The new structure

**Global (11 flat → 4 visible + collapsible System + client list):**

- **Today** (`/`) — carries the unread-notifications badge (the Inbox entry is removed; Today already renders the attention feed, and `/notifications` stays reachable from it and ⌘K).
- **Approvals** — carries the pending-approvals count badge.
- **Clients** (`/projects`) — the active-client list stays nested beneath, unchanged.
- **Prospects**
- **System** (collapsible, default collapsed, persisted in `localStorage`): Control tower · Workflows · Automation · Agents · Companies · Exclusivity.

**Project (16 flat → 11 in 4 labeled groups + Settings):**

| Group | Entries | Tab-merged routes |
|---|---|---|
| *(header)* | ← All clients · project name | |
| **Overview** | Dashboard · Plan · Knowledge | |
| **Measure** | Prompts · Runs | Runs page ⇄ Review queue (tab bar, pending count on the tab) |
| **Findings** | Findings · Competitors | Findings = Gaps ⇄ Accuracy (tab bar; sidebar entry targets `/gaps`, active on both) |
| **Act** | Content · Work · Reports | Work = Tasks ⇄ Campaigns ⇄ Interventions; Reports ⇄ Client validation |
| | Settings | |

Removed from the sidebar (still real URLs, reachable via tab bars and ⌘K): Review, Accuracy, Campaigns, Interventions, Validation, Inbox.

## Mechanics

- `components/layout/sections.ts` — `PROJECT_SECTIONS` stays the complete flat list (the command palette must keep every destination); adds `PROJECT_NAV_GROUPS` (label + section paths) and `TAB_SETS` (named sets of sibling routes with labels) as the single source for both the sidebar and the in-page tab bars.
- `components/layout/page-tabs.tsx` — a small link-tab component (no new dependency; shadcn tabs are stateful, these are links). Renders the current set with the active route highlighted and optional per-tab count badges.
- `components/layout/sidebar-nav.tsx` — grouped rendering with `uppercase text-xs` group labels; a `System` disclosure (client state + `localStorage("nav:system-open")`); active-state matching extended so a group entry highlights for any of its tab siblings.
- `components/layout/sidebar.tsx` — fetches the pending-approvals count alongside the unread count.
- Tab bars added at the top of: gaps + accuracy pages (Findings); tasks + campaigns + interventions (Work); runs + review (Measure — the Review tab shows the project's pending-review count); reports + validation.
- `docs/04-ui-design-system.md` navigation section rewritten to match (it currently describes the 8-section layout from January).

## Edge cases

- Deep link to a demoted page (e.g. `/projects/x/accuracy`): sidebar highlights its group entry (Findings), tab bar shows where you are. Nothing 404s.
- ⌘K palette keeps every destination, including demoted ones — the palette is the escape hatch, so it must not shrink.
- Client roles: unchanged (they never see this sidebar).
- System group state is per-browser; default collapsed. A user inside a System page sees the group auto-expanded (active page must never be hidden).
- Unread and approval badges cap their display at 99+.

## Acceptance criteria

- [x] Global sidebar shows exactly Today, Approvals, Clients, Prospects + collapsed System (6 entries) + client list; expanding System reveals the six machinery pages; state persists across reloads; System auto-expands when a System page is active.
- [x] Project sidebar shows the 4 labeled groups + Settings (11 entries); the group entry is active when any of its tab-merged siblings is the current page.
- [x] Every one of the previous 16 project paths and 11 global paths is still reachable by URL, by tab bar, and by ⌘K.
- [x] Runs/Review, Gaps/Accuracy, Tasks/Campaigns/Interventions, Reports/Validation each share a tab bar; the Review tab shows the pending count.
- [x] Today carries the unread badge; Approvals carries the pending count.
- [x] A config-integrity unit test proves the groups + tab sets cover all 16 sections with no orphans or duplicates.
- [x] Suite, lint, typecheck green; docs/04 updated. No migration.

## Test cases

- Unit `nav-structure.test.ts`: every `PROJECT_SECTIONS` path appears exactly once across `PROJECT_NAV_GROUPS`' visible entries or a `TAB_SETS` member; tab sets reference real section paths; no sidebar entry points at a nonexistent path.
- Existing integration suite unchanged (no routes moved — that's the point).
- Manual QA: click through every group, tab, deep link, and the ⌘K palette against the running app.

## Definition of done

All acceptance criteria pass · suite/lint/typecheck green · docs/04 navigation section updated · DECISIONS records the tabs-over-route-moves choice.
