# Spec 057 — Prospect → Client Promotion

**Status:** In progress
**Branch:** `feat/057-prospect-promotion`
**Source:** Architecture gap audit 2026-08-09 (growth 12.1–12.3 P0, cost B5): `contracted` is a terminal stage label with **zero side effects** — no project creation, no exclusivity agreement, no baseline continuity. The prospect's benchmark project (its captures, classified mentions, scores, competitor set) is orphaned at close, and the new client pays twice for research the platform already did.

## Why

The close is the one moment where the growth engine hands off to the delivery engine, and today nothing crosses the gap. Worse than the duplicated spend: the pre-signing benchmark is the client's true baseline — same prompts, same instrument — and abandoning it means the first client report has no comparable prior, when the entire measurement discipline is built on comparable pairs.

## Design

**`promoteProspectToClient(user, {prospectId, createAgreement?, agreementEndsOn?, gracePeriodDays?})`** — an explicit, audited action available once the prospect is `contracted` (never a hidden side effect of a stage click; creating a client is a deliberate act):

1. **Preconditions:** stage is `contracted`; prospect is linked to a canonical company; not already promoted (`prospects.promoted_project_id`, migration 066).
2. **Baseline continuity — convert, don't copy.** When a benchmark project exists, its `kind` flips `prospect → client` and it is renamed to the business name (on a name collision the existing name stays, noted in the audit detail). Every capture, mention, score, run, and tracked competitor stays attached: the pre-signing benchmark becomes the client's first baseline, and the first client report gets a comparable prior for free — the reports/movement comparability rules (same frozen prompt-set version + scoring version) work unchanged. When no benchmark project exists (linked-run path), a fresh client project is created with the subject set.
3. **Territory at close.** Unless declined, an **active** exclusivity agreement is created on the promoted project, scoped to the launch's market + service category + segment, starting today — the audit's "signing creates no agreement" hole. (A pre-existing `reserved` hold for this territory, if any, should be terminated by the operator via the existing exclusivity surface; reserved holds predate a client project and cannot be re-parented.)
4. **The record:** `prospects.promoted_project_id` set; prospect activity + audit rows; the promoted project appears on client/portfolio surfaces by the existing `kind='client'` filters, and its subject gains the client no-cross-talk protection automatically.

Onboarding intake (vertical pack claims, prompt-universe review, kickoff) continues on the existing onboarding surfaces against the promoted project — promotion moves the *measurement and territory*, not the paperwork.

## Scope
- Migration 066: `prospects.promoted_project_id uuid references projects(id)` + index.
- `promoteProspectToClient` in `lib/prospects/service.ts`; server action; a promote button on the prospect page visible at `contracted` when unpromoted.

## Out of scope
- Re-running `onboardClient` against an existing project (it creates its own project by design; adapting it is a separate refactor).
- Auto-terminating reserved territory holds (they are not project-parented pre-close; operator action via the existing surface).
- Prospect-audit unpublishing at close — the published audit follows its own expiry/revoke lifecycle.

## Acceptance criteria
- [ ] Promotion flips the benchmark project to `kind='client'`, renames it, keeps all runs/scores/competitors attached, and the project appears in active-client listings (test).
- [ ] An active exclusivity agreement scoped to the launch market is created; `createAgreement: false` skips it (test).
- [ ] `promoted_project_id` set; audit + activity rows written; re-promotion refuses; wrong stage refuses; unlinked prospect refuses (tests).
- [ ] No-benchmark prospects get a fresh client project with the subject set (test).
- [ ] A project-name collision keeps the benchmark name and records that in the audit detail (test).
- [ ] Migration 066 reversible; `npm test`, lint, typecheck green.
