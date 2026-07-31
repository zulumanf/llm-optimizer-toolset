/**
 * Stale marking (spec 024).
 *
 * A canonical change does not rebuild anything inline. It marks the pages that
 * *depend* on the changed object and enqueues a build. Two reasons:
 *
 *  - Marking is one set-based UPDATE against `wiki_page_dependencies`. Compiling
 *    is many queries and possibly an agent call. Doing the cheap thing on the
 *    write path keeps claim approval fast.
 *  - It makes "what would this change rebuild?" answerable *before* the build
 *    runs, which is what the dependency panel in the UI shows.
 *
 * The rule: **never mark every page.** A change with no dependents marks
 * nothing, and that is the correct outcome, not a bug.
 */
import { sql, type TransactionSql } from "@/db/client";
import { publishEvent } from "@/lib/events/bus";
import { enqueueJob } from "@/db/jobs";
import { log } from "@/lib/logger";
import type { DependencyType } from "@/lib/knowledge/compiler/types";

type Tx = TransactionSql | typeof sql;

export interface StaleTarget {
  type: DependencyType;
  id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mark every page depending on any of `targets`. Returns the affected slugs so
 * a caller can log or assert exactly what a change touched.
 */
export async function markPagesStale(
  tx: Tx,
  args: {
    projectId: string | null;
    targets: StaleTarget[];
    reason: string;
  }
): Promise<{ pageIds: string[]; slugs: string[] }> {
  // `dependency_id` is a uuid column, so a malformed id can never match a row.
  // Filtering here rather than letting Postgres reject the cast matters: a
  // failed statement aborts the CALLER's transaction, which would turn "an
  // event carried an odd id" into "the claim approval rolled back".
  const targets = args.targets.filter((t) => UUID_RE.test(t.id));
  if (targets.length === 0) return { pageIds: [], slugs: [] };

  const types = targets.map((t) => t.type);
  const ids = targets.map((t) => t.id);

  const rows = await tx`
    update wiki_pages p
    set stale = true,
      stale_reason = ${args.reason},
      stale_since = coalesce(p.stale_since, now()),
      updated_at = now()
    where p.id in (
      select d.page_id from wiki_page_dependencies d
      join unnest(${types}::text[], ${ids}::uuid[]) as t(dep_type, dep_id)
        on d.dependency_type = t.dep_type and d.dependency_id = t.dep_id
    )
    and coalesce(p.project_id, '00000000-0000-0000-0000-000000000000'::uuid)
      = coalesce(${args.projectId}, '00000000-0000-0000-0000-000000000000'::uuid)
    returning p.id, p.slug
  `;

  for (const row of rows) {
    await publishEvent(tx, {
      type: "wiki.page_marked_stale",
      projectId: args.projectId,
      payload: {
        pageId: row.id as string,
        slug: row.slug as string,
        reason: args.reason,
      },
    });
  }

  return {
    pageIds: rows.map((row) => row.id as string),
    slugs: rows.map((row) => row.slug as string),
  };
}

/**
 * Hot files summarise the rest of the wiki, so a stale ordinary page makes them
 * stale too. Kept separate from `markPagesStale` because it is a *transitive*
 * rule rather than a declared dependency, and conflating the two would hide it.
 */
export async function markDependentHotFilesStale(
  tx: Tx,
  args: { projectId: string; reason: string }
): Promise<string[]> {
  const rows = await tx`
    update wiki_pages
    set stale = true, stale_reason = ${args.reason},
      stale_since = coalesce(stale_since, now()), updated_at = now()
    where project_id = ${args.projectId} and page_type = 'hot_file' and not stale
    returning slug
  `;
  return rows.map((row) => row.slug as string);
}

/**
 * The event → dependency mapping. Every entry names the dependency type a
 * payload resolves to; an event with no entry marks nothing, deliberately.
 */
export function targetsForEvent(
  type: string,
  payload: Record<string, unknown>
): StaleTarget[] {
  const claimId = payload.claimId as string | undefined;
  const sourceId = payload.sourceArtifactId as string | undefined;
  const instructionId = payload.instructionId as string | undefined;
  const transactionId = payload.transactionId as string | undefined;
  const assetId = payload.assetId as string | undefined;

  switch (type) {
    case "claim.approved":
    case "claim.superseded":
    case "claim.expired":
    case "claim.conflict_detected":
    case "claim.conflict_resolved":
      return claimId ? [{ type: "claim", id: claimId }] : [];
    case "source.ingested":
    case "source.superseded":
      return sourceId ? [{ type: "source_artifact", id: sourceId }] : [];
    case "instruction.updated":
    case "instruction.expired":
      return instructionId ? [{ type: "instruction", id: instructionId }] : [];
    case "transaction.verified":
    case "transaction.created":
      return transactionId ? [{ type: "transaction", id: transactionId }] : [];
    case "content.published":
      return assetId ? [{ type: "action", id: assetId }] : [];
    default:
      return [];
  }
}

/**
 * Handle a knowledge-relevant domain event: mark, then enqueue.
 *
 * The enqueue is deliberately coarse — one job per client per event — because
 * the build planner is idempotent. A duplicate job compiles nothing the first
 * one already brought current, which is cheaper than deduplicating here.
 */
export async function onKnowledgeEvent(
  tx: Tx,
  args: {
    type: string;
    projectId: string | null;
    payload: Record<string, unknown>;
  }
): Promise<{ marked: string[] }> {
  const targets = targetsForEvent(args.type, args.payload).filter((t) => UUID_RE.test(t.id));
  if (targets.length === 0) return { marked: [] };

  const { slugs } = await markPagesStale(tx, {
    projectId: args.projectId,
    targets,
    reason: `${args.type}`,
  });

  // Contradiction and freshness events change the risk picture, which every
  // hot file reports even when it does not cite the specific claim.
  const touchesRisk =
    args.type.startsWith("claim.") || args.type === "source.ingested";
  const hotFiles =
    touchesRisk && args.projectId
      ? await markDependentHotFilesStale(tx, {
          projectId: args.projectId,
          reason: args.type,
        })
      : [];

  const marked = [...new Set([...slugs, ...hotFiles])];
  if (marked.length > 0) {
    await enqueueJob(tx, "knowledge_build", {
      projectId: args.projectId,
      trigger: "event",
      triggerRef: args.type,
    });
    log("info", "knowledge.stale.marked", {
      event: args.type,
      projectId: args.projectId,
      pages: marked.length,
    });
  }
  return { marked };
}

/** Pages currently stale for a client, for the UI and the build planner. */
export async function stalePages(projectId: string | null): Promise<
  { pageId: string; slug: string; reason: string; since: string | null }[]
> {
  const rows = await sql`
    select id, slug, stale_reason, stale_since from wiki_pages
    where stale
      and coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid)
        = coalesce(${projectId}, '00000000-0000-0000-0000-000000000000'::uuid)
    order by stale_since asc nulls last
  `;
  return rows.map((row) => ({
    pageId: row.id as string,
    slug: row.slug as string,
    reason: (row.staleReason as string) ?? "",
    since: row.staleSince ? String(row.staleSince) : null,
  }));
}
