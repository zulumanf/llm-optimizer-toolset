import { PageHeader, PageShell } from "@/components/layout/page";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getProject } from "@/db/projects";
import { sql } from "@/db/client";
import { interventionView } from "@/lib/attribution/service";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SuggestTasksButton } from "@/components/attribution/suggest-tasks-button";
import {
  InterventionStatusBadge,
  InterventionStatusControls,
} from "@/components/attribution/intervention-status";
import type { InterventionStatus } from "@/lib/attribution/lifecycle";
import type { ComparabilityGrade } from "@/lib/attribution/comparability";
import { formatDate } from "@/lib/format";

function comparabilityBadge(grade: ComparabilityGrade) {
  switch (grade) {
    case "high":
      return <Badge>high comparability</Badge>;
    case "medium":
      return <Badge variant="outline" className="text-warning">medium comparability</Badge>;
    case "low":
      return <Badge variant="outline" className="text-warning">low comparability</Badge>;
    case "not_comparable":
      return <Badge variant="destructive">not comparable</Badge>;
  }
}

function verdictBadge(verdict: string | null) {
  switch (verdict) {
    case "notable":
      return <Badge>notable</Badge>;
    case "within_noise":
      return <Badge variant="outline">within noise</Badge>;
    case "insufficient":
      return <Badge variant="outline" className="text-warning">insufficient data</Badge>;
    case "not_comparable":
      return <Badge variant="destructive">not comparable</Badge>;
    default:
      return <Badge variant="secondary">delta only</Badge>;
  }
}

export default async function InterventionPage({
  params,
}: {
  params: Promise<{ id: string; interventionId: string }>;
}) {
  const { id: projectId, interventionId } = await params;
  const project = await getProject(projectId);
  const [intervention] = await sql`
    select i.*, to_char(i.shipped_at, 'YYYY-MM-DD') as shipped,
      s.name as set_name, v.version
    from interventions i
    join prompt_set_versions v on v.id = i.prompt_set_version_id
    join prompt_sets s on s.id = v.prompt_set_id
    where i.id = ${interventionId}
  `;
  if (!project || !intervention || intervention.projectId !== projectId) notFound();

  const [runs, view, queuedPosts] = await Promise.all([
    sql`
      select ir.role, ir.offset_label, r.id, r.label, r.status, r.started_at
      from intervention_runs ir join runs r on r.id = ir.run_id
      where ir.intervention_id = ${interventionId}
      order by r.started_at asc
    `,
    interventionView(interventionId),
    sql`
      select payload->>'offsetLabel' as offset_label, run_after
      from jobs
      where type = 'start_scheduled_run' and status = 'queued'
        and payload->>'interventionId' = ${interventionId}
      order by run_after asc
    `,
  ]);

  return (
    <PageShell>
      <PageHeader
        crumbs={[
          {
            label: "Interventions",
            href: `/projects/${projectId}/interventions`,
          },
          { label: intervention.title as string },
        ]}
        title={intervention.title as string}
        description={
          <>
            shipped {intervention.shipped as string} · target{" "}
            {intervention.setName as string} v{intervention.version as number}
            {(intervention.urls as string[]).length > 0 &&
              ` · ${(intervention.urls as string[]).join(", ")}`}
            {intervention.hypothesis != null && (
              <span className="mt-1 block italic">
                Hypothesis: {intervention.hypothesis as string}
              </span>
            )}
          </>
        }
        actions={
          <SuggestTasksButton
            interventionId={interventionId}
            hasNotable={view.verdicts.some((v) => v.verdict === "notable")}
          />
        }
      />

      <div className="mb-4 -mt-2 flex flex-wrap items-center gap-2">
        <InterventionStatusBadge
          status={intervention.status as InterventionStatus}
          blockedReason={intervention.blockedReason as string | null}
        />
        {intervention.status === "blocked" && (
          <span className="text-sm text-destructive">
            {intervention.blockedReason as string}
          </span>
        )}
        {intervention.baselineWeak && (
          <Badge variant="outline" className="text-warning">
            weak baseline — verdicts are indicative only
          </Badge>
        )}
        {view.confoundedWith.map((other) => (
          <Badge key={other.id} variant="destructive">
            confounded with &ldquo;{other.title}&rdquo;
          </Badge>
        ))}
        <InterventionStatusControls
          interventionId={interventionId}
          status={intervention.status as InterventionStatus}
        />
      </div>

      <section className="mb-6">
        <h2 className="mb-2 text-lg font-medium">Runs</h2>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Role</TableHead>
                <TableHead>Run</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Started</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow key={run.id as string}>
                  <TableCell>
                    <Badge variant={run.role === "baseline" ? "secondary" : "default"}>
                      {run.role as string}
                      {run.offsetLabel ? ` ${run.offsetLabel}` : ""}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/projects/${projectId}/runs/${run.id}`}
                      className="hover:underline"
                    >
                      {run.label as string}
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm">{run.status as string}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDate(run.startedAt as Date)}
                  </TableCell>
                </TableRow>
              ))}
              {queuedPosts.map((job) => (
                <TableRow key={job.offsetLabel as string}>
                  <TableCell>
                    <Badge variant="outline">post {job.offsetLabel as string}</Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground" colSpan={2}>
                    scheduled
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDate(job.runAfter as Date)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      {view.comparability.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-lg font-medium">
            Comparability{" "}
            <span className="text-sm font-normal text-muted-foreground">
              (instrument drift between baseline and each post run — graded, with
              reasons)
            </span>
          </h2>
          <ul className="space-y-2">
            {view.comparability.map((c) => (
              <li
                key={c.runId}
                className="flex flex-wrap items-baseline gap-2 rounded-md border p-3"
              >
                <Badge variant="secondary">post {c.offsetLabel ?? "run"}</Badge>
                {comparabilityBadge(c.grade)}
                {c.reasons.length > 0 ? (
                  <span className="text-sm text-muted-foreground">
                    {c.reasons.join(" · ")}
                  </span>
                ) : (
                  <span className="text-sm text-muted-foreground">
                    same instrument, same versions, two-run baseline
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-lg font-medium">
          Verdicts{" "}
          <span className="text-sm font-normal text-muted-foreground">
            (subject, pooled baseline vs each post run — computed, never edited)
          </span>
        </h2>
        {view.verdicts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No verdicts yet — they appear once a post run completes and scores.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Metric</TableHead>
                  <TableHead className="text-right">Baseline</TableHead>
                  <TableHead className="text-right">Post</TableHead>
                  <TableHead className="text-right">Δ</TableHead>
                  <TableHead>Verdict</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.verdicts.map((verdict) => (
                  <TableRow key={`${verdict.postRunId}-${verdict.metric}`}>
                    <TableCell className="text-sm">{verdict.metric}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {verdict.baselineValue.toFixed(3)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {verdict.postValue.toFixed(3)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {verdict.delta >= 0 ? "+" : ""}
                      {verdict.delta.toFixed(3)}
                    </TableCell>
                    <TableCell>{verdictBadge(verdict.verdict)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </PageShell>
  );
}
