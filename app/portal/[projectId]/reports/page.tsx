import { portalReports } from "@/lib/portal/service";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

/** Published reports only (spec 031). The CSV download rides the existing
 * project-scoped route — a client can never fetch another client's report. */
export default async function PortalReportsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const reports = await portalReports(projectId);

  return (
    <div>
      <h2 className="mb-1 text-lg font-medium">Reports</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Published reports for your program. Each number in a report is
        backed by stored evidence.
      </p>
      {reports.length === 0 ? (
        <p className="rounded-md border border-dashed p-8 text-sm text-muted-foreground">
          No published reports yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {reports.map((report) => (
            <li
              key={report.id}
              className="flex items-center justify-between rounded-md border p-3 text-sm"
            >
              <div>
                <p className="font-medium">{report.title}</p>
                <p className="text-xs text-muted-foreground">
                  {report.periodStart} → {report.periodEnd} · published{" "}
                  {formatDate(report.publishedAt)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline">{report.kind.replace(/_/g, " ")}</Badge>
                <a
                  className="text-xs underline hover:no-underline"
                  href={`/api/reports/${report.id}/csv`}
                >
                  Download CSV
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
