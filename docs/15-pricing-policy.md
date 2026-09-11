# Pricing policy — operator runbook (spec 135)

Source of truth: `lib/pricing/policy.ts` (versioned in git). Nothing else in the
OS states a price. Read this before any commercial conversation.

## Current offer — `first_client_90d_v1` (ACTIVE from 2026-09-07)

| | |
|---|---|
| Offer | **90-Day Market Implementation Engagement** |
| Price | **$7,500 for the 90-day engagement** |
| Billing | $2,500 × 3 — at signing, day 30, day 60 (manual invoices; one engagement, not three cancellable months) |
| Scope | one client entity/team · one founder-confirmed defined market · one engagement scope |
| Exclusivity | one retained Recommended First client in that market **during the paid engagement** — never after the term |
| Who gets it | the first three real paying clients, by default, regardless of production, market size or how eager they sound |
| Internal framing | early-stage validation pricing: proof + delivery learning + case studies + willingness-to-pay learning. **Never** say discount, founding, pilot, beta, introductory or special to a prospect. It is simply the current offer. |

What it includes (say this, not more): baseline benchmark with every answer saved
and entity reconciliation · diagnosis and a priority work plan · implementation
of the highest-confidence owned-site, entity/profile and technical changes ·
monitoring of changes and competitors · the comparable rerun with before/after
and limitations · client progress and the 90-day review · exclusivity above.
Never promise rankings, leads or transactions.

## When asked "what does it cost?" — `pricing_reply_v1`

> The 90-day engagement is $7,500.
> That includes the baseline, implementation of the highest-confidence changes, monitoring, and the comparable rerun at the end.
> We bill it as $2,500 per month over the 90 days.

Lead with the total. Add the billing line only when useful. No essay, no anchor,
no urgency. Pricing goes only to a prospect who asked or showed explicit
commercial interest — never in T1/T2/T3 or a correction.

## When a prospect says "send me the agreement" — spec 140 path

All on the prospect page → **Commercial state** (and the same panel on the
client's Engagement page). The OS never sends, signs or charges; you do those
through the approved manual channel and record them here. Every step is
idempotent — a retry never duplicates a quote, engagement, hold or invoice.

1. **Prepare quote** — draft under the active policy ($7,500 / 90 days / $2,500 × 3).
2. Send the price yourself (`pricing_reply_v1` lines are in the dialog) → **Mark presented**. From here the quote's terms are frozen by the database.
3. **Record response** (accepted / declined + objection) — or go straight to step 4 on a yes.
4. **Record signed engagement from quote** — terms come from the quote; creates the client project, the commercial record and the territory hold. Quote → `accepted`.
5. **Confirm market definition** (boundary in words) → **Prepare agreement** — `engagement_agreement_v1`, `LEGAL_REVIEW_STATUS = NOT_REVIEWED`, rendered from the frozen terms. Copy the Markdown into your signing channel → **Mark agreement sent**.
6. Signed copy back → **Record signed agreement** with the reference (sets the contract state).
7. **Create invoice schedule** — three `ENG-<id>-n` invoices ($2,500 each, due day 0 / 30 / 60). Issue invoice 1 manually → **Record installment payment** when it lands. Payment shows `PARTIALLY_PAID · $2,500 paid · $5,000 remaining`, never PAID_IN_FULL.
8. **Start onboarding** (gate: signed + installment 1 in full) → **Onboarding intake** (prefilled; required: legal name, brand, contact, email, website, market boundary, one priority, website control) → **Activate exclusivity** → freeze baseline → first work item → **Activate engagement**.

Fixture dry run against production (isolated QA131 market, archives itself):
`npx tsx scripts/commercial-dry-run.ts`.

## What happens in the OS

- **Quote recorded automatically** when an allowed send states the offer
  (`pricing_quotes`, policy version stamped) — or prepared by hand (draft →
  presented, spec 140). A presented quote's commercial fields are immutable;
  an unpresented draft may be regenerated under a newer policy. Record the response with
  `recordQuoteOutcome` (status, objections, preferred solution) — this is the
  willingness-to-pay dataset. Fixtures never count.
- **Report pricing section** (private report, only when the prospect asked)
  is built from the policy active at publish and frozen with the snapshot.
- **Signing a client** defaults to $7,500 / 90 days / $2,500 × 3. Any other
  total or term requires a founder override reason; the default is stored
  beside the actual. No silent discounting.
- **Dashboard → Analyze → Pricing learning**: active offer, real
  conversations, offers, accepted, declined on price, DIY preference, clients
  won, payments received; CAC/ARPU N/A until clients exist; milestones.

## When the price may change

Only by a founder decision: an explicit per-engagement override (with reason),
or a new policy entry after a review milestone — **Early pricing review** (3
real conversations), **First proof pricing review** (3 paying clients),
**Validated pricing review** (a completed engagement with a frozen comparable
rerun). Future scope-based policies (local / major / multi-market) differ by
markets, entities, competitive and implementation complexity — never by how
wealthy a prospect looks. Nothing raises price automatically.

## Do not

- negotiate against yourself or discount after an objection;
- invent a per-client price in a live conversation;
- change, resend or relabel an old quote — Ryan Ogle's $7,500/month × 3
  ($22,500, `founder_monthly_7500_v0`, declined: PRICE_TOO_HIGH + PREFERS_DIY)
  stays exactly as sent; it is the evidence behind this policy;
- productize a DIY/sprint offer on one data point.
