import { notFound } from "next/navigation";
import { Radar } from "lucide-react";
import { PageHeader, PageShell, Stat, StatGrid } from "@/components/layout/page";
import { ProjectTabs } from "@/components/layout/project-tabs";
import { Badge } from "@/components/ui/badge";
import { getProject } from "@/db/projects";
import { latestScan, listScanFindings } from "@/lib/discoverability/service";
import { ScanButton } from "@/components/technical/scan-button";
import { FindingActions } from "@/components/technical/finding-actions";
import { formatDate } from "@/lib/format";
import { SEVERITY_VARIANT } from "@/lib/ui/variants";

const BAND_LABELS: Record<string, string> = {
  do_now: "Do now",
  do_next: "Do next",
  test: "Test",
  low_priority: "Low priority",
};


export default async function TechnicalPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();

  const scan = await latestScan(id);
  const findings = scan && scan.status === "completed" ? await listScanFindings(scan.id) : [];
  const open = findings.filter((f) => f.status !== "dismissed");
  const severe = open.filter((f) => f.severity === "critical" || f.severity === "high");
  const doNow = open.filter((f) => f.priorityBand === "do_now");

  const bands = ["do_now", "do_next", "test", "low_priority"] as const;

  return (
    <PageShell>
      <ProjectTabs projectId={id} setKey="findings" />
      <PageHeader
        crumbs={[
          { label: "Projects", href: "/projects" },
          { label: project.name, href: `/projects/${id}` },
          { label: "Technical" },
        ]}
        title="Can machines find the evidence?"
        description={
          <>
            Whether AI and search crawlers can discover, read, and connect the
            client&apos;s authority pages — robots, sitemaps, indexability,
            structured data, internal links, freshness. Findings become tasks
            only with your approval.
          </>
        }
        actions={<ScanButton projectId={id} />}
      />

      {!scan ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center">
          <Radar className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No scan yet. Run one to see whether the client&apos;s authority
            pages are discoverable and machine-readable.
          </p>
        </div>
      ) : (
        <>
          <StatGrid columns={4}>
            <Stat
              label="Latest scan"
              value={scan.status === "completed" ? formatDate(scan.completedAt ?? scan.createdAt) : scan.status}
              hint={`${scan.domain} · ${scan.scannerVersion}`}
            />
            <Stat label="Pages scanned" value={String(scan.pagesFetched)} />
            <Stat label="Critical / high" value={String(severe.length)} />
            <Stat label="Do now" value={String(doNow.length)} />
          </StatGrid>

          {scan.status === "failed" && (
            <p className="mt-4 text-sm text-destructive">
              The last scan failed: {scan.error ?? "unknown error"}. Run it again.
            </p>
          )}
          {scan.status === "running" && (
            <p className="mt-4 text-sm text-muted-foreground">
              A scan is running — findings will appear here when it completes.
            </p>
          )}

          {scan.status === "completed" && findings.length === 0 && (
            <div className="mt-6 rounded-lg border border-dashed p-8 text-center">
              <p className="text-sm text-muted-foreground">
                No findings — the scanned pages look discoverable and
                connected. Re-scan after major site changes.
              </p>
            </div>
          )}

          {bands.map((band) => {
            const rows = findings.filter((f) => f.priorityBand === band);
            if (rows.length === 0) return null;
            return (
              <section key={band} className="mt-8">
                <h2 className="mb-3 text-lg font-medium">{BAND_LABELS[band]}</h2>
                <ul className="space-y-3">
                  {rows.map((f) => (
                    <li
                      key={f.id}
                      className={`rounded-lg border p-4 ${f.status === "dismissed" ? "opacity-60" : ""}`}
                    >
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <Badge variant={SEVERITY_VARIANT[f.severity] ?? "outline"}>
                          {f.severity}
                        </Badge>
                        <Badge variant="secondary">{f.checkType.replace(/_/g, " ")}</Badge>
                        {f.status !== "open" && (
                          <Badge variant="outline">{f.status.replace(/_/g, " ")}</Badge>
                        )}
                        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                          priority {Number(f.priorityScore).toFixed(0)}
                        </span>
                      </div>
                      <p className="text-sm">{f.observation}</p>
                      {f.inference && (
                        <p className="mt-1 text-sm text-muted-foreground">{f.inference}</p>
                      )}
                      <div className="mt-2 flex items-center justify-between gap-3">
                        <p className="text-sm">
                          <span className="font-medium">The fix:</span> {f.recommendation}
                        </p>
                        <FindingActions findingId={f.id} status={f.status} />
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </>
      )}
    </PageShell>
  );
}
