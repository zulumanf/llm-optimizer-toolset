/**
 * Engagement agreement artifact (spec 140). The operational agreement is
 * rendered deterministically from the engagement's frozen commercial terms
 * (the accepted quote, or the engagement's own snapshot for pre-quote rows)
 * under a versioned template. No signature provider exists: sent and signed
 * are recorded states with a reference, and a sent or signed artifact is
 * immutable by database trigger. The template has NOT been reviewed by
 * counsel — that status is stamped on every artifact and shown to the
 * founder; it is a business follow-up, not a reason the artifact cannot
 * be prepared.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import { SENDER_COMPANY } from "@/lib/prospects/constants";
import { activePricingPolicy, installmentSchedule, pricingPolicy, usd, type Installment } from "@/lib/pricing/policy";
import { quoteById, type QuoteBilling } from "@/lib/pricing/quotes";
import { getEngagement, type EngagementRow } from "@/lib/engagements/service";
import { daysBetween } from "@/lib/engagements/rules";
import { DEFAULT_PERFORMANCE_FEE_DUE_DAYS, describeThreshold, type PerformanceTarget } from "@/lib/engagements/performance";

/** Fixed-fee engagements (spec 140). Renders byte-identically forever. */
export const AGREEMENT_TEMPLATE_V1 = "engagement_agreement_v1";
/** Spec 152: fixed fee + performance fee on a frozen, agreed target. */
export const AGREEMENT_TEMPLATE_V2 = "engagement_agreement_v2";
/** The newest template; an engagement without a performance fee still renders v1. */
export const AGREEMENT_TEMPLATE_VERSION = AGREEMENT_TEMPLATE_V2;
export const LEGAL_REVIEW_STATUSES = ["NOT_REVIEWED", "REVIEWED"] as const;
export type LegalReviewStatus = (typeof LEGAL_REVIEW_STATUSES)[number];
/** The template in this file has not been reviewed by counsel. */
export const TEMPLATE_LEGAL_REVIEW_STATUS: LegalReviewStatus = "NOT_REVIEWED";
export const AGREEMENT_STATUSES = ["draft", "sent", "signed", "void"] as const;
export type AgreementStatus = (typeof AGREEMENT_STATUSES)[number];

/** Clauses that never vary per client. Plain operating language; no legal
 * claims beyond what the platform actually promises. */
export const AGREEMENT_CLAUSES = {
  clientResponsibilities: [
    "Provide reasonable access to the website, profiles and pages the work touches (delegated access only; passwords are never shared).",
    "Approve or decline proposed public changes within a reasonable time so the work can proceed.",
    "Provide the information needed to confirm identity, market boundary and priorities at onboarding.",
    "Name one primary contact for approvals and one implementation contact if different.",
  ],
  noGuarantee: [
    "No specific position, ranking or placement in any AI assistant's answers.",
    "No specific frequency with which any assistant recommends the client.",
    "No volume of leads, inquiries, transactions or revenue.",
    "No causal attribution of any business result to the work performed.",
  ],
  methodologyLimitation:
    "AI assistants produce probabilistic outputs that change between runs, model versions and dates. The measurement uses the same question set, provider and repetitions before and after, and states its limitations; a changed instrument is reported as non-comparable rather than compared.",
  exclusivity:
    "During the active engagement, Recommended First retains no other client for the defined market and scope stated above. Exclusivity ends with the engagement unless renewed in writing.",
  term: "The engagement runs for the stated term from the effective date. Nothing continues after the term unless both parties agree in writing.",
} as const;

/** Spec 152 (engagement_agreement_v2) clauses. Plain operating language; the
 * performance fee is a condition, never a promise of a result. */
export const AGREEMENT_V2_CLAUSES = {
  performanceNotOwed: "If the target is not met, the performance fee is not owed.",
  performanceDecision:
    "The outcome is recorded by the provider against the rerun and shared with the client together with the full before-and-after evidence. Nothing is decided or invoiced automatically.",
  targetIsCondition:
    "The agreed target is the condition for the performance fee. It is not a promise that the target will be reached.",
  measurementMethod: [
    "The rerun repeats the identical test frozen at baseline: the same question set version, the same assistant and model, the same number of repetitions per question, the same scoring version and the same names counted as the client.",
    "The exact model version is reported for both the baseline and the rerun.",
    "AI assistants, their models and the web results they read change over time, independently of the work. A rerun that cannot use the identical instrument is reported as non-comparable rather than compared, and no outcome is recorded against it.",
  ],
} as const;

export interface AgreementSnapshot {
  templateVersion: string;
  legalReviewStatus: LegalReviewStatus;
  parties: {
    client: { legalName: string; brandName: string; primaryContact: string };
    provider: { legalName: string; postalAddress: string };
  };
  engagement: { offerName: string; termDays: number; startsOn: string; endsOn: string };
  commercial: {
    totalUsd: number;
    installments: Installment[];
    pricingPolicyVersion: string | null;
    quoteId: string | null;
    quotePresentedAt: string | null;
    priceOverrideReason: string | null;
  };
  scope: { version: string; includes: string[]; summary: string; exclusions: string };
  market: { id: string; name: string; definition: string; exclusivity: string };
  clientResponsibilities: string[];
  noGuarantee: string[];
  methodologyLimitation: string;
  createdAt: string;
  /** Spec 152 (v2 only): the performance fee and the frozen target it depends on. */
  performance?: { feeUsd: number; dueDaysAfterOutcome: number; target: PerformanceTarget };
}

/** Deterministic Markdown from a snapshot — the artifact the founder sends.
 * The snapshot's own template version picks the renderer, so a v1 artifact
 * re-renders byte-identically after v2 exists. */
export function renderAgreement(s: AgreementSnapshot): string {
  return s.templateVersion === AGREEMENT_TEMPLATE_V2 && s.performance ? renderAgreementV2(s, s.performance) : renderAgreementV1(s);
}

function renderAgreementV1(s: AgreementSnapshot): string {
  const lines: string[] = [];
  lines.push(`# ${s.engagement.offerName} — Agreement`);
  lines.push("");
  lines.push(`Template ${s.templateVersion} · Legal review: ${s.legalReviewStatus}${s.commercial.quoteId ? ` · Quote ${s.commercial.quoteId}` : ""}`);
  lines.push("");
  lines.push("## Parties");
  lines.push(`- **Client:** ${s.parties.client.legalName}${s.parties.client.brandName && s.parties.client.brandName !== s.parties.client.legalName ? ` (${s.parties.client.brandName})` : ""} — primary contact ${s.parties.client.primaryContact || "to be named"}`);
  lines.push(`- **Provider:** ${s.parties.provider.legalName}, ${s.parties.provider.postalAddress}`);
  lines.push("");
  lines.push("## Engagement and term");
  lines.push(`${s.engagement.offerName}. Term: ${s.engagement.termDays} days, effective ${s.engagement.startsOn} through ${s.engagement.endsOn}. ${AGREEMENT_CLAUSES.term}`);
  lines.push("");
  lines.push("## Commercial terms");
  lines.push(`Total fee: **${usd(s.commercial.totalUsd)}** for the ${s.engagement.termDays}-day engagement, billed in ${s.commercial.installments.length} installments:`);
  for (const i of s.commercial.installments) lines.push(`- Installment ${i.n}: ${usd(i.amountUsd)} — ${i.label} (due ${i.dueOn})`);
  lines.push(`The first installment is due at signing and precedes the start of work. Pricing policy ${s.commercial.pricingPolicyVersion ?? "recorded before the pricing policy"}${s.commercial.priceOverrideReason ? ` — founder override: ${s.commercial.priceOverrideReason}` : ""}.`);
  lines.push("");
  lines.push("## Scope");
  lines.push(`One client entity (${s.parties.client.brandName || s.parties.client.legalName}), one defined market, one engagement. Scope version ${s.scope.version}. The fee includes:`);
  for (const inc of s.scope.includes) lines.push(`- ${inc}`);
  lines.push("");
  lines.push(s.scope.summary);
  if (s.scope.exclusions) {
    lines.push("");
    lines.push(`**Out of scope:** ${s.scope.exclusions}`);
  }
  lines.push("");
  lines.push("## Defined market and exclusivity");
  lines.push(`Market: **${s.market.name}**. Boundary: ${s.market.definition}`);
  lines.push(s.market.exclusivity);
  lines.push("");
  lines.push("## Client responsibilities");
  for (const r of s.clientResponsibilities) lines.push(`- ${r}`);
  lines.push("");
  lines.push("## No guarantee");
  lines.push("The provider does not guarantee:");
  for (const g of s.noGuarantee) lines.push(`- ${g}`);
  lines.push("What is promised: a rigorous baseline, evidence-backed diagnosis, documented execution and a comparable remeasurement.");
  lines.push("");
  lines.push("## Methodology limitation");
  lines.push(s.methodologyLimitation);
  lines.push("");
  lines.push("## Signatures");
  lines.push(`Client: ______________________  Date: __________  (${s.parties.client.legalName})`);
  lines.push(`Provider: ____________________  Date: __________  (${s.parties.provider.legalName})`);
  lines.push("");
  return lines.join("\n");
}

function renderAgreementV2(s: AgreementSnapshot, p: NonNullable<AgreementSnapshot["performance"]>): string {
  const t = p.target;
  const client = s.parties.client.brandName || s.parties.client.legalName;
  const lines: string[] = [];
  lines.push(`# ${s.engagement.offerName} — Agreement`);
  lines.push("");
  lines.push(`Template ${s.templateVersion} · Legal review: ${s.legalReviewStatus}${s.commercial.quoteId ? ` · Quote ${s.commercial.quoteId}` : ""}`);
  lines.push("");
  lines.push("## Parties");
  lines.push(`- **Client:** ${s.parties.client.legalName}${s.parties.client.brandName && s.parties.client.brandName !== s.parties.client.legalName ? ` (${s.parties.client.brandName})` : ""} — primary contact ${s.parties.client.primaryContact || "to be named"}`);
  lines.push(`- **Provider:** ${s.parties.provider.legalName}, ${s.parties.provider.postalAddress}`);
  lines.push("");
  lines.push("## Engagement and term");
  lines.push(`${s.engagement.offerName}. Term: ${s.engagement.termDays} days, effective ${s.engagement.startsOn} through ${s.engagement.endsOn}. The baseline was frozen on ${t.baselineFrozenOn}; the agreed target is measured by the rerun on or after ${t.rerunOn}. ${AGREEMENT_CLAUSES.term}`);
  lines.push("");
  lines.push("## Fixed fee");
  lines.push(`Fixed fee: **${usd(s.commercial.totalUsd)}** for the ${s.engagement.termDays}-day engagement:`);
  for (const i of s.commercial.installments) lines.push(`- ${usd(i.amountUsd)} — ${i.label} (due ${i.dueOn})`);
  lines.push(`It is due at signing and precedes the start of work. Pricing policy ${s.commercial.pricingPolicyVersion ?? "recorded before the pricing policy"}${s.commercial.priceOverrideReason ? ` — founder override: ${s.commercial.priceOverrideReason}` : ""}. The fixed fee covers:`);
  for (const inc of s.scope.includes) lines.push(`- ${inc}`);
  lines.push("");
  lines.push("## Performance fee");
  lines.push(`Performance fee: **${usd(p.feeUsd)}**, owed only if the agreed target below is reached at the rerun. It is invoiced after the outcome is recorded as met and is due ${p.dueDaysAfterOutcome} days after that record. ${AGREEMENT_V2_CLAUSES.performanceNotOwed}`);
  lines.push(AGREEMENT_V2_CLAUSES.performanceDecision);
  lines.push("");
  lines.push(`### Agreed target (agreed ${t.agreedOn})`);
  lines.push(t.secondary ? "The target is reached when both thresholds are reached at the rerun:" : "The target is reached when this threshold is reached at the rerun:");
  lines.push(`- ${describeThreshold(t.primary)}`);
  if (t.secondary) lines.push(`- ${describeThreshold(t.secondary)}`);
  if (t.note) lines.push(`- Note: ${t.note}`);
  lines.push("");
  lines.push("Frozen measurement instrument:");
  lines.push(`- Question set: version ${t.instrument.promptSetVersionId}, ${t.instrument.questionCount} questions`);
  lines.push(`- Assistant: ${t.instrument.provider}, model ${t.instrument.models.join(", ") || "as reported"}`);
  lines.push(`- Repetitions: ${t.instrument.repetitions} per question`);
  lines.push(`- Scoring version: ${t.instrument.scoringVersion}`);
  lines.push(`- Names counted as ${client}: ${t.entityNames.join(", ")}`);
  lines.push(`- Baseline: measurement ${t.baselineMeasurementId}, frozen ${t.baselineFrozenOn}`);
  lines.push(AGREEMENT_V2_CLAUSES.targetIsCondition);
  lines.push("");
  lines.push("## Measurement method");
  for (const m of AGREEMENT_V2_CLAUSES.measurementMethod) lines.push(`- ${m}`);
  lines.push("");
  lines.push("## Scope");
  lines.push(`One client entity (${client}), one defined market, one engagement. Scope version ${s.scope.version}.`);
  lines.push("");
  lines.push(s.scope.summary);
  if (s.scope.exclusions) {
    lines.push("");
    lines.push(`**Out of scope:** ${s.scope.exclusions}`);
  }
  lines.push("");
  lines.push("## Defined market and exclusivity");
  lines.push(`Market: **${s.market.name}**. Boundary: ${s.market.definition}`);
  lines.push(s.market.exclusivity);
  lines.push("");
  lines.push("## Client responsibilities");
  for (const r of s.clientResponsibilities) lines.push(`- ${r}`);
  lines.push("");
  lines.push("## No guarantee");
  lines.push("The provider does not guarantee:");
  for (const g of s.noGuarantee) lines.push(`- ${g}`);
  lines.push("What is promised: a rigorous baseline, evidence-backed diagnosis, documented execution and a comparable remeasurement.");
  lines.push("");
  lines.push("## Methodology limitation");
  lines.push(s.methodologyLimitation);
  lines.push("");
  lines.push("## Signatures");
  lines.push(`Client: ______________________  Date: __________  (${s.parties.client.legalName})`);
  lines.push(`Provider: ____________________  Date: __________  (${s.parties.provider.legalName})`);
  lines.push("");
  return lines.join("\n");
}

export function agreementHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export interface AgreementRow {
  id: string;
  engagementId: string;
  projectId: string;
  quoteId: string | null;
  templateVersion: string;
  legalReviewStatus: LegalReviewStatus;
  status: AgreementStatus;
  contentMd: string;
  contentHash: string;
  snapshot: AgreementSnapshot;
  sentAt: Date | null;
  signedAt: Date | null;
  signedRef: string | null;
  createdAt: Date;
}

function mapAgreement(r: Record<string, unknown>): AgreementRow {
  return {
    id: r.id as string,
    engagementId: r.engagementId as string,
    projectId: r.projectId as string,
    quoteId: (r.quoteId as string | null) ?? null,
    templateVersion: r.templateVersion as string,
    legalReviewStatus: r.legalReviewStatus as LegalReviewStatus,
    status: r.status as AgreementStatus,
    contentMd: r.contentMd as string,
    contentHash: r.contentHash as string,
    snapshot: r.snapshot as AgreementSnapshot,
    sentAt: (r.sentAt as Date | null) ?? null,
    signedAt: (r.signedAt as Date | null) ?? null,
    signedRef: (r.signedRef as string | null) ?? null,
    createdAt: r.createdAt as Date,
  };
}

/** The engagement's current agreement: the live one (sent/signed), else the latest draft. */
export async function agreementForEngagement(engagementId: string): Promise<AgreementRow | null> {
  const [row] = await sql`
    select * from engagement_agreements where engagement_id = ${engagementId} and status <> 'void'
    order by (status in ('sent','signed')) desc, created_at desc limit 1`;
  return row ? mapAgreement(row) : null;
}

export async function agreementById(id: string): Promise<AgreementRow | null> {
  const [row] = await sql`select * from engagement_agreements where id = ${id}`;
  return row ? mapAgreement(row) : null;
}

/** The provider party: the active outbound sender identity (spec 052) is the
 * business identity of record; SENDER_COMPANY is the env fallback. */
export async function providerIdentity(): Promise<{ legalName: string; postalAddress: string } | null> {
  const [row] = await sql`select company_name, postal_address from outreach_sender_identity where active limit 1`;
  if (row) return { legalName: row.companyName as string, postalAddress: row.postalAddress as string };
  if (SENDER_COMPANY) return { legalName: SENDER_COMPANY, postalAddress: "" };
  return null;
}

/** Build the snapshot from the engagement's frozen terms. Pure over its inputs. */
export function buildAgreementSnapshot(input: {
  engagement: EngagementRow;
  quote: { id: string; presentedAt: Date | null; billing: QuoteBilling; scopeVersion: string } | null;
  provider: { legalName: string; postalAddress: string };
  brandName: string;
  now: Date;
}): AgreementSnapshot {
  const e = input.engagement;
  const policy = e.pricingPolicyVersion ? pricingPolicy(e.pricingPolicyVersion) : null;
  const billing = input.quote
    ? input.quote.billing
    : policy
      ? { installments: policy.billing.installments, installmentUsd: policy.billing.installmentUsd, schedule: [...policy.billing.schedule], dueDayOffsets: [...policy.billing.dueDayOffsets] }
      : { installments: 1, installmentUsd: e.totalValueUsd, schedule: ["at signing"], dueDayOffsets: [0] };
  const installments = installmentSchedule({ ...billing, cadence: "custom" }, e.startsOn);
  // Spec 152: a performance engagement renders v2, citing the frozen target;
  // every other engagement keeps rendering v1.
  const hasPerformance = e.performanceOutcome !== "not_applicable" && e.performanceFeeUsd !== null && e.performanceFeeUsd > 0;
  if (hasPerformance && !e.performanceTarget) {
    throw new ClassifiedError("validation", "Record the agreed performance target first (freeze the baseline, then record the target) — the agreement cites it.");
  }
  const performance =
    hasPerformance && e.performanceTarget
      ? {
          feeUsd: e.performanceFeeUsd!,
          dueDaysAfterOutcome: input.quote?.billing.performanceFee?.dueDaysAfterOutcome ?? policy?.performanceFee?.dueDaysAfterOutcome ?? DEFAULT_PERFORMANCE_FEE_DUE_DAYS,
          target: e.performanceTarget,
        }
      : null;
  return {
    templateVersion: performance ? AGREEMENT_TEMPLATE_V2 : AGREEMENT_TEMPLATE_V1,
    legalReviewStatus: TEMPLATE_LEGAL_REVIEW_STATUS,
    parties: {
      client: { legalName: e.clientLegalName || input.brandName, brandName: input.brandName, primaryContact: e.primaryContactName },
      provider: input.provider,
    },
    engagement: { offerName: policy?.offerName ?? activePricingPolicy().offerName, termDays: daysBetween(e.startsOn, e.endsOn), startsOn: e.startsOn, endsOn: e.endsOn },
    commercial: {
      totalUsd: e.totalValueUsd,
      installments,
      pricingPolicyVersion: e.pricingPolicyVersion,
      quoteId: input.quote?.id ?? null,
      quotePresentedAt: input.quote?.presentedAt ? input.quote.presentedAt.toISOString() : null,
      priceOverrideReason: e.priceOverrideReason,
    },
    scope: {
      version: input.quote?.scopeVersion || "engagement_scope",
      includes: policy ? [...policy.includes] : [],
      summary: e.scopeSummary,
      exclusions: e.scopeExclusions,
    },
    market: { id: e.marketId, name: e.marketName, definition: e.marketDefinition ?? "", exclusivity: AGREEMENT_CLAUSES.exclusivity },
    clientResponsibilities: [...AGREEMENT_CLAUSES.clientResponsibilities],
    noGuarantee: [...AGREEMENT_CLAUSES.noGuarantee],
    methodologyLimitation: AGREEMENT_CLAUSES.methodologyLimitation,
    createdAt: input.now.toISOString(),
    ...(performance ? { performance } : {}),
  };
}

/**
 * Prepare the agreement artifact for an engagement. Requires the confirmed
 * market definition (the boundary is in the paper) and a provider identity.
 * A draft is regenerated in place (old draft voided); a sent or signed
 * agreement is never regenerated over — void it deliberately first.
 */
export async function prepareAgreement(user: CurrentUser, raw: unknown): Promise<ActionResult<{ agreement: AgreementRow; regenerated: boolean }>> {
  const parsed = z.object({ engagementId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  try {
    assertCanWrite(user);
    const e = await getEngagement(parsed.data.engagementId);
    if (!e) throw new ClassifiedError("not_found", "Engagement not found.");
    if (!e.marketDefinition || !e.marketDefinitionConfirmedAt) {
      throw new ClassifiedError("validation", "Confirm the market definition first — the agreement names the boundary in words.");
    }
    const current = await agreementForEngagement(e.id);
    if (current && current.status !== "draft") {
      throw new ClassifiedError("conflict", `An agreement is already ${current.status} (${current.templateVersion}). It is never regenerated over; void it deliberately if it must change.`);
    }
    const provider = await providerIdentity();
    if (!provider) throw new ClassifiedError("validation", "No Recommended First business identity on record (outreach_sender_identity or SENDER_COMPANY).");
    const quote = e.quoteId ? await quoteById(e.quoteId) : null;
    const [proj] = await sql`select name from projects where id = ${e.projectId}`;
    const snapshot = buildAgreementSnapshot({
      engagement: e,
      quote: quote ? { id: quote.id, presentedAt: quote.presentedAt, billing: quote.billing, scopeVersion: quote.scopeVersion } : null,
      provider,
      brandName: (proj?.name as string | undefined) ?? e.clientLegalName,
      now: new Date(),
    });
    const content = renderAgreement(snapshot);
    const id = await sql.begin(async (tx) => {
      if (current) await tx`update engagement_agreements set status = 'void', updated_at = now() where id = ${current.id} and status = 'draft'`;
      const [row] = await tx`
        insert into engagement_agreements (engagement_id, project_id, quote_id, template_version, legal_review_status, status, content_md, content_hash, snapshot, created_by)
        values (${e.id}, ${e.projectId}, ${quote?.id ?? null}, ${snapshot.templateVersion}, ${TEMPLATE_LEGAL_REVIEW_STATUS}, 'draft', ${content}, ${agreementHash(content)}, ${tx.json(snapshot as never)}, ${user.id})
        returning id`;
      await writeAudit(tx, { userId: user.id, action: "engagement.agreement_prepared", entity: "client_engagement", entityId: e.id, projectId: e.projectId, detail: { agreementId: row!.id, quoteId: quote?.id ?? null, templateVersion: snapshot.templateVersion, legalReviewStatus: TEMPLATE_LEGAL_REVIEW_STATUS, regenerated: Boolean(current) } });
      return row!.id as string;
    });
    return ok({ agreement: (await agreementById(id))!, regenerated: Boolean(current) });
  } catch (err) {
    return fail(err);
  }
}

/** Founder sent the artifact through the approved manual process. Freezes it. */
export async function markAgreementSent(user: CurrentUser, raw: unknown): Promise<ActionResult<{ agreementId: string }>> {
  const parsed = z.object({ agreementId: z.string().uuid(), sentAt: z.coerce.date().optional(), channel: z.string().trim().max(100).default("email") }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const i = parsed.data;
  try {
    assertCanWrite(user);
    const a = await agreementById(i.agreementId);
    if (!a) throw new ClassifiedError("not_found", "Agreement not found.");
    if (a.status === "sent" || a.status === "signed") return ok({ agreementId: a.id });
    if (a.status === "void") throw new ClassifiedError("conflict", "A void agreement cannot be sent; prepare a new one.");
    await sql.begin(async (tx) => {
      await tx`update engagement_agreements set status = 'sent', sent_at = ${i.sentAt ?? new Date()}, updated_at = now() where id = ${a.id} and status = 'draft'`;
      await tx`update client_engagements set contract_status = 'sent', updated_at = now() where id = ${a.engagementId} and contract_status in ('draft', 'sent')`;
      await writeAudit(tx, { userId: user.id, action: "engagement.agreement_sent", entity: "client_engagement", entityId: a.engagementId, projectId: a.projectId, detail: { agreementId: a.id, channel: i.channel, contentHash: a.contentHash } });
    });
    return ok({ agreementId: a.id });
  } catch (err) {
    return fail(err);
  }
}

/** The signed artifact came back: record the reference. Sets the engagement's
 * contract state in the same transaction. Idempotent. */
export async function recordAgreementSigned(user: CurrentUser, raw: unknown): Promise<ActionResult<{ agreementId: string; engagementId: string }>> {
  const parsed = z.object({ agreementId: z.string().uuid(), signedRef: z.string().trim().min(1).max(500), signedAt: z.coerce.date().optional() }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const i = parsed.data;
  try {
    assertCanWrite(user);
    const a = await agreementById(i.agreementId);
    if (!a) throw new ClassifiedError("not_found", "Agreement not found.");
    if (a.status === "signed") return ok({ agreementId: a.id, engagementId: a.engagementId });
    if (a.status === "void") throw new ClassifiedError("conflict", "A void agreement cannot be signed.");
    const signedAt = i.signedAt ?? new Date();
    await sql.begin(async (tx) => {
      await tx`update engagement_agreements set status = 'signed', signed_at = ${signedAt}, signed_ref = ${i.signedRef}, sent_at = coalesce(sent_at, ${signedAt}), updated_at = now() where id = ${a.id}`;
      await tx`update client_engagements set contract_status = 'signed', contract_ref = ${i.signedRef}, contract_signed_at = ${signedAt}, updated_at = now() where id = ${a.engagementId}`;
      await writeAudit(tx, { userId: user.id, action: "engagement.agreement_signed", entity: "client_engagement", entityId: a.engagementId, projectId: a.projectId, detail: { agreementId: a.id, signedRef: i.signedRef, contentHash: a.contentHash, templateVersion: a.templateVersion } });
    });
    return ok({ agreementId: a.id, engagementId: a.engagementId });
  } catch (err) {
    return fail(err);
  }
}

/** Deliberate withdrawal of a draft or sent agreement (audited). Signed never. */
export async function voidAgreement(user: CurrentUser, raw: unknown): Promise<ActionResult<{ agreementId: string }>> {
  const parsed = z.object({ agreementId: z.string().uuid(), reason: z.string().trim().min(10).max(1000) }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  try {
    assertCanWrite(user);
    const a = await agreementById(parsed.data.agreementId);
    if (!a) throw new ClassifiedError("not_found", "Agreement not found.");
    if (a.status === "signed") throw new ClassifiedError("conflict", "A signed agreement is never voided here; it is historical.");
    await sql.begin(async (tx) => {
      await tx`update engagement_agreements set status = 'void', updated_at = now() where id = ${a.id}`;
      await tx`update client_engagements set contract_status = 'draft', updated_at = now() where id = ${a.engagementId} and contract_status = 'sent'`;
      await writeAudit(tx, { userId: user.id, action: "engagement.agreement_void", entity: "client_engagement", entityId: a.engagementId, projectId: a.projectId, detail: { agreementId: a.id, reason: parsed.data.reason } });
    });
    return ok({ agreementId: a.id });
  } catch (err) {
    return fail(err);
  }
}
