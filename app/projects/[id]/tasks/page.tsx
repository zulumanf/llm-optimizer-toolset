import Link from "next/link";
import { notFound } from "next/navigation";
import { getProject } from "@/db/projects";
import { sql } from "@/db/client";
import { TaskCard, type TaskWithEvidence } from "@/components/tasks/task-card";

const COLUMNS = [
  { status: "suggested", title: "Suggested" },
  { status: "approved", title: "Approved" },
  { status: "in_progress", title: "In progress" },
  { status: "done", title: "Done" },
] as const;

export default async function TasksPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();

  const [tasks, versions] = await Promise.all([
    sql`
      select t.*, (
        select json_agg(json_build_object('id', e.id, 'kind', e.kind,
          'refId', e.ref_id, 'note', e.note))
        from evidence e where e.id = any(t.evidence_ids)
      ) as evidence
      from tasks t
      where t.project_id = ${id}
      order by t.priority asc, t.created_at desc
    `,
    sql`
      select v.id, s.name as set_name, v.version
      from prompt_set_versions v
      join prompt_sets s on s.id = v.prompt_set_id
      where s.project_id = ${id}
      order by s.name asc, v.version desc
    `,
  ]);
  const rejected = tasks.filter((t) => t.status === "rejected").length;
  const versionOptions = versions.map((v) => ({
    id: v.id as string,
    label: `${v.setName} — v${v.version}`,
  }));

  return (
    <div className="mx-auto max-w-7xl p-6">
      <nav className="mb-3 text-sm text-muted-foreground">
        <Link href="/projects" className="hover:text-foreground">Projects</Link>
        {" / "}
        <Link href={`/projects/${id}`} className="hover:text-foreground">
          {project.name}
        </Link>
        {" / "}Tasks
      </nav>

      <div className="mb-4">
        <h1 className="text-2xl font-semibold">Tasks</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Software suggests with evidence; humans approve (PRINCIPLES.md #8).
          Completing a task can record it as an intervention so the effect gets
          measured.{rejected > 0 ? ` ${rejected} rejected task${rejected === 1 ? "" : "s"} hidden.` : ""}
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-4">
        {COLUMNS.map((column) => {
          const items = tasks.filter((t) => t.status === column.status);
          return (
            <div key={column.status}>
              <h2 className="mb-2 text-sm font-medium text-muted-foreground">
                {column.title} ({items.length})
              </h2>
              <div className="space-y-3">
                {items.map((task) => (
                  <TaskCard
                    key={task.id as string}
                    task={task as unknown as TaskWithEvidence}
                    projectId={id}
                    versions={versionOptions}
                  />
                ))}
                {items.length === 0 && (
                  <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
                    empty
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
