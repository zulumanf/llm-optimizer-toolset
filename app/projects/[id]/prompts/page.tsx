import Link from "next/link";
import { notFound } from "next/navigation";
import { ListPlus } from "lucide-react";
import { getProject } from "@/db/projects";
import { listPromptSets } from "@/db/prompt-sets";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SetFormDialog } from "@/components/prompts/set-form-dialog";
import { formatDate } from "@/lib/format";

export default async function PromptSetsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();
  const sets = await listPromptSets(id);

  return (
    <div className="mx-auto max-w-7xl p-6">
      <nav className="mb-3 text-sm text-muted-foreground">
        <Link href="/projects" className="hover:text-foreground">
          Projects
        </Link>{" "}
        /{" "}
        <Link href={`/projects/${id}`} className="hover:text-foreground">
          {project.name}
        </Link>{" "}
        / Prompts
      </nav>

      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Prompt sets</h1>
        {project.status === "active" && (
          <SetFormDialog mode="create" projectId={id} />
        )}
      </div>

      {sets.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center">
          <ListPlus className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No prompt sets yet — create one to start authoring prompts.
          </p>
          {project.status === "active" && (
            <SetFormDialog mode="create" projectId={id} />
          )}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">Prompts</TableHead>
                <TableHead>Latest version</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sets.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <Link
                      href={`/projects/${id}/prompts/${s.id}`}
                      className="font-medium hover:underline"
                    >
                      {s.name}
                    </Link>
                    {s.description && (
                      <p className="mt-0.5 max-w-md truncate text-xs text-muted-foreground">
                        {s.description}
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {s.promptCount}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {s.latestVersion
                      ? `v${s.latestVersion} · ${formatDate(s.latestFrozenAt as Date)}`
                      : "never frozen"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(s.createdAt)}
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
