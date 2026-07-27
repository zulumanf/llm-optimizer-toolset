import Link from "next/link";
import { notFound } from "next/navigation";
import { PlayCircle } from "lucide-react";
import { getProject } from "@/db/projects";
import { listRuns } from "@/db/runs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate } from "@/lib/format";
import { runStatusVariant } from "@/components/runs/status";

export default async function RunsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();
  const runs = await listRuns(id);

  return (
    <div className="mx-auto max-w-7xl p-6">
      <nav className="mb-3 text-sm text-muted-foreground">
        <Link href="/projects" className="hover:text-foreground">Projects</Link>
        {" / "}
        <Link href={`/projects/${id}`} className="hover:text-foreground">
          {project.name}
        </Link>
        {" / "}Runs
      </nav>

      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Runs</h1>
        {project.status === "active" && (
          <Button asChild size="sm">
            <Link href={`/projects/${id}/runs/new`}>
              <PlayCircle className="size-4" /> New run
            </Link>
          </Button>
        )}
      </div>

      {runs.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center">
          <PlayCircle className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No runs yet. A run executes a frozen prompt set across providers
            and captures every raw response immutably.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Label</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Captured</TableHead>
                <TableHead className="text-right">Failed</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Started</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <Link
                      href={`/projects/${id}/runs/${r.id}`}
                      className="font-medium hover:underline"
                    >
                      {r.label}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={runStatusVariant(r.status)}>{r.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.successCount}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.failedCount > 0 ? r.failedCount : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    ${Number(r.costUsd).toFixed(2)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{r.trigger}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(r.startedAt)}
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
