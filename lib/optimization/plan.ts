/**
 * The client optimization plan (spec 151 B1): one prioritized, deduplicated,
 * approvable list composed from the existing finding engines. Composition
 * only — detection stays in lib/gaps, lib/citations, lib/discoverability and
 * lib/accuracy; task creation on approval is delegated to each engine's own
 * task path, so a finding becomes a task exactly one way.
 *
 * Regeneration is idempotent: an existing dedupe key refreshes its content
 * and source pointer but never its status, task or intervention.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, assertProjectAccess, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import {
  canMoveOpportunity,
  dedupeDrafts,
  fromAccuracyFinding,
  fromCitationOpportunity,
  fromGapFinding,
  fromSiteFinding,
  OPPORTUNITY_BUILDER_VERSION,
  OPPORTUNITY_STATUSES,
  type OpportunityDraft,
  type OpportunityStatus,
} from "@/lib/optimization/opportunities";

/** Citation-pipeline statuses that are exits — never planned work. */
const CITATION_EXITS = ["rejected", "not_eligible", "not_worth_pursuing", "spam_risk", "unable_to_contact", "lost"];

export async function collectDrafts(projectId: string): Promise<OpportunityDraft[]> {
  const [market] = await sql`
    select m.name from projects p left join markets m on m.id = p.market_id where p.id = ${projectId}
  `;
  const location = (market?.name as string | null) ?? null;

  // Gap findings: the latest analyzed run only (older runs' findings are history).
  const gaps = await sql`
    select f.id, f.gap_type, f.prompt_category, f.finding, f.detail,
      f.opportunity_score::float8 as opportunity_score, f.confidence::float8 as confidence, f.evidence_ids
    from gap_findings f
    where f.project_id = ${projectId} and f.status <> 'dismissed'
      and f.run_id = (select run_id from gap_findings where project_id = ${projectId} order by created_at desc limit 1)
  `;
  const citations = await sql`
    select id, domain, acvs::float8 as acvs, acquisition_path, acquisition_difficulty,
      estimated_cost_usd::float8 as estimated_cost_usd, next_action
    from citation_opportunities
    where project_id = ${projectId} and status <> all(${CITATION_EXITS})
  `;
  const site = await sql`
    select f.id, f.check_type, f.observation, f.recommendation, f.priority_score::float8 as priority_score,
      f.severity, p.url as page_url
    from site_findings f left join site_pages p on p.id = f.page_id
    where f.project_id = ${projectId} and f.status <> 'dismissed'
      and f.scan_id = (select id from site_scans where project_id = ${projectId} order by created_at desc limit 1)
  `;
  const accuracy = await sql`
    select id, kind, quote, rationale, severity, confidence::float8 as confidence, claim_id, response_id
    from accuracy_findings
    where project_id = ${projectId} and status in ('open', 'acknowledged')
  `;
  return dedupeDrafts([
    ...gaps.map((r) =>
      fromGapFinding(
        {
          id: r.id as string,
          gapType: r.gapType as string,
          promptCategory: (r.promptCategory as string | null) ?? null,
          finding: r.finding as string,
          detail: (r.detail as Record<string, unknown>) ?? {},
          opportunityScore: Number(r.opportunityScore),
          confidence: (r.confidence as number | null) ?? null,
          evidenceIds: (r.evidenceIds as string[] | null) ?? [],
        },
        location
      )
    ),
    ...citations.map((r) =>
      fromCitationOpportunity(
        {
          id: r.id as string,
          domain: r.domain as string,
          acvs: (r.acvs as number | null) ?? null,
          acquisitionPath: r.acquisitionPath as string,
          acquisitionDifficulty: r.acquisitionDifficulty as string,
          estimatedCostUsd: (r.estimatedCostUsd as number | null) ?? null,
          nextAction: (r.nextAction as string | null) ?? null,
        },
        location
      )
    ),
    ...site.map((r) =>
      fromSiteFinding(
        {
          id: r.id as string,
          checkType: r.checkType as string,
          observation: r.observation as string,
          recommendation: r.recommendation as string,
          priorityScore: Number(r.priorityScore),
          pageUrl: (r.pageUrl as string | null) ?? null,
          severity: r.severity as string,
        },
        location
      )
    ),
    ...accuracy.map((r) =>
      fromAccuracyFinding(
        {
          id: r.id as string,
          kind: r.kind as string,
          quote: r.quote as string,
          rationale: r.rationale as string,
          severity: r.severity as string,
          confidence: Number(r.confidence),
          claimId: (r.claimId as string | null) ?? null,
          responseId: r.responseId as string,
        },
        location
      )
    ),
  ]);
}

export async function buildOptimizationPlan(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ created: number; refreshed: number; unchanged: number; total: number }>> {
  const parsed = z.object({ projectId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const { projectId } = parsed.data;
  try {
    assertCanWrite(user);
    const drafts = await collectDrafts(projectId);
    let created = 0;
    let refreshed = 0;
    let unchanged = 0;
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${`opportunity-plan:${projectId}`}))`;
      for (const d of drafts) {
        const [row] = await tx`
          insert into opportunities (project_id, dedupe_key, source_kind, source_id, category, title,
            observed_problem, recommended_action, target_intent, target_location, affected_url, evidence,
            competitor_names, priority_score, priority_band, effort, estimated_cost_usd, confidence,
            limitations, approval_requirements, measurement_plan, builder_version)
          values (${projectId}, ${d.dedupeKey}, ${d.sourceKind}, ${d.sourceId}, ${d.category}, ${d.title},
            ${d.observedProblem}, ${d.recommendedAction}, ${d.targetIntent}, ${d.targetLocation}, ${d.affectedUrl},
            ${tx.json(d.evidence as never)}, ${d.competitorNames}, ${d.priorityScore}, ${d.priorityBand},
            ${d.effort}, ${d.estimatedCostUsd}, ${d.confidence}, ${d.limitations}, ${d.approvalRequirements},
            ${tx.json(d.measurementPlan as never)}, ${OPPORTUNITY_BUILDER_VERSION})
          on conflict (project_id, dedupe_key) do update set
            source_id = excluded.source_id,
            title = excluded.title,
            observed_problem = excluded.observed_problem,
            recommended_action = excluded.recommended_action,
            evidence = excluded.evidence,
            competitor_names = excluded.competitor_names,
            priority_score = excluded.priority_score,
            priority_band = excluded.priority_band,
            confidence = excluded.confidence,
            builder_version = excluded.builder_version,
            updated_at = now()
          -- Only unapproved items refresh: once a person approved (or
          -- dismissed) an opportunity, its content is what they decided on
          -- (review finding M7). New evidence for it surfaces as a new run's
          -- finding, never as a silent rewrite.
          where opportunities.status = 'proposed'
          returning id, (xmax = 0) as inserted
        `;
        if (!row) {
          unchanged += 1;
        } else if (row.inserted) {
          created += 1;
          await tx`
            insert into opportunity_events (opportunity_id, from_status, to_status, actor_id, note)
            values (${row.id}, null, 'proposed', ${user.id}, 'generated by the plan builder')
          `;
        } else {
          refreshed += 1;
        }
      }
      await writeAudit(tx, {
        userId: user.id,
        action: "optimization.plan_built",
        entity: "project",
        entityId: projectId,
        projectId,
        detail: { created, refreshed, unchanged, builderVersion: OPPORTUNITY_BUILDER_VERSION },
      });
    });
    return ok({ created, refreshed, unchanged, total: drafts.length });
  } catch (err) {
    return fail(err);
  }
}

export interface OpportunityRow {
  id: string;
  projectId: string;
  dedupeKey: string;
  sourceKind: string;
  sourceId: string;
  category: string;
  title: string;
  observedProblem: string;
  recommendedAction: string;
  targetIntent: string | null;
  targetLocation: string | null;
  affectedUrl: string | null;
  competitorNames: string[];
  priorityScore: number;
  priorityBand: string;
  effort: string;
  estimatedCostUsd: number | null;
  confidence: number | null;
  limitations: string;
  approvalRequirements: string[];
  measurementPlan: Record<string, unknown>;
  status: OpportunityStatus;
  taskId: string | null;
  interventionId: string | null;
  updatedAt: Date;
}

export async function listOpportunities(user: CurrentUser, projectId: string): Promise<OpportunityRow[]> {
  await assertProjectAccess(user, projectId);
  return sql<OpportunityRow[]>`
    select id, project_id, dedupe_key, source_kind, source_id, category, title, observed_problem,
      recommended_action, target_intent, target_location, affected_url, competitor_names,
      priority_score::float8 as priority_score, priority_band, effort,
      estimated_cost_usd::float8 as estimated_cost_usd, confidence::float8 as confidence, limitations,
      approval_requirements, measurement_plan, status, task_id, intervention_id, updated_at
    from opportunities where project_id = ${projectId}
    order by (status in ('closed', 'dismissed')), priority_score desc, dedupe_key
  `;
}

const transitionSchema = z.object({
  opportunityId: z.string().uuid(),
  to: z.enum(OPPORTUNITY_STATUSES),
  note: z.string().trim().max(1000).optional(),
  interventionId: z.string().uuid().optional(),
});

/** Move an opportunity through its lifecycle. Approval is a human act and
 * creates the work item through the source engine's own task path. */
export async function transitionOpportunity(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ status: OpportunityStatus; taskId: string | null }>> {
  const parsed = transitionSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const input = parsed.data;
  try {
    assertCanWrite(user);
    const [opp] = await sql`select * from opportunities where id = ${input.opportunityId}`;
    if (!opp) return fail(new ClassifiedError("not_found", "Opportunity not found."));
    const from = opp.status as OpportunityStatus;
    if (!canMoveOpportunity(from, input.to)) {
      return fail(new ClassifiedError("conflict", `Cannot move an opportunity from ${from} to ${input.to}.`));
    }
    if (input.to === "dismissed" && !input.note) {
      return fail(new ClassifiedError("validation", "Say why it is dismissed — dismissals are kept as evidence."));
    }
    if (input.to === "measuring" && !(input.interventionId ?? opp.interventionId)) {
      return fail(new ClassifiedError("validation", "Link the intervention that records what shipped before measuring."));
    }

    let taskId = (opp.taskId as string | null) ?? null;
    if (input.to === "approved" && !taskId) {
      taskId = await taskForSource(user, opp.sourceKind as string, opp.sourceId as string);
    }
    await sql.begin(async (tx) => {
      const updated = await tx`
        update opportunities set status = ${input.to}, task_id = ${taskId},
          intervention_id = coalesce(${input.interventionId ?? null}::uuid, intervention_id), updated_at = now()
        where id = ${input.opportunityId} and status = ${from}
        returning id
      `;
      if (updated.length === 0) throw new ClassifiedError("conflict", "The opportunity changed meanwhile; reload.");
      await tx`
        insert into opportunity_events (opportunity_id, from_status, to_status, actor_id, note)
        values (${input.opportunityId}, ${from}, ${input.to}, ${user.id}, ${input.note ?? null})
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: `optimization.opportunity_${input.to}`,
        entity: "opportunity",
        entityId: input.opportunityId,
        projectId: opp.projectId as string,
        detail: { from, to: input.to, taskId },
      });
    });
    return ok({ status: input.to, taskId });
  } catch (err) {
    return fail(err);
  }
}

/** Existing task on the source finding, or one created by its engine. */
async function taskForSource(user: CurrentUser, sourceKind: string, sourceId: string): Promise<string | null> {
  const table: Record<string, string> = {
    gap_finding: "gap_findings",
    site_finding: "site_findings",
    accuracy_finding: "accuracy_findings",
  };
  const name = table[sourceKind];
  if (!name) return null; // citation opportunities run their own pipeline
  const [row] = await sql`select task_id from ${sql(name)} where id = ${sourceId}`;
  if (row?.taskId) return row.taskId as string;
  const engine =
    sourceKind === "gap_finding"
      ? (await import("@/lib/gaps/service")).createTaskFromFinding
      : sourceKind === "site_finding"
        ? (await import("@/lib/discoverability/service")).createTaskFromSiteFinding
        : (await import("@/lib/accuracy/service")).createCorrectionTask;
  const result = await engine(user, { findingId: sourceId });
  if (!result.ok) throw new ClassifiedError(result.error.kind, `Could not create the task: ${result.error.message}`);
  return result.data.taskId;
}
