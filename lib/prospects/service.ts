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
import { detectConflicts, type AgreementInput, type MarketNode } from "@/lib/exclusivity/detect";
import { listAgreements } from "@/lib/exclusivity/service";
import { createProject } from "@/lib/projects/service";
import { upsertCompany } from "@/lib/companies/service";
import { addCompetitor } from "@/lib/competitors/service";
import { setSubjectCompany } from "@/lib/claims/service";
import {
  ALL_PROSPECT_STAGES,
  ASSESSMENT_ITEMS,
  ASSESSMENT_VALUES,
  AUDIT_TOKEN_BYTES,
  AUTHORITY_SIGNAL_KINDS,
  CONTACT_CHANNELS,
  FRESHNESS_WINDOWS_DAYS,
  staleness,
  FINDING_GENERATOR_VERSION,
  LAUNCH_STATUSES,
  OUTREACH_CHANNELS,
  PROSPECT_SOURCES,
  PROSPECT_TYPES,
  PROVENANCE_LABELS,
  RECORDING_STATUSES,
  RELATIONSHIP_STRENGTHS,
  findProhibitedPhrase,
  type ConflictStatus,
  type ProspectStage,
  type ProspectType,
} from "@/lib/prospects/constants";
import { validateTransition } from "@/lib/prospects/stages";
import {
  generateFindingCandidates,
  type BenchmarkEntityMetrics,
} from "@/lib/prospects/findings";
import {
  absenceEvidence,
  promptEvidenceForResponses,
  prospectAbsentResponses,
  runSummary,
  scoredEntities,
  type PromptEvidence,
  type RunSummary,
} from "@/lib/prospects/benchmark";
import { generateReplyFirstEmail } from "@/lib/prospects/outreach";
import { generateRecordingPlan as buildRecordingPlan } from "@/lib/prospects/recording";
import { parseProspectImport, type ImportRow } from "@/lib/prospects/import";
import { checkSuppression } from "@/lib/outreach/suppression";
import { authorityGapForRun } from "@/lib/prospects/gap";
import {
  getEmailChannel,
  hasOptOutMention,
  optOutFooter,
} from "@/lib/prospects/channels";
import {
  computeProspectScoreView,
  PROSPECT_SCORE_VERSION,
} from "@/lib/prospects/final-score";
import { diagnoseProspect } from "@/lib/prospects/diagnose";

/** Diagnoses a prospect may read about themselves — retitled for them.
 * Research-gap keys (about OUR evidence base) and internal-QA keys never
 * ship on an audit page. */
const PROSPECT_FACING_DIAGNOSES: Record<string, string> = {
  no_organic_visibility: "AI doesn't surface you yet",
  missing_from_high_intent_prompts: "Missing exactly where buyers decide",
  mentioned_never_recommended: "Known, but not recommended",
  missing_from_cited_sources: "You're not in the sources AI reads",
  competitors_dominate_sources: "Competitors control the sources AI reads",
};

/** Competitors surfaced in findings — enough contrast, no dossier. */
const MAX_COMPARED_COMPETITORS = 5;
/** Rivals on the prospect-facing audit comparison — the visible market. */
const AUDIT_COMPARISON_RIVALS = 7;
const PROMPT_EVIDENCE_LIMIT = 4;
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
  /** Global evidence (nationwide volume, brand rankings) is shown for
   * context but excluded from the local-authority score (spec 038). */
  scope: z.enum(["local", "global"]).default("local"),
  retrievedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  confidence: z.number().min(0).max(1).optional(),
  notes: z.string().trim().max(2000).optional(),
});

// ---------------------------------------------------------------------------
// Shared helpers

async function logActivity(
  tx: TransactionSql,
  prospectId: string,
  kind: string,
  detail: Record<string, unknown>,
  actorId: string | null
): Promise<void> {
  await tx`
    insert into prospect_activities (prospect_id, kind, detail, actor_id)
    values (${prospectId}, ${kind}, ${tx.json(detail as never)}, ${actorId})
  `;
}

interface ProspectRow {
  id: string;
  launchId: string;
  businessName: string;
  companyId: string | null;
  teamLeader: string | null;
  stage: ProspectStage;
  conflictStatus: ConflictStatus;
  doNotContact: boolean;
  email: string | null;
  phone: string | null;
  archivedAt: Date | null;
}

async function lockProspect(tx: TransactionSql, prospectId: string): Promise<ProspectRow> {
  const rows = await tx`
    select id, launch_id, business_name, company_id, team_leader, stage,
      conflict_status, do_not_contact, email, phone, archived_at
    from prospects where id = ${prospectId} for update
  `;
  const row = rows[0] as ProspectRow | undefined;
  if (!row || row.archivedAt) {
    throw new ClassifiedError("not_found", "Prospect not found.");
  }
  return row;
}

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
      p.qualification_score, p.qualification_override
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
           provenance, scope, retrieved_at, confidence, notes, created_by)
        values (${input.prospectId}, ${input.kind}, ${input.label},
          ${input.valueNumber ?? null}, ${input.valueText ?? null},
          ${input.sourceUrl ?? null}, ${input.provenance}, ${input.scope},
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
        p.benchmark_project_id, p.archived_at, m.name as market_name
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

    // Resolve the canonical company: linked > existing by name > created.
    let companyId = prospect.companyId as string | null;
    if (!companyId) {
      const [existing] = await sql`
        select id from companies
        where lower(name) = lower(${prospect.businessName}) and archived_at is null
      `;
      if (existing) {
        companyId = existing.id as string;
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
  const run = await runSummary(benchmark.runId);
  if (!run) throw new ClassifiedError("not_found", "Run not found.");
  const entities = await scoredEntities(benchmark.runId);
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

interface PrimaryFindingRow {
  id: string;
  prospectId: string;
  benchmarkId: string;
  title: string;
  explanation: string;
  metrics: Record<string, unknown>;
  responseIds: string[];
  competitorCompanyIds: string[];
}

async function getPrimaryFinding(
  tx: TransactionSql,
  prospectId: string
): Promise<PrimaryFindingRow> {
  const rows = await tx`
    select id, prospect_id, benchmark_id, title, explanation, metrics,
      response_ids, competitor_company_ids
    from prospect_findings
    where prospect_id = ${prospectId} and is_primary and status = 'approved'
  `;
  const row = rows[0] as unknown as PrimaryFindingRow | undefined;
  if (!row) {
    throw new ClassifiedError(
      "validation",
      "No primary approved finding — review and approve one first."
    );
  }
  return row;
}

// ---------------------------------------------------------------------------
// Prospect audit pages

export interface AuditSnapshot {
  headline: string;
  prospectName: string;
  marketName: string;
  benchmark: {
    dateRange: { from: string; to: string | null };
    providers: string[];
    promptCount: number;
    responseCount: number;
    limitations: string;
  };
  keyFinding: {
    title: string;
    explanation: string;
    metrics: Record<string, unknown>;
  };
  comparison: {
    name: string;
    isProspect: boolean;
    mentionRate: number | null;
    recommendationRate: number | null;
    sampleSize: number;
    /** Sourced market rank (ranking signal with a numeric value, same
     * launch); null for entities with no ranked record — never guessed. */
    marketRank?: number | null;
  }[];
  /** Brand-level names (brokerages, out-of-market brands) that filled the
   * answers — kept out of the team table, summarized beneath it. The
   * first-mover argument: no individual team owns the answers yet. */
  brandMentions?: {
    name: string;
    mentionRate: number | null;
    recommendationRate: number | null;
  }[];
  promptEvidence: PromptEvidence[];
  methodology: string;
  cta: string;
  /** THE PROOF (spec 045): every captured answer, complete and verbatim, so
   * the reader can search for their own name and find nothing — an absence
   * can only be proven by publishing everything. Rendered on the appendix
   * page (/audit/[token]/answers). */
  transcripts?: {
    prompt: string;
    provider: string;
    model: string;
    capturedAt: string;
    answer: string;
  }[];
  /** Short verbatim moments where an assistant recommended a rival —
   * the machine in its own words, stamped. */
  evidenceExcerpts?: {
    quote: string;
    teamName: string;
    model: string;
    capturedAt: string;
  }[];
  /** Who stands behind the report. */
  preparedBy?: {
    name: string;
    date: string;
    reportId: string;
    /** Reply-to for the one-click CTA (spec 045 CRO pass). */
    email?: string;
  };
  /** Live consumer-app share links (spec 045): operator-created exhibits on
   * the assistant vendor's own domain. Demos, never measurements. */
  exampleChats?: {
    url: string;
    assistant: string;
    question: string;
    capturedOn: string;
  }[];
  /** What invisibility means in the prospect's own numbers — measured
   * recommendation moments plus arithmetic on THEIR cited volume/sides.
   * Never a fabricated loss claim (PROHIBITED_PHRASES discipline). */
  stakes?: {
    /** Specific-team recommendations assistants made across the answers. */
    recommendationMomentsTotal: number;
    /** How many of those were the prospect. */
    yourRecommendations: number;
    /** Who got named instead, most-recommended first. */
    competitorsNamed: string[];
    /** volume ÷ sides from their own sourced signals; null when unknown. */
    avgDealUsd: number | null;
    /** The cited numbers the average is computed from. */
    avgDealBasis: string | null;
  };
  /** Prospect-facing "why this is happening" (spec 042 diagnoses, whitelist
   * only — internal research-gap diagnoses never ship to a prospect). */
  whyItHappens?: { title: string; explanation: string; suggestedAction: string }[];
  /** The domains the AI answers actually cited — where visibility is won. */
  topSources?: { domain: string; citations: number }[];
  /** Spec 038 — present only when both sides were measurable at publish
   * time. Additive: audits published before the field render unchanged. */
  authorityGap?: {
    authorityVersion: string;
    visibilityVersion: string;
    authorityScore: number;
    visibilityScore: number;
    gap: number;
    confidence: number | null;
    components: { label: string; points: number; maxPoints: number }[];
    organicResponses: number;
    /** Counted evidence statements only — provenance-labeled, source-linked. */
    signals: { label: string; provenance: string; sourceUrl: string | null }[];
  };
}

const METHODOLOGY_TEXT =
  "Prompts were selected to represent realistic buyer and seller questions for this market and " +
  "run repeatedly against the listed AI engines. Responses were captured verbatim and parsed for " +
  "which businesses each engine mentioned or recommended. Rates are the share of captured " +
  "responses in which a business appeared. AI responses are probabilistic: individual answers " +
  "vary, which is why sample sizes are shown and why no single response is treated as a result.";

const LIMITATIONS_TEXT =
  "Rates reflect the monitored prompt set and engines during the benchmark window only. They " +
  "are observations of AI assistant behaviour, not measurements of revenue, lead flow, or " +
  "market share.";

export async function publishAudit(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ auditId: string; accessToken: string }>> {
  const parsed = z
    .object({
      prospectId: z.string().uuid(),
      expiresAt: z.string().datetime().optional(),
      /** A stale benchmark (spec 042 freshness windows) publishes only with
       * this explicit acknowledgment, which is recorded in the audit log. */
      acknowledgeStale: z.boolean().optional(),
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
      const [existing] = await tx`
        select id from prospect_audits
        where prospect_id = ${input.prospectId} and status = 'published'
      `;
      if (existing) {
        throw new ClassifiedError(
          "conflict",
          "A published audit already exists for this prospect — revoke it before publishing a new one."
        );
      }
      const finding = await getPrimaryFinding(tx, input.prospectId);
      const [benchmark] = await tx`
        select id, run_id, company_id from prospect_benchmarks
        where id = ${finding.benchmarkId}
      `;
      if (!benchmark) throw new ClassifiedError("not_found", "Benchmark not found.");

      const run = await runSummary(benchmark.runId as string);
      if (!run) throw new ClassifiedError("not_found", "Run not found.");
      const benchmarkAge = staleness(run.startedAt, FRESHNESS_WINDOWS_DAYS.benchmark);
      if (benchmarkAge.stale && !input.acknowledgeStale) {
        throw new ClassifiedError(
          "validation",
          `The benchmark run is ${benchmarkAge.ageDays} days old — past the ${FRESHNESS_WINDOWS_DAYS.benchmark}-day freshness window. Re-run the benchmark, or publish anyway with an explicit acknowledgment.`
        );
      }
      const entities = await scoredEntities(benchmark.runId as string);
      const prospectMetrics = entities.find((e) => e.companyId === benchmark.companyId);
      // The comparison shows who actually shows up in the run — top rivals
      // by visibility, not just the ones the approved finding referenced.
      // When the linked run belongs to a CLIENT project, the client's own
      // brand is excluded: it must never appear on a prospect-facing page.
      const [runProject] = await tx`
        select p.kind, p.subject_company_id from projects p
        join runs r on r.project_id = p.id
        where r.id = ${benchmark.runId}
      `;
      const excludedCompanyId =
        runProject?.kind === "client" &&
        runProject?.subjectCompanyId !== benchmark.companyId
          ? (runProject?.subjectCompanyId as string | null)
          : null;
      // Teams vs brands, decided by DATA: a company is a "team" when it maps
      // to a non-brokerage prospect in this launch. Teams go in the table
      // (apples to apples); brands are summarized beneath it.
      const launchTypeRows = await tx`
        select company_id, prospect_type from prospects
        where launch_id = ${prospect.launchId}
          and company_id is not null and archived_at is null
      `;
      const teamCompanyIds = new Set(
        launchTypeRows
          .filter((r) => r.prospectType !== "brokerage")
          .map((r) => r.companyId as string)
      );
      const visibleRivals = entities
        .filter((e) => e.companyId !== benchmark.companyId)
        .filter((e) => e.companyId !== excludedCompanyId)
        .filter((e) => (e.mentionRate ?? 0) > 0 || (e.recommendationRate ?? 0) > 0)
        .sort(
          (a, b) =>
            (b.recommendationRate ?? 0) - (a.recommendationRate ?? 0) ||
            (b.mentionRate ?? 0) - (a.mentionRate ?? 0)
        );
      const rivals = visibleRivals
        .filter((e) => teamCompanyIds.has(e.companyId))
        .slice(0, AUDIT_COMPARISON_RIVALS);
      const brandMentions = visibleRivals
        .filter((e) => !teamCompanyIds.has(e.companyId))
        .slice(0, 5)
        .map((e) => ({
          name: e.name,
          mentionRate: e.mentionRate,
          recommendationRate: e.recommendationRate,
        }));
      const evidence = await promptEvidenceForResponses(
        finding.responseIds,
        PROMPT_EVIDENCE_LIMIT
      );

      const [launchRow] = await tx`
        select m.name as market_name from market_launches l
        join markets m on m.id = l.market_id
        where l.id = ${prospect.launchId}
      `;

      // Authority vs valuable visibility (spec 038) — included only when
      // both sides are measurable; a one-sided "gap" would be a fabrication.
      const gapView = await authorityGapForRun(
        input.prospectId,
        benchmark.runId as string,
        benchmark.companyId as string
      );
      const countedIds = new Set(gapView.authority.components.flatMap((c) => c.signalIds));
      const authorityGap =
        gapView.gap !== null && gapView.visibility !== null
          ? {
              authorityVersion: gapView.authority.version,
              visibilityVersion: gapView.visibility.version,
              authorityScore: gapView.authority.score as number,
              visibilityScore: gapView.visibility.score as number,
              gap: gapView.gap,
              confidence: gapView.authority.confidence,
              components: gapView.authority.components.map((c) => ({
                label: c.label,
                points: c.points,
                maxPoints: c.maxPoints,
              })),
              organicResponses: gapView.visibility.organicResponses,
              signals: gapView.signals
                .filter((s) => countedIds.has(s.id))
                .map((s) => ({
                  label: s.label,
                  provenance: s.provenance,
                  sourceUrl: s.sourceUrl,
                })),
            }
          : undefined;

      // Prospect-facing "why" — whitelist only; internal research-gap and
      // QA diagnoses never ship to a prospect.
      const diagnosisReport = await diagnoseProspect(input.prospectId);
      const whyItHappens = diagnosisReport.diagnoses
        .filter((d) => d.key in PROSPECT_FACING_DIAGNOSES)
        .slice(0, 3)
        .map((d) => ({
          title: PROSPECT_FACING_DIAGNOSES[d.key]!,
          explanation: d.explanation,
          suggestedAction: d.suggestedAction,
        }));
      // Sourced market ranks for every company in this launch (ranking
      // signals with a numeric value, most recent per prospect) — lets the
      // comparison show "#9 in the market → 0% in the answers" per row.
      const rankRows = await tx`
        select distinct on (p.company_id) p.company_id, s.value_number
        from prospects p
        join prospect_authority_signals s on s.prospect_id = p.id
          and s.kind = 'ranking' and s.value_number is not null
        where p.launch_id = ${prospect.launchId}
          and p.company_id is not null and p.archived_at is null
        order by p.company_id, s.created_at desc
      `;
      const rankByCompany = new Map<string, number>(
        rankRows.map((r) => [r.companyId as string, Number(r.valueNumber)])
      );

      // Stakes: every "recommended" mention is a real moment an assistant
      // pointed a buyer at a specific team — counted, not estimated. Echo is
      // excluded per company (the organic rule): a recommendation on a
      // question that NAMED that team measures our question, not the market.
      const recRows = await sql`
        select m.company_id, c.name, count(*)::int as recs
        from mentions m
        join companies c on c.id = m.company_id
        join responses r on r.id = m.response_id
        where r.run_id = ${benchmark.runId} and r.error is null and m.recommended
          and not exists (
            select 1 from mentions newer
            where newer.response_id = m.response_id
              and newer.company_id = m.company_id and newer.revision > m.revision
          )
          and not exists (
            select 1 from unnest(c.aliases || array[c.name]) as t
            where trim(t) != '' and r.prompt_text ilike '%' || trim(t) || '%'
          )
        group by m.company_id, c.name
        order by recs desc
      `;
      const recommendationMomentsTotal = recRows.reduce((a, r) => a + Number(r.recs), 0);
      const yourRecommendations = Number(
        recRows.find((r) => r.companyId === benchmark.companyId)?.recs ?? 0
      );
      const competitorsNamed = recRows
        .filter((r) => r.companyId !== benchmark.companyId)
        .slice(0, 5)
        .map((r) => r.name as string);
      // Average sale = arithmetic on THEIR cited numbers, never an estimate.
      const [dealBasis] = await sql`
        select
          (select value_number from prospect_authority_signals
            where prospect_id = ${input.prospectId} and kind = 'transaction_volume'
              and value_number is not null order by created_at desc limit 1) as volume,
          (select value_number from prospect_authority_signals
            where prospect_id = ${input.prospectId} and kind = 'transaction_count'
              and value_number is not null order by created_at desc limit 1) as sides
      `;
      const volume = dealBasis?.volume === null ? null : Number(dealBasis?.volume);
      const sides = dealBasis?.sides === null ? null : Number(dealBasis?.sides);
      const avgDealUsd =
        volume !== null && sides !== null && sides > 0 ? Math.round(volume / sides) : null;
      const stakes = {
        recommendationMomentsTotal,
        yourRecommendations,
        competitorsNamed,
        avgDealUsd,
        avgDealBasis:
          avgDealUsd !== null
            ? `$${(volume! / 1_000_000).toFixed(2)}M across ${sides} sides, per the sourced record above`
            : null,
      };

      // THE PROOF: every valid answer, complete and verbatim. An absence can
      // only be proven by publishing everything — a reader can search these
      // for their own name. Capped defensively; the cap is stated on the page.
      const TRANSCRIPT_CAP = 60;
      const transcriptRows = await tx`
        select prompt_text, provider, model, requested_at, response_text
        from responses
        where run_id = ${benchmark.runId} and error is null
          and response_text is not null
        order by prompt_text, provider, repetition
        limit ${TRANSCRIPT_CAP}
      `;
      const transcripts = transcriptRows.map((r) => ({
        prompt: r.promptText as string,
        provider: r.provider as string,
        model: r.model as string,
        capturedAt: (r.requestedAt as Date).toISOString(),
        answer: r.responseText as string,
      }));

      // Short verbatim moments: an assistant recommending a rival, in its
      // own words. Organic only (echo exclusion), one per rival, top 3.
      const excerptRows = await tx`
        select distinct on (m.company_id)
          m.excerpt, c.name, r.model, r.requested_at
        from mentions m
        join companies c on c.id = m.company_id
        join responses r on r.id = m.response_id
        where r.run_id = ${benchmark.runId} and r.error is null
          and m.recommended and m.excerpt is not null
          and m.company_id != ${benchmark.companyId}
          and not exists (
            select 1 from mentions newer
            where newer.response_id = m.response_id
              and newer.company_id = m.company_id and newer.revision > m.revision
          )
          and not exists (
            select 1 from unnest(c.aliases || array[c.name]) as t
            where trim(t) != '' and r.prompt_text ilike '%' || trim(t) || '%'
          )
        order by m.company_id, r.requested_at asc
      `;
      const evidenceExcerpts = excerptRows.slice(0, 3).map((r) => ({
        quote: r.excerpt as string,
        teamName: r.name as string,
        model: r.model as string,
        capturedAt: (r.requestedAt as Date).toISOString(),
      }));

      const preparedBy = {
        name: user.name,
        email: user.email,
        date: new Date().toISOString().slice(0, 10),
        reportId: randomBytes(4).toString("hex"),
      };

      // Live exhibits: allowlisted consumer-app share links (spec 045).
      const exhibitRows = await tx`
        select url, assistant, question, captured_on::text as captured_on
        from prospect_exhibits
        where prospect_id = ${input.prospectId} and archived_at is null
        order by captured_on desc, created_at desc
        limit 5
      `;
      const exampleChats = exhibitRows.map((r) => ({
        url: r.url as string,
        assistant: r.assistant as string,
        question: r.question as string,
        capturedOn: r.capturedOn as string,
      }));

      const sourceRows = await sql`
        select c.domain, count(*)::int as citations
        from response_citations c
        join responses r on r.id = c.response_id
        where r.run_id = ${benchmark.runId}
        group by c.domain
        order by citations desc
        limit 5
      `;
      const topSources = sourceRows.map((s) => ({
        domain: s.domain as string,
        citations: Number(s.citations),
      }));

      const marketName = (launchRow?.marketName as string) ?? "the monitored market";
      const headline =
        authorityGap && authorityGap.gap >= 20
          ? `${prospect.businessName} is one of ${marketName}'s strongest teams — and AI assistants almost never say so.`
          : `Your real-world market position appears stronger than your AI market position.`;

      // The snapshot IS the page. Internal fields (notes, scores, owners,
      // rationales) are structurally absent, not filtered at render time.
      const snapshot: AuditSnapshot = {
        headline,
        prospectName: prospect.businessName,
        marketName,
        benchmark: {
          dateRange: {
            from: run.startedAt.toISOString(),
            to: run.completedAt?.toISOString() ?? null,
          },
          providers: run.providers,
          promptCount: run.promptCount,
          responseCount: run.responseCount,
          limitations: LIMITATIONS_TEXT,
        },
        keyFinding: {
          title: finding.title,
          explanation: finding.explanation,
          metrics: finding.metrics,
        },
        comparison: [
          ...(prospectMetrics
            ? [
                {
                  name: prospect.businessName,
                  isProspect: true,
                  mentionRate: prospectMetrics.mentionRate,
                  recommendationRate: prospectMetrics.recommendationRate,
                  sampleSize: prospectMetrics.sampleSize,
                  marketRank: rankByCompany.get(benchmark.companyId as string) ?? null,
                },
              ]
            : []),
          ...rivals.map((r) => ({
            name: r.name,
            isProspect: false,
            mentionRate: r.mentionRate,
            recommendationRate: r.recommendationRate,
            sampleSize: r.sampleSize,
            marketRank: rankByCompany.get(r.companyId) ?? null,
          })),
        ],
        promptEvidence: evidence,
        methodology: METHODOLOGY_TEXT,
        cta: "Review the full benchmark with us.",
        ...(authorityGap ? { authorityGap } : {}),
        ...(brandMentions.length > 0 ? { brandMentions } : {}),
        ...(recommendationMomentsTotal > 0 ? { stakes } : {}),
        ...(whyItHappens.length > 0 ? { whyItHappens } : {}),
        ...(topSources.length > 0 ? { topSources } : {}),
        ...(transcripts.length > 0 ? { transcripts } : {}),
        ...(evidenceExcerpts.length > 0 ? { evidenceExcerpts } : {}),
        ...(exampleChats.length > 0 ? { exampleChats } : {}),
        preparedBy,
      };

      const accessToken = randomBytes(AUDIT_TOKEN_BYTES).toString("base64url");
      const [row] = await tx`
        insert into prospect_audits
          (prospect_id, finding_id, headline, snapshot, status, access_token,
           expires_at, published_by, published_at, created_by)
        values (${input.prospectId}, ${finding.id}, ${snapshot.headline},
          ${tx.json(snapshot as never)}, 'published', ${accessToken},
          ${input.expiresAt ?? null}, ${user.id}, now(), ${user.id})
        returning id
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.audit_publish",
        entity: "prospect_audit",
        entityId: row?.id as string,
        detail: {
          prospectId: input.prospectId,
          findingId: finding.id,
          ...(benchmarkAge.stale
            ? { staleBenchmarkAcknowledged: true, benchmarkAgeDays: benchmarkAge.ageDays }
            : {}),
        },
      });
      await logActivity(
        tx,
        input.prospectId,
        "audit_published",
        { auditId: row?.id },
        user.id
      );
      return { auditId: row?.id as string, accessToken };
    });
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}

export async function revokeAudit(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ auditId: string }>> {
  const parsed = z
    .object({ auditId: z.string().uuid(), reason: z.string().trim().min(1).max(1000) })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "A revocation needs a reason."));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const [row] = await tx`
        update prospect_audits set
          status = 'revoked', revoked_by = ${user.id}, revoked_at = now(),
          revoke_reason = ${input.reason}
        where id = ${input.auditId} and status = 'published'
        returning id, prospect_id
      `;
      if (!row) {
        throw new ClassifiedError("conflict", "Audit not found or not published.");
      }
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.audit_revoke",
        entity: "prospect_audit",
        entityId: input.auditId,
        detail: { reason: input.reason },
      });
      await logActivity(
        tx,
        row.prospectId as string,
        "audit_revoked",
        { auditId: input.auditId },
        user.id
      );
    });
    return ok({ auditId: input.auditId });
  } catch (err) {
    return fail(err);
  }
}

/**
 * Public token resolution — the ONLY unauthenticated read in this module.
 * Published ∧ unrevoked ∧ unexpired, else null; the page 404s so wrong
 * tokens, revoked tokens, and nonexistent tokens are indistinguishable.
 * Every hit is recorded (insert-only) and surfaces on the timeline.
 */
export async function getAuditByToken(
  token: string,
  meta: { ip?: string | null; userAgent?: string | null } = {}
): Promise<AuditSnapshot | null> {
  if (!token || token.length < 20 || token.length > 100) return null;
  const rows = await sql`
    select id, prospect_id, snapshot from prospect_audits
    where access_token = ${token} and status = 'published'
      and (expires_at is null or expires_at > now())
  `;
  const row = rows[0];
  if (!row) return null;
  await sql.begin(async (tx) => {
    await tx`
      insert into prospect_audit_views (audit_id, ip, user_agent, is_internal)
      values (${row.id}, ${meta.ip ?? null}, ${meta.userAgent ?? null}, false)
    `;
    await logActivity(tx, row.prospectId as string, "audit_viewed", { auditId: row.id }, null);
  });
  return row.snapshot as AuditSnapshot;
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
        const [launchRow] = await tx`
          select m.name as market_name from market_launches l
          join markets m on m.id = l.market_id where l.id = ${prospect.launchId}
        `;
        const generated = generateReplyFirstEmail({
          prospectName: prospect.businessName,
          teamLeader: prospect.teamLeader,
          marketName: (launchRow?.marketName as string) ?? "the market",
          findingTitle: finding.title,
          findingExplanation: finding.explanation,
          providers: run?.providers ?? [],
          sampleSize: run?.responseCount ?? 0,
        });
        subject = generated.subject;
        body = generated.body;
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
      await tx`
        update outreach_drafts set status = 'superseded'
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

export const SEND_GATE_VERSION = "prospect-send-gate-v1";

/**
 * The bridge between the two outreach stacks (spec 043): every dispatch —
 * and every gate refusal — leaves an insert-only ledger row with the full
 * check list and the sha256 of the exact text. First touch stays human:
 * this runs behind a human click, never a scheduler (DECISIONS.md,
 * spec-011 reconciliation).
 *
 * Dispatch happens inside the transaction because both current channels
 * ('manual', 'mock') are in-process and instant. A future network channel
 * restructures this into claim → dispatch → finalize.
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

      let body = (draft.body as string) ?? "";
      if (channel.transmits) {
        check(
          "recipient_email",
          Boolean(email),
          email ? `recipient ${email}` : "A transmitting channel needs a recipient email."
        );
        if (!hasOptOutMention(body)) body += optOutFooter(user.name);
        check(
          "opt_out_path",
          hasOptOutMention(body),
          "opt-out instruction present in the outgoing text"
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

      const bodyHash = createHash("sha256")
        .update(`${(draft.subject as string) ?? ""}\n${body}`)
        .digest("hex");
      const allowed = failed === null;

      const writeLedger = async (providerMessageId: string | null): Promise<string> => {
        const [row] = await tx`
          insert into prospect_outreach_sends
            (draft_id, prospect_id, channel, recipient_email, body_hash,
             business_purpose, gate_verdict, allowed, provider_message_id, sent_by)
          values (${draft.id}, ${draft.prospectId}, ${channel.id}, ${email ?? null},
            ${bodyHash}, ${input.businessPurpose},
            ${tx.json({ version: SEND_GATE_VERSION, checks } as never)},
            ${allowed}, ${providerMessageId}, ${user.id})
          returning id
        `;
        return row?.id as string;
      };

      // Refusals are evidence too — ledgered and audited, which is why this
      // RETURNS instead of throwing: a throw would roll the ledger row back.
      if (!allowed) {
        const refusalId = await writeLedger(null);
        await writeAudit(tx, {
          userId: user.id,
          action: "prospect.send_refused",
          entity: "prospect_outreach_send",
          entityId: refusalId,
          detail: { draftId: draft.id, channel: channel.id, reason: failed },
        });
        return { refused: failed ?? "gate check failed" };
      }

      // Dispatch before the ledger row so the insert-only row carries the
      // provider message id (both current channels are in-process; a
      // network channel restructures this into claim → dispatch → finalize).
      const dispatched = await channel.dispatch({
        recipientEmail: email,
        subject: (draft.subject as string) ?? null,
        body,
      });
      const sendId = await writeLedger(dispatched.providerMessageId);

      await tx`
        update outreach_drafts set sent_recorded_at = now(), sent_recorded_by = ${user.id}
        where id = ${draft.id}
      `;
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
      const [launchRow] = await tx`
        select m.name as market_name from market_launches l
        join markets m on m.id = l.market_id where l.id = ${prospect.launchId}
      `;
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
        marketName: (launchRow?.marketName as string) ?? "the market",
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
        const markets = await tx<MarketNode[]>`select id, name, parent_id from markets`;
        const agreements: AgreementInput[] = (await listAgreements()).map((a) => ({
          agreementId: a.id,
          projectId: a.projectId,
          clientName: a.clientName,
          status: a.status as "active" | "terminated",
          startsOn: a.startsOn,
          endsOn: a.endsOn,
          gracePeriodDays: Number(a.gracePeriodDays),
          terminatedAt: a.terminatedAt,
          scopes: a.scopes.map((s) => ({
            scopeId: s.id,
            marketId: s.marketId,
            serviceCategory: s.serviceCategory,
            segment: s.segment,
          })),
        }));
        const today = new Date().toISOString().slice(0, 10);
        const detection = detectConflicts(
          {
            marketId: launch.marketId as string,
            serviceCategory: (launch.serviceCategory as string) ?? null,
            segment: (launch.priceSegment as string) ?? null,
          },
          agreements,
          markets,
          today
        );

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
