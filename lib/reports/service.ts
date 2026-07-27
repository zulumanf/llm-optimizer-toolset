/**
 * Report lifecycle (spec 006): draft → narrative edits (never numbers) →
 * evidence-gated publish → immutable. Numbers live only in the snapshot;
 * updateNarrative rejects anything but narrative section keys server-side.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import type { CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage, duplicateNameConflict } from "@/lib/service-helpers";
import { buildSnapshot } from "@/lib/reports/snapshot";
import { validateNarrative } from "@/lib/reports/narrative";
import {
  NARRATIVE_SECTIONS,
  type NarrativeSection,
  type ReportBody,
} from "@/lib/reports/types";

export interface Report {
  id: string;
  projectId: string;
  title: string;
  periodStart: string;
  periodEnd: string;
  body: ReportBody;
  status: "draft" | "published";
  createdAt: Date;
  publishedBy: string | null;
  publishedAt: Date | null;
}

const COLUMNS = sql`id, project_id, title,
  to_char(period_start, 'YYYY-MM-DD') as period_start,
  to_char(period_end, 'YYYY-MM-DD') as period_end,
  body, status, created_at, published_by, published_at`;

const generateSchema = z.object({
  projectId: z.string().uuid(),
  title: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1, "Title is required.").max(120)),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function generateReportDraft(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<Report>> {
  const parsed = generateSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const { projectId, title, periodStart, periodEnd } = parsed.data;
  if (periodEnd < periodStart) {
    return fail(new ClassifiedError("validation", "Period end precedes start."));
  }
  try {
    const body = await buildSnapshot(projectId, periodStart, periodEnd);
    const report = await sql.begin(async (tx) => {
      const [row] = await tx<Report[]>`
        insert into reports (project_id, title, period_start, period_end, body)
        values (${projectId}, ${title}, ${periodStart}, ${periodEnd},
          ${tx.json(body as never)})
        returning ${COLUMNS}
      `;
      if (!row) throw new ClassifiedError("internal", "Insert returned no row.");
      await writeAudit(tx, {
        userId: user.id,
        action: "report.draft",
        entity: "report",
        entityId: row.id,
        detail: { title, periodStart, periodEnd },
      });
      return row;
    });
    return ok(report);
  } catch (err) {
    return fail(
      duplicateNameConflict(err, "A draft for this period already exists.")
    );
  }
}

export async function updateReportNarrative(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ reportId: string }>> {
  const parsed = z
    .object({
      reportId: z.string().uuid(),
      sectionKey: z.enum(NARRATIVE_SECTIONS),
      markdown: z.string().max(20_000),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const { reportId, sectionKey, markdown } = parsed.data;
  try {
    await sql.begin(async (tx) => {
      const [report] = await tx`
        select status, body from reports where id = ${reportId} for update
      `;
      if (!report) throw new ClassifiedError("not_found", "Report not found.");
      if (report.status !== "draft") {
        throw new ClassifiedError("conflict", "Published reports are immutable.");
      }
      const body = report.body as ReportBody;
      // Only the narrative changes — snapshot numbers are untouchable
      body.narrative[sectionKey] = markdown;
      await tx`
        update reports set body = ${tx.json(body as never)} where id = ${reportId}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "report.edit",
        entity: "report",
        entityId: reportId,
        detail: { sectionKey },
      });
    });
    return ok({ reportId });
  } catch (err) {
    return fail(err);
  }
}

export async function regenerateReportDraft(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ reportId: string }>> {
  const parsed = z.object({ reportId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid report id."));
  }
  const { reportId } = parsed.data;
  try {
    const [report] = await sql`
      select status, project_id,
        to_char(period_start, 'YYYY-MM-DD') as period_start,
        to_char(period_end, 'YYYY-MM-DD') as period_end
      from reports where id = ${reportId}
    `;
    if (!report) return fail(new ClassifiedError("not_found", "Report not found."));
    if (report.status !== "draft") {
      return fail(new ClassifiedError("conflict", "Published reports are immutable."));
    }
    const body = await buildSnapshot(
      report.projectId as string,
      report.periodStart as string,
      report.periodEnd as string
    );
    await sql.begin(async (tx) => {
      await tx`update reports set body = ${tx.json(body as never)} where id = ${reportId}`;
      await writeAudit(tx, {
        userId: user.id,
        action: "report.regenerate",
        entity: "report",
        entityId: reportId,
      });
    });
    return ok({ reportId });
  } catch (err) {
    return fail(err);
  }
}

const publishSchema = z.object({
  reportId: z.string().uuid(),
  acknowledgePendingReviews: z.boolean().optional(),
});

export async function publishReport(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ reportId: string }>> {
  const parsed = publishSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid input."));
  }
  const { reportId, acknowledgePendingReviews } = parsed.data;
  try {
    await sql.begin(async (tx) => {
      const [report] = await tx`
        select status, body from reports where id = ${reportId} for update
      `;
      if (!report) throw new ClassifiedError("not_found", "Report not found.");
      if (report.status !== "draft") {
        throw new ClassifiedError("conflict", "Report is already published.");
      }
      const body = report.body as ReportBody;

      // Evidence gate: every claim cited and resolvable (docs/06, must be 1.0)
      const validation = validateNarrative(body.narrative, body);
      if (!validation.ok) {
        const detail = [
          ...validation.uncitedSentences.map((s) => `uncited: "${s}"`),
          ...validation.unresolvedCitations.map((c) => `unresolved: ${c}`),
        ]
          .slice(0, 5)
          .join(" · ");
        throw new ClassifiedError(
          "validation",
          `Evidence gate failed — every sentence with a number needs a resolvable citation. ${detail}`
        );
      }

      // Pending reviews in the period require explicit acknowledgment
      if (body.coverage.pendingReview > 0 && !acknowledgePendingReviews) {
        throw new ClassifiedError(
          "conflict",
          `${body.coverage.pendingReview} classifications in this period still await review — clear the queue or acknowledge the exclusion explicitly.`
        );
      }

      await tx`
        update reports set status = 'published',
          published_by = ${user.id}, published_at = now()
        where id = ${reportId}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "report.publish",
        entity: "report",
        entityId: reportId,
        detail: {
          acknowledgedPendingReviews: Boolean(
            body.coverage.pendingReview > 0 && acknowledgePendingReviews
          ),
          pendingReview: body.coverage.pendingReview,
        },
      });
    });
    return ok({ reportId });
  } catch (err) {
    return fail(err);
  }
}

export async function deleteDraft(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ reportId: string }>> {
  const parsed = z.object({ reportId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid report id."));
  }
  try {
    await sql.begin(async (tx) => {
      const [row] = await tx`
        delete from reports where id = ${parsed.data.reportId} and status = 'draft'
        returning id
      `;
      if (!row) {
        throw new ClassifiedError(
          "conflict",
          "Draft not found (published reports cannot be deleted)."
        );
      }
      await writeAudit(tx, {
        userId: user.id,
        action: "report.discard_draft",
        entity: "report",
        entityId: parsed.data.reportId,
      });
    });
    return ok({ reportId: parsed.data.reportId });
  } catch (err) {
    return fail(err);
  }
}

/** CSV of the score snapshot (published reports). Pure string building. */
export function reportScoresCsv(body: ReportBody): string {
  const header = "company,metric,provider,value,sample_size,scoring_version";
  const lines = body.scores.map((s) =>
    [
      `"${s.companyName.replace(/"/g, '""')}"`,
      s.metric,
      s.provider,
      s.value,
      s.sampleSize,
      s.scoringVersion,
    ].join(",")
  );
  return [header, ...lines].join("\n");
}
