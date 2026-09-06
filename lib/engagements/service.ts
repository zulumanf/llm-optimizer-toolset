/**
 * Client engagement service (spec 131). The commercial and delivery record
 * of a signed client, built over what already exists: promotion (spec 057)
 * for the project, exclusivity (spec 028) for territory, billing_events for
 * the invoice ledger, tasks for work, runs/mentions for evidence, the portal
 * for the client's view. Nothing here creates a parallel CRM, task system,
 * or billing engine.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import type { TransactionSql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { getSubjectCompany } from "@/db/companies";
import { listComparisonCompanies } from "@/db/competitors";
import { assertCanWrite, assertRole, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import { createAgreement, terminateAgreement } from "@/lib/exclusivity/service";
import { detectConflicts, type MarketNode } from "@/lib/exclusivity/detect";
import { loadAgreementInputs } from "@/lib/exclusivity/service";
import { addCompetitor } from "@/lib/competitors/service";
import { listPortalGrants, revokeClientAccess } from "@/lib/portal/invite";
import { promoteProspectToClient, transitionStage } from "@/lib/prospects/service";
import { deliveredTouch1 } from "@/lib/prospects/followups";
import { logActivity } from "@/lib/prospects/shared";
import {
  ACCESS_STATUSES,
  BILLING_CADENCES,
  BILLING_KINDS,
  CONTEXT_KINDS,
  CONTEXT_PROVENANCES,
  CONTRACT_STATUSES,
  DEFAULT_TERM_DAYS,
  FORMER_CLIENT_COOLDOWN_DAYS,
  LIVE_ENGAGEMENT_STAGES,
  MEASUREMENT_ROLES,
  type ContractStatus,
  type EngagementStage,
  type RenewalStatus,
} from "@/lib/engagements/constants";
import {
  addDays,
  assessMeasurementComparability,
  commercialGate,
  compareMeasurements,
  composeWeeklyUpdate,
  deriveRenewalStatus,
  deriveStage,
  healthSignals,
  measurementSchedule,
  nextAction,
  onboardingChecklist,
  onboardingComplete,
  termDates,
  todayIso,
  type ChecklistItem,
  type GateVerdict,
  type HealthSignal,
  type MeasurementComparability,
  type MeasurementComparison,
  type MeasurementSnapshot,
} from "@/lib/engagements/rules";
import { buildMeasurementSnapshot, runInstrument } from "@/lib/engagements/measurement";

const DEFAULT_PROVIDER = "openai";
/** Audit detail must be plain JSON; interfaces are not assignable to JSONValue. */
const plain = (v: unknown): Record<string, never> => JSON.parse(JSON.stringify(v)) as Record<string, never>;
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const idSchema = z.string().uuid();

// ------------------------------------------------------------------ reads

export interface EngagementRow {
  id: string;
  projectId: string;
  prospectId: string | null;
  marketId: string;
  marketName: string;
  exclusivityAgreementId: string | null;
  exclusivityStatus: "active" | "reserved" | "terminated" | "none";
  previousEngagementId: string | null;
  primaryContactId: string | null;
  primaryContactName: string;
  ownerId: string | null;
  startsOn: string;
  endsOn: string;
  monthlyFeeUsd: number;
  totalValueUsd: number;
  billingCadence: string;
  paymentTerms: string;
  contractStatus: ContractStatus;
  contractRef: string | null;
  contractSignedAt: Date | null;
  marketDefinition: string | null;
  marketDefinitionConfirmedAt: Date | null;
  scopeSummary: string;
  scopeExclusions: string;
  stage: EngagementStage;
  activationOverrideReason: string | null;
  renewalStatus: RenewalStatus;
  renewalReviewOn: string;
  caseStudyPermission: boolean;
  testimonialPermission: boolean;
  logoPermission: boolean;
  anonymizedDataPermission: boolean;
  closedAt: Date | null;
  closeReason: string | null;
  cooldownUntil: string | null;
}

function toIso(d: unknown): string {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d);
}

function mapRow(r: Record<string, unknown>): EngagementRow {
  return {
    id: r.id as string,
    projectId: r.projectId as string,
    prospectId: (r.prospectId as string | null) ?? null,
    marketId: r.marketId as string,
    marketName: (r.marketName as string) ?? "",
    exclusivityAgreementId: (r.exclusivityAgreementId as string | null) ?? null,
    exclusivityStatus: ((r.agreementStatus as string | null) ?? "none") as EngagementRow["exclusivityStatus"],
    previousEngagementId: (r.previousEngagementId as string | null) ?? null,
    primaryContactId: (r.primaryContactId as string | null) ?? null,
    primaryContactName: (r.primaryContactName as string) ?? "",
    ownerId: (r.ownerId as string | null) ?? null,
    startsOn: toIso(r.startsOn),
    endsOn: toIso(r.endsOn),
    monthlyFeeUsd: Number(r.monthlyFeeUsd),
    totalValueUsd: Number(r.totalValueUsd),
    billingCadence: r.billingCadence as string,
    paymentTerms: (r.paymentTerms as string) ?? "",
    contractStatus: r.contractStatus as ContractStatus,
    contractRef: (r.contractRef as string | null) ?? null,
    contractSignedAt: (r.contractSignedAt as Date | null) ?? null,
    marketDefinition: (r.marketDefinition as string | null) ?? null,
    marketDefinitionConfirmedAt: (r.marketDefinitionConfirmedAt as Date | null) ?? null,
    scopeSummary: (r.scopeSummary as string) ?? "",
    scopeExclusions: (r.scopeExclusions as string) ?? "",
    stage: r.stage as EngagementStage,
    activationOverrideReason: (r.activationOverrideReason as string | null) ?? null,
    renewalStatus: r.renewalStatus as RenewalStatus,
    renewalReviewOn: toIso(r.renewalReviewOn),
    caseStudyPermission: Boolean(r.caseStudyPermission),
    testimonialPermission: Boolean(r.testimonialPermission),
    logoPermission: Boolean(r.logoPermission),
    anonymizedDataPermission: Boolean(r.anonymizedDataPermission),
    closedAt: (r.closedAt as Date | null) ?? null,
    closeReason: (r.closeReason as string | null) ?? null,
    cooldownUntil: r.cooldownUntil ? toIso(r.cooldownUntil) : null,
  };
}

const ENGAGEMENT_SELECT = sql`
  select e.*, m.name as market_name, a.status as agreement_status
  from client_engagements e
  join markets m on m.id = e.market_id
  left join exclusivity_agreements a on a.id = e.exclusivity_agreement_id
`;

export async function getEngagement(id: string): Promise<EngagementRow | null> {
  const [row] = await sql`${ENGAGEMENT_SELECT} where e.id = ${id}`;
  return row ? mapRow(row) : null;
}

/** The live engagement for a client project (at most one by index), else the
 * most recently closed one. */
export async function engagementForProject(projectId: string): Promise<EngagementRow | null> {
  const [row] = await sql`
    ${ENGAGEMENT_SELECT}
    where e.project_id = ${projectId}
    order by (e.stage in ('signed','onboarding','active','renewal_review')) desc, e.created_at desc
    limit 1
  `;
  return row ? mapRow(row) : null;
}

export async function listLiveEngagements(): Promise<EngagementRow[]> {
  const rows = await sql`
    ${ENGAGEMENT_SELECT}
    where e.stage in ('signed','onboarding','active','renewal_review')
    order by e.starts_on asc
  `;
  return rows.map(mapRow);
}

async function loadEngagementForWrite(tx: TransactionSql, id: string): Promise<EngagementRow> {
  const [row] = await tx`
    select e.*, m.name as market_name, a.status as agreement_status
    from client_engagements e
    join markets m on m.id = e.market_id
    left join exclusivity_agreements a on a.id = e.exclusivity_agreement_id
    where e.id = ${id} for update of e
  `;
  if (!row) throw new ClassifiedError("not_found", "Engagement not found.");
  return mapRow(row);
}

async function setStage(
  tx: TransactionSql,
  user: CurrentUser,
  engagement: EngagementRow,
  stage: EngagementStage,
  detail: Record<string, unknown> = {}
): Promise<void> {
  await tx`
    update client_engagements set stage = ${stage}, stage_changed_at = now(), updated_at = now()
    where id = ${engagement.id}
  `;
  await writeAudit(tx, {
    userId: user.id,
    action: "engagement.stage",
    entity: "client_engagement",
    entityId: engagement.id,
    projectId: engagement.projectId,
    detail: { from: engagement.stage, to: stage, ...detail },
  });
}

// --------------------------------------------------- market conflict check

interface MarketConflict {
  engagementId: string;
  projectId: string;
  marketName: string;
  relation: string;
}

/** Another LIVE engagement whose market is the same as, inside, or containing
 * this one — the one-retained-client-per-market promise, checked on data. */
async function liveEngagementConflicts(
  marketId: string,
  exceptProjectId: string | null
): Promise<MarketConflict[]> {
  const markets = await sql<MarketNode[]>`select id, name, parent_id from markets`;
  const { geoRelation } = await import("@/lib/exclusivity/detect");
  const live = await sql`
    select e.id, e.project_id, m.name as market_name, e.market_id
    from client_engagements e join markets m on m.id = e.market_id
    where e.stage in ('signed','onboarding','active','renewal_review')
  `;
  const out: MarketConflict[] = [];
  for (const row of live) {
    if (exceptProjectId && row.projectId === exceptProjectId) continue;
    const rel = geoRelation(marketId, row.marketId as string, markets);
    if (rel === "unrelated" || rel === "sibling") continue;
    out.push({
      engagementId: row.id as string,
      projectId: row.projectId as string,
      marketName: row.marketName as string,
      relation: rel,
    });
  }
  return out;
}

// ----------------------------------------------------------------- sign

const signSchema = z.object({
  prospectId: idSchema,
  startsOn: dateSchema,
  termDays: z.number().int().min(30).max(730).default(DEFAULT_TERM_DAYS),
  monthlyFeeUsd: z.number().nonnegative(),
  totalValueUsd: z.number().nonnegative(),
  billingCadence: z.enum(BILLING_CADENCES).default("monthly"),
  paymentTerms: z.string().trim().max(300).default(""),
  scopeSummary: z.string().trim().min(20).max(4000),
  scopeExclusions: z.string().trim().max(4000).default(""),
  primaryContactId: idSchema.nullable().optional(),
  /** Named contact when no prospect_contacts row exists yet. */
  primaryContactName: z.string().trim().max(200).optional(),
  /** Admin override with a reason when another live client overlaps the market. */
  conflictOverrideRationale: z.string().trim().min(10).max(2000).optional(),
});

export interface SignedClient {
  engagementId: string;
  projectId: string;
  agreementId: string;
  promoted: boolean;
  competitorsAdded: number;
  measurementsPlanned: number;
}

/**
 * SIGNED: the one deliberate act that turns a prospect into a client with a
 * commercial record. Idempotent over promotion (reuses the promoted project),
 * refuses a second live client in the same market, reserves the territory
 * (activated later by the exclusivity gate), carries the pre-sale competitor
 * into the client project, and plans the remeasurements. Nothing is sent,
 * charged or activated.
 */
export async function signClient(user: CurrentUser, raw: unknown): Promise<ActionResult<SignedClient>> {
  const parsed = signSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const input = parsed.data;
  try {
    assertCanWrite(user);
    const [prospect] = await sql`
      select p.id, p.stage, p.business_name, p.company_id, p.promoted_project_id, p.archived_at,
        l.market_id, l.service_category, l.price_segment
      from prospects p join market_launches l on l.id = p.launch_id
      where p.id = ${input.prospectId}
    `;
    if (!prospect || prospect.archivedAt) return fail(new ClassifiedError("not_found", "Prospect not found."));
    if (!prospect.companyId) {
      return fail(new ClassifiedError("validation", "Link the prospect to its canonical company before signing."));
    }
    if (input.primaryContactId) {
      const [contact] = await sql`
        select id from prospect_contacts where id = ${input.primaryContactId} and prospect_id = ${prospect.id}
      `;
      if (!contact) return fail(new ClassifiedError("validation", "Primary contact does not belong to this prospect."));
    }

    const conflicts = await liveEngagementConflicts(prospect.marketId as string, prospect.promotedProjectId as string | null);
    if (conflicts.length > 0) {
      if (!input.conflictOverrideRationale) {
        return fail(
          new ClassifiedError(
            "conflict",
            `Another live client already holds ${conflicts[0]!.marketName} (${conflicts[0]!.relation}). One retained client per market — a founder override with a written reason is required.`
          )
        );
      }
      assertRole(user, "admin");
    }

    if (prospect.stage !== "contracted") {
      const moved = await transitionStage(user, {
        prospectId: prospect.id,
        toStage: "contracted",
        reason: "Signed engagement recorded (spec 131).",
      });
      if (!moved.ok) return moved;
    }
    let projectId = prospect.promotedProjectId as string | null;
    let promoted = false;
    if (!projectId) {
      const promotion = await promoteProspectToClient(user, { prospectId: prospect.id, createAgreement: false });
      if (!promotion.ok) return promotion;
      projectId = promotion.data.projectId;
      promoted = true;
    }

    const dates = termDates(input.startsOn, input.termDays);
    const agreement = await createAgreement(user, {
      projectId,
      startsOn: input.startsOn,
      endsOn: dates.endsOn,
      gracePeriodDays: 0,
      status: "reserved",
      notes: `Reserved at signing (spec 131); activates when the market definition is confirmed and the commercial gate passes.`,
      scopes: [
        {
          marketId: prospect.marketId as string,
          serviceCategory: (prospect.serviceCategory as string | null) ?? null,
          segment: (prospect.priceSegment as string | null) ?? null,
        },
      ],
    });
    if (!agreement.ok) return agreement;

    // Pre-sale competitor (the mismatch rival) becomes a tracked competitor
    // so the baseline package and remeasurements name the same rival.
    let competitorsAdded = 0;
    const touch1 = await deliveredTouch1(prospect.id);
    const rivalId = touch1?.evidenceSnapshot.competitor.companyId ?? null;
    if (rivalId && rivalId !== prospect.companyId) {
      const existing = await listComparisonCompanies(projectId);
      if (!existing.some((c) => c.companyId === rivalId)) {
        const added = await addCompetitor(user, { projectId, companyId: rivalId, tier: "primary" });
        if (added.ok) competitorsAdded += 1;
      }
    }

    const contactName = input.primaryContactId
      ? (((await sql`select name from prospect_contacts where id = ${input.primaryContactId}`)[0]?.name as string | undefined) ?? input.primaryContactName ?? "")
      : (input.primaryContactName ?? "");
    const plan = measurementSchedule(input.startsOn, dates.endsOn);
    const engagementId = await sql.begin(async (tx) => {
      const [row] = await tx`
        insert into client_engagements (
          project_id, prospect_id, market_id, exclusivity_agreement_id, primary_contact_id,
          primary_contact_name, owner_id, starts_on, ends_on, monthly_fee_usd, total_value_usd,
          billing_cadence, payment_terms, scope_summary, scope_exclusions, renewal_review_on, created_by
        ) values (
          ${projectId}, ${prospect.id}, ${prospect.marketId}, ${agreement.data.agreementId},
          ${input.primaryContactId ?? null}, ${contactName}, ${user.id}, ${input.startsOn}, ${dates.endsOn},
          ${input.monthlyFeeUsd}, ${input.totalValueUsd}, ${input.billingCadence}, ${input.paymentTerms},
          ${input.scopeSummary}, ${input.scopeExclusions}, ${dates.renewalReviewOn}, ${user.id}
        ) returning id
      `;
      const id = row!.id as string;
      for (const m of plan) {
        await tx`
          insert into engagement_measurements (engagement_id, project_id, role, status, scheduled_for, reason, created_by)
          values (${id}, ${projectId}, ${m.role}, 'planned', ${m.scheduledFor}, ${m.reason}, ${user.id})
        `;
      }
      await writeAudit(tx, {
        userId: user.id,
        action: "engagement.signed",
        entity: "client_engagement",
        entityId: id,
        projectId,
        detail: {
          prospectId: prospect.id,
          agreementId: agreement.data.agreementId,
          monthlyFeeUsd: input.monthlyFeeUsd,
          totalValueUsd: input.totalValueUsd,
          termDays: input.termDays,
          conflictOverride: input.conflictOverrideRationale ?? null,
          conflicts: plain(conflicts),
        },
      });
      await logActivity(tx, prospect.id as string, "engagement_signed", { engagementId: id, projectId }, user.id);
      return id;
    });
    return ok({
      engagementId,
      projectId,
      agreementId: agreement.data.agreementId,
      promoted,
      competitorsAdded,
      measurementsPlanned: plan.length,
    });
  } catch (err) {
    return fail(err);
  }
}

// ------------------------------------------------------------ commercial

const contractSchema = z.object({
  engagementId: idSchema,
  status: z.enum(CONTRACT_STATUSES),
  contractRef: z.string().trim().max(500).optional(),
  signedAt: z.string().datetime().optional(),
});

export async function recordContractStatus(user: CurrentUser, raw: unknown): Promise<ActionResult<{ engagementId: string }>> {
  const parsed = contractSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const input = parsed.data;
  try {
    assertCanWrite(user);
    if (input.status === "signed" && !input.contractRef) {
      return fail(new ClassifiedError("validation", "A signed contract needs a reference (file, folder or signature-provider id)."));
    }
    await sql.begin(async (tx) => {
      const e = await loadEngagementForWrite(tx, input.engagementId);
      await tx`
        update client_engagements set
          contract_status = ${input.status},
          contract_ref = ${input.contractRef ?? e.contractRef},
          contract_signed_at = ${input.status === "signed" ? (input.signedAt ?? new Date().toISOString()) : null},
          updated_at = now()
        where id = ${e.id}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "engagement.contract",
        entity: "client_engagement",
        entityId: e.id,
        projectId: e.projectId,
        detail: { from: e.contractStatus, to: input.status, contractRef: input.contractRef ?? null },
      });
    });
    return ok({ engagementId: input.engagementId });
  } catch (err) {
    return fail(err);
  }
}

const billingSchema = z.object({
  engagementId: idSchema,
  kind: z.enum(BILLING_KINDS),
  amountUsd: z.number().nonnegative(),
  dueDate: dateSchema.optional(),
  externalInvoiceId: z.string().trim().max(200).optional(),
  note: z.string().trim().max(1000).default(""),
});

/** Manual invoice ledger over billing_events: no payment processor exists,
 * so the operator records what happened; the ledger is what the commercial
 * gate reads. Amounts are numeric and deterministic. */
export async function recordBillingEvent(user: CurrentUser, raw: unknown): Promise<ActionResult<{ billingEventId: string }>> {
  const parsed = billingSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const input = parsed.data;
  try {
    assertCanWrite(user);
    const id = await sql.begin(async (tx) => {
      const e = await loadEngagementForWrite(tx, input.engagementId);
      const [row] = await tx`
        insert into billing_events (project_id, kind, external_invoice_id, amount_cents, due_date, contract_ref, detail)
        values (${e.projectId}, ${input.kind}, ${input.externalInvoiceId ?? null},
          ${Math.round(input.amountUsd * 100)}, ${input.dueDate ?? null}, ${`engagement:${e.id}`},
          ${tx.json({ note: input.note, recordedBy: user.id })})
        returning id
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "engagement.billing_event",
        entity: "client_engagement",
        entityId: e.id,
        projectId: e.projectId,
        detail: { kind: input.kind, amountUsd: input.amountUsd, externalInvoiceId: input.externalInvoiceId ?? null },
      });
      return row!.id as string;
    });
    return ok({ billingEventId: id });
  } catch (err) {
    return fail(err);
  }
}

export interface BillingSummary {
  invoicedCents: number;
  receivedCents: number;
  overdueCount: number;
  events: { id: string; kind: string; amountCents: number; dueDate: string | null; occurredAt: Date; externalInvoiceId: string | null }[];
}

export async function billingSummary(engagementId: string, projectId: string, today = todayIso()): Promise<BillingSummary> {
  const rows = await sql`
    select id, kind, amount_cents, due_date, occurred_at, external_invoice_id
    from billing_events where project_id = ${projectId} and contract_ref = ${`engagement:${engagementId}`}
    order by occurred_at asc
  `;
  const events = rows.map((r) => ({
    id: r.id as string,
    kind: r.kind as string,
    amountCents: Number(r.amountCents ?? 0),
    dueDate: r.dueDate ? toIso(r.dueDate) : null,
    occurredAt: r.occurredAt as Date,
    externalInvoiceId: (r.externalInvoiceId as string | null) ?? null,
  }));
  const paidInvoices = new Set(events.filter((e) => e.kind === "payment_received" && e.externalInvoiceId).map((e) => e.externalInvoiceId));
  return {
    invoicedCents: events.filter((e) => e.kind === "invoice_created").reduce((s, e) => s + e.amountCents, 0),
    receivedCents: events.filter((e) => e.kind === "payment_received").reduce((s, e) => s + e.amountCents, 0),
    overdueCount: events.filter(
      (e) => e.kind === "invoice_created" && e.dueDate && e.dueDate < today && !(e.externalInvoiceId && paidInvoices.has(e.externalInvoiceId))
    ).length,
    events,
  };
}

const marketDefinitionSchema = z.object({
  engagementId: idSchema,
  definition: z.string().trim().min(20).max(2000),
});

/** The human-reviewed boundary. Never derived from the market name. */
export async function confirmMarketDefinition(user: CurrentUser, raw: unknown): Promise<ActionResult<{ engagementId: string }>> {
  const parsed = marketDefinitionSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const e = await loadEngagementForWrite(tx, parsed.data.engagementId);
      await tx`
        update client_engagements set market_definition = ${parsed.data.definition},
          market_definition_confirmed_at = now(), market_definition_confirmed_by = ${user.id}, updated_at = now()
        where id = ${e.id}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "engagement.market_definition_confirmed",
        entity: "client_engagement",
        entityId: e.id,
        projectId: e.projectId,
        detail: { definition: parsed.data.definition },
      });
    });
    return ok({ engagementId: parsed.data.engagementId });
  } catch (err) {
    return fail(err);
  }
}

const permissionsSchema = z.object({
  engagementId: idSchema,
  caseStudy: z.boolean().optional(),
  testimonial: z.boolean().optional(),
  logo: z.boolean().optional(),
  anonymizedData: z.boolean().optional(),
});

export async function setMarketingPermissions(user: CurrentUser, raw: unknown): Promise<ActionResult<{ engagementId: string }>> {
  const parsed = permissionsSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const i = parsed.data;
  try {
    assertRole(user, "admin");
    await sql.begin(async (tx) => {
      const e = await loadEngagementForWrite(tx, i.engagementId);
      await tx`
        update client_engagements set
          case_study_permission = ${i.caseStudy ?? e.caseStudyPermission},
          testimonial_permission = ${i.testimonial ?? e.testimonialPermission},
          logo_permission = ${i.logo ?? e.logoPermission},
          anonymized_data_permission = ${i.anonymizedData ?? e.anonymizedDataPermission},
          updated_at = now()
        where id = ${e.id}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "engagement.marketing_permissions",
        entity: "client_engagement",
        entityId: e.id,
        projectId: e.projectId,
        detail: i,
      });
    });
    return ok({ engagementId: i.engagementId });
  } catch (err) {
    return fail(err);
  }
}

// ------------------------------------------------------------ lifecycle

async function paymentsReceivedCents(engagementId: string, projectId: string): Promise<number> {
  const [row] = await sql`
    select coalesce(sum(amount_cents), 0)::bigint as cents from billing_events
    where project_id = ${projectId} and kind = 'payment_received' and contract_ref = ${`engagement:${engagementId}`}
  `;
  return Number(row?.cents ?? 0);
}

const startOnboardingSchema = z.object({
  engagementId: idSchema,
  overrideReason: z.string().trim().min(10).max(1000).optional(),
});

/** SIGNED → ONBOARDING only through the commercial gate (signed contract +
 * first payment, or an admin override with a reason). */
export async function startOnboarding(user: CurrentUser, raw: unknown): Promise<ActionResult<{ engagementId: string; gate: GateVerdict }>> {
  const parsed = startOnboardingSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const input = parsed.data;
  try {
    assertCanWrite(user);
    if (input.overrideReason) assertRole(user, "admin");
    const result = await sql.begin(async (tx) => {
      const e = await loadEngagementForWrite(tx, input.engagementId);
      if (e.stage !== "signed") throw new ClassifiedError("conflict", `Engagement is already ${e.stage}.`);
      const gate = commercialGate({
        contractStatus: e.contractStatus,
        paymentsReceivedCents: await paymentsReceivedCents(e.id, e.projectId),
        activationOverrideReason: input.overrideReason ?? e.activationOverrideReason,
      });
      if (!gate.ready) throw new ClassifiedError("validation", `Commercial gate not met: ${gate.reasons.join(" ")}`);
      if (input.overrideReason) {
        await tx`update client_engagements set activation_override_reason = ${input.overrideReason} where id = ${e.id}`;
      }
      await setStage(tx, user, e, "onboarding", { gate, overrideReason: input.overrideReason ?? null });
      return gate;
    });
    return ok({ engagementId: input.engagementId, gate: result });
  } catch (err) {
    return fail(err);
  }
}

/** Activate the reserved territory. Requires the confirmed market definition
 * and the commercial gate; refuses when another live agreement overlaps. */
export async function activateExclusivity(user: CurrentUser, raw: unknown): Promise<ActionResult<{ agreementId: string }>> {
  const parsed = z.object({ engagementId: idSchema, overrideRationale: z.string().trim().min(10).max(2000).optional() }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const input = parsed.data;
  try {
    assertCanWrite(user);
    const e = await getEngagement(input.engagementId);
    if (!e) return fail(new ClassifiedError("not_found", "Engagement not found."));
    if (!e.exclusivityAgreementId) return fail(new ClassifiedError("conflict", "This engagement has no territory agreement."));
    if (!e.marketDefinitionConfirmedAt) {
      return fail(new ClassifiedError("validation", "Confirm the human-reviewed market definition before activating exclusivity."));
    }
    if (e.stage === "signed") {
      return fail(new ClassifiedError("validation", "Clear the commercial gate (start onboarding) before activating exclusivity."));
    }
    if (!LIVE_ENGAGEMENT_STAGES.includes(e.stage)) {
      return fail(new ClassifiedError("conflict", `Engagement is ${e.stage}.`));
    }
    if (e.exclusivityStatus === "active") return ok({ agreementId: e.exclusivityAgreementId });
    if (e.exclusivityStatus !== "reserved") {
      return fail(new ClassifiedError("conflict", `Agreement is ${e.exclusivityStatus}; only a reserved agreement activates.`));
    }
    // Deterministic conflict check against every OTHER live agreement.
    const markets = await sql<MarketNode[]>`select id, name, parent_id from markets`;
    const agreements = (await loadAgreementInputs()).filter((a) => a.agreementId !== e.exclusivityAgreementId);
    const [scope] = await sql`
      select market_id, service_category, segment from exclusivity_scopes where agreement_id = ${e.exclusivityAgreementId} limit 1
    `;
    const detection = detectConflicts(
      {
        marketId: (scope?.marketId as string) ?? e.marketId,
        serviceCategory: (scope?.serviceCategory as string | null) ?? null,
        segment: (scope?.segment as string | null) ?? null,
      },
      agreements,
      markets,
      todayIso()
    );
    const blocking = detection.conflicts.filter((c) => c.verdict === "direct" || c.verdict === "partial");
    if (blocking.length > 0) {
      if (!input.overrideRationale) {
        return fail(new ClassifiedError("conflict", `Territory conflict: ${blocking[0]!.reason} Founder override with a reason required.`));
      }
      assertRole(user, "admin");
    }
    await sql.begin(async (tx) => {
      await tx`update exclusivity_agreements set status = 'active', updated_at = now() where id = ${e.exclusivityAgreementId}`;
      await writeAudit(tx, {
        userId: user.id,
        action: "exclusivity.agreement_activated",
        entity: "exclusivity_agreement",
        entityId: e.exclusivityAgreementId!,
        projectId: e.projectId,
        detail: { engagementId: e.id, detection: plain(detection), overrideRationale: input.overrideRationale ?? null },
      });
    });
    return ok({ agreementId: e.exclusivityAgreementId });
  } catch (err) {
    return fail(err);
  }
}

/** ONBOARDING → ACTIVE only when the derived checklist is complete. */
export async function markActive(user: CurrentUser, raw: unknown): Promise<ActionResult<{ engagementId: string; checklist: ChecklistItem[] }>> {
  const parsed = z.object({ engagementId: idSchema }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", "Invalid engagement id."));
  try {
    assertCanWrite(user);
    const e = await getEngagement(parsed.data.engagementId);
    if (!e) return fail(new ClassifiedError("not_found", "Engagement not found."));
    if (e.stage !== "onboarding") return fail(new ClassifiedError("conflict", `Engagement is ${e.stage}, not onboarding.`));
    const checklist = await computeChecklist(e);
    if (!onboardingComplete(checklist)) {
      const open = checklist.filter((c) => !c.done).map((c) => c.label);
      return fail(new ClassifiedError("validation", `Onboarding is not complete: ${open.join("; ")}.`));
    }
    await sql.begin(async (tx) => {
      const locked = await loadEngagementForWrite(tx, e.id);
      await setStage(tx, user, locked, "active", { checklist });
    });
    return ok({ engagementId: e.id, checklist });
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------- context

const contextSchema = z
  .object({
    engagementId: idSchema,
    kind: z.enum(CONTEXT_KINDS),
    label: z.string().trim().min(1).max(200),
    value: z.record(z.string(), z.unknown()).default({}),
    provenance: z.enum(CONTEXT_PROVENANCES),
    accessStatus: z.enum(ACCESS_STATUSES).optional(),
    sourceRef: z.string().trim().max(1000).optional(),
  })
  .refine((v) => (v.kind === "access") === (v.accessStatus !== undefined), {
    message: "Access items carry an access status; other items do not.",
  })
  .refine((v) => !("password" in v.value || "secret" in v.value || "token" in v.value), {
    message: "Never store credentials in context items — use delegated access or the encrypted connector vault.",
  });

export async function addContextItem(user: CurrentUser, raw: unknown): Promise<ActionResult<{ itemId: string }>> {
  const parsed = contextSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const i = parsed.data;
  try {
    assertCanWrite(user);
    const id = await sql.begin(async (tx) => {
      const e = await loadEngagementForWrite(tx, i.engagementId);
      const [row] = await tx`
        insert into engagement_context_items (engagement_id, project_id, kind, label, value, provenance, access_status, source_ref, created_by)
        values (${e.id}, ${e.projectId}, ${i.kind}, ${i.label}, ${tx.json(i.value as never)}, ${i.provenance},
          ${i.accessStatus ?? null}, ${i.sourceRef ?? null}, ${user.id})
        returning id
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "engagement.context_added",
        entity: "client_engagement",
        entityId: e.id,
        projectId: e.projectId,
        detail: { kind: i.kind, label: i.label, provenance: i.provenance, accessStatus: i.accessStatus ?? null },
      });
      return row!.id as string;
    });
    return ok({ itemId: id });
  } catch (err) {
    return fail(err);
  }
}

export async function setAccessStatus(user: CurrentUser, raw: unknown): Promise<ActionResult<{ itemId: string }>> {
  const parsed = z.object({ itemId: idSchema, accessStatus: z.enum(ACCESS_STATUSES) }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const [item] = await tx`select id, project_id, engagement_id, kind, access_status from engagement_context_items where id = ${parsed.data.itemId} for update`;
      if (!item) throw new ClassifiedError("not_found", "Context item not found.");
      if (item.kind !== "access") throw new ClassifiedError("validation", "Only access items carry an access status.");
      await tx`update engagement_context_items set access_status = ${parsed.data.accessStatus}, updated_at = now() where id = ${item.id}`;
      await writeAudit(tx, {
        userId: user.id,
        action: "engagement.access_status",
        entity: "client_engagement",
        entityId: item.engagementId as string,
        projectId: item.projectId as string,
        detail: { itemId: item.id, from: item.accessStatus, to: parsed.data.accessStatus },
      });
    });
    return ok({ itemId: parsed.data.itemId });
  } catch (err) {
    return fail(err);
  }
}

export interface ContextItem {
  id: string;
  kind: string;
  label: string;
  value: Record<string, unknown>;
  provenance: string;
  accessStatus: string | null;
  sourceRef: string | null;
  createdAt: Date;
}

export async function listContextItems(engagementId: string): Promise<ContextItem[]> {
  const rows = await sql`
    select id, kind, label, value, provenance, access_status, source_ref, created_at
    from engagement_context_items where engagement_id = ${engagementId}
    order by kind, created_at
  `;
  return rows.map((r) => ({
    id: r.id as string,
    kind: r.kind as string,
    label: r.label as string,
    value: (r.value as Record<string, unknown>) ?? {},
    provenance: r.provenance as string,
    accessStatus: (r.accessStatus as string | null) ?? null,
    sourceRef: (r.sourceRef as string | null) ?? null,
    createdAt: r.createdAt as Date,
  }));
}

// ----------------------------------------------------------- measurement

export interface MeasurementRow {
  id: string;
  role: string;
  status: string;
  scheduledFor: string | null;
  reason: string;
  runId: string | null;
  provider: string | null;
  snapshot: MeasurementSnapshot | null;
  comparability: MeasurementComparability | null;
  comparison: MeasurementComparison | null;
  frozenAt: Date | null;
  statusDetail: string | null;
}

export async function listMeasurements(engagementId: string): Promise<MeasurementRow[]> {
  const rows = await sql`
    select id, role, status, scheduled_for, reason, run_id, provider, snapshot, comparability, comparison, frozen_at, status_detail
    from engagement_measurements where engagement_id = ${engagementId}
    order by (role = 'baseline') desc, coalesce(scheduled_for, frozen_at::date, created_at::date) asc, created_at asc
  `;
  return rows.map((r) => ({
    id: r.id as string,
    role: r.role as string,
    status: r.status as string,
    scheduledFor: r.scheduledFor ? toIso(r.scheduledFor) : null,
    reason: (r.reason as string) ?? "",
    runId: (r.runId as string | null) ?? null,
    provider: (r.provider as string | null) ?? null,
    snapshot: (r.snapshot as MeasurementSnapshot | null) ?? null,
    comparability: (r.comparability as MeasurementComparability | null) ?? null,
    comparison: (r.comparison as MeasurementComparison | null) ?? null,
    frozenAt: (r.frozenAt as Date | null) ?? null,
    statusDetail: (r.statusDetail as string | null) ?? null,
  }));
}

async function frozenBaseline(engagementId: string): Promise<MeasurementRow | null> {
  const rows = await listMeasurements(engagementId);
  return rows.find((m) => m.role === "baseline" && m.status === "frozen") ?? null;
}

async function competitorIds(projectId: string): Promise<string[]> {
  const rows = await listComparisonCompanies(projectId);
  return rows.filter((r) => !r.isSelf).map((r) => r.companyId);
}

const freezeSchema = z.object({
  engagementId: idSchema,
  /** Defaults to the prospect's linked benchmark run. */
  runId: idSchema.optional(),
  provider: z.string().min(1).default(DEFAULT_PROVIDER),
});

/**
 * DAY 0: freeze the baseline package over the pre-sale benchmark run — the
 * corrected evidence (spec 130), never the historical email claim. Refuses a
 * second baseline; the row is immutable once frozen.
 */
export async function freezeBaseline(user: CurrentUser, raw: unknown): Promise<ActionResult<{ measurementId: string; snapshot: MeasurementSnapshot }>> {
  const parsed = freezeSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const input = parsed.data;
  try {
    assertCanWrite(user);
    const e = await getEngagement(input.engagementId);
    if (!e) return fail(new ClassifiedError("not_found", "Engagement not found."));
    if (await frozenBaseline(e.id)) return fail(new ClassifiedError("conflict", "This engagement already has a frozen baseline. A baseline never changes; record a new measurement instead."));
    let runId = input.runId ?? null;
    if (!runId && e.prospectId) {
      const [bench] = await sql`
        select run_id from prospect_benchmarks where prospect_id = ${e.prospectId} order by created_at desc limit 1
      `;
      runId = (bench?.runId as string | null) ?? null;
    }
    if (!runId) return fail(new ClassifiedError("validation", "No benchmark run to freeze: link the prospect benchmark or pass a run id."));
    const instrument = await runInstrument(runId);
    if (!instrument) return fail(new ClassifiedError("not_found", "Run not found."));
    if (instrument.status !== "completed" && instrument.status !== "partial") {
      return fail(new ClassifiedError("validation", `Run is ${instrument.status}; only a finished run can be a baseline.`));
    }
    const subject = await getSubjectCompany(e.projectId);
    if (!subject) return fail(new ClassifiedError("validation", "The client project has no subject company."));
    const competitors = await competitorIds(e.projectId);
    const snapshot = await buildMeasurementSnapshot({
      runId,
      provider: input.provider,
      subjectCompanyId: subject.id,
      competitorCompanyIds: competitors,
    });
    if (snapshot.answerCount === 0) return fail(new ClassifiedError("validation", `The run has no valid ${input.provider} answers.`));
    const id = await sql.begin(async (tx) => {
      const [row] = await tx`
        insert into engagement_measurements (engagement_id, project_id, role, status, reason, run_id, provider,
          prompt_set_version_id, subject_company_id, competitor_company_ids, snapshot, frozen_at, created_by)
        values (${e.id}, ${e.projectId}, 'baseline', 'frozen', 'Day 0 baseline over the pre-sale benchmark (corrected evidence).',
          ${runId}, ${input.provider}, ${snapshot.promptSetVersionId}, ${subject.id}, ${competitors}::uuid[],
          ${tx.json(snapshot as never)}, now(), ${user.id})
        returning id
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "engagement.baseline_frozen",
        entity: "client_engagement",
        entityId: e.id,
        projectId: e.projectId,
        detail: {
          runId,
          provider: input.provider,
          answerCount: snapshot.answerCount,
          subjectRecommended: snapshot.subject.recommendedCount,
          competitors: snapshot.competitors.map((c) => ({ name: c.name, recommended: c.recommendedCount })),
        },
      });
      return row!.id as string;
    });
    return ok({ measurementId: id, snapshot });
  } catch (err) {
    return fail(err);
  }
}

const recordMeasurementSchema = z.object({
  engagementId: idSchema,
  runId: idSchema,
  /** Fill a planned slot; omit for an ad-hoc measurement. */
  measurementId: idSchema.optional(),
  role: z.enum(MEASUREMENT_ROLES).default("adhoc"),
});

/**
 * REMEASURE: freeze a new snapshot over a finished run and compare it to the
 * frozen baseline under the comparability rules. Non-comparable instruments
 * are recorded as such — never a fake progress number.
 */
export async function recordMeasurement(user: CurrentUser, raw: unknown): Promise<ActionResult<{ measurementId: string; comparability: MeasurementComparability; comparison: MeasurementComparison | null }>> {
  const parsed = recordMeasurementSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const input = parsed.data;
  try {
    assertCanWrite(user);
    const e = await getEngagement(input.engagementId);
    if (!e) return fail(new ClassifiedError("not_found", "Engagement not found."));
    const baseline = await frozenBaseline(e.id);
    if (!baseline?.snapshot) return fail(new ClassifiedError("validation", "Freeze the baseline before recording a remeasurement."));
    const instrument = await runInstrument(input.runId);
    if (!instrument) return fail(new ClassifiedError("not_found", "Run not found."));
    if (instrument.status !== "completed" && instrument.status !== "partial") {
      return fail(new ClassifiedError("validation", `Run is ${instrument.status}; wait for it to finish (a failed run is recorded as failed, never filled in).`));
    }
    const snapshot = await buildMeasurementSnapshot({
      runId: input.runId,
      provider: baseline.snapshot.provider,
      subjectCompanyId: baseline.snapshot.subject.companyId,
      competitorCompanyIds: baseline.snapshot.competitors.map((c) => c.companyId),
    });
    const comparability = assessMeasurementComparability(baseline.snapshot, snapshot);
    const comparable = comparability.grade !== "not_comparable";
    const comparison = comparable ? compareMeasurements(baseline.snapshot, snapshot) : null;
    const status = comparable ? "frozen" : "non_comparable";
    const id = await sql.begin(async (tx) => {
      let measurementId = input.measurementId ?? null;
      if (measurementId) {
        const [planned] = await tx`select id, status, role from engagement_measurements where id = ${measurementId} and engagement_id = ${e.id} for update`;
        if (!planned) throw new ClassifiedError("not_found", "Planned measurement not found.");
        if (planned.status !== "planned") throw new ClassifiedError("conflict", `Measurement slot is ${planned.status}.`);
        await tx`
          update engagement_measurements set status = ${status}, run_id = ${input.runId}, provider = ${snapshot.provider},
            prompt_set_version_id = ${snapshot.promptSetVersionId}, subject_company_id = ${snapshot.subject.companyId},
            competitor_company_ids = ${snapshot.competitors.map((c) => c.companyId)}::uuid[],
            snapshot = ${tx.json(snapshot as never)}, comparability = ${tx.json(comparability as never)},
            comparison = ${comparison ? tx.json(comparison as never) : null}, frozen_at = now(),
            status_detail = ${comparability.reasons.join("; ") || null}
          where id = ${measurementId}
        `;
      } else {
        const [row] = await tx`
          insert into engagement_measurements (engagement_id, project_id, role, status, reason, run_id, provider,
            prompt_set_version_id, subject_company_id, competitor_company_ids, snapshot, comparability, comparison, frozen_at, status_detail, created_by)
          values (${e.id}, ${e.projectId}, ${input.role}, ${status}, 'Ad-hoc remeasurement.', ${input.runId}, ${snapshot.provider},
            ${snapshot.promptSetVersionId}, ${snapshot.subject.companyId}, ${snapshot.competitors.map((c) => c.companyId)}::uuid[],
            ${tx.json(snapshot as never)}, ${tx.json(comparability as never)}, ${comparison ? tx.json(comparison as never) : null}, now(),
            ${comparability.reasons.join("; ") || null}, ${user.id})
          returning id
        `;
        measurementId = row!.id as string;
      }
      await writeAudit(tx, {
        userId: user.id,
        action: "engagement.measurement_recorded",
        entity: "client_engagement",
        entityId: e.id,
        projectId: e.projectId,
        detail: { measurementId, runId: input.runId, grade: comparability.grade, reasons: comparability.reasons, subject: plain(comparison?.subject ?? null) },
      });
      return measurementId!;
    });
    return ok({ measurementId: id, comparability, comparison });
  } catch (err) {
    return fail(err);
  }
}

// ----------------------------------------------------- close / renew

const closeSchema = z.object({
  engagementId: idSchema,
  outcome: z.enum(["completed", "churned"]),
  reason: z.string().trim().min(5).max(2000),
  cooldownDays: z.number().int().min(0).max(3650).default(FORMER_CLIENT_COOLDOWN_DAYS),
});

export interface CloseResult {
  engagementId: string;
  agreementTerminatedOn: string | null;
  portalGrantsRevoked: number;
  measurementsCancelled: number;
  cooldownUntil: string;
}

/**
 * OFFBOARD: exclusivity released on the contract end date (or today if
 * later), portal doors closed, planned measurements cancelled, the former
 * client's prospect flagged do-not-contact through the cooldown so cold
 * prospecting never resumes by accident. Records stay historical.
 */
export async function closeEngagement(user: CurrentUser, raw: unknown): Promise<ActionResult<CloseResult>> {
  const parsed = closeSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const input = parsed.data;
  try {
    assertRole(user, "admin");
    const e = await getEngagement(input.engagementId);
    if (!e) return fail(new ClassifiedError("not_found", "Engagement not found."));
    if (!LIVE_ENGAGEMENT_STAGES.includes(e.stage)) return fail(new ClassifiedError("conflict", `Engagement is already ${e.stage}.`));
    const today = todayIso();
    const releaseOn = e.endsOn > today ? e.endsOn : today;
    let agreementTerminatedOn: string | null = null;
    if (e.exclusivityAgreementId && e.exclusivityStatus !== "terminated") {
      const t = await terminateAgreement(user, { agreementId: e.exclusivityAgreementId, terminatedAt: releaseOn });
      if (!t.ok) return t;
      agreementTerminatedOn = releaseOn;
    }
    let revoked = 0;
    for (const grant of await listPortalGrants(e.projectId)) {
      const r = await revokeClientAccess(user, { userId: grant.userId, projectId: e.projectId });
      if (r.ok && r.data.revoked) revoked += 1;
    }
    const cooldownUntil = addDays(releaseOn, input.cooldownDays);
    const cancelled = await sql.begin(async (tx) => {
      const locked = await loadEngagementForWrite(tx, e.id);
      const rows = await tx`
        update engagement_measurements set status = 'cancelled', status_detail = ${`Engagement closed: ${input.reason}`}
        where engagement_id = ${e.id} and status = 'planned' returning id
      `;
      await tx`
        update client_engagements set closed_at = now(), close_reason = ${input.reason}, cooldown_until = ${cooldownUntil},
          renewal_status = case when renewal_status in ('renewed') then renewal_status else 'declined' end, updated_at = now()
        where id = ${e.id}
      `;
      await setStage(tx, user, locked, input.outcome, { reason: input.reason, releaseOn, cooldownUntil, revoked });
      if (e.prospectId) {
        await tx`
          update prospects set do_not_contact = true,
            do_not_contact_reason = ${`Former client (engagement ended ${releaseOn}); commercial cooldown until ${cooldownUntil}. Founder decision required before any outreach.`},
            updated_at = now()
          where id = ${e.prospectId}
        `;
        await logActivity(tx, e.prospectId, "engagement_closed", { engagementId: e.id, outcome: input.outcome, cooldownUntil }, user.id);
      }
      return rows.length;
    });
    return ok({ engagementId: e.id, agreementTerminatedOn, portalGrantsRevoked: revoked, measurementsCancelled: cancelled, cooldownUntil });
  } catch (err) {
    return fail(err);
  }
}

export async function setRenewalStatus(user: CurrentUser, raw: unknown): Promise<ActionResult<{ engagementId: string }>> {
  const parsed = z.object({ engagementId: idSchema, status: z.enum(["offered", "declined"]), note: z.string().trim().max(1000).default("") }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const e = await loadEngagementForWrite(tx, parsed.data.engagementId);
      await tx`update client_engagements set renewal_status = ${parsed.data.status}, updated_at = now() where id = ${e.id}`;
      await writeAudit(tx, { userId: user.id, action: "engagement.renewal_status", entity: "client_engagement", entityId: e.id, projectId: e.projectId, detail: parsed.data });
    });
    return ok({ engagementId: parsed.data.engagementId });
  } catch (err) {
    return fail(err);
  }
}

const renewSchema = z.object({
  engagementId: idSchema,
  startsOn: dateSchema.optional(),
  termDays: z.number().int().min(30).max(730).default(DEFAULT_TERM_DAYS),
  monthlyFeeUsd: z.number().nonnegative(),
  totalValueUsd: z.number().nonnegative(),
  scopeSummary: z.string().trim().min(20).max(4000).optional(),
});

/** RENEW: the current row closes as `renewed`; a new term row starts
 * `signed` (its own contract + payment gate) and carries the baseline
 * lineage through previous_engagement_id. Exclusivity continues on a new
 * reserved agreement for the new dates. Never automatic. */
export async function renewEngagement(user: CurrentUser, raw: unknown): Promise<ActionResult<{ engagementId: string; agreementId: string }>> {
  const parsed = renewSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const input = parsed.data;
  try {
    assertRole(user, "admin");
    const e = await getEngagement(input.engagementId);
    if (!e) return fail(new ClassifiedError("not_found", "Engagement not found."));
    if (!LIVE_ENGAGEMENT_STAGES.includes(e.stage)) return fail(new ClassifiedError("conflict", `Engagement is ${e.stage}.`));
    const startsOn = input.startsOn ?? e.endsOn;
    const dates = termDates(startsOn, input.termDays);
    const [scope] = await sql`select market_id, service_category, segment from exclusivity_scopes where agreement_id = ${e.exclusivityAgreementId} limit 1`;
    const agreement = await createAgreement(user, {
      projectId: e.projectId,
      startsOn,
      endsOn: dates.endsOn,
      gracePeriodDays: 0,
      status: "reserved",
      notes: `Renewal of engagement ${e.id} (spec 131).`,
      scopes: [{ marketId: (scope?.marketId as string) ?? e.marketId, serviceCategory: (scope?.serviceCategory as string | null) ?? null, segment: (scope?.segment as string | null) ?? null }],
    });
    if (!agreement.ok) return agreement;
    const plan = measurementSchedule(startsOn, dates.endsOn);
    const newId = await sql.begin(async (tx) => {
      const locked = await loadEngagementForWrite(tx, e.id);
      await tx`update client_engagements set renewal_status = 'renewed', closed_at = now(), close_reason = 'Renewed.', updated_at = now() where id = ${e.id}`;
      await setStage(tx, user, locked, "renewed");
      const [row] = await tx`
        insert into client_engagements (
          project_id, prospect_id, market_id, exclusivity_agreement_id, previous_engagement_id, primary_contact_id,
          primary_contact_name, owner_id, starts_on, ends_on, monthly_fee_usd, total_value_usd, billing_cadence, payment_terms,
          scope_summary, scope_exclusions, market_definition, market_definition_confirmed_at, market_definition_confirmed_by,
          renewal_review_on, case_study_permission, testimonial_permission, logo_permission, anonymized_data_permission, created_by
        ) values (
          ${e.projectId}, ${e.prospectId}, ${e.marketId}, ${agreement.data.agreementId}, ${e.id}, ${e.primaryContactId},
          ${e.primaryContactName}, ${e.ownerId}, ${startsOn}, ${dates.endsOn}, ${input.monthlyFeeUsd}, ${input.totalValueUsd},
          ${e.billingCadence}, ${e.paymentTerms}, ${input.scopeSummary ?? e.scopeSummary}, ${e.scopeExclusions},
          ${e.marketDefinition}, ${e.marketDefinitionConfirmedAt}, ${e.marketDefinitionConfirmedAt ? user.id : null},
          ${dates.renewalReviewOn}, ${e.caseStudyPermission}, ${e.testimonialPermission}, ${e.logoPermission}, ${e.anonymizedDataPermission}, ${user.id}
        ) returning id
      `;
      const id = row!.id as string;
      for (const m of plan) {
        await tx`
          insert into engagement_measurements (engagement_id, project_id, role, status, scheduled_for, reason, created_by)
          values (${id}, ${e.projectId}, ${m.role}, 'planned', ${m.scheduledFor}, ${m.reason}, ${user.id})
        `;
      }
      await writeAudit(tx, { userId: user.id, action: "engagement.renewed", entity: "client_engagement", entityId: id, projectId: e.projectId, detail: { previousEngagementId: e.id, agreementId: agreement.data.agreementId } });
      return id;
    });
    return ok({ engagementId: newId, agreementId: agreement.data.agreementId });
  } catch (err) {
    return fail(err);
  }
}

// ------------------------------------------------- client communication

export async function recordClientUpdateSent(user: CurrentUser, raw: unknown): Promise<ActionResult<{ engagementId: string }>> {
  const parsed = z.object({ engagementId: idSchema, channel: z.enum(["email", "call", "meeting", "portal", "other"]), summary: z.string().trim().min(5).max(4000) }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const e = await loadEngagementForWrite(tx, parsed.data.engagementId);
      await writeAudit(tx, { userId: user.id, action: "engagement.client_update_sent", entity: "client_engagement", entityId: e.id, projectId: e.projectId, detail: { channel: parsed.data.channel, summary: parsed.data.summary } });
    });
    return ok({ engagementId: parsed.data.engagementId });
  } catch (err) {
    return fail(err);
  }
}

// ------------------------------------------------------------ overview

export interface WorkItemView {
  id: string;
  title: string;
  status: string;
  priority: string;
  clientVisible: boolean;
  observation: string | null;
  hypothesis: string | null;
  confidence: string | null;
  control: string | null;
  scope: string;
  clientApproval: string;
  blockedReason: string | null;
  blockedNote: string | null;
  targetUrl: string | null;
  beforeState: string | null;
  afterState: string | null;
  implementedAt: Date | null;
  dueDate: string | null;
  updatedAt: Date;
  evidenceCount: number;
}

export async function listWorkItems(projectId: string): Promise<WorkItemView[]> {
  const rows = await sql`
    select id, title, status, priority, client_visible, observation, hypothesis, confidence, control, scope,
      client_approval, blocked_reason, blocked_note, target_url, before_state, after_state, implemented_at,
      due_date, updated_at, cardinality(evidence_ids) as evidence_count
    from tasks where project_id = ${projectId}
    order by (status = 'in_progress') desc, (status = 'approved') desc, (status = 'suggested') desc, updated_at desc
  `;
  return rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    status: r.status as string,
    priority: r.priority as string,
    clientVisible: Boolean(r.clientVisible),
    observation: (r.observation as string | null) ?? null,
    hypothesis: (r.hypothesis as string | null) ?? null,
    confidence: (r.confidence as string | null) ?? null,
    control: (r.control as string | null) ?? null,
    scope: r.scope as string,
    clientApproval: r.clientApproval as string,
    blockedReason: (r.blockedReason as string | null) ?? null,
    blockedNote: (r.blockedNote as string | null) ?? null,
    targetUrl: (r.targetUrl as string | null) ?? null,
    beforeState: (r.beforeState as string | null) ?? null,
    afterState: (r.afterState as string | null) ?? null,
    implementedAt: (r.implementedAt as Date | null) ?? null,
    dueDate: r.dueDate ? toIso(r.dueDate) : null,
    updatedAt: r.updatedAt as Date,
    evidenceCount: Number(r.evidenceCount ?? 0),
  }));
}

export interface ChangeLogEntry {
  kind: "task" | "intervention" | "content";
  id: string;
  at: Date;
  title: string;
  targetUrl: string | null;
  before: string | null;
  after: string | null;
  reason: string | null;
  clientVisible: boolean;
  approval: string | null;
}

/** What actually changed, from canonical rows: implemented tasks (with
 * before/after), shipped interventions, published content. */
export async function changeLog(projectId: string): Promise<ChangeLogEntry[]> {
  const tasks = await sql`
    select id, title, coalesce(implemented_at, updated_at) as at, target_url, before_state, after_state, hypothesis, client_visible, client_approval
    from tasks where project_id = ${projectId} and status = 'done'
  `;
  const interventions = await sql`
    select id, title, shipped_at as at, urls, hypothesis, client_visible from interventions
    where project_id = ${projectId} and archived_at is null
  `;
  const content = await sql`
    select id, title, updated_at as at from content_assets where project_id = ${projectId} and status = 'published'
  `;
  const entries: ChangeLogEntry[] = [
    ...tasks.map((t) => ({
      kind: "task" as const,
      id: t.id as string,
      at: t.at as Date,
      title: t.title as string,
      targetUrl: (t.targetUrl as string | null) ?? null,
      before: (t.beforeState as string | null) ?? null,
      after: (t.afterState as string | null) ?? null,
      reason: (t.hypothesis as string | null) ?? null,
      clientVisible: Boolean(t.clientVisible),
      approval: t.clientApproval as string,
    })),
    ...interventions.map((i) => ({
      kind: "intervention" as const,
      id: i.id as string,
      at: new Date(i.at as Date),
      title: i.title as string,
      targetUrl: ((i.urls as string[]) ?? [])[0] ?? null,
      before: null,
      after: null,
      reason: (i.hypothesis as string | null) ?? null,
      clientVisible: Boolean(i.clientVisible),
      approval: null,
    })),
    ...content.map((c) => ({
      kind: "content" as const,
      id: c.id as string,
      at: c.at as Date,
      title: c.title as string,
      targetUrl: null,
      before: null,
      after: "Published",
      reason: null,
      clientVisible: true,
      approval: null,
    })),
  ];
  return entries.sort((a, b) => b.at.getTime() - a.at.getTime());
}

async function computeChecklist(e: EngagementRow): Promise<ChecklistItem[]> {
  const [subject, items, measurements, tasks, cents, conflicts] = await Promise.all([
    getSubjectCompany(e.projectId),
    listContextItems(e.id),
    listMeasurements(e.id),
    listWorkItems(e.projectId),
    paymentsReceivedCents(e.id, e.projectId),
    liveEngagementConflicts(e.marketId, e.projectId),
  ]);
  return onboardingChecklist({
    contractStatus: e.contractStatus,
    paymentsReceivedCents: cents,
    activationOverrideReason: e.activationOverrideReason,
    subjectLinked: Boolean(subject),
    primaryContactNamed: e.primaryContactName.trim().length > 0,
    marketDefinitionConfirmed: Boolean(e.marketDefinitionConfirmedAt),
    exclusivityStatus: e.exclusivityStatus,
    exclusivityConflictFree: conflicts.length === 0,
    priorityItems: items.filter((i) => i.provenance === "client_priority").length,
    assetItems: items.filter((i) => i.kind === "asset").length,
    accessRequestedOpen: items.filter((i) => i.kind === "access" && i.accessStatus === "requested").length,
    baselineFrozen: measurements.some((m) => m.role === "baseline" && m.status === "frozen"),
    planItems: tasks.filter((t) => t.status !== "rejected").length,
  });
}

export interface EngagementOverview {
  engagement: EngagementRow;
  derivedStage: EngagementStage;
  renewalStatus: RenewalStatus;
  commercial: GateVerdict;
  checklist: ChecklistItem[];
  onboardingDone: boolean;
  signals: HealthSignal[];
  nextAction: string;
  work: WorkItemView[];
  context: ContextItem[];
  measurements: MeasurementRow[];
  nextMeasurement: MeasurementRow | null;
  billing: BillingSummary;
  changes: ChangeLogEntry[];
  lastClientUpdate: { at: Date; channel: string; summary: string } | null;
  weeklyUpdate: string;
  marketConflicts: MarketConflict[];
  portalGrants: number;
}

/** Everything the operator client page needs, in one read. */
export async function engagementOverview(projectId: string, now = new Date()): Promise<EngagementOverview | null> {
  const e = await engagementForProject(projectId);
  if (!e) return null;
  const today = todayIso(now);
  const [checklist, work, context, measurements, billing, changes, lastUpdateRows, marketConflicts, grants, projectRow] = await Promise.all([
    computeChecklist(e),
    listWorkItems(e.projectId),
    listContextItems(e.id),
    listMeasurements(e.id),
    billingSummary(e.id, e.projectId, today),
    changeLog(e.projectId),
    sql`select at, detail from audit_log where entity = 'client_engagement' and entity_id = ${e.id} and action = 'engagement.client_update_sent' order by at desc limit 1`,
    liveEngagementConflicts(e.marketId, e.projectId),
    listPortalGrants(e.projectId),
    sql`select name from projects where id = ${e.projectId}`,
  ]);
  const commercial = commercialGate({
    contractStatus: e.contractStatus,
    paymentsReceivedCents: await paymentsReceivedCents(e.id, e.projectId),
    activationOverrideReason: e.activationOverrideReason,
  });
  const derivedStage = deriveStage(e.stage, e.renewalReviewOn, today);
  const renewalStatus = deriveRenewalStatus({ endsOn: e.endsOn, renewalReviewOn: e.renewalReviewOn, stored: e.renewalStatus, stage: e.stage }, today);
  const planned = measurements.filter((m) => m.status === "planned" && m.scheduledFor).sort((a, b) => a.scheduledFor!.localeCompare(b.scheduledFor!));
  const nextMeasurement = planned[0] ?? null;
  const openApprovals = work.filter((t) => t.clientApproval === "required" && t.status !== "rejected").length;
  const blockedOnClient = work.filter((t) => t.blockedReason === "client_access" || t.blockedReason === "client_approval" || t.blockedReason === "client_input").length;
  const blockedOnUs = work.filter((t) => t.blockedReason === "third_party" || t.blockedReason === "internal").length;
  const lastUpdate = lastUpdateRows[0]
    ? { at: lastUpdateRows[0].at as Date, channel: String((lastUpdateRows[0].detail as Record<string, unknown>).channel), summary: String((lastUpdateRows[0].detail as Record<string, unknown>).summary) }
    : null;
  const onboardingDone = onboardingComplete(checklist);
  const signals = healthSignals({
    stage: derivedStage,
    onboardingDone,
    openApprovals,
    blockedOnClient,
    blockedOnUs,
    tasksInProgress: work.filter((t) => t.status === "in_progress").length,
    tasksDone: work.filter((t) => t.status === "done").length,
    nextMeasurementOn: nextMeasurement?.scheduledFor ?? null,
    overdueInvoices: billing.overdueCount,
    lastClientUpdateOn: lastUpdate ? lastUpdate.at.toISOString().slice(0, 10) : null,
    renewalStatus,
    today,
  });
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const latestFrozen = measurements.filter((m) => m.role !== "baseline" && m.status !== "planned" && m.frozenAt && m.frozenAt >= weekAgo)[0];
  const weeklyUpdate = composeWeeklyUpdate({
    clientName: (projectRow[0]?.name as string) ?? "Client",
    weekEnding: today,
    done: changes.filter((c) => c.clientVisible && c.at >= weekAgo).map((c) => `${c.title}${c.targetUrl ? ` (${c.targetUrl})` : ""}${c.after ? ` — now: ${c.after}` : ""}`),
    inProgress: work.filter((t) => t.status === "in_progress" && t.clientVisible).map((t) => t.title),
    needFromYou: [
      ...work.filter((t) => t.clientApproval === "required" && t.clientVisible).map((t) => `Approve: ${t.title}`),
      ...work.filter((t) => (t.blockedReason === "client_access" || t.blockedReason === "client_input") && t.clientVisible).map((t) => `${t.blockedReason === "client_access" ? "Access" : "Input"} needed: ${t.title}${t.blockedNote ? ` — ${t.blockedNote}` : ""}`),
    ],
    measurement: latestFrozen
      ? latestFrozen.comparison
        ? `- ${latestFrozen.comparison.statement} Comparability: ${latestFrozen.comparability?.grade}.`
        : `- A remeasurement ran but is NON-COMPARABLE to the baseline (${latestFrozen.statusDetail ?? "instrument changed"}); no before/after is claimed.`
      : null,
    next: [
      ...work.filter((t) => t.status === "approved" && t.clientVisible).slice(0, 3).map((t) => `Start: ${t.title}`),
      ...(nextMeasurement ? [`Remeasurement (${nextMeasurement.role}) scheduled for ${nextMeasurement.scheduledFor}.`] : []),
    ],
  });
  return {
    engagement: e,
    derivedStage,
    renewalStatus,
    commercial,
    checklist,
    onboardingDone,
    signals,
    nextAction: nextAction({
      stage: derivedStage,
      commercial,
      checklist,
      openApprovals,
      blockedOnClient,
      measurementDue: Boolean(nextMeasurement && nextMeasurement.scheduledFor! <= today),
      renewalStatus,
    }),
    work,
    context,
    measurements,
    nextMeasurement,
    billing,
    changes,
    lastClientUpdate: lastUpdate,
    weeklyUpdate,
    marketConflicts,
    portalGrants: grants.length,
  };
}

// --------------------------------------------- market outreach conflicts

export interface MarketOutreachConflict {
  prospectId: string;
  businessName: string;
  stage: string;
  scheduledDrafts: number;
  activeSequences: number;
}

/** Prospects in the protected market (same node or inside it) that are
 * still being sold to — the sweep the founder runs when exclusivity
 * activates. The client's own prospect record is excluded. */
export async function marketOutreachConflicts(engagementId: string): Promise<MarketOutreachConflict[]> {
  const e = await getEngagement(engagementId);
  if (!e) return [];
  const markets = await sql<MarketNode[]>`select id, name, parent_id from markets`;
  const { geoRelation } = await import("@/lib/exclusivity/detect");
  const inside = markets.filter((m) => {
    const rel = geoRelation(m.id, e.marketId, markets);
    return rel === "same" || rel === "inside";
  }).map((m) => m.id);
  const rows = await sql`
    select p.id, p.business_name, p.stage,
      (select count(*)::int from outreach_drafts d where d.prospect_id = p.id and d.status = 'approved'
         and d.sent_recorded_at is null and d.scheduled_send_at is not null) as scheduled_drafts,
      (select count(*)::int from outreach_followup_sequences s where s.prospect_id = p.id and s.status = 'active') as active_sequences
    from prospects p join market_launches l on l.id = p.launch_id
    where l.market_id = any(${inside}::uuid[]) and p.archived_at is null
      and (p.promoted_project_id is null or p.promoted_project_id != ${e.projectId})
      and p.stage not in ('closed_lost', 'waitlisted', 'conflict_blocked', 'contracted')
    order by p.stage, p.business_name
  `;
  return rows.map((r) => ({
    prospectId: r.id as string,
    businessName: r.businessName as string,
    stage: r.stage as string,
    scheduledDrafts: Number(r.scheduledDrafts ?? 0),
    activeSequences: Number(r.activeSequences ?? 0),
  }));
}

/**
 * Pause the sales motion in the protected market: unschedule queued drafts
 * (they stay approved, unsent, with the reason), pause active sequences,
 * and mark each prospect's conflict status. Prospects remain — a former
 * or future opportunity — but nothing leaves for them while the client's
 * territory is protected.
 */
export async function pauseMarketOutreach(user: CurrentUser, raw: unknown): Promise<ActionResult<{ prospects: number; draftsUnscheduled: number; sequencesPaused: number }>> {
  const parsed = z.object({ engagementId: idSchema }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", "Invalid engagement id."));
  try {
    assertCanWrite(user);
    const e = await getEngagement(parsed.data.engagementId);
    if (!e) return fail(new ClassifiedError("not_found", "Engagement not found."));
    if (e.exclusivityStatus !== "active" && e.exclusivityStatus !== "reserved") {
      return fail(new ClassifiedError("validation", "No live territory agreement to protect."));
    }
    const conflicts = await marketOutreachConflicts(e.id);
    const { pauseFollowupSequence } = await import("@/lib/prospects/followups");
    let drafts = 0;
    let sequences = 0;
    for (const c of conflicts) {
      const reason = `Market exclusivity: ${e.marketName} is protected for a retained client (engagement ${e.id.slice(0, 8)}).`;
      const seqRows = await sql`select id from outreach_followup_sequences where prospect_id = ${c.prospectId} and status = 'active'`;
      for (const s of seqRows) {
        const r = await pauseFollowupSequence(user, { sequenceId: s.id as string, reason: reason.slice(0, 300) });
        if (r.ok) sequences += 1;
      }
      await sql.begin(async (tx) => {
        const updated = await tx`
          update outreach_drafts set scheduled_send_at = null, last_send_error = ${reason}
          where prospect_id = ${c.prospectId} and status = 'approved' and sent_recorded_at is null and scheduled_send_at is not null
          returning id
        `;
        drafts += updated.length;
        await tx`update prospects set conflict_status = 'blocked', updated_at = now() where id = ${c.prospectId}`;
        await logActivity(tx, c.prospectId, "exclusivity_paused_outreach", { engagementId: e.id, drafts: updated.length }, user.id);
      });
    }
    await sql.begin(async (tx) => {
      await writeAudit(tx, { userId: user.id, action: "engagement.market_outreach_paused", entity: "client_engagement", entityId: e.id, projectId: e.projectId, detail: { prospects: conflicts.length, drafts, sequences } });
    });
    return ok({ prospects: conflicts.length, draftsUnscheduled: drafts, sequencesPaused: sequences });
  } catch (err) {
    return fail(err);
  }
}
