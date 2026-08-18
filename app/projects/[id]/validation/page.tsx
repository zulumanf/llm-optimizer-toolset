import { PageHeader, PageShell } from "@/components/layout/page";
import { notFound } from "next/navigation";
import { ClipboardCheck } from "lucide-react";
import { getProject } from "@/db/projects";
import { sql } from "@/db/client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { validationComparison } from "@/lib/evidence/service";
import { NewValidationRunButton } from "@/components/validation/new-validation-run";
import { RecordObservationDialog } from "@/components/validation/record-observation";
import { formatDate } from "@/lib/format";
import { ProjectTabs } from "@/components/layout/project-tabs";

export default async function ValidationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();

  const [runs, frozenVersions] = await Promise.all([
    sql`
      select v.id, v.seed, v.instructions, v.status, v.created_at,
        v.selected_prompt_ids,
        (select count(*)::int from client_validation_observations o
          where o.validation_run_id = v.id) as observations
      from client_validation_runs v
      where v.project_id = ${id}
      order by v.created_at desc
    `,
    sql`
      select v.id, s.name as set_name, v.version
      from prompt_set_versions v join prompt_sets s on s.id = v.prompt_set_id
      where s.project_id = ${id}
      order by s.name asc, v.version desc
    `,
  ]);

  const comparisons = new Map<string, Awaited<ReturnType<typeof validationComparison>>>();
  for (const run of runs) {
    comparisons.set(run.id as string, await validationComparison(run.id as string));
  }

  // Prompt text for each run's selected prompts (frozen snapshots)
  const promptTexts = new Map<string, string>();
  const allPromptRows = await sql`
    select p."promptId" as id, p.text
    from prompt_set_versions v,
      jsonb_to_recordset(v.frozen_prompts) as p("promptId" uuid, text text)
    where v.id = any(${frozenVersions.map((f) => f.id as string)})
  `;
  for (const row of allPromptRows) {
    promptTexts.set(row.id as string, row.text as string);
  }

  return (
    <PageShell>
      <ProjectTabs projectId={id} setKey="reports" />
      <PageHeader
        crumbs={[{ label: "Clients", href: "/projects" }, { label: project.name, href: `/projects/${id}` }, { label: "Client validation" }]}
        title="Client validation"
        description={
          <>
            The client checks our numbers themselves: a seeded random sample
            of frozen prompts, run in their own clean sessions. These
            observations are stored separately and{" "}
            <span className="font-medium text-foreground">
              never enter benchmark metrics
            </span>{" "}
            — they are compared directionally.
          </>
        }
        actions={
          <>
            <NewValidationRunButton
          projectId={id}
          versions={frozenVersions.map((v) => ({
            id: v.id as string,
            label: `${v.setName} — v${v.version}`,
          }))}
        />
          </>
        }
      />
      {runs.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center">
          <ClipboardCheck className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No validation runs yet. Create one to generate clean-session
            instructions for the client.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {runs.map((run) => {
            const comparison = comparisons.get(run.id as string);
            const clientRate =
              comparison && comparison.clientTotal > 0
                ? comparison.clientHits / comparison.clientTotal
                : null;
            const benchRate =
              comparison && comparison.benchmarkTotal > 0
                ? comparison.benchmarkHits / comparison.benchmarkTotal
                : null;
            return (
              <Card key={run.id as string}>
                <CardContent className="space-y-3 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={run.status === "open" ? "default" : "outline"}>
                      {run.status as string}
                    </Badge>
                    <span className="text-sm text-muted-foreground">
                      seed {run.seed as number} ·{" "}
                      {(run.selectedPromptIds as string[]).length} prompts ·{" "}
                      {run.observations as number} submitted ·{" "}
                      {formatDate(run.createdAt as Date)}
                    </span>
                    <div className="ml-auto">
                      <RecordObservationDialog
                        validationRunId={run.id as string}
                        prompts={(run.selectedPromptIds as string[]).map((pid) => ({
                          id: pid,
                          text: promptTexts.get(pid) ?? pid,
                        }))}
                      />
                    </div>
                  </div>

                  <details>
                    <summary className="cursor-pointer text-sm font-medium">
                      Clean-session instructions for the client
                    </summary>
                    <pre className="mt-2 whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs">
                      {run.instructions as string}
                    </pre>
                  </details>

                  <div className="rounded-md border p-3 text-sm">
                    <p className="font-medium">Directional comparison</p>
                    <p className="mt-1 text-muted-foreground">
                      Client-run:{" "}
                      {clientRate == null
                        ? "no submissions yet"
                        : `${comparison!.clientHits} of ${comparison!.clientTotal} mentioned (${(clientRate * 100).toFixed(0)}%)`}
                      {" · "}
                      Our benchmark on the same prompts:{" "}
                      {benchRate == null
                        ? "no observations"
                        : `${comparison!.benchmarkHits} of ${comparison!.benchmarkTotal} (${(benchRate * 100).toFixed(0)}%)`}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Directional only — different sessions, dates, and
                      accounts. A gap is a prompt for investigation, not a
                      correction to the benchmark.
                    </p>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
