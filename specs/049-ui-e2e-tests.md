# Spec 049 — UI/E2E Test Layer

> Status: approved (operator request 2026-08-03: "add tests across the entire
> tool to test the ui/ux"). The 1,400-test suite stops at the service
> boundary; nothing verified that a page renders, a dialog submits, or a
> button does what its label says. This layer does.

## Architecture (the decisions, so they aren't re-litigated)

- **Playwright, chromium only, one worker.** The suite shares one seeded
  database; parallel mutation would make flows racy. Small suite, serial,
  deterministic.
- **Fully isolated runtime:** database `llm_optimizer_e2e`, port `3100`,
  build dir `.next-e2e` (via `NEXT_DIST_DIR` in next.config). A running dev
  server on :3000/.next is never touched — the shared-`.next` trap
  (run-app skill §1) is designed out, not documented around.
- **Seeded through the real pipeline.** Global setup resets the e2e DB,
  migrates, and drives the actual services with the mock provider: project →
  frozen prompt set → run → worker dispatch loop → parse → score; tasks,
  plan, intervention; prospect → benchmark link → findings → published
  audit. No hand-inserted UI fixtures — if the pipeline can't produce a
  state, the UI shouldn't be tested against it. Seed writes ids/token to
  `tests/e2e/.seed-state.json` for the specs.
- **`AUTH_MODE=dev`** — the operator experience. Role-based denial is
  covered by integration tests (portal isolation suite); E2E covers what a
  signed-in operator and an anonymous audit reader actually see.

## Coverage

| File | What it proves |
|---|---|
| smoke-portfolio | Every staff surface renders: Today, Work, Approvals, Clients, Prospects, control tower, workflows, automation, agents, companies, exclusivity, notifications, onboarding — one h1, no error boundary |
| project-sections | All 17 project sections render for a seeded client (incl. the new Activity page) |
| tasks-kanban | Approve → start → complete on a real task; done column updates; overdue task appears on /work |
| plan-items | "Start as task" activates a plan item; item tracks in_progress; the task exists on the board |
| prospect-detail | Detail sections render; copy-link present for the published audit; generate-draft dialog opens with the recipient select |
| audit-page | The prospect-facing page: hero, counted moments, scorecard tiles, counts labels, drawers open, appendix navigates, wrong token 404s, robots noindex |
| nav | Sidebar portfolio links navigate; project sidebar carries the reading order |

## Non-goals (deliberate)

- No visual-regression screenshots (churn > signal at this stage).
- No cross-browser matrix (internal tool; chromium is the operator reality).
- No client-role E2E until real Supabase sessions exist in a test rig —
  the SQL-level portal isolation tests remain the authority there.

## Acceptance

- [x] `npm run test:e2e` seeds, boots, and passes locally while a dev
      server is running on :3000 (isolation proven).
- [x] CI job runs the suite on every PR (own postgres service, chromium).
- [x] Vitest and Playwright never collide (separate include roots).
