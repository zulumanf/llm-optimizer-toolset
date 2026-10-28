# Spec 152 — Performance pilot pricing

> **Status:** implemented (2026-10-28), not committed. Planned 2026-10-17. Build after the Medina meeting (2026-10-19) on `feat/152-performance-pilot-pricing`, off `main`. Deploy only with founder approval.
>
> **Audience:** internal operator (founder). Three outputs reach a prospect or client: the pricing reply lines, the private report's offer section, and the agreement artifact. All three change wording here.
>
> **Why:** founder decision 2026-10-17 — the current offer becomes **$1,000 to start, plus $4,000 only if an agreed, measurable target is reached**. The $7,500 / 90-day offer (`first_client_90d_v1`) is retired. The product assumes one fixed fee split into equal installments (spec 135, spec 140), so a fee that is owed only on a measured outcome cannot be represented today: quote defaults, signing defaults, `pricing_reply_v1`, invoice creation, payment status, run rate and the agreement template would all state or bill the wrong thing.

## Decisions (founder, 2026-10-17)

1. **Retire, never delete.** `first_client_90d_v1` gets `status: "retired"`, `effectiveTo: "2026-10-17"`. It stays in `PRICING_POLICIES` because presented quotes and any engagement reference it by version (same rule as `founder_monthly_7500_v0`).
2. **New active policy** `performance_fee_v1`:
   - Fixed fee **$1,000**, due at signing.
   - Performance fee **$4,000**, due only when the agreed target is recorded as met.
   - Term: **90 days** from the frozen baseline to the rerun (see open question 1).
   - Scope: one entity, one market (unchanged).
3. **Framing.** Customer-facing copy states the structure plainly: "most of the fee depends on a result we agree in advance". Never "discount", "founding", "introductory", "special" or "early-client price". (Open question 2: whether the word "pilot" may appear customer-facing; docs/15 currently forbids it.)
4. **The target is never automatic.** The performance fee becomes due only when the founder records the outcome against a frozen measurement snapshot. No code path decides "met" by itself, and no invoice for the performance fee exists before that record.

## Model changes (`lib/pricing/policy.ts`)

- `PricingPolicy` gains an optional `performanceFee`:
  ```ts
  performanceFee?: {
    usd: number;                 // 4_000
    dueDaysAfterOutcome: number; // e.g. 14
    condition: "agreed_target_met";
  };
  ```
  `totalFeeUsd` keeps meaning **the fixed, contracted fee** ($1,000). A new helper `maximumFeeUsd(p)` = fixed + performance, used only where a maximum must be shown, labelled as such.
- `validatePolicy`: installments × installment = **fixed** fee (unchanged invariant); `performanceFee.usd > 0` when present; never counted in installments.
- `billing` for the new policy: 1 installment, $1,000, `["at signing"]`, `[0]`, cadence `"upfront"`.
- `offerLabel` / `billingLabel` / `paymentTermsDefault` / `runRate` become structure-aware:
  - `offerLabel`: "$1,000 + $4,000 on target / 90 days".
  - `runRate`: counts contracted money only. The performance fee is excluded until met; the label never implies expected revenue.
- `pricingReplyLines` → new template **`pricing_reply_v2`** (docs/13), rendered from the policy, e.g.:
  > It's $1,000 to start, and $4,000 only if we hit a measurable target we agree on before we begin.
  > The target is measured by rerunning the same frozen set of ChatGPT questions after 90 days.
  > If the target isn't reached, the $4,000 isn't owed.
  `pricing_reply_v1` stays for the retired policies' history.
- `policyStatedIn` markers for the new policy: `"$1,000 to start"`, `"$4,000 only if"`.

## Data (one new migration, reversible)

> Numbering: production is at 118. 119–125 (Spec 147) and 126–134 (Spec 151, Platform v2) exist on unmerged branches. The number is assigned at build time, after whatever has merged; see open question 4. "Migration 126" below means "this spec's migration".

- `pricing_quotes`: **no schema change.** `total_fee_usd` = fixed fee; `billing_structure` (jsonb, already frozen by the spec 140 trigger) carries `performanceFee`. Presented quotes stay immutable.
- `client_engagements`: add
  - `performance_fee_usd numeric null check (>= 0)`
  - `performance_target jsonb null` — the frozen definition: metric (`recommendation_rate` primary, `question_coverage` secondary), threshold(s), prompt-set version id, provider + exact model, repetitions, scoring version, entity name variants, baseline snapshot id, agreed date.
  - `performance_outcome text not null default 'not_applicable' check in ('not_applicable','pending','met','not_met')`
  - `performance_outcome_snapshot_id` (the remeasurement snapshot the decision cites), `performance_outcome_by`, `performance_outcome_at`, `performance_outcome_note`.
  - Trigger: `performance_target` immutable once `performance_outcome` leaves `pending` **or** once work starts (`stage = 'active'`); outcome may move `pending → met | not_met` once, never back.
- `billing_events`: unchanged table. The performance invoice uses deterministic id `ENG-<id8>-P`.

## Behaviour changes

| Area | Change |
|---|---|
| Quotes (`lib/pricing/quotes.ts`) | `prepareQuote` under `performance_fee_v1` freezes fixed fee + `performanceFee` in `billing_structure`. Regeneration of unpresented drafts moves them to the new policy (existing rule). |
| Signing (`lib/engagements/service.ts`, `components/engagements/controls.tsx`) | Default terms come from the policy: total = $1,000, `performance_fee_usd` = 4,000, `performance_outcome = 'pending'`. `resolveEngagementPricing` compares fixed fee **and** performance fee; any difference needs a founder override reason (no silent discounting). |
| Target | New founder action `recordPerformanceTarget` (before activation; requires a frozen baseline snapshot). `markActive` refuses an engagement with `performance_outcome = 'pending'` and no target. |
| Outcome | New founder action `recordPerformanceOutcome({ engagementId, outcome, snapshotId, note })`. Requires a remeasurement snapshot taken with the same instrument as the target (prompt-set version, provider/model, repetitions, scoring version); refuses otherwise. Writes audit `engagement.performance_outcome_recorded`. |
| Invoices (`lib/engagements/commercial.ts`) | `createInvoiceSchedule` creates the fixed installment(s) only. `createPerformanceInvoice` exists only after `met`, idempotent (`ENG-<id8>-P`), due `outcome_at + dueDaysAfterOutcome`. |
| Payment state | Contract total = fixed fee while outcome is `pending`/`not_met`; fixed + performance after `met`. `PAID_IN_FULL` after the $1,000 while pending (no phantom $4,000 balance). Panel shows "Performance fee: pending target / not owed / due $4,000". |
| Activation gate | `commercialGate.activationPaymentCents` = the $1,000 fixed fee. |
| Agreement (`lib/engagements/agreement.ts`) | New template **`engagement_agreement_v2`**: fixed fee clause; performance fee clause citing the frozen target definition; measurement method (identical rerun, model version reported, model-change caveat); "if the target is not met, the performance fee is not owed"; no ranking or lead guarantees. Still `LEGAL_REVIEW_STATUS = NOT_REVIEWED`. v1 renders unchanged for old engagements. |
| Report offer section (`lib/prospects/audit-mismatch.ts`) | Reads `customerFacing` of the active policy; new copy shows the two-part fee. Frozen snapshots keep whatever they were published with. |
| Founder views (`commercial-panel.tsx`, `commercial-controls.tsx`, acquisition dashboard) | Show "$1,000 + $4,000 on target". Pipeline value = fixed fee; contingent value shown separately and labelled "not contracted". |
| Dry run (`scripts/commercial-dry-run.ts`) | Expect `performance_fee_v1`; cover pending → met → performance invoice → paid, and pending → not_met → no invoice. |

## Docs

- `docs/15-pricing-policy.md`: current offer section, reply lines, purchase path steps 1, 4, 7, 8 updated; `first_client_90d_v1` moved to history. (A pre-build version of this update landed 2026-10-17 so the runbook states the founder decision; it must be re-checked when this ships.)
- `docs/13-prompts.md`: add `pricing_reply_v2`, changelog row.
- `DECISIONS.md`: entry (landed 2026-10-17).

## Acceptance

- [ ] Exactly one active policy: `performance_fee_v1`. `first_client_90d_v1` retired with `effectiveTo = 2026-10-17`; both earlier policies still resolve by version.
- [ ] `assertQuotablePolicy("first_client_90d_v1")` refuses after 2026-10-17; a presented $7,500 quote still reads $7,500.
- [ ] `pricingReplyLines()` returns the v2 lines; no line mentions monthly billing.
- [ ] A new engagement defaults to $1,000 fixed, $4,000 performance, outcome `pending`; a different fixed or performance fee without a reason is refused.
- [ ] `createInvoiceSchedule` creates one $1,000 invoice; no performance invoice exists while `pending` or `not_met`.
- [ ] `paymentState` is `PAID_IN_FULL` after $1,000 while `pending`; becomes `PARTIALLY_PAID · $4,000 remaining` only after `met` and the performance invoice.
- [ ] `recordPerformanceOutcome` refuses a snapshot from a different prompt-set version, provider/model, repetition count or scoring version.
- [ ] The outcome can be recorded once; the target is immutable after activation; both enforced in the database.
- [ ] `engagement_agreement_v2` renders the performance clause from the frozen target; v1 agreements re-render byte-identical.
- [ ] Migration 126 up/down tested; fixtures never count in pricing analytics.
- [ ] Typecheck, lint, full test suite, `git diff --check` pass.

## Out of scope

- Payment or e-signature providers (still manual).
- Automatic decision of "met".
- Legal review of the agreement template.
- Changing any presented quote, frozen report snapshot or past engagement.

## Decisions 2026-10-28 (founder, answering the open questions)

1. Term: **90 days** from the frozen baseline to the rerun.
2. "Pilot" never appears in customer-facing copy (pricing reply, report offer, agreement). The internal version id is `performance_fee_v1` (renamed from `performance_pilot_v1` because the id rendered into customer-facing output).
3. The $1,000 covers in writing: the frozen baseline benchmark, the diagnosis and priority plan, and implementation of the highest-confidence first changes.
4. Migration number: **127** (`127_engagement_performance_fee.sql`; production is at 126).
5. Performance fee due **14 days** after the outcome is recorded as met.
6. Exclusivity (one retained client per market) applies during the engagement.
7. The target is agreed **per client** and frozen via `recordPerformanceTarget`; there is no standard target.

Order consequence: the agreement cites the target and the target needs a frozen baseline, so the baseline is frozen and the target recorded **after signing the engagement and before preparing the agreement**. `markActive` checks onboarding first, then the target.
