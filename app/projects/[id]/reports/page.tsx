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
    <div className="mx-auto max-w-7xl p-6">
      <ProjectTabs projectId={id} setKey="reports" />
      <nav className="mb-3 text-sm text-muted-foreground">
        <Link href="/projects" className="hover:text-foreground">Projects</Link>
        {" / "}
        <Link href={`/projects/${id}`} className="hover:text-foreground">
          {project.name}
        </Link>
        {" / "}Reports
      </nav>

      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Reports</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Drafts are editable (narrative only — never numbers). Published
            reports are immutable forever (docs/07 step 8).
          </p>
        </div>
        {project.status === "active" && <GenerateReportDialog projectId={id} />}
      </div>

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
    </div>
  );
}
