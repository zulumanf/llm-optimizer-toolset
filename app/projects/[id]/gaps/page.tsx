import Link from "next/link";
import { notFound } from "next/navigation";
import { Crosshair } from "lucide-react";
import { getProject } from "@/db/projects";
import { sql } from "@/db/client";
import { Badge } from "@/components/ui/badge";
import { AnalyzeRunButton } from "@/components/gaps/analyze-run-button";
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
    <div className="mx-auto max-w-4xl p-6">
      <ProjectTabs projectId={id} setKey="findings" />
      <nav className="mb-3 text-sm text-muted-foreground">
        <Link href="/projects" className="hover:text-foreground">Projects</Link>
        {" / "}
        <Link href={`/projects/${id}`} className="hover:text-foreground">
          {project.name}
        </Link>
        {" / "}Gaps
      </nav>

      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Evidence gaps</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Why the client is (or isn&rsquo;t) retrieved — typed findings from
            scored runs, ranked by deterministic opportunity score (docs/15).
            Findings become tasks only with your approval.
          </p>
        </div>
        {latestScoredRun[0] && (
          <AnalyzeRunButton
            runId={latestScoredRun[0].id as string}
            runLabel={latestScoredRun[0].label as string}
          />
        )}
      </div>

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
        deterministic; v1.1 findings carry classification, confidence, and
        evidence refs (LLM enrichment lands as a later version)
      </p>
    </div>
  );
}
