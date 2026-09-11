import { PageHeader, PageShell } from "@/components/layout/page";
import { notFound } from "next/navigation";
import { Crosshair, ScanSearch } from "lucide-react";
import { getProject } from "@/db/projects";
import { sql } from "@/db/client";
import { Badge } from "@/components/ui/badge";
import { BackgroundAction } from "@/components/jobs/background-action";
import { FindingCard } from "@/components/gaps/finding-card";
import { formatDate } from "@/lib/format";
import { ProjectTabs } from "@/components/layout/project-tabs";

export default async function GapsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();

  const [findings, latestScoredRun] = await Promise.all([
    sql`
      select f.*, r.label as run_label
      from gap_findings f join runs r on r.id = f.run_id
      where f.project_id = ${id}
      order by f.status = 'open' desc, f.opportunity_score desc, f.created_at desc
      limit 50
    `,
    sql`
      select r.id, r.label from runs r
      where r.project_id = ${id}
        and exists (select 1 from scores s where s.run_id = r.id)
        and not exists (select 1 from gap_findings f where f.run_id = r.id)
      order by r.started_at desc limit 1
    `,
  ]);

  return (
    <PageShell>
      <ProjectTabs projectId={id} setKey="findings" />
      <PageHeader
        crumbs={[{ label: "Projects", href: "/projects" }, { label: project.name, href: `/projects/${id}` }, { label: "Gaps" }]}
        title="Evidence gaps"
        description={
          <>
            Why the client is (or isn&rsquo;t) retrieved — typed findings from
            scored runs, ranked by deterministic opportunity score (docs/15).
            Findings become tasks only with your approval.
          </>
        }
        actions={
          <>
            {latestScoredRun[0] && (
              <BackgroundAction
                type="analyze_gaps"
                runId={latestScoredRun[0].id as string}
                label={`Analyze "${latestScoredRun[0].label as string}"`}
                workingLabel="Analyzing…"
                icon={<ScanSearch className="size-4" />}
              />
            )}
          </>
        }
      />
      {findings.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center">
          <Crosshair className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No findings yet — analyze a scored run to diagnose the client&rsquo;s
            visibility.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {findings.map((f) => (
            <FindingCard
              key={f.id as string}
              finding={{
                id: f.id as string,
                gapType: f.gapType as string,
                findingText: f.finding as string,
                promptCategory: (f.promptCategory as string | null) ?? null,
                severity: Number(f.severity),
                opportunityScore: Number(f.opportunityScore),
                status: f.status as string,
                runLabel: f.runLabel as string,
                createdAt: formatDate(f.createdAt as Date),
                classification: (f.classification as string | null) ?? null,
                confidence: f.confidence == null ? null : Number(f.confidence),
                evidenceCount: ((f.evidenceIds as string[] | null) ?? []).length,
              }}
            />
          ))}
        </div>
      )}
      <p className="mt-4 text-xs text-muted-foreground">
        <Badge variant="outline" className="mr-1">open</Badge> awaiting your call ·
        task_created / dismissed kept for the record · the detector is
        deterministic; findings carry classification, confidence, and evidence
        refs, and displacement findings name who was recommended instead
        (LLM enrichment lands as a later version)
      </p>
    </PageShell>
  );
}
