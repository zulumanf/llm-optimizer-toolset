import Link from "next/link";
import { notFound } from "next/navigation";
import { getProject } from "@/db/projects";
import { sql } from "@/db/client";
import { listAllModels } from "@/lib/ai/registry";
import { NewRunForm, type VersionOption } from "@/components/runs/new-run-form";

export default async function NewRunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project || project.status !== "active") notFound();

  const versions = await sql<VersionOption[]>`
    select v.id, s.name as set_name, v.version,
      jsonb_array_length(v.frozen_prompts)::int as prompt_count
    from prompt_set_versions v
    join prompt_sets s on s.id = v.prompt_set_id
    where s.project_id = ${id}
    order by s.name asc, v.version desc
  `;

  return (
    <div className="mx-auto max-w-3xl p-6">
      <nav className="mb-3 text-sm text-muted-foreground">
        <Link href="/projects" className="hover:text-foreground">Projects</Link>
        {" / "}
        <Link href={`/projects/${id}`} className="hover:text-foreground">
          {project.name}
        </Link>
        {" / "}
        <Link href={`/projects/${id}/runs`} className="hover:text-foreground">
          Runs
        </Link>
        {" / "}New
      </nav>
      <h1 className="mb-4 text-2xl font-semibold">New run</h1>

      {versions.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          No frozen prompt-set versions in this project yet. Runs only execute
          frozen versions —{" "}
          <Link href={`/projects/${id}/prompts`} className="underline">
            freeze a set first
          </Link>
          .
        </div>
      ) : (
        <NewRunForm
          projectId={id}
          versions={versions}
          models={listAllModels()}
        />
      )}
    </div>
  );
}
