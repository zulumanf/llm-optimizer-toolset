import Link from "next/link";
import { notFound } from "next/navigation";
import { FlaskConical } from "lucide-react";
import { getProject } from "@/db/projects";
import { sql } from "@/db/client";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CreateInterventionDialog } from "@/components/attribution/create-intervention-dialog";
import { InterventionVisibilityToggle } from "@/components/attribution/intervention-visibility";
import { ProjectTabs } from "@/components/layout/project-tabs";

export default async function InterventionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();

  const [interventions, versions] = await Promise.all([
    sql`
      select i.id, i.title, to_char(i.shipped_at, 'YYYY-MM-DD') as shipped,
        i.baseline_weak, i.client_visible, s.name as set_name, v.version,
        (select count(*)::int from intervention_runs ir
          where ir.intervention_id = i.id and ir.role = 'baseline') as baselines,
        (select count(*)::int from intervention_runs ir
          where ir.intervention_id = i.id and ir.role = 'post') as posts
      from interventions i
      join prompt_set_versions v on v.id = i.prompt_set_version_id
      join prompt_sets s on s.id = v.prompt_set_id
      where i.project_id = ${id} and i.archived_at is null
      order by i.shipped_at desc
    `,
    sql`
      select v.id, s.name as set_name, v.version
      from prompt_set_versions v
      join prompt_sets s on s.id = v.prompt_set_id
      where s.project_id = ${id}
      order by s.name asc, v.version desc
    `,
  ]);

  return (
    <div className="mx-auto max-w-7xl p-6">
      <ProjectTabs projectId={id} setKey="work" />
      <nav className="mb-3 text-sm text-muted-foreground">
        <Link href="/projects" className="hover:text-foreground">Projects</Link>
        {" / "}
        <Link href={`/projects/${id}`} className="hover:text-foreground">
          {project.name}
        </Link>
        {" / "}Interventions
      </nav>

      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Interventions</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            What the client shipped, tied to before/after measurement on a frozen
            prompt set (docs/07). Post runs re-use the baseline instrument at
            +2/+6/+12 weeks.
          </p>
        </div>
        {project.status === "active" && (
          <CreateInterventionDialog
            projectId={id}
            versions={versions.map((v) => ({
              id: v.id as string,
              label: `${v.setName} — v${v.version}`,
            }))}
          />
        )}
      </div>

      {interventions.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center">
          <FlaskConical className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No interventions yet. Record one when the client ships something that
            should move AI answers.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Shipped</TableHead>
                <TableHead>Target</TableHead>
                <TableHead className="text-right">Baselines</TableHead>
                <TableHead className="text-right">Post runs</TableHead>
                <TableHead>Portal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {interventions.map((i) => (
                <TableRow key={i.id as string}>
                  <TableCell>
                    <Link
                      href={`/projects/${id}/interventions/${i.id}`}
                      className="font-medium hover:underline"
                    >
                      {i.title as string}
                    </Link>
                    {i.baselineWeak && (
                      <Badge variant="outline" className="ml-2 text-warning">
                        weak baseline
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {i.shipped as string}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {i.setName as string} v{i.version as number}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {i.baselines as number}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {i.posts as number}
                  </TableCell>
                  <TableCell>
                    <InterventionVisibilityToggle
                      interventionId={i.id as string}
                      clientVisible={Boolean(i.clientVisible)}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
