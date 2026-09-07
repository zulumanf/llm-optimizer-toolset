import { PageHeader, PageShell } from "@/components/layout/page";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FileText } from "lucide-react";
import { getProject } from "@/db/projects";
import { sql } from "@/db/client";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { GenerateReportDialog } from "@/components/reports/generate-report-dialog";
import { formatDate } from "@/lib/format";
import { ProjectTabs } from "@/components/layout/project-tabs";

export default async function ReportsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();

  const reports = await sql`
    select id, title, status,
      to_char(period_start, 'YYYY-MM-DD') as period_start,
      to_char(period_end, 'YYYY-MM-DD') as period_end,
      created_at, published_at
    from reports
    where project_id = ${id}
    order by created_at desc
  `;

  return (
    <PageShell>
      <ProjectTabs projectId={id} setKey="reports" />
      <PageHeader
        crumbs={[{ label: "Projects", href: "/projects" }, { label: project.name, href: `/projects/${id}` }, { label: "Reports" }]}
        title="Reports"
        description={
          <>
            Drafts are editable (narrative only — never numbers). Published
            reports are immutable forever (docs/07 step 8).
          </>
        }
        actions={
          <>
            {project.status === "active" && <GenerateReportDialog projectId={id} />}
          </>
        }
      />
      {reports.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center">
          <FileText className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No reports yet — generate a draft for a period with scored runs.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Period</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reports.map((r) => (
                <TableRow key={r.id as string}>
                  <TableCell>
                    <Link
                      href={`/projects/${id}/reports/${r.id}`}
                      className="font-medium hover:underline"
                    >
                      {r.title as string}
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {r.periodStart as string} → {r.periodEnd as string}
                  </TableCell>
                  <TableCell>
                    <Badge variant={r.status === "published" ? "default" : "outline"}>
                      {r.status as string}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDate(r.createdAt as Date)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </PageShell>
  );
}
