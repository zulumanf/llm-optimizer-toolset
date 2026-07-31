/** CSV export of a published report's score snapshot (spec 006). A machine
 * download endpoint — the one non-cron route handler (noted in the spec). */
import { sql } from "@/db/client";
import { assertProjectAccess, getCurrentUser } from "@/lib/auth";
import { reportScoresCsv } from "@/lib/reports/service";
import type { ReportBody } from "@/lib/reports/types";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ reportId: string }> }
): Promise<Response> {
  let user;
  try {
    user = await getCurrentUser();
  } catch {
    return new Response("unauthorized", { status: 401 });
  }
  const { reportId } = await context.params;
  const [report] = await sql`
    select title, status, body, project_id from reports where id = ${reportId}
  `;
  if (!report) return new Response("not found", { status: 404 });
  try {
    // 404, not 403: a report id resolving at all is client information.
    await assertProjectAccess(user, report.projectId as string);
  } catch {
    return new Response("not found", { status: 404 });
  }
  if (report.status !== "published") {
    return new Response("only published reports can be exported", { status: 409 });
  }
  const csv = reportScoresCsv(report.body as ReportBody);
  const filename = `${(report.title as string).replace(/[^\w-]+/g, "_")}.csv`;
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}
