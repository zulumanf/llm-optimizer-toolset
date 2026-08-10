import Link from "next/link";
import { notFound } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { getProject } from "@/db/projects";
import { sql } from "@/db/client";
import { Badge } from "@/components/ui/badge";
import { AnalyzeAccuracyButton } from "@/components/accuracy/analyze-button";
import { AccuracyFindingCard } from "@/components/accuracy/finding-card";
import { formatDate } from "@/lib/format";
import { ProjectTabs } from "@/components/layout/project-tabs";

export default async function AccuracyPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const { id } = await params;
  const { status = "open" } = await searchParams;
  const project = await getProject(id);
  if (!project) notFound();

  const [findings, analysable, counts] = await Promise.all([
    sql`
      select f.*, r.label as run_label, c.canonical_text as claim_text,
        resp.prompt_text
      from accuracy_findings f
      join runs r on r.id = f.run_id
      join responses resp on resp.id = f.response_id
      left join claims c on c.id = f.claim_id
      where f.project_id = ${id}
        and (${status} = 'all' or f.status = ${status})
      order by
        case f.severity when 'high' then 0 when 'medium' then 1 else 2 end,
        f.created_at desc
      limit 100
    `,
    sql`
      select r.id, r.label from runs r
      where r.project_id = ${id}
        and exists (select 1 from scores s where s.run_id = r.id)
      order by r.started_at desc limit 1
    `,
    sql`
      select status, count(*)::int as n from accuracy_findings
      where project_id = ${id} group by status
    `,
  ]);

  const byStatus = new Map(counts.map((c) => [c.status as string, c.n as number]));
  const filters = ["open", "acknowledged", "fix_in_progress", "corrected", "dismissed", "all"];

  return (
    <div className="mx-auto max-w-4xl p-6">
      <ProjectTabs projectId={id} setKey="findings" />
      <nav className="mb-3 text-sm text-muted-foreground">
        <Link href="/projects" className="hover:text-foreground">Clients</Link>
        {" / "}
        <Link href={`/projects/${id}`} className="hover:text-foreground">
          {project.name}
        </Link>
        {" / "}Accuracy
      </nav>

      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Factual accuracy</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            What AI assistants get wrong about the client — captured answers
            audited against the approved claims. Every finding quotes the
            answer verbatim; quotes that don&rsquo;t appear in the stored
            evidence are rejected before they reach this page.
          </p>
        </div>
        {analysable[0] && (
          <AnalyzeAccuracyButton
            runId={analysable[0].id as string}
            runLabel={analysable[0].label as string}
          />
        )}
      </div>

      <div className="mb-4 flex flex-wrap gap-2 text-sm">
        {filters.map((f) => (
          <Link key={f} href={`?status=${f}`}>
            <Badge variant={status === f ? "default" : "outline"}>
              {f}
              {byStatus.get(f) != null ? ` (${byStatus.get(f)})` : ""}
            </Badge>
          </Link>
        ))}
      </div>

      {findings.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center">
          <ShieldAlert className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {byStatus.size === 0
              ? "No accuracy analysis yet — run it on a scored run to audit what AI says about the client."
              : `No ${status} findings.`}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {findings.map((f) => (
            <AccuracyFindingCard
              key={f.id as string}
              finding={{
                id: f.id as string,
                kind: f.kind as string,
                severity: f.severity as string,
                quote: f.quote as string,
                rationale: f.rationale as string,
                status: f.status as string,
                claimText: (f.claimText as string | null) ?? null,
                promptText: f.promptText as string,
                runLabel: f.runLabel as string,
                confidence: Number(f.confidence),
                createdAt: formatDate(f.createdAt as Date),
                evidenceHref: `/projects/${id}/runs/${f.runId}/responses/${f.responseId}`,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
