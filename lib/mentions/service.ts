/**
 * Human review (spec 004, docs/07 step 6): confirming or correcting a
 * low-confidence mention writes an immutable new revision with reviewer
 * identity and confidence 1.0. Clearing a run's queue unblocks scoring.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, assertRole, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import { SENTIMENTS } from "@/lib/constants";
import { maybeEnqueueScoring, enqueueParseJobs } from "@/lib/parsing/service";
import { log } from "@/lib/logger";

const reviewSchema = z.object({
  mentionId: z.string().uuid(),
  verdict: z.enum(["confirm", "correct"]),
  corrections: z
    .object({
      mentioned: z.boolean().optional(),
      recommended: z.boolean().optional(),
      listPosition: z.number().int().min(1).nullable().optional(),
      sentiment: z.enum(SENTIMENTS).optional(),
    })
    .optional(),
});

export async function reviewMention(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ mentionId: string }>> {
  const parsed = reviewSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const { mentionId, verdict, corrections } = parsed.data;
  try {
    assertCanWrite(user);
    const runId = await sql.begin(async (tx) => {
      const [mention] = await tx`
        select m.*, r.run_id
        from mentions m
        join responses r on r.id = m.response_id
        where m.id = ${mentionId}
      `;
      if (!mention) throw new ClassifiedError("not_found", "Mention not found.");
      const [newer] = await tx`
        select 1 from mentions
        where response_id = ${mention.responseId} and company_id = ${mention.companyId}
          and revision > ${mention.revision}
      `;
      if (newer) {
        throw new ClassifiedError("conflict", "A newer revision already exists.");
      }
      if (!mention.needsReview) {
        throw new ClassifiedError("conflict", "This mention is not awaiting review.");
      }

      const merged = verdict === "correct" ? corrections ?? {} : {};
      await tx`
        insert into mentions
          (response_id, company_id, revision, mentioned, recommended,
           list_position, sentiment, excerpt, cited_urls, parser_version,
           confidence, needs_review, reviewed_by, reviewed_at)
        values
          (${mention.responseId}, ${mention.companyId}, ${(mention.revision as number) + 1},
           ${merged.mentioned ?? mention.mentioned},
           ${merged.recommended ?? mention.recommended},
           ${merged.listPosition === undefined ? mention.listPosition : merged.listPosition},
           ${merged.sentiment ?? mention.sentiment},
           ${mention.excerpt}, ${mention.citedUrls},
           ${mention.parserVersion}, 1.0, false, ${user.id}, now())
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "mention.review",
        entity: "mention",
        entityId: mentionId,
        detail: { verdict, corrections: merged as never },
      });
      return mention.runId as string;
    });
    await maybeEnqueueScoring(runId);
    return ok({ mentionId });
  } catch (err) {
    return fail(err);
  }
}

/**
 * Bulk confirm (UX): clearing a queue one card at a time is the operator's
 * biggest time sink at agency scale, and scoring stays blocked until the
 * queue is empty. Each mention still gets its own audited revision — this is
 * a batching of the same decision, never a shortcut around it. Confirm only:
 * a correction is per-item by nature and stays a single-card action.
 */
export async function bulkConfirmMentions(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ confirmed: number; skipped: number }>> {
  const parsed = z
    .object({ mentionIds: z.array(z.string().uuid()).min(1).max(200) })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const { mentionIds } = parsed.data;
  let confirmed = 0;
  let skipped = 0;

  for (const mentionId of mentionIds) {
    // Per-item so one stale row (superseded by a re-parse mid-review) cannot
    // abort the batch — it is skipped and reported. reviewMention also
    // re-checks scoring readiness, so the queue unblocks itself.
    const result = await reviewMention(user, { mentionId, verdict: "confirm" });
    if (result.ok) confirmed += 1;
    else skipped += 1;
  }

  log("info", "mentions.bulk_confirm", {
    requested: mentionIds.length,
    confirmed,
    skipped,
  });
  return ok({ confirmed, skipped });
}

/** Admin: re-parse a run (after alias/parser changes). New revisions only. */
export async function reparseRun(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ runId: string; enqueued: number }>> {
  const parsed = z.object({ runId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid run id."));
  }
  const { runId } = parsed.data;
  try {
    assertRole(user, "admin");
    const [run] = await sql`select id from runs where id = ${runId}`;
    if (!run) return fail(new ClassifiedError("not_found", "Run not found."));
    // Clear the ledger for the current parser version so parse jobs re-run;
    // mentions are never deleted — re-parse appends revisions (docs/03)
    await sql.begin(async (tx) => {
      await tx`delete from response_parses where run_id = ${runId}`;
      await writeAudit(tx, {
        userId: user.id,
        action: "run.reparse",
        entity: "run",
        entityId: runId,
      });
    });
    const enqueued = await enqueueParseJobs(runId);
    return ok({ runId, enqueued });
  } catch (err) {
    return fail(err);
  }
}
