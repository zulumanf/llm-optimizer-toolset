# Spec 031 — Client Portal (read-only command center, v1)

> Status: done (2026-07-31) — v1; "Not built" section applies
> Depends on: specs/014 (auth), Phase 0 authorization work (PR #2), specs/030 batches
> Branch: `feat/033-client-portal`

## Goal

A `client_viewer` account can sign in and see their own program — headline
visibility, what work was done, and published reports — without ever
touching another client's data or the agency's internals. Progressive
disclosure: executive numbers first, supporting detail second, raw
evidence via the existing artifact routes (already project-scoped since
Phase 0). This is v1 of the premium client surface: honest numbers over
polish, no new metrics, nothing the internal app doesn't already compute.

## The prerequisite this spec closes first

Cross-client staff pages (`/`, `/control-tower`, `/notifications`,
`/workflows`, `/agents`, `/companies`, `/exclusivity`, `/automation/*`,
`/onboarding`, `/projects` list) authenticate but do not check ROLE
server-side — a client login could read cross-client data (portfolio
names, costs, exceptions). Before any client account exists, every
cross-client page asserts staff and bounces client roles to `/portal`.
One helper (`requireStaffPage`), applied per page — pages are the unit
Next.js protects, and a helper call per page is greppable.

## Portal surface (v1)

- `/portal` — the client's landing: their granted projects (usually one);
  single grant redirects straight to it.
- `/portal/[projectId]` — Overview: subject + authority trend (existing
  chart data), headline metrics from the latest scored run (mention rate,
  recommendation rate, first-position rate) each with sample size ("x of
  n responses") — no unexplained numbers.
- `/portal/[projectId]/work` — proof of work: completed `client_visible`
  tasks (owner names withheld), published content assets, interventions
  with their shipped dates. Internal-only tasks and notes never appear.
- `/portal/[projectId]/reports` — published reports only; CSV downloads
  ride the existing project-scoped route.

Layout: portal pages render WITHOUT the internal sidebar (own minimal
shell with the client's project name); staff can view any portal page for
preview. Every portal page: `getCurrentUser` + `assertProjectAccess`
(denials 404 as established).

## Service layer

`lib/portal/service.ts` — read-only:
- `portalOverview(projectId)` — subject, latest scored-run headline
  metrics with sample sizes + scoring version, authority trend points.
- `portalWork(projectId)` — client_visible done tasks, published content,
  interventions (title, shipped date, verdict label where available).
- `portalReports(projectId)` — published reports only.

No mutations. Client roles get exactly these reads plus the existing
scoped artifact routes.

## Not built (v1, recorded)

- Branding/white-label, PDF, share links (roadmap 3.3 — next batch).
- Evidence drill-down inside the portal (exports cover it; portal links
  to report CSVs only).
- Client-facing campaign/exclusivity views.
- Client validator flows.

## Acceptance criteria

- [ ] client_viewer with a grant sees /portal/[id] overview, work,
      reports for that project; another project's portal 404s.
- [ ] Cross-client staff pages redirect client roles to /portal
      (server-side, not nav-hiding).
- [ ] portalWork returns only client_visible tasks — an internal task in
      the same project provably absent.
- [ ] Reports listing contains only published reports.
- [ ] Staff can view portal pages (preview).
- [ ] No mutation surface: portal pages import no actions.

## Test cases

Integration (`tests/integration/portal.test.ts`): service-level — work
filtering (internal task absent), published-only reports, overview sample
sizes present; access — client denied on non-granted project via
assertProjectAccess (already covered pattern, asserted here through the
service + page-gate helper); staff-gate helper unit-style checks.
