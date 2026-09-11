/**
 * Canonical entities (spec 020 Phase 2).
 *
 * `companies` covers tracked brands and competitors. Markets, neighbourhoods,
 * brokerages, people, specialties, publications and awards had nowhere to live,
 * which is why `claims.subject_entity` is free text today.
 *
 * Two rules shape this module:
 *
 *  - **Never copy a company.** An entity that *is* a tracked company carries
 *    `company_id` and points at the existing row. One registry, one truth.
 *  - **A merge is recorded, never destructive.** Merging sets the loser's
 *    status to `merged` and its `merged_into_id`; nothing is deleted, so a
 *    claim that referenced the old entity still resolves.
 */
import { z } from "zod";
import { sql, type TransactionSql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import { bestMatch, normalizeEntityName, slugify } from "@/lib/knowledge/normalize";

type Tx = TransactionSql | typeof sql;

export const ENTITY_TYPES = [
  "person",
  "organization",
  "brokerage",
  "team",
  "market",
  "neighborhood",
  "specialty",
  "publication",
  "award",
  "ranking",
  "property",
  "other",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export interface KnowledgeEntity {
  id: string;
  projectId: string | null;
  entityType: EntityType;
  canonicalName: string;
  slug: string;
  companyId: string | null;
  description: string;
  status: "active" | "merged" | "archived";
  mergedIntoId: string | null;
}

const COLUMNS = sql`id, project_id, entity_type, canonical_name, slug, company_id,
  description, status, merged_into_id`;

const upsertSchema = z.object({
  /** Null for a market or methodology shared by every client. */
  projectId: z.string().uuid().nullable().optional(),
  entityType: z.enum(ENTITY_TYPES),
  canonicalName: z.string().trim().min(1, "An entity needs a name.").max(200),
  companyId: z.string().uuid().optional(),
  description: z.string().max(1000).default(""),
  aliases: z.array(z.string().trim().min(1).max(200)).default([]),
});

export async function upsertEntity(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<KnowledgeEntity>> {
  const parsed = upsertSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  const projectId = input.projectId ?? null;
  const slug = slugify(input.canonicalName);

  try {
    assertCanWrite(user);
    const entity = await sql.begin(async (tx) => {
      if (input.companyId) {
        const [company] = await tx`
          select id from companies where id = ${input.companyId}
        `;
        if (!company) throw new ClassifiedError("not_found", "Company not found.");
      }
      const [row] = await tx<KnowledgeEntity[]>`
        insert into knowledge_entities (
          project_id, entity_type, canonical_name, slug, company_id, description, created_by
        ) values (
          ${projectId}, ${input.entityType}, ${input.canonicalName}, ${slug},
          ${input.companyId ?? null}, ${input.description}, ${user.id}
        )
        on conflict (coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid), entity_type, slug)
        do update set
          canonical_name = excluded.canonical_name,
          description = excluded.description,
          company_id = coalesce(excluded.company_id, knowledge_entities.company_id),
          updated_at = now()
        returning ${COLUMNS}
      `;
      if (!row) throw new ClassifiedError("internal", "Upsert returned no row.");

      // The canonical name is always an alias of itself, so lookups have one path.
      for (const alias of [input.canonicalName, ...input.aliases]) {
        await addAliasRow(tx, row.id, alias, null, 1);
      }
      await writeAudit(tx, {
        userId: user.id,
        action: "knowledge.entity.upsert",
        entity: "knowledge_entity",
        entityId: row.id,
        detail: { entityType: input.entityType, slug },
      });
      return row;
    });
    return ok(entity);
  } catch (err) {
    return fail(err);
  }
}

async function addAliasRow(
  tx: Tx,
  entityId: string,
  alias: string,
  sourceArtifactId: string | null,
  confidence: number
): Promise<void> {
  const normalized = normalizeEntityName(alias);
  if (normalized.length === 0) return;
  await tx`
    insert into entity_aliases (entity_id, alias, normalized_alias, source_artifact_id, confidence)
    values (${entityId}, ${alias}, ${normalized}, ${sourceArtifactId}, ${confidence})
    on conflict (entity_id, normalized_alias) do nothing
  `;
}

// ------------------------------------------------------------------- reading

export async function listEntities(
  projectId: string | null,
  options: { includeShared?: boolean; entityType?: EntityType } = {}
): Promise<KnowledgeEntity[]> {
  const includeShared = options.includeShared ?? true;
  return sql<KnowledgeEntity[]>`
    select ${COLUMNS} from knowledge_entities
    where status = 'active'
      and (
        project_id = ${projectId}
        ${includeShared ? sql`or project_id is null` : sql``}
      )
      ${options.entityType ? sql`and entity_type = ${options.entityType}` : sql``}
    order by entity_type asc, canonical_name asc
  `;
}

/**
 * Resolve a free-text name to an entity, scoped to one client plus the shared
 * pool. Returns the match status so a caller can refuse to act on ambiguity
 * rather than silently taking the top hit.
 */
export async function resolveEntityByName(args: {
  projectId: string | null;
  name: string;
  entityType?: EntityType;
}): Promise<{ entityId: string | null; matchStatus: string; confidence: number }> {
  const normalized = normalizeEntityName(args.name);
  if (normalized.length === 0) {
    return { entityId: null, matchStatus: "unmatched", confidence: 0 };
  }

  // An exact alias hit is the cheap, certain path.
  const [exact] = await sql`
    select e.id from entity_aliases a
    join knowledge_entities e on e.id = a.entity_id
    where a.normalized_alias = ${normalized}
      and e.status = 'active'
      and (e.project_id = ${args.projectId} or e.project_id is null)
      ${args.entityType ? sql`and e.entity_type = ${args.entityType}` : sql``}
    limit 1
  `;
  if (exact) return { entityId: exact.id as string, matchStatus: "exact", confidence: 1 };

  const candidates = await listEntities(args.projectId, { entityType: args.entityType });
  const { entityId, match } = bestMatch(
    args.name,
    candidates.map((c) => ({ id: c.id, name: c.canonicalName }))
  );
  return { entityId, matchStatus: match.matchStatus, confidence: match.matchConfidence };
}

/** Entities a page or packet depends on, following merges to the live node. */
// ----------------------------------------------------- relationships (056)

export const RELATIONSHIP_TYPES = ["works_for", "brokerage", "affiliated_with"] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

/** Bridge a company to its knowledge entity, creating a typed one if none
 * exists. Companies are what operators see; entities carry the graph. */
async function entityForCompany(
  user: CurrentUser,
  companyId: string,
  entityType: "team" | "brokerage" | "organization"
): Promise<string> {
  const [existing] = await sql`
    select id from knowledge_entities
    where company_id = ${companyId} and status = 'active'
    order by created_at asc limit 1
  `;
  if (existing) return existing.id as string;
  const [company] = await sql`
    select name from companies where id = ${companyId} and archived_at is null
  `;
  if (!company) throw new ClassifiedError("not_found", "Company not found.");
  const created = await upsertEntity(user, {
    entityType,
    canonicalName: company.name as string,
    companyId,
    description: "",
  });
  if (!created.ok) throw created.error;
  return created.data.id;
}

const proposeRelationshipSchema = z.object({
  projectId: z.string().uuid().nullable().optional(),
  /** The child (team/agent company). */
  fromCompanyId: z.string().uuid(),
  /** The parent (brokerage/organization company). */
  toCompanyId: z.string().uuid(),
  relationshipType: z.enum(RELATIONSHIP_TYPES),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  effectiveUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  note: z.string().trim().max(500).optional(),
});

/**
 * The write path the audit found missing (spec 056, §10 P0): the
 * effective-dated, evidence-bearing relationship schema existed with no
 * writer anywhere. Proposals are company-first — each side bridges to its
 * knowledge entity — and land `proposed`; a human approves (the model's
 * own design), and only approved relationships group.
 */
export async function proposeRelationship(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ relationshipId: string }>> {
  const parsed = proposeRelationshipSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    if (input.fromCompanyId === input.toCompanyId) {
      return fail(
        new ClassifiedError("validation", "A company cannot relate to itself.")
      );
    }
    const fromEntityId = await entityForCompany(user, input.fromCompanyId, "team");
    const toEntityId = await entityForCompany(
      user,
      input.toCompanyId,
      input.relationshipType === "brokerage" ? "brokerage" : "organization"
    );
    const relationshipId = await sql.begin(async (tx) => {
      const [duplicate] = await tx`
        select id from entity_relationships
        where from_entity_id = ${fromEntityId} and to_entity_id = ${toEntityId}
          and relationship_type = ${input.relationshipType}
          and status in ('proposed', 'approved')
          and effective_until is null
      `;
      if (duplicate) {
        throw new ClassifiedError(
          "conflict",
          "An open relationship of this type already exists between these two — end it before proposing a successor."
        );
      }
      const [row] = await tx`
        insert into entity_relationships
          (project_id, from_entity_id, to_entity_id, relationship_type,
           effective_from, effective_until, created_by)
        values
          (${input.projectId ?? null}, ${fromEntityId}, ${toEntityId},
           ${input.relationshipType}, ${input.effectiveFrom ?? null},
           ${input.effectiveUntil ?? null}, ${user.id})
        returning id
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "entity.relationship_proposed",
        entity: "entity_relationship",
        entityId: row?.id as string,
        detail: {
          fromCompanyId: input.fromCompanyId,
          toCompanyId: input.toCompanyId,
          relationshipType: input.relationshipType,
          note: input.note ?? null,
        },
      });
      return row?.id as string;
    });
    return ok({ relationshipId });
  } catch (err) {
    return fail(err);
  }
}

/** Human approval per the schema's own design. Rejection keeps history. */
export async function reviewRelationship(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ relationshipId: string; status: string }>> {
  const parsed = z
    .object({
      relationshipId: z.string().uuid(),
      decision: z.enum(["approved", "rejected"]),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const [row] = await tx`
        update entity_relationships
        set status = ${input.decision}, approved_by = ${user.id}
        where id = ${input.relationshipId} and status = 'proposed'
        returning id
      `;
      if (!row) {
        throw new ClassifiedError(
          "not_found",
          "Relationship not found or already decided."
        );
      }
      await writeAudit(tx, {
        userId: user.id,
        action: `entity.relationship_${input.decision}`,
        entity: "entity_relationship",
        entityId: input.relationshipId,
        detail: {},
      });
    });
    return ok({ relationshipId: input.relationshipId, status: input.decision });
  } catch (err) {
    return fail(err);
  }
}

/** A brokerage move is an end date plus a new proposal — never an edit. */
export async function endRelationship(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ relationshipId: string }>> {
  const parsed = z
    .object({
      relationshipId: z.string().uuid(),
      effectiveUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const [row] = await tx`
        update entity_relationships
        set effective_until = ${input.effectiveUntil}
        where id = ${input.relationshipId} and status = 'approved'
          and effective_until is null
        returning id
      `;
      if (!row) {
        throw new ClassifiedError(
          "not_found",
          "Relationship not found, not approved, or already ended."
        );
      }
      await writeAudit(tx, {
        userId: user.id,
        action: "entity.relationship_ended",
        entity: "entity_relationship",
        entityId: input.relationshipId,
        detail: { effectiveUntil: input.effectiveUntil },
      });
    });
    return ok({ relationshipId: input.relationshipId });
  } catch (err) {
    return fail(err);
  }
}

export interface RelationshipRow {
  id: string;
  fromCompanyId: string | null;
  fromName: string;
  toCompanyId: string | null;
  toName: string;
  relationshipType: string;
  status: string;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
}

/** Proposed + approved relationships whose endpoints this project can see. */
export async function listRelationshipsForProject(
  projectId: string
): Promise<RelationshipRow[]> {
  const rows = await sql`
    select r.id, r.relationship_type, r.status,
      r.effective_from::text, r.effective_until::text,
      fe.company_id as from_company_id, fe.canonical_name as from_name,
      te.company_id as to_company_id, te.canonical_name as to_name
    from entity_relationships r
    join knowledge_entities fe on fe.id = r.from_entity_id
    join knowledge_entities te on te.id = r.to_entity_id
    where r.status in ('proposed', 'approved')
      and (r.project_id is null or r.project_id = ${projectId})
    order by r.created_at desc
    limit 100
  `;
  return rows.map((r) => ({
    id: r.id as string,
    fromCompanyId: (r.fromCompanyId as string | null) ?? null,
    fromName: r.fromName as string,
    toCompanyId: (r.toCompanyId as string | null) ?? null,
    toName: r.toName as string,
    relationshipType: r.relationshipType as string,
    status: r.status as string,
    effectiveFrom: (r.effectiveFrom as string | null) ?? null,
    effectiveUntil: (r.effectiveUntil as string | null) ?? null,
  }));
}
