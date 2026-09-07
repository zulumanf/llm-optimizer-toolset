/**
 * Quotes and pricing learning (spec 135). A quote is recorded the moment an
 * allowed send carries a policy's offer wording; the founder records what
 * came back. Metrics count real prospects only — fixtures (QA launch prefix)
 * and archived prospects never enter them. Willingness to pay is learned
 * from stated responses, never from opens.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import type { TransactionSql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { logActivity } from "@/lib/prospects/shared";
import { QA_FIXTURE_NAME_PREFIX } from "@/lib/prospects/constants";
import {
  activePricingPolicy,
  offerLabel,
  billingLabel,
  policyStatedIn,
  pricingPolicy,
  PRICING_MILESTONES,
  PRICING_OBJECTIONS,
  PREFERRED_SOLUTIONS,
  QUOTE_STATUSES,
  usd,
} from "@/lib/pricing/policy";

/** Called inside the send transaction: if the body states a policy's offer,
 * the send IS a presented quote. Returns the quote id or null. */
export async function recordQuoteFromSend(
  tx: TransactionSql,
  input: { prospectId: string; draftId: string | null; sendId: string | null; channel: string; body: string; sentAt: Date; userId: string | null }
): Promise<string | null> {
  const policy = policyStatedIn(input.body);
  if (!policy) return null;
  const [p] = await tx`
    select p.company_id, l.market_id from prospects p join market_launches l on l.id = p.launch_id where p.id = ${input.prospectId}`;
  const [row] = await tx`
    insert into pricing_quotes
      (prospect_id, company_id, market_id, pricing_policy_version, offer_name, total_fee_usd, term_days,
       billing_structure, quoted_at, channel, draft_id, send_id, status, recorded_by)
    values (${input.prospectId}, ${(p?.companyId as string | null) ?? null}, ${(p?.marketId as string | null) ?? null},
      ${policy.version}, ${policy.offerName}, ${policy.totalFeeUsd}, ${policy.termDays},
      ${tx.json({ installments: policy.billing.installments, installmentUsd: policy.billing.installmentUsd, schedule: [...policy.billing.schedule] } as never)},
      ${input.sentAt}, ${input.channel}, ${input.draftId}, ${input.sendId}, 'presented', ${input.userId})
    on conflict (send_id) where send_id is not null do nothing
    returning id`;
  if (!row) return null;
  await logActivity(tx, input.prospectId, "pricing_quoted", { quoteId: row.id, policy: policy.version, totalFeeUsd: policy.totalFeeUsd }, input.userId);
  return row.id as string;
}

const outcomeSchema = z.object({
  quoteId: z.string().uuid(),
  status: z.enum(QUOTE_STATUSES),
  objections: z.array(z.enum(PRICING_OBJECTIONS)).default([]),
  preferredSolution: z.enum(PREFERRED_SOLUTIONS).nullable().optional(),
  outcome: z.enum(["open", "client_won", "lost"]).optional(),
  lostReason: z.string().trim().max(1000).nullable().optional(),
  responseSummary: z.string().trim().max(2000).nullable().optional(),
  respondedAt: z.coerce.date().optional(),
  engagementId: z.string().uuid().nullable().optional(),
});

/** Founder records the prospect's response to a quote. Audited; the quote's
 * price, policy and time are never touched. */
export async function recordQuoteOutcome(user: CurrentUser, raw: unknown): Promise<ActionResult<{ quoteId: string }>> {
  const parsed = outcomeSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", "Invalid quote outcome."));
  const i = parsed.data;
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const [q] = await tx`select id, prospect_id from pricing_quotes where id = ${i.quoteId}`;
      if (!q) throw new ClassifiedError("not_found", "Quote not found.");
      const outcome = i.outcome ?? (i.status === "accepted" ? "client_won" : i.status === "declined" ? "lost" : "open");
      await tx`
        update pricing_quotes set
          status = ${i.status}, objections = ${i.objections}::text[], preferred_solution = ${i.preferredSolution ?? null},
          outcome = ${outcome}, lost_reason = ${i.lostReason ?? null}, response_summary = ${i.responseSummary ?? null},
          responded_at = ${i.respondedAt ?? new Date()}, engagement_id = coalesce(${i.engagementId ?? null}, engagement_id),
          outcome_recorded_by = ${user.id}, updated_at = now()
        where id = ${i.quoteId}`;
      await writeAudit(tx, { userId: user.id, action: "pricing.quote_outcome", entity: "pricing_quote", entityId: i.quoteId, detail: { status: i.status, objections: i.objections, preferredSolution: i.preferredSolution ?? null, outcome } });
      await logActivity(tx, q.prospectId as string, "pricing_outcome_recorded", { quoteId: i.quoteId, status: i.status, objections: i.objections, outcome }, user.id);
    });
    return ok({ quoteId: i.quoteId });
  } catch (err) {
    return fail(err);
  }
}

export interface PricingConversationRow {
  quoteId: string;
  prospectId: string;
  prospect: string;
  market: string;
  priceQuoted: string;
  termDays: number;
  policyVersion: string;
  quotedAt: Date;
  response: string;
  objections: string[];
  preferredSolution: string | null;
  outcome: string;
}

export interface PricingMilestone {
  key: "EARLY_PRICING_REVIEW" | "FIRST_PROOF_PRICING_REVIEW" | "VALIDATED_PRICING_REVIEW";
  label: string;
  current: number;
  threshold: number;
  reached: boolean;
}

export interface PricingLearning {
  activeOffer: { version: string; offerName: string; price: string; billing: string; scope: string };
  realConversations: number;
  offersPresented: number;
  accepted: number;
  declinedOnPrice: number;
  diyPreference: number;
  clientsWon: number;
  paymentsReceivedUsd: number;
  cacUsd: number | null;
  arpuUsd: number | null;
  conversations: PricingConversationRow[];
  milestones: PricingMilestone[];
}

/** Everything the dashboard's Pricing learning block shows. Real prospects only. */
export async function pricingLearning(): Promise<PricingLearning> {
  const fixture = `${QA_FIXTURE_NAME_PREFIX}%`;
  const rows = await sql`
    select q.id, q.prospect_id, p.business_name, m.name as market_name, q.total_fee_usd, q.term_days,
      q.pricing_policy_version, q.quoted_at, q.status, q.objections, q.preferred_solution, q.outcome
    from pricing_quotes q
    join prospects p on p.id = q.prospect_id
    join market_launches l on l.id = p.launch_id
    left join markets m on m.id = coalesce(q.market_id, l.market_id)
    where p.archived_at is null and l.name not like ${fixture}
    order by q.quoted_at desc`;
  const conversations: PricingConversationRow[] = rows.map((r) => ({
    quoteId: r.id as string,
    prospectId: r.prospectId as string,
    prospect: r.businessName as string,
    market: (r.marketName as string | null) ?? "",
    priceQuoted: usd(Number(r.totalFeeUsd)),
    termDays: Number(r.termDays),
    policyVersion: r.pricingPolicyVersion as string,
    quotedAt: r.quotedAt as Date,
    response: r.status as string,
    objections: (r.objections as string[]) ?? [],
    preferredSolution: (r.preferredSolution as string | null) ?? null,
    outcome: r.outcome as string,
  }));
  const [clients] = await sql`
    select count(*)::int as won,
      coalesce((select sum(b.amount_cents) from billing_events b join client_engagements e2 on e2.contract_ref = b.contract_ref
        join market_launches l2 on l2.id = (select launch_id from prospects where id = e2.prospect_id)
        where b.kind = 'payment_received' and l2.name not like ${fixture}), 0)::bigint as received_cents
    from client_engagements e
    join prospects p on p.id = e.prospect_id
    join market_launches l on l.id = p.launch_id
    where e.contract_status = 'signed' and l.name not like ${fixture} and p.archived_at is null`;
  const [completed] = await sql`
    select count(*)::int as n from client_engagements e
    join prospects p on p.id = e.prospect_id join market_launches l on l.id = p.launch_id
    where e.stage in ('completed', 'renewed') and l.name not like ${fixture}
      and exists (select 1 from engagement_measurements mm where mm.engagement_id = e.id and mm.role = 'final' and mm.status = 'frozen')`;
  const clientsWon = Number(clients?.won ?? 0);
  const paymentsReceivedUsd = Number(clients?.receivedCents ?? 0) / 100;
  const active = activePricingPolicy();
  const realConversations = new Set(conversations.map((c) => c.prospectId)).size;
  const milestones: PricingMilestone[] = [
    { key: "EARLY_PRICING_REVIEW", label: "Early pricing review", current: realConversations, threshold: PRICING_MILESTONES.earlyReviewConversations, reached: realConversations >= PRICING_MILESTONES.earlyReviewConversations },
    { key: "FIRST_PROOF_PRICING_REVIEW", label: "First proof pricing review", current: clientsWon, threshold: PRICING_MILESTONES.firstProofClients, reached: clientsWon >= PRICING_MILESTONES.firstProofClients },
    { key: "VALIDATED_PRICING_REVIEW", label: "Validated pricing review", current: Number(completed?.n ?? 0), threshold: PRICING_MILESTONES.validatedCompletedEngagements, reached: Number(completed?.n ?? 0) >= PRICING_MILESTONES.validatedCompletedEngagements },
  ];
  return {
    activeOffer: { version: active.version, offerName: active.offerName, price: offerLabel(active), billing: billingLabel(active), scope: active.scope.exclusivity },
    realConversations,
    offersPresented: conversations.length,
    accepted: conversations.filter((c) => c.response === "accepted").length,
    declinedOnPrice: conversations.filter((c) => c.objections.includes("PRICE_TOO_HIGH")).length,
    diyPreference: conversations.filter((c) => c.preferredSolution === "DIY" || c.objections.includes("PREFERS_DIY")).length,
    clientsWon,
    paymentsReceivedUsd,
    cacUsd: null,
    arpuUsd: clientsWon > 0 && paymentsReceivedUsd > 0 ? Math.round((paymentsReceivedUsd / clientsWon) * 100) / 100 : null,
    conversations,
    milestones,
  };
}

/** Whether a version exists at all (for display of historical rows). */
export function knownPolicy(version: string): boolean {
  return pricingPolicy(version) !== null;
}
