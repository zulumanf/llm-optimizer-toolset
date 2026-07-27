import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "@/db/client";
import { getProject } from "@/db/projects";
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
import { NarrativeEditor } from "@/components/reports/narrative-editor";
import { PublishControls } from "@/components/reports/publish-controls";
import { NARRATIVE_SECTIONS, type ReportBody } from "@/lib/reports/types";
import { formatDate } from "@/lib/format";

const SECTION_TITLES: Record<string, string> = {
  summary: "Summary",
  competitors: "Competitors",
  notable_responses: "Notable responses",
  suggested_actions: "Suggested actions (human approval required)",
};

export default async function ReportPage({
  params,
}: {
  params: Promise<{ id: string; reportId: string }>;
}) {
  const { id: projectId, reportId } = await params;
  const project = await getProject(projectId);
  const [report] = await sql`
    select id, project_id, title, status, body, created_at, published_at,
      to_char(period_start, 'YYYY-MM-DD') as period_start,
      to_char(period_end, 'YYYY-MM-DD') as period_end
    from reports where id = ${reportId}
  `;
  if (!project || !report || report.projectId !== projectId) notFound();
  const body = report.body as ReportBody;
  const isDraft = report.status === "draft";

  return (
    <div className="mx-auto max-w-5xl p-6">
      <nav className="mb-3 text-sm text-muted-foreground">
        <Link href={`/projects/${projectId}/reports`} className="hover:text-foreground">
          Reports
        </Link>
        {" / "}{report.title as string}
      </nav>

      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{report.title as string}</h1>
            <Badge variant={isDraft ? "outline" : "default"}>
              {report.status as string}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {report.periodStart as string} → {report.periodEnd as string} ·
            scoring {body.scoringVersion} · {body.runs.length} run
            {body.runs.length === 1 ? "" : "s"} · generated{" "}
            {formatDate(new Date(body.generatedAt))}
            {report.publishedAt
              ? ` · published ${formatDate(report.publishedAt as Date)} — immutable`
              : ""}
          </p>
          {!body.comparable && (
            <p className="mt-1 text-xs text-warning">{body.comparabilityNote}</p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          {!isDraft && (
            <Button asChild size="sm" variant="outline">
              <a href={`/api/reports/${reportId}/csv`}>Export CSV</a>
            </Button>
          )}
          {isDraft && (
            <PublishControls
              reportId={reportId}
              pendingReview={body.coverage.pendingReview}
            />
          )}
        </div>
      </div>

      <div className="mb-6 rounded-md border bg-muted/30 px-4 py-3 text-sm">
        Coverage: {body.coverage.capturedCells} captured ·{" "}
        {body.coverage.failedCells} failed · {body.coverage.refusals} refusals ·{" "}
        {body.coverage.pendingReview} pending review
      </div>

      {NARRATIVE_SECTIONS.map((section) => (
        <section key={section} className="mb-6">
          <h2 className="mb-2 text-lg font-medium">{SECTION_TITLES[section]}</h2>
          {isDraft ? (
            <NarrativeEditor
              reportId={reportId}
              sectionKey={section}
              initial={body.narrative[section] ?? ""}
            />
          ) : (
            <div className="whitespace-pre-wrap rounded-md border p-4 text-sm">
              {body.narrative[section] ?? ""}
            </div>
          )}
        </section>
      ))}

      <section className="mb-6">
        <h2 className="mb-2 text-lg font-medium">
          Score snapshot{" "}
          <span className="text-sm font-normal text-muted-foreground">
            (numbers live here — not editable)
          </span>
        </h2>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Company</TableHead>
                <TableHead>Metric</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead className="text-right">Δ vs prev</TableHead>
                <TableHead className="text-right">N</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {body.scores
                .filter((s) => s.provider === "all")
                .map((s) => {
                  const delta = body.deltas.find(
                    (d) => d.companyId === s.companyId && d.metric === s.metric
                  );
                  return (
                    <TableRow key={s.scoreId}>
                      <TableCell className="font-medium">
                        {s.companyName}
                        {s.isSelf && <Badge className="ml-2">Parva</Badge>}
                      </TableCell>
                      <TableCell className="text-sm">{s.metric}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {s.provider}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {s.metric === "authority_score"
                          ? s.value.toFixed(1)
                          : `${(s.value * 100).toFixed(1)}%`}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-xs">
                        {delta
                          ? `${delta.delta >= 0 ? "+" : ""}${delta.delta.toFixed(3)}${delta.verdict ? ` (${delta.verdict.replace(/_/g, " ")})` : ""}`
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-xs">
                        {s.sampleSize}
                      </TableCell>
                    </TableRow>
                  );
                })}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}
