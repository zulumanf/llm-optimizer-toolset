/**
 * Prospect acquisition service (spec 032). Staff-only throughout — client
 * roles are denied by assertCanWrite on writes and never reach the reads
 * (the /prospects segment is staff-gated and nothing here is imported by
 * portal code). All writes are transactional with audit rows; the prospect
 * timeline (`prospect_activities`) is written alongside.
 *
 * Nothing in this module sends anything or calls an AI provider.
 */
import { randomBytes } from "node:crypto";
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
  AUDIT_TOKEN_BYTES,
  AUTHORITY_SIGNAL_KINDS,
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

/** Competitors surfaced in findings/audits — enough contrast, no dossier. */
const MAX_COMPARED_COMPETITORS = 5;
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
  archivedAt: Date | null;
}

async function lockProspect(tx: TransactionSql, prospectId: string): Promise<ProspectRow> {
  const rows = await tx`
    select id, launch_id, business_name, company_id, team_leader, stage,
      conflict_status, do_not_contact, archived_at
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
}

export async function listProspects(
  options: { launchId?: string; limit?: number; offset?: number } = {}
): Promise<ProspectListRow[]> {
  const limit = Math.min(options.limit ?? DEFAULT_PAGE_SIZE, 200);
  const offset = options.offset ?? 0;
  return sql<ProspectListRow[]>`
    select p.id, p.business_name, p.launch_id, l.name as launch_name,
      p.prospect_type, p.stage, p.conflict_status, p.do_not_contact,
      u.name as owner_name, p.next_action, p.next_action_on::text
    from prospects p
    join market_launches l on l.id = p.launch_id
    left join users u on u.id = p.owner_id
    where p.archived_at is null
      and (${options.launchId ?? null}::uuid is null or p.launch_id = ${options.launchId ?? null})
    order by p.created_at desc
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
           provenance, confidence, notes, created_by)
        values (${input.prospectId}, ${input.kind}, ${input.label},
          ${input.valueNumber ?? null}, ${input.valueText ?? null},
          ${input.sourceUrl ?? null}, ${input.provenance},
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
  }[];
  promptEvidence: PromptEvidence[];
  methodology: string;
  cta: string;
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
      const entities = await scoredEntities(benchmark.runId as string);
      const prospectMetrics = entities.find((e) => e.companyId === benchmark.companyId);
      const rivals = entities
        .filter((e) => finding.competitorCompanyIds.includes(e.companyId))
        .slice(0, MAX_COMPARED_COMPETITORS);
      const evidence = await promptEvidenceForResponses(
        finding.responseIds,
        PROMPT_EVIDENCE_LIMIT
      );

      const [launchRow] = await tx`
        select m.name as market_name from market_launches l
        join markets m on m.id = l.market_id
        where l.id = ${prospect.launchId}
      `;

      // The snapshot IS the page. Internal fields (notes, scores, owners,
      // rationales) are structurally absent, not filtered at render time.
      const snapshot: AuditSnapshot = {
        headline: `Your real-world market position appears stronger than your AI market position.`,
        prospectName: prospect.businessName,
        marketName: (launchRow?.marketName as string) ?? "the monitored market",
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
                },
              ]
            : []),
          ...rivals.map((r) => ({
            name: r.name,
            isProspect: false,
            mentionRate: r.mentionRate,
            recommendationRate: r.recommendationRate,
            sampleSize: r.sampleSize,
          })),
        ],
        promptEvidence: evidence,
        methodology: METHODOLOGY_TEXT,
        cta: "Review the full benchmark with us.",
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
        detail: { prospectId: input.prospectId, findingId: finding.id },
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
          (prospect_id, finding_id, channel, version, parent_id, subject, body,
           tone, cta, generated_by, prompt_version, created_by)
        values (${input.prospectId}, ${finding.id}, ${input.channel}, ${version},
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
        select d.id, d.prospect_id, d.channel, d.body, d.subject, d.status
        from outreach_drafts d where d.id = ${parsed.data.draftId} for update
      `;
      if (!draft) throw new ClassifiedError("not_found", "Draft not found.");
      if (draft.status !== "draft") {
        throw new ClassifiedError("conflict", `Draft is already ${draft.status}.`);
      }
      const prospect = await lockProspect(tx, draft.prospectId as string);
      if (prospect.doNotContact) {
        throw new ClassifiedError(
          "validation",
          "This prospect is flagged do-not-contact — outreach cannot be approved."
        );
      }
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
        select id, prospect_id, channel, status, sent_recorded_at
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
      if (prospect.doNotContact) {
        throw new ClassifiedError(
          "validation",
          "This prospect is flagged do-not-contact — a send cannot be recorded."
        );
      }
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
