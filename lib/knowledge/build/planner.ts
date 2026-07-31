/**
 * The incremental build engine (spec 024).
 *
 * Behaves like an incremental software build: a changed claim rebuilds the
 * pages that depend on it and nothing else, an unchanged output produces no new
 * version, and a crash mid-build cannot leave two active versions of a page.
 *
 * Three properties are load-bearing:
 *
 *  - **Set-based staleness.** A canonical change resolves to a page set in one
 *    query against `wiki_page_dependencies`. The whole wiki is never rebuilt
 *    for one source change.
 *  - **Hash no-op detection.** Lives in `compilePage`. The planner only counts
 *    the outcome; a build that is mostly no-ops means something is marking too
 *    much stale, which is why `no_op` is a reported metric rather than hidden.
 *  - **Partial is not completed.** One page failing does not stop the others,
 *    and the build's status becomes `partial`. An undisclosed partial result is
 *    the failure mode this codebase refuses everywhere else.
 */
import { createHash } from "node:crypto";
import { sql } from "@/db/client";
import { publishEvent } from "@/lib/events/bus";
import { log } from "@/lib/logger";
import { BUILD_CONCURRENCY } from "@/lib/knowledge/constants";
import { compilePage, ensurePage, type CompiledPageResult } from "@/lib/knowledge/compiler/compile";
import { loadCompileContext } from "@/lib/knowledge/compiler/context";
import {
  ALL_PAGE_TEMPLATES,
  CLIENT_PAGE_TEMPLATES,
  SHARED_PAGE_TEMPLATES,
  getPageTemplate,
} from "@/lib/knowledge/compiler/templates";
import type { PageTemplate } from "@/lib/knowledge/compiler/types";

export type BuildTrigger = "event" | "manual" | "maintenance" | "initial";

export interface BuildItemOutcome {
  pageId: string;
  slug: string;
  status: "compiled" | "no_op" | "failed" | "skipped";
  reason: string;
  previousVersionId: string | null;
  newVersionId: string | null;
  contentHash: string | null;
  tokenCount: number;
  durationMs: number;
  error: string | null;
}

export interface KnowledgeBuild {
  buildId: string;
  projectId: string | null;
  status: "completed" | "partial" | "failed";
  requested: number;
  compiled: number;
  noOp: number;
  failed: number;
  durationMs: number;
  items: BuildItemOutcome[];
  manifestHash: string;
  warnings: string[];
}

export interface CompileAffectedInput {
  projectId: string | null;
  /** Restrict to these page slugs; omit to build everything stale. */
  slugs?: string[];
  trigger?: BuildTrigger;
  triggerRef?: string | null;
  /** Build every page regardless of staleness (a first build, or a version bump). */
  force?: boolean;
  createdBy?: string | null;
  now?: Date;
}

/**
 * Build the stale set for one client. This is the entry point for the event
 * path, the manual path and the initial path alike — one planner, not three.
 */
export async function compileAffected(input: CompileAffectedInput): Promise<KnowledgeBuild> {
  const started = Date.now();
  const trigger = input.trigger ?? "manual";
  const templates = await resolveTemplates(input);

  const [buildRow] = await sql`
    insert into knowledge_builds (
      project_id, trigger, trigger_ref, status, requested_pages, created_by
    ) values (
      ${input.projectId}, ${trigger}, ${input.triggerRef ?? null}, 'running',
      ${templates.length}, ${input.createdBy ?? null}
    )
    returning id
  `;
  const buildId = buildRow!.id as string;

  await sql.begin((tx) =>
    publishEvent(tx, {
      type: "wiki.page_build_started",
      projectId: input.projectId,
      payload: { buildId, pages: templates.length, compiled: 0, noOp: 0, failed: 0 },
    })
  );

  const items: BuildItemOutcome[] = [];
  const warnings: string[] = [];

  try {
    if (templates.length > 0) {
      // One snapshot for the whole build: two pages compiled together cannot
      // disagree, and the queries run once instead of once per page.
      const context = await loadCompileContext({
        projectId: input.projectId,
        now: input.now,
      });

      for (const batch of chunk(templates, BUILD_CONCURRENCY)) {
        const results = await Promise.all(
          batch.map(async (template): Promise<BuildItemOutcome> => {
            const pageStarted = Date.now();
            try {
              const result = await compilePage({ template, context, buildId });
              if (result.budgetWarning) warnings.push(result.budgetWarning);
              return toOutcome(result, Date.now() - pageStarted);
            } catch (err) {
              // One page's failure does not stop the build. The page stays
              // stale, so the next build retries it.
              const message = (err as Error).message;
              log("error", "knowledge.build.page_failed", {
                buildId,
                slug: template.slug,
                error: message,
              });
              const pageId = await sql.begin((tx) =>
                ensurePage(tx, template, input.projectId)
              );
              return {
                pageId,
                slug: template.slug,
                status: "failed",
                reason: "compilation threw",
                previousVersionId: null,
                newVersionId: null,
                contentHash: null,
                tokenCount: 0,
                durationMs: Date.now() - pageStarted,
                error: message,
              };
            }
          })
        );
        items.push(...results);
      }
    }
  } catch (err) {
    // A failure outside a page — loading the context, for instance — fails the
    // whole build rather than reporting a misleading partial success.
    const message = (err as Error).message;
    await sql`
      update knowledge_builds
      set status = 'failed', error = ${message}, finished_at = now(),
        duration_ms = ${Date.now() - started}
      where id = ${buildId}
    `;
    await sql.begin((tx) =>
      publishEvent(tx, {
        type: "wiki.page_build_failed",
        projectId: input.projectId,
        payload: { buildId, pages: templates.length, compiled: 0, noOp: 0, failed: 0, error: message },
      })
    );
    throw err;
  }

  const compiled = items.filter((i) => i.status === "compiled").length;
  const noOp = items.filter((i) => i.status === "no_op").length;
  const failed = items.filter((i) => i.status === "failed").length;
  const status = failed > 0 ? "partial" : "completed";
  const durationMs = Date.now() - started;

  const manifest = {
    buildId,
    projectId: input.projectId,
    trigger,
    compilerRun: items.map((i) => ({
      slug: i.slug,
      status: i.status,
      previousVersionId: i.previousVersionId,
      newVersionId: i.newVersionId,
      contentHash: i.contentHash,
      tokenCount: i.tokenCount,
    })),
    warnings,
  };
  const manifestHash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");

  await sql.begin(async (tx) => {
    for (const item of items) {
      await tx`
        insert into knowledge_build_items (
          build_id, page_id, status, reason, previous_version_id, new_version_id,
          content_hash, token_count, duration_ms, error
        ) values (
          ${buildId}, ${item.pageId}, ${item.status}, ${item.reason},
          ${item.previousVersionId}, ${item.newVersionId}, ${item.contentHash},
          ${item.tokenCount}, ${item.durationMs}, ${item.error}
        )
        on conflict (build_id, page_id) do nothing
      `;
    }
    await tx`
      insert into knowledge_build_manifests (build_id, manifest, manifest_hash)
      values (${buildId}, ${tx.json(manifest as never)}, ${manifestHash})
      on conflict (build_id) do nothing
    `;
    await tx`
      update knowledge_builds
      set status = ${status}, compiled = ${compiled}, no_op = ${noOp},
        failed = ${failed}, duration_ms = ${durationMs}, finished_at = now()
      where id = ${buildId}
    `;
    await publishEvent(tx, {
      type: "wiki.page_build_completed",
      projectId: input.projectId,
      payload: { buildId, pages: items.length, compiled, noOp, failed },
    });
  });

  log("info", "knowledge.build.finished", {
    buildId,
    projectId: input.projectId,
    status,
    compiled,
    noOp,
    failed,
    durationMs,
  });

  return {
    buildId,
    projectId: input.projectId,
    status,
    requested: templates.length,
    compiled,
    noOp,
    failed,
    durationMs,
    items,
    manifestHash,
    warnings,
  };
}

function toOutcome(result: CompiledPageResult, durationMs: number): BuildItemOutcome {
  return {
    pageId: result.pageId,
    slug: result.slug,
    status: result.status,
    reason:
      result.status === "no_op"
        ? "output unchanged"
        : `version ${result.version}`,
    previousVersionId: result.previousVersionId,
    newVersionId: result.status === "compiled" ? result.versionId : null,
    contentHash: result.contentHash,
    tokenCount: result.tokenCount,
    durationMs,
    error: null,
  };
}

/**
 * Which templates this build should run. Explicit slugs win; otherwise the
 * stale set, expanded so a hot file summarising a stale page is stale too.
 */
async function resolveTemplates(input: CompileAffectedInput): Promise<PageTemplate[]> {
  const pool = input.projectId === null ? SHARED_PAGE_TEMPLATES : CLIENT_PAGE_TEMPLATES;

  if (input.slugs?.length) {
    const chosen = input.slugs
      .map((slug) => getPageTemplate(slug))
      .filter((t): t is PageTemplate => t !== undefined);
    return orderTemplates(chosen);
  }
  if (input.force) return orderTemplates(pool);

  const rows = await sql`
    select slug from wiki_pages
    where stale
      and coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid)
        = coalesce(${input.projectId}, '00000000-0000-0000-0000-000000000000'::uuid)
  `;
  const staleSlugs = new Set(rows.map((row) => row.slug as string));

  // A page that has never been compiled has no row yet, so it is stale by
  // definition. Without this, a new client's first build would compile nothing.
  const known = new Set(
    (
      await sql`
        select slug from wiki_pages
        where coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = coalesce(${input.projectId}, '00000000-0000-0000-0000-000000000000'::uuid)
      `
    ).map((row) => row.slug as string)
  );
  for (const template of pool) {
    if (!known.has(template.slug)) staleSlugs.add(template.slug);
  }

  // Hot files summarise the other pages, so any stale page makes them stale.
  if ([...staleSlugs].some((slug) => getPageTemplate(slug)?.pageType !== "hot_file")) {
    for (const template of pool) {
      if (template.pageType === "hot_file") staleSlugs.add(template.slug);
    }
  }

  return orderTemplates(pool.filter((t) => staleSlugs.has(t.slug)));
}

/**
 * Topological order: ordinary pages before hot files, since a hot file
 * summarises them. The registry already lists them that way; this enforces it
 * regardless of the order a caller passed slugs in.
 */
function orderTemplates(templates: PageTemplate[]): PageTemplate[] {
  const rank = (t: PageTemplate) => (t.pageType === "hot_file" ? 1 : 0);
  const position = new Map(ALL_PAGE_TEMPLATES.map((t, index) => [t.slug, index]));
  return [...templates].sort(
    (a, b) => rank(a) - rank(b) || (position.get(a.slug) ?? 0) - (position.get(b.slug) ?? 0)
  );
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Dependencies a page declared, for the UI's dependency panel. */
export async function getDependencies(
  pageId: string
): Promise<{ type: string; id: string }[]> {
  const rows = await sql`
    select dependency_type, dependency_id from wiki_page_dependencies
    where page_id = ${pageId}
    order by dependency_type asc
  `;
  return rows.map((row) => ({
    type: row.dependencyType as string,
    id: row.dependencyId as string,
  }));
}
