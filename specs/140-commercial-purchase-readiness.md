# Spec 140 — First-client purchase readiness

**Status:** implemented 2026-09-11 · **Audience:** internal operator (founder). Nothing here is client- or prospect-visible; the agreement artifact is sent by the founder through the approved manual process.

## Why

If a qualified prospect says "send me the agreement", the founder must move them through offer → quote → agreement → payment → engagement → onboarding → active using the production system only — no code, no database edits, no invented scope or price, no guessing which market is reserved.

## What already existed (reused)

- **Pricing policy** (`lib/pricing/policy.ts`, spec 135): versioned in code; exactly one active (`first_client_90d_v1`: $7,500 total / 90 days / 3 × $2,500). Ryan Ogle's retired `founder_monthly_7500_v0` ($22,500) stays as history.
- **Quote ledger** (`pricing_quotes`, migration 108): quotes recorded from sent copy; outcomes recorded by the founder.
- **Engagement lifecycle** (spec 131): `client_engagements` (terms snapshot, contract state, stage), `billing_events` manual ledger, commercial gate, onboarding checklist, exclusivity reservation/activation with conflict detection, `markActive` prerequisites.
- **No payment provider, no e-signature provider** — none is built here.

## What this spec adds

1. **Money semantics** — `usdToCents`, `policyMoney`, `validatePolicy` (installments × amount = total, exact), `installmentSchedule` (day offsets 0/30/60), `runRate` (monthly equivalent; annualized figure labelled ANNUALIZED RUN RATE, never annual revenue).
2. **Quote lifecycle** — `prepareQuote` (draft under the active policy, idempotent per prospect), `markQuotePresented` (freeze), `regenerateDraftQuote` (unpresented drafts only), `recordQuoteOutcome` (presented quotes only). Migration 112: statuses `draft`/`superseded`, `presented_at`, `scope_version`, `superseded_by`, and a trigger that makes a presented quote's commercial fields immutable and forbids deletes.
3. **Agreement artifact** (`lib/engagements/agreement.ts`) — deterministic Markdown from the frozen quote/engagement terms under `engagement_agreement_v1`, stamped `LEGAL_REVIEW_STATUS = NOT_REVIEWED`; table `engagement_agreements` with `draft → sent → signed` (or void); sent/signed rows immutable by trigger; one live agreement per engagement; `recordAgreementSigned` sets the engagement's contract state in the same transaction. Provider party = the active `outreach_sender_identity` (Recommended First, Brooklyn NY).
4. **Quote-bound, idempotent engagement creation** — `signClient` accepts `quoteId`; terms come from the frozen quote (a field that restates them must match); a retry returns the existing live engagement instead of creating a second client record, engagement, territory hold or invoice schedule; the quote becomes `accepted` and links to the engagement (`client_engagements.quote_id`, unique).
5. **Payment path** — `createInvoiceSchedule` (3 `invoice_created` events with deterministic ids `ENG-<id8>-n`, idempotent), `recordInstallmentPayment` (payment against the same id; duplicates collapse via the existing unique index), `paymentState` (UNPAID / PARTIALLY_PAID / PAID_IN_FULL / OVERDUE, balance in cents). **Activation payment = first installment in full** (`commercialGate.activationPaymentCents`).
6. **Onboarding intake** (`lib/engagements/onboarding-intake.ts`) — prefilled from prospect/company/contact; required: legal name, brand, primary contact, email, website, market definition, ≥1 priority, website control; writes canonical rows (engagement legal name/contact, market definition, context items) and starts no work.
7. **Founder commercial view** — `CommercialPanel` on the prospect page and the engagement page: stage, offer, quote, agreement, payment (paid / remaining), market, exclusivity conflict, onboarding, engagement, next action, plus the stage's low-friction actions (`app/commercial/actions.ts`).

## Acceptance (verified by tests)

- Unit: `tests/unit/commercial-readiness.test.ts` (policy money, schedule, Ryan history, payment semantics, stage derivation, agreement content, intake, report offer binding).
- Integration: `tests/integration/commercial-dry-run.test.ts` (synthetic prospect end to end + negatives: duplicate activation, duplicate invoices/payments, exclusivity conflict, unsigned agreement, unpaid activation, presented-quote immutability, v0 quote unchanged, fixture excluded from metrics, no sends).
- Production smoke: `scripts/commercial-dry-run.ts` (isolated QA131 fixture market; Ryan's quote hashed before/after; fixtures closed and archived).

## Out of scope (deliberately)

Payment provider, e-signature provider, CRM, tax, accounting, revenue recognition, subscription billing, client portal expansion, reserved-market registry (none exists in code; NYC is not touched).
