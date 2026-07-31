# Spec 028 — Market Exclusivity & Conflict Engine

> Status: done (2026-07-31) — dev-DB apply blocked by an orphan migration; see DECISIONS.md
> Depends on: specs/014 (auth & roles), docs/17 (agency operations), docs/target-gap-analysis.md row 3
> Branch: `feat/028-market-exclusivity`

## Goal

The agency sells exclusive representation within defined markets ("we will
not take your competitor in Manhattan luxury residential"). Today that
promise is tracked nowhere — the 2026-07-31 audit found no table, column, or
code path modeling exclusivity, agreements, or client-vs-client conflicts.
When this spec is done, exclusivity agreements are stored with structural
market scopes and dates, and a prospect can be checked against every active
agreement with an explained verdict (direct / partial / possible / clear),
an authorized override path, and a full audit trail.

Conflict detection must be structural, not string matching: "Manhattan"
must conflict with "NYC" because Manhattan is *inside* NYC, not because the
strings resemble each other.

## Non-goals (this pass)

- Geocoding, polygons, or map UI — geography is an explicit containment
  tree maintained by operators.
- Linking exclusivity markets to vertical-pack prompt variables (recorded
  follow-up; the string market names in packs stay independent for now).
- Contract documents/billing — `notes` carries the reference.
- Automatic prospect intake — checks are run by staff from a form.

## Domain model

**Market** — a node in a containment tree. `NYC (city) → Manhattan
(borough) → Tribeca (neighborhood)`. Markets are global (geography is not
tenant data); aliases catch naming variants ("New York City", "NYC").

**Exclusivity agreement** — held by a client (project), with `starts_on`,
optional `ends_on`, and `grace_period_days` that extends protection past
termination. One agreement carries one or more **scopes**.

**Scope** — the protected tuple: market × service category × segment.
`service_category` null means "all services in this market"; `segment`
null means "all segments". Example: (Manhattan, residential_sales, luxury).

**Conflict check** — an append-only record of asking "would signing this
prospect violate any active agreement?" including the full result, and —
when a conflict was overridden — the override rationale and who decided.

## Conflict semantics

Given a prospect scope P and each scope S of every agreement active at
check time (active = today ∈ [starts_on, effective_end] where
effective_end = coalesce(terminated_at, ends_on) + grace_period_days;
open-ended when ends_on is null and not terminated):

Geography relation between P.market and S.market via the tree:
- `same` — identical market
- `inside` — P.market is a descendant of S.market (protected scope covers
  the prospect's whole geography)
- `contains` — P.market is an ancestor of S.market (prospect wants a
  geography that includes a protected sub-market)
- `sibling` — distinct, but share a parent at any depth ≤ 2 levels up
- `unrelated` — none of the above

Dimension overlap for category and segment: overlapping iff equal, or
either side is null (null = "all").

Verdict per (P, S) pair — first match wins:
- **direct** — geography `same` or `inside`, AND category overlaps AND
  segment overlaps. Signing P would operate inside protected territory.
- **partial** — geography `contains` with category and segment overlap
  (the prospect's broader market includes a protected pocket), OR
  geography `same`/`inside` with exactly one dimension non-overlapping
  ("same market, different segment" is still a conversation).
- **possible** — geography `sibling` with category and segment overlap
  (adjacent territory, same business — flag for judgment).
- **clear** — everything else.

An agreement past `ends_on` but within grace contributes its verdict with
`gracePeriod: true` — shown distinctly, because the obligation is
contractual tail, not active representation.

Every non-clear verdict carries a human-readable `reason` naming the
protected client, the scopes involved, and the relation that triggered it.
A verdict the operator cannot decompose is not a verdict we show.

## Database changes (migration 032)

- `markets` — id, name, kind CHECK (city|borough|neighborhood|region|
  custom), parent_id self-FK nullable, aliases text[], created_by,
  created_at. Unique (lower(name), coalesce(parent_id, zero-uuid)) —
  the same name may exist under different parents ("Chelsea" NYC vs
  London), never twice under one parent.
- `exclusivity_agreements` — id, project_id FK projects, status CHECK
  (active|terminated), starts_on date, ends_on date nullable,
  grace_period_days int default 0 CHECK ≥ 0, terminated_at date nullable,
  notes text, created_by, created_at, updated_at. CHECK ends_on is null or
  ends_on >= starts_on.
- `exclusivity_scopes` — id, agreement_id FK, market_id FK markets,
  service_category text nullable, segment text nullable, notes text.
  Unique (agreement_id, market_id, coalesce(service_category,''),
  coalesce(segment,'')).
- `exclusivity_checks` — append-only (forbid_mutation trigger):
  id, prospect_name, market_id FK, service_category nullable, segment
  nullable, result jsonb (the full verdict list), worst_verdict CHECK
  (direct|partial|possible|clear), decision CHECK (blocked|override|clear)
  , override_rationale text (CHECK required when decision='override'),
  checked_by, checked_at.

Rollback: drop all four (checks first). No existing tables touched.

## API (server actions, all staff-gated; service in `lib/exclusivity/`)

- `createMarket(user, {name, kind, parentId?, aliases?})` — assertCanWrite;
  audit `market.create`.
- `createAgreement(user, {projectId, startsOn, endsOn?, gracePeriodDays?,
  notes?, scopes: [{marketId, serviceCategory?, segment?}] min 1})` —
  assertCanWrite + assertProjectAccess; one transaction; audit
  `exclusivity.agreement_create`.
- `terminateAgreement(user, {agreementId, terminatedAt})` — admin only
  (ends a contractual protection); audit.
- `checkProspect(user, {prospectName, marketId, serviceCategory?,
  segment?, decision?, overrideRationale?})` — assertCanWrite; runs
  detection, persists the check. `decision: "override"` requires admin +
  non-empty rationale; a check with worst_verdict `clear` records
  decision `clear` automatically. Audit `exclusivity.check`.
- Reads: `listMarkets()`, `listAgreements()`, `listChecks(limit)` — staff.

Detection itself is a pure function `detectConflicts(prospect, agreements,
markets)` in `lib/exclusivity/detect.ts` — no I/O, unit-testable, with a
version constant `CONFLICT_DETECTOR_VERSION` stored in each check result.

## UI — `/exclusivity` (staff-only, sidebar top level)

Three sections on one page (house shell, cards + tables):
1. **Check a prospect** — form (name, market select, category, segment) →
   verdict panel listing every non-clear conflict with its reason;
   override affordance (admin) requiring a rationale.
2. **Agreements** — table: client, scopes summary, dates, grace,
  status (active / in grace / ended). Create dialog.
3. **Recent checks** — append-only log with verdicts and decisions.

Empty states for all three; errors via the house ActionResult pattern.

## Edge cases (decided)

- Prospect market not in the tree → the check refuses (validation error:
  "add the market first") rather than silently reporting clear.
- Two agreements protecting the same scope for different clients — legal
  to store (history, grace overlap); both surface in checks.
- Terminated agreement within grace → verdicts flagged `gracePeriod: true`.
- Market cycle (A parent of B parent of A) — createMarket refuses a
  parentId that is a descendant of the node (walk capped at depth 20).
- Checking a market equal to a protected market's ancestor at distance >1
  (Tribeca protected, prospect wants NYC) → still `partial` via
  `contains` — depth does not dilute containment.
- Sibling relation is capped at 2 shared-ancestor levels so "both are in
  the USA" never manufactures a `possible`.

## Acceptance criteria

- [ ] Manhattan-luxury prospect vs Manhattan-luxury agreement → direct.
- [ ] Tribeca prospect vs Manhattan agreement (Tribeca ⊂ Manhattan) → direct.
- [ ] NYC prospect vs Manhattan agreement → partial (contains).
- [ ] Manhattan-rentals vs Manhattan-luxury-sales → partial (same market,
      non-overlapping category).
- [ ] Brooklyn vs Manhattan (siblings under NYC, same category/segment) →
      possible.
- [ ] Miami vs Manhattan → clear.
- [ ] Agreement ended yesterday with 90-day grace → conflict with
      gracePeriod flag; ended past grace → clear.
- [ ] Override requires admin + rationale; recorded immutably; audit row.
- [ ] Checks table rejects UPDATE/DELETE (trigger).
- [ ] client_viewer cannot create/check (read-only denial); non-granted
      staff N/A (staff see all — exclusivity is agency-level data).
- [ ] Migration applies and rolls back.

## Test cases

Unit (`tests/unit/exclusivity-detect.test.ts`): every acceptance verdict
above as a fixture against the pure detector; grace boundary (end+grace
day exactly); cycle refusal logic. Integration
(`tests/integration/exclusivity.test.ts`): agreement create/terminate,
check persistence + immutability, override authorization, audit rows.

## Definition of done

All acceptance criteria pass · tests green · lint/typecheck clean ·
migration up+down verified · DECISIONS.md entry · this spec updated to
done with any "Not built" honesty section.
