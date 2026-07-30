/**
 * Program plan composition (spec 026).
 *
 * The plan is COMPOSED from ranked findings, never generated. An LLM asked for
 * a 90-day plan produces something fluent, plausible and untraceable — the
 * exact failure this repository exists to prevent. So every item here points
 * at the finding that selected it and the evidence behind it, and the same
 * inputs always produce the same plan.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import {
  PLAN_COMPOSER_VERSION,
  relevantPlays,
  type ClientState,
  type Phase,
} from "@/lib/plans/plays";

const PHASE_ORDER: Phase[] = ["foundation", "authority", "compounding"];

export interface PlanItem {
  phase: Phase;
  position: number;
  playKey: string;
  title: string;
  rationale: string;
  sourceFindingId: string | null;
  evidenceIds: string[];
  effortHours: number;
  owner: string;
  measurement: string;
  status: "planned" | "excluded";
  exclusionReason: string | null;
}

export interface ComposedPlan {
  id: string;
  projectId: string;
  title: string;
  status: string;
  baseline: Record<string, unknown>;
  compositionHash: string;
  items: PlanItem[];
  supersededId: string | null;
}

/** Gather the real client state the plays interrogate. */
async function loadClientState(
  projectId: string,
  baselineRunId: string | null
): Promise<ClientState> {
  const claimRows = await sql`
    select key from claims where project_id = ${projectId} and status = 'approved'
  `;
  const entityRows = await sql`
    select entity_type, count(*)::int as n from knowledge_entities
    where project_id = ${projectId} group by entity_type
  `;

  // Citation counts come from the run's gap findings, which already extracted
  // them — recomputing here would be a second implementation that can drift.
  const [sourceTarget] = await sql`
    select detail from gap_findings
    where project_id = ${projectId} and gap_type = 'source_target'
      ${baselineRunId ? sql`and run_id = ${baselineRunId}` : sql``}
    order by created_at desc limit 1
  `;
  const targets =
    ((sourceTarget?.detail as { targets?: { domain: string; citations: number }[] })?.targets ??
      []) as { domain: string; citations: number }[];

  const [citation] = await sql`
    select detail from gap_findings
    where project_id = ${projectId} and gap_type = 'citation'
      ${baselineRunId ? sql`and run_id = ${baselineRunId}` : sql``}
    order by created_at desc limit 1
  `;
  const ownCited = Number((citation?.detail as { ownCitations?: number })?.ownCitations ?? 0) > 0;

  const [entity] = await sql`
    select detail from gap_findings
    where project_id = ${projectId} and gap_type = 'entity'
      ${baselineRunId ? sql`and run_id = ${baselineRunId}` : sql``}
    order by created_at desc limit 1
  `;
  const entityDetail = (entity?.detail ?? {}) as {
    unbrandedMentionRate?: number;
    topCompetitor?: string;
    topCompetitorMentionRate?: number;
  };

  return {
    citedDomains: targets,
    // A citation finding only exists when nothing owned was cited; its absence
    // alongside real citations means the owned domain WAS cited.
    ownDomainCited: ownCited || (targets.length > 0 && !citation),
    approvedClaimKeys: claimRows.map((r) => r.key as string),
    entityCounts: Object.fromEntries(
      entityRows.map((r) => [r.entityType as string, Number(r.n)])
    ),
    organicMentionRate: entityDetail.unbrandedMentionRate ?? null,
    topCompetitorName: entityDetail.topCompetitor ?? null,
    topCompetitorRate: entityDetail.topCompetitorMentionRate ?? null,
  };
}

const composeSchema = z.object({
  projectId: z.string().uuid(),
  /** Restrict composition to one run's findings; omit for the latest per type. */
  baselineRunId: z.string().uuid().optional(),
  horizonDays: z.number().int().min(30).max(365).default(90),
  title: z.string().trim().min(1).max(160).optional(),
});

/**
 * Compose a plan. Supersedes any existing draft/approved plan for the client —
 * two live plans are two answers to the same question.
 */
export async function composePlan(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<ComposedPlan>> {
  const parsed = composeSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;

  try {
    assertCanWrite(user);

    const findings = await sql`
      select id, gap_type, finding, opportunity_score, run_id
      from gap_findings
      where project_id = ${input.projectId} and status = 'open'
        ${input.baselineRunId ? sql`and run_id = ${input.baselineRunId}` : sql``}
      order by opportunity_score desc
    `;
    if (findings.length === 0) {
      // No findings ⇒ no plan. An empty plan is ceremony, and ceremony in a
      // client deliverable is worse than an honest "we have nothing yet".
      throw new ClassifiedError(
        "conflict",
        "No open gap findings for this client — run and analyse a measurement first."
      );
    }

    const runId =
      input.baselineRunId ?? ((findings[0]!.runId as string | null) ?? null);
    const state = await loadClientState(input.projectId, runId);

    const gapTypes = new Set(findings.map((f) => f.gapType as string));
    const bestFindingFor = new Map<string, { id: string; score: number }>();
    for (const f of findings) {
      const existing = bestFindingFor.get(f.gapType as string);
      const score = Number(f.opportunityScore ?? 0);
      if (!existing || score > existing.score) {
        bestFindingFor.set(f.gapType as string, { id: f.id as string, score });
      }
    }

    const plays = relevantPlays(gapTypes);
    const items: PlanItem[] = [];
    for (const play of plays) {
      const blocked = play.requires?.(state) ?? null;
      // The source finding is the highest-scoring one this play answers, so an
      // item's position follows the evidence rather than the template order.
      const source = play.gapTypes
        .map((t) => bestFindingFor.get(t))
        .filter((x): x is { id: string; score: number } => Boolean(x))
        .sort((a, b) => b.score - a.score)[0];

      items.push({
        phase: play.phase,
        position: 0,
        playKey: play.key,
        title: play.title,
        rationale: play.rationale(state),
        sourceFindingId: source?.id ?? null,
        evidenceIds: [],
        effortHours: play.effortHours,
        owner: play.owner,
        measurement: play.measurement,
        status: blocked ? "excluded" : "planned",
        exclusionReason: blocked,
      });
    }

    // Rank within each phase by the opportunity score of the finding that
    // selected the play; excluded items sort last so the plan reads as work.
    for (const phase of PHASE_ORDER) {
      const inPhase = items.filter((i) => i.phase === phase);
      inPhase.sort((a, b) => {
        if (a.status !== b.status) return a.status === "planned" ? -1 : 1;
        const aScore = a.sourceFindingId
          ? [...bestFindingFor.values()].find((v) => v.id === a.sourceFindingId)?.score ?? 0
          : 0;
        const bScore = b.sourceFindingId
          ? [...bestFindingFor.values()].find((v) => v.id === b.sourceFindingId)?.score ?? 0
          : 0;
        return bScore - aScore;
      });
      inPhase.forEach((item, index) => {
        item.position = index + 1;
      });
    }

    const baseline = {
      runId,
      organicMentionRate: state.organicMentionRate,
      topCompetitor: state.topCompetitorName,
      topCompetitorRate: state.topCompetitorRate,
      citedDomains: state.citedDomains.slice(0, 10),
      ownDomainCited: state.ownDomainCited,
      approvedClaims: state.approvedClaimKeys.length,
      findingCount: findings.length,
      composedAt: new Date().toISOString().slice(0, 10),
    };

    // Hash covers findings + plays + preconditions, NOT the timestamp: an
    // unchanged picture must hash the same so a pointless re-compose is visible.
    const compositionHash = createHash("sha256")
      .update(
        JSON.stringify({
          findings: findings.map((f) => [f.id, f.gapType, f.opportunityScore]),
          items: items.map((i) => [i.playKey, i.phase, i.position, i.status, i.exclusionReason]),
          composer: PLAN_COMPOSER_VERSION,
        })
      )
      .digest("hex");

    const plan = await sql.begin(async (tx) => {
      const [previous] = await tx`
        update program_plans set status = 'superseded', superseded_at = now()
        where project_id = ${input.projectId} and status in ('draft', 'approved', 'active')
        returning id
      `;

      const [row] = await tx`
        insert into program_plans (
          project_id, title, horizon_days, status, baseline_run_id, baseline,
          finding_ids, composer_version, composition_hash, supersedes_id, created_by
        ) values (
          ${input.projectId},
          ${input.title ?? `${input.horizonDays}-day program`},
          ${input.horizonDays}, 'draft', ${runId},
          ${tx.json(baseline as never)},
          ${findings.map((f) => f.id as string)},
          ${PLAN_COMPOSER_VERSION}, ${compositionHash},
          ${(previous?.id as string) ?? null}, ${user.id}
        )
        returning id
      `;
      const planId = row!.id as string;

      for (const item of items) {
        await tx`
          insert into plan_items (
            plan_id, phase, position, play_key, title, rationale,
            source_finding_id, evidence_ids, effort_hours, owner, measurement,
            status, exclusion_reason
          ) values (
            ${planId}, ${item.phase}, ${item.position}, ${item.playKey},
            ${item.title}, ${item.rationale}, ${item.sourceFindingId},
            ${item.evidenceIds}, ${item.effortHours}, ${item.owner},
            ${item.measurement}, ${item.status}, ${item.exclusionReason}
          )
        `;
      }

      await writeAudit(tx, {
        userId: user.id,
        action: "plan.compose",
        entity: "program_plan",
        entityId: planId,
        detail: {
          findings: findings.length,
          planned: items.filter((i) => i.status === "planned").length,
          excluded: items.filter((i) => i.status === "excluded").length,
          supersededId: (previous?.id as string) ?? null,
        },
      });

      return {
        id: planId,
        projectId: input.projectId,
        title: input.title ?? `${input.horizonDays}-day program`,
        status: "draft",
        baseline,
        compositionHash,
        items,
        supersededId: (previous?.id as string) ?? null,
      } satisfies ComposedPlan;
    });

    return ok(plan);
  } catch (err) {
    return fail(err);
  }
}

export async function approvePlan(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ planId: string }>> {
  const parsed = z.object({ planId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", "Invalid plan id."));
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const [row] = await tx`
        update program_plans set status = 'approved', approved_by = ${user.id},
          approved_at = now()
        where id = ${parsed.data.planId} and status = 'draft'
        returning id
      `;
      if (!row) throw new ClassifiedError("conflict", "Only a draft plan can be approved.");
      await writeAudit(tx, {
        userId: user.id,
        action: "plan.approve",
        entity: "program_plan",
        entityId: parsed.data.planId,
        detail: {},
      });
    });
    return ok({ planId: parsed.data.planId });
  } catch (err) {
    return fail(err);
  }
}

export interface PlanSummary extends ComposedPlan {
  horizonDays: number;
  createdAt: Date;
  approvedAt: Date | null;
}

export async function getActivePlan(projectId: string): Promise<PlanSummary | null> {
  const [plan] = await sql`
    select * from program_plans
    where project_id = ${projectId} and status <> 'superseded'
    order by created_at desc limit 1
  `;
  if (!plan) return null;
  const itemRows = await sql`
    select * from plan_items where plan_id = ${plan.id}
    order by case phase when 'foundation' then 0 when 'authority' then 1 else 2 end, position
  `;
  return {
    id: plan.id as string,
    projectId: plan.projectId as string,
    title: plan.title as string,
    status: plan.status as string,
    horizonDays: Number(plan.horizonDays),
    baseline: (plan.baseline as Record<string, unknown>) ?? {},
    compositionHash: plan.compositionHash as string,
    supersededId: (plan.supersedesId as string | null) ?? null,
    createdAt: plan.createdAt as Date,
    approvedAt: (plan.approvedAt as Date | null) ?? null,
    items: itemRows.map((r) => ({
      phase: r.phase as Phase,
      position: Number(r.position),
      playKey: r.playKey as string,
      title: r.title as string,
      rationale: r.rationale as string,
      sourceFindingId: (r.sourceFindingId as string | null) ?? null,
      evidenceIds: (r.evidenceIds as string[]) ?? [],
      effortHours: Number(r.effortHours),
      owner: r.owner as string,
      measurement: r.measurement as string,
      status: r.status as PlanItem["status"],
      exclusionReason: (r.exclusionReason as string | null) ?? null,
    })),
  };
}
