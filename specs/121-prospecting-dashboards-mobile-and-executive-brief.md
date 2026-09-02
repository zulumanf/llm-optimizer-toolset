# Spec 121 — Prospecting dashboards: phone parity + executive brief

> Status: done
> Depends on: specs/083 (mobile workspace), specs/098 (cockpit), specs/100 (cockpit hierarchy), specs/119 (momentum), docs/04
> Branch: feat/121-dashboards-mobile-brief (stacked on feat/119-momentum-scoreboard)

## Goal

The two prospecting dashboards — `/prospects` (launches + pipeline index) and
`/prospects/dashboard` (the cockpit) — render phone-width with no horizontal
page scroll, fenced by the same 390px e2e test that protects the rest of the
workspace. On top of the cockpit's data the operator gets an **executive
brief**: a deterministic, evidence-backed synthesis — one headline, the top
three actions with links, and grouped observations — computed from the same
derivations the page already loads. No LLM, no new queries, versioned like
every other interpretation in this repo.

## User stories

- As an operator on my phone, I can open both prospecting dashboards and read
  every section without sideways page scrolling (wide tables still scroll
  inside their own container, per spec 083's "tables stay tables" policy).
- As an operator, I can read one short brief at the top of the cockpit that
  says what is going on and what to do next, with every claim carrying its
  evidence numbers, so I don't have to re-derive the story from eight sections.

## UI

### Mobile fixes (no visual change at desktop width)

1. `PageHeader` / `Section` actions container (`components/layout/page.tsx`):
   `flex shrink-0 items-center gap-2` → `flex min-w-0 flex-wrap items-center
   gap-2`. The `/prospects` header stacks 7 controls in this slot; `shrink-0`
   with no wrap forces ~700px of buttons onto one line at 390px. Fixing the
   primitive fixes every page at once.
2. Cockpit full-funnel rows (`app/prospects/dashboard/page.tsx`): the row
   `w-40` label + bar + `w-10` + `w-24` leaves the bar ~40px at 390px. New
   layout: at phone width the label/count/rate share the first line and the
   bar takes a full-width second line; at `sm:` the current one-line layout
   is restored via flex order utilities. No fixed column may lack a
   breakpoint.
3. Cockpit cohort dropdown menu: `absolute right-0 … min-w-56` anchors the
   224px menu to the summary's right edge; after the header wraps at phone
   width the summary sits at the left edge and the menu extends off-canvas
   left. Anchor `left-0` below `sm`, `right-0` at `sm:` and up.
4. e2e fence: add `/prospects/dashboard` and `/prospects/dashboard?view=analyze`
   to `SURFACES` in `tests/e2e/mobile.spec.ts`.

### Executive brief (cockpit, Operate view only)

Rendered as a `Section` titled "Executive brief" directly after the today
strip, before Momentum. Headline and the top-3 action list are always
visible; observations expand from a `<details>`.

```
Executive brief
What the data says and what to do next — computed from the ledger, no AI.

  2 replies are waiting — conversations are the constraint, not volume.

  1. Answer 2 replies — fastest path to meetings.        [open filtered →]
  2. Send 4 more today to keep the 6-day streak.         [open filtered →]
  3. Approve 3 waiting drafts so the worker can send.

  ▸ observations (5)
     ✓ Quota streak at 6 business days (30-day chart above).
     ✓ 41% of contacted viewed their audit (13/32).
     ⚠ 5 prospects stalled at one touch with a follow-up due.
     ⚠ Possible bottleneck: commercial conversion — strong engagement,
       few replies (evidence: 8 engaged, 1 reply). Review: urgency, …
     ⚠ 2 audits expire within 7 days.

  Early sample — directional only, do not re-plan from these numbers.   (only when the diagnose gate says so)
```

Empty state: with zero prospects in the cohort the brief renders a single
line ("No prospects in this cohort yet — import or discover to begin.") and
no actions. Loading/error states are the page's existing ones (single load,
`EmptyState` on failure).

## Database changes

None. Read-only synthesis over data already loaded by the page.

## API (server actions / routes)

None. New pure module `lib/prospects/brief.ts`:

- `BRIEF_VERSION = "prospecting-brief-v1"` — stamped on the output like
  `DIAGNOSIS_VERSION` / score-feedback.
- `executiveBrief(facts: BriefFacts): ExecutiveBrief` — pure, deterministic.
- `BriefFacts` is a flat input struct the page assembles from values it
  already computes (cohort summary incl. diagnosis, replies/meetings waiting,
  manual-ready, approvals, blocked sends, follow-ups eligible in 24h,
  unresolved attribution, expiring audits, research queue, gmail health, cap
  usage, suppressions, sends today vs quota, quota streak, stalled-at-one,
  `businessDay` flag). No I/O inside the module.
- `ExecutiveBrief = { version, headline, actions: BriefAction[≤3],
  observations: BriefObservation[], epilogue: string | null }`.
- `BriefAction = { text, evidence, target }` where `target` is
  `{ kind: "filter", patch: Partial<DashboardFilters> } | { kind: "none" }` —
  the page maps targets to hrefs so the module stays URL-agnostic.
- `BriefObservation = { tone: "good" | "watch" | "bad", text, evidence }`.

Rendering component `components/prospects/executive-brief.tsx` (server
component, layout primitives only).

## Validation rules

- Headline priority order (first match wins): transport blocked → replies or
  meetings waiting → today's quota unmet on a business day → follow-up debt
  (eligible-24h or stalled-at-one) → diagnosis bottleneck → healthy/keep-going.
- Action ranking (take first 3): reconnect Gmail → answer replies → prepare
  meetings → approve drafts → send remaining quota (business days only) →
  draft eligible follow-ups → resolve attribution → act on bottleneck review
  list → research contacts.
- Every observation and action carries evidence numbers taken verbatim from
  the facts; no rates are stated on denominators of 0.
- The early-sample epilogue appears exactly when `diagnosis.verdict ===
  "not_enough_data"`; bottleneck observations only otherwise — same gate as
  `diagnose()` (no second sample-size policy).
- Language stays possibility-based ("possible bottleneck"), never causal —
  same discipline as spec 100.

## Edge cases

- Zero prospects in cohort → single-line brief, no actions, no epilogue.
- Gmail blocked → it is both the headline and action #1 (with the CLI
  command); remaining slots still fill with the next-ranked actions.
- Weekend (`businessDay: false`) → the quota-gap action and "quota unmet"
  headline are suppressed; streak observation still shows.
- Quota already met → quota action suppressed; "keep going" is not padded in
  — fewer than 3 actions is fine.
- `view=analyze` → no brief (momentum isn't loaded there; the Analyze view is
  its own reading surface).
- All-cohorts zoom-out → brief covers the zoomed-out numbers, cohort name in
  the headline evidence where relevant.

## Acceptance criteria

- [x] At 390px, `/prospects`, `/prospects/dashboard`, and
      `/prospects/dashboard?view=analyze` render with `scrollWidth -
      clientWidth ≤ 1` (e2e).
- [x] `PageHeader`/`Section` action slots wrap at phone width; desktop layout
      unchanged.
- [x] The full-funnel rows show a full-width bar on phone and the current
      single-line layout at `sm:`.
- [x] The cohort dropdown menu opens fully on-canvas at 390px.
- [x] Operate view shows the brief with headline, ≤3 actions (filter targets
      resolve to real dashboard hrefs), observations, and the early-sample
      epilogue exactly per the diagnose gate.
- [x] `executiveBrief` is pure and covered by known-answer unit tests for:
      blocked transport, replies waiting, quota gap on business day vs
      weekend, early sample, healthy cohort, zero prospects.
- [x] Lint, typecheck, and the unit suite pass.

## Test cases

- Unit (`tests/unit/brief.test.ts`): fixtures per acceptance list above —
  assert headline choice, action order/truncation at 3, evidence strings
  contain the fixture numbers, epilogue gating, zero-denominator safety.
- E2E (`tests/e2e/mobile.spec.ts`): the two new dashboard surfaces in
  `SURFACES`.

## Definition of done

All acceptance criteria pass · tests green · `npm run lint` and
`npm run typecheck` clean · DECISIONS.md entry for the deterministic-brief
choice · demoed against seeded data.
