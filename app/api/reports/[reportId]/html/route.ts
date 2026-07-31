/**
 * Printable client-facing report view (roadmap 3.3). Published only,
 * project-scoped like every artifact route since Phase 0, and the
 * download-shaped access is logged — this is the page a client prints to
 * PDF or the operator sends.
 */
import { sql } from "@/db/client";
import { assertProjectAccess, getCurrentUser } from "@/lib/auth";
import { renderReportHtml } from "@/lib/reports/export-html";
import { recordArtifactAccessAsync } from "@/lib/security/access-log";
import type { ReportBody } from "@/lib/reports/types";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
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
    select r.title, r.status, r.body, r.project_id,
      r.period_start::text, r.period_end::text, r.published_at,
      p.name as client_name
    from reports r join projects p on p.id = r.project_id
    where r.id = ${reportId}
  `;
  if (!report) return new Response("not found", { status: 404 });
  try {
    // 404, not 403: a report id resolving at all is client information.
    await assertProjectAccess(user, report.projectId as string);
  } catch {
    return new Response("not found", { status: 404 });
  }
  if (report.status !== "published") {
    return new Response("only published reports can be viewed", { status: 409 });
  }

  recordArtifactAccessAsync({
    userId: user.id,
    artifactType: "report",
    artifactId: reportId,
    projectId: report.projectId as string,
    action: "view",
    ipAddress: request.headers.get("x-forwarded-for"),
    userAgent: request.headers.get("user-agent"),
  });

  const html = renderReportHtml({
    clientName: report.clientName as string,
    title: report.title as string,
    periodStart: report.periodStart as string,
    periodEnd: report.periodEnd as string,
    publishedAt: (report.publishedAt as Date).toISOString(),
    body: report.body as ReportBody,
  });
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
