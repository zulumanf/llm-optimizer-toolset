import Link from "next/link";
import { notFound } from "next/navigation";
import { getProject } from "@/db/projects";
import { getRun, listRunCells } from "@/db/runs";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { runStatusVariant } from "@/components/runs/status";
import { RunControls } from "@/components/runs/run-controls";
import { RunLiveRefresh } from "@/components/runs/run-live-refresh";

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const { id: projectId, runId } = await params;
  const [project, run] = await Promise.all([getProject(projectId), getRun(runId)]);
  if (!project || !run || run.projectId !== projectId) notFound();
  const cells = await listRunCells(runId);

  const successes = cells.filter((c) => c.error === null).length;
  const failures = cells.filter((c) => c.error !== null).length;
  const totalPlanned = run.providers.reduce(
    (acc, p) => acc + p.repetitions,
    0
  );
  const isActive = run.status === "pending" || run.status === "running";

  return (
    <div className="mx-auto max-w-7xl p-6">
      {isActive && <RunLiveRefresh />}
      <nav className="mb-3 text-sm text-muted-foreground">
        <Link href="/projects" className="hover:text-foreground">Projects</Link>
        {" / "}
        <Link href={`/projects/${projectId}`} className="hover:text-foreground">
          {project.name}
        </Link>
        {" / "}
        <Link href={`/projects/${projectId}/runs`} className="hover:text-foreground">
          Runs
        </Link>
        {" / "}{run.label}
      </nav>

      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{run.label}</h1>
            <Badge variant={runStatusVariant(run.status)}>{run.status}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {successes} captured · {failures} failed
            {run.statusDetail ? ` · ${run.statusDetail}` : ""} · $
            {Number(run.costUsd).toFixed(2)} of ${Number(run.budgetUsd).toFixed(2)}{" "}
            budget · {run.providers.map((p) => `${p.model}×${p.repetitions}`).join(", ")}
            {totalPlanned > 0 ? "" : ""}
          </p>
        </div>
        <RunControls
          runId={run.id}
          status={run.status}
          hasFailures={failures > 0}
        />
      </div>

      {cells.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          {isActive
            ? "Waiting for the worker to capture the first responses… (is `npm run worker` running?)"
            : "No responses were captured for this run."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Prompt</TableHead>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Rep</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Latency</TableHead>
                <TableHead className="text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cells.map((cell) => (
                <TableRow key={cell.id}>
                  <TableCell className="max-w-md">
                    <Link
                      href={`/projects/${projectId}/runs/${runId}/responses/${cell.id}`}
                      className="block truncate font-mono text-xs hover:underline"
                    >
                      {cell.promptText}
                    </Link>
                  </TableCell>
                  <TableCell className="text-xs">{cell.model}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {cell.repetition}
                  </TableCell>
                  <TableCell>
                    {cell.error ? (
                      <Badge variant="destructive">{cell.error.kind}</Badge>
                    ) : cell.refusal ? (
                      <Badge variant="outline">refusal</Badge>
                    ) : (
                      <Badge variant="secondary">captured</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-xs">
                    {cell.latencyMs != null ? `${cell.latencyMs}ms` : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-xs">
                    ${Number(cell.costUsd).toFixed(4)}
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
