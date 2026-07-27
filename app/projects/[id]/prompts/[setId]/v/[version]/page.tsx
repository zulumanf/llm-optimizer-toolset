import Link from "next/link";
import { notFound } from "next/navigation";
import { getProject } from "@/db/projects";
import { getPromptSet, getVersion } from "@/db/prompt-sets";
import { diffVersions } from "@/lib/prompts/diff";
import { Badge } from "@/components/ui/badge";
import { DuplicateSetDialog } from "@/components/prompts/duplicate-set-dialog";
import { formatDate } from "@/lib/format";

export default async function VersionPage({
  params,
}: {
  params: Promise<{ id: string; setId: string; version: string }>;
}) {
  const { id: projectId, setId, version: versionParam } = await params;
  const versionNumber = Number.parseInt(versionParam, 10);
  if (!Number.isInteger(versionNumber) || versionNumber < 1) notFound();

  const [project, set, version] = await Promise.all([
    getProject(projectId),
    getPromptSet(setId),
    getVersion(setId, versionNumber),
  ]);
  if (!project || !set || set.projectId !== projectId || !version) notFound();

  const previous =
    versionNumber > 1 ? await getVersion(setId, versionNumber - 1) : null;
  const diff = previous
    ? diffVersions(previous.frozenPrompts, version.frozenPrompts)
    : null;
  const prompts = [...version.frozenPrompts].sort(
    (a, b) => a.position - b.position
  );

  return (
    <div className="mx-auto max-w-7xl p-6">
      <nav className="mb-3 text-sm text-muted-foreground">
        <Link href="/projects" className="hover:text-foreground">Projects</Link>
        {" / "}
        <Link href={`/projects/${projectId}`} className="hover:text-foreground">
          {project.name}
        </Link>
        {" / "}
        <Link
          href={`/projects/${projectId}/prompts/${setId}`}
          className="hover:text-foreground"
        >
          {set.name}
        </Link>
        {" / "}v{version.version}
      </nav>

      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">
              {set.name} — v{version.version}
            </h1>
            <Badge>frozen</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {prompts.length} prompts · frozen {formatDate(version.frozenAt)} ·
            immutable — this snapshot never changes
          </p>
        </div>
        <DuplicateSetDialog
          sourceVersionId={version.id}
          sourceName={`${set.name} v${version.version}`}
        />
      </div>

      <div className="rounded-lg border">
        <ul className="divide-y">
          {prompts.map((p) => (
            <li key={p.promptId} className="flex items-center gap-3 px-4 py-2.5">
              <span className="w-6 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
                {p.position}
              </span>
              <p className="min-w-0 flex-1 font-mono text-sm">{p.text}</p>
              <Badge variant="secondary">{p.category}</Badge>
              {p.language !== "en" && <Badge variant="outline">{p.language}</Badge>}
            </li>
          ))}
        </ul>
      </div>

      {diff && (
        <section className="mt-8">
          <h2 className="text-lg font-medium">
            Diff vs v{versionNumber - 1}
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              {diff.added.length} added · {diff.removed.length} removed ·{" "}
              {diff.changed.length} changed · {diff.unchangedCount} unchanged
            </span>
          </h2>
          <div className="mt-3 space-y-2">
            {diff.added.map((p) => (
              <div
                key={`a-${p.promptId}`}
                className="rounded-md border border-success/40 bg-success/10 px-3 py-2 font-mono text-sm"
              >
                + {p.text}
              </div>
            ))}
            {diff.removed.map((p) => (
              <div
                key={`r-${p.promptId}`}
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-sm"
              >
                − {p.text}
              </div>
            ))}
            {diff.changed.map(({ before, after }) => (
              <div
                key={`c-${after.promptId}`}
                className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 font-mono text-sm"
              >
                <p className="text-muted-foreground line-through">{before.text}</p>
                <p>{after.text}</p>
                {(before.category !== after.category ||
                  before.language !== after.language) && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {before.category}/{before.language} →{" "}
                    {after.category}/{after.language}
                  </p>
                )}
              </div>
            ))}
            {diff.added.length + diff.removed.length + diff.changed.length ===
              0 && (
              <p className="text-sm text-muted-foreground">
                Content identical (order-only change).
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
