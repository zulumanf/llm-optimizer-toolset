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
  QUOTE_RESPONSE_STATUSES,
  OPEN_QUOTE_STATUSES,
  assertQuotablePolicy,
  usd,
  type PricingPolicy,
  type QuoteStatus,
} from "@/lib/pricing/policy";

/** Billing structure as stored on a quote row (frozen copy of the policy's). */
export interface QuoteBilling {
  installments: number;
  installmentUsd: number;
  schedule: string[];
  dueDayOffsets: number[];
}
export function billingSnapshot(p: PricingPolicy): QuoteBilling {
  return { installments: p.billing.installments, installmentUsd: p.billing.installmentUsd, schedule: [...p.billing.schedule], dueDayOffsets: [...p.billing.dueDayOffsets] };
}

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
      ${tx.json(billingSnapshot(policy) as never)},
      ${input.sentAt}, ${input.channel}, ${input.draftId}, ${input.sendId}, 'presented', ${input.userId})
    on conflict (send_id) where send_id is not null do nothing
    returning id`;
  if (!row) return null;
  await logActivity(tx, input.prospectId, "pricing_quoted", { quoteId: row.id, policy: policy.version, totalFeeUsd: policy.totalFeeUsd }, input.userId);
  return row.id as string;
}

// ------------------------------------------------------- quote lifecycle

export interface QuoteRow {
  id: string;
  prospectId: string;
  companyId: string | null;
  marketId: string | null;
  engagementId: string | null;
  pricingPolicyVersion: string;
  offerName: string;
  totalFeeUsd: number;
  termDays: number;
  billing: QuoteBilling;
  scopeVersion: string;
  quotedAt: Date;
  presentedAt: Date | null;
  channel: string;
  status: QuoteStatus;
  outcome: string;
  objections: string[];
  respondedAt: Date | null;
  responseSummary: string | null;
  recordedBy: string | null;
  supersededBy: string | null;
}

function mapQuote(r: Record<string, unknown>): QuoteRow {
  const b = (r.billingStructure as Partial<QuoteBilling> | null) ?? {};
  return {
    id: r.id as string,
    prospectId: r.prospectId as string,
    companyId: (r.companyId as string | null) ?? null,
    marketId: (r.marketId as string | null) ?? null,
    engagementId: (r.engagementId as string | null) ?? null,
    pricingPolicyVersion: r.pricingPolicyVersion as string,
    offerName: r.offerName as string,
    totalFeeUsd: Number(r.totalFeeUsd),
    termDays: Number(r.termDays),
    billing: {
      installments: Number(b.installments ?? 0),
      installmentUsd: Number(b.installmentUsd ?? 0),
      schedule: b.schedule ?? [],
      dueDayOffsets: b.dueDayOffsets ?? [],
    },
    scopeVersion: (r.scopeVersion as string) ?? "",
    quotedAt: r.quotedAt as Date,
    presentedAt: (r.presentedAt as Date | null) ?? null,
    channel: r.channel as string,
    status: r.status as QuoteStatus,
    outcome: r.outcome as string,
    objections: (r.objections as string[]) ?? [],
    respondedAt: (r.respondedAt as Date | null) ?? null,
    responseSummary: (r.responseSummary as string | null) ?? null,
    recordedBy: (r.recordedBy as string | null) ?? null,
    supersededBy: (r.supersededBy as string | null) ?? null,
  };
}

const QUOTE_COLUMNS = sql`id, prospect_id, company_id, market_id, engagement_id, pricing_policy_version, offer_name, total_fee_usd,
  term_days, billing_structure, scope_version, quoted_at, presented_at, channel, status, outcome, objections, responded_at,
  response_summary, recorded_by, superseded_by`;

export async function quoteById(quoteId: string): Promise<QuoteRow | null> {
  const [r] = await sql`select ${QUOTE_COLUMNS} from pricing_quotes where id = ${quoteId}`;
  return r ? mapQuote(r) : null;
}

export async function quotesForProspect(prospectId: string): Promise<QuoteRow[]> {
  const rows = await sql`select ${QUOTE_COLUMNS} from pricing_quotes where prospect_id = ${prospectId} order by quoted_at desc`;
  return rows.map(mapQuote);
}

/** The prospect's one quote still in play (draft, presented or accepted). */
export async function openQuoteForProspect(prospectId: string): Promise<QuoteRow | null> {
  const [r] = await sql`
    select ${QUOTE_COLUMNS} from pricing_quotes
    where prospect_id = ${prospectId} and status = any(${[...OPEN_QUOTE_STATUSES]}::text[])
    order by quoted_at desc limit 1`;
  return r ? mapQuote(r) : null;
}

const prepareSchema = z.object({
  prospectId: z.string().uuid(),
  /** Defaults to the active policy; a retired policy is refused. */
  policyVersion: z.string().optional(),
  scopeVersion: z.string().trim().max(100).optional(),
});

/** Scope version stamped on a new quote: the active policy's version is the
 * scope definition until a separate scope registry exists. */
export const QUOTE_SCOPE_VERSION = "scope_90d_market_implementation_v1";

/**
 * Founder prepares a quote under the CURRENT policy (spec 140). Nothing is
 * sent. Idempotent: a prospect with an open quote gets that quote back — a
 * retry never creates a second one. Fixtures and real prospects alike.
 */
export async function prepareQuote(user: CurrentUser, raw: unknown): Promise<ActionResult<{ quote: QuoteRow; created: boolean }>> {
  const parsed = prepareSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", "Invalid quote input."));
  const i = parsed.data;
  try {
    assertCanWrite(user);
    const policy = assertQuotablePolicy(i.policyVersion ?? activePricingPolicy().version);
    const existing = await openQuoteForProspect(i.prospectId);
    if (existing) return ok({ quote: existing, created: false });
    const [p] = await sql`
      select p.company_id, p.archived_at, l.market_id from prospects p join market_launches l on l.id = p.launch_id where p.id = ${i.prospectId}`;
    if (!p || p.archivedAt) throw new ClassifiedError("not_found", "Prospect not found.");
    const id = await sql.begin(async (tx) => {
      const [row] = await tx`
        insert into pricing_quotes
          (prospect_id, company_id, market_id, pricing_policy_version, offer_name, total_fee_usd, term_days,
           billing_structure, scope_version, quoted_at, channel, status, recorded_by)
        values (${i.prospectId}, ${(p.companyId as string | null) ?? null}, ${(p.marketId as string | null) ?? null},
          ${policy.version}, ${policy.offerName}, ${policy.totalFeeUsd}, ${policy.termDays},
          ${tx.json(billingSnapshot(policy) as never)}, ${i.scopeVersion ?? QUOTE_SCOPE_VERSION}, now(), 'manual', 'draft', ${user.id})
        returning id`;
      await writeAudit(tx, { userId: user.id, action: "pricing.quote_prepared", entity: "pricing_quote", entityId: row!.id as string, detail: { policy: policy.version, totalFeeUsd: policy.totalFeeUsd, termDays: policy.termDays } });
      await logActivity(tx, i.prospectId, "pricing_quote_prepared", { quoteId: row!.id, policy: policy.version, totalFeeUsd: policy.totalFeeUsd }, user.id);
      return row!.id as string;
    });
    const quote = (await quoteById(id))!;
    return ok({ quote, created: true });
  } catch (err) {
    return fail(err);
  }
}

const presentSchema = z.object({
  quoteId: z.string().uuid(),
  channel: z.enum(["email", "call", "meeting", "manual"]).default("email"),
  presentedAt: z.coerce.date().optional(),
  note: z.string().trim().max(1000).optional(),
});

/** Founder records that the quote WAS shown to the prospect. From here the
 * commercial fields are frozen by the database trigger. Idempotent. */
export async function markQuotePresented(user: CurrentUser, raw: unknown): Promise<ActionResult<{ quote: QuoteRow }>> {
  const parsed = presentSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", "Invalid input."));
  const i = parsed.data;
  try {
    assertCanWrite(user);
    const q = await quoteById(i.quoteId);
    if (!q) throw new ClassifiedError("not_found", "Quote not found.");
    if (q.status !== "draft") return ok({ quote: q });
    await sql.begin(async (tx) => {
      await tx`
        update pricing_quotes set status = 'presented', presented_at = ${i.presentedAt ?? new Date()}, channel = ${i.channel},
          response_summary = coalesce(${i.note ?? null}, response_summary), updated_at = now()
        where id = ${q.id} and status = 'draft'`;
      await writeAudit(tx, { userId: user.id, action: "pricing.quote_presented", entity: "pricing_quote", entityId: q.id, detail: { channel: i.channel, presentedAt: i.presentedAt ?? null } });
      await logActivity(tx, q.prospectId, "pricing_quoted", { quoteId: q.id, policy: q.pricingPolicyVersion, totalFeeUsd: q.totalFeeUsd, channel: i.channel }, user.id);
    });
    return ok({ quote: (await quoteById(q.id))! });
  } catch (err) {
    return fail(err);
  }
}

/**
 * An UNPRESENTED draft may be regenerated under the current policy (founder
 * rule: nothing shown to the prospect is ever rewritten). The old draft is
 * marked superseded and points at its replacement; a presented quote is
 * refused here — record its outcome instead.
 */
export async function regenerateDraftQuote(user: CurrentUser, raw: unknown): Promise<ActionResult<{ quote: QuoteRow; supersededQuoteId: string }>> {
  const parsed = z.object({ quoteId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", "Invalid quote id."));
  try {
    assertCanWrite(user);
    const q = await quoteById(parsed.data.quoteId);
    if (!q) throw new ClassifiedError("not_found", "Quote not found.");
    if (q.status !== "draft") throw new ClassifiedError("conflict", `Quote is ${q.status}; only an unpresented draft can be regenerated.`);
    const policy = activePricingPolicy();
    const newId = await sql.begin(async (tx) => {
      const [row] = await tx`
        insert into pricing_quotes
          (prospect_id, company_id, market_id, pricing_policy_version, offer_name, total_fee_usd, term_days,
           billing_structure, scope_version, quoted_at, channel, status, recorded_by)
        values (${q.prospectId}, ${q.companyId}, ${q.marketId}, ${policy.version}, ${policy.offerName}, ${policy.totalFeeUsd}, ${policy.termDays},
          ${tx.json(billingSnapshot(policy) as never)}, ${q.scopeVersion || QUOTE_SCOPE_VERSION}, now(), 'manual', 'draft', ${user.id})
        returning id`;
      await tx`update pricing_quotes set status = 'superseded', superseded_by = ${row!.id}, updated_at = now() where id = ${q.id} and status = 'draft'`;
      await writeAudit(tx, { userId: user.id, action: "pricing.quote_regenerated", entity: "pricing_quote", entityId: row!.id as string, detail: { supersededQuoteId: q.id, from: q.pricingPolicyVersion, to: policy.version } });
      return row!.id as string;
    });
    return ok({ quote: (await quoteById(newId))!, supersededQuoteId: q.id });
  } catch (err) {
    return fail(err);
  }
}

const outcomeSchema = z.object({
  quoteId: z.string().uuid(),
  status: z.enum(QUOTE_RESPONSE_STATUSES),
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
      const [q] = await tx`select id, prospect_id, status from pricing_quotes where id = ${i.quoteId}`;
      if (!q) throw new ClassifiedError("not_found", "Quote not found.");
      if (q.status === "draft" || q.status === "superseded") {
        throw new ClassifiedError("conflict", `Quote is ${q.status}: a response can only be recorded on a presented quote.`);
      }
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
      and q.status not in ('draft', 'superseded')
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
