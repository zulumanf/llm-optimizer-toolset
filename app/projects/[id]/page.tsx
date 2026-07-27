import Link from "next/link";
import { notFound } from "next/navigation";
import { getProject } from "@/db/projects";
import { getCurrentUser } from "@/lib/auth";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { ProjectFormDialog } from "@/components/projects/project-form-dialog";
import { ArchiveControls } from "@/components/projects/archive-controls";
import { formatDate } from "@/lib/format";

const UPCOMING_TABS = [
  { label: "Reports", spec: "specs/006" },
  { label: "Tasks", spec: "specs/007" },
] as const;

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [project, user] = await Promise.all([getProject(id), getCurrentUser()]);
  if (!project) notFound();

  return (
    <div className="mx-auto max-w-7xl p-6">
      <nav className="mb-3 text-sm text-muted-foreground">
        <Link href="/projects" className="hover:text-foreground">
          Projects
        </Link>{" "}
        / {project.name}
      </nav>

      {project.status === "archived" && (
        <div className="mb-4 rounded-md border border-warning/50 bg-warning/10 px-4 py-2 text-sm">
          This project is archived — editing is disabled until it is unarchived.
        </div>
      )}

      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{project.name}</h1>
            <Badge variant={project.status === "active" ? "default" : "outline"}>
              {project.status}
            </Badge>
          </div>
          {project.description && (
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {project.description}
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            Created {formatDate(project.createdAt)}
            {project.archivedAt
              ? ` · archived ${formatDate(project.archivedAt)}`
              : null}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {project.status === "active" && (
            <ProjectFormDialog mode="edit" project={project} />
          )}
          <ArchiveControls project={project} isAdmin={user.role === "admin"} />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Link href={`/projects/${project.id}/prompts`}>
          <Card className="transition-colors hover:bg-accent">
            <CardContent className="p-4">
              <p className="text-sm font-medium">Prompts</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {project.promptSetCount} prompt set
                {project.promptSetCount === 1 ? "" : "s"}
              </p>
            </CardContent>
          </Card>
        </Link>
        <Link href={`/projects/${project.id}/runs`}>
          <Card className="transition-colors hover:bg-accent">
            <CardContent className="p-4">
              <p className="text-sm font-medium">Runs</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {project.runCount} run{project.runCount === 1 ? "" : "s"}
              </p>
            </CardContent>
          </Card>
        </Link>
        <Link href={`/projects/${project.id}/review`}>
          <Card className="transition-colors hover:bg-accent">
            <CardContent className="p-4">
              <p className="text-sm font-medium">Review</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Low-confidence classifications
              </p>
            </CardContent>
          </Card>
        </Link>
        <Link href={`/projects/${project.id}/competitors`}>
          <Card className="transition-colors hover:bg-accent">
            <CardContent className="p-4">
              <p className="text-sm font-medium">Competitors</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Comparison &amp; brand discovery
              </p>
            </CardContent>
          </Card>
        </Link>
        {UPCOMING_TABS.map((tab) => (
          <Card key={tab.label}>
            <CardContent className="p-4">
              <p className="text-sm font-medium">{tab.label}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Arrives with {tab.spec}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
