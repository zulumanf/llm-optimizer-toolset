/**
 * Client-facing plan export (spec 026 follow-up).
 *
 * A download endpoint by the same pattern as the report CSV. Two rules it
 * enforces that the internal page does not:
 *
 * 1. **Only an approved plan exports.** A draft is a working document; sending
 *    one to a client makes an unreviewed composition into a commitment.
 * 2. **The download is logged.** `artifact_access_log` records who took a copy
 *    of a client deliverable off the platform (docs/10, spec 014) — the audit
 *    log records what changed, this records what left.
 */
import { sql } from "@/db/client";
import { getCurrentUser } from "@/lib/auth";
import { getActivePlan } from "@/lib/plans/service";
import { renderPlanHtml, renderPlanMarkdown } from "@/lib/plans/export";
import { recordArtifactAccessAsync } from "@/lib/security/access-log";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ planId: string }> }
): Promise<Response> {
  let user;
  try {
    user = await getCurrentUser();
  } catch {
    return new Response("unauthorized", { status: 401 });
  }

  const { planId } = await context.params;
  const [row] = await sql`
    select p.id, p.project_id, p.status, pr.name as client_name
    from program_plans p
    join projects pr on pr.id = p.project_id
    where p.id = ${planId}
  `;
  if (!row) return new Response("not found", { status: 404 });

  if (row.status !== "approved" && row.status !== "active") {
    // A draft is a working document. Exporting one turns an unreviewed
    // composition into something a client can hold us to.
    return new Response(
      "Only an approved plan can be exported. Approve it first.",
      { status: 409 }
    );
  }

  const plan = await getActivePlan(row.projectId as string);
  if (!plan || plan.id !== planId) {
    return new Response("plan is no longer current", { status: 409 });
  }

  const clientName = row.clientName as string;
  const format = new URL(request.url).searchParams.get("format") === "html" ? "html" : "markdown";
  const slug = clientName.replace(/[^\w-]+/g, "_");

  recordArtifactAccessAsync({
    userId: user.id,
    artifactType: "report",
    artifactId: planId,
    projectId: row.projectId as string,
    action: "download",
    ipAddress: request.headers.get("x-forwarded-for"),
    userAgent: request.headers.get("user-agent"),
  });

  if (format === "html") {
    return new Response(renderPlanHtml(plan, clientName), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-disposition": `inline; filename="${slug}_90_day_plan.html"`,
      },
    });
  }

  return new Response(renderPlanMarkdown(plan, clientName), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${slug}_90_day_plan.md"`,
    },
  });
}
