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

export async function addAlias(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ entityId: string; alias: string }>> {
  const parsed = z
    .object({
      entityId: z.string().uuid(),
      alias: z.string().trim().min(1).max(200),
      sourceArtifactId: z.string().uuid().optional(),
      confidence: z.number().min(0).max(1).default(1),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const [entity] = await tx`
        select id from knowledge_entities where id = ${input.entityId} and status = 'active'
      `;
      if (!entity) throw new ClassifiedError("not_found", "Entity not found or not active.");
      await addAliasRow(
        tx,
        input.entityId,
        input.alias,
        input.sourceArtifactId ?? null,
        input.confidence
      );
      await writeAudit(tx, {
        userId: user.id,
        action: "knowledge.entity.alias",
        entity: "knowledge_entity",
        entityId: input.entityId,
        detail: { alias: input.alias },
      });
    });
    return ok({ entityId: input.entityId, alias: input.alias });
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

/**
 * Merge `sourceId` into `targetId`. Aliases move across; the source is marked
 * `merged` and keeps pointing at the target, so any claim that referenced it
 * still resolves. Nothing is deleted.
 */
export async function mergeEntities(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ targetId: string; movedAliases: number }>> {
  const parsed = z
    .object({
      sourceId: z.string().uuid(),
      targetId: z.string().uuid(),
      reason: z.string().trim().min(1, "A merge needs a reason.").max(500),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const { sourceId, targetId, reason } = parsed.data;
  if (sourceId === targetId) {
    return fail(new ClassifiedError("validation", "An entity cannot be merged into itself."));
  }

  try {
    assertCanWrite(user);
    const result = await sql.begin(async (tx) => {
      const rows = await tx`
        select id, project_id, entity_type, status from knowledge_entities
        where id in (${sourceId}, ${targetId}) for update
      `;
      const source = rows.find((r) => r.id === sourceId);
      const target = rows.find((r) => r.id === targetId);
      if (!source || !target) throw new ClassifiedError("not_found", "Entity not found.");
      if (source.status !== "active") {
        throw new ClassifiedError("conflict", `Source entity is ${source.status}.`);
      }
      // A cross-client merge would fuse two clients' knowledge into one node.
      if (source.projectId !== target.projectId) {
        throw new ClassifiedError(
          "forbidden",
          "Entities belonging to different clients cannot be merged."
        );
      }
      if (source.entityType !== target.entityType) {
        throw new ClassifiedError(
          "conflict",
          "Entities of different types cannot be merged; correct the type first."
        );
      }

      const moved = await tx`
        insert into entity_aliases (entity_id, alias, normalized_alias, source_artifact_id, confidence)
        select ${targetId}, alias, normalized_alias, source_artifact_id, confidence
        from entity_aliases where entity_id = ${sourceId}
        on conflict (entity_id, normalized_alias) do nothing
        returning id
      `;
      await tx`
        update knowledge_entities
        set status = 'merged', merged_into_id = ${targetId}, updated_at = now()
        where id = ${sourceId}
      `;
      // Claims and normalizations follow the entity so nothing dangles.
      await tx`
        update claims set subject_entity_id = ${targetId} where subject_entity_id = ${sourceId}
      `;
      await tx`
        update source_normalizations set normalized_entity_id = ${targetId}
        where normalized_entity_id = ${sourceId}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "knowledge.entity.merge",
        entity: "knowledge_entity",
        entityId: targetId,
        detail: { sourceId, reason, movedAliases: moved.length },
      });
      return { targetId, movedAliases: moved.length };
    });
    return ok(result);
  } catch (err) {
    return fail(err);
  }
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

export async function getEntity(entityId: string): Promise<KnowledgeEntity | null> {
  const [row] = await sql<KnowledgeEntity[]>`
    select ${COLUMNS} from knowledge_entities where id = ${entityId}
  `;
  return row ?? null;
}

export async function entityAliases(entityId: string): Promise<
  { alias: string; confidence: number; sourceArtifactId: string | null }[]
> {
  const rows = await sql`
    select alias, confidence, source_artifact_id from entity_aliases
    where entity_id = ${entityId} order by confidence desc, alias asc
  `;
  return rows.map((row) => ({
    alias: row.alias as string,
    confidence: Number(row.confidence),
    sourceArtifactId: (row.sourceArtifactId as string | null) ?? null,
  }));
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
export async function resolveMerged(entityId: string): Promise<string> {
  let current = entityId;
  // Bounded: a merge chain longer than this is a data problem, not a loop.
  for (let hops = 0; hops < 10; hops += 1) {
    const [row] = await sql`
      select merged_into_id from knowledge_entities where id = ${current}
    `;
    const next = (row?.mergedIntoId as string | null) ?? null;
    if (!next) return current;
    current = next;
  }
  return current;
}
