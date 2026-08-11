/**
 * Durable learnings (spec 034, module L of the visibility loop). A learning
 * is a human-recorded, confidence-labeled statement distilled from measured
 * outcomes — never auto-generated, because an unvalidated observation is not
 * a universal rule. Confidence vocabulary is shared with the outcome graph
 * (spec 019). Learnings are retirable, not editable: a changed statement is
 * a new learning, so anything a past decision cited stays readable as cited.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";

// Vocabulary lives in lib/learnings/constants.ts (client-importable);
// re-exported here so existing server-side imports stay valid.
export {
  LEARNING_CATEGORIES,
  LEARNING_CONFIDENCE_LABELS,
  type LearningCategory,
  type LearningConfidence,
} from "@/lib/learnings/constants";
import type { LearningCategory, LearningConfidence } from "@/lib/learnings/constants";
import { LEARNING_CATEGORIES, LEARNING_CONFIDENCE_LABELS } from "@/lib/learnings/constants";

/** Labels that assert evidence and therefore must point at measured outcomes. */
const EVIDENCE_REQUIRED: LearningConfidence[] = ["confirmed", "strongly_supported"];

const recordSchema = z.object({
  projectId: z.string().uuid().nullish(),
  category: z.enum(LEARNING_CATEGORIES),
  statement: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1, "Statement is required.").max(500)),
  rationale: z.string().max(2000).default(""),
  confidenceLabel: z.enum(LEARNING_CONFIDENCE_LABELS),
  sourceActionOutcomeIds: z.array(z.string().uuid()).max(20).default([]),
  evidenceNote: z.string().max(1000).optional(),
  // Situation dimensions (spec 058) — what makes a learning retrievable
  // when the same shape of problem appears again.
  gapType: z.string().trim().max(80).nullish(),
  playKey: z.string().trim().max(80).nullish(),
  marketId: z.string().uuid().nullish(),
  interventionId: z.string().uuid().nullish(),
  costUsd: z.number().nonnegative().nullish(),
  scoringVersion: z.string().trim().max(40).nullish(),
  /** Which way this learning cuts for the play it names. */
  direction: z.enum(["supports", "cautions"]).default("supports"),
});

export interface Learning {
  id: string;
  projectId: string | null;
  category: LearningCategory;
  statement: string;
  rationale: string;
  confidenceLabel: LearningConfidence;
  sourceActionOutcomeIds: string[];
  evidenceNote: string | null;
  status: "active" | "retired";
  retiredReason: string | null;
  gapType: string | null;
  playKey: string | null;
  marketId: string | null;
  interventionId: string | null;
  costUsd: string | null;
  scoringVersion: string | null;
  direction: "supports" | "cautions";
  createdAt: Date;
}

const COLUMNS = sql`id, project_id, category, statement, rationale,
  confidence_label, source_action_outcome_ids, evidence_note, status,
  retired_reason, gap_type, play_key, market_id, intervention_id, cost_usd,
  scoring_version, direction, created_at`;

export async function recordLearning(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<Learning>> {
  const parsed = recordSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    const learning = await sql.begin(async (tx) => {
      if (input.projectId) {
        const [project] = await tx`select id from projects where id = ${input.projectId}`;
        if (!project) throw new ClassifiedError("not_found", "Project not found.");
      }
      // A label that asserts evidence must point at outcomes that were
      // actually measured — not merely recorded.
      if (EVIDENCE_REQUIRED.includes(input.confidenceLabel)) {
        if (input.sourceActionOutcomeIds.length === 0) {
          throw new ClassifiedError(
            "validation",
            `"${input.confidenceLabel}" requires at least one measured source outcome.`
          );
        }
        const found = await tx`
          select id, measured_at from action_outcomes
          where id = any(${input.sourceActionOutcomeIds}::uuid[])
        `;
        const byId = new Map(found.map((r) => [r.id as string, r.measuredAt]));
        for (const id of input.sourceActionOutcomeIds) {
          if (!byId.has(id)) {
            throw new ClassifiedError("not_found", `Source outcome ${id} not found.`);
          }
          if (!byId.get(id)) {
            throw new ClassifiedError(
              "validation",
              `Source outcome ${id} has not been measured yet — a "${input.confidenceLabel}" learning cannot rest on an unmeasured action.`
            );
          }
        }
      }
      // Auto-derive dimensions from the measured sources (spec 058): the
      // highest-integrity path is also the lowest-effort one. Explicit
      // input always wins; derivation only fills blanks.
      let interventionId = input.interventionId ?? null;
      let gapType = input.gapType ?? null;
      let costUsd = input.costUsd ?? null;
      if (input.sourceActionOutcomeIds.length > 0) {
        const [derived] = await tx`
          select
            (select ao.intervention_id from action_outcomes ao
              where ao.id = any(${input.sourceActionOutcomeIds}::uuid[])
                and ao.intervention_id is not null limit 1) as intervention_id,
            (select gf.gap_type from action_outcomes ao
              join gap_findings gf on gf.id = ao.gap_finding_id
              where ao.id = any(${input.sourceActionOutcomeIds}::uuid[])
              limit 1) as gap_type
        `;
        interventionId = interventionId ?? ((derived?.interventionId as string | null) ?? null);
        gapType = gapType ?? ((derived?.gapType as string | null) ?? null);
        if (costUsd === null && interventionId) {
          const [intervention] = await tx`
            select cost_usd from interventions where id = ${interventionId}
          `;
          costUsd =
            intervention?.costUsd === null || intervention?.costUsd === undefined
              ? null
              : Number(intervention.costUsd);
        }
      }
      const [row] = await tx<Learning[]>`
        insert into learnings
          (project_id, category, statement, rationale, confidence_label,
           source_action_outcome_ids, evidence_note, created_by, gap_type,
           play_key, market_id, intervention_id, cost_usd, scoring_version,
           direction)
        values
          (${input.projectId ?? null}, ${input.category}, ${input.statement},
           ${input.rationale}, ${input.confidenceLabel},
           ${input.sourceActionOutcomeIds}::uuid[],
           ${input.evidenceNote ?? null}, ${user.id}, ${gapType},
           ${input.playKey ?? null}, ${input.marketId ?? null},
           ${interventionId}, ${costUsd}, ${input.scoringVersion ?? null},
           ${input.direction})
        returning ${COLUMNS}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "learning.recorded",
        entity: "learning",
        entityId: row!.id,
        detail: {
          category: input.category,
          confidenceLabel: input.confidenceLabel,
          sourceOutcomes: input.sourceActionOutcomeIds.length,
        },
      });
      return row!;
    });
    return ok(learning);
  } catch (err) {
    return fail(err);
  }
}

const retireSchema = z.object({
  id: z.string().uuid(),
  reason: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1, "A retirement reason is required.").max(500)),
});

export async function retireLearning(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ id: string }>> {
  const parsed = retireSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const [row] = await tx`
        select status from learnings where id = ${parsed.data.id} for update
      `;
      if (!row) throw new ClassifiedError("not_found", "Learning not found.");
      if (row.status === "retired") {
        throw new ClassifiedError("conflict", "This learning is already retired.");
      }
      await tx`
        update learnings set status = 'retired',
          retired_reason = ${parsed.data.reason},
          retired_by = ${user.id}, retired_at = now()
        where id = ${parsed.data.id}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "learning.retired",
        entity: "learning",
        entityId: parsed.data.id,
        detail: { reason: parsed.data.reason },
      });
    });
    return ok({ id: parsed.data.id });
  } catch (err) {
    return fail(err);
  }
}

export interface SearchLearningsInput {
  query?: string;
  projectId?: string;
  category?: LearningCategory;
  includeRetired?: boolean;
}

/** Project searches include cross-project rows (project_id null) — a global
 * pattern applies to every client until retired. */
export async function searchLearnings(
  input: SearchLearningsInput
): Promise<Learning[]> {
  const like = input.query ? `%${input.query}%` : null;
  return sql<Learning[]>`
    select ${COLUMNS}
    from learnings
    where true
      ${input.includeRetired ? sql`` : sql`and status = 'active'`}
      ${input.projectId
        ? sql`and (project_id = ${input.projectId} or project_id is null)`
        : sql``}
      ${input.category ? sql`and category = ${input.category}` : sql``}
      ${like ? sql`and (statement ilike ${like} or rationale ilike ${like})` : sql``}
    order by created_at desc
    limit 100
  `;
}

export interface ComparableLearningsQuery {
  playKey?: string | null;
  gapType?: string | null;
  marketId?: string | null;
  projectId?: string | null;
}

/**
 * Retrieval by situation (spec 058): active learnings matching the play
 * and/or gap, strongest confidence first. Market and project filters keep
 * global rows — a cross-market pattern is evidence everywhere; a local one
 * only locally.
 */
export async function findComparableLearnings(
  query: ComparableLearningsQuery
): Promise<Learning[]> {
  const rows = await sql<Learning[]>`
    select ${COLUMNS} from learnings
    where status = 'active'
      ${query.playKey ? sql`and play_key = ${query.playKey}` : sql``}
      ${query.gapType ? sql`and (gap_type = ${query.gapType} or gap_type is null)` : sql``}
      ${query.marketId ? sql`and (market_id = ${query.marketId} or market_id is null)` : sql``}
      ${query.projectId ? sql`and (project_id = ${query.projectId} or project_id is null)` : sql``}
    order by
      case confidence_label
        when 'confirmed' then 0
        when 'strongly_supported' then 1
        when 'correlated' then 2
        when 'probable' then 3
        else 4
      end,
      created_at desc
    limit 50
  `;
  return rows;
}
