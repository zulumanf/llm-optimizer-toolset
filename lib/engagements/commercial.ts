/**
 * Commercial state (spec 140): the one read the founder needs when a prospect
 * says "send me the agreement" — offer, quote, agreement, payment, market,
 * exclusivity, onboarding, engagement and the next action — derived from
 * canonical rows (pricing_quotes, engagement_agreements, billing_events,
 * client_engagements, exclusivity). Also the installment schedule over the
 * manual invoice ledger: no payment provider exists, so the founder records
 * invoices and payments; the OS makes them deterministic and idempotent.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import {
  activePricingPolicy,
  billingLabel,
  centsToUsd,
  formatBillingLabel,
  formatOfferLabel,
  installmentSchedule,
  offerLabel,
  pricingPolicy,
  runRate,
  usd,
  usdToCents,
  type Installment,
} from "@/lib/pricing/policy";
import { addDays } from "@/lib/engagements/rules";
import {
  DEFAULT_PERFORMANCE_FEE_DUE_DAYS,
  performanceFeeStatus,
  performanceInvoiceId,
  type PerformanceFeeStatus,
  type PerformanceOutcome,
  type PerformanceTarget,
} from "@/lib/engagements/performance";
import { openQuoteForProspect, quoteById, quotesForProspect, type QuoteBilling, type QuoteRow } from "@/lib/pricing/quotes";
import { agreementForEngagement, type AgreementRow } from "@/lib/engagements/agreement";
import { exclusivityGateForProspect } from "@/lib/engagements/exclusivity-gate";
import { billingSummary, engagementForProject, getEngagement, listMeasurements, recordBillingEvent, type BillingSummary, type EngagementRow } from "@/lib/engagements/service";
import { activationPaid, onboardingComplete, type ChecklistItem } from "@/lib/engagements/rules";

// ----------------------------------------------------------------- money

export const PAYMENT_STATUSES = ["UNPAID", "PARTIALLY_PAID", "PAID_IN_FULL", "OVERDUE"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface PerformanceFeeState {
  status: PerformanceFeeStatus;
  feeCents: number;
  paidCents: number;
  /** "Performance fee: pending target" / "not owed" / "due $4,000" / "paid $4,000". */
  label: string;
}

export interface PaymentState {
  status: PaymentStatus;
  contractTotalCents: number;
  invoicedCents: number;
  receivedCents: number;
  balanceCents: number;
  activationPaymentCents: number;
  activationPaymentReceived: boolean;
  overdueCount: number;
  /** Spec 152: null when the engagement carries no performance fee. */
  performance: PerformanceFeeState | null;
}

export const PERFORMANCE_FEE_STATUS_LABEL: Record<PerformanceFeeStatus, (feeUsd: string) => string> = {
  not_applicable: () => "No performance fee",
  pending_target: () => "Performance fee: pending target",
  not_owed: () => "Performance fee: not owed",
  due: (fee) => `Performance fee: due ${fee}`,
  paid: (fee) => `Performance fee: paid ${fee}`,
};

/** Spec 152: the contract total is the fixed fee; the performance fee joins
 * it only once the founder records the target as met. Never before. */
export function contractTotalCents(i: { fixedCents: number; performanceFeeCents: number; outcome: PerformanceOutcome }): number {
  return i.fixedCents + (i.outcome === "met" ? i.performanceFeeCents : 0);
}

/** Financial status of the whole contract, separate from the lifecycle stage.
 * PAID_IN_FULL only when the contract total has been received. */
export function paymentState(i: {
  contractTotalCents: number;
  activationPaymentCents: number;
  invoicedCents: number;
  receivedCents: number;
  overdueCount: number;
  performance?: { outcome: PerformanceOutcome; feeCents: number; paidCents: number } | null;
}): PaymentState {
  const balanceCents = Math.max(0, i.contractTotalCents - i.receivedCents);
  let status: PaymentStatus;
  if (i.receivedCents >= i.contractTotalCents && i.contractTotalCents > 0) status = "PAID_IN_FULL";
  else if (i.overdueCount > 0) status = "OVERDUE";
  else if (i.receivedCents > 0) status = "PARTIALLY_PAID";
  else status = "UNPAID";
  return {
    status,
    contractTotalCents: i.contractTotalCents,
    invoicedCents: i.invoicedCents,
    receivedCents: i.receivedCents,
    balanceCents,
    activationPaymentCents: i.activationPaymentCents,
    activationPaymentReceived: i.activationPaymentCents > 0 ? i.receivedCents >= i.activationPaymentCents : i.receivedCents > 0,
    overdueCount: i.overdueCount,
    performance: performanceState(i.performance ?? null),
  };
}

function performanceState(p: { outcome: PerformanceOutcome; feeCents: number; paidCents: number } | null): PerformanceFeeState | null {
  if (!p || p.outcome === "not_applicable") return null;
  const status = performanceFeeStatus(p);
  return { status, feeCents: p.feeCents, paidCents: p.paidCents, label: PERFORMANCE_FEE_STATUS_LABEL[status](usd(centsToUsd(p.feeCents))) };
}


/** Deterministic invoice id for installment n of an engagement. */
export function installmentInvoiceId(engagementId: string, n: number): string {
  return `ENG-${engagementId.slice(0, 8).toUpperCase()}-${n}`;
}

/** The engagement's billing structure: the bound quote's, else its policy's,
 * else one upfront installment of the recorded total. */
export function engagementBilling(e: EngagementRow, quote: QuoteRow | null): QuoteBilling {
  if (quote) return quote.billing;
  const policy = e.pricingPolicyVersion ? pricingPolicy(e.pricingPolicyVersion) : null;
  if (policy && policy.totalFeeUsd === e.totalValueUsd) {
    return { installments: policy.billing.installments, installmentUsd: policy.billing.installmentUsd, schedule: [...policy.billing.schedule], dueDayOffsets: [...policy.billing.dueDayOffsets] };
  }
  return { installments: 1, installmentUsd: e.totalValueUsd, schedule: ["at signing"], dueDayOffsets: [0] };
}

export function engagementInstallments(e: EngagementRow, quote: QuoteRow | null): Installment[] {
  return installmentSchedule({ ...engagementBilling(e, quote), cadence: "custom" }, e.startsOn);
}

/**
 * Create the installment invoices in the ledger (kind invoice_created), one
 * per installment, with deterministic ids. Idempotent: existing invoices are
 * returned, never duplicated (unique index on invoice id + kind backs it).
 * Nothing is sent; the founder issues the invoice through the approved
 * manual process and records payments against the same ids.
 */
export async function createInvoiceSchedule(user: CurrentUser, raw: unknown): Promise<ActionResult<{ invoices: (Installment & { invoiceId: string; billingEventId: string })[]; created: number }>> {
  const parsed = z.object({ engagementId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  try {
    assertCanWrite(user);
    const e = await getEngagement(parsed.data.engagementId);
    if (!e) throw new ClassifiedError("not_found", "Engagement not found.");
    const quote = e.quoteId ? await quoteById(e.quoteId) : null;
    const plan = engagementInstallments(e, quote);
    const total = plan.reduce((s, i) => s + i.amountCents, 0);
    if (total !== usdToCents(e.totalValueUsd)) {
      throw new ClassifiedError("validation", `Installments (${total} cents) do not sum to the contract total (${usdToCents(e.totalValueUsd)} cents).`);
    }
    const existing = await billingSummary(e.id, e.projectId);
    let created = 0;
    const invoices: (Installment & { invoiceId: string; billingEventId: string })[] = [];
    for (const inst of plan) {
      const invoiceId = installmentInvoiceId(e.id, inst.n);
      const have = existing.events.find((x) => x.kind === "invoice_created" && x.externalInvoiceId === invoiceId);
      if (have) {
        invoices.push({ ...inst, invoiceId, billingEventId: have.id });
        continue;
      }
      const r = await recordBillingEvent(user, { engagementId: e.id, kind: "invoice_created", amountUsd: inst.amountUsd, dueDate: inst.dueOn, externalInvoiceId: invoiceId, note: `Installment ${inst.n} of ${plan.length} — ${inst.label}` });
      if (!r.ok) return r;
      created += 1;
      invoices.push({ ...inst, invoiceId, billingEventId: r.data.billingEventId });
    }
    if (created > 0) {
      await sql.begin((tx) => writeAudit(tx, { userId: user.id, action: "engagement.invoice_schedule", entity: "client_engagement", entityId: e.id, projectId: e.projectId, detail: { created, invoices: invoices.map((i) => ({ n: i.n, invoiceId: i.invoiceId, amountCents: i.amountCents, dueOn: i.dueOn })) } }));
    }
    return ok({ invoices, created });
  } catch (err) {
    return fail(err);
  }
}

/** Record that installment n was paid (manual confirmation or a provider's
 * test-mode event). Amount defaults to the installment; the invoice id ties
 * payment to invoice, and a duplicate event is one event. */
export async function recordInstallmentPayment(user: CurrentUser, raw: unknown): Promise<ActionResult<{ billingEventId: string; payment: PaymentState }>> {
  const parsed = z.object({
    engagementId: z.string().uuid(),
    installment: z.number().int().min(1).max(12),
    amountUsd: z.number().nonnegative().optional(),
    paidAt: z.string().datetime().optional(),
    reference: z.string().trim().max(300).optional(),
  }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const i = parsed.data;
  try {
    assertCanWrite(user);
    const e = await getEngagement(i.engagementId);
    if (!e) throw new ClassifiedError("not_found", "Engagement not found.");
    const quote = e.quoteId ? await quoteById(e.quoteId) : null;
    const plan = engagementInstallments(e, quote);
    const inst = plan.find((p) => p.n === i.installment);
    if (!inst) throw new ClassifiedError("validation", `This engagement has ${plan.length} installment(s).`);
    const r = await recordBillingEvent(user, {
      engagementId: e.id,
      kind: "payment_received",
      amountUsd: i.amountUsd ?? inst.amountUsd,
      externalInvoiceId: installmentInvoiceId(e.id, inst.n),
      note: `Installment ${inst.n} payment${i.reference ? ` · ref ${i.reference}` : ""}${i.paidAt ? ` · paid ${i.paidAt}` : ""}`,
    });
    if (!r.ok) return r;
    const payment = await engagementPaymentState(e);
    return ok({ billingEventId: r.data.billingEventId, payment });
  } catch (err) {
    return fail(err);
  }
}

export async function engagementPaymentState(e: EngagementRow, summary?: BillingSummary): Promise<PaymentState> {
  const b = summary ?? (await billingSummary(e.id, e.projectId));
  const feeCents = e.performanceFeeUsd !== null ? usdToCents(e.performanceFeeUsd) : 0;
  const perfInvoice = performanceInvoiceId(e.id);
  const paidCents = b.events.filter((x) => x.kind === "payment_received" && x.externalInvoiceId === perfInvoice).reduce((s, x) => s + x.amountCents, 0);
  return paymentState({
    contractTotalCents: contractTotalCents({ fixedCents: usdToCents(e.totalValueUsd), performanceFeeCents: feeCents, outcome: e.performanceOutcome }),
    activationPaymentCents: usdToCents(e.monthlyFeeUsd),
    invoicedCents: b.invoicedCents,
    receivedCents: b.receivedCents,
    overdueCount: b.overdueCount,
    performance: { outcome: e.performanceOutcome, feeCents, paidCents },
  });
}

/** Days after "met" the performance invoice falls due: the frozen quote's,
 * else the engagement policy's, else the founder default. */
export function performanceDueDays(e: EngagementRow, quote: QuoteRow | null): number {
  return (
    quote?.billing.performanceFee?.dueDaysAfterOutcome ??
    (e.pricingPolicyVersion ? pricingPolicy(e.pricingPolicyVersion)?.performanceFee?.dueDaysAfterOutcome : undefined) ??
    DEFAULT_PERFORMANCE_FEE_DUE_DAYS
  );
}

/**
 * Spec 152: the performance invoice exists only after the founder recorded
 * the agreed target as met. Idempotent (deterministic id ENG-<id8>-P); due
 * `outcome_at + dueDaysAfterOutcome`. Nothing is sent or charged.
 */
export async function createPerformanceInvoice(user: CurrentUser, raw: unknown): Promise<ActionResult<{ invoiceId: string; billingEventId: string; amountCents: number; dueOn: string; created: boolean }>> {
  const parsed = z.object({ engagementId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  try {
    assertCanWrite(user);
    const e = await getEngagement(parsed.data.engagementId);
    if (!e) throw new ClassifiedError("not_found", "Engagement not found.");
    if (e.performanceOutcome !== "met" || !e.performanceOutcomeAt) {
      throw new ClassifiedError("conflict", e.performanceOutcome === "not_met" ? "The target was recorded as not met: the performance fee is not owed." : "The performance fee is invoiced only after the founder records the agreed target as met.");
    }
    if (e.performanceFeeUsd === null || e.performanceFeeUsd <= 0) throw new ClassifiedError("conflict", "This engagement has no performance fee.");
    const quote = e.quoteId ? await quoteById(e.quoteId) : null;
    const invoiceId = performanceInvoiceId(e.id);
    const dueOn = addDays(e.performanceOutcomeAt.toISOString().slice(0, 10), performanceDueDays(e, quote));
    const existing = await billingSummary(e.id, e.projectId);
    const have = existing.events.find((x) => x.kind === "invoice_created" && x.externalInvoiceId === invoiceId);
    const amountCents = usdToCents(e.performanceFeeUsd);
    if (have) return ok({ invoiceId, billingEventId: have.id, amountCents: have.amountCents, dueOn: have.dueDate ?? dueOn, created: false });
    const r = await recordBillingEvent(user, { engagementId: e.id, kind: "invoice_created", amountUsd: e.performanceFeeUsd, dueDate: dueOn, externalInvoiceId: invoiceId, note: "Performance fee — agreed target recorded as met" });
    if (!r.ok) return r;
    await sql.begin((tx) => writeAudit(tx, { userId: user.id, action: "engagement.performance_invoice", entity: "client_engagement", entityId: e.id, projectId: e.projectId, detail: { invoiceId, amountCents, dueOn, outcomeSnapshotId: e.performanceOutcomeSnapshotId } }));
    return ok({ invoiceId, billingEventId: r.data.billingEventId, amountCents, dueOn, created: true });
  } catch (err) {
    return fail(err);
  }
}

/** Record that the performance invoice was paid. Requires the invoice. */
export async function recordPerformanceFeePayment(user: CurrentUser, raw: unknown): Promise<ActionResult<{ billingEventId: string; payment: PaymentState }>> {
  const parsed = z.object({
    engagementId: z.string().uuid(),
    amountUsd: z.number().nonnegative().optional(),
    paidAt: z.string().datetime().optional(),
    reference: z.string().trim().max(300).optional(),
  }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const i = parsed.data;
  try {
    assertCanWrite(user);
    const e = await getEngagement(i.engagementId);
    if (!e) throw new ClassifiedError("not_found", "Engagement not found.");
    const invoiceId = performanceInvoiceId(e.id);
    const summary = await billingSummary(e.id, e.projectId);
    const invoice = summary.events.find((x) => x.kind === "invoice_created" && x.externalInvoiceId === invoiceId);
    if (!invoice) throw new ClassifiedError("conflict", "No performance invoice exists; it is created only after the target is recorded as met.");
    const r = await recordBillingEvent(user, {
      engagementId: e.id,
      kind: "payment_received",
      amountUsd: i.amountUsd ?? centsToUsd(invoice.amountCents),
      externalInvoiceId: invoiceId,
      note: `Performance fee payment${i.reference ? ` · ref ${i.reference}` : ""}${i.paidAt ? ` · paid ${i.paidAt}` : ""}`,
    });
    if (!r.ok) return r;
    return ok({ billingEventId: r.data.billingEventId, payment: await engagementPaymentState(e) });
  } catch (err) {
    return fail(err);
  }
}

// ------------------------------------------------------- commercial stage

export const COMMERCIAL_STAGES = [
  "COMMERCIAL_INTEREST",
  "QUOTE_READY",
  "QUOTE_PRESENTED",
  "QUOTE_ACCEPTED",
  "AGREEMENT_READY",
  "AGREEMENT_SENT",
  "SIGNED",
  "ACTIVATION_PAYMENT_DUE",
  "ACTIVATION_PAYMENT_RECEIVED",
  "ONBOARDING",
  "ACTIVE",
  "COMPLETED",
  "DECLINED",
  "LOST",
] as const;
export type CommercialStage = (typeof COMMERCIAL_STAGES)[number];

export interface StageInput {
  quoteStatus: QuoteRow["status"] | null;
  engagementStage: EngagementRow["stage"] | null;
  contractStatus: EngagementRow["contractStatus"] | null;
  agreementStatus: AgreementRow["status"] | null;
  activationPaymentReceived: boolean;
  activationOverridden: boolean;
}

/** Pure derivation of the commercial stage from canonical states. */
export function deriveCommercialStage(i: StageInput): CommercialStage {
  if (i.engagementStage) {
    if (i.engagementStage === "churned") return "LOST";
    if (i.engagementStage === "completed" || i.engagementStage === "renewed") return "COMPLETED";
    if (i.engagementStage === "active" || i.engagementStage === "renewal_review") return "ACTIVE";
    if (i.engagementStage === "onboarding") return "ONBOARDING";
    // stage 'signed' = commercial record exists; contract state says the rest
    if (i.contractStatus === "signed") {
      return i.activationPaymentReceived || i.activationOverridden ? "ACTIVATION_PAYMENT_RECEIVED" : "ACTIVATION_PAYMENT_DUE";
    }
    if (i.agreementStatus === "sent" || i.contractStatus === "sent") return "AGREEMENT_SENT";
    return "AGREEMENT_READY";
  }
  if (i.quoteStatus === "draft") return "QUOTE_READY";
  if (i.quoteStatus === "presented") return "QUOTE_PRESENTED";
  if (i.quoteStatus === "accepted") return "QUOTE_ACCEPTED";
  if (i.quoteStatus === "declined" || i.quoteStatus === "withdrawn") return "DECLINED";
  return "COMMERCIAL_INTEREST";
}

export const COMMERCIAL_NEXT_ACTION: Record<CommercialStage, string> = {
  COMMERCIAL_INTEREST: "Prepare the quote (current offer) and answer with the approved pricing lines.",
  QUOTE_READY: "Send the quote through your own channel, then mark it presented.",
  QUOTE_PRESENTED: "Wait for the response; record accepted / declined with objections.",
  QUOTE_ACCEPTED: "Record the signed engagement from the quote, confirm the market definition, prepare the agreement.",
  AGREEMENT_READY: "Confirm the market definition if missing; with a performance fee, freeze the baseline and record the agreed target first. Prepare the agreement, send it through the approved process, mark it sent.",
  AGREEMENT_SENT: "When the signed copy returns, record it with the reference; create the invoice schedule.",
  SIGNED: "Create the invoice schedule and issue installment 1.",
  ACTIVATION_PAYMENT_DUE: "Issue installment 1 through the approved process; record the payment when it lands.",
  ACTIVATION_PAYMENT_RECEIVED: "Start onboarding (commercial gate clear) and run the onboarding intake.",
  ONBOARDING: "Complete the onboarding intake, activate exclusivity, freeze the baseline, record the agreed performance target (if any), plan the first work, then mark active.",
  ACTIVE: "Work the plan; any remaining installments fall due on schedule. With a performance fee: rerun the identical test after the agreed term and record the outcome yourself.",
  COMPLETED: "Historical. Nothing to do.",
  DECLINED: "Record objections; no new quote unless the founder decides.",
  LOST: "Historical. Cooldown applies before any re-prospecting.",
};

export interface CommercialState {
  stage: CommercialStage;
  nextAction: string;
  prospectId: string | null;
  projectId: string | null;
  engagementId: string | null;
  businessName: string;
  offer: {
    label: string;
    billing: string;
    policyVersion: string;
    /** The fixed, contracted fee. */
    totalUsd: number;
    termDays: number;
    monthlyEquivalentUsd: number;
    /** Spec 152: contingent on an agreed target — NOT contracted, never pipeline value. */
    performanceFeeUsd: number | null;
    source: "quote" | "engagement" | "current_policy";
  };
  performance: PerformanceView | null;
  quote: QuoteRow | null;
  quotes: QuoteRow[];
  agreement: { id: string; status: AgreementRow["status"]; templateVersion: string; legalReviewStatus: string; sentAt: Date | null; signedAt: Date | null; signedRef: string | null; contentHash: string } | null;
  contractStatus: EngagementRow["contractStatus"] | null;
  payment: PaymentState | null;
  installments: (Installment & { invoiceId: string; invoiced: boolean; paid: boolean })[];
  /** Spec 152: the performance invoice once it exists. */
  performanceInvoice: { invoiceId: string; amountCents: number; dueOn: string | null; paid: boolean } | null;
  market: { id: string | null; name: string; definition: string | null; definitionConfirmed: boolean };
  exclusivity: { status: EngagementRow["exclusivityStatus"] | "none"; conflict: boolean; detail: string };
  onboarding: { complete: boolean; open: string[] } | null;
  engagementStage: EngagementRow["stage"] | null;
}

function offerFrom(quote: QuoteRow | null, e: EngagementRow | null): CommercialState["offer"] {
  if (e) {
    const termDays = Math.round((new Date(`${e.endsOn}T00:00:00Z`).getTime() - new Date(`${e.startsOn}T00:00:00Z`).getTime()) / 86_400_000);
    const installments = e.totalValueUsd > 0 && e.monthlyFeeUsd > 0 ? Math.round(e.totalValueUsd / e.monthlyFeeUsd) : 1;
    const schedule = e.billingCadence === "upfront" && installments === 1 ? ["at signing"] : [];
    return { label: formatOfferLabel(e.totalValueUsd, Math.max(1, termDays), e.performanceFeeUsd), billing: formatBillingLabel({ installments, installmentUsd: e.monthlyFeeUsd, schedule }, e.performanceFeeUsd), policyVersion: e.pricingPolicyVersion ?? "pre-policy", totalUsd: e.totalValueUsd, termDays, monthlyEquivalentUsd: e.monthlyFeeUsd, performanceFeeUsd: e.performanceFeeUsd, source: "engagement" };
  }
  if (quote) {
    const perf = quote.billing.performanceFee?.usd ?? null;
    return { label: formatOfferLabel(quote.totalFeeUsd, quote.termDays, perf), billing: formatBillingLabel(quote.billing, perf), policyVersion: quote.pricingPolicyVersion, totalUsd: quote.totalFeeUsd, termDays: quote.termDays, monthlyEquivalentUsd: quote.billing.installmentUsd, performanceFeeUsd: perf, source: "quote" };
  }
  const p = activePricingPolicy();
  return { label: offerLabel(p), billing: billingLabel(p), policyVersion: p.version, totalUsd: p.totalFeeUsd, termDays: p.termDays, monthlyEquivalentUsd: runRate(p).monthlyEquivalentUsd, performanceFeeUsd: p.performanceFee?.usd ?? null, source: "current_policy" };
}

/** Spec 152: what the founder needs to record the target and the outcome. */
export interface PerformanceView {
  outcome: PerformanceOutcome;
  feeUsd: number;
  target: PerformanceTarget | null;
  baselineFrozen: boolean;
  /** Target may still be (re)recorded: before work starts and before a sent/signed agreement. */
  targetEditable: boolean;
  /** Frozen remeasurements the outcome may cite (instrument is re-checked on record). */
  remeasurements: { id: string; role: string; frozenAt: Date | null }[];
  outcomeSnapshotId: string | null;
  outcomeAt: Date | null;
  outcomeNote: string | null;
}

async function performanceView(e: EngagementRow, agreementStatus: AgreementRow["status"] | null): Promise<PerformanceView | null> {
  if (e.performanceOutcome === "not_applicable" || e.performanceFeeUsd === null) return null;
  const measurements = await listMeasurements(e.id);
  return {
    outcome: e.performanceOutcome,
    feeUsd: e.performanceFeeUsd,
    target: e.performanceTarget,
    baselineFrozen: measurements.some((m) => m.role === "baseline" && m.status === "frozen"),
    targetEditable: e.performanceOutcome === "pending" && (e.stage === "signed" || e.stage === "onboarding") && agreementStatus !== "sent" && agreementStatus !== "signed",
    remeasurements: measurements.filter((m) => m.role !== "baseline" && m.status === "frozen").map((m) => ({ id: m.id, role: m.role, frozenAt: m.frozenAt })),
    outcomeSnapshotId: e.performanceOutcomeSnapshotId,
    outcomeAt: e.performanceOutcomeAt,
    outcomeNote: e.performanceOutcomeNote,
  };
}

async function assemble(prospectId: string | null, e: EngagementRow | null, checklist: ChecklistItem[] | null, marketConflicts: number): Promise<CommercialState> {
  const quotes = prospectId ? await quotesForProspect(prospectId) : [];
  const quote = e?.quoteId ? (quotes.find((q) => q.id === e.quoteId) ?? (await quoteById(e.quoteId))) : prospectId ? await openQuoteForProspect(prospectId) : null;
  const latest = quote ?? quotes[0] ?? null;
  const agreement = e ? await agreementForEngagement(e.id) : null;
  const summary = e ? await billingSummary(e.id, e.projectId) : null;
  const payment = e && summary ? await engagementPaymentState(e, summary) : null;
  const plan = e ? engagementInstallments(e, quote) : [];
  const installments = plan.map((inst) => {
    const invoiceId = installmentInvoiceId(e!.id, inst.n);
    return {
      ...inst,
      invoiceId,
      invoiced: Boolean(summary?.events.some((x) => x.kind === "invoice_created" && x.externalInvoiceId === invoiceId)),
      paid: Boolean(summary?.events.some((x) => x.kind === "payment_received" && x.externalInvoiceId === invoiceId)),
    };
  });
  const perfInvoiceId = e ? performanceInvoiceId(e.id) : null;
  const perfInvoiceEvent = perfInvoiceId ? summary?.events.find((x) => x.kind === "invoice_created" && x.externalInvoiceId === perfInvoiceId) : undefined;
  const performanceInvoice = perfInvoiceEvent && perfInvoiceId
    ? { invoiceId: perfInvoiceId, amountCents: perfInvoiceEvent.amountCents, dueOn: perfInvoiceEvent.dueDate, paid: Boolean(summary?.events.some((x) => x.kind === "payment_received" && x.externalInvoiceId === perfInvoiceId)) }
    : null;
  const performance = e ? await performanceView(e, agreement?.status ?? null) : null;
  let businessName = "";
  let market: CommercialState["market"] = { id: e?.marketId ?? null, name: e?.marketName ?? "", definition: e?.marketDefinition ?? null, definitionConfirmed: Boolean(e?.marketDefinitionConfirmedAt) };
  let exclusivity: CommercialState["exclusivity"] = { status: e?.exclusivityStatus ?? "none", conflict: marketConflicts > 0, detail: marketConflicts > 0 ? `${marketConflicts} other live client(s) overlap this market` : e ? "no other live client overlaps this market" : "" };
  if (prospectId) {
    const [p] = await sql`
      select p.business_name, m.id as market_id, m.name as market_name from prospects p
      join market_launches l on l.id = p.launch_id left join markets m on m.id = l.market_id where p.id = ${prospectId}`;
    businessName = (p?.businessName as string | undefined) ?? "";
    if (!e) {
      market = { id: (p?.marketId as string | null) ?? null, name: (p?.marketName as string | null) ?? "", definition: null, definitionConfirmed: false };
      const gate = await exclusivityGateForProspect(prospectId);
      exclusivity = { status: "none", conflict: gate.blocked, detail: gate.detail };
    }
  } else if (e) {
    const [proj] = await sql`select name from projects where id = ${e.projectId}`;
    businessName = (proj?.name as string | undefined) ?? "";
  }
  const stage = deriveCommercialStage({
    quoteStatus: latest?.status ?? null,
    engagementStage: e?.stage ?? null,
    contractStatus: e?.contractStatus ?? null,
    agreementStatus: agreement?.status ?? null,
    activationPaymentReceived: payment?.activationPaymentReceived ?? false,
    activationOverridden: Boolean(e?.activationOverrideReason?.trim()),
  });
  return {
    stage,
    nextAction: COMMERCIAL_NEXT_ACTION[stage],
    prospectId,
    projectId: e?.projectId ?? null,
    engagementId: e?.id ?? null,
    businessName,
    offer: offerFrom(latest && latest.status !== "declined" && latest.status !== "withdrawn" && latest.status !== "superseded" ? latest : null, e),
    quote: latest,
    quotes,
    agreement: agreement ? { id: agreement.id, status: agreement.status, templateVersion: agreement.templateVersion, legalReviewStatus: agreement.legalReviewStatus, sentAt: agreement.sentAt, signedAt: agreement.signedAt, signedRef: agreement.signedRef, contentHash: agreement.contentHash } : null,
    contractStatus: e?.contractStatus ?? null,
    payment,
    installments,
    performanceInvoice,
    performance,
    market,
    exclusivity,
    onboarding: checklist ? { complete: onboardingComplete(checklist), open: checklist.filter((c) => !c.done).map((c) => c.label) } : null,
    engagementStage: e?.stage ?? null,
  };
}

/** Commercial state seen from the prospect (before or after signing). */
export async function commercialStateForProspect(prospectId: string): Promise<CommercialState> {
  const [p] = await sql`select promoted_project_id from prospects where id = ${prospectId}`;
  const projectId = (p?.promotedProjectId as string | null) ?? null;
  const e = projectId ? await engagementForProject(projectId) : null;
  if (!e) return assemble(prospectId, null, null, 0);
  const { portfolioClient } = await import("@/lib/engagements/portfolio");
  const client = await portfolioClient(e.projectId);
  return assemble(prospectId, e, client?.overview.checklist ?? null, client?.overview.marketConflicts.length ?? 0);
}

/** Commercial state seen from the client project. */
export async function commercialStateForProject(projectId: string): Promise<CommercialState | null> {
  const e = await engagementForProject(projectId);
  if (!e) return null;
  const { portfolioClient } = await import("@/lib/engagements/portfolio");
  const client = await portfolioClient(e.projectId);
  return assemble(e.prospectId, e, client?.overview.checklist ?? null, client?.overview.marketConflicts.length ?? 0);
}

/** True when the founder may activate: signed + activation payment (or override). */
export function activationPrerequisites(s: CommercialState): { ready: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!s.engagementId) missing.push("no engagement recorded");
  if (s.contractStatus !== "signed") missing.push("agreement not signed");
  if (s.payment && !activationPaid({ activationPaymentCents: s.payment.activationPaymentCents, paymentsReceivedCents: s.payment.receivedCents, activationOverrideReason: null })) missing.push("activation payment not received");
  if (!s.market.definitionConfirmed) missing.push("market definition not confirmed");
  if (s.exclusivity.conflict) missing.push("exclusivity conflict");
  if (s.onboarding && !s.onboarding.complete) missing.push(`onboarding open: ${s.onboarding.open.join("; ")}`);
  if (s.performance && s.performance.outcome === "pending" && !s.performance.target) missing.push("performance target not recorded");
  return { ready: missing.length === 0, missing };
}
