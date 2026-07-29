# Spec 016 — Program Reporting: Cadences, Category Ownership, Whole-Platform Snapshots

> Status: done (2026-07-29)
>
> **Live: a real weekly pulse for Parva was generated AND published through
> the evidence gate.** It leads with the three high-severity entity-confusion
> findings (each cited `[accuracy:…]`), then the top gaps (`[finding:…]`),
> then standing metrics — and the category-ownership table reads:
> recommendation *absent* (0 of 3, Linktree leads), comparison *emerging*
> (1 of 2), problem/how-to/branded *absent*.
>
> Two drafter bugs the gate caught on real data (both fixed):
> 1. Gap-finding text ending in a period split the sentence, orphaning its
>    numbers from the `[finding:…]` citation.
> 2. **Pre-existing since spec 006**: an excerpt that was literally "2."
>    did the same to `notable_responses` — latent for three specs, exposed
>    the first time real captures flowed through.
> Fix: an `inline()` sanitiser for every interpolated stored string. This is
> the evidence gate earning its keep — it refused to publish rather than
> ship a client report with uncited numbers.
>
> Also fixed: the migration-reversibility test now carries an explicit
> timeout (13 migrations × a tsx process each exceeded the 5s default; the
> cycle itself verifies clean in ~5.3s).
> Depends on: specs/006 (reports) · 007 (interventions) · 009 (gaps) ·
> 010 (content) · 015 (accuracy) · docs/06 · docs/15
> Branch: feat/016-program-reporting
> Priority: **P1** — Executive Advisory scored 44/100; the audit found the
> report engine stuck at spec 006's data model.

## Problem
`ReportBody` (lib/reports/types.ts) contains scores, deltas, excerpts, and
coverage — and nothing else. Everything built since spec 006 is invisible
to reports: gap findings, accuracy findings, interventions and their
verdicts, completed tasks, published content. A client report today
therefore describes measurement but not *the program*, and there is exactly
one report shape (no weekly/monthly distinction).

## Goal
Reports that reflect the whole platform, in cadence-appropriate form, with
the evidence discipline intact: **every number still traceable to a stored
row.**

## 1. Cadences (`reports.kind`)
| Kind | Question it answers | Emphasis |
|---|---|---|
| `weekly_pulse` | "What changed and what needs me?" | Change-only: new high-severity accuracy findings, new gap findings, verdicts that landed, work completed, approvals waiting. Suppresses unchanged metrics. |
| `monthly` | "How are we doing?" | Full picture: scores + deltas, category ownership, competitor movement, accuracy summary, program work, next actions. |
| `quarterly` | "Is this worth continuing?" | Monthly plus longer-window trend and intervention outcomes. (v1: same body, longer default period + trend section — full QBR synthesis stays P4.) |

Default period per kind: weekly = 7 days, monthly = 28, quarterly = 91.

## 2. Whole-platform snapshot (`ReportBody.program`)
Added, all self-contained and id-bearing so citations resolve:
- `gapFindings`: open findings in-period (id, type, finding, opportunityScore)
- `accuracyFindings`: in-period findings (id, kind, severity, quote, status)
- `interventions`: shipped in-period + those whose measurement windows
  produced verdicts in-period (id, title, shippedAt, verdicts summary)
- `tasksCompleted`: done in-period (id, title, priority)
- `contentPublished`: assets published in-period (id, title, url)

## 3. Category-ownership map (`ReportBody.categoryOwnership`)
Composed from data that already exists — no new modeling (the audit called
this "a view, not a feature"): for each prompt category, the subject's
mention/recommendation rate and per-prompt stability roll up to a label:
- `owned` — recommended in ≥50% of the category's observations
- `emerging` — mentioned in ≥25% but recommendation below owned
- `contested` — mentioned below 25% while a competitor leads
- `absent` — no mentions
Each row carries numerator/denominator (never a bare label) and the
leading competitor for context.

## 4. Evidence gate extension
Citation tokens gain `[finding:<id>]` and `[accuracy:<id>]` alongside
`[score:…]` / `[response:…]`, resolving against the new snapshot pools.
Rule is unchanged and still absolute: **a sentence containing a number
must carry a resolvable citation**, or publish fails.

## 5. Out of scope (named)
LLM narrative synthesis (a `report-drafter-llm-v2` version bump — the
deterministic drafter stays the default until then), scheduled delivery and
PDF (no notification primitive yet — audit shared gap), what-if scenarios
and budget allocation (P4), and revenue sections (product 4 deferred by the
operator).

## Acceptance criteria
- [ ] `kind` selectable at generation; each cadence produces its own
      section set and default period.
- [ ] A weekly pulse omits unchanged metrics and leads with new
      high-severity accuracy findings and landed verdicts.
- [ ] Report bodies include gap/accuracy/intervention/task/content data for
      the period, self-contained (renaming a company later changes nothing).
- [ ] Category-ownership rows show label + numerator/denominator + leader.
- [ ] Narrative sentences citing finding/accuracy counts validate with the
      new token kinds; uncited numerics still block publish.
- [ ] Published reports remain immutable; CSV export still works.
- [ ] Tests cover cadence bodies, ownership labels, the extended gate, and
      period filtering; lint/typecheck/tests green.
