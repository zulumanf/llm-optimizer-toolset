# Spec 135 — Pricing policy: one versioned offer, auditable quotes, preserved history

## Decision (founder, 2026-09-07)
Recommended First is pre-proof. The default offer for the next first clients is the
**90-Day Market Implementation Engagement: $7,500 total, 90 days, billed $2,500 × 3**
(at signing, day 30, day 60). One engagement, not three cancellable months. It is
the current offer — never described to a prospect as a discount, pilot, beta,
founding or introductory price. Ryan Ogle's quote ($7,500/month × 3 = $22,500,
2026-09-05) stays exactly as sent; his decline (PRICE_TOO_HIGH + PREFERS_DIY) is
the evidence behind this policy.

## Policy versioning (code, versioned in git — like the model registry)
`lib/pricing/policy.ts` holds every policy: version, offer name, term, total fee,
billing structure, effective window, status, scope. `first_client_90d_v1` is
ACTIVE; `founder_monthly_7500_v0` is RETIRED (Ryan). New quotes and new
engagements may use only the active policy; a retired/expired policy is refused.

## Quotes (commercial event history) — `pricing_quotes` (migration 108)
prospect, company, market, policy version, offer name, total fee, term, billing
structure, quoted_at, channel, status (presented/accepted/declined/withdrawn),
objections (taxonomy, many), preferred solution (DONE_FOR_YOU/DONE_WITH_YOU/DIY),
outcome (open/client_won/lost), lost reason, override fields, actor. Recorded
automatically when an allowed send carries a policy's offer marker; outcomes are
recorded by the founder (`recordQuoteOutcome`, audited). Historical quotes are
backfilled from sent drafts that carried the v0 offer. Fixtures are excluded from
every metric by launch-name prefix and archived state.

## Engagements
`signClient` defaults to the active policy (total, term, installments, payment
terms). A different total or term requires `priceOverrideReason`; the row stores
`pricing_policy_version`, `default_total_value_usd` and the reason. No silent
discounting, no per-prospect price inference.

## Reports
The private report's pricing section renders only when the prospect asked for a
price (unchanged) and is built from the policy active AT PUBLISH, stamped with
its version and frozen in the snapshot. Delivered snapshots never drift.

## Sales response
`docs/13-prompts.md` carries the founder-ready pricing reply
(`pricing_reply_v1`): "The 90-day engagement is $7,500. That includes the
baseline, implementation of the highest-confidence changes, monitoring, and the
comparable rerun at the end. We bill it as $2,500 per month over the 90 days."
Cold T1/T2/T3/EVIDENCE_CORRECTION never carry pricing (test-enforced).

## Dashboard — Pricing learning (Analyze)
Active offer · real pricing conversations · offers presented · accepted ·
declined on price · DIY preference · clients won · payments received; CAC/ARPU
N/A until clients exist. Conversation table (prospect, market, price, term,
version, response, objection, outcome). Milestones: EARLY PRICING REVIEW at 3
conversations, FIRST PROOF PRICING REVIEW at 3 paying clients, VALIDATED PRICING
REVIEW at the first completed engagement with a comparable remeasurement. Founder
decides; nothing raises price automatically.

## Not built
Tiers, DIY/sprint offer, market-based price, Stripe, calculators, discount
approval chains. Future scope-based policies are new entries in the same list.
