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

export const LEARNING_CATEGORIES = [
  "content",
  "authority",
  "entity",
  "technical",
  "distribution",
  "process",
  "other",
] as const;
export type LearningCategory = (typeof LEARNING_CATEGORIES)[number];

export const LEARNING_CONFIDENCE_LABELS = [
  "confirmed",
  "strongly_supported",
  "correlated",
  "probable",
  "unknown",
] as const;
export type LearningConfidence = (typeof LEARNING_CONFIDENCE_LABELS)[number];

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
  createdAt: Date;
}

const COLUMNS = sql`id, project_id, category, statement, rationale,
  confidence_label, source_action_outcome_ids, evidence_note, status,
  retired_reason, created_at`;

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
      const [row] = await tx<Learning[]>`
        insert into learnings
          (project_id, category, statement, rationale, confidence_label,
           source_action_outcome_ids, evidence_note, created_by)
        values
          (${input.projectId ?? null}, ${input.category}, ${input.statement},
           ${input.rationale}, ${input.confidenceLabel},
           ${input.sourceActionOutcomeIds}::uuid[],
           ${input.evidenceNote ?? null}, ${user.id})
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
