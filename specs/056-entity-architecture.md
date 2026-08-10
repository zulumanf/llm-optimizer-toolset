# Spec 056 — Entity Architecture: Relationships, Market Scoping, Merge

**Status:** In progress
**Branch:** `feat/056-entity-architecture`
**Source:** Architecture gap audit 2026-08-09 (entity §10): the rich `knowledge_entities` relationship model — types, effective dates, evidence, approval states — **has no write path anywhere in the codebase** (P0); the `companies` registry that actually carries every mention, score, and report has a *global* unique-name index, so two real "Smith Group"s in different cities are structurally unrepresentable (P1); and there is no merge/split/unmerge operation on it at all (P1).

## Why

Real estate is teams inside brokerages, agents inside teams, and same-named firms in different cities. The platform has the schema for all of that (`entity_relationships` with `effective_from/until`, evidence, proposed→approved review) and a rollup that reads it (`relationshipGroups` on the competitors page) — but no code can create a relationship, so the rollup returns `[]` in every real deployment. Meanwhile the flat `companies` registry can't hold two same-named firms and can't recover from a wrong entity: the duplicate-minting the resolver work (spec 050) prevents going forward has no repair path for rows that already exist.

## Scope

### A. Relationship write path (the inert P0 schema becomes usable)
- `proposeRelationship(user, {projectId?, fromCompanyId, toCompanyId, relationshipType, effectiveFrom?, effectiveUntil?, note?})` in `lib/knowledge/entities/service.ts`: bridges each company to its `knowledge_entities` row (creating a typed entity via the existing `upsertEntity` when none exists — team/brokerage type from the relationship direction), then inserts a `proposed` relationship. Company-first because companies are what operators actually see and what the rollup joins on.
- `reviewRelationship(user, {relationshipId, decision})`: human approval per the model's own design (`approved_by` stamped, audited). Rejection keeps the row as history.
- `endRelationship(user, {relationshipId, effectiveUntil})`: a brokerage move is an end date plus a new proposal — never an edit that erases history.
- `listRelationshipsForProject(projectId)`: approved + proposed, both endpoints named, for the UI.
- Competitors page: the existing (always-empty) groups rollup gains a "Link entities" dialog — pick child company, parent company, type (`works_for` | `brokerage` | `affiliated_with`), optional effective dates — and a pending-proposals list with approve/reject. The rollup starts working the day a relationship is approved.

### B. Market-scoped company names (migration 065)
- `companies.market_id uuid references markets(id)` (nullable — existing rows stay global). The global unique index becomes market-scoped: one active name per market, plus one in the global (null) bucket. Two "Smith Group"s can now coexist in Miami and Austin.
- `upsertCompany` accepts optional `marketId`; the alias false-merge check scopes the same way (a name may not collide with an active company **in the same bucket**). Cross-market same-name candidates reach the prospect resolver as a tie → `possible` → human — exactly the spec-050 contract.

### C. Company merge — non-destructive, guarded, reversible (migration 065)
- `companies.merged_into uuid references companies(id)`.
- `mergeCompanies(admin, {fromId, intoId, reason})`: moves `from`'s name + aliases into `into`'s aliases (future parsing credits the survivor), archives `from` with `merged_into` set, repoints `prospects.company_id`, and re-tracks `from`'s competitor rows to `into` where not already tracked. Immutable history (mentions/scores) stays on `from` — those measurements were of the entity as then understood; rewriting them would be fabrication. Refusals: self/cycle, either side already merged, both sides being client subjects (merging two clients is catastrophic), missing reason. Audited with the exact alias set moved.
- `unmergeCompany(admin, {companyId, reason})`: restores the row (clears `merged_into`/`archived_at`) and moves back exactly the aliases the merge audit row recorded — reversible because nothing was destroyed.
- `resolveCompanyId(id)`: follows merge chains for read surfaces that want current identity.

## Out of scope
- Rewriting historical mentions/scores onto the merge survivor — immutable by principle; continuity breaks at a merge and reports say so via sample sizes.
- Team-member (person) rosters and per-member production rollups — needs person entities as first-class citizens; later spec.
- Automatic relationship inference from crawled sources — proposals stay human-created or (later) extraction-proposed; approval stays human either way.

## Acceptance criteria
- [ ] Propose → approve a `brokerage` relationship between two tracked companies; `relationshipGroups` returns the group with live metrics (test — the P0 rollup returns non-empty for the first time).
- [ ] Effective dating: ending a relationship and proposing a successor keeps both rows; only the approved, current one groups (test).
- [ ] Rejection keeps history; approval stamps `approved_by`; both audited (test).
- [ ] Two active companies with the same name coexist in different markets; same-bucket duplicates still refuse (test).
- [ ] The prospect resolver surfaces cross-market same-name candidates as `possible`, never auto-match (test).
- [ ] Merge: aliases move, prospects repoint, competitors re-track, history stays on the merged row, chain resolver follows; refusals for self/cycle/double-merge/two-subjects (tests).
- [ ] Unmerge restores the row and the exact moved aliases (test).
- [ ] Migration 065 reversible; `npm test`, lint, typecheck green.
