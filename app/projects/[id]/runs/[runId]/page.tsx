import { PageHeader, PageShell } from "@/components/layout/page";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getProject } from "@/db/projects";
import { getRun, listRunCells } from "@/db/runs";
import { listScoresForRun } from "@/db/scores";
import { pendingReviewCount } from "@/db/mentions";
import { runCoverage } from "@/lib/scoring/coverage";
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
  const [cells, scores, pendingReviews] = await Promise.all([
    listRunCells(runId),
    listScoresForRun(runId),
    pendingReviewCount(runId),
  ]);
  // Coverage reads the same mentions scoring reads — only meaningful once
  // the run has scored (spec 063).
  const coverage = scores.length > 0 ? await runCoverage(runId) : null;
  const DIMENSION_LABELS: Record<string, string> = {
    category: "Category",
    intent: "Intent",
    audience: "Audience",
    price_tier: "Price tier",
  };

  const successes = cells.filter((c) => c.error === null).length;
  const failures = cells.filter((c) => c.error !== null).length;
  const totalPlanned = run.providers.reduce(
    (acc, p) => acc + p.repetitions,
    0
  );
  const isActive = run.status === "pending" || run.status === "running";

  return (
    <PageShell>
      {isActive && <RunLiveRefresh />}
      <PageHeader
        crumbs={[
          { label: "Projects", href: "/projects" },
          { label: project.name, href: `/projects/${projectId}` },
          { label: "Runs", href: `/projects/${projectId}/runs` },
          { label: run.label },
        ]}
        title={run.label}
        badge={<Badge variant={runStatusVariant(run.status)}>{run.status}</Badge>}
        description={
          <>
            {successes} captured · {failures} failed
            {run.statusDetail ? ` · ${run.statusDetail}` : ""} · $
            {Number(run.costUsd).toFixed(2)} of ${Number(run.budgetUsd).toFixed(2)}{" "}
            budget · {run.providers.map((p) => `${p.model}×${p.repetitions}`).join(", ")}
            {totalPlanned > 0 ? "" : ""}
          </>
        }
        actions={
          <div className="flex shrink-0 items-center gap-2">
          {scores.length > 0 && (
            <Link
              href={`/projects/${projectId}/runs/${runId}/evidence`}
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
            >
              Evidence
            </Link>
          )}
          <RunControls
            runId={run.id}
            status={run.status}
            hasFailures={failures > 0}
          />
          </div>
        }
      />

      <section className="mb-6">
        <h2 className="mb-2 text-lg font-medium">Scores</h2>
        {scores.length > 0 ? (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead>Metric</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead className="text-right">N</TableHead>
                  <TableHead>Version</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {scores.map((s) => (
                  <TableRow key={`${s.companyId}-${s.metric}-${s.provider}`}>
                    <TableCell className="font-medium">
                      {s.companyName}
                      {s.isSelf && <Badge className="ml-2">own brand</Badge>}
                    </TableCell>
                    <TableCell className="text-sm">{s.metric}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {s.provider}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {s.sampleSize < 10
                        ? "insufficient data"
                        : s.metric === "authority_score"
                          ? // Already 0–100 (docs/06) — ×100 rendered a 55.2
                            // authority as "5520.0%".
                            Number(s.value).toFixed(1)
                          : `${(Number(s.value) * 100).toFixed(1)}%`}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-xs">
                      {s.sampleSize}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {s.scoringVersion}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : pendingReviews > 0 ? (
          <div className="rounded-md border border-warning/50 bg-warning/10 px-4 py-3 text-sm">
            Scoring blocked: {pendingReviews} classification
            {pendingReviews === 1 ? "" : "s"} awaiting review —{" "}
            <Link href={`/projects/${projectId}/review`} className="underline">
              open the review queue
            </Link>
            .
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {isActive
              ? "Scores appear after the run completes, parses, and clears review."
              : "No scores yet — parsing may still be in the worker queue."}
          </p>
        )}
      </section>

      {coverage && coverage.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-lg font-medium">
            Coverage{" "}
            <span className="text-sm font-normal text-muted-foreground">
              (own brand, prompts where it appears — counted, holdouts excluded)
            </span>
          </h2>
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Dimension</TableHead>
                  <TableHead>Segment</TableHead>
                  <TableHead className="text-right">Prompts</TableHead>
                  <TableHead className="text-right">Brought up</TableHead>
                  <TableHead className="text-right">Recommended</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {coverage.map((row) => (
                  <TableRow key={`${row.dimension}-${row.segment}`}>
                    <TableCell className="text-sm text-muted-foreground">
                      {DIMENSION_LABELS[row.dimension] ?? row.dimension}
                    </TableCell>
                    <TableCell className="text-sm font-medium">{row.segment}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.promptCount}
                    </TableCell>
                    <TableCell
                      className={`text-right tabular-nums ${
                        row.mentionedPrompts === 0 ? "text-destructive" : ""
                      }`}
                    >
                      {row.mentionedPrompts}/{row.promptCount}
                    </TableCell>
                    <TableCell
                      className={`text-right tabular-nums ${
                        row.recommendedPrompts === 0 ? "text-destructive" : ""
                      }`}
                    >
                      {row.recommendedPrompts}/{row.promptCount}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

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
    </PageShell>
  );
}
