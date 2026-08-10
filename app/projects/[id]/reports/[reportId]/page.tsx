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
import { DeliveryDialog } from "@/components/reports/delivery-dialog";
import { listReportDeliveries } from "@/lib/reports/service";
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
  const deliveries = isDraft ? [] : await listReportDeliveries(reportId);

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
            <>
              <Button asChild size="sm" variant="outline">
                <a href={`/api/reports/${reportId}/csv`}>Export CSV</a>
              </Button>
              <DeliveryDialog reportId={reportId} />
            </>
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
        {body.kind && (
          <span className="mr-2 font-medium">
            {body.kind === "weekly_pulse"
              ? "Weekly pulse"
              : body.kind === "monthly"
                ? "Monthly report"
                : "Quarterly review"}
            {" · "}
          </span>
        )}
        Coverage: {body.coverage.capturedCells} captured ·{" "}
        {body.coverage.failedCells} failed · {body.coverage.refusals} refusals ·{" "}
        {body.coverage.pendingReview} pending review
      </div>

      {!isDraft && (
        <section className="mb-6">
          <h2 className="mb-2 text-lg font-medium">Deliveries</h2>
          {deliveries.length === 0 ? (
            <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              Not recorded as delivered yet. Send it from your mailbox (or walk
              the client through the portal), then record it here so the ledger
              answers &quot;was this ever sent&quot;.
            </p>
          ) : (
            <ul className="space-y-1 text-sm">
              {deliveries.map((d) => (
                <li key={d.id} className="rounded-md border px-3 py-2">
                  <span className="font-medium">{d.recipient}</span>
                  <span className="text-muted-foreground">
                    {" "}· {d.channel.replace(/_/g, " ")} ·{" "}
                    {formatDate(d.deliveredAt)}
                    {d.deliveredBy ? ` · by ${d.deliveredBy}` : ""}
                    {d.note ? ` · ${d.note}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {(body.categoryOwnership?.length ?? 0) > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-lg font-medium">
            Category ownership{" "}
            <span className="text-sm font-normal text-muted-foreground">
              (counts, not just labels)
            </span>
          </h2>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs">
                <tr>
                  <th className="p-2">Category</th>
                  <th className="p-2">Standing</th>
                  <th className="p-2">Mentioned</th>
                  <th className="p-2">Recommended</th>
                  <th className="p-2">Leader</th>
                </tr>
              </thead>
              <tbody>
                {body.categoryOwnership.map((row) => (
                  <tr key={row.category} className="border-t">
                    <td className="p-2">{row.category}</td>
                    <td className="p-2">
                      <Badge
                        variant={
                          row.label === "owned"
                            ? "default"
                            : row.label === "absent"
                              ? "outline"
                              : "secondary"
                        }
                      >
                        {row.label}
                      </Badge>
                    </td>
                    <td className="p-2 tabular-nums">
                      {row.mentions} of {row.observations}
                    </td>
                    <td className="p-2 tabular-nums">
                      {row.recommendations} of {row.observations}
                    </td>
                    <td className="p-2 text-muted-foreground">
                      {row.leadingCompetitor
                        ? `${row.leadingCompetitor} (${row.leadingCompetitorMentions})`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {body.program && (
        <section className="mb-6">
          <h2 className="mb-2 text-lg font-medium">Program activity</h2>
          <div className="space-y-3 rounded-md border p-4 text-sm">
            {body.program.accuracyFindings.length > 0 && (
              <div>
                <p className="font-medium">Factual accuracy findings</p>
                <ul className="mt-1 space-y-1">
                  {body.program.accuracyFindings.map((a) => (
                    <li key={a.accuracyId} className="text-muted-foreground">
                      <Badge
                        variant={a.severity === "high" ? "destructive" : "secondary"}
                        className="mr-1"
                      >
                        {a.severity}
                      </Badge>
                      {a.kind.replace(/_/g, " ")}: &ldquo;{a.quote.slice(0, 120)}
                      &rdquo;
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {body.program.gapFindings.length > 0 && (
              <div>
                <p className="font-medium">Evidence gaps</p>
                <ul className="mt-1 space-y-1">
                  {body.program.gapFindings.slice(0, 6).map((g) => (
                    <li key={g.findingId} className="text-muted-foreground">
                      [{g.opportunityScore.toFixed(0)}] {g.gapType.replace(/_/g, " ")}:{" "}
                      {g.finding.slice(0, 140)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {body.program.interventions.length > 0 && (
              <div>
                <p className="font-medium">Interventions being measured</p>
                <ul className="mt-1 space-y-1">
                  {body.program.interventions.map((i) => (
                    <li key={i.interventionId} className="text-muted-foreground">
                      {i.title} — shipped {i.shippedAt}, {i.measuredVerdicts} post-run(s)
                      recorded
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {body.program.tasksCompleted.length > 0 && (
              <div>
                <p className="font-medium">Work completed</p>
                <ul className="mt-1 space-y-1">
                  {body.program.tasksCompleted.map((t) => (
                    <li key={t.taskId} className="text-muted-foreground">
                      {t.title} ({t.priority})
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {body.program.contentPublished.length > 0 && (
              <div>
                <p className="font-medium">Content published</p>
                <ul className="mt-1 space-y-1">
                  {body.program.contentPublished.map((c) => (
                    <li key={c.assetId} className="text-muted-foreground">
                      {c.title}
                      {c.url ? ` — ${c.url}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {body.program.accuracyFindings.length === 0 &&
              body.program.gapFindings.length === 0 &&
              body.program.interventions.length === 0 &&
              body.program.tasksCompleted.length === 0 &&
              body.program.contentPublished.length === 0 && (
                <p className="text-muted-foreground">
                  No program activity recorded in this period.
                </p>
              )}
          </div>
        </section>
      )}

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
                        {s.isSelf && <Badge className="ml-2">own brand</Badge>}
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
