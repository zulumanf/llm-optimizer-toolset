import Link from "next/link";
import { FolderPlus } from "lucide-react";
import { listPortfolio } from "@/db/projects";
import { getCurrentUser, visibleProjectIds } from "@/lib/auth";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ProjectFormDialog } from "@/components/projects/project-form-dialog";
import { formatDate } from "@/lib/format";

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string }>;
}) {
  const { archived } = await searchParams;
  const includeArchived = archived === "1";
  const user = await getCurrentUser();
  const projects = await listPortfolio({
    includeArchived,
    visibleIds: await visibleProjectIds(user),
  });

  return (
    <div className="mx-auto max-w-7xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Clients</h1>
        <div className="flex items-center gap-3">
          <Link
            href={includeArchived ? "/projects" : "/projects?archived=1"}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            {includeArchived ? "Hide archived" : "Show archived"}
          </Link>
          <div className="flex gap-2">
            <Link
              href="/onboarding"
              className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Onboard client
            </Link>
            <ProjectFormDialog mode="create" />
          </div>
        </div>
      </div>

      {projects.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center">
          <FolderPlus className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No projects yet — create your first project.
          </p>
          <div className="flex gap-2">
            <Link
              href="/onboarding"
              className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Onboard client
            </Link>
            <ProjectFormDialog mode="create" />
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Client / project</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead className="text-right">Authority</TableHead>
                <TableHead className="text-right">Open gaps</TableHead>
                <TableHead>Last run</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <Link
                      href={`/projects/${p.id}`}
                      className="font-medium hover:underline"
                    >
                      {p.name}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {p.promptSetCount} set{p.promptSetCount === 1 ? "" : "s"} ·{" "}
                      {p.runCount} run{p.runCount === 1 ? "" : "s"} · since{" "}
                      {formatDate(p.createdAt)}
                    </p>
                  </TableCell>
                  <TableCell className="text-sm">
                    {p.subjectName ?? (
                      <span className="text-warning">no subject</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.authorityScore != null
                      ? Number(p.authorityScore).toFixed(1)
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.openFindings > 0 ? p.openFindings : "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {p.lastRunLabel ? (
                      <>
                        {p.lastRunLabel}{" "}
                        <Badge variant="outline">{p.lastRunStatus}</Badge>
                      </>
                    ) : (
                      "never"
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={p.status === "active" ? "default" : "outline"}>
                      {p.status}
                    </Badge>
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
