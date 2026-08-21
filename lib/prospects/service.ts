/**
 * Prospect acquisition service (spec 032). Staff-only throughout — client
 * roles are denied by assertCanWrite on writes and never reach the reads
 * (the /prospects segment is staff-gated and nothing here is imported by
 * portal code). All writes are transactional with audit rows; the prospect
 * timeline (`prospect_activities`) is written alongside.
 *
 * Nothing in this module sends anything or calls an AI provider.
 */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { sql } from "@/db/client";
import type { TransactionSql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, assertRole, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage, duplicateNameConflict } from "@/lib/service-helpers";
import {} from "@/lib/exclusivity/detect";
import { createAgreement } from "@/lib/exclusivity/service";
import { createProject } from "@/lib/projects/service";
import { upsertCompany } from "@/lib/companies/service";
import { addCompetitor } from "@/lib/competitors/service";
import { setSubjectCompany } from "@/lib/claims/service";
import {
  ALL_PROSPECT_STAGES,
  ASSESSMENT_ITEMS,
  ASSESSMENT_VALUES,
  AUTHORITY_SIGNAL_KINDS,
  CONTACT_CHANNELS,
  todayIso,
  FINDING_GENERATOR_VERSION,
  LAUNCH_STATUSES,
  OUTREACH_CHANNELS,
  PROSPECT_SOURCES,
  PROSPECT_TYPES,
  PROVENANCE_LABELS,
  SIGNAL_SOURCE_TYPES,
  RECORDING_STATUSES,
  RELATIONSHIP_STRENGTHS,
  findProhibitedPhrase,
  type ConflictStatus,
  type ProspectStage,
  type ProspectType,
  RECONTACT_PERSON_WINDOW_DAYS,
  BROKERAGE_SEND_CAP_30D,
  GMAIL_DAILY_SEND_CAP,
  SCHEDULED_SEND_MAX_DAYS_AHEAD,
  UNATTENDED_SEND_BLOCKED_STAGES,
  CONTACT_GATE_STAGE,
  PRE_CONTACT_STAGES,
} from "@/lib/prospects/constants";
import { validateTransition } from "@/lib/prospects/stages";
import {
  generateFindingCandidates,
  type BenchmarkEntityMetrics,
} from "@/lib/prospects/findings";
// removed-unused: PROMPT_ECHO_EXCLUDED
import {} from "@/lib/scoring/prompt-echo";
// removed-unused: latestVerifiedProduction
import {} from "@/lib/prospects/realtrends";
import {
  absenceEvidence,
  promptEvidenceForResponses,
  prospectAbsentResponses,
  runSummary,
  scoredEntities,

  type RunSummary,
} from "@/lib/prospects/benchmark";
import { generateReplyFirstEmail } from "@/lib/prospects/outreach";
import { generateRecordingPlan as buildRecordingPlan } from "@/lib/prospects/recording";
import { parseProspectImport, type ImportRow } from "@/lib/prospects/import";
import { checkSuppression } from "@/lib/outreach/suppression";
// removed-unused: authorityGapForRun
import {} from "@/lib/prospects/gap";
import { resolveProspectCompany } from "@/lib/prospects/resolve";
import {
  getEmailChannel,
  hasOptOutMention,
  optOutFooter,
} from "@/lib/prospects/channels";
import {
  computeProspectScoreView,
  PROSPECT_SCORE_VERSION,
} from "@/lib/prospects/final-score";
// removed-unused: diagnoseProspect
import {} from "@/lib/prospects/diagnose";
// Statically imported on purpose (simplify pass 2026-08-14): none of these
// modules import this service back (audit-evidence's import is type-only),
// so the mid-function `await import()` ceremony read as "cycle here" where
// there was none.
import { mockScoringAllowed } from "@/lib/ai/registry";
import { checkNoMockResponses } from "@/lib/qa/preflight";
// removed-unused: validateAuditEvidence
import {} from "@/lib/prospects/audit-evidence";
import { auditUrl, brandedAuditUrl, openPixelUrl } from "@/lib/prospects/urls";
import { plainTextToTrackedHtml } from "@/lib/text/html";
import {
  auditLinkForProspect,
} from "@/lib/prospects/links";
// removed-unused: log
import {} from "@/lib/logger";
import {
  detectLaunchConflicts,
  getPrimaryFinding,
  lockProspect,
  logActivity,
  launchMarketName,
  type ProspectRow,
} from "@/lib/prospects/shared";

// The audit-page lifecycle moved to ./audits (split 2026-08-17); the barrel
// keeps every existing `@/lib/prospects/service` import working unchanged.
export * from "@/lib/prospects/audits";
import { getActiveSenderIdentity } from "@/lib/outreach/sender-identity";

/** Diagnoses a prospect may read about themselves — retitled for them.
 * Research-gap keys (about OUR evidence base) and internal-QA keys never
 * ship on an audit page. */
/** Competitors surfaced in findings — enough contrast, no dossier. */
const MAX_COMPARED_COMPETITORS = 5;
const DEFAULT_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Schemas

const launchSchema = z.object({
  name: z.string().trim().min(1).max(120),
  marketId: z.string().uuid(),
  propertyCategory: z.string().trim().max(120).optional(),
  priceSegment: z.string().trim().max(120).optional(),
  customerSegment: z.string().trim().max(120).optional(),
  serviceCategory: z.string().trim().max(120).optional(),
  targetProspectCount: z.number().int().positive().max(500).optional(),
  ownerId: z.string().uuid().optional(),
  priority: z.number().int().min(1).max(3).default(2),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  targetCloseOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  exclusivityModel: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(5000).optional(),
});

const prospectSchema = z.object({
  launchId: z.string().uuid(),
  businessName: z.string().trim().min(1).max(200),
  prospectType: z.enum(PROSPECT_TYPES).default("team"),
  companyId: z.string().uuid().nullish(),
  brokerageAffiliation: z.string().trim().max(200).optional(),
  teamLeader: z.string().trim().max(200).optional(),
  website: z.string().trim().url().max(500).optional(),
  email: z.string().trim().email().max(320).optional(),
  phone: z.string().trim().max(50).optional(),
  socials: z.record(z.string().trim().max(500)).default({}),
  neighborhoods: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  specialties: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  priceSegment: z.string().trim().max(120).optional(),
  estTransactionVolumeUsd: z.number().int().nonnegative().optional(),
  estTeamSize: z.number().int().positive().max(10000).optional(),
  source: z.enum(PROSPECT_SOURCES).default("manual"),
  fieldProvenance: z.record(z.enum(PROVENANCE_LABELS)).default({}),
  ownerId: z.string().uuid().optional(),
  qualificationScore: z.number().int().min(0).max(100).optional(),
  relationshipStrength: z.enum(RELATIONSHIP_STRENGTHS).default("none"),
  notes: z.string().trim().max(10000).optional(),
});

const prospectUpdateSchema = prospectSchema
  .partial()
  .omit({ launchId: true })
  .extend({
    prospectId: z.string().uuid(),
    doNotContact: z.boolean().optional(),
    doNotContactReason: z.string().trim().max(500).optional(),
    nextAction: z.string().trim().max(500).nullish(),
    nextActionOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  });

const signalSchema = z.object({
  prospectId: z.string().uuid(),
  kind: z.enum(AUTHORITY_SIGNAL_KINDS),
  label: z.string().trim().min(1).max(500),
  valueNumber: z.number().finite().optional(),
  valueText: z.string().trim().max(500).optional(),
  sourceUrl: z.string().trim().url().max(1000).optional(),
  provenance: z.enum(PROVENANCE_LABELS),
  /** Evidence classification (migration 085): lets an operator record
   * sponsored coverage or self-reported claims as exactly that. Optional —
   * unclassified stays null, never guessed. */
  sourceType: z.enum(SIGNAL_SOURCE_TYPES).optional(),
  /** Global evidence (nationwide volume, brand rankings) is shown for
   * context but excluded from the local-authority score (spec 038). */
  scope: z.enum(["local", "global"]).default("local"),
  retrievedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  confidence: z.number().min(0).max(1).optional(),
  notes: z.string().trim().max(2000).optional(),
});

// ---------------------------------------------------------------------------
// Market launches

export async function createLaunch(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ launchId: string }>> {
  const parsed = launchSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    const [market] = await sql`select id from markets where id = ${input.marketId}`;
    if (!market) {
      return fail(
        new ClassifiedError(
          "not_found",
          "That market is not in the exclusivity tree yet — add it under Exclusivity first."
        )
      );
    }
    const launchId = await sql.begin(async (tx) => {
      const [row] = await tx`
        insert into market_launches
          (name, market_id, property_category, price_segment, customer_segment,
           service_category, target_prospect_count, owner_id, priority,
           starts_on, target_close_on, exclusivity_model, notes, created_by)
        values (${input.name}, ${input.marketId}, ${input.propertyCategory ?? null},
          ${input.priceSegment ?? null}, ${input.customerSegment ?? null},
          ${input.serviceCategory ?? null}, ${input.targetProspectCount ?? null},
          ${input.ownerId ?? user.id}, ${input.priority},
          ${input.startsOn ?? null}, ${input.targetCloseOn ?? null},
          ${input.exclusivityModel ?? null}, ${input.notes ?? null}, ${user.id})
        returning id
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "launch.create",
        entity: "market_launch",
        entityId: row?.id as string,
        detail: { name: input.name, marketId: input.marketId },
      });
      return row?.id as string;
    });
    return ok({ launchId });
  } catch (err) {
    return fail(duplicateNameConflict(err, "A launch with this name already exists."));
  }
}

export async function updateLaunchStatus(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ launchId: string }>> {
  const parsed = z
    .object({ launchId: z.string().uuid(), status: z.enum(LAUNCH_STATUSES) })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const { launchId, status } = parsed.data;
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const [row] = await tx`
        update market_launches set status = ${status}
        where id = ${launchId} and archived_at is null
        returning id
      `;
      if (!row) throw new ClassifiedError("not_found", "Launch not found.");
      await writeAudit(tx, {
        userId: user.id,
        action: "launch.status",
        entity: "market_launch",
        entityId: launchId,
        detail: { status },
      });
    });
    return ok({ launchId });
  } catch (err) {
    return fail(err);
  }
}

export interface LaunchListRow {
  id: string;
  name: string;
  marketName: string;
  status: string;
  priority: number;
  ownerName: string | null;
  prospectCount: number;
  targetProspectCount: number | null;
}

export async function listLaunches(): Promise<LaunchListRow[]> {
  return sql<LaunchListRow[]>`
    select l.id, l.name, m.name as market_name, l.status, l.priority,
      u.name as owner_name, l.target_prospect_count,
      (select count(*)::int from prospects p
        where p.launch_id = l.id and p.archived_at is null) as prospect_count
    from market_launches l
    join markets m on m.id = l.market_id
    left join users u on u.id = l.owner_id
    where l.archived_at is null
    order by l.priority asc, l.created_at desc
  `;
}

// ---------------------------------------------------------------------------
// Prospects

export async function createProspect(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ prospectId: string }>> {
  const parsed = prospectSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    const [launch] = await sql`
      select id from market_launches where id = ${input.launchId} and archived_at is null
    `;
    if (!launch) return fail(new ClassifiedError("not_found", "Launch not found."));
    if (input.companyId) {
      const [company] = await sql`
        select id from companies where id = ${input.companyId} and archived_at is null
      `;
      if (!company) return fail(new ClassifiedError("not_found", "Canonical company not found."));
    }
    const prospectId = await sql.begin(async (tx) => {
      const [row] = await tx`
        insert into prospects
          (launch_id, business_name, prospect_type, company_id,
           brokerage_affiliation, team_leader, website, email, phone, socials,
           neighborhoods, specialties, price_segment, est_transaction_volume_usd,
           est_team_size, source, field_provenance, owner_id,
           qualification_score, relationship_strength, notes, created_by)
        values (${input.launchId}, ${input.businessName}, ${input.prospectType},
          ${input.companyId ?? null}, ${input.brokerageAffiliation ?? null},
          ${input.teamLeader ?? null}, ${input.website ?? null},
          ${input.email ?? null}, ${input.phone ?? null},
          ${tx.json(input.socials as never)}, ${input.neighborhoods},
          ${input.specialties}, ${input.priceSegment ?? null},
          ${input.estTransactionVolumeUsd ?? null}, ${input.estTeamSize ?? null},
          ${input.source}, ${tx.json(input.fieldProvenance as never)},
          ${input.ownerId ?? user.id}, ${input.qualificationScore ?? null},
          ${input.relationshipStrength}, ${input.notes ?? null}, ${user.id})
        returning id
      `;
      const id = row?.id as string;
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.create",
        entity: "prospect",
        entityId: id,
        detail: { businessName: input.businessName, launchId: input.launchId },
      });
      await logActivity(tx, id, "created", { businessName: input.businessName }, user.id);
      return id;
    });
    return ok({ prospectId });
  } catch (err) {
    return fail(
      duplicateNameConflict(err, "A prospect with this name already exists in this launch.")
    );
  }
}

export async function updateProspect(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ prospectId: string }>> {
  const parsed = prospectUpdateSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const current = await lockProspect(tx, input.prospectId);
      await tx`
        update prospects set
          business_name = coalesce(${input.businessName ?? null}, business_name),
          prospect_type = coalesce(${input.prospectType ?? null}, prospect_type),
          company_id = coalesce(${input.companyId ?? null}, company_id),
          brokerage_affiliation = coalesce(${input.brokerageAffiliation ?? null}, brokerage_affiliation),
          team_leader = coalesce(${input.teamLeader ?? null}, team_leader),
          website = coalesce(${input.website ?? null}, website),
          email = coalesce(${input.email ?? null}, email),
          phone = coalesce(${input.phone ?? null}, phone),
          price_segment = coalesce(${input.priceSegment ?? null}, price_segment),
          est_transaction_volume_usd = coalesce(${input.estTransactionVolumeUsd ?? null}, est_transaction_volume_usd),
          est_team_size = coalesce(${input.estTeamSize ?? null}, est_team_size),
          field_provenance = field_provenance || ${tx.json((input.fieldProvenance ?? {}) as never)},
          owner_id = coalesce(${input.ownerId ?? null}, owner_id),
          qualification_score = coalesce(${input.qualificationScore ?? null}, qualification_score),
          relationship_strength = coalesce(${input.relationshipStrength ?? null}, relationship_strength),
          notes = coalesce(${input.notes ?? null}, notes),
          next_action = coalesce(${input.nextAction ?? null}, next_action),
          next_action_on = coalesce(${input.nextActionOn ?? null}, next_action_on),
          do_not_contact = coalesce(${input.doNotContact ?? null}, do_not_contact),
          do_not_contact_reason = coalesce(${input.doNotContactReason ?? null}, do_not_contact_reason),
          updated_at = now()
        where id = ${input.prospectId}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.update",
        entity: "prospect",
        entityId: input.prospectId,
        detail: { fields: Object.keys(input).filter((k) => k !== "prospectId") },
      });
      if (input.doNotContact === true && !current.doNotContact) {
        await logActivity(
          tx,
          input.prospectId,
          "do_not_contact_set",
          { reason: input.doNotContactReason ?? null },
          user.id
        );
      }
    });
    return ok({ prospectId: input.prospectId });
  } catch (err) {
    return fail(err);
  }
}

export interface ProspectListRow {
  id: string;
  businessName: string;
  launchId: string;
  launchName: string;
  prospectType: string;
  stage: string;
  conflictStatus: string;
  doNotContact: boolean;
  ownerName: string | null;
  nextAction: string | null;
  nextActionOn: string | null;
  qualificationScore: number | null;
  qualificationOverride: number | null;
  /** Stored score breakdown (spec 045) — rendered as the table blurb. */
  qualificationBreakdown: Record<string, unknown> | null;
}

export async function listProspects(
  options: {
    launchId?: string;
    /** Effective score (override when set, else computed) at or above this. */
    minScore?: number;
    limit?: number;
    offset?: number;
  } = {}
): Promise<ProspectListRow[]> {
  const limit = Math.min(options.limit ?? DEFAULT_PAGE_SIZE, 200);
  const offset = options.offset ?? 0;
  return sql<ProspectListRow[]>`
    select p.id, p.business_name, p.launch_id, l.name as launch_name,
      p.prospect_type, p.stage, p.conflict_status, p.do_not_contact,
      u.name as owner_name, p.next_action, p.next_action_on::text,
      p.qualification_score, p.qualification_override, p.qualification_breakdown
    from prospects p
    join market_launches l on l.id = p.launch_id
    left join users u on u.id = p.owner_id
    where p.archived_at is null
      and (${options.launchId ?? null}::uuid is null or p.launch_id = ${options.launchId ?? null})
      and (${options.minScore ?? null}::int is null
        or coalesce(p.qualification_override, p.qualification_score)
          >= ${options.minScore ?? null})
    order by coalesce(p.qualification_override, p.qualification_score) desc nulls last,
      p.created_at desc
    limit ${limit} offset ${offset}
  `;
}

// ---------------------------------------------------------------------------
// Authority signals

export async function addAuthoritySignal(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ signalId: string }>> {
  const parsed = signalSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    if (input.provenance === "verified" && !input.sourceUrl) {
      return fail(
        new ClassifiedError(
          "validation",
          "A verified signal needs a source URL — otherwise record it as manual or estimated."
        )
      );
    }
    const signalId = await sql.begin(async (tx) => {
      await lockProspect(tx, input.prospectId);
      const [row] = await tx`
        insert into prospect_authority_signals
          (prospect_id, kind, label, value_number, value_text, source_url,
           provenance, source_type, scope, retrieved_at, confidence, notes,
           created_by)
        values (${input.prospectId}, ${input.kind}, ${input.label},
          ${input.valueNumber ?? null}, ${input.valueText ?? null},
          ${input.sourceUrl ?? null}, ${input.provenance},
          ${input.sourceType ?? null}, ${input.scope},
          ${input.retrievedAt ?? null},
          ${input.confidence ?? null}, ${input.notes ?? null}, ${user.id})
        returning id
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.signal_add",
        entity: "prospect_authority_signal",
        entityId: row?.id as string,
        detail: { prospectId: input.prospectId, kind: input.kind, provenance: input.provenance },
      });
      await logActivity(
        tx,
        input.prospectId,
        "signal_added",
        { kind: input.kind, label: input.label, provenance: input.provenance },
        user.id
      );
      return row?.id as string;
    });
    return ok({ signalId });
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------------------
// Contacts (spec 032 Phase 2.3). Outreach goes to a person, not a business —
// contacts carry their own do-not-contact flag, and the draft gates below
// check it alongside the account-level flag and the global suppression list.

const contactSchema = z.object({
  prospectId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  role: z.string().trim().max(120).optional(),
  email: z.string().trim().email().max(320).optional(),
  phone: z.string().trim().max(50).optional(),
  linkedin: z.string().trim().url().max(500).optional(),
  preferredChannel: z.enum(CONTACT_CHANNELS).optional(),
  isPrimary: z.boolean().default(false),
  provenance: z.enum(PROVENANCE_LABELS).default("manual"),
  notes: z.string().trim().max(2000).optional(),
});

const contactUpdateSchema = contactSchema
  .partial()
  .omit({ prospectId: true })
  .extend({
    contactId: z.string().uuid(),
    doNotContact: z.boolean().optional(),
    doNotContactReason: z.string().trim().max(500).optional(),
  });

const CONTACT_EMAIL_CONFLICT =
  "A contact with this email already exists on this prospect.";

async function demotePrimaryContact(
  tx: TransactionSql,
  prospectId: string,
  exceptId?: string
): Promise<void> {
  await tx`
    update prospect_contacts set is_primary = false, updated_at = now()
    where prospect_id = ${prospectId} and is_primary and archived_at is null
      and (${exceptId ?? null}::uuid is null or id != ${exceptId ?? null})
  `;
}

export async function addContact(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ contactId: string }>> {
  const parsed = contactSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    const contactId = await sql.begin(async (tx) => {
      await lockProspect(tx, input.prospectId);
      if (input.isPrimary) await demotePrimaryContact(tx, input.prospectId);
      const [row] = await tx`
        insert into prospect_contacts
          (prospect_id, name, role, email, phone, linkedin, preferred_channel,
           is_primary, provenance, notes, created_by)
        values (${input.prospectId}, ${input.name}, ${input.role ?? null},
          ${input.email ?? null}, ${input.phone ?? null}, ${input.linkedin ?? null},
          ${input.preferredChannel ?? null}, ${input.isPrimary},
          ${input.provenance}, ${input.notes ?? null}, ${user.id})
        returning id
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.contact_add",
        entity: "prospect_contact",
        entityId: row?.id as string,
        detail: { prospectId: input.prospectId, name: input.name, provenance: input.provenance },
      });
      await logActivity(
        tx,
        input.prospectId,
        "contact_added",
        { name: input.name, role: input.role ?? null, isPrimary: input.isPrimary },
        user.id
      );
      return row?.id as string;
    });
    return ok({ contactId });
  } catch (err) {
    return fail(duplicateNameConflict(err, CONTACT_EMAIL_CONFLICT));
  }
}

export async function updateContact(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ contactId: string }>> {
  const parsed = contactUpdateSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const [contact] = await tx`
        select id, prospect_id, do_not_contact, archived_at
        from prospect_contacts where id = ${input.contactId} for update
      `;
      if (!contact || contact.archivedAt) {
        throw new ClassifiedError("not_found", "Contact not found.");
      }
      const prospectId = contact.prospectId as string;
      await lockProspect(tx, prospectId);
      if (input.isPrimary === true) {
        await demotePrimaryContact(tx, prospectId, input.contactId);
      }
      await tx`
        update prospect_contacts set
          name = coalesce(${input.name ?? null}, name),
          role = coalesce(${input.role ?? null}, role),
          email = coalesce(${input.email ?? null}, email),
          phone = coalesce(${input.phone ?? null}, phone),
          linkedin = coalesce(${input.linkedin ?? null}, linkedin),
          preferred_channel = coalesce(${input.preferredChannel ?? null}, preferred_channel),
          is_primary = coalesce(${input.isPrimary ?? null}, is_primary),
          provenance = coalesce(${input.provenance ?? null}, provenance),
          notes = coalesce(${input.notes ?? null}, notes),
          do_not_contact = coalesce(${input.doNotContact ?? null}, do_not_contact),
          do_not_contact_reason = coalesce(${input.doNotContactReason ?? null}, do_not_contact_reason),
          updated_at = now()
        where id = ${input.contactId}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.contact_update",
        entity: "prospect_contact",
        entityId: input.contactId,
        detail: {
          prospectId,
          fields: Object.keys(input).filter((k) => k !== "contactId"),
        },
      });
      if (input.doNotContact === true && !contact.doNotContact) {
        await logActivity(
          tx,
          prospectId,
          "contact_do_not_contact_set",
          { contactId: input.contactId, reason: input.doNotContactReason ?? null },
          user.id
        );
      }
    });
    return ok({ contactId: input.contactId });
  } catch (err) {
    return fail(duplicateNameConflict(err, CONTACT_EMAIL_CONFLICT));
  }
}

export async function archiveContact(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ contactId: string }>> {
  const parsed = z.object({ contactId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid contact id."));
  }
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const [contact] = await tx`
        select id, prospect_id, name, archived_at
        from prospect_contacts where id = ${parsed.data.contactId} for update
      `;
      if (!contact || contact.archivedAt) {
        throw new ClassifiedError("not_found", "Contact not found.");
      }
      await tx`
        update prospect_contacts
        set archived_at = now(), is_primary = false, updated_at = now()
        where id = ${contact.id}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.contact_archive",
        entity: "prospect_contact",
        entityId: contact.id as string,
        detail: { prospectId: contact.prospectId },
      });
      await logActivity(
        tx,
        contact.prospectId as string,
        "contact_archived",
        { contactId: contact.id, name: contact.name },
        user.id
      );
    });
    return ok({ contactId: parsed.data.contactId });
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------------------
// CSV import (spec 032 Phase 2.2). Parsing lives in import.ts; this persists
// through the same createProspect/addContact paths as manual entry so dedup,
// validation, audit, and provenance rules cannot fork. Row failures never
// abort the batch — the report says exactly what happened to every line.

const importSchema = z.object({
  launchId: z.string().uuid(),
  csv: z.string().min(1).max(500_000),
  /** Applied to every fact the file populates; the file is one source. */
  provenance: z.enum(PROVENANCE_LABELS).default("publicly_sourced"),
  /** Where the list came from, recorded on the import audit entry. */
  sourceUrl: z.string().trim().url().max(1000).optional(),
});

export interface ImportReport {
  created: number;
  duplicates: number;
  errors: { line: number; message: string }[];
  ignoredHeaders: string[];
}

const IMPORT_TYPE_ALIASES: Record<string, ProspectType> = {
  brokerage: "brokerage",
  team: "team",
  individual_agent: "individual_agent",
  agent: "individual_agent",
  individual: "individual_agent",
  developer: "developer",
  new_dev_marketing: "new_dev_marketing",
};

/** CSV websites usually lack a scheme; the prospect schema requires one. */
function normalizeWebsite(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function importRowToProspectInput(
  row: ImportRow,
  launchId: string,
  provenance: (typeof PROVENANCE_LABELS)[number]
): { input: Record<string, unknown> } | { error: string } {
  let prospectType: ProspectType = "team";
  if (row.prospectType) {
    const mapped = IMPORT_TYPE_ALIASES[row.prospectType.trim().toLowerCase().replace(/[\s-]/g, "_")];
    if (!mapped) return { error: `Unknown prospect type "${row.prospectType}".` };
    prospectType = mapped;
  }
  const facts: Record<string, string | undefined> = {
    businessName: row.businessName,
    brokerageAffiliation: row.brokerageAffiliation,
    teamLeader: row.teamLeader,
    website: normalizeWebsite(row.website),
    email: row.email,
    phone: row.phone,
    priceSegment: row.priceSegment,
  };
  const fieldProvenance: Record<string, string> = {};
  for (const [key, value] of Object.entries(facts)) {
    if (value) fieldProvenance[key] = provenance;
  }
  return {
    input: {
      launchId,
      prospectType,
      source: "csv",
      fieldProvenance,
      ...Object.fromEntries(Object.entries(facts).filter(([, v]) => v !== undefined)),
    },
  };
}

export async function importProspects(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<ImportReport>> {
  const parsed = importSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    const [launch] = await sql`
      select id from market_launches where id = ${input.launchId} and archived_at is null
    `;
    if (!launch) return fail(new ClassifiedError("not_found", "Launch not found."));

    const file = parseProspectImport(input.csv);
    const errors = [...file.errors];
    let created = 0;
    let duplicates = 0;

    for (const row of file.rows) {
      const mapped = importRowToProspectInput(row, input.launchId, input.provenance);
      if ("error" in mapped) {
        errors.push({ line: row.line, message: mapped.error });
        continue;
      }
      const result = await createProspect(user, mapped.input);
      if (!result.ok) {
        if (result.error.kind === "conflict") duplicates += 1;
        else errors.push({ line: row.line, message: result.error.message });
        continue;
      }
      created += 1;
      if (row.contactName || row.contactEmail) {
        const contact = await addContact(user, {
          prospectId: result.data.prospectId,
          name: row.contactName ?? row.contactEmail,
          role: row.contactRole,
          email: row.contactEmail,
          isPrimary: true,
          provenance: input.provenance,
        });
        if (!contact.ok) {
          errors.push({
            line: row.line,
            message: `Prospect created, but its contact was rejected: ${contact.error.message}`,
          });
        }
      }
    }

    await sql.begin(async (tx) => {
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.import",
        entity: "market_launch",
        entityId: input.launchId,
        detail: {
          created,
          duplicates,
          errorCount: errors.length,
          provenance: input.provenance,
          sourceUrl: input.sourceUrl ?? null,
        },
      });
    });
    return ok({ created, duplicates, errors, ignoredHeaders: file.ignoredHeaders });
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------------------
// Assessments and the final prospect score (spec 039)

const assessmentSchema = z.object({
  prospectId: z.string().uuid(),
  item: z.enum(ASSESSMENT_ITEMS),
  value: z.enum(ASSESSMENT_VALUES),
  note: z.string().trim().max(1000).optional(),
});

/** Upsert one operator-recorded fact; the latest answer wins, with identity. */
export async function recordAssessment(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ prospectId: string }>> {
  const parsed = assessmentSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      await lockProspect(tx, input.prospectId);
      await tx`
        insert into prospect_assessments (prospect_id, item, value, note, recorded_by)
        values (${input.prospectId}, ${input.item}, ${input.value},
          ${input.note ?? null}, ${user.id})
        on conflict (prospect_id, item) do update set
          value = excluded.value, note = excluded.note,
          recorded_by = excluded.recorded_by, recorded_at = now()
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.assessment_record",
        entity: "prospect",
        entityId: input.prospectId,
        detail: { item: input.item, value: input.value },
      });
    });
    return ok({ prospectId: input.prospectId });
  } catch (err) {
    return fail(err);
  }
}

/**
 * Compute and store the final score with its full breakdown. Storing (unlike
 * the derived-on-read spec-038 scores) is deliberate: the list filters and
 * sorts on it, and the breakdown records every component, weight, and
 * version that produced the number at a known time.
 */
export async function computeProspectScore(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ prospectId: string; score: number | null }>> {
  const parsed = z.object({ prospectId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid prospect id."));
  }
  try {
    assertCanWrite(user);
    const view = await computeProspectScoreView(parsed.data.prospectId);
    const score = view.score !== null ? Math.round(view.score) : null;
    const breakdown = {
      version: view.version,
      weightSet: view.weightSet,
      components: view.components,
      missing: view.missing,
      dataConfidence: view.dataConfidence,
      preConfidence: view.preConfidence,
      fixability: {
        version: view.fixability.version,
        raw: view.fixability.raw,
        confidence: view.fixability.confidence,
        adjusted: view.fixability.adjusted,
        categories: view.fixability.categories,
        flags: view.fixability.flags,
        needsReview: view.fixability.needsReview,
      },
      contactabilityFlags: view.contactabilityFlags,
      computedAt: new Date().toISOString(),
      computedBy: user.id,
    };
    await sql.begin(async (tx) => {
      await lockProspect(tx, parsed.data.prospectId);
      await tx`
        update prospects set
          qualification_score = ${score},
          qualification_breakdown = ${tx.json(breakdown as never)},
          updated_at = now()
        where id = ${parsed.data.prospectId}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.score_compute",
        entity: "prospect",
        entityId: parsed.data.prospectId,
        detail: {
          score,
          version: PROSPECT_SCORE_VERSION,
          weightSetVersion: view.weightSet.version,
          missing: view.missing,
          flags: view.fixability.flags.map((f) => f.flag),
        },
      });
      await logActivity(
        tx,
        parsed.data.prospectId,
        "score_computed",
        { score, missing: view.missing },
        user.id
      );
    });
    return ok({ prospectId: parsed.data.prospectId, score });
  } catch (err) {
    return fail(err);
  }
}

/** Override with a recorded reason — the computed score is never erased.
 * Pass score: null to clear an override; that too requires a reason. */
export async function overrideProspectScore(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ prospectId: string }>> {
  const parsed = z
    .object({
      prospectId: z.string().uuid(),
      score: z.number().int().min(0).max(100).nullable(),
      reason: z.string().trim().min(3).max(1000),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(
      new ClassifiedError("validation", "An override needs a score (or null) and a reason.")
    );
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      await lockProspect(tx, input.prospectId);
      await tx`
        update prospects set
          qualification_override = ${input.score},
          qualification_override_reason = ${input.reason},
          qualification_override_by = ${input.score === null ? null : user.id},
          qualification_override_at = ${input.score === null ? null : new Date()},
          updated_at = now()
        where id = ${input.prospectId}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action:
          input.score === null ? "prospect.score_override_clear" : "prospect.score_override",
        entity: "prospect",
        entityId: input.prospectId,
        detail: { score: input.score, reason: input.reason },
      });
      await logActivity(
        tx,
        input.prospectId,
        input.score === null ? "score_override_cleared" : "score_overridden",
        { score: input.score, reason: input.reason },
        user.id
      );
    });
    return ok({ prospectId: input.prospectId });
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------------------
// Benchmarks

export async function linkBenchmark(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ benchmarkId: string }>> {
  const parsed = z
    .object({
      prospectId: z.string().uuid(),
      runId: z.string().uuid(),
      note: z.string().trim().max(2000).optional(),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    const benchmarkId = await sql.begin(async (tx) => {
      const prospect = await lockProspect(tx, input.prospectId);
      if (!prospect.companyId) {
        throw new ClassifiedError(
          "validation",
          "Link the prospect to its canonical company first — benchmark data is keyed by company."
        );
      }
      const [run] = await tx`
        select id, status from runs where id = ${input.runId}
      `;
      if (!run) throw new ClassifiedError("not_found", "Run not found.");
      if (run.status !== "completed" && run.status !== "partial") {
        throw new ClassifiedError(
          "validation",
          `Run is ${run.status} — only completed or partial runs can back a benchmark.`
        );
      }
      const [scored] = await tx`
        select 1 from scores
        where run_id = ${input.runId} and company_id = ${prospect.companyId}
        limit 1
      `;
      if (!scored) {
        throw new ClassifiedError(
          "validation",
          "This company was not scored in that run — the benchmark would be empty. Pick a run that tracked it."
        );
      }
      // A benchmark is prospect-facing evidence; fabricated captures must
      // never back it (plan 2.3). Same encoding as the publish gate — one
      // mock rule (lib/qa/preflight), not two that can drift.
      const providerRows = await tx`
        select distinct provider from responses where run_id = ${input.runId}
      `;
      const mockCheck = checkNoMockResponses(
        providerRows.map((r) => r.provider as string),
        mockScoringAllowed()
      );
      if (!mockCheck.ok) {
        throw new ClassifiedError(
          "validation",
          "That run contains mock-provider responses and cannot back a prospect benchmark."
        );
      }
      const [row] = await tx`
        insert into prospect_benchmarks (prospect_id, run_id, company_id, note, created_by)
        values (${input.prospectId}, ${input.runId}, ${prospect.companyId},
          ${input.note ?? null}, ${user.id})
        returning id
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.benchmark_link",
        entity: "prospect_benchmark",
        entityId: row?.id as string,
        detail: { prospectId: input.prospectId, runId: input.runId },
      });
      await logActivity(tx, input.prospectId, "benchmark_linked", { runId: input.runId }, user.id);
      return row?.id as string;
    });
    return ok({ benchmarkId });
  } catch (err) {
    return fail(
      duplicateNameConflict(err, "That run is already linked to this prospect.")
    );
  }
}

/**
 * Phase 2.1: a dedicated benchmark project for a prospect with no existing
 * run coverage. Composes the same services as onboardClient but tolerates an
 * already-registered company (a market team is often tracked as some
 * client's competitor before it becomes a prospect). The project is marked
 * kind='prospect', which keeps it out of every client-facing and portfolio
 * surface while the whole measurement pipeline works on it unchanged.
 *
 * Deliberately NOT created here: a prompt set. The instrument gets built and
 * reviewed by a human in the project workspace before anything runs
 * (docs/07 — same rule onboardClient follows by leaving sets unfrozen).
 */
export async function createBenchmarkProject(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ projectId: string; companyId: string; competitorsTracked: number }>> {
  const parsed = z.object({ prospectId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid prospect id."));
  }
  try {
    assertCanWrite(user);
    const [prospect] = await sql`
      select p.id, p.launch_id, p.business_name, p.company_id,
        p.benchmark_project_id, p.archived_at, p.website,
        p.brokerage_affiliation, p.team_leader, m.name as market_name
      from prospects p
      join market_launches l on l.id = p.launch_id
      join markets m on m.id = l.market_id
      where p.id = ${parsed.data.prospectId}
    `;
    if (!prospect || prospect.archivedAt) {
      return fail(new ClassifiedError("not_found", "Prospect not found."));
    }
    if (prospect.benchmarkProjectId) {
      return fail(
        new ClassifiedError("conflict", "This prospect already has a benchmark project.")
      );
    }

    // Resolve the canonical company: linked > resolver verdict > created.
    // The old exact-lower(name) match-or-create bypassed the resolver and
    // silently minted duplicate companies ("Hudson Advisory Team" alongside
    // "Hudson Advisory") — the same pipeline that carefully resolves
    // discovery candidates then split entities at benchmark time (spec 050).
    let companyId = prospect.companyId as string | null;
    if (!companyId) {
      const registry = await sql`
        select id, name, aliases, domain from companies where archived_at is null
      `;
      const resolution = resolveProspectCompany(
        {
          businessName: prospect.businessName as string,
          website: prospect.website as string | null,
          brokerageAffiliation: prospect.brokerageAffiliation as string | null,
          teamLeader: prospect.teamLeader as string | null,
        },
        registry.map((c) => ({
          id: c.id as string,
          name: c.name as string,
          aliases: (c.aliases as string[]) ?? [],
          domain: (c.domain as string | null) ?? null,
        }))
      );
      if (resolution.verdict === "match" && resolution.companyId !== null) {
        companyId = resolution.companyId;
      } else if (resolution.verdict !== "none") {
        const names = resolution.candidates
          .slice(0, 3)
          .map((c) => c.name)
          .join(", ");
        return fail(
          new ClassifiedError(
            "conflict",
            `Company resolution is ambiguous (${names ? `candidates: ${names}` : resolution.reasons[0] ?? "no clear match"}). ` +
              "Link the prospect to the right company (or confirm it is new) before creating a benchmark — an ambiguous link here poisons every downstream metric."
          )
        );
      } else {
        const created = await upsertCompany(user, { name: prospect.businessName, aliases: [] });
        if (!created.ok) return created;
        companyId = created.data.id;
      }
    }

    const project = await createProject(user, {
      name: `Prospect benchmark: ${prospect.businessName} — ${prospect.marketName}`,
      description: `Spec 032 benchmark project for prospect ${prospect.id}. Not a client.`,
    });
    if (!project.ok) return project;
    const projectId = project.data.id;
    await sql`update projects set kind = 'prospect' where id = ${projectId}`;

    const subject = await setSubjectCompany(user, { projectId, companyId });
    if (!subject.ok) return subject;

    // The comparison set: the launch's other prospects are, by construction,
    // the market's leading teams. Best-effort — a failure to track one
    // competitor must not lose the project that already exists.
    const rivals = await sql`
      select company_id from prospects
      where launch_id = ${prospect.launchId} and id != ${prospect.id}
        and company_id is not null and archived_at is null
    `;
    let competitorsTracked = 0;
    for (const rival of rivals) {
      const tracked = await addCompetitor(user, {
        projectId,
        companyId: rival.companyId as string,
        tier: "secondary",
      });
      if (tracked.ok) competitorsTracked += 1;
    }

    await sql.begin(async (tx) => {
      await tx`
        update prospects
        set benchmark_project_id = ${projectId}, company_id = ${companyId},
          updated_at = now()
        where id = ${prospect.id}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.benchmark_project_create",
        entity: "prospect",
        entityId: prospect.id as string,
        detail: { projectId, companyId, competitorsTracked },
      });
      await logActivity(
        tx,
        prospect.id as string,
        "benchmark_project_created",
        { projectId, competitorsTracked },
        user.id
      );
    });
    return ok({ projectId, companyId, competitorsTracked });
  } catch (err) {
    return fail(
      duplicateNameConflict(
        err,
        "A project with this benchmark name already exists — link that one instead."
      )
    );
  }
}

interface BenchmarkRow {
  id: string;
  prospectId: string;
  runId: string;
  companyId: string;
}

async function getBenchmark(benchmarkId: string): Promise<BenchmarkRow> {
  const rows = await sql`
    select id, prospect_id, run_id, company_id
    from prospect_benchmarks where id = ${benchmarkId}
  `;
  const row = rows[0] as BenchmarkRow | undefined;
  if (!row) throw new ClassifiedError("not_found", "Benchmark not found.");
  return row;
}

export interface BenchmarkMetricsView {
  benchmarkId: string;
  run: RunSummary;
  prospect: BenchmarkEntityMetrics | null;
  others: BenchmarkEntityMetrics[];
}

/** Read-only metrics for the detail page — straight from `scores`. */
export async function benchmarkMetrics(benchmarkId: string): Promise<BenchmarkMetricsView> {
  const benchmark = await getBenchmark(benchmarkId);
  // Independent runId-keyed reads — no reason to serialize them on every
  // benchmark detail render.
  const [run, entities] = await Promise.all([
    runSummary(benchmark.runId),
    scoredEntities(benchmark.runId),
  ]);
  if (!run) throw new ClassifiedError("not_found", "Run not found.");
  return {
    benchmarkId,
    run,
    prospect: entities.find((e) => e.companyId === benchmark.companyId) ?? null,
    others: entities.filter((e) => e.companyId !== benchmark.companyId),
  };
}

// ---------------------------------------------------------------------------
// Findings

export async function generateFindings(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ candidateCount: number }>> {
  const parsed = z.object({ benchmarkId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid benchmark id."));
  }
  try {
    assertCanWrite(user);
    const benchmark = await getBenchmark(parsed.data.benchmarkId);
    const entities = await scoredEntities(benchmark.runId);
    const prospectMetrics = entities.find((e) => e.companyId === benchmark.companyId);
    if (!prospectMetrics) {
      return fail(
        new ClassifiedError("validation", "The prospect's company has no scores in this run.")
      );
    }
    const rivals = entities
      .filter((e) => e.companyId !== benchmark.companyId)
      .sort((a, b) => (b.recommendationRate ?? -1) - (a.recommendationRate ?? -1))
      .slice(0, MAX_COMPARED_COMPETITORS);

    const signals = await sql`
      select id, kind, label, provenance from prospect_authority_signals
      where prospect_id = ${benchmark.prospectId}
      order by created_at asc
    `;
    const [prospect] = await sql`
      select business_name from prospects where id = ${benchmark.prospectId}
    `;
    if (!prospect) return fail(new ClassifiedError("not_found", "Prospect not found."));

    const absence = await absenceEvidence(
      benchmark.runId,
      benchmark.companyId,
      rivals.map((r) => r.companyId)
    );
    const absentIds = await prospectAbsentResponses(benchmark.runId, benchmark.companyId);

    const candidates = generateFindingCandidates({
      prospectName: prospect.businessName as string,
      prospect: prospectMetrics,
      competitors: rivals,
      signals: signals.map((s) => ({
        id: s.id as string,
        kind: s.kind as string,
        label: s.label as string,
        provenance: s.provenance as (typeof PROVENANCE_LABELS)[number],
      })),
      absence,
      prospectAbsentResponseIds: absentIds,
    });

    await sql.begin(async (tx) => {
      // Regeneration archives prior unreviewed candidates; reviewed findings
      // (approved/rejected) are history and stay untouched.
      await tx`
        update prospect_findings set status = 'archived'
        where benchmark_id = ${benchmark.id} and status = 'candidate'
      `;
      for (const c of candidates) {
        await tx`
          insert into prospect_findings
            (prospect_id, benchmark_id, kind, title, explanation, metrics,
             signal_ids, response_ids, competitor_company_ids, confidence,
             severity, business_relevance, suggested_angle, rank_score,
             generator_version)
          values (${benchmark.prospectId}, ${benchmark.id}, ${c.kind}, ${c.title},
            ${c.explanation}, ${tx.json(c.metrics as never)}, ${c.signalIds},
            ${c.responseIds}, ${c.competitorCompanyIds}, ${c.confidence},
            ${c.severity}, ${c.businessRelevance}, ${c.suggestedAngle},
            ${c.rankScore}, ${c.generatorVersion})
        `;
      }
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.findings_generate",
        entity: "prospect_benchmark",
        entityId: benchmark.id,
        detail: { candidates: candidates.length, generator: FINDING_GENERATOR_VERSION },
      });
      await logActivity(
        tx,
        benchmark.prospectId,
        "findings_generated",
        { count: candidates.length },
        user.id
      );
    });
    return ok({ candidateCount: candidates.length });
  } catch (err) {
    return fail(err);
  }
}

export async function reviewFinding(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ findingId: string; status: string }>> {
  const parsed = z
    .object({
      findingId: z.string().uuid(),
      decision: z.enum(["approved", "rejected"]),
      makePrimary: z.boolean().default(false),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const [finding] = await tx`
        select id, prospect_id, title, explanation, response_ids, status
        from prospect_findings where id = ${input.findingId} for update
      `;
      if (!finding) throw new ClassifiedError("not_found", "Finding not found.");
      if (finding.status !== "candidate") {
        throw new ClassifiedError("conflict", `Finding is already ${finding.status}.`);
      }
      if (input.decision === "approved") {
        if ((finding.responseIds as string[]).length === 0) {
          throw new ClassifiedError(
            "validation",
            "A finding cannot be approved without response evidence."
          );
        }
        const banned =
          findProhibitedPhrase(finding.title as string) ??
          findProhibitedPhrase(finding.explanation as string);
        if (banned) {
          throw new ClassifiedError(
            "validation",
            `The finding contains prohibited wording ("${banned}") — revenue and causality claims cannot be approved.`
          );
        }
        if (input.makePrimary) {
          await tx`
            update prospect_findings set is_primary = false
            where prospect_id = ${finding.prospectId} and is_primary
          `;
        }
      }
      await tx`
        update prospect_findings set
          status = ${input.decision},
          is_primary = ${input.decision === "approved" && input.makePrimary},
          reviewed_by = ${user.id},
          reviewed_at = now()
        where id = ${input.findingId}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.finding_review",
        entity: "prospect_finding",
        entityId: input.findingId,
        detail: { decision: input.decision, makePrimary: input.makePrimary },
      });
      await logActivity(
        tx,
        finding.prospectId as string,
        input.decision === "approved" ? "finding_approved" : "finding_rejected",
        { findingId: input.findingId, title: finding.title },
        user.id
      );
    });
    return ok({ findingId: input.findingId, status: input.decision });
  } catch (err) {
    return fail(err);
  }
}



// ---------------------------------------------------------------------------
// Outreach drafts

export async function createOutreachDraft(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ draftId: string; version: number }>> {
  const parsed = z
    .object({
      prospectId: z.string().uuid(),
      channel: z.enum(OUTREACH_CHANNELS).default("email"),
      contactId: z.string().uuid().optional(),
      subject: z.string().trim().max(300).optional(),
      body: z.string().trim().min(1).max(10000).optional(),
      tone: z.string().trim().max(120).optional(),
      cta: z.string().trim().max(500).optional(),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    const result = await sql.begin(async (tx) => {
      const prospect = await lockProspect(tx, input.prospectId);
      if (input.contactId) {
        // The DB cannot express "the contact belongs to this draft's
        // prospect" (042 note) — enforced here, the only insert path.
        const [contact] = await tx`
          select id from prospect_contacts
          where id = ${input.contactId} and prospect_id = ${input.prospectId}
            and archived_at is null
        `;
        if (!contact) {
          throw new ClassifiedError("validation", "Contact not found on this prospect.");
        }
      }
      const finding = await getPrimaryFinding(tx, input.prospectId);

      let subject = input.subject ?? null;
      let body = input.body ?? null;
      let tone = input.tone ?? null;
      let cta = input.cta ?? null;
      let generatedBy: "system" | "operator" = "operator";
      let promptVersion: string | null = null;

      if (!body) {
        const [benchmark] = await tx`
          select run_id from prospect_benchmarks where id = ${finding.benchmarkId}
        `;
        const run = benchmark ? await runSummary(benchmark.runId as string) : null;
        const draftMarketName = await launchMarketName(tx, prospect.launchId);
        // The email's proof is the published audit page (plan 3.1) — the
        // page CTA says "reply to the email that brought you here", so the
        // email must actually carry the link. Unpublished or no APP_URL →
        // the template falls back to the pure reply-first ask.
        const [publishedAudit] = await tx`
          select access_token from prospect_audits
          where prospect_id = ${input.prospectId} and status = 'published'
            and (expires_at is null or expires_at > now())
        `;
        // Spec 052 (audit F17): a published audit whose link cannot resolve
        // must refuse, not silently generate the no-link fallback — the
        // first real outreach email would ship without its entire proof.
        if (publishedAudit && auditUrl(publishedAudit.accessToken as string) === null) {
          throw new ClassifiedError(
            "validation",
            "APP_URL is not configured — the draft would omit the published audit link that is its proof. Set APP_URL, then generate the draft."
          );
        }
        // Sender identity (spec 052): the compliant footer is embedded at
        // generation time, so a manual send copied from this draft carries
        // the postal address and opt-out path too.
        const draftIdentity = await getActiveSenderIdentity();
        if (!draftIdentity) {
          throw new ClassifiedError(
            "validation",
            "No sender identity is configured — an admin must set the legal sender (name, company, postal address) before outreach drafts can be generated."
          );
        }
        const generated = generateReplyFirstEmail({
          prospectName: prospect.businessName,
          teamLeader: prospect.teamLeader,
          marketName: draftMarketName,
          findingTitle: finding.title,
          findingExplanation: finding.explanation,
          providers: run?.providers ?? [],
          sampleSize: run?.responseCount ?? 0,
          // Branded link preferred (spec 076): the first readable thing in
          // the emailed URL is the prospect's own name. Legacy token URL is
          // the fallback for prospects minted before the feature.
          auditUrl: publishedAudit
            ? await (async () => {
                const link = await auditLinkForProspect(input.prospectId, tx);
                return (
                  (link ? brandedAuditUrl(link.slug, link.key) : null) ??
                  auditUrl(publishedAudit.accessToken as string)
                );
              })()
            : null,
        });
        subject = generated.subject;
        body = generated.body + optOutFooter(draftIdentity);
        tone = generated.tone;
        cta = generated.cta;
        generatedBy = "system";
        promptVersion = generated.promptVersion;
      }

      const [latest] = await tx`
        select id, version from outreach_drafts
        where prospect_id = ${input.prospectId} and channel = ${input.channel}
        order by version desc limit 1
      `;
      const version = latest ? Number(latest.version) + 1 : 1;
      const [row] = await tx`
        insert into outreach_drafts
          (prospect_id, finding_id, channel, contact_id, version, parent_id,
           subject, body, tone, cta, generated_by, prompt_version, created_by)
        values (${input.prospectId}, ${finding.id}, ${input.channel},
          ${input.contactId ?? null}, ${version},
          ${latest?.id ?? null}, ${subject}, ${body}, ${tone}, ${cta},
          ${generatedBy}, ${promptVersion}, ${user.id})
        returning id
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.draft_create",
        entity: "outreach_draft",
        entityId: row?.id as string,
        detail: { prospectId: input.prospectId, channel: input.channel, version, generatedBy },
      });
      await logActivity(
        tx,
        input.prospectId,
        "draft_created",
        { channel: input.channel, version, generatedBy },
        user.id
      );
      return { draftId: row?.id as string, version };
    });
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}

/**
 * The recipient gates shared by approval and record-sent, fail-closed and in
 * order: account do-not-contact → contact do-not-contact → global suppression
 * list on the recipient's normalised identifiers (roadmap 2.3 acceptance:
 * "suppression checks match on contact identifiers"). A draft with no email
 * or phone on file has nothing to match — the DNC gates still apply.
 */
async function assertRecipientContactable(
  tx: TransactionSql,
  prospect: ProspectRow,
  contactId: string | null,
  refusalVerb: string
): Promise<void> {
  if (prospect.doNotContact) {
    throw new ClassifiedError(
      "validation",
      `This prospect is flagged do-not-contact — ${refusalVerb}.`
    );
  }
  let email = prospect.email;
  let phone = prospect.phone;
  if (contactId) {
    const [contact] = await tx`
      select name, email, phone, do_not_contact, archived_at
      from prospect_contacts where id = ${contactId}
    `;
    if (!contact || contact.archivedAt) {
      throw new ClassifiedError(
        "validation",
        `The draft's contact has been removed — ${refusalVerb}.`
      );
    }
    if (contact.doNotContact) {
      throw new ClassifiedError(
        "validation",
        `Contact "${contact.name}" is flagged do-not-contact — ${refusalVerb}.`
      );
    }
    email = (contact.email as string | null) ?? email;
    phone = (contact.phone as string | null) ?? phone;
  }
  if (email || phone) {
    const suppression = await checkSuppression({ email, phone, projectId: null });
    if (suppression.suppressed) {
      throw new ClassifiedError(
        "validation",
        `The recipient is on the suppression list (${suppression.matchedScope}: ${suppression.reason}) — ${refusalVerb}.`
      );
    }
  }
}

export async function approveOutreachDraft(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ draftId: string }>> {
  const parsed = z.object({ draftId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid draft id."));
  }
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const [draft] = await tx`
        select d.id, d.prospect_id, d.channel, d.contact_id, d.body, d.subject, d.status
        from outreach_drafts d where d.id = ${parsed.data.draftId} for update
      `;
      if (!draft) throw new ClassifiedError("not_found", "Draft not found.");
      if (draft.status !== "draft") {
        throw new ClassifiedError("conflict", `Draft is already ${draft.status}.`);
      }
      const prospect = await lockProspect(tx, draft.prospectId as string);
      await assertRecipientContactable(
        tx,
        prospect,
        (draft.contactId as string | null) ?? null,
        "outreach cannot be approved"
      );
      const banned =
        findProhibitedPhrase((draft.body as string) ?? "") ??
        findProhibitedPhrase((draft.subject as string) ?? "");
      if (banned) {
        throw new ClassifiedError(
          "validation",
          `The draft contains prohibited wording ("${banned}") — remove it before approval.`
        );
      }
      // Superseding also clears any pending schedule (spec 091): the worker
      // only transmits status = 'approved' rows, but a dead schedule left on
      // a superseded draft would read as a send that is still coming.
      await tx`
        update outreach_drafts set status = 'superseded',
          scheduled_send_at = null, send_claimed_at = null
        where prospect_id = ${draft.prospectId} and channel = ${draft.channel}
          and status = 'approved' and id != ${draft.id}
      `;
      await tx`
        update outreach_drafts set status = 'approved',
          approved_by = ${user.id}, approved_at = now()
        where id = ${draft.id}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.draft_approve",
        entity: "outreach_draft",
        entityId: draft.id as string,
        detail: { prospectId: draft.prospectId, channel: draft.channel },
      });
      await logActivity(
        tx,
        draft.prospectId as string,
        "draft_approved",
        { draftId: draft.id, channel: draft.channel },
        user.id
      );
    });
    return ok({ draftId: parsed.data.draftId });
  } catch (err) {
    return fail(err);
  }
}

/** Records that a human sent the approved draft outside the platform. */
export async function recordDraftSent(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ draftId: string }>> {
  const parsed = z.object({ draftId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid draft id."));
  }
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const [draft] = await tx`
        select id, prospect_id, channel, contact_id, status, sent_recorded_at
        from outreach_drafts where id = ${parsed.data.draftId} for update
      `;
      if (!draft) throw new ClassifiedError("not_found", "Draft not found.");
      if (draft.status !== "approved") {
        throw new ClassifiedError("validation", "Only approved drafts can be recorded as sent.");
      }
      if (draft.sentRecordedAt) {
        throw new ClassifiedError("conflict", "This draft is already recorded as sent.");
      }
      const prospect = await lockProspect(tx, draft.prospectId as string);
      await assertRecipientContactable(
        tx,
        prospect,
        (draft.contactId as string | null) ?? null,
        "a send cannot be recorded"
      );
      await tx`
        update outreach_drafts set sent_recorded_at = now(), sent_recorded_by = ${user.id}
        where id = ${draft.id}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.draft_sent_recorded",
        entity: "outreach_draft",
        entityId: draft.id as string,
        detail: { prospectId: draft.prospectId, channel: draft.channel },
      });
      await logActivity(
        tx,
        draft.prospectId as string,
        "draft_sent_recorded",
        { draftId: draft.id, channel: draft.channel },
        user.id
      );
    });
    return ok({ draftId: parsed.data.draftId });
  } catch (err) {
    return fail(err);
  }
}

/**
 * Schedule an approved draft's transmission (spec 091). This is a second
 * explicit human act on an already-approved draft — approval freezes the
 * text, scheduling names the time. The worker (drainScheduledSends) only
 * ever transmits what this recorded, through the same sendProspectDraft
 * gate a human click uses, and the gate re-runs in full at send time.
 */
export async function scheduleDraftSend(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ draftId: string; sendAt: string }>> {
  const parsed = z
    .object({
      draftId: z.string().uuid(),
      sendAt: z.coerce.date(),
      businessPurpose: z.string().trim().min(10).max(1000),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(
      new ClassifiedError(
        "validation",
        "Scheduling needs a draft, a send time, and a stated business purpose (≥ 10 characters)."
      )
    );
  }
  const { draftId, sendAt, businessPurpose } = parsed.data;
  try {
    assertCanWrite(user);
    const now = Date.now();
    if (sendAt.getTime() <= now) {
      throw new ClassifiedError(
        "validation",
        "The scheduled time is in the past — use Send via Gmail for an immediate send."
      );
    }
    if (sendAt.getTime() > now + SCHEDULED_SEND_MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000) {
      throw new ClassifiedError(
        "validation",
        `Sends can be scheduled at most ${SCHEDULED_SEND_MAX_DAYS_AHEAD} days ahead.`
      );
    }
    await sql.begin(async (tx) => {
      const [draft] = await tx`
        select id, prospect_id, contact_id, status, sent_recorded_at
        from outreach_drafts where id = ${draftId} for update
      `;
      if (!draft) throw new ClassifiedError("not_found", "Draft not found.");
      if (draft.status !== "approved") {
        throw new ClassifiedError("validation", "Only approved drafts can be scheduled.");
      }
      if (draft.sentRecordedAt) {
        throw new ClassifiedError("conflict", "This draft already has a recorded send.");
      }
      // Early feedback only — the authoritative gate re-runs at send time.
      const prospect = await lockProspect(tx, draft.prospectId as string);
      await assertRecipientContactable(
        tx,
        prospect,
        (draft.contactId as string | null) ?? null,
        "a send cannot be scheduled"
      );
      await tx`
        update outreach_drafts set
          scheduled_send_at = ${sendAt}, scheduled_by = ${user.id},
          scheduled_business_purpose = ${businessPurpose},
          send_attempts = 0, send_claimed_at = null, last_send_error = null
        where id = ${draft.id}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.send_scheduled",
        entity: "outreach_draft",
        entityId: draft.id as string,
        detail: { prospectId: draft.prospectId, sendAt: sendAt.toISOString() },
      });
      await logActivity(
        tx,
        draft.prospectId as string,
        "send_scheduled",
        { draftId: draft.id, sendAt: sendAt.toISOString() },
        user.id
      );
    });
    return ok({ draftId, sendAt: sendAt.toISOString() });
  } catch (err) {
    return fail(err);
  }
}

/** Cancel a pending scheduled send. Idempotent on an unscheduled draft. */
export async function cancelScheduledSend(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ draftId: string }>> {
  const parsed = z.object({ draftId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid draft id."));
  }
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const [draft] = await tx`
        select id, prospect_id, scheduled_send_at, send_claimed_at
        from outreach_drafts where id = ${parsed.data.draftId} for update
      `;
      if (!draft) throw new ClassifiedError("not_found", "Draft not found.");
      if (draft.sendClaimedAt) {
        throw new ClassifiedError(
          "conflict",
          "The worker has already claimed this send — it may be transmitting right now. Check the send ledger before rescheduling."
        );
      }
      await tx`
        update outreach_drafts set
          scheduled_send_at = null, send_attempts = 0, last_send_error = null
        where id = ${draft.id}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.send_schedule_cancelled",
        entity: "outreach_draft",
        entityId: draft.id as string,
        detail: {
          prospectId: draft.prospectId,
          wasScheduledFor: draft.scheduledSendAt
            ? (draft.scheduledSendAt as Date).toISOString()
            : null,
        },
      });
      await logActivity(
        tx,
        draft.prospectId as string,
        "send_schedule_cancelled",
        { draftId: draft.id },
        user.id
      );
    });
    return ok({ draftId: parsed.data.draftId });
  } catch (err) {
    return fail(err);
  }
}

// Not exported: stamped into ledger rows, no external consumer.
// v2 (spec 091): adds the daily_send_cap check for transmitting gmail sends.
const SEND_GATE_VERSION = "prospect-send-gate-v2";

/**
 * The bridge between the two outreach stacks (spec 043): every dispatch —
 * and every gate refusal — leaves an insert-only ledger row with the full
 * check list and the sha256 of the exact text. First touch stays human:
 * this runs behind a human click, or behind the worker transmitting a
 * send a human explicitly approved and scheduled (spec 091 — the schedule
 * defers a confirmed action, never originates one; DECISIONS.md).
 *
 * Dispatch happens inside the transaction. For 'manual'/'mock' that is
 * trivially safe (in-process, instant). For 'gmail' it means the gate's
 * row locks are held across one bounded HTTP call — acceptable at this
 * volume (GMAIL_DAILY_SEND_CAP), and it keeps the invariant that a ledger
 * row and its draft's sent-marker commit atomically. The crash window
 * between Gmail accepting and the commit is covered on the scheduled path
 * by the claim marker in drainScheduledSends (never auto-retried).
 */
export async function sendProspectDraft(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ sendId: string; providerMessageId: string | null }>> {
  const parsed = z
    .object({
      draftId: z.string().uuid(),
      channel: z.string().min(1),
      businessPurpose: z.string().trim().min(10).max(1000),
      /** True when a worker, not a human, is dispatching (scheduled send).
       * Adds the conversation-state gate: no transmit after a recorded reply. */
      unattended: z.boolean().optional(),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(
      new ClassifiedError(
        "validation",
        "A send needs a draft, a channel, and a stated business purpose (≥ 10 characters)."
      )
    );
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    const channel = getEmailChannel(input.channel); // throws for guarded mock
    const result = await sql.begin(async (tx) => {
      const [draft] = await tx`
        select id, prospect_id, contact_id, subject, body, status, sent_recorded_at
        from outreach_drafts where id = ${input.draftId} for update
      `;
      if (!draft) throw new ClassifiedError("not_found", "Draft not found.");
      if (draft.status !== "approved") {
        throw new ClassifiedError("validation", "Only approved drafts can be sent.");
      }
      if (draft.sentRecordedAt) {
        throw new ClassifiedError("conflict", "This draft already has a recorded send.");
      }
      const prospect = await lockProspect(tx, draft.prospectId as string);

      // Resolve the recipient and run the gate chain, collecting verdicts.
      const checks: { name: string; passed: boolean; detail: string }[] = [];
      let failed: string | null = null;
      const check = (name: string, passed: boolean, detail: string): void => {
        checks.push({ name, passed, detail });
        if (!passed && failed === null) failed = detail;
      };

      let email = prospect.email;
      let phone = prospect.phone;
      let contactBlocked: string | null = null;
      if (draft.contactId) {
        const [contact] = await tx`
          select name, email, phone, do_not_contact, archived_at
          from prospect_contacts where id = ${draft.contactId}
        `;
        if (!contact || contact.archivedAt) {
          contactBlocked = "The draft's contact has been removed.";
        } else if (contact.doNotContact) {
          contactBlocked = `Contact "${contact.name}" is flagged do-not-contact.`;
        } else {
          email = (contact.email as string | null) ?? email;
          phone = (contact.phone as string | null) ?? phone;
        }
      }
      check(
        "account_do_not_contact",
        !prospect.doNotContact,
        prospect.doNotContact ? "The prospect account is flagged do-not-contact." : "clear"
      );
      check("contact_do_not_contact", contactBlocked === null, contactBlocked ?? "clear");

      // Spec 099: a queued draft must never transmit past a recorded reply
      // or exit. Human sends stay free (the ladder sends the audit after a
      // reply); the worker is not a human.
      const stageBlocksUnattended = (
        UNATTENDED_SEND_BLOCKED_STAGES as readonly ProspectStage[]
      ).includes(prospect.stage);
      check(
        "conversation_state",
        !(input.unattended && stageBlocksUnattended),
        input.unattended
          ? stageBlocksUnattended
            ? `Prospect stage is "${prospect.stage}" — an unattended send would continue a sequence past a recorded reply or exit.`
            : `stage "${prospect.stage}" allows unattended outreach`
          : "human-initiated send — not gated on stage"
      );

      if ((email || phone) && !prospect.doNotContact && contactBlocked === null) {
        const suppression = await checkSuppression({ email, phone, projectId: null });
        check(
          "suppression",
          !suppression.suppressed,
          suppression.suppressed
            ? `Recipient is suppressed (${suppression.matchedScope}: ${suppression.reason}).`
            : "not suppressed"
        );
      } else {
        check("suppression", true, "no identifiers to match");
      }

      // Re-contact guards (spec 052, audit 9.3): DNC was per-prospect only —
      // the same human under two prospects, or one brokerage's teams in
      // quick succession, had no guard at all.
      if (email) {
        const [personPrior] = await tx`
          select s.sent_at from prospect_outreach_sends s
          where s.allowed and s.recipient_email is not null
            and lower(s.recipient_email) = ${email.toLowerCase()}
            and s.prospect_id != ${draft.prospectId}
            and s.sent_at > now() - make_interval(days => ${RECONTACT_PERSON_WINDOW_DAYS})
          order by s.sent_at desc limit 1
        `;
        check(
          "recontact_person",
          !personPrior,
          personPrior
            ? `This person was already contacted under another prospect on ${(personPrior.sentAt as Date).toISOString().slice(0, 10)} — within the ${RECONTACT_PERSON_WINDOW_DAYS}-day window.`
            : "no cross-prospect contact in the window"
        );
      } else {
        check("recontact_person", true, "no email to match");
      }
      // brokerage_affiliation rides the lockProspect column list now — the
      // row was already locked above, so re-selecting it was pure waste.
      const brokerage = prospect.brokerageAffiliation?.trim();
      if (brokerage) {
        const [{ n } = { n: 0 }] = await tx`
          select count(*)::int as n from prospect_outreach_sends s
          join prospects p on p.id = s.prospect_id
          where s.allowed
            and lower(trim(p.brokerage_affiliation)) = ${brokerage.toLowerCase()}
            and s.sent_at > now() - interval '30 days'
        `;
        check(
          "recontact_brokerage",
          Number(n) < BROKERAGE_SEND_CAP_30D,
          Number(n) < BROKERAGE_SEND_CAP_30D
            ? `${n} of ${BROKERAGE_SEND_CAP_30D} brokerage sends used this month`
            : `${brokerage} already received ${n} sends in 30 days — the cap is ${BROKERAGE_SEND_CAP_30D}.`
        );
      } else {
        check("recontact_brokerage", true, "no brokerage affiliation recorded");
      }

      // Territory re-check (spec 052, audit 10.7): the exclusivity gate ran
      // once at outreach_ready and never again — signing a client agreement
      // did not suppress conflicting in-flight sends. Every send re-checks;
      // a recorded admin override (conflict_status) is honored.
      if (prospect.conflictStatus === "override") {
        check("territory_conflict", true, "admin override recorded at the stage gate");
      } else {
        const [launch] = await tx`
          select market_id, service_category, price_segment
          from market_launches where id = ${prospect.launchId}
        `;
        if (launch) {
          const detection = await detectLaunchConflicts(tx, {
            marketId: launch.marketId as string,
            serviceCategory: (launch.serviceCategory as string) ?? null,
            priceSegment: (launch.priceSegment as string) ?? null,
          });
          check(
            "territory_conflict",
            detection.worstVerdict === "clear",
            detection.worstVerdict === "clear"
              ? "no territory conflict at send time"
              : `Territory conflict (${detection.worstVerdict}) detected at send time — a client agreement or reservation covers this market. Resolve or record an admin override before sending.`
          );
        } else {
          check("territory_conflict", true, "prospect has no launch market");
        }
      }

      // Sender identity (spec 052): cold outreach refuses until an admin has
      // configured the legal sender — name, company, physical postal address.
      const identity = await getActiveSenderIdentity();
      check(
        "sender_identity",
        identity !== null,
        identity
          ? `sending as ${identity.senderName}, ${identity.companyName}`
          : "No sender identity is configured — set the legal sender (name, company, postal address) before any outreach."
      );

      // Daily transmission cap (spec 091): a warming sender address. Counts
      // allowed gmail sends in the trailing 24h — refusals don't consume cap.
      if (channel.id === "gmail") {
        const [{ n } = { n: 0 }] = await tx`
          select count(*)::int as n from prospect_outreach_sends
          where channel = 'gmail' and allowed
            and sent_at > now() - interval '24 hours'
        `;
        check(
          "daily_send_cap",
          Number(n) < GMAIL_DAILY_SEND_CAP,
          Number(n) < GMAIL_DAILY_SEND_CAP
            ? `${n} of ${GMAIL_DAILY_SEND_CAP} daily Gmail sends used`
            : `The daily Gmail cap of ${GMAIL_DAILY_SEND_CAP} sends is spent — the send refuses until the 24-hour window clears.`
        );
      }

      let body = (draft.body as string) ?? "";
      if (channel.transmits) {
        check(
          "recipient_email",
          Boolean(email),
          email ? `recipient ${email}` : "A transmitting channel needs a recipient email."
        );
        if (identity && !hasOptOutMention(body)) body += optOutFooter(identity);
        check(
          "opt_out_path",
          hasOptOutMention(body),
          "opt-out instruction present in the outgoing text"
        );
        check(
          "postal_address",
          identity !== null && body.includes(identity.postalAddress),
          identity
            ? body.includes(identity.postalAddress)
              ? "physical postal address present (CAN-SPAM)"
              : "The outgoing text does not carry the sender's postal address."
            : "no sender identity to source the postal address from"
        );
      } else {
        check("recipient_email", true, "manual channel — the human used their own mailbox");
        check("opt_out_path", true, "not gated for manual records");
      }

      const banned =
        findProhibitedPhrase(body) ?? findProhibitedPhrase((draft.subject as string) ?? "");
      check(
        "prohibited_phrases",
        banned === null,
        banned ? `Contains prohibited wording ("${banned}").` : "clean"
      );

      // body_hash stays on the PLAIN text — the human-approved artifact.
      // The HTML part (spec 092) is a mechanical rendering of that text
      // plus the open-tracking pixel; it carries no content of its own.
      const bodyHash = createHash("sha256")
        .update(`${(draft.subject as string) ?? ""}\n${body}`)
        .digest("hex");
      const allowed = failed === null;

      const writeLedger = async (
        providerMessageId: string | null,
        openToken: string | null
      ): Promise<string> => {
        const [row] = await tx`
          insert into prospect_outreach_sends
            (draft_id, prospect_id, channel, recipient_email, body_hash,
             business_purpose, gate_verdict, allowed, provider_message_id,
             sent_by, open_token)
          values (${draft.id}, ${draft.prospectId}, ${channel.id}, ${email ?? null},
            ${bodyHash}, ${input.businessPurpose},
            ${tx.json({ version: SEND_GATE_VERSION, checks } as never)},
            ${allowed}, ${providerMessageId}, ${user.id}, ${openToken})
          returning id
        `;
        return row?.id as string;
      };

      // Refusals are evidence too — ledgered and audited, which is why this
      // RETURNS instead of throwing: a throw would roll the ledger row back.
      if (!allowed) {
        const refusalId = await writeLedger(null, null);
        await writeAudit(tx, {
          userId: user.id,
          action: "prospect.send_refused",
          entity: "prospect_outreach_send",
          entityId: refusalId,
          detail: { draftId: draft.id, channel: channel.id, reason: failed },
        });
        return { refused: failed ?? "gate check failed" };
      }

      // Open tracking (spec 092): telemetry, never a gate — no APP_URL
      // means the send transmits untracked (plain text, token null).
      let openToken: string | null = null;
      let htmlBody: string | null = null;
      if (channel.id === "gmail") {
        const token = randomBytes(16).toString("hex");
        const pixel = openPixelUrl(token);
        if (pixel) {
          openToken = token;
          htmlBody = plainTextToTrackedHtml(body, pixel);
        }
      }

      // Dispatch before the ledger row so the insert-only row carries the
      // provider message id (both current channels are in-process; a
      // network channel restructures this into claim → dispatch → finalize).
      const dispatched = await channel.dispatch({
        recipientEmail: email,
        subject: (draft.subject as string) ?? null,
        body,
        htmlBody,
      });
      const sendId = await writeLedger(dispatched.providerMessageId, openToken);

      await tx`
        update outreach_drafts set sent_recorded_at = now(), sent_recorded_by = ${user.id}
        where id = ${draft.id}
      `;
      // A transmitted send is a machine-observable fact: the recorded stage
      // follows the ledger instead of waiting for a hand edit (spec 098 —
      // 12 contacted prospects sat at "identified" for a day). Only the
      // pre-contact stages move; later stages are the operator's.
      const [stageRow] = await tx`
        select stage from prospects where id = ${draft.prospectId}
      `;
      const currentStage = stageRow?.stage as ProspectStage | undefined;
      if (currentStage && (PRE_CONTACT_STAGES as readonly string[]).includes(currentStage)) {
        await tx`
          update prospects set stage = ${CONTACT_GATE_STAGE}, updated_at = now()
          where id = ${draft.prospectId}
        `;
        await tx`
          insert into prospect_stage_history (prospect_id, from_stage, to_stage, reason, changed_by)
          values (${draft.prospectId}, ${currentStage}, ${CONTACT_GATE_STAGE},
            ${"Advanced automatically: allowed send recorded in the ledger"}, ${user.id})
        `;
      }
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.draft_sent",
        entity: "prospect_outreach_send",
        entityId: sendId,
        detail: { draftId: draft.id, channel: channel.id, bodyHash },
      });
      await logActivity(
        tx,
        draft.prospectId as string,
        "draft_sent",
        { draftId: draft.id, channel: channel.id },
        user.id
      );
      return { sendId, providerMessageId: dispatched.providerMessageId };
    });
    if ("refused" in result) {
      return fail(new ClassifiedError("validation", `Send refused: ${result.refused}`));
    }
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------------------
// Screen-recording plans

export async function generateRecordingPlan(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ planId: string }>> {
  const parsed = z.object({ prospectId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid prospect id."));
  }
  try {
    assertCanWrite(user);
    const planId = await sql.begin(async (tx) => {
      const prospect = await lockProspect(tx, parsed.data.prospectId);
      const finding = await getPrimaryFinding(tx, parsed.data.prospectId);
      const [benchmark] = await tx`
        select run_id from prospect_benchmarks where id = ${finding.benchmarkId}
      `;
      const run = benchmark ? await runSummary(benchmark.runId as string) : null;
      const planMarketName = await launchMarketName(tx, prospect.launchId);
      const rivalNames = finding.competitorCompanyIds.length
        ? (
            await tx`
              select name from companies
              where id = any(${finding.competitorCompanyIds}::uuid[])
              order by name
            `
          ).map((r) => r.name as string)
        : [];
      const evidence = await promptEvidenceForResponses(finding.responseIds, 2);

      const plan = buildRecordingPlan({
        prospectName: prospect.businessName,
        marketName: planMarketName,
        findingTitle: finding.title,
        findingExplanation: finding.explanation,
        competitorNames: rivalNames,
        providers: run?.providers ?? [],
        sampleSize: run?.responseCount ?? 0,
        examplePrompts: evidence.map((e) => e.promptText),
      });

      const [row] = await tx`
        insert into screen_recording_plans
          (prospect_id, finding_id, script, storyboard, estimated_duration_seconds,
           claims_to_verify, cta, generator_version, created_by)
        values (${parsed.data.prospectId}, ${finding.id}, ${plan.script},
          ${tx.json(plan.storyboard as never)}, ${plan.estimatedDurationSeconds},
          ${tx.json(plan.claimsToVerify as never)}, ${plan.cta},
          ${plan.generatorVersion}, ${user.id})
        returning id
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.recording_generate",
        entity: "screen_recording_plan",
        entityId: row?.id as string,
        detail: { prospectId: parsed.data.prospectId, findingId: finding.id },
      });
      await logActivity(
        tx,
        parsed.data.prospectId,
        "recording_plan_generated",
        { planId: row?.id },
        user.id
      );
      return row?.id as string;
    });
    return ok({ planId });
  } catch (err) {
    return fail(err);
  }
}

export async function setRecordingStatus(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ planId: string }>> {
  const parsed = z
    .object({ planId: z.string().uuid(), status: z.enum(RECORDING_STATUSES) })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const [row] = await tx`
        update screen_recording_plans
        set status = ${parsed.data.status}, updated_at = now()
        where id = ${parsed.data.planId}
        returning id, prospect_id
      `;
      if (!row) throw new ClassifiedError("not_found", "Recording plan not found.");
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.recording_status",
        entity: "screen_recording_plan",
        entityId: parsed.data.planId,
        detail: { status: parsed.data.status },
      });
      await logActivity(
        tx,
        row.prospectId as string,
        "recording_status",
        { planId: parsed.data.planId, status: parsed.data.status },
        user.id
      );
    });
    return ok({ planId: parsed.data.planId });
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------------------
// Pipeline

export async function transitionStage(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ prospectId: string; stage: ProspectStage }>> {
  const parsed = z
    .object({
      prospectId: z.string().uuid(),
      toStage: z.enum(ALL_PROSPECT_STAGES as [ProspectStage, ...ProspectStage[]]),
      reason: z.string().trim().max(1000).optional(),
      override: z.boolean().default(false),
      overrideRationale: z.string().trim().max(2000).optional(),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    // The blocked outcome COMMITS (the check record and conflict status are
    // evidence) while the stage change is skipped — so the tx returns an
    // outcome instead of throwing.
    const outcome = await sql.begin(async (tx): Promise<{ blockedVerdict: string | null }> => {
      const prospect = await lockProspect(tx, input.prospectId);
      let conflictStatus = prospect.conflictStatus;
      let exclusivityCheckId: string | null = null;

      const verdict = validateTransition({
        fromStage: prospect.stage,
        toStage: input.toStage,
        conflictStatus,
        doNotContact: prospect.doNotContact,
      });
      if (!verdict.allowed) {
        throw new ClassifiedError("validation", verdict.reason);
      }

      if (verdict.requiresConflictCheck) {
        const [launch] = await tx`
          select market_id, service_category, price_segment
          from market_launches where id = ${prospect.launchId}
        `;
        if (!launch) throw new ClassifiedError("not_found", "Launch not found.");
        const detection = await detectLaunchConflicts(tx, {
          marketId: launch.marketId as string,
          serviceCategory: (launch.serviceCategory as string) ?? null,
          priceSegment: (launch.priceSegment as string) ?? null,
        });

        let decision: "clear" | "blocked" | "override";
        if (detection.worstVerdict === "clear") {
          decision = "clear";
          conflictStatus = "clear";
        } else if (input.override) {
          // Progressing past a detected conflict is an owner decision with a
          // written reason (mirrors spec 028's override rule).
          assertRole(user, "admin");
          if (!input.overrideRationale?.trim()) {
            throw new ClassifiedError("validation", "An override requires a rationale.");
          }
          decision = "override";
          conflictStatus = "override";
        } else {
          decision = "blocked";
          conflictStatus = detection.worstVerdict as ConflictStatus;
        }

        const [check] = await tx`
          insert into exclusivity_checks
            (prospect_name, market_id, service_category, segment, result,
             worst_verdict, decision, override_rationale, checked_by)
          values (${prospect.businessName}, ${launch.marketId},
            ${(launch.serviceCategory as string) ?? null},
            ${(launch.priceSegment as string) ?? null},
            ${tx.json(detection as never)}, ${detection.worstVerdict}, ${decision},
            ${decision === "override" ? (input.overrideRationale ?? null) : null},
            ${user.id})
          returning id
        `;
        exclusivityCheckId = check?.id as string;
        await tx`
          update prospects set conflict_status = ${conflictStatus},
            last_exclusivity_check_id = ${exclusivityCheckId}, updated_at = now()
          where id = ${input.prospectId}
        `;
        await logActivity(
          tx,
          input.prospectId,
          "conflict_checked",
          { verdict: detection.worstVerdict, decision },
          user.id
        );

        if (decision === "blocked") {
          await writeAudit(tx, {
            userId: user.id,
            action: "prospect.stage_blocked",
            entity: "prospect",
            entityId: input.prospectId,
            detail: { toStage: input.toStage, verdict: detection.worstVerdict },
          });
          return { blockedVerdict: detection.worstVerdict };
        }
      }

      await tx`
        update prospects set stage = ${input.toStage}, updated_at = now()
        where id = ${input.prospectId}
      `;
      await tx`
        insert into prospect_stage_history
          (prospect_id, from_stage, to_stage, reason, exclusivity_check_id, changed_by)
        values (${input.prospectId}, ${prospect.stage}, ${input.toStage},
          ${input.reason ?? null}, ${exclusivityCheckId}, ${user.id})
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.stage_change",
        entity: "prospect",
        entityId: input.prospectId,
        detail: { from: prospect.stage, to: input.toStage, override: input.override },
      });
      await logActivity(
        tx,
        input.prospectId,
        "stage_changed",
        { from: prospect.stage, to: input.toStage },
        user.id
      );
      return { blockedVerdict: null };
    });
    if (outcome.blockedVerdict) {
      return fail(
        new ClassifiedError(
          "conflict",
          `Exclusivity conflict detected (${outcome.blockedVerdict}) — progression blocked. An admin can override with a written rationale.`
        )
      );
    }
    return ok({ prospectId: input.prospectId, stage: input.toStage });
  } catch (err) {
    return fail(err);
  }
}

export async function addActivityNote(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ prospectId: string }>> {
  const parsed = z
    .object({ prospectId: z.string().uuid(), note: z.string().trim().min(1).max(5000) })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      await lockProspect(tx, parsed.data.prospectId);
      await logActivity(tx, parsed.data.prospectId, "note", { note: parsed.data.note }, user.id);
    });
    return ok({ prospectId: parsed.data.prospectId });
  } catch (err) {
    return fail(err);
  }
}

// ------------------------------------------------- promotion (spec 057)

const promoteSchema = z.object({
  prospectId: z.string().uuid(),
  /** Territory at close: an ACTIVE agreement scoped to the launch market.
   * Declinable for engagements sold without exclusivity. */
  createAgreement: z.boolean().default(true),
  agreementEndsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  gracePeriodDays: z.number().int().min(0).max(3650).default(0),
});

/**
 * The close finally has a side effect (spec 057, audit 12.1-12.3): an
 * explicit, audited promotion — never a hidden consequence of a stage
 * click. The benchmark project converts IN PLACE (kind prospect -> client),
 * so every pre-signing capture, mention, score, and tracked competitor
 * becomes the client's first baseline and the first client report has a
 * comparable prior — the platform stops paying twice for research it
 * already did (audit B5).
 *
 * Ordering: the exclusivity agreement is created before the core
 * promotion transaction (it runs its own transaction); a failure between
 * the two leaves an audited agreement on an unpromoted project — visible
 * and repairable — never a promoted client without its recorded close.
 */
export async function promoteProspectToClient(
  user: CurrentUser,
  raw: unknown
): Promise<
  ActionResult<{ projectId: string; agreementId: string | null; renamed: boolean }>
> {
  const parsed = promoteSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    const [prospect] = await sql`
      select p.id, p.stage, p.business_name, p.company_id, p.launch_id,
        p.benchmark_project_id, p.promoted_project_id, p.archived_at,
        l.market_id, l.service_category, l.price_segment
      from prospects p
      join market_launches l on l.id = p.launch_id
      where p.id = ${input.prospectId}
    `;
    if (!prospect || prospect.archivedAt) {
      return fail(new ClassifiedError("not_found", "Prospect not found."));
    }
    if (prospect.promotedProjectId) {
      return fail(
        new ClassifiedError("conflict", "This prospect was already promoted to a client.")
      );
    }
    if (prospect.stage !== "contracted") {
      return fail(
        new ClassifiedError(
          "validation",
          `Only a contracted prospect can be promoted (this one is at "${prospect.stage}").`
        )
      );
    }
    if (!prospect.companyId) {
      return fail(
        new ClassifiedError(
          "validation",
          "Link the prospect to its canonical company before promoting — a client without an identity cannot be measured."
        )
      );
    }

    // Ensure the client project: convert the benchmark, or create fresh.
    let projectId = prospect.benchmarkProjectId as string | null;
    if (!projectId) {
      const created = await createProject(user, {
        name: prospect.businessName as string,
        description: `Promoted from prospect ${prospect.id} (spec 057).`,
      });
      if (!created.ok) return created;
      projectId = created.data.id;
      const subject = await setSubjectCompany(user, {
        projectId,
        companyId: prospect.companyId as string,
      });
      if (!subject.ok) return subject;
    }

    let agreementId: string | null = null;
    if (input.createAgreement) {
      const agreement = await createAgreement(user, {
        projectId,
        startsOn: todayIso(),
        endsOn: input.agreementEndsOn ?? null,
        gracePeriodDays: input.gracePeriodDays,
        status: "active",
        notes: `Created at prospect promotion (spec 057), prospect ${prospect.id}.`,
        scopes: [
          {
            marketId: prospect.marketId as string,
            serviceCategory: (prospect.serviceCategory as string | null) ?? null,
            segment: (prospect.priceSegment as string | null) ?? null,
          },
        ],
      });
      if (!agreement.ok) return agreement;
      agreementId = agreement.data.agreementId;
    }

    const renamed = await sql.begin(async (tx) => {
      let didRename = false;
      if (prospect.benchmarkProjectId) {
        // Collision-checked rename: an existing active project owning the
        // business name keeps it — the benchmark name survives, noted in
        // the audit detail, and the operator can rename later.
        const [collision] = await tx`
          select 1 from projects
          where lower(name) = lower(${prospect.businessName})
            and status = 'active' and id != ${projectId}
        `;
        if (collision) {
          await tx`
            update projects set kind = 'client' where id = ${projectId}
          `;
        } else {
          await tx`
            update projects set kind = 'client', name = ${prospect.businessName}
            where id = ${projectId}
          `;
          didRename = true;
        }
      }
      await tx`
        update prospects
        set promoted_project_id = ${projectId}, updated_at = now()
        where id = ${prospect.id}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.promoted",
        entity: "prospect",
        entityId: prospect.id as string,
        detail: {
          projectId,
          agreementId,
          convertedBenchmark: Boolean(prospect.benchmarkProjectId),
          renamed: didRename,
        },
      });
      await logActivity(
        tx,
        prospect.id as string,
        "promoted_to_client",
        { projectId, agreementId },
        user.id
      );
      return didRename;
    });

    return ok({ projectId, agreementId, renamed });
  } catch (err) {
    return fail(err);
  }
}
